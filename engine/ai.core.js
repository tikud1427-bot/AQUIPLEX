"use strict";

/**
 * engine/ai.core.js — AQUIPLEX Unified AI Engine
 *
 * Cascade: Groq → OpenRouter → Gemini
 * Images:  Together → Pollinations
 * Search:  Serper + generateAI
 */

const axios = require("axios");

// ─────────────────────────────────────────────────────────────────────────────
// IDENTITY
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// RETRY HELPER
// ─────────────────────────────────────────────────────────────────────────────

async function withRetry(fn, retries = 2, delayMs = 500) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      // Don't retry on 413 (too large) or 404 (not found)
      const msg = err?.message || "";
      if (msg.includes("413") || msg.includes("404")) throw err;
      if (i === retries) throw err;
      // On 429, wait longer
      const wait = msg.includes("429") ? delayMs * 4 * (i + 1) : delayMs * (i + 1);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NORMALISE MESSAGES
// Accepts Anthropic-style [{role,content}] arrays with optional system messages.
// Strips system messages out for providers that take them inline,
// and prepends AQUA_IDENTITY + AQUA_CONTEXT as the first system entry.
// ─────────────────────────────────────────────────────────────────────────────

function _normalise(messages, injectIdentity = true) {
  let systemParts = [];
  const nonSystem = [];

  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
    } else {
      nonSystem.push({ role: m.role, content: m.content });
    }
  }

  if (injectIdentity) {
    systemParts = [AQUA_IDENTITY, AQUA_CONTEXT, ...systemParts];
  }

  const systemMsg = systemParts.length
    ? [{ role: "system", content: systemParts.join("\n\n") }]
    : [];

  // Ensure alternating user/assistant (OpenAI-style requirement)
  const cleaned = [];
  for (const m of nonSystem) {
    if (cleaned.length && cleaned[cleaned.length - 1].role === m.role) {
      cleaned[cleaned.length - 1].content += "\n" + m.content;
    } else {
      cleaned.push({ ...m });
    }
  }
  if (!cleaned.length || cleaned[0].role !== "user") {
    cleaned.unshift({ role: "user", content: "Hello" });
  }

  return { systemMsg, nonSystem: cleaned };
}

// ─────────────────────────────────────────────────────────────────────────────
// generateAI  (Groq → OpenRouter → Gemini)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Array<{role:string,content:string}>} messages
 * @param {{ temperature?:number, maxTokens?:number, model?:string }} opts
 * @returns {Promise<string>}
 */
// ─────────────────────────────────────────────────────────────────────────────
// MODEL TIERS
// Fast  → quick ops: intent classify, memory extract, chat titles, suggested prompts
// Smart → heavy ops: code gen, project gen, file edit, file analysis, explain
// ─────────────────────────────────────────────────────────────────────────────

const FAST_MODEL  = process.env.GROQ_FAST_MODEL  || "llama-3.3-70b-versatile";
const SMART_MODEL = process.env.GROQ_SMART_MODEL || "llama-3.3-70b-versatile";  // free on Groq

// ── OpenRouter updated free models (2025) ─────────────────────────────────
const OR_FREE_MODELS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "deepseek/deepseek-chat-v3-0324:free",
  "deepseek/deepseek-r1:free",
  "google/gemma-3-27b-it:free",
  "qwen/qwen3-235b-a22b:free",
  "meta-llama/llama-4-maverick:free",
  "mistralai/mistral-nemo:free",
];

