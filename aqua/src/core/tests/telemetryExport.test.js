/**
 * The env-activated telemetry backends against a REAL local HTTP receiver:
 * the bytes on the wire are what a collector / webhook would get.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { configureTelemetryFromEnv, getExportStats, toOtlpSpan } from '../telemetryExport.js';
import { startSpan, reportError, _resetTelemetryForTests } from '../telemetry.js';

const received = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    received.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    res.writeHead(req.url.includes('fail') ? 500 : 200).end('{}');
  });
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); _resetTelemetryForTests(); });

test('unset environment: nothing leaves the process', () => {
  const t = configureTelemetryFromEnv({ env: {} });
  assert.deepEqual([t.spans, t.errors], ['local', 'local']);
});

test('OTLP/HTTP JSON: spans arrive at /v1/traces with service name, attributes and status', async () => {
  received.length = 0;
  const t = configureTelemetryFromEnv({ role: 'worker', env: {
    OTEL_EXPORTER_OTLP_ENDPOINT: `${base}/`, OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=abc%3D1' } });
  assert.equal(t.spans, 'otlp');
  const s = startSpan('job.run', { kind: 'claim.reflection.v1' });
  s.setStatus('error');
  s.end();
  startSpan('context.assemble').end();
  await t.shutdown();
  assert.equal(received.length, 1);
  const r = received[0];
  assert.equal(r.url, '/v1/traces');
  assert.equal(r.headers['x-api-key'], 'abc=1');
  const rs = r.body.resourceSpans[0];
  assert.deepEqual(rs.resource.attributes[0], { key: 'service.name', value: { stringValue: 'aquiplex-worker' } });
  const spans = rs.scopeSpans[0].spans;
  assert.deepEqual(spans.map(x => x.name), ['job.run', 'context.assemble']);
  assert.equal(spans[0].status.code, 2);
  assert.match(spans[0].traceId, /^[0-9a-f]{32}$/);
  assert.match(spans[0].spanId, /^[0-9a-f]{16}$/);
  assert.ok(BigInt(spans[0].endTimeUnixNano) >= BigInt(spans[0].startTimeUnixNano));
});

test('a failing collector is counted, never thrown into the observed path', async () => {
  const before = getExportStats().exportFailures;
  const t = configureTelemetryFromEnv({ env: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${base}/fail` } });
  startSpan('job.run').end();
  await t.shutdown();
  assert.equal(getExportStats().exportFailures, before + 1);
});

test('error webhook: the SCRUBBED record is posted with the bearer token', async () => {
  received.length = 0;
  configureTelemetryFromEnv({ env: { AQUA_ERROR_WEBHOOK_URL: `${base}/errors`, AQUA_ERROR_WEBHOOK_TOKEN: 'tkn' } });
  reportError(new Error('lookup failed for jane@example.com'), { where: 'job.run', ownerId: 'user:42' });
  for (let i = 0; i < 50 && !received.length; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(received.length, 1);
  assert.equal(received[0].headers.authorization, 'Bearer tkn');
  assert.equal(received[0].body.where, 'job.run');
  assert.doesNotMatch(JSON.stringify(received[0].body), /jane@example\.com|user:42/);
});

test('OTLP attribute typing', () => {
  const s = toOtlpSpan({ name: 'x', durationMs: 1.5, status: 'ok', attributes: { a: 'b', n: 3, f: 0.5, t: true }, endedAt: 1000 });
  assert.deepEqual(s.attributes.map(a => Object.keys(a.value)[0]), ['stringValue', 'intValue', 'doubleValue', 'boolValue']);
});
