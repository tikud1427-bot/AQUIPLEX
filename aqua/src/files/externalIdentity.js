/**
 * AQUA — external resource identity (Phase 1a.2)
 *
 * WHY A DETERMINISTIC IDENTITY
 * ----------------------------
 * Uploaded files are identified by a random UKO id and, in file memory and the
 * chunk index, by their lowercased NAME (memory/engine.js fileKey). That is fine
 * for uploads and wrong for anything synchronised from an external source: two
 * repositories both have a README.md, a re-sync must find the file it already
 * imported, and "delete everything that came from source S" must be answerable
 * even for a sync that crashed half-way (before its UKO was saved).
 *
 * So every external resource gets ids DERIVED from where it came from:
 *
 *   sourceId    the connector's stable source identifier   e.g. "github:inst-123", "fake:alpha"
 *   externalId  the resource's id inside that source        e.g. "repo/acme/README.md", "drive:1AbC"
 *   version     the content hash of this version's bytes
 *
 *   ukoId    ext_<sourceTag>_<itemTag>_<versionTag>    (UKO, evidence links, search index, graph, PIC)
 *   fileKey  ext:<sourceTag>:<itemTag>:<versionTag>    (file memory entry, chunk vectors)
 *
 * sourceTag = h(sourceId), itemTag = h(sourceId, externalId): the SOURCE and the
 * ITEM can each be found by prefix in every store, with no registry to keep in
 * step and nothing a crash can leave unreachable. The version tag lets a new
 * version be ingested beside the old one and the old one removed only after the
 * new one succeeded — a failed update never destroys the version that worked.
 *
 * Pure: no I/O, no imports beyond node:crypto, safe to import from any store.
 */
import crypto from 'node:crypto';

export const EXTERNAL_UKO_PREFIX = 'ext_';
export const EXTERNAL_KEY_PREFIX = 'ext:';

const h = (s, n) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, n);

const SOURCE_ID_RE = /^[a-z][a-z0-9._-]{0,40}:[^\s\u0000-\u001f\u007f]{1,160}$/;

/** Throws a TypeError unless sourceId/externalId are well-formed. */
export function assertSourceRef(sourceId, externalId) {
  if (typeof sourceId !== 'string' || !SOURCE_ID_RE.test(sourceId)) {
    throw new TypeError('sourceId must look like "<connector>:<scope>" (lowercase connector name, no whitespace or control characters, ≤ 200 chars)');
  }
  if (externalId !== undefined) {
    if (typeof externalId !== 'string' || !externalId.length || externalId.length > 512 || /[\u0000-\u001f\u007f]/.test(externalId)) {
      throw new TypeError('externalId must be a non-empty string of at most 512 characters without control characters');
    }
  }
}

export const sourceTag = sourceId => h(sourceId, 12);
export const itemTag = (sourceId, externalId) => h(`${sourceId}\u0000${externalId}`, 16);
export const versionTag = contentHash => String(contentHash).replace(/[^a-f0-9]/gi, '').slice(0, 12).toLowerCase();

/** Every id one version of one external resource uses. */
export function externalIdentity(sourceId, externalId, contentHash) {
  assertSourceRef(sourceId, externalId);
  const s = sourceTag(sourceId), i = itemTag(sourceId, externalId), v = versionTag(contentHash);
  if (!v) throw new TypeError('externalIdentity: a content hash is required');
  return {
    sourceTag: s, itemTag: i, versionTag: v,
    ukoId:   `${EXTERNAL_UKO_PREFIX}${s}_${i}_${v}`,
    fileKey: `${EXTERNAL_KEY_PREFIX}${s}:${i}:${v}`,
  };
}

/** Id prefixes that match every version of every resource from one source. */
export function sourcePrefixes(sourceId) {
  assertSourceRef(sourceId);
  const s = sourceTag(sourceId);
  return { ukoPrefix: `${EXTERNAL_UKO_PREFIX}${s}_`, keyPrefix: `${EXTERNAL_KEY_PREFIX}${s}:` };
}

/** Id prefixes that match every version of ONE resource. */
export function itemPrefixes(sourceId, externalId) {
  assertSourceRef(sourceId, externalId);
  const s = sourceTag(sourceId), i = itemTag(sourceId, externalId);
  return { ukoPrefix: `${EXTERNAL_UKO_PREFIX}${s}_${i}_`, keyPrefix: `${EXTERNAL_KEY_PREFIX}${s}:${i}:` };
}

/** Storage class of a UKO / evidence sourceFileId / index entry. */
export const isExternalFileId = id => typeof id === 'string' && id.startsWith(EXTERNAL_UKO_PREFIX);
/** Storage class of a file-memory key / chunk fileKey. */
export const isExternalFileKey = key => typeof key === 'string' && key.startsWith(EXTERNAL_KEY_PREFIX);
