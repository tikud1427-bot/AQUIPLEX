/**
 * capture-core.v1 — the harness that grades the harness.
 *
 * A published capture number is only worth what the scorer behind it is worth.
 * EVAL-1 and EVAL-3 both caught the same trap before shipping: a naive
 * `tp/(tp+fp)` returns 1.0 when nothing fires, so total silence scores
 * flawless. This suite has the same exposure in a different shape — a
 * retrievability rate whose denominator is "captured cases" reads 0/0 when
 * capture collapses entirely, and 0/0 must not render as success.
 *
 * So the scorer is fed synthetic PERFECT and synthetic EMPTY output and
 * asserted to score 1.00 and 0.00 respectively, plus the two adversarial
 * shapes that would let a broken engine look acceptable.
 *
 * It also asserts the two structural properties the suite is FOR:
 *   1. capture and retrievability are never combined into one number
 *   2. the adapter drives the real production path, not a parallel one
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const suite = (await import('../suites/capture-core.suite.mjs')).default;
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets/capture-core.v1.json'), 'utf8'));

/** Build a scored row without touching the engine — the scorer is pure. */
const row = (over = {}) => ({
  correct: true, cat: 'self_disclosure',
  expectedFacts: 1, capturedFacts: 1,
  fullyCaptured: true, partiallyCaptured: false,
  retrieved: true, top1: true,
  factCount: 1, turnCount: 1,
  ...over,
});

const PERFECT = DS.cases.map(c => row({
  cat: c.cat,
  expectedFacts: c.expect_facts.length,
  capturedFacts: c.expect_facts.length,
  turnCount: c.turns.length,
  factCount: c.expect_facts.length,
}));

const EMPTY = DS.cases.map(c => row({
  cat: c.cat,
  expectedFacts: c.expect_facts.length,
  capturedFacts: 0,
  fullyCaptured: false, partiallyCaptured: false,
  retrieved: false, top1: false,
  factCount: 0,
  turnCount: c.turns.length,
}));

// ── The two required fixtures ────────────────────────────────────────────────

test('PERFECT capture scores 1.00 on both dimensions', () => {
  const m = suite.metrics(PERFECT);
  assert.equal(m.capture_rate, 1, 'capture_rate');
  assert.equal(m.capture_fact_rate, 1, 'capture_fact_rate');
  assert.equal(m.retrievability_rate, 1, 'retrievability_rate');
  assert.equal(m.retrieval_top1_rate, 1, 'retrieval_top1_rate');
  for (const [k, v] of Object.entries(m)) {
    if (k.startsWith('capture_') && k !== 'capture_rate' && k !== 'capture_fact_rate') {
      assert.equal(v, 1, `per-category ${k} must be 1.00 under perfect capture`);
    }
  }
});

test('EMPTY capture scores 0.00 — and retrievability does NOT read 1.00 on an empty denominator', () => {
  const m = suite.metrics(EMPTY);
  assert.equal(m.capture_rate, 0, 'capture_rate');
  assert.equal(m.capture_fact_rate, 0, 'capture_fact_rate');
  // THE TRAP. Zero captured cases means the retrievability denominator is 0.
  // `tp/(tp+fp)`-style arithmetic would return 1 here and a total capture
  // failure would publish "retrievability 100%".
  assert.equal(m.retrievability_rate, 0,
    'retrievability over an empty captured set must be 0.00, never 1.00 — an engine that captures nothing must not score perfectly on the dimension it never reached');
  assert.equal(m.retrieval_top1_rate, 0, 'top1 likewise');
  assert.equal(m.n_captured_cases, 0);
  assert.equal(m.n_captured_but_unreachable, 0,
    'nothing captured means nothing can be unreachable — this count must not go negative or borrow from capture');
});

// ── The adversarial shapes ───────────────────────────────────────────────────

test('captures everything but retrieves nothing — the two dimensions must diverge', () => {
  const m = suite.metrics(PERFECT.map(r => ({ ...r, retrieved: false, top1: false })));
  assert.equal(m.capture_rate, 1, 'capture is perfect');
  assert.equal(m.retrievability_rate, 0, 'retrievability is zero');
  assert.equal(m.n_captured_but_unreachable, DS.cases.length,
    'every captured case is counted as unreachable — this is the write-but-lose bug class and it has its own number');
});

