/**
 * AQUA Brain — Canonical Identity Resolver (Phase 1)
 *
 * WHAT THIS SOLVES
 * ----------------
 * The audit found five identity spaces with no agreement between them:
 *
 *   reasoning graph   ent:<type>:<snake_name>     files (+ chat, once ingesting)
 *   mind graph        <type>:<lowercase label>    chat
 *   UKO entities      { type, value } — no id     per-file raw mentions
 *   memory facts      canonical `key` string      chat
 *   PIC subjects      fact id / memfact:<key>     derived
 *
 * The Brain federated two of them, at read time, by normalized string match.
 * The other three stayed disconnected — which is why `mind.goals[].relatedPeople`
 * is `["Priya"]`, a string, and a goal can never be traversed to the person
 * blocking it.
 *
 * This file mints one id per real thing. Every store keeps its own records;
 * they simply agree on which subject those records are about.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a store of knowledge. Not a write path anything routes through. Not a
 * replacement for entityResolver — it is that resolver made incremental.
 *
 * REUSE, NOT REIMPLEMENTATION
 * ---------------------------
 * `resolveEntities` is BATCH: it clusters a set of mentions against each
 * other in one pass. Canonical identity needs the incremental question —
 * "given one mention and a world that already exists, which id is this?" —
 * which that function cannot answer.
 *
 * So the scoring is not reimplemented. `mentionSimilarity`, `normalizeMention`
 * and both thresholds are imported from entityResolver, so a merge decision
 * made here and a merge decision made during file ingest can never disagree.
 * If those thresholds are ever tuned, both paths move together.
 *
 * THE AMBIGUITY RULE (audit R3)
 * -----------------------------
 * A score in [REVIEW, MERGE) is NOT a merge. Two people who share a first
 * name score high enough to look related and must never be folded into one
 * identity — the resolver already surfaces these as `ambiguous` rather than
 * merging them, and this file keeps that exact behaviour: a new id is minted
 * and the near-miss is reported so a human can decide.
 */
import {
  normalizeMention, mentionSimilarity, _thresholds,
} from '../../reasoning/entityResolver.js';
import * as idStore from './idStore.js';

const { MERGE_THRESHOLD, REVIEW_THRESHOLD } = _thresholds;

/**
 * The five spaces use five type vocabularies. This folds them into one.
 *
 * Anything unmapped passes through unchanged — the reasoning graph's type
 * registry is deliberately open, and an unknown kind is better than a wrong
 * one.
 */
const KIND_ALIASES = Object.freeze({
  // organizations
  org: 'org', organization: 'org', company: 'org', employer: 'org',
  // people
  person: 'person', people: 'person', contact: 'person',
  // work
  project: 'project', product: 'project', workspace: 'project',
  goal: 'goal', objective: 'goal',
  // things
  technology: 'technology', tech: 'technology', tool: 'technology',
  concept: 'concept', topic: 'concept',
  document: 'document', file: 'document', uko: 'document',
  conversation: 'conversation',
  place: 'place', location: 'place',
  event: 'event',
  // The owner themselves. Its own kind on purpose: two different SPECIFIC
  // kinds never match, so a lookup for a named person can never reach it.
  self: 'self',
});

/**
 * The file pipeline deliberately types every proper noun as `name` to protect
 * entity identity — it would rather under-type than guess wrong. The Mind
 * knows the semantic type because conversation supplies it.
 *
 * So `name` is a WILDCARD: it unifies with any specific kind. Without this,
 * `name:priya` from a document and `person:priya` from chat would mint two
 * ids and reintroduce exactly the fragmentation this file exists to remove.
 */
const WILDCARD_KIND = 'name';

/** Normalize any of the five vocabularies into one kind. */
export function canonicalKind(rawKind) {
  const k = String(rawKind ?? WILDCARD_KIND).trim().toLowerCase();
  return KIND_ALIASES[k] ?? k;
}

/** Slug for the id segment: normalized, spaces to underscores. */
export function slug(name) {
  return normalizeMention(name).replace(/\s+/g, '_');
}

/**
 * Mint an id.
 *
 * The kind is baked in at CREATION and the id is then immutable, while the
 * `kind` FIELD stays authoritative and may upgrade later. That split is
 * deliberate: an id that changed when a document-derived `name` was later
 * revealed by chat to be a `person` would break every reference already
 * written to it, which is the one thing a canonical id must never do.
 *
 * So `aq:name:priya_sharma` with `kind: 'person'` is normal and correct.
 * Read the id as opaque; read `kind` for the type.
 */
function mintId(kind, canonical) {
  return `aq:${kind}:${slug(canonical)}`;
}

/**
 * Resolve a mention to a canonical id, creating one if it is genuinely new.
 *
 * @param {string} ownerId
 * @param {object} args
 * @param {string} args.name      the surface form, e.g. "Priya Sharma"
 * @param {string} [args.kind]    that space's type, e.g. 'person' or 'name'
 * @param {object} [args.ref]     { space, ref } to link in the same call
 * @param {boolean} [args.create] false → look up without minting
 * @returns {{ id, kind, canonical, created, matched, score, ambiguous }|null}
 */
