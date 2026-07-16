/**
 * index.js — Aqua AI Server
 */

require("dotenv").config();

// ── Startup validation & index self-healing ───────────────────────────────────
const { runStartupChecks } = require("./utils/startup");

const express  = require("express");
const app      = express();

// ── Core imports ──────────────────────────────────────────────────────────────
const mongoose       = require("mongoose");
const bcrypt         = require("bcrypt");
const session        = require("express-session");
const multer         = require("multer");
const fs             = require("fs");
const path           = require("path");
const axios          = require("axios");
const passport       = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

// ── Model imports ─────────────────────────────────────────────────────────────
const User   = require("./models/User");
const Tool   = require("./models/Tool");
const Bundle = require("./models/Bundle");

// ── Service imports ───────────────────────────────────────────────────────────
// ai.client is the platform-internal LLM client (tool insights, bundle
// generation/execution, chat titles). It is NOT a user-facing chatbot —
// AQUA (mounted at /api/aqua) is the only AI product.
const ai            = require("./services/ai.client");
const { usageGuard } = require("./middleware/usage/usageGuard");

// ── Static data ───────────────────────────────────────────────────────────────
const blogs = require("./blogs");
let dynamicBlogs = [];

// ═════════════════════════════════════════════════════════════════════════════
// AI ENGINE — delegates to ai.core (Groq → OpenRouter → Gemini)
// ═════════════════════════════════════════════════════════════════════════════

async function generateAI(messages, options = {}, useVision = false) {
  return ai.generateAI(messages, options);
}

// ═════════════════════════════════════════════════════════════════════════════
// EXPRESS SETUP
// ═════════════════════════════════════════════════════════════════════════════

app.set("trust proxy", 1);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// ── Razorpay webhook — MUST be raw body, mount BEFORE express.json() ──────────
const { verifyWebhookSignature, } = require("./services/billing/razorpay.service");
const { handleWebhookEvent } = require("./services/billing/webhook.handler");
const { createLogger: _createLogger } = require("./utils/logger");
const _webhookLog = _createLogger("WEBHOOK");

app.post(
  "/api/billing/webhook",
  require("express").raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const signature = req.headers["x-razorpay-signature"];
      if (!signature) return res.status(400).json({ error: "MISSING_SIGNATURE" });

      const rawBody = req.body;
      const valid = verifyWebhookSignature(rawBody, signature);
      if (!valid) {
        _webhookLog.warn("Webhook signature mismatch");
        return res.status(400).json({ error: "INVALID_SIGNATURE" });
      }

      const payload = JSON.parse(rawBody.toString());
      if (!payload.event) return res.status(400).json({ error: "MISSING_EVENT" });

      res.status(200).json({ received: true });

      handleWebhookEvent(payload.event, payload).catch((err) =>
        _webhookLog.error("Webhook processing error:", err.message)
      );
    } catch (err) {
      _webhookLog.error("Webhook handler error:", err.message);
      return res.status(500).json({ error: "WEBHOOK_ERROR" });
    }
  }
);

// ── Body parsers & static ─────────────────────────────────────────────────────
app.use(express.json({ limit: "50mb" })); // AQUA project uploads (base64 archives) need a large body limit
app.use(express.urlencoded({ extended: true }));

// P0 (cache) — the service worker file MUST always be revalidated, otherwise
// browsers keep running whatever worker they installed months ago and the
// kill-switch in public/service-worker.js can never reach them. Registered
// BEFORE express.static so this header always wins.
app.get("/service-worker.js", (req, res) => {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Service-Worker-Allowed", "/");
  res.sendFile(path.join(__dirname, "public", "service-worker.js"));
});

// P0 (cache) — platform assets are NOT content-hashed, so they may never be
// served blind from browser cache across deploys. `no-cache` still allows
// conditional requests: unchanged files answer 304 via ETag (cheap), changed
// files arrive fresh. This is what makes deploys seamless on the EJS pages.
app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (/\.(png|jpe?g|gif|webp|svg|ico|woff2?)$/i.test(filePath)) {
      // Images/fonts change rarely and renames are natural — short TTL is safe.
      res.set("Cache-Control", "public, max-age=3600, must-revalidate");
    } else {
      // HTML/CSS/JS: always revalidate (ETag makes unchanged = one 304).
      res.set("Cache-Control", "no-cache, must-revalidate");
    }
  },
}));

// ── Session ───────────────────────────────────────────────────────────────────
// Use connect-mongo if installed, otherwise fall back to in-memory store.
// To persist sessions across restarts: npm install connect-mongo
let sessionStore;
try {
  const MongoStore = require("connect-mongo");
  sessionStore = MongoStore.create({ mongoUrl: process.env.MONGO_URI });
  console.log("✅ Session store: MongoDB (connect-mongo)");
} catch (_) {
  try {
    const MemoryStoreFactory = require("memorystore");
    const MemoryStore = MemoryStoreFactory(require("express-session"));
    sessionStore = new MemoryStore({ checkPeriod: 86400000 }); // prune expired every 24h
    console.log("✅ Session store: memorystore (in-process, resets on restart — add connect-mongo for persistence)");
  } catch (_2) {
    sessionStore = undefined;
    console.warn("⚠️  No persistent session store — using bare MemoryStore. Run: npm install connect-mongo");
  }
}

