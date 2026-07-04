"use strict";
/**
 * models/Transaction.js
 * AQUIPLEX v2 — Immutable credit ledger entry.
 *
 * Every credit movement creates one Transaction document.
 * Never update/delete transactions — append-only for audit integrity.
 *
 * Types:
 *   DAILY_FREE_GRANT   — system grants free daily credits (lazy on first use each day)
 *   PURCHASE           — paid pack purchased via Razorpay
 *   DEBIT              — credits consumed by AI action
 *   REFUND             — credits returned after failed generation
 *   ADMIN_ADJUST       — manual admin correction
 *   REFERRAL_BONUS     — future referral reward
 */

const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema(
  {
    user: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "User",
      required: true,
      index:    true,
    },

    type: {
      type:     String,
      enum:     ["DAILY_FREE_GRANT", "PURCHASE", "DEBIT", "REFUND", "ADMIN_ADJUST", "REFERRAL_BONUS"],
      required: true,
      index:    true,
    },

    // Credit movement (positive = gain, negative = spend)
    amount: { type: Number, required: true },

    // Snapshot after this transaction
    balanceAfter: {
      freeCredits: { type: Number, required: true },
      paidCredits: { type: Number, required: true },
    },

    // For PURCHASE transactions — links to Payment
    paymentId: {
      type:  mongoose.Schema.Types.ObjectId,
      ref:   "Payment",
    },

    // For DEBIT transactions — what AI action consumed credits
    actionType:  { type: String, default: null },
    actionCost:  { type: Number, default: null },

    // Description for user-facing history
    description: { type: String, default: "" },

    // Source breakdown (for DEBIT: how many from free vs paid)
    breakdown: {
      fromFree: { type: Number, default: 0 },
      fromPaid: { type: Number, default: 0 },
    },

    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    // No updates allowed — append only
  }
);

transactionSchema.index({ user: 1, createdAt: -1 });
transactionSchema.index({ paymentId: 1 }, { sparse: true });

module.exports =
  mongoose.models.Transaction ||
  mongoose.model("Transaction", transactionSchema);