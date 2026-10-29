/**
 * AQUA — sensitive personal categories: health and mood (2026-10-28).
 *
 * Production's Memory page showed "unable to enjoy anything" used 186 times,
 * "very bored" 233 times and "right eye = moving automatically" 79 times:
 * health and emotional-state statements, captured by the custom_ fallback,
 * injected into almost every reply. This module is the ONE deterministic
 * answer to "is this about someone's health or mood?" (L3: code decides — no
 * model call). Every store that writes or answers asks it:
 *
 *   write  — memory/engine.js memoryObserve and routes/turnPostProcess.js see
 *            the turn with sensitive sentences removed unless the user opted in
 *            (`rememberSensitive`); opted-in facts are tagged `sensitivity`.
 *   read   — memory/memoryRetriever.js drops them at the source, and
 *            routes/chat.js scrubs every assembled context block, so no lane
 *            (legacy facts, Mind, graph, episodes, evidence lane, canonical
 *            claims) can carry one — unless the user opted in AND the current
 *            message is itself about that topic.
 *
 * Decisions (judgement calls, so written down):
 *   · "bored of React" / "tired of meetings" / "sick of X" is an OPINION about
 *     a topic, not the user's emotional state → null. "I'm very bored" → mood.
 *   · "eye-tracking feature", "back end", "head of sales", "stress test",
 *     "pain points", "diagnose the bug" are work language → null.
 *   · Health vocabulary counts only when the sentence is about a person ("I",
 *     "my …") and not about something they build or sell: "I have diabetes"
 *     → health; "we build an app for diabetes patients" → null.
 *   · Psychiatric diagnoses ("I have ADHD / bipolar") are health; felt states
 *     ("depressed", "anxious", "lonely") are mood. Both are hidden by default;
 *     the split only decides which topic a later message must be about for an
 *     opted-in user.
 *   · "My sister is depressed" is still sensitive: it is someone's health.
 *   · Diet ("I'm vegetarian") is a preference, not health, although the schema
 *     files diet under the `health` category: the text decides, not the
 *     category.
 */

/** @typedef {'health'|'mood'} SensitivityKind */

const MOOD_WORDS = '(?:bored|sad|depressed|anxious|lonely|stressed(?:\\s+out)?|unhappy|miserable|hopeless|worthless|empty|numb|overwhelmed|burn(?:ed|t)\\s+out|exhausted|upset|scared|insecure|heartbroken|devastated|suicidal|unmotivated)';

