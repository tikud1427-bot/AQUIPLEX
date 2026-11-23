import { useCallback, useEffect, useState } from 'react';
import { RefreshCcw, Search } from 'lucide-react';
import { SectionHeader } from '@/components/ui/section-header';
import { Panel } from '@/components/ui/panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  askEmail, connectionAction, EmailApiError, fetchConnections, fetchEvidence, fetchOverview, fetchView, gmailConnectStartUrl,
  type Answer, type ConnectionAction, type SyncPhase, type ConflictGroup, type Connection, type EmailItem, type EvidenceDetail, type ItemView,
  type Overview, type PeopleView, type ProjectsView, type ViewName,
} from '@/api/gmailIntelligence';

/* Email — the user's own Gmail knowledge, extracted on the server by fixed
   rules (no AI model). Every item is a statement found in an email; every item
   opens its evidence. Nothing here is verified or confirmed; "Reported done" /
   "Called off" only repeat what a later email said. */

const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown date');
const errText = (e: unknown) => (e instanceof EmailApiError ? e.message : 'Something went wrong. Try again.');

export function StatusBadge({ status }: { status: EmailItem['status'] }) {
  if (status === 'superseded') return <Badge variant="warning">Superseded</Badge>;
  if (status === 'contradicted') return <Badge variant="danger">Contradicted</Badge>;
  if (status === 'completed') return <Badge variant="outline">Reported done in email</Badge>;
  if (status === 'cancelled') return <Badge variant="outline">Called off in email</Badge>;
  return <Badge variant="primary">Current</Badge>;
}
export function BasisBadge({ item }: { item: EmailItem }) {
  return item.basis === 'direct'
    ? <Badge variant="outline">Direct statement</Badge>
    : <Badge variant="default">{item.certainty === 'uncertain' ? 'Inference · uncertain' : 'Inference'}</Badge>;
}

function ItemRow({ item, onEvidence }: { item: EmailItem; onEvidence: (id: string) => void }) {
  return (
    <li className="flex flex-col gap-2 border-b border-border py-3 last:border-0 sm:flex-row sm:items-start sm:justify-between" data-testid="email-item">
      <div className="min-w-0">
        <p className={item.status === 'superseded' ? 'text-sm text-foreground-secondary line-through decoration-1' : 'text-sm text-foreground'}>
          {item.statement ?? '(no text)'}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <StatusBadge status={item.status} />
          <BasisBadge item={item} />
          {item.due && <Badge variant="default">{item.dueResolution === 'ambiguous' ? 'Date unclear' : `Due ${item.due}`}</Badge>}
          {(item.type === 'commitment' || item.type === 'task') && <span className="text-micro text-foreground-secondary">Not verified · not marked done</span>}
        </div>
        <p className="mt-1 text-micro text-foreground-secondary [overflow-wrap:anywhere]">
          {item.source.threadTopic ? `“${item.source.threadTopic}” · ` : ''}sent {fmtDate(item.source.sentAt)}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={() => onEvidence(item.id)} aria-label={`Show evidence for: ${item.statement ?? item.id}`}>Evidence</Button>
    </li>
  );
}

function ItemList({ items, onEvidence, empty }: { items: EmailItem[]; onEvidence: (id: string) => void; empty: string }) {
  if (!items.length) return <p className="py-3 text-sm text-foreground-secondary">{empty}</p>;
  return <ul>{items.map((i) => <ItemRow key={i.id} item={i} onEvidence={onEvidence} />)}</ul>;
}

function Conflicts({ groups, onEvidence }: { groups: ConflictGroup[]; onEvidence: (id: string) => void }) {
  if (!groups.length) return null;
  return (
    <div className="mt-3 space-y-3">
      {groups.map((g) => (
        <Panel key={g.items.map((i) => i.id).join('-')} className="border-danger/30">
          <p className="text-micro font-medium text-danger">{g.note}</p>
          <ItemList items={g.items} onEvidence={onEvidence} empty="" />
        </Panel>
      ))}
    </div>
  );
}

