/**
 * Platform log safety (Sprint 1, 2026-11-10) — the CommonJS side of
 * aqua/src/core/logSafety.js. The platform server and the engine are separate
 * packages, so the two helpers are separate files with the same rules:
 *
 *  · A session id is a bearer credential. Logged in full, anyone who can read
 *    the logs can replay the session. Lines that need to follow one OAuth leg
 *    get a keyed, per-process hash instead: equal ids match within one
 *    process's logs, nothing can be replayed or reversed.
 *  · An error is logged as its class/code/status/type and stack. A body-parser
 *    "entity.parse.failed" error carries the raw request body on `err.body`
 *    and quotes it in the message — logging the error OBJECT printed the
 *    user's whole message — so for that type the message is not logged.
 */
const crypto = require("crypto");

const PROCESS_KEY = crypto.randomBytes(32);

function shortHash(value) {
  return crypto.createHmac("sha256", PROCESS_KEY).update(String(value ?? "")).digest("hex").slice(0, 8);
}

/** `sess#1a2b3c4d` — correlates log lines of one session without exposing it. */
function sessionTag(sessionId) {
  return sessionId ? `sess#${shortHash(sessionId)}` : "sess#none";
}

function stripQuoted(s) {
  return String(s ?? "")
    .replace(/"[^"]*"/g, '"…"')
    .replace(/'[^']*'/g, "'…'")
    .replace(/`[^`]*`/g, "`…`");
}

/** One-line description of an error with no request content in it. */
function errorSummary(err) {
  if (!err) return "error=unknown";
  const parts = [`name=${err.name ?? typeof err}`];
  if (err.code) parts.push(`code=${err.code}`);
  const status = err.status ?? err.statusCode;
  if (status) parts.push(`status=${status}`);
  if (err.type) parts.push(`type=${err.type}`);
  if (err.type !== "entity.parse.failed" && err.message) {
    parts.push(`message=${JSON.stringify(stripQuoted(err.message).slice(0, 200))}`);
  }
  return parts.join(" ");
}

/** Stack frames only (no message line) — where the error happened, not what it quoted. */
function stackFrames(err) {
  const stack = typeof err?.stack === "string" ? err.stack : "";
  return stack.split("\n").filter(l => /^\s+at\s/.test(l)).slice(0, 12).join("\n");
}

module.exports = { shortHash, sessionTag, errorSummary, stackFrames, stripQuoted };
