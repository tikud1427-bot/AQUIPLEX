#!/usr/bin/env node
/**
 * Records the C9 embedding fixture — ONE bounded run, real vectors, nothing
 * simulated (2026-11-07).
 *
 *   node scripts/record-c9-embeddings.mjs            DRY RUN (default): validates the
 *                                                    dataset, pins, credential shape and
 *                                                    plan. Zero network: the provider SDK
 *                                                    is never even loaded. Writes nothing.
 *   node scripts/record-c9-embeddings.mjs --live     the one live run (needs approval)
 *
 * What a live run does, and refuses to do:
 *   · embeds the UNIQUE texts of eval/datasets/c9-semantic-relevance.dev.v1.json
 *     with gemini-embedding-001 at 768 dimensions — the exact call production
 *     makes (src/embeddings/dedicatedEmbedder.js: embedContent, outputDimensionality,
 *     no task type) — in batches of 64;
 *   · uses ONLY process.env.AQUA_EMBEDDING_API_KEY. No other variable is read as a
 *     credential and there is no fallback; a key equal to any GEMINI / GOOGLE
 *     variable in the session is refused (isolation);
 *   · never prints, logs or writes the key; every error message is scrubbed;
 *   · validates every response: count, 768 finite numbers, not all zero;
 *   · stops at the first failure and does NOT retry. The run leaves an attempt
 *     record (no vectors) that refuses any later live run until a person
 *     removes it — "do not repeat the API run if it fails";
 *   · writes the fixture only when every vector is valid, atomically (tmp →
 *     rename); never overwrites an existing fixture.
 *
 * The dataset hash must match eval/datasets/c9-semantic-relevance.dev.v1.sha256,
 * and the dataset must be what scripts/build-c9-semantic-dataset.mjs builds.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MODEL = 'gemini-embedding-001';
export const DIM = 768;
export const BATCH = 64;
export const KEY_ENV = 'AQUA_EMBEDDING_API_KEY';

const AQUA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATASET = path.join(AQUA, 'eval/datasets/c9-semantic-relevance.dev.v1.json');
export const DATASET_SHA = path.join(AQUA, 'eval/datasets/c9-semantic-relevance.dev.v1.sha256');
export const FIXTURE = path.join(AQUA, 'eval/fixtures/c9-semantic-relevance.embeddings.v1.json');
export const ATTEMPT = path.join(AQUA, 'eval/fixtures/c9-semantic-relevance.embeddings.v1.attempt.json');

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
export const textKey = text => sha256(Buffer.from(String(text), 'utf8'));

/**
 * Is the dedicated credential usable? Reads only `env[KEY_ENV]`. Returns a
 * reason, never the value. The shape rules are the ones semantic-recall-live-v2
 * used; shape is never proof of validity — the provider decides that.
 */
export function checkCredential(env = process.env) {
  const key = String(env[KEY_ENV] ?? '').trim();
  if (!key) return { ok: false, reason: `${KEY_ENV} is not set` };
  if (key.length < 30) return { ok: false, reason: `${KEY_ENV} is too short to be a key (placeholder?)` };
  if (!/^[A-Za-z0-9._-]+$/.test(key)) return { ok: false, reason: `${KEY_ENV} contains characters a key does not` };
  if (new Set(key).size < 12) return { ok: false, reason: `${KEY_ENV} has too few distinct characters (placeholder?)` };
  const clash = Object.entries(env).find(([k, v]) => k !== KEY_ENV && /GEMINI|GOOGLE/i.test(k) && String(v ?? '').trim() === key);
  if (clash) return { ok: false, reason: `${KEY_ENV} equals another provider variable (${clash[0]}) — not a dedicated key` };
  return { ok: true, reason: 'set; shape plausible; not equal to any GEMINI/GOOGLE variable' };
}

/** The model and dimension production embeds with must be the pinned ones. */
export async function checkPins(env = process.env) {
  const problems = [];
  if (env.AQUA_EMBED_MODEL && env.AQUA_EMBED_MODEL !== MODEL) problems.push(`AQUA_EMBED_MODEL=${env.AQUA_EMBED_MODEL} overrides the pinned ${MODEL}`);
  if (env.AQUA_EMBED_DIM && Number(env.AQUA_EMBED_DIM) !== DIM) problems.push(`AQUA_EMBED_DIM=${env.AQUA_EMBED_DIM} overrides the pinned ${DIM}`);
  const prod = await import(pathToFileURL(path.join(AQUA, 'src/embeddings/embeddingModel.js')).href);
  if (prod.EMBED_MODEL !== MODEL) problems.push(`production EMBED_MODEL is ${prod.EMBED_MODEL}, not ${MODEL}`);
  if (Number(prod.EMBED_DIM) !== DIM) problems.push(`production EMBED_DIM is ${prod.EMBED_DIM}, not ${DIM}`);
  return problems;
}

