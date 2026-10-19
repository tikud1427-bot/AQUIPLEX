/**
 * Bounded S8 history decides exactly like the full history (2026-10-18) — live Postgres.
 *
 * findClaimsForDedup used to load every non-archived claim of the incoming
 * predicates (0.54 s per segment at 20,000 claims in one bucket). The bounded
 * version reads targeted candidates. Each scenario below buries the claim that
 * decides an S8 rule among hundreds of distractors — often in the SAME bucket and
 * OLDER than the bucket cap — and requires both histories to produce the same
 * decision. Where a cap makes certainty impossible, the bounded history must
 * ABSTAIN (ambiguous), never decide differently.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-dedup-bounded-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';

const { isConfigured, getPool } = await import('../db/pool.js');
const skip = isConfigured() ? false : 'needs a live migrated Postgres — set AQUA_TEST_DATABASE_URL';
const { findClaimsForDedup, DEDUP_BUCKET_LIMIT } = await import('../worldModel/worldModelRepository.js');
const { dedupAndDetect, sameAttributeValue, revisionHistoryPredicates, isResolutionStatus, RESOLUTION_HISTORY_PREDICATES } = await import('../../brain/understanding/claimDedup.js');
const { singleValuedPredicateNames, singleObjectPredicateNames } = await import('../claims/predicateRegistry.js');

const RUN = `dedupb-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const owners = [];
let n = 0;

async function world() {
  const owner = `user:${RUN}-${n++}`;
  owners.push(owner);
  const p = await getPool();
  const ents = new Map();
  const entity = async (label) => {
    if (ents.has(label)) return ents.get(label);
    const id = crypto.randomUUID();
    await p.query(`INSERT INTO aqua_entities (entity_id, owner_id, type, canonical_label, normalized_label) VALUES ($1,$2,$3,$4,$5)`,
      [id, owner, label === 'You' ? 'self' : 'concept', label, label.toLowerCase()]);
    ents.set(label, id);
    return id;
  };
  let minute = 100000;
  const claim = async (subject, predicate, object, statement, over = {}) => {
    const id = crypto.randomUUID();
    const s = await entity(subject);
    const oe = object.entity ? await entity(object.entity) : null;
    await p.query(`INSERT INTO aqua_claims (claim_id, owner_id, subject_entity_id, predicate, object_entity_id, object_literal,
        polarity, modality, state, asserted_at, extractor, extractor_version, actor, statement_text, statement_norm)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() - ($10 || ' minutes')::interval, 'test', 'v0', 'system', $11, lower($11))`,
      [id, owner, s, predicate, oe, object.literal ?? null, over.polarity ?? 'asserted', over.modality ?? 'fact', over.state ?? 'active', String(over.minutesAgo ?? minute--), statement]);
    return id;
  };
  // N newer distractors in ONE bucket (subject, predicate) — all newer than anything claimed before.
  const flood = async (subject, predicate, count) => {
    const s = await entity(subject);
    await p.query(`INSERT INTO aqua_claims (claim_id, owner_id, subject_entity_id, predicate, object_literal, state, asserted_at,
        extractor, extractor_version, actor, statement_text, statement_norm)
      SELECT gen_random_uuid(), $1, $2, $3, 'filler value ' || g, 'active', now() - (g || ' seconds')::interval, 'test', 'v0', 'system',
             'Filler statement ' || g, 'filler statement ' || g FROM generate_series(1, $4::int) g`, [owner, s, predicate, count]);
  };
  return { owner, claim, flood };
}

const S8 = { functionalPredicates: new Set(singleValuedPredicateNames()), singleObjectPredicates: new Set(singleObjectPredicateNames()) };
const incoming = (subject, predicate, object, statementText, over = {}) => ({ claimId: crypto.randomUUID(), subject, predicate, object,
  objectKind: object.entity ? 'entity' : 'literal', polarity: 'asserted', modality: 'fact', statementText, ...over });
async function decide(owner, claims, mode) {
  // Exactly the commit path's request (brain/index.js understandTurn → S8).
  const extraPredicates = [...(claims.some(isResolutionStatus) ? RESOLUTION_HISTORY_PREDICATES : []), ...revisionHistoryPredicates(claims)];
  const hist = await findClaimsForDedup({ ownerId: owner, claims, extraPredicates, mode, sameKind: sameAttributeValue });
  const r = dedupAndDetect(claims.map(c => ({ ...c })), hist, { ...S8, truncation: hist.truncation ?? null });
  return {
    contradictions: r.contradictions.map(c => [c.kind, c.existing.claimId]).sort(),
    attachments: r.evidenceAttachments.map(a => a.targetClaimId).sort(),
    ambiguous: r.ambiguousRevisions.map(a => String(a.reason ?? '')).sort(),
    rows: hist.length,
  };
}
async function same(owner, claims, label = claims[0]?.statementText) {
  const full = await decide(owner, claims, 'full');
  const bounded = await decide(owner, claims, 'bounded');
  assert.deepEqual({ ...bounded, rows: 0 }, { ...full, rows: 0 }, `[${label}] bounded ${JSON.stringify(bounded)} ≠ full ${JSON.stringify(full)}`);
  assert.ok(bounded.rows <= full.rows);
  return { full, bounded };
}
const BIG = DEDUP_BUCKET_LIMIT + 100;

describe('bounded S8 history = full S8 history', { skip }, () => {
  after(async () => {
    const p = await getPool();
    for (const o of owners) {
      await p.query('DELETE FROM aqua_claims WHERE owner_id = $1', [o]);
      await p.query('DELETE FROM aqua_entities WHERE owner_id = $1', [o]);
    }
  });

  test('a long-held single value still contradicts a new one (snapshot), under a flood of newer claims', async () => {
    const w = await world();
    const nummo = await w.claim('You', 'works_at', { entity: 'Nummo' }, 'I work at Nummo', { minutesAgo: 900000 });
    await w.flood('You', 'has_property', BIG); await w.flood('You', 'uses', BIG);
    const { full } = await same(w.owner, [incoming('You', 'works_at', { entity: 'Zeta Labs' }, 'I work at Zeta Labs now', { revises: true })]);
    assert.ok(full.contradictions.some(([, id]) => id === nummo));
  });

  test('re-stating an OLD value buried in a full bucket corroborates it — no duplicate', async () => {
    const w = await world();
    const old = await w.claim('You', 'has_property', { literal: 'studied sports science' }, 'I studied sports science', { minutesAgo: 900000 });
    await w.flood('You', 'has_property', BIG);
    const { full } = await same(w.owner, [incoming('You', 'has_property', { literal: 'studied sports science' }, 'I studied sports science')]);
    assert.deepEqual(full.attachments, [old]);
  });

  test('sole-value revision of has_property finds its one same-kind rival in a cut bucket', async () => {
    const w = await world();
    const price = await w.claim('You', 'has_property', { literal: '$29 per clinic per month' }, 'Our price is $29 per clinic per month', { minutesAgo: 900000 });
    await w.flood('You', 'has_property', BIG);
    const { full, bounded } = await same(w.owner, [incoming('You', 'has_property', { literal: '$39 per clinic per month' }, 'The price is now $39 per clinic per month', { revises: true })]);
    assert.ok(full.contradictions.some(([k, id]) => k === 'revision' && id === price));
    assert.ok(bounded.rows < BIG);
  });

  test('two same-kind rivals → ambiguous on both', async () => {
    const w = await world();
    await w.claim('You', 'has_property', { literal: '$29 per clinic per month' }, 'Our price is $29 per clinic per month', { minutesAgo: 900000 });
    await w.claim('You', 'has_property', { literal: '$12 per seat' }, 'The add-on is $12 per seat', { minutesAgo: 800000 });
    await w.flood('You', 'has_property', BIG);
    const { full } = await same(w.owner, [incoming('You', 'has_property', { literal: '$39 per clinic per month' }, 'The price is now $39 per clinic per month', { revises: true })]);
    assert.deepEqual(full.contradictions, []);
  });

  test('attribute named as a subject, plan rescheduled, plan cancelled, responsibility ended — each under a flood', async () => {
    const cases = [
      async w => { await w.claim('Our price', 'has_property', { literal: '$29 per clinic per month' }, 'Our price is $29 per clinic per month', { minutesAgo: 900000 });
        await w.flood('You', 'has_property', BIG);
        return incoming('You', 'has_property', { literal: '$39 per clinic per month' }, 'We raised our price to $39 per clinic per month', { revises: true }); },
      async w => { await w.claim('You', 'plans_to', { literal: 'launch publicly on April 14' }, "We're planning to launch publicly on April 14", { modality: 'intent', minutesAgo: 900000 });
        await w.flood('You', 'plans_to', BIG);
        return incoming('public launch', 'deadline_for', { literal: 'May 2' }, 'We moved the public launch to May 2', { revises: true }); },
      async w => { await w.claim('You', 'plans_to', { literal: 'a team offsite in Porto in June' }, "We're planning a team offsite in Porto in June", { modality: 'intent', minutesAgo: 900000 });
        await w.flood('You', 'plans_to', BIG);
        return incoming('You', 'rejected', { literal: 'Porto offsite' }, 'We cancelled the Porto offsite'); },
      async w => { await w.claim('Ines', 'role_is', { literal: 'leads design' }, 'Ines leads design', { minutesAgo: 900000 });
        await w.flood('Ines', 'role_is', BIG);
        return incoming('Ines', 'task_owner', { literal: 'design' }, 'Rui has taken over design from Ines', { polarity: 'negated', revises: true }); },
    ];
    for (const build of cases) {
      const w = await world();
      const c = await build(w);
      const { full } = await same(w.owner, [c]);
      assert.equal(full.contradictions.length, 1, JSON.stringify(full));
    }
  });

  test('role handover, one-per-object ownership, blocker resolution — under a flood', async () => {
    const cases = [
      async w => { await w.claim('Sam Patel', 'related_to', { literal: 'mentor' }, 'My mentor is Sam Patel', { minutesAgo: 900000 });
        await w.flood('You', 'related_to', BIG);
        return incoming('Lena Okafor', 'related_to', { literal: 'mentor' }, 'My mentor is now Lena Okafor', { revises: true }); },
      async w => { await w.claim('Kavya', 'owns', { entity: 'payment integration' }, 'Kavya owns the payment integration', { minutesAgo: 900000 });
        await w.flood('Kavya', 'owns', BIG);
        return incoming('Rohan', 'owns', { entity: 'payment integration' }, 'Rohan owns the payment integration'); },
      async w => { await w.claim('antenna supplier', 'blocks', { entity: 'drone project' }, 'The antenna supplier blocks the drone project', { minutesAgo: 900000 });
        await w.flood('antenna supplier', 'has_property', BIG);
        return incoming('antenna supplier', 'has_status', { literal: 'delivered' }, 'The antenna supplier delivered'); },
    ];
    for (const build of cases) {
      const w = await world();
      const c = await build(w);
      const { full } = await same(w.owner, [c]);
      assert.equal(full.contradictions.length, 1, `${c.statementText}: ${JSON.stringify(full)}`);
    }
  });

  test('distinct claims that merely look alike are not merged (similar text, different values)', async () => {
    const w = await world();
    await w.claim('You', 'has_property', { literal: '42 paying clinics' }, 'We have 42 paying clinics', { minutesAgo: 900000 });
    await w.flood('You', 'has_property', BIG);
    const { full } = await same(w.owner, [incoming('You', 'has_property', { literal: '42 paying clinics in Lisbon' }, 'We have 42 paying clinics in Lisbon')]);
    assert.deepEqual(full.attachments, []);
  });
});
