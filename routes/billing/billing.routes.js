"use strict";
/**
 * routes/billing/billing.routes.js
 * AQUIPLEX v2 — Billing API routes (authenticated REST endpoints only).
 *
 * Routes:
 *   POST /api/billing/create-order      → create Razorpay order
 *   POST /api/billing/verify-payment    → verify after checkout success
 *   GET  /api/billing/wallet            → wallet summary
 *   GET  /api/billing/history           → transaction history
 *   GET  /api/billing/payments          → payment history
 *   GET  /api/billing/packs             → available credit packs
 *
 * NOTE: POST /api/billing/webhook is handled in index.js BEFORE express.json()
 * because it requires raw body. DO NOT add a webhook route here.
 */

const express  = require("express");
const router   = express.Router();

const { createOrder, verifyPayment, getUserPaymentHistory } = require("../../services/billing/razorpay.service");
const { getWalletSummary, getTransactionHistory } = require("../../services/credits/wallet.service");
const { allPacksArray }      = require("../../utils/credits/packs");
const { createLogger }       = require("../../utils/logger");

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
  if (!uid) return res.status(401).json({ error: "LOGIN_REQUIRED" });
  req.uid = uid.toString();
  next();
}

// ── POST /api/billing/create-order ───────────────────────────────────────────

router.post("/create-order", requireLogin, async (req, res) => {
  try {
    const { packId } = req.body;
    const validPacks = ["starter", "growth", "pro", "max"];
    if (!validPacks.includes(packId)) {
      return res.status(400).json({
        error:   "INVALID_PACK",
        message: "Choose a valid credit pack: starter, growth, pro, or max.",
      });
    }

    const order = await createOrder(req.uid, packId);
    log.info(`Order created: user=${req.uid} pack=${packId} orderId=${order.orderId}`);
    return res.json({ success: true, order });

  } catch (err) {
    log.error("create-order error:", err.message);
    return res.status(500).json({ error: "ORDER_CREATION_FAILED", message: err.message });
  }
});

// ── POST /api/billing/verify-payment ─────────────────────────────────────────

router.post("/verify-payment", requireLogin, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
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
    const status = err.message === "INVALID_SIGNATURE" ? 400 : 500;
    return res.status(status).json({ error: err.message });
  }
});

// ── GET /api/billing/wallet ───────────────────────────────────────────────────

router.get("/wallet", requireLogin, async (req, res) => {
  try {
    const summary = await getWalletSummary(req.uid);
    return res.json({ success: true, wallet: summary });
  } catch (err) {
    log.error("wallet fetch error:", err.message);
    return res.status(500).json({ error: "WALLET_FETCH_FAILED" });
  }
});

// ── GET /api/billing/history ──────────────────────────────────────────────────

router.get("/history", requireLogin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "30", 10), 100);
    const skip  = parseInt(req.query.skip || "0", 10);
    const history = await getTransactionHistory(req.uid, limit, skip);
    return res.json({ success: true, history });
  } catch (err) {
    log.error("history fetch error:", err.message);
    return res.status(500).json({ error: "HISTORY_FETCH_FAILED" });
  }
});

// ── GET /api/billing/payments ─────────────────────────────────────────────────

router.get("/payments", requireLogin, async (req, res) => {
  try {
    const limit    = Math.min(parseInt(req.query.limit || "20", 10), 50);
    const payments = await getUserPaymentHistory(req.uid, limit);
    return res.json({ success: true, payments });
  } catch (err) {
    log.error("payments fetch error:", err.message);
    return res.status(500).json({ error: "PAYMENTS_FETCH_FAILED" });
  }
});

// ── GET /api/billing/packs ────────────────────────────────────────────────────

router.get("/packs", (req, res) => {
  return res.json({ success: true, packs: allPacksArray() });
});

module.exports = router;
