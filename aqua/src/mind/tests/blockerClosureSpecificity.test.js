/**
 * A shared name or word does not resolve a DIFFERENT blocker (C9, 2026-11-07).
 *
 * "I fixed a race condition in the Kestrel payment service." closed the Mind's
 * blocker "the Kestrel deploy pipeline" (mind/workingMemory.js applyLaterWords),
 * and Brain continuity (understanding/stateTransition.js continues) linked the two
 * as resolution and blocker — on one shared word, the project name. Both now ask
 * understanding/stateTransition.js differentThing: a shared word that goes on to
 * different things in the two statements ("Kestrel payment…" / "Kestrel deploy…",
 * "sales pipeline" / "deploy pipeline") is not a shared subject.
 *
 * The genuine closures that relied on one shared word keep working: "Apple
 * approved the app" closes "Apple's review", "FCC signed off" closes "waiting on
 * FCC certification". Synthetic sentences; isolated store.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-blocker-closure-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
delete process.env.AQUA_MIND_RELEVANCE;

const { createEmptyMind } = await import('../mindSchema.js');
const { updateWorkingMemory } = await import('../workingMemory.js');
const { observeTurn } = await import('../observers.js');
const { continues, differentThing } = await import('../../understanding/stateTransition.js');

function say(m, userMessage) {
  const { hints } = observeTurn({ userMessage, taskType: 'conversation', extractedFacts: [] });
  updateWorkingMemory(m, { userMessage, taskType: 'conversation', hints });
}
const blockers = m => m.working.blockers.map(b => b.text);

describe('the Mind does not close a different blocker', () => {
  const FALSE = [
    ["I'm blocked on the Kestrel deploy pipeline.", 'I fixed a race condition in the Kestrel payment service.', 'the Kestrel deploy pipeline'],
    ["I'm blocked on the Kestrel deploy pipeline.", 'We fixed the Kestrel deploy script.', 'the Kestrel deploy pipeline'],
    ["I'm blocked on the deploy pipeline.", 'The sales pipeline closed a big deal.', 'the deploy pipeline'],
    ["I'm blocked on the deploy pipeline.", 'Our hiring pipeline is finally done.', 'the deploy pipeline'],
    ["I'm waiting on the Orchid security review.", 'The Orchid design review was approved.', 'the Orchid security review'],
  ];
  for (const [blocked, later, text] of FALSE) {
    test(`"${later}" leaves "${text}" open`, () => {
      const m = createEmptyMind('user:closure');
      say(m, blocked);
      assert.deepEqual(blockers(m), [text], 'control: the blocker is recorded');
      say(m, later);
      assert.deepEqual(blockers(m), [text]);
      assert.equal((m.working.resolvedBlockers ?? []).length, 0);
    });
  }

  const TRUE = [
    ["I'm blocked on the Kestrel deploy pipeline.", 'The Kestrel deploy pipeline is fixed.'],
    ["I'm blocked on the Kestrel deploy pipeline.", 'The Kestrel team fixed the pipeline.'],
    ["I'm blocked on the deploy pipeline.", 'The deploy pipeline is green again, finally fixed.'],
    ["The launch is blocked waiting on Apple's review.", 'Apple approved the app this morning.'],
    ['We are stuck on the zoning permit.', 'The zoning permit came through.'],
  ];
  for (const [blocked, later] of TRUE) {
    test(`a genuine resolution still closes: "${later}"`, () => {
      const m = createEmptyMind('user:closure');
      say(m, blocked);
      assert.equal(blockers(m).length, 1, 'control');
      say(m, later);
      assert.deepEqual(blockers(m), []);
      assert.equal(m.working.resolvedBlockers.length, 1);
    });
  }
});

describe('Brain continuity does not link a different thing either', () => {
  test('the Kestrel payment fix does not continue the Kestrel deploy blocker', () => {
    assert.equal(continues('I fixed a race condition in the Kestrel payment service.', "I'm blocked on the Kestrel deploy pipeline."), null);
    assert.equal(continues('The sales pipeline closed a big deal.', "I'm blocked on the deploy pipeline."), null);
  });
  test('the continuations that relied on one shared word still link', () => {
    assert.ok(continues('Good news, FCC signed off on the lamp last night.', 'Our Kickstarter campaign is stuck waiting on FCC certification.'));
    assert.ok(continues('The zoning permit came through.', 'Now the San Antonio opening is blocked by a zoning permit.'));
    assert.deepEqual(continues('I resigned from Hartwell last Friday.', "I'm employed at Hartwell Bank."), ['hartwell']);
    assert.ok(continues('The Kestrel deploy pipeline is fixed.', "I'm blocked on the Kestrel deploy pipeline."));
  });
  test('differentThing: time words, numbers and closing phrases after the shared word are not a different thing', () => {
    assert.equal(differentThing('Growth is no longer the priority — retention is.', 'Growth is my top priority this quarter.'), false);
    assert.equal(differentThing('The city zoning permit was approved.', 'Now the San Antonio opening is blocked by a zoning permit.'), false);
    assert.equal(differentThing('The city approved my license renewal.', 'I am waiting on a business license renewal from the city.'), false);
    assert.equal(differentThing('anything', 'unrelated', []), false, 'nothing shared: not this function\'s question');
  });
});
