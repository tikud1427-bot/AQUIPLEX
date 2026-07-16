import { API_BASE_URL } from './client';
import type {
  ChatRequest,
  ChatSuccessResponse,
  StreamMetaEvent,
  StreamStageEvent,
  StreamProviderEvent,
  StreamProviderFailedEvent,
  StreamWorkspaceEvent,
  StreamSearchEvent,
  StreamErrorEvent,
  PatchProposal,
  ArtifactManifest,
  StreamArtifactPlanEvent,
  StreamArtifactProgressEvent,
} from '@/types';

/**
 * POST /chat/stream — Server-Sent Events over fetch.
 *
 * EventSource can't POST a JSON body, so this parses the SSE wire format off
 * a fetch ReadableStream by hand: split on the blank-line event boundary,
 * read `event:` + `data:` fields, dispatch to typed handlers. `signal`
 * aborts the fetch — the backend sees the socket close, cancels the
 * provider call, and persists whatever partial text was already streamed.
 *
 * Throws StreamUnsupportedError when the endpoint is missing/not-SSE
 * (older backend build) so the caller can fall back to POST /chat — and
 * only BEFORE any token has been consumed, never mid-answer.
 */

export interface StreamHandlers {
  onMeta?: (e: StreamMetaEvent) => void;
  onStage?: (e: StreamStageEvent) => void;
  onProvider?: (e: StreamProviderEvent) => void;
  onProviderFailed?: (e: StreamProviderFailedEvent) => void;
  onWorkspace?: (e: StreamWorkspaceEvent) => void;
  /** Web-search grounding for this turn, pushed before tokens arrive. */
  onSearch?: (e: StreamSearchEvent) => void;
  onToken?: (t: string) => void;
  /** Verification revised the streamed draft — replace displayed text wholesale. */
  onReplace?: (text: string) => void;
  /** Day 4 — the turn produced a patch-first edit proposal (arrives before the explanation text). */
  onPatch?: (proposal: PatchProposal) => void;
  /** Artifact Engine P1 — validated plan outline, before any content builds. */
  onArtifactPlan?: (plan: StreamArtifactPlanEvent) => void;
  /** Artifact Engine P1 — one build step finished (per-file progress). */
  onArtifactProgress?: (progress: StreamArtifactProgressEvent) => void;
  /** Artifact Engine P1 — the stored artifact's public manifest (arrives before the summary text). */
  onArtifact?: (manifest: ArtifactManifest) => void;
  onDone?: (payload: ChatSuccessResponse) => void;
  onError?: (e: StreamErrorEvent) => void;
}

/** Endpoint absent or not speaking SSE — caller should use the legacy POST /chat. */
export class StreamUnsupportedError extends Error {
  constructor(detail: string) {
    super(`Streaming unavailable: ${detail}`);
    this.name = 'StreamUnsupportedError';
  }
}

export async function streamChatMessage(
  payload: ChatRequest,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  // AbortError propagates to the caller (Stop button); network failures
  // propagate too — if the server is unreachable, POST /chat won't work either.
  const res = await fetch(`${API_BASE_URL}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });

  if (res.status === 404 || res.status === 405) {
    throw new StreamUnsupportedError(`endpoint returned ${res.status}`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (!res.ok || !contentType.includes('text/event-stream')) {
    // 4xx guard/validation errors and 5xx bodies are JSON — surface the FULL
    // structured body so the UI can react to codes (INSUFFICIENT_CREDITS →
    // friendly upsell instead of a raw error string).
    let body: {
      error?: string; message?: string; upgradeUrl?: string;
      totalCredits?: number; costRequired?: number;
    } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* non-JSON body — fall through to the status message */
    }
    if (!res.ok) {
      handlers.onError?.({
        error: body.message ?? body.error ?? `Request failed (${res.status})`,
        recoverable: res.status >= 500,
        status: res.status,
        code: body.error,
        message: body.message,
        upgradeUrl: body.upgradeUrl,
        totalCredits: body.totalCredits,
        costRequired: body.costRequired,
      });
      return;
    }
    throw new StreamUnsupportedError(`unexpected content-type "${contentType}"`);
  }
  if (!res.body) {
    throw new StreamUnsupportedError('response has no readable body');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = (eventName: string, dataRaw: string) => {
    if (!dataRaw) return;
    let data: unknown;
    try {
      data = JSON.parse(dataRaw);
    } catch {
      return; // malformed frame — skip, never break the stream over one event
    }
    switch (eventName) {
      case 'meta':            handlers.onMeta?.(data as StreamMetaEvent); break;
      case 'stage':           handlers.onStage?.(data as StreamStageEvent); break;
      case 'provider':        handlers.onProvider?.(data as StreamProviderEvent); break;
      case 'provider_failed': handlers.onProviderFailed?.(data as StreamProviderFailedEvent); break;
      case 'workspace':       handlers.onWorkspace?.(data as StreamWorkspaceEvent); break;
      case 'search':          handlers.onSearch?.(data as StreamSearchEvent); break;
      case 'token':           handlers.onToken?.((data as { t: string }).t); break;
      case 'replace':         handlers.onReplace?.((data as { text: string }).text); break;
      case 'patch':           handlers.onPatch?.(data as PatchProposal); break;
      case 'artifact_plan':     handlers.onArtifactPlan?.(data as StreamArtifactPlanEvent); break;
      case 'artifact_progress': handlers.onArtifactProgress?.(data as StreamArtifactProgressEvent); break;
      case 'artifact':          handlers.onArtifact?.(data as ArtifactManifest); break;
      case 'done':            handlers.onDone?.(data as ChatSuccessResponse); break;
      case 'error':           handlers.onError?.(data as StreamErrorEvent); break;
      default: break; // unknown event — forward-compatible, ignore
    }
  };

  const parseFrame = (frame: string) => {
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue; // SSE comment (heartbeat)
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    dispatch(eventName, dataLines.join('\n'));
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Events are separated by a blank line; \r\n normalized to \n first.
    buffer = buffer.replace(/\r\n/g, '\n');
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      if (frame.trim()) parseFrame(frame);
    }
  }
  // Trailing frame without final blank line (server ended abruptly).
  if (buffer.trim()) parseFrame(buffer);
}
