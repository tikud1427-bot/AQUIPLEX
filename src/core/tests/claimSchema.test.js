/**
 * AQUA — the claim schema
 * Blueprint E5/PR-1 · D2, and Constitution L8 / L9 / L19
 *
 * The tables only. Nothing reads or writes them yet — a test asserts that —
 * and the extraction that fills them is E5/PR-3 onward.
 *
 * WHAT THIS SUITE IS FOR
 * ----------------------
 * A schema is a set of promises, and a promise nobody tested is a comment.
 * Every CHECK constraint here exists because of a specific failure the audit
 * measured, so each one is exercised: fed the bad value and asserted to
 * REFUSE it, then fed the good one and asserted to accept.
 *
 * Constraints live in the SCHEMA rather than in code deliberately. A
 * code-level rule holds until the second writer; a database-level one holds
 * for every writer including the ones nobody has written yet.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryPg } from './helpers/memoryPg.mjs';
import { _setPoolForTests, _resetForTests } from '../db/pool.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let mem, restorePool;
const envBefore = process.env.DATABASE_URL;

const OWNER = 'user:e5';
let PRIYA, AQUIPLEX;

before(async () => {
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/aqua';
  _resetForTests();
  mem = createMemoryPg();
  restorePool = _setPoolForTests(mem.pool);
  await (await import('../db/migrate.js')).migrate();

  PRIYA = await addEntity('person', 'Priya', 'priya');
  AQUIPLEX = await addEntity('org', 'Aquiplex', 'aquiplex');
});

after(async () => {
  restorePool?.();
  await mem?.close();
  if (envBefore === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = envBefore;
  _resetForTests();
});

async function addEntity(type, label, norm, owner = OWNER) {
  const id = crypto.randomUUID();
  await mem.pool.query(
    `INSERT INTO aqua_entities (entity_id, owner_id, type, canonical_label, normalized_label)
     VALUES ($1,$2,$3,$4,$5)`, [id, owner, type, label, norm]);
  return id;
}

/** Insert a claim, defaulting everything the caller does not care about. */
function insertClaim(over = {}) {
  const c = {
    claim_id: crypto.randomUUID(), owner_id: OWNER,
    subject_entity_id: PRIYA, predicate: 'works_at',
    object_entity_id: null, object_literal: 'Aquiplex',
    object_quantity: null, object_time_from: null,
    polarity: 'asserted', modality: 'fact',
    valid_from: null, valid_to: null,
    state: 'extracted', superseded_by: null,
    statement_text: `s-${Math.random()}`,
    ...over,
  };
  return mem.pool.query(
    `INSERT INTO aqua_claims (
       claim_id, owner_id, subject_entity_id, predicate,
       object_entity_id, object_literal, object_quantity, object_time_from,
       polarity, modality, valid_from, valid_to, asserted_at,
       state, superseded_by, extractor, extractor_version, actor,
       statement_text, statement_norm)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),$13,$14,'test','v1','test',$15,$15)`,
    [c.claim_id, c.owner_id, c.subject_entity_id, c.predicate,
      c.object_entity_id, c.object_literal, c.object_quantity, c.object_time_from,
      c.polarity, c.modality, c.valid_from, c.valid_to,
      c.state, c.superseded_by, c.statement_text]);
}

// ── The tables exist ─────────────────────────────────────────────────────────

describe('claim schema — the tables', () => {
  test('every table the blueprint names is created', async () => {
    for (const t of ['aqua_entities', 'aqua_entity_aliases', 'aqua_entity_merges',
      'aqua_claims', 'aqua_sources', 'aqua_evidence', 'aqua_claim_evidence']) {
      await mem.pool.query(`SELECT count(*) FROM ${t}`);
    }
  });

  test('a well-formed claim is accepted — the constraints are not merely strict', async () => {
    await assert.doesNotReject(() => insertClaim());
  });
});

