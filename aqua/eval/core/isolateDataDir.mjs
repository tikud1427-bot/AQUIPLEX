/**
 * Side-effect module: give an eval/measurement process a private AQUA_DATA_DIR.
 *
 * Import it FIRST. Static ESM imports are hoisted and evaluated in order, so an
 * assignment in a script body runs after every store module has already
 * resolved its directory — too late. Unset, AQUA_DATA_DIR means
 * `~/.aquiplex`, a developer's live conversations and identity map; a shadow
 * run on 2026-10-04 printed "[IDS] Canonical ids loaded … from
 * C:\Users\<user>\.aquiplex" before this existed.
 *
 * An explicit AQUA_DATA_DIR is respected. The Mongo mirror is disabled for the
 * same reason the gate disables it: an eval must not reach a real cluster.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.AQUA_DATA_DIR) {
  process.env.AQUA_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'aqua-eval-'));
}
process.env.AQUA_DISABLE_MONGO_MIRROR ??= '1';
