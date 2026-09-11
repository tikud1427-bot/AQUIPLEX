/**
 * AQUA Internal Intelligence Engine — Agent Plugin Registry
 *
 * Extension point for future modules (spec section 7): Research Agent,
 * Coding Agent, Browser Agent, File Agent, Memory Agent, Tool Agent,
 * Vision Agent, Verification Agent, Planning Agent, etc.
 *
 * No agents are registered today — this phase stays deterministic and
 * single-pass per the spec's cost constraint. This registry is the seam
 * future phases plug into: a new agent calls registerAgent() once at
 * module load and the orchestrator (internalIntelligenceEngine.js) can
 * start invoking it without any other file changing.
 *
 * Consistent interface every agent module must expose:
 *   {
 *     name: string,
 *     description: string,
 *     run: async (input: object) => object   // input/output shape is
 *                                             // agent-specific; orchestrator
 *                                             // treats it as opaque today
 *   }
 */

const agents = new Map();

/**
 * @param {string} name
 * @param {{ name: string, description: string, run: Function }} definition
 */
export function registerAgent(name, definition) {
  if (typeof definition?.run !== 'function') {
    throw new Error(`Agent "${name}" must implement run()`);
  }
  agents.set(name, definition);
}

/**
 * @param {string} name
 * @returns {object | undefined}
 */
export function getAgent(name) {
  return agents.get(name);
}

/**
 * @returns {string[]} names of all registered agents
 */
export function listAgents() {
  return [...agents.keys()];
}
