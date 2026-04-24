/**
 * file.service.js
 * 
 * Universal file analysis system for Aqua AI.
 * 
 * Replaces the inline file processing block in the /chat route.
 * Drop-in compatible — returns { type, content, metadata, displayName }
 * which index.js injects into the AI message context.
 * 
 * Supported types:
 *   Text    → .txt, .md, .html, .xml, .log, .env, .yaml, .yml
 *   Code    → .js, .ts, .py, .java, .cpp, .c, .cs, .go, .rs, .php, .rb,
 *              .swift, .kt, .sh, .bash, .sql, .graphql, .vue, .jsx, .tsx
 *   Data    → .csv, .json, .jsonl, .tsv
 *   Doc     → .pdf, .docx
 *   Image   → .jpg, .jpeg, .png, .gif, .webp
 *   Unknown → graceful fallback
 */

const fs   = require("fs");
const path = require("path");

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const MAX_CONTENT_CHARS  = 12000; // Max chars sent to AI (up from original 8000)
const CHUNK_SIZE         = 4000;  // Size of each chunk when summarizing large files
const PARSE_TIMEOUT_MS   = 15000; // 15s max for any single file parse operation

// ─── EXTENSION MAPS ──────────────────────────────────────────────────────────

const CODE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".py", ".pyw",
  ".java", ".kt", ".kts",
  ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp",
  ".cs", ".fs",
  ".go", ".rs", ".rb", ".php",
  ".swift", ".m", ".mm",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd",
  ".sql", ".graphql", ".gql",
  ".vue", ".svelte",
  ".r", ".rmd", ".jl", ".scala", ".clj", ".ex", ".exs",
  ".lua", ".pl", ".pm", ".tf", ".hcl",
]);

const DATA_EXTENSIONS = new Set([
  ".csv", ".tsv", ".json", ".jsonl", ".ndjson",
]);

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".rst", ".log",
  ".html", ".htm", ".xml", ".xhtml", ".svg",
  ".css", ".scss", ".sass", ".less",
  ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".env", ".properties", ".gitignore", ".dockerignore",
  ".tex", ".rtf",
]);

const IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".ico",
]);

const DOC_EXTENSIONS = new Set([
  ".pdf", ".docx", ".doc",
]);

// ─── TYPE DETECTION ──────────────────────────────────────────────────────────

/**
 * Detect the semantic category of a file based on extension (primary)
 * and MIME type (secondary fallback).
 */
function detectFileType(filename, mimetype) {
  const ext = path.extname(filename || "").toLowerCase();

  if (IMAGE_EXTENSIONS.has(ext))  return "image";
  if (CODE_EXTENSIONS.has(ext))   return "code";
  if (DATA_EXTENSIONS.has(ext))   return "data";
  if (DOC_EXTENSIONS.has(ext))    return "doc";
  if (TEXT_EXTENSIONS.has(ext))   return "text";

  // MIME type fallback
  if (mimetype) {
    if (mimetype.startsWith("image/"))       return "image";
    if (mimetype === "application/pdf")      return "doc";
    if (mimetype.startsWith("text/"))        return "text";
    if (mimetype === "application/json")     return "data";
  }

  return "unknown";
}

// ─── SAFE TIMEOUT WRAPPER ────────────────────────────────────────────────────

/**
 * Wrap any async operation with a hard timeout.
 * If it takes too long, rejects with a timeout error.
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout after ${ms}ms parsing ${label}`)),
      ms
    );
    promise
      .then((v) => { clearTimeout(timer); resolve(v); })
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

// ─── CHUNKING & SUMMARIZATION ─────────────────────────────────────────────────

/**
 * Split text into chunks of ~CHUNK_SIZE characters, respecting line boundaries.
 */
function chunkText(text, chunkSize = CHUNK_SIZE) {
  if (text.length <= chunkSize) return [text];

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = start + chunkSize;

    // Try to break at a newline rather than mid-word
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end);
      if (newline > start + chunkSize * 0.5) end = newline + 1;
    }

    chunks.push(text.slice(start, end));
    start = end;
  }

  return chunks;
}

/**
 * If content is very large, build a summary header + truncated body.
 * This ensures the AI always gets the most useful portion.
 */
function buildLargeFileContent(rawText, filename, fileType) {
  if (rawText.length <= MAX_CONTENT_CHARS) {
    return rawText;
  }

  const chunks = chunkText(rawText, MAX_CONTENT_CHARS);

  // For large files: return first chunk + metadata note
  // The AI will know it's looking at a partial view
  const totalLines = rawText.split("\n").length;
  const totalChars = rawText.length;

  const header = [
    `[File: ${filename} | ${fileType} | ${totalLines} lines | ${totalChars} chars total]`,
    `[Showing first ${MAX_CONTENT_CHARS} of ${totalChars} characters]`,
    "",
  ].join("\n");

  return header + chunks[0];
}

