/**
 * AQUA — what the user told Aqua to forget, in the form verbatim recall needs
 * (2026-10-20).
 *
 * Episodic recall (memory/episodicRecall.js) quotes the user's own past
 * messages. Those messages stay in the conversation store after a forget — the
 * user can still scroll back through a chat — so a forget that only archived
 * claims would come straight back through a quote of the sentence that stated
 * it. Every user-initiated forget and correction (memory/forget.js) therefore
 * also records here which phrases recall must never quote again.
 *
 * PRIVACY: the store keeps SALTED HASHES of normalised phrases, never the
 * phrases. A list of "things this person asked to forget" is the most
 * sensitive file Aqua could keep in plain text. Matching hashes every word
 * n-gram of a CANDIDATE sentence (only the few recall is about to quote), so
 * the cost is bounded by the excerpts, not by the history.
 *
 * Durability: a forget is rare and must hold across a crash, so every change is
 * flushed synchronously (temp-then-rename) and mirrored like every other store.
 */
import crypto from 'node:crypto';
import { createDebouncedWriter, loadJsonFile, wrapStore, unwrapStore } from '../core/atomicStore.js';
import { dataPath } from '../core/dataDir.js';
import { bindOwnerStore } from '../core/storage/ownerBinding.js';

const FILE = dataPath('.aqua-recall-redactions.json');
const SCHEMA = 1;
const MAX_PHRASE_WORDS = 40;
const MAX_PHRASES_PER_OWNER = 20_000;

/** Single words too common to redact on: forgetting a garbage value "And" must not erase every sentence. */
const TOO_COMMON = new Set(('a an the and or but if of in on at to for with from by is are was were be been '
  + 'am i me my we our us you your it its this that he she his her they them their not no yes so as do '
  + 'did does have has had will would can could should may might must just now then than there here').split(' '));

/** Map<ownerId, { forgetAllAt: number|null, phrases: Map<hash, { n, at }>, rev: number }> — rev is in-memory only. */
// PROCESS-WIDE revision (2026-11-06): every change to any owner's list takes the
// next value, so a stamp is never reused — not even by an owner whose record was
// purged and recreated (a per-record counter restarted at 0 and could repeat).
let REVISION = 0;
const store = new Map();
const writer = createDebouncedWriter(FILE);

const decodeRecord = rec => ({
  forgetAllAt: Number.isFinite(rec?.forgetAllAt) ? rec.forgetAllAt : null,
  phrases: new Map(Object.entries(rec?.phrases ?? {})),
  rev: ++REVISION,
});
const encodeRecord = rec => ({ forgetAllAt: rec.forgetAllAt, phrases: Object.fromEntries(rec.phrases) });

function load() {
  const parsed = loadJsonFile(FILE, { label: 'recall-redactions' });
  if (parsed == null) return;
  const { data } = unwrapStore(parsed, { expected: SCHEMA, file: FILE, label: 'recall-redactions' });
  if (!data || typeof data !== 'object') return;
  for (const [owner, rec] of Object.entries(data)) {
    const d = decodeRecord(rec);
    d.rev = 0;
    store.set(owner, d);
  }
}

// ── Per-owner persistence (scalability Phase 2b, step 2) ─────────────────────
// WRITERS: the Memory UI's forget/correct (server) and memory propagation.
// MERGE: grow-only. Phrases are UNIONED (a redaction is never lost to a race),
// forgetAllAt takes the LATER time. Both are order-independent, so any number
// of processes converge on the same list.
// DELETION: purgeOwner (account deletion) → tombstone; redactions made after it
// (a returning user) start a new record.
// FAIL CLOSED: with partitions authoritative, an owner whose list is not loaded
// gets a matcher that redacts EVERYTHING — recall quotes nothing rather than
// risk quoting what the person asked to forget.
export function mergeRedactionRecords(ours, theirs) {
  const phrases = { ...(theirs.phrases ?? {}) };
  for (const [h, v] of Object.entries(ours.phrases ?? {})) {
    const t = phrases[h];
    phrases[h] = t ? { n: v.n, at: Math.min(Number(v.at) || 0, Number(t.at) || 0) } : v;
  }
  const times = [ours.forgetAllAt, theirs.forgetAllAt].filter(Number.isFinite);
  return { forgetAllAt: times.length ? Math.max(...times) : null, phrases };
}
const redactionChangedAt = rec => Math.max(Number(rec?.forgetAllAt) || 0,
  ...Object.values(rec?.phrases ?? {}).map(v => Number(v?.at) || 0), 0);

const binding = bindOwnerStore({
  storeKey: '.aqua-recall-redactions.json',
  file: FILE,
  label: 'recall-redactions',
  schema: SCHEMA,
  encode: owner => { const rec = store.get(owner); return rec ? encodeRecord(rec) : undefined; },
  decode: decodeRecord,
  install: (owner, rec) => { if (rec) store.set(owner, rec); else store.delete(owner); },
  merge: mergeRedactionRecords,
  changedAt: redactionChangedAt,
  // After an account purge at `at`, only redactions made at or after it survive.
  pruneBefore: (rec, at) => {
    for (const [h, v] of Object.entries(rec.phrases ?? {})) if ((Number(v?.at) || 0) < at) delete rec.phrases[h];
    if (!((Number(rec.forgetAllAt) || 0) >= at)) rec.forgetAllAt = null;
    return Object.keys(rec.phrases ?? {}).length || rec.forgetAllAt != null ? rec : null;
  },
  evict: owner => store.delete(owner),
  reloadJson: () => load(),
});
export function redactionsPartitionBinding() { return binding; }

