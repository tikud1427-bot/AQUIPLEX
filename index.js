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

// ================= TRENDING FUNCTION =================
async function getTrendingTools(limit = 10) {
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const tools = await Tool.find().lean();

  const scored = tools.map(tool => {
    const recentClicks = (tool.clickHistory || []).filter(
      c => new Date(c.date) > last24h
    ).length;

    return {
      ...tool,
      trendingScore: recentClicks
    };
  });

  return scored
    .sort((a, b) => b.trendingScore - a.trendingScore)
    .slice(0, limit);
}

// ================= IMPORT JSON =================
let jsonTools = [];

try {
  jsonTools = JSON.parse(fs.readFileSync("./data/tools.json", "utf8"));
} catch {
  console.log("No tools.json found");
}

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

app.use((req, res, next) => {
  res.locals.userId = req.session.userId;
  next();
});

// ================= UPLOAD =================
const uploadDir = path.join(__dirname, "public/uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) =>
    cb(null, Date.now() + "-" + file.originalname)
});

const upload = multer({ storage });

// ================= LOGIN PROTECTION =================
function requireLogin(req, res, next) {
  if (!req.session.userId) return res.redirect("/login");
  next();
}

// ================= ROUTES =================

// TEST
app.get("/test", (req, res) => res.send("Server working"));

// HOME
app.get("/", async (req, res) => {
  try {
    const tools = await Tool.find().limit(12).lean();

    const trendingTools = await getTrendingTools(10);
    const trendingIds = trendingTools.map(t => t._id.toString());

    res.render("home", { tools, trendingIds });

  } catch (err) {
    console.log(err);
    res.send("Error loading home");
  }
});

// VISIT TOOL
app.get("/visit/:id", async (req, res) => {
  try {
    const tool = await Tool.findById(req.params.id);

    if (!tool) return res.redirect("/tools");

    // track clicks
    tool.clicks = (tool.clicks || 0) + 1;

    tool.clickHistory = tool.clickHistory || [];
    tool.clickHistory.push({ date: new Date() });

    await tool.save();

    // safe URL
    let url = tool.url || "";
    if (!url.startsWith("http")) url = "https://" + url;

    res.redirect(url);

  } catch (err) {
    console.log(err);
    res.redirect("/tools");
  }
});

// TOOL DETAILS
app.get("/tool/:id", async (req, res) => {
  try {
    const tool = await Tool.findById(req.params.id).lean();

    if (!tool) return res.redirect("/tools");

    res.render("tool", { tool });

  } catch (err) {
    res.redirect("/tools");
  }
});

// ALL TOOLS
app.get("/tools", async (req, res) => {
  try {
    const tools = await Tool.find().lean();

    const categories = [...new Set(tools.map(t => t.category))];

    const trendingTools = await getTrendingTools(10);
    const trendingIds = trendingTools.map(t => t._id.toString());

    res.render("tools", { tools, categories, trendingIds });

  } catch (err) {
    res.send("Error loading tools");
  }
});

// TRENDING PAGE
app.get("/trending", async (req, res) => {
  try {
    const trendingTools = await getTrendingTools(20);

    const allTools = await Tool.find().lean();
    const categories = [...new Set(allTools.map(t => t.category))];

    const trendingIds = trendingTools.map(t => t._id.toString());

    res.render("trending", {
      tools: trendingTools,
      categories,
      trendingIds
    });

  } catch (err) {
    console.log(err);
    res.send("Error loading trending page");
  }
});

// SEARCH
app.get("/search", async (req, res) => {
  const query = req.query.q || "";

  try {
    const results = await Tool.find({
      $or: [
        { name: { $regex: query, $options: "i" } },
        { category: { $regex: query, $options: "i" } },
        { description: { $regex: query, $options: "i" } }
      ]
    }).lean();

    const categories = [...new Set(results.map(t => t.category))];

    const trendingTools = await getTrendingTools(10);
    const trendingIds = trendingTools.map(t => t._id.toString());

    res.render("tools", { tools: results, categories, trendingIds });

  } catch (err) {
    res.send("Search error");
  }
});

// CATEGORY FILTER
app.get("/tools/category/:name", async (req, res) => {
  try {
    // 🔥 decode URL
    const category = decodeURIComponent(req.params.name);

    const tools = await Tool.find({
      category: { $regex: "^" + category + "$", $options: "i" }
    }).lean();

    const allTools = await Tool.find().lean();
    const categories = [...new Set(allTools.map(t => t.category))];

    const trendingTools = await getTrendingTools(10);
    const trendingIds = trendingTools.map(t => t._id.toString());

    res.render("tools", { tools, categories, trendingIds });

  } catch (err) {
    console.log(err);
    res.send("Category error");
  }
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
  res.redirect("/workspace");
});

// SIGNUP
app.post("/signup", async (req, res) => {
  const { email, password } = req.body;

  const existingUser = await User.findOne({ email });
  if (existingUser) return res.send("User exists");

  const hashedPassword = await bcrypt.hash(password, 10);

  await new User({ email, password: hashedPassword }).save();

  res.redirect("/login");
});

// LOGOUT
app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// ================= START SERVER =================
async function startServer() {
  await connectDB();
  await importTools();

  const PORT = process.env.PORT || 3000;

  app.listen(PORT, () => {
    console.log("🚀 Server running on port " + PORT);
  });
}

startServer();

// ================= ERRORS =================
process.on("unhandledRejection", err => console.error(err));
process.on("uncaughtException", err => console.error(err));