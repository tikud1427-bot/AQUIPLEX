/**
 * AQUA — E12: span-attribute allowlist.
 *
 * Blueprint E12 risk: "PII in traces → span attributes allowlisted, never
 * free-text content." This is that allowlist, as a function every span/metric
 * label site can call. Whatever is not on the list is dropped, and the drop is
 * reported so a caller (or a test) can see it happened (L13: no silent stage).
 *
 * TWO RULES
 *  1. Only listed keys pass, and each key has a fixed type.
 *  2. String values must be IDENTIFIER-SHAPED (letters, digits, `._:/-`, ≤64).
 *     A sentence, an email address or a name has spaces, `@` or length, so it
 *     cannot ride in on an allowed key. That is what makes "never free text"
 *     structural instead of a convention.
 *
 * Owner identity may appear only as `aqua.owner_hash` (truncated SHA-256) —
 * enough to correlate one owner's spans, not to recover who they are.
 */
import { createHash } from 'node:crypto';

const IDENT = /^[A-Za-z0-9._:/-]{1,64}$/;

export const SPAN_ATTRIBUTE_SCHEMA = Object.freeze({
  'aqua.stage': 'ident',
  'aqua.task_type': 'ident',
  'aqua.provider': 'ident',
  'aqua.model': 'ident',
  'aqua.lane': 'ident',
  'aqua.outcome': 'ident',
  'aqua.job_kind': 'ident',
  'aqua.owner_hash': 'ident',
  'aqua.latency_ms': 'number',
  'aqua.input_tokens': 'number',
  'aqua.output_tokens': 'number',
  'aqua.cost_usd': 'number',
  'aqua.claims_admitted': 'number',
  'aqua.claims_rejected': 'number',
  'aqua.retrieved_count': 'number',
  'aqua.attempts': 'number',
  'aqua.cache_hit': 'boolean',
  'aqua.degraded': 'boolean',
});

/** Stable, non-reversible correlation id for an owner. */
export function hashOwner(ownerId) {
  if (ownerId == null || ownerId === '') return null;
  return createHash('sha256').update(String(ownerId)).digest('hex').slice(0, 12);
}

/**
 * @returns {{ attributes: Record<string, string|number|boolean>, dropped: string[] }}
 */
export function sanitizeSpanAttributes(attrs = {}) {
  const attributes = {};
  const dropped = [];
  for (const [key, value] of Object.entries(attrs ?? {})) {
    const kind = SPAN_ATTRIBUTE_SCHEMA[key];
    const ok =
      (kind === 'ident' && typeof value === 'string' && IDENT.test(value)) ||
      (kind === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
      (kind === 'boolean' && typeof value === 'boolean');
    if (ok) attributes[key] = value; else dropped.push(key);
  }
  return { attributes, dropped };
}
