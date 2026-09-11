/**
 * AQUA — the predicate registry
 * Blueprint E5/PR-2 · D2 (the claim atom), L2 (one atom), L14
 *
 * A predicate is the relation in a claim: `works_at`, `plans_to`, `blocks`.
 * This is the vocabulary of them.
 *
 * WHY A REGISTRY AND NOT A FREE-TEXT COLUMN
 * -----------------------------------------
 * Free text is what the current lane effectively has, and it is why the
 * extraction baseline reports **predicate accuracy 0%**: there is nothing to
 * be right or wrong about. A closed enum is the opposite failure — the goal
 * detector's `NOT_A_GOAL_HEAD` exists because a CLOSED allowlist caught 5 of
 * 14 self-disclosures, and this project has fixed that same pathology four
 * separate times (classifier task verbs, goal outcome verbs, self-declaration
 * verbs, TECH_TERMS).
 *
 * So: **controlled but open**, which is exactly what
 * `reasoning/typeRegistry.js` already does for edge types. That design is
 * reused rather than reinvented — a second vocabulary system with different
 * rules is how "two of everything" starts.
 *
 * THE FOUR PROPERTIES BORROWED FROM typeRegistry
 * ----------------------------------------------
 *   seeded          a known set exists from the first boot
 *   auto-register   an unseen predicate is admitted AND LOGGED, once
 *   classed         every predicate has a class, so back-compat is possible
 *   strict-mode     AQUA_CLAIM_STRICT_PREDICATES=1 turns admission into a
 *                   throw, for the eval harness and for CI
 *
 * WHAT IS DIFFERENT HERE, AND WHY
 * -------------------------------
 * Predicates carry two things edge types do not:
 *
 *   inverse    `manages` ⇄ `reports_to`. Without it the graph stores the same
 *              fact twice and they drift. E5's retrieval will traverse either
 *              direction from one row.
 *   objectKind entity | literal | quantity | time. The claims table enforces
 *              exactly-one-object; this says WHICH one a predicate expects, so
 *              a mis-shaped claim is caught at write time rather than by a
 *              constraint violation nobody can interpret.
 *
 * NOTHING WRITES CLAIMS YET. This is the vocabulary; E5/PR-3 is the repository
 * that uses it.
 */

const PREDICATE_NAME = /^[a-z][a-z0-9_]{1,47}$/;

/**
 * Classes exist for BACK-COMPATIBILITY, the same reason typeRegistry has them.
 * A consumer that understands a class can handle a predicate it has never
 * seen — which is what makes the registry safe to extend without a migration.
 */
export const PREDICATE_CLASS = Object.freeze({
  IDENTITY: 'identity',     // who/what the subject is
  RELATION: 'relation',     // subject ↔ another entity
  ATTRIBUTE: 'attribute',   // a property of the subject
  INTENT: 'intent',         // something planned, decided or rejected
  STATE: 'state',           // status, progress, lifecycle
  TEMPORAL: 'temporal',     // deadlines and dated events
});

const C = PREDICATE_CLASS;

/**
 * The seed set.
 *
 * Deliberately the 24 predicates the E2 extraction dataset already uses — not
 * an invented vocabulary. That dataset was built from real sentence shapes and
 * every predicate in it has at least two examples, which is the same bar the
 * dataset's own test enforces. Starting anywhere else would mean the registry
 * and the eval measured different things.
 */
