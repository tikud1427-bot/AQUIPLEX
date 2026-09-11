/**
AQUA Learning Ledger — Regression Tests (Phase 11)

Covers both halves and every feedback path's cold-start guarantee:

  RECORD     counter/EWMA aggregation, provider sub-buckets, fail-open on
             junk input, snapshot isolation
  FEED BACK  getTaskStats sample gate → shouldVerify learned reasons;
             getProviderPrior sample gate + clamp → router scoreProvider
             delta (asserted as before/after difference so static QUALITY
             and runtime health cancel out)

All tests run with persistence disabled (_resetForTests) — the suite never
touches the real .aqua-ledger.json.
*/
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordOutcome, getTaskStats, getProviderPrior, getLedgerSnapshot,
  _resetForTests, MIN_SAMPLE,
} from './learningLedger.js';
import { shouldVerify } from '../orchestrator/verificationStrategy.js';
import { orchestrate } from '../orchestrator/toolOrchestrator.js';
import { scoreProvider } from '../providers/router.js';

beforeEach(() => _resetForTests());

/** Record n identical outcomes. */
function seed(n, outcome) {
  for (let i = 0; i < n; i++) recordOutcome(outcome);
}

const CLEAN  = { taskType: 'coding', provider: 'groq', responseConfidence: { score: 0.9 }, verification: { ran: true, passed: true, revised: false }, verificationWarranted: true, latencyMs: 800 };
const SHAKY  = { taskType: 'coding', provider: 'groq', responseConfidence: { score: 0.4 }, verification: { ran: true, passed: false, revised: true }, verificationWarranted: true, latencyMs: 2000 };

// ═══ Recording ════════════════════════════════════════════════════════════════

test('aggregates counters and EWMAs per task and per provider — no per-turn arrays', () => {
  seed(3, CLEAN);
  seed(1, SHAKY);
  const snap = getLedgerSnapshot().byTask.coding;
  assert.equal(snap.turns, 4);
  assert.equal(snap.verification.ran, 4);
  assert.equal(snap.verification.revised, 1);
  assert.ok(snap.confidenceEwma > 0.4 && snap.confidenceEwma < 0.9); // moved toward, not equal to, the latest value
  const prov = snap.byProvider.groq;
  assert.equal(prov.turns, 4);
  assert.equal(prov.revised, 1);
  assert.ok(prov.latencyEwma > 800);
  assert.equal(Object.keys(snap).sort().join(','), 'byProvider,confidenceEwma,turns,verification'); // bounded shape
});

test('failed-open verifier (ran:false + error) is tracked distinctly from a run', () => {
  seed(2, { ...CLEAN, verification: { ran: false, error: 'providers exhausted' } });
  const v = getLedgerSnapshot().byTask.coding.verification;
  assert.deepEqual([v.ran, v.failedOpen], [0, 2]);
});

test('recordOutcome is fail-open: junk input never throws, never corrupts', () => {
  recordOutcome();                       // no args
  recordOutcome({ provider: 'groq' });   // no taskType → ignored
  recordOutcome({ taskType: 'coding', responseConfidence: { score: 'NaN-ish' } });
  const snap = getLedgerSnapshot();
  assert.equal(snap.byTask.coding.turns, 1);
  assert.equal(snap.byTask.coding.confidenceEwma, null); // non-numeric score ignored
});

test('snapshot is a deep copy — mutating it cannot corrupt the ledger', () => {
  seed(1, CLEAN);
  const snap = getLedgerSnapshot();
  snap.byTask.coding.turns = 999;
  assert.equal(getLedgerSnapshot().byTask.coding.turns, 1);
});

// ═══ Feedback 1 — adaptive verification ═══════════════════════════════════════

test('getTaskStats: null below the sample gate, stats at/above it', () => {
  seed(MIN_SAMPLE - 1, SHAKY);
  assert.equal(getTaskStats('coding'), null);
  seed(1, SHAKY);
  const stats = getTaskStats('coding');
  assert.equal(stats.sampleSize, MIN_SAMPLE);
  assert.equal(stats.revisionRate, 1);
});

test('learned revision history warrants verification on an otherwise-quiet request', () => {
  seed(MIN_SAMPLE, SHAKY);
  const history = getTaskStats('coding');
  const quiet = { taskType: 'coding', complexity: 'medium', tags: [], userMessage: 'short ask' };
  assert.equal(shouldVerify(quiet).enabled, false);                       // without history: off
  const learned = shouldVerify({ ...quiet, history });
  assert.equal(learned.enabled, true);
  assert.match(learned.reason, /learned: task type historically revision-prone/);
});

test('learned low-confidence history warrants verification when revision rate alone does not', () => {
  seed(MIN_SAMPLE, { ...CLEAN, responseConfidence: { score: 0.35 } });    // clean verifications, weak confidence
  const learned = shouldVerify({ taskType: 'coding', complexity: 'medium', tags: [], userMessage: 'x', history: getTaskStats('coding') });
  assert.equal(learned.enabled, true);
  assert.match(learned.reason, /historically low-confidence/);
});

test('orchestrate forwards history: cold ledger (history:null) decision is byte-identical to the pre-ledger call shape', () => {
  const base = { userMessage: 'tidy question', taskType: 'analysis', confidence: 0.9, hasWorkspaceId: false };
  const cold = orchestrate({ ...base, history: null });
  const omitted = orchestrate(base);
  assert.deepEqual(cold.verification, omitted.verification);
  seed(MIN_SAMPLE, { ...SHAKY, taskType: 'analysis' });
  const warm = orchestrate({ ...base, history: getTaskStats('analysis') });
  assert.equal(warm.verification.enabled, true);
  assert.match(warm.verification.reason, /learned/);
});

// ═══ Feedback 2 — provider prior in router scoring ════════════════════════════

test('provider prior: neutral below sample gate, positive for high-confidence history, clamped at ±6', () => {
  assert.equal(getProviderPrior('groq', 'coding'), 0);
  seed(MIN_SAMPLE, { ...CLEAN, responseConfidence: { score: 0.99 } });
  const prior = getProviderPrior('groq', 'coding');
  assert.ok(prior > 0);
  assert.ok(prior <= 6);
  _resetForTests();
  seed(MIN_SAMPLE, { ...SHAKY, responseConfidence: { score: 0.1 } });
  assert.equal(getProviderPrior('groq', 'coding'), -6); // clamped floor
});

test('scoreProvider delta equals the learned prior exactly — quality and health cancel in before/after', () => {
  const before = scoreProvider('groq', 'coding');
  seed(MIN_SAMPLE, { ...CLEAN, responseConfidence: { score: 0.99 } });
  const after = scoreProvider('groq', 'coding');
  const prior = getProviderPrior('groq', 'coding');
  assert.ok(prior > 0);
  assert.ok(Math.abs((after - before) - prior) < 1e-9);
});

test('cold-start parity: empty ledger leaves provider scores untouched', () => {
  const a = scoreProvider('groq', 'coding');
  const b = scoreProvider('groq', 'coding');
  assert.equal(a, b);
  assert.equal(getProviderPrior('groq', 'coding'), 0);
});
