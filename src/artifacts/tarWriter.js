/**
 * AQUA Artifact Engine — ustar Writer (P3)
 * ─────────────────────────────────────────────────────────────────────────────
 * Minimal POSIX ustar archive writer — ZERO dependencies (plan §11: a tar
 * library is not worth a supply-chain edge for ~120 lines of well-specified
 * header math). Regular files only, which is exactly what artifacts are:
 * directories materialize implicitly on extract, no symlinks/devices/owners.
 *
 * Format (POSIX.1-1988 ustar):
 *   • 512-byte header per file: name(100) mode(8) uid(8) gid(8) size(12)
 *     mtime(12) chksum(8) typeflag(1) linkname(100) magic("ustar\0")
 *     version("00") uname(32) gname(32) devmajor(8) devminor(8) prefix(155)
 *   • numeric fields are zero-padded octal, NUL-terminated
 *   • chksum = sum of header bytes with the chksum field read as 8 spaces,
 *     stored as 6 octal digits + NUL + space
 *   • file data zero-padded to the next 512 boundary
 *   • archive ends with two zero blocks
 *
 * Long paths: names >100 chars use the ustar prefix(155) split at a '/'
 * boundary. Paths that cannot split (name part >100 or prefix >155) THROW —
 * honest failure over silent truncation. GNU 'L' longname records are a P6
 * item if real projects ever hit the limit (they don't at sane depths).
 *
 * Verified in tests against the system `tar` binary — an independent reader,
 * same philosophy as re-opening xlsx/docx/pptx output with independent libs.
 */
import zlib from 'zlib';
import { sanitizeRelativePath } from './security.js';

const BLOCK = 512;

function octal(value, width) {
  // width includes the trailing NUL: e.g. size(12) = 11 octal digits + NUL
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

/** Split a >100-char path into ustar { prefix, name } at a '/' boundary. */
function splitPath(p) {
  if (Buffer.byteLength(p) <= 100) return { prefix: '', name: p };
  // Find the LAST '/' whose right side fits in name(100) while the left
  // side fits in prefix(155).
  for (let i = p.length - 1; i > 0; i--) {
    if (p[i] !== '/') continue;
    const prefix = p.slice(0, i);
    const name   = p.slice(i + 1);
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) {
      return { prefix, name };
    }
  }
  return null; // caller falls back to a GNU longname record (P6)
}

/** Truncate a string to at most n BYTES without splitting a UTF-8 char. */
function truncBytes(s, n) {
  let out = s;
  while (Buffer.byteLength(out) > n) out = out.slice(0, -1);
  return out;
}

function header({ name, prefix = '', size, mtime, typeflag = '0' }) {
  const buf = Buffer.alloc(BLOCK); // zero-filled

  buf.write(name, 0, 100, 'utf8');
  buf.write(octal(0o644, 8),   100);        // mode
  buf.write(octal(0, 8),       108);        // uid
  buf.write(octal(0, 8),       116);        // gid
  buf.write(octal(size, 12),   124);        // size
  buf.write(octal(mtime, 12),  136);        // mtime (seconds)
  buf.write('        ',        148);        // chksum placeholder: 8 spaces
  buf.write(typeflag,          156);        // '0' regular file, 'L' GNU longname
  buf.write('ustar\0',         257);        // magic
  buf.write('00',              263);        // version
  buf.write('aqua',            265);        // uname
  buf.write('aqua',            297);        // gname
  buf.write(octal(0, 8),       329);        // devmajor
  buf.write(octal(0, 8),       337);        // devminor
  buf.write(prefix,            345, 155, 'utf8');

  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148); // 6 octal + NUL + space

  return buf;
}

/**
 * Emit the header block(s) for one entry. Paths that fit ustar go straight
 * through; unsplittable long paths (single segment >100 bytes, or prefix
 * >155) get a GNU 'L' longname record first — a pseudo-entry named
 * "././@LongLink" whose DATA is the full path, followed by the real header
 * with a truncated name. GNU tar and bsdtar both read this (P6 hardening;
 * previously these paths threw).
 */
function pushEntryHeaders(chunks, fullPath, size, mtime) {
  const split = splitPath(fullPath);
  if (split) {
    chunks.push(header({ name: split.name, prefix: split.prefix, size, mtime }));
    return;
  }
  const pathBytes = Buffer.from(fullPath + '\0', 'utf8');
  chunks.push(header({ name: '././@LongLink', size: pathBytes.length, mtime, typeflag: 'L' }));
  chunks.push(pathBytes);
  const pad = (BLOCK - (pathBytes.length % BLOCK)) % BLOCK;
  if (pad) chunks.push(Buffer.alloc(pad));
  chunks.push(header({ name: truncBytes(fullPath, 100), size, mtime }));
}

/**
 * Build an in-memory .tar of artifact files, each nested under rootDir —
 * mirror of packager.buildZipBuffer, same hostile-path posture.
 *
 * @param {Array<{path:string, buffer:Buffer}>} files
 * @param {{ rootDir?: string, mtime?: number }} [opts]
 * @returns {Buffer}
 */
export function createTarBuffer(files, { rootDir = 'artifact', mtime = Math.floor(Date.now() / 1000) } = {}) {
  const root   = sanitizeRelativePath(rootDir);
  const chunks = [];
  for (const f of files) {
    const rel  = sanitizeRelativePath(f.path);
    const full = `${root}/${rel}`;
    pushEntryHeaders(chunks, full, f.buffer.length, mtime);
    chunks.push(f.buffer);
    const pad = (BLOCK - (f.buffer.length % BLOCK)) % BLOCK;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(BLOCK * 2)); // end-of-archive
  return Buffer.concat(chunks);
}

/** .tar.gz variant — gzip level 6 (speed/size balance for download-time packaging). */
export function createTarGzBuffer(files, opts) {
  return zlib.gzipSync(createTarBuffer(files, opts), { level: 6 });
}
