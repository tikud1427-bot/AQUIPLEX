/**
 * The Understanding page's view of a Mind (2026-10-28).
 *
 * GET /mind used to hand the page raw state: intent ids as "Current focus"
 * ("simple_qa, personal_info"), predictions and timeline titles built from
 * them, LaTeX tokens as knowledge domains, a goal as the user's profession,
 * and health/mood beliefs. The producers are fixed for NEW data
 * (predictionEngine, episodeTracker, fileBridge, memorySchema); this applies the
 * same rules to what production already stores, at the one route that serves
 * the page. The rule throughout (L11): nothing human to say → not shown.
 */
import { intentLabel, cleanInternalTitle, isAspirationalRole, mentionsInternalIntent } from '../memory/displayLabels.js';
import { classifySensitivity } from '../memory/sensitivity.js';
import { isRealDomain, domainLabel } from '../understanding/domainTopics.js';

const ROLE_KEYS = new Set(['profession', 'role', 'job_title']);
const INTERNAL_SIGNAL = /^(?:task|fact|tech|domain|note|source|signal|attached|bridge)[:_]|^[a-z]+_[a-z_]+$|=/i;

/** What actually supports a belief, in words — or null (the card then shows no line). */
export function evidenceText(belief) {
  const ev = Array.isArray(belief?.evidence) ? belief.evidence.filter(e => e?.support !== false) : [];
  if (!ev.length) return null;
  const stated = ev.filter(e => e.explicit).length;
  if (stated) return stated === 1 ? 'You said this.' : `You said this ${stated} times.`;
  // "extracted fact: project" names the extractor's slot, not the evidence:
  // what it means is that the user said it.
  const told = ev.filter(e => /^extracted fact\b/i.test(String(e.signal ?? ''))).length;
  if (told) return told === 1 ? 'From something you told Aqua.' : `From ${told} things you told Aqua.`;
  const latest = [...ev].reverse().map(e => String(e.signal ?? '').trim()).find(s => s && !INTERNAL_SIGNAL.test(s) && !mentionsInternalIntent(s));
  const n = ev.length;
  const count = `${n} observation${n === 1 ? '' : 's'}`;
  return latest ? `From ${count} — latest: ${latest}.` : `Inferred from ${count}.`;
}

/** One evidence row in words. Observer notes are the engine's ("task:simple_qa",
 *  "extracted fact: custom_x"); those become what they mean, or a plain line. */
