"use strict";
/**
 * routes/billing/billing.routes.js
 * AQUIPLEX — Billing API routes (Batch 5 repaired).
 *
 * Fixed:
 *  - /api/billing/status now returns freeLimits + freeDailyMax + derived plan
 *  - /api/billing/cancel added (was missing — caused JS error on cancel click)
 *  - defensive guards on all responses
 *  - consistent shape: { success, billing|history|... }
 */

const express  = require("express");
const router   = express.Router();

const { createOrder, verifyPayment, getUserPaymentHistory } = require("../../services/billing/razorpay.service");
const {
  getWalletSummary, getTransactionHistory, refreshDailyAllowance,
} = require("../../services/credits/wallet.service");
const { FREE_DAILY_CREDITS } = require("../../utils/credits/freeAllowance");
const { recordProductEvent } = require("../../services/analytics/productEvents");
const { allPacksArray }      = require("../../utils/credits/packs");
const { createLogger }       = require("../../utils/logger");
const User                   = require("../../models/User");
const { hasUnlimitedAccess } = require("../../utils/credits/unlimitedAccess");

const log = createLogger("BILLING_ROUTES");

// ── Auth helper ───────────────────────────────────────────────────────────────

function getUid(req) {
  return (
    req.session?.userId    ||
    req.session?.user?._id ||
    req.user?._id          ||
    req.user?.id           ||
    null
  );
}

function requireLogin(req, res, next) {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ success: false, error: "LOGIN_REQUIRED" });
  req.uid = uid.toString();
  next();
}

/**
 * Derive a display plan string from user fields.
 * The User model removed the `plan` field in v2 — derive from role + isUnlimited.
 */
function derivePlan(user) {
  if (!user) return "free";
  if (user.role === "admin")       return "admin";
  if (user.isUnlimited === true)   return "pro";
  return "free";
}

// ── POST /api/billing/create-order ───────────────────────────────────────────

router.post("/create-order", requireLogin, async (req, res) => {
  try {
    const { packId } = req.body;
    const validPacks = ["starter", "growth", "pro", "max"];
    if (!validPacks.includes(packId)) {
      return res.status(400).json({
        success: false,
        error:   "INVALID_PACK",
        message: "Choose a valid credit pack: starter, growth, pro, or max.",
      });
    }

    const order = await createOrder(req.uid, packId);
    log.info(`Order created: user=${req.uid} pack=${packId} orderId=${order.orderId}`);
    recordProductEvent(req.uid, "checkout_started", { packId, amountPaise: order.amount });
    return res.json({ success: true, order });

  } catch (err) {
    // Razorpay SDK errors are objects ({ statusCode, error }) with no .message;
    // log what there is, never echo provider/config detail to the browser.
    log.error("create-order error:", err?.message || err?.error?.description || err?.statusCode || "unknown");
    recordProductEvent(req.uid, "checkout_failed", { stage: "create_order" });
    return res.status(500).json({
      success: false,
      error:   "ORDER_CREATION_FAILED",
      message: "We couldn't start checkout right now. You haven't been charged — please try again in a moment.",
    });
  }
});

// Verify-payment failures, as the user should read them. A failure here does
// not always mean the payment failed: the webhook is the backup credit path.
const VERIFY_ERRORS = {
  INVALID_SIGNATURE:  { status: 400, message: "We couldn't confirm this payment. If you were charged, your credits will be added automatically once Razorpay confirms it." },
  PAYMENT_NOT_FOUND:  { status: 404, message: "We couldn't find this order. If you were charged, please contact support with your payment ID." },
  PAYMENT_PROCESSING: { status: 409, message: "This payment is already being confirmed. Your credits will appear in a moment." },
};

// ── POST /api/billing/verify-payment ─────────────────────────────────────────

router.post("/verify-payment", requireLogin, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        error:   "MISSING_PARAMS",
        message: "razorpay_order_id, razorpay_payment_id, razorpay_signature required.",
      });
    }

    const result = await verifyPayment(
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      req.uid
    );

    log.info(`Payment verified: user=${req.uid} credits=${result.credits}`);
    return res.json({ success: true, ...result });

  } catch (err) {
    log.error("verify-payment error:", err.message);
    const known = VERIFY_ERRORS[err.message];
    recordProductEvent(req.uid, "checkout_failed", { stage: "verify", code: known ? err.message.toLowerCase() : "server_error" });
    return res.status(known ? known.status : 500).json({
      success: false,
      error:   known ? err.message : "VERIFY_FAILED",
      message: known ? known.message
        : "We couldn't confirm your payment yet. If you were charged, your credits will be added automatically — no need to pay again.",
    });
  }
});

// ── POST /api/billing/event ──────────────────────────────────────────────────
// The three funnel moments only the browser sees. Allow-listed names, no
// free-form properties beyond a pack id — this is not a general event sink.
const CLIENT_EVENTS = new Set(["buy_clicked", "checkout_dismissed", "checkout_failed"]);
const PACK_IDS = new Set(["starter", "growth", "pro", "max"]);

router.post("/event", requireLogin, (req, res) => {
  const name = String(req.body?.event || "");
  if (!CLIENT_EVENTS.has(name)) return res.status(400).json({ success: false, error: "UNKNOWN_EVENT" });
  const packId = PACK_IDS.has(req.body?.packId) ? req.body.packId : undefined;
  recordProductEvent(req.uid, name, { packId, stage: name === "checkout_failed" ? "provider" : undefined });
  return res.status(204).end();
});

