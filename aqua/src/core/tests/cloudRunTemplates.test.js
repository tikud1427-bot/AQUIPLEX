/**
 * Phase 4B — the Cloud Run templates (deploy/cloudrun/*.yaml) must stay
 * consistent with the code. They are NOT deployed; this test keeps a template
 * from drifting into something that would fail or leak on the day it is.
 *
 *   every variable a template sets is one the code reads (flag registry, or a
 *   known platform/script setting) — a typo is a silently ignored setting
 *   no secret value is inline (Secret Manager references only)
 *   the durability features are on in both, with the same partition list
 *   API: start-api entrypoint, /ready startup probe, /health liveness,
 *   CPU always allocated, shutdown inside the 10 s grace
 *   worker: start-worker entrypoint, no port, no probes
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, 'deploy', 'cloudrun', f), 'utf8');
const api = read('api.service.yaml');
const worker = read('worker.workerpool.yaml');
const { GATES, SETTINGS } = await import('../flags.js');

// Read by the platform (not the AQUA engine) or by the entry scripts — from the env inventory in the plan.
const PLATFORM = new Set(['NODE_ENV', 'APP_URL', 'MAIL_TRANSPORT', 'MAIL_FROM', 'DATABASE_URL', 'MONGO_URI', 'SESSION_SECRET',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET',
  'RESEND_API_KEY', 'SERPER_API_KEY', 'PGPOOL_MAX', 'PGPOOL_CONNECT_MS', 'PGPOOL_IDLE_MS', 'START_WORKER_SKIP_DOTENV',
  'AQUA_API_SHUTDOWN_MS', 'AQUA_WORKER_SHUTDOWN_MS', 'AQUA_DISABLE_MONGO_MIRROR', 'AQUA_ARTIFACTS_DIR', 'AQUA_GCS_BUCKET', 'AQUA_GCS_ENDPOINT']);
const PROVIDER_KEY = /^(GROQ_API_KEY|GEMINI_KEY|NVIDIA_API_KEY|OPENROUTER_API_KEY)(_\d+)?$/;
const known = new Set([...GATES, ...SETTINGS].map(e => e.name));

const envNames = y => [...y.matchAll(/name:\s*([A-Z][A-Z0-9_]+)/g)].map(m => m[1]);
const inlineValue = (y, name) => y.match(new RegExp(`name:\\s*${name}\\s*,\\s*value:\\s*"?([^"}]*)"?\\s*}`))?.[1]?.trim() ?? null;

for (const [label, y] of [['api', api], ['worker', worker]]) {
  test(`${label}: every variable it sets is one the code reads`, () => {
    const unknown = envNames(y).filter(n => !known.has(n) && !PLATFORM.has(n) && !PROVIDER_KEY.test(n));
    assert.deepEqual(unknown, [], `not read anywhere: ${unknown.join(', ')}`);
  });
  test(`${label}: no secret is inline — Secret Manager references only`, () => {
    for (const n of envNames(y).filter(n => /KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL|MONGO_URI/.test(n) && !/_MS$/.test(n))) {
      assert.equal(inlineValue(y, n), null, `${n} has an inline value`);
      assert.match(y, new RegExp(`name: ${n}[^\\n]*\\n\\s*valueFrom: \\{ secretKeyRef:`), `${n} is not a secretKeyRef`);
    }
  });
  test(`${label}: durability on, the same partition list in both`, () => {
    assert.equal(inlineValue(y, 'AQUA_POST_TURN_DURABLE'), 'on');
    assert.equal(inlineValue(y, 'AQUA_PENDING_CHARGES'), 'on');
    assert.equal(inlineValue(y, 'AQUA_OBJECT_STORE'), 'gcs');
    assert.equal(inlineValue(y, 'AQUA_STORE_PARTITIONS'), inlineValue(api, 'AQUA_STORE_PARTITIONS'));
    assert.ok(Number(inlineValue(y, 'AQUA_SHUTDOWN_BUDGET_MS')) < 10_000, 'the shutdown budget must fit the 10 s grace');
  });
  // PWI Phase 1 (2026-11-15): DATABASE_URL without this pin switches the read to
  // 'authoritative', which drops the Mind lanes (src/routes/tests/cloudRunMemoryLanes.test.js).
  test(`${label}: AQUA_CANONICAL_READ is pinned off (the Mind lanes survive DATABASE_URL)`, () => {
    assert.equal(inlineValue(y, 'AQUA_CANONICAL_READ'), 'off');
    assert.match(y, /name: DATABASE_URL/, 'the pin exists because this template configures a database');
  });
  test(`${label}: owner log pseudonyms use the shared Secret Manager key`, () => {
    assert.match(y, /name: AQUA_LOG_PSEUDONYM_KEY[^\n]*\n\s*valueFrom: \{ secretKeyRef: \{ name: aquiplex-log-pseudonym-key,/);
  });
}

test('api: entrypoint, probes, CPU always allocated', () => {
  assert.match(api, /args: \["scripts\/start-api\.mjs"\]/);
  assert.match(api, /startupProbe:[^]*?path: \/ready/);
  assert.match(api, /livenessProbe:[^]*?path: \/health/);
  assert.match(api, /run\.googleapis\.com\/cpu-throttling: "false"/);
  assert.ok(Number(inlineValue(api, 'AQUA_API_SHUTDOWN_MS')) < Number(inlineValue(api, 'AQUA_SHUTDOWN_BUDGET_MS')));
});

test('worker: entrypoint, no port, no HTTP probes', () => {
  assert.match(worker, /args: \["scripts\/start-worker\.mjs"/);
  assert.doesNotMatch(worker, /containerPort|startupProbe|livenessProbe/);
  assert.match(worker, /kind: WorkerPool/);
});
