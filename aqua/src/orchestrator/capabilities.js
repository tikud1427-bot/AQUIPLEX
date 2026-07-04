/**
 * AQUA Adaptive Tool Orchestrator — Capability Definitions
 *
 * Registers the capability set from the Phase 6 spec ("Capability
 * Selection") against capabilityRegistry.js. Each capability's detect(ctx)
 * returns { enabled, confidence, reason } — cost/latency are static per
 * capability (declared here) since they reflect what the capability *is*,
 * not what a particular request needs.
 *
 * ctx shape (built by toolOrchestrator.js):
 *   {
 *     taskType, complexity, confidence, hasWorkspaceId,
 *     requiredSet:  Set<string>   capability ids the selected profile wants
 *     profileLabel: string
 *     verification: { enabled, reason }   from verificationStrategy.js
 *     multiLabel:   { labels, tags, dominant }   from multiLabelClassifier.js
 *   }
 *
 * Capabilities whose underlying execution agent isn't built in this
 * codebase yet (Web Search, Streaming) are still reported — always
 * disabled, with a reason pointing at the extension seam — rather than
 * omitted, per the spec: "New capabilities should register themselves
 * dynamically" / "support future plugins without modification". This is the
 * same honesty convention agentRegistry.js already uses for its empty agent
 * slots.
 */
import { registerCapability } from './capabilityRegistry.js';

// Project/workspace-grounded capabilities only matter if a workspace is
// actually attached to the request — no point reporting them "enabled"
// against nothing.
const PROJECT_GROUP = new Set([
  'workspace_analysis', 'repository_understanding', 'project_retrieval', 'file_intelligence',
]);

function inProfile(id, ctx) {
  return ctx.requiredSet.has(id);
}

function define(id, { label, group, cost, latency, reasonEnabled, reasonDisabled, override }) {
  registerCapability(id, {
    label, group, cost, latency,
    detect(ctx) {
      if (typeof override === 'function') {
        const result = override(ctx);
        if (result) return result;
      }
      const wanted = inProfile(id, ctx);
      const gatedByWorkspace = PROJECT_GROUP.has(id) && !ctx.hasWorkspaceId;
      const enabled = wanted && !gatedByWorkspace;

      if (!enabled && wanted && gatedByWorkspace) {
        return {
          enabled: false,
          confidence: 0.1,
          reason: `${label} would help, but no workspace is attached to this request.`,
        };
      }

      return {
        enabled,
        confidence: enabled ? Math.max(0.55, ctx.confidence ?? 0.7) : 0.1,
        reason: enabled ? reasonEnabled(ctx) : reasonDisabled(ctx),
      };
    },
  });
}

// ── Memory ───────────────────────────────────────────────────────────────────

define('memory_retrieval', {
  label: 'Memory Retrieval', group: 'memory', cost: 'low', latency: 'low',
  reasonEnabled: (ctx) => `${ctx.profileLabel} benefits from recalled facts about the user.`,
  reasonDisabled: () => 'Minimal pipeline — no recalled context needed for this request.',
});

define('long_term_memory_extraction', {
  label: 'Long-Term Memory Extraction', group: 'memory', cost: 'low', latency: 'low',
  reasonEnabled: () => 'Request may contain durable facts worth storing.',
  reasonDisabled: () => 'Simple Question profile — extraction skipped to avoid wasted writes.',
});

define('conversation_history', {
  label: 'Conversation History', group: 'memory', cost: 'low', latency: 'low',
  reasonEnabled: () => 'Current conversation context included, as for every profile.',
  reasonDisabled: () => 'Not applicable.',
});

// ── Project / workspace ──────────────────────────────────────────────────────

define('workspace_analysis', {
  label: 'Workspace Analysis', group: 'project', cost: 'low', latency: 'low',
  reasonEnabled: (ctx) => `${ctx.profileLabel} requires awareness of the attached workspace.`,
  reasonDisabled: () => 'No workspace context required for this profile.',
});

define('repository_understanding', {
  label: 'Repository Understanding', group: 'project', cost: 'medium', latency: 'medium',
  reasonEnabled: (ctx) => `${ctx.profileLabel} requires structural understanding of the codebase.`,
  reasonDisabled: () => 'No repository scan required for this profile.',
});

