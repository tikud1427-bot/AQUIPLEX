import { create } from 'zustand';
import { sendChatMessage } from '@/api/chat';
import { streamChatMessage, StreamUnsupportedError } from '@/api/chatStream';
import { getConversation } from '@/api/conversations';
import { normalizeError, isCancel } from '@/api/client';
import { refreshMind } from './mindStore';
import { useConversationStore } from './conversationStore';
import type { ChatSuccessResponse, MessageDiagnostics, PatchProposal, UiMessage } from '@/types';

interface ChatState {
  conversationId: string | null;
  workspaceId: string | null;
  messages: UiMessage[];
  generating: boolean;
  loadingHistory: boolean;
  error: string | null;
  abortController: AbortController | null;

  newConversation: () => void;
  loadConversation: (id: string) => Promise<void>;
  setWorkspaceId: (id: string | null) => void;

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

    const finishTurn = (res: ChatSuccessResponse, contentOverride?: string) => {
      // The mind evolved during this turn — pull the fresh model so the
      // dashboard (if open) updates the moment the answer lands. Silent +
      // debounced inside the store; no polling anywhere.
      refreshMind();
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
<<<<<<< HEAD
=======
                sources: res.search?.sources?.length ? res.search.sources : m.sources,
>>>>>>> 7306efb7 (update)
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
      // Refresh sidebar message counts without blocking this turn on it.
      convStore.fetchConversations();
    };

    const failTurn = (message: string) => {
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
    let flushScheduled = false;
    let firstTokenSeen = false;

    const flush = () => {
      flushScheduled = false;
      if (!isLive()) return;
      patchMsg({ content: streamedText, status: 'streaming', stage: undefined });
    };
    const scheduleFlush = () => {
      if (flushScheduled) return;
      flushScheduled = true;
      requestAnimationFrame(flush);
    };

    // ── Legacy request/response path (compat fallback + shared error handling) ──
    const runLegacy = async () => {
      try {
        const res = await sendChatMessage(
          { message: outgoingText, conversationId: conversationId ?? undefined, workspaceId: workspaceId ?? undefined },
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

      await streamChatMessage(
        { message: outgoingText, conversationId: conversationId ?? undefined, workspaceId: workspaceId ?? undefined },
        {
          onMeta: (e) => {
            // conversationId arrives up front — later turns/aborts already know it.
            if (isLive()) set({ conversationId: e.conversationId });
          },
          onStage: (e) => {
            if (!firstTokenSeen && isLive()) patchMsg({ stage: { id: e.id, label: e.label } });
          },
          onWorkspace: (e) => {
            if (isLive()) patchMsg({ workspace: e });
          },
<<<<<<< HEAD
=======
          onSearch: (e) => {
            // Grounding arrives before tokens — surface source cards early so
            // they're visible as the answer streams (finishTurn later
            // reconciles with the authoritative `done` payload).
            if (isLive() && e.used && e.sources?.length) patchMsg({ sources: e.sources });
          },
>>>>>>> 7306efb7 (update)
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
          onDone: (payload) => {
            doneReceived = true;
            finishTurn(payload);
          },
          onError: (e) => {
            serverError = e.error;
          },
        },
        controller.signal,
      );

      if (doneReceived) return;

      // Stream ended without `done`:
      if (serverError) {
        if (firstTokenSeen && streamedText.trim()) {
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
        failTurn(serverError);
        return;
      }

      // Connection dropped mid-stream with no error event.
      if (firstTokenSeen && streamedText.trim()) {
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
    },

    setWorkspaceId: (id) => set({ workspaceId: id }),

    loadConversation: async (id) => {
      // Same guard as newConversation(): a response still in flight for the
      // previous conversation must not land in this one.
      get().abortController?.abort();
      set({ loadingHistory: true, error: null, conversationId: id, messages: [], generating: false, abortController: null });
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
