/**
 * AQUA — the welcome line: what is most worth acknowledging about this
 * person's world RIGHT NOW (2026-10-10).
 *
 * WHY THIS EXISTS
 * ---------------
 * The home screen used to say "You're in the middle of ${title}." where title
 * was the highest-`priority` legacy Mind goal. Mind goals are regex captures
 * created at priority 5, so "highest priority" was effectively arbitrary, the
 * title was pasted raw ("You're in the middle of become a billionaire within a
 * year"), and nothing checked whether that goal had been completed, corrected
 * or replaced. A sentence about a person built from their stalest datum.
 *
 * WHAT THIS DOES INSTEAD
 * ----------------------
 * Pure and deterministic: (one owner's canonical claims, legacy goals, now)
 * → one sentence plus the evidence it rests on. No model call, no write.
 *
 *   1. ELIGIBILITY  only CURRENT claims count: state active/trusted, asserted,
 *                   not machine-inferred, not disputed, not low-confidence.
 *                   Superseded claims are read ONLY to notice a change.
 *   2. LIFECYCLE    a blocker counts only while nothing newer resolves it
 *                   (proactive/triggers.js `blockersOf`, reused); a goal or
 *                   task counts only while nothing newer says it is done,
 *                   dropped or rejected.
 *   3. CANDIDATES   developments (deadline at risk, unblocked, completed,
 *                   changed focus, recent decision) outrank standing state
 *                   (blocker, goal, task, project). Within a kind, the
 *                   better-evidenced and more corroborated claim wins — not
 *                   merely the newest.
 *   4. PHRASING     fixed templates whose only variable parts are the user's
 *                   own words (entity labels / claim literals). Grounding is
 *                   then checked token-by-token (isGrounded) before a line is
 *                   returned; a line that fails is skipped, never patched.
 *   5. FALLBACK     legacy Mind goals only fill the gap when the canonical
 *                   model has nothing eligible (the 'authoritative' read rule
 *                   in brain/index.js), and only when the canonical model does
 *                   not contradict them. Nothing eligible → an honest
 *                   invitation, never a filler "insight".
 *
 * Stable by construction: identical inputs give an identical line. The only
 * clock-driven change is a development aging out of its window — which is a
 * change in what is true ("recently finished"), not a rotation.
 */
import crypto from 'node:crypto';
import { blockersOf, detectTriggers, isEvidence, HORIZON_DAYS } from '../proactive/triggers.js';
/** A claim that WAS true and is now history (superseded asserted fact) — for "was it…?" questions only. */
const wasTrue = c => Boolean(c) && c.state === 'superseded' && (c.polarity ?? 'asserted') === 'asserted' && (c.modality ?? 'fact') === 'fact';

export const SELECTOR_VERSION = 'welcome-v1';

/** A development is "recent" for this long after it was said. */
export const DEVELOPMENT_WINDOW_DAYS = 14;
/** Below this derived confidence a claim is not stated back to the user. */
export const MIN_CONFIDENCE = 0.45;
/** A phrase longer than this does not fit under the heading — choose another. */
const MAX_PHRASE = 70;
/** Claims extracted from one user turn are asserted within this of each other. */
const SAME_TURN_MS = 2 * 60_000;

const DAY = 86_400_000;
const CURRENT = new Set(['active', 'trusted']);
const INFERRED = /infer|pattern|reflection/i;
const DONE_STATUS = /\b(done|finished|complete(?:d)?|shipped|launched|released|resolved|fixed|closed|delivered|live|merged|signed)\b/i;
const DROPPED_STATUS = /\b(cancel(?:l)?ed|abandoned|dropped|scrapped|shelved|killed|no longer)\b/i;
const BLOCKED_STATUS = /\b(blocked|stuck|waiting (?:on|for)|on hold|delayed|held up)\b/i;

/**
 * Not for a greeting, even when true. A welcome line is read over a shoulder;
 * health, money, relationships and beliefs are not what it should lead with.
 * Wealth aspirations are here on purpose — the line this replaces announced
 * one on every visit.
 */
