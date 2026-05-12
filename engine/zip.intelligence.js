"use strict";

/**
 * engine/zip.intelligence.js — AQUIPLEX ZIP CODEBASE INTELLIGENCE
 *
 * Uploads a ZIP → detects framework → parses architecture → understands
 * file relationships → builds indexed context for AI injection.
 *
 * Works with:
 *   - Website/static HTML/CSS/JS projects
 *   - Node.js/Express apps
 *   - React/Vue/Svelte projects
 *   - Python projects
 *   - Any flat or nested ZIP
 */

const fs      = require("fs");
const fsAsync = require("fs").promises;
const path    = require("path");
const { createLogger } = require("../utils/logger");

const log = createLogger("ZIP_INTEL");

// Max sizes to prevent memory blowout
const MAX_EXTRACT_FILES = 40;
const MAX_FILE_BYTES    = 80_000;   // 80KB per file
const MAX_CONTEXT_CHARS = 12_000;   // Total AI context cap

// Text-parseable extensions
const TEXT_EXTS = new Set([
  ".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".json", ".md", ".txt", ".yaml", ".yml", ".env.example", ".sh",
  ".py", ".rb", ".go", ".rs", ".java", ".php", ".cs", ".swift",
  ".sql", ".graphql", ".gql", ".vue", ".svelte",
]);

// ─────────────────────────────────────────────────────────────────────────────
// FRAMEWORK DETECTION
// ─────────────────────────────────────────────────────────────────────────────

