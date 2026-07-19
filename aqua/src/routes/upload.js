/**
 * AQUA Unified Upload — Day 5
 *
 * THE single upload endpoint. Users (and the frontend) never choose between
 * "chat upload" and "project upload" — everything comes here, gets
 * classified, and is routed to the right pipeline automatically.
 *
 *   POST /upload
 *     Body: {
 *       conversationId?: string,   // created if absent — returned either way
 *       files: [{ name: string, content: string }]   // content ALWAYS base64
 *     }
 *
 *   Routing (per file / per batch):
 *     ZIP / TAR / TAR.GZ          → extract → workspace ingestion → workspace card
 *     multi-file source batch     → workspace ingestion (folder drop)
 *     PDF/DOCX/PPTX/XLSX/CSV/ODT/EPUB → document pipeline → conversation attachment
 *     PNG/JPEG/WEBP/GIF/SVG/HEIC  → vision + OCR → conversation attachment
 *     MP3/WAV/M4A                 → transcription + analysis → attachment
 *     MP4/MOV/AVI                 → transcription + analysis → attachment
 *     single source file          → read → conversation attachment
 *     anything else               → explicit per-file error (never silent)
 *
 *   Response: {
 *     success, conversationId, isNewConversation,
 *     results: [{ name, kind, status: 'ready'|'failed', ... }],
 *     workspace?: { id, projectType, filesIngested, summary, overview },
 *     attachments: [ ...metadata of everything now attached to the conversation ]
 *   }
 *
 *   GET    /upload/formats                          — supported format matrix
 *   GET    /upload/attachments/:conversationId      — list attachments
 *   DELETE /upload/attachments/:conversationId/:id  — detach
 */
import express from 'express';
import path from 'path';
import { classifyUpload, SUPPORTED_FORMATS }    from '../upload/uploadClassifier.js';
import { extractArchive }                        from '../upload/archiveExtractor.js';
import { processDocument }                       from '../upload/documentPipeline.js';
import { processMedia }                          from '../upload/mediaPipeline.js';
import {
  attachToConversation, getAttachments, removeAttachment, serializeAttachment,
} from '../upload/attachmentStore.js';
import { getOrCreateConversation, conversationExists, canAccessConversation } from '../memory/conversationStore.js';
import { resolveOwner, rememberFile, rememberWorkspace } from '../memory/engine.js';
import { createWorkspace }                       from '../project/workspaceManager.js';
import { runWorkspaceIngestion }                 from '../project/ingestionPipeline.js';
import { detectLanguage as detectSourceLanguage } from '../project/fileIngester.js';

const router = express.Router();

// ── Phase 0 (audit F4) — object-level authorization ──────────────────────────
// Attachments bind to conversations, so every attachment operation inherits
// the conversation's ownership rules. This route previously performed ZERO
// checks: any caller who knew a conversationId could list another user's
// attachment metadata (filenames, titles, sizes), DELETE their attachments,
// and — worst — POST files INTO their conversation, which the chat pipeline
// then injects into the victim's system prompt (stored prompt injection).
// Same contract as conversations.js assertOwnership: platform sessions are
// scoped to their own conversations; sessionless/dev traffic (scopeUser
// null) is unchanged; mismatch returns 404, not 403, so a guess is
// indistinguishable from a miss — no existence oracle.
function assertConversationAccess(req, res, conversationId) {
  if (!conversationExists(conversationId)
      || !canAccessConversation(req.aquaUserId ?? null, conversationId)) {
    res.status(404).json({ success: false, error: 'Conversation not found' });
    return false;
  }
  return true;
}

const MAX_FILES_PER_UPLOAD = 30;
const MAX_SOURCE_CHARS     = 100_000; // mirrors fileIngester MAX_FILE_SIZE

