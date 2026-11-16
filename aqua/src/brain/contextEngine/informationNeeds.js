/**
 * AQUA — Information Needs Engine (Sprint 3, 2026-11-10)
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY. ACIB v1 measured the production context on a long history: for "Should
 * I hire another developer?" it held 1 of 6 decision-critical facts beside 14
 * irrelevant items, because what reaches the model is "everything the user
 * said" until 8,000 characters and keyword similarity after. The question
 * planner (queryPlan.js) knew which needs a decision has — but only ran inside
 * the disabled Context Engine V2, over Postgres predicates.
 *
 * WHAT. Understand the question (A), derive the information it requires (B),
 * retrieve evidence for EACH requirement from the stores production has (C),
 * judge each requirement (found / missing / uncertain / contradictory /
 * outdated / forgotten) (D), decide whether the context is sufficient (E),
 * and render the smallest context that answers it.
 *
 * BUILT ON, NOT BESIDE:
 *   · question form       queryPlan.isDecisionForm, pic/questionShape.analyseQuestion
 *   · sufficiency model   queryPlan's required-slot contract (essential needs)
 *   · evidence pool       episodicRecall.collectUnits (user-scoped history + files)
 *   · privacy             recallRedactions (forget list), retrievalPrivacy.withheldBy
 *                         (sensitive policy) — via episodicRecall forgetClean/withholdClean
 *   · ranking terms       stateTransition.tokens (the recall tokenizer)
 *   · time and change     stateTransition.changeKind / corrects / speculative
 *   · structured facts    longTermMemory.getFacts (the profile store)
 *   · rendering           episodicRecall.formatRecall (the existing fenced block)
 * No database, no embeddings, no model call. Deterministic.
 *
 * RULES IT KEEPS.
 *   · A question or a request to the assistant is never evidence, and is never
 *     a goal (the Mind records questions as goals today; this engine does not
 *     read Mind goals for that reason — current goals come from what the user
 *     STATED, with later words resolving earlier ones).
 *   · Speculation ("I might…", "not sure yet") is uncertain, never a fact.
 *   · An explicit "forget my X" in the history removes earlier statements
 *     about X from the evidence, even when no stored fact held X.
 *   · Missing essential information is SAID to be missing, never filled in.
 *
 * Gate: AQUA_INFO_NEEDS = off (default) | shadow (compute + log counts, prompt
 * unchanged) | on (the engine's context replaces the broad personal lanes on
 * the turns it understands). See routes/chat.js.
 */
import { analyseQuestion } from '../../pic/questionShape.js';
import { isDecisionForm } from './queryPlan.js';
import { tokens, changeKind, corrects } from '../../understanding/stateTransition.js';
import { collectUnits, forgetClean, withholdClean, recallRedaction, formatRecall } from '../../memory/episodicRecall.js';
import { redactionsFor } from '../../memory/recallRedactions.js';
import { withheldBy, policyKey } from '../../memory/retrievalPrivacy.js';
import { getFacts } from '../../memory/longTermMemory.js';
import { detectForget } from '../../memory/memoryExtractor.js';

export function infoNeedsMode(env = process.env) {
  const v = String(env.AQUA_INFO_NEEDS ?? '').toLowerCase();
  return v === 'on' ? 'on' : v === 'shadow' ? 'shadow' : 'off';
}

// ── Vocabulary (stems via the recall tokenizer, so matching agrees with recall) ──
const stems = words => [...new Set(words.flatMap(w => tokens(w)))];
const V = Object.freeze({
  team:        stems(['engineer', 'engineers', 'developer', 'developers', 'programmer', 'team', 'headcount', 'staff']),
  departure:   stems(['leaving', 'leave', 'left', 'quit', 'quitting', 'resign', 'resigned', 'notice', 'departure']),
  cash:        stems(['bank', 'cash', 'savings', 'saved', 'budget', 'funding', 'raised', 'balance', 'money']),
  runway:      stems(['burn', 'runway', 'spend', 'spending', 'expenses', 'monthly']),
  revenue:     stems(['revenue', 'mrr', 'arr', 'sales', 'subscribers', 'customers', 'paying']),
  income:      stems(['earn', 'earning', 'salary', 'income', 'paid', 'wage', 'wages']),
  cost:        stems(['cost', 'costs', 'price', 'priced', 'quote', 'quoted', 'salary', 'fee', 'charge', 'pay']),
  workload:    stems(['ship', 'launch', 'release', 'deadline', 'due', 'roadmap', 'milestone', 'workload', 'backlog', 'blocked', 'blocking', 'behind']),
  decision:    stems(['decided', 'decision', 'agreed', 'policy', 'committed', 'promised', 'rule']),
  goal:        stems(['goal', 'goals', 'aim', 'objective']),
  preference:  stems(['prefer', 'preference', 'cheap', 'casual', 'fancy', 'love', 'loves', 'like', 'likes', 'favourite', 'favorite', 'hate']),
  diet:        stems(['vegetarian', 'vegan', 'diet', 'eat', 'eats', 'food']),
  schedule:    stems(['visiting', 'visit', 'trip', 'travel', 'staying', 'saturday', 'sunday', 'weekend', 'monday', 'morning', 'every', 'practice', 'schedule']),
  commute:     stems(['commute', 'office', 'relocate', 'move', 'flat', 'distance', 'city']),
  employment:  stems(['work', 'works', 'working', 'job', 'role', 'employer', 'company', 'profession', 'nurse', 'engineer', 'manager', 'analyst', 'teacher', 'lawyer']),
  location:    stems(['live', 'lives', 'living', 'address', 'home', 'city', 'moved', 'flat', 'house', 'street', 'road']),
  naming:      stems(['named', 'name', 'called', 'call']),
  status:      stems(['blocked', 'blocking', 'block', 'behind', 'track', 'schedule', 'delayed', 'waiting', 'finished', 'live', 'done', 'late', 'early']),
});
/**
 * Life domains (V2, 2026-11-11). A decision is made INSIDE a domain — a job offer
 * in work, a van in money and transport — and the user's situation in that domain
 * bears on it even when it shares no word with the question ("Should I take the
 * Marlow & Pike job?" needs "I make 45k at Hollin" and "I'm learning a lot from my
 * boss"). Broad, general vocabularies per domain; not per scenario.
 */
const DOMAINS = Object.freeze({
  work: stems(['job', 'jobs', 'work', 'works', 'working', 'career', 'boss', 'manager', 'lead', 'team', 'colleague', 'colleagues', 'coworker',
    'office', 'commute', 'salary', 'raise', 'promotion', 'promoted', 'offer', 'offered', 'role', 'position', 'employer', 'company', 'firm',
    'studio', 'client', 'clients', 'contract', 'hours', 'shift', 'remote', 'hybrid', 'quit', 'resign', 'fired', 'hired', 'interview',
    'credit', 'project', 'projects', 'deadline', 'workload', 'overtime', 'meetings', 'redundancy', 'notice', 'appraisal', 'review', 'bonus']),
  money: stems(['money', 'savings', 'saved', 'save', 'saving', 'bank', 'income', 'earn', 'earns', 'salary', 'pay', 'paid', 'take-home',
    'budget', 'afford', 'cost', 'costs', 'price', 'prices', 'loan', 'debt', 'owe', 'owes', 'interest', 'mortgage', 'rent', 'bills',
    'spend', 'spent', 'spare', 'cash', 'invest', 'pension', 'profit', 'revenue', 'fee', 'fees', 'charge', 'quote', 'quoted', 'bonus', 'grand']),
  home: stems(['home', 'house', 'flat', 'apartment', 'rent', 'landlord', 'mortgage', 'move', 'moved', 'moving', 'live', 'neighbourhood',
    'garden', 'kitchen', 'bathroom', 'roof', 'loft', 'boiler', 'renovate', 'renovation', 'sell', 'buy']),
  family: stems(['partner', 'wife', 'husband', 'kids', 'children', 'child', 'son', 'daughter', 'baby', 'family', 'mum', 'mom', 'dad',
    'parents', 'sister', 'brother', 'school', 'pregnant', 'due']),
  health: stems(['health', 'injury', 'injured', 'pain', 'doctor', 'diet', 'allergic', 'allergy', 'sleep', 'tired', 'exhausted', 'stress', 'stressed', 'burnout']),
  learning: stems(['course', 'courses', 'study', 'studying', 'degree', 'certificate', 'qualification', 'bootcamp', 'mba', 'learn', 'learning', 'class', 'exam', 'training']),
  business: stems(['business', 'customers', 'customer', 'clients', 'sales', 'sell', 'sold', 'prices', 'price', 'profit', 'revenue', 'competition',
    'competitor', 'competitors', 'demand', 'orders', 'queue', 'queues', 'shop', 'cafe', 'café', 'consultancy', 'freelance', 'margin', 'costs', 'supplier']),
  pets: stems(['dog', 'dogs', 'cat', 'cats', 'puppy', 'pet', 'pets', 'walk', 'walks', 'vet']),
  transport: stems(['car', 'van', 'bike', 'commute', 'drive', 'driving', 'train', 'mileage', 'repairs', 'breaking']),
});
const domainsOf = toks => Object.entries(DOMAINS).filter(([, list]) => toks.some(t => list.includes(t))).map(([d]) => d);

