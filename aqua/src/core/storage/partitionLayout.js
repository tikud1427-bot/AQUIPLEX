/**
 * AQUA Storage — partition layout (scalability Phase 2a)
 *
 * PURE. How each whole-file store divides into owner partitions, and how the
 * partitions reassemble into the file. No I/O, no database.
 *
 * A store file today is one of three shapes:
 *
 *   envelope   { __aqua: { schema, savedAt, ... }, data: { <key>: value, ... } }
 *   bare map   { <key>: value, ... }
 *   global     an aggregate that is not owner data (cognition, ledger)
 *
 * A LAYOUT names the maps (or arrays) inside the file that are partitioned,
 * and how to find the owner of each entry. Everything else in the file (the
 * envelope, global aggregates, unknown fields) goes into one `~rest`
 * partition, verbatim. So the split is lossless for every shape, including
 * shapes the layout did not anticipate: an unknown store is one `~rest`
 * partition, which is exactly the blob it was before.
 *
 * GUARANTEE (tested for every registered store): for any file F,
 *   JSON.parse(reassemble(split(F))) deep-equals JSON.parse(F)
 * and key order is preserved for every migrated entry (via `ordinal`). Bytes
 * are not preserved: a pretty-printed source comes back compact. Comparisons
 * therefore use `canonicalChecksum`, which hashes the parsed-and-re-serialised form.
 */
import crypto from 'node:crypto';

export const REST_KEY = '~rest';
export const GLOBAL_OWNER = '';

const userOrConv = (conversationId, value) =>
  value?.meta?.userId != null && String(value.meta.userId) !== ''
    ? `user:${value.meta.userId}`
    : `conv:${conversationId}`;

const ownerKeyed = name => ({ name, path: [], kind: 'map', ownerOf: key => String(key) });

/**
 * Store file basename → sections. Keyed by basename, the same key the blob
 * table and the drift job use.
 *
 * Owner derivation, per store, and where it is weaker than "the value names
 * its owner" (stated here, and in AQUIPLEX_PER_OWNER_STORAGE_PLAN.md §3):
 *   history        meta.userId → user:<id>; a pre-login conversation → conv:<id>
 *   attachments    keyed by conversation only → conv:<id>. The user is reached
 *                  through the conversation (a join, not a column).
 *   projects/index keyed by workspace → ws:<id>. The user is in Mongo
 *                  (Bundle.userId), not in the value.
 *   uko cache      content-hash dedupe shared across owners → global ('').
 */
export const LAYOUTS = Object.freeze({
  '.aqua-mind.json':              [ownerKeyed('o')],
  '.aqua-evidence.json':          [ownerKeyed('o')],
  '.aqua-pic.json':               [ownerKeyed('o')],
  '.aqua-reasoning-graph.json':   [ownerKeyed('o')],
  '.aqua-ids.json':               [ownerKeyed('o')],
  '.aqua-brain.json':             [ownerKeyed('o')],
  '.aqua-reflection.json':        [ownerKeyed('o')],
  '.aqua-recall-redactions.json': [ownerKeyed('o')],
  '.aqua-fileindex.json':         [ownerKeyed('o')],
  // Phase 2b, step 3: MESSAGE-level rows. `c:<conv>` is the conversation header
  // (everything but the messages), `m:<conv>:<msgKey>` one message each, so one
  // changed or added message never rewrites the conversation. See
  // memory/conversationPartitions.js for the revision model.
  '.aqua-history.json':           [{ name: 'c', path: [], kind: 'conversations', ownerOf: userOrConv }],
  '.aqua-history-trash.json':     [{
    name: 't', path: [], kind: 'array',
    keyOf: (item, i) => `${String(i).padStart(6, '0')}:${item?.id ?? ''}`,
    ownerOf: (key, item) => userOrConv(item?.id ?? key, item),
  }],
  '.aqua-attachments.json':       [{ name: 'c', path: [], kind: 'map', ownerOf: key => `conv:${key}` }],
  '.aqua-uko.json': [
    { name: 'owners', path: ['owners'], kind: 'map', ownerOf: key => String(key) },
    { name: 'cache',  path: ['cache'],  kind: 'map', ownerOf: () => GLOBAL_OWNER },
  ],
  '.aqua-vectors.json': [{
    name: 'ns', path: [], kind: 'map',
    // 'xfiles:' — Phase 1a.2 external-resource chunks belong to the same owner.
    ownerOf: key => {
      const k = String(key);
      for (const p of ['files:', 'xfiles:']) if (k.startsWith(p)) return k.slice(p.length);
      return k;
    },
  }],
  '.aqua-projects.json':          [{ name: 'ws', path: [], kind: 'map', ownerOf: key => `ws:${key}` }],
  '.aqua-index.json':             [{ name: 'ws', path: [], kind: 'map', ownerOf: key => `ws:${key}` }],
  '.index.json':                  [{ name: 'a', path: [], kind: 'map', ownerOf: (key, v) => String(v?.ownerId ?? GLOBAL_OWNER) }],
  // Phase 2c: artifacts on partitions — the index entry WITH its manifest, one row per artifact.
  '.aqua-artifacts.json':         [{ name: 'a', path: [], kind: 'map', ownerOf: (key, v) => String(v?.ownerId ?? GLOBAL_OWNER) }],
  // Global aggregates and config: not owner data, one `~rest` partition each.
  '.aqua-cognition.json':         [],
  '.aqua-ledger.json':            [],
  '.aqua-identity-overrides.json': [],
});

