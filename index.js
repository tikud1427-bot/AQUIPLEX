const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");

const app = express();

// ---------- MIDDLEWARE ----------
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));
app.set("view engine", "ejs");

// ---------- DATABASE PATH ----------
const dataDir = path.join(__dirname, "data");
const dataPath = path.join(dataDir, "tools.json");

// ---------- DEFAULT TOOLS ----------
const defaultTools = [
  {
    name: "ChatGPT",
    category: "Writing AI",
    url: "https://chat.openai.com",
    description: "AI chatbot for writing, coding and research.",
    trending: true
  },
  {
    name: "Claude",
    category: "Writing AI",
    url: "https://claude.ai",
    description: "Advanced AI assistant.",
    trending: true
  },
  {
    name: "Grammarly",
    category: "Writing AI",
    url: "https://grammarly.com",
    description: "AI grammar assistant.",
    trending: false
  },
  {
    name: "Midjourney",
    category: "Image AI",
    url: "https://midjourney.com",
    description: "AI art generator.",
    trending: true
  },
  {
    name: "DALL-E",
    category: "Image AI",
    url: "https://openai.com/dall-e",
    description: "AI image generator.",
    trending: true
  },
  {
    name: "Runway ML",
    category: "Video AI",
    url: "https://runwayml.com",
    description: "AI video editing platform.",
    trending: true
  },
  {
    name: "GitHub Copilot",
    category: "Coding AI",
    url: "https://github.com/features/copilot",
    description: "AI coding assistant.",
    trending: true
  },
  {
    name: "Perplexity AI",
    category: "Research AI",
    url: "https://perplexity.ai",
    description: "AI powered search engine.",
    trending: true
  },
  {
    name: "ElevenLabs",
    category: "Voice AI",
    url: "https://elevenlabs.io",
    description: "AI voice generator.",
    trending: true
  }
];

let aiTools = [];

// ---------- LOAD DATABASE ----------
function loadTools() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
  }

  if (!fs.existsSync(dataPath)) {
    fs.writeFileSync(dataPath, JSON.stringify(defaultTools, null, 2));
    aiTools = defaultTools;
    return;
  }

  try {
    const data = fs.readFileSync(dataPath, "utf8");
    aiTools = JSON.parse(data);
  } catch (err) {
    console.log("Error loading tools.json, resetting.");
    aiTools = defaultTools;
    saveTools();
  }
}

// ---------- SAVE DATABASE ----------
function saveTools() {
  fs.writeFileSync(dataPath, JSON.stringify(aiTools, null, 2));
  console.log("Tools saved to tools.json");
}

// Load tools on start
loadTools();

// ---------- ROUTES ----------

// Home
app.get("/", function(req, res) {
  res.render("home", { tools: aiTools });
});

// All tools
app.get("/tools", function(req, res) {
  res.render("tools", { tools: aiTools });
});


app.get("/search", (req, res) => {

const query = req.query.q.toLowerCase();

  const results = aiTools.filter(tool =>
  tool.name.toLowerCase().includes(query) ||
  tool.category.toLowerCase().includes(query) ||
  tool.description.toLowerCase().includes(query)
  );

res.render("tools", { tools: results });

});
// Trending
app.get("/trending", function(req, res) {
  const trendingTools = aiTools.filter(function(tool) {
    return tool.trending === true;
  });
  res.render("trending", { tools: trendingTools });
});

// Submit page
app.get("/submit", function(req, res) {
  res.render("submit");
});

// Submit tool
app.post("/submit", function(req, res) {
  const name = req.body.name;
  const category = req.body.category;
  const url = req.body.url;
  const description = req.body.description;

  if (!name || !category || !url || !description) {
    return res.send("All fields are required.");
  }

  let formattedUrl = url;
  if (!url.startsWith("http")) {
    formattedUrl = "https://" + url;
  }

  const exists = aiTools.find(function(tool) {
    return tool.name.toLowerCase() === name.toLowerCase();
  });

  if (exists) {
    return res.send("This AI tool already exists.");
  }

  const newTool = {
    name: name,
    category: category,
    url: formattedUrl,
    description: description,
    trending: false
  };

  aiTools.push(newTool);
  saveTools();
  console.log("New tool added:", name);

  res.redirect("/tools");
});

// About page
app.get("/about", function(req, res) {
  res.render("about");
});

// Category filter
app.get("/tools/category/:name", function(req, res) {
  const category = req.params.name.toLowerCase();
  const filtered = aiTools.filter(function(tool) {
    return tool.category.toLowerCase() === category;
  });
  res.render("tools", { tools: filtered });
});

// ---------- SERVER ----------
const PORT = process.env.PORT || 3000;

app.listen(PORT, function() {
  console.log("Server running on port " + PORT);
});