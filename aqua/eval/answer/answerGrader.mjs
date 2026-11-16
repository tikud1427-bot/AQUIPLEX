/**
 * Answer-level grading (Sprint 4, 2026-11-11) — DETERMINISTIC half.
 *
 * Grades a model's ANSWER against an ACIB scenario's frozen annotations. This is
 * separate from the context-level scorer (eval/suites/acibScoring.mjs), which
 * grades what the model RECEIVED. Same annotations, different object.
 *
 * Deterministic checks are conservative proxies; the independent judge
 * (judgeRubric.md) grades what regexes cannot. Each metric is null when it does
 * not apply to the scenario, so means are over applicable scenarios only.
 *
 *   factual_correctness   required needs whose values appear in the answer / required needs
 *   temporal_accuracy     1 if the current value appears and no stale value is asserted as current
 *   contradiction_handling 1 if the conflict is named (or both values given with a conflict word); 0.5 if both values only
 *   uncertainty_handling  share of unknowns the answer declines to assert (says it is unknown or asks)
 *   clarification_quality 1 if it asks at most one question when information is missing, and none is needed otherwise
 *   ungrounded_figures    figures in the answer found nowhere in the history, files or question (hallucination proxy)
 *   personal_leaks        personal details used on an impersonal question (distractors on needs-free scenarios)
 *   distractor_mentions   distractor details mentioned on personal questions
 */
const rx = list => (list ?? []).map(s => new RegExp(s, 'i'));
const anyMatch = (patterns, text) => patterns.some(r => r.test(text));
const CONFLICT = /conflict|contradict|disagree|inconsistent|differ|two different|doesn'?t match|do not match|don'?t match|mismatch|either .* or|which (?:one )?is (?:right|correct)/i;
const DECLINE = /don'?t know|do not know|not sure|haven'?t (?:said|told|mentioned|shared)|didn'?t (?:say|mention|tell)|not (?:mentioned|stated|said|known|clear)|unknown|no information|could you (?:tell|share|let me know)|can you (?:tell|share)|what (?:is|are) your|how much (?:do|have|would|could) you|would you (?:mind )?(?:tell|share)|depends on/i;
const STALE_OK = /previously|used to|no longer|before|earlier|was\b|were\b|changed|switched|moved from|instead of|not anymore|anymore|old\b|replaced/i;

/** Questions the answer asks the user (sentences ending in "?"). */
export function questionsAsked(answer) {
  return String(answer ?? '').split(/(?<=[.!?])\s+/).filter(s => /\?\s*$/.test(s.trim())).length;
}

/** Figures in a text: 1,200 / 3.5k / 40k / 12 / $49 → normalised digits(+k). */
function figures(text) {
  return [...String(text ?? '').matchAll(/[$€£]?\s?\d[\d,]*(?:\.\d+)?\s?k?\b/gi)]
    .map(m => m[0].toLowerCase().replace(/[$€£\s,]/g, ''))
    .filter(f => /\d{2,}|k$/.test(f));
}

/** Grade one answer. `sources` = all text the user gave (history + files + question). */
export function gradeAnswer(scenario, answer, { sources = '' } = {}) {
  const a = String(answer ?? '');
  const needs = (scenario.needs ?? []).filter(n => n.required);
  const out = {};

  out.factual_correctness = needs.length ? needs.filter(n => anyMatch(rx(n.match), a)).length / needs.length : null;

  if (scenario.temporal) {
    const cur = anyMatch(rx(scenario.temporal.current), a);
    // A stale value is "asserted as current" when it appears in a sentence with no past/change marker.
    const staleAsserted = a.split(/(?<=[.!?])\s+/).some(s => anyMatch(rx(scenario.temporal.stale), s) && !STALE_OK.test(s));
    out.temporal_accuracy = cur && !staleAsserted ? 1 : 0;
    out.stale_asserted = staleAsserted ? 1 : 0;
  } else { out.temporal_accuracy = null; out.stale_asserted = null; }

  if (scenario.contradiction) {
    const both = anyMatch(rx(scenario.contradiction.a), a) && anyMatch(rx(scenario.contradiction.b), a);
    out.contradiction_handling = both && CONFLICT.test(a) ? 1 : both ? 0.5 : CONFLICT.test(a) ? 0.5 : 0;
  } else out.contradiction_handling = null;

  if (scenario.unknowns?.length) {
    // Handled = the answer names the unknown and declines to assert it (says it is not known, or asks).
    const handled = scenario.unknowns.filter(u => a.split(/(?<=[.!?])\s+/).some(s => anyMatch(rx(u.match), s) && (DECLINE.test(s) || /\?\s*$/.test(s))));
    out.uncertainty_handling = handled.length / scenario.unknowns.length;
  } else out.uncertainty_handling = null;

  const asked = questionsAsked(a);
  const infoMissing = !!(scenario.unknowns?.length || scenario.contradiction);
  out.questions_asked = asked;
  out.clarification_quality = needs.length || infoMissing ? (infoMissing ? (asked <= 1 ? 1 : 0) : (asked === 0 ? 1 : 0.5)) : null;

  const known = new Set(figures(`${sources}\n${scenario.question}`));
  out.ungrounded_figures = figures(a).filter(f => !known.has(f) && !known.has(f.replace(/k$/, '000'))).length;

  const distractors = (scenario.distractors ?? []).flatMap(d => rx(d.match));
  if (!needs.length) { out.personal_leaks = distractors.length && anyMatch(distractors, a) ? 1 : 0; out.distractor_mentions = null; }
  else { out.personal_leaks = null; out.distractor_mentions = distractors.length && anyMatch(distractors, a) ? 1 : 0; }

  out.personalization = needs.length ? out.factual_correctness : null;
  return out;
}

const MEAN = ['factual_correctness', 'temporal_accuracy', 'contradiction_handling', 'uncertainty_handling', 'clarification_quality', 'personalization'];
const SUM = ['stale_asserted', 'ungrounded_figures', 'personal_leaks', 'distractor_mentions', 'questions_asked'];
/** Aggregate per-scenario grades: means over applicable scenarios, sums for counts. */
export function aggregateGrades(rows) {
  const r = {};
  for (const k of MEAN) { const v = rows.map(x => x[k]).filter(x => x != null); r[k] = v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 1000) / 1000 : null; r[`${k}_n`] = v.length; }
  for (const k of SUM) r[k] = rows.map(x => x[k]).filter(x => x != null).reduce((s, x) => s + x, 0);
  return r;
}
