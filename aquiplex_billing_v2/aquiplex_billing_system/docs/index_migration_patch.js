/**
 * INDEX.JS MIGRATION PATCH
 * ========================
 * Apply these changes to index.js to wire up the v2 billing system.
 * Sections labeled [REMOVE] / [ADD] / [REPLACE].
 */

// ============================================================
// [1] REMOVE — old billing service imports (around line 552)
// ============================================================
// REMOVE THIS LINE:
//   const billingRoutes = require("./routes/billing/billing.routes");
//   app.use("/api/billing", billingRoutes);

// Also REMOVE the Cashfree webhook block (lines ~349–400):
//   app.post("/api/billing/webhook", express.raw({...}), async (req,res) => {
//     ... verifyWebhookSignature / handleWebhookEvent (Cashfree) ...
//   });


// ============================================================
// [2] REPLACE — billing route mount
// IMPORTANT: billing router must mount BEFORE app.use(express.json())
// because the webhook route uses express.raw() internally.
// ============================================================

// FIND this block in index.js (usually near line 274):
//   app.use(express.json());
//   app.use(express.urlencoded({ extended: true }));

// REPLACE WITH:

const billingRoutes = require("./routes/billing/billing.routes"); // v2
// Mount billing BEFORE JSON parsing — webhook needs raw body
app.use("/api/billing", billingRoutes);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));


// ============================================================
// [3] ADD — /wallet page route (near /billing route ~line 1868)
// ============================================================

app.get("/wallet", requireLogin, async (req, res) => {
  try {
    const billingUser = await User.findById(req.session.userId)
      .select("email phone billingEmail wallet referralCode")
      .lean();
    res.render("wallet", { billingUser });
  } catch (err) {
    console.error("[wallet page]", err.message);
    res.status(500).send("Error loading wallet page");
  }
});


// ============================================================
// [4] REPLACE — /billing route (existing ~line 1868)
// Redirect old /billing URL to /wallet
// ============================================================

app.get("/billing", requireLogin, (req, res) => {
  res.redirect("/wallet");
});


// ============================================================
// [5] REPLACE — /pricing route
// Pass user to pricing view (for logged-in state)
// ============================================================

app.get("/pricing", async (req, res) => {
  try {
    const userId = req.session?.userId;
    const user   = userId ? await User.findById(userId).select("email phone").lean() : null;
    res.render("pricing", { user });
  } catch (err) {
    res.status(500).send("Error loading pricing page");
  }
});


// ============================================================
// [6] REPLACE — usageGuard import in all AI route files
// ============================================================
// OLD:
//   const { usageGuard } = require("../../middleware/usage/usageGuard");
//   // usageGuard used plan-based dailyLimit logic
//
// NEW (same import path, same interface, wallet-based):
//   const { usageGuard } = require("../../middleware/usage/usageGuard");
//   // Same API — no changes to route handlers needed
//   // req.creditContext.refund() still works


// ============================================================
// [7] REMOVE — subscription-related cron jobs
// ============================================================
// Remove any setInterval or cron that calls:
//   - runMonthlyResetCron()
//   - checkAndDowngradeIfExpired (bulk)
//   - resetToFreePlan (bulk)
// These no longer apply in the wallet model.


// ============================================================
// [8] ENV VALIDATION (add to startup console.log block ~line 1980)
// ============================================================

console.log(`RAZORPAY_KEY_ID:        ${process.env.RAZORPAY_KEY_ID        ? "✅ OK" : "❌ MISSING"}`);
console.log(`RAZORPAY_KEY_SECRET:    ${process.env.RAZORPAY_KEY_SECRET    ? "✅ OK" : "❌ MISSING"}`);
console.log(`RAZORPAY_WEBHOOK_SECRET:${process.env.RAZORPAY_WEBHOOK_SECRET ? "✅ OK" : "❌ MISSING — webhooks will reject"}`);
console.log(`FREE_DAILY_CREDITS:     ${process.env.FREE_DAILY_CREDITS || "100 (default)"}`);
