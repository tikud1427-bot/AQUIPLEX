/**
 * AQUA Secret Guard (Phase 1 — security)
 * ─────────────────────────────────────────────────────────────────────────────
 * Two independent defenses against uploading credentials to third-party LLM
 * providers (Groq / OpenRouter / Gemini). Both are pure, deterministic, and
 * dependency-free.
 *
 *   1. isSecretFile(path)  — file-level DENYLIST. A file whose whole purpose
 *      is to hold secrets (.env, private keys, credential stores) is never
 *      ingested at all. This is the primary fix: the previous shouldIgnore()
 *      only rejected hidden *directories*, so a repo-root `.env` (no
 *      extension → not in IGNORE_EXTS) passed the gate and its full content
 *      was persisted into .aqua-index.json AND injected into prompts.
 *
 *   2. redactSecrets(text) — content-level REDACTION for secrets that live
 *      INSIDE an otherwise-legitimate file (a hardcoded key in a .js, a
 *      connection string in a .yaml). Only structurally-distinctive,
 *      high-confidence formats are touched, so real source code is never
 *      corrupted. Redaction always REPLACES a value in place — it never drops
 *      a file — so its worst-case failure is masking a benign high-entropy
 *      string, which is the safe direction.
 *
 * Placeholder-bearing template files (.env.example / .sample / .template /
 * .dist / .defaults) are deliberately NOT excluded: they carry no real
 * values and are genuinely useful for project understanding.
 */
import path from 'path';

// ── 1. File-level denylist ────────────────────────────────────────────────────

// Extensions that only ever hold key material / credentials.
const SECRET_EXTS = new Set([
  '.pem', '.key', '.p12', '.pfx', '.keystore', '.jks',
  '.ppk', '.asc', '.gpg', '.pkcs12',
]);

// Exact basenames (lowercased) that are credential stores or token files.
const SECRET_BASENAMES = new Set([
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',      // SSH private keys
  '.npmrc', '.pypirc', '.netrc', 'netrc',            // registry / network tokens
  '.htpasswd', 'credentials', '.credentials',        // aws / basic-auth
  'secring.gpg', '.pgpass',
]);

// Safe template suffixes — carry no real values, keep them.
const SAFE_ENV_SUFFIXES = ['.example', '.sample', '.template', '.dist', '.defaults', '.local.example'];

/**
 * True when a file should never be ingested because it holds secrets.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isSecretFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const normalised = filePath.replace(/\\/g, '/');
  const base = normalised.split('/').pop().toLowerCase();

  // .env family — reject real env files, allow *.example / *.sample / etc.
  if (base === '.env' || base.startsWith('.env.') || base.startsWith('.env-') || base.endsWith('.env')) {
    if (SAFE_ENV_SUFFIXES.some(suf => base.endsWith(suf))) return false;
    return true;
  }

  if (SECRET_BASENAMES.has(base)) return true;

  const ext = path.extname(base).toLowerCase();
  if (SECRET_EXTS.has(ext)) return true;

  // Google service-account / cloud key JSON (conservative name match only).
  if (ext === '.json' && /(service[-_]?account|gcloud[-_]?key|-key)\b/.test(base)) return true;

  return false;
}

// ── 2. Content-level redaction ────────────────────────────────────────────────

const REDACTED = '[REDACTED-SECRET]';

// Structurally-distinctive credential formats. Each is specific enough that a
// false positive in real source is vanishingly unlikely.
const HIGH_CONFIDENCE = [
  // Any PEM private key block (RSA / EC / OPENSSH / generic).
  { re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g, tag: 'pem_private_key' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g,                              tag: 'aws_access_key_id' },
  { re: /\bASIA[0-9A-Z]{16}\b/g,                              tag: 'aws_session_key_id' },
  { re: /\bgh[posru]_[A-Za-z0-9]{36,}\b/g,                    tag: 'github_token' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,                  tag: 'github_fine_grained_pat' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,                  tag: 'slack_token' },
  { re: /\bAIza[0-9A-Za-z_\-]{35}\b/g,                        tag: 'google_api_key' },
  { re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g,      tag: 'stripe_key' },
  { re: /\bsk-(?:or-)?[A-Za-z0-9_\-]{20,}\b/g,                tag: 'openai_or_openrouter_key' },
  { re: /\bxapp-[0-9]-[A-Za-z0-9-]{10,}\b/g,                  tag: 'slack_app_token' },
];

// Placeholder values that are NOT secrets — never redact these.
const PLACEHOLDER_RE = /^(?:your[_-]?|my[_-]?|<|xxx+|change[_-]?me|example|placeholder|todo|\.\.\.|dummy|test|foo|bar|none|null|undefined|\$\{|process\.env)/i;

// Assignment of a long value to a secret-named key. Redacts the VALUE only,
// preserving the key name (so the code/config still reads sensibly). Guarded
// against placeholders and env-var references.
const SECRET_ASSIGN_RE =
  /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET|AUTH_KEY)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)([^\s"'`]{12,})\3/gi;

/**
 * Redact high-confidence secrets found inside file content.
 * @param {string} text
 * @returns {{ content: string, redactions: number, tags: string[] }}
 */
export function redactSecrets(text) {
  if (!text || typeof text !== 'string') return { content: text ?? '', redactions: 0, tags: [] };

  let content = text;
  let redactions = 0;
  const tags = new Set();

  for (const { re, tag } of HIGH_CONFIDENCE) {
    content = content.replace(re, () => { redactions++; tags.add(tag); return REDACTED; });
  }

  content = content.replace(SECRET_ASSIGN_RE, (match, key, sep, quote, value) => {
    if (PLACEHOLDER_RE.test(value)) return match;   // benign placeholder — leave it
    redactions++;
    tags.add('secret_assignment');
    return `${key}${sep}${quote}${REDACTED}${quote}`;
  });

  return { content, redactions, tags: [...tags] };
}
