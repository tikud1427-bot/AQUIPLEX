import { apiClient } from './client';
import type { GetConversationResponse, ListConversationsResponse, PatchConversationResponse } from '@/types';

export async function listConversations(limit = 100, skip = 0) {
  const { data } = await apiClient.get<ListConversationsResponse>('/conversations', {
    params: { limit, skip },
  });
  return data;
}

export async function getConversation(id: string) {
  const { data } = await apiClient.get<GetConversationResponse>(`/conversations/${encodeURIComponent(id)}`);
  return data;
}

/** Update server-owned metadata: title / pinned / archived (P0). */
export async function patchConversation(
  id: string,
  patch: { title?: string; pinned?: boolean; archived?: boolean },
) {
  const { data } = await apiClient.patch<PatchConversationResponse>(
    `/conversations/${encodeURIComponent(id)}`,
    patch,
  );
  return data;
}

/** Hard delete — the backend has no "clear messages but keep the thread" mode. */
export async function deleteConversation(id: string) {
  const { data } = await apiClient.delete<{ success: true; cleared: string }>(
    `/conversations/${encodeURIComponent(id)}`,
  );
  return data;
}
