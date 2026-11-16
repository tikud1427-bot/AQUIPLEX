/**
 * Offline prompt-size measurement — DEVELOPMENT DATA ONLY (ACIB v3 preparation, 2026-11-12).
 *
 *   node scripts/measure-prompt-sizes.mjs --set acib.v2.dev --regime very-long [--limit N] [--arms A,H] [--out <file>]
 *
 * Builds every prompt through the EXACT evaluation path (eval/answer/evalRun.mjs acibCases →
 * eval/adapters/acibPipeline.mjs runScenario with capturePrompt), unmodified and untruncated, and
 * reports sizes. No provider and no tokenizer API is called (the network is guarded).
 *
 * Token counts are ESTIMATES — the provider tokenizer (openai/gpt-oss-120b, o200k-family) is not
 * available locally:
 *   typical  = chars / 4.48 (calibrated on ONE live prompt: 5,923 chars → 1,323 prompt tokens, 2026-11-11)
 *   lower-density = chars / 3.92 (the judge prompt observed on 2026-11-12: 1,989 chars → 507 tokens)
 *   conservative  = the manager's pre-send estimate: chars/3 + framing + the full max_tokens (what the
 *                   per-request cap actually checks)
 *
 * Refuses any dataset that is not an allow-listed DEVELOPMENT set, and any file whose sha256 equals a
 * frozen evaluation set (acib.v2.eval or an ACIB v3 freeze record).
 */
import '../eval/core/isolateDataDir.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario, closeAcib } from '../eval/adapters/acibPipeline.mjs';
import { acibCases, productionDataGuard } from '../eval/answer/evalRun.mjs';
import { estimateRequestTokens } from '../eval/providers/providerManager.mjs';
import { sha256 } from '../eval/governance/acibV3Governance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const refuse = msg => { console.error(`measure-prompt-sizes: REFUSED — ${msg}`); process.exit(2); };

export const DEV_SETS = Object.freeze(['acib.v2.dev', 'acib.v1']);
const SET = opt('--set', 'acib.v2.dev');
const REGIME = opt('--regime', 'very-long');
const ARMS = opt('--arms', 'A,H').split(',').map(s => s.trim());
const LIMIT = Number(opt('--limit', '1000'));
const MAX_TOKENS = Number(opt('--max-tokens', '1500'));       // the answer settings' output bound (for the conservative estimate)
if (!DEV_SETS.includes(SET)) refuse(`${SET} is not an allow-listed development set (${DEV_SETS.join(', ')}); evaluation scenarios are never measured`);
if (!['short', 'long', 'very-long'].includes(REGIME)) refuse('--regime must be short, long or very-long');
const risk = productionDataGuard(process.env);
if (risk.length) refuse(risk.join('; '));

const RAW = readFileSync(path.join(ROOT, 'eval/datasets', `${SET}.json`), 'utf8');
const HASH = sha256(RAW);
const frozenEval = [];
try { frozenEval.push(readFileSync(path.join(ROOT, 'eval/datasets/acib.v2.eval.FROZEN.sha256'), 'utf8').trim().split(/\s+/)[0]); } catch { /* none */ }
try { frozenEval.push(JSON.parse(readFileSync(path.join(ROOT, 'eval/datasets/acib.v3.FREEZE.json'), 'utf8')).eval.sha256); } catch { /* not frozen */ }
if (frozenEval.includes(HASH)) refuse('this file is a frozen EVALUATION set');
const DS = JSON.parse(RAW);

// Filler reached (the same rule as acibPipeline.fillerPlan: cycle the filler list until the target is passed).
const target = REGIME === 'very-long' ? (DS.veryLongFillerTargetChars ?? 60000) : REGIME === 'long' ? DS.fillerTargetChars : 0;
const fillerTurns = s => {
  if (!target) return { turns: 0, chars: 0 };
  let chars = (s.history ?? []).filter(m => !m.fail).reduce((n, m) => n + m.text.length, 0) + (DS.filler ?? []).slice(0, s.inlineFiller ?? 0).reduce((n, t) => n + t.length, 0), turns = 0;
  while (chars <= target) { chars += DS.filler[turns % DS.filler.length].length; turns++; }
  return { turns, chars };
};

