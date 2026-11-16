#!/usr/bin/env node
/**
 * Recompute a run's scores from its RAW stage outputs (no stage is re-run).
 * Scoring is a pure function of the raw outputs, so a scorer fix can be applied
 * to an existing run and the change audited: the previous summary is kept as
 * summary.<timestamp>.superseded.json beside the new one.
 *
 *   node eval/pwi/rescore.mjs <runDir>
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadDataset, STAGES } from './truth.mjs';
import { scoreStage, persistence } from './score.mjs';

const dir = path.resolve(process.argv[2] ?? '');
const file = path.join(dir, 'summary.json');
const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
const { dataset, sha256 } = loadDataset(path.join(path.dirname(fileURLToPath(import.meta.url)), 'dataset', 'pwi-v1.json'));
if (sha256 !== summary.dataset.sha256) { console.error('dataset hash differs from the run'); process.exit(2); }

fs.copyFileSync(file, path.join(dir, `summary.${new Date().toISOString().replace(/[:.]/g, '-')}.superseded.json`));
for (const [cell, a] of Object.entries(summary.arms)) {
  for (const stage of STAGES) {
    const run = path.join(dir, cell, `${stage}.run.json`);
    if (!fs.existsSync(run)) continue;
    const scored = scoreStage(dataset, JSON.parse(fs.readFileSync(run, 'utf8')));
    const vf = path.join(dir, cell, `${stage}.verify.json`);
    const persist = fs.existsSync(vf) ? persistence(scored, scoreStage(dataset, JSON.parse(fs.readFileSync(vf, 'utf8')))) : null;
    a.stages[stage] = { ...a.stages[stage], infra: scored.infra, metrics: scored.metrics, persistence: persist };
    fs.writeFileSync(path.join(dir, cell, `${stage}.score.json`), JSON.stringify(scored, null, 1));
  }
}
summary.rescoredAt = new Date().toISOString();
const json = JSON.stringify(summary, null, 1);
fs.writeFileSync(file, json);
fs.writeFileSync(`${file}.sha256`, `${crypto.createHash('sha256').update(json).digest('hex')}  summary.json\n`);
console.log(`rescored ${Object.keys(summary.arms).length} cells in ${dir}`);
