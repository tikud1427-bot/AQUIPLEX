import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { CompactBelief, Goal, MindModel } from '@/api/mind';

/**
 * UI leak audit, second pass (2026-10-28 evening). Each test pins a defect
 * found in this pass, not a hypothetical:
 *   1. raw server/JS errors in chat bubbles and toasts (router chain, stack)
 *   2. unknown enum values rendered or guessed at
 *   3. forecasts with fixed "probabilities" on the Understanding page
 *   4. "Established: domain:alpha" — reflection keys sliced past the guard
 *   5. deletes with no confirmation that hid failures (drawer, Memory page,
 *      whole-model erase), and "Forget everything" leaving cleared claims up
 * Uncalibrated percentages are in unsupportedNumbers.test.tsx; the first pass
 * of leaks is uiLeaks.test.tsx; the server half is
 * aqua/src/routes/tests/{uiPayloadContract,chatErrorExposure}.test.js.
 */

if (!('IntersectionObserver' in globalThis)) {
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
}

/** What axios rejects with for a non-2xx response (axios.isAxiosError reads the flag). */
function httpError(status: number, data: unknown) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true, response: { status, data },
  });
}
const UNAVAILABLE = 'Memory is temporarily unavailable — nothing was changed. Please try again.';

const fetchMind = vi.fn();
const explainBelief = vi.fn();
const deleteBelief = vi.fn();
const eraseMind = vi.fn();
vi.mock('@/api/mind', async (orig) => ({
  ...(await orig<typeof import('@/api/mind')>()),
  fetchMind: () => fetchMind(),
  fetchGraph: () => Promise.resolve({ success: true, nodes: [], edges: [] }),
  explainBelief: (d: string, k: string) => explainBelief(d, k),
  deleteBelief: (d: string, k: string) => deleteBelief(d, k),
  eraseMind: () => eraseMind(),
}));
vi.mock('@/api/understanding', async (orig) => ({
  ...(await orig<typeof import('@/api/understanding')>()),
  fetchUnderstanding: () => Promise.reject(new Error('not under test')),
  fetchChanges: () => Promise.resolve([]),
}));
const listMemory = vi.fn();
const listCurrentClaims = vi.fn();
const forgetClaim = vi.fn();
const forgetMemoryFact = vi.fn();
const forgetAllMemory = vi.fn();
vi.mock('@/api/memory', () => ({
  listMemory: () => listMemory(),
  memoryTimeline: () => Promise.resolve({ success: true, changes: [] }),
  listCurrentClaims: () => listCurrentClaims(),
  forgetClaim: (id: string) => forgetClaim(id),
  forgetMemoryFact: (k: string) => forgetMemoryFact(k),
  forgetAllMemory: () => forgetAllMemory(),
  keepSensitiveFact: vi.fn(), correctClaimValue: vi.fn(), pinMemoryFact: vi.fn(),
}));

const { userErrorMessage, GENERIC_ERROR } = await import('@/lib/userError');
const { normalizeError } = await import('@/api/client');
const { dimensionLabel, beliefBasis } = await import('@/lib/displayGuard');
const { ProvenanceBadge } = await import('@/components/ui/provenance-badge');
const { GoalsSection } = await import('@/features/mind/NowSections');
const { BeliefDrawer } = await import('@/features/mind/BeliefDrawer');
const { PrivacyPanel } = await import('@/features/mind/ReflectionAndPrivacy');
const { default: MindPage } = await import('@/pages/MindPage');
const { default: MemoryPage } = await import('@/pages/MemoryPage');
const { useMindStore } = await import('@/stores/mindStore');
const { useUiStore } = await import('@/stores/uiStore');