app.use(
  session({
    secret:            (() => {
      const s = process.env.SESSION_SECRET;
      if (!s) {
        // SECURITY (Phase 1): a predictable fallback secret lets anyone forge
        // session cookies. Refuse to boot insecure in production; keep the
        // dev-only fallback for local work.
        if (process.env.NODE_ENV === 'production') {
          console.error('[FATAL] SESSION_SECRET is not set in production. Refusing to start with a predictable session secret — set SESSION_SECRET and redeploy.');
          process.exit(1);
        }
        console.warn('[WARN] SESSION_SECRET not set — using an insecure dev-only fallback. Never run this in production.');
      }
      return s || 'aqua-secret-fallback-dev-only';
    })(),
    resave:            false,
    saveUninitialized: false,
    name:              "aidex_session",
    store:             sessionStore,
    cookie: {
      maxAge:   7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure:   process.env.NODE_ENV === "production",
    },
  })
);

// ── Passport ──────────────────────────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());

// Configure Google OAuth strategy
passport.use(
  new GoogleStrategy(
    {
      clientID:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:  process.env.GOOGLE_CALLBACK_URL || "/auth/google/callback",
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value;
        if (!email) return done(new Error("No email from Google"), null);
        let user = await User.findOne({ email });
        if (!user) {
          user = await new User({ email, password: "google-oauth" }).save();
        }
        return done(null, user);
      } catch (err) {
        return done(err, null);
      }
    }
  )
);

passport.serializeUser((user, done) => done(null, user._id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err, null);
  }
});

// NOTE: Razorpay webhook is handled inside billing.routes.js (mounted above,
// before express.json()). No duplicate handler needed here.

// ── Global user locals ────────────────────────────────────────────────────────
// FIX: guard req.session before accessing .user — prevents crash when session
// middleware is not yet initialized or request arrives before session is set.
app.use((req, res, next) => {
  res.locals.user = (req.session && req.session.user) || null;
  next();
});

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireLogin(req, res, next) {
  const isLoggedIn = (req.session && req.session.userId) || (req.user && req.user._id);
  if (!isLoggedIn) {
    // req.path is router-relative inside mounted routers — use originalUrl so
    // /api/aqua/* correctly gets a JSON 401 instead of an HTML redirect.
    if (req.originalUrl.startsWith("/api/") || req.xhr) return res.status(401).json({ error: "Login required" });
    return res.redirect("/login");
  }
  if (req.session && !req.session.userId && req.user) req.session.userId = req.user._id;
  next();
}

function redirectIfLoggedIn(req, res, next) {
  if (req.session && req.session.userId) return res.redirect("/home");
  next();
}

// ── Upload ────────────────────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, "public/uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});

const ALLOWED_EXTENSIONS = new Set([
  ".pdf",".docx",".txt",
  ".csv",".tsv",".json",".jsonl",
  ".png",".jpg",".jpeg",".gif",".webp",
  ".js",".ts",".py",".java",".cpp",".c",".cs",".go",".rs",".rb",".php",".swift",".sh",".sql",
  ".html",".css",".xml",".yaml",".yml",".md",".jsx",".tsx",".vue",
]);

const upload = multer({
  storage,
  limits:     { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.has(ext)) cb(null, true);
    else cb(new Error(`File type ${ext} is not supported`), false);
  },
});

// ── Database ──────────────────────────────────────────────────────────────────
async function connectDB() {
  try {
    console.log("⏳ Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS:          45000,
    });
    console.log("✅ MongoDB connected");
  } catch (err) {
  console.error("❌ MongoDB connection failed:");
  console.error(err);
  process.exit(1);
}
}

// ── Trending tools ────────────────────────────────────────────────────────────
async function getTrendingTools(limit = 10) {
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const tools   = await Tool.find({ status: { $in: ["approved", null, undefined] } }).lean();
  return tools
    .map((tool) => {
      const score = (tool.clickHistory || []).filter((c) => new Date(c.date) > last24h).length;
      return { ...tool, trendingScore: score };
    })
    .sort((a, b) => b.trendingScore - a.trendingScore)
    .slice(0, limit);
}

// ── isTrending helper ─────────────────────────────────────────────────────────
function isTrending(tool, thresholdClicks = 1) {
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const score = (tool.clickHistory || []).filter((c) => new Date(c.date) > last24h).length;
  return score >= thresholdClicks;
}

// ── Import tools from JSON ────────────────────────────────────────────────────
let jsonTools = [];
try {
  jsonTools = JSON.parse(fs.readFileSync("./data/tools.json", "utf8"));
} catch (err) {}

