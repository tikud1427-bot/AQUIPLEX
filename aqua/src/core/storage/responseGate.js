/**
 * AQUA — the response gate (scalability Phase 4A)
 *
 * Holds a response until what the request wrote is durable
 * (core/storage/requestWrites.js), and until any credit refund owed on an
 * error status has been recorded. Installed per request by aqua/router.js.
 *
 *   mutating request (not GET/HEAD/OPTIONS), JSON/HTML response
 *       its writes are flushed BEFORE the response is sent; if they cannot be
 *       made durable the success is replaced by a retryable 503 — the client
 *       was never told "done" for a change that only exists in this process.
 *   GET / HEAD / OPTIONS
 *       bookkeeping writes (e.g. reflection "surfaced" marks) are flushed
 *       before the response too, but a failure is logged, never turned into an
 *       error: a read must not fail because its bookkeeping could not be saved.
 *   Server-Sent Events, chat routes
 *       chat enforces its own boundary (routes/turnPostProcess.js
 *       commitTurnWithLearning): the turn is durable before `done` / the JSON
 *       answer. Here: a best-effort flush of anything written afterwards, logged.
 *   error status + req.creditContext
 *       the refund is awaited (bounded) before the response leaves, so an API
 *       exit right after an error cannot lose the user's credit. The usage
 *       guard's 'finish' net stays; refund() pays at most once per request.
 *
 * Nothing is gated when no store is authoritative on partitions and no refund
 * is owed: the default deployment is unchanged.
 */
import { hasScopeWrites, flushScopeStrict, noteReadWrites } from './requestWrites.js';

const READ = new Set(['GET', 'HEAD', 'OPTIONS']);
const REFUND_WAIT_MS = 5_000;

export function installResponseGate(req, res, { isChat = p => /^\/chat(\/|$)/.test(p) } = {}) {
  const origEnd = res.end;
  let gated = false;
  res.end = function gatedEnd(...args) {
    if (gated) return origEnd.apply(this, args);
    gated = true;
    const sse = String(res.getHeader?.('Content-Type') ?? '').includes('text/event-stream');
    const writes = hasScopeWrites();
    const refundOwed = res.statusCode >= 400 && typeof req.creditContext?.refund === 'function';
    const settleOwed = res.statusCode < 400 && typeof req.creditContext?.settle === 'function';
    if (!writes && !refundOwed && !settleOwed) return origEnd.apply(this, args);

    const strict = !sse && !READ.has(req.method) && !isChat(req.path ?? '') && !res.headersSent;
    (async () => {
      let endArgs = args;
      if (writes) {
        try { await flushScopeStrict(); }
        catch (err) {
          if (READ.has(req.method)) noteReadWrites();
          console.error(`[STORE] ${req.method} ${req.originalUrl ?? req.url} — writes not durable before the response (${strict ? 'refused: 503' : 'logged'}): ${err?.message ?? err}`);
          if (strict) {
            const body = JSON.stringify({
              success: false, code: 'UNAVAILABLE', retryable: true, retryAfterMs: 2_000,
              error: 'Your change could not be saved right now. Please try again.',
            });
            res.statusCode = 503;
            res.setHeader('Retry-After', '2');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Content-Length', Buffer.byteLength(body));
            res.removeHeader('ETag');
            endArgs = [body];
          }
        }
      }
      if (res.statusCode >= 400 && typeof req.creditContext?.refund === 'function') {
        await Promise.race([
          Promise.resolve().then(() => req.creditContext.refund()).catch(() => {}),
          new Promise(r => setTimeout(r, REFUND_WAIT_MS).unref?.()),
        ]);
      } else if (res.statusCode < 400 && typeof req.creditContext?.settle === 'function') {
        // Phase 4B — a successful request's pending charge becomes COMMITTED
        // before the response (a chat turn already committed it in its own
        // transaction: this is then a no-op). If it cannot be recorded, the
        // answer still goes out and the charge stays PENDING: the reconciler
        // refunds it after the abandon window — the failure favours the user.
        await Promise.race([
          Promise.resolve().then(() => req.creditContext.settle()).catch(err =>
            console.error(`[CHARGE] settle failed (charge stays PENDING, refunded if abandoned): ${err?.message ?? err}`)),
          new Promise(r => setTimeout(r, REFUND_WAIT_MS).unref?.()),
        ]);
      }
      origEnd.apply(res, endArgs);
    })().catch(err => {
      console.error(`[STORE] response gate failed: ${err?.message ?? err}`);
      try { origEnd.apply(res, args); } catch { /* socket gone */ }
    });
    return this;
  };
}
