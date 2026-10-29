/**
 * Pure formatting helpers. These lived in features/mind/primitives.tsx next
 * to the components that used them, which is what made that file trip
 * react-refresh: a module that exports both components and plain functions
 * can't be hot-replaced. Split out here they are reusable everywhere.
 */

export function timeAgo(ts?: number | null): string {
  if (!ts) return '';
  const m = (Date.now() - ts) / 60000;
  if (m < 1) return 'just now';
  if (m < 60) return `${Math.round(m)}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

/** Staleness → opacity: fresh 1.0, fades toward 0.35 over maxAgeMs. */
export function staleOpacity(lastSeenAt: number, maxAgeMs = 5 * 24 * 3600 * 1000): number {
  const age = Date.now() - lastSeenAt;
  const p = Math.min(1, Math.max(0, age / maxAgeMs));
  return 1 - p * 0.65;
}

/* ── Human-readable presentation of stored keys ───────────────────────────
   Memory and workspace records are keyed for machines (`favorite_language`,
   `work.role`). Nothing about that should reach a screen: the brief is
   explicit that a user must never feel they are managing a database. These
   turn storage keys into sentence-case labels at render time — a
   presentation layer only, nothing is rewritten server-side. */

export function humanizeKey(key: string): string {
  const words = key
    .replace(/[_.:\-/]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  if (!words) return key;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/* ── Calendar-day bucketing ───────────────────────────────────────────────
   By calendar day, not elapsed milliseconds: something from 11pm last night
   is "Yesterday" at 8am, not "Today" because 9 hours have passed. */

export type DateBucket = 'Today' | 'Yesterday' | 'Previous 7 days' | 'Previous 30 days' | 'Older';

export const DATE_BUCKETS: DateBucket[] = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older'];

export function dateBucket(ts: number, now: number = Date.now()): DateBucket {
  const startOfDay = (t: number) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days <= 7) return 'Previous 7 days';
  if (days <= 30) return 'Previous 30 days';
  return 'Older';
}
