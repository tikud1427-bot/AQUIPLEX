/**
 * E10 — are the two lanes seeing the same turns?
 *
 * Every conversation turn is processed by TWO independent pipelines that write
 * to TWO stores: the legacy heuristic lane (`conversationFacts` ->
 * `.aqua-evidence.json`, gated by AQUA_BRAIN_INGEST_FACTS) and the E6 lane
 * (extraction -> `aqua_claims`, gated by AQUA_E6). Nothing reconciles them, and
 * the decision that depends on the answer — can the heuristic lane be switched
 * off without starving the fail-safe floor? — has been waiting on a number
 * nobody had.
 *
 * This is the number, and ONLY the number. Pure: it takes already-read rows and
 * returns counts. It writes nothing, imports no store, and decides nothing.
 *
 *   both            the turn has legacy facts AND canonical claims
 *   legacyOnly      the heuristic lane stored something, canonical has nothing
 *                   — switching the heuristic lane off would LOSE these turns
 *   canonicalOnly   canonical has claims the heuristic lane never produced
 *   unjoinable      legacy facts whose id is not a `conv:C:T:fact:i` turn id
 *                   (documents, derived facts) — reported, never guessed at
 *
 * A turn counts as "canonical" only when it has at least one ACTIVE-or-held
 * claim row, not merely a source row: a source with zero claims is an E6 turn
 * that found nothing, which is not coverage.
 */
import { canonicalTurnSourceId, parseLegacyFactTurn } from './turnSourceIdentity.js';

/**
 * @param {string} ownerId
 * @param {{id:string}[]} legacyFacts           evidenceStore facts for the owner
 * @param {Map<string,number>|Record<string,number>} claimsBySource   source_id -> claim count
 */
export function reconcileTurns(ownerId, legacyFacts, claimsBySource) {
  const canon = claimsBySource instanceof Map
    ? claimsBySource : new Map(Object.entries(claimsBySource ?? {}));

  const legacyTurns = new Map();       // canonical source id -> { key, facts }
  let unjoinable = 0;
  let legacyFactCount = 0;
  for (const f of legacyFacts ?? []) {
    const t = parseLegacyFactTurn(f?.id);
    if (!t) { unjoinable++; continue; }
    legacyFactCount++;
    const sid = canonicalTurnSourceId(ownerId, t.conversationId, t.turn);
    const row = legacyTurns.get(sid) ?? { key: `${t.conversationId}:${t.turn}`, facts: 0 };
    row.facts++;
    legacyTurns.set(sid, row);
  }

  let both = 0, legacyOnly = 0, bothLegacyFacts = 0, bothClaims = 0, legacyOnlyFacts = 0;
  const legacyOnlySample = [];
  for (const [sid, row] of legacyTurns) {
    const n = canon.get(sid) ?? 0;
    if (n > 0) { both++; bothLegacyFacts += row.facts; bothClaims += n; }
    else {
      legacyOnly++; legacyOnlyFacts += row.facts;
      if (legacyOnlySample.length < 5) legacyOnlySample.push(row.key);
    }
  }

  let canonicalOnly = 0, canonicalOnlyClaims = 0;
  for (const [sid, n] of canon) {
    if (n > 0 && !legacyTurns.has(sid)) { canonicalOnly++; canonicalOnlyClaims += n; }
  }

  return {
    ownerId,
    legacy: { turns: legacyTurns.size, facts: legacyFactCount, unjoinable },
    canonical: { turns: [...canon.values()].filter(n => n > 0).length },
    both: { turns: both, legacyFacts: bothLegacyFacts, claims: bothClaims },
    legacyOnly: { turns: legacyOnly, facts: legacyOnlyFacts, sample: legacyOnlySample },
    canonicalOnly: { turns: canonicalOnly, claims: canonicalOnlyClaims },
  };
}

/** Sum per-owner reports. */
export function totalReconciliation(reports) {
  const z = () => ({ turns: 0 });
  const t = {
    owners: reports.length,
    legacy: { turns: 0, facts: 0, unjoinable: 0 }, canonical: { turns: 0 },
    both: { turns: 0, legacyFacts: 0, claims: 0 },
    legacyOnly: { turns: 0, facts: 0 }, canonicalOnly: { turns: 0, claims: 0 },
  };
  for (const r of reports) {
    for (const k of ['turns', 'facts', 'unjoinable']) t.legacy[k] += r.legacy[k];
    t.canonical.turns += r.canonical.turns;
    for (const k of ['turns', 'legacyFacts', 'claims']) t.both[k] += r.both[k];
    for (const k of ['turns', 'facts']) t.legacyOnly[k] += r.legacyOnly[k];
    for (const k of ['turns', 'claims']) t.canonicalOnly[k] += r.canonicalOnly[k];
  }
  void z;
  return t;
}

/**
 * The verdict is a SENTENCE about what the numbers allow, never an action.
 * Switching a flag stays a human decision (aqua-e10 note: product tradeoff).
 */
export function verdict(total) {
  const { legacy, legacyOnly, canonical } = total;
  if (!legacy.turns) return 'The heuristic lane holds no conversation turns for these owners — nothing depends on it.';
  if (!canonical.turns) {
    return `Canonical holds NO claims for any of ${legacy.turns} legacy turn(s). The E6 lane is not committing (check AQUA_E6, a reachable DATABASE_URL, and AQUA_E6_COMMIT); do not switch the heuristic lane off.`;
  }
  const pct = Math.round((legacyOnly.turns / legacy.turns) * 100);
  if (legacyOnly.turns === 0) return 'Every legacy turn also has canonical claims. The heuristic lane adds no turn coverage on this data.';
  return `${legacyOnly.turns} of ${legacy.turns} legacy turn(s) (${pct}%) exist ONLY in the legacy store. Switching the heuristic lane off would drop those from the fail-safe floor.`;
}
