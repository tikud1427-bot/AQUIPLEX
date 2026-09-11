/**
 * AQUA — a reusable bounded parse session
 * Blueprint E1/PR-4b · closes the gap E1/PR-4 declared
 *
 * THE GAP, AND WHY IT WAS LEFT OPEN
 * ---------------------------------
 * E1/PR-4 put document parsing behind a heap-capped worker at three call
 * sites and deliberately did NOT bound the fourth: `fileIngester.ingestFiles`
 * parses every document in a workspace upload in a LOOP, and a one-shot worker
 * costs ~250 ms of spawn each time.
 *
 * Measured, on 20 documents:
 *
 *   inline, unbounded (today)          76 ms
 *   one-shot worker per file           6275 ms      ← 82× slower
 *
 * That is not a tax anyone would accept, so the gap was recorded as an
 * inverting test rather than closed badly. This closes it: the worker is
 * spawned ONCE per batch and reused, so the spawn is amortised over N files
 * instead of paid N times.
 *
 * WHAT A LONG-LIVED WORKER MUST GET RIGHT THAT A ONE-SHOT DOES NOT
 * ----------------------------------------------------------------
 *   respawn        A one-shot worker that dies takes one parse with it. A
 *                  SESSION that dies would take the whole batch — so a death
 *                  rejects only the in-flight request and the next file gets
 *                  a fresh worker. `ingestFiles` already promises "one bad
 *                  document can't fail an entire batch upload"; this keeps it.
 *
 *   no state bleed The worker holds no state between requests by
 *                  construction: every parse re-imports nothing and returns a
 *                  value. That matters because a session carries one user's
 *                  document after another, and a parser that remembered
 *                  anything would be a cross-document leak nobody would spot.
 *
 *   per-request    The deadline and the memory watchdog apply to EACH parse,
 *   limits         not to the session. A session-wide budget would let file 1
 *                  spend the allowance and make file 2 look like the culprit.
 *
 * The ceilings themselves are E1/PR-4's, unchanged and imported rather than
 * copied — two definitions of "too big" would drift.
 */
import { Worker } from 'node:worker_threads';

import { PARSE_LIMITS, ParseLimitError, isWorkerEnabled } from './boundedParse.js';

const WORKER_URL = new URL('./parseSessionWorker.js', import.meta.url);

