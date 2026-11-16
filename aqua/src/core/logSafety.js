/**
 * AQUA — what a log line may say about the user's content (Sprint 1, 2026-11-10)
 * ─────────────────────────────────────────────────────────────────────────────
 * Production logs are not private storage. They leave the process, are kept by
 * the host for as long as it likes, and are read by people debugging something
 * unrelated. The audit found every chat turn printing the user's raw message
 * (memoryRetriever MEMORY_RANKED logged it UNREDACTED — health and mood
 * sentences the product promises not to store), extracted values, uploaded
 * file names and search queries (AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md F-09).
 *
 * The rule: a log line carries operational metadata — ids, counts, lengths,
 * durations, stages, field names, enumerated reasons — and never the text a
 * user wrote or a value derived from it. Where correlating two lines matters
 * ("is this the same message?") the line carries a short keyed hash: an HMAC
 * with a random per-process key, so equal inputs match WITHIN one process's
 * logs and nothing can be dictionary-reversed from a log export.
 *
 * Local debugging: AQUA_LOG_CONTENT=local prints raw content again, but only
 * where it cannot reach production logs — never when RENDER=true or
 * NODE_ENV=production. Read on every call so tests can toggle it.
 */
import crypto from 'node:crypto';

const PROCESS_KEY = crypto.randomBytes(32);

/** True only on a developer machine that asked for raw content. */
export function contentLoggingAllowed(env = process.env) {
  if (String(env.AQUA_LOG_CONTENT ?? '').toLowerCase() !== 'local') return false;
  if (String(env.RENDER ?? '').toLowerCase() === 'true') return false;
  if (String(env.NODE_ENV ?? '').toLowerCase() === 'production') return false;
  return true;
}

/** 8-hex keyed hash — correlates within one process, reveals nothing. */
export function shortHash(value) {
  return crypto.createHmac('sha256', PROCESS_KEY).update(String(value ?? '')).digest('hex').slice(0, 8);
}

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

/** A piece of user text → `len=N h=xxxxxxxx` (or the text, local debug only). */
export function textMeta(text) {
  const s = text == null ? '' : String(text);
  if (contentLoggingAllowed()) return `text=${JSON.stringify(s.slice(0, 200))}`;
  return `len=${s.length} h=${shortHash(s)}`;
}

/** A stored value of any shape → its type and size, never its content. */
export function valueMeta(value) {
  if (contentLoggingAllowed()) return `value=${JSON.stringify(value)?.slice(0, 200)}`;
  if (Array.isArray(value)) return `list(${value.length})`;
  if (value == null) return 'null';
  if (typeof value === 'object') return `object(${Object.keys(value).length})`;
  return `${typeof value}(len=${String(value).length})`;
}

/**
 * A fact key is a field name and may be logged — except the free-text tail of
 * a `custom_` key, which is built from the user's own words ("custom_divorce_
 * lawyer"). Schema keys (name, workplace, goal…) pass through.
 */
export function safeKey(key) {
  const k = String(key ?? '');
  if (contentLoggingAllowed()) return k;
  if (/^custom[_:]/i.test(k)) return `custom_#${shortHash(k)}`;
  if (!/^[a-z][a-z0-9_:.-]{0,63}$/i.test(k)) return `key#${shortHash(k)}`;
  return k;
}

/** A file name → extension, length and hash. "Medical report Jane.pdf" is content. */
export function fileMeta(name) {
  const s = String(name ?? '');
  if (contentLoggingAllowed()) return `name=${JSON.stringify(s)}`;
  const ext = (s.match(/\.([a-z0-9]{1,8})$/i)?.[1] ?? '').toLowerCase();
  return `file(ext=${ext || '-'} len=${s.length} h=${shortHash(s)})`;
}

/**
 * `["name=Ananya", "favorite_language=Rust"]` → `["name", "favorite_language"]`.
 * The memory event details have carried `key=value` since Phase 1; the key is
 * operational, the value is the user's.
 */
export function safeDetails(details = []) {
  if (contentLoggingAllowed()) return details;
  return (Array.isArray(details) ? details : [details]).map(d => {
    const s = String(d ?? '');
    const eq = s.indexOf('=');
    return safeKey(eq >= 0 ? s.slice(0, eq) : s);
  });
}

/**
 * An error for a log line: its class, code, HTTP status and body-parser type,
 * and a message with anything quoted removed. A body-parser SyntaxError
 * carries the raw request body on `err.body` and quotes it in the message —
 * logging the error object printed the user's whole message.
 */
export function errorMeta(err) {
  if (!err) return 'error=unknown';
  if (contentLoggingAllowed()) return String(err?.stack ?? err?.message ?? err);
  const parts = [`name=${err.name ?? typeof err}`];
  if (err.code) parts.push(`code=${err.code}`);
  const status = err.status ?? err.statusCode;
  if (status) parts.push(`status=${status}`);
  if (err.type) parts.push(`type=${err.type}`);
  if (err.type !== 'entity.parse.failed' && err.message) {
    parts.push(`message=${JSON.stringify(stripQuoted(String(err.message)).slice(0, 200))}`);
  }
  return parts.join(' ');
}

/** Stack frames only (no message line): where it happened, not what it quoted. */
export function stackFrames(err) {
  const stack = typeof err?.stack === 'string' ? err.stack : '';
  return stack.split('\n').filter(l => /^\s+at\s/.test(l)).slice(0, 12).join('\n');
}

/** Remove quoted spans ("…", '…', `…`) — where messages embed input. */
export function stripQuoted(s) {
  return String(s ?? '')
    .replace(/"[^"]*"/g, '"…"')
    .replace(/'[^']*'/g, "'…'")
    .replace(/`[^`]*`/g, '`…`');
}