async function importTools() {
  if (jsonTools.length === 0) return;
  for (const tool of jsonTools) {
    await Tool.updateOne({ name: tool.name }, { $set: tool }, { upsert: true });
  }
  console.log("✅ Tools synced");
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTES — mounted sub-routers
// ═════════════════════════════════════════════════════════════════════════════

// ── Sub-routers ───────────────────────────────────────────────────────────────
const billingRoutes = require("./routes/billing/billing.routes");

// Billing REST routes (create-order, verify-payment, wallet, history)
// Webhook is handled above before express.json()
app.use("/api/billing", billingRoutes);

// ═════════════════════════════════════════════════════════════════════════════
// AQUA — THE ONLY AI (engine API + app shell)
// ═════════════════════════════════════════════════════════════════════════════
//
// Engine:   /api/aqua/*  — chat, streaming, memory, conversations, project
//                          intelligence, universal upload. ESM module loaded
//                          dynamically (aqua/ is its own package).
// App:      /aqua        — built React SPA (aqua-frontend/dist), auth-gated.
//
// Identity bridge: requireLogin guarantees a session; req.aquaUserId carries
// the platform userId into the engine so conversations/memory are per-user.

const aquaEngine = express.Router();

// Credit metering on generation endpoints (same wallet as the rest of the platform)
aquaEngine.use((req, res, next) => {
  if (req.method === "POST" && (req.path === "/chat" || req.path === "/chat/stream")) {
    return usageGuard("chat_message")(req, res, next);
  }
  if (req.method === "POST" && req.path.startsWith("/upload")) {
    return usageGuard("chat_with_file")(req, res, next);
  }
  // Artifact Engine P5 — edit/regenerate re-run generation on an existing
  // artifact; metered at the chat_with_file tier (chat-triggered artifact
  // CREATION already rides the chat_message guard above).
  if (req.method === "POST" && /^\/artifacts\/[^/]+\/(edit|regenerate)$/.test(req.path)) {
    return usageGuard("chat_with_file")(req, res, next);
  }
  next();
});

app.use(
  "/api/aqua",
  requireLogin,
  (req, res, next) => {
    req.aquaUserId = String(req.session.userId);
    next();
  },
  aquaEngine,
);

let aquaMounted = false;
import("./aqua/router.js")
  .then((m) => {
    aquaEngine.use(m.default);
    aquaMounted = true;
    console.log("✅ AQUA engine mounted at /api/aqua");
  })
  .catch((err) => {
    console.error("❌ AQUA engine failed to mount:", err);
    aquaEngine.use((req, res) =>
      res.status(503).json({ success: false, error: "AQUA engine unavailable" }));
  });

// AQUA app shell (built SPA)
const AQUA_APP_DIR = path.join(__dirname, "aqua-frontend", "dist");

// P0 (cache) — build identity. The Vite build stamps a build id into
// dist/index.html (<meta name="aqua-build">); the SPA polls this endpoint and
// hard-reloads itself the moment a deploy changes it. Re-read lazily with a
// short memo so a hot dist swap (no server restart) is still detected.
let _buildMemo = { id: null, readAt: 0 };
function currentAquaBuildId() {
  const now = Date.now();
  if (_buildMemo.id && now - _buildMemo.readAt < 5000) return _buildMemo.id;
  try {
    const html = fs.readFileSync(path.join(AQUA_APP_DIR, "index.html"), "utf8");
    const m = html.match(/name="aqua-build"\s+content="([^"]+)"/);
    _buildMemo = { id: m ? m[1] : "unstamped", readAt: now };
  } catch {
    _buildMemo = { id: "unbuilt", readAt: now };
  }
  return _buildMemo.id;
}
app.get("/aqua/build.json", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ buildId: currentAquaBuildId() });
});

