/**
 * AQUA Archive Extractor — Day 5
 *
 * ZIP was already handled (fileIngester.extractZip, adm-zip). TAR and TAR.GZ
 * were flatly rejected. This module unifies all three behind one call:
 *
 *   extractArchive(buffer, format) → rawFiles[{ path, content, encoding? }]
 *
 * TAR is hand-rolled deliberately — the format is 512-byte header blocks +
 * padded content, ~70 lines to read safely, versus pulling in a streaming
 * dependency for a buffer we already hold in memory. GZIP uses Node's
 * built-in zlib. Zero new dependencies.
 *
 * Same safety budget as the ZIP path (entry count / per-entry size / total
 * size), same ignore-rule pre-filter, same base64 carry-through for binary
 * document formats so downstream ingestion is IDENTICAL regardless of
 * which archive format the user happened to pick.
 */
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import { shouldIgnore } from '../project/fileIngester.js';
import { isDocumentExt } from '../project/documentParser.js';

const gunzip = promisify(zlib.gunzip);

// Mirrors fileIngester's ZIP caps — one budget for every archive format.
const MAX_ENTRIES     = 10_000;
const MAX_ENTRY_BYTES = 20_000_000;   // 20 MB uncompressed per entry
const MAX_TOTAL_BYTES = 300_000_000;  // 300 MB total extraction budget
const MAX_GZIP_RATIO  = 200;          // gzip bomb guard: 300 MB budget / declared compressed size

// ── TAR parsing ───────────────────────────────────────────────────────────────

function readTarString(buffer, offset, length) {
  const end = Math.min(offset + length, buffer.length);
  let nul = offset;
  while (nul < end && buffer[nul] !== 0) nul++;
  return buffer.toString('utf8', offset, nul);
}

function readTarOctal(buffer, offset, length) {
  const raw = readTarString(buffer, offset, length).trim();
  if (!raw) return 0;
  const n = parseInt(raw, 8);
  return Number.isFinite(n) ? n : 0;
}

function isZeroBlock(buffer, offset) {
  for (let i = 0; i < 512; i++) {
    if (buffer[offset + i] !== 0) return false;
  }
  return true;
}

/**
 * Parse a TAR buffer into entries. Supports ustar + GNU/PAX long names
 * (typeflag 'L' and PAX 'x' path records — both appear in real-world
 * archives produced by `tar czf` on deep trees).
 *
 * @param {Buffer} buffer
 * @returns {Array<{ name: string, data: Buffer }>}
 */
