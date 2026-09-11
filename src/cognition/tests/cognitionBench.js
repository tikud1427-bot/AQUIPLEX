/**
 * AQUA Cognitive Intelligence Engine — Benchmark & Stress Harness (CIE Phase 2)
 *
 * Run: npm run bench:cognition          (aqua/ package)
 *
 * The spec's TESTING section, executable: "Benchmark simple QA, complex
 * reasoning, cross-file reasoning, large repositories, scientific reasoning,
 * coding, mixed media, edge cases, low confidence, missing evidence. Stress
 * test planning quality."
 *
 *   A. PLANNING QUALITY   the 10 spec categories — for each, synthetic turns
 *                          are pushed through questionModel → strategySelector
 *                          → reasoningPlanner and the resulting executive plan
 *                          is asserted against category invariants
 *   B. MONITOR QUALITY    precision (clean drafts must NOT trip findings or
 *                          escalation) and recall (each structural failure
 *                          signature must be caught), plus escalation
 *                          semantics (only ADDS review) and stream parity
 *   C. LEARNING           convergence at exactly the sample gate, the margin
 *                          gate, and the evidence-safety gate — the loop that
 *                          lets future planning reuse successful strategies
 *   D. PERFORMANCE        wall-time budgets: warm/cold plan builds, cache
 *                          reuse rate, monitor / confidence / question-model
 *                          throughput ("minimize unnecessary reasoning")
 *
 * Deterministic apart from wall-time: no LLM calls, no network, no disk
 * writes (store persistence off). Exit code 1 on any failed check, so it can
 * gate CI exactly like the unit suites.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-cie-bench-'));
process.env.AQUA_DATA_DIR = TMP;
delete process.env.AQUA_CIE;   // default: enabled

const QM  = await import('../questionModel.js');
const SS  = await import('../strategySelector.js');
const RP  = await import('../reasoningPlanner.js');
const CC  = await import('../cognitiveConfidence.js');
const RM  = await import('../reasoningMonitor.js');
const RE  = await import('../reflectionEngine.js');
const CS  = await import('../cognitiveStore.js');
const CIE = await import('../index.js');

CIE._resetCIEForTests();   // metrics + plan cache + store, persistence OFF

// ── Harness ──────────────────────────────────────────────────────────────────

const sections = [];
let current = null;
let totalPass = 0;
let totalFail = 0;

function section(name) {
  current = { name, pass: 0, fail: 0, failures: [] };
  sections.push(current);
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 72 - name.length))}`);
}

function check(name, cond, detail = '') {
  if (cond) {
    current.pass += 1; totalPass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    current.fail += 1; totalFail += 1;
    current.failures.push({ name, detail });
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** questionModel → strategySelector → reasoningPlanner, exactly the facade's path. */
function planFor(message, {
  taskType = 'analysis', complexity = 'medium', confidence = 0.9,
  hasWorkspace = false, hasOwner = true, styleId = null,
} = {}) {
  const question  = QM.assessQuestion(message, { taskType, confidence, hasWorkspace, hasOwner });
  const selection = styleId
    ? { style: SS.COGNITIVE_STYLES[styleId], source: 'bench', reason: 'forced by bench' }
    : SS.selectCognitiveStyle({ taskType, complexity, question });
  return RP.buildReasoningPlan({ question, selection, taskType, complexity, confidence });
}

const pct = (n) => `${(n * 100).toFixed(1)}%`;
function percentile(sortedMicros, p) {
  if (!sortedMicros.length) return 0;
  return sortedMicros[Math.min(sortedMicros.length - 1, Math.floor(sortedMicros.length * p))];
}
function timeLoop(n, fn) {
  const micros = [];
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    fn(i);
    micros.push(Number(process.hrtime.bigint() - t0) / 1000);
  }
  micros.sort((a, b) => a - b);
  const total = micros.reduce((a, b) => a + b, 0);
  return {
    n,
    meanUs: total / n,
    p50Us: percentile(micros, 0.50),
    p95Us: percentile(micros, 0.95),
    perSec: Math.round(n / (total / 1e6)),
  };
}

console.log('AQUA Cognitive Intelligence Engine — bench (CIE Phase 2)');
console.log(`node ${process.version} · data dir ${TMP} · persistence OFF`);

// ═════════════════════════════════════════════════════════════════════════════
// A. PLANNING QUALITY — the spec's 10 benchmark categories
// ═════════════════════════════════════════════════════════════════════════════

