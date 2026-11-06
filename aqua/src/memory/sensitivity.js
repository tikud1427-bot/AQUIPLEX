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
import { splitClauses } from './sentenceParser.js';

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

/** The speaker's own care provider: "my therapist", "I see a doctor", "I started therapy" (singular, first person). */
const CARE_RELATION = /\b(?:my\s+(?:therapist|doctor|psychiatrist|psychologist|counsell?or|gp|physician|cardiologist|oncologist|neurologist|dermatologist)\b|i\s+(?:see|saw|visit(?:ed)?|have|had|started\s+seeing|am\s+seeing|'m\s+seeing|went\s+to)\s+(?:a|my|the)\s+(?:therapist|doctor|psychiatrist|psychologist|counsell?or|gp|physician)\b|i\s+(?:started|began|am\s+in|'m\s+in|go\s+to)\s+(?:therapy|counsell?ing|rehab)\b)/i;

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
  // A first-person care relationship is about one's own health whatever the
  // framing: "I see a therapist at Harlow Clinic" read as product talk ("clinic")
  // and was not classified at all (2026-11-06). Strengthens, never relaxes.
  if (CARE_RELATION.test(masked)) return 'health';
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
  // The clause the fact was read from, when known: the rest of its sentence may be
  // about something else — but only a clause that redaction would keep stands on its
  // own (keptClauses); otherwise the sentence it came from decides (2026-11-06).
  const source = fact.sourceText ?? fact.sourceMessage ?? fact.sentence ?? '';
  if (fact.clause) {
    const own = classifyText(fact.clause);
    if (own) return own;
    const sentence = (String(source).match(SENTENCE) ?? []).find(s => s.includes(String(fact.clause).trim().slice(0, 24))) ?? String(source);
    const whole = classifySentence(sentence);
    if (!whole) return null;
    const kept = keptClauses(sentence);
    return kept && kept.some(c => c.includes(String(fact.clause).trim()) || String(fact.clause).includes(c)) ? null : whole;
  }
  return classifySentences(source);
}

// ── Clause-level withholding (2026-11-06) ───────────────────────────────────
// A sensitive sentence loses only its sensitive clause when, and only when, what
// remains is plainly independent of it. Any doubt withholds the whole sentence.

/**
 * The kind of ONE sentence, read whole AND clause by clause. classifyText reads
 * the whole: a sibling clause's product framing ("I have asthma, and we are
 * building an app for runners.") masked the health clause, so the sentence read
 * as not sensitive and was kept, health clause included. A sentence is
 * sensitive when it is as a whole or when any of its clauses is.
 */
export function classifySentence(sentence) {
  const s = String(sentence ?? '');
  return classifyText(s) ?? splitClauses(s.trim().replace(/[.!?]+$/, '')).map(c => classifyText(c)).find(Boolean) ?? null;
}

/** The kind of a text of one or more sentences, each read by classifySentence. */
export function classifySentences(text) {
  const src = String(text ?? '');
  return (src.match(SENTENCE) ?? [src]).map(classifySentence).find(Boolean) ?? null;
}

/** Any health / mood vocabulary at all, whatever the framing ("an app for my therapist"). */
function mentionsSensitive(text) {
  const t = String(text ?? '').replace(/[‘’]/g, "'").replace(NOT_SENSITIVE, ' ');
  return HEALTH_TERMS.test(t) || MOOD_CONDITION.test(t) || new RegExp(`\\b${MOOD_WORDS}\\b`, 'i').test(t)
    || BODY_ABNORMAL.some(re => re.test(t)) || MOOD.some(re => re.test(t)) || MEDICAL_CONTEXT.test(t);
}
/** Care-domain words that are not themselves a condition. Used ONLY to decide whether a clause
 *  beside a withheld one may be kept, so it can only ever withhold more, never classify. */
