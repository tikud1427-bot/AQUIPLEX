import { apiClient } from './client';
import type { GetConversationResponse, ListConversationsResponse } from '@/types';

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

/** Hard delete — the backend has no "clear messages but keep the thread" mode. */
export async function deleteConversation(id: string) {
  const { data } = await apiClient.delete<{ success: true; cleared: string }>(
    `/conversations/${encodeURIComponent(id)}`,
  );
  return data;
}