// ── 1. Simple QA — casual traffic must stay byte-light ───────────────────────
section('A1 · simple QA');
{
  RP._clearPlanCacheForTests();
  for (const [msg, taskType] of [
    ['What is the capital of France?', 'simple_qa'],
    ['hey how are you today', 'conversation'],
    ['Thanks!', 'conversation'],
  ]) {
    const p = planFor(msg, { taskType, complexity: 'low', confidence: 0.95 });
    check(`fast style for "${msg.slice(0, 30)}"`, p.style.id === 'fast', `got ${p.style.id}`);
    check('  shallow depth', p.depth === 'shallow', p.depth);
    check('  empty directive (zero prompt cost)', p.directive === '', `"${p.directive.slice(0, 40)}"`);
    check('  no clarification', !p.expectations.clarification.recommended);
    check('  no knowledge retrieval expected', !p.expectations.retrieval.knowledge);
  }
}

// ── 2. Complex reasoning — hard questions never reason shallow ───────────────
section('A2 · complex reasoning');
{
  const p = planFor(
    'Evaluate whether moving our billing reconciliation from nightly batch jobs to event-driven processing would reduce settlement discrepancies, considering ordering guarantees, idempotency, and partial-failure recovery.',
    { taskType: 'reasoning', complexity: 'high', confidence: 0.85 },
  );
  check('analytical family selected', ['analytical', 'comparative', 'architectural'].includes(p.style.id), p.style.id);
  check('depth promoted to deep under high complexity', p.depth === 'deep', p.depth);
  check('directive present and bounded', p.directive.length > 0 && p.directive.length <= RP.DIRECTIVE_MAX_CHARS, `${p.directive.length} chars`);
  check('uncertainty at least expressed', ['express', 'quantify'].includes(p.expectations.uncertainty), p.expectations.uncertainty);

  const low = planFor('Compare our two retry strategies briefly.', { taskType: 'analysis', complexity: 'low', confidence: 0.9 });
  check('low-tier turns never pay deep cost', low.depth !== 'deep', low.depth);
}

// ── 3. Cross-file reasoning ──────────────────────────────────────────────────
section('A3 · cross-file reasoning');
{
  const p = planFor(
    'Compare the assumptions across the files and tell me which file supports the Q3 revenue claim.',
    { taskType: 'analysis', complexity: 'medium', confidence: 0.9 },
  );
  check('language hint wins → cross_file', p.style.id === 'cross_file' && p.style.source === 'hint', `${p.style.id}/${p.style.source}`);
  check('evidence required', p.expectations.evidence === 'require', p.expectations.evidence);
  check('broaden-on-empty armed', p.expectations.retrieval.broadenOnEmpty === true);
  check('deep reasoning', p.depth === 'deep', p.depth);
  check('verification encouraged', p.expectations.verification === 'encourage', p.expectations.verification);
}

// ── 4. Large repositories — workspace anchors the references ─────────────────
section('A4 · large repositories');
{
  const anchored = QM.assessQuestion(
    'Explain how the auth middleware in the code interacts with the session store.',
    { taskType: 'project_query', confidence: 0.9, hasWorkspace: true, hasOwner: true },
  );
  check('workspace anchors "the code" (no unanchored_reference)', !anchored.ambiguity.signals.includes('unanchored_reference'), anchored.ambiguity.signals.join(','));

  const p = planFor(
    'Explain the responsibilities of the services layer in the codebase and its main seams.',
    { taskType: 'project_query', complexity: 'high', confidence: 0.9, hasWorkspace: true },
  );
  check('architectural style for repo questions', p.style.id === 'architectural', p.style.id);
  check('deep depth at high complexity', p.depth === 'deep', p.depth);
  check('grounding task ⇒ evidence required', p.expectations.evidence === 'require', p.expectations.evidence);
  check('knowledge retrieval expected', p.expectations.retrieval.knowledge === true);
  check('no clarification on a well-posed repo question', !p.expectations.clarification.recommended);

  const rw = planFor(
    'Trace the upload flow across the repo and name every module that touches it.',
    { taskType: 'project_query', complexity: 'high', confidence: 0.9, hasWorkspace: true },
  );
  check('repo-wide phrasing upgrades to cross_file', rw.style.id === 'cross_file', rw.style.id);
}

