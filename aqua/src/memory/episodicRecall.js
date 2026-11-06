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
import { UNCERTAIN_RULE } from './displayLabels.js';
import { rankHybrid, semanticRecallEnabled, semanticScores, indexRecallUnits, startQueryVector, SEMANTIC_DEFAULTS } from './semanticRecall.js';
import { getAttachments } from '../upload/attachmentStore.js';
import { stem, tokens, transitionOf, strongContinuation } from '../understanding/stateTransition.js';
import { followUpV2Enabled, selectFollowUpsV2 } from './followUpRelevance.js';
import { withheldBy, policyKey } from './retrievalPrivacy.js';

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
// The tokenizer and the transition grammar live in understanding/stateTransition.js
// (shared with the evidence lane and conversational fact ingest).
export { stem, tokens };

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

/** Characters the whole history would take in the prompt — the same count selectRecall uses for its window. */
export function historyChars(units) {
  return units.reduce((n, u) => n + u.text.length + (u.replyTo ? u.replyTo.length + 20 : 0) + 40, 0);
}

const order = (a, b) => (a.ts ?? 0) - (b.ts ?? 0) || (a.conversationId === b.conversationId ? a.msgIndex - b.msgIndex : (a.key < b.key ? -1 : 1));

// ── forgotten text never ranks (2026-11-05, privacy) ─────────────────────────
// Quoting always dropped forgotten sentences, but RANKING and FOLLOW-UPS read
// the raw passage: a forgotten sentence could match the question and pull its
// surviving sibling into the prompt ("We changed the bank appointment to
// Wednesday. Also the car needs new tyres." → "Also the car needs new tyres."
// quoted for a bank question), or tie a follow-up through words only it held.
// So both run on the passages as the owner's forget list leaves them: a
// forgotten sentence contributes no keyword, name, identifier, transition or
// term statistic. Exactly the forget list (recallRedactions.js, or the caller's
// matcher) — not the turn's sensitivity policy, which still applies when quoting.
const forgetCache = new WeakMap();   // unit → { stamp, unit|null, removed }

function forgetCleanUnit(u, forget) {
  if (forget.stamp) {
    const hit = forgetCache.get(u);
    if (hit && hit.stamp === forget.stamp) return hit;
  }
  let out = { unit: u, removed: 0 };
  // A passage none of whose words is forgotten has no forgotten sentence either
  // (every sentence's word runs are runs of the passage; forget-all is by time).
  if (forget.isRedacted(u.text, u.ts)) {
    const kept = u.sentences.filter(s => !forget.isRedacted(s, u.ts));
    const text = kept.join(' ');
    const toks = kept.length && kept.length < u.sentences.length && !forget.isRedacted(text, u.ts) ? tokens(text) : [];
    out = toks.length
      ? { unit: { ...u, sentences: kept, text, toks, tf: termFreq(toks) }, removed: u.sentences.length - kept.length }
      : { unit: null, removed: u.sentences.length };
  }
  if (forget.stamp) forgetCache.set(u, { stamp: forget.stamp, ...out });
  return out;
}

/**
 * The candidate pool with forgotten text removed; inactive forget lists cost nothing.
 * `changed`: keys of passages that LOST a sentence (still in the pool, text shorter).
 */
export function forgetClean(units, forget) {
  if (!forget || forget.active === false) return { pool: units, removed: 0, changed: new Set() };
  const pool = [];
  const changed = new Set();
  let removed = 0;
  for (const u of units) {
    const r = forgetCleanUnit(u, forget);
    removed += r.removed;
    if (r.unit) { pool.push(r.unit); if (r.unit !== u) changed.add(u.key); }
  }
  return { pool, removed, changed };
}

// ── policy-withheld text never ranks either (2026-11-06, privacy) ─────────────
// A sentence the turn's sensitive policy withholds (health / mood, unless the
// user opted in AND this turn is about that kind — sensitivity.js, unchanged)
// contributes no keyword, name, identifier, transition, follow-up link or term
// statistic. Classified SENTENCE BY SENTENCE (retrievalPrivacy.js): a passage is
// never classified as a whole, so a mixed passage keeps its eligible sentences
// and a sibling's product framing never makes a health sentence eligible.
// Withheld is not forgotten: nothing is written to the forget list, and the
// same sentence is rankable on a turn whose policy allows it. Cached per unit
// and per policy (which kinds are allowed), never across a change of either.
const withholdCache = new WeakMap();   // unit → Map<policyKey, { unit|null, removed }>

