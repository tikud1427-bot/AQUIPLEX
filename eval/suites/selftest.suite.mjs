/**
 * AQUA Eval — self-test suite
 * Blueprint E2/PR-1
 *
 * PR-1 ships the harness and no dataset. A harness with nothing to grade is
 * unprovable, and "it will work when the data arrives" is exactly the claim
 * this project has learned not to accept.
 *
 * So the harness grades ITSELF: fixed cases with known outcomes covering every
 * path the runner has — correct, incorrect, skipped, thrown, slow — so the
 * runner's behaviour is demonstrated end to end before a single real sentence
 * is labelled.
 *
 * This suite is NOT a quality measurement of anything in AQUA. It measures the
 * measuring device. Saying so here rather than letting a green 60% look like a
 * result.
 */
export default {
  id: 'selftest',
  title: 'harness self-test',
  about: [
    'Grades the eval harness, not AQUA. Fixed cases with known outcomes exercise',
    'every runner path: a correct answer, a wrong answer, a case that cannot run,',
    'and a case whose code throws. Expected score is 2/3 executed correct, with',
    'one skip and one error that must NOT be counted as wrong answers.',
  ].join('\n'),

  cases: [
    { id: 'a-correct',   input: 2, expected: 4 },
    { id: 'b-correct',   input: 5, expected: 10 },
    { id: 'c-incorrect', input: 3, expected: 999 },   // a genuine wrong answer
    { id: 'd-skipped',   input: null, expected: 0, unavailable: 'no fixture for this case' },
    { id: 'e-error',     input: 'boom', expected: 0 },
  ],

  async run(testCase) {
    if (testCase.unavailable) {
      return { status: 'skipped', reason: testCase.unavailable };
    }
    if (testCase.input === 'boom') {
      throw new Error('deliberate failure — proves a throw is an ERROR, not a wrong answer');
    }
    return { status: 'ok', actual: testCase.input * 2 };
  },

  score(testCase, actual) {
    return { correct: actual === testCase.expected, actual, expected: testCase.expected };
  },

  metrics(scored) {
    const correct = scored.filter(s => s.correct).length;
    return { accuracy: scored.length ? correct / scored.length : 0, correct, scored: scored.length };
  },
};
