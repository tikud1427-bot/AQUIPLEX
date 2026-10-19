"use strict";
/**
 * services/auth/authRoutes.service.js — HTTP handlers for signup, email
 * verification and Google account linking (2026-10-19). Decisions live in
 * identityPolicy.service.js; this file only maps them onto requests, sessions
 * and pages, so the same handlers run in index.js and in the tests.
 *
 * Wired in index.js:
 *   POST /signup                     signup       — never says whether the address exists
 *   GET  /verify-email               verifyForm   — renders the form; looks nothing up
 *   POST /verify-email               verifySubmit — token + the signup password → account + session
 *   GET  /auth/link                  linkForm     — after a Google sign-in met a password account
 *   POST /auth/link/password         linkPassword — path A: prove the password, link Google
 *   POST /auth/link/claim            linkClaim    — path B: claim with Google (explicit confirm)
 */
const policy = require("./identityPolicy.service");

const VERIFY_MESSAGES = {
  invalid:      "This link isn't valid. Check you opened the latest one, or sign up again.",
  used:         "This link has already been used. Log in instead.",
  expired:      "This link has expired. Sign up again to get a new one.",
  locked:       "Too many wrong passwords for this link. Sign up again to get a new one.",
  bad_password: "That isn't the password you chose when you signed up.",
  exists:       "An account for this address already exists. Log in instead.",
};

const LINK_MESSAGES = {
  expired:              "That took too long. Sign in with Google again.",
  bad_password:         "That password doesn't match this account.",
  conflicting_identity: "This account is already linked to a different Google account.",
  gone:                 "That account no longer exists. Sign in with Google again.",
};

/**
 * @param {object} deps
 * @param {object} deps.User
 * @param {object} deps.PendingSignup
 * @param {(msg:object)=>Promise<boolean>} deps.sendMail
 * @param {()=>boolean} deps.mailerAvailable
 * @param {(req)=>string} deps.baseUrl
 * @param {(req, user)=>Promise<void>} deps.establishSession  regenerates + writes identity
 * @param {(req, res, user, opts)=>void} deps.finishLogin  signs a user in after linking (handles the native app leg)
 * @param {(userId, name, props)=>void} [deps.recordEvent]
 * @param {{forget:(id)=>void}} [deps.versionGuard]
 */