// P0 (cache) — the two-tier policy that makes deploys seamless:
//   • /aqua/assets/*  (content-hashed by Vite) → cache FOREVER, immutable.
//   • everything else (index.html, manifest)   → always revalidate.
// Old HTML can therefore never pin new chunks, and new HTML always loads.
app.use("/aqua", requireLogin, express.static(AQUA_APP_DIR, {
  index: false,
  redirect: false,
  setHeaders(res, filePath) {
    if (filePath.includes(`${path.sep}assets${path.sep}`)) {
      res.set("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      res.set("Cache-Control", "no-cache, must-revalidate");
    }
  },
}));
app.get(/^\/aqua(\/.*)?$/, requireLogin, (req, res) => {
  const indexHtml = path.join(AQUA_APP_DIR, "index.html");
  if (!fs.existsSync(indexHtml)) {
    return res
      .status(503)
      .send("AQUA app not built yet. Run: cd aqua-frontend && npm install && npm run build");
  }
  // Never let a browser or proxy serve yesterday's shell after a deploy.
  res.set("Cache-Control", "no-cache, must-revalidate");
  res.sendFile(indexHtml);
});

// ── Legacy AI surface → permanent redirects into AQUA ────────────────────────
app.get(["/chatbot", "/aqua-ai", "/aqua-project-engine", "/workspace", "/workspace/*splat"],
  (req, res) => res.redirect(301, "/aqua"));

// ═════════════════════════════════════════════════════════════════════════════
// INLINE ROUTES
// ═════════════════════════════════════════════════════════════════════════════

app.get("/health", (req, res) => res.status(200).json({ status: "OK", timestamp: new Date().toISOString() }));

app.get("/", (req, res) => {
  if (req.session && req.session.userId) return res.redirect("/home");
  return res.redirect("/landing");
});

app.get("/landing", async (req, res) => {
  if (req.session && req.session.userId) return res.redirect("/home");
  res.render("landing");
});

app.get("/home", requireLogin, async (req, res) => {
  try {
    // Workspace home: the user's own recent projects. Conversations,
    // workspaces, and usage are fetched client-side from existing APIs.
    const bundles = await Bundle.find({ userId: req.session.userId })
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(5)
      .select("title status steps createdAt")
      .lean();
    res.render("home", { bundles: bundles || [] });
  } catch (err) {
    console.error(err);
    res.render("home", { bundles: [] });
  }
});

// ── Retired marketplace surface ───────────────────────────────────────────────
// Aquiplex is an AI Operating System built around Aqua — not a tools directory.
// The old directory URLs stay alive (no dead links, SEO-safe 301s) but resolve
// into the product. Backend tool APIs (/api/tools/*, /visit/:id, admin review)
// remain untouched.
const marketplaceRedirect = (req, res) =>
  res.redirect(301, req.session && req.session.userId ? "/home" : "/landing");

app.get("/tools", marketplaceRedirect);

app.get("/tools/:id", marketplaceRedirect);

app.get("/bundles", (req, res) => res.render("bundles"));

app.post("/generate-bundle", async (req, res) => {
  const { goal, step, answers } = req.body;
  if (!goal || !goal.trim()) return res.status(400).json({ error: "Goal is required" });

  if (!step || step === 1) {
    return res.json({
      type:      "questions",
      step:      2,
      questions: [
        "What type of project is this? (e.g. SaaS, content, freelancing, startup)",
        "Who is the target audience or end-user?",
        "What is the single most important outcome you want?",
        "Do you prefer a lean/fast approach or a thorough/detailed one?",
        "Any tech, tools, or constraints we should know about?",
      ],
    });
  }

  try {
    const prompt = `
You are an expert project architect. Generate a precise, actionable project plan.

USER GOAL: ${goal}
USER ANSWERS:
${(answers || []).map((a, i) => `  ${i + 1}. ${a}`).join("\n")}

Rules:
- Return ONLY valid JSON. No prose, no markdown fences.
- 5 to 8 steps. Each step must be concrete and self-contained.
- Each step description must be 1-2 sentences explaining WHAT to produce.
- steps[].tools is now steps[].resources — an array of strings naming key resources or methods.

JSON schema:
{
  "title": "Project title",
  "steps": [
    {
      "step": 1,
      "title": "Step title",
      "description": "Specific description of what to produce in this step.",
      "resources": ["resource 1", "resource 2"]
    }
  ]
}`.trim();

    const raw = await generateAI(
      [
        { role: "system", content: "You are an expert project architect. Return ONLY valid JSON." },
        { role: "user",   content: prompt },
      ],
      { temperature: 0.5, maxTokens: 1400 },
    );

    const clean = raw.replace(/```json/g, "").replace(/```/g, "").trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON in response");

    const parsed   = JSON.parse(match[0]);
    parsed.steps   = parsed.steps.map((s, i) => ({ ...s, step: i, resources: s.resources || [] }));
    parsed.goal    = goal;
    parsed.answers = answers || [];

    res.json(parsed);
  } catch (err) {
    console.error("❌ /generate-bundle error:", err);
    res.status(500).json({ error: "AI failed to generate bundle", raw: err.message });
  }
});

app.delete("/bundle/:id", requireLogin, async (req, res) => {
  try {
    const result = await Bundle.deleteOne({ _id: req.params.id, userId: req.session.userId });
    if (!result.deletedCount) return res.status(404).json({ error: "Bundle not found" });
    res.json({ success: true });
  } catch (err) {
    console.error("Delete bundle error:", err);
    res.status(500).json({ error: "Failed to delete bundle" });
  }
});

app.get("/api/tools/suggest", async (req, res) => {
  try {
    const q   = req.query.q || "";
    let tools = await Tool.find({ status: { $in: ["approved", null, undefined] } }).lean();
    if (q) {
      tools = tools
        .map((tool) => {
          const text  = ((tool.name || "") + " " + (tool.description || "") + " " + (tool.category || "")).toLowerCase();
          const query = q.toLowerCase();
          const score = (text.includes(query) ? 5 : 0) + (tool.name.toLowerCase().includes(query) ? 3 : 0);
          return { ...tool, score };
        })
        .filter((t) => t.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
    } else {
      tools = tools.slice(0, 5);
    }
    res.json(tools.map((t) => ({ _id: t._id, name: t.name, url: t.url, category: t.category, logo: t.logo })));
  } catch {
    res.json([]);
  }
});

// ── Visit redirect (tracks click) ─────────────────────────────────────────────
app.get("/visit/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).send("Invalid ID");
    const tool = await Tool.findById(req.params.id).lean();
    if (!tool) return res.status(404).send("Tool not found");
    // track click async
    Tool.findByIdAndUpdate(req.params.id, {
      $push: { clickHistory: { date: new Date() } },
      $inc:  { clicks: 1 },
    }).catch(() => {});
    res.redirect(tool.url || "/tools");
  } catch (err) {
    console.error(err);
    res.redirect("/tools");
  }
});

