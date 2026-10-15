#!/usr/bin/env node
/**
 * D6 — does natural change/correction language revise the World Model?
 * (real extractor, live Postgres)
 *
 *   AQUA_TEST_DATABASE_URL=postgresql://…/aqua_test node scripts/d6-extraction-check.mjs \
 *     [--json eval/out/x.json] [--only id,id] [--suite agreed|matrix]
 *
 * Each case is a sequence of TURNS (each tagged with its conversation), said
 * by a run-unique owner through the production E6 path (Brain.understandTurn
 * with the production extraction client, as the `understanding.turn.v1`
 * handler runs it) and drained by the worker's own code (dispatchReflections +
 * runOneJob). Then the World Model and the canonical answer context are read.
 *
 * expect 'change'  PASS when a current claim carries the new value, every
 *                  asserted claim of the old value is retired (superseded —
 *                  not merely disputed), and the canonical context for the
 *                  question contains the new value and not the old statement.
 * expect 'abstain' the change does not say WHICH value it replaces; PASS when
 *                  nothing was retired (no invented supersession).
 *
 * Suites: 'agreed' = the 15 cases scored in Part 2 (+ the 3 former
 * limitation cases, now scored); 'matrix' = the D6 test matrix of the fix
 * brief. A provider transport error is UNMEASURED — retried, never scored.
 *
 * SAFETY: writes only to AQUA_TEST_DATABASE_URL; owners are purged at the end.
 */
import '../eval/core/isolateDataDir.mjs';
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const testUrl = String(process.env.AQUA_TEST_DATABASE_URL ?? '').trim();
if (!testUrl) {
  console.error('\n✗ AQUA_TEST_DATABASE_URL is not set — this check writes claims and jobs and will not touch DATABASE_URL.\n');
  process.exit(2);
}
process.env.DATABASE_URL = testUrl;
{
  const envPath = path.join(ROOT, '..', '.env');
  if (existsSync(envPath)) createRequire(path.join(ROOT, 'package.json'))('dotenv').config({ path: envPath, quiet: true });
}
Object.assign(process.env, { AQUA_E6: 'on', AQUA_CONTEXT_V2: 'on', AQUA_RETRIEVAL_V3: 'on', AQUA_SELF_ENTITY: 'on' });

const argv = process.argv.slice(2);
const flag = n => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const JSON_OUT = flag('--json');
const ONLY = flag('--only')?.split(',') ?? null;
const SUITE = flag('--suite');

const Brain = await import('../src/brain/index.js');
const { dispatchReflections, runOneJob } = await import('../src/core/jobs/workerRuntime.js');
const { getPool, closePool } = await import('../src/core/db/pool.js');
const { purgeOwnerData } = await import('../src/account/accountPurge.js');

// A turn in conversation `a` (the past) or `b` (later, a new conversation).
const A = text => ({ conv: 'a', text });
const B = text => ({ conv: 'b', text });

const CITY = { oldValue: 'Lisbon', newValue: 'Porto', ask: 'Which city do I live in?' };
const JOB = { oldValue: 'Initech', newValue: 'Hooli', ask: 'Where do I work?' };
const LAUNCH = { oldValue: 'April 15', newValue: 'May 2', ask: 'When is the Tidepool launch?' };
const TECH = { oldValue: 'Go', newValue: 'Rust', ask: "What is Tidepool's backend written in?" };
const LIVE = A('I live in Lisbon.'), WORK = A('I work at Initech.'), LAUNCH_AT = A('The Tidepool launch is on April 15.'), GO = A("Tidepool's backend is written in Go.");

