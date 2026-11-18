/**
 * AQUA Prompt Builder v3
 *
 * Changes from v2:
 *   - buildSystemPrompt(taskType, memoryBlock) — accepts memory injection string
 *   - Memory block inserted between identity and task module
 *     (after "who I am", before "how to handle this task")
 *   - Module list includes 'memory' when facts are present
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildIdentityInjection } from '../identity/index.js';
import { fenceUntrusted, makeFenceNonce, INSTRUCTION_HIERARCHY } from './untrustedContent.js';

const __dir     = path.dirname(fileURLToPath(import.meta.url));
const promptDir = path.join(__dir, '..', 'prompts');

function load(name) {
  try {
    return fs.readFileSync(path.join(promptDir, name), 'utf8').trim() || '';
  } catch {
    return '';
  }
}

// Load all task modules once at startup
const M = {
  system:       load('system.txt'),
  coding:       load('coding.txt'),
  architecture: load('architecture.txt'),
  research:     load('research.txt'),
  reasoning:    load('reasoning.txt'),
  creative:     load('creative.txt'),
  planning:     load('planning.txt'),
  project:      load('project.txt'),
  understanding: load('understanding.txt'),   // UUS — the interviewer persona
};

/**
 * task → which extra modules to inject.
 * 'memory' is handled separately (dynamic, not a file).
 */
const MODULE_MAP = {
  // Minimal — identity only
  conversation:          [],
  memory_recall:         [],   // memory injected dynamically
  memory_update:         [],
  personal_info:         [],
  simple_qa:             [],
  opinion:               [],
  summarization:         [],

  // UUS — Getting to Know You. Its own module, and deliberately NOT sharing
  // one with 'conversation': the interviewer has a different job (understand,
  // do not answer) and mixing the two produces an assistant that helpfully
  // solves the problem it was supposed to be learning about.
  understanding_interview: ['understanding'],

  // Task-specific
  coding:                ['coding'],
  debugging:             ['coding'],
  architecture:          ['architecture'],
  research:              ['research'],
  reasoning:             ['reasoning'],
  creative_writing:      ['creative'],
  planning:              ['planning'],
  analysis:              ['research'],
  brainstorming:         ['creative'],
  file_analysis:         ['research'],
  agent_task:            ['research'],
  project_query:         ['project', 'research'],
};

/**
 * Build the minimal correct system prompt for a task type.
 * Injects memory block, then reasoning directive, then optional project context.
 *
 * @param {string} taskType    - from classifyTask()
 * @param {string} [memoryBlock] - formatted facts from memoryRetriever
 * @param {string} [reasoningDirective] - Phase 4: from reasoningStrategy.js
 * @param {string} [projectContext] - Phase 5: from projectRetriever.js ('' if no workspace)
 * @param {string} [intelligenceBlock] - Internal Intelligence Engine: synthesized plan/reasoning/critic brief ('' if low-complexity / skipped)
 * @param {{isSelf:boolean, topics:string[]}|null} [identityIntent] - from identityRouter.detectIdentityIntent(); when it flags a self/brand question the FULL identity section + confidence directive are injected. When null/absent, only the compact always-on identity block is injected.
 * @param {string} [searchContext] - Web Search: compressed live-web block from search/contextExtractor.js ('' if search skipped/failed). Injected AFTER project context — repository truth stays foundational; web results supplement it.
 * @returns {{ prompt: string, modules: string[] }}
 */
/**
 * Join every INGESTED context block for one turn, in a fixed order, into the
 * string buildSystemPrompt() fences as untrusted (its `projectContext` slot).
 *
 * Phase 1a.1 (2026-11-16): `fileMemoryContext` is memoryRetrieve()'s
 * `fileContext` — verbatim chunks, extracted summaries and names of uploaded
 * files. It used to ride the UNFENCED memory block. Routing it here is what
 * puts it behind the fence; chat.js calls this rather than joining by hand so
 * the order and membership are tested in one place.
 *
 * @param {{ attachmentContext?: string, fileMemoryContext?: string, projectContext?: string,
 *           knowledgeContext?: string, recallContext?: string }} [parts]
 * @returns {string}
 */
export function composeIngestedContext({
  attachmentContext = '', fileMemoryContext = '', projectContext = '', knowledgeContext = '', recallContext = '',
} = {}) {
  return [attachmentContext, fileMemoryContext, projectContext, knowledgeContext, recallContext]
    .filter(s => typeof s === 'string' && s.trim()).join('\n\n');
}

