#!/usr/bin/env node
/**
 * Model-free checks of this package before the answer run (2026-11-05, A–D comparison).
 * Never calls a provider, never writes. Exit 1 on any failed check.
 *
 *   node verify-package.mjs --model @cf/mistralai/mistral-small-3.1-24b-instruct
 *
 * 1. 24 records, each question once per condition, categories as the dataset.
 * 2. Send order = the frozen runner's seeded order, and = run 1's actual order.
 * 3. HEAD requests byte-identical to run 1 (request SHA-256 from its raw log).
 * 4. No prompt contains another question (one fresh account per question).
 * 5. Request count within --max-calls 24; Neuron estimate from run 1's measured tokens.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const MODEL = flag('model', '@cf/mistralai/mistral-small-3.1-24b-instruct');
const jsonl = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const PROMPTS = jsonl(path.join(HERE, 'prompts.code-defaults.jsonl'));
const RUN1 = path.join(HERE, '../2026-11-05/answers/primary-cf-mistral-2026-11-05');
const RAW1 = jsonl(path.join(RUN1, 'answers.raw.jsonl'));
const DS = JSON.parse(fs.readFileSync(path.join(HERE, '../../datasets/answer-lifecycle.dev.v1.json'), 'utf8'));
let bad = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) bad++; };

// Copied verbatim from ../2026-11-05/run-answers.v2.mjs (frozen, MANIFEST-ADDENDUM.sha256).
const SETTINGS = Object.freeze({ temperature: 0, top_p: 1, max_tokens: 600, seed: 7 });
const order = (() => {
  let s = 20261105;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const ids = [...new Set(PROMPTS.map(p => p.id))].sort((a, b) => rnd() - 0.5 || a.localeCompare(b));
  return ids.flatMap(id => { const pair = PROMPTS.filter(p => p.id === id); return rnd() < 0.5 ? pair : [...pair].reverse(); });
})();
const bodyOf = p => ({ model: MODEL, messages: [{ role: 'system', content: p.system }, { role: 'user', content: p.user }], ...SETTINGS });
const sha = o => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
const key = p => `${p.id}:${p.condition}`;

// 0. Integrity: this package, the frozen runner, rubric v2, the DEV code it was built from.
const fileSha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function manifest(file, base) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => l.match(/^([0-9a-f]{64}) [ *](.+)$/)).filter(Boolean);
  const failed = lines.filter(([, h, f]) => !fs.existsSync(path.join(base, f)) || fileSha(path.join(base, f)) !== h).map(([, , f]) => f);
  return { n: lines.length, failed };
}
const REPO = path.join(HERE, '../../../..');
for (const [label, file, base] of [
  ['this package', path.join(HERE, 'MANIFEST.sha256'), HERE],
  ['frozen runner + addendum', path.join(HERE, '../2026-11-05/MANIFEST-ADDENDUM.sha256'), path.join(HERE, '../2026-11-05')],
  ['frozen run-1 package', path.join(HERE, '../2026-11-05/MANIFEST.sha256'), path.join(HERE, '../2026-11-05')],
  ['rubric v2', path.join(HERE, '../rubric-v2/FROZEN.sha256'), path.join(HERE, '../rubric-v2')],
  ['DEV code (dev-code.sha256)', path.join(HERE, 'dev-code.sha256'), REPO],
]) {
  if (!fs.existsSync(file)) { check(false, `${label}: ${path.basename(file)} missing`); continue; }
  const m = manifest(file, base);
  check(m.n > 0 && !m.failed.length, `${label}: ${m.n - m.failed.length}/${m.n} hashes match${m.failed.length ? ` — changed: ${m.failed.slice(0, 5).join(', ')}` : ''}`);
}

// 1. Shape
const conds = [...new Set(PROMPTS.map(p => p.condition))];
check(PROMPTS.length === 24, `24 records (${PROMPTS.length})`);
check(conds.join('/') === 'HEAD/DEV', `conditions HEAD/DEV (${conds.join('/')})`);
check(DS.questions.every(q => conds.every(c => PROMPTS.filter(p => p.id === q.id && p.condition === c && p.category === q.category && p.user === q.ask).length === 1)),
  'each of the 12 frozen questions exactly once per condition, with its category and wording');

// 2. Order
const runOrder = RAW1.map(key).join(' ');
check(order.map(key).join(' ') === runOrder, `send order identical to run 1 (${order.map(key).slice(0, 4).join(' ')} …)`);

// 3. HEAD byte-identity with run 1
const rawBy = new Map(RAW1.map(r => [key(r), r]));
const headSame = PROMPTS.filter(p => p.condition === 'HEAD').filter(p => sha(bodyOf(p)) === rawBy.get(key(p))?.request_sha256).length;
check(headSame === 12, `HEAD requests byte-identical to run 1: ${headSame}/12 (request SHA-256)`);
const devSame = PROMPTS.filter(p => p.condition === 'DEV').filter(p => sha(bodyOf(p)) === rawBy.get(key(p))?.request_sha256).length;
console.log(`info DEV requests identical to run 1: ${devSame}/12 (expected 0: the DEV prompts carry A–D)`);
check(RAW1.every(r => r.model === MODEL && JSON.stringify(r.settings) === JSON.stringify(SETTINGS)), `run 1 used the same model and settings (${MODEL}, ${JSON.stringify(SETTINGS)})`);

// 4. Isolation
const norm = s => String(s).replace(/<<<(END-)?UNTRUSTED-CONTENT [\w-]+>>>/g, '');
const leaks = PROMPTS.flatMap(p => DS.questions.filter(q => q.id !== p.id && norm(p.system).includes(q.ask)).map(q => `${key(p)}←${q.id}`));
check(!leaks.length, `no prompt contains another question (${leaks.length ? leaks.join(' ') : 'none'})`);
const otherLife = PROMPTS.flatMap(p => {
  const mine = new Set(DS.lives[DS.questions.find(q => q.id === p.id).life]);
  return Object.entries(DS.lives).filter(([l]) => l !== DS.questions.find(q => q.id === p.id).life)
    .flatMap(([, lines]) => lines.filter(t => t !== '---' && !mine.has(t) && norm(p.system).includes(t)).map(t => `${key(p)}: "${t}"`));
});
check(!otherLife.length, `no prompt contains another life's statements (${otherLife.length ? otherLife.slice(0, 3).join('; ') : 'none'})`);

// 5. Limits and cost
check(order.length <= 24, `requests ${order.length} ≤ --max-calls 24`);
const NEURONS_IN = 31876, NEURONS_OUT = 50488;            // per million tokens, Cloudflare Workers AI pricing (mistral-small-3.1-24b-instruct)
const headTok = RAW1.filter(r => r.condition === 'HEAD').reduce((n, r) => n + r.usage.prompt_tokens, 0);
const headChars = PROMPTS.filter(p => p.condition === 'HEAD').reduce((n, p) => n + p.system.length + p.user.length, 0);
const perChar = headTok / headChars;                      // measured on HEAD, whose prompts are unchanged
const devTok = Math.round(PROMPTS.filter(p => p.condition === 'DEV').reduce((n, p) => n + p.system.length + p.user.length, 0) * perChar);
const inTok = headTok + devTok;
const outRun1 = RAW1.reduce((n, r) => n + r.usage.completion_tokens, 0);
const n = (tin, tout) => Math.round(tin * NEURONS_IN / 1e6 + tout * NEURONS_OUT / 1e6);
console.log(`info input tokens: HEAD ${headTok} (measured in run 1) + DEV ≈${devTok} (chars × ${perChar.toFixed(4)} tokens/char) = ≈${inTok}`);
console.log(`info Neurons: expected ≈${n(inTok, outRun1)} (output as run 1, ${outRun1} tokens); worst case ≈${n(inTok, 24 * 600)} (every answer at the 600-token cap); free allocation 10,000/day/account`);
console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed — nothing was sent');
process.exitCode = bad ? 1 : 0;
