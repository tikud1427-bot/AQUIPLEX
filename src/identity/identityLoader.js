/**
 * AQUA Identity Loader
 * ─────────────────────────────────────────────────────────────────────────────
 * Loads the structured brand/self-knowledge profile ONCE, validates it, and
 * caches it in memory. There is exactly one source of truth for everything
 * AQUA knows about Aquiplex and AQUA, and it lives in ./data/*.json — never
 * hardcoded inside a prompt string.
 *
 * Performance (per spec):
 *   • Load once, cache in memory. No disk read on the hot path.
 *   • getIdentityProfile() is O(1) after first call.
 *
 * Editability (per spec):
 *   • Edit ./data/company.json (vision, mission, values…) → the change
 *     propagates everywhere: every injected prompt and every direct answer.
 *   • updateIdentityProfile(patch) applies a runtime override (in-memory by
 *     default; optionally persisted to ./data/overrides.json) WITHOUT editing
 *     or clobbering the base files. Overrides are deep-merged last.
 *
 * Versioning (per spec):
 *   • Every profile carries _identity = { version, revision, contentHash, loadedAt }.
 *   • revision bumps on each successful updateIdentityProfile().
 *
 * Resilience:
 *   • A missing/corrupt data file is logged and skipped — never throws on boot.
 *     AQUA must never fail to know itself because one JSON file was malformed.
 */
import fs   from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { atomicWriteFileSync } from '../core/atomicStore.js';

import { migrateLegacyFile } from '../core/dataDir.js';

