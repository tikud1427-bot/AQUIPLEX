/**
 * AQUA Brain — Conversational Facts (pure)
 *
 * WHY THIS EXISTS
 * ---------------
 * `conversationIngest.js` deliberately keeps chat-derived claims OUT of
 * `evidenceStore`, and `brain/tests/picConversationSync.test.js` states the
 * reasoning: a turn has no UKO, so routing it through the document path would
 * mean "pretending to be a document".
 *
 * That reasoning is right about TRUST and wrong about REACHABILITY, and the
 * two got conflated. `evidenceStore` is not a trust badge — it is the index
 * every retriever reads:
 *
 *   pic/retrievalIntelligence.js:55   Lane 1 → retrieveGroundedFacts(ES, …)
 *   pic/retrievalIntelligence.js:83   Lane 3 → `about` edges → ES.getFact
 *   brain/contextEngine/index.js:148  candidates → ES.getFact
 *   brain/reflectionV2/deltaReflector.js:140  obsolescence → ES.listFacts
 *
 * Keeping conversations out of that index does not protect document-grade
 * trust. It makes everything the user says unreachable by retrieval and
 * invisible to reflection — which is the exact point at which AQUA stops
 * being a continuously improving understanding engine.
 *
 * A Fact can live in the store and still be honestly labelled: `sourceType:
 * 'conversation'`, `extractionMethod: 'heuristic'`, confidence capped below
 * document-grade, provenance pointing at the turn. Distinguishable at every
 * read. Never masquerading. But reachable.
 *
 * WHAT THIS FILE IS
 * -----------------
 * The pure half of that change: turn text + already-resolved entities in,
 * Fact and Evidence objects out. No store, no graph, no flag, no I/O — so it
 * is testable in isolation and, until something calls it, provably inert.
 * The wiring is a separate, separately reviewable step.
 *
 * TWO DECISIONS ENCODED HERE, BOTH DELIBERATE
 * -------------------------------------------
 *  1. USER MESSAGES ONLY by default (`includeAssistant: false`).
 *     Writing AQUA's own claims into the evidence store as facts would let
 *     the system manufacture its own corroboration — the closed loop B6
 *     avoided for the Digital Twin, for the same reason. The assistant's
 *     answer is already grounded in facts that exist; re-ingesting it as new
 *     evidence double-counts them.
 *  2. A SENTENCE NEEDS ≥1 RESOLVED ENTITY (`minEntities: 1`).
 *     `conversationIngest` uses ≥2 because it is building relationships,
 *     which need two endpoints. Knowledge does not: "AQUA ships in October"
 *     names one entity and is worth remembering. ≥1 is a much higher write
 *     volume than ≥2, which is why the eviction question has to be settled
 *     before this is wired — see the note on volume below.
 *
 * VOLUME / EVICTION — NOT THIS FILE'S PROBLEM, BUT ITS CONSEQUENCE
 * ---------------------------------------------------------------
 * `evidenceStore.saveFact` evicts the oldest fact at MAX_FACTS_PER_OWNER.
 * Chat volume dwarfs document volume, so an unbounded chat write path can
 * evict document facts. This module therefore caps facts per turn and stays
 * pure; the store-level policy is the caller's decision.
 *
 * IDENTITY / IDEMPOTENCE
 * ----------------------
 * `createFact` mints a uuid, so re-ingesting a turn would duplicate. Evidence
 * dedupes for free (content checksum), facts do not. Ids here are therefore
 * DERIVED from the turn coordinates — `conv:<cid>:<turn>:fact:<n>` — so
 * re-ingesting the same turn upserts instead of duplicating. Everything else
 * about the objects is produced by the canonical constructors, so a
 * conversational fact and a document fact are the same shape and pass the
 * same validators.
 */
import { createEvidence, createFact } from '../../files/evidence.js';
import { readFidelity, isRequest, isInformationRequest } from './claimFidelity.js';
import { isAboutSpeakersWorld } from './selfDeclaration.js';

/** Conversational claims never reach document-grade confidence. */
export const CONVERSATION_FACT_CONFIDENCE = 0.6;

/** Per-turn bound. Mirrors conversationIngest's MAX_FACTS_PER_TURN. */
export const MAX_FACTS_PER_TURN = 15;

/** Below this a sentence carries nothing worth resolving. */
const MIN_SENTENCE_LENGTH = 12;

/** Sentence splitter — same heuristic conversationIngest already uses. */
function sentencesOf(text) {
  return String(text ?? '')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length >= MIN_SENTENCE_LENGTH);
}

