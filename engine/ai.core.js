"use strict";

/**
 * engine/ai.core.js — AQUIPLEX Unified AI Engine
 *
 * Cascade: Groq (primary) → OpenRouter (fallback/reasoning) → Gemini (last)
 * Images:  Pollinations (primary, no-auth) → HuggingFace (optional fallback)
 * Search:  Serper + generateAI
 *
 * Smart routing:
 *   tiny/simple → llama-3.1-8b-instant   (Groq)
 *   normal chat/code → qwen/qwen3-32b    (Groq)
 *   heavy/long → llama-3.3-70b-versatile (Groq)
 *   hard reasoning → qwen3-235b-a22b:free (OpenRouter)
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
// MODEL TIERS
// ─────────────────────────────────────────────────────────────────────────────

// Groq models
const MODEL_TINY    = process.env.GROQ_TINY_MODEL    || "llama-3.1-8b-instant";
const MODEL_DEFAULT = process.env.GROQ_DEFAULT_MODEL || "qwen/qwen3-32b";
const MODEL_STRONG  = process.env.GROQ_STRONG_MODEL  || "llama-3.3-70b-versatile";

// Kept for back-compat exports
const FAST_MODEL  = MODEL_DEFAULT;
const SMART_MODEL = MODEL_STRONG;

// OpenRouter reasoning model — only for hard prompts
const OR_REASONING_MODEL = "qwen/qwen3-235b-a22b:free";

// OpenRouter fallback pool (ordered)
const OR_FALLBACK_MODELS = [
  "deepseek/deepseek-chat-v3-0324:free",
  "google/gemma-3-27b-it:free",
  "meta-llama/llama-3.3-70b-instruct:free",
];

// ─────────────────────────────────────────────────────────────────────────────
// PROVIDER HEALTH / COOLDOWN
// ─────────────────────────────────────────────────────────────────────────────

const _providerCooldown = new Map();
const PROVIDER_COOL_MS  = 60_000;

function _isProviderCooling(name) {
  const until = _providerCooldown.get(name);
  return until && Date.now() < until;
}

function _coolProvider(name, ms = PROVIDER_COOL_MS) {
  _providerCooldown.set(name, Date.now() + ms);
  console.warn(`[ai.core] Provider ${name} in cooldown for ${ms / 1000}s`);
}

// ─────────────────────────────────────────────────────────────────────────────
// RETRY HELPER
// ─────────────────────────────────────────────────────────────────────────────

const NO_RETRY_CODES = new Set([401, 402, 403, 404]);

async function withRetry(fn, retries = 2, delayMs = 500) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg  = err?.message || "";
      const code = err?.response?.status || 0;
      // Hard-stop: never retry auth/not-found/credit errors
      if (NO_RETRY_CODES.has(code)) throw err;
      if (msg.includes("401") || msg.includes("403") || msg.includes("404") || msg.includes("402")) throw err;
      if (i === retries) throw err;
      const wait = (msg.includes("429") || code === 429)
        ? delayMs * 6 * (i + 1)
        : delayMs * (i + 1);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROMPT COMPLEXITY CLASSIFIER
// Returns "tiny" | "normal" | "heavy" | "reasoning"
// ─────────────────────────────────────────────────────────────────────────────

function classifyPromptComplexity(messages) {
  const lastUser = [...messages].reverse().find(m => m.role === "user");
  const text = (lastUser?.content || "").toLowerCase();
  const len  = text.length;

  const REASONING_SIGNALS = [
    /\b(architect|design system|complex|algorithm|optimize|debug.*hard|explain.*deep|why does|how does.*work|proof|derive|formal|specification)\b/,
    /\b(refactor.*entire|redesign|overhaul|best approach for|trade-off|compare.*approaches)\b/,
  ];
  if (len > 1500 || REASONING_SIGNALS.some(r => r.test(text))) return "reasoning";

  const HEAVY_SIGNALS = [
    /\b(generate|build|create|write|implement|code|develop|make)\b/,
    /\b(full.*app|entire|complete|all files|every file|project)\b/,
  ];
  if (len > 600 || HEAVY_SIGNALS.some(r => r.test(text))) return "heavy";

  if (len < 120 && !/\b(code|build|generate|implement|write)\b/.test(text)) return "tiny";

  return "normal";
}

function _selectGroqModel(complexity) {
  switch (complexity) {
    case "tiny":      return MODEL_TINY;
    case "reasoning": return MODEL_STRONG; // Groq first for reasoning too (faster)
    case "heavy":     return MODEL_STRONG;
    default:          return MODEL_DEFAULT;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NORMALISE MESSAGES
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
// GROQ CALLER
// ─────────────────────────────────────────────────────────────────────────────

async function _callGroq(model, combined, temperature, maxTokens) {
  if (!process.env.GROQ_API_KEY || _isProviderCooling("groq")) return null;
  try {
    const res = await withRetry(() =>
      axios.post("https://api.groq.com/openai/v1/chat/completions", {
        model,
        messages:   combined,
        temperature,
        max_tokens: maxTokens,
      }, {
        headers: {
          Authorization:  `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 12000,
      })
    );
    const content = res.data?.choices?.[0]?.message?.content;
    if (content) return content;
    return null;
  } catch (err) {
    const code = err?.response?.status;
    if (code === 401 || code === 403) {
      _coolProvider("groq", 300_000);
    } else if (code === 429) {
      _coolProvider("groq", 15_000);
    }
    console.error(`[ai.core] Groq ${model} failed: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OPENROUTER CALLER
// ─────────────────────────────────────────────────────────────────────────────

async function _callOpenRouter(model, combined, temperature, maxTokens) {
  if (!process.env.OPENROUTER_API_KEY || _isProviderCooling("openrouter")) return null;
  try {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      { model, messages: combined, temperature, max_tokens: maxTokens },
      {
        headers: {
          Authorization:  `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 20000,
      }
    );
    const content = res.data?.choices?.[0]?.message?.content;
    return content || null;
  } catch (err) {
    const code = err?.response?.status;
    if (code === 401 || code === 403) {
      _coolProvider("openrouter", 300_000);
    } else if (code === 429) {
      _coolProvider("openrouter", 15_000);
    }
    console.error(`[ai.core] OpenRouter ${model} failed: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GEMINI CALLER
// ─────────────────────────────────────────────────────────────────────────────

async function _callGemini(combined, temperature, maxTokens) {
  const _geminiKey = process.env.Gemini_API_Key || process.env.GEMINI_API_KEY;
  if (!_geminiKey || _isProviderCooling("gemini")) return null;
  const geminiModels = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-1.5-flash-002"];
  const userText   = combined.filter(m => m.role !== "system").map(m => typeof m.content === "string" ? m.content : "").join("\n");
  const systemText = combined.filter(m => m.role === "system").map(m => m.content).join("\n");
  for (const gm of geminiModels) {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${gm}:generateContent?key=${_geminiKey}`,
        {
          contents:         [{ parts: [{ text: `${systemText}\n\nUser: ${userText}` }] }],
          generationConfig: { temperature, maxOutputTokens: maxTokens },
        },
        { timeout: 18000 }
      );
      const content = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (content) return content;
    } catch (err) {
      const code = err?.response?.status;
      if (code === 401 || code === 403) { _coolProvider("gemini", 300_000); return null; }
      console.error(`[ai.core] Gemini ${gm} failed: ${err.message}`);
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// generateAI  — smart routing: Groq → OpenRouter → Gemini
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Array<{role:string,content:string}>} messages
 * @param {{ temperature?:number, maxTokens?:number, model?:string }} opts
 * @returns {Promise<string>}
 */
