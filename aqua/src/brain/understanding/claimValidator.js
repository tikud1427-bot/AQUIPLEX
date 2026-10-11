/**
 * AQUA — Claim validation, stage S4 (Blueprint E6/PR-6)
 *
 * The hallucination firewall. Seven deterministic gates, taken verbatim from
 * the blueprint's S4 box:
 *
 *   ① quote must appear VERBATIM in the segment      → else DISCARD
 *   ② quote must contain the object literal/quantity → else DISCARD
 *   ③ predicate ∈ registry, or ∈ proposal queue (never auto-admitted)
 *   ④ modality/polarity ∈ enum
 *   ⑤ subject surface must appear in the segment OR be first-person
 *   ⑥ no sensitive-attribute predicates (D3)
 *   ⑦ confidence CEILING by source tier applied here, not by the model
 *
 * "This stage is code, not model (L3). It is why extraction can be
 * non-deterministic without the store becoming untrustworthy." Nothing here
 * asks a model anything, and nothing here is probabilistic.
 *
 * WHERE THIS SITS RELATIVE TO PR-4
 * --------------------------------
 * `extractionContract.js` is the SHAPE gate: is this well-formed enough to be
 * a claim at all. This is the TRUTH gate: does the claim follow from the text
 * in front of it. Gates ③ and ④ overlap the contract deliberately — the
 * contract runs on raw model output and this runs on validated claims, and a
 * caller may reach S4 by another route (the heuristic fallback path the
 * blueprint keeps as the floor). A firewall with a hole reachable from one
 * entrance is not a firewall.
 *
 * THREE OUTCOMES, NOT TWO
 * -----------------------
 * `admit` · `propose` · `discard`. The middle one matters and is easy to lose:
 * S3's prompt says "unknown predicate → propose, don't force", and S4 says a
 * predicate may be in the registry OR the proposal queue but is "never
 * auto-admitted". Collapsing propose into discard throws away the signal that
 * the vocabulary is too small; collapsing it into admit is the
 * auto-registration this design exists to prevent — a model inventing
 * `enjoys_working_at` beside `works_at` would split one employment history in
 * two, permanently and invisibly.
 *
 * NOT WIRED. No production caller, no flag. E6/PR-12 flips writers behind
 * `AQUA_EXTRACT_V2`.
 */
import { isRegistered } from '../../core/claims/predicateRegistry.js';

export const OUTCOME = Object.freeze({ ADMIT: 'admit', PROPOSE: 'propose', DISCARD: 'discard' });

const POLARITY = new Set(['asserted', 'negated']);
const MODALITY = new Set(['fact', 'intent', 'hypothetical', 'question', 'quote']);

/**
 * Gate ⑦'s ceilings, from D4.
 *
 * ⚠️ THESE ARE NOT THE NUMBERS IN `contextEngine/scorer.js`. That table reads
 * `document: 1.0, file: 1.0, conversation: 0.6, inferred: 0.45`; D4 reads
 * `explicit 0.9 > file 0.7 > chat 0.6 > inferred 0.45`. They agree on chat and
 * inferred and diverge on documents.
 *
 * Reported rather than reconciled, because they are answering different
 * questions and only one of them is a ceiling: the scorer's table is a
 * RANKING prior — how much should this item's origin push it up a candidate
 * list — while D4's is a STORAGE ceiling on what confidence may ever be
 * recorded. A document can reasonably rank top while still not being allowed
 * to claim 1.0 certainty. If they are ever meant to be one table, that is a
 * decision with its own measurement, not a silent edit here.
 */
export const SOURCE_CEILING = Object.freeze({
  explicit: 0.9,   // the user stated it directly and unambiguously
  file:     0.7,   // extracted from a document they uploaded
  chat:     0.6,   // extracted from conversation
  inferred: 0.45,  // derived rather than said
});

/** Unknown tiers get the FLOOR, not the benefit of the doubt. */
export const UNKNOWN_TIER_CEILING = SOURCE_CEILING.inferred;

/**
 * Gate ⑥ — D3's hard prohibition, as a predicate blocklist.
 *
 * ARMED, AND CURRENTLY INERT AGAINST THE REGISTRY. None of the 31 registered
 * predicates is sensitive, so this gate cannot fire on an admitted claim
 * today. It is not decoration: gate ③ can PROPOSE a predicate the model
 * invented, and a proposal is exactly how `has_religion` or
 * `has_health_condition` would enter the vocabulary. So ⑥ runs on proposals
 * too, and a blocked name is discarded rather than queued.
 *
 * Matched on stems rather than exact names because the model is inventing the
 * name, not choosing it: `health_condition`, `has_health_status` and
 * `medical_history` are one prohibition, not three.
 */
