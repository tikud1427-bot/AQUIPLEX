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
 *   - Added:   wallet.freeFullBuildUsed — tracks if free build was used this cycle
 *   - Added:   wallet.aiEditLockedUntil — AI editing locked until this timestamp
 *
 * Consumption order: freeCredits first → paidCredits
 */

const mongoose = require("mongoose");
const crypto   = require("crypto");
const { hasUnlimitedAccess, unlimitedAccessReason } = require("../utils/credits/unlimitedAccess");
const { getISTDateStr, nextISTMidnight } = require("../utils/date/getISTDayRange");

const FREE_DAILY_CREDITS = parseInt(process.env.FREE_DAILY_CREDITS || "200", 10);

// ── Per-feature daily limits (free tier) ─────────────────────────────────────
const FREE_LIMITS = {
  imageGen:    parseInt(process.env.FREE_LIMIT_IMAGE    || "2",  10),
  codeMode:    parseInt(process.env.FREE_LIMIT_CODE     || "1",  10),
  webSearch:   parseInt(process.env.FREE_LIMIT_SEARCH   || "3",  10),
  websiteGen:  parseInt(process.env.FREE_LIMIT_WEBSITE  || "1",  10),
  websiteEdit: parseInt(process.env.FREE_LIMIT_WEBEDIT  || "2",  10),
};

const dailyUsageSchema = new mongoose.Schema({
  date:        { type: String, default: () => todayStr() }, // "YYYY-MM-DD"
  imageGen:    { type: Number, default: 0, min: 0 },
  codeMode:    { type: Number, default: 0, min: 0 },
  webSearch:   { type: Number, default: 0, min: 0 },
  websiteGen:  { type: Number, default: 0, min: 0 },
  websiteEdit: { type: Number, default: 0, min: 0 },
}, { _id: false });

const walletSchema = new mongoose.Schema(
  {
    freeCredits: {
      type: Number,
      default: FREE_DAILY_CREDITS,
      min: 0,
    },

    paidCredits: {
      type: Number,
      default: 0,
      min: 0,
    },

    freeResetAt: {
      type: Date,
      default: () => nextDayReset(),
    },

    totalEarned: {
      type: Number,
      default: 0,
      min: 0,
    },

    totalSpent: {
      type: Number,
      default: 0,
      min: 0,
    },
  }
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

    // ── Daily feature usage counters (free tier) ─────────────────────────────
    dailyUsage: { type: dailyUsageSchema, default: () => ({}) },

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

userSchema.pre("save", function () {
  if (!this.referralCode) {
    this.referralCode = crypto.randomBytes(4).toString("hex").toUpperCase();
  }
});

// ── Access helpers ────────────────────────────────────────────────────────────

userSchema.methods.hasUnlimitedAccount = function () {
  return hasUnlimitedAccess(this);
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
  if (this.hasUnlimitedAccount()) return false;
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
  if (this.hasUnlimitedAccount()) return Number.MAX_SAFE_INTEGER;
  this.resetFreeCreditsIfNeeded();
  return this.wallet.freeCredits + this.wallet.paidCredits;
};

/**
 * hasEnoughCredits — check without mutating.
 */
userSchema.methods.hasEnoughCredits = function (cost) {
  if (this.hasUnlimitedAccount()) return true;
  this.resetFreeCreditsIfNeeded();
  return this.totalAvailableCredits() >= cost;
};

/**
 * deductCredits — consume free first, then paid.
 * DOES NOT save — caller must save() to allow atomic handling.
 * Throws if insufficient.
 */
userSchema.methods.deductCredits = function (cost) {
  if (this.hasUnlimitedAccount()) return;
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
    isUnlimited:  this.hasUnlimitedAccount(),
    unlimitedReason: this.unlimitedAccessReason(),
    dailyUsage:   this.getDailyUsageSnapshot(),
    freeLimits:   FREE_LIMITS,
  };
};

// ── Daily feature usage methods ───────────────────────────────────────────────

/**
 * resetDailyUsageIfNeeded — lazy daily reset for feature counters.
 */
userSchema.methods.resetDailyUsageIfNeeded = function () {
  const today = todayStr();
  if (!this.dailyUsage || this.dailyUsage.date !== today) {
    this.dailyUsage = {
      date:        today,
      imageGen:    0,
      codeMode:    0,
      webSearch:   0,
      websiteGen:  0,
      websiteEdit: 0,
    };
    return true;
  }
  return false;
};

/**
 * checkFeatureLimit — returns { allowed, used, limit, feature }.
 * Does NOT increment. Call incrementFeatureUsage after successful action.
 */
userSchema.methods.checkFeatureLimit = function (feature) {
  if (this.hasUnlimitedAccount()) return { allowed: true, used: 0, limit: Infinity, feature };
  this.resetDailyUsageIfNeeded();
  const limit = FREE_LIMITS[feature];
  if (limit === undefined) return { allowed: true, used: 0, limit: Infinity, feature };
  const used = this.dailyUsage[feature] || 0;
  return { allowed: used < limit, used, limit, feature };
};

/**
 * incrementFeatureUsage — bump counter. DOES NOT save.
 */
userSchema.methods.incrementFeatureUsage = function (feature) {
  if (this.hasUnlimitedAccount()) return;
  this.resetDailyUsageIfNeeded();
  if (this.dailyUsage[feature] !== undefined) {
    this.dailyUsage[feature] += 1;
  }
};

/**
 * getDailyUsageSnapshot — public snapshot of today's usage + limits.
 */
userSchema.methods.getDailyUsageSnapshot = function () {
  this.resetDailyUsageIfNeeded();
  const snapshot = {};
  for (const [key, limit] of Object.entries(FREE_LIMITS)) {
    snapshot[key] = {
      used:      this.dailyUsage[key] || 0,
      limit,
      remaining: Math.max(0, limit - (this.dailyUsage[key] || 0)),
    };
  }
  return snapshot;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function nextDayReset() {
  // Use IST midnight so Indian users reset at 00:00 IST, not 00:00 UTC (05:30 IST)
  return nextISTMidnight();
}

function todayStr() {
  // Use IST date string so "today" matches the IST calendar day
  return getISTDateStr(); // "YYYY-MM-DD" in IST
}

module.exports = mongoose.model("User", userSchema);