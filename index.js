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

const app = express();

// ✅ TRUST PROXY (IMPORTANT for Render/Replit)
app.set("trust proxy", 1);

app.use((req, res, next) => {
  const proto = req.headers["x-forwarded-proto"];

  // ❌ DISABLED FOR REPLIT (causes issues)
  // if (proto && proto !== "https") {
  //   return res.redirect("https://" + req.headers.host + req.url);
  // }

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
} catch {}

async function importTools() {
if (jsonTools.length === 0) return;

for (let tool of jsonTools) {
await Tool.updateOne(
{ name: tool.name },   // find by name
{ $set: tool },        // update data
{ upsert: true }       // create if not exists
);
}

console.log("✅ Tools synced");
}

// ================= MIDDLEWARE =================
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static("public"));
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
// ✅ SESSION (IMPROVED)
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

// ✅ GLOBAL USER (IMPORTANT)
app.use((req, res, next) => {
res.locals.user = req.session.user || null;
next();
});
//
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
//
function redirectIfLoggedIn(req, res, next) {
  if (req.session.userId) {
    return res.redirect("/home"); // ✅ stop here
  }
  next(); // ✅ only runs if NOT logged in
}
// ================= ROUTES =================

// Landing page

//

app.post("/api/tools/:id/like", async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Login required" });
  }

  const tool = await Tool.findById(req.params.id);

  if (!tool) {
    return res.json({ error: "Tool not found" });
  }

  // create likes array if not exists
  if (!tool.likedBy) tool.likedBy = [];

  // check if already liked
  if (tool.likedBy.includes(req.session.userId)) {
    return res.json({ message: "Already liked", likes: tool.likes });
  }

  tool.likes = (tool.likes || 0) + 1;
  tool.likedBy.push(req.session.userId);

  await tool.save();

  res.json({ likes: tool.likes });
});
//
app.get("/landing", (req, res) => {
  if (req.session.userId) {
    return res.redirect("/home");
  }
  res.render("landing");
});
// HOME (main app - public)
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

// AI BUNDLES PAGE
app.get("/bundles", (req, res) => {
  res.render("bundles");
});
//
// GENERATE AI BUNDLE (FIXED)
app.post("/generate-bundle", async (req, res) => {
  console.log("🔥 Bundle API called");

  const { goal } = req.body;

  if (!goal) {
    return res.json({ error: "No goal provided" });
  }

  try {
    const result = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.1-8b-instant",
        messages: [
          {
            role: "system",
            content: `
You are an AI that ONLY returns valid JSON.

DO NOT explain anything.
DO NOT add text before or after.
DO NOT use markdown.

STRICT FORMAT:

{
  "title": "Short bundle name",
  "steps": [
    {
      "step": 1,
      "title": "Step name",
      "description": "What to do",
      "tools": ["Tool1", "Tool2"]
    }
  ]
}

Rules:
- Max 5 steps
- Keep steps practical
- Use real AI tools like ChatGPT, Canva, Runway, etc.
- Output MUST be valid JSON
`
          },
          {
            role: "user",
            content: goal
          }
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

    const text = result?.data?.choices?.[0]?.message?.content || "";

    console.log("🧠 AI RAW:", text);

    // ✅ SAFE JSON PARSE
    let parsed;
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No JSON");

      parsed = JSON.parse(match[0]);
    } catch (err) {
      return res.json({
        error: "Invalid AI format",
        raw: text
      });
    }

    if (!parsed.steps) {
      return res.json({
        error: "Invalid structure",
        raw: parsed
      });
    }

    res.json(parsed);

  } catch (err) {
    console.error("❌ API ERROR:", err.response?.data || err.message);

    // ✅ FALLBACK (always works)
    res.json({
      title: "Basic AI Bundle",
      steps: [
        {
          step: 1,
          title: "Understand your goal",
          description: goal,
          tools: ["ChatGPT"]
        },
        {
          step: 2,
          title: "Use AI tools",
          description: "Execute using recommended tools",
          tools: ["Canva", "Google"]
        }
      ]
    });
  }
});
// TEST AI (DEBUG ROUTE)
app.get("/test-ai", async (req, res) => {
  try {
    const r = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "user", content: "hello" }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.json(r.data);

  } catch (e) {
    console.error("TEST AI ERROR:", e.response?.data || e.message);
    res.json({
      error: e.response?.data || e.message
    });
  }
});
// Download APK
app.get("/download", (req, res) => {
  console.log("APK downloaded");

  const filePath = path.join(__dirname, "public/uploads/Aquiplex.apk");
  res.download(filePath);
});

// TOOLS
app.get("/tools", async (req, res) => {
const query = req.query.q;

let tools;

if (query) {
tools = await Tool.find({
$or: [
{ name: { $regex: query, $options: "i" } },
{ description: { $regex: query, $options: "i" } },
],
}).lean();
} else {
tools = await Tool.find().lean();
}

const allTools = await Tool.find().lean();
const categories = [...new Set(allTools.map(t => t.category))];

const trendingTools = await getTrendingTools(10);
const trendingIds = trendingTools.map(t => t._id.toString());

res.render("tools", { tools, categories, trendingIds });
});

