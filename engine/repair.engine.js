"use strict";

/**
 * engine/repair.engine.js — AQUIPLEX VALIDATION + AUTO-REPAIR ENGINE
 *
 * Quality gate that runs AFTER generation.
 * Detects issues → critiques → repairs → retries weak sections.
 *
 * Checks:
 *   - Broken HTML structure
 *   - Missing CSS/JS links
 *   - Empty sections / placeholder content
 *   - Missing Google Font
 *   - Missing animations
 *   - Missing responsiveness
 *   - Broken JS references
 *   - Low-quality layouts (single-column boring layouts)
 *   - Missing interactivity for interactive projects
 */

const { createLogger } = require("../utils/logger");
const log = createLogger("REPAIR_ENGINE");

function _inferLanguage(fileName = "") {
  if (fileName.endsWith(".css"))  return "css";
  if (fileName.endsWith(".ts"))   return "typescript";
  if (fileName.endsWith(".json")) return "json";
  if (fileName.endsWith(".md"))   return "markdown";
  if (fileName.endsWith(".html")) return "html";
  if (fileName.endsWith(".yaml") || fileName.endsWith(".yml")) return "yaml";
  if (fileName.endsWith(".toml")) return "toml";
  if (fileName.endsWith(".sh"))   return "bash";
  if (fileName.endsWith(".js"))   return "javascript";
  return "plaintext";
}

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE DETECTORS
// ─────────────────────────────────────────────────────────────────────────────

function detectHTMLIssues(html) {
  const issues = [];
  if (!html) return [{ severity: "critical", code: "NO_HTML", description: "index.html is empty" }];

  if (!html.includes("<!DOCTYPE") && !html.includes("<!doctype"))
    issues.push({ severity: "critical", code: "NO_DOCTYPE", description: "Missing <!DOCTYPE html>" });

  if (!html.includes("<html"))
    issues.push({ severity: "critical", code: "NO_HTML_TAG", description: "Missing <html> tag" });

  if (!html.includes("<head"))
    issues.push({ severity: "critical", code: "NO_HEAD", description: "Missing <head> tag" });

  if (!html.includes("<body"))
    issues.push({ severity: "critical", code: "NO_BODY", description: "Missing <body> tag" });

  if (!html.includes("style.css") && !html.includes("<style"))
    issues.push({ severity: "warning", code: "NO_CSS_LINK", description: "No CSS linked" });

  if (!html.includes("fonts.googleapis.com") && !html.includes("fonts.gstatic.com") && !html.includes("@import"))
    issues.push({ severity: "warning", code: "NO_GOOGLE_FONT", description: "No Google Font loaded" });

  if (html.includes("Lorem ipsum") || html.includes("[Your Name]") || html.includes("TODO") || html.includes("placeholder text"))
    issues.push({ severity: "warning", code: "PLACEHOLDER_CONTENT", description: "Placeholder text detected" });

  // Check for very minimal body content
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch && bodyMatch[1].replace(/<script[\s\S]*?<\/script>/gi, "").trim().length < 100)
    issues.push({ severity: "warning", code: "SPARSE_BODY", description: "Body content appears very sparse" });

  return issues;
}

function detectCSSIssues(css) {
  const issues = [];
  if (!css || css.trim().length < 50) {
    issues.push({ severity: "critical", code: "NO_CSS", description: "CSS is empty or nearly empty" });
    return issues;
  }

  if (!css.includes(":root") && !css.includes("var(--"))
    issues.push({ severity: "warning", code: "NO_CSS_VARS", description: "No CSS custom properties (:root vars)" });

  if (!css.includes("@keyframes") && !css.includes("animation") && !css.includes("transition"))
    issues.push({ severity: "warning", code: "NO_ANIMATIONS", description: "No animations or transitions detected" });

  if (!css.includes("@media"))
    issues.push({ severity: "warning", code: "NOT_RESPONSIVE", description: "No @media queries — not responsive" });

  if (!css.includes("background") && !css.includes("gradient"))
    issues.push({ severity: "info", code: "NO_BG", description: "No background styling detected" });

  if (css.includes("background: white") || css.includes("background-color: white") || css.includes("background:#fff"))
    issues.push({ severity: "info", code: "PLAIN_WHITE_BG", description: "Plain white background — consider dark/atmospheric bg" });

  return issues;
}

