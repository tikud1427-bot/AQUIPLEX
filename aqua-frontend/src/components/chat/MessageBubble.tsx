import { memo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertCircle, ArrowRightCircle, CircleSlash, FolderGit2, Paperclip, Pencil, RotateCcw, X, Check } from 'lucide-react';
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer';
import { ThinkingIndicator } from './ThinkingIndicator';
import { SourceCards } from './SourceCards';
import { MessageActions } from './MessageActions';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { ResponseConfidence } from './ResponseConfidence';
import { PatchCard } from '@/components/patch/PatchCard';
import { ArtifactCard } from '@/components/artifact/ArtifactCard';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Avatar } from '@/components/ui/avatar';
import { AquaLogo } from '@/components/common/AquaLogo';
import { useChatStore } from '@/stores/chatStore';
import { useUploadStore } from '@/stores/uploadStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { UiMessage } from '@/types';

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** "answered from workspace" grounding strip — shown when project context was injected. */
function WorkspaceContextChip({ workspace }: { workspace: NonNullable<UiMessage['workspace']> }) {
  const overview = useUploadStore((s) => s.overview);
  if (!workspace.contextInjected) return null;
  const name = overview?.name || workspace.workspaceId;
  const files = workspace.filesReferenced ?? [];
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border/70 bg-surface-secondary/60 px-2.5 py-1.5 text-[11px] text-foreground-secondary">
      <span className="flex items-center gap-1 font-medium text-foreground-secondary">
        <FolderGit2 className="h-3 w-3" />
        Answering from workspace · {name}
      </span>
      {files.length > 0 && (
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          {files.slice(0, 4).map((f) => (
            <code key={f} className="truncate rounded bg-surface px-1.5 py-0.5 font-mono text-[10px]" title={f}>
              {f.split('/').pop()}
            </code>
          ))}
          {files.length > 4 && <span>+{files.length - 4} more</span>}
        </span>
      )}
    </div>
  );
}

