/**
 * AQUA — Relationship resolution, stage S7 (Blueprint E6/PR-8)
 *
 * Three rules, verbatim from the S7 box:
 *
 *   entity-object claims → edge upsert (typed, temporal, evidence-bound)
 *   direction from the PREDICATE, never from word order
 *   unknown predicate → proposal queue with usage count
 *
 * WHAT "DIRECTION FROM THE PREDICATE" ACTUALLY BUYS
 * -------------------------------------------------
 * The naive reading is from=subject, to=object. That is word order wearing a
 * different name, and it produces TWO edges for one relationship:
 *
 *   "I work at Nummo"     → self  --works_at-->  Nummo
 *   "Nummo employs me"    → Nummo --employs-->   self
 *
 * Same fact, two rows, pointing opposite ways. A k-hop walk then sees a cycle
 * that does not exist, dedup never fires because the rows differ, and the
 * relationship's evidence is split across two edges so neither looks
 * well-supported.
 *
 * So the PREDICATE picks the canonical end. `works_at` and `employs` are one
 * edge type, and a claim expressed either way lands on the same row.
 *
 * THE CANONICAL CHOICE IS ARBITRARY AND MUST BE STABLE
 * ----------------------------------------------------
 * Between `works_at` and `employs` there is no principled winner — both are
 * ordinary English. What matters is that the same pair always resolves the
 * same way, because instability means duplicate edges appearing over time as
 * the tiebreak drifts. Lexicographic order is used precisely BECAUSE it is
 * arbitrary: it cannot be argued with, it needs no table to maintain, and it
 * cannot change when someone edits a predicate's description.
 *
 * 🔴 ONE EXCEPTION, FORCED BY A REGISTRY DEFECT. Inverse pairs are supposed to
 * agree on `objectKind`, and one does not:
 *
 *   owns(literal)  ↔  owned_by(entity)
 *
 * Audited across all 31 predicates: every other inverse is reciprocal and
 * kind-consistent; this is the only offender. It matters here because
 * lexicographic order would canonicalise `owned_by` to `owns`, and `owns`
 * cannot legally hold an entity object — S4 gate ② would reject the very
 * claim this stage just created an edge for. So canonicalisation SKIPS an
 * inverse that is not itself entity-object, and the edge keeps the subject →
 * object direction.
 *
 * Reported, not silently fixed. Changing `owns` to entity-object is a
 * one-word registry edit that would alter what S4 accepts, which is a
 * behaviour change to a shipped gate and belongs in its own PR with its own
 * measurement.
 *
 * SYMMETRIC PREDICATES CANONICALISE THE ENDPOINTS, NOT THE TYPE
 * -------------------------------------------------------------
 * `knows` is its own inverse. "A knows B" and "B knows A" are the same edge,
 * so the two entity ids are sorted. Without that, mutual acquaintance produces
 * two rows and the graph reports twice the connections it has.
 *
 * NOT WIRED. No production caller, no flag. E6/PR-12 flips writers behind
 * `AQUA_EXTRACT_V2`.
 */
import { getPredicate, isRegistered } from '../../core/claims/predicateRegistry.js';

/**
 * Matches `MAX_EDGE_HISTORY` in reasoningGraph.js, which is not exported.
 * Duplicated deliberately rather than exporting from a hot production module,
 * and pinned by a test that reads the other file — two different bounds on one
 * ring buffer is the same class of defect as two different length floors.
 */
export const MAX_EDGE_HISTORY = 20;

/**
 * Which of an inverse pair names the edge?
 *
 * @returns {{ type: string, flip: boolean }} `flip` = swap subject and object
 */
export function chooseCanonical(spec, inverseSpec) {
  if (!spec) return { type: null, flip: false };

  // No inverse: the predicate is its own canonical form. `located_in` has no
  // partner and needs no decision.
  if (!spec.inverse) return { type: spec.name, flip: false };

  // Symmetric: the TYPE is already canonical; the endpoints get sorted instead
  // (see edgeFromClaim). Flipping here as well would undo that.
  if (spec.symmetric) return { type: spec.name, flip: false };

  // THE REGISTRY DEFECT. An inverse that cannot hold an entity object is not a
  // usable edge type, whatever lexicographic order says.
  //
  // ⚠️ THIS GUARD IS CURRENTLY REDUNDANT BY COINCIDENCE, and that is exactly
  // why it is a separate pure function. For the one broken pair,
  // `'owned_by' < 'owns'` happens to already pick the entity-side member, so
  // deleting the guard changes nothing today and fails no test that reads the
  // live registry. Rename either predicate — or add a second inconsistent
  // pair — and the coincidence evaporates silently. Taking specs as arguments
  // makes the invariant testable with a synthetic pair instead of resting on
  // an accident of alphabetical order.
  if (!inverseSpec || inverseSpec.objectKind !== 'entity') {
    return { type: spec.name, flip: false };
  }

  if (spec.name <= spec.inverse) return { type: spec.name, flip: false };
  return { type: spec.inverse, flip: true };
}

export function canonicalDirection(predicate) {
  const spec = getPredicate(predicate);
  if (!spec) return { type: predicate, flip: false };
  return chooseCanonical(spec, spec.inverse ? getPredicate(spec.inverse) : null);
}

/**
 * Turn one validated, temporally-normalised claim into an edge.
 *
 * @param {object} claim   subject/predicate/object, post-S4 and post-S5
 * @param {object} [opts]
 * @param {string} [opts.claimId]  the claim that asserts this edge — the truth
 * @param {number} [opts.now]      timestamp for first/last seen
 * @returns {{ok:boolean, edge:object|null, reason:string|null}}
 *
 * The edge table is DERIVED and REBUILDABLE — `claim_id` is the source of
 * truth. An edge without one is unrebuildable and unauditable, so it is
 * refused rather than written with a null.
 */
