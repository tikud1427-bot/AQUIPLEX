/**
 * AQUA Conversations — revision-based message persistence (scalability Phase 2b, step 3)
 *
 * The whole-file history store rewrote EVERY conversation of EVERY user when one
 * message was added. Here a conversation is:
 *
 *   c:<conversationId>              the header: everything but the messages (meta)
 *   m:<conversationId>:<messageKey> one row per message
 *
 * in `aqua_store_partitions`, owned by `user:<meta.userId>` (or `conv:<id>`).
 *
 * MESSAGE MODEL
 *   stable id      every message has a key that never changes. Messages written
 *                  while partitions are on carry it as `mid` ("1-<ts36>-<rand>",
 *                  sorts chronologically). Older messages are keyed by their
 *                  position at migration ("0-000042"), which sorts before all new
 *                  ones; their migration ordinal keeps their order.
 *   insertion      an independent INSERT of a new row. Two instances appending to
 *                  one conversation never contend; order is by key (time).
 *                  A retry after a lost acknowledgement finds its own identical
 *                  row and succeeds (idempotent); a different row under the same
 *                  key (a 1-in-2^30 collision) is re-keyed, never overwritten.
 *   edits          `editMessage` writes one row, CHECKED against the version the
 *                  caller saw. Another edit in between is an explicit conflict:
 *                  `{ ok: false, conflict: true, current }` — never a silent
 *                  overwrite. `rev` and `editedAt` record the revision.
 *   deletion       a message is a tombstone row; a conversation is a tombstoned
 *                  header plus a tombstone for every one of its message rows,
 *                  including rows another instance wrote that this one never saw.
 *                  A header deleted elsewhere wins over a local metadata change.
 *   metadata       header writes re-apply only the meta FIELDS this process
 *                  changed onto the latest header (title from one tab, pin from
 *                  another: both kept). updatedAt takes the later time.
 *
 * MODES: AQUA_STORE_PARTITIONS=history:<off|shadow|on|only> — same meanings as
 * core/storage/ownerBinding.js. Off (the default) changes nothing at all: no
 * `mid` field, no rows, the JSON file exactly as before.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

import {
  parsePartitionModes, registerPartitionBinding, partitionRepositoryForBindings, partitionsDatabaseConfigured,
} from '../core/storage/ownerBinding.js';
import { PartitionConflictError } from '../core/storage/partitionRepository.js';
import { headerKey, messageKey, parseMessageKey, legacyMessageKey, MESSAGES_MARK } from '../core/storage/partitionLayout.js';
import { errorText } from '../core/errorText.js';
import { isOwnerDeleted, OwnerDeletedError } from '../core/storage/deletedOwners.js';
import { noteWrite } from '../core/storage/requestWrites.js';
import { registerFenceInvalidator, isWriteRefused, originFor, withWriteOrigins } from '../core/storage/writeFence.js';

export const STORE_KEY = '.aqua-history.json';
export const TRASH_STORE_KEY = '.aqua-history-trash.json';
const TRASH_PER_OWNER = 40;
/** The message's key, held on the object without changing its JSON. */
export const MESSAGE_KEY = Symbol('aqua.messageKey');
const RETRY_CAP_MS = 30_000;
const EDITABLE = new Set(['content', 'contextRefs']);

// Time first, then a per-process sequence (two messages in one millisecond keep
// the order they were added), then randomness (two processes never collide).
let lastTs = 0;
let seq = 0;
export const newMessageKey = (ts = Date.now()) => {
  const t = Math.max(0, Number(ts) || 0);
  seq = t === lastTs ? seq + 1 : 0;
  lastTs = t;
  return `1-${t.toString(36).padStart(9, '0')}-${seq.toString(36).padStart(4, '0')}-${crypto.randomBytes(4).toString('hex')}`;
};
export const conversationOwner = (id, conv) =>
  conv?.meta?.userId != null && String(conv.meta.userId) !== '' ? `user:${conv.meta.userId}` : `conv:${id}`;
const isNewKey = k => typeof k === 'string' && /^[0-9a-z-]+$/.test(k);

/**
 * @param {object} args
 * @param {string} args.file   the JSON history file (rollback copy in `on` mode)
 * @param {Map}    args.store  conversationStore's Map<conversationId, { messages, meta }>
 * @param {() => void} [args.reloadJson]
 */
