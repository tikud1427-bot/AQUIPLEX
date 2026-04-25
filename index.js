/**
 * index.js — Aqua AI Server (UPGRADED)
 * 
 * ═══════════════════════════════════════════════════════════════════
 * UPGRADE CHANGELOG
 * ═══════════════════════════════════════════════════════════════════
 * 
 * [FIX-1]  CRITICAL: Fixed syntax error — extra closing brace in /chat
 *          route that orphaned history/delete routes and broke parsing.
 * 
 * [FIX-2]  CRITICAL: Fixed memory system — replaced aggressive delete
 *          logic with merge-based upserts. Moved to memory.service.js.
 * 
 * [FIX-3]  Added googleId field to User schema + User.js model note.
 * 
 * [FIX-4]  Fixed session/passport mismatch — requireLogin now checks
 *          both req.session.userId AND req.user from Passport.
 * 
 * [FIX-5]  Universal file processor via file.service.js — supports
 *          CSV, JSON, JSONL, code files, images + old PDF/DOCX/TXT.
 * 
 * [FIX-6]  Memory now injected in STREAM mode too.
 * 
 * [FIX-7]  generateAI() now accepts an optional vision flag for images.
 * 
 * [FIX-8]  generateChatTitle() no longer injects identity system prompts.
 * 
 * [FIX-9]  Bundle GET/:id now validates user ownership.
 * 
 * [FIX-10] extractMemory() is fire-and-forget with injected generateAI.
 *
 * ═══════════════════════════════════════════════════════════════════
 * HOW TO APPLY THIS FILE
 * ═══════════════════════════════════════════════════════════════════
 * 
 * This file IS your new index.js. Replace the old one entirely.
 * Also add these two new files to your project:
 *   - services/memory.service.js
 *   - services/file.service.js
 *   - models/Memory.js  (replace the original)
 * 
 * No other files need to change.
 */

require("dotenv").config();

const express    = require("express");
const mongoose   = require("mongoose");
const bcrypt     = require("bcrypt");
const session    = require("express-session");
const bodyParser = require("body-parser");
const multer     = require("multer");
const fs         = require("fs");
const path       = require("path");
const axios      = require("axios");
const passport   = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const executionRoutes = require("./execution-engine.routes");

// ── NEW: Service imports ─────────────────────────────────────────────────────
// [FIX-2] [FIX-5] Import upgraded service modules
const { extractMemory, getUserMemory } = require("./services/memory.service");
const { processFile }                  = require("./services/file.service");

// ================= AQUA AI IDENTITY LAYER =================

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

// ================= IDENTITY LEAK DETECTION =================

const IDENTITY_TRIGGERS = [
  "who are you", "which model", "are you chatgpt", "what ai are you",
  "are you gpt", "what model are you", "which ai", "are you openai",
  "are you gemini", "are you llama", "are you groq", "what are you",
  "who built you", "who made you", "are you claude", "are you anthropic",
  "are you mistral", "are you deepseek",
];

const AQUA_IDENTITY_RESPONSE =
  "I'm Aqua AI v3 — built by Aquiplex. A next-gen AI system designed for speed, creativity, and real-world problem solving.";

function isIdentityQuery(message) {
  if (!message) return false;
  const lower = message.toLowerCase();
  return IDENTITY_TRIGGERS.some((trigger) => lower.includes(trigger));
}

// ================= MULTI-AI MODELS LIST =================
const models = [
  {
    name: "Aqua Fast",
    system: "You are Aqua Fast — a concise, snappy AI. Give short, punchy answers.",
  },
  {
    name: "Aqua Deep",
    system: "You are Aqua Deep — a thorough, analytical AI. Give detailed, structured answers with examples.",
  },
  {
    name: "Aqua Creative",
    system: "You are Aqua Creative — an imaginative AI. Think outside the box, use metaphors and vivid language.",
  },
];

// ================= RETRY HELPER =================
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

