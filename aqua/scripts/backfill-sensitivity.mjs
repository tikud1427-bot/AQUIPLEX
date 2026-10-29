#!/usr/bin/env node
/**
 * AQUA — tag existing health and mood facts (2026-10-28).
 *
 *     node scripts/backfill-sensitivity.mjs            # DRY RUN (default): counts only, writes nothing
 *     node scripts/backfill-sensitivity.mjs --apply    # tag them
 *     node scripts/backfill-sensitivity.mjs --apply --owner user:<id>
 *
 * What it does: every legacy fact that memory/sensitivity.js classifies as
 * health or mood gets `sensitivity: 'health'|'mood'`. Nothing is deleted or
 * changed otherwise (L5) — the user decides Delete / Keep on the Memory page.
 *
 * It is NOT what keeps these facts out of chat: every read path classifies at
 * read time, so they stop being injected the moment the code deploys, tagged
 * or not. Tagging makes the classification durable (a later classifier change
 * cannot silently un-hide a fact) and lets other tools see it.
 *
 * Idempotent: an already-tagged fact is skipped, so a second --apply reports
 * 0 changes. Prints owner ids, counts and kinds — never a fact's key or value
 * (keys are slugs of the value: custom_very_bored).
 *
 * Run it where the app runs, with the app's environment (it reads and writes
 * the same Mind store, through the same Mongo mirror). The store merges
 * concurrent writers per owner, so the live server can keep running; prefer a
 * quiet moment anyway.
 */
const apply = process.argv.includes('--apply');
const ownerArg = (() => { const i = process.argv.indexOf('--owner'); return i > 0 ? process.argv[i + 1] : null; })();

const { _iterateMindsForStats, touchMind } = await import('../src/mind/mindStore.js');
const { classifySensitivity } = await import('../src/memory/sensitivity.js');

const totals = { owners: 0, facts: 0, sensitive: 0, alreadyTagged: 0, tagged: 0, health: 0, mood: 0 };
const perOwner = [];
for (const mind of _iterateMindsForStats()) {
  if (ownerArg && mind.ownerId !== ownerArg) continue;
  const facts = Object.values(mind.facts ?? {});
  if (!facts.length) continue;
  totals.owners++;
  totals.facts += facts.length;
  const row = { owner: mind.ownerId, health: 0, mood: 0, toTag: 0 };
  for (const fact of facts) {
    const kind = classifySensitivity(fact);
    if (!kind) continue;
    totals.sensitive++;
    totals[kind]++;
    row[kind]++;
    if (fact.sensitivity === kind) { totals.alreadyTagged++; continue; }
    row.toTag++;
    if (apply) { fact.sensitivity = kind; totals.tagged++; }
  }
  if (row.health || row.mood) perOwner.push(row);
  if (apply && row.toTag) touchMind(mind);
}

console.log(`[BACKFILL] mode=${apply ? 'APPLY' : 'DRY-RUN'}${ownerArg ? ` owner=${ownerArg}` : ''}`);
for (const r of perOwner) console.log(`[BACKFILL] owner=${r.owner} health=${r.health} mood=${r.mood} ${apply ? 'tagged' : 'would_tag'}=${r.toTag}`);
console.log(`[BACKFILL] owners=${totals.owners} facts=${totals.facts} sensitive=${totals.sensitive} (health=${totals.health} mood=${totals.mood}) alreadyTagged=${totals.alreadyTagged} ${apply ? `tagged=${totals.tagged}` : `wouldTag=${totals.sensitive - totals.alreadyTagged}`}`);

if (apply && totals.tagged) {
  // The store writes on a debounce, then hands the file to the Mongo mirror.
  await new Promise(r => setTimeout(r, 1500));
  try {
    const { drainMirror } = await import('../src/core/mongoMirror.js');
    await drainMirror(20_000);
  } catch (err) {
    console.warn(`[BACKFILL] mirror drain: ${err?.message ?? err} — the local file is written; check the mirror before trusting the cloud copy`);
  }
}
if (!apply) console.log('[BACKFILL] nothing written. Re-run with --apply to tag.');
