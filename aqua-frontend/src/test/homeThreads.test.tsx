import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Welcome, WelcomeThread } from '@/api/welcome';

/**
 * Home-screen threads (2026-10-28): the welcome selector's grounded
 * runners-up, offered as places to pick up.
 *
 *   - only what the server returned is shown — nothing composed locally
 *   - tapping a thread pre-fills the composer; nothing is sent for the user
 *   - a thread can be dismissed, and stays dismissed on the next visit
 *   - a new user / an older server (no `threads`) gets no block at all
 */

const fetchWelcome = vi.fn();
vi.mock('@/api/welcome', () => ({ fetchWelcome: (...a: unknown[]) => fetchWelcome(...a) }));
const listWorkspaces = vi.fn();
vi.mock('@/api/project', () => ({ listWorkspaces: (...a: unknown[]) => listWorkspaces(...a) }));

const { EmptyState } = await import('@/components/chat/EmptyState');
const { useUiStore } = await import('@/stores/uiStore');
const { useChatStore } = await import('@/stores/chatStore');
const { resetAllStores } = await import('@/stores/resetAll');

const thread = (id: string, text: string, kind = 'goal'): WelcomeThread => ({
  id, kind, text, prompt: `About ${id}: `, evidence: [{ source: 'claim', id: `c-${id}` }],
});
function welcome(threads?: WelcomeThread[]): Welcome {
  return {
    text: "Let's keep working toward launching the beta.", kind: 'goal', basis: 'world_model', established: true,
    evidence: [{ source: 'claim', id: 'c1' }], worldVersion: 'v', messageId: `m:${threads?.length ?? 'x'}`, threads,
  };
}
const renderScreen = () => render(<MemoryRouter><EmptyState /></MemoryRouter>);

beforeEach(() => {
  resetAllStores();
  localStorage.clear();
  fetchWelcome.mockReset();
  listWorkspaces.mockResolvedValue({ workspaces: [] });
});
afterEach(() => cleanup());

describe('home threads', () => {
  it('shows the server threads verbatim, with a plain-language kind', async () => {
    fetchWelcome.mockResolvedValue(welcome([
      thread('designer', "Let's keep working toward hiring a designer."),
      thread('pricing', 'You haven\'t settled on pricing yet — want to think it through?', 'open_decision'),
    ]));
    renderScreen();
    await waitFor(() => expect(screen.getAllByTestId('home-thread')).toHaveLength(2));
    expect(screen.getByText("Let's keep working toward hiring a designer.")).toBeTruthy();
    expect(screen.getByText('Undecided')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/open_decision|claim|c-designer/);
  });

  it('tapping a thread pre-fills the composer and sends nothing', async () => {
    const send = vi.fn();
    useChatStore.setState({ sendMessage: send } as never);
    fetchWelcome.mockResolvedValue(welcome([thread('designer', "Let's keep working toward hiring a designer.")]));
    renderScreen();
    fireEvent.click(await screen.findByText("Let's keep working toward hiring a designer."));
    expect(useUiStore.getState().composerSeed?.text).toBe('About designer: ');
    expect(send).not.toHaveBeenCalled();
  });

  it('a dismissed thread disappears and stays gone on the next visit', async () => {
    fetchWelcome.mockResolvedValue(welcome([thread('a', 'Thread A text.'), thread('b', 'Thread B text.')]));
    const first = renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: /Don't suggest this: Thread A/ }));
    expect(screen.queryByText('Thread A text.')).toBeNull();
    expect(screen.getByText('Thread B text.')).toBeTruthy();
    first.unmount();

    renderScreen();
    await screen.findByText('Thread B text.');
    expect(screen.queryByText('Thread A text.')).toBeNull();
  });

  it('no threads (new user, or an older server without the field) → no block', async () => {
    fetchWelcome.mockResolvedValue(welcome(undefined));
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('welcome-line').textContent).toMatch(/beta/));
    expect(screen.queryByText('On your plate')).toBeNull();
    expect(screen.queryAllByTestId('home-thread')).toHaveLength(0);
  });

  it('storage that throws never breaks the screen', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    fetchWelcome.mockResolvedValue(welcome([thread('a', 'Thread A text.')]));
    renderScreen();
    expect(await screen.findByText('Thread A text.')).toBeTruthy();
    spy.mockRestore();
  });
});

describe('composer seed', () => {
  it('fills an empty composer once, and never overwrites what the user is typing', async () => {
    window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
    const { Composer } = await import('@/components/chat/Composer');
    const { TooltipProvider } = await import('@/components/ui/tooltip');
    const { act } = await import('@testing-library/react');
    render(<MemoryRouter><TooltipProvider><Composer /></TooltipProvider></MemoryRouter>);
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;

    act(() => useUiStore.getState().seedComposer('About the beta: '));
    await waitFor(() => expect(box.value).toBe('About the beta: '));
    expect(useUiStore.getState().composerSeed).toBeNull();

    fireEvent.change(box, { target: { value: 'my own words' } });
    act(() => useUiStore.getState().seedComposer('About something else: '));
    await waitFor(() => expect(useUiStore.getState().composerSeed).toBeNull());
    expect(box.value).toBe('my own words');
  });
});

describe('phone home screen (no sidebar mounted)', () => {
  it('loads recent conversations itself, so a returning user can pick up where they left off', async () => {
    const { useConversationStore } = await import('@/stores/conversationStore');
    const fetchConversations = vi.fn(async () => {
      useConversationStore.setState({ items: [{ id: 'c1', title: 'Hiring plan', messageCount: 3, updatedAt: Date.now(), createdAt: Date.now(), pinned: false, archived: false } as never] });
    });
    useConversationStore.setState({ items: [], loading: false, fetchConversations });
    fetchWelcome.mockResolvedValue(welcome(undefined));
    renderScreen();
    await waitFor(() => expect(fetchConversations).toHaveBeenCalledOnce());
    expect(await screen.findByText('Hiring plan')).toBeTruthy();
    expect(screen.getByRole('heading').textContent).toBe('Welcome back.');
  });
});
