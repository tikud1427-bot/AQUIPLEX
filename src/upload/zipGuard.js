/**
 * AQUA ZIP Guard — the one bounded doorway for reading ZIP containers
 * Blueprint E1/PR-3
 *
 * WHY THIS EXISTS
 * ---------------
 * Five code paths read attacker-supplied ZIP containers. Before this module
 * they were guarded inconsistently, and three of them not at all:
 *
 *   archiveExtractor.extractArchive('zip')   entries ✓  size ✓  ratio ✗
 *   fileIngester.extractZip                  entries ✓  size ✓  ratio ✗
 *   documentParser.parsePptx                 entries ✗  size ✗  ratio ✗
 *   documentPipeline.parseOdt                entries ✗  size ✗  ratio ✗
 *   documentPipeline.parseEpub               entries ✗  size ✗  ratio ✗
 *
 * .pptx, .odt and .epub ARE ZIP files. They reached `new AdmZip(buffer)` with
 * no entry-count ceiling, no per-entry ceiling and no expansion ceiling, which
 * made "upload a document" the softest target in the product.
 *
 * MEASURED, on adm-zip 0.6.0 (the version E1/PR-3 upgrades to):
 *   · a header declaring 4 GiB for a 1-byte payload no longer allocates —
 *     0.6.0 returns the actual bytes. That is GHSA-xcpc-8h2w-3j85 fixed.
 *   · a 64 MiB payload at 1027:1 still extracts in full, unremarked.
 *   · 20,000 entries still parse.
 *
 * So the dependency bump closes the allocation bug and closes NOTHING about
 * expansion. Both halves are needed, which is why this module ships with it.
 *
 * WHAT IT GUARANTEES
 * ------------------
 * Every ceiling is checked against the central directory BEFORE a single byte
 * is decompressed, because a ceiling enforced after inflation is not a ceiling.
 * The one exception is the cumulative actual-bytes budget in readEntry(),
 * which exists precisely because a header can lie in the other direction —
 * declaring small and delivering large.
 *
 * DESIGN RULE
 * -----------
 * `adm-zip` is imported HERE AND NOWHERE ELSE. A second import would be a
 * second set of ceilings to keep in sync, and the drift would be silent.
 * `src/core/tests/dependencySafety.test.js` pins that invariant.
 */
import AdmZip from 'adm-zip';

/**
 * Two profiles, because an uploaded source tree and an uploaded slide deck are
 * different shapes of legitimate.
 *
 * ARCHIVE mirrors the ceilings archiveExtractor and fileIngester already
 * enforced, so those two paths change in exactly one way: ratio.
 *
 * DOCUMENT is new. A 100-slide deck with media runs to a few hundred entries;
 * 2,000 leaves generous headroom while making a 20,000-entry "document"
 * impossible.
 *
 * MAX_RATIO is 200 for both, matching the gzip guard archiveExtractor has
 * always applied to .tar.gz (MAX_GZIP_RATIO). One idea, one number — a ZIP
 * bomb and a gzip bomb are the same attack through a different container.
 * XML compresses roughly 10-30:1 and repetitive spreadsheet data can reach
 * ~100:1, so 200:1 refuses bombs without refusing real documents.
 */
export const ZIP_PROFILES = Object.freeze({
  archive: Object.freeze({
    name: 'archive',
    MAX_ENTRIES: 10_000,
    MAX_ENTRY_BYTES: 20_000_000,
    MAX_TOTAL_BYTES: 300_000_000,
    MAX_RATIO: 200,
  }),
  document: Object.freeze({
    name: 'document',
    MAX_ENTRIES: 2_000,
    MAX_ENTRY_BYTES: 25_000_000,
    MAX_TOTAL_BYTES: 100_000_000,
    MAX_RATIO: 200,
  }),
});

/** Thrown when a container violates a ceiling. Carries which one, for logs. */
export class ZipGuardError extends Error {
  constructor(message, { limit, profile, observed = null } = {}) {
    super(message);
    this.name = 'ZipGuardError';
    this.limit = limit;
    this.profile = profile;
    this.observed = observed;
  }
}

const mb = n => `${(n / 1e6).toFixed(0)} MB`;