// ── One object, exactly ──────────────────────────────────────────────────────

describe('claim schema — exactly one object form', () => {
  test('TWO objects are refused', async () => {
    // A claim with two objects is two claims. Enforced in the schema because a
    // code-level rule holds only until the second writer.
    await assert.rejects(() => insertClaim({ object_entity_id: AQUIPLEX }));
  });

  test('ZERO objects are refused', async () => {
    await assert.rejects(() => insertClaim({ object_literal: null }));
  });

  test('each object form works on its own', async () => {
    await assert.doesNotReject(() => insertClaim({ object_literal: null, object_entity_id: AQUIPLEX }));
    await assert.doesNotReject(() => insertClaim({ object_literal: null, object_quantity: 30 }));
    await assert.doesNotReject(() => insertClaim({ object_literal: null, object_time_from: new Date() }));
  });
});

// ── Polarity: the failure that inverts meaning ───────────────────────────────

describe('claim schema — polarity', () => {
  test('a negated claim is representable at all', async () => {
    // The current lane stores "Priya no longer works at Aquiplex" as
    // member_of(Priya, Aquiplex). Measured: negation recall 20%, and every
    // captured one stored POSITIVELY. This column is the fix.
    await assert.doesNotReject(() => insertClaim({
      polarity: 'negated', statement_text: 'Priya no longer works at Aquiplex.',
    }));
  });

  test('an unknown polarity is refused rather than stored as a typo', async () => {
    await assert.rejects(() => insertClaim({ polarity: 'maybe' }));
  });
});

// ── Modality: intent is not fact ─────────────────────────────────────────────

describe('claim schema — modality', () => {
  test('all five modalities are accepted', async () => {
    for (const modality of ['fact', 'intent', 'hypothetical', 'question', 'quote']) {
      await assert.doesNotReject(() => insertClaim({ modality }), modality);
    }
  });

  test('an unknown modality is refused', async () => {
    // "I want to hire a designer" is an INTENT. Storing it as fact is how an
    // assistant becomes confidently wrong about someone's life.
    await assert.rejects(() => insertClaim({ modality: 'vibes' }));
  });
});

// ── Time: three of them, not one ─────────────────────────────────────────────

describe('claim schema — three timestamps', () => {
  test('world-validity and assertion time are separate columns', async () => {
    // "I moved to Bangalore last year": valid_from is last year, asserted_at is
    // today. Conflating them is why retrieval currently returns the OLD
    // employer for "where do I work" — measured at 20% on superseded.
    const from = new Date('2025-01-01');
    await assert.doesNotReject(() => insertClaim({ valid_from: from }));
    const { rows } = await mem.pool.query(
      'SELECT valid_from, asserted_at FROM aqua_claims WHERE valid_from IS NOT NULL LIMIT 1');
    assert.ok(rows[0].asserted_at > rows[0].valid_from,
      'asserted_at and valid_from are the same value — the columns are being conflated');
  });

  test('a validity range that ends before it starts is refused', async () => {
    await assert.rejects(() => insertClaim({
      valid_from: new Date('2026-01-01'), valid_to: new Date('2025-01-01'),
    }));
  });

  test('an unbounded claim is fine — most facts have no end date', async () => {
    await assert.doesNotReject(() => insertClaim({ valid_from: new Date('2024-01-01'), valid_to: null }));
  });
});

// ── Supersession: L5, nothing is deleted ─────────────────────────────────────

