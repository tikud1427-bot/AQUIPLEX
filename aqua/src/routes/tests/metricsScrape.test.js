/**
 * Prometheus machine scrape (E12, 2026-10-05).
 *
 * The exposition sat behind requireLogin — a browser session — so no scraper
 * could reach it and the alert rules were blind in production. The machine
 * path takes a bearer token instead, is OFF without one, and must never become
 * a way round the app's own authentication.
 */
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { metricsScrape, scrapeAuthorized } = await import('../metricsScrape.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'a'.repeat(20) + '-scrape-token-0123456789';

let server, base;
const sent = [];
const app = express();
app.get('/metrics', metricsScrape({ token: TOKEN, send: (req, res) => { sent.push(1); res.type('text/plain').send('aqua_requests_total 1\n'); } }));
app.get('/metrics-off', metricsScrape({ token: '', send: () => { throw new Error('must not send'); } }));

before(async () => { await new Promise(r => { server = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${server.address().port}`; });
after(() => new Promise(r => server.close(r)));
const get = (p, auth) => fetch(base + p, { headers: auth ? { authorization: auth } : {} });

describe('GET /metrics — machine scrape', () => {
  test('the right bearer token gets the exposition', async () => {
    const r = await get('/metrics', `Bearer ${TOKEN}`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /aqua_requests_total/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });

  test('no token, a wrong token, or another scheme is 401 and sends nothing', async () => {
    const before = sent.length;
    for (const auth of [null, 'Bearer nope', `Basic ${TOKEN}`, `Bearer ${TOKEN}x`]) {
      const r = await get('/metrics', auth);
      assert.equal(r.status, 401, `auth=${auth}`);
      assert.doesNotMatch(await r.text(), new RegExp(TOKEN), 'the token is never echoed');
    }
    assert.equal(sent.length, before);
  });

  test('without AQUA_METRICS_TOKEN the route does not exist (404)', async () => {
    assert.equal((await get('/metrics-off', `Bearer ${TOKEN}`)).status, 404);
  });

  test('a short token can never open it', () => {
    assert.equal(scrapeAuthorized('Bearer short', 'short'), null);
    assert.equal(scrapeAuthorized(`Bearer ${TOKEN}`, TOKEN), true);
  });

  test('the platform mounts it BEFORE the session-gated /api/aqua, and only at /metrics', () => {
    const src = fs.readFileSync(path.resolve(HERE, '..', '..', '..', '..', 'index.js'), 'utf8');
    const mount = src.indexOf('app.get("/metrics"');
    const gate = src.indexOf('app.use("/api/aqua", ...aquaAccess)');
    assert.ok(mount > 0 && gate > 0 && mount < gate, 'machine scrape must not sit behind requireLogin');
    assert.match(src.slice(mount, mount + 300), /metricsScrape\(\)/);
  });

  test('both routes serve the same exposition', () => {
    const health = fs.readFileSync(path.resolve(HERE, '..', 'health.js'), 'utf8');
    assert.match(health, /router\.get\('\/metrics', \(req, res\) => sendPrometheus\(req, res\)\)/);
    assert.match(fs.readFileSync(path.resolve(HERE, '..', 'metricsScrape.js'), 'utf8'), /import \{ sendPrometheus \} from '\.\/health\.js'/);
  });
});
