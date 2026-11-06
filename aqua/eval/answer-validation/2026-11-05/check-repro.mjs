#!/usr/bin/env node
/**
 * Reproducibility of a context build: compare two builds of the same condition,
 * question by question, with the per-request untrusted-content fence nonce
 * normalised (a random security token — everything else must be identical).
 *
 *   node check-repro.mjs <buildA.json> <buildB.json>
 */
import fs from 'node:fs';
const [a, b] = process.argv.slice(2).map(f => JSON.parse(fs.readFileSync(f, 'utf8')).contexts);
const norm = s => String(s).replace(/<<<(END-)?UNTRUSTED-CONTENT [\w-]+>>>/g, (m, end) => `<<<${end ?? ''}UNTRUSTED-CONTENT ·>>>`);
const differ = Object.keys(a).filter(k => norm(a[k]) !== norm(b[k]));
console.log(differ.length ? `DIFFERS: ${differ.join(', ')}` : `identical ${Object.keys(a).length}/${Object.keys(a).length} (fence nonce normalised)`);
process.exitCode = differ.length ? 1 : 0;
