/**
 * AQUA — Episodic recall: the user's own words from earlier conversations
 * (2026-10-20).
 *
 * WHY THIS EXISTS
 * ---------------
 * Until now the answer model saw exactly two things about the user's past: the
 * current conversation's window, and what background extraction had turned
 * into claims. Anything said in ANOTHER conversation reached the answer only if
 * extraction caught it — and extraction is lossy by construction: a compound
 * sentence keeps one of its two changes, a rate-limited job lands minutes
 * later, 7% of facts never become claims (scorecard §3a, §3b).
 *
 * The measurement that decided this (held-out Lift v3, same answerer, same
 * judge, PRODUCT_SCORECARD.md §2): every past user turn verbatim in the prompt
 * scored 95.3% correct / 1.0% stale; BM25 over raw turns 78.5% / 9.1%; the
 * World Model alone 73.4% / 15.2%. The structured model is valuable for what
 * it alone can do — supersession, provenance, correction, abstention — but as
 * the ONLY window onto the past it loses what the user actually said.
 *
 * So the answer now gets both: the World Model's current understanding, and a
 * bounded, query-matched set of the user's own past messages, dated and in
 * order, so the model can see what changed. The World Model also annotates
 * those quotes: an excerpt whose claim was later superseded carries the
 * current statement beside it (canonicalReadModel.supersessionNotes).
 *
 * GUARANTEES
 * ----------
 *   · OWNER-SCOPED: a platform user's recall reads only conversations whose
 *     meta.userId is theirs; a conversation-scoped owner reads only its own.
 *   · USER WORDS ONLY: assistant text is never quoted as something the user
 *     said (a short reply carries a few words of the question it answered,
 *     labelled as such, so "yes, May 2" keeps its meaning).
 *   · FORGET HOLDS: every sentence is checked against recallRedactions before
 *     it is quoted — a forgotten value or sentence never comes back this way.
 *   · NO DUPLICATION: messages already in this turn's conversation window are
 *     not quoted again.
 *   · BOUNDED: k passages, a character budget, a per-conversation tokenised
 *     cache; no network, no LLM, deterministic.
 *   · HONEST WHEN NOTHING APPLIES: weak matches below a relative floor are
 *     dropped, so an unrelated question gets no excerpts.
 */
import { getAllConversations } from './conversationStore.js';
import { redactionsFor } from './recallRedactions.js';
import { classifyText } from './sensitivity.js';
import { getAttachments } from '../upload/attachmentStore.js';

export function recallEnabled() {
  return String(process.env.AQUA_EPISODIC_RECALL ?? '').toLowerCase() !== 'off';
}

export const RECALL_DEFAULTS = Object.freeze({
  k: 8,               // passages quoted
  maxChars: 3600,     // ≈ 900 tokens of excerpts
  followUps: 3,       // later passages admitted because they continue a selected one
  relativeFloor: 0.3, // a passage must score ≥ 30% of the best one
  passageChars: 480,
  // ADAPTIVE: while everything the user ever said fits this budget (≈2k
  // tokens), quote ALL of it, in order, instead of a ranked subset. Measured
  // reason: on short histories every-turn-verbatim was the best condition
  // (95.3% correct, 1.0% stale, lowest fabrication); selection only pays once
  // the history outgrows the prompt. 0 disables.
  allUnderChars: 8000,
});

/**
 * FILES the user uploaded in OTHER conversations (2026-10-20). A file uploaded
 * in this conversation is already in the prompt whole (attachmentStore); one
 * uploaded last week reached the answer only through document extraction,
 * which lost exact figures ("15,000 words", "max 12 days a month") — the
 * category the first recall measurement still lost (file questions 73% vs 100%
 * for full history). Own pool, own budget, so one long PDF can never push the
 * user's own words out of whole-history mode.
 */
export const FILE_DEFAULTS = Object.freeze({
  k: 4,
  maxChars: 2400,
  followUps: 0,
  relativeFloor: 0.3,
  allUnderChars: 4000,
});

