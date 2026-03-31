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
app.use(express.static("public"));

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

// ================= ROUTES =================

// HOME
app.get("/", async (req, res) => {
  try {
    const tools = await Tool.find().limit(12).lean(); // for UI
    const allTools = await Tool.find().lean(); // 🔥 FULL DB

    const trendingTools = await getTrendingTools(10);
    const trendingIds = trendingTools.map(t => t._id.toString());

    res.render("home", { tools, trendingIds, allTools });

  } catch {
    res.send("Error loading home");
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
    // ✅ GET TOP TOOLS (SAFE)
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
                  content: `
              You are AQUIPLEX AI — a smart assistant that not only answers questions but also guides users to the best AI tools.
              Available tools on this platform:
              ${toolList}

              Your tasks:
              1. Answer clearly
              2. Suggest relevant AI tools if helpful
              3. Keep answers clean and useful
              4. ALWAYS suggest at least one relevant tool when possible

              Available tool categories:
              - Writing AI (ChatGPT, Jasper)
              - Image AI (Midjourney, DALL·E)
              - Video AI (Runway, Pika)
              - Coding AI (Copilot, Codeium)

              If user asks something like:
              - "write blog" → suggest writing tools
              - "generate image" → suggest image tools
              - "build app" → suggest coding tools

              Keep suggestions SHORT at the end like:
              "🔧 Recommended Tools: ChatGPT, Jasper"

              Tone: helpful, modern, not robotic.
              `
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

        } catch (err) {
          console.error("❌ ERROR:", ai.name);
          console.error("STATUS:", err.response?.status);
          console.error("DATA:", err.response?.data || err.message);

          return {
            model: ai.name,
            output: "⚠️ Error generating response"
          };
        }
      })
    );

    // ✅ Smart recommendation
    const best =
      responses.find(r => !r.output.includes("⚠️")) || responses[0];

    // ✅ SAVE HISTORY (SAFE)
    if (req.session?.userId) {
      try {
        await History.create({
          userId: req.session.userId,
          prompt: prompt || "chat",
          response: best.output,
          model: best.model
        });
      } catch (err) {
        console.log("History save failed:", err.message);
      }
    }

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
  res.redirect("/workspace");  
});

} catch (err) {
console.error(err);
res.send("Login error");
}
});

// SIGNUP
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

// 🔥 AUTO LOGIN AFTER SIGNUP  
req.session.user = {  
  _id: newUser._id,  
  email: newUser.email,  
  username: newUser.email.split("@")[0]  
};  

req.session.userId = newUser._id; // 🔥 ADD THIS  
req.session.save(() => {  
  res.redirect("/workspace");  
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
})
.populate("tools")
.lean();

if (!workspace) {
workspace = await new Workspace({
userId: req.session.userId,
tools: [],
}).save();
}

res.render("workspace", { workspace });
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