/**
 * Relevance > filling empty seats (2026-10-04). Generic candidate pools, no
 * benchmark questions. An empty seat is preferable to irrelevant personal
 * information.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleContext, tokensOf, ASSEMBLER_DEFAULTS } from '../contextEngine/assembler.js';

const ctx = (q, semanticScores = null) => ({
  queryTokens: tokensOf(q), semanticScores, activeProjectTokens: new Set(), activeGoalTokens: new Set(),
  focusEntityIds: new Set(), priorEntityIds: new Set(), maxHops: 3,
});
const fact = (id, text, over = {}) => ({ id, kind: 'fact', text, confidence: 0.66, entityIds: [`e-${id}`], via: 'structured:', ...over });
const lines = out => out.block.split('\n').filter(l => l.startsWith('• '));

test('the floor is relative and on by default', () => {
  assert.equal(ASSEMBLER_DEFAULTS.relativeFloor, 0.3);
});

test('one highly relevant candidate is not diluted by many weak ones: empty seats stay empty', () => {
  const sem = new Map([['strong', 0.95], ...Array.from({ length: 6 }, (_, i) => [`w${i}`, 0.05])]);
  const cands = [fact('strong', 'Ledgerly is a budgeting app for freelancers', { semanticId: 'strong' }),
    ...Array.from({ length: 6 }, (_, i) => fact(`w${i}`, `I had coffee on day ${i}`, { semanticId: `w${i}`, confidence: 0.9 }))];
  const out = assembleContext(cands, ctx('What does Ledgerly do?', sem), { limit: 8 });
  assert.match(lines(out)[0] ?? '', /budgeting app/);
  assert.equal(lines(out).length, 1, `prior-only candidates filled the free seats:\n${out.block}`);
  assert.equal(out.stats.contextEngine.dropReasons['no-relevance-signal'], 6);
});

test('without ANY relevance-backed candidate, the relevance rule removes nothing', () => {
  const out = assembleContext([fact('a', 'zz yy'), fact('b', 'qq ww')], ctx('Where do I live?'), { limit: 8 });
  assert.equal(out.stats.contextEngine.dropReasons['no-relevance-signal'] ?? 0, 0);
});

test('a candidate selected by anchor/predicate (structured lane) or filling a slot counts as relevant', () => {
  const sem = new Map([['strong', 0.95]]);
  const out = assembleContext([
    fact('strong', 'Ledgerly is a budgeting app', { semanticId: 'strong' }),
    fact('lane', 'zz qq', { lanes: ['structured'] }),
    fact('slot', 'yy ww', { slotIds: ['deadline'] }),
  ], ctx('What does Ledgerly do?', sem), { limit: 8 });
  assert.equal(lines(out).length, 3);
});

test('a pool with no strong candidate is judged relative to its own best, not emptied', () => {
  const cands = [fact('a', 'Ledgerly uses Postgres'), fact('b', 'Ledgerly hired a designer')];
  const out = assembleContext(cands, ctx('Tell me about Ledgerly'), { limit: 8 });
  assert.equal(lines(out).length, 2);
});

test('candidates below the absolute floor are never admitted, whatever is free', () => {
  const out = assembleContext([fact('x', 'zzz qqq', { confidence: 0 , importance: 0 })], ctx('Where do I live?'), { limit: 8, minScore: 0.9 });
  assert.equal(lines(out).length, 0);
});

test('subject match outranks subject mismatch', () => {
  const sem = new Map([['m', 0.8], ['n', 0.2]]);
  const out = assembleContext([
    fact('n', 'Priya works at Stripe', { semanticId: 'n' }),
    fact('m', 'I work at Quillbase', { semanticId: 'm' }),
  ], ctx('Where do I work?', sem), { limit: 8 });
  assert.match(lines(out)[0] ?? '', /Quillbase/);
});

test('a current fact outranks its superseded predecessor on a current-state question', () => {
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const out = assembleContext([
    fact('old', 'I live in Berlin', { validTo: past }),
    fact('new', 'I live in Rome', { validTo: null }),
  ], ctx('Where do I live?'), { limit: 8 });
  assert.match(lines(out)[0] ?? '', /Rome/);
});

test('contradictory claims are both shown, the disputed one marked as contested', () => {
  const out = assembleContext([
    fact('a', 'The launch is blocked by reliability', { disputed: true }),
    fact('b', 'The reliability blocker is resolved', { disputed: true }),
  ], ctx('Is the launch blocked?'), { limit: 8 });
  assert.equal(lines(out).filter(l => /disputed — treat as contested/.test(l)).length, 2);
});

test('low-confidence claims do not crowd out strong evidence', () => {
  const cands = [fact('strong', 'I report to Tamsin', { confidence: 0.9 }),
    ...Array.from({ length: 8 }, (_, i) => fact(`low${i}`, `Maybe I report to someone ${i}`, { confidence: 0.1 }))];
  const out = assembleContext(cands, ctx('Who do I report to?'), { limit: 4 });
  assert.match(lines(out)[0] ?? '', /Tamsin/);
});
