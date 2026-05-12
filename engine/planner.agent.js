"use strict";

/**
 * engine/planner.agent.js — AQUIPLEX PROJECT PLANNER AGENT
 *
 * Runs BEFORE any code generation. Produces a deterministic, structured
 * architecture plan that drives all downstream agents.
 *
 * Plan schema:
 * {
 *   meta:         { title, description, type, complexity }
 *   stack:        { framework, runtime, database, auth, styling, deployment }
 *   files:        [{ path, role, dependencies }]
 *   routes:       [{ path, method, handler, auth }]        — backend
 *   pages:        [{ route, component, purpose }]          — frontend
 *   components:   [{ name, purpose, props }]
 *   dependencies: { runtime: [], devDependencies: [] }
 *   envVars:      [{ key, description, required }]
 *   deployment:   { target, port, buildCmd, startCmd }
 *   designSystem: { primaryColor, accentColor, fontPrimary, theme }
 * }
 */

const ai  = require("./ai.core");
const { createLogger } = require("../utils/logger");
const log = createLogger("PLANNER");

// ─────────────────────────────────────────────────────────────────────────────
// PROJECT TYPE DETECTION (local — no AI needed)
// ─────────────────────────────────────────────────────────────────────────────

const TYPE_PATTERNS = [
  { type: "saas",        re: /\b(saas|landing|startup|product page|pricing|waitlist|marketing)\b/i },
  { type: "dashboard",   re: /\b(dashboard|analytics|admin|metrics|kpi|stats|reporting)\b/i },
  { type: "ecommerce",   re: /\b(store|shop|ecommerce|marketplace|cart|product listing)\b/i },
  { type: "game",        re: /\b(game|arcade|puzzle|platformer|chess|snake|tetris|pong)\b/i },
  { type: "portfolio",   re: /\b(portfolio|personal site|resume|cv|hire me|freelancer)\b/i },
  { type: "blog",        re: /\b(blog|article|magazine|news|journal)\b/i },
  { type: "tool",        re: /\b(tool|calculator|converter|generator|formatter|checker|timer)\b/i },
  { type: "api",         re: /\b(rest api|graphql|backend api|api server|express api)\b/i },
  { type: "chat",        re: /\b(chat app|messaging|realtime|socket|chatroom)\b/i },
  { type: "fullstack",   re: /\b(fullstack|full.stack|node.*react|express.*react|next\.?js)\b/i },
];

