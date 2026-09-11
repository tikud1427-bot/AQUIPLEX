/**
 * AQUA Brain — World Model Projection (Brain V1 / B2)
 *
 * THE FEDERATION
 * --------------
 * Two graphs, historically blind to each other:
 *
 *   reasoningGraph   built from FILES. Entity resolution across documents,
 *                    provenance-enforced edges, typed since B1. Knows that
 *                    "OpenAI", "Open AI" and "OpenAI Inc." are one thing —
 *                    but its entity TYPE is deliberately coarse ('name' for
 *                    every proper noun, to stop identity fragmenting).
 *
 *   mind.graph       built from CONVERSATION. Knows semantic types outright
 *                    (person / organization / project / technology / goal)
 *                    and carries `weight` — how salient a thing is in how
 *                    the user actually talks. But has no provenance and no
 *                    cross-file resolution.
 *
 * Each holds exactly what the other lacks. Joining them on the normalized
 * name gives an entity that is resolved AND typed AND weighted — strictly
 * more than either source knows alone. That join is this module.
 *
 * PROJECTION, NOT STORAGE
 * -----------------------
 * Nothing here is written back. The Brain never mutates reasoningGraph or
 * the Mind; it reads both and assembles a view, so the owning subsystems
 * stay the single source of truth and account deletion still has exactly
 * two places to purge, not three.
 *
 * Pure over injected deps — { graph, peekMind, evidenceStore, annotations } —
 * so every path is testable without touching disk.
 */
import { normalizeMention } from '../../reasoning/entityResolver.js';
import { registerEdgeType, EDGE_CLASS } from '../../reasoning/typeRegistry.js';
import {
  createEntityView, createRelationshipView, createObservationView, createEventView,
  computeConfidence, computeImportance, importanceBreakdown, round3,
} from './schema.js';

/**
 * The Mind kept its own frozen edge vocabulary (mindSchema.js), four types of
 * which the B1 registry had never heard of. Register them so unified
 * relationship queries speak ONE vocabulary rather than two dialects — this
 * is exactly the extensibility B1 opened the registry for.
 */
const MIND_ONLY_EDGE_TYPES = [
  ['works_with',    'person ↔ person collaboration (mind)'],
  ['part_of',       'X is part of Y (mind)'],
  ['interested_in', 'user → topic/technology interest (mind)'],
  ['targets',       'effort → goal (mind)'],
];

/**
 * Idempotent, and called on every projection rather than only at import.
 *
 * The registry is process-local and rebuildable, so a one-shot registration
 * at module load is a hidden ordering dependency: anything that re-seeds the
 * registry (today only tests, tomorrow a reload path) would silently leave
 * mind edge types unregistered and the two vocabularies split again. Making
 * it a cheap idempotent call at the point of use removes the ordering
 * assumption entirely — registerEdgeType is a Map write on a set of four.
 */
export function ensureMindVocabulary() {
  for (const [type, description] of MIND_ONLY_EDGE_TYPES) {
    registerEdgeType(type, { class: EDGE_CLASS.RELATED, description, source: 'mind-vocabulary' });
  }
}
ensureMindVocabulary();

/** Mind node types that represent real-world things worth federating. */
const MIND_ENTITY_TYPES = new Set(['person', 'organization', 'project', 'goal', 'technology', 'artifact']);

/** The Mind's placeholder for the user themself — not a world entity. */
const MIND_SELF_KEY = 'person:__self__';

// ── Index ────────────────────────────────────────────────────────────────────

/**
 * Build the join once, reuse it for many lookups. Callers doing a single
 * lookup can ignore this and use projectEntity(), which builds internally.
 *
 * @param {object} deps - { graph, peekMind }
 * @returns {{ byId: Map, byName: Map, mindOnly: Map }}
 */