// TOOL DETAILS
app.get("/tool/:id", async (req, res) => {
try {
const tool = await Tool.findById(req.params.id).lean();
if (!tool) return res.redirect("/tools");

res.render("tool", { tool });

} catch {
res.redirect("/tools");
}
});

// VISIT TOOL
app.get("/visit/:id", async (req, res) => {
try {
const tool = await Tool.findById(req.params.id);
if (!tool) return res.redirect("/tools");

tool.clicks = (tool.clicks || 0) + 1;  
tool.clickHistory = tool.clickHistory || [];  
tool.clickHistory.push({ date: new Date() });  

await tool.save();  

let url = tool.url;  
if (!url.startsWith("http")) url = "https://" + url;  

res.redirect(url);

} catch {
res.redirect("/tools");
}
});

// TRENDING PAGE
app.get("/trending", async (req, res) => {
try {
const tools = await getTrendingTools(20);
res.render("trending", { tools });
} catch (err) {
console.error(err);
res.send("Error loading trending page");
}
});

// SUBMIT PAGE
app.get("/submit", (req, res) => {
res.render("submit");
});

// SUBMIT TOOL
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
// ABOUT PAGE
app.get("/about", (req, res) => {
res.render("about");
});

// CATEGORY FILTER
app.get("/tools/category/:category", async (req, res) => {
try {
const category = decodeURIComponent(req.params.category);

const tools = await Tool.find({
category: { $regex: new RegExp("^" + category + "$", "i") }
}).lean();
const allTools = await Tool.find().lean();
const categories = [...new Set(allTools.map(t => t.category))];

const trendingTools = await getTrendingTools(10);  
const trendingIds = trendingTools.map(t => t._id.toString());  

res.render("tools", { tools, categories, trendingIds });

} catch (err) {
console.error(err);
res.redirect("/tools");
}
});
app.get("/lab", (req, res) => {
res.render("lab");
});


