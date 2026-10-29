/**
AQUA Memory Retriever v4
─────────────────────────────────────────────────────────────────────────────
Semantic retrieval engine with multi-dimensional scoring, context budgeting, 
and grouped prompt injection.
*/
import { getFacts, touchRetrieved } from './longTermMemory.js';
import { sensitivePolicy, withheld } from './sensitivity.js';
import { FACT_LABELS } from './displayLabels.js';
import { failsItsSchema } from './factVisibility.js';
import { getSchema, getSchemaByCategory, getWordIndex, CATEGORIES, SEMANTIC_CONCEPTS, CATEGORY_ALIASES } from './memorySchema.js';

// ── Recall trigger detection ──────────────────────────────────────────────────
const RECALL_PATTERNS = [
  /what(?:'s| is) my \b/i, /do you (?:remember|know|recall)/i,
  /what did i (?:say|tell you|mention)/i, /i (?:told|mentioned|said) (?:you )?(?:earlier|before|that)/i,
  /what (?:was|were|is|are) my \b/i, /remember (?:when|that) i\b/i,
  /what (?:have )?you (?:learned|know) about me/i, /tell me (?:everything )?(?:you know )?about me/i,
  /what do you know about me/i,
];

export function isMemoryQuery(query) {
  return RECALL_PATTERNS.some((p) => p.test(query));
}

// ── Intent & Semantic Detection ───────────────────────────────────────────────
const CATEGORY_INTENT_PATTERNS = [
  { pattern: /\b(preference|preferences|likes|favorites|favourites|fav)\b/i, category: CATEGORIES.PREFERENCES },
  { pattern: /\b(pet|pets|dog|cat|animal|animals)\b/i, category: CATEGORIES.PETS },
  { pattern: /\b(food|foods|meal|meals|cuisine|eat|eating)\b/i, category: CATEGORIES.FOOD },
  { pattern: /\b(family|wife|husband|spouse|partner|kid|kids|children|son|daughter|brother|sister|parent|mom|dad)\b/i, category: CATEGORIES.FAMILY },
  { pattern: /\b(work|job|career|profession|employer|company|boss)\b/i, category: CATEGORIES.WORK },
  { pattern: /\b(location|city|country|live|lives|hometown|where)\b/i, category: CATEGORIES.LOCATION },
  { pattern: /\b(hobby|hobbies|interest|interests|pastime)\b/i, category: CATEGORIES.LIFESTYLE },
  { pattern: /\b(goal|goals|objective|objectives|aim|aims|ambition)\b/i, category: CATEGORIES.GOALS },
  { pattern: /\b(language|languages|programming|coding|code)\b/i, category: CATEGORIES.PROGRAMMING },
  { pattern: /\b(framework|frameworks|library|libraries|tech stack)\b/i, category: CATEGORIES.TECHNOLOGY },
  { pattern: /\b(identity|name|age|birthday|born|pronouns)\b/i, category: CATEGORIES.IDENTITY },
];

const SEMANTIC_PATTERNS = [
  { pattern: /\b(programming|coding|tech|development)\s*(stack|setup|environment|tools)\b/i, concept: 'programming stack' },
  { pattern: /\b(food|diet|eating|meals|cuisine)\b/i, concept: 'food' },
  { pattern: /\b(family|relatives|wife|husband|kids|children|parents)\b/i, concept: 'family' },
  { pattern: /\b(travel|trips|vacations|countries visited)\b/i, concept: 'travel' },
  { pattern: /\b(enjoy|like to do|hobbies|pastimes|fun)\b/i, concept: 'enjoy' },
  { pattern: /\b(entertainment|movies|books|music|media)\b/i, concept: 'entertainment' },
  { pattern: /\b(goals|ambitions|dreams|objectives)\b/i, concept: 'goals' },
];

function detectCategoryIntent(query) {
  const matches = new Set();
  for (const { pattern, category } of CATEGORY_INTENT_PATTERNS) {
    if (pattern.test(query)) matches.add(category);
  }
  const tokens = query.toLowerCase().match(/\b[a-z]+\b/g) || [];
  for (const token of tokens) {
    if (CATEGORY_ALIASES[token]) matches.add(CATEGORY_ALIASES[token]);
  }
  return matches.size > 0 ? matches : null;
}

function detectSemanticConcepts(query) {
  const concepts = new Set();
  for (const { pattern, concept } of SEMANTIC_PATTERNS) {
    if (pattern.test(query)) concepts.add(concept);
  }
  return concepts;
}

function detectKeyIntent(query) {
  const index = getWordIndex();
  const tokens = query.toLowerCase().match(/[a-z_]+/g) || [];
  const keyScores = new Map();
  for (const token of tokens) {
    const keys = index.get(token);
    if (keys) {
      for (const key of keys) {
        keyScores.set(key, (keyScores.get(key) || 0) + 1);
      }
    }
  }
  return keyScores;
}

// ── Multi-Dimensional Scoring ─────────────────────────────────────────────────
// Returns { score, intentScore }: intentScore is the portion earned from the
// QUERY's detected intent (category / semantic concept / key tokens / value /
// hints). retrieveRelevantFacts() uses it to drop facts that matched nothing
// about a directed query — previously a high-importance food fact leaked into
// "what programming stack do I use?" purely on base importance + recency.
//
// Phase 2 — semantic blend: ctx.semanticScores (optional Map<factKey, cosine>,
// precomputed by the async caller via semanticMemory) contributes a bounded
// boost that ALSO counts as intentScore. This is what lets a fact survive the
// directed-intent gate on a synonym/paraphrase query that shares no keywords
// with the fact ("what do I do outdoors?" → hobby: bouldering). Cosine below
// SEM_FLOOR contributes nothing (unrelated text still sits ~0.3–0.5 with modern
// embeddings, so a floor is required); above it, the boost scales to rival a
// key-index hit without steamrolling an exact category match. When
// semanticScores is null/absent (embeddings disabled or failed) this block is
// inert and scoring is byte-identical to pre-Phase-2.
/** An explicit per-key hint outranks the coarse category filter (500). */
const HINT_WEIGHT = 600;

const SEM_FLOOR  = 0.55;   // cosine below this = no semantic signal
const SEM_WEIGHT = 700;    // (cosine - floor) * weight → boost

function scoreRelevance(fact, query, ctx) {
  let score = 0;
  let intentScore = 0;
  
  // 1. Base Importance & Confidence (Ensures high importance never ranks below low)
  score += (fact.importance || 5) * 15; 
  score += (fact.confidence || 0.5) * 20; 
  
  // 2. Explicit Recall (e.g., "What do you know about me?")
  if (ctx.isRecall && !ctx.categoryFilter && ctx.semanticConcepts.size === 0) {
    score += 1000; 
  }
  
  // 3. Category Filter Match
  if (ctx.categoryFilter && ctx.categoryFilter.has(fact.category)) {
    score += 500;
    intentScore += 500;
  }
  
  // 4. Semantic Concept Match
  for (const concept of ctx.semanticConcepts) {
    const keys = SEMANTIC_CONCEPTS[concept] || [];
    if (keys.includes(fact.key)) {
      score += 400;
      intentScore += 400;
    }
  }
  
  // 5. Key Intent Match (from word index)
  const keyScore = ctx.keyScores.get(fact.key) || 0;
  score += keyScore * 60;
  intentScore += keyScore * 60;
  
  // 6. Value-based matching
  const qLower = query.toLowerCase();
  const valueStr = typeof fact.value === 'string' 
    ? fact.value.toLowerCase() 
    : JSON.stringify(fact.value).toLowerCase();
  if (valueStr && valueStr.length > 2 && qLower.includes(valueStr)) {
    score += 150;
    intentScore += 150;
  }
  
  // 7. Retrieval Hints Match
  //
  // WEIGHTED ABOVE THE CATEGORY FILTER (500), deliberately. A category filter
  // is a COARSE signal — "this whole category might be relevant". A retrieval
  // hint is a SPECIFIC one — the schema author listed this exact word as
  // meaning this exact key. The specific signal losing to the coarse one is
  // backwards, and it was measurable: "What is my company called?" returned
  // `cofounder` because `company` maps to the WORK category (+500, and
  // cofounder lives in `work`) while `project` — whose retrievalHints name
  // `company` outright — could only earn +100 and lost by 400 points.
  const schema = getSchema(fact.key);
  if (schema?.retrievalHints) {
    for (const hint of schema.retrievalHints) {
      if (qLower.includes(hint.toLowerCase())) {
        score += HINT_WEIGHT;
        intentScore += HINT_WEIGHT;
        break;
      }
    }
  }
  
  // 8. Recency Boost
  const ageMs = Date.now() - (fact.ts || fact.updatedAt || 0);
  if (ageMs < 60_000) score += 40;
  else if (ageMs < 600_000) score += 20;
  else if (ageMs < 3_600_000) score += 10;

  // 9. Semantic similarity (Phase 2) — inert when ctx.semanticScores is null.
  if (ctx.semanticScores) {
    const sim = ctx.semanticScores.get(fact.key);
    if (typeof sim === 'number' && sim > SEM_FLOOR) {
      const boost = (sim - SEM_FLOOR) * SEM_WEIGHT;
      score += boost;
      intentScore += boost;   // survives the directed-intent gate on paraphrase queries
    }
  }

  return { score, intentScore };
}

/** The question is about, or for, the person asking. */
const PERSONAL_REFERENCE = /\b(?:i|i'?m|i'?ve|i'?d|i'?ll|me|my|mine|myself|we|we'?re|we'?ve|our|ours|us|ourselves)\b/i;

// ── Public retrieval API ──────────────────────────────────────────────────────
export function retrieveRelevantFacts(ownerId, query, limit = 15, { trace = null, semanticScores = null, sensitive = null } = {}) {
  // Sensitive categories (2026-10-28): health and mood facts leave BEFORE
  // scoring. They used to rank like any fact — a custom_ fallback fact scores
  // importance 4 × 15 + confidence 0.7 × 20 = 74 on base alone, above the
  // generic-query threshold of 50 — so they rode along on every turn, and each
  // ride raised retrievalCount (the Memory page's "Used 233×").
  const policy = sensitive ?? sensitivePolicy();
  const stored = getFacts(ownerId);
  const visible = stored.filter(f => !withheld(f, policy));
  if (trace) trace.sensitiveWithheld = stored.length - visible.length;
  // A value its own schema rejects today ("profession: billionaire", written
  // before that validator was fixed) is hidden from the Memory page — and must
  // not reach the answer either, or the model is still told a goal is a job.
  // Stored and forgettable as before; only its use stops.
  const allFacts = visible.filter(f => !failsItsSchema(f));
  if (!allFacts.length) return [];

  const isRecall = isMemoryQuery(query);
  const categoryFilter = detectCategoryIntent(query);
  const semanticConcepts = detectSemanticConcepts(query);
  const keyScores = detectKeyIntent(query);
  
  const ctx = { isRecall, categoryFilter, semanticConcepts, keyScores, semanticScores };

  const scored = allFacts
    .filter((f) => (f.confidence || 0) >= 0.5)
    .map((f) => ({ fact: f, ...scoreRelevance(f, query, ctx) }))
    .sort((a, b) => b.score - a.score);

  console.log(`[MEM_RETRIEVER] MEMORY_RANKED owner=${ownerId} query="${query}" candidates=${scored.length}`);

  let threshold = 0;
  if (!isRecall && (!categoryFilter || categoryFilter.size === 0) && semanticConcepts.size === 0) {
    threshold = 50; 
  }

  // Directed-query relevance gate: when the query names a category or a
  // semantic concept ("what programming stack…", "what food…"), a fact
  // that earned ZERO intent score matched nothing about the question —
  // exclude it, no matter how important it is in general. Recall queries
  // ("what do you know about me?") and generic queries are untouched.
  const hasDirectedIntent =
    (categoryFilter && categoryFilter.size > 0) || semanticConcepts.size > 0;

  // Impersonal-query gate (2026-10-29): a generic question that never refers
  // to the user ("At sea level, what temperature does water boil at?") used to
  // carry the whole profile — importance alone clears threshold 50 — so every
  // factual question handed the model the user's job and goals (live run,
  // CONTEXT_VALIDATION_2026-10-29.md, V7). With no personal reference only facts
  // the question itself names survive. Anything with I/my/we/our ("help me plan
  // my week") keeps the profile as before.
  const impersonal = !isRecall && !hasDirectedIntent && !PERSONAL_REFERENCE.test(query);

  const filtered = scored.filter((x) =>
    x.score >= threshold && (!hasDirectedIntent || x.intentScore > 0) && (!impersonal || x.intentScore > 0));
  
  if (filtered.length > 0) {
    console.log(`[MEM_RETRIEVER] MEMORY_RETRIEVED owner=${ownerId} count=${filtered.length} topScore=${filtered[0].score}`);
  }

  const top = filtered.slice(0, limit);
  // Phase A — usage feedback: these facts are about to be injected into the
  // prompt; record it so computeImportance can reward facts retrieval keeps
  // needing. Fail-open: a touch failure must never break retrieval.
  try { touchRetrieved(ownerId, top.map((x) => x.fact.key)); } catch { /* non-fatal */ }
  if (trace) {
    trace.ranking = top.map((x) => ({
      key: x.fact.key, score: x.score, intentScore: x.intentScore,
      confidence: x.fact.confidence, importance: x.fact.importance,
      reason: x.intentScore > 0 ? 'intent_match' : (isRecall ? 'recall_query' : 'importance_recency'),
    }));
    trace.consideredFacts = scored.length;
    trace.droppedByGate = scored.length - filtered.length;
  }
  return top.map((x) => x.fact);
}

// ── Prompt formatting & Grouping ──────────────────────────────────────────────

const CATEGORY_LABELS = {
  [CATEGORIES.IDENTITY]: 'Identity', [CATEGORIES.LOCATION]: 'Location',
  [CATEGORIES.WORK]: 'Work & Career', [CATEGORIES.EDUCATION]: 'Education',
  [CATEGORIES.FAMILY]: 'Family', [CATEGORIES.PETS]: 'Pets',
  [CATEGORIES.PREFERENCES]: 'Preferences', [CATEGORIES.TECHNOLOGY]: 'Technology & Setup',
  [CATEGORIES.PROGRAMMING]: 'Programming', [CATEGORIES.PROJECTS]: 'Projects',
  [CATEGORIES.LIFESTYLE]: 'Lifestyle & Hobbies', [CATEGORIES.TRAVEL]: 'Travel',
  [CATEGORIES.HEALTH]: 'Health & Diet', [CATEGORIES.ENTERTAINMENT]: 'Entertainment',
  [CATEGORIES.GOALS]: 'Goals & Ambitions', [CATEGORIES.FOOD]: 'Food & Drink',
  [CATEGORIES.CUSTOM]: 'Other Details',
};

/**
 * The exact line a fact contributes to the prompt, or null when the formatter
 * leaves it out. Shared with the "Context used" disclosure (routes/chat.js) so
 * that list can only name what the model was actually given — retrieval
 * returns facts from 0.5 confidence, the prompt only from 0.55.
 */
export function factPromptLine(f) {
  if (!f || f.value === undefined || f.value === null || (f.confidence || 0) < 0.55) return null;
  return `- ${FACT_LABELS[f.key] || String(f.key).replace(/_/g, ' ')}: ${formatValue(f.value)}`;
}

export function formatFactsForPrompt(facts) {
  if (!facts || !facts.length) return '';

  const grouped = new Map();
  for (const fact of facts) {
    if (factPromptLine(fact) === null) continue;
    const cat = fact.category || CATEGORIES.CUSTOM;
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat).push(fact);
  }

  if (grouped.size === 0) return '';

  const lines = [];
  for (const [cat, catFacts] of grouped.entries()) {
    const catLabel = CATEGORY_LABELS[cat] || cat;
    lines.push(`\n### ${catLabel}`);
    for (const f of catFacts) lines.push(factPromptLine(f));
  }

  console.log(`[MEM_RETRIEVER] MEMORY_GROUPED categories=${Array.from(grouped.keys()).join(',')}`);
  console.log(`[MEM_RETRIEVER] MEMORY_SUMMARIZED facts=${facts.length} groups=${grouped.size}`);
  console.log(`[MEM_RETRIEVER] MEMORY_INJECTED facts=${facts.length}`);

  return [
    '--- USER PROFILE & MEMORY ---',
    'The following is a structured summary of what you know about the user:',
    ...lines,
    '',
    'Guidelines:',
    '- Use this memory naturally to personalize responses.',
    '- Do not narrate "I remember that..." unless explicitly asked.',
    '- If asked about these topics, rely on this profile.',
    '--- END PROFILE ---',
  ].join('\n');
}

function formatValue(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) {
    return v.map((item) => {
      if (typeof item === 'object' && item !== null) {
        const parts = [];
        if (item.name) parts.push(item.name);
        if (item.type) parts.push(`(${item.type})`);
        if (item.age !== null && item.age !== undefined) parts.push(`age ${item.age}`);
        return parts.length ? parts.join(' ') : JSON.stringify(item);
      }
      return String(item);
    }).join(', ');
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}