/**
 * AQUA Project Intelligence Engine — HTTP Routes
 *
 * POST   /project/workspace                — create workspace
 * POST   /project/workspace/:id/files      — upload + ingest files
 * GET    /project/workspace/:id            — status + stats
 * GET    /project/workspace/:id/files      — list indexed files
 * GET    /project/workspace/:id/graph      — dependency graph
 * POST   /project/workspace/:id/query      — query index
 * DELETE /project/workspace/:id            — delete workspace
 * GET    /project/workspaces               — list all workspaces
 *
 * File upload format (JSON body):
 *   { files: [{ path: string, content: string, encoding?: 'base64' }] } — raw files array
 *   { zip: "<base64>" }                                                 — base64-encoded ZIP
 *
 * encoding: 'base64' marks binary document formats (.pdf/.docx/.pptx/.xlsx)
 * — content is their raw bytes, base64-encoded, not UTF-8 text. Omit it
 * (or omit the field) for ordinary text/code files — unchanged, exactly
 * as before. See project/fileIngester.js + project/documentParser.js.
 */
import express from 'express';
import { createWorkspace, getWorkspace, updateWorkspace, deleteWorkspace, listWorkspaces } from '../project/workspaceManager.js';
import { extractZip }                                                                      from '../project/fileIngester.js';
import { runWorkspaceIngestion }                                                           from '../project/ingestionPipeline.js';
import { getIndex, getIndexStats, queryIndex }                                             from '../project/projectIndex.js';
import { serializeGraph, detectCycles }                                                    from '../project/dependencyGraph.js';
import { formatPatch }                                                                     from '../project/patchGenerator.js';
import {
  proposeEdit, getProposal, listProposals, applyProposal, rejectProposal, revertProposal,
  serializeProposal,
} from '../project/editEngine.js';
import { whoImports, whatImports } from '../project/dependencyGraph.js';

import { resolveOwner, rememberWorkspace } from '../memory/engine.js';

const router = express.Router();

// ── Create workspace ──────────────────────────────────────────────────────────

router.post('/workspace', (req, res) => {
  const { name, description } = req.body ?? {};
  const ownerId = resolveOwner({ userId: req.aquaUserId ?? null, conversationId: req.body?.conversationId ?? null });
  const workspace = createWorkspace({ name, description, ownerId });
  rememberWorkspace(ownerId, workspace);
  res.json({
    success:   true,
    workspace: { id: workspace.id, createdAt: workspace.createdAt, indexStatus: workspace.indexStatus },
  });
});

// ── Upload + ingest files ─────────────────────────────────────────────────────

