#!/usr/bin/env node
/**
 * Fixed instructions per condition = lines present in EVERY one of its prompts
 * (user data varies by life and question; instructions do not). Prints the
 * instruction lines only one condition has — the part of the treatment that is
 * prompt wording rather than memory content.
 *
 *   node instruction-diff.mjs contexts.HEAD.<p>.json contexts.DEV.<p>.json
 */
import fs from 'node:fs';
const norm = s => String(s).replace(/<<<(END-)?UNTRUSTED-CONTENT [\w-]+>>>/g, (m, end) => `<<<${end ?? ''}UNTRUSTED-CONTENT ·>>>`);
const fixed = f => {
  const cs = Object.values(JSON.parse(fs.readFileSync(f, 'utf8')).contexts).map(c => new Set(norm(c).split('\n').map(l => l.trim()).filter(Boolean)));
  return new Set([...cs[0]].filter(l => cs.every(s => s.has(l))));
};
const [a, b] = process.argv.slice(2).map(fixed);
console.log(`fixed instruction lines: HEAD ${a.size}, DEV ${b.size}, shared ${[...a].filter(l => b.has(l)).length}`);
for (const l of a) if (!b.has(l)) console.log(`  HEAD only: ${l.slice(0, 300)}`);
for (const l of b) if (!a.has(l)) console.log(`  DEV only:  ${l.slice(0, 300)}`);
