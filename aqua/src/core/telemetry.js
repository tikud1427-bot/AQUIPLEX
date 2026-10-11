/**
 * AQUA — E12: tracing and error reporting behind interfaces (2026-10-04).
 *
 * Blueprint E12 asks for traces per turn and PII-scrubbed error tracking. The
 * real backends (an OpenTelemetry collector, an error-tracking service) are
 * external infrastructure this repository does not have, so this module is the
 * SEAM, not a fake of them:
 *
 *   startSpan(name, attrs) / withSpan(name, attrs, fn)
 *       every attribute passes sanitizeSpanAttributes (allowlisted keys,
 *       identifier-shaped values — free text cannot ride in). Finished spans go
 *       to the configured exporter; per-stage count/sum/max latency and error
 *       counts are kept for /metrics.
 *   reportError(err, { where, ownerId })
 *       the message is scrubbed (emails, long digit runs, quoted text, URLs with
 *       query strings), the owner is hashed, the stack is trimmed to frames —
 *       then handed to the configured sink.
 *
 *   setSpanExporter(fn) / setErrorSink(fn)
 *       where a real OTel exporter or error tracker plugs in. The defaults keep
 *       a bounded in-memory ring (G6) — useful locally, honestly NOT a backend.
 *
 * Observability never fails the thing it observes: every path is try/caught.
 */
import { sanitizeSpanAttributes, hashOwner } from './spanAttributes.js';

const RING = 200;
const recentSpans = [];
const recentErrors = [];
const stageStats = new Map();   // stage → { count, sumMs, maxMs, errors }
const errorCounts = new Map();  // where → n

let spanExporter = span => { recentSpans.push(span); if (recentSpans.length > RING) recentSpans.shift(); };
let errorSink = rec => { recentErrors.push(rec); if (recentErrors.length > RING) recentErrors.shift(); };

export function setSpanExporter(fn) { if (typeof fn === 'function') spanExporter = fn; }
export function setErrorSink(fn) { if (typeof fn === 'function') errorSink = fn; }

const STAGE = /^[a-z0-9._-]{1,48}$/;

export function startSpan(name, attrs = {}) {
  const stage = STAGE.test(String(name)) ? String(name) : 'invalid_stage';
  const started = performance.now();
  const { attributes, dropped } = sanitizeSpanAttributes(attrs);
  let status = 'ok';
  let ended = false;
  return {
    setAttribute(key, value) {
      const r = sanitizeSpanAttributes({ [key]: value });
      Object.assign(attributes, r.attributes);
      dropped.push(...r.dropped);
    },
    setStatus(s) { status = s === 'error' ? 'error' : 'ok'; },
    end() {
      if (ended) return;
      ended = true;
      const ms = performance.now() - started;
      try {
        const s = stageStats.get(stage) ?? { count: 0, sumMs: 0, maxMs: 0, errors: 0 };
        s.count++; s.sumMs += ms; s.maxMs = Math.max(s.maxMs, ms); if (status === 'error') s.errors++;
        stageStats.set(stage, s);
        spanExporter({ name: stage, durationMs: Number(ms.toFixed(2)), status, attributes, dropped: [...dropped], endedAt: Date.now() });
      } catch { /* never fail the observed path */ }
    },
  };
}

export async function withSpan(name, attrs, fn) {
  const span = startSpan(name, attrs);
  try { return await fn(span); } catch (err) { span.setStatus('error'); throw err; } finally { span.end(); }
}

const SCRUB = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'],
  [/https?:\/\/[^\s?]+\?\S*/g, '<url>'],
  [/\b\d{6,}\b/g, '<number>'],
  [/"[^"]{3,}"/g, '"<text>"'],
  [/'[^']{3,}'/g, "'<text>'"],
  [/\b(?:sk|gsk|AIza|ghp|xox[bp])[-_A-Za-z0-9]{8,}\b/g, '<secret>'],
];
export function scrubMessage(message) {
  let m = String(message ?? '').slice(0, 500);
  for (const [re, rep] of SCRUB) m = m.replace(re, rep);
  return m;
}

export function reportError(err, { where = 'unknown', ownerId = null } = {}) {
  try {
    const place = STAGE.test(String(where)) ? String(where) : 'unknown';
    errorCounts.set(place, (errorCounts.get(place) ?? 0) + 1);
    const frames = String(err?.stack ?? '').split('\n').slice(1, 6)
      .map(l => l.trim().replace(/\(.*[\\/](src|scripts)[\\/]/, '($1/')).filter(Boolean);
    errorSink({
      where: place,
      code: typeof err?.code === 'string' ? err.code.slice(0, 48) : null,
      message: scrubMessage(err?.message ?? err),
      ownerHash: hashOwner(ownerId),
      frames,
      at: Date.now(),
    });
  } catch { /* never fail the observed path */ }
}

export function getTelemetryMetrics() {
  return {
    stages: Object.fromEntries([...stageStats].map(([k, v]) => [k, { ...v,
      avgMs: v.count ? Number((v.sumMs / v.count).toFixed(2)) : 0 }])),
    errors: Object.fromEntries(errorCounts),
  };
}

export const _recentSpansForTests = () => [...recentSpans];
export const _recentErrorsForTests = () => [...recentErrors];
export function _resetTelemetryForTests() {
  recentSpans.length = 0; recentErrors.length = 0; stageStats.clear(); errorCounts.clear();
  spanExporter = span => { recentSpans.push(span); if (recentSpans.length > RING) recentSpans.shift(); };
  errorSink = rec => { recentErrors.push(rec); if (recentErrors.length > RING) recentErrors.shift(); };
}
