"use strict";

/**
 * utils/placeholder.detector.js — SHARED PLACEHOLDER DETECTION
 *
 * Superset pattern list combining the placeholder checks already living in
 * buildProjectV2.js (_hasPlaceholder) and brain.learning.pipeline.js
 * (_hasPlaceholderContent). Those two stay as-is to avoid touching working
 * call sites — this is a new, separate export for the one gap that had no
 * check at all: file.generator.js accepting brain-retrieved content without
 * ever screening it for placeholder text before it lands in a project file.
 *
 * Not a refactor of the existing checkers — an additional gate for a path
 * that previously had none.
 */

const PLACEHOLDER_PATTERNS = [
  /lorem ipsum/i,
  /coming soon/i,
  /sample (project|data)/i,
  /dummy content/i,
  /insert content here/i,
  /project (title|description)/i,
  /your application is being prepared/i,
  /src=["'](placeholder|your-image|undefined)["']/i,
  /\[YOUR\s+(CODE|CONTENT|TEXT)\s+HERE\]/i,
  /\bTODO\b|\bFIXME\b/,
  // Loading-only page text (not attribute values)
  /<[^>]+>\s*Loading[^<]{0,40}[.]{3}/,
  // Hardcoded localhost in fetch/href/src calls
  /fetch\s*\(\s*["']http:\/\/localhost/i,
];

/**
 * hasPlaceholder(content) → boolean
 */
function hasPlaceholder(content) {
  if (!content || typeof content !== "string") return false;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(content));
}

module.exports = { hasPlaceholder, PLACEHOLDER_PATTERNS };
