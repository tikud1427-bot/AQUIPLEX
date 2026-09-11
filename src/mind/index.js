/**
 * AQUA Mind — Facade
 * ─────────────────────────────────────────────────────────────────────────────
 * The ONLY module the chat pipeline imports. Three calls:
 *
 *   mindObserve(owner, turn)   — inline, <1ms: signals → beliefs, goals,
 *                                working memory, episodes, graph. Called
 *                                during prepareTurn AFTER fact extraction
 *                                (reuses extractedFacts — no re-parse).
 *   mindContext(owner, q)      — inline: budgeted cognitive block for the
 *                                system prompt (rides memoryBlock slot).
 *   mindAfterTurn(owner, meta) — post-response: turn counting, prediction
 *                                rebuild, async reflection scheduling.
 *
 * Every call is fail-safe: a Mind failure logs a warning and returns a
 * neutral value — the chat pipeline can NEVER break because of the Mind.
 * owner=null (no user, no conversation) disables everything silently.
 */
import { resolveMindOwner, getMind, peekMind } from './mindStore.js';
import { observeSignals } from './beliefEngine.js';
import { observeTurn as runObservers, observeReaction } from './observers.js';
import { trackGoals } from './goalTracker.js';
import { updateWorkingMemory } from './workingMemory.js';
import { trackEpisode } from './episodeTracker.js';
import { updateGraph } from './relationshipGraph.js';
import { rebuildPredictions } from './predictionEngine.js';
import { scheduleReflection } from './reflectionEngine.js';
import { retrieveCognitiveContext } from './mindRetriever.js';

export { resolveMindOwner };

/**
 * Observe one user turn. Synchronous by design — pure heuristics, no I/O
 * beyond the debounced store save.
 * @returns {{ signals: number, goalsTouched: number }} diagnostics for logging
 */
export function mindObserve(ownerId, { userMessage, taskType, extractedFacts = [], workspaceId = null, conversationId = null }) {
  if (!ownerId) return { signals: 0, goalsTouched: 0 };
  try {
    const mind = getMind(ownerId);

    const { signals, hints } = runObservers({ userMessage, taskType, extractedFacts, workspaceId, conversationId });
    signals.push(...observeReaction({ userMessage, conversationId }));
    observeSignals(mind, signals);

    const goalsTouched = trackGoals(mind, { userMessage, extractedFacts, conversationId, workspaceId });
    updateWorkingMemory(mind, { userMessage, taskType, hints, workspaceId });
    trackEpisode(mind, { taskType, conversationId, userMessage, goalsTouched });
    updateGraph(mind, { extractedFacts, hints, goalsTouched, workspaceId });

    return { signals: signals.length, goalsTouched: goalsTouched.length };
  } catch (err) {
    console.warn('[MIND] observe failed (non-fatal):', err.message);
    return { signals: 0, goalsTouched: 0 };
  }
}

/**
 * Cognitive context for the prompt. Returns '' when the Mind is empty,
 * disabled, or nothing clears the relevance bar.
 */
export function mindContext(ownerId, { query = '', taskType = 'conversation', budgetTokens } = {}) {
  if (!ownerId) return { block: '', used: {} };
  try {
    const mind = peekMind(ownerId);          // peek: context must not create minds
    if (!mind) return { block: '', used: {} };
    return retrieveCognitiveContext(mind, { query, taskType, budgetTokens });
  } catch (err) {
    console.warn('[MIND] context failed (non-fatal):', err.message);
    return { block: '', used: {} };
  }
}

/**
 * Post-response bookkeeping. Counts the turn, rebuilds predictions, and
 * schedules async reflection when due. Cheap; reflection itself is deferred.
 */
export function mindAfterTurn(ownerId, { taskType = 'conversation', workspaceId = null } = {}) {
  if (!ownerId) return { reflected: false };
  try {
    const mind = getMind(ownerId);
    mind.turnCount += 1;
    rebuildPredictions(mind, { taskType, workspaceId });
    const reflected = scheduleReflection(mind);
    return { reflected };
  } catch (err) {
    console.warn('[MIND] afterTurn failed (non-fatal):', err.message);
    return { reflected: false };
  }
}
