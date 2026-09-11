/**
 * Post-turn seam (Phase 2, step 1) — the wiring behind the Phase 0 flags.
 *
 * WHY THIS FILE EXISTS
 * Phase 0 shipped four flags that activate code reachable ONLY through this
 * seam, and the seam had no coverage at all. `flagproof.mjs` proved each
 * module works; nothing proved chat.js called them correctly, in the right
 * order, with the right arguments. That was audit risk P0-5. This closes it.
 *
 * The guarantees under test:
 *   NO-OP EXTRACTION  same calls, same order, same arguments as the block
 *                     that was inline in both endpoints.
 *   USER ONLY         the Twin never sees the assistant's message — that
 *                     would be a closed loop manufacturing its own evidence.
 *   FAIL-OPEN         any subsystem can throw and the others still run; the
 *                     caller never sees an exception.
 *   OFF THE HOT PATH  nothing but the Mind's post-turn runs synchronously.
 *   ORDER             ingest lands before reflection, so reflection reflects
 *                     on the turn just absorbed.
 *   CADENCE           reflection fires only on the Mind's interval.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-postturn-'));

const { runPostTurn } = await import('../turnPostProcess.js');

const TURN = {
  ownerId: 'user:ananya',
  conversationId: 'c1',
  userMessage: 'Priya owns billing.',
  assistantMessage: 'Understood — Priya owns billing.',
  taskType: 'general',
  workspaceId: 'w1',
};

let calls;

/** Deps that record instead of acting. `defer` runs inline so tests stay sync. */
function spyDeps(overrides = {}, { conversationLength = 4 } = {}) {
  return {
    memoryAfterTurn: (...a) => calls.push(['memoryAfterTurn', ...a]),
    getConversation: () => new Array(conversationLength),
    observeConversationTurn: (a) => calls.push(['ingest', a]),
    observeTwin: (a) => calls.push(['twin', a]),
    reflectTurn: (a) => calls.push(['reflect', a]),
    defer: (fn) => fn(),
    reflectEvery: 8,
    ...overrides,
  };
}

const names = () => calls.map(c => c[0]);
const find = (n) => calls.find(c => c[0] === n)?.[1];

beforeEach(() => { calls = []; });

// ── NO-OP EXTRACTION ─────────────────────────────────────────────────────────

test('every subsystem the inline block called is still called, in order', () => {
  runPostTurn(TURN, spyDeps({}, { conversationLength: 8 }));
  assert.deepEqual(names(), ['memoryAfterTurn', 'ingest', 'twin', 'reflect']);
});

test('ingest receives the same arguments the inline block passed', () => {
  runPostTurn(TURN, spyDeps({}, { conversationLength: 8 }));
  assert.deepEqual(find('ingest'), {
    ownerId: 'user:ananya',
    conversationId: 'c1',
    turn: 8,
    userMessage: 'Priya owns billing.',
    assistantMessage: 'Understood — Priya owns billing.',
  });
});

test('Mind post-turn receives taskType and workspaceId', () => {
  runPostTurn(TURN, spyDeps());
  const call = calls.find(c => c[0] === 'memoryAfterTurn');
  assert.equal(call[1], 'user:ananya');
  assert.deepEqual(call[2], { taskType: 'general', workspaceId: 'w1' });
});

// ── USER ONLY ────────────────────────────────────────────────────────────────

test('the Twin sees the USER message and never the assistant\'s', () => {
  runPostTurn(TURN, spyDeps());
  const twin = find('twin');
  assert.equal(twin.userMessage, TURN.userMessage);
  assert.ok(!('assistantMessage' in twin),
    'inferring the user\'s style from AQUA\'s own output would manufacture its own evidence');
  assert.equal(Object.values(twin).includes(TURN.assistantMessage), false);
});

// ── ORDER ────────────────────────────────────────────────────────────────────

test('ingest lands before reflection', () => {
  runPostTurn(TURN, spyDeps({}, { conversationLength: 8 }));
  assert.ok(names().indexOf('ingest') < names().indexOf('reflect'),
    'reflection must reflect on the turn just absorbed, not the one before it');
});

// ── CADENCE ──────────────────────────────────────────────────────────────────