// ── AI Tool Recommendation endpoint ───────────────────────────────────────────
app.get("/api/tools/recommend", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const cat = (req.query.cat || "").trim();
    const trendingTools = await getTrendingTools(10);
    const trendingIds = new Set(trendingTools.map(t => t._id.toString()));

    let tools = await Tool.find({ status: { $in: ["approved", null, undefined] } }).lean();

    // filter by category if provided
    if (cat) tools = tools.filter(t => (t.category || "").toLowerCase() === cat.toLowerCase());

    let scored;
    if (q) {
      scored = tools.map(t => {
        const text = ((t.name || "") + " " + (t.description || "") + " " + (t.category || "")).toLowerCase();
        const qLow = q.toLowerCase();
        let score = 0;
        if (t.name.toLowerCase().includes(qLow)) score += 6;
        if (text.includes(qLow)) score += 3;
        score += (t.likes || 0) * 0.1;
        if (trendingIds.has(t._id.toString())) score += 4;
        return { ...t, recScore: score };
      }).filter(t => t.recScore > 0).sort((a, b) => b.recScore - a.recScore).slice(0, 6);
    } else {
      scored = tools
        .map(t => ({ ...t, recScore: (t.likes || 0) + (trendingIds.has(t._id.toString()) ? 10 : 0) + (t.clicks || 0) * 0.1 }))
        .sort((a, b) => b.recScore - a.recScore).slice(0, 6);
    }

    res.json(scored.map(t => ({
      _id: t._id, name: t.name, url: t.url, category: t.category,
      logo: t.logo, description: t.description,
      likes: t.likes || 0, isTrending: trendingIds.has(t._id.toString()),
    })));
  } catch (err) {
    console.error("recommend error:", err);
    res.json([]);
  }
});

app.post("/api/tools/:id/like", async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: "Login required" });
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid tool ID" });

  const tool = await Tool.findById(req.params.id);
  if (!tool) return res.status(404).json({ error: "Tool not found" });

  if (!tool.likedBy) tool.likedBy = [];
  const userIdStr = req.session.userId.toString();
  if (tool.likedBy.map((id) => id.toString()).includes(userIdStr)) {
    tool.likes   = Math.max(0, (tool.likes || 0) - 1);
    tool.likedBy = tool.likedBy.filter((id) => id.toString() !== userIdStr);
    await tool.save();
    return res.json({ likes: tool.likes, liked: false });
  }

  tool.likes = (tool.likes || 0) + 1;
  tool.likedBy.push(req.session.userId);
  await tool.save();
  res.json({ likes: tool.likes, liked: true });
});

app.get("/trending", marketplaceRedirect);

app.get("/submit", marketplaceRedirect);

