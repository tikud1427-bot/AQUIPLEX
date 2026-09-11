/**
 * AQUA Bounded Parse — the memory/time boundary around untrusted-byte parsing
 * Blueprint E1/PR-4
 *
 * WHAT THIS IS
 * ------------
 * A WRAPPER, not an invasion. `parseDocument`, `extractArchive` and
 * `extractZip` are untouched and still pure — every existing test still calls
 * them directly, at the same speed, and `golden.json` cannot move. Production
 * call sites switch to the `*Bounded` variants here, which run the identical
 * function inside a worker that has its own heap cap and a wall-clock deadline.
 *
 * Same shape as zipGuard: one doorway, and the thing behind it is unchanged.
 *
 * THE FALLBACK POLICY — the load-bearing decision
 * -----------------------------------------------
 * A fail-open fallback is this codebase's default habit and it is WRONG here in
 * one specific case, so the two failures are split by cause:
 *
 *   worker could not START (spawn error, platform issue, missing module)
 *       → run inline, log loudly. The input is not implicated; refusing every
 *         upload because the thread pool is unhappy trades a real outage for a
 *         hypothetical attack.
 *
 *   worker hit its MEMORY CAP or DEADLINE
 *       → REJECT the input. Never retry inline. Retrying inline is precisely
 *         the crash the worker exists to prevent, executed deliberately.
 *
 * Getting that split backwards would make this whole PR decorative.
 *
 * KILL SWITCH
 * -----------
 * AQUA_PARSE_WORKER=off runs everything inline, as before this PR. It exists
 * because a worker failure mode nobody predicted should not mean "uploads are
 * down"; it is reported in the boot line so it can never be off silently.
 */
import { Worker } from 'node:worker_threads';

const WORKER_URL = new URL('./parseWorker.js', import.meta.url);

/**
 * ⚠ MEASURED, AND IT CHANGED THIS DESIGN
 * --------------------------------------
 * `resourceLimits.maxOldGenerationSizeMb` bounds the V8 HEAP ONLY. Buffer and
 * ArrayBuffer memory is external to the heap and is NOT counted. Probed
 * directly with a 32 MB cap:
 *
 *     Array of strings (V8 heap)     → ERR_WORKER_OUT_OF_MEMORY, capped ✅
 *     Buffer.alloc (external memory) → escaped, allocated 320 MB      ❌
 *
 * Buffers are precisely what pdf-parse, adm-zip and SheetJS allocate while
 * decompressing, so the heap cap alone guards the LESS likely failure and
 * misses the more likely one. Three bounds are therefore applied together:
 *
 *   MAX_HEAP_MB      V8 heap cap — enforced by Node, hard, exact
 *   TIMEOUT_MS       wall-clock deadline — enforced by terminate(), hard
 *   MAX_RSS_GROWTH   parent-side watchdog — covers EXTERNAL memory
 *
 * The watchdog is honestly imperfect: RSS is process-wide, so under
 * concurrent parses growth is not attributable to one worker. The threshold is
 * therefore generous enough that only a genuine bomb trips it, and it is a
 * safety net rather than a precise accountant. It is still the only thing
 * standing between a decompression bomb and the process holding all state.
 *
 * 256 MB is ~4× the largest legitimate parse observed. 30 s is ~20× the
 * slowest; a document needing longer is not one a chat turn should wait on.
 */
export const PARSE_LIMITS = Object.freeze({
  MAX_HEAP_MB: 256,
  MAX_YOUNG_MB: 32,
  TIMEOUT_MS: 30_000,
  MAX_RSS_GROWTH_MB: 512,
  RSS_POLL_MS: 200,
});

export const isWorkerEnabled = () =>
  String(process.env.AQUA_PARSE_WORKER ?? 'on').toLowerCase() !== 'off';

/** Rebuild an error that crossed the thread boundary, keeping the fields callers read. */
function reviveError(e) {
  const err = new Error(e?.message ?? 'Parse failed');
  err.name = e?.name ?? 'Error';
  if (e?.limit != null) err.limit = e.limit;
  if (e?.observed != null) err.observed = e.observed;
  return err;
}

/** Thrown when the INPUT exhausted the boundary. Never retried inline. */
export class ParseLimitError extends Error {
  constructor(message, { limit, op } = {}) {
    super(message);
    this.name = 'ParseLimitError';
    this.limit = limit;
    this.op = op;
  }
}