// ── 5. Scientific reasoning ──────────────────────────────────────────────────
section('A5 · scientific reasoning');
{
  const p = planFor(
    'Does the study show the mechanism of action is replicable, and are the p-value thresholds defensible?',
    { taskType: 'research', complexity: 'medium', confidence: 0.9 },
  );
  check('scientific style via language hint', p.style.id === 'scientific' && p.style.source === 'hint', `${p.style.id}/${p.style.source}`);
  check('uncertainty quantified', p.expectations.uncertainty === 'quantify', p.expectations.uncertainty);
  check('evidence required', p.expectations.evidence === 'require', p.expectations.evidence);
  check('verification encouraged', p.expectations.verification === 'encourage');
  check('deep reasoning', p.depth === 'deep', p.depth);
  check('directive asks for confidence statement', /confiden/i.test(p.directive), p.directive.slice(0, 80));
}

// ── 6. Coding ────────────────────────────────────────────────────────────────
section('A6 · coding');
{
  const write = planFor('Write a debounce utility in TypeScript with a flush method.', { taskType: 'coding', complexity: 'medium', confidence: 0.9 });
  check('code style for coding', write.style.id === 'code', write.style.id);
  check('standard depth at medium complexity', write.depth === 'standard', write.depth);

  const dbg = planFor('Why does the login handler throw on an empty payload after the last deploy?', { taskType: 'debugging', complexity: 'high', confidence: 0.85 });
  check('code style for debugging', dbg.style.id === 'code', dbg.style.id);
  check('debugging is a grounding task ⇒ evidence required', dbg.expectations.evidence === 'require', dbg.expectations.evidence);
  check('deep depth at high complexity', dbg.depth === 'deep', dbg.depth);

  const quick = planFor('Rename this variable across the function.', { taskType: 'coding', complexity: 'low', confidence: 0.9 });
  check('low-complexity coding stays cheap', quick.depth !== 'deep', quick.depth);
}

// ── 7. Mixed media — files, timelines, memory in one turn ────────────────────
section('A7 · mixed media');
{
  const p = planFor(
    'Summarize the attached PDF and pull the revenue table into bullet points.',
    { taskType: 'file_analysis', complexity: 'medium', confidence: 0.9 },
  );
  check('evidence_first for file analysis', p.style.id === 'evidence_first', p.style.id);
  check('evidence required + broaden armed', p.expectations.evidence === 'require' && p.expectations.retrieval.broadenOnEmpty);
  check('deep depth with widened limit', p.depth === 'deep' && p.expectations.retrieval.limit === 10, `${p.depth}/${p.expectations.retrieval.limit}`);

  const t = planFor(
    'Build a timeline of events from the uploaded meeting notes.',
    { taskType: 'file_analysis', complexity: 'medium', confidence: 0.9 },
  );
  check('temporal cue outranks evidence cue (hint order)', t.style.id === 'temporal', t.style.id);
  check('temporal need detected', t.question.needs.temporal === true);
  check('grounding task keeps evidence required', t.expectations.evidence === 'require', t.expectations.evidence);
}

// ── 8. Edge cases — the planner must never throw, never overspend ────────────
section('A8 · edge cases');
{
  const weird = [
    ['', 'conversation'],
    ['?', 'conversation'],
    ['🔥🔥🔥', 'conversation'],
    ['a', 'simple_qa'],
    ['the of and to in a', 'conversation'],
    ['व्याख्या करें कि यह प्रणाली कैसे काम करती है और इसकी सीमाएँ क्या हैं', 'analysis'],
    ['lorem ipsum dolor sit amet '.repeat(400), 'analysis'],   // ~2.4k words
  ];
  let survived = 0;
  for (const [msg, taskType] of weird) {
    try {
      const p = planFor(msg, { taskType, confidence: 0.7 });
      if (p && p.id && p.signature && p.expectations && p.directive.length <= RP.DIRECTIVE_MAX_CHARS
          && p.question.understanding >= 0 && p.question.understanding <= 1) survived += 1;
    } catch { /* counted as failure below */ }
  }
  check(`planner survives ${weird.length} hostile inputs with valid plans`, survived === weird.length, `${survived}/${weird.length}`);

  // Directive budget under the worst stack: every line a style can earn.
  let worst = 0;
  for (const styleId of SS.listCognitiveStyles()) {
    const p = planFor('it is broken, fix it and stuff and things', { taskType: 'file_analysis', complexity: 'high', confidence: 0.3, hasWorkspace: false, styleId });
    worst = Math.max(worst, p.directive.length);
    if (p.directive.length > RP.DIRECTIVE_MAX_CHARS) check(`directive cap for style ${styleId}`, false, `${p.directive.length}`);
  }
  check(`directive cap holds across all 13 styles (worst ${worst} ≤ ${RP.DIRECTIVE_MAX_CHARS})`, worst <= RP.DIRECTIVE_MAX_CHARS);

  check('broadenQuery: empty ⇒ null', CIE.broadenQuery('') === null);
  check('broadenQuery: stopwords-only ⇒ null', CIE.broadenQuery('the a an of and to') === null);
  const bq = CIE.broadenQuery('What does the quarterly compliance report conclude about vendor risk exposure?');
  check('broadenQuery: keyword reformulation ≤ 6 tokens', !!bq && bq.split(' ').length <= 6 && !bq.includes('what'), bq ?? 'null');
}

