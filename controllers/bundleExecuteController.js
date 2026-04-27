"use strict";

const Bundle = require("../models/Bundle");
const axios  = require("axios");

// ─────────────────────────────────────────────────────────────────────────────
// Intent detection
// ─────────────────────────────────────────────────────────────────────────────
const WEB_KEYWORDS = [
  "website", "landing page", "web app", "portfolio",
  "saas", "frontend", "homepage", "site", "app",
];

function isWebBuildIntent(bundle) {
  const text = [
    bundle.goal  || "",
    bundle.title || "",
    ...(bundle.steps || []).map((s) => s.title + " " + (s.description || "")),
  ].join(" ").toLowerCase();

  return WEB_KEYWORDS.some((kw) => text.includes(kw));
}

// ─────────────────────────────────────────────────────────────────────────────
// Build prompt
// ─────────────────────────────────────────────────────────────────────────────
function buildProjectPrompt(bundle) {
  const steps = (bundle.steps || [])
    .map((s, i) => `Step ${i + 1}: ${s.title} - ${s.description || ""}`)
    .join("\n");

  return `Build a complete, production-ready website.\n\nGOAL:\n${bundle.goal || bundle.title}\n\nSTEPS:\n${steps}\n\nMake it responsive, modern UI, and fully working.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function uid(req) {
  return (
    req.session?.userId     ||
    req.session?.user?._id  ||
    req.user?._id           ||
    null
  );
}

function apiError(res, msg, status = 500) {
  console.error("❌ [executeBundle]", msg);
  return res.status(status).json({ success: false, error: msg });
}

// ✅ FIX: Build base URL from request — works on localhost, GitHub dev, prod
function getBaseUrl(req) {
  // Prefer explicit env var if set (recommended for production)
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL;
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host  = req.headers["x-forwarded-host"]  || req.get("host");
  return `${proto}://${host}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXECUTION
// ─────────────────────────────────────────────────────────────────────────────
exports.executeBundle = async (req, res) => {
  try {
    console.log("🚀 [executeBundle] hit — bundleId:", req.params.id);

    const userId = uid(req);
    if (!userId) return apiError(res, "Unauthorized", 401);

    const bundle = await Bundle.findOne({
      _id: req.params.id,
      userId,
    }).lean();

    if (!bundle) return apiError(res, "Bundle not found", 404);

    const isWeb = isWebBuildIntent(bundle);
    console.log("🔍 [executeBundle] isWeb:", isWeb, "| goal:", bundle.goal || bundle.title);

    if (!isWeb) {
      return res.json({ success: true, webIntent: false });
    }

    const BASE    = getBaseUrl(req);
    const COOKIE  = req.headers.cookie || "";
    const prompt  = buildProjectPrompt(bundle);

    console.log("🌐 [executeBundle] base URL:", BASE);

    let projectId;

    // ── STEP 1: CREATE PROJECT ────────────────────────────────────────────────
    try {
      const createRes = await axios.post(
        `${BASE}/workspace/project/create`,
        {
          name:        bundle.title || "Website Project",
          description: bundle.goal  || "",
        },
        {
          headers: {
            Cookie:           COOKIE,   // forward session so auth passes
            "Content-Type":   "application/json",
          },
          timeout: 15000,
        }
      );

      projectId = createRes.data?.projectId || createRes.data?._id;
      console.log("✅ [executeBundle] project created:", projectId);
    } catch (err) {
      const detail = err.response?.data?.error || err.message;
      console.error("❌ [executeBundle] createProject failed:", detail);
      return apiError(res, "Failed to create project: " + detail);
    }

    if (!projectId) {
      return apiError(res, "No project ID returned from workspace");
    }

    // ── STEP 2: GENERATE WEBSITE ──────────────────────────────────────────────
    try {
      await axios.post(
        `${BASE}/workspace/project/generate`,
        { projectId, prompt },
        {
          headers: {
            Cookie:           COOKIE,
            "Content-Type":   "application/json",
          },
          timeout: 60000, // generation can take time
        }
      );
      console.log("✅ [executeBundle] generation complete");
    } catch (err) {
      const detail = err.response?.data?.error || err.message;
      console.error("⚠️ [executeBundle] generate failed (non-fatal):", detail);

      // Project exists — redirect anyway, generation failed gracefully
      return res.json({
        success:     true,
        webIntent:   true,
        projectId,
        redirectUrl: `/workspace/project/${projectId}`,
        warning:     "Generation failed, but project was created: " + detail,
      });
    }

    // ── FINAL RESPONSE ────────────────────────────────────────────────────────
    console.log("🎉 [executeBundle] done — redirecting to:", `/workspace/project/${projectId}`);
    return res.json({
      success:     true,
      webIntent:   true,
      projectId,
      redirectUrl: `/workspace/project/${projectId}`,
    });

  } catch (err) {
    console.error("❌ [executeBundle] fatal:", err.message);
    return apiError(res, "Execution failed: " + err.message);
  }
};
