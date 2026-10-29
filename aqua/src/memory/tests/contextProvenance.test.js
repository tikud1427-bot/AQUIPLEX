/**
 * "Context used" on a reopened conversation (2026-10-29) — memory/contextProvenance.js
 * and GET /conversations/:id.
 *
 * Stored: references only (no personal text). Read: resolved against the
 * stores as they are now — unchanged shown, changed marked, forgotten never
 * shown (counted), World Model down counted as unavailable, never guessed.
 * Run: node scripts/run-tests.mjs src/memory/tests/contextProvenance.test.js
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-ctx-prov-'));
process.env.AQUA_DATA_DIR = tmp;
process.chdir(tmp);

const USER = 'prov-user';
const OWNER = `user:${USER}`;
const C1 = '0b7f8a8e-3c1d-4e2a-9f10-1a2b3c4d5e6f';
const C2 = '1c2d3e4f-0000-4000-8000-000000000000';
const C3 = '2d3e4f50-0000-4000-8000-000000000000';
let prov, ltm, conv, server, base;

before(async () => {
  prov = await import('../contextProvenance.js');
  ltm  = await import('../longTermMemory.js');
  conv = await import('../conversationStore.js');
  const { default: express } = await import('express');
  const { default: router } = await import('../../routes/conversations.js');
  const app = express();
  app.use((req, _res, next) => { req.aquaUserId = USER; next(); });
  app.use('/conversations', router);
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

const fakeClaims = rows => async (_owner, ids) => rows.filter(r => ids.includes(r.claimId));

test('stored references carry no personal text', () => {
  const refs = prov.contextRefs([
    { kind: 'claim', id: C1, text: 'We launch the beta on November 3.', disputed: false },
    { kind: 'fact', key: 'city', label: 'City', text: 'Guwahati' },
    { kind: 'other', text: 'ignored' },
  ]);
  assert.equal(refs.length, 2);
  assert.doesNotMatch(JSON.stringify(refs), /launch|beta|Guwahati/i);
  assert.deepEqual(prov.contextRefs(undefined), []);
});

test('resolution: unchanged shown; changed marked; forgotten never shown; DB down counted', async () => {
  ltm.storeFact(OWNER, { key: 'city', value: 'Guwahati', confidence: 0.9, importance: 6, ts: Date.now() });
  ltm.storeFact(OWNER, { key: 'favorite_food', value: 'momos', confidence: 0.9, importance: 6, ts: Date.now() });
  ltm.storeFact(OWNER, { key: 'pets', value: 'a cat named Biscuit', confidence: 0.9, importance: 6, ts: Date.now() });
  const refs = prov.contextRefs([
    { kind: 'fact', key: 'city', text: 'Guwahati' },
    { kind: 'fact', key: 'favorite_food', text: 'Momos' },
    { kind: 'fact', key: 'pets', text: 'A cat named Biscuit' },
    { kind: 'claim', id: C1, text: 'We charge $49 a month per clinic' },
    { kind: 'claim', id: C2, text: 'Launch is November 3' },
    { kind: 'claim', id: C3, text: 'My co-founder is Maya' },
  ]);
  // After the answer: food corrected, pets forgotten, C1 corrected (superseded), C3 forgotten (archived → not read).
  ltm.storeFact(OWNER, { key: 'favorite_food', value: 'dosa', confidence: 0.95, importance: 6, ts: Date.now(), isCorrection: true });
  ltm.deleteFact(OWNER, 'pets');
  const readClaims = fakeClaims([
    { claimId: C1, statement: 'We charge $49 a month per clinic', state: 'superseded' },
    { claimId: C2, statement: 'Launch is November 3', state: 'active' },
  ]);
  const out = await prov.resolveContextRefs(OWNER, refs, { readClaims });
  const by = Object.fromEntries(out.items.map(i => [i.key ?? i.id, i]));
  assert.equal(by.city.changed, false);
  assert.equal(by.city.text, 'Guwahati');
  assert.equal(by.favorite_food.changed, true, 'corrected since');
  assert.equal(by[C1].changed, true, 'superseded since');
  assert.equal(by[C2].changed, false);
  assert.ok(!out.items.some(i => /Biscuit|Maya/.test(i.text)), 'forgotten items never shown');
  assert.equal(out.removed, 2);
  assert.equal(out.unavailable, 0);

  const down = await prov.resolveContextRefs(OWNER, refs, { readClaims: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(down.unavailable, 3);
  assert.ok(!down.items.some(i => i.kind === 'claim'));
  assert.equal(await prov.resolveContextRefs(OWNER, [], {}), null);
});

test('GET /conversations/:id resolves references and never returns them raw', async () => {
  ltm.storeFact(OWNER, { key: 'city', value: 'Guwahati', confidence: 0.9, importance: 6, ts: Date.now() });
  const c = conv.getOrCreateConversation(null, { userId: USER });
  conv.addMessage(c.id, 'user', 'Where should I live?');
  conv.addMessage(c.id, 'assistant', 'Stay in Guwahati.', { contextRefs: prov.contextRefs([{ kind: 'fact', key: 'city', text: 'Guwahati' }]) });
  conv.addMessage(c.id, 'assistant', 'A plain answer.');
  const res = await fetch(`${base}/conversations/${c.id}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  const [, withCtx, plain] = body.messages;
  assert.equal(withCtx.contextRefs, undefined);
  assert.deepEqual(withCtx.contextUsed, { items: [{ kind: 'fact', key: 'city', label: 'City', text: 'Guwahati', changed: false }], removed: 0, unavailable: 0 });
  assert.equal(plain.contextUsed, undefined);
});

test('another account cannot read a conversation or its context', async () => {
  const c = conv.getOrCreateConversation(null, { userId: 'someone-else' });
  conv.addMessage(c.id, 'assistant', 'x', { contextRefs: [{ k: 'fact', key: 'city', h: 'abc' }] });
  const res = await fetch(`${base}/conversations/${c.id}`);
  assert.equal(res.status, 404);
});