// ── POST /upload ──────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const { files, conversationId: requestedConversationId, workspaceName } = req.body ?? {};

  if (!Array.isArray(files) || !files.length) {
    return res.status(400).json({
      success: false,
      error:   'Body must include "files": [{ name, content }] with base64 content.',
    });
  }
  if (files.length > MAX_FILES_PER_UPLOAD) {
    return res.status(400).json({
      success: false,
      error:   `Too many files in one upload (${files.length} > ${MAX_FILES_PER_UPLOAD}). Zip the folder instead — archives ingest as a full workspace.`,
    });
  }

  // Phase 0 (audit F4) — write-side IDOR guard. An EXISTING conversation may
  // only receive attachments from its owner; attaching into someone else's
  // conversation is a stored prompt injection (the content lands in their
  // system prompt next turn). A non-existent requested id keeps today's
  // create-with-that-id contract — the caller becomes the creator.
  if (requestedConversationId
      && conversationExists(requestedConversationId)
      && !canAccessConversation(req.aquaUserId ?? null, requestedConversationId)) {
    return res.status(404).json({ success: false, error: 'Conversation not found' });
  }

  // Attachments bind to a conversation — create one now if the user uploaded
  // before sending their first message (the common drag-drop-then-type flow).
  const { id: conversationId, isNew: isNewConversation } = getOrCreateConversation(
    requestedConversationId ?? null,
    { userAgent: req.headers['user-agent']?.slice(0, 80), ip: req.ip, createdBy: 'upload',
      userId: req.aquaUserId ?? null },
  );
  // Uploaded files become durable OWNER memory (Req 10) — not just
  // conversation attachments. Same owner model as chat.
  const memoryOwner = resolveOwner({ userId: req.aquaUserId ?? null, conversationId });

  // ── Decode + classify every file up front ──
  const classified = [];
  const results    = [];

  for (const f of files) {
    if (!f?.name || !f?.content) {
      results.push({ name: f?.name ?? '(unnamed)', kind: 'unknown', status: 'failed', error: 'File entry missing name or content' });
      continue;
    }
    let buffer;
    try {
      buffer = Buffer.from(f.content, 'base64');
      if (!buffer.length) throw new Error('empty');
    } catch {
      results.push({ name: f.name, kind: 'unknown', status: 'failed', error: 'Content is not valid base64' });
      continue;
    }
    const cls = classifyUpload(f.name, buffer);
    classified.push({ name: f.name, buffer, cls });
  }

  // ── Batch decision: repository experience ──
  // An archive anywhere in the batch, OR a multi-file batch that is
  // majority source files (a folder drop), becomes a workspace.
  const archives    = classified.filter(c => c.cls.kind === 'repository');
  const sourceFiles = classified.filter(c => c.cls.kind === 'source');
  const isFolderDrop = classified.length > 3 && sourceFiles.length / classified.length >= 0.6;

  let workspacePayload = null;

  if (archives.length > 0 || isFolderDrop) {
    try {
      workspacePayload = await handleRepositoryUpload({ memoryOwner,
        archives,
        sourceFiles: isFolderDrop ? sourceFiles : [],
        workspaceName: workspaceName
          ?? (archives[0]?.name.replace(/\.(zip|tar\.gz|tgz|tar|gz)$/i, '') || 'Uploaded project'),
        results,
      });
    } catch (err) {
      // Whole-repository failure is reported per archive — never silent.
      for (const a of archives) {
        if (!results.some(r => r.name === a.name)) {
          results.push({ name: a.name, kind: 'repository', status: 'failed', error: err.message });
        }
      }
    }
  }

  // Files consumed by the workspace path don't get double-processed.
  const consumed = new Set([
    ...archives.map(a => a.name),
    ...(isFolderDrop ? sourceFiles.map(s => s.name) : []),
  ]);
  const individual = classified.filter(c => !consumed.has(c.name));

  // ── Per-file routing for everything else ──
  for (const item of individual) {
    const { name, buffer, cls } = item;
    try {
      switch (cls.kind) {
        case 'document': {
          if (cls.corrupt) throw new Error('File extension and content disagree — the file appears corrupt.');
          const normalized = await processDocument(name, buffer);
          const attachment = attachToConversation(conversationId, { name, kind: 'document', normalized });
          rememberFile(memoryOwner, { name, kind: 'document', summary: (normalized.title && normalized.title !== name ? normalized.title + ' — ' : '') + normalized.content.slice(0, 240), chars: normalized.content.length, conversationId, content: normalized.content });
          results.push({ name, kind: 'document', status: 'ready', attachmentId: attachment.id, format: normalized.format, pages: normalized.pages, contentChars: normalized.content.length, truncated: normalized.truncated });
          break;
        }
        case 'image':
        case 'audio':
        case 'video': {
          const normalized = await processMedia(name, buffer, cls.mime, cls.kind);
          const attachment = attachToConversation(conversationId, { name, kind: cls.kind, normalized });
          rememberFile(memoryOwner, { name, kind: cls.kind, summary: (normalized.title && normalized.title !== name ? normalized.title + ' — ' : '') + normalized.content.slice(0, 240), chars: normalized.content.length, conversationId, content: normalized.content });
          results.push({ name, kind: cls.kind, status: 'ready', attachmentId: attachment.id, format: normalized.format, contentChars: normalized.content.length, analyzed: normalized.metadata.analyzed !== false });
          break;
        }
        case 'source': {
          let content = buffer.toString('utf8');
          let truncated = false;
          if (content.length > MAX_SOURCE_CHARS) { content = content.slice(0, MAX_SOURCE_CHARS) + '\n... [truncated]'; truncated = true; }
          const normalized = {
            title: name, format: detectSourceLanguage(name), metadata: {},
            content, pages: null, sections: [], language: null, truncated,
          };
          const attachment = attachToConversation(conversationId, { name, kind: 'source', normalized });
          rememberFile(memoryOwner, { name, kind: 'source', summary: (normalized.title && normalized.title !== name ? normalized.title + ' — ' : '') + normalized.content.slice(0, 240), chars: normalized.content.length, conversationId, content: normalized.content });
          results.push({ name, kind: 'source', status: 'ready', attachmentId: attachment.id, format: normalized.format, contentChars: content.length, truncated });
          break;
        }
        case 'repository': {
          // Only reachable if handleRepositoryUpload threw before reaching this archive
          break;
        }
        default: {
          const ext = path.extname(name) || '(no extension)';
          results.push({
            name, kind: 'unknown', status: 'failed',
            error: `Unsupported format ${ext}. Supported: repositories (zip/tar/tar.gz), documents (pdf/docx/pptx/xlsx/csv/odt/epub), images, audio, video, and source/text files.`,
          });
        }
      }
    } catch (err) {
      console.error(`[UPLOAD] Processing failed file=${name}:`, err.message);
      results.push({ name, kind: cls.kind, status: 'failed', error: err.message });
    }
  }

  const anyReady = results.some(r => r.status === 'ready') || !!workspacePayload;

  res.status(anyReady ? 200 : 422).json({
    success: anyReady,
    conversationId,
    isNewConversation,
    results,
    ...(workspacePayload ? { workspace: workspacePayload } : {}),
    attachments: getAttachments(conversationId).map(serializeAttachment),
    ...(anyReady ? {} : { error: 'No file in the upload could be processed — see per-file results.' }),
  });
});