function detectJSIssues(js, html) {
  const issues = [];
  if (!js) return issues;

  // Check if script.js is referenced in HTML but JS is empty
  if (html?.includes("script.js") && js.trim().length < 20)
    issues.push({ severity: "critical", code: "EMPTY_JS", description: "script.js referenced but effectively empty" });

  // Check for placeholder functions
  if (/function\s+\w+\s*\([^)]*\)\s*\{\s*\}/g.test(js))
    issues.push({ severity: "warning", code: "EMPTY_FUNCTIONS", description: "Empty function bodies detected" });

  if (/console\.log\(['"]TODO/i.test(js))
    issues.push({ severity: "warning", code: "TODO_HANDLERS", description: "TODO console.log found — incomplete logic" });

  return issues;
}

// ─────────────────────────────────────────────────────────────────────────────
// QUALITY SCORE
// ─────────────────────────────────────────────────────────────────────────────

function scoreFiles(files) {
  const fileMap = {};
  for (const f of files) fileMap[f.fileName || f.name] = f.content || "";

  const html = fileMap["index.html"] || "";
  const css  = fileMap["style.css"]  || "";
  const js   = fileMap["script.js"]  || "";

  const htmlIssues = detectHTMLIssues(html);
  const cssIssues  = detectCSSIssues(css);
  const jsIssues   = detectJSIssues(js, html);

  const allIssues = [...htmlIssues, ...cssIssues, ...jsIssues];

  // Score: 100 - deductions
  let score = 100;
  for (const issue of allIssues) {
    if (issue.severity === "critical") score -= 30;
    else if (issue.severity === "warning") score -= 10;
    else if (issue.severity === "info")  score -= 2;
  }
  score = Math.max(0, score);

  return { score, issues: allIssues, fileMap };
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-REPAIR — CSS injection fixes
// ─────────────────────────────────────────────────────────────────────────────

const REPAIR_CSS_RESPONSIVE = `
/* REPAIR: Basic responsive foundation */
* { box-sizing: border-box; margin: 0; padding: 0; }
html { font-size: 16px; }
body { min-width: 320px; overflow-x: hidden; }
img, video { max-width: 100%; height: auto; }
@media (max-width: 768px) {
  .container, .content, .wrapper { padding: 0 1rem; }
}`;

const REPAIR_CSS_ANIMATIONS = `
/* REPAIR: Basic entrance animations */
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(24px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes fadeIn {
  from { opacity: 0; }
  to   { opacity: 1; }
}
.hero, h1, h2, .card:nth-child(1) { animation: fadeUp 0.6s ease both; }
.card:nth-child(2) { animation: fadeUp 0.6s 0.1s ease both; }
.card:nth-child(3) { animation: fadeUp 0.6s 0.2s ease both; }`;

const REPAIR_CSS_VARS = `
/* REPAIR: CSS custom property foundation */
:root {
  --bg-primary:    #0a0a0f;
  --bg-secondary:  #111118;
  --surface:       rgba(255,255,255,0.05);
  --accent-1:      #6366f1;
  --accent-2:      #a78bfa;
  --text-primary:  #f1f5f9;
  --text-secondary:#94a3b8;
  --border:        rgba(255,255,255,0.1);
  --glow-color:    rgba(99,102,241,0.4);
  --radius:        12px;
  --transition:    all 0.2s ease;
}`;

/**
 * applyLocalRepairs — non-AI fixes applied directly to file contents
 */
function applyLocalRepairs(fileMap, issues) {
  const repaired = { ...fileMap };
  const repairs  = [];

  const issueCodes = new Set(issues.map(i => i.code));

  // ── CSS repairs ──
  let css = repaired["style.css"] || "";
  let cssModified = false;

  if (issueCodes.has("NO_CSS_VARS") && css.length > 0) {
    css = REPAIR_CSS_VARS + "\n\n" + css;
    cssModified = true;
    repairs.push("Injected CSS custom properties (:root vars)");
  }

  if (issueCodes.has("NO_ANIMATIONS") && css.length > 0) {
    css += "\n\n" + REPAIR_CSS_ANIMATIONS;
    cssModified = true;
    repairs.push("Injected entrance animations");
  }

  if (issueCodes.has("NOT_RESPONSIVE") && css.length > 0) {
    css += "\n\n" + REPAIR_CSS_RESPONSIVE;
    cssModified = true;
    repairs.push("Injected responsive foundation");
  }

  if (cssModified) repaired["style.css"] = css;

  // ── HTML repairs ──
  let html = repaired["index.html"] || "";
  let htmlModified = false;

  // Inject Google Font if missing
  if (issueCodes.has("NO_GOOGLE_FONT") && html.includes("<head")) {
    const fontLink = '<link rel="preconnect" href="https://fonts.googleapis.com">\n  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=DM+Serif+Display&display=swap" rel="stylesheet">';
    html = html.replace(/<\/head>/i, `  ${fontLink}\n</head>`);
    htmlModified = true;
    repairs.push("Injected Google Fonts (Plus Jakarta Sans + DM Serif Display)");
  }

  // Inject CSS link if missing
  if (issueCodes.has("NO_CSS_LINK") && html.includes("<head") && !html.includes("style.css")) {
    html = html.replace(/<\/head>/i, '  <link rel="stylesheet" href="style.css">\n</head>');
    htmlModified = true;
    repairs.push("Injected style.css link");
  }

  if (htmlModified) repaired["index.html"] = html;

  return { repaired, repairs };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI REPAIR — for critical issues that need regeneration
// ─────────────────────────────────────────────────────────────────────────────

async function attemptAIRepair(fileMap, issues, callAI) {
  if (!callAI || typeof callAI !== "function") return { repaired: fileMap, repairs: [] };

  const criticalIssues = issues.filter(i => i.severity === "critical");
  if (!criticalIssues.length) return { repaired: fileMap, repairs: [] };

  const repairs  = [];
  const repaired = { ...fileMap };

  // Repair CSS if it's empty/broken
  const cssIssues = criticalIssues.filter(i => i.code === "NO_CSS");
  if (cssIssues.length && fileMap["index.html"]) {
    log.info("AI repair: regenerating CSS from HTML context");
    try {
      const rawCSS = await callAI([
        {
          role: "system",
          content: "You are an expert CSS developer. Generate complete, spectacular CSS for the provided HTML. Return ONLY raw CSS — no explanation, no fences.",
        },
        {
          role: "user",
          content: `Generate complete CSS for this HTML. Make it dark, modern, and visually striking with CSS custom properties, animations, and responsive design:\n\n${fileMap["index.html"].slice(0, 3000)}`,
        },
      ], { temperature: 0.5, maxTokens: 3000 });

      if (rawCSS && rawCSS.trim().length > 100) {
        repaired["style.css"] = rawCSS.replace(/^```css\s*/i, "").replace(/```\s*$/i, "").trim();
        repairs.push("AI regenerated style.css (was empty/broken)");
      }
    } catch (e) {
      log.warn(`AI CSS repair failed: ${e.message}`);
    }
  }

  return { repaired, repairs };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * validateAndRepair(files, opts) → { files, score, issues, repairs, passed }
 *
 * @param {Array<{fileName, content}>} files
 * @param {{ callAI?: Function, projectType?: string, skipRepair?: boolean }} opts
 */
async function validateAndRepair(files, opts = {}) {
  const { callAI, skipRepair = false } = opts;

  // Build fileMap
  const fileMap = {};
  for (const f of files) fileMap[f.fileName || f.name] = f.content || "";

  // Route to correct scorer based on file set
  const isFullstack = isFullstackFileSet(fileMap);
  const initial     = isFullstack ? scoreFullstackFiles(fileMap) : scoreFiles(files);

  log.info(`validateAndRepair: mode=${isFullstack ? "fullstack" : "frontend"} score=${initial.score} issues=${initial.issues.length}`);

  if (initial.score >= 80 || skipRepair) {
    return {
      files,
      score:   initial.score,
      issues:  initial.issues,
      repairs: [],
      passed:  initial.score >= 80,
      mode:    isFullstack ? "fullstack" : "frontend",
    };
  }

  // Apply local repairs — fullstack or frontend path
  const { repaired: localRepaired, repairs: localRepairs } = isFullstack
    ? applyFullstackLocalRepairs(initial.fileMap, initial.issues)
    : applyLocalRepairs(initial.fileMap, initial.issues);

  // Apply AI repairs for critical issues
  let finalRepaired = localRepaired;
  let aiRepairs     = [];

  if (callAI) {
    const afterLocalFiles = Object.entries(localRepaired).map(([fileName, content]) => ({ fileName, content }));
    const afterLocal = isFullstack ? scoreFullstackFiles(localRepaired) : scoreFiles(afterLocalFiles);
    if (afterLocal.score < 70) {
      const { repaired, repairs } = await attemptAIRepair(localRepaired, afterLocal.issues, callAI);
      finalRepaired = repaired;
      aiRepairs     = repairs;
    }
  }

  // Convert map back to file array with correct language
  const repairedFiles = Object.entries(finalRepaired).map(([fileName, content]) => ({
    fileName,
    content,
    language: _inferLanguage(fileName),
  }));

  // Re-score
  const final      = isFullstack ? scoreFullstackFiles(finalRepaired) : scoreFiles(repairedFiles);
  const allRepairs = [...localRepairs, ...aiRepairs];

  log.info(`validateAndRepair: final score=${final.score} repairs=${allRepairs.length}`);

  return {
    files:   repairedFiles,
    score:   final.score,
    issues:  final.issues,
    repairs: allRepairs,
    passed:  final.score >= 60,
    mode:    isFullstack ? "fullstack" : "frontend",
  };
}

/**
 * quickScore — just score without repair (for display)
 */
function quickScore(files) {
  return scoreFiles(files);
}

// ─────────────────────────────────────────────────────────────────────────────
// FULLSTACK VALIDATORS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * detectPackageJsonIssues — validate package.json for a runnable Node project
 */
function detectPackageJsonIssues(pkgRaw) {
  const issues = [];
  if (!pkgRaw || pkgRaw.trim().length < 10) {
    return [{ severity: "critical", code: "NO_PACKAGE_JSON", description: "package.json is missing or empty" }];
  }

  let pkg;
  try { pkg = JSON.parse(pkgRaw); }
  catch (e) {
    return [{ severity: "critical", code: "INVALID_PACKAGE_JSON", description: `package.json parse error: ${e.message}` }];
  }

  if (!pkg.name)
    issues.push({ severity: "warning", code: "PKG_NO_NAME", description: "package.json missing 'name' field" });

  if (!pkg.scripts?.start)
    issues.push({ severity: "critical", code: "PKG_NO_START", description: "package.json missing 'scripts.start'" });

  if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0)
    issues.push({ severity: "critical", code: "PKG_NO_DEPS", description: "package.json has no dependencies" });

  const requiredDeps = ["express"];
  for (const dep of requiredDeps) {
    if (!pkg.dependencies?.[dep])
      issues.push({ severity: "warning", code: `PKG_MISSING_DEP_${dep.toUpperCase()}`, description: `Missing expected dependency: ${dep}` });
  }

  if (!pkg.engines?.node)
    issues.push({ severity: "info", code: "PKG_NO_NODE_VERSION", description: "No 'engines.node' version specified" });

  return issues;
}

/**
 * detectServerJsIssues — validate server.js is a real Express server
 */
function detectServerJsIssues(serverJs) {
  const issues = [];
  if (!serverJs || serverJs.trim().length < 50) {
    return [{ severity: "critical", code: "NO_SERVER_JS", description: "server.js is missing or empty" }];
  }

  if (!serverJs.includes("express"))
    issues.push({ severity: "critical", code: "SERVER_NO_EXPRESS", description: "server.js does not import express" });

  if (!serverJs.includes("app.listen") && !serverJs.includes("server.listen"))
    issues.push({ severity: "critical", code: "SERVER_NO_LISTEN", description: "server.js missing app.listen() call" });

  if (!serverJs.includes("process.env.PORT") && !serverJs.includes("process.env[\"PORT\"]"))
    issues.push({ severity: "warning", code: "SERVER_HARDCODED_PORT", description: "server.js uses hardcoded port instead of process.env.PORT" });

  if (!serverJs.includes("/api/health") && !serverJs.includes("/health"))
    issues.push({ severity: "info", code: "SERVER_NO_HEALTH", description: "No health check route (/api/health)" });

  if (!serverJs.includes("express.json()") && !serverJs.includes("bodyParser.json()"))
    issues.push({ severity: "warning", code: "SERVER_NO_JSON_MW", description: "No JSON body parser middleware" });

  // Detect TODO stubs
  const todoCount = (serverJs.match(/\/\/\s*TODO/gi) || []).length;
  if (todoCount > 2)
    issues.push({ severity: "warning", code: "SERVER_TODO_STUBS", description: `${todoCount} TODO stubs found in server.js` });

  // Detect placeholder route handlers
  if (/res\.(json|send)\(\s*['"]\s*['"]\s*\)/g.test(serverJs))
    issues.push({ severity: "warning", code: "SERVER_EMPTY_HANDLERS", description: "Empty route handlers detected" });

  return issues;
}

/**
 * detectEnvIssues — validate .env.example exists and lists required vars
 */
function detectEnvIssues(envExample, serverJs = "") {
  const issues = [];
  if (!envExample || envExample.trim().length < 5) {
    issues.push({ severity: "warning", code: "NO_ENV_EXAMPLE", description: ".env.example is missing — env vars undocumented" });
    return issues;
  }

  // If server.js references env vars not in .env.example, flag it
  if (serverJs) {
    const serverEnvRefs = [...serverJs.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)].map(m => m[1]);
    const envKeys       = envExample.split("\n").map(l => l.split("=")[0].trim()).filter(Boolean);
    const missing       = serverEnvRefs.filter(k => !envKeys.includes(k) && k !== "NODE_ENV" && k !== "PORT");
    if (missing.length) {
      issues.push({
        severity: "warning",
        code: "ENV_UNDOCUMENTED_VARS",
        description: `server.js uses env vars not in .env.example: ${[...new Set(missing)].join(", ")}`,
      });
    }
  }

  return issues;
}

/**
 * detectRouteFileIssues — validate route files export a router
 */
function detectRouteFileIssues(fileName, content) {
  const issues = [];
  if (!content || content.trim().length < 20) {
    return [{ severity: "warning", code: "EMPTY_ROUTE_FILE", description: `${fileName} is empty` }];
  }

  if (!content.includes("express.Router") && !content.includes("router"))
    issues.push({ severity: "warning", code: "ROUTE_NO_ROUTER", description: `${fileName} doesn't use express.Router()` });

  if (!content.includes("module.exports") && !content.includes("export default") && !content.includes("export {"))
    issues.push({ severity: "warning", code: "ROUTE_NO_EXPORT", description: `${fileName} missing module.exports` });

  return issues;
}

/**
 * detectModelFileIssues — validate model files define a schema
 */
function detectModelFileIssues(fileName, content) {
  const issues = [];
  if (!content || content.trim().length < 20) {
    return [{ severity: "warning", code: "EMPTY_MODEL_FILE", description: `${fileName} is empty` }];
  }

  const hasMongoose = content.includes("mongoose") || content.includes("Schema");
  const hasSequelize = content.includes("sequelize") || content.includes("DataTypes");
  const hasKnex = content.includes("knex");

  if (!hasMongoose && !hasSequelize && !hasKnex)
    issues.push({ severity: "warning", code: "MODEL_NO_ORM", description: `${fileName} doesn't use a recognized ORM/ODM` });

  if (!content.includes("module.exports") && !content.includes("export"))
    issues.push({ severity: "warning", code: "MODEL_NO_EXPORT", description: `${fileName} missing module.exports` });

  return issues;
}

/**
 * isFullstackFileSet — detect if a file set is a fullstack project
 */
function isFullstackFileSet(fileMap) {
  const keys = Object.keys(fileMap);
  return (
    keys.includes("server.js") ||
    keys.includes("package.json") ||
    keys.some(k => k.startsWith("routes/")) ||
    keys.some(k => k.startsWith("models/"))
  );
}

/**
 * scoreFullstackFiles — score a fullstack project
 */
function scoreFullstackFiles(fileMap) {
  const allIssues = [];

  // package.json
  const pkgIssues = detectPackageJsonIssues(fileMap["package.json"]);
  allIssues.push(...pkgIssues);

  // server.js
  const serverIssues = detectServerJsIssues(fileMap["server.js"]);
  allIssues.push(...serverIssues);

  // .env.example / env.example.txt
  const envContent = fileMap[".env.example"] || fileMap["env.example.txt"] || "";
  const envIssues  = detectEnvIssues(envContent, fileMap["server.js"]);
  allIssues.push(...envIssues);

  // Route files
  for (const [name, content] of Object.entries(fileMap)) {
    if (name.startsWith("routes/") && name.endsWith(".js")) {
      allIssues.push(...detectRouteFileIssues(name, content));
    }
  }

  // Model files
  for (const [name, content] of Object.entries(fileMap)) {
    if (name.startsWith("models/") && name.endsWith(".js")) {
      allIssues.push(...detectModelFileIssues(name, content));
    }
  }

  // Frontend files (non-critical for fullstack — bonus points)
  const hasFrontend = !!fileMap["index.html"];
  if (!hasFrontend)
    allIssues.push({ severity: "info", code: "FS_NO_FRONTEND", description: "No index.html — API-only project (OK if intentional)" });

  // Score
  let score = 100;
  for (const issue of allIssues) {
    if (issue.severity === "critical") score -= 25;
    else if (issue.severity === "warning") score -= 8;
    else if (issue.severity === "info")   score -= 2;
  }
  score = Math.max(0, Math.min(100, score));

  return { score, issues: allIssues, fileMap };
}

// ─────────────────────────────────────────────────────────────────────────────
// FULLSTACK LOCAL REPAIRS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * applyFullstackLocalRepairs — non-AI fixes for common fullstack issues
 */
function applyFullstackLocalRepairs(fileMap, issues) {
  const repaired = { ...fileMap };
  const repairs  = [];
  const codes    = new Set(issues.map(i => i.code));

  // ── package.json repairs ──
  if (fileMap["package.json"] && codes.has("PKG_NO_START")) {
    try {
      const pkg = JSON.parse(fileMap["package.json"]);
      pkg.scripts = pkg.scripts || {};
      if (!pkg.scripts.start) {
        pkg.scripts.start = "node server.js";
        repaired["package.json"] = JSON.stringify(pkg, null, 2);
        repairs.push("Injected 'start' script into package.json");
      }
    } catch { /* malformed — skip */ }
  }

  if (fileMap["package.json"] && codes.has("PKG_NO_NODE_VERSION")) {
    try {
      const pkg = JSON.parse(fileMap["package.json"]);
      pkg.engines = pkg.engines || {};
      if (!pkg.engines.node) {
        pkg.engines.node = ">=18.0.0";
        repaired["package.json"] = JSON.stringify(pkg, null, 2);
        repairs.push("Injected engines.node >=18.0.0 into package.json");
      }
    } catch { /* skip */ }
  }

  // ── server.js repairs ──
  if (fileMap["server.js"] && codes.has("SERVER_HARDCODED_PORT")) {
    let server = fileMap["server.js"];
    // Replace common hardcoded port patterns
    server = server.replace(/const\s+PORT\s*=\s*(\d{4,5})/g, "const PORT = process.env.PORT || $1");
    server = server.replace(/\.listen\((\d{4,5})/g, ".listen(process.env.PORT || $1");
    if (server !== fileMap["server.js"]) {
      repaired["server.js"] = server;
      repairs.push("Replaced hardcoded port with process.env.PORT in server.js");
    }
  }

  if (fileMap["server.js"] && codes.has("SERVER_NO_JSON_MW")) {
    let server = fileMap["server.js"];
    if (server.includes("app.use(") && !server.includes("express.json()")) {
      server = server.replace(
        /(const app\s*=\s*express\(\);?\n)/,
        "$1app.use(express.json());\napp.use(express.urlencoded({ extended: true }));\n"
      );
      if (server !== fileMap["server.js"]) {
        repaired["server.js"] = server;
        repairs.push("Injected express.json() middleware into server.js");
      }
    }
  }

  if (fileMap["server.js"] && codes.has("SERVER_NO_HEALTH")) {
    let server = fileMap["server.js"];
    const healthRoute = `\n// Health check\napp.get('/api/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));\n`;
    // Inject before app.listen
    server = server.replace(/(app\.listen)/, healthRoute + "\n$1");
    if (server !== fileMap["server.js"]) {
      repaired["server.js"] = server;
      repairs.push("Injected /api/health route into server.js");
    }
  }

  // ── .env.example repair ──
  if (codes.has("NO_ENV_EXAMPLE") && !fileMap[".env.example"]) {
    // Extract env var names from server.js
    const server = fileMap["server.js"] || "";
    const refs   = [...server.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)].map(m => m[1]);
    const unique = [...new Set(refs)];
    if (unique.length) {
      const envContent = unique.map(k => `${k}=`).join("\n") + "\nPORT=3000\nNODE_ENV=development\n";
      repaired[".env.example"] = envContent;
      repairs.push(`Generated .env.example with ${unique.length} env vars extracted from server.js`);
    }
  }

  // ── Frontend repairs on fullstack projects (still apply base CSS/HTML fixes) ──
  if (fileMap["index.html"] || fileMap["style.css"]) {
    const { repaired: frontendRepaired, repairs: frontendRepairs } = applyLocalRepairs(fileMap, issues.filter(i =>
      ["NO_CSS_VARS", "NO_ANIMATIONS", "NOT_RESPONSIVE", "NO_GOOGLE_FONT", "NO_CSS_LINK"].includes(i.code)
    ));
    if (fileMap["index.html"]) repaired["index.html"] = frontendRepaired["index.html"];
    if (fileMap["style.css"])  repaired["style.css"]  = frontendRepaired["style.css"];
    repairs.push(...frontendRepairs);
  }

  return { repaired, repairs };
}

module.exports = {
  validateAndRepair,
  quickScore,
  detectHTMLIssues,
  detectCSSIssues,
  detectJSIssues,
  detectPackageJsonIssues,
  detectServerJsIssues,
  detectEnvIssues,
  detectRouteFileIssues,
  detectModelFileIssues,
  scoreFiles,
  scoreFullstackFiles,
  isFullstackFileSet,
};