export function bindConversationStore({ file, store, reloadJson = null, mode: forced = null }) {
  let mode = forced ?? parsePartitionModes().get(STORE_KEY) ?? 'off';
  let reason = null;
  if (mode !== 'off' && !partitionsDatabaseConfigured()) {
    reason = `AQUA_STORE_PARTITIONS asked for ${mode} but DATABASE_URL is not set`;
    mode = 'off';
  }
  const repo = () => partitionRepositoryForBindings();
  const authoritative = () => mode === 'on' || mode === 'only';

  /** conversationId → { owner, headerVersion, msgs: Map<key, { version, ordinal, msg }> } */
  const state = new Map();
  const ownerConvs = new Map();      // owner → Set<conversationId>
  const loadedOwners = new Map();    // owner → true, LRU order
  const ops = [];
  // Multi-instance connect safety (core/storage/writeFence.js): op keys whose
  // writes were DISCARDED because their owner's write fence was lost.
  const discarded = new Map();       // opKey → FenceLostError
  const metaDirty = new Map();       // conversationId → Set<metaKey> | 'all'
  const deletingConvs = new Set();
  const backupPending = new Map();   // conversationId → conv | null
  const maxOwners = Number(process.env.AQUA_PARTITION_STORE_OWNERS) > 0 ? Number(process.env.AQUA_PARTITION_STORE_OWNERS) : 2_000;
  const stats = { inserts: 0, idempotentRetries: 0, rekeyed: 0, headerWrites: 0, headerMerges: 0, edits: 0, editConflicts: 0,
    messageDeletes: 0, conversationDeletes: 0, droppedDeletedElsewhere: 0, failures: 0, retries: 0, fetched: 0, evictions: 0 };
  let lastError = null;
  let timer = null;
  let running = null;
  let retryDelay = 0;
  let backupWriter = null;

  const stateFor = (id, owner) => {
    let st = state.get(id);
    if (!st) { st = { owner, headerVersion: 0, msgs: new Map() }; state.set(id, st); }
    if (owner && st.owner !== owner) st.owner = owner;
    if (st.owner) { if (!ownerConvs.has(st.owner)) ownerConvs.set(st.owner, new Set()); ownerConvs.get(st.owner).add(id); }
    return st;
  };
  const keyOf = (msg, i) => msg?.[MESSAGE_KEY] ?? (isNewKey(msg?.mid) ? msg.mid : legacyMessageKey(i));
  const headerOf = conv => { const h = { ...conv }; h.messages = MESSAGES_MARK; return h; };

  /** Phase 4A — the key a request's write boundary tracks for an op. */
  const opKey = op => (op.id != null ? String(op.id) : `owner:${op.owner}`);
  /** Queue an op and record it in the current request's write scope. */
  // Safety Fix 3: an op carries the connect-operation fence it was CREATED under
  // (null outside any operation) to its eventual write, whatever context flushes it.
  const enqueueOp = op => {
    const owner = op.owner ?? state.get(op.id)?.owner ?? conversationOwner(op.id, store.get(op.id));
    op.origin = originFor(owner);
    discarded.delete(opKey(op)); ops.push(op); noteWrite(binding, opKey(op));
  };
  const applyWithOrigin = op => withWriteOrigins(op.origin ? [op.origin] : [], () => applyOp(op));

  function schedule(delay = 50) {
    if (mode === 'off' || timer) return;
    timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, delay);
    timer.unref?.();
  }

  function rebuild(conv, st) {
    const ordered = [...st.msgs.entries()]
      .sort(([ka, a], [kb, b]) => {
        const oa = a.ordinal ?? Number.POSITIVE_INFINITY; const ob = b.ordinal ?? Number.POSITIVE_INFINITY;
        return oa !== ob ? oa - ob : (ka < kb ? -1 : ka > kb ? 1 : 0);
      })
      .map(([, e]) => e.msg);
    conv.messages.length = 0;
    conv.messages.push(...ordered);
  }

  // A fence was lost (Safety Fix 3: per operation): drop ONLY the queued ops
  // CREATED UNDER IT (recorded as discarded) and, where partitions are
  // authoritative, the local copies of their conversations — the next unit of
  // work reloads them. Ops created outside that operation: untouched.
  registerFenceInvalidator((owner, err, fence) => {
    if (mode === 'off' || !fence) return;
    const convs = new Set();
    for (let i = 0; i < ops.length; i++) {
      if (ops[i].origin === fence) {
        if (ops[i].id) convs.add(ops[i].id);
        discarded.set(opKey(ops[i]), err); ops.splice(i, 1); i--; stats.fenceDiscards = (stats.fenceDiscards ?? 0) + 1;
      }
    }
    if (authoritative()) for (const id of convs) removeLocal(id);
  });

  function removeLocal(id) {
    const st = state.get(id);
    if (st?.owner) ownerConvs.get(st.owner)?.delete(id);
    state.delete(id);
    store.delete(id);
    metaDirty.delete(id);
  }

  // ── hooks called by conversationStore ─────────────────────────────────────
  const hooks = {
    /** After the JSON boot load (off/shadow): give every message its key. */
    adoptJsonLoaded() {
      if (mode === 'off') return;
      for (const [id, conv] of store) {
        const st = stateFor(id, conversationOwner(id, conv));
        conv.messages.forEach((m, i) => {
          const key = keyOf(m, i);
          m[MESSAGE_KEY] = key;
          if (!st.msgs.has(key)) st.msgs.set(key, { version: 0, ordinal: i, msg: m });
        });
      }
    },
    created(id) {
      if (mode === 'off') return;
      stateFor(id, conversationOwner(id, store.get(id)));
      metaDirty.set(id, 'all');
      enqueueOp({ t: 'header', id });
      schedule();
    },
    metaChanged(id, keys) {
      if (mode === 'off') return;
      const cur = metaDirty.get(id);
      if (cur !== 'all') {
        const set = cur ?? new Set();
        for (const k of keys) set.add(k);
        metaDirty.set(id, set);
      }
      enqueueOp({ t: 'header', id });
      schedule();
    },
    /** Called with the message object BEFORE it is pushed; returns the message (with `mid` set). */
    messageAdded(id, msg) {
      if (mode === 'off') return msg;
      const conv = store.get(id);
      const key = newMessageKey(msg.ts);
      msg.mid = key;
      msg[MESSAGE_KEY] = key;
      const st = stateFor(id, conversationOwner(id, conv));
      st.msgs.set(key, { version: 0, ordinal: null, msg });
      enqueueOp({ t: 'insert', id, key, msg, owner: st.owner });
      hooks.metaChanged(id, ['updatedAt']);
      return msg;
    },
    messagesTrimmed(id, removed) {
      if (mode === 'off') return;
      const st = state.get(id);
      for (const m of removed) {
        const key = m?.[MESSAGE_KEY];
        if (!key) continue;
        st?.msgs.delete(key);
        enqueueOp({ t: 'delMsg', id, key, owner: st?.owner ?? conversationOwner(id, store.get(id)) });
      }
      schedule();
    },
    /**
     * Partitions authoritative: keep the deleted conversation's recovery
     * snapshot as a row in the trash store (one per deletion, owned by the
     * user, newest 40 per user kept) instead of the local rolling file.
     * Returns false when the caller should write the file as today.
     */
    trashed(id) {
      if (!authoritative()) return false;
      const conv = store.get(id);
      if (!conv) return true;
      const deletedAt = Date.now();
      const owner = conversationOwner(id, conv);
      const key = `t:${deletedAt.toString(36).padStart(9, '0')}-${crypto.randomBytes(3).toString('hex')}:${id}`;
      enqueueOp({ t: 'trash', id, owner, key, data: JSON.stringify({ id, deletedAt, ...conv }) });
      schedule();
      return true;
    },
    /** Account deletion: retire every trash snapshot of this user. Returns false off partitions. */
    trashPurged(userId) {
      if (!authoritative() || !userId) return false;
      enqueueOp({ t: 'trashPurge', id: null, owner: `user:${userId}` });
      schedule(0);
      return true;
    },
    /** Called BEFORE the store forgets the conversation. */
    conversationDeleted(id) {
      if (mode === 'off') return;
      const conv = store.get(id);
      const st = state.get(id);
      const owner = st?.owner ?? conversationOwner(id, conv);
      deletingConvs.add(id);
      enqueueOp({ t: 'delConv', id, owner, keys: [...(st?.msgs.keys() ?? [])] });
      if (st) ownerConvs.get(st.owner)?.delete(id);
      state.delete(id);
      metaDirty.delete(id);
      schedule(0);
    },
  };

  // ── writes ───────────────────────────────────────────────────────────────
  async function applyOp(op) {
    const R = repo();
    // Phase 3: nothing of a deleted account is written back (deletions still land).
    if (['insert', 'header', 'trash'].includes(op.t)) {
      const owner = op.owner ?? state.get(op.id)?.owner ?? conversationOwner(op.id, store.get(op.id));
      // Refused explicitly (discarded by the caller, never retried) — not a silent success.
      if (await isOwnerDeleted(owner)) { stats.blockedDeletedOwner = (stats.blockedDeletedOwner ?? 0) + 1; throw new OwnerDeletedError(); }
    }
    if (op.t === 'insert') {
      if (deletingConvs.has(op.id) || !state.has(op.id)) return;
      let key = op.key;
      const data = JSON.stringify(op.msg);
      let headerRetried = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        // Phase 2c: the insert succeeds only while the conversation header is
        // LIVE, checked under a share lock in the same statement. A message can
        // no longer land in a conversation another instance has deleted.
        const r = await R.insertChild({ storeKey: STORE_KEY, parentKey: headerKey(op.id), partitionKey: messageKey(op.id, key), data, ownerId: op.owner });
        if (r.status === 'inserted') {
          const e = state.get(op.id)?.msgs.get(key);
          if (e) e.version = r.version;
          stats.inserts++;
          return;
        }
        if (r.status === 'parent-gone') {
          const header = await R.get(STORE_KEY, headerKey(op.id), { fresh: true });
          if (header.deleted) {
            // Deleted by another instance: the deletion wins; this message is not written.
            stats.droppedDeletedElsewhere++;
            if (authoritative()) removeLocal(op.id);
            return;
          }
          if (headerRetried || !store.has(op.id)) throw new Error(`conversation header ${op.id} could not be written`);
          // Header never written here (a conversation from before partitions):
          // write it, then retry the insert.
          headerRetried = true;
          metaDirty.set(op.id, 'all');
          await applyOp({ t: 'header', id: op.id });
          continue;
        }
        if (r.data === data) {                   // our own earlier attempt landed: idempotent
          const e = state.get(op.id)?.msgs.get(key);
          if (e) e.version = r.version;
          stats.idempotentRetries++;
          return;
        }
        // A different row under this key: re-key OUR message, never overwrite.
        const st = state.get(op.id);
        const e = st?.msgs.get(key);
        const oldKey = key;
        key = newMessageKey(op.msg.ts);
        op.msg.mid = key;
        op.msg[MESSAGE_KEY] = key;
        if (st && e) { st.msgs.delete(oldKey); st.msgs.set(key, e); }
        stats.rekeyed++;
      }
      throw new Error(`message insert could not find a free key for ${op.id}`);
    }

    if (op.t === 'header') {
      const keys = metaDirty.get(op.id);
      if (!keys) return;                         // already written by an earlier coalesced op
      metaDirty.delete(op.id);
      const conv = store.get(op.id);
      if (!conv || deletingConvs.has(op.id)) return;
      const owner = conversationOwner(op.id, conv);
      let written = null;
      let deletedElsewhere = false;
      try {
        const r = await R.update(STORE_KEY, headerKey(op.id), (cur, meta) => {
          if (meta.deleted) { deletedElsewhere = true; return undefined; }
          const ours = headerOf(conv);
          if (!cur) { written = ours; return JSON.stringify(ours); }
          const base = JSON.parse(cur);
          let next;
          if (keys === 'all') {
            next = { ...base, ...ours, meta: { ...(base.meta ?? {}), ...(ours.meta ?? {}) } };
          } else {
            next = { ...base, meta: { ...(base.meta ?? {}) } };
            for (const k of keys) { if (k in conv.meta) next.meta[k] = conv.meta[k]; else delete next.meta[k]; }
            stats.headerMerges++;
          }
          if (Number.isFinite(base.meta?.updatedAt) && Number.isFinite(next.meta?.updatedAt)) {
            next.meta.updatedAt = Math.max(base.meta.updatedAt, next.meta.updatedAt);
          }
          written = next;
          const text = JSON.stringify(next);
          return text === cur ? undefined : text;
        }, { ownerId: owner, maxAttempts: 20 });
        if (deletedElsewhere) { stats.droppedDeletedElsewhere++; if (authoritative()) removeLocal(op.id); return; }
        stats.headerWrites++;
        const st = stateFor(op.id, owner);
        st.headerVersion = r.version;
        // Fields another process wrote become visible here, unless we changed meta again meanwhile.
        if (authoritative() && written && !metaDirty.has(op.id)) Object.assign(conv.meta, written.meta);
      } catch (err) {
        // Put the fields back so the retry still writes them.
        const again = metaDirty.get(op.id);
        if (keys === 'all' || again === 'all') metaDirty.set(op.id, 'all');
        else metaDirty.set(op.id, new Set([...(keys ?? []), ...(again ?? [])]));
        throw err;
      }
      return;
    }

    if (op.t === 'trash') {
      // A deleted conversation's recovery snapshot: its own row, owned by its user.
      await R.put(TRASH_STORE_KEY, op.key, op.data, { ownerId: op.owner, expectedVersion: 0 });
      const versions = (await R.ownerVersions(op.owner, [TRASH_STORE_KEY])).get(TRASH_STORE_KEY) ?? new Map();
      const live = [...versions].filter(([, v]) => !v.deleted).map(([k]) => k).sort();
      for (const k of live.slice(0, Math.max(0, live.length - TRASH_PER_OWNER))) {
        await R.update(TRASH_STORE_KEY, k, () => null, { ownerId: op.owner, maxAttempts: 10 });
      }
      return;
    }

    if (op.t === 'trashPurge') {
      await R.tombstonePrefix({ storeKey: TRASH_STORE_KEY, ownerId: op.owner, prefix: 't:' });
      return;
    }

    if (op.t === 'delMsg') {
      await R.update(STORE_KEY, messageKey(op.id, op.key), () => null, { ownerId: op.owner, maxAttempts: 20 });
      stats.messageDeletes++;
      return;
    }

    if (op.t === 'delConv') {
      // Phase 2c: ONE transaction. The header is locked first, which waits for
      // any in-flight message insert (they hold a share lock on it); then EVERY
      // message row of the conversation is retired, including rows this process
      // never saw. An insert starting after this commits finds no live header.
      await R.tombstoneGroup({ storeKey: STORE_KEY, parentKey: headerKey(op.id), childPrefix: `m:${op.id}:`, ownerId: op.owner });
      deletingConvs.delete(op.id);
      stats.conversationDeletes++;
    }
  }

  async function backupFlush(ids) {
    if (mode !== 'on' || !ids.size) return;
    for (const id of ids) backupPending.set(id, store.get(id) ?? null);
    if (!backupWriter) {
      const { createDebouncedWriter } = await import('../core/atomicStore.js');
      backupWriter = createDebouncedWriter(file);
    }
    backupWriter.schedule(() => {
      let doc = null;
      try { doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch { doc = null; }
      const isEnv = doc && typeof doc === 'object' && doc.__aqua && 'data' in doc;
      const data = (isEnv ? doc.data : doc) ?? {};
      for (const [id, conv] of backupPending) { if (conv === null) delete data[id]; else data[id] = conv; }
      backupPending.clear();
      return JSON.stringify(isEnv ? { ...doc, __aqua: { ...doc.__aqua, savedAt: Date.now() }, data }
        : { __aqua: { schema: 1, savedAt: Date.now() }, data });
    });
  }

  async function flush() {
    while (running) await running;
    if (!ops.length) return;
    running = (async () => {
      const batch = ops.splice(0);
      const touched = new Set();
      let failedAt = -1;
      for (let i = 0; i < batch.length; i++) {
        const lost = batch[i].origin?.lost;
        if (lost) { discarded.set(opKey(batch[i]), lost); stats.fenceDiscards = (stats.fenceDiscards ?? 0) + 1; continue; }
        try {
          await applyWithOrigin(batch[i]);
          if (batch[i].id) touched.add(batch[i].id);
        } catch (err) {
          if (isWriteRefused(err)) {   // fence lost / account deleted: never into the retry queue
            discarded.set(opKey(batch[i]), err); stats.fenceDiscards = (stats.fenceDiscards ?? 0) + 1;
            continue;
          }
          // Phase 3: a row owned by someone else will never accept this write.
          // Retrying it would block every later write of this process behind
          // it (ops apply in order) — drop it, loudly.
          if (err instanceof PartitionOwnershipError) {
            stats.ownershipDropped = (stats.ownershipDropped ?? 0) + 1;
            lastError = errorText(err);
            console.error(`[STORE] history: dropped a write to a row of another owner (${batch[i].t} ${batch[i].id ?? ''}): ${lastError}`);
            if (batch[i].id && authoritative()) removeLocal(batch[i].id);
            continue;
          }
          stats.failures++;
          lastError = errorText(err);
          failedAt = i;
          break;   // keep order: this op and everything after it retry together
        }
      }
      if (failedAt >= 0) {
        ops.unshift(...batch.slice(failedAt));
        retryDelay = Math.min(RETRY_CAP_MS, Math.max(500, retryDelay * 2));
        stats.retries++;
        console.error(`[STORE] history partition flush failed (${mode}), ${ops.length} op(s) pending, retry in ${retryDelay}ms: ${lastError}`);
        schedule(retryDelay);
      } else {
        retryDelay = 0;
      }
      await backupFlush(touched);
    })();
    try { await running; } finally { running = null; }
    if (ops.length && !timer) schedule();
  }

  // ── loads (unit of work) ──────────────────────────────────────────────────
  function touchOwner(owner) {
    loadedOwners.delete(owner);
    loadedOwners.set(owner, true);
    if (loadedOwners.size <= maxOwners) return;
    const busy = new Set(ops.map(o => state.get(o.id)?.owner ?? o.owner));
    for (const candidate of [...loadedOwners.keys()]) {
      if (loadedOwners.size <= maxOwners) break;
      if (candidate === owner || busy.has(candidate)) continue;
      loadedOwners.delete(candidate);
      for (const id of ownerConvs.get(candidate) ?? []) { state.delete(id); store.delete(id); }
      ownerConvs.delete(candidate);
      stats.evictions++;
    }
  }

  const binding = {
    storeKey: STORE_KEY,
    label: 'history',
    get mode() { return mode; },
    get reason() { return reason; },
    authoritative,
    loadsJsonAtBoot: () => mode === 'off' || mode === 'shadow',
    writesWholeJson: () => mode === 'off' || mode === 'shadow',
    ready: owner => !authoritative() || loadedOwners.has(owner),
    isLoaded: owner => loadedOwners.has(owner),
    hooks,

    wanted(owner, versions) {
      if (!authoritative()) return [];
      const want = [];
      for (const [pk, v] of versions) {
        if (v.deleted) continue;
        if (pk.startsWith('c:')) {
          const id = pk.slice(2);
          if (metaDirty.has(id) || deletingConvs.has(id)) continue;
          if (state.get(id)?.headerVersion !== v.version || !store.has(id)) want.push(pk);
        } else {
          const p = parseMessageKey(pk);
          if (!p || deletingConvs.has(p.conversationId)) continue;
          if (state.get(p.conversationId)?.msgs.get(p.key)?.version !== v.version || !store.has(p.conversationId)) want.push(pk);
        }
      }
      return want;
    },

    applyOwner(owner, versions, rows) {
      if (!authoritative()) return;
      stats.fetched += rows.size;
      const msgsByConv = new Map();
      const headers = new Map();
      for (const [pk, v] of versions) {
        if (pk.startsWith('c:')) headers.set(pk.slice(2), v);
        else { const p = parseMessageKey(pk); if (p) { if (!msgsByConv.has(p.conversationId)) msgsByConv.set(p.conversationId, new Map()); msgsByConv.get(p.conversationId).set(p.key, { v, pk }); } }
      }
      const seen = new Set();
      for (const [id, hv] of headers) {
        seen.add(id);
        if (deletingConvs.has(id)) continue;
        if (hv.deleted) { if (store.has(id) && !metaDirty.has(id)) removeLocal(id); continue; }
        const row = rows.get(headerKey(id));
        let conv = store.get(id);
        const st = stateFor(id, owner);
        if (row && !metaDirty.has(id)) {
          const header = JSON.parse(row.data);
          if (!conv) { conv = { messages: [], meta: {} }; store.set(id, conv); }
          for (const [k, val] of Object.entries(header)) { if (k !== 'messages' && k !== 'meta') conv[k] = val; }
          for (const k of Object.keys(conv.meta)) if (!(k in (header.meta ?? {}))) delete conv.meta[k];
          Object.assign(conv.meta, header.meta ?? {});
          st.headerVersion = hv.version;
        }
        if (!conv) continue;
        let changed = Boolean(row);
        const live = msgsByConv.get(id) ?? new Map();
        for (const [key, { v, pk }] of live) {
          if (v.deleted) { if (st.msgs.delete(key)) changed = true; continue; }
          const mrow = rows.get(pk);
          if (mrow) {
            const obj = JSON.parse(mrow.data);
            obj[MESSAGE_KEY] = key;
            const held = st.msgs.get(key);
            if (held?.msg) { for (const k of Object.keys(held.msg)) delete held.msg[k]; Object.assign(held.msg, obj); held.version = v.version; held.ordinal = mrow.ordinal ?? held.ordinal; }
            else st.msgs.set(key, { version: v.version, ordinal: mrow.ordinal ?? null, msg: obj });
            changed = true;
          }
        }
        // Rows gone from the database entirely (not tombstoned): drop, unless still being inserted here.
        for (const [key, e] of [...st.msgs]) if (!live.has(key) && e.version !== 0) { st.msgs.delete(key); changed = true; }
        if (changed) rebuild(conv, st);
      }
      // Conversations of this owner held here that the database no longer has at all.
      for (const id of [...(ownerConvs.get(owner) ?? [])]) {
        if (!seen.has(id) && !metaDirty.has(id) && !deletingConvs.has(id) && state.get(id)?.headerVersion) removeLocal(id);
      }
      touchOwner(owner);
    },

    /** Versioned edit of one message. Conflicts are returned, never overwritten. */
    async editMessage(id, key, patch) {
      const conv = store.get(id);
      const st = state.get(id);
      const held = st?.msgs.get(key);
      const msg = held?.msg ?? conv?.messages.find((m, i) => keyOf(m, i) === key);
      if (!conv || !msg) return { ok: false, reason: 'not-found' };
      const clean = Object.fromEntries(Object.entries(patch ?? {}).filter(([k]) => EDITABLE.has(k)));
      if (!Object.keys(clean).length) return { ok: false, reason: 'nothing-editable' };
      if (mode === 'off') { Object.assign(msg, clean, { rev: (msg.rev ?? 0) + 1, editedAt: Date.now() }); return { ok: true, version: null }; }
      await flush();                                       // our own pending insert must land first
      const R = repo();
      const expected = st?.msgs.get(key)?.version ?? 0;
      const next = { ...msg, ...clean, rev: (msg.rev ?? 0) + 1, editedAt: Date.now() };
      try {
        const r = await R.put(STORE_KEY, messageKey(id, key), JSON.stringify(next), { ownerId: st?.owner ?? conversationOwner(id, conv), expectedVersion: expected });
        Object.assign(msg, clean, { rev: next.rev, editedAt: next.editedAt });
        if (st?.msgs.get(key)) st.msgs.get(key).version = r.version;
        stats.edits++;
        await backupFlush(new Set([id]));
        return { ok: true, version: r.version, rev: next.rev };
      } catch (err) {
        if (!(err instanceof PartitionConflictError)) throw err;
        stats.editConflicts++;
        const cur = await R.get(STORE_KEY, messageKey(id, key), { fresh: true });
        if (cur.deleted || cur.data == null) {
          st?.msgs.delete(key);
          if (st) rebuild(conv, st);
          return { ok: false, conflict: true, deleted: true, version: cur.version };
        }
        const current = JSON.parse(cur.data);
        for (const k of Object.keys(msg)) delete msg[k];
        Object.assign(msg, current);
        if (st?.msgs.get(key)) st.msgs.get(key).version = cur.version;
        return { ok: false, conflict: true, current, version: cur.version };
      }
    },

    /** Delete one message (tombstone). */
    async deleteMessage(id, key) {
      const conv = store.get(id);
      if (!conv) return { ok: false, reason: 'not-found' };
      const idx = conv.messages.findIndex((m, i) => keyOf(m, i) === key);
      if (idx < 0) return { ok: false, reason: 'not-found' };
      const st = state.get(id);
      if (mode !== 'off') {
        await flush();
        st?.msgs.delete(key);
        enqueueOp({ t: 'delMsg', id, key, owner: st?.owner ?? conversationOwner(id, conv) });
      }
      conv.messages.splice(idx, 1);
      if (mode !== 'off') await flush();
      return { ok: true };
    },

    /**
     * Phase 3 — THE DURABLE TURN COMMIT. This turn's message rows and its
     * learning jobs (`jobsWithin(client, keys)` enqueues them on the
     * transaction's client) in ONE transaction, only while the conversation is
     * live. Either the turn and everything it must teach the system are in the
     * database, or neither is: on any failure the messages are removed here
     * too, and this throws — the caller must not acknowledge the turn.
     *
     * Requires history partitions `on`/`only` (otherwise the messages are not
     * rows and cannot share a transaction with the jobs).
     * @param {string} id
     * @param {object[]} msgs   message objects already added by addMessage (in order)
     * @param {(client, keys: string[]) => Promise<any>} jobsWithin
     */
    async commitTurn(id, msgs, jobsWithin) {
      if (!authoritative()) throw Object.assign(new Error(`durable turn commit needs history partitions on (mode ${mode})`), { code: 'TURN_COMMIT_UNAVAILABLE' });
      const st = state.get(id);
      const conv = store.get(id);
      const owner = st?.owner ?? conversationOwner(id, conv);
      const mine = new Set(msgs);
      // Take this turn's inserts out of the background queue: they are written
      // HERE, inside the transaction. (One already taken by a running flush is
      // written by it; our insert then finds its own row and is idempotent.)
      for (let i = ops.length - 1; i >= 0; i--) if (ops[i].t === 'insert' && mine.has(ops[i].msg)) ops.splice(i, 1);
      const undo = () => {
        for (const m of msgs) {
          const k = m?.[MESSAGE_KEY];
          if (k) st?.msgs.delete(k);
          const at = conv?.messages.indexOf(m) ?? -1;
          if (at >= 0) conv.messages.splice(at, 1);
        }
      };
      try {
        if (await isOwnerDeleted(owner)) throw Object.assign(new Error('owner deleted'), { code: 'OWNER_DELETED' });
        // This conversation's queued ops only (its header: new conversation, updatedAt);
        // other users' pending writes are not this turn's business (Phase 4A).
        await binding.flushOnly(new Set([String(id)]));
        const R = repo();
        for (let attempt = 0; attempt < 3; attempt++) {
          const children = msgs.map(m => ({ partitionKey: messageKey(id, m[MESSAGE_KEY]), data: JSON.stringify(m) }));
          const keys = msgs.map(m => m[MESSAGE_KEY]);
          const r = await R.insertChildrenTx({ storeKey: STORE_KEY, parentKey: headerKey(id), ownerId: owner, children,
            within: client => jobsWithin(client, keys) });
          if (r.status === 'committed') {
            for (const m of msgs) { const e = st?.msgs.get(m[MESSAGE_KEY]); if (e) e.version = r.versions.get(messageKey(id, m[MESSAGE_KEY])) ?? e.version; }
            stats.durableTurns = (stats.durableTurns ?? 0) + 1;
            backupFlush(new Set([id])).catch(() => {});
            return { keys, jobs: r.extra };
          }
          if (r.status === 'collision') {          // astronomically rare: a new key, never an overwrite
            const m = msgs.find(x => messageKey(id, x[MESSAGE_KEY]) === r.partitionKey);
            const e = st?.msgs.get(m[MESSAGE_KEY]);
            st?.msgs.delete(m[MESSAGE_KEY]);
            const k = newMessageKey(m.ts); m.mid = k; m[MESSAGE_KEY] = k;
            if (e) st.msgs.set(k, e);
            stats.rekeyed++;
            continue;
          }
          // parent-gone: deleted elsewhere (the deletion wins), or never written (write it once).
          const header = await R.get(STORE_KEY, headerKey(id), { fresh: true });
          if (header.deleted) throw Object.assign(new Error('conversation deleted'), { code: 'CONVERSATION_DELETED' });
          if (attempt > 0) break;
          metaDirty.set(id, 'all');
          await applyOp({ t: 'header', id });
        }
        throw new Error(`durable turn commit failed for ${id}`);
      } catch (err) {
        undo();
        if (err?.code === 'CONVERSATION_DELETED' || err?.code === 'OWNER_DELETED') {
          // The deletion wins: forget the conversation here and its queued writes.
          for (let i = ops.length - 1; i >= 0; i--) if (ops[i].id === id && ops[i].t !== 'delConv') ops.splice(i, 1);
          removeLocal(id);
        }
        stats.durableTurnFailures = (stats.durableTurnFailures ?? 0) + 1;
        lastError = errorText(err);
        throw err;
      }
    },

    keyOf,
    flush,
    /**
     * Phase 4A — apply ONLY the ops of these keys (a request's conversations),
     * in their queue order, now. Ops of other conversations stay queued. On a
     * failure the failed op and the rest of these keys' ops go back to the
     * FRONT of the queue (their order kept) and pendingAmong() reports them.
     */
    async flushOnly(keys) {
      while (running) await running;
      const want = new Set([...keys].map(String));
      const mine = [];
      for (let i = 0; i < ops.length; i++) if (want.has(opKey(ops[i]))) { mine.push(ops[i]); ops.splice(i, 1); i--; }
      if (!mine.length) {
        for (const k of want) { const err = discarded.get(k); if (err) { discarded.delete(k); throw err; } }
        return;
      }
      running = (async () => {
        const touched = new Set();
        for (let i = 0; i < mine.length; i++) {
          const lost = mine[i].origin?.lost;
          if (lost) { discarded.set(opKey(mine[i]), lost); stats.fenceDiscards = (stats.fenceDiscards ?? 0) + 1; continue; }
          try { await applyWithOrigin(mine[i]); if (mine[i].id) touched.add(mine[i].id); }
          catch (err) {
            if (isWriteRefused(err)) {
              discarded.set(opKey(mine[i]), err); stats.fenceDiscards = (stats.fenceDiscards ?? 0) + 1;
              continue;
            }
            if (err instanceof PartitionOwnershipError) {
              stats.ownershipDropped = (stats.ownershipDropped ?? 0) + 1;
              lastError = errorText(err);
              console.error(`[STORE] history: dropped a write to a row of another owner (${mine[i].t} ${mine[i].id ?? ''}): ${lastError}`);
              if (mine[i].id && authoritative()) removeLocal(mine[i].id);
              continue;
            }
            stats.failures++; lastError = errorText(err);
            ops.unshift(...mine.slice(i));
            schedule(Math.max(500, retryDelay));
            break;
          }
        }
        await backupFlush(touched);
      })();
      try { await running; } finally { running = null; }
      // Explicit failure for a caller whose writes were discarded (fence lost).
      for (const k of want) {
        const err = discarded.get(k);
        if (err) { discarded.delete(k); throw err; }
      }
    },
    /** Op keys of this owner still queued (connect lease release: flushOwnerStrict). */
    pendingKeysOfOwner: owner => [...new Set(ops.filter(o => o.owner === String(owner)).map(opKey))],
    pendingAmong: keys => { const want = new Set([...keys].map(String)); return ops.filter(o => want.has(opKey(o))).length; },
    pendingCount: () => ops.length,
    async configure() {
      if (!authoritative()) return;
      try {
        if (await repo().hasAny(STORE_KEY)) return;
        let hasJson = false;
        try { hasJson = fs.existsSync(file) && fs.statSync(file).size > 0; } catch { hasJson = false; }
        if (hasJson) {
          reason = `refused ${mode}: no partition rows for ${STORE_KEY} but its JSON file has data — migrate it first`;
          mode = 'off';
          reloadJson?.();
        }
      } catch (err) {
        reason = `partitions unreachable at boot: ${errorText(err)}`;
        console.error(`[STORE] history: ${reason}`);
      }
    },
    status() {
      return { store: STORE_KEY, mode, reason, loadedOwners: loadedOwners.size, conversations: state.size, pending: ops.length, lastError, ...stats };
    },
    _reset() {
      state.clear(); ownerConvs.clear(); loadedOwners.clear(); ops.length = 0; metaDirty.clear(); deletingConvs.clear();
      backupPending.clear(); if (timer) clearTimeout(timer); timer = null; lastError = null;
      for (const k of Object.keys(stats)) stats[k] = 0;
    },
  };
  return registerPartitionBinding(binding);
}
