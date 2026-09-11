/**
 * AQUA Memory Editor — Memory 5.1 (spec: Memory Editing)
 * ─────────────────────────────────────────────────────────────────────────────
 * The explicit-edit surface over the EXISTING fact layer. Nothing here is a
 * new store or a new write path: correction/replacement ride storeResolved()
 * (the same conflict-resolved path chat observation uses), and the operations
 * that layer above it (merge, split, pin, archive) mutate mind.facts directly
 * — same layer as longTermMemory — while snapshotting the pre-edit state
 * through buildRevisionHistory(), so the "never silently overwrite" contract
 * holds for every operation:
 *
 *   correctFact    user says "that's wrong, it's X"  → CORRECTION (pins)
 *   replaceFact    programmatic overwrite            → OVERWRITE (damped conf)
 *   mergeFacts     N facts → 1 survivor; losers archived w/ supersededBy
 *   splitFact      1 fact  → N parts;   source archived w/ splitInto
 *   pinFact        exempt from archive, importance floor (Phase A semantics)
 *   archiveFact    manual cold-storage (refused for pinned unless force)
 *   restoreFact    archived → active
 *
 * Every mutation also bridges a compact `memory`-kind revision into the PIC
 * version store (subject `memfact:<key>`) — the revision kind Phase 4
 * reserved for the memory layer but nothing wrote until now. Fire-and-forget,
 * gated on AQUA_PIC, fail-open: editing can never be sunk by bookkeeping.
 *
 * Archive semantics mirror consolidationEngine: archived ≠ deleted. Losers
 * and split sources stay on disk with full history, excluded from prompts and
 * default reads, reactivatable by restoreFact() or re-mention.
 */
import { getMind, peekMind, touchMind } from '../mind/mindStore.js';
import {
  getFact, getFacts, getFactHistory, storeResolved, deleteFact,
  buildRevisionHistory,
} from './longTermMemory.js';
import { RESOLUTION_ACTIONS } from './memoryResolver.js';
import { resolveCanonicalKey } from './memoryExtractor.js';

const CONF_CEIL = 0.98;          // matches consolidationEngine's ceiling
const MIN_STORE_CONF = 0.5;      // longTermMemory MIN_CONF — below is rejected

// ── PIC bridge: memory-kind revisions (fire-forget, gated, fail-open) ────────
function picEnabled() {
  return String(process.env.AQUA_PIC ?? 'on').toLowerCase() !== 'off';
}

function recordMemoryRevision(ownerId, key, { before = null, after = null, reason = null, actor = 'user' } = {}) {
  if (!picEnabled()) return;
  import('../pic/versionStore.js')
    .then(m => m.recordRevision(ownerId, `memfact:${key}`, { kind: 'memory', before, after, reason, actor }))
    .catch(() => { /* bookkeeping never sinks an edit */ });
}

function fail(error) { return { ok: false, error }; }

function factView(f) {
  if (!f) return null;
  const { history, ...rest } = f;
  return { ...rest, revisions: Array.isArray(history) ? history.length : 0 };
}

// ── Correction / replacement (ride the ONE conflict-resolved write path) ─────

/**
 * Explicit user correction: "no, my X is Y". Pins the fact (archive-exempt),
 * full confidence — the user said so. History via storeResolved's CORRECTION
 * branch, exactly as if detectMemoryUpdate had caught it in chat.
 */
export function correctFact(ownerId, key, value, { reason = 'user_correction', sourceText = '', importance = null } = {}) {
  if (!ownerId || !key || value === undefined || value === null || value === '') {
    return fail('ownerId, key and value are required');
  }
  try {
    const canonical = resolveCanonicalKey(String(key));
    const existing = getFact(ownerId, canonical);
    storeResolved(ownerId, {
      key: canonical, value, normalizedValue: value,
      confidence: 0.95,
      importance: importance ?? existing?.importance ?? 8,
      category: existing?.category ?? null,
      sourceText: sourceText || `edited:${reason}`,
      ts: Date.now(),
      action: RESOLUTION_ACTIONS.CORRECTION, reason,
    });
    const after = getFact(ownerId, canonical);
    recordMemoryRevision(ownerId, canonical, { before: existing?.value ?? null, after: after?.value ?? value, reason });
    console.log(`[MEMEDIT] CORRECT owner=${ownerId} key=${canonical}`);
    return { ok: true, key: canonical, fact: factView(after) };
  } catch (err) {
    console.warn('[MEMEDIT] correctFact failed (non-fatal):', err.message);
    return fail(err.message);
  }
}

/**
 * Programmatic replacement. OVERWRITE semantics — contradiction-damped
 * confidence against an established value (the store's rule, not bypassed),
 * no pin. Use correctFact for user-asserted truth.
 */
