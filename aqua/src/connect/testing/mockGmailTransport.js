/**
 * AQUA Connect — deterministic MOCK Gmail service (Gmail Phase 1, test-only)
 *
 * An in-memory stand-in for the Gmail REST API, returning Gmail API
 * structures (users.messages.list/get, users.threads.get, users.history.list,
 * users.getProfile) so the Gmail connector can be proven end to end with no
 * account, no OAuth, no network and no credentials.
 *
 *   const svc = createMockGmailService();   // the "remote service" + test controls
 *   svc.transport                           // what the connector receives: read methods only
 *
 * The TRANSPORT is a frozen object with read methods only, `readOnly: true`
 * and `testOnly: true` (the connector inherits testOnly, so the production
 * registry refuses it). Mailbox mutation (add, relabel, trash, delete, expire
 * history, revoke) lives on the SERVICE object, which the connector never
 * sees — exactly as a user acting in Gmail.
 *
 * Determinism: no clock except the injectable `now`, counters for tokens and
 * history ids, listing order = internalDate descending then id.
 */
import crypto from 'node:crypto';

const DEFAULT_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const s256 = v => crypto.createHash('sha256').update(String(v)).digest('base64url');

const httpError = status => Object.assign(new Error(`mock gmail: ${status}`), { status });

export function createMockGmailService({ now = () => 1_767_225_600_000, tokenTtlMs = 3_600_000, historyPageSize = 3, startHistoryId = 1000 } = {}) {
  const boxes = new Map();          // email → { messages: Map, history: [], historyId, minHistoryId, duplicates: [] }
  const codes = new Map();          // one-time authorisation code → { email, scopes, redirectUri?, codeChallenge? }
  const access = new Map();         // access token → { email, grant, expiresAt, revoked }
  const refresh = new Map();        // refresh token → { email, grant, revoked }
  const failures = new Map();       // op → [{ status, times }]
  const calls = [];                 // what the connector actually did (no token values)
  let tokenSeq = 0, grantSeq = 0;
  let down = false;
  let refreshScopes = null;       // Phase 2A test control: scopes a refresh reports (null = none stated)
  const gates = new Map();          // F2 test control: op → a promise the next call of op waits for
  async function waitGate(op) { const g = gates.get(op); if (g) { gates.delete(op); await g; } }

  const box = email => {
    if (!boxes.has(email)) boxes.set(email, { messages: new Map(), history: [], historyId: startHistoryId, minHistoryId: 0, duplicates: [], hidden: new Set() });
    return boxes.get(email);
  };
  const clone = v => structuredClone(v);
  const bump = b => String(++b.historyId);
  const record = (b, rec) => { const id = bump(b); b.history.push({ id, ...rec }); return id; };
  const brief = m => ({ id: m.id, threadId: m.threadId, labelIds: [...(m.labelIds ?? [])] });

  function maybeFail(op) {
    if (down) throw httpError(503);
    const q = failures.get(op);
    if (q?.length) {
      const f = q[0];
      if (--f.times <= 0) q.shift();
      throw httpError(f.status);
    }
  }
  function authorise(token, op) {
    calls.push({ op });
    const t = access.get(token);
    if (!t || t.revoked || t.expiresAt <= now()) throw httpError(401);
    maybeFail(op);
    calls[calls.length - 1].account = t.email;
    return box(t.email);
  }
  function issue(email, grant, scopes) {
    const n = ++tokenSeq;
    const at = `mock-gmail-access-${n}-SECRETVALUE`;
    const rt = `mock-gmail-refresh-${n}-SECRETVALUE`;
    access.set(at, { email, grant, expiresAt: now() + tokenTtlMs, revoked: false });
    refresh.set(rt, { email, grant, revoked: false });
    return { accessToken: at, refreshToken: rt, expiresAt: now() + tokenTtlMs, scopes: [...scopes] };
  }
  const listed = (b, includeSpamTrash) => {
    const all = [...b.messages.values()]
      .filter(m => includeSpamTrash || !(m.labelIds ?? []).some(l => l === 'TRASH' || l === 'SPAM'))
      .filter(m => !b.hidden.has(m.id))   // Gmail Phase 2 test control: a listing that skips a present message
      .sort((x, y) => Number(y.internalDate) - Number(x.internalDate) || (x.id < y.id ? 1 : -1))
      .map(m => ({ id: m.id, threadId: m.threadId }));
    return all;
  };
  const stripBodies = part => {
    if (!part || typeof part !== 'object') return part;
    const p = { ...part, body: part.body ? { size: part.body.size ?? 0, ...(part.body.attachmentId ? { attachmentId: part.body.attachmentId } : {}) } : undefined };
    if (Array.isArray(part.parts)) p.parts = part.parts.map(stripBodies);
    return p;
  };

  // ── the transport: READ methods only ──────────────────────────────────────
  const transport = Object.freeze({
    readOnly: true,
    testOnly: true,
    async exchangeCode({ code, redirectUri, codeVerifier } = {}) {
      calls.push({ op: 'exchangeCode', redirectUri: redirectUri ?? null, pkce: codeVerifier != null });
      await waitGate('exchangeCode');
      maybeFail('exchangeCode');
      const c = codes.get(code);
      if (!c) throw httpError(400);                 // invalid_grant
      codes.delete(code);                            // one-time (consumed even when the checks below fail, like Google)
      // Phase 2A — like Google: a code issued for a redirect URI / PKCE challenge
      // is redeemable only with that exact URI and the verifier that hashes to it.
      if (c.redirectUri != null && redirectUri !== c.redirectUri) throw httpError(400);   // redirect_uri_mismatch
      if (c.codeChallenge != null && (typeof codeVerifier !== 'string' || s256(codeVerifier) !== c.codeChallenge)) throw httpError(400);   // invalid_grant (PKCE)
      return issue(c.email, ++grantSeq, c.scopes);
    },
    async refreshAccessToken(refreshToken) {
      calls.push({ op: 'refresh' });
      maybeFail('refresh');
      const r = refresh.get(refreshToken);
      if (!r || r.revoked) throw httpError(400);
      const n = ++tokenSeq;
      const at = `mock-gmail-access-${n}-SECRETVALUE`;
      access.set(at, { email: r.email, grant: r.grant, expiresAt: now() + tokenTtlMs, revoked: false });
      return { accessToken: at, expiresAt: now() + tokenTtlMs, ...(refreshScopes ? { scopes: [...refreshScopes] } : {}) };
    },
    async revokeToken(token) {
      calls.push({ op: 'revoke' });
      await waitGate('revoke');
      maybeFail('revoke');
      const t = access.get(token) ?? refresh.get(token);
      if (!t) throw httpError(400);
      for (const m of [access, refresh]) for (const v of m.values()) if (v.grant === t.grant) v.revoked = true;   // Google revokes the whole grant
    },
    async getProfile(token) {
      const b = authorise(token, 'getProfile');
      const email = [...boxes.entries()].find(([, v]) => v === b)[0];
      return { emailAddress: email, messagesTotal: b.messages.size, threadsTotal: new Set([...b.messages.values()].map(m => m.threadId)).size, historyId: String(b.historyId) };
    },
    async listMessages(token, { pageToken, maxResults = 100, includeSpamTrash = false } = {}) {
      const b = authorise(token, 'listMessages');
      calls[calls.length - 1].pageToken = pageToken ?? null;
      // Keyset page tokens ("after this message"), so a message added or deleted
      // during a listing never makes the listing skip another one. Ids Gmail
      // repeats (duplicateInListing) follow as a final page.
      const size = Math.max(1, Math.min(500, Number(maxResults) || 100));
      const main = listed(b, includeSpamTrash);
      const dups = b.duplicates.filter(id => b.messages.has(id)).map(id => ({ id, threadId: b.messages.get(id).threadId }));
      const total = main.length + dups.length;
      if (pageToken === 'DUP') return { messages: dups, resultSizeEstimate: total };
      let start = 0;
      if (pageToken != null) {
        const m = /^K(\d{1,16})_([A-Za-z0-9]{1,40})$/.exec(String(pageToken));
        if (!m) throw httpError(400);
        const [kd, kid] = [Number(m[1]), m[2]];
        const after = x => { const d = Number(b.messages.get(x.id)?.internalDate ?? 0); return d < kd || (d === kd && x.id < kid); };
        start = main.findIndex(after);
        if (start < 0) start = main.length;
      }
      const page = main.slice(start, start + size);
      const last = page[page.length - 1];
      const next = start + size < main.length ? `K${b.messages.get(last.id).internalDate}_${last.id}` : (dups.length ? 'DUP' : undefined);
      return { ...(page.length ? { messages: page } : {}), ...(next ? { nextPageToken: next } : {}), resultSizeEstimate: total };
    },
    async getMessage(token, id, { format = 'full' } = {}) {
      const b = authorise(token, 'getMessage');
      Object.assign(calls[calls.length - 1], { id, format });
      const m = b.messages.get(id);
      if (!m) throw httpError(404);
      const out = clone(m);
      if (format === 'metadata' || format === 'minimal') out.payload = stripBodies(out.payload);
      return out;
    },
    async getThread(token, threadId, { format = 'metadata' } = {}) {
      const b = authorise(token, 'getThread');
      const msgs = [...b.messages.values()].filter(m => m.threadId === threadId).sort((x, y) => Number(x.internalDate) - Number(y.internalDate));
      if (!msgs.length) throw httpError(404);
      return { id: threadId, historyId: String(Math.max(...msgs.map(m => Number(m.historyId)))), messages: msgs.map(m => { const c = clone(m); if (format !== 'full') c.payload = stripBodies(c.payload); return c; }) };
    },
    async listHistory(token, { startHistoryId, pageToken } = {}) {
      const b = authorise(token, 'listHistory');
      Object.assign(calls[calls.length - 1], { startHistoryId, pageToken: pageToken ?? null });
      const start = Number(startHistoryId);
      if (!Number.isFinite(start) || start < b.minHistoryId) throw httpError(404);   // history no longer available
      const recs = b.history.filter(h => Number(h.id) > start);
      let from = 0;
      if (pageToken != null) { const m = /^H(\d{1,9})$/.exec(String(pageToken)); if (!m) throw httpError(400); from = Number(m[1]); }
      const page = recs.slice(from, from + historyPageSize);
      const next = from + historyPageSize < recs.length ? `H${from + historyPageSize}` : undefined;
      return { ...(page.length ? { history: clone(page) } : {}), ...(next ? { nextPageToken: next } : {}), historyId: String(b.historyId) };
    },
    async health() { return { ok: !down }; },
  });

  // ── test controls (the user acting in Gmail; never seen by the connector) ──
  return {
    transport, calls,
    /** A one-time authorisation code for `email` (what a consent screen would return). */
    authorizeCode(email, { code = `code-${email}-${++grantSeq}`, scopes = [DEFAULT_SCOPE], redirectUri = null, codeChallenge = null } = {}) { codes.set(code, { email, scopes, redirectUri, codeChallenge }); return code; },
    /** F2: the NEXT call of op ('exchangeCode' | 'revoke') waits until the returned release() is called. */
    gate(op) { let release; gates.set(op, new Promise(r => { release = r; })); return () => release(); },
    /** F2: every grant issued so far and whether it is revoked (no token values). */
    grants() { return [...refresh.values()].map(v => ({ grant: v.grant, email: v.email, revoked: v.revoked })); },
    /** Phase 2A: the scopes the next refreshes report (null = the response states none). */
    setRefreshScopes(scopes) { refreshScopes = scopes ? [...scopes] : null; },    /** Deliver a Gmail-format message (fixtures). Its historyId is assigned here. */
    addMessage(email, message) {
      const b = box(email);
      const m = clone(message);
      m.labelIds = [...(m.labelIds ?? [])];
      const id = record(b, { messages: [{ id: m.id, threadId: m.threadId }], messagesAdded: [{ message: brief(m) }] });
      m.historyId = id;
      b.messages.set(m.id, m);
    },
    relabel(email, id, { add = [], remove = [] } = {}) {
      const b = box(email);
      const m = b.messages.get(id);
      if (!m) throw new Error('no such message');
      const before = new Set(m.labelIds);
      for (const l of remove) before.delete(l);
      for (const l of add) before.add(l);
      m.labelIds = [...before];
      const rec = { messages: [{ id: m.id, threadId: m.threadId }] };
      if (add.length) rec.labelsAdded = [{ message: brief(m), labelIds: [...add] }];
      if (remove.length) rec.labelsRemoved = [{ message: brief(m), labelIds: [...remove] }];
      m.historyId = record(b, rec);
    },
    trash(email, id) { this.relabel(email, id, { add: ['TRASH'], remove: ['INBOX'] }); },
    untrash(email, id) { this.relabel(email, id, { add: ['INBOX'], remove: ['TRASH'] }); },
    /** Permanent deletion at the source. */
    deleteMessage(email, id) {
      const b = box(email);
      const m = b.messages.get(id);
      if (!m) return;
      b.messages.delete(id);
      record(b, { messages: [{ id: m.id, threadId: m.threadId }], messagesDeleted: [{ message: { id: m.id, threadId: m.threadId } }] });
    },
    /** Gmail keeps history for a limited time: drop everything up to now. */
    expireHistory(email) { const b = box(email); b.minHistoryId = b.historyId + 1; b.history = []; },
    /** Gmail Phase 2: the listing silently skips this (still present) message — pagination drift. */
    hideFromListing(email, id, hidden = true) { const b = box(email); if (hidden) b.hidden.add(id); else b.hidden.delete(id); },
    /** Make the listing repeat a message id on a later page. */
    duplicateInListing(email, id) { box(email).duplicates.push(id); },
    failNext(op, status, times = 1) { if (!failures.has(op)) failures.set(op, []); failures.get(op).push({ status, times }); },
    setDown(v) { down = v === true; },
    /** The user removes the app's access in their Google account. */
    revokeAllFor(email) { for (const m of [access, refresh]) for (const v of m.values()) if (v.email === email) v.revoked = true; },
    expireAccessTokens() { for (const v of access.values()) v.expiresAt = 0; },
    historyIdOf: email => String(box(email).historyId),
    messageIds: email => [...box(email).messages.keys()],
    grantRevoked: token => Boolean((access.get(token) ?? refresh.get(token))?.revoked),
  };
}
