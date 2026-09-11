/**
 * AQUA Artifact Engine — Packager (P1)
 * ─────────────────────────────────────────────────────────────────────────────
 * ALL packaging funnels through here (spec requirement). P1 supports:
 *
 *   raw — single file served as-is
 *   zip — real .zip via adm-zip, ALREADY a dependency of the aqua package
 *         (documentPipeline.js uses it for docx/pptx/xlsx reading) — the
 *         write path costs zero new dependencies.
 *
 * tar / tar.gz land in P3 alongside codeProjectExporter (plan §11 — minimal
 * ustar writer, also zero-dep). The PACKAGING set in specSchema.js widens
 * in the same change.
 *
 * Design decision carried from the plan: the store keeps SOURCE FILES as the
 * single source of truth; archives are built on demand at download time
 * (bounded by the 100 MB artifact cap, so in-memory zip assembly is safe).
 * That means editing (P5) never has to crack open an archive to change one
 * file, and a single artifact can serve both `?file=` and whole-zip
 * downloads without storing anything twice.
 */
import AdmZip from 'adm-zip';
import { sanitizeRelativePath } from './security.js';
import { createTarBuffer, createTarGzBuffer } from './tarWriter.js';

/**
 * Resolve 'auto' packaging: one file travels raw, many travel zipped.
 * Any archive format is honored for a single file too (user asked for it).
 * @param {object} spec       validated ArtifactSpec
 * @param {number} fileCount  exporter output count
 * @returns {'raw'|'zip'|'tar'|'tar.gz'}
 */
export function resolvePackaging(spec, fileCount) {
  const requested = spec?.packaging ?? 'auto';
  if (requested === 'raw' && fileCount > 1) return 'zip'; // raw is impossible for >1 file
  if (requested === 'auto') return fileCount > 1 ? 'zip' : 'raw';
  return requested;
}

/** Archive metadata for a packaging mode — download route picks from here. */
export const ARCHIVE_META = {
  zip:      { ext: '.zip',    mime: 'application/zip'  },
  tar:      { ext: '.tar',    mime: 'application/x-tar' },
  'tar.gz': { ext: '.tar.gz', mime: 'application/gzip' },
};

/**
 * Build the archive buffer for a packaging mode. ALL archive assembly
 * funnels through here (spec requirement) — zip via adm-zip, tar/tar.gz via
 * the zero-dep ustar writer.
 *
 * @param {'zip'|'tar'|'tar.gz'} packaging
 * @param {Array<{path:string, buffer:Buffer}>} files
 * @param {{ rootDir?: string }} [opts]
 * @returns {Buffer}
 */
export function buildArchiveBuffer(packaging, files, opts = {}) {
  if (packaging === 'zip')    return buildZipBuffer(files, opts);
  if (packaging === 'tar')    return createTarBuffer(files, opts);
  if (packaging === 'tar.gz') return createTarGzBuffer(files, opts);
  throw new Error(`Unknown packaging "${packaging}"`);
}

/**
 * Build an in-memory .zip of artifact files, each nested under rootDir so an
 * unzip never splatters files into the user's cwd.
 *
 * @param {Array<{path:string, buffer:Buffer}>} files
 * @param {{ rootDir?: string }} [opts]
 * @returns {Buffer}
 */
export function buildZipBuffer(files, { rootDir = 'artifact' } = {}) {
  const zip  = new AdmZip();
  const root = sanitizeRelativePath(rootDir);
  for (const f of files) {
    const rel = sanitizeRelativePath(f.path);
    zip.addFile(`${root}/${rel}`, f.buffer);
  }
  return zip.toBuffer();
}
