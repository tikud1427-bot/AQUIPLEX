/**
AQUA Memory Retriever v4
─────────────────────────────────────────────────────────────────────────────
Semantic retrieval engine with multi-dimensional scoring, context budgeting, 
and grouped prompt injection.
*/
import { getFacts } from './longTermMemory.js';
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
  const schema = getSchema(fact.key);
  if (schema?.retrievalHints) {
    for (const hint of schema.retrievalHints) {
      if (qLower.includes(hint.toLowerCase())) {
        score += 100;
        intentScore += 100;
        break;
      }
    }
  }
  
  // 8. Recency Boost
  const ageMs = Date.now() - (fact.ts || fact.updatedAt || 0);
  if (ageMs < 60_000) score += 40;
  else if (ageMs < 600_000) score += 20;
  else if (ageMs < 3_600_000) score += 10;
  
  return { score, intentScore };
}

// ── Public retrieval API ──────────────────────────────────────────────────────
export function retrieveRelevantFacts(ownerId, query, limit = 15, { trace = null } = {}) {
  const allFacts = getFacts(ownerId);
  if (!allFacts.length) return [];

  const isRecall = isMemoryQuery(query);
  const categoryFilter = detectCategoryIntent(query);
  const semanticConcepts = detectSemanticConcepts(query);
  const keyScores = detectKeyIntent(query);
  
  const ctx = { isRecall, categoryFilter, semanticConcepts, keyScores };

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

  const filtered = scored.filter((x) =>
    x.score >= threshold && (!hasDirectedIntent || x.intentScore > 0));
  
  if (filtered.length > 0) {
    console.log(`[MEM_RETRIEVER] MEMORY_RETRIEVED owner=${ownerId} count=${filtered.length} topScore=${filtered[0].score}`);
  }

  const top = filtered.slice(0, limit);
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
const FACT_LABELS = {
  name: 'Name', age: 'Age', birthday: 'Birthday', gender: 'Gender', ethnicity: 'Ethnicity',
  city: 'City', country: 'Country', profession: 'Profession', company: 'Company', 
  years_experience: 'Years of Experience', pets: 'Pets', favorite_language: 'Favorite Programming Language',
  least_favorite_language: 'Disliked Languages', favorite_color: 'Favorite Color', 
  favorite_food: 'Favorite Food', disliked_food: 'Disliked Food', languages: 'Programming Languages',
  favorite_editor: 'Favorite Editor', favorite_os: 'Operating System', hobbies: 'Hobbies', goal: 'Goals',
  spouse: 'Spouse', children: 'Children', frameworks: 'Frameworks', hardware: 'Hardware',
};

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

export function formatFactsForPrompt(facts) {
  if (!facts || !facts.length) return '';

  const grouped = new Map();
  for (const fact of facts) {
    if (fact.value === undefined || fact.value === null || (fact.confidence || 0) < 0.55) continue;
    const cat = fact.category || CATEGORIES.CUSTOM;
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat).push(fact);
  }

  if (grouped.size === 0) return '';

  const lines = [];
  for (const [cat, catFacts] of grouped.entries()) {
    const catLabel = CATEGORY_LABELS[cat] || cat;
    lines.push(`\n### ${catLabel}`);
    for (const f of catFacts) {
      const label = FACT_LABELS[f.key] || f.key.replace(/_/g, ' ');
      const value = formatValue(f.value);
      lines.push(`- ${label}: ${value}`);
    }
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