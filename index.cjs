try { require("dotenv").config(); } catch(e) {}

const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const session = require("express-session");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();

const User = require("./models/User.cjs");
const Tool = require("./models/Tool.cjs");
const Workspace = require("./models/Workspace.cjs");

// ================= DATABASE =================
async function connectDB() {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB connected");
  } catch (err) {
    console.error("MongoDB connection failed:", err.message);
    process.exit(1);
  }
}

// ================= TRENDING =================
async function getTrendingTools(limit = 10) {
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const tools = await Tool.find().lean();
  const scored = tools.map(tool => {
    const recentClicks = (tool.clickHistory || []).filter(
      c => new Date(c.date) > last24h
    ).length;
    return { ...tool, trendingScore: recentClicks };
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
    console.log("Default tools imported");
  }
}

// ================= MIDDLEWARE =================
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static("public"));
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

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
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const upload = multer({ storage });

// ================= AUTH GUARD =================
function requireLogin(req, res, next) {
  if (!req.session.userId) return res.redirect("/login");
  next();
}

// ================= ROUTES =================

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

// VISIT TOOL (track click then redirect)
app.get("/visit/:id", async (req, res) => {
  try {
    const tool = await Tool.findById(req.params.id);
    if (!tool) return res.redirect("/tools");
    tool.clicks = (tool.clicks || 0) + 1;
    tool.clickHistory = tool.clickHistory || [];
    tool.clickHistory.push({ date: new Date() });
    await tool.save();
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
    res.render("trending", { tools: trendingTools, categories, trendingIds });
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

// SUBMIT TOOL PAGE
app.get("/submit", (req, res) => res.render("submit"));

// SUBMIT TOOL POST
app.post("/submit", upload.single("logo"), async (req, res) => {
  try {
    const { name, category, url, description } = req.body;
    const logo = req.file ? "/uploads/" + req.file.filename : "";
    await new Tool({ name, category, url, description, logo, clicks: 0 }).save();
    res.redirect("/tools");
  } catch (err) {
    console.log(err);
    res.send("Error submitting tool");
  }
});

// ABOUT PAGE
app.get("/about", (req, res) => {
  if (fs.existsSync(path.join(__dirname, "views/about.ejs"))) {
    res.render("about");
  } else {
    res.send("About AIDEX - AI Tool Directory");
  }
});

// ================= AUTH =================

app.get("/login", (req, res) => res.render("login"));
app.get("/signup", (req, res) => res.render("signup"));

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.render("login", { error: "User not found" });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.render("login", { error: "Wrong password" });
    req.session.userId = user._id;
    res.redirect("/workspace");
  } catch (err) {
    res.render("login", { error: "Login error" });
  }
});

app.post("/signup", async (req, res) => {
  const { email, password } = req.body;
  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.render("signup", { error: "User already exists" });
    const hashedPassword = await bcrypt.hash(password, 10);
    await new User({ email, password: hashedPassword }).save();
    res.redirect("/login");
  } catch (err) {
    res.render("signup", { error: "Signup error" });
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// ================= WORKSPACE =================

app.get("/workspace", requireLogin, async (req, res) => {
  try {
    let workspace = await Workspace.findOne({ userId: req.session.userId });
    if (!workspace) {
      workspace = await new Workspace({ userId: req.session.userId, tools: [] }).save();
    }
    res.render("workspace", { workspace });
  } catch (err) {
    console.log(err);
    res.send("Error loading workspace");
  }
});

app.post("/workspace/add/:id", async (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }
  try {
    const tool = await Tool.findById(req.params.id).lean();
    if (!tool) return res.status(404).json({ error: "Tool not found" });

    let workspace = await Workspace.findOne({ userId: req.session.userId });
    if (!workspace) {
      workspace = new Workspace({ userId: req.session.userId, tools: [] });
    }

    const alreadyAdded = workspace.tools.some(t => t.toolId === req.params.id);
    if (!alreadyAdded) {
      workspace.tools.push({
        toolId: req.params.id,
        name: tool.name,
        url: tool.url,
        logo: tool.logo
      });
      await workspace.save();
    }

    res.json({ success: true });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/workspace/remove/:id", requireLogin, async (req, res) => {
  try {
    const workspace = await Workspace.findOne({ userId: req.session.userId });
    if (workspace) {
      workspace.tools = workspace.tools.filter(t => t.toolId !== req.params.id);
      await workspace.save();
    }
    res.json({ success: true });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================= START SERVER =================
async function startServer() {
  await connectDB();
  await importTools();

  const PORT = parseInt(process.env.PORT || "5000", 10);
  app.listen(PORT, "0.0.0.0", () => {
    console.log("Server running on port " + PORT);
  });
}

startServer();

process.on("unhandledRejection", err => console.error(err));
process.on("uncaughtException", err => console.error(err));
