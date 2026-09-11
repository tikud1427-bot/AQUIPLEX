/**
 * AQUA Brain — Reflection Engine V2: Delta Reflector (Brain V1 / B5)
 *
 * THE BRIEF'S INSTRUCTION
 * ----------------------
 * "Every meaningful interaction should answer: What changed? What was
 *  learned? Which entities changed? Which relationships changed? Did goals
 *  change? Did projects change? Did assumptions change? Did beliefs change?
 *  Which memories became obsolete? Should the World Model be updated?
 *  Reflection should modify STRUCTURED KNOWLEDGE. Not simply save text
 *  summaries."
 *
 * The two existing reflectors each answer part of this and both emit rich
 * structured reports already — mind/reflectionEngine (beliefs decay/promote/
 * archive, goals stale) and cognition/reflectionEngine (strategy
 * effectiveness). What neither touches is the WORLD MODEL: which entities and
 * typed relationships appeared or shifted, and which stored knowledge a new
 * claim just made obsolete. That is the gap B5 fills.
 *
 * WHAT THIS PRODUCES
 * ------------------
 * A structured `WorldDelta` — a diff object, never prose:
 *
 *   {
 *     entitiesChanged:      [{ id, change: 'added'|'corroborated'|'grew', … }],
 *     relationshipsChanged: [{ id, type, change: 'added'|'strengthened'|'retyped' }],
 *     goalsChanged:         [{ title, change }],       // read from the Mind report
 *     assumptionsRevised:   [{ subject, from, to, reason }],  // contradiction-driven
 *     obsoleted:            [{ factId, supersededBy, reason }],
 *     beliefsChanged:       [...],                      // passed through from Mind
 *     worldModelUpdated:    boolean,
 *   }
 *
 * It is computed by DIFFING two cheap snapshots of the graph (before/after
 * the window of turns since the last reflection). Snapshots are structural
 * fingerprints — node ids + edge ids + confidences — not copies of the
 * knowledge, so this stays O(nodes+edges) and holds nothing it shouldn't.
 *
 * The reflector only DESCRIBES the delta. deltaApplier.js is what acts on it
 * (lifecycle transitions, annotation updates) — separation kept deliberately
 * so the "what changed" computation is pure and testable in isolation.
 *
 * Pure over injected deps. No I/O, no model.
 */
import { round3 } from '../worldModel/schema.js';

/**
 * A structural fingerprint of an owner's graph — enough to diff against a
 * later one, cheap enough to take every reflection. Not a knowledge copy:
 * node ids + labels, edge ids + type + confidence, and per-entity source
 * count (the corroboration signal).
 *
 * @param {object} deps - { graph }
 * @returns {{ nodes: Map, edges: Map, takenAt: number }}
 */

/**
 * Canonical Postgres snapshot adapter.
 *
 * The canonical substrate is authoritative for E5+ reflection. It deliberately
 * uses the same fingerprint shape as the legacy graph snapshot so the pure
 * diff machinery remains reusable and testable.
 */
export function snapshotCanonicalWorldModel(snapshot) {
  const nodes = new Map();
  const edges = new Map();
  const claims = Array.isArray(snapshot?.claims) ? snapshot.claims : [];

  for (const e of snapshot?.entities ?? []) {
    nodes.set(e.entity_id, {
      id: e.entity_id,
      label: e.canonical_label,
      sourceCount: Number(e.source_count ?? e.mention_count ?? 0),
      type: e.type ?? null,
      identityKey: e.identity_key ?? null,
    });
  }

  for (const edge of snapshot?.edges ?? []) {
    edges.set(edge.edge_id, {
      id: edge.edge_id,
      type: edge.predicate,
      confidence: Number(edge.confidence ?? 0.5),
      from: edge.from_entity_id,
      to: edge.to_entity_id,
      claimId: edge.claim_id ?? null,
    });
  }

  return { nodes, edges, claims, events: snapshot?.events ?? [], takenAt: Date.now(), canonical: true };
}

/**
 * Canonical contradiction/obsolescence proposal. Two claims can supersede
 * one another only when they describe the same subject + predicate, differ in
 * their asserted value, and their validity windows overlap (or are timeless).
 * This avoids turning legitimate historical changes into contradictions.
 */
