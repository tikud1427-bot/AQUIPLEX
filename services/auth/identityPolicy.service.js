"use strict";
/**
 * services/auth/identityPolicy.service.js — who may sign in to which account
 * (2026-10-19).
 *
 * THE DEFECT THIS REPLACES (pre-account takeover, reproduced on origin/main)
 * -------------------------------------------------------------------------
 * /signup created a usable account for any address without proving the caller
 * owned it, and Google sign-in then attached to WHATEVER account had that
 * email string (`User.findOne({ email })`). An attacker registered
 * victim@… with a password of their choosing; the victim's first Google login
 * landed in that account; the attacker's password kept opening it.
 *
 * THE POLICY
 * ----------
 * 1. An address is trusted only once ownership is proved: by completing an
 *    emailed link (which also asks for the password chosen at signup, so a
 *    victim clicking an attacker-initiated link creates nothing), or by Google
 *    reporting `email_verified`.
 * 2. Google sign-in finds an account by its Google identity (`sub`), never by
 *    email alone. An email match is used only for:
 *      - no account at all → create one, bound to this Google identity;
 *      - a legacy account that only Google sign-in could have created (the
 *        "google-oauth" sentinel, no googleId yet) → bind it;
 *      - a PASSWORD account → nothing happens automatically. The person must
 *        explicitly choose, on /auth/link: prove the password (link Google),
 *        or claim the account with Google — which, when the address was never
 *        verified, REMOVES the unverified password and signs out every other
 *        session, so a squatter loses access.
 * 3. One Google identity ↔ at most one account (unique index), and an account
 *    bound to one Google identity refuses another.
 * 4. Every security-sensitive change bumps `authVersion`; sessions created
 *    before it are ended by `enforceAuthVersion`.
 *
 * Pure decisions over injected models: routes live in authRoutes.service.js.
 */
const crypto = require("crypto");
const bcrypt = require("bcrypt");

const GOOGLE_SENTINEL = "google-oauth";
const SIGNUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const PENDING_GOOGLE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_PER_EMAIL_PER_HOUR = 3;
const MAX_VERIFY_ATTEMPTS = 5;
const MIN_PASSWORD_LENGTH = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normalizeEmail = (e) => String(e || "").trim().toLowerCase();
const hashToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("base64url");
const isPasswordAccount = (u) => !!u && typeof u.password === "string" && u.password !== GOOGLE_SENTINEL;

/** Validate the identity claims Google returned. */
function googleIdentity(profile) {
  const googleId = profile && typeof profile.id === "string" && profile.id ? profile.id : null;
  if (!googleId) return { ok: false, reason: "missing_subject" };
  const entry = profile.emails && profile.emails[0];
  const email = normalizeEmail(entry && entry.value);
  if (!email || !EMAIL_RE.test(email)) return { ok: false, reason: "missing_email" };
  const verified = entry.verified === true || entry.verified === "true";
  if (!verified) return { ok: false, reason: "unverified_email" };
  return { ok: true, googleId, email };
}

/**
 * Decide what a Google sign-in may do.
 * @returns {Promise<{kind:'login'|'created', user, migrated?:boolean}
 *   | {kind:'link-required', pending:{googleId,email,at}, accountVerified:boolean}
 *   | {kind:'rejected', reason:string}>}
 */