function detectFramework(fileNames, fileContents) {
  const names = new Set(fileNames.map(n => n.toLowerCase()));
  const allContent = Object.values(fileContents).join("\n").toLowerCase();

  // Check package.json for deps
  const pkgContent = fileContents["package.json"] || fileContents["package.json (root)"] || "";

  if (pkgContent) {
    if (/"next"/.test(pkgContent))            return "next.js";
    if (/"react"/.test(pkgContent) && /"vite"/.test(pkgContent)) return "react+vite";
    if (/"react"/.test(pkgContent))           return "react";
    if (/"vue"/.test(pkgContent))             return "vue";
    if (/"svelte"/.test(pkgContent))          return "svelte";
    if (/"express"/.test(pkgContent))         return "node+express";
    if (/"fastify"/.test(pkgContent))         return "node+fastify";
    if (/"@angular\/core"/.test(pkgContent))  return "angular";
  }

  if (names.has("requirements.txt") || names.has("setup.py") || names.has("pyproject.toml"))
    return "python";
  if (names.has("go.mod"))   return "golang";
  if (names.has("cargo.toml")) return "rust";
  if (names.has("gemfile"))  return "ruby";

  // Vanilla detection
  if ([...names].some(n => n.endsWith(".html"))) return "vanilla-html";
  return "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE IMPORTANCE RANKING
// ─────────────────────────────────────────────────────────────────────────────

const PRIORITY_FILES = [
  "package.json", "readme.md", "index.html", "index.js", "index.ts",
  "app.js", "app.ts", "main.js", "main.ts", "server.js", "server.ts",
  "style.css", "styles.css", "tailwind.config.js", "vite.config.js",
  "next.config.js", ".env.example", "requirements.txt",
];

function rankFile(filePath) {
  const name = path.basename(filePath).toLowerCase();
  const idx  = PRIORITY_FILES.indexOf(name);
  if (idx !== -1) return 100 - idx;

  const ext = path.extname(name);
  if (ext === ".html") return 60;
  if (ext === ".js" || ext === ".ts") return 50;
  if (ext === ".css") return 45;
  if (ext === ".json") return 40;
  if (ext === ".md")   return 35;
  return 10;
}

// ─────────────────────────────────────────────────────────────────────────────
// ZIP EXTRACTION (uses unzipper or adm-zip, falls back to shell unzip)
// ─────────────────────────────────────────────────────────────────────────────

async function extractZip(zipPath, destDir) {
  // Try unzipper (common in node projects)
  try {
    const unzipper = require("unzipper");
    await new Promise((resolve, reject) => {
      fs.createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: destDir }))
        .on("close", resolve)
        .on("error", reject);
    });
    return true;
  } catch (e1) {
    log.warn(`unzipper failed: ${e1.message}, trying adm-zip`);
  }

  // Try adm-zip
  try {
    const AdmZip = require("adm-zip");
    const zip    = new AdmZip(zipPath);
    zip.extractAllTo(destDir, true);
    return true;
  } catch (e2) {
    log.warn(`adm-zip failed: ${e2.message}, trying shell`);
  }

  // Shell fallback
  try {
    const { execSync } = require("child_process");
    fs.mkdirSync(destDir, { recursive: true });
    execSync(`unzip -q -o "${zipPath}" -d "${destDir}"`, { timeout: 30000 });
    return true;
  } catch (e3) {
    throw new Error(`ZIP extraction failed: ${e3.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RECURSIVE FILE LISTING
// ─────────────────────────────────────────────────────────────────────────────

function listFilesSync(dir, baseDir = dir, results = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return results; }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath  = path.relative(baseDir, fullPath);

    // Skip common junk
    if (/node_modules|\.git|\.DS_Store|__pycache__|\.cache|dist\/|build\//.test(relPath)) continue;

    if (entry.isDirectory()) {
      listFilesSync(fullPath, baseDir, results);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (TEXT_EXTS.has(ext)) results.push(relPath);
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// DEPENDENCY EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

function extractDependencies(pkgJsonContent) {
  if (!pkgJsonContent) return [];
  try {
    const pkg  = JSON.parse(pkgJsonContent);
    const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
    // Filter to notable ones only
    const notable = ["react", "vue", "next", "express", "fastify", "tailwindcss",
      "three", "d3", "chart.js", "socket.io", "mongoose", "prisma", "drizzle-orm",
      "vite", "webpack", "typescript", "jest", "vitest", "axios", "zod"];
    return deps.filter(d => notable.some(n => d.includes(n)));
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// ARCHITECTURE SUMMARY BUILDER
// ─────────────────────────────────────────────────────────────────────────────

function buildArchitectureSummary(fileNames, fileContents, framework) {
  const summary = [];

  summary.push(`Framework: ${framework}`);
  summary.push(`Files: ${fileNames.length}`);

  // Dependencies
  const deps = extractDependencies(fileContents["package.json"] || "");
  if (deps.length) summary.push(`Key deps: ${deps.slice(0, 8).join(", ")}`);

  // Structure patterns
  const dirs = [...new Set(fileNames.map(f => f.split("/")[0]).filter(d => d && !d.includes(".")))];
  if (dirs.length > 1) summary.push(`Directories: ${dirs.slice(0, 6).join(", ")}`);

  // Entry points
  const entries = fileNames.filter(f => /^(index|main|app|server)\.(html|js|ts)$/.test(path.basename(f)));
  if (entries.length) summary.push(`Entry points: ${entries.join(", ")}`);

  // Component patterns
  const components = fileNames.filter(f => /components?\//.test(f));
  if (components.length) summary.push(`Components: ${components.slice(0, 5).join(", ")}...`);

  // API routes
  const routes = fileNames.filter(f => /routes?\/|api\//.test(f));
  if (routes.length) summary.push(`Routes: ${routes.slice(0, 5).join(", ")}`);

  return summary.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTEXT BUILDER — for AI injection
// ─────────────────────────────────────────────────────────────────────────────

function buildZipContext(intel, userMessage) {
  const { framework, fileNames, fileContents, architectureSummary, dependencies } = intel;

  const parts = [
    "═".repeat(60),
    `📦 UPLOADED CODEBASE (ZIP)`,
    "═".repeat(60),
    architectureSummary,
    "",
    "FILE STRUCTURE:",
    fileNames.slice(0, 25).map(f => `  • ${f}`).join("\n"),
    fileNames.length > 25 ? `  ... and ${fileNames.length - 25} more files` : "",
    "",
  ];

  // Add top files by priority
  const rankedFiles = [...fileNames].sort((a, b) => rankFile(b) - rankFile(a)).slice(0, 6);
  let usedChars = 0;

  for (const f of rankedFiles) {
    const content = fileContents[f];
    if (!content) continue;

    const allowance = Math.min(2000, MAX_CONTEXT_CHARS - usedChars - parts.join("\n").length);
    if (allowance < 100) break;

    const snippet = content.slice(0, allowance);
    const truncated = content.length > allowance;

    parts.push(`FILE: ${f}${truncated ? " (truncated)" : ""}:`);
    parts.push("```");
    parts.push(snippet);
    parts.push("```");
    parts.push("");

    usedChars += snippet.length;
    if (usedChars >= MAX_CONTEXT_CHARS) break;
  }

  parts.push("═".repeat(60));
  parts.push(`The user uploaded this codebase and asks: "${userMessage}"`);
  parts.push("Analyze the codebase above and respond directly.");
  parts.push("═".repeat(60));

  return parts.filter(p => p !== null && p !== undefined).join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * analyzeZip(zipFilePath) → ZipIntelligence
 *
 * @param {string} zipFilePath
 * @returns {Promise<{
 *   framework: string,
 *   fileNames: string[],
 *   fileContents: object,
 *   architectureSummary: string,
 *   dependencies: string[],
 *   totalFiles: number,
 *   error?: string,
 * }>}
 */
async function analyzeZip(zipFilePath) {
  const os   = require("os");
  const destDir = path.join(os.tmpdir(), `aquiplex_zip_${Date.now()}`);

  try {
    await fsAsync.mkdir(destDir, { recursive: true });
    await extractZip(zipFilePath, destDir);

    const allFiles = listFilesSync(destDir)
      .sort((a, b) => rankFile(b) - rankFile(a))
      .slice(0, MAX_EXTRACT_FILES);

    const fileContents = {};
    for (const f of allFiles) {
      try {
        const fullPath = path.join(destDir, f);
        const stat     = fs.statSync(fullPath);
        if (stat.size > MAX_FILE_BYTES) {
          fileContents[f] = `[File too large: ${(stat.size / 1024).toFixed(0)}KB]`;
          continue;
        }
        fileContents[f] = fs.readFileSync(fullPath, "utf8");
      } catch { fileContents[f] = "[Could not read file]"; }
    }

    const framework = detectFramework(allFiles, fileContents);
    const dependencies = extractDependencies(fileContents["package.json"] || "");
    const architectureSummary = buildArchitectureSummary(allFiles, fileContents, framework);

    log.info(`analyzeZip: framework=${framework} files=${allFiles.length} deps=${dependencies.length}`);

    return {
      framework,
      fileNames: allFiles,
      fileContents,
      architectureSummary,
      dependencies,
      totalFiles: allFiles.length,
    };

  } catch (e) {
    log.error(`analyzeZip failed: ${e.message}`);
    return {
      framework: "unknown",
      fileNames: [],
      fileContents: {},
      architectureSummary: `ZIP analysis failed: ${e.message}`,
      dependencies: [],
      totalFiles: 0,
      error: e.message,
    };
  } finally {
    // Cleanup temp dir
    try { fs.rmSync(destDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * buildZipContextFromFile(zipFilePath, userMessage) → string
 * Full pipeline: analyze + build context string for AI injection
 */
async function buildZipContextFromFile(zipFilePath, userMessage) {
  const intel = await analyzeZip(zipFilePath);
  return buildZipContext(intel, userMessage);
}

module.exports = {
  analyzeZip,
  buildZipContext,
  buildZipContextFromFile,
  detectFramework,
};