router.post('/workspace/:id/files', async (req, res) => {
  const { id } = req.params;
  const workspace = getWorkspace(id);
  if (!workspace) return res.status(404).json({ success: false, error: 'Workspace not found' });

  const { files, zip } = req.body ?? {};
  let rawFiles = [];

  if (zip) {
    try {
      rawFiles = await extractZip(zip);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  } else if (Array.isArray(files)) {
    rawFiles = files;
  } else {
    return res.status(400).json({
      success: false,
      error:   'Provide "files": [{ path, content }] or "zip": "<base64>"',
    });
  }

  // Day 5: the pipeline (ingest → index → summarize → graph → analyze →
  // persist) is now the shared runWorkspaceIngestion() in
  // project/ingestionPipeline.js — identical behavior, one implementation,
  // also used by the unified /upload endpoint. Error semantics preserved:
  // any failure marks the workspace 'failed' (retryable) and returns
  // structured JSON.
  try {
    const result = await runWorkspaceIngestion(id, rawFiles);
    res.json({ success: true, workspaceId: id, ...result });
  } catch (err) {
    if (err.code === 'NO_VALID_FILES') {
      return res.status(400).json({ success: false, error: err.message });
    }
    res.status(500).json({
      success: false,
      workspaceId: id,
      error: `Indexing failed: ${err.message}. The workspace was marked failed — you can retry the upload.`,
    });
  }
});

// ── Workspace status ──────────────────────────────────────────────────────────

router.get('/workspace/:id', (req, res) => {
  const workspace = getWorkspace(req.params.id);
  if (!workspace) return res.status(404).json({ success: false, error: 'Workspace not found' });
  res.json({ success: true, workspace: { ...workspace, indexStats: getIndexStats(req.params.id) } });
});

// ── File list ─────────────────────────────────────────────────────────────────

router.get('/workspace/:id/files', (req, res) => {
  const workspace = getWorkspace(req.params.id);
  if (!workspace) return res.status(404).json({ success: false, error: 'Workspace not found' });
  res.json({ success: true, workspaceId: req.params.id, files: workspace.files });
});

// ── Workspace overview (cached intelligence) ──────────────────────────────────
// Generated once at index time; this endpoint only serves the cache.
// Overview cannot be regenerated post-upload (raw content is not persisted).

router.get('/workspace/:id/overview', (req, res) => {
  const workspace = getWorkspace(req.params.id);
  if (!workspace) return res.status(404).json({ success: false, error: 'Workspace not found' });

  if (!workspace.overview) {
    return res.status(200).json({
      success:  true,
      workspaceId: req.params.id,
      overview: null,
      note: workspace.indexStatus === 'indexed'
        ? 'This workspace was indexed before overview generation existed. Re-upload to generate one.'
        : `Workspace not yet indexed (status: ${workspace.indexStatus}).`,
    });
  }
  res.json({ success: true, workspaceId: req.params.id, overview: workspace.overview });
});

// ── Dependency graph ──────────────────────────────────────────────────────────

router.get('/workspace/:id/graph', (req, res) => {
  const workspace = getWorkspace(req.params.id);
  if (!workspace) return res.status(404).json({ success: false, error: 'Workspace not found' });
  const graph  = serializeGraph(req.params.id);
  const cycles = detectCycles(req.params.id);
  res.json({ success: true, workspaceId: req.params.id, graph, cycles });
});

// ── Index query ───────────────────────────────────────────────────────────────

router.post('/workspace/:id/query', (req, res) => {
  const workspace = getWorkspace(req.params.id);
  if (!workspace) return res.status(404).json({ success: false, error: 'Workspace not found' });

  const { symbol, keyword, importModule, filePath } = req.body ?? {};
  const results = queryIndex(req.params.id, { symbol, keyword, importModule, filePath });

  res.json({
    success:     true,
    workspaceId: req.params.id,
    results: {
      files:   results.files.map(f => ({ path: f.path, lang: f.lang, summary: f.summary, functions: f.functions })),
      symbols: results.symbols,
      imports: results.imports,
    },
  });
});

// ── List all workspaces ───────────────────────────────────────────────────────

router.get('/workspaces', (req, res) => {
  const workspaces = listWorkspaces();
  res.json({
    success:    true,
    count:      workspaces.length,
    workspaces: workspaces.map(ws => ({
      id:          ws.id,
      projectType: ws.projectType,
      indexStatus: ws.indexStatus,
      fileCount:   ws.files?.length ?? 0,
      createdAt:   ws.createdAt,
      meta:        ws.meta,
    })),
  });
});

// ── Delete workspace ──────────────────────────────────────────────────────────

router.delete('/workspace/:id', (req, res) => {
  const deleted = deleteWorkspace(req.params.id);
  if (!deleted) return res.status(404).json({ success: false, error: 'Workspace not found' });
  res.json({ success: true, deleted: req.params.id });
});

// ── File content fetch ────────────────────────────────────────────────────────
// GET /project/workspace/:id/file-content?path=src/foo.js

router.get('/workspace/:id/file-content', (req, res) => {
  const workspace = getWorkspace(req.params.id);
  if (!workspace) return res.status(404).json({ success: false, error: 'Workspace not found' });

  const { path: filePath } = req.query;
  if (!filePath) return res.status(400).json({ success: false, error: 'Query param ?path= required' });

  // Day 4 fix: the in-memory index HAS full content (index.byPath entries carry
  // it — retrieval and patch editing both depend on that). Serve it when the
  // index is live so file navigation ("open this referenced file") works.
  // Persisted workspace records still store metadata only, unchanged.
  const index = getIndex(req.params.id);
  const entry = index?.byPath.get(filePath);
  if (entry) {
    return res.json({
      success:     true,
      workspaceId: req.params.id,
      file: {
        path:      filePath,
        lang:      entry.lang,
        size:      entry.size,
        summary:   entry.summary,
        content:   entry.content,
        functions: entry.functions ?? [],
        exports:   entry.exports ?? [],
        imports:   entry.imports ?? [],
        importedBy: whoImports(req.params.id, filePath),
        importsFiles: whatImports(req.params.id, filePath),
      },
    });
  }

  const meta = workspace.files?.find(f => f.path === filePath);
  if (!meta) {
    return res.status(404).json({ success: false, error: `File '${filePath}' not in index` });
  }
  // Index gone (server restarted) — metadata only.
  res.json({
    success:     true,
    workspaceId: req.params.id,
    file:        meta,
    note:        'Index is not live (server restarted since upload). Re-upload to restore file content.',
  });
});

// ── Patch proposal ────────────────────────────────────────────────────────────
// POST /project/workspace/:id/patch
// Body: { description, reasoning, changes: [{ file, original?, modified, explanation }] }

router.post('/workspace/:id/patch', (req, res) => {
  const workspace = getWorkspace(req.params.id);
  if (!workspace) return res.status(404).json({ success: false, error: 'Workspace not found' });

  const { description, reasoning, changes } = req.body ?? {};
  if (!Array.isArray(changes) || !changes.length) {
    return res.status(400).json({
      success: false,
      error: 'Body must include { description, reasoning, changes: [...] }',
    });
  }

  const patch = formatPatch({ description, reasoning, changes });
  res.json({ success: true, workspaceId: req.params.id, patch });
});

// ══════════════════════════════════════════════════════════════════════════════
// Day 4 — Patch-First Editing
// ══════════════════════════════════════════════════════════════════════════════

// ── Propose an edit ───────────────────────────────────────────────────────────
// POST /project/workspace/:id/edit   Body: { instruction }
// Runs the full pipeline: locate → LLM minimal edits → in-memory apply →
// diff → static verify → related-file recommendations. NOTHING is applied.

router.post('/workspace/:id/edit', async (req, res) => {
  const { instruction } = req.body ?? {};
  if (!instruction || typeof instruction !== 'string' || !instruction.trim()) {
    return res.status(400).json({ success: false, error: 'Body must include a non-empty "instruction" string' });
  }
  try {
    const proposal = await proposeEdit({ workspaceId: req.params.id, instruction: instruction.trim() });
    res.json({ success: true, workspaceId: req.params.id, proposal: serializeProposal(proposal) });
  } catch (err) {
    const status = err.code === 'NO_WORKSPACE' ? 404
                 : err.code === 'NOT_INDEXED' || err.code === 'NO_TARGETS' || err.code === 'BAD_EDIT_PLAN' || err.code === 'ALL_OPS_FAILED' ? 422
                 : 500;
    console.error(`[EDIT] proposal failed workspace=${req.params.id}:`, err.message);
    res.status(status).json({ success: false, error: err.message, code: err.code ?? 'EDIT_FAILED', failedOperations: err.failedOperations ?? [] });
  }
});

// ── List / fetch proposals ────────────────────────────────────────────────────

router.get('/workspace/:id/edits', (req, res) => {
  res.json({ success: true, workspaceId: req.params.id, proposals: listProposals(req.params.id) });
});

router.get('/workspace/:id/edit/:proposalId', (req, res) => {
  const p = getProposal(req.params.id, req.params.proposalId);
  if (!p) return res.status(404).json({ success: false, error: 'Proposal not found' });
  res.json({ success: true, workspaceId: req.params.id, proposal: serializeProposal(p) });
});

// ── Apply (safe, atomic, conflict-checked) ────────────────────────────────────

router.post('/workspace/:id/edit/:proposalId/apply', (req, res) => {
  const result = applyProposal(req.params.id, req.params.proposalId);
  if (!result.ok) {
    return res.status(result.conflicts ? 409 : 400).json({
      success: false, error: result.error,
      ...(result.conflicts ? { conflicts: result.conflicts, suggestion: result.suggestion } : {}),
    });
  }
  res.json({ success: true, workspaceId: req.params.id, proposal: result.proposal, indexStats: result.indexStats });
});

// ── Reject ────────────────────────────────────────────────────────────────────

router.post('/workspace/:id/edit/:proposalId/reject', (req, res) => {
  const result = rejectProposal(req.params.id, req.params.proposalId);
  if (!result.ok) return res.status(400).json({ success: false, error: result.error });
  res.json({ success: true, workspaceId: req.params.id, proposal: result.proposal });
});

// ── Revert an applied proposal ────────────────────────────────────────────────

router.post('/workspace/:id/edit/:proposalId/revert', (req, res) => {
  const result = revertProposal(req.params.id, req.params.proposalId);
  if (!result.ok) return res.status(400).json({ success: false, error: result.error });
  res.json({ success: true, workspaceId: req.params.id, proposal: result.proposal });
});

export default router;
