/**
 * Day 4 — Patch-first editing types.
 * Wire format of editEngine.serializeProposal() (backend).
 */

export type PatchStatus = 'proposed' | 'applied' | 'rejected' | 'reverted' | 'failed';
export type ChangeType = 'create' | 'delete' | 'modify';

export interface DiffLine {
  type: 'equal' | 'add' | 'del';
  /** 1-based line number in the original file (absent on added lines). */
  oldLine?: number;
  /** 1-based line number in the modified file (absent on removed lines). */
  newLine?: number;
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface PatchFileDiff {
  path: string;
  changeType: ChangeType;
  explanation: string;
  lang?: string;
  appliedOps: number;
  /** Snippet match required whitespace-tolerant fuzzy matching — worth a second look. */
  fuzzyMatched: boolean;
  stats: { added: number; removed: number };
  totalOldLines: number;
  totalNewLines: number;
  hunks: DiffHunk[];
  /** Standard unified-diff text (copy / export). */
  unified: string;
}

export interface PatchVerificationCheck {
  id: string;
  label: string;
  status: 'pass' | 'fail';
  detail?: string;
}

export interface PatchVerification {
  ran: boolean;
  passed: boolean;
  checks: PatchVerificationCheck[];
  warnings: string[];
}

export interface FailedOperation {
  file: string;
  error: string;
  operation?: string;
  suggestion?: string;
}

export interface RelatedFile {
  path: string;
  reason: string;
}

export interface PatchProposal {
  id: string;
  workspaceId: string;
  createdAt: number;
  status: PatchStatus;
  instruction: string;
  summary: string;
  reasoning: string;
  impact: string;
  risks: string[];
  breakingChanges: string[];
  relatedFiles: RelatedFile[];
  failedOperations: FailedOperation[];
  stats: { filesChanged: number; added: number; removed: number };
  verification: PatchVerification;
  provider?: string;
  latencyMs?: number;
  files: PatchFileDiff[];
}

export interface ApplyConflict {
  file: string;
  reason: string;
}
