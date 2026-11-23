import axios from 'axios';
import { API_BASE_URL, apiClient } from './client';

/**
 * Gmail intelligence (Gmail Phase 5) — the user's OWN email knowledge,
 * extracted deterministically on the server. No AI model is involved and
 * nothing here is generated: every item is a statement found in an email,
 * with the evidence behind it. All endpoints are owner-scoped server-side
 * (the session's user); nothing here sends an owner id.
 */

// completed / cancelled: a later email reported it done or called it off (as stated in email; never user-confirmed).
export type ItemStatus = 'current' | 'superseded' | 'contradicted' | 'completed' | 'cancelled';
export type Basis = 'direct' | 'inference';

export interface EmailItem {
  id: string;
  type: 'decision' | 'commitment' | 'task' | 'deadline' | 'event' | 'date' | 'project' | 'document' | 'topic';
  status: ItemStatus;
  statement: string | null;
  basis: Basis;
  explicit: boolean;
  certainty: 'stated' | 'likely' | 'uncertain';
  confidence: number;
  userConfirmed: false;
  due: string | null;
  dueResolution: string | null;
  source: { gmailMessageId: string; threadId: string; threadTopic: string | null; sentAt: string | null; extractedAt: string };
  supersededBy: string | null;
  supersedes: string | null;
  conflictsWith: string[];
  closedBy?: { kind: 'completed' | 'cancelled'; by: string; sourceTimestamp: string | null; gmailMessageId: string; quote: string } | null;
  evidenceIds: string[];
}

export interface ConflictGroup { items: EmailItem[]; note: string }
export interface Page<T> { total: number; items: T[]; nextCursor: number | null }

export interface Overview {
  counts: Record<'openCommitments' | 'openTasks' | 'upcoming' | 'currentDecisions' | 'supersededDecisions' | 'contradictions' | 'people' | 'projects' | 'conversations' | 'items', number>;
  upcoming: EmailItem[];
  openCommitments: EmailItem[];
  openTasks: EmailItem[];
  contradictions: ConflictGroup[];
}

export interface Person { key: string; names: string[]; address: string; conversations: number; openItems: number; itemIds: string[] }
export interface PeopleView extends Page<Person> { organizations: { domain: string; basis: 'inference'; members: string[] }[] }
export interface ProjectsView extends Page<{ topic: string | null; threadId: string; messages: number; itemIds: string[] }> { projects: { name: string; threadId: string; itemId: string | null }[] }
export type ItemView = Page<EmailItem> & { contradictions?: ConflictGroup[] };

export interface EvidenceDetail {
  item: EmailItem;
  evidence: { gmailMessageId: string; threadId: string; threadTopic: string | null; sentAt: string | null; extractedAt: string; field: string; span: number[]; quote: string };
  supersededBy: EmailItem[];
  supersedes: EmailItem[];
  conflictsWith: EmailItem[];
}

export interface Answer {
  supported: boolean;
  intent: string | null;
  question: string;
  summary: string;
  items: EmailItem[];
  contradictions: ConflictGroup[];
  evidenceIds: string[];
  superseded?: EmailItem[];
  possiblyInvolving?: EmailItem[];
  ambiguous?: { key: string; names: string[]; address: string }[];
  detail?: EvidenceDetail;
}

export type SyncPhase = 'not_started' | 'initial_in_progress' | 'initial_interrupted' | 'initial_complete'
  | 'incremental_in_progress' | 'full_resync_in_progress' | 'failed' | 'paused';

export interface Connection {
  connectionId: string;
  connectorId: string;
  status: 'active' | 'needs_reauth' | 'revoked' | 'disconnecting' | 'disconnect_incomplete';
  account: { label: string | null };
  hasCredentials: boolean;
  syncPaused?: boolean;
  /** A sync of this connection is running on the server right now. */
  syncing?: boolean;
  syncPhase?: SyncPhase;
  /** Messages currently imported from this connection. */
  imported?: number;
  initialSyncComplete?: boolean;
  /** An unfinished full listing: messages listed so far in this pass (Gmail's own total is only an estimate; never shown as a percentage). */
  progress?: { listed?: number | null } | null;
  lastSync: { state?: string; finishedAt?: string; startedAt?: string; error?: string; lastSuccessAt?: string | null } | null;
}

/** 'unavailable' = Gmail Connect is not enabled on this server (the routes answer 404). */
export class EmailApiError extends Error {
  constructor(public kind: 'unavailable' | 'not-found' | 'error', message: string) { super(message); }
}
function toError(err: unknown): EmailApiError {
  if (axios.isAxiosError(err)) {
    if (err.response?.status === 404) return new EmailApiError('not-found', 'Not found');
    return new EmailApiError('error', 'Email knowledge could not be loaded. Try again.');
  }
  return new EmailApiError('error', 'Email knowledge could not be loaded. Try again.');
}

const BASE = '/connect';
export type ViewName = 'commitments' | 'tasks' | 'deadlines' | 'decisions' | 'superseded' | 'contradictions' | 'people' | 'projects';

export async function fetchConnections(): Promise<Connection[]> {
  try { return (await apiClient.get(`${BASE}/connections`)).data.connections ?? []; }
  catch (err) { const e = toError(err); throw e.kind === 'not-found' ? new EmailApiError('unavailable', 'Gmail connection is not available on this server.') : e; }
}
export async function fetchOverview(): Promise<Overview> {
  try { return (await apiClient.get(`${BASE}/gmail/intelligence/overview`)).data; } catch (err) { throw toError(err); }
}
export async function fetchView<T = ItemView>(view: ViewName, cursor = 0, limit = 20): Promise<T> {
  try { return (await apiClient.get(`${BASE}/gmail/intelligence/view/${view}`, { params: { limit, cursor } })).data; } catch (err) { throw toError(err); }
}
export async function fetchEvidence(id: string): Promise<EvidenceDetail> {
  try { return (await apiClient.get(`${BASE}/gmail/intelligence/evidence/${encodeURIComponent(id)}`)).data; } catch (err) { throw toError(err); }
}
export async function askEmail(question: string): Promise<Answer> {
  try { return (await apiClient.post(`${BASE}/gmail/intelligence/ask`, { question })).data; } catch (err) { throw toError(err); }
}

/* Connection controls (finalization) — the existing owner-scoped routes. The
   connect start is a full-page navigation: the server stores the OAuth state in
   the session and redirects to Google; the callback returns to /aqua/email. */
export const gmailConnectStartUrl = () => `${API_BASE_URL}${BASE}/gmail/start`;
export type ConnectionAction = 'sync' | 'pause' | 'resume' | 'revoke' | 'disconnect';
export async function connectionAction(connectionId: string, action: ConnectionAction): Promise<void> {
  const url = `${BASE}/connections/${encodeURIComponent(connectionId)}`;
  try {
    if (action === 'disconnect') await apiClient.delete(url);
    else await apiClient.post(`${url}/${action}`, action === 'sync' ? { mode: 'auto' } : undefined);
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 409) {
      const reason = (err.response.data as { reason?: string } | undefined)?.reason;
      throw new EmailApiError('error', reason === 'PAUSED' ? 'Sync is paused for this connection.' : 'This connection cannot do that right now. Reconnect Gmail if access was revoked.');
    }
    throw new EmailApiError('error', 'That did not work. Try again.');
  }
}
