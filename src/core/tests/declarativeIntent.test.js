/**
 * P1 — declarative first-person coverage at the classifier fallback seam.
 *
 * The load-bearing tests here are the NEGATIVE ones. Making ordinary speech
 * classifiable is easy; doing it without stealing turns from the patterns that
 * already work is the actual constraint, and that is what "no regression" means
 * for a change at a fallback seam.
 *
 * Proven to bite: with `resolveDeclarativeIntent` stubbed to return null (i.e.
 * the original classifier), exactly the three behavioural cases fail —
 * statements, recall and corrections. The rest pass in BOTH directions on
 * purpose: they are the constraints (no theft from scored patterns, the
 * fallback still exists, purity, the searchDecision contract), and a
 * constraint that only holds after the change is not a constraint.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { resolveDeclarativeIntent, DECLARATIVE_CONFIDENCE } from '../declarativeIntent.js';
import { classifyTask } from '../classifier.js';
import { LOW_CONFIDENCE_THRESHOLD } from '../../orchestrator/verificationStrategy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── The point of the whole change ────────────────────────────────────────────

test('a resolved declarative turn clears the verification threshold', () => {
  // 0.45 < 0.5 was the entire problem: verification AND the debate panel ran on
  // every ordinary sentence, and the streamed answer was replaced mid-read.
  assert.ok(
    DECLARATIVE_CONFIDENCE > LOW_CONFIDENCE_THRESHOLD,
    `declarative confidence ${DECLARATIVE_CONFIDENCE} must exceed LOW_CONFIDENCE_THRESHOLD ${LOW_CONFIDENCE_THRESHOLD}`,
  );
});

test('first-person statements no longer land on the 0.45 guess', () => {
  const statements = [
    "I'm a product manager at a fintech startup",
    "we're building a payments product for small businesses in India",
    "our biggest competitor is Razorpay",
    "I think we should ship it Friday",
    'my team is 6 engineers and 2 designers',
    'I usually work late, mostly nights',
  ];
  for (const msg of statements) {
    const { task, confidence } = classifyTask(msg);
    assert.equal(task, 'personal_info', `"${msg}" → ${task}`);
    assert.ok(confidence > LOW_CONFIDENCE_THRESHOLD, `"${msg}" confidence ${confidence}`);
  }
});

test('recall questions reach memory_recall instead of small talk or a guess', () => {
  for (const msg of [
    'remind me what I said about the pricing tiers',
    'what did we decide about the auth thing last week',
    'who is on my team again?',
    'what did I tell you about my co-founder',
  ]) {
    assert.equal(classifyTask(msg).task, 'memory_recall', `"${msg}"`);
  }
});

test('corrections are memory_update, not a fresh statement', () => {
  // Mislabelling a correction as new information is how two contradictory facts
  // end up coexisting instead of one superseding the other.
  for (const msg of [
    'I moved to the Bangalore office last month',
    'actually, I work from the office now',
    'I no longer work at that company',
  ]) {
    assert.equal(classifyTask(msg).task, 'memory_update', `"${msg}"`);
  }
});

// ── Negative controls — the constraint, not the feature ─────────────────────

test('questions that merely mention the speaker are NOT self-disclosure', () => {
  // "should I use Postgres or Mongo" is a request for an opinion about the
  // world. Reading it as the user describing themselves would both mislabel the
  // turn and write a fact about a database preference they never stated.
  for (const msg of [
    'should I use Postgres or Mongo for this?',
    'how do I deploy my app to Render',
    'can you explain how my auth flow works',
    'what is the best way for me to structure this',
  ]) {
    assert.notEqual(resolveDeclarativeIntent(msg)?.task, 'personal_info', `"${msg}"`);
  }
});

test('forensic pass (Bug 2): imperative information-requests are NOT self-disclosure', () => {
  // No "?", no WH-word/auxiliary opener — these were falling through to the
  // final catch-all and being classified personal_info, which
  // searchDecision.js hard-blocks. They are requests ("give me X"), not
  // statements about the user's world, so the resolver must step aside
  // (return null) and let the message keep its ordinary fallback.
  for (const msg of [
    'give me the latest on the Israel-Gaza ceasefire',
    'tell me the latest on the Fed rate decision',
    'show me the current price of Bitcoin',
    'update me on the merger talks',
    'let me know the latest iOS version',
  ]) {
    assert.notEqual(resolveDeclarativeIntent(msg)?.task, 'personal_info', `"${msg}"`);
  }
});

test('third-person sentences with no first-person marker are left alone', () => {
  // Stated gap, deliberately not closed: a bare third-person sentence is
  // indistinguishable from a general-knowledge question about a stranger.
  for (const msg of ['Dev handles engineering', 'Razorpay raised a round last year']) {
    assert.equal(resolveDeclarativeIntent(msg), null, `"${msg}"`);
  }
});

test('messages that already score keep their existing classification', () => {
  // The seam only runs on the way to a fallback. This is what makes the change
  // incapable of regressing a turn that works today.
  const pinned = [
    ['hey', 'conversation'],
    ['thanks!', 'conversation'],
    ['write a python script to parse this csv', 'project_query'],
    ['summarize this', 'project_query'],
  ];
  for (const [msg, task] of pinned) {
    assert.equal(classifyTask(msg).task, task, `"${msg}"`);
  }
});

test('the zero-signal fallback still exists for genuinely unclassifiable input', () => {
  // Not every message is about the user. Removing the fallback entirely would
  // be a different and worse bug than the one being fixed.
  const r = classifyTask('make it shorter');
  assert.equal(r.confidence, 0.45);
  assert.equal(r.task, 'simple_qa');
});

test('empty and non-string input is unchanged', () => {
  assert.equal(resolveDeclarativeIntent(''), null);
  assert.equal(resolveDeclarativeIntent(null), null);
  assert.equal(resolveDeclarativeIntent('ok'), null);
  assert.equal(classifyTask('').task, 'conversation');
});

// ── Structural ───────────────────────────────────────────────────────────────

test('declarativeIntent is pure — it imports nothing', () => {
  // Called on every turn that reaches a fallback. A store import here would put
  // persistence inside the classifier, which is deterministic and sub-1ms by
  // contract. Same pin as conversationFacts, same reason.
  const src = readFileSync(path.join(HERE, '..', 'declarativeIntent.js'), 'utf8');
  const imports = [...src.matchAll(/^\s*import\s.+?from\s+['"](.+?)['"]/gm)].map(m => m[1]);
  assert.deepEqual(imports, [], `expected zero imports, found: ${imports.join(', ')}`);
});

test('searchDecision hard-blocks every label this resolver can produce', () => {
  // The block list existed all along and was unreachable, which is why a real
  // web search fired on "I currently work from home". Producing these labels is
  // what activates it — so the two must not drift apart.
  const src = readFileSync(path.join(HERE, '..', '..', 'search', 'searchDecision.js'), 'utf8');
  for (const label of ['personal_info', 'memory_recall', 'memory_update']) {
    assert.ok(src.includes(`'${label}'`), `searchDecision.js no longer blocks ${label}`);
  }
});
