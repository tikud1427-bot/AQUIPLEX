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

// Groq models (confirmed active)
const MODEL_TINY    = process.env.GROQ_TINY_MODEL    || "llama-3.1-8b-instant";
const MODEL_DEFAULT = process.env.GROQ_DEFAULT_MODEL || "llama-3.3-70b-versatile"; // qwen3-32b has 6k TPM limit → use 70b as default
const MODEL_STRONG  = process.env.GROQ_STRONG_MODEL  || "llama-3.3-70b-versatile";

// Kept for back-compat exports
const FAST_MODEL  = MODEL_DEFAULT;
const SMART_MODEL = MODEL_STRONG;

// OpenRouter: no longer using qwen3-235b (404). Use llama-3.3-70b-instruct:free for reasoning.
const OR_REASONING_MODEL = "meta-llama/llama-3.3-70b-instruct:free";

// OpenRouter fallback pool — only confirmed-live models
// REMOVED: mistralai/mistral-7b-instruct:free (404 as of May 2026)
// REMOVED: google/gemma-3-9b-it:free (400 invalid model ID)
// REMOVED: qwen3-235b-a22b:free (404), deepseek-chat-v3-0324:free (404), gemma-3-27b-it:free (404)
const OR_FALLBACK_MODELS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  // Note: llama-3.1-8b-instruct:free and phi-3-mini:free return 404 on OpenRouter free tier
  // Only keep the one confirmed working model; add more only after verifying
];

// ─────────────────────────────────────────────────────────────────────────────
// PROVIDER HEALTH / COOLDOWN
// ─────────────────────────────────────────────────────────────────────────────

const _providerCooldown   = new Map(); // name → { until, failures }
const PROVIDER_COOL_MS    = 60_000;

// ── Async generation queue — limits concurrent AI calls to avoid 429 bursts ──
const MAX_PARALLEL_GEN    = 2;
let   _activeGenCalls     = 0;
const _genQueue           = [];

function _enqueueGenCall(fn) {
  return new Promise((resolve, reject) => {
    _genQueue.push({ fn, resolve, reject });
    _drainGenQueue();
  });
}

function _drainGenQueue() {
  while (_activeGenCalls < MAX_PARALLEL_GEN && _genQueue.length > 0) {
    const { fn, resolve, reject } = _genQueue.shift();
    _activeGenCalls++;
    fn()
      .then(resolve, reject)
      .finally(() => { _activeGenCalls--; _drainGenQueue(); });
  }
}

function _isProviderCooling(name) {
  const entry = _providerCooldown.get(name);
  if (!entry) return false;
  if (Date.now() >= entry.until) return false;
  return true;
}

function _coolProvider(name, ms = PROVIDER_COOL_MS) {
  const entry   = _providerCooldown.get(name) || { until: 0, failures: 0 };
  entry.failures = (entry.failures || 0) + 1;
  // Escalating backoff: each consecutive 429 doubles the cooldown, cap 5min
  const escalated = Math.min(ms * Math.pow(1.5, entry.failures - 1), 300_000);
  entry.until = Date.now() + escalated;
  _providerCooldown.set(name, entry);
  console.warn(`[router] ${name} cooldown activated (${Math.round(escalated / 1000)}s) — failure #${entry.failures}`);
}

