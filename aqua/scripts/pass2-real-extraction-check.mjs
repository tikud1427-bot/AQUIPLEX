#!/usr/bin/env node
/**
 * Pass 2 (2026-10-11) — the state-correctness loops with the REAL extractor.
 *
 *   AQUA_TEST_DATABASE_URL=… node scripts/pass2-real-extraction-check.mjs [--provider nvidia --model openai/gpt-oss-20b]
 *
 * Each scenario is a fresh owner: its turns are enqueued exactly as
 * turnPostProcess enqueues them and drained by the production worker's handler
 * table (real E6 extraction, S5–S9, outbox, contradiction worker). Then the
 * canonical state and the production answer context are printed and checked.
 * Writes only to AQUA_TEST_DATABASE_URL; purges its owners at the end.
 */
import '../eval/core/isolateDataDir.mjs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testUrl = String(process.env.AQUA_TEST_DATABASE_URL ?? '').trim();
if (!testUrl) { console.error('AQUA_TEST_DATABASE_URL is required'); process.exit(2); }
process.env.DATABASE_URL = testUrl;
process.env.MONGO_URI = '';
const envPath = path.join(ROOT, '..', '.env');
if (existsSync(envPath)) createRequire(path.join(ROOT, 'package.json'))('dotenv').config({ path: envPath, quiet: true });
Object.assign(process.env, { AQUA_E6: 'on', AQUA_CONTEXT_V2: 'on', AQUA_RETRIEVAL_V3: 'on', AQUA_SELF_ENTITY: 'on' });
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i < 0 ? d : argv[i + 1]; };
process.env.AQUA_E6_PROVIDER = flag('--provider', process.env.AQUA_E6_PROVIDER ?? 'nvidia');
process.env.AQUA_E6_MODEL = flag('--model', process.env.AQUA_E6_MODEL ?? 'openai/gpt-oss-20b');

const R = await import('../eval/lift/liftRuntime.mjs');
const { getPool, closePool } = await import('../src/core/db/pool.js');
const { purgeOwnerData } = await import('../src/account/accountPurge.js');

const run = `${Date.now().toString(36)}`;
const SCENARIOS = [
  { id: 'future-role', turns: ['My team lead is Oren Katz.', 'From next month my team lead will be Dalia Mor.'],
    ask: 'Who is my team lead right now, and who will it be next month?',
    expect: { current: /Oren Katz/, scheduled: /Dalia Mor[^\n]*scheduled/ } },
  { id: 'resolved-blocker', turns: ["The kitchen permit is blocked because the city inspector hasn't visited yet.", 'Good news: the city inspector visited this morning and signed off.'],
    ask: "What's holding up the kitchen permit now?",
    expect: { notCurrent: /kitchen permit is blocked by[^\n]*inspector(?![^\n]*no longer current)/i } },
  { id: 'renamed-event', turns: ["We're launching the ceramic planter line on May 4.", 'Actually the planter launch moved to May 18.'],
    ask: 'When is the planter launch?',
    expect: { current: /May 18/ } },
];

const results = [];
for (const sc of SCENARIOS) {
  const ownerId = `user:p2real-${run}-${sc.id}`;
  await R.ingestTurns(ownerId, `p2real-${run}-${sc.id}`, sc.turns.map((text, i) => ({ turn: i + 1, text })), { runId: run, log: () => {} });
  const pool = await getPool();
  const claims = (await pool.query(
    `SELECT c.state, c.predicate, c.polarity, c.valid_from, c.valid_to, se.canonical_label AS subj,
            COALESCE(oe.canonical_label, c.object_literal) AS obj, c.statement_text
       FROM aqua_claims c JOIN aqua_entities se ON se.owner_id=c.owner_id AND se.entity_id=c.subject_entity_id
       LEFT JOIN aqua_entities oe ON oe.owner_id=c.owner_id AND oe.entity_id=c.object_entity_id
      WHERE c.owner_id=$1 ORDER BY c.asserted_at`, [ownerId])).rows;
  const ctx = await R.worldModelContext(ownerId, sc.ask);
  const checks = Object.entries(sc.expect).map(([k, re]) => {
    const pass = k === 'notCurrent' ? !re.test(ctx.block) : re.test(ctx.block);
    return { check: k, pass };
  });
  console.log(`\n=== ${sc.id}`);
  for (const c of claims) console.log(`  ${c.state.padEnd(10)} ${c.polarity === 'negated' ? 'NOT ' : ''}${c.subj} | ${c.predicate} | ${c.obj}  from=${c.valid_from?.toISOString?.() ?? '-'} to=${c.valid_to?.toISOString?.() ?? '-'}`);
  console.log(ctx.block.split('\n').filter(l => l.startsWith('•')).map(l => `  ctx ${l}`).join('\n'));
  for (const c of checks) console.log(`  CHECK ${c.check}: ${c.pass ? 'PASS' : 'FAIL'}`);
  results.push({ id: sc.id, checks });
  await purgeOwnerData({ userId: ownerId.slice(5) });
}
const failed = results.flatMap(r => r.checks.filter(c => !c.pass).map(c => `${r.id}:${c.check}`));
console.log(`\n${failed.length ? `FAILED: ${failed.join(', ')}` : 'ALL CHECKS PASS'}`);
await closePool();
process.exit(failed.length ? 1 : 0);
