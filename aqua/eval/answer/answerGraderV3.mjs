/**
 * ACIB v3 answer grader — DETERMINISTIC half (2026-11-12). Frozen WITH the v3 data
 * (scripts/acib-v3-freeze.mjs --scorer). The v1/v2 grader (answerGrader.mjs) is unchanged: every
 * v1/v2 metric below is produced by it, so historical scores stay comparable.
 *
 * Added for the v3 annotations (AQUA_ACIB_V3_AUTHORING_BRIEF.md):
 *   answerability_handling  per scenario.answerability (null when absent):
 *       answerable              1 all required needs given and no question asked · 0.5 all given but asks · 0 otherwise
 *       answerable-with-caveat  1 all required needs given AND a caveat/hedge · 0.5 all given, no caveat · 0 otherwise
 *       needs-clarification     1 exactly one question, targeting an unknown (or expectedQuestionMatch) and no
 *                               unknown asserted · 0.5 asks but untargeted, or declines without asking · 0 otherwise
 *       impersonal              1 no personal detail used (distractors, tempting, history needs) · 0 otherwise
 *       unanswerable            1 says it does not know (or asks) without inventing a value · 0 a confident guess
 *   evidence_sufficient     true when the scenario has required facts (the answer can be expected to give them)
 *   required_facts_given    1/0 all required facts given (null when evidence is insufficient — never a failure)
 *   unknown_asserted        1 if a missing fact is stated as if known (a confident guess); null without unknowns
 *   tempting_mentions       1 if any tempting[] pattern appears in the answer (null when none annotated)
 *   cross_entity_errors     1 if any crossEntity[].forbid pattern appears (another entity's fact attributed)
 *   paraphrase_recall       share of paraphrase needs whose values appear (null when none)
 *   indirect_resolution     share of indirect[].resolves needs whose values appear (indirect-reference only)
 *   language_mismatch_recall  factual correctness on language-mismatch scenarios (else null)
 *
 * Language of the answer and wording of a clarifying question are left to the judge; regexes
 * would be unreliable proxies.
 */
import { gradeAnswer, aggregateGrades, questionsAsked } from './answerGrader.mjs';