// ── 9. Low confidence — uncertainty, clarification, and the cache-leak fix ───
section('A9 · low confidence');
{
  RP._clearPlanCacheForTests();
  const unsure = planFor('Refactor the cache invalidation path.', { taskType: 'coding', complexity: 'medium', confidence: 0.5 });
  check('confidence < 0.6 forces uncertainty expression', unsure.expectations.uncertainty === 'express', unsure.expectations.uncertainty);

  const vague = planFor('it is broken, fix it', { taskType: 'conversation', complexity: 'low', confidence: 0.35 });
  check('deictic + vague + unsure + short ⇒ clarification recommended', vague.expectations.clarification.recommended === true, JSON.stringify(vague.question.ambiguity));
  check('clarification line lands in the directive', /clarifying question/i.test(vague.directive), vague.directive);
  const q = QM.assessQuestion('it is broken, fix it', { taskType: 'conversation', confidence: 0.35 });
  check('rock-bottom classifier confidence drags understanding', q.understanding < 0.5, `${q.understanding}`);

  // The Phase 2 regression this bench surfaced: cached plans must not leak
  // a stale uncertainty posture across the 0.6 confidence boundary.
  RP._clearPlanCacheForTests();
  const msg = 'Write a pagination helper for the orders endpoint.';
  const a = planFor(msg, { taskType: 'coding', confidence: 0.9 });
  const b = planFor(msg, { taskType: 'coding', confidence: 0.5 });
  const c = planFor(msg, { taskType: 'coding', confidence: 0.55 });
  check('confidence bucket busts the cache signature', a.signature !== b.signature, `${a.signature} vs ${b.signature}`);
  check('low-confidence turn does NOT reuse the confident plan', b.reused === false);
  check('uncertainty flips allow → express across the boundary', a.expectations.uncertainty === 'allow' && b.expectations.uncertainty === 'express', `${a.expectations.uncertainty}/${b.expectations.uncertainty}`);
  check('same-bucket turn still reuses (cache stays useful)', c.reused === true);
}

// ── 10. Missing evidence — broaden pass, collapsed confidence, honest lesson ─
section('A10 · missing evidence');
{
  CIE._resetCIEForTests();
  const plan = planFor('What does the compliance report say about vendor risk?', { taskType: 'file_analysis', complexity: 'medium', confidence: 0.9 });

  // Broaden pass fires once, bounded, with a keyword query and a wider limit.
  const calls = [];
  const stubHit = (ownerId, query, { limit }) => {
    calls.push({ query, limit });
    return calls.length === 1
      ? { items: [], block: '', stats: { facts: 0, entities: 0 } }
      : { items: [{ kind: 'fact', id: 'f1', statement: 'vendor risk rated moderate', confidence: 0.8 },
                  { kind: 'entity', id: 'e1', entity: 'VendorCo', resolutionConfidence: 0.9 }],
          block: 'KNOWLEDGE', stats: { facts: 1, entities: 1 } };
  };
  const out = CIE.cognitiveKnowledgeRetrieve('user:bench', 'What does the compliance report say about vendor risk?', { limit: 8, plan, _retrieve: stubHit });
  check('empty-first retrieval triggers exactly one broaden pass', calls.length === 2, `${calls.length} calls`);
  check('broaden query is a keyword reformulation', calls.length === 2 && calls[1].query !== calls[0].query && !/what/i.test(calls[1].query), calls[1]?.query);
  check('broaden pass widens the limit', calls.length === 2 && calls[1].limit === 12, `${calls[1]?.limit}`);
  check('recovered items merged with broadened stats', out.items.length === 2 && out.stats.broadened === true && out.stats.broadenGained === 2);

  const stubEmpty = () => ({ items: [], block: '', stats: { facts: 0, entities: 0 } });
  const empty = CIE.cognitiveKnowledgeRetrieve('user:bench', 'What does the compliance report say about vendor risk?', { limit: 8, plan, _retrieve: stubEmpty });
  check('honest empty-after-broaden marking', empty.items.length === 0 && empty.stats.broadened === true && empty.stats.broadenGained === 0);
  const m = CIE.getCIEMetrics();
  check('retrieval metrics track broadening', m.retrieval.broadened === 2 && m.retrieval.emptyAfterBroaden === 1, JSON.stringify(m.retrieval));

  // "Never invent certainty": no evidence under a require posture collapses
  // the evidence dimension and caps the overall band.
  const conf = CC.composeCognitiveConfidence({
    plan, knowledgeItems: [], knowledgeStats: { broadened: true, facts: 0, entities: 0 },
    retrieval: {}, responseConfidence: { score: 0.85, band: 'high' },
  });
  const evDim = conf.dims.find(d => d.id === 'evidence');
  check('evidence dim collapses with zero facts under require', evDim.score <= 0.2, `${evDim.score}`);
  check('overall confidence leaves the high band', conf.overall.score < 0.6 && conf.overall.band !== 'high', `${conf.overall.score}/${conf.overall.band}`);

  const refl = RE.reflect({
    plan, monitor: { findings: [] }, verification: { ran: false },
    responseConfidence: { score: 0.85, band: 'high' }, cognitiveConfidence: conf,
    knowledgeStats: { facts: 0, entities: 0, broadened: true }, taskType: 'file_analysis',
  });
  check('reflection names the knowledge gap', refl.ran && refl.lessons.some(l => /knowledge gap/.test(l)), (refl.lessons ?? []).join(' | '));
}