// ── GET /api/billing/wallet ───────────────────────────────────────────────────

router.get("/wallet", requireLogin, async (req, res) => {
  try {
    const summary = await getWalletSummary(req.uid);
    return res.json({ success: true, wallet: summary });
  } catch (err) {
    log.error("wallet fetch error:", err.message);
    return res.status(500).json({ success: false, error: "WALLET_FETCH_FAILED" });
  }
});

// ── GET /api/billing/status ───────────────────────────────────────────────────
// Returns: { success, billing: { plan, freeCredits, paidCredits, totalCredits,
//   freeDailyMax, freeResetAt, isUnlimited, dailyUsage, freeLimits } }

router.get("/status", requireLogin, async (req, res) => {
  try {
    // Need Mongoose instance for methods — do NOT use .lean(). The atomic
    // refresh applies today's reset / allowance cap, so this endpoint shows
    // the same free balance the next debit will see (it used to show the raw
    // stored value, e.g. yesterday's leftovers before the lazy reset ran).
    const fullUser = await refreshDailyAllowance(req.uid);

    if (!fullUser) {
      return res.status(404).json({ success: false, error: "USER_NOT_FOUND" });
    }

    // Lazy reset before reading (feature counters; not persisted here)
    fullUser.resetDailyUsageIfNeeded();

    const wallet = fullUser.wallet || {};
    const freeCredits  = Number(wallet.freeCredits  || 0);
    const paidCredits  = Number(wallet.paidCredits  || 0);
    const freeDailyMax = FREE_DAILY_CREDITS;

    // getDailyUsageSnapshot already embeds per-feature limits
    const dailyUsageSnapshot = fullUser.getDailyUsageSnapshot();

    // Build freeLimits from snapshot so frontend can reference it separately
    const freeLimits = {};
    for (const [key, val] of Object.entries(dailyUsageSnapshot)) {
      freeLimits[key] = val.limit;
    }

    return res.json({
      success: true,
      billing: {
        plan:         derivePlan(fullUser),
        freeCredits,
        paidCredits,
        totalCredits: freeCredits + paidCredits,
        freeDailyMax,
        totalEarned:  Number(wallet.totalEarned || 0),
        totalSpent:   Number(wallet.totalSpent  || 0),
        freeResetAt:  wallet.freeResetAt || null,
        isUnlimited:  hasUnlimitedAccess(fullUser),
        dailyUsage:   dailyUsageSnapshot,
        freeLimits,
      },
    });

  } catch (err) {
    log.error("billing status error:", err.message);
    return res.status(500).json({ success: false, error: "STATUS_FETCH_FAILED" });
  }
});

// ── GET /api/billing/history ──────────────────────────────────────────────────

router.get("/history", requireLogin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "30", 10), 100);
    const skip  = Math.max(parseInt(req.query.skip  || "0",  10), 0);

    const history = await getTransactionHistory(req.uid, limit, skip);

    const normalizedHistory = Array.isArray(history)
      ? history.map((tx) => ({
          id:        tx._id   || null,
          type:      tx.type  || "wallet",
          amount:    Number(tx.amount  || 0),
          credits:   Number(tx.credits || tx.amount || 0),
          status:    tx.status    || "completed",
          createdAt: tx.createdAt || null,
        }))
      : [];

    return res.json({ success: true, history: normalizedHistory });

  } catch (err) {
    log.error("history fetch error:", err.message);
    return res.status(500).json({ success: false, error: "HISTORY_FETCH_FAILED", history: [] });
  }
});

// ── POST /api/billing/cancel ──────────────────────────────────────────────────
// Free-tier users have no subscription to cancel; handle gracefully.
// Paid tiers: mark isUnlimited = false (simplified cancel — no Razorpay sub mgmt yet).

router.post("/cancel", requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.uid);
    if (!user) {
      return res.status(404).json({ success: false, error: "USER_NOT_FOUND" });
    }

    if (!hasUnlimitedAccess(user)) {
      return res.status(400).json({
        success: false,
        error:   "NO_ACTIVE_SUBSCRIPTION",
        message: "No active paid subscription to cancel.",
      });
    }

    // Downgrade: revoke unlimited flag
    user.isUnlimited = false;
    await user.save();

    log.info(`Subscription cancelled: user=${req.uid}`);
    return res.json({
      success: true,
      message: "Subscription cancelled. You've been moved to the free plan.",
    });

  } catch (err) {
    log.error("cancel error:", err.message);
    return res.status(500).json({ success: false, error: "CANCEL_FAILED", message: err.message });
  }
});

// ── GET /api/billing/payments ─────────────────────────────────────────────────

router.get("/payments", requireLogin, async (req, res) => {
  try {
    const limit    = Math.min(parseInt(req.query.limit || "20", 10), 50);
    const payments = await getUserPaymentHistory(req.uid, limit);
    return res.json({ success: true, payments: payments || [] });
  } catch (err) {
    log.error("payments fetch error:", err.message);
    return res.status(500).json({ success: false, error: "PAYMENTS_FETCH_FAILED", payments: [] });
  }
});

// ── GET /api/billing/packs ────────────────────────────────────────────────────

router.get("/packs", (req, res) => {
  return res.json({ success: true, packs: allPacksArray(), freeDailyCredits: FREE_DAILY_CREDITS });
});

module.exports = router;
