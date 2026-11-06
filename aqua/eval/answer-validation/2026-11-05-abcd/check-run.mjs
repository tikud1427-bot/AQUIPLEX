#!/usr/bin/env node
/**
 * After the run, before grading: is it complete, untruncated, and the run that was frozen?
 * Reads the run directory only. Exit 1 = do not grade it as a complete comparison
 * (../2026-11-05/ADDENDUM-v2.md rules 2 and 3).
 *
 *   node check-run.mjs answers/<run-id>
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] ?? (console.error('usage: node check-run.mjs answers/<run-id>'), process.exit(2));
const jsonl = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const PROMPTS = jsonl(path.join(HERE, 'prompts.code-defaults.jsonl'));
const raw = jsonl(path.join(dir, 'answers.raw.jsonl'));
const answers = fs.existsSync(path.join(dir, 'answers.jsonl')) ? jsonl(path.join(dir, 'answers.jsonl')) : [];
const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
const key = r => `${r.id}:${r.condition}`;
const sha = o => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
const SETTINGS = { temperature: 0, top_p: 1, max_tokens: 600, seed: 7 };
let bad = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) bad++; };

check(run.prompts_sha256 === crypto.createHash('sha256').update(fs.readFileSync(path.join(HERE, 'prompts.code-defaults.jsonl'))).digest('hex'), 'run used this package\'s frozen prompts file');
check(raw.length === 24 && run.requests === 24, `24 requests recorded (${raw.length}; run.json ${run.requests})`);
check(new Set(raw.map(key)).size === 24 && PROMPTS.every(p => raw.some(r => key(r) === key(p))), 'every question × condition answered exactly once');
check(raw.every(r => r.status === 200 && !r.error), `no provider errors (${raw.filter(r => r.status !== 200 || r.error).map(key).join(' ') || 'none'})`);
check(raw.every(r => String(r.answer ?? '').trim().length > 0), `no empty answers (${raw.filter(r => !String(r.answer ?? '').trim()).map(key).join(' ') || 'none'})`);
const trunc = raw.filter(r => r.finish_reason !== 'stop');
console.log(`info finish_reason: ${Object.entries(raw.reduce((m, r) => ({ ...m, [r.finish_reason]: (m[r.finish_reason] ?? 0) + 1 }), {})).map(([k, v]) => `${k} ×${v}`).join(', ')}`);
check(trunc.length <= 2, `truncated (finish_reason ≠ stop) ${trunc.length} ≤ 2 — ADDENDUM rule 3 (${trunc.map(key).join(' ') || 'none'})`);
check(raw.every(r => r.model === run.model && JSON.stringify(r.settings) === JSON.stringify(SETTINGS)), 'one model and one settings set throughout');
const bySha = new Map(PROMPTS.map(p => [key(p), sha({ model: run.model, messages: [{ role: 'system', content: p.system }, { role: 'user', content: p.user }], ...SETTINGS })]));
check(raw.every(r => r.request_sha256 === bySha.get(key(r))), 'every request byte-identical to the frozen prompt');
check(answers.length === 24 && answers.every(a => raw.find(r => key(r) === key(a))?.answer === a.answer), 'answers.jsonl matches the raw log');
const toks = raw.reduce((m, r) => ({ in: m.in + (r.usage?.prompt_tokens ?? 0), out: m.out + (r.usage?.completion_tokens ?? 0) }), { in: 0, out: 0 });
console.log(`info tokens: input ${toks.in}, output ${toks.out} (max per answer ${Math.max(...raw.map(r => r.usage?.completion_tokens ?? 0))}); ≈${Math.round(toks.in * 31876 / 1e6 + toks.out * 50488 / 1e6)} Neurons`);
console.log(bad ? `\n${bad} check(s) FAILED — report the run as incomplete; do not grade it as complete` : '\ncomplete — grade it');
process.exitCode = bad ? 1 : 0;
