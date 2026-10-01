import { create } from 'zustand';
import { sendChatMessage } from '@/api/chat';
import { streamChatMessage, StreamUnsupportedError } from '@/api/chatStream';
import { getConversation } from '@/api/conversations';
import { listArtifacts, getArtifact } from '@/api/artifacts';
import { useArtifactsStore } from './artifactsStore';
import { normalizeError, isCancel } from '@/api/client';
import { refreshMind } from './mindStore';
import { refreshWallet } from './walletStore';
import { useUiStore } from './uiStore';
import { useConversationStore } from './conversationStore';
// Read at call time only, never at module init — same contract artifactsStore
// already relies on for its import of this file.
import { useUploadStore } from './uploadStore';
import type { ChatSuccessResponse, MessageDiagnostics, PatchProposal, UiMessage } from '@/types';

interface ChatState {
  conversationId: string | null;
  workspaceId: string | null;
  /**
   * UUS — set while the "Getting to Know You" intro is on screen.
   *
   * Lives on the store rather than being threaded as a Composer prop so the
   * intro can reuse Composer and MessageList COMPLETELY unchanged. A user who
   * finishes the intro has therefore already learned the product's main
   * surface, and every intro turn is a real conversation turn — stored,
   * ingested, reflected on, correctable.
   */
  introMode: boolean;
  messages: UiMessage[];
  generating: boolean;
  loadingHistory: boolean;
  error: string | null;
  abortController: AbortController | null;

  newConversation: () => void;
  loadConversation: (id: string) => Promise<void>;
  setWorkspaceId: (id: string | null) => void;
  setIntroMode: (on: boolean) => void;

  sendMessage: (text: string) => Promise<void>;
  /** Day 4 — PatchCard reports proposal status changes (applied / rejected / reverted). */
  updateMessagePatch: (messageId: string, patch: PatchProposal) => void;
  retryLastMessage: () => Promise<void>;
  regenerate: (assistantMessageId: string) => Promise<void>;
  editAndResend: (userMessageId: string, newText: string) => Promise<void>;
  continueGeneration: () => Promise<void>;
  stopGenerating: () => void;
}

function makeId() {
  return crypto.randomUUID();
}

function userMessage(text: string): UiMessage {
  return { id: makeId(), role: 'user', content: text, ts: Date.now(), status: 'complete' };
}

function pendingAssistantMessage(): UiMessage {
  return { id: makeId(), role: 'assistant', content: '', ts: Date.now(), status: 'sending' };
}

function toDiagnostics(res: ChatSuccessResponse): MessageDiagnostics {
  return {
    provider: res.provider,
    providerScore: res.providerScore,
    taskType: res.taskType,
    confidence: res.confidence,
    latencyMs: res.latencyMs,
    fallbackChain: res.fallbackChain,
    orchestration: res.orchestration,
    plan: res.plan,
    intelligence: res.intelligence,
    memory: res.memory,
    verification: res.verification,
    project: res.project,
  };
}

/**
 * Sidebar reconcile, debounced.
 *
 * Every turn used to fire a full GET /conversations (up to 100 rows) — a
 * request per message, on a list the client had already updated locally. The
 * server owns updatedAt and messageCount, so it still has the last word; it
 * just doesn't need it after every sentence. touch() keeps the ordering
 * correct in the meantime.
 */
let sidebarSyncTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSidebarSync(delayMs: number) {
  if (sidebarSyncTimer) clearTimeout(sidebarSyncTimer);
  sidebarSyncTimer = setTimeout(() => {
    sidebarSyncTimer = null;
    void useConversationStore.getState().fetchConversations();
  }, delayMs);
}

/** Sent by the "Continue" affordance when an answer was cut off (budget/interrupt). */
const CONTINUE_PROMPT =
  'Continue exactly from where your previous response was cut off. Do not repeat anything you already wrote.';

