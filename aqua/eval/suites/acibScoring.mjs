/**
 * ACIB v1 scoring — pure functions over the context blocks one turn produced
 * (2026-11-10). No I/O, no model. Definitions: AQUA_ACIB_V1_IMPLEMENTATION.md §4.
 *
 * ITEMS. The unit of context is one line the model reads as a separate piece
 * of information: a profile/identity bullet, one clause of the cognitive
 * model, one knowledge bullet, one recall excerpt (with its "since changed"
 * note attached). Instructions, headers and guidelines are not items.
 * `structured` items are Aqua's own assertions about the user (profile,
 * identity, cognitive model, graph, knowledge); recall quotes and file
 * contents are evidence, not assertions — temporal and cross-entity checks
 * judge only what Aqua asserts.
 */

export const ARMS = Object.freeze(['production', 'recall', 'memory', 'knowledge']);

const COGNITIVE_LINE = /^(Identity|Communication|Preferences|Known tech[^:]*|Active goals|Current state|Anticipated need|Related):\s*(.*)$/;
const DOCUMENT_SECTIONS = /KNOWN FILES|FILE RECALL/;

/** memoryBlock → items. */
export function memoryItems(block) {
  const items = [];
  let section = null, inGuidelines = false;
  for (const raw of String(block ?? '').split('\n')) {
    const line = raw.trimEnd();
    const open = line.match(/^---\s+(?!END\b)(.+?)(\s+\(.*\))?\s+---$/);
    if (open) { section = open[1]; inGuidelines = false; continue; }
    if (/^---\s+END\b/.test(line)) { section = null; inGuidelines = false; continue; }
    if (!section) continue;
    if (/^Guidelines:/.test(line)) { inGuidelines = true; continue; }
    if (inGuidelines) continue;
    if (/COGNITIVE MODEL/.test(section)) {
      const m = line.match(COGNITIVE_LINE);
      if (!m) continue;
      const parts = m[1] === 'Current state' ? m[2].split(' | ') : m[1] === 'Active goals' ? m[2].split('; ') : [m[2]];
      for (const p of parts) if (p.trim()) items.push({ lane: 'memory', text: `${m[1]}: ${p.trim()}`, structured: true });
      continue;
    }
    if (/^\s*-\s+/.test(line)) items.push({ lane: 'memory', text: line.replace(/^\s*-\s+/, ''), structured: !DOCUMENT_SECTIONS.test(section) });
  }
  return items;
}

/** knowledgeContext (PIC / Context Engine) → items. */
export function knowledgeItems(block) {
  return String(block ?? '').split('\n').filter(l => /^\s*[•·]\s+/.test(l))
    .map(l => ({ lane: 'knowledge', text: l.replace(/^\s*[•·]\s+/, '').trim(), structured: true }));
}

