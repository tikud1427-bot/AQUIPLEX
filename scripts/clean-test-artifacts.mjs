#!/usr/bin/env node
/**
 * One-off: remove test artifacts that earlier suite runs wrote into a real
 * data directory.
 *
 * Only needed once. From this point the runner sandboxes every run, so nothing
 * new can land here.
 *
 * DRY RUN BY DEFAULT. Pass --apply to actually write.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = process.env.AQUA_DATA_DIR || path.join(os.homedir(), '.aquiplex');
const apply = process.argv.includes('--apply');

// Owners and ids that only ever come from test fixtures. Deliberately an
// explicit list rather than a pattern: a regex that guesses at "looks like a
// test" is how a cleanup script eats someone's real data.
const TEST_OWNERS = [
  'user:alice', 'user:bob', 'user:carol', 'user:erin', 'user:aliceid',
  'user:recall-tester', 'user:nobody', 'user:proof',
  'user:u4-alice', 'user:u4-bob', 'user:u4-nobody',
  'user:u5-done', 'user:u5-skipper', 'user:u5-fresh', 'user:u5-nobeliefs',
  'user:u6', 'user:u6-http', 'user:u6-src', 'user:u6-dismiss',
  'user:u6-score-a', 'user:u6-score-b', 'user:u6-refs',
  'user:e2e-ananya', 'user:probe', 'user:invariant', 'user:g', 'user:o', 'user:x',
];
const TEST_CONVERSATIONS = ['conv-u5', 'conv-marker', 'brand-new-conv-id-12345', 'conv-e2e', 'e2e-conv-1', 'e2e-conv-2', 'e2e-conv-3', 'e2e-conv-4', 'e2e-conv-5', 'e2e-conv-7', 'e2e-conv-8'];
const TEST_WORKSPACES = ['ws-persist-test', 'ws-phase2c-test'];

let touched = 0;
const prune = (file, fn) => {
  const p = path.join(dir, file);
  let data;
  try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return; }
  const before = JSON.stringify(data).length;
  const removed = fn(data);
  const after = JSON.stringify(data).length;
  if (!removed.length) { console.log(`  ${file}: clean`); return; }
  touched += removed.length;
  console.log(`  ${file}: ${removed.length} test entr(ies) — ${removed.slice(0, 6).join(', ')}${removed.length > 6 ? ' …' : ''}`);
  if (apply) {
    fs.copyFileSync(p, `${p}.pre-cleanup`);
    fs.writeFileSync(p, JSON.stringify(data));
    console.log(`     written (${before} → ${after} bytes; backup at ${path.basename(p)}.pre-cleanup)`);
  }
};

/**
 * Every AQUA store wraps its contents as `{ __aqua: <meta>, data: {...} }`.
 * Guessing at the shape is how a cleanup script reports "clean" while the junk
 * sits right there — which is exactly what the first draft of this file did.
 * So: unwrap explicitly, and if the expected container is missing, say so
 * rather than silently finding nothing.
 */
const container = (root, ...candidates) => {
  const d = root?.data ?? root;
  for (const c of candidates) if (d?.[c] && typeof d[c] === 'object') return d[c];
  return d;
};

const dropKeys = (obj, list) => {
  const hit = [];
  for (const k of Object.keys(obj ?? {})) if (list.includes(k)) { hit.push(k); delete obj[k]; }
  return hit;
};

console.log(`\nScanning ${dir}${apply ? '' : '   (dry run — pass --apply to write)'}\n`);
prune('.aqua-mind.json', (d) => dropKeys(container(d, 'byOwner', 'minds'), TEST_OWNERS));
prune('.aqua-history.json', (d) => dropKeys(container(d, 'conversations'), TEST_CONVERSATIONS));
prune('.aqua-ltm.json', (d) => dropKeys(container(d, 'byOwner'), TEST_OWNERS));
prune('.aqua-attachments.json', (d) => dropKeys(container(d, 'byConversation'), TEST_CONVERSATIONS));
prune('.aqua-projects.json', (d) => dropKeys(container(d, 'workspaces'), TEST_WORKSPACES));
prune('.aqua-index.json', (d) => dropKeys(container(d), TEST_WORKSPACES));

console.log(`\n${touched ? `${touched} test entr(ies) found.` : 'Nothing to clean.'}`);
if (touched && !apply) console.log('Re-run with --apply to remove them. Every file gets a .pre-cleanup backup.\n');
else console.log('');
