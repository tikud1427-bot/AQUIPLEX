/**
 * AQUA Mind — Episodic Memory (Layer 8)
 * ─────────────────────────────────────────────────────────────────────────────
 * Experiences, not isolated facts. An episode is a themed arc: it opens when
 * a distinct focus emerges, accumulates conversations/objectives, and closes
 * (with an outcome) when the theme completes or goes quiet. Reflection closes
 * quiet episodes; completion cues close them with an outcome.
 *
 * Heuristic theming (zero-LLM): dominant focus topic + task type. An
 * LLM-assisted summarizer can later rewrite titles/lessons without schema
 * change.
 */
import { createEpisode, createTimelineEvent, STATUS } from './mindSchema.js';
import { touchMind } from './mindStore.js';
import { pushTimeline } from './timeline.js';
import { currentFocus } from './workingMemory.js';

const EPISODE_IDLE_CLOSE_MS = 5 * 24 * 3600 * 1000; // quiet 5 days → close
const OUTCOME_RE = /\b(shipped|launched|completed|fixed it|solved|it works now|resolved|merged|deployed)\b/i;

function activeEpisode(mind) {
  return Object.values(mind.episodes)
    .filter(e => e.status === STATUS.ACTIVE)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0] || null;
}

function themeFor(mind, taskType) {
  const focus = currentFocus(mind, 2).map(f => f.topic).filter(t => !t.startsWith('workspace:'));
  if (focus.length) return focus.join(' + ');
  return taskType !== 'conversation' ? taskType : null;
}

/**
 * Per-turn episode maintenance:
 *   • continue the active episode if theme overlaps, else open a new one
 *   • record outcome cues
 */
export function trackEpisode(mind, { taskType = 'conversation', conversationId = null, userMessage = '', goalsTouched = [] }) {
  const now = Date.now();
  const theme = themeFor(mind, taskType);
  if (!theme) return null;

  let ep = activeEpisode(mind);
  const themeTokens = new Set(theme.toLowerCase().split(/[\s+]+/).filter(Boolean));
  const overlaps = ep && [...themeTokens].some(t => ep.title.toLowerCase().includes(t));

  if (ep && !overlaps && now - ep.lastActivityAt > 12 * 3600 * 1000) {
    // Theme moved on after a gap — close the old arc quietly
    closeEpisode(mind, ep, 'theme shifted');
    ep = null;
  }

  if (!ep || !overlaps) {
    ep = createEpisode({ title: `Working on ${theme}`, conversationId });
    mind.episodes[ep.id] = ep;
    pushTimeline(mind, createTimelineEvent({ kind: 'episode_opened', subject: ep.title, importance: 5 }));
  }

  if (conversationId && !ep.conversationIds.includes(conversationId)) ep.conversationIds.push(conversationId);
  for (const g of goalsTouched) {
    if (!ep.objectives.includes(g.title)) ep.objectives.push(g.title);
  }
  ep.lastActivityAt = now;

  if (OUTCOME_RE.test(userMessage)) {
    closeEpisode(mind, ep, userMessage.match(OUTCOME_RE)[0]);
  }

  touchMind(mind);
  return ep;
}

export function closeEpisode(mind, ep, outcome) {
  if (!ep || ep.status !== STATUS.ACTIVE) return;
  ep.status = STATUS.ARCHIVED;
  ep.endedAt = Date.now();
  ep.outcome = outcome || null;
  pushTimeline(mind, createTimelineEvent({ kind: 'episode_closed', subject: ep.title, detail: outcome || '', importance: 6 }));
  touchMind(mind);
}

/** Reflection hook: close episodes that went quiet. */
export function closeStaleEpisodes(mind) {
  const now = Date.now();
  let closed = 0;
  for (const ep of Object.values(mind.episodes)) {
    if (ep.status === STATUS.ACTIVE && now - ep.lastActivityAt > EPISODE_IDLE_CLOSE_MS) {
      closeEpisode(mind, ep, 'went quiet');
      closed++;
    }
  }
  return closed;
}

export function getEpisodes(mind, { activeOnly = false, limit = 10 } = {}) {
  return Object.values(mind.episodes)
    .filter(e => !activeOnly || e.status === STATUS.ACTIVE)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, limit);
}
