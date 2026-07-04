import { apiClient } from './client';
import type { ListFactsResponse } from '@/types';

export async function listFacts(conversationId: string) {
  const { data } = await apiClient.get<ListFactsResponse>(`/memory/${encodeURIComponent(conversationId)}`);
  return data;
}

export async function deleteFact(conversationId: string, key: string) {
  const { data } = await apiClient.delete<{ success: true; deleted: string }>(
    `/memory/${encodeURIComponent(conversationId)}/${encodeURIComponent(key)}`,
  );
  return data;
}

export async function clearFacts(conversationId: string) {
  const { data } = await apiClient.delete<{ success: true; cleared: true }>(
    `/memory/${encodeURIComponent(conversationId)}`,
  );
  return data;
}
