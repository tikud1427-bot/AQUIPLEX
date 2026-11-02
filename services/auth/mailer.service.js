"use strict";
/**
 * services/auth/mailer.service.js — transactional email for identity checks
 * (2026-10-19). The project had no mail capability; email ownership cannot be
 * verified without one.
 *
 * Transports (MAIL_TRANSPORT):
 *   - "resend": HTTPS POST to the Resend API (RESEND_API_KEY, MAIL_FROM).
 *               Request shape and error handling unit-tested with a stubbed
 *               fetch; NOT yet verified against the live provider.
 *   - "log":    writes the message to the server log. REFUSED when
 *               NODE_ENV=production, because the log would then hold live
 *               sign-in links.
 *   - unset:    no transport. `mailerAvailable()` is false and email/password
 *               signup is switched off (fail closed); Google sign-in, which
 *               does not need mail, keeps working.
 *
 * A test can install its own transport with `_setTransportForTests`.
 *
 * `mailerStatus()` names whatever is missing; it is logged at startup
 * (utils/startup.js) and, throttled, when /signup is refused.
 */

let testTransport = null;

function configuredTransport() {
  if (testTransport) return testTransport;
  const kind = String(process.env.MAIL_TRANSPORT || "").trim().toLowerCase();
  const production = process.env.NODE_ENV === "production";
  if (kind === "log" && !production) return logTransport;
  if (kind === "resend" && process.env.RESEND_API_KEY && process.env.MAIL_FROM) return resendTransport;
  return null;
}

async function logTransport({ to, subject, text }) {
  // Dev only (see above). The recipient is masked; the body (which holds the
  // link) is printed so a developer can complete the flow locally.
  console.log(`[MAIL:log] to=${maskEmail(to)} subject=${JSON.stringify(subject)}\n${text}`);
  return { ok: true };
}

const RESEND_TIMEOUT_MS = 10000;

// What an operator should check for each Resend refusal. Resend answers 401/403
// for a missing or invalid key AND for an unverified sending domain, so its own
// message (logged alongside) says which.
const RESEND_HINTS = {
  400: "the request was malformed — check MAIL_FROM is `Name <address@domain>` or a bare address",
  401: "RESEND_API_KEY is missing or not a Resend key",
  403: "RESEND_API_KEY is invalid/revoked, or the MAIL_FROM domain is not verified in Resend (Domains page)",
  422: "Resend refused a field — usually MAIL_FROM is malformed or its domain is not verified",
  429: "Resend rate limit or daily quota reached",
};

async function resendTransport({ to, subject, text }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, text }),
    signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Resend explains itself in a JSON body ({ name, message }); addresses in
    // it are masked before they reach the log.
    let detail = "";
    try {
      const body = typeof res.json === "function" ? await res.json() : null;
      if (body) detail = [body.name, body.message].filter(Boolean).join(": ");
    } catch (_) { /* no usable body */ }
    detail = detail.replace(/[^\s@<>(),;:"']+@[^\s@<>(),;:"']+/g, maskEmail).slice(0, 300);
    const hint = RESEND_HINTS[res.status] || (res.status >= 500 ? "Resend is having a problem — retry later" : "");
    throw new Error(`mail provider responded ${res.status}${detail ? ` (${detail})` : ""}${hint ? ` — ${hint}` : ""}`);
  }
  let id = null;
  try { id = typeof res.json === "function" ? (await res.json())?.id || null : null; } catch (_) { /* id is optional */ }
  return { ok: true, id };
}

/** "founder@example.com" → "f***@example.com" — for logs only. */
function maskEmail(email) {
  const s = String(email || "");
  const at = s.indexOf("@");
  return at > 0 ? `${s[0]}***${s.slice(at)}` : "***";
}

function mailerAvailable() {
  return configuredTransport() !== null;
}

/**
 * Whether email signup can run, and if not, exactly what to set. Names
 * variables, never prints their secret values. `ready` also requires APP_URL
 * in production: links in email must not be built from the Host header.
 * @returns {{ ready:boolean, transport:string|null, problems:string[], warnings:string[] }}
 */
