require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());

// ✅ EJS setup
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

const PORT = process.env.PORT || 3000;

/* =========================
💬 CHAT API
========================= */
app.post("/chat", async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Message required" });
  }

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant", // ✅ FIXED MODEL
        messages: [{ role: "user", content: message }],
      }),
    });

    const data = await response.json();

    if (!data.choices || !data.choices[0]) {
      throw new Error("Invalid response from Groq");
    }

    res.json({ reply: data.choices[0].message.content });

  } catch (err) {
    console.error("CHAT ERROR:", err.message);
    res.json({ reply: "Error getting response" });
  }
});
/* =========================
📄 ROUTES
========================= */
app.get("/", (req, res) => {
  res.render("chatbot");
});

app.get("/chatbot", (req, res) => {
  res.render("chatbot");
});

/* =========================
🚀 START
========================= */
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});