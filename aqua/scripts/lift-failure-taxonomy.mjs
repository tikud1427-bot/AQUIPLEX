#!/usr/bin/env node
/**
 * Lift failure taxonomy (Pass 2, 2026-10-11) — for DEV data only (v1–v3).
 *
 *   node scripts/lift-failure-taxonomy.mjs eval/out/lift-heldout-v3.after.json [--condition worldModel]
 *
 * For every failed answer of a condition, decide where the needed information
 * was lost, from the run record alone:
 *   extraction — no stored claim of the persona carries the required fact
 *   retrieval  — a claim carries it, but the condition's context does not
 *   answer     — the context carries it, the answer still missed it / judged wrong
 *   stale      — a forbidden (outdated) value was asserted
 *   fabricated — the judge flagged an unsupported claim
 * "Carries" = every content word (≥4 chars, stemmed) of the required item occurs.
 * Heuristic and conservative; printed per category with examples.
 */
import { readFileSync } from 'node:fs';
const file = process.argv[2];
const cond = (() => { const i = process.argv.indexOf('--condition'); return i < 0 ? 'worldModel' : process.argv[i + 1]; })();
const run = JSON.parse(readFileSync(file, 'utf8'));
const STOP = new Set('that this with from have they their there about which would should could what when where into than then them were been being does doesn very just also only currently user users answer mentions states'.split(' '));
const words = s => [...new Set(String(s ?? '').toLowerCase().replace(/[^a-z0-9$%,. ]+/g, ' ').split(/\s+/)
  .map(w => w.replace(/[.,]+$/, '')).filter(w => w.length >= 4 && !STOP.has(w)).map(w => w.replace(/(?:ing|ed|es|s)$/, '')))];
const carries = (text, item) => { const t = String(text ?? '').toLowerCase(); const ws = words(item); return ws.length > 0 && ws.every(w => t.includes(w)); };
const tally = {}; const ex = {};
const add = (k, r, note) => { tally[k] = (tally[k] ?? 0) + 1; (ex[k] ??= []).length < 6 && ex[k].push(`${r.id}#${r.rep} [${r.cat}] ${r.q} — ${note}`); };
for (const r of run.results) {
  const c = r.conditions[cond]; const g = c?.grade; if (!g || g.correct) continue;
  const j = c.judgement ?? {};
  if (g.stale) add('stale', r, j.notes);
  if (g.fabricated) add('fabricated', r, j.notes);
  const missing = (j.required ?? []).map((ok, i) => ok ? null : i).filter(i => i !== null);
  if (!missing.length) continue;
  const q = findQuestion(r);
  const claims = (run.pipeline?.[r.persona]?.claimTexts ?? []).join('\n');
  for (const i of missing) {
    const item = q?.required?.[i] ?? `required[${i}]`;
    const where = !carries(claims, item) ? 'extraction' : !carries(c.context, item) ? 'retrieval' : 'answer';
    add(where, r, item);
  }
}
function findQuestion(r) {
  for (const f of run.datasets ?? []) {
    try { const d = JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')); for (const p of d.personas) for (const q of p.questions) if (q.id === r.id) return q; } catch { /* ignore */ }
  }
  return null;
}
console.log(`failure taxonomy · ${file} · condition ${cond}`);
for (const [k, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`\n${k}: ${n}`);
  for (const e of ex[k]) console.log(`  · ${e}`);
}