const SENSITIVE = /\b(billionaire|millionaire|rich|wealth\w*|net worth|salary|debt|loan|bankrupt\w*|diagnos\w*|therap\w*|depress\w*|anxiety|cancer|pregnan\w*|divorce\w*|break ?up|lawsuit|sued|medication|illness|disease|surgery|religio\w*|sexual\w*|lose weight|weight loss|rehab|addict\w*|grief|funeral)\b/i;

// Base rank per kind. Developments first, standing state after. Confidence
// and corroboration add at most 0.1, so they order within a kind and can only
// break near-ties across kinds — a well-evidenced goal does not bury a
// deadline that is at risk.
const BASE = Object.freeze({
  deadline_at_risk: 1.0,
  unblocked: 0.92,
  completed: 0.9,
  focus_changed: 0.88,
  deadline_approaching: 0.8,
  blocked: 0.78,
  decision: 0.7,
  open_decision: 0.68,
  goal: 0.66,
  task: 0.62,
  project: 0.55,
  completed_elsewhere: 0.6,
  legacy_goal: 0.45,
});

/* ── Text helpers ─────────────────────────────────────────────────────────── */

const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim().replace(/[.!?;:,]+$/, '');
const ts = c => new Date(c?.assertedAt ?? 0).getTime();
const confOf = c => Number(c?.confidence?.derived ?? c?.confidence ?? 0.5);
const objectText = c => clean(c?.object?.label ?? c?.object?.value ?? c?.object?.literal ?? c?.object?.entity ?? '');
const objectId = c => c?.object?.entityId ?? null;

const STOP = new Set(('a an the my our your their his her its this that these those to of in on at for with from by and or '
  + 'but is are be it i we you me us them as into over about up out new next').split(' '));
export const contentTokens = s => String(s ?? '').toLowerCase().normalize('NFKC')
  .split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 1 && !STOP.has(t));

/** Speaker-relative words in a copied literal are re-anchored to the reader. */
function secondPerson(s) {
  return s.replace(/\b(my|our)\b/gi, 'your').replace(/\b(mine|ours)\b/gi, 'yours')
    .replace(/\bmyself\b/gi, 'yourself').replace(/\b(me|us)\b/gi, 'you').replace(/\bI\b/g, 'you');
}

const DETERMINER = /^(the|a|an|your|my|our|this|that|these|those|his|her|their)\s/i;
function isProper(s) {
  const words = s.split(' ').filter(w => /\p{L}/u.test(w));
  return words.length > 0 && words.every(w => /^\p{Lu}/u.test(w));
}
/** A noun phrase readable mid-sentence: "payment integration" → "the payment integration". */
function nounPhrase(s, det = 'the') {
  const t = secondPerson(clean(s));
  if (!t) return '';
  if (DETERMINER.test(t) || isProper(t)) return t;
  return det ? `${det} ${t}` : t;
}
const capFirst = s => (/^\p{Ll}\p{Lu}/u.test(s) ? s : s.charAt(0).toUpperCase() + s.slice(1));

/**
 * Head verbs of goal/task phrases ("hire a designer", "finish the migration"),
 * mapped to their -ing form. A list, not morphology: the phrase is the user's
 * own words, and a frame that mis-conjugates them would put words in their
 * mouth. An unlisted head verb falls back to the regular rule only for the
 * verb-forming suffixes below; anything else is treated as a noun phrase.
 */
const DOUBLED = new Set(['get', 'ship', 'plan', 'cut', 'run', 'stop', 'set', 'hit', 'put', 'begin', 'win', 'drop', 'swap', 'map', 'scrap', 'chat', 'jog', 'quit', 'submit', 'commit', 'admit', 'spin']);
const VERBS = new Set([
  'add', 'apply', 'automate', 'be', 'become', 'begin', 'build', 'buy', 'change', 'chat', 'clean', 'close', 'commit',
  'complete', 'convert', 'create', 'cut', 'debug', 'decide', 'define', 'deliver', 'deploy', 'design', 'develop',
  'do', 'document', 'drop', 'earn', 'expand', 'finalize', 'finalise', 'find', 'finish', 'fix', 'get', 'grow',
  'help', 'hire', 'hit', 'implement', 'improve', 'integrate', 'invest', 'join', 'keep', 'land', 'launch', 'lead',
  'learn', 'make', 'map', 'master', 'meet', 'merge', 'migrate', 'move', 'open', 'optimize', 'optimise', 'organize',
  'organise', 'own', 'pass', 'pay', 'pick', 'plan', 'polish', 'practice', 'practise', 'prepare', 'present', 'publish',
  'put', 'quit', 'raise', 'reach', 'read', 'rebuild', 'redesign', 'reduce', 'refactor', 'release', 'remove',
  'replace', 'rewrite', 'run', 'save', 'scale', 'secure', 'sell', 'send', 'set', 'settle', 'ship', 'sign', 'simplify',
  'sort', 'speed', 'start', 'stop', 'study', 'submit', 'switch', 'take', 'teach', 'test', 'train', 'travel', 'try',
  'turn', 'understand', 'update', 'upgrade', 'validate', 'win', 'work', 'write',
]);
const VERB_SUFFIX = /(?:ize|ise|ify|ate)$/;

