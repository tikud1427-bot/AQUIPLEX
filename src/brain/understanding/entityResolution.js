/**
 * AQUA — Entity resolution, stage S6 (Blueprint)
 *
 *   ① exact normalized match  ② alias match  ③ trigram fuzzy
 *
 * ⚠️ THREE MEASURED GAPS BETWEEN THE SPEC AND THE FUNCTION THIS REUSES,
 * reported rather than papered over — each is a property of
 * `reasoning/entityResolver.js`, which ships and is used elsewhere, so none is
 * changed here:
 *
 *   1. TIER ③ IS NOT TRIGRAM. `mentionSimilarity` scores token overlap,
 *      subset and acronyms; there is no character-level comparison. `Numo` vs
 *      `Nummo` scores 0.000, so a typo creates a duplicate entity rather than
 *      resolving. Tier ③ is named `token-overlap` here for that reason.
 *
 *   2. THE REVIEW BAND IS ESSENTIALLY DEAD. Scores cluster at 1.00 (exact),
 *      0.86/0.84 (subset) and ~0.33 (partial overlap); realistic name pairs
 *      almost never land between REVIEW 0.62 and MERGE 0.82. The band the
 *      blueprint reserves for tier ⑤'s "narrow band" is therefore rarely the
 *      ambiguity that matters. The live one is MULTIPLE candidates ABOVE the
 *      merge threshold — two `Rahul`s both scoring 0.84 — and that is handled
 *      as the primary ambiguity case below.
 *
 *   3. SUFFIX STRIPPING IS BROAD. `Inc · Ltd · Group · Holdings · Labs ·
 *      Systems` all strip, so "Nummo Labs" and "Nummo" resolve to one entity.
 *      Correct for the cross-file dedup this function was built for; in a
 *      personal graph a subsidiary and its parent are arguably two employers.
 *      Flagged, not changed — the normaliser has other callers.
 *   ④ embedding similarity ≥τ  ⑤ LLM disambiguation ONLY for the narrow band
 *   first-person → owner self entity by GRAMMAR (never surface form)
 *   never-fuse invariant enforced here, pinned by negative test
 *   no confident match → NEW entity, provisional, merge-reviewable
 *
 * WHY THIS UNBLOCKS S7–S9
 * -----------------------
 * The pipeline stops at S5 because without resolution a subject is a surface
 * string. E6/PR-8 refuses to build an edge from one — "an edge to a string
 * that was never resolved to an entity is a node nothing else can ever reach".
 * S6 is what turns `"Nummo"` into an id, and only then do relationships,
 * dedup and commit have anything real to work on.
 *
 * IT REUSES THE SHIPPED RESOLVER RATHER THAN SCORING AGAIN
 * --------------------------------------------------------
 * `reasoning/entityResolver.js` already normalises mentions (casefold, strip
 * Inc/Ltd/LLC, drop honorifics) and scores pairs with a similarity that
 * rewards token-subset and acronym matches and PENALISES conflicting tokens.
 * Its thresholds — merge 0.82, review 0.62 — are tuned and shipped. A second
 * scorer here would drift from it, and the drift would surface as two
 * "Nummo"s in the graph: one resolved by this module and one by that.
 *
 * So tier ① is its `normalizeMention` and tier ③ is its `mentionSimilarity`.
 * This module adds the OWNER-SCOPED STORE LOOKUP those functions do not do,
 * the alias tier, deixis, and provisional creation.
 *
 * 🔴 THE NEVER-FUSE INVARIANT IS THE POINT OF THE DEIXIS BRANCH
 * -------------------------------------------------------------
 * "Deixis is not a name; `I`/`my`/`we` never touch the id store." Described in
 * the blueprint as correct and hard-won, and pinned by an existing negative
 * test.
 *
 * The failure it prevents: `I` gets normalised and looked up, matches nothing,
 * and a provisional entity named "i" is created — per owner, forever, silently
 * accumulating every first-person claim under a node that is not a person. Or
 * worse, fuzzy-matches a real short name and fuses the speaker into somebody
 * else.
 *
 * So first person resolves to the owner's self entity BY GRAMMAR, BEFORE any
 * normalisation or lookup, and the store is never consulted. There is no
 * threshold involved and no way for a similarity score to override it.
 *
 * ⚠️ TIERS ④ AND ⑤ ARE INJECTED AND ABSENT BY DEFAULT. Embedding similarity
 * needs a provider and τ has not been measured; LLM disambiguation needs one
 * too and is specified for "the narrow band" only. Both are optional
 * parameters, and a pair in the review band with neither supplied is reported
 * AMBIGUOUS rather than guessed — which is what the shipped resolver already
 * does with the same band.
 *
 * NOT WIRED. No production caller, no flag.
 */
