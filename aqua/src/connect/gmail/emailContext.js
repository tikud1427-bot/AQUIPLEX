/**
 * AQUA Connect — the read adapter for email understanding (Gmail Phase 3).
 *
 * Reads the structured understanding the `emailUnderstanding` enrichment stage
 * stored on the owner's restricted Gmail UKOs, groups it by thread and
 * reconciles it (supersession / contradiction / duplicates, computed on read).
 * It is the ONE place later phases will retrieve email evidence from — there is
 * no other store to read.
 *
 * PRIVACY BOUNDARY (unchanged, relied upon):
 *   · the owner comes ONLY from an authenticated principal (principal.js);
 *   · the read runs in data class external:gmail and taints the CALLER's scope
 *     (core/egressGuard.js: a scope only grows). Whatever request or job calls
 *     this can no longer reach ANY AI provider, embedding, reranker or search
 *     service — the frozen external:gmail allowlist is empty. This adapter can
 *     therefore never be used to launder email content into a prompt;
 *   · it is NOT wired into the chat context path (brain/contextEngine): that
 *     needs an explicit provider-egress approval first (see the design doc).
 */
import { isPrincipal } from '../principal.js';
import { runWithDataClass, currentDataClasses } from '../../core/egressGuard.js';
import { listUKOs, dataClassOfUko } from '../../files/ukoStore.js';
import { sourcePrefixes } from '../../files/externalIdentity.js';
import { reconcileThread, EMAIL_UNDERSTANDING_SCHEMA } from './emailUnderstanding.js';

const GMAIL_CLASS = 'external:gmail';

export class EmailContextError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * @param {object} q
 * @param {object} q.principal       authenticated principal (required)
 * @param {string} [q.connectionId]  limit to one connection (source gmail:<id>)
 * @param {string} [q.threadId]      limit to one thread
 * @param {string[]} [q.types]       limit item types (after reconciliation)
 * @param {boolean} [q.includeHistory]  also return superseded/duplicate items (default: current + contradicted only)
 * @returns {{ threads: Array<{ threadId, topic, messages: number, people, items }> }}
 */
