/**
 * D5 + D6B — canonical World Model > stale legacy memory, in the PRODUCTION
 * prompt (live Postgres).
 *
 * Live validation 2026-10-05: after "I moved to Porto" the World Model held
 * Porto as current, but /chat also injected the legacy regex memory
 * (`city=Lisbon`) and the model answered "Lisbon" (7/7 stale answers equalled
 * the legacy value). This drives the real `prepareTurn` — the function /chat
 * and /chat/stream build their prompt with — so the legacy observe path writes
 * exactly what production writes.
 *
 * Per fact: say the old value → change it (rule-11 shaped extraction: new
 * value asserted + old value negated, both `revises`) → drain the production
 * handlers → ask in a NEW conversation. Asserted:
 *   · World Model: old claim superseded (by the change), new claim current,
 *     lifecycle row written, the old claim keeps its evidence (L4/L5)
 *   · AQUA_CANONICAL_READ=on: the persistent context carries the new value and
 *     neither the old statement nor any legacy lane
 *   · control, flag off: the stale legacy value IS injected — the defect, so
 *     this test can tell the two apart (and =off stays a working rollback)
 *
 * Only the extraction and embedding MODELS are stood in; natural-language
 * extraction is proven against a real provider by scripts/d6-extraction-check.mjs.
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
const { prepareTurn } = await import('../../routes/chat.js');
const { createContext } = await import('../../core/observability.js');
const { HANDLERS, dispatchReflections } = await import('../../core/jobs/workerRuntime.js');
const { complete } = await import('../../core/jobs/jobQueue.js');
const { purgeOwnerData } = await import('../../account/accountPurge.js');

const USER = `flip-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const OWNER = `user:${USER}`;
const KINDS = ['claim.embedding.v1', 'claim.reflection.v1', 'claim.contradiction.v1'];

const claim = (subject, predicate, object, statementText, extra = {}) => ({
  subject, predicate, object, statementText, polarity: 'asserted', modality: 'fact', timePrecision: 'none', confidenceExtraction: 0.9, ...extra,
});
const rev = { revises: true };
const neg = { revises: true, polarity: 'negated' };

/** old statement → change → question, with the claims a rule-11 extractor yields. */
const FACTS = [
  { name: 'city',
    old: ['I live in Lisbon', [claim('I', 'located_in', { entity: 'Lisbon' }, 'I live in Lisbon')]],
    change: ['I moved from Lisbon to Porto', [
      claim('I', 'located_in', { entity: 'Porto' }, 'I moved from Lisbon to Porto', rev),
      claim('I', 'located_in', { entity: 'Lisbon' }, 'I moved from Lisbon to Porto', neg)]],
    ask: 'Which city do I live in?', now: 'Porto', legacyStale: /Lisbon/ },
  { name: 'employer',
    old: ['I work at Acme Robotics', [claim('I', 'works_at', { entity: 'Acme Robotics' }, 'I work at Acme Robotics')]],
    change: ['I no longer work at Acme Robotics, I work at Globex now', [
      claim('I', 'works_at', { entity: 'Globex' }, 'I work at Globex now', rev),
      claim('I', 'works_at', { entity: 'Acme Robotics' }, 'I no longer work at Acme Robotics', neg)]],
    ask: 'Where do I work?', now: 'Globex' },  // the legacy regex catches "I work at X now" — not stale there
  { name: 'project state',
    old: ['Tidepool is in private beta', [claim('Tidepool', 'has_status', { literal: 'in private beta' }, 'Tidepool is in private beta')]],
    change: ['Tidepool is now in public launch', [
      claim('Tidepool', 'has_status', { literal: 'in public launch' }, 'Tidepool is now in public launch', rev)]],
    ask: 'What is the status of Tidepool?', now: 'public launch' },
  { name: 'technology',
    old: ["Tidepool's backend is written in Go", [claim('Tidepool', 'uses', { entity: 'Go' }, "Tidepool's backend is written in Go")]],
    change: ["Not Go, Tidepool's backend is written in Rust", [
      claim('Tidepool', 'uses', { entity: 'Rust' }, "Tidepool's backend is written in Rust", rev),
      claim('Tidepool', 'uses', { entity: 'Go' }, "Not Go, Tidepool's backend is written in Rust", neg)]],
    ask: "What language is Tidepool's backend written in?", now: 'Rust' },
  { name: 'launch date',
    old: ['The Tidepool launch is on March 15', [claim('Tidepool launch', 'deadline_for', { literal: 'March 15' }, 'The Tidepool launch is on March 15')]],
    change: ['The Tidepool launch moved from March 15 to May 2', [
      claim('Tidepool launch', 'deadline_for', { literal: 'May 2' }, 'The Tidepool launch moved from March 15 to May 2', rev),
      claim('Tidepool launch', 'deadline_for', { literal: 'March 15' }, 'The Tidepool launch moved from March 15 to May 2', neg)]],
    ask: 'When is the Tidepool launch?', now: 'May 2' },
];
const SCRIPT = new Map(FACTS.flatMap(f => [f.old, f.change]));
const callModel = async (arg = {}) => {
  const seen = JSON.stringify(arg);
  const key = [...SCRIPT.keys()].sort((a, b) => b.length - a.length).find(k => seen.includes(k));
  return { text: JSON.stringify({ claims: key ? SCRIPT.get(key) : [] }), model: 'scripted/read-flip' };
};

