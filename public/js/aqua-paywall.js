/**
 * public/js/aqua-paywall.js
 * AQUIPLEX — Global paywall modal + usage HUD (Batch 6)
 *
 * Include once per page (before </body>):
 *   <script src="/js/aqua-paywall.js"></script>
 *
 * API:
 *   AquaPaywall.showLimit(errData)       — show daily-limit modal
 *   AquaPaywall.showInsufficient(errData)— show out-of-credits modal
 *   AquaPaywall.showAuto(errData)        — auto-detect from errData.error field
 *   AquaPaywall.initHUD()               — inject usage HUD into page header
 *   AquaPaywall.refreshHUD()            — re-fetch /api/billing/status and update HUD
 *
 * Auto-intercept: if window.AquaPaywall exists, aqua-client.js onError
 * calls showAuto automatically (no extra wiring needed if both scripts loaded).
 */

(function (root) {
  "use strict";

  // ── Styles ────────────────────────────────────────────────────────────────

  var STYLE_ID = "aqua-paywall-styles";
  if (!document.getElementById(STYLE_ID)) {
    var style = document.createElement("style");
    style.id  = STYLE_ID;
    style.textContent = [
      /* Overlay */
      ".apw-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);z-index:99990;display:flex;align-items:center;justify-content:center;padding:16px;opacity:0;transition:opacity 0.2s;}",
      ".apw-overlay.apw-visible{opacity:1;}",
      /* Modal card */
      ".apw-modal{background:#0f0f1e;border:1px solid rgba(255,255,255,0.1);border-radius:20px;padding:32px 28px;max-width:420px;width:100%;position:relative;transform:translateY(20px);transition:transform 0.25s;box-shadow:0 20px 60px rgba(0,0,0,0.6);}",
      ".apw-overlay.apw-visible .apw-modal{transform:translateY(0);}",
      /* Close */
      ".apw-close{position:absolute;top:14px;right:16px;background:none;border:none;color:rgba(255,255,255,0.4);font-size:1.2rem;cursor:pointer;line-height:1;padding:4px;}",
      ".apw-close:hover{color:#fff;}",
      /* Icon */
      ".apw-icon{font-size:2.5rem;margin-bottom:12px;display:block;}",
      /* Heading */
      ".apw-title{font-size:1.2rem;font-weight:800;color:#fff;margin-bottom:8px;}",
      /* Body */
      ".apw-body{font-size:0.88rem;color:rgba(255,255,255,0.65);line-height:1.6;margin-bottom:6px;}",
      ".apw-detail{font-size:0.82rem;color:rgba(255,255,255,0.4);margin-bottom:20px;line-height:1.5;}",
      /* Reset timer */
      ".apw-timer{font-size:0.8rem;color:rgba(0,212,255,0.8);margin-bottom:20px;}",
      /* CTA button */
      ".apw-cta{display:block;text-align:center;padding:12px 20px;background:linear-gradient(135deg,#00d4ff,#7c3aed);color:#fff;border-radius:10px;font-weight:700;font-size:0.95rem;text-decoration:none;margin-bottom:10px;border:none;cursor:pointer;width:100%;}",
      ".apw-cta:hover{opacity:0.9;}",
      /* Secondary */
      ".apw-secondary{display:block;text-align:center;padding:10px;color:rgba(255,255,255,0.45);font-size:0.82rem;cursor:pointer;background:none;border:none;width:100%;}",
      ".apw-secondary:hover{color:#fff;}",
      /* Feature pills */
      ".apw-quotas{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px;}",
      ".apw-quota-pill{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:999px;padding:4px 12px;font-size:0.78rem;color:rgba(255,255,255,0.7);}",
      ".apw-quota-pill.full{border-color:rgba(239,68,68,0.4);color:#fca5a5;background:rgba(239,68,68,0.08);}",

      /* HUD */
      ".apw-hud{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}",
      ".apw-hud-pill{display:inline-flex;align-items:center;gap:4px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.09);border-radius:999px;padding:3px 10px;font-size:0.75rem;color:rgba(255,255,255,0.65);cursor:default;}",
      ".apw-hud-pill.low{border-color:rgba(245,158,11,0.4);color:#fde68a;}",
      ".apw-hud-pill.empty{border-color:rgba(239,68,68,0.4);color:#fca5a5;background:rgba(239,68,68,0.06);}",
      ".apw-hud-pill .dot{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:0.7;}",
    ].join("");
    document.head.appendChild(style);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  var FEATURE_META = {
    imageGen:    { label: "Image Gen",    icon: "🖼️" },
    codeMode:    { label: "Code Mode",    icon: "💻" },
    webSearch:   { label: "Web Search",   icon: "🔍" },
    websiteGen:  { label: "Website Gen",  icon: "🌐" },
    websiteEdit: { label: "Website Edit", icon: "✏️" },
  };

  function timeUntil(iso) {
    if (!iso) return null;
    var diff = new Date(iso) - Date.now();
    if (diff <= 0) return "resetting now";
    var h = Math.floor(diff / 3600000);
    var m = Math.floor((diff % 3600000) / 60000);
    return h > 0 ? ("in " + h + "h " + m + "m") : ("in " + m + "m");
  }

  // ── Modal core ────────────────────────────────────────────────────────────

  var _overlay = null;

  function _buildOverlay() {
    if (_overlay) return _overlay;
    _overlay = document.createElement("div");
    _overlay.className = "apw-overlay";
    _overlay.setAttribute("role", "dialog");
    _overlay.setAttribute("aria-modal", "true");
    _overlay.innerHTML = '<div class="apw-modal" id="apw-modal-inner"></div>';
    _overlay.addEventListener("click", function (e) {
      if (e.target === _overlay) _close();
    });
    document.body.appendChild(_overlay);
    return _overlay;
  }

  function _close() {
    if (!_overlay) return;
    _overlay.classList.remove("apw-visible");
    setTimeout(function () {
      if (_overlay) _overlay.style.display = "none";
    }, 220);
  }

  function _open(html) {
    var ov = _buildOverlay();
    document.getElementById("apw-modal-inner").innerHTML = html;
    ov.style.display = "flex";
    // Force reflow for transition
    void ov.offsetWidth;
    ov.classList.add("apw-visible");

    var closeBtn = ov.querySelector(".apw-close");
    if (closeBtn) closeBtn.addEventListener("click", _close);
    var secBtn = ov.querySelector(".apw-secondary");
    if (secBtn) secBtn.addEventListener("click", _close);

    // Esc key
    var _onKey = function (e) {
      if (e.key === "Escape") { _close(); document.removeEventListener("keydown", _onKey); }
    };
    document.addEventListener("keydown", _onKey);
  }

  // ── Show Limit (429) ──────────────────────────────────────────────────────

  function showLimit(errData) {
    errData = errData || {};
    var upgradeUrl  = errData.upgradeUrl || "/wallet";
    var cta         = errData.cta        || "Buy Credits";
    var msg         = errData.message    || "You've reached your free daily allowance for this feature.";
    var detail      = errData.detail     || "Your quota resets at midnight. Buy credits to continue now.";
    var resetAt     = errData.resetAt    || null;
    var timerText   = resetAt ? ("⏱ Quota resets " + timeUntil(resetAt)) : "";
    var featureLabel= errData.featureLabel ? (" — " + errData.featureLabel) : "";

    _open(
      '<button class="apw-close" aria-label="Close">✕</button>' +
      '<span class="apw-icon">⏱️</span>' +
      '<div class="apw-title">Daily limit reached' + featureLabel + '</div>' +
      '<div class="apw-body">' + _esc(msg) + '</div>' +
      '<div class="apw-detail">' + _esc(detail) + '</div>' +
      (timerText ? '<div class="apw-timer">' + _esc(timerText) + '</div>' : '') +
      '<a href="' + _esc(upgradeUrl) + '" class="apw-cta">⚡ ' + _esc(cta) + '</a>' +
      '<button class="apw-secondary">Dismiss — I\'ll wait until midnight</button>'
    );
  }

  // ── Show Insufficient Credits (402) ───────────────────────────────────────

  function showInsufficient(errData) {
    errData = errData || {};
    var upgradeUrl   = errData.upgradeUrl   || "/wallet";
    var msg          = errData.message      || "You don't have enough Aqua Credits for this action.";
    var totalCredits = errData.totalCredits != null ? errData.totalCredits : "—";
    var costRequired = errData.costRequired != null ? errData.costRequired : "—";

    _open(
      '<button class="apw-close" aria-label="Close">✕</button>' +
      '<span class="apw-icon">💳</span>' +
      '<div class="apw-title">Out of credits</div>' +
      '<div class="apw-body">' + _esc(msg) + '</div>' +
      '<div class="apw-detail">You have <strong style="color:#fff">' + totalCredits + '</strong> credits. This action costs <strong style="color:#fff">' + costRequired + '</strong>.</div>' +
      '<a href="' + _esc(upgradeUrl) + '" class="apw-cta">⚡ Top Up Wallet</a>' +
      '<button class="apw-secondary">Dismiss</button>'
    );
  }

  // ── Auto-detect ───────────────────────────────────────────────────────────

  function showAuto(errData) {
    if (!errData) return;
    var code = errData.error || "";
    if (code === "DAILY_LIMIT_REACHED") return showLimit(errData);
    if (code === "INSUFFICIENT_CREDITS") return showInsufficient(errData);
    // Unknown limit-type error — show generic
    if (errData.upgradeUrl) return showLimit(errData);
  }

  // ── Usage HUD ─────────────────────────────────────────────────────────────

  var _hudEl = null;
  var _hudData = null;

  function initHUD(containerSelector) {
    // Find or create container
    var container = containerSelector
      ? document.querySelector(containerSelector)
      : (document.getElementById("aqua-hud-slot") || null);

    if (!container) {
      // Auto-inject before first nav/header child as last resort
      container = document.createElement("div");
      container.id = "aqua-hud-slot";
      container.style.cssText = "display:flex;align-items:center;";
      var nav = document.querySelector("nav, header");
      if (nav) nav.appendChild(container);
      else document.body.insertBefore(container, document.body.firstChild);
    }

    _hudEl = container;
    refreshHUD();
  }

  function refreshHUD() {
    if (!_hudEl) return;

    fetch("/api/billing/status", { credentials: "include" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.success) return;
        _hudData = data.billing || {};
        _renderHUD();
      })
      .catch(function () { /* non-fatal — HUD just stays empty */ });
  }

  function _renderHUD() {
    if (!_hudEl || !_hudData) return;
    var dailyUsage = _hudData.dailyUsage || {};
    var pills = "";

    Object.keys(FEATURE_META).forEach(function (key) {
      var meta  = FEATURE_META[key];
      var info  = dailyUsage[key] || {};
      var used  = Number(info.used  || 0);
      var limit = Number(info.limit || 0);
      if (limit === 0) return; // skip if no limit data
      var rem   = Math.max(0, limit - used);
      var cls   = rem === 0 ? "empty" : (rem <= 1 ? "low" : "");

      pills += '<span class="apw-hud-pill ' + cls + '" title="' + meta.label + ': ' + rem + ' of ' + limit + ' remaining">' +
        '<span class="dot"></span>' + meta.icon + ' ' + rem + '</span>';
    });

    _hudEl.innerHTML = '<div class="apw-hud">' + pills + '</div>';
  }

  // ── Escape helper ─────────────────────────────────────────────────────────

  function _esc(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── Expose global ─────────────────────────────────────────────────────────

  root.AquaPaywall = {
    showLimit:       showLimit,
    showInsufficient:showInsufficient,
    showAuto:        showAuto,
    initHUD:         initHUD,
    refreshHUD:      refreshHUD,
    close:           _close,
  };

  // ── Auto-init HUD if data-hud attribute on body ────────────────────────────
  document.addEventListener("DOMContentLoaded", function () {
    if (document.body.dataset.aquaHud === "1") initHUD();
  });

})(window);
