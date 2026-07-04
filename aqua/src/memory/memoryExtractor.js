/**
AQUA Memory Extractor v3.1 — Orchestrator
*/
import { parseMessage } from './sentenceParser.js';
import { extractAllCandidates } from './candidateExtractor.js';
import { normalizeCandidates } from './entityNormalizer.js';
import { deduplicateIntraMessage } from './duplicateDetector.js';
import { resolveCandidates, RESOLUTION_ACTIONS } from './memoryResolver.js';
import { detectCorrection, CORRECTION_PHRASES } from './memoryConflictResolver.js';
import { getSchema, getWordIndex } from './memorySchema.js';

export { detectCorrection, CORRECTION_PHRASES } from './memoryConflictResolver.js';

/**
 * Fuzzy-resolve a user-provided key to the closest canonical schema key.
 * e.g. "preferred language" → "favorite_language", "score" → "score" (falls back)
 */
export function resolveCanonicalKey(rawKey) {
  const normalized = rawKey.toLowerCase().trim().replace(/\s+/g, '_');
  // Direct hit
  const direct = getSchema(normalized);
  if (direct) return direct.key;
  // Word-index fuzzy match — key words score 3, alias words 2, hint words 1
  const wordIndex = getWordIndex();
  const words = normalized.split('_').filter(w => w.length > 1);
  const scores = new Map();
  for (const word of words) {
    const hits = wordIndex.get(word);
    if (hits) {
      for (const k of hits) {
        const schema = getSchema(k);
        if (!schema) continue;
        const inKey     = schema.key.split('_').includes(word);
        const inAlias   = (schema.aliases || []).some(a => a.split('_').includes(word));
        const score     = inKey ? 3 : inAlias ? 2 : 1;
        scores.set(k, (scores.get(k) || 0) + score);
      }
    }
  }
  if (scores.size === 0) return normalized;
  let best = null, bestScore = 0;
  for (const [k, score] of scores) {
    if (score > bestScore) { bestScore = score; best = k; }
  }
  return best || normalized;
}

const log = {
  info: (msg, ...args) => console.log(`[AQUA Pipeline] ${msg}`, ...args),
  debug: (msg, ...args) => console.debug(`[AQUA Pipeline] ${msg}`, ...args),
};

const FORGET_PATTERNS = [/forget (?:that )?(?:my )?(.+)/i, /don't remember (?:that )?(?:my )?(.+)/i];
const UPDATE_PATTERNS = [/(?:actually|correction|update)[,:]?\s+my ([a-zA-Z\s]+?) is now ([a-zA-Z0-9\s]+)/i];

export function extractFactsWithReport(message, conversationId = null) {
  const t0 = Date.now();
  log.info('Pipeline started', { messageLength: message.length, conversationId });
  
  const report = {
    candidates: 0, accepted: 0, rejected: 0, duplicates: 0,
    updated: 0, overwritten: 0, merged: 0, stored: 0,
    averageConfidence: 0, categories: new Set(), processingTimeMs: 0,
  };

  // 1. Parse
  const parsed = parseMessage(message);
  if (parsed.sentences.length === 0) {
    report.processingTimeMs = Date.now() - t0;
    return { facts: [], report: finalizeReport(report) };
  }

  // 2. Extract candidates (includes Personal Statement Detector & Custom Fallback)
  const rawCandidates = extractAllCandidates(parsed);
  report.candidates = rawCandidates.length;
  if (rawCandidates.length === 0) {
    report.processingTimeMs = Date.now() - t0;
    return { facts: [], report: finalizeReport(report) };
  }

  // 3. Normalize + validate
  const { accepted, rejected } = normalizeCandidates(rawCandidates);
  report.accepted = accepted.length;
  report.rejected += rejected.length;
  if (accepted.length === 0) {
    report.processingTimeMs = Date.now() - t0;
    return { facts: [], report: finalizeReport(report) };
  }

  // 4. Intra-message dedup
  const { unique, duplicates } = deduplicateIntraMessage(accepted);
  report.duplicates += duplicates.length;
  log.debug(`Deduplicated: ${unique.length} unique, ${duplicates.length} duplicates`);

  // 5. Resolve against stored facts
  let toStore = unique;
  if (conversationId) {
    const resolved = resolveCandidates(conversationId, unique);
    toStore = [];
    for (const r of resolved) {
      switch (r.action) {
        case RESOLUTION_ACTIONS.STORE_NEW: report.stored++; toStore.push(r); break;
        case RESOLUTION_ACTIONS.OVERWRITE:
        case RESOLUTION_ACTIONS.CORRECTION: report.overwritten++; toStore.push(r); break;
        case RESOLUTION_ACTIONS.MERGE: report.merged++; toStore.push(r); break;
        case RESOLUTION_ACTIONS.DUPLICATE: report.duplicates++; toStore.push({ ...r, _isDuplicate: true }); break;
        case RESOLUTION_ACTIONS.REJECT_LOW_CONF: report.rejected++; break;
      }
      report.categories.add(r.category);
    }
  } else {
    for (const c of unique) {
      report.stored++;
      report.categories.add(c.category);
    }
  }

  // 6. Map to legacy Fact shape
  const facts = toStore.map(toLegacyFact);

  // 7. Average confidence
  if (facts.length > 0) {
    const sum = facts.reduce((s, f) => s + (f.confidence || 0), 0);
    report.averageConfidence = sum / facts.length;
  }

  report.processingTimeMs = Date.now() - t0;
  log.info('Pipeline finished', { finalCount: facts.length, timeMs: report.processingTimeMs });
  
  return { facts, report: finalizeReport(report) };
}

export function extractFacts(message) {
  const { facts } = extractFactsWithReport(message);
  return facts;
}

export function extractCandidates(message) {
  const parsed = parseMessage(message);
  const raw = extractAllCandidates(parsed);
  const { accepted } = normalizeCandidates(raw);
  return accepted;
}

export function detectMemoryUpdate(message) {
  for (const p of UPDATE_PATTERNS) {
    const m = message.match(p);
    if (m) return { isUpdate: true, key: m[1].toLowerCase().trim().replace(/\s+/g, '_'), value: m[2].trim() };
  }
  return { isUpdate: false };
}

export function detectForget(message) {
  for (const p of FORGET_PATTERNS) {
    const m = message.match(p);
    if (m) return { isForget: true, hint: m[1]?.trim() };
  }
  return { isForget: false };
}

function toLegacyFact(resolved) {
  const value = resolved.mergedValue !== undefined ? resolved.mergedValue : resolved.normalizedValue;
  return {
    key: resolved.key, value, confidence: resolved.confidence, importance: resolved.importance || 5,
    sourceText: (resolved.rawText || '').slice(0, 200), ts: resolved.ts || Date.now(), isCorrection: !!resolved.isCorrection,
    category: resolved.category, normalizedValue: resolved.normalizedValue, sentence: resolved.sentence,
    reason: resolved.reason, action: resolved.action, previousValue: resolved.previousValue, _isDuplicate: resolved._isDuplicate,
    // Memory Confidence Engine (Phase 6): self-contained provenance, carried
    // through longTermMemory's upgradeFact() metadata passthrough.
    metadata: {
      validationStatus: resolved.validationStatus || 'validated',
      entityType: resolved.category,
      sourceSentence: resolved.sentence,
      confidence: resolved.confidence,
    },
  };
}

function finalizeReport(report) {
  return { ...report, categories: Array.from(report.categories) };
}