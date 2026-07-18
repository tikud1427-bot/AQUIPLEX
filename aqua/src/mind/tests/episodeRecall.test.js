/**
 * Memory 5.0 Phase C — Episodic Recall
 * Run: node --test src/mind/tests/episodeRecall.test.js
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-episoderecall-'));
process.env.AQUA_DATA_DIR = tmp;
process.chdir(tmp);

const DAY = 24 * 3600 * 1000;
let mindStore, schema, recall, engine;

before(async () => {
  mindStore = await import('../mindStore.js');
  schema    = await import('../mindSchema.js');
  recall    = await import('../episodeRecall.js');
  engine    = await import('../../memory/engine.js');
});

function mindWithEpisodes(name) {
  const owner = `user:epC-${name}-${Math.random().toString(36).slice(2, 8)}`;
  const mind = mindStore.getMind(owner);
  const now = Date.now();

  const deploy = schema.createEpisode({ title: 'debugging render deploy failure', conversationId: 'c1' });
  deploy.status = 'archived';
  deploy.startedAt = now - 20 * DAY;
  deploy.endedAt = now - 18 * DAY;
  deploy.lastActivityAt = now - 18 * DAY;
  deploy.outcome = 'fixed: missing env var on render';
  deploy.lessons = ['always verify env vars before rollback'];
  deploy.importance = 7;
  mind.episodes[deploy.id] = deploy;

  const billing = schema.createEpisode({ title: 'razorpay billing migration', conversationId: 'c2' });
  billing.status = 'archived';
  billing.startedAt = now - 60 * DAY;
  billing.endedAt = now - 55 * DAY;
  billing.lastActivityAt = now - 55 * DAY;
  billing.outcome = 'shipped prepaid credit wallet';
  billing.importance = 8;
  mind.episodes[billing.id] = billing;

  return { owner, mind, now };
}

test('topic query retrieves the matching episode, best-first', () => {
  const { mind } = mindWithEpisodes('topic');
  const got = recall.recallEpisodes(mind, 'what did we do about the deploy failure?');
  assert.ok(got.length >= 1);
  assert.match(got[0].episode.title, /deploy/);
});

test('recency decay: older matching arc scores below fresher one on shared token', () => {
  const { mind } = mindWithEpisodes('decay');
  // both mention nothing shared; craft shared-token pair
  const now = Date.now();
  const a = schema.createEpisode({ title: 'search caching sprint', conversationId: 'c3' });
  a.status = 'archived'; a.endedAt = now - 2 * DAY; a.lastActivityAt = now - 2 * DAY; a.importance = 5;
  const b = schema.createEpisode({ title: 'search ranking sprint', conversationId: 'c4' });
  b.status = 'archived'; b.endedAt = now - 90 * DAY; b.lastActivityAt = now - 90 * DAY; b.importance = 5;
  mind.episodes[a.id] = a; mind.episodes[b.id] = b;
  const got = recall.recallEpisodes(mind, 'the search sprint', { limit: 4 });
  const iA = got.findIndex(x => x.episode.id === a.id);
  const iB = got.findIndex(x => x.episode.id === b.id);
  assert.ok(iA !== -1 && iB !== -1 && iA < iB, 'fresh arc must outrank stale arc');
});

test('generic past-tense query surfaces recent closed episodes without token match', () => {
  const { mind } = mindWithEpisodes('generic');
  assert.equal(recall.isPastRecallQuery('what were we doing last week?'), true);
  const got = recall.recallEpisodes(mind, 'what were we doing last week?');
  assert.ok(got.length >= 1, 'past-intent must surface recent closed arcs');
});

test('non-recall unrelated query → []; format block renders outcome + lesson', () => {
  const { mind } = mindWithEpisodes('fmt');
  assert.deepEqual(recall.recallEpisodes(mind, 'write me a haiku generator'), []);
  const got = recall.recallEpisodes(mind, 'render deploy');
  const block = recall.formatEpisodeRecall(got);
  assert.match(block, /PAST EPISODES/);
  assert.match(block, /outcome: fixed/);
  assert.match(block, /lesson: always verify env vars/);
});

test('engine wiring: memoryRetrieve injects PAST EPISODES + trace', () => {
  const { owner } = mindWithEpisodes('engine');
  const { block, trace } = engine.memoryRetrieve(owner, { query: 'what did we decide about the razorpay billing migration?' });
  assert.match(block, /PAST EPISODES/);
  assert.ok(trace.episodesRecalled?.some(t => /billing/.test(t)));
});
