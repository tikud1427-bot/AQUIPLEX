"use strict";

/**
 * Centralized helper for exempting trusted accounts from usage limits.
 *
 * Two sources, both server-side (2026-10-19):
 *   1. `user.isUnlimited === true` — a database flag changed ONLY by
 *      scripts/admin/unlimited-entitlement.js, which writes an
 *      EntitlementAudit record (who, why, before/after). No route sets it.
 *   2. UNLIMITED_USER_EMAILS — honoured only for an account whose address is
 *      VERIFIED (`emailVerified === true`: a completed email link, or Google's
 *      `email_verified`). Before this, any signup that typed an allowlisted
 *      address got unlimited credits: the addresses are public (they were
 *      committed to git history) and signup did not check ownership.
 *
 * Matching is exact after trim + lower-case. Provider aliasing (Gmail dots,
 * "+tag") is deliberately NOT folded: an alias is a different string, so it
 * simply does not match — it can never widen the grant.
 *
 * Nothing here logs an email address.
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

function allowlistedAndVerified(user) {
  if (user.emailVerified !== true) return false;
  const email = normalizeEmail(user.email);
  return !!email && getUnlimitedEmails().includes(email);
}

function hasUnlimitedAccess(user) {
  if (!user) return false;
  if (user.isUnlimited === true) return true;
  return allowlistedAndVerified(user);
}

/**
 * unlimitedAccessReason — returns a human-readable reason string, or null.
 * Called for logging only.
 */
function unlimitedAccessReason(user) {
  if (!user) return null;
  if (user.isUnlimited === true) return "isUnlimited_flag";
  if (allowlistedAndVerified(user)) return "email_allowlist_verified";
  return null;
}

module.exports = {
  hasUnlimitedAccess,
  unlimitedAccessReason,
};