function _providerRecovered(name) {
  const entry = _providerCooldown.get(name);
  if (entry) { entry.failures = Math.max(0, (entry.failures || 1) - 1); }
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
    if (content) { _providerRecovered("groq"); return content; }
    return null;
  } catch (err) {
    const code = err?.response?.status;
    if (code === 401 || code === 403) {
      _coolProvider("groq", 300_000);
    } else if (code === 429) {
      _coolProvider("groq", PROVIDER_COOL_MS); // 60s base, escalating
    } else if (code === 408 || err.code === "ECONNABORTED") {
      _coolProvider("groq", 30_000); // timeout cooldown
    }
    console.error(`[ai.core] Groq ${model} failed (${code || err.code || "unknown"}): ${err.message}`);
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
    if (content) { _providerRecovered("openrouter"); return content; }
    return null;
  } catch (err) {
    const code = err?.response?.status;
    if (code === 401 || code === 403) {
      _coolProvider("openrouter", 300_000);
    } else if (code === 429) {
      _coolProvider("openrouter", PROVIDER_COOL_MS);
    } else if (code === 408 || err.code === "ECONNABORTED") {
      _coolProvider("openrouter", 30_000);
    }
    console.error(`[ai.core] OpenRouter ${model} failed (${code || err.code || "unknown"}): ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GEMINI CALLER
// ─────────────────────────────────────────────────────────────────────────────

async function _callGemini(combined, temperature, maxTokens) {
  const _geminiKey = process.env.Gemini_API_Key || process.env.GEMINI_API_KEY;
  if (!_geminiKey || _isProviderCooling("gemini")) return null;
  const geminiModels = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.0-flash-lite"];
  // REMOVED: gemini-1.5-flash-002 → deprecated 404
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
  // Route through queue to cap concurrent AI calls (prevents 429 burst)
  return _enqueueGenCall(() => _generateAIInner(messages, opts));
}

async function _generateAIInner(messages, opts = {}) {
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

  // TASK 1 FIX: THROW — never silently return error string as file content.
  // Agent orchestrator catches this and surfaces real failure to user.
  throw new Error("ALL_PROVIDERS_FAILED: All AI providers are unavailable or rate-limited. Check API keys.");
}

// ─────────────────────────────────────────────────────────────────────────────
// generateImage  — verified multi-provider image chain
// ─────────────────────────────────────────────────────────────────────────────

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function _isImageResponse(resp) {
  const ct = String(resp?.headers?.["content-type"] || "").toLowerCase();
  const len = Buffer.isBuffer(resp?.data) ? resp.data.length : Buffer.byteLength(resp?.data || "");
  return ct.startsWith("image/") && len > 1000;
}

function _dataUrlFromImageResponse(resp) {
  if (!_isImageResponse(resp)) {
    const ct = resp?.headers?.["content-type"] || "unknown";
    const len = Buffer.isBuffer(resp?.data) ? resp.data.length : Buffer.byteLength(resp?.data || "");
    throw new Error(`invalid image response content-type=${ct} bytes=${len}`);
  }
  const ct = resp.headers["content-type"];
  return `data:${ct};base64,${Buffer.from(resp.data).toString("base64")}`;
}

function _validBase64Image(b64) {
  if (!b64 || typeof b64 !== "string" || b64.length < 1200) return false;
  try {
    return Buffer.from(b64, "base64").length > 1000;
  } catch {
    return false;
  }
}

function _hashPrompt(text) {
  let hash = 2166136261;
  for (const ch of String(text || "")) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function _escapeXML(value) {
  return String(value || "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[ch]));
}

function _proceduralPromptImage(prompt, providerErrors = []) {
  const hash = _hashPrompt(prompt);
  const hueA = hash % 360;
  const hueB = (hueA + 128) % 360;
  const hueC = (hueA + 248) % 360;
  const words = String(prompt || "Generated image")
    .replace(/[^a-z0-9\s-]/gi, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 9);
  const title = words.slice(0, 5).join(" ") || "Generated image";
  const chips = words.slice(0, 7).map((word, index) => {
    const x = 84 + (index % 3) * 284;
    const y = 700 + Math.floor(index / 3) * 54;
    return `<g><rect x="${x}" y="${y}" width="230" height="34" rx="17" fill="rgba(255,255,255,0.14)" stroke="rgba(255,255,255,0.22)"/><text x="${x + 115}" y="${y + 22}" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="15" fill="#f8fafc">${_escapeXML(word)}</text></g>`;
  }).join("");
  const nodes = Array.from({ length: 18 }).map((_, index) => {
    const x = 80 + ((hash >> (index % 16)) + index * 97) % 860;
    const y = 120 + ((hash >> ((index + 5) % 16)) + index * 71) % 520;
    const r = 18 + ((hash + index * 19) % 54);
    const opacity = (0.11 + ((index % 5) * 0.035)).toFixed(3);
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="hsl(${(hueA + index * 23) % 360} 88% 62%)" opacity="${opacity}"/>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="${_escapeXML(prompt)}">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="hsl(${hueA} 78% 18%)"/>
      <stop offset="54%" stop-color="#101827"/>
      <stop offset="100%" stop-color="hsl(${hueB} 80% 16%)"/>
    </linearGradient>
    <radialGradient id="core" cx="50%" cy="46%" r="48%">
      <stop offset="0%" stop-color="hsl(${hueC} 90% 66%)" stop-opacity="0.92"/>
      <stop offset="58%" stop-color="hsl(${hueB} 86% 52%)" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="transparent"/>
    </radialGradient>
    <filter id="soft"><feGaussianBlur stdDeviation="18"/></filter>
  </defs>
  <rect width="1024" height="1024" fill="url(#bg)"/>
  <rect width="1024" height="1024" fill="url(#core)"/>
  <g filter="url(#soft)">${nodes}</g>
  <path d="M138 606 C280 512 354 666 486 558 C626 444 704 562 888 430" fill="none" stroke="rgba(255,255,255,0.26)" stroke-width="12" stroke-linecap="round"/>
  <path d="M154 438 C302 300 424 442 526 318 C646 172 738 286 876 190" fill="none" stroke="hsl(${hueC} 90% 66%)" stroke-opacity="0.48" stroke-width="7" stroke-linecap="round"/>
  <g transform="translate(512 438)">
    <circle r="142" fill="rgba(255,255,255,0.10)" stroke="rgba(255,255,255,0.24)" stroke-width="2"/>
    <path d="M-76 24 L-18 -70 L68 -58 L96 26 L28 90 L-58 76 Z" fill="hsl(${hueC} 88% 60%)" opacity="0.86"/>
    <path d="M-18 -70 L28 90 M68 -58 L-58 76 M-76 24 L96 26" stroke="rgba(15,23,42,0.42)" stroke-width="10" stroke-linecap="round"/>
  </g>
  <text x="512" y="650" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="44" font-weight="800" fill="#ffffff">${_escapeXML(title)}</text>
  <text x="512" y="688" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="17" fill="rgba(248,250,252,0.76)">Prompt-specific generated visual</text>
  ${chips}
</svg>`;
  const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  return { url, provider: "Aquiplex Procedural Renderer", fallback: true, providerErrors };
}

async function _withImageRetries(providerName, attempts, fn, errors) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const status = err.response?.status ? `HTTP ${err.response.status}` : (err.code || "");
      const message = `${providerName} attempt ${attempt}/${attempts} failed: ${status} ${err.message}`.trim();
      errors.push(message);
      console.warn(`[ai.core] generateImage: ${message}`);
      if (attempt < attempts) await _sleep(500 * attempt);
    }
  }
  throw lastErr || new Error(`${providerName} failed`);
}

