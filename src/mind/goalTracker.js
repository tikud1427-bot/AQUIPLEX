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

// Detection: explicit goal statements + working-toward phrasing.
const GOAL_PATTERNS = [
  // "my/our goal is …", "the goal here is …", "my objective is …"
  /\b(?:my|our|the)\s+(?:main\s+|primary\s+|current\s+)?(?:goal|objective|aim|mission|target)\b[^.!?;]{0,20}?\s+is\s+(?:to\s+)?(.{4,90}?)(?:[.,;!](?!\d)|$)/i,
  // "my top priority this quarter is …"
  /\b(?:my|our)\s+(?:top\s+|main\s+|biggest\s+|number one\s+)?priority\b[^.!?;]{0,24}?\s+is\s+(?:to\s+)?(.{4,90}?)(?:[.,;!](?!\d)|$)/i,
  // "I'm trying to …", "we're aiming to …", and the bare participle form
  /\b(?:(?:i|we)(?:'m|'re| am| are)\s+)?(?:trying|aiming|planning|hoping|looking|pushing|working)\s+(?:to|toward|towards)\s+(.{4,90}?)(?:[.,;!](?!\d)|$)/i,
  // "I want to …", "I'd like to …", "I need to …" — and the we/plural forms
  /\b(?:i|we)(?:'d)?\s+(?:want|need|plan|intend|would like|just want)\s+to\s+(?:finally\s+|eventually\s+)?(.{4,90}?)(?:[.,;!](?!\d)|$)/i,
  /\b(?:i|we)'d\s+like\s+to\s+(.{4,90}?)(?:[.,;!](?!\d)|$)/i,
];

/**
 * Head verbs that make a capture a REQUEST rather than an intention.
 *
 * "I want to know how this works" and "I need to check the logs" are things
 * the user wants from this turn, not things they are working toward. They must
 * never reach the card, so they are named explicitly rather than excluded by
 * an allowlist that would also drop every outcome verb nobody thought of.
 */
const NOT_A_GOAL_HEAD = new Set([
  'know', 'understand', 'see', 'ask', 'hear', 'check', 'find', 'look',
  'read', 'say', 'tell', 'talk', 'discuss', 'confirm', 'clarify', 'explain',
  'remember', 'show', 'compare', 'review', 'double-check', 'verify', 'figure',
]);

/** Tokens that carry no goal. A capture made ENTIRELY of these is noise —
 *  "do it", "get more", "be better". Checked per-token rather than against the
 *  whole string, because the contentless case is usually two words, not one. */
const CONTENTLESS = new Set((
  'it,this,that,them,thing,things,stuff,something,anything,more,less,better,' +
  'faster,best,out,up,down,go,going,be,do,doing,get,getting,make,making,work,on'
).split(','));

/**
 * A capture is a goal unless it reads as a request or is empty of content.
 * Kept strict on purpose: goals are the heaviest term in the understanding
 * score and the most visible line on the card.
 */
function isGoalLike(capture) {
  const v = String(capture ?? '').trim();
  if (v.length < 4 || v.length > 90) return false;
  if (v.endsWith('?')) return false;                 // a question is not a plan
  const tokens = v.toLowerCase().split(/\s+/).map(t => t.replace(/[^\p{L}\p{N}-]/gu, '')).filter(Boolean);
  if (!tokens.length) return false;
  if (NOT_A_GOAL_HEAD.has(tokens[0])) return false;
  if (tokens.every(t => CONTENTLESS.has(t))) return false;
  return true;
}

const DONE_RE    = /\b(finished|completed|shipped|launched|released|done with|we shipped|it'?s live|merged)\b/i;
const BLOCKED_RE = /\b(blocked (on|by)|stuck on|can'?t proceed|waiting (on|for))\b/i;
const PROGRESS_RE = /\b(made progress|almost (done|there)|halfway|nearly (done|finished)|good progress)\b/i;

const STOPWORDS = new Set(['the','a','an','to','of','for','and','or','in','on','with','our','my','it','this','that','be','is','are']);

function tokenize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

/** Jaccard-ish token overlap — good enough for goal re-mention matching. */
export function goalSimilarity(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

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
  const titles = [];
  for (const p of GOAL_PATTERNS) {
    const m = text.match(p);
    if (!m?.[1]) continue;
    const title = m[1].trim().replace(/\s+/g, ' ');
    if (!isGoalLike(title)) continue;
    titles.push(title);
  }
  return [...new Set(titles)];
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
    if (f.key === 'goal' && typeof f.value === 'string') titles.push(f.value);
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

  // Status cues → most relevant active goal (mentioned-title match first,
  // else most recently mentioned active goal — conversation continuity).
  const cueTarget = () => {
    for (const t of titles) {
      const g = findMatch(mind, t);
      if (g) return g;
    }
    return Object.values(mind.goals)
      .filter(g => g.status === GOAL_STATUS.ACTIVE || g.status === GOAL_STATUS.BLOCKED)
      .sort((a, b) => b.lastMentionedAt - a.lastMentionedAt)[0] || null;
  };

  if (DONE_RE.test(userMessage)) {
    const g = cueTarget();
    if (g && g.status !== GOAL_STATUS.COMPLETED) {
      g.history.push({ status: g.status, at: now, reason: 'completion cue' });
      g.status = GOAL_STATUS.COMPLETED;
      g.progress = 1;
      g.updatedAt = now;
      pushTimeline(mind, createTimelineEvent({ kind: 'goal_completed', subject: g.title, importance: 7 }));
      changed.push(g);
    }
  } else if (BLOCKED_RE.test(userMessage)) {
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