const SENSITIVE_STEMS = Object.freeze([
  'health', 'medical', 'diagnos', 'disease', 'illness', 'disabilit', 'pregnan',
  'politic', 'party_affiliation', 'votes_for', 'ideolog',
  'sexual', 'orientation', 'gender_identity',
  'religio', 'faith', 'church', 'caste',
  'immigration', 'citizenship', 'visa_status', 'ethnic', 'race',
  'criminal', 'conviction', 'arrest',
]);

export function isSensitivePredicate(name) {
  const n = String(name ?? '').toLowerCase();
  return SENSITIVE_STEMS.some(stem => n.includes(stem));
}

const norm = s => String(s ?? '').toLowerCase();

/**
 * Gate ① compares WORDS, not spellings of contractions (2026-10-06). Measured
 * on the production extractor: "Dev isn't on the platform team" quoted as
 * "Dev is not on the platform team" — the same words, a correct negated claim —
 * was discarded as not verbatim, and that one discard failed the negation gate.
 * Both sides are canonicalised the same way (curly apostrophes, n't → not, the
 * irregular can't/won't/shan't, whitespace); the quote must still be the
 * segment's own words. Nothing is added, nothing paraphrased is accepted.
 */
export function canonText(s) {
  return norm(s)
    .replace(/[‘’`´]/g, "'")
    .replace(/\bcan't\b/g, 'can not').replace(/\bcannot\b/g, 'can not')
    .replace(/\bwon't\b/g, 'will not').replace(/\bshan't\b/g, 'shall not')
    .replace(/\b(\w+)n't\b/g, '$1 not')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First person by GRAMMAR, never by surface form (S6's rule, applied early). */
const FIRST_PERSON_SUBJECT = new Set(['self', 'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'ours']);

/** Third-person references — "it", "that", "they"… — as whole words. */
const PRONOUN = /\b(it|its|it's|that|this|they|them|their|he|him|his|she|her)\b/;
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'for', 'to', 'in', 'on', 's']);
const words = s => norm(s).replace(/['’]s\b/g, ' ').split(/[^a-z0-9]+/).filter(w => w.length > 1 && !STOP.has(w));

/**
 * Gate ⑤b. `contextSubjects`: Map(normalised subject → [values the context
 * gives it]). Returns how the segment refers to the subject, or null.
 */
export function contextReference(subject, seg, contextSubjects) {
  if (!(contextSubjects instanceof Map)) return null;
  const values = contextSubjects.get(norm(subject).trim());
  if (!values) return null;                                  // not a subject it was given
  if (PRONOUN.test(seg)) return { subject, via: 'pronoun' };
  const segWords = new Set(words(seg));
  if (words(subject).some(w => segWords.has(w))) return { subject, via: 'name' };
  const valueHit = values.find(v => words(v).length && words(v).every(w => segWords.has(w)));
  if (valueHit) return { subject, via: 'value', value: valueHit };
  return null;
}

/**
 * Run the seven gates.
 *
 * @param {object} claim   a claim already through the PR-4 contract
 * @param {string} segment the exact text the claim was extracted from
 * @param {object} [opts]
 * @param {string} [opts.sourceTier] explicit | file | chat | inferred
 * @param {number} [opts.modelConfidence] what the model claimed, 0..1
 * @returns {{outcome:string, gate:number|null, reason:string|null, claim:object|null}}
 *
 * Gates run in order and stop at the first failure, so `gate` names the
 * earliest thing wrong rather than an arbitrary one — a claim failing ① and ⑤
 * has a quote problem, and reporting ⑤ would send someone to fix the wrong
 * thing.
 */
export function validateAgainstSegment(claim, segment, opts = {}) {
  const fail = (gate, reason) => ({ outcome: OUTCOME.DISCARD, gate, reason, claim: null });

  if (!claim || typeof claim !== 'object') return fail(0, 'not-a-claim');
  if (typeof segment !== 'string' || !segment.trim()) {
    // No segment means gate ① cannot run. Admitting anyway would let the
    // firewall be bypassed by omitting an argument — the most likely way a
    // future caller breaks this without noticing.
    return fail(0, 'no-segment');
  }

  const seg = norm(segment);
  const quote = claim.statementText ?? claim.statement_text ?? null;

  // ① VERBATIM QUOTE. "A claim with no span is a hallucination with a
  // database row" (D3). Compared case-insensitively but otherwise exactly —
  // the model is quoting, not paraphrasing, and case is the one difference a
  // provider routinely introduces.
  if (typeof quote !== 'string' || !quote.trim()) return fail(1, 'no-quote');
  if (!seg.includes(norm(quote)) && !canonText(segment).includes(canonText(quote))) return fail(1, 'quote-not-verbatim');

  // ② THE QUOTE MUST CONTAIN THE OBJECT. A verbatim quote proves the words
  // were said; it does not prove they say what the claim says. Without this,
  // a model can quote "I run product at Nummo" and attach object "Zeta" — a
  // real span, real words, and a fabricated fact wearing valid provenance.
  const kind = claim.objectKind ?? null;
  const objVal = kind && claim.object ? claim.object[kind] : undefined;
  if (kind === 'literal' || kind === 'quantity') {
    if (objVal === undefined || objVal === null) return fail(2, 'object-missing');
    if (!norm(quote).includes(norm(objVal)))     return fail(2, 'object-not-in-quote');
  }
  // Entity and time objects are exempt BY DESIGN and it is worth being
  // explicit: an entity object is a resolved id whose surface form need not
  // appear ("my co-founder" → Dev), and a time object is normalised in S5
  // from an expression that rarely matches the stored value ("last month" →
  // 2026-07). Enforcing ② on those would discard correct claims, so the check
  // is scoped to the two kinds where the object IS the literal text.

  // ⑥ SENSITIVE PREDICATES — before ③, so a sensitive invention is discarded
  // rather than proposed. D3: "no flag, no exception, no temporarily".
  if (isSensitivePredicate(claim.predicate)) return fail(6, 'sensitive-predicate');

  // ③ PREDICATE VOCABULARY. Registered → continue. Unknown → PROPOSE, never
  // auto-admit.
  if (!isRegistered(claim.predicate)) {
    return { outcome: OUTCOME.PROPOSE, gate: 3, reason: 'unregistered-predicate', claim: null,
      proposal: { predicate: claim.predicate, quote, segment } };
  }

  // ④ ENUMS.
  const polarity = claim.polarity ?? 'asserted';
  const modality = claim.modality ?? 'fact';
  if (!POLARITY.has(polarity)) return fail(4, `bad-polarity:${polarity}`);
  if (!MODALITY.has(modality)) return fail(4, `bad-modality:${modality}`);

  // ⑤ SUBJECT MUST BE IN THE SEGMENT, OR FIRST PERSON. Stops a claim about
  // someone who was never mentioned. First person is decided by GRAMMAR, not
  // by matching a surface form, so "self" is admitted without the segment
  // containing the word.
  const subject = String(claim.subject ?? '');
  let contextResolved = null;
  if (!FIRST_PERSON_SUBJECT.has(norm(subject)) && !seg.includes(norm(subject))) {
    // ⑤b A REFERENCE RESOLVED FROM CONTEXT (D6, 2026-10-05). "It's written in
    // Rust", "No, it's Rust", "Not Go — Rust", "the backend is Rust now" name
    // their subject by reference. The subject WAS mentioned — as "it", as part
    // of its name, or through the value it held — so the gate's purpose (no
    // claim about someone never mentioned) still holds when, and only when:
    //   · the subject is literally one the extractor was GIVEN as context
    //     (the owner's own World Model — never a new name), and
    //   · the segment contains a reference to it: a third-person pronoun, a
    //     word of its name, or a value the context attaches to it.
    contextResolved = contextReference(subject, seg, opts.contextSubjects);
    if (!contextResolved) return fail(5, 'subject-not-in-segment');
  }

  // ⑦ CONFIDENCE CEILING BY SOURCE TIER — "applied here, not by the model".
  // The model's number is an input, never the answer: a model that returns
  // 0.99 on a chat message must not outrank a document, and letting it would
  // make provenance decorative.
  const tier = opts.sourceTier ?? null;
  const ceiling = SOURCE_CEILING[tier] ?? UNKNOWN_TIER_CEILING;
  const asked = typeof opts.modelConfidence === 'number' ? opts.modelConfidence : 1;
  const confidence = Math.max(0, Math.min(asked, ceiling));

  return {
    outcome: OUTCOME.ADMIT,
    gate: null,
    reason: null,
    claim: Object.freeze({
      ...claim,
      // Provenance of a ⑤b resolution — kept in the evidence locator (L4).
      ...(contextResolved ? { contextResolved } : {}),
      confidence: Object.freeze({
        extraction: confidence,
        sourceTier: tier ?? 'unknown',
        ceiling,
        // Kept so a later audit can see the model was overruled rather than
        // wondering why its number vanished.
        modelAsked: asked,
        capped: asked > ceiling,
      }),
    }),
  };
}

/**
 * Gate ⑧ — ONE SENTENCE CANNOT ASSERT AND NEGATE THE SAME FACT (2026-10-06).
 *
 * Measured on the E6 eval (extract-v4, NVIDIA gpt-oss-20b): "Priya no longer
 * works at Aquiplex", "Sam no longer manages the support team" and "I stopped
 * commuting by metro" each came back as TWO claims from one segment — the
 * negation AND an asserted twin with the same subject, predicate and object,
 * open validity, present tense. The model misapplies rule 11 ("new value
 * asserted, old value negated") to a single value. Committed, the twin is a
 * current positive fact the user just denied (blueprint scenario 3), and the
 * eval's detection metric counted the case as handled.
 *
 * Policy, owned by code (L3): within one segment, same subject + predicate +
 * object + modality with both polarities → keep the NEGATION, discard the
 * asserted twin. The negation is the marked form in language — a sentence only
 * says "no longer"/"not"/"never" on purpose — and keeping it is the safe
 * direction (a wrongly-kept negation retires nothing on its own; a wrongly-kept
 * assertion is a fabricated current fact). The history the twin gestures at
 * ("Priya used to work there") is already the PRIOR claim, which the negation
 * supersedes with its provenance intact.
 *
 * Pure; returns { kept, discarded } so the caller records the discard.
 */
export function resolveSegmentPolarityConflicts(claims) {
  const list = Array.isArray(claims) ? claims : [];
  const keyOf = c => {
    const kind = c.objectKind ?? null;
    const obj = kind && c.object ? c.object[kind] : (c.object?.entity ?? c.object?.literal ?? '');
    return [norm(c.subject).trim(), c.predicate, norm(typeof obj === 'object' ? JSON.stringify(obj) : obj).trim(),
      c.modality ?? 'fact'].join('|');
  };
  const negatedKeys = new Set(list.filter(c => (c.polarity ?? 'asserted') === 'negated').map(keyOf));
  const kept = [], discarded = [];
  for (const c of list) {
    if ((c.polarity ?? 'asserted') === 'asserted' && negatedKeys.has(keyOf(c))) {
      discarded.push({ gate: 8, reason: 'polarity-conflict-in-segment', claim: c });
    } else kept.push(c);
  }
  return { kept, discarded };
}

/**
 * Validate a batch, reporting which gate rejected what.
 *
 * The per-gate histogram is the point: an extractor losing 30% of its output
 * to gate ① is a prompt problem, to gate ⑤ an entity problem, and to gate ③ a
 * vocabulary that is too small. One aggregate rejection rate cannot tell those
 * apart, and E6/PR-11 has to.
 */
export function validateBatch(claims, segment, opts = {}) {
  const admitted = [], proposed = [], discarded = [];
  const byGate = {};

  const passed = [];
  for (const c of Array.isArray(claims) ? claims : []) {
    const r = validateAgainstSegment(c, segment, opts);
    if (r.outcome === OUTCOME.ADMIT) passed.push(r.claim);
    else if (r.outcome === OUTCOME.PROPOSE) proposed.push(r.proposal);
    else {
      discarded.push({ gate: r.gate, reason: r.reason, claim: c });
      byGate[r.gate] = (byGate[r.gate] ?? 0) + 1;
    }
  }
  // ⑧ runs over the segment's admitted set — it is a relation between claims.
  const g8 = resolveSegmentPolarityConflicts(passed);
  admitted.push(...g8.kept);
  for (const d of g8.discarded) { discarded.push(d); byGate[8] = (byGate[8] ?? 0) + 1; }

  return {
    admitted, proposed, discarded,
    stats: {
      seen: Array.isArray(claims) ? claims.length : 0,
      admitted: admitted.length,
      proposed: proposed.length,
      discarded: discarded.length,
      byGate,
    },
  };
}