/** Standing constraints a recommendation must respect (food: diet; gifts: what the person loves). */
const CONSTRAINTS = Object.freeze({
  food: { cue: /\b(?:cook|cooking|bake|baking|dinner|lunch|breakfast|meal|meals|recipe|eat|food|snack|menu|restaurant)\b/i,
    terms: stems(['vegan', 'vegetarian', 'pescatarian', 'coeliac', 'celiac', 'gluten', 'dairy', 'lactose', 'allergic', 'allergy', 'intolerant',
      'halal', 'kosher', 'diet', 'hate', 'dislike', 'eat', 'eating', 'fish', 'meat', 'nuts', 'shellfish', 'spicy']) },
  gift: { cue: /\b(?:gift|present|birthday|christmas|get (?:him|her|them|my)|buy (?:him|her|them|my))\b/i,
    terms: stems(['love', 'loves', 'obsessed', 'enjoys', 'enjoy', 'hobby', 'into', 'collects', 'fan', 'spends', 'allotment', 'garden', 'reading', 'music']) },
});

/** Words too common to tie a question to the user's own history. */
const COMMON = new Set(stems(['time', 'good', 'thing', 'things', 'way', 'people', 'person', 'day', 'days', 'year', 'years', 'make', 'get', 'much',
  'many', 'long', 'far', 'best', 'work', 'world', 'number', 'part', 'kind', 'type', 'mean', 'means', 'difference', 'example', 'use', 'used',
  'happen', 'happens', 'right', 'new', 'old', 'big', 'small', 'first', 'last', 'need', 'know', 'tell', 'say', 'said', 'think', 'like', 'want']));

const PHRASE = Object.freeze({
  decision: [/\bhold off\b/i, /\bwe (?:decided|agreed)\b/i, /\bour (?:policy|rule)\b/i],
  runway: [/\bper month\b/i, /\ba month\b/i, /\bat the current spend\b/i],
});

/** Hyponyms a question's noun stands for (lexical expansion, not semantics). */
const KINDS = Object.freeze({
  dog: ['dog', 'puppy', 'greyhound', 'terrier', 'labrador', 'retriever', 'poodle', 'spaniel', 'collie', 'beagle', 'whippet'],
  cat: ['cat', 'kitten', 'tabby'],
  kids: ['kids', 'kid', 'children', 'child', 'son', 'daughter'],
  developer: ['developer', 'engineer', 'programmer', 'dev'],
  partner: ['partner', 'wife', 'husband', 'boyfriend', 'girlfriend', 'spouse', 'fiance', 'fiancee'],
});
const RELATIONS = /\b(sister|brother|mother|mum|mom|father|dad|partner|wife|husband|son|daughter|kids|children|boss|manager|co-?founder|accountant|landlord|client|doctor|friend|neighbou?r|cousin|aunt|uncle)\b/i;

const PERSONAL = /\b(?:i|i'?m|i'?ve|i'?d|i'?ll|me|my|mine|myself|we|we'?re|we'?ve|our|ours|us)\b/i;
/** Requests addressed to the assistant — never evidence of what is true. */
const REQUEST = /^\s*(?:please\s+)?(?:help me|can you|could you|would you|will you|tell me|give me|show me|recommend|suggest|explain|plan\b|make me|write|draft|summari[sz]e|find|forget|remember that|how (?:do|can|should|would)|what(?:'s| is| are| do| should)|why|where|when|who|which|is it|are there|do you)\b/i;
const QUESTION_END = /\?\s*$/;
/**
 * Hedges only. stateTransition.speculative() also counts "want to", "hope to",
 * "plan to" and "if" — right for deciding whether a sentence CHANGES a stored
 * fact, wrong for evidence: "we agreed we want to stay in this city" is a
 * stated commitment, not a guess (held-out ho-job-offer, Sprint 3).
 */
const HEDGE = /\b(?:might|may\s+(?!\d)|maybe|perhaps|possibly|probably|not\s+sure|thinking\s+(?:about|of)|considering|undecided|(?:haven'?t|not|nothing(?:'s|\s+is)?)\s+(?:yet\s+)?decided|someday|eventually)\b/i;

// ── Stage A: understand the question ────────────────────────────────────────

function namesInQuestion(q) {
  const words = String(q).replace(/[?.!,]/g, ' ').split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 1; i < words.length; i++) if (/^[A-Z][a-z]+$/.test(words[i]) && words[i] !== 'I') out.push(words[i]);
  return [...new Set(out)];
}

/**
 * Advice about the asker's own course of action, whether or not it says "I":
 * "Is a new kitchen worth it?", "Is now a good time to ask for a raise?".
 */
const ADVICE_FORM = /^\s*(?:should|shall)\s+(?:i|we)\b|\b(?:can|could)\s+(?:i|we)\s+afford\b|\bis (?:it|this|now|that) (?:a )?good (?:time|idea|moment)\b|\bis (?:it|this|that|a|an|the|now)\b[^?]*\bworth (?:it|the|doing|getting|buying)\b|\bis (?:opening|starting|buying|getting|taking|doing|moving)\b[^?]*\b(?:a good idea|worth it|sensible|wise)\b|\b(?:would it|does it) make sense\b/i;

/** Deterministic reading of the question. `taskType` is the chat classifier's label.
 *  `anchored` (V2): the question names something only the user's history holds. */
