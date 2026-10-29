/**
 * AQUA Mind — Goal Tracker (Layer 5)
 * ─────────────────────────────────────────────────────────────────────────────
 * Goals are first-class living objects: detected from conversation, matched
 * fuzzily against existing goals (re-mention strengthens, not duplicates),
 * auto-progressed / completed / blocked from message cues, and marked STALE
 * by the reflection engine when unmentioned too long. Never hard-deleted by
 * inference — only the user deletes.
 */
import { createGoal, GOAL_STATUS, CAPS, createTimelineEvent } from './mindSchema.js';
import { touchMind } from './mindStore.js';
import { pushTimeline } from './timeline.js';
import { splitCoordinated, listContinuation, isGoalLike, goalSimilarity, splitGoalTitle } from './goalText.js';

export { goalSimilarity, splitGoalTitle };

/* ──────────────────────────────────────────────────────────────────────────
   GOAL DETECTION
   ──────────────────────────────────────────────────────────────────────────
   The previous table detected 1 of 10 realistic goal statements. Measured:

     ✗ "I want to hit 10,000 active merchants by December."
     ✗ "My top priority this quarter is launching the beta."
     ✗ "we're aiming to close the seed round by March"
     ✗ "the goal is to cut churn in half"
     ✗ "I need to ship the pricing page this week"
     ✓ "Long term I want to build AI that truly understands people."
     ✗ "planning to hire two engineers"
     ✗ "I'd like to get to profitability next year"
     ✗ "trying to reduce onboarding time"
     ✗ "our objective is 10k merchants"

   Three separate causes, all the same shape — a coding-era heuristic applied
   to how people actually talk:

     1. A CLOSED VERB ALLOWLIST (ship|launch|build|finish|…). "hit", "get to",
        "cut", "reduce" and every other outcome verb were invisible. A goal is
        not a deploy.
     2. `my goal is` required that exact possessive — "the goal is", "our
        objective is", "my top priority is" all missed.
     3. `i'm (trying|aiming|planning) to` required an explicit I'm/I am, so
        bare "planning to …" and any `we`-subject aiming missed entirely.

   WHY THE ALLOWLIST IS NOT SIMPLY WIDENED
   ---------------------------------------
   Opening the verb up is what makes "I want to know how OAuth works" a goal,
   and a wrong goal is materially worse than a missing one: goals are the
   heaviest single term in the understanding score (`goals:none` carries
   weight 1.2, the largest gap in the whole model) and they render on the card
   under "Aiming at". So the allowlist is replaced by a cue-led match plus an
   EXCLUSION guard on the head verb: asking, checking and understanding are
   requests, not intentions. That inverts the failure mode — an unusual
   outcome verb now gets in, and a conversational one is turned away by name.
   ────────────────────────────────────────────────────────────────────────── */

