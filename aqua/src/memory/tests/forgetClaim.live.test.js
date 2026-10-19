/**
 * "What Aqua holds now" + "delete this" on ONE canonical claim (2026-10-16) —
 * live Postgres, shipping read mode (authoritative).
 *
 * The Memory page used to list the legacy fact store while answers came from
 * canonical claims. These tests drive the real /brain router: GET /current
 * shows what answers (with the sentence it came from), POST
 * /claims/:id/forget removes it from every store that could answer, a legacy
 * copy written AFTER the deletion (a background re-derivation) cannot bring it
 * back, and another account cannot delete it. Claims are seeded through the
 * production understanding path (scripted extraction, no provider); answers
 * are checked on the real prepareTurn model input.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-forget-claim-live-'));
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
const { default: brainRoute } = await import('../../routes/brain.js');
const { purgeOwnerData } = await import('../../account/accountPurge.js');

const USER = `fgc-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const OWNER = `user:${USER}`;
const OTHER = `${USER}-other`;

const claim = (subject, predicate, object, statementText) => ({
  subject, predicate, object, statementText, polarity: 'asserted', modality: 'fact', timePrecision: 'none', confidenceExtraction: 0.9,
});
const SCRIPT = new Map([
  ['I live in Lisbon', [claim('I', 'located_in', { entity: 'Lisbon' }, 'I live in Lisbon')]],
  ['I work at Nummo', [claim('I', 'works_at', { entity: 'Nummo' }, 'I work at Nummo')]],
  ['My sister Ana lives in Lisbon', [claim('Ana', 'located_in', { entity: 'Lisbon' }, 'My sister Ana lives in Lisbon')]],
  ['I prefer short bullet-point answers', [claim('I', 'prefers', { literal: 'short bullet-point answers' }, 'I prefer short bullet-point answers')]],
  // One sentence, two claims about someone else — the live-journey failure shape.
  ['My co-founder Maya runs engineering', [
    // Phrased differently per claim, as the live extractor did (2026-10-17);
    // what they share is the evidence: the sentence the user said.
    claim('Maya', 'manages', { entity: 'engineering' }, 'Maya runs engineering'),
    claim('Maya', 'related_to', { literal: 'co-founder' }, 'My co-founder Maya'),
  ]],
]);
const callModel = async (arg = {}) => {
  const seen = JSON.stringify(arg);
  const key = [...SCRIPT.keys()].sort((a, b) => b.length - a.length).find(k => seen.includes(k));
  return { text: JSON.stringify({ claims: key ? SCRIPT.get(key) : [] }), model: 'scripted/forget-claim' };
};

let turn = 0;
async function say(text) {
  const t = ++turn;
  mem.memoryObserve(OWNER, { userMessage: `${text}.`, taskType: 'personal_info', conversationId: 'c-fgc', userId: USER, requestId: `s${t}` });
  await Brain.observeConversationTurn({ ownerId: OWNER, conversationId: 'c-fgc', turn: t, userMessage: `${text}.`, assistantMessage: 'Got it.' });
  await Brain.understandTurn({ ownerId: OWNER, conversationId: 'c-fgc', turn: t, userMessage: `${text}.`, callModel });
}
let q = 0;
async function promptFor(question) {
  const conv = `c-fgc-ask-${q++}`;
  const p = await prepareTurn({ userMessage: question, workspaceId: null, conversationId: conv, userId: USER,
    ctx: createContext({ conversationId: conv, requestId: conv }), requestId: conv, skipReasoningPass: true });
  return String(p.systemPrompt);
}
async function stateOf(claimId) {
  const { rows } = await (await getPool()).query('SELECT state FROM aqua_claims WHERE owner_id=$1 AND claim_id=$2', [OWNER, claimId]);
  return rows[0]?.state ?? null;
}

const app = express();
app.use(express.json());
// The platform injects the session identity; here a header plays the session.
app.use((req, _res, next) => { req.aquaUserId = req.get('x-test-user') ?? USER; next(); });
app.use('/brain', brainRoute);
let server, base;
const call = async (method, p, { body, user = USER } = {}) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': user }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let current = [];
const findCurrent = re => current.find(c => re.test(c.statement));

describe('the Memory page shows what answers, and "delete" removes it everywhere', { skip }, () => {
  before(async () => {
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    for (const s of SCRIPT.keys()) await say(s);
  });
  after(async () => {
    server?.close();
    await purgeOwnerData({ userId: USER });
  });

  test('GET /brain/current lists the current canonical claims with the sentence each came from', async () => {
    const r = await call('GET', '/brain/current');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.configured, true);
    current = r.body.claims;
    const work = findCurrent(/Nummo/);
    assert.ok(work, JSON.stringify(current));
    assert.match(String(work.quote), /I work at Nummo/);
    assert.equal(work.sourceKind, 'conversation');
    assert.ok(work.assertedAt);
  });

  test('another account cannot delete it (404, and it stays current)', async () => {
    const work = findCurrent(/Nummo/);
    const r = await call('POST', `/brain/claims/${work.claimId}/forget`, { user: OTHER });
    assert.equal(r.status, 404);
    assert.ok(['active', 'trusted'].includes(await stateOf(work.claimId)));
  });

  test('POST /brain/claims/:id/forget archives the claim, removes the legacy copy, and it stops answering', async () => {
    assert.match(await promptFor('Where do I work?'), /Nummo/, 'positive control');
    assert.equal(LTM.getFact(OWNER, 'workplace')?.value, 'Nummo', 'precondition: legacy copy exists');
    const work = findCurrent(/Nummo/);
    const r = await call('POST', `/brain/claims/${work.claimId}/forget`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await stateOf(work.claimId), 'archived');
    assert.equal(LTM.getFact(OWNER, 'workplace'), null, 'legacy copy survived');
    assert.doesNotMatch(await promptFor('Where do I work?'), /Nummo/);
    const after = await call('GET', '/brain/current');
    assert.ok(!after.body.claims.some(c => /Nummo/.test(c.statement)), 'still listed after deletion');
  });

  test('a legacy copy written AFTER the deletion (background re-derivation) cannot bring it back', async () => {
    LTM.storeFact(OWNER, { key: 'workplace', value: 'Nummo', normalizedValue: 'nummo', confidence: 0.9, importance: 8, ts: Date.now() });
    assert.equal(LTM.getFact(OWNER, 'workplace')?.value, 'Nummo', 'precondition: resurrected legacy row');
    assert.doesNotMatch(await promptFor('Where do I work?'), /Nummo/, 'a deleted fact answered again through the legacy store');
  });

  test('nothing else was forgotten: the city and the sister\'s claim still answer', async () => {
    const p = await promptFor('Where do I live, and where does my sister Ana live?');
    assert.match(p, /Lisbon/);
  });

  test('POST /brain/claims/:id/correct-value: another account gets 404; the owner\'s new value becomes the stored object and answers', async () => {
    current = (await call('GET', '/brain/current')).body.claims;
    const pref = findCurrent(/bullet-point/);
    assert.ok(pref, JSON.stringify(current));
    assert.match(await promptFor('How do I like my answers?'), /bullet-point/, 'positive control');

    assert.equal((await call('POST', `/brain/claims/${pref.claimId}/correct-value`, { user: OTHER, body: { value: 'long detailed answers' } })).status, 404);

    const r = await call('POST', `/brain/claims/${pref.claimId}/correct-value`, { body: { value: 'long detailed answers' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await stateOf(pref.claimId), 'superseded');
    const { rows } = await (await getPool()).query('SELECT state, object_literal FROM aqua_claims WHERE owner_id=$1 AND claim_id=$2', [OWNER, r.body.claimId]);
    assert.equal(rows[0]?.object_literal, 'long detailed answers', 'the structured object kept the old value');
    assert.ok(['active', 'trusted'].includes(rows[0]?.state));

    const p = await promptFor('How do I like my answers?');
    assert.match(p, /long detailed answers/);
    assert.doesNotMatch(p, /bullet-point/, 'the corrected value still reaches the model input');

    const listed = (await call('GET', '/brain/current')).body.claims;
    const shown = listed.find(c => /long detailed answers/.test(c.statement));
    assert.ok(shown, 'the correction is not on the page');
    assert.equal(shown.sourceKind, 'user_correction');
    assert.ok(!listed.some(c => /bullet-point/.test(c.statement)), 'the old value is still listed as current');
  });

  test('deleting one claim of a sentence removes the sentence: siblings, the person\'s legacy copy, and re-derived copies', async () => {
    current = (await call('GET', '/brain/current')).body.claims;
    const maya = current.filter(c => /Maya/.test(c.statement));
    assert.ok(maya.length >= 2, `precondition: two claims from one sentence: ${JSON.stringify(maya)}`);
    assert.match(await promptFor('Who is my co-founder?'), /Maya/, 'positive control');
    // The regex extractor's wrong value in the role slot (seen live: "And").
    LTM.storeFact(OWNER, { key: 'cofounder', value: 'And', normalizedValue: 'and', confidence: 0.92, importance: 10, ts: Date.now() });

    const r = await call('POST', `/brain/claims/${maya[0].claimId}/forget`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    for (const c of maya) assert.equal(await stateOf(c.claimId), 'archived', `sibling ${c.statement} still current`);
    for (const f of LTM.getFacts(OWNER, { includeArchived: true })) assert.doesNotMatch(String(f.value), /maya/i, `legacy ${f.key} kept Maya`);
    assert.equal(LTM.getFact(OWNER, 'cofounder'), null, 'the role slot survived with a wrong value');
    const after = await promptFor('Who is my co-founder?');
    assert.doesNotMatch(after, /Maya/);
    assert.doesNotMatch(after, /co-?founder[^\n]{0,40}\bAnd\b/i, 'the garbage slot value answered');

    LTM.storeFact(OWNER, { key: 'cofounder', value: 'Maya', normalizedValue: 'maya', confidence: 0.9, importance: 8, ts: Date.now() });
    assert.doesNotMatch(await promptFor('Who is my co-founder?'), /Maya/, 'a re-derived legacy copy brought the deleted person back');
    LTM.storeFact(OWNER, { key: 'cofounder', value: 'Priya', normalizedValue: 'priya', confidence: 0.9, importance: 8, ts: Date.now() });
    assert.doesNotMatch(await promptFor('Who is my co-founder?'), /Priya/, 'a re-derived value in the deleted role slot answered');
  });
});
