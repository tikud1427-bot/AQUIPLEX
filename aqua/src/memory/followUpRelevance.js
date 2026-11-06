/**
 * AQUA — follow-up relevance v2 (2026-11-05). Pure, deterministic, no LLM, no
 * vectors, no network. Used by episodicRecall.js selectRecall when
 * AQUA_RECALL_FOLLOWUP_V2=on (default off; the legacy follow-up step runs otherwise).
 *
 * WHY. A follow-up is a LATER statement quoted beside a chosen one because it
 * continues it ("the launch moved to December 9"). The legacy step admitted any
 * later passage sharing one salient word plus any change word, from any chosen
 * passage. The independent semantic-recall run (v2, 2026-11-05) showed both
 * failure modes: "The sales tax rules … changed" followed a sales-hire goal
 * through the one word "sales", and passages admitted on meaning alone (often
 * wrongly) seeded chains. Cosine cannot separate these (a legitimate follow-up
 * sat at the question's median cosine, an irrelevant chained one above it), so
 * this model uses no cosine at all.
 *
 * THE MODEL. A later statement L is admitted after a chosen statement P only
 * when it is evidently about the SAME THING and continues its STATE:
 *
 *   LINK  E2  ≥2 shared names, or a shared identifier ("10k", "qb-2291")
 *         E1  one shared name
 *         C2  ≥2 shared specific words (idf > 0.5, the legacy salience cut)
 *         C1  one shared specific word
 *     A name is capitalised in BOTH statements and not sentence-initial in at
 *     least one; months, weekdays, ordinals and plain numbers never link.
 *   RELATION (of L to P; stateTransition.js grammar, unchanged vocabulary)
 *     correction > closure > update > revalue > decision > change > speculative > mention
 *     closure / update / decision need P to be OPEN: pending, an intention,
 *     speculative, or a dated plan not yet closed. A speculative L is only ever
 *     'speculative' (hedged): a hedge never closes or changes a state.
 *   ADMISSION
 *     E2  any relation                        (meaning-only seed: any)
 *     E1  all but mention                     (meaning-only seed: correction, closure, update, revalue, decision)
 *     C2  correction, closure, update, revalue, change, speculative   (meaning-only: correction, closure)
 *     C1  correction, closure, update, revalue                        (meaning-only: correction, closure)
 *   One shared word plus a change word is therefore never enough.
 *
 * SEEDS. Anchored = matched the question by keyword (or descends from one):
 * chains to depth 2, at most 2 follow-ups per root. Meaning-only = admitted by
 * the semantic ranking alone: depth 1, at most 1. Total cap = the caller's
 * followUps. Priority: anchored roots first, then relation, then link, then the
 * later statement. Nothing is superseded or hidden: follow-ups are quoted BESIDE
 * their parent, in date order, by the caller.
 *
 * PRIVACY. The caller passes passages already cleaned of forgotten text, and
 * `quoteText(u)` — the text that would actually be quoted (forget list AND the
 * turn's sensitivity policy). Link and relation evidence come only from that
 * text, so a withheld sentence can never tie a follow-up.
 */
import { tokens, transitionOf, closeKind, changeKind, corrects, speculative, intends, datesIn, sentencesIn } from '../understanding/stateTransition.js';

export function followUpV2Enabled(env = process.env) {
  return String(env.AQUA_RECALL_FOLLOWUP_V2 ?? '').toLowerCase() === 'on';
}

export const RELATION_ORDER = Object.freeze(['correction', 'closure', 'update', 'revalue', 'decision', 'change', 'speculative', 'mention']);
const LINK_ORDER = ['E2', 'E1', 'C2', 'C1'];
const ALLOWED = {
  anchored: { E2: RELATION_ORDER, E1: RELATION_ORDER.filter(r => r !== 'mention'),
    C2: ['correction', 'closure', 'update', 'revalue', 'change', 'speculative'], C1: ['correction', 'closure', 'update', 'revalue'] },
  meaning: { E2: RELATION_ORDER, E1: ['correction', 'closure', 'update', 'revalue', 'decision'],
    C2: ['correction', 'closure'], C1: ['correction', 'closure'] },
};
export const FOLLOWUP_V2_LIMITS = Object.freeze({ anchored: { depth: 2, perRoot: 2 }, meaning: { depth: 1, perRoot: 1 } });

