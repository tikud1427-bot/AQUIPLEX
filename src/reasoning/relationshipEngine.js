/**
 * AQUA Relationship + Contradiction Engines — Cross-File Reasoning (Phase 3)
 *
 * RELATIONSHIP BUILDER — infers typed relationships between resolved
 * entities from co-occurrence in grounded facts. If a fact mentions both a
 * person and an org, that's evidence of a Person↔Organization relationship;
 * the relationship's confidence grows with the number of independent files
 * that co-mention them, and it always carries the supporting facts +
 * evidence + source files. The engine NEVER invents a relationship: no
 * co-occurrence, no edge. Relationship kind is 'derived' (an inference from
 * observed facts), never 'observed' — the epistemic tiers stay separate.
 *
 * CONTRADICTION DETECTOR (cross-file) — the Phase-2 validator found
 * conflicts within one owner's facts; this operates across FILES on
 * RESOLVED entities: same canonical entity, contradictory numbers / dates /
 * negation across different source files. It SURFACES both sides with their
 * evidence and does NOT resolve them (explicit non-goal). Each contradiction
 * records the two facts, their files, and why they conflict.
 *
 * Both pure. They consume resolved entities (entityResolver) + grounded
 * facts (evidenceStore) and emit graph-ready records.
 */

// ── Relationship inference ────────────────────────────────────────────────────

const REL_BY_TYPES = {
  'person|org':       'affiliated_with',
  'person|person':    'associated_with',
  'person|project':   'works_on',
  'org|project':      'owns',
  'org|org':          'related_to',
  'person|place':     'located_in',
  'org|place':        'located_in',
};

/**
 * PREDICATE TYPING (Brain V1 / B1)
 *
 * REL_BY_TYPES keys on person/org/project/place — but entity typing is
 * deliberately coarse: graphBuilder.guessType() returns 'name' for every
 * proper noun, precisely so "OpenAI" and "OpenAI Inc." stay ONE entity
 * instead of fragmenting into a guessed person and a guessed org. The
 * consequence was that the dominant real-world pair is 'name|name', which
 * matches nothing, so essentially every inferred relationship fell back to
 * the generic `related_to`. The typed vocabulary existed but was unreachable.
 *
 * The strongest available signal is the co-mentioning FACT ITSELF: "Ananya
 * leads the AQUA project" already says the relationship out loud. So we read
 * the type off the supporting statement, using entity position to fix
 * direction (X <predicate> Y ⇒ from X to Y; reversed order ⇒ inverse).
 *
 * This types relationships; it never creates them. A pair with no
 * co-occurrence still produces no edge, and a pair whose facts contain no
 * recognised predicate still falls back exactly as before. The matched
 * phrase is recorded in the reason, so every typed edge remains auditable
 * back to the sentence that justified it.
 */
const PREDICATES = [
  [/\b(?:founded|co-?founded|started|established)\b/,                        'created_by',   'reverse'],
  [/\b(?:created|authored|wrote|designed)\b/,                                'created_by',   'reverse'],
  [/\b(?:built|developed|implemented|shipped|launched)\b/,                   'works_on',     'forward'],
  [/\b(?:leads?|led|heads?|manages?|maintains?|runs?|owns? the)\b/,          'works_on',     'forward'],
  [/\b(?:works? on|working on|contributed to|collaborat\w* on)\b/,           'works_on',     'forward'],
  [/\b(?:reports? to)\b/,                                                    'reports_to',   'forward'],
  [/\b(?:works? at|employed by|joined|member of|part of the team)\b/,        'member_of',    'forward'],
  // Place predicates are checked BEFORE the ownership ones: "operates from
  // Guwahati" is a location, not an acquisition, and bare "operates" is too
  // ambiguous to claim ownership from — so it is deliberately not listed.
  [/\b(?:located in|based in|headquartered in|operates from|offices in)\b/,   'located_in',   'forward'],
  [/\b(?:acquired|owns|subsidiary of)\b/,                                    'owns',         'forward'],
  [/\b(?:belongs to|part of|component of|module of)\b/,                      'belongs_to',   'forward'],
  [/\b(?:uses|using|built with|powered by|runs on|adopted)\b/,               'uses',         'forward'],
  [/\b(?:depends? on|requires?|needs|relies on)\b/,                          'depends_on',   'forward'],
  [/\b(?:implements?|conforms to|complies with)\b/,                          'implements',   'forward'],
  [/\b(?:blocks?|blocking|is blocked by)\b/,                                 'blocks',       'forward'],
  [/\b(?:inspired by|derived from|forked from)\b/,                           'inspired_by',  'forward'],
];