/**
 * Build a lookup from every surface form (canonical + aliases, lowercased) to
 * its canonical name, so a sentence can be matched against resolved entities
 * rather than re-extracted.
 */
function surfaceFormIndex(entities) {
  const index = new Map();
  for (const e of entities ?? []) {
    if (!e?.canonical) continue;
    // The self entity has no usable surface form — see entitiesNamedIn. Its
    // label would be matched as a substring, which for a word like "you" fires
    // inside "your", "young", "yours". Excluded here, handled by grammar.
    if (e.isSelf) continue;
    for (const name of [e.canonical, ...(e.aliases ?? [])]) {
      const key = String(name).toLowerCase().trim();
      if (key) index.set(key, e.canonical);
    }
  }
  return index;
}

/** The owner's canonical label, if the turn resolved them as a subject. */
function selfCanonicalOf(entities) {
  return (entities ?? []).find(e => e?.isSelf && e?.canonical)?.canonical ?? null;
}

/** Canonical entity names named in one sentence. */
function entitiesNamedIn(sentence, index, selfCanonical = null) {
  const lower = sentence.toLowerCase();
  const named = new Set();
  for (const [surface, canonical] of index) {
    if (lower.includes(surface)) named.add(canonical);
  }
  // The self entity is matched by GRAMMAR, never by surface form. It cannot go
  // through the index above: that is a substring match, and a surface form like
  // "i" or "you" would fire inside almost every word in the language. This is
  // also the honest mechanism — "I'm building X" names the speaker deictically,
  // not by any name, which is exactly why it never threatens the invariant that
  // no NAME may resolve to the self node.
  // WIDER than `isSelfDeclaration` on purpose — see the long note in
  // selfDeclaration.js. A fact stores the sentence verbatim with provenance
  // and never reaches the belief writer, so "our biggest problem is churn"
  // can be recorded here without becoming a claim about the individual. The
  // card's singular-only rule is unchanged; this is a different question.
  if (selfCanonical && isAboutSpeakersWorld(sentence)) named.add(selfCanonical);
  return [...named];
}

/**
 * The synthetic source id for a turn. Identical to
 * `conversationIngest.turnSourceId` so both halves agree on provenance and a
 * fact written here is attributable to the same source node the ingest built.
 */
export function turnSourceId(conversationId, turn) {
  return `conv:${conversationId}:${turn}`;
}

/**
 * Turn one conversation turn into Facts + Evidence.
 *
 * Pure. Deterministic apart from `createdAt`. Returns empty arrays rather
 * than throwing on unusable input — the caller is a post-turn side effect
 * and must never be able to cost a user their answer.
 *
 * @param {object}   args
 * @param {string}   args.conversationId
 * @param {number}   [args.turn=0]
 * @param {string}   [args.userMessage]
 * @param {string}   [args.assistantMessage]
 * @param {Array}    args.entities            resolved entities from entityResolver
 * @param {object}   [opts]
 * @param {boolean}  [opts.includeAssistant=false]  see decision 1 above
 * @param {number}   [opts.minEntities=1]           see decision 2 above
 * @param {number}   [opts.maxFacts=MAX_FACTS_PER_TURN]
 * @param {number}   [opts.confidence=CONVERSATION_FACT_CONFIDENCE]
 * @returns {{ facts: Array, evidence: Array, sourceId: string|null, skipped: string|null }}
 */
