/**
 * Question-aware cognitive-block selection is OFF by default (2026-11-06).
 *
 * mindRetriever.js questionScope keeps a goal, blocker, deadline or prediction on
 * a targeted question only when it shares a word with it. That dropped goals the
 * user asked about in other words ("a 21 km race" for a half marathon, "career"
 * for a promotion — test.todo in cognitiveRelevanceSynonyms.test.js), so it runs
 * only when AQUA_MIND_RELEVANCE is exactly "on" until related-phrase matching
 * exists. These tests pin the gate and both behaviours; the selection itself is
 * tested ON in cognitiveRelevance*.test.js.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-mind-relevance-default-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
delete process.env.AQUA_MIND_RELEVANCE;

const { createEmptyMind } = await import('../mindSchema.js');
const { trackGoals } = await import('../goalTracker.js');
const { retrieveCognitiveContext, mindRelevanceEnabled } = await import('../mindRetriever.js');
const { GATES } = await import('../../core/flags.js');

afterEach(() => { delete process.env.AQUA_MIND_RELEVANCE; });

const mind = () => {
  const m = createEmptyMind('user:relevance-default');
  for (const t of ['My goal is to run a half marathon in October.', 'My goal is to learn Spanish this year.']) trackGoals(m, { userMessage: t });
  return m;
};
const goals = q => retrieveCognitiveContext(mind(), { query: q }).block.match(/Active goals: ([^\n]*)/)?.[1] ?? '';

describe('the gate', () => {
  test('unset, empty and every value other than "on" mean OFF', () => {
    assert.equal(mindRelevanceEnabled(), false, 'unset');
    for (const v of ['', 'off', 'true', '1', 'yes', 'enabled']) { process.env.AQUA_MIND_RELEVANCE = v; assert.equal(mindRelevanceEnabled(), false, JSON.stringify(v)); }
  });
  test('exactly "on" (case-insensitive, trimmed) means ON', () => {
    for (const v of ['on', 'ON', ' On ']) { process.env.AQUA_MIND_RELEVANCE = v; assert.equal(mindRelevanceEnabled(), true, JSON.stringify(v)); }
  });
  test('the registry records it as an OFF-by-default gate read as === "on"', () => {
    const g = GATES.find(x => x.name === 'AQUA_MIND_RELEVANCE');
    assert.equal(g?.dflt, 'off');
    assert.equal(g?.inverted, undefined);
  });
});

describe('both behaviours', () => {
  test('OFF (default): the previous selection — the active goals ride along on any question', () => {
    assert.match(goals('How far is a 21 km race?'), /half marathon/, 'the related-phrase case keeps its goal');
    assert.match(goals('Where do I work?'), /half marathon/);
  });
  test('ON (explicit): question-aware — a targeted question keeps only what it is about', () => {
    process.env.AQUA_MIND_RELEVANCE = 'on';
    assert.match(goals("How's my marathon training?"), /half marathon/);
    assert.doesNotMatch(goals("How's my marathon training?"), /Spanish/);
    assert.equal(goals('Where do I work?'), '', 'an unrelated question keeps no goal');
  });
});
