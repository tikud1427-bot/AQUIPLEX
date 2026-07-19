/**
 * AQUA Enrichment Pipeline — File Intelligence V1
 *
 * After parsing, every UKO flows through an ORDERED LIST OF STAGES. Each
 * stage is a plain object { name, version, applicable(uko), run(uko, deps) }
 * — independently replaceable, individually observable (recordStage wraps
 * every run), and FAIL-OPEN: a throwing enrichment stage records a warning
 * and the pipeline continues. Knowledge enrichment must never lose an
 * upload that parsing already succeeded on.
 *
 * Two stage classes, one contract:
 *   KNOWLEDGE stages (metadata → keywords → entities → topics → timeline →
 *     facts → summary → hints) are pure content transforms — cacheable by
 *     content hash, skipped entirely on a UKO cache hit.
 *   INTEGRATION stages (embeddings → memory → search-index) perform
 *     owner-scoped side effects — they run on EVERY ingest, cache hit or
 *     not, because whose memory a file enters is not content-determined.
 *
 * Replaceability is proven by test: a custom stage list swaps a heuristic
 * stage for a fake "LLM" stage behind the same signature and the pipeline
 * neither knows nor cares — the exact seam later phases upgrade through.
 */
import {
  extractKeywords, extractEntities, extractTimeline, extractFacts,
  deriveTopics, shortSummary,
} from './extractors.js';
import { recordStage } from './uko.js';
import { indexFileChunks, fileNamespace } from '../embeddings/fileMemory.js';
import { rememberFile, rememberWorkspace } from '../memory/engine.js';
import { indexUKO } from './fileSearchIndex.js';
import { buildFactsFromUKO } from './factBuilder.js';
import { saveEvidence, saveFact } from './evidenceStore.js';

// ── Knowledge stages (content-determined, cacheable) ─────────────────────────

export const metadataStage = {
  name: 'metadata', version: '1.0.0', class: 'knowledge',
  applicable: () => true,
  run(uko) {
    uko.summaries.title = uko.structuredContent.title || uko.sourceFile.name;
    uko.metadata = { ...uko.metadata, bytes: uko.sourceFile.bytes, ext: uko.sourceFile.ext };
  },
};

export const keywordStage = {
  name: 'keywords', version: '1.0.0', class: 'knowledge',
  applicable: (uko) => uko.rawContent.length > 0,
  run(uko) { uko.keywords = extractKeywords(uko.rawContent); },
};

export const entityStage = {
  name: 'entities', version: '1.0.0', class: 'knowledge',
  applicable: (uko) => uko.rawContent.length > 0,
  run(uko) { uko.entities = extractEntities(uko.rawContent); },
};

export const topicStage = {
  name: 'topics', version: '1.0.0', class: 'knowledge',
  applicable: () => true,
  run(uko) { uko.topics = deriveTopics(uko.structuredContent.sections, uko.keywords); },
};

export const timelineStage = {
  name: 'timeline', version: '1.0.0', class: 'knowledge',
  applicable: (uko) => uko.rawContent.length > 0,
  run(uko) { uko.timeline = extractTimeline(uko.rawContent, uko.structuredContent.sections); },
};

export const factStage = {
  name: 'facts', version: '1.0.0', class: 'knowledge',
  applicable: (uko) => uko.entities.length > 0,
  run(uko) { uko.facts = extractFacts(uko.rawContent, uko.entities); },
};

export const summaryStage = {
  name: 'summary', version: '1.0.0', class: 'knowledge',
  applicable: () => true,
  run(uko) { uko.summaries.short = shortSummary(uko.rawContent); },
};

export const reasoningHintStage = {
  name: 'reasoningHints', version: '1.0.0', class: 'knowledge',
  applicable: () => true,
  run(uko) {
    // Parser-declared hints came in via the parse result; add universal ones.
    const universal = 'Content above was extracted/analyzed by the platform at upload time — answer from it directly; never claim the file cannot be accessed.';
    if (!uko.reasoningHints.includes(universal)) uko.reasoningHints.push(universal);
    if (uko.timeline.length) uko.reasoningHints.push('A timeline was extracted — prefer it for chronological questions.');
  },
};

// ── Integration stages (owner-scoped effects, never cached) ──────────────────

export const embeddingStage = {
  name: 'embeddings', version: '1.0.0', class: 'integration',
  applicable: (uko) => Boolean(uko.owner) && uko.rawContent.length > 0,
  async run(uko, deps) {
    const index = deps?.indexFileChunks ?? indexFileChunks;
    const fileKey = uko.memoryLinks.fileKey ?? `file:${uko.sourceFile.name.toLowerCase()}`;
    const res = await index(uko.owner, fileKey, uko.sourceFile.name, uko.rawContent);
    uko.embeddings = { indexed: res?.indexed ?? 0, namespace: fileNamespace(uko.owner) };
  },
};

