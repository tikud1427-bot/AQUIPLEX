"use strict";
/**
 * models/EntitlementAudit.js — every change to a privileged entitlement
 * (unlimited credits), who made it and why (2026-10-19).
 *
 * Written by scripts/admin/unlimited-entitlement.js, the only supported way to
 * grant or revoke `isUnlimited`. Append-only by convention: nothing in the app
 * updates or deletes these records.
 */
const mongoose = require("mongoose");

const entitlementAuditSchema = new mongoose.Schema(
  {
    userId:  { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    action:  { type: String, enum: ["grant_unlimited", "revoke_unlimited"], required: true },
    reason:  { type: String, required: true },
    actor:   { type: String, required: true },   // the operator, e.g. an email or initials — not the account's email
    before:  { type: Boolean, default: null },
    after:   { type: Boolean, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.models.EntitlementAudit || mongoose.model("EntitlementAudit", entitlementAuditSchema);
