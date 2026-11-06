/**
 * One change, every store (2026-11-02).
 * ─────────────────────────────────────────────────────────────────────────────
 * One thing the user says about themselves is held in several places: the
 * legacy fact (which is also the identity card and profile), a Mind belief
 * (fact bridge, mind/observers.js FACT_TO_BELIEF), a Mind graph edge
 * (mind/relationshipGraph.js), and the sentence in the conversation evidence
 * lane (files/evidenceStore.js). Things the user said that NAME the value — a
 * goal "get promoted at Fintrail", a deadline for a Fintrail project — live in
 * Mind goals, working memory, legacy facts and evidence sentences too. Before
 * this module only the legacy fact changed when the user said "I now work at
 * Northbeam"; every other copy kept saying Fintrail.
 *
 * The fact store is the ONE source of a change. Each turn, memory/engine.js
 * compares the facts before and after the turn and records every change as a
 * TRANSITION on the fact itself (`fact.transitions`):
 *
 *   { id, key, from, to, kind, text, at, item?, fromSource, effective,
 *     provenance: { conversationId, requestId, source }, confidence }
 *
 *   id         stable: owner + key + from + to + the user's sentence. The same
 *              change processed twice has the same id and is recorded once.
 *   kind       changed | ended | corrected | resolved | … (the resolver's kind)
 *   to         the new value, or null when the fact or item ended
 *   effective  a date the user named in the sentence, else null (as said)
 *
 * Nothing new is inferred: a transition exists only where the fact store's
 * own value changed, and its text is the user's sentence.
 *
 * Propagation is RECONCILIATION, not a one-shot event. `reconcileMind` derives
 * what every Mind store should say from the facts' transitions and makes it so,
 * touching only what disagrees. It runs after every observed turn and after a
 * forget, so a step that failed, a process restart before the store flushed, or
 * the two-process merge (mind/mindStore.js mergeConcurrent) taking an older
 * copy is repaired on the next turn. Re-running it changes nothing.
 *
 *   Mind belief      holding the old value → the new value (old value to its
 *                    history), or archived when the fact ended
 *   Mind graph edge  self → old value: `endedAt` / `endedBy`; an edge to the
 *                    new value is created as updateGraph would have
 *   dependents       open goals, deadlines, blockers and other legacy facts
 *                    that NAME the old value (a proper name, whole word), were
 *                    said before the change, and do not name the new value:
 *                    `review` = { transitionId, text, at, value }. Never
 *                    completed, closed or deleted — rendered as "uncertain
 *                    whether still current — they said: …"
 *
 * A transition that is no longer live (the user went back to the old value,
 * or forgot the fact) releases everything it set: reviews are removed, ended
 * edges reopen only when the value is current again.
 *
 * The evidence lane is a separate file store; it is updated in the background
 * (`propagateToEvidence`) and each transition records `pic` when done. A failure
 * leaves the stamp unset and the next turn retries (bounded attempts). The two
 * stores are NOT written atomically together. In memory the evidence step reads
 * the transitions, so it can lag the Mind but not lead it; on disk each file
 * flushes on its own debounce, so after a crash inside that window either one
 * may be ahead (a lost Mind flush loses the whole turn's fact change with it).
 *
 * DEFAULT OFF (2026-11-06). Propagation records, reconciles and sweeps only when
 * AQUA_PROPAGATION is exactly "on" (case-insensitive). Unset, empty or anything
 * else: no transition is recorded, nothing is reconciled, the evidence lane is
 * not touched and the startup sweeper does not start (startPropagationSweeper,
 * sweepOnce). The one function here that still runs is forgetValueInMind: a
 * user-requested forget removing the forgotten value's copies from the Mind —
 * a privacy cleanup, not propagation.
 * AQUA_PROPAGATION_CRASH_AT is a TEST SEAM only (crash-recovery tests).
 */
import crypto from 'node:crypto';
import { peekMind, touchMind, deleteItem, flushMind, listOwners } from '../mind/mindStore.js';
import { createTimelineEvent } from '../mind/mindSchema.js';
import { pushTimeline } from '../mind/timeline.js';
import { goalSimilarity } from '../mind/goalText.js';
import { applyCurrentState } from './longTermMemory.js';
import { nodesByType } from '../reasoning/reasoningGraph.js';
import { backoffMs } from '../core/jobs/jobQueue.js';
import { beliefKey, GOAL_STATUS, STATUS } from '../mind/mindSchema.js';
import { FACT_TO_BELIEF } from '../mind/observers.js';
import { upsertNode, SELF_KEY } from '../mind/relationshipGraph.js';
import { createEdge } from '../mind/mindSchema.js';
import { corrects, datesIn } from '../understanding/stateTransition.js';

export function propagationEnabled() {
  return String(process.env.AQUA_PROPAGATION ?? '').trim().toLowerCase() === 'on';
}

const TRANSITIONS_PER_FACT = 10;      // longTermMemory.applyCurrentState keeps the same window
// Evidence-lane outbox: attempt N waits backoffMs(N) (core/jobs/jobQueue.js —
// the durable queue's own schedule, so one retry policy exists). After the
// last attempt the transition is dead-lettered: kept, reported, never retried.
const EVIDENCE_ATTEMPTS = 8;
const PLACE = { memory_page: 'Memory page', understanding_card: 'Understanding page', goal_sync: 'goal list' };
const OPEN_GOAL = new Set([GOAL_STATUS.ACTIVE, GOAL_STATUS.BLOCKED, GOAL_STATUS.STALE]);

// The graph relation a fact key projects to (mind/relationshipGraph.js updateGraph).
const GRAPH_OF = {
  workplace: ['organization', 'part_of'],
  spouse: ['person', 'related_to'],
  siblings: ['person', 'related_to'],
  cofounder: ['person', 'works_with'],
  project: ['project', 'works_on'],
  goal: ['goal', 'targets'],
};

const vnorm = v => String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.,;:!?]+$/, '');
const asText = v => (v && typeof v === 'object' ? (v.name ?? v.value ?? v.label ?? '') : v);
const listOf = v => (Array.isArray(v) ? v : v == null ? [] : [v]).map(asText).filter(x => typeof x === 'string' && x.trim());
const same = (a, b) => vnorm(asText(a)) === vnorm(asText(b));

/**
 * A value that identifies one thing by name — "Fintrail", "Priya Rao" — and so
 * can be looked for in other things the user said. "data analyst" or "dark
 * mode" are descriptions: a goal mentioning "analyst" is not about that fact.
 */
