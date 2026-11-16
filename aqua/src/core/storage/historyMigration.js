/**
 * AQUA — conversation-history migration audit (scalability Phase 4A)
 *
 * Everything an operator needs BEFORE moving production conversation history
 * onto per-user Postgres partitions (history `on`), and to prove afterwards
 * that nothing was lost. Pure functions over TEXT the operator supplies: this
 * module never connects to production. The partition writes themselves stay
 * in partitionMigration.js (dry-run / apply / reconcile / export).
 *
 * WHERE PRODUCTION HISTORY LIVES (all must be inventoried):
 *   1. AQUA_DATA_DIR/.aqua-history.json         the live file (+ .bak boot backup)
 *   2. Mongo `aqua_kv` _id ".aqua-history.json"  the durable mirror (chunked:
 *                                                 manifest + "<id>::part<gen>:<i>" docs)
 *   3. Mongo `aqua_kv` "conflict/.aqua-history.json/…"  preserved generations and
 *                                                 LOCAL RECOVERY copies — writes made
 *                                                 while the mirror was unreachable,
 *                                                 possibly found nowhere else
 *   4. .aqua-history-trash.json                   deleted conversations (recovery snapshots)
 *   5. pg-blob (AQUA_STORE_PG)                    only if the blob shadow was ever on
 *
 * WHAT IT REPORTS (never message content — ids, counts, hashes):
 *   counts by owner and by storage type · conversations without a user
 *   ("conv:" owners) · user ids not among the known accounts · accounts
 *   already deleted · duplicate message keys · repeated identical messages ·
 *   malformed records · conversations that differ between sources
 */
import crypto from 'node:crypto';

const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const NEW_KEY = /^[0-9a-z-]+$/;

/** A store file's text (envelope or bare map) → { data: Map(id → conv), envelope }. */
export function parseHistoryText(text) {
  const doc = JSON.parse(text);
  const envelope = Boolean(doc && typeof doc === 'object' && doc.__aqua && 'data' in doc);
  const data = (envelope ? doc.data : doc) ?? {};
  return { envelope, data: new Map(Object.entries(data)) };
}

/**
 * Reassemble Mongo `aqua_kv` docs (an export: array or JSON lines) into store
 * texts. Returns { live: text|null, conflicts: [{ id, text }], problems: [] }.
 * A torn chunk set (missing parts) is reported, never guessed.
 */
export function readMirrorExport(exportText, filename = '.aqua-history.json') {
  const docs = exportText.trim().startsWith('[')
    ? JSON.parse(exportText)
    : exportText.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const idOf = d => (typeof d._id === 'object' && d._id !== null ? d._id.$oid ?? String(d._id) : String(d._id));
  const parts = new Map();
  for (const d of docs) if (d.part) { const k = `${d.of}:${d.gen}`; if (!parts.has(k)) parts.set(k, []); parts.get(k).push(d); }
  const problems = [];
  const textOf = d => {
    if (!d.chunked) return typeof d.json === 'string' ? d.json : null;
    const set = (parts.get(`${idOf(d)}:${d.gen}`) ?? []).sort((a, b) => a.i - b.i);
    if (set.length !== d.parts || set.some((p, i) => p.i !== i || typeof p.json !== 'string')) {
      problems.push({ id: idOf(d), problem: 'torn-chunk-set', have: set.length, want: d.parts });
      return null;
    }
    return set.map(p => p.json).join('');
  };
  let live = null;
  const conflicts = [];
  for (const d of docs) {
    if (d.part) continue;
    const id = idOf(d);
    if (id === filename) live = textOf(d);
    else if (id.startsWith(`conflict/${filename}/`)) { const t = textOf(d); if (t != null) conflicts.push({ id, localRecovery: !!d.localRecovery, text: t }); }
  }
  return { live, conflicts, problems };
}

const ownerOf = (id, conv) => (conv && !Array.isArray(conv) && conv.meta?.userId != null && String(conv.meta.userId) !== ''
  ? `user:${conv.meta.userId}` : `conv:${id}`);
