#!/usr/bin/env node
/**
 * Run-to-run noise: the 12 HEAD requests of this run are byte-identical to run 1's
 * (verify-package.mjs check 3). Same model, temperature 0 — any difference in their
 * answers or rubric v2 grades is provider noise, and bounds what a HEAD/DEV
 * difference of that size can mean. Reads files only.
 *
 *   node compare-head.mjs answers/<run-id>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] ?? (console.error('usage: node compare-head.mjs answers/<run-id>'), process.exit(2));
const jsonl = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const RUN1 = path.join(HERE, '../2026-11-05/answers/primary-cf-mistral-2026-11-05');
const a1 = jsonl(path.join(RUN1, 'answers.jsonl')).filter(r => r.condition === 'HEAD');
const a2 = jsonl(path.join(dir, 'answers.jsonl')).filter(r => r.condition === 'HEAD');
const g1 = JSON.parse(fs.readFileSync(path.join(HERE, '../rubric-v2/results/primary-cf-mistral-2026-11-05.v2.json'), 'utf8')).results.filter(r => r.condition === 'HEAD');
const g2p = path.join(dir, 'graded.v2.json');
const g2 = fs.existsSync(g2p) ? JSON.parse(fs.readFileSync(g2p, 'utf8')).results.filter(r => r.condition === 'HEAD') : null;
let same = 0, gradeSame = 0;
for (const x of a1) {
  const y = a2.find(r => r.id === x.id);
  const eq = y && y.answer === x.answer;
  if (eq) same++;
  const p1 = g1.find(r => r.id === x.id)?.pass, p2 = g2?.find(r => r.id === x.id)?.pass;
  if (g2 && p1 === p2) gradeSame++;
  console.log(`${x.id} answer ${eq ? 'identical' : 'DIFFERS'}${g2 ? `  v2 ${p1 ? 'pass' : 'fail'} → ${p2 ? 'pass' : 'fail'}` : ''}`);
}
console.log(`HEAD answers identical to run 1: ${same}/12${g2 ? `; same v2 grade: ${gradeSame}/12` : ' (grade this run with rubric v2 first for the grade comparison)'}`);