function EvidenceDialog({ id, onClose, onEvidence }: { id: string | null; onClose: () => void; onEvidence: (id: string) => void }) {
  const [detail, setDetail] = useState<EvidenceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    setDetail(null); setError(null);
    fetchEvidence(id).then(setDetail).catch((e) => setError(e instanceof EmailApiError && e.kind === 'not-found' ? 'This item no longer exists — its email was deleted or disconnected.' : errText(e)));
  }, [id]);
  return (
    <Dialog open={!!id} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Evidence</DialogTitle>
          <DialogDescription>The exact text this item was extracted from. Extraction is rule-based and may be wrong.</DialogDescription>
        </DialogHeader>
        {!detail && !error && <Skeleton className="h-24 w-full" />}
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
        {detail && (
          <div className="space-y-3 text-sm" data-testid="evidence-detail">
            <blockquote className="rounded-lg border-l-4 border-border bg-surface-secondary p-3 text-foreground [overflow-wrap:anywhere]">{detail.evidence.quote}</blockquote>
            <div className="flex flex-wrap gap-1.5"><StatusBadge status={detail.item.status} /><BasisBadge item={detail.item} /></div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-micro text-foreground-secondary">
              <dt>Conversation</dt><dd className="[overflow-wrap:anywhere]">{detail.evidence.threadTopic ?? '(no subject)'}</dd>
              <dt>Sent</dt><dd>{fmtDate(detail.evidence.sentAt)}</dd>
              <dt>Extracted</dt><dd>{fmtDate(detail.evidence.extractedAt)}</dd>
              <dt>Found in</dt><dd>{detail.evidence.field === 'subject' ? 'Subject line' : detail.evidence.field === 'attachment' ? 'Attachment name (content not read)' : 'Message body'}</dd>
              <dt>Gmail message</dt><dd className="font-mono [overflow-wrap:anywhere]">{detail.evidence.gmailMessageId}</dd>
            </dl>
            {detail.supersededBy.length > 0 && <Related title="Replaced by a later message" items={detail.supersededBy} onEvidence={onEvidence} />}
            {detail.supersedes.length > 0 && <Related title="This replaced" items={detail.supersedes} onEvidence={onEvidence} />}
            {detail.conflictsWith.length > 0 && <Related title="Conflicts with (neither confirmed)" items={detail.conflictsWith} onEvidence={onEvidence} />}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
function Related({ title, items, onEvidence }: { title: string; items: EmailItem[]; onEvidence: (id: string) => void }) {
  return (<div><p className="text-micro font-medium text-foreground">{title}</p><ItemList items={items} onEvidence={onEvidence} empty="" /></div>);
}

const startConnect = () => { window.location.assign(gmailConnectStartUrl()); };

const PHASE_TEXT: Record<SyncPhase, string> = {
  not_started: 'Initial import not started',
  initial_in_progress: 'Initial import in progress',
  initial_interrupted: 'Initial import interrupted — choose "Sync now" to continue where it stopped',
  initial_complete: 'Initial import complete',
  incremental_in_progress: 'Checking for new email',
  full_resync_in_progress: 'Re-checking the whole mailbox',
  failed: 'Last sync failed',
  paused: 'Sync paused',
};
/** Counts only. Gmail's mailbox size is an estimate, so no percentage is shown. */
export function SyncProgress({ c }: { c: Connection }) {
  const phase = c.syncPhase as SyncPhase;
  const parts = [`${(c.imported ?? 0).toLocaleString()} message${c.imported === 1 ? '' : 's'} imported`];
  if (c.progress?.listed != null && (phase === 'initial_in_progress' || phase === 'initial_interrupted' || phase === 'full_resync_in_progress')) parts.push(`${c.progress.listed.toLocaleString()} listed so far in this pass`);
  if (c.lastSync?.lastSuccessAt) parts.push(`last successful sync ${fmtDate(c.lastSync.lastSuccessAt)}`);
  return (
    <p className="text-micro text-foreground-secondary" data-testid="sync-phase">
      <span className={phase === 'failed' ? 'text-danger' : 'text-foreground'}>{PHASE_TEXT[phase]}</span> · {parts.join(' · ')}
    </p>
  );
}

export function ConnectionStatus({ connections, state, onAction, busy = false }: {
  connections: Connection[];
  state: 'loading' | 'ready' | 'unavailable' | 'error';
  onAction?: (connectionId: string, action: ConnectionAction) => void;
  busy?: boolean;
}) {
  if (state === 'loading') return <Skeleton className="h-16 w-full" />;
  if (state === 'unavailable') return <Panel><p className="text-sm text-foreground">Gmail connection is not available on this server.</p></Panel>;
  if (state === 'error') return <Panel><p className="text-sm text-danger" role="alert">Connection status could not be loaded.</p></Panel>;
  const gmail = connections.filter((c) => c.connectorId === 'gmail');
  if (!gmail.length) {
    return (
      <Panel className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-foreground">Gmail is not connected. Nothing has been imported.</p>
        {onAction && <Button size="sm" onClick={startConnect}>Connect Gmail</Button>}
      </Panel>
    );
  }
  return (
    <Panel className="space-y-3">
      {gmail.map((c) => {
        const active = c.status === 'active';
        const act = (a: ConnectionAction) => onAction?.(c.connectionId, a);
        return (
          <div key={c.connectionId} className="space-y-2" data-testid="gmail-connection">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-foreground">{c.account.label ?? 'Gmail'}</span>
              <Badge variant={active ? 'success' : 'warning'}>{{ active: 'Connected', needs_reauth: 'Needs reconnecting', revoked: 'Access revoked', disconnecting: 'Disconnecting', disconnect_incomplete: 'Disconnect incomplete' }[c.status]}</Badge>
              {c.syncPaused && <Badge variant="warning">Sync paused</Badge>}
              {c.syncing && <Badge variant="primary">Syncing…</Badge>}
              <span className="text-micro text-foreground-secondary">
                {c.lastSync?.finishedAt ? `Last sync ${c.lastSync.state ?? ''} · ${fmtDate(c.lastSync.finishedAt)}` : 'Not synchronised yet'}
              </span>
            </div>
            {c.syncPhase && <SyncProgress c={c} />}
            {onAction && (
              <div className="flex flex-wrap gap-2">
                {active && <Button size="sm" disabled={busy || c.syncing || c.syncPaused} onClick={() => act('sync')}>Sync now</Button>}
                {active && (c.syncPaused
                  ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => act('resume')}>Resume sync</Button>
                  : <Button size="sm" variant="ghost" disabled={busy} onClick={() => act('pause')}>Pause sync</Button>)}
                {!active && c.status !== 'disconnecting' && <Button size="sm" disabled={busy} onClick={startConnect}>Reconnect Gmail</Button>}
                {active && <Button size="sm" variant="ghost" disabled={busy} onClick={() => act('revoke')}>Revoke access</Button>}
                <Button size="sm" variant="outline" disabled={busy || c.syncing} onClick={() => act('disconnect')}>Disconnect</Button>
              </div>
            )}
          </div>
        );
      })}
    </Panel>
  );
}

const CONNECT_OUTCOME: Record<string, string> = {
  connected: 'Gmail is connected. Choose "Sync now" to import your email.',
  denied: 'Gmail was not connected: access was not granted.',
  failed: 'Gmail could not be connected. Try again.',
};
/** The OAuth callback returns to /aqua/email?gmailConnect=…; show it once, then drop it from the URL. */
function useConnectOutcome(): string | null {
  const [msg] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    const o = q.get('gmailConnect');
    if (!o) return null;
    const reason = q.get('reason');
    return CONNECT_OUTCOME[o] ? `${CONNECT_OUTCOME[o]}${o === 'failed' && reason ? ` (${reason})` : ''}` : null;
  });
  useEffect(() => {
    if (!msg) return;
    const u = new URL(window.location.href);
    u.searchParams.delete('gmailConnect'); u.searchParams.delete('reason');
    window.history.replaceState(window.history.state, '', `${u.pathname}${u.search}${u.hash}`);
  }, [msg]);
  return msg;
}

