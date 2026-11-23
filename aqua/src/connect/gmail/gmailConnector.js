/**
 * AQUA Connect — Gmail connector over an INJECTED read-only transport (Phase 1)
 *
 * A contract-conformant connector (connect/contract.js) for the EXISTING
 * engine: connectService (lease, fencing, sealed credentials), syncEngine
 * (paging, change detection, mass-deletion guard, disconnect guard) and the
 * external-source lifecycle (files/externalSources.js). It adds no store, no
 * sync engine and no route.
 *
 * ACTIVATION (Phase 2A)
 *   · No transport is constructed here. routes/connect.js registers this
 *     connector over the real REST transport (gmail/googleGmailTransport.js)
 *     ONLY when AQUA_GMAIL_CONNECT=on and the OAuth config is complete
 *     (gmail/gmailOAuthConfig.js). Off by default. The test-only mock
 *     (connect/testing/mockGmailTransport.js) passes on `testOnly`, so the
 *     production registry refuses it.
 *   · No OAuth client, no Google endpoint, no credential lives in this file.
 *
 * READ-ONLY
 *   The transport interface below has no write method. A transport that
 *   exposes one (send, delete, trash, modify, insert, import, …) is REFUSED at
 *   construction, and the connector only ever calls the read methods.
 *
 * DATA CLASS
 *   The connector id is `gmail`, so every source is `gmail:<connectionId>` and
 *   every object derived from it is `external:gmail` (core/dataClass.js:
 *   frozen at NO provider). The definition declares no `dataPolicy` (the
 *   registry refuses one for Gmail). Classification is by connector, never by
 *   content.
 *
 * Transport interface (a future real transport implements exactly this):
 *   readOnly: true                                  required marker
 *   testOnly?: boolean
 *   exchangeCode({ code, redirectUri, codeVerifier })
 *                                                → { accessToken, refreshToken, expiresAt, scopes }
 *                                                  (scopes REQUIRED: exactly gmail.readonly)
 *   refreshAccessToken(refreshToken)             → { accessToken, refreshToken?, expiresAt, scopes? }
 *   revokeToken(token)                           → void
 *   getProfile(accessToken)                      → { emailAddress, messagesTotal, historyId }
 *   listMessages(accessToken, { pageToken, maxResults, includeSpamTrash: false })
 *                                                → { messages: [{ id, threadId }], nextPageToken?, resultSizeEstimate? }
 *   getMessage(accessToken, id, { format: 'full'|'metadata' }) → Gmail Message
 *   getThread(accessToken, threadId, { format: 'metadata' })   → { id, historyId, messages: [Message] }
 *   listHistory(accessToken, { startHistoryId, pageToken })    → { history: [HistoryRecord], nextPageToken?, historyId }
 *   health?()                                    → { ok, detail? }
 * Errors carry an HTTP-like `status`: 401/403 → AUTH, 404 → NOT_FOUND (on
 * history: the cursor expired), 429/5xx → TRANSIENT, anything else PERMANENT.
 * Provider error text is never propagated.
 */
import { ConnectorError } from '../contract.js';
import {
  parseGmailMessage, renderGmailDocument, threadRelations, isExcluded,
  resourceIdOf, gmailIdOf, resourceNameOf,
} from './gmailNormalize.js';

export const GMAIL_CONNECTOR_ID = 'gmail';
import { GMAIL_READONLY_SCOPE } from './gmailOAuthConfig.js';
export { GMAIL_READONLY_SCOPE };

const READ_METHODS = ['exchangeCode', 'refreshAccessToken', 'revokeToken', 'getProfile', 'listMessages', 'getMessage', 'getThread', 'listHistory'];
const WRITE_SHAPED = /^(send|delete|trash|untrash|modify|insert|import|batch|create|update|patch|watch|stop|draft|label|filter|forward|setting)/i;

export class GmailTransportError extends Error {
  constructor(code, message) { super(message); this.name = 'GmailTransportError'; this.code = code; }
}

