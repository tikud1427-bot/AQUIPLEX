/**
 * AQUA Identity — Canonical Structured State (v4)
 * ─────────────────────────────────────────────────────────────────────────────
 * The design premise, stated plainly:
 *
 *     Identity is NOT semantic recall. Identity is structured state.
 *
 * "What is my name?" must never depend on vector similarity, ranking scores,
 * a token budget, or which other facts happen to be important today. The
 * answer is a definite field the user told us, retrieved DIRECTLY.
 *
 * This module is a thin CANONICAL VIEW over the field-isolated fact layer
 * (longTermMemory → mind.facts). It deliberately owns NO persistence of its
 * own: each identity attribute already lives in its own fact key (`name`,
 * `preferred_name`, `profession`, `workplace`, `city`, …), which is exactly
 * what guarantees field-level independence — updating `workplace` cannot touch
 * `name`, because they are different keys with different lifecycles. What was
 * missing was (a) a canonical object assembled from those keys, and (b) a
 * retrieval path that bypasses the semantic ranker for identity questions.
 * Both live here.
 *
 * Responsibilities:
 *   getIdentity(owner)        → the canonical Identity object (present fields
 *                               only, each with value/confidence/provenance)
 *   formatIdentityBlock(id)   → authoritative, definite prompt block
 *   isIdentityQuery(query)    → "who am I / what's my name / what company…"
 *   answerIdentityQuery(id,q) → the identity card, chosen by the question,
 *                               read straight from canonical state (no ranker)
 *   IDENTITY_FACT_KEYS        → the set of fact keys this layer owns (used by
 *                               retrieval + migration to reason about identity)
 */
import { getFact } from './longTermMemory.js';

// ── Canonical field map ───────────────────────────────────────────────────────
// canonical : the stable public field name on the Identity object
// factKey   : the underlying isolated key in mind.facts (single source of data)
// kind      : 'scalar' | 'set'
// label     : how it renders in the identity block
// role/company map onto the pre-existing `profession`/`workplace` keys so the
// whole extraction + storage + conflict pipeline is reused unchanged.
export const IDENTITY_FIELDS = Object.freeze([
  { canonical: 'name',                factKey: 'name',                kind: 'scalar', label: 'Name' },
  { canonical: 'preferred_name',      factKey: 'preferred_name',      kind: 'scalar', label: 'Preferred name' },
  { canonical: 'aliases',             factKey: 'aliases',             kind: 'set',    label: 'Also known as' },
  { canonical: 'pronouns',            factKey: 'pronouns',            kind: 'scalar', label: 'Pronouns' },
  { canonical: 'age',                 factKey: 'age',                 kind: 'scalar', label: 'Age' },
  { canonical: 'birthday',            factKey: 'birthday',            kind: 'scalar', label: 'Birthday' },
  { canonical: 'role',                factKey: 'profession',          kind: 'scalar', label: 'Role' },
  { canonical: 'company',             factKey: 'workplace',           kind: 'scalar', label: 'Company' },
  { canonical: 'organization',        factKey: 'organization',        kind: 'scalar', label: 'Organization' },
  { canonical: 'education',           factKey: 'education',            kind: 'scalar', label: 'Education' },
  { canonical: 'city',                factKey: 'city',                kind: 'scalar', label: 'City' },
  { canonical: 'country',             factKey: 'country',             kind: 'scalar', label: 'Country' },
  { canonical: 'timezone',            factKey: 'timezone',            kind: 'scalar', label: 'Timezone' },
  { canonical: 'language',            factKey: 'language',            kind: 'scalar', label: 'Language' },
  { canonical: 'relationship_status', factKey: 'relationship_status', kind: 'scalar', label: 'Relationship' },
]);

export const IDENTITY_FACT_KEYS = Object.freeze(new Set(IDENTITY_FIELDS.map(f => f.factKey)));

const FIELD_BY_CANONICAL = new Map(IDENTITY_FIELDS.map(f => [f.canonical, f]));

const MIN_IDENTITY_CONF = 0.5;

// ── Canonical object ──────────────────────────────────────────────────────────
/**
 * Assemble the canonical Identity object for an owner from the isolated fact
 * keys. Absent fields are simply absent — the object shape is sparse, never a
 * grab-bag of nulls. Each present field carries its provenance.
 *
 * @returns {Object<string, { value:*, confidence:number, updatedAt:number,
 *          factKey:string, kind:string, label:string }>}
 */
export function getIdentity(ownerId) {
  const identity = {};
  if (!ownerId) return identity;
  for (const field of IDENTITY_FIELDS) {
    const fact = getFact(ownerId, field.factKey);
    if (!fact || fact.value === null || fact.value === undefined) continue;
    if (fact.value === '' || (Array.isArray(fact.value) && fact.value.length === 0)) continue;
    if ((fact.confidence ?? 1) < MIN_IDENTITY_CONF) continue;
    identity[field.canonical] = {
      value: fact.value,
      confidence: fact.confidence ?? 1,
      updatedAt: fact.updatedAt ?? fact.ts ?? 0,
      factKey: field.factKey,
      kind: field.kind,
      label: field.label,
    };
  }
  return identity;
}