/** The pool with policy-withheld sentences removed. `key` identifies the policy (policyKey). */
export function withholdClean(units, withhold, key = null) {
  if (typeof withhold !== 'function') return { pool: units, removed: 0 };
  const pool = [];
  let removed = 0;
  for (const u of units) {
    let byKey = key ? withholdCache.get(u) : null;
    let r = byKey?.get(key);
    if (!r) {
      const kept = u.sentences.filter(s => !withhold(s));
      if (kept.length === u.sentences.length) r = { unit: u, removed: 0 };
      else {
        const text = kept.join(' ');
        const toks = kept.length ? tokens(text) : [];
        r = toks.length ? { unit: { ...u, sentences: kept, text, toks, tf: termFreq(toks) }, removed: u.sentences.length - kept.length }
          : { unit: null, removed: u.sentences.length };
      }
      if (key) { if (!byKey) { byKey = new Map(); withholdCache.set(u, byKey); } byKey.set(key, r); }
    }
    removed += r.removed;
    if (r.unit) pool.push(r.unit);
  }
  return { pool, removed };
}

/**
 * Choose what to quote (pure apart from the injected redaction matcher).
 * Returns the excerpts in chronological order plus counters.
 *   redaction  what may be QUOTED (forget list + the turn's sensitivity policy)
 *   forget     what was FORGOTTEN — removed before ranking and follow-ups
 *              (defaults to `redaction` for callers that pass one matcher)
 */
