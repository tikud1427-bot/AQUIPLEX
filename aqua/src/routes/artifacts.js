/**
 * AQUA Artifacts Route (P1)
 * ─────────────────────────────────────────────────────────────────────────────
 *   GET    /artifacts                 — list (optional ?conversationId= &workspaceId=)
 *   GET    /artifacts/:id             — full manifest (spec included — owner's data)
 *   GET    /artifacts/:id/download    — single file raw, multi-file zip (?version=N)
 *   GET    /artifacts/:id/file?path=  — one file from the artifact (?version=N)
 *   GET    /artifacts/:id/preview?path= — bounded text preview for panel/cards
 *   PATCH  /artifacts/:id             — rename { title }
 *   DELETE /artifacts/:id             — delete artifact + files
 *
 * Ownership guard mirrors conversations.js assertOwnership EXACTLY: when the
 * platform supplies a session identity (req.aquaUserId, injected by
 * index.js), the artifact's ownerId must equal ownerForUser(that id).
 * Mismatch and missing id both return 404 — no existence oracle. Dev /
 * standalone mode (no session) is unscoped, same as every other route.
 * `conv:`-owned artifacts (created pre-login) stay invisible to logged-in
 * users — the documented conversations.js legacy rule, applied consistently.
 *
 * `?path=` query param instead of a wildcard segment: artifact paths contain
 * slashes, and Express 5 wildcard params changed shape between majors — an
 * explicit query param is unambiguous and encodes trivially on the client.
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import {
  getArtifactLite, getArtifact, listArtifacts,
  renameArtifact, deleteArtifact, getFileAbsolutePath, getVersionFileMetas,
} from '../artifacts/artifactStore.js';
import { publicManifest, composeArtifactEditSummary } from '../artifacts/engine.js';
import { editArtifact, regenerateArtifact } from '../artifacts/editEngine.js';
import { buildArchiveBuffer, ARCHIVE_META } from '../artifacts/packager.js';
import { slugify }         from '../artifacts/security.js';
import { ownerForUser }    from '../memory/ownerResolver.js';

const router = express.Router();

// ── Ownership guard (404-uniform, conversations.js pattern) ───────────────────

function assertOwner(req, res, id) {
  const lite = getArtifactLite(id);
  if (!lite) {
    res.status(404).json({ success: false, error: 'Artifact not found' });
    return null;
  }
  const scopeUser = req.aquaUserId ?? null;
  if (scopeUser && lite.ownerId !== ownerForUser(scopeUser)) {
    res.status(404).json({ success: false, error: 'Artifact not found' });
    return null;
  }
  return lite;
}

function contentDisposition(kind, filename) {
  // RFC 5987 — ASCII fallback + UTF-8 extended form (titles can be Hindi etc.)
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ── List ──────────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const scopeUser = req.aquaUserId ?? null;
  const entries = listArtifacts({
    ownerId:        scopeUser ? ownerForUser(scopeUser) : null,
    conversationId: req.query.conversationId ?? null,
    workspaceId:    req.query.workspaceId ?? null,
  });
  res.json({
    success: true,
    artifacts: entries.map(e => ({ ...e, downloadUrl: `/artifacts/${e.id}/download` })),
  });
});

// ── Manifest ──────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  if (!assertOwner(req, res, req.params.id)) return;
  const manifest = await getArtifact(req.params.id);
  if (!manifest) return res.status(404).json({ success: false, error: 'Artifact not found' });
  res.json({ success: true, artifact: { ...publicManifest(manifest), spec: manifest.spec, summary: manifest.summary } });
});

// ── Download (single file raw, multi-file zip) ────────────────────────────────

router.get('/:id/download', async (req, res) => {
  if (!assertOwner(req, res, req.params.id)) return;
  const manifest = await getArtifact(req.params.id);
  if (!manifest) return res.status(404).json({ success: false, error: 'Artifact not found' });

  const version = req.query.version ? Number(req.query.version) : manifest.version;

  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const versionFiles = getVersionFileMetas(manifest, version);
    if (versionFiles.length === 1) {
      const f   = versionFiles[0];
      const abs = getFileAbsolutePath(manifest, f.path, version);
      res.setHeader('Content-Type', f.mime || 'application/octet-stream');
      res.setHeader('Content-Length', f.size);
      res.setHeader('Content-Disposition', contentDisposition('attachment', path.basename(f.path)));
      fs.createReadStream(abs)
        .on('error', (err) => {
          console.warn(`[ARTIFACT] download stream failed id=${manifest.id}: ${err.message}`);
          if (!res.headersSent) res.status(500).json({ success: false, error: 'Download failed' });
          else res.destroy(err);
        })
        .pipe(res);
      return;
    }

    // Multi-file — archive on demand from the stored sources in the
    // artifact's own packaging mode (zip default; tar/tar.gz when the user
    // asked). Bounded by the 100 MB artifact cap, so in-memory assembly is
    // safe.
    const files = versionFiles.map(f => ({
      path:   f.path,
      buffer: fs.readFileSync(getFileAbsolutePath(manifest, f.path, version)),
    }));
    const packaging = ARCHIVE_META[manifest.packaging] ? manifest.packaging : 'zip';
    const meta      = ARCHIVE_META[packaging];
    const archive   = buildArchiveBuffer(packaging, files, { rootDir: slugify(manifest.title) });
    const name      = `${slugify(manifest.title)}-v${version}${meta.ext}`;
    res.setHeader('Content-Type', meta.mime);
    res.setHeader('Content-Length', archive.length);
    res.setHeader('Content-Disposition', contentDisposition('attachment', name));
    res.send(archive);
  } catch (err) {
    console.warn(`[ARTIFACT] download failed id=${req.params.id}: ${err.message}`);
    if (!res.headersSent) res.status(404).json({ success: false, error: 'Artifact not found' });
  }
});

// ── Single file ───────────────────────────────────────────────────────────────

router.get('/:id/file', async (req, res) => {
  if (!assertOwner(req, res, req.params.id)) return;
  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ success: false, error: 'Query param "path" is required' });

  const manifest = await getArtifact(req.params.id);
  if (!manifest) return res.status(404).json({ success: false, error: 'Artifact not found' });
  const version = req.query.version ? Number(req.query.version) : manifest.version;

  try {
    const meta = getVersionFileMetas(manifest, version).find(f => f.path === relPath);
    const abs  = getFileAbsolutePath(manifest, relPath, version); // throws on unlisted/hostile
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', meta?.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition('attachment', path.basename(relPath)));
    fs.createReadStream(abs)
      .on('error', () => { if (!res.headersSent) res.status(404).json({ success: false, error: 'Artifact not found' }); })
      .pipe(res);
  } catch {
    res.status(404).json({ success: false, error: 'Artifact not found' });
  }
});

// ── Text preview (bounded — for cards/panel) ──────────────────────────────────

const PREVIEW_MAX = 50_000;
const TEXT_MIME_RE = /^(text\/|application\/(json|yaml|xml|sql|javascript))/;

router.get('/:id/preview', async (req, res) => {
  if (!assertOwner(req, res, req.params.id)) return;
  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ success: false, error: 'Query param "path" is required' });

  const manifest = await getArtifact(req.params.id);
  if (!manifest) return res.status(404).json({ success: false, error: 'Artifact not found' });
  const version = req.query.version ? Number(req.query.version) : manifest.version;

  try {
    // Version-correct metas — preview reaches old versions on the same terms
    // as /download and /file (P6: these three routes now behave identically).
    const meta = getVersionFileMetas(manifest, version).find(f => f.path === relPath);
    if (!meta || !TEXT_MIME_RE.test(meta.mime ?? '')) {
      return res.json({ success: true, previewable: false });
    }
    const abs  = getFileAbsolutePath(manifest, relPath, version);
    const text = await fs.promises.readFile(abs, 'utf8');
    res.json({
      success: true,
      previewable: true,
      path: relPath,
      version,
      mime: meta.mime,
      text: text.slice(0, PREVIEW_MAX),
      truncated: text.length > PREVIEW_MAX,
    });
  } catch {
    res.status(404).json({ success: false, error: 'Artifact not found' });
  }
});

// ── Edit / Regenerate (P5) ────────────────────────────────────────────────────
// Metered at the chat_with_file tier by the platform (index.js usageGuard).
// Both append an immutable new version; the previous versions stay
// downloadable via ?version=N.

router.post('/:id/edit', async (req, res) => {
  if (!assertOwner(req, res, req.params.id)) return;
  const instruction = typeof req.body?.instruction === 'string' ? req.body.instruction.trim() : '';
  if (!instruction) return res.status(400).json({ success: false, error: 'Body field "instruction" is required' });
  if (instruction.length > 4_000) return res.status(400).json({ success: false, error: '"instruction" exceeds 4000 chars' });

  try {
    const r = await editArtifact({
      artifactId: req.params.id,
      instruction,
      requestId: `api-${req.params.id.slice(0, 8)}-${Date.now()}`,
      conversationId: getArtifactLite(req.params.id)?.conversationId,
    });
    res.json({
      success: true,
      artifact: publicManifest(r.manifest),
      changed: r.changed,
      summary: composeArtifactEditSummary(publicManifest(r.manifest), r.changed),
    });
  } catch (err) {
    console.warn(`[ARTIFACT] API edit failed id=${req.params.id}: ${err.message}`);
    res.status(err.code === 'ARTIFACT_NOT_FOUND' ? 404 : 422)
      .json({ success: false, error: err.message, code: err.code ?? 'ARTIFACT_EDIT_FAILED' });
  }
});

router.post('/:id/regenerate', async (req, res) => {
  if (!assertOwner(req, res, req.params.id)) return;
  const onlyPath = typeof req.body?.path === 'string' && req.body.path.trim() ? req.body.path.trim() : null;

  try {
    const r = await regenerateArtifact({
      artifactId: req.params.id,
      path: onlyPath,
      requestId: `api-${req.params.id.slice(0, 8)}-${Date.now()}`,
      conversationId: getArtifactLite(req.params.id)?.conversationId,
    });
    res.json({ success: true, artifact: publicManifest(r.manifest), changed: r.changed });
  } catch (err) {
    console.warn(`[ARTIFACT] API regenerate failed id=${req.params.id}: ${err.message}`);
    res.status(err.code === 'ARTIFACT_NOT_FOUND' ? 404 : 422)
      .json({ success: false, error: err.message, code: err.code ?? 'ARTIFACT_REGEN_FAILED' });
  }
});

// ── Rename ────────────────────────────────────────────────────────────────────

router.patch('/:id', async (req, res) => {
  if (!assertOwner(req, res, req.params.id)) return;
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  if (!title) return res.status(400).json({ success: false, error: 'Body field "title" is required' });
  const manifest = await renameArtifact(req.params.id, title);
  if (!manifest) return res.status(404).json({ success: false, error: 'Artifact not found' });
  res.json({ success: true, artifact: publicManifest(manifest) });
});

// ── Delete ────────────────────────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
  if (!assertOwner(req, res, req.params.id)) return;
  await deleteArtifact(req.params.id);
  res.json({ success: true });
});

export default router;