function createAuthHandlers(deps) {
  const { User, PendingSignup, sendMail, mailerAvailable, baseUrl, establishSession, finishLogin } = deps;
  const recordEvent = deps.recordEvent || (() => {});
  const forget = (id) => deps.versionGuard && deps.versionGuard.forget(id);

  async function signup(req, res) {
    try {
      const { email, password } = req.body || {};
      const again = (status, error) => res.status(status).render("signup", { error });
      if (!mailerAvailable()) {
        return again(503, "Email sign-up isn't available right now. Continue with Google instead.");
      }
      const invalid = policy.signupInputError(email, password);
      if (invalid) return again(400, invalid);
      await startSignupSafely({ email, password }, req);
      return res.status(200).render("signup-check-email", { email: policy.normalizeEmail(email) });
    } catch (err) {
      console.error(`[AUTH] signup failed: ${err.message}`);
      return res.status(500).render("signup", { error: "Something went wrong creating your account. Try again." });
    }
  }

  async function startSignupSafely(input, req) {
    return policy.startSignup({ User, PendingSignup, sendMail, baseUrl: baseUrl(req) }, input);
  }

  function verifyForm(req, res) {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    res.set("Cache-Control", "no-store");
    return res.render("verify-email", { token, error: null });
  }

  async function verifySubmit(req, res) {
    res.set("Cache-Control", "no-store");
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    try {
      const result = await policy.completeSignup({ User, PendingSignup }, { token, password: req.body?.password });
      if (!result.ok) {
        const status = result.reason === "bad_password" ? 401 : 400;
        return res.status(status).render("verify-email", { token: result.reason === "bad_password" ? token : "", error: VERIFY_MESSAGES[result.reason] || VERIFY_MESSAGES.invalid });
      }
      await establishSession(req, result.user);
      recordEvent(result.user._id, "signup_completed", { method: "email" });
      return res.redirect("/aqua");
    } catch (err) {
      console.error(`[AUTH] verify failed: ${err.message}`);
      return res.status(500).render("verify-email", { token, error: "Something went wrong. Try again." });
    }
  }

  function pendingFrom(req) {
    const p = req.session && req.session.pendingGoogle;
    return policy.pendingIsFresh(p) ? p : null;
  }

  function linkForm(req, res) {
    res.set("Cache-Control", "no-store");
    const pending = pendingFrom(req);
    if (!pending) return res.redirect("/login?error=google_expired");
    return res.render("link-account", { email: pending.email, accountVerified: pending.accountVerified === true, error: null });
  }

  async function finishLink(req, res, result, method) {
    const pending = req.session.pendingGoogle;
    delete req.session.pendingGoogle;
    forget(result.user._id);
    recordEvent(result.user._id, "account_linked", { method, passwordRemoved: !!result.passwordRemoved });
    return finishLogin(req, res, result.user, { nativeNonce: pending && pending.nativeNonce });
  }

  async function linkPassword(req, res) {
    res.set("Cache-Control", "no-store");
    const pending = pendingFrom(req);
    if (!pending) return res.redirect("/login?error=google_expired");
    try {
      const result = await policy.linkWithPassword({ User }, pending, req.body?.password);
      if (!result.ok) {
        return res.status(result.reason === "bad_password" ? 401 : 409)
          .render("link-account", { email: pending.email, accountVerified: pending.accountVerified === true, error: LINK_MESSAGES[result.reason] || LINK_MESSAGES.expired });
      }
      return finishLink(req, res, result, "password");
    } catch (err) {
      console.error(`[AUTH] link (password) failed: ${err.message}`);
      return res.status(500).render("link-account", { email: pending.email, accountVerified: pending.accountVerified === true, error: "Something went wrong. Try again." });
    }
  }

  async function linkClaim(req, res) {
    res.set("Cache-Control", "no-store");
    const pending = pendingFrom(req);
    if (!pending) return res.redirect("/login?error=google_expired");
    if (req.body?.confirm !== "yes") {
      return res.status(400).render("link-account", { email: pending.email, accountVerified: pending.accountVerified === true, error: "Tick the box to confirm." });
    }
    try {
      const result = await policy.claimWithGoogle({ User }, pending);
      if (!result.ok) {
        return res.status(409).render("link-account", { email: pending.email, accountVerified: pending.accountVerified === true, error: LINK_MESSAGES[result.reason] || LINK_MESSAGES.expired });
      }
      return finishLink(req, res, result, "google-claim");
    } catch (err) {
      console.error(`[AUTH] link (claim) failed: ${err.message}`);
      return res.status(500).render("link-account", { email: pending.email, accountVerified: pending.accountVerified === true, error: "Something went wrong. Try again." });
    }
  }

  /**
   * After the Google strategy declined to sign in (link required): move the
   * pending identity into a FRESH session id, so a planted pre-login session
   * id cannot be used to complete the claim, then send the person to /auth/link.
   */
  function startLink(req, res, decision) {
    const nativeNonce = req.session && req.session.nativeReturn ? req.session.nativeNonce : undefined;
    req.session.regenerate((err) => {
      if (err) return res.redirect("/login?error=google_failed");
      req.session.pendingGoogle = { ...decision.pending, accountVerified: decision.accountVerified === true, ...(nativeNonce ? { nativeNonce } : {}) };
      req.session.save(() => res.redirect("/auth/link"));
    });
  }

  return { signup, verifyForm, verifySubmit, linkForm, linkPassword, linkClaim, startLink, VERIFY_MESSAGES, LINK_MESSAGES };
}

module.exports = { createAuthHandlers };
