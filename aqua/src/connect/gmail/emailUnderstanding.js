/**
 * AQUA Connect — Email understanding, DETERMINISTIC and LOCAL (Gmail Phase 3).
 *
 * A pure function of one rendered Gmail message (gmailNormalize.renderGmailDocument
 * output, as stored in the message's restricted UKO): no I/O, no model, no
 * network, no provider. It runs as a KNOWLEDGE enrichment stage
 * (files/enrichmentPipeline.js `emailUnderstanding`) and its result lives ON the
 * message's own UKO (`uko.emailUnderstanding`), which is class external:gmail:
 * invisible without includeRestricted, never copied to Memory/Mind/claims/
 * embeddings/search, removed with the source (externalSources), and replaced
 * when the message changes. There is no second store.
 *
 * Thread-level reconciliation (supersession, contradiction, duplicates) is
 * computed ON READ by reconcileThread() from the messages' records — nothing
 * thread-level is persisted, so nothing derived can outlive its emails.
 *
 * Every item carries: source Gmail message id, thread id, source timestamp,
 * extraction timestamp, an evidence reference (field + character span + bounded
 * quote), confidence + certainty, classification (external:gmail), and whether
 * it is explicit or inferred. The extractor NEVER marks anything confirmed:
 * `userConfirmed` is false until a user confirms it (a future, explicit action).
 *
 * English heuristics only; precision over recall. Quoted earlier messages in a
 * reply are removed first, so nobody is credited with words they only quoted.
 */
import crypto from 'node:crypto';

export const EMAIL_UNDERSTANDING_SCHEMA = 'aqua.email-understanding/v1';
export const EXTRACTOR = Object.freeze({ id: 'email-heuristics', version: '1.0.0', kind: 'deterministic', network: false });
export const CLASSIFICATION = 'external:gmail';
export const ITEM_TYPES = Object.freeze(['decision', 'commitment', 'task', 'deadline', 'event', 'date', 'project', 'document', 'topic']);
const LIMITS = Object.freeze({ maxSentences: 300, maxItems: 120, maxQuote: 200, maxUrls: 10, maxBody: 60_000 });

// ── parsing the rendered message ──────────────────────────────────────────────
const HEADER_KEYS = ['Gmail-Message-Id', 'Gmail-Thread-Id', 'Message-Id', 'In-Reply-To', 'References', 'Kind', 'Date', 'From', 'To', 'Cc', 'Reply-To', 'Subject', 'Labels', 'Body-Format', 'Body-Truncated'];

export function parseRenderedEmail(text) {
  const s = String(text ?? '');
  const blank = s.indexOf('\n\n');
  const head = blank >= 0 ? s.slice(0, blank) : s;
  const body = blank >= 0 ? s.slice(blank + 2) : '';
  const h = {};
  const attachments = [];
  let inAtt = false;
  for (const line of head.split('\n')) {
    if (/^Attachments \(\d+, metadata only\):$/.test(line)) { inAtt = true; continue; }
    if (inAtt && /^ {2}- /.test(line)) {
      const [filename, mimeType, size] = line.slice(4).split(' · ');
      attachments.push({ filename: filename ?? null, mimeType: mimeType ?? null, size: Number.parseInt(size, 10) || null });
      continue;
    }
    inAtt = false;
    const m = /^([A-Za-z-]+): (.*)$/.exec(line);
    if (m && HEADER_KEYS.includes(m[1])) h[m[1]] = m[2];
  }
  const dm = /^(\S+)(?: \(sent at UTC([+-]\d{2}:?\d{2})\))?$/.exec(h.Date ?? '');
  const iso = dm && !Number.isNaN(Date.parse(dm[1])) ? new Date(Date.parse(dm[1])).toISOString() : null;
  return {
    gmailId: h['Gmail-Message-Id'] ?? null, threadId: h['Gmail-Thread-Id'] ?? null,
    rfcMessageId: h['Message-Id'] ?? null, inReplyTo: h['In-Reply-To'] ?? null,
    references: h.References ? h.References.split(/\s+/).filter(Boolean) : [],
    kind: h.Kind ?? null, date: iso, zone: dm?.[2] ?? null,
    from: h.From ?? null, to: h.To ?? null, cc: h.Cc ?? null, replyTo: h['Reply-To'] ?? null,
    subject: h.Subject && h.Subject !== '(no subject)' ? h.Subject : null,
    labels: h.Labels ? h.Labels.split(', ') : [], attachments,
    body: body === '(no body)' ? '' : body.slice(0, LIMITS.maxBody),
  };
}

// ── people & organisations ────────────────────────────────────────────────────
const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me', 'protonmail.com', 'live.com', 'aol.com']);

/** "Name <a@b>, c@d" → [{ name, address }] (addresses lowercased). */
export function parseAddressList(v) {
  if (!v) return [];
  const out = [];
  const re = /\s*(?:"?([^"<,]*?)"?\s*<([^>\s]+@[^>\s]+)>|([^\s<>,"]+@[^\s<>,"]+))\s*(?:,|$)/g;
  let m;
  while ((m = re.exec(v)) !== null && out.length < 100) {
    if (m.index === re.lastIndex) re.lastIndex++;
    const address = String(m[2] ?? m[3] ?? '').toLowerCase().replace(/[.;]+$/, '');
    if (!address.includes('@')) continue;
    out.push({ name: (m[1] ?? '').trim() || null, address });
  }
  return out;
}

