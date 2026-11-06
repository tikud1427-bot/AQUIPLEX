/**
 * AQUA — what a person may see of the engine's internal state (2026-10-28).
 *
 * Production's Memory and Understanding pages showed rows that said only
 * "event", headings like "CUSTOM STUDENT WITH ALMOST ZERO NETWORTH", a goal
 * list rendered as one run-on string, internal operation names
 * ("collection_merge"), intent ids ("simple_qa, personal_info") and a goal
 * filed as a profession. Every API payload that feeds those pages goes through
 * the rules here; the frontend applies the same rules again as a guard.
 *
 * The rule throughout (L11): a thing with no human-readable label is not shown.
 * No imports, so memorySchema can use it without a cycle.
 */

/** Human labels for well-known fact keys (the prompt formatter uses the same map). */
export const FACT_LABELS = Object.freeze({
  name: 'Name', age: 'Age', birthday: 'Birthday', gender: 'Gender', ethnicity: 'Ethnicity',
  city: 'City', country: 'Country', profession: 'Profession', company: 'Company',
  years_experience: 'Years of Experience', pets: 'Pets', favorite_language: 'Favorite Programming Language',
  least_favorite_language: 'Disliked Languages', favorite_color: 'Favorite Color',
  favorite_food: 'Favorite Food', disliked_food: 'Disliked Food', languages: 'Programming Languages',
  favorite_editor: 'Favorite Editor', favorite_os: 'Operating System', hobbies: 'Hobbies', goal: 'Goals',
  spouse: 'Spouse', children: 'Children', frameworks: 'Frameworks', hardware: 'Hardware',
});

const sentenceCase = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** "custom_*" keys are the extractor's fallback slug of the VALUE — never a heading. */
export function isCustomKey(key) {
  return /^custom_/i.test(String(key ?? ''));
}

/**
 * The heading for a fact, or null when the fact has none worth showing (a
 * custom_ fact: its key is a slug of its own value, so the value IS the text).
 */
export function factLabel(fact) {
  const key = String(fact?.key ?? '');
  if (!key || isCustomKey(key)) return null;
  if (FACT_LABELS[key]) return FACT_LABELS[key];
  const words = key.replace(/[_.:\-/]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words ? sentenceCase(words) : null;
}

function itemString(v) {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.name ?? v.value ?? v.label ?? v.text ?? '').trim();
  return String(v).trim();
}

const FILLER = new Set(['a', 'an', 'the', 'to', 'be', 'become', 'becoming', 'being', 'became', 'one', 'day', 'someday',
  'asap', 'soon', 'eventually', 'really', 'very', 'my', 'in', 'of', 'and', 'for', 'some', 'get', 'getting', 'want', 'wanna']);
function gist(s) {
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(t => t && !FILLER.has(t)).map(t => t.replace(/(?<=\w{3})s$/, '')));
}
function nearDuplicate(a, b) {
  const x = gist(a), y = gist(b);
  if (!x.size || !y.size) return a.toLowerCase() === b.toLowerCase();
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  const small = Math.min(x.size, y.size);
  return inter === small || inter / (x.size + y.size - inter) >= 0.6;
}

/**
 * A fact value as the list of DISTINCT things it holds. A collection (goals,
 * pets, hobbies) used to reach the page as an array React rendered with no
 * separator — "becoming a billionairebe topper in both coursesbe a billionaire
 * asap…". Near-duplicates collapse to the first phrasing ("be a billionaire
 * asap" / "become a billionaire one day" / "becoming a billionaire").
 */
export function factItems(value) {
  const raw = (Array.isArray(value) ? value : [value]).map(itemString).filter(Boolean);
  const out = [];
  for (const item of raw) if (!out.some(o => nearDuplicate(o, item))) out.push(item);
  return out.map(sentenceCase);
}

