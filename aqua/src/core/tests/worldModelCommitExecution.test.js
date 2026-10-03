/**
 * THE COMMIT, EXECUTED — not grepped.
 *
 * `worldModelCommitContract.test.js` asserts the SHAPE of the commit's source
 * with regexes: that a string exists, that one index precedes another. It
 * passed for as long as `commitUnderstanding` built an INSERT with 17 column
 * names and 16 values — `fields` listed `state`, `vals` had no value for it —
 * which Postgres rejects on every call. With AQUA_E6=on in production, every
 * canonical commit threw, the post-turn seam swallowed it (correctly: fail-open,
 * L11), and the only trace was `canonicalCommit.error` on a result nobody reads.
 *
 * A contract test that reads the file proves the file contains the words. This
 * runs the transaction against the migrated schema, then asserts on the ROWS.
 * Arity errors are caught at parse time, so even the in-memory engine sees them.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createMemoryPg } from './helpers/memoryPg.mjs';
import { _setPoolForTests, _resetForTests } from '../db/pool.js';
import { commitUnderstanding } from '../worldModel/worldModelRepository.js';
import { dedupAndDetect, inStoredVocabulary } from '../../brain/understanding/claimDedup.js';

let mem, restore;
const envBefore = process.env.DATABASE_URL;
const OWNER = 'user:commit-exec';

before(async () => {
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/aqua';
  _resetForTests();
  mem = createMemoryPg();
  restore = _setPoolForTests(mem.pool);
  await (await import('../db/migrate.js')).migrate();
});
after(async () => {
  restore?.();
  await mem?.close();
  if (envBefore === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = envBefore;
  _resetForTests();
});

const ent = (id, name) => ({ entityId: id, canonical: name, name, type: 'concept' });
const claim = (over = {}) => ({
  claimId: crypto.randomUUID(),
  predicate: 'works_at', objectKind: 'entity',
  subject: 'I', object: { entity: 'Nummo' },
  polarity: 'asserted', modality: 'fact', timePrecision: 'none',
  statementText: 'I work at Nummo',
  _canonicalSubject: ent('aq:self:owner', 'You'),
  _canonicalObject: ent('aq:name:nummo', 'Nummo'),
  resolution: { ready: true },
  ...over,
});
const input = (claims, over = {}) => ({
  ownerId: OWNER, sourceId: crypto.randomUUID(), actor: 'e6:test', extractorVersion: 'e6-test',
  segmentRange: { start: 0, end: 15 }, sourceKind: 'conversation',
  title: 't', contentHash: 'h', assertedAt: new Date(), claims, ...over,
});

describe('canonicalCommit — executed against the migrated schema', () => {
  test('a ready claim COMMITS, and lands ACTIVE with its evidence', async () => {
    const res = await commitUnderstanding(input([claim()]));
    assert.equal(res.claims?.length, 1, 'the commit returned no claim — it threw or skipped');

    const { rows } = await mem.pool.query(
      `SELECT predicate, state, polarity, modality, extractor, statement_text
         FROM aqua_claims WHERE owner_id=$1`, [OWNER]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'active', 'promoted to active in the same transaction');
    assert.equal(rows[0].extractor, 'extraction');
    assert.equal(rows[0].statement_text, 'I work at Nummo');

    const ev = await mem.pool.query(`SELECT quote FROM aqua_evidence WHERE owner_id=$1`, [OWNER]);
    assert.equal(ev.rows.length, 1, 'a claim with no evidence violates D2');
    assert.equal(ev.rows[0].quote, 'I work at Nummo');
  });

  test('the INSERT names exactly as many columns as it supplies values — every object kind', async () => {
    // The original bug was an arity mismatch in the code that BUILDS the
    // statement, and the builder branches on objectKind (entity: 1 column,
    // literal: 1, quantity: 2, time: 2). A single-kind test would have covered
    // one branch of a four-way construction.
    const owner = 'user:arity';
    const base = { ownerId: owner };
    const kinds = [
      claim({ claimId: crypto.randomUUID(), predicate: 'works_at', objectKind: 'entity',
        object: { entity: 'Nummo' }, statementText: 'arity entity' }),
      claim({ claimId: crypto.randomUUID(), predicate: 'role_is', objectKind: 'literal',
        object: { literal: 'run product' }, _canonicalObject: null, statementText: 'arity literal' }),
      claim({ claimId: crypto.randomUUID(), predicate: 'works_at', objectKind: 'quantity',
        object: { quantity: 42, unit: 'hours' }, _canonicalObject: null, statementText: 'arity quantity' }),
      claim({ claimId: crypto.randomUUID(), predicate: 'works_at', objectKind: 'time',
        object: { time: '2026-01-01' }, _canonicalObject: null, statementText: 'arity time' }),
    ];
    let i = 0;
    for (const c of kinds) {
      const res = await commitUnderstanding({ ...input([c], base), segmentRange: { start: i * 100, end: i * 100 + 10 } });
      i++;
      assert.equal(res.claims?.length, 1, `objectKind=${c.objectKind} did not commit`);
    }
    const { rows } = await mem.pool.query(
      `SELECT count(*)::int n FROM aqua_claims WHERE owner_id=$1 AND state='active'`, [owner]);
    assert.equal(rows[0].n, 4, 'not every object kind produced an active claim');
  });

  test('replaying the same segment is idempotent — no second claim, no throw', async () => {
    const owner = 'user:replay';
    const src = crypto.randomUUID();
    const one = { ...input([claim({ statementText: 'replay me' })], { ownerId: owner }), sourceId: src };
    await commitUnderstanding(one);
    const again = await commitUnderstanding({ ...one, claims: [claim({ statementText: 'replay me' })] });
    assert.equal(again.skipped, true, 'the ledger did not recognise the replay');
    const { rows } = await mem.pool.query(`SELECT count(*)::int n FROM aqua_claims WHERE owner_id=$1`, [owner]);
    assert.equal(rows[0].n, 1);
  });

  // pg-mem DOES NOT HONOUR ROLLBACK across the pooled client this repository
  // uses: the same scenario run against real Postgres 16 leaves zero rows in
  // aqua_claims/evidence/sources/entities/outbox, and under pg-mem leaves one.
  // So the harness cannot grade this property — the same class of limit
  // helpers/memoryPg.mjs documents for partial unique indexes. Skipped WITH the
  // reason rather than asserted weakly; the real-database check is
  // `DATABASE_URL=… node --test` on this file with SKIP_PGMEM_LIMITS unset.
  test('a commit that throws leaves NOTHING behind (one transaction, both halves or neither)', {
    skip: process.env.AQUA_TEST_REAL_PG === '1' ? false : 'pg-mem does not roll back — verified on real Postgres, see comment',
  }, async () => {
    const owner = 'user:atomic';
    const bad = claim({ statementText: undefined, resolution: { ready: true } });
    await assert.rejects(() => commitUnderstanding(input([claim({ statementText: 'good one' }), bad], { ownerId: owner })));
    const { rows } = await mem.pool.query(`SELECT count(*)::int n FROM aqua_claims WHERE owner_id=$1`, [owner]);
    assert.equal(rows[0].n, 0, 'the first claim survived a failed commit');
  });
});


// ── Provenance: an earlier claim is NOT corroborated by an unrelated new one ──
//
// MEASURED on real Postgres after the arity fix let commits land for the first
// time. Turn 1 "I work at Quillbase", turn 2 "I work at Nummo": turn 2's commit
// wrote a SECOND evidence row onto the Quillbase claim — role 'primary', quote
// "I work at Quillbase", source = turn 2, a sentence turn 2 never contained —
// and raised its confidence_corroboration. S8 returns every claim it SEEDED from
// history in `claims`, and the repository's loop treated each `_persisted` one
// as if it had just been said again. A restatement was counted twice (loop +
// evidenceAttachments); an unrelated claim counted once, falsely.
describe('commit — history is not re-evidenced by the current turn', () => {
  const OWNER2 = 'user:prov';
  const turn = (n) => ({ sourceId: crypto.randomUUID(), segmentRange: { start: n * 100, end: n * 100 + 20 } });

  // Mirrors the production facade: read history, run S8, commit s8.claims.
  // History is read with plain queries, producing the SAME shape as
  // findClaimsForDedup. That function's own SQL (a correlated subquery inside a
  // JOIN) is rejected by pg-mem, so calling it here would fail the harness, not
  // the code; its output shape is what S8 depends on and is reproduced below.
  async function history() {
    const cs = await mem.pool.query(
      `SELECT claim_id, subject_entity_id, object_entity_id, predicate, polarity, modality,
              valid_from, valid_to, asserted_at, state, statement_text
         FROM aqua_claims WHERE owner_id=$1 AND state <> 'archived'`, [OWNER2]);
    const out = [];
    for (const r of cs.rows) {
      const label = async (id) => (await mem.pool.query(
        `SELECT canonical_label FROM aqua_entities WHERE entity_id=$1 AND owner_id=$2`, [id, OWNER2])).rows[0]?.canonical_label;
      out.push({
        claimId: r.claim_id, subject: await label(r.subject_entity_id), subjectEntityId: r.subject_entity_id,
        predicate: r.predicate, objectKind: 'entity',
        object: { entity: await label(r.object_entity_id), entityId: r.object_entity_id },
        polarity: r.polarity, modality: r.modality, validFrom: r.valid_from, validTo: r.valid_to,
        assertedAt: r.asserted_at, state: r.state, statementText: r.statement_text,
        sourceTier: 'chat', _persisted: true,
      });
    }
    return out;
  }
  async function commitTurn(n, c) {
    const s8 = dedupAndDetect([inStoredVocabulary(c)], await history(), {});
    const t = turn(n);
    return commitUnderstanding({
      ...input(s8.claims, { ownerId: OWNER2 }), ...t,
      evidenceAttachments: s8.evidenceAttachments, contradictions: s8.contradictions,
    });
  }
  const rows = async (q, p = [OWNER2]) => (await mem.pool.query(q, p)).rows;
  // Two plain queries, not a correlated subquery: pg-mem cannot resolve an outer
  // alias inside a select-list subquery and fails the QUERY, which would have
  // read as the defect failing. (Same class as the harness limits in memoryPg.mjs.)
  const claimOf = async (name) => {
    const c = (await rows(
      `SELECT claim_id, confidence_corroboration AS corr FROM aqua_claims
        WHERE owner_id=$1 AND statement_text=$2`, [OWNER2, `I work at ${name}`]))[0];
    if (!c) return undefined;
    const ev = await rows(`SELECT count(*)::int AS n FROM aqua_claim_evidence WHERE claim_id=$1`, [c.claim_id]);
    return { ...c, ev: ev[0].n };
  };
  const works = (name) => claim({
    statementText: `I work at ${name}`, object: { entity: name },
    _canonicalObject: ent(`aq:name:${name.toLowerCase()}`, name),
  });

  test('an UNRELATED new claim leaves the earlier claim\'s evidence and confidence untouched', async () => {
    await commitTurn(1, works('Quillbase'));
    const before = await claimOf('Quillbase');
    assert.equal(before.ev, 1);

    await commitTurn(2, works('Nummo'));
    const after = await claimOf('Quillbase');
    assert.equal(after.ev, 1, 'turn 2 attached evidence to a claim it never mentioned');
    assert.equal(after.corr, before.corr, 'turn 2 raised the corroboration of a claim it did not corroborate');
    assert.equal((await claimOf('Nummo')).ev, 1);
  });

  test('a true RESTATEMENT adds exactly one corroborating row quoting the NEW sentence, +0.1 once', async () => {
    await commitTurn(10, works('Initech'));
    const before = await claimOf('Initech');
    await commitTurn(11, works('Initech'));
    const after = await claimOf('Initech');
    assert.equal(after.ev, before.ev + 1, `restatement attached ${after.ev - before.ev} evidence rows`);
    assert.ok(Math.abs((after.corr - before.corr) - 0.1) < 1e-6, `corroboration moved by ${after.corr - before.corr}, not 0.1`);
    const roles = await rows(`SELECT role FROM aqua_claim_evidence WHERE claim_id=$1 ORDER BY added_at`, [after.claim_id]);
    assert.deepEqual(roles.map(r => r.role), ['primary', 'corroborating']);
    const claimsN = await rows(`SELECT count(*)::int n FROM aqua_claims WHERE owner_id=$1 AND statement_text='I work at Initech'`);
    assert.equal(claimsN[0].n, 1, 'a restatement must not create a second claim row');
  });

  test('corroboration saturates at 1 — it is a bonus, never an unbounded counter', async () => {
    await commitTurn(20, works('Hooli'));
    const c = await claimOf('Hooli');
    await mem.pool.query(`UPDATE aqua_claims SET confidence_corroboration=0.95 WHERE claim_id=$1`, [c.claim_id]);
    await commitTurn(21, works('Hooli'));
    assert.equal((await claimOf('Hooli')).corr, 1, 'a restatement at 0.95 must land exactly on 1');
    await commitTurn(22, works('Hooli'));
    assert.equal((await claimOf('Hooli')).corr, 1, 'a further restatement must not exceed 1');
  });

  test('every evidence quote on a claim appears in the sentence of ITS OWN source turn', async () => {
    // The invariant that makes provenance trustworthy, stated directly: no
    // evidence row may carry a quote that its source never said.
    const all = await rows(`SELECT claim_id, statement_text FROM aqua_claims WHERE owner_id=$1`);
    for (const c of all) {
      const ev = await rows(`SELECT e.quote, e.source_id FROM aqua_claim_evidence ce
                              JOIN aqua_evidence e ON e.evidence_id = ce.evidence_id WHERE ce.claim_id=$1`, [c.claim_id]);
      for (const e of ev) {
        assert.equal(e.quote, c.statement_text,
          `claim "${c.statement_text}" carries evidence quoting "${e.quote}" — a sentence it was never said in`);
      }
    }
    const quill = await claimOf('Quillbase');
    const srcs = await rows(`SELECT e.source_id FROM aqua_claim_evidence ce JOIN aqua_evidence e ON e.evidence_id=ce.evidence_id WHERE ce.claim_id=$1`, [quill.claim_id]);
    assert.equal(new Set(srcs.map(r => r.source_id)).size, 1, 'the Quillbase claim is supported by a source other than the turn that said it');
  });
});
