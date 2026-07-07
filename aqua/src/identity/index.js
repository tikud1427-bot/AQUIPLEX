/**
 * AQUA Identity & Self-Knowledge Layer — public API
 * ─────────────────────────────────────────────────────────────────────────────
 * The single source of truth for everything AQUA knows about Aquiplex and AQUA.
 * Loaded once, cached in memory, injected into every request. Nothing here is
 * hardcoded in a prompt — edit ./data/*.json (or call updateIdentityProfile)
 * and every prompt + every direct answer updates.
 *
 * Typical usage:
 *   import { buildIdentityInjection, detectIdentityIntent, answerFromIdentity,
 *            isRefusal } from '../identity/index.js';
 *
 *   const intent = detectIdentityIntent(userMessage);   // smart router
 *   const block  = buildIdentityInjection(intent);       // prompt injection
 *   ...
 *   if (intent.isSelf && isRefusal(answer)) answer = answerFromIdentity(userMessage);
 */

// Profile store
export {
  getIdentityProfile,
  updateIdentityProfile,
  reloadIdentity,
  IDENTITY_VERSION,
  _resetForTests,
} from './identityLoader.js';

// Prompt context (compact always-on + expanded per topic + directive)
export {
  compactBlock,
  buildIdentityInjection,
  directive as identityDirective,
} from './identityContext.js';

// Smart router (detect intent + deterministic grounded answer + refusal guard)
export {
  detectIdentityIntent,
  answerFromIdentity,
  composeAnswer,
  isRefusal,
} from './identityRouter.js';
