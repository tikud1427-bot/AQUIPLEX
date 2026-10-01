/**
 * AQUA — Provisional entity minter, the missing half of stage S6
 * Blueprint E6/S6 · L8 (one thing, one opaque id) · L11 · L19
 *
 * THE SPEC SAYS: "no confident match → NEW entity, provisional, merge-reviewable".
 * THE CODE DID: resolve the "no match" case, label it `new-provisional`, and stop.
 * `resolveClaimEntities` marks such a claim UNREADY ("a provisional one needs an
 * insert"), `readyForS7` filters it out, and NOTHING in the tree performed the
 * insert — grep for `provisional` outside the resolver and the pipeline finds a
 * log line.
 *
 * MEASURED, against real Postgres with a stub model: "I work at Intercom."
 * → subject resolves to the owner's self entity, object is `new-provisional`,
 * `ready: 0`, `blockedBy: object:new-provisional`, zero rows in aqua_claims.
 * Every claim about a name the legacy regex ingest had not already minted died
 * at this seam, silently, counted in `s6.provisional` and nowhere else. The loop
 * the blueprint is built around — understand, commit, retrieve, apply — could
 * only ever learn about things it already knew.
 *
 * WHAT THIS DOES — and deliberately nothing more
 * ----------------------------------------------
 * For each claim end that S6 called PROVISIONAL (never ambiguous, never deixis,
 * never a literal), ask the existing canonical identity resolver to mint an id,
 * then mark that end resolved with tier `minted`. It writes through the SAME
 * `canonicalId.resolve` the ingest path uses, so there is still one identity
 * space (L2/L8), and it is injected, so this module holds no state and imports
 * no store.
 *
 * UNDER-TYPED ON PURPOSE. Minted as the wildcard kind `name`, which the identity
 * layer defines as "unifies with any specific kind later". The extractor knows a
 * surface form, not whether Intercom is a company; guessing would fragment the
 * identity the way `org:Mercury` / `place:Mercury` shows it can.
 *
 * WHAT IT REFUSES, AND WHY EACH IS A SEPARATE LINE
 * ------------------------------------------------
 *  · pronouns, demonstratives and indefinites — "it", "this", "someone" are not
 *    things, and an entity called "it" would absorb every later claim;
 *  · determiner-led descriptions — "my manager", "the project" are roles, not
 *    names. Capitalised tails ("The Hague") pass: that IS a name;
 *  · anything without a letter, URLs, e-mail addresses, absurd lengths;
 *  · AMBIGUOUS ends — two candidates above the merge threshold need adjudication,
 *    and minting a third is exactly the fusion/duplication S6 refused to guess;
 *  · more than MAX_MINTS_PER_TURN — a model that emits fifty "entities" in one
 *    turn is a malfunction to bound, not a world to record.
 * Every refusal is COUNTED BY REASON, because a silent refusal is the dark stage
 * this module exists to remove (L13).
 */
import { TIER, isDeixis } from './entityResolution.js';

export const MINTED_TIER = 'minted';
export const MINT_KIND = 'name';          // identity layer's wildcard kind
export const MAX_MINTS_PER_TURN = 8;
const MAX_CHARS = 80;
const MAX_TOKENS = 6;

const PRONOUNS = new Set([
  'it', 'its', 'this', 'that', 'these', 'those', 'them', 'they', 'one', 'ones',
  'someone', 'somebody', 'something', 'anyone', 'anybody', 'anything',
  'everyone', 'everybody', 'everything', 'nobody', 'nothing', 'none',
  'who', 'what', 'which', 'there', 'here', 'other', 'others', 'another',
]);
const DETERMINERS = new Set([
  'a', 'an', 'the', 'my', 'our', 'your', 'his', 'her', 'their', 'some', 'any',
  'each', 'every', 'no', 'this', 'that', 'these', 'those',
]);

