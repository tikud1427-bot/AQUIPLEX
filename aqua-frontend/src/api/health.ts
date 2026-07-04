import { apiClient } from './client';
import type { HealthResponse } from '@/types';

export async function getHealth(signal?: AbortSignal) {
  const { data } = await apiClient.get<HealthResponse>('/provider-health', { signal });
  return data;
}