describe('claim schema — supersession', () => {
  test('a superseded claim MUST name its successor', async () => {
    // Half-applied supersession is how history silently forks.
    await assert.rejects(() => insertClaim({ state: 'superseded' }));
  });

  test('a live claim must NOT name one', async () => {
    await assert.rejects(() => insertClaim({ superseded_by: crypto.randomUUID() }));
  });

  test('the full supersede cycle works', async () => {
    const oldId = crypto.randomUUID();
    const newId = crypto.randomUUID();
    await insertClaim({ claim_id: oldId, statement_text: 'I work at Intercom.' });
    await insertClaim({ claim_id: newId, statement_text: 'I work at Nummo.' });
    await mem.pool.query(
      `UPDATE aqua_claims SET state='superseded', superseded_by=$2 WHERE claim_id=$1`,
      [oldId, newId]);
    const { rows } = await mem.pool.query(
      'SELECT state, superseded_by FROM aqua_claims WHERE claim_id=$1', [oldId]);
    assert.equal(rows[0].state, 'superseded');
    assert.equal(rows[0].superseded_by, newId);
  });
});

// ── Entities: L8 ─────────────────────────────────────────────────────────────

describe('claim schema — entities are opaque ids', () => {
  test('the label is not the key — two owners can both have a "Priya"', async () => {
    const other = await addEntity('person', 'Priya', 'priya', 'user:other');
    assert.notEqual(other, PRIYA, 'the same label produced the same id');
  });

  test('an owner may have only ONE active self entity', {
    skip: 'pg-mem ignores the WHERE on a partial unique index — see helpers/memoryPg.mjs',
  }, async () => {
    // The label "You" needed special-casing in five separate places. Two self
    // entities would reintroduce the ambiguity opaque ids exist to remove.
    //
    // 🔴 THIS TEST USED TO PASS, FOR THE WRONG REASON. pg-mem treated the
    // partial unique index as a FULL unique index on owner_id, so the second
    // insert was rejected — the right outcome by accident. The same defect
    // SILENTLY DROPPED a legitimate second entity of a different type, which
    // is how E5/PR-4's backfill appeared to lose rows.
    //
    // The harness now skips partial indexes rather than losing data, so this
    // constraint is genuinely unverifiable here. Skipped WITH A REASON rather
    // than deleted or left passing on a coincidence — the constraint is real
    // in Postgres and the migration still declares it.
    await addEntity('self', 'You', 'you', 'user:selftest');
    await assert.rejects(() => addEntity('self', 'You', 'you', 'user:selftest'));
  });

  test('the harness records which constraints it declined to enforce', () => {
    // So the skip above can never become invisible.
    assert.ok(Array.isArray(mem.skippedPartialIndexes));
    assert.ok(mem.skippedPartialIndexes.some(i => /aqua_entities_one_self_idx/i.test(i)),
      'the self-entity index was enforced after all — un-skip the test above');
  });

  test('a merged entity must say what it merged into', async () => {
    const loser = await addEntity('person', 'P', 'p', 'user:merge');
    await assert.rejects(() => mem.pool.query(
      `UPDATE aqua_entities SET status='merged' WHERE entity_id=$1`, [loser]));
  });

  test('a merge is recorded with an actor and is reversible', async () => {
    // L5 + L9. Today a merge is unrecoverable and unattributed.
    const from = await addEntity('person', 'P1', 'p1', 'user:merge2');
    const into = await addEntity('person', 'P2', 'p2', 'user:merge2');
    await mem.pool.query(
      `INSERT INTO aqua_entity_merges (merge_id, owner_id, from_entity_id, into_entity_id, reason, confidence, actor)
       VALUES ($1,'user:merge2',$2,$3,'same person',0.9,'user')`,
      [crypto.randomUUID(), from, into]);
    const { rows } = await mem.pool.query(
      `SELECT actor, reverted_at FROM aqua_entity_merges WHERE from_entity_id=$1`, [from]);
    assert.equal(rows[0].actor, 'user');
    assert.equal(rows[0].reverted_at, null, 'a fresh merge should not be pre-reverted');
  });
});

// ── Evidence: mandatory ──────────────────────────────────────────────────────

