"use strict";
/**
 * utils/startup.js
 * AQUIPLEX — Startup validation and index self-healing.
 *
 * Call await runStartupChecks() inside startServer() after connectDB().
 *
 * Self-heals:
 *   - Drops bad webhookId indexes (non-sparse, or sparse with null entries)
 *   - Recreates correct sparse+unique index
 *   - Validates required env variables
 *   - Logs index health report
 */

const mongoose = require("mongoose");

// ── Env validation ────────────────────────────────────────────────────────────

const REQUIRED_ENV = [
  "MONGO_URI",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "SESSION_SECRET",
];

function validateEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error("❌ STARTUP FAILED — Missing required env variables:");
    missing.forEach((k) => console.error(`   - ${k}`));
    process.exit(1);
  }
  console.log("✅ Env vars validated");
}

// ── Index self-healing ────────────────────────────────────────────────────────

/**
 * fixPaymentIndexes
 *
 * Inspects the payments collection for:
 *   1. Any webhookId index that is NOT sparse (causes E11000 on null)
 *   2. Duplicate index definitions for webhookId
 *
 * Drops bad indexes, then ensures correct index exists.
 */
async function fixPaymentIndexes() {
  const db = mongoose.connection.db;
  if (!db) {
    console.warn("⚠️  fixPaymentIndexes: mongoose not connected");
    return;
  }

  const collection = db.collection("payments");
  let indexes;
  try {
    indexes = await collection.indexes();
  } catch (err) {
    console.warn("⚠️  fixPaymentIndexes: could not list indexes:", err.message);
    return;
  }

  console.log(`📋 payments indexes found: ${indexes.length}`);

  const webhookIndexes = indexes.filter(
    (idx) => idx.key && idx.key.webhookId !== undefined
  );

  let needsDrop = false;
  for (const idx of webhookIndexes) {
    const isSparse = !!idx.sparse;
    const isUnique = !!idx.unique;
    const name     = idx.name;

    if (!isSparse) {
      console.warn(`⚠️  BAD INDEX: ${name} on webhookId is NOT sparse. Dropping...`);
      needsDrop = true;
      try {
        await collection.dropIndex(name);
        console.log(`✅ Dropped bad index: ${name}`);
      } catch (e) {
        console.error(`❌ Failed to drop index ${name}:`, e.message);
      }
    } else if (!isUnique) {
      console.warn(`⚠️  BAD INDEX: ${name} on webhookId is sparse but NOT unique. Dropping...`);
      needsDrop = true;
      try {
        await collection.dropIndex(name);
        console.log(`✅ Dropped bad index: ${name}`);
      } catch (e) {
        console.error(`❌ Failed to drop index ${name}:`, e.message);
      }
    } else {
      console.log(`✅ webhookId index OK: ${name} (sparse=${isSparse} unique=${isUnique})`);
    }
  }

  // Purge null webhookId values from existing documents (from before the fix)
  // Set null → undefined (unset) so sparse index excludes them
  try {
    const result = await collection.updateMany(
      { webhookId: null },
      { $unset: { webhookId: "" } }
    );
    if (result.modifiedCount > 0) {
      console.log(`✅ Cleared ${result.modifiedCount} documents with webhookId=null`);
    }
  } catch (e) {
    console.warn("⚠️  Could not clear null webhookIds:", e.message);
  }

  // Also clear null razorpayPaymentId values (sparse index field)
  try {
    await collection.updateMany(
      { razorpayPaymentId: null },
      { $unset: { razorpayPaymentId: "" } }
    );
  } catch (_) {}

  // Let Mongoose sync indexes (creates missing ones, no-ops on existing correct ones)
  try {
    const Payment = require("../models/Payment");
    await Payment.syncIndexes();
    console.log("✅ Payment model indexes synced");
  } catch (e) {
    console.error("❌ Payment.syncIndexes() failed:", e.message);
  }
}

/**
 * fixWebhookLogIndexes
 * Ensures WebhookLog idempotencyKey index is healthy.
 */
async function fixWebhookLogIndexes() {
  try {
    const WebhookLog = require("../models/WebhookLog");
    await WebhookLog.syncIndexes();
    console.log("✅ WebhookLog model indexes synced");
  } catch (e) {
    console.error("❌ WebhookLog.syncIndexes() failed:", e.message);
  }
}

// ── Main entry ────────────────────────────────────────────────────────────────

async function runStartupChecks() {
  console.log("─────────────────────────────────────────────");
  console.log("🔍 AQUIPLEX STARTUP CHECKS");
  console.log("─────────────────────────────────────────────");

  // 1. Env validation (exits process if missing critical vars)
  validateEnv();

  // 2. Razorpay key health (log only — don't exit, prod may be read-only env)
  console.log(`RAZORPAY_KEY_ID:         ${process.env.RAZORPAY_KEY_ID       ? "✅ OK" : "❌ MISSING"}`);
  console.log(`RAZORPAY_KEY_SECRET:     ${process.env.RAZORPAY_KEY_SECRET   ? "✅ OK" : "❌ MISSING"}`);
  console.log(`RAZORPAY_WEBHOOK_SECRET: ${process.env.RAZORPAY_WEBHOOK_SECRET ? "✅ OK" : "❌ MISSING"}`);
  console.log(`APP_URL:                 ${process.env.APP_URL || "⚠️  not set"}`);

  // 3. Database index self-healing
  await fixPaymentIndexes();
  await fixWebhookLogIndexes();

  console.log("─────────────────────────────────────────────");
  console.log("✅ Startup checks complete");
  console.log("─────────────────────────────────────────────");
}

module.exports = { runStartupChecks, validateEnv, fixPaymentIndexes };