function ingForm(v) {
  if (v === 'be') return 'being';
  if (v.endsWith('ie')) return `${v.slice(0, -2)}ying`;
  if (DOUBLED.has(v)) return `${v}${v.slice(-1)}ing`;
  if (v.endsWith('e') && !v.endsWith('ee') && v !== 'be') return `${v.slice(0, -1)}ing`;
  return `${v}ing`;
}

/** "finish the migration" → "finishing the migration"; null when it is not a verb phrase. */
export function gerundPhrase(s) {
  const t = secondPerson(clean(s));
  const [head, ...rest] = t.split(' ');
  const h = String(head ?? '').toLowerCase();
  if (!h || (!VERBS.has(h) && !VERB_SUFFIX.test(h))) return null;
  return [ingForm(h), ...rest].join(' ');
}

/** The thing a goal/task is about, phrased for "toward …" / "back to …". */
function aimPhrase(s) {
  return gerundPhrase(s) ?? nounPhrase(s);
}

function when(daysLeft, date) {
  if (daysLeft <= 0) return 'today';
  if (daysLeft === 1) return 'tomorrow';
  if (daysLeft <= 6) return `in ${daysLeft} days`;
  return `on ${date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })}`;
}

/* ── Eligibility and lifecycle ────────────────────────────────────────────── */

/** A current, asserted, user-stated, sufficiently confident claim. */
function eligible(c, { modalities = ['fact'] } = {}) {
  return Boolean(c) && CURRENT.has(c.state) && !c.validTo
    && (c.polarity ?? 'asserted') === 'asserted'
    && modalities.includes(c.modality ?? 'fact')
    && !INFERRED.test(String(c.extractor ?? ''))
    && confOf(c) >= MIN_CONFIDENCE;
}

/**
 * Is the aim of `claim` (a goal or task phrase) closed by something NEWER?
 *   - a current status on a thing the phrase names says done / dropped
 *   - the user later negated the same plan or task
 *   - the user later rejected something the phrase names
 * Matching is by content words: "finish the migration" is closed by
 * "migration → done". Conservative in the direction that matters — an aim
 * whose closure cannot be matched stays a candidate only while it is current
 * in the canonical model itself.
 */
function closedBy(claim, claims, text = objectText(claim)) {
  const aim = new Set(contentTokens(text));
  if (!aim.size) return null;
  const t = ts(claim);
  const covers = label => {
    const toks = contentTokens(label);
    return toks.length > 0 && toks.every(x => aim.has(x));
  };
  for (const c of claims) {
    if (c.claimId === claim.claimId || !CURRENT.has(c.state) || ts(c) < t) continue;
    const pol = c.polarity ?? 'asserted';
    if (c.predicate === 'has_status' && pol === 'asserted' && covers(c.subject)
      && (DONE_STATUS.test(objectText(c)) || DROPPED_STATUS.test(objectText(c)))) return c;
    if (pol === 'negated' && c.predicate === claim.predicate && c.subjectEntityId === claim.subjectEntityId
      && covers(objectText(c))) return c;
    if (c.predicate === 'rejected' && pol === 'asserted' && covers(objectText(c))) return c;
  }
  return null;
}

const usable = s => Boolean(s) && s.length <= MAX_PHRASE && !SENSITIVE.test(s);

