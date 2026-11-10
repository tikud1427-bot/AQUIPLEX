#!/usr/bin/env node
"use strict";
/**
 * Business metrics: activity, the free → paid funnel, verified revenue and
 * per-user AI consumption (2026-11-10). READ-ONLY.
 *
 *   node scripts/admin/business-metrics.cjs --mongo <uri> [--days 30] [--json]
 *        [--usd-per-mtok-in <n> --usd-per-mtok-out <n>]   # optional: estimate API spend
 *
 * Sources and what they can and cannot say:
 *   Revenue        — Payment documents with creditedAt set: the payment was
 *                    verified (checkout signature or authenticated webhook)
 *                    AND its credits were added, exactly once. This is the
 *                    ONLY number reported as revenue. Orders that are
 *                    created/pending/failed, or "success" without creditedAt,
 *                    are listed separately and are NOT revenue.
 *   Funnel/usage   — ProductEvent (services/analytics/productEvents.js): user
 *                    id + event name + small numeric props, never content.
 *                    Events began 2026-11-10 for the funnel; windows that
 *                    start earlier under-count the funnel, not revenue.
 *   AI usage       — chat_turn props (aiCalls/aiInTok/aiOutTok/providerAttempts)
 *                    cover the user-facing turn. Background understanding,
 *                    embeddings and key-level retries are process-wide only:
 *                    see /metrics (aqua_cost_*, aqua_provider_*) and
 *                    /api/aqua/provider-health.
 *
 * The Mongo URI must be passed explicitly; .env is never read. No writes.
 * No email addresses or content are printed.
 */
const path = require("path");
const mongoose = require("mongoose");

