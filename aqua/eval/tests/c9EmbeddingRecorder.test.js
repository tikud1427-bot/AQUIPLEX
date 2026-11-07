/**
 * The C9 recorder's guards (scripts/record-c9-embeddings.mjs), 2026-11-07.
 * No network: the script runs under a tripwire that kills the process on any
 * socket, HTTP or fetch attempt. The response validator is fed malformed
 * shapes to prove it rejects them — those arrays are probes of the validator,
 * never fixture data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AQUA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(AQUA, 'scripts/record-c9-embeddings.mjs');
const R = await import(pathToFileURL(SCRIPT).href);

const TRIPWIRE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-c9-tripwire-')), 'tripwire.mjs');
fs.writeFileSync(TRIPWIRE, [
  "import https from 'node:https'; import http from 'node:http'; import net from 'node:net'; import tls from 'node:tls';",
  "const hit = w => { process.stderr.write(`TRIPWIRE HIT: ${w}\\n`); process.exit(99); };",
  "globalThis.fetch = () => hit('fetch');",
  "for (const m of [https, http]) { m.request = () => hit('http.request'); m.get = () => hit('http.get'); }",
  "net.connect = net.createConnection = () => hit('net.connect'); tls.connect = () => hit('tls.connect');",
].join('\n'));

/** The script's environment: no credential of any kind. */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD|GEMINI|GOOGLE/i.test(k)) delete env[k];
  return { ...env, ...extra };
}
const run = (args, env) => spawnSync(process.execPath, ['--import', pathToFileURL(TRIPWIRE).href, SCRIPT, ...args], { cwd: AQUA, env, encoding: 'utf8', timeout: 60_000 });
const fixtureDir = path.join(AQUA, 'eval/fixtures');
const listing = () => fs.readdirSync(fixtureDir).sort().join('\n');

test('dry run: plans the bounded run, makes zero network requests and writes nothing', () => {
  const before = listing();
  const r = run([], cleanEnv());
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /TRIPWIRE HIT/);
  assert.match(r.stdout, /DRY RUN/);
  assert.match(r.stdout, /gemini-embedding-001 · 768 dims/);
  assert.match(r.stdout, /dry run complete: 0 network requests/);
  assert.match(r.stdout, /requests of ≤64 texts/);
  assert.equal(listing(), before, 'the dry run wrote nothing');
});

test('live run without the dedicated key: refused before any request, no attempt record written', () => {
  const before = listing();
  const r = run(['--live'], cleanEnv());
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stderr, /TRIPWIRE HIT/, 'refused before touching the network');
  assert.match(r.stderr, /REFUSED/);
  assert.equal(listing(), before);
});

test('live run with a shared key under the dedicated name: refused (isolation), and the value never appears', () => {
  const fakeShared = 'NOTAREALKEY0123456789abcdefghijklmnopqrstu';   // a probe string, not a credential
  const r = run(['--live'], cleanEnv({ AQUA_EMBEDDING_API_KEY: fakeShared, GEMINI_KEY_1: fakeShared }));
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stderr, /TRIPWIRE HIT/);
  assert.ok(!r.stdout.includes(fakeShared) && !r.stderr.includes(fakeShared), 'the value is never printed');
});

test('credential check: reads only AQUA_EMBEDDING_API_KEY and reports reasons, never the value', () => {
  assert.equal(R.checkCredential({}).ok, false);
  assert.equal(R.checkCredential({ GEMINI_API_KEY: 'x'.repeat(40) }).ok, false, 'no fallback to another variable');
  assert.equal(R.checkCredential({ AQUA_EMBEDDING_API_KEY: 'short' }).ok, false);
  assert.equal(R.checkCredential({ AQUA_EMBEDDING_API_KEY: 'a'.repeat(40) }).ok, false, 'placeholder: too few distinct characters');
  assert.equal(R.checkCredential({ AQUA_EMBEDDING_API_KEY: 'has spaces and !! symbols in it 0123456789' }).ok, false);
  const probe = 'NOTAREALKEY0123456789abcdefghijklmnopqrstu';
  assert.equal(R.checkCredential({ AQUA_EMBEDDING_API_KEY: probe, GOOGLE_API_KEY: probe }).ok, false, 'equal to a shared variable');
  const ok = R.checkCredential({ AQUA_EMBEDDING_API_KEY: probe });
  assert.equal(ok.ok, true);
  assert.ok(!JSON.stringify(ok).includes(probe));
});

test('pins: the recorder and production embed with gemini-embedding-001 at 768; an override is refused', async () => {
  assert.deepEqual(await R.checkPins({}), []);
  assert.equal((await R.checkPins({ AQUA_EMBED_MODEL: 'text-embedding-004' })).length, 1);
  assert.equal((await R.checkPins({ AQUA_EMBED_DIM: '1536' })).length, 1);
});

test('response validation rejects every malformed shape and never repairs one', () => {
  const good = Array.from({ length: R.DIM }, (_, i) => (i % 7) / 10 - 0.3);
  assert.equal(R.validateResponse({ embeddings: [{ values: good }] }, 1).length, 1);
  assert.throws(() => R.validateResponse({}, 1), /no embeddings/);
  assert.throws(() => R.validateResponse({ embeddings: [{ values: good }] }, 2), /1 embeddings for 2 inputs/);
  assert.throws(() => R.validateResponse({ embeddings: [{ values: good.slice(0, 767) }] }, 1), /767 dimensions/);
  assert.throws(() => R.validateResponse({ embeddings: [{ values: [...good.slice(0, 767), NaN] }] }, 1), /non-finite/);
  assert.throws(() => R.validateResponse({ embeddings: [{ values: new Array(R.DIM).fill(0) }] }, 1), /all zeros/);
  assert.throws(() => R.validateResponse({ embeddings: [{}] }, 1), /no values/);
});

test('error text is scrubbed of credential values', () => {
  const probe = 'NOTAREALKEY0123456789abcdefghijklmnopqrstu';
  assert.equal(R.scrub(`401 for key ${probe}`, { AQUA_EMBEDDING_API_KEY: probe }), '401 for key [redacted]');
  assert.equal(R.scrub('bad AIzaSyA1234567890abcdefghijklmno', {}), 'bad [redacted]');
});