export function namedValue(v) {
  const s = String(asText(v) ?? '').trim();
  if (s.length < 3 || s.length > 60 || s.split(/\s+/).length > 5) return false;
  return /(?:^|\s)[A-Z][\w'&.-]*/.test(s) || /\b[A-Z]{2,}\b/.test(s);
}

/**
 * The names in a retired value that other statements would use: the value
 * itself, and for "Derek Shaw at Lone Star Bank" its leading name — the person
 * changed, not the bank, so only "Derek Shaw" is looked for.
 */
export function anchorsOf(value) {
  const s = String(asText(value) ?? '').trim();
  const lead = s.match(/^(\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+){0,3})\s+(?:at|of|from|with|in)\s+/u)?.[1];
  return [s, lead].filter(v => v && namedValue(v));
}

function wordRe(value) {
  const esc = String(asText(value)).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\w])${esc}(?![\\w])`, 'i');
}

export function transitionId(ownerId, key, from, to, text) {
  const h = crypto.createHash('sha1').update([ownerId, key, vnorm(asText(from)), vnorm(asText(to)), vnorm(text)].join('\u0000')).digest('hex');
  return `tr_${h.slice(0, 16)}`;
}

/** Values the fact holds as current now. */
function currentValues(f) {
  return f?.ended ? [] : listOf(f?.value);
}

/**
 * Taken out of the active memory on the Memory page (archive, merged into
 * another fact, split into parts). Not a statement that the world changed: the
 * Mind's copies follow it, nothing that names the value is flagged.
 */
const ARCHIVE_KINDS = new Set(['archived', 'merged', 'split']);

/**
 * A transition still describes the present: what it retired is not current
 * again. An archive holds while the fact stays archived (a restore releases it).
 */
export function isLive(f, t) {
  if (!f || !t?.id || t.kind === 'scoped') return false;
  if (ARCHIVE_KINDS.has(t.kind)) return f.status === 'archived';
  if (f.status === 'archived') return false;
  return !currentValues(f).some(v => same(v, t.from));
}

/** Every live transition across an owner's facts. */
function liveTransitions(mind) {
  const out = [];
  for (const f of Object.values(mind?.facts ?? {})) {
    for (const t of f?.transitions ?? []) if (isLive(f, t)) out.push({ f, t });
  }
  return out;
}

// ── 1. Record ────────────────────────────────────────────────────────────────
/**
 * Compare the facts before and after one turn and record each change as a
 * transition on the fact. `previous`: key → { value, sourceText, ended } as
 * memory/engine.js captured them before the turn. A fact that disappeared was
 * forgotten (not a change). A fact that is new was set, not changed.
 * @returns {object[]} the transitions recorded this turn
 */
export function recordTransitions(ownerId, previous, { text = '', turnStart = 0, conversationId = null, requestId = null, source = 'conversation', kind: kindOf = null } = {}) {
  if (!propagationEnabled()) return [];
  const mind = peekMind(ownerId);
  if (!mind?.facts || !previous) return [];
  const recorded = [];
  // Not said in a conversation: what the user did, in words the prompt can carry.
  const describe = (key, from, to, kind) => source === 'conversation' ? null
    : ARCHIVE_KINDS.has(kind) ? `they removed it from their active memory on the ${PLACE[source] ?? 'Memory page'} (${key.replace(/^custom_/, '').replace(/_/g, ' ')}: "${asText(from)}")`
      : `they changed it on the ${PLACE[source] ?? 'Memory page'}: ${key.replace(/^custom_/, '').replace(/_/g, ' ')} "${asText(from)}"${to == null ? ' removed' : ` → "${asText(to)}"`}`;
  for (const [key, before] of previous) {
    const f = mind.facts[key];
    if (!f || before?.ended) continue;
    const changes = [];
    if (before.status !== 'archived' && f.status === 'archived') {
      // Archive, merge, split: the value left the active memory, the world did not change.
      for (const item of listOf(before.value)) changes.push({ from: item, to: null, kind: kindOf ?? 'archived', text: describe(key, item, null, kindOf ?? 'archived'), item: Array.isArray(before.value) });
    } else if (before.status === 'archived') {
      continue;                     // a restore releases the archive; nothing new is recorded
    } else if (Array.isArray(before.value) || Array.isArray(f.value)) {
      const now = currentValues(f);
      for (const item of listOf(before.value)) {
        if (now.some(v => same(v, item))) continue;
        const r = (f.retiredItems ?? []).find(x => same(x.item, item) && (x.at ?? 0) >= turnStart);
        const kind = kindOf ?? r?.kind ?? 'ended';
        changes.push({ from: item, to: null, kind, text: describe(key, item, null, kind) ?? r?.text, item: true });
      }
    } else if (f.ended && (f.ended.at ?? 0) >= turnStart) {
      changes.push({ from: before.value, to: null, kind: f.ended.kind ?? 'ended', text: f.ended.text });
    } else if (!f.ended && !same(before.value, f.value)) {
      // The resolver's own record of this change (applyCurrentState), if any.
      const own = (f.transitions ?? []).find(t => !t.id && (t.at ?? 0) >= turnStart && same(t.from, before.value));
      const said = own?.text ?? f.sourceText ?? text;
      // A correction is the user's words saying the old value was wrong — not the
      // store's flag: step 4a stores a moved date with isCorrection only to skip
      // the confidence damping, and "pushed back to April 23" is a change.
      const kind = kindOf ?? own?.kind ?? (corrects(said) ? 'corrected' : 'changed');
      changes.push({ from: before.value, to: f.value, kind, text: describe(key, before.value, f.value, kind) ?? said, own });
    }
    for (const c of changes) {
      const said = String(c.text ?? text ?? '').slice(0, 200);
      const id = transitionId(ownerId, key, c.from, c.to, said);
      if ((f.transitions ?? []).some(t => t.id === id)) continue;          // the same change, seen again
      const at = c.own?.at ?? Date.now();
      const record = {
        id, key, from: c.from, to: c.to, kind: c.kind, text: said, at,
        ...(c.item ? { item: true } : {}),
        fromSource: String(before.sourceText ?? '').slice(0, 300),
        effective: source === 'conversation' ? (datesIn(said)[0] ?? null) : null,
        source,
        provenance: { conversationId, requestId, source: source === 'conversation' ? 'user_statement' : `user_edit:${source}` },
        confidence: f.confidence ?? null,
      };
      if (c.own) Object.assign(c.own, record);
      else {
        (f.transitions ??= []).push(record);
        if (f.transitions.length > TRANSITIONS_PER_FACT) f.transitions.splice(0, f.transitions.length - TRANSITIONS_PER_FACT);
      }
      recorded.push(record);
    }
  }
  if (recorded.length) touchMind(mind);
  return recorded;
}

// ── 2. Reconcile the Mind ────────────────────────────────────────────────────
let failAt = null;   // test seam: name of a stage that throws once (partial-failure tests)
export function _failOnceAt(stage) { failAt = stage; }
function checkpoint(stage) {
  if (failAt === stage) { failAt = null; throw new Error(`injected failure at ${stage}`); }
}

function reconcileBeliefs(mind, live, now) {
  let n = 0;
  for (const { f, t } of live) {
    const map = FACT_TO_BELIEF[f.key];
    const sig = map ? map({ key: f.key, value: f.value }) : null;
    const b = sig ? mind.beliefs?.[beliefKey(sig.dimension, sig.key)] : null;
    if (!b || b.privacy?.locked || b.status === STATUS.LOCKED) continue;
    // Already taken: an archived belief still holds the retired value, and must
    // not be versioned again on every pass.
    if (b.endedBy === t.id || (b.status === STATUS.ARCHIVED && same(b.value, t.from))) continue;
    const version = () => {
      (b.history ??= []).push({ value: b.value, confidence: b.confidence, supersededAt: t.at, reason: `transition:${t.kind}`, transitionId: t.id });
      if (b.history.length > 20) b.history.splice(0, b.history.length - 20);
    };
    if (Array.isArray(b.value)) {
      if (!b.value.some(v => same(v, t.from))) continue;
      version();
      b.value = b.value.filter(v => !same(v, t.from));
    } else if (same(b.value, t.from)) {
      version();
      const now1 = currentValues(f);
      if (!ARCHIVE_KINDS.has(t.kind) && !Array.isArray(f.value) && now1.length === 1) { b.value = f.value; b.status = STATUS.ACTIVE; b.supersededBy = t.id; }
      else { b.status = STATUS.ARCHIVED; b.endedBy = t.id; }
    } else continue;
    b.updatedAt = now;
    n++;
  }
  return n;
}

/** A belief archived by a change that no longer holds (restored, or the value is current again) is active again. */
function releaseBeliefs(mind, liveIds, now) {
  let n = 0;
  for (const b of Object.values(mind.beliefs ?? {})) {
    if (!b?.endedBy || liveIds.has(b.endedBy)) continue;
    const f = Object.values(mind.facts ?? {}).find(x => (x.transitions ?? []).some(t => t.id === b.endedBy));
    if (!f) continue;                          // forgotten: stays archived (forgetValueInMind removes it)
    if (f.status !== 'archived' && currentValues(f).some(v => same(v, b.value))) { b.status = STATUS.ACTIVE; }
    delete b.endedBy;
    b.updatedAt = now;
    n++;
  }
  return n;
}

function edgeKeyOf(nodeKey, rel) { return `${SELF_KEY}|${rel}|${nodeKey}`; }
function nodeKeyOf(type, label) { return `${type}:${String(type === 'goal' ? String(label).slice(0, 60) : label).toLowerCase().trim()}`; }

function reconcileGraph(mind, live, liveIds, now) {
  const g = mind.graph;
  if (!g?.nodes || !g?.edges) return 0;
  let n = 0;
  for (const { f, t } of live) {
    const rel = GRAPH_OF[f.key];
    if (!rel) continue;
    const old = g.edges[edgeKeyOf(nodeKeyOf(rel[0], asText(t.from)), rel[1])];
    if (old && !old.endedAt) { old.endedAt = t.at; old.endedBy = t.id; n++; }
    // The new value, as updateGraph links it when the extractor reports it.
    for (const v of currentValues(f)) {
      if (!t.to || !same(v, t.to) || !g.nodes[SELF_KEY]) continue;
      const nk = nodeKeyOf(rel[0], v);
      const node = g.nodes[nk] ?? upsertNode(mind, rel[0], rel[0] === 'goal' ? String(v).slice(0, 60) : v);
      const ek = edgeKeyOf(nk, rel[1]);
      if (node && !g.edges[ek]) {
        const e = createEdge({ from: SELF_KEY, to: nk, type: rel[1], note: `${f.key} fact` });
        e.key = ek; e.startedBy = t.id;
        g.edges[ek] = e; n++;
      }
    }
  }
  // An edge ended by a change that no longer holds (the value is current again) reopens.
  for (const e of Object.values(g.edges)) {
    if (!e?.endedBy || liveIds.has(e.endedBy)) continue;
    const owner = Object.values(mind.facts ?? {}).find(f => (f.transitions ?? []).some(t => t.id === e.endedBy));
    if (!owner) continue;                       // the fact was forgotten: the edge stays ended
    delete e.endedAt; delete e.endedBy; e.lastSeenAt = now; n++;
  }
  return n;
}

function flag(item, t) {
  if (item.review?.transitionId === t.id) return false;
  item.review = { transitionId: t.id, text: t.text, at: t.at, value: asText(t.from), source: t.source ?? 'conversation' };
  return true;
}

// Not affected by the change: what already happened ("I learned SQL at
// Fintrail" stays true after leaving it), and someone else's relation to the
// value ("My friend Sam works at Fintrail").
const PAST = /\b(?:was|were|had|did|used\s+to|learned|learnt|worked|studied|met|spent|left|joined|grew\s+up|born)\b/i;
const SOMEONE_ELSE = /\b(?:[Mm]y|[Oo]ur)\s+(?:friend|brother|sister|wife|husband|partner|colleague|cousin|dad|mom|mum|mother|father|son|daughter|boss|neighbou?r)\b|^\s*\p{Lu}\p{L}+(?:\s+\p{Lu}\p{L}+)?\s+(?:works|lives|studies)\s+(?:at|for|in)\b/u;

/**
 * Things the user said before the change that name what changed — by its name,
 * an alias or acronym of it (`anchors`, see anchorsFor), or a pronoun whose one
 * referent it was (`refersTo`, see notePronounReferents) — and not its
 * replacement.
 */
export function dependsOn(text, t, f, saidAt, { anchors = anchorsOf(t.from), refersTo = null } = {}) {
  if (typeof text !== 'string' || !(saidAt < t.at)) return false;
  const res = anchors.map(a => (/^\p{Lu}{3,}$/u.test(a) ? new RegExp(`(?<![\\w])${a}(?![\\w])`) : wordRe(a)));   // acronyms: case-sensitive
  const named = { test: x => res.some(re => re.test(x)) };
  const referred = (refersTo ?? []).some(r => anchors.some(a => same(a, r)));
  if (!named.test(text) && !referred) return false;
  if (currentValues(f).some(v => wordRe(v).test(text))) return false;
  if (t.text && vnorm(text) === vnorm(t.text)) return false;
  if (PAST.test(text)) return false;
  const other = text.match(SOMEONE_ELSE);
  if (other && !named.test(other[0])) return false;
  return true;
}

/**
 * Every name the retired value goes by, from what Aqua already holds — never
 * guessed:
 *   · the value and its leading name (anchorsOf);
 *   · its acronym, when the name has three or more words ("Lone Star Bank" →
 *     "LSB"; two-letter initials are too common to mean one thing);
 *   · the aliases the entity resolver merged into the same reasoning-graph
 *     entity (reasoning/entityResolver.js: mentions of one thing, e.g.
 *     "Fintrail" and "Fintrail Inc").
 * An alias that is also the new value is dropped.
 */
export function anchorsFor(ownerId, t, f) {
  const base = anchorsOf(t.from);
  const out = new Set(base);
  for (const a of base) {
    const words = String(a).split(/\s+/).filter(w => /^\p{Lu}/u.test(w));
    if (words.length >= 3 && words.length === String(a).split(/\s+/).length) out.add(words.map(w => w[0]).join('').toUpperCase());
  }
  try {
    for (const n of nodesByType(ownerId, 'entity')) {
      const names = [n.label, ...(n.data?.aliases ?? [])].filter(x => typeof x === 'string');
      if (!names.some(x => base.some(a => same(a, x)))) continue;
      for (const x of names) if (namedValue(x)) out.add(String(x).trim());
    }
  } catch { /* the reasoning graph is optional */ }
  return [...out].filter(a => !currentValues(f).some(v => same(v, a)));
}

// ── A goal whose target the user now holds (2026-11-05) ─────────────────────
/**
 * "My goal is to get promoted to senior analyst" … "I now work at Northbeam as a
 * senior analyst." The goal names the NEW value, so `dependsOn` (which looks for
 * the OLD one) never saw it, and it stayed active and predicted. It is flagged
 * `review.kind = 'target_reached'` ("may already be achieved") — never completed:
 * the user may have meant a promotion where they were, and only their own words
 * close a goal (goalTracker completion cues, the Understanding page).
 *
 * Exact matching only: the object of an attaining phrase (become / get promoted
 * to / get a job at / move to …), minus a time qualifier, equals the new value.
 * "mentor a senior analyst", "become a manager" and "senior analyst at Fintrail"
 * do not match "senior analyst".
 */
const TARGET_KEYS = new Set(['profession', 'workplace', 'city']);
const ATTAIN = /^(?:to\s+)?(?:get\s+promoted\s+to|be\s+promoted\s+to|get\s+a\s+promotion\s+to|become|be|get\s+(?:a\s+)?(?:new\s+)?(?:job|role|position|offer)\s+(?:as|at|with)|get\s+hired\s+(?:as|at|by)|land\s+(?:a\s+)?(?:job|role|position)\s+(?:as|at|with)|work\s+(?:as|at|for)|join|move\s+to|relocate\s+to|live\s+in)\s+(.+)$/i;
const WHEN_TAIL = /\s+(?:(?:this|next)\s+(?:year|month|quarter|spring|summer|autumn|fall|winter)|by\s+(?:the\s+end\s+of\s+)?[\w\s]+|in\s+\d{4}|soon|someday|eventually|one\s+day)$/i;
const ARTICLE = /^(?:an?|the)\s+/i;
export function reachedTarget(title, value) {
  const m = String(title ?? '').trim().replace(/[.!?]+$/, '').match(ATTAIN);
  const v = vnorm(asText(value)).replace(ARTICLE, '');
  if (!m || !v) return false;
  return vnorm(m[1].replace(WHEN_TAIL, '')).replace(ARTICLE, '') === v;
}

/** Live changes that put a value in place a goal could have been aiming at. */
function targetChanges(live) {
  return live.filter(({ f, t }) => TARGET_KEYS.has(t.key ?? f.key) && t.to != null && !ARCHIVE_KINDS.has(t.kind)
    && currentValues(f).some(v => same(v, t.to)));
}

function reconcileDependents(mind, live, liveIds, now, ownerId) {
  let flagged = 0, cleared = 0;
  const named = live.filter(({ t }) => !ARCHIVE_KINDS.has(t.kind)).map(x => ({ ...x, anchors: anchorsFor(ownerId, x.t, x.f) })).filter(x => x.anchors.length);
  const reaching = targetChanges(live);
  const reachingIds = new Set(reaching.map(x => x.t.id));
  // Goals (the Mind's goal store)
  for (const goal of Object.values(mind.goals ?? {})) {
    if (goal.review && (!liveIds.has(goal.review.transitionId) || !OPEN_GOAL.has(goal.status) || (goal.lastMentionedAt ?? 0) > goal.review.at
      || (goal.review.kind === 'target_reached' && !reachingIds.has(goal.review.transitionId)))) {
      delete goal.review; goal.updatedAt = now; cleared++;
    }
    if (!OPEN_GOAL.has(goal.status) || goal.changedBy) continue;
    for (const { f, t, anchors } of named) {
      if (dependsOn(goal.title, t, f, goal.lastMentionedAt ?? goal.createdAt ?? 0, { anchors, refersTo: goal.refersTo }) && flag(goal, t)) { goal.updatedAt = now; flagged++; }
    }
    // Only when nothing else flagged it: an old-name dependency (uncertain) takes precedence.
    if (goal.review && goal.review.kind !== 'target_reached') continue;
    const said = goal.lastMentionedAt ?? goal.createdAt ?? 0;
    const hit = reaching.find(({ t }) => said < t.at && reachedTarget(goal.title, t.to));
    if (hit && goal.review?.transitionId !== hit.t.id) {
      goal.review = { transitionId: hit.t.id, kind: 'target_reached', text: hit.t.text, at: hit.t.at, value: asText(hit.t.to), source: hit.t.source ?? 'conversation' };
      goal.updatedAt = now; flagged++;
    }
  }
  // The same decision for the legacy goal list's items (one decision, two stores).
  const reachedTitles = Object.values(mind.goals ?? {}).filter(g => g.review?.kind === 'target_reached').map(g => ({ title: g.title, review: g.review }));
  // Working memory: deadlines and blockers
  const w = mind.working ?? {};
  for (const list of [w.deadlines, w.blockers]) {
    for (const d of list ?? []) {
      if (d.review && !liveIds.has(d.review.transitionId)) { delete d.review; cleared++; }
      for (const { f, t, anchors } of named) {
        if (dependsOn(d.label ?? d.text, t, f, d.addedAt ?? d.ts ?? 0, { anchors, refersTo: d.refersTo }) && flag(d, t)) flagged++;
      }
    }
  }
  // Other legacy facts (goal / project collections, free-text facts)
  for (const [factKey, g] of Object.entries(mind.facts ?? {})) {
    if (!g || g.status === 'archived' || g.ended) continue;
    const before = g.reviews?.length ?? 0;
    const mirrored = r => reachedTitles.some(x => x.review.transitionId === r.transitionId && same(x.title, r.item));
    g.reviews = (g.reviews ?? []).filter(r => liveIds.has(r.transitionId) && (g.lastMentionedAt ?? 0) <= Math.max(r.at, g.reviewsSetAt ?? 0)
      && (r.item == null || listOf(g.value).some(v => same(v, r.item)))
      && (r.kind !== 'target_reached' || mirrored(r)));
    cleared += before - g.reviews.length;
    if (GOAL_FACT_KEYS.includes(g.key ?? factKey) && Array.isArray(g.value)) {
      for (const item of listOf(g.value)) {
        const x = reachedTitles.find(rt => same(rt.title, item));
        if (!x || g.reviews.some(r => same(r.item, item))) continue;   // one note per item; an existing one stands
        g.reviews.push({ transitionId: x.review.transitionId, kind: 'target_reached', item, text: x.review.text, at: x.review.at, value: x.review.value, source: x.review.source });
        g.reviewsSetAt = now;
        flagged++;
      }
    }
    for (const { f, t, anchors } of named) {
      if (g === f || g.scopeOf === f.key) continue;
      const items = Array.isArray(g.value) ? listOf(g.value) : [asText(g.value)];
      for (const item of items) {
        if (!dependsOn(item, t, f, g.createdAt ?? g.ts ?? 0, { anchors })) continue;
        if (!Array.isArray(g.value) && (g.lastMentionedAt ?? 0) > t.at) continue;   // restated after the change
        if (g.reviews.some(r => r.transitionId === t.id && same(r.item, Array.isArray(g.value) ? item : null))) continue;
        g.reviews.push({ transitionId: t.id, item: Array.isArray(g.value) ? item : null, text: t.text, at: t.at, value: asText(t.from), source: t.source ?? 'conversation' });
        g.reviewsSetAt = now;
        flagged++;
      }
    }
    if (!g.reviews.length) { delete g.reviews; delete g.reviewsSetAt; }
  }
  return { flagged, cleared };
}

// ── Goals: one lifecycle across the two goal stores ─────────────────────────
/**
 * A goal is held twice: an item of the legacy `goal` fact (closed by
 * memory/factChange.js laterWordsOnFacts → retiredItems) and a Mind goal
 * (closed by mind/goalTracker.js or on the Understanding page). Each decided
 * completion on its own, so "We launched the app" could complete one and leave
 * the other active. Here a closure THE USER made in either store is applied to
 * the other, with the same words:
 *   Mind goal completed / abandoned by the user → the legacy item retires
 *     (applyCurrentState end; recorded as a transition, source goal_sync)
 *   legacy item retired by the user's words     → the Mind goal completes
 *     (resolved) or is abandoned (ended), or carries changedBy (changed)
 * Never from a related fact: a dependent is only ever flagged (above). Never
 * from reflection ("reflection: unmentioned" → stale) — not the user's word.
 */
const GOAL_FACT_KEYS = ['goal', 'goals'];
const USER_CLOSED = /^(?:completion cue|user edit|(?:resolved|ended|abandoned|changed|stopped|achieved) by the user)/;
const GOAL_MATCH = 0.8;

function reconcileGoals(mind, ownerId, now) {
  let n = 0;
  const legacy = GOAL_FACT_KEYS.map(k => mind.facts?.[k]).filter(f => f && f.status !== 'archived');
  if (!legacy.length) return 0;
  const goals = Object.values(mind.goals ?? {});
  const matchOf = (title, items) => items.find(i => goalSimilarity(i, title) >= GOAL_MATCH);
  // Mind → legacy
  for (const g of goals) {
    if (g.status !== GOAL_STATUS.COMPLETED && g.status !== GOAL_STATUS.ABANDONED) continue;
    const last = (g.history ?? []).at(-1);
    if (!last || !USER_CLOSED.test(String(last.reason ?? ''))) continue;
    for (const f of legacy) {
      const item = matchOf(g.title, currentValues(f));
      if (!item) continue;
      const kind = g.status === GOAL_STATUS.COMPLETED ? 'resolved' : 'ended';
      const said = String(last.reason).replace(/^[a-z ]+by the user:\s*/, '').trim();
      const text = /^(?:completion cue|user edit)$/.test(said)
        ? `they marked the goal "${g.title.slice(0, 80)}" ${kind === 'resolved' ? 'done' : 'dropped'}${said === 'user edit' ? ' on the Understanding page' : ''}`
        : said;
      const previous = new Map([[f.key, { value: Array.isArray(f.value) ? [...f.value] : f.value, sourceText: f.sourceText, status: f.status }]]);
      const start = now;
      if (Array.isArray(f.value)) applyCurrentState(ownerId, f.key, { action: 'end' }, { text, kind, item, at: now });
      else applyCurrentState(ownerId, f.key, { action: 'end' }, { text, kind, at: now });
      recordTransitions(ownerId, previous, { text, turnStart: start, source: said === 'user edit' ? 'understanding_card' : 'conversation' });
      n++;
    }
  }
  // legacy → Mind
  for (const f of legacy) {
    // A single goal is a scalar fact: it closes as `ended`, a collection item as a retired item.
    const closed = [...(f.retiredItems ?? []),
      ...(f.ended && !Array.isArray(f.value) ? [{ item: f.value, kind: f.ended.kind, text: f.ended.text, at: f.ended.at }] : [])];
    for (const r of closed) {
      const g = goals.find(x => OPEN_GOAL.has(x.status) && !x.changedBy && goalSimilarity(r.item, x.title) >= GOAL_MATCH);
      if (!g || (g.lastMentionedAt ?? 0) > (r.at ?? 0)) continue;       // restated after it closed: open again
      const clip = String(r.text ?? '').slice(0, 160);
      if (r.kind === 'changed' || r.kind === 'corrected') {
        g.history.push({ status: g.status, at: now, reason: `changed by the user: ${clip}` });
        g.changedBy = { text: clip, at: r.at ?? now };
      } else {
        const status = r.kind === 'resolved' ? GOAL_STATUS.COMPLETED : GOAL_STATUS.ABANDONED;
        g.history.push({ status: g.status, at: now, reason: `${r.kind === 'resolved' ? 'resolved' : 'ended'} by the user: ${clip}` });
        g.status = status;
        if (status === GOAL_STATUS.COMPLETED) g.progress = 1;
        pushTimeline(mind, createTimelineEvent({ kind: status === GOAL_STATUS.COMPLETED ? 'goal_completed' : 'goal_abandoned', subject: g.title, importance: 7 }));
      }
      g.updatedAt = now;
      n++;
    }
  }
  return n;
}

// ── Pronouns with one referent ───────────────────────────────────────────────
const PERSON_PRONOUN = /\b(?:he|him|his|she|her|hers|they|them|their)\b/i;
/**
 * "My bank contact is Derek Shaw." then "I need to send her the statements by
 * June 5." — the deadline names nobody, so a later change to the contact could
 * not reach it. When an item the Mind created THIS turn has a personal pronoun
 * and no name, and the user's previous message in the same conversation stated
 * exactly ONE fact whose value names someone, the item records that name in
 * `refersTo`. Two candidates, or none, or a different conversation: nothing is
 * recorded (ambiguous stays untouched). Called by memory/engine.js after the Mind
 * observed the turn.
 */
export function notePronounReferents(ownerId, { userMessage = '', conversationId = null, turnStart = 0 } = {}) {
  if (!propagationEnabled()) return 0;
  const mind = peekMind(ownerId);
  if (!mind) return 0;
  const w = (mind.working ??= {});
  const prior = w.lastUtterance;
  let n = 0;
  if (prior?.text && prior.conversationId === conversationId && PERSON_PRONOUN.test(userMessage)) {
    // Facts stated BY that message: each carries its own sentence, so a message of
    // two sentences states two facts — match by containment, at that turn.
    const stated = Object.values(mind.facts ?? {}).filter(f => !f.ended && f.sourceText && prior.text.includes(String(f.sourceText).trim())
      && Math.abs((f.updatedAt ?? f.ts ?? 0) - (prior.at ?? 0)) < 5_000);
    const names = [...new Set(stated.flatMap(f => listOf(f.value).flatMap(anchorsOf)).filter(a => !/\b(?:Inc|Ltd|Bank|Corp|LLC|Group|Capital)\b/.test(a)))];
    if (names.length === 1) {
      const fresh = [
        ...Object.values(mind.goals ?? {}).filter(g => (g.createdAt ?? 0) >= turnStart).map(g => [g, g.title]),
        ...[...(w.deadlines ?? []), ...(w.blockers ?? [])].filter(d => (d.addedAt ?? 0) >= turnStart).map(d => [d, d.label ?? d.text]),
      ];
      for (const [item, text] of fresh) {
        // Already names someone ("send Kim Alvarez the forms"): the pronoun is not the reference.
        if (!PERSON_PRONOUN.test(text ?? '') || /\p{Lu}\p{L}+\s+\p{Lu}\p{L}+/u.test(text ?? '')) continue;
        item.refersTo = names;
        n++;
      }
    }
  }
  w.lastUtterance = { text: String(userMessage).slice(0, 400), conversationId, at: Date.now() };
  touchMind(mind);
  return n;
}

/**
 * Make every Mind store agree with the facts' transitions. Idempotent; safe to
 * call on every turn. Each stage commits its own changes, so a failure part-way
 * leaves the earlier stages done and the rest for the next call.
 * @returns {{ beliefs: number, edges: number, flagged: number, cleared: number, error?: string }}
 */
export function reconcileMind(ownerId) {
  const out = { beliefs: 0, edges: 0, goals: 0, flagged: 0, cleared: 0 };
  if (!propagationEnabled()) return out;
  const mind = peekMind(ownerId);
  if (!mind?.facts) return out;
  const now = Date.now();
  try {
    // Goals first: closing a goal in one store records a transition in the facts,
    // which the stages below then carry like any other change.
    checkpoint('goals');
    out.goals = reconcileGoals(mind, ownerId, now);
    if (out.goals) touchMind(mind);
    const live = liveTransitions(mind);
    const liveIds = new Set(live.map(x => x.t.id));
    checkpoint('beliefs');
    out.beliefs = reconcileBeliefs(mind, live, now) + releaseBeliefs(mind, liveIds, now);
    if (out.beliefs) touchMind(mind);
    checkpoint('graph');
    out.edges = reconcileGraph(mind, live, liveIds, now);
    if (out.edges) touchMind(mind);
    checkpoint('dependents');
    Object.assign(out, reconcileDependents(mind, live, liveIds, now, ownerId));
    if (out.flagged || out.cleared) touchMind(mind);
  } catch (err) {
    out.error = err.message;
    console.warn(`[MEMORY] propagation incomplete owner=${ownerId} (retried next turn): ${err.message}`);
  }
  return out;
}

// ── 3. The evidence lane: a durable outbox ──────────────────────────────────
/**
 * The evidence lane is another file. A transition is its own outbox entry: it
 * is persisted in the Mind document, and the evidence work it implies is done
 * from it until it is stamped. Per transition:
 *
 *   pending   live, no `pic` stamp, `picNextAt` reached
 *   done      `pic` = when the evidence file was durably written
 *   dead      `picDead` = { at, error, attempts } after EVIDENCE_ATTEMPTS
 *             failures — kept, reported (propagationStatus), never retried
 *   released  `picReleased`: the transition stopped holding (revert, restore,
 *             forget); what it did in the evidence lane was undone
 *
 * ORDER, so a crash at any point leaves something the next sweep can finish
 * (WRITE-AHEAD; never atomic across the two files):
 *   1. flushMind      the transition is on disk before anything acts on it
 *   2. evidence work  archive / flag, idempotent (archived and same-id checks)
 *   3. flushEvidence  the evidence file is on disk
 *   4. stamp `pic`    in memory; the Mind's next flush persists it
 * Crash before 3: the stamp is missing, the work is redone (idempotent).
 * Crash between 3 and the next Mind flush: same. The evidence lane can lag the
 * record of a change on disk; it cannot lead it.
 *
 * Everything archived here carries `archivedReason: propagation:<transition>`,
 * so a release restores exactly those sentences and nothing a forget archived.
 */
const brain = () => import('../brain/index.js');
const evidence = () => import('../files/evidenceStore.js');
const inFlight = new Set();      // owners whose evidence step is running in this process
const crashAt = point => {       // test seam: simulate a process crash at a named point (AQUA_PROPAGATION_CRASH_AT)
  if (process.env.AQUA_PROPAGATION_CRASH_AT === point) process.exit(70);
};

const due = (t, now) => !t.pic && !t.picDead && (t.picNextAt ?? 0) <= now;

/**
 * Do every due evidence-lane step for one owner. Never throws; failures are
 * recorded on the transition. Safe to call concurrently (one run per owner per
 * process; across processes every step is idempotent).
 */
export async function propagateToEvidence(ownerId, { now = Date.now() } = {}) {
  const out = { retired: 0, flagged: 0, cleared: 0, restored: 0, failed: 0, dead: 0 };
  if (!propagationEnabled() || inFlight.has(ownerId)) return out;
  const mind = peekMind(ownerId);
  if (!mind?.facts) return out;
  const all = Object.values(mind.facts).flatMap(f => (f.transitions ?? []).filter(t => t.id).map(t => ({ f, t })));
  const pending = all.filter(({ f, t }) => isLive(f, t) && due(t, now));
  const released = all.filter(({ f, t }) => t.pic && !isLive(f, t) && !t.picReleased);
  if (!pending.length && !released.length) return out;
  inFlight.add(ownerId);
  try {
    flushMind(ownerId);                                   // 1. write-ahead
    crashAt('after-mind-flush');
    const [Brain, ES] = await Promise.all([brain(), evidence()]);
    const done = [];
    for (const { f, t } of pending) {
      try {
        checkpoint('evidence');
        const reason = `propagation:${t.id}`;
        // The sentence that stated the old value: retired by a change, and by an archive alike.
        if (t.fromSource) out.retired += Brain.retireSupersededStatement(ownerId, { oldValue: t.from, sourceText: t.fromSource }, { reason }).length;
        const anchors = ARCHIVE_KINDS.has(t.kind) ? [] : anchorsFor(ownerId, t, f);
        if (anchors.length) {
          // A sentence with a pronoun refers to whom the Mind item made from it
          // refers (notePronounReferents) — the same resolution, not a new one.
          const referents = [...Object.values(mind.goals ?? {}).map(g => [g.title, g.refersTo]),
            ...[...(mind.working?.deadlines ?? []), ...(mind.working?.blockers ?? [])].map(d => [d.label ?? d.text, d.refersTo])]
            .filter(([label, r]) => r?.length && typeof label === 'string' && label.length >= 12);
          const refersTo = statement => referents.filter(([label]) => vnorm(statement).includes(vnorm(label))).flatMap(([, r]) => r);
          for (const s of ES.listFacts(ownerId, { limit: 100_000 })) {
            if (s.archived || s.review?.transitionId === t.id || !dependsOn(s.statement, t, f, s.createdAt ?? 0, { anchors, refersTo: refersTo(s.statement ?? '') })) continue;
            if (!ES.evidenceForFact(ownerId, s.id).some(ev => ev.sourceType === 'conversation')) continue;
            ES.updateFact(ownerId, s.id, { review: { transitionId: t.id, text: t.text, at: t.at, value: asText(t.from), source: t.source ?? 'conversation' } });
            out.flagged++;
          }
        }
        done.push(t);
      } catch (err) {
        t.picAttempts = (t.picAttempts ?? 0) + 1;
        t.picError = String(err?.message ?? err).slice(0, 200);
        if (t.picAttempts >= EVIDENCE_ATTEMPTS) {
          t.picDead = { at: now, error: t.picError, attempts: t.picAttempts };
          out.dead++;
          console.warn(`[MEMORY] PROPAGATION_DEAD owner=${ownerId} transition=${t.id} key=${t.key} attempts=${t.picAttempts}: ${t.picError}`);
        } else {
          t.picNextAt = now + backoffMs(t.picAttempts);
          out.failed++;
          console.warn(`[MEMORY] evidence propagation failed owner=${ownerId} transition=${t.id} attempt=${t.picAttempts} (retry in ${backoffMs(t.picAttempts)}ms): ${t.picError}`);
        }
      }
    }
    for (const { t } of released) {
      const reason = `propagation:${t.id}`;
      for (const s of ES.listFacts(ownerId, { limit: 100_000 })) {
        if (s.review?.transitionId === t.id) { ES.updateFact(ownerId, s.id, { review: null }); out.cleared++; }
        if (s.archived && s.archivedReason === reason) { ES.updateFact(ownerId, s.id, { archived: false, archivedReason: null, archivedAt: null }); out.restored++; }
      }
    }
    ES.flushEvidence();                                   // 3. evidence durable
    crashAt('after-evidence-flush');
    const at = Date.now();
    for (const t of done) { t.pic = at; delete t.picNextAt; delete t.picError; }   // 4. stamp
    for (const { t } of released) t.picReleased = at;
    touchMind(mind);
  } catch (err) {
    console.warn(`[MEMORY] evidence propagation deferred owner=${ownerId}: ${err?.message ?? err}`);
  } finally {
    inFlight.delete(ownerId);
  }
  return out;
}

// ── 4. Recovery without a user message ──────────────────────────────────────
/**
 * One pass over every owner this process holds: reconcile the Mind (repairs a
 * copy the two-process merge brought back, a stage that failed part-way) and
 * run due evidence steps (pending after a crash, a failure, a restart). Owners
 * are independent: one owner's failure never stops another's.
 */
export async function sweepOnce({ owners = listOwners(), now = Date.now() } = {}) {
  const stats = { owners: 0, reconciled: 0, evidence: 0, failed: 0, dead: 0 };
  if (!propagationEnabled()) return { ...stats, disabled: true };   // second guard: the sweeper never starts when off
  for (const ownerId of owners) {
    const mind = peekMind(ownerId);
    if (!mind?.facts || !Object.values(mind.facts).some(f => f?.transitions?.some(t => t.id))) continue;
    stats.owners++;
    try {
      const r = reconcileMind(ownerId);
      if (r.beliefs || r.edges || r.goals || r.flagged || r.cleared) stats.reconciled++;
      const e = await propagateToEvidence(ownerId, { now });
      if (e.retired || e.flagged || e.cleared || e.restored) stats.evidence++;
      stats.failed += e.failed; stats.dead += e.dead;
    } catch (err) {
      console.warn(`[MEMORY] sweep failed owner=${ownerId}: ${err?.message ?? err}`);
    }
  }
  lastSweep = { at: Date.now(), ...stats };
  return stats;
}

let sweeper = null;
let lastSweep = null;
/**
 * Start the periodic sweep (server boot, aqua/router.js). Unref'd: it never
 * keeps a process alive. A first pass shortly after boot finishes whatever a
 * crash or a restart left pending.
 */
export function startPropagationSweeper({ intervalMs = 60_000, firstAfterMs = 5_000 } = {}) {
  if (sweeper || !propagationEnabled()) return false;
  const run = () => sweepOnce().catch(err => console.warn(`[MEMORY] propagation sweep failed: ${err?.message ?? err}`));
  setTimeout(run, firstAfterMs).unref?.();
  sweeper = setInterval(run, intervalMs);
  sweeper.unref?.();
  return true;
}
export function stopPropagationSweeper() { if (sweeper) clearInterval(sweeper); sweeper = null; }

/**
 * Diagnostics for one owner (GET /mind/propagation): what is pending, what is
 * dead and why. Owner-scoped; quotes nothing the user said beyond the key.
 */
export function propagationStatus(ownerId, { now = Date.now() } = {}) {
  const mind = peekMind(ownerId);
  const all = Object.values(mind?.facts ?? {}).flatMap(f => (f.transitions ?? []).filter(t => t.id).map(t => ({ f, t })));
  const row = ({ f, t }) => ({ id: t.id, key: t.key, kind: t.kind, source: t.source ?? 'conversation', at: t.at, attempts: t.picAttempts ?? 0, nextAt: t.picNextAt ?? null, error: t.picError ?? t.picDead?.error ?? null });
  return {
    transitions: all.length,
    live: all.filter(({ f, t }) => isLive(f, t)).length,
    evidencePending: all.filter(({ f, t }) => isLive(f, t) && !t.pic && !t.picDead).map(row),
    evidenceDead: all.filter(({ t }) => t.picDead).map(row),
    oldestPendingMs: Math.max(0, ...all.filter(({ f, t }) => isLive(f, t) && !t.pic && !t.picDead).map(({ t }) => now - (t.at ?? now))),
    lastSweep,
  };
}

// ── 5. Edits outside a conversation take the same path ──────────────────────
/**
 * Run a Memory-page / Understanding-page edit of the fact store through the
 * transition lifecycle: snapshot the facts it touches, edit, record what
 * changed as transitions (with `source`), reconcile the Mind, schedule the
 * evidence step. One definition of current reality whichever way the user
 * changed it. Never fails the edit: propagation errors are logged and the
 * sweep finishes them.
 */
export function withTransitions(ownerId, keys, mutate, { text = '', source = 'memory_page', kind = null } = {}) {
  if (!propagationEnabled() || !ownerId) return mutate();
  const mind = peekMind(ownerId);
  const previous = new Map();
  for (const k of new Set(keys.filter(Boolean))) {
    const f = mind?.facts?.[k];
    if (f) previous.set(k, { value: Array.isArray(f.value) ? [...f.value] : f.value, sourceText: f.sourceText, ended: !!f.ended, status: f.status });
  }
  const turnStart = Date.now();
  const result = mutate();
  try {
    recordTransitions(ownerId, previous, { text, turnStart, source, kind });
    reconcileMind(ownerId);
    propagateToEvidenceInBackground(ownerId);
  } catch (err) {
    console.warn(`[MEMORY] edit propagation deferred owner=${ownerId}: ${err?.message ?? err}`);
  }
  return result;
}

/** Fire-and-forget form for the chat path: never on the turn's critical path. */
export function propagateToEvidenceInBackground(ownerId) {
  propagateToEvidence(ownerId)
    .then(r => { if (r.retired || r.flagged || r.cleared) console.log(`[MEMORY] PROPAGATED owner=${ownerId} retired=${r.retired} flagged=${r.flagged} cleared=${r.cleared}`); })
    .catch(err => console.warn(`[MEMORY] evidence propagation deferred owner=${ownerId}: ${err?.message ?? err}`));
}

/**
 * A forgotten fact's value leaves the Mind's copies of it too: the belief the
 * fact bridged (mind/observers.js FACT_TO_BELIEF) when it holds that value, and
 * the graph edge self → that value. Before this a forgotten workplace stayed
 * "organization: Northbeam (user said)" in every prompt's cognitive model.
 * @returns {number} copies removed
 */
export function forgetValueInMind(ownerId, key, value) {
  const mind = peekMind(ownerId);
  if (!mind || value == null) return 0;
  let n = 0;
  const values = listOf(value);
  const map = FACT_TO_BELIEF[key];
  const sig = map ? map({ key, value }) : null;
  const bk = sig ? beliefKey(sig.dimension, sig.key) : null;
  const b = bk ? mind.beliefs?.[bk] : null;
  if (b && values.some(v => same(b.value, v) || (Array.isArray(b.value) && b.value.some(x => same(x, v))))) { deleteItem(mind, 'beliefs', bk); n++; }
  const rel = GRAPH_OF[key];
  for (const v of rel ? values : []) {
    const ek = edgeKeyOf(nodeKeyOf(rel[0], v), rel[1]);
    if (mind.graph?.edges?.[ek]) { delete mind.graph.edges[ek]; n++; }
  }
  if (n) touchMind(mind);
  return n;
}

/**
 * After a forget: the forgotten fact's transitions are gone, so everything they
 * set is released — the review notes quote the user's words and must not
 * outlive the forget. The evidence lane is checked against the transitions that
 * remain.
 */
export async function releaseAfterForget(ownerId) {
  if (!propagationEnabled()) return { cleared: 0 };
  const r = reconcileMind(ownerId);
  const mind = peekMind(ownerId);
  const remaining = new Set(Object.values(mind?.facts ?? {}).flatMap(f => (f.transitions ?? []).filter(t => isLive(f, t)).map(t => t.id)));
  const ES = await evidence();
  let n = 0;
  for (const s of ES.listFacts(ownerId, { limit: 100_000 })) {
    if (!s.review || remaining.has(s.review.transitionId)) continue;
    ES.updateFact(ownerId, s.id, { review: null });
    n++;
  }
  return { cleared: r.cleared + n };
}