// ── Repository experience: archive/folder → workspace, zero manual steps ──────

async function handleRepositoryUpload({ memoryOwner = null, archives, sourceFiles, workspaceName, results }) {
  // Merge every archive + loose source file into ONE raw file set (mixed
  // uploads: "here's my repo zip and also these two extra files").
  const rawFiles = [];

  for (const a of archives) {
    if (a.cls.corrupt) {
      results.push({ name: a.name, kind: 'repository', status: 'failed', error: 'Archive appears corrupt — its bytes do not match its extension.' });
      continue;
    }
    try {
      const extracted = await extractArchive(a.buffer, a.cls.archiveFormat);
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

  for (const s of sourceFiles) {
    rawFiles.push({ path: s.name, content: s.buffer.toString('utf8') });
    results.push({ name: s.name, kind: 'source', status: 'ready', routedTo: 'workspace' });
  }

  if (!rawFiles.length) {
    throw new Error('No archive in the upload could be extracted.');
  }

  // Create workspace + run the EXACT same pipeline as POST /project/workspace/:id/files
  const workspace = createWorkspace({ name: workspaceName, createdBy: 'unified-upload', ownerId: memoryOwner });
  const ingestion = await runWorkspaceIngestion(workspace.id, rawFiles);
  // Workspace becomes durable owner memory: project node + summary (Req 9/10).
  rememberWorkspace(memoryOwner, { ...workspace, summary: ingestion.summary, stats: { files: ingestion.filesIngested } });

  return {
    id:            workspace.id,
    name:          workspaceName,
    projectType:   ingestion.projectType,
    filesIngested: ingestion.filesIngested,
    indexStats:    ingestion.indexStats,
    summary:       ingestion.summary,
    overview:      ingestion.overview,
  };
}

// ── GET /upload/formats ───────────────────────────────────────────────────────

router.get('/formats', (_req, res) => {
  res.json({ success: true, formats: SUPPORTED_FORMATS });
});

// ── Attachment management ─────────────────────────────────────────────────────

router.get('/attachments/:conversationId', (req, res) => {
  // Phase 0 (audit F4): object-level authorization — see assertConversationAccess.
  if (!assertConversationAccess(req, res, req.params.conversationId)) return;
  res.json({
    success: true,
    conversationId: req.params.conversationId,
    attachments: getAttachments(req.params.conversationId).map(serializeAttachment),
  });
});

router.delete('/attachments/:conversationId/:attachmentId', (req, res) => {
  // Phase 0 (audit F4): object-level authorization — see assertConversationAccess.
  if (!assertConversationAccess(req, res, req.params.conversationId)) return;
  const removed = removeAttachment(req.params.conversationId, req.params.attachmentId);
  if (!removed) return res.status(404).json({ success: false, error: 'Attachment not found' });
  res.json({ success: true, removed: req.params.attachmentId });
});

export default router;