// Date words never say what two statements are about ("March", "Fridays", "today").
const DATE_WORDS = new Set(tokens(['january february march april may june july august september october november december',
  'jan feb mar apr jun jul aug sep sept oct nov dec monday tuesday wednesday thursday friday saturday sunday',
  'mondays tuesdays wednesdays thursdays fridays saturdays sundays today tomorrow tonight yesterday'].join(' ')));
const ORDINAL = /^\d+(?:st|nd|rd|th)$/;
const NUMBERISH = /^(?:\d+(?:st|nd|rd|th|am|pm|s)?)$/;
const RELATIVE_FUTURE = /\b(?:next\s+(?:week|month|year|quarter|spring|summer|autumn|fall|winter|weekend)|tomorrow|tonight|soon|later\s+this\s+(?:week|month|year)|this\s+(?:week|month|quarter|year|weekend|spring|summer|autumn|fall|winter))\b/i;
const MONEY = /[$€£]\s?\d|\b\d[\d,.]*\s?(?:k|m|bn)?\s?(?:dollars|euros|pounds|usd|eur|gbp)\b/i;
const CLOCK = /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/i;

/** Features of one statement's text (memoised per call). */
function featuresOf(text, memo) {
  const hit = memo.get(text);
  if (hit) return hit;
  const capAny = new Set();
  const capNonInitial = new Set();
  for (const sentence of sentencesIn(text)) {
    let i = 0;
    for (const m of sentence.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu)) {
      const t = tokens(m[0])[0];
      if (t && !DATE_WORDS.has(t) && !NUMBERISH.test(t) && /^\p{Lu}/u.test(m[0])) { capAny.add(t); if (i > 0) capNonInitial.add(t); }
      i++;
    }
  }
  const ids = new Set();
  for (const m of String(text).matchAll(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu)) {
    const w = m[0].toLowerCase();
    if (/\p{L}/u.test(w) && /\p{N}/u.test(w) && !ORDINAL.test(w) && !NUMBERISH.test(w)) ids.add(w);
  }
  const tr = transitionOf(text);
  const f = {
    toks: new Set(tokens(text)), capAny, capNonInitial, ids,
    spec: speculative(text), intends: intends(text), pending: tr.pending, stillOpen: tr.stillOpen,
    close: closeKind(text), change: changeKind(text), corrects: corrects(text),
    dated: datesIn(text).length > 0, relFuture: RELATIVE_FUTURE.test(text), money: MONEY.test(text), clock: CLOCK.test(text),
    question: /\?\s*$/.test(String(text).trim()),
  };
  memo.set(text, f);
  return f;
}

const isOpen = p => p.pending || p.intends || p.spec || ((p.dated || p.relFuture) && !p.close);

/** Every relation L stands in to P, strongest first. */
export function relationsOf(p, l) {
  if (l.spec) return ['speculative'];
  const open = isOpen(p);
  const out = [];
  if (l.corrects) out.push('correction');
  if (l.close && open) out.push('closure');
  if (open && (l.pending || l.stillOpen)) out.push('update');
  if (l.change === 'changed' && ((p.dated && l.dated) || (p.money && l.money) || (p.clock && l.clock))) out.push('revalue');
  if (open && !l.intends && !l.pending && !l.question) out.push('decision');
  if (l.change) out.push('change');
  out.push('mention');
  return out;
}

/** The links between P and L, strongest first, plus what they share (diagnostics). */
export function linksOf(p, l, idf) {
  const names = [...p.capAny].filter(t => l.capAny.has(t) && (p.capNonInitial.has(t) || l.capNonInitial.has(t)));
  const ids = [...p.ids].filter(t => l.ids.has(t));
  const words = [...p.toks].filter(t => l.toks.has(t) && (idf.get(t) ?? 0) > 0.5 && !DATE_WORDS.has(t) && !NUMBERISH.test(t));
  const links = [];
  if (names.length >= 2 || ids.length) links.push('E2'); else if (names.length === 1) links.push('E1');
  if (words.length >= 2) links.push('C2'); else if (words.length === 1) links.push('C1');
  return { links, names, ids, words };
}

