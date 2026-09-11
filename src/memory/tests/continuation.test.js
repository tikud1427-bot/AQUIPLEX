/**
 * Memory 5.0 Phase F — Continuation fast-path + retrieval metrics
 * Run: node --test src/memory/tests/continuation.test.js
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-continuation-'));
process.env.AQUA_DATA_DIR = tmp;
process.chdir(tmp);

let cont, engine, mindStore, schema, obs;

before(async () => {
  cont      = await import('../continuation.js');
  engine    = await import('../engine.js');
  mindStore = await import('../../mind/mindStore.js');
  schema    = await import('../../mind/mindSchema.js');
  obs       = await import('../../core/observability.js');
});

test('detector: bare continuations match', () => {
  for (const msg of [
    "let's continue", 'continue', 'Continue.', 'ok, resume', 'carry on',
    'keep going', 'pick up where we left off', 'where were we?', 'back to it',
    'continue please', "okay let's continue",
  ]) {
    assert.equal(cont.detectContinuation(msg), true, `should match: "${msg}"`);
  }
});

test('detector: content requests naming their own subject do NOT match', () => {
  for (const msg of [
    'continue the story about dragons',
    'resume the download in chunks of 5',
    'let us discuss continuing education',
    'can you keep going through the list of countries and their capitals please',
    'what should I do next',
  ]) {
    assert.equal(cont.detectContinuation(msg), false, `should NOT match: "${msg}"`);
  }
});

test('continuation surfaces the latest active episode with zero token overlap', () => {
  const owner = `user:phaseF-ep-${Math.random().toString(36).slice(2, 8)}`;
  const mind = mindStore.getMind(owner);
  const ep = schema.createEpisode({ title: 'artifact engine builder module', conversationId: 'c1' });
  ep.lastActivityAt = Date.now() - 3600_000;
  mind.episodes[ep.id] = ep;

  const { block, trace } = engine.memoryRetrieve(owner, { query: "let's continue" });
  assert.equal(trace.continuation, true);
  assert.match(block, /PAST EPISODES/);
  assert.match(block, /artifact engine builder/);
});

test('continuation forces file-summary lane (workspace resurfaces)', () => {
  const owner = `user:phaseF-ws-${Math.random().toString(36).slice(2, 8)}`;
  engine.rememberFile(owner, { name: 'builder-spec.md', kind: 'document', summary: 'Universal Artifact Engine phase 2 plan', chars: 1200 });
  const { block } = engine.memoryRetrieve(owner, { query: 'continue' });
  assert.match(block, /KNOWN FILES/);
  assert.match(block, /builder-spec\.md/);
});

test('normal unrelated query without file words: file-summary lane stays quiet', () => {
  const owner = `user:phaseF-quiet-${Math.random().toString(36).slice(2, 8)}`;
  engine.rememberFile(owner, { name: 'notes.md', kind: 'document', summary: 'misc', chars: 10 });
  const { block, trace } = engine.memoryRetrieve(owner, { query: 'what is the capital of France' });
  assert.equal(trace.continuation, undefined);
  assert.ok(!/KNOWN FILES/.test(block));
});

test('metrics: retrievals counted with latency + lanes', () => {
  const owner = `user:phaseF-metrics-${Math.random().toString(36).slice(2, 8)}`;
  const beforeCount = obs.getMetrics().memoryRetrieval.count;
  engine.memoryRetrieve(owner, { query: 'anything at all' });
  const m = obs.getMetrics().memoryRetrieval;
  assert.equal(m.count, beforeCount + 1);
  assert.ok(m.p95LatencyMs >= 0);
  assert.ok(typeof m.lanes.facts === 'number');
});
