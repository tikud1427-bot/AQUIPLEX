/**
 * Types mirrored 1:1 from the AQUA backend (aqua/src/routes/*.js).
 * The backend is the source of truth — do not add fields here that the
 * server doesn't actually send, and do not rename anything to "look nicer".
 */

export type TaskType =
  | 'conversation'
  | 'personal_info'
  | 'simple_qa'
  | 'opinion'
  | 'brainstorming'
  | 'summarization'
  | 'debugging'
  | 'coding'
  | 'architecture'
  | 'research'
  | 'reasoning'
  | 'analysis'
  | 'planning'
  | 'creative_writing'
  | 'file_analysis'
  | 'agent_task'
  | 'memory_recall'
  | 'memory_update'
  | (string & {});

export type Provider = 'gemini' | 'groq' | 'openrouter';
export type CostTier = 'low' | 'medium' | 'high';

/** One web-search source the answer was grounded in (backend contextExtractor). */
export interface SearchSource {
  /** 1-based rank the model cites as [n]. */
  n: number;
  title: string;
  url: string;
}

/** Web Search grounding for a turn — present only when search ran. */
export interface SearchGrounding {
  used: boolean;
  cached: boolean;
  provider: string | null;
  query: string;
  sources: SearchSource[];
  tokens?: number;
  latencyMs?: number | null;
  reason?: string;
}

export interface FallbackAttempt {
  provider: Provider | string;
  outcome: 'success' | 'failed' | 'invalid';
  reason?: string;
  latencyMs: number | null;
}

export interface ChatRequest {
  message: string;
  conversationId?: string | null;
  workspaceId?: string;
}

export interface ChatSuccessResponse {
  success: true;
  requestId: string;
  conversationId: string;
  isNewConversation: boolean;

  provider: Provider | string;
  providerScore: number;
  taskType: TaskType;
  taskLabels: string[];
  confidence: number;
  promptModules: string[];
  latencyMs: number | null;
  fallbackChain: FallbackAttempt[];
  answer: string;
  /** True when the answer hit the output-token budget (finishReason 'length')
   *  or the stream was interrupted mid-generation ('interrupted') — the UI
   *  offers "Continue" in both cases. */
  truncated: boolean;
  finishReason: 'stop' | 'length' | 'interrupted' | (string & {});

  memory: {
    extracted: number;
    injected: number;
    facts: Array<{ key: string; value: string }>;
  };

  plan: {
    complexity: 'low' | 'medium' | 'high' | string;
    multiStep: boolean;
    reasoningMode: string;
    contextTokensBefore: number;
    contextTokensAfter: number;
  };

  intelligence: {
    active: boolean;
    pipeline: string[];
    strategy: string | null;
    criticFocus: string[];
  };

  verification: {
    warranted: boolean;
    reason: string | null;
    ran: boolean;
    passed: boolean | null;
    revised: boolean;
  };

  orchestration: {
    profile: string;
    profileLabel: string;
    capabilitiesEnabled: string[];
    capabilitiesSkipped: string[];
    estimatedCost: CostTier;
    estimatedLatency: CostTier;
    verificationEnabled: boolean;
    multiLabel: string[];
    tags: string[];
  };

  project?: {
    workspaceId: string;
    contextInjected: boolean;
    /** Paths of workspace files the answer was grounded in (may be empty). */
    filesReferenced?: string[];
  };

  /** Web Search grounding — present only when the orchestrator ran a search. */
  search?: SearchGrounding;

  /** Day 4 — present when the turn produced a patch-first edit proposal. */
  mode?: 'edit' | 'artifact';
  patch?: import('./patch').PatchProposal;
  /** Artifact Engine P1 — present when the turn generated a downloadable artifact. */
  artifact?: import('./artifact').ArtifactManifest;
}

// ── Streaming (POST /chat/stream — Server-Sent Events) ─────────────────────

export interface StreamMetaEvent {
  requestId: string;
  conversationId: string;
  isNewConversation: boolean;
}

/** A REAL pipeline stage starting server-side — never scripted progress. */
export interface StreamStageEvent {
  id: 'classify' | 'memory' | 'workspace' | 'prompt' | 'generate' | 'verify'
    | 'edit_locate' | 'edit_generate' | 'edit_diff' | 'edit_verify' | (string & {});
  label: string;
}

export interface StreamProviderEvent {
  provider: string;
  score: number;
  attempt: number;
}

export interface StreamProviderFailedEvent {
  provider: string;
  reason: string;
}

export interface StreamWorkspaceEvent {
  workspaceId: string;
  contextInjected: boolean;
  filesReferenced: string[];
}

/** Web Search grounding pushed mid-stream, before tokens (SSE `search` event). */
export interface StreamSearchEvent {
  used: boolean;
  cached: boolean;
  provider: string | null;
  query: string;
  sources: SearchSource[];
}

export interface StreamErrorEvent {
  error: string;
  recoverable: boolean;
  requestId?: string;
  conversationId?: string;
  fallbackChain?: Array<{ provider: string; outcome: string }>;
  /** P1 (freemium) — set when a pre-stream guard rejected the request. */
  status?: number;
  /** Machine code from the guard, e.g. INSUFFICIENT_CREDITS. */
  code?: string;
  /** Human sentence from the guard — preferred over `error` for display. */
  message?: string;
  upgradeUrl?: string;
  totalCredits?: number;
  costRequired?: number;
}

