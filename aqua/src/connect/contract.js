/**
 * AQUA Connect — the connector contract (Phase 1b)
 *
 * A connector is an object:
 *
 *   {
 *     id, displayName, version,                  // id: lowercase, the sourceId prefix
 *     auth: { type: 'none'|'api_key'|'oauth2', scopes?: string[] },
 *     capabilities: ['list','fetch','sync', 'incremental'?, 'refresh'?],
 *     resourceTypes: string[], permissions: string[], testOnly?: boolean,
 *
 *     // ── authentication (credential side) ──
 *     async connect(input)            → { account: { externalAccountId, label }, credentials, scopes?, expiresAt? }
 *     async refresh?(credentials)     → { credentials, expiresAt? }
 *     async disconnect(ctx)           → revoke at the provider (best effort)
 *
 *     // ── execution (resource side) — receives ctx, never raw identity ──
 *     async listResources(ctx, { cursor }) → { resources: ResourceRef[], cursor?: string|null }
 *     async fetchResource(ctx, ref)        → raw (connector-specific)
 *     normalize(raw, ref)                  → { externalId, name, content|buffer, sourceUpdatedAt?, url?, title?, type?, version? }
 *                                            name MUST end in an extension the parser registry
 *                                            recognises (.md, .txt, .pdf, …): it selects the parser.
 *                                            A name without one fails that resource (reported, not
 *                                            silently dropped) — e.g. a Drive title needs ".md"/".txt".
 *     async syncChanges?(ctx, { checkpoint }) → { changed: ResourceRef[], removed: string[], checkpoint }
 *                                            may throw ConnectorError('CURSOR_EXPIRED') when the
 *                                            checkpoint is gone at the source
 *     listResources' LAST page may also return { checkpoint }: the source position
 *     the listing started from, stored after a clean complete full pass.
 *     async health()                       → { ok, detail? }
 *   }
 *
 *   ctx = { connectionId, credentials: () => creds, signal? } — no user id, no
 *   owner id, no store access. A connector can only act as the one connection
 *   it was handed, with that connection's credentials.
 *
 * EVERYTHING a connector returns is untrusted: ids, names, content, URLs,
 * timestamps. normalizeOutput() validates and sanitises it before it reaches
 * the knowledge pipeline, which then treats the content as untrusted data
 * (fenced in every prompt lane — Phase 1a.1).
 */
import { sanitizeInlineLabel } from '../core/untrustedContent.js';

export const AUTH_TYPES = Object.freeze(['none', 'api_key', 'oauth2']);
export const CAPABILITIES = Object.freeze(['list', 'fetch', 'sync', 'incremental', 'refresh']);
const ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** Problems with a connector definition ([] = valid). */
export function validateConnectorDefinition(c) {
  const p = [];
  if (!c || typeof c !== 'object') return ['definition must be an object'];
  if (!ID_RE.test(String(c.id ?? ''))) p.push('id must be 2–31 chars of [a-z0-9-], starting with a letter');
  if (typeof c.displayName !== 'string' || !c.displayName.trim() || c.displayName.length > 60) p.push('displayName required (≤ 60 chars)');
  if (!VERSION_RE.test(String(c.version ?? ''))) p.push('version must be semver x.y.z');
  if (!c.auth || !AUTH_TYPES.includes(c.auth.type)) p.push(`auth.type must be one of ${AUTH_TYPES.join('|')}`);
  if (c.auth?.scopes && (!Array.isArray(c.auth.scopes) || c.auth.scopes.some(s => typeof s !== 'string'))) p.push('auth.scopes must be strings');
  if (!Array.isArray(c.capabilities) || !c.capabilities.length || c.capabilities.some(x => !CAPABILITIES.includes(x))) p.push(`capabilities must be a non-empty subset of ${CAPABILITIES.join('|')}`);
  if (!Array.isArray(c.resourceTypes) || !c.resourceTypes.length || c.resourceTypes.some(x => typeof x !== 'string')) p.push('resourceTypes must be a non-empty string array');
  if (!Array.isArray(c.permissions) || c.permissions.some(x => typeof x !== 'string')) p.push('permissions must be a string array');
  for (const fn of ['connect', 'disconnect', 'listResources', 'fetchResource', 'normalize', 'health']) {
    if (typeof c[fn] !== 'function') p.push(`${fn}() is required`);
  }
  if (c.capabilities?.includes('incremental') && typeof c.syncChanges !== 'function') p.push('capability "incremental" requires syncChanges()');
  if (c.capabilities?.includes('refresh') && typeof c.refresh !== 'function') p.push('capability "refresh" requires refresh()');
  // G1-2 — which AI providers may receive this connector's content
  // (core/dataClass.js). Optional; absent = none (fail closed).
  if (c.dataPolicy !== undefined) {
    const a = c.dataPolicy?.allowedProviders;
    if (!c.dataPolicy || typeof c.dataPolicy !== 'object' || !(a === '*' || (Array.isArray(a) && a.every(x => typeof x === 'string')))) {
      p.push('dataPolicy.allowedProviders must be "*" or a string array');
    }
  }
  return p;
}

