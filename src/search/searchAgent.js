/**
 * AQUA Web Search — Agent Registration
 *
 * Closes the seam the codebase left open for exactly this module:
 *
 *   - orchestrator/capabilities.js's 'web_search' entry: "No web search
 *     agent registered yet (see src/intelligence/agentRegistry.js) —
 *     reported for planning purposes only."
 *   - intelligence/agentRegistry.js: "Extension point for future modules
 *     (spec section 7): Research Agent, … Browser Agent …"
 *
 * Registers itself under the name 'web_search' on import (side effect —
 * the exact pattern verificationAgent.js established: chat.js does
 * `import '../search/searchAgent.js'` once, everything else discovers the
 * agent through getAgent()).
 *
 * run() delegates to SearchManager.performSearch() — the agent layer adds
 * NO logic of its own; it exists so the orchestrator's capability
 * detection can honestly report enabled/disabled based on real
 * registration state, the same way it already does for 'verification'.
 */

import { registerAgent } from '../intelligence/agentRegistry.js';
import { performSearch } from './searchManager.js';

registerAgent('web_search', {
  name: 'web_search',
  description:
    'Live web search: multi-provider (Serper → Tavily) with key rotation, ' +
    'result ranking, context compression, and query caching. Fails open — ' +
    'returns { used:false } instead of throwing.',
  run: performSearch,
});

console.log('[SEARCH] web_search agent registered');

export {};
