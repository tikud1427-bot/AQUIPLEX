#!/usr/bin/env node
/**
 * Lift JUDGE calibration — does a candidate judge agree with the reference
 * judge on answers that were already graded?
 *
 *   node scripts/lift-judge-calibration.mjs --from eval/out/world-model-lift-live.<run>.partial.json
 *     --judge-provider nvidia --judge-model mistralai/mistral-large-2-instruct [--limit 60] [--concurrency 4]
 *
 * Re-judges the stored answers (same history, question, rubric, answer text —
 * the judge prompt is liftCore.buildJudgePrompt, unchanged) and reports
 * agreement with the stored judgement on the GRADED outcome (correct), on
 * fabricated, on saysUnknown and on askedForKnownInfo, plus Cohen's kappa for
 * `correct`. Measurement instrumentation only; writes nothing but its report.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
{
  const envPath = path.join(ROOT, '..', '.env');
  if (existsSync(envPath)) createRequire(path.join(ROOT, 'package.json'))('dotenv').config({ path: envPath, quiet: true });
}
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const FROM = flag('--from');
const LIMIT = Number(flag('--limit', 60));
const CONC = Math.max(1, Number(flag('--concurrency', 4)));
const L = await import('../eval/lift/liftCore.mjs');
const { makeJudge } = await import('../eval/lift/liftJudge.mjs');
const judgeCall = makeJudge({ provider: flag('--judge-provider', 'nvidia'), model: flag('--judge-model', 'mistralai/mistral-large-2-instruct') });

const prior = JSON.parse(readFileSync(path.resolve(ROOT, FROM), 'utf8'));
const datasets = [JSON.parse(readFileSync(path.join(ROOT, 'eval/lift/world-model-lift-live.v1.json'), 'utf8'))];
const personas = new Map(datasets.flatMap(d => d.personas).map(p => [p.id, p]));
const items = [];
for (const r of prior.results) {
  const persona = personas.get(r.persona);
  const question = persona?.questions.find(q => q.id === r.id);
  if (!question) continue;
  for (const [cond, c] of Object.entries(r.conditions)) {
    if (!c.judgement || c.judgement.error || !c.grade) continue;
    items.push({ persona, question, cond, answer: c.answer, ref: c.judgement, refGrade: c.grade });
  }
}
// Deterministic, condition-balanced sample.
items.sort((a, b) => `${a.question.id}${a.cond}`.localeCompare(`${b.question.id}${b.cond}`));
const step = Math.max(1, Math.floor(items.length / LIMIT));
const sample = items.filter((_, i) => i % step === 0).slice(0, LIMIT);

const out = [];
let next = 0;
async function worker() {
  while (next < sample.length) {
    const it = sample[next++];
    const p = L.buildJudgePrompt({ history: it.persona.history, question: it.question }, it.answer);
    let j = null, err = null;
    for (let t = 0; t < 4 && !j; t++) {
      try { j = L.parseJudgement((await judgeCall(p.system, p.user)).text, it.question); }
      catch (e) { err = e; await new Promise(r => setTimeout(r, 3000 * (t + 1))); }
    }
    out.push({ id: it.question.id, cond: it.cond, ref: it.refGrade, cand: j ? L.gradeAnswer(it.question, j) : null, error: j ? null : String(err?.message ?? err) });
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

const ok = out.filter(o => o.cand);
const agree = k => ok.length ? ok.filter(o => Boolean(o.ref[k]) === Boolean(o.cand[k])).length / ok.length : null;
const kappa = (() => {
  const n = ok.length; if (!n) return null;
  const a = ok.filter(o => o.ref.correct && o.cand.correct).length, d = ok.filter(o => !o.ref.correct && !o.cand.correct).length;
  const po = (a + d) / n;
  const pr = ok.filter(o => o.ref.correct).length / n, pc = ok.filter(o => o.cand.correct).length / n;
  const pe = pr * pc + (1 - pr) * (1 - pc);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
})();
const report = {
  judge: { provider: flag('--judge-provider', 'nvidia'), model: flag('--judge-model', 'mistralai/mistral-large-2-instruct') },
  reference: 'stored judgements in ' + FROM, sampled: sample.length, judged: ok.length, errors: out.length - ok.length,
  agreement: { correct: agree('correct'), fabricated: agree('fabricated'), stale: agree('stale'), askedForKnownInfo: agree('askedForKnownInfo') },
  kappaCorrect: kappa == null ? null : Number(kappa.toFixed(3)),
  disagreements: ok.filter(o => o.ref.correct !== o.cand.correct).map(o => ({ id: o.id, cond: o.cond, ref: o.ref.correct, cand: o.cand.correct })),
};
const file = flag('--json', `eval/out/lift-judge-calibration.${report.judge.model.replace(/[^a-z0-9]+/gi, '-')}.json`);
writeFileSync(path.resolve(ROOT, file), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, disagreements: report.disagreements.length }, null, 2));
console.log(`→ ${file}`);
