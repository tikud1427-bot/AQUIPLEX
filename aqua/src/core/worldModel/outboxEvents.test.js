/**
 * No orphaned outbox events (2026-10-04): every type the code emits is
 * classified; every 'dispatch' type has a consumer and every consumed type is
 * 'dispatch'; record events are never left pending; a disputed claim reaches
 * Reflection. Live half skips visibly without AQUA_TEST_DATABASE_URL.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTBOX_EVENTS, dispatchEventTypes, outboxRole, claimTransitionEvent } from './outboxEvents.js';
import { CONSUMED_EVENT_TYPES } from '../../brain/reflectionV3/reflectionOutbox.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('registry', () => {
  test('every event type the source emits is classified', () => {
    const emitted = new Set();
    const walk = dir => {
      for (const name of readdirSync(dir)) {
        if (name === 'tests' || name.startsWith('.') || name.endsWith('.test.js')) continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!name.endsWith('.js')) continue;
        const src = readFileSync(full, 'utf8');
        if (!/outbox\(client/.test(src)) continue;
        for (const m of src.matchAll(/eventType:\s*'([a-z.-]+)'/g)) emitted.add(m[1]);
        for (const m of src.matchAll(/created \? '([a-z.-]+)' : '([a-z.-]+)'/g)) { emitted.add(m[1]); emitted.add(m[2]); }
      }
    };
    walk(SRC);
    for (const s of ['superseded', 'disputed', 'stale', 'archived', 'active']) emitted.add(claimTransitionEvent(s));
    const unclassified = [...emitted].filter(t => !OUTBOX_EVENTS[t]);
    assert.deepEqual(unclassified, [], `emitted but unclassified: ${unclassified.join(', ')}`);
    assert.ok(emitted.size >= 10, `scan found only ${emitted.size} types — the scan is broken`);
  });

  test("'dispatch' types are exactly what the consumer handles", () => {
    assert.deepEqual([...CONSUMED_EVENT_TYPES].sort(), dispatchEventTypes().sort());
  });

  test('an unregistered type is refused at write time', () => {
    assert.throws(() => outboxRole('claim.something.new'), /not registered/);
  });

  test('claim lifecycle transitions map to the events Reflection consumes', () => {
    assert.equal(claimTransitionEvent('disputed'), 'claim.contradicted');
    assert.equal(claimTransitionEvent('stale'), 'claim.stale');
    assert.equal(claimTransitionEvent('superseded'), 'claim.superseded');
    assert.equal(claimTransitionEvent('archived'), 'world-model.lifecycle');
  });
});

const { isConfigured, getPool, closePool } = await import('../db/pool.js');
const LIVE = isConfigured();
const skip = LIVE ? false : 'needs a live migrated Postgres — set AQUA_TEST_DATABASE_URL';
after(async () => { if (LIVE) await closePool(); });

describe('live', { skip }, () => {
  test('record events are written published; a disputed claim emits claim.contradicted for Reflection', async () => {
    const W = await import('./worldModelRepository.js');
    const owner = `outbox-${Date.now().toString(36)}`;
    const p = await getPool();
    const e = await W.upsertEntity({ ownerId: owner, type: 'concept', canonicalLabel: 'Ledger', actor: 'test' });
    const pending = async type => (await p.query(
      `SELECT count(*)::int n FROM aqua_outbox WHERE owner_id=$1 AND event_type=$2 AND state='pending'`, [owner, type])).rows[0].n;
    assert.equal(await pending('entity.created'), 0, 'a record event was left pending');
    assert.ok((await p.query(`SELECT count(*)::int n FROM aqua_outbox WHERE owner_id=$1 AND event_type='entity.created' AND state='published'`, [owner])).rows[0].n >= 1);

    const { rows: [c] } = await p.query(
      `INSERT INTO aqua_claims (claim_id, owner_id, subject_entity_id, predicate, object_literal, polarity, modality,
         asserted_at, state, confidence_extraction, confidence_source, confidence_corroboration, extractor, extractor_version,
         actor, statement_text, statement_norm)
       VALUES (gen_random_uuid(), $1, $2, 'has_status', 'live', 'asserted', 'fact', now(), 'active', 0.6, 0.6, 0, 'test', 'v1',
         'test', 'Ledger is live', 'ledger is live') RETURNING claim_id`, [owner, e.entityId ?? e.entity_id ?? e.id]);
    await W.transition({ ownerId: owner, targetKind: 'claim', targetId: c.claim_id, toState: 'disputed', reason: 'test', actor: 'test' });
    const { rows } = await p.query(
      `SELECT payload FROM aqua_outbox WHERE owner_id=$1 AND event_type='claim.contradicted' AND state='pending'`, [owner]);
    assert.equal(rows.length, 1, 'the disputed transition did not reach the reflection consumer');
    assert.equal(rows[0].payload.nextState, 'disputed');
    assert.equal(rows[0].payload.claimId, c.claim_id);
    await p.query('DELETE FROM aqua_outbox WHERE owner_id=$1', [owner]);
  });
});
