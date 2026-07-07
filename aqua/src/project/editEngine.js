/**
 * AQUA Edit Engine (Day 4) — patch-first repository editing.
 *
 * Pipeline (proposeEdit):
 *   1. LOCATE   — reuse the existing retriever scoring + index to pick target
 *                 files; inject their FULL content (index keeps content in
 *                 memory — no rescan, no re-upload).
 *   2. GENERATE — one structured LLM call (via the existing provider router,
 *                 so ranking/fallback/circuit-breaker all apply) that returns
 *                 MINIMAL search/replace operations per file — never whole-file
 *                 regeneration unless the file is being created.
 *   3. APPLY-IN-MEMORY — operations are applied to copies of the indexed
 *                 content. Exact match first, whitespace-tolerant fuzzy match
 *                 second. A failed operation never corrupts anything — it is
 *                 reported with a reason and suggestion.
 *   4. DIFF     — diffEngine produces structured hunks + unified text + stats
 *                 for the preview UI.
 *   5. VERIFY   — deterministic static checks (bracket balance, JSON validity,
 *                 local-import resolution against the index, removed-export
 *                 breakage via the dependency graph). Warnings only when
 *                 confidence is high — no invented issues.
 *   6. RELATE   — dependency graph (whoImports) recommends files that may
 *                 need follow-up changes.
 *
 * Safe apply (applyProposal):
 *   - Proposal must exist and be in 'proposed' state.
 *   - Every target file's CURRENT index content must hash-match the content
 *     the patch was generated against (baseHash). Any mismatch → conflict,
 *     nothing is applied (atomic).
 *   - On success the index + dependency graph + workspace metadata are
 *     rebuilt through the EXISTING buildIndex/buildDependencyGraph/
 *     enrichWithSummaries pipeline — no parallel indexing system.
 *   - Previous contents are retained → revertProposal() restores them.
 *
 * NOTHING here touches disk. The workspace model is in-memory-indexed
 * uploaded source; "apply" means the index (and everything grounded on it —
 * retrieval, chat answers, future patches) now sees the edited code.
 */

import { generateText }          from '../providers/router.js';
import { createContext }         from '../core/observability.js';
import { getFocusRisks }         from '../intelligence/critic.js';
import { getIndex, buildIndex, getIndexStats, syncSummaries } from './projectIndex.js';
import { getWorkspace, updateWorkspace }       from './workspaceManager.js';
import { buildDependencyGraph, whoImports }    from './dependencyGraph.js';
import { enrichWithSummaries }   from './projectSummarizer.js';
import { diffFile }              from './diffEngine.js';
import { v4 as uuidv4 }          from 'uuid';

// ── Proposal store (in-memory, like the index it patches) ────────────────────
// workspaceId → Map<proposalId, proposal>
const proposals = new Map();

const MAX_TARGET_FILES     = 6;
const MAX_PROMPT_CHARS     = 60_000;  // total file content injected into the edit prompt
const MAX_FILE_CHARS       = 24_000;  // single file cap
const EDIT_RESPONSE_BUDGET = { maxResponseTokens: 4096 };

// ── Hashing (conflict detection) ──────────────────────────────────────────────

export function contentHash(str = '') {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0') + ':' + str.length;
}

// ── 1. LOCATE ─────────────────────────────────────────────────────────────────

/**
 * Pick the files most relevant to the instruction and return them with FULL
 * content from the index. Reuses the same signal the retriever uses
 * (path keywords, symbols, imports) — no new scoring system.
 */