// ================= AI ENGINE (FALLBACK SYSTEM) =================
// [FIX-7] Added optional `useVision` flag for image understanding.
//         When useVision=true and messages contain image content blocks,
//         the messages are passed as-is (already formatted for vision).
async function generateAI(messages, options = {}, useVision = false) {
  const { temperature = 0.7, maxTokens = 1024 } = options;

  // For vision requests, we pass raw messages without wrapping in identity prompts
  // (vision models handle system prompts differently and identity isn't needed for file parsing)
  const identityMessages = useVision
    ? messages
    : [
        { role: "system", content: AQUA_IDENTITY },
        { role: "system", content: AQUA_CONTEXT },
        ...messages,
      ];

  // 🥇 1. GROQ (fastest)
  try {
    const res = await withRetry(() =>
      axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          // [FIX-7] Use vision-capable model when processing images
          model: useVision ? "llava-v1.5-7b-4096-preview" : "llama-3.1-8b-instant",
          messages: identityMessages,
          temperature,
          max_tokens: maxTokens,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 10000,
        }
      )
    );

    const content = res.data?.choices?.[0]?.message?.content;
    if (content) return content;
    throw new Error("Empty response from Groq");
  } catch (err) {
    console.log("❌ Groq failed:", err.message);
  }

  // 🥈 2. OPENROUTER (many free models)
  try {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: useVision ? "openai/gpt-4o-mini" : "mistralai/mistral-7b-instruct",
        messages: identityMessages,
        temperature,
        max_tokens: maxTokens,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

    const content = res.data?.choices?.[0]?.message?.content;
    if (content) return content;
    throw new Error("Empty response from OpenRouter");
  } catch (err) {
    console.log("❌ OpenRouter failed:", err.message);
  }

  // 🥉 3. GEMINI (backup — text only, not vision in this fallback)
  if (!useVision) {
    try {
      const userContent = messages
        .filter((m) => m.role !== "system")
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n");

      const systemContent = [AQUA_IDENTITY, AQUA_CONTEXT].join("\n");

      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent?key=${process.env.Gemini_API_Key}`,
        {
          contents: [
            {
              parts: [{ text: `${systemContent}\n\nUser: ${userContent}` }],
            },
          ],
          generationConfig: { temperature, maxOutputTokens: maxTokens },
        },
        { timeout: 15000 }
      );

      const content = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (content) return content;
      throw new Error("Empty response from Gemini");
    } catch (err) {
      console.log("❌ Gemini failed:", err.message);
    }
  }

  return "⚠️ All AI services are busy right now. Please try again in a moment.";
}

// ================= CODE AI ENGINE =================
async function generateCodeAI(messages) {
  const CODE_SYSTEM_PROMPT = `You are Aqua Dev Engine, an expert software engineer.

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
    { role: "system", content: CODE_SYSTEM_PROMPT },
    ...messages,
  ];

  // 🥇 1. OpenRouter DeepSeek Coder
  try {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "deepseek/deepseek-coder",
        messages: fullMessages,
        temperature: 0.3,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    const content = res.data?.choices?.[0]?.message?.content;
    if (content) return content;
    throw new Error("Empty response from DeepSeek");
  } catch (err) {
    console.log("❌ DeepSeek Coder failed:", err.message);
  }

  // 🥈 2. Fallback: Groq
  try {
    const res = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.1-8b-instant",
        messages: fullMessages,
        temperature: 0.3,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

    const content = res.data?.choices?.[0]?.message?.content;
    if (content) return content;
    throw new Error("Empty response from Groq fallback");
  } catch (err) {
    console.log("❌ Groq code fallback failed:", err.message);
  }

  return "⚠️ Code engine is unavailable. Please try again in a moment.";
}

