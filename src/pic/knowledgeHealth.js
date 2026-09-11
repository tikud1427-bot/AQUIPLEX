/**
 * AQUA Knowledge Health — Persistent Intelligence Core (Phase 4)
 *
 * "Continuously monitor. Provide maintenance APIs." Every check the brief
 * names, computed from the EXISTING stores (nothing new is persisted here;
 * the report itself is a snapshot, logged to the PIC ledger for trend
 * observability):
 *
 *   duplicateEntities    ambiguous pairs the resolver refused to auto-merge
 *   brokenEvidence       facts citing evidence ids that no longer exist
 *   orphanedKnowledge    evidence no fact references; facts with no evidence
 *   missingRelationships multi-file entities with zero related_to edges
 *   staleKnowledge       facts flagged stale by consolidation
 *   conflictingFacts     open contradicts edges (surfaced, unresolved)
 *   lowConfidence        active facts below LOW_CONF
 *   unusedEmbeddings     UKOs that indexed chunks but were later evicted
 *                        from the store (namespace count vs live objects)
 *   invalidReferences    graph edges pointing at nodes that don't exist
 *
 * runMaintenance() = consolidate → re-check → snapshot. Read-only except
 * through the consolidation engine's annotate-and-archive path — maintenance
 * never rewrites a claim and never deletes knowledge.
 */
import { resolveEntities } from '../reasoning/entityResolver.js';
import { consolidateOwner } from './consolidationEngine.js';
import { ledger, getLedger } from './picStore.js';

const LOW_CONF = 0.4;

/**
 * @param {object} deps - { evidenceStore, ukoStore, graph }
 * @param {string} ownerId
 * @returns {object} health report (counts + bounded samples, never full dumps)
 */
export function healthReport(deps, ownerId) {
  const { evidenceStore: ES, ukoStore: US, graph: G } = deps;
  const started = Date.now();
  const facts = ES.listFacts(ownerId, { limit: 100000 });
  const ukos  = US.listUKOs(ownerId, { limit: 100000 });
  const active = facts.filter(f => !f.archived);

  // broken / orphaned
  const brokenEvidence = [];
  const orphanFacts = [];
  for (const f of active) {
    const hydrated = ES.evidenceForFact(ownerId, f.id);
    if (hydrated.length < f.evidence.length) brokenEvidence.push(f.id);
    if (f.evidence.length === 0) orphanFacts.push(f.id);
  }
  let orphanEvidence = 0;
  for (const u of ukos) {
    for (const ev of ES.evidenceForFile(ownerId, u.id)) {
      if (!ES.factsForEvidence(ownerId, ev.id).length) orphanEvidence += 1;
    }
  }

  // duplicate-entity candidates — same compact mention set the graph builder
  // resolves over, so this mirrors what ingestion actually saw.
  const mentions = [];
  for (const f of active) {
    for (const raw of f.entities ?? []) mentions.push({ value: raw, type: 'name', fileId: null, fileName: null });
  }
  const { ambiguous } = resolveEntities(mentions);

  // graph-side checks
  let conflictingFacts = 0, missingRelationships = 0, invalidReferences = 0;
  const entityNodes = G.nodesByType(ownerId, 'entity');
  const seenContra = new Set();
  for (const n of G.nodesByType(ownerId, 'fact')) {
    for (const e of G.edgesOf(ownerId, n.id, { type: 'contradicts' })) {
      if (!seenContra.has(e.id)) { seenContra.add(e.id); conflictingFacts += 1; }
    }
  }
  for (const n of entityNodes) {
    if ((n.data?.fileCount ?? 0) >= 2 && !G.edgesOf(ownerId, n.id, { type: 'related_to' }).length) {
      missingRelationships += 1;
    }
  }
  for (const n of [...entityNodes, ...G.nodesByType(ownerId, 'fact')]) {
    for (const e of G.edgesOf(ownerId, n.id)) {
      if (!G.getNode(ownerId, e.from) || !G.getNode(ownerId, e.to)) invalidReferences += 1;
    }
  }

  // embeddings drift: chunks indexed for objects the bounded UKO store evicted
  const liveNames = new Set(ukos.map(u => u.sourceFile.name.toLowerCase()));
  let unusedEmbeddings = 0;
  if (typeof deps.listIndexedFileKeys === 'function') {
    for (const key of deps.listIndexedFileKeys(ownerId)) {
      const name = String(key).replace(/^file:/, '');
      if (!liveNames.has(name)) unusedEmbeddings += 1;
    }
  }

  const report = {
    at: Date.now(),
    objects: ukos.length,
    facts: { total: facts.length, active: active.length, archived: facts.length - active.length },
    duplicateEntityCandidates: ambiguous.length,
    brokenEvidence: { count: brokenEvidence.length, sample: brokenEvidence.slice(0, 5) },
    orphanedKnowledge: { factsWithoutEvidence: orphanFacts.length, evidenceWithoutFacts: orphanEvidence },
    missingRelationships,
    staleKnowledge: active.filter(f => f.stale).length,
    conflictingFacts,
    disputed: active.filter(f => f.disputed).length,
    lowConfidence: active.filter(f => (f.confidence ?? 0) < LOW_CONF).length,
    trusted: active.filter(f => f.trusted).length,
    unusedEmbeddings,
    invalidReferences,
    durationMs: Date.now() - started,
  };
  const healthy =
    report.brokenEvidence.count === 0 &&
    report.invalidReferences === 0 &&
    report.orphanedKnowledge.factsWithoutEvidence === 0;
  report.status = healthy ? (report.conflictingFacts || report.duplicateEntityCandidates ? 'attention' : 'healthy') : 'degraded';
  return report;
}

/**
 * The maintenance API's engine: consolidate, then re-measure. Returns both
 * so callers see what the pass changed. Ledger-logged.
 */
export function runMaintenance(deps, ownerId, { consolidate = true } = {}) {
  const before = healthReport(deps, ownerId);
  const consolidation = consolidate ? consolidateOwner(deps, ownerId) : null;
  const after = consolidate ? healthReport(deps, ownerId) : before;
  ledger(ownerId, 'maintenance', {
    status: after.status,
    merged: consolidation?.duplicatesMerged ?? 0,
    stale: after.staleKnowledge,
    conflicts: after.conflictingFacts,
  });
  return { before, consolidation, after, ledger: getLedger(ownerId, { limit: 10 }) };
}