// ═════════════════════════════════════════════════════════════════════════════
// B. MONITOR QUALITY — precision on clean drafts, recall on dirty ones
// ═════════════════════════════════════════════════════════════════════════════
section('B · reasoning monitor — precision');
{
  const plan = planFor('Summarize the attached quarterly report.', { taskType: 'file_analysis', confidence: 0.9, styleId: 'evidence_first' });
  const evidence = 'Q3 revenue was 4200 units at a 12.5% margin. The database migration completed on 2025-11-03. Vendor risk was rated moderate. Headcount reached 86.';
  const cleanDrafts = [
    'The report shows Q3 revenue of 4200 units at a 12.5% margin. The database migration completed on 2025-11-03 as planned. Vendor risk was rated moderate for the period. Headcount reached 86 by quarter end. These figures come directly from the report tables. Overall the quarter tracked the stated plan.',
    'Revenue landed at 4200 units for the quarter. Margin held at 12.5% across both segments. The migration wrapped on 2025-11-03 without rollback. The report rates vendor exposure as moderate. Staffing grew to 86 people over the period. Every figure above appears in the source tables.',
    'Three findings stand out in the filing. First, unit volume reached 4200 with margin at 12.5%. Second, the platform migration closed on 2025-11-03. Third, vendor risk stays moderate while headcount sits at 86. The underlying tables support each of these directly. Nothing in the appendix contradicts them.',
  ];
  let falseAlarms = 0, escalations = 0;
  for (const draft of cleanDrafts) {
    const r = RM.monitorDraft({ draft, plan, evidenceContext: evidence, knowledgeItems: [], verificationAlreadyEnabled: false });
    falseAlarms += r.findings.filter(f => f.severity !== 'info').length;
    if (r.escalate.escalate) escalations += 1;
  }
  check(`zero warn/critical findings across ${cleanDrafts.length} clean grounded drafts`, falseAlarms === 0, `${falseAlarms} false alarms`);
  check('zero escalations on clean drafts (precision 100%)', escalations === 0, `${escalations}`);
}