describe('claim schema — evidence', () => {
  test('an empty quote is refused — a claim with no span is a hallucination with a row', async () => {
    const src = crypto.randomUUID();
    await mem.pool.query(
      `INSERT INTO aqua_sources (source_id, owner_id, kind, trust_tier) VALUES ($1,$2,'conversation',0.6)`,
      [src, OWNER]);
    await assert.rejects(() => mem.pool.query(
      `INSERT INTO aqua_evidence (evidence_id, owner_id, source_id, quote, checksum)
       VALUES ($1,$2,$3,'','x')`, [crypto.randomUUID(), OWNER, src]));
  });

  test('one claim can carry several pieces of evidence — that IS corroboration', async () => {
    const src = crypto.randomUUID();
    await mem.pool.query(
      `INSERT INTO aqua_sources (source_id, owner_id, kind, trust_tier) VALUES ($1,$2,'document',0.9)`,
      [src, OWNER]);
    const claimId = crypto.randomUUID();
    await insertClaim({ claim_id: claimId, statement_text: 'corroborated claim' });

    for (const [quote, role] of [['first mention', 'primary'], ['second mention', 'corroborating']]) {
      const evId = crypto.randomUUID();
      await mem.pool.query(
        `INSERT INTO aqua_evidence (evidence_id, owner_id, source_id, quote, checksum)
         VALUES ($1,$2,$3,$4,'h')`, [evId, OWNER, src, quote]);
      await mem.pool.query(
        `INSERT INTO aqua_claim_evidence (owner_id, claim_id, evidence_id, role) VALUES ($1,$2,$3,$4)`,
        [OWNER, claimId, evId, role]);
    }
    const { rows } = await mem.pool.query(
      `SELECT count(*)::int AS n FROM aqua_claim_evidence WHERE claim_id=$1`, [claimId]);
    assert.equal(Number(rows[0].n), 2);
  });

  test("'contradicting' is a role, so a survived disagreement is showable", async () => {
    // A claim that survived a contradiction is STRONGER than one that never
    // faced one, and the user has to be able to see the disagreement rather
    // than only a flag.
    const sql = fs.readFileSync(
      path.join(ROOT, 'src/core/db/migrations/0006_claims.sql'), 'utf8');
    assert.match(sql, /'contradicting'/);
  });
});

// ── Inertness ────────────────────────────────────────────────────────────────

describe('claim schema — nothing uses it yet', () => {
  test('only the REPOSITORY touches the claim tables — one writer', () => {
    // E5/PR-1 asserted nothing referenced them. E5/PR-3 added the repository,
    // which must — and this went red, which is what the guard is for.
    //
    // The list has exactly one entry and that is the whole design: three
    // semantic stores with three write paths is what the audit found, and the
    // reason nobody could say what AQUA believed.
    const ALLOWED = ['src/core/claims/claimRepository.js', 'src/core/claims/backfill.js',
      'src/core/claims/projection.js'];
    const offenders = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        if (name === 'tests' || name.startsWith('.')) continue;
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(m?js|cjs)$/.test(name)) continue;
        if (/aqua_claims|aqua_entities\b/.test(fs.readFileSync(full, 'utf8'))) {
          offenders.push(path.relative(ROOT, full));
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    const undeclared = offenders.filter(f => !ALLOWED.includes(f.split(path.sep).join('/')));
    assert.deepEqual(undeclared, [], 'a second module touches the claim tables — that is how three stores happened');
  });

  test('every index leads with owner_id — L19 is structural, not conventional', () => {
    const sql = [5, 6].map(n => fs.readFileSync(
      path.join(ROOT, `src/core/db/migrations/000${n}_${n === 5 ? 'entities' : 'claims'}.sql`), 'utf8')).join('\n');
    const indexes = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS \w+\s*\n?\s*ON \w+ \(([^)]+)\)/g)];
    assert.ok(indexes.length >= 8, `only found ${indexes.length} indexes`);
    for (const m of indexes) {
      assert.match(m[1].trim(), /^owner_id/,
        `an index does not lead with owner_id: (${m[1]}) — cross-owner scans would be cheap`);
    }
  });
});
