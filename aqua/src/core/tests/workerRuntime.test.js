/**
 * The durable understanding job must RETRY a turn whose extraction failed.
 *
 * Found on live Postgres (2026-10-04, World-Model Lift run): Groq's TPM limit
 * is per organisation, so under load a 429 reached extractSegment, the
 * fail-open pipeline returned zero claims, and the `understanding.turn.v1`
 * job was marked DONE. "The payment integration is blocking the iOS launch"
 * never entered the World Model, and nothing anywhere said so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.AQUA_E6 = 'on';
const { assertUnderstood } = await import('../jobs/workerRuntime.js');
const { runUnderstandingPipeline } = await import('../../brain/understanding/pipeline.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('a transport failure inside the pipeline is reported, not silently empty', async () => {
  const callModel = async () => { throw new Error('429 rate limit reached (TPM)'); };
  const r = await runUnderstandingPipeline('The payment integration is blocking the iOS launch.', {
    ownerId: 'u-retry', conversationId: 'c', callModel,
  });
  assert.equal(r.stats.errors, 1);
  assert.match(r.stats.errorReasons[0], /transport:429/);
  assert.throws(() => assertUnderstood(r), err => err.code === 'UNDERSTANDING_INCOMPLETE' && /429/.test(err.message));
});

test('a turn with no claim in it is NOT an error — it must complete', async () => {
  const callModel = async () => ({ text: '{"claims":[]}', model: 'm' });
  const r = await runUnderstandingPipeline('The payment integration is blocking the iOS launch.', {
    ownerId: 'u-retry', conversationId: 'c', callModel,
  });
  assert.equal(r.stats.errors, 0);
  assert.doesNotThrow(() => assertUnderstood(r));
  assert.doesNotThrow(() => assertUnderstood(null), 'E6 off returns null — nothing to retry');
});

test('the worker handler and the worker process both run through this check', () => {
  const runtime = readFileSync(path.join(ROOT, 'src/core/jobs/workerRuntime.js'), 'utf8');
  const handler = runtime.slice(runtime.indexOf("'understanding.turn.v1'"), runtime.indexOf("'claim.reflection.v1'"));
  assert.match(handler, /assertUnderstood\(result\)/, 'the understanding handler no longer retries failed turns');
  const worker = readFileSync(path.join(ROOT, 'scripts/worker.mjs'), 'utf8');
  assert.match(worker, /runOneJob\(WORKER_ID/, 'worker.mjs no longer uses the shared handler table');
  assert.doesNotMatch(worker, /'understanding\.turn\.v1': async/, 'worker.mjs grew a second copy of the handlers');
});

test('a failed canonical commit RETRIES the job — extracted-but-unwritten claims are a lost turn', () => {
  assert.throws(() => assertUnderstood({ stats: { errors: 0 }, canonicalCommit: { enabled: true, committed: false, error: 'duplicate key' } }),
    err => err.code === 'UNDERSTANDING_COMMIT_FAILED' && /duplicate key/.test(err.message));
  assert.doesNotThrow(() => assertUnderstood({ stats: { errors: 0 }, canonicalCommit: { enabled: true, commits: [] } }));
});
