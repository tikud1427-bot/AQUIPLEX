/**
 * The C9 semantic-relevance dataset is what its builder writes, its hash is
 * recorded, and its labels are coherent (2026-11-07). No vectors needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const AQUA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATASET = path.join(AQUA, 'eval/datasets/c9-semantic-relevance.dev.v1.json');
const SHA = path.join(AQUA, 'eval/datasets/c9-semantic-relevance.dev.v1.sha256');
const body = fs.readFileSync(DATASET);
const d = JSON.parse(body.toString('utf8'));

test('the committed dataset is exactly what scripts/build-c9-semantic-dataset.mjs builds, and its hash is recorded', () => {
  const out = execFileSync(process.execPath, [path.join(AQUA, 'scripts/build-c9-semantic-dataset.mjs'), '--check'], { encoding: 'utf8' });
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  assert.match(out, new RegExp(`^OK ${sha}`));
  assert.equal(fs.readFileSync(SHA, 'utf8').trim().split(/\s+/)[0], sha);
});

test('every label names a statement of the same owner; ids are unique; no placeholder is left', () => {
  const statements = new Map(d.statements.map(s => [s.id, s]));
  assert.equal(new Set([...d.statements, ...d.queries].map(x => x.id)).size, d.statements.length + d.queries.length);
  for (const q of d.queries) {
    for (const id of [...q.relevant, ...q.forbidden]) assert.equal(statements.get(id)?.owner, q.owner, `${q.id} → ${id}`);
    assert.ok(!q.relevant.some(id => q.forbidden.includes(id)), `${q.id}: an id both relevant and forbidden`);
  }
  for (const p of d.pairs) assert.equal(statements.get(p.a).owner, statements.get(p.b).owner, `${p.a} ~ ${p.b}`);
  for (const x of [...d.statements, ...d.queries]) assert.doesNotMatch(x.text, /\{\w+\}/, x.id);
});

test('the five C9 cases and every control category are present for every owner', () => {
  const owners = [...new Set(d.statements.map(s => s.owner))];
  assert.equal(owners.length, 10);
  for (const o of owners) {
    const qs = d.queries.filter(q => q.owner === o);
    for (const c of ['C1', 'C2', 'C3', 'C4', 'C5']) assert.ok(qs.some(q => q.case === c), `${o} ${c}`);
    for (const cat of ['paraphrase', 'planning_anchored', 'planning_broad', 'related_distinct', 'hard_negative', 'unrelated']) assert.ok(qs.some(q => q.category === cat), `${o} ${cat}`);
  }
  const canonical = ['How far is a 21 km race?', 'Is Duolingo worth it?', 'Why is CI failing?', "How's my career?", 'What shoes should I buy for my race?'];
  for (const t of canonical) assert.equal(d.queries.filter(q => q.text === t).length, 10, t);
});

test('every owner\'s corpus is above the dense lane\'s 60-statement floor', () => {
  const per = {};
  for (const s of d.statements) per[s.owner] = (per[s.owner] ?? 0) + 1;
  for (const [o, n] of Object.entries(per)) assert.ok(n >= 60, `${o}: ${n}`);
});

test('temporal labels: a changed career goal and a stopped language goal are historical, their later words current', () => {
  for (const s of d.statements.filter(x => x.role === 'change' || x.role === 'ended')) {
    assert.equal(s.status, 'current');
    assert.equal(d.statements.find(x => x.id === s.continues).status, 'historical', s.id);
  }
});

test('synthetic only: no credential-shaped string, no e-mail address, no phone number', () => {
  const text = body.toString('utf8');
  assert.doesNotMatch(text, /AIza[0-9A-Za-z_-]{20,}|AQ\.[0-9A-Za-z_.-]{20,}|sk-[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  assert.doesNotMatch(text, /\+?\d[\d\s-]{8,}\d/);
});
