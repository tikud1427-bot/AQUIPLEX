/**
 * THE 2026-10-11 LOOPS on a REAL Postgres — the production path end to end:
 *
 *   role relations (prompt rule 13) → S8 role handover → contradiction job →
 *   the old holder retired · role reference in a question ("my mentor") →
 *   the holder's facts retrieved · uploaded document → fileEngine.ingestFiles →
 *   durable understanding.document.v1 jobs → the worker's own handler →
 *   canonical claims with DOCUMENT provenance · the CURRENT WORLD section of
 *   the answer context (worldCore): current facts the relevance section did
 *   not show, superseded and closed-past ones left out, file provenance shown ·
 *   owner isolation · purge.
 *
 * Stand-ins: the extraction MODEL (scripted per sentence, via callModel for
 * turns and __setE6TransportForTests for the document job) and the embedding
 * MODEL. Queue, handlers, S6–S9, policy, SQL and Context Engine are production.
 * Skips visibly without AQUA_TEST_DATABASE_URL.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.AQUA_E6 = 'on';
process.env.AQUA_CONTEXT_V2 = 'on';
process.env.AQUA_RETRIEVAL_V3 = 'on';
process.env.AQUA_SELF_ENTITY = 'on';
delete process.env.AQUA_WORLD_CORE;

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
const { ingestFiles } = await import('../../files/fileEngine.js');
const { DOCUMENT_JOB_KIND } = await import('../../files/documentUnderstanding.js');
const { purgeOwnerData } = await import('../../account/accountPurge.js');

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const USER = `wc-a-${run}`;
const OWNER = `user:${USER}`;
const OTHER = `user:wc-b-${run}`;
const KINDS = [DOCUMENT_JOB_KIND, 'claim.embedding.v1', 'claim.reflection.v1', 'claim.contradiction.v1'];

const claim = (subject, predicate, object, statementText, extra = {}) => ({
  subject, predicate, object, statementText,
  polarity: 'asserted', modality: 'fact', timePrecision: 'none', confidenceExtraction: 0.9, ...extra,
});
const SCRIPT = new Map([
  ["I'm based in Osaka", [claim('self', 'located_in', { entity: 'Osaka' }, "I'm based in Osaka")]],
  ['My biggest client is a studio called Kumo Games', [
    claim('Kumo Games', 'related_to', { literal: 'biggest client' }, 'My biggest client is a studio called Kumo Games'),
    // The sibling claim that stays CURRENT after the role moves — the shape the
    // live product run exposed (2026-10-11): quoting the sentence re-asserted the role.
    claim('Kumo Games', 'is_a', { literal: 'studio' }, 'My biggest client is a studio called Kumo Games'),
  ]],
  ['My mentor is Sam Patel', [claim('Sam Patel', 'related_to', { literal: 'mentor' }, 'My mentor is Sam Patel')]],
  ['Sam Patel works at Sky', [claim('Sam Patel', 'works_at', { entity: 'Sky' }, 'Sam Patel works at Sky')]],
  ['Sam Patel moved from Sky to the BBC', [
    claim('Sam Patel', 'works_at', { entity: 'BBC' }, 'Sam Patel moved from Sky to the BBC', { revises: true }),
    claim('Sam Patel', 'works_at', { entity: 'Sky' }, 'Sam Patel moved from Sky to the BBC', { polarity: 'negated', revises: true }),
  ]],
  ['My biggest client is now Sora Studio', [claim('Sora Studio', 'related_to', { literal: 'biggest client' }, 'My biggest client is now Sora Studio', { revises: true })]],
  ['I lived in Kyoto until 2023', [claim('self', 'located_in', { entity: 'Kyoto' }, 'I lived in Kyoto until 2023', { validTo: '2023', timePrecision: 'year' })]],
  ['I prefer short bullet answers', [claim('self', 'prefers', { literal: 'short bullet answers' }, 'I prefer short bullet answers')]],
  ['Monthly rent: $6,400', [claim('Monthly rent', 'has_property', { literal: '$6,400, fixed for 3 years' }, 'Monthly rent: $6,400, fixed for 3 years')]],
]);
const callModel = async (arg = {}) => {
  const seen = JSON.stringify(arg.user ?? arg);
  const key = [...SCRIPT.keys()].sort((a, b) => b.length - a.length).find(k => seen.includes(k));
  return { text: JSON.stringify({ claims: key ? SCRIPT.get(key) : [] }), model: 'scripted/world-core-loop' };
};
Brain.__setE6TransportForTests(callModel);

let turn = 0;
const say = s => Brain.understandTurn({ ownerId: OWNER, conversationId: `c-${OWNER}`, turn: ++turn, userMessage: `${s}.`, callModel });
const empty = () => ({ items: [], block: '', stats: {} });
const ask = (ownerId, q) => Brain.assembleContextAsync(ownerId, q, empty, { limit: 8, taskType: 'simple_qa', canonicalOnly: true });
const q = async (sql, args) => (await (await getPool()).query(sql, args)).rows;

async function drain(ownerId) {
  const p = await getPool();
  for (let i = 0; i < 80; i++) {
    await dispatchReflections({ limit: 200 });
    const { rows } = await p.query(
      `UPDATE aqua_jobs SET state='running', attempts=attempts+1, claimed_by='world-core-loop', updated_at=now()
        WHERE owner_id=$1 AND state='queued' AND kind = ANY($2) RETURNING job_id, kind, owner_id, payload, attempts`, [ownerId, KINDS]);
    if (!rows.length) {
      const [{ n: pending }] = await q(`SELECT count(*)::int n FROM aqua_outbox WHERE owner_id=$1 AND state IN ('pending','processing')`, [ownerId]);
      const [{ n: queued }] = await q(`SELECT count(*)::int n FROM aqua_jobs WHERE owner_id=$1 AND state IN ('queued','running') AND kind = ANY($2)`, [ownerId, KINDS]);
      if (!pending && !queued) return;
      await new Promise(r => setTimeout(r, 100));
      continue;
    }
    rows.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || (a.kind === 'claim.contradiction.v1' ? -1 : 0));
    for (const r of rows) {
      await HANDLERS[r.kind]({ jobId: r.job_id, kind: r.kind, ownerId: r.owner_id, payload: r.payload, attempts: r.attempts });
      await complete(r.job_id);
    }
  }
  throw new Error('drain did not settle');
}
const stateOf = async text => (await q(`SELECT state FROM aqua_claims WHERE owner_id=$1 AND statement_text=$2 ORDER BY asserted_at LIMIT 1`, [OWNER, text]))[0]?.state ?? null;

after(async () => {
  Brain.__setE6TransportForTests(null);
  __clearEmbedderForTests();
  if (LIVE) {
    for (const userId of [USER, OTHER.slice(5)]) { try { await purgeOwnerData({ userId }); } catch { /* best effort */ } }
    await closePool();
  }
});

