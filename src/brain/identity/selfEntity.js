/**
 * AQUA Brain — Owner Self-Entity (foundation increment)
 *
 * WHY THIS EXISTS
 * ---------------
 * The world model knows Priya and Aquiplex. It has never had a node for the
 * person whose world it is.
 *
 * That gap surfaced concretely when we tried to route `memoryObserve`'s typed
 * facts into the graph. A fact like `cofounder = "Priya"` is already a typed
 * relationship — the key IS the predicate — but it is USER-ANCHORED, and
 * there was nothing for the `from` end of that edge to be. The same gap is
 * why a goal's `owner` field has nowhere to point.
 *
 * This file introduces exactly one node per owner so that anchoring becomes
 * possible. It does NOT create any such relationship yet — that is the next
 * increment, deliberately kept separate.
 *
 * IDENTITY IS STABLE, NEVER RESOLVED
 * ----------------------------------
 * The self entity always exists, whether or not the user's name is known, and
 * learning the name later ENRICHES it rather than replacing it. A self node
 * that became `aq:person:priya_sharma` the moment a name was learned would
 * change identity underneath every reference already written to it — the one
 * thing a canonical id must never do.
 *
 * So the id is a constant. The graph and the id map are both owner-scoped
 * already, so a constant is unique exactly where it needs to be.
 *
 * IT CAN NEVER MERGE WITH A NAMED PERSON
 * --------------------------------------
 * Two guarantees, one structural and one deliberate:
 *
 *   1. `self` is its own canonical kind. Two different SPECIFIC kinds never
 *      match — the same rule that keeps the company Mercury and the planet
 *      Mercury apart. A lookup for `person:Priya` never considers self.
 *
 *   2. The id-map entry is registered with NO norms. Nothing resolves to the
 *      self entity BY NAME at all; it is reachable only by its known id. So
 *      even a wildcard-kinded mention — the one path that does scan every
 *      kind — cannot reach it.
 *
 * Guarantee 2 is why aliases learned later live on the GRAPH node, for
 * display and enrichment, and are never registered as identity norms. An
 * alias in the identity map would make "Priya" resolve to self, quietly
 * fusing the user with a person who might be someone else entirely.
 *
 * PROVENANCE
 * ----------
 * `kind: 'declared'` — not 'derived' (nothing inferred it) and not 'observed'
 * (nothing extracted it). It exists by construction, and the kind says so
 * rather than borrowing a label that would imply evidence.
 *
 * Flagged by AQUA_SELF_ENTITY. Off by default, so the node does not appear in
 * entity listings or world stats until you choose. Rollback is the flag plus
 * deleting one node.
 */
import * as idStore from './idStore.js';

/** Stable across every owner; the graph and id map are owner-scoped already. */
export const SELF_GRAPH_ID     = 'ent:self:owner';
export const SELF_CANONICAL_ID = 'aq:self:owner';
export const SELF_KIND         = 'self';
export const SELF_LABEL        = 'You';

export const selfEntityEnabled = () => process.env.AQUA_SELF_ENTITY === 'on';

/**
 * Create the owner's self node if it does not exist. Idempotent.
 *
 * @param {object} deps  { graph }
 * @returns {object|null} the graph node, or null when disabled or on failure
 */
export function ensureSelfEntity(deps, ownerId) {
  if (!selfEntityEnabled() || !ownerId) return null;
  const G = deps?.graph;
  if (!G) return null;

  try {
    const node = G.upsertNode(ownerId, {
      id: SELF_GRAPH_ID,
      type: 'entity',
      label: SELF_LABEL,
      kind: 'declared',
      data: {
        entityType: SELF_KIND,
        isSelf: true,
        aliases: [],
        resolutionConfidence: 1,
      },
      sourceFiles: [],
    });

    // Registered with NO norms — see the header. This makes the entity
    // reachable by id (so the world-model join can find it) while leaving it
    // unreachable by name (so nothing can accidentally resolve into it).
    if (!idStore.getEntry(ownerId, SELF_CANONICAL_ID)) {
      idStore.putEntry(ownerId, SELF_CANONICAL_ID, {
        kind: SELF_KIND,
        canonical: SELF_LABEL,
        norms: [],
        refs: [{ space: 'reasoning', ref: SELF_GRAPH_ID }],
      });
    }
    return node;
  } catch (err) {
    console.warn(`[SELF] ensureSelfEntity failed (non-fatal): ${err?.message ?? err}`);
    return null;
  }
}

/** @returns {object|null} the owner's self node, without creating it. */
export function getSelfEntity(deps, ownerId) {
  try {
    return deps?.graph?.getNode?.(ownerId, SELF_GRAPH_ID)
        ?? deps?.graph?.nodesByType?.(ownerId, 'entity')?.find(n => n.id === SELF_GRAPH_ID)
        ?? null;
  } catch {
    return null;
  }
}

/**
 * Record a name the user is known by.
 *
 * ENRICHES, never replaces: the id, the canonical form and the label all stay
 * put, and the name is added as an alias on the graph node only. It is
 * deliberately NOT registered as an identity norm — doing so would make that
 * name resolve to the self entity, fusing the user with anyone who shares it.
 */
export function enrichSelf(deps, ownerId, { name = null } = {}) {
  if (!selfEntityEnabled() || !ownerId || !name) return null;
  const G = deps?.graph;
  if (!G) return null;

  try {
    const existing = getSelfEntity(deps, ownerId);
    if (!existing) return null;

    const aliases = [...new Set([...(existing.data?.aliases ?? []), String(name).trim()])]
      .filter(Boolean)
      .slice(0, 16);

    return G.upsertNode(ownerId, {
      id: SELF_GRAPH_ID,
      type: 'entity',
      label: SELF_LABEL,          // never becomes the name
      kind: 'declared',
      data: { ...existing.data, aliases },
    });
  } catch (err) {
    console.warn(`[SELF] enrichSelf failed (non-fatal): ${err?.message ?? err}`);
    return null;
  }
}