/**
 * Canonical-ID joining (Phase 1 / M2).
 *
 * Off (default): the join is by normalized name, exactly as before.
 * On: identity is asked first, and the string match remains as a FALLBACK.
 *
 * The fallback is what makes the cutover non-regressive by construction. The
 * ID join can only ADD matches the string match missed — it can never take
 * one away, because anything the string match still finds is still used. That
 * turns the backfill's diff from a gate against loss into a measurement of
 * gain, which is a far safer thing to flip on production data.
 */
const canonicalIdsEnabled = () => process.env.AQUA_CANONICAL_IDS === 'on';

/**
 * Resolve a mind node to a reasoning entity id through canonical identity.
 * Returns null whenever identity has nothing to say, so the caller falls back.
 */
function idJoin(deps, ownerId, label, type) {
  const C = deps.canonicalIds;
  if (!C) return null;
  try {
    const hit = C.lookup(ownerId, label, type);
    if (!hit?.id) return null;
    const ref = (C.refs(ownerId, hit.id) ?? []).find(r => r.space === 'reasoning');
    return ref?.ref ?? null;
  } catch {
    return null;   // identity is an optimization; it must never break the join
  }
}

export function buildWorldIndex(deps, ownerId) {
  const { graph: G, peekMind } = deps;
  const useIds = canonicalIdsEnabled();
  ensureMindVocabulary();
  const byId = new Map();     // reasoning entity id → { node, mindNode, mindKey }
  const byName = new Map();   // normalized name → entity id

  for (const node of G.nodesByType(ownerId, 'entity')) {
    byId.set(node.id, { node, mindNode: null, mindKey: null });
    for (const name of [node.label, ...(node.data?.aliases ?? [])]) {
      const n = normalizeMention(name);
      if (n && !byName.has(n)) byName.set(n, node.id);
    }
  }

  // Join the conversation-side graph in by normalized name.
  const mind = peekMind?.(ownerId) ?? null;
  const mindOnly = new Map();  // mind key → mind node (no file-side match)
  for (const [key, mindNode] of Object.entries(mind?.graph?.nodes ?? {})) {
    if (key === MIND_SELF_KEY) continue;
    if (!MIND_ENTITY_TYPES.has(mindNode.type)) continue;
    const n = normalizeMention(mindNode.label);
    // Identity first, normalized name second. Both consult the same
    // similarity rules, so they agree wherever the map has been backfilled;
    // where the map is empty or stale, the string match still carries it.
    const viaId = useIds ? idJoin(deps, ownerId, mindNode.label, mindNode.type) : null;
    const matchId = (viaId && byId.has(viaId)) ? viaId : (n ? byName.get(n) : null);
    if (matchId) {
      const rec = byId.get(matchId);
      // First match wins; a second mind node with the same normalized name
      // is the same real-world thing typed differently, so fold its weight in.
      if (rec.mindNode) rec.mindNode = { ...rec.mindNode, weight: (rec.mindNode.weight ?? 0) + (mindNode.weight ?? 0) };
      else { rec.mindNode = mindNode; rec.mindKey = key; }
    } else {
      mindOnly.set(key, mindNode);
      if (n && !byName.has(n)) byName.set(n, `mind:${key}`);
    }
  }

  return { byId, byName, mindOnly, mind };
}

// ── Entities ─────────────────────────────────────────────────────────────────

/**
 * Assemble one unified Entity.
 *
 * TYPE PRECEDENCE is the clearest payoff of the federation: the Mind's
 * semantic type wins over the file side's 'name', because chat genuinely
 * knows "Aquiplex is an organization" while document extraction deliberately
 * refuses to guess. Neither source could produce this alone.
 */
