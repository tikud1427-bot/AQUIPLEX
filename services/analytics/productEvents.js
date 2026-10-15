"use strict";
/**
 * Product events — the minimum needed to measure activation and retention.
 *
 * WHAT IS RECORDED: a user id, an event name from the fixed list below, a
 * timestamp, and (for some events) a small non-content property such as
 * `firstRun`. NEVER prompts, answers, file names, file contents, memory
 * values, IPs or user agents. If a future event seems to need content, it
 * does not belong here.
 *
 * WHY SERVER-SIDE: the platform already knows every one of these moments, it
 * cannot be blocked by an ad-blocker, and nothing third-party loads in the
 * browser. Recording is fire-and-forget: a failed write is logged once per
 * process and never fails or slows the request.
 *
 * Kill switch: AQUA_PRODUCT_EVENTS=off.
 */

const EVENTS = Object.freeze([
  "signup_completed",   // account created (email or Google)
  "login",              // returning sign-in
  "chat_turn",          // a chat request the engine ACCEPTED (2xx); not a judgement of the answer
  "upload_completed",   // a file/archive upload the engine accepted
  "project_created",    // a project (workspace) was created
  "memory_corrected",   // the user corrected something Aqua held about them
  "memory_forgotten",   // the user deleted something Aqua held about them
]);
const EVENT_SET = new Set(EVENTS);

function enabled() {
  return String(process.env.AQUA_PRODUCT_EVENTS || "on").toLowerCase() !== "off";
}

/**
 * Which product event, if any, does a FINISHED engine request represent?
 * Pure. `path` is relative to the engine mount (/api/aqua or /v1).
 */
function classifyEngineRequest(method, path, status) {
  if (!(status >= 200 && status < 300)) return null;
  const p = String(path || "").replace(/^\/v1(?=\/|$)/, "").replace(/\/+$/, "") || "/";
  const m = String(method || "").toUpperCase();
  if (m === "POST" && (p === "/chat" || p === "/chat/stream")) return "chat_turn";
  if (m === "POST" && (p === "/upload" || /^\/project\/workspace\/[^/]+\/files$/.test(p))) return "upload_completed";
  if (m === "POST" && p === "/project/workspace") return "project_created";
  if (m === "POST" && (p === "/memory/fact" || /^\/brain\/claims\/[^/]+\/correct$/.test(p))) return "memory_corrected";
  if (m === "DELETE" && (/^\/memory\/fact\/[^/]+$/.test(p) || p === "/memory")) return "memory_forgotten";
  return null;
}

/** Only small scalar properties survive; anything else is dropped, not stored. */
function sanitizeProps(props) {
  const out = {};
  if (!props || typeof props !== "object") return out;
  for (const [k, v] of Object.entries(props)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(k)) continue;
    if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) out[k] = v;
    else if (typeof v === "string" && v.length <= 32 && /^[a-z0-9_.-]*$/i.test(v)) out[k] = v;
  }
  return out;
}

let _model = null;
let _warned = false;
function model() {
  if (!_model) _model = require("../../models/ProductEvent");
  return _model;
}

/**
 * Record one event. Never throws, never awaits in the caller's path.
 * @param {string|object} userId
 * @param {string} event one of EVENTS
 * @param {object} [props]
 * @param {{ sink?: (doc: object) => Promise<unknown> }} [opts] test seam
 */
function recordProductEvent(userId, event, props, opts = {}) {
  if (!enabled() || !userId || !EVENT_SET.has(event)) return false;
  const doc = { userId: String(userId), event, at: new Date(), props: sanitizeProps(props) };
  const sink = opts.sink || ((d) => model().create(d));
  Promise.resolve()
    .then(() => sink(doc))
    .catch((err) => {
      if (!_warned) { _warned = true; console.warn(`[product-events] write failed (further failures silent): ${err.message}`); }
    });
  return true;
}

/**
 * Express middleware for the engine mount: once the response has finished,
 * record the event its route represents.
 */
function engineEventTap(opts = {}) {
  return function productEventTap(req, res, next) {
    // Captured now: nested routers rewrite req.url before the response ends.
    const method = req.method;
    const path = req.path;
    const userId = req.session && req.session.userId;
    res.on("finish", () => {
      const event = classifyEngineRequest(method, path, res.statusCode);
      if (event) recordProductEvent(userId, event, null, opts);
    });
    next();
  };
}

module.exports = { EVENTS, classifyEngineRequest, sanitizeProps, recordProductEvent, engineEventTap };