/** Case-insensitive index of the first occurrence of any of an entity's names. */
function nameIndex(statement, entity) {
  let best = -1;
  for (const name of [entity.canonical, ...entity.aliases]) {
    const i = statement.indexOf(String(name).toLowerCase());
    if (i !== -1 && (best === -1 || i < best)) best = i;
  }
  return best;
}

/**
 * @returns {{type,from,to,phrase}|null} null when no statement names a
 *          recognised predicate between the two entities.
 */
function inferTypeFromPredicates(a, b, statements) {
  for (const raw of statements) {
    const s = String(raw).toLowerCase();
    const ia = nameIndex(s, a);
    const ib = nameIndex(s, b);
    if (ia === -1 || ib === -1 || ia === ib) continue;

    for (const [pattern, type, direction] of PREDICATES) {
      const m = pattern.exec(s);
      if (!m) continue;
      const ip = m.index;
      // The predicate must sit BETWEEN the two entity mentions, otherwise it
      // is describing something else in the sentence.
      const forward = ia < ip && ip < ib;
      const backward = ib < ip && ip < ia;
      if (!forward && !backward) continue;

      const [subject, object] = forward ? [a, b] : [b, a];
      // 'reverse' predicates read subject→object but MEAN object→subject
      // ("Ananya founded Aquiplex" ⇒ Aquiplex created_by Ananya).
      const [from, to] = direction === 'reverse' ? [object, subject] : [subject, object];
      return { type, from: from.id, to: to.id, phrase: m[0] };
    }
  }
  return null;
}

/** Supporting statements kept per pair for predicate typing (bounded). */
const MAX_TYPING_STATEMENTS = 20;

/**
 * @param {Array} entities - resolved entities (entityResolver output)
 * @param {Array} facts    - grounded facts
 * @param {object} store   - evidenceStore (evidence hydration)
 * @param {string} ownerId
 * @returns {Array} relationships [{ id, from, to, type, kind:'derived', confidence, supportingFacts:[id], evidence:[id], sourceFiles:[ukoId], reason }]
 */
export function buildRelationships(entities, facts, store, ownerId) {
  // Map every alias/canonical → entity id, for fast fact→entity linking.
  const nameToEntity = new Map();
  for (const e of entities) {
    for (const name of [e.canonical, ...e.aliases]) nameToEntity.set(String(name).toLowerCase(), e);
  }

  // For each fact, which resolved entities does it mention?
  const pairCounts = new Map(); // "idA|idB" → { files:Set, facts:Set, evidence:Set }
  for (const fact of facts) {
    const hit = new Set();
    for (const raw of fact.entities ?? []) {
      const e = nameToEntity.get(String(raw).toLowerCase());
      if (e) hit.add(e);
    }
    const list = [...hit];
    if (list.length < 2) continue;
    const evidence = store.evidenceForFact(ownerId, fact.id);
    const files = new Set(evidence.map(ev => ev.sourceFileId));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a, b] = [list[i], list[j]].sort((x, y) => x.id.localeCompare(y.id));
        const key = `${a.id}|${b.id}`;
        const bucket = pairCounts.get(key) ?? { a, b, files: new Set(), facts: new Set(), evidence: new Set(), statements: [] };
        for (const f of files) bucket.files.add(f);
        bucket.facts.add(fact.id);
        for (const ev of evidence) bucket.evidence.add(ev.id);
        // Kept for predicate typing — the sentence that co-mentions them is
        // the best evidence of WHAT the relationship is.
        if (bucket.statements.length < MAX_TYPING_STATEMENTS) bucket.statements.push(fact.statement);
        pairCounts.set(key, bucket);
      }
    }
  }

  const relationships = [];
  for (const { a, b, files, facts: fset, evidence, statements } of pairCounts.values()) {
    // Typing precedence: what the sentence SAYS > what the entity types
    // imply > generic association. Direction comes from the predicate when
    // one was found; otherwise it stays canonical (id-sorted) as before.
    const predicate = inferTypeFromPredicates(a, b, statements ?? []);
    const type = predicate?.type
      ?? REL_BY_TYPES[[a.type, b.type].sort().join('|')]
      ?? 'related_to';
    const from = predicate?.from ?? a.id;
    const to   = predicate?.to   ?? b.id;
    const typeSource = predicate ? 'predicate' : (REL_BY_TYPES[[a.type, b.type].sort().join('|')] ? 'entity_types' : 'co_occurrence');

    // Confidence: more independent files co-mentioning → stronger, capped.
    // A predicate-typed relationship is stated outright rather than merely
    // co-occurring, so it earns a small, bounded lift.
    const base = 0.5 + 0.15 * (files.size - 1) + 0.05 * (fset.size - 1);
    const confidence = round(Math.min(0.95, predicate ? base + 0.1 : base));

    const cooccur = `co-mentioned in ${fset.size} fact(s) across ${files.size} file(s)`;
    relationships.push({
      // Id stays canonical (id-sorted, type-free) so re-runs and the B1
      // legacy migration both resolve to the SAME edge — never a duplicate.
      id: `rel:${a.id}|${b.id}`,
      from, to, type, kind: 'derived',
      typeSource,
      confidence,
      supportingFacts: [...fset],
      evidence: [...evidence],
      sourceFiles: [...files],
      reason: predicate ? `stated via "${predicate.phrase}"; ${cooccur}` : cooccur,
    });
  }
  return relationships;
}

