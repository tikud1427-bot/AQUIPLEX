/**
 * AQUA Mind — Reflection Engine (Layer 13) + Memory Decay (Layer 14)
 * ─────────────────────────────────────────────────────────────────────────────
 * Every N observed turns the Mind consolidates itself:
 *
 *   What did I learn?             → newly-promoted (established) beliefs
 *   Which assumptions weakened?   → contradiction-heavy / decayed beliefs
 *   What should become permanent? → promotion (established flag)
 *   What should be forgotten?     → decay → ARCHIVE (never immediate delete)
 *   Housekeeping                  → stale goals, quiet episodes, graph prune,
 *                                   working-memory expiry, TTL enforcement
 *
 * Runs ASYNCHRONOUSLY (setImmediate) after the response is already on its
 * way — reflection never adds latency to a turn and never appears in user
 * messages. Failures are logged and swallowed: reflection can never break
 * chat.
 */
import { DIMENSION_DYNAMICS, DIMENSIONS, STATUS, GOAL_STATUS, CAPS, createTimelineEvent } from './mindSchema.js';
import { decay, isEstablished, isArchiveCandidate } from './confidence.js';
import { touchMind } from './mindStore.js';
import { pushTimeline } from './timeline.js';
import { decayWorkingMemory } from './workingMemory.js';
import { closeStaleEpisodes } from './episodeTracker.js';
import { pruneGraph } from './relationshipGraph.js';
import { applyFactLifecycle, mergeDuplicateFacts } from '../memory/importanceEngine.js';
import { observeSignal } from './beliefEngine.js';

export const REFLECT_EVERY_TURNS = 8;
const GOAL_STALE_MS = 21 * 24 * 3600 * 1000; // unmentioned 3 weeks → stale

export function shouldReflect(mind) {
  return (mind.turnCount - (mind.lastReflectionTurn || 0)) >= REFLECT_EVERY_TURNS;
}

/** Synchronous core — exported for tests. Production path uses scheduleReflection. */
export function reflect(mind) {
  const now = Date.now();
  const report = {
    ts: now,
    turnCount: mind.turnCount,
    learned: [],      // newly established
    weakened: [],     // significant confidence drops via decay/contradiction
    promoted: [],
    archived: [],
    goalsStaled: [],
    episodesClosed: 0,
    graphPruned: 0,
    expired: [],      // hard TTL (privacy.retentionDays)
  };

  // ── Beliefs: decay, promote, archive, TTL ──────────────────────────────────
  for (const [bk, b] of Object.entries(mind.beliefs)) {
    if (b.privacy?.locked || b.status === STATUS.LOCKED) continue;

    // Hard retention TTL (Layer 19)
    if (b.privacy?.retentionDays) {
      const ttlMs = b.privacy.retentionDays * 24 * 3600 * 1000;
      if (now - b.createdAt > ttlMs) {
        delete mind.beliefs[bk];
        report.expired.push(bk);
        continue;
      }
    }

    // Promotion first (evidence accumulated since last reflection), then decay.
    // b.established is a one-way flag: "became permanent knowledge" is
    // reported exactly once, whenever the bar was crossed between reflections.
    if (!b.established && isEstablished(b)) {
      b.established = true;
      report.promoted.push(bk);
      report.learned.push({ key: bk, value: b.value, confidence: +b.confidence.toFixed(2) });
      pushTimeline(mind, createTimelineEvent({ kind: 'belief_established', subject: bk, importance: 6 }));
    }

    const dyn = DIMENSION_DYNAMICS[b.dimension] ?? { decayRate: 0.003 };
    const before = b.confidence;
    b.confidence = decay(before, dyn.decayRate, now - b.lastEvidenceAt, { established: !!b.established });
    if (before - b.confidence > 0.05) report.weakened.push({ key: bk, from: +before.toFixed(2), to: +b.confidence.toFixed(2) });

    // Temporary items never persist past reflection once stale (Layer 18)
    const staleTemp = b.privacy?.temporary && now - b.lastEvidenceAt > 24 * 3600 * 1000;
    if (b.status === STATUS.ACTIVE && (isArchiveCandidate(b) || staleTemp)) {
      b.status = STATUS.ARCHIVED;   // archive first — never delete immediately
      report.archived.push(bk);
    }
  }

  // ── Goals: stale detection ─────────────────────────────────────────────────
  for (const g of Object.values(mind.goals)) {
    if (g.status === GOAL_STATUS.ACTIVE && now - g.lastMentionedAt > GOAL_STALE_MS) {
      g.history.push({ status: g.status, at: now, reason: 'reflection: unmentioned' });
      g.status = GOAL_STATUS.STALE;
      report.goalsStaled.push(g.title);
    }
  }

  // ── Housekeeping ───────────────────────────────────────────────────────────
  report.episodesClosed = closeStaleEpisodes(mind);
  report.graphPruned    = pruneGraph(mind);
  decayWorkingMemory(mind);

  // ── Phase A — fact lifecycle (importance recompute + cold-storage archive) ─
  // Same consolidation pass human memory does: strengthen what's used,
  // archive what's stale. Fail-open — lifecycle can never break reflection.
  try {
    const life = applyFactLifecycle(mind, { now });
    report.factsRecomputed  = life.recomputed;
    report.factsArchived    = life.archived;
    report.factHistoryCapped = life.historyCapped;
  } catch (err) {
    console.warn('[MIND] fact lifecycle failed (non-fatal):', err.message);
    report.factsRecomputed = 0; report.factsArchived = [];
  }

  // ── Phase E — consolidation: duplicate-fact merge + insight generation ─────
  try {
    const dupes = mergeDuplicateFacts(mind, { now });
    report.factsMerged = dupes.merged;
    if (dupes.merged.length) {
      pushTimeline(mind, createTimelineEvent({
        kind: 'facts_merged', subject: dupes.merged.map(m => `${m.loser}→${m.winner}`).join(', '),
        importance: 4,
      }));
    }
  } catch (err) {
    console.warn('[MIND] duplicate merge failed (non-fatal):', err.message);
    report.factsMerged = [];
  }

  try {
    report.insights = deriveInsights(mind);
  } catch (err) {
    console.warn('[MIND] insight derivation failed (non-fatal):', err.message);
    report.insights = [];
  }

  // ── Record reflection (internal only — never surfaces in user messages) ────
  mind.reflections.push(report);
  if (mind.reflections.length > CAPS.REFLECTIONS) {
    mind.reflections.splice(0, mind.reflections.length - CAPS.REFLECTIONS);
  }
  mind.lastReflectionAt = now;
  mind.lastReflectionTurn = mind.turnCount;
  pushTimeline(mind, createTimelineEvent({
    kind: 'reflection', subject: `turn ${mind.turnCount}`,
    detail: `+${report.promoted.length} promoted, ${report.archived.length} archived, ${report.weakened.length} weakened`,
    importance: 4,
  }));
  touchMind(mind);

  console.log(`[MIND] REFLECTION owner=${mind.ownerId} turn=${mind.turnCount} promoted=${report.promoted.length} archived=${report.archived.length} weakened=${report.weakened.length} goalsStaled=${report.goalsStaled.length} factsArchived=${(report.factsArchived || []).length}`);
  return report;
}

