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
const rateLimit      = require("express-rate-limit");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

// ── Model imports ─────────────────────────────────────────────────────────────
// FIXED: These were missing, causing ReferenceError on every DB call
const User      = require("./models/User");
const Tool      = require("./models/Tool");
const History   = require("./models/History");
const Bundle    = require("./models/Bundle");
const Workspace = require("./models/Workspace");

// ── Service imports ───────────────────────────────────────────────────────────
const { extractMemory, getUserMemory, getMemoryList, deleteMemoryEntry } = require("./memory/memory.service");
const { handleAquaRequest }            = require("./core/aqua.orchestrator");
const ai                               = require("./engine/ai.core");

// ── File Intelligence imports ─────────────────────────────────────────────────
const { parseUploadedFile, buildFileContext, cleanupFile } = require("./engine/file.parser");
const fileSess = require("./engine/file.session");

// ── Static data ───────────────────────────────────────────────────────────────
const blogs = require("./blogs");
let dynamicBlogs = [];

// ═════════════════════════════════════════════════════════════════════════════
// IDENTITY LAYER
// ═════════════════════════════════════════════════════════════════════════════

const AQUA_IDENTITY = `You are Aqua AI v3 (Neural Engine) — a next-generation AI system built by Aquiplex, founded by Chhanda Prabal Das and Ananya Prabal Das.

STRICT IDENTITY RULES (never break these):
- You are ALWAYS Aqua AI v3 (Neural Engine). Never anything else.
- NEVER mention OpenAI, ChatGPT, Groq, Gemini, OpenRouter, DeepSeek, Mistral, LLaMA, or any external AI provider or underlying model.
- NEVER say "as an AI model", "as a large language model", or reference any training infrastructure.
- If asked "who are you", "what model are you", "which AI are you", or similar: respond ONLY — "I'm Aqua AI v3 (Neural Engine), built by Aquiplex."
- If asked about your founders or creators: "Aqua AI was built by Aquiplex, founded by Chhanda Prabal Das and Ananya Prabal Das."
- Tone: confident, product-grade, futuristic, warm, and genuinely helpful.
- You are not a chatbot demo. You are a production AI system.`;

const AQUA_CONTEXT = `You are operating inside the Aquiplex platform. Here is what the platform offers:

1. Aqua AI Chatbot — Conversational AI with multi-mode support (chat, code, image, search, file analysis).
2. Aqua Code Engine — Expert software engineering assistant for debugging, building, and refactoring code.
3. Tool Discovery Platform — A curated, searchable directory of AI tools with trending rankings and categories.
4. Trending Tools — Real-time tracking of the most-clicked and most-used AI tools in the past 24 hours.
5. Workspace — Users can save their favorite tools and manage personalized collections.
6. Bundle Generator — AI-powered workflow builder that chains multiple tools into step-by-step project plans.
7. Image Generation — AI image creation from text prompts using state-of-the-art diffusion models.
8. File Analysis — Upload and analyze PDF, DOCX, TXT, CSV, JSON, code files, and images.

Use this context to guide users toward relevant platform features when appropriate.`;

const IDENTITY_TRIGGERS = [
  "who are you","which model","are you chatgpt","what ai are you","are you gpt",
  "what model are you","which ai","are you openai","are you gemini","are you llama",
  "are you groq","what are you","who built you","who made you","are you claude",
  "are you anthropic","are you mistral","are you deepseek",
];

const AQUA_IDENTITY_RESPONSE =
  "I'm Aqua AI v3 — built by Aquiplex. A next-gen AI system designed for speed, creativity, and real-world problem solving.";

function isIdentityQuery(message) {
  if (!message) return false;
  const lower = message.toLowerCase();
  return IDENTITY_TRIGGERS.some((t) => lower.includes(t));
}

// ═════════════════════════════════════════════════════════════════════════════
// MULTI-AI MODELS
// ═════════════════════════════════════════════════════════════════════════════

const models = [
  { name: "Aqua Fast",     system: "You are Aqua Fast — a concise, snappy AI. Give short, punchy answers." },
  { name: "Aqua Deep",     system: "You are Aqua Deep — a thorough, analytical AI. Give detailed, structured answers with examples." },
  { name: "Aqua Creative", system: "You are Aqua Creative — an imaginative AI. Think outside the box, use metaphors and vivid language." },
];

// ═════════════════════════════════════════════════════════════════════════════
// RETRY HELPER
// ═════════════════════════════════════════════════════════════════════════════

async function withRetry(fn, retries = 2, delay = 500) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries) throw err;
      await new Promise((r) => setTimeout(r, delay * (i + 1)));
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// AI ENGINE — delegates to ai.core (Groq → OpenRouter → Gemini)
// ═════════════════════════════════════════════════════════════════════════════