const CLAUSE_WORD = /\b(is|are|was|were|will|would|should|can|could|has|have|had|owns|does|did)\b/i;
/** A short object that reads as a thing: "Postgres", "pricing tiers". */
const isShortNoun = s => {
  const t = clean(s);
  return Boolean(t) && t.split(' ').length <= 3 && !CLAUSE_WORD.test(t);
};

export const OPEN_DECISION_WINDOW_DAYS = 30;
/**
 * "We haven't decided on X" is open while nothing NEWER records a decision
 * about X, and while it is recent enough to still be on the user's mind.
 */
function isOpenDecision(c, claims, now) {
  if (!c.subjectIsSelf || !CURRENT.has(c.state) || (c.polarity ?? 'asserted') !== 'negated'
    || (c.modality ?? 'fact') !== 'fact' || INFERRED.test(String(c.extractor ?? '')) || confOf(c) < MIN_CONFIDENCE) return false;
  if (ts(c) < new Date(now).getTime() - OPEN_DECISION_WINDOW_DAYS * DAY) return false;
  const topic = contentTokens(objectText(c));
  if (!topic.length) return false;
  return !claims.some(d => d.claimId !== c.claimId && CURRENT.has(d.state) && ts(d) >= ts(c)
    && (d.polarity ?? 'asserted') === 'asserted' && (d.predicate === 'decided' || d.predicate === 'rejected')
    && topic.some(w => contentTokens(objectText(d)).includes(w)));
}

/* ── Candidate builders ───────────────────────────────────────────────────── */

function candidate(kind, text, evidence, { strength = 0.5, at = 0, subject = null, rank = kind } = {}) {
  return {
    kind, text, subject,
    evidence: evidence.filter(Boolean).map(e => (typeof e === 'string' ? { source: 'claim', id: e } : e)),
    score: BASE[rank] + 0.1 * Math.max(0, Math.min(1, strength)),
    at,
  };
}

/** Strength of a standing claim: its confidence, lifted by restatement. */
const strengthOf = c => Math.min(1, confOf(c) * (1 + 0.15 * Math.log1p(Math.max(0, Number(c.evidenceCount ?? 1) - 1))));

function deadlineCandidates(claims, now) {
  const out = [];
  for (const t of detectTriggers(claims, now)) {
    if (t.type !== 'deadline_at_risk' && t.type !== 'deadline_approaching') continue;
    if (t.daysLeft == null || t.daysLeft < 0 || t.daysLeft > HORIZON_DAYS) continue;
    if (t.type === 'deadline_approaching' && t.daysLeft > 7) continue;
    const thing = nounPhrase(t.subjectLabel);
    if (!usable(thing)) continue;
    const date = new Date(`${t.deadline.date}T00:00:00Z`);
    const due = `${capFirst(thing)} is due ${when(t.daysLeft, date)}`;
    if (t.type === 'deadline_approaching') {
      out.push(candidate('deadline_approaching', `${due} — let's make sure it's on track.`, t.evidenceClaimIds,
        { strength: 1 - t.daysLeft / 7, subject: t.subjectLabel }));
      continue;
    }
    const b = t.blockers[0];
    const blocker = b.status ? clean(b.label) : nounPhrase(b.label);
    if (!usable(blocker)) continue;
    const text = b.status
      ? `${due} and is still ${blocker}.`
      : `${due}, and ${blocker} is still in the way.`;
    out.push(candidate('deadline_at_risk', text, t.evidenceClaimIds, { strength: 1 - t.daysLeft / HORIZON_DAYS, subject: t.subjectLabel }));
  }
  return out;
}

/** Things the user is working toward or on, by entity id and by words. */
function selfWorld(claims) {
  const ids = new Set();
  const words = new Set();
  for (const c of claims) {
    if (!c.subjectIsSelf || !CURRENT.has(c.state)) continue;
    if (!['builds', 'owns', 'task_owner', 'plans_to', 'member_of', 'manages'].includes(c.predicate)) continue;
    if (objectId(c)) ids.add(objectId(c));
    for (const w of contentTokens(objectText(c))) words.add(w);
  }
  return {
    has: (entityId, label) => (entityId && ids.has(entityId))
      || (contentTokens(label).length > 0 && contentTokens(label).every(w => words.has(w))),
  };
}

