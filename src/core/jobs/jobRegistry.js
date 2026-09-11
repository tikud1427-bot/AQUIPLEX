/**
 * AQUA — the deferred job registry
 * Blueprint E4/PR-1 · L13 (no dark stages)
 *
 * THE MEASURED PROBLEM
 * --------------------
 * Post-turn understanding work — Mind post-turn, world-model ingest, the
 * Digital Twin, cadence-gated reflection — runs behind a bare `setImmediate`.
 * It is fire-and-forget by design, so a chat turn never waits on it.
 *
 * Measured: on SIGTERM, **3 of 3 outstanding jobs were lost, and nothing knew
 * they were outstanding.** The E3 drain already awaits the debounced writers,
 * the Mongo mirror and the storage adapter — but deferred work is invisible to
 * it, because nothing tracks it.
 *
 * Every deploy therefore discards the understanding side-effects of whatever
 * turns were in flight. The user got their answer, so from their side it
 * worked; AQUA just quietly learned nothing from that conversation.
 *
 * WHAT THIS PR DOES, AND WHAT IT DELIBERATELY DOES NOT
 * ----------------------------------------------------
 * It makes outstanding work **visible and drainable**. That is all.
 *
 *   no queue        A queue implies ordering guarantees and backpressure
 *                   policy, and neither is needed to stop losing work on
 *                   shutdown. Adding them here would be two risky things at
 *                   once — the ordering rule E3 followed.
 *   no persistence  An outbox that survives a crash is E4/PR-3. This survives
 *                   a DEPLOY, which is the common case and the cheap one.
 *   no retry        A retry policy needs a failure taxonomy to be anything
 *                   other than "try twice and hope". E4/PR-2.
 *
 * FAIL-OPEN IS PRESERVED EXACTLY
 * ------------------------------
 * `runPostTurn` already promises that every subsystem failing at once still
 * never reaches the caller, and there is a test for it. A registry that let a
 * job rejection escape would break that promise while claiming to improve
 * reliability.
 */

/** name → Set of in-flight promises. Named so the drain report is readable. */
const inFlight = new Map();
let completed = 0;
let failed = 0;
let lost = 0;

/**
 * Run work after the current turn, tracked.
 *
 * A drop-in replacement for `setImmediate(fn)` — same deferral, same
 * fail-open, plus the registry knows the work exists.
 */
export function defer(name, fn) {
  let settle;
  const tracked = new Promise(resolve => { settle = resolve; });

  if (!inFlight.has(name)) inFlight.set(name, new Set());
  inFlight.get(name).add(tracked);

  setImmediate(async () => {
    try {
      await fn();
      completed++;
    } catch (err) {
      // Swallowed, exactly as the bare setImmediate did. The COUNT is the
      // improvement: a failure that is invisible cannot be investigated, and
      // this path has been silently swallowing them since it was written.
      failed++;
      console.error(`[JOBS] ${name} failed: ${err?.message ?? err}`);
    } finally {
      const set = inFlight.get(name);
      set?.delete(tracked);
      if (set && set.size === 0) inFlight.delete(name);
      settle();
    }
  });

  return tracked;
}

/** What is outstanding right now, by name. Cheap; safe to call anywhere. */
export function outstanding() {
  const byName = {};
  let total = 0;
  for (const [name, set] of inFlight) { byName[name] = set.size; total += set.size; }
  return { total, byName };
}

export function jobStats() {
  return { completed, failed, lost, ...outstanding() };
}

/**
 * Await outstanding work, with a hard ceiling.
 *
 * The ceiling is not optional. A deploy has a finite window — the platform
 * sends SIGKILL after its own grace period regardless — so a drain that waited
 * indefinitely would be killed mid-write and lose MORE than it saved.
 *
 * On timeout it reports what was still running rather than pretending success.
 * "Drained" and "gave up after 5s with 4 jobs outstanding" are different
 * facts, and a deploy log that conflates them teaches people to ignore it.
 */
export async function drainJobs(timeoutMs = 5_000) {
  const started = Date.now();
  const before = outstanding();
  if (before.total === 0) return { drained: 0, timedOut: false, durationMs: 0, outstanding: {} };

  const all = [...inFlight.values()].flatMap(set => [...set]);
  const timedOut = await Promise.race([
    Promise.allSettled(all).then(() => false),
    new Promise(resolve => setTimeout(() => resolve(true), timeoutMs)),
  ]);

  const after = outstanding();
  if (timedOut) lost += after.total;

  return {
    drained: before.total - after.total,
    timedOut,
    durationMs: Date.now() - started,
    outstanding: after.byName,
  };
}

/** One line for the shutdown log. A silent drain is indistinguishable from no drain. */
export function drainLine(result) {
  if (!result || result.drained === 0 && !result.timedOut) return '[JOBS] nothing outstanding';
  if (result.timedOut) {
    const names = Object.entries(result.outstanding).map(([n, c]) => `${n}×${c}`).join(', ');
    return `[JOBS] ⚠ drain gave up after ${result.durationMs}ms — ${names} still running and will be LOST`;
  }
  return `[JOBS] drained ${result.drained} job(s) in ${result.durationMs}ms`;
}

/** Tests only. */
export function _resetForTests() {
  inFlight.clear();
  completed = 0; failed = 0; lost = 0;
}