export function hasIdentity(identity) {
  return !!identity && Object.keys(identity).length > 0;
}

/** Flat convenience view: { name: 'Chhanda', company: 'Aquiplex', … }. */
export function identityValues(identity) {
  const out = {};
  for (const [k, v] of Object.entries(identity || {})) out[k] = v.value;
  return out;
}

// ── Display ───────────────────────────────────────────────────────────────────
const TITLE_CASE_FIELDS = new Set(['role']); // role captured lower-case ("founder")

function titleCase(s) {
  return String(s).replace(/\b\w/g, c => c.toUpperCase());
}

function displayValue(canonical, value) {
  if (Array.isArray(value)) {
    return value.map(v => (typeof v === 'object' && v?.name ? v.name : String(v))).join(', ');
  }
  if (TITLE_CASE_FIELDS.has(canonical) && typeof value === 'string') return titleCase(value);
  return String(value);
}

/**
 * The authoritative identity block. Definite, first-person-of-the-user framing.
 * `fields` optionally restricts which fields to render (used to answer a
 * specific identity question); default renders the whole card.
 */
export function formatIdentityBlock(identity, { fields = null } = {}) {
  if (!hasIdentity(identity)) return '';
  const order = IDENTITY_FIELDS.map(f => f.canonical);
  const wanted = fields ? new Set(fields) : null;

  const lines = [];
  for (const canonical of order) {
    if (wanted && !wanted.has(canonical)) continue;
    const entry = identity[canonical];
    if (!entry) continue;
    lines.push(`- ${entry.label}: ${displayValue(canonical, entry.value)}`);
  }
  if (!lines.length) return '';

  return [
    '--- IDENTITY (user-stated, authoritative — this is who the user is) ---',
    ...lines,
    'These are durable, user-confirmed identity facts. Answer questions about the',
    "user's name, role, company, and location directly and confidently from this —",
    'never claim you do not know them.',
    '--- END IDENTITY ---',
  ].join('\n');
}

// ── Identity-query detection (retrieval bypass) ───────────────────────────────
// When any of these fire, the identity card is served straight from canonical
// state. It never rides the semantic ranker, so it cannot be crowded out by
// other high-importance facts or lost under a token budget.
const IDENTITY_QUERY_PATTERNS = [
  /\bwho am i\b/i,
  /\bwho i am\b/i,
  /\bdo you (?:remember|know) (?:me|who i am)\b/i,
  /\bremember me\b/i,
  /\bwhat (?:do|have) you (?:know|learned) about me\b/i,
  /\btell me about (?:myself|me)\b/i,
  /\bwhat(?:'s| is| are)? my name\b/i,
  /\bwhat am i called\b/i,
  /\bwhat(?:'s| is)? my (?:preferred name|nickname)\b/i,
  /\bwhat(?:'s| is)? my (?:role|job|title|profession|occupation)\b/i,
  /\bwhat(?:'s| is)? my (?:company|employer|workplace|organi[sz]ation)\b/i,
  /\bwhat company do i (?:run|own|work (?:for|at))\b/i,
  /\bwhere do i work\b/i, /\bwho do i work for\b/i,
  /\bwhat(?:'s| is)? my (?:age|birthday)\b/i, /\bhow old am i\b/i,
  /\bwhere (?:do i live|am i (?:from|based|located))\b/i,
  /\bwhat(?:'s| is)? my (?:city|country|location|timezone|hometown)\b/i,
];

export function isIdentityQuery(query) {
  const q = query || '';
  return IDENTITY_QUERY_PATTERNS.some(p => p.test(q));
}

// Map a narrow identity question to the specific canonical fields it asks for.
// A broad "who am I / about me" (or anything unmatched) → the whole card.
const QUERY_FIELD_MAP = [
  { re: /\b(name|called|nickname|preferred name)\b/i, fields: ['name', 'preferred_name', 'aliases'] },
  { re: /\b(role|job|title|profession|occupation|company|employer|workplace|organi[sz]ation|work for|work at|run|own)\b/i, fields: ['name', 'role', 'company', 'organization'] },
  { re: /\b(age|old|birthday)\b/i, fields: ['name', 'age', 'birthday'] },
  { re: /\b(live|from|based|located|city|country|location|timezone|hometown)\b/i, fields: ['name', 'city', 'country', 'timezone'] },
];

const BROAD_QUERY = /\bwho am i\b|\bwho i am\b|about me\b|remember me\b|remember (?:who i am|you)\b|learned about me\b/i;

/**
 * Answer an identity question from canonical state. Returns the identity card
 * scoped to the question (falls back to the full card for broad questions).
 * The retrieval path — NOT the ranker.
 */
export function answerIdentityQuery(identity, query) {
  if (!hasIdentity(identity)) return '';
  if (BROAD_QUERY.test(query || '')) return formatIdentityBlock(identity);
  for (const { re, fields } of QUERY_FIELD_MAP) {
    if (re.test(query || '')) {
      const block = formatIdentityBlock(identity, { fields });
      return block || formatIdentityBlock(identity);
    }
  }
  return formatIdentityBlock(identity);
}