function assembleEntity(deps, ownerId, { node, mindNode, mindKey }, index) {
  const { graph: G, evidenceStore: ES, annotations: A } = deps;
  const id = node?.id ?? `mind:${mindKey}`;
  const ann = A?.getAnnotation(ownerId, id) ?? null;

  const reasoningType = node?.data?.entityType ?? null;
  const type = mindNode?.type
    ?? (reasoningType && reasoningType !== 'name' ? reasoningType : null)
    ?? reasoningType
    ?? 'entity';

  const sourceFiles = node?.sourceFiles ?? [];
  const sourceCount = sourceFiles.length + (mindNode ? 1 : 0);

  // Degree + observations come from whichever graphs actually hold this node.
  const reasoningEdges = node ? G.edgesOf(ownerId, node.id) : [];
  const mindDegree = mindKey ? countMindEdges(index?.mind, mindKey) : 0;
  const degree = reasoningEdges.length + mindDegree;
  const observationCount = node
    ? G.neighbors(ownerId, node.id, { type: 'fact', edgeType: 'about' }).length
    : 0;

  const mindWeight = mindNode?.weight ?? 0;
  const createdAts = [node?.createdAt, mindNode?.createdAt].filter(Boolean);
  const firstSeenAt = createdAts.length ? Math.min(...createdAts) : null;
  const lastSeenAt = Math.max(
    firstSeenAt ?? 0,
    mindKey ? lastMindTouch(index?.mind, mindKey) : 0,
  ) || null;

  const signals = { sourceCount, degree, observationCount, mindWeight, lastSeenAt };

  const derivedConfidence = computeConfidence({
    resolutionConfidence: node?.data?.resolutionConfidence ?? null,
    sourceCount,
  });
  const derivedImportance = computeImportance(signals);

  return createEntityView({
    id,
    type,
    title: node?.label ?? mindNode?.label ?? id,
    aliases: [
      ...(node?.data?.aliases ?? []),
      ...(mindNode && node && normalizeMention(mindNode.label) !== normalizeMention(node.label) ? [mindNode.label] : []),
      ...(ann?.aliases ?? []),
    ],
    description: ann?.description ?? '',
    metadata: {
      reasoningType,
      mindType: mindNode?.type ?? null,
      fileCount: node?.data?.fileCount ?? sourceFiles.length,
      resolutionConfidence: node?.data?.resolutionConfidence ?? null,
      tags: ann?.tags ?? [],
      pinned: ann?.pinned ?? false,
      ...(ann?.metadata ?? {}),
      importanceBreakdown: importanceBreakdown(signals),
    },
    // An override is a deliberate correction and wins over the derived value;
    // the derived number is kept alongside so nothing is silently lost.
    confidence: ann?.confidenceOverride ?? derivedConfidence,
    importance: ann?.importanceOverride ?? derivedImportance,
    firstSeenAt,
    lastSeenAt,
    updatedAt: ann?.updatedAt ?? lastSeenAt,
    sourceRefs: {
      files: sourceFiles,
      mindKey: mindKey ?? null,
      observations: ES ? observationIds(deps, ownerId, node) : [],
    },
    ids: { reasoning: node?.id ?? null, mind: mindKey ?? null },
    signals: { ...signals, derivedConfidence, derivedImportance },
    annotated: !!ann,
  });
}

function observationIds(deps, ownerId, node) {
  if (!node) return [];
  return deps.graph
    .neighbors(ownerId, node.id, { type: 'fact', edgeType: 'about' })
    .map(({ node: n }) => n.id.replace(/^fact:/, ''))
    .slice(0, 50);
}

function countMindEdges(mind, key) {
  if (!mind?.graph?.edges) return 0;
  let n = 0;
  for (const e of Object.values(mind.graph.edges)) if (e.from === key || e.to === key) n++;
  return n;
}

function lastMindTouch(mind, key) {
  if (!mind?.graph?.edges) return 0;
  let last = 0;
  for (const e of Object.values(mind.graph.edges)) {
    if (e.from === key || e.to === key) last = Math.max(last, e.lastSeenAt ?? e.createdAt ?? 0);
  }
  return last;
}

