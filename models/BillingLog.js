"use strict";
const mongoose = require("mongoose");

const billingLogSchema = new mongoose.Schema(
  {
    user:   { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },  // nullable for orphans
    plan:   { type: String, enum: ["free","starter","pro","team"], required: true },
    amount: { type: Number, default: 0 },   // paise (INR × 100)
    event:  { type: String, required: true },
    status: { type: String, enum: ["success","failed","pending","refunded"], default: "pending" },

    // Cashfree payment session IDs (current)
    cashfreeOrderId:   { type: String, default: null },
    cashfreePaymentId: { type: String, default: null },

    // Legacy Cashfree subscription IDs (v1 migration compatibility)
    cashfreeSubscriptionId: { type: String, default: null },

    // Legacy Razorpay IDs (historical billing log compatibility)
    razorpaySubscriptionId: { type: String, default: null },
    razorpayPaymentId:      { type: String, default: null },
    razorpayOrderId:        { type: String, default: null },

    // Idempotency key — unique per webhook delivery
    webhookId: {
  type: String,
  default: undefined,
  index: {
    unique: true,
    sparse: true
  }
},

    metadata:  { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

billingLogSchema.index({ cashfreeOrderId: 1 });
billingLogSchema.index({ createdAt: -1 });

module.exports =
  mongoose.models.BillingLog ||
  mongoose.model("BillingLog", billingLogSchema);