section('B · reasoning monitor — recall');
{
  const plan = planFor('Summarize the attached quarterly report.', { taskType: 'file_analysis', confidence: 0.9, styleId: 'evidence_first' });
  const evidence = 'Q3 revenue was 4200 units. The database migration completed successfully last week.';
  const fact = { kind: 'fact', statement: 'database migration completed successfully last week', confidence: 0.9 };

  const dirty = [
    { id: 'dead_end', severity: 'critical', draft: "I cannot access uploaded files, so I'm unable to summarize the report you attached here." },
    { id: 'circular_reasoning', severity: 'warn', draft: (
      'The quarter performed according to the stated projections overall. ' +
      'Revenue growth tracked the plan set out at the start of the year. ' +
      'The quarter performed according to the stated projections overall. ' +
      'The quarter performed according to the stated projections overall. ' +
      'Margins held steady across both of the operating segments in scope. ' +
      'The quarter performed according to the stated projections overall. ' +
      'Costs stayed inside the envelope the finance team had budgeted for. ' +
      'The quarter performed according to the stated projections overall.'
    ) },
    { id: 'unsupported_specifics', severity: 'warn', draft: 'The report claims revenue of 98765 units, a 47.9% margin, and $123,456 in savings, none of which the summary tables repeat elsewhere in this draft of the analysis.' },
    { id: 'possible_contradiction', severity: 'warn', draft: 'Reading the filing closely, the database migration completed claim is wrong — the work did not finish and remains open per the appendix.' },
    { id: 'excess_hedging', severity: 'warn', draft: (
      'The results might indicate growth, though it could be seasonal and perhaps temporary in nature. ' +
      'Maybe the margin improvement holds, but possibly the vendor mix shifted underneath it during the period. ' +
      'I think the headcount number seems roughly right, though it could be off by a little in either direction. ' +
      'The appendix might resolve some of this, and perhaps the next filing will clarify the remaining open points.'
    ) },
  ];
  let caught = 0;
  for (const t of dirty) {
    const r = RM.monitorDraft({ draft: t.draft, plan, evidenceContext: evidence, knowledgeItems: [fact], verificationAlreadyEnabled: false });
    const hit = r.findings.some(f => f.id === t.id && f.severity === t.severity);
    if (hit) caught += 1;
    check(`catches ${t.id}`, hit, r.findings.map(f => `${f.id}:${f.severity}`).join(',') || 'no findings');
  }
  check(`recall ${caught}/${dirty.length} across all structural failure signatures`, caught === dirty.length);
}

section('B · reasoning monitor — escalation semantics + stream parity');
{
  const plan = planFor('Summarize the attached quarterly report.', { taskType: 'file_analysis', confidence: 0.9, styleId: 'evidence_first' });
  const evidence = 'Q3 revenue was 4200 units.';
  const refusal = "I cannot access uploaded files, so I'm unable to summarize the report you attached here.";

  const esc = RM.monitorDraft({ draft: refusal, plan, evidenceContext: evidence, knowledgeItems: [], verificationAlreadyEnabled: false });
  check('critical finding escalates when verification was skipped', esc.escalate.escalate === true && esc.escalate.reason === 'dead_end', JSON.stringify(esc.escalate));

  const ride = RM.monitorDraft({ draft: refusal, plan, evidenceContext: evidence, knowledgeItems: [], verificationAlreadyEnabled: true });
  check('only ADDS review: no escalation when verification already enabled', ride.escalate.escalate === false && ride.findings.length > 0);

  const twoWarn = (
    'The report claims revenue of 98765 units, a 47.9% margin, and $123,456 in savings for the period under review. ' +
    'The quarter performed according to the stated projections overall. '.repeat(5) +
    'Margins held steady across both of the operating segments in scope.'
  );
  const w = RM.monitorDraft({ draft: twoWarn, plan, evidenceContext: evidence, knowledgeItems: [], verificationAlreadyEnabled: false });
  check('two warnings under a require plan escalate', w.escalate.escalate === true && /warnings/.test(w.escalate.reason ?? ''), JSON.stringify(w.escalate));

  const sm = RM.createStreamMonitor({ plan, evidenceContext: evidence, knowledgeItems: [] });
  for (let i = 0; i < refusal.length; i += 17) sm.addChunk(refusal.slice(i, i + 17));
  const streamed = sm.finish({ verificationAlreadyEnabled: false });
  check('stream monitor ≡ whole-draft monitor', JSON.stringify(streamed.findings.map(f => f.id)) === JSON.stringify(esc.findings.map(f => f.id)));
}

// ═════════════════════════════════════════════════════════════════════════════
// C. LEARNING — convergence, margin gate, evidence-safety gate
// ═════════════════════════════════════════════════════════════════════════════
section('C · learning convergence');
{
  CIE._resetCIEForTests();
  const q = QM.assessQuestion('Lay out a rollout plan for the new billing tier.', { taskType: 'planning', confidence: 0.9 });

  // Cold start: an empty store must behave byte-identically to pure rules.
  const cold = SS.selectCognitiveStyle({ taskType: 'planning', complexity: 'medium', question: q });
  check('cold start uses task rules', cold.style.id === 'analytical' && cold.source === 'task', `${cold.style.id}/${cold.source}`);

  // Feed successful 'comparative' reflections; the flip must land at EXACTLY
  // the sample gate — one short of it, rules still hold.
  for (let i = 0; i < SS.PRIOR_SAMPLE_GATE - 1; i++) {
    CS.recordReflection({ taskType: 'planning', styleId: 'comparative', outcome: 'clean', effectiveness: 0.9 });
  }
  const preGate = SS.selectCognitiveStyle({ taskType: 'planning', complexity: 'medium', question: q });
  check(`no override at ${SS.PRIOR_SAMPLE_GATE - 1} samples (gate holds)`, preGate.style.id === 'analytical' && preGate.source !== 'learned', `${preGate.style.id}/${preGate.source}`);

  CS.recordReflection({ taskType: 'planning', styleId: 'comparative', outcome: 'clean', effectiveness: 0.9 });
  const atGate = SS.selectCognitiveStyle({ taskType: 'planning', complexity: 'medium', question: q });
  check(`learned override lands at exactly ${SS.PRIOR_SAMPLE_GATE} samples`, atGate.style.id === 'comparative' && atGate.source === 'learned', `${atGate.style.id}/${atGate.source}`);
}