import { normalizeMention, mentionSimilarity, _thresholds } from '../../reasoning/entityResolver.js';

export const { MERGE_THRESHOLD, REVIEW_THRESHOLD } = _thresholds;

/**
 * First-person deixis. Matched as WHOLE tokens against the raw surface, before
 * normalisation, because normalising is itself a store-shaped operation and
 * the invariant is that these never get that far.
 *
 * `self` is included because it is the extractor's own token for the speaker
 * (E6/PR-4's contract defines it), not an English pronoun.
 */
const DEIXIS = new Set([
  'self', 'i', 'me', 'my', 'mine', 'myself',
  'we', 'us', 'our', 'ours', 'ourselves',
]);

export const isDeixis = surface =>
  DEIXIS.has(String(surface ?? '').trim().toLowerCase().replace(/[.!?,]+$/, ''));

/** Resolution outcomes, in the order the blueprint lists the tiers. */
export const TIER = Object.freeze({
  SELF: 'self-grammar',
  EXACT: 'exact-normalized',
  ALIAS: 'alias',
  // NOT 'trigram-fuzzy'. The blueprint names tier ③ that way, and the shipped
  // similarity function does TOKEN overlap, subset and acronym matching with no
  // character-level comparison anywhere. Measured: `Numo` vs `Nummo` — a
  // one-character typo, exactly what trigram fuzzy exists for — scores 0.000
  // and mints a duplicate entity. Naming the tier for what it does keeps the
  // gap visible instead of letting the label imply coverage that is not there.
  FUZZY: 'token-overlap',
  EMBEDDING: 'embedding',
  DISAMBIGUATED: 'llm-disambiguation',
  PROVISIONAL: 'new-provisional',
  AMBIGUOUS: 'ambiguous',
});

/**
 * Resolve one surface form against an owner's entity store.
 *
 * @param {string} surface
 * @param {object} store  owner-scoped reader:
 *   `byNormalized(norm) → entity|null` · `byAlias(norm) → entity|null` ·
 *   `all() → entity[]`
 * @param {object} [opts]
 * @param {string} [opts.selfEntityId]   required to resolve deixis
 * @param {Function} [opts.embeddingMatch] async (surface, candidates) → entity|null
 * @param {Function} [opts.disambiguate]  async (surface, candidates) → entity|null
 * @returns {Promise<{entityId:string|null, tier:string, provisional:boolean,
 *                    candidates?:object[], score?:number, reason?:string}>}
 */
