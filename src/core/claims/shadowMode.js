/**
 * AQUA Claims — shadow mode resolution
 * Blueprint E5 · L11 (fail open on enrichment) · L13 (no dark stages) · L15
 *
 * WHAT THIS RESOLVES, AND WHY IT IS NOT A GUESS
 * ---------------------------------------------
 * The claim shadow writer needs an answer to one question before it can be
 * built: what happens when the flag asks for shadow writes and there is no
 * Postgres? Both obvious answers are wrong. Throwing breaks L11 — a shadow
 * projection is enrichment, and enrichment must never cost a user their turn.
 * Silently doing nothing breaks L13 — a stage that is configured on, runs, and
 * writes nothing is indistinguishable from one that is working.
 *
 * The architecture already answered it. `configureStorageFromEnv` in
 * `core/storage/index.js` faced exactly this in E3/PR-5:
 *
 *     if (!isConfigured()) {
 *       mode = 'off';
 *       return { mode: 'off', …, reason: 'AQUA_STORE_PG=shadow but DATABASE_URL is not set' };
 *     }
 *
 * DEGRADE, AND DECLARE. Not an exception, not a silence — a mode of `off`
 * carrying the reason it is off, printed at boot by `storageBootLine`. This
 * module follows that contract exactly rather than inventing a second one,
 * because two subsystems disagreeing about what "shadow with no database"
 * means is how an operator ends up trusting one of them.
 *
 * ⚠️ THIS MODULE DOES NOT WRITE CLAIMS. It resolves whether anything should,
 * and says so. The projection from `conversationFacts` into `claimRepository`
 * is E5/PR-6 and is NOT implemented — see the report accompanying this change.
 * Shipping the resolution first means PR-6 starts from a decided contract with
 * a boot line already carrying it, instead of relitigating this at the point
 * where there is also a write path to get wrong.
 */
import { GATES } from '../flags.js';

/**
 * Registered in `core/flags.js`.
 *
 * 🔴 THE READ BELOW IS A LITERAL `process.env.AQUA_CLAIMS_SHADOW`, ON PURPOSE.
 * The first version read `process.env[CLAIMS_SHADOW_FLAG]` — tidier, and
 * invisible to the flag census, which greps for literal reads. The registry
 * test caught it immediately: "registered but never read". A flag reached
 * through a computed key is a dark flag that a registry cannot see, which is
 * the failure PR-1 exists to prevent, arriving through the door PR-1 built.
 */
export const CLAIMS_SHADOW_FLAG = 'AQUA_CLAIMS_SHADOW';

/** The gate's registry entry, so the default here cannot drift from the census. */
const gate = () => GATES.find(g => g.name === CLAIMS_SHADOW_FLAG);

/**
 * Should the claim shadow writer run, and if not, why not?
 *
 * @param {object} [deps]
 * @param {Function} [deps.isConfigured] Postgres availability probe
 * @returns {Promise<{ mode:'off'|'shadow', reason:string|null }>}
 */
export async function resolveClaimShadowMode({ isConfigured = null } = {}) {
  if (!gate()) {
    // The registry is the single configuration mechanism (PR-1). A flag that
    // reached here without an entry would be dark by construction.
    return { mode: 'off', reason: `${CLAIMS_SHADOW_FLAG} is not in the flag registry` };
  }

  const requested = String(process.env.AQUA_CLAIMS_SHADOW ?? '').toLowerCase() === 'on';
  if (!requested) return { mode: 'off', reason: null };

  let configured = isConfigured;
  if (!configured) {
    try {
      ({ isConfigured: configured } = await import('../db/pool.js'));
    } catch (err) {
      // L11: an unavailable probe degrades, it does not throw.
      return { mode: 'off', reason: `claim shadow unavailable: ${err?.message ?? err}` };
    }
  }

  let ok = false;
  try { ok = Boolean(configured()); } catch (err) {
    return { mode: 'off', reason: `claim shadow unavailable: ${err?.message ?? err}` };
  }

  return ok
    ? { mode: 'shadow', reason: null }
    : { mode: 'off', reason: `${CLAIMS_SHADOW_FLAG}=on but DATABASE_URL is not set` };
}

/**
 * One boot line, in the shape `storageBootLine` established.
 *
 * The requested-but-off case is the one that matters: it is the only way an
 * operator learns that the thing they switched on is not running.
 */
export function claimShadowBootLine(result) {
  const r = result ?? { mode: 'off', reason: null };
  if (r.mode === 'shadow') {
    return '[CLAIMS] shadow=on (JSON facts remain authoritative; claims are written but never read)';
  }
  return `[CLAIMS] shadow=off${r.reason ? ` (${r.reason})` : ''}`;
}
