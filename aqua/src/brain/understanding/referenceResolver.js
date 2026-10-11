/**
 * AQUA — S6½: resolving references the minter must refuse (2026-10-04).
 *
 * "My company launched", "our team shipped", "it is blocked", "the project
 * slipped". The minter correctly refuses to mint an entity called "my company"
 * or "it" (an entity named after a role or a pronoun would absorb every later
 * claim). Refusing, though, LOSES the claim. This step resolves such a
 * reference against the owner's EXISTING World Model, and only when that is
 * unambiguous:
 *
 *   exactly one candidate  → the claim end takes that entity's name (the minter
 *                            then reuses its id) and the claim records HOW
 *                            (`reference`: surface, method, via) — persisted in
 *                            the evidence locator (L4)
 *   several candidates     → NOT resolved; the claim stays uncommitted with
 *                            `reference.ambiguous` (uncertainty preserved,
 *                            never a guess)
 *   none                   → NOT resolved (the claim stays uncommitted, as before)
 *
 * Methods, each from the owner's own data only (L19):
 *   pronoun     "it/they/that/…" → the non-self entities claimed in the
 *               PREVIOUS turn of the same conversation
 *   role        "my/our company|manager|team…" → the object of the user's
 *               current works_at / reports_to / member_of (by entity TYPE
 *               self, never by label — L8)
 *   head-noun   "the/our/that <…> launch" → the one entity whose label ends
 *               with that noun
 * Deliberately NOT resolved: location roles ("our office", "my city"). The
 * user's located_in object is a PLACE; resolving "our office" to it would turn
 * "where the office is" into "the office" — a false fact.
 *
 * Pure: the lookup is injected. Applies only to claim ends the minter would
 * refuse, so every previously-mintable surface behaves exactly as before.
 */
import { TIER } from './entityResolution.js';
import { isMintableSurface } from './provisionalMinter.js';

const PRONOUN = /^(it|its|they|them|that|this|those|these|he|she|him|her)$/i;
const POSSESSIVE = /^(my|our)\s+([a-z][a-z'-]*)$/i;
const DEFINITE = /^(my|our|the|that|this)\s+(.+)$/i;
export const WRITE_ROLE_NOUNS = Object.freeze({
  company: ['works_at', 'member_of', 'founded'], employer: ['works_at'], startup: ['works_at', 'founded', 'member_of'],
  business: ['works_at', 'founded', 'member_of'], firm: ['works_at', 'member_of'],
  organisation: ['works_at', 'member_of'], organization: ['works_at', 'member_of'], org: ['works_at', 'member_of'],
  workplace: ['works_at'], manager: ['reports_to'], boss: ['reports_to'], supervisor: ['reports_to'],
  team: ['member_of'], group: ['member_of'], club: ['member_of'],
});
const LOCATION_ROLES = new Set(['office', 'city', 'hometown', 'base', 'place', 'country']);

/** What kind of reference is this surface, if any? */
export function classifyReference(surface) {
  const s = String(surface ?? '').trim().replace(/[.!?,]+$/, '');
  if (!s) return null;
  if (PRONOUN.test(s)) return { method: 'pronoun', surface: s };
  const p = POSSESSIVE.exec(s);
  if (p) {
    const noun = p[2].toLowerCase().replace(/'s$/, '');
    if (LOCATION_ROLES.has(noun)) return { method: 'location-role', surface: s, noun, unresolvable: true };
    if (WRITE_ROLE_NOUNS[noun]) return { method: 'role', surface: s, noun, predicates: WRITE_ROLE_NOUNS[noun] };
  }
  const d = DEFINITE.exec(s);
  if (d) {
    const words = d[2].toLowerCase().split(/\s+/).filter(Boolean);
    const head = (words[words.length - 1] ?? '').replace(/'s$/, '');
    if (head.length >= 3) return { method: 'head-noun', surface: s, head };
  }
  return null;
}

/**
 * @param {object[]} claims  S6 output (each with `.resolution`)
 * @param {object} lookup    { pronoun() → cands, role(predicates) → cands, headNoun(head) → cands }
 *                           each cand { label, via?, claimId? }; async allowed
 */
export async function resolveReferences(claims, lookup) {
  const stats = { resolved: 0, ambiguous: 0, unresolved: 0, byMethod: {} };
  const out = [];
  for (const c of claims ?? []) {
    const r = c?.resolution;
    if (!r || r.ready) { out.push(c); continue; }
    const next = { ...c, resolution: { ...r } };
    let touched = false;
    for (const sideName of ['subject', 'object']) {
      const side = r[sideName];
      if (!side || side.tier !== TIER.PROVISIONAL || !side.provisional) continue;
      if (sideName === 'object' && c.objectKind !== 'entity') continue;
      const surface = side.proposedName;
      if (isMintableSurface(surface).ok) continue;           // the minter handles it as before
      const ref = classifyReference(surface);
      if (!ref || ref.unresolvable) {
        if (ref) { stats.unresolved++; next.resolution[sideName] = { ...side, reference: { ...ref, outcome: 'unresolved' } }; touched = true; }
        continue;
      }
      let cands = [];
      try {
        cands = ref.method === 'pronoun' ? await lookup.pronoun()
          : ref.method === 'role' ? await lookup.role(ref.predicates)
          : await lookup.headNoun(ref.head);
      } catch { cands = []; }
      const unique = [...new Map((cands ?? []).filter(x => x?.label).map(x => [String(x.label).toLowerCase(), x])).values()];
      stats.byMethod[ref.method] = (stats.byMethod[ref.method] ?? 0) + 1;
      if (unique.length === 1) {
        stats.resolved++;
        const [hit] = unique;
        next.resolution[sideName] = { ...side, proposedName: hit.label,
          reference: { surface, method: ref.method, resolvedTo: hit.label, via: hit.via ?? null, claimId: hit.claimId ?? null, outcome: 'resolved' } };
        next._references = [...(next._references ?? []), { end: sideName, surface, method: ref.method, resolvedTo: hit.label, via: hit.via ?? null }];
      } else if (unique.length > 1) {
        stats.ambiguous++;
        next.resolution[sideName] = { ...side, reference: { surface, method: ref.method, outcome: 'ambiguous', candidates: unique.length } };
        next.resolution.blockedBy = `${sideName}:ambiguous-reference`;
      } else {
        stats.unresolved++;
        next.resolution[sideName] = { ...side, reference: { surface, method: ref.method, outcome: 'unresolved' } };
      }
      touched = true;
    }
    out.push(touched ? next : c);
  }
  return { claims: out, stats };
}