section('C · learning — margin gate');
{
  CIE._resetCIEForTests();
  const q = QM.assessQuestion('Assess the two rollout options against our constraints.', { taskType: 'analysis', confidence: 0.9 });
  for (let i = 0; i < SS.PRIOR_SAMPLE_GATE; i++) {
    CS.recordReflection({ taskType: 'analysis', styleId: 'analytical',  outcome: 'clean', effectiveness: 0.85 });
    CS.recordReflection({ taskType: 'analysis', styleId: 'comparative', outcome: 'clean', effectiveness: 0.95 });
  }
  const held = SS.selectCognitiveStyle({ taskType: 'analysis', complexity: 'medium', question: q });
  check(`0.10 edge < ${SS.PRIOR_MARGIN} margin ⇒ rules hold`, held.style.id === 'analytical' && held.source !== 'learned', `${held.style.id}/${held.source}`);

  // The incumbent degrades; once the EWMA gap clears the margin, the learned
  // style takes over.
  CS.recordReflection({ taskType: 'analysis', styleId: 'analytical', outcome: 'misfired', effectiveness: 0.4 });
  const flipped = SS.selectCognitiveStyle({ taskType: 'analysis', complexity: 'medium', question: q });
  check('incumbent decay past the margin flips selection', flipped.style.id === 'comparative' && flipped.source === 'learned', `${flipped.style.id}/${flipped.source}`);
}

section('C · learning — evidence-safety gate');
{
  CIE._resetCIEForTests();
  for (let i = 0; i < SS.PRIOR_SAMPLE_GATE + 2; i++) {
    CS.recordReflection({ taskType: 'file_analysis', styleId: 'creative', outcome: 'clean', effectiveness: 0.99 });
  }
  const q = QM.assessQuestion('Summarize the attached vendor report.', { taskType: 'file_analysis', confidence: 0.9 });
  const sel = SS.selectCognitiveStyle({ taskType: 'file_analysis', complexity: 'medium', question: q });
  check('evidence-needing turns never learn into a no-evidence style', sel.style.id !== 'creative' && sel.source !== 'learned', `${sel.style.id}/${sel.source}`);
  CIE._resetCIEForTests();
}