export function resolve(ownerId, { name, kind = WILDCARD_KIND, ref = null, create = true } = {}) {
  if (!ownerId || !name) return null;
  const norm = normalizeMention(name);
  if (!norm) return null;

  const wantKind = canonicalKind(kind);

  // 1. Exact normalized hit. Cheap and certain — the same shortcut
  //    resolveEntities takes before it agglomerates anything.
  //
  //    Tried in order of confidence: the same kind first; then a
  //    wildcard-kinded entry, which is the document pipeline's deliberate
  //    under-typing waiting to be upgraded; and only when the INCOMING
  //    mention is itself wildcard, any kind at all — an untyped "Mercury"
  //    from a document has no basis to prefer the company over the planet.
  //
  //    Two DIFFERENT specific kinds never match here. `org:Mercury` and
  //    `place:Mercury` are two subjects that happen to share a name.
  const exact =
    idStore.findByNorm(ownerId, norm, wantKind)
    ?? idStore.findByNorm(ownerId, norm, WILDCARD_KIND)
    ?? (wantKind === WILDCARD_KIND ? idStore.findByNormAnyKind(ownerId, norm) : null);

  if (exact) {
    const entry = idStore.getEntry(ownerId, exact);
    const upgraded = upgradeKind(entry?.kind, wantKind);
    idStore.putEntry(ownerId, exact, {
      kind: upgraded, canonical: name, norms: [norm],
      refs: ref ? [ref] : [],
    });
    return {
      id: exact, kind: upgraded, canonical: pickFuller(entry?.canonical, name),
      created: false, matched: 'exact', score: 1, ambiguous: null,
    };
  }

  // 2. Score against existing entries of the same kind, plus wildcard-kinded
  //    ones (the document side's deliberate under-typing) and — when the
  //    incoming mention is itself a wildcard — every specific kind, since a
  //    document's "Priya" should find chat's person:priya.
  const candidates = wantKind === WILDCARD_KIND
    ? [...idStore.allEntries(ownerId)].map(([id, entry]) => ({ id, entry }))
    : idStore.entriesOfKind(ownerId, wantKind, { includeWildcard: WILDCARD_KIND });

  let best = { id: null, entry: null, score: 0, reason: 'none' };
  let ambiguous = null;

  for (const { id, entry } of candidates) {
    for (const candNorm of entry.norms ?? []) {
      const s = mentionSimilarity(norm, candNorm);
      if (s.score > best.score) best = { id, entry, score: s.score, reason: s.reason };
    }
  }

  if (best.score >= MERGE_THRESHOLD) {
    const upgraded = upgradeKind(best.entry.kind, wantKind);
    idStore.putEntry(ownerId, best.id, {
      kind: upgraded, canonical: name, norms: [norm],
      refs: ref ? [ref] : [],
    });
    return {
      id: best.id, kind: upgraded, canonical: pickFuller(best.entry.canonical, name),
      created: false, matched: best.reason, score: round(best.score), ambiguous: null,
    };
  }

  // 3. Near-miss. NEVER merged — surfaced so a human can decide. Two people
  //    sharing a first name land here, and folding them together would be a
  //    far worse failure than carrying two ids.
  if (best.score >= REVIEW_THRESHOLD) {
    ambiguous = {
      against: best.id, canonical: best.entry.canonical,
      score: round(best.score), reason: best.reason,
    };
  }

  if (!create) {
    return { id: null, kind: wantKind, canonical: name, created: false, matched: 'none', score: round(best.score), ambiguous };
  }

  const id = mintId(wantKind, name);
  idStore.putEntry(ownerId, id, {
    kind: wantKind, canonical: name, norms: [norm],
    refs: ref ? [ref] : [],
  });
  return { id, kind: wantKind, canonical: name, created: true, matched: 'new', score: round(best.score), ambiguous };
}

/**
 * A wildcard kind yields to a specific one; a specific kind never yields.
 *
 * A stored `person` is not overwritten by an incoming `org`. A genuine type
 * conflict means the resolution is wrong, and silently taking the newer value
 * would hide that rather than fix it.
 */
function upgradeKind(storedKind, incomingKind) {
  const stored = storedKind ?? WILDCARD_KIND;
  if (stored === incomingKind) return stored;
  if (stored === WILDCARD_KIND) return incomingKind;
  return stored;
}

/** Attach a store reference to an id. Idempotent. */
export function link(ownerId, id, { space, ref } = {}) {
  return idStore.addRef(ownerId, id, { space, ref });
}

/** Where this subject's records actually live, across the five spaces. */
export function refs(ownerId, id) {
  return idStore.refsOf(ownerId, id);
}

/** Look up without minting — for read paths that must not create identity. */
export function lookup(ownerId, name, kind = WILDCARD_KIND) {
  return resolve(ownerId, { name, kind, create: false });
}

const round = (n) => Math.round(n * 100) / 100;
function pickFuller(a, b) {
  if (!a) return b ?? '';
  if (!b) return a;
  return b.length > a.length ? b : a;
}

export const _internals = { WILDCARD_KIND, MERGE_THRESHOLD, REVIEW_THRESHOLD, mintId, upgradeKind };