/**
 * AQUA Patch Generator
 *
 * Formats proposed multi-file changes as structured patch objects.
 * Generates unified-diff-style output for readability.
 *
 * NEVER modifies files automatically. Output is review-only.
 */

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Format a proposed change set.
 *
 * @param {{ description, reasoning, changes: Array<{file, original?, modified, explanation}> }} proposal
 * @returns {PatchResult}
 */
export function formatPatch(proposal) {
  const { description, reasoning, changes = [] } = proposal;

  const patches = changes.map(ch => ({
    file:        ch.file,
    explanation: ch.explanation ?? '',
    diff:        _diff(ch.file, ch.original ?? '', ch.modified ?? ''),
  }));

  return {
    description,
    reasoning,
    filesAffected: patches.map(p => p.file),
    patches,
    note: 'Proposed change — review carefully before applying.',
  };
}

/**
 * Render a PatchResult as a Markdown block for inclusion in LLM responses.
 */
export function formatPatchForPrompt(patchResult) {
  if (!patchResult?.patches?.length) return '';

  const lines = [
    '## Proposed Changes',
    `**${patchResult.description}**`,
    '',
    `**Reasoning:** ${patchResult.reasoning}`,
    `**Files affected:** ${patchResult.filesAffected.join(', ')}`,
  ];

  for (const p of patchResult.patches) {
    lines.push('', `### ${p.file}`);
    if (p.explanation) lines.push(p.explanation);
    lines.push('```diff', p.diff, '```');
  }

  lines.push('', `> ⚠️ ${patchResult.note}`);
  return lines.join('\n');
}

// ── Diff generation ───────────────────────────────────────────────────────────
// Day 4: delegates to diffEngine.js (real LCS + hunks) instead of the old
// greedy 4-line-lookahead scan. Same unified-diff output contract.

import { diffFile } from './diffEngine.js';

function _diff(filename, original, modified) {
  const d = diffFile(filename, original ?? '', modified ?? '');
  if (!d.stats.added && !d.stats.removed) return `// No changes in ${filename}`;
  return d.unified;
}