beforeEach(() => {
  useMindStore.setState(useMindStore.getInitialState(), true);
  useUiStore.setState({ toasts: [] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const toastText = () => useUiStore.getState().toasts.map((t) => `${t.variant}: ${t.title} — ${t.description ?? ''}`).join('\n');

const belief = (over: Partial<CompactBelief>): CompactBelief => ({
  dimension: 'identity', key: 'role', value: 'founder', confidence: 0.9, evidenceCount: 2, contradictions: 0,
  status: 'active', locked: false, temporary: false, source: 'explicit', updatedAt: Date.now(), ...over,
});
const goal = (over: Partial<Goal>): Goal => ({
  id: 'g1', title: 'Ship the beta', priority: 5, progress: 0.4, deadline: null, dependencies: [], blockers: [],
  relatedProjects: [], status: 'active', confidence: 0.55, mentions: 2, createdAt: 1, updatedAt: 1, lastMentionedAt: Date.now(), ...over,
});
function mindModel(over: Partial<MindModel> = {}): MindModel {
  return {
    success: true, ownerId: 'user:x', turnCount: 9, createdAt: 1, updatedAt: 1,
    identity: [belief({})], personality: [], communication: [], preferences: [], knowledge: [], behavior: [], decision: [],
    goals: [goal({})], activeGoals: ['g1'], episodes: [], timeline: [], lastReflectionAt: null,
    graph: { nodeCount: 0, edgeCount: 0 },
    working: { focus: [], focusRanked: [], blockers: [], deadlines: [], recentDiscoveries: [], openQuestions: [], updatedAt: 1 },
    predictions: [
      { label: 'Likely to continue debugging this issue', probability: 0.7, basis: 'current task momentum', ts: 1 },
      { label: 'Next questions likely about: simple_qa', probability: 0.6, basis: 'dominant working-memory focus', ts: 1 },
    ],
    reflections: [{
      ts: Date.now() - 1000, turnCount: 9, weakened: [], promoted: [], archived: [], goalsStaled: [], episodesClosed: 0, graphPruned: 0, expired: [],
      learned: [{ key: 'knowledge:domain:alpha', value: 'familiar', confidence: 0.6 }, { key: 'identity:custom_very_bored', value: 'x', confidence: 0.5 }, { key: 'identity:role', value: 'founder', confidence: 0.9 }],
    }],
    ...over,
  };
}

describe('1. errors are sentences, never internals', () => {
  it('router chains, stack frames, driver errors and key fragments become a generic sentence', () => {
    for (const raw of [
      'All providers exhausted | task=simple_qa | chain=groq:failed(config) → gemini:failed(config)',
      "TypeError: Cannot read properties of undefined (reading 'map')\n    at buildPrompt (chat.js:120:5)",
      'connect ECONNREFUSED 127.0.0.1:5432',
      'E11000 duplicate key error collection: aqua.users index: email_1',
      'Incorrect API key provided: sk-proj-abc123XYZ',
      'Request failed with status code 500',
    ]) expect(userErrorMessage(raw), raw).toBe(GENERIC_ERROR);
  });

  it('a guard’s own sentence passes through (positive control)', () => {
    expect(userErrorMessage("You're out of credits. Top up to keep chatting.")).toBe("You're out of credits. Top up to keep chatting.");
    expect(userErrorMessage(UNAVAILABLE)).toBe(UNAVAILABLE);
  });

  it('normalizeError sanitises a server body that carries the router chain', () => {
    const err = httpError(500, { error: 'All providers exhausted | task=reasoning | chain=nvidia:failed(auth)' });
    expect(normalizeError(err).message).toBe(GENERIC_ERROR);
    expect(normalizeError(httpError(503, { error: UNAVAILABLE })).message).toBe(UNAVAILABLE);
  });
});

describe('design system: cn keeps the type scale', () => {
  it('a custom text size survives being combined with a text colour', async () => {
    const { cn } = await import('@/lib/utils');
    expect(cn('text-micro text-foreground-secondary')).toBe('text-micro text-foreground-secondary');
    expect(cn('rounded-full text-micro', 'text-primary')).toContain('text-micro');
    expect(cn('text-micro', 'text-caption')).toBe('text-caption'); // two sizes still resolve
  });
});

describe('2. unknown enum values fail safely', () => {
  it('an unknown dimension or provenance prints nothing rather than a guess', () => {
    expect(dimensionLabel('decision')).toBe('Decisions');
    expect(dimensionLabel('weird_internal_dimension')).toBeNull();
    expect(beliefBasis({ source: 'llm_v2_guess' })).toBeNull();
    const { container } = render(<ProvenanceBadge source="llm_v2_guess" evidenceCount={0} />);
    expect(container.innerHTML).toBe('');
  });

  it('a goal with a status the page does not know shows its title and no invented status', () => {
    const { container } = render(<GoalsSection goals={[goal({ status: 'superseded_internal' as Goal['status'] })]} />);
    expect(screen.getByText('Ship the beta')).toBeTruthy();
    expect(container.textContent).not.toMatch(/superseded_internal|undefined/);
  });
});

describe('3–4. the Understanding page', () => {
  async function renderMind(m = mindModel()) {
    fetchMind.mockResolvedValue(m);
    render(<MemoryRouter><MindPage /></MemoryRouter>);
    await screen.findByText('A living model of you');
  }

  it('shows no forecasts — fixed-score templates are not a prediction', async () => {
    await renderMind();
    expect(screen.queryByText('What Aqua expects next')).toBeNull();
    expect(screen.queryByText(/Likely to continue debugging/)).toBeNull();
    expect(screen.queryByText(/simple[_ ]qa/i)).toBeNull();
  });

  it('seeds "What Aqua learned" only from beliefs the page shows (no "domain:alpha", no custom_ slug)', async () => {
    await renderMind();
    expect(screen.getByText('Established: role')).toBeTruthy();
    expect(screen.queryByText(/alpha|custom|very bored/i)).toBeNull();
  });

  it('prints no percentage anywhere, and no constant "priority 5"', async () => {
    await renderMind();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\d+\s*%/);
    expect(text).not.toMatch(/priority 5/);
    expect(screen.getByText('You said this')).toBeTruthy(); // stated, not inferred
  });
});

describe('5. destructive actions are confirmed and report the server’s real result', () => {
  it('belief drawer: forget asks first; a server failure is shown and the drawer stays open', async () => {
    explainBelief.mockResolvedValue({
      dimension: 'identity', key: 'role', value: 'founder', confidence: 0.9, evidenceCount: 2, contradictions: 0,
      explanation: 'You said this.', recentEvidence: [{ ts: Date.now(), conversationId: 'c1', signal: 'You said this', delta: 0, support: true }],
    });
    deleteBelief.mockRejectedValueOnce(httpError(503, { error: UNAVAILABLE }));
    const onClose = vi.fn();
    render(<BeliefDrawer belief={belief({ dimension: 'decision' })} onClose={onClose} />);
    expect(await screen.findByText('Decisions')).toBeTruthy(); // label, not the raw id
    await screen.findAllByText('You said this.');

    fireEvent.click(screen.getByRole('button', { name: /Forget this entirely/ }));
    expect(deleteBelief).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Forget it' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', UNAVAILABLE);
    expect(onClose).not.toHaveBeenCalled();

    deleteBelief.mockResolvedValueOnce({ success: true });
    fireEvent.click(screen.getByRole('button', { name: /Forget this entirely/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Forget it' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toastText()).toMatch(/success: Forgotten/);
  });

  it('Memory page: a delete asks first; on failure the row stays and the server’s reason is shown', async () => {
    listMemory.mockResolvedValue({ success: true, ownerId: 'user:x', factCount: 0, facts: [] });
    listCurrentClaims.mockResolvedValue({ success: true, configured: true, claims: [
      { claimId: 'c1', statement: 'You live in Pune', quote: 'I moved to Pune last year', sourceKind: 'conversation', assertedAt: null, disputed: false },
    ] });
    forgetClaim.mockRejectedValueOnce(httpError(503, { error: UNAVAILABLE }));
    render(<MemoryRouter><MemoryPage /></MemoryRouter>);
    await screen.findByText('You live in Pune');

    fireEvent.click(screen.getByRole('button', { name: 'Delete: You live in Pune' }));
    expect(forgetClaim).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(forgetClaim).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(toastText()).toContain(UNAVAILABLE));
    expect(screen.getByText('You live in Pune')).toBeTruthy();
  });

  it('Memory page: "Forget everything" re-reads the server, so cleared World Model claims leave the page', async () => {
    listMemory.mockResolvedValue({ success: true, ownerId: 'user:x', factCount: 1, facts: [{ key: 'city', value: 'Pune', category: 'location', createdAt: Date.now() }] });
    listCurrentClaims.mockResolvedValueOnce({ success: true, configured: true, claims: [
      { claimId: 'c1', statement: 'You live in Pune', quote: null, sourceKind: 'conversation', assertedAt: null, disputed: false },
    ] });
    forgetAllMemory.mockResolvedValue({ success: true, ownerId: 'user:x', cleared: true });
    render(<MemoryRouter><MemoryPage /></MemoryRouter>);
    await screen.findByText('You live in Pune');

    listMemory.mockResolvedValue({ success: true, ownerId: 'user:x', factCount: 0, facts: [] });
    listCurrentClaims.mockResolvedValue({ success: true, configured: true, claims: [] });
    fireEvent.click(screen.getByRole('button', { name: /Forget everything/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Forget everything' }));
    await screen.findByText(/doesn.t know anything about you yet/);
    expect(screen.queryByText('You live in Pune')).toBeNull();
  });

  it('erasing the whole model: a failure says so and the model stays on screen', async () => {
    const m = mindModel();
    useMindStore.setState({ model: m, hasLoadedOnce: true });
    eraseMind.mockRejectedValueOnce(httpError(500, { error: 'MongoServerError: not primary' }));
    render(<PrivacyPanel model={m} />);
    fireEvent.click(screen.getByRole('button', { name: /Delete the entire model/ }));
    fireEvent.click(screen.getByRole('button', { name: /Yes, delete everything/ }));
    await waitFor(() => expect(toastText()).toMatch(/error: Could not delete the model/));
    expect(toastText()).not.toMatch(/Mongo/);
    expect(useMindStore.getState().model).toBe(m);
  });
});

describe('6. page organisation (2026-10-28 context pass)', () => {
  it('Memory groups lead with who you are; the catch-all is last whatever its size', async () => {
    const day = 24 * 3600 * 1000;
    const now = Date.now();
    listMemory.mockResolvedValue({ success: true, ownerId: 'user:x', factCount: 5, facts: [
      { key: 'custom_a', value: 'likes rain', category: 'custom', createdAt: now },
      { key: 'custom_b', value: 'hates queues', category: 'custom', createdAt: now },
      { key: 'custom_c', value: 'reads at night', category: 'custom', createdAt: now },
      { key: 'favorite_food', value: 'momos', category: 'food', createdAt: now },
      { key: 'name', value: 'Asha', category: 'identity', createdAt: now - 30 * day, lastConfirmedAt: now - 2 * day },
    ] });
    listCurrentClaims.mockResolvedValue({ success: true, configured: false, claims: [] });
    render(<MemoryRouter><MemoryPage /></MemoryRouter>);
    await screen.findByText('Asha');
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    const order = ['Identity', 'Food', 'Other things you’ve said'].map((h) => headings.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Learned a month ago, said again two days ago: both moments shown.
    expect(screen.getByText(/You last said this/)).toBeTruthy();
    expect(screen.getAllByText(/You last said this/)).toHaveLength(1);
  });

  it('Understanding has a section index whose links reach real sections', async () => {
    fetchMind.mockResolvedValue(mindModel());
    render(<MemoryRouter><MindPage /></MemoryRouter>);
    await screen.findByText('A living model of you');
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Identity', 'Goals', 'Right now', 'Projects & sources', 'Map', 'Timeline', 'Privacy']);
    for (const l of links) {
      const id = l.getAttribute('href')!.slice(1);
      expect(document.getElementById(id), id).not.toBeNull();
    }
  });
});
