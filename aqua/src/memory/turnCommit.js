/**
 * AQUA — a turn's memory commits with the turn (Sprint 1 Task D, 2026-11-10)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT (audit F-12). memoryObserve runs BEFORE generation — facts, Mind
 * beliefs, goals, working memory, episodes and graph are written from the
 * user's message, then the model is called. When generation failed (provider
 * exhaustion → HTTP 503 / SSE error) nothing was added to the conversation, but
 * everything learned from the message stayed: Aqua "knew" things from a turn
 * that, as far as the user and the history can tell, never happened. A retry
 * then observed the same message AGAIN (belief evidence counted twice).
 *
 * THE RULE. A turn's durable knowledge commits at the turn's COMMIT BOUNDARY:
 * the moment its user message is persisted to the conversation (routes/chat.js
 * persistUserTurn). A request that ends without reaching it is rolled back.
 *
 * WHY THIS SHAPE (and not "observe after generation"). The same turn's
 * retrieval reads what observation just stored ("my name is X — what's my
 * name?"), and the Mind's observers run on the turn — moving observation would
 * change every successful turn. This keeps the successful path's behaviour
 * identical and only adds a compensating revert for the failed one.
 *
 * HOW. Everything observation writes lives in ONE object: the owner's Mind
 * (legacy facts are `mind.facts`). It is snapshotted as UNITS — one per item
 * (`facts.<key>`, `beliefs.<key>`, `graph.nodes.<key>`, …) or per scalar/array
 * field — each as its serialized string (no parse, no deep clone). At the end
 * of turn preparation the live Mind is serialized again and only the units the
 * turn CHANGED are kept (old string, new string); the rest is dropped.
 * Measured (Sprint 1 report): three deep clones cost ~100 ms per turn on an
 * 800 KB Mind; this costs two serialize passes and holds only the delta.
 *
 * Rollback, per changed unit, is a 3-way decision: if the unit still equals
 * what the turn left, it returns to what it was before (or is removed, with a
 * tombstone in merge-tracked bags so the two-process merge cannot resurrect
 * it); if something else changed it since, that later change is KEPT — a
 * concurrent turn's knowledge is never discarded.
 *
 * Effects on OTHER stores that observation schedules in the background (the
 * evidence-lane retirement of a superseded sentence, fact re-indexing) are
 * deferred to commit and dropped on rollback. A user's FORGET is honoured even
 * when the turn fails — deletion is not knowledge — and is re-applied after the
 * revert (its World Model / recall-redaction side ran immediately, as before).
 */
import { peekMind, getMind, touchMind, markDeleted, flushMind } from '../mind/mindStore.js';
import { deleteFact } from './longTermMemory.js';
import { forgetValueInMind } from './propagation.js';

const TOMBSTONE_BAGS = new Set(['facts', 'beliefs', 'goals', 'episodes', 'files']);
/** Containers split one level deeper than the default (their items are nested one more level). */
const DEEP = new Set(['graph']);
const SEP = '\u0000';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Mind → Map(unitPath → serialized value). Top-level objects are split into
 * their items (`graph` one level further); everything else is one unit.
 */
export function snapshotUnits(mind) {
  const units = new Map();
  if (!mind) return units;
  for (const [k, v] of Object.entries(mind)) {
    if (v === undefined) continue;
    if (!isObj(v)) { units.set(k, JSON.stringify(v)); continue; }
    for (const [k2, v2] of Object.entries(v)) {
      if (v2 === undefined) continue;
      if (DEEP.has(k) && isObj(v2)) {
        units.set(`${k}${SEP}${k2}`, '{}');   // the container exists (even when empty)
        for (const [k3, v3] of Object.entries(v2)) if (v3 !== undefined) units.set(`${k}${SEP}${k2}${SEP}${k3}`, JSON.stringify(v3));
      } else {
        units.set(`${k}${SEP}${k2}`, JSON.stringify(v2));
      }
    }
    units.set(k, '{}');   // the bag itself exists
  }
  return units;
}

/** before/after unit maps → Map(path → { before, after }) for the units that differ. */
export function diffUnits(before, after) {
  const changed = new Map();
  for (const [p, a] of after) { const b = before.get(p); if (b !== a) changed.set(p, { before: b, after: a }); }
  for (const [p, b] of before) if (!after.has(p)) changed.set(p, { before: b, after: undefined });
  return changed;
}

function readUnit(mind, path) {
  const parts = path.split(SEP);
  let v = mind;
  for (const p of parts) { if (!isObj(v) || !(p in v)) return undefined; v = v[p]; }
  if (parts.length < 3 && isObj(v) && (parts.length === 1 || DEEP.has(parts[0]))) return '{}';   // containers compare by existence
  return v === undefined ? undefined : JSON.stringify(v);
}

function writeUnit(mind, path, serialized) {
  const parts = path.split(SEP);
  let v = mind;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isObj(v[parts[i]])) v[parts[i]] = {};
    v = v[parts[i]];
  }
  const last = parts.at(-1);
  if (serialized === undefined) delete v[last];
  else if (serialized === '{}' && isObj(v[last])) { /* container: keep its other items */ }
  else v[last] = JSON.parse(serialized);
}

/**
 * Open a turn's memory transaction for `ownerId`. Creates the owner's (empty)
 * Mind first if absent — an empty model is not knowledge, and the revert then
 * has a concrete `before`. Returns null when there is no owner (memory off).
 */