test('a capture collapse cannot hide behind clean retrieval of the survivors', () => {
  // One case captured and retrieved; everything else lost. A combined score
  // would flatter this badly. The two must report it as 1/23 and 100%.
  const scored = EMPTY.map((r, i) => (i === 0
    ? { ...r, capturedFacts: r.expectedFacts, fullyCaptured: true, retrieved: true, top1: true }
    : r));
  const m = suite.metrics(scored);
  assert.ok(m.capture_rate < 0.05, `capture_rate stays low (got ${m.capture_rate})`);
  assert.equal(m.retrievability_rate, 1,
    'retrievability is 100% of the one thing that survived — which is exactly why it must never be averaged with capture');
});

// ── Structural properties ────────────────────────────────────────────────────

test('capture and retrievability are never combined into one number', () => {
  const m = suite.metrics(suite.metrics ? PERFECT.map((r, i) => (i % 2 ? r : { ...r, retrieved: false })) : []);
  // No metric may be a function of both dimensions. The check is behavioural:
  // hold capture fixed, move retrieval, and assert every capture-named metric
  // is unchanged.
  const base = suite.metrics(PERFECT);
  for (const k of Object.keys(base)) {
    if (k.startsWith('capture_') || k === 'n_captured_facts' || k === 'n_expected_facts') {
      assert.equal(m[k], base[k],
        `${k} moved when only RETRIEVAL changed — capture metrics must be independent of retrieval`);
    }
  }
  assert.notEqual(m.retrievability_rate, base.retrievability_rate,
    'retrievability did move, so the fixture actually exercised the difference');
});

test('the suite exposes no single combined "quality" score', () => {
  const m = suite.metrics(PERFECT);
  const banned = Object.keys(m).filter(k => /^(overall|combined|quality|score)$/.test(k));
  assert.deepEqual(banned, [],
    `a headline combined score would let one dimension mask the other; found ${banned.join(', ')}`);
});

// ── Proof the adapter drives production, not a parallel implementation ───────

test('the adapter imports the production modules — no test-only reimplementation', () => {
  const src = readFileSync(path.join(ROOT, 'eval/adapters/currentCapture.mjs'), 'utf8');
  const code = src.split('\n').filter(l => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//')).join('\n');
  for (const mod of [
    'src/routes/turnPostProcess.js',   // the real post-turn seam chat.js calls
    'src/memory/engine.js',            // §2a memoryObserve
    'src/memory/conversationStore.js', // §9 addMessage — feeds turn number + reflect cadence
    'src/pic/core.js',                 // the reader chat.js §5c² calls
    'src/core/jobs/jobRegistry.js',    // the real drain, not an injected defer
  ]) {
    assert.ok(code.includes(mod), `adapter must import ${mod}`);
  }
});

test('the adapter does NOT override runPostTurn dependencies', () => {
  const src = readFileSync(path.join(ROOT, 'eval/adapters/currentCapture.mjs'), 'utf8');
  const code = src.split('\n').filter(l => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//')).join('\n');
  // runPostTurn(args, deps) — a second argument would replace production
  // wiring and the baseline would measure a configuration nobody ships. An
  // earlier draft injected `defer: fn => fn()` for determinism; drainJobs
  // gives the same determinism with every dependency real.
  assert.match(code, /runPostTurn\(\{[^}]*\}\);/s,
    'runPostTurn must be called with ONE argument so REAL_DEPS is used verbatim');
  assert.ok(!/observeConversationTurn\s*:/.test(code),
    'the adapter must not supply its own ingest function');
});

// ── Dataset integrity ────────────────────────────────────────────────────────

test('every case states why it exists, and the census matches the cases', () => {
  for (const c of DS.cases) {
    assert.ok(c.why && c.why.length > 40, `case ${c.id} needs a why — a judgment with no reason cannot be argued with`);
    assert.ok(Array.isArray(c.turns) && c.turns.length > 0, `case ${c.id} needs turns`);
    assert.ok(Array.isArray(c.expect_facts) && c.expect_facts.length > 0, `case ${c.id} needs expectations`);
  }
  assert.equal(DS.census.cases, DS.cases.length, 'census case count');
  assert.equal(DS.census.total_turns, DS.cases.reduce((a, c) => a + c.turns.length, 0), 'census turn count');
});

test('the concurrency category ships a same-turns control', () => {
  const conc = DS.cases.filter(c => c.cat === 'concurrency');
  const batched = conc.filter(c => c.batch === true);
  const control = conc.filter(c => c.batch !== true);
  assert.ok(batched.length >= 1 && control.length >= 1,
    'without a control drained per turn, a concurrency failure cannot be attributed to cadence rather than to the sentences themselves');
  const ctrl = control[0];
  const match = batched.find(b => JSON.stringify(b.turns) === JSON.stringify(ctrl.turns));
  assert.ok(match,
    'the control must use IDENTICAL turns to a batched case, or it controls for nothing');
});
