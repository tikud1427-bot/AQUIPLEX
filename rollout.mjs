#!/usr/bin/env node
/**
 * ROLLOUT — what each flag actually buys, and what it costs.
 *
 * `flagproof.mjs` answers "does this flag do anything at all". This answers a
 * different question: "if I turn these on IN THIS ORDER, what changes, and
 * where does it get worse". Those are not the same, and the second is the one
 * you need before touching a production .env.
 *
 * Eleven phases of work sits behind eight switches, most of them off. The
 * temptation is to flip all of them. Every row below is a measured reason not
 * to do that in one go — and one of them (SELF_ENTITY) buys the largest gain
 * in the whole set while being the only one with a real cost attached.
 *
 * Each stage runs in its OWN PROCESS against its OWN data dir, because several
 * flags are read at module load and every store is a module-level singleton.
 * Measuring stages in one process measures whatever the last stage left behind.
 *
 *   node rollout.mjs          # the table
 *   npm run rollout
 *
 * Re-run after each flip in staging: the numbers are a regression check, not
 * just a one-time recommendation.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'AQUA_BRAIN_INGEST=on,AQUA_BRAIN_INGEST_FACTS=on';

/** Cumulative — each stage is the previous one plus one switch. */
const STAGES = [
  ['0 · today',        BASE,                                            'what production runs right now'],
  ['1 · +UUS',         `${BASE},AQUA_UUS=on`,                           'a stated fact earns explicit standing'],
  ['2 · +SELF_ENTITY', `${BASE},AQUA_UUS=on,AQUA_SELF_ENTITY=on`,       'the owner becomes a node; retrieval can anchor on it'],
  ['3 · +CONTEXT_V2',  `${BASE},AQUA_UUS=on,AQUA_SELF_ENTITY=on,AQUA_CONTEXT_V2=on`, 'scored selection over the PIC floor'],
  ['4 · +REFLECT_V2',  `${BASE},AQUA_UUS=on,AQUA_SELF_ENTITY=on,AQUA_CONTEXT_V2=on,AQUA_REFLECT_V2=on`, 'AQUA acts on a delta'],
  ['5 · +VOICE',       `${BASE},AQUA_UUS=on,AQUA_SELF_ENTITY=on,AQUA_CONTEXT_V2=on,AQUA_REFLECT_V2=on,AQUA_REVISION_VOICE=on`, 'AQUA raises a revision unprompted'],
];

const rows = [];
for (const [label, flags, why] of STAGES) {
  const slug = label.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  const r = spawnSync(process.execPath, [path.join(HERE, 'rolloutstage.mjs'), slug, flags], {
    encoding: 'utf8', timeout: 120_000,
  });
  const line = (r.stdout ?? '').split('\n').find(l => l.startsWith('__RESULT__'));
  if (!line) {
    console.error(`stage ${label} produced no result:\n${(r.stderr ?? '').slice(-400)}`);
    process.exit(1);
  }
  rows.push({ label, why, ...JSON.parse(line.replace('__RESULT__', '')) });
}

const col = (s, n) => String(s).padEnd(n);
console.log('\n══════════════════════════════════════════════════════════════════════════════');
console.log('  ROLLOUT — measured on one realistic session, one process per stage');
console.log('══════════════════════════════════════════════════════════════════════════════\n');
console.log(`  ${col('stage', 18)}${col('facts', 7)}${col('score', 7)}${col('top-1', 7)}${col('noise', 7)}${col('voice', 6)}`);
console.log(`  ${'─'.repeat(52)}`);
for (const r of rows) {
  console.log(`  ${col(r.label, 18)}${col(r.worldFacts, 7)}${col(r.score, 7)}${col(r.top1, 7)}${col(r.noiseLines, 7)}${col(r.voice, 6)}`);
}

console.log(`
  facts  world-model facts written by the session
  score  understanding score — what the card and dashboard both show
  top-1  questions whose FIRST retrieved line answers them (6 asked)
  noise  context lines returned for four queries that are NOT about the user
  voice  would AQUA raise a revision unprompted on the next conversational turn

  A stage that raises noise without raising top-1 is a bad trade. Read the two
  columns together — every one of these flags is free except where noise moves.
`);
