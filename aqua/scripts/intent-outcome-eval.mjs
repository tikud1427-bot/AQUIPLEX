#!/usr/bin/env node
/**
 * Intent, outcome and relationship understanding — isolated, no provider, no DB.
 *
 *   node scripts/intent-outcome-eval.mjs [--profile dev-env|code-defaults] [--json out.json]
 *
 * Runs eval/datasets/intent-outcome.dev.v1.json through the real observation
 * pipeline (memoryObserve → reconcile → evidence lane), one account per case.
 *
 *   achievement  a goal is closed as ACHIEVED in both goal stores (Mind goal
 *                completed; legacy goal item retired / fact ended, kind resolved)
 *                — and goals that must stay open stay open in both
 *   entity       the value lands in the expected fact key, not in a forbidden one
 *   multi        every expected fact is extracted, no value runs two together
 */
import '../eval/core/isolateDataDir.mjs';
import fs from 'node:fs';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const PROFILE = arg('profile', 'dev-env');
const JSON_OUT = arg('json', null);
process.env.DATABASE_URL = ''; process.env.MONGO_URI = '';
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AQUA_') && !['AQUA_DATA_DIR', 'AQUA_DISABLE_MONGO_MIRROR'].includes(k)) delete process.env[k];
  if (/(_API_KEY|^GEMINI_KEY|^SERPER|^TAVILY)/.test(k)) delete process.env[k];
}
if (PROFILE === 'dev-env') Object.assign(process.env, { AQUA_BRAIN_INGEST: 'on', AQUA_BRAIN_INGEST_FACTS: 'on', AQUA_UUS: 'on' });
const say = (...a) => process.stdout.write(`${a.join(' ')}\n`);
for (const k of ['log', 'info', 'warn', 'debug']) console[k] = () => {};

const engine = await import('../src/memory/engine.js');
const { peekMind } = await import('../src/mind/mindStore.js');
const SET = arg('set', 'dev');
const DS = JSON.parse(fs.readFileSync(new URL(`../eval/datasets/intent-outcome.${SET}.v1.json`, import.meta.url), 'utf8'));

let clock = Date.UTC(2026, 8, 1);
Date.now = () => clock;
let n = 0, turn = 0;
function told(owner, text) {
  clock += 3_600_000; turn++;
  engine.memoryObserve(owner, { userMessage: text, conversationId: `${owner}-c`, userId: owner, requestId: `r${turn}`, extractMessage: text });
  engine.memoryAfterTurn(owner, {});
}
const items = v => [].concat(v ?? []).map(x => (x && typeof x === 'object' ? x.name ?? x.value ?? '' : String(x)));
const low = s => String(s).toLowerCase();

// ── achievement ──────────────────────────────────────────────────────────────
function goalState(m, needle) {
  const g = Object.values(m.goals ?? {}).find(x => low(x.title).includes(low(needle)));
  const f = m.facts?.goal;
  const inLegacy = f && items(f.value).some(v => low(v).includes(low(needle)));
  const legacyClosed = f && ((f.ended && f.ended.kind === 'resolved' && items(f.value).some(v => low(v).includes(low(needle))))
    || (f.retiredItems ?? []).some(r => low(r.item).includes(low(needle)) && r.kind === 'resolved'));
  return {
    mind: g?.status ?? 'absent',
    legacy: legacyClosed ? 'completed' : inLegacy && !f.ended ? 'open' : f?.ended ? `ended:${f.ended.kind}` : 'absent',
    achievedBy: g?.achievedBy ?? null,
    history: g?.history?.length ?? 0,
    transition: (f?.transitions ?? []).some(t => t.id && t.kind === 'resolved' && low(t.from).includes(low(needle))),
  };
}
const ach = [];
for (const c of DS.achievement) {
  const o = `user:ach-${++n}`;
  for (const s of c.setup) told(o, s);
  const before = Object.fromEntries([...c.completed, ...c.open].map(x => [x, goalState(peekMind(o), x)]));
  told(o, c.message);
  const m = peekMind(o);
  const after = Object.fromEntries([...c.completed, ...c.open].map(x => [x, goalState(m, x)]));
  const setupOk = Object.values(before).every(s => s.mind === 'active' && s.legacy === 'open');
  const closedOk = c.completed.every(x => after[x].mind === 'completed' && after[x].legacy === 'completed');
  const openOk = c.open.every(x => after[x].mind === 'active' && after[x].legacy === 'open');
  const falseClose = c.open.filter(x => after[x].mind !== 'active' || after[x].legacy !== 'open').length;
  ach.push({ id: c.id, kind: c.kind, positive: c.completed.length > 0, setupOk, pass: setupOk && closedOk && openOk, falseClose, before, after });
}

