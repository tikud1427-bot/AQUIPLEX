/**
 * AQUA Project Intelligence — Persistent Intelligence Core (Phase 4)
 *
 * "Projects become persistent knowledge spaces. Users should feel like AQUA
 * truly understands the project." A project here is an owner's knowledge
 * space — the same scope every store already keys on — automatically
 * organized: every ingested artifact by type, the resolved entities that
 * matter, the cross-file timeline, open contradictions, workspace links,
 * lifecycle distribution, and a health digest. One call, one coherent view
 * — composed entirely from existing stores (queryEngine.projectSummary is
 * finally consumed here), nothing re-derived, nothing duplicated.
 *
 * A future explicit-project layer (many named projects per owner) slots in
 * by narrowing ownerId → projectId at this seam; every downstream shape
 * stays identical.
 */
import { lifecycleStats } from './knowledgeLifecycle.js';
import { versionStats } from './versionStore.js';
import { feedbackStats } from './reasoningFeedback.js';
import { getLedger } from './picStore.js';

/**
 * @param {object} deps - { evidenceStore, ukoStore, graph, queryEngine }
 * @param {string} ownerId
 */
export function projectIntelligence(deps, ownerId) {
  const { evidenceStore: ES, ukoStore: US, queryEngine: QE } = deps;
  const ukos = US.listUKOs(ownerId, { limit: 100000 });

  // Artifacts organized by kind — documents, videos, repositories, … all one
  // knowledge space ("AQUA should think: I understand knowledge").
  const artifacts = {};
  for (const u of ukos) {
    (artifacts[u.fileType] ??= []).push({
      name: u.sourceFile.name, ukoId: u.id,
      uploadedAt: u.provenance.uploadedAt,
      summary: u.summaries?.short?.slice(0, 140) ?? '',
    });
  }

  const summary = QE.projectSummary(ES, ownerId);   // key entities, timeline size, contradictions
  const evidence = ES.getEvidenceStats(ownerId);

  return {
    ownerId,
    artifacts,
    artifactCounts: Object.fromEntries(Object.entries(artifacts).map(([k, v]) => [k, v.length])),
    knowledge: {
      facts: evidence.facts,
      evidence: evidence.evidence,
      sharedEvidence: evidence.sharedEvidence,
      graph: summary.stats,
      keyEntities: summary.keyEntities,
      timelineSize: summary.timelineSize,
      firstEvents: summary.firstEvents,
      openContradictions: summary.openContradictions,
    },
    lifecycle: lifecycleStats(ownerId),
    versions: versionStats(ownerId),
    reasoning: feedbackStats(ownerId),
    recentOperations: getLedger(ownerId, { limit: 10 }),
    grounding: summary.grounding,
  };
}
