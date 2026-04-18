require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const session = require("express-session");
const bodyParser = require("body-parser");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");

// ================= MULTI-AI MODELS LIST =================
// FIX: was referenced in /multi-generate but never defined
const models = [
  {
    name: "Aqua Fast",
    system: "You are Aqua Fast — a concise, snappy AI. Give short, punchy answers."
  },
  {
    name: "Aqua Deep",
    system: "You are Aqua Deep — a thorough, analytical AI. Give detailed, structured answers with examples."
  },
  {
    name: "Aqua Creative",
    system: "You are Aqua Creative — an imaginative AI. Think outside the box, use metaphors and vivid language."
  }
];

// ================= AI ENGINE (FALLBACK SYSTEM) =================

async function generateAI(messages) {

  // 🥇 1. GROQ (fastest)
  try {
    const res = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.1-8b-instant",
        messages
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 10000
      }
    );

    return res.data.choices[0].message.content;

  } catch (err) {
    console.log("❌ Groq failed:", err.message);
  }

  // 🥈 2. OPENROUTER (many free models)
  try {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "mistralai/mistral-7b-instruct",
        messages
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 15000
      }
    );

    return res.data.choices[0].message.content;

  } catch (err) {
    console.log("❌ OpenRouter failed:", err.message);
  }

  // 🥉 3. GEMINI (backup)
  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent?key=${process.env.Gemini_API_Key}`,
      {
        contents: [
          {
            parts: [{ text: messages.map(m => m.content).join("\n") }]
          }
        ]
      },
      { timeout: 15000 }
    );

    return res.data.candidates[0].content.parts[0].text;

  } catch (err) {
    console.log("❌ Gemini failed:", err.message);
  }

  return "⚠️ All AI services are busy. Please try again in a moment.";
}

async function generateImage(prompt) {

  // 🥇 1. TOGETHER AI (HIGH QUALITY)
  try {
    const res = await axios.post(
      "https://api.together.xyz/v1/images/generations",
      {
        prompt,
        model: "black-forest-labs/FLUX.1-schnell",
        width: 512,
        height: 512
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.TOGETHER_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 20000
      }
    );

    const imageUrl = res.data?.data?.[0]?.url;

    if (imageUrl) {
      console.log("✅ Together AI success");
      return { url: imageUrl };
    }

    throw new Error("No image from Together");

  } catch (err) {
    console.log("⚠️ Together failed → switching to Pollinations:", err.message);
  }

  // 🥈 2. POLLINATIONS (UNLIMITED FALLBACK)
  try {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`;
    console.log("✅ Pollinations fallback used");
    return { url };
  } catch (err) {
    console.log("❌ Pollinations failed:", err.message);
    return {
      url: "https://via.placeholder.com/512?text=Image+Failed"
    };
  }
}

const app = express();

// ✅ TRUST PROXY (IMPORTANT for Render/Replit)
app.set("trust proxy", 1);

app.use((req, res, next) => {
  // HTTPS redirect disabled for Replit compatibility
  next();
});

// ================= MODELS =================
const User = require("./models/User");
const Tool = require("./models/Tool");
const Workspace = require("./models/Workspace");
const History = require("./models/History");

