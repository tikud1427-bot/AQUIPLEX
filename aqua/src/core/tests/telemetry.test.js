import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startSpan, withSpan, reportError, scrubMessage, setSpanExporter, setErrorSink,
  getTelemetryMetrics, _recentSpansForTests, _recentErrorsForTests, _resetTelemetryForTests,
} from '../telemetry.js';
import { renderPrometheus } from '../metricsExposition.js';
import { readEvalGateSummary } from '../evalGateSummary.js';

beforeEach(() => _resetTelemetryForTests());

test('span attributes pass the allowlist: free text and unknown keys are DROPPED, and the drop is reported', () => {
  const s = startSpan('job.run', { 'aqua.job_kind': 'claim.reflection.v1', 'aqua.stage': 'I work at Nummo', secret: 'x' });
  s.setAttribute('aqua.attempts', 2);
  s.end();
  const [span] = _recentSpansForTests();
  assert.deepEqual(span.attributes, { 'aqua.job_kind': 'claim.reflection.v1', 'aqua.attempts': 2 });
  assert.deepEqual(span.dropped.sort(), ['aqua.stage', 'secret']);
});

test('withSpan records errors and per-stage latency for /metrics', async () => {
  await withSpan('context.assemble', {}, async () => {});
  await assert.rejects(withSpan('context.assemble', {}, async () => { throw new Error('boom'); }));
  const m = getTelemetryMetrics().stages['context.assemble'];
  assert.equal(m.count, 2);
  assert.equal(m.errors, 1);
});

test('reported errors are scrubbed of user content and secrets; the owner is hashed', () => {
  reportError(Object.assign(new Error('failed for maya@nummo.io on "I work at Nummo" key gsk_abcdefghijk123 id 9876543210'), { code: 'E_X' }),
    { where: 'job.understanding.turn.v1', ownerId: 'user:maya' });
  const [rec] = _recentErrorsForTests();
  assert.doesNotMatch(rec.message, /maya@|Nummo|gsk_|9876543210/);
  assert.equal(rec.code, 'E_X');
  assert.match(rec.ownerHash, /^[0-9a-f]{12}$/);
  assert.equal(getTelemetryMetrics().errors['job.understanding.turn.v1'], 1);
  assert.equal(scrubMessage("visit https://x.io/a?token=abc"), 'visit <url>');
});

test('exporter and error sink are pluggable (where a real OTel / error tracker connects)', () => {
  const spans = []; const errs = [];
  setSpanExporter(s => spans.push(s)); setErrorSink(e => errs.push(e));
  startSpan('job.run').end(); reportError(new Error('x'), { where: 'w' });
  assert.equal(spans.length, 1); assert.equal(errs.length, 1);
  setSpanExporter(() => { throw new Error('exporter down'); });
  assert.doesNotThrow(() => startSpan('job.run').end(), 'a broken exporter must never fail the observed path');
});

test('/metrics renders spans, reported errors, retry windows and the eval gate', () => {
  startSpan('job.run').end();
  reportError(new Error('x'), { where: 'job.claim.embedding.v1' });
  const text = renderPrometheus({
    telemetry: getTelemetryMetrics(),
    queue: { queued: 1, running: 0, done: 2, dead: 1, byKind: [{ kind: 'understanding.turn.v1', state: 'dead', jobs: 1, retries: 4 }] },
    evalGate: { passed: false, regressions: 1, ageSeconds: 30 },
  });
  assert.match(text, /aqua_span_count\{stage="job\.run"\} 1/);
  assert.match(text, /aqua_reported_errors_total\{where="job\.claim\.embedding\.v1"\} 1/);
  assert.match(text, /aqua_job_retries_window\{kind="understanding\.turn\.v1",state="dead"\} 4/);
  assert.match(text, /aqua_eval_gate_passed 0/);
});

test('eval gate summary: a missing file is NO DATA, never a fabricated pass', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gate-sum-'));
  assert.equal(readEvalGateSummary(path.join(dir, 'none.json')), null);
  const f = path.join(dir, 'gate-summary.json');
  writeFileSync(f, JSON.stringify({ ranAt: new Date(1000).toISOString(), passed: true, regressions: [] }));
  assert.deepEqual(readEvalGateSummary(f, 61_000), { passed: true, regressions: 0, ageSeconds: 60 });
});

test('the worker wraps every job in a span and reports failures (wiring, structural)', () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'jobs', 'workerRuntime.js'), 'utf8');
  assert.match(src, /startSpan\('job\.run'/);
  assert.match(src, /reportError\(err, \{ where: `job\./);
  assert.match(src, /span\.end\(\)/);
});
