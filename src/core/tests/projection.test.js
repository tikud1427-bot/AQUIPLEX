/**
 * AQUA — the claim projection
 * Blueprint E5/PR-5
 *
 * The read path. Nothing here writes: a persisted "current beliefs" store
 * would be the audit's three-stores mistake with a newer schema, because the
 * moment a derived view is stored it can disagree with what it came from.
 *
 * THE ASSERTION THIS SUITE EXISTS FOR is the superseded case. The retrieval
 * baseline measures it at **20%** — asked "where do I work", the engine
 * returns the OLD employer. Here it is a WHERE clause, and the same query with
 * a different cutoff returns the old one on purpose.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryPg } from './helpers/memoryPg.mjs';
import { _setPoolForTests, _resetForTests } from '../db/pool.js';
import { recordClaim, supersede } from '../claims/claimRepository.js';
import {
  whatWeKnow, whatPointsAt, historyOf, contradictions, coverage, confidenceOf,
} from '../claims/projection.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OWNER = 'user:proj';
let mem, restorePool, ME, INTERCOM, NUMMO, SRC;
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
  await mem.pool.query("UPDATE aqua_claims SET superseded_by = NULL, state = 'extracted'");
  await mem.pool.query('DELETE FROM aqua_claims');
  await mem.pool.query('DELETE FROM aqua_evidence');
  await mem.pool.query('DELETE FROM aqua_sources');
  await mem.pool.query('DELETE FROM aqua_entities');
  ME = await entity('self', 'You');
  INTERCOM = await entity('org', 'Intercom');
  NUMMO = await entity('org', 'Nummo');
  SRC = crypto.randomUUID();
  await mem.pool.query(
    `INSERT INTO aqua_sources (source_id, owner_id, kind, trust_tier) VALUES ($1,$2,'conversation',0.6)`,
    [SRC, OWNER]);
});

async function entity(type, label) {
  const id = crypto.randomUUID();
  await mem.pool.query(
    `INSERT INTO aqua_entities (entity_id, owner_id, type, canonical_label, normalized_label)
     VALUES ($1,$2,$3,$4,$5)`, [id, OWNER, type, label, label.toLowerCase()]);
  return id;
}
async function ev(quote) {
  const id = crypto.randomUUID();
  await mem.pool.query(
    `INSERT INTO aqua_evidence (evidence_id, owner_id, source_id, quote, checksum)
     VALUES ($1,$2,$3,$4,'h')`, [id, OWNER, SRC, quote]);
  return id;
}
const say = async (over) => recordClaim({
  ownerId: OWNER, subjectEntityId: ME, predicate: 'works_at',
  actor: 't', extractor: 'proj', evidence: [await ev(over.statementText ?? 'x')], ...over,
});

/** The exact scenario the retrieval baseline scores 20% on. */
async function employmentHistory() {
  const oldC = await say({
    object: { entityId: INTERCOM }, statementText: 'I work at Intercom.',
    validFrom: new Date('2022-01-01'),
  });
  const newC = await say({
    object: { entityId: NUMMO }, statementText: 'I work at Nummo.',
    validFrom: new Date('2025-01-01'),
  });
  await supersede(oldC.claimId, newC.claimId, OWNER, { validTo: new Date('2024-12-31') });
  return { oldC, newC };
}

// ── The failure this fixes ───────────────────────────────────────────────────

