/**
 * AQUA — the long-lived parse worker
 * Blueprint E1/PR-4b
 *
 * Handles many requests over its lifetime, unlike E1/PR-4's one-shot
 * `parseWorker.js`. The two are deliberately separate files rather than one
 * with a mode flag: a one-shot worker that could accidentally be reused, or a
 * session worker that exits after one message, are both silent failures.
 *
 * IT HOLDS NO STATE BETWEEN REQUESTS.
 *
 * That is a security property, not a style choice. A session carries one
 * user's document after another, and a parser that remembered anything would
 * be a cross-document leak nobody would spot in a log. Every handler takes its
 * input from the message and returns a value; nothing is stored at module
 * scope except the lazily-imported parser modules themselves, which are pure.
 */
import { parentPort } from 'node:worker_threads';

/** Structured clone delivers a Uint8Array; the parsers want a Buffer. */
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
};

parentPort.on('message', async ({ id, op, args }) => {
  try {
    const fn = OPS[op];
    if (!fn) throw new Error(`Unknown parse op: ${op}`);
    parentPort.postMessage({ id, ok: true, value: await fn(args) });
  } catch (err) {
    // Errors lose their prototype across a structured clone, and callers read
    // `.message` and — for a ZipGuardError — `.limit`. Both are carried
    // explicitly and rebuilt on the parent side.
    parentPort.postMessage({
      id, ok: false,
      error: {
        message: err?.message ?? String(err),
        name: err?.name ?? 'Error',
        limit: err?.limit ?? null,
        observed: err?.observed ?? null,
      },
    });
  }
});
