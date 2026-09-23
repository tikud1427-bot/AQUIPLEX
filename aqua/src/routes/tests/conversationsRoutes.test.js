/**
 * conversations.js — envelope migration + the ownership guard it must not
 * regress (IDOR fix: GET/PATCH/DELETE /:id return 404, never 403, for a
 * conversation that exists but belongs to someone else).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-conversations-routes-'));
process.env.AQUA_DATA_DIR = TMP;

const Store = await import('../../memory/conversationStore.js');
const { default: conversationsRoute } = await import('../conversations.js');
const { ErrorCodes } = await import('../envelope.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const u = req.headers['x-test-user'];
  if (u) req.aquaUserId = String(u);
  next();
});
app.use('/conversations', conversationsRoute);

let server, base;
before(() => { server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`; });
// Not removing TMP: the store's debounced writer can flush after the suite
// ends, and a delete here just turns that into a noisy ENOENT instead of a
// no-op. Same call brainRoutes.test.js makes, for the same reason.
after(() => { server.close(); });

const req = async (method, p, { user, body } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(user ? { 'x-test-user': user } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json };
};

describe('conversations.js — envelope + ownership guard', () => {
  test('list: success:true, no code field on a happy path', async () => {
    const { status, body } = await req('GET', '/conversations?limit=5');
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal('code' in body, false);
    assert.ok(Array.isArray(body.conversations));
  });

  test('get one: owner can read their own conversation', async () => {
    const id = Store.createConversation({ userId: 'user:alice' });
    Store.addMessage(id, 'user', 'hello');
    const { status, body } = await req('GET', `/conversations/${id}`, { user: 'user:alice' });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.id, id);
    assert.equal(body.messageCount, 1);
  });

  test('get one: a different owner gets 404 with code=not_found, not 403 — no existence oracle', async () => {
    const id = Store.createConversation({ userId: 'user:alice' });
    const { status, body } = await req('GET', `/conversations/${id}`, { user: 'user:bob' });
    assert.equal(status, 404);
    assert.equal(body.success, false);
    assert.equal(body.code, ErrorCodes.NOT_FOUND);
    assert.equal(body.error, 'Conversation not found');
  });

  test('get one: a genuinely missing id gets the identical shape as a cross-owner mismatch', async () => {
    const { status, body } = await req('GET', '/conversations/does-not-exist', { user: 'user:alice' });
    assert.equal(status, 404);
    assert.equal(body.code, ErrorCodes.NOT_FOUND);
  });

  test('patch: updates title/pinned/archived under the envelope', async () => {
    const id = Store.createConversation({ userId: 'user:alice' });
    const { status, body } = await req('PATCH', `/conversations/${id}`, {
      user: 'user:alice', body: { title: 'Renamed', pinned: true },
    });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.meta.title, 'Renamed');
    assert.equal(body.meta.pinned, true);
  });

  test('patch: an empty body is bad_request/400, not a silent no-op', async () => {
    const id = Store.createConversation({ userId: 'user:alice' });
    const { status, body } = await req('PATCH', `/conversations/${id}`, { user: 'user:alice', body: {} });
    assert.equal(status, 400);
    assert.equal(body.code, ErrorCodes.BAD_REQUEST);
  });

  test('delete: clears the conversation under the envelope', async () => {
    const id = Store.createConversation({ userId: 'user:alice' });
    const { status, body } = await req('DELETE', `/conversations/${id}`, { user: 'user:alice' });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.cleared, id);
    assert.equal(Store.conversationExists(id), false);
  });
});