// ── Cross-file contradiction detection ───────────────────────────────────────

/**
 * @returns {Array} contradictions [{ id, entity, type:'numeric'|'negation'|'date', factIds:[a,b], statements:[a,b], sourceFiles:[[..],[..]], evidence:[[..],[..]], reason }]
 */
export function detectCrossFileContradictions(entities, facts, store, ownerId) {
  const nameToEntity = new Map();
  for (const e of entities) for (const name of [e.canonical, ...e.aliases]) nameToEntity.set(String(name).toLowerCase(), e);

  // Group facts by resolved entity.
  const byEntity = new Map(); // entityId → facts[]
  for (const fact of facts) {
    for (const raw of fact.entities ?? []) {
      const e = nameToEntity.get(String(raw).toLowerCase());
      if (!e) continue;
      if (!byEntity.has(e.id)) byEntity.set(e.id, []);
      byEntity.get(e.id).push(fact);
    }
  }

  const contradictions = [];
  const seen = new Set();

  // Evidence lookups HOISTED out of the pair loop.
  //
  // `evidenceForFact` was called twice per PAIR — O(N²) store lookups to
  // answer a question that only depends on ONE fact at a time. Measured: the
  // pass spent 537ms on 300 facts, and this was most of it.
  //
  // Computing each fact's file set once is O(N). **The set of pairs reaching
  // conflictKind is byte-for-byte identical**, which is why this is an
  // optimisation and not a selection change — the thing FIX-4 said it could
  // not safely do without an eval. The selection eval now exists and confirms
  // it, and `comparisons_examined` is unchanged at 1104 precisely because
  // nothing about the pairing changed.
  const filesOfFact = new Map();
  const filesFor = (fact) => {
    let set = filesOfFact.get(fact.id);
    if (!set) {
      set = new Set(store.evidenceForFact(ownerId, fact.id).map(e => e.sourceFileId));
      filesOfFact.set(fact.id, set);
    }
    return set;
  };

  for (const [entId, group] of byEntity) {
    const entity = entities.find(e => e.id === entId);

    // ── BUCKET BY SUBJECT ────────────────────────────────────────────────
    //
    // `differentSubjects` already rejected most pairs — but it was asked once
    // per PAIR, so the O(N²) enumeration happened regardless. Computing each
    // fact's subject key ONCE and comparing only within a bucket skips the
    // enumeration itself.
    //
    // A fact with NO subject key joins the global bucket and is compared
    // against everything, because "no series index" means "could be about
    // anything". Dropping those would be the silent recall loss FIX-4 refused
    // to risk without an eval — `contradiction-corpus.v1` is that eval.
    const buckets = new Map();
    const global = [];
    for (const fact of group) {
      const keys = subjectKeys(fact.statement);
      if (keys.size === 0) { global.push(fact); continue; }
      for (const [label, idx] of keys) {
        const k = `${label}=${idx}`;
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(fact);
      }
    }
    const candidateGroups = [...buckets.values()].map(b => [...b, ...global]);
    if (global.length) candidateGroups.push(global);

    for (const cand of candidateGroups) {
    for (let i = 0; i < cand.length; i++) {
      const fa = cand[i];
      const filesA = filesFor(fa);
      for (let j = i + 1; j < cand.length; j++) {
        const fb = cand[j];
        const filesB = filesFor(fb);
        // Cross-FILE only: the two facts must come from different files.
        // Same predicate as before — a Set membership test rather than two
        // array spreads per pair, which allocated 4 arrays for every pair.
        let crossFile = false;
        for (const f of filesA) if (!filesB.has(f)) { crossFile = true; break; }
        if (!crossFile) for (const f of filesB) if (!filesA.has(f)) { crossFile = true; break; }
        if (!crossFile) continue;

        // De-duplicate BEFORE comparing, not after.
        //
        // A fact carrying two subject keys sits in two buckets, and `global`
        // is appended to every bucket, so the same pair can surface several
        // times. Checking `seen` after `conflictKind` meant paying for every
        // repeat: bucketing took comparisons from 1104 UP to 2609 — the
        // opposite of its purpose — until this moved.
        const key = [fa.id, fb.id].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);

        const kind = conflictKind(fa.statement, fb.statement);
        if (!kind) continue;

        contradictions.push({
          id: `contra:${key}`,
          entity: entity?.canonical ?? entId,
          type: kind,
          factIds: [fa.id, fb.id],
          statements: [fa.statement, fb.statement],
          sourceFiles: [[...filesA], [...filesB]],
          evidence: [fa.evidence, fb.evidence],
          reason: `${kind} disagreement about "${entity?.canonical ?? entId}" across different files`,
        });
      }
    }
    }
  }
  return contradictions;
}