function blockerCandidates(claims, now, mine) {
  const out = [];
  const windowStart = new Date(now).getTime() - DEVELOPMENT_WINDOW_DAYS * DAY;
  // Everything something is (or was) blocking: subjects of blocked_by /
  // blocked statuses, objects of blocks.
  const things = new Map();
  for (const c of claims) {
    if (c.predicate === 'blocks' && objectId(c)) things.set(objectId(c), c.object.label ?? null);
    // "I'm blocked" is about the person, not a piece of their work — not a
    // welcome line ("You is blocked"), and not a fact to announce on entry.
    if (c.subjectIsSelf) continue;
    if ((c.predicate === 'blocked_by' || c.predicate === 'has_status') && c.subjectEntityId) {
      if (c.predicate === 'blocked_by' || BLOCKED_STATUS.test(objectText(c))) things.set(c.subjectEntityId, c.subject);
    }
  }
  for (const [eid, label] of things) {
    if (!label) continue;
    const selfIds = new Set(claims.filter(c => c.subjectIsSelf).map(c => c.subjectEntityId));
    // The person as the blocker ("I'm holding up the release") is not
    // something to greet them with.
    const current = blockersOf(eid, claims).filter(b => !b.entityId || !selfIds.has(b.entityId));
    const related = mine.has(eid, label) ? 1 : 0.6;
    if (current.length) {
      const b = current[0];
      const thing = nounPhrase(label);
      const text = b.status
        ? `${capFirst(thing)} is ${clean(b.label)} — let's see what it needs to move.`
        : `Let's get ${nounPhrase(b.label)} out of the way of ${thing}.`;
      if (!usable(thing) || !usable(b.status ? clean(b.label) : nounPhrase(b.label))) continue;
      const bc = claims.find(c => c.claimId === b.claimId);
      out.push(candidate('blocked', text, [b.claimId], { strength: related * strengthOf(bc ?? {}), at: ts(bc), subject: label }));
      continue;
    }
    // Nothing blocks it now. Was it blocked, and was the blocker resolved recently?
    const resolution = claims
      .filter(c => isEvidence(c) && !c.subjectIsSelf && c.predicate === 'has_status' && DONE_STATUS.test(objectText(c)) && ts(c) >= windowStart)
      .map(res => {
        // "Was it blocked?" reads HISTORY: since 2026-10-11 S8 retires a
        // resolved blocker (superseded), which is exactly the evidence here.
        const was = claims.find(c => (isEvidence(c) || wasTrue(c)) && ts(c) <= ts(res) && (
          (c.predicate === 'blocks' && c.subjectEntityId === res.subjectEntityId && objectId(c) === eid)
          || (c.predicate === 'blocked_by' && c.subjectEntityId === eid && objectId(c) === res.subjectEntityId)));
        return was ? { res, was } : null;
      })
      .filter(Boolean)
      .sort((a, b) => ts(b.res) - ts(a.res))[0];
    if (!resolution) continue;
    const blocker = nounPhrase(resolution.res.subject);
    const thing = nounPhrase(label);
    if (!usable(blocker) || !usable(thing)) continue;
    out.push(candidate('unblocked', `With ${blocker} sorted, ${thing} can move forward again.`,
      [resolution.res.claimId, resolution.was.claimId], { strength: related, at: ts(resolution.res), subject: label }));
  }
  return out;
}

function completionCandidates(claims, now, mine, blockerIds) {
  const windowStart = new Date(now).getTime() - DEVELOPMENT_WINDOW_DAYS * DAY;
  const out = [];
  const latestStatus = new Map();
  for (const c of claims) {
    if (!isEvidence(c) || c.predicate !== 'has_status' || c.subjectIsSelf) continue;
    const prev = latestStatus.get(c.subjectEntityId);
    if (!prev || ts(c) > ts(prev)) latestStatus.set(c.subjectEntityId, c);
  }
  for (const c of latestStatus.values()) {
    if (ts(c) < windowStart || !DONE_STATUS.test(objectText(c))) continue;
    // A resolved BLOCKER is reported as "unblocked" on the thing it held up.
    if (blockerIds.has(c.subjectEntityId)) continue;
    const thing = nounPhrase(c.subject);
    if (!usable(thing)) continue;
    // Something finishing that is not part of the user's own work ("Sam
    // finished the billing refactor") is news, but not ahead of their goals.
    const related = mine.has(c.subjectEntityId, c.subject);
    // The user's own word for it ("live", "signed", "finished"), not ours.
    const status = clean(objectText(c));
    const said = status.split(' ').length <= 3 && !SENSITIVE.test(status) ? status : 'done';
    out.push(candidate('completed', `${capFirst(thing)} is ${said} — what's next?`, [c.claimId],
      { strength: strengthOf(c), at: ts(c), subject: c.subject, rank: related ? 'completed' : 'completed_elsewhere' }));
  }
  return out;
}