export function emailUnderstandingFor({ principal, connectionId = null, threadId = null, types = null, includeHistory = false } = {}) {
  if (!isPrincipal(principal)) throw new EmailContextError('UNAUTHENTICATED', 'an authenticated user is required');
  const ownerId = `user:${principal.userId}`;
  // A connection's UKOs share its source's id prefix (files/externalIdentity.js); every Gmail UKO carries the class.
  const ukoPrefix = connectionId ? sourcePrefixes(`gmail:${connectionId}`).ukoPrefix : null;
  return runWithDataClass(GMAIL_CLASS, () => {
    const records = listUKOs(ownerId, { limit: 100_000, includeRestricted: true })
      .filter(u => dataClassOfUko(u) === GMAIL_CLASS && (!ukoPrefix || String(u.id).startsWith(ukoPrefix)))
      .map(u => u.emailUnderstanding)
      .filter(r => r?.schema === EMAIL_UNDERSTANDING_SCHEMA && (!threadId || r.source.threadId === threadId));
    const byThread = new Map();
    for (const r of records) {
      const k = r.source.threadId ?? `msg:${r.source.gmailMessageId}`;
      if (!byThread.has(k)) byThread.set(k, []);
      byThread.get(k).push(r);
    }
    const keep = it => (includeHistory || ['current', 'contradicted'].includes(it.status)) && (!types || types.includes(it.type));
    const threads = [...byThread.entries()].map(([tid, recs]) => {
      const people = new Map();
      for (const r of recs) for (const p of r.people) {
        const cur = people.get(p.key) ?? { key: p.key, address: p.address, names: [] };
        for (const n of p.names) if (!cur.names.includes(n)) cur.names.push(n);
        people.set(p.key, cur);
      }
      const ordered = [...recs].sort((a, b) => String(a.source.sourceTimestamp).localeCompare(String(b.source.sourceTimestamp)));
      return { threadId: tid, topic: ordered.at(-1)?.conversation?.topic ?? null, messages: recs.length, people: [...people.values()], items: reconcileThread(recs).filter(keep) };
    }).sort((a, b) => String(a.threadId).localeCompare(String(b.threadId)));
    return { threads };
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Gmail Phase 4 — the RESTRICTED, evidence-backed retrieval interface.
// ══════════════════════════════════════════════════════════════════════════════
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'was', 'what', 'when', 'who', 'did', 'does', 'do', 'about', 'my', 'me', 'i', 'we', 'it', 'that', 'this', 'any', 'with', 'from', 'by', 'are', 'be', 'have', 'has', 'which', 'there', 'email', 'emails', 'mail']);
const tokens = s => String(s ?? '').toLowerCase().split(/[^a-z0-9@.]+/).filter(t => t.length > 1 && !STOP.has(t));
const dayOf = iso => (typeof iso === 'string' ? iso.slice(0, 10) : null);
const dueOf = it => it.due?.date ?? it.when?.date ?? it.value?.date ?? null;
/** Gmail Phase 5: the bound of one retrieval (the intelligence API pages over it; nothing larger is ever assembled). */
export const MAX_EVIDENCE = 2000;
const FREE_DOMAIN =/^(gmail|googlemail|outlook|hotmail|yahoo|icloud|live|aol)\.com$|^proton(mail)?\.(me|com)$/;

/**
 * Evidence-backed retrieval for ONE authenticated user. Local only (token
 * overlap — no embeddings, reranker or search service). Returns numbered
 * evidence (E1…) with full provenance, and views over it: relationships,
 * decisions (current / superseded), open commitments and tasks, upcoming
 * deadlines and events, contradictions. `basis` is 'direct' only for an
 * explicit, stated item; everything else is 'inference'.
 *
 * Like emailUnderstandingFor it runs in external:gmail and TAINTS the caller:
 * after this call the request can reach no AI provider. There is no ownerId
 * parameter — any extra field is ignored; the owner is the principal's.
 *
 * @param {object} q  { principal, question?, types?, connectionId?, limit?, perType?, now? }
 *   perType (Phase 4B): { [itemType]: max, default?: max } — bound each type separately
 *   instead of one global `limit` (the views use it; see emailIntelligence.CATEGORY_LIMITS).
 */
export function retrieveEmailEvidence({ principal, question = '', types = null, connectionId = null, limit = 25, perType = null, now = Date.now() } = {}) {
  const { threads } = emailUnderstandingFor({ principal, connectionId, types, includeHistory: true });
  const q = tokens(question);
  const today = dayOf(new Date(now).toISOString());
  const all = [];
  for (const t of threads) {
    for (const it of t.items) {
      if (it.status === 'duplicate' || it.status === 'corroborates') continue;
      const actor = t.people.find(p => p.key === it.actor);
      const hay = tokens([it.statement, it.object, it.topic, it.name, it.about, it.filename, it.url, t.topic, actor?.names.join(' '), actor?.address].filter(Boolean).join(' '));
      const score = q.length ? q.filter(x => hay.includes(x)).length : 1;
      all.push({ it, t, score });
    }
  }
  // An update inherits the relevance of what it supersedes ("send it by Wednesday instead" answers a question about "the deck").
  const scoreById = new Map(all.map(x => [x.it.id, x.score]));
  for (const x of all) if (x.it.supersedes) x.score = Math.max(x.score, scoreById.get(x.it.supersedes) ?? 0);
  const rank = (a, b) => b.score - a.score || (a.it.status === 'superseded') - (b.it.status === 'superseded') || String(b.it.sourceTimestamp).localeCompare(String(a.it.sourceTimestamp));
  const eligible = all.filter(x => x.score > 0).sort(rank);
  // 2026-11-23 (Phase 4B) — CATEGORY-AWARE selection. With `perType`, every item type is
  // ranked and bounded ON ITS OWN (same order as before), so a flood of one category
  // (e.g. thousands of document links in newsletters) can never crowd out commitments,
  // tasks, deadlines or decisions. Without it: the previous single global ranking.
  // `coverage` reports, per type, how many items were eligible and how many were kept —
  // truncation is always visible, never silent.
  let chosen;
  const coverage = {};
  for (const x of eligible) (coverage[x.it.type] ??= { eligible: 0, selected: 0 }).eligible++;
  if (perType && typeof perType === 'object') {
    const kept = new Map();
    chosen = eligible.filter(x => {
      const cap = Number.isFinite(perType[x.it.type]) ? perType[x.it.type] : (Number.isFinite(perType.default) ? perType.default : 0);
      const n = kept.get(x.it.type) ?? 0;
      if (n >= cap) return false;
      kept.set(x.it.type, n + 1);
      return true;
    });
  } else {
    chosen = eligible.slice(0, Math.max(1, Math.min(MAX_EVIDENCE, limit)));
  }
  for (const x of chosen) coverage[x.it.type].selected++;
  const refOf = new Map();
  const evidence = chosen.map(({ it, t }, i) => {
    const ref = `E${i + 1}`;
    refOf.set(it.id, ref);
    return {
      ref, id: it.id, type: it.type, status: it.status,
      statement: it.statement ?? it.object ?? it.topic ?? it.name ?? it.url ?? it.filename ?? null,
      basis: it.explicit === true && it.certainty === 'stated' ? 'direct' : 'inference',
      explicit: it.explicit, certainty: it.certainty, confidence: it.confidence, userConfirmed: it.userConfirmed === true,
      actor: it.actor ?? null, requestedBy: it.requestedBy ?? null, assignee: it.assignee ?? null, due: dueOf(it),
      dueResolution: it.due?.resolution ?? it.when?.resolution ?? it.value?.resolution ?? null,
      provenance: { gmailMessageId: it.gmailMessageId, threadId: it.threadId, threadTopic: t.topic, sourceTimestamp: it.sourceTimestamp, extractedAt: it.extractedAt, field: it.evidence.field, span: it.evidence.span, quote: it.evidence.quote },
      supersededBy: it.supersededBy ?? null, supersedes: it.supersedes ?? null, conflictsWith: it.conflictsWith ?? null,
      // Gmail Phase 6: 'completed' / 'cancelled' items carry the later message that closed them (as stated in email; not user-confirmed).
      closedBy: it.closedBy ? { kind: it.closedBy.kind, by: it.closedBy.by, sourceTimestamp: it.closedBy.sourceTimestamp, gmailMessageId: it.closedBy.evidence.gmailMessageId, quote: it.closedBy.evidence.quote } : null,
      classification: it.classification,
    };
  });
  const byRef = id => refOf.get(id) ?? null;
  const peopleMap = new Map();
  const orgs = new Map();
  for (const t of threads) for (const p of t.people) {
    const cur = peopleMap.get(p.key) ?? { key: p.key, address: p.address, names: [...p.names], threads: [] };
    if (!cur.threads.includes(t.threadId)) cur.threads.push(t.threadId);
    peopleMap.set(p.key, cur);
    const dom = p.address.split('@')[1];
    if (dom && !FREE_DOMAIN.test(dom)) {
      const o = orgs.get(dom) ?? { domain: dom, basis: 'inference', members: [] };
      if (!o.members.includes(p.key)) o.members.push(p.key);
      orgs.set(dom, o);
    }
  }
  const ev = evidence;
  const open = type => ev.filter(e => e.type === type && (e.status === 'current' || e.status === 'contradicted')).map(e => e.ref);
  return {
    classification: GMAIL_CLASS,
    question: String(question ?? ''),
    evidence,
    coverage,
    relationships: {
      people: [...peopleMap.values()],
      organizations: [...orgs.values()],
      // Phase 4B: one entry per project NAME (case-insensitive), newest mention first, with every thread it appears in.
      projects: [...ev.filter(e => e.type === 'project').reduce((m, e) => {
        const k = String(e.statement ?? '').toLowerCase();
        const cur = m.get(k);
        if (!cur) m.set(k, { name: e.statement, threadId: e.provenance.threadId, ref: e.ref, threadIds: [e.provenance.threadId], mentions: 1 });
        else { cur.mentions++; if (!cur.threadIds.includes(e.provenance.threadId)) cur.threadIds.push(e.provenance.threadId); }
        return m;
      }, new Map()).values()],
      topics: threads.map(t => ({ topic: t.topic, threadId: t.threadId, messages: t.messages })),
    },
    decisions: {
      current: ev.filter(e => e.type === 'decision' && e.status === 'current').map(e => e.ref),
      superseded: ev.filter(e => e.type === 'decision' && e.status === 'superseded').map(e => ({ ref: e.ref, supersededBy: byRef(e.supersededBy) })),
    },
    openCommitments: open('commitment'),
    openTasks: open('task'),
    upcoming: ev.filter(e => ['deadline', 'event', 'commitment', 'task', 'date'].includes(e.type) && (e.status === 'current' || e.status === 'contradicted') && e.due && today && e.due >= today)
      .sort((a, b) => a.due.localeCompare(b.due)).map(e => ({ ref: e.ref, due: e.due })),
    contradictions: [...new Set(ev.filter(e => e.status === 'contradicted' && Array.isArray(e.conflictsWith))
      .map(e => [e.ref, ...e.conflictsWith.map(byRef).filter(Boolean)].sort().join(',')))]
      .map(s => s.split(',')).filter(g => g.length > 1),
  };
}

export class EmailScopeError extends Error {
  constructor() { super('email evidence may only be formatted inside a request already in data class external:gmail'); this.code = 'EMAIL_SCOPE_REQUIRED'; }
}

/**
 * Gmail Phase 4 — the chat-integration ADAPTER (designed; NOT wired into
 * routes/chat.js prepareTurn). Formats retrieved evidence into a prompt block
 * with citations. It REFUSES to run unless the current scope already carries
 * external:gmail, so any prompt built from it belongs to a request every
 * provider refuses (core/egressGuard.js). Its only consumer today is the
 * test harness with an injected fake model (connect/testing/emailAnswerHarness.js).
 */
export function formatEmailEvidenceForPrompt(bundle) {
  if (!(currentDataClasses() ?? []).includes(GMAIL_CLASS)) throw new EmailScopeError();   // no scope at all = not tainted = refused
  const lines = ['EMAIL EVIDENCE (the user\'s own Gmail; cite as [E#]; "inference" items are not facts; contradicted items must be presented as conflicting):'];
  for (const e of bundle?.evidence ?? []) {
    lines.push(`[${e.ref}] ${e.type}${e.status !== 'current' ? ` (${e.status})` : ''} · ${e.basis} · ${e.certainty} · ${dayOf(e.provenance.sourceTimestamp) ?? 'undated'}${e.due ? ` · due ${e.due}` : ''} — ${String(e.statement ?? '').slice(0, 200)}`);
  }
  if (bundle?.contradictions?.length) lines.push(`CONTRADICTIONS: ${bundle.contradictions.map(g => g.map(r => `[${r}]`).join(' vs ')).join('; ')}`);
  return lines.join('\n');
}