/** Refuse anything but an explicit, read-only transport. */
function assertReadOnlyTransport(t) {
  if (!t || typeof t !== 'object') throw new GmailTransportError('NO_TRANSPORT', 'a Gmail transport must be injected');
  if (t.readOnly !== true) throw new GmailTransportError('NOT_READ_ONLY', 'the Gmail transport must declare readOnly: true');
  for (const m of READ_METHODS) if (typeof t[m] !== 'function') throw new GmailTransportError('INCOMPLETE_TRANSPORT', `the Gmail transport lacks ${m}()`);
  const names = new Set();
  for (let o = t; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) for (const k of Object.getOwnPropertyNames(o)) names.add(k);
  const writes = [...names].filter(k => typeof t[k] === 'function' && WRITE_SHAPED.test(k));
  if (writes.length) throw new GmailTransportError('WRITE_METHOD_PRESENT', `the Gmail transport exposes write-shaped methods (${writes.join(', ')}); Phase 1 is read-only`);
}

/** A transport failure → a connector error kind. Never the provider's own text. */
/**
 * 2026-11-23 (real-mailbox test: every 403 was read as "reconnect"). Google's 403 carries a
 * structured reason; the classification follows it:
 *   429, 403 rateLimitExceeded|userRateLimitExceeded → TRANSIENT, rateLimited (backoff; never a reconnect)
 *   401                                             → AUTH (reconnect)
 *   403 + a permission / scope / access reason       → AUTH (reconnect)
 *   403 dailyLimitExceeded|quotaExceeded             → REFUSED (quota): the run stops, status kept
 *   403 with any other or no reason                  → REFUSED (unknown): the run stops, status kept —
 *                                                      never assumed to be a rate limit, never a reconnect
 * The reason code travels on the error (err.reason); Google's free text never does.
 */
export const GMAIL_RATE_LIMIT_REASONS = Object.freeze(['rateLimitExceeded', 'userRateLimitExceeded']);
export const GMAIL_PERMISSION_REASONS = Object.freeze(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'authError', 'domainPolicy', 'accessDenied']);
export const GMAIL_QUOTA_REASONS = Object.freeze(['dailyLimitExceeded', 'quotaExceeded']);
function mapError(err, { history = false } = {}) {
  if (err instanceof ConnectorError) return err;
  const s = Number(err?.status ?? err?.code);
  const reason = typeof err?.reason === 'string' ? err.reason : null;
  const why = reason ? ` ${reason}` : '';
  const detail = { status: s, reason };
  const withPause = e => { const ra = Number(err?.retryAfterMs); if (Number.isFinite(ra) && ra >= 0) e.retryAfterMs = ra; return e; };
  if (s === 401) return new ConnectorError('AUTH', `Gmail refused the credentials (401${why})`, detail);
  if (s === 429 || (s === 403 && GMAIL_RATE_LIMIT_REASONS.includes(reason))) {
    return withPause(new ConnectorError('TRANSIENT', `Gmail rate limit (${s}${why})`, { ...detail, rateLimited: true }));
  }
  if (s === 403 && GMAIL_PERMISSION_REASONS.includes(reason)) return new ConnectorError('AUTH', `Gmail denied access (403${why})`, detail);
  if (s === 403 && GMAIL_QUOTA_REASONS.includes(reason)) return new ConnectorError('REFUSED', `Gmail quota exhausted (403${why}); try again later`, detail);
  if (s === 403) return new ConnectorError('REFUSED', `Gmail refused the request for an unrecognised reason (403${why || ' no reason given'}); the connection was left unchanged`, detail);
  if (s === 404) return history ? new ConnectorError('CURSOR_EXPIRED', 'Gmail change history no longer reaches the saved position (404)') : new ConnectorError('NOT_FOUND', 'no such Gmail message (404)');
  if (s === 429 || (s >= 500 && s < 600)) {
    // Gmail Phase 2: a server-requested pause travels with the error (syncEngine.withRetry honours it, bounded).
    const e = new ConnectorError('TRANSIENT', `Gmail is unavailable (${s})`);
    const ra = Number(err?.retryAfterMs);
    if (Number.isFinite(ra) && ra >= 0) e.retryAfterMs = ra;
    return e;
  }
  if (/ECONNRESET|ETIMEDOUT|timeout/i.test(String(err?.code ?? '') + String(err?.name ?? ''))) return new ConnectorError('TRANSIENT', 'Gmail did not respond');
  const e = new ConnectorError('PERMANENT', `Gmail request failed${Number.isFinite(s) ? ` (${s})` : ''}`);
  if (Number.isFinite(s)) e.status = s;   // Gmail Phase 2: lets listResources recognise a rejected page token (400)
  return e;
}

