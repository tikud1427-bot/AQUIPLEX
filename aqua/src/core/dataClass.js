/**
 * AQUA — data classes and provider eligibility (G1-2)
 *
 * Every piece of content AQUA processes belongs to exactly one DATA CLASS:
 *
 *   user                    what the user typed or AQUA produced for them
 *   upload                  a file the user uploaded
 *   external:<connectorId>  content synced from a connected source (e.g.
 *                           external:gmail), identified by the connector that
 *                           fetched it — never by file name or content
 *
 * A class decides which AI PROVIDERS may receive that content. The policy is
 * here and nowhere else; prompts never carry it (a prompt instruction is not a
 * privacy boundary).
 *
 *   user, upload            every provider (today's behaviour, unchanged)
 *   external:gmail          NONE — frozen. No provider is approved for Gmail
 *                           content (audit/…/g0/AI_PROVIDER_PRIVACY_AUDIT.md);
 *                           approving one is a reviewed code change here, not
 *                           a setting and not a connector declaration.
 *   external:<other>        what that connector's registered definition
 *                           declares (`dataPolicy.allowedProviders`); a
 *                           connector that declares nothing, or is not
 *                           registered, gets NONE.
 *   anything else           NONE (fail closed): an unparseable class, a
 *                           missing class, `unclassified`.
 *
 * Consumers: core/egressGuard.js (every outbound model call), files/ukoStore.js
 * (restricted content is invisible to normal readers), files/fileEngine.js
 * (ingestion never derives restricted content into prompt-feeding stores).
 */

/** Every outbound AI/search vendor AQUA can call. An egress point names one of these. */
export const PROVIDERS = Object.freeze(['gemini', 'groq', 'nvidia', 'openrouter', 'huggingface', 'serper', 'tavily']);
const PROVIDER_SET = new Set(PROVIDERS);

/** Allowed-provider marker for classes every provider may receive. */
export const ALL_PROVIDERS = '*';

/** The class given to content whose class cannot be determined. Never allowed anywhere. */
export const UNCLASSIFIED = 'unclassified';

const CONNECTOR_ID = /^[a-z][a-z0-9_-]{0,39}$/;

/** Classes whose policy is fixed in code and cannot be (re)registered. */
const FROZEN = new Map([
  ['user', ALL_PROVIDERS],
  ['upload', ALL_PROVIDERS],
  ['external:gmail', Object.freeze([])],
]);

const registered = new Map();   // connectorId → frozen allowedProviders (array | '*')

export class DataClassError extends Error {
  constructor(code, message) { super(message); this.name = 'DataClassError'; this.code = code; }
}

/** `user` | `upload` | `external:<connectorId>` → { kind, connectorId }, else null. */
export function parseDataClass(value) {
  if (value === 'user' || value === 'upload') return { kind: value, connectorId: null };
  if (typeof value !== 'string' || !value.startsWith('external:')) return null;
  const connectorId = value.slice('external:'.length);
  return CONNECTOR_ID.test(connectorId) ? { kind: 'external', connectorId } : null;
}

export const isKnownDataClass = value => parseDataClass(value) !== null;
export const externalDataClass = connectorId => `external:${connectorId}`;

/**
 * The class of content from an external source id (`<connector>:<scope>`,
 * files/externalIdentity.js). Anything that does not name a connector is
 * UNCLASSIFIED — fail closed, never `user`.
 */
export function dataClassOfSource(sourceId) {
  const connectorId = typeof sourceId === 'string' ? sourceId.slice(0, sourceId.indexOf(':')) : '';
  return sourceId?.includes?.(':') && CONNECTOR_ID.test(connectorId) ? externalDataClass(connectorId) : UNCLASSIFIED;
}

/**
 * Allowed providers for one class: `'*'` or a frozen array (possibly empty).
 * Unknown, unparseable or unregistered classes → [] (fail closed).
 */
export function allowedProvidersFor(dataClass) {
  if (FROZEN.has(dataClass)) return FROZEN.get(dataClass);
  const parsed = parseDataClass(dataClass);
  if (parsed?.kind !== 'external') return Object.freeze([]);
  return registered.get(parsed.connectorId) ?? Object.freeze([]);
}

/** True when `provider` may receive content of `dataClass`. */
export function providerAllowedFor(dataClass, provider) {
  if (!PROVIDER_SET.has(provider)) return false;
  const allowed = allowedProvidersFor(dataClass);
  return allowed === ALL_PROVIDERS || allowed.includes(provider);
}

/**
 * Every provider may receive it. Only such content may be derived into stores
 * that do not carry a class (file memory, evidence, search index, canonical
 * claims, Mind) — anything derived there reaches every provider later.
 */
export const isUnrestricted = dataClass => allowedProvidersFor(dataClass) === ALL_PROVIDERS;

/**
 * Register the data policy a connector DEFINITION declares (connect/registry.js
 * calls this on register). Refused for a frozen class (Gmail): no connector
 * definition can approve a provider for Gmail content.
 *
 * @param {string} connectorId
 * @param {{ allowedProviders?: string[]|'*' }} [policy]  missing → []
 * @returns {() => void} unregister
 */
export function registerConnectorDataPolicy(connectorId, policy = {}) {
  if (!CONNECTOR_ID.test(String(connectorId))) throw new DataClassError('INVALID_CONNECTOR', 'invalid connector id');
  if (FROZEN.has(externalDataClass(connectorId))) {
    throw new DataClassError('FROZEN_POLICY', `the data policy of external:${connectorId} is fixed in code`);
  }
  const allowed = policy?.allowedProviders ?? [];
  let value;
  if (allowed === ALL_PROVIDERS) value = ALL_PROVIDERS;
  else if (Array.isArray(allowed) && allowed.every(p => PROVIDER_SET.has(p))) value = Object.freeze([...new Set(allowed)]);
  else throw new DataClassError('INVALID_POLICY', 'allowedProviders must be "*" or a list of known providers');
  registered.set(connectorId, value);
  return () => { if (registered.get(connectorId) === value) registered.delete(connectorId); };
}

export function unregisterConnectorDataPolicy(connectorId) { registered.delete(connectorId); }

/** A class whose policy is fixed in code (user, upload, external:gmail). */
export const isFrozenDataClass = dataClass => FROZEN.has(dataClass);

/** Tests only. */
export function _resetConnectorDataPoliciesForTests() { registered.clear(); }