const ROOT = path.join(__dirname, "..", "..");
const DAY_MS = 24 * 3600 * 1000;
const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const istDay = (d) => new Date(new Date(d).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const pct = (a, b) => (b > 0 ? +((a / b) * 100).toFixed(1) : null);

async function collect({ since, until = new Date(), usdIn = null, usdOut = null }) {
  const User = require(path.join(ROOT, "models", "User.js"));
  const Payment = require(path.join(ROOT, "models", "Payment.js"));
  const ProductEvent = require(path.join(ROOT, "models", "ProductEvent.js"));

  const inWindow = { $gte: since, $lt: until };

  // ── Users & activity ────────────────────────────────────────────────────
  const totalUsers = await User.countDocuments({});
  const newUsers = await User.countDocuments({ createdAt: inWindow });
  const turns = await ProductEvent.find({ event: "chat_turn", at: inWindow }).select("userId at props").lean();
  const activeUsers = new Set(turns.map((t) => t.userId));
  const byDay = new Map();
  for (const t of turns) {
    const d = istDay(t.at);
    if (!byDay.has(d)) byDay.set(d, new Set());
    byDay.get(d).add(t.userId);
  }
  const dauSeries = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, s]) => ({ day, dau: s.size }));
  const avgDau = dauSeries.length ? +(dauSeries.reduce((s, d) => s + d.dau, 0) / dauSeries.length).toFixed(1) : 0;

  // Paying = ever had a credited payment (up to `until`).
  const creditedEver = await Payment.find({ creditedAt: { $exists: true, $lt: until } }).select("user creditedAt amountPaise packId").lean();
  const firstPaidAt = new Map();
  for (const p of creditedEver) {
    const u = String(p.user);
    if (!firstPaidAt.has(u) || p.creditedAt < firstPaidAt.get(u)) firstPaidAt.set(u, p.creditedAt);
  }
  const activeFreeUsers = [...activeUsers].filter((u) => !firstPaidAt.has(u) || firstPaidAt.get(u) >= since);

  // ── Funnel (distinct users per stage, in window) ────────────────────────
  const stages = ["free_allowance_low", "free_allowance_exhausted", "credits_insufficient", "pricing_viewed",
    "buy_clicked", "checkout_started", "checkout_dismissed", "checkout_failed", "purchase_credited"];
  const funnel = {};
  const usersAt = {};
  for (const ev of stages) {
    const rows = await ProductEvent.find({ event: ev, at: inWindow }).select("userId").lean();
    usersAt[ev] = new Set(rows.map((r) => r.userId));
    funnel[ev] = { events: rows.length, users: usersAt[ev].size };
  }
  const exhaustedUsers = new Set([...usersAt.free_allowance_exhausted, ...usersAt.credits_insufficient]);
  const exhaustedThenPaid = [...exhaustedUsers].filter((u) => usersAt.purchase_credited.has(u)).length;

  // ── Revenue (verified only) ─────────────────────────────────────────────
  const credited = creditedEver.filter((p) => p.creditedAt >= since);
  const revenuePaise = credited.reduce((s, p) => s + (p.amountPaise || 0), 0);
  const byPack = {};
  for (const p of credited) {
    const b = (byPack[p.packId] ??= { purchases: 0, revenueINR: 0 });
    b.purchases++; b.revenueINR += (p.amountPaise || 0) / 100;
  }
  const buyers = new Set(credited.map((p) => String(p.user)));
  const firstTimeBuyers = [...buyers].filter((u) => firstPaidAt.get(u) >= since).length;
  const repeatPurchases = credited.length - firstTimeBuyers;

  const notRevenue = await Payment.aggregate([
    { $match: { createdAt: inWindow, creditedAt: { $exists: false } } },
    { $group: { _id: "$status", orders: { $sum: 1 }, amountPaise: { $sum: "$amountPaise" } } },
  ]);

  // ── AI consumption (user-facing turns) ──────────────────────────────────
  let aiCalls = 0, inTok = 0, outTok = 0, attempts = 0, fallbacks = 0, withUsage = 0;
  const perUserCalls = new Map();
  for (const t of turns) {
    const p = t.props || {};
    if (Number.isFinite(p.aiCalls)) {
      withUsage++;
      aiCalls += p.aiCalls;
      perUserCalls.set(t.userId, (perUserCalls.get(t.userId) || 0) + p.aiCalls);
    }
    if (Number.isFinite(p.aiInTok)) inTok += p.aiInTok;
    if (Number.isFinite(p.aiOutTok)) outTok += p.aiOutTok;
    if (Number.isFinite(p.providerAttempts)) attempts += p.providerAttempts;
    if (p.fallback === true) fallbacks++;
  }
  const estUsd = Number.isFinite(usdIn) && Number.isFinite(usdOut)
    ? +((inTok * usdIn + outTok * usdOut) / 1e6).toFixed(4) : null;

  return {
    window: { since: since.toISOString(), until: until.toISOString() },
    users: { total: totalUsers, newInWindow: newUsers, active: activeUsers.size, activeFree: activeFreeUsers.length, avgDau, dauSeries },
    funnel,
    conversion: {
      exhaustedUsers: exhaustedUsers.size,
      exhaustedThenPurchasedUsers: exhaustedThenPaid,
      exhaustedToPaidPct: pct(exhaustedThenPaid, exhaustedUsers.size),
      activeFreeToPaidPct: pct(firstTimeBuyers, activeFreeUsers.length),
      checkoutStartToPaidPct: pct(funnel.purchase_credited.users, funnel.checkout_started.users),
    },
    revenue: {
      verifiedPurchases: credited.length,
      revenueINR: revenuePaise / 100,
      firstTimeBuyers,
      repeatPurchases,
      byPack,
      notRevenue: notRevenue.map((r) => ({ status: r._id, orders: r.orders, amountINR: (r.amountPaise || 0) / 100 })),
    },
    ai: {
      turns: turns.length,
      turnsWithUsage: withUsage,
      providerCalls: aiCalls,
      inputTokens: inTok,
      outputTokens: outTok,
      avgCallsPerTurn: withUsage ? +(aiCalls / withUsage).toFixed(2) : null,
      avgCallsPerActiveUser: perUserCalls.size ? +(aiCalls / perUserCalls.size).toFixed(1) : null,
      avgProviderAttemptsPerTurn: withUsage ? +(attempts / withUsage).toFixed(2) : null,
      fallbackTurnPct: pct(fallbacks, withUsage),
      estimatedApiUsd: estUsd,
      estimatedApiUsdPerActiveUser: estUsd != null && activeUsers.size ? +(estUsd / activeUsers.size).toFixed(4) : null,
      note: "User-facing turns only. Background understanding, embeddings and key retries: see /metrics.",
    },
  };
}

