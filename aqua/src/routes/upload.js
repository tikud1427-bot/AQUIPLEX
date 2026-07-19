/**
 * AQUA Unified Upload — File Intelligence V1
 *
 * THE single upload endpoint — now a THIN SHELL over the File Engine
 * (src/files/fileEngine.js). The route owns exactly three concerns:
 * HTTP validation, authorization (Phase 0 IDOR guards), and response
 * shaping. Everything between "decoded buffers" and "results" — detection,
 * parser selection, parsing, UKO construction, enrichment, caching, memory,
 * search indexing, attachment — is the engine's universal lifecycle. This
 * route contains ZERO file-type knowledge; adding a format is
 * registerParser(), never a route change.
 *
 *   POST /upload
 *     Body: {
 *       conversationId?: string,   // created if absent — returned either way
 *       files: [{ name: string, content: string }]   // content ALWAYS base64
 *     }
 *
 *   Response (byte-compatible with pre-V1, additive fields marked +):
 *     success, conversationId, isNewConversation,
 *     results: [{ name, kind, status, ..., +ukoId, +cacheHit }],
 *     workspace?: { id, projectType, filesIngested, summary, overview, +ukoId },
 *     attachments: [ ...metadata of everything attached to the conversation ]
 *
 *   GET    /upload/formats                          — format matrix (+parser matrix)
 *   GET    /upload/attachments/:conversationId      — list attachments
 *   DELETE /upload/attachments/:conversationId/:id  — detach
 */
import express from 'express';
import { SUPPORTED_FORMATS }                     from '../upload/uploadClassifier.js';
import { getAttachments, removeAttachment, serializeAttachment } from '../upload/attachmentStore.js';
import { getOrCreateConversation, conversationExists, canAccessConversation } from '../memory/conversationStore.js';
import { resolveOwner }                          from '../memory/engine.js';
import { ingestFiles }                           from '../files/fileEngine.js';
import { listParsers }                           from '../files/parserRegistry.js';

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

  // ── Decode (route-owned: base64 error semantics are part of the HTTP contract) ──
  const decoded = [];
  const results = [];
  for (const f of files) {
    if (!f?.name || !f?.content) {
      results.push({ name: f?.name ?? '(unnamed)', kind: 'unknown', status: 'failed', error: 'File entry missing name or content' });
      continue;
    }
    try {
      const buffer = Buffer.from(f.content, 'base64');
      if (!buffer.length) throw new Error('empty');
      decoded.push({ name: f.name, buffer });
    } catch {
      results.push({ name: f.name, kind: 'unknown', status: 'failed', error: 'Content is not valid base64' });
    }
  }

  // ── Universal lifecycle (engine-owned) ──
  const engineOut = await ingestFiles({
    files: decoded,
    ownerId: memoryOwner,
    conversationId,
    workspaceName: workspaceName
      ?? (decoded.find(d => /\.(zip|tar\.gz|tgz|tar|gz)$/i.test(d.name))?.name.replace(/\.(zip|tar\.gz|tgz|tar|gz)$/i, '') || 'Uploaded project'),
    traceId: req.headers['x-request-id'] ?? null,
  });
  results.push(...engineOut.results);
  const workspacePayload = engineOut.workspace;

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

// ── GET /upload/formats ───────────────────────────────────────────────────────

router.get('/formats', (_req, res) => {
  res.json({ success: true, formats: SUPPORTED_FORMATS, parsers: listParsers() });
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