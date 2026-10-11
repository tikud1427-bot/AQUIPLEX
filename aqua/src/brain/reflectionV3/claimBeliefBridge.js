/**
 * AQUA — E9: canonical claims SEED beliefs (the missing half of J2).
 *
 * MEASURED (live Postgres, 2026-10-04): an owner whose World Model was built
 * only by E6 ran 29 reflection jobs and got 0 `belief_claims` rows. J2 revises
 * beliefs already linked to claims, and the only thing that ever created a
 * belief from something the user SAID was the legacy fact bridge
 * (mind/observers.js FACT_TO_BELIEF) fed by the regex extractor. Canonical
 * claims could revise a belief but never start one.
 *
 * WHAT THIS IS — deliberately narrow, and not "every claim is a belief":
 *   · the SAME curated vocabulary the legacy fact bridge uses (organization,
 *     profession, project, tech knowledge), keyed by canonical predicate;
 *   · only first-person (subject type `self`), current, `fact`-modality claims —
 *     a belief is AQUA's stance about the USER, so a claim about Priya, an
 *     intent, a hypothetical or a superseded value never seeds one;
 *   · source `fact_bridge`, exactly as a legacy extracted fact enters: the
 *     Belief Engine's own dynamics (slow identity changeRate, versioning on a
 *     changed value) decide confidence. Code decides; nothing here is inferred.
 *
 * Claims, beliefs and indexes stay distinct (L2): the claim is the evidence,
 * the belief is the stance, `aqua_belief_claims` is the index linking them.
 */
import { DIMENSIONS, beliefKey } from '../../mind/mindSchema.js';

const label = c => {
  const o = c?.object ?? {};
  const v = o.entity ?? o.literal ?? null;
  return typeof v === 'string' ? v.trim() : null;
};

/** predicate → belief target. Mirrors FACT_TO_BELIEF; strengths identical. */
export const CLAIM_TO_BELIEF = Object.freeze({
  works_at: c => ({ dimension: DIMENSIONS.IDENTITY, key: 'organization', value: label(c), strength: 0.85 }),
  role_is:  c => ({ dimension: DIMENSIONS.IDENTITY, key: 'profession', value: label(c), strength: 0.85 }),
  builds:   c => ({ dimension: DIMENSIONS.IDENTITY, key: 'project', value: label(c), strength: 0.85 }),
  uses:     c => (label(c)
    ? { dimension: DIMENSIONS.KNOWLEDGE, key: `tech:${label(c).toLowerCase()}`, value: 'working_knowledge', strength: 0.4 }
    : null),
});

const CURRENT = new Set(['active', 'trusted', 'extracted']);

/**
 * One canonical claim → one belief signal, or null when the claim is not
 * first-person, not a current fact, or has no curated belief target.
 * A NEGATED claim becomes contradicting evidence for the same value.
 */
export function claimToBeliefSignal(claim) {
  if (!claim?.claimId) return null;
  if (claim.subjectType !== 'self') return null;
  if ((claim.modality ?? 'fact') !== 'fact') return null;
  if (claim.state && !CURRENT.has(claim.state)) return null;
  const map = CLAIM_TO_BELIEF[claim.predicate];
  const sig = map ? map(claim) : null;
  if (!sig?.value) return null;
  return {
    ...sig,
    support: (claim.polarity ?? 'asserted') !== 'negated',
    claimId: claim.claimId,
    source: 'fact_bridge',
    note: `canonical claim: ${claim.predicate}`,
  };
}

/**
 * Plan bridge signals for claims that have NO belief link yet. If the belief
 * already holds the claim's value (e.g. the legacy fact bridge saw the same
 * sentence), the claim is LINKED, not applied again — one statement must not
 * reinforce a belief twice because two pipelines read it.
 *
 * @returns {{ apply: object[], linkOnly: Array<{signal, belief}> }}
 */
export function planBridgeSignals({ claims = [], linkedClaimIds = new Set(), beliefs = {} } = {}) {
  const apply = [];
  const linkOnly = [];
  for (const claim of claims) {
    if (linkedClaimIds.has(claim.claimId)) continue;
    const signal = claimToBeliefSignal(claim);
    if (!signal) continue;
    const existing = beliefs[beliefKey(signal.dimension, signal.key)];
    const same = existing && JSON.stringify(existing.value) === JSON.stringify(signal.value);
    if (existing && same && signal.support) linkOnly.push({ signal, belief: existing });
    else apply.push(signal);
  }
  return { apply, linkOnly };
}