/**
 * Exposed for the contradiction eval.
 *
 * A seam rather than a copy: the eval must score the PREDICATE THE ENGINE
 * ACTUALLY USES. A duplicated rule in the harness would drift the first time
 * one side changed, and the baseline would then measure a detector nobody
 * ships. FINDING-1 exists because this predicate over-fires; a scorer aimed at
 * a copy of it would be worthless.
 */
export function _conflictKindForTests(a, b) { return conflictKind(a, b); }

/**
 * How many statement PAIRS the last contradiction pass examined.
 *
 * Exported for the cost test. A comparison count is a fact about the
 * ALGORITHM; a millisecond figure is a fact about the machine on the day.
 * Pinning O(N²) with a timing ratio meant pinning a LOWER bound on a
 * stopwatch, which is the fragile direction under load — it passed alone and
 * failed in the battery, twice.
 *
 * Incrementing a counter is the whole cost of this seam, and it makes the pin
 * exact and load-independent instead of merely usually-right.
 */
let comparisons = 0;
export function _comparisonCountForTests() { return comparisons; }
export function _resetComparisonCountForTests() { comparisons = 0; }

function conflictKind(a, b) {
  comparisons++;
  // ── GATE 0: one statement REVISING the other is history, not conflict ────
  //
  // "The beta date was 1 August" / "The beta date MOVED TO 15 September" are
  // both true: one records a change. Revision language is an explicit signal
  // that the writer knows about the earlier value.
  if (REVISION.test(a) !== REVISION.test(b)) return null;

  // ── GATE 1: the two statements must be about the SAME THING ──────────────
  //
  // The idea the predicate never had. `Item 0 for VendorCo recorded value
  // 1000` and `Item 1 … 1001` share an entity and five words and disagree on
  // a number — and are both true, because they describe DIFFERENT ITEMS.
  //
  // Measured before this gate existed: 95.5% of per-item table rows fired,
  // 73,500 edges from 300 facts. That single missing idea is nearly all of the
  // false-positive damage.
  if (differentSubjects(a, b)) return null;

  const numA = numbers(a), numB = numbers(b);
  const sigA = significant(numA), sigB = significant(numB);
  if (sigA.length && sigB.length && !sigA.some(n => sigB.includes(n)) && !sigB.some(n => sigA.includes(n)) && overlap(a, b) >= 4) {
    return 'numeric';
  }
  if (numA.length && numB.length && !numA.some(n => numB.includes(n)) && overlap(a, b) >= 3) {
    if (/\b(19|20)\d{2}\b/.test(a) && /\b(19|20)\d{2}\b/.test(b)) return 'date';
    return 'numeric';
  }
  const negA = NEG.test(a), negB = NEG.test(b);
  if (negA !== negB && overlap(a, b) >= 4) return 'negation';

  // ── The recall half. Everything above compares DIGITS, so the detector was
  // blind to disagreements that carry no numeral at all. Measured: 9 of 15
  // genuine contradictions missed. These run only after the subject gate, so
  // they cannot reintroduce the per-item false positives.
  if (monthConflict(a, b) && overlap(a, b) >= 3) return 'date';
  // Re-added. It was removed in FIX-1 as dead — and it WAS dead, because the
  // qualifier gate suppressed every case before it could run. Fixing the gate
  // brought its cases back, which is a reminder that "this rule bites nothing"
  // can mean "something upstream is eating its input".
  if (spelledNumberConflict(a, b) && overlap(a, b) >= 3) return 'numeric';
  // A spelled-number rule was here and was DEAD: "runway is fourteen months"
  // vs "six months" is already caught by the bare `is` relation-tail rule
  // below. Removing it cost zero tests across the whole battery — the same
  // check that found E5/PR-2's `autoLogged` Set guarding nothing.
  if (categoricalConflict(a, b) && overlap(a, b) >= 3) return 'status';
  const tail = relationTailConflict(a, b);
  if (tail) return tail;

  return null;
}