describe('projection — the superseded case, measured at 20% today', () => {
  test('"where do I work" returns the CURRENT employer', async () => {
    await employmentHistory();
    const { claims } = await whatWeKnow(OWNER, ME);
    assert.equal(claims.length, 1, 'both employers came back — currency is still ambiguous');
    assert.equal(claims[0].object, NUMMO);
  });

  test('"where did I work in 2023" returns the OLD one — and that is correct', async () => {
    // 🔴 The first version of the live filter also required
    // `state <> 'superseded'`, which made every historical query return
    // NOTHING: a superseded claim is exactly the one that was true in the
    // past. Supersession and validity are different questions.
    await employmentHistory();
    const { claims } = await whatWeKnow(OWNER, ME, { asOf: new Date('2023-06-01') });
    assert.equal(claims.length, 1);
    assert.equal(claims[0].object, INTERCOM);
  });

  test('a superseded claim with NO end date is still excluded from now', async () => {
    // 🔴 Found by measuring bite: removing the supersession clause failed ZERO
    // tests, because every superseded claim in the suite carried a `valid_to`
    // and the window alone excluded it. The headline test was passing for the
    // wrong reason.
    //
    // Supersession WITHOUT an end date is the real case — a correction where
    // nobody knows when the old fact stopped being true. Only the state check
    // catches it.
    const oldC = await say({ object: { entityId: INTERCOM }, statementText: 'I work at Intercom.' });
    const newC = await say({ object: { entityId: NUMMO }, statementText: 'I work at Nummo.' });
    await mem.pool.query(
      `UPDATE aqua_claims SET state='superseded', superseded_by=$2 WHERE claim_id=$1`,
      [oldC.claimId, newC.claimId]);

    const { claims } = await whatWeKnow(OWNER, ME);
    assert.deepEqual(claims.map(c => c.object), [NUMMO],
      'a superseded claim with no end date is still being reported as current');
  });

  test('a claim with no validity window is true at every cutoff', async () => {
    await say({ object: { entityId: NUMMO }, statementText: 'I work at Nummo.' });
    for (const asOf of [new Date('2020-01-01'), new Date(), new Date('2030-01-01')]) {
      assert.equal((await whatWeKnow(OWNER, ME, { asOf })).claims.length, 1, String(asOf));
    }
  });

  test('history shows every value, current and past, in order', async () => {
    // The current engine has no notion of "before".
    await employmentHistory();
    const h = await historyOf(OWNER, ME, 'works_at');
    assert.deepEqual(h.map(x => x.current), [true, false]);
    assert.equal(h[0].object, NUMMO);
    assert.equal(h[1].object, INTERCOM);
    assert.ok(h[1].supersededBy, 'the past value does not say what replaced it');
  });
});

// ── Reading backwards ────────────────────────────────────────────────────────

describe('projection — the inverse read', () => {
  test('an entity that is the OBJECT can be asked about', async () => {
    // `manages(Priya, Dev)` answers "who does Dev report to" without a second
    // row — two rows for one fact is how a graph disagrees with itself.
    await say({ object: { entityId: NUMMO }, statementText: 'I work at Nummo.' });
    const back = await whatPointsAt(OWNER, NUMMO);
    assert.equal(back.length, 1);
    assert.equal(back[0].predicate, 'works_at');
    assert.equal(back[0].readsAs, 'employs');
  });

  test('a predicate with no inverse is reported, not dropped', async () => {
    // Dropping it would silently hide half the graph from anyone asking
    // backwards, which reads as missing data rather than a missing inverse.
    await say({ predicate: 'related_to', object: { literal: 'x' }, statementText: 'related.' });
    const rows = await mem.pool.query(
      `SELECT predicate FROM aqua_claims WHERE predicate = 'related_to'`);
    assert.equal(rows.rows.length, 1);
  });

  test('a superseded claim does not answer backwards either', async () => {
    await employmentHistory();
    assert.deepEqual(await whatPointsAt(OWNER, INTERCOM), []);
  });
});

// ── Confidence ───────────────────────────────────────────────────────────────

describe('projection — confidence is a vector with a derived summary', () => {
  test('the components are never collapsed into a stored number', async () => {
    // L7. `overall` is absent from the table on purpose.
    await say({ object: { entityId: NUMMO }, statementText: 'I work at Nummo.' });
    const { claims } = await whatWeKnow(OWNER, ME);
    for (const k of ['extraction', 'source', 'corroboration', 'derived']) {
      assert.ok(k in claims[0].confidence, `missing ${k}`);
    }
  });

  test('a weak component is NOT masked by a strong one', async () => {
    // Multiplied, not averaged: a claim extracted badly from a trusted source
    // is still badly extracted, and averaging would hide that.
    const badly = confidenceOf({ confidence_extraction: 0.1, confidence_source: 0.9, confidence_corroboration: 0 });
    const evenly = confidenceOf({ confidence_extraction: 0.5, confidence_source: 0.5, confidence_corroboration: 0 });
    assert.ok(badly.derived < evenly.derived,
      'averaging let a trusted source rescue a bad extraction');
  });

  test('corroboration is a bonus, not a factor', async () => {
    // One well-extracted statement from the user is not one-third as good as
    // three; treating corroboration as a multiplier would say it is.
    const alone = confidenceOf({ confidence_extraction: 0.9, confidence_source: 0.9, confidence_corroboration: 0 });
    const backed = confidenceOf({ confidence_extraction: 0.9, confidence_source: 0.9, confidence_corroboration: 0.5 });
    assert.ok(alone.derived > 0.75, 'a strong uncorroborated claim was penalised for being alone');
    assert.ok(backed.derived > alone.derived);
  });

  test('nothing ever reaches certainty', async () => {
    const perfect = confidenceOf({ confidence_extraction: 1, confidence_source: 1, confidence_corroboration: 1 });
    assert.ok(perfect.derived < 1);
  });
});

