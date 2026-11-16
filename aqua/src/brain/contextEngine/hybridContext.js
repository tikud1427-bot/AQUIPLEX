/**
 * AQUA — Hybrid Context V1 (Sprint 6, 2026-11-11)
 * ─────────────────────────────────────────────────────────────────────────────
 * Design: AQUA_HYBRID_CONTEXT_ARCHITECTURE.md (Sprint 5). Implementation notes:
 * AQUA_HYBRID_CONTEXT_V1_IMPLEMENTATION.md.
 *
 * The existing pipeline's context (A) is KEPT, byte for byte. The information-
 * needs engine (V2) runs beside it and may ADD, after it, a bounded block of:
 *   · conflict notes        two of the user's statements disagree
 *   · change notes          an earlier statement was superseded by a later one
 *   · ended facts           a stored value the user's later words ended
 *   · ambiguity notes       one name, several people
 *   · verified unknowns     an essential need that NEITHER V2 NOR A's context holds
 *   · not-matched notes     an essential need V2 did not find but A's context may
 *                           hold in other words ("not retrieved" ≠ "unknown")
 *   · additional evidence   the user's own statements for a need, matched STRONGLY,
 *                           that A's context does not already show
 *   · one clarifying question, only for a verified gap, a conflict or an ambiguity
 *
 * Never: removes or edits A's context; declares unknown what A's context holds;
 * adds a weak match; exceeds its token budget; uses a result that ran over its
 * time budget. Pure: no store, no network, no model. Deterministic.
 *
 * Gate: AQUA_HYBRID_CONTEXT = off (default) | shadow (compute + log counts,
 * prompt unchanged) | on (append the block). Settings: AQUA_HYBRID_MAX_TOKENS,
 * AQUA_HYBRID_MAX_MS, AQUA_HYBRID_MAX_SENTENCES.
 */
import { needMatchScore } from './informationNeeds.js';
import { estimateTokens } from '../../core/tokenManager.js';

export function hybridContextMode(env = process.env) {
  const v = String(env.AQUA_HYBRID_CONTEXT ?? '').toLowerCase();
  return v === 'on' ? 'on' : v === 'shadow' ? 'shadow' : 'off';
}

const int = (v, d, lo, hi) => { const n = Number.parseInt(String(v ?? ''), 10); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
/** Budgets. Defaults are the Sprint 5 design values; out-of-range values fall back to them. */
export function hybridSettings(env = process.env) {
  return {
    maxTokens: int(env.AQUA_HYBRID_MAX_TOKENS, 400, 50, 4000),
    maxMs: int(env.AQUA_HYBRID_MAX_MS, 50, 5, 5000),
    maxSentences: int(env.AQUA_HYBRID_MAX_SENTENCES, 4000, 100, 100000),
  };
}

// ── What the existing context (A) already shows ─────────────────────────────

const norm = s => String(s ?? '').toLowerCase().replace(/[“”"']/g, '').replace(/\s+/g, ' ').trim();

/**
 * The user-content lines of A's context: profile/fact lines ("- key: value"),
 * quoted excerpts ("[date · …] text"), knowledge items. Headers and instruction
 * prose are excluded so boilerplate words ("goals", "memory") never count as
 * evidence that a need is covered.
 */
export function contentLines(aContext) {
  const text = [aContext?.memoryBlock, aContext?.knowledgeContext, aContext?.recallBlock].filter(Boolean).join('\n');
  const out = [];
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l || /^---/.test(l) || /^<<<|^>>>/.test(l)) continue;
    const quote = l.match(/^\[[^\]]{4,80}\]\s*(.+)$/);           // [2026-11-10 · another conversation] text
    if (quote) { out.push(quote[1]); continue; }
    const item = l.match(/^[-•*]\s+(.+)$/);                       // - Role: Nurse Manager
    if (item) { out.push(item[1]); continue; }
    if (/^[A-Z][\w ]{1,40}:\s+\S/.test(l) && l.length < 300) out.push(l);   // Current state: …
  }
  return out;
}

function presence(aContext) {
  const lines = contentLines(aContext);
  const all = norm(lines.join('\n'));
  return {
    lines,
    /** Is this statement (or fact value) already shown to the model? */
    has(c) {
      const t = norm(c.kind === 'fact' ? c.value : c.text);
      if (!t) return false;
      if (c.kind === 'fact') return t.length >= 3 && all.includes(t);
      return all.includes(t) || (t.length > 40 && all.includes(t.slice(0, 40)));
    },
    /** Does A's context hold something that satisfies this need, by V2's own matching rules? */
    covers(need) { return lines.some(l => needMatchScore(need, l) > 0); },
  };
}

// ── Strength ─────────────────────────────────────────────────────────────────