async function generateAI(messages, opts = {}) {
  const { temperature = 0.7, maxTokens = 1024 } = opts;
  const { systemMsg, nonSystem } = _normalise(messages);
  const combined = [...systemMsg, ...nonSystem];

  const complexity   = classifyPromptComplexity(messages);
  const groqModel    = opts.model || _selectGroqModel(complexity);

  // ── 1. Groq — primary fast inference ─────────────────────────────────────
  if (process.env.GROQ_API_KEY) {
    // For reasoning complexity try strong model first, then default
    const groqCandidates = complexity === "reasoning"
      ? [MODEL_STRONG, MODEL_DEFAULT]
      : [groqModel];

    for (const gm of groqCandidates) {
      const result = await _callGroq(gm, combined, temperature, maxTokens);
      if (result) return result;
    }
  }

  // ── 2. OpenRouter — reasoning model for hard prompts, else fallbacks ──────
  if (process.env.OPENROUTER_API_KEY) {
    // Hard reasoning → try dedicated 235b model first
    if (complexity === "reasoning") {
      const result = await _callOpenRouter(OR_REASONING_MODEL, combined, temperature, maxTokens);
      if (result) return result;
    }
    // Fallback pool
    for (const orModel of OR_FALLBACK_MODELS) {
      const result = await _callOpenRouter(orModel, combined, temperature, maxTokens);
      if (result) return result;
    }
  }

  // ── 3. Gemini — last resort ───────────────────────────────────────────────
  const gemResult = await _callGemini(combined, temperature, maxTokens);
  if (gemResult) return gemResult;

  return "⚠️ All AI services are currently unavailable. Please check your API keys and try again.";
}

// ─────────────────────────────────────────────────────────────────────────────
// generateImage  — Pollinations primary (free, no auth)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} prompt
 * @param {object} opts
 * @returns {Promise<string|null>}  image URL or null
 */
async function generateImage(prompt, opts = {}) {
  try {
    const encoded = encodeURIComponent((prompt || "").trim().slice(0, 500));
    const seed = Math.floor(Math.random() * 999999);
    return `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&seed=${seed}&nologo=true&enhance=true`;
  } catch (err) {
    console.error(`[ai.core] Image generation failed: ${err.message}`);
    return null;
  }
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
        }
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

module.exports = {
  generateAI,
  generateImage,
  generateSearch,
  FAST_MODEL,
  SMART_MODEL,
  MODEL_TINY,
  MODEL_DEFAULT,
  MODEL_STRONG,
  classifyPromptComplexity,
};