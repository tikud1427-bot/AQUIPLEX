#!/usr/bin/env node
/**
 * Re-explanation, LONGITUDINAL (Phase 3 / Gate 9) — a controlled evaluation.
 *
 *   AQUA_TEST_DATABASE_URL=… node scripts/reexplanation-longitudinal.mjs
 *     [--e6-provider nvidia --e6-model openai/gpt-oss-20b] [--json eval/out/x.json] [--keep]
 *
 * Dataset: eval/longitudinal/reexplanation-longitudinal.v1.json (pre-registered).
 * Each persona lives through sessions. Per session, per condition:
 *   1. the session's world CHANGES are said (and the probes' current values update),
 *   2. every probe asks for something that depends on a fact about the user,
 *   3. the probe SUCCEEDS when the context that condition would answer from
 *      contains the probe's CURRENT value; otherwise the user must RE-EXPLAIN,
 *      and that utterance becomes part of that condition's knowledge.
 * Forced re-explanation rate per session = re-explanations / probes.
 *
 * Conditions (identical protocol, separate knowledge):
 *   worldModel  the production canonical context (liftRuntime.worldModelContext),
 *               every utterance ingested through the production E6 worker path
 *   memory      BM25 top-8 over every utterance this user said so far (liftCore)
 *   stateless   nothing is retained → every probe is a re-explanation
 *
 * Also records, per World-Model owner, the production instrument
 * (GET /brain/reexplanation: volunteered S8 restatements / statements).
 * Context-level presence is a deterministic proxy for "Aqua had what it needed";
 * it does not grade the answer model (the Lift does that).
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
Object.assign(process.env, { AQUA_E6: 'on', AQUA_CONTEXT_V2: 'on', AQUA_RETRIEVAL_V3: 'on', AQUA_SELF_ENTITY: 'on', AQUA_CROSS_ENCODER: 'off', AQUA_CANONICAL_READ: 'on' });
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
if (flag('--e6-provider')) process.env.AQUA_E6_PROVIDER = flag('--e6-provider');
if (flag('--e6-model')) process.env.AQUA_E6_MODEL = flag('--e6-model');
const ONLY = flag('--personas', null)?.split(',') ?? null;

const L = await import('../eval/lift/liftCore.mjs');
const R = await import('../eval/lift/liftRuntime.mjs');
const { getPool, closePool } = await import('../src/core/db/pool.js');
const { reexplanationStats } = await import('../src/core/worldModel/canonicalReadModel.js');
const { purgeOwnerData } = await import('../src/account/accountPurge.js');
const DS = JSON.parse(readFileSync(path.join(ROOT, 'eval/longitudinal/reexplanation-longitudinal.v1.json'), 'utf8'));
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const CONDS = ['worldModel', 'memory', 'stateless'];

/** Deterministic presence: word-bounded; values of ≤ 2 chars ("R") are case-sensitive. */
export function hasValue(context, value) {
  const v = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${v}($|[^A-Za-z0-9])`, String(value).length <= 2 ? '' : 'i').test(String(context ?? ''));
}

async function main() {
  const personas = DS.personas.filter(p => !ONLY || ONLY.includes(p.id));
  const out = { experiment: 'reexplanation-longitudinal', dataset: `${DS.id}.v${DS.version}`, run: RUN, ranAt: new Date().toISOString(),
    e6: { provider: process.env.AQUA_E6_PROVIDER ?? 'default', model: process.env.AQUA_E6_MODEL ?? 'default' }, personas: {} };

  for (const persona of personas) {
    const ownerId = `user:longi-${RUN}-${persona.id}`;
    const userId = `longi-${RUN}-${persona.id}`;
    const probes = Object.fromEntries(persona.probes.map(p => [p.id, { ...p, stale: [] }]));
    const memory = [...persona.intro];
    const wmState = { turn: 0 };
    await sayWM(ownerId, persona, persona.intro, wmState);
    const rec = { ownerId, sessions: [] };
    for (const [k, session] of persona.sessions.entries()) {
      for (const [id, u] of Object.entries(session.updates ?? {})) Object.assign(probes[id], u);
      if (session.changes?.length) {
        await sayWM(ownerId, persona, session.changes, wmState);
        memory.push(...session.changes);
      }
      const row = { session: k, probes: Object.keys(probes).length, worldModel: [], memory: [], stateless: [] };
      for (const p of Object.values(probes)) {
        const wmCtx = (await R.worldModelContext(ownerId, p.q)).block;
        const memCtx = L.formatTurns(L.bm25Retrieve(memory, p.q, 8));
        const ok = { worldModel: hasValue(wmCtx, p.need), memory: hasValue(memCtx, p.need), stateless: false };
        for (const c of CONDS) {
          row[c].push({ probe: p.id, need: p.need, ok: ok[c],
            staleAlsoShown: c === 'stateless' ? false : (p.stale ?? []).some(s => hasValue(c === 'worldModel' ? wmCtx : memCtx, s)) });
        }
        // Re-explanations become that condition's knowledge.
        if (!ok.worldModel) await sayWM(ownerId, persona, [p.explain], wmState);
        if (!ok.memory) memory.push(p.explain);
      }
      for (const c of CONDS) row[`${c}Rate`] = Number((row[c].filter(x => !x.ok).length / row.probes).toFixed(4));
      rec.sessions.push(row);
      console.log(`[LONGI] ${persona.id} s${k}: WM ${row.worldModelRate}  MEM ${row.memoryRate}  NONE ${row.statelessRate}`);
    }
    rec.productionInstrument = await reexplanationStats(ownerId, { sinceDays: 2 });
    out.personas[persona.id] = rec;
    if (!argv.includes('--keep')) await purgeOwnerData({ userId });
  }

  // aggregate: mean rate per session across personas, and the least-squares slope
  const S = Math.max(...Object.values(out.personas).map(r => r.sessions.length));
  out.bySession = Array.from({ length: S }, (_, k) => Object.fromEntries(CONDS.map(c => {
    const xs = Object.values(out.personas).map(r => r.sessions[k]?.[`${c}Rate`]).filter(x => x != null);
    return [c, Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(4))];
  })));
  const slope = ys => { const n = ys.length, mx = (n - 1) / 2, my = ys.reduce((a, b) => a + b, 0) / n;
    return Number((ys.reduce((s, y, x) => s + (x - mx) * (y - my), 0) / ys.reduce((s, _, x) => s + (x - mx) ** 2, 0)).toFixed(4)); };
  out.trend = Object.fromEntries(CONDS.map(c => [c, { first: out.bySession[0][c], last: out.bySession[S - 1][c],
    slopePerSession: slope(out.bySession.map(s => s[c])) }]));
  out.missesAfterFirstSession = Object.fromEntries(CONDS.map(c => [c,
    Object.values(out.personas).reduce((n, r) => n + r.sessions.slice(1).reduce((m, s) => m + s[c].filter(x => !x.ok).length, 0), 0)]));
  const file = flag('--json', path.join('eval', 'out', `reexplanation-longitudinal.${RUN}.json`));
  mkdirSync(path.dirname(path.resolve(ROOT, file)), { recursive: true });
  writeFileSync(path.resolve(ROOT, file), `${JSON.stringify(out, null, 2)}\n`);
  console.log('\nRE-EXPLANATION RATE BY SESSION (mean over personas)');
  out.bySession.forEach((s, k) => console.log(`  session ${k}: ${CONDS.map(c => `${c} ${s[c]}`).join('  ')}`));
  console.log(`trend: ${JSON.stringify(out.trend)}`);
  console.log(`→ ${file}`);
  await closePool();
}

/** Say utterances to the World Model through the production worker path; turns numbered continuously. */
async function sayWM(ownerId, persona, utterances, state) {
  if (!utterances.length) return;
  const turns = utterances.map((text, i) => ({ turn: state.turn + i + 1, text }));
  state.turn += utterances.length;
  await R.ingestTurns(ownerId, `longi-${RUN}-${persona.id}`, turns, { runId: RUN });
}

main().catch(async err => { console.error(err); try { await closePool(); } catch {} process.exit(1); });
