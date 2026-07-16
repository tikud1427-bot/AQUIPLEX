import axios, { AxiosError } from 'axios';
import type { ApiError } from '@/types';

export const API_BASE_URL = (import.meta.env.VITE_API_URL ?? '/api/aqua').replace(/\/+$/, '');

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  // Hang guard: worst legitimate case is a full provider fallback chain plus
  // a verification pass (~4-5 min of budget server-side). 6 min never kills a
  // live request but guarantees the UI can't spin forever on a dead socket.
  timeout: 360_000,
});

/** True when the request was deliberately aborted (e.g. "Stop generating"). */
export function isCancel(err: unknown): boolean {
  return axios.isCancel(err) || (axios.isAxiosError(err) && err.code === 'ERR_CANCELED');
}

/**
 * Normalize any thrown value from an apiClient call into a single shape the
 * UI can render directly, regardless of whether the backend returned its own
 * `{ success: false, error }` body, a non-AQUA error, or the network failed
 * outright (offline / timeout / backend down).
 */
export function normalizeError(err: unknown): ApiError {
  if (axios.isAxiosError(err)) {
    const e = err as AxiosError<{ error?: string; requestId?: string; conversationId?: string }>;

    if (e.response) {
      const body = e.response.data as { error?: string; message?: string; requestId?: string; conversationId?: string };
      return {
        // Guards send { error: CODE, message: "human sentence" } — show the sentence.
        message: body?.message ?? body?.error ?? `Request failed (${e.response.status})`,
        status: e.response.status,
        requestId: body?.requestId,
        conversationId: body?.conversationId,
      };
    }
    if (e.code === 'ECONNABORTED') {
      return { message: 'Request timed out. AQUA may be under heavy load — try again.' };
    }
    if (!navigator.onLine) {
      return { message: "You're offline. Check your connection and try again." };
    }
    return { message: 'Could not reach AQUA. Is the backend running?' };
  }
  if (err instanceof Error) return { message: err.message };
  return { message: 'Something went wrong.' };
}
