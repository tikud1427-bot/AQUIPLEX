/**
 * UUS U5 — the world-model card (node:test).
 *
 * "Here's what I understand about you" is the moment the brief is written
 * around, and the one place where being WRONG costs more than being thin.
 *
 * So most of this suite guards omission, not inclusion: what gets left off the
 * card, and what happens when there is almost nothing to say.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.AQUA_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-u5-'));

const { buildCard, CARD_CONFIDENCE_FLOOR } = await import('../summary.js');
const understandingRoute = (await import('../understandingRoutes.js')).default;
const { getMind } = await import('../../mind/mindStore.js');
const { observeSignal } = await import('../../mind/beliefEngine.js');
const { trackGoals } = await import('../../mind/goalTracker.js');
const { getOrCreateConversation } = await import('../../memory/conversationStore.js');
const { DIMENSIONS } = await import('../../mind/mindSchema.js');

const belief = (dimension, key, value, confidence = 0.8) => ({
  dimension, key, value, confidence, evidenceCount: 2, status: 'active',
});

// ── 1. It says something true ────────────────────────────────────────────────

test('U5: a real account produces a readable card', () => {
  const card = buildCard({
    beliefsByDimension: {
      identity: [belief('identity', 'profession', 'founder and software engineer', 0.9)],
      communication: [belief('communication', 'message_style', 'terse', 0.6)],
    },
    goals: [{ id: 'g1', title: 'launch the beta', status: 'active', confidence: 0.7 }],
    projects: [{ id: 'ent:proj:aqua', label: 'AQUA' }],
    score: 61,
  });

  const ids = card.sections.map(s => s.id);
  assert.deepEqual(ids, ['you', 'working_on', 'aiming_at', 'how_to_help']);
  assert.equal(card.sections[0].items[0].text, 'founder and software engineer');
  assert.equal(card.sections[2].items[0].text, 'launch the beta');
  assert.equal(card.score, 61);
  assert.equal(card.isThin, false);
});

test('U5: every item carries a correction ref', () => {
  // The card is where someone first thinks "no, that's not right" — so every
  // line must be correctable without hunting for it in a settings screen.
  const card = buildCard({
    beliefsByDimension: { identity: [belief('identity', 'profession', 'founder', 0.9)] },
    goals: [{ id: 'g1', title: 'ship it', status: 'active', confidence: 0.7 }],
    projects: [{ id: 'ent:p:x', label: 'X' }],
    score: 40,
  });
  for (const s of card.sections) {
    for (const i of s.items) assert.ok(/^(belief|goal|entity):/.test(i.ref), `bad ref: ${i.ref}`);
  }
});

// ── 2. Omission — most of the value is here ──────────────────────────────────

test('U5: an empty section is DROPPED, never rendered as unknown', () => {
  const card = buildCard({
    beliefsByDimension: { identity: [belief('identity', 'profession', 'teacher', 0.9)] },
    goals: [], projects: [], score: 20,
  });
  assert.deepEqual(card.sections.map(s => s.id), ['you']);
  // The failure this guards: a card with "Goals: unknown · Projects: unknown"
  // reads as a list of the user's omissions on the screen meant to earn trust.
  const json = JSON.stringify(card);
  assert.ok(!/unknown/i.test(json));
  assert.ok(!/not (yet )?(known|provided|set)/i.test(json));
});

test('U5: a guess never appears as a fact', () => {
  const card = buildCard({
    beliefsByDimension: {
      identity: [
        belief('identity', 'profession', 'founder', 0.9),
        belief('identity', 'city', 'Berlin', CARD_CONFIDENCE_FLOOR - 0.05),
      ],
    },
    goals: [], projects: [], score: 30,
  });
  const texts = card.sections.flatMap(s => s.items.map(i => i.text));
  assert.ok(texts.includes('founder'));
  assert.ok(!texts.includes('Berlin'), 'below the floor is a follow-up question, not a card line');
});

test('U5: archived beliefs never reach the card', () => {
  const stale = { ...belief('identity', 'profession', 'student', 0.95), status: 'archived' };
  const card = buildCard({ beliefsByDimension: { identity: [stale] }, score: 10 });
  assert.deepEqual(card.sections, []);
});

test('U5: a completed goal is not something you are aiming at', () => {
  const card = buildCard({
    beliefsByDimension: {},
    goals: [{ id: 'g1', title: 'ship v1', status: 'completed', confidence: 0.9 }],
    score: 15,
  });
  assert.ok(!card.sections.some(s => s.id === 'aiming_at'));
});

test('U5: duplicate values collapse to one line', () => {
  const card = buildCard({
    beliefsByDimension: {
      communication: [belief('communication', 'message_style', 'terse', 0.8)],
      preferences: [belief('preferences', 'style', 'Terse', 0.7)],
    },
    score: 25,
  });
  const items = card.sections.find(s => s.id === 'how_to_help').items;
  assert.equal(items.length, 1, 'saying the same thing twice makes the card look padded');
});

test('U5: a thin card admits it', () => {
  // Someone answered two questions and stopped. That is a real outcome, and
  // the UI needs to know so it can say something honest rather than presenting
  // three lines as a finished portrait.
  const thin = buildCard({
    beliefsByDimension: { identity: [belief('identity', 'profession', 'founder', 0.9)] },
    score: 18,
  });
  assert.equal(thin.isThin, true);
});

test('U5: the headline never announces completion', () => {
  // "Setup complete" is explicitly what the brief says not to say.
  const card = buildCard({ score: 0 });
  assert.ok(!/complete|success|all set|done|welcome aboard/i.test(card.headline));
  assert.ok(!card.headline.includes('!'), 'the card repeats back what it heard; it does not celebrate');
});

test('U5: malformed input degrades to an empty card, never throws', () => {
  for (const bad of [undefined, {}, { beliefsByDimension: null, goals: null, projects: null }]) {
    const card = buildCard(bad);
    assert.ok(Array.isArray(card.sections));
    assert.equal(card.isThin, true);
  }
});

// ── 3. The endpoints ─────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.aquaUserId = req.get('x-test-user') || null; next(); });
app.use('/understanding', understandingRoute);

let server, base;
test.before(async () => { await new Promise(r => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server?.close());

const post = async (p, user, body = {}) => {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const get = async (p, user) => {
  const res = await fetch(`${base}${p}`, { headers: user ? { 'x-test-user': user } : {} });
  return { status: res.status, body: await res.json() };
};

test('U5: the gate offers the intro to an account AQUA knows nothing about', async () => {
  const { status, body } = await get('/understanding/intro/state', 'u5-fresh');
  assert.equal(status, 200);
  assert.equal(body.score, 0);
  assert.equal(body.hasIntro, false);
  assert.equal(body.shouldOffer, true);
});

test('U5: completing the intro returns the card and stops the offer', async () => {
  const owner = 'user:u5-done';
  const mind = getMind(owner);
  observeSignal(mind, { dimension: DIMENSIONS.IDENTITY, key: 'profession', value: 'founder', explicit: true });
  trackGoals(mind, { userMessage: 'I want to launch the beta this quarter.' });

  // The conversation must exist — updateConversationMeta is a no-op on an
  // unknown id, which is correct: you cannot complete an intro that never
  // happened. In production the chat pipeline has already created it.
  getOrCreateConversation('conv-u5');

  const done = await post('/understanding/intro/complete', 'u5-done', { conversationId: 'conv-u5' });
  assert.equal(done.status, 200);
  assert.equal(done.body.card.sections[0].items[0].text, 'founder');
  assert.ok(!/complete/i.test(done.body.card.headline));

  const state = await get('/understanding/intro/state?conversationId=conv-u5', 'u5-done');
  assert.equal(state.body.hasIntro, true);
  assert.equal(state.body.shouldOffer, false);
});

test('U5: someone who did the intro is never re-offered it, even at a low score', async () => {
  // Re-offering reads as "you failed". Understanding grows from ordinary
  // conversation afterwards; that is the design, not a fallback.
  const state = await get('/understanding/intro/state?conversationId=conv-u5', 'u5-nobeliefs');
  assert.equal(state.body.hasIntro, true);
  assert.equal(state.body.shouldOffer, false);
});

test('U5: skipping immediately returns an honest empty card, not an error', async () => {
  const { status, body } = await post('/understanding/intro/complete', 'u5-skipper', {});
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(body.card.sections, []);
  assert.equal(body.card.isThin, true);
});

test('U5: the card reads the SAME score the dashboard shows', async () => {
  // One formula, one number. A card and a dashboard disagreeing about how well
  // AQUA knows someone is the exact failure U4 moved the score server-side to
  // prevent.
  const card = await post('/understanding/intro/complete', 'u5-done', { conversationId: 'conv-u5' });
  const dash = await get('/understanding', 'u5-done');
  assert.equal(card.body.card.score, dash.body.score);
});

test('U5: the intro marker actually persists — the U2 silent-drop regression', async () => {
  // U2 wrote conversation.meta.kind for a full phase and every write was
  // DISCARDED: updateConversationMeta has a whitelist and `continue`s past
  // anything unlisted, with no error and no log. The architecture called meta
  // "an open bag"; it is not. This pins the fix.
  const { getOrCreateConversation, updateConversationMeta, getConversationMeta } =
    await import('../../memory/conversationStore.js');

  getOrCreateConversation('conv-marker');
  updateConversationMeta('conv-marker', { kind: 'understanding_intro' });
  assert.equal(getConversationMeta('conv-marker')?.kind, 'understanding_intro');

  // …and an unrecognised role is still rejected rather than stored.
  updateConversationMeta('conv-marker', { kind: 'onboarding_wizard' });
  assert.equal(getConversationMeta('conv-marker')?.kind, 'understanding_intro');

  // An unknown conversation stays a no-op — you cannot complete an intro that
  // never happened.
  assert.equal(updateConversationMeta('conv-never-existed', { kind: 'understanding_intro' }), null);
});

test('U5: summary.js is pure — it cannot reach a store', async () => {
  const src = fs.readFileSync(new URL('../summary.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
  assert.deepEqual(imports, ['./coverage.js'], 'the assembler must import coverage and nothing else');
});