function participantsOf(p) {
  const people = new Map();
  for (const [role, v] of [['from', p.from], ['to', p.to], ['cc', p.cc], ['reply-to', p.replyTo]]) {
    for (const a of parseAddressList(v)) {
      const key = `person:${a.address}`;
      const cur = people.get(key) ?? { key, type: 'person', address: a.address, names: [], roles: [] };
      if (a.name && !cur.names.includes(a.name)) cur.names.push(a.name);
      if (!cur.roles.includes(role)) cur.roles.push(role);
      people.set(key, cur);
    }
  }
  const orgs = new Map();
  for (const person of people.values()) {
    const domain = person.address.split('@')[1];
    if (!domain || FREEMAIL.has(domain)) continue;
    const key = `org:${domain}`;
    const o = orgs.get(key) ?? { key, type: 'organization', domain, members: [], explicit: false, basis: 'email domain (inferred)' };
    o.members.push(person.key);
    orgs.set(key, o);
  }
  return { people: [...people.values()], organizations: [...orgs.values()] };
}

/** A name mention in the body → the participant(s) it may mean. Never guesses between two. */
export function resolveMention(name, people) {
  const n = String(name).trim().toLowerCase();
  if (!n) return { status: 'unresolved', candidates: [] };
  const full = people.filter(p => p.names.some(x => x.toLowerCase() === n));
  if (full.length === 1) return { status: 'resolved', person: full[0].key, candidates: [full[0].key] };
  const first = people.filter(p => p.names.some(x => x.toLowerCase().split(/\s+/)[0] === n.split(/\s+/)[0]));
  if (n.includes(' ') && full.length === 0) return { status: 'unresolved', candidates: [] };
  if (first.length === 1) return { status: 'resolved', person: first[0].key, candidates: [first[0].key] };
  if (first.length > 1) return { status: 'ambiguous', candidates: first.map(p => p.key) };
  return { status: 'unresolved', candidates: [] };
}

// ── dates, in the SENDER's local time ─────────────────────────────────────────
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const pad = n => String(n).padStart(2, '0');
const offsetMinutes = zone => { const m = /^([+-])(\d{2}):?(\d{2})$/.exec(zone ?? ''); return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0; };
const monthIndex = s => MONTHS.findIndex(m => m.startsWith(String(s).toLowerCase().slice(0, 3)));

/** The sender's local calendar day of the message. */
export function localDay(sourceIso, zone) {
  const t = Date.parse(sourceIso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + offsetMinutes(zone) * 60_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay() };
}
const addDays = (day, n) => { const x = new Date(Date.UTC(day.y, day.m, day.d + n)); return { y: x.getUTCFullYear(), m: x.getUTCMonth(), d: x.getUTCDate(), wd: x.getUTCDay() }; };
const ymd = day => `${day.y}-${pad(day.m + 1)}-${pad(day.d)}`;

const DATE_EXPR = new RegExp([
  String.raw`\b(?:today|tonight|tomorrow|end of (?:the )?(?:week|day)|eod|eow)\b`,
  String.raw`\b(?:(?:next|this|on)\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b`,
  String.raw`\b${MON}\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b`,
  String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+${MON}\.?(?:,?\s+\d{4})?\b`,
  String.raw`\b\d{4}-\d{2}-\d{2}\b`,
  String.raw`\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b`,
].join('|'), 'i');
const TIME_EXPR = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\bat\s+(\d{1,2}):(\d{2})\b/i;

/**
 * Resolve a date expression against the message's local day. Relative words
 * resolve in the SENDER's time zone; a numeric d/m vs m/d that cannot be told
 * apart is 'ambiguous' with both readings — never silently picked.
 */
export function resolveDate(expr, sourceIso, zone) {
  const today = localDay(sourceIso, zone);
  const e = String(expr).toLowerCase().trim();
  if (!today) return { text: expr, date: null, resolution: 'unresolved' };
  const rel = date => ({ text: expr, date: ymd(date), resolution: 'relative' });
  if (/^(today|tonight)$/.test(e)) return rel(today);
  if (e === 'tomorrow') return rel(addDays(today, 1));
  if (/^(end of (the )?week|eow)$/.test(e)) return rel(addDays(today, ((5 - today.wd) + 7) % 7 || 7));
  if (/^(end of (the )?day|eod)$/.test(e)) return rel(today);
  const wd = /^(?:(next|this|on)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/.exec(e);
  if (wd) {
    const target = WEEKDAYS.indexOf(wd[2]);
    const delta = (target - today.wd + 7) % 7 || 7;   // the next occurrence after the message's local day
    const r = rel(addDays(today, delta));
    if (wd[1] === 'next') r.certainty = 'likely';   // "next Friday" is read differently by different people
    return r;
  }
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(e);
  if (m) return { text: expr, date: `${m[1]}-${m[2]}-${m[3]}`, resolution: 'absolute' };
  const yearFor = (mo, d) => {
    const thisYear = Date.UTC(today.y, mo, d);
    return thisYear < Date.UTC(today.y, today.m, today.d) - 60 * 86_400_000 ? today.y + 1 : today.y;
  };
  m = new RegExp(`^${MON}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?$`, 'i').exec(e)
    ?? null;
  if (m) { const mo = monthIndex(m[1]); const d = Number(m[2]); const y = m[3] ? Number(m[3]) : yearFor(mo, d); return { text: expr, date: `${y}-${pad(mo + 1)}-${pad(d)}`, resolution: m[3] ? 'absolute' : 'year-inferred' }; }
  m = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON}\\.?(?:,?\\s+(\\d{4}))?$`, 'i').exec(e);
  if (m) { const mo = monthIndex(m[2]); const d = Number(m[1]); const y = m[3] ? Number(m[3]) : yearFor(mo, d); return { text: expr, date: `${y}-${pad(mo + 1)}-${pad(d)}`, resolution: m[3] ? 'absolute' : 'year-inferred' }; }
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(e);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : today.y;
    const md = a <= 12 && b <= 31 ? `${y}-${pad(a)}-${pad(b)}` : null;
    const dm = b <= 12 && a <= 31 ? `${y}-${pad(b)}-${pad(a)}` : null;
    if (md && dm && md !== dm) return { text: expr, date: null, resolution: 'ambiguous', alternatives: [md, dm] };
    return { text: expr, date: md ?? dm, resolution: 'absolute' };
  }
  return { text: expr, date: null, resolution: 'unresolved' };
}