async function resolveGoogleLogin({ User }, profile) {
  const id = googleIdentity(profile);
  if (!id.ok) return { kind: "rejected", reason: id.reason };

  const bound = await User.findOne({ googleId: id.googleId });
  if (bound) return { kind: "login", user: bound };

  const byEmail = await User.findOne({ email: id.email });
  if (!byEmail) {
    try {
      const user = await User.create({
        email: id.email, password: GOOGLE_SENTINEL, googleId: id.googleId,
        emailVerified: true, emailVerifiedAt: new Date(), emailVerifiedVia: "google",
      });
      return { kind: "created", user };
    } catch (err) {
      if (err && err.code === 11000) {
        // Two sign-ins for the same new identity raced; the other one won.
        const winner = await User.findOne({ googleId: id.googleId });
        if (winner) return { kind: "login", user: winner };
        return { kind: "rejected", reason: "conflicting_identity" };
      }
      throw err;
    }
  }

  if (byEmail.googleId && byEmail.googleId !== id.googleId) {
    return { kind: "rejected", reason: "conflicting_identity" };
  }

  if (!isPasswordAccount(byEmail)) {
    // Legacy Google-created account (only the Google path writes the sentinel).
    const migrated = await User.findOneAndUpdate(
      { _id: byEmail._id, password: GOOGLE_SENTINEL, $or: [{ googleId: null }, { googleId: { $exists: false } }] },
      { $set: { googleId: id.googleId, emailVerified: true, emailVerifiedAt: byEmail.emailVerifiedAt || new Date(), emailVerifiedVia: "google" } },
      { new: true }
    );
    if (!migrated) return { kind: "rejected", reason: "conflicting_identity" };
    return { kind: "login", user: migrated, migrated: true };
  }

  return {
    kind: "link-required",
    pending: { googleId: id.googleId, email: id.email, at: Date.now() },
    accountVerified: byEmail.emailVerified === true,
  };
}

function pendingIsFresh(pending, now = Date.now()) {
  return !!pending && typeof pending.googleId === "string" && typeof pending.email === "string"
    && typeof pending.at === "number" && now - pending.at <= PENDING_GOOGLE_TTL_MS && now >= pending.at;
}

async function googleIdTakenElsewhere(User, googleId, userId) {
  return !!(await User.exists({ googleId, _id: { $ne: userId } }));
}

/**
 * Path A on /auth/link: the person knows the account's password → link this
 * Google identity to it. Google has verified the address, so the account
 * becomes verified too. Other sessions end.
 */
async function linkWithPassword({ User }, pending, password) {
  if (!pendingIsFresh(pending)) return { ok: false, reason: "expired" };
  const user = await User.findOne({ email: pending.email });
  if (!isPasswordAccount(user)) return { ok: false, reason: "bad_password" };
  const match = typeof password === "string" && password.length > 0 && await bcrypt.compare(password, user.password);
  if (!match) return { ok: false, reason: "bad_password" };
  return bindGoogle(User, user, pending, { removePassword: false });
}

/**
 * Path B on /auth/link: claim the account with Google alone. Allowed because
 * Google has just proved the person controls the address — the same proof a
 * password-reset email would give. If the address was NEVER verified, the
 * password on the account may be a squatter's, so it is removed.
 */
async function claimWithGoogle({ User }, pending) {
  if (!pendingIsFresh(pending)) return { ok: false, reason: "expired" };
  const user = await User.findOne({ email: pending.email });
  if (!user) return { ok: false, reason: "gone" };
  return bindGoogle(User, user, pending, { removePassword: user.emailVerified !== true });
}

/**
 * @param {{removePassword:boolean, verifiesEmail?:boolean}} opts
 *   verifiesEmail: the Google address IS the account's address, so Google's
 *   verification proves ownership of the account's email too.
 */
async function bindGoogle(User, user, pending, { removePassword, verifiesEmail = true }) {
  if (user.googleId && user.googleId !== pending.googleId) return { ok: false, reason: "conflicting_identity" };
  if (await googleIdTakenElsewhere(User, pending.googleId, user._id)) return { ok: false, reason: "conflicting_identity" };
  const set = { googleId: pending.googleId };
  if (verifiesEmail) Object.assign(set, { emailVerified: true, emailVerifiedAt: new Date(), emailVerifiedVia: "google" });
  if (removePassword) set.password = GOOGLE_SENTINEL;
  try {
    const updated = await User.findOneAndUpdate(
      { _id: user._id, $or: [{ googleId: null }, { googleId: { $exists: false } }, { googleId: pending.googleId }] },
      { $set: set, $inc: { authVersion: 1 } },
      { new: true }
    );
    if (!updated) return { ok: false, reason: "conflicting_identity" };
    return { ok: true, user: updated, passwordRemoved: !!removePassword };
  } catch (err) {
    if (err && err.code === 11000) return { ok: false, reason: "conflicting_identity" };
    throw err;
  }
}

