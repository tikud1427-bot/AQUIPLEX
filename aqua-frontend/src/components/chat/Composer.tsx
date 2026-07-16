import { useCallback, useEffect, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { ArrowUp, FolderPlus, Paperclip, Square } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { AttachmentChip } from '@/components/upload/AttachmentChip';
import { ProjectUploadDialog } from '@/components/upload/ProjectUploadDialog';
import { useChatStore } from '@/stores/chatStore';
import { useAttachmentStore } from '@/stores/attachmentStore';
import { useUiStore } from '@/stores/uiStore';
import { useIsMobile } from '@/hooks/useMediaQuery';
import { isMac, modKey } from '@/hooks/useKeyboardShortcuts';
import { cn } from '@/lib/utils';

const MAX_CHARS = 8000;

/**
 * Day 5 — Universal Upload composer.
 *
 * ONE upload experience: drag ANY supported file into the chat (repository
 * archives, PDFs, slides, spreadsheets, images, audio, video, source
 * files). The unified /upload endpoint classifies and routes each file
 * automatically — archives become indexed workspaces attached to this
 * conversation; everything else becomes conversation attachments whose
 * extracted content grounds the very next turn. The legacy Project Upload
 * dialog remains reachable (folder button) for named multi-file projects.
 */
export function Composer() {
  const [text, setText] = useState('');
  // Lifted to uiStore (not local) so the ⌘⇧U shortcut in AppShell can open
  // this same dialog instead of duplicating dialog-open state per-trigger.
  const projectDialogOpen = useUiStore((s) => s.projectUploadOpen);
  const setProjectDialogOpen = useUiStore((s) => s.setProjectUploadOpen);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();

  const sendMessage = useChatStore((s) => s.sendMessage);
  const stopGenerating = useChatStore((s) => s.stopGenerating);
  const generating = useChatStore((s) => s.generating);
  const workspaceId = useChatStore((s) => s.workspaceId);
  const conversationId = useChatStore((s) => s.conversationId);

  const attachments = useAttachmentStore((s) => s.items);
  const uploading = useAttachmentStore((s) => s.uploading);
  const addFiles = useAttachmentStore((s) => s.addFiles);
  const removeAttachment = useAttachmentStore((s) => s.remove);
  const clearAttachments = useAttachmentStore((s) => s.clearForNewConversation);

  // Attachments are conversation-scoped server-side — when the user starts a
  // fresh conversation (conversationId resets to null), drop the local chips.
  const prevConversationId = useRef<string | null>(conversationId);
  useEffect(() => {
    if (prevConversationId.current && !conversationId) clearAttachments();
    prevConversationId.current = conversationId;
  }, [conversationId, clearAttachments]);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, []);

  const onDrop = useCallback((accepted: File[]) => void addFiles(accepted), [addFiles]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    noClick: true,
    noKeyboard: true,
    disabled: generating,
  });

  function handleSend() {
    if (generating || uploading) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    // Attachment content is injected server-side from the conversation's
    // attachment store — the message goes out as plain text.
    sendMessage(trimmed);
    setText('');
    requestAnimationFrame(autoResize);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // On touch, Enter should insert a newline — sending is the button's job,
    // matching native mobile chat behaviour. Precise-pointer devices keep
    // Enter-to-send with Shift+Enter for newlines.
    if (!isMobile && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const overLimit = text.length > MAX_CHARS;
  const readyAttachments = attachments.filter((a) => a.stage === 'ready').length;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 sm:pb-6">
      {(workspaceId || readyAttachments > 0) && (
        <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] text-foreground-secondary">
          <FolderPlus className="h-3 w-3" />
          {workspaceId && readyAttachments > 0
            ? `Project context + ${readyAttachments} attachment${readyAttachments === 1 ? '' : 's'} active for this chat`
            : workspaceId
              ? 'Project context active for this chat'
              : `${readyAttachments} attachment${readyAttachments === 1 ? '' : 's'} available to this chat`}
        </div>
      )}

      <div
        {...getRootProps()}
        className={cn(
          'relative rounded-2xl border bg-surface shadow-sm transition-all',
          'focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/15',
          isDragActive ? 'border-primary ring-2 ring-primary/20' : 'border-border',
        )}
      >
        <input {...getInputProps()} />

        {isDragActive && (
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl bg-surface/90 text-sm font-medium text-primary">
            Drop anything — repos, PDFs, slides, images, audio, video
            <span className="mt-0.5 text-[11px] font-normal text-foreground-secondary">AQUA routes it automatically</span>
          </div>
        )}

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {attachments.map((a) => (
              <AttachmentChip key={a.localId} attachment={a} onRemove={() => removeAttachment(a.localId)} />
            ))}
          </div>
        )}

        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            autoResize();
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            // P1 (mobile) — iOS Safari overlays the keyboard without resizing
            // the layout viewport (interactive-widget only helps Chromium).
            // Nudge the composer back into view once the keyboard settles.
            window.setTimeout(() => {
              textareaRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }, 300);
          }}
          placeholder={readyAttachments > 0 ? 'Ask about your files…' : 'Message AQUA…'}
          rows={1}
          className="max-h-60 min-h-[52px] px-4 py-3.5 pr-14 text-[15px]"
        />

        <div className="flex items-center justify-between px-2.5 pb-2.5">
          <div className="flex items-center gap-0.5">
            <Tooltip label="Attach any file — documents, images, audio, video, archives">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={generating || uploading}
                className="tap rounded-lg p-2 text-foreground-secondary transition-colors hover:bg-surface-secondary hover:text-foreground disabled:opacity-40"
                aria-label="Attach files"
              >
                <Paperclip className="h-4 w-4" />
              </button>
            </Tooltip>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) void addFiles(Array.from(e.target.files));
                e.target.value = '';
              }}
            />

            <Tooltip label="Upload a named project">
              <button
                onClick={() => setProjectDialogOpen(true)}
                disabled={generating}
                className="tap rounded-lg p-2 text-foreground-secondary transition-colors hover:bg-surface-secondary hover:text-foreground disabled:opacity-40"
                aria-label="Upload project"
              >
                <FolderPlus className="h-4 w-4" />
              </button>
            </Tooltip>

            {text.length > MAX_CHARS - 500 && (
              <span className={cn('ml-1 text-[11px] tabular-nums', overLimit ? 'text-danger' : 'text-foreground-secondary/60')}>
                {text.length}/{MAX_CHARS}
              </span>
            )}
          </div>

          {generating ? (
            <Tooltip label="Stop generating (Esc)">
              <Button size="icon" variant="secondary" onClick={stopGenerating} className="tap h-9 w-9 rounded-full">
                <Square className="h-3.5 w-3.5 fill-current" />
              </Button>
            </Tooltip>
          ) : (
            <Button
              size="icon"
              onClick={handleSend}
              disabled={!text.trim() || overLimit || uploading}
              className="tap h-9 w-9 rounded-full"
              aria-label="Send message"
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <p className="mt-2 text-center text-[11px] text-foreground-secondary/50">
        AQUA can make mistakes. Verify important information.
      </p>

      <div className="mt-1.5 hidden items-center justify-center gap-3 text-[11px] text-foreground-secondary/50 sm:flex">
        <span className="flex items-center gap-1">
          <kbd className="rounded border border-border/70 bg-surface-secondary px-1 py-0.5 font-mono text-[10px]">
            {isMac ? '⌘K' : 'Ctrl+K'}
          </kbd>
          Search
        </span>
        <span className="flex items-center gap-1">
          <kbd className="rounded border border-border/70 bg-surface-secondary px-1 py-0.5 font-mono text-[10px]">
            {isMac ? `${modKey}⇧U` : 'Ctrl+Shift+U'}
          </kbd>
          Upload repository
        </span>
      </div>

      <ProjectUploadDialog open={projectDialogOpen} onOpenChange={setProjectDialogOpen} />
    </div>
  );
}