/** Decide one candidate: { relation, link, hedged } or null. */
export function decideFollowUp(parentText, laterText, { idf, anchored, memo = new Map() }) {
  const p = featuresOf(parentText, memo);
  const l = featuresOf(laterText, memo);
  const { links } = linksOf(p, l, idf);
  if (!links.length) return null;
  const table = ALLOWED[anchored ? 'anchored' : 'meaning'];
  const rels = relationsOf(p, l);
  for (const relation of RELATION_ORDER) {
    if (!rels.includes(relation)) continue;
    const link = links.find(k => table[k].includes(relation));
    if (link) return { relation, link, hedged: l.spec };
  }
  return null;
}

/**
 * Choose follow-ups for the already chosen excerpts. Calls `admit(unit, extra)`
 * (the caller's budget / redaction / dedupe gate) and returns how many it admitted.
 *   chosen     excerpts chosen by ranking (cleaned), each { key, ts, text }
 *   pool       candidate passages, forgotten text already removed
 *   idf        Map term → idf over `pool`
 *   anchoredKeys  keys of passages that matched the question by keyword
 *   quoteText  unit → the text that would be quoted, or null when nothing would be
 *   isSeen     key → already quoted or tried
 */
export function selectFollowUpsV2({ chosen, pool, idf, anchoredKeys, budget, admit, quoteText, isSeen }) {
  if (!(budget > 0) || !chosen.length) return 0;
  const memo = new Map();
  const used = new Map();
  const pending = [];
  const expand = node => {
    const lim = FOLLOWUP_V2_LIMITS[node.anchored ? 'anchored' : 'meaning'];
    if (node.depth >= lim.depth) return;
    // Exact pre-filter: a link needs a shared specific word, name or identifier
    // part, so a candidate holding none of the node's is skipped before any
    // feature extraction (which is the cost: regexes per candidate).
    const nf = featuresOf(node.text, memo);
    const linkable = [...new Set([...[...nf.toks].filter(t => (idf.get(t) ?? 0) > 0.5 && !DATE_WORDS.has(t) && !NUMBERISH.test(t)),
      ...nf.capAny, ...[...nf.ids].flatMap(id => tokens(id.replace(/-/g, ' ')))])];
    if (!linkable.length) return;
    for (const u of pool) {
      if ((u.ts ?? 0) <= (node.ts ?? 0) || isSeen(u.key)) continue;
      if (!linkable.some(t => u.tf.has(t))) continue;
      const text = quoteText(u);
      if (!text) continue;
      const d = decideFollowUp(node.text, text, { idf, anchored: node.anchored, memo });
      if (d) pending.push({ u, text, root: node.root, anchored: node.anchored, depth: node.depth + 1, ...d });
    }
  };
  for (const c of chosen) expand({ text: c.text, ts: c.ts, root: c.key, anchored: anchoredKeys.has(c.key), depth: 0 });
  const rank = (a, b) => (b.anchored - a.anchored) || (RELATION_ORDER.indexOf(a.relation) - RELATION_ORDER.indexOf(b.relation))
    || (LINK_ORDER.indexOf(a.link) - LINK_ORDER.indexOf(b.link)) || ((b.u.ts ?? 0) - (a.u.ts ?? 0));
  let admitted = 0;
  while (admitted < budget && pending.length) {
    pending.sort(rank);
    const p = pending.shift();
    if (isSeen(p.u.key)) continue;
    const cap = FOLLOWUP_V2_LIMITS[p.anchored ? 'anchored' : 'meaning'].perRoot;
    if ((used.get(p.root) ?? 0) >= cap) continue;
    if (!admit(p.u, { relation: p.relation, link: p.link, hedged: p.hedged })) continue;
    admitted++;
    used.set(p.root, (used.get(p.root) ?? 0) + 1);
    expand({ text: p.text, ts: p.u.ts, root: p.root, anchored: p.anchored, depth: p.depth });
  }
  return admitted;
}