export const PARTITIONED_STORES = Object.freeze(Object.keys(LAYOUTS));

export function layoutFor(storeKey) {
  return LAYOUTS[String(storeKey).split(/[\\/]/).pop()] ?? [];
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isEnvelope = doc => isPlainObject(doc) && isPlainObject(doc.__aqua) && 'data' in doc;

function getAt(root, pathParts) {
  let cur = root;
  for (const p of pathParts) {
    if (!isPlainObject(cur) || !(p in cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function setAt(root, pathParts, value) {
  if (!pathParts.length) return value;
  let cur = root;
  for (const p of pathParts.slice(0, -1)) cur = cur[p];
  cur[pathParts.at(-1)] = value;
  return root;
}

const sha = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

/** Checksum of a partition's exact text. */
export const partitionChecksum = text => sha(String(text));

/** Checksum of a document's canonical form: parsed, then re-serialised. Key order kept. */
export function canonicalChecksum(text) {
  return sha(JSON.stringify(JSON.parse(text)));
}

/**
 * Split one store file into partitions.
 *
 * @param {string} storeKey   basename (or a path; the basename is used)
 * @param {string} text       the file's JSON text
 * @returns {{ storeKey: string, envelope: boolean,
 *             partitions: Array<{ partitionKey: string, ownerId: string, ordinal: number|null, data: string }> }}
 *          The `~rest` partition is always present and always last.
 */
export function splitStore(storeKey, text) {
  const key = String(storeKey).split(/[\\/]/).pop();
  const doc = JSON.parse(text);
  const envelope = isEnvelope(doc);
  const root = envelope ? doc.data : doc;
  const sections = layoutFor(key);

  const partitions = [];
  const present = [];
  let ordinal = 0;

  // `rest` is the document with each partitioned container emptied. Built from
  // a deep copy so the caller's parsed value is never mutated.
  const rest = structuredClone(doc);
  const restRoot = envelope ? rest.data : rest;

  for (const s of sections) {
    const container = getAt(root, s.path);
    if (s.kind === 'map' && isPlainObject(container)) {
      present.push(s.name);
      for (const [k, v] of Object.entries(container)) {
        partitions.push({ partitionKey: `${s.name}:${k}`, ownerId: String(s.ownerOf(k, v) ?? GLOBAL_OWNER), ordinal: ordinal++, data: JSON.stringify(v) });
      }
      if (s.path.length) setAt(restRoot, s.path, {});
    } else if (s.kind === 'conversations' && isPlainObject(container)) {
      present.push(s.name);
      for (const [id, conv] of Object.entries(container)) {
        const legacyArray = Array.isArray(conv);
        const msgs = legacyArray ? conv : (Array.isArray(conv?.messages) ? conv.messages : null);
        const owner = String(s.ownerOf(id, legacyArray ? { meta: {} } : conv) ?? GLOBAL_OWNER);
        // The header keeps the conversation's own key order; `messages` holds a
        // marker in its original position.
        const header = legacyArray ? { [ARRAY_MARK]: true } : (msgs ? { ...conv, messages: MESSAGES_MARK } : conv);
        partitions.push({ partitionKey: `c:${id}`, ownerId: owner, ordinal: ordinal++, data: JSON.stringify(header) });
        // Phase 4A (found by the migration test): a key seen twice in one
        // conversation (the same message persisted twice) would map two
        // messages to ONE row and abort the migration batch. The repeat falls
        // back to its position key, so both messages are kept, in order.
        const seenKeys = new Set();
        (msgs ?? []).forEach((m, i) => {
          // A message written while partitions were on carries its own key (`mid`);
          // older messages are keyed by their position.
          let k = typeof m?.mid === 'string' && /^[0-9a-z-]+$/.test(m.mid) ? m.mid : legacyMessageKey(i);
          if (seenKeys.has(k)) k = legacyMessageKey(i);
          seenKeys.add(k);
          partitions.push({ partitionKey: messageKey(id, k), ownerId: owner, ordinal: ordinal++, data: JSON.stringify(m) });
        });
      }
    } else if (s.kind === 'array' && Array.isArray(container)) {
      present.push(s.name);
      container.forEach((item, i) => {
        const k = s.keyOf(item, i);
        partitions.push({ partitionKey: `${s.name}:${k}`, ownerId: String(s.ownerOf(k, item) ?? GLOBAL_OWNER), ordinal: ordinal++, data: JSON.stringify(item) });
      });
      if (s.path.length) setAt(restRoot, s.path, []);
    }
  }

  // A section at the root replaces the whole root; the rest keeps an empty one.
  let restDoc = rest;
  const rootSection = sections.find(s => !s.path.length && present.includes(s.name));
  if (rootSection) {
    const empty = rootSection.kind === 'array' ? [] : {};
    if (envelope) rest.data = empty; else restDoc = empty;
  }

  partitions.push({
    partitionKey: REST_KEY,
    ownerId: GLOBAL_OWNER,
    ordinal: null,
    data: JSON.stringify({ envelope, sections: present, doc: restDoc }),
  });
  return { storeKey: key, envelope, partitions };
}

const byOrder = (a, b) => {
  const ao = a.ordinal ?? Number.POSITIVE_INFINITY;
  const bo = b.ordinal ?? Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao - bo;
  return a.partitionKey < b.partitionKey ? -1 : a.partitionKey > b.partitionKey ? 1 : 0;
};

/**
 * Reassemble a store file from its LIVE partitions (tombstones excluded by the caller).
 *
 * Without a `~rest` partition (a store first created in partitions, never
 * migrated from a file) the result is a bare map of the first section, which
 * every loader accepts (unwrapStore treats a bare object as schema 0).
 *
 * @param {string} storeKey
 * @param {Array<{ partitionKey: string, data: string, ordinal?: number|null }>} rows
 * @returns {string} JSON text
 */
export function reassembleStore(storeKey, rows) {
  const sections = layoutFor(storeKey);
  const restRow = rows.find(r => r.partitionKey === REST_KEY);
  const rest = restRow ? JSON.parse(restRow.data) : null;
  const envelope = rest?.envelope ?? false;
  const present = rest?.sections ?? (sections[0] ? [sections[0].name] : []);
  let doc = rest ? structuredClone(rest.doc) : (sections[0]?.kind === 'array' ? [] : {});

  const ordered = rows.filter(r => r.partitionKey !== REST_KEY).sort(byOrder);

  for (const s of sections) {
    if (!present.includes(s.name)) continue;
    if (s.kind === 'conversations') {
      const container = assembleConversations(ordered);
      if (envelope) doc.data = container; else doc = container;
      continue;
    }
    const prefix = `${s.name}:`;
    const mine = ordered.filter(r => r.partitionKey.startsWith(prefix));
    let container;
    if (s.kind === 'array') {
      container = mine.map(r => JSON.parse(r.data));
    } else {
      container = {};
      // defineProperty, not assignment: a key named "__proto__" (JSON.parse
      // makes it an own property) would otherwise set the prototype and vanish.
      for (const r of mine) {
        Object.defineProperty(container, r.partitionKey.slice(prefix.length),
          { value: JSON.parse(r.data), enumerable: true, writable: true, configurable: true });
      }
    }
    if (!s.path.length) {
      if (envelope) doc.data = container; else doc = container;
    } else {
      const root = envelope ? doc.data : doc;
      setAt(root, s.path, container);
    }
  }
  return JSON.stringify(doc);
}

// ── Conversations: header + message rows ─────────────────────────────────────
export const MESSAGES_MARK = '\u0000messages';
export const ARRAY_MARK = '\u0000array';
/** Legacy (migrated) messages: their index, zero-padded. Sorts before every new key. */
export const legacyMessageKey = i => `0-${String(i).padStart(6, '0')}`;
export const messageKey = (conversationId, key) => `m:${conversationId}:${key}`;
export const headerKey = conversationId => `c:${conversationId}`;
/** `m:<conv>:<key>` → { conversationId, key }. Conversation ids may contain ':'; message keys never do. */
export function parseMessageKey(partitionKey) {
  if (!partitionKey.startsWith('m:')) return null;
  const rest = partitionKey.slice(2);
  const at = rest.lastIndexOf(':');
  return at < 0 ? null : { conversationId: rest.slice(0, at), key: rest.slice(at + 1) };
}

/** Rows (already in order) → { <conv>: { ...header, messages: [...] } }. Orphan messages (no live header) are dropped. */
function assembleConversations(ordered) {
  const msgs = new Map();
  for (const r of ordered) {
    const p = parseMessageKey(r.partitionKey);
    if (!p) continue;
    if (!msgs.has(p.conversationId)) msgs.set(p.conversationId, []);
    msgs.get(p.conversationId).push(JSON.parse(r.data));
  }
  const out = {};
  for (const r of ordered) {
    if (!r.partitionKey.startsWith('c:')) continue;
    const id = r.partitionKey.slice(2);
    const header = JSON.parse(r.data);
    let conv;
    if (header?.[ARRAY_MARK]) conv = msgs.get(id) ?? [];
    else if (header?.messages === MESSAGES_MARK) { conv = { ...header }; conv.messages = msgs.get(id) ?? []; }
    else conv = header;
    Object.defineProperty(out, id, { value: conv, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** The owner a single partition belongs to, from its key and value (for new writes). */
export function ownerForPartition(storeKey, partitionKey, value) {
  if (partitionKey === REST_KEY) return GLOBAL_OWNER;
  const idx = partitionKey.indexOf(':');
  const name = partitionKey.slice(0, idx);
  const key = partitionKey.slice(idx + 1);
  const s = layoutFor(storeKey).find(x => x.name === name);
  if (!s) return GLOBAL_OWNER;
  return String(s.ownerOf(key, value) ?? GLOBAL_OWNER);
}
