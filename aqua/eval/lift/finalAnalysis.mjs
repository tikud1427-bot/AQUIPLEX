#!/usr/bin/env node
/**
 * Analysis for PREREG-final-2026-10-18.md. Written BEFORE any result existed.
 *
 *   node eval/lift/finalAnalysis.mjs endpoints <final.improved.json> <final.current.json> [--out report.json]
 *   node eval/lift/finalAnalysis.mjs second-judge <final.improved.json> <final.current.json> --out judge2.json
 *   node eval/lift/finalAnalysis.mjs human-sheet <final.improved.json> <final.current.json> --out sheet.csv --key key.json
 *   node eval/lift/finalAnalysis.mjs human-agreement <sheet-graded.csv> <key.json> <final.improved.json> <final.current.json>
 *
 * Conditions are renamed so both trees share one table: from the improved tree
 * fullHistory, history, memory, memoryMatched, worldModel → wm-improved, hybrid → hybrid-improved;
 * from the current tree (aadda450) worldModel → wm-current, hybrid → hybrid-current.
 * Units are joined on (question id, repeat).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from './liftCore.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATASET = JSON.parse(readFileSync(path.join(HERE, 'world-model-final.v1.json'), 'utf8'));
const QUESTIONS = new Map(DATASET.personas.flatMap(p => p.questions.map(q => [q.id, { ...q, persona: p }])));
const [mode, fImproved, fCurrent, ...rest] = process.argv.slice(2);
const opt = k => (rest.includes(k) ? rest[rest.indexOf(k) + 1] : null);
const SEED = 20261006;

const RENAME = {
  improved: { worldModel: 'wm-improved', hybrid: 'hybrid-improved' },
  current: { worldModel: 'wm-current', hybrid: 'hybrid-current' },
};
function load(file, tree) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  return { json: j, rows: (j.results ?? []).map(r => ({ ...r, conditions: Object.fromEntries(Object.entries(r.conditions ?? {})
    .map(([c, v]) => [RENAME[tree][c] ?? (tree === 'improved' ? c : `${c}-current`), v])) })) };
}
function merged() {
  const a = load(fImproved, 'improved'), b = load(fCurrent, 'current');
  const key = r => `${r.id}#${r.rep}`;
  const byKey = new Map(a.rows.map(r => [key(r), { ...r, conditions: { ...r.conditions } }]));
  for (const r of b.rows) {
    const t = byKey.get(key(r));
    if (t) Object.assign(t.conditions, r.conditions); else byKey.set(key(r), r);
  }
  return { rows: [...byKey.values()], improved: a.json, current: b.json };
}
const rnd = (() => { let s = SEED >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; })();
const shuffle = xs => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const units = rows => rows.flatMap(r => Object.entries(r.conditions).map(([cond, v]) => ({ r, cond, v })));

function endpoints() {
  const { rows, improved, current } = merged();
  const all = units(rows);
  const graded = all.filter(u => u.v.grade);
  const validity = {
    units: all.length, judgeErrors: all.length - graded.length,
    judgeErrorRate: all.length ? (all.length - graded.length) / all.length : null,
    e6: { improved: improved.pipeline ?? null, current: current.pipeline ?? null },
  };
  const conds = [...new Set(all.map(u => u.cond))].sort();
  const metricsFor = sel => Object.fromEntries(conds.map(c => [c, L.conditionMetrics(sel
    .filter(r => r.conditions[c]?.grade).map(r => ({ cat: r.cat, expectUnknown: r.expectUnknown, hasForbidden: r.hasForbidden, grade: r.conditions[c].grade })))]));
  const long = rows.filter(r => r.length === 'long'), short = rows.filter(r => r.length !== 'long');
  const cmp = (sel, a, b) => L.clusteredComparison(sel, a, b);
  const fab = (sel, c) => L.conditionMetrics(sel.filter(r => r.conditions[c]?.grade).map(r => ({ cat: r.cat, expectUnknown: r.expectUnknown, hasForbidden: r.hasForbidden, grade: r.conditions[c].grade }))).fabrication_rate;
  // E1 — all personas.
  const e1c = cmp(rows, 'wm-improved', 'wm-current');
  const E1 = { comparison: e1c, decision: e1c.ci95[0] > 0 ? 'IMPROVED' : e1c.ci95[1] < 0 ? 'WORSE' : 'NO DETECTABLE CHANGE' };
  // E2 — long personas.
  const e2 = ['wm-improved', 'hybrid-improved'].map(c => {
    const vh = cmp(long, c, 'history'), vm = cmp(long, c, 'memoryMatched');
    const ok = vh.ci95[0] > 0 && vm.ci95[0] > 0 && fab(long, c) <= fab(long, 'memoryMatched');
    return { condition: c, vsHistory: vh, vsMemoryMatched: vm, fabrication: fab(long, c), fabricationMemoryMatched: fab(long, 'memoryMatched'), superior: ok };
  });
  const longMetrics = metricsFor(long);
  const best = Object.entries(longMetrics).filter(([, m]) => m.n).sort((x, y) => y[1].correctness - x[1].correctness)[0]?.[0] ?? null;
  const E2 = { candidates: e2, decision: e2.some(x => x.superior) ? `SUPERIOR: ${e2.filter(x => x.superior).map(x => x.condition).join(', ')}` : `NOT SUPERIOR — best on long personas: ${best}` };
  // E3 — short personas.
  const e3 = ['wm-improved', 'hybrid-improved'].map(c => {
    const vf = cmp(short, c, 'fullHistory'), vm = cmp(short, c, 'memoryMatched');
    return { condition: c, vsFullHistory: vf, vsMemoryMatched: vm, superior: vf.ci95[0] > 0 && vm.ci95[0] > 0 };
  });
  const E3 = { candidates: e3, decision: e3.some(x => x.superior) ? 'SUPERIOR' : 'NO CLAIM' };
  const cost = Object.fromEntries(conds.map(c => {
    const us = all.filter(u => u.cond === c);
    const tok = us.map(u => u.v.contextTokens).filter(Number.isFinite).sort((a, b) => a - b);
    const ms = us.map(u => u.v.answerMs).filter(Number.isFinite).sort((a, b) => a - b);
    return [c, { contextTokensMean: tok.length ? Math.round(tok.reduce((a, b) => a + b, 0) / tok.length) : null,
      answerMsP50: ms[Math.floor(ms.length / 2)] ?? null, answerMsP90: ms[Math.floor(ms.length * 0.9)] ?? null }];
  }));
  const report = { dataset: DATASET.id, validity, E1, E2, E3, metrics: { all: metricsFor(rows), long: longMetrics, short: metricsFor(short) }, cost };
  if (opt('--out')) writeFileSync(opt('--out'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ validity: { ...validity, e6: undefined }, E1: E1.decision, E2: E2.decision, E3: E3.decision }, null, 1));
}

async function secondJudge() {
  const { rows } = merged();
  const sample = shuffle(units(rows).filter(u => u.v.grade)).slice(0, Math.ceil(0.15 * units(rows).filter(u => u.v.grade).length));
  const keys = Object.keys(process.env).filter(k => /^GROQ_API_KEY_\d+$/.test(k)).sort().map(k => process.env[k]).filter(Boolean);
  if (!keys.length) throw new Error('no GROQ_API_KEY_* for the second judge');
  const out = []; let i = 0;
  for (const u of sample) {
    const q = QUESTIONS.get(u.r.id);
    const history = q.persona.sessions.flat();
    const p = L.buildJudgePrompt({ history, question: q }, u.v.answer);
    let text = null, err = null;
    for (let attempt = 0; attempt < 6 && text === null; attempt++) {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST',
        headers: { authorization: `Bearer ${keys[i++ % keys.length]}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'openai/gpt-oss-120b', temperature: 0, max_tokens: 2000, messages: [{ role: 'system', content: p.system }, { role: 'user', content: p.user }] }) });
      if (res.ok) text = (await res.json()).choices?.[0]?.message?.content ?? '';
      else { err = `${res.status}`; await new Promise(r => setTimeout(r, 15000)); }
    }
    let g2 = null;
    try { g2 = text === null ? null : L.gradeAnswer(q, L.parseJudgement(text, q)); } catch (e) { err = String(e.message ?? e); }
    out.push({ id: u.r.id, rep: u.r.rep, cond: u.cond, judge1: u.v.grade.correct, judge2: g2?.correct ?? null, error: g2 ? null : err });
    writeFileSync(opt('--out'), JSON.stringify(out, null, 1));
  }
  const both = out.filter(o => o.judge2 !== null);
  console.log(JSON.stringify({ sampled: sample.length, compared: both.length, ...kappa(both.map(o => [o.judge1, o.judge2])) }));
}

function kappa(pairs) {
  const n = pairs.length; if (!n) return { kappa: null, agreement: null };
  const agree = pairs.filter(([a, b]) => a === b).length / n;
  const pa = pairs.filter(([a]) => a).length / n, pb = pairs.filter(([, b]) => b).length / n;
  const pe = pa * pb + (1 - pa) * (1 - pb);
  return { agreement: Number(agree.toFixed(4)), kappa: pe === 1 ? 1 : Number(((agree - pe) / (1 - pe)).toFixed(4)) };
}

function humanSheet() {
  const { rows } = merged();
  const byCond = new Map();
  for (const u of shuffle(units(rows).filter(u => u.v.grade))) {
    if (!byCond.has(u.cond)) byCond.set(u.cond, []);
    byCond.get(u.cond).push(u);
  }
  const per = Math.ceil(60 / byCond.size);
  const picked = shuffle([...byCond.values()].flatMap(us => us.slice(0, per))).slice(0, 60);
  const csv = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = ['item,persona,question,required_facts,forbidden_as_current,expect_unknown,answer,YOUR_correct(1/0),YOUR_stale(1/0),YOUR_fabricated(1/0),notes'];
  const key = [];
  picked.forEach((u, i) => {
    const q = QUESTIONS.get(u.r.id);
    lines.push([i + 1, q.persona.id, csv(q.q), csv((q.required ?? []).join(' | ')), csv((q.forbidden ?? []).join(' | ')), q.expectUnknown ? 1 : 0, csv(u.v.answer), '', '', '', ''].join(','));
    key.push({ item: i + 1, id: u.r.id, rep: u.r.rep, cond: u.cond, judge: u.v.grade });
  });
  writeFileSync(opt('--out'), lines.join('\n') + '\n');
  writeFileSync(opt('--key'), JSON.stringify(key, null, 1));
  console.log(`wrote ${picked.length} blinded items (conditions hidden; key in ${opt('--key')})`);
}

function humanAgreement() {
  const [sheetFile, keyFile] = [fImproved, fCurrent];
  const key = JSON.parse(readFileSync(keyFile, 'utf8'));
  const parse = line => { const cells = []; let cur = '', q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === ',' && !q) { cells.push(cur); cur = ''; } else cur += ch; } cells.push(cur); return cells; };
  const graded = readFileSync(sheetFile, 'utf8').trim().split(/\r?\n/).slice(1).map(parse)
    .map(c => ({ item: Number(c[0]), human: c[7]?.trim() })).filter(x => x.human === '1' || x.human === '0');
  const pairs = graded.map(g => [key.find(k => k.item === g.item).judge.correct, g.human === '1']);
  console.log(JSON.stringify({ gradedByHuman: pairs.length, ...kappa(pairs) }));
}

const run = { endpoints, 'second-judge': secondJudge, 'human-sheet': humanSheet, 'human-agreement': humanAgreement }[mode];
if (!run) { console.error('modes: endpoints | second-judge | human-sheet | human-agreement'); process.exit(2); }
await run();