function intentCandidates(claims, now) {
  const windowStart = new Date(now).getTime() - DEVELOPMENT_WINDOW_DAYS * DAY;
  const byId = new Map(claims.map(c => [c.claimId, c]));
  const out = [];
  const shifted = new Set();

  // A plan the user REPLACED recently: the old one is superseded and points at
  // its successor. Acknowledge the new direction (never the old one).
  for (const old of claims) {
    if (old.state !== 'superseded' || old.predicate !== 'plans_to' || !old.subjectIsSelf || !old.supersededBy) continue;
    const next = byId.get(old.supersededBy);
    if (!next || !eligible(next, { modalities: ['intent', 'fact'] }) || next.predicate !== 'plans_to') continue;
    if (ts(next) < windowStart || closedBy(next, claims)) continue;
    const aim = aimPhrase(objectText(next));
    if (!usable(aim)) continue;
    shifted.add(next.claimId);
    out.push(candidate('focus_changed', `Your focus has moved to ${aim} — let's build on that.`, [next.claimId, old.claimId],
      { strength: strengthOf(next), at: ts(next), subject: objectText(next) }));
  }

  // The same change as the store records it TODAY for intents: the contradiction
  // worker retires only fact snapshots, so "now X, not Y" leaves Y active
  // beside its negated twin. A new plan stated in the same turn as the
  // negation of an older one is the user's own statement of a shift.
  for (const neg of claims) {
    if (neg.predicate !== 'plans_to' || !neg.subjectIsSelf || (neg.polarity ?? 'asserted') !== 'negated'
      || !CURRENT.has(neg.state) || ts(neg) < windowStart) continue;
    const old = claims.find(o => o.predicate === 'plans_to' && o.subjectIsSelf && o.claimId !== neg.claimId
      && (o.polarity ?? 'asserted') === 'asserted' && ts(o) < ts(neg) && closedBy(o, claims)?.claimId === neg.claimId);
    const next = claims.find(n => n.predicate === 'plans_to' && n.subjectIsSelf && !shifted.has(n.claimId)
      && eligible(n, { modalities: ['intent', 'fact'] }) && Math.abs(ts(n) - ts(neg)) <= SAME_TURN_MS && !closedBy(n, claims));
    if (!old || !next) continue;
    const aim = aimPhrase(objectText(next));
    if (!usable(aim)) continue;
    shifted.add(next.claimId);
    out.push(candidate('focus_changed', `Your focus has moved to ${aim} — let's build on that.`, [next.claimId, neg.claimId, old.claimId],
      { strength: strengthOf(next), at: ts(next), subject: objectText(next) }));
  }

  for (const c of claims) {
    if (!c.subjectIsSelf) continue;
    if (c.predicate === 'plans_to' && eligible(c, { modalities: ['intent', 'fact'] }) && !shifted.has(c.claimId)) {
      if (closedBy(c, claims)) continue;
      const aim = aimPhrase(objectText(c));
      if (!usable(aim)) continue;
      out.push(candidate('goal', `Let's keep working toward ${aim}.`, [c.claimId],
        { strength: strengthOf(c), at: ts(c), subject: objectText(c) }));
    } else if (c.predicate === 'task_owner' && eligible(c, { modalities: ['intent', 'fact'] })) {
      if (closedBy(c, claims)) continue;
      const aim = aimPhrase(objectText(c));
      if (!usable(aim)) continue;
      out.push(candidate('task', `Ready to get back to ${aim}?`, [c.claimId],
        { strength: strengthOf(c), at: ts(c), subject: objectText(c) }));
    } else if (c.predicate === 'decided' && eligible(c) && ts(c) >= windowStart) {
      const what = objectText(c);
      const vp = gerundPhrase(what) ? secondPerson(what) : null;
      // A decision recorded as a clause ("Priya owns onboarding") is not a
      // noun phrase; framing it as one would misquote the user.
      if (!vp && !isShortNoun(what)) continue;
      const text = vp ? `You've decided to ${vp} — let's work out what follows.` : `You've settled on ${nounPhrase(what, '')} — let's build on that.`;
      if (!usable(vp ?? nounPhrase(what, ''))) continue;
      out.push(candidate('decision', text, [c.claimId], { strength: strengthOf(c), at: ts(c), subject: what }));
    } else if (c.predicate === 'decided' && isOpenDecision(c, claims, now)) {
      // "We haven't decided on pricing" — ongoing thinking, while nothing
      // newer records the decision as made.
      const what = objectText(c);
      if (!isShortNoun(what) && !gerundPhrase(what)) continue;
      const topic = gerundPhrase(what) ?? nounPhrase(what, '');
      if (!usable(topic)) continue;
      out.push(candidate('open_decision', `You haven't settled on ${topic} yet — want to think it through?`,
        [c.claimId], { strength: strengthOf(c), at: ts(c), subject: what }));
    } else if (c.predicate === 'builds' && eligible(c)) {
      const what = objectText(c);
      if (closedBy(c, claims)) continue;
      // "We're building an AI operating system" → "your AI operating system".
      const thing = nounPhrase(what.replace(/^(a|an)\s+/i, ''), 'your');
      if (!usable(thing)) continue;
      out.push(candidate('project', `Let's keep building ${thing}.`, [c.claimId],
        { strength: strengthOf(c), at: ts(c), subject: what }));
    }
  }
  return out;
}