export const MessageBubble = memo(function MessageBubble({ message, isLast }: { message: UiMessage; isLast: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const contentRef = useRef<HTMLDivElement>(null);
  const regenerate = useChatStore((s) => s.regenerate);
  const editAndResend = useChatStore((s) => s.editAndResend);
  const retryLastMessage = useChatStore((s) => s.retryLastMessage);
  const continueGeneration = useChatStore((s) => s.continueGeneration);
  const generating = useChatStore((s) => s.generating);
  const developerMode = useSettingsStore((s) => s.developerMode);

  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="message-row group flex justify-end px-4 py-2"
      >
        <div className="flex max-w-[85%] flex-col items-end gap-1 sm:max-w-[70%]">
          {editing ? (
            <div className="w-full rounded-xl border border-primary bg-surface p-3 shadow-sm">
              <Textarea
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="min-h-[60px]"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    setEditing(false);
                    editAndResend(message.id, draft);
                  }
                  if (e.key === 'Escape') {
                    setDraft(message.content);
                    setEditing(false);
                  }
                }}
              />
              <div className="mt-2 flex justify-end gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => { setDraft(message.content); setEditing(false); }}>
                  <X className="h-3.5 w-3.5" /> Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => { setEditing(false); editAndResend(message.id, draft); }}
                  disabled={!draft.trim()}
                >
                  <Check className="h-3.5 w-3.5" /> Save & submit
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-xl bg-primary px-4 py-2.5 text-[15px] text-primary-foreground shadow-sm [overflow-wrap:anywhere]">
              {message.content}
            </div>
          )}

          {!editing && message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {message.attachments.map((a) => (
                <span
                  key={a.id}
                  className="flex items-center gap-1.5 rounded-md border border-border bg-surface-secondary px-2 py-1 text-[11px] text-foreground-secondary"
                >
                  <Paperclip className="h-3 w-3" /> {a.name}
                </span>
              ))}
            </div>
          )}

          {!editing && (
            <div className="hover-reveal flex items-center gap-1.5 pr-0.5">
              <span className="text-[11px] text-foreground-secondary/60">{formatTime(message.ts)}</span>
              {!generating && (
                <button
                  onClick={() => setEditing(true)}
                  className="tap flex h-7 w-7 items-center justify-center rounded-md text-foreground-secondary/70 hover:bg-surface-secondary hover:text-foreground"
                  aria-label="Edit message"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
        </div>
      </motion.div>
    );
  }

  // Assistant message
  const isThinking = message.status === 'sending' && !message.content;
  const isStreaming = message.status === 'streaming';
  const isError = message.status === 'error';
  const wasInterrupted = message.finishReason === 'interrupted';

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="message-row group flex gap-3 px-4 py-3"
    >
      <Avatar className="mt-0.5 h-7 w-7 shrink-0 bg-gradient-to-br from-primary to-accent">
        <AquaLogo size={20} />
      </Avatar>

      <div className="min-w-0 flex-1">
        {message.workspace && !isThinking && <WorkspaceContextChip workspace={message.workspace} />}

        {isThinking ? (
          <ThinkingIndicator stage={message.stage} />
        ) : isError ? (
          <div className="flex items-start gap-2 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2.5 text-sm text-danger">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="flex-1">
              <p>{message.error ?? 'Something went wrong.'}</p>
              {message.errorCode === 'INSUFFICIENT_CREDITS' ? (
                // P1 (freemium) — a dead end becomes a doorway: nothing was
                // lost, and the fix is one tap away.
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => { window.location.href = message.errorUpgradeUrl ?? '/wallet'; }}
                  >
                    Buy credits
                  </Button>
                  <span className="text-xs text-foreground-secondary">
                    Your conversations, files, and memory stay saved.
                  </span>
                </div>
              ) : message.error !== 'Stopped' && (
                <Button size="sm" variant="outline" className="mt-2 border-danger/30 text-danger hover:bg-danger/10" onClick={() => retryLastMessage()}>
                  <RotateCcw className="h-3 w-3" /> Retry
                </Button>
              )}
            </div>
          </div>
        ) : (
          <>
            <div ref={contentRef}>
              <MarkdownRenderer content={message.content} streaming={isStreaming} stripCitations />
            </div>

            <SourceCards sources={message.sources} />

            {message.patch && !isStreaming && <PatchCard patch={message.patch} messageId={message.id} />}

            {(message.artifact || message.artifactPlan || message.artifactProgress) && (
              <ArtifactCard
                artifact={message.artifact}
                plan={message.artifactPlan}
                progress={message.artifactProgress}
                streaming={isStreaming || message.status === 'sending'}
              />
            )}

            {message.stoppedByUser && (
              <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-foreground-secondary/70">
                <CircleSlash className="h-3 w-3" /> Generation stopped
              </div>
            )}

            {!isStreaming && message.truncated && !generating && (
              <div className="mt-2 flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => continueGeneration()}>
                  <ArrowRightCircle className="h-3.5 w-3.5" /> Continue
                </Button>
                <span className="text-[11px] text-foreground-secondary/70">
                  {wasInterrupted ? 'Response was interrupted' : 'Response hit the length limit'}
                </span>
              </div>
            )}

            {!isStreaming && (
              <ResponseConfidence workspace={message.workspace} verification={message.diagnostics?.verification} />
            )}

            {!isStreaming && (
              <div className="mt-0.5 flex items-center gap-1">
                <MessageActions
                  content={message.content}
                  contentRef={contentRef}
                  onRegenerate={isLast && !generating ? () => regenerate(message.id) : undefined}
                  className="hover-reveal"
                />
                <span className="hover-reveal ml-1 text-[11px] text-foreground-secondary/50">
                  {formatTime(message.ts)}
                </span>
              </div>
            )}

            {developerMode && message.diagnostics && !isStreaming && (
              <DiagnosticsPanel diagnostics={message.diagnostics} />
            )}
          </>
        )}
      </div>
    </motion.div>
  );
});