app.post("/submit", upload.single("logo"), async (req, res) => {
  try {
    const { name, category, url, description } = req.body;
    if (!name || !category || !url || !description) return res.status(400).send("All fields are required");
    try { new URL(url); } catch { return res.status(400).send("Invalid URL format"); }

    const logoPath    = req.file ? "/uploads/" + req.file.filename : "/logos/default.png";
    const submittedBy = req.session?.userId ? String(req.session.userId) : "anonymous";

    await new Tool({
      name:        name.trim(),
      category:    category.trim(),
      url:         url.trim(),
      description: description.trim(),
      logo:        logoPath,
      clicks:      0,
      clickHistory: [],
      status:      "pending",   // hidden until admin approves
      submittedBy,
    }).save();

    res.send(`
      <html><head><meta http-equiv="refresh" content="3;url=/home"></head>
      <body style="font-family:sans-serif;text-align:center;padding:4rem">
        <h2>Submission received</h2>
        <p>Thanks — your submission is under review. Redirecting to your workspace…</p>
      </body></html>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error submitting tool");
  }
});

// ── Admin ─────────────────────────────────────────────────────────────────────

/**
 * requireAdmin — checks Basic Auth against ADMIN_PASSWORD env var.
 * Usage: set ADMIN_PASSWORD=yourpassword in .env
 * Access /admin with password prompt in browser.
 */
function requireAdmin(req, res, next) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return res.status(503).send("Admin not configured. Set ADMIN_PASSWORD in environment.");
  }

  const auth = req.headers.authorization || "";
  if (auth.startsWith("Basic ")) {
    const [, user, pass] = Buffer.from(auth.slice(6), "base64").toString().match(/^([^:]*):(.*)$/) || [];
    if (pass === adminPassword) return next();
  }

  res.set("WWW-Authenticate", "Basic realm=\"Aquiplex Admin\"");
  res.status(401).send("Admin authentication required.");
}

// GET /admin — review queue dashboard
app.get("/admin", requireAdmin, async (req, res) => {
  try {
    const pending  = await Tool.find({ status: "pending"  }).sort({ createdAt: -1 }).lean();
    const approved = await Tool.find({ status: "approved" }).sort({ createdAt: -1 }).limit(20).lean();
    const rejected = await Tool.find({ status: "rejected" }).sort({ createdAt: -1 }).limit(20).lean();

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Aquiplex Admin</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0d0d0d;color:#eee;margin:0;padding:2rem}
  h1{color:#fff;margin-bottom:.5rem}
  h2{color:#aaa;font-size:1rem;font-weight:500;margin:2rem 0 .75rem;text-transform:uppercase;letter-spacing:.05em}
  .badge{display:inline-block;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:600}
  .pending{background:#7c4d00;color:#ffb347}
  .approved{background:#0f4d2a;color:#4caf7d}
  .rejected{background:#4d0f0f;color:#f87171}
  table{width:100%;border-collapse:collapse;margin-bottom:2rem}
  th{text-align:left;padding:10px 12px;font-size:12px;color:#666;border-bottom:1px solid #222}
  td{padding:10px 12px;border-bottom:1px solid #1a1a1a;font-size:14px;vertical-align:middle}
  td a{color:#60a5fa;text-decoration:none}
  .btn{display:inline-block;padding:5px 14px;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;border:none;text-decoration:none}
  .btn-approve{background:#166534;color:#4ade80}
  .btn-reject{background:#7f1d1d;color:#fca5a5}
  form{display:inline}
  .empty{color:#555;font-style:italic;padding:1rem 0}
</style></head><body>
<h1>🛡 Aquiplex Admin</h1>
<p style="color:#666;font-size:13px">Tool submission moderation queue</p>

<h2>⏳ Pending Review (${pending.length})</h2>
${pending.length === 0 ? '<p class="empty">No pending submissions.</p>' : `
<table>
  <tr><th>Name</th><th>Category</th><th>URL</th><th>Submitted</th><th>Actions</th></tr>
  ${pending.map(t => `
  <tr>
    <td><strong>${t.name}</strong></td>
    <td>${t.category}</td>
    <td><a href="${t.url}" target="_blank">${t.url.slice(0, 40)}…</a></td>
    <td style="color:#666;font-size:12px">${new Date(t.createdAt||Date.now()).toLocaleDateString()}</td>
    <td>
      <form method="POST" action="/admin/tools/${t._id}/approve">
        <button class="btn btn-approve">✓ Approve</button>
      </form>
      <form method="POST" action="/admin/tools/${t._id}/reject" style="margin-left:6px">
        <button class="btn btn-reject">✕ Reject</button>
      </form>
    </td>
  </tr>`).join("")}
</table>`}

<h2>✅ Recently Approved (${approved.length})</h2>
${approved.length === 0 ? '<p class="empty">None.</p>' : `
<table>
  <tr><th>Name</th><th>Category</th><th>Clicks</th><th>Actions</th></tr>
  ${approved.map(t => `
  <tr>
    <td>${t.name}</td><td>${t.category}</td><td>${t.clicks||0}</td>
    <td>
      <form method="POST" action="/admin/tools/${t._id}/reject">
        <button class="btn btn-reject">✕ Remove</button>
      </form>
    </td>
  </tr>`).join("")}
</table>`}

<h2>❌ Rejected (${rejected.length})</h2>
${rejected.length === 0 ? '<p class="empty">None.</p>' : `
<table>
  <tr><th>Name</th><th>Category</th><th>Actions</th></tr>
  ${rejected.map(t => `
  <tr>
    <td>${t.name}</td><td>${t.category}</td>
    <td>
      <form method="POST" action="/admin/tools/${t._id}/approve">
        <button class="btn btn-approve">↩ Re-approve</button>
      </form>
    </td>
  </tr>`).join("")}
</table>`}
</body></html>`;
    res.send(html);
  } catch (err) {
    console.error("[admin]", err.message);
    res.status(500).send("Admin error: " + err.message);
  }
});

// POST /admin/tools/:id/approve
app.post("/admin/tools/:id/approve", requireAdmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).send("Invalid ID");
    await Tool.findByIdAndUpdate(req.params.id, { status: "approved", rejectionReason: "" });
    res.redirect("/admin");
  } catch (err) {
    res.status(500).send("Error approving tool: " + err.message);
  }
});

// POST /admin/tools/:id/reject
app.post("/admin/tools/:id/reject", requireAdmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).send("Invalid ID");
    const reason = (req.body?.reason || "").trim();
    await Tool.findByIdAndUpdate(req.params.id, { status: "rejected", rejectionReason: reason });
    res.redirect("/admin");
  } catch (err) {
    res.status(500).send("Error rejecting tool: " + err.message);
  }
});

app.get("/about", (req, res) => res.render("about"));


app.post("/bundle/:id/run", requireLogin, async (req, res) => {
  try {
    const { runBundle } = require("./services/execution.service");
    const bundle = await runBundle(req.params.id, generateAI);
    res.json({ success: true, bundle });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/bundle/save", requireLogin, async (req, res) => {
  try {
    const { title, steps, goal, answers } = req.body;
    if (!title || !steps || !Array.isArray(steps)) return res.status(400).json({ error: "Invalid bundle" });

    const saved = await new Bundle({
      userId:   req.session.userId,
      title,
      goal:     goal || title,
      answers:  answers || [],
      steps,
      progress: steps.map((s, i) => ({ step: i, status: "pending" })),
      status:   "draft",
    }).save();

    res.json({ success: true, id: saved._id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save bundle" });
  }
});

app.get("/bundle/:id", requireLogin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).send("Invalid bundle ID");
    const bundle = await Bundle.findOne({ _id: req.params.id, userId: req.session.userId }).lean();
    if (!bundle) return res.status(404).send("Bundle not found");
    res.render("bundle-view", { bundle });
  } catch {
    res.status(500).send("Error loading bundle");
  }
});

