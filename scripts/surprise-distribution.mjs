#!/usr/bin/env node
/**
 * Surprise distribution — the measurement that sets E6/PR-3's threshold.
 *
 * WHY THIS IS A SCRIPT AND NOT A CONSTANT
 * ---------------------------------------
 * `surpriseGate.js` ships with `DEFAULT_THRESHOLD = 0`, which admits
 * everything. It is inert on purpose. The blueprint's rule for this phase is to
 * establish the baseline first and define the gate from the measured
 * distribution — writing 0.15 into the module because it sounds reasonable
 * would be inventing the number and then measuring against it.
 *
 * This produces the distribution. Run it, send back the output, and the
 * threshold gets chosen in a follow-up PR with the cost it implies stated.
 *
 * WHY YOU HAVE TO RUN IT
 * ----------------------
 * Real embeddings. The analysis sandbox has no provider key and its egress
 * blocks Gemini, so the numbers cannot be produced there. Everything that does
 * NOT need a provider — the change-cue exemption, fail-open behaviour, the
 * centroid maths — is already tested in
 * `src/brain/tests/surpriseGate.test.js`, which runs anywhere.
 *
 * USAGE
 *
 *   cd aqua
 *   node scripts/surprise-distribution.mjs
 *
 * Needs whatever key `embeddingProvider.js` already reads — the same one the
 * app uses. Nothing is written; results go to stdout. Add --json <path> to
 * also write a machine record.
 *
 * WHAT IT REPORTS
 *
 *   • surprise for every REDUNDANT pair   (a restatement of a seeded fact)
 *   • surprise for every NOVEL pair       (an unrelated new fact)
 *   • surprise for every SUPERSEDING pair (an update to a seeded fact)
 *   • the separation between those groups, which is the only thing that can
 *     justify a threshold
 *
 * READ THE SUPERSEDING GROUP FIRST. If superseding segments score as low as
 * redundant ones, that CONFIRMS the reason change cues bypass this gate
 * entirely — and it means the threshold must never be the only thing standing
 * between an update and the floor.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { embed, isEmbeddingEnabled } from '../src/embeddings/embeddingProvider.js';
import { centroidOf, hasChangeCue } from '../src/brain/understanding/surpriseGate.js';
import { cosineSim } from '../src/embeddings/vectorStore.js';

/** What the owner already knows. */
const SEEDED = [
  'I run product at Nummo, a fintech in Bangalore.',
  'My co-founder Dev runs engineering.',
  'Our biggest problem is churn in the first 30 days.',
  'Razorpay is our main competitor.',
  'I want to hit 10,000 active merchants by December.',
  'I usually do deep work in the mornings.',
];

const PROBES = [
  // REDUNDANT — says something already on file. The gate SHOULD suppress these.
  ['redundant', 'I work at Nummo as head of product.'],
  ['redundant', 'Dev is my co-founder and leads engineering.'],
  ['redundant', 'Churn in the first month is our main issue.'],
  ['redundant', 'Our competitor is Razorpay.'],
  ['redundant', 'I do my best focused work early in the day.'],

  // NOVEL — unrelated to anything seeded. The gate must admit these.
  ['novel', 'We signed a term sheet with an angel investor last week.'],
  ['novel', 'The compliance audit is due before the board meeting.'],
  ['novel', 'I am learning system design this quarter.'],
  ['novel', 'Our office moved to Indiranagar.'],
  ['novel', 'Priya joined as our first designer.'],

  // SUPERSEDING — updates a seeded fact. Losing one of these is the expensive
  // mistake, and every one of them looks like its predecessor.
  ['superseding', 'I left Nummo and joined Zeta.'],
  ['superseding', 'Growth is no longer the priority — retention is.'],
  ['superseding', 'Dev is not running engineering anymore.'],
  ['superseding', 'Razorpay stopped being our competitor after they exited.'],
  ['superseding', 'I moved my deep work to the evenings.'],
];

const pct = n => `${(n * 100).toFixed(1)}%`;
const fmt = n => (n === null ? '  n/a ' : n.toFixed(4));

