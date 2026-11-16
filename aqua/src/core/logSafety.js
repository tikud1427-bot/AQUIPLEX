/**
 * AQUA — what a log line may say about the user (PWI Phase 1, 2026-11-15).
 * A log line carries operational metadata, never a direct identifier: owner
 * ids are written as pseudonyms (ownerLogId below).
 */
import crypto from 'node:crypto';

/**
 * Owner ids in log lines (2026-11-15, PWI Phase 1). `user:<accountId>` is a
 * direct identifier; a log line names the owner by a pseudonym instead:
 *
 *   o_<16 hex>   HMAC-SHA256 under AQUA_LOG_PSEUDONYM_KEY (≥ 32 chars, a
 *                secret). STABLE across restarts, instances and the API/worker
 *                split, so one owner's lines correlate everywhere; not
 *                reversible without the key. Support finds a user's lines with
 *                `node scripts/owner-log-id.mjs <ownerId>` and the same key.
 *   p_<16 hex>   the key is unset or too short: a random per-process key.
 *                Lines still never carry the raw id, but they correlate only
 *                within one process — the prefix says so. Warned once.
 *
 * Domain-separated from every other hash here, so a pseudonym can never be
 * matched against shortHash/textMeta output. Read on every call (tests and
 * key rotation take effect without a restart of this module).
 */
const PSEUDONYM_DOMAIN = 'aqua-owner-log-v1';
const PSEUDONYM_MIN_KEY_CHARS = 32;
const PSEUDONYM_PROCESS_KEY = crypto.randomBytes(32);
let pseudonymWarned = false;

function pseudonymKey(env) {
  const raw = String(env.AQUA_LOG_PSEUDONYM_KEY ?? '');
  if (raw.length >= PSEUDONYM_MIN_KEY_CHARS) return { key: Buffer.from(raw, 'utf8'), stable: true };
  if (!pseudonymWarned) {
    pseudonymWarned = true;
    console.warn(`[LOG] AQUA_LOG_PSEUDONYM_KEY ${raw ? `is shorter than ${PSEUDONYM_MIN_KEY_CHARS} characters` : 'is not set'} — owner pseudonyms (p_…) correlate within this process only`);
  }
  return { key: PSEUDONYM_PROCESS_KEY, stable: false };
}

/** An owner id → `o_<16 hex>` (stable, keyed) or `p_<16 hex>` (per process). Never the id itself. */
export function ownerLogId(ownerId, env = process.env) {
  if (ownerId == null || ownerId === '') return 'none';
  const { key, stable } = pseudonymKey(env);
  const h = crypto.createHmac('sha256', key).update(`${PSEUDONYM_DOMAIN}\u0000${String(ownerId)}`).digest('hex').slice(0, 16);
  return `${stable ? 'o' : 'p'}_${h}`;
}

/** Tests only: re-arm the one-time warning. */
export function _resetOwnerLogIdForTests() { pseudonymWarned = false; }