export function replaceFact(ownerId, key, value, { reason = 'replace', confidence = 0.9, sourceText = '' } = {}) {
  if (!ownerId || !key || value === undefined || value === null || value === '') {
    return fail('ownerId, key and value are required');
  }
  try {
    const canonical = resolveCanonicalKey(String(key));
    const existing = getFact(ownerId, canonical);
    storeResolved(ownerId, {
      key: canonical, value, normalizedValue: value,
      confidence: Math.max(MIN_STORE_CONF, Math.min(1, confidence)),
      importance: existing?.importance ?? 6,
      category: existing?.category ?? null,
      sourceText: sourceText || `edited:${reason}`,
      ts: Date.now(),
      action: RESOLUTION_ACTIONS.OVERWRITE, reason,
    });
    const after = getFact(ownerId, canonical);
    recordMemoryRevision(ownerId, canonical, { before: existing?.value ?? null, after: after?.value ?? value, reason });
    console.log(`[MEMEDIT] REPLACE owner=${ownerId} key=${canonical}`);
    return { ok: true, key: canonical, fact: factView(after) };
  } catch (err) {
    console.warn('[MEMEDIT] replaceFact failed (non-fatal):', err.message);
    return fail(err.message);
  }
}

// ── Pin / archive lifecycle (direct, snapshotted) ────────────────────────────

export function pinFact(ownerId, key, pinned = true) {
  try {
    const mind = getMind(ownerId);
    const fact = mind?.facts?.[key];
    if (!fact) return fail(`Fact '${key}' not found`);
    if (!!fact.pinned === !!pinned) return { ok: true, key, fact: factView(fact), unchanged: true };
    fact.pinned = !!pinned;
    fact.updatedAt = Date.now();
    touchMind(mind);
    recordMemoryRevision(ownerId, key, { before: !pinned, after: !!pinned, reason: pinned ? 'pinned' : 'unpinned' });
    console.log(`[MEMEDIT] ${pinned ? 'PIN' : 'UNPIN'} owner=${ownerId} key=${key}`);
    return { ok: true, key, fact: factView(fact) };
  } catch (err) {
    return fail(err.message);
  }
}

export function archiveFact(ownerId, key, { reason = 'manual_archive', force = false } = {}) {
  try {
    const mind = getMind(ownerId);
    const fact = mind?.facts?.[key];
    if (!fact) return fail(`Fact '${key}' not found`);
    if (fact.status === 'archived') return { ok: true, key, fact: factView(fact), unchanged: true };
    if (fact.pinned && !force) return fail(`Fact '${key}' is pinned (archive-exempt); pass force to override`);
    fact.history = buildRevisionHistory(fact, reason);
    fact.status = 'archived';
    fact.archivedAt = Date.now();
    fact.updatedAt = Date.now();
    touchMind(mind);
    recordMemoryRevision(ownerId, key, { before: 'active', after: 'archived', reason });
    console.log(`[MEMEDIT] ARCHIVE owner=${ownerId} key=${key}`);
    return { ok: true, key, fact: factView(fact) };
  } catch (err) {
    return fail(err.message);
  }
}

export function restoreFact(ownerId, key, { reason = 'manual_restore' } = {}) {
  try {
    const mind = getMind(ownerId);
    const fact = mind?.facts?.[key];
    if (!fact) return fail(`Fact '${key}' not found`);
    if (fact.status !== 'archived') return { ok: true, key, fact: factView(fact), unchanged: true };
    fact.status = 'active';
    delete fact.archivedAt;
    fact.updatedAt = Date.now();
    touchMind(mind);
    recordMemoryRevision(ownerId, key, { before: 'archived', after: 'active', reason });
    console.log(`[MEMEDIT] RESTORE owner=${ownerId} key=${key}`);
    return { ok: true, key, fact: factView(fact) };
  } catch (err) {
    return fail(err.message);
  }
}

// ── Merge: N facts → one survivor (consolidationEngine semantics) ────────────

/**
 * Merge duplicate/overlapping facts. Survivor = intoKey if given, else
 * highest confidence, then newest. Support counts union onto the survivor;
 * every loser is archived with supersededBy — historical knowledge is
 * archived, never destroyed (Phase-4 rule, applied to the memory layer).
 */