/** Recall block → one item per excerpt, its indented notes attached. */
export function recallItems(block) {
  const items = [];
  for (const line of String(block ?? '').split('\n')) {
    if (/^\[/.test(line)) items.push({ lane: 'recall', text: line, structured: false });
    else if (/^\s+↳/.test(line) && items.length) items.at(-1).text += ` ${line.trim()}`;
  }
  return items;
}

export function armItems(blocks) {
  const memory = memoryItems(blocks.memory), knowledge = knowledgeItems(blocks.knowledge), recall = recallItems(blocks.recall);
  return { production: [...memory, ...knowledge, ...recall], memory, knowledge, recall };
}

const rx = list => (list ?? []).map(s => new RegExp(s, 'i'));
const anyMatch = (patterns, text) => patterns.some(r => r.test(text));
const ANNOTATED = /previously|since changed|no longer|none current|now:|they said|given up|not current|ended|retired|replaced|uncertain/i;
const CONFLICT = /conflict|contradict|disagree|inconsistent|contested|disputed|differ/i;
const UNKNOWN = /not known|unknown|not stated|no record|never (said|stated|told)|not available|was not given|isn't known/i;

/**
 * Score one arm's items against one scenario. Returns per-metric values; a
 * metric that does not apply to the scenario is null (excluded from means).
 */
export function scoreArm(scenario, items) {
  const needs = scenario.needs ?? [];
  const required = needs.filter(n => n.required);
  const needRx = needs.map(n => ({ ...n, m: rx(n.match), e: rx(n.evidence) }));
  const distractorRx = (scenario.distractors ?? []).map(d => ({ ...d, m: rx(d.match) }));
  const isRelevant = it => needRx.some(n => anyMatch(n.m, it.text));
  const relevant = items.filter(isRelevant);
  const irrelevant = items.filter(it => !isRelevant(it));
  const chars = items.reduce((n, it) => n + it.text.length, 0);
  const relChars = relevant.reduce((n, it) => n + it.text.length, 0);

  const found = needRx.filter(n => n.required && items.some(it => anyMatch(n.m, it.text)));
  const evidenced = needRx.filter(n => n.required && items.some(it => anyMatch(n.e, it.text)));

  const out = {
    items: items.length,
    context_precision: items.length ? relevant.length / items.length : (required.length ? 0 : 1),
    context_recall: required.length ? found.length / required.length : null,
    evidence_coverage: required.length ? evidenced.length / required.length : null,
    context_efficiency: chars ? relChars / chars : (required.length ? 0 : 1),
    irrelevant_items: irrelevant.length,
    irrelevant_chars: chars - relChars,
    distractor_items: irrelevant.filter(it => distractorRx.some(d => anyMatch(d.m, it.text))).length,
    critical_missing: required.length - found.length,
    missing_needs: needRx.filter(n => n.required && !found.includes(n)).map(n => n.id),
    found_needs: found.map(n => n.id),
  };
  out.critical_miss_with_noise = out.critical_missing > 0 && out.irrelevant_items > 0 ? 1 : 0;

  if (scenario.temporal) {
    const cur = rx(scenario.temporal.current), stale = rx(scenario.temporal.stale);
    const currentFound = items.some(it => anyMatch(cur, it.text));
    const staleAsCurrent = items.filter(it => it.structured && anyMatch(stale, it.text) && !ANNOTATED.test(it.text)).length;
    out.stale_as_current = staleAsCurrent;
    out.temporal_accuracy = currentFound && staleAsCurrent === 0 ? 1 : 0;
  } else { out.stale_as_current = null; out.temporal_accuracy = null; }

  if (scenario.contradiction) {
    const a = rx(scenario.contradiction.a), b = rx(scenario.contradiction.b);
    const visible = items.some(it => anyMatch(a, it.text)) && items.some(it => anyMatch(b, it.text));
    const flagged = items.some(it => (anyMatch(a, it.text) || anyMatch(b, it.text)) && CONFLICT.test(it.text));
    out.contradiction_handling = flagged ? 1 : visible ? 0.5 : 0;
  } else out.contradiction_handling = null;

  if (scenario.unknowns?.length) {
    const handled = scenario.unknowns.filter(u => items.some(it => anyMatch(rx(u.match), it.text) && UNKNOWN.test(it.text)));
    out.unknown_handling = handled.length / scenario.unknowns.length;
  } else out.unknown_handling = null;

  if (scenario.crossEntity?.length) {
    const forbid = scenario.crossEntity.flatMap(c => rx(c.forbid));
    const violations = items.filter(it => it.structured && anyMatch(forbid, it.text)).length;
    out.cross_entity_violations = violations;
    out.cross_entity_accuracy = violations === 0 ? 1 : 0;
  } else { out.cross_entity_violations = null; out.cross_entity_accuracy = null; }

  out.forgotten_leaks = scenario.forgotten?.length ? items.filter(it => anyMatch(rx(scenario.forgotten), it.text)).length : null;
  out.failed_turn_leaks = scenario.failedTurn?.length ? items.filter(it => anyMatch(rx(scenario.failedTurn), it.text)).length : null;
  out.personal_items_on_impersonal = required.length === 0 && !scenario.forgotten && !scenario.failedTurn ? items.length : null;
  return out;
}

/** Planner (plan-only): share of required needs the question plan asks for at all. */
export function scorePlanner(scenario, planner) {
  const required = (scenario.needs ?? []).filter(n => n.required);
  if (!required.length) return { planner_need_coverage: null, planner_task: planner.taskType };
  const covered = required.filter(n => (n.slots ?? []).some(s => planner.slots.includes(s)));
  return { planner_need_coverage: covered.length / required.length, planner_task: planner.taskType, planner_uncovered: required.filter(n => !covered.includes(n)).map(n => n.id) };
}

const NUMERIC_MEAN = ['context_precision', 'context_recall', 'evidence_coverage', 'context_efficiency', 'temporal_accuracy', 'contradiction_handling', 'unknown_handling', 'cross_entity_accuracy'];
const NUMERIC_SUM = ['irrelevant_items', 'irrelevant_chars', 'distractor_items', 'critical_missing', 'critical_miss_with_noise', 'stale_as_current', 'cross_entity_violations', 'forgotten_leaks', 'failed_turn_leaks', 'personal_items_on_impersonal'];
const mean = xs => { const v = xs.filter(x => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const sum = xs => { const v = xs.filter(x => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
const round = x => (x === null ? null : Math.round(x * 10000) / 10000);

/**
 * Flat metric map for the gate: `<arm>_<regime>_<metric>` (means for rates,
 * sums for error counts), the critical scenario separately as
 * `critical_<arm>_<regime>_<metric>`, and the planner as `planner_<regime>_need_coverage`.
 */
export function aggregate(scored) {
  const ok = scored.filter(s => s && s.arms);   // the runner passes score() results of executed cases
  const metrics = { cases_scored: ok.length };
  for (const regime of ['short', 'long']) {
    const R = ok.filter(s => s.regime === regime);
    for (const arm of ARMS) {
      const rows = R.map(s => s.arms[arm]);
      for (const k of NUMERIC_MEAN) { const v = round(mean(rows.map(r => r[k]))); if (v !== null) metrics[`${arm}_${regime}_${k}`] = v; }
      for (const k of NUMERIC_SUM) { const v = sum(rows.map(r => r[k])); if (v !== null) metrics[`${arm}_${regime}_${k}`] = v; }
      const crit = R.filter(s => s.critical).map(s => s.arms[arm]);
      if (crit.length) {
        for (const k of ['context_precision', 'context_recall', 'evidence_coverage', 'context_efficiency']) metrics[`critical_${arm}_${regime}_${k}`] = round(mean(crit.map(r => r[k])));
        for (const k of ['critical_missing', 'irrelevant_items', 'distractor_items', 'critical_miss_with_noise']) metrics[`critical_${arm}_${regime}_${k}`] = sum(crit.map(r => r[k]));
      }
    }
    const p = round(mean(R.map(s => s.planner.planner_need_coverage)));
    if (p !== null) metrics[`planner_${regime}_need_coverage`] = p;
    metrics[`${regime}_network_attempts`] = sum(R.map(s => s.networkBlocked)) ?? 0;
  }
  return metrics;
}