async function main() {
  if (!isEmbeddingEnabled()) {
    console.error('\n✗ Embeddings are not available in this environment.');
    console.error('  This script needs the same provider key the app uses.');
    console.error('  Nothing was measured — no partial numbers are printed, because a');
    console.error('  distribution built from nulls would look like a real result.\n');
    process.exit(1);
  }

  const seededVecs = await embed(SEEDED);
  const centroid = centroidOf(seededVecs);
  if (!centroid) {
    console.error('✗ Could not build a centroid from the seeded facts — every embedding came back null.');
    process.exit(1);
  }

  const probeVecs = await embed(PROBES.map(([, t]) => t));

  const rows = PROBES.map(([group, text], i) => {
    const v = probeVecs[i];
    const surprise = Array.isArray(v) && v.length ? 1 - cosineSim(v, centroid) : null;
    return { group, text, surprise, exempt: hasChangeCue(text) };
  });

  console.log(`\nSURPRISE DISTRIBUTION  ·  ${SEEDED.length} seeded facts, ${PROBES.length} probes`);
  console.log(`centroid dim ${centroid.length}\n`);
  console.log('group        exempt  surprise  text');
  for (const r of rows) {
    console.log(`${r.group.padEnd(12)} ${(r.exempt ? 'yes' : ' no').padEnd(6)}  ${fmt(r.surprise)}  ${r.text}`);
  }

  const stats = {};
  for (const group of ['redundant', 'novel', 'superseding']) {
    const vals = rows.filter(r => r.group === group && r.surprise !== null).map(r => r.surprise).sort((a, b) => a - b);
    if (!vals.length) { stats[group] = null; continue; }
    stats[group] = {
      n: vals.length,
      min: vals[0],
      median: vals[Math.floor(vals.length / 2)],
      max: vals[vals.length - 1],
      mean: vals.reduce((a, b) => a + b, 0) / vals.length,
    };
  }

  console.log('\ngroup        n    min     median  max     mean');
  for (const [g, s] of Object.entries(stats)) {
    if (!s) { console.log(`${g.padEnd(12)} —`); continue; }
    console.log(`${g.padEnd(12)} ${String(s.n).padEnd(4)} ${fmt(s.min)}  ${fmt(s.median)}  ${fmt(s.max)}  ${fmt(s.mean)}`);
  }

  // The only question this script exists to answer.
  const r = stats.redundant, n = stats.novel, s = stats.superseding;
  console.log('\nSEPARATION');
  if (r && n) {
    const gap = n.min - r.max;
    console.log(`  novel.min − redundant.max = ${fmt(gap)}  ${gap > 0
      ? '→ the groups separate; a threshold in this gap is defensible'
      : '→ THE GROUPS OVERLAP. No threshold separates them cleanly; any value drops real claims.'}`);
  }
  if (s && r) {
    const overlap = s.min <= r.max;
    console.log(`  superseding.min = ${fmt(s.min)} vs redundant.max = ${fmt(r.max)}  ${overlap
      ? '→ SUPERSEDING SCORES AS LOW AS REDUNDANT. Exactly why change cues bypass this gate; the threshold must never be the only guard.'
      : '→ superseding scores above redundant here, but the change-cue exemption stays regardless — one corpus is not a guarantee.'}`);
    const exempt = rows.filter(x => x.group === 'superseding' && x.exempt).length;
    console.log(`  superseding segments caught by the change-cue exemption: ${exempt}/${rows.filter(x => x.group === 'superseding').length}  ${pct(exempt / rows.filter(x => x.group === 'superseding').length)}`);
  }
  console.log('\nNo threshold is chosen here. Send this output back and it gets set in a follow-up PR.\n');

  const jsonIdx = process.argv.indexOf('--json');
  if (jsonIdx !== -1 && process.argv[jsonIdx + 1]) {
    const out = path.resolve(process.cwd(), process.argv[jsonIdx + 1]);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ seeded: SEEDED, rows, stats }, null, 2));
    console.log(`→ ${out}\n`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