const messagesOf = conv => (Array.isArray(conv) ? conv : (Array.isArray(conv?.messages) ? conv.messages : null));

/**
 * Inventory one history source. `knownUserIds` (Set of Mongo user ids, as
 * strings) and `deletedOwners` (Set of "user:<id>") are optional.
 */
export function inventoryHistory(text, { label = 'source', knownUserIds = null, deletedOwners = null } = {}) {
  const { data, envelope } = parseHistoryText(text);
  const owners = new Map();      // owner → { conversations, messages, bytes }
  const r = {
    label, envelope, conversations: data.size, messages: 0, bytes: Buffer.byteLength(text, 'utf8'),
    storage: { conversationObjects: 0, legacyArrayConversations: 0, messagesWithStableKey: 0, messagesPositional: 0 },
    owners: { users: 0, anonymous: 0 },
    missingOwner: { anonymousConversations: 0, anonymousMessages: 0, unknownUserIds: 0, unknownUserConversations: 0, sampleUnknown: [] },
    deletedAccounts: { owners: 0, conversations: 0 },
    duplicates: { duplicateMessageKeys: 0, conversationsWithDuplicateKeys: 0, repeatedIdenticalMessages: 0 },
    malformed: { conversations: 0, messages: 0, sample: [] },
    byOwner: [],
  };
  const unknownUsers = new Set();
  const deletedSeen = new Set();
  for (const [id, conv] of data) {
    const msgs = messagesOf(conv);
    if (msgs == null || (conv && typeof conv !== 'object')) {
      r.malformed.conversations++;
      if (r.malformed.sample.length < 20) r.malformed.sample.push({ conversation: id, problem: 'no message list' });
      continue;
    }
    if (Array.isArray(conv)) r.storage.legacyArrayConversations++; else r.storage.conversationObjects++;
    const owner = ownerOf(id, conv);
    const o = owners.get(owner) ?? { conversations: 0, messages: 0, bytes: 0 };
    o.conversations++; o.messages += msgs.length; o.bytes += Buffer.byteLength(JSON.stringify(conv), 'utf8');
    owners.set(owner, o);
    r.messages += msgs.length;
    if (owner.startsWith('conv:')) { r.missingOwner.anonymousConversations++; r.missingOwner.anonymousMessages += msgs.length; }
    else if (knownUserIds && !knownUserIds.has(owner.slice(5))) { unknownUsers.add(owner); r.missingOwner.unknownUserConversations++; }
    if (deletedOwners?.has(owner)) { deletedSeen.add(owner); r.deletedAccounts.conversations++; }
    const keys = new Map();
    let prev = null;
    let dupInConv = 0;
    msgs.forEach((m, i) => {
      if (!m || typeof m !== 'object' || typeof m.role !== 'string' || typeof m.content !== 'string') {
        r.malformed.messages++;
        if (r.malformed.sample.length < 20) r.malformed.sample.push({ conversation: id, index: i, problem: 'message without role/content' });
      }
      const k = typeof m?.mid === 'string' && NEW_KEY.test(m.mid) ? m.mid : null;
      if (k) { r.storage.messagesWithStableKey++; keys.set(k, (keys.get(k) ?? 0) + 1); } else r.storage.messagesPositional++;
      if (prev && m && prev.role === m.role && prev.content === m.content && prev.ts === m.ts) r.duplicates.repeatedIdenticalMessages++;
      prev = m;
    });
    for (const n of keys.values()) if (n > 1) dupInConv += n - 1;
    if (dupInConv) { r.duplicates.duplicateMessageKeys += dupInConv; r.duplicates.conversationsWithDuplicateKeys++; }
  }
  r.owners.users = [...owners.keys()].filter(o => o.startsWith('user:')).length;
  r.owners.anonymous = [...owners.keys()].filter(o => o.startsWith('conv:')).length;
  r.missingOwner.unknownUserIds = unknownUsers.size;
  r.missingOwner.sampleUnknown = [...unknownUsers].slice(0, 20).map(o => sha(o));   // hashed, not ids
  r.deletedAccounts.owners = deletedSeen.size;
  r.byOwner = [...owners].map(([owner, v]) => ({ owner: sha(owner), kind: owner.startsWith('user:') ? 'user' : 'anonymous', ...v }))
    .sort((a, b) => b.messages - a.messages);
  return r;
}

