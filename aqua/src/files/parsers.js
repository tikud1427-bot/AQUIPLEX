/**
 * AQUA Built-in Parsers — File Intelligence V1
 *
 * Every existing pipeline (document / media / source / repository) migrated
 * behind the parser interface. ZERO extraction logic moved or rewritten —
 * each parser is a thin adapter around the battle-tested pipeline module it
 * wraps, so current behavior (formats, limits, OCR fallback, caches, error
 * messages) is preserved verbatim. What changes is WHERE the routing
 * decision lives: the registry, not a switch statement in a route.
 *
 * Parser contract (consumed by fileEngine):
 *   parse(ctx) → {
 *     title, format, metadata, content, sections, pages, language, truncated,
 *     analyzer?: string,                 // model/provider used, for provenance
 *     reasoningHints?: string[],         // kind-specific downstream guidance
 *     workspace?: {...}                  // repository parser only
 *     workspaceResults?: [...]           // repository parser only (per-archive results)
 *   }
 *   ctx = { name, buffer, classification, deps, ownerId, workspaceName }
 *
 * deps: every external effect a parser performs is injected with a default
 * (ctx.deps.processMedia ?? processMedia). Tests override deps to run the
 * FULL pipeline offline; production passes nothing and gets the real
 * modules. This is the same injection seam the intelligence agents use for
 * `generate` — one pattern everywhere.
 */
import { processDocument }   from '../upload/documentPipeline.js';
import { processMedia }      from '../upload/mediaPipeline.js';
import { extractArchive }    from '../upload/archiveExtractor.js';
import { createWorkspace }   from '../project/workspaceManager.js';
import { runWorkspaceIngestion } from '../project/ingestionPipeline.js';
import { detectLanguage as detectSourceLanguage } from '../project/fileIngester.js';
import { registerParser }    from './parserRegistry.js';

const MAX_SOURCE_CHARS = 100_000; // mirrors fileIngester MAX_FILE_SIZE — unchanged

// ── Document ──────────────────────────────────────────────────────────────────

export const documentParser = {
  id: 'document', version: '1.0.0',
  kinds: ['document'],
  extensions: ['.pdf', '.docx', '.pptx', '.xlsx', '.csv', '.odt', '.epub'],
  mimeTypes: ['application/pdf'],
  capabilities: ['TextExtraction', 'TableExtraction', 'SectionExtraction', 'MetadataExtraction', 'OCR'],
  priority: 50,
  async parse(ctx) {
    if (ctx.classification?.corrupt) {
      throw new Error('File extension and content disagree — the file appears corrupt.');
    }
    const run = ctx.deps?.processDocument ?? processDocument;
    const n = await run(ctx.name, ctx.buffer);
    return { ...n, analyzer: n.metadata?.ocr ? 'gemini-ocr' : null,
      reasoningHints: ['Cite page/section numbers when the document provides them.'] };
  },
};

// ── Media (image / audio / video — separate parsers, per-kind capabilities) ──

function mediaParser(kind, { extensions, mimeTypes, capabilities, hints }) {
  return {
    id: kind, version: '1.0.0',
    kinds: [kind], extensions, mimeTypes, capabilities, priority: 50,
    async parse(ctx) {
      const run = ctx.deps?.processMedia ?? processMedia;
      const n = await run(ctx.name, ctx.buffer, ctx.classification?.mime, kind);
      return { ...n, analyzer: n.metadata?.model ?? (n.metadata?.analyzed === false ? null : 'gemini'),
        reasoningHints: hints };
    },
  };
}

export const imageParser = mediaParser('image', {
  extensions: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.heic', '.heif'],
  mimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'image/heic', 'image/heif'],
  capabilities: ['Vision', 'OCR', 'ObjectDetection', 'MetadataExtraction', 'SectionExtraction'],
  hints: ['The OCR text is verbatim from the image — quote it exactly.',
          'Never claim inability to view the image: the vision analysis above IS the image content.'],
});

export const audioParser = mediaParser('audio', {
  extensions: ['.mp3', '.wav', '.m4a'],
  mimeTypes: ['audio/mpeg', 'audio/wav', 'audio/mp4'],
  capabilities: ['SpeechRecognition', 'MetadataExtraction', 'SectionExtraction'],
  hints: ['The TRANSCRIPT section is verbatim speech — quote it exactly.',
          'Never claim inability to hear the audio: the transcription above IS the audio content.'],
});

export const videoParser = mediaParser('video', {
  extensions: ['.mp4', '.mov', '.avi'],
  mimeTypes: ['video/mp4', 'video/quicktime', 'video/x-msvideo'],
  capabilities: ['Vision', 'SpeechRecognition', 'TimelineExtraction', 'ObjectDetection', 'MetadataExtraction', 'SectionExtraction'],
  hints: ['SCENES are chronological — use them for "what happened when" questions.',
          'Never claim inability to watch the video: the analysis above IS the video content.'],
});

// ── Source (single code/text file) ───────────────────────────────────────────

export const sourceParser = {
  id: 'source', version: '1.0.0',
  kinds: ['source'], extensions: [], mimeTypes: ['text/plain'],
  capabilities: ['TextExtraction', 'MetadataExtraction'],
  priority: 50,
  async parse(ctx) {
    const detect = ctx.deps?.detectSourceLanguage ?? detectSourceLanguage;
    let content = ctx.buffer.toString('utf8');
    let truncated = false;
    if (content.length > MAX_SOURCE_CHARS) {
      content = content.slice(0, MAX_SOURCE_CHARS) + '\n... [truncated]';
      truncated = true;
    }
    return {
      title: ctx.name, format: detect(ctx.name), metadata: {},
      content, pages: null, sections: [], language: null, truncated,
      reasoningHints: ['Treat the content as the complete file unless marked truncated.'],
    };
  },
};