const __dir   = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dir, 'data');
// P0 — persisted overrides are USER data (runtime edits to the identity
// profile) and must survive redeploys. They now live in the canonical data
// dir, with a one-time migration of any legacy copy shipped alongside code.
const overridePath = migrateLegacyFile('.aqua-identity-overrides.json', { legacyDir: dataDir });
// Historical name inside src/identity/data — migrate that too if present.
migrateLegacyOverrides();
function migrateLegacyOverrides() {
  const legacy = path.join(dataDir, 'overrides.json');
  try {
    if (fs.existsSync(legacy) && !fs.existsSync(overridePath)) {
      fs.copyFileSync(legacy, overridePath);
      fs.renameSync(legacy, `${legacy}.migrated-to-datadir`);
      console.log('[IDENTITY] Migrated overrides.json → data dir');
    }
  } catch (err) {
    console.warn(`[IDENTITY] Override migration failed (${err.message}) — legacy file left in place.`);
  }
}
function readOverrides() {
  try {
    return JSON.parse(fs.readFileSync(overridePath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[IDENTITY] Override file invalid — skipping (${err.message})`);
    return null;
  }
}

export const IDENTITY_VERSION = '1.0.0';

// Base data files → the key they populate on the merged profile.
const FILES = {
  company:   'company.json',
  assistant: 'assistant.json',
  founders:  'founders.json',
  products:  'products.json',
  roadmap:   'roadmap.json',
  models:    'models.json',
  faq:       'faq.json',
};

let _cache          = null;   // merged, frozen profile
let _revision       = 0;      // bumps on updateIdentityProfile()
let _memoryOverride = null;   // non-persisted runtime override

// ── low-level IO ──────────────────────────────────────────────────────────────

function readJson(file, { required = false, silent = false } = {}) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
  } catch (err) {
    // ENOENT on an optional file we expect to usually be absent (overrides) is
    // not worth a line on every boot; a PARSE error always is.
    const isMissing = err.code === 'ENOENT';
    if (required)            console.error(`[IDENTITY] Failed to read required data file ${file}: ${err.message}`);
    else if (!(silent && isMissing)) console.warn(`[IDENTITY] Optional data file ${file} ${isMissing ? 'missing' : 'invalid'} — skipping${isMissing ? '' : ` (${err.message})`}`);
    return null;
  }
}

// Deep-merge b into a (arrays/scalars from b win; objects merge). Pure.
function deepMerge(a, b) {
  if (Array.isArray(b) || b === null || typeof b !== 'object') return b;
  const out = (a && typeof a === 'object' && !Array.isArray(a)) ? { ...a } : {};
  for (const [k, v] of Object.entries(b)) out[k] = deepMerge(out[k], v);
  return out;
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.values(obj).forEach(deepFreeze);
    Object.freeze(obj);
  }
  return obj;
}

// ── validation (minimal, non-throwing) ────────────────────────────────────────
// Guarantees the fields the context builder + router depend on exist (with
// safe fallbacks) so downstream code never has to null-check its own brand.
function validate(profile) {
  const problems = [];
  const c = profile.company   ?? {};
  const a = profile.assistant ?? {};
  if (!c.name)    { problems.push('company.name missing');   c.name = 'Aquiplex'; }
  if (!c.vision)    problems.push('company.vision missing');
  if (!c.mission)   problems.push('company.mission missing');
  if (!a.name)    { problems.push('assistant.name missing'); a.name = 'AQUA'; }
  if (!a.builtBy)   a.builtBy = c.name;
  if (!Array.isArray(a.capabilities) || a.capabilities.length === 0) problems.push('assistant.capabilities empty');
  profile.company = c;
  profile.assistant = a;
  if (problems.length) console.warn(`[IDENTITY] Profile validation notes: ${problems.join('; ')}`);
  return profile;
}

// ── build (single path; applies disk override then in-memory override) ────────

function build() {
  const merged = {};
  for (const [key, file] of Object.entries(FILES)) {
    const required = key === 'company' || key === 'assistant';
    const data = readJson(file, { required });
    if (data == null) continue;
    if      (key === 'founders') merged.founders = data.founders ?? [];
    else if (key === 'products') merged.products = data.products ?? [];
    else if (key === 'roadmap')  merged.roadmap  = data.roadmap  ?? [];
    else                         merged[key]     = data;
  }

  // Overrides deep-merged last so they win: disk override, then in-memory.
  const diskOverride = readOverrides();
  let withOverride = diskOverride ? deepMerge(merged, diskOverride) : merged;
  if (_memoryOverride) withOverride = deepMerge(withOverride, _memoryOverride);

  const validated = validate(withOverride);

  const contentHash = crypto.createHash('sha1')
    .update(JSON.stringify(validated)).digest('hex').slice(0, 12);

  validated._identity = {
    version:  IDENTITY_VERSION,
    revision: _revision,
    contentHash,
    loadedAt: new Date().toISOString(),
  };

  return deepFreeze(validated);
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * The cached, frozen, merged identity profile. Loads on first call, then
 * serves from memory. Safe to call on every request.
 * @returns {Readonly<object>}
 */
export function getIdentityProfile() {
  if (!_cache) {
    _cache = build();
    console.log(`[IDENTITY] Loaded profile v${_cache._identity.version} (${_cache._identity.contentHash}) — ${_cache.assistant.name} by ${_cache.company.name}`);
  }
  return _cache;
}

/**
 * Force a re-read of all data files (hot reload in dev, or after editing
 * ./data/*.json). Same revision, fresh content.
 * @returns {Readonly<object>}
 */
export function reloadIdentity() {
  _cache = null;
  const p = getIdentityProfile();
  console.log('[IDENTITY] Reloaded profile from disk');
  return p;
}

/**
 * Admin update. Deep-merges `patch` as a runtime override WITHOUT editing the
 * base data files. Bumps the revision. This is the single helper the spec asks
 * for — changing the vision/roadmap never means touching a prompt.
 *
 * @param {object}  patch                - partial profile, e.g. { company: { vision: '…' } }
 * @param {object}  [opts]
 * @param {boolean} [opts.persist=false] - also write the accumulated override to ./data/overrides.json
 * @returns {Readonly<object>} the new cached profile
 */
export function updateIdentityProfile(patch, { persist = false } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('updateIdentityProfile(patch): patch must be a plain object');
  }

  if (persist) {
    // Accumulate against any existing override file so successive updates stack.
    const nextOverride = deepMerge(readOverrides() ?? {}, patch);
    try {
      atomicWriteFileSync(overridePath, JSON.stringify(nextOverride, null, 2));
      console.log(`[IDENTITY] Persisted override → ${overridePath}`);
    } catch (err) {
      console.error(`[IDENTITY] Failed to persist override: ${err.message}`);
    }
  } else {
    _memoryOverride = deepMerge(_memoryOverride ?? {}, patch);
  }

  _revision += 1;
  _cache = null;
  return getIdentityProfile();
}

/** Test/diagnostic helper — clears cache + in-memory override + revision. */
export function _resetForTests() {
  _cache = null;
  _revision = 0;
  _memoryOverride = null;
}
