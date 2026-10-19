"use strict";
/**
 * models/PendingSignup.js — an email/password signup that has not yet proved
 * ownership of its address (2026-10-19).
 *
 * WHY A SEPARATE COLLECTION, NOT AN UNVERIFIED User
 * -------------------------------------------------
 * The pre-account takeover worked because /signup created a real User for an
 * address nobody had proved they own; a later Google login for that address
 * landed in it. A pending signup is not an account: it cannot sign in, holds
 * no data, and blocks nobody — every attempt gets its own record with its own
 * password, and only the one whose link is completed (by someone who also
 * knows that record's password) becomes a User.
 *
 * Only a sha256 of the token is stored, so a database read does not yield a
 * usable link. Records expire (TTL index) and are single-use (`usedAt`).
 */
const mongoose = require("mongoose");

const pendingSignupSchema = new mongoose.Schema(
  {
    email:          { type: String, required: true, lowercase: true, trim: true, index: true },
    passwordHash:   { type: String, required: true },
    tokenHash:      { type: String, required: true, unique: true },
    expiresAt:      { type: Date, required: true },
    usedAt:         { type: Date, default: null },
    failedAttempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Mongo removes a record shortly after it expires; until then the code treats
// it as expired itself (the TTL monitor runs about once a minute).
pendingSignupSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.PendingSignup || mongoose.model("PendingSignup", pendingSignupSchema);