// ================= IMAGE GENERATION =================
async function generateImage(prompt) {
  // 🥇 1. TOGETHER AI (HIGH QUALITY)
  try {
    const res = await axios.post(
      "https://api.together.xyz/v1/images/generations",
      {
        prompt,
        model: "black-forest-labs/FLUX.1-schnell",
        width: 512,
        height: 512,
        steps: 4,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.TOGETHER_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 20000,
      }
    );

    const imageUrl = res.data?.data?.[0]?.url;
    if (imageUrl) {
      console.log("✅ Together AI success");
      return { url: imageUrl, provider: "Together AI" };
    }

    throw new Error("No image from Together");
  } catch (err) {
    console.log("⚠️ Together failed → switching to Pollinations:", err.message);
  }

  // 🥈 2. POLLINATIONS (UNLIMITED FALLBACK)
  try {
    const seed = Math.floor(Math.random() * 1000000);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?seed=${seed}&nologo=true`;
    console.log("✅ Pollinations fallback used");
    return { url, provider: "Pollinations" };
  } catch (err) {
    console.log("❌ Pollinations failed:", err.message);
    return {
      url: "https://via.placeholder.com/512?text=Image+Failed",
      provider: "fallback",
    };
  }
}

// ================= SUGGESTED PROMPTS ENGINE =================
async function generateSuggestedPrompts(lastMessage, lastReply) {
  try {
    const res = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.1-8b-instant",
        messages: [
          {
            role: "system",
            content: `Generate 3 short, engaging follow-up questions or prompts the user might want to ask next based on the conversation. 
Return ONLY a JSON array of strings. Each string max 8 words. No numbering. Example: ["Tell me more about X", "How does Y work?", "Give me an example"]`,
          },
          {
            role: "user",
            content: `User said: "${lastMessage.slice(0, 200)}"\nAI replied about: "${lastReply.slice(0, 300)}"`,
          },
        ],
        temperature: 0.8,
        max_tokens: 150,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 5000,
      }
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

// ================= CHAT TITLE GENERATOR =================
// [FIX-8] Removed identity system prompts from title generation.
//         Identity prompts waste tokens and pollute short title responses.
async function generateChatTitle(message) {
  let title = (message || "New Chat").slice(0, 30);

  try {
    const res = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.1-8b-instant",
        messages: [
          {
            role: "system",
            content: "Generate a 4-5 word title for this chat. Return ONLY the title, no quotes, no punctuation at the end.",
          },
          {
            role: "user",
            content: (message || "").slice(0, 200),
          },
        ],
        temperature: 0.5,
        max_tokens: 20,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 5000,
      }
    );

    const aiTitle = res.data?.choices?.[0]?.message?.content;
    if (aiTitle && aiTitle.length < 60 && !aiTitle.includes("⚠️")) {
      title = aiTitle.trim();
    }
  } catch {
    // silently fall back to truncated message
  }

  return title;
}

// ════════════════════════════════════════════════════════════════════
// EXPRESS APP SETUP
// ════════════════════════════════════════════════════════════════════

const app = express();
app.set("trust proxy", 1);

// ================= MODELS =================
const User      = require("./models/User");
const Tool      = require("./models/Tool");
const Workspace = require("./models/Workspace");
const History   = require("./models/History");
const Bundle    = require("./models/Bundle");

// ================= DATABASE =================
async function connectDB() {
  try {
    console.log("⏳ Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    console.log("✅ MongoDB connected");
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err.message);
    process.exit(1);
  }
}

// ================= TRENDING =================
async function getTrendingTools(limit = 10) {
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const tools = await Tool.find().lean();
  return tools
    .map((tool) => {
      const score = (tool.clickHistory || []).filter(
        (c) => new Date(c.date) > last24h
      ).length;
      return { ...tool, trendingScore: score };
    })
    .sort((a, b) => b.trendingScore - a.trendingScore)
    .slice(0, limit);
}

// ================= IMPORT JSON TOOLS =================
let jsonTools = [];
try {
  jsonTools = JSON.parse(fs.readFileSync("./data/tools.json", "utf8"));
} catch (err) {}

async function importTools() {
  if (jsonTools.length === 0) return;
  for (let tool of jsonTools) {
    await Tool.updateOne({ name: tool.name }, { $set: tool }, { upsert: true });
  }
  console.log("✅ Tools synced");
}

// ================= SAVE CHAT HELPER =================
async function saveChat(messages, chatId, userId, message) {
  if (!userId) return null;

  if (chatId) {
    try {
      if (!mongoose.Types.ObjectId.isValid(chatId)) return null;
      return await History.findOneAndUpdate(
        { _id: chatId, userId },
        { messages, updatedAt: new Date() },
        { new: true }
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

// ================= MIDDLEWARE =================
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.static("public"));

const rateLimit = require("express-rate-limit");

const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 40,
  skip: (req) => req.method === "GET",
  handler: (req, res) => {
    res.status(429).json({ reply: "⚠️ Too many requests. Please slow down a moment." });
  },
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(
  session({
    name: "aidex_session",
    secret: process.env.SESSION_SECRET || "super-secret-key",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 7,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err, null);
  }
});

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL || "/auth/google/callback",
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value;
        if (!email) return done(new Error("No email from Google"), null);

        let user = await User.findOne({ email });
        if (!user) {
          user = await new User({
            email,
            password: "google-oauth",
            googleId: profile.id,
          }).save();
        } else if (!user.googleId) {
          // Backfill googleId on existing accounts that OAuth'd for the first time
          user.googleId = profile.id;
          await user.save();
        }

        return done(null, user);
      } catch (err) {
        return done(err, null);
      }
    }
  )
);

// ✅ GLOBAL USER
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

// ================= AUTH MIDDLEWARE =================
// [FIX-4] requireLogin now checks BOTH session.userId (manual auth)
//         AND req.user (Passport OAuth). This prevents Passport-authenticated
//         users from being rejected because session.userId wasn't set.
function requireLogin(req, res, next) {
  const isLoggedIn = req.session.userId || (req.user && req.user._id);

  if (!isLoggedIn) {
    if (req.path.startsWith("/api/") || req.xhr) {
      return res.status(401).json({ error: "Login required" });
    }
    return res.redirect("/login");
  }

  // Normalize: ensure req.session.userId is always set after Passport login
  if (!req.session.userId && req.user) {
    req.session.userId = req.user._id;
  }

  next();
}

function redirectIfLoggedIn(req, res, next) {
  if (req.session.userId) return res.redirect("/home");
  next();
}

executionRoutes(app, requireLogin, generateAI);

// ================= UPLOAD =================
const uploadDir = path.join(__dirname, "public/uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});

// [FIX-5] Expanded allowed file types to match file.service.js capabilities
const ALLOWED_EXTENSIONS = new Set([
  // Documents
  ".pdf", ".docx", ".txt",
  // Data
  ".csv", ".tsv", ".json", ".jsonl",
  // Images
  ".png", ".jpg", ".jpeg", ".gif", ".webp",
  // Code
  ".js", ".ts", ".py", ".java", ".cpp", ".c", ".cs", ".go",
  ".rs", ".rb", ".php", ".swift", ".sh", ".sql", ".html",
  ".css", ".xml", ".yaml", ".yml", ".md", ".jsx", ".tsx", ".vue",
]);

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} is not supported`), false);
    }
  },
});

// ════════════════════════════════════════════════════════════════════
// ROUTES (unchanged from original — only patched where noted)
// ════════════════════════════════════════════════════════════════════

app.get("/health", (req, res) => {
  res.status(200).json({ status: "OK", timestamp: new Date().toISOString() });
});

app.get("/", (req, res) => {
  if (req.session.userId) return res.redirect("/home");
  return res.redirect("/landing");
});

app.post("/api/tools/:id/like", async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: "Login required" });
  if (!mongoose.Types.ObjectId.isValid(req.params.id))
    return res.status(400).json({ error: "Invalid tool ID" });

  const tool = await Tool.findById(req.params.id);
  if (!tool) return res.status(404).json({ error: "Tool not found" });

  if (!tool.likedBy) tool.likedBy = [];

  const userIdStr = req.session.userId.toString();
  if (tool.likedBy.map((id) => id.toString()).includes(userIdStr)) {
    tool.likes = Math.max(0, (tool.likes || 0) - 1);
    tool.likedBy = tool.likedBy.filter((id) => id.toString() !== userIdStr);
    await tool.save();
    return res.json({ likes: tool.likes, liked: false });
  }

  tool.likes = (tool.likes || 0) + 1;
  tool.likedBy.push(req.session.userId);
  await tool.save();
  res.json({ likes: tool.likes, liked: true });
});

