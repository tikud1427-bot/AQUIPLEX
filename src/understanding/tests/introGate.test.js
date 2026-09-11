/**
 * UUS — the first-run gate contract (node:test).
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * The gate shipped as three pieces that never met: a hook, a route and an
 * intro screen, with nothing calling any of them. A brand-new account went
 * to the project empty state and was never offered the introduction. Nothing
 * failed, so nothing said so — the same shape as every other bug this sprint
 * surfaced.
 *
 * The UI wiring is pinned by tsc and by the browser. What is pinned HERE is
 * the answer the UI now depends on, because a redirect built on a wrong
 * `shouldOffer` is worse than no redirect at all: it traps people.
 *
 *   1. A brand-new account is offered the intro.       (the reported bug)
 *   2. NEVER RE-OFFER survives the boot with no conversation id — the exact
 *      request the gate makes, and the one the old per-conversation lookup
 *      always answered "no intro" to.
 *   3. Owners do not leak. Bob's intro never silences Alice's offer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.AQUA_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-gate-'));

const understandingRoute = (await import('../understandingRoutes.js')).default;
const { createConversation, updateConversationMeta } = await import('../../memory/conversationStore.js');

const ALICE = 'gate-alice';
const BOB = 'gate-bob';

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.aquaUserId = req.get('x-test-user') || null; next(); });
app.use('/understanding', understandingRoute);

let server, base;
test.before(async () => {
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server?.close());

/** Exactly what the browser sends at boot: no conversation id at all. */
const gateState = async (user, conversationId = null) => {
  const url = new URL(`${base}/understanding/intro/state`);
  if (conversationId) url.searchParams.set('conversationId', conversationId);
  const res = await fetch(url, { headers: user ? { 'x-test-user': user } : {} });
  return res.json();
};

/** An intro conversation as /intro/complete leaves it. */
function completedIntroFor(userId) {
  const id = createConversation({ userId });
  const meta = updateConversationMeta(id, { kind: 'understanding_intro', introCompletedAt: Date.now() });
  assert.equal(meta?.kind, 'understanding_intro', 'marker must actually land');
  return id;
}

test('gate: a brand-new account is offered the intro', async () => {
  const body = await gateState(ALICE);
  assert.equal(body.success, true);
  assert.equal(body.ownerId, `user:${ALICE}`);
  assert.equal(body.hasIntro, false);
  assert.equal(body.score, 0);
  assert.equal(body.shouldOffer, true);
});

test('gate: an ordinary conversation is not an intro', async () => {
  const id = createConversation({ userId: ALICE });
  const body = await gateState(ALICE, id);
  assert.equal(body.hasIntro, false);
  assert.equal(body.shouldOffer, true);
});

test('gate: NEVER RE-OFFER holds with no conversation id — the boot request', async () => {
  completedIntroFor(BOB);

  // This is the call the gate actually makes on a fresh tab. Reading the meta
  // of "whichever conversation was passed" answered false here every time, so
  // a skipper whose score stayed at zero was re-offered on every visit.
  const body = await gateState(BOB);
  assert.equal(body.hasIntro, true, 'the account did the intro; the id it happened in is not the question');
  assert.equal(body.shouldOffer, false);
});

test('gate: re-offer stays off even when nothing was learned', async () => {
  // Someone who opened the intro and skipped after one word. Score is still
  // zero — and must NOT bring the offer back. Re-offering reads as "you
  // failed", which is the one thing the rule exists to prevent.
  const body = await gateState(BOB);
  assert.equal(body.score, 0);
  assert.equal(body.shouldOffer, false);
});

test('gate: one account\'s intro never silences another\'s offer', async () => {
  const alice = await gateState(ALICE);
  assert.equal(alice.hasIntro, false);
  assert.equal(alice.shouldOffer, true, "Bob's intro must not answer for Alice");
});

test('gate: no owner still answers, and still offers', async () => {
  // Logged-out / dev fallback. The gate FAILS CLOSED on a thrown request; an
  // answered one with nothing behind it is a new user by every signal there is.
  const body = await gateState(null);
  assert.equal(body.success, true);
  assert.equal(body.ownerId, null);
  assert.equal(body.shouldOffer, true);
});