/** @returns {{ok:boolean, reason?:string}} */
export function isMintableSurface(surface) {
  const raw = String(surface ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty' };
  if (raw.length > MAX_CHARS) return { ok: false, reason: 'too-long' };
  if (!/\p{L}/u.test(raw)) return { ok: false, reason: 'no-letter' };
  if (/@|https?:\/\/|www\./i.test(raw)) return { ok: false, reason: 'not-a-name' };
  if (isDeixis(raw)) return { ok: false, reason: 'deixis' };

  const tokens = raw.split(/\s+/);
  if (tokens.length > MAX_TOKENS) return { ok: false, reason: 'too-many-tokens' };

  const lower = tokens.map(t => t.toLowerCase().replace(/[^\p{L}\p{N}']/gu, ''));
  if (tokens.length === 1 && PRONOUNS.has(lower[0])) return { ok: false, reason: 'pronoun' };
  if (lower.every(t => PRONOUNS.has(t))) return { ok: false, reason: 'pronoun' };

  if (DETERMINERS.has(lower[0]) && tokens.length > 1) {
    const tail = tokens.slice(1);
    const allCapitalised = tail.every(t => /^\p{Lu}/u.test(t));
    if (!allCapitalised) return { ok: false, reason: 'description' };
  }
  if (tokens.length === 1 && DETERMINERS.has(lower[0])) return { ok: false, reason: 'description' };
  return { ok: true };
}

/**
 * Mint ids for provisional claim ends and recompute readiness. PURE with respect
 * to its input: returns new claim objects, never mutates the ones it was given.
 *
 * @param {object[]} claims   S6 output (each with `.resolution`)
 * @param {object} args
 * @param {string} args.ownerId
 * @param {(ownerId:string, spec:{name:string, kind:string}) => ({id?:string, created?:boolean, ambiguous?:any}|null)} args.mint
 * @param {number} [args.max]
 * @returns {{claims:object[], readyForS7:object[], stats:{minted:number, reused:number, refused:Record<string,number>}}}
 */
export function mintProvisionalEntities(claims, { ownerId, mint, max = MAX_MINTS_PER_TURN } = {}) {
  const stats = { minted: 0, reused: 0, refused: {} };
  const refuse = (reason) => { stats.refused[reason] = (stats.refused[reason] ?? 0) + 1; };
  if (!ownerId || typeof mint !== 'function') {
    return { claims: claims ?? [], readyForS7: (claims ?? []).filter(c => c?.resolution?.ready), stats };
  }

  const settleSide = (side) => {
    if (!side || side.tier !== TIER.PROVISIONAL || side.provisional !== true) return side;
    const name = side.proposedName;
    const verdict = isMintableSurface(name);
    if (!verdict.ok) { refuse(verdict.reason); return side; }
    if (stats.minted >= max) { refuse('turn-cap'); return side; }

    let got = null;
    try { got = mint(ownerId, { name, kind: MINT_KIND }); }
    catch { refuse('mint-threw'); return side; }

    if (!got?.id) { refuse('mint-returned-no-id'); return side; }
    if (got.ambiguous) { refuse('identity-ambiguous'); return side; }
    if (got.created) stats.minted++; else stats.reused++;
    return { ...side, entityId: got.id, tier: MINTED_TIER, provisional: false, minted: Boolean(got.created) };
  };

  const out = (claims ?? []).map((c) => {
    const r = c?.resolution;
    if (!r || r.ready) return c;
    const subject = settleSide(r.subject);
    const object = settleSide(r.object);
    const objectIsEntity = c.objectKind === 'entity';
    const ready = Boolean(subject?.entityId) && (!objectIsEntity || Boolean(object?.entityId));
    if (subject === r.subject && object === r.object) return c;       // nothing changed
    return {
      ...c,
      subjectEntityId: subject?.entityId ?? c.subjectEntityId ?? null,
      objectEntityId: object?.entityId ?? c.objectEntityId ?? null,
      resolution: {
        subject, object, ready,
        blockedBy: ready ? null
          : (!subject?.entityId ? `subject:${subject?.tier}` : `object:${object?.tier}`),
      },
    };
  });

  return { claims: out, readyForS7: out.filter(c => c?.resolution?.ready), stats };
}