// MULTI AI GENERATION
const models = [
  {
    name: "🧠 Smart AI",
    system: "You are a highly intelligent AI. Give deep, clear, and well-structured answers."
  },
  {
    name: "🎨 Creative AI",
    system: "You are a creative and imaginative AI. Make answers engaging, unique, and expressive."
  },
  {
    name: "⚡ Fast AI",
    system: "You are a concise AI. Give short, direct, and fast answers."
  }
];
//
app.post("/multi-generate", async (req, res) => {
  const { prompt, messages, aiType } = req.body;

  if (!prompt && (!messages || messages.length === 0)) {
    return res.json({
      responses: [{
        model: "Error",
        output: "⚠️ No input received"
      }],
      recommended: "Error"
    });
  }

  try {
    const selectedModels = aiType
      ? models.filter(m =>
          m.name.toLowerCase().includes(aiType.toLowerCase())
        )
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
            output:
              result?.data?.choices?.[0]?.message?.content ||
              "⚠️ Empty response"
          };

        } catch {
          return {
            model: ai.name,
            output: "⚠️ Error generating response"
          };
        }
      })
    );

    const best =
      responses.find(r => !r.output.includes("⚠️")) || responses[0];

    res.json({
      responses,
      recommended: best.model
    });

  } catch (err) {
    console.error("❌ GLOBAL ERROR:", err);
    res.status(500).send("AI generation failed");
  }
});
// HISTORY PAGE
app.get("/history", requireLogin, async (req, res) => {
  try {
    const history = await History.find({
      userId: req.session.userId
    })
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

// SAVE BUNDLE
app.post("/bundle/save", requireLogin, async (req, res) => {
  try {
    const { title, steps } = req.body;

    if (!title || !steps) {
      return res.status(400).json({ error: "Invalid bundle" });
    }

    const saved = await new Bundle({
      userId: req.session.userId,
      title,
      steps
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
// ================= CHATBOT =================
app.post("/chat", async (req, res) => {
  const { message, history, mode, chatId } = req.body;

  if (!message) {
    return res.json({ reply: "⚠️ Message required" });
  }

  try {
    let messages = (history || []).map(m => ({
      role: m.role === "bot" ? "assistant" : m.role,
      content: m.content
    }));

    // 🧠 Add user message
    messages.push({
      role: "user",
      content: message
    });

    let reply = "";

    // 🌐 SEARCH MODE (keep your upgraded version)
    if (mode === "search") {
      try {
        const search = await axios.post(
          "https://google.serper.dev/search",
          { q: message },
          {
            headers: {
              "X-API-KEY": process.env.SERPER_API_KEY,
              "Content-Type": "application/json"
            }
          }
        );

        const organic = search.data.organic;

        const resultsText = organic
          .slice(0, 5)
          .map(r => `${r.title}: ${r.snippet}`)
          .join("\n");

        const ai = await axios.post(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            model: "llama-3.1-8b-instant",
            messages: [
              {
                role: "system",
                content: "Summarize search results clearly."
              },
              {
                role: "user",
                content: `Query: ${message}\n\n${resultsText}`
              }
            ]
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
              "Content-Type": "application/json"
            }
          }
        );

        reply =
          ai?.data?.choices?.[0]?.message?.content ||
          "⚠️ No summary";

      } catch {
        reply = `⚠️ Search failed\nhttps://www.google.com/search?q=${encodeURIComponent(message)}`;
      }
    }

    // 🎨 IMAGE MODE
    else if (mode === "image") {
      const imageUrl =
        "https://image.pollinations.ai/prompt/" +
        encodeURIComponent(message);

      return res.json({
        reply: "🖼️ Here is your image:",
        image: imageUrl
      });
    }

    // 🧠 NORMAL CHAT
    else {
      const response = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: "llama-3.1-8b-instant",
          messages: [
            {
              role: "system",
              content: `
            You are Aqua AI by Aquiplex, a smart and friendly assistant.

            Rules:
            - Talk like a human, not a textbook
            - Keep responses clean and well formatted
            - Use short paragraphs (2-4 lines max)
            - Use bullet points when helpful
            - Add spacing between sections
            - Avoid long essays unless user asks
            - Be clear, modern, and conversational
            - Do NOT write like school answers (no "Similarities / Differences" unless asked)

            Formatting style:
            - Use simple headings when useful
            - Keep mobile readability in mind
            - Break content into sections

            Your goal: respond like ChatGPT (clean, structured, easy to read).
            `
            },
            ...messages.slice(-10) // ✅ limit memory = better responses
            ]
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Type": "application/json"
          }
        }
      );

      reply =
        response?.data?.choices?.[0]?.message?.content ||
        "⚠️ No reply";
    }

    // 🧠 Add AI reply
    messages.push({
      role: "assistant",
      content: reply
    });

    let chat;

    // 🔥 UPDATE EXISTING CHAT
    if (chatId) {
      chat = await History.findOneAndUpdate(
        { _id: chatId, userId: req.session.userId },
        { messages },
        { new: true }
      );
    }

    // 🆕 CREATE NEW CHAT
    else {
      chat = await History.create({
        userId: req.session.userId,
        title: message.slice(0, 30),
        messages
      });
    }

    res.json({
      reply,
      messages,
      chatId: chat._id
    });

  } catch (err) {
    console.error("CHAT ERROR:", err.message);
    res.json({ reply: "⚠️ AI failed" });
  }
});

//history id
app.get("/history/:id", requireLogin, async (req, res) => {
  try {
    const chat = await History.findOne({
      _id: req.params.id,
      userId: req.session.userId
    }).lean();

    if (!chat) {
      return res.status(404).json({ error: "Chat not found" });
    }

    res.json(chat);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error loading chat" });
  }
});
//delete history
app.delete("/history/:id", requireLogin, async (req, res) => {
  await History.deleteOne({
    _id: req.params.id,
    userId: req.session.userId
  });

  res.sendStatus(200);
});
// ================= AUTH =================

// LOGIN PAGE
app.get("/login", (req, res) => {
if (req.session.userId) return res.redirect("/workspace");
res.render("login");
});

// SIGNUP PAGE
app.get("/signup", (req, res) => {
if (req.session.userId) return res.redirect("/workspace");
res.render("signup");
});

// LOGIN
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

req.session.userId = user._id; // 🔥 ADD THIS  
  req.session.save(() => {  
    res.redirect("/home");  
  });

} catch (err) {
console.error(err);
res.send("Login error");
}
});
//signup
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

    // ✅ AUTO LOGIN
    req.session.user = {
      _id: newUser._id,
      email: newUser.email,
      username: newUser.email.split("@")[0]
    };

    req.session.userId = newUser._id;

    req.session.save(() => {
      res.redirect("/home"); // 🔥 FIXED
    });

  } catch (err) {
    console.error(err);
    res.send("Signup error");
  }
});

// LOGOUT
app.get("/logout", (req, res) => {
req.session.destroy(() => {
res.clearCookie("aidex_session");
res.redirect("/");
});
});

// ================= WORKSPACE =================

// VIEW

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

// DELETE BUNDLE
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

// ADD
app.post("/workspace/add/:toolId", requireLogin, async (req, res) => {
let workspace = await Workspace.findOne({
userId: req.session.userId,
});

if (!workspace) {
workspace = new Workspace({
userId: req.session.userId,
tools: [],
});
}

if (!workspace.tools.includes(req.params.toolId)) {
workspace.tools.push(req.params.toolId);
await workspace.save();
}

res.sendStatus(200);
});

// REMOVE
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

  // 🔥 DEBUG LOGS
  console.log("GROQ:", process.env.GROQ_API_KEY ? "OK" : "MISSING");
  console.log("MONGO:", process.env.MONGO_URI ? "OK" : "MISSING");
  console.log("SESSION:", process.env.SESSION_SECRET ? "OK" : "MISSING");

  await connectDB();
  await importTools();

  const PORT = process.env.PORT || 5000;

  app.listen(PORT, "0.0.0.0", () => {
    console.log("🚀 Server running on port " + PORT);
  });
}

startServer();


