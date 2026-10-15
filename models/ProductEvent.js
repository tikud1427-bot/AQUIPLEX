"use strict";
/**
 * One product-analytics event. See services/analytics/productEvents.js for
 * what may and may not be recorded (never content). Expires after 400 days;
 * deleted with the account (services/account/accountDeletion.service.js).
 */
const mongoose = require("mongoose");

const productEventSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    event:  { type: String, required: true },
    at:     { type: Date, required: true, default: Date.now },
    props:  { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { versionKey: false }
);

productEventSchema.index({ event: 1, at: 1 });
productEventSchema.index({ at: 1 }, { expireAfterSeconds: 400 * 24 * 3600 });

module.exports = mongoose.models.ProductEvent || mongoose.model("ProductEvent", productEventSchema);
