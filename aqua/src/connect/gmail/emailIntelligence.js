/**
 * AQUA Connect — Gmail intelligence, MODEL-FREE (Gmail Phase 5).
 *
 * Structured views and deterministic answers over the owner's own email
 * understanding, built ONLY on emailContext.retrieveEmailEvidence (which takes
 * the owner from the authenticated principal and taints the request with
 * external:gmail, so nothing here — or after it in the same request — can
 * reach an AI provider). No LLM, no provider, no embeddings, no reranker, no
 * external search. Nothing is generated: summaries are fixed templates over
 * counts; every item carries its evidence ids.
 *
 * Public item ids are the extractor's stable item ids (16 hex) — the same id
 * across requests, so a client can open its evidence later.
 */
import { retrieveEmailEvidence } from './emailContext.js';

export const VIEWS = Object.freeze(['commitments', 'tasks', 'deadlines', 'decisions', 'superseded', 'contradictions', 'people', 'projects']);
/**
 * Phase 4B (2026-11-23) — per-category retrieval budgets. Measured on the first real
 * mailbox (1,367 messages): 6,648 document links + 1,363 topics filled the old single
 * 2,000-item window, so the views showed 41 of 180 commitments and 51 of 188 tasks.
 * Actionable knowledge now has its own budget per type; links and topics are bounded
 * separately and can no longer crowd it out. Each budget keeps the newest items of its
 * type; overview().coverage reports eligible vs shown per type, so any truncation is explicit.
 */
export const CATEGORY_LIMITS = Object.freeze({
  commitment: 5000, task: 5000, deadline: 5000, event: 5000, date: 5000, decision: 5000, project: 2000,
  document: 250, topic: 250, default: 1000,
});
export const PAGE = Object.freeze({ defaultLimit: 20, maxLimit: 50, maxCursor: CATEGORY_LIMITS.commitment });
export const MAX_QUESTION_CHARS = 500;

function snapshot(principal, now) {
  const b = retrieveEmailEvidence({ principal, perType: CATEGORY_LIMITS, now });
  const byRef = new Map(b.evidence.map(e => [e.ref, e]));
  const byId = new Map(b.evidence.map(e => [e.id, e]));
  return { b, byRef, byId };
}

/** What a client sees of one item (no internal record, no ref numbering). */
export function publicItem(e) {
  if (!e) return null;
  const related = [e.supersededBy, e.supersedes, ...(e.conflictsWith ?? [])].filter(Boolean);
  return {
    id: e.id, type: e.type, status: e.status, statement: e.statement,
    basis: e.basis, explicit: e.explicit === true, certainty: e.certainty, confidence: e.confidence,
    userConfirmed: false,                       // nothing here is verified or completed
    actor: e.actor, requestedBy: e.requestedBy ?? null, assignee: e.assignee, due: e.due, dueResolution: e.dueResolution,
    source: { gmailMessageId: e.provenance.gmailMessageId, threadId: e.provenance.threadId, threadTopic: e.provenance.threadTopic, sentAt: e.provenance.sourceTimestamp, extractedAt: e.provenance.extractedAt },
    supersededBy: e.supersededBy ?? null, supersedes: e.supersedes ?? null, conflictsWith: e.conflictsWith ?? [],
    closedBy: e.closedBy ?? null,
    evidenceIds: [e.id, ...related],
  };
}

const page = (list, { limit = PAGE.defaultLimit, cursor = 0 } = {}) => ({
  total: list.length,
  items: list.slice(cursor, cursor + limit),
  nextCursor: cursor + limit < list.length ? cursor + limit : null,
});

/** Contradiction groups touching any of these items — never silently omitted. */
function contradictionsFor(items, b, byRef) {
  const ids = new Set(items.map(i => i.id));
  return b.contradictions
    .map(g => g.map(r => byRef.get(r)).filter(Boolean))
    .filter(g => g.some(e => ids.has(e.id)))
    .slice(0, 50)
    .map(g => ({ items: g.map(publicItem), note: 'These statements conflict; neither has been confirmed.' }));
}

