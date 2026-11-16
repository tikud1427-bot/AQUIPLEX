#!/usr/bin/env node
/**
 * PWI benchmark runner (2026-11-15).
 *
 *   node eval/pwi/run-pwi.mjs [--arms prod,propagation,hybrid] [--out <dir>] [--label <name>]
 *
 * For each arm: a fresh data directory; stages A → B → C, each in its own
 * process (stage.mjs --mode run), each followed by a fresh process over the same
 * data (--mode verify) to measure persistence across restarts. Then scoring
 * (score.mjs) and a results file. No model, no network, no database: the
 * production configuration as it runs on Render today (legacy read).
 *
 * Refuses to run if the dataset does not match its frozen SHA-256.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadDataset, validateDataset, STAGES } from './truth.mjs';
import { scoreStage, persistence } from './score.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AQUA = path.resolve(HERE, '..', '..');
const DATASET = path.join(HERE, 'dataset', 'pwi-v1.json');

export const ARMS = {
  prod:        { env: {}, note: 'code defaults = production today (legacy read, no database)' },
  propagation: { env: { AQUA_PROPAGATION: 'on' }, note: 'one change reaches every store (memory/propagation.js), off in production' },
  hybrid:      { env: { AQUA_HYBRID_CONTEXT: 'on' }, note: 'information-needs check block added to the context, off in production' },
};

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const arms = (args.arms ?? 'prod,propagation,hybrid').split(',').filter(Boolean);
const regimes = (args.regimes ?? 'short,long').split(',').filter(Boolean);
for (const r of regimes) if (!['short', 'long'].includes(r)) { console.error(`unknown regime ${r}`); process.exit(2); }
for (const a of arms) if (!ARMS[a]) { console.error(`unknown arm ${a}`); process.exit(2); }

const { dataset, sha256 } = loadDataset(DATASET);
const frozen = fs.readFileSync(`${DATASET}.sha256`, 'utf8').split(/\s+/)[0];
if (sha256 !== frozen) { console.error(`dataset changed since it was frozen (${sha256} ≠ ${frozen}); version it as pwi-v2 instead`); process.exit(2); }
const shape = validateDataset(dataset);

const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}${args.label ? `-${args.label}` : ''}`;
const outDir = path.resolve(args.out ?? path.join(HERE, 'results', runId));
fs.mkdirSync(outDir, { recursive: true });

/** The child environment: no database, no Mongo, no provider credentials; the arm's flags. */
function childEnv(dataDir, armEnv) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(DATABASE_URL|MONGO_URI|MONGODB_URI|AQUA_TEST_.*)$/.test(k)) delete env[k];
    if (/(_API_KEY|_KEY_\d+|_KEYS)$|^OPENROUTER|^GROQ|^GEMINI|^NVIDIA|^OPENAI|^TAVILY|^SERPER|^BRAVE|^EXA/i.test(k)) delete env[k];
    if (/^AQUA_/.test(k) && !['AQUA_DATA_DIR'].includes(k)) delete env[k];   // only the arm decides flags
  }
  return { ...env, AQUA_DATA_DIR: dataDir, AQUA_DISABLE_MONGO_MIRROR: '1', MONGO_URI: '', AQUA_EMBEDDINGS: 'off', ...armEnv };
}

function runStage(arm, regime, stage, mode, dataDir) {
  const out = path.join(outDir, `${arm}-${regime}`, `${stage}.${mode}.json`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(HERE, 'stage.mjs'), '--dataset', DATASET, '--stage', stage, '--mode', mode, '--regime', regime, '--out', out],
    { cwd: AQUA, env: childEnv(dataDir, ARMS[arm].env), encoding: 'utf8', timeout: 10 * 60_000 });
  const ms = Date.now() - t0;
  // 143 = exited through the production SIGTERM flush (expected); 0 = nothing to flush.
  const clean = r.status === 143 || r.status === 0;
  if (!clean || !fs.existsSync(out)) {
    return { ok: false, ms, status: r.status, signal: r.signal, stderr: String(r.stderr ?? '').slice(-2000) };
  }
  return { ok: true, ms, status: r.status, file: out };
}

const summary = { runId, dataset: { version: dataset.version, sha256, ...shape }, node: process.version, platform: `${os.platform()} ${os.release()}`, startedAt: new Date().toISOString(), arms: {} };
for (const arm of arms) for (const regime of regimes) {
  const cell = `${arm}-${regime}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `aqua-pwi-${cell}-`));
  const A = summary.arms[cell] = { arm, regime, note: ARMS[arm].note, env: ARMS[arm].env, dataDir, stages: {}, infraFailures: [] };
  for (const stage of STAGES) {
    const run = runStage(arm, regime, stage, 'run', dataDir);
    if (!run.ok) { A.infraFailures.push({ stage, mode: 'run', ...run }); console.error(`[PWI] ${cell} ${stage} run FAILED (status ${run.status})`); break; }
    const verify = runStage(arm, regime, stage, 'verify', dataDir);
    const runOut = JSON.parse(fs.readFileSync(run.file, 'utf8'));
    const scored = scoreStage(dataset, runOut);
    let persist = null;
    if (verify.ok) persist = persistence(scored, scoreStage(dataset, JSON.parse(fs.readFileSync(verify.file, 'utf8'))));
    else A.infraFailures.push({ stage, mode: 'verify', ...verify });
    A.stages[stage] = { ms: { run: run.ms, verify: verify.ms }, infra: scored.infra, metrics: scored.metrics, persistence: persist };
    fs.writeFileSync(path.join(outDir, cell, `${stage}.score.json`), JSON.stringify(scored, null, 1));
    console.log(`[PWI] ${cell} ${stage}: completeness=${scored.metrics.contextCompleteness.mean} claim=${scored.metrics.claim.accuracy} staleUnmarked=${scored.metrics.temporal.staleUnmarkedRate} deletionStore=${scored.metrics.deletion.complianceStore} isolation=${scored.metrics.isolation.contextLeaks + scored.metrics.isolation.storeLeaks} persist=${persist?.identical ?? 'n/a'} (${run.ms}+${verify.ms} ms)`);
  }
}
summary.finishedAt = new Date().toISOString();
const json = JSON.stringify(summary, null, 1);
fs.writeFileSync(path.join(outDir, 'summary.json'), json);
fs.writeFileSync(path.join(outDir, 'summary.json.sha256'), `${crypto.createHash('sha256').update(json).digest('hex')}  summary.json\n`);
console.log(`[PWI] results: ${outDir}`);
