import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RecallSources } from '@/components/chat/RecallSources';

/**
 * "From your earlier conversations" — the answer says where it quoted the user
 * from, and each source opens that conversation. The current conversation is
 * not a source (its messages are on screen), and one conversation is one link.
 */
const at = (iso: string) => new Date(iso).toISOString();
const renderWith = (recall: Parameters<typeof RecallSources>[0]['recall'], current: string | null = 'now') =>
  render(<MemoryRouter><RecallSources recall={recall} currentConversationId={current} /></MemoryRouter>);

afterEach(cleanup);

describe('RecallSources', () => {
  it('renders nothing when nothing was recalled', () => {
    const { container } = renderWith(undefined);
    expect(container.textContent).toBe('');
    renderWith({ excerpts: [] });
    expect(screen.queryByText(/earlier conversations/)).toBeNull();
  });

  it('links each earlier conversation once, skipping the current one', () => {
    renderWith({ excerpts: [
      { conversationId: 'a', title: 'Splitpay planning', date: at('2026-09-01T10:00:00Z'), changed: false },
      { conversationId: 'a', title: 'Splitpay planning', date: at('2026-09-01T10:05:00Z'), changed: false },
      { conversationId: 'now', title: 'This chat', date: at('2026-09-20T10:00:00Z'), changed: false },
      { conversationId: 'b', title: null, date: null, changed: true },
    ] });
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/c/a', '/c/b']);
    expect(links[0].textContent).toMatch(/^Splitpay planning · /);
    expect(links[1].textContent).toBe('a conversation');
    expect(screen.queryByText(/This chat/)).toBeNull();
  });
});