export function buildConversationFacts(args, opts) {
  // A default parameter only covers `undefined`. This runs as a post-turn
  // side effect, so an explicit null from a caller must degrade, not throw.
  const {
    conversationId, turn = 0, userMessage = '', assistantMessage = '', entities = [],
  } = args ?? {};
  const {
    includeAssistant = false,
    minEntities = 1,
    maxFacts = MAX_FACTS_PER_TURN,
    confidence = CONVERSATION_FACT_CONFIDENCE,
  } = opts ?? {};

  const empty = (skipped) => ({ facts: [], evidence: [], sourceId: null, skipped });
  if (!conversationId) return empty('missing-conversation');

  const surfaces = surfaceFormIndex(entities);
  const selfCanonical = selfCanonicalOf(entities);
  // A turn whose ONLY subject is the speaker is the whole point of U1 — it is
  // the shape of nearly every "getting to know you" answer. Before this, such
  // a turn returned `no-entities` and wrote nothing at all.
  if (!surfaces.size && !selfCanonical) return empty('no-entities');

  const text = includeAssistant
    ? `${userMessage}\n${assistantMessage}`.trim()
    : String(userMessage ?? '').trim();
  const sentences = sentencesOf(text);
  if (!sentences.length) return empty('no-sentences');

  const sourceId = turnSourceId(conversationId, turn);

  const facts = [];
  const evidence = [];
  let skippedRequests = 0;

  for (let i = 0; i < sentences.length && facts.length < maxFacts; i++) {
    const sentence = sentences[i];
    const named = entitiesNamedIn(sentence, surfaces, selfCanonical);
    if (named.length < minEntities) continue;

    // A REQUEST IS NOT EVIDENCE ABOUT THE USER'S WORLD.
    //
    // "Explain how OAuth works to me." produced a stored fact, because OAuth
    // reads as an entity and this lane had no notion of a request. Six of the
    // ten false positives on `extraction-core.v1` are that exact shape, and
    // the same failure was already fixed once at the self-declaration gate —
    // this is the general path catching up with a decision already made.
    //
    // The cost of getting this wrong points one way. A missed claim is
    // recoverable: the user says it again, or it arrives from another turn. An
    // imperative stored as a fact is not — it sits in the world model and gets
    // retrieved later as though the user had told us something about
    // themselves, which is how a system starts confidently describing a person
    // back to themselves using their own to-do list.
    if (isRequest(sentence)) { skippedRequests += 1; continue; }

    // A WH-QUESTION HAS NO CLAIM IN IT; A POLAR QUESTION DOES.
    //
    // "Why did the deploy fail?" produced a stored fact. The thing being asked
    // for is exactly the part that is missing — all that is left is a
    // presupposition, and storing a presupposition as a fact is how a guess
    // becomes knowledge the user never gave.
    //
    // "Do I still report to Priya?" is different in kind. It puts a specific
    // proposition up for confirmation, and both the proposition and the fact
    // that the user is unsure about it are worth keeping. It is captured with
    // `modality: 'question'` — recorded, explicitly NOT asserted.
    //
    // Gating both cost 3.7 points of detection recall and bought no honesty.
    const fid0 = readFidelity(sentence);
    if (isInformationRequest(sentence)) { skippedRequests += 1; continue; }

    // One Evidence per sentence: the snippet IS the claim's source text, so
    // the checksum makes re-ingesting the same sentence a no-op at the store.
    const ev = createEvidence({
      sourceFileId:     sourceId,
      sourceFileName:   `Conversation ${conversationId}`,
      sourceType:       'conversation',
      extractionMethod: 'heuristic',
      extractor:        'conversationFacts',
      // `paragraph` is the closest honest slot for "which sentence of the
      // turn". Every other locator field stays null — a conversation has no
      // page, sheet or frame, and inventing one would corrupt citations.
      location:         { paragraph: i + 1 },
      confidence,
      snippet:          sentence,
    });

    const fact = createFact({
      statement:  sentence,
      entities:   named,
      evidence:   [ev],
      confidence,
    });

    // FIDELITY IS STORED, NOT LEFT IN THE PROSE.
    //
    // The lane used to write the sentence and nothing else, so "I don't use
    // Kubernetes" was stored as an ASSERTED fact whose text happened to contain
    // "don't". Every consumer then had to re-derive the polarity from prose —
    // the retrieval gate does exactly that on every read — and any consumer
    // that summarises or reasons over polarity instead of rendering it gets the
    // claim backwards. Negation, modality and temporal qualifiers must not be
    // lost silently, and a qualifier that survives only as English is one
    // careless reader away from being lost.
    //
    // These are grammatical properties of the sentence, so they are read here.
    // The PREDICATE is not: choosing `works_at` over `role_is` is a semantic
    // judgement belonging to the claim schema, and guessing it from surface
    // patterns would fit this corpus and transfer nowhere.
    const fid = fid0;
    fact.polarity = fid.polarity;
    fact.modality = fid.modality;
    fact.tense    = fid.tense;
    if (fid.time) fact.time = fid.time;
    // Derived id — see IDENTITY / IDEMPOTENCE above. Everything else about
    // the object stays exactly as the canonical constructor produced it.
    fact.id = `${sourceId}:fact:${i}`;

    evidence.push(ev);
    facts.push(fact);
  }

  if (!facts.length) return empty(skippedRequests ? 'all-requests' : 'no-qualifying-sentences');
  return { facts, evidence, sourceId, skipped: null, skippedRequests };
}

export const _internals = { sentencesOf, surfaceFormIndex, entitiesNamedIn, MIN_SENTENCE_LENGTH };