// ── Internal intent ids (core/classifier.js task types) ─────────────────────
/** Ids with a meaning a person would recognise; everything else is hidden. */
const INTENT_LABELS = Object.freeze({
  coding: 'writing code', debugging: 'debugging', architecture: 'system design', planning: 'planning',
  research: 'research', reasoning: 'thinking a problem through', analysis: 'analysis',
  creative_writing: 'writing', brainstorming: 'brainstorming', summarization: 'summaries',
  file_analysis: 'your files', project_query: 'your project',
});
/** Ids that describe the ENGINE's routing, not the person's work. */
const HIDDEN_INTENTS = new Set(['simple_qa', 'personal_info', 'memory_recall', 'memory_update', 'conversation', 'opinion', 'understanding', 'interview', 'understanding_intro']);
const ALL_INTENTS = new Set([...Object.keys(INTENT_LABELS), ...HIDDEN_INTENTS]);
/** Hidden ids written either way ("simple_qa", "simple qa") — never in human text. */
const HIDDEN_WORDS = new RegExp(`\\b(?:${[...HIDDEN_INTENTS].filter(i => i.includes('_')).map(i => i.replace(/_/g, '[_\\s]')).join('|')})\\b`, 'i');
const intentKey = s => String(s ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
const isIntentId = s => ALL_INTENTS.has(intentKey(s));

/** An intent id → its human label, or null when it must not be shown. */
export function intentLabel(id) {
  const raw = String(id ?? '').trim();
  const k = intentKey(raw);
  if (!k || k.startsWith('workspace:')) return null;
  if (INTENT_LABELS[k]) return INTENT_LABELS[k];
  if (HIDDEN_INTENTS.has(k)) return null;
  return /^[a-z]+(?:_[a-z]+)+$/.test(raw) ? null : raw;   // an unknown snake_case id is internal too
}

/** Does this text carry a hidden routing id ("simple_qa", "personal info", "memory recall")? */
export function mentionsInternalIntent(text) {
  return HIDDEN_WORDS.test(String(text ?? ''));
}

/**
 * Rewrite a title assembled from intent ids ("Working on simple qa + memory
 * recall") into human words, or null when nothing human is left. A part is
 * mapped only when it IS an id — "Planning the launch" stays as written.
 */
export function cleanInternalTitle(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(working on|next questions likely about:?)\s+(.+)$/i);
  const lead = m ? m[1] : '';
  const parts = (m ? m[2] : s).split(/\s*(?:\+|,|&)\s*/).map(p => p.trim()).filter(Boolean);
  if (!parts.some(isIntentId)) return s;
  const human = [...new Set(parts.map(p => (isIntentId(p) ? intentLabel(p) : p)).filter(Boolean))];
  if (!human.length) return null;
  return lead ? `${lead} ${human.join(' and ')}` : human.join(' and ');
}

// ── Goals are not jobs ───────────────────────────────────────────────────────
const ASPIRATION = /\b(?:billionaire|millionaire|trillionaire|multimillionaire|rich|wealthy|famous|legend|topper|success(?:ful)?|the\s+best|number\s+one|no\.?\s*1)\b/i;
const FUTURE_FRAME = /^(?:future|aspiring|wannabe|would-?be|soon-?to-?be|next|upcoming)\b|\b(?:one\s+day|someday|asap|eventually)\b|^(?:be|become|becoming)\b/i;

/**
 * "billionaire", "future founder", "becoming a millionaire": a GOAL, never a
 * profession (production showed "Profession: billionaire 90%").
 */
export function isAspirationalRole(value) {
  const v = String(itemString(value) ?? '').trim();
  if (!v) return false;
  return ASPIRATION.test(v) || FUTURE_FRAME.test(v);
}

// ── Change feed ──────────────────────────────────────────────────────────────
const TIMELINE_VERB = Object.freeze({
  goal_created: 'Started working toward', goal_completed: 'Completed', goal_abandoned: 'Stopped working toward',
  episode_opened: 'Began', episode_closed: 'Wrapped up',
  belief_established: 'Understanding settled:', reflection: 'Reflected on',
});

/**
 * One Mind timeline event as a sentence, or null. Events are {kind, subject};
 * the change feed used to read e.type / e.text, which do not exist, and fell
 * through to the literal "event".
 */
