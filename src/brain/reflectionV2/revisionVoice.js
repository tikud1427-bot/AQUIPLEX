/**
 * AQUA Brain — raising a revision, out loud.
 *
 * THE CAPABILITY
 * --------------
 * Everything else AQUA does answers "what do I know about you". This answers
 * something no amount of context window can: "I changed my mind about you, and
 * I should say so." A transcript gives an assistant recall. It does not give it
 * a position that can be revised, and it certainly does not make it volunteer
 * the revision.
 *
 * The data now exists — every real WorldDelta is recorded to the PIC ledger.
 * The prompt path had no idea. This module is the seam: one pending revision
 * becomes one short directive on one suitable turn, and then never again.
 *
 * PURE. Zero imports, every input an argument. Pinned by a structural test for
 * the same reason `conversationFacts` and `declarativeIntent` are: it is
 * consulted on the turn path, and a store import here would put persistence
 * inside prompt construction.
 *
 * FOUR RULES, and each one is a way this could go wrong
 * ----------------------------------------------------
 * 1. ASK, NEVER ASSERT. The delta says the world model changed. It does not say
 *    the change is correct. "Has your priority moved?" is honest; "Your
 *    priority has moved" is AQUA reporting its own bookkeeping as fact about
 *    someone's life.
 *
 * 2. ONE AT A TIME, ONCE. A revision raised twice is nagging; three raised at
 *    once is an audit. The caller advances a watermark on injection.
 *
 * 3. NOT ON EVERY TURN, AND NOT ON WORKING TURNS. Interrupting a debugging
 *    session with a question about someone's goals is the behaviour that makes
 *    people turn a feature off. Suitability is the caller's decision; this
 *    module refuses to build anything for a turn type it was not given.
 *
 * 4. NEVER NARRATE THE MACHINERY. No "my world model updated", no confidence
 *    numbers, no entity counts. The user gets a question about their work, not
 *    a changelog of ours.
 */

/** Revisions smaller than this are bookkeeping, not something to raise. */
export const MIN_INTERESTING_CHANGES = 2;

/**
 * Task types where raising a revision is welcome rather than an interruption.
 *
 * Conversational and self-referential turns only. A revision is a question
 * about the person; a question about the person during `coding` or `debugging`
 * is an interruption no matter how well phrased.
 */
export const SUITABLE_TASKS = new Set([
  'conversation', 'personal_info', 'memory_recall', 'memory_update', 'simple_qa', 'opinion',
]);

/**
 * Is this turn a reasonable moment to raise a revision?
 *
 * `understanding_interview` is deliberately EXCLUDED even though it is the most
 * conversational turn there is. During the intro AQUA is supposed to be
 * learning, not reporting back — and the interview has its own directive on
 * this exact channel, so both would arrive at once and compete.
 */
export function isSuitableTurn({ taskType, mode = null } = {}) {
  if (mode) return false;
  return SUITABLE_TASKS.has(String(taskType ?? ''));
}

/**
 * Is a recorded revision worth a person's attention?
 *
 * A single entity appearing is how the world model breathes; it is not news.
 * An obsoleted fact or a revised assumption IS news at any size — those are
 * cases where AQUA previously believed something that no longer holds, which
 * is exactly the thing worth admitting.
 */
export function isWorthRaising(revision) {
  if (!revision) return false;
  const obsoleted = Number(revision.obsoleted) || 0;
  const revised   = Number(revision.revised) || 0;
  if (obsoleted > 0 || revised > 0) return true;
  const changed = (Number(revision.entities) || 0) + (Number(revision.relationships) || 0);
  return changed >= MIN_INTERESTING_CHANGES;
}

/** Join names the way a person would: "A", "A and B", "A, B and C". */
function listNames(names) {
  const n = names.filter(Boolean);
  if (n.length <= 1) return n[0] ?? '';
  if (n.length === 2) return `${n[0]} and ${n[1]}`;
  return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
}

/**
 * The directive. Returns '' when there is nothing to raise — an empty string,
 * never filler, for the reason `interview.directive` gives: a prompt position
 * that always contains a nagging instruction is a position the model learns to
 * ignore.
 *
 * BUILT FROM NAMES, NOT COUNTS. An earlier version passed `delta.summary`
 * straight through, so the model was handed "your understanding changed: 5
 * entities changed; 1 relationship(s) changed" and then instructed not to sound
 * like a changelog. It was being asked to be human about arithmetic. The delta
 * carries labels; those are what a person can actually be asked about.
 *
 * @param {object|null} revision  ledger entry: { subjects[], revisions[], obsoleted, revised, entities, relationships }
 * @returns {string}
 */
export function buildRevisionDirective(revision) {
  if (!isWorthRaising(revision)) return '';

  const revisions = Array.isArray(revision.revisions) ? revision.revisions : [];
  const subjects  = (Array.isArray(revision.subjects) ? revision.subjects : [])
    .map(s => String(s).trim()).filter(Boolean).slice(0, 3);

  // A superseded assumption is the strongest material available: AQUA believed
  // something and no longer does. Preferred over a list of what merely moved.
  const superseded = revisions.find(r => r?.to);
  let what;
  if (superseded) {
    what = superseded.from
      ? `You had it that ${superseded.from}. It now looks more like ${superseded.to}.`
      : `It now looks like ${superseded.to}, which is not what you had before.`;
  } else if (subjects.length) {
    what = `What you understand about ${listNames(subjects)} has shifted since you last took stock.`;
  } else {
    // Counts only, no labels — nothing a person could be asked about. Better to
    // say nothing than to ask a question with no subject in it.
    return '';
  }

  return [
    'SOMETHING YOU NOTICED, and have not mentioned yet.',
    what,
    'If — and only if — it fits naturally, raise it ONCE, briefly, in your own '
      + 'words, near the end of your reply. Ask whether you have it right. Do not '
      + 'assert that their situation changed: you observed your own understanding '
      + 'change, which is not the same thing and may simply mean you learned more.',
    'Never describe the mechanism. No mention of a world model, a reflection, '
      + 'confidence scores, or counts of anything. If the current message is '
      + 'urgent, technical, or emotionally loaded, say nothing about this at all '
      + 'and just answer them.',
  ].join('\n');
}