export interface ChatErrorResponse {
  success: false;
  requestId: string;
  conversationId: string;
  error: string;
  fallbackChain?: Array<{ provider: string; outcome: string }>;
}

export type ChatResponse = ChatSuccessResponse | ChatErrorResponse;

// ── Conversations ──────────────────────────────────────────────────────────

export interface ServerMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

export interface ConversationMeta {
  createdAt?: number;
  updatedAt?: number;
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  userAgent?: string;
  ip?: string;
  [key: string]: unknown;
}

export interface ConversationSummary {
  id: string;
  /** Server-owned display fields (P0 — synced across devices/deploys). */
  title: string | null;
  pinned: boolean;
  archived: boolean;
  updatedAt: number;
  messageCount: number;
  meta: ConversationMeta;
}

export interface PatchConversationResponse {
  success: true;
  id: string;
  meta: ConversationMeta;
}

export interface ListConversationsResponse {
  success: true;
  total: number;
  count: number;
  conversations: ConversationSummary[];
}

export interface GetConversationResponse {
  success: true;
  id: string;
  meta: ConversationMeta;
  messageCount: number;
  messages: ServerMessage[];
}

// ── Memory ────────────────────────────────────────────────────────────────

export interface MemoryFact {
  key: string;
  value: string;
  confidence?: number;
  importance?: number;
  sourceText?: string;
  ts?: number;
  isCorrection?: boolean;
}

export interface ListFactsResponse {
  success: true;
  conversationId: string;
  factCount: number;
  facts: MemoryFact[];
}

// ── Project / workspace ──────────────────────────────────────────────────

export type IndexStatus = 'pending' | 'indexing' | 'indexed' | 'failed';

export interface WorkspaceSummary {
  id: string;
  projectType: string | null;
  indexStatus: IndexStatus;
  fileCount: number;
  createdAt: number;
  meta?: Record<string, unknown>;
}

export interface CreateWorkspaceResponse {
  success: true;
  workspace: { id: string; createdAt: number; indexStatus: IndexStatus };
}

export interface UploadFilesResponse {
  success: true;
  workspaceId: string;
  projectType: string;
  filesIngested: number;
  indexStats: unknown;
  summary: string;
  overview: WorkspaceOverview | null;
}

// ── Workspace intelligence overview (generated once at index time) ────────

export interface OverviewRoute {
  method: string;
  path: string;
  file: string;
}

export interface OverviewCoreModule {
  file: string;
  importedBy: number;
  exports?: number;
}

export interface OverviewTodo {
  tag: string;
  text: string;
  file: string;
}

export interface OverviewFolder {
  dir: string;
  files: number;
  bytes: number;
}

export interface OverviewArchitecture {
  frontend: string;
  backend: string;
  apiLayer: string;
  dataLayer: string;
  authFlow: string;
  storage: string;
  backgroundJobs: string;
  serviceRelationships: string;
  dependencyFlow: string;
}

export interface OverviewStats {
  fileCount: number;
  totalBytes: number;
  totalKB: number;
  functions: number;
  classes: number;
  interfaces: number;
  components: number;
  dependencyEdges: number;
  configFileCount: number;
}

export interface WorkspaceOverview {
  generatedAt: number;
  partial: boolean;
  warnings: string[];
  name: string;
  purpose: string;
  summary: string;
  projectType: string | null;
  languages: Record<string, number>;
  frameworks: string[];
  runtime: string[];
  packageManagers: string[];
  buildTools: string[];
  frontendTech: string[];
  backendTech: string[];
  databaseTech: string[];
  authMethods: string[];
  majorDependencies: string[];
  dependencyCount: number;
  folderStructure: OverviewFolder[];
  largestFolders: { dir: string; bytes: number }[];
  envVars: string[];
  configFiles: string[];
  entryPoints: string[];
  coreModules: OverviewCoreModule[];
  importantServices: { file: string; summary: string }[];
  apiRoutes: OverviewRoute[];
  externalIntegrations: string[];
  stats: OverviewStats;
  todoCount: number;
  todos: OverviewTodo[];
  potentialTechDebt: string[];
  architecture: OverviewArchitecture;
  suggestedImprovements: string[];
  suggestedQuestions: string[];
}

export interface WorkspaceOverviewResponse {
  success: true;
  workspaceId: string;
  overview: WorkspaceOverview | null;
  note?: string;
}

export interface WorkspaceFileMeta {
  path: string;
  lang: string;
  size: number;
  summary: string;
  parsedAt: number;
}

// ── Health ────────────────────────────────────────────────────────────────

export interface ProviderHealthEntry {
  circuitState: 'closed' | 'open' | 'half_open' | string;
  score: string;
  successRate: string;
  avgLatencyMs: string;
  consecutiveFailures: number;
  cooldownRemainingS: number | null;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
}

export interface HealthResponse {
  status: string;
  ts: string;
  uptime: { startedAt: string; uptimeMs: number; uptimeHuman: string };
  providers: Record<string, ProviderHealthEntry>;
  openrouter: { models: unknown };
  metrics: unknown;
  memory: { shortTerm: unknown; longTerm: unknown };
  project: unknown;
}

// ── Generic API error shape (network / non-2xx without a body we recognize) ─

export interface ApiError {
  message: string;
  status?: number;
  requestId?: string;
  conversationId?: string;
}
