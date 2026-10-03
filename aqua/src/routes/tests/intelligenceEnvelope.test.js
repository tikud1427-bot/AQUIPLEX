/**
 * intelligence.js — envelope migration, pinned by CHARACTERISATION.
 *
 * Every status and `error` text below was recorded from the route BEFORE it was
 * migrated to ok()/fail(). The migration may add exactly one thing — `code` on
 * failures — and nothing else may move: same statuses (including the 500s that
 * carry err.message, the 502 on orchestration failure, and the 503s), same
 * error text, same success bodies.
 *
 * `__CODE(x)` marks an assertion on the new `code` field; the pre-migration run
 * of this file neutralises it, which is how the old behaviour was proven.
 */
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-intel-routes-'));
const { default: intelRoute } = await import('../intelligence.js');
const { ErrorCodes } = await import('../envelope.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { const u = req.headers['x-test-user']; if (u) req.aquaUserId = String(u); next(); });
app.use('/intelligence', intelRoute);

let server, base;
before(() => { server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`; });
after(() => { server.close(); });

const call = async (method, p, { user, body } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { ...(user ? { 'x-test-user': user } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null; try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
};
const U = `u-intel-${Math.random().toString(36).slice(2, 8)}`;
const __CODE = (r, code) => assert.equal(r.json.code, code, `code on ${JSON.stringify(r.json)}`);

describe('owner-scoped routes without an owner → 400 bad_request', () => {
  const routes = [
    ['GET', '/intelligence/knowledge?q=x'], ['GET', '/intelligence/project'], ['GET', '/intelligence/health'],
    ['POST', '/intelligence/maintain', {}], ['GET', '/intelligence/lifecycle/fact/abc'], ['GET', '/intelligence/ledger'],
    ['GET', '/intelligence/forensics'], ['GET', '/intelligence/research'],
    ['GET', '/intelligence/compare?a=1&b=2'], ['GET', '/intelligence/cause?q=x'],
  ];
  for (const [m, p, body] of routes) {
    test(`${m} ${p}`, async () => {
      const r = await call(m, p, { body });
      assert.equal(r.status, 400, JSON.stringify(r.json));
      assert.equal(r.json.success, false);
      assert.equal(r.json.error, 'No owner (no session and no ?conversationId)');
      __CODE(r, ErrorCodes.BAD_REQUEST);
    });
  }
});

describe('global and success routes', () => {
  test('GET /metrics needs no owner', async () => {
    const r = await call('GET', '/intelligence/metrics');
    assert.equal(r.status, 200); assert.equal(r.json.success, true); assert.ok('metrics' in r.json);
  });
  test('GET /cognition and /cognition/strategies', async () => {
    const a = await call('GET', '/intelligence/cognition');
    assert.equal(a.status, 200); assert.equal(a.json.success, true);
    assert.equal(typeof a.json.enabled, 'boolean'); assert.ok('metrics' in a.json);
    const b = await call('GET', '/intelligence/cognition/strategies');
    assert.equal(b.status, 200); assert.equal(b.json.success, true); assert.ok('strategies' in b.json);
  });
  test('GET /project, /health, /ledger succeed with their fields', async () => {
    const p = await call('GET', '/intelligence/project', { user: U });
    assert.equal(p.status, 200); assert.ok('project' in p.json);
    const h = await call('GET', '/intelligence/health', { user: U });
    assert.equal(h.status, 200); assert.equal(typeof h.json.enabled, 'boolean'); assert.ok('health' in h.json);
    const l = await call('GET', '/intelligence/ledger?limit=3', { user: U });
    assert.equal(l.status, 200); assert.ok('ledger' in l.json);
  });
  test('POST /maintain succeeds and spreads the engine result', async () => {
    const r = await call('POST', '/intelligence/maintain', { user: U, body: {} });
    assert.equal(r.status, 200); assert.equal(r.json.success, true);
  });
  test('GET /knowledge returns ownerId, query and the retrieval result', async () => {
    const r = await call('GET', '/intelligence/knowledge?q=hello', { user: U });
    assert.equal(r.status, 200); assert.equal(r.json.success, true);
    assert.match(r.json.ownerId, /u-intel/); assert.equal(r.json.query, 'hello');
  });
  test('GET /research echoes the mode', async () => {
    const r = await call('GET', '/intelligence/research?mode=gaps', { user: U });
    assert.ok([200, 503].includes(r.status), `status ${r.status}`);
    if (r.status === 200) { assert.equal(r.json.mode, 'gaps'); assert.ok('research' in r.json); }
  });
});

describe('validation failures keep their statuses and messages', () => {
  test('knowledge without ?q= → 400 "Missing ?q="', async () => {
    const r = await call('GET', '/intelligence/knowledge', { user: U });
    assert.equal(r.status, 400); assert.equal(r.json.error, 'Missing ?q=');
    __CODE(r, ErrorCodes.BAD_REQUEST);
  });
  test('compare without a and b → 400', async () => {
    const r = await call('GET', '/intelligence/compare?a=1', { user: U });
    assert.equal(r.status, 400); assert.equal(r.json.error, 'a and b (uko ids) are required');
    __CODE(r, ErrorCodes.BAD_REQUEST);
  });
  test('cause without q → 400', async () => {
    const r = await call('GET', '/intelligence/cause', { user: U });
    assert.equal(r.status, 400); assert.equal(r.json.error, 'q is required');
    __CODE(r, ErrorCodes.BAD_REQUEST);
  });
  test('lifecycle for an unknown subject → 404', async () => {
    const r = await call('GET', '/intelligence/lifecycle/fact/does-not-exist', { user: U });
    assert.equal(r.status, 404); assert.equal(r.json.error, 'Unknown subject');
    __CODE(r, ErrorCodes.NOT_FOUND);
  });
  test('compare with unknown files → 404 (or 503 when PIC is off) — whichever it is today', async () => {
    const r = await call('GET', '/intelligence/compare?a=nope&b=nada', { user: U });
    assert.equal(r.status, 404, JSON.stringify(r.json));
    assert.equal(r.json.error, 'one or both files not found');
    __CODE(r, ErrorCodes.NOT_FOUND);
  });
  test('forensics for an unknown file → 404 "file not found"', async () => {
    const r = await call('GET', '/intelligence/forensics?file=nope', { user: U });
    assert.equal(r.status, 404); assert.equal(r.json.error, 'file not found');
    __CODE(r, ErrorCodes.NOT_FOUND);
  });
});

describe('orchestrate', () => {
  const saved = process.env.AQUA_GRAPH;
  afterEach(() => { if (saved === undefined) delete process.env.AQUA_GRAPH; else process.env.AQUA_GRAPH = saved; });

  test('kill switch → 503 with the exact message', async () => {
    process.env.AQUA_GRAPH = 'off';
    const r = await call('POST', '/intelligence/orchestrate', { user: U, body: { message: 'hi' } });
    assert.equal(r.status, 503); assert.equal(r.json.error, 'orchestration disabled (AQUA_GRAPH=off)');
    __CODE(r, ErrorCodes.UNAVAILABLE);
  });
  test('no owner → 400 with the conversationId wording (no leading "?")', async () => {
    delete process.env.AQUA_GRAPH;
    const r = await call('POST', '/intelligence/orchestrate', { body: { message: 'hi' } });
    assert.equal(r.status, 400); assert.equal(r.json.error, 'No owner (no session and no conversationId)');
    __CODE(r, ErrorCodes.BAD_REQUEST);
  });
  test('empty message → 400', async () => {
    delete process.env.AQUA_GRAPH;
    const r = await call('POST', '/intelligence/orchestrate', { user: U, body: { message: '   ' } });
    assert.equal(r.status, 400); assert.equal(r.json.error, 'message is required');
    __CODE(r, ErrorCodes.BAD_REQUEST);
  });
});

// ── The "unavailable" paths, at runtime ─────────────────────────────────────
// With the PIC facade switched off its read functions return null, which is
// what drives research/cause → 503 and forensics → 404. The flag is read per
// call, so it can be flipped inside a test. Statuses are the ones the SOURCE
// declared before migration (503, 503, 404).
describe('PIC off — the facade returns null', () => {
  const saved = process.env.AQUA_PIC;
  before(() => { process.env.AQUA_PIC = 'off'; });
  after(() => { if (saved === undefined) delete process.env.AQUA_PIC; else process.env.AQUA_PIC = saved; });

  test('research → 503 unavailable', async () => {
    const r = await call('GET', '/intelligence/research', { user: U });
    assert.equal(r.status, 503); assert.equal(r.json.error, 'research unavailable');
    __CODE(r, ErrorCodes.UNAVAILABLE);
  });
  test('cause → 503 unavailable', async () => {
    const r = await call('GET', '/intelligence/cause?q=why', { user: U });
    assert.equal(r.status, 503); assert.equal(r.json.error, 'causal query unavailable');
    __CODE(r, ErrorCodes.UNAVAILABLE);
  });
  test('forensics without ?file → 404 "forensics unavailable" (the message differs from the ?file case)', async () => {
    const r = await call('GET', '/intelligence/forensics', { user: U });
    assert.equal(r.status, 404); assert.equal(r.json.error, 'forensics unavailable');
    __CODE(r, ErrorCodes.NOT_FOUND);
  });
});

// ── The catch paths ─────────────────────────────────────────────────────────
//
// The five 500s and the one 502 only fire when an engine function THROWS, and
// none of them can be made to throw from outside without stubbing the engine
// (and the 502 path calls `runTaskGraph`, which would reach real model
// providers on any machine that has keys in its environment — a test must not
// do that). So these are pinned STRUCTURALLY, from the source with comments
// stripped, and declared as such: they prove the mapping, not the throw.
describe('catch paths (structural)', () => {
  const src = fs.readFileSync(new URL('../intelligence.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  test('five handlers answer an engine throw as 500 internal, carrying err.message', () => {
    assert.equal((src.match(/fail\(res, ErrorCodes\.INTERNAL, err\.message\)/g) ?? []).length, 5);
  });
  test('orchestrate answers a failure as 502 upstream_failed, not 500 or 503', () => {
    assert.equal((src.match(/fail\(res, ErrorCodes\.UPSTREAM_FAILED, err\.message\)/g) ?? []).length, 1);
  });
  test('no raw response point is left in the file', () => {
    assert.doesNotMatch(src, /res\.status\(/);
    assert.doesNotMatch(src, /res\.json\(/);
  });
  test('upstream_failed maps to 502 in the envelope itself', async () => {
    const { fail } = await import('../envelope.js');
    const calls = {};
    const res = { status(s) { calls.status = s; return this; }, json(b) { calls.body = b; return this; } };
    fail(res, ErrorCodes.UPSTREAM_FAILED, 'boom');
    assert.equal(calls.status, 502);
    assert.deepEqual(calls.body, { success: false, code: 'upstream_failed', error: 'boom' });
  });
});
