/**
 * AQUA Artifact Engine — Security Primitives (P1)
 * ─────────────────────────────────────────────────────────────────────────────
 * Every filename the Artifact Engine writes or serves passes through here.
 * Planner output is UNTRUSTED INPUT — an LLM was asked for JSON and JSON is
 * what we hope came back. Nothing it produces touches the filesystem until
 * sanitizeRelativePath() has accepted the path AND resolveInsideRoot() has
 * proven the resolved absolute path cannot escape the artifact's own
 * directory. Pure, dependency-free, throw-on-violation (never "fix up" a
 * hostile path into a safe-looking one — rejection is the only safe repair).
 *
 * Mirrors the posture of project/secretGuard.js: deterministic denylists,
 * fail-closed, unit-tested against hostile inputs before anything wires in.
 */
import path from 'path';

// ── Errors ────────────────────────────────────────────────────────────────────

export class ArtifactSecurityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArtifactSecurityError';
    this.code = code;
  }
}

// ── Quotas (P1 — enforced by validator.js and artifactStore.js) ───────────────

export const QUOTAS = {
  MAX_FILE_BYTES:     25 * 1024 * 1024,   // 25 MB per file
  MAX_ARTIFACT_BYTES: 100 * 1024 * 1024,  // 100 MB per artifact (all files)
  MAX_FILES:          200,                // files per artifact
  MAX_OWNER_BYTES:    500 * 1024 * 1024,  // 500 MB per owner — oldest evicted beyond this
  MAX_PATH_LENGTH:    1024,               // total relative path
  MAX_SEGMENT_LENGTH: 255,                // single path segment
};

// ── Filename / path validation ────────────────────────────────────────────────

// Windows-reserved device names — forbidden as a segment basename with or
// without an extension ("CON", "con.md", "LPT1.txt" are all invalid on the
// platforms users will unzip these artifacts on).
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const DRIVE_LETTER_RE  = /^[a-zA-Z]:/;

/**
 * Validate + normalize a relative artifact path. Accepts forward or backward
 * separators in input (LLMs emit both), returns a canonical forward-slash
 * relative path. THROWS ArtifactSecurityError on anything unsafe — callers
 * never receive a "cleaned" version of a hostile path.
 *
 * @param {string} p
 * @returns {string} normalized POSIX-style relative path
 */
export function sanitizeRelativePath(p) {
  if (typeof p !== 'string') {
    throw new ArtifactSecurityError('PATH_TYPE', 'Path must be a string');
  }
  const raw = p.trim();
  if (!raw) {
    throw new ArtifactSecurityError('PATH_EMPTY', 'Path is empty');
  }
  if (raw.length > QUOTAS.MAX_PATH_LENGTH) {
    throw new ArtifactSecurityError('PATH_TOO_LONG', `Path exceeds ${QUOTAS.MAX_PATH_LENGTH} chars`);
  }
  if (CONTROL_CHARS_RE.test(raw)) {
    throw new ArtifactSecurityError('PATH_CONTROL_CHARS', 'Path contains control characters');
  }

  const normalized = raw.replace(/\\/g, '/');

  if (normalized.startsWith('/')) {
    throw new ArtifactSecurityError('PATH_ABSOLUTE', `Absolute paths are not allowed: "${p}"`);
  }
  if (DRIVE_LETTER_RE.test(normalized)) {
    throw new ArtifactSecurityError('PATH_DRIVE', `Drive-letter paths are not allowed: "${p}"`);
  }

  const segments = normalized.split('/');
  for (const seg of segments) {
    if (seg === '' ) {
      throw new ArtifactSecurityError('PATH_EMPTY_SEGMENT', `Empty path segment (double slash or trailing slash): "${p}"`);
    }
    if (seg === '.' || seg === '..') {
      throw new ArtifactSecurityError('PATH_TRAVERSAL', `Path traversal segment "${seg}" in "${p}"`);
    }
    if (seg.length > QUOTAS.MAX_SEGMENT_LENGTH) {
      throw new ArtifactSecurityError('PATH_SEGMENT_TOO_LONG', `Path segment exceeds ${QUOTAS.MAX_SEGMENT_LENGTH} chars`);
    }
    const base = seg.split('.')[0].toUpperCase();
    if (WINDOWS_RESERVED.has(base)) {
      throw new ArtifactSecurityError('PATH_RESERVED_NAME', `Reserved filename "${seg}" in "${p}"`);
    }
  }

  return segments.join('/');
}

/**
 * Resolve `rel` inside `root` and PROVE the result cannot escape root.
 * Defense-in-depth behind sanitizeRelativePath — every disk touch (write in
 * artifactStore, read in the download/file routes) goes through this even
 * though the path was already sanitized at spec time.
 *
 * @param {string} root absolute directory
 * @param {string} rel  relative path (should already be sanitized)
 * @returns {string} absolute path, guaranteed inside root
 */
export function resolveInsideRoot(root, rel) {
  const absRoot = path.resolve(root);
  const abs     = path.resolve(absRoot, rel);
  if (abs !== absRoot && !abs.startsWith(absRoot + path.sep)) {
    throw new ArtifactSecurityError('PATH_ESCAPE', `Resolved path escapes artifact root: "${rel}"`);
  }
  return abs;
}

// ── Executable-abuse prevention ───────────────────────────────────────────────
// Scripts (.sh/.bat/.ps1) are legitimate TEXT artifacts and are allowed —
// they are stored 0644 and never chmod +x'd. Native executables are never
// generated: extension denylist + magic-byte sniff on every buffer.

const FORBIDDEN_EXECUTABLE_EXTS = new Set([
  '.exe', '.dll', '.msi', '.scr', '.com', '.so', '.dylib', '.pif', '.cpl',
]);

/**
 * @param {string} relPath
 * @param {Buffer} [buffer]
 * @returns {{ forbidden: boolean, reason?: string }}
 */
export function checkExecutable(relPath, buffer) {
  const ext = path.extname(relPath).toLowerCase();
  if (FORBIDDEN_EXECUTABLE_EXTS.has(ext)) {
    return { forbidden: true, reason: `native executable extension "${ext}"` };
  }
  if (buffer && buffer.length >= 4) {
    // MZ (PE), ELF, Mach-O (both endiannesses + fat binaries)
    const b0 = buffer[0], b1 = buffer[1], b2 = buffer[2], b3 = buffer[3];
    if (b0 === 0x4d && b1 === 0x5a) return { forbidden: true, reason: 'PE (MZ) executable magic bytes' };
    if (b0 === 0x7f && b1 === 0x45 && b2 === 0x4c && b3 === 0x46) return { forbidden: true, reason: 'ELF executable magic bytes' };
    const u32 = (b0 << 24 | b1 << 16 | b2 << 8 | b3) >>> 0;
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(u32)) {
      return { forbidden: true, reason: 'Mach-O executable magic bytes' };
    }
  }
  return { forbidden: false };
}

/** Filesystem-safe download name from a title. Never empty. */
export function slugify(title) {
  const slug = String(title ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._ -]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
    .replace(/^[.-]+|[.-]+$/g, '');
  return slug || 'artifact';
}
