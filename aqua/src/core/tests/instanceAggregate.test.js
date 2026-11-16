/**
 * Instance-partitioned aggregates (scalability Phase 2b, step 5) against a REAL
 * Postgres. Skipped loudly without one.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { addAggregates, createInstanceAggregate, BASE_KEY } from '../storage/instanceAggregate.js';
import { createPartitionRepository, TABLE } from '../storage/partitionRepository.js';

const LIVE = Boolean(process.env.DATABASE_URL);
const skip = LIVE ? false : 'DATABASE_URL is not set — this needs a live Postgres';
const RUN = crypto.randomBytes(4).toString('hex');
const store = name => `.test-${RUN}-agg-${name}.json`;
let pg, pool;

before(async () => {
  if (!LIVE) return;
  pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
  await (await import('../db/migrate.js')).migrate();
});
after(async () => {
  if (!LIVE) return;
  await pool.query(`DELETE FROM ${TABLE} WHERE store_key LIKE $1`, [`.test-${RUN}-%`]);
  await pool.end();
  await (await import('../db/pool.js')).closePool();
});

const inst = (s, id, extra = {}) => createInstanceAggregate({
  storeKey: s, instanceId: id, repo: createPartitionRepository({ pool, instanceId: id }), ...extra });
const turn = a => a.record(c => { c.chat = c.chat ?? { turns: 0 }; c.chat.turns += 1; });

describe('addAggregates — pure', () => {
  const a = { chat: { turns: 3, reflected: 3, effectivenessEwma: 0.9, lastAt: '2026-11-01' } };
  const b = { chat: { turns: 1, reflected: 1, effectivenessEwma: 0.5, lastAt: '2026-11-05' } };
  const c = { chat: { turns: 4, reflected: 4, effectivenessEwma: 0.2 }, code: { turns: 2 } };
  test('counters sum, EWMAs combine weighted by samples, timestamps take the later', () => {
    const m = addAggregates(a, b);
    assert.equal(m.chat.turns, 4);
    assert.equal(m.chat.reflected, 4);
    assert.ok(Math.abs(m.chat.effectivenessEwma - 0.8) < 1e-9);
    assert.equal(m.chat.lastAt, '2026-11-05');
  });
  test('commutative and associative: the order rows are read in does not matter', () => {
    assert.deepEqual(addAggregates(a, b), addAggregates(b, a));
    const l = addAggregates(addAggregates(a, b), c);
    const r = addAggregates(a, addAggregates(b, c));
    assert.equal(l.chat.turns, r.chat.turns);
    assert.ok(Math.abs(l.chat.effectivenessEwma - r.chat.effectivenessEwma) < 1e-9);
    assert.deepEqual(l.code, r.code);
  });
});

describe('instance aggregates — against Postgres', { skip }, () => {
  test('many instances publish at once: exact totals, no contention on a shared row', async () => {
    const S = store('many');
    const N = 16; const ROUNDS = 10; const PER = 5;
    const instances = Array.from({ length: N }, (_, i) => inst(S, `i${i}`));
    const lat = [];
    await Promise.all(instances.map(async a => {
      for (let r = 0; r < ROUNDS; r++) {
        for (let k = 0; k < PER; k++) turn(a);
        const t0 = performance.now();
        await a.publish();
        lat.push(performance.now() - t0);
      }
    }));
    const { total, instances: rows } = await instances[0].read();
    assert.equal(total.chat.turns, N * ROUNDS * PER);
    assert.equal(rows, N);
    lat.sort((x, y) => x - y);
    const p99 = lat[Math.floor(lat.length * 0.99)];
    assert.ok(p99 < 1_000, `p99 publish ${p99.toFixed(1)}ms`);
    console.log(`[instance-aggregate] ${N} instances x ${ROUNDS} publishes: p50=${lat[Math.floor(lat.length / 2)].toFixed(1)}ms p99=${p99.toFixed(1)}ms`);
  });

  test('two instances fold the same expired rows at once: counted exactly once', async () => {
    const S = store('fold');
    for (let i = 0; i < 5; i++) { const a = inst(S, `gone${i}`); for (let k = 0; k < 3; k++) turn(a); await a.publish(1_000); }
    const live = inst(S, 'live'); turn(live); await live.publish();
    const [f1, f2] = [inst(S, 'folder1', { ttlMs: 60_000 }), inst(S, 'folder2', { ttlMs: 60_000 })];
    const [r1, r2] = await Promise.all([f1.fold(), f2.fold()]);
    assert.equal(r1.folded + r2.folded, 5, 'each expired row folded by exactly one folder');
    const { total, instances } = await live.read();
    assert.equal(total.chat.turns, 5 * 3 + 1);
    assert.equal(instances, 1, 'only the live instance row remains');
    const base = (await pool.query(`SELECT data FROM ${TABLE} WHERE store_key=$1 AND partition_key=$2`, [S, BASE_KEY])).rows[0];
    assert.equal(JSON.parse(base.data).chat.turns, 15);
  });

  test('an instance folded while it was only slow publishes again without double counting', async () => {
    const S = store('late');
    const slow = inst(S, 'slow');
    for (let k = 0; k < 4; k++) turn(slow);
    await slow.publish(1_000);                       // looks expired
    await inst(S, 'folder', { ttlMs: 60_000 }).fold();
    for (let k = 0; k < 2; k++) turn(slow);
    const r = await slow.publish();
    assert.equal(r.generation, 1, 'moved to a new row');
    const { total } = await slow.read();
    assert.equal(total.chat.turns, 6);
  });

  test('a publish whose acknowledgement was lost is not applied twice when retried', async () => {
    const S = store('ack');
    const base = createPartitionRepository({ pool, instanceId: 'flaky' });
    let failOnce = true;
    const flaky = { ...base, update: async (...args) => {
      const r = await base.update(...args);
      if (failOnce) { failOnce = false; throw new Error('connection reset after commit'); }
      return r;
    } };
    const a = createInstanceAggregate({ storeKey: S, instanceId: 'flaky', repo: flaky });
    for (let k = 0; k < 3; k++) turn(a);
    await assert.rejects(a.publish(), /connection reset/);
    turn(a);
    await a.publish();                               // re-sends the unknown one with the SAME seq, then the new one
    const { total } = await a.read();
    assert.equal(total.chat.turns, 4);
    assert.equal(a.stats().deduplicated, 1);
  });

  test('an idle but live instance keeps its row alive with heartbeats', async () => {
    const S = store('hb');
    const a = inst(S, 'idle');
    turn(a);
    await a.publish(1_000);
    await a.publish();                               // nothing new: heartbeat only
    const r = await inst(S, 'folder', { ttlMs: 60_000 }).fold();
    assert.equal(r.folded, 0);
  });
});
