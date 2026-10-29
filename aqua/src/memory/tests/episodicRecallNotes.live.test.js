/**
 * Episodic recall × World Model (live Postgres, 2026-10-20).
 *
 * The case only the World Model can fix: the user's OLD sentence matches the
 * question word for word, and the sentence that changed it shares no word with
 * it ("We pushed it to May 2."). Lexical recall alone quotes the stale value
 * with nothing beside it. The World Model superseded the claim, so the quote
 * must carry the current statement — in the system prompt the model receives.
 *
 * Production path throughout: prepareTurn (what /chat builds), the real
 * understanding pipeline with a scripted extraction model, the real worker
 * handlers, the real conversation store. A user deletion of the successor
 * turns the note off (that value was forgotten, not changed).
 * Skips visibly without AQUA_TEST_DATABASE_URL.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.AQUA_E6 = 'on';
process.env.AQUA_CONTEXT_V2 = 'on';
process.env.AQUA_RETRIEVAL_V3 = 'on';
process.env.AQUA_SELF_ENTITY = 'on';
delete process.env.AQUA_EPISODIC_RECALL;
delete process.env.AQUA_CANONICAL_READ;
// Ranked recall: the point is the case lexical selection misses (the whole-history
// mode would quote the change itself — asserted separately below).
process.env.AQUA_RECALL_ALL_CHARS = '0';

const { isConfigured, getPool, closePool } = await import('../../core/db/pool.js');
const LIVE = isConfigured();
const skip = LIVE ? false : 'needs a live migrated Postgres — set AQUA_TEST_DATABASE_URL';

const { __setEmbedderForTests, __clearEmbedderForTests } = await import('../../embeddings/embeddingProvider.js');
const DIM = 768;
__setEmbedderForTests(async texts => texts.map(t => {
  const v = new Array(DIM).fill(0);
  for (const w of String(t).toLowerCase().match(/[a-z0-9]+/g) ?? []) v[crypto.createHash('md5').update(w).digest().readUInt32BE(0) % DIM] += 1;
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}));

const Brain = await import('../../brain/index.js');
const { prepareTurn } = await import('../../routes/chat.js');
const { createContext } = await import('../../core/observability.js');
const { HANDLERS, dispatchReflections } = await import('../../core/jobs/workerRuntime.js');
const { complete } = await import('../../core/jobs/jobQueue.js');
const { purgeOwnerData } = await import('../../account/accountPurge.js');
const store = await import('../conversationStore.js');
const { forgetClaim } = await import('../forget.js');

const USER = `recall-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const OWNER = `user:${USER}`;
const KINDS = ['claim.embedding.v1', 'claim.reflection.v1', 'claim.contradiction.v1'];

const OLD = 'The Orchid launch is on March 15';
const CHANGE = 'We pushed it to May 2';
const claim = (subject, predicate, object, statementText, extra = {}) => ({
  subject, predicate, object, statementText, polarity: 'asserted', modality: 'fact', timePrecision: 'none', confidenceExtraction: 0.9, ...extra,
});
const SCRIPT = new Map([
  [OLD, [claim('Orchid launch', 'deadline_for', { literal: 'March 15' }, OLD)]],
  [CHANGE, [claim('Orchid launch', 'deadline_for', { literal: 'May 2' }, CHANGE, { revises: true }),
    claim('Orchid launch', 'deadline_for', { literal: 'March 15' }, CHANGE, { revises: true, polarity: 'negated' })]],
]);
const callModel = async (arg = {}) => {
  const seen = JSON.stringify(arg);
  const key = [...SCRIPT.keys()].sort((a, b) => b.length - a.length).find(k => seen.includes(k));
  return { text: JSON.stringify({ claims: key ? SCRIPT.get(key) : [] }), model: 'scripted/recall-notes' };
};

let turn = 0;
/** A user turn as production records it: the conversation store, then the worker's understanding. */
async function say(text, conv) {
  store.getOrCreateConversation(conv, { userId: USER });
  store.addMessage(conv, 'user', `${text}.`);
  store.addMessage(conv, 'assistant', 'Noted.');
  await Brain.understandTurn({ ownerId: OWNER, conversationId: conv, turn: ++turn, userMessage: `${text}.`, callModel });
}
async function ask(question) {
  const conv = `ask-${crypto.randomUUID()}`;
  store.getOrCreateConversation(conv, { userId: USER });
  const requestId = crypto.randomUUID();
  return prepareTurn({ userMessage: question, conversationId: conv, userId: USER, ctx: createContext({ conversationId: conv, requestId }), requestId, skipReasoningPass: true });
}
async function drain() {
  const p = await getPool();
  for (let i = 0; i < 120; i++) {
    await dispatchReflections({ limit: 200 });
    const { rows } = await p.query(
      `UPDATE aqua_jobs SET state='running', attempts=attempts+1, claimed_by='recall-notes', updated_at=now()
        WHERE owner_id=$1 AND state='queued' AND kind = ANY($2) RETURNING job_id, kind, owner_id, payload, attempts`, [OWNER, KINDS]);
    if (!rows.length) {
      const { rows: [{ n }] } = await p.query(
        `SELECT (SELECT count(*) FROM aqua_outbox WHERE owner_id=$1 AND state IN ('pending','processing'))
              + (SELECT count(*) FROM aqua_jobs WHERE owner_id=$1 AND state IN ('queued','running') AND kind = ANY($2)) AS n`, [OWNER, KINDS]);
      if (!Number(n)) return;
      await new Promise(r => setTimeout(r, 100));
      continue;
    }
    rows.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
    for (const r of rows) {
      await HANDLERS[r.kind]({ jobId: r.job_id, kind: r.kind, ownerId: r.owner_id, payload: r.payload, attempts: r.attempts });
      await complete(r.job_id);
    }
  }
  throw new Error('drain did not settle');
}

