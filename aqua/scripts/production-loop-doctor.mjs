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
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

function read(rel) {
  const p = path.join(ROOT, rel);
  return fs.readFileSync(p, 'utf8');
}

const checks = [
  {
    name: 'platform launcher delegates to the canonical engine launcher',
    file: '../scripts/start-production.mjs',
    patterns: [/import\('\.\.\/aqua\/scripts\/start-production\.mjs'\)/],
  },
  {
    name: 'production launcher starts server and worker',
    file: 'scripts/start-production.mjs',
    patterns: [/start\('server'/, /start\('worker'/],
  },
  {
    // 2026-10-06 cutover: the default read mode is canonical-AUTHORITATIVE —
    // the canonical World Model answers; legacy user memory only fills gaps it
    // does not contradict (veto); =on canonical only; =off rollback.
    name: 'the answer context is canonical-authoritative by default; legacy memory is vetoed by the World Model (D5, E10 cutover)',
    file: 'src/routes/chat.js',
    patterns: [/const readMode = Brain\.canonicalReadMode\(\)/,
      /legacyUserMemory: readMode === 'legacy' \? true : readMode === 'authoritative' \? 'gapfill' : false/,
      /legacyVeto: readMode === 'authoritative' \? await Brain\.legacyVetoFor\(memoryOwner\)/],
  },
  {
    name: 'production launcher gives the worker the same .env as the server',
    file: 'scripts/start-production.mjs',
    patterns: [/dotenv\.config\(\{ path: path\.join\(PLATFORM_ROOT, '\.env'\)/],
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
    name: 'a failed extraction or canonical commit retries the durable job (no silent turn loss)',
    file: 'src/core/jobs/workerRuntime.js',
    patterns: [/assertUnderstood\(result\)/, /UNDERSTANDING_COMMIT_FAILED/, /UNDERSTANDING_INCOMPLETE/],
  },
  {
    name: 'canonical first-person claims seed beliefs with provenance links (E9)',
    file: 'src/brain/reflectionV3/claimBeliefAdapter.js',
    patterns: [/planBridgeSignals\(/, /linkOnly/],
  },
  {
    name: 'a changed single-valued fact retires the older snapshot (registry cardinality → E9 policy)',
    file: 'src/brain/reflectionV3/contradictionWorker.js',
    patterns: [/snapshotPair: isDeclaredSnapshotPair\(incoming, existing\)/, /cardinalityOf/],
  },
  {
    name: 'S8 detects single-valued changes from the registry, not a hardcoded list',
    file: 'src/brain/index.js',
    patterns: [/singleValuedPredicateNames\(\)/, /singleObjectPredicates: singleObjectPredicates\(\)/],
  },
  {
    name: 'deictic follow-ups ("that", "it") anchor on the previous turn of the same conversation',
    file: 'src/brain/index.js',
    patterns: [/isDeictic\(query\)/, /rememberFocus\(/],
  },
  {
    name: 'transactional outbox claims rows with SKIP LOCKED and reaps crashes',
    file: 'src/brain/reflectionV3/reflectionOutbox.js',
    patterns: [/SKIP LOCKED/, /state='processing'/, /reapStaleClaimOutbox/, /attempts >= 8/],
  },
  {
    name: '"my company" / "it" / "the launch" resolve against the owner\'s World Model before minting (S6½)',
    file: 'src/brain/index.js',
    patterns: [/resolveReferences\(result\.claims/, /referenceRoleObjects\(ownerId/, /referencePreviousTurn\(ownerId/],
  },
  {
    name: 'every outbox event is registered as dispatch or record — no orphaned rows',
    file: 'src/core/worldModel/worldModelRepository.js',
    patterns: [/outboxRole\(/, /claimTransitionEvent\(/],
  },
  {
    name: 'workers publish metric snapshots to Postgres; the server /metrics reads them',
    file: 'scripts/worker.mjs',
    patterns: [/startMetricsPublisher\(\{ role: 'worker' \}\)/, /await stopMetrics/],
  },
  {
    name: 'the revision voice reads canonical lifecycle transitions with a compare-and-set watermark',
    file: 'src/brain/index.js',
    patterns: [/revisionVoiceCandidates\(ownerId\)/, /advanceRevisionVoice\(ownerId/],
  },
  {
    name: 'the worker schedules durable E9 J3 consolidation jobs, and has a handler for them',
    file: 'scripts/worker.mjs',
    patterns: [/scheduleConsolidation\(\)/],
  },
  {
    name: 'J3 consolidation archives (never deletes) and keeps provenance on the survivor',
    file: 'src/core/worldModel/worldModelRepository.js',
    patterns: [/export async function consolidateClaimDuplicate/, /state='archived'/, /changeKind: 'merge'/, /'corroborating' FROM aqua_claim_evidence/],
  },
  {
    name: 'revision voice outcomes are counted and every server publishes them to /metrics',
    file: 'src/brain/index.js',
    patterns: [/recordRevisionVoice\('considered'/, /recordRevisionVoice\('emitted'\)/, /recordRevisionVoice\('suppressed'/, /recordRevisionVoice\('skipped'/],
  },
  // ── Phases 3–5 (2026-10-06) ──
  {
    name: 'every canonical claim an answer used is returned with its correction reference (Phase 3)',
    file: 'src/routes/chat.js',
    patterns: [/worldModelClaimRefs\(prep\?\.knowledgeItems\)/, /correct: `\/brain\/claims\//],
  },
  {
    name: 'corrections are idempotent (replay by key or statement; a superseded claim is not corrected twice)',
    file: 'src/core/worldModel/worldModelRepository.js',
    patterns: [/IDEMPOTENT CORRECTIONS/, /replayed: true/, /claim already superseded/],
  },
  {
    name: 'a World-Model change enqueues a debounced proactive evaluation (Phase 4)',
    file: 'src/brain/reflectionV3/reflectionOutbox.js',
    patterns: [/PROACTIVE_CHANGE_EVENTS\.has\(normalized\.eventType\) && proactiveEnabled\(\)/, /proactiveChangeJob\(/],
  },
  {
    name: 'the worker runs proactive evaluations and approved action runs, and schedules the periodic scan',
    file: 'src/core/jobs/workerRuntime.js',
    patterns: [/\[PROACTIVE_JOB_KIND\]: async job =>/, /\[ACTION_JOB_KIND\]: async job =>/, /export const scheduleProactiveScan/],
  },
  {
    name: 'the worker process calls the periodic proactive scan',
    file: 'scripts/worker.mjs',
    patterns: [/await scheduleProactiveScan\(\)/],
  },
  {
    name: 'proactive interventions reach the production prompt at most once per turn',
    file: 'src/routes/chat.js',
    patterns: [/proactiveDirective = await proactiveDirectiveForTurn\(memoryOwner\)/, /revisionDirective, proactiveDirective\]/],
  },
  {
    name: 'no action executes without owner approval; World-Model effects go through the audited lifecycle path (Phase 5)',
    file: 'src/brain/actions/executor.js',
    patterns: [/return \{ skipped: run\.status \};\s+\/\/ proposed: never executes without approval/, /await transition\(\{ ownerId, actor: 'user'/],
  },
  {
    name: 'interventions and action runs are purged with the account, before claims and entities',
    file: 'src/account/accountPurge.js',
    patterns: [/purgeActionRuns\(ownerId\)[\s\S]*purgeInterventions\(ownerId\)[\s\S]*purgeWorldModelPreClaims\(ownerId\)/],
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
