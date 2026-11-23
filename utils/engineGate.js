/**
 * AQUA engine startup gate (2026-11-24, audit/render-heap-oom).
 *
 * index.js starts listening while the AQUA engine is still being imported —
 * that import first restores every store from the Mongo mirror. In that
 * window an engine request used to run through usage metering and then fall
 * through to the platform's HTML 404. This gate sits FIRST inside the engine
 * router (after authentication, before metering) and answers honestly:
 *
 *   starting → 503 + Retry-After, code ENGINE_STARTING
 *   failed   → 503 "AQUA engine unavailable" (the existing failure response)
 *   mounted  → pass through
 *
 * Non-AI platform routes are unaffected. /ready reports the same state.
 */
function createEngineGate({ retryAfterSeconds = 5 } = {}) {
  let state = "starting";
  function middleware(req, res, next) {
    if (state === "mounted") return next();
    res.set("Cache-Control", "no-store");
    if (state === "failed") {
      return res.status(503).json({ success: false, error: "AQUA engine unavailable" });
    }
    res.set("Retry-After", String(retryAfterSeconds));
    return res.status(503).json({ success: false, error: "AQUA engine is starting — retry shortly", code: "ENGINE_STARTING" });
  }
  return {
    middleware,
    markMounted() { state = "mounted"; },
    markFailed() { state = "failed"; },
    get state() { return state; },
  };
}

module.exports = { createEngineGate };