function timeIn(sentence) {
  const m = TIME_EXPR.exec(sentence);
  if (!m) return null;
  if (m[4] != null) return `${pad(Number(m[4]))}:${m[5]}`;
  let h = Number(m[1]) % 12;
  if (m[3].toLowerCase() === 'pm') h += 12;
  return `${pad(h)}:${m[2] ?? '00'}`;
}

// ── body preparation ──────────────────────────────────────────────────────────
/** Remove quoted earlier messages: "> …" lines, and everything from "On … wrote:" / an original-message divider. */
export function stripQuoted(body) {
  const lines = String(body ?? '').split('\n');
  const out = [];
  for (const l of lines) {
    if (/^\s*On .{3,200}wrote:\s*$/i.test(l) || /^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}/i.test(l) || /^_{5,}\s*$/.test(l)) break;
    if (/^\s*>/.test(l)) continue;
    out.push(l);
  }
  return out.join('\n');
}

function sentences(text) {
  const out = [];
  const re = /[^.!?\n]+[.!?]*/g;
  let m;
  while ((m = re.exec(text)) !== null && out.length < LIMITS.maxSentences) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const s = raw.trim();
    if (s.length >= 3) out.push({ text: s, start: m.index + lead, end: m.index + lead + s.length });
  }
  return out;
}