/* ── Legacy fallback ──────────────────────────────────────────────────────── */

/**
 * A legacy Mind goal is a regex capture, so it must clear a higher bar than a
 * canonical claim: restated, or confirmed by the user, and not contradicted by
 * anything the canonical model knows (a later negation, rejection or "done").
 */
function legacyCandidates(goals, claims) {
  const out = [];
  for (const g of Array.isArray(goals) ? goals : []) {
    if (g?.status !== 'active' && g?.status !== 'blocked') continue;
    const established = Number(g.mentions ?? 0) >= 2 || g.privacy?.source === 'user' || Number(g.confidence ?? 0) >= 0.65;
    if (!established) continue;
    const pseudo = { claimId: `mind:${g.id}`, predicate: 'plans_to', subjectEntityId: null, assertedAt: new Date(0) };
    const title = clean(g.title);
    if (closedBy(pseudo, claims, title)) continue;
    if (claims.some(c => c.predicate === 'plans_to' && (c.state === 'superseded' || (c.polarity ?? 'asserted') === 'negated')
      && contentTokens(objectText(c)).length && contentTokens(objectText(c)).every(w => contentTokens(title).includes(w)))) continue;
    const aim = aimPhrase(title);
    if (!usable(aim)) continue;
    const strength = Math.min(1, (Number(g.priority ?? 5) / 10) * 0.6 + Math.min(1, Number(g.mentions ?? 1) / 5) * 0.4);
    out.push({ ...candidate('legacy_goal', `Let's keep working toward ${aim}.`, [{ source: 'mind_goal', id: String(g.id) }],
      { strength, at: Number(g.lastMentionedAt ?? 0), subject: title }) });
  }
  return out;
}

/* ── Grounding ────────────────────────────────────────────────────────────── */

// Every word a template contributes. Anything else in a line must come from
// the evidence it cites.
const FRAME_WORDS = new Set(contentTokens(`
  let's lets keep working toward ready get back to you've youve decided work out what follows settled on build building
  that your focus has moved with sorted can move forward again done what's whats next is due today tomorrow in days
  and still the way let's through it make sure it's its on track see needs out of haven't haven yet want think
  january february march april may june july august september october november december
`));

/**
 * True when every content word of `text` is a frame word or comes from the
 * cited evidence (allowing the -ing form of an evidence verb and the
 * first→second person re-anchoring). This is the check that makes "no
 * invented facts" a property of the output, not of the author's care.
 */