if (binding.loadsJsonAtBoot()) load();

function persist(ownerId = null) {
  if (ownerId) binding.markDirty(ownerId);
  if (!binding.writesWholeJson()) {
    // A forget must survive a crash: start the partition write now, not after the debounce.
    binding.flush().catch(() => {});
    return;
  }
  writer.schedule(() => {
    const data = {};
    for (const [owner, rec] of store) {
      data[owner] = { forgetAllAt: rec.forgetAllAt, phrases: Object.fromEntries(rec.phrases) };
    }
    return JSON.stringify(wrapStore(SCHEMA, data));
  });
  writer.flush();   // a forget must survive a crash one millisecond later
}

/** "Lisbon," / "LISBON" / "lisbon" → one comparable word list. */
export function words(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
}

function hashPhrase(ownerId, ws) {
  return crypto.createHash('sha256').update(`${ownerId}\u0000${ws.join(' ')}`).digest('hex').slice(0, 32);
}

function recordFor(ownerId) {
  let rec = store.get(ownerId);
  if (!rec) { rec = { forgetAllAt: null, phrases: new Map(), rev: 0 }; store.set(ownerId, rec); }
  return rec;
}

/** Is this phrase specific enough to redact on? */
function redactable(ws) {
  if (!ws.length || ws.length > MAX_PHRASE_WORDS) return false;
  // A number is specific even when short: a corrected "$29" must stop being quoted.
  if (ws.length === 1) return (ws[0].length >= 3 && !TOO_COMMON.has(ws[0])) || (ws[0].length >= 2 && /\p{N}/u.test(ws[0]));
  return ws.some(w => !TOO_COMMON.has(w));
}

/**
 * Recall must never again quote a sentence containing any of `phrases` (values,
 * names, or the forgotten sentence itself). Returns how many were added.
 */
export function redactPhrases(ownerId, phrases, { at = Date.now() } = {}) {
  if (!ownerId) return 0;
  const rec = recordFor(ownerId);
  let added = 0;
  for (const p of (Array.isArray(phrases) ? phrases : [phrases])) {
    const ws = words(p);
    if (!redactable(ws)) continue;
    const h = hashPhrase(ownerId, ws);
    if (!rec.phrases.has(h)) { rec.phrases.set(h, { n: ws.length, at }); added++; }
  }
  while (rec.phrases.size > MAX_PHRASES_PER_OWNER) rec.phrases.delete(rec.phrases.keys().next().value);
  if (added) { rec.rev = ++REVISION; persist(ownerId); }
  return added;
}

/** "Forget everything I told you": nothing said before `at` may be quoted again. */
export function redactAllBefore(ownerId, at = Date.now()) {
  if (!ownerId) return;
  const rec = recordFor(ownerId);
  rec.forgetAllAt = Math.max(rec.forgetAllAt ?? 0, at);
  rec.rev = ++REVISION;
  persist(ownerId);
}

/**
 * The matcher recall applies to each sentence it is about to quote.
 * `isRedacted(sentence, ts)` — true when the sentence predates a forget-all or
 * contains a redacted phrase as whole words.
 */
export function redactionsFor(ownerId) {
  if (ownerId && !binding.ready(ownerId)) {
    // Not loaded (partitions authoritative): fail CLOSED. See the header.
    return { active: true, stamp: `${ownerId}#not-loaded`, isRedacted: () => true };
  }
  const rec = ownerId ? store.get(ownerId) : null;
  if (!rec || (!rec.phrases.size && rec.forgetAllAt == null)) {
    return { active: false, isRedacted: () => false };
  }
  const lengths = [...new Set([...rec.phrases.values()].map(v => v.n))].sort((a, b) => a - b);
  return {
    active: true,
    // Changes whenever this owner's forget list does (in-memory, per process): lets
    // recall cache text it has already cleaned (episodicRecall.js forgetClean).
    stamp: `${ownerId}#${rec.rev ?? 0}`,
    isRedacted(sentence, ts = null) {
      if (rec.forgetAllAt != null && Number.isFinite(ts) && ts <= rec.forgetAllAt) return true;
      if (!rec.phrases.size) return false;
      const ws = words(sentence);
      for (const n of lengths) {
        if (n > ws.length) break;
        for (let i = 0; i + n <= ws.length; i++) {
          if (rec.phrases.has(hashPhrase(ownerId, ws.slice(i, i + n)))) return true;
        }
      }
      return false;
    },
  };
}

/** Account deletion: nothing about this owner survives. Returns the phrase count removed. */
export function purgeOwner(ownerId) {
  binding.markDeleted(ownerId);   // tombstone even if this process never loaded it
  const rec = store.get(ownerId);
  if (!rec) { if (!binding.writesWholeJson()) binding.flush().catch(() => {}); return 0; }
  store.delete(ownerId);
  persist();
  return rec.phrases.size;
}

/** Tests only. */
export function __resetForTests() {
  writer.cancel();
  store.clear();
  binding._reset();
}