/**
 * Compare several sources of the same store (file, mirror, conflict copies).
 * Per conversation: present where, and whether the versions agree. Nothing is
 * resolved automatically; `union` proposes the version with the most messages
 * (then the newest updatedAt) and lists every decision for the operator.
 */
export function compareHistorySources(sources) {
  const parsed = sources.map(s => ({ label: s.label, data: parseHistoryText(s.text).data }));
  const ids = new Set(parsed.flatMap(p => [...p.data.keys()]));
  const out = { conversations: ids.size, inAll: 0, onlyIn: {}, differing: 0, decisions: [] };
  for (const p of parsed) out.onlyIn[p.label] = 0;
  const union = {};
  for (const id of ids) {
    const have = parsed.filter(p => p.data.has(id));
    if (have.length === parsed.length) out.inAll++;
    if (have.length === 1) out.onlyIn[have[0].label]++;
    const versions = have.map(p => ({ label: p.label, conv: p.data.get(id), hash: sha(JSON.stringify(p.data.get(id))) }));
    const distinct = new Set(versions.map(v => v.hash));
    const pick = [...versions].sort((a, b) =>
      (messagesOf(b.conv)?.length ?? 0) - (messagesOf(a.conv)?.length ?? 0)
      || (b.conv?.meta?.updatedAt ?? 0) - (a.conv?.meta?.updatedAt ?? 0))[0];
    union[id] = pick.conv;
    if (distinct.size > 1) {
      out.differing++;
      if (out.decisions.length < 200) {
        out.decisions.push({ conversation: sha(id), chosen: pick.label,
          versions: versions.map(v => ({ label: v.label, messages: messagesOf(v.conv)?.length ?? null, hash: v.hash })) });
      }
    }
  }
  out.unionText = JSON.stringify({ __aqua: { schema: 1, savedAt: Date.now(), mergedFrom: parsed.map(p => p.label) }, data: union });
  return out;
}

/**
 * After an apply: every conversation of the source, reassembled from the
 * partitions (reassembled store text from exportStore), is identical —
 * header fields and the ordered message list. Returns counts and hashed ids.
 */
export function verifyHistoryPreserved(sourceText, partitionsText, { excludeOwners = null } = {}) {
  const src = parseHistoryText(sourceText).data;
  const dst = partitionsText ? parseHistoryText(partitionsText).data : new Map();
  const r = { conversations: 0, preserved: 0, missing: 0, changed: 0, messageCountDiffers: 0, excluded: 0,
    messages: { source: 0, partitions: 0 }, sample: [] };
  for (const [id, conv] of src) {
    if (excludeOwners?.has(ownerOf(id, conv))) { r.excluded++; continue; }
    r.conversations++;
    r.messages.source += messagesOf(conv)?.length ?? 0;
    const got = dst.get(id);
    if (!got) { r.missing++; if (r.sample.length < 20) r.sample.push({ conversation: sha(id), problem: 'missing' }); continue; }
    r.messages.partitions += messagesOf(got)?.length ?? 0;
    if (JSON.stringify(got) === JSON.stringify(conv)) { r.preserved++; continue; }
    r.changed++;
    if ((messagesOf(got)?.length ?? -1) !== (messagesOf(conv)?.length ?? -2)) r.messageCountDiffers++;
    if (r.sample.length < 20) r.sample.push({ conversation: sha(id), problem: 'changed',
      sourceMessages: messagesOf(conv)?.length ?? null, partitionMessages: messagesOf(got)?.length ?? null });
  }
  r.clean = r.missing === 0 && r.changed === 0;
  return r;
}