// Detection: explicit goal statements + working-toward phrasing. Global: a
// message can state several goals in separate sentences, and every one counts
// ("I want to launch the beta. I also want to hire a designer.").
const GOAL_PATTERNS = [
  // "my/our goal is …", "the goal here is …", "my goals are …"
  /\b(?:my|our|the)\s+(?:main\s+|primary\s+|current\s+)?(?:goal|objective|aim|mission|target)s?\b[^.!?;]{0,20}?\s+(?:is|are)\s+(?:to\s+)?(.{4,90}?)(?:[.,;!](?!\d)|$)/gi,
  // "my top priority this quarter is …"
  /\b(?:my|our)\s+(?:top\s+|main\s+|biggest\s+|number one\s+)?priority\b[^.!?;]{0,24}?\s+is\s+(?:to\s+)?(.{4,90}?)(?:[.,;!](?!\d)|$)/gi,
  // "I'm trying to …", "we're aiming to …", and the bare participle form
  /\b(?:(?:i|we)(?:'m|'re| am| are)\s+)?(?:trying|aiming|planning|hoping|looking|pushing|working)\s+(?:to|toward|towards)\s+(.{4,90}?)(?:[.,;!](?!\d)|$)/gi,
  // "I want to …", "I'd like to …", "I need to …", "I also want to …" — and the we/plural forms
  /\b(?:i|we)(?:'d)?\s+(?:also\s+)?(?:want|need|plan|intend|would like|just want)\s+to\s+(?:finally\s+|eventually\s+)?(.{4,90}?)(?:[.,;!](?!\d)|$)/gi,
  /\b(?:i|we)'d\s+(?:also\s+)?like\s+to\s+(.{4,90}?)(?:[.,;!](?!\d)|$)/gi,
];

const DONE_RE    = /\b(finished|completed|shipped|launched|released|done with|we shipped|it'?s live|merged)\b/i;
const BLOCKED_RE = /\b(blocked (on|by)|stuck on|can'?t proceed|waiting (on|for))\b/i;
const PROGRESS_RE = /\b(made progress|almost (done|there)|halfway|nearly (done|finished)|good progress)\b/i;

const MATCH_THRESHOLD = 0.5;

function findMatch(mind, title) {
  let best = null, bestScore = 0;
  for (const g of Object.values(mind.goals)) {
    if (g.status === GOAL_STATUS.ABANDONED) continue;
    const s = goalSimilarity(g.title, title);
    if (s > bestScore) { bestScore = s; best = g; }
  }
  return bestScore >= MATCH_THRESHOLD ? best : null;
}

export function detectGoalTitles(text) {
  const src = String(text ?? '');
  const found = [];   // [{ at, title }] — ordered by position in the message
  for (const p of GOAL_PATTERNS) {
    for (const m of src.matchAll(p)) {
      if (!m[1]) continue;
      const captureEnd = m.index + m[0].length - (/[.,;!]$/.test(m[0]) ? 1 : 0);
      const pieces = [...splitCoordinated(m[1]), ...listContinuation(src, captureEnd)];
      pieces.forEach((piece, i) => found.push({ at: m.index + i, title: piece.replace(/\s+/g, ' ').trim() }));
    }
  }
  const titles = [];
  for (const { title } of found.sort((a, b) => a.at - b.at)) {
    if (!isGoalLike(title)) continue;
    // Two patterns can capture the same statement ("I'm planning to …" and
    // "I plan to …" forms) — one goal, the first wording.
    if (titles.some(t => t === title || goalSimilarity(t, title) >= 0.9)) continue;
    titles.push(title);
  }
  return titles;
}

/* ── Status cues ──────────────────────────────────────────────────────────────
   A status change is only ever applied to a goal the message is ABOUT. Until
   2026-10-28 an unmatched cue fell back to "the most recently mentioned active
   goal", so "I finished lunch" completed "become a billionaire", and "I haven't
   shipped it yet" completed whatever was discussed last. A cue that is
   negated ("haven't finished"), hedged ("almost done") or conditional ("once
   we've launched") is not a status change at all. Silence never completes
   anything. */
const CUE_NEGATED = /\b(?:not|never|no|yet to|haven'?t|hasn'?t|hadn'?t|didn'?t|isn'?t|wasn'?t|aren'?t|won'?t|can'?t|almost|nearly|once|when|after|if|until|before|hope(?:fully)?|will|should|might|could)\b[^.!?]{0,24}$/i;

function cueApplies(re, message) {
  const m = re.exec(message);
  if (!m) return false;
  return !CUE_NEGATED.test(message.slice(Math.max(0, m.index - 40), m.index));
}

/** The goal this message is about: a goal named this turn, else one whose words the message uses. */
function referencedGoal(mind, titles, message) {
  for (const t of titles) {
    const g = findMatch(mind, t);
    if (g) return g;
  }
  let best = null, bestScore = 0;
  for (const g of Object.values(mind.goals)) {
    if (g.status !== GOAL_STATUS.ACTIVE && g.status !== GOAL_STATUS.BLOCKED && g.status !== GOAL_STATUS.STALE) continue;
    const s = goalSimilarity(g.title, message);
    if (s > bestScore || (s === bestScore && best && g.lastMentionedAt > best.lastMentionedAt)) { bestScore = s; best = g; }
  }
  return bestScore >= MATCH_THRESHOLD ? best : null;
}

/**
 * Per-turn goal update. Consumes:
 *   • detected titles from this message
 *   • schema-extracted goal facts (fact bridge — reuse, no re-parse)
 *   • status cues (done/blocked/progress) applied to the best-matching goal
 */
export function trackGoals(mind, { userMessage = '', extractedFacts = [], conversationId = null, workspaceId = null }) {
  const now = Date.now();
  const changed = [];

  const titles = detectGoalTitles(userMessage);
  for (const f of extractedFacts) {
    if (f.key !== 'goal' || typeof f.value !== 'string') continue;
    for (const piece of splitCoordinated(f.value.trim())) {
      if (isGoalLike(piece) && !titles.some(t => goalSimilarity(t, piece) >= 0.9)) titles.push(piece);
    }
  }

  for (const title of titles) {
    const existing = findMatch(mind, title);
    if (existing) {
      existing.mentions += 1;
      existing.lastMentionedAt = now;
      existing.updatedAt = now;
      existing.confidence = Math.min(1, existing.confidence + 0.1);
      if (existing.status === GOAL_STATUS.STALE) existing.status = GOAL_STATUS.ACTIVE;
      if (workspaceId && !existing.relatedProjects.includes(workspaceId)) existing.relatedProjects.push(workspaceId);
      changed.push(existing);
    } else {
      const activeCount = Object.values(mind.goals).filter(g => g.status === GOAL_STATUS.ACTIVE).length;
      if (activeCount >= CAPS.GOALS_ACTIVE) continue; // reflection will make room
      const goal = createGoal({ title, source: 'inference', confidence: 0.55 });
      if (workspaceId) goal.relatedProjects.push(workspaceId);
      mind.goals[goal.id] = goal;
      pushTimeline(mind, createTimelineEvent({ kind: 'goal_created', subject: title, importance: 6 }));
      changed.push(goal);
    }
  }

  // Status cues → only the goal this message names (see "Status cues" above).
  const cueTarget = () => referencedGoal(mind, titles, userMessage);

  if (cueApplies(DONE_RE, userMessage)) {
    const g = cueTarget();
    if (g && g.status !== GOAL_STATUS.COMPLETED) {
      g.history.push({ status: g.status, at: now, reason: 'completion cue' });
      g.status = GOAL_STATUS.COMPLETED;
      g.progress = 1;
      g.updatedAt = now;
      pushTimeline(mind, createTimelineEvent({ kind: 'goal_completed', subject: g.title, importance: 7 }));
      changed.push(g);
    }
  } else if (cueApplies(BLOCKED_RE, userMessage)) {
    const g = cueTarget();
    if (g && g.status === GOAL_STATUS.ACTIVE) {
      g.history.push({ status: g.status, at: now, reason: 'blocked cue' });
      g.status = GOAL_STATUS.BLOCKED;
      const blocker = userMessage.match(BLOCKED_RE)?.[0]?.slice(0, 60);
      if (blocker && !g.blockers.includes(blocker)) g.blockers.push(blocker);
      g.updatedAt = now;
      changed.push(g);
    }
  } else if (PROGRESS_RE.test(userMessage)) {
    const g = cueTarget();
    if (g && g.status !== GOAL_STATUS.COMPLETED) {
      g.progress = Math.min(0.9, (g.progress || 0) + 0.2);
      g.status = GOAL_STATUS.ACTIVE;
      g.updatedAt = now;
      g.lastMentionedAt = now;
      changed.push(g);
    }
  }

  if (changed.length) touchMind(mind);
  return changed;
}

export function getActiveGoals(mind, limit = 5) {
  return Object.values(mind.goals)
    .filter(g => g.status === GOAL_STATUS.ACTIVE || g.status === GOAL_STATUS.BLOCKED)
    .sort((a, b) => (b.priority - a.priority) || (b.lastMentionedAt - a.lastMentionedAt))
    .slice(0, limit);
}