/**
 * Open a ZIP container behind every ceiling.
 *
 * @param {Buffer} buffer
 * @param {'archive'|'document'} profileName
 * @param {object} [opts]
 * @param {string} [opts.label]  - name used in error messages ("Archive", "Presentation")
 * @returns {{
 *   entries: Array<object>,          // adm-zip entries, directories and oversize already removed
 *   skippedOversize: number,         // entries whose DECLARED size exceeded the per-entry cap
 *   readEntry: (entry: object) => Buffer,
 *   getEntry: (name: string) => object | null,
 *   profile: object,
 * }}
 * @throws {ZipGuardError} on a corrupt container or any ceiling violation
 */
export function openZip(buffer, profileName = 'archive', { label = 'Archive' } = {}) {
  const profile = ZIP_PROFILES[profileName];
  if (!profile) throw new ZipGuardError(`Unknown zip profile: ${profileName}`, { limit: 'profile' });

  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw new ZipGuardError(`Corrupted or unreadable ${label.toLowerCase()}: ${err.message}`, {
      limit: 'parse', profile: profile.name,
    });
  }

  let allEntries;
  try {
    allEntries = zip.getEntries();
  } catch (err) {
    throw new ZipGuardError(`Corrupted or unreadable ${label.toLowerCase()}: ${err.message}`, {
      limit: 'parse', profile: profile.name,
    });
  }

  // ── Ceiling 1: entry count ────────────────────────────────────────────────
  if (allEntries.length > profile.MAX_ENTRIES) {
    throw new ZipGuardError(
      `${label} has ${allEntries.length} entries (limit ${profile.MAX_ENTRIES}). Remove build artifacts (node_modules, dist) before zipping.`,
      { limit: 'entries', profile: profile.name, observed: allEntries.length },
    );
  }

  // ── Ceilings 2-4: declared sizes and expansion, before any inflation ──────
  const entries = [];
  let declaredTotal = 0;
  let skippedOversize = 0;

  for (const e of allEntries) {
    if (e.isDirectory) continue;

    // Encrypted entries: adm-zip cannot read them and the failure mode is a
    // confusing empty result. Surfaced here so all five callers say the same
    // thing rather than each inventing its own message.
    if (e.header?.flags & 0x1) {
      throw new ZipGuardError(
        `${label} is password-protected. Remove the password and re-upload.`,
        { limit: 'encrypted', profile: profile.name },
      );
    }

    const declared = e.header?.size ?? 0;
    if (declared > profile.MAX_ENTRY_BYTES) { skippedOversize++; continue; }

    declaredTotal += declared;
    if (declaredTotal > profile.MAX_TOTAL_BYTES) {
      throw new ZipGuardError(
        `${label} expands beyond the ${mb(profile.MAX_TOTAL_BYTES)} extraction budget — likely includes dependencies or binaries. Trim it and retry.`,
        { limit: 'total', profile: profile.name, observed: declaredTotal },
      );
    }
    entries.push(e);
  }

  // ── Ceiling 4: expansion ratio — the zip-bomb guard ──────────────────────
  // Measured against the WHOLE container rather than per entry: one small
  // highly-compressible file inside an otherwise ordinary archive is normal,
  // and per-entry ratios would reject it. Total expansion is the number that
  // actually describes a bomb. The per-entry ceiling above already bounds the
  // single-huge-entry case.
  const ratio = buffer.length > 0 ? declaredTotal / buffer.length : 0;
  if (ratio > profile.MAX_RATIO) {
    throw new ZipGuardError(
      `${label} expands ${ratio.toFixed(0)}× (limit ${profile.MAX_RATIO}×) — refusing to decompress a file this compressed.`,
      { limit: 'ratio', profile: profile.name, observed: Math.round(ratio) },
    );
  }

  // ── Read budget: defends the OTHER lie — declared small, delivers large ──
  let actualTotal = 0;
  const readEntry = (entry) => {
    const data = entry.getData();
    actualTotal += data.length;
    if (actualTotal > profile.MAX_TOTAL_BYTES) {
      throw new ZipGuardError(
        `${label} exceeded the ${mb(profile.MAX_TOTAL_BYTES)} extraction budget while decompressing — the archive under-reports its own size.`,
        { limit: 'actual', profile: profile.name, observed: actualTotal },
      );
    }
    return data;
  };

  return {
    entries,
    skippedOversize,
    readEntry,
    getEntry: name => entries.find(e => e.entryName === name) ?? null,
    profile,
  };
}

/**
 * Convenience for the document paths, which only ever want one named part
 * (content.xml, a slide, a chapter) and should not repeat the profile choice.
 */
export function openDocumentZip(buffer, label) {
  return openZip(buffer, 'document', { label });
}