const CONFIRM: Partial<Record<ConnectionAction, string>> = {
  revoke: 'Revoke AQUIPLEX\'s access to Gmail? Email already imported stays until you disconnect.',
  disconnect: 'Disconnect Gmail? Access is revoked and every imported email and everything extracted from it is deleted. This cannot be undone.',
};

/** Workstream 5 — what each control does to email already imported. */
export function RetentionNotice() {
  return (
    <details className="rounded-xl border border-border p-3 text-sm text-foreground-secondary">
      <summary className="cursor-pointer text-foreground">What happens to imported email</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li><b>Pause sync</b>: no new mail is read. Everything already imported stays.</li>
        <li><b>Revoke access</b>: AQUIPLEX can no longer read your Gmail. Email already imported <b>stays</b> until you disconnect.</li>
        <li><b>Disconnect</b>: access is revoked and every imported email and everything extracted from it is deleted.</li>
        <li><b>Delete your AQUIPLEX account</b>: access is revoked and all of your data, including imported email, is deleted.</li>
      </ul>
      <p className="mt-2">Email is processed on AQUIPLEX's server by fixed rules. It is never sent to an AI model.</p>
    </details>
  );
}

function PagedItems({ view, onEvidence, empty }: { view: ViewName; onEvidence: (id: string) => void; empty: string }) {
  const [data, setData] = useState<ItemView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (cursor = 0) => {
    try {
      const next = await fetchView<ItemView>(view, cursor);
      setData((prev) => (cursor && prev ? { ...next, items: [...prev.items, ...next.items], contradictions: [...(prev.contradictions ?? []), ...(next.contradictions ?? [])] } : next));
      setError(null);
    } catch (e) { setError(errText(e)); }
  }, [view]);
  useEffect(() => { void load(0); }, [load]);
  if (error) return <p className="text-sm text-danger" role="alert">{error}</p>;
  if (!data) return <Skeleton className="h-20 w-full" />;
  return (
    <div>
      <ItemList items={data.items} onEvidence={onEvidence} empty={empty} />
      {data.contradictions && data.contradictions.length > 0 && <Conflicts groups={data.contradictions} onEvidence={onEvidence} />}
      {data.nextCursor != null && <Button variant="ghost" size="sm" className="mt-2" onClick={() => void load(data.nextCursor ?? 0)}>Show more</Button>}
    </div>
  );
}

