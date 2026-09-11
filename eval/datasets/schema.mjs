/**
 * AQUA Eval — extraction label schema
 * Blueprint E2/PR-2 · target schema from Blueprint Part 3 (claims)
 *
 * WHAT A LABEL IS, AND WHY IT IS NOT THE CURRENT SCHEMA
 * ----------------------------------------------------
 * Cases are labelled against the CLAIM the blueprint targets — subject,
 * predicate, object, polarity, modality, time — not against what
 * `files/extractors.js` can currently produce.
 *
 * That is deliberate and it has a trap in it worth naming here, because
 * E2/PR-3 has to avoid it: the regex extractor cannot express polarity at all.
 * Scored naively against these labels it reports near zero, and a near-zero
 * baseline is useless — it tells you nothing about where the gap is and it
 * makes any replacement look miraculous.
 *
 * So the labels are FULL and the scoring is GRADED. PR-3 measures at four
 * levels, and the interesting result is the shape of the drop-off:
 *
 *   detection    did anything get captured from a sentence that carries a claim?
 *   subject      is it about the right entity?
 *   predicate    is the relation right?
 *   fidelity     polarity + modality + time
 *
 * The regex extractor is expected to score respectably on detection and zero
 * on fidelity. That contrast IS the baseline — it is the number E6 exists to
 * move, and stating the expectation now stops PR-3 reading as a catastrophe.
 *
 * NEGATIVES ARE HALF THE DATASET'S VALUE
 * --------------------------------------
 * A third of the cases carry NO claims: requests, questions, small talk, code.
 * Without them precision is unmeasurable, and an extractor that fires on
 * everything scores perfectly on recall. This project has already shipped that
 * exact failure twice — "I need to check the logs" became a self-declaration,
 * and a stopword matched a fact — so the negatives are not padding.
 */

/**
 * Controlled predicate vocabulary. Small, open by review, versioned with the
 * dataset. Modelled on `reasoning/typeRegistry.js`: adding one is a decision
 * someone makes on purpose, not a side effect of a new sentence.
 *
 * Every entry here has at least two examples in the dataset, enforced by test.
 * A predicate with one example produces a per-predicate score of 0% or 100%
 * and nothing in between — a number that looks like a measurement and is a
 * coin flip. Three entries were removed for exactly that reason while v1 was
 * being written rather than padding cases to justify keeping them.
 */
export const PREDICATES = Object.freeze([
  // identity & work
  'works_at', 'role_is', 'located_in', 'member_of', 'founded', 'builds', 'uses',
  // people
  'knows', 'reports_to', 'manages', 'related_to',
  // preference & habit
  'prefers', 'dislikes', 'habit_of',
  // projects & artefacts
  'owns', 'depends_on', 'blocks',
  // intent, decision, task
  'plans_to', 'decided', 'rejected', 'task_owner', 'has_status', 'deadline_for',
  // state
  'has_property',
]);

export const POLARITIES = Object.freeze(['asserted', 'negated']);
export const MODALITIES = Object.freeze(['fact', 'intent', 'hypothetical', 'question', 'quote']);
export const TIME_KINDS = Object.freeze(['absolute', 'relative', 'none']);

export const CATEGORIES = Object.freeze([
  'identity', 'people', 'negation', 'modality', 'temporal',
  'decision', 'task', 'negative',
]);

const CASE_ID = /^[a-z]+-\d{3}$/;

export class DatasetError extends Error {
  constructor(message) { super(message); this.name = 'DatasetError'; }
}

function fail(id, message) { throw new DatasetError(`${id}: ${message}`); }

/** Validate one labelled claim. */
export function validateClaim(id, claim, text) {
  for (const field of ['s', 'p', 'o']) {
    if (typeof claim[field] !== 'string' || !claim[field].length) fail(id, `claim.${field} is required`);
  }
  if (!PREDICATES.includes(claim.p)) {
    fail(id, `unknown predicate "${claim.p}" — add it to PREDICATES on purpose, or relabel`);
  }
  if (!POLARITIES.includes(claim.polarity)) fail(id, `polarity must be one of ${POLARITIES}`);
  if (!MODALITIES.includes(claim.modality)) fail(id, `modality must be one of ${MODALITIES}`);

  const time = claim.time ?? { kind: 'none' };
  if (!TIME_KINDS.includes(time.kind)) fail(id, `time.kind must be one of ${TIME_KINDS}`);
  if (time.kind !== 'none' && !time.expr) fail(id, 'a dated claim must record the expression it came from');

  // The subject must be traceable to the sentence. A label that invents its
  // subject is unscoreable — no extractor could ever be judged against it.
  const self = ['I', 'me', 'my', 'we', 'our', 'us'];
  const inText = text.toLowerCase().includes(claim.s.toLowerCase());
  if (claim.s !== 'SELF' && !inText) {
    fail(id, `subject "${claim.s}" does not appear in the sentence — use SELF for first person`);
  }
  if (claim.s === 'SELF' && !self.some(w => new RegExp(`\\b${w}\\b`, 'i').test(text))) {
    fail(id, 'labelled SELF but the sentence carries no first-person marker');
  }
  return true;
}

