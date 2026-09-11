/**
 * AQUA Memory Reasoner — Memory 5.1 (spec: Reasoning Over Memory)
 * ─────────────────────────────────────────────────────────────────────────────
 * Deterministic reasoning across the MEMORY layer's stores — facts (with
 * revision history), episodes, goals, working memory, the relationship graph
 * and the mind timeline. The evidence layer already has its own reasoning
 * surface (reasoning/queryEngine.js: contradictionsFor, whatHappenedBefore,
 * connectionsBetween…); this module gives the conversational memory layer
 * the same power, and every finding is evidence-backed: fact keys, revision
 * timestamps, episode ids — never a bare claim.
 *
 *   findContradictions   values that flipped or were contested, with priors
 *   detectTrends         topic momentum + fact churn + recurring work
 *   findGaps             missing identity, open questions, stale goals,
 *                        low-confidence (unverified) facts
 *   compareDecisions     episodes-with-outcomes matching a query, in order
 *   whatChanged          merged change feed: timeline events + fact revisions
 *                        + new facts ("What changed?" / "since when?")
 *   reasonOverMemory     one entry: classifies the question, dispatches,
 *                        returns { mode, findings, evidence, confidence }
 *
 * Pure reads (peekMind — never creates an owner), zero deps, zero model
 * calls, every public function fail-open to a neutral value. House style:
 * this can never sink a route or a prompt.
 */
import { peekMind } from '../mind/mindStore.js';
import { getFacts } from './longTermMemory.js';
import { getIdentity, IDENTITY_FIELDS } from './identity.js';

const DAY = 24 * 3600 * 1000;
const STALE_GOAL_MS = 14 * DAY;
const RECENT_WORK_MS = 30 * DAY;
const LOW_CONF = 0.6;

// ── helpers ──────────────────────────────────────────────────────────────────
function tokenize(q) {
  return String(q || '').toLowerCase().match(/[a-z0-9_.-]{3,}/g) || [];
}
function itemText(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  return String(x.text ?? x.label ?? x.title ?? '');
}
function goalLabel(g) { return itemText(g) || String(g?.id ?? ''); }
function goalLastAt(g) {
  const h = Array.isArray(g?.history) ? g.history[g.history.length - 1]?.at : null;
  return g?.updatedAt || h || g?.createdAt || 0;
}
function clampConf(n) { return Math.max(0.3, Math.min(0.9, n)); }

// ── Contradictions ───────────────────────────────────────────────────────────
/**
 * Facts whose value has been contested or has flipped. A "contradiction" here
 * is the fact layer's own bookkeeping (contradictions counter) plus any
 * revision whose recorded value differs from the current one. Each finding
 * carries the prior values with timestamps and reasons — the receipts.
 */
export function findContradictions(ownerId, { limit = 10 } = {}) {
  try {
    const facts = getFacts(ownerId);
    const out = [];
    for (const f of facts) {
      const history = Array.isArray(f.history) ? f.history : [];
      const priors = history
        .filter(h => String(h.normalizedValue ?? h.value) !== String(f.normalizedValue ?? f.value))
        .map(h => ({ value: h.value, at: h.supersededAt || h.ts, reason: h.reason || null }));
      if (!(f.contradictions > 0) && !priors.length) continue;
      out.push({
        key: f.key, current: f.value,
        confidence: f.confidence, contradictions: f.contradictions || 0,
        priorValues: priors.slice(-5),
        evidence: { factKey: f.key, revisions: history.length, lastChangedAt: f.updatedAt },
      });
    }
    out.sort((a, b) => (b.contradictions - a.contradictions) || (a.confidence - b.confidence));
    return out.slice(0, limit);
  } catch (err) {
    console.warn('[MEMREASON] findContradictions failed (non-fatal):', err.message);
    return [];
  }
}

// ── Trends ───────────────────────────────────────────────────────────────────
/**
 * Three deterministic trend signals:
 *   momentum      what the owner keeps touching — working-memory focus plus
 *                 the heaviest graph nodes (weight = repeated mention)
 *   churn         facts that keep changing (revision >= 3) — instability is
 *                 itself a signal worth surfacing
 *   recurringWork episode themes recurring in the last 30 days
 */