let turn = 0;
/** One user turn the way production handles it: /chat's prepareTurn (legacy observe), then the worker's E6. */
async function say(text, conv) {
  const requestId = crypto.randomUUID();
  await prepareTurn({ userMessage: `${text}.`, conversationId: conv, userId: USER, ctx: createContext({ conversationId: conv, requestId }), requestId, skipReasoningPass: true });
  await Brain.understandTurn({ ownerId: OWNER, conversationId: conv, turn: ++turn, userMessage: `${text}.`, callModel });
}
/** mode: true → 'on' (canonical only), false → 'off' (legacy rollback), 'auto' → the default (authoritative). */
async function ask(question, flag) {
  const before = process.env.AQUA_CANONICAL_READ;
  if (flag === 'auto') delete process.env.AQUA_CANONICAL_READ; else process.env.AQUA_CANONICAL_READ = flag ? 'on' : 'off';
  try {
    const conv = `ask-${crypto.randomUUID()}`;
    const requestId = crypto.randomUUID();
    const prep = await prepareTurn({ userMessage: question, conversationId: conv, userId: USER, ctx: createContext({ conversationId: conv, requestId }), requestId, skipReasoningPass: true });
    return { persistent: `${prep.memoryBlock}\n${prep.knowledgeContext}`, prep };
  } finally {
    if (before === undefined) delete process.env.AQUA_CANONICAL_READ; else process.env.AQUA_CANONICAL_READ = before;
  }
}
async function drain() {
  const p = await getPool();
  for (let i = 0; i < 120; i++) {
    await dispatchReflections({ limit: 200 });
    const { rows } = await p.query(
      `UPDATE aqua_jobs SET state='running', attempts=attempts+1, claimed_by='read-flip', updated_at=now()
        WHERE owner_id=$1 AND state='queued' AND kind = ANY($2) RETURNING job_id, kind, owner_id, payload, attempts`, [OWNER, KINDS]);
    if (!rows.length) {
      const { rows: [{ n }] } = await p.query(
        `SELECT (SELECT count(*) FROM aqua_outbox WHERE owner_id=$1 AND state IN ('pending','processing'))
              + (SELECT count(*) FROM aqua_jobs WHERE owner_id=$1 AND state IN ('queued','running') AND kind = ANY($2)) AS n`, [OWNER, KINDS]);
      if (!Number(n)) return;
      await new Promise(r => setTimeout(r, 100));
      continue;
    }
    // Contradictions after reflection/embedding, as the worker's priorities order them.
    rows.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
    for (const r of rows) {
      await HANDLERS[r.kind]({ jobId: r.job_id, kind: r.kind, ownerId: r.owner_id, payload: r.payload, attempts: r.attempts });
      await complete(r.job_id);
    }
  }
  throw new Error('drain did not settle');
}
const rowsFor = async text => (await (await getPool()).query(
  `SELECT c.claim_id, c.state, c.polarity, c.superseded_by,
          (SELECT count(*)::int FROM aqua_claim_evidence ce WHERE ce.owner_id=c.owner_id AND ce.claim_id=c.claim_id) AS evidence,
          (SELECT count(*)::int FROM aqua_lifecycle_transitions t WHERE t.owner_id=c.owner_id AND t.target_id=c.claim_id AND t.to_state='superseded') AS retired
     FROM aqua_claims c WHERE c.owner_id=$1 AND c.statement_text=$2 ORDER BY c.created_at`, [OWNER, text])).rows;

