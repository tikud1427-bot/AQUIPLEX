import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { CompactBelief, Goal, MindModel } from '@/api/mind';
import { GoalsSection } from '@/features/mind/NowSections';
import { CommunicationSection, KnowledgeSection } from '@/features/mind/ModelSections';
import { BeliefCard } from '@/features/mind/IdentitySection';
import { UnderstandingRing } from '@/features/mind/UnderstandingRing';
import { learnedCount } from '@/stores/mindStore';

/**
 * Numbers the Understanding page used to print that nothing backs (2026-10-28):
 * an "understanding %" blended from uncalibrated confidences, goal "progress"
 * that is +0.2 per "made progress" phrase, forecast "probabilities" that are
 * constants, and belief confidence drawn as a percentage bar. Counts that are
 * real (mentions, evidence, things learned) stay.
 */

afterEach(cleanup);

const belief = (over: Partial<CompactBelief>): CompactBelief => ({
  dimension: 'knowledge', key: 'k', value: 'familiar', confidence: 0.9, evidenceCount: 1, contradictions: 0,
  status: 'active', locked: false, temporary: false, source: 'inference', updatedAt: Date.now(), ...over,
});

const goal = (over: Partial<Goal>): Goal => ({
  id: 'g1', title: 'Launch Tidepool beta', priority: 5, progress: 0.6, deadline: null, dependencies: [], blockers: [],
  relatedProjects: [], status: 'active', confidence: 0.55, mentions: 3, createdAt: 1, updatedAt: 1, lastMentionedAt: Date.now(),
  ...over,
});

const PERCENT = /\d+\s*%/;

function model(over: Partial<MindModel>): MindModel {
  return {
    success: true, ownerId: 'user:x', turnCount: 12, createdAt: 1, updatedAt: 1,
    identity: [], personality: [], communication: [], preferences: [], knowledge: [], behavior: [], decision: [],
    goals: [], activeGoals: [], episodes: [], predictions: [], timeline: [], reflections: [], lastReflectionAt: null,
    graph: { nodeCount: 0, edgeCount: 0 },
    working: { focusRanked: [], blockers: [], deadlines: [], recentDiscoveries: [], openQuestions: [] } as unknown as MindModel['working'],
    ...over,
  };
}

describe('Understanding page prints no unsupported percentages', () => {
  it('goals show how often they were mentioned, not a heuristic progress bar or confidence', () => {
    const { container } = render(<GoalsSection goals={[goal({})]} />);
    expect(screen.getByText('Launch Tidepool beta')).toBeTruthy();
    expect(screen.getByText(/mentioned 3×/)).toBeTruthy();
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.textContent).not.toMatch(PERCENT);
  });

  // Forecasts are no longer on the page at all (second pass, same day): see
  // uiLeakRegression.test.tsx "the Understanding page shows no forecasts".

  it('a goal shows no priority it was never given (every goal is created at 5)', () => {
    const { container } = render(<GoalsSection goals={[goal({}), goal({ id: 'g2', title: 'Hire a designer', priority: 8 })]} />);
    expect(container.textContent).not.toMatch(/priority 5/);
    expect(screen.getByText(/priority 8/)).toBeTruthy(); // positive control: a set priority shows
  });

  it('belief cards and the communication panel say stated/inferred and how often seen, never a percentage', () => {
    const { container } = render(<>
      <BeliefCard belief={belief({ dimension: 'identity', key: 'role', value: 'founder', source: 'explicit', confidence: 0.9 })} onSelect={() => {}} />
      <CommunicationSection
        beliefs={[belief({ dimension: 'communication', key: 'response_length', value: 'brief', confidence: 0.73, evidenceCount: 2 })]}
        decision={[]} onSelect={() => {}} />
    </>);
    expect(screen.getByText('You said this')).toBeTruthy();
    expect(screen.getByText('Inferred')).toBeTruthy();
    expect(screen.getByText('seen 2×')).toBeTruthy();
    expect(container.textContent).not.toMatch(PERCENT);
    expect(container.innerHTML).not.toMatch(/percent/i);
  });

  it('knowledge rows show how often a skill was seen, not a confidence percentage', () => {
    const { container } = render(<KnowledgeSection
      beliefs={[belief({ key: 'domain:react', evidenceCount: 4 }), belief({ key: 'domain:postgres', evidenceCount: 2, confidence: 0.6 })]}
      onSelect={() => {}} />);
    expect(screen.getByText('seen 4×')).toBeTruthy();
    expect(screen.getByText('seen 2×')).toBeTruthy();
    expect(container.textContent).not.toMatch(PERCENT);
    expect(container.innerHTML).not.toMatch(/percent/i);
  });

  it('the ring centre is a count of things learned, not an "understanding" percentage', () => {
    const m = model({
      identity: [belief({ dimension: 'identity', key: 'role' }), belief({ dimension: 'identity', key: 'old', status: 'archived' })],
      knowledge: [belief({ key: 'domain:react' })],
      goals: [goal({}), goal({ id: 'g2', status: 'abandoned' })],
    });
    expect(learnedCount(m)).toBe(3); // archived belief and dropped goal excluded
    const { container } = render(<UnderstandingRing model={m} />);
    expect(screen.getByText('things learned')).toBeTruthy();
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('3 things learned so far');
    expect(container.textContent).not.toMatch(PERCENT);
  });
});
