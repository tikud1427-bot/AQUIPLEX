import { apiClient } from './client';
import type { PatchProposal, ApplyConflict } from '@/types';

/**
 * Day 4 — patch-first editing endpoints.
 * Proposals are normally created conversationally (chat `patch` SSE event);
 * proposeEdit() exists for direct/programmatic use.
 */

export async function proposeEdit(workspaceId: string, instruction: string) {
  const { data } = await apiClient.post<{ success: true; proposal: PatchProposal }>(
    `/project/workspace/${encodeURIComponent(workspaceId)}/edit`,
    { instruction },
  );
  return data;
}

export async function listEdits(workspaceId: string) {
  const { data } = await apiClient.get<{ success: true; proposals: PatchProposal[] }>(
    `/project/workspace/${encodeURIComponent(workspaceId)}/edits`,
  );
  return data;
}

export async function getEdit(workspaceId: string, proposalId: string) {
  const { data } = await apiClient.get<{ success: true; proposal: PatchProposal }>(
    `/project/workspace/${encodeURIComponent(workspaceId)}/edit/${encodeURIComponent(proposalId)}`,
  );
  return data;
}

export interface ApplyPatchResult {
  success: boolean;
  error?: string;
  conflicts?: ApplyConflict[];
  suggestion?: string;
}

/** Apply is atomic + conflict-checked server-side; 409 carries the conflict list. */
export async function applyPatch(workspaceId: string, proposalId: string): Promise<ApplyPatchResult> {
  try {
    const { data } = await apiClient.post(
      `/project/workspace/${encodeURIComponent(workspaceId)}/edit/${encodeURIComponent(proposalId)}/apply`,
    );
    return { success: !!data.success };
  } catch (err: unknown) {
    const resp = (err as { response?: { data?: ApplyPatchResult & { error?: string } } })?.response?.data;
    return {
      success: false,
      error: resp?.error ?? 'Apply failed — the server could not be reached.',
      conflicts: resp?.conflicts,
      suggestion: resp?.suggestion,
    };
  }
}

export async function rejectPatch(workspaceId: string, proposalId: string): Promise<ApplyPatchResult> {
  try {
    const { data } = await apiClient.post(
      `/project/workspace/${encodeURIComponent(workspaceId)}/edit/${encodeURIComponent(proposalId)}/reject`,
    );
    return { success: !!data.success };
  } catch (err: unknown) {
    const resp = (err as { response?: { data?: { error?: string } } })?.response?.data;
    return { success: false, error: resp?.error ?? 'Reject failed.' };
  }
}

export async function revertPatch(workspaceId: string, proposalId: string): Promise<ApplyPatchResult> {
  try {
    const { data } = await apiClient.post(
      `/project/workspace/${encodeURIComponent(workspaceId)}/edit/${encodeURIComponent(proposalId)}/revert`,
    );
    return { success: !!data.success };
  } catch (err: unknown) {
    const resp = (err as { response?: { data?: { error?: string } } })?.response?.data;
    return { success: false, error: resp?.error ?? 'Revert failed.' };
  }
}