// ================= DATABASE =================
async function connectDB() {
  try {
    console.log("⏳ Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI);
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
    .map(tool => {
      const score = (tool.clickHistory || []).filter(
        c => new Date(c.date) > last24h
      ).length;
      return { ...tool, trendingScore: score };
    })
    .sort((a, b) => b.trendingScore - a.trendingScore)
    .slice(0, limit);
}

// ================= IMPORT JSON =================
let jsonTools = [];
try {
  jsonTools = JSON.parse(fs.readFileSync("./data/tools.json", "utf8"));
} catch (err) {}

async function importTools() {
  if (jsonTools.length === 0) return;

  for (let tool of jsonTools) {
    await Tool.updateOne(
      { name: tool.name },
      { $set: tool },
      { upsert: true }
    );
  }

  console.log("✅ Tools synced");
}

// ================= SAVE CHAT HELPER =================
async function saveChat(messages, chatId, userId, message) {
  if (!userId) return null; // guard: not logged in

  if (chatId) {
    try {
      return await History.findOneAndUpdate(
        { _id: chatId, userId },
        { messages },
        { new: true }
      );
    } catch (err) {
      console.log("⚠️ saveChat update failed:", err.message);
      return null;
    }
  } else {
    // Generate a short AI title (5–6 words max)
    let title = (message || "New Chat").slice(0, 30);

    try {
      const aiTitle = await generateAI([
        {
          role: "system",
          content: "Generate a 5-6 word title for this chat message. Return ONLY the title, no quotes, no punctuation at the end."
        },
        {
          role: "user",
          content: (message || "").slice(0, 200)
        }
      ]);

      if (aiTitle && aiTitle.length < 80) {
        title = aiTitle.trim();
      }
    } catch {
      // silently fall back to slice(0,30)
    }

    try {
      return await History.create({
        userId,
        title,
        messages
      });
    } catch (err) {
      console.log("⚠️ saveChat create failed:", err.message);
      return null;
    }
  }
}

// ================= MIDDLEWARE =================
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const rateLimit = require("express-rate-limit");

// FIX: Raised limit and only apply to POST /chat to avoid blocking normal usage
const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 40, // raised from 20 to 40 — streaming counts as one request
  message: "⚠️ Too many requests. Please slow down.",
  skip: (req) => req.method === "GET" // never rate-limit GETs
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// ✅ SESSION
app.use(
  session({
    name: "aidex_session",
    secret: process.env.SESSION_SECRET || "super-secret-key",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24, // 1 day
      httpOnly: true,
      secure: false,
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

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: "/auth/google/callback"
},
async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails[0].value;
    let user = await User.findOne({ email });

    if (!user) {
      user = await new User({
        email,
        password: "google-oauth"
      }).save();
    }

    return done(null, user);
  } catch (err) {
    return done(err, null);
  }
}));

// ✅ GLOBAL USER
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// ================= UPLOAD =================
const uploadDir = path.join(__dirname, "public/uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) =>
    cb(null, Date.now() + "-" + file.originalname),
});

const upload = multer({ storage });

// ================= AUTH MIDDLEWARE =================
function requireLogin(req, res, next) {
  if (!req.session.userId) return res.redirect("/login");
  next();
}

function redirectIfLoggedIn(req, res, next) {
  if (req.session.userId) {
    return res.redirect("/home");
  }
  next();
}

// ================= ROUTES =================

app.get("/", (req, res) => {
  if (req.session.userId) {
    return res.redirect("/home");
  }
  return res.redirect("/landing");
});

app.post("/api/tools/:id/like", async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Login required" });
  }

  const tool = await Tool.findById(req.params.id);

  if (!tool) {
    return res.json({ error: "Tool not found" });
  }

  if (!tool.likedBy) tool.likedBy = [];

  if (tool.likedBy.includes(req.session.userId)) {
    return res.json({ message: "Already liked", likes: tool.likes });
  }

  tool.likes = (tool.likes || 0) + 1;
  tool.likedBy.push(req.session.userId);

  await tool.save();

  res.json({ likes: tool.likes });
});

app.get("/landing", async (req, res) => {
  if (req.session.userId) {
    return res.redirect("/home");
  }
  res.render("landing");
});