/** All entities in the owner's world, most important first. */
export function projectEntities(deps, ownerId, { limit = 100, minImportance = 0, type = null } = {}) {
  const index = buildWorldIndex(deps, ownerId);
  const out = [];
  for (const rec of index.byId.values()) out.push(assembleEntity(deps, ownerId, rec, index));
  for (const [mindKey, mindNode] of index.mindOnly) {
    out.push(assembleEntity(deps, ownerId, { node: null, mindNode, mindKey }, index));
  }
  return out
    .filter(e => (!type || e.type === type) && e.importance >= minImportance)
    .sort((a, b) => b.importance - a.importance || String(a.title).localeCompare(String(b.title)))
    .slice(0, limit);
}

/** One entity by unified id (reasoning id or `mind:<key>`). */
export function projectEntity(deps, ownerId, entityId, index = null) {
  const idx = index ?? buildWorldIndex(deps, ownerId);
  const rec = idx.byId.get(entityId);
  if (rec) return assembleEntity(deps, ownerId, rec, idx);
  if (String(entityId).startsWith('mind:')) {
    const key = String(entityId).slice(5);
    const mindNode = idx.mindOnly.get(key);
    if (mindNode) return assembleEntity(deps, ownerId, { node: null, mindNode, mindKey: key }, idx);
  }
  return null;
}

/**
 * Find entities by name or alias. Normalized match first (the same
 * normalization entity resolution uses, so "OpenAI Inc." finds "OpenAI"),
 * then a substring pass for partial queries.
 */
export function findEntities(deps, ownerId, query, { limit = 10 } = {}) {
  if (!query) return [];
  const idx = buildWorldIndex(deps, ownerId);
  const norm = normalizeMention(query);
  const hits = new Map();

  const exactId = idx.byName.get(norm);
  if (exactId) {
    const e = projectEntity(deps, ownerId, exactId, idx);
    if (e) hits.set(e.id, e);
  }
  if (norm) {
    for (const [name, id] of idx.byName) {
      if (hits.size >= limit * 3) break;
      if (name !== norm && (name.includes(norm) || norm.includes(name))) {
        const e = projectEntity(deps, ownerId, id, idx);
        if (e && !hits.has(e.id)) hits.set(e.id, e);
      }
    }
  }
  return [...hits.values()]
    .sort((a, b) => b.importance - a.importance)
    .slice(0, limit);
}

// ── Relationships ────────────────────────────────────────────────────────────

/**
 * Every relationship touching an entity, from BOTH graphs, in one vocabulary.
 *
 * The file side contributes provenance-bearing typed edges (B1). The mind
 * side contributes weighted conversational edges with no provenance — kept
 * distinguishable via `origin`, never blended, so a caller can always tell a
 * document-grounded claim from a conversational impression.
 */
export function projectRelationships(deps, ownerId, entityId, { limit = 50, index = null } = {}) {
  const { graph: G } = deps;
  const idx = index ?? buildWorldIndex(deps, ownerId);
  const entity = projectEntity(deps, ownerId, entityId, idx);
  if (!entity) return [];

  const out = [];

  if (entity.ids.reasoning) {
    for (const e of G.edgesOf(ownerId, entity.ids.reasoning, { type: EDGE_CLASS.RELATED })) {
      out.push(createRelationshipView({
        id: e.id, from: e.from, to: e.to, type: e.type, kind: e.kind,
        confidence: e.confidence, reason: e.reason,
        evidence: e.evidence ?? [], sourceFiles: e.sourceFiles ?? [],
        origin: 'reasoning',
        otherId: e.from === entity.ids.reasoning ? e.to : e.from,
      }));
    }
  }

  if (entity.ids.mind && idx.mind?.graph?.edges) {
    const key = entity.ids.mind;
    for (const e of Object.values(idx.mind.graph.edges)) {
      if (e.from !== key && e.to !== key) continue;
      out.push(createRelationshipView({
        id: e.key ?? e.id,
        from: mindKeyToEntityId(idx, e.from),
        to: mindKeyToEntityId(idx, e.to),
        type: e.type,
        kind: 'derived',
        // Mind edges carry weight, not confidence. Weight is a repetition
        // count, so saturate it into 0..1 rather than inventing a number.
        confidence: round3(Math.min(0.9, 0.4 + 0.1 * ((e.weight ?? 1) - 1))),
        reason: e.note || `observed in conversation ×${e.weight ?? 1}`,
        evidence: [], sourceFiles: [],
        origin: 'mind', weight: e.weight ?? 1,
        otherId: mindKeyToEntityId(idx, e.from === key ? e.to : e.from),
      }));
    }
  }

  return out.sort((a, b) => b.confidence - a.confidence).slice(0, limit);
}

