/**
 * Evaluation credential inventory (2026-11-11). EVALUATION ONLY — production
 * rotation (src/providers/keyPool.cjs) is not used or changed.
 *
 * Loads numbered and unnumbered Gemini/Groq credentials from an env object and
 * classifies each WITHOUT exposing it:
 *   · missing / malformed (blank, whitespace, quotes, placeholder, too short) → excluded
 *   · duplicate value of an earlier variable → excluded (first variable wins)
 *   · compatibility: 'standard' (documented format) | 'non-standard' (unknown kind —
 *     usable only if the evaluation config lists it explicitly) | 'incompatible'
 *     (looks like ANOTHER provider's key) → excluded
 *
 * The value lives only in a private WeakMap. A credential object serialises,
 * inspects and stringifies to its environment variable NAME only.
 */
import { inspect } from 'node:util';

const SECRET = new WeakMap();

export const PROVIDER_SPECS = Object.freeze({
  gemini: {
    numbered: /^GEMINI_KEY_(\d+)$/,
    bare: ['GEMINI_API_KEY'],
    standard: /^AIza[0-9A-Za-z_-]{35}$/,
    standardName: 'Google AI Studio API key',
  },
  groq: {
    numbered: /^GROQ_API_KEY_(\d+)$/,
    bare: ['GROQ_API_KEY'],
    standard: /^gsk_[0-9A-Za-z]{20,}$/,
    standardName: 'Groq API key',
  },
});
const OTHER_FORMATS = [/^AIza[0-9A-Za-z_-]{35}$/, /^gsk_[0-9A-Za-z]{20,}$/, /^sk-or-/, /^nvapi-/, /^sk-(?!or-)[A-Za-z0-9]/, /^xai-/];
const PLACEHOLDER = /^(?:your[_-]?(?:api[_-]?)?key(?:[_-]?here)?|xxx+|changeme|todo|placeholder|<.*>|\.\.\.|none|null|undefined)$/i;

/** Shape-level problems only. A well-formed value is not a VALID value — only a call proves that. */
export function malformedReason(value) {
  const s = value == null ? '' : String(value);
  if (!s.trim()) return 'blank';
  if (s !== s.trim()) return 'surrounding-whitespace';
  if (/\s/.test(s)) return 'contains-whitespace';
  if (/["'`]/.test(s)) return 'contains-quotes';
  if (PLACEHOLDER.test(s)) return 'placeholder';
  if (s.length < 20) return 'too-short';
  return null;
}

export function compatibility(provider, value) {
  const spec = PROVIDER_SPECS[provider];
  if (spec.standard.test(value)) return 'standard';
  if (OTHER_FORMATS.some(r => r.test(value))) return 'incompatible';
  return 'non-standard';
}

class Credential {
  constructor({ provider, envName, slot, compat, value }) {
    this.provider = provider; this.envName = envName; this.slot = slot; this.compatibility = compat;
    SECRET.set(this, value);
    Object.freeze(this);
  }
  toJSON() { return { provider: this.provider, envName: this.envName, slot: this.slot, compatibility: this.compatibility }; }
  toString() { return `${this.provider}:${this.envName}`; }
  [inspect.custom]() { return `Credential(${this.provider}:${this.envName})`; }
}

/** The value, for a transport's request header only. Never log what this returns. */
export function revealForRequest(credential) {
  if (!(credential instanceof Credential)) throw new TypeError('not a credential');
  return SECRET.get(credential);
}

/**
 * Inventory for one provider. Returns { usable: Credential[], excluded: [{envName, reason}] }.
 * `excluded` never contains values.
 */
export function loadCredentials(provider, env = process.env) {
  const spec = PROVIDER_SPECS[provider];
  if (!spec) throw new Error(`unknown provider ${provider}`);
  const names = Object.keys(env).filter(n => spec.numbered.test(n))
    .sort((a, b) => Number(spec.numbered.exec(a)[1]) - Number(spec.numbered.exec(b)[1]));
  const ordered = [...names.map(n => [n, `#${spec.numbered.exec(n)[1]}`]), ...spec.bare.filter(n => n in env).map(n => [n, '#bare'])];
  const usable = [], excluded = [];
  const seen = new Map();
  for (const [envName, slot] of ordered) {
    const v = env[envName];
    const bad = malformedReason(v);
    if (bad) { excluded.push({ envName, reason: `malformed:${bad}` }); continue; }
    if (seen.has(v)) { excluded.push({ envName, reason: `duplicate-of:${seen.get(v)}` }); continue; }
    seen.set(v, envName);
    const compat = compatibility(provider, v);
    if (compat === 'incompatible') { excluded.push({ envName, reason: 'incompatible-format' }); continue; }
    usable.push(new Credential({ provider, envName, slot, compat, value: v }));
  }
  return { usable, excluded };
}

export function isCredential(x) { return x instanceof Credential; }