/** A contribution is strong when its match is unambiguous (Sprint 5 design §4.2). Thresholds: dev-set hypotheses. */
export function isStrong(c, need, score) {
  if (c.kind === 'fact') return (score ?? 0) >= 1.5 && !c.hedged;          // ≥1 term on a structured fact (fact bonus 0.5)
  if (need?.entity && new RegExp(`\\b${need.entity}\\b`, 'i').test(c.text)) return (score ?? 0) >= 1;
  // Situation needs match by ONE life-domain word by design ("I earn 39k…" for a job decision);
  // they count when the statement is the user's own first-person situation, not someone else's.
  // and is SPECIFIC — a figure, a proper name, or a second matching term — so "I earn 39k at
  // Nordwell" counts and "I have a lot of work this week" does not.
  if (need?.kind === 'situation') {
    if (!((score ?? 0) >= 1 && /\b(?:i|i'm|i've|my|we|we're|our)\b/i.test(c.text))) return false;
    // About a family member or friend, not the user ("My brother Teo is training to be a pilot"):
    // not the user's situation. Work relations ("my manager…") describe the user's job and count.
    if (/^\W*(?:my|our)\s+(?:brother|sister|sibling|mum|mom|mother|dad|father|parents?|son|daughter|kids?|children|cousin|aunt|uncle|friend|neighbou?r|partner|wife|husband|girlfriend|boyfriend|nephew|niece|grand\w+)\b/i.test(c.text)
      && !/\b(?:i|i'm|i've|we|we're)\b/i.test(c.text)) return false;
    const specific = /\d/.test(c.text) || /\s[A-Z][a-z]{2,}/.test(String(c.text).replace(/^\S+\s*/, ' ').replace(/\bI\b/g, ''));
    return specific || (score ?? 0) >= 2;
  }
  return (score ?? 0) >= 2;                                                 // ≥2 terms, or a term + a phrase/figure
}

// ── Contribution ─────────────────────────────────────────────────────────────

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const iso = ts => (Number.isFinite(ts) && ts ? new Date(ts).toISOString().slice(0, 10) : 'undated');
const empty = (reason, extra = {}) => ({ block: '', items: [], summary: { reason, added: 0, dup: 0, weak: 0, conflicts: 0, changes: 0, ended: 0, ambiguous: 0, unknownsDeclared: 0, notMatched: 0, notRetrieved: 0, question: 0, tokens: 0, trimmed: 0, ...extra } });

/**
 * Decide what V2 adds to A's context. Inputs: the V2 analysis (analyseInformationNeeds)
 * and A's three context strings. Returns { block, items, summary }; `summary` is
 * content-free (counts and labels only) and is what the route logs.
 */
export function hybridContribution({ v2, aContext = {}, maxTokens = 400, maxMs = 50 } = {}) {
  if (!v2) return empty('no-analysis');
  const ms = v2.summary?.ms ?? 0;
  if (ms > maxMs) return empty('over-time', { v2ms: ms });
  if (v2.understanding?.intent === 'general') return empty('general');
  if (!v2.applied) {
    // V2 found nothing it could use. That is "not retrieved", never "unknown": A stands alone.
    const notRetrieved = (v2.needs ?? []).filter(r => r.need?.essential && r.status === 'missing').length;
    return empty(v2.reason ?? 'not-applied', { notRetrieved });
  }
  const present = presence(aContext);
  const items = [];
  const counts = { dup: 0, weak: 0, notRetrieved: 0 };
  const seen = new Set();
  const add = (kind, priority, line, key = line) => { if (seen.has(key)) return; seen.add(key); items.push({ kind, priority, line }); };

  for (const r of v2.needs ?? []) {
    const n = r.need ?? {};
    if (r.status === 'contradictory' && r.conflict?.length === 2) {
      const [a, b] = r.conflict;
      add('conflict', 1, `- Conflict (${n.label}): "${clip(a.text, 110)}" (${iso(a.ts)}) vs "${clip(b.text, 110)}" (${iso(b.ts)}) — neither is marked as a change; do not pick one silently.`, `conflict:${a.key}:${b.key}`);
    }
    if (r.status === 'ambiguous' && r.ambiguous) {
      // Same wording as the engine's own rendering (informationNeeds.renderNeeds): an ambiguity is an unknown.
      add('ambiguous', 2, `- Not known: which ${r.ambiguous.name} is meant (ambiguous) — the user knows ${r.ambiguous.candidates.join(' and ')}.`, `amb:${r.ambiguous.name}`);
    }
    for (const c of [...(r.evidence ?? []), ...(r.outdated ?? [])]) {
      if (c?.outdatedBy) add('change', 1, `- Since changed: "${clip(c.text, 100)}" (${iso(c.ts)}) → now: "${clip(c.outdatedBy.text, 110)}" (${iso(c.outdatedBy.ts)}).`, `change:${c.key}`);
    }
    for (const f of r.ended ?? []) {
      const shown = present.has(f);
      add('ended', 1, `- No longer current${shown ? ' (the profile line above is outdated)' : ''}: ${f.label}: ${clip(f.value, 80)}${f.ended?.text ? ` — they later said: "${clip(f.ended.text, 110)}"` : ''}.`, `ended:${f.key}`);
    }
    if (r.status === 'forgotten') {
      add('forgotten', 1, `- Not known: ${n.label} — the user asked Aqua to forget this. Do not use or reconstruct it.`, `forgot:${n.id}`);
    }
    if (n.essential && r.status === 'missing') {
      // Distinguish "not retrieved" from "unknown": V2's matching is lexical, so a need
      // V2 did not find may still be in A's context in other words.
      if (present.covers(n)) add('not-matched', 3, `- Not matched by the needs check: ${n.label} — it may be stated above in other words; check before saying it is unknown.`, `nm:${n.id}`);
      else add('unknown', 2, `- Not known: ${n.label} — neither the user's history nor the context above states it. Do not guess it.`, `unk:${n.id}`);
    }
    // Additional evidence: strong, the user's own, not already shown.
    const scores = r.scores ?? new Map();
    for (const c of [...(r.facts ?? []), ...(r.evidence ?? [])]) {
      if (!c || c.outdatedBy) continue;                                  // outdated ones travel as change notes
      if (present.has(c)) { counts.dup++; continue; }
      if (!isStrong(c, n, scores.get(c.key))) { counts.weak++; continue; }
      const line = c.kind === 'fact'
        ? `- ${c.label}: ${clip(c.value, 100)} (user-stated${c.ts ? `, ${iso(c.ts)}` : ''})`
        : `[${iso(c.ts)} · ${c.kind === 'file' ? `file "${clip(c.fileName ?? 'upload', 40)}"` : 'they said'}] ${clip(c.text, 300)}`;
      add('evidence', 4 + (1 / (1 + (scores.get(c.key) ?? 0))), line, `ev:${c.key}`);
    }
  }

  // One clarifying question — only for a verified gap, a conflict or an ambiguity.
  const conflict = items.find(i => i.kind === 'conflict');
  const amb = items.find(i => i.kind === 'ambiguous');
  const unknownNeed = (v2.needs ?? []).find(r => r.need?.essential && r.status === 'missing' && !present.covers(r.need));
  let question = null;
  if (amb) question = (v2.needs.find(r => r.status === 'ambiguous') && `Which ${v2.needs.find(r => r.status === 'ambiguous').ambiguous.name} do you mean — ${v2.needs.find(r => r.status === 'ambiguous').ambiguous.candidates.join(' or ')}?`);
  else if (conflict) { const r = v2.needs.find(x => x.status === 'contradictory'); question = `Which is right: "${clip(r.conflict[0].text, 70)}" or "${clip(r.conflict[1].text, 70)}"?`; }
  else if (unknownNeed) question = unknownNeed.need.ask ?? `Could you tell me ${String(unknownNeed.need.label).replace(/\s*\(.*\)$/, '')}?`;

  if (!items.length) return empty('nothing-to-add', { dup: counts.dup, weak: counts.weak });
  return render(items, question, maxTokens, counts);
}

const HEAD = '--- NEEDS CHECK (added after the context above; it does not replace it) ---';
const FOOT = '--- END NEEDS CHECK ---';
const EVIDENCE_HEAD = 'Also relevant, in the user\'s own words (not shown above):';

function render(items, question, maxTokens, counts) {
  const sorted = [...items].sort((a, b) => a.priority - b.priority);
  const kept = [];
  const fixed = estimateTokens(`${HEAD}\n${FOOT}\n${EVIDENCE_HEAD}\n${question ? `If you need to ask, ask only this: "${question}"` : ''}`);
  let used = fixed;
  let trimmed = 0;
  for (const it of sorted) {
    const t = estimateTokens(it.line);
    if (used + t > maxTokens) { trimmed++; continue; }
    kept.push(it); used += t;
  }
  if (!kept.length) return empty('over-budget', { trimmed, dup: counts.dup, weak: counts.weak });
  const notes = kept.filter(i => i.kind !== 'evidence').map(i => i.line);
  const evidence = kept.filter(i => i.kind === 'evidence').map(i => i.line);
  const keptQuestion = question && kept.some(i => ['conflict', 'ambiguous', 'unknown'].includes(i.kind)) ? question : null;
  const lines = [HEAD, ...notes];
  if (evidence.length) lines.push(EVIDENCE_HEAD, ...evidence);
  if (keptQuestion) lines.push(`If you need to ask, ask only this: "${keptQuestion}"`);
  lines.push(FOOT);
  const block = lines.join('\n');
  const n = k => kept.filter(i => i.kind === k).length;
  return {
    block, items: kept,
    summary: {
      reason: '-', added: n('evidence'), dup: counts.dup, weak: counts.weak, conflicts: n('conflict'), changes: n('change'),
      ended: n('ended'), ambiguous: n('ambiguous'), unknownsDeclared: n('unknown'), notMatched: n('not-matched'),
      notRetrieved: counts.notRetrieved, question: keptQuestion ? 1 : 0, tokens: estimateTokens(block), trimmed,
    },
  };
}

/** One content-free log line (route). */
export function hybridSummaryLine(mode, s) {
  return `mode=${mode} reason=${s.reason} added=${s.added} dup=${s.dup} weak=${s.weak} conflicts=${s.conflicts} changes=${s.changes} ended=${s.ended} ambiguous=${s.ambiguous} unknowns=${s.unknownsDeclared} not_matched=${s.notMatched} not_retrieved=${s.notRetrieved} question=${s.question} tokens=${s.tokens} trimmed=${s.trimmed}`;
}
