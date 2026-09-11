/**
 * The revision voice — AQUA raising a change to its own understanding, unasked.
 *
 * This is the capability the audit named as the differentiator: unlimited
 * context gives an assistant recall, not a position that can be revised, and
 * certainly not the habit of volunteering the revision. The data landed last
 * phase; this is the seam that lets the prompt see it.
 *
 * THE LOAD-BEARING TESTS ARE THE ONES ABOUT SILENCE. Making an assistant raise
 * something is easy. Making it raise something ONCE, only when welcome, without
 * narrating its own bookkeeping, and without asserting a change to someone's
 * life that it merely inferred about its own model — that is the whole problem.
 *
 * Proven to bite: neutering the builder and the suitability gate fails 5 of 14
 * — the three "what gets raised" cases and the two gating ones. The silence and
 * watermark cases pass in both directions by design: they are the contract this
 * capability has to keep, not evidence that it exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  buildRevisionDirective, isWorthRaising, isSuitableTurn, SUITABLE_TASKS,
} from '../reflectionV2/revisionVoice.js';
import {
  loadSurfacedAt, markSurfaced, _resetReflectionStoreForTests,
} from '../reflectionV2/reflectionStore.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const named = (...subjects) => ({ entities: subjects.length, subjects });
const superseded = (from, to) => ({ revised: 1, revisions: [{ subject: 'priority', from, to }] });

// ── What gets raised ─────────────────────────────────────────────────────────

test('a superseded assumption is raised with its before AND after', () => {
  // The strongest material there is: AQUA believed something and no longer
  // does. Without `from`, the question has nothing to be measured against.
  const d = buildRevisionDirective(superseded('churn was the priority', 'pricing is the priority'));
  assert.match(d, /You had it that churn was the priority/);
  assert.match(d, /It now looks more like pricing is the priority/);
});

test('changed entities are raised BY NAME, never as counts', () => {
  // An earlier version passed `delta.summary` straight through, so the model
  // was handed "your understanding changed: 5 entities changed; 1
  // relationship(s) changed" and then told not to sound like a changelog. It
  // was being asked to be human about arithmetic.
  const d = buildRevisionDirective(named('Nummo', 'Dev', 'Razorpay'));
  assert.match(d, /Nummo, Dev and Razorpay/);
  assert.ok(!/\d+ entit/.test(d), `counts leaked into the directive: ${d}`);
});

test('names read like a sentence, not an array', () => {
  // `entities` is the count of everything that changed; `subjects` is what
  // could be NAMED. They differ when the self entity is filtered out, so a
  // one-name directive is reachable — but it still has to clear the
  // worth-raising bar, which is why these carry entities: 2.
  const one = { entities: 2, subjects: ['Nummo'] };
  const two = { entities: 2, subjects: ['Nummo', 'Dev'] };
  assert.match(buildRevisionDirective(one), /about Nummo has shifted/);
  assert.match(buildRevisionDirective(two), /about Nummo and Dev/);
});

// ── What does NOT get raised ─────────────────────────────────────────────────

test('counts with no names raise nothing', () => {
  // A question with no subject in it is worse than silence — the user would be
  // asked to confirm something AQUA cannot name.
  assert.equal(buildRevisionDirective({ entities: 4, relationships: 2, subjects: [] }), '');
});

test('one entity appearing is how the world model breathes, not news', () => {
  assert.equal(isWorthRaising({ entities: 1, subjects: ['Nummo'] }), false);
  assert.equal(buildRevisionDirective(named('Nummo')), '');
  // …but an obsoleted fact IS news at any size: AQUA held something that no
  // longer holds, and admitting that is the entire point.
  assert.equal(isWorthRaising({ entities: 0, obsoleted: 1 }), true);
  assert.equal(isWorthRaising({ entities: 0, revised: 1 }), true);
});

test('nothing at all raises nothing', () => {
  assert.equal(buildRevisionDirective(null), '');
  assert.equal(buildRevisionDirective({}), '');
  assert.equal(isWorthRaising(null), false);
});

// ── When it is welcome ───────────────────────────────────────────────────────

test('a working turn is never interrupted', () => {
  // Asking someone about their goals mid-debugging is the behaviour that gets a
  // feature switched off, however well the sentence is written.
  for (const taskType of ['coding', 'debugging', 'architecture', 'research', 'creative_writing']) {
    assert.equal(isSuitableTurn({ taskType }), false, taskType);
  }
});

test('conversational turns are welcome', () => {
  for (const taskType of ['conversation', 'personal_info', 'memory_recall']) {
    assert.equal(isSuitableTurn({ taskType }), true, taskType);
  }
});

test('the intro is EXCLUDED even though it is the most conversational turn there is', () => {
  // During the intro AQUA is learning, not reporting back — and the interview
  // has its own directive on this exact channel, so both would arrive at once
  // and compete for the same instruction slot.
  assert.equal(isSuitableTurn({ taskType: 'conversation', mode: 'understanding_intro' }), false);
  assert.ok(!SUITABLE_TASKS.has('understanding_interview'));
});

// ── Once, and only once ──────────────────────────────────────────────────────

test('the surfaced watermark is separate from the reflection watermark', () => {
  // Conflating "I noticed" with "I mentioned it" is how this ends up either
  // silent or repeating itself.
  _resetReflectionStoreForTests();
  assert.equal(loadSurfacedAt('user:a'), 0);
  markSurfaced('user:a', 7000);
  assert.equal(loadSurfacedAt('user:a'), 7000);
});

test('marking works for an owner with no snapshot yet', () => {
  // `markSurfaced` can run before reflection has ever produced a snapshot.
  // Dropping that record on reload would re-raise a revision already raised.
  _resetReflectionStoreForTests();
  markSurfaced('user:fresh', 123);
  assert.equal(loadSurfacedAt('user:fresh'), 123);
});

test('a missing owner id is a no-op, never a throw', () => {
  _resetReflectionStoreForTests();
  markSurfaced(null, 1);
  assert.equal(loadSurfacedAt(null), 0);
});

// ── Structural ───────────────────────────────────────────────────────────────

test('revisionVoice is pure — it imports nothing', () => {
  // Consulted on the turn path. A store import here would put persistence
  // inside prompt construction. Same pin as declarativeIntent and
  // conversationFacts, same reason.
  const src = readFileSync(path.join(HERE, '..', 'reflectionV2', 'revisionVoice.js'), 'utf8');
  const imports = [...src.matchAll(/^\s*import\s.+?from\s+['"](.+?)['"]/gm)].map(m => m[1]);
  assert.deepEqual(imports, [], `expected zero imports, found: ${imports.join(', ')}`);
});

test('the voice has its OWN flag, not folded into REFLECT_V2', () => {
  // REFLECT_V2 controls whether AQUA ACTS on a delta — invisible. This controls
  // whether AQUA SPEAKS about one — which every user sees. Sharing a switch
  // would mean nobody could have the first without the second, and someone
  // would get the second by accident.
  const idx = readFileSync(path.join(HERE, '..', 'index.js'), 'utf8');
  assert.match(idx, /AQUA_REVISION_VOICE/);
  assert.match(idx, /export function revisionVoiceEnabled/);
  // And it must be reported, or it is a dark stage by another name.
  const routes = readFileSync(path.join(HERE, '..', '..', 'routes', 'brain.js'), 'utf8');
  assert.match(routes, /AQUA_REVISION_VOICE: Brain\.revisionVoiceEnabled\(\)/);
  const router = readFileSync(path.join(HERE, '..', '..', '..', 'router.js'), 'utf8');
  assert.match(router, /revisionVoice=/);
});

// ── The SELECTOR ─────────────────────────────────────────────────────────────
//
// Added after shipping. The suite above tested `buildRevisionDirective` in
// isolation with one revision at a time and never touched the code that CHOOSES
// which revision to build from — which is where the bug was. flagproof caught
// it on Ananya's machine; re-run eight times here it had been failing 2 in 5 all
// along, and I had run it once, seen green, and shipped.
//
// The lesson is not "add a test". It is that a pure builder with perfect
// coverage proves nothing about the impure caller that feeds it, and the caller
// is where selection lives.

process.env.AQUA_BRAIN = 'on';
process.env.AQUA_REVISION_VOICE = 'on';
const Brain = await import('../index.js');
const { ledger, _resetPicStoreForTests } = await import('../../pic/picStore.js');

const seedRevisions = (owner, entries) => {
  _resetPicStoreForTests();
  _resetReflectionStoreForTests();
  for (const e of entries) ledger(owner, 'reflection', e);
};
const firstLine = (s) => String(s).split('\n')[1] ?? '';

test('a trivial NEWER revision does not mask an interesting older one', () => {
  // THE BUG. Reflection runs on a cadence and most deltas are small, so an
  // uninteresting one-entity revision arriving after a real one would bury it
  // permanently — the feature would be silent in practice while every unit test
  // stayed green.
  // Timestamps are EXPLICIT. An earlier draft let `ledger()` stamp both with
  // Date.now(); they landed in the same millisecond, the buggy sort tied, and
  // the test passed against the very defect it was written for. A test for a
  // race that only sometimes fires is the thing this whole phase is about.
  const t = Date.now();
  seedRevisions('user:mask', [
    { at: t,      entities: 3, subjects: ['Nummo', 'Dev', 'Razorpay'], summary: '3 entities changed' },
    { at: t + 5,  entities: 1, subjects: ['Another Thing'],            summary: '1 entity changed' },
  ]);
  const d = Brain.revisionDirectiveFor('user:mask', { taskType: 'conversation' });
  assert.match(firstLine(d), /Nummo, Dev and Razorpay/, `masked: ${JSON.stringify(d)}`);
});

test('among several worth raising, the NEWEST wins', () => {
  // Recency preference is kept — the most recent is the current picture, and
  // raising a stale one then the current one would be two questions about the
  // same shift. "Prefer the newest" just never meant "give up if it is boring".
  seedRevisions('user:recent', [
    { entities: 2, subjects: ['Old One', 'Older'], summary: 'old' },
    { entities: 2, subjects: ['New One', 'Newer'], summary: 'new' },
  ]);
  assert.match(firstLine(Brain.revisionDirectiveFor('user:recent', { taskType: 'conversation' })), /New One and Newer/);
});

test('same-millisecond entries resolve by INSERTION order, not by sort', () => {
  // Two reflections can land in one millisecond — this codebase already carries
  // a millisecond-resolution note on obsolescence. A stable sort on tied keys
  // inverts the real order, which is why the selector walks the ring backwards
  // instead of sorting.
  const at = Date.now();
  seedRevisions('user:tie', [
    { at, entities: 2, subjects: ['First', 'Firstly'], summary: 'first' },
    { at, entities: 2, subjects: ['Second', 'Secondly'], summary: 'second' },
  ]);
  assert.match(firstLine(Brain.revisionDirectiveFor('user:tie', { taskType: 'conversation' })), /Second and Secondly/);
});

test('a revision judged not worth raising is DECIDED, not deferred forever', () => {
  // Otherwise every subsequent turn rescans it, and a future interesting
  // revision sits behind it in exactly the way this fix exists to prevent.
  seedRevisions('user:decided', [{ entities: 1, subjects: ['Trivial'], summary: '1 entity changed' }]);
  assert.equal(Brain.revisionDirectiveFor('user:decided', { taskType: 'conversation' }), '');
  assert.ok(loadSurfacedAt('user:decided') > 0, 'the watermark did not advance past a rejected revision');

  // …and a genuinely interesting one arriving afterwards is still raised.
  ledger('user:decided', 'reflection', { at: Date.now() + 10, entities: 3, subjects: ['Nummo', 'Dev', 'Priya'], summary: '3 changed' });
  assert.match(firstLine(Brain.revisionDirectiveFor('user:decided', { taskType: 'conversation' })), /Nummo, Dev and Priya/);
});

test('nothing pending leaves the watermark alone', () => {
  seedRevisions('user:empty', []);
  assert.equal(Brain.revisionDirectiveFor('user:empty', { taskType: 'conversation' }), '');
  assert.equal(loadSurfacedAt('user:empty'), 0, 'an empty scan should not churn the watermark');
});
