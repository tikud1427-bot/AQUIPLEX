/**
 * The Context Engine seats a later word beside what it continues (assembler
 * 2b, 2026-11-02), and renders what it selects.
 *
 * Pure: assembleContext over hand-built candidates shaped like PIC floor
 * facts (legacy: `timestamp`, no `understood`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleContext, tokensOf } from '../contextEngine/assembler.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);
const ctx = q => ({
  queryTokens: tokensOf(q), semanticScores: null, activeProjectTokens: new Set(), activeGoalTokens: new Set(),
  focusEntityIds: new Set(), priorEntityIds: new Set(), maxHops: 3,
});
const fact = (id, text, day, extra = {}) => ({
  id, kind: 'fact', text, confidence: 0.6, entityIds: [`e-${id}`], via: 'lexical', lanes: ['lexical'],
  sourceType: 'conversation', timestamp: T0 + day * DAY, citations: [], continuationOf: [], ...extra,
});
const Q = 'Is anything still blocking the San Antonio opening?';
const blocker = () => fact('blocker', 'Now the San Antonio opening is blocked by a zoning permit.', 7);
const resolution = (extra = {}) => fact('res', 'The zoning permit came through.', 14, { via: 'continuation: stored link', lanes: ['unknown'], continuationOf: ['blocker'], ...extra });
const lineOf = (block, re) => block.split('\n').findIndex(l => re.test(l));

// Competition the way a real context has it: with one seat, relevance alone
// gives it to the blocker and the resolution loses.
test('a continuation that lost on the question\'s words is seated after what it continues', () => {
  const plain = assembleContext([blocker(), resolution({ continuationOf: [] })], ctx(Q), { limit: 1 });
  assert.equal(lineOf(plain.block, /came through/), -1, 'control: untagged, it loses the seat');
  const out = assembleContext([blocker(), resolution()], ctx(Q), { limit: 1 });
  const b = lineOf(out.block, /blocked by a zoning permit/);
  const r = lineOf(out.block, /came through/);
  assert.ok(b >= 0);
  assert.ok(r > b, 'rendered after it, oldest → newest');
  assert.equal(out.stats.contextEngine.continuations, 1);
});

test('without its predecessor selected, a continuation is not seated', () => {
  const date = fact('date', 'The San Antonio opening date is set for July 12, the opening is not blocked.', 15);
  const out = assembleContext([date, resolution()], ctx(Q), { limit: 1 });
  assert.equal(lineOf(out.block, /came through/), -1);
  assert.equal(out.stats.contextEngine.continuations, 0);
});

test('a full budget makes room by displacing the weakest pick, never what is continued', () => {
  const fillers = Array.from({ length: 6 }, (_, i) => fact(`f${i}`, `The San Antonio opening checklist item ${i} is about paint colours and shelving and signage.`, 1));
  const roomy = assembleContext([blocker(), ...fillers], ctx(Q), { charBudget: 900 });
  const charBudget = roomy.block.length + 2;   // the same picks, and no room left
  const without = assembleContext([blocker(), ...fillers], ctx(Q), { charBudget });
  assert.equal(without.items.length, roomy.items.length, 'control: the budget is binding, not cutting');
  const out = assembleContext([blocker(), ...fillers, resolution()], ctx(Q), { charBudget });
  assert.ok(lineOf(out.block, /came through/) >= 0, 'seated');
  assert.ok(lineOf(out.block, /blocked by a zoning permit/) >= 0, 'what it continues stays');
  assert.ok(out.block.length <= charBudget, 'within the budget');
  assert.equal(out.stats.contextEngine.dropReasons['displaced-by-continuation'], 1);
});

test('at most two continuations', () => {
  const cands = [blocker(), ...[0, 1, 2].map(i => fact(`c${i}`, `Update ${i}: it came through.`, 10 + i,
    { via: 'continuation: stored link', lanes: ['unknown'], continuationOf: ['blocker'] }))];
  const out = assembleContext(cands, ctx(Q), { limit: 1 });
  assert.equal(out.stats.contextEngine.continuations, 2);
});

test('legacy dated facts: every selected line is rendered, the newest included', () => {
  // The order note is printed for dated legacy facts; it used to be budgeted
  // only for canonical claims, and the overflow cut the LAST (newest) line.
  const lines = Array.from({ length: 8 }, (_, i) => fact(`l${i}`, `Statement ${i} about the San Antonio opening and the zoning permit and the SBA loan schedule.`, i));
  const out = assembleContext(lines, ctx(Q), { charBudget: 1600 });
  assert.match(out.block, /oldest → newest/);
  for (const it of out.items) assert.ok(out.block.includes(it.statement), `selected and rendered: ${it.statement}`);
});
