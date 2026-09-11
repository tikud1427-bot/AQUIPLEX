/**
 * AQUA Retrieval Intelligence — Persistent Intelligence Core (Phase 4)
 *
 * "The system should retrieve KNOWLEDGE instead of files." Before this
 * module, chat retrieval was three disconnected lanes (memory facts, file
 * chunks, attachment text) and the Phase-3 graph/query layer had ZERO
 * consumers. This is the unification: one call composes
 *
 *   grounded facts        evidenceRetrieval (lexical, provenance-bearing)
 *   connected entities    reasoning graph (canonical, alias-aware)
 *   connected facts       one-hop `about` edges from matched entities —
 *                         facts the lexical lane MISSED but the graph links
 *   timeline context      cross-file ordered events, only on temporal cues
 *   reasoning history     per-fact feedback boost (reasoningFeedback)
 *   lifecycle awareness   archived/superseded facts excluded; stale and
 *                         disputed downweighted; trusted boosted
 *
 * into ONE ranked item list + ONE budgeted prompt block. Every item keeps
 * its provenance (citations, source files, kind observed|derived) — the
 * grounding contract survives composition.
 *
 * Side effect (the lifecycle earning its keep): facts that make the final
 * cut get a `retrieved` lifecycle touch — retrieval frequency is what
 * consolidation's stale/promote logic reads.
 *
 * Pure over injected deps; no model, no I/O of its own; fail-open at the
 * PIC facade.
 */
import { transition } from './knowledgeLifecycle.js';
import { reasoningBoost } from './reasoningFeedback.js';
import {
  analyseQuestion, factAffinity, statementPolarity, MIN_AFFINITY,
} from './questionShape.js';

const TEMPORAL_CUE = /\b(when|before|after|timeline|first|then|earlier|later|history|sequence|order of|chronolog)\b/i;

/**
 * A question the asker is asking ABOUT THEMSELVES.
 *
 * Deliberately local, and deliberately NOT `selfDeclaration.js`. That module
 * answers "did the speaker STATE something about themselves" — a declaration.
 * This answers "is the speaker ASKING about themselves" — a question. Related
 * grammar, genuinely different predicates, and merging them would mean one of
 * the two callers silently getting the other's rule.
 *
 * First-person SINGULAR only, matching the U1 precedent: `we`/`our` is a group
 * claim, and anchoring it to the individual is the quiet inference that puts a
 * wrong line in front of the model. Bare `me` is excluded too — "tell me about
 * Nummo" is a request, not a question about the asker, and including it would
 * anchor nearly every message.
 */
const SELF_QUERY_RE = /(?:^|[^\p{L}])(?:i|i'?m|i'?ve|my|mine|myself)(?:[^\p{L}]|$)/iu;

/**
 * …and asking it as a QUESTION.
 *
 * Without this, the anchor fired on every first-person message, so "I need to
 * fix this bug in my code" pulled three sentences about the user's job into a
 * debugging turn. Measured: that was the only turn in a five-message noise
 * probe whose output changed, and narrowing to interrogatives removed it while
 * keeping all eight retrieval wins. A question mark OR an interrogative opener
 * — chat drops the mark constantly, and "where do I work again" is still a
 * question.
 *
 * The same predicate exists in `core/declarativeIntent.js`, where it is used to
 * REJECT questions rather than to select them. Kept local because this module
 * documents itself as pure over injected deps and imports nothing outside its
 * own directory; a shared regex is not worth being the first exception.
 */
const INTERROGATIVE = /^(?:so\s+|and\s+|but\s+|ok(?:ay)?[,\s]+|hey[,\s]+)*(?:what|when|where|which|who|whom|whose|why|how|is|are|was|were|do|does|did|can|could|should|would|will|have|has|had|am|remind|tell)\b/i;

/** True when the asker is asking a question about themselves. */
function isSelfQuestion(query) {
  const q = String(query ?? '').trim();
  if (!q) return false;
  if (!SELF_QUERY_RE.test(q)) return false;
  return q.endsWith('?') || INTERROGATIVE.test(q);
}

/**
 * Did this lexical hit earn its place by anything other than the self label?
 *
 * `retrieveGroundedFacts` does not report WHICH term matched, so the test is
 * re-derived: if no query term of substance appears in the statement, and none
 * appears in any non-self entity, then the only thing left in the haystack that
 * could have matched is the self entity's label.
 *
 * Terms are ≥3 characters — matching the shape of the haystack tokeniser
 * closely enough for this purpose, and short enough that a two-letter word
 * cannot rescue a hit on its own.
 *
 * FAIL-OPEN: anything malformed keeps the hit. A retrieval that returns one
 * extra line is a smaller failure than one that silently drops a real answer,
 * and this predicate exists to trim noise, not to gatekeep.
 */