const scenarios = DS.scenarios.slice(0, LIMIT);
const armEnvs = { A: {}, B: { AQUA_INFO_NEEDS: 'on' }, H: { AQUA_HYBRID_CONTEXT: 'on' } };
const cases = acibCases({ ds: DS, datasetHash: HASH, scenarios, armEnvs: Object.fromEntries(ARMS.map(a => [a, armEnvs[a]])), regime: REGIME, label: 'measure', runScenario });
const rows = [];
for (const c of cases) {
  const f = fillerTurns(c.scenario);
  for (const arm of ARMS) {
    const m = await c.arms[arm]();
    const chars = m.reduce((s, x) => s + x.content.length, 0);
    rows.push({ id: c.scenario.id, category: c.scenario.category, arm, messages: m.length, promptChars: chars, systemChars: m.filter(x => x.role === 'system').reduce((s, x) => s + x.content.length, 0),
      estTypical: Math.round(chars / 4.48), estLowDensity: Math.round(chars / 3.92), estConservativeWithOutput: estimateRequestTokens(m, MAX_TOKENS), historyCharsWritten: f.chars, fillerTurns: f.turns });
  }
}
closeAcib();

const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const stats = xs => (xs.length ? { n: xs.length, min: Math.min(...xs), median: q(xs, 0.5), mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length), p95: q(xs, 0.95), max: Math.max(...xs) } : null);
const block = rs => ({ promptChars: stats(rs.map(r => r.promptChars)), estTypical: stats(rs.map(r => r.estTypical)), estConservativeWithOutput: stats(rs.map(r => r.estConservativeWithOutput)) });
const LIMITS = { perRequestCap: 4500, groqTpm: 8000, modelContext: 131072 };   // D-2 (2026-11-12): per-request ceiling 4,500 (was 4,000)
const out = {
  createdAt: new Date().toISOString(), set: SET, datasetSha256: HASH, regime: REGIME, fillerTargetChars: target, fillerMessagesDistinct: (DS.filler ?? []).length, arms: ARMS,
  method: 'Exact evaluation prompt path (acibCases → runScenario capturePrompt), unmodified. Token counts are ESTIMATES (no local provider tokenizer): typical chars/4.48 and low-density chars/3.92 from two live observations; conservative = the manager\'s pre-send estimate (chars/3 + framing + max_tokens).',
  limits: LIMITS,
  overall: block(rows), perArm: Object.fromEntries(ARMS.map(a => [a, block(rows.filter(r => r.arm === a))])),
  perCategory: Object.fromEntries([...new Set(rows.map(r => r.category))].sort().map(c => [c, block(rows.filter(r => r.category === c))])),
  largest: [...rows].sort((a, b) => b.promptChars - a.promptChars).slice(0, 5).map(r => ({ id: r.id, arm: r.arm, category: r.category, promptChars: r.promptChars, estTypical: r.estTypical, estConservativeWithOutput: r.estConservativeWithOutput })),
  risks: {
    overPerRequestCap_conservative: rows.filter(r => r.estConservativeWithOutput > LIMITS.perRequestCap).map(r => `${r.id}/${r.arm}`),
    overTpm_typicalPlusOutput: rows.filter(r => r.estTypical + MAX_TOKENS > LIMITS.groqTpm).map(r => `${r.id}/${r.arm}`),
    overModelContext_lowDensity: rows.filter(r => r.estLowDensity + MAX_TOKENS > LIMITS.modelContext).map(r => `${r.id}/${r.arm}`),
  },
  perScenario: rows,
};
const file = opt('--out');
if (file) writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
const s = out.overall;
console.log(`${SET} · ${REGIME} (filler target ${target} chars from ${out.fillerMessagesDistinct} distinct messages) · ${rows.length} prompts`);
console.log(`prompt chars: min ${s.promptChars.min} · median ${s.promptChars.median} · mean ${s.promptChars.mean} · p95 ${s.promptChars.p95} · max ${s.promptChars.max}`);
console.log(`est. tokens (typical): min ${s.estTypical.min} · median ${s.estTypical.median} · mean ${s.estTypical.mean} · p95 ${s.estTypical.p95} · max ${s.estTypical.max}`);
console.log(`conservative pre-send estimate incl. ${MAX_TOKENS} output: max ${s.estConservativeWithOutput.max} vs per-request cap ${LIMITS.perRequestCap}`);
console.log(`risks: over cap ${out.risks.overPerRequestCap_conservative.length} · over TPM ${out.risks.overTpm_typicalPlusOutput.length} · over context ${out.risks.overModelContext_lowDensity.length}`);
if (file) console.log(`written: ${file}`);
