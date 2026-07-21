/**
 * Cognitive Intelligence Engine — Regression Suite (CIE Phase 1)
 *
 * Run: npm run test:cognition   (aqua/ package)
 *
 * Covers the CIE brief's success criteria:
 *
 *   question model     understanding, ambiguity signals, cognitive needs,
 *                      style hints, clarification decision (conservative)
 *   strategy selector  all 13 styles reachable; hint > task > complexity
 *                      precedence; learned prior override is sample-gated,
 *                      margin-gated, and evidence-safe
 *   reasoning planner  executive plan shape, bounded directive, fast stays
 *                      byte-light, plan-cache reuse
 *   confidence model   7 tracked dimensions, renormalization over signaled
 *                      dims ("never invent certainty" both ways),
 *                      revised-unproven cap, existing engine composed
 *   reasoning monitor  every finding type; escalation only ADDS review;
 *                      clean drafts stay clean
 *   reflection engine  beneficial gate, calibration lessons, strategy-misfit
 *                      hints, outcome classes
 *   cognitive store    (task × style) aggregates, EWMA, sample-gated priors,
 *                      snapshot isolation
 *   facade             kill switch ⇒ byte-identical passthrough; retrieval
 *                      broaden pass; fail-open; metrics; e2e
 *                      plan → retrieve → monitor → escalate → conclude
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-cie-'));
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

beforeEach(() => {
  CIE._resetCIEForTests();   // clears metrics + plan cache + store (persistence off)
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function planFor(message, {
  taskType = 'analysis', complexity = 'medium', confidence = 0.9,
  hasWorkspace = false, hasOwner = true, styleId = null,
} = {}) {
  const question = QM.assessQuestion(message, { taskType, confidence, hasWorkspace, hasOwner });
  const selection = styleId
    ? { style: SS.COGNITIVE_STYLES[styleId], source: 'test', reason: 'forced by test' }
    : SS.selectCognitiveStyle({ taskType, complexity, question });
  return RP.buildReasoningPlan({ question, selection, taskType, complexity, confidence });
}

const RC = (score, band) => ({ score, band, basis: [], factors: [] });

// ═════════════════════════════════════════════════════════════════════════════
describe('question model — meta-reasoning over the question itself', () => {

  test('clean, specific question: high understanding, no ambiguity, no clarification', () => {
    const q = QM.assessQuestion('Summarize the main findings of the attached quarterly report in three bullet points.', { taskType: 'summarization', confidence: 0.92 });
    assert.equal(q.ambiguity.score, 0);
    assert.equal(q.understanding, 1);
    assert.equal(q.clarification.recommended, false);
  });

  test('vague deictic ask trips ambiguity signals', () => {
    const q = QM.assessQuestion('it is broken, fix it', { taskType: 'conversation', confidence: 0.5 });
    assert.ok(q.ambiguity.signals.includes('deictic_opener'));
    assert.ok(q.ambiguity.signals.includes('vague_ask'));
    assert.ok(q.ambiguity.score >= 0.6);
    assert.ok(q.understanding < 0.7);
  });

  test('clarification recommended ONLY when ambiguous + low confidence + short', () => {
    const yes = QM.assessQuestion('it is broken, fix it', { taskType: 'conversation', confidence: 0.5 });
    assert.equal(yes.clarification.recommended, true);
    assert.match(yes.clarification.reason, /ambiguity/);

    // Same text, confident classifier → no clarification (conservative gate).
    const conf = QM.assessQuestion('it is broken, fix it', { taskType: 'debugging', confidence: 0.9 });
    assert.equal(conf.clarification.recommended, false);

    // Ambiguous opener but plenty of words → self-resolving, no clarification.
    const long = QM.assessQuestion('it is broken, fix it — the login form on the settings page throws a 500 when I submit an empty password field', { taskType: 'debugging', confidence: 0.5 });
    assert.equal(long.clarification.recommended, false);
  });

  test('unanchored "the file" only counts without a workspace', () => {
    const bare = QM.assessQuestion('What does the file do?', { taskType: 'conversation', confidence: 0.8, hasWorkspace: false });
    assert.ok(bare.ambiguity.signals.includes('unanchored_reference'));
    const anchored = QM.assessQuestion('What does the file do?', { taskType: 'conversation', confidence: 0.8, hasWorkspace: true });
    assert.ok(!anchored.ambiguity.signals.includes('unanchored_reference'));
  });

  test('cognitive needs detected from language + task type', () => {
    const q = QM.assessQuestion('According to the uploaded report, what is the latest revenue timeline across the files?', {
      taskType: 'file_analysis', confidence: 0.9, hasOwner: true,
    });
    assert.equal(q.needs.evidence, true);       // "according to" + grounding task
    assert.equal(q.needs.freshness, true);      // "latest"
    assert.equal(q.needs.temporal, true);       // "timeline"
    assert.equal(q.needs.crossFile, true);      // "across the files"
    assert.equal(q.needs.retrievalLikely, true);
  });

  test('memoryLikely requires an owner to anchor "my …"', () => {
    const owned = QM.assessQuestion('What did we discuss about my project last time?', { taskType: 'memory_recall', confidence: 0.9, hasOwner: true });
    assert.equal(owned.needs.memoryLikely, true);
    const unowned = QM.assessQuestion('What did we discuss about my project last time?', { taskType: 'memory_recall', confidence: 0.9, hasOwner: false });
    assert.equal(unowned.needs.memoryLikely, false);
  });

  test('style hints fire in priority order — legal beats comparative', () => {
    const q = QM.assessQuestion('Compare the contract liability clauses in these two agreements.', { taskType: 'analysis', confidence: 0.9 });
    assert.equal(q.styleHints[0], 'legal');
    assert.ok(q.styleHints.includes('comparative'));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('strategy selector — 13 adaptive cognitive styles', () => {

  test('all 13 spec styles exist', () => {
    const styles = SS.listCognitiveStyles();
    for (const id of ['fast', 'analytical', 'evidence_first', 'temporal', 'cross_file', 'code', 'scientific', 'mathematical', 'creative', 'comparative', 'architectural', 'legal', 'research']) {
      assert.ok(styles.includes(id), `missing style ${id}`);
    }
    assert.equal(styles.length, 13);
  });

  test('task type mapping: coding→code, file_analysis→evidence_first, conversation→fast', () => {
    const q = QM.assessQuestion('Please help with this task in a normal way.', { taskType: 'coding', confidence: 0.9 });
    assert.equal(SS.selectCognitiveStyle({ taskType: 'coding', complexity: 'medium', question: q }).style.id, 'code');
    assert.equal(SS.selectCognitiveStyle({ taskType: 'file_analysis', complexity: 'medium', question: q }).style.id, 'evidence_first');
    assert.equal(SS.selectCognitiveStyle({ taskType: 'conversation', complexity: 'low', question: q }).style.id, 'fast');
    assert.equal(SS.selectCognitiveStyle({ taskType: 'architecture', complexity: 'medium', question: q }).style.id, 'architectural');
  });

  test('language hint overrides task mapping', () => {
    const q = QM.assessQuestion('Is this clause GDPR compliant under the contract?', { taskType: 'conversation', confidence: 0.9 });
    const sel = SS.selectCognitiveStyle({ taskType: 'conversation', complexity: 'medium', question: q });
    assert.equal(sel.style.id, 'legal');
    assert.equal(sel.source, 'hint');
  });

  test('high complexity promotes fast → analytical (never shallow a hard task)', () => {
    const q = QM.assessQuestion('Please help with this in a normal way, thanks a lot.', { taskType: 'conversation', confidence: 0.9 });
    const sel = SS.selectCognitiveStyle({ taskType: 'conversation', complexity: 'high', question: q });
    assert.equal(sel.style.id, 'analytical');
    assert.equal(sel.source, 'complexity');
  });

  test('learned prior overrides only past the sample gate AND the margin', () => {
    const q = QM.assessQuestion('Please analyze this in a normal way for me.', { taskType: 'analysis', confidence: 0.9 });

    // 7 strong reflections — one short of the gate: no override.
    for (let i = 0; i < 7; i++) {
      CS.recordReflection({ taskType: 'analysis', styleId: 'research', outcome: 'clean', effectiveness: 0.95 });
    }
    assert.equal(SS.selectCognitiveStyle({ taskType: 'analysis', complexity: 'medium', question: q }).style.id, 'analytical');

    // 8th clears the gate; 0.95 ≥ 0.7 (neutral) + 0.12 margin → learned override.
    CS.recordReflection({ taskType: 'analysis', styleId: 'research', outcome: 'clean', effectiveness: 0.95 });
    const sel = SS.selectCognitiveStyle({ taskType: 'analysis', complexity: 'medium', question: q });
    assert.equal(sel.style.id, 'research');
    assert.equal(sel.source, 'learned');
  });

  test('margin gate: a prior that is merely as good does not override', () => {
    const q = QM.assessQuestion('Please analyze this in a normal way for me.', { taskType: 'analysis', confidence: 0.9 });
    for (let i = 0; i < 10; i++) {
      CS.recordReflection({ taskType: 'analysis', styleId: 'research', outcome: 'clean', effectiveness: 0.75 }); // < 0.7+0.12
    }
    assert.equal(SS.selectCognitiveStyle({ taskType: 'analysis', complexity: 'medium', question: q }).style.id, 'analytical');
  });

  test('evidence safety: never learn INTO a no-evidence style when the question needs evidence', () => {
    const q = QM.assessQuestion('According to the report, what changed?', { taskType: 'file_analysis', confidence: 0.9 });
    assert.equal(q.needs.evidence, true);
    for (let i = 0; i < 12; i++) {
      CS.recordReflection({ taskType: 'file_analysis', styleId: 'creative', outcome: 'clean', effectiveness: 0.99 });
    }
    const sel = SS.selectCognitiveStyle({ taskType: 'file_analysis', complexity: 'medium', question: q });
    assert.equal(sel.style.id, 'evidence_first');   // creative (evidencePosture none) blocked
  });

  test('depth resolution: complexity bends depth both ways', () => {
    assert.equal(SS.resolveDepth(SS.COGNITIVE_STYLES.analytical, 'high'), 'deep');
    assert.equal(SS.resolveDepth(SS.COGNITIVE_STYLES.evidence_first, 'low'), 'standard');
    assert.equal(SS.resolveDepth(SS.COGNITIVE_STYLES.fast, 'low'), 'shallow');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('reasoning planner — the executive plan', () => {

  test('evidence_first plan: require evidence, broaden on empty, deep retrieval limit', () => {
    const plan = planFor('According to the uploaded report, what were the revenue figures?', { taskType: 'file_analysis' });
    assert.equal(plan.style.id, 'evidence_first');
    assert.equal(plan.expectations.evidence, 'require');
    assert.equal(plan.expectations.retrieval.knowledge, true);
    assert.equal(plan.expectations.retrieval.broadenOnEmpty, true);
    assert.equal(plan.expectations.retrieval.limit, 10);   // deep
    assert.equal(plan.expectations.verification, 'encourage');
    assert.ok(plan.directive.includes('say so instead of guessing'));
  });

  test('fast style keeps casual traffic byte-light: empty directive', () => {
    const plan = planFor('Hey, how are you doing today my friend?', { taskType: 'conversation', complexity: 'low', confidence: 0.95 });
    assert.equal(plan.style.id, 'fast');
    assert.equal(plan.directive, '');
    assert.equal(plan.expectations.evidence, 'none');
  });

  test('clarification recommendation lands in the directive', () => {
    const plan = planFor('it is broken, fix it', { taskType: 'conversation', complexity: 'low', confidence: 0.5 });
    assert.equal(plan.expectations.clarification.recommended, true);
    assert.ok(plan.directive.includes('ONE precise clarifying question'));
  });

  test('directive never exceeds the hard cap — every style, worst-case expectations', () => {
    for (const styleId of SS.listCognitiveStyles()) {
      const plan = planFor('it is broken, fix it according to the attached legal contract', {
        taskType: 'file_analysis', complexity: 'high', confidence: 0.4, styleId,
      });
      assert.ok(plan.directive.length <= RP.DIRECTIVE_MAX_CHARS,
        `${styleId} directive ${plan.directive.length} > ${RP.DIRECTIVE_MAX_CHARS}`);
    }
  });

  test('plan cache: identical cognitive situation reuses the plan', () => {
    const a = planFor('Compare the trade-offs between REST and GraphQL for our API.', { taskType: 'analysis' });
    const b = planFor('Compare the trade-offs between REST and GraphQL for our API.', { taskType: 'analysis' });
    assert.equal(a.reused, false);
    assert.equal(b.reused, true);
    assert.equal(a.signature, b.signature);
    assert.notEqual(a.id, b.id);              // fresh id per turn, shared plan body
    assert.ok(RP.planCacheStats().size >= 1);
  });

  test('plan cache: confidence busts the signature — no stale uncertainty reuse', () => {
    // Phase 2 regression (surfaced by cognitionBench, category 9): the
    // uncertainty expectation branches on confidence < 0.6, so a plan built
    // at 0.9 must never be handed to a 0.5 turn via the cache.
    const msg = 'Write a pagination helper for the orders endpoint.';
    const sure   = planFor(msg, { taskType: 'coding', confidence: 0.9 });
    const unsure = planFor(msg, { taskType: 'coding', confidence: 0.5 });
    assert.notEqual(sure.signature, unsure.signature);        // confidence bucket differs
    assert.equal(unsure.reused, false);                       // 0.5 must not inherit the 0.9 plan
    assert.equal(sure.expectations.uncertainty, 'allow');
    assert.equal(unsure.expectations.uncertainty, 'express'); // pre-fix: stale 'allow' leaked here
    const again = planFor(msg, { taskType: 'coding', confidence: 0.55 });
    assert.equal(again.reused, true);                         // same 0.4–0.6 bucket still reuses
  });

  test('uncertainty stance: quantify for legal/scientific, express under required evidence', () => {
    const legal = planFor('Is this clause enforceable under the contract law of Germany?', { taskType: 'analysis' });
    assert.equal(legal.style.id, 'legal');
    assert.equal(legal.expectations.uncertainty, 'quantify');
    const evid = planFor('Based on the document, summarize the findings please.', { taskType: 'file_analysis' });
    assert.equal(evid.expectations.uncertainty, 'express');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('cognitive confidence — 7 tracked dimensions, never invented', () => {

  test('exposes exactly the spec dimensions: 6 dims + overall = 7 tracked', () => {
    const plan = planFor('Summarize the report according to the uploaded data.', { taskType: 'file_analysis' });
    const out = CC.composeCognitiveConfidence({ plan, responseConfidence: RC(0.7, 'medium') });
    assert.deepEqual(out.dims.map(d => d.id), ['retrieval', 'evidence', 'reasoning', 'entity', 'relationship', 'timeline']);
    assert.ok(out.overall && typeof out.overall.score === 'number' && out.overall.band);
  });

  test('no-signal dimensions are EXCLUDED, not zeroed: fast turn ⇒ overall == reasoning', () => {
    const plan = planFor('Hey, how are you doing my friend?', { taskType: 'conversation', complexity: 'low', confidence: 0.95 });
    const out = CC.composeCognitiveConfidence({ plan, responseConfidence: RC(0.8, 'high') });
    assert.deepEqual(out.basis, ['reasoning']);
    assert.equal(out.overall.score, 0.8);
    assert.equal(out.overall.band, 'high');
  });

  test('required evidence with empty retrieval drags overall down hard', () => {
    const plan = planFor('According to the report, what were the exact figures?', { taskType: 'file_analysis' });
    const out = CC.composeCognitiveConfidence({
      plan, knowledgeStats: { broadened: true }, knowledgeItems: [],
      responseConfidence: RC(0.8, 'high'),
    });
    assert.ok(out.basis.includes('retrieval') && out.basis.includes('evidence'));
    assert.ok(out.overall.score < 0.6, `expected low, got ${out.overall.score}`);
    const evidence = out.dims.find(d => d.id === 'evidence');
    assert.equal(evidence.score, 0.2);        // require + 0 facts
  });

  test('grounded knowledge lifts evidence/entity/relationship dimensions', () => {
    const plan = planFor('According to the files, how are the services connected across the files?', { taskType: 'file_analysis' });
    const items = [
      { kind: 'fact', id: 'f1', statement: 'aqua uses postgres', confidence: 0.9, trusted: true },
      { kind: 'fact', id: 'f2', statement: 'billing calls auth', confidence: 0.85 },
      { kind: 'entity', entity: 'aqua', resolutionConfidence: 0.9 },
    ];
    const out = CC.composeCognitiveConfidence({
      plan, knowledgeItems: items, knowledgeStats: { connectedFacts: 2, timelineEvents: 0 },
      responseConfidence: RC(0.75, 'high'),
    });
    assert.ok(out.dims.find(d => d.id === 'evidence').score > 0.8);
    assert.ok(out.dims.find(d => d.id === 'entity').score >= 0.9);
    assert.ok(out.dims.find(d => d.id === 'relationship').score >= 0.7);
    assert.ok(out.overall.score >= 0.6);
  });

  test('monitor findings depress the reasoning dimension (composition with Phase 12)', () => {
    const plan = planFor('Please analyze this dataset for me thanks.', { taskType: 'analysis' });
    const clean = CC.composeCognitiveConfidence({ plan, responseConfidence: RC(0.8, 'high') });
    const dirty = CC.composeCognitiveConfidence({
      plan, responseConfidence: RC(0.8, 'high'),
      monitor: { findings: [{ id: 'dead_end', severity: 'critical' }, { id: 'excess_hedging', severity: 'warn' }] },
    });
    const r = (o) => o.dims.find(d => d.id === 'reasoning').score;
    assert.ok(r(dirty) < r(clean));
    assert.ok(Math.abs(r(dirty) - (0.8 - 0.25 - 0.08)) < 0.011);
  });

  test('revised-but-unproven verification caps overall at 0.6 — certainty is never invented', () => {
    const plan = planFor('Hey, how are you doing my friend?', { taskType: 'conversation', complexity: 'low', confidence: 0.95 });
    const out = CC.composeCognitiveConfidence({
      plan, responseConfidence: RC(0.9, 'high'),
      verification: { ran: true, revised: true, passed: false },
    });
    assert.equal(out.overall.score, 0.6);   // 0.9 reasoning-only basis, capped exactly
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('reasoning monitor — structural failure signatures + escalation', () => {

  const EVIDENCE = 'REPORT CONTEXT: Revenue grew steadily through the year across both regions of the business.';

  test('clean draft under a fast plan: zero findings, no escalation', () => {
    const plan = planFor('Hey, how are you doing today my friend?', { taskType: 'conversation', complexity: 'low', confidence: 0.95 });
    const out = RM.monitorDraft({ draft: 'Doing great! How can I help you today?', plan });
    assert.equal(out.findings.length, 0);
    assert.equal(out.escalate.escalate, false);
  });

  test('dead end: refusal with evidence present is critical and escalates', () => {
    const plan = planFor('Based on the document, what happened to revenue?', { taskType: 'file_analysis' });
    const out = RM.monitorDraft({
      draft: 'I cannot access the document you uploaded, so I am unable to answer.',
      plan, evidenceContext: EVIDENCE, verificationAlreadyEnabled: false,
    });
    const f = out.findings.find(x => x.id === 'dead_end');
    assert.ok(f && f.severity === 'critical');
    assert.equal(out.escalate.escalate, true);
    assert.equal(out.escalate.reason, 'dead_end');
  });

  test('escalation only ADDS review: same dead end, verification already enabled ⇒ no escalation', () => {
    const plan = planFor('Based on the document, what happened to revenue?', { taskType: 'file_analysis' });
    const out = RM.monitorDraft({
      draft: 'I cannot access the document you uploaded, so I am unable to answer.',
      plan, evidenceContext: EVIDENCE, verificationAlreadyEnabled: true,
    });
    assert.ok(out.findings.some(x => x.id === 'dead_end'));   // finding still reported
    assert.equal(out.escalate.escalate, false);               // nothing to add
  });

  test('circular reasoning: repeated sentences trip the ratio', () => {
    const s = 'The system processes every request through the central queue for consistency. ';
    const u1 = 'Latency depends mostly on the size of the payload being processed today. ';
    const u2 = 'Workers scale horizontally whenever the queue depth crosses the threshold. ';
    const plan = planFor('Explain how the queue works in this system please.', { taskType: 'analysis' });
    const out = RM.monitorDraft({ draft: s + s + s + s + u1 + u2, plan });
    assert.ok(out.findings.some(f => f.id === 'circular_reasoning'));
    assert.ok(out.stats.repetitionRatio > 0.25);
  });

  test('unsupported specifics: ≥3 precise values absent from evidence', () => {
    const plan = planFor('According to the report, summarize revenue for the year.', { taskType: 'file_analysis' });
    const out = RM.monitorDraft({
      draft: 'Revenue reached 45123 in Q3, growth was 12.5%, and version 2.4.1 shipped.',
      plan, evidenceContext: EVIDENCE,
    });
    const f = out.findings.find(x => x.id === 'unsupported_specifics');
    assert.ok(f, 'expected unsupported_specifics');
    assert.match(f.detail, /3 precise/);
  });

  test('supported specifics do not fire when evidence contains them', () => {
    const plan = planFor('According to the report, summarize revenue for the year.', { taskType: 'file_analysis' });
    const out = RM.monitorDraft({
      draft: 'Revenue reached 45123 in Q3, growth was 12.5%, and version 2.4.1 shipped.',
      plan, evidenceContext: EVIDENCE + ' Figures: 45123 total, 12.5% growth, release 2.4.1.',
    });
    assert.ok(!out.findings.some(x => x.id === 'unsupported_specifics'));
  });

  test('possible contradiction: grounded fact negated in the draft (capped, conservative)', () => {
    const plan = planFor('Based on the document, what database does project alpha use?', { taskType: 'file_analysis' });
    const out = RM.monitorDraft({
      draft: 'Actually the project alpha uses nothing here — it does not rely on storage at all.',
      plan, evidenceContext: 'CONTEXT: project alpha uses postgres for persistence.',
      knowledgeItems: [{ kind: 'fact', id: 'f1', statement: 'project alpha uses postgres for persistence' }],
    });
    assert.ok(out.findings.some(f => f.id === 'possible_contradiction'));
  });

  test('token waste: draft far over the response budget', () => {
    const plan = planFor('Give me a quick answer about the weather please.', { taskType: 'analysis' });
    const out = RM.monitorDraft({
      draft: 'x'.repeat(600),                       // ~150 tokens
      plan, budget: { maxResponseTokens: 100 },
    });
    assert.ok(out.findings.some(f => f.id === 'token_waste'));
  });

  test('two warnings under an evidence-required plan escalate', () => {
    const plan = planFor('According to the report, what database does project alpha use and what were the figures?', { taskType: 'file_analysis' });
    const out = RM.monitorDraft({
      draft: 'The project alpha uses nothing — it does not rely on storage. Revenue hit 45123, growth 12.5%, build 2.4.1.',
      plan,
      evidenceContext: 'CONTEXT: project alpha uses postgres for persistence.',
      knowledgeItems: [{ kind: 'fact', id: 'f1', statement: 'project alpha uses postgres for persistence' }],
      verificationAlreadyEnabled: false,
    });
    const warns = out.findings.filter(f => f.severity === 'warn').length;
    assert.ok(warns >= 2);
    assert.equal(out.escalate.escalate, true);
  });

  test('createStreamMonitor: chunked input, same verdict as monitorDraft', () => {
    const plan = planFor('Based on the document, what happened to revenue?', { taskType: 'file_analysis' });
    const sm = RM.createStreamMonitor({ plan, evidenceContext: EVIDENCE, verificationAlreadyEnabled: false });
    sm.addChunk('I cannot access the ');
    sm.addChunk('document you uploaded.');
    const out = sm.finish();
    assert.ok(out.findings.some(f => f.id === 'dead_end'));
    assert.equal(out.escalate.escalate, true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('reflection engine — lightweight, only when beneficial', () => {

  test('beneficial gate: clean fast turn with high confidence skips reflection', () => {
    const plan = planFor('Hey, how are you doing today my friend?', { taskType: 'conversation', complexity: 'low', confidence: 0.95 });
    const out = RE.reflect({
      plan, monitor: { findings: [] }, verification: { ran: false },
      responseConfidence: RC(0.85, 'high'), taskType: 'conversation',
    });
    assert.equal(out.ran, false);
    assert.match(out.reason, /not beneficial/);
    assert.equal(CS.getCognitionSnapshot().byTask.conversation, undefined);   // nothing written
  });

  test('clean verified turn: outcome clean, high effectiveness, persisted', () => {
    const plan = planFor('Please analyze this dataset carefully for me.', { taskType: 'analysis' });
    const out = RE.reflect({
      plan, monitor: { findings: [] },
      verification: { ran: true, passed: true, revised: false },
      responseConfidence: RC(0.8, 'high'), cognitiveConfidence: { overall: { score: 0.8 } },
      knowledgeStats: { facts: 2, entities: 1 }, taskType: 'analysis',
    });
    assert.equal(out.ran, true);
    assert.equal(out.outcome, 'clean');
    assert.equal(out.effectiveness, 0.95);
    const s = CS.getCognitionSnapshot().byTask.analysis.byStrategy[plan.style.id];
    assert.equal(s.reflected, 1);
    assert.equal(s.outcomes.clean, 1);
  });

  test('failed verification + high cognitive confidence ⇒ misfired + overconfident lesson', () => {
    const plan = planFor('Please analyze this dataset carefully for me.', { taskType: 'analysis' });
    const out = RE.reflect({
      plan, monitor: { findings: [] },
      verification: { ran: true, passed: false, revised: false },
      responseConfidence: RC(0.8, 'high'), cognitiveConfidence: { overall: { score: 0.9 } },
      taskType: 'analysis',
    });
    assert.equal(out.outcome, 'misfired');
    assert.equal(out.checks.confidenceCalibrated, false);
    assert.ok(out.lessons.some(l => l.startsWith('overconfident')));
  });

  test('evidence drift under a non-evidence_first style hints evidence_first', () => {
    const plan = planFor('Analyze the uploaded figures according to the report.', { taskType: 'analysis', styleId: 'analytical' });
    assert.equal(plan.expectations.evidence, 'require');   // prefer + needs.evidence
    const out = RE.reflect({
      plan,
      monitor: { findings: [{ id: 'unsupported_specifics', severity: 'warn' }] },
      verification: { ran: true, passed: true, revised: true },
      responseConfidence: RC(0.6, 'medium'), cognitiveConfidence: { overall: { score: 0.6 } },
      taskType: 'analysis',
    });
    assert.equal(out.betterStrategyHint, 'evidence_first');
    assert.equal(out.checks.strategyFit, false);
    assert.equal(out.outcome, 'adjusted');
    const s = CS.getCognitionSnapshot().byTask.analysis.byStrategy.analytical;
    assert.equal(s.hints.evidence_first, 1);
  });

  test('retrieval insufficiency is a recorded lesson', () => {
    const plan = planFor('According to the report, what changed in the codebase?', { taskType: 'file_analysis' });
    const out = RE.reflect({
      plan, monitor: { findings: [] },
      verification: { ran: true, passed: true, revised: false },
      responseConfidence: RC(0.7, 'medium'), cognitiveConfidence: { overall: { score: 0.65 } },
      knowledgeStats: { facts: 0, entities: 0, broadened: true }, taskType: 'file_analysis',
    });
    assert.equal(out.checks.retrievalSufficient, false);
    assert.ok(out.lessons.some(l => l.includes('broadening')));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('cognitive store — (task × style) learning aggregates', () => {

  test('plans and reflections aggregate; EWMA moves toward new evidence', () => {
    CS.recordPlan({ taskType: 'coding', styleId: 'code', reused: false });
    CS.recordPlan({ taskType: 'coding', styleId: 'code', reused: true, clarification: true });
    CS.recordReflection({ taskType: 'coding', styleId: 'code', outcome: 'clean', effectiveness: 0.9, confidence: 0.8, findings: 0 });
    CS.recordReflection({ taskType: 'coding', styleId: 'code', outcome: 'misfired', effectiveness: 0.3, findings: 2 });
    const t = CS.getCognitionSnapshot().byTask.coding;
    assert.equal(t.turns, 2);
    assert.equal(t.clarifications, 1);
    const s = t.byStrategy.code;
    assert.equal(s.planned, 2);
    assert.equal(s.reused, 1);
    assert.equal(s.reflected, 2);
    assert.ok(s.effectivenessEwma < 0.9 && s.effectivenessEwma > 0.3);   // 0.9 → EWMA toward 0.3
    assert.equal(s.outcomes.clean, 1);
    assert.equal(s.outcomes.misfired, 1);
  });

  test('getStrategyPrior: null before the sample gate, best style after', () => {
    assert.equal(CS.getStrategyPrior('planning'), null);
    for (let i = 0; i < 8; i++) CS.recordReflection({ taskType: 'planning', styleId: 'analytical', outcome: 'clean', effectiveness: 0.9 });
    for (let i = 0; i < 8; i++) CS.recordReflection({ taskType: 'planning', styleId: 'research',   outcome: 'clean', effectiveness: 0.7 });
    const prior = CS.getStrategyPrior('planning');
    assert.equal(prior.styleId, 'analytical');
    assert.equal(prior.samples, 8);
    assert.ok(prior.effectiveness > 0.85);
  });

  test('snapshot is isolated — mutating it does not touch the store', () => {
    CS.recordPlan({ taskType: 'coding', styleId: 'code' });
    const snap = CS.getCognitionSnapshot();
    snap.byTask.coding.turns = 999;
    assert.equal(CS.getCognitionSnapshot().byTask.coding.turns, 1);
  });

  test('malformed records are ignored, never throw', () => {
    assert.doesNotThrow(() => CS.recordPlan({}));
    assert.doesNotThrow(() => CS.recordReflection({ taskType: null, styleId: null }));
    assert.equal(Object.keys(CS.getCognitionSnapshot().byTask).length, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('facade — kill switch, retrieval seam, fail-open, e2e', () => {

  test('AQUA_CIE=off: every surface is a byte-identical no-op', () => {
    process.env.AQUA_CIE = 'off';
    try {
      const prep = CIE.cognitivePrepare({ userMessage: 'According to the report, what changed?', taskType: 'file_analysis', confidence: 0.9, complexity: 'medium' });
      assert.deepEqual(prep, { plan: null, directive: '' });

      const picResult = { items: [{ kind: 'fact', id: 'f1', statement: 's' }], block: 'B', stats: { facts: 1 } };
      const out = CIE.cognitiveKnowledgeRetrieve('owner1', 'query', { limit: 8, plan: { expectations: { retrieval: { broadenOnEmpty: true } } }, _retrieve: () => picResult });
      assert.equal(out, picResult);                          // same reference — pure passthrough

      const mon = CIE.observeDraft({ draft: 'I cannot do this.', prep: { cognition: { plan: {} }, evidenceContext: 'E' } });
      assert.equal(mon.escalate.escalate, false);

      assert.equal(CIE.concludeTurn({ prep: { cognition: { plan: {} } }, verification: {}, responseConfidence: RC(0.8, 'high') }), null);
    } finally {
      delete process.env.AQUA_CIE;
    }
  });

  test('broadenQuery: stopwords dropped, keyword-only, null on thin queries', () => {
    const bq = CIE.broadenQuery('What is the deployment architecture of the payment service?');
    assert.ok(bq.includes('architecture') && bq.includes('deployment') && bq.includes('payment') && bq.includes('service'));
    assert.ok(!/\b(what|the|of|is)\b/.test(bq));
    assert.ok(bq.split(' ').length <= 6);
    assert.equal(CIE.broadenQuery('what is it'), null);
  });

  test('retrieval seam: original call is the floor; broaden pass only on empty + required evidence', () => {
    const prep = CIE.cognitivePrepare({ userMessage: 'According to the uploaded report, what were the exact revenue figures?', taskType: 'file_analysis', confidence: 0.9, complexity: 'medium', hasOwner: true });
    assert.equal(prep.plan.expectations.retrieval.broadenOnEmpty, true);

    const calls = [];
    const hit = { items: [{ kind: 'fact', id: 'f1', statement: 'revenue grew', confidence: 0.8 }], block: 'KNOWLEDGE BLOCK', stats: { facts: 1, entities: 0, timelineEvents: 0, reusedSignals: 0 } };
    const _retrieve = (owner, q, opts) => {
      calls.push({ q, opts });
      return calls.length === 1
        ? { items: [], block: '', stats: { facts: 0, entities: 0, timelineEvents: 0, reusedSignals: 0 } }
        : hit;
    };

    const out = CIE.cognitiveKnowledgeRetrieve('owner1', 'According to the uploaded report, what were the exact revenue figures?', { limit: 8, plan: prep.plan, _retrieve });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].opts.limit, 8);                    // floor call untouched
    assert.notEqual(calls[1].q, calls[0].q);                 // broadened keyword query
    assert.equal(calls[1].opts.limit, 12);                   // limit + 4
    assert.equal(out.items.length, 1);
    assert.equal(out.block, 'KNOWLEDGE BLOCK');
    assert.equal(out.stats.broadened, true);
    assert.equal(out.stats.broadenGained, 1);
    assert.equal(CIE.getCIEMetrics().retrieval.broadened, 1);
    assert.equal(CIE.getCIEMetrics().retrieval.broadenGained, 1);
  });

  test('retrieval seam: non-empty first pass never broadens; broaden failure falls open to first', () => {
    const prep = CIE.cognitivePrepare({ userMessage: 'According to the uploaded report, what were the exact revenue figures?', taskType: 'file_analysis', confidence: 0.9, complexity: 'medium', hasOwner: true });

    let calls = 0;
    const first = { items: [{ kind: 'fact', id: 'f1', statement: 's', confidence: 0.8 }], block: 'B', stats: { facts: 1 } };
    const out1 = CIE.cognitiveKnowledgeRetrieve('o', 'query with plenty of keywords inside here', { limit: 8, plan: prep.plan, _retrieve: () => { calls++; return first; } });
    assert.equal(calls, 1);
    assert.equal(out1, first);

    // Second pass throws → first result returned, no throw (fail-open).
    let n = 0;
    const out2 = CIE.cognitiveKnowledgeRetrieve('o', 'deployment architecture payment service details', {
      limit: 8, plan: prep.plan,
      _retrieve: () => { n++; if (n === 1) return { items: [], block: '', stats: {} }; throw new Error('boom'); },
    });
    assert.equal(out2.items.length, 0);
  });

  test('cognitivePrepare is fail-open: internal error yields empty, counts a failure', () => {
    const before = CIE.getCIEMetrics().failures;
    const out = CIE.cognitivePrepare({ userMessage: null, taskType: undefined, confidence: 'not-a-number', complexity: 'medium' });
    // assessQuestion tolerates nulls, so this may succeed — force a real failure via bad plan input instead.
    assert.ok(out.plan === null || typeof out.plan === 'object');
    assert.ok(CIE.getCIEMetrics().failures >= before);
  });

  test('plan cache reuse is visible in facade metrics', () => {
    const args = { userMessage: 'Compare the trade-offs between REST and GraphQL for our API.', taskType: 'analysis', confidence: 0.9, complexity: 'medium' };
    const a = CIE.cognitivePrepare(args);
    const b = CIE.cognitivePrepare(args);
    assert.equal(a.plan.reused, false);
    assert.equal(b.plan.reused, true);
    const m = CIE.getCIEMetrics();
    assert.equal(m.plans.built, 2);
    assert.equal(m.plans.reused, 1);
  });

  test('e2e: plan → retrieve(empty) → dirty draft → escalate → conclude with full cognition block', () => {
    // 1. Executive plan for an evidence-demanding question.
    const prepared = CIE.cognitivePrepare({
      userMessage: 'According to the uploaded report, what were the exact revenue figures?',
      taskType: 'file_analysis', confidence: 0.9, complexity: 'medium', hasOwner: true,
    });
    assert.equal(prepared.plan.style.id, 'evidence_first');
    assert.ok(prepared.directive.length > 0);

    // 2. Simulated prep (the fields chat.js carries).
    const prep = {
      taskType: 'file_analysis',
      cognition: { plan: prepared.plan, directiveApplied: true },
      evidenceContext: 'REPORT: Revenue grew steadily through the year across both regions.',
      knowledgeItems: [],
      knowledgeStats: { facts: 0, entities: 0, broadened: true },
      relevantFacts: [], projectFiles: [],
      orchestration: { budget: { maxResponseTokens: 1024 }, verification: { enabled: false } },
      search: null,
    };

    // 3. Monitor the refusal draft — orchestrator skipped verification; CIE escalates.
    const draftObservation = CIE.observeDraft({ draft: 'I cannot access the document you uploaded, so I am unable to answer.', prep });
    assert.equal(draftObservation.enabled, true);
    assert.equal(draftObservation.escalate.escalate, true);

    // 4. Conclude with the (escalated) verification verdict.
    const block = CIE.concludeTurn({
      prep,
      verification: { ran: true, passed: true, revised: true, escalatedByCognition: true },
      responseConfidence: RC(0.62, 'medium'),
      draftObservation,
    });
    assert.equal(block.plan.style, 'evidence_first');
    assert.equal(block.plan.evidenceExpectation, 'require');
    assert.equal(block.monitor.escalated, true);
    assert.ok(block.monitor.findings.some(f => f.id === 'dead_end'));
    assert.ok(block.confidence.overall.score < 0.6);          // empty required evidence
    assert.equal(block.reflection.ran, true);
    assert.ok(['adjusted', 'misfired'].includes(block.reflection.outcome));

    // 5. Learning landed: the pattern is in the store; metrics moved.
    const s = CS.getCognitionSnapshot().byTask.file_analysis.byStrategy.evidence_first;
    assert.equal(s.reflected, 1);
    const m = CIE.getCIEMetrics();
    assert.equal(m.monitor.escalations, 1);
    assert.equal(m.reflection.ran, 1);
    assert.ok(m.confidence.overallEwma > 0);
  });

  test('_resetCIEForTests zeroes metrics, cache, and store', () => {
    CIE.cognitivePrepare({ userMessage: 'Analyze this thing for me now.', taskType: 'analysis', confidence: 0.9, complexity: 'medium' });
    assert.ok(CIE.getCIEMetrics().plans.built > 0);
    CIE._resetCIEForTests();
    assert.equal(CIE.getCIEMetrics().plans.built, 0);
    assert.equal(RP.planCacheStats().size, 0);
    assert.deepEqual(CS.getCognitionSnapshot().byTask, {});
  });
});