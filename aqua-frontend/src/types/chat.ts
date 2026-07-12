import type { ChatSuccessResponse, FallbackAttempt, SearchSource } from './api';
import type { PatchProposal } from './patch';

/**
 * 'sending'   — request in flight, no tokens yet (thinking / pipeline stages)
 * 'streaming' — tokens actively arriving via SSE
 * 'complete'  — final answer rendered
 * 'error'     — request failed (retry offered)
 */
export type MessageStatus = 'sending' | 'streaming' | 'complete' | 'error';

export interface MessageDiagnostics {
  provider: string;
  providerScore: number;
  taskType: string;
  confidence: number;
  latencyMs: number | null;
  fallbackChain: FallbackAttempt[];
  orchestration: ChatSuccessResponse['orchestration'];
  plan: ChatSuccessResponse['plan'];
  intelligence: ChatSuccessResponse['intelligence'];
  memory: ChatSuccessResponse['memory'];
  verification?: ChatSuccessResponse['verification'];
  project?: ChatSuccessResponse['project'];
}

export interface UiMessage {
  /** Client-generated id — the server does not assign message ids. */
  id: string;
  role: 'user' | 'assistant';
  content: string;
  ts: number;
  status: MessageStatus;
  error?: string;
  /** Live pipeline stage while status==='sending' (from real SSE stage events). */
  stage?: { id: string; label: string };
  /** Answer hit the output budget or the stream was interrupted — "Continue" offered. */
  truncated?: boolean;
  finishReason?: string;
  /** User pressed Stop; the partial shown is what was persisted server-side. */
  stoppedByUser?: boolean;
  /** Workspace grounding surfaced before/with the answer (stream `workspace` event). */
  workspace?: { workspaceId: string; contextInjected: boolean; filesReferenced: string[] };
  /** Day 4 — patch-first edit proposal attached to this assistant turn. */
  patch?: PatchProposal;
  /** Web-search sources grounding this assistant turn (structured, from the
   *  SSE `search` event / `done` payload). Renders as source cards below the
   *  answer; internal `[n]` markers are stripped from the text itself. */
  sources?: SearchSource[];
  /** Only present on completed assistant messages. */
  diagnostics?: MessageDiagnostics;
  /** Text-file attachments inlined into the outgoing message (user turns only). */
  attachments?: TextAttachment[];
}

export interface TextAttachment {
  id: string;
  name: string;
  sizeBytes: number;
  /** Raw text content that gets folded into the outgoing chat message. */
  content: string;
}

export interface UiConversation {
  id: string;
  /** Derived client-side from the first user message — the server has no title field. */
  title: string;
  messageCount: number;
  createdAt: number;
  /** Local-only — the backend has no rename/pin endpoints. Persisted in localStorage. */
  pinned: boolean;
  renamedTitle?: string;
}
