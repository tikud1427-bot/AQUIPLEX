#!/usr/bin/env node
/**
 * World-Model STATE PROBE — the provider-free half of the Lift's condition C.
 *
 *   AQUA_TEST_DATABASE_URL=postgresql://…/aqua_test node scripts/world-model-state-probe.mjs
 *     [--personas p1-meera,p2-daniel] [--e6-provider nvidia --e6-model openai/gpt-oss-20b]
 *     [--reuse eval/out/world-model-state-probe.<run>.json] [--json <out>] [--purge]
 *
 * Builds each persona's World Model through the production worker path (the
 * same liftRuntime.ingestPersona the Lift uses — real E6 extraction), then,
 * for every Lift question, assembles the production answer context and dumps
 * WHAT THE ANSWER MODEL WOULD SEE and WHY: the claim table (state, polarity,
 * subject → predicate → object), the QueryPlan and slot status, candidates /
 * selected / dropped with reasons, and the rendered block.
 *
 * No answer model, no judge: it isolates "is the World Model's state right and
 * does the context carry it" from "did the answer model reason well", which is
 * the first split of the Phase-2 failure taxonomy. --reuse keeps the owners of
 * an earlier probe so a context-side change can be re-probed without
 * re-extracting (which is what costs provider quota).
 *
 * SAFETY: writes only to AQUA_TEST_DATABASE_URL, like the Lift.
 */
import '../eval/core/isolateDataDir.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const testUrl = String(process.env.AQUA_TEST_DATABASE_URL ?? '').trim();
if (!testUrl) { console.error('✗ AQUA_TEST_DATABASE_URL is not set.'); process.exit(2); }
process.env.DATABASE_URL = testUrl;
{
  const envPath = path.join(ROOT, '..', '.env');
  if (existsSync(envPath)) createRequire(path.join(ROOT, 'package.json'))('dotenv').config({ path: envPath, quiet: true });
}
Object.assign(process.env, {
  AQUA_E6: 'on', AQUA_CONTEXT_V2: 'on', AQUA_RETRIEVAL_V3: 'on', AQUA_SELF_ENTITY: 'on', AQUA_CROSS_ENCODER: 'off',
  AQUA_CANONICAL_READ: 'on',
});
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
if (flag('--e6-provider')) process.env.AQUA_E6_PROVIDER = flag('--e6-provider');
if (flag('--e6-model')) process.env.AQUA_E6_MODEL = flag('--e6-model');
const ONLY = flag('--personas', null)?.split(',').map(s => s.trim()).filter(Boolean) ?? null;
const REUSE = flag('--reuse', null);
const PRIOR = REUSE ? JSON.parse(readFileSync(path.resolve(ROOT, REUSE), 'utf8')) : null;
const RUN = PRIOR?.run ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const DATASET = flag('--dataset', 'eval/lift/world-model-lift-live.v1.json');

const R = await import('../eval/lift/liftRuntime.mjs');
const { getPool, closePool } = await import('../src/core/db/pool.js');
const { purgeOwnerData } = await import('../src/account/accountPurge.js');
const DS = JSON.parse(readFileSync(path.join(ROOT, DATASET), 'utf8'));

const STOP = new Set('a an the is are was were be of to in on at for with and or by it its that this they their our we you your i my me he she his her them not no'.split(' '));
const words = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 2 && !STOP.has(w));
/** Rough lexical coverage of a rubric item by the context block (diagnostic only, never a score). */
const coverage = (item, block) => {
  const w = words(item); if (!w.length) return null;
  const b = new Set(words(block));
  return Number((w.filter(x => b.has(x)).length / w.length).toFixed(2));
};

async function claimTable(ownerId) {
  const pool = await getPool();
  const { rows } = await pool.query(`
    SELECT c.state, c.polarity, c.modality, c.predicate, s.canonical_label AS subj,
           COALESCE(o.canonical_label, c.object_literal, c.object_quantity::text, to_char(c.object_time_from,'YYYY-MM-DD')) AS obj,
           c.valid_from, c.valid_to, c.statement_text, c.superseded_by IS NOT NULL AS has_successor
      FROM aqua_claims c JOIN aqua_entities s ON s.entity_id = c.subject_entity_id
      LEFT JOIN aqua_entities o ON o.entity_id = c.object_entity_id
     WHERE c.owner_id = $1 ORDER BY c.asserted_at, c.claim_id`, [ownerId]);
  return rows.map(r => `${r.state.padEnd(10)} ${r.polarity === 'negated' ? 'NOT ' : '    '}${r.modality === 'fact' ? '' : `[${r.modality}] `}${r.subj} —${r.predicate}→ ${r.obj ?? '∅'}${r.valid_to ? ` (until ${new Date(r.valid_to).toISOString().slice(0, 10)})` : ''}   «${r.statement_text}»`);
}

const out = { run: RUN, dataset: DATASET, ranAt: new Date().toISOString(), e6: { provider: process.env.AQUA_E6_PROVIDER ?? 'default', model: process.env.AQUA_E6_MODEL ?? 'default' }, personas: {} };
const personas = DS.personas.filter(p => !ONLY || ONLY.includes(p.id));
for (const persona of personas) {
  const userId = `probe-${RUN}-${persona.id}`;
  const ownerId = `user:${userId}`;
  const rec = { ownerId, userId, questions: [] };
  if (!PRIOR?.personas?.[persona.id]) {
    const ing = await R.ingestPersona(ownerId, persona, { runId: RUN });
    rec.jobs = ing.jobs;
  } else rec.jobs = PRIOR.personas[persona.id].jobs;
  rec.claims = await claimTable(ownerId);
  console.log(`\n════════ ${persona.id} — ${rec.claims.length} claims · jobs ${JSON.stringify(rec.jobs)}`);
  for (const line of rec.claims) console.log(`  ${line}`);
  for (const q of persona.questions) {
    const wm = await R.worldModelContext(ownerId, q.q);
    const req = (q.required ?? []).map(r => ({ item: r, coverage: coverage(r, wm.block) }));
    rec.questions.push({ id: q.id, cat: q.cat, q: q.q, expectUnknown: !!q.expectUnknown, required: req, forbidden: q.forbidden ?? [], wm });
    console.log(`\n── ${q.id} [${q.cat}] ${q.q}${q.expectUnknown ? '  (expect UNKNOWN)' : ''}`);
    console.log(`   plan=${wm.queryPlan?.intent ?? '-'} slots=${JSON.stringify(wm.queryPlan?.slots ?? [])} missing=${JSON.stringify(wm.requiredSlotsMissing)}`);
    console.log(`   candidates=${wm.candidates} selected=${wm.selected} dropped=${JSON.stringify(wm.dropReasons)}`);
    console.log(`   required: ${req.map(r => `${r.item} [${r.coverage}]`).join(' | ') || '—'}${(q.forbidden ?? []).length ? `   forbidden: ${q.forbidden.join(' | ')}` : ''}`);
    console.log(wm.block.split('\n').map(l => `   │ ${l}`).join('\n'));
  }
  out.personas[persona.id] = rec;
}
const file = flag('--json', path.join('eval', 'out', `world-model-state-probe.${RUN}.json`));
mkdirSync(path.dirname(path.resolve(ROOT, file)), { recursive: true });
writeFileSync(path.resolve(ROOT, file), `${JSON.stringify(out, null, 2)}\n`);
console.log(`\n→ ${file}`);
if (argv.includes('--purge')) {
  for (const p of Object.values(out.personas)) await purgeOwnerData({ userId: p.userId });
  console.log('purged');
}
await closePool();