function ConflictsView({ onEvidence }: { onEvidence: (id: string) => void }) {
  const [groups, setGroups] = useState<ConflictGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { fetchView<{ items: ConflictGroup[] }>('contradictions').then((d) => setGroups(d.items)).catch((e) => setError(errText(e))); }, []);
  if (error) return <p className="text-sm text-danger" role="alert">{error}</p>;
  if (!groups) return <Skeleton className="h-20 w-full" />;
  if (!groups.length) return <p className="text-sm text-foreground-secondary">No conflicting statements found.</p>;
  return <Conflicts groups={groups} onEvidence={onEvidence} />;
}

function PeopleProjects({ onEvidence }: { onEvidence: (id: string) => void }) {
  const [people, setPeople] = useState<PeopleView | null>(null);
  const [projects, setProjects] = useState<ProjectsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([fetchView<PeopleView>('people'), fetchView<ProjectsView>('projects')]).then(([p, q]) => { setPeople(p); setProjects(q); }).catch((e) => setError(errText(e)));
  }, []);
  if (error) return <p className="text-sm text-danger" role="alert">{error}</p>;
  if (!people || !projects) return <Skeleton className="h-20 w-full" />;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Panel>
        <p className="mb-2 text-sm font-medium text-foreground">People</p>
        {people.items.length === 0 ? <p className="text-sm text-foreground-secondary">No people found.</p> : (
          <ul className="space-y-1.5 text-sm">{people.items.map((p) => (
            <li key={p.key} className="[overflow-wrap:anywhere]"><span className="text-foreground">{p.names[0] ?? p.address}</span> <span className="text-micro text-foreground-secondary">{p.address} · {p.conversations} conversation(s) · {p.openItems} open item(s)</span></li>
          ))}</ul>
        )}
        {people.organizations.length > 0 && <p className="mt-2 text-micro text-foreground-secondary">Organisations (inferred from email domains): {people.organizations.map((o) => o.domain).join(', ')}</p>}
      </Panel>
      <Panel>
        <p className="mb-2 text-sm font-medium text-foreground">Projects and conversations</p>
        {projects.projects.length > 0 && <div className="mb-2 flex flex-wrap gap-1.5">{projects.projects.map((p) => (
          <button key={`${p.name}-${p.threadId}`} className="tap" onClick={() => p.itemId && onEvidence(p.itemId)}><Badge variant="primary">Project {p.name}</Badge></button>
        ))}</div>}
        {projects.items.length === 0 ? <p className="text-sm text-foreground-secondary">No conversations found.</p> : (
          <ul className="space-y-1 text-sm">{projects.items.map((t) => (
            <li key={t.threadId} className="flex justify-between gap-2"><span className="[overflow-wrap:anywhere]">{t.topic ?? '(no subject)'}</span><span className="shrink-0 text-micro text-foreground-secondary">{t.messages} message(s)</span></li>
          ))}</ul>
        )}
      </Panel>
    </div>
  );
}

