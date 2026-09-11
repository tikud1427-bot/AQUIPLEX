/**
 * UUS U2 — interview steering.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a question list. Not a state machine. Not a step counter.
 *
 * A scripted questionnaire is the thing the brief explicitly forbids, and it is
 * also worse at its job: the moment someone answers off-script — which is the
 * moment they say something worth knowing — a script either ignores it or
 * derails. So the model writes the questions, and this module only tells it
 * WHERE THE GAPS ARE.
 *
 * That inverts the usual shape. Instead of "ask question 3 of 7", the prompt
 * carries "you still don't know what they're working toward", and the model
 * decides how to get there from whatever was just said.
 *
 * WHY IT COULD ONLY BE BUILT AFTER U4
 * -----------------------------------
 * The gap list comes from the same coverage math that produces the score on the
 * understanding card. Before U4 that math lived in the frontend store, so the
 * server could not see it — the interviewer would have needed its own private
 * notion of what was known, which is exactly how a card and a dashboard end up
 * disagreeing. One formula, two readers.
 *
 * PURE
 * ----
 * No store imports, no LLM call. Choosing the next topic is deterministic
 * ranking over data the caller already has; spending a model round-trip on it
 * would add latency to the one conversation that promises to take two minutes.
 */
import { unknownAreas, COVERAGE_DIMENSIONS } from './coverage.js';

/** How many gaps to name at once. */
const MAX_HINTS = 3;

/**
 * Roughly the order these matter for being useful to someone. Used only to
 * break ties among equally-unknown areas — the live conversation outranks it,
 * which is why this is a tiebreak and not a sequence.
 */
const TOPIC_ORDER = [
  'goals', 'identity', 'behavior', 'communication', 'preferences', 'knowledge', 'personality',
];

/** What to actually say about each gap, in the second person. */
const GAP_PHRASING = Object.freeze({
  goals:         'what they are trying to accomplish',
  identity:      'what they do, and what they are working on now',
  behavior:      'how they work day to day',
  communication: 'how much detail and explanation they want',
  preferences:   'what tools and approaches they prefer',
  knowledge:     'what they already know well, so you can skip the basics',
  personality:   'how they think about problems',
});

const rank = (id) => {
  const i = TOPIC_ORDER.indexOf(id);
  return i === -1 ? TOPIC_ORDER.length : i;
};

/**
 * The gaps worth steering toward, most valuable first.
 *
 * @param {object} args  same shape as coverage.buildCoverage
 * @returns {Array<{ id, prompt }>}
 */
export function openTopics({ beliefsByDimension = {}, goals = [], gaps = {} } = {}) {
  const seen = new Set();
  const out = [];

  for (const u of unknownAreas({ beliefsByDimension, goals, gaps })) {
    const id = u.dimension === 'goals' ? 'goals' : u.dimension;
    if (seen.has(id)) continue;
    if (!GAP_PHRASING[id]) continue;
    seen.add(id);
    out.push({ id, prompt: GAP_PHRASING[id], weight: u.weight });
  }

  return out
    .sort((a, b) => b.weight - a.weight || rank(a.id) - rank(b.id))
    .map(({ id, prompt }) => ({ id, prompt }));
}

/**
 * The directive appended to the interviewer prompt.
 *
 * Returns '' when there is nothing useful to say — an empty directive is
 * better than a filler one, because a prompt that always ends with a nagging
 * instruction trains the model to ignore that position.
 *
 * @returns {string}
 */
export function directive(args = {}) {
  const topics = openTopics(args).slice(0, MAX_HINTS);
  if (!topics.length) {
    // Everything the coverage model tracks has something in it. Saying so is
    // worth more than saying nothing: it tells the model to stop probing and
    // start wrapping up, which is how the conversation ends at the right
    // length instead of running until the user gets bored.
    return 'You now have at least something on every area you track. '
         + 'Unless they raise something new, wrap up rather than asking more.';
  }

  const lines = topics.map(t => `- ${t.prompt}`).join('\n');
  return [
    'Still unknown, in rough order of value:',
    lines,
    'Work toward these when the conversation allows. Follow what they actually '
      + 'say first — a live thread is always worth more than the next item here. '
      + 'Never read this list out, and never mention that you are tracking gaps.',
  ].join('\n');
}

/**
 * Has the conversation covered enough to be worth showing a summary?
 *
 * Deliberately generous. The cost of ending slightly early is a thinner card
 * that fills in from ordinary chat; the cost of ending late is someone stuck in
 * a conversation they did not ask for, which is the failure the whole brief is
 * written against.
 */
export function readyToSummarise({ beliefsByDimension = {}, goals = [], turns = 0 } = {}) {
  const filled = COVERAGE_DIMENSIONS
    .filter(d => (beliefsByDimension[d] ?? []).some(b => b && b.status !== 'archived')).length;
  const goalList = Array.isArray(goals) ? goals : Object.values(goals ?? {});
  const hasGoal = goalList.some(g => g?.status === 'active' || g?.status === 'blocked');
  return turns >= 4 && filled >= 3 && hasGoal;
}