/**
 * Do the two statements describe different members of a series?
 *
 * A per-item table is the shape: `Item 0 …`, `Item 1 …`, `Invoice 1042 …`,
 * `Sprint 4 …`, `Q1 revenue …`. When both sides carry a LABEL + INDEX and the
 * indices differ, they are about different things and cannot contradict.
 *
 * Deliberately narrow. It only fires when BOTH sides show the same label with
 * a different index — an unlabelled numeric difference is still a candidate
 * conflict, which is what keeps `Revenue was 4200000` vs `9100000` firing.
 */
function differentSubjects(a, b) {
  const A = subjectKeys(a), B = subjectKeys(b);
  for (const [label, idx] of A) {
    if (B.has(label) && B.get(label) !== idx) return true;
  }
  return differentQualifier(a, b);
}

/**
 * A shared head noun carrying a DIFFERENT qualifier on each side.
 *
 *   "The BANGALORE office has 12 desks"  /  "The DELHI office has 30 desks"
 *   "The 2024 audit cost 15000"          /  "The 2025 audit cost 21000"
 *   "Plan BASIC costs 4900"              /  "Plan PRO costs 9900"
 *
 * Same predicate, different subject, both true. The series-index gate misses
 * these because the discriminator is a name or a year rather than an index —
 * and a year is deliberately excluded there, correctly, since `on 2026-01-10`
 * is a date and not a series.
 *
 * Requires the qualifier to be adjacent to the shared noun, so it cannot fire
 * on two statements that merely contain different words somewhere.
 */
