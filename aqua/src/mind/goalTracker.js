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
import { transitionOf, closeKind, datesIn, subjectShared, partAbout, speculative, achieves, whenSaid, reportsDone } from '../understanding/stateTransition.js';
import { splitClauses } from '../memory/sentenceParser.js';

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
      // A goal the user STATED ("My goal is to read twenty books") is a goal whatever its verb;
      // the head filter exists for goals inferred from remarks ("I want to read about…").
      const stated = f.pattern === 'goal_is' && piece.length >= 4 && piece.length <= 90 && !piece.endsWith('?');
      if ((isGoalLike(piece) || stated) && !titles.some(t => goalSimilarity(t, piece) >= 0.9)) titles.push(piece);
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
      // Restated as it was: whatever changed it earlier is no longer the last word.
      if (existing.changedBy) delete existing.changedBy;
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

  // A completion cue counts only as the user reporting their own thing done, whole
  // (stateTransition.reportsDone) — the keyword alone completed a goal for
  // "Our competitor launched their product" and "I finished the first draft".
  if (cueApplies(DONE_RE, userMessage) && splitClauses(userMessage).some(c => reportsDone(c, DONE_RE))) {
    // The goal named in this same message ("…ship v2 — and we shipped it"); otherwise only a
    // goal the achievement reader says was done (what was done to what: "I finished my third
    // swimming lesson" is not "learn to swim"), never one found by shared words alone.
    const read = titles.length ? null : achievedGoal(mind, userMessage, titles, changed);
    const g = titles.length ? cueTarget() : read?.g ?? null;
    if (g && g.status !== GOAL_STATUS.COMPLETED) {
      g.history.push({ status: g.status, at: now, reason: 'completion cue' });
      if (read) g.achievedBy = { text: userMessage.replace(/\s+/g, ' ').trim().slice(0, 160), clause: read.clause.slice(0, 160), at: now, when: whenSaid(read.clause) };
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

  laterWordOnGoals(mind, userMessage, titles, now, changed);

  if (changed.length) touchMind(mind);
  return changed;
}

/* ── The user's later word on a goal (2026-11-02) ─────────────────────────────
   Completion knew only "finished/shipped/launched…", so "The new driving
   licence arrived" left "renew my driving licence before it expires in March"
   an active goal, and "I changed my goal: a half marathon instead" left "run a
   marathon" one — each told to the answer model as what the user is working
   toward (dev sets: 6 of 36 users). Applied only when the message is about
   ONE goal — two shared subject words, or one distinctive word (5+ letters)
   no other open goal shares — and only on the user's own words:
     · a resolution ("arrived", "came through", "sorted"), not negated → COMPLETED;
     · an ending ("gave up", "cancelled", "no longer") → ABANDONED;
     · a change ("changed my goal", or a NEW date for the same thing:
       "Shipping slips to April 20" for "ship the first batch on March 3") →
       the goal stays, carrying the message as `changedBy`; the title is never
       rewritten (that would be inventing the new goal's wording).
   Every change is recorded in the goal's history. */
const GOAL_CHANGE_RE = /\b(?:changed|switched|changing|switching)\s+(?:my|our)\s+(?:goal|target|plan|priority|focus)\b|\b(?:goal|target|plan|priority) is now\b|\binstead of\b/i;
const OPEN = new Set([GOAL_STATUS.ACTIVE, GOAL_STATUS.BLOCKED, GOAL_STATUS.STALE]);

/** The message names a date and the goal a DIFFERENT one: "slips to April 20" for "… on March 3". */
const reschedules = (message, title) => {
  const now = datesIn(message), was = datesIn(title);
  return now.length > 0 && was.length > 0 && !now.some(d => was.includes(d));
};

function goalTheMessageIsAbout(mind, message) {
  const open = Object.values(mind.goals).filter(g => OPEN.has(g.status));
  const hits = open.map(g => ({ g, shared: subjectShared(message, g.title) })).filter(h => h.shared.length);
  const two = hits.filter(h => h.shared.length >= 2);
  if (two.length === 1) return two[0].g;
  if (two.length > 1) return null;   // ambiguous: touch nothing
  if (hits.length !== 1) return null;
  // One shared word: distinctive (5+ letters), or any word when the message
  // gives the same thing a new date — the pair of dates is the evidence.
  return hits[0].shared[0].length >= 5 || reschedules(message, hits[0].g.title) ? hits[0].g : null;
}

/**
 * ACHIEVED (2026-11-04): the user reports the goal's outcome done — "I finally
 * ran the half marathon", "I got the promotion", "We closed our seed round" —
 * read per clause by the shared reader (understanding/stateTransition.js
 * achieves: the user as subject, a past form of the goal's verb or a completion
 * verb, the goal's object, not negated / planned / partial / sarcastic). Only
 * when ONE open goal is the best match; a tie touches nothing. The goal is
 * completed with the user's words and when they said it happened
 * (`achievedBy`); its title and history stay. The profile's goal list follows
 * through memory/propagation.js reconcileGoals.
 */
function achievedGoal(mind, message, titles, changed) {
  const open = Object.values(mind.goals).filter(g => OPEN.has(g.status) && !(changed.includes(g) && titles.some(t => goalSimilarity(t, g.title) >= MATCH_THRESHOLD)));
  let best = null, tie = false;
  for (const clause of splitClauses(message)) {
    for (const g of open) {
      const a = achieves(clause, g.title);
      if (!a) continue;
      if (!best || a.coverage > best.a.coverage) { best = { g, a, clause }; tie = false; }
      else if (a.coverage === best.a.coverage && best.g !== g) tie = true;
    }
  }
  return best && !tie ? best : null;
}

function laterWordOnGoals(mind, message, titles, now, changed) {
  const text = String(message ?? '');
  const won = achievedGoal(mind, text, titles, changed);
  if (won) {
    const { g, clause } = won;
    const clip = text.replace(/\s+/g, ' ').trim().slice(0, 160);
    g.history.push({ status: g.status, at: now, reason: `achieved by the user: ${clip}` });
    g.status = GOAL_STATUS.COMPLETED;
    g.progress = 1;
    g.achievedBy = { text: clip, clause: clause.slice(0, 160), at: now, when: whenSaid(clause) };
    g.updatedAt = now;
    pushTimeline(mind, createTimelineEvent({ kind: 'goal_completed', subject: g.title, importance: 7 }));
    if (!changed.includes(g)) changed.push(g);
    return;
  }
  const tr = transitionOf(text);
  if (!tr.marked) return;
  const g = goalTheMessageIsAbout(mind, text);
  // A goal this very message stated is being set, not updated.
  if (!g || (changed.includes(g) && titles.some(t => goalSimilarity(t, g.title) >= MATCH_THRESHOLD))) return;
  const clip = text.replace(/\s+/g, ' ').trim().slice(0, 160);
  // Read only the part of the message about this goal: in "Shipping slips to
  // April 20, and Boxwell is out", "is out" ends Boxwell, not the shipping.
  const about = partAbout(text, g.title);
  // "I might switch my goal to…", "if the knee heals I'll…": considered, not done.
  if (speculative(about)) return;
  const kind = closeKind(about);
  if (kind) {
    const status = kind === 'resolved' ? GOAL_STATUS.COMPLETED : GOAL_STATUS.ABANDONED;
    if (g.status === status) return;
    g.history.push({ status: g.status, at: now, reason: `${kind} by the user: ${clip}` });
    g.status = status;
    if (status === GOAL_STATUS.COMPLETED) g.progress = 1;
    g.updatedAt = now;
    pushTimeline(mind, createTimelineEvent({ kind: status === GOAL_STATUS.COMPLETED ? 'goal_completed' : 'goal_abandoned', subject: g.title, importance: 7 }));
    if (!changed.includes(g)) changed.push(g);
    return;
  }
  const aboutTr = transitionOf(about);
  if (!(aboutTr.changes || aboutTr.corrects)) return;
  if (!GOAL_CHANGE_RE.test(about) && !reschedules(about, g.title)) return;
  g.history.push({ status: g.status, at: now, reason: `changed by the user: ${clip}` });
  g.changedBy = { text: clip, at: now };
  g.updatedAt = now;
  g.lastMentionedAt = now;
  if (!changed.includes(g)) changed.push(g);
}

export function getActiveGoals(mind, limit = 5) {
  return Object.values(mind.goals)
    .filter(g => g.status === GOAL_STATUS.ACTIVE || g.status === GOAL_STATUS.BLOCKED)
    .sort((a, b) => (b.priority - a.priority) || (b.lastMentionedAt - a.lastMentionedAt))
    .slice(0, limit);
}