// ── entity / multi ───────────────────────────────────────────────────────────
function factsCase(c) {
  const o = `user:fact-${++n}`;
  for (const s of c.setup) told(o, s);
  told(o, c.message);
  const facts = Object.values(peekMind(o)?.facts ?? {}).filter(f => f.status !== 'archived' && !f.ended);
  const found = Object.entries(c.expect ?? {}).map(([kp, val]) => {
    const re = new RegExp(kp, 'i');
    const hit = facts.find(f => re.test(f.key) && items(f.value).some(v => low(v).includes(low(val))));
    const exact = hit && items(hit.value).some(v => low(v).replace(/[.\s]+$/, '') === low(val) || low(v).startsWith(low(val)) && low(v).length <= low(val).length + 12);
    return { key: kp, value: val, ok: !!hit, clean: !!exact, got: hit ? `${hit.key}=${JSON.stringify(hit.value)}` : null };
  });
  const forbidden = (c.forbid ?? []).flatMap(kp => facts.filter(f => new RegExp(kp, 'i').test(f.key)
    && Object.values(c.expect ?? {}).some(val => items(f.value).some(v => low(v).includes(low(val))))).map(f => `${f.key}=${JSON.stringify(f.value)}`));
  const unwanted = (c.noFactKeys ?? []).flatMap(kp => facts.filter(f => new RegExp(kp, 'i').test(f.key)).map(f => `${f.key}=${JSON.stringify(f.value)}`));
  forbidden.push(...unwanted);
  const runOn = (c.noRunOn ?? []).flatMap(pair => facts.filter(f => pair.every(p => low(JSON.stringify(f.value)).includes(low(p)))).map(f => `${f.key}=${JSON.stringify(f.value)}`));
  const values = facts.flatMap(f => items(f.value).map(v => low(v).trim())).filter(Boolean);
  const duplicates = values.length - new Set(values).size;
  const pass = found.every(x => x.ok && x.clean) && !forbidden.length && !runOn.length;
  return { id: c.id, kind: c.kind, pass, found, forbidden, runOn, duplicates, facts: facts.map(f => `${f.key}=${JSON.stringify(f.value)}`) };
}
const ent = DS.entity.map(factsCase);
const multi = DS.multi.map(factsCase);

// ── lifecycle check on the correction case ───────────────────────────────────
const e01 = (() => {
  const o = `user:life-${++n}`;
  told(o, "I'm a data analyst at Fintrail.");
  told(o, 'Actually, my company is Northbeam.');
  const m = peekMind(o);
  const b = Object.values(m.beliefs).find(x => x.key === 'organization');
  const t = (m.facts.workplace?.transitions ?? []).find(x => x.id);
  return { workplace: m.facts.workplace?.value ?? null, belief: b?.value ?? null, transition: t ? `${t.from}→${t.to} ${t.kind}` : null,
    history: (m.facts.workplace?.history ?? []).some(h => h.value === 'Fintrail') };
})();

// ── report ───────────────────────────────────────────────────────────────────
const pos = ach.filter(a => a.positive), neg = ach.filter(a => !a.positive);
say(`\n== intent & outcome  profile=${PROFILE}`);
say('\n-- achievement');
for (const a of ach) say(`   ${a.pass ? 'PASS' : 'FAIL'} ${a.id} ${a.kind.padEnd(40)} ${a.setupOk ? '' : '[setup: goal not created in both stores] '}${Object.entries(a.after).map(([k, s]) => `${k}: mind=${s.mind} legacy=${s.legacy}${s.achievedBy ? ' +achievedBy' : ''}`).join('; ')}`);
say(`   recognised ${pos.filter(a => a.pass).length}/${pos.length}; negatives kept open ${neg.filter(a => a.pass).length}/${neg.length}; false goal completions ${ach.reduce((s, a) => s + a.falseClose, 0)} (of ${ach.reduce((s, a) => s + Object.keys(a.after).length - (a.positive ? DS.achievement.find(c => c.id === a.id).completed.length : 0), 0)} goals that must stay open); setup failures ${ach.filter(a => !a.setupOk).length}`);
say('\n-- entity classification');
for (const e of ent) say(`   ${e.pass ? 'PASS' : 'FAIL'} ${e.id} ${e.kind.padEnd(44)} ${e.found.map(x => `${x.key}→${x.got ?? 'MISSING'}${x.ok && !x.clean ? ' (unclean)' : ''}`).join(', ')}${e.forbidden.length ? ` FORBIDDEN ${e.forbidden.join(', ')}` : ''}`);
say(`   correct ${ent.filter(e => e.pass).length}/${ent.length}`);
say('\n-- multiple facts');
for (const m of multi) say(`   ${m.pass ? 'PASS' : 'FAIL'} ${m.id} ${m.kind.padEnd(34)} ${m.found.map(x => `${x.key}→${x.got ?? 'MISSING'}${x.ok && !x.clean ? ' (unclean)' : ''}`).join(', ')}${m.runOn.length ? ` RUN-ON ${m.runOn.join(', ')}` : ''}${m.duplicates ? ` DUP ${m.duplicates}` : ''}`);
const rel = multi.flatMap(m => m.found);
say(`   cases ${multi.filter(m => m.pass).length}/${multi.length}; relationships extracted cleanly ${rel.filter(x => x.ok && x.clean).length}/${rel.length}; run-on facts ${multi.reduce((s, m) => s + m.runOn.length, 0)}; duplicate values ${[...ent, ...multi].reduce((s, m) => s + m.duplicates, 0)}`);
say(`\n-- lifecycle on "Actually, my company is Northbeam.": ${JSON.stringify(e01)}`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ profile: PROFILE, ach, ent, multi, e01 }, null, 2));
process.exit(0);
