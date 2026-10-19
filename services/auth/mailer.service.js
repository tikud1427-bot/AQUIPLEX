"use strict";
/**
 * services/auth/mailer.service.js — transactional email for identity checks
 * (2026-10-19). The project had no mail capability; email ownership cannot be
 * verified without one.
 *
 * Transports (MAIL_TRANSPORT):
 *   - "resend": HTTPS POST to the Resend API (RESEND_API_KEY, MAIL_FROM).
 *               Request shape unit-tested with a stubbed fetch; NOT yet
 *               verified against the live provider.
 *   - "log":    writes the message to the server log. REFUSED when
 *               NODE_ENV=production, because the log would then hold live
 *               sign-in links.
 *   - unset:    no transport. `mailerAvailable()` is false and email/password
 *               signup is switched off (fail closed); Google sign-in, which
 *               does not need mail, keeps working.
 *
 * A test can install its own transport with `_setTransportForTests`.
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

async function resendTransport({ to, subject, text }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, text }),
  });
  if (!res.ok) throw new Error(`mail provider responded ${res.status}`);
  return { ok: true };
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
 * Send one message. Never throws to the caller's response path: identity
 * routes answer the same way whether or not mail was delivered (no account
 * enumeration), so failures are logged — masked — and reported as false.
 */
async function sendMail(message) {
  const transport = configuredTransport();
  if (!transport) return false;
  try {
    await transport(message);
    return true;
  } catch (err) {
    console.error(`[MAIL] send failed to=${maskEmail(message.to)}: ${err.message}`);
    return false;
  }
}

function _setTransportForTests(fn) {
  testTransport = fn;
}

module.exports = { sendMail, mailerAvailable, maskEmail, _setTransportForTests, _resendTransport: resendTransport };
