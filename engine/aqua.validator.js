"use strict";

/**
 * aqua.validator.js — AQUA Control Layer: Output Validation
 *
 * Validates parsed AI file output before any disk write.
 * Rules: must be valid JSON-parseable object, must have "files",
 * must include index.html, each file must have name + non-empty content.
 *
 * Does NOT parse. Does NOT write. Pure validation gate.
 */

// ─── VALIDATORS ──────────────────────────────────────────────────────────────

/**
 * validateFile({ name, content })
 * Returns { valid: boolean, errors: string[] }
 */
function validateFile({ name, content }) {
  const errors = [];

  if (!name || typeof name !== "string" || !name.trim()) {
    errors.push("File name is missing or empty");
  }

  if (!content || typeof content !== "string" || !content.trim()) {
    errors.push(`File "${name}" has empty content`);
  }

  // index.html structural checks
  if (name === "index.html") {
    if (!content.includes("<!DOCTYPE html") && !content.includes("<!doctype html")) {
      errors.push('index.html missing <!DOCTYPE html>');
    }
    if (!content.includes("<html")) {
      errors.push("index.html missing <html> tag");
    }
    if (!content.includes("<body")) {
      errors.push("index.html missing <body> tag");
    }
  }

  // script.js must not be obviously empty
  if (name === "script.js" && content.trim().length < 5) {
    errors.push("script.js appears to be effectively empty");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * validateAIOutput(files)
 *
 * Full validation pass over the parsed file array.
 * Enforces:
 *   1. files is a non-empty array
 *   2. At least one valid index.html present
 *   3. Each file passes individual validation
 *
 * @param {Array<{name: string, content: string}>} files
 * @returns {{
 *   valid:    boolean,
 *   files:    Array<{name, content, valid, errors}>,
 *   errors:   string[],
 *   summary:  string,
 * }}
 */
function validateAIOutput(files) {
  const globalErrors = [];

  if (!Array.isArray(files) || files.length === 0) {
    return {
      valid:   false,
      files:   [],
      errors:  ["No files provided to validator"],
      summary: "FAIL: empty input",
    };
  }

  // Per-file validation
  const annotated = files.map(f => {
    const { valid, errors } = validateFile(f);
    return { ...f, valid, errors };
  });

  const validFiles = annotated.filter(f => f.valid);
  const hasIndexHtml = validFiles.some(f => f.name === "index.html");

  if (!hasIndexHtml) {
    // Attempt rescue: rename the first valid HTML file to index.html
    const htmlFile = validFiles.find(f => f.name?.endsWith(".html"));
    if (htmlFile) {
      htmlFile.name = "index.html";
      globalErrors.push(`Warning: renamed "${htmlFile.name}" → index.html`);
    } else {
      globalErrors.push("REQUIRED: index.html not found in valid output");
    }
  }

  const finalValid = validFiles.length > 0 && (
    validFiles.some(f => f.name === "index.html")
  );

  const summary = finalValid
    ? `OK: ${validFiles.length}/${annotated.length} files valid`
    : `FAIL: ${globalErrors.join("; ")}`;

  return {
    valid:   finalValid,
    files:   annotated,
    errors:  globalErrors,
    summary,
  };
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = { validateAIOutput, validateFile };