export function detectTrends(ownerId, { limit = 8, now = Date.now() } = {}) {
  const neutral = { momentum: [], churn: [], recurringWork: [] };
  try {
    const mind = peekMind(ownerId);
    if (!mind) return neutral;

    const momentum = [];
    for (const f of mind.working?.focus || []) {
      momentum.push({ topic: f.topic, weight: +(f.weight || 0).toFixed(2), source: 'working', lastSeenAt: f.lastSeenAt || null });
    }
    for (const n of Object.values(mind.graph?.nodes || {})) {
      if (n.key === 'self' || (n.weight || 0) < 3) continue;
      momentum.push({ topic: n.label, type: n.type, weight: n.weight, source: 'graph' });
    }
    momentum.sort((a, b) => b.weight - a.weight);

    const churn = getFacts(ownerId)
      .filter(f => (f.revision || 1) >= 3)
      .map(f => ({ key: f.key, revisions: f.revision, current: f.value, lastChangedAt: f.updatedAt }))
      .sort((a, b) => b.revisions - a.revisions);

    const byTheme = new Map();
    for (const e of Object.values(mind.episodes || {})) {
      if ((e.startedAt || 0) < now - RECENT_WORK_MS) continue;
      const theme = String(e.theme || e.title || '').toLowerCase();
      if (!theme) continue;
      const cur = byTheme.get(theme) || { theme: e.theme || e.title, count: 0, episodeIds: [] };
      cur.count += 1;
      cur.episodeIds.push(e.id);
      byTheme.set(theme, cur);
    }
    const recurringWork = [...byTheme.values()].filter(t => t.count >= 2).sort((a, b) => b.count - a.count);

    return {
      momentum: momentum.slice(0, limit),
      churn: churn.slice(0, limit),
      recurringWork: recurringWork.slice(0, limit),
    };
  } catch (err) {
    console.warn('[MEMREASON] detectTrends failed (non-fatal):', err.message);
    return neutral;
  }
}

// ── Gaps ─────────────────────────────────────────────────────────────────────
/** What the system knows it does NOT know — identify missing information. */
export function findGaps(ownerId, { now = Date.now() } = {}) {
  const neutral = { identityMissing: [], openQuestions: [], staleGoals: [], unverifiedFacts: [] };
  try {
    const mind = peekMind(ownerId);

    // Only the high-value core — reporting "birthday missing" for every
    // owner is noise, not a gap. getIdentity() keys by canonical name.
    const CORE = new Set(['name', 'role', 'company', 'city']);
    let identityMissing = [];
    try {
      const identity = getIdentity(ownerId) || {};
      identityMissing = IDENTITY_FIELDS
        .filter(f => CORE.has(f.canonical) && !identity[f.canonical])
        .map(f => f.canonical);
    } catch { /* identity lane fails open */ }

    const openQuestions = (mind?.working?.openQuestions || []).map(itemText).filter(Boolean);

    const staleGoals = Object.values(mind?.goals || {})
      .filter(g => (g.status === 'active' || g.status === 'blocked') && goalLastAt(g) < now - STALE_GOAL_MS)
      .map(g => ({ id: g.id ?? null, goal: goalLabel(g), status: g.status, lastTouchedAt: goalLastAt(g) }));

    const unverifiedFacts = getFacts(ownerId)
      .filter(f => (f.confidence ?? 1) < LOW_CONF)
      .sort((a, b) => (a.confidence ?? 1) - (b.confidence ?? 1))
      .slice(0, 5)
      .map(f => ({ key: f.key, value: f.value, confidence: f.confidence, supportCount: f.supportCount || 1 }));

    return { identityMissing, openQuestions, staleGoals, unverifiedFacts };
  } catch (err) {
    console.warn('[MEMREASON] findGaps failed (non-fatal):', err.message);
    return neutral;
  }
}

// ── Decision comparison ──────────────────────────────────────────────────────
/**
 * Compare historical decisions: closed episodes with an OUTCOME that match
 * the query's tokens, chronological. Two or more matches also yield a
 * contrast line (earliest vs latest outcome) — the "did we change course?"
 * answer, backed by episode ids.
 */
export function compareDecisions(ownerId, query = '', { limit = 5 } = {}) {
  const neutral = { decisions: [], contrast: null };
  try {
    const mind = peekMind(ownerId);
    if (!mind) return neutral;
    const qTokens = tokenize(query);
    const eps = Object.values(mind.episodes || {}).filter(e => e.outcome);
    const matched = (qTokens.length
      ? eps.filter(e => {
          const hay = `${e.title || ''} ${e.theme || ''} ${e.outcome || ''} ${(e.lessons || []).join(' ')}`.toLowerCase();
          return qTokens.some(t => hay.includes(t));
        })
      : eps
    ).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0)).slice(-limit);

    const decisions = matched.map(e => ({
      id: e.id, title: e.title, status: e.status,
      outcome: e.outcome, lessons: e.lessons || [],
      startedAt: e.startedAt || null, endedAt: e.endedAt || null,
    }));
    let contrast = null;
    if (decisions.length >= 2) {
      const first = decisions[0];
      const last = decisions[decisions.length - 1];
      contrast = {
        earliest: { id: first.id, title: first.title, outcome: first.outcome },
        latest: { id: last.id, title: last.title, outcome: last.outcome },
        changed: String(first.outcome) !== String(last.outcome),
      };
    }
    return { decisions, contrast };
  } catch (err) {
    console.warn('[MEMREASON] compareDecisions failed (non-fatal):', err.message);
    return neutral;
  }
}

