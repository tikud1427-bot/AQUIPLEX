/**
 * Consolidation runs on a cadence — audit M6.
 *
 * Everything needed to mature knowledge already existed: `consolidationEngine`
 * merges duplicates, promotes corroborated claims to trusted, and marks stale
 * ones stale. It had exactly one trigger — a human calling
 * `POST /intelligence/maintain`. So in practice knowledge accumulated forever
 * and never matured.
 *
 * These tests cover the cadence seam, not the consolidation algorithm, which
 * has its own coverage. What matters here: does it fire, does it fire at the
 * right interval, does it stay off when the flag is off, and can it hurt a turn.
 *
 * THE CLOCK IS OWNER-SCOPED ON PURPOSE
 * ------------------------------------
 * Reflection keys off `getConversation(id).length`. That is right for
 * reflection and wrong here: consolidation operates across an owner's whole
 * corpus, and most conversations are far shorter than the interval, so a
 * conversation-scoped counter would almost never reach it. `mind.turnCount` is
 * already persisted and already owner-scoped.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-consol-'));

const { runPostTurn, _resetConsolidationWatermark } = await import('../turnPostProcess.js');
const PIC = await import('../../pic/core.js');

const O = 'user:ananya';

/** Minimal deps: every stage a no-op except the one under test. */
function deps({ turns = 0, onConsolidate = () => {}, enabled = true } = {}) {
  return {
    memoryAfterTurn: () => {},
    getConversation: () => new Array(4),
    observeConversationTurn: () => {},
    observeTwin: () => {},
    reflectTurn: () => {},
    defer: (fn) => fn(),               // run inline so assertions are synchronous
    reflectEvery: 8,
    consolidate: onConsolidate,
    consolidateEnabled: () => enabled,
    consolidateEvery: 25,
    ownerTurnCount: () => turns,
  };
}

const turn = (d) => runPostTurn({
  ownerId: O, conversationId: 'c1',
  userMessage: 'hello', assistantMessage: 'hi',
}, d);

beforeEach(() => _resetConsolidationWatermark());
afterEach(() => { delete process.env.AQUA_CONSOLIDATE; });

// ── The cadence ─────────────────────────────────────────────────────────────

test('does not consolidate before the interval is reached', () => {
  let calls = 0;
  turn(deps({ turns: 24, onConsolidate: () => { calls += 1; } }));
  assert.equal(calls, 0);
});

test('consolidates once the interval is reached', () => {
  let calls = 0;
  turn(deps({ turns: 25, onConsolidate: () => { calls += 1; } }));
  assert.equal(calls, 1);
});

test('does not consolidate again until another interval has passed', () => {
  let calls = 0;
  const at = (turns) => turn(deps({ turns, onConsolidate: () => { calls += 1; } }));

  at(25); assert.equal(calls, 1, 'first pass');
  at(26); assert.equal(calls, 1, 'one turn later — not due');
  at(49); assert.equal(calls, 1, 'still short of the next interval');
  at(50); assert.equal(calls, 2, 'second pass');
});

test('a watermark, not a modulo — a skipped turn does not skip the cadence', () => {
  // The counter is incremented by another subsystem and this hook is
  // fail-open, so exact multiples cannot be relied on. `turnCount % every`
  // would silently never fire for an owner whose turns land on 24, 26, 51…
  let calls = 0;
  turn(deps({ turns: 37, onConsolidate: () => { calls += 1; } }));
  assert.equal(calls, 1, 'due is due, even at a non-multiple');
});

test('an owner with no recorded turns is left alone', () => {
  let calls = 0;
  turn(deps({ turns: 0, onConsolidate: () => { calls += 1; } }));
  assert.equal(calls, 0, 'no mind yet means no corpus worth consolidating');
});

// ── The flag ────────────────────────────────────────────────────────────────

test('nothing runs when the flag is off, however overdue', () => {
  let calls = 0;
  turn(deps({ turns: 10_000, enabled: false, onConsolidate: () => { calls += 1; } }));
  assert.equal(calls, 0);
});

test('the flag is off by default and subordinate to PIC', () => {
  assert.equal(PIC.consolidateEnabled(), false, 'off unless explicitly enabled');

  process.env.AQUA_CONSOLIDATE = 'on';
  assert.equal(PIC.consolidateEnabled(), true);

  process.env.AQUA_PIC = 'off';
  assert.equal(PIC.consolidateEnabled(), false, 'PIC off disables it too');
  delete process.env.AQUA_PIC;
});

// ── It cannot hurt the turn ─────────────────────────────────────────────────

test('a throwing consolidation does not break the post-turn hook', () => {
  assert.doesNotThrow(() => turn(deps({
    turns: 100,
    onConsolidate: () => { throw new Error('store on fire'); },
  })));
});

test('a throwing consolidation still does not retry immediately', () => {
  // The watermark advances BEFORE the call, so a failing pass waits for the
  // next interval rather than retrying every turn against a broken store.
  let calls = 0;
  const boom = () => { calls += 1; throw new Error('nope'); };

  turn(deps({ turns: 25, onConsolidate: boom }));
  turn(deps({ turns: 26, onConsolidate: boom }));
  assert.equal(calls, 1);
});

test('the earlier stages still run when consolidation is due', () => {
  const seen = [];
  const d = deps({ turns: 100, onConsolidate: () => seen.push('consolidate') });
  d.memoryAfterTurn = () => seen.push('memory');
  d.observeConversationTurn = () => seen.push('ingest');
  d.reflectTurn = () => seen.push('reflect');
  d.getConversation = () => new Array(8);   // divisible by reflectEvery

  turn(d);

  assert.deepEqual(seen, ['memory', 'ingest', 'reflect', 'consolidate'],
    'consolidation is last — a heavier pass must not delay the lighter stages');
});

// ── The entry point itself ──────────────────────────────────────────────────

test('PIC.consolidate is inert without an owner or with PIC off', () => {
  assert.equal(PIC.consolidate(null).skipped, true);

  process.env.AQUA_PIC = 'off';
  assert.equal(PIC.consolidate(O).skipped, true);
  delete process.env.AQUA_PIC;
});

test('PIC.consolidate reports rather than throws when the store misbehaves', () => {
  const res = PIC.consolidate(O, {
    deps: { evidenceStore: { listFacts() { throw new Error('down'); } } },
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /down/);
});