export const memoryLinkStage = {
  name: 'memoryLink', version: '1.0.0', class: 'integration',
  applicable: (uko) => Boolean(uko.owner),
  run(uko, deps) {
    if (uko.fileType === 'repository' && uko.memoryLinks.workspaceId) {
      const remember = deps?.rememberWorkspace ?? rememberWorkspace;
      remember(uko.owner, {
        id: uko.memoryLinks.workspaceId,
        meta: { name: uko.summaries.title },
        summary: uko.summaries.short,
        stats: { files: uko.metadata.filesIngested ?? 0 },
      });
      return;
    }
    const remember = deps?.rememberFile ?? rememberFile;
    const entry = remember(uko.owner, {
      name: uko.sourceFile.name, kind: uko.fileType,
      summary: (uko.summaries.title && uko.summaries.title !== uko.sourceFile.name ? uko.summaries.title + ' — ' : '') + uko.summaries.short,
      chars: uko.rawContent.length,
      conversationId: uko.conversation,
      content: uko.rawContent,
    });
    if (entry?.key) uko.memoryLinks.fileKey = entry.key;
  },
};

export const searchIndexStage = {
  name: 'searchIndex', version: '1.0.0', class: 'integration',
  applicable: (uko) => Boolean(uko.owner),
  run(uko, deps) {
    const index = deps?.indexUKO ?? indexUKO;
    const res = index(uko.owner, uko);
    uko.searchIndexed = Boolean(res?.indexed);
  },
};

/**
 * Phase 2 — the trust layer, wired as one enrichment stage. Turns the UKO's
 * knowledge into GROUNDED FACTS: every fact gets an Evidence object with
 * modality-correct provenance (page/slide/sheet/timestamp/lineRange/…) and
 * a confidence that reflects its extraction method. Evidence is stored with
 * dedup+sharing; facts reference it by id. Runs LAST — it consumes the
 * facts/timeline/entities the earlier knowledge stages produced. Owner-
 * scoped (facts belong to a memory owner) and fail-open like every stage.
 */
export const evidenceStage = {
  name: 'evidence', version: '1.0.0', class: 'integration',
  applicable: (uko) => Boolean(uko.owner) && (uko.facts.length > 0 || uko.timeline.length > 0),
  run(uko, deps) {
    const build = deps?.buildFactsFromUKO ?? buildFactsFromUKO;
    const saveEv = deps?.saveEvidence ?? saveEvidence;
    const saveFa = deps?.saveFact ?? saveFact;

    const { evidence, facts } = build(uko);
    // Store evidence first (returns shared instances), remap fact refs to the
    // possibly-deduped ids, then store facts.
    const idMap = new Map();
    for (const ev of evidence) {
      const stored = saveEv(uko.owner, ev);
      idMap.set(ev.id, stored.id);
    }
    let stored = 0;
    for (const fact of facts) {
      fact.evidence = fact.evidence.map(id => idMap.get(id) ?? id);
      saveFa(uko.owner, fact, { sourceFileId: uko.id });
      stored += 1;
    }
    uko.evidence = { factCount: stored, evidenceCount: idMap.size };
  },
};

// ── Pipeline ──────────────────────────────────────────────────────────────────

export const KNOWLEDGE_STAGES = [
  metadataStage, keywordStage, entityStage, topicStage,
  timelineStage, factStage, summaryStage, reasoningHintStage,
];
export const INTEGRATION_STAGES = [embeddingStage, memoryLinkStage, searchIndexStage, evidenceStage];
export const DEFAULT_STAGES = [...KNOWLEDGE_STAGES, ...INTEGRATION_STAGES];

/**
 * Run stages against a UKO. Fail-open per stage; every run is recorded in
 * uko.processing.stages with duration + outcome.
 *
 * @param {object} uko
 * @param {object} [opts]
 * @param {Array}  [opts.stages] - replaceable stage list (tests, upgrades)
 * @param {object} [opts.deps]   - integration dependency injection
 * @param {'all'|'knowledge'|'integration'} [opts.only]
 */
export async function runEnrichment(uko, { stages = DEFAULT_STAGES, deps = {}, only = 'all' } = {}) {
  for (const stage of stages) {
    if (only !== 'all' && stage.class !== only) continue;
    let applies = false;
    try { applies = stage.applicable(uko); }
    catch { applies = false; }
    if (!applies) continue;
    try {
      await recordStage(uko, `enrich:${stage.name}`, (u) => stage.run(u, deps));
    } catch (err) {
      // recordStage already logged the stage error onto the UKO; downgrade
      // to a warning — enrichment never sinks a parsed upload.
      uko.processing.errors = uko.processing.errors.filter(e => !e.startsWith(`enrich:${stage.name}:`));
      uko.processing.warnings.push(`enrich:${stage.name} failed: ${err.message}`);
    }
  }
  return uko;
}