export function isGrounded(text, evidenceTexts = []) {
  const allowed = new Set(FRAME_WORDS);
  for (const e of evidenceTexts) {
    for (const w of contentTokens(secondPerson(String(e ?? '')))) {
      allowed.add(w);
      const g = gerundPhrase(w);
      if (g) allowed.add(g);
    }
  }
  return contentTokens(text).every(w => allowed.has(w) || /^\d+$/.test(w));
}

function evidenceTexts(cand, claims, goals) {
  const byId = new Map(claims.map(c => [c.claimId, c]));
  const out = [];
  for (const e of cand.evidence) {
    if (e.source === 'mind_goal') {
      const g = (goals ?? []).find(x => String(x.id) === e.id);
      if (g) out.push(g.title);
      continue;
    }
    const c = byId.get(e.id);
    if (!c) continue;
    out.push(c.subject, objectText(c));
  }
  return out;
}

/* ── Selection ────────────────────────────────────────────────────────────── */

const hash = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

/**
 * The version of the inputs the line was chosen from. Same world → same
 * version → the client keeps what it shows. Any claim that enters, leaves or
 * changes state, or a legacy goal that changes status, moves it.
 */
export function worldVersion(claims = [], goals = []) {
  return hash([
    SELECTOR_VERSION,
    claims.map(c => [c.claimId, c.state, c.polarity, String(c.updatedAt ?? c.assertedAt ?? ''), c.supersededBy ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    (goals ?? []).map(g => [g.id, g.status, g.mentions, g.priority, g.title]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]);
}

export const INVITE_NEW = 'AQUA reads what you give it once, remembers what matters, and carries it into every conversation after.';
export const INVITE_RETURNING = "Tell me what you're focused on right now, and I'll keep it in mind from here.";
export const UNAVAILABLE = 'Pick up a thread below, or start something new.';

/**
 * @param {object}   input
 * @param {object[]} input.claims       ONE owner's canonical claims (read-model shape + subjectIsSelf, evidenceCount)
 * @param {object[]} [input.legacyGoals] that owner's legacy Mind goals (fallback only)
 * @param {boolean}  [input.history]     the user has conversations (chooses the invitation wording only)
 * @param {boolean}  [input.unavailable] the world model could not be read
 * @param {Date|number} [input.now]
 */
export function selectWelcome({ claims = [], legacyGoals = [], history = false, unavailable = false, now = Date.now() } = {}) {
  const list = Array.isArray(claims) ? claims : [];
  const version = worldVersion(list, legacyGoals);
  const envelope = (fields) => ({
    ...fields,
    worldVersion: version,
    messageId: hash([fields.kind, fields.text, fields.evidence.map(e => e.id)]),
    selector: SELECTOR_VERSION,
  });

  if (unavailable) {
    return envelope({ text: history ? UNAVAILABLE : INVITE_NEW, kind: 'unavailable', basis: 'unavailable', established: false, evidence: [] });
  }

  const mine = selfWorld(list);
  const blockerIds = new Set(list.filter(c => c.predicate === 'blocks').map(c => c.subjectEntityId)
    .concat(list.filter(c => c.predicate === 'blocked_by').map(objectId)).filter(Boolean));
  const canonical = [
    ...deadlineCandidates(list, now),
    ...blockerCandidates(list, now, mine),
    ...completionCandidates(list, now, mine, blockerIds),
    ...intentCandidates(list, now),
  ];
  const rank = (a, b) => (b.score - a.score) || (b.at - a.at) || a.text.localeCompare(b.text);

  const pick = (cands) => cands.sort(rank).find(c => isGrounded(c.text, evidenceTexts(c, list, legacyGoals)));
  const chosen = pick(canonical);
  if (chosen) {
    return envelope({ text: chosen.text, kind: chosen.kind, basis: 'world_model', established: true, evidence: chosen.evidence, subject: chosen.subject });
  }
  const legacy = pick(legacyCandidates(legacyGoals, list));
  if (legacy) {
    return envelope({ text: legacy.text, kind: legacy.kind, basis: 'legacy_goals', established: true, evidence: legacy.evidence, subject: legacy.subject });
  }
  return envelope({ text: history ? INVITE_RETURNING : INVITE_NEW, kind: 'invite', basis: 'none', established: false, evidence: [] });
}