export function overview({ principal, now = Date.now() } = {}) {
  const { b, byRef } = snapshot(principal, now);
  const top = refs => refs.slice(0, 5).map(r => publicItem(byRef.get(r)));
  return {
    counts: {
      openCommitments: b.openCommitments.length, openTasks: b.openTasks.length,
      upcoming: b.upcoming.length, currentDecisions: b.decisions.current.length,
      supersededDecisions: b.decisions.superseded.length, contradictions: b.contradictions.length,
      people: b.relationships.people.length, projects: b.relationships.projects.length,
      conversations: b.relationships.topics.length, items: b.evidence.length,
    },
    // Phase 4B: per item type, how many were found and how many the views include (newest first).
    coverage: Object.fromEntries(Object.entries(b.coverage ?? {}).map(([t, c]) => [t, { found: c.eligible, shown: c.selected, truncated: c.selected < c.eligible }])),
    upcoming: top(b.upcoming.map(u => u.ref)),
    openCommitments: top(b.openCommitments),
    openTasks: top(b.openTasks),
    contradictions: b.contradictions.slice(0, 5).map(g => ({ items: g.map(r => publicItem(byRef.get(r))), note: 'These statements conflict; neither has been confirmed.' })),
  };
}

export function view({ principal, view: name, limit = PAGE.defaultLimit, cursor = 0, now = Date.now() } = {}) {
  if (!VIEWS.includes(name)) throw Object.assign(new Error('unknown view'), { code: 'BAD_REQUEST' });
  const { b, byRef, byId } = snapshot(principal, now);
  const items = refs => refs.map(r => publicItem(byRef.get(r))).filter(Boolean);
  if (name === 'contradictions') {
    const groups = b.contradictions.map(g => ({ items: items(g), note: 'These statements conflict; neither has been confirmed.' }));
    return { view: name, ...page(groups, { limit, cursor }) };
  }
  if (name === 'people') {
    const people = b.relationships.people.map(p => {
      const involved = b.evidence.filter(e => e.actor === p.key || e.assignee?.person === p.key || (e.assignee?.candidates ?? []).includes(p.key));
      return { key: p.key, names: p.names, address: p.address, conversations: p.threads.length, threadIds: p.threads.slice(0, 20), itemIds: involved.map(e => e.id).slice(0, 50), openItems: involved.filter(e => ['commitment', 'task'].includes(e.type) && (e.status === 'current' || e.status === 'contradicted')).length };
    }).sort((x, y) => y.conversations - x.conversations || x.key.localeCompare(y.key));
    return { view: name, organizations: b.relationships.organizations, ...page(people, { limit, cursor }) };
  }
  if (name === 'projects') {
    const projects = b.relationships.projects.map(p => ({ name: p.name, threadId: p.threadId, itemId: byRef.get(p.ref)?.id ?? null }));
    const topics = b.relationships.topics.map(t => ({ topic: t.topic, threadId: t.threadId, messages: t.messages, itemIds: b.evidence.filter(e => e.provenance.threadId === t.threadId).map(e => e.id).slice(0, 50) }));
    return { view: name, projects, ...page(topics, { limit, cursor }) };
  }
  const refs = {
    commitments: b.openCommitments, tasks: b.openTasks, deadlines: b.upcoming.map(u => u.ref),
    decisions: b.decisions.current, superseded: b.decisions.superseded.map(x => x.ref),
  }[name];
  const all = items(refs);
  const p = page(all, { limit, cursor });
  return { view: name, ...p, contradictions: contradictionsFor(p.items, b, byRef) };
}

/** One item with its supporting evidence (quote, span, field) and its related items. 404 when not the caller's. */
export function evidenceDetail({ principal, id, now = Date.now() } = {}) {
  const { b, byId } = snapshot(principal, now);
  const e = byId.get(id);
  if (!e) return null;
  const rel = ids => ids.map(x => publicItem(byId.get(x))).filter(Boolean);
  return {
    item: publicItem(e),
    evidence: { gmailMessageId: e.provenance.gmailMessageId, threadId: e.provenance.threadId, threadTopic: e.provenance.threadTopic, sentAt: e.provenance.sourceTimestamp, extractedAt: e.provenance.extractedAt, field: e.provenance.field, span: e.provenance.span, quote: e.provenance.quote, classification: e.classification },
    supersededBy: rel(e.supersededBy ? [e.supersededBy] : []),
    supersedes: rel(e.supersedes ? [e.supersedes] : []),
    conflictsWith: rel(e.conflictsWith ?? []),
    sameConversation: b.evidence.filter(x => x.provenance.threadId === e.provenance.threadId && x.id !== e.id).slice(0, 20).map(x => x.id),
  };
}

