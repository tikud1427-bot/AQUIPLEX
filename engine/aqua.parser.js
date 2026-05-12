"use strict";

/**
 * aqua.parser.js — AQUA Control Layer: AI Response Parser
 *
 * Extracts structured file data from raw AI JSON output.
 * Single responsibility: parse → validate shape → return clean file array.
 * Does NOT write files. Does NOT call AI. Pure transform.
 */

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const REQUIRED_FILES  = ["index.html"];
const ALLOWED_FILES   = new Set([
  "index.html", "style.css", "script.js",
  "server.js", "package.json",
  "routes/api.js", "routes/index.js",
  "utils/helpers.js", "db/schema.sql",
  ".env.example", "README.md",
]);

// ─── PARSER ───────────────────────────────────────────────────────────────────

/**
 * parseAIResponse(raw)
 *
 * Parses raw AI text into a clean array of file objects.
 * Handles: bare JSON arrays, ```json fences, minor whitespace noise.
 *
 * @param {string} raw - Raw string from AI response
 * @returns {{ files: Array<{name: string, content: string}>, warnings: string[] }}
 * @throws {Error} if JSON cannot be extracted or has no valid files
 */
function parseAIResponse(raw) {
  if (!raw || typeof raw !== "string") {
    throw new Error("Parser received empty or non-string input");
  }

  const warnings = [];
  let candidate = raw.trim();

  // Strip markdown code fences
  candidate = candidate
    .replace(/^```(?:json)?\s*/im, "")
    .replace(/```\s*$/im, "")
    .trim();

  // Locate JSON array boundaries
  const start = candidate.indexOf("[");
  const end   = candidate.lastIndexOf("]");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      `No JSON array found. AI output preview: "${candidate.slice(0, 150).replace(/\n/g, "↵")}"`
    );
  }

  const jsonStr = candidate.slice(start, end + 1);

  // Parse — attempt raw, then with escape fixes
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (firstErr) {
    warnings.push(`Initial parse failed (${firstErr.message}), attempting escape repair`);
    try {
      // Fix bare newlines/tabs inside JSON strings (common AI mistake)
      const repaired = jsonStr
        .replace(/(?<!\\)\n/g, "\\n")
        .replace(/(?<!\\)\t/g, "\\t")
        .replace(/\r/g, "");
      parsed = JSON.parse(repaired);
    } catch (secondErr) {
      throw new Error(`JSON parse failed after repair attempt: ${secondErr.message}`);
    }
  }

  if (!Array.isArray(parsed)) {
    throw new Error("AI response parsed as non-array JSON — expected array of file objects");
  }

  // Normalize entries: support {name, fileName, file} and {content, code, text}
  const files = parsed
    .filter(item => item && typeof item === "object")
    .map(item => {
      const name    = String(item.name || item.fileName || item.file || "").trim();
      const content = String(item.content || item.code || item.text || "").trim();
      return { name, content };
    })
    .filter(({ name, content }) => {
      if (!name)    { warnings.push("Skipped entry with no file name"); return false; }
      if (!content) { warnings.push(`Skipped empty file: ${name}`);     return false; }
      return true;
    });

  if (files.length === 0) {
    throw new Error("AI JSON array contained no valid file entries after normalization");
  }

  // Warn on unrecognized filenames (don't block — project may have custom files)
  for (const { name } of files) {
    if (!ALLOWED_FILES.has(name)) {
      warnings.push(`Non-standard file included: "${name}" — allowed through`);
    }
  }

  return { files, warnings };
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = { parseAIResponse, REQUIRED_FILES, ALLOWED_FILES };