export const CASES = [
  // ── agreed: Part 2's 15, unchanged sentences ───────────────────────────────
  { suite: 'agreed', id: 'city-move-from-to', ...CITY, turns: [LIVE, B('I moved from Lisbon to Porto.')] },
  { suite: 'agreed', id: 'city-now', ...CITY, turns: [LIVE, B('I live in Porto now.')] },
  { suite: 'agreed', id: 'city-actually', ...CITY, turns: [LIVE, B('Actually, I moved to Porto.')] },
  { suite: 'agreed', id: 'city-anymore', ...CITY, turns: [LIVE, B("I don't live in Lisbon anymore; I'm in Porto.")] },
  { suite: 'agreed', id: 'city-moved-to', ...CITY, turns: [LIVE, B('I moved to Porto.')] },
  { suite: 'agreed', id: 'city-negation-only', ...CITY, newValue: null, turns: [LIVE, B("I don't live in Lisbon anymore.")] },
  { suite: 'agreed', id: 'job-changed-from-to', ...JOB, turns: [WORK, B('My company changed from Initech to Hooli.')] },
  { suite: 'agreed', id: 'job-no-longer', ...JOB, turns: [WORK, B('I no longer work at Initech. I work at Hooli now.')] },
  { suite: 'agreed', id: 'job-employer-now', ...JOB, turns: [WORK, B('My employer is now Hooli.')] },
  { suite: 'agreed', id: 'launch-changed-from-to', ...LAUNCH, turns: [LAUNCH_AT, B('The launch date changed from April 15 to May 2.')] },
  { suite: 'agreed', id: 'launch-actually', ...LAUNCH, turns: [LAUNCH_AT, B('Actually, the launch is May 2.')] },
  { suite: 'agreed', id: 'launch-moved', ...LAUNCH, turns: [LAUNCH_AT, B('The launch moved to May 2.')] },
  { suite: 'agreed', id: 'tech-not-x-dash-y', ...TECH, turns: [GO, B('Not Go — Rust.')] },
  { suite: 'agreed', id: 'tech-not-x-its-y', ...TECH, turns: [GO, B("Not Go, it's Rust.")] },
  { suite: 'agreed', id: 'tech-switched-from', ...TECH, turns: [GO, B('We switched the backend from Go to Rust.')] },
  // Former "limitation" cases: the backend held ONE value, so the brief says the change may be inferred.
  { suite: 'agreed+', id: 'tech-switched-unnamed', ...TECH, turns: [GO, B('We switched the backend to Rust.')] },
  { suite: 'agreed+', id: 'tech-now-unnamed', ...TECH, turns: [GO, B('The backend is Rust now.')] },
  { suite: 'agreed+', id: 'multi-fact', ...TECH, turns: [A("Tidepool's backend is written in Go and the database is MySQL."), B('The backend is Rust now and the database is Postgres.')] },

  // ── matrix: the fix brief's §9, in its own words where it gives them ────────
  { suite: 'matrix', id: 'm-explicit-employer-now', oldValue: 'Initech', newValue: 'Acme', ask: 'Where do I work?', turns: [WORK, B('My employer is now Acme.')] },
  { suite: 'matrix', id: 'm-ref-launch-date', oldValue: 'March 15', newValue: 'May 2', ask: 'When is the Tidepool launch?',
    turns: [A('The Tidepool launch date is March 15.'), B('The launch date changed to May 2.')] },
  { suite: 'matrix', id: 'm-ref-company-now', oldValue: 'Initech', newValue: 'Acme', ask: 'Where do I work?', turns: [WORK, B('The company is now Acme.')] },
  { suite: 'matrix', id: 'm-correction-actually-backend', ...TECH, turns: [GO, B('Actually, the backend is Rust.')] },
  { suite: 'matrix', id: 'm-pronoun-backend', ...TECH, ask: 'What is the backend written in?',
    turns: [A("I'm building an app called Tidepool."), A('The backend is Go.'), A("It's written in Rust.")] },
  { suite: 'matrix', id: 'm-pronoun-launch', oldValue: 'March 15', newValue: 'May 2', ask: 'When is the launch?',
    turns: [A("I'm building an app called Tidepool."), A('The launch is March 15.'), A("It's now May 2.")] },
  { suite: 'matrix', id: 'm-pronoun-employer', ...JOB, turns: [A('I work at Initech.'), A("I'm at Hooli now.")] },
  { suite: 'matrix', id: 'm-conversational-correction', ...TECH, ask: 'What is the backend written in?',
    turns: [A("I'm building an app called Tidepool."), A('The backend is Go.'), A("No, it's Rust.")] },
  { suite: 'matrix', id: 'm-replacement-employer-from-to', ...JOB, turns: [WORK, B('My employer changed from Initech to Hooli.')] },
  // Must NOT invent a replacement: two current values could be the one replaced.
  { suite: 'matrix', id: 'm-ambiguous-two-technologies', expect: 'abstain', oldValues: ['Go', 'Postgres'], ask: 'What does Tidepool use?',
    turns: [A('Tidepool uses Go and Postgres.'), B('Tidepool uses Rust now.')] },
  { suite: 'matrix', id: 'm-ambiguous-two-backends', expect: 'abstain', oldValues: ['Go', 'Kotlin'], ask: 'What is the backend written in?',
    turns: [A("Tidepool's backend is written in Go and Harbor's backend is written in Kotlin."), A("It's written in Rust now.")] },
];

