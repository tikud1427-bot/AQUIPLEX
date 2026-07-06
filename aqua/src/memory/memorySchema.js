/**
AQUA Memory Schema v3.2
─────────────────────────────────────────────────────────────────────────────
Single source of truth for every extractable memory type.
Added: Semantic concepts, category aliases, and pre-indexed word graph.
*/
export const CATEGORIES = Object.freeze({
  IDENTITY: 'identity', LOCATION: 'location', WORK: 'work', EDUCATION: 'education',
  FAMILY: 'family', PETS: 'pets', PREFERENCES: 'preferences', TECHNOLOGY: 'technology',
  PROGRAMMING: 'programming', PROJECTS: 'projects', LIFESTYLE: 'lifestyle', TRAVEL: 'travel',
  HEALTH: 'health', ENTERTAINMENT: 'entertainment', GOALS: 'goals', FOOD: 'food', CUSTOM: 'custom',
});

export const CONFLICT_POLICIES = Object.freeze({
  OVERWRITE: 'overwrite', MERGE_COLLECTION: 'merge_collection',
  KEEP_NEWEST: 'keep_newest', HIGHEST_CONF: 'highest_confidence',
});

// ── Normalizers ───────────────────────────────────────────────────────────────
const normalizeTrim = (v) => (v || '').trim();
const normalizeLower = (v) => (v || '').trim().toLowerCase();
const normalizeName = (v) => (v || '').trim().replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const normalizeLanguage = (v) => {
  const lower = (v || '').trim().toLowerCase();
  const map = {
    'js': 'javascript', 'ts': 'typescript', 'py': 'python', 'rb': 'ruby', 'cs': 'c#',
    'golang': 'go', 'cpp': 'c++', 'csharp': 'c#', 'objc': 'objective-c'
  };
  if (map[lower]) return map[lower];
  const stripped = lower.replace(/.?js$/i, '').replace(/\s*programming$/i, '');
  return map[stripped] || stripped || lower;
};
const normalizeFramework = (v) => (v || '').trim().toLowerCase().replace(/.?js$/i, '');
const normalizeEditor = (v) => {
  const lower = (v || '').trim().toLowerCase();
  const map = {
    'vscode': 'visual studio code', 'vs code': 'visual studio code',
    'vim': 'vim', 'neovim': 'neovim', 'nvim': 'neovim',
    'intellij': 'intellij idea', 'sublime': 'sublime text',
    'cursor': 'cursor', 'zed': 'zed', 'fleet': 'fleet', 'emacs': 'emacs'
  };
  return map[lower] || lower;
};
const normalizeOS = (v) => {
  const lower = (v || '').trim().toLowerCase();
  const linuxDistros = ['ubuntu', 'fedora', 'debian', 'arch', 'manjaro', 'pop!_os', 'pop os', 'mint', 'centos', 'rhel', 'linux'];
  if (linuxDistros.includes(lower)) return 'linux';
  const macVariants = ['macos', 'mac os', 'osx', 'os x', 'mac'];
  if (macVariants.includes(lower)) return 'macos';
  return lower;
};
const normalizeCountry = (v) => {
  const lower = (v || '').trim().toLowerCase().replace(/^the\s+/, '');
  const map = {
    'usa': 'United States', 'us': 'United States', 'u.s.': 'United States', 'u.s.a.': 'United States', 'america': 'United States',
    'uk': 'United Kingdom', 'britain': 'United Kingdom', 'england': 'United Kingdom', 'scotland': 'United Kingdom', 'wales': 'United Kingdom', 'northern ireland': 'United Kingdom',
    'uae': 'United Arab Emirates', 'holland': 'Netherlands',
  };
  return map[lower] || (v || '').trim().replace(/^the\s+/i, '').replace(/\b\w/g, (c) => c.toUpperCase());
};
const normalizeNumber = (v) => {
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};
const normalizeDate = (v) => (v || '').trim().replace(/\s+/g, ' ');
const normalizeCity = normalizeCountry;

