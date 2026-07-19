/**
 * AQUA Event + Timeline Engine — Cross-File Reasoning (Phase 3)
 *
 * Two cooperating pure modules:
 *
 * EVENT EXTRACTION — normalized events from grounded Facts. A fact whose
 * statement matches an event pattern ("contract signed", "invoice paid",
 * "meeting started", "email sent", "deployed", …) becomes an Event with a
 * type, the entities it involves, an (optional) timestamp lifted from the
 * fact's evidence location, and — always — the evidence that supports it.
 * Events never appear without provenance (the reasoning contract).
 *
 * TIMELINE ENGINE — merges events + dated facts across EVERY file into one
 * ordered sequence, and supports UNCERTAINTY: events with a real timestamp
 * anchor the order; events without one are placed probabilistically by
 * textual/causal cues ("before", "after", "then") relative to anchors, and
 * flagged { certainty: 'exact' | 'approximate' | 'relative' | 'unknown' }.
 * We never fabricate a precise time we don't have.
 *
 * Pure: no I/O, no model. A model-based event/temporal extractor plugs in
 * behind extractEvents()/buildTimeline() later.
 */
import { formatTimestamp } from '../files/evidence.js';

// ── Event patterns (extensible) ───────────────────────────────────────────────

const EVENT_PATTERNS = [
  ['contract_signed',   /\b(contract|agreement|deal|mou)\b.*\b(sign(ed|ing)?|execut(ed|ion)|finali[sz]ed)\b|\b(sign(ed|ing)?|execut(ed|ion))\b.*\b(contract|agreement|deal)\b/i],
  ['funding',           /\b(raised|secured|closed|received)\b.*\b(funding|round|investment|capital|seed|series [a-e])\b|\b(funding|investment)\b.*\b(raised|closed|announced)\b/i],
  ['invoice_paid',      /\b(invoice|payment|bill|amount)\b.*\b(paid|settled|cleared|received|recorded|made|processed)\b|\bpaid\b.*\b(invoice|₹|\$|€)\b|\bpayment of\b/i],
  ['meeting',           /\b(meeting|call|standup|review|sync|interview)\b.*\b(start(ed|s)?|held|began|scheduled|recorded)\b|\b(met|discussed)\b/i],
  ['email_sent',        /\b(email|mail|message)\b.*\b(sent|received|replied|forwarded)\b/i],
  ['deployment',        /\b(deploy(ed|ment)?|release[d]?|shipped|launched|rolled out)\b/i],
  ['repo_update',       /\b(commit(ted)?|merged|pushed|pull request|pr)\b/i],
  ['capture',           /\b(photo|image|picture|video|recording)\b.*\b(taken|captured|recorded|shot)\b/i],
  ['approval',          /\b(approv(ed|al)|authori[sz]ed|granted|accepted)\b/i],
  ['creation',          /\b(created|founded|established|opened|started|built)\b/i],
];

/**
 * @param {object} store - evidenceStore (for hydrating evidence)
 * @param {string} ownerId
 * @param {Array} facts - grounded facts (from evidenceStore.factsForFile / listFacts)
 * @returns {Array} events [{ id, type, statement, entities, timestamp, timestampSeconds, certainty, evidence:[id], sourceFiles:[ukoId], confidence }]
 */
export function extractEvents(store, ownerId, facts) {
  const events = [];
  for (const fact of facts) {
    const type = classifyEvent(fact.statement);
    if (!type) continue;
    const evidence = store.evidenceForFact(ownerId, fact.id);
    const ts = firstTimestamp(evidence, fact.statement);
    events.push({
      id: `evt:${fact.id}`,
      type,
      statement: fact.statement,
      entities: fact.entities ?? [],
      timestamp: ts.display,
      timestampSeconds: ts.seconds,
      certainty: ts.seconds != null ? 'exact' : relativeCue(fact.statement),
      evidence: fact.evidence,
      sourceFiles: [...new Set(evidence.map(e => e.sourceFileId))],
      confidence: fact.confidence,
      factId: fact.id,
    });
  }
  return events;
}

function classifyEvent(statement) {
  for (const [type, re] of EVENT_PATTERNS) if (re.test(statement)) return type;
  return null;
}

function firstTimestamp(evidence, statement = '') {
  for (const e of evidence) {
    const ts = e.location?.timestamp;
    if (ts != null) return { display: formatTimestamp(ts), seconds: toSeconds(ts) };
  }
  // Dated documents carry the date in the TEXT, not the evidence location —
  // mine the statement and any evidence snippet for an explicit date.
  for (const text of [statement, ...evidence.map(e => e.snippet ?? '')]) {
    const d = parseDate(text);
    if (d != null) return { display: new Date(d).toISOString().slice(0, 10), seconds: d / 1000 };
  }
  return { display: null, seconds: null };
}

function relativeCue(statement) {
  return /\b(before|after|then|following|subsequently|prior to|once)\b/i.test(statement) ? 'relative' : 'unknown';
}

// ── Timeline construction with uncertainty ───────────────────────────────────

/**
 * Merge events into one ordered timeline. Anchored (exact) events sort by
 * time; unanchored events are appended in a stable "relative/unknown" tail,
 * each retaining its certainty flag. The ordering is explainable: every
 * entry keeps its evidence + sourceFiles.
 *
 * @returns {{ ordered: Array, anchored: number, unanchored: number }}
 */
export function buildTimeline(events, { extraDatedFacts = [] } = {}) {
  const anchored = [];
  const floating = [];

  for (const e of [...events, ...extraDatedFacts]) {
    if (e.timestampSeconds != null) anchored.push(e); else floating.push(e);
  }
  anchored.sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  // Probabilistic placement of floating events: a "before X"/"after X" cue
  // that names an anchored event's entity nudges it adjacent to that anchor;
  // otherwise it lands in the unknown tail. We annotate, we don't invent times.
  const ordered = [...anchored];
  for (const f of floating) {
    const anchorIdx = placeRelative(f, anchored);
    const entry = { ...f, position: anchorIdx == null ? 'unordered' : (f.certainty === 'relative' ? 'relative' : 'approximate') };
    if (anchorIdx == null) ordered.push(entry);
    else ordered.splice(anchorIdx, 0, entry);
  }

  return {
    ordered: ordered.map((e, i) => ({ order: i, ...e })),
    anchored: anchored.length,
    unanchored: floating.length,
  };
}

function placeRelative(floating, anchored) {
  if (!anchored.length) return null;
  const m = floating.statement?.match(/\b(before|after|prior to|following)\b\s+(.+)/i);
  if (!m) return null;
  const ref = m[2].toLowerCase();
  const idx = anchored.findIndex(a => a.entities?.some(e => ref.includes(String(e).toLowerCase())) || ref.includes(a.type.replace('_', ' ')));
  if (idx < 0) return null;
  return /before|prior/i.test(m[1]) ? idx : idx + 1;
}

// ── date/time helpers ─────────────────────────────────────────────────────────

function toSeconds(ts) {
  if (typeof ts === 'number') return ts;
  const p = String(ts).split(':').map(Number);
  if (p.some(Number.isNaN)) return null;
  return p.reduce((a, n) => a * 60 + n, 0);
}

function parseDate(text) {
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) { const t = Date.parse(iso[0]); return Number.isNaN(t) ? null : t; }
  const named = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/);
  if (named) { const t = Date.parse(named[0]); return Number.isNaN(t) ? null : t; }
  return null;
}

export const _eventPatterns = EVENT_PATTERNS.map(([t]) => t);
