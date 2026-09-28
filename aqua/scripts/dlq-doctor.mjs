#!/usr/bin/env node
/**
 * E4/PR-7 — DLQ doctor. Exit code IS the alert: 0 ok, 1 warn, 2 alert, 3 could
 * not check. Wire it to cron / a deploy gate / an uptime monitor.
 *
 *   npm run doctor:dlq            # human-readable
 *   npm run doctor:dlq -- --json  # machine-readable
 *
 * Never prints payloads or owner ids — only kinds, counts, ages and the
 * job_id an operator needs for `requeueDead` (see docs/RUNBOOK_DLQ.md).
 */
import 'dotenv/config';
import { queueStats, deadLetters } from '../src/core/jobs/jobQueue.js';
import { evaluateDlq } from '../src/core/jobs/dlqPolicy.js';

const asJson = process.argv.includes('--json');
try {
  const [stats, dead] = await Promise.all([queueStats(), deadLetters(200)]);
  const verdict = evaluateDlq({ stats, dead });
  const sample = dead.slice(0, 10).map(r => ({
    job_id: r.job_id, kind: r.kind, attempts: r.attempts,
    updated_at: r.updated_at, last_error: String(r.last_error ?? '').slice(0, 160),
  }));
  if (asJson) console.log(JSON.stringify({ stats, ...verdict, sample }));
  else {
    console.log(`DLQ ${verdict.level.toUpperCase()}  queued=${stats.queued} running=${stats.running} dead=${stats.dead}`);
    for (const r of verdict.reasons) console.log(`  - ${r}`);
    for (const r of sample) console.log(`  #${r.job_id} ${r.kind} x${r.attempts}: ${r.last_error}`);
  }
  process.exit({ ok: 0, warn: 1, alert: 2 }[verdict.level]);
} catch (e) {
  console.error(`DLQ doctor could not check: ${e.message}`);
  process.exit(3);
}
