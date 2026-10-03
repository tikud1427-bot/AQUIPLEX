/**
 * errorText — an error rendered so a log line is never blank.
 *
 * MEASURED, from a Windows boot log:  `[DRIFT] check unavailable: `  — nothing
 * after the colon. Node connects to `localhost` over both ::1 and 127.0.0.1 and,
 * when both are refused, throws an AggregateError whose `.message` is the EMPTY
 * STRING (the detail lives in `.code` and `.errors[]`). Every log site that
 * wrote `${err.message}` printed an empty reason for the single most common
 * local failure — "Postgres is not running" — on the very line meant to say so.
 *
 * Rules, in order: the message if there is one; else the code; else the
 * constructor name. Aggregates append their distinct inner messages. Always
 * returns a non-empty string, never throws, never includes a stack.
 */
export function errorText(err) {
  try {
    if (err == null) return 'unknown error';
    if (typeof err === 'string') return err || 'unknown error';

    const code = err.code ? String(err.code) : '';
    let head = typeof err.message === 'string' ? err.message.trim() : '';
    if (!head) head = code || err.name || err.constructor?.name || 'error';
    else if (code && !head.includes(code)) head = `${head} (${code})`;

    if (Array.isArray(err.errors) && err.errors.length) {
      const inner = [...new Set(err.errors
        .map(e => (typeof e?.message === 'string' && e.message.trim()) || e?.code || '')
        .filter(Boolean)
        .map(String))].slice(0, 3);
      const fresh = inner.filter(m => !head.includes(m));
      if (fresh.length) head = `${head}: ${fresh.join('; ')}`;
    }
    return head;
  } catch {
    return 'unreadable error';
  }
}