const HAYSTACK_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'you', 'your', 'yours', 'are',
  'was', 'were', 'can', 'could', 'would', 'should', 'what', 'when', 'where',
  'which', 'who', 'how', 'why', 'about', 'from', 'into', 'out', 'get', 'got',
  'has', 'have', 'had', 'not', 'but', 'all', 'any', 'some', 'just', 'like',
]);

function earnedBeyondSelf(query, fact, selfLabel) {
  if (!fact) return true;
  const terms = (String(query ?? '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])
    .filter(t => !HAYSTACK_STOPWORDS.has(t));
  if (!terms.length) return true;

  const statement = String(fact.statement ?? '').toLowerCase();
  if (terms.some(t => statement.includes(t))) return true;

  const others = (fact.entities ?? [])
    .map(e => String(e).toLowerCase())
    .filter(e => e && e !== selfLabel);
  return others.some(e => terms.some(t => e.includes(t)));
}

const W_TRUSTED  = 0.10;
const W_DISPUTED = -0.20;
const W_STALE    = -0.10;
const W_GRAPH    = 0.05;    // facts reached through the graph, not lexically

// ── Relevance gating ─────────────────────────────────────────────────────────
//
// THE DEFECT THIS CLOSES, AS MEASURED
// -----------------------------------
// On `retrieval-core.v1` (200 labelled queries through this exact facade)
// every first-person question returned the SAME eight facts, because lane 2b
// anchored on the owner and lane 3 hopped every `about` edge from that anchor
// with a score of `confidence * 0.5 + 0.05` — a number in which the QUESTION
// does not appear. Four different questions, byte-identical output:
//
//     "What is my job?"  "Which city am I in?"  "Where am I employed?"
//     "What is my blood type?"   ← the store cannot answer this one at all
//
// Consequences, all measured on the committed baseline:
//   · unknown_honesty 34.4% — a dossier for questions with no stored answer
//   · noise_lines 131 across 21 of 32 silence-expecting queries
//   · top1_kind 42.9% — the top hit was literally the same fact every time
//   · recall_category 40.6% / recall_superseded 20.0% — the REAL answer was
//     crowded out of the eight-item budget by the same eight generic facts
//
// So the gate is not a noise filter bolted on the end. It is the missing
// relevance term in a lane that never had one.
//
// FAIL-OPEN IS PRESERVED WHERE IT BELONGS, AND NOT WHERE IT DOES NOT.
// A lane that cannot decide keeps its candidate. A candidate that no signal
// supports is dropped — that is not a failure to be open about, it is the
// answer being "we do not know", and L11 says silence beats a confident wrong
// line. Unknown stays unknown.

/**
 * How many facts may arrive on the self-anchor with NO lexical support.
 *
 * The anchor exists to bridge the category/instance gap ("where do I work" →
 * "I run product at Nummo"), which needs a handful of candidates, not a
 * dossier. Without a cap a well-typed question still returns everything that
 * matches the kind, which is how "what is my job" came back with eight facts
 * of which one was a job.
 *
 * Retrieval policy, so it stays here. The SCORING it caps lives in
 * `questionShape.js`, shared with the Context Engine.
 */
const MAX_SELF_ANCHORED = 5;

/**
 * How many facts the polarity lane may INSPECT.
 *
 * A bound, not a budget: it caps the scan, not the number of candidates. It
 * matches `listFacts`' own default so the lane cannot become the reason a
 * turn walks more of the store than any other lane already does.
 */
const POLARITY_LANE_SCAN = 200;

/**
 * Cosine below which the dense lane will not even propose a candidate.
 *
 * Deliberately BELOW `SEMANTIC_TOPIC_FLOOR`: proposing is cheap and the gate
 * decides. Set at the floor of the measured answerable range (0.570) so a real
 * answer is never withheld from the gate by this lane's own filter.
 */
const DENSE_LANE_FLOOR = 0.55;

/** Proposals per turn. The gate still has to admit each one. */
const DENSE_LANE_MAX = 12;

/**
 * How far the best match must stand above the corpus median to be believed.
 *
 * Read off the measured distributions: silence-expecting queries have a p90
 * margin of 0.105, answerable ones a p10 of 0.092.
 *
 * 0.15 rather than 0.11 because it is the PARETO point — swept 0.11 / 0.15 /
 * 0.20 / 0.25 / 0.30:
 *
 *              recall@8  category  superseded  noise  honesty
 *   lexical      0.7560    0.4688      0.6000     16   0.7188
 *   m=0.11       0.8393    0.6562      0.8000     34   0.6562   ← recall bought
 *   m=0.15       0.7976    0.5938      0.7000     16   0.7188   ← nothing bought
 *   m=0.20       0.7738    0.5312      0.7000     16   0.7188
 *   m=0.25       0.7560    0.4688      0.7000     16   0.7188   ← dense inert
 *
 * At 0.15 `noise_lines` and `unknown_honesty` are UNCHANGED from lexical while
 * recall@8 gains 4.2 and recall_category 12.5. 0.11 gains more and pays 18
 * noise lines for it — a real trade, and not one to make silently inside a
 * constant. Above 0.25 the lane stops firing at all.
 */
const DENSE_MARGIN_FLOOR = 0.15;

/**
 * Facts a store must hold before the dense lane is trusted.
 *
 * The floor above was swept at 60 and the margin statistic grows with corpus
 * size, so below this the threshold is an extrapolation. Set AT the calibration
 * point, not below it: the honest bound is the one we measured, and moving it
 * down is a claim that needs its own labelled corpus.
 */
const DENSE_MIN_CORPUS = 60;

/**
 * @param {object} deps - { evidenceStore, evidenceRetrieval, graph, queryEngine }
 * @param {string} ownerId
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit=8]        max knowledge items
 * @param {number} [opts.charBudget=1600] hard cap on the rendered block
 * @returns {{ items: Array, block: string, stats: object }}
 */
export function retrieveKnowledge(deps, ownerId, query, { limit = 8, charBudget = 1600, semanticScores: semanticScoresIn = null } = {}) {
  const { evidenceStore: ES, evidenceRetrieval: ER, graph: G, queryEngine: QE } = deps;
  const started = Date.now();
  const empty = { items: [], block: '', stats: { facts: 0, entities: 0, connectedFacts: 0, timelineEvents: 0, reusedSignals: 0, durationMs: 0 } };
  if (!ownerId || !query) return empty;

  // The owner's own node, found ONCE and used by two lanes below. Lane 1 needs
  // its label to recognise a hit that was earned by nothing else; lane 2b needs
  // the node itself to anchor on. Read from the graph rather than hardcoded, so
  // the label stays a fact about the data and not a duplicated constant.
  const selfNode = (() => {
    try {
      for (const n of G.nodesByType(ownerId, 'entity')) {
        if (n?.data?.entityType === 'self') return n;
      }
    } catch { /* fail-open */ }
    return null;
  })();
  const selfLabel = String(selfNode?.label ?? '').toLowerCase();

  // ── Question shape: what did the asker actually ask FOR? ───────────────────
  //
  // Computed ONCE, before any lane runs, because every lane below needs it and
  // because the thing that was missing was not a better lane — it was any
  // representation of the question at all. Lane 3 scored candidates with
  // `confidence * 0.5 + 0.05`, an expression the query does not appear in.
  const shape = analyseQuestion(query);

  // Entity typing from the world model, for the kind signal. Read once; the
  // regex fallback in `offeredKinds` only runs for entities the graph has not
  // typed, so this map is what makes the signal improve as extraction does.
  const entityTypes = new Map();
  try {
    for (const n of G.nodesByType(ownerId, 'entity')) {
      const t = n?.data?.entityType;
      if (t && n?.label) entityTypes.set(String(n.label).toLowerCase(), String(t));
    }
  } catch { /* fail-open: no typing is a weaker signal, not an error */ }

  // ── Lane 1: grounded facts (lexical + provenance) ──────────────────────────
  //
  // Filtered for hits earned SOLELY by the self entity's label.
  //
  // `evidenceRetrieval` builds its haystack as `statement + entities.join(' ')`,
  // and the self entity is labelled with the literal word "You". So once facts
  // carry it, every message containing "you" lexically matches every fact about
  // the owner. Measured on the rollout harness: turning AQUA_SELF_ENTITY on took
  // retrieval from 2/6 to 5/6 and noise from 0 to 9 lines — and 7 of those 9
  // came from one query, "can you write me a python script". Checked hit by
  // hit, ALL SIX of its matches shared nothing with the fact statement and
  // nothing with any real entity. Every one was the word "you".
  //
  // The haystack is built in `src/files/`, which stays frozen — every uploaded
  // document would otherwise pay for a chat problem. Relabelling the self node
  // was the other option and is worse: `about` edges are keyed off
  // `fact.entities`, so the label is load-bearing for the lane-3 hop this
  // module depends on, and changing it would touch identity, display and
  // stored data to fix a ranking artefact.
  //
  // So the test is re-derived here instead: a hit whose query terms match
  // NEITHER the statement NOR any non-self entity was earned by the self label
  // alone. Nothing else can have produced it.
  //
  // This CANNOT suppress the self-anchored results — those arrive via lane 3's
  // `about` hop, which never consults the haystack. Pinned by a test.
  const rawHits = ER.retrieveGroundedFacts(ES, ownerId, query, { limit: limit * 2 });
  const factHits = selfLabel
    ? rawHits.filter(h => earnedBeyondSelf(query, h?.fact, selfLabel))
    : rawHits;

  // ── Lane 2: entities matching the query (canonical, alias-aware) ───────────
  // Token-based: a whole user message never substring-matches an entity
  // label, so we match entity labels/aliases against the query's tokens.
  const qTokens = tokenize(query);
  const entityMatches = [];
  if (qTokens.length) {
    for (const n of G.nodesByType(ownerId, 'entity')) {
      // THE SELF NODE IS NEVER MATCHED BY SURFACE FORM.
      //
      // Its label is the literal word "You", so a query token "you" matched it
      // here — and lane 3 then hopped `about` from it and returned every fact
      // about the owner. That is where most of the measured noise came from:
      // filtering lane 1 alone changed nothing, because these arrived through
      // lane 2 → lane 3 instead.
      //
      // Lane 2b below is the ONLY route by which the owner becomes an anchor,
      // and it requires a first-person QUESTION. That contract is the same one
      // `conversationEntities` pass B enforces on the write side, for the same
      // reason: a token like "you" fires inside almost every sentence.
      if (n?.data?.entityType === 'self') continue;
      const names = [n.label, ...(n.data?.aliases ?? [])].map(v => String(v).toLowerCase());
      const hit = names.some(name => qTokens.some(t => name.includes(t)));
      if (!hit) continue;
      const files = G.neighbors(ownerId, n.id, { type: 'file', edgeType: 'mentions' })
        .map(({ node }) => ({ file: node.label }));
      entityMatches.push({
        entity: n.label, entityType: n.data?.entityType,
        aliases: n.data?.aliases ?? [],
        resolutionConfidence: n.data?.resolutionConfidence,
        files, _nodeId: n.id, _fileCount: files.length,
      });
    }
    entityMatches.sort((a, b) => b._fileCount - a._fileCount);
    entityMatches.splice(3);
  }

  // ── Lane 2b: the asker themselves ──────────────────────────────────────────
  //
  // Lanes 1 and 2 are both LEXICAL: they need a word from the question to
  // appear in a fact statement or an entity label. That works when the question
  // names the thing ("Tell me about Nummo") and fails completely when it names
  // a CATEGORY and the answer holds an INSTANCE:
  //
  //     "Where do I work now?"   vs  "I run product at Nummo, a fintech in Bangalore."
  //     "Which city am I in?"    vs  "I moved to the Bangalore office last month."
  //
  // Measured: 6 of 8 on a populated store, and both misses were this shape.
  // No amount of token matching bridges "work" → "Nummo" or "city" →
  // "Bangalore" — the question and the answer share no vocabulary at all.
  //
  // The graph already holds the bridge. A first-person question is a question
  // about the owner, the owner HAS a node, and `about` edges already run from
  // it to every fact the user has stated about themselves. So a first-person
  // question anchors on that node and lane 3 does the rest. This is not a
  // synonym table and not a new store — it is the existing self entity being
  // read for the first time on the retrieval side.
  //
  // Deliberately NOT added to `entityMatches`: that list is rendered to the
  // model as "entities relevant to your question", and an item reading "You"
  // is noise at best and a distraction at worst. The anchor exists to reach
  // facts, so it is used for the hop only.
  // WIDENED, AND SAFE ONLY BECAUSE OF THE GATE BELOW.
  //
  // The previous predicate required a first-person SUBJECT and deliberately
  // excluded bare "me", because "tell me about Nummo" is a request and the
  // anchor had nothing downstream to stop it. That exclusion cost real
  // answers: "Which company pays me?" and "Who employs me right now?" both
  // returned SILENCE on the committed baseline — neither contains a
  // first-person subject, and neither shares a word with "I run product at
  // Nummo".
  //
  // Narrowing the anchor was the wrong lever. It made the engine silent on
  // questions it could answer while leaving it noisy on questions it could
  // not, because both failures came from the SAME missing thing: no relevance
  // test on what the anchor reached. Widening the anchor and gating its
  // results is strictly better than narrowing it and gating nothing.
  const selfAnchors = [];
  if (selfNode && shape.selfScoped && shape.isQuestion) selfAnchors.push({ entity: 'you', _nodeId: selfNode.id });

  // ── Lane 3: connected facts — one hop over `about` edges from matched
  //    entities; the graph surfacing what lexical matching missed ────────────
  const seenFactIds = new Set(factHits.map(h => h.fact.id));
  const connected = [];
  for (const em of [...entityMatches, ...selfAnchors]) {
    for (const { node } of G.neighbors(ownerId, em._nodeId, { type: 'fact', edgeType: 'about' })) {
      const factId = node.id.replace(/^fact:/, '');
      if (seenFactIds.has(factId)) continue;
      const fact = ES.getFact(ownerId, factId);
      if (!fact) continue;
      seenFactIds.add(factId);
      const evidence = ES.evidenceForFact(ownerId, factId);
      connected.push({
        fact, evidence,
        citations: evidence.map(deps.formatCitation),
        confidence: fact.confidence,
        score: (fact.confidence ?? 0.5) * 0.5 + W_GRAPH,
        via: `graph: about ${em.entity}`,
        // The self anchor is not a topic. Everything else was named in the
        // query, and that naming is what survives alias canonicalisation.
        _namedAnchor: em._nodeId !== selfNode?.id,
      });
    }
  }

  // ── Lane 5: polarity — the claim-attribute lane ────────────────────────────
  //
  // THE GAP THIS CLOSES, AS MEASURED
  // --------------------------------
  // `recall_negation` was the worst number on `retrieval-core.v1`: 3/10. Read
  // case by case, seven of the ten misses were NOT gating failures. The gate
  // would have admitted the right fact; it never saw it. Every lane above
  // proposes candidates on ONE of two bases — a word from the question appears
  // in the statement (1), or an entity the question NAMES has an `about` edge
  // to it (2/2b/3). "What did we turn down?" names no entity, and after the
  // negation cue is stripped it has NO content words at all. Nothing could
  // propose "We rejected the Bangalore relocation" and nothing did.
  //
  // So the question's POLARITY was understood, the store knew which facts were
  // negated, and no lane connected the two. This is the first lane that
  // retrieves on a CLAIM ATTRIBUTE rather than on surface words or graph
  // adjacency — the "structured claims" lane the E7 roadmap names.
  //
  // WHY IT IS SAFE TO ADD A NON-LEXICAL LANE
  // ----------------------------------------
  // It cannot widen the answer to a question that should be silent, because it
  // does not fire on one: a candidate still has to clear `factAffinity`, and
  // the lane only runs when the QUESTION carries a negation cue. Measured on
  // the 32 silence-expecting queries, ZERO read as negated.
  //
  // ⚠️ THIS LANE SCANS. `listFacts` walks the owner's facts; there is no
  // polarity index, and adding a persisted one to serve two facts in sixty
  // would be an index built for a benchmark. The cost is therefore COUNTED,
  // not hidden — `stats.polarityScanned` reports how many facts were inspected,
  // the same instrument AQUA_INDEXED_NOT_SCAN.md settled on, so the day this
  // is a real cost the number says so instead of a timer that cannot fail.
  //
  // ⚠️ ONE HYPOTHESIS WAS BUILT HERE, MEASURED AT ZERO, AND REMOVED.
  //
  // `droppedSelfCap: 3` on q133 said a negated fact reached by lane 3's self
  // hop was losing a `MAX_SELF_ANCHORED` slot to ordinary dossier lines. The
  // fix looked obvious: record every negated id whether or not another lane
  // saw it first, and exempt those from the cap on the grounds that a claim
  // matching the question's polarity is present for what it SAYS, not because
  // the asker is its subject.
  //
  // It was built, and reverting it changed nothing — q133 still hit, the lane
  // still measured 8/10. The cap pressure came from somewhere else entirely:
  // the over-broad past-tense bonus (see `questionShape.js`), and removing
  // that removed the crowding. The exemption was closing a defect that no
  // longer existed.
  //
  // It is not kept "in case". Twenty lines and a confident comment describing
  // a defect they do not close is the shape a future reader trusts, and the
  // argument for it may still be right — it is recorded in the PR as an
  // unconverted hypothesis needing a case that isolates it, not as code.
  const polarityCandidates = [];
  let polarityScanned = 0;
  if (shape.polarity === 'negated') {
    for (const fact of ES.listFacts(ownerId, { limit: POLARITY_LANE_SCAN })) {
      polarityScanned++;
      if (statementPolarity(fact) !== 'negated') continue;
      if (seenFactIds.has(fact.id)) continue;
      seenFactIds.add(fact.id);
      const evidence = ES.evidenceForFact(ownerId, fact.id);
      polarityCandidates.push({
        fact, evidence,
        citations: evidence.map(deps.formatCitation),
        confidence: fact.confidence,
        score: (fact.confidence ?? 0.5) * 0.5,
        via: 'polarity: negated claim',
        // Not an anchor. The lane proposes on an ATTRIBUTE, which is not
        // topical evidence — `_namedAnchor: false` would claim the graph
        // reached it from something the query named, and nothing did.
        _namedAnchor: undefined,
      });
    }
  }

  // ── Lane 6: dense — retrieval on MEANING rather than on words ──────────────
  //
  // `recall_category` has been the worst honest metric on both retrieval lanes
  // since it was first measured: 0.4688. Its misses are semantic, not lexical —
  // "educational background" → "I studied physics before this", "go-to-market
  // metric" → "we measure success by weekly active teams". No lane above can
  // reach those, and a synonym table that could would be fitted to this dataset,
  // which this module's own header forbids.
  //
  // `semanticScores` is Map<factId, cosine>, supplied by the CALLER — from the
  // committed fixture in eval, from a live query embedding in production. The
  // lane does not embed anything itself, so retrieval stays synchronous and
  // provider-free, and a caller with no vectors simply passes nothing.
  //
  // Keyed by evidence-store fact id, which is the point: E7/PR-1 found the
  // long-term-memory embedding path keying vectors by LTM fact key while
  // retrieval identifies facts by evidence-store id — blueprint §10's
  // "embedding key ≠ retrieval identity". This lane cannot inherit that,
  // because it looks facts up by the same id it proposes them under.
  // ── THE DENSE SIGNAL IS ONLY TRUSTED WHEN SOMETHING STANDS OUT ─────────────
  //
  // Absolute cosine cannot tell an answerable query from an unanswerable one:
  // top-cosine runs 0.570–0.939 for answerable and 0.461–0.767 for the 32
  // silence-expecting queries. Admitting on it cost `noise_lines` 16 → 138 and
  // `unknown_honesty` 0.7188 → 0.1875 — the textbook dense failure, measured.
  //
  // The MARGIN does separate. Top cosine minus the corpus median, per query:
  //     answerable   p10 0.092   median 0.191
  //     silence      median 0.084   p90 0.105
  //
  // Because that is what "I have nothing for this" looks like in a vector
  // space: every fact is equally unrelated, so the best one is not much better
  // than the middle one. "What is my partner's birthday?" has a nearest
  // neighbour; it does not have a STANDOUT one.
  //
  // Below the floor the lane withdraws entirely — no proposals, no semantic
  // topic support — and retrieval behaves exactly as it did before dense
  // existed. An answerable query that falls below still has every lexical lane;
  // it loses a boost, not its answer.
  const rawSemantic = semanticScoresIn instanceof Map ? semanticScoresIn : null;
  let semanticScores = null;
  let semanticMargin = null;
  // ⚠️ THE MARGIN FLOOR NEEDS A CORPUS BIG ENOUGH TO ESTIMATE A BASELINE.
  //
  // 🔴 AN EARLIER VERSION OF THIS COMMENT HAD THE REASON BACKWARDS. It claimed
  // answerable margins grow with corpus size while silence stays flat. That came
  // from SUBSAMPLING the 60-fact corpus, which was confounded — deleting facts
  // leaves the queries still asking for them, so those worlds describe a
  // deletion, not a small store. A real 20-fact corpus with its own labels
  // (`retrieval-small.v1`) says the opposite:
  //
  //                    answerable p10 / median      silence median / p90
  //     N=60  core          0.092 / 0.191               0.084 / 0.105
  //     N=20  small         0.092 / 0.206               0.169 / 0.265
  //
  // ANSWERABLE IS FLAT — 0.092 at both sizes. What moves is SILENCE, and it
  // moves the other way: at 20 facts an unanswerable query's best match stands
  // 0.265 above the median, well ABOVE the typical answerable query. There is
  // no floor to place. Swept on the real small corpus:
  //
  //     margin   recall@8   category   noise
  //     lexical    0.6304     0.1000      17
  //     0.15       0.6957     0.2000      49
  //     0.20       0.6522     0.2000      27
  //     0.27       0.6304     0.1000      21
  //     0.32       0.6304     0.1000      17   ← free, and worthless
  //
  // Every floor that buys recall buys noise; the one that costs nothing does
  // nothing. At N=60, 0.15 was strictly free. Five statistics were tried —
  // top−median, top−p75, top−p90, top−2nd, top/median — and NONE separates at
  // N=20 (answerable p25 minus silence p90 runs −0.098 to −0.306).
  //
  // The cause is sampling, which is why the bound is principled rather than
  // arbitrary: the margin measures a signal against the unrelated mass, and 20
  // samples estimate that mass badly. More facts means a better baseline, so
  // dense gets SAFER as a store grows — the right direction for a product where
  // stores only accumulate.
  if (rawSemantic && rawSemantic.size > 0 && rawSemantic.size < DENSE_MIN_CORPUS) {
    // Explicitly nothing: no proposals, no semantic credit, lexical unchanged.
  } else if (rawSemantic?.size) {
    const sorted = [...rawSemantic.values()].sort((a, b) => b - a);
    semanticMargin = sorted[0] - sorted[Math.floor(sorted.length / 2)];
    if (semanticMargin >= DENSE_MARGIN_FLOOR) semanticScores = rawSemantic;
  }
  const denseCandidates = [];
  if (semanticScores) {
    const ranked = [...semanticScores.entries()]
      .filter(([, sim]) => sim >= DENSE_LANE_FLOOR)
      .sort((a, b) => b[1] - a[1])
      .slice(0, DENSE_LANE_MAX);
    for (const [factId, sim] of ranked) {
      if (seenFactIds.has(factId)) continue;
      const fact = ES.getFact(ownerId, factId);
      if (!fact) continue;
      seenFactIds.add(factId);
      const evidence = ES.evidenceForFact(ownerId, factId);
      denseCandidates.push({
        fact, evidence,
        citations: evidence.map(deps.formatCitation),
        confidence: fact.confidence,
        score: sim,
        via: `dense: ${sim.toFixed(2)}`,
        // Not an anchor, for the same reason lane 5 is not: similarity is an
        // attribute of the pair, not evidence that the graph reached it from
        // something the query named.
        _namedAnchor: undefined,
      });
    }
  }

  // ── Rank: relevance × lifecycle × feedback, and DROP what nothing supports ─
  //
  // Order matters. Relevance is computed FIRST and gates; the lifecycle and
  // feedback weights then rank what survived. The previous order had no
  // relevance term at all, so lifecycle flags and confidence were ranking a
  // pool that had never been filtered for whether it answered the question.
  const gate = { considered: 0, droppedIrrelevant: 0, droppedPolarity: 0, droppedSelfCap: 0, droppedSuperseded: 0 };

  const admitted = [];
  let selfAnchoredKept = 0;

  for (const h of [...factHits, ...connected, ...polarityCandidates, ...denseCandidates]) {
    if (h.fact.archived) continue;
    gate.considered++;

    // SUPERSESSION IS NOT UNCONDITIONAL SUPPRESSION.
    //
    // A superseded fact must not answer a present-tense question — that is the
    // measured "old employer wins" defect. But it IS the answer to a question
    // about the past: "Where do I not work anymore?" is answered by "I used to
    // work at Intercom", the exact fact a blanket filter buries. L5 says
    // nothing is deleted, only superseded; a reader that cannot ever see a
    // superseded claim has deleted it at read time.
    if (h.fact.supersededBy && !(shape.currency === 'past' || shape.polarity === 'negated')) {
      gate.droppedSuperseded++;
      continue;
    }

    const rel = factAffinity(shape, h.fact, entityTypes, h._namedAnchor === true,
      semanticScores?.get(h.fact.id) ?? null);

    const anchoredOnly = h._namedAnchor === false && rel.lexical === 0;

    // "What do you know about me?" is a SUMMARY REQUEST, not a topic query.
    //
    // Self-scoped, no topic words, no typed expectation: there is nothing for
    // the gate to match on, and the honest reading is not "we know nothing"
    // but "you asked for an overview". The owner's own facts, capped as
    // always, ARE the answer.
    //
    // The gate stays narrow on purpose — all three conditions must hold. Every
    // unanswerable first-person question in the dataset carries topic words
    // ("dog", "blood type", "dentist"), so this admits the summary shape
    // without reopening the dossier it replaced.
    const summaryAsk = anchoredOnly && shape.selfScoped && !shape.typed && shape.topicTerms.length === 0;

    if (rel.score < MIN_AFFINITY && !summaryAsk) {
      if (rel.polarityConflict) gate.droppedPolarity++; else gate.droppedIrrelevant++;
      continue;
    }
    // Bound the dossier. A well-typed question still matches many owner facts
    // on kind alone; the anchor exists to bridge a gap, not to summarise a life.
    if (anchoredOnly && selfAnchoredKept >= MAX_SELF_ANCHORED) { gate.droppedSelfCap++; continue; }
    if (anchoredOnly) selfAnchoredKept++;

    // Relevance is the dominant term. The lifecycle and feedback weights keep
    // the magnitudes they were tuned at, so their relative effect is unchanged
    // — what changed is that they now modify a score that knows the question.
    let s = rel.score;
    if (h.fact.trusted)  s += W_TRUSTED;
    if (h.fact.disputed) s += W_DISPUTED;
    if (h.fact.stale)    s += W_STALE;
    const boost = reasoningBoost(ownerId, h.fact.id);
    s += boost;

    // A non-finite score is not a low score, it is an ABSENT one, and
    // `b.score - a.score` on NaN returns NaN, which sort treats as "leave the
    // order alone" — so one malformed evidence record silently randomises the
    // ranking around it. Observed live: a fact ranked FIRST with score=NaN.
    if (!Number.isFinite(s)) s = rel.score;

    admitted.push({ ...h, score: s, feedbackBoost: boost, relevance: rel });
  }

  const scored = admitted.sort((a, b) => b.score - a.score).slice(0, limit);

  // ── Lane 4: timeline, only when the question is temporal ───────────────────
  let timelineEvents = [];
  if (TEMPORAL_CUE.test(query)) {
    const tl = QE.timelineAcross(ES, ownerId);
    timelineEvents = tl.ordered.slice(0, 5);
  }

  // ── Lifecycle touch: these facts were retrieved ────────────────────────────
  for (const h of scored) transition(ownerId, `fact:${h.fact.id}`, 'retrieved', { reason: 'pic-retrieval' });

  // ── Items (structured, for callers) + block (for the prompt) ───────────────
  const items = [
    ...scored.map(h => ({
      kind: 'fact', epistemic: 'observed',
      id: h.fact.id, statement: h.fact.statement,
      confidence: h.fact.confidence,
      trusted: !!h.fact.trusted, disputed: !!h.fact.disputed, stale: !!h.fact.stale,
      citations: h.citations, via: h.via ?? 'lexical', score: round3(h.score),
    })),
    ...entityMatches.map(em => ({
      kind: 'entity', epistemic: 'derived',
      entity: em.entity, entityType: em.entityType,
      aliases: em.aliases, files: em.files.map(f => f.file),
      resolutionConfidence: em.resolutionConfidence, nodeId: em._nodeId,
    })),
    ...timelineEvents.map(e => ({
      kind: 'event', epistemic: 'derived',
      statement: e.statement, timestamp: e.timestamp, certainty: e.certainty, order: e.order,
    })),
  ];

  const block = renderBlock({ scored, entityMatches, timelineEvents, charBudget });

  const stats = {
    facts: scored.length,
    entities: entityMatches.length,
    connectedFacts: scored.filter(h => String(h.via ?? '').startsWith('graph:')).length,
    polarityFacts: scored.filter(h => String(h.via ?? '').startsWith('polarity:')).length,
    // Counted, not timed — see the Lane 5 header. Zero on every turn whose
    // question is not negated, which is what makes the lane's cost auditable
    // rather than amortised into a duration nobody reads.
    polarityScanned,
    timelineEvents: timelineEvents.length,
    reusedSignals: scored.filter(h => h.feedbackBoost !== 0).length,
    durationMs: Date.now() - started,
    // L13: the gate is reported, never silent. "The engine had nothing to
    // offer" and "the engine dropped eleven irrelevant facts" are different
    // events and an operator has to be able to tell them apart — an abstention
    // that logs nothing is indistinguishable from a turn that never asked.
    relevance: {
      expects: shape.expects, typed: shape.typed,
      polarity: shape.polarity, currency: shape.currency,
      selfScoped: shape.selfScoped, ...gate,
      abstained: gate.considered > 0 && scored.length === 0,
    },
  };
  return { items, block, stats };
}

// ── Prompt block (budgeted; provenance visible; epistemic tiers labeled) ─────

function renderBlock({ scored, entityMatches, timelineEvents, charBudget }) {
  if (!scored.length && !entityMatches.length && !timelineEvents.length) return '';

  // The header used to say "verified across your files" unconditionally, which
  // was true only while documents were the sole writer into evidenceStore.
  // Conversational facts can now appear here, and telling the model a chat
  // claim was "verified across your files" is a false provenance claim — the
  // one thing the citation discipline exists to prevent. So the header states
  // what the block actually contains.
  const hasConversation = scored.some(h => h.citations?.[0]?.startsWith('Conversation'));
  const hasDocument     = scored.some(h => !h.citations?.[0]?.startsWith('Conversation'))
    || entityMatches.length || timelineEvents.length;
  const scope = hasConversation && hasDocument ? 'from your files and conversations'
    : hasConversation ? 'from your conversations'
    : 'verified across your files';
  const lines = [`── CONNECTED KNOWLEDGE (${scope}) ──`];

  for (const h of scored) {
    const cite = h.citations?.[0] ? ` [${h.citations[0]}]` : '';
    const flags = [h.fact.trusted && 'trusted', h.fact.disputed && 'disputed — treat as contested', h.fact.stale && 'stale']
      .filter(Boolean).join(', ');
    lines.push(`• ${h.fact.statement}${cite} (confidence ${fmt(h.fact.confidence)}${flags ? `; ${flags}` : ''})`);
  }
  for (const em of entityMatches) {
    const aka = em.aliases?.length ? ` (a.k.a. ${em.aliases.slice(0, 3).join(', ')})` : '';
    const files = em.files.slice(0, 4).map(f => f.file).join(', ');
    lines.push(`• Entity: ${em.entity}${aka} — appears in ${files}`);
  }
  if (timelineEvents.length) {
    lines.push('• Timeline (cross-file, derived):');
    for (const e of timelineEvents) {
      lines.push(`   ${e.order + 1}. ${e.timestamp ? `[${e.timestamp}] ` : ''}${e.statement.slice(0, 110)} (${e.certainty})`);
    }
  }
  lines.push('Use the knowledge above with its citations; disputed items must be presented as contested, never as settled.');

  let out = '';
  for (const l of lines) {
    if (out.length + l.length + 1 > charBudget) break;
    out += (out ? '\n' : '') + l;
  }
  return out;
}

const fmt = (n) => (n == null ? '?' : Number(n).toFixed(2));

/**
 * Query tokens for the entity lane.
 *
 * TRAILING PUNCTUATION USED TO BE PART OF THE TOKEN. `[\w\-.]` absorbs the
 * full stop, so "Tell me about Priya." tokenised to `priya.` — which matches
 * the entity label `Priya` in neither direction. The entity lane went blind on
 * every query that ended in the name it was about, the graph hop that depends
 * on it never fired, and the only reason anything came back at all was the
 * self anchor, which cannot reach a fact the owner is not an entity of.
 *
 * Interior dots are KEPT: `v2.0` and `config.json` are single tokens and
 * splitting them would break the case this character class was widened for.
 * Only the trailing run is trimmed.
 */
function tokenize(q) {
  return [...String(q).toLowerCase().matchAll(/[a-z0-9][\w\-.]{1,}/g)]
    .map(m => m[0].replace(/[.\-_]+$/, ''))
    .filter(t => t.length > 2);
}
const round3 = (n) => Math.round(n * 1000) / 1000;