/** The dataset on disk, its hash, and its unique texts in first-seen order. */
export function loadDataset() {
  const body = fs.readFileSync(DATASET);
  const sha = sha256(body);
  const recorded = fs.existsSync(DATASET_SHA) ? fs.readFileSync(DATASET_SHA, 'utf8').trim().split(/\s+/)[0] : null;
  const d = JSON.parse(body.toString('utf8'));
  const entries = [...d.statements, ...d.queries];
  const unique = [];
  const seen = new Set();
  for (const e of entries) { const k = textKey(e.text); if (!seen.has(k)) { seen.add(k); unique.push(e.text); } }
  return { dataset: d, sha, recorded, entries, unique };
}

/**
 * One response → its vectors, or a thrown Error naming what is wrong. Never
 * repairs, pads, truncates or substitutes anything.
 */
export function validateResponse(res, expected) {
  const list = res?.embeddings;
  if (!Array.isArray(list)) throw new Error('response has no embeddings array');
  if (list.length !== expected) throw new Error(`response has ${list.length} embeddings for ${expected} inputs`);
  return list.map((e, i) => {
    const v = e?.values;
    if (!Array.isArray(v)) throw new Error(`embedding ${i} has no values`);
    if (v.length !== DIM) throw new Error(`embedding ${i} has ${v.length} dimensions, expected ${DIM}`);
    if (!v.every(x => typeof x === 'number' && Number.isFinite(x))) throw new Error(`embedding ${i} has a non-finite value`);
    if (v.every(x => x === 0)) throw new Error(`embedding ${i} is all zeros`);
    return v;
  });
}

/** Digest of the recorded vectors, over a canonical order (keys sorted). */
export function vectorsDigest(vectors) {
  const h = crypto.createHash('sha256');
  for (const k of Object.keys(vectors).sort()) h.update(k).update(':').update(JSON.stringify(vectors[k])).update('\n');
  return h.digest('hex');
}

/** Remove every credential-like value of the environment from a message. */
export function scrub(text, env = process.env) {
  let s = String(text ?? '');
  const secrets = Object.entries(env).filter(([k, v]) => v && String(v).length >= 8 && /KEY|TOKEN|SECRET|PASSWORD/i.test(k)).map(([, v]) => String(v).trim()).sort((a, b) => b.length - a.length);
  for (const v of secrets) s = s.split(v).join('[redacted]');
  return s.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]').replace(/AQ\.[0-9A-Za-z_.-]{20,}/g, '[redacted]').slice(0, 300);
}