app.get("/home", async (req, res) => {
  try {
    const tools = await Tool.find().limit(12).lean();
    const allTools = await Tool.find().lean();
    const trendingTools = await getTrendingTools(10);
    const trendingIds = trendingTools.map(t => t._id.toString());

    res.render("home", {
      tools: tools || [],
      trendingIds: trendingIds || [],
      allTools: allTools || []
    });
  } catch (err) {
    console.error(err);
    res.send("Error loading home");
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
                content: `You are an AI search engine brain. Convert user query into JSON: {"intent": "","keywords": [],"categories": []}. Return ONLY JSON.`
              },
              { role: "user", content: searchQuery }
            ]
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
              "Content-Type": "application/json"
            },
            timeout: 8000
          }
        );

        let text = ai.data.choices[0].message.content;
        text = text.replace(/```json/g, "").replace(/```/g, "").trim();
        aiData = JSON.parse(text);

      } catch (err) {
        aiData = {
          intent: searchQuery,
          keywords: [searchQuery],
          categories: []
        };
      }

      tools = tools.map(tool => {
        let score = 0;
        const name = tool.name.toLowerCase();
        const desc = tool.description.toLowerCase();
        const cat = tool.category.toLowerCase();

        const keywords = [
          ...(aiData.keywords || []),
          aiData.intent
        ].map(k => (k || "").toLowerCase()).filter(Boolean);

        keywords.forEach(k => {
          if (name.includes(k)) score += 5;
          if (desc.includes(k)) score += 3;
          if (cat.includes(k)) score += 4;
        });

        (aiData.categories || []).forEach(c => {
          if (cat.includes(c.toLowerCase())) score += 6;
        });

        score += (tool.clickHistory || []).length * 0.5;

        return { ...tool, score };
      });

      tools = tools
        .filter(t => t.score > 0)
        .sort((a, b) => b.score - a.score);
    }

    const allTools = tools;
    const categories = [...new Set(allTools.map(t => t.category))];
    const recommended = tools.slice(0, 3);

    res.render("tools", {
      tools,
      categories,
      searchQuery: searchQuery || "",
      recommended
    });

  } catch (err) {
    console.error(err);
    res.send("Error loading tools");
  }
});

app.get("/tools/category/:category", async (req, res) => {
  try {
    const rawCategory = req.params.category;
    const category = rawCategory.replace(/-/g, " ");
    const searchQuery = req.query.q;

    let tools;

    if (searchQuery) {
      tools = await Tool.find({
        category: { $regex: new RegExp(`^${category}$`, "i") }
      }).lean();

      tools = tools.map(tool => {
        let score = 0;
        const text = (tool.name + tool.description).toLowerCase();
        const query = searchQuery.toLowerCase();
        if (text.includes(query)) score += 5;
        return { ...tool, score };
      });

      tools = tools
        .filter(t => t.score > 0)
        .sort((a, b) => b.score - a.score);

    } else {
      tools = await Tool.find({
        category: { $regex: new RegExp(`^${category}$`, "i") }
      }).lean();
    }

    const allTools = await Tool.find().lean();
    const categories = [...new Set(allTools.map(t => t.category))];
    const recommended = tools.slice(0, 3);

    res.render("tools", {
      tools,
      categories,
      selectedCategory: category,
      searchQuery: searchQuery || "",
      recommended
    });

  } catch (err) {
    console.error(err);
    res.send("Error loading category");
  }
});

app.get("/categories", async (req, res) => {
  try {
    const tools = await Tool.find().lean();
    const categories = [...new Set(tools.map(t => t.category))];
    res.render("categories", { categories });
  } catch (err) {
    console.error(err);
    res.send("Error loading categories");
  }
});

app.get("/visit/:id", async (req, res) => {
  try {
    const tool = await Tool.findById(req.params.id);
    if (!tool) return res.send("Tool not found");

    tool.clicks = (tool.clicks || 0) + 1;
    if (!tool.clickHistory) tool.clickHistory = [];
    tool.clickHistory.push({ date: new Date() });
    await tool.save();

    res.redirect(tool.url);
  } catch (err) {
    console.error(err);
    res.send("Error visiting tool");
  }
});

