import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Gmail Phase 5 — the Email page: honest states (unavailable / not connected /
 * never synchronised / error), labels that separate direct statements from
 * inferences and current from superseded/contradicted, nothing shown as
 * verified, and evidence one click away. No real API is called.
 */
const fetchConnections = vi.fn();
const fetchOverview = vi.fn();
const fetchEvidence = vi.fn();
const connectionAction = vi.fn();
vi.mock('@/api/gmailIntelligence', async (orig) => ({
  ...(await orig<typeof import('@/api/gmailIntelligence')>()),
  connectionAction: (id: string, a: string) => connectionAction(id, a),
  fetchConnections: () => fetchConnections(),
  fetchOverview: () => fetchOverview(),
  fetchEvidence: (id: string) => fetchEvidence(id),
  fetchView: vi.fn(async () => ({ total: 0, items: [], nextCursor: null })),
  askEmail: vi.fn(),
}));
const { EmailApiError } = await import('@/api/gmailIntelligence');
const { default: GmailIntelligencePage } = await import('@/pages/GmailIntelligencePage');

const item = (over: Record<string, unknown>) => ({
  id: 'aaaaaaaaaaaaaaaa', type: 'commitment', status: 'current', statement: 'I will send the deck by Wednesday.', basis: 'direct', explicit: true,
  certainty: 'stated', confidence: 0.8, userConfirmed: false, due: '2026-01-07', dueResolution: 'relative',
  source: { gmailMessageId: 'm1', threadId: 't1', threadTopic: 'launch plan', sentAt: '2026-01-06T09:00:00.000Z', extractedAt: '2026-01-06T09:01:00.000Z' },
  supersededBy: null, supersedes: null, conflictsWith: [], evidenceIds: ['aaaaaaaaaaaaaaaa'], ...over,
});
const counts = (n: number) => ({ openCommitments: n, openTasks: 0, upcoming: n, currentDecisions: 0, supersededDecisions: 0, contradictions: n ? 1 : 0, people: n, projects: 0, conversations: n, items: n * 3 });
const CONNECTED = [{ connectionId: 'conn_1', connectorId: 'gmail', status: 'active', account: { label: 'Gmail · a***@example.test' }, hasCredentials: true, lastSync: null }];

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Email page — honest states', () => {
  it('Gmail Connect off on this server: says so; no tabs, no knowledge', async () => {
    fetchConnections.mockRejectedValue(new EmailApiError('unavailable', 'Gmail connection is not available on this server.'));
    render(<GmailIntelligencePage />);
    expect(await screen.findByText('Gmail connection is not available on this server.')).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(fetchOverview).not.toHaveBeenCalled();
  });

  it('not connected: says nothing was imported; never claims a connection or a sync', async () => {
    fetchConnections.mockResolvedValue([]);
    fetchOverview.mockResolvedValue({ counts: counts(0), upcoming: [], openCommitments: [], openTasks: [], contradictions: [] });
    render(<GmailIntelligencePage />);
    expect(await screen.findByText('Gmail is not connected. Nothing has been imported.')).toBeTruthy();
    expect(await screen.findByText(/Connect Gmail to see what your email says/)).toBeTruthy();
    expect(screen.queryByText('Connected')).toBeNull();
    expect(screen.queryByText(/Last sync/)).toBeNull();
  });

  it('connected but never synchronised: "Not synchronised yet"', async () => {
    fetchConnections.mockResolvedValue(CONNECTED);
    fetchOverview.mockResolvedValue({ counts: counts(0), upcoming: [], openCommitments: [], openTasks: [], contradictions: [] });
    render(<GmailIntelligencePage />);
    expect(await screen.findByText('Not synchronised yet')).toBeTruthy();
    expect(await screen.findByText(/No commitments, deadlines or decisions have been found/)).toBeTruthy();
  });

  it('an overview error is shown as an error, not as an empty mailbox', async () => {
    fetchConnections.mockResolvedValue(CONNECTED);
    fetchOverview.mockRejectedValue(new EmailApiError('error', 'Email knowledge could not be loaded. Try again.'));
    render(<GmailIntelligencePage />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be loaded/);
    expect(screen.queryByText(/No commitments/)).toBeNull();
  });

  it('the retention notice explains what revoking and disconnecting do to imported email', async () => {
    fetchConnections.mockResolvedValue([]);
    fetchOverview.mockResolvedValue({ counts: counts(0), upcoming: [], openCommitments: [], openTasks: [], contradictions: [] });
    render(<GmailIntelligencePage />);
    expect(await screen.findByText('What happens to imported email')).toBeTruthy();
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/Revoke access.*Email already imported stays until you disconnect/);
    expect(text).toMatch(/Disconnect.*every imported email and everything extracted from it is deleted/);
    expect(text).toMatch(/never sent to an AI model/);
  });
});

