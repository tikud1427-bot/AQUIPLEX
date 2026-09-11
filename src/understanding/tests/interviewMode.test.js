/**
 * UUS U2 — interview mode (node:test).
 *
 * THE DEFECT
 * ----------
 * `classifyTask` scores ordinary first-person speech at 0.45, below
 * LOW_CONFIDENCE_THRESHOLD (0.5). Measured on eight realistic
 * getting-to-know-you answers: four of them fall below the line and fire
 * verification + debate — up to five extra LLM calls, 1.5-16.7s in production,
 * and the drafted answer visibly REPLACED mid-stream. Two more misroute to
 * `planning`/`research`, dragging the reasoning engine into a conversation
 * whose whole job is to listen.
 *
 * All of that against a promise of "about two minutes", in the one conversation
 * that has to earn the user's trust.
 *
 * THE FIX IS NOT A CLASSIFIER FIX
 * -------------------------------
 * `classifyTask` remains wrong about first-person statements everywhere else,
 * and correcting it is a separate change with a far wider blast radius. The
 * difference here is that the caller already KNOWS the intent — the client said
 * "this is the intro" — so inferring it is the mistake.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  UNDERSTANDING_MODE, UNDERSTANDING_TASK, isInterviewTurn, classifyForMode,
} from '../interviewMode.js';
import { directive, openTopics, readyToSummarise } from '../interview.js';
import { COVERAGE_DIMENSIONS } from '../coverage.js';
import { classifyTask } from '../../core/classifier.js';
import { buildSystemPrompt } from '../../core/promptBuilder.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function withUus(on, fn) {
  const prior = process.env.AQUA_UUS;
  if (on) process.env.AQUA_UUS = 'on'; else delete process.env.AQUA_UUS;
  try { return fn(); } finally {
    if (prior === undefined) delete process.env.AQUA_UUS; else process.env.AQUA_UUS = prior;
  }
}

const belief = (confidence = 0.8, status = 'active') => ({ confidence, evidenceCount: 2, status });

// The eight answers from the audit, verbatim.
const GTKY = [
  "I'm a founder and a software engineer.",
  "I'm building an AI product right now.",
  'My biggest project at the moment is the understanding engine.',
  'My top priority this quarter is launching the beta.',
  'Long term I want to build AI that truly understands people.',
  "I'd like help with product strategy, coding and research.",
  "I've been engineering for about eight years, so go deep, don't over-explain.",
  'I prefer short answers with code first.',
];

// ── 1. The measured defect, and that the mode removes it ─────────────────────

test('U2: the defect this mode was built around is now fixed AT THE CLASSIFIER', () => {
  // HISTORY, kept deliberately. This assertion used to read:
  //
  //     assert.equal(low.length, 4, "expected the audit's 4/8")
  //
  // — it pinned the DEFECT as the justification for interview mode: 4 of these
  // 8 answers scored 0.45, below LOW_CONFIDENCE_THRESHOLD, so a getting-to-know
  // -you conversation paid for verification and a debate panel on half its
  // turns. U2's answer was to have the caller declare its intent, because the
  // caller already knew it.
  //
  // P1 fixed the underlying cause: a first-person statement now resolves to
  // personal_info at 0.62 everywhere, not only inside the intro. So the mode's
  // verification-skip rationale is SUBSUMED, and this test flipped from
  // asserting the bug to asserting its absence.
  //
  // Interview mode is NOT redundant — it still owns the interviewer persona,
  // the gap-steering directive, the `understanding_intro` marker and its own
  // ledger bucket, and those are what the tests below cover. But the reason
  // most often quoted for it no longer holds, and a comment saying so is worth
  // more than a number nobody can source.
  const low = GTKY.filter(m => classifyTask(m).confidence < 0.5);
  assert.equal(low.length, 0, `P1 regressed — ${low.length}/8 still below 0.5: ${low.join(' | ')}`);
});

test('U2: in interview mode no answer trips verification', () => {
  withUus(true, () => {
    for (const m of GTKY) {
      const r = classifyForMode(UNDERSTANDING_MODE, m, classifyTask);
      assert.equal(r.task, UNDERSTANDING_TASK);
      assert.ok(r.confidence >= 0.5, `${m} → ${r.confidence}`);
    }
  });
});

test('U2: interview turns never route to research or planning', () => {
  // Two of the eight classify as planning/research, which pulls the reasoning
  // and planning engines into a getting-to-know-you chat.
  withUus(true, () => {
    for (const m of GTKY) {
      const { task } = classifyForMode(UNDERSTANDING_MODE, m, classifyTask);
      assert.ok(!['research', 'planning', 'analysis'].includes(task));
    }
  });
});

// ── 2. The gate ──────────────────────────────────────────────────────────────

test('U2: without the mode, classification is byte-identical', () => {
  withUus(true, () => {
    for (const m of GTKY) {
      assert.deepEqual(classifyForMode(null, m, classifyTask), classifyTask(m));
      assert.deepEqual(classifyForMode(undefined, m, classifyTask), classifyTask(m));
    }
  });
});

test('U2: the flag is required — a mode string alone does nothing', () => {
  withUus(false, () => {
    assert.equal(isInterviewTurn(UNDERSTANDING_MODE), false);
    assert.deepEqual(classifyForMode(UNDERSTANDING_MODE, GTKY[0], classifyTask), classifyTask(GTKY[0]));
  });
});

test('U2: an unrecognised mode is ignored, not guessed at', () => {
  withUus(true, () => {
    assert.equal(isInterviewTurn('onboarding'), false);
    assert.equal(isInterviewTurn(''), false);
    assert.equal(isInterviewTurn(42), false);
  });
});

// ── 3. Steering, not scripting ───────────────────────────────────────────────

test('U2: an empty account is steered to goals first', () => {
  const topics = openTopics({ beliefsByDimension: {}, goals: [] });
  assert.equal(topics[0].id, 'goals', 'what someone is trying to accomplish outranks everything');
});

test('U2: a covered area is never asked about again', () => {
  const topics = openTopics({
    beliefsByDimension: { identity: [belief(0.9)], communication: [belief(0.9)] },
    goals: [{ status: 'active' }],
  });
  const ids = topics.map(t => t.id);
  assert.ok(!ids.includes('identity'));
  assert.ok(!ids.includes('communication'));
  assert.ok(!ids.includes('goals'));
});

test('U2: the directive names gaps but never scripts questions', () => {
  const d = directive({ beliefsByDimension: {}, goals: [] });
  assert.ok(d.length > 0);
  assert.ok(!d.includes('?'), 'a directive containing a question is a script');
  assert.ok(/Follow what they actually say/i.test(d), 'the live thread must outrank the list');
  assert.ok(/Never read this list out/i.test(d));
});

test('U2: at most three gaps are named at once', () => {
  // Naming everything unknown to a brand-new account produces an interrogation.
  const d = directive({ beliefsByDimension: {}, goals: [] });
  assert.ok(d.split('\n').filter(l => l.startsWith('- ')).length <= 3);
});

test('U2: a fully covered account is told to wrap up, not to keep probing', () => {
  const d = directive({
    beliefsByDimension: Object.fromEntries(COVERAGE_DIMENSIONS.map(x => [x, [belief(0.9)]])),
    goals: [{ status: 'active' }],
  });
  assert.ok(/wrap up/i.test(d), 'the conversation must be able to end');
});

test('U2: readyToSummarise is generous, and needs a goal', () => {
  const three = { identity: [belief()], communication: [belief()], knowledge: [belief()] };
  assert.equal(readyToSummarise({ beliefsByDimension: three, goals: [{ status: 'active' }], turns: 4 }), true);
  assert.equal(readyToSummarise({ beliefsByDimension: three, goals: [], turns: 9 }), false,
    'no goal means the summary would miss the point of the brief');
  assert.equal(readyToSummarise({ beliefsByDimension: three, goals: [{ status: 'active' }], turns: 1 }), false);
});

// ── 4. The prompt module ─────────────────────────────────────────────────────

test('U2: the interviewer persona is loaded for the interview task only', () => {
  const interview = buildSystemPrompt(UNDERSTANDING_TASK);
  assert.ok(interview.modules.includes('understanding'), 'interviewer module missing');

  const ordinary = buildSystemPrompt('conversation');
  assert.ok(!ordinary.modules.includes('understanding'));
});

test('U2: the persona forbids the vocabulary the brief forbids', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/prompts/understanding.txt'), 'utf8');
  // "Never call this onboarding" is a product requirement, not a style note.
  for (const word of ['onboarding', 'setup', 'questionnaire']) {
    assert.ok(new RegExp(`Never say[^]*${word}`, 'i').test(src),
      `the persona must forbid "${word}"`);
  }
  assert.ok(/Do not give advice unless asked/i.test(src),
    'the interviewer must not start solving the problem it is meant to understand');
  assert.ok(/Do not flatter/i.test(src));
});

test('U2: the directive rides the existing channel, so it composes', () => {
  // Appended to the reasoning directive rather than occupying a new slot —
  // no signature change, and empty for every non-interview turn.
  const d = directive({ beliefsByDimension: {}, goals: [] });
  const { prompt } = buildSystemPrompt(UNDERSTANDING_TASK, '', d);
  assert.ok(prompt.includes('Still unknown'));
});