// ─── FORMAT-SPECIFIC PARSERS ─────────────────────────────────────────────────

/**
 * Parse CSV: extract header row + sample rows for context.
 * Returns a readable summary rather than raw CSV dump.
 */
function parseCSV(rawText, filename) {
  try {
    const lines = rawText.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return { content: "(empty CSV)", metadata: {} };

    const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
    const sampleRows = lines.slice(1, 6); // First 5 data rows
    const totalRows = lines.length - 1;

    const summary = [
      `CSV file: ${filename}`,
      `Columns (${headers.length}): ${headers.join(", ")}`,
      `Total rows: ${totalRows}`,
      "",
      "Sample data (first 5 rows):",
      lines.slice(0, 6).join("\n"),
    ];

    if (totalRows > 5) {
      summary.push(`\n... and ${totalRows - 5} more rows`);
    }

    return {
      content: summary.join("\n"),
      metadata: { columns: headers, rowCount: totalRows },
    };
  } catch {
    return { content: rawText.slice(0, MAX_CONTENT_CHARS), metadata: {} };
  }
}

/**
 * Parse JSON: pretty-print with structure summary.
 */
function parseJSON(rawText, filename) {
  try {
    const parsed = JSON.parse(rawText);
    const type = Array.isArray(parsed) ? "array" : typeof parsed;
    const size = Array.isArray(parsed) ? parsed.length : Object.keys(parsed || {}).length;

    const pretty = JSON.stringify(parsed, null, 2);

    const header = [
      `JSON file: ${filename}`,
      `Structure: ${type} with ${size} ${type === "array" ? "items" : "keys"}`,
      "",
    ].join("\n");

    return {
      content: buildLargeFileContent(header + pretty, filename, "json"),
      metadata: { type, size },
    };
  } catch {
    // Not valid JSON — treat as text
    return {
      content: rawText.slice(0, MAX_CONTENT_CHARS),
      metadata: { parseError: "Invalid JSON" },
    };
  }
}

/**
 * Parse JSONL (one JSON object per line).
 */
function parseJSONL(rawText, filename) {
  const lines = rawText.trim().split("\n").filter(Boolean);
  const sample = lines.slice(0, 5).map((l) => {
    try { return JSON.stringify(JSON.parse(l), null, 2); }
    catch { return l; }
  });

  return {
    content: [
      `JSONL file: ${filename} — ${lines.length} records`,
      "",
      "Sample (first 5 records):",
      sample.join("\n---\n"),
    ].join("\n"),
    metadata: { recordCount: lines.length },
  };
}

/**
 * Parse code files — add language label for markdown rendering.
 */
