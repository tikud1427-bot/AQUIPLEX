import { apiClient } from './client';

/* ── Mirrors aqua/src/brain/welcome (backend is source of truth) ─────────── */

export type WelcomeBasis = 'world_model' | 'legacy_goals' | 'none' | 'unavailable';

export interface Welcome {
  /** One sentence, already phrased and grounding-checked server-side. */
  text: string;
  kind: string;
  basis: WelcomeBasis;
  /** True only when the line is about this person's actual world. */
  established: boolean;
  evidence: { source: 'claim' | 'mind_goal'; id: string }[];
  /** Changes when the inputs the line was chosen from change. */
  worldVersion: string;
  /** Changes when the line itself changes — what the screen keys on. */
  messageId: string;
}

/** `history` only chooses between two invitation wordings; it adds no content. */
export async function fetchWelcome(opts: { history: boolean; signal?: AbortSignal }): Promise<Welcome> {
  const { data } = await apiClient.get<{ success: true; welcome: Welcome }>('/brain/welcome', {
    params: opts.history ? { history: 1 } : undefined,
    signal: opts.signal,
    timeout: 10_000,
  });
  return data.welcome;
}
