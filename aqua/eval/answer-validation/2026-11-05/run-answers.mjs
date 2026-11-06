#!/usr/bin/env node
/**
 * Answer generation for the frozen HEAD-vs-DEV comparison (2026-11-05).
 * GENERATION ONLY — grading is a separate step (answer-eval-harness.mjs grade).
 *
 * Refuses to run unless the operator states, per run, that the provider is
 * isolated, free and authorised. Never reads .env; the key comes from the ONE
 * environment variable named on the command line. Never overwrites outputs.
 *
 *   node run-answers.mjs --prompts prompts.code-defaults.jsonl --out answers/<run-id> \
 *     --endpoint <openai-compatible base url> --model <model id> --api-key-env <VAR> \
 *     --confirm "isolated-free-authorized:<provider name>"   [--dry-run]
 *
 * Fixed settings (identical for both conditions): temperature 0, top_p 1,
 * max_tokens 600, seed 7 (sent; providers may ignore it), system = the
 * recorded production system prompt, user = the question. One request per
 * prompt; the 24 prompts are sent in a seeded interleaved order so time-of-day
 * or rate-limit drift cannot favour one condition.
 *
 * Writes:
 *   <out>/answers.raw.jsonl   one line per request: id, condition, model, settings,
 *                             sha256 of the exact request body, response text,
 *                             finish reason, usage, HTTP status, latency, timestamps
 *   <out>/answers.jsonl       {id, condition, answer} — the grader's input
 *   <out>/run.json            run metadata (no key, no endpoint secrets)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = n => argv.includes(`--${n}`);
const die = m => { console.error(`✗ ${m}`); process.exit(2); };

const promptsFile = flag('prompts') ?? die('--prompts is required');
const out = flag('out') ?? die('--out is required');
const dry = has('dry-run');
const SETTINGS = Object.freeze({ temperature: 0, top_p: 1, max_tokens: 600, seed: 7 });
const prompts = fs.readFileSync(promptsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

// Seeded interleaving: deterministic, conditions alternate within each question pair.
const order = (() => {
  let s = 20261105;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const ids = [...new Set(prompts.map(p => p.id))].sort((a, b) => rnd() - 0.5 || a.localeCompare(b));
  return ids.flatMap(id => {
    const pair = prompts.filter(p => p.id === id);
    return rnd() < 0.5 ? pair : [...pair].reverse();
  });
})();
const bodyOf = p => ({ model: flag('model') ?? 'UNSET', messages: [{ role: 'system', content: p.system }, { role: 'user', content: p.user }], ...SETTINGS });
const sha = o => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');

if (dry) {
  console.log(`dry run: ${order.length} requests, settings ${JSON.stringify(SETTINGS)}, conditions ${[...new Set(order.map(p => p.condition))].join(' / ')}`);
  console.log(`order: ${order.map(p => `${p.id}:${p.condition}`).join(' ')}`);
  console.log(`request sha256 (first 3): ${order.slice(0, 3).map(p => sha(bodyOf(p)).slice(0, 12)).join(' ')}`);
  console.log('nothing was sent.');
  process.exit(0);
}

const endpoint = flag('endpoint') ?? die('--endpoint is required');
const model = flag('model') ?? die('--model is required');
const keyEnv = flag('api-key-env') ?? die('--api-key-env is required (the NAME of one environment variable)');
const confirm = flag('confirm') ?? '';
if (!/^isolated-free-authorized:\S+/.test(confirm)) die('--confirm "isolated-free-authorized:<provider>" is required: state that this provider is isolated from Lift and production quota, free, and authorised for this run');
const key = process.env[keyEnv] ?? die(`environment variable ${keyEnv} is not set`);
if (fs.existsSync(out)) die(`${out} exists — outputs are never overwritten; choose a new run id`);
fs.mkdirSync(out, { recursive: true });
const raw = fs.openSync(path.join(out, 'answers.raw.jsonl'), 'a');
const answers = [];
const started = new Date().toISOString();
for (const p of order) {
  const body = { ...bodyOf(p), model };
  const t0 = Date.now();
  let status = 0, text = '', finish = null, usage = null, error = null;
  try {
    const r = await fetch(`${endpoint.replace(/\/+$/, '')}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    status = r.status;
    const j = await r.json().catch(() => null);
    text = j?.choices?.[0]?.message?.content ?? '';
    finish = j?.choices?.[0]?.finish_reason ?? null;
    usage = j?.usage ?? null;
    if (!r.ok) error = String(j?.error?.message ?? r.statusText).slice(0, 300);
  } catch (e) { error = String(e?.message ?? e).slice(0, 300); }
  const rec = { id: p.id, condition: p.condition, category: p.category, model, settings: SETTINGS, request_sha256: sha(body), status, finish_reason: finish, usage, error, latency_ms: Date.now() - t0, at: new Date().toISOString(), answer: text };
  fs.writeSync(raw, `${JSON.stringify(rec)}\n`);
  answers.push({ id: p.id, condition: p.condition, answer: text });
  console.log(`${p.id} ${p.condition}: ${status} ${error ? `ERROR ${error}` : `${text.length} chars`}`);
  if (error && /quota|rate|429|402/i.test(`${status} ${error}`)) { console.error('✗ stopping: quota or rate limit — no retries against a provider that may be shared'); break; }
}
fs.writeFileSync(path.join(out, 'answers.jsonl'), answers.map(a => JSON.stringify(a)).join('\n') + '\n');
fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify({ started, finished: new Date().toISOString(), prompts: path.basename(promptsFile), prompts_sha256: crypto.createHash('sha256').update(fs.readFileSync(promptsFile)).digest('hex'), model, settings: SETTINGS, confirm, requests: answers.length }, null, 2));
console.log(`wrote ${answers.length} answers → ${out}. Grade separately: node ../../../scripts/answer-eval-harness.mjs grade --answers ${out}/answers.jsonl --contexts …`);
