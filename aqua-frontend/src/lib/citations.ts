/**
 * Citation utilities — pure, dependency-free.
 *
 * The backend's web-search context tells the model to "Cite sources as [n]";
 * models often emit a richer internal token — `[1†L1-L3]` (dagger + line
 * range), grouped `[1, 2]`, or plain `[3]`. These are INTERNAL reference
 * markers and must never reach the reader. This module:
 *
 *   1. stripCitationMarkers() — removes those markers from prose while leaving
 *      code (fenced + inline) and markdown link syntax `[text](url)` intact.
 *   2. hostnameOf / faviconUrl — derive display data from a source URL. Nothing
 *      is hardcoded per-source; the favicon endpoint is a single swappable
 *      constant parameterised by hostname.
 *   3. dedupeSources — collapse citations that point at the same page
 *      (protocol / www / trailing-slash / hash-insensitive), first wins.
 *
 * Source of truth for the source list is the backend's structured
 * `search.sources` ({ n, title, url }) — see SearchSource in types/api.ts.
 * Text is only ever parsed to REMOVE markers, never to reconstruct sources.
 */

import type { SearchSource } from '@/types';

// Complete marker: [n] · [n†…] · [n, m, …] — but NOT `[n](url)` (markdown link,
// guarded by the negative lookahead) and NOT `[x]` / `[ ]` (task lists — the
// `\d+` requirement excludes them).
const CITATION_MARKER =
  /\[\s*\d+(?:†[^\]]*)?(?:\s*,\s*\d+(?:†[^\]]*)?)*\s*\](?!\()/g;

// A marker still being typed at the very end of a streaming buffer
// (`…as of [1†L1-L` before the closing `]` arrives). Anchored to end + requires
// `[` followed by a digit, so it can't eat a legitimate trailing bracket; the
// leading \s* also removes the now-orphaned space before it.
const TRAILING_PARTIAL = /\s*\[\s*\d+(?:†[^\]]*)?$/;

// Fenced ```…``` and inline `…` code — captured so String.split keeps them as
// verbatim segments we never touch.
const CODE_SEGMENT = /(```[\s\S]*?```|`[^`\n]*`)/g;

/**
 * Remove internal citation markers from `text`, preserving code spans and
 * markdown links. Pass { streaming:true } to also drop a half-typed trailing
 * marker so it doesn't flicker while tokens arrive.
 */
export function stripCitationMarkers(text: string, opts?: { streaming?: boolean }): string {
  if (!text) return text;

  const segments = text.split(CODE_SEGMENT);
  const out = segments.map((seg, i) => {
    if (i % 2 === 1) return seg; // odd indices are captured code — leave exactly as-is
    let s = seg.replace(CITATION_MARKER, '');
    if (opts?.streaming) s = s.replace(TRAILING_PARTIAL, '');
    // Tidy whitespace the removed markers leave behind: " word ." → " word.",
    // and collapse the double space left by a mid-sentence "word [1] more".
    // (Note: `]` is intentionally NOT in the tidy set — it would eat the space
    // inside a GFM task-list `[ ]`, which the citation regex already skips.)
    s = s.replace(/[ \t]+([.,;:!?)])/g, '$1').replace(/[ \t]{2,}/g, ' ');
    return s;
  });
  return out.join('');
}

/** True when `text` contains at least one internal citation marker. */
export function hasCitationMarkers(text: string): boolean {
  CITATION_MARKER.lastIndex = 0;
  return CITATION_MARKER.test(text);
}

/** Hostname without a leading www., falling back gracefully on unparseable URLs. */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^[a-z]+:\/\//i, '').split('/')[0] || url;
  }
}

// Single swappable favicon endpoint — parameterised by hostname, not per-source.
const FAVICON_ENDPOINT = (host: string, size: number) =>
  `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=${size}`;

/** Favicon image URL for a source, derived from its hostname. */
export function faviconUrl(url: string, size = 64): string {
  return FAVICON_ENDPOINT(hostnameOf(url), size);
}

/** Normalise a URL for equality: drop protocol, www., trailing slash, hash. */
function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.hostname.replace(/^www\./, '')}${path}${u.search}`.toLowerCase();
  } catch {
    return url.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  }
}

/** Deduplicate sources pointing at the same page; first occurrence wins. */
export function dedupeSources(sources: SearchSource[] | undefined): SearchSource[] {
  if (!sources?.length) return [];
  const seen = new Set<string>();
  const out: SearchSource[] = [];
  for (const s of sources) {
    if (!s?.url) continue;
    const key = canonicalUrl(s.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}