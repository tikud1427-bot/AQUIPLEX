#!/usr/bin/env node
/**
 * For each question, the prompt lines about what is asked, in both conditions —
 * the evidence a model would answer from. Model-free.
 *   node focus-lines.mjs contexts.HEAD.<p>.json contexts.DEV.<p>.json > focus.<p>.txt
 */
import fs from 'node:fs';
const TERMS = {
  q01: /Fintrail|Northbeam|work|workplace|company/i, q02: /Fintrail|Northbeam/i, q03: /marathon/i, q04: /Atlas|March 3/i,
  q05: /Northbeam|analyst|Fintrail|Atlas|promot/i, q06: /manager/i, q07: /Halcyon|Northbeam|company|workplace/i,
  q08: /accountant|Lena|Priya|manager/i, q09: /client|Meridian/i, q10: /accountant|Lena|phone/i, q11: /CFA|Spanish|goal/i, q12: /CFA/i,
};
const [h, d] = process.argv.slice(2).map(f => JSON.parse(fs.readFileSync(f, 'utf8')).contexts);
const DS = JSON.parse(fs.readFileSync(new URL('../../datasets/answer-lifecycle.dev.v1.json', import.meta.url), 'utf8'));
const pick = (ctx, re) => {
  let section = '';
  return String(ctx).split('\n').flatMap(l => {
    const m = l.match(/^---\s+([A-Z][A-Z &/()'-]+?)(?:\s*\(.*?\))?\s+---$/) ?? l.match(/^(WHAT THE USER TOLD YOU BEFORE)/) ?? l.match(/^(### .+)$/);
    if (m && !/^--- END/.test(l)) section = m[1].replace(/^### /, '  § ');
    return re.test(l) && !/^(What you can do|Guidelines|- Use this|- If asked|Values listed|Reading these|Use the knowledge)/.test(l) && l.length < 400 ? [`    [${section}] ${l.trim().slice(0, 220)}`] : [];
  });
};
for (const q of DS.questions) {
  console.log(`\n${q.id} (${q.category}) — "${q.ask}"`);
  for (const [name, c] of [['HEAD', h], ['DEV', d]]) { console.log(`  ${name}:`); for (const l of pick(c[q.id], TERMS[q.id])) console.log(l); }
}
