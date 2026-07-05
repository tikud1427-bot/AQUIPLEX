import { apiClient } from './client';

/* ── Types mirroring aqua/src/mind (backend is source of truth) ─────────── */

export type Dimension =
  | 'identity' | 'personality' | 'communication'
  | 'preferences' | 'knowledge' | 'behavior' | 'decision';

export interface CompactBelief {
  dimension: Dimension;
  key: string;
  value: unknown;
  confidence: number;
  evidenceCount: number;
  contradictions: number;
  status: 'active' | 'archived' | 'locked';
  locked: boolean;
  temporary: boolean;
  source: 'inference' | 'explicit' | 'correction' | 'fact_bridge';
  updatedAt: number;
}

export interface Goal {
  id: string;
  title: string;
  priority: number;
  progress: number;
  deadline: number | null;
  dependencies: string[];
  blockers: string[];
  relatedProjects: string[];
  status: 'active' | 'blocked' | 'completed' | 'abandoned' | 'stale';
  confidence: number;
  mentions: number;
  createdAt: number;
  updatedAt: number;
  lastMentionedAt: number;
}

export interface Episode {
  id: string;
  title: string;
  startedAt: number;
  endedAt: number | null;
  conversationIds: string[];
  objectives: string[];
  outcome: string | null;
  status: string;
  lastActivityAt: number;
}

export interface WorkingItem { text: string; addedAt: number; lastSeenAt: number; count?: number }
export interface Working {
  focus: { topic: string; weight: number; lastSeenAt: number }[];
  focusRanked: { topic: string; weight: number }[];
  blockers: WorkingItem[];
  deadlines: { label: string; addedAt?: number }[];
  recentDiscoveries: WorkingItem[];
  openQuestions: WorkingItem[];
  updatedAt: number;
}

export interface Prediction { label: string; probability: number; basis: string; ts: number }

export interface TimelineEvent {
  id: string; ts: number; kind: string; subject: string; detail: string; importance: number;
}

export interface ReflectionReport {
  ts: number; turnCount: number;
  learned: { key: string; value: unknown; confidence: number }[];
  weakened: { key: string; from: number; to: number }[];
  promoted: string[]; archived: string[];
  goalsStaled: string[]; episodesClosed: number; graphPruned: number; expired: string[];
}

export interface MindModel {
  success: true;
  ownerId: string;
  turnCount: number;
  createdAt: number;
  updatedAt: number;
  identity: CompactBelief[];
  personality: CompactBelief[];
  communication: CompactBelief[];
  preferences: CompactBelief[];
  knowledge: CompactBelief[];
  behavior: CompactBelief[];
  decision: CompactBelief[];
  goals: Goal[];
  activeGoals: string[];
  episodes: Episode[];
  working: Working;
  predictions: Prediction[];
  timeline: TimelineEvent[];
  graph: { nodeCount: number; edgeCount: number };
  reflections: ReflectionReport[];
  lastReflectionAt: number | null;
}

export interface GraphNode { id: string; key: string; type: string; label: string; weight: number }
export interface GraphEdge { key: string; from: string; to: string; type: string; weight: number }

export interface BeliefExplanation {
  dimension: string; key: string; value: unknown; confidence: number;
  evidenceCount: number; contradictions: number; explanation: string;
  recentEvidence: { ts: number; conversationId: string | null; signal: string; delta: number; support?: boolean; correction?: boolean }[];
}

/* ── Calls (reuse existing endpoints — no backend changes) ──────────────── */

/** 404 = no model yet → null (empty-state, not an error). */
export async function fetchMind(): Promise<MindModel | null> {
  try {
    const { data } = await apiClient.get<MindModel>('/mind');
    return data;
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'response' in err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 404 || status === 400) return null;
    }
    throw err;
  }
}

export async function fetchGraph() {
  const { data } = await apiClient.get<{ success: true; nodes: GraphNode[]; edges: GraphEdge[] }>('/mind/graph');
  return data;
}

export async function explainBelief(dimension: string, key: string) {
  const { data } = await apiClient.get<{ success: true; explanation: BeliefExplanation }>(
    `/mind/beliefs/${encodeURIComponent(dimension)}/${encodeURIComponent(key)}`,
  );
  return data.explanation;
}

export async function correctBelief(dimension: string, key: string, value: unknown) {
  const { data } = await apiClient.patch<{ success: true; belief: CompactBelief }>(
    `/mind/beliefs/${encodeURIComponent(dimension)}/${encodeURIComponent(key)}`, { value },
  );
  return data.belief;
}

export async function setBeliefLock(dimension: string, key: string, locked: boolean) {
  const { data } = await apiClient.post<{ success: true; belief: CompactBelief }>(
    `/mind/beliefs/${encodeURIComponent(dimension)}/${encodeURIComponent(key)}/lock`, { locked },
  );
  return data.belief;
}

export async function setBeliefTemporary(dimension: string, key: string, temporary: boolean) {
  const { data } = await apiClient.post<{ success: true; belief: CompactBelief }>(
    `/mind/beliefs/${encodeURIComponent(dimension)}/${encodeURIComponent(key)}/temporary`, { temporary },
  );
  return data.belief;
}

export async function deleteBelief(dimension: string, key: string) {
  const { data } = await apiClient.delete<{ success: boolean }>(
    `/mind/beliefs/${encodeURIComponent(dimension)}/${encodeURIComponent(key)}`,
  );
  return data;
}

export async function updateGoal(id: string, patch: Partial<Pick<Goal, 'status' | 'priority' | 'title' | 'progress' | 'deadline'>>) {
  const { data } = await apiClient.patch<{ success: true; goal: Goal }>(`/mind/goals/${encodeURIComponent(id)}`, patch);
  return data.goal;
}

export async function deleteGoal(id: string) {
  const { data } = await apiClient.delete<{ success: boolean }>(`/mind/goals/${encodeURIComponent(id)}`);
  return data;
}

export function exportMindUrl() {
  return `${apiClient.defaults.baseURL}/mind/export`;
}

export async function eraseMind() {
  const { data } = await apiClient.delete<{ success: boolean }>('/mind');
  return data;
}
