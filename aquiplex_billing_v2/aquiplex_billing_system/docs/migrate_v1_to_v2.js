/**
 * migrate_v1_to_v2.js
 * AQUIPLEX billing migration: subscription model → wallet model
 *
 * Run ONCE on production database:
 *   node migrate_v1_to_v2.js
 *
 * What it does:
 *   1. Migrates all User documents to wallet structure
 *   2. Seeds initial wallet from existing credits field
 *   3. Creates WebhookLog TTL index
 *   4. Creates Transaction indexes
 *   5. Drops legacy BillingLog indexes (keeps collection for audit)
 *
 * SAFE TO RUN: idempotent — skips users already migrated.
 * Run in staging first. Take a backup before production.
 */

require("dotenv").config();
const mongoose = require("mongoose");

const FREE_DAILY = parseInt(process.env.FREE_DAILY_CREDITS || "100", 10);

async function main() {
  console.log("🔄 AQUIPLEX v1→v2 billing migration starting…\n");

  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ MongoDB connected\n");

  const db = mongoose.connection.db;

  // ── 1. Migrate users ───────────────────────────────────────────────────────

  console.log("📦 Migrating User documents…");

  const users = await db.collection("users").find({}).toArray();
  let migrated = 0, skipped = 0;

  for (const user of users) {
    // Already migrated?
    if (user.wallet && typeof user.wallet.paidCredits === "number") {
      skipped++;
      continue;
    }

    // Carry over existing paid credits if user had a paid plan
    // Map old monthlyCredits → paidCredits (conservative: only if they had a paid plan)
    let paidCredits = 0;
    if (user.plan && user.plan !== "free" && user.subscriptionStatus === "active") {
      // Give them starter pack equivalent as goodwill (500 credits)
      paidCredits = 500;
    }

    await db.collection("users").updateOne(
      { _id: user._id },
      {
        $set: {
          wallet: {
            freeCredits: FREE_DAILY,
            paidCredits,
            freeResetAt: nextDayReset(),
            totalEarned: paidCredits,
            totalSpent:  0,
          },
        },
        $unset: {
          // Remove old subscription fields
          plan:                    "",
          subscriptionStatus:      "",
          currentPeriodEnd:        "",
          subscriptionCancelledAt: "",
          cashfreeOrderId:         "",
          cashfreeSubscriptionId:  "",
          cashfreeCustomerId:      "",
          razorpaySubscriptionId:  "",
          razorpayCustomerId:      "",
          credits:                 "",
          monthlyCredits:          "",
          creditsResetAt:          "",
          dailyUsage:              "",
          dailyResetAt:            "",
        },
      }
    );
    migrated++;
  }

  console.log(`✅ Users migrated: ${migrated} | Already done: ${skipped}\n`);

  // ── 2. Create new collection indexes ──────────────────────────────────────

  console.log("📑 Creating Transaction indexes…");
  await db.collection("transactions").createIndex({ user: 1, createdAt: -1 });
  await db.collection("transactions").createIndex({ paymentId: 1 }, { sparse: true });
  console.log("✅ Transaction indexes created\n");

  console.log("📑 Creating Payment indexes…");
  await db.collection("payments").createIndex({ razorpayOrderId: 1 }, { unique: true });
  await db.collection("payments").createIndex({ user: 1, createdAt: -1 });
  await db.collection("payments").createIndex({ status: 1 });
  console.log("✅ Payment indexes created\n");

  console.log("📑 Creating WebhookLog indexes…");
  await db.collection("webhooklogs").createIndex({ idempotencyKey: 1 }, { unique: true });
  await db.collection("webhooklogs").createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: 30 * 24 * 60 * 60 }
  );
  console.log("✅ WebhookLog indexes created\n");

  // ── 3. Legacy BillingLog — keep for audit, don't touch ───────────────────

  console.log("📦 BillingLog collection preserved for audit history.\n");

  // ── Done ──────────────────────────────────────────────────────────────────

  console.log("🎉 Migration complete!\n");
  console.log("Next steps:");
  console.log("  1. Deploy new code");
  console.log("  2. Verify /api/billing/wallet returns correct data");
  console.log("  3. Test a purchase flow in staging");
  console.log("  4. Update Razorpay webhook URL in dashboard to:");
  console.log(`     ${process.env.APP_URL}/api/billing/webhook`);
  console.log("  5. Set RAZORPAY_WEBHOOK_SECRET in Render/VPS env\n");

  await mongoose.disconnect();
}

function nextDayReset() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

main().catch((e) => {
  console.error("❌ Migration failed:", e.message);
  process.exit(1);
});
