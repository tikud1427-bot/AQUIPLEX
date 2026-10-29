import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { CompactBelief, MindModel } from '@/api/mind';
import type { MemoryFact } from '@/types';

/**
 * UI leaks seen on production's Memory and Understanding pages (2026-10-28).
 * The server now strips these (aqua/src/routes/tests/uiPayloadContract.test.js);
 * these pin the frontend guard, fed the OLD server shapes, one test per class:
 *   a "event" rows · b custom_ headings · c collections as run-on strings /
 *   collection_merge · Task 1 hidden sensitive section · e/f Knowledge ·
 *   g intent ids · h hard-coded evidence · i unlabelled badge · j filenames.
 */

// jsdom has no IntersectionObserver (framer-motion's whileInView needs one).
// Plumbing only: it never reports an intersection, so it decides nothing here.
if (!('IntersectionObserver' in globalThis)) {
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
}

const listMemory = vi.fn();
const memoryTimeline = vi.fn();
const keepSensitiveFact = vi.fn();
const forgetMemoryFact = vi.fn();
vi.mock('@/api/memory', () => ({
  listMemory: () => listMemory(),
  memoryTimeline: () => memoryTimeline(),
  listCurrentClaims: () => Promise.resolve({ success: true, configured: false, claims: [] }),
  keepSensitiveFact: (k: string) => keepSensitiveFact(k),
  forgetMemoryFact: (k: string) => forgetMemoryFact(k),
  forgetAllMemory: vi.fn(), forgetClaim: vi.fn(), correctClaimValue: vi.fn(), pinMemoryFact: vi.fn(),
}));
const fetchGraph = vi.fn();
vi.mock('@/api/mind', async (orig) => ({ ...(await orig<typeof import('@/api/mind')>()), fetchGraph: () => fetchGraph() }));
const getPrivacy = vi.fn();
const setPrivacy = vi.fn();
vi.mock('@/api/account', async (orig) => ({
  ...(await orig<typeof import('@/api/account')>()),
  getPrivacy: () => getPrivacy(),
  setPrivacy: (p: unknown) => setPrivacy(p),
}));

const { default: MemoryPage } = await import('@/pages/MemoryPage');
const { MemoryTab } = await import('@/components/settings/MemoryTab');
const { BeliefCard } = await import('@/features/mind/IdentitySection');
const { KnowledgePanel, CommunicationSection } = await import('@/features/mind/ModelSections');
const { WorkingMemorySection } = await import('@/features/mind/NowSections');
const { MindTimeline } = await import('@/features/mind/StorySections');
const { RelationshipGraph } = await import('@/features/mind/RelationshipGraph');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const fact = (over: Partial<MemoryFact>): MemoryFact => ({ key: 'k', value: 'v', createdAt: Date.now(), ...over });
const belief = (over: Partial<CompactBelief>): CompactBelief => ({
  dimension: 'identity', key: 'k', value: true, confidence: 0.9, evidenceCount: 1, contradictions: 0,
  status: 'active', locked: false, temporary: false, source: 'inference', updatedAt: Date.now(), ...over,
});

/** The pre-fix server: no label/items, everything in `facts`, raw change labels. */
function oldServerMemory() {
  listMemory.mockResolvedValue({
    success: true, ownerId: 'user:x', factCount: 3,
    facts: [
      fact({ key: 'custom_student_with_almost_zero_networth', value: 'student with almost zero networth', category: 'custom' }),
      fact({ key: 'goal', value: ['becoming a billionaire', 'be topper in both courses'] as unknown as string, category: 'goals' }),
      fact({ key: 'city', value: 'Pune', category: 'location' }),
    ],
    hiddenSensitive: [fact({ key: 'custom_very_bored', value: 'very bored', sensitivity: 'mood', items: ['Very bored'] })],
  });
  memoryTimeline.mockResolvedValue({
    success: true, ownerId: 'user:x', days: 30,
    changes: [
      { at: Date.now(), kind: 'event', label: 'event' },
      { at: Date.now(), kind: 'fact_new', label: 'custom_networth = "almost zero"' },
      { at: Date.now(), kind: 'fact_change', label: 'goal: was "becoming a billionaire" (collection_merge)' },
      { at: Date.now(), kind: 'goal_created', label: 'Started working toward ship the beta' },
    ],
  });
}
async function renderMemory() {
  oldServerMemory();
  render(<MemoryRouter><MemoryPage /></MemoryRouter>);
  await screen.findByText('What AQUA remembers');
}

describe('Memory page', () => {
  it('(a) "Recently learned" shows no bare "event" rows', async () => {
    await renderMemory();
    await screen.findByText('Started working toward ship the beta');
    expect(screen.queryByText(/^event$/i)).toBeNull();
  });

  it('(b) a custom_ key is never a heading; such facts group under "Other things you’ve said"', async () => {
    await renderMemory();
    expect(screen.queryByText(/custom/i)).toBeNull();
    expect(screen.getByText('Other things you’ve said')).toBeTruthy();
    expect(screen.getByText('student with almost zero networth')).toBeTruthy();
  });

  it('(c) a collection renders as distinct list items; no internal operation names', async () => {
    await renderMemory();
    const first = screen.getByText('becoming a billionaire');
    expect(first.tagName).toBe('LI');
    expect(screen.getByText('be topper in both courses').tagName).toBe('LI');
    expect(screen.queryByText(/becoming a billionairebe/)).toBeNull();
    await screen.findByText('Started working toward ship the beta');
    expect(screen.queryByText(/collection_merge/)).toBeNull();
  });

  it('Task 1: sensitive facts sit in a collapsed "Hidden from AQUA — sensitive" section with Delete / Keep', async () => {
    keepSensitiveFact.mockResolvedValue({ success: true, ownerId: 'user:x' });
    await renderMemory();
    const section = screen.getByTestId('hidden-sensitive');
    expect(section.tagName).toBe('DETAILS');
    expect((section as HTMLDetailsElement).open).toBe(false);
    expect(within(section).getByText(/Hidden from AQUA — sensitive/)).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Keep: Very bored' }));
    await waitFor(() => expect(keepSensitiveFact).toHaveBeenCalledWith('custom_very_bored'));
    expect(within(section).getByRole('button', { name: 'Delete: Very bored' })).toBeTruthy();
  });
});

