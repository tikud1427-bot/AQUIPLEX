/**
 * F1 TEST-ONLY preload for the real index.js child (node --import <this>).
 *
 * Replaces globalThis.fetch BEFORE the app loads:
 *   oauth2.googleapis.com, gmail.googleapis.com  → the test's fake Google at
 *     F1_FAKE_GOOGLE_URL (loopback), path prefixed with the original host;
 *   127.0.0.1 / localhost                         → the real fetch;
 *   anything else                                 → refused, and one line
 *     "[F1-EGRESS] <host>" is written to stderr (the test asserts there is none).
 * http(s).request to a non-loopback host is refused the same way.
 *
 * Never imported by production code (the boundary test in gmailConnector.test.js
 * walks src/ excluding tests/). Reads only F1_FAKE_GOOGLE_URL.
 */
import http from 'node:http';
import https from 'node:https';

const FAKE = process.env.F1_FAKE_GOOGLE_URL;
if (!FAKE || !/^http:\/\/127\.0\.0\.1:\d+$/.test(FAKE)) {
  process.stderr.write('[F1-PRELOAD] refusing: F1_FAKE_GOOGLE_URL must be a loopback URL\n');
  process.exit(3);
}
const GOOGLE = new Set(['oauth2.googleapis.com', 'gmail.googleapis.com']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const realFetch = globalThis.fetch;

globalThis.fetch = async function f1Fetch(input, init = {}) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (GOOGLE.has(url.hostname)) {
    if (url.protocol !== 'https:') { process.stderr.write(`[F1-EGRESS] non-https google ${url.hostname}\n`); throw new Error('refused'); }
    return realFetch(`${FAKE}/${url.hostname}${url.pathname}${url.search}`, { ...init, redirect: init.redirect ?? 'error' });
  }
  if (LOOPBACK.has(url.hostname)) return realFetch(input, init);
  process.stderr.write(`[F1-EGRESS] ${url.hostname}\n`);
  throw new Error('network refused in the F1 test');
};

for (const mod of [http, https]) {
  const orig = mod.request;
  mod.request = function (opts, ...rest) {
    let host = '';
    try { host = typeof opts === 'string' ? new URL(opts).hostname : opts instanceof URL ? opts.hostname : (opts?.hostname ?? opts?.host ?? ''); } catch { host = '?'; }
    host = String(host).replace(/:\d+$/, '');
    if (host && !LOOPBACK.has(host)) { process.stderr.write(`[F1-EGRESS] ${mod === https ? 'https' : 'http'} ${host}\n`); throw new Error('network refused in the F1 test'); }
    return orig.call(this, opts, ...rest);
  };
}
process.stderr.write('[F1-PRELOAD] fetch routed: Google → fake, loopback → real, everything else refused\n');