const SEED = [
  // identity
  // ── AN INVERSE FORCES objectKind: 'entity'. THIS IS DERIVED, NOT CHOSEN. ────
  //
  // "A owns B" is the same fact as "B owned_by A". So `owns`'s OBJECT and
  // `owned_by`'s SUBJECT are the same thing, and every subject in this system
  // is an entity. A predicate that declares an inverse therefore cannot take a
  // literal object without asserting that one thing is both an entity and not.
  //
  // Five entries violated it — `owns`, `depends_on`, `depended_on_by`,
  // `blocks`, `blocked_by` — and `owned_by` was already `entity`, so the pair
  // contradicted itself in adjacent lines. The cost was not theoretical: every
  // contract rejection in a 525-call eval run was `object-kind-mismatch`, and
  // the objects the model was refused for were `owns → billing service`,
  // `depends_on → search`, and `blocks → Priya`. A person, rejected for not
  // being a literal. Two of the three negation cases that fail the E6
  // promotion gate on every run are this.
  //
  // `predicateRegistry.test.js` enforces the rule structurally, so a sixth
  // cannot be added by hand.
  //
  // NOT changed here: `uses` and `task_owner` have no inverse, so this
  // derivation says nothing about them and they remain an ontology decision
  // with the owner. Nor does it touch the predicates whose gold objects really
  // are values — `has_status → "blocked"`, `role_is → "tech lead"`.
  ['works_at',    { class: C.IDENTITY, objectKind: 'entity',   inverse: 'employs' }],
  ['role_is',     { class: C.IDENTITY, objectKind: 'literal' }],
  ['located_in',  { class: C.IDENTITY, objectKind: 'entity' }],
  ['member_of',   { class: C.IDENTITY, objectKind: 'entity',   inverse: 'has_member' }],
  ['founded',     { class: C.IDENTITY, objectKind: 'entity',   inverse: 'founded_by' }],
  ['is_a',        { class: C.IDENTITY, objectKind: 'literal' }],

  // relations between people
  ['knows',       { class: C.RELATION, objectKind: 'entity',   inverse: 'knows', symmetric: true }],
  ['reports_to',  { class: C.RELATION, objectKind: 'entity',   inverse: 'manages' }],
  ['manages',     { class: C.RELATION, objectKind: 'entity',   inverse: 'reports_to' }],
  ['related_to',  { class: C.RELATION, objectKind: 'literal' }],
  ['employs',     { class: C.RELATION, objectKind: 'entity',   inverse: 'works_at' }],
  ['has_member',  { class: C.RELATION, objectKind: 'entity',   inverse: 'member_of' }],
  ['founded_by',  { class: C.RELATION, objectKind: 'entity',   inverse: 'founded' }],

  // attributes and habits
  ['builds',      { class: C.ATTRIBUTE, objectKind: 'literal' }],
  ['uses',        { class: C.ATTRIBUTE, objectKind: 'literal' }],
  ['prefers',     { class: C.ATTRIBUTE, objectKind: 'literal' }],
  ['dislikes',    { class: C.ATTRIBUTE, objectKind: 'literal' }],
  ['habit_of',    { class: C.ATTRIBUTE, objectKind: 'literal' }],
  ['has_property', { class: C.ATTRIBUTE, objectKind: 'literal' }],

  // projects and artefacts
  ['owns',        { class: C.RELATION, objectKind: 'entity',   inverse: 'owned_by' }],
  ['owned_by',    { class: C.RELATION, objectKind: 'entity',   inverse: 'owns' }],
  ['depends_on',  { class: C.RELATION, objectKind: 'entity',   inverse: 'depended_on_by' }],
  ['depended_on_by', { class: C.RELATION, objectKind: 'entity', inverse: 'depends_on' }],
  ['blocks',      { class: C.RELATION, objectKind: 'entity',   inverse: 'blocked_by' }],
  ['blocked_by',  { class: C.RELATION, objectKind: 'entity',   inverse: 'blocks' }],

  // intent and decision — absent from the engine entirely today
  ['plans_to',    { class: C.INTENT, objectKind: 'literal' }],
  ['decided',     { class: C.INTENT, objectKind: 'literal' }],
  ['rejected',    { class: C.INTENT, objectKind: 'literal' }],

  // tasks and state — also absent today
  ['task_owner',  { class: C.STATE, objectKind: 'literal' }],
  ['has_status',  { class: C.STATE, objectKind: 'literal' }],

  // time
  ['deadline_for', { class: C.TEMPORAL, objectKind: 'literal' }],
];

const predicates = new Map();