export function selectRecall(units, query, { redaction = { isRedacted: () => false }, forget = null, withhold = null, withholdKey = null, ...opts } = {}) {
  const o = { ...RECALL_DEFAULTS, ...opts };
  const stats = { candidates: units.length, matched: 0, selected: 0, followUps: 0, redactedSentences: 0, mode: 'ranked' };
  // Ranking pool: forgotten sentences out, then policy-withheld ones (counted apart).
  const { pool: unforgotten, removed: forgottenSentences, changed: changedByForget } = forgetClean(units, forget ?? redaction);
  const { pool, removed: withheldSentences } = withholdClean(unforgotten, withhold, withholdKey);
  stats.forgottenSentences = forgottenSentences;
  stats.withheldSentences = withheldSentences;
  const { scored, idf } = scoreUnits(pool, query);
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
  stats.redactedSentences += forgottenSentences + withheldSentences;
  // A passage that lost a sentence to the forget list may still carry a vector
  // made from its FULL text (indexed before the forget; the index pass that
  // replaces it runs after this turn): its meaning score is not used — the
  // keyword path still sees what is left of it. (Withheld sentences are never
  // embedded at all — semanticRecall.js — so their passages keep their scores.)
  let semanticMap = o.semantic instanceof Map ? o.semantic : null;
  if (semanticMap && changedByForget.size) semanticMap = new Map([...semanticMap].filter(([k]) => !changedByForget.has(k)));
  // HYBRID (semanticRecall.js, AQUA_SEMANTIC_RECALL): keyword + meaning + recency.
  // Only when passage vectors scored; otherwise the keyword path below, unchanged.
  const hybrid = semanticMap && semanticMap.size ? rankHybrid(pool, query, semanticMap, { scored }) : null;
  if (hybrid) {
    stats.mode = 'hybrid';
    stats.matched = hybrid.length;
    stats.semanticOnly = 0;
  }
  const ranking = hybrid ?? scored.map(s => ({ ...s, why: 'match' }));
  if (!ranking.length) return { excerpts: [], stats };
  const floor = ranking[0].score * o.relativeFloor;

  const chosen = [];
  const seen = new Set();
  let used = 0;
  const seenText = new Set();   // hybrid only: one quote per sentence said more than once
  const admit = (u, why, extra = null) => {
    if (seen.has(u.key)) return false;
    seen.add(u.key);
    if (hybrid) {
      const t = u.text.toLowerCase().replace(/\s+/g, ' ').trim();
      if (seenText.has(t)) return false;
      seenText.add(t);
    }
    const c = clean(u);
    if (!c) return false;
    const cost = c.text.length + (c.replyTo ? c.replyTo.length + 20 : 0) + 40;
    if (used + cost > o.maxChars && chosen.length) return false;
    chosen.push({ ...c, why, ...(extra ?? {}) });
    used += cost;
    return true;
  };

  for (const s of ranking) {
    if (chosen.length >= o.k) break;
    if (s.score < floor) break;
    if (admit(s.unit, s.why) && s.why === 'semantic') stats.semanticOnly++;
  }
  stats.selected = chosen.length;

  // FOLLOW-UPS — the staleness guard. A later statement about the same thing
  // ("the ledger slipped… so the launch moved to December 9") often shares
  // the subject but not the question's words. A LATER unit sharing ≥2 salient
  // terms with a chosen one, or 1 plus a transition marker, is admitted after it.
  if (o.followUps > 0 && chosen.length && followUpV2Enabled()) {
    // V2 (followUpRelevance.js, AQUA_RECALL_FOLLOWUP_V2): same thing + a state
    // relation, stricter from passages chosen on meaning alone. Evidence comes
    // only from what would be quoted (forget list AND sensitivity policy).
    stats.followUpMode = 'v2';
    const quoted = new Map();   // per call: a candidate is examined from several parents
    const quoteText = u => {
      if (quoted.has(u.key)) return quoted.get(u.key);
      let out = null;
      const whole = redaction.isRedacted(u.text, u.ts);
      const parts = whole ? u.sentences.filter(s => !redaction.isRedacted(s, u.ts)) : null;
      if (!whole || (parts.length < u.sentences.length && !redaction.isRedacted(parts.join(' '), u.ts))) {
        const kept = u.sentences.filter(s => !redaction.isRedacted(s, u.ts));
        out = kept.length ? kept.join(' ') : null;
      }
      quoted.set(u.key, out);
      return out;
    };
    stats.followUps = selectFollowUpsV2({
      chosen: [...chosen], pool, idf, anchoredKeys: new Set(scored.map(s => s.unit.key)), budget: o.followUps,
      admit: (u, extra) => admit(u, 'follow-up', extra), quoteText, isSeen: key => seen.has(key),
    });
  } else if (o.followUps > 0 && chosen.length) {
    // idf > 0.5 ≈ the term is in fewer than ~60% of passages: specific enough
    // to say "same subject", and still meaningful on a short history.
    const salientOf = u => [...u.tf.keys()].filter(t => (idf.get(t) ?? 0) > 0.5).sort((a, b) => idf.get(b) - idf.get(a)).slice(0, 8);
    const queryTerms = new Set(tokens(query));
    // Passages that matched the question but fell under the relative floor.
    const matchedQuery = new Set(scored.map(s => s.unit.key));
    const followUpsOf = c => {
      const pending = [];
      const sal = salientOf(c);
      if (!sal.length) return pending;
      const chosenTr = transitionOf(c.text);
      for (const u of pool) {
        if (seen.has(u.key) || (u.ts ?? 0) <= (c.ts ?? 0)) continue;
        const shared = sal.filter(t => u.tf.has(t));
        const tr = transitionOf(u.text);
        // One shared word is enough only when it is the passage's own subject
        // (not a question word — that would already have matched) and the
        // later message announces a transition. Or when the later message DID
        // match the question and lost only to the relative floor: "Shipping
        // slips to April 20" shares one word, "ship", with "When does the
        // first batch ship?" and with "We plan to ship the first batch on
        // March 3", which matched three (dev set, 2026-11-02).
        const ownSubject = shared.some(t => !queryTerms.has(t));
        if (shared.length >= 2 || (tr.marked && (ownSubject || (shared.length && matchedQuery.has(u.key))))) {
          // RESOLUTION FIRST (2026-11-02). "The zoning permit came through"
          // shares one word with "the opening is blocked by a zoning permit"
          // and no change word, so it lost its slot to any later line with a
          // bare "now" ("flat tire fixes went from 30 to 40 now"). A later
          // statement that closes or re-reports the open state a chosen
          // passage describes, or corrects it, is the one a staleness guard
          // exists for (understanding/stateTransition.js strongContinuation).
          const resolves = ownSubject && strongContinuation(tr, chosenTr) ? 1 : 0;
          // A follow-up tied only through a question word is the fallback: it
          // ranks after every follow-up that shares the passage's own subject.
          const own = ownSubject || shared.length >= 2 ? 1 : 0;
          pending.push({ u, shared: shared.length, change: tr.marked ? 1 : 0, resolves, own });
        }
      }
      return pending;
    };
    const rank = (a, b) => (b.resolves - a.resolves) || (b.own - a.own) || (b.change - a.change) || (b.shared - a.shared) || (b.u.ts ?? 0) - (a.u.ts ?? 0);
    // CHAINED (2026-11-02): an admitted follow-up's own later word competes
    // for the remaining slots. A history runs plan → blocker → resolution;
    // when the question matches only the plan, the blocker arrives as a
    // follow-up and its resolution ("the cabinets arrived, but now the
    // electrician is the bottleneck") was unreachable. Same cap.
    const pending = chosen.flatMap(followUpsOf);
    while (stats.followUps < o.followUps && pending.length) {
      pending.sort(rank);
      const p = pending.shift();
      if (seen.has(p.u.key)) continue;
      if (admit(p.u, 'follow-up')) { stats.followUps++; pending.push(...followUpsOf(p.u)); }
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
    const uncertain = [];
    for (const n of prepared) {
      if (!n.q.some(q => text.includes(q))) continue;
      const now = String(n.now).trim();
      if (!now || text.includes(norm(now))) continue;
      // Uncertainty notes (uncertaintyNotes in memory/engine.js): the quoted record may be
      // affected by a change, not replaced by it — kept apart from "since changed".
      if (n.kind === 'uncertain' || n.kind === 'target_reached') {
        if (uncertain.length < 2 && !uncertain.some(u => u.text === now)) uncertain.push({ kind: n.kind, text: now });
        continue;
      }
      if (changes.length >= 2 || changes.includes(now)) continue;
      changes.push(now);
    }
    // A since-changed note is the stronger statement: it supersedes an uncertainty note on the same quote.
    const keep = changes.length ? [] : uncertain;
    return changes.length || keep.length ? { ...e, ...(changes.length ? { changes } : {}), ...(keep.length ? { uncertain: keep } : {}) } : e;
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
    const unsure = (e.uncertain ?? []).map(u => u.kind === 'target_reached'
      ? `\n   ↳ may already be achieved — they later said: "${clip(u.text, 200)}"; not confirmed`
      : `\n   ↳ uncertain whether still current — they later said: "${clip(u.text, 200)}"`).join('');
    return `[${iso(e.ts)} · ${where}]${reply} ${e.text}${changed}${unsure}`;
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
    'Reading these: a newer statement about the same thing replaces an older one, and a "since changed" note is the current state; '
      + `${UNCERTAIN_RULE} `
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
  // Sentence by sentence (retrievalPrivacy.js): a text is withheld when ANY of its
  // sentences is — never because its sentences only combine into a match, and
  // never let through because a sibling's framing cancels one (2026-11-06).
  const withheld = withheldBy(sensitive);
  return {
    isRedacted(text, ts) {
      if (base.isRedacted(text, ts)) return true;
      return sentencesOf(text).some(withheld);
    },
  };
}

/**
 * The whole-history window recall uses this turn (AQUA_RECALL_ALL_CHARS or the default).
 */
function recallWindow() {
  const allChars = Number.parseInt(process.env.AQUA_RECALL_ALL_CHARS ?? '', 10);
  return Number.isFinite(allChars) && allChars >= 0 ? allChars : RECALL_DEFAULTS.allUnderChars;
}

/**
 * Called at the TOP of a chat turn (routes/chat.js prepareTurn): start the query
 * vector semantic recall will need, so its round trip overlaps the turn's other
 * work. Only when recall is certain to rank — the user's OTHER conversations
 * (a lower bound of what recall will see) already exceed the window — so a turn
 * never makes an embedding call it would not have made. Returns a promise that
 * resolves to a vector or null, or null when nothing was started. Never throws.
 */
export function startRecallQueryVector({ userId = null, conversationId = null, query, conversations } = {}) {
  try {
    if (!semanticRecallEnabled() || !String(query ?? '').trim()) return null;
    // excludeFromIndex 0 drops every message of the current conversation: a lower bound.
    const others = collectUnits({ userId, conversationId, excludeFromIndex: 0, includeFiles: false, ...(conversations ? { conversations } : {}) });
    return startQueryVector(query, { historyLowerBound: historyChars(others), window: recallWindow() });
  } catch { return null; }
}

export async function recallForTurn({ ownerId, userId = null, conversationId = null, query, excludeFromIndex = Infinity, notesFor = null, conversations,
  includeFiles = true, attachmentsFor, fileOpts = {}, sensitive = null, queryVector = undefined, ...opts } = {}) {
  const t0 = Date.now();
  try {
    if (!ownerId || !String(query ?? '').trim()) return { block: '', excerpts: [], stats: { skipped: 'no-owner-or-query' } };
    const units = collectUnits({ userId, conversationId, excludeFromIndex, includeFiles,
      ...(conversations ? { conversations } : {}), ...(attachmentsFor ? { attachmentsFor } : {}) });
    const allChars = Number.parseInt(process.env.AQUA_RECALL_ALL_CHARS ?? '', 10);
    // forgotten = the owner's forget list only (removed before ranking and follow-ups);
    // redaction = what may be quoted (forget list + this turn's sensitivity policy).
    // withhold = the policy-withheld sentences, also removed before ranking (counted apart).
    const forgotten = redactionsFor(ownerId);
    const redaction = recallRedaction(forgotten, sensitive);
    const withhold = withheldBy(sensitive);
    const withholdKey = policyKey(sensitive);
    const saidUnits = units.filter(u => u.source !== 'file');
    // SEMANTIC (semanticRecall.js): only when the history is past the whole-history
    // window (below it everything is quoted anyway). Indexing is fire-and-forget,
    // over every passage of the owner (not the windowed list, which would churn).
    let semantic = null;
    const semStats = {};
    const { semanticTimeoutMs, ...selectOpts } = opts;
    if (semanticRecallEnabled()) {
      const window = Number.isFinite(allChars) && allChars >= 0 ? allChars : (selectOpts.allUnderChars ?? RECALL_DEFAULTS.allUnderChars);
      const total = historyChars(saidUnits);
      // An early query vector (startRecallQueryVector) is reused, never re-requested.
      if (!(window > 0 && total <= window)) semantic = await semanticScores(ownerId, saidUnits, query, { timeoutMs: semanticTimeoutMs, stats: semStats, ...(queryVector ? { queryVector } : {}) });
      if (window === 0 || total >= window * SEMANTIC_DEFAULTS.indexFromFraction) {
        const everything = collectUnits({ userId, conversationId, excludeFromIndex: Infinity, includeFiles: false, ...(conversations ? { conversations } : {}) });
        // The index applies the owner's forget list itself and never embeds a
        // sensitive sentence whatever the policy (semanticRecall.js).
        indexRecallUnits(ownerId, everything).then(r => { if (r.embedded || r.pruned) console.log(`[RECALL] semantic index owner=${ownerId} embedded=${r.embedded} pruned=${r.pruned} pending=${Math.max(0, r.missing - r.embedded)}`); }).catch(() => {});
      }
    }
    const said = selectRecall(saidUnits, query, {
      redaction,
      forget: forgotten, withhold, withholdKey,
      ...(Number.isFinite(allChars) && allChars >= 0 ? { allUnderChars: allChars } : {}),
      ...selectOpts,
      semantic,
    });
    const fileUnits = units.filter(u => u.source === 'file');
    const filed = fileUnits.length
      ? selectRecall(fileUnits, query, { redaction, forget: forgotten, withhold, withholdKey, ...FILE_DEFAULTS, ...fileOpts })
      : { excerpts: [], stats: { candidates: 0, selected: 0, mode: 'none', redactedSentences: 0 } };
    const excerpts = [...said.excerpts, ...filed.excerpts].sort(order);
    const stats = { ...said.stats, files: { candidates: filed.stats.candidates, selected: filed.stats.selected, mode: filed.stats.mode },
      redactedSentences: said.stats.redactedSentences + (filed.stats.redactedSentences ?? 0),
      ...(Object.keys(semStats).length ? { semantic: semStats } : {}) };
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
