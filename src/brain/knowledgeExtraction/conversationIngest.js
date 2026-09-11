/**
 * AQUA Brain — Conversation Ingest (Brain V1 / B3)
 *
 * THE GAP THIS CLOSES
 * -------------------
 * `pic/core.js:onKnowledgeIngested` has exactly one caller: fileEngine. Every
 * document an owner uploads flows into the reasoning graph with full
 * provenance; every conversation — the highest-volume input AQUA has —
 * contributes nothing to it. The Mind observes conversations (mind.graph),
 * but everything it learns is anchored to the user (SELF → X edges) and
 * carries no evidence. So "Priya owns the billing service", said in chat,
 * is invisible to the graph the reasoning layers actually traverse, and can
 * never corroborate or contradict the same claim from a document.
 *
 * B3 gives conversations the SAME standing as files:
 *
 *   • A conversation turn becomes a `conversation` source node (registered
 *     as a new node CLASS via B1 — deliberate, not auto).
 *   • Entities named in the turn are resolved (reusing entityResolver, the
 *     exact machinery files use, so "Priya" from chat and "Priya" from a doc
 *     resolve to ONE entity) and linked to the conversation with a
 *     provenance-bearing `mentions` edge.
 *   • Relationships stated in the turn are typed by the same predicate
 *     engine B1 added, and stored as grounded edges between third-party
 *     entities — not just user→X.
 *
 * The evidence is the message itself: a synthetic UKO-shaped source id
 * (`conv:<conversationId>:<turn>`) and an evidence record whose snippet is
 * the sentence. That keeps the reasoning contract intact — every edge still
 * has provenance — while being honest that the source is conversational, not
 * a document (extractionMethod: 'heuristic', sourceType: 'conversation').
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 *   • It does not re-implement extraction. resolveEntities and the B1
 *     predicate typing are reused wholesale, and entity detection still runs
 *     the shared document extractor — but WRAPPED by
 *     `conversationEntities.js`, which adds a case-insensitive pass for
 *     lowercase chat. The shared extractor itself is unchanged, so the
 *     document pipeline sees none of this.
 *   • It does not touch the Mind. mindObserve still runs; this is additive.
 *   • It does not write conversation facts as if they were DOCUMENT facts.
 *     They do now enter evidenceStore (step 3c) — that reversed an earlier
 *     decision, and the reversal is the point of the change: keeping them out
 *     did not protect document-grade trust, it made everything said in chat
 *     unreachable by every retriever and invisible to reflection. What
 *     protects trust is the LABELLING, which is intact: sourceType
 *     'conversation', extractionMethod 'heuristic', confidence capped at 0.6,
 *     provenance pointing at the exact turn. A query can always tell a
 *     stated-in-chat claim from a document-grounded one.
 *
 * Fail-open, off by default (AQUA_BRAIN_INGEST; facts additionally behind
 * AQUA_BRAIN_INGEST_FACTS), bounded per turn.
 */
import { resolveEntities } from '../../reasoning/entityResolver.js';
import { buildRelationships } from '../../reasoning/relationshipEngine.js';
import { registerNodeType } from '../../reasoning/typeRegistry.js';
import { brainEnabled } from '../worldModel/schema.js';
import { buildConversationFacts } from './conversationFacts.js';
import { extractConversationEntities, knownEntitiesFor } from './conversationEntities.js';
import { SELF_GRAPH_ID, SELF_LABEL, SELF_KIND, selfEntityEnabled } from '../identity/selfEntity.js';
import { uusEnabled } from '../../understanding/flags.js';

// `conversation` is a new node CLASS (a source, like `file`). Registered
// idempotently at the point of use rather than only at import: the registry
// is process-local and rebuildable, so an import-time-only registration is a
// hidden ordering dependency — anything that re-seeds the registry would
// silently drop it. registerNodeType is a cheap Map write.
function ensureConversationNodeType() {
  registerNodeType('conversation', { description: 'a conversation turn as a knowledge source', source: 'brain-b3' });
}
ensureConversationNodeType();

/** Ingest is opt-in separately from the read-side kill switch. */
function ingestEnabled() {
  return brainEnabled() && String(process.env.AQUA_BRAIN_INGEST ?? '').toLowerCase() === 'on';
}