export const useChatStore = create<ChatState>((set, get) => {
  /**
   * Shared core for every turn. Streams via SSE; falls back to the legacy
   * request/response endpoint ONLY if streaming is unavailable AND no token
   * has been rendered yet (never restarts an answer under the user's cursor).
   *
   * Token deltas are batched through requestAnimationFrame — dozens of
   * per-token store updates per second would re-render the whole message
   * list; one flush per frame keeps the UI fluid during fast providers.
   */
  async function runTurn(outgoingText: string, opts?: { skipUserBubble?: boolean }) {
    const { conversationId, workspaceId } = get();
    const controller = new AbortController();

    const assistantMsg = pendingAssistantMessage();
    set((s) => ({
      messages: opts?.skipUserBubble
        ? [...s.messages, assistantMsg]
        : [...s.messages, userMessage(outgoingText), assistantMsg],
      generating: true,
      error: null,
      abortController: controller,
    }));

    /** Stale-turn guard: false once the user switched/cleared conversations. */
    const isLive = () => get().messages.some((m) => m.id === assistantMsg.id);

    const patchMsg = (patch: Partial<UiMessage>) =>
      set((s) => ({
        messages: s.messages.map((m) => (m.id === assistantMsg.id ? { ...m, ...patch } : m)),
      }));

    const wasNewConversation = !conversationId;

    // Terminal-turn guard for rAF token batching. A token/replacement can queue
    // an animation-frame flush immediately before the server's `done` event;
    // once the turn settles that callback must never be allowed to resurrect
    // `status: 'streaming'`.
    let flushScheduled = false;
    let flushRaf: number | null = null;
    let turnSettled = false;

    const cancelPendingFlush = () => {
      turnSettled = true;
      if (flushRaf !== null) {
        cancelAnimationFrame(flushRaf);
        flushRaf = null;
      }
      flushScheduled = false;
    };

    const finishTurn = (res: ChatSuccessResponse, contentOverride?: string) => {
      cancelPendingFlush();
      // The mind evolved during this turn — pull the fresh model so the
      // dashboard (if open) updates the moment the answer lands. Silent +
      // debounced inside the store; no polling anywhere.
      refreshMind();
      refreshWallet(); // P1 — keep the remaining-credits chip honest after each spend
      if (!isLive()) {
        set({ generating: false, abortController: null });
        return;
      }
      set((s) => ({
        conversationId: res.conversationId,
        generating: false,
        abortController: null,
        messages: s.messages.map((m) =>
          m.id === assistantMsg.id
            ? {
                ...m,
                content: contentOverride ?? res.answer,
                status: 'complete' as const,
                ts: Date.now(),
                stage: undefined,
                truncated: res.truncated,
                finishReason: res.finishReason,
                diagnostics: toDiagnostics(res),
                patch: res.patch ?? m.patch,
                artifact: res.artifact ?? m.artifact,
                artifactPlan: undefined,
                artifactProgress: undefined,
                sources: res.search?.sources?.length ? res.search.sources : m.sources,
                workspace: res.project
                  ? {
                      workspaceId: res.project.workspaceId,
                      contextInjected: res.project.contextInjected,
                      filesReferenced: res.project.filesReferenced ?? [],
                    }
                  : m.workspace,
              }
            : m,
        ),
      }));

      const convStore = useConversationStore.getState();
      if (wasNewConversation) {
        convStore.ensureLocalEntry(res.conversationId, Date.now());
        convStore.cacheTitle(res.conversationId, outgoingText);
      }
      // A workspace attached before the first message had no conversation to
      // bind to yet. It does now — record the pairing so a reload can restore
      // this conversation's project context.
      if (workspaceId) convStore.linkWorkspace(res.conversationId, workspaceId);
      // Reorder the sidebar now; reconcile with the server shortly after.
      convStore.touch(res.conversationId);
      scheduleSidebarSync(wasNewConversation ? 1_500 : 5_000);
    };

    const failTurn = (message: string) => {
      cancelPendingFlush();
      if (!isLive()) return;
      set((s) => ({
        generating: false,
        abortController: null,
        error: message,
        messages: s.messages.map((m) =>
          m.id === assistantMsg.id ? { ...m, status: 'error' as const, stage: undefined, error: message } : m,
        ),
      }));
    };

    // ── rAF-batched token buffer ────────────────────────────────────────────
    let streamedText = '';
    let firstTokenSeen = false;

    const flush = () => {
      flushScheduled = false;
      flushRaf = null;
      if (turnSettled || !isLive()) return;
      patchMsg({ content: streamedText, status: 'streaming', stage: undefined });
    };
    const scheduleFlush = () => {
      if (turnSettled || flushScheduled) return;
      flushScheduled = true;
      flushRaf = requestAnimationFrame(flush);
    };

    // ── Legacy request/response path (compat fallback + shared error handling) ──
    const runLegacy = async () => {
      try {
        const res = await sendChatMessage(
          {
          message: outgoingText,
          conversationId: conversationId ?? undefined,
          workspaceId: workspaceId ?? undefined,
          // Absent outside the intro, so ordinary chat is byte-identical.
          ...(get().introMode ? { mode: 'understanding' as const } : {}),
        },
          controller.signal,
        );
        finishTurn(res);
      } catch (err) {
        if (!isLive()) return;
        if (isCancel(err)) {
          set((s) => ({
            generating: false,
            abortController: null,
            messages: s.messages.map((m) =>
              m.id === assistantMsg.id ? { ...m, status: 'error' as const, error: 'Stopped' } : m,
            ),
          }));
          return;
        }
        failTurn(normalizeError(err).message);
      }
    };

    // ── Streaming path (primary) ─────────────────────────────────────────────
    try {
      let doneReceived = false;
      let serverError: string | null = null;
      let serverErrorCode: string | undefined;
      let serverErrorUpgradeUrl: string | undefined;

      await streamChatMessage(
        {
          message: outgoingText,
          conversationId: conversationId ?? undefined,
          workspaceId: workspaceId ?? undefined,
          // The intro runs on THIS path. `mode` was set only on the legacy
          // fallback below — which never runs, because streaming does not
          // fail — so every interview turn reached the server as ordinary
          // chat: classified at 0.45, verification and debate engaged, the
          // interviewer persona never loaded, and the gap-driven steering
          // never applied. The intro screen was real and the conversation
          // behind it was not. Absent outside the intro, so ordinary chat
          // stays byte-identical.
          ...(get().introMode ? { mode: 'understanding' as const } : {}),
        },
        {
          onMeta: (e) => {
            // conversationId arrives up front — later turns/aborts already know it.
            if (isLive()) set({ conversationId: e.conversationId });
          },
          onStage: (e) => {
            // Stages can begin after generation (for example verification).
            // Keep surfacing them after the first token instead of leaving the
            // composer in a silent blinking state while the server is still
            // doing legitimate post-draft work.
            if (isLive()) patchMsg({ stage: { id: e.id, label: e.label } });
          },
          onWorkspace: (e) => {
            if (isLive()) patchMsg({ workspace: e });
          },
          onSearch: (e) => {
            // Grounding arrives before tokens — surface source cards early so
            // they're visible as the answer streams (finishTurn later
            // reconciles with the authoritative `done` payload).
            if (isLive() && e.used && e.sources?.length) patchMsg({ sources: e.sources });
          },
          onProviderFailed: () => {
            // Pre-token fallback is invisible by design — the thinking state
            // simply continues; diagnostics carry the chain afterwards.
          },
          onToken: (t) => {
            firstTokenSeen = true;
            streamedText += t;
            scheduleFlush();
          },
          onReplace: (text) => {
            // Verification revised the draft — swap wholesale.
            streamedText = text;
            scheduleFlush();
          },
          onPatch: (proposal) => {
            // Patch proposal arrives before the explanation text — attach it
            // immediately so the diff preview renders alongside the answer.
            if (isLive()) patchMsg({ patch: proposal });
          },
          onArtifactPlan: (plan) => {
            // Plan lands before content builds — the card shows the outline
            // ("3 files · md") while per-file generation runs.
            if (isLive()) patchMsg({ artifactPlan: plan });
          },
          onArtifactProgress: (progress) => {
            if (isLive()) patchMsg({ artifactProgress: progress });
          },
          onArtifact: (manifest) => {
            // Stored manifest arrives just before the summary text — attach
            // so the Download card renders the moment the answer lands.
            if (isLive()) patchMsg({ artifact: manifest });
            // Live insert into the panel if it's open (no-op otherwise).
            useArtifactsStore.getState().upsertFromManifest(manifest);
          },
          onDone: (payload) => {
            doneReceived = true;
            finishTurn(payload);
          },
          onError: (e) => {
            serverError = e.message ?? e.error;
            serverErrorCode = e.code;
            serverErrorUpgradeUrl = e.upgradeUrl;
          },
        },
        controller.signal,
      );

      if (doneReceived) return;

      // Stream ended without `done`:
      if (serverError) {
        if (firstTokenSeen && streamedText.trim()) {
          cancelPendingFlush();
          // Partial answer already on screen — keep it, note the interruption.
          if (!isLive()) return;
          set((s) => ({
            generating: false,
            abortController: null,
            messages: s.messages.map((m) =>
              m.id === assistantMsg.id
                ? { ...m, content: streamedText, status: 'complete' as const, stage: undefined, truncated: true, finishReason: 'interrupted' }
                : m,
            ),
          }));
          return;
        }
        // P1 (freemium) — out of credits is a normal state, not a failure.
        // Friendly copy + a real path forward; balance chip refreshes so the
        // number the user sees matches why they were stopped.
        if (serverErrorCode === 'INSUFFICIENT_CREDITS') {
          refreshWallet();
          useUiStore.getState().toast('info', 'Out of credits', 'Your conversations, files, and memory are all safe.');
          failTurn(serverError ?? "You're out of credits.");
          if (isLive()) {
            set((s) => ({
              messages: s.messages.map((m) =>
                m.id === assistantMsg.id
                  ? { ...m, errorCode: 'INSUFFICIENT_CREDITS', errorUpgradeUrl: serverErrorUpgradeUrl ?? '/wallet' }
                  : m,
              ),
            }));
          }
          return;
        }
        failTurn(serverError);
        return;
      }

      // Connection dropped mid-stream with no error event.
      if (firstTokenSeen && streamedText.trim()) {
        cancelPendingFlush();
        if (!isLive()) return;
        set((s) => ({
          generating: false,
          abortController: null,
          messages: s.messages.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, content: streamedText, status: 'complete' as const, stage: undefined, truncated: true, finishReason: 'interrupted' }
              : m,
          ),
        }));
        return;
      }
      failTurn('The connection dropped before AQUA could respond. Your message was not lost — try again.');
    } catch (err) {
      if (!isLive()) return;

      // Stop button / conversation switch — the backend persisted the partial.
      if ((err as Error)?.name === 'AbortError' || isCancel(err)) {
        cancelPendingFlush();
        if (streamedText.trim()) {
          set((s) => ({
            generating: false,
            abortController: null,
            messages: s.messages.map((m) =>
              m.id === assistantMsg.id
                ? { ...m, content: streamedText, status: 'complete' as const, stage: undefined, stoppedByUser: true }
                : m,
            ),
          }));
        } else {
          set((s) => ({
            generating: false,
            abortController: null,
            messages: s.messages.map((m) =>
              m.id === assistantMsg.id ? { ...m, status: 'error' as const, stage: undefined, error: 'Stopped' } : m,
            ),
          }));
        }
        return;
      }

      // Older backend without /chat/stream — transparent one-time fallback,
      // only safe because no token has rendered yet.
      if (err instanceof StreamUnsupportedError && !firstTokenSeen) {
        await runLegacy();
        return;
      }

      if (firstTokenSeen && streamedText.trim()) {
        cancelPendingFlush();
        set((s) => ({
          generating: false,
          abortController: null,
          messages: s.messages.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, content: streamedText, status: 'complete' as const, stage: undefined, truncated: true, finishReason: 'interrupted' }
              : m,
          ),
        }));
        return;
      }
      failTurn(normalizeError(err).message);
    }
  }

  return {
    conversationId: null,
    workspaceId: null,
    introMode: false,
    messages: [],
    generating: false,
    loadingHistory: false,
    error: null,
    abortController: null,

    updateMessagePatch: (messageId, patch) =>
      set((s) => ({
        messages: s.messages.map((m) => (m.id === messageId ? { ...m, patch } : m)),
      })),

    newConversation: () => {
      // Cancel any in-flight generation first — its late response must not
      // attach itself (or its conversationId) to the fresh conversation.
      get().abortController?.abort();
      set({
        conversationId: null,
        workspaceId: null,
        messages: [],
        generating: false,
        error: null,
        abortController: null,
      });
      // workspaceId was already cleared here, but the *visible* project
      // context never was: uploadStore.overview is global, so a new chat kept
      // showing the previous project's strip — the interface claiming context
      // this conversation does not have.
      useUploadStore.getState().clearOverview();
    },

    setIntroMode: (on) => set({ introMode: on }),

    setWorkspaceId: (id) => {
      set({ workspaceId: id });
      // Bind it to the conversation immediately when there is one. Uploads
      // that happen before the first message are bound in finishTurn instead,
      // once the server has minted the conversation id.
      const { conversationId } = get();
      if (conversationId) useConversationStore.getState().linkWorkspace(conversationId, id);
    },

    loadConversation: async (id) => {
      // Same guard as newConversation(): a response still in flight for the
      // previous conversation must not land in this one.
      get().abortController?.abort();

      // ── Project context follows the conversation ──────────────────────────
      // Two failures fixed here. Reloading a project conversation used to drop
      // its grounding entirely (workspaceId reset to null, overview never
      // refetched), and switching to a conversation WITHOUT a project left the
      // previous project's context strip on screen. Both told the user the
      // wrong thing about what AQUA can see. Restore this conversation's own
      // workspace, or clear the view when it has none.
      const linkedWorkspaceId = useConversationStore.getState().workspaceFor(id);
      const upload = useUploadStore.getState();
      if (linkedWorkspaceId) void upload.fetchOverview(linkedWorkspaceId);
      else upload.clearOverview();

      set({
        loadingHistory: true,
        error: null,
        conversationId: id,
        workspaceId: linkedWorkspaceId,
        messages: [],
        generating: false,
        abortController: null,
      });
      try {
        const res = await getConversation(id);
        const messages: UiMessage[] = res.messages.map((m) => ({
          id: makeId(),
          role: m.role,
          content: m.content,
          ts: m.ts,
          status: 'complete',
        }));
        set({ messages, loadingHistory: false });

        // ── Artifact rehydration (P1) ────────────────────────────────────────
        // Persisted messages carry no artifact linkage (ServerMessage is
        // role/content/ts only), but manifests carry conversationId +
        // createdAt, and the backend appends the assistant summary message
        // immediately after the store write. Attach each artifact to the
        // assistant message whose ts is CLOSEST AFTER createdAt within 60s —
        // a documented heuristic; the P4 Artifacts panel is the durable,
        // linkage-free home. Fire-and-forget: history renders instantly,
        // cards pop in when the fetches land. Guarded against the user
        // switching conversations mid-flight.
        void (async () => {
          try {
            const { artifacts } = await listArtifacts({ conversationId: id });
            if (!artifacts.length || get().conversationId !== id) return;
            const manifests = await Promise.all(
              artifacts.map((a) => getArtifact(a.id).then((r) => r.artifact).catch(() => null)),
            );
            if (get().conversationId !== id) return;
            set((s) => {
              const next = [...s.messages];
              for (const manifest of manifests) {
                if (!manifest) continue;
                let best = -1;
                let bestDelta = Infinity;
                for (let i = 0; i < next.length; i++) {
                  const m = next[i];
                  if (m.role !== 'assistant' || m.artifact) continue;
                  const delta = m.ts - manifest.createdAt;
                  if (delta >= -2_000 && delta < 60_000 && Math.abs(delta) < bestDelta) {
                    best = i;
                    bestDelta = Math.abs(delta);
                  }
                }
                if (best !== -1) next[best] = { ...next[best], artifact: manifest };
              }
              return { messages: next };
            });
          } catch {
            /* rehydration is best-effort — history already rendered */
          }
        })();
      } catch (err) {
        set({ error: normalizeError(err).message, loadingHistory: false });
      }
    },

    sendMessage: async (text) => {
      if (!text.trim() || get().generating) return;
      await runTurn(text.trim());
    },

    retryLastMessage: async () => {
      const { messages, generating } = get();
      if (generating) return;
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      if (!lastUser) return;
      // Drop the failed assistant bubble that followed it before retrying.
      set((s) => ({ messages: s.messages.filter((m) => !(m.role === 'assistant' && m.status === 'error')) }));
      await runTurn(lastUser.content, { skipUserBubble: true });
    },

    regenerate: async (assistantMessageId) => {
      const { messages, generating } = get();
      if (generating) return;
      const idx = messages.findIndex((m) => m.id === assistantMessageId);
      if (idx <= 0) return;
      const precedingUser = messages[idx - 1];
      if (precedingUser.role !== 'user') return;
      // AQUA has no "replace last turn" endpoint — every /chat call appends
      // to server history. Regenerate removes the old assistant bubble
      // locally and asks again; the prior answer still exists server-side.
      set((s) => ({ messages: s.messages.filter((m) => m.id !== assistantMessageId) }));
      await runTurn(precedingUser.content, { skipUserBubble: true });
    },

    editAndResend: async (userMessageId, newText) => {
      const { messages, generating } = get();
      if (generating || !newText.trim()) return;
      const idx = messages.findIndex((m) => m.id === userMessageId);
      if (idx === -1) return;
      // Same backend constraint as regenerate() — history can't be rewritten
      // server-side, so we drop everything from this point forward locally
      // and resend as a fresh turn.
      set((s) => ({ messages: s.messages.slice(0, idx) }));
      await runTurn(newText.trim());
    },

    continueGeneration: async () => {
      // Offered when the last answer was truncated (output budget) or
      // interrupted mid-stream — sends a continuation turn; the follow-up
      // appears as a new assistant bubble (server history is append-only).
      const { generating, messages } = get();
      if (generating) return;
      const last = messages[messages.length - 1];
      if (!last || last.role !== 'assistant' || !last.truncated) return;
      // Clear the flag so the Continue affordance doesn't linger on the old bubble.
      set((s) => ({
        messages: s.messages.map((m) => (m.id === last.id ? { ...m, truncated: false } : m)),
      }));
      await runTurn(CONTINUE_PROMPT, { skipUserBubble: true });
    },

    stopGenerating: () => {
      get().abortController?.abort();
    },
  };
});