/**
 * Rubric v2 tests. Synthetic answers only (not the Mistral run's text), so the rules are
 * tested as rules, not fitted to one run. Run: node --test grader.v2.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DS, gradeAnswerV2, unsupportedV2, parseUnits, statusOf, selftestCases } from './grader.v2.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const Q = id => DS.questions.find(q => q.id === id);
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(HERE, f))).digest('hex');
const CTX_JOB = "[2026-09-08 10:00] I'm a data analyst at Fintrail. I'm leading the Atlas migration at Fintrail; it's due on March 3. I now work at Northbeam as a senior analyst.";

describe('names: ordinary words are not names', () => {
  test('sentence-opening discourse words are not flagged', () => {
    const r = unsupportedV2('However, you moved. Given that, check. Based on this, yes. Additionally, rest. Ensure you sleep.', CTX_JOB, 'q');
    assert.deepEqual(r.names, []);
  });
  test('markdown headings and bold labels are not flagged (reported separately)', () => {
    const r = unsupportedV2('### Overview\n1. **Workload Management**: plan your week.\n- **Networking**: meet people.', CTX_JOB, 'q');
    assert.deepEqual(r.names, []);
    assert.ok(r.headingUnknown.includes('Networking'));
  });
  test('an invented name mid-sentence is flagged', () => {
    assert.deepEqual(unsupportedV2('Your manager is Daniel.', CTX_JOB, 'q').names, ['Daniel']);
  });
  test('an invented multi-word name at sentence start is flagged', () => {
    assert.deepEqual(unsupportedV2('Daniel Ross is your manager.', CTX_JOB, 'q').names.sort(), ['Daniel', 'Ross']);
  });
  test('known names pass, wherever they are', () => {
    assert.deepEqual(unsupportedV2('Northbeam hired you. You left Fintrail.', CTX_JOB, 'q').names, []);
  });
  test('an acronym defined inline is not flagged; an undefined one is', () => {
    assert.deepEqual(unsupportedV2('Track key performance indicators (KPIs) weekly.', CTX_JOB, 'q').names, []);
    assert.deepEqual(unsupportedV2('Track your KPIs weekly.', CTX_JOB, 'q').names, ['KPIs']);
  });
});

describe('names: equivalent date formats', () => {
  test('a month written out from an ISO date in the context is supported', () => {
    assert.deepEqual(unsupportedV2('You said it on September 8, 2026.', CTX_JOB, 'q').names, []);
    assert.deepEqual(unsupportedV2('That was on Sep 8.', CTX_JOB, 'q').names, []);
  });
  test('the weekday of a context date is supported', () => {
    assert.deepEqual(unsupportedV2('You told me on Tuesday.', CTX_JOB, 'q').names, []); // 2026-09-08 is a Tuesday
  });
  test('a month the context never implies is still flagged', () => {
    assert.deepEqual(unsupportedV2('You said it in July.', CTX_JOB, 'q').names, ['July']);
  });
});

describe('structure: numbered lists and multi-section answers', () => {
  test('a labelled list item passes its label to indented children', () => {
    const { units } = parseUnits('1. **Pass the CFA:**\n   - You passed it. This goal is complete.');
    assert.equal(units[0].sub, 'Pass the CFA');
  });
  test('a bare list item naming a goal is neutral, not "open"', () => {
    const a = 'Your goals were:\n1. Pass the CFA Level 1 exam.\n2. Learn Spanish this year.\n\nYou passed the CFA, so only Spanish is still open.';
    assert.equal(gradeAnswerV2(Q('q11'), a).checks.notOpen, true);
  });
  test('a list under an "open" header presents its items as open', () => {
    const a = 'Your open goals:\n- Pass the CFA Level 1 exam.\n- Learn Spanish.';
    assert.equal(gradeAnswerV2(Q('q11'), a).checks.notOpen, false);
  });
  test('the done mark may sit in the next sentence of the same item', () => {
    const a = '**Check:**\n1. **CFA Level 1:**\n   - You mentioned passing your CFA exam. This goal is complete.\n\n**Final:** Spanish is still open.';
    assert.equal(gradeAnswerV2(Q('q11'), a).checks.notOpen, true);
  });
  test('negated completion is not completion', () => {
    assert.equal(gradeAnswerV2(Q('q12'), "You haven't passed the CFA yet.").checks.notOpen, false);
  });
  test('an answer that never says the goal is done fails', () => {
    assert.equal(gradeAnswerV2(Q('q11'), 'Learning Spanish is open.').checks.notOpen, false);
  });
});

describe('claim status: confirmed, historical, inferred, uncertain', () => {
  const s = text => statusOf({ text, context: '' });
  test('statuses', () => {
    assert.equal(s('You work at Northbeam.'), 'asserted');
    assert.equal(s('You previously worked at Fintrail.'), 'historical');
    assert.equal(s('It is likely no longer yours.'), 'inferred');
    assert.equal(s('It may no longer be yours.'), 'uncertain');
    assert.equal(s('Is that still yours?'), 'uncertain');
    assert.equal(s('You passed the CFA.'), 'done');
    assert.equal(s("You're asking if the Atlas migration is still yours."), 'meta');
  });
});

describe('stale current-state advice', () => {
  test('advice built on the retired role fails', () => {
    const r = gradeAnswerV2(Q('q05'), 'You are a data analyst at Fintrail, so focus on reports. You are a senior analyst candidate.', CTX_JOB);
    assert.equal(r.checks.notCurrent, false);
  });
  test('the retired employer mentioned as history passes', () => {
    const r = gradeAnswerV2(Q('q05'), 'As a senior analyst at Northbeam, learn the stack; you previously worked at Fintrail.', CTX_JOB);
    assert.equal(r.checks.notCurrent, true);
  });
  test('a reached goal presented as active fails, also through "this goal"', () => {
    assert.equal(gradeAnswerV2(Q('q05'), 'You are a senior analyst at Northbeam. You set a goal to get promoted. This goal is still active.', CTX_JOB).checks.reachedGoal, false);
    assert.equal(gradeAnswerV2(Q('q05'), 'As a senior analyst at Northbeam, keep working toward your promotion.', CTX_JOB).checks.reachedGoal, false);
  });
  test('a reached goal mentioned as reached passes; not mentioning it passes', () => {
    assert.equal(gradeAnswerV2(Q('q05'), "You've already reached your promotion goal: you're a senior analyst at Northbeam.", CTX_JOB).checks.reachedGoal, true);
    assert.equal(gradeAnswerV2(Q('q05'), 'As a senior analyst at Northbeam, learn the stack.', CTX_JOB).checks.reachedGoal, true);
  });
});

describe('uncertainty may not be turned into fact', () => {
  const q04 = Q('q04');
  test('"likely no longer yours" with no hedge fails both checks', () => {
    const r = gradeAnswerV2(q04, 'You moved jobs, so the Atlas migration is likely no longer your responsibility.', CTX_JOB);
    assert.equal(r.checks.uncertaintyKept, false);
    assert.equal(r.checks.hedge, false);
  });
  test('"no longer relevant" via "this project" fails', () => {
    const r = gradeAnswerV2(q04, 'You led the Atlas migration at Fintrail. Since you moved, this project is no longer relevant.', CTX_JOB);
    assert.equal(r.checks.uncertaintyKept, false);
  });
  test('stating the uncertain deadline as current fails', () => {
    assert.equal(gradeAnswerV2(q04, 'The Atlas migration is due on March 3; make it a priority. Is that right?', CTX_JOB).checks.uncertaintyKept, false);
  });
  test('the deadline as history plus an open question passes', () => {
    const r = gradeAnswerV2(q04, 'The Atlas migration was due on March 3 at Fintrail. It is uncertain whether it is still on your plate; you should check with your team.', CTX_JOB);
    assert.equal(r.checks.uncertaintyKept, true);
    assert.equal(r.checks.hedge, true);
  });
  test('a hedged inference passes', () => {
    assert.equal(gradeAnswerV2(q04, 'The Atlas migration may no longer be yours. Can you confirm?', CTX_JOB).pass, true);
  });
  test('method talk and a "Check" heading are not a hedge', () => {
    const a = '1. **Understand**: To determine this, we need to check your role.\n2. **Check**: The Atlas migration was at Fintrail.\n3. **Final**: The Atlas migration is not on your plate anymore.';
    const r = gradeAnswerV2(q04, a, CTX_JOB);
    assert.equal(r.checks.hedge, false);
    assert.equal(r.checks.uncertaintyKept, false);
    assert.equal(r.scaffold, true);
  });
});

describe('v1 behaviour kept where it was right', () => {
  test('every dataset example and every v2 example is graded as intended', () => {
    const wrong = selftestCases().filter(c => gradeAnswerV2(c.q, c.text).pass !== c.want).map(c => `${c.q.id}:${c.kind}`);
    assert.deepEqual(wrong, []);
  });
});

describe('the original rubric, dataset and results are preserved', () => {
  test('v1 grader and dataset are byte-identical to the frozen manifest', () => {
    assert.equal(sha('../../../scripts/answer-eval-harness.mjs'), '3055927477ed8ca0176721d61ef361750ee2c3c9f56842aa8f056059258a3ba4');
    assert.equal(sha('../../datasets/answer-lifecycle.dev.v1.json'), '155c0390023f518099a8561260e2add3c33287146a54a384245f042e72c3a595');
  });
  test('the Cloudflare Mistral run and its v1 grading are unchanged', () => {
    const run = '../2026-11-05/answers/primary-cf-mistral-2026-11-05';
    assert.equal(sha(`${run}/answers.raw.jsonl`), '0cab6ca86755dd796ecf14b58762378bc266d9e9b581ac62dd37d6f2099faa6d');
    assert.equal(sha(`${run}/answers.jsonl`), 'e2f3c90c2d9a4c1e28c17317174793509b41ac8eb841e4d44ffe51b4279b73c2');
    assert.equal(sha(`${run}/graded.json`), '3bd489314e390d4dd8ba0711d950e6ad204aa72b6a770eba3771035f2243ac32');
  });
});