app.get("/landing", async (req, res) => {
  if (req.session.userId) return res.redirect("/home");
  res.render("landing");
});

app.get("/home", async (req, res) => {
  try {
    const tools = await Tool.find().limit(12).lean();
    const allTools = await Tool.find().lean();
    const trendingTools = await getTrendingTools(10);
    const trendingIds = trendingTools.map((t) => t._id.toString());
    res.render("home", { tools: tools || [], trendingIds: trendingIds || [], allTools: allTools || [] });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading home");
  }
});

app.get("/tools", async (req, res) => {
  try {
    const searchQuery = req.query.q;
    let tools = await Tool.find().lean();

    if (searchQuery) {
      let aiData;
      try {
        const ai = await axios.post(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            model: "llama-3.1-8b-instant",
            messages: [
              {
                role: "system",
                content: `You are an AI search engine brain. Convert user query into JSON: {"intent": "","keywords": [],"categories": []}. Return ONLY valid JSON, no markdown.`,
              },
              { role: "user", content: searchQuery },
            ],
            temperature: 0.3,
          },
          {
            headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
            timeout: 8000,
          }
        );

        let text = ai.data.choices[0].message.content;
        text = text.replace(/```json/g, "").replace(/```/g, "").trim();
        const match = text.match(/\{[\s\S]*\}/);
        if (match) aiData = JSON.parse(match[0]);
        else throw new Error("No JSON found");
      } catch {
        aiData = { intent: searchQuery, keywords: [searchQuery], categories: [] };
      }

      tools = tools
        .map((tool) => {
          let score = 0;
          const name = tool.name.toLowerCase();
          const desc = (tool.description || "").toLowerCase();
          const cat = (tool.category || "").toLowerCase();
          const keywords = [...(aiData.keywords || []), aiData.intent]
            .map((k) => (k || "").toLowerCase()).filter(Boolean);
          keywords.forEach((k) => {
            if (name.includes(k)) score += 5;
            if (desc.includes(k)) score += 3;
            if (cat.includes(k)) score += 4;
          });
          (aiData.categories || []).forEach((c) => {
            if (cat.includes(c.toLowerCase())) score += 6;
          });
          score += (tool.clickHistory || []).length * 0.5;
          return { ...tool, score };
        })
        .filter((t) => t.score > 0)
        .sort((a, b) => b.score - a.score);
    }

    const allTools = await Tool.find().lean();
    const categories = [...new Set(allTools.map((t) => t.category))];
    const recommended = tools.slice(0, 3);
    res.render("tools", { tools, categories, searchQuery: searchQuery || "", recommended });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading tools");
  }
});

app.get("/tools/category/:category", async (req, res) => {
  try {
    const rawCategory = req.params.category;
    const category = rawCategory.replace(/-/g, " ");
    const searchQuery = req.query.q;
    let tools;

    if (searchQuery) {
      tools = await Tool.find({ category: { $regex: new RegExp(`^${category}$`, "i") } }).lean();
      tools = tools
        .map((tool) => {
          let score = 0;
          const text = ((tool.name || "") + " " + (tool.description || "")).toLowerCase();
          if (text.includes(searchQuery.toLowerCase())) score += 5;
          return { ...tool, score };
        })
        .filter((t) => t.score > 0)
        .sort((a, b) => b.score - a.score);
    } else {
      tools = await Tool.find({ category: { $regex: new RegExp(`^${category}$`, "i") } }).lean();
    }

    const allTools = await Tool.find().lean();
    const categories = [...new Set(allTools.map((t) => t.category))];
    res.render("tools", { tools, categories, selectedCategory: category, searchQuery: searchQuery || "", recommended: tools.slice(0, 3) });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading category");
  }
});

app.get("/categories", async (req, res) => {
  try {
    const tools = await Tool.find().lean();
    const categories = [...new Set(tools.map((t) => t.category))];
    res.render("categories", { categories });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading categories");
  }
});

app.get("/visit/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return res.status(400).send("Invalid tool ID");

    const tool = await Tool.findById(req.params.id);
    if (!tool) return res.status(404).send("Tool not found");

    tool.clicks = (tool.clicks || 0) + 1;
    if (!tool.clickHistory) tool.clickHistory = [];
    tool.clickHistory.push({ date: new Date() });

    if (tool.clickHistory.length > 1000) tool.clickHistory = tool.clickHistory.slice(-1000);
    await tool.save();
    res.redirect(tool.url);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error visiting tool");
  }
});

app.get("/tool/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return res.status(400).send("Invalid tool ID");

    const tool = await Tool.findById(req.params.id).lean();
    if (!tool) return res.status(404).send("Tool not found");

    let aiInsights = null;
    try {
      const ai = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: "llama-3.1-8b-instant",
          messages: [
            { role: "system", content: `You are an AI product expert. Analyze the tool and return JSON: {"why": "","bestFor": [],"pros": [],"cons": []}. Keep it short and practical. Return ONLY valid JSON.` },
            { role: "user", content: `Name: ${tool.name}\nCategory: ${tool.category}\nDescription: ${tool.description}` },
          ],
          temperature: 0.5,
        },
        { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" }, timeout: 8000 }
      );
      let text = ai.data.choices[0].message.content;
      text = text.replace(/```json/g, "").replace(/```/g, "").trim();
      const match = text.match(/\{[\s\S]*\}/);
      if (match) aiInsights = JSON.parse(match[0]);
    } catch {
      console.log("AI failed for tool insights");
    }

    res.render("tool-details", { tool, aiInsights });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading tool");
  }
});

