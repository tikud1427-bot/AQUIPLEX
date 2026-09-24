/**
 * AQUIPLEX Eval — Longitudinal Learning Loop (diagnostic)
 *
 * This suite tests the PRODUCT PROPERTY rather than a subsystem:
 * information accumulated earlier must change what the retrieval/context
 * layer can use later, and a correction must supersede the previous state
 * without erasing history.
 *
 * It deliberately uses the current production retrieval facade in an isolated
 * eval world. It is not a substitute for the live Postgres E6→E7→E9 gate;
 * it is the deterministic longitudinal contract that must hold before that
 * live gate is claimed closed.
 */
import { seedWorld, retrieveWithContextEngine, resetWorld } from '../adapters/contextEngineRetrieval.mjs';

const OWNER = 'user:eval-longitudinal-learning-loop';

const INITIAL = [
  { id: 'project-alpha', statement: 'I am building Project Alpha.', entities: ['You', 'Project Alpha'], confidence: 0.95, sourceType: 'conversation' },
  { id: 'alpha-launch-nov', statement: 'Project Alpha launches in November.', entities: ['Project Alpha'], confidence: 0.95, sourceType: 'conversation' },
  { id: 'funding-priority', statement: 'Funding is currently a higher priority than launch work.', entities: ['You', 'Project Alpha'], confidence: 0.9, sourceType: 'conversation' },
];

const UPDATED = [
  { id: 'alpha-launch-dec', statement: 'Project Alpha launches in December.', entities: ['Project Alpha'], confidence: 0.98, sourceType: 'conversation' },
];

async function addFacts(corpus) {
  // seedWorld mirrors the production retrieval write shape. It is intentionally
  // used here instead of calling an inner retrieval primitive.
  await seedWorld(OWNER, corpus);
}

function ids(result) {
  return new Set((result.ranked ?? []).map(String));
}

export default {
  id: 'longitudinal-learning-loop',
  title: 'Longitudinal Learning Loop — accumulated context changes later retrieval',
  about: [
    'Diagnostic longitudinal contract for AQUIPLEX: an earlier user world is',
    'seeded, later information is added as a correction, and future questions',
    'must surface the current state rather than treating every turn as stateless.',
    'The suite is deterministic and isolated; live Postgres closure remains a',
    'separate production gate.',
  ].join(' '),
  cases: [
    { id: 'accumulation', q: 'What am I building and when does it launch?' },
    { id: 'correction', q: 'When does Project Alpha launch now?' },
    { id: 'priority', q: 'What is currently a higher priority than launch work?' },
  ],

  async run(testCase) {
    await resetWorld(OWNER).catch(() => {});
    await addFacts(INITIAL);

    const before = await retrieveWithContextEngine(OWNER, testCase.q, { limit: 8 });

    // Simulate a later turn that changes the world. The old assertion remains
    // present in the corpus; the new assertion is appended, matching the
    // append-only direction of the canonical model. The production canonical
    // lifecycle layer is responsible for marking the old state superseded.
    if (testCase.id === 'correction') {
      await addFacts(UPDATED);
    }

    const after = await retrieveWithContextEngine(OWNER, testCase.q, { limit: 8 });

    return {
      status: 'ok',
      actual: {
        before: { ranked: before.ranked, stats: before.stats },
        after: { ranked: after.ranked, stats: after.stats },
        changed: JSON.stringify(before.ranked) !== JSON.stringify(after.ranked),
      },
    };
  },

  score(testCase, actual) {
    const before = ids(actual.before);
    const after = ids(actual.after);
    const launchBefore = before.has('alpha-launch-nov');
    const launchAfter = after.has('alpha-launch-dec');

    if (testCase.id === 'accumulation') {
      return { correct: before.has('project-alpha') && before.has('alpha-launch-nov'), checks: {
        projectKnown: before.has('project-alpha'),
        launchKnown: before.has('alpha-launch-nov'),
      }};
    }

    if (testCase.id === 'correction') {
      return { correct: launchBefore && launchAfter && actual.changed, checks: {
        previousStateWasKnown: launchBefore,
        currentStateWasAdded: launchAfter,
        retrievalChangedAfterNewInformation: actual.changed,
      }};
    }

    return { correct: before.has('funding-priority'), checks: {
      accumulatedPriorityContextRetrieved: before.has('funding-priority'),
    }};
  },

  metrics(scored) {
    const rows = scored.map(x => x.checks ?? {});
    const count = key => rows.filter(x => x[key]).length;
    return {
      cases: scored.length,
      accumulation: count('projectKnown') === 1 && count('launchKnown') === 1,
      correctionPreviousStateKnown: count('previousStateWasKnown'),
      correctionCurrentStateAdded: count('currentStateWasAdded'),
      correctionRetrievalChanged: count('retrievalChangedAfterNewInformation'),
      priorityContextRetrieved: count('accumulatedPriorityContextRetrieved'),
    };
  },
};