// ── Change feed ──────────────────────────────────────────────────────────────
/**
 * "What changed?" — one chronological feed merging:
 *   • mind timeline events (belief flips, goal changes, episode open/close)
 *   • fact revisions (each superseded value, with its reason)
 *   • newly created facts
 * Includes archived facts so merge/split/archive edits show up as changes.
 */
export function whatChanged(ownerId, { sinceMs = 7 * DAY, limit = 20, now = Date.now() } = {}) {
  try {
    const since = now - sinceMs;
    const events = [];

    const mind = peekMind(ownerId);
    for (const e of mind?.timeline || []) {
      const at = e.at || e.ts || 0;
      if (at < since) continue;
      events.push({ at, kind: e.type || 'event', label: itemText(e) || e.summary || e.type || 'event', importance: e.importance ?? null });
    }

    for (const f of getFacts(ownerId, { includeArchived: true })) {
      for (const h of Array.isArray(f.history) ? f.history : []) {
        const at = h.supersededAt || h.ts || 0;
        if (at < since) continue;
        events.push({
          at, kind: 'fact_change',
          label: `${f.key}: was "${h.value}"${h.reason ? ` (${h.reason})` : ''}`,
          evidence: { factKey: f.key, revision: h.revision ?? null },
        });
      }
      if ((f.createdAt || 0) >= since) {
        events.push({ at: f.createdAt, kind: 'fact_new', label: `${f.key} = "${f.value}"`, evidence: { factKey: f.key } });
      }
    }

    events.sort((a, b) => b.at - a.at);
    return events.slice(0, limit);
  } catch (err) {
    console.warn('[MEMREASON] whatChanged failed (non-fatal):', err.message);
    return [];
  }
}

// ── One entry point ──────────────────────────────────────────────────────────
const MODE_RES = [
  ['contradictions', /\b(contradict\w*|conflict\w*|inconsisten\w*|disagree\w*|doesn'?t match)\b/i],
  ['changes',        /\b(what changed|changed|recent(ly)?\s+(update|change)\w*|since (yesterday|last))\b/i],
  ['decisions',      /\b(decid\w*|decision\w*|chose|choice\w*|why did we|outcome\w*)\b/i],
  ['trends',         /\b(trend\w*|pattern\w*|momentum|lately|keep (working|coming back)|focus)\b/i],
  ['gaps',           /\b(gap\w*|missing|don'?t know|unknown|need to (know|learn)|unverified)\b/i],
];

/**
 * Classify the question, dispatch, and return an evidence-backed answer:
 * { mode, findings, evidence, confidence, generatedAt }. Confidence scales
 * with how much evidence backs the findings — an empty result is an honest
 * 0.3, never a confident guess.
 */
export function reasonOverMemory(ownerId, question = '', opts = {}) {
  const generatedAt = Date.now();
  try {
    let mode = opts.mode || null;
    if (!mode) {
      for (const [m, re] of MODE_RES) { if (re.test(question)) { mode = m; break; } }
    }
    mode = mode || 'overview';

    let findings; let evidenceCount = 0;
    switch (mode) {
      case 'contradictions': {
        findings = findContradictions(ownerId);
        evidenceCount = findings.length;
        break;
      }
      case 'changes': {
        findings = whatChanged(ownerId, opts);
        evidenceCount = findings.length;
        break;
      }
      case 'decisions': {
        findings = compareDecisions(ownerId, question, opts);
        evidenceCount = findings.decisions.length;
        break;
      }
      case 'trends': {
        findings = detectTrends(ownerId, opts);
        evidenceCount = findings.momentum.length + findings.churn.length + findings.recurringWork.length;
        break;
      }
      case 'gaps': {
        findings = findGaps(ownerId, opts);
        evidenceCount = findings.openQuestions.length + findings.staleGoals.length + findings.unverifiedFacts.length;
        break;
      }
      default: {
        const contradictions = findContradictions(ownerId, { limit: 3 });
        const trends = detectTrends(ownerId, { limit: 5 });
        const gaps = findGaps(ownerId);
        findings = { contradictions, trends, gaps };
        evidenceCount = contradictions.length + trends.momentum.length + gaps.openQuestions.length;
      }
    }
    return {
      mode, findings,
      evidence: { items: evidenceCount },
      confidence: clampConf(0.3 + 0.1 * Math.min(6, evidenceCount)),
      generatedAt,
    };
  } catch (err) {
    console.warn('[MEMREASON] reasonOverMemory failed (non-fatal):', err.message);
    return { mode: 'error', findings: null, evidence: { items: 0 }, confidence: 0.3, generatedAt };
  }
}