function differentQualifier(a, b) {
  const toks = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const ta = toks(a), tb = toks(b);
  const shared = new Set(ta.filter(w => tb.includes(w) && w.length >= 4));
  for (const noun of shared) {
    // 🔴 The shared word must be a NOUN the qualifier modifies.
    //
    // `Acme Corporation RAISED $10M` vs `Acme Holdings RAISED $99M` put two
    // names before a VERB — but a name before a verb is the subject itself,
    // not a series label, and suppressing there hid a real conflict. A
    // past-tense "-ed" form is a cheap, honest proxy for a verb without a POS
    // tagger; it errs toward FIRING the detector, which is the safer side
    // given the alternative is silently losing a contradiction.
    if (/(?:ed|ing)$/.test(noun)) continue;
    const qa = ta[ta.indexOf(noun) - 1];
    const qb = tb[tb.indexOf(noun) - 1];
    if (!qa || !qb || qa === qb) continue;
    if (NOT_A_SERIES_LABEL.has(qa) || NOT_A_SERIES_LABEL.has(qb)) continue;
    // Both qualifiers must be CONTENT: a name, or a number acting as one.
    if (!/^[a-z0-9]{2,}$/.test(qa) || !/^[a-z0-9]{2,}$/.test(qb)) continue;
    // 🔴 A qualifier only DISTINGUISHES subjects if it is absent from the
    // other statement.
    //
    // `OpenAI raised 10000000` vs `OpenAI Inc. raised 99000000` put "openai"
    // and "inc" before the shared word, so the raw-token comparison read them
    // as different subjects and suppressed a GENUINE contradiction between two
    // files. They are the same company with a suffix — which is precisely what
    // entity resolution exists to handle.
    //
    // Found by the existing battery, not by my 53-case dataset. That dataset
    // had no same-entity-with-a-suffix pair, and four rounds of tuning against
    // it would never have surfaced this.
    if (tb.includes(qa) || ta.includes(qb)) continue;
    // 🔴 A UNIT is not a subject.
    //
    // `reduces duration by 30 PERCENT` vs `by 12 PERCENT` puts two numbers
    // before a shared word — but that IS the disagreement, not a
    // distinguisher. `2024 audit` vs `2025 audit` is the opposite: a year
    // qualifying a noun, naming two different audits.
    //
    // So a NUMERIC qualifier distinguishes subjects only when the shared word
    // is not a unit of measure. Also found by the existing battery, not by my
    // dataset.
    // A qualifier that is ITSELF A VALUE does not name a subject.
    //
    //   "fourteen MONTHS" / "six MONTHS"   → two values of one measure
    //   "january 2026"    / "march 2026"   → two dates, the year shared
    //   "2024 AUDIT"      / "2025 AUDIT"   → two different audits ✓ distinguish
    //
    // The discriminator is what the qualifier MODIFIES: a unit or another
    // value means the pair is one measure disagreeing; a plain noun means two
    // named things. The first version only recognised DIGIT qualifiers, so
    // spelled numbers and month names still suppressed four genuine
    // contradictions.
    if (isValueToken(qa) && isValueToken(qb) && (UNIT_WORDS.has(noun) || isValueToken(noun))) continue;
    return true;
  }
  return false;
}

/** Spelled cardinals, so "fourteen" reads as a quantity and not as a name. */
const SPELLED_NUMBERS = new Set([
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen', 'twenty', 'twenty-four', 'thirty',
  'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred',
]);

/** "fourteen months" vs "six months" — invisible to a digit comparison. */
function spelledNumberConflict(a, b) {
  const of = (s) => (String(s).toLowerCase().match(/[a-z-]+/g) ?? []).filter(w => SPELLED_NUMBERS.has(w));
  const wa = of(a), wb = of(b);
  return wa.length > 0 && wb.length > 0 && !wa.some(n => wb.includes(n));
}

/** A digit run, a spelled cardinal, or a month name — a VALUE, never a name. */
function isValueToken(w) {
  return /^[0-9]/.test(w) || SPELLED_NUMBERS.has(w) || MONTHS.includes(w);
}

/** Words that measure rather than name — a number before one is a VALUE. */
const UNIT_WORDS = new Set([
  'percent', 'percentage', 'months', 'month', 'weeks', 'days', 'hours',
  'minutes', 'people', 'users', 'customers', 'dollars', 'units', 'tickets',
  'desks', 'seats', 'points', 'times', 'items', 'rows', 'words',
]);

const MONTHS = ['january','february','march','april','may','june','july',
  'august','september','october','november','december'];

/** "signed on 12 January" vs "3 March" — a month name is a date, not a word. */
function monthConflict(a, b) {
  const of = (s) => MONTHS.filter(m => new RegExp(`\\b${m}\\b`, 'i').test(String(s)));
  const ma = of(a), mb = of(b);
  return ma.length > 0 && mb.length > 0 && !ma.some(m => mb.includes(m));
}

