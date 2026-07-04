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
 * @param {{ plan: object, reasoning: object, critic: object, taskType: string }} input
 * @returns {{ active: boolean, text: string, raw: object }}
 */
export function synthesize({ plan, reasoning, critic, taskType }) {
  if (!plan?.active || !reasoning?.active) {
    return { active: false, text: '', raw: { plan, reasoning, critic, taskType } };
  }

  const stageNames = plan.pipeline.map(s => s.name).join(' → ');
  const lines = [
    '[Internal Reasoning Brief]',
    `Task: ${taskType}. ${reasoning.directive}`,
    `Work through these stages internally before answering: ${stageNames}.`,
    `Keep in mind: ${reasoning.checklist.join('; ')}.`,
  ];

  if (critic?.active) {
    lines.push(critic.directive);
  }

  return {
    active: true,
    text:   lines.join('\n'),
    raw:    { plan, reasoning, critic, taskType },
  };
}
