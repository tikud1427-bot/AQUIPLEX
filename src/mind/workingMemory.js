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
  const q = userMessage.match(QUESTION_RE);
  if (q?.[1]) upsertList(w.openQuestions, q[1], now, CAPS.WORKING_LIST);

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