describe('Settings', () => {
  it('Task 1: the health/mood toggle is off by default and saves', async () => {
    listMemory.mockResolvedValue({ success: true, ownerId: 'user:x', factCount: 0, facts: [] });
    getPrivacy.mockResolvedValue({ rememberSensitive: false });
    setPrivacy.mockResolvedValue({ rememberSensitive: true });
    render(<MemoryRouter><MemoryTab /></MemoryRouter>);
    const toggle = await screen.findByRole('switch', { name: 'Let AQUA remember health and mood details (off by default)' });
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    fireEvent.click(toggle);
    await waitFor(() => expect(setPrivacy).toHaveBeenCalledWith({ rememberSensitive: true }));
  });
});

describe('Understanding page', () => {
  const noop = () => {};

  it('(e) knowledge labels never carry the "Domain:" prefix', () => {
    const k = (key: string, label?: string) => belief({ dimension: 'knowledge', key, label, value: 'familiar' });
    render(<KnowledgePanel beliefs={[k('domain:machine_learning'), k('domain:statistics', 'Statistics'), k('tech:react')]} onSelect={noop} />);
    expect(screen.getByText('Machine learning')).toBeTruthy();
    expect(screen.getByText('Statistics')).toBeTruthy();
    expect(screen.queryByText(/domain:/i)).toBeNull();
  });

  it('(f) the Knowledge panel is absent with fewer than 3 real observations', () => {
    const k = (key: string) => belief({ dimension: 'knowledge', key, value: 'familiar' });
    const { container } = render(<KnowledgePanel beliefs={[k('domain:statistics'), k('tech:react')]} onSelect={noop} />);
    expect(container.innerHTML).toBe('');
  });

  // Forecasts left the page later the same day; uiLeakRegression.test.tsx
  // checks the page renders none, including "Next questions likely about: simple_qa".
  it('(g) intent ids never reach focus or the timeline', () => {
    const model = {
      working: {
        focusRanked: [{ topic: 'simple_qa', weight: 5 }, { topic: 'personal_info', weight: 4 }, { topic: 'react', weight: 2 }],
        blockers: [], deadlines: [], recentDiscoveries: [], openQuestions: [],
      },
    } as unknown as MindModel;
    render(<WorkingMemorySection model={model} />);
    render(<MindTimeline timeline={[
      { id: 't1', ts: 2, kind: 'episode_opened', subject: 'Working on simple qa + memory recall', detail: '', importance: 5 },
      { id: 't2', ts: 1, kind: 'episode_closed', subject: 'Working on simple qa', detail: '', importance: 6 },
      { id: 't3', ts: 3, kind: 'goal_created', subject: 'ship the beta', detail: '', importance: 6 },
    ]} />);
    expect(screen.getByText('react')).toBeTruthy();
    expect(screen.getByText('Started working toward ship the beta')).toBeTruthy();
    expect(screen.queryByText(/simple[_ ]qa|personal[_ ]info|memory recall/i)).toBeNull();
  });

  it('(h) the evidence line is the belief’s real evidence, never a fixed sentence', () => {
    render(<BeliefCard belief={belief({ key: 'profession', value: 'founder', evidenceText: 'You said this.' })} onSelect={noop} />);
    expect(screen.getByText('You said this.')).toBeTruthy();
    expect(screen.queryByText(/confirmed by how they actually work/)).toBeNull();
    cleanup();
    render(<BeliefCard belief={belief({ key: 'founder' })} onSelect={noop} />);
    expect(screen.queryByText(/Talks about the company/)).toBeNull();
  });

  // Was: the badge reads "confidence 100%" rather than a bare "100%" beside the
  // slider. Second pass: belief confidence is uncalibrated, so no percentage is
  // printed at all; the badge says what the position rests on.
  it('(i) the communication badge says what the slider rests on, not a percentage', () => {
    render(<CommunicationSection beliefs={[belief({ dimension: 'communication', key: 'message_style', value: 'terse', confidence: 1, evidenceCount: 3 })]} decision={[]} onSelect={noop} />);
    expect(screen.getByText('Inferred')).toBeTruthy();
    expect(screen.getByText('seen 3×')).toBeTruthy();
    expect(screen.queryByText(/\d+\s*%/)).toBeNull();
  });

  it('(j) the graph hides file nodes until "Show files"', async () => {
    fetchGraph.mockResolvedValue({
      success: true,
      nodes: [
        { id: 's', key: 'person:__self__', type: 'person', label: 'You', weight: 1 },
        { id: 'g', key: 'goal:beta', type: 'goal', label: 'ship the beta', weight: 2 },
        { id: 'f1', key: 'artifact:img', type: 'artifact', label: 'IMG-20260817-WA0001.jpg', weight: 1 },
        { id: 'f2', key: 'artifact:pdf', type: 'artifact', label: '1785322714.pdf', weight: 1 },
      ],
      edges: [],
    });
    render(<RelationshipGraph />);
    await screen.findByText('ship the beta');
    expect(screen.queryByText(/IMG-2026|1785322714/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show files (2)' }));
    expect(screen.getByText(/1785322714/)).toBeTruthy();
  });
});