export function understandQuestion(question, { taskType = null, anchored = false } = {}) {
  const q = String(question ?? '').trim();
  const shape = analyseQuestion(q);
  const lower = q.toLowerCase();
  const names = namesInQuestion(q);
  const relation = (lower.match(RELATIONS) ?? [])[1] ?? null;
  const advice = ADVICE_FORM.test(q);
  // V2: a capitalised word alone ("the Moon", "Earth") no longer makes a question
  // personal; a name the user's own history holds does, through `anchored`.
  const personal = PERSONAL.test(q) || advice || anchored;
  let intent;
  if (!personal) intent = 'general';
  else if (isDecisionForm(q) || advice) intent = 'decision';
  else if (/^\s*(?:please\s+)?(?:help me\s+)?(?:plan|organi[sz]e|schedule|prepare)\b/i.test(q)) intent = 'planning';
  else if (/\b(?:agree|disagree|differ|consistent|match|contradict)\b/i.test(q) && /\band\b/i.test(q)) intent = 'comparison';
  else if (/\bwhat did\s+\w+\s+(?:say|tell|mention)\b/i.test(q)) intent = 'recall';
  else if (/\b(?:block(?:ing|ed)?|status|on (?:track|schedule)|behind|progress|what'?s left)\b/i.test(q)) intent = 'status';
  else if (/^\s*(?:who|what|what'?s|where|when|which|how many|how much|how long)\b/i.test(q)) intent = 'lookup';
  else intent = 'personal-other';
  const topic = shape.topicTerms?.length ? shape.topicTerms : shape.terms ?? [];
  return {
    question: q, intent, personal, names, relation, taskType, anchored,
    advice: intent === 'decision' || intent === 'planning',
    multiFact: intent === 'decision' || intent === 'planning' || intent === 'comparison',
    currency: shape.currency ?? 'any',          // 'current' | 'past' | 'any' — time sensitivity
    topicTerms: [...new Set(topic.flatMap(t => tokens(t)))],
    shape,
  };
}

// ── Stage B: requirements ───────────────────────────────────────────────────

/**
 * A requirement. V2 fields:
 *   amount         a sentence carrying a money amount counts as evidence (with requireAlso, if set)
 *   essentialWhen  essential only under a condition resolved against the evidence:
 *                  'cost' (the option costs money), 'care' (it takes time or care),
 *                  'move' (it means leaving where they are), 'thin' (only the option is known)
 *   ask            the one clarifying question to ask if this is the gap that matters
 */
const need = (id, label, { essential = true, terms = [], phrases = [], requireAlso = null, entity = null, kind = 'facet', single = false, unknownNote = null, amount = false, essentialWhen = null, ask = null } = {}) =>
  ({ id, label, essential: essentialWhen ? false : essential, terms, phrases, requireAlso, entity, kind, single, unknownNote, amount, essentialWhen, ask });

// The decision model (V2): what a personal decision of ANY kind depends on.
const ACQUIRE = /\b(?:buy|buying|purchase|get|getting|adopt|adopting|hire|take out|start|starting|open|opening|launch|enrol|enroll|sign up|signing up|register|subscribe|book|do|doing|join|invest|renovate|go ahead|build|lend|take on|replace|loan|afford|pay for|spend)\b/i;
const CARE = /\b(?:puppy|dog|cat|kitten|pet|greyhound|baby|child|course|bootcamp|degree|mba|certificate|qualification|study|side (?:project|gig|job|business)|volunteer|allotment|freelance|business|shop|caf[eé])\b/i;
const MOVE = /\b(?:move|moving|relocate|relocation|relocating|emigrate)\b/i;
const MONEY_TERMS = stems(['savings', 'saved', 'save', 'bank', 'budget', 'income', 'earn', 'salary', 'take-home', 'spare', 'afford', 'cash', 'money', 'grand', 'profit']);
const TIME_TERMS = stems(['hours', 'schedule', 'shift', 'shifts', 'busy', 'free', 'evenings', 'weekends', 'time', 'full-time', 'part-time', 'commute', 'travel', 'away']);
const CRITERIA_TERMS = stems(['goal', 'goals', 'aim', 'want', 'wants', 'hope', 'dream', 'career', 'reason', 'because', 'enjoy', 'love', 'passion', 'priority', 'matters']);
const TIES_TERMS = stems(['partner', 'wife', 'husband', 'kids', 'children', 'family', 'parents', 'mum', 'dad', 'school', 'house', 'flat', 'home', 'friends', 'job', 'mortgage']);
const ADVICE_WORDS = new Set(stems(['should', 'worth', 'idea', 'good', 'time', 'now', 'take', 'go', 'ahead', 'sense', 'afford', 'opening', 'getting', 'doing', 'right']));
// Situation said without a domain word: tenure ("I've been at Corvel for four years"),
// new competition ("two new walkers started in my area"), a standing arrangement.
const SITUATION_PHRASES = [
  /\b(?:i'?ve|i have|we'?ve|we have)\s+been\s+(?:at|with|in)\b[^.]*\bfor\s+\w+\s+(?:years?|months?)\b/i,
  /\b(?:new|another|second|third)\b[^.]*\b(?:opened|started|launched|moved in)\b[^.]*\b(?:nearby|in (?:my|our|the) (?:area|street|town|village|neighbourhood))\b/i,
];
const PRICE_CHANGE = /\b(?:raise|raising|increase|increasing|put up|putting up|hike|lower|lowering|cut|cutting|change|changing|charge more|charge less)\b[^?]*\b(?:price|prices|pricing|rates?|fees?|subscription)\b|\b(?:price|prices|pricing|rates?|fees?)\b[^?]*\b(?:up|higher|increase|rise)\b/i;
// How customers RESPOND — not how many there are ("1,200 subscribers" is the base, not a response).
const EFFECT_TERMS = stems(['churn', 'cancel', 'cancelled', 'cancellations', 'complain', 'complained', 'complaints', 'demand', 'queues', 'waiting',
  'competitor', 'competitors', 'competition', 'loyal', 'retention', 'sensitive', 'unsubscribed', 'refunds']);
const SINGLE_VALUE = /^\s*(?:how much|how many|how old|how big|how often|when|what time|what date|what day|where|who|which)\b/i;

function expand(terms) {
  const out = new Set(terms);
  for (const [k, list] of Object.entries(KINDS)) if (terms.some(t => tokens(k).includes(t) || list.some(w => tokens(w).includes(t)))) for (const w of list) for (const s of tokens(w)) out.add(s);
  return [...out];
}

/**
 * The information a question needs — conditional on the question. Decision
 * questions get the facets a decision of that kind depends on; lookups get the
 * one thing asked about; impersonal questions need nothing personal.
 */
export function requirementsFor(u) {
  const { intent, topicTerms, names, relation } = u;
  const q = u.question.toLowerCase();
  if (intent === 'general') return [];
  const topic = expand(topicTerms);
  const entity = names[0] ?? null;
  const out = [];

  if (intent === 'decision') {
    const hiring = /\b(?:hire|hiring|recruit|headcount|another (?:developer|engineer|designer)|second (?:developer|engineer))\b/i.test(q);
    const afford = /\b(?:afford|budget for|pay for|buy|replace|purchase|quote|cost)\b/i.test(q);
    if (hiring && !afford) {
      const role = expand(topicTerms.filter(t => V.team.includes(t) || tokens('developer engineer designer').includes(t)));
      out.push(need('team', 'current team composition', { terms: V.team }));
      out.push(need('departures', 'upcoming departures from the team', { essential: false, terms: V.departure }));
      out.push(need('cash', 'money available (cash in the bank, budget)', { terms: V.cash }));
      out.push(need('burn', 'monthly burn or runway', { terms: V.runway, phrases: PHRASE.runway }));
      out.push(need('revenue', 'current revenue', { essential: false, terms: V.revenue }));
      out.push(need('workload', 'engineering workload and roadmap commitments', { terms: V.workload }));
      out.push(need('prior-decisions', 'previous hiring decisions or rules', { essential: false, terms: V.decision, phrases: PHRASE.decision, requireAlso: stems(['hire', 'hiring', 'headcount']) }));
      out.push(need('hire-cost', 'the cost of a developer (salary or hiring cost)', { terms: V.cost, requireAlso: role.length ? role : V.team, ask: 'Roughly what would a developer cost you per year, all in?' }));
      return out;
    }
    if (afford) {
      const object = topic.filter(t => !tokens('afford can could we i replace buy pay this year').includes(t));
      const what = (u.question.match(/\b(?:afford|replace|buy|purchase|pay for)\s+(?:to\s+)?(.+?)[?.!]*$/i)?.[1] ?? 'it').trim();
      out.push(need('cost', `the cost of ${what}`, { terms: V.cost, requireAlso: object.length ? object : null, amount: true, ask: `Roughly how much does ${what} cost?` }));
      out.push(need('cash', 'money available (savings, cash in the bank, budget)', { terms: [...V.cash, ...MONEY_TERMS.filter(t => !V.income.includes(t))], ask: 'How much do you have saved or set aside for this?' }));
      out.push(need('income', 'income or how much can be saved per month', { terms: [...V.income, ...V.revenue, ...stems(['take-home', 'bring', 'home'])], phrases: [/\b(?:take|bring)[- ]home\b/i], ask: 'What is your monthly income after tax?' }));
      out.push(need('runway', 'spending and runway', { essential: false, terms: V.runway, phrases: PHRASE.runway }));
      out.push(need('situation', 'their situation around it', { kind: 'situation', terms: domainLexicon(domainsOf([...topic, ...tokens(q)])), essential: false }));
      return out;
    }
    // Any other decision (V2): one general model of a personal decision —
    //   the OPTION (what they said about it), their SITUATION in the decision's
    //   domain(s), the RESOURCES it takes (money when it costs, time when it needs
    //   care), what ties them where they are (when it means moving), and what they
    //   WANT from it (essential only when nothing but the option is known).
    const subjectTerms = topic.filter(t => !ADVICE_WORDS.has(t) && !COMMON.has(t));
    const what = clip(u.question.replace(/^\s*(?:should|shall|can|could)\s+(?:i|we)\s+|^\s*is\s+(?:it|now|this)\s+a\s+good\s+(?:time|idea)\s+to\s+|[?.!]+$/gi, ''), 60);
    // Essential only when the question points at a SPECIFIC option they must have mentioned
    // ("the Brightmoor offer", "the cottage", "the MBA"); "put my prices up", "a puppy",
    // "leave my job" name an action or a kind, and nothing about it need have been said.
    const specific = !!entity || /\b(?:the|this|that|these|those)\s+(?!(?:time|moment|right|best|money|price|prices)\b)\w+/i.test(u.question);
    out.push(need('subject', `what is known about the option (${what})`, { terms: subjectTerms.length ? subjectTerms : topic, entity, amount: false, essential: specific }));
    out.push(need('situation', 'their current situation where this decision sits', { kind: 'situation', essential: false, terms: domainLexicon(domainsOf([...topic, ...tokens(q)])), phrases: SITUATION_PHRASES }));
    out.push(need('money', 'money available for it (savings or budget) and income', { essentialWhen: 'cost', terms: MONEY_TERMS, amount: true, requireAlso: null, ask: 'How much could you put towards this — savings or monthly budget?' }));
    out.push(need('time', 'time available for it (working hours, schedule, other commitments)', { essentialWhen: 'care', terms: TIME_TERMS, ask: 'How much time could you realistically give it each week?' }));
    if (MOVE.test(q)) out.push(need('ties', 'what ties them to where they are now (partner, family, home, job)', { essentialWhen: 'move', terms: TIES_TERMS, ask: 'What keeps you where you are now — family, a partner, your home?' }));
    // A decision that changes what OTHERS pay or receive depends on how they respond
    // (held-out v1 investigation: "Is it a good time to raise our price?" had no such need).
    if (PRICE_CHANGE.test(q)) out.push(need('effects', 'how customers would respond (demand, churn, what competitors charge)', { terms: EFFECT_TERMS, phrases: SITUATION_PHRASES.slice(1), ask: 'How price-sensitive are your customers — have you seen people leave or complain when prices changed?' }));
    out.push(need('criteria', 'what they want from it (their goal or reason)', { essentialWhen: 'thin', terms: CRITERIA_TERMS, ask: 'What would you most want to get out of this?' }));
    out.push(need('timing', 'deadlines and timing', { essential: false, terms: stems(['deadline', 'expires', 'due', 'until', 'friday', 'monday', 'week', 'month']) }));
    return out;
  }

  if (intent === 'planning') {
    const people = expand([...topicTerms.filter(t => RELATIONS.test(t) || Object.keys(KINDS).some(k => tokens(k).includes(t))), ...(relation ? tokens(relation) : [])]);
    if (/\b(?:train|training|workout|exercise|fitness|run|swim)\b/i.test(q)) {
      out.push(need('goals', 'current goals', { terms: V.goal, single: true }));
      out.push(need('constraints', 'constraints on training (injuries, schedule)', { essential: false, terms: stems(['injured', 'injury', 'knee', 'schedule', 'busy', 'time']) }));
      return out;
    }
    // Each need follows from something the request MENTIONS: who, the trip, the day, the meal.
    if (people.length) out.push(need('people', 'the people involved', { terms: people }));
    if (/\b(?:trip|travel|travell?ing|holiday|vacation|visit|visiting|away)\b/i.test(q)) {
      out.push(need('trip', 'the trip (where and when)', { terms: stems(['trip', 'visiting', 'visit', 'travel', 'travelling', 'staying', 'holiday', 'vacation', 'flight', 'flying']) }));
    }
    const day = q.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|tomorrow|tonight)\b/i)?.[1];
    if (day) out.push(need('day', `fixed commitments on ${day.toLowerCase()}`, { terms: stems([day, 'practice', 'appointment', 'lesson', 'class']), requireAlso: stems([day, 'every']) }));
    if (/\b(?:dinner|lunch|breakfast|meal|eat|restaurant|food|cook)\b/i.test(q)) {
      out.push(need('food', 'food preferences and dietary needs', { terms: [...V.diet, ...stems(['restaurant', 'restaurants', 'places', 'cheap', 'casual', 'fancy'])] }));
    }
    const about = topic.filter(t => !tokens('plan my our me us during with the').includes(t));
    out.push(need('preferences', 'their preferences about this', { essential: false, terms: V.preference, requireAlso: about.length ? about : null }));
    if (/\b(?:trip|travel|holiday|vacation|visit)\b/i.test(q)) out.push(need('dates', 'travel dates (when they are going)', { terms: stems(['june', 'july', 'august', 'summer', 'spring', 'autumn', 'winter', 'dates', 'week', 'weeks', 'month', 'leaving', 'flying']), ask: 'When are you planning to go, and for how long?' }));
    return out;
  }

  if (intent === 'comparison') {
    // One thing compared across sources: sharing it is enough to compare their figures.
    out.push(need('sources', 'what each source says', { terms: topic, single: true }));
    return out;
  }

  if (intent === 'recall' || intent === 'status') {
    const about = intent === 'status' ? [...topic, ...V.status] : topic;
    out.push(need('statement', intent === 'status' ? `the current status of ${entity ?? 'it'}` : `what ${entity ?? 'they'} said`, { terms: about, entity }));
    if (entity) out.push(need('who', `who "${entity}" is`, { essential: false, kind: 'entity', entity }));
    return out;
  }

  // Lookups and anything else personal: the one thing asked about.
  const attr = [];
  if (/\bwhere\b/i.test(q) && /\b(?:work|job)\b/i.test(q)) attr.push(...V.employment);
  if (/\b(?:do|does)\b.*\bfor (?:work|a living)\b/i.test(q)) attr.push(...V.employment);
  if (/\bwhere\b/i.test(q) && /\b(?:live|home)\b/i.test(q)) attr.push(...V.location);
  if (/\b(?:called|name)\b/i.test(q)) attr.push(...V.naming);
  const rel = relation ? expand(tokens(relation)) : [];
  const terms = [...new Set([...topic, ...attr, ...rel])];
  const label = relation ? `what is known about their ${relation}` : `the information asked about (${u.question.replace(/\?$/, '')})`;
  out.push(need('answer', label, { terms, entity, single: u.currency === 'current' || SINGLE_VALUE.test(q) || /\b(?:who is|where do|where does|what'?s my)\b/i.test(q), requireAlso: rel.length ? rel : null }));
  out.push(...constraintNeeds(u, rel));
  return out;
}

/** Union of the vocabularies of some domains. */
function domainLexicon(domains) { return [...new Set(domains.flatMap(d => DOMAINS[d] ?? []))]; }

/**
 * Standing constraints a recommendation must respect (V2): a dinner suggestion
 * needs the user's diet ("I'm coeliac"); a gift needs what the person loves.
 */
function constraintNeeds(u, rel = []) {
  const q = u.question;
  if (!/\b(?:should|could|suggest|recommend|ideas?|what (?:can|to)|get|cook|bake|make)\b/i.test(q)) return [];
  const out = [];
  if (CONSTRAINTS.food.cue.test(q)) out.push(need('diet', 'dietary needs and food dislikes', { essential: false, terms: CONSTRAINTS.food.terms }));
  if (CONSTRAINTS.gift.cue.test(q) && (rel.length || u.names.length)) out.push(need('interests', `what ${u.names[0] ?? `their ${u.relation}`} enjoys`, { essential: false, terms: CONSTRAINTS.gift.terms, requireAlso: rel.length ? rel : null, entity: rel.length ? null : u.names[0] }));
  return out;
}

// ── Stage C: evidence ───────────────────────────────────────────────────────

const FACT_TERMS = Object.freeze({
  workplace: 'work job employer company', organization: 'work company', profession: 'work job role profession',
  role: 'work job role', city: 'live home city', address: 'live home address', location: 'live home',
  siblings: 'sister brother sibling', partner: 'partner wife husband', goal: 'goal', preference: 'prefer preference',
  name: 'name', pet: 'pet dog cat', pets: 'pet dog cat',
});

const isRequest = t => QUESTION_END.test(String(t ?? '')) || REQUEST.test(String(t ?? ''));
const normText = t => String(t ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const valueText = v => (v && typeof v === 'object' ? String(v.name ?? v.value ?? v.label ?? '') : String(v ?? ''));

/**
 * Stored facts as candidates. A fact whose source is a question or a request
 * is not something the user stated: the observer runs on EVERY message,
 * questions included ("Where does my sister work?" added "Work" to siblings;
 * "What's my dog called?" wrote a pet). Such facts are not trusted, and a
 * collection item that only ever appeared inside a request is dropped.
 */
function factCandidates(ownerId, sensitive, requestTexts = []) {
  const out = [];
  const seen = new Set();
  for (const f of getFacts(ownerId)) {
    if (f.sensitivity && !(sensitive?.allows?.(f.sensitivity))) continue;
    if (isRequest(f.sourceText)) continue;
    const label = String(f.key).replace(/^custom_/, '').replace(/_/g, ' ');
    const items = (Array.isArray(f.value) ? f.value : [f.value]).map(valueText).map(x => x.trim()).filter(Boolean)
      .filter(item => !requestTexts.some(r => r.includes(normText(item))));
    const value = items.join(', ');
    if (!value || seen.has(normText(value))) continue;
    seen.add(normText(value));
    if (truncatedNumber(value, f.sourceText)) continue;     // e.g. "earn 58" stored from "earn 58,000": the quote speaks instead
    const text = `${label}: ${value}`;
    out.push({
      kind: 'fact', key: f.key, text, value, label,
      toks: tokens(`${label} ${FACT_TERMS[f.key] ?? ''} ${value}`),
      ts: Number(f.updatedAt ?? f.ts ?? 0) || null,
      sourceText: f.sourceText ?? null,
      current: !f.ended, ended: f.ended ?? null, laterWord: f.laterWord ?? null,
      confidence: f.confidence ?? null, hedged: !!f.metadata?.hedged,
    });
  }
  return out;
}

/**
 * True when a number in the stored value is a cut-off piece of a longer number
 * in the sentence it came from ("58" from "58,000") — the extractor split on
 * the thousands separator. Showing it would state a figure the user never gave.
 */
function truncatedNumber(value, source) {
  const src = String(source ?? '');
  if (!src) return false;
  for (const m of String(value).matchAll(/\d[\d,.]*/g)) {
    const n = m[0].replace(/[,.]+$/, '');
    const full = [...src.matchAll(/\d[\d,.]*\d|\d/g)].map(x => x[0]);
    if (!full.includes(n) && full.some(x => x.startsWith(n))) return true;
  }
  return false;
}

/**
 * V2: "left" meaning REMAINING ("I have 9 days of leave left", "5,000 left in the
 * budget") is not an ending. stateTransition.changeKind reads it as one; here a
 * statement whose only end cue is that sense of "left" is not a change, so two
 * such statements with different figures are a contradiction, not a supersession.
 */
const REMAINING_LEFT = /\b(?:have|has|had|got|is|are|was|there(?:'s| is| are))\b[^.]*\bleft\b(?!\s+(?:the|my|our|his|her|their|for|to|at|on|him|her|them|work|home|school)\b)|\b\d[\d,.]*\s*(?:k\b)?[^.]{0,30}\bleft\b(?!\s+(?:the|my|our|for|to|at|on)\b)/i;
const OTHER_END = /\b(?:quit|resigned|ended|stopped|no longer|sold|gave up|moved out|broke up|cancelled|retired|finished)\b/i;
function changeOf(s) {
  const k = changeKind(s);
  if (k === 'ended' && REMAINING_LEFT.test(s) && !OTHER_END.test(s)) return null;
  return k;
}

/** Facts about OTHER people travel as the user's own sentence (V2): "My brother Tomas
 *  lives in Ghent and works as an architect" keeps who-is-who; "siblings: Tomas" cannot. */
const THIRD_PARTY_KEYS = /^(?:siblings|spouse|partner|children|parents|friends?|pets?|cofounder|manager|boss|mentor|colleague|landlord|accountant|custom_(?:sister|brother|mum|mom|dad|mother|father|friend|partner|wife|husband|son|daughter|boss|manager|mentor|colleague|landlord|accountant|neighbou?r|cousin|co_?founder)\w*)$/i;

/** History + file sentences the user may be quoted on, privacy applied the way recall applies it. */
function historyCandidates({ ownerId, userId, conversationId, excludeFromIndex, sensitive, maxSentences = null }) {
  const units = collectUnits({ userId, conversationId, excludeFromIndex, includeFiles: true });
  const forgotten = redactionsFor(ownerId);
  const redaction = recallRedaction(forgotten, sensitive);
  const { pool: kept } = forgetClean(units, forgotten);
  const { pool } = withholdClean(kept, withheldBy(sensitive), policyKey(sensitive));
  const out = [];
  const forgetRequests = [];
  const requestTexts = [];
  for (const u of units) if (u.source !== 'file') for (const s of u.sentences) if (isRequest(s)) requestTexts.push(normText(s));
  const seenText = new Set();
  for (const u of units) {            // forget requests are read from the raw user words (they carry no private value)
    if (u.source === 'file') continue;
    for (const s of u.sentences) {
      const f = detectForget(s);
      if (f.isForget && f.hint) forgetRequests.push({ ts: u.ts ?? 0, terms: tokens(f.hint.replace(/^my\s+/i, '')), text: s });
    }
  }
  for (const u of pool) {
    u.sentences.forEach((s, i) => {
      if (redaction.isRedacted(s, u.ts)) return;
      if (QUESTION_END.test(s) || REQUEST.test(s)) return;      // a question or request is not a fact
      const toks = tokens(s);
      if (!toks.length) return;
      const nt = normText(s);
      if (seenText.has(nt)) return;                              // the same words said again add nothing
      seenText.add(nt);
      out.push({
        kind: u.source === 'file' ? 'file' : 'said', key: `${u.key}#${i}`, text: s, toks,
        ts: u.ts ?? null, conversationId: u.conversationId, title: u.title ?? null,
        source: u.source ?? null, fileName: u.fileName ?? null,
        speculative: HEDGE.test(s), change: changeOf(s), corrects: corrects(s),
      });
    });
  }
  // Sprint 6 work budget: keep the most recent sentences (and every file sentence) when capped.
  if (Number.isFinite(maxSentences) && out.length > maxSentences) {
    const said = out.filter(c => c.kind !== 'file').sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)).slice(0, maxSentences);
    const keep = new Set([...said, ...out.filter(c => c.kind === 'file')]);
    return { candidates: out.filter(c => keep.has(c)), forgetRequests, requestTexts, capped: out.length - keep.size };
  }
  return { candidates: out, forgetRequests, requestTexts };
}

const SPLIT_ON = /\b(?:and|but)\b/;
function matchScore(n, c) {
  const set = new Set(c.toks);
  let hits = 0;
  for (const t of n.terms) if (set.has(t)) hits++;
  for (const p of n.phrases ?? []) if (p.test(c.text)) hits++;
  // V2: a figure is evidence for a money need ("A newer used van is around 12,000").
  if (n.amount && c.kind !== 'fact' && moneyAmounts(c.text).length) hits++;
  if (!hits) return 0;
  if (n.requireAlso && !n.requireAlso.some(t => set.has(t))) return 0;
  if (n.entity && !new RegExp(`\\b${n.entity}\\b`, 'i').test(c.text)) return 0;
  return hits + (c.kind === 'fact' ? 0.5 : 0);
}

const NUMBER = /(?:[$€£]\s?)?\d[\d,]*(?:\.\d+)?\s?(?:k\b|%|days?\b|euros?\b|dollars?\b|pounds?\b|months?\b|weeks?\b|staff\b|years?\b)?/gi;
const ORDINAL = /\b(\d{1,2})(?:st|nd|rd|th)\b/gi;
const WEEKDAY = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;
const DAY_MONTH = /\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})\b/gi;
/**
 * Values a statement gives, each with its unit, so two statements can be seen
 * to disagree: amounts ("15,000", "8 days", "40k"), ordinal days ("the 9th"),
 * dates ("3 March") and weekdays (V2: "Tuesday at 10" vs "Wednesday at 10").
 */
function amounts(text) {
  const s = String(text);
  const dated = [...s.matchAll(DAY_MONTH)].map(m => `${(m[1] ?? m[4])}@${(m[2] ?? m[3]).toLowerCase()}`);
  const stripped = s.replace(DAY_MONTH, ' ');
  const nums = [...stripped.replace(ORDINAL, ' ').matchAll(NUMBER)].map(m => m[0].toLowerCase().replace(/[\s,]/g, '').replace(/^[$€£]/, '').replace(/s$/, ''))
    .filter(a => /\d{2,}|\d(?:k|%|days?|euros?|months?|pounds?|staff|years?)/.test(a) || /^\d$/.test(a));
  const ords = [...stripped.matchAll(ORDINAL)].map(m => `${m[1]}ord`);
  const days = [...s.matchAll(WEEKDAY)].map(m => `${m[1].toLowerCase()}`);
  return [...nums, ...ords, ...dated.map(d => `${d}`), ...days];
}
const unitOf = v => (/^[a-z]+day$/.test(v) ? 'weekday' : /@/.test(v) ? 'date' : v.replace(/^[\d.]+/, ''));
/** Money-like figures only (not "3 days", not "year 3"). */
function moneyAmounts(text) {
  return [...String(text).matchAll(/(?:[$€£]\s?\d[\d,.]*k?|\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?k\b|\b\d{3,}\b(?!\s*(?:am|pm|years?|days?|minutes?|hours?|miles?|km)\b)|\b\d+\s*(?:grand|pounds?|euros?|dollars?)\b)/gi)].map(m => m[0]);
}

// ── Stage D: evaluate one requirement's evidence ────────────────────────────

const iso = ts => (Number.isFinite(ts) && ts ? new Date(ts).toISOString().slice(0, 10) : 'undated');

function evaluate(n, matched, forgetRequests, u) {
  const forgot = forgetRequests.find(r => r.terms.some(t => n.terms.includes(t)));
  const live = forgot ? matched.filter(c => (c.ts ?? 0) > forgot.ts) : matched;
  if (forgot && !live.length) return { status: 'forgotten', evidence: [], forgotten: forgot };
  const said = live.filter(c => c.kind !== 'fact').sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const facts = live.filter(c => c.kind === 'fact');
  // Later words: a later statement that changes or corrects makes the earlier ones on this need outdated.
  for (let j = 1; j < said.length; j++) {
    if (!said[j].change && !said[j].corrects) continue;
    for (let i = 0; i < j; i++) if (!said[i].outdatedBy && sharesSubject(said[i], said[j], n)) said[i].outdatedBy = said[j];
  }
  const currentSaid = said.filter(c => !c.outdatedBy);
  const certain = currentSaid.filter(c => !c.speculative);
  // A stored fact the user's LATER words change or correct is not current, even if the
  // profile was never updated (stale profile facts: audit F-04/F-06).
  for (const f of facts) {
    if (!f.current) continue;
    const valueToks = tokens(f.value).filter(t => t.length > 2);
    // V2: or a later change that names the same thing (all of the fact's label words) and
    // gives another value: "The gym raised the membership fee to 38" ends "membership fee: 30".
    const labelToks = tokens(f.label).filter(t => t.length > 2 && !COMMON.has(t));
    const fv = amounts(f.value);
    const later = said.find(c => (c.ts ?? 0) > (f.ts ?? 0) && (c.change || c.corrects) && (valueToks.some(t => c.toks.includes(t))
      || (labelToks.length && labelToks.every(t => c.toks.includes(t)) && amounts(c.text).some(v => fv.length && !fv.includes(v)))));
    if (later) { f.current = false; f.ended = { text: later.text }; }
  }
  const currentFacts = facts.filter(f => f.current && !f.hedged);
  const endedFacts = facts.filter(f => !f.current);
  // Contradiction: two current, unqualified statements with different amounts of the same unit.
  let conflict = null;
  if (certain.length >= 2) {
    for (let i = 0; i < certain.length && !conflict; i++) for (let j = i + 1; j < certain.length && !conflict; j++) {
      const a = amounts(certain[i].text), b = amounts(certain[j].text);
      // Disagree: a value of the same unit in one that the other does not give at all.
      const differs = a.some(x => !b.includes(x) && b.some(y => unitOf(x) === unitOf(y) && x !== y));
      if (a.length && b.length && differs && sameNeedSubject(certain[i], certain[j], n)) conflict = [certain[i], certain[j]];
    }
  }
  if (!currentFacts.length && !certain.length) {
    if (currentSaid.some(c => c.speculative)) return { status: 'uncertain', evidence: currentSaid, outdated: said.filter(c => c.outdatedBy) };
    if (said.length || endedFacts.length) return { status: 'outdated', evidence: said, ended: endedFacts };
    return { status: 'missing', evidence: [] };
  }
  if (conflict) return { status: 'contradictory', evidence: said, conflict, facts: currentFacts };
  return { status: 'found', evidence: said.filter(c => !c.speculative || c.outdatedBy), facts: currentFacts, ended: endedFacts };
}

/** Both statements are about this need's own subject: they share two of its terms (or all of them, when it has fewer). */
function sameNeedSubject(a, b, n) {
  const own = new Set(n.terms);
  const common = a.toks.filter(t => own.has(t) && b.toks.includes(t));
  // One value asked for ("How much does the venue cost?"): sharing what is asked about is enough.
  if (n.single && new Set(common).size >= 1) return true;
  return new Set(common).size >= Math.min(2, own.size) || sharesSubject(a, b, n, 2);
}

function sharesSubject(a, b, n, min = 1) {
  const own = new Set(n.terms);
  const sa = new Set(a.toks.filter(t => !own.has(t)));
  let shared = 0;
  for (const t of b.toks) if (sa.has(t)) shared++;
  if (n.single || n.kind === 'entity') return true;            // one value asked for: any later word on it counts
  // Otherwise the two statements must share their own subject (two words beyond the need's
  // vocabulary): "hold off on hiring until $20k MRR" is not changed by "we're at $14k MRR now".
  return shared >= Math.max(min, 2);
}

// ── Stage E + rendering ─────────────────────────────────────────────────────

const PER_NEED = 3;
const MAX_QUOTES = 12;
const MAX_QUOTE_CHARS = 3600;

/**
 * Run the engine for one turn. Pure apart from reading the owner's stores.
 * Returns { applied, understanding, needs[], sufficiency, memoryBlock, recallBlock, summary }.
 * `applied:false` = the question was not understood well enough; the caller
 * keeps the existing pipeline for that turn.
 */
/**
 * V2: the question's own words that tie it to the user's history — a question
 * with no "I" or "my" can still be about the user ("When is the school play?",
 * "Who runs the data pipeline?"). A word counts when some statement the user
 * made (or a file they gave) contains it and it is not a common word. A
 * definitional question ("What is a credit score?") needs a proper-noun tie.
 */
const DEFINITIONAL = /^\s*(?:what\s+(?:is|are|does|do)\s+(?:a|an|the)?\s*\w+(?:\s+\w+)?\s*(?:mean)?\s*\??$|define\b|explain\b|how\s+(?:does|do)\s+\w+(?:\s+\w+)?\s+work\b|why\s+(?:is|are|do|does)\b|how\s+(?:many|far|long|old|tall|big)\s+(?:is|are|does|do)\s+(?:a|an|the)\b)/i;
function anchorTerms(u, said) {
  const qWords = u.question.replace(/[?.!,]/g, ' ').split(/\s+/).filter(Boolean);
  const proper = new Set(qWords.slice(1).filter(w => /^[A-Z][a-z]+/.test(w) && w !== 'I').flatMap(w => tokens(w)));
  const own = said.filter(c => c.kind === 'said' || c.kind === 'file');
  const terms = [...new Set(tokens(u.question))].filter(t => t.length > 2 && !COMMON.has(t) && !ADVICE_WORDS.has(t));
  const tied = terms.filter(t => own.some(c => c.toks.includes(t)));
  if (DEFINITIONAL.test(u.question)) return tied.filter(t => proper.has(t));
  return tied;
}

export function analyseInformationNeeds({ ownerId, userId = null, conversationId = null, question, taskType = null, excludeFromIndex = Infinity, sensitive = null, budget = null } = {}) {
  const t0 = process.hrtime.bigint();
  if (failNext) { const err = failNext; failNext = null; throw err; }
  let u = understandQuestion(question, { taskType });
  if (!ownerId) return finish({ understanding: { intent: u.intent }, applied: false, reason: 'no-owner', needs: [] }, t0);
  const history = historyCandidates({ ownerId, userId, conversationId, excludeFromIndex, sensitive, maxSentences: budget?.maxSentences ?? null });
  // Sprint 6 work budget (hybrid only; absent = unbounded, as before): the engine is
  // synchronous, so a deadline is checked between stages and aborts with BudgetExceeded.
  const overBudget = () => budget?.deadlineMs != null && Number(process.hrtime.bigint() - t0) / 1e6 > budget.deadlineMs;
  if (overBudget()) throw Object.assign(new Error('information-needs work budget exceeded'), { name: 'BudgetExceeded' });
  if (u.intent === 'general' && anchorTerms(u, history.candidates).length) u = understandQuestion(question, { taskType, anchored: true });
  const base = { understanding: { intent: u.intent, personal: u.personal, advice: u.advice, multiFact: u.multiFact, currency: u.currency, names: u.names, relation: u.relation, anchored: u.anchored } };
  if (u.intent === 'general') {
    // Impersonal: the smallest sufficient context is no personal context at all.
    return finish({ ...base, applied: true, needs: [], sufficiency: 'not-applicable', memoryBlock: '', recallBlock: '' }, t0);
  }
  const reqs = requirementsFor(u);
  if (!reqs.length) return finish({ ...base, applied: false, reason: 'no-requirements', needs: [] }, t0);

  const { candidates: said, forgetRequests, requestTexts } = history;
  const allFacts = factCandidates(ownerId, sensitive, [...requestTexts, normText(question)]);
  // A third-party fact whose sentence is in the history is represented by that sentence.
  const facts = allFacts.filter(f => !(THIRD_PARTY_KEYS.test(f.key) && f.sourceText && said.some(c => c.text === f.sourceText || c.text.includes(f.sourceText))));
  const pool = [...facts, ...said];

  // Ambiguous names: one name in the question, several full names in the user's world.
  const ambiguous = [];
  for (const name of u.names) {
    const full = new Set();
    for (const c of said) for (const m of c.text.matchAll(new RegExp(`\\b${name}\\s+([A-Z][a-z]+)`, 'g'))) full.add(`${name} ${m[1]}`);
    if (full.size >= 2) ambiguous.push({ name, candidates: [...full] });
  }

  const results = [];
  const usedQuotes = new Set();
  for (const n of reqs) {
    if (overBudget()) throw Object.assign(new Error('information-needs work budget exceeded'), { name: 'BudgetExceeded' });
    if (n.kind === 'entity') {
      const amb = ambiguous.find(a => a.name === n.entity);
      const intro = said.filter(c => new RegExp(`\\b${n.entity}\\b`).test(c.text) && !QUESTION_END.test(c.text))
        .filter(c => !amb || amb.candidates.some(fn => c.text.includes(fn)));
      results.push({ need: n, status: amb ? 'ambiguous' : intro.length ? 'found' : 'missing', evidence: intro.slice(0, PER_NEED), ambiguous: amb ?? null });
      continue;
    }
    let nn = n;
    if (n.kind === 'situation') {
      // The decision's domains, from the question AND from what the user said about the option.
      const subj = results.find(r => r.need.id === 'subject' || r.need.id === 'cost');
      const subjToks = [...(subj?.evidence ?? []), ...(subj?.facts ?? [])].flatMap(c => c.toks ?? tokens(c.text ?? ''));
      const terms = [...new Set([...n.terms, ...domainLexicon(domainsOf(subjToks))])];
      // Already-used evidence is not "situation"; statements must be the user's own (not files).
      nn = { ...n, terms };
    }
    // Situation and resource needs never reuse a statement already used as evidence (the
    // option's own price is not the user's money); situation is the user's words, not files.
    const fresh = nn.kind === 'situation' || ['money', 'time', 'ties', 'criteria', 'effects'].includes(nn.id);
    const scored = pool.filter(c => !fresh || ((nn.kind !== 'situation' || c.kind !== 'file') && !results.some(r => (r.evidence ?? []).includes(c) || (r.facts ?? []).includes(c))))
      .map(c => ({ c, s: matchScore(nn, c) })).filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s || (b.c.ts ?? 0) - (a.c.ts ?? 0));
    let top = scored.slice(0, PER_NEED * 2).map(x => x.c);
    top = followChanges(top, said);
    const r = evaluate(nn, top, forgetRequests, u);
    // Prefer a structured fact; keep a quote only when no fact covers the need or it carries a later word.
    const quotes = (r.evidence ?? []).filter(c => !(r.facts ?? []).some(f => f.sourceText && f.sourceText.includes(c.text)));
    results.push({ need: nn, ...r, evidence: quotes.slice(-PER_NEED), scores: new Map(scored.map(x => [x.c.key, x.s])) });
  }
  resolveEssentials(results, u);

  // V2 safety: a factual question for which nothing at all was found falls back to the
  // existing pipeline (applied:false) rather than sending an empty context — the engine
  // never makes a turn worse than the existing pipeline would on a lookup it cannot read.
  const anyEvidence = results.some(r => (r.evidence ?? []).length || (r.facts ?? []).length || (r.ended ?? []).length || r.status === 'forgotten' || r.status === 'ambiguous');
  if (!anyEvidence && !u.advice && u.intent !== 'comparison') {
    return finish({ ...base, applied: false, reason: 'no-evidence', needs: results }, t0);
  }

  // Sufficiency (Stage E): essential needs that are missing, forgotten, ambiguous or contradictory.
  const blocking = results.filter(r => r.need.essential && ['missing', 'forgotten', 'contradictory', 'ambiguous'].includes(r.status));
  const shaky = results.filter(r => ['uncertain', 'outdated'].includes(r.status) || (!r.need.essential && r.status === 'missing'));
  const sufficiency = blocking.length ? 'insufficient' : shaky.length ? 'partial' : 'sufficient';

  // Quotes: the evidence of every requirement, deduplicated, chronological, bounded.
  const quotes = [];
  let chars = 0;
  for (const r of results) {
    for (const c of [...(r.evidence ?? []), ...(r.conflict ?? [])]) {
      if (usedQuotes.has(c.key) || quotes.length >= MAX_QUOTES || chars + c.text.length > MAX_QUOTE_CHARS) continue;
      usedQuotes.add(c.key); chars += c.text.length;
      quotes.push({
        text: c.text, ts: c.ts, conversationId: c.conversationId, title: c.title, source: c.kind === 'file' ? 'file' : null,
        fileName: c.fileName, why: 'need', ...(c.outdatedBy ? { changes: [c.outdatedBy.text] } : {}),
      });
    }
  }
  quotes.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  const memoryBlock = renderNeeds(u, results, sufficiency);
  const recallBlock = quotes.length ? formatRecall(quotes, { currentConversationId: conversationId }) : '';
  return finish({ ...base, applied: true, needs: results, sufficiency, memoryBlock, recallBlock, quotes: quotes.length }, t0);
}

/**
 * V2: later words about the same named thing. A matched statement whose names
 * (capitalised words) a LATER change or correction repeats brings that later
 * statement in — "What car do I drive?" matches "I drive a Ford Focus"; "Sold the
 * Focus, I have a Kia Niro now" shares no word with the question but ends it.
 */
function followChanges(top, said) {
  const out = [...top];
  // Later = later in time, or said later at the same timestamp (history order).
  const order = new Map(said.map((s, i) => [s, i]));
  const later = (s, c) => (s.ts ?? 0) > (c.ts ?? 0) || ((s.ts ?? 0) === (c.ts ?? 0) && c.kind !== 'fact' && (order.get(s) ?? -1) > (order.get(c) ?? Infinity));
  for (const c of top) {
    const names = new Set(String(c.kind === 'fact' ? c.value : c.text).split(/\s+/).slice(c.kind === 'fact' ? 0 : 1)
      .filter(w => /^[A-Z][A-Za-z]+/.test(w) && w !== 'I').flatMap(w => tokens(w)));
    if (!names.size) continue;
    for (const s of said) {
      if (s === c || !later(s, c) || !(s.change || s.corrects)) continue;
      if (!s.toks.some(t => names.has(t))) continue;
      if (!out.includes(s)) out.push(s);
      // The later change names what this statement was about: this one is no longer current.
      if (c.kind !== 'fact' && !c.outdatedBy) c.outdatedBy = s;
    }
  }
  return out;
}

/**
 * V2: resolve conditional essentials against what was found. Money is essential
 * when the option costs something; time when it needs care or study; ties when it
 * means moving; criteria when nothing but the option itself is known.
 */
function resolveEssentials(results, u) {
  const subj = results.find(r => r.need.id === 'subject');
  const text = [u.question, ...(subj?.evidence ?? []).map(c => c.text), ...(subj?.facts ?? []).map(f => f.sourceText ?? f.value)].join(' ');
  const costs = ACQUIRE.test(u.question) && (moneyAmounts(text).length > 0 || /\b(?:buy|loan|invest|afford|lend|renovate|hire|open|opening|start|starting|freelance|shop|business)\b/i.test(text));
  const care = CARE.test(text);
  const known = results.filter(r => ['situation', 'money', 'time', 'ties'].includes(r.need.id) && (r.status === 'found' || (r.evidence ?? []).length));
  for (const r of results) {
    const w = r.need.essentialWhen;
    if (!w) continue;
    const essential = w === 'cost' ? costs : w === 'care' ? care : w === 'move' ? MOVE.test(u.question) : w === 'thin' ? known.length === 0 : false;
    r.need = { ...r.need, essential };
  }
}

function finish(r, t0) {
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const count = s => (r.needs ?? []).filter(x => x.status === s).length;
  r.summary = {
    applied: r.applied, reason: r.reason ?? null, intent: r.understanding?.intent ?? null,
    needs: (r.needs ?? []).length, essential: (r.needs ?? []).filter(x => x.need.essential).length,
    found: count('found'), missing: count('missing'), uncertain: count('uncertain'), contradictory: count('contradictory'),
    outdated: count('outdated'), forgotten: count('forgotten'), ambiguous: count('ambiguous'),
    sufficiency: r.sufficiency ?? null, quotes: r.quotes ?? 0, ms: Math.round(ms * 100) / 100,
    byNeed: (r.needs ?? []).map(x => ({ id: x.need.id, essential: x.need.essential, status: x.status, quotes: (x.evidence ?? []).length, facts: (x.facts ?? []).length })),
  };
  return r;
}

const clip = (s, n = 160) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

/**
 * V2: the ONE clarifying question worth asking — about the most important gap
 * (first essential need that blocks: ambiguity first, then conflict, then a
 * missing fact). None when the information is sufficient or only partial.
 */
export function clarifyingQuestion(results, sufficiency) {
  if (sufficiency !== 'insufficient') return null;
  const blocking = results.filter(r => r.need.essential && ['ambiguous', 'contradictory', 'missing'].includes(r.status));
  const pick = blocking.find(r => r.status === 'ambiguous') ?? blocking.find(r => r.status === 'contradictory') ?? blocking[0];
  if (!pick) return null;
  if (pick.status === 'ambiguous') return `Which ${pick.ambiguous.name} do you mean — ${pick.ambiguous.candidates.join(' or ')}?`;
  if (pick.status === 'contradictory') return `Which is right: "${clip(pick.conflict[0].text, 70)}" or "${clip(pick.conflict[1].text, 70)}"?`;
  return pick.need.ask ?? `Could you tell me ${pick.need.label.replace(/\s*\(.*\)$/, '')}?`;
}

function renderNeeds(u, results, sufficiency) {
  if (!results.length) return '';
  const lines = [
    '--- INFORMATION NEEDS (what this question requires, from what the user told Aqua) ---',
    `This is ${u.advice ? 'a request for advice' : 'a factual question'} (${u.intent}); it needs ${results.length} piece(s) of information. The user's own words for each are quoted further below.`,
  ];
  for (const r of results) {
    const n = r.need;
    for (const f of r.facts ?? []) lines.push(`- ${f.label}: ${clip(f.value, 120)} (user-stated${f.ts ? `, ${iso(f.ts)}` : ''}${f.sourceText ? `; they said: "${clip(f.sourceText, 140)}"` : ''})`);
    for (const f of r.ended ?? []) lines.push(`- No longer current — ${f.label}: ${clip(f.value, 100)}${f.ended?.text ? ` (they said: "${clip(f.ended.text, 120)}")` : ''}`);
    if (r.status === 'missing' && n.essential) lines.push(`- Not known: ${n.label} — the user has not said. Do not guess it.`);
    if (r.status === 'forgotten') lines.push(`- Not known: ${n.label} — the user asked Aqua to forget this ("${clip(r.forgotten.text, 80)}"). Do not use or reconstruct it.`);
    if (r.status === 'uncertain') lines.push(`- Uncertain: ${n.label} — they have only said it tentatively; not decided.`);
    if (r.status === 'contradictory') lines.push(`- Conflicting statements about ${n.label}: "${clip(r.conflict[0].text, 110)}" (${iso(r.conflict[0].ts)}) vs "${clip(r.conflict[1].text, 110)}" (${iso(r.conflict[1].ts)}) — contradictory, neither marked as a change; do not pick one silently.`);
    if (r.status === 'ambiguous') lines.push(`- Not known: which ${r.ambiguous.name} is meant — the user knows ${r.ambiguous.candidates.join(' and ')}.`);
  }
  const directive = sufficiency === 'insufficient'
    ? 'Essential information above is not known, conflicting or ambiguous. Do not invent it. If it changes the answer, ask ONE targeted question about the most important gap; otherwise answer conditionally and say what it depends on.'
    : sufficiency === 'partial'
      ? 'Some information is uncertain, outdated or optional and missing: answer, and say plainly what is uncertain.'
      : 'The information this question needs is available: answer directly from it.';
  lines.push(`Status: ${sufficiency}. ${directive}`);
  const q = clarifyingQuestion(results, sufficiency);
  if (q) lines.push(`If you ask, ask only this: "${q}"`);
  lines.push('--- END INFORMATION NEEDS ---');
  return lines.join('\n');
}

/**
 * Sprint 6 (hybrid context): does this text satisfy the need, by the engine's own
 * matching rules? Used to check whether the EXISTING context already holds a need
 * before the hybrid declares it unknown. Returns the match score (0 = no match).
 */
export function needMatchScore(n, text) {
  return matchScore(n, { kind: 'said', text: String(text ?? ''), toks: tokens(String(text ?? '')) });
}

/** Test seam (Sprint 4 shadow readiness): the next call throws `err`, to prove the route falls back. */
let failNext = null;
export function __failNextForTests(err) { failNext = err; }

/** Test seam: the vocabularies (frozen). */
export const __vocab = V;