// ── Validators ────────────────────────────────────────────────────────────────
const validateName = (v) => typeof v === 'string' && v.length >= 2 && v.length <= 60 && /^[A-Za-zÀ-ÿ\s'-]+$/.test(v);
const validateShort = (min, max) => (v) => typeof v === 'string' && v.length >= min && v.length <= max;
const validateLanguage = (v) => typeof v === 'string' && v.length > 1;
const validateFramework = (v) => typeof v === 'string' && v.length > 1;
const validateEditor = (v) => typeof v === 'string' && v.length > 1;
const validateOS = (v) => typeof v === 'string' && v.length > 1;
const validateAge = (v) => Number.isInteger(v) && v >= 0 && v <= 130;
const validateYear = (v) => Number.isInteger(v) && v >= 1900 && v <= 2100;
// A project value must be a NAME, not a bare generic noun left over after
// article stripping ("I am building an AI" must not store project="AI").
const GENERIC_PROJECT = new Set(['ai', 'app', 'apps', 'website', 'site', 'tool', 'bot', 'thing', 'things', 'something', 'stuff', 'project', 'product', 'startup', 'company', 'business', 'saas', 'platform', 'feature', 'code', 'it']);
const validateProject = (v) => typeof v === 'string' && v.length >= 2 && v.length <= 50 && !GENERIC_PROJECT.has(v.toLowerCase().trim());
const validateWords = (min, max) => (v) => {
  const words = (v || '').split(/\s+/).filter(Boolean);
  return words.length >= min && words.length <= max;
};

// ── Schema entries ────────────────────────────────────────────────────────────
export const MEMORY_SCHEMA = [
  // ═══════════════════════ IDENTITY ═════════════════════════════════════════
  { category: CATEGORIES.IDENTITY, key: 'name', aliases: ['legal_name', 'full_name'],
    patterns: [
      { regex: /my name is ([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]+(?: [A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]+){0,3})/i, group: 1, reason: 'explicit_name' },
      // v2 FIX (Memory Confidence Engine): excludes gerunds/present-participles
      // ("building", "working", "coding", "running", ...) via the trailing
      // (?!\w*ing\b) lookahead. Previously "I am building an AI." matched
      // this pattern and stored name="Building" — identity extraction must
      // only succeed when the sentence is explicitly introducing an identity,
      // not describing a current activity.
      // v3 FIX (Extraction Audit): the old anchor ^ rejected "Hi I'm Chhanda",
      // the [A-ZÀ-ÿ] first-char class rejected "hi i'm chhanda", and the
      // mandatory trailing [,.]/connector rejected bare "I'm Chhanda" at end
      // of sentence — the single most common introduction produced ZERO
      // candidates. Now: no anchor, any-case first letter (normalizeName
      // capitalizes), end-of-sentence allowed, and a wider stop-word list so
      // "I'm sure/tired/back/ready…" never becomes a name. Gerund guard kept.
      // v4 FIX (Cognitive Identity): the capture was a SINGLE token, so
      // "I'm Chhanda Prabal Das" matched only "Chhanda", then the boundary
      // failed on " Prabal" and the WHOLE phrase fell through to the custom_
      // fallback (stored as an opaque trait, later overwritten by an unrelated
      // custom fact — the identity-corruption bug). Now the capture takes 1–4
      // name tokens; each SUBSEQUENT token is guarded against connectors/
      // prepositions so "I'm Chhanda from Assam" still stops at "Chhanda" and
      // never absorbs "from Assam".
      { regex: /\bi(?:'m| am) (?!(?:a|an|the|from|in|at|on|going|trying|planning|hoping|aiming|not|no|so|just|also|very|really|now|currently|actually|here|there|sure|fine|okay|ok|well|still|good|great|glad|happy|sad|sorry|tired|busy|free|back|ready|done|new|old|late|early|lost|stuck|confused|curious|interested|afraid|excited|serious|right|wrong|kidding|joking|all|too|quite|pretty|almost|about|only|way|kind|sort)\b)(?!\w*ing\b)([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]{2,}(?:\s(?!(?:and|but|from|in|at|by|with|for|to|of|on|as|is|who|the|a|an)\b)[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]+){0,3})(?:\s*[,.!?]|$|\s+(?:and|but|from|in|at|by|who|is|the|of)\b)/i, group: 1, reason: 'intro' },
      { regex: /^(?:hi|hey|hello|yo|greetings)?[,!.\s]*this is ([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]{2,}(?:\s(?!(?:and|from|at|the|a|an|of|who|is)\b)[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]+){0,3})(?:\s*[,.!?]|$|\s+(?:and|from|at|who|is)\b)/i, group: 1, reason: 'this_is', confidence: 0.85 },
    ], normalizer: normalizeName, validator: validateName, multiValue: false, conflictPolicy: CONFLICT_POLICIES.OVERWRITE, importance: 10, baseConfidence: 0.98, retrievalHints: ['name', 'called', 'who am i'] },
  // v4 (Cognitive Identity): preferred_name is a DISTINCT field from the legal
  // `name` — "Call me Chhanda" must set the preferred name WITHOUT erasing the
  // legal name (field-level isolation: two keys, two lifecycles). Previously
  // "call me X" wrote the `name` key and clobbered the full legal name.
  { category: CATEGORIES.IDENTITY, key: 'preferred_name', aliases: ['nickname', 'goes_by'],
    patterns: [
      { regex: /(?:just )?call me ([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]+(?: [A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]+){0,2})/i, group: 1, reason: 'call_me', confidence: 0.95,
        transform: (m) => { const v = m[1].trim(); return /^(back|later|maybe|now|when|if|about|anytime|tomorrow|tonight|please|asap|soon)\b/i.test(v) ? null : v; } },
      { regex: /i (?:go by|am called|prefer to be called|usually go by) ([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]+(?: [A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]+){0,2})/i, group: 1, reason: 'go_by', confidence: 0.95 },
    ], normalizer: normalizeName, validator: validateName, multiValue: false, conflictPolicy: CONFLICT_POLICIES.OVERWRITE, importance: 9, baseConfidence: 0.95, retrievalHints: ['call me', 'nickname', 'go by', 'preferred name'] },
  { category: CATEGORIES.IDENTITY, key: 'aliases', patterns: [
      { regex: /(?:also known as|a\.?k\.?a\.?|you can also call me|some(?:times)? call me) ([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]+(?: [A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]+){0,2})/i, group: 1, reason: 'alias', confidence: 0.85 },
    ], normalizer: (v) => Array.isArray(v) ? v.map(normalizeName) : [normalizeName(v)], validator: (v) => (Array.isArray(v) ? v : [v]).every(validateName), multiValue: true, conflictPolicy: CONFLICT_POLICIES.MERGE_COLLECTION, importance: 5, baseConfidence: 0.85, retrievalHints: ['alias', 'also known as', 'aka'] },
  { category: CATEGORIES.IDENTITY, key: 'age', patterns: [
      { regex: /i(?:'m| am) (\d{1,3}) years? old/i, group: 1, reason: 'age_explicit' },
      { regex: /i turned (\d{1,3})(?: last| recently)?/i, group: 1, reason: 'turned_age' },
      { regex: /i(?:'m| am) (\d{1,3})\b(?![\s]*(?:km|miles|percent|%|°|degrees|days|weeks|months|hours|minutes|seconds|kg|lbs))/i, group: 1, reason: 'age_bare', confidence: 0.8 },
    ], normalizer: normalizeNumber, validator: validateAge, multiValue: false, conflictPolicy: CONFLICT_POLICIES.OVERWRITE, importance: 7, baseConfidence: 0.95, retrievalHints: ['age', 'old'] },
  { category: CATEGORIES.IDENTITY, key: 'birthday', aliases: ['birth_date'], patterns: [
      { regex: /my birthday is (.+?)(?:\.|,|$)/i, group: 1, reason: 'birthday_explicit' },
      { regex: /i was born on (.+?)(?:\.|,|$)/i, group: 1, reason: 'born_on' },
    ], normalizer: normalizeDate, validator: validateShort(3, 40), multiValue: false, conflictPolicy: CONFLICT_POLICIES.OVERWRITE, importance: 7, baseConfidence: 0.95, retrievalHints: ['birthday', 'born on'] },
  
  // ═══════════════════════ LOCATION ═════════════════════════════════════════
  { category: CATEGORIES.LOCATION, key: 'city', aliases: ['current_city'], patterns: [
      // MultiKey: "I live in Paris, France" / "I am based in London, England"
      { regex: /i\s+(?:[a-z]+\s+)?(?:live|reside|stay)\s+in\s+([A-ZÀ-ÿ][A-Za-zÀ-ÿ'-]+),\s*([A-ZÀ-ÿ][A-Za-zÀ-ÿ\s'-]{2,35}?)(?:\s+now|\s*[,.]|$)/i,
        multiKey: true, reason: 'city_country_pair', confidence: 0.9,
        transform: (m) => ({ city: m[1].trim(), country: m[2].trim() }) },
      { regex: /i\s+am\s+(?:based|located)\s+in\s+([A-ZÀ-ÿ][A-Za-zÀ-ÿ'-]+),\s*([A-ZÀ-ÿ][A-Za-zÀ-ÿ\s'-]{2,35}?)(?:\s+now|\s*[,.]|$)/i,
        multiKey: true, reason: 'city_country_based', confidence: 0.9,
        transform: (m) => ({ city: m[1].trim(), country: m[2].trim() }) },
      { regex: /i\s+(?:[a-z]+\s+)?(?:live|reside|stay|am\s+(?:based|located))\s+in\s+([A-ZÀ-ÿ][A-Za-zÀ-ÿ\s,'-]{2,35}?)(?:\s+now|\s*[,.]|$)/i, group: 1, reason: 'live_in' },
    ], normalizer: normalizeCity, validator: validateWords(1, 5), multiValue: false, conflictPolicy: CONFLICT_POLICIES.OVERWRITE, importance: 7, baseConfidence: 0.9, retrievalHints: ['city', 'live'] },
  { category: CATEGORIES.LOCATION, key: 'country', patterns: [
      { regex: /i(?:'m| am) from ([A-ZÀ-ÿ][A-Za-zÀ-ÿ\s'-]{2,35}?)(?:\s+originally|\s*[,.]|$)/i, group: 1, reason: 'from_country' },
    ], normalizer: normalizeCountry, validator: validateWords(1, 4), multiValue: false, conflictPolicy: CONFLICT_POLICIES.OVERWRITE, importance: 7, baseConfidence: 0.9, retrievalHints: ['country', 'from'] },

  // ═══════════════════════ WORK ═════════════════════════════════════════════
  { category: CATEGORIES.WORK, key: 'profession', aliases: ['job_title', 'role'], patterns: [
      // v4 (Cognitive Identity): "I'm the founder of Aquiplex" / "I'm the CEO
      // at Acme" carries BOTH a role and a company but matched NO schema key
      // (profession needs "a/an", workplace needs "work at") → it fell through
      // to the custom_ fallback as one opaque blob. This multiKey pattern
      // splits it into role → profession and company → workplace, each stored
      // in its own isolated field.
      { regex: /i(?:'m| am) the ([A-Za-z][A-Za-z\s-]{1,30}?) (?:of|at|for) ([A-Za-z0-9][A-Za-z0-9&.'\s-]{1,40}?)(?:\s*[,.!?]|$)/i,
        multiKey: true, reason: 'role_of_org', confidence: 0.92,
        transform: (m) => ({ profession: m[1].trim(), workplace: m[2].trim() }) },
      { regex: /i work as (?:a |an )?([A-Za-z\s-]+?)(?:\s+at|\s+for|\s*[,.]|$)/i, group: 1, reason: 'work_as' },
      // v3 (Extraction Audit): "I'm a student", "I am a founder", "I'm an
      // engineer at X". Guard rejects intensity idioms ("I'm a bit tired").
      { regex: /i(?:'m| am) (?:a|an) ([A-Za-z][A-Za-z\s-]{2,30}?)(?:\s+(?:at|for|in|and|who|based|working)\b|\s*[,.!?]|$)/i, group: 1, reason: 'i_am_a', confidence: 0.85,
        transform: (m) => { const v = m[1].trim(); return /^(bit|little|fan|big|huge|great|good|real|total|complete|proud|happy|new)\b/i.test(v) ? null : v; } },
    ], normalizer: normalizeTrim, validator: validateWords(1, 6), multiValue: false, conflictPolicy: CONFLICT_POLICIES.OVERWRITE, importance: 8, baseConfidence: 0.9, retrievalHints: ['job', 'work', 'role'] },
  { category: CATEGORIES.WORK, key: 'workplace', aliases: ['company', 'employer', 'organization'], patterns: [
      { regex: /i work (?:as [A-Za-z\s'-]+? )?(?:at|for) ([A-Za-z][A-Za-z0-9\s&.'-]+?)(?:\s*[,.!?]|$)/i, group: 1, reason: 'work_at' },
      { regex: /i(?:'m| am) (?:a|an) [A-Za-z\s-]+? at ([A-Za-z][A-Za-z0-9\s&.'-]+?)(?:\s*[,.!?]|$)/i, group: 1, reason: 'role_at_org', confidence: 0.85 },
      { regex: /i(?:'m| am) (?:employed at|working at|based at) ([A-Z][A-Za-z0-9\s&'-]+?)(?:\s*[,.]|$)/i, group: 1, reason: 'employed_at' },
    ], normalizer: normalizeTrim, validator: validateWords(1, 8), multiValue: false, conflictPolicy: CONFLICT_POLICIES.OVERWRITE, importance: 7, baseConfidence: 0.88, retrievalHints: ['workplace', 'company', 'employer'] },
  { category: CATEGORIES.IDENTITY, key: 'relationship_status', aliases: ['marital_status'], patterns: [
      { regex: /my (?:wife|husband|spouse) (?:is |'s )?[A-ZÀ-ÿ]/i, reason: 'has_spouse', transform: () => 'married' },
      { regex: /i(?:'m| am) (?:married|engaged|single|divorced|widowed|in a relationship)/i, reason: 'rel_status',
        transform: (m) => m[0].replace(/^i(?:'m| am) /i, '').trim() },
    ], normalizer: normalizeLower, validator: validateShort(4, 20), multiValue: false, conflictPolicy: CONFLICT_POLICIES.OVERWRITE, importance: 5, baseConfidence: 0.88, retrievalHints: ['married', 'relationship', 'single', 'spouse'] },
  
  // ═══════════════════════ PREFERENCES & DISLIKES ═══════════════════════════
  { category: CATEGORIES.PREFERENCES, key: 'favorite_language', aliases: ['favorite_programming_language'], patterns: [
      { regex: /my (?:favorite|favourite|preferred|fav) (?:programming )?language is ([A-Za-z#+\s]+?)(?:\s*[,.]|$)/i, group: 1, reason: 'fav_lang' },
      { regex: /i (?:adore|love|mostly use|primarily code in) ([A-Za-z#+]+)/i, group: 1, reason: 'code_in', confidence: 0.9 },
    ], normalizer: normalizeLanguage, validator: validateLanguage, multiValue: false, conflictPolicy: CONFLICT_POLICIES.OVERWRITE, importance: 9, baseConfidence: 0.95, retrievalHints: ['language', 'favorite language'] },
  { category: CATEGORIES.FOOD, key: 'favorite_food', patterns: [
      { regex: /my (?:favorite|favourite|fav) food is ([A-Za-z\s]+?)(?:\s*[,.]|$)/i, group: 1, reason: 'fav_food' },
    ], normalizer: normalizeLower, validator: validateShort(2, 40), multiValue: true, conflictPolicy: CONFLICT_POLICIES.MERGE_COLLECTION, importance: 6, baseConfidence: 0.9, retrievalHints: ['food', 'favorite food'] },

  { category: CATEGORIES.PREFERENCES, key: 'least_favorite_language', aliases: ['disliked_language'], patterns: [
      { regex: /i (?:(?:really|absolutely) )?(?:can't stand|despise|hate|detest|really dislike)(?!\s+eating)\s+([A-Za-z#+]{2,20})/i, group: 1, reason: 'dislike_lang', confidence: 0.9 },
    ], normalizer: normalizeLanguage, validator: validateLanguage, multiValue: true, conflictPolicy: CONFLICT_POLICIES.MERGE_COLLECTION, importance: 6, baseConfidence: 0.9, retrievalHints: ['hate language', 'dislike language'] },
  { category: CATEGORIES.FOOD, key: 'disliked_food', aliases: ['least_favorite_food'], patterns: [
      { regex: /i (?:hate|can't stand|despise|dislike) eating ([A-Za-z\s]+?)(?:\s*[,.]|$)/i, group: 1, reason: 'hate_food' },
    ], normalizer: normalizeLower, validator: validateShort(2, 40), multiValue: true, conflictPolicy: CONFLICT_POLICIES.MERGE_COLLECTION, importance: 5, baseConfidence: 0.85, retrievalHints: ['hate food', 'dislike food'] },
  { category: CATEGORIES.PREFERENCES, key: 'favorite_color', aliases: ['favourite_color', 'fav_color'], patterns: [
      { regex: /my (?:favorite|favourite|fav) colou?r is ([A-Za-z\s]+?)(?:\s*[,.]|$)/i, group: 1, reason: 'fav_color' },
    ], normalizer: normalizeLower, validator: validateShort(2, 30), multiValue: false, conflictPolicy: CONFLICT_POLICIES.OVERWRITE, importance: 4, baseConfidence: 0.9, retrievalHints: ['color', 'colour', 'favorite color'] },
  { category: CATEGORIES.TECHNOLOGY, key: 'favorite_framework', aliases: ['frameworks', 'framework'], patterns: [
      { regex: /my (?:favorite|favourite|preferred|fav) (?:framework|library) is ([A-Za-z\s.]+?)(?:\s*[,.]|$)/i, group: 1, reason: 'fav_framework' },
      { regex: /i (?:use|prefer|love|mostly use) ([A-Za-z.]+?) (?:framework|library)/i, group: 1, reason: 'use_framework', confidence: 0.85 },
    ], normalizer: normalizeFramework, validator: validateFramework, multiValue: true, conflictPolicy: CONFLICT_POLICIES.MERGE_COLLECTION, importance: 6, baseConfidence: 0.88, retrievalHints: ['framework', 'library', 'react', 'vue', 'express'] },

  // ═══════════════════════ FAMILY ═══════════════════════════════════════════
  { category: CATEGORIES.FAMILY, key: 'spouse', aliases: ['partner', 'wife', 'husband'], patterns: [
      { regex: /my (?:wife|husband|spouse|partner) (?:is |'s )?([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]{1,30})/i, group: 1, reason: 'spouse_name' },
    ], normalizer: normalizeName, validator: validateName, multiValue: false, conflictPolicy: CONFLICT_POLICIES.OVERWRITE, importance: 8, baseConfidence: 0.95, retrievalHints: ['wife', 'husband', 'spouse', 'partner'] },
  { category: CATEGORIES.FAMILY, key: 'children', aliases: ['kids', 'child'], patterns: [
      { regex: /(?:my|a) (?:son|daughter|child|kid) (?:named )?([A-ZÀ-ÿ][A-Za-zÀ-ÿ'-]{1,25})/i, group: 1, reason: 'child_name',
        transform: (m) => ({ name: m[1].trim(), relation: m[0].match(/son/i) ? 'son' : 'daughter' }) },
      { regex: /i have (?:a )?(?:son|daughter) (?:named )?([A-ZÀ-ÿ][A-Za-zÀ-ÿ'-]{1,25})/i, group: 1, reason: 'have_child',
        transform: (m) => ({ name: m[1].trim(), relation: m[0].match(/son/i) ? 'son' : 'daughter' }) },
    ], normalizer: (v) => typeof v === 'object' ? v : { name: String(v) }, validator: (v) => v && typeof v.name === 'string' && v.name.length > 0, multiValue: true, conflictPolicy: CONFLICT_POLICIES.MERGE_COLLECTION, importance: 8, baseConfidence: 0.9, retrievalHints: ['child', 'son', 'daughter', 'kids'] },
  { category: CATEGORIES.FAMILY, key: 'siblings', aliases: ['brother', 'sister'], patterns: [
      { regex: /my (?:brother|sister|sibling) (?:is |'s )?([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]{1,30})/i, group: 1, reason: 'sibling_name' },
    ], normalizer: normalizeName, validator: validateName, multiValue: true, conflictPolicy: CONFLICT_POLICIES.MERGE_COLLECTION, importance: 6, baseConfidence: 0.9, retrievalHints: ['sibling', 'brother', 'sister'] },

  // ═══════════════════════ ENTERTAINMENT ════════════════════════════════════
  { category: CATEGORIES.ENTERTAINMENT, key: 'favorite_movie', aliases: ['favourite_movie'], patterns: [
      { regex: /my (?:favorite|favourite|fav) (?:movie|film) is ([A-Za-z0-9\s:'-]+?)(?:\s*[,.]|$)/i, group: 1, reason: 'fav_movie' },
    ], normalizer: normalizeTrim, validator: validateShort(1, 80), multiValue: true, conflictPolicy: CONFLICT_POLICIES.MERGE_COLLECTION, importance: 4, baseConfidence: 0.9, retrievalHints: ['movie', 'film'] },
  { category: CATEGORIES.ENTERTAINMENT, key: 'favorite_music', aliases: ['favourite_music', 'favorite_song', 'favorite_band'], patterns: [
      { regex: /my (?:favorite|favourite|fav) (?:music|song|band|artist|genre) is ([A-Za-z0-9\s:'-]+?)(?:\s*[,.]|$)/i, group: 1, reason: 'fav_music' },
    ], normalizer: normalizeTrim, validator: validateShort(1, 60), multiValue: true, conflictPolicy: CONFLICT_POLICIES.MERGE_COLLECTION, importance: 4, baseConfidence: 0.88, retrievalHints: ['music', 'song', 'band', 'artist'] },
  { category: CATEGORIES.ENTERTAINMENT, key: 'favorite_book', aliases: ['favourite_book'], patterns: [
      { regex: /my (?:favorite|favourite|fav) book is ([A-Za-z0-9\s:'-]+?)(?:\s*[,.]|$)/i, group: 1, reason: 'fav_book' },
    ], normalizer: normalizeTrim, validator: validateShort(1, 80), multiValue: true, conflictPolicy: CONFLICT_POLICIES.MERGE_COLLECTION, importance: 4, baseConfidence: 0.88, retrievalHints: ['book', 'reading'] },
  { category: CATEGORIES.ENTERTAINMENT, key: 'favorite_sport', aliases: ['favourite_sport'], patterns: [
      { regex: /my (?:favorite|favourite|fav) sport is ([A-Za-z\s]+?)(?:\s*[,.]|$)/i, group: 1, reason: 'fav_sport' },
    ], normalizer: normalizeLower, validator: validateShort(2, 40), multiValue: false, conflictPolicy: CONFLICT_POLICIES.OVERWRITE, importance: 4, baseConfidence: 0.88, retrievalHints: ['sport'] },

  // ═══════════════════════ TRAVEL ═══════════════════════════════════════════
  { category: CATEGORIES.TRAVEL, key: 'visited_countries', aliases: ['traveled_to', 'been_to'], patterns: [
      { regex: /i(?:'ve| have) (?:visited|been to|traveled to) ([A-Za-z\s,&]+?)(?:\s*[,.]|$)/i, group: 1, reason: 'visited',
        transform: (m) => m[1].split(/[,&]|and/).map(s => s.trim()).filter(Boolean) },
    ], normalizer: (v) => Array.isArray(v) ? v.map(normalizeCountry) : [normalizeCountry(v)], validator: (v) => (Array.isArray(v) ? v : [v]).every(s => s.length > 1), multiValue: true, conflictPolicy: CONFLICT_POLICIES.MERGE_COLLECTION, importance: 4, baseConfidence: 0.85, retrievalHints: ['visited', 'traveled', 'been to'] },
  { category: CATEGORIES.TRAVEL, key: 'dream_destinations', aliases: ['want_to_visit', 'bucket_list'], patterns: [
      { regex: /i (?:want|dream|hope) to (?:visit|go to|travel to) ([A-Za-z\s,]+?)(?:\s*[,.]|$)/i, group: 1, reason: 'dream_dest',
        transform: (m) => m[1].split(/[,]|and/).map(s => s.trim()).filter(Boolean) },
    ], normalizer: (v) => Array.isArray(v) ? v.map(normalizeCountry) : [normalizeCountry(v)], validator: (v) => (Array.isArray(v) ? v : [v]).every(s => s.length > 1), multiValue: true, conflictPolicy: CONFLICT_POLICIES.MERGE_COLLECTION, importance: 4, baseConfidence: 0.85, retrievalHints: ['dream destination', 'want to visit'] },

  // ═══════════════════════ FOOD (extended) ══════════════════════════════════
  { category: CATEGORIES.FOOD, key: 'favorite_drink', aliases: ['favourite_drink', 'fav_drink'], patterns: [
      { regex: /my (?:favorite|favourite|fav) drink is ([A-Za-z\s]+?)(?:\s*[,.]|$)/i, group: 1, reason: 'fav_drink' },
    ], normalizer: normalizeLower, validator: validateShort(2, 40), multiValue: false, conflictPolicy: CONFLICT_POLICIES.OVERWRITE, importance: 4, baseConfidence: 0.88, retrievalHints: ['drink', 'beverage'] },
  { category: CATEGORIES.FOOD, key: 'dietary_restrictions', aliases: ['diet', 'dietary_preference', 'allergies'], patterns: [
      { regex: /i(?:'m| am) (?:a )?(?:vegan|vegetarian|gluten.free|lactose.intolerant|kosher|halal|pescatarian)/i, reason: 'diet_type',
        transform: (m) => m[0].replace(/i(?:'m| am) (?:a )?/i, '').trim() },
    ], normalizer: normalizeLower, validator: validateShort(2, 40), multiValue: true, conflictPolicy: CONFLICT_POLICIES.MERGE_COLLECTION, importance: 7, baseConfidence: 0.92, retrievalHints: ['diet', 'vegan', 'vegetarian', 'allergy'] },

  { category: CATEGORIES.TECHNOLOGY, key: 'languages', patterns: [
      { regex: /i (?:code|program|write|work) in ([A-Za-z#+,\s&]+?)(?:\s+and\s+)?(?:mostly|primarily)?(?:\s*[,.]|$)/i, group: 1, reason: 'code_in_multi',
        transform: (m) => m[1].split(/[,&]|\sand\s/).map((s) => s.trim()).filter(Boolean) },
      { regex: /i (?:mainly|primarily|mostly) (?:write|code|program) (?:in )?([A-Za-z#+]{2,20})/i, group: 1, reason: 'mainly_write',
        transform: (m) => [m[1].trim()] },
    ], normalizer: (v) => Array.isArray(v) ? v.map(normalizeLanguage) : [normalizeLanguage(v)], validator: (v) => (Array.isArray(v) ? v : [v]).every(validateLanguage), multiValue: true, conflictPolicy: CONFLICT_POLICIES.MERGE_COLLECTION, importance: 7, baseConfidence: 0.9, retrievalHints: ['languages', 'code in'] },
  { category: CATEGORIES.PREFERENCES, key: 'favorite_editor', patterns: [
      { regex: /my (?:favorite|favourite|preferred|fav) editor is ([A-Za-z\s+]+?)(?:\s*[,.]|$)/i, group: 1, reason: 'fav_editor' },
      { regex: /i (?:use|switched to|prefer) (VS ?Code|Visual Studio Code|vim|neovim|nvim|emacs|Sublime(?: Text)?|Cursor|Zed|Fleet|Atom|IntelliJ(?: IDEA)?|WebStorm|Rider|CLion)/i, group: 1, reason: 'use_editor', confidence: 0.88 },
    ], normalizer: normalizeEditor, validator: validateEditor, multiValue: false, conflictPolicy: CONFLICT_POLICIES.OVERWRITE, importance: 6, baseConfidence: 0.9, retrievalHints: ['editor', 'vscode', 'vim'] },
  { category: CATEGORIES.PREFERENCES, key: 'favorite_os', patterns: [
      { regex: /i (?:run|am on|use) (Ubuntu|Fedora|Debian|Arch|Manjaro|Pop!_OS|Pop OS|Mint|CentOS|RHEL|macOS|Mac OS|OSX|OS X|Windows|Linux|Android|iOS|ChromeOS|FreeBSD)(?: as my os)?/i, group: 1, reason: 'use_os' },
      { regex: /on (?:my )?(Mac(?:Book(?:\s+(?:Pro|Air|mini))?)?|PC)\b/i, group: 1, reason: 'on_device', confidence: 0.75 },
    ], normalizer: normalizeOS, validator: (v) => typeof v === 'string' && ['linux','macos','windows','android','ios','chromeos','bsd','freebsd','unix','solaris'].includes(v.toLowerCase()), multiValue: false, conflictPolicy: CONFLICT_POLICIES.OVERWRITE, importance: 5, baseConfidence: 0.9, retrievalHints: ['os', 'linux', 'windows'] },

  // ═══════════════════════ PETS ═════════════════════════════════════════════
  { category: CATEGORIES.PETS, key: 'pets',
    compoundPatterns: [
      { regex: /(?:my|i have (?:a|an)?) (dog|cat|bird|fish|rabbit|hamster|turtle|snake|lizard|parrot|horse|guinea pig) (?:named |called |is )?([A-ZÀ-ÿ][A-Za-zÀ-ÿ'-]+)/gi,
        buildItem: (m) => ({ name: m[2].trim(), type: m[1].toLowerCase() }),
        reason: 'pet_name', confidence: 0.9 },
    ],
    normalizer: (v) => v, validator: (v) => v && typeof v.name === 'string' && v.name.length > 0,
    multiValue: true, conflictPolicy: CONFLICT_POLICIES.MERGE_COLLECTION, importance: 6, baseConfidence: 0.9, retrievalHints: ['pet', 'dog', 'cat', 'bird'] },

  // ═══════════════════════ LIFESTYLE & GOALS ════════════════════════════════
  { category: CATEGORIES.LIFESTYLE, key: 'hobbies', patterns: [
      { regex: /i (?:spend weekends|enjoy|love to|like to|am into) (.+?)(?: in my free time|\s+in my spare time|\s*[,.]|$)/i, group: 1, reason: 'enjoy',
        transform: (m) => m[1].split(/[, &]|\sand\s/).map((s) => s.trim()).filter(Boolean) },
    ], normalizer: (v) => Array.isArray(v) ? v.map((s) => s.toLowerCase()) : [v.toLowerCase()], validator: (v) => (Array.isArray(v) ? v : [v]).every((s) => s.length >= 2 && s.length <= 40), multiValue: true, conflictPolicy: CONFLICT_POLICIES.MERGE_COLLECTION, importance: 5, baseConfidence: 0.85, retrievalHints: ['hobby', 'enjoy', 'weekends'] },
  // ═══════════════════ PROJECTS / RELATIONSHIPS / GENERIC PREFS (v3) ═════════
  // Extraction Audit: "I'm building Aquiplex", "my cofounder is X",
  // "I prefer concise answers", "I always use TypeScript" previously
  // produced ZERO candidates — no schema keys existed for any of them.
  { category: CATEGORIES.PROJECTS, key: 'project', aliases: ['projects', 'startup', 'product'], patterns: [
      { regex: /i(?:'m| am) (?:building|working on|developing|creating|making|shipping) ([A-Za-zÀ-ÿ0-9][\w .'-]{1,40}?)(?:\s*[,.!?]|$|\s+(?:with|using|for|in|and|that|which|to)\b)/i, group: 1, reason: 'building', confidence: 0.9,
        transform: (m) => m[1].replace(/^(?:a|an|the|my|our|this|that|some)\s+/i, '').trim() || null },
      { regex: /my (?:startup|project|company|product|app|platform|saas) is (?:called |named )?([A-Za-zÀ-ÿ0-9][\w .'-]{1,40}?)(?:\s*[,.!?]|$|\s+(?:and|which|that)\b)/i, group: 1, reason: 'my_project', confidence: 0.92 },
      { regex: /i (?:founded|co-?founded|started|launched|run) ([A-Za-zÀ-ÿ0-9][\w .'-]{1,40}?)(?:\s*[,.!?]|$|\s+(?:with|in|and|last|back)\b)/i, group: 1, reason: 'founded', confidence: 0.92 },
    ], normalizer: normalizeTrim, validator: validateProject, multiValue: true, conflictPolicy: CONFLICT_POLICIES.MERGE_COLLECTION, importance: 8, baseConfidence: 0.9, retrievalHints: ['project', 'startup', 'building', 'working on', 'company'] },
  { category: CATEGORIES.WORK, key: 'cofounder', aliases: ['co_founder', 'business_partner'], patterns: [
      { regex: /my (?:co-?founder|business partner) (?:is |'s )?([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]{1,30})/i, group: 1, reason: 'cofounder_name' },
    ], normalizer: normalizeName, validator: validateName, multiValue: true, conflictPolicy: CONFLICT_POLICIES.MERGE_COLLECTION, importance: 7, baseConfidence: 0.92, retrievalHints: ['cofounder', 'co-founder', 'partner'] },
  // v4 (Cognitive Identity): "I founded Aquiplex" is captured by `project`
  // (it IS a project) AND here as an EMPLOYMENT identity — role=Founder,
  // company=Aquiplex — so the identity card knows the user's company, not just
  // that Aquiplex is a project. multiKey → two isolated fields; no clobber.
  { category: CATEGORIES.WORK, key: 'founder_role', patterns: [
      { regex: /i (co-?)?founded ([A-Za-z0-9][A-Za-z0-9&.'\s-]{1,40}?)(?:\s*[,.!?]|$|\s+(?:with|in|and|last|back|to|as)\b)/i,
        multiKey: true, reason: 'founded_company', confidence: 0.9,
        transform: (m) => ({ profession: m[1] ? 'Co-founder' : 'Founder', workplace: m[2].trim() }) },
    ], normalizer: normalizeTrim, validator: () => true, multiValue: false, conflictPolicy: CONFLICT_POLICIES.OVERWRITE, importance: 8, baseConfidence: 0.9, retrievalHints: ['founded', 'founder'] },
  { category: CATEGORIES.PREFERENCES, key: 'preference', aliases: ['prefers'], patterns: [
      { regex: /i prefer ([\w][\w\s,'&.-]{2,60}?)(?:\s+(?:over|to|rather|instead)\b|\s*[,.!?]|$)/i, group: 1, reason: 'prefer', confidence: 0.88 },
      { regex: /i always use ([\w][\w\s.'#+-]{1,40}?)(?:\s*[,.!?]|$|\s+(?:for|when|because)\b)/i, group: 1, reason: 'always_use', confidence: 0.9 },
    ], normalizer: normalizeTrim, validator: validateShort(2, 70), multiValue: true, conflictPolicy: CONFLICT_POLICIES.MERGE_COLLECTION, importance: 7, baseConfidence: 0.88, retrievalHints: ['prefer', 'preference', 'always use'] },
  { category: CATEGORIES.PREFERENCES, key: 'likes', patterns: [
      { regex: /i (?:really |absolutely )?(?:like|love|enjoy) ([\w][\w\s.'&-]{2,40}?)(?:\s*[,.!?]|$|\s+(?:and|but|because|when|so)\b)/i, group: 1, reason: 'likes', confidence: 0.75,
        transform: (m) => { const v = m[1].trim(); return /^(your|that|this|it|the idea|when|how|what|to)\b/i.test(v) ? null : v; } },
    ], normalizer: normalizeLower, validator: validateShort(3, 50), multiValue: true, conflictPolicy: CONFLICT_POLICIES.MERGE_COLLECTION, importance: 4, baseConfidence: 0.75, retrievalHints: ['like', 'love', 'enjoy'] },

  { category: CATEGORIES.GOALS, key: 'goal', aliases: ['goals', 'ambitions'], patterns: [
      { regex: /my (?:goal|ambition|dream) is (?:to )?(.+?)(?:\s*[,.]|$)/i, group: 1, reason: 'goal_is' },
      // v3 (Extraction Audit): the ONLY goal pattern was "my goal is" — every
      // natural phrasing produced zero candidates. Verb-anchored so "I want
      // to know the time" stays out while durable ambitions land.
      { regex: /i want to (be(?:come)?|build|create|make|start|launch|learn|master|reach|achieve|get|grow|raise|earn|win|write|ship|found) (.+?)(?:\s*[,.!?]|$)/i, group: 0, reason: 'want_to', confidence: 0.85,
        transform: (m) => `${m[1]} ${m[2]}`.trim() },
      { regex: /i(?:'m| am) (?:trying|planning|aiming|hoping|determined) to (.+?)(?:\s*[,.!?]|$)/i, group: 1, reason: 'trying_to', confidence: 0.82 },
      { regex: /help me (?:to )?(become|build|create|make|start|launch|learn|master|reach|achieve|get|grow|raise|earn|win|write|ship|plan) (.+?)(?:\s*[,.!?]|$)/i, group: 0, reason: 'help_me_goal', confidence: 0.8,
        transform: (m) => `${m[1]} ${m[2]}`.trim() },
    ], normalizer: normalizeTrim, validator: validateWords(2, 15), multiValue: true, conflictPolicy: CONFLICT_POLICIES.MERGE_COLLECTION, importance: 6, baseConfidence: 0.85, retrievalHints: ['goal', 'ambition', 'dream'] },
];

// ── Indexes for O(1) lookup ───────────────────────────────────────────────────
export const SCHEMA_BY_KEY = new Map();
export const SCHEMA_BY_ALIAS = new Map();
for (const entry of MEMORY_SCHEMA) {
  SCHEMA_BY_KEY.set(entry.key, entry);
  for (const alias of entry.aliases || []) SCHEMA_BY_ALIAS.set(alias, entry);
}

export function getSchema(key) {
  return SCHEMA_BY_KEY.get(key) || SCHEMA_BY_ALIAS.get(key) || null;
}

export function getSchemaByCategory(category) {
  return MEMORY_SCHEMA.filter(e => e.category === category);
}

// ── Semantic Mappings ─────────────────────────────────────────────────────────
export const SEMANTIC_CONCEPTS = Object.freeze({
  'programming stack': ['favorite_language', 'languages', 'favorite_framework', 'favorite_editor', 'favorite_os'],
  'coding setup': ['favorite_editor', 'favorite_os', 'languages', 'favorite_framework'],
  'tech stack': ['languages', 'frameworks', 'favorite_editor', 'favorite_os'],
  'food': ['favorite_food', 'disliked_food', 'favorite_drink', 'dietary_restrictions'],
  'family': ['spouse', 'children', 'parents', 'siblings'],
  'travel': ['visited_countries', 'dream_destinations'],
  'goals': ['goal', 'ambition'],
  'projects': ['project', 'cofounder', 'workplace', 'profession'],
  'preferences': ['preference', 'likes', 'favorite_language', 'favorite_framework', 'favorite_editor'],
  'enjoy': ['hobbies', 'favorite_movie', 'favorite_music', 'favorite_food', 'favorite_sport'],
  'entertainment': ['favorite_movie', 'favorite_book', 'favorite_music', 'favorite_sport'],
});

export const CATEGORY_ALIASES = Object.freeze({
  'preferences': CATEGORIES.PREFERENCES, 'likes': CATEGORIES.PREFERENCES, 'favorites': CATEGORIES.PREFERENCES,
  'tech': CATEGORIES.TECHNOLOGY, 'technology': CATEGORIES.TECHNOLOGY,
  'programming': CATEGORIES.PROGRAMMING, 'code': CATEGORIES.PROGRAMMING, 'coding': CATEGORIES.PROGRAMMING,
  'work': CATEGORIES.WORK, 'job': CATEGORIES.WORK, 'career': CATEGORIES.WORK,
  'education': CATEGORIES.EDUCATION, 'school': CATEGORIES.EDUCATION, 'university': CATEGORIES.EDUCATION,
  'family': CATEGORIES.FAMILY, 'relatives': CATEGORIES.FAMILY,
  'pets': CATEGORIES.PETS, 'animals': CATEGORIES.PETS,
  'food': CATEGORIES.FOOD, 'diet': CATEGORIES.FOOD,
  'travel': CATEGORIES.TRAVEL,
  'hobbies': CATEGORIES.LIFESTYLE, 'lifestyle': CATEGORIES.LIFESTYLE,
  'goals': CATEGORIES.GOALS,
  'projects': CATEGORIES.PROJECTS,
  'health': CATEGORIES.HEALTH,
  'entertainment': CATEGORIES.ENTERTAINMENT, 'media': CATEGORIES.ENTERTAINMENT,
  'identity': CATEGORIES.IDENTITY, 'personal': CATEGORIES.IDENTITY,
});

export function getWordIndex() {
  if (!globalThis._aquaWordIndex) {
    const index = new Map();
    for (const entry of MEMORY_SCHEMA) {
      const words = new Set();
      entry.key.split('_').forEach(w => words.add(w));
      (entry.aliases || []).forEach(a => a.split('_').forEach(w => words.add(w)));
      (entry.retrievalHints || []).forEach(h => h.toLowerCase().split(/\s+/).forEach(w => words.add(w)));
      
      for (const word of words) {
        if (word.length > 1) {
          if (!index.has(word)) index.set(word, new Set());
          index.get(word).add(entry.key);
        }
      }
    }
    globalThis._aquaWordIndex = index;
  }
  return globalThis._aquaWordIndex;
}