app.get("/bundles", (req, res) => res.render("bundles"));

app.post("/generate-bundle", async (req, res) => {
  const { goal, step, answers } = req.body;

  if (!goal || !goal.trim()) {
    return res.status(400).json({ error: "Goal is required" });
  }

  // ── Step 1: collect context via questions ────────────────────
  if (!step || step === 1) {
    return res.json({
      type: "questions",
      step: 2,
      questions: [
        "What type of project is this? (e.g. SaaS, content, freelancing, startup)",
        "Who is the target audience or end-user?",
        "What is the single most important outcome you want?",
        "Do you prefer a lean/fast approach or a thorough/detailed one?",
        "Any tech, tools, or constraints we should know about?",
      ],
    });
  }

  // ── Step 2: generate plan ────────────────────────────────────
  try {
    const prompt = `
You are an expert project architect. Generate a precise, actionable project plan.

USER GOAL: ${goal}
USER ANSWERS:
${(answers || []).map((a, i) => `  ${i + 1}. ${a}`).join("\n")}

Rules:
- Return ONLY valid JSON. No prose, no markdown fences.
- 5 to 8 steps. Each step must be concrete and self-contained.
- Each step description must be 1-2 sentences explaining WHAT to produce (not vague advice).
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
}
`.trim();

    const raw = await generateAI(
      [
        { role: "system", content: "You are an expert project architect. Return ONLY valid JSON." },
        { role: "user",   content: prompt },
      ],
      { temperature: 0.5, maxTokens: 1400 }
    );

    const clean = raw.replace(/```json/g, "").replace(/```/g, "").trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON in response");

    const parsed = JSON.parse(match[0]);

    // Normalise step index to 0-based integer for the execution engine
    parsed.steps = parsed.steps.map((s, i) => ({
      ...s,
      step:      i,      // 0-based for engine; UI adds 1 when displaying
      resources: s.resources || [],
    }));

    // Attach goal + answers so /bundle/save can store them
    parsed.goal    = goal;
    parsed.answers = answers || [];

    res.json(parsed);
  } catch (err) {
    console.error("❌ /generate-bundle error:", err);
    res.status(500).json({ error: "AI failed to generate bundle", raw: err.message });
  }
});


