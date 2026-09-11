/**
 * AQUA — the claim repository
 * Blueprint E5/PR-3
 *
 * The one writer. Every claim that ever exists is created here — not because a
 * facade is tidy, but because the alternative is what the audit found: three
 * semantic stores with three write paths, and the reason nobody can say what
 * AQUA believes is that it depends which one you ask.
 *
 * The assertions with the most bite are the REFUSALS. A repository that
 * accepts a claim with no evidence, or coerces an object into the wrong
 * column, produces rows that satisfy the schema and mean nothing.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryPg } from './helpers/memoryPg.mjs';
import { _setPoolForTests, _resetForTests } from '../db/pool.js';
import {
  recordClaim, attachEvidence, recomputeCorroboration, supersede,
  claimsAbout, claimWithEvidence, normalizeStatement, ClaimError,
} from '../claims/claimRepository.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OWNER = 'user:repo';
const OTHER = 'user:other';

let mem, restorePool, PRIYA, AQUIPLEX, NUMMO, SRC_A, SRC_B;
const envBefore = process.env.DATABASE_URL;

before(async () => {
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/aqua';
  _resetForTests();
  mem = createMemoryPg();
  restorePool = _setPoolForTests(mem.pool);
  await (await import('../db/migrate.js')).migrate();
});

after(async () => {
  restorePool?.();
  await mem?.close();
  if (envBefore === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = envBefore;
  _resetForTests();
});

beforeEach(async () => {
  await mem.pool.query('DELETE FROM aqua_claim_evidence');
  // Break the self-referencing FK before deleting: a superseded claim points
  // at its successor, so a plain DELETE hits the constraint. Clearing the
  // pointer first is what a real cleanup would do too — and finding this via
  // a `hookFailed` cascade rather than a real assertion is a reminder that a
  // failing fixture reports as a failing TEST.
  await mem.pool.query('UPDATE aqua_claims SET superseded_by = NULL, state = \'extracted\'');
  await mem.pool.query('DELETE FROM aqua_claims');
  await mem.pool.query('DELETE FROM aqua_evidence');
  await mem.pool.query('DELETE FROM aqua_sources');
  await mem.pool.query('DELETE FROM aqua_entities');
  PRIYA = await entity('person', 'Priya');
  AQUIPLEX = await entity('org', 'Aquiplex');
  NUMMO = await entity('org', 'Nummo');
  SRC_A = await source();
  SRC_B = await source();
});

async function entity(type, label, owner = OWNER) {
  const id = crypto.randomUUID();
  await mem.pool.query(
    `INSERT INTO aqua_entities (entity_id, owner_id, type, canonical_label, normalized_label)
     VALUES ($1,$2,$3,$4,$5)`, [id, owner, type, label, label.toLowerCase()]);
  return id;
}
async function source(owner = OWNER) {
  const id = crypto.randomUUID();
  await mem.pool.query(
    `INSERT INTO aqua_sources (source_id, owner_id, kind, trust_tier) VALUES ($1,$2,'conversation',0.6)`,
    [id, owner]);
  return id;
}
async function evidence(srcId, quote, owner = OWNER) {
  const id = crypto.randomUUID();
  await mem.pool.query(
    `INSERT INTO aqua_evidence (evidence_id, owner_id, source_id, quote, checksum)
     VALUES ($1,$2,$3,$4,'h')`, [id, owner, srcId, quote]);
  return id;
}
const claim = (over = {}) => ({
  ownerId: OWNER, subjectEntityId: PRIYA, predicate: 'works_at',
  object: { entityId: AQUIPLEX }, statementText: 'Priya works at Aquiplex.',
  actor: 'test', extractor: 'unit', ...over,
});

// ── Writing ──────────────────────────────────────────────────────────────────

describe('claim repository — writing', () => {
  test('a well-formed claim is recorded with its evidence', async () => {
    const ev = await evidence(SRC_A, 'Priya works at Aquiplex.');
    const r = await recordClaim(claim({ evidence: [ev] }));
    assert.equal(r.created, true);
    const stored = await claimWithEvidence(r.claimId, OWNER);
    assert.equal(stored.predicate, 'works_at');
    assert.equal(stored.object_entity_id, AQUIPLEX);
    assert.equal(stored.evidence.length, 1);
    assert.equal(stored.evidence[0].role, 'primary');
  });

  test('polarity and modality are stored, not flattened', async () => {
    // The two columns the current lane has nowhere to put. Negation recall is
    // 20% today and every capture is stored POSITIVELY.
    const ev = await evidence(SRC_A, 'Priya no longer works at Aquiplex.');
    const r = await recordClaim(claim({
      evidence: [ev], polarity: 'negated', modality: 'fact',
      statementText: 'Priya no longer works at Aquiplex.',
    }));
    const stored = await claimWithEvidence(r.claimId, OWNER);
    assert.equal(stored.polarity, 'negated');
  });

  test('world-validity and assertion time are stored separately', async () => {
    const ev = await evidence(SRC_A, 'Priya joined in 2023.');
    const validFrom = new Date('2023-04-01');
    const r = await recordClaim(claim({
      evidence: [ev], validFrom, statementText: 'Priya joined in 2023.',
    }));
    const stored = await claimWithEvidence(r.claimId, OWNER);
    assert.equal(new Date(stored.valid_from).getFullYear(), 2023);
    assert.ok(new Date(stored.asserted_at) > validFrom,
      'asserted_at collapsed onto valid_from — the columns are being conflated');
  });
});

// ── Refusals ─────────────────────────────────────────────────────────────────

describe('claim repository — what it refuses', () => {
  test('THE LOAD-BEARING ONE: no claim without evidence', async () => {
    // The table demands it; refusing here gives the caller a readable error
    // rather than a constraint violation. A claim with no span is a
    // hallucination with a database row.
    await assert.rejects(() => recordClaim(claim({ evidence: [] })), ClaimError);
    await assert.rejects(() => recordClaim(claim({ evidence: [] })), /hallucination/);
  });

  test('no claim without an actor — L9', async () => {
    const ev = await evidence(SRC_A, 'x');
    await assert.rejects(() => recordClaim(claim({ evidence: [ev], actor: '' })), /actor is required/);
  });

  test('an object of the WRONG KIND is refused, never coerced', async () => {
    // Coercion is how one predicate ends up with a literal in half its rows
    // and an entity in the other half, and the join stops working.
    const ev = await evidence(SRC_A, 'x');
    await assert.rejects(
      () => recordClaim(claim({ evidence: [ev], object: { literal: 'Aquiplex' } })),
      /expects a entity object/);
  });

  test('two objects, or none, are refused', async () => {
    const ev = await evidence(SRC_A, 'x');
    await assert.rejects(() => recordClaim(claim({
      evidence: [ev], object: { entityId: AQUIPLEX, literal: 'x' } })), /exactly one object/);
    await assert.rejects(() => recordClaim(claim({ evidence: [ev], object: {} })), /exactly one object/);
  });

  test('an unknown polarity or modality is refused', async () => {
    const ev = await evidence(SRC_A, 'x');
    await assert.rejects(() => recordClaim(claim({ evidence: [ev], polarity: 'maybe' })), /unknown polarity/);
    await assert.rejects(() => recordClaim(claim({ evidence: [ev], modality: 'vibes' })), /unknown modality/);
  });

  test('a backwards validity range is refused before the insert', async () => {
    const ev = await evidence(SRC_A, 'x');
    await assert.rejects(() => recordClaim(claim({
      evidence: [ev], validFrom: new Date('2026-01-01'), validTo: new Date('2025-01-01'),
    })), /validTo is before validFrom/);
  });

  test("CROSS-OWNER: another owner's evidence cannot be linked", async () => {
    // L19 says isolation is structural. A repository that trusted its caller
    // would make it conventional again.
    const foreignSrc = await source(OTHER);
    const foreignEv = await evidence(foreignSrc, 'not yours', OTHER);
    await assert.rejects(
      () => recordClaim(claim({ evidence: [foreignEv] })), /cross-owner link refused/);
  });
});

// ── Dedup and corroboration ──────────────────────────────────────────────────

describe('claim repository — the same thing said twice is ONE claim', () => {
  test('a repeat attaches evidence instead of creating a second claim', async () => {
    // The second time someone says a thing, the right outcome is a STRONGER
    // claim, not a second one. `created:false` lets the caller SEE
    // corroboration rather than silently believing it wrote something new.
    const first = await recordClaim(claim({ evidence: [await evidence(SRC_A, 'a')] }));
    const second = await recordClaim(claim({ evidence: [await evidence(SRC_B, 'b')] }));
    assert.equal(second.created, false);
    assert.equal(second.claimId, first.claimId);
    assert.equal(second.evidenceAdded, 1);

    const { rows } = await mem.pool.query('SELECT count(*)::int AS n FROM aqua_claims');
    assert.equal(Number(rows[0].n), 1, 'a duplicate claim was created');
  });

  test('case and whitespace differences are not new beliefs', async () => {
    assert.equal(normalizeStatement('Priya  works at Aquiplex.'), normalizeStatement('priya works at aquiplex'));
    const a = await recordClaim(claim({ evidence: [await evidence(SRC_A, 'a')] }));
    const b = await recordClaim(claim({
      evidence: [await evidence(SRC_B, 'b')], statementText: '  PRIYA WORKS AT AQUIPLEX  ' }));
    assert.equal(b.claimId, a.claimId);
  });

  test('corroboration counts DISTINCT SOURCES, not evidence rows', async () => {
    // Six quotes from one document is one source agreeing with itself.
    // Counting evidence rows would let a single chatty file manufacture
    // confidence.
    const r = await recordClaim(claim({ evidence: [await evidence(SRC_A, 'q1')] }));
    await attachEvidence(r.claimId, OWNER, [await evidence(SRC_A, 'q2')]);
    await attachEvidence(r.claimId, OWNER, [await evidence(SRC_A, 'q3')]);
    const sameSource = await recomputeCorroboration(r.claimId, OWNER);
    assert.equal(sameSource.sources, 1);
    assert.equal(sameSource.score, 0, 'three quotes from ONE source manufactured confidence');

    await attachEvidence(r.claimId, OWNER, [await evidence(SRC_B, 'q4')]);
    const twoSources = await recomputeCorroboration(r.claimId, OWNER);
    assert.equal(twoSources.sources, 2);
    assert.ok(twoSources.score > 0);
  });

  test('corroboration never reaches certainty', async () => {
    const r = await recordClaim(claim({ evidence: [await evidence(SRC_A, 'q')] }));
    for (let i = 0; i < 30; i++) {
      await attachEvidence(r.claimId, OWNER, [await evidence(await source(), `q${i}`)]);
    }
    const { score } = await recomputeCorroboration(r.claimId, OWNER);
    assert.ok(score < 1, 'agreement alone produced certainty');
    assert.ok(score <= 0.9);
  });

  test('contradicting evidence does not raise corroboration', async () => {
    const r = await recordClaim(claim({ evidence: [await evidence(SRC_A, 'q')] }));
    await attachEvidence(r.claimId, OWNER, [await evidence(SRC_B, 'no')], 'contradicting');
    const { sources } = await recomputeCorroboration(r.claimId, OWNER);
    assert.equal(sources, 1, 'a contradiction was counted as agreement');
  });

  test('the same evidence twice is not counted twice', async () => {
    const ev = await evidence(SRC_A, 'q');
    const r = await recordClaim(claim({ evidence: [ev] }));
    assert.equal(await attachEvidence(r.claimId, OWNER, [ev]), 0);
  });
});

// ── Supersession ─────────────────────────────────────────────────────────────

describe('claim repository — supersession is a write, not a delete', () => {
  test('the old claim is marked and linked forward', async () => {
    // L5. The retrieval baseline measures what ambiguous currency costs: the
    // OLD employer wins, 20% on the superseded category.
    const oldC = await recordClaim(claim({ evidence: [await evidence(SRC_A, 'a')] }));
    const newC = await recordClaim(claim({
      evidence: [await evidence(SRC_B, 'b')],
      object: { entityId: NUMMO }, statementText: 'Priya works at Nummo.' }));

    await supersede(oldC.claimId, newC.claimId, OWNER);

    const stored = await claimWithEvidence(oldC.claimId, OWNER);
    assert.equal(stored.state, 'superseded');
    assert.equal(stored.superseded_by, newC.claimId);
    assert.ok(stored.valid_to, 'a superseded claim with no end date is still "current" to a temporal query');
  });

  test('the live view excludes it — the query the engine cannot express today', async () => {
    const oldC = await recordClaim(claim({ evidence: [await evidence(SRC_A, 'a')] }));
    const newC = await recordClaim(claim({
      evidence: [await evidence(SRC_B, 'b')],
      object: { entityId: NUMMO }, statementText: 'Priya works at Nummo.' }));
    await supersede(oldC.claimId, newC.claimId, OWNER);

    const live = await claimsAbout(OWNER, PRIYA);
    assert.deepEqual(live.map(c => c.claim_id), [newC.claimId]);

    const all = await claimsAbout(OWNER, PRIYA, { includeSuperseded: true });
    assert.equal(all.length, 2, 'history was destroyed rather than superseded');
  });

  test('a claim cannot supersede itself', async () => {
    const c = await recordClaim(claim({ evidence: [await evidence(SRC_A, 'a')] }));
    await assert.rejects(() => supersede(c.claimId, c.claimId, OWNER), /cannot supersede itself/);
  });

  test('superseding twice is refused, not silently reapplied', async () => {
    const a = await recordClaim(claim({ evidence: [await evidence(SRC_A, 'a')] }));
    const b = await recordClaim(claim({
      evidence: [await evidence(SRC_B, 'b')], object: { entityId: NUMMO },
      statementText: 'Priya works at Nummo.' }));
    await supersede(a.claimId, b.claimId, OWNER);
    await assert.rejects(() => supersede(a.claimId, b.claimId, OWNER), /already superseded/);
  });

  test("another owner cannot supersede this owner's claim", async () => {
    const c = await recordClaim(claim({ evidence: [await evidence(SRC_A, 'a')] }));
    await assert.rejects(() => supersede(c.claimId, crypto.randomUUID(), OTHER), ClaimError);
    assert.equal((await claimWithEvidence(c.claimId, OWNER)).state, 'extracted');
  });
});

// ── Isolation ────────────────────────────────────────────────────────────────

describe('claim repository — owners are isolated', () => {
  test("one owner's claims are invisible to another", async () => {
    const c = await recordClaim(claim({ evidence: [await evidence(SRC_A, 'a')] }));
    assert.equal(await claimWithEvidence(c.claimId, OTHER), null);
    assert.deepEqual(await claimsAbout(OTHER, PRIYA), []);
  });

  test('two owners can hold contradictory claims about the same label', async () => {
    // Entities are per-owner and opaque (L8), so "Priya" in two accounts is
    // two entities and neither claim disturbs the other.
    const theirPriya = await entity('person', 'Priya', OTHER);
    const theirSrc = await source(OTHER);
    const theirEv = await evidence(theirSrc, 'Priya left.', OTHER);
    await recordClaim(claim({ evidence: [await evidence(SRC_A, 'a')] }));
    await recordClaim({
      ownerId: OTHER, subjectEntityId: theirPriya, predicate: 'works_at',
      object: { entityId: theirPriya }, statementText: 'Priya left.',
      actor: 'test', extractor: 'unit', evidence: [theirEv], polarity: 'negated',
    });
    const { rows } = await mem.pool.query('SELECT count(*)::int AS n FROM aqua_claims');
    assert.equal(Number(rows[0].n), 2);
  });
});

// ── Wiring ───────────────────────────────────────────────────────────────────

describe('claim repository — wiring', () => {
  test('it is the ONE writer — nothing else inserts a claim', () => {
    // The whole point. Three write paths is how a system stops being able to
    // say what it believes.
    const offenders = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        if (name === 'tests' || name.startsWith('.')) continue;
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(m?js|cjs)$/.test(name)) continue;
        // E5/PR-4's backfill is the SECOND and LAST writer, and it is a
        // deliberate exception: a migration cannot go through a repository
        // that refuses claims without a predicate, because legacy facts have
        // none. It writes `unresolved` claims and nothing else — asserted in
        // backfill.test.js. Any THIRD writer fails here.
        if (full.endsWith(path.join('claims', 'claimRepository.js'))) continue;
        if (full.endsWith(path.join('claims', 'backfill.js'))) continue;
        if (/INSERT INTO aqua_claims/i.test(fs.readFileSync(full, 'utf8'))) {
          offenders.push(path.relative(ROOT, full));
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    assert.deepEqual(offenders, [], 'a second claim writer exists — that is how the audit found three stores');
  });

  test('only DECLARED callers touch the repository — no drift onto the writer', () => {
    // This test was `nothing CALLS the repository yet` and it fired on E5/PR-6,
    // which is exactly what it was for: the first caller became a deliberate
    // edit rather than a change nobody reviewed. Rewritten rather than deleted,
    // because the property worth keeping was never "zero callers" — it was
    // "one writer, and a named list of who reaches it". That is what stops the
    // three-stores problem the audit found from reassembling itself.
    //
    // Grows by DELIBERATE edit only. Each entry should cost a red battery first.
    const DECLARED = [
      // E5/PR-5 — mentions the repository only inside a guard asserting it does
      // NOT call it. Reads no rows, writes none.
      path.join('claims', 'shadowMode.js'),
      // E5/PR-6 — the shadow projector's purge path and its composition over
      // backfill. Projects only; retrieval still reads the JSON store.
      path.join('claims', 'shadowProjector.js'),
      // E5/PR-6 — account deletion must reach claim rows (G4). Found by running
      // the purge gate, not by reading it.
      path.join('account', 'accountPurge.js'),
    ];
    const offenders = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        if (name === 'tests' || name.startsWith('.')) continue;
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(m?js|cjs)$/.test(name)) continue;
        if (full.endsWith(path.join('claims', 'claimRepository.js'))) continue;
        if (DECLARED.some(x => full.endsWith(x))) continue;
        if (/claimRepository/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(ROOT, full));
      }
    };
    walk(path.join(ROOT, 'src'));
    assert.deepEqual(offenders, [],
      'a new module reaches the claim writer — add it to DECLARED on purpose, or do not');
  });
});