function AskPanel({ onEvidence }: { onEvidence: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!q.trim()) return;
    setBusy(true); setError(null);
    try { setAnswer(await askEmail(q.trim().slice(0, 500))); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-3">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={500} placeholder="e.g. What are my open commitments?" aria-label="Question about your email"
          className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 text-sm text-foreground" />
        <Button type="submit" size="default" disabled={busy || !q.trim()}><Search /> Ask</Button>
      </form>
      <p className="text-micro text-foreground-secondary">Answers are assembled by fixed rules from your email; no AI model is used. Supported: open commitments, upcoming deadlines, decisions about a topic, changed decisions, conflicts, a named person, a named project, evidence for an item.</p>
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      {answer && (
        <Panel data-testid="email-answer">
          <p className={answer.supported ? 'text-sm text-foreground' : 'text-sm text-foreground-secondary'}>{answer.summary}</p>
          {answer.ambiguous && <ul className="mt-2 text-micro text-foreground-secondary">{answer.ambiguous.map((p) => <li key={p.key}>{p.names.join(' / ')} · {p.address}</li>)}</ul>}
          <ItemList items={answer.items} onEvidence={onEvidence} empty={answer.supported && !answer.ambiguous ? 'Nothing found.' : ''} />
          {answer.superseded && answer.superseded.length > 0 && <Related title="Earlier decisions, since replaced" items={answer.superseded} onEvidence={onEvidence} />}
          {answer.possiblyInvolving && answer.possiblyInvolving.length > 0 && <Related title="May involve them (no one is named — inference)" items={answer.possiblyInvolving} onEvidence={onEvidence} />}
          <Conflicts groups={answer.contradictions} onEvidence={onEvidence} />
        </Panel>
      )}
    </div>
  );
}

