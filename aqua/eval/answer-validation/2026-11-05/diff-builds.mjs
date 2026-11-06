#!/usr/bin/env node
/** Line diff of one question between two builds (fence nonce normalised). node diff-builds.mjs <a.json> <b.json> <qid> */
import fs from 'node:fs';
const [fa, fb, id] = process.argv.slice(2);
const norm = s => String(s).replace(/<<<(END-)?UNTRUSTED-CONTENT [\w-]+>>>/g, (m, end) => `<<<${end ?? ''}UNTRUSTED-CONTENT ·>>>`);
const a = norm(JSON.parse(fs.readFileSync(fa, 'utf8')).contexts[id]).split('\n');
const b = norm(JSON.parse(fs.readFileSync(fb, 'utf8')).contexts[id]).split('\n');
const sa = new Set(a), sb = new Set(b);
for (const l of a) if (!sb.has(l)) console.log(`- ${l.slice(0, 200)}`);
for (const l of b) if (!sa.has(l)) console.log(`+ ${l.slice(0, 200)}`);
if (a.join('\n') !== b.join('\n') && [...a].every(l => sb.has(l)) && [...b].every(l => sa.has(l))) console.log('(same lines, different order)');