export function mergeFacts(ownerId, keys = [], { intoKey = null, reason = 'manual_merge' } = {}) {
  if (!ownerId || !Array.isArray(keys) || keys.length < 2) {
    return fail('ownerId and at least two keys are required');
  }
  try {
    const mind = getMind(ownerId);
    if (!mind?.facts) return fail('No memory for owner');
    const found = [...new Set(keys)].map(k => mind.facts[k]).filter(Boolean);
    if (found.length < 2) return fail('Fewer than two of the given keys exist');

    let survivor = intoKey ? mind.facts[intoKey] : null;
    if (intoKey && !survivor) return fail(`intoKey '${intoKey}' not found`);
    if (!survivor) {
      survivor = [...found].sort((a, b) =>
        (b.confidence || 0) - (a.confidence || 0) || (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    }
    const losers = found.filter(f => f.key !== survivor.key);
    if (!losers.length) return fail('Nothing to merge into the survivor');

    const now = Date.now();
    const absorbedKeys = losers.map(l => l.key);

    // Snapshot the survivor BEFORE mutation — the merge is a visible event
    // in its trail even though its value is unchanged.
    survivor.history = buildRevisionHistory(survivor, `merge_absorbed:${absorbedKeys.join(',')}`);
    survivor.supportCount = (survivor.supportCount || 1) +
      losers.reduce((s, l) => s + (l.supportCount || 1), 0);
    survivor.confidence = Math.min(CONF_CEIL,
      Math.max(survivor.confidence || 0.5, ...losers.map(l => l.confidence || 0.5)));
    survivor.importance = Math.max(survivor.importance || 5, ...losers.map(l => l.importance || 5));
    survivor.pinned = !!survivor.pinned || losers.some(l => l.pinned);
    survivor.mergedFrom = [...new Set([...(survivor.mergedFrom || []), ...absorbedKeys])];
    survivor.revision = (survivor.revision || 1) + 1;
    survivor.updatedAt = now;

    for (const loser of losers) {
      loser.history = buildRevisionHistory(loser, `merged_into:${survivor.key}`);
      loser.status = 'archived';
      loser.supersededBy = survivor.key;
      loser.archivedAt = now;
      loser.updatedAt = now;
      recordMemoryRevision(ownerId, loser.key, { before: 'active', after: `merged_into:${survivor.key}`, reason });
    }
    touchMind(mind);
    recordMemoryRevision(ownerId, survivor.key, {
      before: { absorbed: absorbedKeys }, after: { supportCount: survivor.supportCount }, reason,
    });
    console.log(`[MEMEDIT] MERGE owner=${ownerId} survivor=${survivor.key} absorbed=${absorbedKeys.join(',')}`);
    return { ok: true, survivor: factView(survivor), archived: absorbedKeys };
  } catch (err) {
    console.warn('[MEMEDIT] mergeFacts failed (non-fatal):', err.message);
    return fail(err.message);
  }
}

// ── Split: one fact → N parts ────────────────────────────────────────────────

/**
 * Split a compound fact ("stack: node and react") into parts. Parts inherit
 * the source's provenance (+ metadata.splitFrom); the source is archived
 * with splitInto — reversible, auditable, never destroyed. A part whose key
 * already exists goes through OVERWRITE (history preserved), never a raw set.
 */
export function splitFact(ownerId, key, parts = [], { reason = 'manual_split' } = {}) {
  if (!ownerId || !key || !Array.isArray(parts) || parts.length < 2) {
    return fail('ownerId, key and at least two parts are required');
  }
  try {
    const mind = getMind(ownerId);
    const source = mind?.facts?.[key];
    if (!source) return fail(`Fact '${key}' not found`);

    const prepared = [];
    const seen = new Set([key]);
    for (const p of parts) {
      if (!p || !p.key || p.value === undefined || p.value === null || p.value === '') {
        return fail('Every part needs a key and a value');
      }
      const canonical = resolveCanonicalKey(String(p.key));
      if (seen.has(canonical)) return fail(`Duplicate or source-colliding part key '${canonical}'`);
      seen.add(canonical);
      prepared.push({ ...p, key: canonical });
    }

    const now = Date.now();
    for (const p of prepared) {
      const exists = !!mind.facts[p.key];
      storeResolved(ownerId, {
        key: p.key, value: p.value, normalizedValue: p.value,
        confidence: Math.max(MIN_STORE_CONF, source.confidence || 0.5),
        importance: p.importance ?? source.importance ?? 5,
        category: p.category ?? source.category ?? null,
        sourceText: source.sourceText || source.sourceMessage || '',
        sourceConversation: source.sourceConversation || null,
        metadata: { ...(source.metadata || {}), splitFrom: key },
        ts: now,
        action: exists ? RESOLUTION_ACTIONS.OVERWRITE : RESOLUTION_ACTIONS.STORE_NEW,
        reason: `split_from:${key}`,
      });
      recordMemoryRevision(ownerId, p.key, { before: null, after: p.value, reason: `split_from:${key}` });
    }

    source.history = buildRevisionHistory(source, reason);
    source.status = 'archived';
    source.splitInto = prepared.map(p => p.key);
    source.archivedAt = now;
    source.updatedAt = now;
    touchMind(mind);
    recordMemoryRevision(ownerId, key, { before: 'active', after: `split_into:${source.splitInto.join(',')}`, reason });
    console.log(`[MEMEDIT] SPLIT owner=${ownerId} key=${key} into=${source.splitInto.join(',')}`);
    return { ok: true, source: factView(source), parts: source.splitInto.map(k => factView(getFact(ownerId, k))) };
  } catch (err) {
    console.warn('[MEMEDIT] splitFact failed (non-fatal):', err.message);
    return fail(err.message);
  }
}

// ── Reads for the editing UI/API ─────────────────────────────────────────────

export function getEditableFact(ownerId, key) {
  const mind = peekMind(ownerId);
  const fact = mind?.facts?.[key] ?? null;
  if (!fact) return null;
  return { fact: factView(fact), history: getFactHistory(ownerId, key) };
}

export function listAllFacts(ownerId) {
  const active = getFacts(ownerId);
  const all = getFacts(ownerId, { includeArchived: true });
  return {
    active: active.map(factView),
    archived: all.filter(f => f.status === 'archived').map(factView),
  };
}

export { deleteFact as deleteFactByKey };