/**
 * Writing conversational CLAIMS into the evidence store is gated on its own,
 * beneath entity ingest. Entities are additive to a graph the Brain owns;
 * facts land in a store the document pipeline owns and reads. Separate switch
 * so the riskier half can be revoked without losing the safer half.
 */
export function factIngestEnabled() {
  return ingestEnabled() && String(process.env.AQUA_BRAIN_INGEST_FACTS ?? '').toLowerCase() === 'on';
}

// Per-turn bounds — a runaway message must never balloon the graph.
const MAX_ENTITIES_PER_TURN = 20;
const MAX_FACTS_PER_TURN    = 15;
const MIN_TEXT_LENGTH       = 12;   // below this there is nothing worth resolving

const metrics = {
  turns: 0, skipped: 0, errors: 0,
  entitiesLinked: 0, relationshipsAdded: 0, conversationsSeen: 0,
  factsWritten: 0, factErrors: 0,
  lastDurationMs: 0,
};

/**
 * The synthetic source id for a conversation turn. Shaped like a UKO id so
 * every provenance-bearing edge has a well-formed sourceFile, and stable so
 * re-ingesting the same turn is idempotent (upsert/merge, never duplicate).
 */
function turnSourceId(conversationId, turn) {
  return `conv:${conversationId}:${turn}`;
}

/**
 * A minimal evidenceStore-shaped adapter over ONE turn's text. buildRelationships
 * and entity resolution both expect an evidenceStore that can hand back the
 * evidence behind a fact; conversation facts never touch the real store, so
 * this satisfies the interface in-memory. The evidence id embeds the turn so
 * provenance points back at the exact message.
 */
function turnEvidenceStore(sourceId, facts) {
  const evId = `${sourceId}#ev`;
  const evidence = [{ id: evId, sourceFileId: sourceId, sourceFileName: sourceId, extractionMethod: 'heuristic', confidence: 0.6, snippet: '' }];
  return {
    evidenceForFact: (_o, factId) => (facts.some(f => f.id === factId) ? evidence : []),
    getFact: (_o, factId) => facts.find(f => f.id === factId) ?? null,
    listFacts: () => facts,
  };
}

/**
 * Ingest one conversation turn into the world model.
 *
 * @param {object} deps - { graph } (reasoningGraph), injected for tests
 * @param {object} args - { ownerId, conversationId, turn, userMessage, assistantMessage }
 * @returns {{ ok, entities, relationships, skipped? }}
 */