function detectProjectType(prompt) {
  for (const { type, re } of TYPE_PATTERNS) {
    if (re.test(prompt)) return type;
  }
  return "webapp";
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPLEXITY ESTIMATION (local)
// ─────────────────────────────────────────────────────────────────────────────

function estimateComplexity(prompt) {
  const p = (prompt || "").toLowerCase();
  const highSignals = [
    "auth", "login", "signup", "database", "api", "realtime",
    "payment", "stripe", "dashboard", "admin", "search", "filter",
    "fullstack", "backend", "mongodb", "mysql", "postgres",
  ];
  const score = highSignals.filter(s => p.includes(s)).length;
  if (score >= 4) return "complex";
  if (score >= 2) return "medium";
  return "simple";
}

// ─────────────────────────────────────────────────────────────────────────────
// STACK DEFAULTS (per project type — fast, no AI)
// ─────────────────────────────────────────────────────────────────────────────

function defaultStack(type, complexity) {
  const stacks = {
    saas:       { framework: "vanilla", runtime: "browser", database: "none", auth: "none", styling: "css", deployment: "netlify" },
    dashboard:  { framework: "vanilla", runtime: "browser", database: "none", auth: "none", styling: "css", deployment: "netlify" },
    portfolio:  { framework: "vanilla", runtime: "browser", database: "none", auth: "none", styling: "css", deployment: "netlify" },
    game:       { framework: "vanilla", runtime: "browser", database: "none", auth: "none", styling: "css", deployment: "netlify" },
    tool:       { framework: "vanilla", runtime: "browser", database: "none", auth: "none", styling: "css", deployment: "netlify" },
    blog:       { framework: "vanilla", runtime: "browser", database: "none", auth: "none", styling: "css", deployment: "netlify" },
    ecommerce:  { framework: "vanilla", runtime: "browser", database: "none", auth: "none", styling: "css", deployment: "netlify" },
    api:        { framework: "express", runtime: "node", database: "mongodb", auth: "jwt", styling: "none", deployment: "railway" },
    chat:       { framework: "express", runtime: "node", database: "mongodb", auth: "session", styling: "css", deployment: "railway" },
    fullstack:  { framework: "express", runtime: "node", database: "mongodb", auth: "session", styling: "css", deployment: "railway" },
    webapp:     { framework: "vanilla", runtime: "browser", database: "none", auth: "none", styling: "css", deployment: "netlify" },
  };
  const base = stacks[type] || stacks.webapp;
  // Upgrade to fullstack for complex projects
  if (complexity === "complex" && base.framework === "vanilla") {
    return { ...base, framework: "express", runtime: "node", database: "mongodb", auth: "session", deployment: "railway" };
  }
  return base;
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE PLAN (per stack — no AI, deterministic)
// ─────────────────────────────────────────────────────────────────────────────

function buildFilePlan(stack, type) {
  const isBrowser = stack.runtime === "browser";
  const isNode    = stack.runtime === "node";

  if (isBrowser) {
    return [
      { path: "index.html",  role: "main_entry",    dependencies: ["style.css", "script.js"] },
      { path: "style.css",   role: "styles",        dependencies: [] },
      { path: "script.js",   role: "main_script",   dependencies: [] },
    ];
  }

  if (isNode) {
    const files = [
      { path: "server.js",          role: "server_entry",    dependencies: ["package.json"] },
      { path: "package.json",       role: "package_config",  dependencies: [] },
      { path: "public/index.html",  role: "frontend_entry",  dependencies: ["public/style.css", "public/script.js"] },
      { path: "public/style.css",   role: "frontend_styles", dependencies: [] },
      { path: "public/script.js",   role: "frontend_script", dependencies: [] },
      { path: ".env.example",       role: "env_template",    dependencies: [] },
      { path: "README.md",          role: "docs",            dependencies: [] },
    ];

    if (type === "api" || type === "chat") {
      files.splice(3, 0, { path: "routes/index.js", role: "api_routes", dependencies: ["server.js"] });
    }

    return files;
  }

  return [
    { path: "index.html", role: "main_entry", dependencies: ["style.css", "script.js"] },
    { path: "style.css",  role: "styles",     dependencies: [] },
    { path: "script.js",  role: "main_script",dependencies: [] },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN SYSTEM (random high-quality set per project type)
// ─────────────────────────────────────────────────────────────────────────────

const DESIGN_SYSTEMS = {
  saas:      [
    { primaryColor: "#0f172a", accentColor: "#6366f1", fontPrimary: "Syne", theme: "dark-modern" },
    { primaryColor: "#ffffff", accentColor: "#7c3aed", fontPrimary: "Plus Jakarta Sans", theme: "light-clean" },
  ],
  dashboard: [
    { primaryColor: "#0f1629", accentColor: "#38bdf8", fontPrimary: "IBM Plex Mono", theme: "glassmorphism" },
    { primaryColor: "#0d0d0d", accentColor: "#d4af37", fontPrimary: "Syne", theme: "luxury-dark" },
  ],
  portfolio: [
    { primaryColor: "#0a0a0f", accentColor: "#6366f1", fontPrimary: "Syne", theme: "dark-elegant" },
    { primaryColor: "#fafafa", accentColor: "#18181b", fontPrimary: "Plus Jakarta Sans", theme: "minimal-light" },
  ],
  game:      [
    { primaryColor: "#050510", accentColor: "#00ffff", fontPrimary: "IBM Plex Mono", theme: "cyberpunk-neon" },
    { primaryColor: "#000000", accentColor: "#ff6b35", fontPrimary: "Syne", theme: "retro-arcade" },
  ],
  tool:      [
    { primaryColor: "#0d0d0d", accentColor: "#22d3ee", fontPrimary: "IBM Plex Mono", theme: "dark-terminal" },
  ],
  ecommerce: [
    { primaryColor: "#ffffff", accentColor: "#f97316", fontPrimary: "Plus Jakarta Sans", theme: "clean-commerce" },
  ],
};

function getDesignSystem(type) {
  const options = DESIGN_SYSTEMS[type] || DESIGN_SYSTEMS.saas;
  return options[Math.floor(Math.random() * options.length)];
}

// ─────────────────────────────────────────────────────────────────────────────
// AI ENRICHMENT (optional — enhances plan with project-specific details)
// ─────────────────────────────────────────────────────────────────────────────

async function enrichPlanWithAI(basePlan, prompt) {
  const SYSTEM = `You are a software architect. Given a project prompt and base plan, return ONLY a JSON object with these fields:
{
  "title": "project title (3-5 words)",
  "description": "one sentence description",
  "components": ["list", "of", "UI", "components"],
  "features": ["key", "feature", "1", "feature 2"],
  "pages": [{"route": "/", "purpose": "landing page"}],
  "envVars": [{"key": "PORT", "description": "Server port", "required": false}]
}
Return ONLY valid JSON. No markdown. No explanation.`;

  const USER = `Prompt: "${prompt.slice(0, 500)}"
Type: ${basePlan.meta.type}
Stack: ${basePlan.stack.framework}/${basePlan.stack.runtime}`;

  try {
    const raw = await ai.generateAI(
      [{ role: "system", content: SYSTEM }, { role: "user", content: USER }],
      { temperature: 0.3, maxTokens: 600 }
    );

    const match = (raw || "").replace(/```json|```/g, "").trim().match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON in AI response");
    const parsed = JSON.parse(match[0]);
    return parsed;
  } catch (err) {
    log.warn(`AI enrichment failed: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PLANNER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * createProjectPlan
 * @param {string} prompt — user's natural language project description
 * @param {object} options
 * @param {boolean} options.skipAI — skip AI enrichment (faster, for tests)
 * @returns {Promise<object>} — structured plan JSON
 */
async function createProjectPlan(prompt, options = {}) {
  const startMs    = Date.now();
  const type       = detectProjectType(prompt);
  const complexity = estimateComplexity(prompt);
  const stack      = defaultStack(type, complexity);
  const files      = buildFilePlan(stack, type);
  const design     = getDesignSystem(type);

  const basePlan = {
    meta: {
      title:       prompt.slice(0, 50).trim(),
      description: prompt.slice(0, 120).trim(),
      type,
      complexity,
      createdAt:   new Date().toISOString(),
    },
    stack,
    files,
    pages:       [],
    routes:      [],
    components:  [],
    features:    [],
    dependencies: {
      runtime:    stack.runtime === "node" ? ["express"] : [],
      dev:        [],
    },
    envVars:     stack.runtime === "node"
      ? [
          { key: "PORT",       description: "Server port (default: 3000)", required: false },
          { key: "MONGO_URI",  description: "MongoDB connection string",   required: stack.database === "mongodb" },
          { key: "SESSION_SECRET", description: "Express session secret",  required: stack.auth === "session" },
        ].filter(e => e.required || stack.auth !== "none")
      : [],
    deployment: {
      target:   stack.deployment,
      port:     3000,
      buildCmd: stack.runtime === "node" ? "npm install" : "",
      startCmd: stack.runtime === "node" ? "node server.js" : "",
    },
    designSystem: design,
  };

  // AI enrichment (adds title, components, pages, features, envVars)
  if (!options.skipAI) {
    const enriched = await enrichPlanWithAI(basePlan, prompt);
    if (enriched) {
      if (enriched.title)       basePlan.meta.title       = enriched.title;
      if (enriched.description) basePlan.meta.description = enriched.description;
      if (enriched.components)  basePlan.components       = enriched.components;
      if (enriched.features)    basePlan.features         = enriched.features;
      if (enriched.pages)       basePlan.pages            = enriched.pages;
      if (enriched.envVars)     basePlan.envVars          = [...basePlan.envVars, ...enriched.envVars];
    }
  }

  const durationMs = Date.now() - startMs;
  log.info(`Plan created for "${basePlan.meta.title}" [${type}/${complexity}] in ${durationMs}ms`);

  return basePlan;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  createProjectPlan,
  detectProjectType,
  estimateComplexity,
  defaultStack,
};
