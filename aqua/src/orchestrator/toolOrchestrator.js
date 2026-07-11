/**
 * AQUA Adaptive Tool Orchestrator — Main Entry Point
 *
 * Phase 6 spec. Sits immediately after task classification and immediately
 * before the existing Execution Planner stage:
 *
 *   User → Task Classification → [Adaptive Tool Orchestrator] →
 *   Execution Planner → Internal Intelligence → Prompt Builder →
 *   Provider Router → LLM → Response
 *
 * orchestrate() is a pure, synchronous, deterministic function: same inputs
 * always produce the same decision, no LLM calls, no I/O. It computes:
 *   - the dominant execution profile (src/orchestrator/executionProfiles.js)
 *   - per-capability enabled/disabled/confidence/reason/cost/latency
 *     (src/orchestrator/capabilityRegistry.js + capabilities.js)
 *   - the response budget for this profile
 *   - the verification decision (src/orchestrator/verificationStrategy.js)
 *   - a multi-label breakdown + cross-cutting tags for richer logging
 *     (src/orchestrator/multiLabelClassifier.js)
 *
 * It does NOT itself decide what chat.js actually skips — that integration
 * stays in chat.js, deliberately conservative (see comments there) so this
 * module can evolve independently without risking the "do not break
 * memory / project retrieval / existing APIs" non-functional requirements.
 */
import './capabilities.js'; // side-effect: registers every capability definition
import { getAllCapabilities } from './capabilityRegistry.js';
import { classifyMultiLabel } from './multiLabelClassifier.js';
import { selectProfile } from './executionProfiles.js';
import { shouldVerify } from './verificationStrategy.js';
import { getEffectiveComplexity } from '../core/classifier.js';
import { getAgent } from '../intelligence/agentRegistry.js';

/**
 * @param {{
 *   userMessage: string,
 *   taskType: string,        // classifier.js's classifyTask(...).task — single source of truth
 *   confidence: number,      // classifyTask(...).confidence
 *   hasWorkspaceId: boolean,
 * }} input
 * @returns {object} orchestration decision (see shape below)
 */
export function orchestrate({ userMessage, taskType, confidence, hasWorkspaceId }) {
  // Derived via the same function executionPlanner.js's createExecutionPlan()
  // uses a moment later in the pipeline — see getEffectiveComplexity's
  // docstring. Lets this run genuinely *before* the Execution Planner stage
  // (per the spec's pipeline diagram) without ever disagreeing with it.
  const complexity = getEffectiveComplexity(taskType, confidence);

  const multiLabel = classifyMultiLabel(userMessage);
  const profile     = selectProfile(taskType);
  const verification = shouldVerify({ taskType, complexity, tags: multiLabel.tags, userMessage });

  const requiredSet = new Set(profile.requiredCapabilities);
  const ctx = {
    taskType, complexity, confidence, hasWorkspaceId,
    requiredSet, profileLabel: profile.label, verification, multiLabel,
<<<<<<< HEAD
=======
    userMessage, // Web Search: decideWebSearch() (pure/deterministic) reads it — see capabilities.js
>>>>>>> 7306efb7 (update)
  };

  const capabilities = getAllCapabilities().map((cap) => {
    const decision = cap.detect(ctx);
    return {
      id: cap.id,
      label: cap.label,
      group: cap.group,
      estimated_cost: cap.cost,
      estimated_latency: cap.latency,
      enabled: decision.enabled,
      confidence: Number((decision.confidence ?? 0).toFixed(2)),
      reason: decision.reason,
    };
  });

  const enabled  = capabilities.filter((c) => c.enabled);
  const skipped  = capabilities.filter((c) => !c.enabled);

  // Verification's *capability* entry already reflects shouldVerify()'s
  // decision (capabilities.js wires it via an override), but the seam for
  // an eventual LLM-based verification agent lives here: if/when a future
  // phase calls registerAgent('verification', {...}) against
  // src/intelligence/agentRegistry.js, this is where toolOrchestrator would
  // hand off to it. Today agentRegistry has nothing registered, so this is
  // always a no-op — exactly the spec's "otherwise skip verification".
  const verificationAgent = verification.enabled ? getAgent('verification') : undefined;

  const estimatedCost    = roughTier(enabled, 'estimated_cost');
  const estimatedLatency = roughTier(enabled, 'estimated_latency');

  return {
    profile: { id: profile.id, label: profile.label, description: profile.description },
    budget: profile.budget,
    complexity,
    capabilities,
    enabled,
    skipped,
    estimatedCost,
    estimatedLatency,
    confidence,
    reasoningDepth: profile.budget.reasoningDepth,
    verification: { enabled: verification.enabled, reason: verification.reason, agentAvailable: !!verificationAgent },
    memoryUsed: enabled.some((c) => c.group === 'memory'),
    repositoryUsed: enabled.some((c) => c.id === 'repository_understanding'),
    researchUsed: enabled.some((c) => c.group === 'research'),
    multiLabel,
  };
}

// Cheapest-common-denominator tier across enabled capabilities — used only
// for the rolled-up "Estimated Cost: Medium" style summary line in logs.
function roughTier(enabledCapabilities, field) {
  const order = { low: 0, medium: 1, high: 2 };
  const names = ['low', 'medium', 'high'];
  if (!enabledCapabilities.length) return 'low';
  const max = enabledCapabilities.reduce((m, c) => Math.max(m, order[c[field]] ?? 0), 0);
  return names[max];
}

/**
 * Renders the orchestration decision in the spec's exact [ORCHESTRATOR] log
 * format ("Logging" section). Internal-only — never sent to the client; see
 * chat.js, which logs this server-side and exposes a separate, smaller
 * metadata object on the response for debugging APIs.
 *
 * @param {object} decision  result of orchestrate()
 * @returns {string}
 */
export function formatOrchestratorLog(decision) {
  const enabledNames = decision.enabled.map((c) => c.label).join('\n');
  const skippedNames = decision.skipped.map((c) => c.label).join('\n');
  const reasonParts = [decision.profile.description];
  if (decision.verification.enabled) {
    reasonParts.push(`Verification enabled: ${decision.verification.reason}.`);
  }

  return [
    '[ORCHESTRATOR]',
    `Profile = ${decision.profile.label}`,
    '',
    'Enabled:',
    enabledNames || '(none)',
    '',
    'Skipped:',
    skippedNames || '(none)',
    '',
    `Estimated Cost:\n${capitalize(decision.estimatedCost)}`,
    '',
    `Estimated Latency:\n${capitalize(decision.estimatedLatency)}`,
    '',
    `Reason:\n${reasonParts.join(' ')}`,
  ].join('\n');
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
