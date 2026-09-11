/**
 * AQUA Claims — the shadow projector (conversationFacts → claimRepository)
 * Blueprint E5/PR-6 · L5 · L7 · L11 · L13 · L17 (composition over replacement)
 *
 * WHAT THIS IS, IN ONE LINE
 * -------------------------
 * The same facts a turn already wrote to the evidence store, projected a second
 * time into the claim substrate — where nothing reads them yet.
 *
 * WHY A SECOND WRITE IS NOT A SECOND SOURCE OF TRUTH
 * --------------------------------------------------
 * The audit's central finding is three semantic stores nobody can reconcile, so
 * adding a write path needs a better answer than "the blueprint says claims".
 * The answer is that this path is DERIVED and UNREAD:
 *
 *   · the JSON evidence store stays authoritative — retrieval, context and the
 *     UI are untouched and read nothing from here;
 *   · every claim is projected from a fact that already exists, so the claim
 *     substrate cannot contain anything the authoritative store does not;
 *   · a parity report makes the difference between the two VISIBLE per turn,
 *     which is the entire point of running it in shadow before trusting it.
 *
 * The day claims become authoritative, the number that justifies the switch is
 * the parity report having been boring for a long time. Without it the switch
 * would be a decision taken on the blueprint's authority rather than evidence.
 *
 * COMPOSITION, NOT A NEW PROJECTION (L17)
 * ---------------------------------------
 * `backfill.js` already knows how to turn a legacy fact into a claim, including
 * the part that matters most: it REFUSES to invent predicate, polarity,
 * modality or validity, because guessing those is extraction and doing it
 * inside a migration buries an unmeasured extractor where nobody evaluates it.
 * That judgement is correct per-turn for exactly the same reason, so this
 * module calls it rather than reimplementing it — a second projection would be
 * a second set of rules about what an unknown predicate means.
 *
 * ⚠️ WHAT THIS DOES NOT DO
 *   · does not read claims back — retrieval is untouched
 *   · does not delete or supersede any fact (L5)
 *   · does not invent fields the source lane never had
 *   · does not run without Postgres — see `shadowMode.js` for that contract
 *   · does not turn itself on — `AQUA_CLAIMS_SHADOW` is off by default
 */
import { getFact, getEvidence } from '../../files/evidenceStore.js';
import { backfillOwner, UNRESOLVED } from './backfill.js';

/**
 * Project the facts one turn just wrote.
 *
 * FAIL-OPEN (L11). Every failure mode returns a report with `ok: false` and a
 * reason. A shadow projection that could throw would be a shadow projection
 * that costs a user their turn, and the first incident would end with it being
 * switched off permanently rather than fixed.
 *
 * IDEMPOTENT (G2) by inheritance, not by a second mechanism: `saveEvidence`
 * dedupes on content checksum and `recordClaim` dedupes on the normalised
 * statement, so replaying a turn reuses rows instead of twinning them. The
 * `duplicates` count below is how that shows up in the report rather than
 * silently — a turn projecting 0 new claims from 3 facts is a correct replay,
 * and looks identical to a broken projector unless it is counted.
 *
 * OWNER-SCOPED (G3): `ownerId` is passed to every read and every write; there
 * is no path here that touches another owner's bucket.
 *
 * @param {object} args
 * @param {string} args.ownerId
 * @param {string[]} args.factIds  ids written by THIS turn, in write order
 * @param {object} [deps]
 * @returns {Promise<object>} parity report — never throws
 */
export async function projectTurnFacts({ ownerId, factIds = [] } = {}, deps = {}) {
  const {
    getFact: readFact = getFact,
    getEvidence: readEvidence = getEvidence,
    backfill = backfillOwner,
  } = deps;

  const report = {
    ok: false, ownerId: ownerId ?? null,
    facts: factIds.length, claims: 0, duplicates: 0,
    unmatched: 0, rejected: 0, rejections: [],
    // 🔴 TWO ATTRIBUTIONS, BOTH RECORDED, BECAUSE THEY ARE DIFFERENT FACTS.
    // The first version reported `extractor: 'conversationFacts'` while the row
    // it produced recorded `extractor=backfill@v1`. Both are true — the lane
    // that observed the sentence and the code that projected it are not the
    // same thing — and a report that names one while the database names the
    // other is a disagreement waiting to be discovered during an incident.
    sourceExtractor: 'conversationFacts',
    projector: 'backfill@v1',
    unresolvedPredicate: 0, reason: null,
  };

  if (!ownerId) { report.reason = 'no owner'; return report; }
  if (!factIds.length) { report.ok = true; return report; }

  try {
    // Resolve ids to the objects the backfill contract expects. A fact id that
    // no longer resolves is UNMATCHED, not an error: the authoritative store is
    // allowed to have moved on, and divergence is the thing this report exists
    // to surface rather than to crash on.
    const facts = [];
    const evidenceById = new Map();
    for (const id of factIds) {
      const fact = readFact(ownerId, id);
      if (!fact) { report.unmatched += 1; continue; }
      facts.push(fact);
      for (const evId of fact.evidence ?? []) {
        const ev = readEvidence(ownerId, evId);
        if (ev) evidenceById.set(evId, ev);
      }
    }
    if (!facts.length) { report.ok = true; return report; }

    const result = await backfill(ownerId, facts, evidenceById);

    report.claims = result.projected ?? 0;
    report.rejected = (result.skipped ?? []).length;
    report.rejections = (result.skipped ?? [])
      .map(s => (s.problems ?? []).join('|')).filter(Boolean).slice(0, 5);
    // Every claim this path can produce is predicate-unresolved by design; the
    // count is the size of the debt E6 will pay down, stated per turn.
    report.unresolvedPredicate = report.claims;
    report.duplicates = Math.max(0, facts.length - report.claims - report.rejected);
    report.ok = true;
    return report;
  } catch (err) {
    report.reason = err?.message ?? String(err);
    return report;
  }
}

/**
 * One line per projecting turn.
 *
 * Prints ONLY when the projector actually did something or failed. A line on
 * every turn including the ones with nothing to project would bury the
 * divergence signal in noise, and divergence is the only reason to run this.
 */
export function claimParityLine(r) {
  if (!r) return null;
  if (!r.ok) return `[CLAIMS] parity owner=${r.ownerId ?? '?'} FAILED reason=${r.reason}`;
  if (!r.facts) return null;
  const why = r.rejections.length ? ` rejected_because=${JSON.stringify(r.rejections)}` : '';
  return `[CLAIMS] parity owner=${r.ownerId} source=${r.sourceExtractor} projector=${r.projector} facts=${r.facts} `
    + `claims=${r.claims} duplicates=${r.duplicates} unmatched=${r.unmatched} `
    + `rejected=${r.rejected} predicate=${UNRESOLVED}:${r.unresolvedPredicate}${why}`;
}
