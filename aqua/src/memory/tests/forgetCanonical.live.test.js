/**
 * A forgotten or corrected memory must stop answering from the canonical World
 * Model too (audit 2026-10-12) — live Postgres, shipping read mode.
 *
 * Before: the Memory page deleted/corrected the LEGACY fact only, while the
 * default 'authoritative' read answers from aqua_claims — and its veto even
 * dropped the user's corrected legacy value because a current canonical claim
 * still owned that attribute. These tests seed claims through the production
 * understanding path (scripted extraction, no provider), act through the real
 * /memory router, then assert on Postgres claim state AND on the real
 * prepareTurn model input.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-forget-live-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
process.env.AQUA_E6 = 'on';
process.env.AQUA_CONTEXT_V2 = 'on';
process.env.AQUA_RETRIEVAL_V3 = 'on';
process.env.AQUA_SELF_ENTITY = 'on';
process.env.AQUA_BRAIN_INGEST = 'on';
process.env.AQUA_BRAIN_INGEST_FACTS = 'on';
delete process.env.AQUA_CANONICAL_READ;          // the shipping default: authoritative
for (const k of Object.keys(process.env)) {
  if (/(_API_KEY|^GEMINI_KEY|^SERPER|^TAVILY)/.test(k)) delete process.env[k];
}

const { isConfigured, getPool } = await import('../../core/db/pool.js');
const LIVE = isConfigured();
const skip = LIVE ? false : 'needs a live migrated Postgres — set AQUA_TEST_DATABASE_URL';

const { __setEmbedderForTests } = await import('../../embeddings/embeddingProvider.js');
__setEmbedderForTests(async texts => texts.map(t => {
  const v = new Array(768).fill(0);
  for (const w of String(t).toLowerCase().match(/[a-z0-9]+/g) ?? []) v[crypto.createHash('md5').update(w).digest().readUInt32BE(0) % 768] += 1;
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}));

const Brain = await import('../../brain/index.js');
const mem = await import('../engine.js');
const LTM = await import('../longTermMemory.js');
const { prepareTurn } = await import('../../routes/chat.js');
const { createContext } = await import('../../core/observability.js');
const { default: memoryRoute } = await import('../../routes/memory.js');
const { purgeOwnerData } = await import('../../account/accountPurge.js');

const USER = `fgt-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const OWNER = `user:${USER}`;

const claim = (subject, predicate, object, statementText) => ({
  subject, predicate, object, statementText, polarity: 'asserted', modality: 'fact', timePrecision: 'none', confidenceExtraction: 0.9,
});
const SCRIPT = new Map([
  ['I live in Lisbon', [claim('I', 'located_in', { entity: 'Lisbon' }, 'I live in Lisbon')]],
  ['I work at Nummo', [claim('I', 'works_at', { entity: 'Nummo' }, 'I work at Nummo')]],
  ['My sister Ana lives in Lisbon', [claim('Ana', 'located_in', { entity: 'Lisbon' }, 'My sister Ana lives in Lisbon')]],
  ['I prefer short bullet-point answers', [claim('I', 'prefers', { literal: 'short bullet-point answers' }, 'I prefer short bullet-point answers')]],
]);
const callModel = async (arg = {}) => {
  const seen = JSON.stringify(arg);
  const key = [...SCRIPT.keys()].sort((a, b) => b.length - a.length).find(k => seen.includes(k));
  return { text: JSON.stringify({ claims: key ? SCRIPT.get(key) : [] }), model: 'scripted/forget' };
};

let turn = 0;
/** One user turn, the way production records it: legacy observe + conversation lane + canonical understanding. */
async function say(text) {
  const t = ++turn;
  mem.memoryObserve(OWNER, { userMessage: `${text}.`, taskType: 'personal_info', conversationId: 'c-fgt', userId: USER, requestId: `s${t}` });
  await Brain.observeConversationTurn({ ownerId: OWNER, conversationId: 'c-fgt', turn: t, userMessage: `${text}.`, assistantMessage: 'Got it.' });
  await Brain.understandTurn({ ownerId: OWNER, conversationId: 'c-fgt', turn: t, userMessage: `${text}.`, callModel });
}
let q = 0;
async function promptFor(question) {
  const conv = `c-fgt-ask-${q++}`;
  const p = await prepareTurn({ userMessage: question, workspaceId: null, conversationId: conv, userId: USER,
    ctx: createContext({ conversationId: conv, requestId: conv }), requestId: conv, skipReasoningPass: true });
  return String(p.systemPrompt);
}
async function claims() {
  const p = await getPool();
  const { rows } = await p.query(`
    SELECT c.claim_id, c.predicate, c.state, c.extractor, se.type AS subject_type, se.canonical_label AS subject,
           COALESCE(oe.canonical_label, c.object_literal) AS val
      FROM aqua_claims c
      JOIN aqua_entities se ON se.entity_id=c.subject_entity_id AND se.owner_id=c.owner_id
      LEFT JOIN aqua_entities oe ON oe.entity_id=c.object_entity_id AND oe.owner_id=c.owner_id
     WHERE c.owner_id=$1`, [OWNER]);
  return rows;
}
// The user's own claims: the self entity is typed 'self', or (older schema) labelled "You".
const isSelf = r => r.subject_type === 'self' || r.subject === 'You';
const find = (rows, pred, val, self = true) => rows.filter(r => r.predicate === pred && String(r.val).toLowerCase() === val.toLowerCase() && isSelf(r) === self);
const CURRENT = new Set(['active', 'trusted']);

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.aquaUserId = USER; next(); });
app.use('/memory', memoryRoute);
let server, base;
const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