const MOOD = [
  // A felt state in the first person: "I'm very bored", "I've been feeling lonely".
  new RegExp(`\\b(?:i\\s+(?:am|feel|felt|have\\s+been|was|get|keep)|i'm|im|i've\\s+been|feeling|felt)\\s+(?:\\w+\\s+){0,2}${MOOD_WORDS}\\b`, 'i'),
  // A stored value that is nothing but the state: "very bored".
  new RegExp(`^\\s*(?:very|so|really|super|quite|extremely|always|constantly|kind\\s+of|kinda)?\\s*${MOOD_WORDS}\\s*(?:lately|these\\s+days|all\\s+the\\s+time)?\\s*[.!]?\\s*$`, 'i'),
  /\b(?:unable|can'?t|cannot|no\s+longer\s+able|stopped\s+being\s+able)\s+(?:to\s+)?(?:enjoy\s+(?:anything|life|things|it\s+anymore)|feel\s+(?:anything|happy|joy)|get\s+out\s+of\s+bed|stop\s+crying|stop\s+worrying)\b/i,
  /\b(?:anhedonia|panic\s+attacks?|self[-\s]?harm|suicid\w*|mental\s+breakdown|crying\s+(?:all|every)\w*|mood\s+swings?)\b/i,
  /\bmy\s+(?:mood|mental\s+health|emotional\s+state|feelings)\b/i,
];
/** Conditions named as one's own: "I have anxiety", "my depression". */
const MOOD_CONDITION = /\b(?:depression|anxiety|loneliness|burnout|grief|grieving)\b/i;

const HEALTH_TERMS = /\b(?:pain|painful|ache|aching|headaches?|migraines?|fever|nausea|nauseous|dizzy|dizziness|vomit\w*|cough\w*|rash|bleeding|insomnia|can'?t\s+sleep|fatigue|seizures?|numbness|tingling|twitch\w*|swollen|swelling|lump|infection|infected|blurry\s+vision|injur\w+|fractured?|sprain\w*|allerg\w+|asthma|diabet\w+|cancer|tumou?r|adhd|autis\w+|ocd|ptsd|bipolar|schizophren\w+|epilep\w+|arthritis|hypertension|blood\s+pressure|thyroid|diagnos\w+|symptoms?|medication|medicines?|meds|pills?|prescri\w+|antidepressants?|insulin|ibuprofen|paracetamol|acetaminophen|sertraline|prozac|xanax|adderall|ritalin|dosage|therap(?:y|ist)|psychiatrist|surgery|hospitali[sz]ed|in\s+(?:the\s+)?hospital|doctor|pregnan\w+|miscarriage|mental\s+health)\b/i;

const BODY_PART = '(?:eyes?|ears?|head|chest|heart|stomach|belly|back|knees?|legs?|arms?|hands?|fingers?|skin|tooth|teeth|throat|lungs?|kidneys?|liver|nose|neck|shoulders?|wrists?|foot|feet|hips?|ankles?|jaw|eyelids?|muscles?|joints?|spine|bladder|bowels?)';
const ABNORMAL = "(?:mov(?:es|ing)\\s+(?:on\\s+its\\s+own|automatically|by\\s+itself)|twitch\\w*|hurts?|hurting|pain\\w*|swollen|swelling|bleed\\w*|numb|blurry|itch\\w*|ach(?:es|ing|y)|sore|broken|infected|burn(?:s|ing)|throbb\\w*|cramp\\w*|shak(?:es|ing|y)|trembl\\w*|keeps?\\s+\\w+ing|won'?t\\s+stop|feels?\\s+(?:weird|strange|funny|heavy|tight)|(?:is|are)\\s+(?:moving|jumping|spasming|red|yellow))";
const BODY_ABNORMAL = [
  // "my right eye is moving automatically", "my left knee hurts"
  new RegExp(`\\b(?:my|right|left|both)\\s+(?:\\w+\\s+)?${BODY_PART}\\b(?![-\\s]?(?:end|of|office|track\\w*|line|story|count|room))[^.!?\\n]{0,40}?\\b${ABNORMAL}`, 'i'),
  // "a sharp pain in my chest"
  new RegExp(`\\b${ABNORMAL}[^.!?\\n]{0,20}\\b(?:in|on)\\s+my\\s+(?:\\w+\\s+)?${BODY_PART}\\b`, 'i'),
];

/** Work/product language that shares a word with the vocabularies above. */
const NOT_SENSITIVE = /\b(?:pills?[-\s]?(?:shaped|button|badge|tabs?)|stress[-\s]?test\w*|load\s+test\w*|sad\s+path|happy\s+path|eye[-\s]?tracking|back[-\s]?end|front[-\s]?end|head\s+of\s+\w+|heart\s+of\s+the|hands[-\s]?(?:on|off)|arm64|pain\s+points?|customer\s+pain|growing\s+pains|health\s*(?:check|endpoint|score)s?|bleeding[-\s]edge|feature\s+fatigue|alert\s+fatigue|decision\s+fatigue|kernel\s+panic|symptoms?\s+of\s+the\s+(?:bug|issue|outage|problem)|diagnos\w+\s+(?:the|a|this|that)\s+(?:bug|issue|error|problem|outage|crash|failure))\b/gi;

/** "bored of React", "tired of meetings", "sick of X": an opinion about a topic. */
const OPINION_ABOUT_TOPIC = /\b(?:bored|tired|sick|fed\s+up)\s+(?:of|with)\s+(?!(?:life|everything|myself|living|it\s+all)\b)\S+/gi;

/** Whose: the speaker or someone they name ("I", "my sister"). */
const PERSONAL_ANCHOR = /(?:^|[^\p{L}'])(?:i|i'm|im|i've|i'd|i'll|me|my|mine|myself)(?=[^\p{L}']|$)/iu;
/** A sentence about what the user BUILDS, SELLS or STUDIES, not their own body or mind. */
const PRODUCT_FRAMING = /\b(?:app|apps|startup|product|platform|tool|tools|feature|features|saas|customers?|users?|patients|clinics?|market|pitch|investors?|build(?:ing|s)?|launch\w*|company|business|api|dashboard|website|research(?:ing)?|article|blog|essay|course|lecture|chapter|novel|character|game|dataset)\b/i;

/** Classify one piece of text. */
export function classifyText(text) {
  const t = String(text ?? '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  if (t.length < 3) return null;
  const masked = t.replace(NOT_SENSITIVE, ' ').replace(/\s+/g, ' ');
  if (BODY_ABNORMAL.some(re => re.test(masked))) return 'health';
  const personal = PERSONAL_ANCHOR.test(masked) && !PRODUCT_FRAMING.test(masked);
  if (personal && HEALTH_TERMS.test(masked)) return 'health';
  const moodText = masked.replace(OPINION_ABOUT_TOPIC, ' ');
  if (MOOD.some(re => re.test(moodText))) return 'mood';
  if (personal && MOOD_CONDITION.test(moodText)) return 'mood';
  return null;
}

/** The extractor's own snake_case key → words ("custom_right_eye" → "right eye"). */
function keyWords(key) {
  return String(key ?? '').replace(/^custom_/, '').replace(/_/g, ' ').trim();
}

function textOf(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(textOf).join('; ');
  if (typeof v === 'object') return [v.name, v.value, v.label, v.text, v.statement].filter(Boolean).map(String).join(' ');
  return String(v);
}

/**
 * Classify a fact (legacy fact, claim, evidence fact, belief) or a string.
 * An explicit tag wins; otherwise key, value and source sentence are read.
 *
 * @param {object|string} fact
 * @returns {SensitivityKind|null}
 */
export function classifySensitivity(fact) {
  if (fact == null) return null;
  if (typeof fact === 'string') return classifyText(fact);
  if (fact.sensitivity === 'health' || fact.sensitivity === 'mood') return fact.sensitivity;
  const key = keyWords(fact.key);
  const value = textOf(fact.value);
  const direct = classifyText([fact.statement, fact.statementText, fact.text, fact.label].filter(Boolean).join(' — '));
  if (direct) return direct;
  // The custom_ fallback stores "my right eye is moving automatically" as
  // key=custom_right_eye, value="moving automatically": neither half alone
  // reads as a symptom; the sentence they came from does. A schema key (goal,
  // favorite_food) is not a body part or a feeling, so it is read as "my X is
  // Y" too — "my goal is to feel less anxious" is still about anxiety.
  if (value) {
    const joined = (key && classifyText(`my ${key} is ${value}`)) ?? classifyText(`i am ${value}`) ?? classifyText(value);
    if (joined) return joined;
  }
  return classifyText(fact.sourceText ?? fact.sourceMessage ?? fact.sentence ?? '');
}

/**
 * The read policy for one turn: sensitive memory may reach the prompt only
 * when the user opted in AND the current message is itself about that topic.
 */
export function sensitivePolicy({ rememberSensitive = false, message = '' } = {}) {
  const topic = classifyText(message);
  const optedIn = rememberSensitive === true;
  return {
    rememberSensitive: optedIn,
    topic,
    allows: kind => optedIn && !!kind && kind === topic,
  };
}

/** True when `fact` is sensitive and the read policy does not allow it this turn. */
export function withheld(fact, policy) {
  const kind = classifySensitivity(fact);
  if (!kind) return false;
  return !(policy?.allows?.(kind));
}

const SENTENCE = /[^.!?\n]+(?:[.!?]+|\n|$)/g;

/**
 * The write-side view of a turn: sentences about health or mood removed.
 * Callers apply it only when the user has not opted in.
 */
export function redactSensitiveSentences(text) {
  const src = String(text ?? '');
  if (!src) return { text: src, removed: [] };
  const removed = [];
  const kept = [];
  for (const m of src.match(SENTENCE) ?? []) {
    const kind = classifyText(m);
    if (kind) removed.push(kind);
    else kept.push(m);
  }
  if (!removed.length) return { text: src, removed };
  return { text: kept.join('').replace(/[ \t]{2,}/g, ' ').trim(), removed };
}

/**
 * Read-side backstop over an assembled context block: every content line the
 * policy withholds is dropped. Structural lines (headers, delimiters) never
 * classify, so they stay.
 */
export function scrubSensitiveLines(block, policy) {
  const src = String(block ?? '');
  if (!src) return { block: src, removed: 0 };
  let removed = 0;
  const lines = src.split('\n').filter(line => {
    // "- very bored: very bored" (the fact lane's "- label: value") reads like a fact.
    const kv = line.match(/^\s*(?:[-*•]|\d+[.)])\s*([^:]{1,60}):\s*(.+)$/);
    const kind = classifyText(line) ?? (kv ? classifySensitivity({ key: kv[1].trim().replace(/\s+/g, '_'), value: kv[2] }) : null);
    if (kind && !policy?.allows?.(kind)) { removed++; return false; }
    return true;
  });
  return { block: removed ? lines.join('\n') : src, removed };
}