export function createParseSession({ limits = PARSE_LIMITS, workerUrl = WORKER_URL } = {}) {
  let worker = null;
  let nextId = 1;
  /** id → { resolve, reject, timer } */
  const inFlight = new Map();
  let respawns = 0;
  let parses = 0;
  let closed = false;

  const settle = (id, fn, value) => {
    const entry = inFlight.get(id);
    if (!entry) return;
    inFlight.delete(id);
    clearTimeout(entry.timer);
    fn(value);
  };

  /**
   * A dead worker rejects every in-flight request and is dropped.
   *
   * Dropping rather than immediately respawning is deliberate: the next
   * request spawns a fresh one lazily, so a session that is never used again
   * does not leave a thread behind.
   */
  const onDeath = (reason) => {
    worker = null;
    for (const id of [...inFlight.keys()]) {
      settle(id, inFlight.get(id)?.reject ?? (() => {}), reason);
    }
  };

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(workerUrl, {
      resourceLimits: {
        maxOldGenerationSizeMb: limits.MAX_HEAP_MB,
        maxYoungGenerationSizeMb: limits.MAX_YOUNG_MB,
      },
    });
    worker.on('message', (msg) => {
      const entry = inFlight.get(msg?.id);
      if (!entry) return;
      if (msg.ok) settle(msg.id, entry.resolve, msg.value);
      else settle(msg.id, entry.reject, reviveError(msg.error));
    });
    worker.on('error', (err) => {
      const oom = err?.code === 'ERR_WORKER_OUT_OF_MEMORY' || /out of memory/i.test(err?.message ?? '');
      respawns++;
      onDeath(oom
        ? new ParseLimitError(
          `A document needed more than ${limits.MAX_HEAP_MB} MB to parse and was stopped. ` +
          'It is unusually large or malformed.', { limit: 'memory' })
        : err);
    });
    worker.on('exit', (code) => {
      if (code === 0 && inFlight.size === 0) { worker = null; return; }
      respawns++;
      onDeath(new ParseLimitError(
        `The parser stopped unexpectedly (exit ${code}).`, { limit: 'exit' }));
    });
    return worker;
  }

  return {
    /**
     * Parse one document. Bounded per request, not per session.
     *
     * @param {'parseDocument'} op
     * @param {object} args
     * @param {Function} inline  used only when the worker is DISABLED or
     *                           cannot start — never to retry a limit breach.
     */
    async run(op, args, { inline, label = 'Document' } = {}) {
      if (closed) throw new Error('parse session is closed');
      if (!isWorkerEnabled()) return inline();

      let w;
      try {
        w = ensureWorker();
      } catch (err) {
        // Infrastructure, not input — same split as E1/PR-4. Refusing every
        // upload because the thread pool is unhappy trades a real outage for
        // a hypothetical attack.
        console.warn(`[PARSE] session worker unavailable (${err.message}) — parsing inline`);
        return inline();
      }

      const id = nextId++;
      parses++;
      const rssBaseline = process.memoryUsage.rss();

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          // A hung parse must not wedge the session for every file after it,
          // so the worker is destroyed and the next request gets a fresh one.
          settle(id, reject, new ParseLimitError(
            `${label} took longer than ${limits.TIMEOUT_MS / 1000}s to parse and was stopped.`,
            { limit: 'timeout' }));
          try { worker?.terminate(); } catch { /* already gone */ }
          worker = null;
        }, limits.TIMEOUT_MS);

        // External memory is invisible to the V8 heap cap (E1/PR-4's finding),
        // so RSS growth is sampled per request.
        const rssTimer = limits.MAX_RSS_GROWTH_MB ? setInterval(() => {
          const grown = (process.memoryUsage.rss() - rssBaseline) / 1e6;
          if (grown > limits.MAX_RSS_GROWTH_MB) {
            settle(id, reject, new ParseLimitError(
              `${label} grew past the ${limits.MAX_RSS_GROWTH_MB} MB parse budget and was stopped.`,
              { limit: 'rss' }));
            try { worker?.terminate(); } catch { /* already gone */ }
            worker = null;
          }
        }, limits.RSS_POLL_MS ?? 200) : null;
        rssTimer?.unref?.();

        inFlight.set(id, {
          resolve: (v) => { clearInterval(rssTimer); resolve(v); },
          reject: (e) => { clearInterval(rssTimer); reject(e); },
          timer,
        });
        w.postMessage({ id, op, args });
      });
    },

    stats() { return { parses, respawns, alive: worker !== null, inFlight: inFlight.size }; },

    /**
     * Tests only — kill the worker the way an OOM would, and wait for the
     * death handler to run.
     *
     * A seam rather than a mock, because recovery is only meaningful if the
     * REAL death path runs: the handler, the drop, and the lazy respawn on the
     * next request.
     */
    async killWorkerForTests() {
      const w = worker;
      if (!w) return false;
      await w.terminate();
      await new Promise(r => setImmediate(r));
      return true;
    },

    /** Always call this. A session that is never closed leaves a thread alive. */
    async close() {
      closed = true;
      const w = worker;
      worker = null;
      if (w) { try { await w.terminate(); } catch { /* already gone */ } }
    },
  };
}

function reviveError(e) {
  const err = new Error(e?.message ?? 'Parse failed');
  err.name = e?.name ?? 'Error';
  if (e?.limit != null) err.limit = e.limit;
  if (e?.observed != null) err.observed = e.observed;
  return err;
}
