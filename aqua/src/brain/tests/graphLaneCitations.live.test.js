/**
 * The canonical graph lane, called the way chat.js calls it (live Postgres).
 *
 * chat.js passes `formatCitation` (files/evidence.js) into the Context Engine.
 * The canonical graph lane mapped canonical evidence rows ({ quote, locator,
 * … }) through it; it reads `.location`, threw on the first claim, and the
 * lane's catch returned [] — on 40 of 53 live turns of a real start:production
 * run (2026-10-05). Every live suite called assembleContextAsync WITHOUT
 * formatCitation, so the lane looked healthy in tests and was dead in prod.
 *
 * Only the extraction and embedding MODELS are stood in.
 * Skips visibly without AQUA_TEST_DATABASE_URL.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.AQUA_E6 = 'on';
process.env.AQUA_CONTEXT_V2 = 'on';
process.env.AQUA_RETRIEVAL_V3 = 'on';
process.env.AQUA_SELF_ENTITY = 'on';

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

const Brain = await import('../index.js');
const { HANDLERS, dispatchReflections } = await import('../../core/jobs/workerRuntime.js');
const { complete } = await import('../../core/jobs/jobQueue.js');
const { formatCitation } = await import('../../files/evidence.js');
const { purgeOwnerData } = await import('../../account/accountPurge.js');

const USER = `graph-cite-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const OWNER = `user:${USER}`;
const KINDS = ['claim.embedding.v1', 'claim.reflection.v1', 'claim.contradiction.v1'];
const claim = (subject, predicate, object, statementText) => ({
  subject, predicate, object, statementText, polarity: 'asserted', modality: 'fact', timePrecision: 'none', confidenceExtraction: 0.9,
});
const SCRIPT = new Map([
  ['Priya leads the billing service', [claim('Priya', 'owns', { entity: 'billing service' }, 'Priya leads the billing service')]],
  ['The billing service runs on Kafka', [claim('billing service', 'uses', { entity: 'Kafka' }, 'The billing service runs on Kafka')]],
]);
const callModel = async (arg = {}) => {
  const seen = JSON.stringify(arg);
  const key = [...SCRIPT.keys()].find(k => seen.includes(k));
  return { text: JSON.stringify({ claims: key ? SCRIPT.get(key) : [] }), model: 'scripted/graph-cite' };
};
let turn = 0;
const say = s => Brain.understandTurn({ ownerId: OWNER, conversationId: `c-${OWNER}`, turn: ++turn, userMessage: `${s}.`, callModel });

async function drain() {
  const p = await getPool();
  for (let i = 0; i < 80; i++) {
    await dispatchReflections({ limit: 200 });
    const { rows } = await p.query(
      `UPDATE aqua_jobs SET state='running', attempts=attempts+1, claimed_by='graph-cite', updated_at=now()
        WHERE owner_id=$1 AND state='queued' AND kind = ANY($2) RETURNING job_id, kind, owner_id, payload, attempts`, [OWNER, KINDS]);
    if (!rows.length) {
      const { rows: [{ n }] } = await p.query(
        `SELECT (SELECT count(*) FROM aqua_outbox WHERE owner_id=$1 AND state IN ('pending','processing'))
              + (SELECT count(*) FROM aqua_jobs WHERE owner_id=$1 AND state IN ('queued','running') AND kind = ANY($2)) AS n`, [OWNER, KINDS]);
      if (!Number(n)) return;
      await new Promise(r => setTimeout(r, 100));
      continue;
    }
    for (const r of rows) {
      await HANDLERS[r.kind]({ jobId: r.job_id, kind: r.kind, ownerId: r.owner_id, payload: r.payload, attempts: r.attempts });
      await complete(r.job_id);
    }
  }
  throw new Error('drain did not settle');
}

describe('canonical graph lane with the production citation formatter', { skip }, () => {
  after(async () => {
    __clearEmbedderForTests();
    if (!LIVE) return;
    await purgeOwnerData({ userId: USER });
    await closePool();
  });

  test('the lane contributes claims instead of throwing on canonical evidence', async () => {
    await say('Priya leads the billing service');
    await say('The billing service runs on Kafka');
    await drain();

    const warnings = [];
    const warn = console.warn;
    console.warn = (...a) => { warnings.push(a.join(' ')); warn(...a); };
    let res;
    try {
      // Exactly as chat.js: canonical dense scores (the lane's anchors) + formatCitation.
      const query = 'What does Priya work on?';
      res = await Brain.assembleContextAsync(OWNER, query, () => ({ items: [], block: '', stats: {} }),
        { limit: 8, taskType: 'simple_qa', formatCitation, semanticScores: await Brain.canonicalSemanticScores(OWNER, query) });
    } finally { console.warn = warn; }

    assert.deepEqual(warnings.filter(w => /canonical graph lane failed/.test(w)), [],
      'the graph lane threw — canonical evidence went through the file-citation formatter');
    assert.ok((res.items ?? []).length > 0, 'the context came back empty');
    assert.doesNotMatch(res.block ?? '', /\[object Object\]|undefined/);
  });
});
