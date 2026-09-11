/**
 * AQUA — backfilling existing facts into claims
 * Blueprint E5/PR-4
 *
 * The question this PR exists to answer: **can the claim schema represent what
 * AQUA already believes?** Her store holds 65 facts across 6 owners. If those
 * cannot become claims, the schema is wrong and every PR built on it inherits
 * the error — so the answer arrives as a number rather than an opinion.
 *
 * The answer is: the *shape* projects cleanly, and the *understanding* does
 * not exist to project. A legacy fact is a verbatim sentence plus an entity
 * list; it has no predicate, polarity, modality or validity because the lane
 * that wrote it had nowhere to put them.
 *
 * This suite asserts the backfill preserves everything that IS there and
 * REFUSES to invent what is not.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryPg } from './helpers/memoryPg.mjs';
import { _setPoolForTests, _resetForTests } from '../db/pool.js';
import { assess, backfillOwner, unresolvedCount, UNRESOLVED, BackfillError } from '../claims/backfill.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OWNER = 'user:bf';
let mem, restorePool;
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
});

/** Legacy facts, shaped exactly as the evidence store writes them. */
const legacy = (over = {}) => ({
  id: `f-${Math.random()}`, statement: 'I run product at Nummo.',
  entities: ['You', 'Nummo'], confidence: 0.6, sourceType: 'conversation',
  evidence: ['e1'], ...over,
});
const evMap = facts => new Map(facts.flatMap(f => f.evidence.map(e => [e, { quote: f.statement }])));

// ── The assessment ───────────────────────────────────────────────────────────

describe('backfill — what a legacy fact can become', () => {
  test('a complete fact is projectable', () => {
    const v = assess(legacy());
    assert.equal(v.projectable, true);
    assert.deepEqual(v.problems, []);
  });

  test('an incomplete fact names exactly what is missing', () => {
    assert.deepEqual(assess(legacy({ statement: '' })).problems, ['no statement']);
    assert.deepEqual(assess(legacy({ entities: [] })).problems, ['no entities']);
    assert.deepEqual(assess(legacy({ evidence: [] })).problems, ['no evidence']);
  });

  test('THE FINDING: predicate, polarity, modality and validity are DEFERRED, not guessed', () => {
    // Guessing a predicate from a sentence is extraction, and doing it inside
    // a migration would bury a low-quality extractor where nobody evaluates
    // it — a silent, unmeasured version of exactly what E6 does properly.
    assert.deepEqual(assess(legacy()).deferred,
      ['predicate', 'polarity', 'modality', 'valid_from', 'valid_to']);
  });

  test('assess is pure — it needs no database', () => {
    // So the question "can the schema hold this?" is answerable without one.
    assert.doesNotThrow(() => assess(legacy()));
  });
});

// ── What projects ────────────────────────────────────────────────────────────

describe('backfill — everything that IS there is preserved', () => {
  test('the statement survives verbatim — the user\'s own words', async () => {
    const facts = [legacy({ statement: 'Priya no longer works at Aquiplex.' })];
    await backfillOwner(OWNER, facts, evMap(facts));
    const { rows } = await mem.pool.query('SELECT statement_text FROM aqua_claims');
    assert.equal(rows[0].statement_text, 'Priya no longer works at Aquiplex.');
  });

  test('the legacy TRUST TIERS survive — file 0.9 beats chat 0.6', async () => {
    // L10. A backfill that flattened them would erase the one piece of ranking
    // information the old store did carry.
    const facts = [legacy({ sourceType: 'document', evidence: ['d1'] }), legacy({ evidence: ['c1'] })];
    await backfillOwner(OWNER, facts, evMap(facts));
    const { rows } = await mem.pool.query('SELECT kind, trust_tier FROM aqua_sources ORDER BY kind');
    assert.deepEqual(rows.map(r => [r.kind, Number(r.trust_tier)]),
      [['conversation', 0.6], ['document', 0.9]]);
  });

  test('every claim carries evidence — provenance is never optional', async () => {
    const facts = [legacy()];
    await backfillOwner(OWNER, facts, evMap(facts));
    const { rows } = await mem.pool.query('SELECT count(*)::int AS n FROM aqua_claim_evidence');
    assert.equal(Number(rows[0].n), 1);
  });

  test('the self entity keeps its TYPE but stops being keyed by its label', async () => {
    // L8. The old store used the literal word "You", which needed
    // special-casing in five places.
    const facts = [legacy()];
    await backfillOwner(OWNER, facts, evMap(facts));
    const { rows } = await mem.pool.query(
      "SELECT type, canonical_label FROM aqua_entities WHERE normalized_label = 'you'");
    assert.equal(rows[0].type, 'self');
    assert.equal(rows[0].canonical_label, 'You', 'the label is kept for display');
  });

  test('claims are marked as not-yet-understood, and the debt is countable', async () => {
    // `SELECT count(*) WHERE predicate='unresolved'` is the number of things
    // AQUA has stored and not understood. A real predicate here would be a
    // guess wearing a fact's clothes.
    const facts = [legacy(), legacy({ statement: 'Different.', evidence: ['e2'] })];
    await backfillOwner(OWNER, facts, evMap(facts));
    const { rows } = await mem.pool.query('SELECT DISTINCT predicate FROM aqua_claims');
    assert.deepEqual(rows.map(r => r.predicate), [UNRESOLVED]);
    assert.equal(await unresolvedCount(OWNER), 2);
  });
});