// ── Contradictions ───────────────────────────────────────────────────────────

describe('projection — disagreements are surfaced, never resolved', () => {
  test('opposite polarity on the same relation is reported with BOTH sides', async () => {
    // The existing reasoning graph already refuses to resolve contradictions
    // and that is one of the better decisions in the codebase.
    await say({ object: { entityId: NUMMO }, statementText: 'I work at Nummo.' });
    await say({ object: { entityId: NUMMO }, statementText: 'I do not work at Nummo.', polarity: 'negated' });
    const found = await contradictions(OWNER);
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, 'polarity');
    assert.equal(found[0].sides.length, 2, 'only one side was kept — that is resolving, not surfacing');
  });

  test('a superseded claim is not a contradiction — it is history', async () => {
    await employmentHistory();
    assert.deepEqual(await contradictions(OWNER), []);
  });

  test('unresolved claims are excluded — they have no relation to disagree about', async () => {
    const { backfillOwner } = await import('../claims/backfill.js');
    await backfillOwner(OWNER, [
      { id: 'a', statement: 'One.', entities: ['You'], confidence: 0.6, sourceType: 'conversation', evidence: ['e1'] },
      { id: 'b', statement: 'Two.', entities: ['You'], confidence: 0.6, sourceType: 'conversation', evidence: ['e2'] },
    ], new Map([['e1', { quote: 'One.' }], ['e2', { quote: 'Two.' }]]));
    assert.deepEqual(await contradictions(OWNER), []);
  });
});

// ── Coverage ─────────────────────────────────────────────────────────────────

describe('projection — how much is actually understood', () => {
  test('unresolved claims are counted and reported separately', async () => {
    // A caller that does not know how much is un-understood will read a thin
    // answer as a complete one.
    const { backfillOwner } = await import('../claims/backfill.js');
    await say({ object: { entityId: NUMMO }, statementText: 'I work at Nummo.' });
    await backfillOwner(OWNER, [
      { id: 'a', statement: 'Legacy.', entities: ['You'], confidence: 0.6, sourceType: 'conversation', evidence: ['e1'] },
    ], new Map([['e1', { quote: 'Legacy.' }]]));

    const c = await coverage(OWNER);
    assert.equal(c.total, 2);
    assert.equal(c.unresolved, 1);
    assert.equal(c.understood, 1);
    assert.equal(c.understoodFraction, 0.5);
  });

  test('the counts are per-predicate, not the total — the FILTER trap', async () => {
    // 🔴 `count(*) FILTER (WHERE ...)` is SILENTLY IGNORED by pg-mem, which
    // returns the unfiltered count — so every number here read as the total
    // and coverage reported 100% unresolved. `SUM(CASE ...)` is identical in
    // Postgres and correct in both.
    await say({ object: { entityId: NUMMO }, statementText: 'I work at Nummo.' });
    const c = await coverage(OWNER);
    assert.equal(c.unresolved, 0, 'the unresolved count equals the total — FILTER is being ignored');
    assert.equal(c.superseded, 0);
  });

  test('an empty owner reports zero, not NaN', async () => {
    const c = await coverage('user:nobody');
    assert.equal(c.total, 0);
    assert.equal(c.understoodFraction, 0);
  });
});

// ── It reads, and only reads ─────────────────────────────────────────────────

describe('projection — nothing here writes', () => {
  test('no INSERT, UPDATE or DELETE anywhere in the module', () => {
    // A persisted "current beliefs" store would be the three-stores mistake
    // with a newer schema.
    const src = fs.readFileSync(path.join(ROOT, 'src/core/claims/projection.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    for (const banned of ['INSERT INTO', 'UPDATE ', 'DELETE FROM']) {
      assert.ok(!src.includes(banned), `projection.js contains ${banned}`);
    }
  });

  test('it reports not-configured rather than throwing', async () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      assert.equal((await whatWeKnow('u', 'e')).configured, false);
      assert.deepEqual(await whatPointsAt('u', 'e'), []);
      assert.equal((await coverage('u')).configured, false);
    } finally { process.env.DATABASE_URL = prev; }
  });

  test('nothing calls it yet — the read path is not wired into chat', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        if (name === 'tests' || name.startsWith('.')) continue;
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(m?js|cjs)$/.test(name)) continue;
        if (full.endsWith(path.join('claims', 'projection.js'))) continue;
        if (/claims\/projection/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(ROOT, full));
      }
    };
    walk(path.join(ROOT, 'src'));
    assert.deepEqual(offenders, [], 'the projection is now wired — make that deliberate');
  });
});