async function main() {
  const live = process.argv.includes('--live');
  const out = [];
  const say = s => { out.push(s); console.log(s); };
  const fail = (code, s) => { console.error(`REFUSED: ${s}`); process.exit(code); };

  const { dataset, sha, recorded, entries, unique } = loadDataset();
  if (!recorded) fail(2, `no recorded dataset hash (${path.relative(AQUA, DATASET_SHA)})`);
  if (recorded !== sha) fail(2, `dataset hash ${sha} does not match the recorded ${recorded}`);
  const pins = await checkPins();
  if (pins.length) fail(2, pins.join('; '));
  const cred = checkCredential();
  const requests = Math.ceil(unique.length / BATCH);
  const fixtureExists = fs.existsSync(FIXTURE);
  const attemptExists = fs.existsSync(ATTEMPT);

  say(`${live ? 'LIVE' : 'DRY RUN (no network, nothing written)'} · ${MODEL} · ${DIM} dims · no task type (as production)`);
  say(`dataset ${dataset.id} · sha256 ${sha} (matches recorded) · ${entries.length} entries · ${unique.length} unique texts`);
  say(`plan: ${requests} requests of ≤${BATCH} texts · hard cap ${requests} · stop at first failure · no retry`);
  say(`credential ${KEY_ENV}: ${cred.ok ? 'usable' : 'NOT usable'} — ${cred.reason}`);
  say(`fixture: ${path.relative(AQUA, FIXTURE)} ${fixtureExists ? 'EXISTS (a live run would refuse)' : 'absent'} · attempt record ${attemptExists ? 'EXISTS (a live run would refuse)' : 'absent'}`);
  if (!live) { say('dry run complete: 0 network requests'); return; }

  if (fixtureExists) fail(3, 'the fixture already exists; it is never overwritten');
  if (attemptExists) fail(3, `an earlier live attempt is recorded (${path.relative(AQUA, ATTEMPT)}); a run is not repeated without a person removing it`);
  if (!cred.ok) fail(2, cred.reason);

  // The attempt record is written BEFORE the first request: a crash mid-run still blocks a repeat.
  const attempt = { about: 'One live C9 recording attempt. Holds no vectors and no credential. A later live run refuses while this file exists.', startedAt: new Date().toISOString(), model: MODEL, dim: DIM, datasetSha256: sha, plannedRequests: requests, requests: [], outcome: 'running' };
  const writeAttempt = () => fs.writeFileSync(ATTEMPT, JSON.stringify(attempt, null, 2) + '\n');
  writeAttempt();

  const { GoogleGenAI } = await import('@google/genai');
  const client = new GoogleGenAI({ apiKey: String(process.env[KEY_ENV]).trim() });
  const vectors = {};
  try {
    for (let r = 0; r < requests; r++) {
      const chunk = unique.slice(r * BATCH, (r + 1) * BATCH);
      const t0 = Date.now();
      let res;
      try {
        res = await client.models.embedContent({ model: MODEL, contents: chunk, config: { outputDimensionality: DIM } });
      } catch (err) {
        const status = Number(err?.status ?? err?.code) || null;
        attempt.requests.push({ n: r + 1, inputs: chunk.length, ms: Date.now() - t0, ok: false, status, error: scrub(err?.message ?? err) });
        throw new Error(`request ${r + 1} failed (status ${status ?? 'n/a'}): ${scrub(err?.message ?? err)}`);
      }
      let vs;
      try { vs = validateResponse(res, chunk.length); } catch (err) {
        attempt.requests.push({ n: r + 1, inputs: chunk.length, ms: Date.now() - t0, ok: false, error: `invalid response: ${err.message}` });
        throw new Error(`request ${r + 1}: invalid response: ${err.message}`);
      }
      attempt.requests.push({ n: r + 1, inputs: chunk.length, ms: Date.now() - t0, ok: true });
      chunk.forEach((t, j) => { vectors[textKey(t)] = vs[j]; });
      writeAttempt();
      say(`request ${r + 1}/${requests}: ${chunk.length} vectors ok (${Date.now() - t0} ms)`);
    }
  } catch (err) {
    attempt.outcome = 'failed'; attempt.finishedAt = new Date().toISOString(); attempt.error = scrub(err.message);
    writeAttempt();
    console.error(`FAILED — no fixture written, not retried: ${scrub(err.message)}`);
    process.exit(4);
  }

  if (Object.keys(vectors).length !== unique.length) { attempt.outcome = 'failed'; attempt.error = 'vector count mismatch'; writeAttempt(); console.error('FAILED: vector count mismatch'); process.exit(4); }
  const sdk = JSON.parse(fs.readFileSync(path.join(AQUA, 'node_modules/@google/genai/package.json'), 'utf8')).version;
  const fixture = {
    about: 'C9 semantic-relevance embedding fixture: REAL vectors returned by the provider in one recording run, replayed offline by eval/fixtures/c9EmbeddingFixture.mjs. Never edit by hand; never regenerate silently.',
    model: MODEL, modelVersion: `${MODEL} (Gemini API embedContent; model id as served)`, dim: DIM, taskType: null,
    recordedAt: new Date().toISOString(),
    dataset: { id: dataset.id, path: 'eval/datasets/c9-semantic-relevance.dev.v1.json', sha256: sha },
    script: { path: 'scripts/record-c9-embeddings.mjs', sha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))) },
    sdk: { name: '@google/genai', version: sdk },
    credential: `${KEY_ENV} only (dedicated; value never recorded)`,
    requestCount: attempt.requests.length,
    requests: attempt.requests,
    reproduce: 'node scripts/build-c9-semantic-dataset.mjs --check && node scripts/record-c9-embeddings.mjs (dry run) && (with approval) node scripts/record-c9-embeddings.mjs --live',
    keyedBy: 'sha256 of the UTF-8 text; eval entries map to vectors through their text',
    counts: { vectors: unique.length },
    vectorsSha256: vectorsDigest(vectors),
    vectors,
  };
  const tmp = `${FIXTURE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(fixture) + '\n');
  fs.renameSync(tmp, FIXTURE);
  attempt.outcome = 'succeeded'; attempt.finishedAt = fixture.recordedAt; writeAttempt();
  say(`wrote ${path.relative(AQUA, FIXTURE)} · ${unique.length} vectors · ${attempt.requests.length} requests · vectors sha256 ${fixture.vectorsSha256}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(`ERROR: ${scrub(err?.message ?? err)}`); process.exit(1); });
}
