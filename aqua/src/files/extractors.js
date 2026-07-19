/**
 * AQUA Knowledge Extractors — File Intelligence V1
 *
 * Pure, deterministic, dependency-free heuristics that turn extracted text
 * into the UKO knowledge fields (keywords, entities, timeline, facts,
 * topics, summary). Deliberately NOT model calls: this phase builds the
 * architecture; each extractor is one enrichment stage's worker and each
 * stage is independently replaceable — a later phase swaps any of these for
 * an LLM/JSON-mode extractor behind the same signature without touching
 * the pipeline (the exact modularity the design demands).
 *
 * Every function: (text | uko-ish input) → data. No I/O, no state, no
 * randomness — trivially testable, safe to cache by content hash.
 */

// ── Keywords ─────────────────────────────────────────────────────────────────

const STOPWORDS = new Set(('a,an,the,and,or,but,if,then,else,of,in,on,at,to,for,from,by,with,as,is,are,was,were,be,been,'
  + 'being,it,its,this,that,these,those,i,you,he,she,we,they,them,his,her,our,your,their,not,no,yes,do,does,did,done,'
  + 'so,than,too,very,can,could,will,would,should,may,might,must,shall,have,has,had,there,here,what,when,where,which,'
  + 'who,whom,why,how,all,any,both,each,few,more,most,other,some,such,only,own,same,just,also,into,over,under,about,'
  + 'after,before,between,during,through,per,via,none,nan,null,true,false').split(','));

const WORD_RE = /[A-Za-z][A-Za-z0-9_\-']{2,}/g;

/** Top-N terms by frequency, stopword-filtered, case-folded. */
export function extractKeywords(text, { limit = 15 } = {}) {
  if (!text) return [];
  const counts = new Map();
  for (const m of text.matchAll(WORD_RE)) {
    const term = m[0].toLowerCase();
    if (STOPWORDS.has(term)) continue;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 2 || counts.size < 20)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term, count]) => ({ term, count }));
}

// ── Entities ─────────────────────────────────────────────────────────────────

const ENTITY_PATTERNS = [
  ['email',    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ['url',      /\bhttps?:\/\/[^\s)>'"\]]+/g],
  ['money',    /(?:₹|\$|€|£)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:lakh|crore|million|billion|k|m|bn))?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|INR|EUR|GBP)\b/g],
  ['date',     /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,?\s+\d{4})?|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?(?:\s+\d{4})?)\b/g],
  ['time',     /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM|am|pm)?\b/g],
  ['version',  /\bv?\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.]+)?\b(?=\s|$|[,.)\]])/g],
  ['filename', /\b[\w\-.]+\.(?:js|ts|tsx|jsx|py|java|go|rs|json|yaml|yml|md|pdf|docx|pptx|xlsx|csv|png|jpe?g|mp4|mp3|wav|zip|html|css|sql|sh)\b/g],
];

// Proper-noun runs: 1-4 Capitalized words, not sentence-initial-only noise.
const PROPER_RE = /\b([A-Z][a-zA-Z0-9&']+(?:\s+[A-Z][a-zA-Z0-9&']+){0,3})\b/g;

/**
 * Typed entity extraction with counts. Proper-noun candidates require ≥2
 * occurrences OR ≥2 words (single capitalized words appear at every
 * sentence start — frequency separates "The" noise from "Aquiplex").
 */