export function locateTargetFiles(workspaceId, instruction, limit = MAX_TARGET_FILES) {
  const index = getIndex(workspaceId);
  if (!index) return { files: [], allPaths: [] };

  const words = [...new Set(
    instruction.toLowerCase().split(/[^a-z0-9_$]+/i).filter(w => w.length > 2),
  )];

  const scored = [];
  for (const [path, entry] of index.byPath.entries()) {
    let score = 0;
    const lowerPath = path.toLowerCase();
    for (const w of words) {
      if (lowerPath.includes(w)) score += 4;
      if (index.bySymbol.has(w)) {
        for (const hit of index.bySymbol.get(w)) if (hit.path === path) score += 6;
      }
    }
    // symbol names in the entry that appear in the instruction (case-sensitive identifiers)
    for (const fn of entry.functions ?? []) {
      if (fn.length > 3 && instruction.includes(fn)) score += 8;
    }
    if (entry.content) {
      let contentHits = 0;
      for (const w of words) {
        if (entry.content.toLowerCase().includes(w)) contentHits++;
      }
      score += Math.min(contentHits, 5);
    }
    if (score > 0) scored.push({ path, entry, score });
  }
  scored.sort((a, b) => b.score - a.score);

  let budget = MAX_PROMPT_CHARS;
  const files = [];
  for (const { path, entry, score } of scored) {
    if (files.length >= limit || budget <= 0) break;
    const content = (entry.content ?? '').slice(0, MAX_FILE_CHARS);
    if (!content) continue;
    files.push({ path, lang: entry.lang, content, score });
    budget -= content.length;
  }

  return { files, allPaths: [...index.byPath.keys()] };
}

// ── 2. GENERATE (LLM structured edits) ────────────────────────────────────────

function buildEditSystemPrompt(focusRisks) {
  return [
    'You are AQUA\'s repository editing engine. You produce MINIMAL, SURGICAL edits to an indexed codebase.',
    '',
    'HARD RULES:',
    '- NEVER rewrite a whole existing file. Express changes as small search/replace operations.',
    '- "search" must be copied EXACTLY from the provided file content (including indentation) and must be unique within the file. Use 2–6 lines of surrounding context to make it unique.',
    '- Only edit files whose content was provided. New files may be created with the "create" field.',
    '- Keep the existing code style of each file.',
    '- Prefer the smallest change that fully accomplishes the instruction.',
    `- Pay attention to these risk areas: ${focusRisks.join(', ')}.`,
    '',
    'Respond with ONLY a JSON object (no markdown fences, no prose) in exactly this shape:',
    '{',
    '  "summary": "one-sentence description of the change",',
    '  "reasoning": "why this approach",',
    '  "impact": "expected behavioral impact",',
    '  "risks": ["potential risk", ...],',
    '  "breakingChanges": ["breaking change", ...] ,',
    '  "edits": [',
    '    {',
    '      "file": "path/exactly/as/provided.js",',
    '      "explanation": "why this file changes",',
    '      "operations": [',
    '        { "type": "replace", "search": "exact existing snippet", "replace": "new snippet" },',
    '        { "type": "insert_after", "anchor": "exact existing snippet", "content": "new lines" },',
    '        { "type": "insert_before", "anchor": "exact existing snippet", "content": "new lines" },',
    '        { "type": "append", "content": "lines appended to end of file" }',
    '      ]',
    '    },',
    '    { "file": "path/new-file.js", "explanation": "why created", "create": "full file content" }',
    '  ]',
    '}',
    '',
    'risks and breakingChanges may be empty arrays. Never invent risks that are not real.',
  ].join('\n');
}

function buildEditUserMessage(instruction, files, allPaths) {
  const parts = [
    `EDIT INSTRUCTION:\n${instruction}`,
    '',
    `REPOSITORY FILE LIST (${allPaths.length} files):`,
    allPaths.slice(0, 400).join('\n'),
    '',
    'TARGET FILE CONTENTS:',
  ];
  for (const f of files) {
    parts.push('', `===== FILE: ${f.path} =====`, f.content, `===== END FILE: ${f.path} =====`);
  }
  return parts.join('\n');
}

function parseEditJson(text) {
  let t = (text ?? '').trim();
  // strip markdown fences if the model added them anyway
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const first = t.indexOf('{');
  const last  = t.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new Error('Model did not return a JSON edit object');
  }
  const parsed = JSON.parse(t.slice(first, last + 1));
  if (!Array.isArray(parsed.edits) || !parsed.edits.length) {
    throw new Error('Edit object contains no edits');
  }
  return parsed;
}

