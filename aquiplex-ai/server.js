require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());

// ✅ Serve static frontend
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

/* =========================
🧠 GROQ
========================= */
async function chatWithGroq(message) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama3-70b-8192",
      messages: [{ role: "user", content: message }],
    }),
  });

  const data = await res.json();

  if (!res.ok || !data.choices) {
    throw new Error("Groq API failed");
  }

  return data.choices[0].message.content;
}

/* =========================
🔄 OPENROUTER
========================= */
async function chatWithOpenRouter(message) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost:3000",
      "X-Title": "Aquiplex AI",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: message }],
    }),
  });

  const data = await res.json();

  if (!res.ok || !data.choices) {
    throw new Error("OpenRouter API failed");
  }

  return data.choices[0].message.content;
}

/* =========================
🌐 SERPER SEARCH
========================= */
async function searchWeb(query) {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": process.env.SERPER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query }),
  });

  const data = await res.json();

  if (!res.ok) throw new Error("Search failed");

  return data.organic?.slice(0, 3) || [];
}

/* =========================
🎨 IMAGE (Pollinations)
========================= */
function generateImage(prompt) {
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`;
}

/* =========================
💬 CHAT API
========================= */
app.post("/chat", async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Message is required" });
  }

  try {
    let reply;

    try {
      reply = await chatWithGroq(message);
    } catch {
      console.log("⚠️ Groq failed → using OpenRouter");
      reply = await chatWithOpenRouter(message);
    }

    res.json({ reply });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: "AI failed to respond" });
  }
});

/* =========================
🔍 SEARCH API
========================= */
app.post("/search", async (req, res) => {
  const { query } = req.body;

  if (!query) {
    return res.status(400).json({ error: "Query is required" });
  }

  try {
    const results = await searchWeb(query);
    res.json(results);
  } catch {
    res.status(500).json({ error: "Search failed" });
  }
});

/* =========================
🖼 IMAGE API
========================= */
app.get("/image", (req, res) => {
  const { prompt } = req.query;

  if (!prompt) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  res.json({ url: generateImage(prompt) });
});

/* =========================
📄 ROUTES (FRONTEND)
========================= */

// Home page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Optional custom route
app.get("/mychatbot", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* =========================
🚀 START SERVER
========================= */
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});