const run = `${Date.now().toString(36)}`;
const q = async (sql, args) => (await (await getPool()).query(sql, args)).rows;
async function drain(ownerId) {
  for (let i = 0; i < 200; i++) {
    await dispatchReflections({ limit: 200 });
    const job = await runOneJob(`d6-check-${run}`);
    if (job) continue;
    const [{ n }] = await q(`SELECT (SELECT count(*) FROM aqua_outbox WHERE owner_id=$1 AND state IN ('pending','processing'))
      + (SELECT count(*) FROM aqua_jobs WHERE owner_id=$1 AND state IN ('queued','running')) AS n`, [ownerId]);
    if (!Number(n)) return;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`drain did not settle for ${ownerId}`);
}
const claimsOf = ownerId => q(`
  SELECT c.predicate, c.polarity, c.state, c.statement_text, se.canonical_label AS subject,
         coalesce(e.canonical_label, c.object_literal, c.object_quantity::text, c.object_time_from::text) AS object,
         (SELECT bool_or((ev.locator->>'revision')::boolean) FROM aqua_claim_evidence ce
            JOIN aqua_evidence ev ON ev.owner_id=ce.owner_id AND ev.evidence_id=ce.evidence_id
           WHERE ce.owner_id=c.owner_id AND ce.claim_id=c.claim_id) AS revision
    FROM aqua_claims c LEFT JOIN aqua_entities e ON e.owner_id=c.owner_id AND e.entity_id=c.object_entity_id
    LEFT JOIN aqua_entities se ON se.owner_id=c.owner_id AND se.entity_id=c.subject_entity_id
   WHERE c.owner_id=$1 AND c.predicate <> 'unresolved' ORDER BY c.created_at`, [ownerId]);