// ── 3. APPLY OPERATIONS IN MEMORY ────────────────────────────────────────────

/**
 * Locate `search` inside `content`. Exact indexOf first; if that fails, a
 * line-window fuzzy match that ignores leading/trailing whitespace per line
 * (LLMs most often get indentation subtly wrong). Must be unique either way.
 *
 * @returns {{ start, end } | { error }}
 */
export function findSnippet(content, search) {
  if (!search) return { error: 'empty search snippet' };

  // exact
  const first = content.indexOf(search);
  if (first !== -1) {
    if (content.indexOf(search, first + 1) !== -1) {
      return { error: 'search snippet is not unique in file (exact match)' };
    }
    return { start: first, end: first + search.length };
  }

  // fuzzy: match by trimmed lines
  const contentLines = content.split('\n');
  const searchLines  = search.split('\n').map(l => l.trim());
  while (searchLines.length && searchLines[0] === '') searchLines.shift();
  while (searchLines.length && searchLines[searchLines.length - 1] === '') searchLines.pop();
  if (!searchLines.length) return { error: 'empty search snippet' };

  const matches = [];
  outer:
  for (let i = 0; i + searchLines.length <= contentLines.length; i++) {
    for (let j = 0; j < searchLines.length; j++) {
      if (contentLines[i + j].trim() !== searchLines[j]) continue outer;
    }
    matches.push(i);
  }
  if (!matches.length) return { error: 'search snippet not found in file' };
  if (matches.length > 1) return { error: 'search snippet is not unique in file (fuzzy match)' };

  const lineStart = matches[0];
  const start = contentLines.slice(0, lineStart).join('\n').length + (lineStart > 0 ? 1 : 0);
  const matchedBlock = contentLines.slice(lineStart, lineStart + searchLines.length).join('\n');
  return { start, end: start + matchedBlock.length, fuzzy: true, matchedBlock };
}

/**
 * Apply one operation. Returns { content } or { error }.
 */
export function applyOperation(content, op) {
  switch (op.type) {
    case 'replace': {
      const loc = findSnippet(content, op.search ?? '');
      if (loc.error) return { error: `replace: ${loc.error}` };
      return { content: content.slice(0, loc.start) + (op.replace ?? '') + content.slice(loc.end), fuzzy: loc.fuzzy };
    }
    case 'insert_after': {
      const loc = findSnippet(content, op.anchor ?? '');
      if (loc.error) return { error: `insert_after: ${loc.error}` };
      const insert = op.content?.startsWith('\n') ? op.content : '\n' + (op.content ?? '');
      return { content: content.slice(0, loc.end) + insert + content.slice(loc.end), fuzzy: loc.fuzzy };
    }
    case 'insert_before': {
      const loc = findSnippet(content, op.anchor ?? '');
      if (loc.error) return { error: `insert_before: ${loc.error}` };
      const insert = op.content?.endsWith('\n') ? op.content : (op.content ?? '') + '\n';
      return { content: content.slice(0, loc.start) + insert + content.slice(loc.start), fuzzy: loc.fuzzy };
    }
    case 'append': {
      const sep = content.endsWith('\n') ? '' : '\n';
      return { content: content + sep + (op.content ?? '') };
    }
    default:
      return { error: `unknown operation type "${op.type}"` };
  }
}

// ── 5. STATIC VERIFICATION ────────────────────────────────────────────────────

const JS_LANGS = new Set(['javascript', 'typescript', 'js', 'ts', 'jsx', 'tsx']);

/** Bracket balance ignoring strings/template literals/comments (heuristic, JS-family). */
export function checkBrackets(source) {
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  let i = 0, mode = null; // mode: '"' | "'" | '`' | '//' | '/*'
  while (i < source.length) {
    const ch = source[i], next = source[i + 1];
    if (mode === '//') { if (ch === '\n') mode = null; i++; continue; }
    if (mode === '/*') { if (ch === '*' && next === '/') { mode = null; i += 2; continue; } i++; continue; }
    if (mode === '"' || mode === "'" || mode === '`') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === mode) mode = null;
      i++; continue;
    }
    if (ch === '/' && next === '/') { mode = '//'; i += 2; continue; }
    if (ch === '/' && next === '*') { mode = '/*'; i += 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { mode = ch; i++; continue; }
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.pop() !== pairs[ch]) return { balanced: false, detail: `unmatched "${ch}"` };
    }
    i++;
  }
  if (stack.length) return { balanced: false, detail: `unclosed "${stack[stack.length - 1]}"` };
  return { balanced: true };
}

