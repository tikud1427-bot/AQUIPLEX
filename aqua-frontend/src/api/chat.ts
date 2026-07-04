import { apiClient } from './client';
import type { ChatRequest, ChatSuccessResponse } from '@/types';

/**
 * Legacy request/response endpoint (POST /chat) — returns the full answer in
 * one JSON payload. Day 3 made SSE streaming (api/chatStream.ts →
 * POST /chat/stream) the PRIMARY path; this remains as the automatic
 * fallback when the stream endpoint is unavailable (older backend build)
 * and as a stable programmatic API. `signal` cancels the in-flight request.
 */
export async function sendChatMessage(
  payload: ChatRequest,
  signal?: AbortSignal,
): Promise<ChatSuccessResponse> {
  const { data } = await apiClient.post<ChatSuccessResponse>('/chat', payload, { signal });
  return data;
}