// ── Execute a single bundle step ──────────────────────────────────────────────
app.post("/execute-step", requireLogin, async (req, res) => {
  try {
    const { bundleId, stepIndex } = req.body;
    if (!bundleId || stepIndex === undefined) return res.status(400).json({ error: "bundleId and stepIndex required" });
    if (!mongoose.Types.ObjectId.isValid(bundleId)) return res.status(400).json({ error: "Invalid bundleId" });

    const bundle = await Bundle.findOne({ _id: bundleId, userId: req.session.userId });
    if (!bundle) return res.status(404).json({ error: "Bundle not found" });

    const step = bundle.steps[stepIndex];
    if (!step) return res.status(400).json({ error: `Step ${stepIndex} not found` });

    // Build context from previous outputs
    const prevOutputs = bundle.outputs
      .sort((a, b) => a.stepIndex - b.stepIndex)
      .map((o) => `Step ${o.stepIndex + 1} — ${o.title}:\n${o.content}`)
      .join("\n\n");

    const memoryLines = [...(bundle.memory || new Map()).entries()]
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");

    const systemPrompt = `You are an expert project executor. Execute the following project step and produce a detailed, actionable deliverable.

PROJECT: ${bundle.title}
GOAL: ${bundle.goal}
${memoryLines ? `MEMORY:\n${memoryLines}` : ""}
${bundle.contextSummary ? `CONTEXT:\n${bundle.contextSummary}` : ""}
${prevOutputs ? `PREVIOUS STEPS OUTPUT:\n${prevOutputs}` : ""}

Rules:
- Produce the actual deliverable (not a plan to produce it)
- Be specific, detailed, and immediately usable
- Use markdown formatting for clarity
- End with 3 key insights as a JSON block: {"keyInsights":["...","...","..."],"nextStepHints":["...","..."]}`;

    bundle.markStepStarted(stepIndex);
    await bundle.save();

    const startMs = Date.now();
    const raw = await generateAI([
      { role: "system", content: systemPrompt },
      { role: "user", content: `Execute Step ${stepIndex + 1}: ${step.title}\n\n${step.description}` },
    ], { temperature: 0.6, maxTokens: 1800 });

    const durationMs = Date.now() - startMs;

    // Extract JSON block at end if present
    let output = raw;
    let keyInsights = [];
    let nextStepHints = [];
    try {
      const jsonMatch = raw.match(/\{[\s\S]*"keyInsights"[\s\S]*\}(?:\s*)$/);
      if (jsonMatch) {
        const meta = JSON.parse(jsonMatch[0]);
        keyInsights   = meta.keyInsights   || [];
        nextStepHints = meta.nextStepHints || [];
        output = raw.slice(0, raw.lastIndexOf(jsonMatch[0])).trim();
      }
    } catch (_) {}

    bundle.markStepCompleted(stepIndex, {
      title:         step.title,
      content:       output,
      keyInsights,
      nextStepHints,
      durationMs,
      executedAt:    new Date(),
    });

    // Update context summary
    bundle.contextSummary = `${bundle.contextSummary ? bundle.contextSummary + "\n" : ""}Step ${stepIndex + 1} (${step.title}): ${keyInsights.slice(0, 2).join("; ")}`.slice(-800);

    // Merge key insights into memory
    if (keyInsights.length) {
      bundle.mergeMemory({ [`step_${stepIndex + 1}_insights`]: keyInsights.join("; ") });
    }

    await bundle.save();

    return res.json({
      success:       true,
      output,
      keyInsights,
      nextStepHints,
      durationMs,
      progress:      bundle.progress,
      outputs:       bundle.outputs,
      memory:        Object.fromEntries(bundle.memory || new Map()),
      contextSummary: bundle.contextSummary,
      currentStep:   bundle.currentStep,
      status:        bundle.status,
    });
  } catch (err) {
    console.error("❌ /execute-step error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Resume bundle (returns JSON) ──────────────────────────────────────────────
app.get("/resume/:id", requireLogin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, error: "Invalid ID" });
    const bundle = await Bundle.findOne({ _id: req.params.id, userId: req.session.userId }).lean();
    if (!bundle) return res.status(404).json({ success: false, error: "Bundle not found" });
    res.json({ success: true, bundle });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH
// ═════════════════════════════════════════════════════════════════════════════

app.get("/login",  redirectIfLoggedIn, (req, res) => res.render("login"));
app.get("/signup", redirectIfLoggedIn, (req, res) => res.render("signup"));

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).send("All fields are required");

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(401).send("User not found");

    const isMatch = user.password !== "google-oauth" ? await bcrypt.compare(password, user.password) : false;
    if (!isMatch) return res.status(401).send("Invalid credentials");

    req.session.user   = { _id: user._id, email: user.email, username: user.email.split("@")[0] };
    req.session.userId = user._id;
    req.session.save(() => res.redirect("/home"));
  } catch (err) {
    console.error(err);
    res.status(500).send("Login error");
  }
});

app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));

app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/login" }),
  (req, res) => {
    req.session.user   = { _id: req.user._id, email: req.user.email, username: req.user.email.split("@")[0] };
    req.session.userId = req.user._id;
    req.session.save(() => res.redirect("/home"));
  },
);

