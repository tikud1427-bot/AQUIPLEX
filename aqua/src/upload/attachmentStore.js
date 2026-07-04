/**
 * AQUA Attachment Store — Day 5
 *
 * The "immediately available to the current conversation" half of the
 * universal upload contract. Every processed upload (document, image,
 * audio, video, single source file) is registered here against a
 * conversationId; chat.js's prepareTurn() pulls the registered content
 * into the system prompt on the very next turn — no re-processing, no
 * re-upload, no user action.
 *
 * Repositories are NOT stored here — they attach as a workspaceId (the
 * existing project-context path), which retrieval already handles better
 * than a flat content blob ever could.
 *
 * In-memory by design, matching conversationStore.js's persistence model
 * exactly — attachments live as long as the conversation store does.
 */
import { v4 as uuidv4 } from 'uuid';

const MAX_ATTACHMENTS_PER_CONVERSATION = 20;
const MAX_INJECTED_CHARS_TOTAL         = 120_000; // context-window protection
const MAX_INJECTED_CHARS_PER_DOC       = 60_000;

/** conversationId → [{ id, name, kind, format, title, content, metadata, sections, pages, language, truncated, uploadedAt }] */
const store = new Map();

// ── Write ─────────────────────────────────────────────────────────────────────

export function attachToConversation(conversationId, { name, kind, normalized }) {
  if (!conversationId) throw new Error('conversationId required to attach content');

  const list = store.get(conversationId) ?? [];
  if (list.length >= MAX_ATTACHMENTS_PER_CONVERSATION) {
    // Evict the oldest — a 21st upload should never hard-fail the request.
    list.shift();
    console.warn(`[UPLOAD] Attachment cap reached conversation=${conversationId} — evicted oldest`);
  }

  const attachment = {
    id:         uuidv4(),
    name,
    kind,                             // 'document' | 'image' | 'audio' | 'video' | 'source'
    format:     normalized.format,
    title:      normalized.title,
    content:    normalized.content,
    metadata:   normalized.metadata,
    sections:   normalized.sections,
    pages:      normalized.pages,
    language:   normalized.language,
    truncated:  normalized.truncated,
    uploadedAt: Date.now(),
  };

  list.push(attachment);
  store.set(conversationId, list);
  console.log(`[UPLOAD] Attached ${kind} "${name}" conversation=${conversationId} chars=${normalized.content.length}`);
  return attachment;
}

// ── Read ──────────────────────────────────────────────────────────────────────

export function getAttachments(conversationId) {
  return store.get(conversationId) ?? [];
}

export function removeAttachment(conversationId, attachmentId) {
  const list = store.get(conversationId);
  if (!list) return false;
  const idx = list.findIndex(a => a.id === attachmentId);
  if (idx === -1) return false;
  list.splice(idx, 1);
  return true;
}

export function clearAttachments(conversationId) {
  return store.delete(conversationId);
}

/** Metadata-only view — safe for API listing (no full content). */
export function serializeAttachment(a) {
  return {
    id: a.id, name: a.name, kind: a.kind, format: a.format, title: a.title,
    pages: a.pages, language: a.language, truncated: a.truncated,
    contentChars: a.content.length, uploadedAt: a.uploadedAt,
    metadata: a.metadata,
  };
}

// ── Prompt injection ──────────────────────────────────────────────────────────

const KIND_LABEL = {
  document: 'Document',
  image:    'Image (vision analysis + OCR below)',
  audio:    'Audio (transcription + analysis below)',
  video:    'Video (transcription + analysis below)',
  source:   'File',
};

/**
 * Format all conversation attachments as a system-prompt block. Newest
 * first (most recently uploaded = most likely subject of the question);
 * older attachments degrade to summaries when the total budget is hit —
 * never silently vanish, the model is TOLD what was elided.
 */
export function formatAttachmentsForPrompt(conversationId) {
  const list = getAttachments(conversationId);
  if (!list.length) return '';

  const blocks = [];
  let budget = MAX_INJECTED_CHARS_TOTAL;

  for (const a of [...list].reverse()) {
    const header = `── ${KIND_LABEL[a.kind] ?? 'Attachment'}: ${a.name}` +
      (a.pages ? ` (${a.pages} ${a.format === 'pptx' ? 'slides' : a.format === 'xlsx' ? 'sheets' : 'pages'})` : '') +
      (a.truncated ? ' [content truncated]' : '') + ' ──';

    let body = a.content;
    if (body.length > MAX_INJECTED_CHARS_PER_DOC) body = body.slice(0, MAX_INJECTED_CHARS_PER_DOC) + '\n... [truncated for context]';

    if (body.length + header.length > budget) {
      // Budget exhausted — include a stub so the model knows the file exists.
      blocks.push(`${header}\n[Content omitted to fit context — ${a.content.length} chars. Ask about "${a.name}" specifically to prioritize it.]`);
      continue;
    }

    budget -= body.length + header.length;
    blocks.push(`${header}\n${body}`);
  }

  return [
    'UPLOADED ATTACHMENTS (available in this conversation — answer questions about them directly):',
    ...blocks,
  ].join('\n\n');
}

export function getAttachmentStats() {
  let total = 0;
  for (const list of store.values()) total += list.length;
  return { conversations: store.size, attachments: total };
}
