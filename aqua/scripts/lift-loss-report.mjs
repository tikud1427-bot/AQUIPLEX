#!/usr/bin/env node
/**
 * Every World-Model LOSS against Memory in a Lift result, with what is needed
 * to root-cause it: the question, the rubric, the WM context the answer model
 * saw, the selected claims (lane, slots), both answers and the judge's notes.
 *
 *   node scripts/lift-loss-report.mjs eval/out/world-model-lift-live.<run>.json [--md out.md]
 *
 * A loss = a (question, repeat) where worldModel is graded incorrect and memory
 * correct. Also lists WM fabrications (any outcome), since a win bought with
 * fabrication is not a win.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [file] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const mdIdx = process.argv.indexOf('--md');
const res = JSON.parse(readFileSync(path.resolve(file), 'utf8'));
const datasets = (res.datasets ?? ['eval/lift/world-model-lift-live.v1.json', 'eval/lift/world-model-lift-live.v2-extension.json'])
  .map(f => JSON.parse(readFileSync(path.resolve(f), 'utf8')));
const qById = new Map(datasets.flatMap(d => d.personas.flatMap(p => p.questions.map(q => [q.id, q]))));

const graded = res.results.filter(r => r.conditions.worldModel?.grade && r.conditions.memory?.grade);
const losses = graded.filter(r => !r.conditions.worldModel.grade.correct && r.conditions.memory.grade.correct);
const fabs = graded.filter(r => r.conditions.worldModel.grade.fabricated);
const out = [];
const block = (title, rows) => {
  out.push(`\n## ${title} (${rows.length})\n`);
  for (const r of rows) {
    const q = qById.get(r.id) ?? {};
    const wm = r.conditions.worldModel, mem = r.conditions.memory;
    out.push(`### ${r.id}#${r.rep} [${r.cat}] ${r.q}`);
    out.push(`required: ${JSON.stringify(q.required ?? [])}  forbidden: ${JSON.stringify(q.forbidden ?? [])}${q.expectUnknown ? '  (expect UNKNOWN)' : ''}`);
    out.push(`WM judge: ${JSON.stringify({ required: wm.judgement.required, forbidden: wm.judgement.forbidden, fabricated: wm.judgement.fabricated, saysUnknown: wm.judgement.saysUnknown, asked: wm.judgement.askedForKnownInfo })} — ${wm.judgement.notes}`);
    out.push(`MEM judge: ${mem.judgement.notes}`);
    out.push('WM context:\n```\n' + (wm.context || '(empty)') + '\n```');
    out.push('WM answer:\n```\n' + String(wm.answer).slice(0, 900) + '\n```');
    out.push('MEM answer:\n```\n' + String(mem.answer).slice(0, 500) + '\n```\n');
  }
};
block('World-Model losses vs Memory', losses);
block('World-Model fabrications', fabs);
const text = `# Lift loss report — ${res.run ?? path.basename(file)}\n${out.join('\n')}`;
if (mdIdx > -1) writeFileSync(path.resolve(process.argv[mdIdx + 1]), text);
console.log(`losses ${losses.length} · WM fabrications ${fabs.length} · graded ${graded.length}`);
