/**
 * Machine scrape for Prometheus — E12, 2026-10-05.
 *
 * The exposition lives at /api/aqua/provider-health/metrics, behind the
 * platform's requireLogin (a browser session). A Prometheus server has no
 * session, so in production nothing could scrape it and every alert in
 * ops/prometheus/aqua-alerts.yml was blind.
 *
 * This is the narrowest machine path that does not weaken app authentication:
 *   · OFF unless AQUA_METRICS_TOKEN is set — then 404, nothing is exposed;
 *   · a token shorter than 32 characters is refused at request time (404 +
 *     one warning), so a placeholder can never open it;
 *   · `Authorization: Bearer <token>`, compared in constant time; the token
 *     is never logged or echoed;
 *   · it serves exactly the same exposition (`sendPrometheus`) — owners appear
 *     only as 12-hex hashes there (spanAttributes.js), no user content.
 *
 * Prometheus: `authorization: { type: Bearer, credentials_file: … }`.
 */
import crypto from 'node:crypto';
import { sendPrometheus } from './health.js';

const MIN_TOKEN = 32;
let warnedWeak = false;

const digest = s => crypto.createHash('sha256').update(String(s)).digest();

/** true / false, or null when machine scraping is not enabled. */
export function scrapeAuthorized(authHeader, token = process.env.AQUA_METRICS_TOKEN) {
  const expected = String(token ?? '');
  if (!expected) return null;
  if (expected.length < MIN_TOKEN) {
    if (!warnedWeak) { console.warn(`[METRICS] AQUA_METRICS_TOKEN is shorter than ${MIN_TOKEN} characters — machine scrape disabled`); warnedWeak = true; }
    return null;
  }
  const m = /^Bearer\s+(.+)$/i.exec(String(authHeader ?? '').trim());
  if (!m) return false;
  // Equal-length digests, so timingSafeEqual never throws and length leaks nothing.
  return crypto.timingSafeEqual(digest(m[1]), digest(expected));
}

/** Express handler for GET /metrics on the platform server. */
export function metricsScrape({ send = sendPrometheus, token } = {}) {
  return async (req, res) => {
    const ok = scrapeAuthorized(req.get?.('authorization') ?? req.headers?.authorization, token ?? process.env.AQUA_METRICS_TOKEN);
    if (ok === null) return res.status(404).type('text/plain').send('Not found');
    if (!ok) return res.status(401).set('WWW-Authenticate', 'Bearer').type('text/plain').send('Unauthorized');
    res.set('Cache-Control', 'no-store');
    return send(req, res);
  };
}
