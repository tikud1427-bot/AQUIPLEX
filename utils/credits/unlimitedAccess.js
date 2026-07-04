"use strict";

/**
 * Centralized helper for exempting trusted accounts from usage limits.
 * ONLY emails listed in UNLIMITED_USER_EMAILS are bypassed.
 */

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function getUnlimitedEmails() {
  return String(process.env.UNLIMITED_USER_EMAILS || "")
    .split(",")
    .map(normalizeEmail)
    .filter(Boolean);
}

function hasUnlimitedAccess(user) {
  if (!user) return false;

  const email = normalizeEmail(user.email);
  if (!email) return false;

  // Check env allowlist
  const allowlist = getUnlimitedEmails();
  if (allowlist.includes(email)) {
    console.info("[UnlimitedAccess] allowlisted account", { email });
    return true;
  }

  // Check isUnlimited flag on user document (admin-set)
  if (user.isUnlimited === true) {
    return true;
  }

  return false;
}

/**
 * unlimitedAccessReason — returns a human-readable reason string, or null.
 * Called for logging only. Never returns a falsy value that blocks access.
 */
function unlimitedAccessReason(user) {
  if (!user) return null;

  const email = normalizeEmail(user.email);
  const allowlist = getUnlimitedEmails();

  if (email && allowlist.includes(email)) return "email_allowlist";
  if (user.isUnlimited === true) return "isUnlimited_flag";
  return null;
}

module.exports = {
  hasUnlimitedAccess,
  unlimitedAccessReason,
};