export function detectCanonicalObsolescence(snapshot, { since = 0 } = {}) {
  const claims = Array.isArray(snapshot?.claims) ? snapshot.claims : [];
  const groups = new Map();
  const out = [];
  const revised = [];

  const time = c => {
    const v = c.asserted_at ?? c.updated_at ?? c.created_at;
    const n = typeof v === 'number' ? v : Date.parse(String(v ?? ''));
    return Number.isFinite(n) ? n : 0;
  };
  const normValue = c => JSON.stringify([
    c.object_entity_id ?? null,
    c.object_literal ?? null,
    c.object_quantity ?? null,
    c.object_unit ?? null,
    c.object_time_from ?? null,
    c.object_time_to ?? null,
    c.polarity ?? 'asserted',
    c.modality ?? 'fact',
  ]);
  const overlaps = (a, b) => {
    const af = a.valid_from ? Date.parse(String(a.valid_from)) : -Infinity;
    const at = a.valid_to ? Date.parse(String(a.valid_to)) : Infinity;
    const bf = b.valid_from ? Date.parse(String(b.valid_from)) : -Infinity;
    const bt = b.valid_to ? Date.parse(String(b.valid_to)) : Infinity;
    return af <= bt && bf <= at;
  };

  for (const c of claims) {
    if (!c?.claim_id || !c.subject_entity_id || !c.predicate) continue;
    const key = `${c.subject_entity_id}\0${c.predicate}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  for (const [key, group] of groups) {
    group.sort((a, b) => time(a) - time(b));
    for (let i = 1; i < group.length; i += 1) {
      const older = group[i - 1], newer = group[i];
      if (normValue(older) === normValue(newer) || !overlaps(older, newer)) continue;
      if (time(newer) < since) continue;
      out.push({
        factId: older.claim_id,
        supersededBy: newer.claim_id,
        entity: newer.subject_label ?? newer.subject_identity ?? key.split('\0')[0],
        reason: `canonical ${newer.predicate} conflict; newer claim supersedes`,
      });
      revised.push({
        subject: newer.subject_label ?? newer.subject_identity ?? key.split('\0')[0],
        from: older.statement_text ?? '',
        to: newer.statement_text ?? '',
        reason: `canonical ${newer.predicate} conflict`,
      });
    }
  }
  return { obsoleted: out, assumptionsRevised: revised };
}

export function snapshotGraph(deps, ownerId) {
  const { graph: G } = deps;
  const nodes = new Map();
  const edges = new Map();
  if (!G || !ownerId) return { nodes, edges, takenAt: Date.now() };

  for (const n of G.nodesByType(ownerId, 'entity')) {
    nodes.set(n.id, {
      id: n.id,
      label: n.label,
      sourceCount: (n.sourceFiles ?? []).length,
      type: n.data?.entityType ?? null,
    });
  }
  // Semantic edges only — the entity↔entity relationships the brief cares
  // about. Structural wiring (mentions/asserts/…) is not "a relationship
  // changing" in the sense reflection reports.
  for (const n of G.nodesByType(ownerId, 'entity')) {
    for (const e of G.edgesOf(ownerId, n.id, { type: 'related_to' })) {
      if (edges.has(e.id)) continue;
      edges.set(e.id, { id: e.id, type: e.type, confidence: e.confidence ?? 0.5, from: e.from, to: e.to });
    }
  }
  return { nodes, edges, takenAt: Date.now() };
}

/**
 * Diff two graph snapshots into the entity + relationship portions of a
 * WorldDelta. Everything is observed from the fingerprints — nothing is
 * inferred or invented.
 */
export function diffSnapshots(before, after) {
  const entitiesChanged = [];
  const relationshipsChanged = [];

  // Entities: added, or corroborated (more sources), or grew a new type.
  for (const [id, now] of after.nodes) {
    const was = before.nodes.get(id);
    if (!was) {
      entitiesChanged.push({ id, label: now.label, change: 'added', sourceCount: now.sourceCount });
    } else if (now.sourceCount > was.sourceCount) {
      entitiesChanged.push({ id, label: now.label, change: 'corroborated', from: was.sourceCount, to: now.sourceCount });
    } else if (!was.type && now.type) {
      entitiesChanged.push({ id, label: now.label, change: 'typed', to: now.type });
    }
  }

  // Relationships: added, strengthened (confidence up), or retyped
  // (generic → specific, the B1 upgrade path showing up in reflection).
  for (const [id, now] of after.edges) {
    const was = before.edges.get(id);
    if (!was) {
      relationshipsChanged.push({ id, type: now.type, change: 'added', from: now.from, to: now.to, confidence: now.confidence });
    } else if (now.type !== was.type) {
      relationshipsChanged.push({ id, type: now.type, change: 'retyped', fromType: was.type, from: now.from, to: now.to });
    } else if (now.confidence - was.confidence > 0.05) {
      relationshipsChanged.push({ id, type: now.type, change: 'strengthened', from: round3(was.confidence), to: round3(now.confidence) });
    }
  }

  return { entitiesChanged, relationshipsChanged };
}

/**
 * Obsolescence: a new conversational claim about an entity can supersede an
 * older stored fact. We use the graph's OWN cross-file contradiction
 * detector (relationshipEngine) so the judgement is the same one the rest of
 * AQUA already trusts — reflection does not invent a second, divergent notion
 * of "these disagree".
 *
 * A contradiction between a newer and an older fact about the same entity is
 * reported as the older fact being obsoleted BY the newer one. Reflection
 * only proposes this; the applier decides whether to act (and lifecycle
 * transitions are reversible — archived, never deleted).
 *
 * @param {object} deps - { graph, evidenceStore, detectContradictions, resolveEntities }
 * @returns {{ obsoleted: Array, assumptionsRevised: Array }}
 */
export function detectObsolescence(deps, ownerId, { since = 0 } = {}) {
  const { evidenceStore: ES, detectContradictions, buildEntitiesForOwner } = deps;
  const obsoleted = [];
  const assumptionsRevised = [];
  if (!ES || !detectContradictions || !buildEntitiesForOwner) return { obsoleted, assumptionsRevised };

  const facts = ES.listFacts(ownerId, { limit: 5000 });
  if (!facts.length) return { obsoleted, assumptionsRevised };

  const entities = buildEntitiesForOwner(deps, ownerId, facts);
  const contradictions = detectContradictions(entities, facts, ES, ownerId) ?? [];

  for (const c of contradictions) {
    // Order the two conflicting facts by recency; the newer supersedes.
    const [a, b] = c.factIds;
    const fa = ES.getFact(ownerId, a);
    const fb = ES.getFact(ownerId, b);
    if (!fa || !fb) continue;
    const aNewer = (fa.createdAt ?? 0) >= (fb.createdAt ?? 0);
    const [newer, older] = aNewer ? [fa, fb] : [fb, fa];

    // Only treat it as obsolescence if the newer fact arrived AFTER the last
    // reflection — otherwise it is a standing contradiction the user already
    // knows about, not something that "just became obsolete".
    if ((newer.createdAt ?? 0) < since) continue;

    obsoleted.push({
      factId: older.id,
      supersededBy: newer.id,
      entity: c.entity,
      reason: `${c.type} conflict about "${c.entity}"; newer statement supersedes`,
    });
    assumptionsRevised.push({
      subject: c.entity,
      from: older.statement,
      to: newer.statement,
      reason: c.reason ?? `${c.type} conflict`,
    });
  }
  return { obsoleted, assumptionsRevised };
}

/**
 * Assemble the full WorldDelta from: a before/after graph diff, obsolescence
 * detection, and the Mind's own reflection report (goals + beliefs — already
 * structured, so we pass the relevant slices through rather than recomputing).
 *
 * @returns {object} the structured WorldDelta
 */
export function computeWorldDelta({ diff, obsolescence, mindReport = null }) {
  const goalsChanged = [];
  const beliefsChanged = [];
  if (mindReport) {
    for (const t of mindReport.goalsStaled ?? []) goalsChanged.push({ title: t, change: 'staled' });
    for (const l of mindReport.learned ?? []) beliefsChanged.push({ key: l.key, change: 'established', confidence: l.confidence });
    for (const w of mindReport.weakened ?? []) beliefsChanged.push({ key: w.key, change: 'weakened', from: w.from, to: w.to });
    for (const a of mindReport.archived ?? []) beliefsChanged.push({ key: a, change: 'archived' });
  }

  const worldModelUpdated =
    (diff.entitiesChanged?.length ?? 0) > 0 ||
    (diff.relationshipsChanged?.length ?? 0) > 0 ||
    (obsolescence.obsoleted?.length ?? 0) > 0;

  return {
    entitiesChanged:      diff.entitiesChanged ?? [],
    relationshipsChanged: diff.relationshipsChanged ?? [],
    goalsChanged,
    beliefsChanged,
    assumptionsRevised:   obsolescence.assumptionsRevised ?? [],
    obsoleted:            obsolescence.obsoleted ?? [],
    worldModelUpdated,
    // A one-line human-readable digest is fine AS METADATA, but it is derived
    // FROM the structured delta, never the other way round.
    summary: digest(diff, obsolescence, goalsChanged, beliefsChanged),
  };
}

function digest(diff, obs, goals, beliefs) {
  const parts = [];
  if (diff.entitiesChanged?.length) parts.push(`${diff.entitiesChanged.length} entit${diff.entitiesChanged.length === 1 ? 'y' : 'ies'} changed`);
  if (diff.relationshipsChanged?.length) parts.push(`${diff.relationshipsChanged.length} relationship(s) changed`);
  if (obs.obsoleted?.length) parts.push(`${obs.obsoleted.length} fact(s) obsoleted`);
  if (goals.length) parts.push(`${goals.length} goal(s) changed`);
  if (beliefs.length) parts.push(`${beliefs.length} belief(s) changed`);
  return parts.length ? parts.join('; ') : 'no structural change';
}
