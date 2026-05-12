"use strict";

/**
 * engine/file.session.js — AQUIPLEX In-Session File Memory
 *
 * Stores parsed file content in req.session so AI remembers files
 * across multiple chat turns without re-uploading.
 *
 * Schema (stored in req.session.fileContext):
 * {
 *   files: [
 *     {
 *       id:        string,     unique ID for this upload
 *       fileName:  string,
 *       mimeType:  string,
 *       charCount: number,
 *       text:      string,     extracted content
 *       uploadedAt: number,    timestamp
 *     }
 *   ]
 * }
 *
 * Max 5 files per session, oldest evicted first.
 * Max 32000 chars total across all files (safe token budget).
 */

const MAX_FILES      = 5;
const MAX_TOTAL_CHARS = 8000;  // keep total context under AI endpoint limits
const { randomUUID } = require("crypto");

// ─── SESSION HELPERS ─────────────────────────────────────────────────────────

function _getStore(session) {
  if (!session.fileContext) session.fileContext = { files: [] };
  if (!Array.isArray(session.fileContext.files)) session.fileContext.files = [];
  return session.fileContext;
}

/**
 * addFileToSession(session, parseResult)
 * Stores a parsed file in session. Evicts oldest if limit hit.
 * @returns {string} fileId
 */
function addFileToSession(session, parseResult) {
  const store = _getStore(session);
  const fileId = randomUUID();

  const entry = {
    id:         fileId,
    fileName:   parseResult.fileName,
    mimeType:   parseResult.mimeType,
    charCount:  parseResult.charCount,
    text:       parseResult.text,
    uploadedAt: Date.now(),
  };

  // Evict oldest if at limit
  while (store.files.length >= MAX_FILES) {
    store.files.shift();
  }

  store.files.push(entry);
  return fileId;
}

/**
 * getSessionFiles(session)
 * Returns all files stored in session.
 * @returns {Array}
 */
function getSessionFiles(session) {
  return _getStore(session).files;
}

/**
 * buildSessionFileContext(session)
 * Builds full context block for all session files.
 * Respects total char budget — truncates oldest files first if needed.
 * @returns {string}  ready to inject into AI system prompt
 */
function buildSessionFileContext(session) {
  const files = getSessionFiles(session);
  if (!files.length) return "";

  const blocks = [];
  let totalChars = 0;

  // Most recent files get priority (iterate from end)
  const ordered = [...files].reverse();

  for (const file of ordered) {
    if (totalChars >= MAX_TOTAL_CHARS) {
      blocks.push(`[File "${file.fileName}" available but omitted — context budget reached]`);
      continue;
    }

    const remaining = MAX_TOTAL_CHARS - totalChars;
    const text      = file.text.length > remaining
      ? file.text.slice(0, remaining) + "\n[...truncated for context budget...]"
      : file.text;

    totalChars += text.length;

    blocks.push([
      `${"─".repeat(55)}`,
      `📄 FILE: ${file.fileName}  (${file.charCount.toLocaleString()} chars)`,
      `${"─".repeat(55)}`,
      text,
    ].join("\n"));
  }

  if (!blocks.length) return "";

  return [
    "╔" + "═".repeat(58) + "╗",
    "║  UPLOADED FILES IN THIS CONVERSATION" + " ".repeat(20) + "║",
    "╚" + "═".repeat(58) + "╝",
    blocks.join("\n\n"),
    "═".repeat(60),
    "IMPORTANT: The files above were uploaded by the user in this conversation.",
    "You have full access to their content. Analyze them directly.",
    "NEVER ask the user to upload or re-upload a file if it appears above.",
    "═".repeat(60),
  ].join("\n");
}

/**
 * clearSessionFiles(session)
 * Removes all files from session. Call when user starts new conversation.
 */
function clearSessionFiles(session) {
  if (session.fileContext) session.fileContext = { files: [] };
}

/**
 * getFileList(session)
 * Returns compact list of file names for UI display.
 * @returns {Array<{id, fileName, uploadedAt}>}
 */
function getFileList(session) {
  return getSessionFiles(session).map(({ id, fileName, uploadedAt }) => ({
    id, fileName, uploadedAt,
  }));
}

module.exports = {
  addFileToSession,
  getSessionFiles,
  buildSessionFileContext,
  clearSessionFiles,
  getFileList,
};