describe('episodic recall carries the World Model\'s "since changed" note', { skip }, () => {
  after(async () => {
    __clearEmbedderForTests();
    if (!LIVE) return;
    await purgeOwnerData({ userId: USER });
    await closePool();
  });

  test('seed: the old value in one conversation, a wordless change in another', async () => {
    await say(OLD, 'c-old');
    await drain();
    await say(CHANGE, 'c-change');
    await drain();
    const { rows } = await (await getPool()).query(
      `SELECT state FROM aqua_claims WHERE owner_id=$1 AND statement_text=$2`, [OWNER, OLD]);
    assert.deepEqual(rows.map(r => r.state), ['superseded'], 'precondition: the World Model retired the old date');
  });

  test('the quoted old sentence carries the current statement, in the prompt the model receives', async () => {
    const prep = await ask('When is the Orchid launch?');
    assert.match(prep.systemPrompt, /The Orchid launch is on March 15\./, 'positive control: recall quoted the matching old sentence');
    const quoted = prep.recall.excerpts.find(e => /March 15/.test(e.text));
    assert.ok(quoted, 'excerpt present');
    assert.ok(!prep.recall.excerpts.some(e => /pushed it/.test(e.text)), 'precondition: lexical recall alone does not find the change');
    assert.deepEqual(quoted.changes, [CHANGE], `the note came from the World Model: ${JSON.stringify(prep.recall.excerpts)}`);
    assert.match(prep.systemPrompt, /since changed — now: "We pushed it to May 2"/);
  });

  test('whole-history mode (short history): the change itself is quoted, after the old value', async () => {
    process.env.AQUA_RECALL_ALL_CHARS = '8000';
    try {
      const prep = await ask('When is the Orchid launch?');
      const texts = prep.recall.excerpts.map(e => e.text);
      assert.equal(prep.recall.stats.mode, 'all');
      const i = texts.findIndex(t => /March 15/.test(t)), j = texts.findIndex(t => /pushed it to May 2/.test(t));
      assert.ok(i >= 0 && j > i, JSON.stringify(texts));
    } finally { process.env.AQUA_RECALL_ALL_CHARS = '0'; }
  });

  test('a user deletion of the current value removes the note and the quote of that value', async () => {
    const { rows: [now] } = await (await getPool()).query(
      `SELECT claim_id::text AS id FROM aqua_claims WHERE owner_id=$1 AND statement_text=$2 AND polarity='asserted' AND state IN ('active','trusted')`, [OWNER, CHANGE]);
    assert.ok(now, 'the successor claim exists');
    await forgetClaim(OWNER, now.id);
    const prep = await ask('When is the Orchid launch?');
    assert.doesNotMatch(prep.systemPrompt, /May 2/, 'a forgotten value must not come back as a note or a quote');
  });

  test('isolation: another user asking the same question gets no excerpt', async () => {
    const conv = `ask-other-${crypto.randomUUID()}`;
    const other = `${USER}-other`;
    store.getOrCreateConversation(conv, { userId: other });
    const requestId = crypto.randomUUID();
    const prep = await prepareTurn({ userMessage: 'When is the Orchid launch?', conversationId: conv, userId: other,
      ctx: createContext({ conversationId: conv, requestId }), requestId, skipReasoningPass: true });
    assert.equal(prep.recall.excerpts.length, 0);
    assert.doesNotMatch(prep.systemPrompt, /Orchid/);
  });
});
