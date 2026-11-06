/**
 * A Lift persona as the episodic-recall lane sees it (memory/episodicRecall.js):
 * each session is its own dated conversation, a week apart, a minute per turn;
 * each document is a file attached to the conversation it followed, uploaded
 * just after it. Shared by scripts/lift-recall-offline.mjs (stored v3 blocks)
 * and scripts/world-model-lift-live.mjs (the `recall` / `wmRecall` conditions).
 */
import { deriveTitle } from '../../src/memory/conversationStore.js';

const T0 = Date.UTC(2026, 8, 1);
const WEEK = 7 * 86_400_000;

/** When turn i of session s (both 0-based) was said — the clock recall's dates use. */
export const turnTime = (s, i) => T0 + s * WEEK + i * 60_000;
/** The day after the persona's last session: when its questions are asked. */
export const askTime = p => T0 + (p.sessions.length - 1) * WEEK + 86_400_000;

/** Map<conversationId, { meta, messages }> in the shape collectUnits() reads. */
export function conversationsFor(p, userId = p.id) {
  const m = new Map();
  p.sessions.forEach((turns, s) => {
    m.set(`${p.id}-s${s + 1}`, {
      meta: { userId, title: deriveTitle(turns[0]), createdAt: turnTime(s, 0) },
      messages: turns.map((content, i) => ({ role: 'user', content, ts: turnTime(s, i) })),
    });
  });
  return m;
}

/** conversationId → the persona's documents attached to it. */
export function attachmentsFor(p) {
  const by = new Map();
  for (const d of p.documents ?? []) {
    const id = `${p.id}-s${d.afterSession}`;
    const ts = T0 + (d.afterSession - 1) * WEEK + 23 * 3_600_000;
    by.set(id, [...(by.get(id) ?? []), { id: d.name, name: d.name, content: d.text, uploadedAt: ts }]);
  }
  return id => by.get(id) ?? [];
}