async function generateAI(messages, opts = {}) {
  const { temperature = 0.7, maxTokens = 1024 } = opts;
  // Caller can pass model: SMART_MODEL for heavy tasks; defaults to FAST_MODEL
  const groqModel = opts.model || FAST_MODEL;
  const { systemMsg, nonSystem } = _normalise(messages);
  const combined = [...systemMsg, ...nonSystem];

  // ── 0a. Anthropic Claude — most powerful, primary if key available ────────
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const sysMsg2  = messages.find(m => m.role === "system");
      const userMsgs = messages.filter(m => m.role !== "system");
      const cleaned2 = [];
      for (const m of userMsgs) {
        if (cleaned2.length && cleaned2[cleaned2.length-1].role === m.role) {
          cleaned2[cleaned2.length-1].content += "\n" + m.content;
        } else { cleaned2.push({...m}); }
      }
      if (!cleaned2.length || cleaned2[0].role !== "user") cleaned2.unshift({role:"user",content:"Hello"});
      const aRes = await withRetry(() =>
        axios.post("https://api.anthropic.com/v1/messages", {
          model:      "claude-haiku-4-5-20251001",
          max_tokens: maxTokens || 1024,
          system:     sysMsg2?.content || undefined,
          messages:   cleaned2,
        }, {
          headers: {
            "x-api-key":         process.env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "Content-Type":      "application/json",
          },
          timeout: 15000,
        })
      );
      const aContent = aRes.data?.content?.filter(b => b.type === "text").map(b => b.text).join("") || "";
      if (aContent) return aContent;
      throw new Error("Empty Anthropic response");
    } catch (err) {
      console.error(`[ai.core] Anthropic failed: ${err.message}`);
    }
  }

  // ── 0b. Together AI free — Llama 405b, DeepSeek-V3 ─────────────────────
  if (process.env.TOGETHER_API_KEY) {
    const togetherModels = [
      "meta-llama/Llama-3.3-70B-Instruct-Turbo-Free",
      "deepseek-ai/DeepSeek-V3",
    ];
    for (const tm of togetherModels) {
      try {
        const tres = await withRetry(() =>
          axios.post("https://api.together.xyz/v1/chat/completions", {
            model: tm, messages: combined, temperature, max_tokens: maxTokens,
          }, {
            headers: { Authorization: `Bearer ${process.env.TOGETHER_API_KEY}`, "Content-Type": "application/json" },
            timeout: 15000,
          })
        );
        const tc = tres.data?.choices?.[0]?.message?.content;
        if (tc) return tc;
      } catch (err) {
        console.error(`[ai.core] Together ${tm} failed: ${err.message}`);
      }
    }
  }

  // ── 1. Groq ──────────────────────────────────────────────────────────────
  if (process.env.GROQ_API_KEY) {
    try {
      const groqModels = [
        groqModel,
        "llama-3.1-70b-versatile",
        "deepseek-r1-distill-llama-70b",
        "qwen-qwq-32b",
        "meta-llama/llama-4-scout-17b-16e-instruct",
      ].filter((v, i, a) => a.indexOf(v) === i);
      for (const gm of groqModels) {
        try {
          const res = await withRetry(() =>
            axios.post("https://api.groq.com/openai/v1/chat/completions", {
              model: gm, messages: combined, temperature, max_tokens: maxTokens,
            }, {
              headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
              timeout: 10000,
            })
          );
          const content = res.data?.choices?.[0]?.message?.content;
          if (content) return content;
        } catch (err) {
          console.error(`[ai.core] Groq ${gm} failed: ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`[ai.core] Groq section failed: ${err.message}`);
    }
  }

  // ── 2. OpenRouter ─────────────────────────────────────────────────────────
  if (process.env.OPENROUTER_API_KEY) {
    for (const orModel of OR_FREE_MODELS) {
    try {
      const res = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model:      orModel,
          messages:   combined,
          temperature,
          max_tokens: maxTokens,
        },
        {
          headers: {
            Authorization:  `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 15000,
        },
      );
      const content = res.data?.choices?.[0]?.message?.content;
      if (content) return content;
      throw new Error("Empty response from OpenRouter");
    } catch (err) {
      console.error(`[ai.core] OpenRouter ${orModel} failed: ${err.message}`);
      // try next model
    }
    } // end for OR_FREE_MODELS
  }

  // ── 3. Gemini (multi-model fallback) ────────────────────────────────────
  const _geminiKey = process.env.Gemini_API_Key || process.env.GEMINI_API_KEY;
  if (_geminiKey) {
    const geminiModels = [
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
      "gemini-2.5-flash-preview-04-17",
      "gemini-1.5-flash-002",
    ];
    const userText = nonSystem
      .filter((m) => m.role !== "system")
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    const systemText = [...systemMsg.map((m) => m.content)].join("\n");
    for (const gm of geminiModels) {
      try {
        const res = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${gm}:generateContent?key=${_geminiKey}`,
          {
            contents:         [{ parts: [{ text: `${systemText}\n\nUser: ${userText}` }] }],
            generationConfig: { temperature, maxOutputTokens: maxTokens },
          },
          { timeout: 15000 },
        );
        const content = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (content) return content;
      } catch (err) {
        console.error(`[ai.core] Gemini ${gm} failed: ${err.message}`);
      }
    }
  }

  return "⚠️ All AI services are currently unavailable. Please check your API keys and try again.";
}

// ─────────────────────────────────────────────────────────────────────────────
// generateImage  (Together → Pollinations)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} prompt
 * @param {object} opts
 * @returns {Promise<string|null>}  image URL or null
 */
async function generateImage(prompt, opts = {}) {
  // ── 1. Together AI ────────────────────────────────────────────────────────
  if (process.env.TOGETHER_API_KEY) {
    try {
      const res = await axios.post(
        "https://api.together.xyz/v1/images/generations",
        {
          model:  "black-forest-labs/FLUX.1-schnell-Free",
          prompt,
          n:      1,
          width:  1024,
          height: 1024,
        },
        {
          headers: {
            Authorization:  `Bearer ${process.env.TOGETHER_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 30000,
        },
      );
      const url = res.data?.data?.[0]?.url;
      if (url) return url;
      throw new Error("No image URL from Together");
    } catch (err) {
      console.error(`[ai.core] Together image failed: ${err.message}`);
    }
  }

  // ── 2. Pollinations (free, no key) ────────────────────────────────────────
  try {
    const encoded = encodeURIComponent(prompt);
    const url     = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&nologo=true`;
    // Verify reachable
    await axios.head(url, { timeout: 10000 });
    return url;
  } catch (err) {
    console.error(`[ai.core] Pollinations image failed: ${err.message}`);
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// generateSearch  (Serper + generateAI)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Array<{role:string,content:string}>} messages
 * @param {object} opts
 * @returns {Promise<{ message: string, sources: object[] }>}
 */
async function generateSearch(messages, opts = {}) {
  const query = [...messages].reverse().find((m) => m.role === "user")?.content || "";
  let sources = [];
  let searchContext = "";

  if (process.env.SERPER_API_KEY && query) {
    try {
      const res = await axios.post(
        "https://google.serper.dev/search",
        { q: query, num: 5 },
        {
          headers: {
            "X-API-KEY":    process.env.SERPER_API_KEY,
            "Content-Type": "application/json",
          },
          timeout: 8000,
        },
      );
      const organic = res.data?.organic || [];
      sources = organic.map((r) => ({
        title:   r.title,
        url:     r.link,
        snippet: r.snippet,
      }));
      if (sources.length) {
        searchContext =
          "Web search results:\n" +
          sources.map((s, i) => `[${i + 1}] ${s.title}\n${s.snippet}\n${s.url}`).join("\n\n") +
          "\n\nUse the above results to answer the user's question accurately.";
      }
    } catch (err) {
      console.error(`[ai.core] Serper search failed: ${err.message}`);
    }
  }

  const augmented = searchContext
    ? [{ role: "system", content: searchContext }, ...messages]
    : messages;

  const reply = await generateAI(augmented, opts);
  return { message: reply, sources };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { generateAI, generateImage, generateSearch, FAST_MODEL, SMART_MODEL };