export function timelineLabel(e) {
  const verb = TIMELINE_VERB[e?.kind];
  if (!verb) {
    // An event that already carries its own sentence ({ label }) keeps it —
    // unless that "sentence" is a raw id, an intent id or the word "event".
    const own = String(e?.label ?? e?.text ?? '').trim();
    if (!own || /^event$/i.test(own) || /\bcustom_|collection_merge/i.test(own) || mentionsInternalIntent(own)) return null;
    return own;
  }
  const raw = String(e?.subject ?? e?.text ?? e?.label ?? e?.title ?? '').replace(/^[a-z]+:/i, '').replace(/_/g, ' ').trim();
  if (!raw || raw.toLowerCase() === 'event') return null;
  const subject = cleanInternalTitle(raw);
  if (!subject) return null;
  return `${verb} ${subject.replace(/^working on\s+/i, '')}`;
}

// ── "Since changed" — one marker across the prompt (2026-11-02) ─────────────
/**
 * The user's later word on a fact, beside it (memory/factChange.js): the
 * value is what was true before, their words are the latest. The same marker
 * the cognitive model's goals and the recall quotes use, so every block of the
 * prompt says "this changed" the same way (profile, identity, cognitive model).
 */
export function laterWordNote(lw) {
  if (!lw?.text) return '';
  // Uncertain: may have changed, may not ("We sold the Civic" on MY car) — the value stands.
  if (lw.kind === 'uncertain') return ` (uncertain whether still current — they said: "${String(lw.text).slice(0, 160)}")`;
  return ` (since changed — they said: "${String(lw.text).slice(0, 160)}")`;
}

/**
 * Something a record names has since changed (memory/propagation.js `review`):
 * the uncertainty marker, with the change in the user's words — or, for an edit
 * made on the Memory or Understanding page, what they did there (it is not
 * something they said). `phrase` is the text inside the parentheses, for blocks
 * that carry their own (the evidence lane).
 */
export function reviewPhrase(r) {
  if (!r?.text) return '';
  const said = r.source && r.source !== 'conversation' ? String(r.text).slice(0, 180) : `they later said: "${String(r.text).slice(0, 160)}"`;
  return `uncertain whether still current — ${said}`;
}
export function reviewNote(r, { item = null } = {}) {
  if (!r?.text) return '';
  // A goal whose target the user now holds (propagation.js reachedTarget): possibly
  // achieved, not confirmed — the user's words beside it, never a completion.
  if (r.kind === 'target_reached') {
    const said = r.source && r.source !== 'conversation' ? String(r.text).slice(0, 180) : `they said: "${String(r.text).slice(0, 160)}"`;
    return ` (may already be achieved — ${said}; not confirmed)`;
  }
  if (item == null && (!r.source || r.source === 'conversation')) return laterWordNote({ kind: 'uncertain', text: r.text });
  const what = item == null ? '' : ` "${String(item).slice(0, 80)}" is`;
  return ` (uncertain whether${what} still current — ${r.source && r.source !== 'conversation' ? String(r.text).slice(0, 180) : `they said: "${String(r.text).slice(0, 160)}"`})`;
}

/** One rule for every authoritative block: a "since changed" line is history; the user's words beside it are current. */
/**
 * One rule for every uncertainty marker, in every block that can carry one
 * (profile, identity, cognitive model, recall) — 2026-11-05. The Cloudflare
 * Mistral run settled "uncertain whether still current" as "no longer relevant":
 * the marker said what it was, nothing said what to do with it.
 */
export const UNCERTAIN_RULE = 'An "uncertain" note means the user was unsure, or something related changed: it has neither ended nor been confirmed, and "may already be achieved" is not confirmed either. Do not settle it either way on your own — if it matters to the answer, say what is unclear or ask. A change to one thing does not end the other things that mention it.';
export const SINCE_CHANGED_RULE = `Values listed are current; "(previously: …)" is what they replaced; "No longer current" lines were true before and are not now. A line marked "since changed" changed but its new value was not given — say so rather than guess; "uncertain" may or may not still hold. ${UNCERTAIN_RULE}`;

/** A value the user stated unsure ("I think I work at Halcyon Labs"): candidateExtractor hedgeOf. */
export function hedgeNote(f) {
  if (!f?.metadata?.hedged) return '';
  const said = String(f.sourceText || f.sourceMessage || '').trim();
  return said ? ` (uncertain — they said: "${said.slice(0, 160)}")` : ' (uncertain — the user was not sure)';
}