function define(name, meta) {
  predicates.set(name, Object.freeze({
    name,
    class: meta.class ?? C.ATTRIBUTE,
    objectKind: meta.objectKind ?? 'literal',
    inverse: meta.inverse ?? null,
    symmetric: meta.symmetric === true,
    source: meta.source ?? 'seed',
  }));
}

function seed() {
  predicates.clear();
  for (const [name, meta] of SEED) define(name, { ...meta, source: 'seed' });
}
seed();

/**
 * Strict mode: an unregistered predicate throws instead of auto-registering.
 *
 * Read per call rather than cached at import, so a test can set it without a
 * module reload — the same choice typeRegistry made, for the same reason.
 */
const strictMode = () =>
  String(process.env.AQUA_CLAIM_STRICT_PREDICATES ?? '') === '1';

export const isRegistered = name => predicates.has(name);
export const getPredicate = name => predicates.get(name) ?? null;
export const allPredicates = () => [...predicates.values()];
export const predicateNames = () => [...predicates.keys()].sort();

/** Explicit registration. Used by seeds, migrations and deliberate additions. */
export function registerPredicate(name, meta = {}) {
  if (!PREDICATE_NAME.test(name)) {
    throw new Error(
      `predicate "${name}" must match ${PREDICATE_NAME} — lower snake_case, 2-48 chars. ` +
      'A malformed predicate would be unqueryable and unjoinable.');
  }
  if (meta.class && !Object.values(C).includes(meta.class)) {
    throw new Error(`predicate "${name}": unknown class "${meta.class}"`);
  }
  if (meta.objectKind && !['entity', 'literal', 'quantity', 'time'].includes(meta.objectKind)) {
    throw new Error(`predicate "${name}": unknown objectKind "${meta.objectKind}"`);
  }
  define(name, { ...meta, source: meta.source ?? 'explicit' });
  return predicates.get(name);
}

/**
 * Admit a predicate seen on a claim.
 *
 * Malformed → always throws: a predicate that cannot be a column value is not
 * a vocabulary question, it is corruption.
 * Unknown but well-formed → registered and LOGGED ONCE, unless strict mode.
 *
 * The log line is the point. An open registry that admitted silently would
 * accumulate `works_at`, `work_at` and `worksat` with nobody noticing, and the
 * vocabulary would stop meaning anything. Logging once per name makes drift
 * visible without flooding.
 */
export function ensurePredicate(name, { source = 'auto' } = {}) {
  if (predicates.has(name)) return predicates.get(name);
  if (!PREDICATE_NAME.test(name)) {
    throw new Error(`unregistered predicate "${name}" is malformed — lower snake_case, 2-48 chars`);
  }
  if (strictMode()) {
    throw new Error(
      `unregistered predicate "${name}" (AQUA_CLAIM_STRICT_PREDICATES=1). ` +
      'Add it to the registry on purpose, or fix the extractor.');
  }
  define(name, { class: C.ATTRIBUTE, objectKind: 'literal', source });
  // Logged exactly once because the early return above makes this line
  // unreachable on a second call. A memo Set was here first, copied from
  // typeRegistry — where it IS needed, because that module's ensure() does not
  // return early. Measuring bite showed it guarded nothing here, so it is gone
  // rather than kept as decoration. FIFTH time in this project a content check
  // matched its own explanatory comment, hence: code lines only.
  console.log(`[CLAIM] New predicate registered: "${name}" (class=${C.ATTRIBUTE}, source=${source})`);
  return predicates.get(name);
}

/**
 * The inverse of a predicate, or null.
 *
 * Retrieval traverses one row in either direction rather than storing the
 * relation twice — two rows for one fact is how a graph starts disagreeing
 * with itself.
 */
export function inverseOf(name) {
  return predicates.get(name)?.inverse ?? null;
}

/** Which object column a predicate expects, so a mis-shaped claim fails early. */
export function objectKindOf(name) {
  return predicates.get(name)?.objectKind ?? null;
}

/** Names auto-registered this process — the drift report. */
export const autoRegistered = () =>
  allPredicates().filter(p => p.source === 'auto').map(p => p.name).sort();

/** Tests only. */
export function _resetForTests() { seed(); }
