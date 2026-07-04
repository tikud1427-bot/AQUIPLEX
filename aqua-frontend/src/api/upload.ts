import { apiClient } from './client';
import type { UploadKind } from '@/utils/uploadKinds';

/** Per-file processing result from POST /upload. */
export interface UploadFileResult {
  name: string;
  kind: UploadKind;
  status: 'ready' | 'failed';
  error?: string;
  attachmentId?: string;
  format?: string;
  pages?: number | null;
  contentChars?: number;
  truncated?: boolean;
  entriesExtracted?: number;
  routedTo?: string;
  analyzed?: boolean;
}

export interface UploadWorkspaceResult {
  id: string;
  name: string;
  projectType: string;
  filesIngested: number;
  summary: unknown;
  overview: unknown;
}

export interface ServerAttachment {
  id: string;
  name: string;
  kind: UploadKind;
  format: string;
  title: string;
  pages: number | null;
  language: string | null;
  truncated: boolean;
  contentChars: number;
  uploadedAt: number;
  metadata: Record<string, unknown>;
}

export interface UnifiedUploadResponse {
  success: boolean;
  conversationId: string;
  isNewConversation: boolean;
  results: UploadFileResult[];
  workspace?: UploadWorkspaceResult;
  attachments: ServerAttachment[];
  error?: string;
}

/** ONE upload call for everything — the server classifies and routes. */
export async function uploadUnified(
  files: Array<{ name: string; content: string }>,
  opts?: { conversationId?: string | null; workspaceName?: string; onProgress?: (pct: number) => void },
) {
  const { data } = await apiClient.post<UnifiedUploadResponse>(
    '/upload',
    {
      files,
      ...(opts?.conversationId ? { conversationId: opts.conversationId } : {}),
      ...(opts?.workspaceName ? { workspaceName: opts.workspaceName } : {}),
    },
    {
      onUploadProgress: (e) => {
        if (opts?.onProgress && e.total) opts.onProgress(Math.round((e.loaded / e.total) * 100));
      },
    },
  );
  return data;
}

export async function listConversationAttachments(conversationId: string) {
  const { data } = await apiClient.get<{ success: boolean; attachments: ServerAttachment[] }>(
    `/upload/attachments/${encodeURIComponent(conversationId)}`,
  );
  return data;
}

export async function deleteConversationAttachment(conversationId: string, attachmentId: string) {
  const { data } = await apiClient.delete<{ success: boolean }>(
    `/upload/attachments/${encodeURIComponent(conversationId)}/${encodeURIComponent(attachmentId)}`,
  );
  return data;
}