function parseCode(rawText, filename) {
  const ext = path.extname(filename).slice(1); // e.g. "js", "py"
  const content = buildLargeFileContent(rawText, filename, "code");
  return {
    content: `\`\`\`${ext}\n${content}\n\`\`\``,
    metadata: { language: ext, lines: rawText.split("\n").length },
  };
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────

/**
 * processFile(file) → { type, content, metadata, displayName }
 * 
 * The universal entry point. Called once per uploaded file from the /chat route.
 * 
 * Guarantees:
 * - Always returns a result (never throws to caller)
 * - Always cleans up the temp file from disk
 * - Never executes uploaded code
 * - Respects the 15s parse timeout
 * 
 * @param {object} file - multer file object (path, originalname, mimetype, size)
 * @param {Function} generateAI - injected from index.js for image description
 * @returns {Promise<{type: string, content: string, metadata: object, displayName: string}>}
 */
async function processFile(file, generateAI) {
  const { path: filePath, originalname, mimetype, size } = file;
  const ext        = path.extname(originalname).toLowerCase();
  const fileType   = detectFileType(originalname, mimetype);
  const displayName = originalname;

  // Result skeleton — always returned even on failure
  let result = {
    type: fileType,
    content: "",
    metadata: { filename: originalname, size, ext },
    displayName,
  };

  try {
    await withTimeout(
      (async () => {
        // ── IMAGES ────────────────────────────────────────────────────────────
        if (fileType === "image") {
          // Read as base64 for AI vision description
          const imageBuffer = fs.readFileSync(filePath);
          const base64 = imageBuffer.toString("base64");
          const mimeType = mimetype || `image/${ext.slice(1)}`;

          // Use AI to describe the image (Vision via generateAI with image content)
          // We embed the image description request so it works even without vision support
          try {
            const description = await generateAI(
              [
                {
                  role: "user",
                  content: [
                    {
                      type: "image",
                      source: { type: "base64", media_type: mimeType, data: base64 },
                    },
                    {
                      type: "text",
                      text: "Describe this image in detail. Include: main subjects, colors, text visible, layout, and any notable elements. Be thorough.",
                    },
                  ],
                },
              ],
              {},
              true // flag = use vision-capable model
            );
            result.content = `[Image: ${displayName}]\n\nAI Description:\n${description}`;
          } catch {
            // Fallback if vision fails — still useful for the chat context
            result.content = `[Image uploaded: ${displayName} (${Math.round(size / 1024)}KB) — visual content, no text extracted]`;
          }

          result.metadata.base64Preview = base64.slice(0, 100) + "..."; // Don't leak full base64 to metadata
          return;
        }

        // ── PDF ───────────────────────────────────────────────────────────────
        if (ext === ".pdf") {
          const pdfParse = require("pdf-parse");
          const buffer = fs.readFileSync(filePath);
          const data = await pdfParse(buffer);

          result.content = buildLargeFileContent(data.text, displayName, "pdf");
          result.metadata = {
            ...result.metadata,
            pages: data.numpages,
            chars: data.text.length,
            truncated: data.text.length > MAX_CONTENT_CHARS,
          };
          return;
        }

        // ── DOCX ──────────────────────────────────────────────────────────────
        if (ext === ".docx") {
          const mammoth = require("mammoth");
          const parsed = await mammoth.extractRawText({ path: filePath });

          result.content = buildLargeFileContent(parsed.value, displayName, "docx");
          result.metadata = {
            ...result.metadata,
            chars: parsed.value.length,
            truncated: parsed.value.length > MAX_CONTENT_CHARS,
            warnings: parsed.messages?.length || 0,
          };
          return;
        }

        // ── CSV ───────────────────────────────────────────────────────────────
        if (ext === ".csv" || ext === ".tsv") {
          const rawText = fs.readFileSync(filePath, "utf8");
          const { content, metadata } = parseCSV(rawText, displayName);
          result.content = content;
          result.metadata = { ...result.metadata, ...metadata };
          return;
        }

        // ── JSON ──────────────────────────────────────────────────────────────
        if (ext === ".json") {
          const rawText = fs.readFileSync(filePath, "utf8");
          const { content, metadata } = parseJSON(rawText, displayName);
          result.content = content;
          result.metadata = { ...result.metadata, ...metadata };
          return;
        }

        // ── JSONL ─────────────────────────────────────────────────────────────
        if (ext === ".jsonl" || ext === ".ndjson") {
          const rawText = fs.readFileSync(filePath, "utf8");
          const { content, metadata } = parseJSONL(rawText, displayName);
          result.content = content;
          result.metadata = { ...result.metadata, ...metadata };
          return;
        }

        // ── CODE FILES ────────────────────────────────────────────────────────
        if (fileType === "code") {
          const rawText = fs.readFileSync(filePath, "utf8");
          const { content, metadata } = parseCode(rawText, displayName);
          result.content = content;
          result.metadata = { ...result.metadata, ...metadata };
          return;
        }

        // ── TEXT / EVERYTHING ELSE ────────────────────────────────────────────
        // Covers: .txt, .md, .html, .xml, .yaml, .log, etc.
        const rawText = fs.readFileSync(filePath, "utf8");
        result.content = buildLargeFileContent(rawText, displayName, fileType);
        result.metadata = {
          ...result.metadata,
          chars: rawText.length,
          truncated: rawText.length > MAX_CONTENT_CHARS,
        };
      })(),
      PARSE_TIMEOUT_MS,
      displayName
    );
  } catch (err) {
    // Any parse failure → graceful degradation with error note
    console.warn(`⚠️ [file] processFile failed for "${displayName}":`, err.message);
    result.content = `⚠️ Could not fully parse "${displayName}": ${err.message}. The file was uploaded but its content could not be extracted.`;
    result.metadata.parseError = err.message;
  } finally {
    // ALWAYS clean up temp file — even if parsing failed
    fs.unlink(filePath, (unlinkErr) => {
      if (unlinkErr) console.warn("⚠️ [file] Failed to delete temp file:", unlinkErr.message);
    });
  }

  return result;
}

module.exports = { processFile, detectFileType };
