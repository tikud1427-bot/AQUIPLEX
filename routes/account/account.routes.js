"use strict";
/**
 * routes/account/account.routes.js
 * AQUIPLEX — account self-service (Google Play User Data policy).
 *
 *   GET  /api/account          — who am I, and how do I have to reauthenticate
 *   POST /api/account/logout   — end this session (used by the AQUA SPA)
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
const { endSession } = require("../../services/account/sessionLogout.service");
const { getPrivacy, setPrivacy } = require("../../services/account/privacySettings.service");
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

// ── POST /api/account/logout ─────────────────────────────────────────────────
// Ends the current session for the AQUA SPA.
//
// WHY A JSON ENDPOINT WHEN GET /logout ALREADY EXISTS
// ---------------------------------------------------
// GET /logout is a browser navigation that lands on "/". The SPA needs to do
// three things in order — end the server session, tear down every client-side
// store and persisted key, and only THEN navigate — and it needs to know
// whether the first step actually succeeded so it can refuse to pretend. A
// redirect tells it nothing. GET /logout is untouched and still works.
//
// The teardown itself is the same req.session.destroy() + clearCookie the
// existing call sites use, extracted into sessionLogout.service.js.
//
// NO requireLogin, DELIBERATELY
// -----------------------------
// An expired or already-destroyed session must get a clean 200, not a 401.
// The caller's goal is "not signed in"; if that is already true the request
// succeeded. Gating this on a live session would mean the one case where the
// client most needs a definitive answer — a session that died underneath it —
// is the case it cannot get one for.
//
// CSRF: covered by enforceSameOrigin() (index.js), which is mounted globally
// ahead of every route for the /api/* surface. A cross-site POST here carries
// an Origin that is not ours and is rejected before it arrives.
router.post("/logout", async (req, res) => {
  const uid = getUid(req);
  const result = await endSession(req, res);

  if (!result.ok) {
    log.error(`logout: session destroy failed user=${uid || "anon"}: ${result.error}`);
    return res.status(500).json({
      success: false,
      error:   "LOGOUT_FAILED",
      message: "We couldn't sign you out. Check your connection and try again.",
    });
  }

  return res.json({ success: true, hadSession: result.hadSession });
});

// ── GET/PUT /api/account/privacy ─────────────────────────────────────────────
// `rememberSensitive` (default false): may AQUA remember health and mood
// details? Read by the engine on every turn (services/account/privacySettings).
// CSRF: same enforceSameOrigin() coverage as /logout above.

router.get("/privacy", requireLogin, async (req, res) => {
  return res.json({ success: true, privacy: await getPrivacy(req.uid) });
});

router.put("/privacy", requireLogin, async (req, res) => {
  const v = req.body?.rememberSensitive;
  if (typeof v !== "boolean") {
    return res.status(400).json({ success: false, error: "BAD_REQUEST", message: "rememberSensitive must be true or false." });
  }
  try {
    const privacy = await setPrivacy(req.uid, { rememberSensitive: v });
    log.info(`privacy updated user=${req.uid} rememberSensitive=${privacy.rememberSensitive}`);
    return res.json({ success: true, privacy });
  } catch (err) {
    log.error("PUT /account/privacy error:", err.message);
    return res.status(500).json({ success: false, error: "PRIVACY_UPDATE_FAILED", message: "We couldn't save that setting. Please try again." });
  }
});

module.exports = router;