describe('Email page — labels and evidence', () => {
  it('separates direct from inference and current from contradicted; nothing is shown as verified; evidence opens', async () => {
    fetchConnections.mockResolvedValue([{ ...CONNECTED[0], lastSync: { state: 'succeeded', finishedAt: '2026-01-06T10:00:00.000Z' } }]);
    const conflictA = item({ id: 'bbbbbbbbbbbbbbbb', type: 'date', status: 'contradicted', statement: 'The launch is March 15.', basis: 'direct', due: '2026-03-15' });
    const conflictB = item({ id: 'cccccccccccccccc', type: 'date', status: 'contradicted', statement: 'The launch is March 20.', basis: 'direct', due: '2026-03-20' });
    fetchOverview.mockResolvedValue({
      counts: counts(1),
      upcoming: [item({ id: 'dddddddddddddddd', type: 'event', statement: 'Kickoff call on Thursday.', basis: 'inference', certainty: 'likely', explicit: false, due: '2026-01-08' })],
      openCommitments: [item({}), item({ id: 'eeeeeeeeeeeeeeee', statement: 'If approved, I will hire two engineers.', basis: 'inference', certainty: 'uncertain', explicit: false, due: null })],
      openTasks: [], contradictions: [{ items: [conflictA, conflictB], note: 'These statements conflict; neither has been confirmed.' }],
    });
    fetchEvidence.mockResolvedValue({
      item: item({}), evidence: { gmailMessageId: 'm1', threadId: 't1', threadTopic: 'launch plan', sentAt: '2026-01-06T09:00:00.000Z', extractedAt: '2026-01-06T09:01:00.000Z', field: 'body', span: [0, 34], quote: "Update: I'll send it by Wednesday instead." },
      supersededBy: [], supersedes: [item({ id: 'ffffffffffffffff', status: 'superseded', statement: "I'll send the deck by Monday." })], conflictsWith: [],
    });
    render(<GmailIntelligencePage />);
    await screen.findByTestId('email-counts');
    expect(screen.getAllByText('Direct statement').length).toBeGreaterThan(0);
    expect(screen.getByText('Inference · uncertain')).toBeTruthy();
    expect(screen.getByText('Inference')).toBeTruthy();
    expect(screen.getAllByText('Contradicted').length).toBe(2);
    expect(screen.getByText('These statements conflict; neither has been confirmed.')).toBeTruthy();
    expect(screen.getAllByText('Not verified · not marked done').length).toBe(2);
    expect(document.body.textContent).not.toMatch(/\b(completed|verified ✓|confirmed fact)\b/i);
    expect(screen.getByText(/Last sync succeeded/)).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: /Show evidence for: I will send the deck/ })[0]);
    await waitFor(() => expect(fetchEvidence).toHaveBeenCalledWith('aaaaaaaaaaaaaaaa'));
    const detail = await screen.findByTestId('evidence-detail');
    expect(detail.textContent).toMatch(/I'll send it by Wednesday instead/);
    expect(detail.textContent).toMatch(/This replaced/);
    expect(detail.textContent).toMatch(/Superseded/);
  });

  it('evidence for an item whose email was deleted says so', async () => {
    fetchConnections.mockResolvedValue(CONNECTED);
    fetchOverview.mockResolvedValue({ counts: counts(1), upcoming: [], openCommitments: [item({})], openTasks: [], contradictions: [] });
    fetchEvidence.mockRejectedValue(new EmailApiError('not-found', 'Not found'));
    render(<GmailIntelligencePage />);
    fireEvent.click((await screen.findAllByRole('button', { name: /Show evidence for/ }))[0]);
    expect((await screen.findByRole('alert')).textContent).toMatch(/no longer exists/);
  });

  it('Gmail Phase 6: an item a later email closed is never labelled Current', async () => {
    const { StatusBadge } = await import('@/pages/GmailIntelligencePage');
    const { container: done } = render(<StatusBadge status="completed" />);
    expect(done.textContent).toBe('Reported done in email');
    const { container: off } = render(<StatusBadge status="cancelled" />);
    expect(off.textContent).toBe('Called off in email');
    expect(`${done.textContent}${off.textContent}`).not.toMatch(/Current|verified|confirmed/i);
  });
});

