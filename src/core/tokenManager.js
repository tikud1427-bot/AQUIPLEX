export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

export function buildContextWindow(
  history,
  maxTokens = 12000
) {
  const selected = [];
  let used = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    const tokens =
      estimateTokens(msg.content);

    if (used + tokens > maxTokens)
      break;

    selected.unshift(msg);
    used += tokens;
  }

  return selected;
}