const call = async (fn, opts) => { try { return await fn(); } catch (err) { throw mapError(err, opts); } };

// The full-listing cursor is opaque to the engine (≤ SYNC_LIMITS.maxCursorChars):
// the Gmail page token, the mailbox historyId taken BEFORE the first page
// (the incremental start point), and progress.
const encodeCursor = c => JSON.stringify({ v: 1, p: c.p, h: c.h, n: c.n, e: c.e ?? null });
function decodeCursor(cursor) {
  if (cursor == null) return null;
  let c;
  // Gmail Phase 2: a saved cursor that cannot be decoded can never be resumed — CURSOR_EXPIRED
  // tells the engine to discard it and list from the start (rather than fail on it forever).
  try { c = JSON.parse(cursor); } catch { throw new ConnectorError('CURSOR_EXPIRED', 'invalid Gmail listing cursor'); }
  if (!c || c.v !== 1 || typeof c.p !== 'string' || !c.p || typeof c.h !== 'string' || !/^\d{1,30}$/.test(c.h)) {
    throw new ConnectorError('CURSOR_EXPIRED', 'invalid Gmail listing cursor');
  }
  return { p: c.p, h: c.h, n: Number.isFinite(c.n) ? c.n : 0, e: Number.isFinite(c.e) ? c.e : null };
}
const validHistoryId = h => (typeof h === 'string' || typeof h === 'number') && /^\d{1,30}$/.test(String(h));

/**
 * @param {object} opts
 * @param {object} opts.transport          injected read-only Gmail transport (required)
 * @param {number} [opts.pageSize]         messages per listing page (Gmail max 500)
 * @param {number} [opts.maxHistoryPages]  history pages per incremental run
 * @param {string} [opts.version]
 */
