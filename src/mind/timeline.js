/**
 * AQUA Mind — Timeline (Layer 10)
 * ─────────────────────────────────────────────────────────────────────────────
 * Append-only capped ring of significant events (belief flips, goal changes,
 * episode open/close, reflections). History never disappears — old entries
 * roll off the detailed ring but their effects live on in belief history and
 * evidence counts. The Mind understands how the user EVOLVES.
 */
import { CAPS } from './mindSchema.js';
import { touchMind } from './mindStore.js';

export function pushTimeline(mind, event) {
  if (!mind || !event) return;
  mind.timeline.push(event);
  if (mind.timeline.length > CAPS.TIMELINE) {
    mind.timeline.splice(0, mind.timeline.length - CAPS.TIMELINE);
  }
  touchMind(mind);
}

export function recentTimeline(mind, limit = 20, { minImportance = 0 } = {}) {
  return mind.timeline
    .filter(e => e.importance >= minImportance)
    .slice(-limit)
    .reverse();
}