async function _downloadVerifiedImage(url, timeout = 30000) {
  const resp = await axios.get(url, {
    responseType: "arraybuffer",
    timeout,
    headers: { "User-Agent": "AquiplexServer/1.0" },
    validateStatus: s => s >= 200 && s < 300,
  });
  return _dataUrlFromImageResponse(resp);
}

/**
 * generateImage — robust fallback chain, never returns unverified URLs.
 * Order: Pollinations (fetch+verify) → HuggingFace Inference → OpenRouter flux-schnell → Gemini Imagen 3
 *
 * @param {string} prompt
 * @param {object} opts
 * @returns {Promise<{url:string, provider:string}>}
 */
async function generateImage(prompt, opts = {}) {
  const safePrompt = (prompt || "").trim().slice(0, 500) || "abstract digital art";
  const encoded    = encodeURIComponent(safePrompt);
  const errors     = [];

  // ── Provider 1: Pollinations — fetch & verify (avoids 402/empty body issues) ──
  try {
    return await _withImageRetries("Pollinations", opts.pollinationsAttempts || 3, async () => {
      const seed = Math.floor(Math.random() * 999999);
      const url  = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&seed=${seed}&nologo=true&enhance=true`;
      return { url: await _downloadVerifiedImage(url, opts.timeout || 30000), provider: "Pollinations" };
    }, errors);
  } catch (err) {
    // Continue provider chain.
  }

  // ── Provider 2: HuggingFace Inference Providers (free tier) ──
  const hfKey = process.env.HF_TOKEN || process.env.HUGGINGFACE_API_KEY;
  if (hfKey) {
    const hfModels = [
      "black-forest-labs/FLUX.1-schnell",
      "stabilityai/stable-diffusion-xl-base-1.0",
    ];
    for (const model of hfModels) {
      try {
        return await _withImageRetries(`HuggingFace ${model}`, opts.hfAttempts || 2, async () => {
          const resp = await axios.post(
            `https://api-inference.huggingface.co/models/${model}`,
            { inputs: safePrompt },
            {
              headers: {
                Authorization: `Bearer ${hfKey}`,
                "Content-Type": "application/json",
              },
              responseType: "arraybuffer",
              timeout: opts.hfTimeout || 60000,
              validateStatus: s => s >= 200 && s < 300,
            }
          );
          return { url: _dataUrlFromImageResponse(resp), provider: `HuggingFace (${model.split("/")[1]})` };
        }, errors);
      } catch (err) {
        // Try next HF model / provider.
      }
    }
  }

  // ── Provider 3: OpenRouter — flux-schnell (free, uses existing key) ──
  if (process.env.OPENROUTER_API_KEY) {
    try {
      return await _withImageRetries("OpenRouter flux-schnell", opts.openRouterAttempts || 2, async () => {
        const resp = await axios.post(
          "https://openrouter.ai/api/v1/images/generations",
          { model: "black-forest-labs/flux-schnell", prompt: safePrompt, n: 1, size: "1024x1024" },
          {
            headers: {
              Authorization:  `Bearer ${process.env.OPENROUTER_API_KEY}`,
              "Content-Type": "application/json",
              "HTTP-Referer":  process.env.APP_URL || "https://aquiplex.com",
            },
            timeout: opts.openRouterTimeout || 45000,
            validateStatus: s => s >= 200 && s < 300,
          }
        );
        const imageUrl = resp.data?.data?.[0]?.url;
        const b64Json  = resp.data?.data?.[0]?.b64_json;
        if (imageUrl) return { url: await _downloadVerifiedImage(imageUrl, 30000), provider: "Flux Schnell (OpenRouter)" };
        if (_validBase64Image(b64Json)) return { url: `data:image/png;base64,${b64Json}`, provider: "Flux Schnell (OpenRouter)" };
        throw new Error("OpenRouter returned no verified image payload");
      }, errors);
    } catch (err) {
      // Continue provider chain.
    }
  }

  // ── Provider 4: Gemini image models / Imagen 4 (last network resort, if key present) ──
  const geminiKey = process.env.Gemini_API_Key || process.env.GEMINI_API_KEY;
  if (geminiKey) {
    const geminiImageModels = [
      "gemini-2.5-flash-image",
      "gemini-3.1-flash-image",
      "gemini-3-pro-image",
      "nano-banana-pro-preview",
    ];
    for (const model of geminiImageModels) {
      try {
        return await _withImageRetries(`Gemini ${model}`, opts.geminiAttempts || 1, async () => {
          const resp = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
            {
              contents: [{ role: "user", parts: [{ text: `Generate an image: ${safePrompt}` }] }],
              generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
            },
            { headers: { "Content-Type": "application/json" }, timeout: opts.geminiTimeout || 60000, validateStatus: s => s >= 200 && s < 300 }
          );
          const parts = resp.data?.candidates?.[0]?.content?.parts || [];
          const imagePart = parts.find(part => part.inlineData?.data && /^image\//i.test(part.inlineData?.mimeType || ""));
          const b64data = imagePart?.inlineData?.data;
          const mimeType = imagePart?.inlineData?.mimeType || "image/png";
          if (_validBase64Image(b64data)) return { url: `data:${mimeType};base64,${b64data}`, provider: `Gemini ${model}` };
          throw new Error("Gemini generateContent returned no verified image payload");
        }, errors);
      } catch {
        // Try next Gemini image model.
      }
    }

    const imagenModels = ["imagen-4.0-fast-generate-001", "imagen-4.0-generate-001", "imagen-4.0-ultra-generate-001"];
    for (const model of imagenModels) {
      try {
        return await _withImageRetries(`Gemini ${model}`, opts.geminiAttempts || 1, async () => {
          const resp = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${geminiKey}`,
            { instances: [{ prompt: safePrompt }], parameters: { sampleCount: 1, aspectRatio: "1:1" } },
            { headers: { "Content-Type": "application/json" }, timeout: opts.geminiTimeout || 60000, validateStatus: s => s >= 200 && s < 300 }
          );
          const b64data  = resp.data?.predictions?.[0]?.bytesBase64Encoded;
          const mimeType = resp.data?.predictions?.[0]?.mimeType || "image/png";
          if (_validBase64Image(b64data) && /^image\//i.test(mimeType)) {
            return { url: `data:${mimeType};base64,${b64data}`, provider: `Gemini ${model}` };
          }
          throw new Error("Imagen returned no verified image payload");
        }, errors);
      } catch {
        // Try next Imagen model.
      }
    }
  }

  if (opts.disableLocalFallback) {
    const error = new Error("IMAGE_GENERATION_FAILED: all image providers failed validation");
    error.code = "IMAGE_GENERATION_FAILED";
    error.providerErrors = errors;
    console.error(`[ai.core] generateImage: ${error.message} | ${errors.join(" | ")}`);
    throw error;
  }

  console.warn(`[ai.core] generateImage: network providers unavailable; using verified local renderer. ${errors.join(" | ")}`);
  return _proceduralPromptImage(safePrompt, errors);
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