export async function resolveSurface(surface, store, opts = {}) {
  const raw = String(surface ?? '').trim();
  if (!raw) return { entityId: null, tier: TIER.PROVISIONAL, provisional: true, reason: 'empty' };

  // ── DEIXIS, BEFORE ANYTHING ELSE ─────────────────────────────────────────
  // No normalisation, no lookup, no score. See the header.
  if (isDeixis(raw)) {
    return opts.selfEntityId
      ? { entityId: opts.selfEntityId, tier: TIER.SELF, provisional: false }
      : { entityId: null, tier: TIER.SELF, provisional: false, reason: 'no-self-entity' };
  }

  const norm = normalizeMention(raw);
  if (!norm) return { entityId: null, tier: TIER.PROVISIONAL, provisional: true, reason: 'empty-after-normalize' };

  // ── ① EXACT NORMALIZED ───────────────────────────────────────────────────
  const exact = store?.byNormalized?.(norm) ?? null;
  if (exact) return { entityId: exact.entityId ?? exact.id, tier: TIER.EXACT, provisional: false };

  // ── ② ALIAS ──────────────────────────────────────────────────────────────
  const alias = store?.byAlias?.(norm) ?? null;
  if (alias) return { entityId: alias.entityId ?? alias.id, tier: TIER.ALIAS, provisional: false };

  // ── ③ TRIGRAM FUZZY ──────────────────────────────────────────────────────
  const scored = (store?.all?.() ?? [])
    .map(e => ({ entity: e, ...mentionSimilarity(norm, normalizeMention(e.name ?? e.canonical ?? '')) }))
    .filter(c => c.score >= REVIEW_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  const above = scored.filter(c => c.score >= MERGE_THRESHOLD);

  if (above.length === 1) {
    return { entityId: above[0].entity.entityId ?? above[0].entity.id, tier: TIER.FUZZY,
      provisional: false, score: above[0].score, reason: above[0].reason };
  }

  // MULTIPLE above the merge threshold is the narrow band ⑤ is for, and it is
  // also the most dangerous case in the whole stage: picking the top score
  // when two candidates are both confident is how two distinct "John"s get
  // fused, which the shipped resolver's header calls "the cardinal failure of
  // a reasoning graph".
  const band = above.length > 1 ? above : scored;

  if (band.length > 0) {
    // ── ④ EMBEDDING, ⑤ LLM — only when supplied ────────────────────────────
    if (typeof opts.embeddingMatch === 'function') {
      const hit = await opts.embeddingMatch(raw, band.map(c => c.entity));
      if (hit) return { entityId: hit.entityId ?? hit.id, tier: TIER.EMBEDDING, provisional: false };
    }
    if (band.length > 1 && typeof opts.disambiguate === 'function') {
      const hit = await opts.disambiguate(raw, band.map(c => c.entity));
      if (hit) return { entityId: hit.entityId ?? hit.id, tier: TIER.DISAMBIGUATED, provisional: false };
    }

    if (above.length > 1) {
      return { entityId: null, tier: TIER.AMBIGUOUS, provisional: false,
        candidates: band.map(c => ({ entityId: c.entity.entityId ?? c.entity.id, score: c.score })),
        reason: 'multiple-above-merge-threshold' };
    }
    // Review band with nothing to break the tie. Surfaced, never auto-merged —
    // the same call the shipped resolver makes for the same band.
    return { entityId: null, tier: TIER.AMBIGUOUS, provisional: false,
      candidates: band.map(c => ({ entityId: c.entity.entityId ?? c.entity.id, score: c.score })),
      reason: 'review-band' };
  }

  // ── NO CONFIDENT MATCH → NEW, PROVISIONAL, MERGE-REVIEWABLE ──────────────
  return { entityId: null, tier: TIER.PROVISIONAL, provisional: true,
    proposedName: raw, normalized: norm };
}

/**
 * Resolve a claim's subject and entity-object.
 *
 * A claim is only READY for S7 when both ends resolved to an id. Ambiguity and
 * provisional creation both leave it unready, and the caller is told which —
 * an ambiguous subject needs adjudication, a provisional one needs an insert,
 * and treating them alike would either create duplicates or block on nothing.
 */
export async function resolveClaimEntities(claim, store, opts = {}) {
  const subject = await resolveSurface(claim?.subject, store, opts);
  const objectIsEntity = claim?.objectKind === 'entity';
  const object = objectIsEntity
    ? await resolveSurface(claim?.object?.entity, store, opts)
    : { entityId: null, tier: null, provisional: false, reason: 'not-an-entity-object' };

  const ready = Boolean(subject.entityId) && (!objectIsEntity || Boolean(object.entityId));

  return {
    claim,
    subject,
    object,
    ready,
    // Only a READY claim may reach S7. Anything else would mint an edge to a
    // node that does not exist yet, or to the wrong one.
    blockedBy: ready ? null
      : (!subject.entityId ? `subject:${subject.tier}` : `object:${object.tier}`),
  };
}

/** Resolve a batch, reporting which tier did the work. */
export async function resolveBatch(claims, store, opts = {}) {
  const results = [];
  const byTier = {};
  for (const c of Array.isArray(claims) ? claims : []) {
    const r = await resolveClaimEntities(c, store, opts);
    results.push(r);
    for (const side of [r.subject, r.object]) {
      if (side?.tier) byTier[side.tier] = (byTier[side.tier] ?? 0) + 1;
    }
  }
  return {
    results,
    ready: results.filter(r => r.ready),
    stats: {
      seen: results.length,
      ready: results.filter(r => r.ready).length,
      ambiguous: results.filter(r => r.subject.tier === TIER.AMBIGUOUS || r.object.tier === TIER.AMBIGUOUS).length,
      provisional: results.filter(r => r.subject.provisional || r.object.provisional).length,
      byTier,
    },
  };
}