describe('D5/D6B — the canonical World Model controls the production context', { skip }, () => {
  after(async () => {
    __clearEmbedderForTests();
    if (!LIVE) return;
    await purgeOwnerData({ userId: USER });
    await closePool();
  });

  test('seed the old values and change them, the way production does', async () => {
    for (const [i, f] of FACTS.entries()) await say(f.old[0], `c-old-${i}`);
    await drain();
    for (const [i, f] of FACTS.entries()) await say(f.change[0], `c-change-${i}`);
    await drain();
  });

  for (const f of FACTS) {
    test(`${f.name}: the World Model retires the old value and keeps its history`, async () => {
      const [old] = await rowsFor(f.old[1][0].statementText);
      assert.ok(old, `the old ${f.name} claim was never written`);
      assert.equal(old.state, 'superseded', `old ${f.name} is ${old.state}, not superseded`);
      assert.ok(old.superseded_by, 'superseded_by names the successor');
      assert.ok(old.retired >= 1, 'the retirement is an audited lifecycle transition');
      assert.ok(old.evidence >= 1, 'the old claim keeps its evidence');
      const [now] = await rowsFor(f.change[1][0].statementText);
      assert.ok(now && ['active', 'trusted'].includes(now.state), `new ${f.name} is ${now?.state}`);
    });

    test(`${f.name}: with AQUA_CANONICAL_READ=on the production context says "${f.now}", never the old statement`, async () => {
      const { persistent, prep } = await ask(f.ask, true);
      assert.ok(persistent.includes(f.now), `the context lacks the current ${f.name}:\n${persistent}`);
      assert.ok(!persistent.includes(f.old[1][0].statementText), `the superseded statement is still offered:\n${persistent}`);
      assert.equal(prep.relevantFacts.length, 0, 'no legacy regex fact may reach the prompt');
      assert.ok(prep.systemPrompt.includes(f.now), 'the current value is in the system prompt the model receives');
    });
  }

  test('DEFAULT (auto = canonical-authoritative): the stale legacy value is VETOED, the current value answers', async () => {
    for (const f of FACTS) {
      const { persistent, prep } = await ask(f.ask, 'auto');
      assert.ok(persistent.includes(f.now), `${f.name}: the context lacks the current value:
${persistent}`);
      if (f.legacyStale) assert.doesNotMatch(prep.memoryBlock, f.legacyStale, `${f.name}: a contradicted legacy value reached the prompt`);
    }
  });

  test('DEFAULT: a legacy-only fact the World Model never learned still fills the gap (nothing lost at cutover)', async () => {
    await say('My name is Maya Rodrigues', 'c-name');
    const { prep } = await ask('What is my name?', 'auto');
    assert.match(prep.memoryBlock, /Maya/, 'the uncontradicted legacy identity fact was dropped');
    const { prep: off } = await ask('What is my name?', true);
    assert.doesNotMatch(off.memoryBlock, /Maya/, 'AQUA_CANONICAL_READ=on must carry no legacy user memory');
  });

  test('control: with the flag OFF the legacy store still injects the stale values (the defect, and the rollback)', async () => {
    for (const f of FACTS.filter(x => x.legacyStale)) {
      const { prep } = await ask(f.ask, false);
      assert.match(prep.memoryBlock, f.legacyStale, `${f.name}: the legacy store no longer holds the stale value — this control is void`);
    }
  });

  test('isolation: another owner asking the same questions sees none of it', async () => {
    const other = `user:${USER}-other`;
    const res = await Brain.assembleContextAsync(other, 'Which city do I live in?', () => ({ items: [], block: '', stats: {} }),
      { limit: 8, canonicalOnly: true, semanticScores: await Brain.canonicalSemanticScores(other, 'Which city do I live in?') });
    assert.doesNotMatch(res.block ?? '', /Porto|Lisbon|Globex|Tidepool/);
  });
});