describe('Email page — connection controls (finalization)', () => {
  const EMPTY = { counts: counts(0), upcoming: [], openCommitments: [], openTasks: [], contradictions: [] };
  const conn = (over: Record<string, unknown> = {}) => [{ ...CONNECTED[0], ...over }];

  it('not connected: "Connect Gmail" navigates to the server OAuth start (same origin, full page)', async () => {
    fetchConnections.mockResolvedValue([]);
    fetchOverview.mockResolvedValue(EMPTY);
    const assign = vi.fn();
    const orig = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...orig, assign, search: '', href: 'http://localhost/aqua/email' } });
    try {
      render(<GmailIntelligencePage />);
      fireEvent.click(await screen.findByRole('button', { name: 'Connect Gmail' }));
      expect(assign).toHaveBeenCalledWith('/api/aqua/connect/gmail/start');
    } finally { Object.defineProperty(window, 'location', { configurable: true, value: orig }); }
  });

  it('connected: "Sync now" starts a sync and reloads; while syncing it is disabled and says so', async () => {
    fetchConnections.mockResolvedValueOnce(conn()).mockResolvedValue(conn({ syncing: true }));
    fetchOverview.mockResolvedValue(EMPTY);
    connectionAction.mockResolvedValue(undefined);
    render(<GmailIntelligencePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(connectionAction).toHaveBeenCalledWith('conn_1', 'sync'));
    expect(await screen.findByText('Syncing…')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Sync now' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('disconnect and revoke ask first; cancelling does nothing', async () => {
    fetchConnections.mockResolvedValue(conn());
    fetchOverview.mockResolvedValue(EMPTY);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<GmailIntelligencePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(String(confirm.mock.calls[0][0])).toMatch(/deleted\. This cannot be undone/);
    expect(connectionAction).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(connectionAction).toHaveBeenCalledWith('conn_1', 'disconnect'));
    confirm.mockRestore();
  });

  it('paused: Sync now is disabled and Resume is offered; revoked: Reconnect is offered, no Sync', async () => {
    fetchConnections.mockResolvedValue(conn({ syncPaused: true }));
    fetchOverview.mockResolvedValue(EMPTY);
    render(<GmailIntelligencePage />);
    expect((await screen.findByRole('button', { name: 'Sync now' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Resume sync' }));
    await waitFor(() => expect(connectionAction).toHaveBeenCalledWith('conn_1', 'resume'));
    cleanup();
    fetchConnections.mockResolvedValue(conn({ status: 'revoked', hasCredentials: false }));
    render(<GmailIntelligencePage />);
    expect(await screen.findByRole('button', { name: 'Reconnect Gmail' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
  });

  it('the OAuth callback outcome is shown once and removed from the URL', async () => {
    window.history.replaceState(null, '', '/aqua/email?gmailConnect=failed&reason=STATE_EXPIRED');
    fetchConnections.mockResolvedValue([]);
    fetchOverview.mockResolvedValue(EMPTY);
    render(<GmailIntelligencePage />);
    expect((await screen.findByTestId('connect-outcome')).textContent).toBe('Gmail could not be connected. Try again. (STATE_EXPIRED)');
    await waitFor(() => expect(window.location.search).toBe(''));
  });
});

describe('Email page — sync progress (complete mailbox import)', () => {
  const EMPTY = { counts: counts(0), upcoming: [], openCommitments: [], openTasks: [], contradictions: [] };
  const show = async (over: Record<string, unknown>) => {
    cleanup();
    fetchConnections.mockResolvedValue([{ ...CONNECTED[0], ...over }]);
    fetchOverview.mockResolvedValue(EMPTY);
    render(<GmailIntelligencePage />);
    return (await screen.findByTestId('sync-phase')).textContent ?? '';
  };

  it('each phase is named; counts only; no percentage is ever shown', async () => {
    expect(await show({ syncPhase: 'not_started', imported: 0 })).toMatch(/^Initial import not started · 0 messages imported$/);
    const running = await show({ syncPhase: 'initial_in_progress', syncing: true, imported: 1234, progress: { listed: 1500, estimate: 98000 } });
    expect(running).toMatch(/Initial import in progress/);
    expect(running).toMatch(/1,234 messages imported/);
    expect(running).toMatch(/1,500 listed so far in this pass/);
    expect(running).not.toMatch(/%|98,000|98000/);
    expect(await show({ syncPhase: 'initial_interrupted', imported: 300, progress: { listed: 320 } })).toMatch(/Initial import interrupted — choose "Sync now" to continue/);
    const done = await show({ syncPhase: 'initial_complete', imported: 1, lastSync: { state: 'succeeded', finishedAt: '2026-01-06T09:00:00.000Z', lastSuccessAt: '2026-01-06T09:00:00.000Z' } });
    expect(done).toMatch(/Initial import complete · 1 message imported · last successful sync/);
    expect(await show({ syncPhase: 'incremental_in_progress', syncing: true, imported: 10 })).toMatch(/Checking for new email/);
    expect(await show({ syncPhase: 'failed', imported: 10, lastSync: { state: 'failed', finishedAt: '2026-01-06T09:00:00.000Z' } })).toMatch(/Last sync failed/);
    expect(await show({ syncPhase: 'paused', syncPaused: true, imported: 10 })).toMatch(/Sync paused · 10 messages imported/);
  });
});
