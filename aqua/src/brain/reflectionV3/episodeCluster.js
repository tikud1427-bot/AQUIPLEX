/**
 * AQUA Brain — E9 / PR-4 episode clustering.
 *
 * Pure, deterministic clustering for episodic material before J3 consolidation.
 * This is deliberately a read-model computation: it does not author claims or
 * create a second semantic store.
 *
 * Hard boundaries:
 *   - one owner per invocation (L19)
 *   - stable ordering by event time then id
 *   - a new cluster starts when the temporal gap is too large or the theme
 *     changes without a shared subject
 */

const DEFAULT_GAP_MS = 30 * 60 * 1000;
const DEFAULT_MAX_EPISODES = 200;

const norm = v => String(v ?? '').trim().toLowerCase();

function timeOf(item) {
  const raw = item?.occurredAt ?? item?.endedAt ?? item?.startedAt ?? item?.ts ?? item?.createdAt ?? 0;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function subjectSet(item) {
  const values = [
    ...(Array.isArray(item?.subjects) ? item.subjects : []),
    ...(Array.isArray(item?.entityLabels) ? item.entityLabels : []),
    ...(Array.isArray(item?.entityIds) ? item.entityIds : []),
  ];
  return new Set(values.map(norm).filter(Boolean));
}

function overlap(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

function themeOf(item) {
  return norm(item?.theme ?? item?.title ?? item?.taskType ?? item?.conversationId);
}

function cohesive(previous, current, gapMs) {
  const gap = Math.max(0, timeOf(current) - timeOf(previous));
  if (gap > gapMs) return false;
  const aTheme = themeOf(previous);
  const bTheme = themeOf(current);
  if (aTheme && bTheme && aTheme === bTheme) return true;
  return overlap(subjectSet(previous), subjectSet(current));
}

export function clusterEpisodes({ ownerId, items = [], gapMs = DEFAULT_GAP_MS, maxItems = DEFAULT_MAX_EPISODES } = {}) {
  if (!ownerId) return [];
  if (!Array.isArray(items) || !items.length) return [];
  const safeGap = Number.isFinite(Number(gapMs)) ? Math.max(0, Number(gapMs)) : DEFAULT_GAP_MS;
  const safeMax = Math.max(1, Math.min(DEFAULT_MAX_EPISODES, Number(maxItems) || DEFAULT_MAX_EPISODES));

  const selected = items.slice(0, safeMax).filter(Boolean);
  for (const item of selected) {
    if (item.ownerId != null && item.ownerId !== ownerId) {
      throw new Error('episode clustering cannot mix owners');
    }
  }

  const ordered = [...selected].sort((a, b) => {
    const dt = timeOf(a) - timeOf(b);
    if (dt) return dt;
    return String(a.id ?? a.eventId ?? a.conversationId ?? '').localeCompare(String(b.id ?? b.eventId ?? b.conversationId ?? ''));
  });

  const clusters = [];
  for (const item of ordered) {
    const previous = clusters.at(-1)?.items.at(-1);
    if (!previous || !cohesive(previous, item, safeGap)) {
      clusters.push({
        ownerId,
        episodeId: `episode:${clusters.length + 1}`,
        startedAt: timeOf(item),
        endedAt: timeOf(item),
        themes: new Set(themeOf(item) ? [themeOf(item)] : []),
        subjects: new Set(subjectSet(item)),
        items: [item],
      });
      continue;
    }

    const cluster = clusters.at(-1);
    cluster.items.push(item);
    cluster.endedAt = timeOf(item);
    if (themeOf(item)) cluster.themes.add(themeOf(item));
    for (const subject of subjectSet(item)) cluster.subjects.add(subject);
  }

  return clusters.map(cluster => ({
    ownerId,
    episodeId: cluster.episodeId,
    startedAt: cluster.startedAt,
    endedAt: cluster.endedAt,
    themes: [...cluster.themes].slice(0, 8),
    subjects: [...cluster.subjects].slice(0, 16),
    itemIds: cluster.items.map(x => x.id ?? x.eventId ?? x.conversationId ?? null),
    items: cluster.items,
  }));
}