const CURRENT = new Set(['active', 'trusted', 'stale']);
const has = (s, v) => String(s ?? '').toLowerCase().includes(String(v).toLowerCase());
const word = (s, v) => new RegExp(`\\b${String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(String(s ?? ''));
/**
 * A transport error (provider 503/429) is not an extraction result. Production
 * retries the durable job; this retries the turn, and a turn that never got an
 * answer is UNMEASURED — never scored as a failure (or a pass).
 */
async function understand(args) {
  for (let i = 0; i < 6; i++) {
    const r = await Brain.understandTurn(args);
    if (!(r?.stats?.errors > 0)) return true;
    await new Promise(res => setTimeout(res, 10_000 * (i + 1)));
  }
  return false;
}

const results = [];
for (const c of CASES.filter(x => (!ONLY || ONLY.includes(x.id)) && (!SUITE || x.suite.startsWith(SUITE)))) {
  const userId = `d6-${run}-${c.id}`;
  const ownerId = `user:${userId}`;
  const expect = c.expect ?? 'change';
  try {
    const turnIn = {};
    for (const t of c.turns) {
      const conversationId = `${c.id}-${t.conv}`;
      turnIn[t.conv] = (turnIn[t.conv] ?? 0) + 1;
      if (!await understand({ ownerId, conversationId, turn: turnIn[t.conv], userMessage: t.text })) throw new Error(`UNMEASURED: provider never answered «${t.text}»`);
      await drain(ownerId);
    }
    const rows = await claimsOf(ownerId);
    const asserted = rows.filter(r => r.polarity === 'asserted');
    const retired = r => !CURRENT.has(r.state) && r.state !== 'disputed';
    let pass, detail;
    if (expect === 'abstain') {
      const olds = asserted.filter(r => c.oldValues.some(v => word(r.object, v)));
      const invented = olds.filter(retired);
      pass = olds.length >= c.oldValues.length && invented.length === 0;
      detail = { oldClaims: olds.length, retired: invented.map(r => r.object) };
    } else {
      const oldAsserted = asserted.filter(r => word(r.object, c.oldValue) && !(c.newValue && word(r.object, c.newValue)));
      const newCurrent = c.newValue ? asserted.filter(r => CURRENT.has(r.state) && word(r.object, c.newValue)) : [];
      const oldRetired = oldAsserted.length > 0 && oldAsserted.every(retired);
      const ctx = await Brain.assembleContextAsync(ownerId, c.ask, () => ({ items: [], block: '', stats: {} }),
        { limit: 8, taskType: 'memory_recall', canonicalOnly: true, semanticScores: await Brain.canonicalSemanticScores(ownerId, c.ask) });
      const block = ctx.block ?? '';
      const oldStatements = c.turns.slice(0, -1).map(t => t.text.replace(/\.$/, ''));
      const ctxOk = (!c.newValue || has(block, c.newValue)) && !oldStatements.some(s => word(s, c.oldValue) && block.includes(s));
      pass = (c.newValue ? newCurrent.length > 0 : true) && oldRetired && ctxOk;
      detail = { newCurrent: newCurrent.length > 0, oldRetired, ctxOk };
    }
    const r = { suite: c.suite, id: c.id, expect, turns: c.turns.map(t => `${t.conv}: ${t.text}`), pass, ...detail,
      claims: rows.map(x => `${x.subject}|${x.predicate}|${x.object}|${x.polarity}|${x.state}${x.revision ? '|rev' : ''}`) };
    results.push(r);
    console.log(`${pass ? '✓' : '✗'} [${c.suite}] ${c.id.padEnd(32)} ${expect === 'abstain' ? `abstain retired=${JSON.stringify(detail.retired)}` : `new-current=${detail.newCurrent} old-retired=${detail.oldRetired} context=${detail.ctxOk}`}  «${c.turns.at(-1).text}»`);
    if (!pass) for (const line of r.claims) console.log(`      ${line}`);
  } catch (err) {
    results.push({ suite: c.suite, id: c.id, expect, pass: false, error: String(err?.message ?? err) });
    console.log(`✗ [${c.suite}] ${c.id} ERROR ${err?.message ?? err}`);
  } finally {
    try { await purgeOwnerData({ userId }); } catch { /* best effort */ }
  }
}
const measured = results.filter(r => !/UNMEASURED/.test(r.error ?? ''));
for (const s of ['agreed', 'agreed+', 'matrix']) {
  const in_ = measured.filter(r => r.suite === s);
  if (in_.length) console.log(`D6 ${s.padEnd(8)}: ${in_.filter(r => r.pass).length}/${in_.length} pass`);
}
console.log(`unmeasured (provider never answered): ${results.length - measured.length}`);
if (JSON_OUT) writeFileSync(path.resolve(ROOT, JSON_OUT), `${JSON.stringify({ run, model: process.env.AQUA_E6_MODEL ?? 'production default', results }, null, 2)}\n`);
await closePool();
process.exit(0);
