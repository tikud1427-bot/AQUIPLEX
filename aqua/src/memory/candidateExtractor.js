/**
AQUA Candidate Extractor v3.1
*/
import { MEMORY_SCHEMA, getSchema, CATEGORIES, CONFLICT_POLICIES } from './memorySchema.js';

const log = {
  debug: (msg, ...args) => console.debug(`[AQUA Extractor] ${msg}`, ...args),
};

// ── Personal Statement Detector ───────────────────────────────────────────────
function isPersonalStatement(sentence) {
  return /\b(i|my|me|mine|we|our|us|myself|i'm|i've|i'll|i'd)\b/i.test(sentence);
}

// ── Confidence Adjuster ───────────────────────────────────────────────────────
function adjustConfidence(candidate, sentence) {
  let conf = candidate.confidence;
  if (/\b(maybe|perhaps|guess|think|probably|might|could be|sort of|kind of)\b/i.test(sentence)) {
    conf *= 0.8; // Hedging
  }
  if (/\b(definitely|certainly|absolutely|actually|fact is|explicitly)\b/i.test(sentence)) {
    conf = Math.min(0.99, conf + 0.05); // Explicit
  }
  candidate.confidence = parseFloat(conf.toFixed(2));
  return candidate;
}

// ── Custom Fact Extractor (Fallback) ──────────────────────────────────────────
// v2 FIX (Memory Confidence Engine): "I am building an AI" / "I am coding a
// feature" describe a transient activity, not an identity/trait — they must
// never be stored. Without this guard, extractCustomFacts's "i am X" pattern
// captured the entire remainder of the sentence as custom_trait whenever the
// schema-level name pattern didn't match first (see memorySchema.js 'intro').
const ACTIVITY_STATEMENT = /^[a-z]+ing\b/i;

function extractCustomFacts(sentence, ctx) {
  const candidates = [];
  const patterns = [
    { regex: /my ([a-z\s]+?) is ([a-z0-9\s]+)/i, keyGen: (m) => `custom_${m[1].trim().replace(/\s+/g, '_')}`, valGen: (m) => m[2].trim() },
    { regex: /i am (?:a |an )?([a-z\s]+?)(?:\s*[,.]|$)/i, keyGen: () => 'custom_trait', valGen: (m) => m[1].trim(), guard: (v) => !ACTIVITY_STATEMENT.test(v) },
  ];
  
  for (const p of patterns) {
    const m = sentence.match(p.regex);
    if (m) {
      const key = p.keyGen(m);
      const value = p.valGen(m);
      if (value && value.length > 0 && (!p.guard || p.guard(value))) {
        candidates.push({
          category: CATEGORIES.CUSTOM, key, value, normalizedValue: value,
          confidence: 0.7, rawText: sentence, sentence, reason: 'custom_fact',
          isCorrection: !!ctx.isCorrection, ts: ctx.ts || Date.now(),
          multiValue: false, conflictPolicy: CONFLICT_POLICIES.OVERWRITE, importance: 4,
        });
      }
    }
  }
  return candidates;
}

// ── Main Extraction Logic ─────────────────────────────────────────────────────
export function extractCandidatesFromSentence(sentence, ctx = {}) {
  if (!sentence || typeof sentence !== 'string') return [];
  
  // 1. Personal Statement Detector
  if (!isPersonalStatement(sentence) && !ctx.isCorrection) {
    return [];
  }

  const candidates = [];
  const seenKeys = new Set();

  // 2. Schema-based Extraction
  for (const schema of MEMORY_SCHEMA) {
    if (seenKeys.has(schema.key) && !schema.multiValue) continue;

    // Compound patterns (e.g., pets) — supports global flag for matchAll
    if (Array.isArray(schema.compoundPatterns)) {
      for (const cp of schema.compoundPatterns) {
        const isGlobal = cp.regex.flags.includes('g');
        const matches = isGlobal
          ? [...sentence.matchAll(cp.regex)]
          : (() => { const m = sentence.match(cp.regex); return m ? [m] : []; })();
        
        let matched = false;
        for (const m of matches) {
          try {
            const item = cp.buildItem(m);
            if (!item) continue;
            candidates.push(makeCandidate(schema, item, sentence, { reason: cp.reason, confidence: cp.confidence ?? schema.baseConfidence, ctx }));
            matched = true;
            if (!schema.multiValue) { seenKeys.add(schema.key); break; }
          } catch (err) { /* skip malformed */ }
        }
        if (matched && !schema.multiValue) break;
      }
      continue;
    }

    // Simple & MultiKey patterns
    if (!Array.isArray(schema.patterns)) continue;
    for (const pattern of schema.patterns) {
      const m = sentence.match(pattern.regex);
      if (!m) continue;

      // MultiKey support (e.g., Location Context)
      if (pattern.multiKey) {
        try {
          const transformed = pattern.transform(m);
          if (transformed && typeof transformed === 'object') {
            for (const [key, value] of Object.entries(transformed)) {
              const subSchema = getSchema(key);
              if (subSchema) {
                candidates.push(makeCandidate(subSchema, value, sentence, { reason: pattern.reason, confidence: pattern.confidence ?? subSchema.baseConfidence, ctx }));
              }
            }
          }
        } catch (err) { /* skip */ }
        seenKeys.add(schema.key);
        break;
      }

      // Standard single value
      let value;
      try {
        value = pattern.transform ? pattern.transform(m) : (m[pattern.group ?? 1] ?? '').trim();
      } catch (err) { continue; }

      if (value === undefined || value === null || value === '') continue;
      if (typeof value === 'string' && value.length < 2) continue;

      candidates.push(makeCandidate(schema, value, sentence, { reason: pattern.reason, confidence: pattern.confidence ?? schema.baseConfidence, ctx }));
      seenKeys.add(schema.key);
      break; 
    }
  }

  // 3. Custom Fact Fallback
  if (candidates.length === 0) {
    const customFacts = extractCustomFacts(sentence, ctx);
    candidates.push(...customFacts);
  }

  // 4. Dynamic Confidence Assignment
  return candidates.map(c => adjustConfidence(c, sentence));
}

export function extractAllCandidates(parsed) {
  const all = [];
  for (const sentence of parsed.sentences) {
    const cs = extractCandidatesFromSentence(sentence, {
      isCorrection: parsed.isCorrection,
      correctionPhrase: parsed.correctionPhrase,
      ts: parsed.ts,
    });
    all.push(...cs);
  }
  log.debug(`Extracted ${all.length} raw candidates from ${parsed.sentences.length} sentences`);
  return all;
}

function makeCandidate(schema, value, sentence, { reason, confidence, ctx }) {
  return {
    category: schema.category, key: schema.key, value, normalizedValue: null,
    confidence, rawText: sentence, sentence, reason,
    isCorrection: !!ctx.isCorrection, correctionPhrase: ctx.correctionPhrase,
    ts: ctx.ts || Date.now(), multiValue: !!schema.multiValue,
    conflictPolicy: schema.conflictPolicy, importance: schema.importance,
  };
}