/**
 * A SIGNED-IN owner links a Google identity from their account. If the Google
 * address differs from the account's, the account must already be verified,
 * and the Google address must not belong to another account.
 */
async function linkGoogleToAccount({ User }, userId, identity) {
  if (!identity || !identity.ok) return { ok: false, reason: (identity && identity.reason) || "unverified_email" };
  const user = await User.findById(userId);
  if (!user) return { ok: false, reason: "gone" };
  if (user.googleId === identity.googleId) return { ok: true, user, unchanged: true };
  if (identity.email !== normalizeEmail(user.email)) {
    if (user.emailVerified !== true) return { ok: false, reason: "verify_first" };
    if (await User.exists({ email: identity.email, _id: { $ne: user._id } })) return { ok: false, reason: "conflicting_identity" };
  }
  // A different Google address proves nothing about the account's own address.
  return bindGoogle(User, user, { googleId: identity.googleId, email: identity.email },
    { removePassword: false, verifiesEmail: identity.email === normalizeEmail(user.email) });
}

/** Validation shared by the signup form; null = acceptable. */
function signupInputError(email, password) {
  if (typeof email !== "string" || typeof password !== "string" || !email || !password) return "Enter an email and a password.";
  if (!EMAIL_RE.test(email.trim())) return "That email address doesn't look right.";
  if (password.length < MIN_PASSWORD_LENGTH) return `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 200) return "That password is too long.";
  return null;
}

/**
 * Start an email/password signup. Always resolves { sent: true } for valid
 * input — whether the address is new, already has an account, or has hit the
 * hourly cap — so the response never reveals which addresses exist.
 */
async function startSignup({ User, PendingSignup, sendMail, baseUrl }, { email, password }) {
  const address = normalizeEmail(email);
  const existing = await User.findOne({ email: address }).select("_id").lean();
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await PendingSignup.countDocuments({ email: address, createdAt: { $gt: since } });
  if (recent >= MAX_PENDING_PER_EMAIL_PER_HOUR) return { sent: true, delivered: false, capped: true };

  // Hash BEFORE branching. Only the new-address path needs the hash, but if
  // only it paid bcrypt's cost the response TIME would say which addresses
  // have accounts (measured: 12 ms existing vs 856 ms new before this line).
  const passwordHash = await bcrypt.hash(password, 12);

  if (existing) {
    // Recorded as an already-used marker so notices count toward the hourly cap
    // (kept for the hour the cap looks back over, then removed by the TTL index).
    await PendingSignup.create({ email: address, passwordHash: "-", tokenHash: hashToken(newToken()), expiresAt: new Date(Date.now() + 60 * 60 * 1000), usedAt: new Date() });
    const delivered = await sendMail({
      to: address,
      subject: "Someone tried to create an Aquiplex account with this address",
      text: `An account already exists for this email address.\n\nLog in: ${baseUrl}/login\n\nIf this wasn't you, you can ignore this message — nothing has changed.`,
    });
    return { sent: true, delivered };
  }

  const token = newToken();
  await PendingSignup.create({
    email: address,
    passwordHash,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + SIGNUP_TOKEN_TTL_MS),
  });
  const delivered = await sendMail({
    to: address,
    subject: "Confirm your email to finish creating your Aquiplex account",
    text: `Open this link and enter the password you chose to finish creating your account:\n\n${baseUrl}/verify-email?token=${token}\n\nThe link works once and expires in 24 hours. If you didn't sign up, ignore this message.`,
  });
  return { sent: true, delivered };
}

