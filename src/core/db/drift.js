/**
 * AQUA Storage — drift comparison
 * Blueprint E3/PR-6
 *
 * Reads both sides and reports where they disagree. E3's read paths do not
 * flip until this has reported clean for a week, and PR-7 onward will point at
 * `aqua_drift_runs` for the evidence rather than at somebody's recollection.
 *
 * IT NEVER WRITES TO A STORE
 * --------------------------
 * A drift job that "repairs" what it finds is a second write path with no
 * review, running unattended, against the exact data whose correctness is in
 * question. This one reports; a human decides. The only thing it writes is its
 * own history row.
 *
 * IT COMPARES CHECKSUMS, NOT BLOBS
 * --------------------------------
 * `aqua_store_blobs.checksum` exists for this: the shadow side is one query
 * returning `(store_key, checksum)`, not every store's full contents pulled
 * across the wire on a timer. The primary side is hashed from the file with
 * the same function that wrote the column.
 *
 * THE PURE PART IS SEPARATED, AGAIN
 * ---------------------------------
 * `diffManifests()` is where all the judgement lives and it needs neither a
 * database nor a filesystem. Same split as the migration runner: the decision
 * is fully testable, and the I/O around it is too small to hide anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { DATA_DIR } from '../dataDir.js';
import { isConfigured, getPool } from './pool.js';
import { TABLE } from '../storage/pgBlobAdapter.js';

/** The same hash pgBlobAdapter writes into the checksum column. */
export const checksumOf = data =>
  crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);

/**
 * Compare two `{ key → checksum }` maps.
 *
 * Four outcomes, and the two "missing" ones are NOT the same problem:
 *   missingShadow   a write never reached Postgres, or never happened yet
 *   missingPrimary  a row outlived its store file — a stale row, not a lost write
 * Collapsing them into "different" would lose which side to go and look at.
 */
export function diffManifests(primary, shadow) {
  const matched = [];
  const mismatched = [];
  const missingShadow = [];
  const missingPrimary = [];

  for (const [key, sum] of primary) {
    if (!shadow.has(key)) { missingShadow.push(key); continue; }
    if (shadow.get(key) === sum) matched.push(key);
    else mismatched.push({ key, primary: sum, shadow: shadow.get(key) });
  }
  for (const key of shadow.keys()) {
    if (!primary.has(key)) missingPrimary.push(key);
  }

  matched.sort();
  mismatched.sort((a, b) => a.key.localeCompare(b.key));
  missingShadow.sort();
  missingPrimary.sort();

  return {
    stores: primary.size,
    matched: matched.length,
    mismatched,
    missingShadow,
    missingPrimary,
    clean: mismatched.length === 0 && missingShadow.length === 0 && missingPrimary.length === 0,
  };
}

/** Hash every `.aqua-*.json` in the data directory. */
export function primaryManifest({ dir = DATA_DIR } = {}) {
  const out = new Map();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;               // no data directory yet — nothing to compare
  }
  for (const name of names) {
    if (!name.startsWith('.aqua-') || !name.endsWith('.json')) continue;
    try {
      out.set(name, checksumOf(fs.readFileSync(path.join(dir, name), 'utf8')));
    } catch { /* a store being rewritten right now — next run catches it */ }
  }
  return out;
}

export async function shadowManifest() {
  const pool = await getPool();
  const { rows } = await pool.query(`SELECT store_key, checksum FROM ${TABLE}`);
  return new Map(rows.map(r => [r.store_key, r.checksum]));
}

/**
 * Run one comparison.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.record]  write a history row (default true)
 */
export async function checkDrift({ dir = DATA_DIR, record = true } = {}) {
  if (!isConfigured()) {
    return { configured: false, status: 'not-configured' };
  }
  const started = Date.now();
  const result = diffManifests(primaryManifest({ dir }), await shadowManifest());
  const durationMs = Date.now() - started;

  if (record) {
    try {
      const pool = await getPool();
      await pool.query(
        `INSERT INTO aqua_drift_runs
           (stores, matched, mismatched, missing_shadow, missing_primary, clean, duration_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [result.stores, result.matched, result.mismatched.length,
          result.missingShadow.length, result.missingPrimary.length, result.clean, durationMs]);
    } catch (err) {
      // Losing the history row must not lose the RESULT. The comparison is the
      // point; the record is how the week-of-zero claim stays checkable.
      console.error(`[DRIFT] could not record run: ${err.message}`);
    }
  }
  return { configured: true, status: result.clean ? 'clean' : 'drift', durationMs, ...result };
}

/** How long drift has been clean — the evidence PR-7 needs before flipping a read. */
export async function cleanSince() {
  if (!isConfigured()) return null;
  const pool = await getPool();
  const { rows } = await pool.query(
    'SELECT ran_at, clean FROM aqua_drift_runs ORDER BY ran_at DESC LIMIT 200');
  if (!rows.length) return { runs: 0, cleanSince: null, lastDirty: null };
  const lastDirty = rows.find(r => !r.clean) ?? null;
  const oldestClean = lastDirty
    ? rows.filter(r => r.ran_at > lastDirty.ran_at).at(-1)
    : rows.at(-1);
  return {
    runs: rows.length,
    cleanSince: oldestClean?.ran_at ?? null,
    lastDirty: lastDirty?.ran_at ?? null,
  };
}

/** One line for the boot log. Never throws. */
export function driftLine(result) {
  if (!result || result.configured === false) return '[DRIFT] not-configured';
  if (result.clean) return `[DRIFT] clean — ${result.matched}/${result.stores} stores match (${result.durationMs}ms)`;
  const parts = [];
  if (result.mismatched.length) parts.push(`${result.mismatched.length} mismatched`);
  if (result.missingShadow.length) parts.push(`${result.missingShadow.length} missing in postgres`);
  if (result.missingPrimary.length) parts.push(`${result.missingPrimary.length} stale rows`);
  return `[DRIFT] ⚠ ${parts.join(', ')} of ${result.stores} stores — read paths must NOT flip`;
}
