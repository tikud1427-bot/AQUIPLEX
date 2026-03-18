require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const session = require("express-session");
const bodyParser = require("body-parser");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();

// ================= MODELS =================
const User = require("./models/User");
const Tool = require("./models/Tool");
const Workspace = require("./models/Workspace");

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
  const count = await Tool.countDocuments();
  if (count === 0 && jsonTools.length > 0) {
    await Tool.insertMany(jsonTools);
    console.log("✅ Default tools imported");
  }
}

// ================= MIDDLEWARE =================
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));
app.set("view engine", "ejs");

app.use(session({
  secret: process.env.SESSION_SECRET || "aidex-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

// 🔥 GLOBAL USER
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

// ================= UPLOAD =================
const uploadDir = path.join(__dirname, "public/uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) =>
    cb(null, Date.now() + "-" + file.originalname)
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
    const tools = await Tool.find().limit(12).lean();
    const trendingTools = await getTrendingTools(10);
    const trendingIds = trendingTools.map(t => t._id.toString());

    res.render("home", { tools, trendingIds });
  } catch {
    res.send("Error loading home");
  }
});

// TOOLS
app.get("/tools", async (req, res) => {
  try {
    const tools = await Tool.find().lean();
    const categories = [...new Set(tools.map(t => t.category))];

    const trendingTools = await getTrendingTools(10);
    const trendingIds = trendingTools.map(t => t._id.toString());

    res.render("tools", { tools, categories, trendingIds });
  } catch {
    res.send("Error loading tools");
  }
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

// TRENDING
app.get("/trending", async (req, res) => {
  try {
    const tools = await getTrendingTools(20);

    const allTools = await Tool.find().lean();
    const categories = [...new Set(allTools.map(t => t.category))];

    const trendingIds = tools.map(t => t._id.toString());

    res.render("trending", { tools, categories, trendingIds });
  } catch {
    res.send("Error loading trending");
  }
});

// SEARCH
app.get("/search", async (req, res) => {
  const q = req.query.q || "";

  const tools = await Tool.find({
    $or: [
      { name: { $regex: q, $options: "i" } },
      { category: { $regex: q, $options: "i" } },
      { description: { $regex: q, $options: "i" } }
    ]
  }).lean();

  const categories = [...new Set(tools.map(t => t.category))];

  const trendingTools = await getTrendingTools(10);
  const trendingIds = trendingTools.map(t => t._id.toString());

  res.render("tools", { tools, categories, trendingIds });
});

// CATEGORY
app.get("/tools/category/:name", async (req, res) => {
  const category = decodeURIComponent(req.params.name);

  const tools = await Tool.find({
    category: { $regex: "^" + category + "$", $options: "i" }
  }).lean();

  const allTools = await Tool.find().lean();
  const categories = [...new Set(allTools.map(t => t.category))];

  const trendingTools = await getTrendingTools(10);
  const trendingIds = trendingTools.map(t => t._id.toString());

  res.render("tools", { tools, categories, trendingIds });
});

// ================= AUTH =================

// LOGIN PAGE
app.get("/login", (req, res) => res.render("login"));

// SIGNUP PAGE
app.get("/signup", (req, res) => res.render("signup"));

// LOGIN
app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });
  if (!user) return res.send("User not found");

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.send("Wrong password");

  req.session.userId = user._id;
  req.session.user = {
    _id: user._id,
    email: user.email
  };

  res.redirect("/workspace");
});

// SIGNUP
app.post("/signup", async (req, res) => {
  const { email, password } = req.body;

  const exists = await User.findOne({ email });
  if (exists) return res.send("User exists");

  const hash = await bcrypt.hash(password, 10);
  await new User({ email, password: hash }).save();

  res.redirect("/login");
});

// LOGOUT
app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// ================= WORKSPACE =================
app.get("/workspace", requireLogin, async (req, res) => {
  let workspace = await Workspace.findOne({ userId: req.session.userId }).populate("tools");

  if (!workspace) {
    workspace = await new Workspace({
      userId: req.session.userId,
      tools: []
    }).save();
  }

  res.render("workspace", { workspace });
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
  await Workspace.updateOne(
    { userId: req.session.userId },
    { $pull: { tools: req.params.toolId } }
  );

  res.sendStatus(200);
});

// ================= START =================
async function startServer() {
  await connectDB();
  await importTools();

  const PORT = process.env.PORT || 3000;

  app.listen(PORT, "0.0.0.0", () => {
    console.log("🚀 Server running on port " + PORT);
  });
}

startServer();