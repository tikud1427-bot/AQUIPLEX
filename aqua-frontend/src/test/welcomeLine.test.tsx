import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Welcome } from '@/api/welcome';

/**
 * The opening screen's line under "Welcome back."
 *
 * The line used to be built HERE from the Mind's highest-priority goal
 * ("You're in the middle of …"). It now comes from GET /brain/welcome, which
 * chooses it from the user's current world. What this suite pins is the
 * screen's half of that contract:
 *
 *   - the server's line is shown verbatim, and nothing is composed locally
 *     from memory — a goal sitting in the Mind store never reaches the screen
 *   - unchanged world (same messageId) → the same line, no churn
 *   - changed world (new messageId) → the new line
 *   - a failed fetch → a neutral line about the screen, never about the person
 *   - the paragraph holds its height while loading, so nothing jumps
 *   - sign-out cancels and clears it (no cross-account carry-over)
 */

const fetchWelcome = vi.fn();
vi.mock('@/api/welcome', () => ({ fetchWelcome: (...a: unknown[]) => fetchWelcome(...a) }));
const listWorkspaces = vi.fn();
vi.mock('@/api/project', () => ({ listWorkspaces: (...a: unknown[]) => listWorkspaces(...a) }));

const { EmptyState } = await import('@/components/chat/EmptyState');
const { useWelcomeStore } = await import('@/stores/welcomeStore');
const { useMindStore } = await import('@/stores/mindStore');
const { useConversationStore } = await import('@/stores/conversationStore');
const { resetAllStores } = await import('@/stores/resetAll');

function welcome(text: string, over: Partial<Welcome> = {}): Welcome {
  return {
    text, kind: 'goal', basis: 'world_model', established: true,
    evidence: [{ source: 'claim', id: 'c1' }], worldVersion: `v:${text}`, messageId: `m:${text}`, ...over,
  };
}

const renderScreen = () => render(<MemoryRouter><EmptyState /></MemoryRouter>);
const line = () => screen.getByTestId('welcome-line');

beforeEach(() => {
  resetAllStores();
  fetchWelcome.mockReset();
  listWorkspaces.mockResolvedValue({ workspaces: [] });
});
afterEach(() => cleanup());

describe('welcome line', () => {
  it('shows the server line under "Welcome back." and never composes one from memory', async () => {
    useMindStore.setState({
      hasLoadedOnce: true,
      model: { goals: [{ id: 'g', title: 'become a billionaire', status: 'active', priority: 10 }] },
    } as never);
    fetchWelcome.mockResolvedValue(welcome("Let's keep working toward launching the beta."));
    renderScreen();

    await waitFor(() => expect(line().textContent).toBe("Let's keep working toward launching the beta."));
    expect(screen.getByRole('heading').textContent).toBe('Welcome back.');
    expect(document.body.textContent).not.toMatch(/billionaire|in the middle of/i);
  });

  it('different worlds, different lines — the screen adds nothing of its own', async () => {
    fetchWelcome.mockResolvedValueOnce(welcome('With the auth bug sorted, the launch can move forward again.'));
    const first = renderScreen();
    await waitFor(() => expect(line().textContent).toMatch(/auth bug/));
    first.unmount();

    resetAllStores();
    fetchWelcome.mockResolvedValueOnce(welcome("Let's keep working toward finishing your thesis."));
    renderScreen();
    await waitFor(() => expect(line().textContent).toMatch(/thesis/));
    expect(line().textContent).not.toMatch(/auth bug/);
  });

  it('an unchanged world keeps the same line across refreshes; a changed one replaces it', async () => {
    const goal = welcome("Let's get the auth bug out of the way of the launch.");
    fetchWelcome.mockResolvedValue(goal);
    renderScreen();
    await waitFor(() => expect(line().textContent).toBe(goal.text));
    const shown = useWelcomeStore.getState().welcome;

    // Same messageId (only the world version moved) → the same object stays.
    fetchWelcome.mockResolvedValue({ ...goal, worldVersion: 'v2' });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(fetchWelcome).toHaveBeenCalledTimes(2));
    expect(useWelcomeStore.getState().welcome).toBe(shown);
    expect(line().textContent).toBe(goal.text);

    // The blocker is resolved server-side → new messageId → new line.
    fetchWelcome.mockResolvedValue(welcome('With the auth bug sorted, the launch can move forward again.', { kind: 'unblocked' }));
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(line().textContent).toMatch(/sorted/));
    expect(line().textContent).not.toMatch(/out of the way/);
  });

  it('a failed fetch shows a neutral line and invents nothing', async () => {
    useConversationStore.setState({ items: [{ id: 'a', title: 'Pricing thread', updatedAt: 1, createdAt: 1 }] } as never);
    fetchWelcome.mockRejectedValue(new Error('Network Error'));
    renderScreen();
    await waitFor(() => expect(line().textContent).toBe('Pick up a thread below, or start something new.'));
    expect(screen.getByRole('heading').textContent).toBe('Welcome back.');
  });

  it('a new user with no context gets the invitation and the first-run heading', async () => {
    fetchWelcome.mockResolvedValue(welcome('AQUA reads what you give it once, remembers what matters, and carries it into every conversation after.',
      { kind: 'invite', basis: 'none', established: false, evidence: [] }));
    renderScreen();
    await waitFor(() => expect(line().textContent).toMatch(/AQUA reads what you give it/));
    expect(screen.getByRole('heading').textContent).toBe('What are you working on?');
    expect(fetchWelcome).toHaveBeenCalledWith(expect.objectContaining({ history: false }));
  });

  it('while loading, the paragraph is empty but keeps its height (no layout shift)', () => {
    fetchWelcome.mockReturnValue(new Promise(() => {}));
    renderScreen();
    expect(line().textContent).toBe('');
    expect(line().getAttribute('aria-busy')).toBe('true');
    expect(line().className).toMatch(/min-h-\[/);
  });

  it('sign-out cancels the in-flight request and clears the line', async () => {
    let signal: AbortSignal | undefined;
    fetchWelcome.mockImplementation((opts: { signal?: AbortSignal }) => { signal = opts.signal; return new Promise(() => {}); });
    renderScreen();
    await waitFor(() => expect(signal).toBeDefined());
    useWelcomeStore.setState({ welcome: welcome('User A’s line') });
    resetAllStores();
    expect(signal?.aborted).toBe(true);
    expect(useWelcomeStore.getState().welcome).toBeNull();
  });
});
