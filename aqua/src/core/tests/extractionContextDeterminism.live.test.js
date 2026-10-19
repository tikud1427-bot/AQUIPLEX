/**
 * The extractor's reference context is a function of the world, not of
 * Postgres row order (2026-10-16) — live Postgres.
 *
 * One turn yields several claims that share a turn number and an updated_at.
 * With a limit, the old ordering (turn only / updated_at + random claim_id)
 * let row order choose WHICH of them the extractor saw, so the same sentence
 * got different prompts from run to run: the extraction cache missed and the
 * context-canonical replay gate could not reproduce a recording. Ties are now
 * broken by content.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-ctx-determinism-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
process.env.AQUA_E6 = 'on';
process.env.AQUA_SELF_ENTITY = 'on';

const { isConfigured } = await import('../db/pool.js');
const skip = isConfigured() ? false : 'needs a live migrated Postgres — set AQUA_TEST_DATABASE_URL';

const Brain = await import('../../brain/index.js');
const { extractionContext } = await import('../worldModel/canonicalReadModel.js');
const { purgeOwnerData } = await import('../../account/accountPurge.js');

const USER = `ctxdet-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const OWNER = `user:${USER}`;
const c = (subject, predicate, object, statementText) => ({
  subject, predicate, object, statementText, polarity: 'asserted', modality: 'fact', timePrecision: 'none', confidenceExtraction: 0.9,
});
// One sentence, five claims — all from turn 1.
const TURN1 = 'I run product at Nummo, live in Pune, use Linear, prefer Rust and my co-founder is Dev';
const CLAIMS = [
  c('I', 'works_at', { entity: 'Nummo' }, TURN1),
  c('I', 'located_in', { entity: 'Pune' }, TURN1),
  c('I', 'uses', { entity: 'Linear' }, TURN1),
  c('I', 'prefers', { literal: 'Rust' }, TURN1),
  c('I', 'related_to', { entity: 'Dev' }, TURN1),
];
const callModel = async () => ({ text: JSON.stringify({ claims: CLAIMS }), model: 'scripted/determinism' });

describe('extraction reference context is deterministic', { skip }, () => {
  after(async () => { await purgeOwnerData({ userId: USER }); });

  test('with a limit below the turn\'s claim count, the same lines come back in content order, every time', async () => {
    await Brain.understandTurn({ ownerId: OWNER, conversationId: 'c-det', turn: 1, userMessage: `${TURN1}.`, callModel });
    const runs = [];
    for (let i = 0; i < 4; i++) {
      runs.push(await extractionContext(OWNER, { conversationId: 'c-det', turn: 2, conversationLimit: 3, factLimit: 3 }));
    }
    const first = runs[0];
    assert.equal(first.conversation.length, 3, JSON.stringify(first));
    for (const r of runs) assert.deepEqual(r, first);
    assert.deepEqual(first.conversation, [...first.conversation].sort((a, b) => a.localeCompare(b)),
      'ties within one turn must be ordered by content, not row order');
  });

  // 2026-10-17: a claim RESTATED later carries two evidence turns. The query took
  // DISTINCT ON (claim_id) with no ORDER BY, so either turn could come back and
  // the claim fell in or out of the most-recent window at random (13–15 of 46
  // held-out replay requests differed between two runs of the same code).
  test('a restated claim ranks by its most recent mention, on every read', async () => {
    const conv = 'c-restated';
    const say = { 1: ['I run product at Nummo', 'I', 'works_at', { entity: 'Nummo' }],
      2: ['I live in Pune', 'I', 'located_in', { entity: 'Pune' }],
      3: ['I use Linear', 'I', 'uses', { entity: 'Linear' }],
      4: ['I run product at Nummo', 'I', 'works_at', { entity: 'Nummo' }] };
    for (const [turn, [text, s, p, o]] of Object.entries(say)) {
      const scripted = async () => ({ text: JSON.stringify({ claims: [c(s, p, o, text)] }), model: 'scripted/determinism' });
      await Brain.understandTurn({ ownerId: OWNER, conversationId: conv, turn: Number(turn), userMessage: `${text}.`, callModel: scripted });
    }
    for (let i = 0; i < 6; i++) {
      const ctx = await extractionContext(OWNER, { conversationId: conv, turn: 5, conversationLimit: 1, factLimit: 1 });
      assert.deepEqual(ctx.conversation, ['self | works_at | Nummo'], `read ${i}: ${JSON.stringify(ctx.conversation)}`);
    }
    // Before turn 4 the restatement does not exist yet: Linear (turn 3) is newest.
    const earlier = await extractionContext(OWNER, { conversationId: conv, turn: 4, conversationLimit: 1, factLimit: 1 });
    assert.deepEqual(earlier.conversation, ['self | uses | Linear']);
  });
});
