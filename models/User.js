"use strict";
/**
 * models/User.js
 * AQUIPLEX v2 — Prepaid Credits / Wallet Model
 *
 * BREAKING CHANGES from v1:
 *   - Removed: plan, subscriptionStatus, currentPeriodEnd, subscriptionCancelledAt
 *   - Removed: cashfreeOrderId, cashfreeSubscriptionId, cashfreeCustomerId
 *   - Removed: razorpaySubscriptionId, razorpayCustomerId
 *   - Removed: monthlyCredits, creditsResetAt (no monthly allocation)
 *   - Added:   wallet.freeCredits     — today's free quota (resets daily)
 *   - Added:   wallet.paidCredits     — purchased credits (never expire)
 *   - Added:   wallet.freeResetAt     — next daily reset timestamp
 *   - Added:   wallet.totalEarned     — lifetime paid credits purchased
 *   - Added:   wallet.totalSpent      — lifetime credits consumed
 *
 * Consumption order: freeCredits first → paidCredits
 */

const mongoose = require("mongoose");
const crypto   = require("crypto");
const { isUnlimitedAccount, unlimitedAccessReason } = require("../utils/credits/unlimitedAccess");

const FREE_DAILY_CREDITS = parseInt(process.env.FREE_DAILY_CREDITS || "100", 10);

const walletSchema = new mongoose.Schema(
  {
    freeCredits:  { type: Number, default: FREE_DAILY_CREDITS, min: 0 },
    paidCredits:  { type: Number, default: 0,                  min: 0 },
    freeResetAt:  { type: Date,   default: () => nextDayReset() },
    totalEarned:  { type: Number, default: 0, min: 0 },  // lifetime paid credits added
    totalSpent:   { type: Number, default: 0, min: 0 },  // lifetime credits consumed
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    googleId: { type: String, default: null, sparse: true },
    role: { type: String, default: "user", index: true },
    isUnlimited: { type: Boolean, default: false },

    // ── Wallet ──────────────────────────────────────────────────────────────
    wallet: { type: walletSchema, default: () => ({}) },

    // ── Profile ─────────────────────────────────────────────────────────────
    billingEmail: { type: String, default: null },
    phone:        { type: String, default: null },

    // ── Referral (keep for future) ──────────────────────────────────────────
    referralCode: { type: String, default: null, unique: true, sparse: true },
    referredBy:   { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

// ── Pre-save: generate referral code ─────────────────────────────────────────

userSchema.pre("save", function (next) {
  if (!this.referralCode) {
    this.referralCode = crypto.randomBytes(4).toString("hex").toUpperCase();
  }
  next();
});

// ── Access helpers ────────────────────────────────────────────────────────────

userSchema.methods.isUnlimitedAccount = function () {
  return isUnlimitedAccount(this);
};

userSchema.methods.unlimitedAccessReason = function () {
  return unlimitedAccessReason(this);
};

// ── Wallet methods ─────────────────────────────────────────────────────────────

/**
 * resetFreeCreditsIfNeeded — lazy daily reset.
 * Returns true if reset occurred.
 */
userSchema.methods.resetFreeCreditsIfNeeded = function () {
  if (this.isUnlimitedAccount()) return false;
  const now = new Date();
  if (this.wallet.freeResetAt && now >= this.wallet.freeResetAt) {
    this.wallet.freeCredits = FREE_DAILY_CREDITS;
    this.wallet.freeResetAt = nextDayReset();
    return true;
  }
  return false;
};

/**
 * totalAvailableCredits — free + paid.
 */
userSchema.methods.totalAvailableCredits = function () {
  if (this.isUnlimitedAccount()) return Number.MAX_SAFE_INTEGER;
  this.resetFreeCreditsIfNeeded();
  return this.wallet.freeCredits + this.wallet.paidCredits;
};

/**
 * hasEnoughCredits — check without mutating.
 */
userSchema.methods.hasEnoughCredits = function (cost) {
  if (this.isUnlimitedAccount()) return true;
  this.resetFreeCreditsIfNeeded();
  return this.totalAvailableCredits() >= cost;
};

/**
 * deductCredits — consume free first, then paid.
 * DOES NOT save — caller must save() to allow atomic handling.
 * Throws if insufficient.
 */
userSchema.methods.deductCredits = function (cost) {
  if (this.isUnlimitedAccount()) return;
  this.resetFreeCreditsIfNeeded();
  const total = this.wallet.freeCredits + this.wallet.paidCredits;
  if (total < cost) throw new Error("INSUFFICIENT_CREDITS");

  // Consume free first
  const fromFree = Math.min(this.wallet.freeCredits, cost);
  this.wallet.freeCredits -= fromFree;
  const remainder = cost - fromFree;
  if (remainder > 0) {
    this.wallet.paidCredits -= remainder;
  }
  this.wallet.totalSpent += cost;
};

/**
 * addPaidCredits — add purchased credits, update totalEarned.
 * DOES NOT save — caller must save().
 */
userSchema.methods.addPaidCredits = function (amount) {
  this.wallet.paidCredits += amount;
  this.wallet.totalEarned += amount;
};

/**
 * walletSummary — safe public-facing snapshot.
 */
userSchema.methods.walletSummary = function () {
  this.resetFreeCreditsIfNeeded();
  return {
    freeCredits:  this.wallet.freeCredits,
    paidCredits:  this.wallet.paidCredits,
    totalCredits: this.wallet.freeCredits + this.wallet.paidCredits,
    freeResetAt:  this.wallet.freeResetAt,
    freeDailyMax: FREE_DAILY_CREDITS,
    totalEarned:  this.wallet.totalEarned,
    totalSpent:   this.wallet.totalSpent,
    isUnlimited:  this.isUnlimitedAccount(),
    unlimitedReason: this.unlimitedAccessReason(),
  };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function nextDayReset() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

module.exports = mongoose.model("User", userSchema);