export default function GmailIntelligencePage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connState, setConnState] = useState<'loading' | 'ready' | 'unavailable' | 'error'>('loading');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [evidenceId, setEvidenceId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setConnState('loading'); setOverviewError(null);
    try { setConnections(await fetchConnections()); setConnState('ready'); }
    catch (e) { setConnState(e instanceof EmailApiError && e.kind === 'unavailable' ? 'unavailable' : 'error'); return; }
    try { setOverview(await fetchOverview()); } catch (e) { setOverviewError(errText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const outcome = useConnectOutcome();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const onAction = useCallback(async (connectionId: string, action: ConnectionAction) => {
    const question = CONFIRM[action];
    if (question && !window.confirm(question)) return;
    setBusy(true); setActionError(null);
    try { await connectionAction(connectionId, action); }
    catch (e) { setActionError(errText(e)); }
    finally { setBusy(false); }
    await load();
  }, [load]);

  // While a sync runs on the server, poll its status; reload everything when it ends.
  const syncing = connections.some((c) => c.syncing);
  useEffect(() => {
    if (!syncing) return;
    const t = window.setInterval(() => {
      fetchConnections().then((next) => {
        if (next.some((c) => c.syncing)) setConnections(next);
        else void load();
      }).catch(() => {});
    }, 3000);
    return () => window.clearInterval(t);
  }, [syncing, load]);

  const connected = connections.some((c) => c.connectorId === 'gmail');
  const empty = overview !== null && overview.counts.items === 0;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
      <SectionHeader eyebrow="Email" title="What your email says" aside={<Button variant="ghost" size="icon" aria-label="Refresh" onClick={() => void load()}><RefreshCcw /></Button>} />
      <div className="space-y-4">
        {outcome && <Panel><p className="text-sm text-foreground" role="status" data-testid="connect-outcome">{outcome}</p></Panel>}
        <ConnectionStatus connections={connections} state={connState} onAction={(id, a) => void onAction(id, a)} busy={busy} />
        {actionError && <p className="text-sm text-danger" role="alert">{actionError}</p>}
        <RetentionNotice />
        {connState === 'ready' && overviewError && <p className="text-sm text-danger" role="alert">{overviewError}</p>}
        {connState === 'ready' && !overview && !overviewError && <Skeleton className="h-32 w-full" />}
        {overview && empty && <Panel><p className="text-sm text-foreground-secondary">{connected ? 'No commitments, deadlines or decisions have been found in your imported email yet.' : 'Connect Gmail to see what your email says. Nothing is shown until email is imported.'}</p></Panel>}
        {overview && !empty && (
          <Tabs defaultValue="overview">
            <TabsList className="flex w-full flex-wrap">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="commitments">Commitments</TabsTrigger>
              <TabsTrigger value="deadlines">Deadlines</TabsTrigger>
              <TabsTrigger value="decisions">Decisions</TabsTrigger>
              <TabsTrigger value="people">People &amp; projects</TabsTrigger>
              <TabsTrigger value="conflicts">Conflicts</TabsTrigger>
              <TabsTrigger value="ask">Ask</TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="email-counts">
                {([['Open commitments', overview.counts.openCommitments], ['Open requests', overview.counts.openTasks], ['Upcoming dates', overview.counts.upcoming], ['Conflicts', overview.counts.contradictions]] as const).map(([label, n]) => (
                  <Panel key={label} className="p-3"><p className="text-xl font-semibold text-foreground">{n}</p><p className="text-micro text-foreground-secondary">{label}</p></Panel>
                ))}
              </div>
              <Panel><p className="text-sm font-medium text-foreground">Coming up</p><ItemList items={overview.upcoming} onEvidence={setEvidenceId} empty="No upcoming dates found." /></Panel>
              <Panel><p className="text-sm font-medium text-foreground">Open commitments</p><ItemList items={overview.openCommitments} onEvidence={setEvidenceId} empty="No open commitments found." /></Panel>
              {overview.contradictions.length > 0 && <Panel><p className="text-sm font-medium text-foreground">Conflicting statements</p><Conflicts groups={overview.contradictions} onEvidence={setEvidenceId} /></Panel>}
            </TabsContent>
            <TabsContent value="commitments" className="space-y-4">
              <Panel><p className="text-sm font-medium text-foreground">Promises</p><PagedItems view="commitments" onEvidence={setEvidenceId} empty="No open commitments found." /></Panel>
              <Panel><p className="text-sm font-medium text-foreground">Requests</p><PagedItems view="tasks" onEvidence={setEvidenceId} empty="No open requests found." /></Panel>
            </TabsContent>
            <TabsContent value="deadlines"><Panel><PagedItems view="deadlines" onEvidence={setEvidenceId} empty="No upcoming dates found." /></Panel></TabsContent>
            <TabsContent value="decisions" className="space-y-4">
              <Panel><p className="text-sm font-medium text-foreground">Current decisions</p><PagedItems view="decisions" onEvidence={setEvidenceId} empty="No current decisions found." /></Panel>
              <Panel><p className="text-sm font-medium text-foreground">Superseded decisions</p><PagedItems view="superseded" onEvidence={setEvidenceId} empty="No decisions have been changed." /></Panel>
            </TabsContent>
            <TabsContent value="people"><PeopleProjects onEvidence={setEvidenceId} /></TabsContent>
            <TabsContent value="conflicts"><ConflictsView onEvidence={setEvidenceId} /></TabsContent>
            <TabsContent value="ask"><AskPanel onEvidence={setEvidenceId} /></TabsContent>
          </Tabs>
        )}
      </div>
      <EvidenceDialog id={evidenceId} onClose={() => setEvidenceId(null)} onEvidence={setEvidenceId} />
    </div>
  );
}