/** Validate the whole dataset. Throws on the first problem, loudly. */
export function validateDataset(ds) {
  if (!ds || typeof ds !== 'object') throw new DatasetError('dataset must be an object');
  for (const field of ['id', 'version', 'about', 'limitations', 'cases']) {
    if (!ds[field]) throw new DatasetError(`dataset.${field} is required`);
  }
  if (!Array.isArray(ds.cases)) throw new DatasetError('dataset.cases must be an array');

  const seenIds = new Set();
  const seenText = new Map();

  for (const c of ds.cases) {
    const id = c.id ?? '(no id)';
    if (!CASE_ID.test(id)) fail(id, 'id must look like "negation-007"'.replace('negation', 'category'));
    if (seenIds.has(id)) fail(id, 'duplicate case id');
    seenIds.add(id);

    if (!CATEGORIES.includes(c.cat)) fail(id, `unknown category "${c.cat}"`);
    if (typeof c.text !== 'string' || c.text.trim().length < 3) fail(id, 'text is required');
    if (!Array.isArray(c.claims)) fail(id, 'claims must be an array (use [] for a negative)');

    const norm = c.text.trim().toLowerCase();
    if (seenText.has(norm)) fail(id, `duplicate sentence, already used by ${seenText.get(norm)}`);
    seenText.set(norm, id);

    if (c.cat === 'negative' && c.claims.length > 0) {
      fail(id, 'a negative case must carry no claims — that is what makes precision measurable');
    }
    if (c.cat !== 'negative' && c.claims.length === 0) {
      fail(id, 'a non-negative case with no claims should be categorised "negative"');
    }
    for (const claim of c.claims) validateClaim(id, claim, c.text);
  }

  // ── Class completeness — the E6 smoke defect, made structural ──────────────
  //
  // Every rule above judges a case in isolation, and a dataset can satisfy all
  // of them and still be unmeasurable. Delete every negation case and the file
  // is still perfectly well formed — but `detection_negation` becomes 0/0, and
  // `ratio()` renders 0/0 as 0.0. The E6 promotion gate read exactly that
  // number off exactly that kind of slice and returned DO NOT PROMOTE: a
  // verdict about a missing class, delivered as a verdict about the extractor.
  //
  // Publishing `n_cases_*` next to the rates (extraction-core.suite.mjs) makes
  // that emptiness READABLE. This makes it IMPOSSIBLE. No dataset reaches a
  // scorer carrying a declared category it cannot measure.
  //
  // One rule covers every denominator in the suite: each per-category rate
  // divides by its own category count, `silence_on_negatives` divides by the
  // negatives, and the three claim-level rates divide by the labelled claims —
  // which cannot be zero once a non-negative category is non-empty, because a
  // non-negative case with no claims is already refused above.
  //
  // The registry is the contract. A dataset that genuinely should not carry a
  // category shrinks CATEGORIES — an edit a reviewer sees — rather than
  // omitting it quietly.
  const counts = census(ds);
  const empty = CATEGORIES.filter(c => counts[c] === 0);
  if (empty.length) {
    throw new DatasetError(
      `${ds.id}: no cases in category ${empty.map(c => `"${c}"`).join(', ')} — `
      + 'every metric over that category would be 0/0 rendered as 0.0. Add cases, '
      + 'or remove the category from CATEGORIES on purpose.');
  }

  return true;
}

/** Counts by category — used by the dataset's own integrity test. */
export function census(ds) {
  const out = Object.fromEntries(CATEGORIES.map(c => [c, 0]));
  for (const c of ds.cases) out[c.cat]++;
  return out;
}
