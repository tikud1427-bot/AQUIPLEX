/**
 * AQUA Internal Intelligence Engine — Synthesizer
 *
 * Final stage of the internal pipeline. Combines Planner output,
 * Reasoning Engine output, and Critic output into one compact text
 * block — the "intelligence brief" — that promptBuilder.js injects into
 * the system prompt as a single additional module.
 *
 * Design note (additive, non-breaking):
 * Memory, project context, and conversation history are already built
 * and injected by chat.js / promptBuilder.js as their own blocks. The
 * Synthesizer does not re-embed that content here — doing so would
 * duplicate tokens already in the prompt. Instead it produces the one
 * genuinely new piece (plan + reasoning strategy + critic rubric) and
 * exposes a structured `raw` object so a future version of this module
 * can fully own prompt assembly end-to-end (per spec's long-term framing
 * of Synthesizer output as "the only prompt sent to the provider")
 * without breaking this interface.
 *
 * Deterministic: pure string templating, no LLM calls.
 */

/**
 * @param {{ plan: object, reasoning: object, critic: object, taskType: string, analysis?: string }} input
 *   analysis (Phase 3): the REAL reasoning pass output from reasoningAgent.js,
 *   present only on turns the pipeline deemed worth a model call. When present
 *   it REPLACES the generic "work through these stages" template line with the
 *   actual worked-through analysis of this specific request — the answering
 *   step then reasons WITH a real deliberation in front of it. When absent the
 *   brief is byte-identical to pre-Phase-3 (deterministic template).
 * @returns {{ active: boolean, text: string, raw: object }}
 */
export function synthesize({ plan, reasoning, critic, taskType, analysis = '' }) {
  if (!plan?.active || !reasoning?.active) {
    return { active: false, text: '', raw: { plan, reasoning, critic, taskType } };
  }

  const stageNames = plan.pipeline.map(s => s.name).join(' → ');
  const hasAnalysis = typeof analysis === 'string' && analysis.trim().length > 0;

  const lines = [
    '[Internal Reasoning Brief]',
    `Task: ${taskType}. ${reasoning.directive}`,
  ];

  if (hasAnalysis) {
    // Real reasoning pass ran — inject the actual analysis instead of a
    // generic "think through these stages" instruction.
    lines.push(
      'A preliminary analysis of this request was completed. Use it, verify it, and go beyond it — do not just restate it:',
      analysis.trim(),
    );
  } else {
    lines.push(
      `Work through these stages internally before answering: ${stageNames}.`,
      `Keep in mind: ${reasoning.checklist.join('; ')}.`,
    );
  }

  if (critic?.active) {
    lines.push(critic.directive);
  }

  return {
    active: true,
    text:   lines.join('\n'),
    raw:    { plan, reasoning, critic, taskType, reasoningPassRan: hasAnalysis },
  };
}