function evidenceLine(e) {
  if (e?.correction) return 'You corrected this';
  if (e?.explicit) return 'You said this';
  const s = String(e?.signal ?? '').replace(/^reflection insight:\s*/i, '').trim();
  if (/^extracted fact\b/i.test(s)) return 'Something you told Aqua';
  if (/^user said this is not theirs$/i.test(s)) return 'You said this isn’t yours';
  if (/^user pushed back\b/i.test(s)) return 'You pushed back on an answer';
  if (!s || INTERNAL_SIGNAL.test(s) || mentionsInternalIntent(s) || classifySensitivity(s)) return 'Seen in a conversation';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * GET /mind/beliefs/:dim/:key — "Why Aqua believes this" (2026-10-28).
 * explainBelief() is the engine's account: "Strongest signals: task:simple_qa;
 * extracted fact: custom_…" and "Previously believed: {json}". The drawer
 * printed it verbatim. Same shape, said in words.
 */
export function presentExplanation(belief) {
  if (!belief) return null;
  const ev = Array.isArray(belief.evidence) ? belief.evidence : [];
  const corrected = belief.privacy?.source === 'correction';
  const parts = [corrected ? 'You set this yourself.' : (evidenceText(belief) ?? 'Nothing Aqua recorded still supports this.')];
  const convs = new Set(ev.map(e => e?.conversationId).filter(Boolean)).size;
  if (convs > 1) parts.push(`Seen across ${convs} conversations.`);
  const n = Number(belief.contradictions) || 0;
  if (n > 0) parts.push(`${n} thing${n === 1 ? '' : 's'} you said pointed the other way.`);
  const prev = belief.history?.at?.(-1)?.value;
  if ((typeof prev === 'string' || typeof prev === 'number') && String(prev).trim()
      && !classifySensitivity(String(prev)) && !mentionsInternalIntent(String(prev)) && !/\bcustom_/i.test(String(prev))
      && !(ROLE_KEYS.has(belief.key) && isAspirationalRole(prev))) {
    parts.push(`Before that, Aqua had “${prev}”.`);
  }
  return {
    dimension: belief.dimension,
    key: belief.key,
    value: belief.value,
    confidence: +Number(belief.confidence ?? 0).toFixed(3),
    evidenceCount: belief.evidenceCount,
    contradictions: belief.contradictions,
    explanation: parts.join(' '),
    recentEvidence: ev.slice(-5).map(e => ({
      ts: e.ts, conversationId: e.conversationId ?? null, signal: evidenceLine(e), delta: e.delta ?? 0,
      support: e.support !== false, ...(e.correction ? { correction: true } : {}),
    })),
  };
}

/** Independent sources behind a belief: distinct conversations / files named in its evidence. */
function sourceCount(belief) {
  const ids = new Set();
  for (const e of belief?.evidence ?? []) ids.add(String(e.conversationId ?? e.signal ?? ''));
  ids.delete('');
  return ids.size;
}

/** null = not shown. */
export function presentBelief(b) {
  if (!b) return null;
  if (classifySensitivity({ key: b.key, value: b.value })) return null;
  // Unless the user confirmed it in the legacy review, or set it themselves.
  if (ROLE_KEYS.has(b.key) && isAspirationalRole(b.value) && !b.reviewedAt && b.privacy?.source !== 'correction') return null;
  let label = null;
  if (String(b.key).startsWith('domain:')) {
    if (!isRealDomain(b.key, { sources: sourceCount(b) })) return null;
    label = domainLabel(b.key);
  }
  return {
    dimension: b.dimension, key: b.key, ...(label ? { label } : {}), value: b.value,
    confidence: +Number(b.confidence ?? 0).toFixed(3), evidenceCount: b.evidenceCount,
    evidenceText: evidenceText(b),
    contradictions: b.contradictions, status: b.status,
    locked: !!b.privacy?.locked, temporary: !!b.privacy?.temporary,
    source: b.privacy?.source, updatedAt: b.updatedAt,
  };
}

export const presentBeliefs = beliefs => (beliefs ?? []).map(presentBelief).filter(Boolean);

/** Focus topics with a human label only ("writing code", "react"); routing ids drop. */
export function presentFocus(focus) {
  const out = [];
  for (const f of focus ?? []) {
    const topic = intentLabel(f?.topic);
    if (!topic || out.some(o => o.topic === topic)) continue;
    out.push({ ...f, topic });
  }
  return out;
}

export function presentPredictions(preds) {
  return (preds ?? []).flatMap(p => {
    const label = cleanInternalTitle(p?.label);
    if (!label || /:\s*$/.test(label) || classifySensitivity(label)) return [];
    return [{ ...p, label }];
  });
}

export function presentTimeline(events) {
  return (events ?? []).flatMap(e => {
    const subject = cleanInternalTitle(String(e?.subject ?? '').replace(/_/g, ' '));
    if (!subject || /^working on\s*$/i.test(subject) || classifySensitivity(subject)) return [];
    return [{ ...e, subject }];
  });
}

export function presentEpisodes(episodes) {
  return (episodes ?? []).flatMap(ep => {
    const title = cleanInternalTitle(ep?.title);
    if (!title || /^working on\s*$/i.test(title)) return [];
    return [{ ...ep, title, theme: ep.theme ? (cleanInternalTitle(ep.theme) ?? undefined) : ep.theme }];
  });
}

export function presentGoals(goals) {
  // A goal the user split (legacy review) lives on as its parts; the original
  // stays stored with its history and in the export, not on the page.
  return (goals ?? []).filter(g => !g?.splitInto && !classifySensitivity(String(g?.title ?? '')));
}

export function presentWorking(working, focusRanked) {
  const w = working ?? {};
  return {
    ...w,
    focus: presentFocus(w.focus),
    focusRanked: presentFocus(focusRanked),
    recentDiscoveries: (w.recentDiscoveries ?? []).filter(d => !classifySensitivity(String(d?.text ?? d ?? ''))),
    openQuestions: (w.openQuestions ?? []).filter(q => !classifySensitivity(String(q?.text ?? q ?? ''))),
  };
}