app.get("/tool/:id", async (req, res) => {
  try {
    const tool = await Tool.findById(req.params.id).lean();
    if (!tool) return res.send("Tool not found");

    let aiInsights = null;

    try {
      const ai = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: "llama-3.1-8b-instant",
          messages: [
            {
              role: "system",
              content: `You are an AI product expert. Analyze the tool and return JSON: {"why": "","bestFor": [],"pros": [],"cons": []}. Keep it short and practical.`
            },
            {
              role: "user",
              content: `Name: ${tool.name}\nCategory: ${tool.category}\nDescription: ${tool.description}`
            }
          ]
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Type": "application/json"
          },
          timeout: 8000
        }
      );

      let text = ai.data.choices[0].message.content;
      text = text.replace(/```json/g, "").replace(/```/g, "").trim();
      const match = text.match(/\{[\s\S]*\}/);
      if (match) aiInsights = JSON.parse(match[0]);

    } catch (err) {
      console.log("AI failed for tool insights");
    }

    res.render("tool-details", { tool, aiInsights });

  } catch (err) {
    console.error(err);
    res.send("Error loading tool");
  }
});

app.get("/bundles", (req, res) => {
  res.render("bundles");
});

app.post("/generate-bundle", async (req, res) => {
  const { goal, step, answers } = req.body;
  const tools = await Tool.find().limit(20).lean();
  const toolList = tools.map(t => `Name: ${t.name}, URL: ${t.url}`).join("\n");

  if (!step || step === 1) {
    return res.json({
      type: "questions",
      step: 2,
      questions: [
        "What type of project do you want?",
        "Who is your target users?",
        "What is your main goal?",
        "Do you want simple or advanced?",
        "Any tech preference?"
      ]
    });
  }

  try {
    const prompt = `
User goal: ${goal}
Answers:
${answers?.join("\n")}
Use ONLY tools from this list (copy exact name and url):
${toolList}
Create a structured AI workflow bundle.
Return ONLY JSON:
{
  "title": "",
  "steps": [
    {
      "step": 1,
      "title": "",
      "description": "",
      "tools": [
        { "name": "", "url": "" }
      ]
    }
  ]
}
    `;

    const ai = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: "You are an expert startup mentor." },
          { role: "user", content: prompt }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 15000
      }
    );

    let text = ai.data.choices[0].message.content;
    text = text.replace(/```json/g, "").replace(/```/g, "").trim();

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON");

    const parsed = JSON.parse(match[0]);

    parsed.steps.forEach(s => {
      s.tools = (s.tools || []).map(t => {
        if (typeof t === "object" && t.name && t.url) return t;

        const found = tools.find(tool =>
          tool.name.toLowerCase().includes((t.name || t).toLowerCase())
        );

        return found
          ? { name: found.name, url: found.url }
          : {
              name: t.name || t,
              url: "https://www.google.com/search?q=" + encodeURIComponent(t.name || t)
            };
      });
    });

    res.json(parsed);

  } catch (err) {
    console.error(err);
    res.json({ error: "AI failed", raw: err.message });
  }
});

