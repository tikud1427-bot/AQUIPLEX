/**
 * AQUA Upload Classifier — Day 5 Universal Upload
 *
 * ONE upload entrypoint means SOMETHING must decide what a file actually is.
 * This module is that decision. Pure + synchronous: extension first, magic
 * bytes as a tiebreaker/verifier (a ".zip" that doesn't start with PK is
 * treated as corrupt, not silently mis-routed).
 *
 * Kinds (each maps to exactly one processing pipeline — see routes/upload.js):
 *   repository — ZIP / TAR / TAR.GZ / TGZ           → workspace ingestion
 *   source     — code / text / markdown / json / …  → inline read
 *   document   — PDF / DOCX / PPTX / XLSX / CSV / ODT / EPUB → document pipeline
 *   image      — PNG / JPEG / WEBP / GIF / SVG / HEIC → vision pipeline
 *   audio      — MP3 / WAV / M4A                     → media pipeline (Gemini)
 *   video      — MP4 / MOV / AVI                     → media pipeline (Gemini)
 *   unknown    — everything else                     → explicit rejection (never silent)
 */
import path from 'path';

// ── Extension tables ──────────────────────────────────────────────────────────

const ARCHIVE_EXTS = new Set(['.zip', '.tar', '.gz', '.tgz']);

const SOURCE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.pyw', '.java', '.kt',
  '.go', '.rs', '.cs', '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.php',
  '.rb', '.swift', '.md', '.mdx', '.txt', '.json', '.yaml', '.yml', '.toml',
  '.xml', '.html', '.htm', '.css', '.scss', '.sass', '.less', '.sql',
  '.graphql', '.gql', '.proto', '.sh', '.bash', '.zsh', '.env', '.tf',
  '.vue', '.svelte', '.log', '.ini', '.cfg', '.conf', '.tsv',
]);

const DOCUMENT_EXTS = new Set(['.pdf', '.docx', '.pptx', '.xlsx', '.csv', '.odt', '.epub']);

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.heic', '.heif']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi']);

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.heic': 'image/heic', '.heif': 'image/heif',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.pdf': 'application/pdf',
};

// ── Magic bytes ───────────────────────────────────────────────────────────────

function startsWith(buffer, bytes, offset = 0) {
  if (buffer.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buffer[offset + i] !== bytes[i]) return false;
  }
  return true;
}

/** Best-effort binary signature sniff. Returns a hint string or null. */
export function sniffMagic(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buffer, [0x50, 0x4b, 0x05, 0x06])) return 'zip';
  if (startsWith(buffer, [0x1f, 0x8b])) return 'gzip';
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46])) return 'pdf';       // %PDF
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47])) return 'png';
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (buffer.length >= 12 && startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  // TAR: "ustar" at offset 257
  if (buffer.length > 262 && startsWith(buffer, [0x75, 0x73, 0x74, 0x61, 0x72], 257)) return 'tar';
  return null;
}

// ── Classification ────────────────────────────────────────────────────────────

/**
 * @param {string} filename
 * @param {Buffer} [buffer] - raw bytes if available (magic verification)
 * @returns {{ kind: string, ext: string, mime: string|null, archiveFormat?: string, corrupt?: boolean }}
 */
export function classifyUpload(filename, buffer = null) {
  const base = path.basename(filename).toLowerCase();
  let ext = path.extname(base);
  // Compound extension: .tar.gz classifies as tar.gz, not bare .gz
  const isTarGz = base.endsWith('.tar.gz') || base.endsWith('.tgz');

  const magic = buffer ? sniffMagic(buffer) : null;

  // ── Repositories / archives ──
  if (ARCHIVE_EXTS.has(ext) || isTarGz) {
    let archiveFormat = null;
    if (ext === '.zip')            archiveFormat = 'zip';
    else if (isTarGz)              archiveFormat = 'tar.gz';
    else if (ext === '.tar')       archiveFormat = 'tar';
    else if (ext === '.gz')        archiveFormat = 'gz'; // single gzipped file — treated as tar.gz attempt then plain gunzip

    // Magic verification: named .zip but bytes disagree → corrupt, not misrouted.
    let corrupt = false;
    if (magic) {
      if (archiveFormat === 'zip'    && magic !== 'zip')  corrupt = true;
      if (archiveFormat === 'tar'    && magic !== 'tar')  corrupt = true;
      if ((archiveFormat === 'tar.gz' || archiveFormat === 'gz') && magic !== 'gzip') corrupt = true;
    }
    return { kind: 'repository', ext, mime: null, archiveFormat, corrupt };
  }

  if (DOCUMENT_EXTS.has(ext)) {
    const corrupt = ext === '.pdf' && magic !== null && magic !== 'pdf';
    return { kind: 'document', ext, mime: MIME_BY_EXT[ext] ?? null, corrupt };
  }
  if (IMAGE_EXTS.has(ext)) return { kind: 'image', ext, mime: MIME_BY_EXT[ext] ?? 'application/octet-stream' };
  if (AUDIO_EXTS.has(ext)) return { kind: 'audio', ext, mime: MIME_BY_EXT[ext] ?? 'application/octet-stream' };
  if (VIDEO_EXTS.has(ext)) return { kind: 'video', ext, mime: MIME_BY_EXT[ext] ?? 'application/octet-stream' };

  if (SOURCE_EXTS.has(ext) || isKnownExtensionless(base)) {
    return { kind: 'source', ext, mime: 'text/plain' };
  }

  // Unknown extension but bytes look like an archive/document → trust the bytes.
  if (magic === 'zip')  return { kind: 'repository', ext, mime: null, archiveFormat: 'zip' };
  if (magic === 'gzip') return { kind: 'repository', ext, mime: null, archiveFormat: 'tar.gz' };
  if (magic === 'tar')  return { kind: 'repository', ext, mime: null, archiveFormat: 'tar' };
  if (magic === 'pdf')  return { kind: 'document', ext: '.pdf', mime: 'application/pdf' };
  if (magic === 'png')  return { kind: 'image', ext: '.png', mime: 'image/png' };
  if (magic === 'jpeg') return { kind: 'image', ext: '.jpg', mime: 'image/jpeg' };

  return { kind: 'unknown', ext, mime: null };
}

function isKnownExtensionless(base) {
  return ['dockerfile', 'makefile', 'gemfile', 'procfile', 'license', 'readme', 'cmakelists.txt'].includes(base)
    || base.startsWith('.env');
}

export const SUPPORTED_FORMATS = {
  repository: ['zip', 'tar', 'tar.gz', 'tgz', 'folder (multi-file)'],
  source:     [...SOURCE_EXTS].map(e => e.slice(1)),
  document:   [...DOCUMENT_EXTS].map(e => e.slice(1)),
  image:      [...IMAGE_EXTS].map(e => e.slice(1)),
  audio:      [...AUDIO_EXTS].map(e => e.slice(1)),
  video:      [...VIDEO_EXTS].map(e => e.slice(1)),
};
