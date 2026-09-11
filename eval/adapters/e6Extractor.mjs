/**
 * AQUA Eval — adapter for the E6 extraction pipeline (Blueprint E6/PR-11).
 *
 * Runs a segment through every stage built in PR-1 … PR-7 and returns the
 * SAME `{ facts, surfaces }` shape `currentExtractor.mjs` returns, so
 * `extraction-core.v1` can score both without a second scorer.
 *
 * It runs NOTHING itself: `runUnderstandingPipeline` (S0 → S5) does the work,
 * and this maps its output into the `{ facts, surfaces }` shape the suite
 * scores. Keeping the composition in `src/` is what makes the shadow numbers
 * describe the code that would actually ship.
 *
 * WHY IT REUSES THE EXISTING SUITE RATHER THAN BRINGING ITS OWN
 * -------------------------------------------------------------
 * `extraction-core.suite.mjs` already computes `predicateHits` and
 * `fidelityHits` from the OUTPUT SHAPE, with a comment saying it does so "so
 * the day E6 starts emitting them this begins scoring without a code change".
 * A second scorer written for the new extractor would be a scorer written by
 * the person hoping it wins, and the committed baseline — predicate 0.0%,
 * fidelity 0.0% — would no longer be comparable to anything.
 *
 * So: same 200 cases, same four levels, same arithmetic. Only the extractor
 * changes.
 *
 * ⚠️ IT CANNOT RUN WITHOUT A PROVIDER, AND SAYS SO RATHER THAN SCORING ZERO.
 * A pipeline with no transport emits no claims, which the suite would score as
 * detection 0.0% — a number indistinguishable from a catastrophically bad
 * extractor. `extractE6` therefore returns `available: false` and the harness
 * refuses to publish, instead of reporting the absence of a key as a result.
 */
import { runUnderstandingPipeline } from '../../src/brain/understanding/pipeline.js';

/** A fixed anchor so a re-run on a different day produces identical output. */
export const EVAL_ASSERTED_AT = '2026-08-24T10:00:00.000Z';

/**
 * Map one validated claim to the fact shape `extraction-core` scores.
 *
 * The suite reads `f.predicate`, `f.polarity`, `f.modality` and
 * `f.time || f.validFrom || f.validTo`, and matches subjects against
 * `surfaces`. Anything not in that list is invisible to scoring, so this is
 * deliberately narrow — a fact object carrying extra fields would invite the
 * belief that they were measured.
 */
function toFact(claim) {
  return {
    statement: claim.statementText ?? claim.statement_text ?? '',
    predicate: claim.predicate,
    polarity: claim.polarity ?? 'asserted',
    modality: claim.modality ?? 'fact',
    validFrom: claim.validFrom ?? null,
    validTo: claim.validTo ?? null,
    time: claim.timePrecision && claim.timePrecision !== 'none' ? claim.timePrecision : null,
    subject: claim.subject,
    object: claim.object,
  };
}

/**
 * Run the E6 pipeline over one text.
 *
 * @param {string} text
 * @param {object} opts
 * @param {Function} opts.callModel  the transport. REQUIRED — see the header.
 * @param {string} [opts.modelPin]
 * @param {string} [opts.sourceTier] defaults to `chat`, which is what a
 *   conversational eval corpus actually is. Claiming `explicit` would raise
 *   every confidence ceiling and flatter the run.
 * @returns {Promise<{available:boolean, facts:object[], surfaces:string[], stats:object}>}
 */
export async function extractE6(text, opts = {}) {
  if (typeof opts.callModel !== 'function') {
    return { available: false, facts: [], surfaces: [], stats: { reason: 'no-transport' } };
  }

  // DELEGATES to the production pipeline. It used to compose the stages here,
  // which meant the shadow run measured an arrangement that existed only in
  // the eval harness — L12's failure in the place it would be least visible,
  // because the numbers would look real while describing something never
  // shipped. Two compositions would also have drifted the first time a stage
  // changed, and the eval would have kept reporting on the old one.
  const run = await runUnderstandingPipeline(text, {
    ...opts,
    assertedAt: opts.assertedAt ?? EVAL_ASSERTED_AT,
    sourceTier: opts.sourceTier ?? 'chat',
  });

  const facts = [];
  const surfaces = new Set();
  // 🔴 THE SAME MISMATCH AS `__self__`, ONE LINE FURTHER DOWN.
  //
  // The suite matches a named subject with `surfaces.has(claim.s.toLowerCase())`
  // — the label is ALWAYS lowered before the lookup. `currentExtractor.mjs`
  // lowers everything it adds (`out.add(String(s).toLowerCase())`). This adapter
  // added `claim.subject` at whatever casing the model produced, so "Priya"
  // never matched "priya".
  //
  // 49 of the 167 labelled claims have a capitalised named subject — Priya,
  // Dev, Aquiplex, Chhanda — which is 29% of the corpus that could not score
  // however well the model read it. Fixing `__self__` last session exposed this
  // one: subject_recall moved 0.0% → 43.7%, still below the regex lane's 55.7%,
  // and this is why.
  //
  // Same normalisation as the regex lane, in one helper, so a third call site
  // cannot reintroduce it.
  const add = v => { if (v != null && String(v).trim()) surfaces.add(String(v).toLowerCase()); };

  for (const claim of run.claims) {
    facts.push(toFact(claim));

    // 🔴 THE SUITE CHECKS ONE SENTINEL, AND THIS EMITTED SIX OF THE WRONG THING.
    //
    // `extraction-core.suite.mjs` scores a self-subject with exactly:
    //
    //     if (claim.s === 'SELF') return surfaces.has('__self__');
    //
    // The previous version of this block expanded `self` into first-person
    // SURFACE forms — 'I', 'me', 'my', 'we', 'our' — reasoning that the labels
    // use those. They do not: the label is the literal string `SELF` and the
    // suite translates it to the sentinel `__self__`, which is what
    // `currentExtractor.mjs` has always emitted (`if (e.isSelf) out.add('__self__')`).
    //
    // So every self-claim missed. Measured on the first shadow run: 20 of 20
    // claims in the identity slice are SELF-subject, and `subject_recall` came
    // back 0.00 against the regex lane's 0.55 on the SAME cases — while
    // detection sat at 0.90 and predicate accuracy at 0.65. An extractor
    // finding 90% of claims and reading 65% of predicates correctly was never
    // getting 0% of subjects; the shape of that number was the tell.
    //
    // The comment this replaces described the right problem and shipped the
    // wrong token. The first-person forms are kept ALONGSIDE the sentinel: they
    // cost nothing, and a label that names a surface form directly still matches.
    if (claim.subject === 'self') {
      surfaces.add('__self__');
      for (const t of ['self', 'I', 'me', 'my', 'we', 'our']) surfaces.add(t);
    } else add(claim.subject);
    if (claim.objectKind === 'entity' && claim.object?.entity) add(claim.object.entity);
  }

  return { available: true, facts, surfaces: [...surfaces], stats: run.stats };
}