export function ingestConversationTurn(deps, {
  ownerId, conversationId, turn = 0, userMessage = '', assistantMessage = '',
} = {}) {
  if (!ingestEnabled()) { metrics.skipped += 1; return { ok: false, skipped: 'disabled' }; }
  if (!ownerId || !conversationId) { metrics.skipped += 1; return { ok: false, skipped: 'missing-owner' }; }

  const { graph: G } = deps;

  // The owner's self node, if enabled. Created lazily on first ingest so that
  // user-anchored knowledge has somewhere to attach in the next increment.
  // Fail-open and idempotent; nothing downstream depends on it yet.
  try { deps.ensureSelfEntity?.(deps, ownerId); } catch { /* fail-open */ }
  const started = Date.now();
  try {
    ensureConversationNodeType();
    // Both sides of the turn are knowledge: the user states things, and the
    // assistant's grounded answer states things too. Join them for extraction
    // but keep the source id per-turn.
    const text = `${userMessage}\n${assistantMessage}`.trim();
    if (text.length < MIN_TEXT_LENGTH) { metrics.skipped += 1; return { ok: false, skipped: 'too-short' }; }

    const sourceId = turnSourceId(conversationId, turn);

    // 1. Source node for the turn. Merge-safe: same id re-ingests cleanly.
    G.upsertNode(ownerId, {
      id: `conv:${conversationId}`,
      type: 'conversation',
      label: `Conversation ${conversationId}`,
      kind: 'observed',
      data: { conversationId },
      sourceFiles: [sourceId],
    }, { fileId: sourceId });

    // 2. Extract + resolve entities from the turn.
    //
    //    This used to call the shared `extractEntities` directly, which finds
    //    proper nouns by capitalisation. Chat is not capitalised, so lowercase
    //    turns produced zero entities and fell out at the guard below —
    //    before any fact could be written. `extractConversationEntities`
    //    wraps the shared extractor rather than replacing it: pass A is still
    //    the untouched document heuristic, plus a case-insensitive pass over
    //    entities this owner already has and a narrow set of declaration cues.
    //    The document pipeline is unaffected; it never calls this module.
    const rawEntities = extractConversationEntities(text, {
      limit: MAX_ENTITIES_PER_TURN,
      knownEntities: knownEntitiesFor(G, ownerId),
      // U1 — first-person disclosure. The USER's message only: reading AQUA's
      // own "I can help with…" as the user describing themselves would
      // manufacture evidence from our own output, the same closed loop the
      // Digital Twin avoids by observing the user side alone. Requires both
      // AQUA_UUS and AQUA_SELF_ENTITY — a self subject with no self node to
      // attach to would resolve into a stray entity called "You".
      selfText: (uusEnabled() && selfEntityEnabled()) ? userMessage : null,
    });
    if (!rawEntities.length) {
      metrics.turns += 1; metrics.conversationsSeen += 1;
      return { ok: true, entities: 0, relationships: 0 };
    }

    // The speaker never goes through the resolver. resolveEntities mints an id
    // from a name, and the owner's id is a constant that must not change when
    // their name is learned — so the self mention is lifted out here and
    // re-joined afterwards, pointing at the node ensureSelfEntity created.
    const selfMention = rawEntities.find(e => e.isSelf) ?? null;
    const namedMentions = rawEntities.filter(e => !e.isSelf);

    const mentions = namedMentions.map(e => ({
      value: e.value, type: e.type, fileId: sourceId, fileName: sourceId,
      factId: null, evidenceId: `${sourceId}#ev`,
    }));
    const { entities } = resolveEntities(mentions);
    if (selfMention) {
      entities.push({
        id: SELF_GRAPH_ID, canonical: SELF_LABEL, type: SELF_KIND,
        aliases: [], confidence: 1, isSelf: true,
      });
    }

    // 3. Entity nodes + `mentions` edges from the conversation (provenance =
    //    the turn). Same node shape/id scheme as graphBuilder, so a
    //    conversation entity and a file entity with the same resolved id ARE
    //    the same node — corroboration across sources falls out for free.
    let entitiesLinked = 0;
    const entityNodeByName = new Map();
    for (const e of entities) {
      // The self node already exists, created declaratively by ensureSelfEntity
      // with kind 'declared' and isSelf true. Re-upserting it here as a
      // 'derived' entity would overwrite that provenance with a claim that
      // something inferred the user into existence. The `mentions` edge is the
      // part worth writing — it records that this turn was about them.
      if (!e.isSelf) {
        G.upsertNode(ownerId, {
          id: e.id, type: 'entity', label: e.canonical, kind: 'derived',
          data: { entityType: e.type, aliases: e.aliases, resolutionConfidence: e.confidence, fromConversation: true },
          sourceFiles: [sourceId],
        }, { fileId: sourceId });
      }
      for (const name of [e.canonical, ...e.aliases]) entityNodeByName.set(String(name).toLowerCase(), e.id);
      G.addEdge(ownerId, {
        from: `conv:${conversationId}`, to: e.id, type: 'mentions',
        kind: 'observed', confidence: 0.6,
        evidence: [`${sourceId}#ev`], sourceFiles: [sourceId],
        reason: `mentioned in conversation ${conversationId}`,
      }, { fileId: sourceId });
      entitiesLinked += 1;
    }

    // 3b. Tell PIC the resolver merged surface forms here.
    //
    //     PIC's document path (onKnowledgeIngested) needs ukoIds and reads
    //     evidenceStore; a turn has neither, and faking a UKO would push
    //     conversational claims through a path that treats them as document
    //     objects. onEntitiesResolved records only the merge revision.
    //
    //     Fail-open and fire-and-forget: PIC's bookkeeping must never be able
    //     to cost the caller a turn.
    if (entities.length) {
      try {
        deps.pic?.onEntitiesResolved?.({
          ownerId, entities, source: conversationId, traceId: sourceId,
        });
      } catch { /* fail-open */ }
    }

    // 3c. KNOWLEDGE — conversational claims enter the evidence layer.
    //
    //     This is the seam the audit identified as the single point where AQUA
    //     stopped being a continuously improving understanding engine. Steps 1-3
    //     above give a turn's ENTITIES graph standing; nothing gave its CLAIMS
    //     any. And every retriever reads claims, not entities:
    //
    //       pic/retrievalIntelligence.js:55  Lane 1 → retrieveGroundedFacts(ES)
    //       pic/retrievalIntelligence.js:83  Lane 3 → `about` → ES.getFact
    //       brain/contextEngine/index.js:148 candidates → ES.getFact
    //       brain/reflectionV2/…:140         obsolescence → ES.listFacts
    //
    //     So a turn wrote entity nodes nobody could retrieve a statement from.
    //     "Priya owns billing", said in chat, was unreachable and invisible to
    //     reflection — it could never corroborate or contradict the same claim
    //     from a document.
    //
    //     HONESTY IS PRESERVED, NOT TRADED AWAY. The earlier decision to keep
    //     chat out of evidenceStore conflated TRUST with REACHABILITY. A fact
    //     can be in the index and still be labelled: sourceType 'conversation',
    //     extractionMethod 'heuristic', confidence capped below document grade,
    //     provenance pointing at the exact turn. Distinguishable at every read.
    //     Never masquerading as a document.
    //
    //     Gated separately from entity ingest (AQUA_BRAIN_INGEST_FACTS) because
    //     it is the first thing here that writes to a store the document
    //     pipeline owns, and it must be revocable on its own.
    let factsWritten = 0;
    const writtenFactIds = [];
    if (factIngestEnabled() && deps.evidenceStore) {
      try {
        const ES = deps.evidenceStore;
        const built = buildConversationFacts(
          { conversationId, turn, userMessage, assistantMessage, entities },
        );
        for (const fact of built.facts) {
          // Evidence first: saveEvidence dedupes on content checksum, so the
          // id the store hands back is authoritative — re-ingesting a turn
          // reuses the existing record instead of adding a twin.
          const stored = (fact.evidence ?? [])
            .map(evId => built.evidence.find(e => e.id === evId))
            .filter(Boolean)
            .map(ev => ES.saveEvidence(ownerId, ev));
          const evidenceIds = stored.map(ev => ev.id);
          if (evidenceIds.length) fact.evidence = evidenceIds;

          ES.saveFact(ownerId, fact, { sourceFileId: sourceId });

          // Graph standing: the same node + edge shapes graphBuilder writes for
          // a document fact (graphBuilder.js:91-98), so a conversational fact
          // is traversable by machinery that predates it and needs no special
          // case. `asserts` is seeded as "source → fact"; the conversation node
          // is a source class, registered as one in step 1.
          G.upsertNode(ownerId, {
            id: `fact:${fact.id}`, type: 'fact',
            label: fact.statement.slice(0, 120), kind: 'observed',
            data: { confidence: fact.confidence, fromConversation: true },
            sourceFiles: [sourceId],
          }, { fileId: sourceId });

          G.addEdge(ownerId, {
            from: `conv:${conversationId}`, to: `fact:${fact.id}`, type: 'asserts',
            kind: 'observed', confidence: fact.confidence,
            evidence: evidenceIds, sourceFiles: [sourceId],
            reason: `stated in conversation ${conversationId}`,
          }, { fileId: sourceId });

          // `about` edges are what Lane 3 and the Context Engine hop across.
          // Without them the fact is in the store but off the graph paths that
          // reach it, which is half the gap and the easier half to miss.
          for (const name of fact.entities ?? []) {
            const entityId = entityNodeByName.get(String(name).toLowerCase());
            if (!entityId) continue;
            G.addEdge(ownerId, {
              from: `fact:${fact.id}`, to: entityId, type: 'about',
              kind: 'observed', confidence: fact.confidence,
              evidence: evidenceIds, sourceFiles: [sourceId],
              reason: 'conversational fact about entity',
            }, { fileId: sourceId });
          }

          factsWritten += 1;
          writtenFactIds.push(fact.id);
        }
        metrics.factsWritten += factsWritten;

        // Lifecycle birth. Retrieval would eventually auto-create a record on
        // first hit, but that history starts at `retrieved` and silently omits
        // the linking performed immediately above. Recording it here keeps the
        // lifecycle an account of what actually happened.
        //
        // Fail-open and separate from the write loop: PIC bookkeeping must not
        // undo facts already committed to the store.
        if (writtenFactIds.length) {
          try {
            deps.pic?.onConversationFactsWritten?.({
              ownerId, factIds: writtenFactIds, source: conversationId, traceId: sourceId,
            });
          } catch { /* fail-open */ }
        }
      } catch (err) {
        // Isolated from the rest of ingest: a failure here must not cost the
        // entity/relationship work that already succeeded above.
        metrics.factErrors += 1;
        console.warn(`[BRAIN] conversational fact write failed (fail-open): ${err?.message ?? err}`);
      }
    }

    // 4. Relationships. extractFacts() is a DOCUMENT heuristic — it requires a
    //    numeric token (funding figures, dates) and would drop almost every
    //    conversational sentence. So build relationship input directly: each
    //    sentence naming ≥2 resolved entities becomes a fact carrying those
    //    entities, and the SAME B1 predicate engine types it.
    //
    //    These throwaway fact objects exist only to feed buildRelationships and
    //    are deliberately NOT the ones step 3c persists: relationships need ≥2
    //    entities per sentence, knowledge needs ≥1, so the two sets differ and
    //    conflating them would either lose single-entity claims or invent
    //    relationships from sentences that name one thing.
    const canonicalByNorm = new Map();
    for (const e of entities) for (const name of [e.canonical, ...e.aliases]) canonicalByNorm.set(String(name).toLowerCase(), e.canonical);

    const facts = [];
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (let i = 0; i < sentences.length && facts.length < MAX_FACTS_PER_TURN; i++) {
      const sentence = sentences[i].trim();
      if (sentence.length < MIN_TEXT_LENGTH) continue;
      const lower = sentence.toLowerCase();
      const named = [...new Set(
        [...canonicalByNorm.keys()].filter(n => lower.includes(n)).map(n => canonicalByNorm.get(n)),
      )];
      if (named.length >= 2) {
        facts.push({
          id: `${sourceId}:fact:${i}`,
          statement: sentence,
          entities: named,
          confidence: 0.6,
          evidence: [`${sourceId}#ev`],
        });
      }
    }

    let relationshipsAdded = 0;
    if (facts.length) {
      const es = turnEvidenceStore(sourceId, facts);
      const relationships = buildRelationships(entities, facts, es, ownerId);
      for (const rel of relationships) {
        G.addEdge(ownerId, {
          from: rel.from, to: rel.to, type: rel.type, kind: 'derived',
          // Conversational relationships are capped below document-grade: a
          // thing stated in chat is weaker evidence than a thing extracted
          // from a document with a citation.
          confidence: Math.min(rel.confidence, 0.7),
          evidence: rel.evidence, sourceFiles: rel.sourceFiles,
          reason: `${rel.reason} (conversation)`, id: rel.id,
        }, { fileId: sourceId });
        relationshipsAdded += 1;
      }
    }

    metrics.turns += 1;
    metrics.conversationsSeen += 1;
    metrics.entitiesLinked += entitiesLinked;
    metrics.relationshipsAdded += relationshipsAdded;
    metrics.lastDurationMs = Date.now() - started;

    if (entitiesLinked || relationshipsAdded || factsWritten) {
      console.log(`[BRAIN] Conversation ingested owner=${ownerId} conv=${conversationId} turn=${turn} entities=${entitiesLinked} relationships=${relationshipsAdded} facts=${factsWritten} in ${metrics.lastDurationMs}ms`);
    }
    // `factIds` is returned so E5/PR-6 can project THIS turn's facts into the
    // claim substrate without re-scanning the owner's whole store. The ids were
    // already being collected; only the return shape changed. Callers that
    // ignore it are unaffected — this is additive.
    return {
      ok: true, entities: entitiesLinked, relationships: relationshipsAdded,
      facts: factsWritten, factIds: writtenFactIds,
    };
  } catch (err) {
    metrics.errors += 1;
    console.warn(`[BRAIN] ingestConversationTurn failed (fail-open): ${err?.message ?? err}`);
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export function ingestMetrics() {
  return { ...metrics, enabled: ingestEnabled(), factsEnabled: factIngestEnabled() };
}

export { ingestEnabled };