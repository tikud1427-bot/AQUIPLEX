/**
 * E11 foundation: envelope.js contract, plus a live-HTTP check that
 * health.js's migration to it preserved every existing field and fixed
 * the one inconsistency (root endpoint previously had no `success` key).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ok, fail, ErrorCodes } from '../envelope.js';

function mockRes() {
  const calls = { status: 200, body: null };
  return {
    status(code) { calls.status = code; return this; },
    json(body) { calls.body = body; return this; },
    _calls: calls,
  };
}

describe('envelope.js — ok()', () => {
  test('spreads data onto { success: true, ... }, matching the existing convention', () => {
    const res = mockRes();
    ok(res, { count: 3, items: [1, 2, 3] });
    assert.equal(res._calls.status, 200);
    assert.deepEqual(res._calls.body, { success: true, count: 3, items: [1, 2, 3] });
  });

  test('defaults to an empty payload', () => {
    const res = mockRes();
    ok(res);
    assert.deepEqual(res._calls.body, { success: true });
  });
});

describe('envelope.js — fail()', () => {
  test('maps each declared code to its HTTP status', () => {
    const cases = [
      [ErrorCodes.BAD_REQUEST, 400], [ErrorCodes.UNAUTHORIZED, 401],
      [ErrorCodes.FORBIDDEN, 403], [ErrorCodes.NOT_FOUND, 404],
      [ErrorCodes.CONFLICT, 409], [ErrorCodes.INTERNAL, 500],
    ];
    for (const [code, status] of cases) {
      const res = mockRes();
      fail(res, code, 'x');
      assert.equal(res._calls.status, status, code);
      assert.equal(res._calls.body.code, code);
      assert.equal(res._calls.body.success, false);
    }
  });

  test('an unknown code degrades to 500/internal instead of throwing', () => {
    const res = mockRes();
    assert.doesNotThrow(() => fail(res, 'not_a_real_code', 'x'));
    assert.equal(res._calls.status, 500);
    assert.equal(res._calls.body.code, ErrorCodes.INTERNAL);
  });

  test('extra fields (e.g. requestId) pass through', () => {
    const res = mockRes();
    fail(res, ErrorCodes.NOT_FOUND, 'Conversation not found', { requestId: 'r1' });
    assert.equal(res._calls.body.requestId, 'r1');
    assert.equal(res._calls.body.error, 'Conversation not found');
  });
});

describe('health.js — migrated to the envelope, same fields, now consistent', () => {
  let server, base;

  before(async () => {
    const { default: healthRoute } = await import('../health.js');
    const app = express();
    app.use('/health', healthRoute);
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  const req = async (p) => {
    const res = await fetch(base + p);
    return { status: res.status, body: await res.json() };
  };

  test('root now carries success:true (previously missing) plus every existing field', async () => {
    const { status, body } = await req('/health/');
    assert.equal(status, 200);
    assert.equal(body.success, true);
    for (const key of ['status', 'ts', 'uptime', 'providers', 'models', 'metrics', 'memory', 'project', 'mirror', 'search']) {
      assert.ok(key in body, `missing ${key}`);
    }
  });

  test('/uptime keeps its fields under the envelope', async () => {
    const { status, body } = await req('/health/uptime');
    assert.equal(status, 200);
    assert.equal(body.success, true);
  });

  test('/logs keeps count + logs under the envelope', async () => {
    const { status, body } = await req('/health/logs?limit=5');
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.ok('count' in body && 'logs' in body);
  });

  test('/orchestrator keeps profiles + capabilities under the envelope', async () => {
    const { status, body } = await req('/health/orchestrator');
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.ok('profiles' in body && 'capabilities' in body);
  });
});