export function beginTurnMemory(ownerId, { requestId = null } = {}) {
  if (!ownerId) return null;
  const effects = [];
  const txn = {
    ownerId, requestId,
    before: snapshotUnits(getMind(ownerId)),
    changed: null,            // Map(path → {before, after}) once sealed
    state: 'open',            // open | committed | rolled_back
    effects,
    forgets: [],              // fact keys the turn's FORGET deleted (honoured on rollback)
    /**
     * Schedule a background effect on another store: runs at commit, dropped on
     * rollback. `kind` (Phase 4A) names effects a caller may hand to a durable
     * worker job instead of running here ('index': fact embeddings).
     */
    defer: (fn, kind = null) => {
      if (txn.state === 'committed') { txn.effectRuns.push(safeRun(fn)); return; }
      if (txn.state === 'open') effects.push({ fn, kind });
    },
    effectRuns: [],             // promises of the effects run at commit (Phase 4A: awaitable)
  };
  return txn;
}

/** Remember that this turn's FORGET deleted `forget.key` (cheap; call right after observation). */
export function noteTurnForget(txn, forget) {
  if (!txn || txn.state !== 'open' || !forget?.deleted || !forget.key) return;
  if (!txn.forgets.includes(forget.key)) txn.forgets.push(forget.key);
}

/**
 * End of turn preparation: keep only what the turn changed. Includes the
 * turn's own retrieval bookkeeping. Further calls re-derive from `before`.
 */
export function sealTurnMemory(txn) {
  if (!txn || txn.state !== 'open' || !txn.before) return;
  txn.changed = diffUnits(txn.before, snapshotUnits(peekMind(txn.ownerId)));
  txn.forgetValues = Object.fromEntries(txn.forgets.map(k => [k, txn.before.get(`facts${SEP}${k}`)]));
  txn.before = null;   // the unchanged rest is not needed again
}

function safeRun(fn) {
  // Fail-open as before; returns a promise so a caller MAY await the effect (Phase 4A).
  try { const r = fn(); return (r && typeof r.then === 'function') ? Promise.resolve(r).catch(() => {}) : Promise.resolve(); }
  catch { return Promise.resolve(); /* background effects are fail-open */ }
}

/**
 * The user message reached the conversation: the turn's memory stands. Idempotent.
 * `skipKinds` (Phase 4A): effects of these kinds are NOT run here — the caller
 * scheduled them as durable worker jobs in the same transaction as the turn.
 */
export function commitTurnMemory(txn, { skipKinds = null } = {}) {
  if (!txn || txn.state !== 'open') return false;
  txn.state = 'committed';
  for (const { fn, kind } of txn.effects.splice(0)) {
    if (kind && skipKinds?.includes?.(kind)) continue;
    txn.effectRuns.push(safeRun(fn));
  }
  txn.before = null; txn.changed = null;
  return true;
}

/** Does this open turn carry a pending effect of `kind`? (Phase 4A) */
export function turnHasEffect(txn, kind) {
  return Boolean(txn && txn.state === 'open' && txn.effects.some(e => e.kind === kind));
}

/** Wait for the effects run at commit (bounded). Resolves true when all settled in time. (Phase 4A) */
export async function awaitTurnEffects(txn, timeoutMs = 3_000) {
  if (!txn?.effectRuns?.length) return true;
  const all = Promise.allSettled(txn.effectRuns.splice(0));
  return Promise.race([all.then(() => true), new Promise(r => setTimeout(() => r(false), timeoutMs).unref?.())]);
}

/**
 * The request ended without persisting the user message: undo what this turn
 * taught the Mind. Idempotent; a no-op after commit. Never throws — a failed
 * revert is reported, the request's own error still wins.
 */
export function rollbackTurnMemory(txn, { reason = 'uncommitted' } = {}) {
  if (!txn || txn.state !== 'open') return null;
  const report = { reverted: 0, kept: 0, forgetsHonoured: 0, error: null };
  // Not sealed (preparation threw midway): everything since `before` is this turn's.
  // Sealed while still open — sealTurnMemory is a no-op once the state moves on.
  try { if (!txn.changed && txn.before) sealTurnMemory(txn); } catch (err) { report.error = err?.name ?? 'error'; }
  txn.state = 'rolled_back';
  txn.effects.length = 0;              // background effects on other stores never happen
  try {
    const live = peekMind(txn.ownerId);
    if (live && txn.changed) {
      const now = Date.now();
      // Items before their containers' removal, deepest first.
      const paths = [...txn.changed.keys()].sort((a, b) => b.split(SEP).length - a.split(SEP).length);
      for (const p of paths) {
        const { before, after } = txn.changed.get(p);
        if (readUnit(live, p) !== after) { report.kept++; continue; }   // changed since: the later change stands
        writeUnit(live, p, before);
        report.reverted++;
        const parts = p.split(SEP);
        if (before === undefined && parts.length === 2 && TOMBSTONE_BAGS.has(parts[0])) markDeleted(live, parts[0], parts[1], now);
      }
      touchMind(live);
      for (const key of txn.forgets) {
        if (deleteFact(txn.ownerId, key)) report.forgetsHonoured++;
        const s = txn.forgetValues?.[key];
        const value = s ? JSON.parse(s)?.value : undefined;
        if (value != null) forgetValueInMind(txn.ownerId, key, value);
      }
      flushMind(txn.ownerId);
    }
  } catch (err) {
    report.error = err?.name ?? 'error';
  }
  txn.before = null; txn.changed = null;
  console.log(`[MEMORY] TURN_ROLLBACK owner=${txn.ownerId} req=${txn.requestId ?? '-'} reason=${reason} reverted=${report.reverted} keptConcurrent=${report.kept} forgetsHonoured=${report.forgetsHonoured}${report.error ? ` error=${report.error}` : ''}`);
  return report;
}
