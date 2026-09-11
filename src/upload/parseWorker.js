/**
 * AQUA Parse Worker — runs exactly one untrusted-byte parse, then exits
 * Blueprint E1/PR-4
 *
 * Loaded by boundedParse.js as a `worker_threads` Worker with a hard heap cap.
 * It exists so that a malicious or malformed document cannot take down the
 * process that holds every user's state.
 *
 * WHY A WORKER AND NOT JUST MORE CEILINGS
 * ---------------------------------------
 * E1/PR-3 bounded ZIP expansion, which is the attack we could measure. It did
 * nothing for the parsers we do not control: pdf-parse, mammoth and SheetJS
 * each allocate on shapes we cannot predict, and none of them can be bounded
 * from the outside. Nor can a ceiling stop CPU exhaustion — a pathological
 * regex inside a parser hangs the event loop with memory usage flat.
 *
 * A worker gives two properties no ceiling can:
 *   · a SEPARATE V8 heap with its own cap — an OOM kills the worker, and the
 *     parent, holding all state behind a 500 ms debounced writer, survives
 *   · a wall-clock deadline that is actually enforceable, because terminate()
 *     works on a thread that is not the one running the event loop
 *
 * ONE-SHOT, NOT POOLED
 * --------------------
 * Deliberate. A pool would amortise startup, and would also carry parser state
 * between two users' documents — a class of bug this codebase has no way to
 * detect. Startup was measured before choosing (see AQUA_PARSE_ISOLATION.md);
 * an upload is not a hot path and the cost is not worth a pool's lifecycle
 * risk. If that ever changes, pool per OWNER, never globally.
 *
 * The parsers themselves are imported LAZILY, per op, so a PDF parse never
 * pays to load SheetJS.
 */
import { workerData, parentPort } from 'node:worker_threads';

/** Structured clone hands us a Uint8Array; the parsers want a Buffer. */
function asBuffer(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  return v;
}

const OPS = {
  async parseDocument({ ext, buffer }) {
    const { parseDocument } = await import('../project/documentParser.js');
    return parseDocument(ext, asBuffer(buffer));
  },
  async extractArchive({ buffer, format }) {
    const { extractArchive } = await import('./archiveExtractor.js');
    return extractArchive(asBuffer(buffer), format);
  },
  async extractZip({ base64 }) {
    const { extractZip } = await import('../project/fileIngester.js');
    return extractZip(base64);
  },
};

const { op, args } = workerData ?? {};

(async () => {
  try {
    const fn = OPS[op];
    if (!fn) throw new Error(`Unknown parse op: ${op}`);
    parentPort.postMessage({ ok: true, value: await fn(args) });
  } catch (err) {
    // Errors do not survive structured clone with their prototype, and the
    // call sites downstream read `.message` and, for ZipGuardError, `.limit`.
    // Both are carried across explicitly and rebuilt on the parent side.
    parentPort.postMessage({
      ok: false,
      error: {
        message: err?.message ?? String(err),
        name: err?.name ?? 'Error',
        limit: err?.limit ?? null,
        observed: err?.observed ?? null,
      },
    });
  }
})();
