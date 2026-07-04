/**
 * AQUA Workspace Ingestion Pipeline — Day 5 unification
 *
 * The full ingest → index → summarize → graph → analyze → persist sequence,
 * factored VERBATIM out of routes/project.js (POST /workspace/:id/files)
 * so the new unified upload endpoint (routes/upload.js) runs the IDENTICAL
 * pipeline. One implementation, two entrypoints — the "backward
 * compatibility / no duplicate implementations" requirement is structural,
 * not a promise.
 *
 * Behavior is byte-identical to the previous inline version: same step
 * order, same logging, same error semantics (throws → caller marks the
 * workspace failed).
 */
import { getWorkspace, updateWorkspace }                    from './workspaceManager.js';
import { ingestFiles, buildStructure, detectProjectType }   from './fileIngester.js';
import { buildIndex, getIndex, getIndexStats }              from './projectIndex.js';
import { buildDependencyGraph, serializeGraph, detectCycles } from './dependencyGraph.js';
import { enrichWithSummaries, summarizeProject }            from './projectSummarizer.js';
import { analyzeWorkspace }                                 from './workspaceAnalyzer.js';

/**
 * Run the complete ingestion pipeline for a workspace.
 *
 * @param {string} workspaceId - existing workspace (created by caller)
 * @param {Array<{path, content, encoding?}>} rawFiles
 * @param {(id: string, label: string) => void} [onStage] - real progress reporting
 * @returns {Promise<{ projectType, filesIngested, indexStats, summary, overview }>}
 * @throws {Error} with .code='NO_VALID_FILES' when filtering leaves nothing;
 *                 any other pipeline failure propagates (caller marks 'failed')
 */
export async function runWorkspaceIngestion(workspaceId, rawFiles, onStage = () => {}) {
  const workspace = getWorkspace(workspaceId);
  if (!workspace) {
    const err = new Error('Workspace not found');
    err.code = 'NO_WORKSPACE';
    throw err;
  }

  updateWorkspace(workspaceId, { indexStatus: 'indexing' });

  try {
    // 1. Ingest (filter + size-cap; PDF/DOCX/PPTX/XLSX get real extraction)
    onStage('extract', 'Extracting files…');
    const ingested = await ingestFiles(rawFiles);
    if (!ingested.length) {
      updateWorkspace(workspaceId, { indexStatus: 'failed' });
      const err = new Error('No valid source files found after filtering');
      err.code = 'NO_VALID_FILES';
      throw err;
    }

    // 2. Detect project type + build directory tree
    const projectType = detectProjectType(ingested);
    const structure   = buildStructure(ingested);

    // 3. Build symbol / import index — parseFile() runs HERE, once per file.
    onStage('index', 'Indexing repository…');
    buildIndex(workspaceId, ingested);
    console.log(`[Index] Files indexed workspace=${workspaceId}`);

    // 4. Pull parsed entries back out of the index (full parse metadata + content).
    const parsedEntries = [...getIndex(workspaceId).byPath.values()];

    // 5. Summarize from real parse metadata; patch summaries into live index.
    onStage('analyze', 'Analyzing project…');
    const enriched  = enrichWithSummaries(parsedEntries);
    const liveIndex = getIndex(workspaceId);
    for (const f of enriched) {
      const entry = liveIndex.byPath.get(f.path);
      if (entry) entry.summary = f.summary;
    }

    // 6. Dependency graph from parsed imports
    buildDependencyGraph(workspaceId, enriched);
    console.log(`[GRAPH] Dependencies updated workspace=${workspaceId}`);

    // 6b. Project-level summary
    const summary = summarizeProject({ projectType }, enriched);
    console.log(`[SUMMARY] File summarized workspace=${workspaceId}`);

    // 7. Language stats
    const languages = {};
    for (const f of enriched) languages[f.lang] = (languages[f.lang] ?? 0) + 1;

    // 7b. Workspace intelligence — cached on the record; failure degrades, never fails upload.
    onStage('workspace', 'Generating workspace…');
    let overview = null;
    try {
      const graph  = serializeGraph(workspaceId);
      const cycles = detectCycles(workspaceId);
      ({ overview } = analyzeWorkspace({
        workspaceName: workspace.meta?.name,
        projectType, files: enriched, graph, cycles,
      }));
      console.log(`[ANALYZER] Overview generated workspace=${workspaceId} partial=${overview.partial} warnings=${overview.warnings.length}`);
    } catch (err) {
      console.warn(`[ANALYZER] Overview generation failed workspace=${workspaceId}:`, err.message);
    }

    // 8. Persist (metadata only — no raw content)
    const fileMetadata = enriched.map(f => ({
      path: f.path, lang: f.lang, size: f.size, summary: f.summary, parsedAt: Date.now(),
    }));
    updateWorkspace(workspaceId, {
      projectType, structure, files: fileMetadata, summary, overview,
      indexStatus: 'indexed', indexedAt: Date.now(),
      stats: { files: enriched.length, languages },
    });

    return {
      projectType,
      filesIngested: enriched.length,
      indexStats: getIndexStats(workspaceId),
      summary,
      overview,
    };
  } catch (err) {
    if (err.code !== 'NO_VALID_FILES') {
      console.error(`[PROJECT] Ingestion failed workspace=${workspaceId}:`, err.stack ?? err.message);
      updateWorkspace(workspaceId, { indexStatus: 'failed', indexError: err.message });
    }
    throw err;
  }
}