// ── Errors a connector may raise (anything else is treated as transient-unknown) ──

export class ConnectorError extends Error {
  /**
   * @param {'AUTH'|'TRANSIENT'|'NOT_FOUND'|'PERMANENT'|'CURSOR_EXPIRED'|'REFUSED'} kind
   *   REFUSED (2026-11-23): the source refused for a reason that is neither an
   *   authorisation failure nor temporary (an unknown 403, an exhausted daily quota).
   *   The run stops; the connection's status is NOT changed (no reconnect demanded).
   * @param {string} message
   * @param {{ status?: number, reason?: string|null, rateLimited?: boolean }} [detail]
   *   status/reason: the source's HTTP status and its fixed reason code (never free text).
   */
  constructor(kind, message, detail = {}) {
    super(message);
    this.kind = kind;
    if (Number.isFinite(detail.status)) this.status = detail.status;
    if (detail.reason) this.reason = detail.reason;
    if (detail.rateLimited === true) this.rateLimited = true;
  }
}
export const isAuthError = err => err?.kind === 'AUTH';
/** 2026-11-23: a refusal that is neither auth nor temporary (status kept; the run stops). */
export const isRefused = err => err?.kind === 'REFUSED';
/** 2026-11-23: a temporary failure the source attributed to a rate limit (longer backoff, then the run stops). */
export const isRateLimited = err => err?.kind === 'TRANSIENT' && err?.rateLimited === true;
// A connector's explicit classification always wins; the message heuristic only
// applies to errors that carry no kind (a raw network/library error).
export const isTransient = err => (err?.kind
  ? err.kind === 'TRANSIENT'
  : /\b(429|5\d\d)\b|timeout|ECONNRESET|ETIMEDOUT/i.test(String(err?.message ?? '')));
export const isNotFound = err => err?.kind === 'NOT_FOUND';
/** syncChanges: the saved checkpoint no longer exists at the source (the engine lists the whole source instead). */
export const isCursorExpired = err => err?.kind === 'CURSOR_EXPIRED';

// ── Untrusted output → the Phase 1a.2 resource shape ────────────────────────

export const MAX_EXTERNAL_ID = 512;
const URL_RE = /^https?:\/\/[^\s]+$/i;

/** A resource reference from listResources/syncChanges, validated. Null = drop it. */
export function sanitizeRef(ref) {
  const externalId = typeof ref?.externalId === 'string' ? ref.externalId : null;
  if (!externalId || externalId.length > MAX_EXTERNAL_ID || /[\u0000-\u001f\u007f]/.test(externalId)) return null;
  return {
    externalId,
    name: sanitizeInlineLabel(ref.name ?? '', { max: 200 }) || null,
    type: sanitizeInlineLabel(ref.type ?? '', { max: 40 }) || null,
    version: typeof ref.version === 'string' || typeof ref.version === 'number' ? String(ref.version).slice(0, 128) : null,
    updatedAt: validTime(ref.updatedAt),
  };
}

/**
 * normalize() output → { externalId, name, buffer, sourceUpdatedAt, url, title, version }
 * or { error } when it cannot be trusted at all. The externalId must match the
 * ref it was fetched for (a connector cannot rename one resource into another).
 */
export function normalizeOutput(out, ref) {
  if (!out || typeof out !== 'object') return { error: 'normalize returned nothing' };
  if (out.externalId !== ref.externalId) return { error: 'normalize changed the resource id' };
  const name = sanitizeInlineLabel(out.name ?? ref.name ?? '', { max: 200 }).replace(/[\\/]+/g, '_');
  if (!name) return { error: 'resource has no name' };
  let buffer = null;
  if (Buffer.isBuffer(out.buffer)) buffer = out.buffer;
  else if (typeof out.content === 'string') buffer = Buffer.from(out.content, 'utf8');
  if (!buffer) return { error: 'resource has no content' };
  return {
    externalId: ref.externalId,
    name,
    buffer,
    sourceUpdatedAt: validTime(out.sourceUpdatedAt) ?? ref.updatedAt ?? null,
    url: typeof out.url === 'string' && URL_RE.test(out.url) && out.url.length <= 2048 ? out.url : null,
    title: sanitizeInlineLabel(out.title ?? '', { max: 200 }) || null,
    version: out.version != null ? String(out.version).slice(0, 128) : ref.version ?? null,
  };
}

function validTime(v) {
  if (v == null) return null;
  const t = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null;
}

// ── Secrets never leave the credential boundary ─────────────────────────────

/** Every string value ≥ 6 chars inside a credentials object (the things to redact). */
export function secretValues(credentials) {
  const out = new Set();
  const walk = v => {
    if (typeof v === 'string') { if (v.length >= 6) out.add(v); }
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(credentials);
  return [...out];
}

/** Replace any secret occurring in `text` with [redacted]. */
export function scrubSecrets(text, secrets) {
  let s = String(text ?? '');
  for (const v of secrets) if (v && s.includes(v)) s = s.split(v).join('[redacted]');
  return s;
}
