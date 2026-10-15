/**
 * D6 — revisions that do not name the old value, and the reference context
 * (live Postgres). Only the extraction and embedding MODELS are stood in.
 *
 *   · "The backend is Rust now" after "the backend is written in Go": the
 *     backend held ONE `uses` value, so the revision retires it (S8 sole-value
 *     rule → contradiction job → policy rule 2), history and evidence kept.
 *   · the same revision when the subject holds TWO values (Go and Postgres):
 *     nothing is retired — the World Model never invents what was replaced.
 *   · extractionContext: earlier turns of THIS conversation only, this owner
 *     only; the current turn and later turns are not context.
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
__setEmbedderForTests(async texts => texts.map(t => {
  const v = new Array(768).fill(0);
  for (const w of String(t).toLowerCase().match(/[a-z0-9]+/g) ?? []) v[crypto.createHash('md5').update(w).digest().readUInt32BE(0) % 768] += 1;
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}));

const Brain = await import('../index.js');
const { HANDLERS, dispatchReflections } = await import('../../core/jobs/workerRuntime.js');
const { complete } = await import('../../core/jobs/jobQueue.js');
const { extractionContext } = await import('../../core/worldModel/canonicalReadModel.js');
const { purgeOwnerData } = await import('../../account/accountPurge.js');

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const USERS = [];
const KINDS = ['claim.embedding.v1', 'claim.reflection.v1', 'claim.contradiction.v1'];
const claim = (subject, predicate, object, statementText, extra = {}) => ({
  subject, predicate, object, statementText, polarity: 'asserted', modality: 'fact', timePrecision: 'none', confidenceExtraction: 0.9, ...extra,
});
const SCRIPT = new Map([
  ["Tidepool's backend is written in Go", [claim("Tidepool's backend", 'uses', { entity: 'Go' }, "Tidepool's backend is written in Go")]],
  ["Tidepool's backend uses Go and Postgres", [
    claim("Tidepool's backend", 'uses', { entity: 'Go' }, "Tidepool's backend uses Go and Postgres"),
    claim("Tidepool's backend", 'uses', { entity: 'Postgres' }, "Tidepool's backend uses Go and Postgres")]],
  ['The backend is Rust now', [claim("Tidepool's backend", 'uses', { entity: 'Rust' }, 'The backend is Rust now', { revises: true })]],
]);
const callModel = async (arg = {}) => {
  const seen = JSON.stringify(arg?.user ?? arg);
  const key = [...SCRIPT.keys()].sort((a, b) => b.length - a.length).find(k => seen.includes(k));
  return { text: JSON.stringify({ claims: key ? SCRIPT.get(key) : [] }), model: 'scripted/d6' };
};
const owner = name => { const u = `d6-${name}-${RUN}`; USERS.push(u); return `user:${u}`; };
const say = (ownerId, conversationId, turn, text) => Brain.understandTurn({ ownerId, conversationId, turn, userMessage: `${text}.`, callModel });
async function drain(ownerId) {
  const p = await getPool();
  for (let i = 0; i < 120; i++) {
    await dispatchReflections({ limit: 200 });
    const { rows } = await p.query(
      `UPDATE aqua_jobs SET state='running', attempts=attempts+1, claimed_by='d6-live', updated_at=now()
        WHERE owner_id=$1 AND state='queued' AND kind = ANY($2) RETURNING job_id, kind, owner_id, payload, attempts`, [ownerId, KINDS]);
    if (!rows.length) {
      const { rows: [{ n }] } = await p.query(
        `SELECT (SELECT count(*) FROM aqua_outbox WHERE owner_id=$1 AND state IN ('pending','processing'))
              + (SELECT count(*) FROM aqua_jobs WHERE owner_id=$1 AND state IN ('queued','running') AND kind = ANY($2)) AS n`, [ownerId, KINDS]);
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
const uses = async ownerId => (await (await getPool()).query(
  `SELECT e.canonical_label AS object, c.state,
          (SELECT count(*)::int FROM aqua_claim_evidence ce WHERE ce.owner_id=c.owner_id AND ce.claim_id=c.claim_id) AS evidence
     FROM aqua_claims c JOIN aqua_entities e ON e.owner_id=c.owner_id AND e.entity_id=c.object_entity_id
    WHERE c.owner_id=$1 AND c.predicate='uses' ORDER BY e.canonical_label`, [ownerId])).rows;

describe('D6 — revisions without the old value, and reference context', { skip }, () => {
  after(async () => {
    __clearEmbedderForTests();
    if (!LIVE) return;
    for (const u of USERS) await purgeOwnerData({ userId: u });
    await closePool();
  });

  test('one prior value: "the backend is Rust now" retires Go, keeps its history', async () => {
    const o = owner('sole');
    await say(o, 'c1', 1, "Tidepool's backend is written in Go"); await drain(o);
    await say(o, 'c2', 1, 'The backend is Rust now'); await drain(o);
    const rows = await uses(o);
    assert.deepEqual(rows.map(r => [r.object, r.state]), [['Go', 'superseded'], ['Rust', 'active']]);
    assert.ok(rows.find(r => r.object === 'Go').evidence >= 1, 'the retired value keeps its evidence');
  });

  test('two prior values: the same revision retires NOTHING (no invented replacement)', async () => {
    const o = owner('ambiguous');
    await say(o, 'c1', 1, "Tidepool's backend uses Go and Postgres"); await drain(o);
    await say(o, 'c2', 1, 'The backend is Rust now'); await drain(o);
    assert.deepEqual((await uses(o)).map(r => [r.object, r.state]), [['Go', 'active'], ['Postgres', 'active'], ['Rust', 'active']]);
  });

  test('extractionContext: earlier turns of this conversation, this owner only', async () => {
    const o = owner('ctx'); const other = owner('ctx-other');
    await say(o, 'conv-x', 1, "Tidepool's backend is written in Go"); await drain(o);
    await say(o, 'conv-y', 1, "Tidepool's backend uses Go and Postgres"); await drain(o);
    await say(other, 'conv-x', 1, "Tidepool's backend uses Go and Postgres"); await drain(other);

    const atTurn2 = await extractionContext(o, { conversationId: 'conv-x', turn: 2 });
    assert.deepEqual(atTurn2.conversation, ["Tidepool's backend | uses | Go"], 'only conv-x, only this owner');
    const atTurn1 = await extractionContext(o, { conversationId: 'conv-x', turn: 1 });
    assert.deepEqual(atTurn1.conversation, [], 'the current turn is not its own context');
    assert.ok(atTurn2.facts.includes("Tidepool's backend | uses | Postgres"), 'current facts include other conversations');
    assert.ok((await extractionContext(owner('empty'), { conversationId: 'conv-x', turn: 9 })).facts.length === 0, 'another owner sees nothing');
  });
});