// ── tokens ─────────────────────────────────────────────────────────────────

// "may" is deliberately absent: in this product it is far more often the month.
const STOP = new Set(('a an the is are was were be been being am i me my mine myself we our ours us you your yours '
  + 'it its this that these those to of in on at for with from by and or but do does did doing done what where when '
  + 'who whom whose how why which can could should would will shall might must have has had having not no nor so '
  + 'if then than there their theirs they them he him his she her hers about into onto up out just now also too very '
  + 'any some all each every much many more most other such own same only again ever really still yet tell know think '
  + 'remember said say told ask asked please thanks thank ok okay hi hey hello yes yeah sure like get got one '
  // contractions, apostrophe already removed by tokens()
  + 'im ive id ill youre youve youll were weve well theyre theyve thats whats wheres whos hows whys theres heres '
  + 'its lets dont doesnt didnt isnt arent wasnt werent cant couldnt wont wouldnt shouldnt havent hasnt hadnt'
  ).split(/\s+/));

/** Light suffix folding so "launching"/"launched"/"launches" meet "launch". */
export function stem(t) {
  let s = t;
  for (const suf of ['ing', 'ed', 'es', 's']) {
    if (s.endsWith(suf) && s.length - suf.length >= 3 && !(suf === 's' && s.endsWith('ss'))) { s = s.slice(0, -suf.length); break; }
  }
  if (s.length >= 5 && s.endsWith('e')) s = s.slice(0, -1);
  return s;
}

export function tokens(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(t => (t.length > 1 || /\p{N}/u.test(t)) && !STOP.has(t))
    .map(t => (/\p{N}/u.test(t) ? t : stem(t)));
}

/** Words that mark a statement as a CHANGE to something said before. */
const CHANGE_MARKERS = /\b(actually|correction|no longer|not anymore|any ?more|instead|changed?|moved?|switched|now|update[ds]?|turns out|cancel(?:led|ed)?|postponed|delayed|slipped|pushed|replaced|left|quit|promoted|decided)\b/i;

// ── passages ───────────────────────────────────────────────────────────────

