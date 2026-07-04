"use strict";

/**
 * utils/file.validator.js — AQUIPLEX V5 File Validation Layer
 *
 * Validates AI-generated file content BEFORE any disk write.
 * Called by safeEditFiles() and generateProjectV2().
 *
 * Exports:
 *   validateFile(fileName, content)        → { valid, errors }
 *   validateFileSet(files)                 → { valid, files, errors }
 *   validateHtmlStructure(content)         → { valid, errors }
 */

const path = require("path");

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const MIN_CONTENT_LENGTH = 10;
const MAX_CONTENT_LENGTH = 500_000; // 500KB per file hard cap

const ALLOWED_EXTENSIONS = new Set([
  ".html", ".htm", ".css", ".js", ".mjs", ".cjs",
  ".ts", ".json", ".svg", ".md", ".txt",
  ".env.example", // allow .env templates, never actual .env
]);

const BLOCKED_FILENAMES = new Set([
  ".env", ".env.local", ".env.production",
  "package-lock.json", "yarn.lock",
]);

// ─────────────────────────────────────────────────────────────────────────────
// INDIVIDUAL FILE VALIDATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * validateFile(fileName, content)
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateFile(fileName, content) {
  const errors = [];

  // ── Name checks ────────────────────────────────────────────────────────────
  if (!fileName || typeof fileName !== "string") {
    return { valid: false, errors: ["fileName must be a non-empty string"] };
  }

  const baseName = path.basename(fileName).toLowerCase();
  const ext      = path.extname(baseName).toLowerCase();

  if (BLOCKED_FILENAMES.has(baseName)) {
    errors.push(`Blocked filename: ${baseName}`);
  }

  if (!ALLOWED_EXTENSIONS.has(ext) && ext !== "") {
    errors.push(`Disallowed extension: ${ext || "(none)"}`);
  }

  // Path traversal
  const normalized = path.normalize(fileName);
  if (normalized.includes("..") || normalized.startsWith("/")) {
    errors.push("Path traversal detected in fileName");
  }

  // ── Content checks ─────────────────────────────────────────────────────────
  if (content === null || content === undefined) {
    errors.push("content is null/undefined");
  } else if (typeof content !== "string") {
    errors.push(`content must be string, got ${typeof content}`);
  } else {
    if (content.trim().length < MIN_CONTENT_LENGTH) {
      errors.push(`content too short (${content.trim().length} chars, min ${MIN_CONTENT_LENGTH})`);
    }
    if (content.length > MAX_CONTENT_LENGTH) {
      errors.push(`content too large (${content.length} bytes, max ${MAX_CONTENT_LENGTH})`);
    }

    // Per-extension semantic checks
    if (ext === ".html" || ext === ".htm") {
      const htmlResult = validateHtmlStructure(content);
      if (!htmlResult.valid) errors.push(...htmlResult.errors);
    }

    if (ext === ".json") {
      try { JSON.parse(content); }
      catch (e) { errors.push(`Invalid JSON: ${e.message.slice(0, 80)}`); }
    }

    // Placeholder detection — reject obviously incomplete AI output
    const PLACEHOLDER_PATTERNS = [
      /\/\*\s*(TODO|FIXME|PLACEHOLDER|INSERT|ADD HERE)\s*\*\//i,
      /<!--\s*(TODO|FIXME|PLACEHOLDER|YOUR CODE HERE)\s*-->/i,
      /\[YOUR\s+(CODE|CONTENT|TEXT)\s+HERE\]/i,
    ];
    for (const re of PLACEHOLDER_PATTERNS) {
      if (re.test(content)) {
        errors.push(`Placeholder detected in ${fileName} — AI output incomplete`);
        break;
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML STRUCTURAL VALIDATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * validateHtmlStructure(content)
 * Ensures index.html has required tags.
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateHtmlStructure(content) {
  const errors  = [];
  const lower   = content.toLowerCase();

  if (!lower.includes("<!doctype")) {
    errors.push("HTML missing <!DOCTYPE html>");
  }
  if (!lower.includes("<html")) {
    errors.push("HTML missing <html> tag");
  }
  if (!lower.includes("<head")) {
    errors.push("HTML missing <head> tag");
  }
  if (!lower.includes("<body")) {
    errors.push("HTML missing <body> tag");
  }
  if (!lower.includes("</body>")) {
    errors.push("HTML unclosed <body>");
  }
  if (!lower.includes("</html>")) {
    errors.push("HTML unclosed <html>");
  }
  if (!lower.includes("<meta charset")) {
    errors.push("HTML missing charset meta tag (risk: garbled content)");
  }

  // Blank body check — catches AI returning shell with empty body
  const bodyMatch = content.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch && bodyMatch[1].trim().length < 5) {
    errors.push("HTML body is empty or near-empty — AI returned shell without content");
  }

  return { valid: errors.length === 0, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE SET VALIDATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * validateFileSet(files)
 * Validates array of { fileName, content }.
 * Returns sanitized list with per-file validity + set-level errors.
 *
 * @param {Array<{fileName: string, content: string}>} files
 * @returns {{
 *   valid:   boolean,
 *   files:   Array<{fileName, content, valid, errors}>,
 *   errors:  string[],
 *   summary: string,
 * }}
 */
function validateFileSet(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return {
      valid:   false,
      files:   [],
      errors:  ["File set is empty or not an array"],
      summary: "FAIL: no files",
    };
  }

  const setErrors   = [];
  const annotated   = [];
  const fileNames   = new Set();

  for (const f of files) {
    const result = validateFile(f?.fileName, f?.content);
    annotated.push({
      fileName: f?.fileName || "(unknown)",
      content:  f?.content  || "",
      language: f?.language || "",
      valid:    result.valid,
      errors:   result.errors,
    });

    // Duplicate detection
    if (f?.fileName) {
      if (fileNames.has(f.fileName)) {
        setErrors.push(`Duplicate fileName: ${f.fileName}`);
      } else {
        fileNames.add(f.fileName);
      }
    }
  }

  // index.html required in any set containing HTML
  const hasHtml = annotated.some(f => f.fileName?.endsWith(".html") || f.fileName?.endsWith(".htm"));
  const hasIndex = annotated.some(f => f.fileName === "index.html");
  if (hasHtml && !hasIndex) {
    setErrors.push("File set contains HTML but no index.html — preview will fail");
  }

  const allValid = setErrors.length === 0 && annotated.every(f => f.valid);
  const badFiles = annotated.filter(f => !f.valid).map(f => f.fileName);

  const summary = allValid
    ? `OK: ${annotated.length} file(s) validated`
    : `FAIL: ${badFiles.length} invalid file(s) [${badFiles.join(", ")}]` +
      (setErrors.length ? ` | Set errors: ${setErrors.join("; ")}` : "");

  return { valid: allValid, files: annotated, errors: setErrors, summary };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { validateFile, validateFileSet, validateHtmlStructure };
