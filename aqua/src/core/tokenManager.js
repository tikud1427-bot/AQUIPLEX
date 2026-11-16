export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Conversation history window (2026-11-16, audit D-08).
 *
 * BEFORE: walk newest → oldest and `break` at the first message that does not
 * fit. One long recent message (a pasted document, a long answer) therefore
 * erased EVERY older turn — including the antecedent of the next "it" — and,
 * when the newest message alone exceeded the budget, the window was empty.
 *
 * NOW (same budget, same estimate):
 *   - The window is still a CONTIGUOUS suffix of the history. Callers rely on
 *     that (`history.length - window.length` is the index of the first message
 *     the model sees; recall / information-needs exclude from there).
 *   - The newest exchange is always present. A message that does not fit is
 *     included as a TRUNCATED COPY (head + tail, with an explicit marker) when
 *     at least MIN_TRUNCATED_TOKENS of budget remain; the walk then stops.
 *   - The window never starts with an assistant message whose question was cut
 *     off: that orphan is dropped (or its question is kept truncated if the
 *     budget allows).
 *   - Store objects are never mutated: truncation makes a copy.
 *   - `buildContextWindowWithStats` reports included / excluded / truncated
 *     counts — numbers only, never content — for logs.
 */
const MIN_TRUNCATED_TOKENS = 120;
const QUESTION_RESERVE = 300;   // max tokens kept of a question whose answer is truncated
const HEAD_SHARE = 0.75;

function truncateCopy(msg, maxTokens) {
  const content = String(msg.content ?? '');
  const maxChars = Math.max(0, maxTokens * 4 - 80);   // room for the marker
  if (content.length <= maxChars) return { ...msg, content };
  const head = Math.floor(maxChars * HEAD_SHARE);
  const tail = Math.max(0, maxChars - head);
  const omitted = content.length - head - tail;
  return {
    ...msg,
    content: `${content.slice(0, head)}\n[… ${omitted} characters omitted to fit the context window …]\n${tail ? content.slice(content.length - tail) : ''}`,
    truncated: true,
  };
}

export function buildContextWindowWithStats(history, maxTokens = 12000) {
  const msgs = Array.isArray(history) ? history : [];
  const selected = [];
  let used = 0;
  let truncated = 0;

  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    const tokens = estimateTokens(String(msg?.content ?? ''));
    if (used + tokens <= maxTokens) {
      selected.unshift(msg);
      used += tokens;
      continue;
    }
    const remaining = maxTokens - used;
    const newestExchange = selected.length < 2;
    if (remaining >= MIN_TRUNCATED_TOKENS || (newestExchange && remaining >= 40)) {
      // An answer is only useful with its question: reserve room for the
      // question (itself truncated to at most QUESTION_RESERVE) before
      // truncating the answer, so neither ends up orphaned.
      const question = msg?.role === 'assistant' && msgs[i - 1]?.role === 'user' ? msgs[i - 1] : null;
      const reserve = question ? Math.min(estimateTokens(String(question.content ?? '')) + 20, QUESTION_RESERVE, Math.floor(remaining / 2)) : 0;
      const copy = truncateCopy(msg, remaining - reserve);
      selected.unshift(copy);
      used += estimateTokens(copy.content);
      truncated += 1;
      if (question) {
        const room = maxTokens - used;
        const qTokens = estimateTokens(String(question.content ?? ''));
        if (qTokens <= room) { selected.unshift(question); used += qTokens; }
        else if (room >= 40) { const q = truncateCopy(question, room); selected.unshift(q); used += estimateTokens(q.content); truncated += 1; }
      }
    }
    break;
  }

  // Never open on an orphaned assistant message (its question was cut off).
  if (selected.length && selected[0]?.role === 'assistant') {
    const firstIdx = msgs.length - selected.length;
    const question = msgs[firstIdx - 1];
    const remaining = maxTokens - used;
    if (question?.role === 'user' && remaining >= 40) {
      const copy = truncateCopy(question, remaining);
      selected.unshift(copy);
      used += estimateTokens(copy.content);
      truncated += 1;
    } else {
      used -= estimateTokens(String(selected[0].content ?? ''));
      selected.shift();
    }
  }

  return {
    messages: selected,
    stats: { included: selected.length, excluded: msgs.length - selected.length, truncated, tokens: used, budget: maxTokens },
  };
}

export function buildContextWindow(history, maxTokens = 12000) {
  return buildContextWindowWithStats(history, maxTokens).messages;
}
