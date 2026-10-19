#!/usr/bin/env node
/**
 * Records the E6 replay fixture for the `context-canonical` gate suite.
 *
 *   AQUA_TEST_DATABASE_URL=postgresql://…/<disposable db> node eval/fixtures/recordCanonicalWorld.mjs
 *
 * Passes the 60 retrieval-core statements through the PRODUCTION understanding
 * path (Brain.understandTurn) with the PRODUCTION E6 transport, and stores each
 * raw model output keyed by the exact request. The gate then replays them
 * offline (eval/adapters/canonicalContextRetrieval.mjs). Re-record only when the
 * extraction prompt or segmentation changes — and say so in the PR, because the
 * suite's baseline moves with the recording.
 *
 * Needs provider keys (read from the root .env) and a DISPOSABLE Postgres. It
 * never uses .env's DATABASE_URL or MONGO_URI.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const target = String(process.env.AQUA_TEST_DATABASE_URL ?? '').trim();
if (!target) { console.error('AQUA_TEST_DATABASE_URL (a disposable test database) is required'); process.exit(2); }

// Provider keys come from .env; the database and the mirror never do.
createRequire(import.meta.url)('dotenv').config({ path: path.join(HERE, '../../../.env') });
process.env.DATABASE_URL = target;
process.env.MONGO_URI = '';
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';

const A = await import('../adapters/canonicalContextRetrieval.mjs');
const Brain = await import('../../src/brain/index.js');
const { closePool } = await import('../../src/core/db/pool.js');
// `--world heldout` records the frozen held-out set (2026-10-17); default is the
// development world, recorded exactly as before.
const world = process.argv.includes('--world') ? process.argv[process.argv.indexOf('--world') + 1] : 'core';
const DATASETS = { core: 'retrieval-core.v1.json', heldout: 'retrieval-heldout.v1.json' };
if (!DATASETS[world]) { console.error(`unknown --world ${world}`); process.exit(2); }
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets', DATASETS[world]), 'utf8'));

const real = await Brain.e6Transport();
const { provider, model } = await Brain.e6TransportConfig();
const calls = {};
const requests = {};
let n = 0, failures = 0;
const recording = async (req) => {
  n++;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await real(req);
      const text = typeof res === 'string' ? res : res?.text;
      if (typeof text !== 'string' || !text.trim()) throw new Error('empty response');
      calls[A.replayKey(req)] = text;
      // The normalised request is kept so a later normalisation change can be
      // re-keyed offline from `requests` instead of spending provider quota.
      requests[A.replayKey(req)] = A.normaliseRequest(req);
      return { text };
    } catch (err) {
      console.warn(`  call ${n} attempt ${attempt}: ${err?.message ?? err}`);
      if (attempt === 4) { failures++; throw err; }
      await new Promise(r => setTimeout(r, 4000 * attempt));
    }
  }
};

const reports = await A.ingestCorpusViaE6(DS.corpus, recording, { world });
const outFile = A.CANONICAL_WORLDS[world].fixture;
writeFileSync(outFile, `${JSON.stringify({
  about: `Recorded E6 extractor outputs for the ${DS.id} corpus, replayed by the canonical context gate suite.`,
  recordedAt: new Date().toISOString(),
  provider, model,
  dataset: `${DS.id}.v${DS.version}`,
  callCount: Object.keys(calls).length,
  failedCalls: failures,
  turnsWithErrors: reports.filter(r => r.report?.errors?.length || r.report?.error).length,
  calls,
  requests,
}, null, 2)}\n`);
console.log(`recorded ${Object.keys(calls).length} call(s) from ${provider}/${model}; failures=${failures} → ${path.basename(outFile)}`);
await closePool();