/**
 * Run one parse op inside a bounded worker.
 *
 * @param {'parseDocument'|'extractArchive'|'extractZip'} op
 * @param {object} args
 * @param {{inline: Function, label?: string, limits?: object, workerUrl?: URL}} opts
 *        `inline` is the real function, used when the worker is disabled or
 *        cannot start. It is NEVER used to retry a limit breach.
 *        `limits` and `workerUrl` exist so the boundary itself can be tested
 *        with a worker that deliberately misbehaves — the ceilings are the
 *        thing under test and cannot be exercised with 5 KB fixtures.
 */
export async function runBounded(op, args, { inline, label = 'File', limits = PARSE_LIMITS, workerUrl = WORKER_URL }) {
  if (!isWorkerEnabled()) return inline();

  let worker;
  try {
    worker = new Worker(workerUrl, {
      workerData: { op, args },
      resourceLimits: {
        maxOldGenerationSizeMb: limits.MAX_HEAP_MB,
        maxYoungGenerationSizeMb: limits.MAX_YOUNG_MB,
      },
    });
  } catch (err) {
    // Infrastructure, not input. Degrade rather than fail the upload.
    console.warn(`[PARSE] worker unavailable (${err.message}) — parsing inline`);
    return inline();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (rssTimer) clearInterval(rssTimer);
      worker.terminate().catch(() => {});
      fn(v);
    };

    // ── External-memory watchdog ────────────────────────────────────────
    // The heap cap cannot see Buffer allocations, so RSS growth is sampled
    // while the parse is in flight. Baseline is taken AFTER the worker exists
    // so the thread's own fixed footprint is not counted against the budget.
    const rssBaseline = process.memoryUsage.rss();
    const rssTimer = limits.MAX_RSS_GROWTH_MB ? setInterval(() => {
      const grownMb = (process.memoryUsage.rss() - rssBaseline) / 1e6;
      if (grownMb > limits.MAX_RSS_GROWTH_MB) {
        finish(reject, new ParseLimitError(
          `${label} grew past the ${limits.MAX_RSS_GROWTH_MB} MB parse budget and was stopped. It is unusually large or malformed.`,
          { limit: 'rss', op },
        ));
      }
    }, limits.RSS_POLL_MS ?? 200) : null;
    rssTimer?.unref?.();

    const timer = setTimeout(() => {
      finish(reject, new ParseLimitError(
        `${label} took longer than ${limits.TIMEOUT_MS / 1000}s to parse and was stopped. It is unusually large or malformed.`,
        { limit: 'timeout', op },
      ));
    }, limits.TIMEOUT_MS);

    worker.on('message', msg => {
      if (msg?.ok) finish(resolve, msg.value);
      else finish(reject, reviveError(msg?.error));
    });

    worker.on('error', err => {
      // ERR_WORKER_OUT_OF_MEMORY is the cap doing its job: the INPUT is
      // implicated, so this is a rejection and never an inline retry.
      if (err?.code === 'ERR_WORKER_OUT_OF_MEMORY' || /out of memory/i.test(err?.message ?? '')) {
        finish(reject, new ParseLimitError(
          `${label} needed more than ${limits.MAX_HEAP_MB} MB to parse and was stopped. It is unusually large or malformed.`,
          { limit: 'memory', op },
        ));
        return;
      }
      finish(reject, err);
    });

    worker.on('exit', code => {
      if (code !== 0) {
        finish(reject, new ParseLimitError(
          `${label} could not be parsed — the parser stopped unexpectedly (exit ${code}).`,
          { limit: 'exit', op },
        ));
      } else {
        // A clean exit with no message means the worker never posted a result.
        finish(reject, new Error(`${label} could not be parsed.`));
      }
    });
  });
}

// ── Drop-in bounded variants — identical signatures to the originals ─────────

export async function parseDocumentBounded(ext, buffer) {
  const { parseDocument } = await import('../project/documentParser.js');
  return runBounded('parseDocument', { ext, buffer }, {
    inline: () => parseDocument(ext, buffer),
    label: 'Document',
  });
}

export async function extractArchiveBounded(buffer, format) {
  const { extractArchive } = await import('./archiveExtractor.js');
  return runBounded('extractArchive', { buffer, format }, {
    inline: () => extractArchive(buffer, format),
    label: 'Archive',
  });
}

export async function extractZipBounded(base64) {
  const { extractZip } = await import('../project/fileIngester.js');
  return runBounded('extractZip', { base64 }, {
    inline: () => extractZip(base64),
    label: 'Archive',
  });
}