/** Async, fire-and-forget, fail-safe. The only production entry point. */
export function scheduleReflection(mind) {
  if (!shouldReflect(mind)) return false;
  setImmediate(() => {
    try { reflect(mind); }
    catch (err) { console.warn('[MIND] Reflection failed (non-fatal):', err.message); }
  });
  return true;
}

// ── Phase E — insight generation ──────────────────────────────────────────────
// Cross-signal patterns the per-turn observers can't see individually become
// BEHAVIOR beliefs (through the ONE belief writer, so confidence math,
// evidence windows, contradiction handling and Mind View all apply for free).
// Deliberately few and high-precision:
//   • recurring blocker  — the same blocker text keeps returning (count ≥ 3)
//   • persistent goal    — a goal mentioned again and again (mentions ≥ 5)
const INSIGHT_BLOCKER_MIN = 3;
const INSIGHT_GOAL_MENTIONS = 5;

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

export function deriveInsights(mind) {
  const insights = [];

  for (const b of mind.working?.blockers || []) {
    if ((b.count || 1) >= INSIGHT_BLOCKER_MIN) {
      observeSignal(mind, {
        dimension: DIMENSIONS.BEHAVIOR,
        key: `recurring_blocker:${slug(b.text)}`,
        value: b.text,
        strength: 0.7,
        note: `reflection insight: blocker seen ${b.count}×`,
        source: 'reflection',
      });
      insights.push(`recurring blocker: ${b.text}`);
    }
  }

  for (const g of Object.values(mind.goals || {})) {
    if (g.status === GOAL_STATUS.ACTIVE && (g.mentions || 0) >= INSIGHT_GOAL_MENTIONS) {
      observeSignal(mind, {
        dimension: DIMENSIONS.BEHAVIOR,
        key: `persistent_goal:${slug(g.title)}`,
        value: g.title,
        strength: 0.65,
        note: `reflection insight: goal mentioned ${g.mentions}×`,
        source: 'reflection',
      });
      insights.push(`persistent goal: ${g.title}`);
    }
  }

  return insights;
}
