"use strict";

/**
 * engine/file.parser.js — AQUIPLEX Universal File Parser
 *
 * Extracts text content from uploaded files for AI context injection.
 * Supports: PDF, DOCX, TXT, CSV, JSON, JSONL, code files, YAML, Markdown.
 *
 * Usage:
 *   const { parseUploadedFile } = require("./engine/file.parser");
 *   const result = await parseUploadedFile(req.file);
 *   // result: { text, mimeType, fileName, charCount, truncated, error? }
 */

const fs   = require("fs");
const path = require("path");

// Max chars injected into AI context (~6000 tokens safe limit)
const MAX_CHARS = 8000;  // ~2000 tokens — safe for all AI endpoints

// ─── PARSERS ─────────────────────────────────────────────────────────────────

async function parsePDF(filePath) {
  // pdf-parse v2.x is ESM-only — must use dynamic import(), not require()
  // Fallback chain: ESM import → require default fn → require.parse
  const buffer = fs.readFileSync(filePath);

  let pdfFn = null;

  // Try dynamic ESM import first (v2.x)
  try {
    const mod = await import("pdf-parse");
    pdfFn = mod.default || mod.parse || null;
    if (typeof pdfFn !== "function") pdfFn = null;
  } catch (_) { /* not ESM or import failed */ }

  // Fallback: CJS require (v1.x)
  if (!pdfFn) {
    try {
      const mod = require("pdf-parse");
      pdfFn = typeof mod === "function" ? mod : (mod.default || mod.parse || null);
    } catch (_) { /* also failed */ }
  }

  if (typeof pdfFn !== "function") {
    throw new Error("pdf-parse not usable — try: npm install pdf-parse@1.1.1");
  }

  const data = await pdfFn(buffer);
  return data.text || "";
}

async function parseDOCX(filePath) {
  const mammoth = require("mammoth");
  const result  = await mammoth.extractRawText({ path: filePath });
  return result.value || "";
}

function parseText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function parseJSON(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    const parsed = JSON.parse(raw);
    // Pretty-print for readability
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw; // return as-is if malformed
  }
}

function parseCSV(filePath) {
  const raw   = fs.readFileSync(filePath, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) return "";

  // Add row count context
  const preview = lines.slice(0, 200).join("\n");
  const note    = lines.length > 200
    ? `\n[...${lines.length - 200} more rows truncated]`
    : "";
  return preview + note;
}

// ─── EXTENSION → PARSER MAP ──────────────────────────────────────────────────

const EXT_MAP = {
  ".pdf":  parsePDF,
  ".docx": parseDOCX,
  ".txt":  parseText,
  ".md":   parseText,
  ".csv":  parseCSV,
  ".tsv":  parseCSV,
  ".json": parseJSON,
  ".jsonl":parseText,
  ".yaml": parseText,
  ".yml":  parseText,
  // Code files
  ".js":   parseText,
  ".ts":   parseText,
  ".tsx":  parseText,
  ".jsx":  parseText,
  ".py":   parseText,
  ".java": parseText,
  ".cpp":  parseText,
  ".c":    parseText,
  ".cs":   parseText,
  ".go":   parseText,
  ".rs":   parseText,
  ".rb":   parseText,
  ".php":  parseText,
  ".swift":parseText,
  ".sh":   parseText,
  ".sql":  parseText,
  ".html": parseText,
  ".css":  parseText,
  ".xml":  parseText,
  ".vue":  parseText,
};

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────

/**
 * parseUploadedFile(file)
 *
 * @param {object} file  - multer file object (req.file)
 *   file.path          - disk path
 *   file.originalname  - original filename
 *   file.mimetype      - MIME type
 *   file.size          - bytes
 *
 * @returns {Promise<{
 *   text:      string,    extracted content
 *   fileName:  string,
 *   mimeType:  string,
 *   charCount: number,
 *   truncated: boolean,
 *   error?:    string,    set if parse failed (text will be empty)
 * }>}
 */
async function parseUploadedFile(file) {
  if (!file || !file.path) {
    return { text: "", fileName: "", mimeType: "", charCount: 0, truncated: false, error: "No file provided" };
  }

  const ext      = path.extname(file.originalname).toLowerCase();
  const fileName = file.originalname;
  const mimeType = file.mimetype;

  // ── ZIP: use zip.intelligence for codebase understanding ──────────────────
  if (ext === ".zip") {
    try {
      const { analyzeZip, buildZipContext } = require("./zip.intelligence");
      const intel = await analyzeZip(file.path);

      const summary = [
        `📦 ZIP Archive: ${fileName}`,
        `Framework: ${intel.framework}`,
        `Files analyzed: ${intel.totalFiles}`,
        intel.architectureSummary,
        "",
        "Files:",
        intel.fileNames.slice(0, 20).map(f => `  • ${f}`).join("\n"),
        intel.fileNames.length > 20 ? `  ... and ${intel.fileNames.length - 20} more` : "",
      ].join("\n");

      return {
        text:       summary,
        fileName,
        mimeType:   "application/zip",
        charCount:  summary.length,
        truncated:  false,
        error:      intel.error || null,
        isZip:      true,
        zipIntel:   intel,
      };
    } catch (e) {
      return {
        text: "", fileName, mimeType, charCount: 0, truncated: false,
        error: `ZIP analysis failed: ${e.message}`,
      };
    }
  }

  const parser = EXT_MAP[ext];

  if (!parser) {
    return {
      text: "", fileName, mimeType, charCount: 0, truncated: false,
      error: `File type "${ext}" is not supported for text extraction`,
    };
  }

  let raw = "";
  try {
    raw = await parser(file.path);
  } catch (err) {
    return {
      text: "", fileName, mimeType, charCount: 0, truncated: false,
      error: `Parse failed: ${err.message}`,
    };
  }

  if (!raw || !raw.trim()) {
    return {
      text: "", fileName, mimeType, charCount: 0, truncated: false,
      error: "File parsed but contained no extractable text",
    };
  }

  // Normalize whitespace
  let text = raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();

  const truncated = text.length > MAX_CHARS;
  if (truncated) {
    text = text.slice(0, MAX_CHARS) + `\n\n[... File truncated — showing first ${MAX_CHARS} characters of ${raw.length} total ...]`;
  }

  return { text, fileName, mimeType, charCount: text.length, truncated, error: null };
}

/**
 * buildFileContext(parseResult, userMessage)
 *
 * Builds the injected context block for the AI system prompt.
 * Call this to convert a parse result into prompt-ready text.
 *
 * @param {object} parseResult  - result of parseUploadedFile()
 * @param {string} userMessage  - original user message
 * @returns {string}
 */
function buildFileContext(parseResult, userMessage) {
  if (!parseResult || !parseResult.text) return "";

  const { text, fileName, charCount, truncated } = parseResult;

  return [
    "═".repeat(60),
    `📄 UPLOADED FILE: ${fileName}`,
    `   Size: ${charCount.toLocaleString()} chars${truncated ? " (truncated)" : ""}`,
    "═".repeat(60),
    text,
    "═".repeat(60),
    `The user has uploaded the above file and is asking: "${userMessage}"`,
    "Analyze the file content above and respond directly. Do NOT ask the user to upload anything.",
    "═".repeat(60),
  ].join("\n");
}

/**
 * cleanupFile(filePath) — safe delete after processing
 */
function cleanupFile(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* non-fatal */ }
}

module.exports = {
  parseUploadedFile,
  buildFileContext,
  cleanupFile,
  MAX_CHARS,
};