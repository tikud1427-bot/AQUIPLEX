/**
 * Question-aware cognitive context (mind/mindRetriever.js, 2026-11-05).
 *
 * Goals, the latest deadline, the latest open question and the top prediction
 * rode into every prompt whatever was asked: "Where do I work now?" carried the
 * Atlas deadline and the promotion goal; "What should I focus on…" carried
 * itself as an "open question"; the prediction repeated the goal above it.
 *
 *   targeted question   goals / deadlines / blockers / prediction only when the
 *                       question shares a content word with them
 *   planning, overview,  everything, as before
 *   goal or no query
 *   open question       never the message being answered
 *   prediction          never a repeat of a listed goal or deadline
 *
 * The profile, identity and recall are untouched (history and continuity kept).
 * AQUA_MIND_RELEVANCE=off restores the previous selection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-cog-relevance-'));
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
// Question-aware selection is OFF by default (2026-11-06); this file tests it ON.
process.env.AQUA_MIND_RELEVANCE = 'on';

const engine = await import('../../memory/engine.js');
const { sensitivePolicy } = await import('../../memory/sensitivity.js');
const { questionScope } = await import('../mindRetriever.js');

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
const full = (owner, query) => engine.memoryRetrieve(owner, { query, requestId: `q${++turn}`, legacyUserMemory: true,
  sensitive: sensitivePolicy({ rememberSensitive: false, message: 'x' }) }).block;
const cognitive = (owner, query) => (full(owner, query).match(/--- COGNITIVE MODEL[\s\S]*?--- END COGNITIVE MODEL ---/) ?? [''])[0];

let n = 0;
async function jobLife() {
  const o = `user:cog-relevance-${++n}`;
  for (const t of ["I'm a data analyst at Fintrail.", 'My goal is to get promoted to senior analyst.', 'My goal is to run a half marathon in October.',
    "I'm leading the Atlas migration at Fintrail; it's due on March 3."]) await say(o, t);
  clock += 7 * 86_400_000;
  await say(o, 'I now work at Northbeam as a senior analyst.');
  return o;
}

test('questionScope: planning, overview and goal questions are broad; others are targeted', () => {
  for (const q of ['What should I focus on at work this month?', 'What do you know about me?', 'Which of my goals are still open?',
    'Is the Atlas migration still on my plate?', 'What are my priorities this week?', 'Help me plan my week', '']) {
    assert.equal(questionScope(q).broad, true, q);
  }
  for (const q of ['Where do I work now?', "What's my manager's name?", 'Who is my accountant?', 'When is the Atlas migration due?']) {
    assert.equal(questionScope(q).broad, false, q);
  }
});

test('an unrelated question carries no goals, deadline or prediction — the profile keeps its history', async () => {
  const o = await jobLife();
  const c = cognitive(o, 'Where do I work now?');
  assert.doesNotMatch(c, /Active goals|deadline:|Anticipated need/);
  assert.match(full(o, 'Where do I work now?'), /workplace: Northbeam \(previously: Fintrail\)/, 'history is in the profile, unchanged');
});

test('a question naming the item keeps it, with its uncertainty', async () => {
  const o = await jobLife();
  const c = cognitive(o, 'When is the Atlas migration due?');
  assert.match(c, /deadline: I'm leading the Atlas migration[^\n]*\(uncertain whether still current/);
  assert.doesNotMatch(c, /Active goals/, 'goals it does not name stay out');
});

test('a question naming one goal keeps that goal only', async () => {
  const o = await jobLife();
  const c = cognitive(o, 'Any tips for my half marathon?');
  assert.match(c, /Active goals: "run a half marathon in October"/);
  assert.doesNotMatch(c, /promoted/);
});

test('planning and overview requests keep the broader context', async () => {
  const o = await jobLife();
  for (const q of ['What should I focus on at work this month?', 'What do you know about me?']) {
    const c = cognitive(o, q);
    assert.match(c, /Active goals: [^\n]*promoted to senior analyst/, q);
    assert.match(c, /Active goals: [^\n]*half marathon/, q);
    assert.match(c, /deadline: I'm leading the Atlas migration/, q);
  }
});

test('the message being answered is not its own open question; an earlier one stays', async () => {
  const o = await jobLife();
  await say(o, "I'm wondering whether to learn Rust.");
  const q = 'What should I focus on at work this month?';
  await say(o, q);                       // working memory records it before the prompt is built
  const c = cognitive(o, q);
  assert.doesNotMatch(c, /open question: [^\n|]*focus on at work/);
  assert.match(c, /open question: [^\n|]*learn Rust/);
});

test('the prediction never repeats a goal already listed', async () => {
  const o = `user:cog-relevance-${++n}`;
  await say(o, 'My goal is to learn Spanish this year.');
  const c = cognitive(o, 'What should I focus on this week?');
  assert.match(c, /Active goals: "learn Spanish this year"/);
  assert.doesNotMatch(c, /Anticipated need: Likely working toward: learn Spanish/);
});

test('AQUA_MIND_RELEVANCE=off restores the previous selection', async () => {
  const o = await jobLife();
  process.env.AQUA_MIND_RELEVANCE = 'off';
  try {
    assert.match(cognitive(o, 'Where do I work now?'), /Active goals:[^\n]*deadline:|Active goals:[\s\S]*deadline:/);
  } finally { process.env.AQUA_MIND_RELEVANCE = 'on'; }   // back to this file's setting
});
