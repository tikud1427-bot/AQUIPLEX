"use strict";
/**
 * routes/account/account.routes.js
 * AQUIPLEX — account self-service (Google Play User Data policy).
 *
 *   GET  /api/account          — who am I, and how do I have to reauthenticate
 *   POST /api/account/delete   — permanently delete this account
 *
 * The Google OAuth reauthentication round trip itself lives in index.js
 * alongside the other passport routes (/auth/google/reauth) — it must be a
 * browser redirect, not an XHR, so it cannot live behind this JSON API.
 *
 * Shape and conventions mirror routes/billing/billing.routes.js exactly:
 * session-based auth helper, `{ success, ... }` bodies, `{ error: CODE,
 * message: "human sentence" }` on failure (the AQUA frontend's
 * normalizeError() renders `message`).
 */

const express = require("express");
const router  = express.Router();

const User = require("../../models/User");
const {
  deleteAccount,
  verifyReauthentication,
  authMethodFor,
  REAUTH_MAX_AGE_MS,
} = require("../../services/account/accountDeletion.service");
const { createLogger } = require("../../utils/logger");

const log = createLogger("ACCOUNT_ROUTES");

// ── Auth helper (same contract as billing.routes.js) ─────────────────────────

function getUid(req) {
  return (
    req.session?.userId    ||
    req.session?.user?._id ||
    req.user?._id          ||
    req.user?.id           ||
    null
  );
}

function requireLogin(req, res, next) {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ success: false, error: "LOGIN_REQUIRED" });
  req.uid = uid.toString();
  next();
}

/** Is there a usable Google reauthentication on this session right now? */
function reauthFresh(session) {
  const r = session?.accountDeleteReauth;
  return !!(r && r.at && Date.now() - r.at <= REAUTH_MAX_AGE_MS);
}

// ── GET /api/account ─────────────────────────────────────────────────────────
// Drives the Delete Account UI: it needs to know whether to show a password
// field or a "Confirm with Google" button, and whether that confirmation has
// already happened (the user is sent back here after the OAuth round trip).

router.get("/", requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.uid).select("email password createdAt");
    if (!user) return res.status(404).json({ success: false, error: "USER_NOT_FOUND" });

    return res.json({
      success: true,
      account: {
        email:      user.email,
        authMethod: authMethodFor(user),   // "password" | "google"
        reauthFresh: reauthFresh(req.session),
        createdAt:  user.createdAt,
      },
    });
  } catch (err) {
    log.error("GET /account error:", err.message);
    return res.status(500).json({
      success: false,
      error:   "ACCOUNT_LOOKUP_FAILED",
      message: "Could not load your account details. Try again.",
    });
  }
});

// ── POST /api/account/delete ─────────────────────────────────────────────────
// Permanent. Reauthentication is mandatory and is checked here, never in the
// service — the service deletes whatever it is told to delete.

router.post("/delete", requireLogin, async (req, res) => {
  let user;
  try {
    user = await User.findById(req.uid);
  } catch (err) {
    log.error("delete: user lookup failed:", err.message);
    return res.status(500).json({
      success: false,
      error:   "ACCOUNT_LOOKUP_FAILED",
      message: "Could not load your account. Try again.",
    });
  }

  if (!user) {
    // Already gone (double submit / stale session) — end the session so the
    // client stops thinking it is signed in, and report success: the caller's
    // desired end state is exactly this.
    return req.session.destroy(() => {
      res.clearCookie("aidex_session");
      res.json({ success: true, alreadyDeleted: true });
    });
  }

  // ── Reauthentication ──
  const check = await verifyReauthentication({
    user,
    reauth:   req.session.accountDeleteReauth || null,
    password: typeof req.body?.password === "string" ? req.body.password : undefined,
  });

  if (!check.ok) {
    log.warn(`delete: reauth rejected user=${req.uid} reason=${check.error}`);
    // 401 for a failed credential, 403 for a missing/expired confirmation —
    // the client uses this to decide between "retry" and "start OAuth again".
    const status = check.error === "PASSWORD_INCORRECT" ? 401 : 403;
    return res.status(status).json({
      success:    false,
      error:      check.error,
      message:    check.message,
      authMethod: check.method,
    });
  }

  // ── Deletion ──
  let result;
  try {
    result = await deleteAccount({ userId: req.uid });
  } catch (err) {
    log.error(`delete: failed user=${req.uid}:`, err.message);
    return res.status(500).json({
      success: false,
      error:   "DELETION_FAILED",
      message: "We couldn't finish deleting your account. Nothing partial was left behind — please try again, or email support@aquiplex.ai.",
    });
  }

  if (!result.ok) {
    // The engine purge reported errors, so the account still exists on
    // purpose — the user can retry rather than being left half-deleted.
    log.error(`delete: incomplete user=${req.uid}:`, result.errors.join(" | "));
    return res.status(500).json({
      success: false,
      error:   "DELETION_INCOMPLETE",
      message: "We couldn't remove all of your data, so your account was left intact. Please try again, or email support@aquiplex.ai.",
    });
  }

  // Session last: every other session was already deleted from the store by
  // the service; this ends the one making the request.
  return req.session.destroy((err) => {
    if (err) log.warn(`delete: session destroy failed user=${req.uid}: ${err.message}`);
    res.clearCookie("aidex_session");
    return res.json({
      success: true,
      deleted: {
        conversations: result.engine.conversations,
        artifacts:     result.engine.artifacts,
        workspaces:    result.engine.workspaces,
      },
    });
  });
});

module.exports = router;