const MEDICAL_CONTEXT = /\b(?:inhalers?|clinics?|hospitals?|patients?|pharmac\w+|prescriptions?|treatments?|nurses?|surgeons?|doctors|physicians?|therapists|psychiatrists|psychologists?|medic\w*|rehab\w*|counsell?(?:ors?|ing)|wellness|mental|health|illness|sick|recovery|appointments?\s+with)\b/i;
/** A clause that opens on a word pointing back at something said before it. */
const POINTS_BACK = /^(?:and\s+|but\s+|while\s+|so\s+)?(?:it|its|it's|this|that|these|those|he|she|they|him|her|them|his|their|which|who|whose)\b/i;
const NAME_OR_DETAIL = text => new Set((String(text).match(/[\p{L}\p{N}'’-]+/gu) ?? [])
  .filter(w => /^\p{Lu}/u.test(w) ? w.length > 1 && !/^(?:I|I'm|I've|I'd|I'll|My|Our|We|The|A|An)$/.test(w) : w.length >= 4 && !DETAIL_STOP.has(w.toLowerCase()))
  .map(w => w.toLowerCase().replace(/['’]s$/, '')));
const DETAIL_STOP = new Set(('also really very just still been have having with from that this they them their there then than what when where which while your yours mine ours about after before because into onto over under some more most much many such only even ever every week weeks month months year years today tomorrow yesterday lately thing things stuff going doing being make made like want wants need needs know think said says feel felt good great fine okay much little lots plan plans work works working time times').split(' '));

/**
 * The clauses of a sensitive sentence that may be kept, or null when the whole
 * sentence must be withheld. A clause is kept only when:
 *   · it does not classify on its own AND names no sensitive term at all (product,
 *     work or app framing never makes "my therapist" keepable);
 *   · some OTHER clause classifies on its own (a sentence that is sensitive only
 *     across its clauses — "The doctor called, and I was relieved." — is context,
 *     and goes whole);
 *   · coming after a sensitive clause, it does not open on a word pointing back
 *     at it ("…and she says I'm improving");
 *   · it shares no name or content word with a sensitive clause (no identifying
 *     detail survives: "…, I also run at Harlow Park" after "Harlow Clinic").
 * Any clause failing → null. Clause boundaries are sentenceParser.splitClauses
 * (a new subject after "and/but/while", ";" or ","; never inside a name; ≥3 words).
 */
export function keptClauses(sentence) {
  const clauses = splitClauses(String(sentence ?? '').trim().replace(/[.!?]+$/, ''));
  if (clauses.length < 2) return null;
  const sensitive = clauses.map(c => !!classifyText(c));
  if (!sensitive.some(Boolean) || sensitive.every(Boolean)) return null;
  const details = new Set(clauses.filter((_, i) => sensitive[i]).flatMap(c => [...NAME_OR_DETAIL(c)]));
  const kept = [];
  for (let i = 0; i < clauses.length; i++) {
    if (sensitive[i]) continue;
    const c = clauses[i];
    if (mentionsSensitive(c)) return null;
    if (sensitive.slice(0, i).some(Boolean) && POINTS_BACK.test(c.trim())) return null;
    if ([...NAME_OR_DETAIL(c)].some(w => details.has(w))) return null;
    kept.push(c);
  }
  return kept.length ? kept : null;
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
    const kind = classifySentence(m);   // whole AND clause by clause: a sibling's framing never masks a clause
    if (!kind) { kept.push(m); continue; }
    // Only the sensitive CLAUSE goes (2026-11-04): "My mentor is Grace Liu and my
    // therapist is private." lost the mentor with it. What stays must be plainly
    // independent of what went (keptClauses, 2026-11-06); any doubt withholds the
    // whole sentence. Each kept clause becomes its own sentence.
    const safe = keptClauses(m) ?? [];
    removed.push(kind);
    for (const c of safe) kept.push(` ${c.replace(/[\s,;]+$/, '').replace(/[.!?]?$/, '.')} `);
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