export function extractEntities(text, { limit = 40 } = {}) {
  if (!text) return [];
  const found = new Map(); // `${type}:${value}` → { type, value, count }
  const bump = (type, value) => {
    const v = value.trim();
    if (!v) return;
    const k = `${type}:${v.toLowerCase()}`;
    const e = found.get(k) ?? { type, value: v, count: 0 };
    e.count += 1;
    found.set(k, e);
  };

  for (const [type, re] of ENTITY_PATTERNS) {
    for (const m of text.matchAll(re)) bump(type, m[0]);
  }

  const properCounts = new Map();
  for (const m of text.matchAll(PROPER_RE)) {
    const v = m[1].trim();
    if (v.length < 3) continue;
    if (v.split(/\s+/).every(w => STOPWORDS.has(w.toLowerCase()))) continue;
    properCounts.set(v, (properCounts.get(v) ?? 0) + 1);
  }
  for (const [v, count] of properCounts) {
    if (count >= 2 || v.includes(' ')) {
      const e = { type: 'name', value: v, count };
      found.set(`name:${v.toLowerCase()}`, e);
    }
  }

  return [...found.values()]
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, limit);
}

// ── Timeline ─────────────────────────────────────────────────────────────────

const SCENE_LINE_RE = /^(?:[-•*]\s*)?(\d{1,2}:\d{2}(?::\d{2})?)\s*[—\-–:]?\s*(.{4,160})$/;

/**
 * Ordered events from (a) media SCENES/timestamped lines and (b) dated
 * sentences in text. `source` records which extractor produced each event.
 */
export function extractTimeline(text, sections = []) {
  const events = [];

  const sceneSections = sections.filter(s => /SCENE|TIMELINE|CHRONOLOG/i.test(s.heading ?? ''));
  for (const s of sceneSections) {
    for (const line of (s.text ?? '').split('\n')) {
      const m = line.trim().match(SCENE_LINE_RE);
      if (m) events.push({ ts: m[1], event: m[2].trim(), source: 'scenes' });
    }
  }

  if (text) {
    const dateRe = ENTITY_PATTERNS.find(([t]) => t === 'date')[1];
    for (const sentence of text.split(/(?<=[.!?])\s+/).slice(0, 400)) {
      const m = sentence.match(new RegExp(dateRe.source));
      if (m && sentence.length <= 300) {
        events.push({ ts: m[0], event: sentence.trim(), source: 'dated-sentence' });
        if (events.length >= 60) break;
      }
    }
  }

  return events.map((e, i) => ({ order: i, ...e }));
}

// ── Facts ────────────────────────────────────────────────────────────────────

/**
 * Candidate atomic facts: sentences that carry at least one extracted
 * entity AND a number/date/money mention — the sentences cross-file
 * reasoning will want to join on later. Capped hard; this is a seed, not
 * an exhaustive claim extractor.
 */
export function extractFacts(text, entities, { limit = 20 } = {}) {
  if (!text || !entities.length) return [];
  const values = entities.filter(e => e.type === 'name' || e.type === 'filename').map(e => e.value);
  if (!values.length) return [];
  const numeric = /\d/;
  const facts = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (sentence.length < 15 || sentence.length > 300 || !numeric.test(sentence)) continue;
    const hit = values.filter(v => sentence.includes(v));
    if (hit.length) {
      facts.push({ text: sentence.trim(), entities: hit.slice(0, 5), source: 'heuristic' });
      if (facts.length >= limit) break;
    }
  }
  return facts;
}

// ── Topics + summary ─────────────────────────────────────────────────────────

/** Coarse topics: section headings first, top keywords as fallback. */
export function deriveTopics(sections, keywords, { limit = 8 } = {}) {
  const topics = [];
  for (const s of sections) {
    const h = (s.heading ?? '').trim();
    if (h && h.length <= 60 && !/^(TEXT|OCR|TRANSCRIPT|SUMMARY|DETAILS|SPECIAL|NOTES)\b/i.test(h)) {
      topics.push({ topic: h, weight: 1 });
    }
  }
  for (const k of keywords.slice(0, limit)) {
    if (!topics.some(t => t.topic.toLowerCase() === k.term)) {
      topics.push({ topic: k.term, weight: k.count });
    }
  }
  return topics.slice(0, limit);
}

/** First meaningful sentences, ≤ maxChars — the memory-card summary. */
export function shortSummary(text, { maxChars = 240 } = {}) {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= maxChars ? clean : clean.slice(0, maxChars - 1) + '…';
}