// ═════════════════════════════════════════════════════════════════════════════
// D. PERFORMANCE — "minimize unnecessary reasoning"
// ═════════════════════════════════════════════════════════════════════════════
section('D · performance budgets');
{
  RP._clearPlanCacheForTests();
  const inputs = [];
  const kinds = [
    ['What is the capital of France?', 'simple_qa', 'low', 0.95],
    ['Compare the assumptions across the files for the Q3 claim.', 'analysis', 'medium', 0.9],
    ['Why does the login handler throw on an empty payload?', 'debugging', 'high', 0.85],
    ['Summarize the attached PDF and pull the revenue table.', 'file_analysis', 'medium', 0.9],
    ['Lay out a rollout plan for the new billing tier.', 'planning', 'medium', 0.55],
  ];
  for (let i = 0; i < 25; i++) inputs.push(kinds[i % kinds.length]);
  const prepped = inputs.map(([msg, taskType, complexity, confidence]) => {
    const question  = QM.assessQuestion(msg, { taskType, confidence, hasOwner: true });
    const selection = SS.selectCognitiveStyle({ taskType, complexity, question });
    return { question, selection, taskType, complexity, confidence };
  });

  // Warm plans: the cache should carry nearly all of a repeated workload.
  let reused = 0;
  const warm = timeLoop(5000, (i) => { if (RP.buildReasoningPlan(prepped[i % prepped.length]).reused) reused += 1; });
  const reuseRate = reused / warm.n;
  console.log(`    warm plan build   ${warm.perSec}/s · p50 ${warm.p50Us.toFixed(1)}µs · p95 ${warm.p95Us.toFixed(1)}µs · reuse ${pct(reuseRate)}`);
  check('warm plan p95 < 5ms', warm.p95Us < 5000, `${warm.p95Us.toFixed(1)}µs`);
  check('plan reuse rate ≥ 95% on repeated workload', reuseRate >= 0.95, pct(reuseRate));

  // Cold plans: full recompute cost, cache cleared every iteration.
  const cold = timeLoop(500, (i) => { RP._clearPlanCacheForTests(); RP.buildReasoningPlan(prepped[i % prepped.length]); });
  console.log(`    cold plan build   ${cold.perSec}/s · p50 ${cold.p50Us.toFixed(1)}µs · p95 ${cold.p95Us.toFixed(1)}µs`);
  check('cold plan p95 < 8ms', cold.p95Us < 8000, `${cold.p95Us.toFixed(1)}µs`);

  // Full meta-reasoning pass (assess → select → plan) on a long message.
  const longMsg = 'Explain how the ingestion pipeline handles retries, backpressure, and duplicate suppression across the services layer. '.repeat(10);
  RP._clearPlanCacheForTests();
  const full = timeLoop(200, () => {
    const question  = QM.assessQuestion(longMsg, { taskType: 'analysis', confidence: 0.9, hasOwner: true });
    const selection = SS.selectCognitiveStyle({ taskType: 'analysis', complexity: 'high', question });
    RP.buildReasoningPlan({ question, selection, taskType: 'analysis', complexity: 'high', confidence: 0.9 });
  });
  console.log(`    full meta-pass    ${full.perSec}/s · p50 ${full.p50Us.toFixed(1)}µs · p95 ${full.p95Us.toFixed(1)}µs (long message)`);
  check('assess+select+plan p95 < 15ms on a ~1.2k-word message', full.p95Us < 15000, `${full.p95Us.toFixed(1)}µs`);

  // Monitor on a realistic 4KB draft.
  const plan = planFor('Summarize the attached quarterly report.', { taskType: 'file_analysis', confidence: 0.9, styleId: 'evidence_first' });
  const bigDraft = 'The report shows Q3 revenue of 4200 units at a 12.5% margin, with the migration completed on schedule and vendor exposure rated moderate for the period under review. '.repeat(25);
  const evidence = 'Q3 revenue was 4200 units at a 12.5% margin. Migration completed. Vendor risk moderate.';
  const mon = timeLoop(500, () => RM.monitorDraft({ draft: bigDraft, plan, evidenceContext: evidence, knowledgeItems: [] }));
  console.log(`    monitor (4KB)     ${mon.perSec}/s · p50 ${mon.p50Us.toFixed(1)}µs · p95 ${mon.p95Us.toFixed(1)}µs`);
  check('monitor p95 < 25ms on a 4KB draft', mon.p95Us < 25000, `${mon.p95Us.toFixed(1)}µs`);

  // Confidence composition throughput.
  const items = Array.from({ length: 12 }, (_, i) => ({ kind: i % 3 ? 'fact' : 'entity', id: `k${i}`, statement: `fact ${i}`, confidence: 0.8, resolutionConfidence: 0.85 }));
  const conf = timeLoop(2000, () => CC.composeCognitiveConfidence({
    plan, knowledgeItems: items, knowledgeStats: { facts: 8, entities: 4, connectedFacts: 3, timelineEvents: 0 },
    retrieval: { factsInjected: 2, hasWorkspace: true, projectFilesUsed: 1 },
    responseConfidence: { score: 0.82, band: 'high' }, verification: { ran: true, passed: true, revised: false },
  }));
  console.log(`    confidence        ${conf.perSec}/s · p50 ${conf.p50Us.toFixed(1)}µs · p95 ${conf.p95Us.toFixed(1)}µs`);
  check('confidence composition p95 < 5ms', conf.p95Us < 5000, `${conf.p95Us.toFixed(1)}µs`);
}

// ═════════════════════════════════════════════════════════════════════════════
// Summary
// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(76)}`);
for (const s of sections) {
  const mark = s.fail ? '✗' : '✓';
  console.log(`${mark} ${s.name.padEnd(52)} ${String(s.pass).padStart(3)} pass ${String(s.fail).padStart(2)} fail`);
}
console.log('─'.repeat(76));
console.log(`CIE BENCH: ${totalPass}/${totalPass + totalFail} checks passed`);
if (totalFail) {
  console.log('\nFailures:');
  for (const s of sections) for (const f of s.failures) console.log(`  ${s.name} → ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exitCode = 1;
}
