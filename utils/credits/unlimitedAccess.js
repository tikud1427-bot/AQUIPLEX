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

  const allowlist = getUnlimitedEmails();
  const allowed = allowlist.includes(email);

  if (allowed) {
    console.info("[UnlimitedAccess] allowlisted account", {
      email,
    });
  }

  return allowed;
}

module.exports = {
  hasUnlimitedAccess,
};