export function createGmailConnector({ transport, pageSize = 100, maxHistoryPages = 20, version = '0.1.0', revokeTimeoutMs = 10_000 } = {}) {
  assertReadOnlyTransport(transport);
  const t = transport;
  const token = ctx => {
    const c = ctx?.credentials?.();
    if (!c || typeof c.accessToken !== 'string' || !c.accessToken) throw new ConnectorError('AUTH', 'no Gmail access token');
    return c.accessToken;
  };
  /**
   * F2 — revoke a grant this connector was just issued and will not hand on.
   * Bounded (revokeTimeoutMs), never throws, logs nothing; revoking the refresh
   * token revokes the whole grant at Google. Returns 'revoked' | 'failed' | 'not_attempted'.
   */
  const revokeGrant = async issued => {
    const tok = issued?.refreshToken || issued?.accessToken;
    if (typeof tok !== 'string' || !tok) return 'not_attempted';
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => t.revokeToken(tok)),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('revocation timed out')), revokeTimeoutMs); timer.unref?.(); }),
      ]);
      return 'revoked';
    } catch { return 'failed'; }
    finally { clearTimeout(timer); }
  };
  const ref = (id, { version: v = null, updatedAt = null } = {}) => ({ externalId: resourceIdOf(id), name: resourceNameOf(id), type: 'email', version: v, updatedAt });

  // ── adapter capabilities (also usable on their own, read-only) ────────────
  const gmail = Object.freeze({
    /** One page of message ids (SPAM/TRASH excluded). */
    async listMessages(ctx, { pageToken = null } = {}) {
      const r = await call(() => t.listMessages(token(ctx), { pageToken: pageToken ?? undefined, maxResults: pageSize, includeSpamTrash: false }));
      return {
        messages: (Array.isArray(r?.messages) ? r.messages : []).filter(m => typeof m?.id === 'string' && m.id).map(m => ({ id: m.id, threadId: typeof m.threadId === 'string' ? m.threadId : null })),
        nextPageToken: typeof r?.nextPageToken === 'string' && r.nextPageToken ? r.nextPageToken : null,
        resultSizeEstimate: Number.isFinite(r?.resultSizeEstimate) ? r.resultSizeEstimate : null,
      };
    },
    /** A whole message, parsed (body + attachment metadata). */
    async getMessage(ctx, id) { return parseGmailMessage(await call(() => t.getMessage(token(ctx), id, { format: 'full' }))); },
    /** Headers, labels and attachment metadata only — no body. */
    async getMetadata(ctx, id) { return parseGmailMessage(await call(() => t.getMessage(token(ctx), id, { format: 'metadata' })), { includeBody: false }); },
    /** A thread's messages (metadata) and their reply relationships. */
    async getThread(ctx, threadId) {
      const r = await call(() => t.getThread(token(ctx), threadId, { format: 'metadata' }));
      const parsed = (Array.isArray(r?.messages) ? r.messages : []).map(m => parseGmailMessage(m, { includeBody: false }));
      return { threadId: typeof r?.id === 'string' ? r.id : threadId, messages: threadRelations(parsed) };
    },
    /** Progress of an unfinished full listing (from the saved cursor). */
    progressOf(cursor) {
      try { const c = decodeCursor(cursor); return c ? { listed: c.n, estimate: c.e } : null; } catch { return null; }
    },
  });

  return {
    id: GMAIL_CONNECTOR_ID,
    displayName: 'Gmail (read-only)',
    version,
    testOnly: t.testOnly === true,
    // No dataPolicy: Gmail's provider policy is frozen in core/dataClass.js (NONE).
    auth: { type: 'oauth2', scopes: [GMAIL_READONLY_SCOPE] },
    capabilities: ['list', 'fetch', 'sync', 'incremental', 'refresh'],
    resourceTypes: ['email'],
    permissions: ['read:email'],
    gmail,

    /**
     * Phase 2A: `redirectUri` and `codeVerifier` (PKCE) are passed to the
     * transport's token exchange unchanged — the OAuth flow (routes/connect.js)
     * supplies them from its own config and the session-bound flow record,
     * never from request data.
     */
    async connect({ code, redirectUri = undefined, codeVerifier = undefined } = {}) {
      if (typeof code !== 'string' || !code) throw new ConnectorError('AUTH', 'authorisation code missing');
      const issued = await call(() => t.exchangeCode({ code, redirectUri, codeVerifier }));
      // F2: from here on Google has issued a grant. Every failure below revokes it
      // (bounded, best effort) before the ORIGINAL error is thrown.
      if (!issued?.accessToken) {
        await revokeGrant(issued);
        throw new ConnectorError('AUTH', 'Gmail issued no access token');
      }
      // STRICT (Phase 2A): the grant must state its scopes and be EXACTLY gmail.readonly.
      // Broader (any other scope) or narrower (read-only unchecked on the consent
      // screen, or no scope list at all) is refused, and the grant is revoked.
      const granted = Array.isArray(issued.scopes) ? [...new Set(issued.scopes.map(String))] : null;
      const exact = granted && granted.length === 1 && granted[0] === GMAIL_READONLY_SCOPE;
      if (!exact) {
        await revokeGrant(issued);
        throw new ConnectorError('AUTH', granted && granted.some(s => s !== GMAIL_READONLY_SCOPE)
          ? 'Gmail granted more than read-only access; refused'
          : 'Gmail did not grant read-only access; refused');
      }
      let profile;
      try { profile = await call(() => t.getProfile(issued.accessToken)); }
      catch (err) { await revokeGrant(issued); throw err; }   // F2: profile failure — the grant is never left behind
      const email = typeof profile?.emailAddress === 'string' ? profile.emailAddress : '';
      return {
        account: { externalAccountId: email ? `gmail:${email.toLowerCase()}` : null, label: email ? `Gmail · ${maskEmail(email)}` : 'Gmail' },
        credentials: { accessToken: issued.accessToken, refreshToken: issued.refreshToken ?? null },
        expiresAt: Number.isFinite(issued.expiresAt) ? issued.expiresAt : null,
        scopes: granted,
      };
    },

    async refresh(credentials) {
      if (!credentials?.refreshToken) throw new ConnectorError('AUTH', 'no refresh token');
      const r = await call(() => t.refreshAccessToken(credentials.refreshToken));
      if (!r?.accessToken) throw new ConnectorError('AUTH', 'refresh refused');
      // A refreshed token whose stated scopes are anything but read-only is refused (never used).
      if (Array.isArray(r.scopes) && (r.scopes.length === 0 || r.scopes.some(s => String(s) !== GMAIL_READONLY_SCOPE))) {
        throw new ConnectorError('AUTH', 'refreshed Gmail access is not read-only; refused');
      }
      return { credentials: { accessToken: r.accessToken, refreshToken: r.refreshToken ?? credentials.refreshToken }, expiresAt: Number.isFinite(r.expiresAt) ? r.expiresAt : null };
    },

    async disconnect(ctx) {
      const c = ctx.credentials();
      await call(() => t.revokeToken(c.refreshToken ?? c.accessToken));
    },

    /**
     * Full listing. The first page reads the mailbox historyId BEFORE listing:
     * any change after that point is replayed by the next incremental run
     * (idempotent), so nothing between the listing and the checkpoint is lost.
     */
    async listResources(ctx, { cursor = null } = {}) {
      const prev = decodeCursor(cursor);
      let h = prev?.h ?? null;
      if (!h) {
        const profile = await call(() => t.getProfile(token(ctx)));
        if (!validHistoryId(profile?.historyId)) throw new ConnectorError('PERMANENT', 'Gmail returned no mailbox position');
        h = String(profile.historyId);
      }
      let page;
      try { page = await gmail.listMessages(ctx, { pageToken: prev?.p ?? null }); }
      catch (err) {
        // Gmail Phase 2: Gmail answers 400 for a page token it no longer accepts — the saved
        // listing position is dead (the engine discards it; nothing is deleted on this path).
        if (prev && err?.kind === 'PERMANENT' && err.status === 400) throw new ConnectorError('CURSOR_EXPIRED', 'Gmail no longer accepts the saved listing position (400)');
        throw err;
      }
      const n = (prev?.n ?? 0) + page.messages.length;
      const resources = page.messages.map(m => ref(m.id));
      if (page.nextPageToken) return { resources, cursor: encodeCursor({ p: page.nextPageToken, h, n, e: page.resultSizeEstimate ?? prev?.e }) };
      return { resources, cursor: null, checkpoint: { historyId: h } };
    },

    /** Gmail Phase 2: progress of an unfinished full listing (from the saved cursor), for status APIs. */
    progressOf: cursor => gmail.progressOf(cursor),

    /**
     * Gmail Phase 2 — confirm a proposed removal with the source before it is
     * applied (syncEngine). Headers-only fetch: 'gone' when Gmail answers 404 or
     * the message is now out of scope (TRASH/SPAM/DRAFT); 'present' otherwise.
     * Any other failure is thrown (the engine keeps the resource).
     */
    async confirmRemoval(ctx, externalId) {
      const id = gmailIdOf(externalId);
      if (!id) return 'gone';
      let raw;
      try { raw = await call(() => t.getMessage(token(ctx), id, { format: 'metadata' })); }
      catch (err) { if (err?.kind === 'NOT_FOUND') return 'gone'; throw err; }
      if (raw?.id !== id) return 'unknown';
      return isExcluded(raw.labelIds) ? 'gone' : 'present';
    },

    /** A message in SPAM/TRASH/DRAFT is outside the scope: reported as gone. */
    async fetchResource(ctx, r) {
      const id = gmailIdOf(r?.externalId);
      if (!id) throw new ConnectorError('NOT_FOUND', 'not a Gmail message reference');
      const raw = await call(() => t.getMessage(token(ctx), id, { format: 'full' }));
      if (raw?.id !== id) throw new ConnectorError('PERMANENT', 'Gmail returned a different message');
      if (isExcluded(raw.labelIds)) throw new ConnectorError('NOT_FOUND', 'message is in trash or spam');
      return raw;
    },

    normalize(raw, r) {
      const m = parseGmailMessage(raw);
      return {
        externalId: r?.externalId ?? resourceIdOf(m.gmailId),
        name: resourceNameOf(m.gmailId),
        content: renderGmailDocument(m),
        sourceUpdatedAt: m.internalDate ?? m.date,
        version: m.historyId,
        // No title (a subject is content; it stays inside the restricted document).
        title: null,
        url: null,
      };
    },

    /**
     * Incremental: replay history since the checkpoint. Later records win per
     * message. Added/relabelled → changed (the engine refetches; identical
     * bytes are "unchanged"); deleted, or moved to TRASH/SPAM → removed.
     * A checkpoint Gmail no longer has history for → CURSOR_EXPIRED (the
     * engine falls back to a full listing; it never loops on a dead cursor).
     */
    async syncChanges(ctx, { checkpoint } = {}) {
      const start = checkpoint?.historyId;
      if (!validHistoryId(start)) throw new ConnectorError('CURSOR_EXPIRED', 'no Gmail history position saved');
      const state = new Map();    // gmailId → 'changed' | 'removed'
      let pageToken = null;
      let last = String(start);
      let mailboxHistoryId = null;
      for (let page = 0; page < maxHistoryPages; page++) {
        const r = await call(() => t.listHistory(token(ctx), { startHistoryId: String(start), pageToken: pageToken ?? undefined }), { history: true });
        for (const rec of Array.isArray(r?.history) ? r.history : []) {
          applyHistoryRecord(state, rec);
          if (validHistoryId(rec?.id) && BigInt(rec.id) > BigInt(last)) last = String(rec.id);
        }
        if (validHistoryId(r?.historyId)) mailboxHistoryId = String(r.historyId);
        pageToken = typeof r?.nextPageToken === 'string' && r.nextPageToken ? r.nextPageToken : null;
        if (!pageToken) break;
      }
      const changed = [], removed = [];
      for (const [id, s] of state) (s === 'removed' ? removed : changed).push(id);
      // More history than this run reads: resume after the last record seen.
      const next = pageToken ? last : (mailboxHistoryId && BigInt(mailboxHistoryId) > BigInt(last) ? mailboxHistoryId : last);
      return { changed: changed.map(id => ref(id)), removed: removed.map(resourceIdOf), checkpoint: { historyId: next } };
    },

    async health() {
      if (typeof t.health !== 'function') return { ok: true };
      try { const r = await t.health(); return { ok: Boolean(r?.ok), detail: r?.ok ? null : 'unavailable' }; }
      catch { return { ok: false, detail: 'unavailable' }; }
    },
  };
}

function applyHistoryRecord(state, rec) {
  if (!rec || typeof rec !== 'object') return;
  const each = (list, fn) => { for (const x of Array.isArray(list) ? list : []) { const m = x?.message; if (typeof m?.id === 'string' && m.id) fn(m, x); } };
  each(rec.messagesAdded, m => state.set(m.id, isExcluded(m.labelIds) ? 'removed' : 'changed'));
  // `message.labelIds` in a history item is the message's label set after that change.
  each(rec.labelsAdded, (m, x) => state.set(m.id, isExcluded(x.labelIds) || isExcluded(m.labelIds) ? 'removed' : 'changed'));
  each(rec.labelsRemoved, m => state.set(m.id, isExcluded(m.labelIds) ? 'removed' : 'changed'));
  each(rec.messagesDeleted, m => state.set(m.id, 'removed'));
}

function maskEmail(email) {
  const [user, domain] = String(email).split('@');
  if (!domain) return '***';
  return `${user.slice(0, 1)}***@${domain}`;
}
