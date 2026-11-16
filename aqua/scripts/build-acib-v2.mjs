/**
 * Expand the compact ACIB v2 source (eval/datasets/src/acib.v2.<set>.source.mjs)
 * into the shared ACIB schema (eval/datasets/acib.v2.<set>.json).
 * Usage: node scripts/build-acib-v2.mjs eval [--freeze]
 * --freeze writes the FROZEN.sha256 and refuses to overwrite an existing one.
 */
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { datasetHash } from '../eval/suites/acibSuite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const set = process.argv[2] ?? 'eval';
const freeze = process.argv.includes('--freeze');
const DS = path.join(HERE, '../eval/datasets');
const src = await import(pathToFileURL(path.join(DS, 'src', `acib.v2.${set}.source.mjs`)).href);
const P = r => (r instanceof RegExp ? r.source : String(r));

const scenarios = src.SCENARIOS.map(s => {
  const out = { id: s.id, category: s.category, dimensions: [s.category] };
  out.history = s.h.map(([conv, text, flag], i) => ({ id: `m${i + 1}`, conv: `c-${conv}`, text, ...(flag === 'fail' ? { fail: true } : {}) }));
  if (s.up) out.uploads = s.up.map(([conv, name, content]) => ({ conv: `c-${conv}`, name, content }));
  if (s.f) out.inlineFiller = s.f;
  out.question = s.question;
  out.needs = (s.n ?? []).map(([id, match, ev]) => ({ id, required: true, match: match.map(P), evidence: [P(ev)], slots: [] }));
  out.distractors = (s.d ?? []).map(([id, match]) => ({ id, match: match.map(P) }));
  if (s.u) out.unknowns = s.u.map(([id, label, match]) => ({ id, label, match: match.map(P) }));
  if (s.t) out.temporal = { current: s.t.current.map(P), stale: s.t.stale.map(P) };
  if (s.c) out.contradiction = { a: s.c.a.map(P), b: s.c.b.map(P) };
  if (s.x) out.crossEntity = s.x.map(([id, forbid]) => ({ id, forbid: forbid.map(P) }));
  return out;
});
const ids = new Set(scenarios.map(s => s.id));
if (ids.size !== scenarios.length) throw new Error('duplicate scenario id');
for (const s of scenarios) for (const n of s.needs) {
  const ev = new RegExp(n.evidence[0], 'i'); const texts = [...s.history.map(m => m.text), ...(s.uploads ?? []).map(u => u.content)];
  if (!texts.some(t => ev.test(t))) throw new Error(`${s.id}/${n.id}: evidence pattern matches no source text`);
  if (!texts.some(t => n.match.some(m => new RegExp(m, 'i').test(t)))) throw new Error(`${s.id}/${n.id}: match patterns match no source text`);
}
const doc = {
  id: `acib-v2-${set}`, version: '2',
  status: set === 'eval'
    ? 'EVALUATION SET — authored 2026-11-10 (Sprint 4) BEFORE any Sprint 4 code change, frozen by acib.v2.eval.FROZEN.sha256 before its first run. Never used for development. A change is a reviewed change and a new version.'
    : 'DEVELOPMENT SET.',
  about: 'Same schema and scorer as acib.v1 (eval/suites/acibScoring.mjs). Built from eval/datasets/src by scripts/build-acib-v2.mjs.',
  regimes: { short: 'history only', long: "history, then filler conversations until the user's past messages exceed 9,000 characters" },
  fillerTargetChars: 9000, filler: src.FILLER, scenarios,
};
const text = JSON.stringify(doc, null, 1) + '\n';
const file = path.join(DS, `acib.v2.${set}.json`), frozen = path.join(DS, `acib.v2.${set}.FROZEN.sha256`);
if (freeze && existsSync(frozen)) throw new Error('already frozen — refusing to overwrite');
writeFileSync(file, text);
const cats = {}; scenarios.forEach(s => (cats[s.category] = (cats[s.category] ?? 0) + 1));
console.log(scenarios.length, 'scenarios', JSON.stringify(cats), datasetHash(text));
if (freeze) writeFileSync(frozen, `${datasetHash(text)}  acib.v2.${set}.json\n`);