define('project_retrieval', {
  label: 'Project Retrieval', group: 'project', cost: 'medium', latency: 'medium',
  reasonEnabled: (ctx) => `${ctx.profileLabel} requires relevant project files in context.`,
  reasonDisabled: () => 'No project retrieval required for this profile.',
});

define('file_intelligence', {
  label: 'File Intelligence', group: 'project', cost: 'medium', latency: 'low',
  reasonEnabled: (ctx) => `${ctx.profileLabel} benefits from per-file summaries/dependency info.`,
  reasonDisabled: () => 'Not required for this profile.',
});

// ── Research ─────────────────────────────────────────────────────────────────

define('deep_research', {
  label: 'Deep Research', group: 'research', cost: 'high', latency: 'high',
  reasonEnabled: () => 'Research Request profile — comprehensive source/evidence strategy needed.',
  reasonDisabled: () => 'Not a research request.',
});

define('web_search', {
  label: 'Web Search', group: 'research', cost: 'medium', latency: 'medium',
  override: () => ({
    enabled: false,
    confidence: 0.05,
    reason: 'No web search agent registered yet (see src/intelligence/agentRegistry.js) — reported for planning purposes only.',
  }),
  reasonEnabled: () => '', reasonDisabled: () => '',
});

// ── Reasoning ─────────────────────────────────────────────────────────────────

define('reasoning_engine', {
  label: 'Reasoning Engine', group: 'reasoning', cost: 'low', latency: 'low',
  reasonEnabled: (ctx) => `${ctx.profileLabel} requires multi-step reasoning before answering.`,
  reasonDisabled: () => 'Simple Question profile — single-pass answer is sufficient.',
});

define('planning_engine', {
  label: 'Planning Engine', group: 'reasoning', cost: 'low', latency: 'low',
  reasonEnabled: () => 'Planning/architecture request — roadmap or structural plan required.',
  reasonDisabled: () => 'No planning step required for this profile.',
});

define('critic', {
  label: 'Critic', group: 'reasoning', cost: 'low', latency: 'low',
  reasonEnabled: () => 'Non-trivial request — a self-critique pass improves answer quality.',
  reasonDisabled: () => 'Simple Question profile — critique pass skipped.',
});

define('verification', {
  label: 'Verification', group: 'reasoning', cost: 'medium', latency: 'medium',
  override: (ctx) => ({
    enabled: ctx.verification.enabled,
    confidence: ctx.verification.enabled ? 0.8 : 0.1,
    reason: ctx.verification.reason,
  }),
  reasonEnabled: () => '', reasonDisabled: () => '',
});

// ── Execution ─────────────────────────────────────────────────────────────────

define('code_generation', {
  label: 'Code Generation', group: 'execution', cost: 'medium', latency: 'medium',
  reasonEnabled: () => 'Coding/debugging request — output will include generated code.',
  reasonDisabled: () => 'No code generation needed for this profile.',
});

define('architecture_planning', {
  label: 'Architecture Planning', group: 'execution', cost: 'high', latency: 'high',
  reasonEnabled: () => 'Structural/system design tradeoffs need explicit reasoning.',
  reasonDisabled: () => 'No architecture planning needed for this profile.',
});

define('debugging', {
  label: 'Debugging', group: 'execution', cost: 'medium', latency: 'medium',
  reasonEnabled: () => 'Debugging Request profile — hypothesis/root-cause strategy needed.',
  reasonDisabled: () => 'Not a debugging request.',
});

define('tool_calling', {
  label: 'Tool Calling', group: 'execution', cost: 'medium', latency: 'medium',
  reasonEnabled: () => 'Coding request may require running or inspecting project tooling.',
  reasonDisabled: () => 'Not required for this profile.',
});

// ── Infra ─────────────────────────────────────────────────────────────────────

define('streaming', {
  label: 'Streaming', group: 'infra', cost: 'low', latency: 'low',
  override: () => ({
    enabled: false,
    confidence: 0.05,
    reason: 'chat.js responds via a single JSON payload today, not SSE — reported for planning purposes only.',
  }),
  reasonEnabled: () => '', reasonDisabled: () => '',
});

// Importing this module is enough to register every capability above —
// toolOrchestrator.js does `import './capabilities.js'` purely for the
// side effect, then reads everything back via capabilityRegistry.js.
export {};