export function edgeFromClaim(claim, opts = {}) {
  const reject = reason => ({ ok: false, edge: null, reason });

  if (!claim || typeof claim !== 'object') return reject('not-a-claim');

  const predicate = claim.predicate;
  if (typeof predicate !== 'string' || !predicate) return reject('no-predicate');
  if (!isRegistered(predicate)) return reject('unregistered-predicate');

  const spec = getPredicate(predicate);
  // Only entity-object claims become edges. `prefers → "Postgres"` is a real
  // claim about a literal and belongs in the claim store, not the graph — an
  // edge to a string that was never resolved to an entity is a node nothing
  // else can ever reach.
  if (spec.objectKind !== 'entity') return reject('not-an-entity-object');

  const subject = claim.subject ?? null;
  const object = claim.object?.entity ?? claim.object?.value ?? null;
  if (!subject || !object) return reject('missing-endpoint');
  if (String(subject) === String(object)) {
    // A self-loop is almost always a resolution bug upstream ("Nummo employs
    // Nummo" from a mis-resolved pronoun) and it makes every traversal
    // non-terminating without a visited set.
    return reject('self-loop');
  }

  // A negated claim asserts the edge does NOT exist. Writing it as an edge and
  // hoping a reader checks polarity is how "Priya no longer works at Aquiplex"
  // becomes "Priya works at Aquiplex" two hops later.
  if ((claim.polarity ?? 'asserted') === 'negated') return reject('negated-claim');

  // Only `fact` becomes an edge. An intent ("I plan to join Zeta") and a
  // hypothetical ("if we merged with Zeta") are real claims about a world that
  // is not this one; materialising them would make the graph assert things
  // nobody said were true.
  const modality = claim.modality ?? 'fact';
  if (modality !== 'fact') return reject(`non-factual-modality:${modality}`);

  const claimId = opts.claimId ?? claim.claimId ?? claim.claim_id ?? null;
  if (!claimId) return reject('no-claim-id');

  const { type, flip } = canonicalDirection(predicate);
  let from = flip ? object : subject;
  let to = flip ? subject : object;

  // Symmetric: sort the endpoints so A↔B and B↔A are one row.
  if (getPredicate(type)?.symmetric && String(from) > String(to)) {
    [from, to] = [to, from];
  }

  const now = opts.now ?? Date.now();
  return {
    ok: true,
    reason: null,
    edge: Object.freeze({
      from, to, type,
      claimId,
      confidence: claim.confidence?.extraction ?? claim.confidence ?? null,
      validFrom: claim.validFrom ?? null,
      validTo: claim.validTo ?? null,
      state: 'active',
      firstSeenAt: now,
      lastSeenAt: now,
      history: Object.freeze([]),
      // Kept so a reader can see the claim said `employs` while the edge is
      // typed `works_at`. Without it, canonicalisation looks like the
      // extractor got the predicate wrong.
      assertedAs: predicate,
      flipped: flip,
    }),
  };
}

/** Identity of an edge for upsert purposes — type plus endpoints, nothing else. */
export const edgeKey = e => `${e.from}\u0000${e.type}\u0000${e.to}`;

/**
 * Upsert a batch of edges and queue unknown predicates.
 *
 * "unknown predicate → proposal queue with usage count". The count is the
 * point: one sighting of `enjoys_working_at` is noise, forty is a vocabulary
 * that is too small, and only a counter distinguishes them. Without it the
 * queue is a list of every typo a model ever made.
 */
export function resolveRelationships(claims, opts = {}) {
  const edges = new Map();
  const proposals = new Map();
  const rejected = [];
  const now = opts.now ?? Date.now();

  for (const claim of Array.isArray(claims) ? claims : []) {
    const predicate = claim?.predicate;
    if (typeof predicate === 'string' && predicate && !isRegistered(predicate)) {
      const p = proposals.get(predicate) ?? { predicate, usageCount: 0, examples: [] };
      p.usageCount++;
      // Bounded: a proposal seen four hundred times must not carry four
      // hundred quotes into memory. Three is enough to judge the predicate.
      if (p.examples.length < 3 && claim.statementText) p.examples.push(claim.statementText);
      proposals.set(predicate, p);
      continue;
    }

    const r = edgeFromClaim(claim, { ...opts, now });
    if (!r.ok) { rejected.push({ reason: r.reason, claim }); continue; }

    const key = edgeKey(r.edge);
    const existing = edges.get(key);
    if (!existing) { edges.set(key, r.edge); continue; }

    // UPSERT. The same relationship asserted twice is corroboration, not a
    // second edge: last-seen advances, the earliest first-seen is kept, and
    // the stronger confidence wins. The superseded value goes into the
    // bounded history ring so the change is auditable rather than lost.
    const merged = {
      ...existing,
      lastSeenAt: now,
      firstSeenAt: Math.min(existing.firstSeenAt, r.edge.firstSeenAt),
      confidence: Math.max(existing.confidence ?? 0, r.edge.confidence ?? 0),
      history: Object.freeze([...existing.history,
        { at: now, from: existing.confidence, to: r.edge.confidence, claimId: r.edge.claimId },
      ].slice(-MAX_EDGE_HISTORY)),
    };
    edges.set(key, Object.freeze(merged));
  }

  return {
    edges: [...edges.values()],
    proposals: [...proposals.values()].sort((a, b) => b.usageCount - a.usageCount),
    rejected,
    stats: {
      seen: Array.isArray(claims) ? claims.length : 0,
      edges: edges.size,
      proposals: proposals.size,
      rejected: rejected.length,
      byReason: rejected.reduce((a, r) => ({ ...a, [r.reason]: (a[r.reason] ?? 0) + 1 }), {}),
    },
  };
}
