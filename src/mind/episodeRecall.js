/**
 * AQUA Mind — Episodic Recall (Memory 5.0, Phase C)
 * ─────────────────────────────────────────────────────────────────────────────
 * Episodes were write-only arcs. This makes past experience retrievable:
 * "what did we do about the deploy last month" → the deploy episode, its
 * outcome and lessons, injected as context.
 *
 *   isPastRecallQuery(q)          — past-tense recall intent
 *   recallEpisodes(mind, query)   — scored past/active arcs matching query
 *   formatEpisodeRecall(list)     — compact prompt block
 *
 * Scoring (pure, zero-LLM): token overlap between the query and the
 * episode's title/objectives/lessons/outcome, weighted by episode
 * importance, with mild recency decay. On a past-recall query with no token
 * match, the most recent CLOSED episodes surface ("what were we doing?").
 */

const MIN_TOKEN_LEN = 3;
const MAX_EPISODES_DEFAULT = 2;
const DAY_MS = 24 * 3600 * 1000;

const PAST_RECALL_PATTERNS = [
  /\bwhat (?:did|were|was|happened)\b/i,
  /\blast (?:time|week|month|session)\b/i,
  /\b(?:previously|earlier|before) (?:we|i|you)\b/i,
  /\bremember (?:when|how|what)\b/i,
  /\bwhat (?:did we|have we) (?:do|done|decide|discuss|work)/i,
  /\bwhere (?:did|were) we\b/i,
];

export function isPastRecallQuery(query) {
  const q = String(query || '');
  return PAST_RECALL_PATTERNS.some(p => p.test(q));
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'what', 'did', 'was', 'were',
  'about', 'when', 'how', 'why', 'where', 'you', 'your', 'our', 'have',
  'has', 'had', 'last', 'time', 'week', 'month', 'remember', 'happened',
  'doing', 'done', 'work', 'working', 'session', 'earlier', 'before', 'previously',
]);

function tokensOf(text) {
  return (String(text || '').toLowerCase().match(/[a-z0-9_.-]+/g) || [])
    .filter(t => t.length >= MIN_TOKEN_LEN && !STOPWORDS.has(t));
}

function episodeText(ep) {
  return [
    ep.title,
    ...(ep.objectives || []),
    ...(ep.lessons || []),
    ep.outcome || '',
  ].join(' ');
}

/**
 * @returns {Array<{ episode, score }>} best-first, empty when nothing relevant.
 */
export function recallEpisodes(mind, query, { limit = MAX_EPISODES_DEFAULT, now = Date.now() } = {}) {
  try {
    const episodes = Object.values(mind?.episodes || {});
    if (!episodes.length) return [];

    const qTokens = new Set(tokensOf(query));
    const pastIntent = isPastRecallQuery(query);

    const scored = [];
    for (const ep of episodes) {
      if (!ep?.title) continue;
      const epTokens = new Set(tokensOf(episodeText(ep)));
      let overlap = 0;
      for (const t of qTokens) if (epTokens.has(t)) overlap++;

      let score = 0;
      if (overlap > 0) {
        score = overlap * 10 + (ep.importance || 5);
        const ageDays = (now - (ep.lastActivityAt || ep.startedAt || now)) / DAY_MS;
        score *= Math.pow(0.5, ageDays / 45); // 45-day half-life — old arcs fade, never vanish
        if (ep.outcome) score *= 1.2;         // resolved arcs carry lessons
      } else if (pastIntent && ep.status !== 'active') {
        // "what were we doing?" with no named topic → most recent closed arcs
        const ageDays = (now - (ep.endedAt || ep.lastActivityAt || now)) / DAY_MS;
        score = Math.max(0.5, 6 - ageDays / 7);
      }
      if (score > 0) scored.push({ episode: ep, score: +score.toFixed(2) });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Most recent episode, active-first (Phase F continuation fallback: "let's
 * continue" should resurface the arc the user was living, token match or not).
 */
export function latestEpisode(mind) {
  const eps = Object.values(mind?.episodes || {});
  if (!eps.length) return null;
  const active = eps.filter(e => e.status === 'active')
    .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))[0];
  if (active) return active;
  return eps.sort((a, b) => (b.endedAt || b.lastActivityAt || 0) - (a.endedAt || a.lastActivityAt || 0))[0] || null;
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatEpisodeRecall(list) {
  if (!list?.length) return '';
  const lines = list.map(({ episode: ep }) => {
    const bits = [`"${ep.title}"`];
    const when = fmtDate(ep.endedAt || ep.lastActivityAt || ep.startedAt);
    if (when) bits.push(`(${when}${ep.status === 'active' ? ', ongoing' : ''})`);
    if (ep.outcome) bits.push(`— outcome: ${ep.outcome}`);
    const lesson = (ep.lessons || [])[0];
    if (lesson) bits.push(`— lesson: ${lesson}`);
    return `- ${bits.join(' ')}`;
  });
  return [
    '--- PAST EPISODES (episodic memory) ---',
    ...lines,
    '--- END PAST EPISODES ---',
  ].join('\n');
}
