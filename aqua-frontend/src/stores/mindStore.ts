import { create } from 'zustand';
import {
  fetchMind, type MindModel, type CompactBelief, type Dimension,
} from '@/api/mind';

/* ────────────────────────────────────────────────────────────────────────
   Mind store — single source for the dashboard.

   No polling. Refreshes are event-driven:
     • page mount / window focus
     • after every completed chat turn (chatStore.finishTurn → refreshMind())
   Consecutive fetches are diffed to produce the "What AQUA learned" feed
   and to detect a new reflection (→ plays the reflection sequence).
   ──────────────────────────────────────────────────────────────────────── */

export const DIMENSIONS: Dimension[] = [
  'identity', 'personality', 'communication', 'preferences', 'knowledge', 'behavior', 'decision',
];

export interface Learning {
  id: string;
  ts: number;
  kind: 'new' | 'strengthened' | 'shifted' | 'goal' | 'promoted';
  text: string;
}

interface MindState {
  model: MindModel | null;
  loading: boolean;
  error: string | null;
  hasLoadedOnce: boolean;
  learnings: Learning[];           // session-accumulated, newest first
  reflectionPlaying: boolean;
  lastFetchedAt: number;

  refresh: (opts?: { silent?: boolean }) => Promise<void>;
  applyBelief: (b: CompactBelief) => void;   // optimistic local update after edit
  removeBelief: (dimension: string, key: string) => void;
  dismissReflection: () => void;
  clear: () => void;
}

function allBeliefs(m: MindModel): CompactBelief[] {
  return DIMENSIONS.flatMap((d) => m[d] ?? []);
}

/** Composite understanding: confidence mass + dimension coverage + context signals. */
export function understandingScore(m: MindModel | null): number {
  if (!m) return 0;
  const beliefs = allBeliefs(m).filter((b) => b.status !== 'archived');
  if (!beliefs.length && !m.goals.length) return 0;

  const avgConf = beliefs.length
    ? beliefs.reduce((s, b) => s + b.confidence, 0) / beliefs.length
    : 0;
  const coverage = DIMENSIONS.filter((d) => (m[d] ?? []).some((b) => b.status !== 'archived')).length / DIMENSIONS.length;
  const goalSignal = Math.min(1, m.goals.filter((g) => g.status === 'active' || g.status === 'blocked').length / 3);
  const depth = Math.min(1, beliefs.reduce((s, b) => s + b.evidenceCount, 0) / 60);

  return Math.round(100 * (0.45 * avgConf + 0.25 * coverage + 0.15 * depth + 0.15 * goalSignal));
}

export function dimensionConfidence(m: MindModel, d: Dimension): { avg: number; count: number } {
  const list = (m[d] ?? []).filter((b) => b.status !== 'archived');
  if (!list.length) return { avg: 0, count: 0 };
  return { avg: list.reduce((s, b) => s + b.confidence, 0) / list.length, count: list.length };
}

let learningSeq = 0;
function diffLearnings(prev: MindModel | null, next: MindModel): Learning[] {
  const out: Learning[] = [];
  const now = Date.now();
  const push = (kind: Learning['kind'], text: string) =>
    out.push({ id: `l${now.toString(36)}_${learningSeq++}`, ts: now, kind, text });

  const label = (b: CompactBelief) => b.key.replace('tech:', '').replace(/_/g, ' ');
  const val = (v: unknown) => (v === true ? '' : ` — ${String(typeof v === 'object' ? JSON.stringify(v) : v)}`);

  const prevMap = new Map(prev ? allBeliefs(prev).map((b) => [`${b.dimension}:${b.key}`, b]) : []);
  for (const b of allBeliefs(next)) {
    const p = prevMap.get(`${b.dimension}:${b.key}`);
    if (!p) {
      if (prev) push('new', `Noticed ${label(b)}${val(b.value)}`);
    } else if (JSON.stringify(p.value) !== JSON.stringify(b.value)) {
      push('shifted', `Updated ${label(b)}: now${val(b.value) || ` ${String(b.value)}`}`);
    } else if (b.confidence - p.confidence >= 0.04) {
      push('strengthened', `More confident: ${label(b)} (${Math.round(p.confidence * 100)}% → ${Math.round(b.confidence * 100)}%)`);
    }
  }

  const prevGoals = new Map(prev?.goals.map((g) => [g.id, g]) ?? []);
  for (const g of next.goals) {
    const p = prevGoals.get(g.id);
    if (!p && prev) push('goal', `Tracking a goal: “${g.title}”`);
    else if (p && p.status !== g.status && g.status === 'completed') push('goal', `Goal completed: “${g.title}”`);
    else if (p && p.status !== g.status && g.status === 'blocked') push('goal', `Goal blocked: “${g.title}”`);
  }

  const prevPromoted = new Set(prev?.reflections.flatMap((r) => r.promoted) ?? []);
  for (const r of next.reflections) {
    for (const key of r.promoted) {
      if (!prevPromoted.has(key)) push('promoted', `Established: ${key.split(':').slice(1).join(':').replace(/_/g, ' ')}`);
    }
  }

  return out.reverse(); // newest first when prepended
}

export const useMindStore = create<MindState>()((set, get) => ({
  model: null,
  loading: false,
  error: null,
  hasLoadedOnce: false,
  learnings: [],
  reflectionPlaying: false,
  lastFetchedAt: 0,

  refresh: async ({ silent = false } = {}) => {
    const { loading, lastFetchedAt } = get();
    if (loading) return;
    if (silent && Date.now() - lastFetchedAt < 1500) return; // debounce bursts
    if (!silent) set({ loading: true, error: null });
    try {
      const next = await fetchMind();
      const prev = get().model;
      if (next) {
        const fresh = diffLearnings(prev, next);
        const reflectionHappened =
          !!prev && next.reflections.length > prev.reflections.length;
        set((s) => ({
          model: next,
          loading: false,
          error: null,
          hasLoadedOnce: true,
          lastFetchedAt: Date.now(),
          learnings: [...fresh, ...s.learnings].slice(0, 40),
          reflectionPlaying: s.reflectionPlaying || reflectionHappened,
        }));
      } else {
        set({ model: null, loading: false, hasLoadedOnce: true, lastFetchedAt: Date.now() });
      }
    } catch (err) {
      set({
        loading: false,
        hasLoadedOnce: true,
        error: err instanceof Error ? err.message : 'Could not load the mind model.',
      });
    }
  },

  applyBelief: (b) =>
    set((s) => {
      if (!s.model) return s;
      const dim = b.dimension;
      const list = (s.model[dim] ?? []).filter((x) => x.key !== b.key);
      return { model: { ...s.model, [dim]: [b, ...list] } };
    }),

  removeBelief: (dimension, key) =>
    set((s) => {
      if (!s.model) return s;
      const dim = dimension as Dimension;
      return {
        model: { ...s.model, [dim]: (s.model[dim] ?? []).filter((x) => x.key !== key) },
      };
    }),

  dismissReflection: () => set({ reflectionPlaying: false }),
  clear: () => set({ model: null, learnings: [], hasLoadedOnce: false }),
}));

/** Called by chatStore after each completed turn — the "live" in live updates. */
export function refreshMind() {
  void useMindStore.getState().refresh({ silent: true });
}