app.get("/api/tools/suggest", async (req, res) => {
  try {
    const q = req.query.q || "";
    let tools = await Tool.find().lean();

    if (q) {
      tools = tools
        .map((tool) => {
          const text = ((tool.name || "") + " " + (tool.description || "") + " " + (tool.category || "")).toLowerCase();
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
    if (!name || !category || !url || !description)
      return res.status(400).send("All fields are required");

    try { new URL(url); } catch { return res.status(400).send("Invalid URL format"); }

    let logoPath = "/logos/default.png";
    if (req.file) logoPath = "/uploads/" + req.file.filename;

    await new Tool({ name: name.trim(), category: category.trim(), url: url.trim(), description: description.trim(), logo: logoPath, clicks: 0, clickHistory: [] }).save();
    res.redirect("/tools");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error submitting tool");
  }
});

app.get("/about", (req, res) => res.render("about"));

// ================= MULTI-GENERATE =================
app.post("/multi-generate", async (req, res) => {
  const { prompt, messages, aiType } = req.body;

  if (!prompt && (!messages || messages.length === 0)) {
    return res.json({ responses: [{ model: "Error", output: "⚠️ No input received" }], recommended: "Error" });
  }

  try {
    const selectedModels = aiType
      ? models.filter((m) => m.name.toLowerCase().includes(aiType.toLowerCase()))
      : models;
    const activeModels = selectedModels.length > 0 ? selectedModels : models;

    const topTools = await Tool.find().limit(5).lean();
    const toolList = topTools.map((t) => t.name).join(", ");

    const responses = await Promise.all(
      activeModels.map(async (ai) => {
        try {
          const finalMessages = messages?.length ? messages : [{ role: "user", content: prompt || "Hello" }];
          const result = await axios.post(
            "https://api.groq.com/openai/v1/chat/completions",
            {
              model: "llama-3.1-8b-instant",
              messages: [
                { role: "system", content: AQUA_IDENTITY },
                { role: "system", content: AQUA_CONTEXT },
                { role: "system", content: `Suggest tools when needed: ${toolList}` },
                { role: "system", content: ai.system },
                ...finalMessages,
              ],
              temperature: 0.7,
            },
            { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" }, timeout: 10000 }
          );
          return { model: ai.name, output: result?.data?.choices?.[0]?.message?.content || "⚠️ Empty response" };
        } catch {
          return { model: ai.name, output: "⚠️ Error generating response" };
        }
      })
    );

    const best = responses.find((r) => !r.output.includes("⚠️")) || responses[0];
    res.json({ responses, recommended: best.model });
  } catch (err) {
    console.error("❌ GLOBAL ERROR:", err);
    res.status(500).json({ error: "AI generation failed" });
  }
});

// ================= HISTORY =================
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

app.post("/bundle/save", requireLogin, async (req, res) => {
  try {
    const { title, steps, goal, answers } = req.body;
    if (!title || !steps || !Array.isArray(steps)) {
      return res.status(400).json({ error: "Invalid bundle" });
    }

    const saved = await new Bundle({
      userId:  req.session.userId,
      title,
      goal:    goal    || title,
      answers: answers || [],
      steps,
      progress: steps.map((s, i) => ({ step: i, status: "pending" })),
      status:  "draft",
    }).save();

    res.json({ success: true, id: saved._id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save bundle" });
  }
});

// [FIX-9] Added ownership check — only the bundle's owner can view it
app.get("/bundle/:id", requireLogin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return res.status(400).send("Invalid bundle ID");

    const bundle = await Bundle.findOne({
      _id: req.params.id,
      userId: req.session.userId, // ← ownership enforced
    }).lean();

    if (!bundle) return res.status(404).send("Bundle not found");
    res.render("bundle-view", { bundle });
  } catch {
    res.status(500).send("Error loading bundle");
  }
});

// ================= CHATBOT PAGE =================
app.get("/chatbot", requireLogin, (req, res) => res.render("chatbot"));

// ================= SUGGESTED PROMPTS API =================
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

// ════════════════════════════════════════════════════════════════════
// CHAT ROUTE — primary AI endpoint
// [FIX-1] Fixed syntax structure (extra brace caused route orphaning)
// [FIX-2] Memory now uses memory.service.js (merge-based, no destructive deletes)
// [FIX-5] File processing now uses file.service.js (universal processor)
// [FIX-6] Memory injected in STREAM mode too
// ════════════════════════════════════════════════════════════════════

app.post("/chat", chatLimiter, upload.single("file"), async (req, res) => {
  let { message, history, mode, chatId, stream } = req.body;

  stream = stream === "true" || stream === true;

  let parsedHistory = [];
  try {
    if (Array.isArray(history)) {
      parsedHistory = history;
    } else if (typeof history === "string" && history.trim()) {
      parsedHistory = JSON.parse(history);
    }
    if (!Array.isArray(parsedHistory)) parsedHistory = [];
  } catch {
    parsedHistory = [];
  }

  parsedHistory = parsedHistory
    .filter((m) => m && m.role && m.content)
    .slice(-20);

  if (!message && !req.file) {
    return res.json({ reply: "⚠️ Message or file required" });
  }

  message = (message || "").trim();

  // ── HARD IDENTITY OVERRIDE ───────────────────────────────────────
  if (message && isIdentityQuery(message)) {
    return res.json({
      reply: AQUA_IDENTITY_RESPONSE,
      suggestions: ["What can you do?", "Show me image generation", "Help me write code"],
    });
  }

  try {
    let messages = [...parsedHistory];

    // ── FILE PROCESSING ──────────────────────────────────────────────
    // [FIX-5] Replaced inline file handling with universal file.service.js
    if (req.file) {
      const fileResult = await processFile(req.file, generateAI);
      // temp file is deleted inside processFile — no need to handle here

      if (fileResult.type === "image") {
        // For images, inject as a rich context message
        messages.push({
          role: "system",
          content: `User uploaded an image: "${fileResult.displayName}"\n${fileResult.content}`,
        });
      } else {
        // For all other file types, inject as a system context message
        messages.push({
          role: "system",
          content: `User uploaded file "${fileResult.displayName}" [${fileResult.type}]:\n\n${fileResult.content}`,
        });
      }
    }

    // ── REFINER ──────────────────────────────────────────────────────
    let refinedMessage = message;

    if (req.body.refiner === "true" && message) {
      try {
        refinedMessage = await generateAI([
          {
            role: "system",
            content: "Rewrite user input into a clear, detailed AI prompt. Return ONLY the improved prompt, nothing else. Max 200 words.",
          },
          { role: "user", content: message },
        ]);
        if (!refinedMessage || refinedMessage.includes("⚠️")) refinedMessage = message;
      } catch {
        refinedMessage = message;
      }
    }

    const finalUserMessage = req.body.refiner === "true" ? refinedMessage : message;

    if (finalUserMessage) {
      messages.push({ role: "user", content: finalUserMessage });
    }

    // ── MEMORY EXTRACTION (fire-and-forget, non-blocking) ────────────
    // [FIX-2] Now uses memory.service.js — smart merge, no destructive deletes
    // [FIX-10] generateAI injected to avoid circular dependency
    if (req.session.userId && finalUserMessage) {
      extractMemory(req.session.userId, finalUserMessage, generateAI)
        .catch(() => {}); // silent fail — never crash the response
    }

    // ── IMAGE GENERATION MODE ────────────────────────────────────────
    if (mode === "image") {
      if (!message) return res.json({ reply: "⚠️ Please describe the image you want to generate." });
      const result = await generateImage(message);
      return res.json({ reply: `🖼️ Here's your generated image:`, image: result.url, provider: result.provider });
    }

    // ── SEARCH MODE ──────────────────────────────────────────────────
    if (mode === "search") {
      try {
        const search = await axios.post(
          "https://google.serper.dev/search",
          { q: message, num: 5 },
          { headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" }, timeout: 8000 }
        );

        const results = search.data?.organic || [];
        const resultsText = results
          .slice(0, 5)
          .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\nSource: ${r.link}`)
          .join("\n\n");

        const reply = await generateAI([
          { role: "system", content: "Summarize search results clearly and concisely. Mention sources when relevant. Use markdown formatting." },
          { role: "user", content: `Question: ${message}\n\nSearch results:\n${resultsText}` },
        ]);

        const savedChat = await saveChat(
          [...messages, { role: "assistant", content: reply }],
          chatId,
          req.session.userId,
          message
        );

        return res.json({
          reply,
          chatId: savedChat?._id,
          sources: results.slice(0, 3).map((r) => ({ title: r.title, link: r.link })),
        });
      } catch {
        return res.json({
          reply: `🔎 Here's a Google search for your query: [Search Results](https://www.google.com/search?q=${encodeURIComponent(message)})`,
        });
      }
    }

    // ── CODE MODE ────────────────────────────────────────────────────
    if (mode === "code") {
      try {
        const reply = await generateCodeAI(messages.filter((m) => m.role !== "system"));

        const savedChat = await saveChat(
          [...messages, { role: "assistant", content: reply }],
          chatId,
          req.session.userId,
          message
        );

        return res.json({ reply, chatId: savedChat?._id });
      } catch (err) {
        console.error("CODE MODE ERROR:", err.message);
        return res.json({ reply: "⚠️ Code engine encountered an error. Please try again." });
      }
    }

    // ── STREAM MODE ──────────────────────────────────────────────────
    // [FIX-6] Memory is now fetched and injected in stream mode too
    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      if (typeof res.flushHeaders === "function") res.flushHeaders();

      if (req.body.refiner === "true" && refinedMessage !== message) {
        res.write(`data: ${JSON.stringify({ refined: refinedMessage })}\n\n`);
      }

      // [FIX-6] Fetch memory for stream mode (parallel with stream setup)
      const userMemory = await getUserMemory(req.session.userId, finalUserMessage);

      let fullReply = "";
      let axiosStream;
      let streamEnded = false;

      const endStream = async () => {
        if (streamEnded) return;
        streamEnded = true;
        try {
          await saveChat(
            [...messages, { role: "assistant", content: fullReply }],
            chatId,
            req.session.userId,
            message
          );
        } catch (e) {
          console.log("⚠️ saveChat in stream failed:", e.message);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      };

      try {
        // Build stream system messages including memory
        const streamSystemMessages = [
          { role: "system", content: AQUA_IDENTITY },
          { role: "system", content: AQUA_CONTEXT },
          {
            role: "system",
            content: userMemory
              ? `User Memory:\n${userMemory}\n\nUse this to personalize your response.`
              : "",
          },
          {
            role: "system",
            content: "Use markdown formatting with headings, bullet points, and code blocks where appropriate.",
          },
        ].filter((m) => m.content); // Remove empty memory message if no memory

        axiosStream = await axios({
          method: "post",
          url: "https://api.groq.com/openai/v1/chat/completions",
          data: {
            model: "llama-3.1-8b-instant",
            messages: [
              ...streamSystemMessages,
              ...messages.slice(-12),
            ],
            stream: true,
            temperature: 0.7,
          },
          responseType: "stream",
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 30000,
        });

        let lineBuffer = "";

        axiosStream.data.on("data", (chunk) => {
          if (streamEnded) return;
          lineBuffer += chunk.toString();
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload) continue;
            if (payload === "[DONE]") { endStream(); return; }

            try {
              const parsed = JSON.parse(payload);
              const token = parsed.choices?.[0]?.delta?.content;
              if (token) {
                fullReply += token;
                res.write(`data: ${JSON.stringify(token)}\n\n`);
              }
            } catch {
              // Skip malformed JSON lines
            }
          }
        });

        axiosStream.data.on("end", () => {
          if (!streamEnded) endStream();
        });

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
              } catch {
                res.write(`data: ${JSON.stringify("⚠️ Connection issue. Please try again.")}\n\n`);
              }
              endStream();
            }
          }
        });

        req.on("close", () => {
          streamEnded = true;
          if (axiosStream?.data) {
            try { axiosStream.data.destroy(); } catch {}
          }
        });

        return; // ← stream takes over from here
      } catch (err) {
        console.log("❌ Stream init failed → fallback:", err.message);
        const reply = await generateAI(messages.slice(-12));
        fullReply = reply;
        await saveChat([...messages, { role: "assistant", content: reply }], chatId, req.session.userId, message);
        res.write(`data: ${JSON.stringify(reply)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
    } // ← end of stream block

    // ── NORMAL (NON-STREAM) MODE ─────────────────────────────────────
    // [FIX-2] Memory from memory.service.js — ranked by importance + recency
    const userMemory = await getUserMemory(req.session.userId, finalUserMessage);

    const reply = await generateAI([
      {
        role: "system",
        content: userMemory
          ? `User Memory:\n${userMemory}\n\nUse this memory to personalize your responses.`
          : "",
      },
      {
        role: "system",
        content: "Use headings, bullet points, and clear markdown structure in your responses. Be thorough but concise.",
      },
      ...messages.slice(-12),
    ].filter((m) => m.content));

    const [savedChat, suggestions] = await Promise.all([
      saveChat([...messages, { role: "assistant", content: reply }], chatId, req.session.userId, message),
      generateSuggestedPrompts(message, reply).catch(() => []),
    ]);

    res.json({ reply, chatId: savedChat?._id, suggestions });

  } catch (err) {
    console.error("CHAT ERROR:", err.message);
    res.status(500).json({ reply: "⚠️ Something went wrong. Please try again." });
  }
}); // ← [FIX-1] Correct closing of /chat route handler

// ── SINGLE CHAT ──────────────────────────────────────────────────────────────
app.get("/history/:id", requireLogin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return res.status(400).json({ error: "Invalid chat ID" });

    const chat = await History.findOne({ _id: req.params.id, userId: req.session.userId });
    if (!chat) return res.status(404).json({ error: "Chat not found" });
    res.json(chat);
  } catch {
    res.status(500).json({ error: "Error loading chat" });
  }
});

// ── DELETE CHAT ───────────────────────────────────────────────────────────────
app.delete("/history/:id", requireLogin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return res.status(400).json({ error: "Invalid chat ID" });

    const result = await History.deleteOne({ _id: req.params.id, userId: req.session.userId });
    if (result.deletedCount === 0) return res.status(404).json({ error: "Chat not found" });
    res.sendStatus(200);
  } catch {
    res.status(500).json({ error: "Error deleting chat" });
  }
});

// ================= AUTH =================
app.get("/login",  (req, res) => { if (req.session.userId) return res.redirect("/home"); res.render("login"); });
app.get("/signup", (req, res) => { if (req.session.userId) return res.redirect("/home"); res.render("signup"); });

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).send("All fields are required");

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(401).send("User not found");

    const isMatch = user.password !== "google-oauth"
      ? await bcrypt.compare(password, user.password)
      : false;
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
  }
);

app.post("/signup", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).send("All fields are required");

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return res.status(400).send("Invalid email format");
    if (password.length < 6) return res.status(400).send("Password must be at least 6 characters");

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

// ================= WORKSPACE =================
app.get("/workspace", requireLogin, async (req, res) => {
  let workspace = await Workspace.findOne({ userId: req.session.userId }).populate("tools").lean();
  if (!workspace) {
    workspace = await new Workspace({ userId: req.session.userId, tools: [] }).save();
  }
  const bundles = await Bundle.find({ userId: req.session.userId }).sort({ createdAt: -1 }).lean();
  res.render("workspace", { workspace, bundles });
});

app.post("/bundle/remove/:id", requireLogin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return res.status(400).json({ error: "Invalid bundle ID" });
    await Bundle.deleteOne({ _id: req.params.id, userId: req.session.userId });
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error removing bundle");
  }
});

app.post("/workspace/add/:toolId", requireLogin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.toolId))
      return res.status(400).json({ error: "Invalid tool ID" });

    let workspace = await Workspace.findOne({ userId: req.session.userId });
    if (!workspace) workspace = new Workspace({ userId: req.session.userId, tools: [] });

    const toolIdStr = req.params.toolId;
    if (!workspace.tools.map((t) => t.toString()).includes(toolIdStr)) {
      workspace.tools.push(req.params.toolId);
      await workspace.save();
    }
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error adding tool" });
  }
});

app.post("/workspace/remove/:toolId", requireLogin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.toolId))
      return res.status(400).json({ error: "Invalid tool ID" });
    const toolId = new mongoose.Types.ObjectId(req.params.toolId);
    await Workspace.updateOne({ userId: req.session.userId }, { $pull: { tools: toolId } });
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error removing tool");
  }
});

// ================= STATIC PAGES =================
app.get("/aqua-ai", (req, res) => res.render("aqua-ai"));
app.get("/aqua-project-engine", (req, res) => res.render("aqua-project-engine"));
app.get("/founders", (req, res) => res.render("founders"));

app.get("/download", (req, res) => {
  const filePath = path.join(__dirname, "public/uploads/Aquiplex.apk");
  if (!fs.existsSync(filePath)) return res.status(404).send("Download not available yet");
  res.download(filePath, "Aquiplex.apk", (err) => {
    if (err && !res.headersSent) res.status(500).send("Download failed");
  });
});

// ================= 404 HANDLER =================
app.use((req, res) => res.status(404).send("Page not found"));

// ================= GLOBAL ERROR HANDLER =================
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (err.code === "LIMIT_FILE_SIZE")
    return res.status(400).json({ reply: "⚠️ File too large. Maximum size is 10MB." });
  if (err.message?.includes("not supported"))
    return res.status(400).json({ reply: `⚠️ ${err.message}` });
  res.status(500).json({ reply: "⚠️ Something went wrong. Please try again." });
});

// ================= START =================
async function startServer() {
  console.log("GROQ:",       process.env.GROQ_API_KEY       ? "✅ OK" : "❌ MISSING");
  console.log("MONGO:",      process.env.MONGO_URI           ? "✅ OK" : "❌ MISSING");
  console.log("SESSION:",    process.env.SESSION_SECRET      ? "✅ OK" : "❌ MISSING");
  console.log("OPENROUTER:", process.env.OPENROUTER_API_KEY  ? "✅ OK" : "❌ MISSING");
  console.log("GEMINI:",     process.env.Gemini_API_Key      ? "✅ OK" : "❌ MISSING");
  console.log("TOGETHER:",   process.env.TOGETHER_API_KEY    ? "✅ OK" : "❌ MISSING");
  console.log("SERPER:",     process.env.SERPER_API_KEY      ? "✅ OK" : "❌ MISSING");

  await connectDB();
  await importTools();

  const PORT = process.env.PORT || 5000;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Aqua AI running on port ${PORT}`);
  });
}

startServer();