function extractLocalImports(source) {
  const out = [];
  const re = /(?:import\s[^'"]*?from\s*|import\s*\(|require\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(source))) out.push(m[1]);
  return out;
}

function resolveLocalImport(fromPath, spec, pathSet) {
  const baseDir = fromPath.split('/').slice(0, -1);
  const segs = spec.split('/');
  const stack = [...baseDir];
  for (const s of segs) {
    if (s === '.') continue;
    else if (s === '..') stack.pop();
    else stack.push(s);
  }
  const resolved = stack.join('/');
  const candidates = [
    resolved,
    `${resolved}.js`, `${resolved}.ts`, `${resolved}.jsx`, `${resolved}.tsx`, `${resolved}.mjs`,
    `${resolved}/index.js`, `${resolved}/index.ts`,
  ];
  return candidates.some(c => pathSet.has(c));
}

/**
 * Deterministic checks on the post-edit file set. Only high-confidence
 * findings are reported — no speculation.
 */
export function verifyProposedFiles(workspaceId, fileChanges) {
  const index = getIndex(workspaceId);
  const checks = [];
  const warnings = [];

  const pathSet = new Set(index ? [...index.byPath.keys()] : []);
  for (const fc of fileChanges) {
    if (fc.changeType === 'create') pathSet.add(fc.path);
    if (fc.changeType === 'delete') pathSet.delete(fc.path);
  }

  for (const fc of fileChanges) {
    if (fc.changeType === 'delete') continue;
    const src = fc.modified;

    // syntax-ish: bracket balance for JS-family, JSON.parse for JSON
    if (fc.path.endsWith('.json')) {
      try {
        JSON.parse(src);
        checks.push({ id: `json:${fc.path}`, label: `${fc.path}: valid JSON`, status: 'pass' });
      } catch (e) {
        checks.push({ id: `json:${fc.path}`, label: `${fc.path}: invalid JSON`, status: 'fail', detail: e.message });
        warnings.push(`${fc.path} would no longer parse as JSON: ${e.message}`);
      }
    } else if (JS_LANGS.has((fc.lang ?? '').toLowerCase()) || /\.(m?js|ts|jsx|tsx)$/.test(fc.path)) {
      const b = checkBrackets(src);
      checks.push({
        id: `brackets:${fc.path}`,
        label: `${fc.path}: brackets ${b.balanced ? 'balanced' : 'UNBALANCED'}`,
        status: b.balanced ? 'pass' : 'fail',
        ...(b.detail ? { detail: b.detail } : {}),
      });
      if (!b.balanced) warnings.push(`${fc.path}: ${b.detail} — likely syntax error`);

      // local imports resolve
      const unresolved = extractLocalImports(src).filter(s => !resolveLocalImport(fc.path, s, pathSet));
      if (unresolved.length) {
        checks.push({ id: `imports:${fc.path}`, label: `${fc.path}: unresolved local imports`, status: 'fail', detail: unresolved.join(', ') });
        warnings.push(`${fc.path} imports missing local module(s): ${unresolved.join(', ')}`);
      } else {
        checks.push({ id: `imports:${fc.path}`, label: `${fc.path}: local imports resolve`, status: 'pass' });
      }
    }

    // removed exports still imported elsewhere → broken references
    if (fc.changeType === 'modify' && index) {
      const entry = index.byPath.get(fc.path);
      const oldExports = new Set(entry?.exports ?? []);
      if (oldExports.size) {
        const removed = [...oldExports].filter(name =>
          name && name.length > 1 &&
          !new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(src),
        );
        const importers = whoImports(workspaceId, fc.path) ?? [];
        if (removed.length && importers.length) {
          const affected = importers.filter(imp => {
            const impEntry = index.byPath.get(imp);
            return impEntry?.content && removed.some(r => impEntry.content.includes(r));
          });
          if (affected.length) {
            const detail = `removed export(s) ${removed.join(', ')} still referenced by ${affected.join(', ')}`;
            checks.push({ id: `refs:${fc.path}`, label: `${fc.path}: broken references`, status: 'fail', detail });
            warnings.push(detail);
          }
        }
      }
    }
  }

  const failed = checks.some(c => c.status === 'fail');
  return { ran: true, passed: !failed, checks, warnings };
}

// ── 6. RELATED FILES ──────────────────────────────────────────────────────────

function findRelatedFiles(workspaceId, editedPaths) {
  const edited = new Set(editedPaths);
  const related = new Map(); // path → reason
  for (const p of editedPaths) {
    for (const importer of whoImports(workspaceId, p) ?? []) {
      if (!edited.has(importer) && !related.has(importer)) {
        related.set(importer, `imports ${p}`);
      }
    }
  }
  return [...related.entries()].map(([path, reason]) => ({ path, reason })).slice(0, 8);
}

// ── PUBLIC: propose ───────────────────────────────────────────────────────────

/**
 * Generate a patch proposal for an instruction against an indexed workspace.
 * Never mutates the index. Returns a full proposal object (also stored for
 * later apply/reject).
 *
 * @param {{ workspaceId, instruction, requestId?, conversationId?, onStage? }} input
 */
export async function proposeEdit({ workspaceId, instruction, requestId, conversationId, onStage = () => {} }) {
  const workspace = getWorkspace(workspaceId);
  const index = getIndex(workspaceId);
  if (!workspace) throw Object.assign(new Error('Workspace not found'), { code: 'NO_WORKSPACE' });
  if (!index || workspace.indexStatus !== 'indexed') {
    throw Object.assign(
      new Error(`Workspace is not indexed (status: ${workspace.indexStatus}). Upload files first — patch editing works on the in-memory index, which is rebuilt on upload (and cleared on server restart).`),
      { code: 'NOT_INDEXED' },
    );
  }

  // 1. Locate
  onStage('edit_locate', 'Locating relevant files…');
  const { files: targetFiles, allPaths } = locateTargetFiles(workspaceId, instruction);
  if (!targetFiles.length) {
    throw Object.assign(
      new Error('Could not locate any files relevant to that instruction. Try naming a file, function, or module explicitly.'),
      { code: 'NO_TARGETS' },
    );
  }
  console.log(`[EDIT] targets=[${targetFiles.map(f => f.path).join(', ')}] workspace=${workspaceId}`);

  // 2. Generate structured edits — one LLM call through the existing router
  onStage('edit_generate', 'Generating minimal patch…');
  const focusRisks = getFocusRisks('coding');
  const editCtx = createContext({ conversationId, requestId: requestId ? `${requestId}-edit` : undefined });
  const start = Date.now();
  const result = await generateText(
    instruction,
    buildEditSystemPrompt(focusRisks),
    [{ role: 'user', content: buildEditUserMessage(instruction, targetFiles, allPaths) }],
    editCtx,
    'coding',                 // real task type → provider ranking favors coding-strong providers
    undefined,
    EDIT_RESPONSE_BUDGET,
  );

  let editPlan;
  try {
    editPlan = parseEditJson(result.text);
  } catch (err) {
    throw Object.assign(
      new Error(`The model's edit plan could not be parsed (${err.message}). Try rephrasing the instruction more specifically.`),
      { code: 'BAD_EDIT_PLAN' },
    );
  }

  // 3. Apply in memory
  const fileChanges = [];
  const failedOperations = [];
  for (const edit of editPlan.edits) {
    const path = edit.file;
    const entry = index.byPath.get(path);

    if (edit.create != null) {
      if (entry) {
        failedOperations.push({ file: path, error: 'create requested but file already exists', suggestion: 'Use replace operations to modify existing files.' });
        continue;
      }
      fileChanges.push({
        path,
        changeType: 'create',
        explanation: edit.explanation ?? '',
        lang: path.split('.').pop(),
        original: '',
        modified: String(edit.create),
        baseHash: contentHash(''),
        appliedOps: 1,
      });
      continue;
    }

    if (!entry?.content) {
      failedOperations.push({ file: path, error: 'file not found in workspace index', suggestion: 'Only indexed files can be edited. Check the path against the file list.' });
      continue;
    }

    let content = entry.content;
    let applied = 0;
    let fuzzyUsed = false;
    let opFailed = false;
    for (const op of edit.operations ?? []) {
      const res = applyOperation(content, op);
      if (res.error) {
        failedOperations.push({
          file: path,
          error: res.error,
          operation: op.type,
          suggestion: 'The snippet the model targeted has probably drifted. Re-ask with more specific context, or apply the remaining files and handle this one manually.',
        });
        opFailed = true;
        continue; // skip this op, keep others for the file
      }
      content = res.content;
      if (res.fuzzy) fuzzyUsed = true;
      applied++;
    }
    if (!applied) {
      if (!opFailed) failedOperations.push({ file: path, error: 'edit contained no operations', suggestion: 'Model returned an empty operation list for this file.' });
      continue;
    }
    fileChanges.push({
      path,
      changeType: 'modify',
      explanation: edit.explanation ?? '',
      lang: entry.lang,
      original: entry.content,
      modified: content,
      baseHash: contentHash(entry.content),
      appliedOps: applied,
      fuzzyMatched: fuzzyUsed,
    });
  }

  if (!fileChanges.length) {
    const reasons = failedOperations.map(f => `${f.file}: ${f.error}`).join('; ');
    throw Object.assign(
      new Error(`No operations could be applied. ${reasons || 'The model produced an unusable edit plan.'}`),
      { code: 'ALL_OPS_FAILED', failedOperations },
    );
  }

  // 4. Diff
  onStage('edit_diff', 'Building diff preview…');
  for (const fc of fileChanges) {
    fc.diff = diffFile(fc.path, fc.original, fc.modified);
  }

  // 5. Verify
  onStage('edit_verify', 'Running static verification…');
  const verification = verifyProposedFiles(workspaceId, fileChanges);

  // 6. Related files
  const relatedFiles = findRelatedFiles(workspaceId, fileChanges.map(f => f.path));

  const totals = fileChanges.reduce(
    (acc, fc) => ({ added: acc.added + fc.diff.stats.added, removed: acc.removed + fc.diff.stats.removed }),
    { added: 0, removed: 0 },
  );

  const proposal = {
    id: uuidv4(),
    workspaceId,
    createdAt: Date.now(),
    status: 'proposed',
    instruction,
    summary:          editPlan.summary ?? 'Proposed change',
    reasoning:        editPlan.reasoning ?? '',
    impact:           editPlan.impact ?? '',
    risks:            Array.isArray(editPlan.risks) ? editPlan.risks : [],
    breakingChanges:  Array.isArray(editPlan.breakingChanges) ? editPlan.breakingChanges : [],
    relatedFiles,
    files: fileChanges,
    failedOperations,
    stats: { filesChanged: fileChanges.length, added: totals.added, removed: totals.removed },
    verification,
    provider:  result.provider,
    latencyMs: Date.now() - start,
  };

  if (!proposals.has(workspaceId)) proposals.set(workspaceId, new Map());
  proposals.get(workspaceId).set(proposal.id, proposal);
  console.log(`[EDIT] proposal=${proposal.id} files=${fileChanges.length} +${totals.added} -${totals.removed} verified=${verification.passed} workspace=${workspaceId}`);

  return proposal;
}

/** Test-only: register a handcrafted proposal (tests exercise apply/conflict/revert without an LLM). */
export function __registerProposalForTests(p) {
  if (!proposals.has(p.workspaceId)) proposals.set(p.workspaceId, new Map());
  proposals.get(p.workspaceId).set(p.id, p);
}

// ── PUBLIC: read / reject ─────────────────────────────────────────────────────

export function getProposal(workspaceId, proposalId) {
  return proposals.get(workspaceId)?.get(proposalId) ?? null;
}

export function listProposals(workspaceId) {
  return [...(proposals.get(workspaceId)?.values() ?? [])]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(serializeProposalSummary);
}

export function rejectProposal(workspaceId, proposalId) {
  const p = getProposal(workspaceId, proposalId);
  if (!p) return { ok: false, error: 'Proposal not found' };
  if (p.status !== 'proposed') return { ok: false, error: `Proposal already ${p.status}` };
  p.status = 'rejected';
  p.resolvedAt = Date.now();
  return { ok: true, proposal: serializeProposalSummary(p) };
}

// ── PUBLIC: safe apply ────────────────────────────────────────────────────────

/**
 * Atomically apply a proposal to the workspace index. Conflict-checked:
 * if ANY target file's current content differs from what the patch was
 * generated against, nothing is applied.
 */
export function applyProposal(workspaceId, proposalId) {
  const workspace = getWorkspace(workspaceId);
  const index = getIndex(workspaceId);
  const p = getProposal(workspaceId, proposalId);

  if (!p) return { ok: false, error: 'Proposal not found' };
  if (p.status !== 'proposed') return { ok: false, error: `Proposal already ${p.status} — generate a fresh patch.` };
  if (!workspace || !index) return { ok: false, error: 'Workspace index unavailable (server may have restarted). Re-upload the project and regenerate the patch.' };

  // 1. Validate every target cleanly applies
  const conflicts = [];
  for (const fc of p.files) {
    const entry = index.byPath.get(fc.path);
    if (fc.changeType === 'create') {
      if (entry) conflicts.push({ file: fc.path, reason: 'file was created since this patch was generated' });
      continue;
    }
    if (!entry) {
      conflicts.push({ file: fc.path, reason: 'file no longer exists in the index' });
      continue;
    }
    if (contentHash(entry.content) !== fc.baseHash) {
      conflicts.push({ file: fc.path, reason: 'file changed since this patch was generated' });
    }
  }
  if (conflicts.length) {
    return {
      ok: false,
      error: 'Patch does not apply cleanly — the workspace changed underneath it.',
      conflicts,
      suggestion: 'Regenerate the patch against the current workspace state.',
    };
  }

  // 2. Build the post-apply file set from the CURRENT index (all files carry content)
  const previousContents = [];
  const nextFiles = [];
  const changedPaths = new Set(p.files.map(f => f.path));
  for (const [path, entry] of index.byPath.entries()) {
    if (changedPaths.has(path)) continue;
    nextFiles.push({ path, content: entry.content, lang: entry.lang, size: entry.size, truncated: entry.truncated, summary: entry.summary });
  }
  for (const fc of p.files) {
    const entry = index.byPath.get(fc.path);
    previousContents.push({ path: fc.path, content: entry?.content ?? null }); // null → file did not exist
    if (fc.changeType === 'delete') continue;
    nextFiles.push({
      path: fc.path,
      content: fc.modified,
      lang: fc.lang ?? entry?.lang ?? 'unknown',
      size: fc.modified.length,
      truncated: false,
    });
  }

  // 3. Rebuild index + summaries + dependency graph through the EXISTING pipeline
  buildIndex(workspaceId, nextFiles);
  const parsedEntries = [...getIndex(workspaceId).byPath.values()];
  const enriched = enrichWithSummaries(parsedEntries);
  const liveIndex = getIndex(workspaceId);
  for (const f of enriched) {
    const entry = liveIndex.byPath.get(f.path);
    if (entry) entry.summary = f.summary;
  }
  syncSummaries(workspaceId, enriched);
  buildDependencyGraph(workspaceId, enriched);

  // 4. Refresh persisted workspace metadata (no raw content — unchanged policy)
  const fileMetadata = enriched.map(f => ({
    path: f.path, lang: f.lang, size: f.size, summary: f.summary, parsedAt: Date.now(),
  }));
  const languages = {};
  for (const f of enriched) languages[f.lang] = (languages[f.lang] ?? 0) + 1;
  updateWorkspace(workspaceId, {
    files: fileMetadata,
    stats: { files: enriched.length, languages },
    lastPatchAppliedAt: Date.now(),
  });

  p.status = 'applied';
  p.resolvedAt = Date.now();
  p.previousContents = previousContents;

  console.log(`[EDIT] proposal=${proposalId} APPLIED files=${p.files.length} workspace=${workspaceId}`);
  return { ok: true, proposal: serializeProposalSummary(p), indexStats: getIndexStats(workspaceId) };
}

/** Restore the pre-apply contents of an applied proposal. */
export function revertProposal(workspaceId, proposalId) {
  const index = getIndex(workspaceId);
  const p = getProposal(workspaceId, proposalId);
  if (!p) return { ok: false, error: 'Proposal not found' };
  if (p.status !== 'applied') return { ok: false, error: `Only applied proposals can be reverted (status: ${p.status})` };
  if (!index) return { ok: false, error: 'Workspace index unavailable.' };

  const restoreMap = new Map(p.previousContents.map(pc => [pc.path, pc.content]));
  const nextFiles = [];
  for (const [path, entry] of index.byPath.entries()) {
    if (restoreMap.has(path)) {
      const prev = restoreMap.get(path);
      if (prev === null) continue; // file was created by the patch → drop it
      nextFiles.push({ path, content: prev, lang: entry.lang, size: prev.length, truncated: false });
      restoreMap.delete(path);
    } else {
      nextFiles.push({ path, content: entry.content, lang: entry.lang, size: entry.size, truncated: entry.truncated, summary: entry.summary });
    }
  }
  // files deleted by the patch that need restoring
  for (const [path, prev] of restoreMap.entries()) {
    if (prev !== null) nextFiles.push({ path, content: prev, lang: path.split('.').pop(), size: prev.length, truncated: false });
  }

  buildIndex(workspaceId, nextFiles);
  const enriched = enrichWithSummaries([...getIndex(workspaceId).byPath.values()]);
  buildDependencyGraph(workspaceId, enriched);

  p.status = 'reverted';
  console.log(`[EDIT] proposal=${proposalId} REVERTED workspace=${workspaceId}`);
  return { ok: true, proposal: serializeProposalSummary(p) };
}

// ── Serialization ─────────────────────────────────────────────────────────────

/** Wire-format proposal — original/modified content stripped (diff carries everything the UI needs). */
export function serializeProposal(p) {
  return {
    id: p.id,
    workspaceId: p.workspaceId,
    createdAt: p.createdAt,
    status: p.status,
    instruction: p.instruction,
    summary: p.summary,
    reasoning: p.reasoning,
    impact: p.impact,
    risks: p.risks,
    breakingChanges: p.breakingChanges,
    relatedFiles: p.relatedFiles,
    failedOperations: p.failedOperations,
    stats: p.stats,
    verification: p.verification,
    provider: p.provider,
    latencyMs: p.latencyMs,
    files: p.files.map(fc => ({
      path: fc.path,
      changeType: fc.changeType,
      explanation: fc.explanation,
      lang: fc.lang,
      appliedOps: fc.appliedOps,
      fuzzyMatched: fc.fuzzyMatched ?? false,
      stats: fc.diff.stats,
      totalOldLines: fc.diff.totalOldLines,
      totalNewLines: fc.diff.totalNewLines,
      hunks: fc.diff.hunks,
      unified: fc.diff.unified,
    })),
  };
}

export function serializeProposalSummary(p) {
  return {
    id: p.id,
    workspaceId: p.workspaceId,
    createdAt: p.createdAt,
    resolvedAt: p.resolvedAt,
    status: p.status,
    instruction: p.instruction,
    summary: p.summary,
    stats: p.stats,
    verificationPassed: p.verification?.passed ?? null,
    files: p.files.map(fc => ({ path: fc.path, changeType: fc.changeType, stats: fc.diff.stats })),
  };
}