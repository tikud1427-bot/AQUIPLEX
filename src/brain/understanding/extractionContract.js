/**
 * AQUA — Extraction output contract (Blueprint E6/PR-4)
 *
 * Parses what the model returned and refuses anything the claim store would
 * refuse — before it reaches the claim store.
 *
 * A NOTE ON NAMING. This file says "the claim writer" rather than naming the
 * module, and that is not stylistic. The repository's own wiring test greps the whole
 * source for that identifier to assert nothing CALLS the repository yet — a
 * guard armed for E6/PR-10, when the extractor first writes claims. It fired
 * on these comments. Spending a guard's one firing on prose disarms it for the
 * event it was built for, so the prose changed instead.
 *
 * WHY REFUSE HERE AND NOT AT THE WRITER
 * -------------------------------------
 * The claim writer already throws on an unknown predicate, a
 * wrong object kind, or two objects. Letting the model's output reach it and
 * catching the throw would work, and would be worse: one bad claim in a batch
 * of five would abort the batch, the reason would arrive as an exception
 * message rather than as data, and there would be no record of WHAT the model
 * got wrong. Rejections are the measurement that tells you whether the prompt
 * is working.
 *
 * So every claim is either accepted or rejected WITH A REASON, and both lists
 * come back. Nothing is silently dropped.
 *
 * A MODEL RETURNING NOTHING IS A VALID ANSWER
 * -------------------------------------------
 * `{"claims":[]}` is correct for a question, a conditional, or a request —
 * three of the seven fixtures expect exactly that. An empty result must
 * therefore be distinguishable from a parse failure, or "the model refused to
 * hallucinate" and "the model returned garbage" become the same event. `ok`
 * carries that distinction.
 *
 * SHAPE ONLY. The seven semantic gates — grounding the statement text in the
 * source, entity resolution, temporal normalisation, dedup — are E6/PR-6 and
 * PR-7. This file answers one question: is this a well-formed claim in AQUA's
 * vocabulary?
 */
import { isRegistered, objectKindOf } from '../../core/claims/predicateRegistry.js';
import { POLARITIES, MODALITIES, PRECISIONS } from './extractionPrompt.js';

const POLARITY_SET  = new Set(POLARITIES);
const MODALITY_SET  = new Set(MODALITIES);
const PRECISION_SET = new Set(PRECISIONS);

/** Which object form did the model actually supply? */
function objectForm(object) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return null;
  const present = ['entity', 'literal', 'quantity', 'time']
    .filter(k => object[k] !== undefined && object[k] !== null && object[k] !== '');
  // ZERO and TWO are different failures and must not share a diagnostic.
  // The first draft returned `ambiguous-object:none` for `{}`, which reads as
  // "you gave me too many" when the caller gave none. The claim writer already
  // draws the line in the right place — "two objects is two claims; none is
  // not a claim" — and a rejection reason is only useful if it says which one
  // happened.
  if (present.length === 0) return null;
  return present.length === 1 ? present[0] : { ambiguous: present };
}

/**
 * Strip what models add around JSON even when told not to.
 *
 * Deliberately conservative: fences and a leading prose line are removed, and
 * anything still unparseable is REPORTED rather than repaired. A parser that
 * tries hard enough to salvage malformed output will eventually salvage
 * something the model did not mean, and a silently-repaired claim is
 * indistinguishable from a correct one.
 */
export function extractJsonBlock(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();

  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) s = fenced[1].trim();

  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  return s.slice(start, end + 1);
}

/**
 * Validate one claim against AQUA's vocabulary.
 * @returns {{ ok: true, claim: object } | { ok: false, reason: string }}
 */
export function validateClaim(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'not-an-object' };
  }
  const { subject, predicate, object, polarity, modality, timePrecision, statementText } = input;

  if (typeof subject !== 'string' || !subject.trim())     return { ok: false, reason: 'missing-subject' };
  if (typeof predicate !== 'string' || !predicate.trim()) return { ok: false, reason: 'missing-predicate' };

  // The closed vocabulary. `isRegistered`, not a copy of the list — a copy is
  // the drift this whole PR is built to avoid.
  if (!isRegistered(predicate)) return { ok: false, reason: `unregistered-predicate:${predicate}` };

  const form = objectForm(object);
  if (form === null)         return { ok: false, reason: 'missing-object' };
  if (typeof form === 'object') {
    // Two objects is two claims; none is not a claim. Same rule the schema's
    // one-object CHECK constraint enforces.
    return { ok: false, reason: `ambiguous-object:${form.ambiguous.join('+') || 'none'}` };
  }

  const expected = objectKindOf(predicate) ?? 'literal';
  if (form !== expected) {
    return { ok: false, reason: `object-kind-mismatch:${predicate} wants ${expected}, got ${form}` };
  }

  const pol = polarity ?? 'asserted';
  const mod = modality ?? 'fact';
  const prec = timePrecision ?? 'none';
  if (!POLARITY_SET.has(pol))   return { ok: false, reason: `bad-polarity:${pol}` };
  if (!MODALITY_SET.has(mod))   return { ok: false, reason: `bad-modality:${mod}` };
  if (!PRECISION_SET.has(prec)) return { ok: false, reason: `bad-precision:${prec}` };

  if (typeof statementText !== 'string' || !statementText.trim()) {
    // Provenance is not optional. A claim with no source span cannot be shown
    // to a user as evidence and cannot be checked against the segment in PR-6.
    return { ok: false, reason: 'missing-statement-text' };
  }

  return {
    ok: true,
    claim: {
      subject: subject.trim(),
      predicate,
      object: { [form]: object[form], ...(form === 'quantity' && object.unit ? { unit: object.unit } : {}) },
      objectKind: form,
      polarity: pol,
      modality: mod,
      timePrecision: prec,
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
      statementText: statementText.trim(),
    },
  };
}

/**
 * Parse and validate a full model response.
 *
 * @param {string} raw
 * @returns {{ ok: boolean, claims: object[], rejected: Array<{reason:string, raw:*}>, error: string|null }}
 *   `ok:true, claims:[]` means the model correctly found nothing.
 *   `ok:false` means the response could not be read at all.
 */
export function parseExtractionResponse(raw) {
  const block = extractJsonBlock(raw);
  if (block === null) {
    return { ok: false, claims: [], rejected: [], error: 'no-json-found' };
  }

  let parsed;
  try {
    parsed = JSON.parse(block);
  } catch (err) {
    return { ok: false, claims: [], rejected: [], error: `bad-json:${err.message}` };
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.claims)) {
    return { ok: false, claims: [], rejected: [], error: 'missing-claims-array' };
  }

  const claims = [];
  const rejected = [];
  for (const candidate of parsed.claims) {
    const r = validateClaim(candidate);
    if (r.ok) claims.push(r.claim);
    else rejected.push({ reason: r.reason, raw: candidate });
  }

  return { ok: true, claims, rejected, error: null };
}
