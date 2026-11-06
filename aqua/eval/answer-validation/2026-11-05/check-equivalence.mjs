#!/usr/bin/env node
/**
 * Equivalence of the two conditions' inputs (answer validation, 2026-11-05).
 * For every question: same user message; system prompts split into sections at
 * their "--- NAME ---" / "### Name" headers; report which sections are identical
 * in HEAD and DEV and which differ. Model-free; reads only this folder.
 *
 *   node check-equivalence.mjs contexts.HEAD.<profile>.json contexts.DEV.<profile>.json
 */
import fs from 'node:fs';
const [a, b] = process.argv.slice(2).map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
const sections = text => {
  const out = new Map(); let name = '(preamble)'; let buf = [];
  for (const line of String(text).split('\n')) {
    const h = line.match(/^---\s+([A-Z][A-Z &/()'-]+?)(?:\s*\(.*?\))?\s+---$/) ?? line.match(/^(WHAT THE USER TOLD YOU BEFORE|RELEVANT KNOWLEDGE|KNOWLEDGE[^:]*)/);
    if (h && !/^--- END/.test(line)) { out.set(name, (out.get(name) ?? '') + buf.join('\n')); name = h[1].trim(); buf = []; }
    buf.push(line);
  }
  out.set(name, (out.get(name) ?? '') + buf.join('\n'));
  return out;
};
const tally = new Map();
for (const id of Object.keys(a.contexts)) {
  const sa = sections(a.contexts[id]), sb = sections(b.contexts[id]);
  for (const k of new Set([...sa.keys(), ...sb.keys()])) {
    const t = tally.get(k) ?? { same: 0, differ: 0, onlyHEAD: 0, onlyDEV: 0 };
    if (!sa.has(k)) t.onlyDEV++; else if (!sb.has(k)) t.onlyHEAD++; else if (sa.get(k) === sb.get(k)) t.same++; else t.differ++;
    tally.set(k, t);
  }
}
console.log(`profile ${a.profile}; questions ${Object.keys(a.contexts).length}; dataset ${a.dataset} / ${b.dataset}`);
for (const [k, t] of [...tally].sort((x, y) => x[0].localeCompare(y[0]))) console.log(`  ${k.padEnd(44)} same ${t.same}  differ ${t.differ}  only HEAD ${t.onlyHEAD}  only DEV ${t.onlyDEV}`);