export function buildSystemPrompt(taskType, memoryBlock = '', reasoningDirective = '', projectContext = '', intelligenceBlock = '', identityIntent = null, searchContext = '', enginePolicy = '') {
  const modules     = MODULE_MAP[taskType] ?? [];
  const parts       = [M.system];
  const moduleNames = ['system'];

  // E1/PR-5 — the instruction hierarchy sits immediately after the base
  // system prompt, before ANY ingested content, so the rule is established
  // before the material it governs appears. One nonce per prompt: every
  // untrusted block in this prompt shares it, so the model sees one boundary
  // vocabulary rather than several.
  const fenceNonce = makeFenceNonce();
  parts.push(INSTRUCTION_HIERARCHY);
  moduleNames.push('instruction_hierarchy');

  // Identity & Self-Knowledge Layer — injected on EVERY request (compact),
  // expanded to the full profile + confidence directive when the Smart Router
  // flags a question about AQUA/Aquiplex. This is what makes AQUA always know
  // itself without retrieval; it sits right after the base system prompt and
  // before memory so brand identity is the most foundational context present.
  const identityBlock = buildIdentityInjection(identityIntent);
  if (identityBlock && identityBlock.trim()) {
    parts.push(identityBlock.trim());
    moduleNames.push(identityIntent?.isSelf ? 'identity+' : 'identity');
  }

  // Inject memory block right after identity — before task instructions.
  // UNFENCED by design: it holds what the user told AQUA about themselves.
  // CONTRACT (Phase 1a.1): no file-derived text may ride here — memoryRetrieve()
  // returns uploaded-file content separately as `fileContext`, which goes
  // through composeIngestedContext() into the fenced block below.
  if (memoryBlock && memoryBlock.trim()) {
    parts.push(memoryBlock);
    moduleNames.push('memory');
  }

  // Phase 4: reasoning directive (stepwise/reflective) — after memory, before task module
  if (reasoningDirective && reasoningDirective.trim()) {
    parts.push(reasoningDirective.trim());
    moduleNames.push('reasoning');
  }

  // Internal Intelligence Engine: synthesized plan/reasoning/critic brief —
  // after the simple reasoning directive, before project context.
  if (intelligenceBlock && intelligenceBlock.trim()) {
    parts.push(intelligenceBlock.trim());
    moduleNames.push('intelligence');
  }

  // 2026-11-16 (audit D-17) — AQUA's OWN context policy: what a follow-up
  // refers to, the evidence status of the user's world, degraded-memory
  // notices. Operator text, so it sits OUTSIDE the untrusted fence below; the
  // user's statements, files and web pages stay inside it. Producers build
  // this only from engine state (slot ids, statuses, the user's own earlier
  // words in this chat as a referent), never from ingested documents.
  if (enginePolicy && enginePolicy.trim()) {
    parts.push(`CONTEXT POLICY (from AQUA — operator instructions; not user content):\n${enginePolicy.trim()}`);
    moduleNames.push('context_policy');
  }

  // Phase 5: project context — injected after reasoning directive
  if (projectContext && projectContext.trim()) {
    // Carries attachment bodies, repository files and retrieved knowledge —
    // all ingested, all attacker-influenceable. Fenced as one block because
    // chat.js has already joined them by this point; per-source fencing
    // would need the producers to fence, which is more churn than this
    // buys today.
    parts.push(fenceUntrusted(projectContext, { source: 'your files, repositories and stored knowledge', nonce: fenceNonce }));
    moduleNames.push('project_context');
  }

  // Web Search: live-web results block — after project context so repository
  // truth remains foundational and web results are clearly supplementary,
  // before task modules so task instructions can reference "the sources".
  if (searchContext && searchContext.trim()) {
    // The least trusted source in the system: arbitrary third-party pages.
    parts.push(fenceUntrusted(searchContext, { source: 'live web search results', nonce: fenceNonce }));
    moduleNames.push('web_search');
  }

  for (const mod of modules) {
    const content = M[mod];
    if (content) {
      parts.push('---\n\n' + content);
      moduleNames.push(mod);
    }
  }

  return {
    prompt:  parts.join('\n\n'),
    modules: moduleNames,
  };
}

/** Hot-reload prompts in dev without restart */
export function reloadPrompts() {
  for (const key of Object.keys(M)) {
    const file    = key === 'system' ? 'system.txt' : `${key}.txt`;
    const content = load(file);
    if (content) M[key] = content;
  }
  console.log('[PROMPTS] Reloaded all modules');
}
