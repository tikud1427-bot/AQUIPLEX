import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * "Worth a second look" (legacy review, 2026-10-29): records saved before the
 * 2026-10-28 fixes. Candidates only — nothing changes until the user chooses;
 * removal is confirmed; a failed call keeps the item and says why.
 */
const fetchReview = vi.fn();
const splitGoal = vi.fn();
const confirmBelief = vi.fn();
const deleteBelief = vi.fn();
vi.mock('@/api/mind', () => ({
  fetchReview: () => fetchReview(),
  splitGoal: (...a: unknown[]) => splitGoal(...a),
  confirmBelief: (...a: unknown[]) => confirmBelief(...a),
  deleteBelief: (...a: unknown[]) => deleteBelief(...a),
}));
const confirmMemoryFact = vi.fn();
const forgetMemoryFact = vi.fn();
const splitMemoryItem = vi.fn();
vi.mock('@/api/memory', () => ({
  confirmMemoryFact: (...a: unknown[]) => confirmMemoryFact(...a),
  forgetMemoryFact: (...a: unknown[]) => forgetMemoryFact(...a),
  splitMemoryItem: (...a: unknown[]) => splitMemoryItem(...a),
}));
const { ReviewPanel } = await import('@/components/memory/ReviewPanel');

const MERGED = { id: 'goal:g1', kind: 'merged_goal' as const, goalId: 'g1', title: 'become a billionaire and build a company people love', parts: ['become a billionaire', 'build a company people love'] };
const ITEM = { id: 'factitem:goal:x', kind: 'merged_goal_item' as const, key: 'goal', item: 'launch the beta and hire a designer', parts: ['launch the beta', 'hire a designer'] };
const FACT = { id: 'fact:profession', kind: 'fact_fails_schema' as const, key: 'profession', label: 'Profession', value: 'Billionaire', aspiration: true, learnedFrom: 'I want to be a billionaire' };
const ROLE = { id: 'belief:identity:role', kind: 'role_is_aspiration' as const, dimension: 'identity', key: 'role', value: 'future founder' };

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('ReviewPanel', () => {
  it('renders nothing when there is nothing to review, or the review cannot be read', async () => {
    fetchReview.mockResolvedValueOnce([]);
    const a = render(<ReviewPanel />);
    await waitFor(() => expect(fetchReview).toHaveBeenCalled());
    expect(screen.queryByTestId('review-panel')).toBeNull();
    a.unmount();
    fetchReview.mockRejectedValueOnce(new Error('503'));
    render(<ReviewPanel />);
    await waitFor(() => expect(fetchReview).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('review-panel')).toBeNull();
  });

  it('shows each kind in plain words with the evidence, and no internal ids', async () => {
    fetchReview.mockResolvedValue([MERGED, ITEM, FACT, ROLE]);
    render(<ReviewPanel />);
    await screen.findByText('Worth a second look');
    expect(screen.getByText(/Saved as one goal: “become a billionaire and build/)).toBeTruthy();
    expect(screen.getByText(/Saved as your profession: “Billionaire”\. That reads like something you’re aiming for/)).toBeTruthy();
    expect(screen.getByText('“I want to be a billionaire”')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/merged_goal|fact_fails_schema|goal:g1|factitem/);
  });

  it('split sends the suggested parts and the item leaves only on success', async () => {
    fetchReview.mockResolvedValue([MERGED, ITEM]);
    splitGoal.mockResolvedValueOnce({ success: true });
    splitMemoryItem.mockRejectedValueOnce({ message: 'x' });
    const onChanged = vi.fn();
    render(<ReviewPanel onChanged={onChanged} />);
    const [first, second] = await screen.findAllByRole('button', { name: 'Split into 2' });
    fireEvent.click(first);
    await waitFor(() => expect(splitGoal).toHaveBeenCalledWith('g1', { parts: MERGED.parts }));
    await waitFor(() => expect(screen.queryByText(/billionaire and build/)).toBeNull());
    expect(onChanged).toHaveBeenCalledOnce();
    fireEvent.click(second);
    await waitFor(() => expect(splitMemoryItem).toHaveBeenCalledWith('goal', { item: ITEM.item, parts: ITEM.parts }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/launch the beta and hire a designer/)).toBeTruthy();
  });

  it('"It\'s one goal" / "It\'s right" record the decision', async () => {
    fetchReview.mockResolvedValue([MERGED, FACT, ROLE]);
    splitGoal.mockResolvedValue({ success: true });
    confirmMemoryFact.mockResolvedValue({ success: true });
    confirmBelief.mockResolvedValue({ success: true });
    render(<ReviewPanel />);
    fireEvent.click(await screen.findByRole('button', { name: "It's one goal" }));
    await waitFor(() => expect(splitGoal).toHaveBeenCalledWith('g1', { keep: true }));
    const right = await screen.findAllByRole('button', { name: "It's right" });
    fireEvent.click(right[0]);
    await waitFor(() => expect(confirmMemoryFact).toHaveBeenCalledWith('profession'));
    fireEvent.click((await screen.findAllByRole('button', { name: "It's right" }))[0]);
    await waitFor(() => expect(confirmBelief).toHaveBeenCalledWith('identity', 'role'));
  });

  it('remove asks first, then forgets the fact', async () => {
    fetchReview.mockResolvedValue([FACT]);
    forgetMemoryFact.mockResolvedValue({ success: true });
    render(<ReviewPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove it' }));
    expect(forgetMemoryFact).not.toHaveBeenCalled();
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(forgetMemoryFact).toHaveBeenCalledWith('profession'));
    await waitFor(() => expect(screen.queryByTestId('review-panel')).toBeNull());
  });
});