/** Title / abbreviation / initial before a period: not a sentence end ("Dr. Okafor", "Dec. 9", "J. Smith"). */
const NO_BREAK_BEFORE = /(?:^|[\s(])(?:dr|mr|mrs|ms|prof|st|jr|sr|vs|etc|inc|ltd|co|no|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|e\.g|i\.e|[\p{L}])\.$/iu;

/** Sentence split that keeps titles, month abbreviations and initials intact. */
export function sentencesOf(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\n+/)) {
    const parts = line.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"'(])/u);
    let cur = '';
    for (const part of parts) {
      cur = cur ? `${cur} ${part}` : part;
      if (!NO_BREAK_BEFORE.test(cur)) { out.push(cur.trim()); cur = ''; }
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out.filter(Boolean);
}

/** One user message → passages of whole sentences, each ≤ maxChars (a single long sentence is cut). */
export function passagesOf(text, maxChars = RECALL_DEFAULTS.passageChars) {
  const out = [];
  let cur = [];
  let len = 0;
  for (let s of sentencesOf(text)) {
    if (s.length > maxChars) s = `${s.slice(0, maxChars - 1)}…`;
    if (len + s.length + 1 > maxChars && cur.length) { out.push(cur); cur = []; len = 0; }
    cur.push(s);
    len += s.length + 1;
  }
  if (cur.length) out.push(cur);
  return out;
}

function termFreq(toks) {
  const tf = new Map();
  for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

/**
 * Units for one conversation's messages (pure). `replyTo` is the start of the
 * assistant message a short user reply answered — context, never quoted as the
 * user's words.
 */
export function unitsForConversation(conversationId, messages, meta = {}) {
  const units = [];
  const title = typeof meta.title === 'string' ? meta.title : null;
  (messages ?? []).forEach((m, msgIndex) => {
    if (m?.role !== 'user' || typeof m.content !== 'string' || !m.content.trim()) return;
    const prev = messages[msgIndex - 1];
    const replyTo = m.content.trim().length < 80 && prev?.role === 'assistant' && typeof prev.content === 'string'
      ? prev.content.trim().replace(/\s+/g, ' ').slice(0, 140)
      : null;
    passagesOf(m.content).forEach((sentences, p) => {
      const text = sentences.join(' ');
      const toks = tokens(text);
      if (!toks.length) return;
      units.push({
        key: `${conversationId}#${msgIndex}#${p}`,
        conversationId, title, msgIndex, ts: Number.isFinite(m.ts) ? m.ts : null,
        sentences, text, toks, tf: termFreq(toks), replyTo,
      });
    });
  });
  return units;
}

/** One conversation's uploaded files → line-grouped passages (pure). Documents are line-structured, not prose. */
export function unitsForAttachments(conversationId, attachments, maxChars = RECALL_DEFAULTS.passageChars) {
  const units = [];
  for (const a of attachments ?? []) {
    if (typeof a?.content !== 'string' || !a.content.trim()) continue;
    const groups = [];
    let cur = [];
    let len = 0;
    for (let line of a.content.split(/\n+/).map(l => l.trim()).filter(Boolean)) {
      if (line.length > maxChars) line = `${line.slice(0, maxChars - 1)}…`;
      if (len + line.length + 1 > maxChars && cur.length) { groups.push(cur); cur = []; len = 0; }
      cur.push(line);
      len += line.length + 1;
    }
    if (cur.length) groups.push(cur);
    groups.forEach((lines, p) => {
      const text = lines.join(' · ');
      const toks = tokens(text);
      if (!toks.length) return;
      units.push({
        key: `${conversationId}#file:${a.id ?? a.name}#${p}`,
        conversationId, title: null, msgIndex: -1, ts: Number.isFinite(a.uploadedAt) ? a.uploadedAt : null,
        source: 'file', fileName: String(a.name ?? 'a file'),
        sentences: lines, text, toks, tf: termFreq(toks), replyTo: null,
      });
    });
  }
  return units;
}

// Per-conversation cache: tokenising a long history on every turn is the only
// real cost here, and a conversation only ever grows by appending.
const cache = new Map();   // conversationId → { n, lastTs, units }
const MAX_CACHED = 5000;

function cachedUnits(conversationId, conv) {
  const messages = conv?.messages ?? [];
  const lastTs = messages.at(-1)?.ts ?? null;
  const hit = cache.get(conversationId);
  if (hit && hit.n === messages.length && hit.lastTs === lastTs && hit.title === (conv?.meta?.title ?? null)) return hit.units;
  const units = unitsForConversation(conversationId, messages, conv?.meta ?? {});
  cache.set(conversationId, { n: messages.length, lastTs, title: conv?.meta?.title ?? null, units });
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
  return units;
}

/**
 * Every recallable unit for this owner. A platform user (userId) reads all of
 * their conversations; otherwise only `conversationId`. Messages of the CURRENT
 * conversation already in the window (index ≥ excludeFromIndex) are skipped.
 */
export function collectUnits({ userId = null, conversationId = null, excludeFromIndex = Infinity, conversations = getAllConversations(),
  includeFiles = false, attachmentsFor = getAttachments } = {}) {
  const out = [];
  const uid = userId != null ? String(userId) : null;
  for (const [id, conv] of conversations) {
    const mine = uid ? String(conv?.meta?.userId ?? '') === uid : id === conversationId;
    if (!mine) continue;
    for (const u of cachedUnits(id, conv)) {
      if (id === conversationId && u.msgIndex >= excludeFromIndex) continue;
      out.push(u);
    }
    // This conversation's own files are already in the prompt, whole.
    if (includeFiles && id !== conversationId) out.push(...cachedFileUnits(id, attachmentsFor(id)));
  }
  return out;
}

const fileCache = new Map();   // conversationId → { sig, units }
function cachedFileUnits(conversationId, attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (!list.length) return [];
  const sig = list.map(a => `${a.id ?? a.name}:${a.content?.length ?? 0}`).join('|');
  const hit = fileCache.get(conversationId);
  if (hit?.sig === sig) return hit.units;
  const units = unitsForAttachments(conversationId, list);
  fileCache.set(conversationId, { sig, units });
  if (fileCache.size > MAX_CACHED) fileCache.delete(fileCache.keys().next().value);
  return units;
}

// ── ranking ────────────────────────────────────────────────────────────────

/** BM25 (k1 1.2, b 0.75) of every unit against the query terms. Pure. */
export function scoreUnits(units, query) {
  const q = [...new Set(tokens(query))];
  if (!q.length || !units.length) return { scored: [], idf: new Map() };
  const N = units.length;
  const avgdl = units.reduce((n, u) => n + u.toks.length, 0) / N || 1;
  const df = new Map();
  for (const u of units) for (const t of u.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = new Map();
  for (const [t, n] of df) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  const k1 = 1.2, b = 0.75;
  const scored = [];
  for (const u of units) {
    let s = 0;
    let matched = 0;
    for (const t of q) {
      const f = u.tf.get(t);
      if (!f) continue;
      matched++;
      s += idf.get(t) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * u.toks.length / avgdl));
    }
    if (s > 0) scored.push({ unit: u, score: s, matched });
  }
  // Higher score first; ties → the LATER statement (it is the likelier current one).
  scored.sort((x, y) => y.score - x.score || (y.unit.ts ?? 0) - (x.unit.ts ?? 0) || (x.unit.key < y.unit.key ? -1 : 1));
  return { scored, idf };
}

const order = (a, b) => (a.ts ?? 0) - (b.ts ?? 0) || (a.conversationId === b.conversationId ? a.msgIndex - b.msgIndex : (a.key < b.key ? -1 : 1));

/**
 * Choose what to quote (pure apart from the injected redaction matcher).
 * Returns the excerpts in chronological order plus counters.
 */
export function selectRecall(units, query, { redaction = { isRedacted: () => false }, ...opts } = {}) {
  const o = { ...RECALL_DEFAULTS, ...opts };
  const stats = { candidates: units.length, matched: 0, selected: 0, followUps: 0, redactedSentences: 0, mode: 'ranked' };
  const { scored, idf } = scoreUnits(units, query);
  stats.matched = scored.length;

  // Quote only the sentences the user has not asked Aqua to forget.
  const clean = u => {
    // Whole passage first: a phrase split across a sentence boundary the
    // splitter guessed wrong must still be caught. Then sentence by sentence.
    if (redaction.isRedacted(u.text, u.ts)) {
      const parts = u.sentences.filter(s => !redaction.isRedacted(s, u.ts));
      const rejoined = parts.join(' ');
      if (parts.length === u.sentences.length || redaction.isRedacted(rejoined, u.ts)) {
        stats.redactedSentences += u.sentences.length;
        return null;
      }
    }
    const kept = u.sentences.filter(s => {
      const r = redaction.isRedacted(s, u.ts);
      if (r) stats.redactedSentences++;
      return !r;
    });
    return kept.length ? { ...u, sentences: kept, text: kept.join(' ') } : null;
  };

  // Whole history while it is small: every unit, oldest first, still redacted.
  const total = units.reduce((n, u) => n + u.text.length + (u.replyTo ? u.replyTo.length + 20 : 0) + 40, 0);
  if (o.allUnderChars > 0 && units.length && total <= o.allUnderChars) {
    stats.mode = 'all';
    const excerpts = [...units].sort(order).map(u => clean(u)).filter(Boolean).map(u => ({ ...u, why: 'all' }));
    stats.selected = excerpts.length;
    return { excerpts, stats };
  }
  if (!scored.length) return { excerpts: [], stats };
  const floor = scored[0].score * o.relativeFloor;

  const chosen = [];
  const seen = new Set();
  let used = 0;
  const admit = (u, why) => {
    if (seen.has(u.key)) return false;
    seen.add(u.key);
    const c = clean(u);
    if (!c) return false;
    const cost = c.text.length + (c.replyTo ? c.replyTo.length + 20 : 0) + 40;
    if (used + cost > o.maxChars && chosen.length) return false;
    chosen.push({ ...c, why });
    used += cost;
    return true;
  };

  for (const s of scored) {
    if (chosen.length >= o.k) break;
    if (s.score < floor) break;
    admit(s.unit, 'match');
  }
  stats.selected = chosen.length;

  // FOLLOW-UPS — the staleness guard. A later statement about the same thing
  // ("the ledger slipped… so the launch moved to December 9") often shares
  // the subject but not the question's words. A LATER unit sharing ≥2 salient
  // terms with a chosen one, or 1 plus a change marker, is admitted after it.
  if (o.followUps > 0 && chosen.length) {
    // idf > 0.5 ≈ the term is in fewer than ~60% of passages: specific enough
    // to say "same subject", and still meaningful on a short history.
    const salientOf = u => [...u.tf.keys()].filter(t => (idf.get(t) ?? 0) > 0.5).sort((a, b) => idf.get(b) - idf.get(a)).slice(0, 8);
    const queryTerms = new Set(tokens(query));
    const pending = [];
    for (const c of chosen) {
      const sal = salientOf(c);
      if (!sal.length) continue;
      for (const u of units) {
        if (seen.has(u.key) || (u.ts ?? 0) <= (c.ts ?? 0)) continue;
        const shared = sal.filter(t => u.tf.has(t));
        const change = CHANGE_MARKERS.test(u.text);
        // One shared word is enough only when it is the passage's own subject
        // (not a question word — that would already have matched) and the
        // later message announces a change.
        if (shared.length >= 2 || (change && shared.some(t => !queryTerms.has(t)))) pending.push({ u, shared: shared.length, change });
      }
    }
    pending.sort((a, b) => (b.change - a.change) || (b.shared - a.shared) || (b.u.ts ?? 0) - (a.u.ts ?? 0));
    for (const p of pending) {
      if (stats.followUps >= o.followUps) break;
      if (admit(p.u, 'follow-up')) stats.followUps++;
    }
  }

  return { excerpts: chosen.sort(order), stats };
}

// ── World Model annotation + rendering ─────────────────────────────────────

const norm = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Attach "since changed" notes from the World Model to the excerpts they quote. Pure. */
export function annotate(excerpts, notes = []) {
  if (!notes.length) return excerpts;
  const prepared = notes.map(n => ({ ...n, q: (n.quotes ?? []).map(norm).filter(q => q.length >= 8) })).filter(n => n.q.length);
  return excerpts.map(e => {
    const text = norm(e.text);
    const changes = [];
    for (const n of prepared) {
      if (changes.length >= 2) break;
      if (!n.q.some(q => text.includes(q))) continue;
      const now = String(n.now).trim();
      if (!now || text.includes(norm(now)) || changes.includes(now)) continue;
      changes.push(now);
    }
    return changes.length ? { ...e, changes } : e;
  });
}

const iso = ts => (Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : 'undated');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The prompt block. Empty string when there is nothing to quote. */
export function formatRecall(excerpts, { currentConversationId = null } = {}) {
  if (!excerpts.length) return '';
  const lines = excerpts.map(e => {
    const where = e.source === 'file'
      ? `file "${clip(e.fileName ?? 'a file', 60)}" they uploaded`
      : e.conversationId === currentConversationId
        ? 'earlier in this conversation'
        : (e.title ? `"${clip(e.title, 48)}"` : 'another conversation');
    const reply = e.replyTo ? ` (replying to you: "${clip(e.replyTo, 100)}")` : '';
    const changed = (e.changes ?? []).map(c => `\n   ↳ since changed — now: "${clip(c, 200)}"`).join('');
    return `[${iso(e.ts)} · ${where}]${reply} ${e.text}${changed}`;
  });
  const said = excerpts.filter(e => e.source !== 'file');
  const all = said.length > 0 && said.every(e => e.why === 'all');
  const files = excerpts.some(e => e.source === 'file');
  const scope = all
    ? 'everything they said in earlier conversations, except what they asked you to forget'
    : 'only excerpts that match this message';
  return [
    `WHAT THE USER TOLD YOU BEFORE (their own words${files ? ', and lines from files they uploaded (marked file)' : ''}, verbatim, oldest first; ${scope}):`,
    ...lines,
    'Reading these: a newer statement about the same thing replaces an older one, and a "since changed" note is the current state. '
      + 'Corrections or deletions the user made in their Memory override these excerpts. '
      + (all ? '' : 'Not finding something here does not mean the user never said it.'),
  ].join('\n').trimEnd();
}

/**
 * One call for a chat turn. `notesFor(ownerId)` (optional, async) supplies the
 * World Model's supersession notes; it is only consulted when something was
 * selected. Never throws — recall failing must never fail a turn.
 */
/**
 * The forget list plus the turn's sensitive-category policy (memory/sensitivity.js):
 * a health or mood sentence is quoted only when the policy allows that kind
 * this turn. Without a policy every sensitive sentence is withheld.
 */
export function recallRedaction(base, sensitive = null) {
  return {
    isRedacted(text, ts) {
      if (base.isRedacted(text, ts)) return true;
      const kind = classifyText(text);
      return !!kind && !sensitive?.allows?.(kind);
    },
  };
}

export async function recallForTurn({ ownerId, userId = null, conversationId = null, query, excludeFromIndex = Infinity, notesFor = null, conversations,
  includeFiles = true, attachmentsFor, fileOpts = {}, sensitive = null, ...opts } = {}) {
  const t0 = Date.now();
  try {
    if (!ownerId || !String(query ?? '').trim()) return { block: '', excerpts: [], stats: { skipped: 'no-owner-or-query' } };
    const units = collectUnits({ userId, conversationId, excludeFromIndex, includeFiles,
      ...(conversations ? { conversations } : {}), ...(attachmentsFor ? { attachmentsFor } : {}) });
    const allChars = Number.parseInt(process.env.AQUA_RECALL_ALL_CHARS ?? '', 10);
    const redaction = recallRedaction(redactionsFor(ownerId), sensitive);
    const said = selectRecall(units.filter(u => u.source !== 'file'), query, {
      redaction,
      ...(Number.isFinite(allChars) && allChars >= 0 ? { allUnderChars: allChars } : {}),
      ...opts,
    });
    const fileUnits = units.filter(u => u.source === 'file');
    const filed = fileUnits.length
      ? selectRecall(fileUnits, query, { redaction, ...FILE_DEFAULTS, ...fileOpts })
      : { excerpts: [], stats: { candidates: 0, selected: 0, mode: 'none', redactedSentences: 0 } };
    const excerpts = [...said.excerpts, ...filed.excerpts].sort(order);
    const stats = { ...said.stats, files: { candidates: filed.stats.candidates, selected: filed.stats.selected, mode: filed.stats.mode },
      redactedSentences: said.stats.redactedSentences + (filed.stats.redactedSentences ?? 0) };
    let annotated = excerpts;
    if (excerpts.length && typeof notesFor === 'function') {
      try { annotated = annotate(excerpts, await notesFor(ownerId)); stats.annotated = annotated.filter(e => e.changes).length; }
      catch (err) { stats.notesError = String(err?.message ?? err).slice(0, 120); }
    }
    return {
      block: formatRecall(annotated, { currentConversationId: conversationId }),
      excerpts: annotated,
      stats: { ...stats, ms: Date.now() - t0 },
    };
  } catch (err) {
    console.warn(`[RECALL] failed open owner=${ownerId}: ${err?.message ?? err}`);
    return { block: '', excerpts: [], stats: { error: String(err?.message ?? err).slice(0, 120), ms: Date.now() - t0 } };
  }
}

/** Tests only. */
export function __clearCacheForTests() { cache.clear(); fileCache.clear(); }
