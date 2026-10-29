import { create } from 'zustand';
import {
  fetchMind, type MindModel, type CompactBelief, type Dimension,
} from '@/api/mind';
import { normalizeError } from '@/api/client';
import { isDisplayableBelief, isInternalText, stripInternalPrefix } from '@/lib/displayGuard';

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

/**
 * How many things the model holds: live beliefs plus goals that are not dropped.
 * Shown instead of the old composite "understanding %", which blended average
 * confidence, coverage and counts with weights nothing had validated.
 */
export function learnedCount(m: MindModel | null): number {
  if (!m) return 0;
  // Counted by the same rule that decides what the page shows, so the number
  // never includes rows a person cannot find below it.
  return allBeliefs(m).filter(isDisplayableBelief).length
    + m.goals.filter((g) => g.status !== 'abandoned').length;
}

/** Beliefs shown in a dimension, and the observations behind them (the ring's arc and its shade). */
export function dimensionEvidence(m: MindModel, d: Dimension): { count: number; observations: number } {
  const list = (m[d] ?? []).filter(isDisplayableBelief);
  return { count: list.length, observations: list.reduce((s, b) => s + (b.evidenceCount || 0), 0) };
}

/** The shown belief a reflection key ("dimension:key") refers to, or null. */
export function establishedBelief(m: MindModel, dimKey: string): CompactBelief | null {
  const i = dimKey.indexOf(':');
  const dim = dimKey.slice(0, i) as Dimension;
  const key = dimKey.slice(i + 1);
  const b = (m[dim] ?? []).find((x) => x.key === key);
  return b && isDisplayableBelief(b) ? b : null;
}

let learningSeq = 0;
function diffLearnings(prev: MindModel | null, next: MindModel): Learning[] {
  const out: Learning[] = [];
  const now = Date.now();
  // A line that would show a raw key, an intent id or a custom_ slug is dropped.
  const push = (kind: Learning['kind'], text: string) => {
    if (!isInternalText(text)) out.push({ id: `l${now.toString(36)}_${learningSeq++}`, ts: now, kind, text });
  };

  const label = (b: CompactBelief) => (b.label ?? stripInternalPrefix(b.key)).toLowerCase();
  // An object value has no sentence form; it is left out rather than printed as JSON.
  const val = (v: unknown) => (v === true || v == null || typeof v === 'object' ? '' : ` — ${String(v)}`);

  const shown = (m: MindModel) => allBeliefs(m).filter(isDisplayableBelief);
  const prevMap = new Map(prev ? shown(prev).map((b) => [`${b.dimension}:${b.key}`, b]) : []);
  for (const b of shown(next)) {
    const p = prevMap.get(`${b.dimension}:${b.key}`);
    if (!p) {
      if (prev) push('new', `Noticed ${label(b)}${val(b.value)}`);
    } else if (JSON.stringify(p.value) !== JSON.stringify(b.value)) {
      push('shifted', `Updated ${label(b)}${val(b.value)}`);
    } else if (b.evidenceCount > p.evidenceCount) {
      // Was "More confident: x (40% → 55%)" — a change in an uncalibrated number.
      push('strengthened', `Seen again: ${label(b)}`);
    }
  }

  const prevGoals = new Map(prev?.goals.map((g) => [g.id, g]) ?? []);
  for (const g of next.goals) {
    const p = prevGoals.get(g.id);
    if (!p && prev) push('goal', `Tracking a goal: “${g.title}”`);
    else if (p && p.status !== g.status && g.status === 'completed') push('goal', `Goal completed: “${g.title}”`);
    else if (p && p.status !== g.status && g.status === 'blocked') push('goal', `Goal blocked: “${g.title}”`);
  }

  // A promoted key ("knowledge:domain:alpha") is named only through a belief the
  // page shows; slicing the key itself put "domain:alpha" past the guard.
  const prevPromoted = new Set(prev?.reflections.flatMap((r) => r.promoted) ?? []);
  for (const r of next.reflections) {
    for (const key of r.promoted) {
      if (prevPromoted.has(key)) continue;
      const b = establishedBelief(next, key);
      if (b) push('promoted', `Established: ${label(b)}`);
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
        error: normalizeError(err).message,
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
