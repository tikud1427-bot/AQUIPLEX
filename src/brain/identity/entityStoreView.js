/**
 * AQUA Brain — owner-scoped ENTITY READER for S6
 * Blueprint E6/S6 · L8 (labels are never keys) · L19 (owner isolation)
 *
 * THIS IS NOT A STORE. IT HOLDS NOTHING.
 *
 * S6 was structurally unreachable from production for one reason: it takes an
 * `entityStore` and `understandTurn` never passed one, so `pipeline.js` returned
 * `entityResolution: 'unresolved'` before the stage ran. The obvious fix — build
 * an entity store — is the wrong one. The audit's central finding is that this
 * codebase has too many stores of the same thing, and a fourth identity space
 * created to satisfy an argument would be the exact failure L2 exists to stop.
 *
 * So this is a VIEW. `idStore` is already the canonical identity map: one entry
 * per real thing, owner-scoped, `purgeOwner`-registered, bounded at 20k entries,
 * with a normalized-spelling index maintained on every write. It has everything
 * S6 asks for and none of it in the shape S6 asks for. This closes that seam and
 * nothing else — zero state, zero writes, zero new persistence.
 *
 * THE INTERFACE S6 EXPECTS (entityResolution.js)
 * ----------------------------------------------
 *   byNormalized(norm) → entity|null     tier ①
 *   byAlias(norm)      → entity|null     tier ②
 *   all()              → entity[]        tier ③
 * where an entity carries `entityId`/`id` and `name`/`canonical`.
 *
 * 🔴 `byAlias` IS DELIBERATELY ABSENT, AND THAT IS AN HONESTY DECISION.
 *
 * idStore does not model aliases as a separate space. Every spelling that
 * resolves to a subject — the canonical one and every alias ever seen — lives in
 * the SAME `norms` array and the SAME index, unioned by `putEntry`. So tier ①
 * already returns what tier ② would look for.
 *
 * Supplying a `byAlias` that consults that same index would never fire (tier ①
 * consumed the hit first) or, if tier ① were ever reordered, would report ALIAS
 * for what is an EXACT match. Either way `stats.s6.byTier` — the only evidence
 * anyone has that S6 did anything — would be describing a tier structure the
 * store does not have. An absent optional reader is read as `null` by S6's own
 * `store?.byAlias?.(norm) ?? null`, which is the truthful answer: this store has
 * no separate alias tier.
 *
 * NORMALISATION KEYSPACE — WHY THE KEYS ACTUALLY MEET
 * ---------------------------------------------------
 * S6 keys its lookups with `normalizeMention(surface)`. `canonicalId.resolve`
 * writes `norms: [normalizeMention(name)]`. Same function, same module, one
 * keyspace. That is not a coincidence to be relied on quietly — blueprint §10's
 * defect is precisely "embedding key ≠ retrieval identity", and this file exists
 * one seam away from repeating it, so it is asserted in test rather than assumed
 * here.
 *
 * READ-ONLY, ON PURPOSE. `canonicalId.lookup()` looks like the natural reuse and
 * is not: `resolve()` calls `idStore.putEntry` on its exact and merge paths
 * BEFORE returning, so a "lookup" upgrades kinds and unions norms. Correct for
 * an ingest path; wrong for a shadow stage that must not change the world it is
 * measuring. This reads the index directly and writes nothing.
 */
import * as idStore from './idStore.js';

/** Shape one idStore entry the way S6 reads entities. */
const asEntity = (id, entry) => (id
  ? { entityId: id, name: entry?.canonical ?? null, kind: entry?.kind ?? null }
  : null);

/**
 * An owner-scoped reader over the canonical identity map.
 *
 * @param {string} ownerId
 * @returns {{ byNormalized: Function, all: Function }|null} null without an
 *          owner — S6 then does not run, which is the correct fail-open.
 */
export function entityStoreFor(ownerId) {
  if (!ownerId) return null;

  return {
    // Tier ① — exact normalized. Kind-agnostic because S6 resolves a bare
    // surface form out of a sentence and has no type to filter on; a claim's
    // subject arrives as a string, not as `org:Nummo`.
    byNormalized(norm) {
      const id = idStore.findByNormAnyKind(ownerId, norm);
      return asEntity(id, idStore.getEntry(ownerId, id));
    },

    // Tier ③ — the candidate set S6 scores against. BOUNDED BY idStore's own
    // MAX_ENTRIES_PER_OWNER (20k), which is a cap on the store, not on this
    // scan: S6 scores every candidate per surface, so cost is O(entities ×
    // surfaces) per turn. Acceptable today because the stage is deferred,
    // fail-open and flag-off; it is a real ceiling and it is named here rather
    // than discovered later.
    all() {
      const out = [];
      for (const [id, entry] of idStore.allEntries(ownerId)) out.push(asEntity(id, entry));
      return out;
    },
  };
}