/** label → index, for `Item 3`, `Invoice 1042`, `Q2`, `Sprint 5`, `web-01`. */
function subjectKeys(s) {
  const out = new Map();
  const text = String(s);
  for (const m of text.matchAll(/\b([A-Za-z][A-Za-z-]{1,20})[ -]([0-9]{1,6})\b/g)) {
    const label = m[1].toLowerCase();
    // A year is not a series index.
    if (/^(19|20)\d\d$/.test(m[2])) continue;
    // 🔴 A FUNCTION WORD IS NOT A SERIES LABEL.
    //
    // The first version of this gate treated "on 12" and "is 88400" as
    // labelled indices, so `signed on 12 January` vs `signed on 3 March` read
    // as two different subjects and the contradiction was suppressed.
    // Measured: it cost three genuine detections.
    //
    // This is the stopword class this project has fixed four times already
    // (classifier task verbs, goal outcome verbs, self-declaration verbs,
    // TECH_TERMS). A closed list of function words is the narrow fix; a label
    // has to be a NOUN naming a series.
    if (NOT_A_SERIES_LABEL.has(label)) continue;
    if (!out.has(label)) out.set(label, m[2]);
  }
  for (const m of text.matchAll(/\b(Q[1-4]|H[12])\b/g)) {
    if (!out.has('period')) out.set('period', m[1].toUpperCase());
  }
  return out;
}

/** Function words that precede a number without naming a series. */
const NOT_A_SERIES_LABEL = new Set([
  'on', 'is', 'was', 'are', 'were', 'at', 'in', 'of', 'to', 'by', 'for',
  'about', 'over', 'under', 'and', 'or', 'the', 'a', 'an', 'be', 'been',
  'has', 'have', 'had', 'totals', 'total', 'costs', 'cost', 'raised',
]);

/**
 * Opposite states of one thing: confirmed/cancelled, passed/failed.
 *
 * A closed list, on purpose. An open one would need a lexicon this codebase
 * does not have, and guessing antonyms is how a detector starts firing on
 * "increased"/"decreased" in two unrelated metrics.
 */
const OPPOSITES = [
  ['confirmed', 'cancelled'], ['confirmed', 'canceled'],
  ['passed', 'failed'], ['approved', 'rejected'],
  ['complete', 'incomplete'], ['open', 'closed'],
  ['active', 'inactive'], ['signed', 'unsigned'],
  ['accepted', 'declined'], ['available', 'unavailable'],
];
function categoricalConflict(a, b) {
  const la = String(a).toLowerCase(), lb = String(b).toLowerCase();
  const has = (s, w) => new RegExp(`\\b${w}\\b`).test(s);
  return OPPOSITES.some(([x, y]) => (has(la, x) && has(lb, y)) || (has(la, y) && has(lb, x)));
}

/**
 * Same relation, different object: "Dev reports to Priya" / "to Karan".
 *
 * Compares the TAIL after a shared relation phrase. Requires the heads to
 * match, so it cannot fire on two different subjects.
 */
const RELATIONS = [
  'reports to', 'is the', 'is our', 'works at', 'is based in',
  'is led by', 'belongs to', 'is assigned to', 'is owned by',
  'we chose', 'is', 'are',
];
function relationTailConflict(a, b) {
  const la = String(a).toLowerCase().replace(/[.!?]+$/, '');
  const lb = String(b).toLowerCase().replace(/[.!?]+$/, '');
  for (const rel of RELATIONS) {
    const ia = la.indexOf(rel), ib = lb.indexOf(rel);
    if (ia < 0 || ib < 0) continue;
    if (la.slice(0, ia).trim() !== lb.slice(0, ib).trim()) continue;   // different heads
    const ta = la.slice(ia + rel.length).trim();
    const tb = lb.slice(ib + rel.length).trim();
    if (ta && tb && ta !== tb) return 'entity';
  }
  return null;
}

const REVISION = /\b(moved to|changed to|updated to|revised to|pushed to|slipped to|now|since|until)\b/i;
const NEG = /\b(not|no|never|isn't|aren't|won't|cannot|can't|failed|rejected|denied)\b/i;
function numbers(s) { return [...String(s).matchAll(/\d[\d,]*(?:\.\d+)?/g)].map(m => m[0].replace(/,/g, '')); }
function significant(ns) { return ns.filter(n => n.length >= 4 && !/^(19|20)\d\d$/.test(n)); }
function overlap(a, b) {
  const wa = new Set(String(a).toLowerCase().match(/[a-z]{3,}/g) ?? []);
  const wb = new Set(String(b).toLowerCase().match(/[a-z]{3,}/g) ?? []);
  let n = 0; for (const w of wa) if (wb.has(w)) n++;
  return n;
}
const round = (n) => Math.round(n * 100) / 100;