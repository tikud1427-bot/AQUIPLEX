/**
 * Shared isolation + fixtures for the Connect Engine tests (Phase 1b).
 *
 * Importing this module FIRST (before any engine module) gives the test file:
 *   · a fresh temporary AQUA_DATA_DIR, no database, no Mongo mirror, no provider keys
 *   · a deterministic offline embedder (identical text → identical vector)
 *   · a test registry that allows the test-only fake connector
 *   · an in-memory connection store and a credential vault with a test key
 *     generated per process (never an environment value)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-connect-'));
process.env.AQUA_DATA_DIR = TMP;
process.env.AQUA_ARTIFACTS_DIR = path.join(TMP, 'artifacts');
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AQUA_') && !['AQUA_DATA_DIR', 'AQUA_ARTIFACTS_DIR'].includes(k)) delete process.env[k];
  if (/(_API_KEY|^GEMINI|^GOOGLE)/.test(k)) delete process.env[k];
}
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
delete process.env.DATABASE_URL;

const prov = await import('../../embeddings/embeddingProvider.js');
prov.__setEmbedderForTests(async texts => texts.map(t => {
  const v = new Array(32).fill(0);
  for (const w of String(t).toLowerCase().split(/\W+/)) if (w) v[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 32] += 1;
  return v;
}));

export const { createConnectorRegistry, defaultRegistry } = await import('../registry.js');
export const { createMemoryConnectionStore, createMongoConnectionStore } = await import('../connectionStore.js');
export const { createCredentialVault, parseConnectorKey } = await import('../credentialVault.js');
export const { createConnectService, ConnectError } = await import('../connectService.js');
export const { createFakeWorld, createFakeConnector } = await import('../testing/fakeConnector.js');
export const external = await import('../../files/externalSources.js');

export const TEST_KEY = crypto.randomBytes(32);
const noSleep = () => Promise.resolve();

/** A complete, isolated connect stack over a fresh fake world. */
export function stack({ connectorOverrides = {}, world: w = null, logs = null, now = null } = {}) {
  const world = w ?? createFakeWorld(now ? { now } : {});
  const registry = createConnectorRegistry({ allowTestOnly: true });
  const connector = createFakeConnector({ world, overrides: connectorOverrides });
  registry.register(connector);
  const store = createMemoryConnectionStore();
  const vault = createCredentialVault({ key: TEST_KEY });
  const log = logs ? { log: (...a) => logs.push(a.join(' ')) } : { log: () => {} };
  // trustRawUserId: these tests act as a trusted server-side caller. Routes must use principals (principal.js; IS-1).
  const service = createConnectService({ registry, store, vault, retry: { sleep: noSleep, baseMs: 0 }, log, trustRawUserId: true, ...(now ? { now } : {}) });
  return { world, registry, connector, store, vault, service };
}

let n = 0;
export const freshUser = tag => `u-${tag}-${process.pid}-${++n}`;
export const ownerOf = userId => `user:${userId}`;
export const settle = (ms = 80) => new Promise(r => setTimeout(r, ms));

export const doc = (token, extra = '') =>
  `Project ${token} is an offline-first note app built by Priya Sharma at Acme Corp. ${extra} ` +
  `The ${token} launch date is March 15, 2026. Contact priya@acme.example about ${token}.`;

/** Every file under the test data dir, as text (to prove what is — and is not — at rest). */
export function dataDirText() {
  const out = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else { try { out.push(fs.readFileSync(p, 'utf8')); } catch { /* binary */ } }
    }
  };
  walk(TMP);
  return out.join('\n');
}
