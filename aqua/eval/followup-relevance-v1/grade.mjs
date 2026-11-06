#!/usr/bin/env node
/**
 * Frozen grader for followup-relevance.v1 (written 2026-11-05, before the
 * implementation it grades). Offline: no key, no network (fetch is a tripwire),
 * a private data dir, no Mongo, no database.
 *
 *   node eval/followup-relevance-v1/grade.mjs [--json <file>] [--verbose]
 *
 * Refuses to run when dataset.v1.json, grade.mjs or README.md differ from
 * MANIFEST.sha256 (--unfrozen-ok exists only for authoring before the freeze).
 * Exit 0 = every case passes; 1 = a case fails or is invalid; 2 = refused.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AQUA = path.resolve(HERE, '../..');
const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const jsonOut = (() => { const i = argv.indexOf('--json'); return i >= 0 ? argv[i + 1] : null; })();

// ── freeze check ──────────────────────────────────────────────────────────────
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
{
  const man = path.join(HERE, 'MANIFEST.sha256');
  const bad = !fs.existsSync(man) ? ['MANIFEST.sha256 missing'] : fs.readFileSync(man, 'utf8').split('\n').filter(Boolean)
    .map(l => l.match(/^([0-9a-f]{64}) [ *](.+)$/)).filter(Boolean)
    .filter(([, h, f]) => !fs.existsSync(path.join(HERE, f)) || sha(path.join(HERE, f)) !== h).map(([, , f]) => f);
  if (bad.length && !argv.includes('--unfrozen-ok')) { console.error(`refused: frozen files changed: ${bad.join(', ')}`); process.exit(2); }
  if (bad.length) console.log(`UNFROZEN (authoring only): ${bad.join(', ')}`);
}

// ── isolation ────────────────────────────────────────────────────────────────
let netAttempts = 0;
globalThis.fetch = async () => { netAttempts++; throw new Error('followup-relevance grader: network is blocked'); };
for (const k of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|MONGO|DATABASE|^AQUA_SEMANTIC_RECALL$|^AQUA_RECALL_ALL_CHARS$|^AQUA_EPISODIC_RECALL$|^AQUA_RECALL_FOLLOWUP_V2$/i.test(k)) delete process.env[k];
process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-followup-v1-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';

const imp = p => import(pathToFileURL(path.join(AQUA, p)).href);
const R = await imp('src/memory/episodicRecall.js');
const RR = await imp('src/memory/recallRedactions.js');
const { classifyText } = await imp('src/memory/sensitivity.js');
const DS = JSON.parse(fs.readFileSync(path.join(HERE, 'dataset.v1.json'), 'utf8'));

const DAY = 86_400_000, T0 = Date.UTC(2026, 2, 2);
const FILLERS = [
  'The cat slept on the sofa all afternoon.', 'I watered the tomatoes on the balcony.', 'We watched a documentary about owls.',
  'The kettle whistles very loudly.', 'My neighbour plays the cello in the evenings.', 'I bought green apples at the market.',
  'The bus was crowded this morning.', 'I read a short story about a lighthouse keeper.',
];
const RELATIONS = DS.contract.relationOrder;

function build(c) {
  const userId = `u-${c.id}`;
  const conversations = new Map();
  const items = [...c.history, ...FILLERS.map((text, i) => ({ id: `f${i}`, day: 60 + i, text }))];
  for (const it of items) {
    if (it.deleted) continue;                    // a deleted conversation is not in the store
    conversations.set(`${c.id}-${it.id}`, { meta: { userId: it.owner ?? userId, title: `${c.id} ${it.id}` },
      messages: [{ role: 'user', content: it.text, ts: T0 + it.day * DAY }] });
  }
  return { userId, conversations, convOf: id => `${c.id}-${id}` };
}

async function run(c, { followUps } = {}) {
  const { userId, conversations, convOf } = build(c);
  R.__clearCacheForTests();
  const fu = followUps ?? c.followUps ?? 3;
  if (c.mode === 'turn') {
    const r = await R.recallForTurn({ ownerId: `user:${userId}`, userId, conversationId: 'none', query: c.question, conversations,
      includeFiles: false, allUnderChars: 0, k: c.k ?? 8, followUps: fu });
    return { excerpts: r.excerpts, stats: r.stats, convOf };
  }
  const units = R.collectUnits({ userId, conversationId: 'none', conversations });
  const opts = { allUnderChars: 0, k: c.k ?? (c.mode === 'keyword' ? 1 : 8), followUps: fu };
  if (c.mode === 'meaning') opts.semantic = new Map(units.map(u => [u.key, u.conversationId === convOf(c.seed) ? 0.75 : 0.45]));
  const r = R.selectRecall(units, c.question, opts);
  return { excerpts: r.excerpts, stats: r.stats, convOf };
}

const found = (res, id) => res.excerpts.find(e => e.conversationId === res.convOf(id));

const report = { dataset: DS.id, datasetSha256: sha(path.join(HERE, 'dataset.v1.json')), graderSha256: sha(path.join(HERE, 'grade.mjs')), at: new Date().toISOString(), cases: [], legacy: [] };
let failed = 0;

// Forgets are recorded once, per case owner, through the production store.
RR.__resetForTests();
for (const c of DS.cases) {
  if (!c.forget) continue;
  const owner = `user:u-${c.id}`;
  if (c.forget.phrases?.length) RR.redactPhrases(owner, c.forget.phrases);
  if (Number.isFinite(c.forget.beforeDay)) RR.redactAllBefore(owner, T0 + c.forget.beforeDay * DAY);
}

for (const c of DS.cases) {
  const problems = [];
  // Validity: privacy cases must test the forget list, not the sensitivity policy.
  for (const t of [c.question, ...c.history.map(h => h.text)]) if (classifyText(t)) problems.push(`INVALID: sensitive text "${t}" (${classifyText(t)})`);
  const flags = c.flags ?? ['v2'];
  const outcome = {};
  for (const flag of flags) {
    if (flag === 'v2') process.env.AQUA_RECALL_FOLLOWUP_V2 = 'on'; else delete process.env.AQUA_RECALL_FOLLOWUP_V2;
    // Preconditions (follow-ups off): the seed is chosen by ranking; no target is.
    const pre = await run(c, { followUps: 0 });
    if (c.seed) {
      const s = found(pre, c.seed);
      const want = c.mode === 'meaning' ? 'semantic' : 'match';
      if (!s) problems.push(`[${flag}] INVALID: seed ${c.seed} not selected by ranking`);
      else if (c.mode !== 'turn' && s.why !== want) problems.push(`[${flag}] INVALID: seed ${c.seed} selected as ${s.why}, expected ${want}`);
    }
    // Not for 'turn' (privacy) cases: there the leak under test may be the RANKING itself.
    if (c.mode !== 'turn') for (const e of c.expect) if (e.id !== c.seed && (e.why === 'follow-up' || !e.quoted) && found(pre, e.id)) problems.push(`[${flag}] INVALID: ${e.id} already selected without follow-ups`);
    // The graded run.
    const res = await run(c);
    for (const e of c.expect) {
      const x = found(res, e.id);
      if (!e.quoted) { if (x) problems.push(`[${flag}] ${e.id} quoted (${x.why}${x.relation ? `/${x.relation}` : ''}), expected not quoted`); continue; }
      if (!x) { problems.push(`[${flag}] ${e.id} not quoted, expected ${e.why ?? 'quoted'}${e.relation ? `/${e.relation}` : ''}`); continue; }
      if (e.why && x.why !== e.why) problems.push(`[${flag}] ${e.id} why=${x.why}, expected ${e.why}`);
      if (flag === 'v2' && e.relation) {
        if (!RELATIONS.includes(x.relation)) problems.push(`[${flag}] ${e.id} relation=${x.relation}, not in the contract`);
        else if (x.relation !== e.relation) problems.push(`[${flag}] ${e.id} relation=${x.relation}, expected ${e.relation}`);
      }
      if (flag === 'v2' && e.hedged != null && !!x.hedged !== e.hedged) problems.push(`[${flag}] ${e.id} hedged=${!!x.hedged}, expected ${e.hedged}`);
    }
    // Invariants: date order; the seed is never dropped by follow-ups; follow-ups within the total budget.
    const ts = res.excerpts.map(e => e.ts ?? 0);
    if (ts.some((t, i) => i && t < ts[i - 1])) problems.push(`[${flag}] excerpts not in date order`);
    if (c.seed && found(pre, c.seed) && !found(res, c.seed)) problems.push(`[${flag}] seed ${c.seed} dropped`);
    const fus = res.excerpts.filter(e => e.why === 'follow-up').length;
    if (fus > (c.followUps ?? 3)) problems.push(`[${flag}] ${fus} follow-ups exceed the budget ${c.followUps ?? 3}`);
    outcome[flag] = res.excerpts.map(e => { const id = c.history.find(h => res.convOf(h.id) === e.conversationId)?.id ?? e.conversationId; return `${id}:${e.why}${e.relation ? `/${e.relation}` : ''}${e.hedged ? '/hedged' : ''}`; });
  }
  // Informational: what the legacy follow-up step (flag off) does on the admission cases.
  if (!flags.includes('off')) {
    delete process.env.AQUA_RECALL_FOLLOWUP_V2;
    const res = await run(c);
    const agrees = c.expect.every(e => !!found(res, e.id) === e.quoted);
    report.legacy.push({ id: c.id, agreesWithExpected: agrees, quoted: res.excerpts.map(e => c.history.find(h => res.convOf(h.id) === e.conversationId)?.id ?? 'filler') });
  }
  delete process.env.AQUA_RECALL_FOLLOWUP_V2;
  const pass = problems.length === 0;
  if (!pass) failed++;
  report.cases.push({ id: c.id, group: c.group, mode: c.mode, pass, problems, outcome });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${c.id.padEnd(4)} ${c.group.padEnd(11)} ${c.mode.padEnd(8)} ${Object.entries(outcome).map(([f, o]) => `${f}: ${o.join(' ')}`).join(' || ')}`);
  if (!pass || VERBOSE) for (const p of problems) console.log(`       ${p}`);
}

const groups = {};
for (const r of report.cases) { groups[r.group] ??= { pass: 0, total: 0 }; groups[r.group].total++; if (r.pass) groups[r.group].pass++; }
report.summary = { pass: report.cases.length - failed, total: report.cases.length, groups, networkAttempts: netAttempts,
  legacyAgreement: `${report.legacy.filter(l => l.agreesWithExpected).length}/${report.legacy.length}` };
console.log(`\n${report.summary.pass}/${report.summary.total} cases pass · ${Object.entries(groups).map(([g, v]) => `${g} ${v.pass}/${v.total}`).join(' · ')} · network attempts ${netAttempts}`);
console.log(`legacy follow-ups (flag off, informational) agree with the expected outcome on ${report.summary.legacyAgreement} admission cases: disagree ${report.legacy.filter(l => !l.agreesWithExpected).map(l => l.id).join(', ') || 'none'}`);
if (jsonOut) { fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true }); fs.writeFileSync(path.resolve(jsonOut), `${JSON.stringify(report, null, 2)}\n`); }
process.exit(failed || netAttempts ? 1 : 0);