function mailerStatus() {
  const production = process.env.NODE_ENV === "production";
  const kind = String(process.env.MAIL_TRANSPORT || "").trim().toLowerCase();
  const problems = [];
  const warnings = [];
  if (testTransport) return { ready: true, transport: "test", problems, warnings };

  if (!kind) {
    problems.push("MAIL_TRANSPORT is not set — set MAIL_TRANSPORT=resend (production) or MAIL_TRANSPORT=log (local development only)");
  } else if (kind === "log") {
    if (production) problems.push("MAIL_TRANSPORT=log is refused when NODE_ENV=production (it would write live sign-in links to the log) — set MAIL_TRANSPORT=resend");
  } else if (kind === "resend") {
    const key = String(process.env.RESEND_API_KEY || "").trim();
    const from = String(process.env.MAIL_FROM || "").trim();
    if (!key) problems.push("RESEND_API_KEY is not set — create a Sending access key at resend.com/api-keys");
    else if (!key.startsWith("re_")) warnings.push("RESEND_API_KEY does not start with \"re_\" — check it is a Resend API key");
    if (!from) problems.push("MAIL_FROM is not set — e.g. MAIL_FROM=\"Aquiplex <no-reply@aquiplex.com>\" on a domain verified in Resend");
    else if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$|^[^<>]*<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>$/.test(from)) problems.push(`MAIL_FROM is not an address Resend accepts — use "Name <address@domain>" or "address@domain"`);
  } else {
    problems.push(`MAIL_TRANSPORT="${kind}" is not supported — use "resend" or (development only) "log"`);
  }

  const appUrl = String(process.env.APP_URL || "").trim();
  if (production && !appUrl) problems.push("APP_URL is not set — e.g. APP_URL=https://aquiplex.com (verification links are built from it)");
  else if (appUrl && !/^https?:\/\/[^\s/]+/i.test(appUrl)) problems.push(`APP_URL must be an absolute URL such as https://aquiplex.com`);
  else if (production && appUrl && !/^https:\/\//i.test(appUrl)) warnings.push("APP_URL is not https — verification links will be sent over plain http");

  const transport = configuredTransport() === resendTransport ? "resend" : configuredTransport() === logTransport ? "log" : null;
  return { ready: problems.length === 0 && transport !== null, transport, problems, warnings };
}

/** Startup line(s) saying whether email signup is on and, if not, why. */
function logMailerStatus(status = mailerStatus()) {
  if (status.ready) {
    console.log(`✅ Email signup: ON (MAIL_TRANSPORT=${status.transport}${status.transport === "resend" ? `, MAIL_FROM=${process.env.MAIL_FROM}` : ""})`);
  } else {
    console.error("❌ Email signup: OFF — /signup answers \"Email sign-up isn't available\". Google sign-in is unaffected. To turn it on:");
    status.problems.forEach((p) => console.error(`   - ${p}`));
  }
  status.warnings.forEach((w) => console.warn(`⚠️  Email signup: ${w}`));
}

let lastUnavailableLogAt = 0;
/** For the request path: the same diagnostics, at most once per 10 minutes. */
function warnUnavailable(status = mailerStatus(), now = Date.now()) {
  if (now - lastUnavailableLogAt < 10 * 60 * 1000) return false;
  lastUnavailableLogAt = now;
  console.error(`[MAIL] email signup refused: ${status.problems.join("; ") || "no mail transport"}`);
  return true;
}

/**
 * Send one message. Never throws to the caller's response path: failures are
 * logged — masked, with the provider's reason — and reported as false, and
 * the caller decides what to tell the person.
 */
async function sendMail(message) {
  const transport = configuredTransport();
  if (!transport) return false;
  try {
    const result = await transport(message);
    if (transport === resendTransport) console.log(`[MAIL] sent to=${maskEmail(message.to)}${result && result.id ? ` id=${result.id}` : ""}`);
    return true;
  } catch (err) {
    console.error(`[MAIL] send failed to=${maskEmail(message.to)}: ${err.message}`);
    return false;
  }
}

function _setTransportForTests(fn) {
  testTransport = fn;
}

module.exports = { sendMail, mailerAvailable, mailerStatus, logMailerStatus, warnUnavailable, maskEmail, _setTransportForTests, _resendTransport: resendTransport };