// ── model-free question answering ─────────────────────────────────────────────
export const INTENTS = Object.freeze(['evidence', 'contradictions', 'superseded_decisions', 'decisions_about', 'person', 'project', 'open_commitments', 'upcoming_deadlines']);
const words = s => String(s ?? '').toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? [];
const STOP = new Set(['the', 'a', 'an', 'about', 'on', 'regarding', 'for', 'of', 'to', 'we', 'did', 'what', 'which', 'any', 'our', 'my', 'is', 'are', 'was', 'decide', 'decided', 'decision', 'decisions', 'make', 'made']);

/**
 * Deterministic intent → structured answer. Unsupported questions get an
 * honest "not supported yet". Contradictions touching the answer are always
 * included; superseded items appear only when asked for, and labelled.
 */
export function ask({ principal, question, now = Date.now() } = {}) {
  const q = String(question ?? '').trim();
  const lq = q.toLowerCase();
  const { b, byRef, byId } = snapshot(principal, now);
  const all = b.evidence;
  const answer = (intent, items, summary, extra = {}) => {
    const pub = items.map(publicItem);
    return { supported: true, intent, question: q, summary, items: pub, contradictions: contradictionsFor(pub, b, byRef), evidenceIds: [...new Set(pub.flatMap(i => i.evidenceIds))], ...extra };
  };
  const live = e => e.status === 'current' || e.status === 'contradicted';

  const idm = /\b([0-9a-f]{16})\b/.exec(lq);
  if (idm && /\b(evidence|source|proof|why|show)\b/.test(lq)) {
    const d = evidenceDetail({ principal, id: idm[1], now });
    if (!d) return { supported: true, intent: 'evidence', question: q, summary: 'No item with that id exists in your email knowledge.', items: [], contradictions: [], evidenceIds: [] };
    return { supported: true, intent: 'evidence', question: q, summary: 'The supporting evidence for that item.', items: [d.item], detail: d, contradictions: contradictionsFor([d.item], b, byRef), evidenceIds: d.item.evidenceIds };
  }
  if (/\b(contradict\w*|conflict\w*|inconsisten\w*|disagree\w*)\b/.test(lq)) {
    const items = all.filter(e => e.status === 'contradicted');
    return answer('contradictions', items, `${b.contradictions.length} conflicting statement group(s) found. None has been resolved or confirmed.`);
  }
  if (/\b(decisions?|decided)\b/.test(lq) && /\b(superseded|changed|reversed|overturned|old|previous|earlier|replaced)\b/.test(lq)) {
    const items = all.filter(e => e.type === 'decision' && e.status === 'superseded');
    return answer('superseded_decisions', items, `${items.length} decision(s) were later changed. Each is shown with the decision that replaced it.`, { replacements: items.map(e => ({ id: e.id, supersededBy: e.supersededBy })) });
  }
  if (/\b(decisions?|decided|decide)\b/.test(lq)) {
    const topic = words(lq.split(/\b(?:about|on|regarding|for)\b/).slice(1).join(' ')).filter(w => !STOP.has(w));
    if (!topic.length) return { supported: false, intent: 'decisions_about', question: q, summary: 'Name the topic: for example "What did we decide about storage?"', items: [], contradictions: [], evidenceIds: [] };
    const direct = e => topic.some(w => words(`${e.statement} ${e.provenance.threadTopic}`).includes(w));
    // A decision that REPLACES a matching decision is about the same topic ("…use MySQL instead" replaces "…Postgres for storage").
    const matched = new Set(all.filter(e => e.type === 'decision' && direct(e)).map(e => e.id));
    for (let grew = true; grew;) {
      grew = false;
      for (const e of all) if (e.type === 'decision' && !matched.has(e.id) && e.supersedes && matched.has(e.supersedes)) { matched.add(e.id); grew = true; }
    }
    const hit = e => matched.has(e.id);
    const current = all.filter(e => e.type === 'decision' && live(e) && hit(e));
    const history = all.filter(e => e.type === 'decision' && e.status === 'superseded' && hit(e));
    return answer('decisions_about', current, `${current.length} current decision(s) about "${topic.join(' ')}"${history.length ? `; ${history.length} earlier decision(s) were superseded and are listed separately` : ''}.`, { superseded: history.map(publicItem) });
  }
  // "project X" first; "X project" only for a capitalised name (else "…with project Atlas" would read "with").
  const pm = /\bproject\s+([a-z][\w-]{1,40})\b/i.exec(q) ?? /\b([A-Z][\w-]{1,40})\s+[Pp]roject\b/.exec(q);
  if (pm) {
    const name = (pm[1] ?? pm[2]).toLowerCase();
    const threads = new Set(b.relationships.projects.filter(p => String(p.name).toLowerCase() === name).map(p => p.threadId));
    if (!threads.size) return { supported: true, intent: 'project', question: q, summary: `No project named "${pm[1] ?? pm[2]}" appears in your email.`, items: [], contradictions: [], evidenceIds: [] };
    const items = all.filter(e => threads.has(e.provenance.threadId) && !['superseded', 'completed', 'cancelled'].includes(e.status));
    return answer('project', items, `${items.length} item(s) from ${threads.size} conversation(s) about project ${pm[1] ?? pm[2]}.`, { threadIds: [...threads] });
  }
  const nameM = /\b(?:from|by|with|involving|to|for|did|does|has|have|is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/.exec(q) ?? /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:promised|owes|committed|asked|said)\b/.exec(q);
  if (nameM && !/^(I|We|You|What|When|Which|Who|Show|List)$/.test(nameM[1])) {
    const n = nameM[1].toLowerCase();
    const matches = b.relationships.people.filter(p => p.names.some(x => x.toLowerCase() === n || x.toLowerCase().split(/\s+/)[0] === n.split(/\s+/)[0] && !n.includes(' ')));
    if (!matches.length) return { supported: true, intent: 'person', question: q, summary: `Nobody named "${nameM[1]}" appears in your email.`, items: [], contradictions: [], evidenceIds: [] };
    if (matches.length > 1) return { supported: true, intent: 'person', question: q, summary: `More than one person is named "${nameM[1]}". Ask with a full name.`, ambiguous: matches.map(p => ({ key: p.key, names: p.names, address: p.address })), items: [], contradictions: [], evidenceIds: [] };
    const key = matches[0].key;
    const items = all.filter(e => ['commitment', 'task'].includes(e.type) && live(e) && (e.actor === key || e.requestedBy === key || e.assignee?.person === key));
    const possibly = all.filter(e => e.type === 'task' && live(e) && e.assignee?.status !== 'resolved' && (e.assignee?.candidates ?? []).includes(key));
    return answer('person', items, `${items.length} open commitment(s) or request(s) involving ${matches[0].names[0] ?? matches[0].address}${possibly.length ? `; ${possibly.length} more may involve them but name no one specifically (inference)` : ''}. None has been verified or completed.`, { person: { key, names: matches[0].names, address: matches[0].address }, possiblyInvolving: possibly.map(publicItem) });
  }
  if (/\b(commitments?|promises?|promised|tasks?|to-?dos?|action items?|follow[- ]?ups?|owe|outstanding|pending|open items?)\b/.test(lq)) {
    const items = [...b.openCommitments, ...b.openTasks].map(r => byRef.get(r));
    return answer('open_commitments', items, `${b.openCommitments.length} open commitment(s) and ${b.openTasks.length} open request(s) found in your email. None has been verified or completed.`);
  }
  // Gmail Phase 6 (evaluation Q14): "When is the Falcon kickoff?" asks for a date — the extractor's event words count.
  if (/\b(deadlines?|due|upcoming|coming up|events?|meetings?|calls?|schedule|calendar|kick-?offs?|demos?|interviews?|workshops?|webinars?|offsites?|standups?|stand-ups?)\b/.test(lq) || /^\s*when\s+(?:is|are|'s|will)\b/.test(lq)) {
    const items = b.upcoming.map(u => byRef.get(u.ref));
    return answer('upcoming_deadlines', items, `${items.length} upcoming date(s) found in your email, earliest first.`);
  }
  return {
    supported: false, intent: null, question: q,
    summary: 'This question is not supported yet. Ask about open commitments, upcoming deadlines, decisions about a topic, changed decisions, contradictions, a named person, a named project, or the evidence for an item.',
    items: [], contradictions: [], evidenceIds: [],
  };
}
