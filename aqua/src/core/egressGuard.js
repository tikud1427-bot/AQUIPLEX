/**
 * AQUA — egress guard (G1-2): the ONE check every outbound model call passes.
 *
 * WHAT IT ENFORCES. Content leaves AQUA only to a provider every data class in
 * play allows (core/dataClass.js). The classes in play are carried by a DATA-
 * CLASS SCOPE (AsyncLocalStorage) that follows the work across awaits, timers,
 * retries, fallbacks and streams:
 *
 *   entry point                     scope opened
 *   AQUA HTTP request               user          (aqua/router.js)
 *   durable job                     per job       (core/jobs/workerRuntime.js)
 *   external-source ingestion       external:<c>  (files/fileEngine.js)
 *   startup provider probes         user          (core/startupValidation.js)
 *
 * and every READ of classified content adds its class to the current scope
 * (files/ukoStore.js `includeRestricted`). A scope only grows — a nested scope
 * starts from its parent's classes and what it reads is added to every
 * ancestor — so content can never be "downgraded" by passing through another
 * class's code path.
 *
 * FAIL CLOSED:
 *   · no scope at all            → blocked (DATA_CLASS_MISSING)
 *   · an unknown class in scope  → blocked (DATA_CLASS_UNKNOWN)
 *   · a class that disallows the provider → blocked (DATA_CLASS_RESTRICTED)
 *
 * WHERE IT IS CALLED. Immediately before the network, in each transport:
 * providers/{gemini,groq,nvidia,openrouter}.js (generate, stream, media),
 * providers/router.js (every attempt, injected providers included),
 * embeddings/embeddingProvider.js and dedicatedEmbedder.js (embeddings),
 * brain/contextEngine/crossEncoder.js (reranking), search providers.
 *
 * Logs and counters carry provider, operation, reason and CLASS NAMES — never
 * content.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isKnownDataClass, providerAllowedFor, DataClassError } from './dataClass.js';

const als = new AsyncLocalStorage();

export class EgressBlockedError extends Error {
  constructor(reason, provider, operation, classes) {
    super(`egress to ${provider} (${operation}) blocked: ${reason}${classes.length ? ` [${classes.join(', ')}]` : ''}`);
    this.name = 'EgressBlockedError';
    this.code = 'EGRESS_BLOCKED';
    this.reason = reason;
    this.provider = provider;
    this.operation = operation;
    this.dataClasses = classes;
    this.retryable = false;
  }
}

/**
 * Run `fn` with `dataClass` in play. Inside an existing scope the class is
 * added to that scope and every enclosing one (content of that class is now in
 * this request/job — whatever the caller does next carries it too); otherwise
 * a new root scope is opened (an entry point: a request, a job).
 */
export function runWithDataClass(dataClass, fn) {
  if (als.getStore()) { noteDataClasses([dataClass]); return fn(); }
  return als.run({ classes: new Set([String(dataClass)]), parent: null }, fn);
}

/**
 * Record that content of these classes is now in play. Propagates to every
 * enclosing scope. Without a scope this THROWS — classified content may not
 * be read where its class cannot be tracked.
 */
export function noteDataClasses(classes) {
  const list = [...new Set((Array.isArray(classes) ? classes : [classes]).map(String))];
  if (!list.length) return;
  let s = als.getStore();
  if (!s) throw new DataClassError('DATA_CLASS_SCOPE_MISSING', 'classified content read outside a data-class scope');
  for (; s; s = s.parent) for (const c of list) s.classes.add(c);
}

/** The classes in the current scope, or null when there is no scope. */
export function currentDataClasses() {
  const s = als.getStore();
  return s ? [...s.classes] : null;
}

// ── Observability (class names and counts only) ─────────────────────────────
const blocked = new Map();   // `${provider}|${operation}|${reason}|${classes}` → count
let allowedCount = 0;
export function egressStats() {
  return { allowed: allowedCount, blocked: [...blocked].map(([k, n]) => { const [provider, operation, reason, classes] = k.split('|'); return { provider, operation, reason, classes: classes ? classes.split(',') : [], count: n }; }) };
}
export function _resetEgressStatsForTests() { blocked.clear(); allowedCount = 0; }

function decide(provider, operation) {
  const s = als.getStore();
  if (!s) return { ok: false, reason: 'DATA_CLASS_MISSING', classes: [] };
  const classes = [...s.classes].sort();
  if (!classes.length) return { ok: false, reason: 'DATA_CLASS_MISSING', classes };
  if (classes.some(c => !isKnownDataClass(c))) return { ok: false, reason: 'DATA_CLASS_UNKNOWN', classes };
  if (classes.some(c => !providerAllowedFor(c, provider))) return { ok: false, reason: 'DATA_CLASS_RESTRICTED', classes };
  return { ok: true, reason: null, classes };
}

function record(d, provider, operation) {
  if (d.ok) { allowedCount++; return; }
  const k = `${provider}|${operation}|${d.reason}|${d.classes.join(',')}`;
  blocked.set(k, (blocked.get(k) ?? 0) + 1);
  console.warn(`[EGRESS] blocked provider=${provider} op=${operation} reason=${d.reason} classes=${d.classes.join(',') || '-'}`);
}

/** May `provider` receive this scope's content? Records the decision. */
export function egressAllowed(provider, operation) {
  const d = decide(provider, operation);
  record(d, provider, operation);
  return d.ok;
}

/** Same decision without recording it (planning: which providers to try). */
export function wouldAllowEgress(provider, operation = 'plan') {
  return decide(provider, operation).ok;
}

/** Throws EgressBlockedError unless `provider` may receive this scope's content. */
export function assertEgress(provider, operation) {
  const d = decide(provider, operation);
  record(d, provider, operation);
  if (!d.ok) throw new EgressBlockedError(d.reason, provider, operation, d.classes);
}

/**
 * HTTP entry point: run the rest of the request in a root `dataClass` scope.
 * aqua/router.js mounts it for every AQUA route; tests that mount a route
 * module on their own app mount it the same way.
 */
export const dataClassScope = dataClass => (req, res, next) => runWithDataClass(dataClass, next);

/**
 * TESTS ONLY — declare the class of a test file's fixture content: opens a
 * root scope for the rest of the calling module's execution (node:test runs
 * each file in its own process). Production code opens scopes at its entry
 * points (dataClassScope, runWithDataClass) and never calls this.
 */
export function _enterDataClassForTests(dataClass) {
  als.enterWith({ classes: new Set([String(dataClass)]), parent: null });
}
