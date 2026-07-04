/**
 * AQUA Adaptive Tool Orchestrator — Capability Registry
 *
 * Phase 6 spec, "Extensibility": the orchestrator must support future
 * plugins without modification. New capabilities (Browser Agent, Research
 * Agent, Vision Agent, Code Execution Agent, Verification Agent,
 * Multi-Agent Coordinator, Evaluation Engine, Self-Reflection Engine, ...)
 * register themselves here once at module load; toolOrchestrator.js iterates
 * whatever is registered without needing to know about it ahead of time.
 *
 * Mirrors src/intelligence/agentRegistry.js's registration pattern exactly,
 * scoped to "capability" rather than "agent".
 *
 * Every capability definition:
 *   {
 *     id: string,
 *     label: string,            // human-readable, used in logs/metadata
 *     group: string,            // 'memory' | 'project' | 'research' |
 *                                  'reasoning' | 'execution' | 'infra'
 *     cost: 'low'|'medium'|'high',     // estimated_cost
 *     latency: 'low'|'medium'|'high',  // estimated_latency
 *     detect(ctx): { enabled, confidence, reason }
 *   }
 */

const capabilities = new Map();

/**
 * @param {string} id
 * @param {{ label: string, group: string, cost: string, latency: string, detect: Function }} definition
 */
export function registerCapability(id, definition) {
  if (typeof definition?.detect !== 'function') {
    throw new Error(`Capability "${id}" must implement detect()`);
  }
  capabilities.set(id, { id, ...definition });
}

/**
 * @param {string} id
 * @returns {object | undefined}
 */
export function getCapability(id) {
  return capabilities.get(id);
}

/**
 * @returns {string[]} ids of all registered capabilities
 */
export function listCapabilities() {
  return [...capabilities.keys()];
}

/**
 * @returns {object[]} full definitions of all registered capabilities
 */
export function getAllCapabilities() {
  return [...capabilities.values()];
}
