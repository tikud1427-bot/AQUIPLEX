#!/usr/bin/env node
/** List every individual benchmark failure of one cell (Markdown). Usage: node analyze.mjs <runDir> <cell> [stage] */
import fs from 'node:fs';
import path from 'node:path';

const [dir, cell, only] = process.argv.slice(2);
for (const stage of ['A', 'B', 'C'].filter(s => !only || s === only)) {
  const f = path.join(dir, cell, `${stage}.score.json`);
  if (!fs.existsSync(f)) continue;
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  console.log(`\n## ${cell} — stage ${stage}\n`);
  const P = s.probes.filter(x => !x.infra);
  const miss = P.flatMap(x => x.required.filter(r => !r.present).map(r => `${x.persona} ${x.probe}: ${r.slot}=${r.value} [${r.kind}, ${r.source}] → ${r.miss}`));
  console.log(`**Required values missing from the context (${miss.length}):**\n${miss.map(m => `- ${m}`).join('\n') || '- none'}\n`);
  const stale = P.flatMap(x => x.stale.filter(t => t.unmarked).map(t => `${x.persona} ${x.probe}: ${t.kind} ${t.slot}=${t.value} — "${t.unmarkedLines[0]?.trim().slice(0, 110)}"`));
  console.log(`**Stale/wrong/hedged values presented as current (${stale.length}):**\n${stale.map(m => `- ${m}`).join('\n') || '- none'}\n`);
  const del = P.flatMap(x => [...x.deleted.map(d => `${x.persona} ${x.probe}: deleted "${d}"`), ...x.sensitive.map(d => `${x.persona} ${x.probe}: sensitive "${d}"`)]);
  const delCount = del.reduce((m, d) => (m[d.split(': ')[1] + ' (' + d.split(' ')[0] + ')'] = (m[d.split(': ')[1] + ' (' + d.split(' ')[0] + ')'] ?? 0) + 1, m), {});
  console.log(`**Deleted/sensitive values in contexts (${del.length} occurrences):**\n${Object.entries(delCount).map(([k, n]) => `- ${k} × ${n}`).join('\n') || '- none'}\n`);
  for (const [pid, v] of Object.entries(s.perPersona)) {
    const notCaptured = v.claims.filter(c => !c.captured).map(c => `${c.slot}=${c.value}${c.source === 'document' ? ' (doc)' : ''}`);
    const staleStored = v.claims.filter(c => c.staleAlongside.length).map(c => `${c.slot}: ${c.value} AND still ${c.staleAlongside.join(', ')}`);
    const undetected = v.changes.filter(c => !c.recordedAsHistory).map(c => `${c.slot}: ${c.old} (${c.kind})`);
    const delStore = v.deletion.filter(d => Object.values(d.found).some(Boolean)).map(d => `${d.kind} "${d.value}" in ${Object.entries(d.found).filter(([, b]) => b).map(([k]) => k).join('+')}${d.factsDetail.sourceTextOnly ? ' (facts: source sentence only)' : ''}`);
    console.log(`**${pid}** — not captured: ${notCaptured.join('; ') || 'none'}`);
    if (staleStored.length) console.log(`  - stale held as current: ${staleStored.join('; ')}`);
    if (undetected.length) console.log(`  - change not recorded as history: ${undetected.join('; ')}`);
    if (delStore.length) console.log(`  - deletion not complete: ${delStore.join('; ')}`);
    console.log(`  - entities missed (graph): ${v.entities.missed.join(', ') || 'none'}; spurious nodes: ${v.entities.spurious.join(', ') || 'none'}`);
    console.log(`  - relations missed: ${v.relations.missed.join(', ') || 'none'}`);
  }
}