export function parseTar(buffer) {
  const entries = [];
  let offset = 0;
  let pendingLongName = null;

  while (offset + 512 <= buffer.length) {
    if (isZeroBlock(buffer, offset)) break; // end-of-archive marker

    const name     = readTarString(buffer, offset, 100);
    const size     = readTarOctal(buffer, offset + 124, 12);
    const typeflag = String.fromCharCode(buffer[offset + 156] || 0x30);
    const prefix   = readTarString(buffer, offset + 345, 155);

    const dataStart = offset + 512;
    const dataEnd   = dataStart + size;
    if (dataEnd > buffer.length) {
      throw new Error('Truncated TAR archive — entry data runs past end of file');
    }

    if (typeflag === 'L') {
      // GNU long name: data block IS the real name of the NEXT entry
      pendingLongName = buffer.toString('utf8', dataStart, dataEnd).replace(/\0+$/, '');
    } else if (typeflag === 'x' || typeflag === 'g') {
      // PAX extended header — pull path= record if present
      const pax = buffer.toString('utf8', dataStart, dataEnd);
      const m = pax.match(/\d+ path=([^\n]+)\n/);
      if (m) pendingLongName = m[1];
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      // Regular file
      let entryName = pendingLongName ?? (prefix ? `${prefix}/${name}` : name);
      pendingLongName = null;
      entryName = entryName.replace(/^\.\//, '');
      if (entryName) {
        entries.push({ name: entryName, data: buffer.subarray(dataStart, dataEnd) });
      }
    } else {
      // Directory / link / device / etc — skip, but a long name applies to it
      pendingLongName = null;
    }

    // Advance: header + data rounded up to the next 512-byte boundary
    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  return entries;
}

// ── Path safety ───────────────────────────────────────────────────────────────

/** Archive entry names are attacker-controlled — normalize + reject traversal. */
function sanitizeEntryPath(name) {
  const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(p => p && p !== '.');
  if (parts.some(p => p === '..')) return null; // zip-slip / tar-slip attempt
  return parts.join('/');
}

// ── Unified conversion: archive entries → ingestable rawFiles ─────────────────

function entriesToRawFiles(entries) {
  const files = [];
  let totalBytes = 0;
  let skippedOversize = 0;

  for (const entry of entries) {
    const entryPath = sanitizeEntryPath(entry.name);
    if (!entryPath) continue;

    if (entry.data.length > MAX_ENTRY_BYTES) { skippedOversize++; continue; }
    totalBytes += entry.data.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('Archive expands beyond the 300 MB extraction budget — likely includes dependencies or binaries. Trim it and retry.');
    }

    const ext = path.extname(entryPath).toLowerCase();
    if (!isDocumentExt(ext) && shouldIgnore(entryPath)) continue;

    if (isDocumentExt(ext)) {
      // Binary document — carry raw bytes as base64 (same contract as extractZip)
      files.push({ path: entryPath, content: entry.data.toString('base64'), encoding: 'base64' });
      continue;
    }

    files.push({ path: entryPath, content: entry.data.toString('utf8') });
  }

  if (skippedOversize) console.warn(`[UPLOAD] Skipped ${skippedOversize} oversize archive entries (> ${MAX_ENTRY_BYTES / 1e6} MB each)`);
  return files;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract any supported archive format into the rawFiles shape ingestFiles()
 * consumes.
 *
 * @param {Buffer} buffer  - raw archive bytes
 * @param {'zip'|'tar'|'tar.gz'|'gz'} format
 * @returns {Promise<Array<{ path: string, content: string, encoding?: 'base64' }>>}
 * @throws {Error} corrupt archive / bomb budget exceeded / password-protected
 */
export async function extractArchive(buffer, format) {
  switch (format) {
    case 'zip': {
      const { default: AdmZip } = await import('adm-zip');
      let zip;
      try {
        zip = new AdmZip(buffer);
      } catch (err) {
        throw new Error(`Corrupted or unreadable ZIP archive: ${err.message}`);
      }
      const zipEntries = zip.getEntries();
      if (zipEntries.length > MAX_ENTRIES) {
        throw new Error(`Archive has ${zipEntries.length} entries (limit ${MAX_ENTRIES}). Remove build artifacts (node_modules, dist) before zipping.`);
      }
      const entries = [];
      for (const e of zipEntries) {
        if (e.isDirectory) continue;
        // Password-protected ZIPs: adm-zip's getData() throws or returns empty
        // on encrypted entries — surface a clear error instead of silence.
        if (e.header?.flags & 0x1) {
          throw new Error('Archive is password-protected. Remove the password and re-upload.');
        }
        const declared = e.header?.size ?? 0;
        if (declared > MAX_ENTRY_BYTES) continue; // pre-filter before decompressing
        let data;
        try { data = e.getData(); } catch { continue; }
        entries.push({ name: e.entryName, data });
      }
      return entriesToRawFiles(entries);
    }

    case 'tar': {
      const entries = parseTar(buffer);
      if (entries.length > MAX_ENTRIES) {
        throw new Error(`Archive has ${entries.length} entries (limit ${MAX_ENTRIES}).`);
      }
      return entriesToRawFiles(entries);
    }

    case 'tar.gz':
    case 'gz': {
      let inflated;
      try {
        inflated = await gunzip(buffer, { maxOutputLength: Math.min(MAX_TOTAL_BYTES, buffer.length * MAX_GZIP_RATIO) });
      } catch (err) {
        if (err.code === 'ERR_BUFFER_TOO_LARGE' || /output length/i.test(err.message)) {
          throw new Error('Gzip stream expands beyond the extraction budget — refusing to decompress.');
        }
        throw new Error(`Corrupted gzip stream: ${err.message}`);
      }
      // .tgz / .tar.gz — the inflated payload should be a TAR. A bare .gz of
      // a single file is legal too: fall back to treating the payload as one file.
      try {
        const entries = parseTar(inflated);
        if (entries.length > 0) {
          if (entries.length > MAX_ENTRIES) throw new Error(`Archive has ${entries.length} entries (limit ${MAX_ENTRIES}).`);
          return entriesToRawFiles(entries);
        }
      } catch (tarErr) {
        if (format === 'tar.gz') throw new Error(`Invalid .tar.gz: ${tarErr.message}`);
      }
      // Bare gzip of one file
      return entriesToRawFiles([{ name: 'extracted-file', data: inflated }]);
    }

    default:
      throw new Error(`Unsupported archive format: ${format}`);
  }
}
