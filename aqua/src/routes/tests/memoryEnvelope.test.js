/**
 * memory.js — envelope migration, pinned by CHARACTERISATION.
 *
 * Every status code and body below was recorded from the route BEFORE it was
 * migrated to ok()/fail(). The migration may add exactly one thing — `code` on
 * failures — and must change nothing else: same statuses (note pin's 404 vs
 * the others' 400 — kept, even where 404 would be "more correct"), same
 * `error` text, same `ownerId`/`ok` fields the edit endpoints already spread.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-memory-routes-'));
process.env.AQUA_DATA_DIR = TMP;

const Store = await import('../../memory/conversationStore.js');
const LTM = await import('../../memory/longTermMemory.js');
const { default: memoryRoute } = await import('../memory.js');
const { ErrorCodes } = await import('../envelope.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const u = req.headers['x-test-user'];
  if (u) req.aquaUserId = String(u);
  next();
});
app.use('/memory', memoryRoute);

let server, base;
before(() => { server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`; });
after(() => { server.close(); });

const call = async (method, p, { user, body } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { ...(user ? { 'x-test-user': user } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
};

const U = `u-mem-${Math.random().toString(36).slice(2, 8)}`;
const OTHER = `u-mem-other-${Math.random().toString(36).slice(2, 8)}`;

describe('no memory owner → 400 bad_request on every owner-scoped endpoint', () => {
  const cases = [
    ['GET', '/memory/recall?q=x'], ['GET', '/memory'], ['GET', '/memory/fact/k'],
    ['DELETE', '/memory/fact/k'], ['DELETE', '/memory'],
    ['POST', '/memory/fact', { key: 'a', value: 'b' }], ['POST', '/memory/fact/k/pin', {}],
    ['POST', '/memory/fact/k/archive', {}], ['POST', '/memory/merge', { keys: ['a', 'b'] }],
    ['POST', '/memory/fact/k/split', { parts: [] }], ['GET', '/memory/reason?q=x'], ['GET', '/memory/timeline'],
  ];
  for (const [method, p, body] of cases) {
    test(`${method} ${p}`, async () => {
      const r = await call(method, p, { body });
      assert.equal(r.status, 400, JSON.stringify(r.json));
      assert.equal(r.json.success, false);
      assert.equal(r.json.code, ErrorCodes.BAD_REQUEST);
      assert.match(r.json.error, /No memory owner/);
    });
  }
});

describe('read endpoints', () => {
  test('GET /memory returns the facts payload on success', async () => {
    const r = await call('GET', '/memory', { user: U });
    assert.equal(r.status, 200);
    assert.equal(r.json.success, true);
    assert.equal(r.json.ownerId !== undefined, true);
    assert.equal(typeof r.json.factCount, 'number');
    assert.ok(Array.isArray(r.json.facts));
  });

  test('unknown fact → 404 not_found with the key in the message', async () => {
    const r = await call('GET', '/memory/fact/nope', { user: U });
    assert.equal(r.status, 404);
    assert.deepEqual([r.json.success, r.json.code], [false, ErrorCodes.NOT_FOUND]);
    assert.equal(r.json.error, "Fact 'nope' not found");
  });

  test('inspector: unknown requestId → 404 not_found', async () => {
    const r = await call('GET', '/memory/inspector/does-not-exist', { user: U });
    assert.equal(r.status, 404);
    assert.deepEqual([r.json.success, r.json.code], [false, ErrorCodes.NOT_FOUND]);
    assert.match(r.json.error, /No trace for that requestId/);
  });

  test('timeline and reason succeed with their documented fields', async () => {
    const t = await call('GET', '/memory/timeline', { user: U });
    assert.equal(t.status, 200); assert.equal(t.json.success, true);
    assert.ok('days' in t.json && 'changes' in t.json);
    const q = await call('GET', '/memory/reason?q=anything', { user: U });
    assert.equal(q.status, 200); assert.equal(q.json.success, true); assert.equal(q.json.query, 'anything');
  });
});

describe('edit endpoints keep their statuses — including the inconsistent ones', () => {
  test('POST /fact with no key/value → 400 bad_request, ok:false and ownerId still present', async () => {
    const r = await call('POST', '/memory/fact', { user: U, body: {} });
    assert.equal(r.status, 400);
    assert.equal(r.json.success, false);
    assert.equal(r.json.ok, false, 'the engine result is still spread onto the body');
    assert.equal(r.json.code, ErrorCodes.BAD_REQUEST);
    assert.match(r.json.error, /required/);
    assert.ok(r.json.ownerId);
  });

  test('POST /fact then pin/unpin/archive/restore all succeed with success:true and ok:true', async () => {
    const a = await call('POST', '/memory/fact', { user: U, body: { key: 'favourite_colour', value: 'teal' } });
    assert.equal(a.status, 200, JSON.stringify(a.json));
    assert.equal(a.json.success, true); assert.equal(a.json.ok, true);
    // The engine canonicalises keys, so address the fact by the key it RETURNED.
    const k = encodeURIComponent(a.json.key);
    assert.equal((await call('POST', `/memory/fact/${k}/pin`, { user: U, body: {} })).status, 200);
    assert.equal((await call('POST', `/memory/fact/${k}/pin`, { user: U, body: { pinned: false } })).status, 200);
    assert.equal((await call('POST', `/memory/fact/${k}/archive`, { user: U, body: {} })).status, 200);
    assert.equal((await call('POST', `/memory/fact/${k}/archive`, { user: U, body: { restore: true } })).status, 200);
  });

  test('pin on a missing fact is 404 not_found (pin ONLY — the others are 400)', async () => {
    const r = await call('POST', '/memory/fact/ghost/pin', { user: U, body: {} });
    assert.equal(r.status, 404);
    assert.deepEqual([r.json.success, r.json.ok, r.json.code], [false, false, ErrorCodes.NOT_FOUND]);
    assert.equal(r.json.error, "Fact 'ghost' not found");
  });

  test('archive/merge/split failures are 400 bad_request (their pre-migration status)', async () => {
    const arch = await call('POST', '/memory/fact/ghost/archive', { user: U, body: {} });
    assert.equal(arch.status, 400); assert.equal(arch.json.code, ErrorCodes.BAD_REQUEST);
    assert.equal(arch.json.error, "Fact 'ghost' not found");
    const merge = await call('POST', '/memory/merge', { user: U, body: { keys: ['only-one'] } });
    assert.equal(merge.status, 400); assert.equal(merge.json.code, ErrorCodes.BAD_REQUEST);
    const split = await call('POST', '/memory/fact/ghost/split', { user: U, body: { parts: [{ key: 'a', value: 'b' }, { key: 'c', value: 'd' }] } });
    assert.equal(split.status, 400); assert.equal(split.json.code, ErrorCodes.BAD_REQUEST);
  });

  test('delete a fact and clear all report what they did', async () => {
    await call('POST', '/memory/fact', { user: U, body: { key: 'tmp_fact', value: 'x' } });
    const d = await call('DELETE', '/memory/fact/tmp_fact', { user: U });
    assert.equal(d.status, 200); assert.equal(d.json.deleted, 'tmp_fact');
    const c = await call('DELETE', '/memory', { user: U });
    assert.equal(c.status, 200); assert.equal(c.json.cleared, true);
  });
});

describe('legacy conversation-keyed routes — the ownership guard must survive', () => {
  test('another user\'s conversation → 404 not_found, never 403, on every legacy route', async () => {
    // `createConversation` takes a META OBJECT and returns the id. (A first draft
    // passed the user as a bare string, which left the conversation ownerless —
    // and an ownerless conversation also 404s for everyone, so the test passed
    // without proving ownership. The positive control below is what rules that out.)
    const id = Store.createConversation({ userId: OTHER });
    assert.equal(typeof id, 'string');
    for (const [method, p] of [['GET', `/memory/${id}`], ['GET', `/memory/${id}/k`], ['DELETE', `/memory/${id}/k`], ['DELETE', `/memory/${id}`]]) {
      const r = await call(method, p, { user: U });
      assert.equal(r.status, 404, `${method} ${p}`);
      assert.deepEqual([r.json.success, r.json.code], [false, ErrorCodes.NOT_FOUND]);
      assert.equal(r.json.error, 'Conversation not found');
    }
  });

  test('POSITIVE CONTROL: the OWNER of that same conversation is let through', async () => {
    const id = Store.createConversation({ userId: OTHER });
    const r = await call('GET', `/memory/${id}`, { user: OTHER });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.success, true);
    assert.equal(r.json.conversationId, id);
  });

  test('legacy fact lookup for a missing key is 404 not_found', async () => {
    const r = await call('GET', '/memory/some-conv-id/missing-key', { user: U });
    assert.equal(r.status, 404);
    assert.deepEqual([r.json.success, r.json.code], [false, ErrorCodes.NOT_FOUND]);
    assert.equal(r.json.error, "Fact 'missing-key' not found");
  });
});
void LTM;
