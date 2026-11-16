/**
 * AQUA — structured job lifecycle log (scalability Phase 3)
 *
 * One JSON line per lifecycle event, prefixed `[JOB] ` so it can be grepped
 * out of mixed output and parsed:
 *
 *   enqueued · claimed · done · skipped · retry · dead · failed · released ·
 *   lost · unrecorded · reclaimed
 *
 * Fields: evt, phase, jobId, kind, owner (a per-process HMAC hash, never the
 * account id), attempt, and timings when known (queueWaitMs, runMs, retryInMs,
 * enqueueMs). Never message text: payloads are not logged at all, and error
 * strings are truncated. AQUA_JOB_LOG=off silences it.
 */
import { hashOwner } from '../spanAttributes.js';

const enabled = () => String(process.env.AQUA_JOB_LOG ?? 'on').toLowerCase() !== 'off';

export function logJobEvent(phase, job, fields = {}) {
  if (!enabled()) return;
  try {
    const line = {
      evt: 'job', phase, t: new Date().toISOString(),
      jobId: job?.jobId ?? null, kind: job?.kind ?? null,
      owner: job?.ownerId ? hashOwner(job.ownerId) : null,
      attempt: job?.attempts ?? null,
      pid: process.pid,
      ...fields,
    };
    if (typeof line.error === 'string') line.error = line.error.slice(0, 300);
    console.log(`[JOB] ${JSON.stringify(line)}`);
  } catch { /* logging must never affect a job */ }
}
