"use strict";
/**
 * models/WebhookLog.js
 * AQUIPLEX v2 — Deduplicate Razorpay webhook deliveries.
 *
 * TTL index auto-deletes entries after 30 days (they're only needed for replay prevention).
 */

const mongoose = require("mongoose");

const webhookLogSchema = new mongoose.Schema(
  {
    // Razorpay doesn't send a webhook ID — use razorpay_payment_id as idempotency key
    // For order.paid: razorpay_order_id + razorpay_payment_id
    idempotencyKey: { type: String, required: true, unique: true },

    event:   { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed },
    handled: { type: Boolean, default: false },
    error:   { type: String,  default: null },
  },
  { timestamps: true }
);

// Auto-expire after 30 days — sufficient for replay protection
webhookLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports =
  mongoose.models.WebhookLog ||
  mongoose.model("WebhookLog", webhookLogSchema);
