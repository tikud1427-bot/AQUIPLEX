/**
AQUA Candidate Extractor v3.1
*/
import { MEMORY_SCHEMA, getSchema, CATEGORIES, CONFLICT_POLICIES } from './memorySchema.js';
import { goalParts } from '../mind/goalText.js';
import { splitClauses } from './sentenceParser.js';

const log = {
  debug: (msg, ...args) => console.debug(`[AQUA Extractor] ${msg}`, ...args),
};

// ── Personal Statement Detector ───────────────────────────────────────────────
function isPersonalStatement(sentence) {
  // v3 (Extraction Audit): "This is John" is a self-introduction with no
  // first-person pronoun — allow the greeting form through the gate.
  // v4 (Cognitive Identity): "Also known as CP" / "aka CP" are self-referential
  // alias declarations, also pronoun-free — let them through too.
  return /\b(i|my|me|mine|we|our|us|myself|i'm|i've|i'll|i'd)\b/i.test(sentence)
      || /^(?:hi|hey|hello|yo|greetings)?[,!.\s]*this is\b/i.test(sentence)
      || /^\s*(?:also known as|a\.?k\.?a\.?\b)/i.test(sentence);
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
// v3 (Extraction Audit): widening the fallback to "i'm X" made transient
// states ("I'm sure/tired/busy…") storable as custom_trait. Moods are not
// durable memories.
// The same rule for situations of the moment (2026-11-02): "I'm in a rush"
// was stored as `custom_in_a_rush` — one turn's circumstance as a lasting fact.
const TRANSIENT_PHRASE = /^(?:in\s+a\s+(?:rush|hurry|meeting|bit\s+of\s+a\s+rush)|on\s+(?:my|the)\s+way|running\s+late|on\s+a\s+call|in\s+between\s+meetings|driving)\b/i;
const TRANSIENT_STATE = /^(sure|tired|busy|happy|sad|fine|okay|ok|good|great|glad|sorry|ready|done|back|free|late|early|lost|stuck|confused|curious|excited|afraid|scared|bored|hungry|thirsty|sick|well|here|there|home|away|online|offline|not|no|so|just|about|almost|kind|sort)\b/i;

// v4 (Cognitive Identity): stable, collision-free key from free text. The old
// fallback stored EVERY "I'm X" trait under the single key `custom_trait` with
// an OVERWRITE policy, so two unrelated traits ("I'm a night owl", later "I'm
// left-handed") clobbered each other — and worse, any identity phrase that
// slipped past the schema landed here and was later destroyed by the next
// custom fact. Deriving the key from the value gives each trait its own field.
function customSlug(value) {
  return 'custom_' + String(value).toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

// The value of "my X is Y" runs to the end of its CLAUSE (2026-10-29). It used
// to stop at the first character outside [a-z0-9 ], so the profile stored
// "Dr" for "Dr. Helen Moss", "stuck because the hospital R" for "…R&D office…"
// and "to get Splitpay to 50" for "…50,000 monthly active users" — and the
// prompt presents the profile as what to rely on. A clause ends at ";", a
// dash, or a comma before a word (not "50,000" or "December 15, 2026").
function clauseValue(raw) {
  return String(raw).split(/;|\s[—–-]\s|,\s+(?!\d)/)[0].replace(/[.!?…]+$/, '').trim().slice(0, 160);
}

/**
 * The key for a relationship or role the user names ("my accountant", "our
 * biggest client", "Jordan is my co-founder"). A word the schema already knows —
 * a key or one of its aliases ("co-founder" → cofounder, "company" → workplace,
 * "employer" → workplace) — is that key, with its validator and policy; any
 * other is its own custom key, as before. Words that place the role rather than
 * name it ("my manager THERE") are not part of it.
 */
const ROLE_FILLER = /\s+(?:there|here|now|currently|these days|at work|at the moment)$/i;
// Roles that relate the user to a person or an organisation (the inverse form "X is my <role>").
const RELATION_HEAD = /^(?:client|customer|partner|co-?founder|founder|manager|boss|mentor|mentee|accountant|lawyer|attorney|doctor|dentist|therapist|advisor|adviser|investor|landlord|tenant|friend|wife|husband|spouse|fianc[eé]e?|girlfriend|boyfriend|sister|brother|sibling|mother|mom|mum|father|dad|son|daughter|cousin|aunt|uncle|competitor|rival|supplier|vendor|employer|company|bank|agent|coach|teacher|tutor|assistant|colleague|coworker|contact|sponsor|lead|owner|neighbou?r|roommate|flatmate|recruiter|banker|broker|officer|editor|publisher|agency|distributor|reseller|nanny|vet|pediatrician|surgeon|nurse|trainer)s?$/i;
const flat = s => String(s).toLowerCase().replace(/[^a-z]/g, '');
let ALIAS_INDEX = null;
function schemaForRole(role) {
  if (!ALIAS_INDEX) {
    ALIAS_INDEX = new Map();
    for (const s of MEMORY_SCHEMA) for (const name of [s.key, ...(s.aliases ?? [])]) if (!ALIAS_INDEX.has(flat(name))) ALIAS_INDEX.set(flat(name), s);
  }
  return ALIAS_INDEX.get(flat(role)) ?? null;
}
function roleCandidate(role, value, sentence, ctx) {
  const r = String(role).trim().replace(ROLE_FILLER, '');
  const schema = schemaForRole(r);
  // A known slot holds a NAME: "my company is growing fast" says nothing about which company.
  if (schema && !/^[\p{Lu}\d]/u.test(String(value).trim())) return null;
  if (schema && !schema.compoundPatterns) return makeCandidate(schema, value, sentence, { reason: 'named_role', confidence: 0.85, ctx });
  return {
    extractor: 'custom_fallback',
    // The user's casing is kept, as before: the label is built from the key ("ETH application").
    category: CATEGORIES.CUSTOM, key: `custom_${r.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`, value, normalizedValue: value,
    confidence: 0.7, rawText: sentence, sentence, reason: 'custom_fact',
    isCorrection: !!ctx.isCorrection, ts: ctx.ts || Date.now(),
    multiValue: false, conflictPolicy: CONFLICT_POLICIES.OVERWRITE, importance: 4,
  };
}

function extractCustomFacts(sentence, ctx) {
  const candidates = [];
  // A question states nothing: "How is my half marathon goal going?" became
  // custom_half_marathon_goal_going = "How" through the inverse pattern below.
  if (/\?\s*$/.test(sentence) || /^\s*(?:how|what|who|whom|whose|where|when|why|which|is|are|was|were|do|does|did|can|could|should|would|will|have|has)\b/i.test(sentence)) return [];
  // "Jordan is my co-founder", "Northbeam is our client": the same relationship, said the other way round.
  // Only for a RELATIONSHIP — a role that connects the user to a person or an organisation. Every
  // sentence opens on a capital, so "Growth is my top priority this quarter" looked the same and
  // became custom_top_priority_this_quarter = "Growth" (capture-core supersede-priority, 2026-11-04).
  const inverse = sentence.match(/^\s*([A-Z][\w&.'-]*(?:\s+(?:[A-Z][\w&.'-]*|&|and|of)){0,4}) is (?:my|our) ([a-z][a-z\s-]{1,30}?)\s*[.!?]?\s*$/);
  if (inverse && RELATION_HEAD.test(inverse[2].trim().split(/\s+/).at(-1))) return [roleCandidate(inverse[2], inverse[1].trim(), sentence, ctx)].filter(Boolean);
  const owned = sentence.match(/\b(?:my|our) ([a-z][a-z\s-]*?) is (\S.*)/i);
  if (owned) {
    const value = clauseValue(owned[2]);
    if (value) return [roleCandidate(owned[1], value, sentence, ctx)].filter(Boolean);
  }
  const patterns = [
    // Per-value key (was the single collision-prone `custom_trait`).
    { regex: /i(?:'m| am) (?:a |an )?([a-z\s]+?)(?:\s*[,.]|$)/i, keyGen: (m) => customSlug(m[1].trim()), valGen: (m) => m[1].trim(), guard: (v) => !ACTIVITY_STATEMENT.test(v) && !TRANSIENT_STATE.test(v) && !TRANSIENT_PHRASE.test(v) },
  ];
  
  for (const p of patterns) {
    const m = sentence.match(p.regex);
    if (m) {
      const key = p.keyGen(m);
      const value = p.valGen(m);
      if (value && value.length > 0 && (!p.guard || p.guard(value))) {
        candidates.push({
          extractor: 'custom_fallback',
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
// ── Uncertainty the user states (2026-11-05) ──────────────────────────────────
// "I'm not sure if I'm still leading the Atlas migration" asserts nothing: the
// fallback stored it as `still leading the Atlas migration`, the opposite of what
// was said. Such a clause yields no fact (the words stay quotable in recall).
// "I think I work at Halcyon Labs" asserts a value the user is unsure of: it is
// kept, marked `hedged`, and never replaces a confirmed value (memoryExtractor).
const NOT_SURE_CLAUSE = /\b(?:i'?m|i am)\s+not\s+(?:sure|certain)\b|\bnot\s+(?:sure|certain)\s+(?:if|whether)\b|\bi\s+(?:don'?t|do\s+not)\s+know\s+(?:if|whether)\b|\bunsure\s+(?:if|whether)\b|\bi\s+wonder\s+(?:if|whether)\b|\bno\s+idea\s+(?:if|whether)\b/i;
const HEDGE_CLAUSE = /\b(?:i\s+think|i\s+believe|i\s+guess|i\s+suppose|i'?m\s+fairly\s+sure|probably|maybe|perhaps|might|apparently|could\s+be)\b/i;
export function hedgeOf(sentence) {
  const s = String(sentence ?? '');
  if (NOT_SURE_CLAUSE.test(s)) return 'not_sure';
  if (HEDGE_CLAUSE.test(s)) return 'hedged';
  return null;
}

export function extractCandidatesFromSentence(sentence, ctx = {}) {
  if (!sentence || typeof sentence !== 'string') return [];

  // 1. Personal Statement Detector
  if (!isPersonalStatement(sentence) && !ctx.isCorrection) {
    return [];
  }

  const hedge = hedgeOf(sentence);
  if (hedge === 'not_sure') return [];

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

      // A goal capture runs through "and" ("become a billionaire and build a
      // company people love"), and the collection stored it as ONE item — live
      // run 2026-10-29. Same split rule as the Mind's goal tracker, so the two
      // stores never disagree about how many goals were said.
      const values = schema.key === 'goal' && typeof value === 'string' ? goalParts(value) : [value];
      for (const v of values) {
        candidates.push(makeCandidate(schema, v, sentence, { reason: pattern.reason, confidence: pattern.confidence ?? schema.baseConfidence, ctx }));
      }
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
  return candidates.map(c => adjustConfidence(hedge ? { ...c, hedged: true } : c, sentence));
}

export function extractAllCandidates(parsed) {
  const all = [];
  for (const sentence of parsed.sentences) {
    // Each clause is read on its own (sentenceParser.splitClauses), so a sentence
    // stating two facts yields two; provenance stays the whole sentence the user
    // said — what the evidence lane and the transitions quote.
    const cs = splitClauses(sentence).flatMap(clause => extractCandidatesFromSentence(clause, {
      isCorrection: parsed.isCorrection,
      correctionPhrase: parsed.correctionPhrase,
      ts: parsed.ts,
    }).map(c => ({ ...c, rawText: sentence, sentence, clause, pattern: c.reason })));
    // Instrumentation (Extraction Audit Req 3): every sentence prints what
    // matched — pattern, extractor, fact, confidence — or an explicit miss.
    if (cs.length) {
      for (const c of cs) {
        console.log(`[EXTRACTOR] MATCH sentence="${sentence.slice(0, 80)}" extractor=${c.extractor} pattern=${c.reason} → ${c.key}=${JSON.stringify(c.value)} conf=${c.confidence}`);
      }
    } else {
      console.log(`[EXTRACTOR] NO_MATCH sentence="${sentence.slice(0, 80)}" personal=${isPersonalStatement(sentence)}`);
    }
    all.push(...cs);
  }
  log.debug(`Extracted ${all.length} raw candidates from ${parsed.sentences.length} sentences`);
  return all;
}

function makeCandidate(schema, value, sentence, { reason, confidence, ctx }) {
  return {
    extractor: 'schema',
    category: schema.category, key: schema.key, value, normalizedValue: null,
    confidence, rawText: sentence, sentence, reason,
    isCorrection: !!ctx.isCorrection, correctionPhrase: ctx.correctionPhrase,
    ts: ctx.ts || Date.now(), multiValue: !!schema.multiValue,
    conflictPolicy: schema.conflictPolicy, importance: schema.importance,
  };
}