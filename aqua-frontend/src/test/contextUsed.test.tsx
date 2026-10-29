import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * "Context used" under an answer (2026-10-28).
 *   - absent when nothing about the user was used
 *   - collapsed by default; shows exactly the server's items, labelled
 *   - forget is confirmed, and the row changes only when the server agrees
 *   - correct sends the user's words to the claim's endpoint
 *   - after a change, the last answer offers Regenerate
 */
const forgetClaim = vi.fn();
const forgetMemoryFact = vi.fn();
const correctClaimValue = vi.fn();
vi.mock('@/api/memory', () => ({
  forgetClaim: (...a: unknown[]) => forgetClaim(...a),
  forgetMemoryFact: (...a: unknown[]) => forgetMemoryFact(...a),
  correctClaimValue: (...a: unknown[]) => correctClaimValue(...a),
}));

const { ContextUsed } = await import('@/components/chat/ContextUsed');

const CTX = {
  items: [
    { kind: 'claim' as const, id: 'claim-1', text: 'We launch the beta on November 3.', disputed: false },
    { kind: 'fact' as const, key: 'city', label: 'City', text: 'Guwahati' },
  ],
};
const renderIt = (props: Parameters<typeof ContextUsed>[0]) => render(<MemoryRouter><ContextUsed {...props} /></MemoryRouter>);

beforeEach(() => { forgetClaim.mockReset(); forgetMemoryFact.mockReset(); correctClaimValue.mockReset(); });
afterEach(() => cleanup());

describe('ContextUsed', () => {
  it('renders nothing when nothing was used', () => {
    renderIt({ contextUsed: undefined });
    renderIt({ contextUsed: { items: [] } });
    expect(screen.queryByTestId('context-used')).toBeNull();
  });

  it('is collapsed by default and lists the server items when opened', () => {
    renderIt({ contextUsed: CTX });
    expect(screen.getByRole('button', { name: /Context used · 2/ }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Guwahati')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Context used/ }));
    expect(screen.getByText('We launch the beta on November 3.')).toBeTruthy();
    expect(screen.getByText('City:')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/claim-1|%/);
  });

  it('forget asks first, and a server failure keeps the row and says why', async () => {
    forgetMemoryFact.mockRejectedValueOnce({ isAxiosError: false, message: 'x' });
    renderIt({ contextUsed: CTX, onRegenerate: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: /Context used/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Forget' })[1]);
    expect(forgetMemoryFact).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Forget' }).at(-1)!); // the dialog's confirm
    await waitFor(() => expect(forgetMemoryFact).toHaveBeenCalledWith('city'));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('Forgotten')).toBeNull();
    expect(screen.queryByRole('button', { name: /Regenerate/ })).toBeNull();
  });

  it('a successful forget marks the row and offers Regenerate', async () => {
    forgetClaim.mockResolvedValueOnce({ success: true });
    const regen = vi.fn();
    renderIt({ contextUsed: CTX, onRegenerate: regen });
    fireEvent.click(screen.getByRole('button', { name: /Context used/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Forget' })[0]);
    const dialogConfirm = screen.getAllByRole('button', { name: 'Forget' }).at(-1)!;
    fireEvent.click(dialogConfirm);
    await waitFor(() => expect(forgetClaim).toHaveBeenCalledWith('claim-1'));
    expect(await screen.findByText('Forgotten')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Regenerate with the change/ }));
    expect(regen).toHaveBeenCalledOnce();
  });

  it('correct sends the user\'s words and shows the corrected statement', async () => {
    correctClaimValue.mockResolvedValueOnce({ success: true, claimId: 'claim-2', statement: 'We launch the beta on November 10.' });
    renderIt({ contextUsed: CTX });
    fireEvent.click(screen.getByRole('button', { name: /Context used/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Correct' }));
    fireEvent.change(screen.getByLabelText('What is actually true'), { target: { value: 'November 10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(correctClaimValue).toHaveBeenCalledWith('claim-1', 'November 10'));
    expect(await screen.findByText('We launch the beta on November 10.')).toBeTruthy();
    expect(screen.getByText('Corrected')).toBeTruthy();
  });

  it('facts from the legacy store offer forget only (no in-place correct)', () => {
    renderIt({ contextUsed: { items: [CTX.items[1]] } });
    fireEvent.click(screen.getByRole('button', { name: /Context used/ }));
    expect(screen.queryByRole('button', { name: 'Correct' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Forget' })).toBeTruthy();
  });
});

describe('ContextUsed on a reopened answer', () => {
  it('marks changed items without offering edits, and counts removed / unreadable items without showing them', () => {
    renderIt({ contextUsed: {
      items: [
        { kind: 'claim', id: 'c9', text: 'We charge $49 a month per clinic', disputed: false, changed: true },
        { kind: 'fact', key: 'city', label: 'City', text: 'Pune', changed: false },
      ],
      removed: 2, unavailable: 1,
    } });
    fireEvent.click(screen.getByRole('button', { name: /Context used · 5/ }));
    expect(screen.getByText('(since changed)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Correct' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Forget' })).toHaveLength(1); // the unchanged fact only
    expect(screen.getByText(/2 more were used, and have since been removed\. 1 couldn’t be checked right now\./)).toBeTruthy();
  });

  it('a reopened answer whose context was all forgotten still says so, with nothing to show', () => {
    renderIt({ contextUsed: { items: [], removed: 1 } });
    fireEvent.click(screen.getByRole('button', { name: /Context used · 1/ }));
    expect(screen.getByText(/1 more was used, and has since been removed\./)).toBeTruthy();
  });
});

describe('ContextUsed correction box', () => {
  it('starts from the exact value being replaced, so the rest of the sentence survives', async () => {
    correctClaimValue.mockResolvedValueOnce({ success: true, claimId: 'c2', statement: 'We charge $59 a month per clinic' });
    renderIt({ contextUsed: { items: [{ kind: 'claim', id: 'c1', text: 'We charge $49 a month per clinic', disputed: false, value: 'charge $49 a month per clinic' }] } });
    fireEvent.click(screen.getByRole('button', { name: /Context used/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Correct' }));
    const box = screen.getByLabelText('What is actually true') as HTMLInputElement;
    expect(box.value).toBe('charge $49 a month per clinic');
    fireEvent.change(box, { target: { value: 'charge $59 a month per clinic' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(correctClaimValue).toHaveBeenCalledWith('c1', 'charge $59 a month per clinic'));
    expect(await screen.findByText('We charge $59 a month per clinic')).toBeTruthy();
  });
});
