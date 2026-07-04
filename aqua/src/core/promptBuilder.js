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
 * @returns {{ prompt: string, modules: string[] }}
 */
export function buildSystemPrompt(taskType, memoryBlock = '', reasoningDirective = '', projectContext = '', intelligenceBlock = '') {
  const modules     = MODULE_MAP[taskType] ?? [];
  const parts       = [M.system];
  const moduleNames = ['system'];

  // Inject memory block right after identity — before task instructions
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

  // Phase 5: project context — injected after reasoning directive
  if (projectContext && projectContext.trim()) {
    parts.push(projectContext.trim());
    moduleNames.push('project_context');
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