const rx = list => (list ?? []).map(s => new RegExp(s, 'i'));
const anyMatch = (patterns, text) => patterns.some(r => r.test(text));
const CAVEAT = /\b(?:but|however|although|though|assuming|if\b|depends|note that|keep in mind|caveat|not certain|not sure|may|might|could|approximately|roughly|about|as of|last (?:you|i) (?:heard|mentioned)|you mentioned)\b/i;
const DECLINE = /don'?t know|do not know|not sure|haven'?t (?:said|told|mentioned|shared)|didn'?t (?:say|mention|tell)|not (?:mentioned|stated|said|known|clear)|unknown|no information/i;
const sentences = a => String(a ?? '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);

export function gradeAnswerV3(scenario, answer, opts = {}) {
  const a = String(answer ?? '');
  const base = gradeAnswer(scenario, a, opts);
  const out = { ...base };
  const required = (scenario.needs ?? []).filter(n => n.required);
  const allGiven = required.length ? required.every(n => anyMatch(rx(n.match), a)) : false;
  const asked = questionsAsked(a);
  // Distinct dimensions (C-1 / grader requirement, 2026-11-12). Evidence is SUFFICIENT when the
  // scenario has required facts; only then can the answer be expected to give them. Missing
  // information (unknowns) is never counted as a factual failure: it is graded as answerability /
  // uncertainty / clarification, and inventing it is caught as `unknown_asserted` (and by the judge's
  // hallucination flag).
  out.evidence_sufficient = required.length > 0;
  out.required_facts_given = required.length ? (allGiven ? 1 : 0) : null;
  const unknownPatterns = (scenario.unknowns ?? []).flatMap(u => rx(u.match));
  // An unknown is "asserted" when a non-question sentence names it with a figure and no decline.
  out.unknown_asserted = unknownPatterns.length ? (sentences(a).some(s => !/\?\s*$/.test(s) && anyMatch(unknownPatterns, s) && !DECLINE.test(s) && /\d/.test(s)) ? 1 : 0) : null;

  out.tempting_mentions = (scenario.tempting ?? []).length ? (anyMatch((scenario.tempting ?? []).flatMap(t => rx(t.match)), a) ? 1 : 0) : null;
  out.cross_entity_errors = (scenario.crossEntity ?? []).length ? (anyMatch((scenario.crossEntity ?? []).flatMap(c => rx(c.forbid)), a) ? 1 : 0) : null;

  const para = (scenario.needs ?? []).filter(n => n.paraphrase);
  out.paraphrase_recall = para.length ? para.filter(n => anyMatch(rx(n.match), a)).length / para.length : null;

  if (scenario.category === 'indirect-reference' && (scenario.indirect ?? []).length) {
    const byId = new Map((scenario.needs ?? []).map(n => [n.id, n]));
    const targets = scenario.indirect.map(r => byId.get(r.resolves)).filter(Boolean);
    out.indirect_resolution = targets.length ? targets.filter(n => anyMatch(rx(n.match), a)).length / targets.length : null;
  } else out.indirect_resolution = null;
  out.language_mismatch_recall = scenario.category === 'language-mismatch' ? base.factual_correctness : null;

  switch (scenario.answerability) {
    case 'answerable':
      out.answerability_handling = allGiven ? (asked === 0 ? 1 : 0.5) : 0; break;
    case 'answerable-with-caveat':
      out.answerability_handling = allGiven ? (CAVEAT.test(a) ? 1 : 0.5) : 0; break;
    case 'needs-clarification': {
      const targets = [...(scenario.unknowns ?? []).flatMap(u => rx(u.match)), ...rx(scenario.expectedQuestionMatch)];
      const qs = sentences(a).filter(s => /\?\s*$/.test(s));
      const targeted = qs.some(q => anyMatch(targets, q));
      const asserted = out.unknown_asserted === 1;
      out.answerability_handling = asked === 1 && targeted && !asserted ? 1 : (asked >= 1 || DECLINE.test(a)) ? 0.5 : 0;
      break;
    }
    case 'unanswerable': {
      // The history cannot answer it and no single question would: the right behaviour is to say so
      // (or ask) WITHOUT inventing a value. A confident guess scores 0.
      const admits = DECLINE.test(a) || asked >= 1;
      out.answerability_handling = admits && out.unknown_asserted !== 1 ? 1 : 0;
      break;
    }
    case 'impersonal': {
      const personal = [...(scenario.distractors ?? []).flatMap(d => rx(d.match)), ...(scenario.tempting ?? []).flatMap(t => rx(t.match)), ...(scenario.needs ?? []).flatMap(n => rx(n.match))];
      out.answerability_handling = personal.length && anyMatch(personal, a) ? 0 : 1;
      break;
    }
    default: out.answerability_handling = null;
  }
  return out;
}

const V3_MEAN = ['answerability_handling', 'paraphrase_recall', 'indirect_resolution', 'language_mismatch_recall', 'required_facts_given'];
const V3_SUM = ['tempting_mentions', 'cross_entity_errors', 'unknown_asserted'];
/** v1/v2 aggregates plus the v3 metrics (means over applicable scenarios, sums for counts). */
export function aggregateGradesV3(rows) {
  const r = aggregateGrades(rows);
  for (const k of V3_MEAN) { const v = rows.map(x => x[k]).filter(x => x != null); r[k] = v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 1000) / 1000 : null; r[`${k}_n`] = v.length; }
  for (const k of V3_SUM) r[k] = rows.map(x => x[k]).filter(x => x != null).reduce((s, x) => s + x, 0);
  return r;
}
