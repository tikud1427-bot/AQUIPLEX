/**
 * AQUA Mind — Working Memory (Layer 9)
 * ─────────────────────────────────────────────────────────────────────────────
 * Volatile "what's on the user's plate RIGHT NOW": focus topics, blockers,
 * deadlines, discoveries, open questions. Changes every turn, decays in
 * hours-to-days (not weeks), and is the highest-signal input to both
 * retrieval and prediction. Nothing here is a belief — it's state.
 */
import { CAPS } from './mindSchema.js';
import { touchMind } from './mindStore.js';
import { transitionOf, closes, datesIn, partAbout, clauseWith, speculative } from '../understanding/stateTransition.js';

const FOCUS_HALF_LIFE_MS = 36 * 3600 * 1000;   // focus weight halves every 36h
const LIST_TTL_MS        = 7 * 24 * 3600 * 1000; // blockers/discoveries/questions expire after 7d

const DISCOVERY_RE = /\b(turns out|i (?:just )?(?:found|discovered|realized|learned)|interesting[:,]|til\b)\s*(.{4,100}?)(?:[.!;]|$)/i;
const QUESTION_RE  = /\b(?:i(?:'m| am) (?:wondering|not sure)|should (?:i|we)|open question|still unsure)\b.{0,10}(.{4,100}?)(?:[.!;?]|$)/i;
const BLOCKER_RE   = /\b(?:blocked (?:on|by)|stuck on|waiting (?:on|for))\s+(.{3,80}?)(?:[.,;!]|$)/i;

function decayedWeight(item, now) {
  const age = now - (item.lastSeenAt || now);
  return (item.weight || 1) * Math.pow(0.5, age / FOCUS_HALF_LIFE_MS);
}

function upsertList(list, text, now, cap) {
  const norm = text.trim().toLowerCase();
  const hit = list.find(x => x.text.toLowerCase() === norm || x.text.toLowerCase().includes(norm) || norm.includes(x.text.toLowerCase()));
  if (hit) { hit.lastSeenAt = now; hit.count = (hit.count || 1) + 1; return; }
  list.push({ text: text.trim().slice(0, 100), addedAt: now, lastSeenAt: now, count: 1 });
  if (list.length > cap) list.splice(0, list.length - cap);
}

const HISTORY_CAP = 20;
const clip = (s, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const keep = (list, item) => { list.push(item); if (list.length > HISTORY_CAP) list.splice(0, list.length - HISTORY_CAP); };

/**
 * THE USER'S LATER WORDS ON WHAT IS ON THEIR PLATE (2026-11-02).
 *
 * Working memory only ever ADDED: a blocker left after seven days unmentioned,
 * a deadline after fourteen, whatever the user said meanwhile. So "blocked on:
 * a zoning permit" was the user's "Current state" after "the zoning permit came
 * through", "deadline: launch on November" after "the launch moved to December
 * 9", and "Likely needs unblocking on: Apple's review" after "Apple approved
 * the app" — in every turn's prompt (dev sets: 8 of 36 users). And an OPEN
 * blocker the user kept reporting ("still no word from the city") expired on
 * the same clock.
 *
 * Applied before this turn's own additions, only on the user's own words:
 *   · a message that CLOSES a listed blocker (resolution or ending, not negated
 *     or hedged — understanding/stateTransition.js `closes`) and shares a
 *     subject word with it moves it to `resolvedBlockers`, with when and what;
 *   · "still no word on …" keeps a listed blocker open;
 *   · a message that changes, corrects, ends or closes a listed deadline's
 *     subject retires it to `pastDeadlines`; when it names a new date, that
 *     clause, in the user's words, is the deadline now.
 * Nothing is inferred into the state and nothing is deleted: the history
 * lists keep every retired item with the message that retired it.
 */
function applyLaterWords(w, userMessage, now) {
  const text = String(userMessage ?? '');
  if (!text.trim() || !transitionOf(text).marked) return;

  // Each item is judged on the part of the message ABOUT it: in "the cabinets
  // arrived, but now the electrician is the bottleneck" the arrival closes the
  // cabinets, not the electrician.
  for (const b of [...w.blockers]) {
    const about = partAbout(text, b.text);
    if (!about || speculative(about)) continue;
    const closing = closes(about);
    if (!closing && transitionOf(about).stillOpen) { b.lastSeenAt = now; continue; }
    if (!closing) continue;
    w.blockers.splice(w.blockers.indexOf(b), 1);
    keep(w.resolvedBlockers ??= [], { ...b, resolvedAt: now, resolvedBy: clip(text) });
  }

  for (const d of [...w.deadlines]) {
    const about = partAbout(text, d.label);
    if (!about || speculative(about)) continue;
    const tr = transitionOf(about);
    const closing = closes(about);
    const dates = datesIn(about);
    // A change that names no date and closes nothing ("now", "update") says
    // nothing about WHEN — the deadline stands.
    if (!closing && !((tr.changes || tr.corrects) && dates.length)) continue;
    w.deadlines.splice(w.deadlines.indexOf(d), 1);
    keep(w.pastDeadlines ??= [], { ...d, supersededAt: now, supersededBy: clip(text) });
    if (dates.length && !closing) {
      const label = clauseWith(about, dates[0]);
      if (!w.deadlines.some(x => x.label === label)) w.deadlines.push({ label, ts: null, source: 'update', addedAt: now });
    }
  }
}

/**
 * Per-turn working-memory update. Consumes observer hints (tech, deadlines)
 * plus its own light parsing for discoveries/questions/blockers.
 */
export function updateWorkingMemory(mind, { userMessage = '', taskType = 'conversation', hints = {}, workspaceId = null }) {
  const w = mind.working;
  const now = Date.now();

  // Focus: task type + tech terms + workspace form the current-topic cloud
  const topics = new Set();
  if (taskType && taskType !== 'conversation') topics.add(taskType);
  for (const t of hints.tech || []) topics.add(t);
  if (workspaceId) topics.add(`workspace:${workspaceId}`);

  for (const topic of topics) {
    const existing = w.focus.find(f => f.topic === topic);
    if (existing) {
      existing.weight = decayedWeight(existing, now) + 1;
      existing.lastSeenAt = now;
    } else {
      w.focus.push({ topic, weight: 1, lastSeenAt: now });
    }
  }
  // Re-rank by decayed weight; keep top N
  w.focus = w.focus
    .map(f => ({ ...f, _w: decayedWeight(f, now) }))
    .filter(f => f._w > 0.05)
    .sort((a, b) => b._w - a._w)
    .slice(0, CAPS.WORKING_FOCUS)
    .map(({ _w, ...f }) => f);

  // The user's later words on what is already listed, before this turn adds.
  applyLaterWords(w, userMessage, now);

  // Deadlines from observer hints
  for (const d of hints.deadlines || []) {
    if (!w.deadlines.some(x => x.label === d.label)) {
      w.deadlines.push({ ...d, addedAt: now });
      if (w.deadlines.length > CAPS.WORKING_LIST) w.deadlines.splice(0, w.deadlines.length - CAPS.WORKING_LIST);
    }
  }

  // Blockers / discoveries / open questions
  const b = userMessage.match(BLOCKER_RE);
  if (b?.[1]) upsertList(w.blockers, b[1], now, CAPS.WORKING_LIST);
  const d = userMessage.match(DISCOVERY_RE);
  if (d?.[2]) upsertList(w.recentDiscoveries, d[2], now, CAPS.WORKING_LIST);
  // The user's clause, not the capture: `.{0,10}` after the cue ate into the
  // next word, and "open question: hat.." / "ull overhaul" reached the prompt
  // as the user's current state (dev sets, 2026-11-02).
  const q = userMessage.match(QUESTION_RE);
  if (q?.[1]) upsertList(w.openQuestions, clauseWith(userMessage, q[0].toLowerCase().slice(0, 20), 100), now, CAPS.WORKING_LIST);

  w.updatedAt = now;
  touchMind(mind);
  return w;
}

/** Reflection-time cleanup: expire stale list items, re-decay focus. */
export function decayWorkingMemory(mind) {
  const w = mind.working;
  const now = Date.now();
  const fresh = (x) => now - (x.lastSeenAt || x.addedAt || 0) < LIST_TTL_MS;
  w.blockers          = w.blockers.filter(fresh);
  w.recentDiscoveries = w.recentDiscoveries.filter(fresh);
  w.openQuestions     = w.openQuestions.filter(fresh);
  w.deadlines         = w.deadlines.filter(x => now - (x.addedAt || 0) < 2 * LIST_TTL_MS);
  w.focus = w.focus
    .map(f => ({ ...f, _w: decayedWeight(f, now) }))
    .filter(f => f._w > 0.05)
    .map(({ _w, ...f }) => f);
  touchMind(mind);
}

export function currentFocus(mind, limit = 5) {
  const now = Date.now();
  return mind.working.focus
    .map(f => ({ topic: f.topic, weight: +decayedWeight(f, now).toFixed(2) }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}