/** Map a mind node key back to its federated entity id where one exists. */
function mindKeyToEntityId(idx, key) {
  for (const [id, rec] of idx.byId) if (rec.mindKey === key) return id;
  return `mind:${key}`;
}

// ── Observations + events ────────────────────────────────────────────────────

/**
 * Grounded facts about an entity. evidenceStore stays the owner — this
 * hydrates through the graph's `about` edges rather than copying anything.
 */
export function projectObservations(deps, ownerId, entityId, { limit = 25, index = null } = {}) {
  const { graph: G, evidenceStore: ES } = deps;
  const idx = index ?? buildWorldIndex(deps, ownerId);
  const entity = projectEntity(deps, ownerId, entityId, idx);
  if (!entity?.ids.reasoning || !ES) return [];

  const out = [];
  for (const { node } of G.neighbors(ownerId, entity.ids.reasoning, { type: 'fact', edgeType: 'about' })) {
    const fact = ES.getFact(ownerId, node.id.replace(/^fact:/, ''));
    if (!fact) continue;
    out.push(createObservationView({
      id: fact.id, statement: fact.statement, entities: fact.entities ?? [],
      confidence: fact.confidence, evidence: fact.evidence ?? [],
      sourceFiles: node.sourceFiles ?? [], observedAt: fact.createdAt ?? null,
    }));
  }
  return out.sort((a, b) => b.confidence - a.confidence).slice(0, limit);
}

/**
 * Events involving an entity, from both sides: reasoning-graph event nodes
 * (extracted from file facts) and the Mind's own timeline. B7 builds causal
 * chains on top of this; B2 only has to make them addressable together.
 */
export function projectEvents(deps, ownerId, entityId, { limit = 25, index = null } = {}) {
  const { graph: G } = deps;
  const idx = index ?? buildWorldIndex(deps, ownerId);
  const entity = projectEntity(deps, ownerId, entityId, idx);
  if (!entity) return [];

  const out = [];
  if (entity.ids.reasoning) {
    for (const { node } of G.neighbors(ownerId, entity.ids.reasoning, { type: 'event', edgeType: 'involves' })) {
      out.push(createEventView({
        id: node.id, label: node.label, eventType: node.data?.eventType ?? null,
        timestamp: node.data?.timestamp ?? null, certainty: node.data?.certainty ?? null,
        entities: [entity.id], sourceFiles: node.sourceFiles ?? [], origin: 'reasoning',
      }));
    }
  }

  const title = String(entity.title ?? '').toLowerCase();
  for (const ev of idx.mind?.timeline ?? []) {
    const subject = String(ev.subject ?? '').toLowerCase();
    if (!title || !subject.includes(title)) continue;
    out.push(createEventView({
      id: ev.id, label: `${ev.kind}: ${ev.subject}`, eventType: ev.kind,
      timestamp: ev.ts ?? null, certainty: null,
      entities: [entity.id], sourceFiles: [], origin: 'mind',
    }));
  }

  return out
    .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0))
    .slice(0, limit);
}

// ── Stats ────────────────────────────────────────────────────────────────────

/** A read-only picture of the unified world — how much came from where. */
export function worldStats(deps, ownerId) {
  const idx = buildWorldIndex(deps, ownerId);
  let federated = 0;
  for (const rec of idx.byId.values()) if (rec.mindNode) federated++;
  return {
    entities: idx.byId.size + idx.mindOnly.size,
    fileOnly: idx.byId.size - federated,
    mindOnly: idx.mindOnly.size,
    federated,   // present in BOTH graphs — the join's actual yield
  };
}