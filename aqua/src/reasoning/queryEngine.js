/**
 * AQUA Cross-File Query Engine — Cross-File Reasoning (Phase 3)
 *
 * Answers cross-file questions over the Unified Reasoning Graph. This is the
 * query layer, not an agent: it retrieves and assembles CONNECTED knowledge
 * with provenance — it does not plan, act, or execute (those are later,
 * explicitly-excluded phases). Every answer is grounded: each returned item
 * carries its evidence/source-files, and the engine distinguishes observed
 * facts from derived conclusions (the reasoning contract).
 *
 * Supported intents (the brief's cross-file questions):
 *   whichFilesMention(entity)          "Which files mention NVIDIA?"
 *   entitiesInCommon(fileA, fileB)     "Which people appear in both the video and the emails?"
 *   whatSupportsClaim(query)           "Which documents support this claim?"
 *   contradictionsFor(entity?)         "Which files contradict each other?"
 *   timelineAcross()                   "Build a timeline across every uploaded artifact."
 *   whatHappenedBefore(anchor)         "What happened before the contract was signed?"
 *   connectionsBetween(a, b)           multi-hop path between two entities/files
 *   projectSummary()                   "Summarize this entire project."
 *   explainEntity(entity)              "Explain this company."
 *
 * All methods return plain data (nodes/edges/citations) ready for a
 * response layer to render; none call a model. A natural-language planner
 * that maps free-text questions onto these primitives is the next phase —
 * these are the grounded operations it will compose.
 */
import * as G from './reasoningGraph.js';
import { extractEvents, buildTimeline } from './timelineEngine.js';
import { formatCitation } from '../files/evidence.js';

function citationsFor(evidenceStore, ownerId, evidenceIds) {
  return evidenceIds.map(id => evidenceStore.getEvidence(ownerId, id)).filter(Boolean).map(formatCitation);
}

/** "Which files mention NVIDIA?" — resolved entity → its source files. */
export function whichFilesMention(ownerId, entityQuery) {
  const q = entityQuery.toLowerCase();
  const entityNodes = G.nodesByType(ownerId, 'entity').filter(n =>
    n.label.toLowerCase().includes(q) || (n.data.aliases ?? []).some(a => String(a).toLowerCase().includes(q)));

  return entityNodes.map(entity => {
    const files = G.neighbors(ownerId, entity.id, { type: 'file', edgeType: 'mentions' });
    return {
      entity: entity.label, entityType: entity.data.entityType,
      resolutionConfidence: entity.data.resolutionConfidence,
      aliases: entity.data.aliases ?? [],
      files: files.map(({ node, edge }) => ({ file: node.label, fileId: node.sourceFiles[0], reason: edge.reason, confidence: edge.confidence })),
    };
  });
}

/** "Which entities appear in BOTH files?" (people/orgs shared across two files). */
export function entitiesInCommon(ownerId, fileIdA, fileIdB, { type = null } = {}) {
  const a = new Set(G.neighbors(ownerId, `file:${fileIdA}`, { type: 'entity', edgeType: 'mentions' }).map(x => x.node.id));
  const shared = G.neighbors(ownerId, `file:${fileIdB}`, { type: 'entity', edgeType: 'mentions' })
    .filter(x => a.has(x.node.id))
    .filter(x => !type || x.node.data.entityType === type);
  return shared.map(({ node }) => ({
    entity: node.label, entityType: node.data.entityType,
    resolutionConfidence: node.data.resolutionConfidence,
    inBothFiles: node.data.aliases?.length ? `matched across aliases: ${node.data.aliases.join(', ')}` : 'exact',
  }));
}

/** "Which documents support this claim?" — grounded facts matching the claim, with citations. */
export function whatSupportsClaim(evidenceStore, ownerId, claim, { limit = 10 } = {}) {
  const terms = tokenize(claim);
  const factNodes = G.nodesByType(ownerId, 'fact');
  const scored = [];
  for (const fn of factNodes) {
    const hay = fn.label.toLowerCase();
    const hits = terms.filter(t => hay.includes(t)).length;
    if (!hits) continue;
    const factId = fn.id.replace(/^fact:/, '');
    const fact = evidenceStore.getFact(ownerId, factId);
    if (!fact) continue;
    scored.push({
      statement: fact.statement,
      confidence: fact.confidence,
      kind: 'observed',
      citations: citationsFor(evidenceStore, ownerId, fact.evidence),
      sourceFiles: fn.sourceFiles,
      score: hits / terms.length,
    });
  }
  return scored.sort((a, b) => b.score - a.score || b.confidence - a.confidence).slice(0, limit);
}

/** "Which files contradict each other?" — cross-file contradiction edges, both sides + evidence. */
export function contradictionsFor(evidenceStore, ownerId, entityQuery = null) {
  const g = G.nodesByType(ownerId, 'fact'); void g;
  const edges = [];
  for (const factNode of G.nodesByType(ownerId, 'fact')) {
    for (const e of G.edgesOf(ownerId, factNode.id, { type: 'contradicts' })) edges.push(e);
  }
  const seen = new Set();
  const out = [];
  for (const e of edges) {
    if (seen.has(e.id)) continue; seen.add(e.id);
    const [ia, ib] = [e.from, e.to].map(id => id.replace(/^fact:/, ''));
    const fa = evidenceStore.getFact(ownerId, ia), fb = evidenceStore.getFact(ownerId, ib);
    if (!fa || !fb) continue;
    if (entityQuery && !e.reason.toLowerCase().includes(entityQuery.toLowerCase())) continue;
    out.push({
      reason: e.reason,
      sideA: { statement: fa.statement, citations: citationsFor(evidenceStore, ownerId, fa.evidence) },
      sideB: { statement: fb.statement, citations: citationsFor(evidenceStore, ownerId, fb.evidence) },
      kind: 'derived', // a detected disagreement — surfaced, NOT resolved
    });
  }
  return out;
}