describe('2026-10-11 loops — live Postgres', { skip }, () => {
  test('turns: role relations land, a role handover retires the old holder, closed-past validity is not current', async () => {
    for (const s of ["I'm based in Osaka", 'My biggest client is a studio called Kumo Games', 'My mentor is Sam Patel', 'Sam Patel works at Sky',
      'Sam Patel moved from Sky to the BBC', 'My biggest client is now Sora Studio', 'I lived in Kyoto until 2023', 'I prefer short bullet answers']) {
      const r = await say(s);
      assert.notEqual(r?.canonicalCommit?.committed, false, `${s}: commit failed — ${r?.canonicalCommit?.error}`);
    }
    await drain(OWNER);
    assert.equal((await q(`SELECT state FROM aqua_claims WHERE owner_id=$1 AND predicate='related_to' AND statement_text LIKE 'My biggest client is a studio%'`, [OWNER]))[0]?.state, 'superseded', 'role handed over to Sora Studio — Kumo must be retired');
    assert.equal(await stateOf('My biggest client is now Sora Studio'), 'active');
    assert.equal(await stateOf('Sam Patel works at Sky'), 'superseded');
    assert.notEqual(await stateOf("I'm based in Osaka"), 'superseded', 'a closed past location must not retire the current one');
  });

  test('upload: the document reaches the canonical World Model through durable jobs, with document provenance', async () => {
    const out = await ingestFiles({
      files: [{ name: 'lease_terms.txt', buffer: Buffer.from('Studio lease\nMonthly rent: $6,400, fixed for 3 years.\n', 'utf8') }],
      ownerId: OWNER, conversationId: `c-${OWNER}`, deps: { skipGraph: true },
    });
    assert.equal(out.results[0]?.status, 'ready');
    assert.ok(out.understanding?.enqueued >= 1, `no understanding job enqueued: ${JSON.stringify(out.understanding)}`);
    const jobs = await q(`SELECT count(*)::int n FROM aqua_jobs WHERE owner_id=$1 AND kind=$2`, [OWNER, DOCUMENT_JOB_KIND]);
    assert.ok(jobs[0].n >= 1);
    // Re-uploading the same file enqueues nothing new (idempotency key = content hash + chunk).
    await ingestFiles({ files: [{ name: 'lease_terms.txt', buffer: Buffer.from('Studio lease\nMonthly rent: $6,400, fixed for 3 years.\n', 'utf8') }],
      ownerId: OWNER, conversationId: `c-${OWNER}`, deps: { skipGraph: true } });
    const again = await q(`SELECT count(*)::int n FROM aqua_jobs WHERE owner_id=$1 AND kind=$2`, [OWNER, DOCUMENT_JOB_KIND]);
    assert.equal(again[0].n, jobs[0].n, 'a re-upload must not enqueue the same chunks twice');
    await drain(OWNER);
    const [row] = await q(`SELECT s.kind, s.trust_tier, s.external_ref FROM aqua_claims c
        JOIN aqua_claim_evidence ce ON ce.owner_id=c.owner_id AND ce.claim_id=c.claim_id
        JOIN aqua_evidence ev ON ev.owner_id=ce.owner_id AND ev.evidence_id=ce.evidence_id
        JOIN aqua_sources s ON s.owner_id=ev.owner_id AND s.source_id=ev.source_id
       WHERE c.owner_id=$1 AND c.statement_text LIKE 'Monthly rent%'`, [OWNER]);
    assert.ok(row, 'the document claim was not committed');
    assert.equal(row.kind, 'document');
    assert.equal(Number(row.trust_tier), 3);
    assert.match(row.external_ref, /^file:lease_terms\.txt:chunk:0$/);
  });

  test('answer context: a role reference reaches the holder; the current world shows what relevance did not', async () => {
    const mentor = await ask(OWNER, 'Where does my mentor work?');
    // The holder's facts are in the RELEVANCE section (structured lane, via the
    // role anchor) — not only in the current-world section.
    const relevance = mentor.block.split('── ALSO KNOWN ABOUT THE USER')[0];
    assert.match(relevance, /Sam Patel works at BBC/, `the mentor's current employer was not retrieved:\n${mentor.block}`);
    assert.doesNotMatch(relevance, /(?<!NOT: )Sam Patel works at Sky/, 'a superseded employer reached the answer as current');

    const client = await ask(OWNER, 'Who is my biggest client?');
    assert.match(client.block, /Sora Studio/);
    assert.doesNotMatch(client.block, /My biggest client is a studio called Kumo Games/, 'the retired role was re-asserted through its sentence');

    const plan = await ask(OWNER, 'Help me plan my week.');
    assert.match(plan.block, /ALSO KNOWN ABOUT THE USER/);
    assert.match(plan.block, /\[from uploaded file lease_terms\.txt\] "Monthly rent: \$6,400, fixed for 3 years"/);
    assert.match(plan.block, /I prefer short bullet answers/);
    assert.doesNotMatch(plan.block, /I lived in Kyoto until 2023/, 'closed-past validity is history, not the current world');
    // The still-current sibling survives as a READING; its sentence is never quoted.
    assert.doesNotMatch(plan.block, /My biggest client is a studio called Kumo Games/, 'a partly retired sentence was quoted');
    assert.match(plan.block, /Kumo Games is studio/, `the current half of the sentence was lost:\n${plan.block}`);
    assert.ok(plan.stats.worldCore.rendered >= 3, JSON.stringify(plan.stats.worldCore));
    // Rendered once: nothing in the current-world section repeats a relevance line.
    const lines = plan.block.split('\n').filter(l => l.startsWith('• '));
    const quotes = lines.map(l => l.match(/"([^"]+)"/)?.[1]).filter(Boolean);
    assert.equal(new Set(quotes).size, quotes.length, `a statement rendered twice:\n${plan.block}`);
  });

  test('rollback and isolation: AQUA_WORLD_CORE=off removes the section; another owner sees none of it', async () => {
    process.env.AQUA_WORLD_CORE = 'off';
    try {
      const off = await ask(OWNER, 'Help me plan my week.');
      assert.doesNotMatch(off.block, /ALSO KNOWN ABOUT THE USER/);
    } finally { delete process.env.AQUA_WORLD_CORE; }
    const other = await ask(OTHER, 'Help me plan my week.');
    assert.doesNotMatch(other.block, /Sora Studio|Monthly rent|Osaka/);
  });
});