function print(r, log) {
  log(`Window ${r.window.since} → ${r.window.until}`);
  log(`Users: total ${r.users.total}, new ${r.users.newInWindow}, active ${r.users.active} (free ${r.users.activeFree}), avg DAU ${r.users.avgDau}`);
  log("Funnel (distinct users / events):");
  for (const [k, v] of Object.entries(r.funnel)) log(`  ${k.padEnd(26)} ${String(v.users).padStart(6)} / ${v.events}`);
  log(`Conversion: exhausted→paid ${r.conversion.exhaustedToPaidPct ?? "n/a"}% (${r.conversion.exhaustedThenPurchasedUsers}/${r.conversion.exhaustedUsers}); active free→paid ${r.conversion.activeFreeToPaidPct ?? "n/a"}%; checkout→paid ${r.conversion.checkoutStartToPaidPct ?? "n/a"}%`);
  log(`REVENUE (verified, credited): ₹${r.revenue.revenueINR.toFixed(2)} from ${r.revenue.verifiedPurchases} purchase(s); first-time buyers ${r.revenue.firstTimeBuyers}, repeat purchases ${r.revenue.repeatPurchases}`);
  for (const [k, v] of Object.entries(r.revenue.byPack)) log(`  ${k.padEnd(8)} ${v.purchases} × → ₹${v.revenueINR.toFixed(2)}`);
  if (r.revenue.notRevenue.length) {
    log("NOT revenue (orders without credited payment):");
    for (const n of r.revenue.notRevenue) log(`  ${String(n.status).padEnd(8)} ${n.orders} order(s), ₹${n.amountINR.toFixed(2)} attempted`);
  }
  log(`AI (user-facing turns): ${r.ai.turns} turns, ${r.ai.providerCalls} provider calls, ${r.ai.inputTokens} in / ${r.ai.outputTokens} out tokens; ${r.ai.avgCallsPerTurn ?? "n/a"} calls/turn; fallback on ${r.ai.fallbackTurnPct ?? "n/a"}% of turns`);
  if (r.ai.estimatedApiUsd != null) log(`  estimated API spend $${r.ai.estimatedApiUsd} ($${r.ai.estimatedApiUsdPerActiveUser}/active user) — from the prices you passed`);
}

async function main(args = process.argv.slice(2), { log = console.log } = {}) {
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const uri = arg("--mongo");
  if (!uri) throw new Error("--mongo <uri> is required (the script never reads .env)");
  const days = Math.max(1, Math.min(400, parseInt(arg("--days") || "30", 10) || 30));
  const usdIn = arg("--usd-per-mtok-in") != null ? Number(arg("--usd-per-mtok-in")) : null;
  const usdOut = arg("--usd-per-mtok-out") != null ? Number(arg("--usd-per-mtok-out")) : null;
  if (mongoose.connection.readyState !== 1) await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, autoIndex: false, autoCreate: false });
  const until = new Date();
  const report = await collect({ since: new Date(until.getTime() - days * DAY_MS), until, usdIn, usdOut });
  if (args.includes("--json")) log(JSON.stringify(report, null, 2)); else print(report, log);
  return report;
}

if (require.main === module) {
  main().then(() => mongoose.disconnect()).catch(async (err) => { console.error(`error: ${err.message}`); await mongoose.disconnect().catch(() => {}); process.exit(1); });
}

module.exports = { main, collect };