app.post("/signup", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).send("All fields are required");

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return res.status(400).send("Invalid email format");
    if (password.length < 6)    return res.status(400).send("Password must be at least 6 characters");

    const normalizedEmail = email.toLowerCase().trim();
    const exists = await User.findOne({ email: normalizedEmail });
    if (exists) return res.status(409).send("User already exists");

    const hashedPassword = await bcrypt.hash(password, 12);
    const newUser = await new User({ email: normalizedEmail, password: hashedPassword }).save();

    req.session.user   = { _id: newUser._id, email: newUser.email, username: newUser.email.split("@")[0] };
    req.session.userId = newUser._id;
    req.session.save(() => res.redirect("/home"));
  } catch (err) {
    console.error(err);
    res.status(500).send("Signup error");
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("aidex_session");
    res.redirect("/");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// STATIC PAGES
// ═════════════════════════════════════════════════════════════════════════════

app.get("/founders",            (req, res) => res.render("founders"));

// ── Pricing page ───────────────────────────────────────────────────────────────
app.get("/pricing", async (req, res) => {
  try {
    let pricingUser = null;
    if (req.session && req.session.userId) {
      const u = await User.findById(req.session.userId).select("wallet email").lean();
      if (u) pricingUser = u;
    }
    return res.render("pricing", { pricingUser });
  } catch (err) {
    console.error("[pricing]", err.message);
    return res.render("pricing", { pricingUser: null });
  }
});

app.get("/wallet", requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId)
      .select("wallet email billingEmail phone")
      .lean();
    res.render("wallet", { user });
  } catch (err) {
    console.error("[wallet page]", err.message);
    res.status(500).send("Error loading wallet page");
  }
});




app.get("/download", (req, res) => {
  const filePath = path.join(__dirname, "public/uploads/Aquiplex.apk");
  if (!fs.existsSync(filePath)) return res.status(404).send("Download not available yet");
  res.download(filePath, "Aquiplex.apk", (err) => {
    if (err && !res.headersSent) res.status(500).send("Download failed");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLOG ROUTES
// ═════════════════════════════════════════════════════════════════════════════

app.get("/write", (req, res) => res.render("write"));

// /blog → /blogs canonical redirect
app.get("/blog", (req, res) => res.redirect(301, "/blogs"));

app.get("/blogs", (req, res) => {
  const allBlogs = [...dynamicBlogs, ...blogs];
  res.render("blogs", { blogs: allBlogs });
});

app.get("/blogs/:slug", (req, res) => {
  const allBlogs = [...dynamicBlogs, ...blogs];
  const blog     = allBlogs.find((b) => b.slug === req.params.slug);
  if (!blog) {
    try { return res.status(404).render("404"); } catch (_) {}
    return res.status(404).send("Blog not found");
  }
  res.render("blog-detail", { blog });
});

app.post("/write", (req, res) => {
  const { title, content } = req.body;
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  dynamicBlogs.unshift({
    title,
    content,
    slug,
    author:      "You",
    createdAt:   new Date().toISOString().split("T")[0],
    description: content.substring(0, 120),
    readTime:    Math.ceil(content.split(" ").length / 200) + " min read",
  });
  console.log("✅ New blog written:", slug);
  res.redirect("/blogs");
});

// ── Billing page ───────────────────────────────────────────────────────────────
app.get("/billing", async (req, res) => {
  try {
    let billingUser = null;
    if (req.session && req.session.userId) {
      // FIXED: `plan` field removed in v2 — derive from role + isUnlimited
      const u = await User.findById(req.session.userId)
        .select("wallet email role isUnlimited")
        .lean();
      if (u) {
        // Compute plan string so templates don't get undefined
        u.plan = u.role === "admin" ? "admin" : (u.isUnlimited ? "pro" : "free");
        billingUser = u;
      }
    }
    return res.render("billing", { billingUser, user: billingUser });
  } catch (err) {
    console.error("[billing page]", err.message);
    return res.render("billing", { billingUser: null, user: null });
  }
});

// ── Categories page (retired marketplace surface) ─────────────────────────────
app.get("/categories", marketplaceRedirect);

// ═════════════════════════════════════════════════════════════════════════════
// ERROR HANDLERS
// ═════════════════════════════════════════════════════════════════════════════

app.use((req, res) => {
  // Try to render a 404 view, fall back to plain text
  try { return res.status(404).render("404"); } catch (_) {}
  res.status(404).send("Page not found");
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (err.code === "LIMIT_FILE_SIZE")        return res.status(400).json({ reply: "⚠️ File too large. Maximum size is 10MB." });
  if (err.message?.includes("not supported")) return res.status(400).json({ reply: `⚠️ ${err.message}` });
  res.status(500).json({ reply: `⚠️ ${err.message || "Something went wrong. Please try again."}` });
});

// ═════════════════════════════════════════════════════════════════════════════
// START
// ═════════════════════════════════════════════════════════════════════════════

async function startServer() {
  // Connect DB first (startup checks need mongoose connection)
  await connectDB();

  // Startup validation: env vars, index self-healing, Razorpay key check
  await runStartupChecks();

  await importTools();

  const PORT   = process.env.PORT || 5000;
  const http   = require("http");
  const server = http.createServer(app);

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.log("⚠️ Port busy, retrying...");
      setTimeout(() => server.listen(0, "0.0.0.0"), 1000);
    }
  });

  server.listen(PORT, "0.0.0.0", () => console.log(`🚀 Aqua AI running on port ${PORT}`));
}

startServer();