async function generateAI(messages, options = {}, useVision = false) {
  return ai.generateAI(messages, options);
}

// ═════════════════════════════════════════════════════════════════════════════
// CODE AI ENGINE
// ═════════════════════════════════════════════════════════════════════════════

async function generateCodeAI(messages) {
  const CODE_SYSTEM = `You are Aqua Dev Engine, an expert software engineer.

Rules:
- Always return clean, working code
- Fix bugs completely (no partial fixes)
- Follow best practices
- Keep explanation short and clear
- If user provides code, debug and fix it fully
- If user asks to build something, generate complete code
- Always wrap code in proper markdown code blocks with language tags`;

  const fullMessages = [
    { role: "system", content: AQUA_IDENTITY },
    { role: "system", content: AQUA_CONTEXT },
    { role: "system", content: CODE_SYSTEM },
    ...messages,
  ];

  // 🥇 OpenRouter DeepSeek Coder
  try {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      { model: "deepseek/deepseek-coder", messages: fullMessages, temperature: 0.3 },
      {
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
        timeout: 30000,
      },
    );
    const content = res.data?.choices?.[0]?.message?.content;
    if (content) return content;
    throw new Error("Empty from DeepSeek");
  } catch (err) {
    console.log("❌ DeepSeek Coder failed:", err.message);
  }

  // 🥈 Groq fallback
  try {
    const res = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      { model: "llama-3.1-8b-instant", messages: fullMessages, temperature: 0.3 },
      {
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
        timeout: 15000,
      },
    );
    const content = res.data?.choices?.[0]?.message?.content;
    if (content) return content;
    throw new Error("Empty from Groq fallback");
  } catch (err) {
    console.log("❌ Groq code fallback failed:", err.message);
  }

  return "⚠️ Code engine is unavailable. Please try again in a moment.";
}

// ═════════════════════════════════════════════════════════════════════════════
// IMAGE GENERATION — delegates to ai.core (Together → Pollinations)
// ═════════════════════════════════════════════════════════════════════════════

