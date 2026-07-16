/**
 * AQUA Artifact Engine — Validator (P1)
 * ─────────────────────────────────────────────────────────────────────────────
 * The last gate before anything touches the artifact store. Exporters run
 * their own format-level validate(); THIS pass enforces the global,
 * exporter-independent invariants — the checks that must hold no matter how
 * many exporters exist or how any one of them is implemented:
 *
 *   • every path re-sanitized (defense in depth; specSchema already did it,
 *     but exporters can ADD files — e.g. a future packager side-file)
 *   • per-file / per-artifact size quotas
 *   • no native executables (extension + magic bytes)
 *   • declared mime consistent with the exporter's declared set
 *   • text mimes must decode as valid UTF-8
 *
 * Collects ALL errors (never first-throw) so failures log usefully, then the
 * engine converts a failed validation into the standard fallback-to-chat.
 */
import {
  sanitizeRelativePath, checkExecutable, QUOTAS, ArtifactSecurityError,
} from './security.js';

const TEXT_MIME_RE = /^(text\/|application\/(json|yaml|xml|sql|javascript))/;

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/**
 * @param {Array<{path:string, buffer:Buffer, mime:string}>} files exporter output
 * @param {object} spec        validated ArtifactSpec
 * @param {object} exporterDef registry definition for spec.format
 * @returns {{ valid: boolean, errors: string[], totalBytes: number }}
 */
export function validateArtifactFiles(files, spec, exporterDef) {
  const errors = [];
  let totalBytes = 0;

  if (!Array.isArray(files) || files.length === 0) {
    return { valid: false, errors: ['exporter produced no files'], totalBytes: 0 };
  }
  if (files.length > QUOTAS.MAX_FILES) {
    errors.push(`file count ${files.length} exceeds maximum ${QUOTAS.MAX_FILES}`);
  }

  const allowedMimes = new Set(exporterDef?.mimes ?? []);
  const seen = new Set();

  for (const f of files) {
    // Path — re-sanitized even though specSchema already ran.
    let cleanPath;
    try {
      cleanPath = sanitizeRelativePath(f.path);
    } catch (err) {
      if (err instanceof ArtifactSecurityError) {
        errors.push(`"${f.path}": ${err.message}`);
        continue;
      }
      throw err;
    }
    const lower = cleanPath.toLowerCase();
    if (seen.has(lower)) { errors.push(`"${cleanPath}": duplicate path`); continue; }
    seen.add(lower);

    // Buffer + size
    if (!Buffer.isBuffer(f.buffer)) {
      errors.push(`"${cleanPath}": content is not a Buffer`);
      continue;
    }
    if (f.buffer.length === 0) {
      errors.push(`"${cleanPath}": empty file`);
      continue;
    }
    if (f.buffer.length > QUOTAS.MAX_FILE_BYTES) {
      errors.push(`"${cleanPath}": ${f.buffer.length} bytes exceeds per-file cap ${QUOTAS.MAX_FILE_BYTES}`);
      continue;
    }
    totalBytes += f.buffer.length;

    // Executable abuse
    const exe = checkExecutable(cleanPath, f.buffer);
    if (exe.forbidden) {
      errors.push(`"${cleanPath}": forbidden — ${exe.reason}`);
      continue;
    }

    // Mime consistency with the exporter's declaration
    if (allowedMimes.size && f.mime && !allowedMimes.has(f.mime)) {
      errors.push(`"${cleanPath}": mime "${f.mime}" not declared by exporter "${exporterDef?.id ?? spec.format}"`);
    }

    // Text formats must be valid UTF-8 (a mangled buffer here would ship a
    // corrupt file the user only discovers after download).
    if (TEXT_MIME_RE.test(f.mime ?? '')) {
      try {
        utf8Strict.decode(f.buffer);
      } catch {
        errors.push(`"${cleanPath}": declared text mime but content is not valid UTF-8`);
      }
    }
  }

  if (totalBytes > QUOTAS.MAX_ARTIFACT_BYTES) {
    errors.push(`artifact totals ${totalBytes} bytes — exceeds cap ${QUOTAS.MAX_ARTIFACT_BYTES}`);
  }

  return { valid: errors.length === 0, errors, totalBytes };
}
