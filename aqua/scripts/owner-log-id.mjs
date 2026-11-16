#!/usr/bin/env node
/**
 * Owner id → the pseudonym its log lines carry (core/logSafety.js ownerLogId).
 *
 *   AQUA_LOG_PSEUDONYM_KEY=… node scripts/owner-log-id.mjs user:<accountId> [more ids…]
 *
 * Support uses it to find one user's [RECALL] / [PIC] / [SENSITIVE] lines: run it
 * with the SAME key the services run with, then search the logs for the o_… value.
 * Refuses without a stable key — a per-process pseudonym would match nothing.
 * Prints only the pseudonyms, one per line, in argument order.
 */
import { ownerLogId } from '../src/core/logSafety.js';

const ids = process.argv.slice(2).filter(Boolean);
if (!ids.length) {
  console.error('usage: AQUA_LOG_PSEUDONYM_KEY=<secret> node scripts/owner-log-id.mjs <ownerId> [ownerId…]');
  process.exit(2);
}
if (String(process.env.AQUA_LOG_PSEUDONYM_KEY ?? '').length < 32) {
  console.error('AQUA_LOG_PSEUDONYM_KEY (≥ 32 chars, the key the services use) is required: without it the pseudonym would not match any log line.');
  process.exit(2);
}
for (const id of ids) console.log(ownerLogId(id));