// Tool suggestions JSON endpoint
app.get("/api/tools/suggest", async (req, res) => {
  try {
    const q = req.query.q || "";
    let tools = await Tool.find().lean();

    if (q) {
      tools = tools
        .map(tool => {
          const text  = (tool.name + " " + tool.description + " " + tool.category).toLowerCase();
          const query = q.toLowerCase();
          const score = (text.includes(query) ? 5 : 0) +
                        (tool.name.toLowerCase().includes(query) ? 3 : 0);
          return { ...tool, score };
        })
        .filter(t => t.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
    } else {
      tools = tools.slice(0, 3);
    }

    res.json(tools.map(t => ({ _id: t._id, name: t.name, url: t.url, category: t.category })));
  } catch (err) {
    res.json([]);
  }
});

app.get("/trending", async (req, res) => {
  try {
    const tools = await getTrendingTools(20);
    res.render("trending", { tools });
  } catch (err) {
    console.error(err);
    res.send("Error loading trending page");
  }
});

app.get("/submit", (req, res) => {
  res.render("submit");
});

app.post("/submit", upload.single("logo"), async (req, res) => {
  try {
    const { name, category, url, description } = req.body;

    if (!name || !category || !url || !description) {
      return res.send("All fields are required");
    }

    let logoPath = "/logos/default.png";
    if (req.file) {
      logoPath = "/uploads/" + req.file.filename;
    }

    await new Tool({
      name,
      category,
      url,
      description,
      logo: logoPath,
      clicks: 0,
      clickHistory: []
    }).save();

    res.redirect("/tools");

  } catch (err) {
    console.error(err);
    res.send("Error submitting tool");
  }
});

app.get("/about", (req, res) => {
  res.render("about");
});

// ================= MULTI-GENERATE =================
app.post("/multi-generate", async (req, res) => {
  const { prompt, messages, aiType } = req.body;

  if (!prompt && (!messages || messages.length === 0)) {
    return res.json({
      responses: [{ model: "Error", output: "⚠️ No input received" }],
      recommended: "Error"
    });
  }

  try {
    const selectedModels = aiType
      ? models.filter(m => m.name.toLowerCase().includes(aiType.toLowerCase()))
      : models;

    const topTools = await Tool.find().limit(5).lean();
    const toolList = topTools.map(t => t.name).join(", ");

    const responses = await Promise.all(
      selectedModels.map(async (ai) => {
        try {
          const finalMessages = messages?.length
            ? messages
            : [{ role: "user", content: prompt || "Hello" }];

          const result = await axios.post(
            "https://api.groq.com/openai/v1/chat/completions",
            {
              model: "llama-3.1-8b-instant",
              messages: [
                {
                  role: "system",
                  content: `You are AQUIPLEX AI. Suggest tools when needed: ${toolList}`
                },
                { role: "system", content: ai.system },
                ...finalMessages
              ]
            },
            {
              headers: {
                Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
                "Content-Type": "application/json"
              },
              timeout: 10000
            }
          );

          return {
            model: ai.name,
            output: result?.data?.choices?.[0]?.message?.content || "⚠️ Empty response"
          };

        } catch {
          return {
            model: ai.name,
            output: "⚠️ Error generating response"
          };
        }
      })
    );

    const best = responses.find(r => !r.output.includes("⚠️")) || responses[0];

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
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    res.json(history);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching history");
  }
});

const Bundle = require("./models/Bundle");

app.post("/bundle/save", requireLogin, async (req, res) => {
  try {
    const { title, steps } = req.body;

    if (!title || !steps) {
      return res.status(400).json({ error: "Invalid bundle" });
    }

    const saved = await new Bundle({
      userId: req.session.userId,
      title,
      steps,
      progress: steps.map(s => ({
        step: s.step,
        status: "pending"
      }))
    }).save();

    res.json({ success: true, id: saved._id });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save bundle" });
  }
});

app.get("/bundle/:id", async (req, res) => {
  try {
    const bundle = await Bundle.findById(req.params.id).lean();
    if (!bundle) return res.send("Bundle not found");
    res.render("bundle-view", { bundle });
  } catch {
    res.send("Error loading bundle");
  }
});

// ================= CHATBOT PAGE =================
app.get("/chatbot", requireLogin, (req, res) => {
  res.render("chatbot");
});

// ================= CHAT ROUTE =================
// FIX: Rate limiter applied only to POST
app.post("/chat", chatLimiter, upload.single("file"), async (req, res) => {
  let { message, history, mode, chatId, stream } = req.body;

  // FIX: Parse stream flag reliably
  stream = stream === "true" || stream === true;

  // FIX: Robust history parsing — handle array, string, or missing
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

  if (!message && !req.file) {
    return res.json({ reply: "⚠️ Message required" });
  }

  // Normalize message
  message = (message || "").trim();

  try {
    let messages = [...parsedHistory];
    let fileText = "";

    // ================= FILE PROCESS =================
    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase();

      try {
        if (ext === ".txt") {
          fileText = fs.readFileSync(req.file.path, "utf8");
        } else if (ext === ".pdf") {
          const buffer = fs.readFileSync(req.file.path);
          const data = await pdfParse(buffer);
          fileText = data.text;
        } else if (ext === ".docx") {
          const result = await mammoth.extractRawText({ path: req.file.path });
          fileText = result.value;
        } else {
          fileText = `Unsupported file type: ${ext}`;
        }
      } catch {
        fileText = "⚠️ Failed to read file";
      }

      // Delete file after read
      fs.unlink(req.file.path, () => {});
    }

    if (fileText.length > 10000) {
      fileText = fileText.slice(0, 10000);
    }

    if (fileText) {
      messages.push({
        role: "system",
        content: `User uploaded file:\n${fileText}`
      });
    }

    // ================= REFINER =================
    let refinedMessage = message;

    if (req.body.refiner === "true" && message) {
      try {
        const refinerInput = fileText ? message + "\n\nFile:\n" + fileText : message;
        refinedMessage = await generateAI([
          {
            role: "system",
            content: "Rewrite user input into a clear, detailed AI prompt. Return ONLY the improved prompt, nothing else."
          },
          { role: "user", content: refinerInput }
        ]);
        // Guard against empty refiner output
        if (!refinedMessage || refinedMessage.includes("⚠️")) {
          refinedMessage = message;
        }
      } catch {
        refinedMessage = message;
      }
    }

    // Push user message (refined if applicable)
    messages.push({
      role: "user",
      content: req.body.refiner === "true" ? refinedMessage : message
    });

    // ================= IMAGE MODE =================
    if (mode === "image") {
      const result = await generateImage(message);
      return res.json({
        reply: "🖼️ Here is your image:",
        image: result.url
      });
    }

    // ================= SEARCH MODE =================
    if (mode === "search") {
      try {
        const search = await axios.post(
          "https://google.serper.dev/search",
          { q: message },
          {
            headers: {
              "X-API-KEY": process.env.SERPER_API_KEY,
              "Content-Type": "application/json"
            },
            timeout: 8000
          }
        );

        const results = search.data?.organic || [];
        const resultsText = results
          .slice(0, 5)
          .map(r => `${r.title}: ${r.snippet}`)
          .join("\n");

        const reply = await generateAI([
          { role: "system", content: "You are Aqua AI. Summarize search results clearly and concisely with proper formatting." },
          { role: "user", content: `Question: ${message}\n\nSearch results:\n${resultsText}` }
        ]);

        const savedChat = await saveChat(
          [...messages, { role: "assistant", content: reply }],
          chatId, req.session.userId, message
        );

        return res.json({
          reply,
          chatId: savedChat?._id
        });

      } catch {
        return res.json({
          reply: `🔎 Here's a Google search for your query: [Search Results](https://www.google.com/search?q=${encodeURIComponent(message)})`
        });
      }
    }

    // ================= STREAM MODE =================
    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no"); // disables nginx buffering on Replit/Render
      res.flushHeaders?.();

      // Send refined prompt preview immediately
      if (req.body.refiner === "true" && refinedMessage !== message) {
        res.write(`data: ${JSON.stringify({ refined: refinedMessage })}\n\n`);
      }

      let fullReply = "";
      let axiosStream;

      try {
        axiosStream = await axios({
          method: "post",
          url: "https://api.groq.com/openai/v1/chat/completions",
          data: {
            model: "llama-3.1-8b-instant",
            messages: [
              {
                role: "system",
                content: "You are Aqua AI, a smart and helpful assistant. Format responses clearly using markdown: headings, bullet points, and clean spacing. Be concise but thorough."
              },
              ...messages.slice(-10)
            ],
            stream: true
          },
          responseType: "stream",
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Type": "application/json"
          },
          timeout: 30000
        });

        // FIX: Line buffer across chunks — Groq TCP may split SSE lines
        let lineBuffer = "";
        let streamEnded = false;

        axiosStream.data.on("data", chunk => {
          if (streamEnded) return;

          lineBuffer += chunk.toString();

          // Split on newlines, keep incomplete last segment
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;

            const payload = trimmed.slice(5).trim();
            if (!payload) continue;

            if (payload === "[DONE]") {
              streamEnded = true;
              // Save chat async
              (async () => {
                await saveChat(
                  [...messages, { role: "assistant", content: fullReply }],
                  chatId, req.session.userId, message
                );
              })();
              res.write("data: [DONE]\n\n");
              res.end();
              return;
            }

            try {
              const parsed = JSON.parse(payload);
              const token = parsed.choices?.[0]?.delta?.content;

              if (token) {
                fullReply += token;
                // FIX: JSON.stringify keeps \n from breaking SSE frame
                res.write(`data: ${JSON.stringify(token)}\n\n`);
              }
            } catch {
              // Skip malformed JSON lines
            }
          }
        });

        axiosStream.data.on("end", () => {
          if (!streamEnded) {
            // Flush any remaining buffer
            if (lineBuffer.trim()) {
              const trimmed = lineBuffer.trim();
              if (trimmed.startsWith("data:")) {
                const payload = trimmed.slice(5).trim();
                if (payload && payload !== "[DONE]") {
                  try {
                    const parsed = JSON.parse(payload);
                    const token = parsed.choices?.[0]?.delta?.content;
                    if (token) {
                      fullReply += token;
                      res.write(`data: ${JSON.stringify(token)}\n\n`);
                    }
                  } catch {}
                }
              }
            }

            (async () => {
              await saveChat(
                [...messages, { role: "assistant", content: fullReply }],
                chatId, req.session.userId, message
              );
            })();

            res.write("data: [DONE]\n\n");
            res.end();
          }
        });

        axiosStream.data.on("error", async () => {
          if (!streamEnded) {
            streamEnded = true;
            // Fallback: send what we have
            if (fullReply) {
              res.write("data: [DONE]\n\n");
              res.end();
            } else {
              // Full fallback to non-stream
              const fallbackReply = await generateAI([
                { role: "system", content: "You are Aqua AI. Be helpful and clear." },
                ...messages.slice(-10)
              ]);
              res.write(`data: ${JSON.stringify(fallbackReply)}\n\n`);
              res.write("data: [DONE]\n\n");
              res.end();
            }
          }
        });

        // Client disconnect cleanup
        req.on("close", () => {
          streamEnded = true;
          if (axiosStream) axiosStream.data.destroy();
        });

        return;

      } catch (err) {
        console.log("❌ Stream init failed → fallback:", err.message);

        // Fallback to non-stream response
        const reply = await generateAI([
          { role: "system", content: "You are Aqua AI. Be helpful and clear." },
          ...messages.slice(-10)
        ]);

        const savedChat = await saveChat(
          [...messages, { role: "assistant", content: reply }],
          chatId, req.session.userId, message
        );

        // Send as SSE so frontend stream reader still works
        res.write(`data: ${JSON.stringify(reply)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
    }

    // ================= NORMAL (NON-STREAM) MODE =================
    const reply = await generateAI([
      {
        role: "system",
        content: "You are Aqua AI. Use headings, bullet points, and clear structure in your responses."
      },
      ...messages.slice(-10)
    ]);

    const savedChat = await saveChat(
      [...messages, { role: "assistant", content: reply }],
      chatId, req.session.userId, message
    );

    res.json({
      reply,
      chatId: savedChat?._id
    });

  } catch (err) {
    console.error("CHAT ERROR:", err.message);
    res.json({ reply: "⚠️ Something went wrong. Please try again." });
  }
});

// GET SINGLE CHAT
app.get("/history/:id", requireLogin, async (req, res) => {
  try {
    const chat = await History.findOne({
      _id: req.params.id,
      userId: req.session.userId
    });
    res.json(chat);
  } catch {
    res.status(500).send("Error loading chat");
  }
});

// DELETE CHAT
app.delete("/history/:id", requireLogin, async (req, res) => {
  try {
    await History.deleteOne({
      _id: req.params.id,
      userId: req.session.userId
    });
    res.sendStatus(200);
  } catch {
    res.status(500).send("Error deleting chat");
  }
});

// ================= AUTH =================

app.get("/login", (req, res) => {
  if (req.session.userId) return res.redirect("/workspace");
  res.render("login");
});

app.get("/signup", (req, res) => {
  if (req.session.userId) return res.redirect("/workspace");
  res.render("signup");
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.send("All fields are required");

    const user = await User.findOne({ email });
    if (!user) return res.send("User not found");

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.send("Invalid credentials");

    req.session.user = {
      _id: user._id,
      email: user.email,
      username: user.email.split("@")[0]
    };
    req.session.userId = user._id;

    req.session.save(() => {
      res.redirect("/home");
    });

  } catch (err) {
    console.error(err);
    res.send("Login error");
  }
});

app.get("/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);

app.get("/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/login" }),
  (req, res) => {
    req.session.user = {
      _id: req.user._id,
      email: req.user.email,
      username: req.user.email.split("@")[0]
    };
    req.session.userId = req.user._id;
    res.redirect("/home");
  }
);

app.post("/signup", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.send("All fields are required");

    const exists = await User.findOne({ email });
    if (exists) return res.send("User already exists");

    const hashedPassword = await bcrypt.hash(password, 12);

    const newUser = await new User({
      email,
      password: hashedPassword,
    }).save();

    req.session.user = {
      _id: newUser._id,
      email: newUser.email,
      username: newUser.email.split("@")[0]
    };
    req.session.userId = newUser._id;

    req.session.save(() => {
      res.redirect("/home");
    });

  } catch (err) {
    console.error(err);
    res.send("Signup error");
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
  let workspace = await Workspace.findOne({
    userId: req.session.userId,
  }).populate("tools").lean();

  if (!workspace) {
    workspace = await new Workspace({
      userId: req.session.userId,
      tools: [],
    }).save();
  }

  const bundles = await Bundle.find({
    userId: req.session.userId
  }).sort({ createdAt: -1 }).lean();

  res.render("workspace", { workspace, bundles });
});

app.post("/bundle/remove/:id", requireLogin, async (req, res) => {
  try {
    await Bundle.deleteOne({
      _id: req.params.id,
      userId: req.session.userId
    });
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error removing bundle");
  }
});

app.post("/workspace/add/:toolId", requireLogin, async (req, res) => {
  let workspace = await Workspace.findOne({ userId: req.session.userId });

  if (!workspace) {
    workspace = new Workspace({ userId: req.session.userId, tools: [] });
  }

  if (!workspace.tools.includes(req.params.toolId)) {
    workspace.tools.push(req.params.toolId);
    await workspace.save();
  }

  res.sendStatus(200);
});

app.post("/workspace/remove/:toolId", requireLogin, async (req, res) => {
  try {
    const toolId = new mongoose.Types.ObjectId(req.params.toolId);

    await Workspace.updateOne(
      { userId: req.session.userId },
      { $pull: { tools: toolId } }
    );

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error removing tool");
  }
});

// ================= START =================
async function startServer() {
  console.log("GROQ:", process.env.GROQ_API_KEY ? "OK" : "MISSING");
  console.log("MONGO:", process.env.MONGO_URI ? "OK" : "MISSING");
  console.log("SESSION:", process.env.SESSION_SECRET ? "OK" : "MISSING");

  await connectDB();
  await importTools();

  const PORT = process.env.PORT || 5000;

  app.listen(PORT, "0.0.0.0", () => {
    console.log("🚀 Server running on port " + PORT);
    console.log("HF:", process.env.HF_API_KEY ? "OK" : "MISSING");
  });
}

startServer();
