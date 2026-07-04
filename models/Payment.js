"use strict";
/**
 * models/Payment.js
 * AQUIPLEX v2 — Razorpay one-time payment record.
 *
 * CRITICAL INDEX NOTES:
 *   - webhookId MUST NOT have default: null — MongoDB indexes null in sparse+unique indexes.
 *   - webhookId sparse+unique defined ONLY at schema field level (not via paymentSchema.index()).
 *   - razorpayPaymentId sparse index defined at field level, no default: null.
 *   - This file is the SINGLE authoritative Payment model.
 */

const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    user: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "User",
      required: true,
      index:    true,
    },

    // Credit pack identifier
    packId: {
      type:     String,
      enum:     ["starter", "growth", "pro", "max"],
      required: true,
    },

    // Amount in paise (₹49 = 4900 paise)
    amountPaise:  { type: Number, required: true },
    creditsToAdd: { type: Number, required: true },

    // Razorpay identifiers
    razorpayOrderId: {
      type:     String,
      required: true,
      unique:   true,
    },

    // sparse: true → field OMITTED from index when value is absent (undefined).
    // DO NOT set default: null — null is indexed and causes E11000 on second null.
    razorpayPaymentId: {
      type:   String,
      sparse: true,
      unique: false, // not unique — retries may reuse same paymentId
    },

    razorpaySignature: { type: String },

    status: {
      type:    String,
      enum:    ["created", "pending", "success", "failed"],
      default: "created",
      index:   true,
    },

    // Set when webhook/verify confirms payment
    paidAt: { type: Date },

    // Idempotency — prevent double credit on duplicate webhooks.
    // sparse: true → documents WITHOUT webhookId are excluded from unique index.
    // NEVER set default: null — that defeats the sparse index entirely.
    webhookId: {
      type:   String,
      sparse: true,
      unique: true,
    },

    // Set atomically when credits are added — primary idempotency guard.
    creditedAt: { type: Date },

    // Failure info
    failureReason: { type: String },

    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

// Compound index for payment history queries
paymentSchema.index({ user: 1, createdAt: -1 });

// NOTE: razorpayOrderId unique index is defined inline above (unique: true).
// DO NOT add paymentSchema.index({ razorpayOrderId: 1 }) here — duplicate index warning.

// NOTE: webhookId sparse+unique is defined inline above.
// DO NOT add paymentSchema.index({ webhookId: 1 }, { unique: true, sparse: true }) here.
// Defining it both inline AND via paymentSchema.index() creates duplicate conflicting indexes.

module.exports =
  mongoose.models.Payment ||
  mongoose.model("Payment", paymentSchema);