// ── Repository (archives + folder drops → workspace) ─────────────────────────
//
// The batch-claim logic that lived in routes/upload.js verbatim: any archive
// claims itself; a >3-file batch that is ≥60% source files is a folder drop
// and claims those sources. The ENGINE knows none of this — it just asks the
// registry "does anything claim this batch?", which is exactly principle 3
// (orchestration never knows file-specific details).

export const repositoryParser = {
  id: 'repository', version: '1.0.0',
  kinds: ['repository'], extensions: ['.zip', '.tar', '.gz', '.tgz'], mimeTypes: [],
  capabilities: ['ArchiveExtraction', 'WorkspaceIngestion', 'TextExtraction', 'MetadataExtraction'],
  priority: 60,
  consumesBatch: true,

  claimBatch(classified) {
    const archives    = classified.filter(c => c.cls.kind === 'repository').map(c => c.name);
    const sourceFiles = classified.filter(c => c.cls.kind === 'source').map(c => c.name);
    const isFolderDrop = classified.length > 3 && sourceFiles.length / classified.length >= 0.6;
    if (!archives.length && !isFolderDrop) return null;
    return {
      claimed: [...archives, ...(isFolderDrop ? sourceFiles : [])],
      reason:  archives.length ? 'archive-in-batch' : 'folder-drop',
    };
  },

  /**
   * Batch parse: ctx.files = [{ name, buffer, cls }] (the claimed set).
   * Returns workspace payload + per-archive results + a UKO core
   * representing the repository (summary/overview as content — the same
   * text the project-context lane retrieves richly).
   */
  async parseBatch(ctx) {
    const deps = {
      extractArchive:       ctx.deps?.extractArchive       ?? extractArchive,
      createWorkspace:      ctx.deps?.createWorkspace      ?? createWorkspace,
      runWorkspaceIngestion: ctx.deps?.runWorkspaceIngestion ?? runWorkspaceIngestion,
    };
    const results = [];
    const rawFiles = [];

    for (const a of ctx.files.filter(f => f.cls.kind === 'repository')) {
      if (a.cls.corrupt) {
        results.push({ name: a.name, kind: 'repository', status: 'failed', error: 'Archive appears corrupt — its bytes do not match its extension.' });
        continue;
      }
      try {
        const extracted = await deps.extractArchive(a.buffer, a.cls.archiveFormat);
        if (!extracted.length) {
          results.push({ name: a.name, kind: 'repository', status: 'failed', error: 'Archive extracted to zero usable files (only ignored/binary content).' });
          continue;
        }
        rawFiles.push(...extracted);
        results.push({ name: a.name, kind: 'repository', status: 'ready', entriesExtracted: extracted.length });
      } catch (err) {
        results.push({ name: a.name, kind: 'repository', status: 'failed', error: err.message });
      }
    }

    for (const s of ctx.files.filter(f => f.cls.kind === 'source')) {
      rawFiles.push({ path: s.name, content: s.buffer.toString('utf8') });
      results.push({ name: s.name, kind: 'source', status: 'ready', routedTo: 'workspace' });
    }

    if (!rawFiles.length) throw new Error('No archive in the upload could be extracted.');

    const workspace = deps.createWorkspace({ name: ctx.workspaceName, createdBy: 'unified-upload', ownerId: ctx.ownerId });
    const ingestion = await deps.runWorkspaceIngestion(workspace.id, rawFiles);

    const content = [
      `Repository workspace "${ctx.workspaceName}" — ${ingestion.filesIngested} files ingested (${ingestion.projectType}).`,
      '', 'SUMMARY:', ingestion.summary ?? '(none)',
      '', 'OVERVIEW:', typeof ingestion.overview === 'string' ? ingestion.overview : JSON.stringify(ingestion.overview ?? {}, null, 2).slice(0, 8_000),
    ].join('\n');

    return {
      title: ctx.workspaceName, format: 'workspace',
      metadata: { projectType: ingestion.projectType, filesIngested: ingestion.filesIngested, indexStats: ingestion.indexStats },
      content, pages: null, sections: [], language: null, truncated: false,
      reasoningHints: ['Deep file-level questions route through the workspace/project context, not this summary.'],
      workspace: {
        id: workspace.id, name: ctx.workspaceName,
        projectType: ingestion.projectType, filesIngested: ingestion.filesIngested,
        indexStats: ingestion.indexStats, summary: ingestion.summary, overview: ingestion.overview,
      },
      workspaceResults: results,
    };
  },

  // Single-file path is never used (consumesBatch); keep the contract total.
  async parse(ctx) {
    const out = await this.parseBatch({ ...ctx, files: [{ name: ctx.name, buffer: ctx.buffer, cls: ctx.classification }] });
    return out;
  },
};

// ── Registration ──────────────────────────────────────────────────────────────

export const BUILTIN_PARSERS = [documentParser, imageParser, audioParser, videoParser, sourceParser, repositoryParser];

let registered = false;
/** Idempotent — the engine calls this at import time; tests may call after _resetRegistryForTests(). */
export function registerBuiltinParsers() {
  if (registered) return;
  for (const p of BUILTIN_PARSERS) registerParser(p);
  registered = true;
}
export function _unmarkBuiltinsForTests() { registered = false; }
