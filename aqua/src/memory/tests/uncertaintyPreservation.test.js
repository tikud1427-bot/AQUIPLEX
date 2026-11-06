/**
 * Uncertainty preserved from extraction to the prompt (2026-11-05).
 *
 * The Cloudflare Mistral run turned "uncertain whether still current" into "this
 * project is no longer relevant" (q05). The marker reached the prompt only in the
 * cognitive block, under "use silently"; the recall block quoted the same
 * sentence bare beside "a newer statement replaces an older one"; and the
 * extractor stored "I'm not sure if I'm still leading X" as "still leading X".
 *
 *   extraction  a "not sure if/whether" clause states nothing; a hedged
 *               statement ("I think…") is stored as hedged and never replaces
 *               a confirmed value
 *   storage     the hedge persists (metadata.hedged); a plain restatement clears it
 *   retrieval   recall quotes carry the same uncertainty notes as the other blocks
 *   prompt      one rule in every block: uncertain is neither ended nor current
 *
 * Real observation pipeline, private data directory, no provider, no database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-uncertainty-'));
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AQUA_') && k !== 'AQUA_DATA_DIR') delete process.env[k];
  if (/(_API_KEY|^GEMINI_KEY|^SERPER|^TAVILY)/.test(k)) delete process.env[k];
}
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
delete process.env.DATABASE_URL;
// Change propagation is OFF by default (2026-11-06: only AQUA_PROPAGATION=on enables it).
// These tests exercise behaviour that needs it, so they enable it explicitly.
process.env.AQUA_PROPAGATION = 'on';

const engine = await import('../engine.js');
const { peekMind } = await import('../../mind/mindStore.js');
const { sensitivePolicy } = await import('../sensitivity.js');
const { annotate, formatRecall } = await import('../episodicRecall.js');
const { UNCERTAIN_RULE } = await import('../displayLabels.js');
const { getIdentity, formatIdentityBlock } = await import('../identity.js');

let clock = Date.UTC(2026, 8, 1);
const realNow = Date.now;
Date.now = () => clock;
process.on('exit', () => { Date.now = realNow; });

let turn = 0;
async function say(owner, text) {
  clock += 60_000; turn++;
  engine.memoryObserve(owner, { userMessage: text, conversationId: `${owner}-c`, userId: owner, requestId: `r${turn}`, extractMessage: text });
  engine.memoryAfterTurn(owner, {});
  await new Promise(r => setTimeout(r, 20));
}
let n = 0;
const fresh = () => `user:uncertainty-${++n}`;
const facts = owner => peekMind(owner)?.facts ?? {};
const block = (owner, query = 'Where do I work?') => engine.memoryRetrieve(owner, {
  query, requestId: `q${++turn}`, legacyUserMemory: true, sensitive: sensitivePolicy({ rememberSensitive: false, message: 'x' }),
}).block;
const excerpt = (text, i) => ({ text, ts: Date.UTC(2026, 8, 1) + i, conversationId: 'c-old', source: 'said', why: 'all' });

const JOB = ["I'm a data analyst at Fintrail.", 'My goal is to get promoted to senior analyst.', 'My goal is to run a half marathon in October.', "I'm leading the Atlas migration at Fintrail; it's due on March 3."];
const MOVE = 'I now work at Northbeam as a senior analyst.';

// ── Extraction and storage ─────────────────────────────────────────────────
test('a "not sure if" clause stores nothing (it used to store the opposite)', async () => {
  const o = fresh();
  await say(o, "I'm not sure if I'm still leading the Atlas migration.");
  assert.deepEqual(Object.keys(facts(o)).filter(k => /atlas|leading/i.test(k)), []);
});

test('a hedged statement is stored as hedged', async () => {
  const o = fresh();
  await say(o, 'I think I work at Halcyon Labs.');
  assert.equal(facts(o).workplace?.value, 'Halcyon Labs');
  assert.equal(facts(o).workplace.metadata?.hedged, true);
});

test('a plain statement is not hedged', async () => {
  const o = fresh();
  await say(o, 'I work at Fintrail.');
  assert.ok(!facts(o).workplace.metadata?.hedged);
});

test('a hedged statement never replaces a confirmed value', async () => {
  const o = fresh();
  await say(o, 'I work at Fintrail.');
  await say(o, 'I think I work at Halcyon Labs.');
  assert.equal(facts(o).workplace.value, 'Fintrail');
  assert.ok(!facts(o).workplace.metadata?.hedged, 'the confirmed value stays confirmed');
  assert.equal((facts(o).workplace.transitions ?? []).length, 0, 'no change recorded, nothing propagated');
});

test('a plain restatement confirms a hedged value', async () => {
  const o = fresh();
  await say(o, 'I think I work at Halcyon Labs.');
  await say(o, 'I work at Halcyon Labs.');
  assert.equal(facts(o).workplace.value, 'Halcyon Labs');
  assert.ok(!facts(o).workplace.metadata?.hedged);
});

// ── Prompt: the hedge is visible where the value is ────────────────────────
test('profile and identity show a hedged value as uncertain, in the user\'s words', async () => {
  const o = fresh();
  await say(o, 'I think I work at Halcyon Labs.');
  assert.match(block(o), /Halcyon Labs \(uncertain — they said: "I think I work at Halcyon Labs\."\)/);
  assert.match(formatIdentityBlock(getIdentity(o)), /Halcyon Labs \(uncertain — they said: "I think I work at Halcyon Labs\."\)/);
});

test('one uncertainty rule in the profile, the cognitive model and the recall block', async () => {
  const o = fresh();
  for (const t of JOB) await say(o, t);
  clock += 7 * 86_400_000;
  await say(o, MOVE);
  const b = block(o, 'What should I focus on at work this month?');
  assert.match(UNCERTAIN_RULE, /neither ended nor (?:been )?confirmed/);
  assert.ok(b.split(UNCERTAIN_RULE).length - 1 >= 2, 'profile guideline and cognitive model both carry it');
  assert.ok(formatRecall([excerpt('I like tea.', 0)]).includes(UNCERTAIN_RULE), 'recall carries it');
  assert.doesNotMatch(formatRecall([excerpt('I like tea.', 0)]), /a newer statement about the same thing replaces an older one, and a "since changed" note is the current state\.\s*Corrections/, 'the replace rule is qualified');
});

// ── Retrieval: recall quotes carry the uncertainty ─────────────────────────
test('a quoted sentence whose record is uncertain carries the note; since-changed is unchanged', async () => {
  const o = fresh();
  for (const t of JOB) await say(o, t);
  clock += 7 * 86_400_000;
  await say(o, MOVE);
  const ex = [...JOB, MOVE].map(excerpt);
  const out = formatRecall(annotate(ex, engine.legacySupersessionNotes(o)));
  assert.match(out, /Atlas migration at Fintrail; it's due on March 3\.\n {3}↳ uncertain whether still current — they later said: "I now work at Northbeam as a senior analyst\."/);
  assert.match(out, /get promoted to senior analyst\.\n {3}↳ may already be achieved — they later said: "I now work at Northbeam as a senior analyst\."; not confirmed/);
  assert.match(out, /I'm a data analyst at Fintrail\.\n {3}↳ since changed — now: "I now work at Northbeam as a senior analyst\."/);
  assert.doesNotMatch(out, /half marathon in October\.\n {3}↳/, 'an unrelated quote has no note');
});

test('a change to one fact does not end the things that mention it', async () => {
  const o = fresh();
  for (const t of JOB) await say(o, t);
  clock += 7 * 86_400_000;
  await say(o, MOVE);
  const m = peekMind(o);
  const atlas = m.working.deadlines.find(d => /Atlas/.test(d.label));
  assert.ok(atlas, 'the deadline is kept');
  assert.ok(atlas.review, 'and flagged, not removed');
  assert.equal(Object.values(m.goals).find(g => /half marathon/.test(g.title)).review, undefined);
});
