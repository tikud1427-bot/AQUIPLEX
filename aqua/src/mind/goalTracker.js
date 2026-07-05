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

// Detection: explicit goal statements + working-toward phrasing.
const GOAL_PATTERNS = [
  /\bmy goal is (?:to )?(.{4,90}?)(?:[.,;!]|$)/i,
  /\bi(?:'m| am) (?:trying|working|aiming|planning) to (.{4,90}?)(?:[.,;!]|$)/i,
  /\bi want to (?:finally |eventually )?((?:ship|launch|build|finish|complete|release|migrate|raise|hire|reach|grow|refactor|rewrite|land)\b.{0,80}?)(?:[.,;!]|$)/i,
  /\bwe (?:need|want|plan) to ((?:ship|launch|build|finish|complete|release|migrate|raise|close)\b.{0,80}?)(?:[.,;!]|$)/i,
];

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
    if (m?.[1]) titles.push(m[1].trim().replace(/\s+/g, ' '));
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
