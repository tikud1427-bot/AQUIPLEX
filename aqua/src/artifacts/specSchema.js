/**
 * AQUA Artifact Engine — ArtifactSpec Schema (P1)
 * ─────────────────────────────────────────────────────────────────────────────
 * The planner asks an LLM for JSON; this module is the ONLY thing standing
 * between that reply and the rest of the engine. Pure, dependency-free,
 * fail-closed:
 *
 *   • Prototype-pollution proof — the raw parse is deep-copied onto
 *     null-prototype objects, and `__proto__` / `constructor` / `prototype`
 *     keys are dropped wherever they appear.
 *   • Every file path goes through security.sanitizeRelativePath — a spec
 *     with even one hostile path is rejected whole.
 *   • Errors are collected (not first-throw) so planner.js can hand the FULL
 *     list back to the model for its single repair attempt.
 *
 * validateSpec() never throws on bad input — it returns { valid:false,
 * errors } so the caller owns the retry/fallback decision.
 */
import { sanitizeRelativePath, QUOTAS, ArtifactSecurityError } from './security.js';

export const SPEC_LIMITS = {
  TITLE_MAX:        200,
  SUMMARY_MAX:      2_000,
  THEME_MAX:        100,
  DESCRIPTION_MAX:  500,
  STRUCTURE_MAX_DEPTH:  6,
  STRUCTURE_KEY_MAX:    200,
  STRUCTURE_STRING_MAX: 20_000,
  STRUCTURE_JSON_MAX:   200_000,
};

const FILE_ROLES = new Set(['primary', 'source', 'asset', 'doc', 'config', 'test']);
const PACKAGING  = new Set(['auto', 'raw', 'zip', 'tar', 'tar.gz']); // tar variants landed in P3

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ── Deep sanitize: null-prototype copy, dangerous keys dropped ────────────────

function deepSanitize(value, depth = 0) {
  if (depth > SPEC_LIMITS.STRUCTURE_MAX_DEPTH) return undefined;
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string')  return value.length > SPEC_LIMITS.STRUCTURE_STRING_MAX
    ? value.slice(0, SPEC_LIMITS.STRUCTURE_STRING_MAX)
    : value;
  if (t === 'number')  return Number.isFinite(value) ? value : undefined;
  if (t === 'boolean') return value;
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      const s = deepSanitize(item, depth + 1);
      if (s !== undefined) out.push(s);
    }
    return out;
  }
  if (t === 'object') {
    const out = Object.create(null);
    for (const key of Object.keys(value)) {
      if (DANGEROUS_KEYS.has(key)) continue;
      if (key.length > SPEC_LIMITS.STRUCTURE_KEY_MAX) continue;
      const s = deepSanitize(value[key], depth + 1);
      if (s !== undefined) out[key] = s;
    }
    return out;
  }
  return undefined; // functions, symbols, bigints — never valid in a spec
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

function cleanString(v, max) {
  return String(v).replace(CONTROL_RE, ' ').trim().slice(0, max);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validate a raw parsed planner object into a canonical ArtifactSpec.
 *
 * @param {unknown} raw                      JSON.parse'd planner output
 * @param {{ knownFormats: string[] }} opts  registered exporter ids
 * @returns {{ valid: true, spec: object } | { valid: false, errors: string[] }}
 */
export function validateSpec(raw, { knownFormats }) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['Spec must be a JSON object'] };
  }
  const input = deepSanitize(raw);
  const spec  = Object.create(null);

  // format — must name a registered exporter
  const formats = new Set(knownFormats ?? []);
  if (typeof input.format !== 'string' || !input.format.trim()) {
    errors.push('`format` is required and must be a string');
  } else {
    const fmt = input.format.trim().toLowerCase();
    if (!formats.has(fmt)) {
      errors.push(`\`format\` "${fmt}" is not one of the allowed formats: ${[...formats].join(', ')}`);
    } else {
      spec.format = fmt;
    }
  }

  // title
  if (typeof input.title !== 'string' || !input.title.trim()) {
    errors.push('`title` is required and must be a non-empty string');
  } else {
    spec.title = cleanString(input.title, SPEC_LIMITS.TITLE_MAX);
  }

  // intentSummary / theme — optional strings
  if (input.intentSummary != null) spec.intentSummary = cleanString(input.intentSummary, SPEC_LIMITS.SUMMARY_MAX);
  if (input.theme != null)         spec.theme         = cleanString(input.theme, SPEC_LIMITS.THEME_MAX);

  // files
  if (!Array.isArray(input.files) || input.files.length === 0) {
    errors.push('`files` is required and must be a non-empty array');
  } else if (input.files.length > QUOTAS.MAX_FILES) {
    errors.push(`\`files\` exceeds the maximum of ${QUOTAS.MAX_FILES} entries`);
  } else {
    const seen  = new Set();
    const files = [];
    for (let i = 0; i < input.files.length; i++) {
      const f = input.files[i];
      if (!f || typeof f !== 'object') { errors.push(`files[${i}] must be an object`); continue; }
      if (typeof f.path !== 'string')  { errors.push(`files[${i}].path is required`);  continue; }
      let cleanPath;
      try {
        cleanPath = sanitizeRelativePath(f.path);
      } catch (err) {
        if (err instanceof ArtifactSecurityError) {
          errors.push(`files[${i}].path rejected (${err.code}): ${err.message}`);
          continue;
        }
        throw err;
      }
      const lower = cleanPath.toLowerCase();
      if (seen.has(lower)) { errors.push(`files[${i}].path duplicates "${cleanPath}" (case-insensitive)`); continue; }
      seen.add(lower);

      const entry = Object.create(null);
      entry.path = cleanPath;
      if (f.role != null) {
        const role = String(f.role).toLowerCase();
        entry.role = FILE_ROLES.has(role) ? role : 'source';
      }
      if (f.description != null) entry.description = cleanString(f.description, SPEC_LIMITS.DESCRIPTION_MAX);
      files.push(entry);
    }
    if (files.length === 0 && errors.length === 0) errors.push('`files` contained no valid entries');
    spec.files = files;
  }

  // packaging
  const pkg = input.packaging == null ? 'auto' : String(input.packaging).toLowerCase();
  if (!PACKAGING.has(pkg)) {
    errors.push(`\`packaging\` must be one of: ${[...PACKAGING].join(', ')}`);
  } else {
    spec.packaging = pkg;
  }

  // structure / constraints — optional sanitized objects, total size capped
  for (const key of ['structure', 'constraints']) {
    if (input[key] == null) continue;
    if (typeof input[key] !== 'object' || Array.isArray(input[key])) {
      errors.push(`\`${key}\` must be an object when present`);
      continue;
    }
    const json = JSON.stringify(input[key]);
    if (json.length > SPEC_LIMITS.STRUCTURE_JSON_MAX) {
      errors.push(`\`${key}\` exceeds ${SPEC_LIMITS.STRUCTURE_JSON_MAX} serialized chars`);
      continue;
    }
    spec[key] = input[key];
  }

  if (errors.length) return { valid: false, errors };
  return { valid: true, spec };
}