/** "Build a timeline across every uploaded artifact." */
export function timelineAcross(evidenceStore, ownerId) {
  const facts = evidenceStore.listFacts(ownerId, { limit: 100000 });
  const events = extractEvents(evidenceStore, ownerId, facts);
  const tl = buildTimeline(events);
  return {
    ...tl,
    ordered: tl.ordered.map(e => ({
      order: e.order, type: e.type, statement: e.statement,
      timestamp: e.timestamp, certainty: e.certainty, position: e.position ?? 'anchored',
      citations: citationsFor(evidenceStore, ownerId, e.evidence),
      sourceFiles: e.sourceFiles, kind: 'derived',
    })),
  };
}

/** "What happened before X?" — events preceding an anchor event/entity in the merged timeline. */
export function whatHappenedBefore(evidenceStore, ownerId, anchorQuery) {
  const { ordered } = timelineAcross(evidenceStore, ownerId);
  const q = anchorQuery.toLowerCase();
  const anchorIdx = ordered.findIndex(e => e.statement.toLowerCase().includes(q) || e.type.replace('_', ' ').includes(q));
  if (anchorIdx < 0) return { anchor: null, before: [], note: 'anchor event not found in the timeline' };
  return { anchor: ordered[anchorIdx], before: ordered.slice(0, anchorIdx) };
}

/** Multi-hop connection between two nodes (entities/files), with the provenance-bearing path. */
export function connectionsBetween(ownerId, fromId, toId, { maxHops = 4 } = {}) {
  const sub = G.traverse(ownerId, fromId, { maxHops, maxNodes: 200 });
  const path = sub.paths.get(toId);
  if (!path) return { connected: false, hops: 0, path: [] };
  return {
    connected: true,
    hops: path.length,
    path: path.map(e => ({ from: e.from, to: e.to, type: e.type, confidence: e.confidence, reason: e.reason, kind: e.kind, evidence: e.evidence })),
  };
}

/** "Summarize this entire project." — graph-shaped overview (not prose; a response layer narrates). */
export function projectSummary(evidenceStore, ownerId) {
  const stats = G.graphStats(ownerId);
  const entities = G.nodesByType(ownerId, 'entity')
    .sort((a, b) => (b.data.fileCount ?? 0) - (a.data.fileCount ?? 0))
    .slice(0, 15)
    .map(n => ({ entity: n.label, type: n.data.entityType, files: n.data.fileCount, confidence: n.data.resolutionConfidence }));
  const events = timelineAcross(evidenceStore, ownerId);
  const contradictions = contradictionsFor(evidenceStore, ownerId);
  return {
    stats,
    keyEntities: entities,
    timelineSize: events.ordered.length,
    firstEvents: events.ordered.slice(0, 5),
    openContradictions: contradictions.length,
    grounding: 'every entity/event/relationship above is backed by evidence in the graph',
  };
}

/** "Explain this company/person." — an entity's neighborhood: facts, relationships, events, files. */
export function explainEntity(evidenceStore, ownerId, entityQuery) {
  const q = entityQuery.toLowerCase();
  const entity = G.nodesByType(ownerId, 'entity').find(n =>
    n.label.toLowerCase().includes(q) || (n.data.aliases ?? []).some(a => String(a).toLowerCase().includes(q)));
  if (!entity) return null;

  const facts = G.neighbors(ownerId, entity.id, { type: 'fact', edgeType: 'about' })
    .map(({ node }) => {
      const fact = evidenceStore.getFact(ownerId, node.id.replace(/^fact:/, ''));
      return fact ? { statement: fact.statement, confidence: fact.confidence, citations: citationsFor(evidenceStore, ownerId, fact.evidence), kind: 'observed' } : null;
    }).filter(Boolean);

  const relationships = G.edgesOf(ownerId, entity.id, { type: 'related_to' }).map(e => {
    const otherId = e.from === entity.id ? e.to : e.from;
    const other = G.getNode(ownerId, otherId);
    return { with: other?.label ?? otherId, confidence: e.confidence, reason: e.reason, kind: 'derived', sourceFiles: e.sourceFiles };
  });

  const events = G.neighbors(ownerId, entity.id, { type: 'event', edgeType: 'involves' })
    .map(({ node }) => ({ event: node.label, timestamp: node.data.timestamp, certainty: node.data.certainty, kind: 'derived' }));

  return {
    entity: entity.label, type: entity.data.entityType,
    aliases: entity.data.aliases ?? [], appearsInFiles: entity.data.fileCount,
    resolutionConfidence: entity.data.resolutionConfidence,
    observedFacts: facts, derivedRelationships: relationships, events,
  };
}

function tokenize(s) {
  return [...String(s).toLowerCase().matchAll(/[a-z0-9][\w\-.]{1,}/g)].map(m => m[0]).filter(t => t.length > 2);
}
