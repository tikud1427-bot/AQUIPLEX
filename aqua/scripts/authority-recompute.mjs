#!/usr/bin/env node
/**
 * Current-state scoring from RECORDED contexts (temporal-resolution-eval.mjs
 * --emit-contexts) — so an arm whose code no longer exists in the tree is
 * scored by exactly the same metric as the current one. Development
 * instrument; no app module is imported.
 *
 *   node scripts/authority-recompute.mjs <contexts.json>[,…] --labels a.json,b.json [--regime short] [--only c01,c02]
 *
 * Memory block = the context before the evidence / recall blocks (identity,
 * profile, cognitive model, graph, episodes, files). A value is presented AS
 * CURRENT when it sits on a memory-block line that is not marked "since
 * changed", not inside a "(previously: …)" note, and not under a "No longer
 * current" heading.
 *
 *   outdated-as-current  change questions whose staleValue / stale is shown as current
 *   correct current      questions with currentValue whose value is shown as current
 *   false updates        no-change controls (stillCurrent) not shown as current
 *   never-held shown     mustNot values shown as current
 *   history preserved    historical questions whose past value is anywhere in the context
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const files = argv[0].split(',');
const regime = flag('--regime', 'short');
const only = flag('--only', null);
const labels = Object.assign({}, ...flag('--labels').split(',').map(f => JSON.parse(readFileSync(path.resolve(ROOT, f), 'utf8')).labels));
const norm = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ');
// The memory block ends where the first evidence / recall block begins — which
// may be the very first line, when the user has no memory block at all.
const memoryOf = text => { const m = String(text).match(/(?:^|\n)(?:── CONTEXT AQUA ASSEMBLED|── CONNECTED KNOWLEDGE|WHAT THE USER TOLD YOU BEFORE)/); return m ? String(text).slice(0, m.index) : String(text); };
function asCurrentLines(text) {
  const out = [];
  let history = false;
  for (const raw of memoryOf(text).split('\n')) {
    if (/^###\s/.test(raw) || /^---/.test(raw)) history = /^###\s+No longer current/i.test(raw);
    if (history || raw.includes('since changed')) continue;
    out.push(norm(raw.replace(/\((?:previously|was)[^)]*\)/gi, '')));
  }
  return out;
}
const shown = (lines, vals) => vals.some(v => lines.some(x => x.includes(norm(v))));
const tok = s => Math.ceil(String(s).length / 4);

for (const f of files) {
  const all = JSON.parse(readFileSync(path.resolve(ROOT, f), 'utf8')).contexts[regime];
  const ctx = Object.fromEntries(Object.entries(all).filter(([id]) => !only || only.split(',').some(p => id.startsWith(p))));
  const c = { change: [], stale: [], cur: [], curOk: [], ctl: [], falseUpd: [], never: [], neverShown: [], hist: [], histOk: [] };
  let tokens = 0;
  for (const [id, text] of Object.entries(ctx)) {
    tokens += tok(text);
    const l = labels[id];
    if (!l) continue;
    const lines = asCurrentLines(text);
    if (l.stale && !l.historical) { c.change.push(id); if (shown(lines, [...(l.staleValue ?? []), ...l.stale])) c.stale.push(id); }
    if (l.currentValue) { c.cur.push(id); if (shown(lines, l.currentValue)) c.curOk.push(id); }
    if (l.stillCurrent) { c.ctl.push(id); if (!shown(lines, l.stillCurrent)) c.falseUpd.push(id); }
    if (l.mustNot) { c.never.push(id); if (shown(lines, l.mustNot)) c.neverShown.push(id); }
    if (l.historical) { c.hist.push(id); if (norm(text).includes(norm(l.current[0]))) c.histOk.push(id); }
  }
  const r = (a, b) => `${a.length}/${b.length}${b.length ? ` (${(100 * a.length / b.length).toFixed(1)}%)` : ''}`;
  console.log(`${path.basename(f)} [${regime}]${only ? ` [${only}]` : ''}  tokens/q ${(tokens / Object.keys(ctx).length).toFixed(0)}`);
  console.log(`   outdated-as-current ${r(c.stale, c.change)} ${c.stale.join(' ')}`);
  console.log(`   correct current     ${r(c.curOk, c.cur)}   missing: ${c.cur.filter(x => !c.curOk.includes(x)).join(' ')}`);
  console.log(`   false updates       ${r(c.falseUpd, c.ctl)} ${c.falseUpd.join(' ')}`);
  console.log(`   never-held shown    ${r(c.neverShown, c.never)} ${c.neverShown.join(' ')}`);
  console.log(`   history preserved   ${r(c.histOk, c.hist)}`);
}
