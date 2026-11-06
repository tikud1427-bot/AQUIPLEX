#!/usr/bin/env node
/**
 * Validate an independently written held-out file (HELDOUT_SPEC.md) WITHOUT the
 * implementer editing it: schema, coverage, overlap with the development sets,
 * and the rubric self-test on the writer's own example answers. Prints the
 * file's SHA-256 so the submitted version is pinned. Model-free.
 *
 *   node validate-heldout.mjs heldout.v1.json
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const file = process.argv[2];
if (!file) { console.error('usage: validate-heldout.mjs <heldout.json>'); process.exit(2); }
const raw = fs.readFileSync(file);
const H = JSON.parse(raw);
const problems = [];
const CATS = ['current', 'historical', 'goal_status', 'uncertain_dependency', 'personal_context', 'abstention'];
console.log(`sha256 ${crypto.createHash('sha256').update(raw).digest('hex')}`);
if (!H.author) problems.push('author missing');
const lives = Object.keys(H.lives ?? {});
if (lives.length < 6) problems.push(`lives: ${lives.length} (need ≥ 6)`);
const qs = H.questions ?? [];
if (qs.length < 30) problems.push(`questions: ${qs.length} (need ≥ 30)`);
for (const c of CATS) { const n = qs.filter(q => q.category === c).length; if (n < 4) problems.push(`category ${c}: ${n} (need ≥ 4)`); }
for (const q of qs) {
  if (!q.id || !q.ask || !H.lives?.[q.life]) problems.push(`${q.id ?? '?'}: id, ask and a known life are required`);
  if (!CATS.includes(q.category)) problems.push(`${q.id}: unknown category ${q.category}`);
  if (!q.examples?.good || !q.examples?.bad) problems.push(`${q.id}: examples.good and examples.bad are required`);
  if (!q.include && !q.notCurrent && !q.notOpen && !q.hedge && !q.abstain) problems.push(`${q.id}: no criterion`);
}
// Overlap with the development material: sentences and capitalised names.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const devFiles = ['answer-lifecycle.dev.v1.json', 'intent-outcome.dev.v1.json', 'intent-outcome.check.v1.json'].map(f => path.join(HERE, '../../datasets', f)).filter(f => fs.existsSync(f));
const devText = devFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n').toLowerCase();
const names = new Set((devText.match(/\b[a-z]+\b/g) ?? []));
const heldSentences = Object.values(H.lives ?? {}).flat().filter(s => s !== '---');
for (const s of heldSentences) if (devText.includes(String(s).toLowerCase())) problems.push(`sentence reused from the development sets: "${s}"`);
const devNames = new Set((devFiles.map(f => fs.readFileSync(f, 'utf8')).join(' ').match(/\b[A-Z][a-z]{3,}\b/g) ?? []).filter(w => !/^(?:My|Our|The|What|Where|Who|How|Did|Which|Yes|Actually|Before|Both|You|Your|Focus|Learning|Congratulations|Not|Got|Good|Great|When|Since|This|That|They|There|Is|Are)$/.test(w)));
const reused = [...new Set((heldSentences.join(' ').match(/\b[A-Z][a-z]{3,}\b/g) ?? []).filter(w => devNames.has(w)))];
if (reused.length) problems.push(`names also used in the development sets: ${reused.join(', ')}`);
void names;
// Rubric self-test on the writer's examples (the grader must separate them).
const { gradeAnswer } = await import(pathToFileURL(path.join(HERE, '../../../scripts/answer-eval-harness.mjs')).href + '?lib').catch(() => ({}));
if (gradeAnswer) {
  let sep = 0;
  for (const q of qs) {
    const ctx = (H.lives[q.life] ?? []).join(' ');
    const g = gradeAnswer(q, q.examples?.good, ctx), b = gradeAnswer(q, q.examples?.bad, ctx);
    if (g.pass && !b.pass) sep++; else problems.push(`${q.id}: rubric does not separate the examples (good ${g.pass ? 'passes' : 'fails'}, bad ${b.pass ? 'passes' : 'fails'})`);
  }
  console.log(`rubric separates ${sep}/${qs.length} example pairs`);
}
console.log(problems.length ? `${problems.length} problem(s):\n  ${problems.join('\n  ')}` : 'valid');
process.exitCode = problems.length ? 1 : 0;
