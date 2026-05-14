"use strict";
/**
 * utils/credits/packs.js
 * AQUIPLEX v2 — Credit pack definitions (sourced from env).
 *
 * Prices in paise (₹1 = 100 paise) for Razorpay.
 * Change pack pricing ONLY via environment variables — no code changes needed.
 */

function buildPacks() {
  return {
    starter: {
      id:           "starter",
      name:         "Starter Pack",
      priceINR:     parseInt(process.env.STARTER_PACK_PRICE   || "49",    10),
      credits:      parseInt(process.env.STARTER_PACK_CREDITS || "500",   10),
      badge:        null,
      description:  "Perfect for exploring",
    },
    growth: {
      id:           "growth",
      name:         "Growth Pack",
      priceINR:     parseInt(process.env.GROWTH_PACK_PRICE   || "199",   10),
      credits:      parseInt(process.env.GROWTH_PACK_CREDITS || "3000",  10),
      badge:        "MOST POPULAR",
      description:  "Best value for creators",
    },
    pro: {
      id:           "pro",
      name:         "Pro Pack",
      priceINR:     parseInt(process.env.PRO_PACK_PRICE   || "499",   10),
      credits:      parseInt(process.env.PRO_PACK_CREDITS || "8500",  10),
      badge:        null,
      description:  "For power users & teams",
    },
    max: {
      id:           "max",
      name:         "Max Pack",
      priceINR:     parseInt(process.env.MAX_PACK_PRICE   || "999",   10),
      credits:      parseInt(process.env.MAX_PACK_CREDITS || "20000", 10),
      badge:        "BEST DEAL",
      description:  "Maximum capacity",
    },
  };
}

// Memoize — packs don't change at runtime
let _packs = null;
function getPacks() {
  if (!_packs) _packs = buildPacks();
  return _packs;
}

function getPackById(packId) {
  return getPacks()[packId] || null;
}

function allPacksArray() {
  return Object.values(getPacks());
}

/**
 * Credit costs per AI action type.
 * Extend freely — usageGuard reads from here dynamically.
 */
const CREDIT_COSTS = {
  // Aqua AI chat
  chat_message:              5,
  chat_with_file:            8,

  // Aqua Code Engine
  code_review:               10,
  code_generate:             20,
  code_refactor:             15,
  code_debug:                12,

  // Project Engine
  section_gen:               15,
  component_gen:             20,
  feature_update:            25,
  full_app_gen:              150,
  backend_gen:               120,
  deploy_prep:               80,

  // Research / advanced
  web_search:                5,
  deep_research:             40,
  multi_agent_orchestration: 200,

  // Image
  image_generate:            30,

  // File analysis
  file_analysis:             8,

  // Passthrough — no cost (non-AI actions, local-only repair, etc.)
  free:                      0,

  // Fallback
  default:                   5,
};

function getActionCost(actionType) {
  return CREDIT_COSTS[actionType] ?? CREDIT_COSTS.default;
}

module.exports = { getPacks, getPackById, allPacksArray, CREDIT_COSTS, getActionCost };