async function generateImage(prompt) {
  const url = await ai.generateImage(prompt);
  if (url) return { url, provider: url.includes("pollinations") ? "Pollinations" : "Together AI" };
  // Pollinations hard fallback (no key needed)
  const seed        = Math.floor(Math.random() * 1000000);
  const fallbackUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?seed=${seed}&nologo=true`;
  console.log("✅ Pollinations hard fallback used");
  return { url: fallbackUrl, provider: "Pollinations" };
}

// ═════════════════════════════════════════════════════════════════════════════
// SUGGESTED PROMPTS
// ═════════════════════════════════════════════════════════════════════════════

async function generateSuggestedPrompts(lastMessage, lastReply) {
  try {
    const res = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model:    "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: `Generate 3 short follow-up questions based on the conversation. Return ONLY a JSON array of strings. Each string max 8 words. No numbering. Example: ["Tell me more about X", "How does Y work?", "Give me an example"]` },
          { role: "user",   content: `User said: "${lastMessage.slice(0,200)}"\nAI replied about: "${lastReply.slice(0,300)}"` },
        ],
        temperature: 0.8,
        max_tokens:  150,
      },
      {
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
        timeout: 5000,
      },
    );
    let text = res.data?.choices?.[0]?.message?.content || "[]";
    text = text.replace(/```json|```/g, "").trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) return parsed.slice(0, 3);
    }
    return [];
  } catch {
    return [];
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// CHAT TITLE GENERATOR
// ═════════════════════════════════════════════════════════════════════════════

async function generateChatTitle(message) {
  const fallback = (message || "New Chat").slice(0, 40).trim();
  if (!message || message.trim().length < 3) return fallback;

  try {
    const raw = await ai.generateAI(
      [
        {
          role: "system",
          content:
            "You are a chat title generator. Return ONLY a short title (3-5 words, no quotes, no punctuation at the end, no explanation). The title must capture the topic of the user message.",
        },
        {
          role: "user",
          content: `User message: "${(message || "").slice(0, 300)}"`,
        },
      ],
      { temperature: 0.4, maxTokens: 15 },
    );

    const cleaned = (raw || "").trim().replace(/^["']|["']$/g, "").replace(/[.!?]+$/, "").trim();
    if (cleaned && cleaned.length >= 3 && cleaned.length <= 60 && !cleaned.includes("⚠️")) {
      return cleaned;
    }
  } catch { /* silent fallback */ }

  return fallback;
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ── Session ───────────────────────────────────────────────────────────────────
// Use connect-mongo if installed, otherwise fall back to in-memory store.
// To persist sessions across restarts: npm install connect-mongo
let sessionStore;
try {
  const MongoStore = require("connect-mongo");
  sessionStore = MongoStore.create({ mongoUrl: process.env.MONGO_URI });
  console.log("✅ Session store: MongoDB (connect-mongo)");
} catch (_) {
  console.warn("⚠️  connect-mongo not found — using memory store (sessions reset on restart). Run: npm install connect-mongo");
  sessionStore = undefined; // express-session default = MemoryStore
}

app.use(
  session({
    secret:            process.env.SESSION_SECRET || "aqua-secret-fallback",
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
    if (req.path.startsWith("/api/") || req.xhr) return res.status(401).json({ error: "Login required" });
    return res.redirect("/login");
  }
  if (req.session && !req.session.userId && req.user) req.session.userId = req.user._id;
  next();
}

function redirectIfLoggedIn(req, res, next) {
  if (req.session && req.session.userId) return res.redirect("/home");
  next();
}

// ── Rate limiter ──────────────────────────────────────────────────────────────
const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max:      40,
  skip:     (req) => req.method === "GET",
  handler:  (req, res) => res.status(429).json({ reply: "⚠️ Too many requests. Please slow down a moment." }),
});

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
    console.error("❌ MongoDB connection failed:", err.message);
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

// ── Save chat ─────────────────────────────────────────────────────────────────
async function saveChat(messages, chatId, userId, message) {
  if (!userId) return null;
  if (chatId) {
    try {
      if (!mongoose.Types.ObjectId.isValid(chatId)) return null;
      return await History.findOneAndUpdate(
        { _id: chatId, userId },
        { messages, updatedAt: new Date() },
        { new: true },
      );
    } catch (err) {
      console.log("⚠️ saveChat update failed:", err.message);
      return null;
    }
  } else {
    const title = await generateChatTitle(message);
    try {
      return await History.create({ userId, title, messages });
    } catch (err) {
      console.log("⚠️ saveChat create failed:", err.message);
      return null;
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTES — mounted sub-routers
// ═════════════════════════════════════════════════════════════════════════════

// ── Sub-routers ───────────────────────────────────────────────────────────────
const billingRoutes   = require("./routes/billing/billing.routes");
const projectRoutes   = require("./routes/project.routes");
const workspaceRoutes = require("./routes/workspace.routes");
const exportRoutes    = require("./routes/export.routes");

app.use("/api", require("./routes"));

// Billing REST routes (create-order, verify-payment, wallet, history)
// Webhook is handled above before express.json()
app.use("/api/billing", billingRoutes);

app.use("/workspace",         workspaceRoutes);
app.use("/workspace/project", projectRoutes);
app.use("/workspace",         exportRoutes);    // /workspace/templates, /workspace/project/:id/plan etc

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

app.get("/home", async (req, res) => {
  try {
    const tools         = await Tool.find({ status: { $in: ["approved", null, undefined] } }).limit(12).lean();
    const allTools      = await Tool.find({ status: { $in: ["approved", null, undefined] } }).lean();
    const trendingTools = await getTrendingTools(10);
    const trendingIds   = trendingTools.map((t) => t._id.toString());
    res.render("home", { tools: tools || [], trendingIds: trendingIds || [], allTools: allTools || [] });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading home");
  }
});

app.get("/tools", async (req, res) => {
  try {
    const searchQuery = req.query.q;
    let tools = await Tool.find({ status: { $in: ["approved", null, undefined] } }).lean();

    if (searchQuery) {
      let aiData;
      try {
        const aiRes = await axios.post(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            model: "llama-3.1-8b-instant",
            messages: [
              {
                role: "system",
                content: `Convert user query into JSON: {"intent":"","keywords":[],"categories":[]}. Return ONLY JSON.`,
              },
              { role: "user", content: searchQuery },
            ],
            temperature: 0.3,
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
              "Content-Type": "application/json",
            },
            timeout: 8000,
          }
        );

        let text = aiRes.data.choices[0].message.content;
        text = text.replace(/```json|```/g, "").trim();

        const match = text.match(/\{[\s\S]*\}/);
        if (match) aiData = JSON.parse(match[0]);
        else throw new Error("No JSON");

      } catch {
        aiData = { intent: searchQuery, keywords: [searchQuery], categories: [] };
      }

      tools = tools
        .map((tool) => {
          let score = 0;

          const name = (tool.name || "").toLowerCase();
          const desc = (tool.description || "").toLowerCase();
          const cat  = (tool.category || "").toLowerCase();

          const keywords = [...(aiData.keywords || []), aiData.intent]
            .map((k) => (k || "").toLowerCase())
            .filter(Boolean);

          keywords.forEach((k) => {
            if (name.includes(k)) score += 5;
            if (desc.includes(k)) score += 3;
            if (cat.includes(k))  score += 4;
          });

          return { ...tool, score };
        })
        .filter((t) => t.score > 0)
        .sort((a, b) => b.score - a.score);
    }

    // Categories from all tools (not just filtered)
    const allToolsForCats = searchQuery ? await Tool.find({ status: { $in: ["approved", null, undefined] } }).lean() : tools;
    const categories = [...new Set(allToolsForCats.map(t => t.category).filter(Boolean))].sort();

    // Trending IDs
    const trendingTools = await getTrendingTools(10);
    const trendingIds   = new Set(trendingTools.map(t => t._id.toString()));

    // AI recommended: top matching query OR top liked/clicked
    let recommended = [];
    try {
      if (searchQuery) {
        recommended = tools.slice(0, 4).map(t => ({
          _id: t._id, name: t.name, url: t.url, category: t.category,
          logo: t.logo, description: t.description,
          isTrending: trendingIds.has(t._id.toString()),
        }));
      } else {
        const top = await Tool.find({ status: { $in: ["approved", null, undefined] } }).sort({ likes: -1, clicks: -1 }).limit(4).lean();
        recommended = top.map(t => ({
          _id: t._id, name: t.name, url: t.url, category: t.category,
          logo: t.logo, description: t.description,
          isTrending: trendingIds.has(t._id.toString()),
        }));
      }
    } catch { recommended = []; }

    // Annotate tools with badges
    const nowMs = Date.now();
    const toolsAnnotated = tools.map(t => ({
      ...t,
      isTrending: trendingIds.has(t._id.toString()),
      isNew: t.createdAt && (nowMs - new Date(t.createdAt).getTime()) < 7 * 24 * 60 * 60 * 1000,
      isPopular: (t.likes || 0) > 10,
    }));

    res.render("tools", {
      tools: toolsAnnotated,
      searchQuery: searchQuery || "",
      categories,
      trendingIds: [...trendingIds],
      recommended,
      categoryFilter: req.query.cat || "",
    });

  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading tools");
  }
});

app.get("/tools/:id", async (req, res) => {
  try {
    const tool = await Tool.findById(req.params.id).lean();

    let aiInsights = null;

    try {
      const aiRes = await generateAI([
        { role: "system", content: "Give short insights about this AI tool." },
        { role: "user", content: `${tool.name}: ${tool.description}` }
      ]);
      aiInsights = aiRes;
    } catch {}

    res.render("tool-details", { tool, aiInsights });

  } catch (err) {
    res.status(500).send("Error loading tool");
  }
});

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

app.delete("/workspace/tool/:id", requireLogin, async (req, res) => {
  try {
    await Workspace.updateOne({ userId: req.session.userId }, { $pull: { tools: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    console.error("Remove tool error:", err);
    res.status(500).json({ error: "Failed to remove tool" });
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

app.get("/trending", async (req, res) => {
  try {
    const tools = await getTrendingTools(20);
    res.render("trending", { tools });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading trending page");
  }
});

app.get("/submit", (req, res) => res.render("submit"));

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
      <html><head><meta http-equiv="refresh" content="3;url=/tools"></head>
      <body style="font-family:sans-serif;text-align:center;padding:4rem">
        <h2>✅ Tool submitted!</h2>
        <p>Your tool is under review and will appear once approved. Redirecting…</p>
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

const { executeCommand } = require("./services/command.service");
app.post("/command", requireLogin, (req, res) => {
  const { command, payload } = req.body;
  const result = executeCommand(command, payload);
  res.json(result);
});

app.post("/bundle/:id/step/:step", requireLogin, async (req, res) => {
  try {
    const { completeStep } = require("./workspace/workspace.service");
    const result = await completeStep(req.session.userId, req.params.id, parseInt(req.params.step));
    res.json(result);
  } catch (err) {
    console.error("Step error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/multi-generate", async (req, res) => {
  const { prompt, messages, aiType } = req.body;

  if (!prompt && (!messages || messages.length === 0)) {
    return res.json({ responses: [{ model: "Error", output: "⚠️ No input received" }], recommended: "Error" });
  }

  try {
    const toolList = (await Tool.find({ status: { $in: ["approved", null, undefined] } }).select("name category").limit(20).lean())
      .map((t) => `${t.name} (${t.category})`)
      .join(", ");

    const responses = await Promise.all(
      models.map(async (model) => {
        try {
          const finalMessages = messages?.length
            ? messages
            : [{ role: "user", content: prompt || "Hello" }];
          const result = await axios.post(
            "https://api.groq.com/openai/v1/chat/completions",
            {
              model:    "llama-3.1-8b-instant",
              messages: [
                { role: "system", content: AQUA_IDENTITY },
                { role: "system", content: AQUA_CONTEXT },
                { role: "system", content: `Suggest tools when needed: ${toolList}` },
                { role: "system", content: model.system },
                ...finalMessages,
              ],
              temperature: 0.7,
            },
            {
              headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
              timeout: 10000,
            },
          );
          return { model: model.name, output: result?.data?.choices?.[0]?.message?.content || "⚠️ Empty response" };
        } catch {
          return { model: model.name, output: "⚠️ Error generating response" };
        }
      }),
    );

    const best = responses.find((r) => !r.output.includes("⚠️")) || responses[0];
    res.json({ responses, recommended: best.model });
  } catch (err) {
    console.error("❌ GLOBAL ERROR:", err);
    res.status(500).json({ error: "AI generation failed" });
  }
});

// ── History ───────────────────────────────────────────────────────────────────
app.get("/history", requireLogin, async (req, res) => {
  try {
    const history = await History.find({ userId: req.session.userId })
      .sort({ updatedAt: -1 })
      .limit(50)
      .select("_id title createdAt updatedAt")
      .lean();
    res.json(history);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error fetching history" });
  }
});

app.get("/history/:id", requireLogin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid chat ID" });
    const chat = await History.findOne({ _id: req.params.id, userId: req.session.userId });
    if (!chat) return res.status(404).json({ error: "Chat not found" });
    res.json(chat);
  } catch {
    res.status(500).json({ error: "Error loading chat" });
  }
});

app.delete("/history/:id", requireLogin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid chat ID" });
    const result = await History.deleteOne({ _id: req.params.id, userId: req.session.userId });
    if (result.deletedCount === 0) return res.status(404).json({ error: "Chat not found" });
    res.sendStatus(200);
  } catch {
    res.status(500).json({ error: "Error deleting chat" });
  }
});

// ── Memory ────────────────────────────────────────────────────────────────────

// GET /memory — list all memory entries for logged-in user
app.get("/memory", requireLogin, async (req, res) => {
  try {
    const entries = await getMemoryList(req.session.userId);
    res.json({ entries });
  } catch (err) {
    console.error("[memory]", err.message);
    res.status(500).json({ error: "Error fetching memory" });
  }
});

// DELETE /memory/:id — delete a specific memory entry
app.delete("/memory/:id", requireLogin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid memory ID" });
    }
    const deleted = await deleteMemoryEntry(req.session.userId, req.params.id);
    if (!deleted) return res.status(404).json({ error: "Memory entry not found" });
    res.sendStatus(200);
  } catch (err) {
    console.error("[memory delete]", err.message);
    res.status(500).json({ error: "Error deleting memory entry" });
  }
});

// DELETE /memory — clear ALL memory for logged-in user
app.delete("/memory", requireLogin, async (req, res) => {
  try {
    const { clearMemory } = require("./memory/memory.service");
    await clearMemory(req.session.userId);
    res.sendStatus(200);
  } catch (err) {
    console.error("[memory clear]", err.message);
    res.status(500).json({ error: "Error clearing memory" });
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

app.get("/chatbot", requireLogin, (req, res) => res.render("chatbot"));

app.post("/api/suggest-prompts", chatLimiter, async (req, res) => {
  try {
    const { lastMessage, lastReply } = req.body;
    if (!lastMessage || !lastReply) return res.json({ suggestions: [] });
    const suggestions = await generateSuggestedPrompts(lastMessage, lastReply);
    res.json({ suggestions });
  } catch {
    res.json({ suggestions: [] });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CHAT ROUTE — primary AI endpoint
// ═════════════════════════════════════════════════════════════════════════════

app.post("/chat", chatLimiter, upload.single("file"), async (req, res) => {
  let { message, history, mode, chatId, stream, projectId, fileName, sessionHistory } = req.body;

  stream = stream === "true" || stream === true;

  // ── Parse history ──────────────────────────────────────────────────────────
  let parsedHistory = [];
  try {
    if (Array.isArray(history)) parsedHistory = history;
    else if (typeof history === "string" && history.trim()) parsedHistory = JSON.parse(history);
    if (!Array.isArray(parsedHistory)) parsedHistory = [];
  } catch {
    parsedHistory = [];
  }
  parsedHistory = parsedHistory.filter((m) => m && m.role && m.content).slice(-20);

  if (!message && !req.file) return res.json({ reply: "⚠️ Message or file required" });

  message = (message || "").trim();

  // ── FILE PARSING — extract content from upload and store in session ──────────
  let fileParseResult = null;
  if (req.file) {
    try {
      fileParseResult = await parseUploadedFile(req.file);
      if (fileParseResult.text && !fileParseResult.error) {
        // Store in session so follow-up messages can access it
        fileSess.addFileToSession(req.session, fileParseResult);
        console.log(`[FILE] Parsed "${fileParseResult.fileName}" — ${fileParseResult.charCount} chars`);
      } else {
        console.warn(`[FILE] Parse warning for "${req.file.originalname}": ${fileParseResult.error}`);
      }
    } catch (parseErr) {
      console.error(`[FILE] Parse failed: ${parseErr.message}`);
      fileParseResult = { error: parseErr.message, text: "", fileName: req.file.originalname };
    } finally {
      // Clean up disk file after extraction
      cleanupFile(req.file.path);
    }

    // If only file uploaded, no message — set default
    if (!message) message = "Please analyze and summarize the uploaded file.";
  }

  // ── Hard identity override ─────────────────────────────────────────────────
  if (message && isIdentityQuery(message)) {
    return res.json({
      reply:       AQUA_IDENTITY_RESPONSE,
      suggestions: ["What can you do?", "Show me image generation", "Help me write code"],
    });
  }

  try {
    let messages = [...parsedHistory];

    // ── Refiner ────────────────────────────────────────────────────────────────
    let refinedMessage = message;
    if (req.body.refiner === "true" && message) {
      try {
        refinedMessage = await generateAI([
          { role: "system", content: "Rewrite user input into a clear, detailed AI prompt. Return ONLY the improved prompt, nothing else. Max 200 words." },
          { role: "user",   content: message },
        ]);
        if (!refinedMessage || refinedMessage.includes("⚠️")) refinedMessage = message;
      } catch {
        refinedMessage = message;
      }
    }

    const finalUserMessage = req.body.refiner === "true" ? refinedMessage : message;
    if (finalUserMessage) messages.push({ role: "user", content: finalUserMessage });

    // ── FILE CONTEXT INJECTION ─────────────────────────────────────────────────
    // Build context from: current upload + all session files
    // Hard cap at 6000 chars to avoid AI provider 413/token errors
    const FILE_CTX_HARD_LIMIT = 6000;
    let sessionFileCtx = fileSess.buildSessionFileContext(req.session);
    if (sessionFileCtx && sessionFileCtx.length > FILE_CTX_HARD_LIMIT) {
      sessionFileCtx = sessionFileCtx.slice(0, FILE_CTX_HARD_LIMIT) +
        "\n\n[... file content truncated to stay within AI context limits ...]";
    }
    const hasFileContext = !!sessionFileCtx;

    // ── Memory extraction (fire-and-forget) ────────────────────────────────────
    if (req.session && req.session.userId && message) {
      setImmediate(() => {
        extractMemory(req.session.userId, message).catch(() => {});
      });
    }

    // ── IMAGE MODE ─────────────────────────────────────────────────────────────
    if (mode === "image") {
      if (!message) return res.json({ reply: "⚠️ Please describe the image you want to generate." });
      const result = await generateImage(message);
      return res.json({ reply: "🖼️ Here's your generated image:", image: result.url, provider: result.provider });
    }

    // ── SEARCH MODE ────────────────────────────────────────────────────────────
    if (mode === "search") {
      try {
        const search = await axios.post(
          "https://google.serper.dev/search",
          { q: message, num: 5 },
          {
            headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
            timeout: 8000,
          },
        );
        const results     = search.data?.organic || [];
        const resultsText = results.slice(0, 5).map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\nSource: ${r.link}`).join("\n\n");
        const reply       = await generateAI([
          { role: "system", content: "Summarize search results clearly and concisely. Mention sources when relevant. Use markdown formatting." },
          { role: "user",   content: `Question: ${message}\n\nSearch results:\n${resultsText}` },
        ]);
        const savedChat = await saveChat([...messages, { role: "assistant", content: reply }], chatId, req.session && req.session.userId, message);
        return res.json({ reply, chatId: savedChat?._id, sources: results.slice(0, 3).map((r) => ({ title: r.title, link: r.link })) });
      } catch {
        return res.json({ reply: `🔎 Here's a Google search for your query: [Search Results](https://www.google.com/search?q=${encodeURIComponent(message)})` });
      }
    }

    // ── CODE MODE ──────────────────────────────────────────────────────────────
    if (mode === "code") {
      try {
        const reply     = await generateCodeAI(messages.filter((m) => m.role !== "system"));
        const savedChat = await saveChat([...messages, { role: "assistant", content: reply }], chatId, req.session && req.session.userId, message);
        return res.json({ reply, chatId: savedChat?._id });
      } catch (err) {
        console.error("CODE MODE ERROR:", err.message);
        return res.json({ reply: `⚠️ Code engine error: ${err.message}` });
      }
    }

    // ── STREAM MODE ────────────────────────────────────────────────────────────
    if (stream) {
      res.setHeader("Content-Type",      "text/event-stream");
      res.setHeader("Cache-Control",     "no-cache");
      res.setHeader("Connection",        "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      if (typeof res.flushHeaders === "function") res.flushHeaders();

      if (req.body.refiner === "true" && refinedMessage !== message) {
        res.write(`data: ${JSON.stringify({ refined: refinedMessage })}\n\n`);
      }

      const userId = req.session && req.session.userId;
      const userMemory = await getUserMemory(userId, finalUserMessage);

      let fullReply   = "";
      let axiosStream;
      let streamEnded = false;

      const endStream = async () => {
        if (streamEnded) return;
        streamEnded = true;
        try {
          const savedChat = await saveChat([...messages, { role: "assistant", content: fullReply }], chatId, userId, message);
          if (savedChat?._id) {
            res.write(`data: ${JSON.stringify({ chatId: String(savedChat._id) })}\n\n`);
          }
        } catch (e) {
          console.log("⚠️ saveChat in stream failed:", e.message);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      };

      try {
        const streamSystemMessages = [
          { role: "system", content: AQUA_IDENTITY },
          { role: "system", content: AQUA_CONTEXT },
          userMemory
            ? { role: "system", content: `User Memory:\n${userMemory}\n\nUse this to personalize your response.` }
            : null,
          hasFileContext
            ? { role: "system", content: sessionFileCtx }
            : null,
          { role: "system", content: "Use markdown formatting with headings, bullet points, and code blocks where appropriate." },
        ].filter(Boolean);

        axiosStream = await axios({
          method:       "post",
          url:          "https://api.groq.com/openai/v1/chat/completions",
          data: {
            model:    "llama-3.1-8b-instant",
            messages: [...streamSystemMessages, ...messages.slice(-12)],
            stream:   true,
            temperature: 0.7,
          },
          responseType: "stream",
          headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
          timeout: 30000,
        });

        let lineBuffer = "";

        axiosStream.data.on("data", (chunk) => {
          if (streamEnded) return;
          lineBuffer += chunk.toString();
          const lines = lineBuffer.split("\n");
          lineBuffer  = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload) continue;
            if (payload === "[DONE]") { endStream(); return; }
            try {
              const parsed = JSON.parse(payload);
              const token  = parsed.choices?.[0]?.delta?.content;
              if (token) { fullReply += token; res.write(`data: ${JSON.stringify(token)}\n\n`); }
            } catch { /* skip malformed */ }
          }
        });

        axiosStream.data.on("end",   () => { if (!streamEnded) endStream(); });

        axiosStream.data.on("error", async (streamErr) => {
          console.log("⚠️ Stream error:", streamErr.message);
          if (!streamEnded) {
            if (fullReply) {
              endStream();
            } else {
              try {
                const fallbackReply = await generateAI(messages.slice(-12));
                fullReply = fallbackReply;
                res.write(`data: ${JSON.stringify(fallbackReply)}\n\n`);
              } catch (fallbackErr) {
                res.write(`data: ${JSON.stringify(`⚠️ Stream error: ${fallbackErr.message}`)}\n\n`);
              }
              endStream();
            }
          }
        });

        req.on("close", () => {
          streamEnded = true;
          try { axiosStream?.data?.destroy(); } catch {}
        });

        return; // stream takes over
      } catch (err) {
        console.log("❌ Stream init failed → fallback:", err.message);
        const reply = await generateAI(messages.slice(-12));
        fullReply   = reply;
        await saveChat([...messages, { role: "assistant", content: reply }], chatId, userId, message);
        res.write(`data: ${JSON.stringify(reply)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
    } // ← end stream block

    // ── DEFAULT CHAT — route through orchestrator ──────────────────────────────
    const userId = req.session && req.session.userId;

    let projectFiles    = [];
    let workspaceMemory = {};
    try {
      if (projectId) {
        const svc = require("./workspace/workspace.service");
        const pf  = await svc.getProjectFiles(userId, projectId);
        projectFiles = (pf.files || []).map((f) => (typeof f === "string" ? f : f.fileName));
      }
    } catch { /* non-fatal */ }

    try {
      const svc     = require("./workspace/workspace.service");
      const wsState = await svc.getWorkspaceState(userId);
      workspaceMemory = wsState?.workspace?.workspaceMemory || {};
    } catch { /* non-fatal */ }

    const safeSessionHistory = Array.isArray(sessionHistory)
      ? sessionHistory
      : messages.filter((m) => m.role !== "system").slice(-12);

    // Prepend file context to input if files exist in session
    const inputWithFileCtx = hasFileContext
      ? `${sessionFileCtx}\n\nUser message: ${finalUserMessage || message}`
      : (finalUserMessage || message);

    const result = await handleAquaRequest({
      userId,
      projectId:      projectId   || null,
      input:          inputWithFileCtx,
      mode:           "chat",
      projectFiles,
      memory:         null,
      sessionHistory: safeSessionHistory,
    });

    // Fire-and-forget workspace memory update
    if (result.projectId) {
      setImmediate(() => {
        const svc = require("./workspace/workspace.service");
        svc.updateWorkspaceMemory(userId, {
          lastProjectId:   result.projectId,
          lastUserMessage: message.slice(0, 120),
        }).catch(() => {});
      });
    }

    const replyText = result.message || result.reply || "⚠️ No response generated.";
    const [savedChat, suggestions] = await Promise.all([
      saveChat([...messages, { role: "assistant", content: replyText }], chatId, userId, message),
      generateSuggestedPrompts(message, replyText).catch(() => []),
    ]);

    // Emit real-time file change event via socket.io
    if (result.updatedFiles?.length || result.files?.length) {
      try {
        const io = req.app.get("io");
        if (io) {
          io.emit("project:files-changed", {
            projectId:    result.projectId || projectId,
            updatedFiles: result.updatedFiles || [],
            files:        result.files || [],
          });
        }
      } catch { /* non-fatal */ }
    }

    return res.json({
      reply:          replyText,
      chatId:         savedChat?._id,
      suggestions,
      intent:         result.intent        || null,
      action:         result.action        || "replied",
      projectId:      result.projectId     || projectId || null,
      updatedFiles:   result.updatedFiles  || [],
      files:          result.files         || [],
      previewUrl:     result.previewUrl    || null,
      previewRefresh: !!(result.updatedFiles?.length || result.files?.length),
      errors:         result.errors        || [],
    });

  } catch (err) {
    console.error("CHAT ERROR:", err.message);
    res.status(500).json({ reply: `⚠️ Chat error: ${err.message}` });
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
    res.redirect("/home");
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

app.get("/aqua-ai",             (req, res) => res.render("aqua-ai"));
app.get("/aqua-project-engine", (req, res) => res.render("aqua-project-engine"));
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




// ─── FILE SESSION ENDPOINTS ───────────────────────────────────────────────────

// GET /files/list — returns files stored in session for current user
app.get("/files/list", (req, res) => {
  const files = fileSess.getFileList(req.session);
  res.json({ success: true, files });
});

// DELETE /files/clear — clears all session files
app.delete("/files/clear", (req, res) => {
  fileSess.clearSessionFiles(req.session);
  res.json({ success: true, message: "Session files cleared" });
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
      const u = await User.findById(req.session.userId).select("wallet email plan").lean();
      if (u) billingUser = u;
    }
    return res.render("billing", { billingUser, user: billingUser });
  } catch (err) {
    console.error("[billing page]", err.message);
    return res.render("billing", { billingUser: null, user: null });
  }
});

// ── Categories page ────────────────────────────────────────────────────────────
app.get("/categories", async (req, res) => {
  try {
    const allTools = await Tool.find({ status: { $in: ["approved", null, undefined] } }).lean();
    const catMap = {};
    allTools.forEach((t) => {
      const cat = t.category || "Uncategorized";
      if (!catMap[cat]) catMap[cat] = 0;
      catMap[cat]++;
    });
    const categories = Object.entries(catMap)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    res.render("categories", { categories });
  } catch (err) {
    console.error("[categories]", err.message);
    res.status(500).send("Error loading categories");
  }
});

// ── Lab page ───────────────────────────────────────────────────────────────────
app.get("/lab", (req, res) => res.render("lab"));

// ── Every page ─────────────────────────────────────────────────────────────────
app.get("/every", async (req, res) => {
  try {
    const tools = await Tool.find({ status: { $in: ["approved", null, undefined] } }).lean();
    res.render("every", { tools });
  } catch (err) {
    console.error("[every]", err.message);
    res.status(500).send("Error loading page");
  }
});

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

  const io = require("socket.io")(server, { cors: { origin: "*" } });
  app.set("io", io);

  io.on("connection", (socket) => {
    console.log("⚡ client connected");
    socket.on("bundle:run", (bundleId) => socket.broadcast.emit("bundle:update", { bundleId }));
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.log("⚠️ Port busy, retrying...");
      setTimeout(() => server.listen(0, "0.0.0.0"), 1000);
    }
  });

  server.listen(PORT, "0.0.0.0", () => console.log(`🚀 Aqua AI running on port ${PORT}`));
}

startServer();