test('reflection fires only on the Mind\'s interval', () => {
  runPostTurn(TURN, spyDeps({}, { conversationLength: 8 }));
  assert.ok(names().includes('reflect'), '8 % 8 === 0 → due');

  calls = [];
  runPostTurn(TURN, spyDeps({}, { conversationLength: 9 }));
  assert.ok(!names().includes('reflect'), '9 % 8 !== 0 → not due');

  calls = [];
  runPostTurn(TURN, spyDeps({}, { conversationLength: 16 }));
  assert.ok(names().includes('reflect'));
});

// ── FAIL-OPEN ────────────────────────────────────────────────────────────────

test('a throwing ingest does not stop the Twin', () => {
  runPostTurn(TURN, spyDeps({
    observeConversationTurn: () => { throw new Error('graph exploded'); },
  }));
  assert.ok(names().includes('twin'), 'the Twin runs even when ingest fails');
});

test('a throwing Mind post-turn does not stop the deferred work', () => {
  runPostTurn(TURN, spyDeps({
    memoryAfterTurn: () => { throw new Error('mind exploded'); },
  }, { conversationLength: 8 }));
  assert.deepEqual(names(), ['ingest', 'twin', 'reflect']);
});

test('a throwing reflection is swallowed', () => {
  assert.doesNotThrow(() => runPostTurn(TURN, spyDeps({
    reflectTurn: () => { throw new Error('reflection exploded'); },
  }, { conversationLength: 8 })));
});

test('every subsystem failing at once still never reaches the caller', () => {
  const boom = () => { throw new Error('everything is on fire'); };
  assert.doesNotThrow(() => runPostTurn(TURN, spyDeps({
    memoryAfterTurn: boom, observeConversationTurn: boom,
    observeTwin: boom, reflectTurn: boom, getConversation: boom,
  })), 'the user has already been answered — nothing here may surface');
});

// ── OFF THE HOT PATH ─────────────────────────────────────────────────────────

test('only the Mind post-turn runs synchronously; the rest is deferred', () => {
  const deferred = [];
  runPostTurn(TURN, spyDeps({ defer: (fn) => deferred.push(fn) }, { conversationLength: 8 }));

  assert.deepEqual(names(), ['memoryAfterTurn'],
    'nothing else may run before the response is sent');
  // Three ticks: ingest+twin, then reflection, then consolidation. The last
  // one is separate rather than appended to reflection's tick because a
  // consolidation pass is heavy (~90ms at 2k facts) and synchronous — its own
  // macrotask lets the event loop serve other requests in between. Pinned
  // deliberately: if a future stage is quietly folded into an existing tick,
  // that is a latency change and this assertion should be the thing that says so.
  //
  // FOUR SINCE E6 (blueprint §8). This assertion did its job: adding the
  // understanding seam was a latency change and it refused to pass silently.
  // The justification for a separate tick rather than folding it into the
  // ingest one is ISOLATION, not weight — E6's deferred body only kicks off a
  // promise and returns, so it costs one macrotask scheduling and nothing else.
  // Sharing ingest's tick would put a synchronous throw during E6 setup in
  // front of the twin observation that follows it in the same callback.
  assert.equal(deferred.length, 4, 'ingest+twin, reflection, consolidation, E6');

  for (const fn of deferred) fn();
  // E6 is ABSENT from this list on purpose: AQUA_E6 defaults to off, so its
  // tick runs and does nothing. That is the production default, and the whole
  // safety argument for wiring an extractor that fails its own negation gate.
  assert.deepEqual(names(), ['memoryAfterTurn', 'ingest', 'twin', 'reflect']);
});

test('real deferral is setImmediate, not synchronous', async () => {
  const seen = [];
  runPostTurn(TURN, spyDeps({
    memoryAfterTurn: () => seen.push('sync'),
    observeConversationTurn: () => seen.push('deferred'),
    defer: setImmediate,
  }));
  assert.deepEqual(seen, ['sync'], 'deferred work has not run yet');
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.ok(seen.includes('deferred'));
});

// ── DEFAULTS ─────────────────────────────────────────────────────────────────

test('the real wiring is used when no deps are injected', () => {
  assert.doesNotThrow(() => runPostTurn({
    ownerId: 'user:nobody', conversationId: 'missing',
    userMessage: 'hi', assistantMessage: 'hello',
  }), 'the default path must be fail-open against a conversation that does not exist');
});