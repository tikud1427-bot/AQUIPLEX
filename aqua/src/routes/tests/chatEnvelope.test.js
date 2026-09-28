/**
 * chat.js — error `code` on the four early-return paths (E11 / Phase 10)
 *
 * chat.js had no dedicated route-level tests: the only thing touching it was
 * the IDOR check in uploadAuth.test.js, which asserts status only. This pins
 * the additive `code` field on the guard/validation returns that fire BEFORE
 * any provider, memory or streaming machinery runs, so nothing here touches
 * a provider or the network.
 *
 *   POST /chat         empty message → 400 bad_request
 *   POST /chat/stream  empty message → 400 bad_request
 *   POST /chat         someone else's conversation → 404 not_found
 *   POST /chat/stream  someone else's conversation → 404 not_found
 *
 * NOT covered here, deliberately: the 503/500 generation-failure response.
 * Reaching it means making the whole provider pipeline fail on cue, which
 * needs its own fixture — a real gap, not a claim of coverage.
 *
 * Additive contract: `code` is new; success/requestId/conversationId/error
 * keep exactly the shape they had, so the assertions below also pin those.
 *
 * Harness: same as uploadAuth.test.js.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-chat-envelope-'));
process.env.AQUA_DATA_DIR = TMP;

const { default: chatRoute } = await import('../chat.js');
const { ErrorCodes }         = await import('../envelope.js');
const convStore              = await import('../../memory/conversationStore.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const u = req.headers['x-test-user'];
  if (u) req.aquaUserId = String(u);
  next();
});
app.use('/chat', chatRoute);

let server, base, aliceConv;

const post = async (p, { user, body } = {}) => {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json };
};

before(() => {
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  aliceConv = convStore.getOrCreateConversation(null, { userId: 'alice' }).id;
  assert.ok(aliceConv);
});

after(() => server.close());

for (const route of ['/chat', '/chat/stream']) {
  test(`${route}: empty message → 400 with code bad_request, existing fields intact`, async () => {
    for (const body of [{}, { message: '' }, { message: '   ' }, { message: 42 }]) {
      const { status, body: b } = await post(route, { user: 'alice', body });
      assert.equal(status, 400, JSON.stringify(body));
      assert.equal(b.success, false);
      assert.equal(b.code, ErrorCodes.BAD_REQUEST);
      assert.match(b.error, /message is required/);
      assert.ok(b.requestId, 'requestId is still returned');
      assert.ok(b.conversationId, 'conversationId is still returned');
    }
  });

  test(`${route}: someone else's conversation → 404 with code not_found, no existence oracle`, async () => {
    const hit = await post(route, { user: 'bob', body: { conversationId: aliceConv, message: 'hi' } });
    assert.equal(hit.status, 404);
    assert.equal(hit.body.success, false);
    assert.equal(hit.body.code, ErrorCodes.NOT_FOUND);
    assert.equal(hit.body.error, 'Conversation not found');
    assert.ok(hit.body.requestId);
    assert.equal(hit.body.conversationId, undefined, 'a 404 must not echo the id back');
  });
}