// ── statement patterns ────────────────────────────────────────────────────────
const NEGATED = /\b(not|never|no longer|cannot|unable to)\b|n['’]t\b/i;
// Gmail Phase 5 (quality audit) — conditions, questions, automated mail, unsupported languages.
const CONDITIONAL = /^\s*(if|unless|provided(?: that)?|assuming|in case)\b|[,;]\s*(if|unless|provided(?: that)?|assuming)\b|\b(if|unless) (?:we|i|you|they|the|it|this|that)\b/i;
const STATE_NOT_ACTION = /^(be|been|have|having)\b/i;
const AUTOMATED_SENDER = /^(?:no-?reply|do-?not-?reply|notifications?|notify|mailer-daemon|postmaster|bounces?|newsletters?|marketing|alerts?|updates?|news|digest)(?:[@+._-]|$)/i;
const AUTO_REPLY = /^\s*(automatic reply|auto(?:matic)?[- ]?reply|out of (the )?office|ooo\b|undeliverable|delivery status notification)/i;
const EN_FUNCTION = new Set(['the', 'and', 'to', 'of', 'a', 'in', 'is', 'it', 'you', 'that', 'we', 'i', 'for', 'on', 'be', 'will', 'with', 'this', 'are', 'have', 'as', 'at', 'by', 'can', 'please', 'our', 'your', 'not', 'from', 'or', 'was', 'if', 'do', 'so', 'let', 'me', 'my', 'all', 'about', 'thanks', 'hi', 'hello']);

/**
 * Gmail Phase 5 — the extractor's patterns are ENGLISH. A body that is mostly
 * another script, or Latin-script text with almost no English function words,
 * is marked unsupported and yields NO statements (decisions, commitments,
 * tasks, dates): an English regex over another language is a false-positive
 * generator. Only participants, attachments and the subject survive.
 */
/*
 * Phase 4B (2026-11-23) — measured on the first real mailbox: 529 of 1,367 messages (39%)
 * were "not-english", and 520 of them were English. URLs, tracking parameters, addresses
 * and footer tokens counted as words and diluted the English function-word ratio below
 * 10%. Now: (1) only prose words are measured (URLs, e-mail addresses, HTML entities and
 * over-long tokens removed); (2) "not English" needs POSITIVE evidence of another language
 * (its own function words); (3) otherwise the result is 'uncertain' — statements are still
 * extracted (nothing silently discarded) but every one is downgraded to an uncertain
 * inference (see understandEmail).
 */
const OTHER_FUNCTION = Object.freeze({
  es: new Set(['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'un', 'una', 'por', 'para', 'con', 'es', 'del', 'se', 'no', 'su', 'al', 'lo', 'como', 'pero', 'muy', 'gracias', 'hola']),
  fr: new Set(['le', 'la', 'les', 'de', 'des', 'et', 'est', 'un', 'une', 'pour', 'que', 'qui', 'dans', 'pas', 'vous', 'nous', 'sur', 'du', 'au', 'avec', 'je', 'merci', 'bonjour', 'mais']),
  de: new Set(['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'zu', 'den', 'mit', 'sie', 'von', 'für', 'auf', 'ich', 'wir', 'sich', 'dem', 'auch', 'danke', 'bitte', 'aber']),
  pt: new Set(['o', 'os', 'as', 'de', 'que', 'e', 'em', 'um', 'uma', 'para', 'com', 'não', 'por', 'do', 'da', 'se', 'no', 'na', 'você', 'mais', 'obrigado', 'olá', 'mas']),
  it: new Set(['il', 'lo', 'la', 'gli', 'le', 'di', 'che', 'e', 'un', 'una', 'per', 'con', 'non', 'sono', 'del', 'della', 'grazie', 'ciao', 'anche', 'questo']),
  nl: new Set(['de', 'het', 'een', 'en', 'van', 'ik', 'je', 'dat', 'niet', 'met', 'voor', 'op', 'zijn', 'wij', 'ook', 'bedankt', 'dank', 'maar']),
  'hi-latn': new Set(['hai', 'hain', 'nahi', 'nahin', 'kya', 'aap', 'mein', 'main', 'ki', 'ka', 'ke', 'ko', 'bhi', 'aur', 'tha', 'kar', 'karo', 'karna', 'hum', 'tum', 'yeh', 'woh', 'kal', 'abhi', 'thik', 'haan']),
});
/** Prose words only: no URLs, addresses, HTML entities, or tokens too long to be words. */
export function proseWords(text) {
  return String(text ?? '')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')   // entities first: they glue words together
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/\S+@\S+\.\S+/g, ' ')
    .toLowerCase()
    .match(/\p{L}+/gu)?.filter(w => w.length <= 20) ?? [];
}
export function detectLanguage(text) {
  const words = proseWords(text);
  const letters = words.join('');
  if (letters.length < 12) return { detected: 'too-short', supported: true };
  const latin = (letters.match(/\p{Script=Latin}/gu) ?? []).length;
  if (latin / letters.length < 0.7) return { detected: 'non-latin-script', supported: false };
  if (words.length < 8) return { detected: 'too-short', supported: true };
  const en = words.filter(w => EN_FUNCTION.has(w)).length / words.length;
  if (en >= 0.1) return { detected: 'en', supported: true };
  let best = null, bestRatio = 0;
  for (const [code, set] of Object.entries(OTHER_FUNCTION)) {
    const r = words.filter(w => set.has(w)).length / words.length;
    if (r > bestRatio) { bestRatio = r; best = code; }
  }
  if (best && bestRatio >= 0.08 && bestRatio > en) return { detected: best, supported: false };
  return { detected: 'uncertain', supported: true, uncertain: true };
}
const HEDGE = /\b(try to|might|maybe|perhaps|possibly|hopefully|probably|i think|should be able|if (?:i|we) can|tentative(?:ly)?)\b/i;
const CHANGE = /\b(instead|changed?|update[ds]?:?|moved to|postponed|rescheduled|pushed (?:back|to)|revised|correction|actually,?|no longer)\b/i;
const DECISION = /\b(?:we|i|they|the team|management|everyone|all of us)\s+(?:have\s+|has\s+|'ve\s+)?(?:now\s+)?(decided|agreed|approved|chose|finali[sz]ed|signed off)\b/i;
const DECISION_LABEL = /^\s*(decision|decided|resolution)\s*:/i;
const DECISION_SOFT = /\b(let'?s go with|we(?:'re| are) going with|we should go with|i suggest we go with)\b/i;
const COMMIT = /\b(I|we)(?:'ll|'d| will| shall| am going to| are going to| promise to| commit to| plan to)\s+([^.;!?]{3,160})/i;
const TASK_ASK = /\b(?:can|could|would) you\b([^?]{3,160})\?/i;
// Gmail Phase 6 (evaluation D1, D8): a sentence-initial "Please …" is a request too, and the addressee
// may be a full name ("Priya Shah, please …"). A greeting is not a name ("Hi Raj, please …" names Raj).
const TASK_PLEASE = /(?:^|[,;]\s*|\b)(?:(?!(?:Hi|Hello|Hey|Dear|Thanks|Thank|Ok|Okay|So|And|But|Also)\b)([A-Z][a-z]{1,20}(?: [A-Z][a-z]{1,20}){0,2}),\s+)?[Pp]lease\s+([^.;!?]{3,160})/;
// Courtesy formulas are not requests ("Please find attached …", "Please let me know …").
const PLEASE_COURTESY = /^(?:find|see|note|let (?:me|us) know|feel free|do not hesitate|don['’]t hesitate|ignore|disregard)\b/i;
// Gmail Phase 6 (evaluation D4): an explicit acceptance of a request ("Sure, I can share it tomorrow.") is a commitment.
// …but agreeing with a point is not a promise ("Sure, I can see why …", held-out evaluation).
const ACCEPT_COMMIT = /^\s*(?:sure|yes|ok(?:ay)?|of course|absolutely|no problem)[,!.]?\s+(I|we) can\s+(?!(?:see|understand|imagine|tell|hear|appreciate|relate|believe|guess|feel|agree)\b)([^.;!?]{3,160})/i;
// Gmail Phase 6 (evaluation D7): a remark about an event that already happened is not a scheduled event.
const PAST_REMARK = /^\s*(?:thanks|thank you)\s+(?:so much\s+|again\s+)?for\b|\b(?:was|were)\s+(?:great|good|nice|helpful|productive|fun|lovely|useful|amazing|awesome|excellent)\b|\bwent\s+(?:well|great|fine)\b/i;
// Gmail Phase 6 (evaluation D2, D3): a later message that reports an item done, or calls it off.
const COMPLETED = /\b(?:i|we)(?:['’]ve| have)\s+(?:now\s+|just\s+|already\s+)?(?:sent|shared|submitted|uploaded|finished|completed|done|prepared|updated|signed|confirmed|delivered|fixed)\b|^\s*done\b|\b(?:is|are|has been|have been)\s+(?:now\s+)?(?:done|updated|sent|submitted|completed|finished|uploaded|signed|confirmed|delivered|fixed)\b/i;
const CANCELLED = /\b(?:never ?mind|no need to|no longer need(?:ed)?|disregard|scratch that|forget about)\b/i;
const CLOSURE_STOP = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'its', 'our', 'your', 'their', 'his', 'her', 'are', 'was', 'were', 'been', 'has', 'have', 'had', 'will', 'can', 'could', 'would', 'should', 'please', 'also', 'just', 'now', 'already', 'need', 'never', 'mind', 'not', 'let', 'know', 'thanks', 'thank', 'attached', 'done', 'due', 'deadline', 'moved', 'update', 'updated', 'send', 'sent', 'share', 'shared', 'prepare', 'prepared', 'finish', 'finished', 'complete', 'completed', 'submit', 'submitted', 'confirm', 'confirmed', 'upload', 'uploaded', 'sign', 'signed', 'deliver', 'delivered', 'fix', 'fixed', 'team', 'there', 'so', 'is', 'it']);
/** Content words of a sentence (dates and generic verbs removed), used to tie a closure or a change to an earlier item. */
export const contentWords = s => [...new Set((String(s ?? '').toLowerCase().replace(new RegExp(DATE_EXPR.source, 'gi'), ' ').match(/[a-z][a-z0-9-]{2,}/g) ?? []).filter(w => !CLOSURE_STOP.has(w)))];
const sharesSubject = (a, b) => { const B = new Set(contentWords(b)); return contentWords(a).filter(w => B.has(w)).length >= 2; };
const TASK_LABEL = /^\s*(action items?|todo|to-do|follow[- ]?up|next steps?)\s*:\s*(.{3,160})/i;
const DEADLINE = new RegExp(String.raw`\b(by|before|due(?:\s+(?:on|by))?|no later than|deadline(?:\s+is)?|until)\s+(${DATE_EXPR.source})`, 'i');
const EVENT = /\b(meeting|call|sync|standup|stand-up|interview|demo|review session|lunch|catch[- ]up|workshop|webinar|offsite|kick-?off)\b/i;
const DATE_FACT = new RegExp(String.raw`\b(?:the\s+)?([a-z][a-z ]{2,30}?)\s+(?:is|will be|has been moved to|was moved to|is now|has moved to|got moved to|is scheduled for)\s+(?:on\s+)?(${DATE_EXPR.source})`, 'i');
const PROJECT = /\b(?:[Pp]roject|[Ii]nitiative)\s+([A-Z][\w-]{1,40})|\b[Tt]he\s+([A-Z][\w-]{1,40})\s+(?:[Pp]roject|[Ii]nitiative)\b/;
const URL_RE = /https?:\/\/[^\s<>()"'\]]{3,300}/g;

const norm = s => String(s ?? '').toLowerCase().replace(DATE_EXPR, ' ').replace(/\b(by|before|on|at|until|instead|please|the|a|an|it|this|that)\b/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ');
export const normalizeSubject = s => String(s ?? '').replace(/^\s*((re|fw|fwd|aw)\s*:\s*)+/i, '').trim().toLowerCase();

/**
 * Understand ONE message. Pure: (rendered text, extractedAt) → record.
 * @returns {object|null} null when the text is not a rendered Gmail message
 */
export function understandEmail(renderedText, { extractedAt = new Date().toISOString() } = {}) {
  const p = parseRenderedEmail(renderedText);
  if (!p.gmailId) return null;
  const { people, organizations } = participantsOf(p);
  const sender = people.find(x => x.roles.includes('from'))?.key ?? null;
  const recipients = people.filter(x => x.roles.includes('to')).map(x => x.key);
  const body = stripQuoted(p.body);
  const items = [];
  const language = detectLanguage(body);
  const senderAddress = people.find(x => x.roles.includes('from'))?.address ?? '';
  const automated = AUTOMATED_SENDER.test(senderAddress) || AUTO_REPLY.test(p.subject ?? '') || /this is an automatic(ally generated)? (reply|message)/i.test(body);
  // Statements (decisions, commitments, tasks, deadlines, events, dates, projects) only from
  // supported-language mail written by a person; never from automated mail.
  const statementsAllowed = language.supported && !automated;
  const base = (type, field, span, quoteText, extra) => {
    const quote = String(quoteText).slice(0, LIMITS.maxQuote);
    const id = crypto.createHash('sha256').update(`${p.gmailId}|${type}|${field}|${span[0]}|${span[1]}`).digest('hex').slice(0, 16);
    const out = {
      id, type, classification: CLASSIFICATION,
      gmailMessageId: p.gmailId, threadId: p.threadId, sourceTimestamp: p.date, extractedAt,
      evidence: { gmailMessageId: p.gmailId, threadId: p.threadId, field, span, quote },
      userConfirmed: false,
      ...extra,
    };
    // Phase 4B: a statement from mail whose language could not be established is kept, but
    // only ever as an uncertain inference — never "stated", never explicit.
    if (language.uncertain && type !== 'document' && type !== 'topic') {
      Object.assign(out, { certainty: 'uncertain', explicit: false, confidence: Math.min(Number(out.confidence) || 0.35, 0.35), languageUncertain: true });
    }
    return out;
  };
  const push = it => { if (items.length < LIMITS.maxItems) items.push(it); };
  // Gmail Phase 6: sentences that report an earlier item done or called off. They are not items;
  // reconcileThread applies them to EARLIER commitments/tasks of the same thread that share the subject.
  const closures = [];
  // A hedge or a condition ("if the budget is approved, I'll …") makes a statement uncertain and inferred — never stated.
  const certaintyOf = (s, dflt) => (HEDGE.test(s) || CONDITIONAL.test(s) ? { certainty: 'uncertain', confidence: 0.35, explicit: false, ...(CONDITIONAL.test(s) ? { conditional: true } : {}) } : dflt);

  for (const s of (statementsAllowed ? sentences(body) : [])) {
    const t = s.text;
    // A question decides and promises nothing ("Have we decided on pricing?", "Will you send it?").
    const question = /\?\s*$/.test(t);
    const negated = NEGATED.test(t) || question;
    const change = CHANGE.test(t);
    const time = timeIn(t);
    if (!question) {
      const closure = CANCELLED.test(t) ? 'cancelled' : COMPLETED.test(t) ? 'completed' : null;
      if (closure && closures.length < 20) closures.push({ kind: closure, by: sender, evidence: { gmailMessageId: p.gmailId, threadId: p.threadId, field: 'body', span: [s.start, s.end], quote: t.slice(0, LIMITS.maxQuote) } });
    }
    const dl = DEADLINE.exec(t);
    const due = dl ? resolveDate(dl[2], p.date, p.zone) : null;

    if (!negated && (DECISION.test(t) || DECISION_LABEL.test(t))) {
      push(base('decision', 'body', [s.start, s.end], t, { statement: t, actor: sender, explicit: true, certainty: 'stated', confidence: 0.85, change, ...certaintyOf(t, {}) , key: `decision:${normalizeSubject(p.subject)}` }));
    } else if (!negated && DECISION_SOFT.test(t)) {
      push(base('decision', 'body', [s.start, s.end], t, { statement: t, actor: sender, explicit: false, certainty: 'likely', confidence: 0.55, change, key: `decision:${normalizeSubject(p.subject)}` }));
    }

    const c = COMMIT.exec(t) ?? ACCEPT_COMMIT.exec(t);
    if (c && !negated) {
      const object = c[2].replace(/\s+/g, ' ').trim();
      // Gmail Phase 6 (evaluation D5): "we'll start the pilot on Monday" — the date the promised action happens.
      const inObject = DATE_EXPR.exec(object);
      const when = due ?? (inObject ? resolveDate(inObject[0], p.date, p.zone) : null);
      push(base('commitment', 'body', [s.start, s.end], t, {
        statement: t, actor: sender, actorScope: c[1].toLowerCase() === 'we' ? 'sender-and-others' : 'sender',
        object, due: when, explicit: true, certainty: 'stated', confidence: 0.8, change,
        // "I'll be out of office until Monday" describes a state, not an action promised: inference, not a stated commitment.
        ...(STATE_NOT_ACTION.test(object) ? { explicit: false, certainty: 'likely', confidence: 0.5, stateNotAction: true } : {}),
        ...certaintyOf(t, {}),
        key: `commitment:${sender}:${norm(object)}`,
      }));
    }

    const ask = TASK_ASK.exec(t);
    const pleaseM = ask ? null : TASK_PLEASE.exec(t);
    const please = pleaseM && !PLEASE_COURTESY.test(pleaseM[2]) ? pleaseM : null;
    const label = TASK_LABEL.exec(t);
    if (ask || please || label) {
      const named = please?.[1] ? resolveMention(please[1], people) : null;
      // Gmail Phase 6 (evaluation D8): an un-named request in mail with exactly ONE recipient (To and Cc together)
      // is addressed to that person. With anyone else copied it stays inferred (candidates).
      const allRecipients = people.filter(x => x.roles.includes('to') || x.roles.includes('cc')).map(x => x.key);
      const soleRecipient = allRecipients.length === 1 && allRecipients[0] !== sender ? allRecipients[0] : null;
      const assignee = named?.status === 'resolved' ? { status: 'resolved', person: named.person }
        : named ? { status: named.status, candidates: named.candidates }
        : soleRecipient ? { status: 'resolved', person: soleRecipient, basis: 'sole-recipient' }
        : { status: 'inferred', candidates: recipients };
      const object = (ask?.[1] ?? please?.[2] ?? label?.[2] ?? '').trim();
      // The REQUEST is stated when it is addressed to someone: by name (even an ambiguous one —
      // the ambiguity stays on the assignee), to the only recipient, or as an action-item label.
      // An un-addressed question to several people stays likely.
      const stated = Boolean(label || assignee.status === 'resolved' || named?.status === 'ambiguous');
      push(base('task', 'body', [s.start, s.end], t, {
        statement: t, requestedBy: sender, assignee, object, due,
        explicit: stated, certainty: stated ? 'stated' : 'likely', confidence: stated ? 0.8 : 0.6,
        change, key: `task:${norm(object)}`,
      }));
    }

    if (due && !c && !ask && !please && !label && !negated) {   // a question or a negation sets no deadline
      push(base('deadline', 'body', [s.start, s.end], t, { statement: t, due, explicit: due.resolution !== 'ambiguous', certainty: due.resolution === 'ambiguous' ? 'uncertain' : 'stated', confidence: due.resolution === 'ambiguous' ? 0.3 : 0.75, change, key: `deadline:${norm(t)}` }));
    }

    const ev = EVENT.exec(t);
    const dateM = DATE_EXPR.exec(t);
    // Held-out evaluation: an event word used as a verb ("I'll call the supplier tomorrow") is not an event,
    // and a date given only as a deadline ("send the offsite budget by Friday") is not when an event happens.
    const eventVerb = ev && /\b(?:i|we|you|they|['’]ll|will|to|can|could|should|would|please|let['’]?s)\s+(?:also\s+|just\s+)?$/i.test(t.slice(0, ev.index));
    const deadlineOnly = Boolean(dl) && (t.match(new RegExp(DATE_EXPR.source, 'gi')) ?? []).length === 1;
    if (ev && dateM && !negated && !PAST_REMARK.test(t) && !eventVerb && !deadlineOnly) {
      const when = resolveDate(dateM[0], p.date, p.zone);
      // Gmail Phase 6 (evaluation D9): "is scheduled for …", "is booked for …" state the event; otherwise it is likely.
      const scheduled = /\b(scheduled|is on|is at|will be on|invite|calendar|booked|confirmed)\b/i.test(t);
      push(base('event', 'body', [s.start, s.end], t, {
        statement: t, kind: ev[1].toLowerCase(), when: { ...when, time, zone: p.zone ? `UTC${p.zone}` : null },
        explicit: scheduled, certainty: HEDGE.test(t) ? 'uncertain' : scheduled ? 'stated' : 'likely', confidence: HEDGE.test(t) ? 0.35 : scheduled ? 0.75 : 0.65,
        change, key: `event:${ev[1].toLowerCase()}:${normalizeSubject(p.subject)}`,
      }));
    }

    const df = DATE_FACT.exec(t);
    if (df && !negated && !EVENT.test(df[1])) {
      const subjectPhrase = df[1].trim().toLowerCase().replace(/^(the|our|my)\s+/, '');
      push(base('date', 'body', [s.start, s.end], t, {
        statement: t, about: subjectPhrase, value: resolveDate(df[2], p.date, p.zone),
        explicit: true, certainty: HEDGE.test(t) ? 'uncertain' : 'stated', confidence: HEDGE.test(t) ? 0.35 : 0.75,
        change, key: `date:${subjectPhrase}`,
      }));
    }

    const pr = PROJECT.exec(t);
    if (pr) push(base('project', 'body', [s.start, s.end], t, { name: pr[1] ?? pr[2], explicit: true, certainty: 'stated', confidence: 0.7, change: false, key: `project:${(pr[1] ?? pr[2]).toLowerCase()}` }));
  }

  let urls = 0;
  for (const m of body.matchAll(URL_RE)) {
    if (urls++ >= LIMITS.maxUrls) break;
    const url = m[0].replace(/[.,;:]+$/, '');
    push(base('document', 'body', [m.index, m.index + url.length], url, { reference: 'link', url, explicit: true, certainty: 'stated', confidence: 0.9, change: false, key: `document:${url}` }));
  }
  p.attachments.forEach((a, i) => push(base('document', 'attachment', [i, i], a.filename ?? '(unnamed)', {
    reference: 'attachment', filename: a.filename, mimeType: a.mimeType, size: a.size, contentFetched: false,
    explicit: true, certainty: 'stated', confidence: 0.95, change: false, key: `document:attachment:${String(a.filename).toLowerCase()}`,
  })));
  if (p.subject) push(base('topic', 'subject', [0, p.subject.length], p.subject, { topic: normalizeSubject(p.subject), explicit: true, certainty: 'stated', confidence: 0.9, change: false, key: `topic:${normalizeSubject(p.subject)}` }));

  return {
    schema: EMAIL_UNDERSTANDING_SCHEMA, extractor: { ...EXTRACTOR }, classification: CLASSIFICATION,
    source: { gmailMessageId: p.gmailId, threadId: p.threadId, rfcMessageId: p.rfcMessageId, sourceTimestamp: p.date, senderZone: p.zone ? `UTC${p.zone}` : null, extractedAt },
    conversation: { threadId: p.threadId, kind: p.kind, inReplyTo: p.inReplyTo, references: p.references, subject: p.subject, topic: normalizeSubject(p.subject) },
    language, automated,   // Gmail Phase 5: why a message yielded no statements (unsupported language / automated mail)
    people, organizations, items, closures,
  };
}

// ── thread-level reconciliation (computed on read; never stored) ──────────────
/**
 * Messages of ONE thread (their understanding records) → items with a status:
 *   current       the latest word on its key
 *   superseded    a LATER message with a change marker ("instead", "moved to",
 *                 "update:", …) restated it — supersededBy names the item
 *   contradicted  a later message states a DIFFERENT value for the same key with
 *                 NO change marker — both stay 'contradicted' (neither is confirmed)
 *   duplicate     the same statement again (same RFC Message-ID delivered twice)
 * Nothing is ever marked confirmed here.
 */
export function reconcileThread(records) {
  const seenRfc = new Set();
  const msgs = [];
  for (const r of [...records].filter(Boolean).sort((a, b) => String(a.source.sourceTimestamp).localeCompare(String(b.source.sourceTimestamp)) || a.source.gmailMessageId.localeCompare(b.source.gmailMessageId))) {
    const dup = r.source.rfcMessageId && seenRfc.has(r.source.rfcMessageId);
    if (r.source.rfcMessageId) seenRfc.add(r.source.rfcMessageId);
    msgs.push({ r, dup });
  }
  const out = [];
  const latestByKey = new Map();          // key → item (current)
  const valueOf = it => JSON.stringify(it.type === 'date' ? it.value?.date ?? it.value?.text : it.type === 'commitment' || it.type === 'task' ? it.due?.date ?? it.object : it.type === 'event' ? it.when?.date : it.statement);
  // Gmail Phase 6 (evaluation D2, D3): who may close an item — the promiser reports their promise
  // done or withdraws it; the assignee reports a request done; the requester calls it off.
  const mayClose = (it, c) => (it.type === 'commitment' ? c.by === it.actor
    : c.kind === 'cancelled' ? c.by === it.requestedBy
      : c.by === it.assignee?.person || (it.assignee?.candidates ?? []).includes(c.by));
  for (const { r, dup } of msgs) {
    for (const c of dup ? [] : r.closures ?? []) {
      for (const it of out) {
        if (!['commitment', 'task'].includes(it.type) || !['current', 'contradicted'].includes(it.status)) continue;
        if (!c.by || !mayClose(it, c) || !sharesSubject(it.object ?? it.statement, c.evidence.quote)) continue;
        it.status = c.kind;   // 'completed' | 'cancelled' — closed, kept as history with the closing evidence
        it.closedBy = { kind: c.kind, by: c.by, sourceTimestamp: r.source.sourceTimestamp, evidence: c.evidence };
      }
    }
    for (const item of r.items) {
      const it = { ...item, status: dup ? 'duplicate' : 'current' };
      out.push(it);
      // Phase 4B: the same project named again in the thread is the same project (it corroborates the first mention).
      if (!dup && it.type === 'project') {
        const first = latestByKey.get(it.key);
        if (first) { it.status = 'corroborates'; it.corroborates = first.id; } else latestByKey.set(it.key, it);
        continue;
      }
      if (dup || ['topic', 'project', 'document'].includes(it.type)) continue;
      let prev = latestByKey.get(it.key);
      // A change by the same actor that names its object differently ("send it" vs "send the deck").
      if (!prev && it.change && it.actor) prev = [...latestByKey.values()].reverse().find(x => x.type === it.type && x.actor === it.actor && x.status === 'current') ?? null;
      // Gmail Phase 6 (evaluation D6): a changed date restates an earlier deadline/date of the same subject
      // even when it is phrased as the other kind ("the report is due tomorrow" → "the report deadline has moved to Wednesday").
      if (!prev && it.change && ['deadline', 'date'].includes(it.type)) prev = [...latestByKey.values()].reverse().find(x => ['deadline', 'date'].includes(x.type) && x.status === 'current' && sharesSubject(x.statement, it.statement)) ?? null;
      if (prev && prev.status !== 'duplicate') {
        if (it.change) { prev.status = 'superseded'; prev.supersededBy = it.id; it.supersedes = prev.id; }
        else if (it.type !== 'decision' && valueOf(prev) !== valueOf(it)) {
          prev.status = 'contradicted'; it.status = 'contradicted';
          prev.conflictsWith = [...(prev.conflictsWith ?? []), it.id]; it.conflictsWith = [prev.id];
        } else if (valueOf(prev) === valueOf(it) && it.type !== 'decision') { it.status = 'corroborates'; it.corroborates = prev.id; continue; }
      }
      latestByKey.set(it.key, it);
    }
  }
  return out;
}

/** Problems with a record ([] = complete provenance). Used by tests and by the reader. */
export function validateUnderstanding(rec) {
  const p = [];
  if (!rec || rec.schema !== EMAIL_UNDERSTANDING_SCHEMA) return ['not an email-understanding record'];
  if (rec.classification !== CLASSIFICATION) p.push('classification');
  for (const it of rec.items ?? []) {
    const miss = ['gmailMessageId', 'threadId', 'sourceTimestamp', 'extractedAt', 'classification', 'explicit', 'certainty', 'confidence'].filter(k => it[k] === undefined || it[k] === null);
    if (!it.evidence?.gmailMessageId || !it.evidence?.threadId || !Array.isArray(it.evidence?.span) || typeof it.evidence?.quote !== 'string') miss.push('evidence');
    if (it.classification !== CLASSIFICATION) miss.push('classification-value');
    if (it.userConfirmed !== false) miss.push('userConfirmed');
    if (miss.length) p.push(`${it.type}:${it.id}: ${miss.join(',')}`);
  }
  return p;
}