// ── What does not ────────────────────────────────────────────────────────────

describe('backfill — what it refuses, and reports', () => {
  test('an unprojectable fact is SKIPPED with its reason, not silently dropped', async () => {
    const facts = [legacy(), legacy({ statement: '', evidence: ['x'] }), legacy({ entities: [], evidence: ['y'] })];
    const report = await backfillOwner(OWNER, facts, evMap(facts));
    assert.equal(report.projected, 1);
    assert.deepEqual(report.skipped.map(s => s.problems),
      [['no statement'], ['no entities']]);
  });

  test('a dry run assesses and writes nothing', async () => {
    const facts = [legacy()];
    const report = await backfillOwner(OWNER, facts, evMap(facts), { dryRun: true });
    assert.equal(report.projected, 1);
    const { rows } = await mem.pool.query('SELECT count(*)::int AS n FROM aqua_claims');
    assert.equal(Number(rows[0].n), 0, 'a dry run wrote to the database');
  });

  test('it refuses clearly with no database rather than failing obscurely', async () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await assert.rejects(() => backfillOwner(OWNER, [legacy()], new Map()), BackfillError);
    } finally { process.env.DATABASE_URL = prev; }
  });
});

// ── Idempotency ──────────────────────────────────────────────────────────────

describe('backfill — running it twice changes nothing', () => {
  test('a second run projects ZERO', async () => {
    // A migration that duplicates on re-run is a migration nobody dares
    // repeat, and half-finished migrations are the ones that need repeating.
    const facts = [legacy(), legacy({ statement: 'Second.', evidence: ['e2'] })];
    const first = await backfillOwner(OWNER, facts, evMap(facts));
    assert.equal(first.projected, 2);
    const second = await backfillOwner(OWNER, facts, evMap(facts));
    assert.equal(second.projected, 0);
    assert.equal(await unresolvedCount(OWNER), 2);
  });

  test('entities are reused, not duplicated', async () => {
    const facts = [legacy(), legacy({ statement: 'Second.', evidence: ['e2'] })];
    await backfillOwner(OWNER, facts, evMap(facts));
    const { rows } = await mem.pool.query(
      "SELECT count(*)::int AS n FROM aqua_entities WHERE normalized_label='you'");
    assert.equal(Number(rows[0].n), 1, 'the same entity was created twice');
  });

  test('two owners with the same labels stay separate', async () => {
    const facts = [legacy()];
    await backfillOwner(OWNER, facts, evMap(facts));
    await backfillOwner('user:other', facts, evMap(facts));
    const { rows } = await mem.pool.query(
      "SELECT count(*)::int AS n FROM aqua_entities WHERE normalized_label='you'");
    assert.equal(Number(rows[0].n), 2, 'two owners collapsed onto one entity');
  });
});

// ── The harness limitation this PR uncovered ─────────────────────────────────

describe('backfill — the simulator defect it exposed', () => {
  test('the harness declines to enforce partial unique indexes, and says which', () => {
    // 🔴 Found here: pg-mem ignores the WHERE on a partial unique index and
    // then SILENTLY DROPS the conflicting row rather than raising. Two
    // entities for one owner — one `self`, one `concept` — and only the first
    // persisted, with both inserts reporting success.
    //
    // That looked exactly like a backfill bug. It was the harness losing data.
    // Silent loss in a test harness is worse than a missing feature, so the
    // harness now skips those indexes and records them.
    assert.ok(mem.skippedPartialIndexes.length >= 1);
  });

  test('a second entity of a DIFFERENT type now persists — the case that vanished', async () => {
    const facts = [legacy({ entities: ['You'] }), legacy({ entities: ['Priya'], statement: 'P.', evidence: ['e2'] })];
    await backfillOwner(OWNER, facts, evMap(facts));
    const { rows } = await mem.pool.query('SELECT canonical_label FROM aqua_entities ORDER BY canonical_label');
    assert.deepEqual(rows.map(r => r.canonical_label), ['Priya', 'You']);
  });
});

// ── Wiring ───────────────────────────────────────────────────────────────────

describe('backfill — wiring', () => {
  test('nothing runs it automatically', () => {
    // A migration that runs itself at boot is a migration nobody chose.
    const offenders = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        if (name === 'tests' || name.startsWith('.')) continue;
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(m?js|cjs)$/.test(name)) continue;
        if (full.endsWith(path.join('claims', 'backfill.js'))) continue;
        if (/claims\/backfill/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(ROOT, full));
      }
    };
    walk(path.join(ROOT, 'src'));
    assert.deepEqual(offenders, [], 'something now backfills on its own — make that deliberate');
  });

  test('it writes ONLY unresolved claims — it is not a secret extractor', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/claims/backfill.js'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    const inserts = [...src.matchAll(/INSERT INTO aqua_claims[\s\S]*?predicate[^,]*,/g)];
    assert.ok(src.includes('UNRESOLVED'), 'the backfill picks a predicate other than unresolved');
    assert.ok(!/predicate\s*=\s*['"](?!unresolved)/.test(src));
  });
});