/**
 * Complete a signup from its link. The password chosen at signup is required:
 * whoever opens the link must also be whoever started the signup.
 * @returns {Promise<{ok:true,user}|{ok:false,reason:'invalid'|'used'|'expired'|'locked'|'bad_password'|'exists'}>}
 */
async function completeSignup({ User, PendingSignup }, { token, password }) {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return { ok: false, reason: "invalid" };
  const rec = await PendingSignup.findOne({ tokenHash: hashToken(token) });
  if (!rec) return { ok: false, reason: "invalid" };
  if (rec.usedAt) return { ok: false, reason: "used" };
  if (rec.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };
  if (rec.failedAttempts >= MAX_VERIFY_ATTEMPTS) return { ok: false, reason: "locked" };

  const match = typeof password === "string" && password.length > 0 && await bcrypt.compare(password, rec.passwordHash);
  if (!match) {
    await PendingSignup.updateOne({ _id: rec._id }, { $inc: { failedAttempts: 1 } });
    return { ok: false, reason: "bad_password" };
  }

  // Single use, race-safe: exactly one request can stamp usedAt.
  const claimed = await PendingSignup.findOneAndUpdate(
    { _id: rec._id, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
    { new: true }
  );
  if (!claimed) return { ok: false, reason: "used" };

  let user;
  try {
    user = await User.create({
      email: rec.email, password: rec.passwordHash,
      emailVerified: true, emailVerifiedAt: new Date(), emailVerifiedVia: "email",
    });
  } catch (err) {
    if (err && err.code === 11000) return { ok: false, reason: "exists" };
    throw err;
  }
  // Any other signup started for this address is void now.
  await PendingSignup.deleteMany({ email: rec.email, _id: { $ne: rec._id } });
  return { ok: true, user };
}

/**
 * Express middleware: end any session older than its account's authVersion.
 * Placed after passport.session(). The version is cached per process for
 * `ttlMs`, so a change made on another instance takes effect within that
 * window; `forget(userId)` makes it immediate on this one.
 */
function enforceAuthVersion({ User, ttlMs = 5000 }) {
  const cache = new Map();
  const mw = async (req, res, next) => {
    const id = req.session && req.session.userId;
    if (!id) return next();
    try {
      let current;
      if (req.user && String(req.user._id) === String(id) && typeof req.user.authVersion !== "undefined") {
        current = req.user.authVersion || 0;
      } else {
        const hit = cache.get(String(id));
        if (hit && Date.now() - hit.at < ttlMs) current = hit.v;
        else {
          const u = await User.findById(id).select("authVersion").lean();
          current = u ? (u.authVersion || 0) : null;
          cache.set(String(id), { v: current, at: Date.now() });
        }
      }
      if (current !== null && current === (req.session.authVersion || 0)) return next();
      // Stale (or deleted account): continue as signed out.
      return req.session.regenerate((err) => {
        if (err) return next(err);
        req.user = null;
        if (res.locals) res.locals.user = null;
        next();
      });
    } catch (err) {
      // Availability over strictness during a database fault: the session is
      // left as is (a revoked session survives only while the DB is down).
      console.error(`[AUTH] authVersion check failed: ${err.message}`);
      return next();
    }
  };
  mw.forget = (userId) => cache.delete(String(userId));
  return mw;
}

/** Record the account's current authVersion on the session. */
function stampSession(req, user) {
  req.session.authVersion = (user && user.authVersion) || 0;
}

module.exports = {
  GOOGLE_SENTINEL, PENDING_GOOGLE_TTL_MS, SIGNUP_TOKEN_TTL_MS, MAX_VERIFY_ATTEMPTS, MIN_PASSWORD_LENGTH,
  normalizeEmail, hashToken, googleIdentity, resolveGoogleLogin, pendingIsFresh,
  linkWithPassword, claimWithGoogle, linkGoogleToAccount,
  signupInputError, startSignup, completeSignup,
  enforceAuthVersion, stampSession, isPasswordAccount,
};