describe('user memory control reaches the canonical World Model', { skip }, () => {
  before(async () => {
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    for (const s of SCRIPT.keys()) await say(s);
  });
  after(async () => {
    server?.close();
    await purgeOwnerData({ userId: USER });
  });

  test('precondition: the facts are current canonical claims, answer the question, and the legacy rows exist', async () => {
    const rows = await claims();
    assert.ok(find(rows, 'located_in', 'Lisbon').some(r => CURRENT.has(r.state)), JSON.stringify(rows));
    assert.ok(find(rows, 'works_at', 'Nummo').some(r => CURRENT.has(r.state)));
    assert.ok(find(rows, 'located_in', 'Lisbon', false).some(r => CURRENT.has(r.state)), 'Ana\'s claim');
    assert.equal(LTM.getFact(OWNER, 'city')?.value, 'Lisbon');
    assert.equal(LTM.getFact(OWNER, 'workplace')?.value, 'Nummo');
    assert.match(await promptFor('Where do I live?'), /I live in Lisbon/, 'positive control');
  });

  test('DELETE /memory/fact/city: the user\'s canonical claim is archived and stops answering; Ana\'s is kept', async () => {
    const r = await call('DELETE', '/memory/fact/city');
    assert.equal(r.status, 200);
    const rows = await claims();
    assert.ok(find(rows, 'located_in', 'Lisbon').every(c => c.state === 'archived'), JSON.stringify(find(rows, 'located_in', 'Lisbon')));
    assert.ok(find(rows, 'located_in', 'Lisbon', false).some(c => CURRENT.has(c.state)), 'over-forgot Ana');
    assert.ok(find(rows, 'works_at', 'Nummo').some(c => CURRENT.has(c.state)), 'over-forgot workplace');
    assert.doesNotMatch(await promptFor('Where do I live?'), /I live in Lisbon/);
    // Idempotent: a retry (e.g. after a timeout) is a no-op, not an error.
    assert.equal((await call('DELETE', '/memory/fact/city')).status, 200);
  });

  test('POST /memory/fact (correct workplace → Globex): canonical is corrected, the answer follows the user', async () => {
    assert.match(await promptFor('Where do I work?'), /Nummo/, 'positive control');
    const r = await call('POST', '/memory/fact', { key: 'workplace', value: 'Globex' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rows = await claims();
    assert.ok(find(rows, 'works_at', 'Nummo').every(c => !CURRENT.has(c.state)), 'old canonical value still current');
    assert.ok(find(rows, 'works_at', 'Globex').some(c => CURRENT.has(c.state) && c.extractor === 'user-correction'), JSON.stringify(rows.filter(x => x.predicate === 'works_at')));
    const after = await promptFor('Where do I work?');
    assert.match(after, /Globex/);
    assert.doesNotMatch(after, /Nummo/, 'the corrected value still reaches the model input');
  });

  test('DELETE /memory (forget all): nothing from the user\'s conversations or corrections answers', async () => {
    const r = await call('DELETE', '/memory');
    assert.equal(r.status, 200);
    const rows = await claims();
    const live = rows.filter(c => CURRENT.has(c.state));
    assert.deepEqual(live, [], `still current after forget-all: ${JSON.stringify(live)}`);
    const after = await promptFor('What do you know about me? Where do I work, what do I prefer?');
    for (const v of ['Globex', 'Nummo', 'bullet-point']) assert.doesNotMatch(after, new RegExp(v), `${v} survived forget-all`);
  });
});
