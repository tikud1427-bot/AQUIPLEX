#!/usr/bin/env node
/**
 * AQUIPLEX — production intelligence loop doctor.
 *
 * Static gate for the code-level closed loop. It intentionally does not claim
 * database health; run `npm run db:status` separately for live substrate state.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');

function read(rel) {
  const p = path.join(ROOT, rel);
  return fs.readFileSync(p, 'utf8');
}

const checks = [
  {
    name: 'production launcher starts server and worker',
    file: '../scripts/start-production.mjs',
    patterns: [/start\('server'/, /start\('worker'/],
  },
  {
    name: 'post-turn schedules durable understanding',
    file: 'src/routes/turnPostProcess.js',
    patterns: [/understanding\.turn\.v1/, /enqueueUnderstanding: enqueue/],
  },
  {
    name: 'worker consumes understanding jobs',
    file: 'scripts/worker.mjs',
    patterns: [/'understanding\.turn\.v1'/, /Brain\.understandTurn/],
  },
  {
    name: 'canonical E6 commit defaults on when E6 is on',
    file: 'src/brain/index.js',
    patterns: [/AQUA_E6_COMMIT \?\? \(e6Enabled\(\) \? 'on' : 'off'\)/],
  },
  {
    name: 'canonical commit emits embedding outbox',
    file: 'src/core/worldModel/worldModelRepository.js',
    patterns: [/claim\.embedding\.requested/, /aqua_claim_retrieval_bridge/],
  },
  {
    name: 'outbox dispatches reflection and embedding jobs',
    file: 'src/brain/reflectionV3/reflectionOutbox.js',
    patterns: [/claim\.reflection\.v1/, /claim\.embedding\.v1/, /dispatchPendingClaimReflections/],
  },
  {
    name: 'worker executes reflection',
    file: 'src/brain/reflectionV3/reflectionWorker.js',
    patterns: [/reflectClaimsToBeliefs/, /markReflectionEffect/],
  },
  {
    name: 'canonical retrieval prefers Postgres embeddings',
    file: 'src/brain/contextEngine/canonicalSemantic.js',
    patterns: [/scoreClaimEmbeddings/, /retrievalKeysForClaimIds/],
  },
  {
    name: 'canonical graph lane is wired into async context',
    file: 'src/brain/contextEngine/index.js',
    patterns: [/traverseGraph/, /gatherCanonicalGraphCandidates/, /canonicalClaimLoader/],
  },
  {
    name: 'claim correction supersedes history and emits durable follow-up work',
    file: 'src/core/worldModel/worldModelRepository.js',
    patterns: [/export async function correctClaim/, /state='superseded'/, /claim\.embedding\.requested/, /user-correction/],
  },
  {
    name: 'claim correction is exposed with a writable provenance ref',
    file: 'src/routes/brain.js',
    patterns: [/claims\/:id\/correct/, /ref: `\/brain\/claims\//, /correctClaim/],
  },
  {
    name: 'transactional outbox claims rows with SKIP LOCKED and reaps crashes',
    file: 'src/brain/reflectionV3/reflectionOutbox.js',
    patterns: [/SKIP LOCKED/, /state='processing'/, /reapStaleClaimOutbox/, /attempts >= 8/],
  },
];

let failed = 0;
for (const c of checks) {
  const text = read(c.file);
  const ok = c.patterns.every(re => re.test(text));
  console.log(`${ok ? '✓' : '✗'} ${c.name}`);
  if (!ok) failed += 1;
}

console.log(`\n[PRODUCTION-LOOP] ${checks.length - failed}/${checks.length} static checks passed`);
if (failed) process.exit(1);
console.log('[PRODUCTION-LOOP] Code-level loop is wired: turn → durable understanding → canonical commit → outbox → embeddings/reflection → canonical retrieval.');
console.log('[PRODUCTION-LOOP] Live closure still requires database migration/status, worker uptime, and longitudinal E2E evaluation.');
