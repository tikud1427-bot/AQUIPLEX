/**
 * AQUA Connect — Gmail API structures → one plain-text document (Gmail Phase 1)
 *
 * Pure and deterministic: no clock, no network, no provider. Input is a Gmail
 * API `users.messages.get` response (format=full or format=metadata); output
 * is the text the external-source lifecycle stores — as a UKO of class
 * external:gmail, invisible to every normal reader (files/ukoStore.js) and
 * never derived into memory, vectors, search, facts or claims
 * (files/fileEngine.js, G1-2).
 *
 * Everything here is UNTRUSTED input: header values are stripped of control
 * characters and line breaks (no header injection into the document), bodies
 * are decoded defensively and bounded, HTML is reduced to text (scripts and
 * styles dropped, never executed or rendered).
 *
 * Attachments: METADATA only (file name, MIME type, size, part and attachment
 * ids). Phase 1 never fetches attachment bytes.
 */

export const GMAIL_LIMITS = Object.freeze({
  maxBodyChars: 200_000,     // a larger body is truncated (and says so)
  maxHeaderChars: 2_000,     // per header value
  maxAttachments: 100,       // listed per message
  maxPartsWalked: 500,       // MIME parts visited per message
});

/**
 * Labels whose messages are outside the synced scope (treated as removed).
 * Gmail Phase 2: DRAFT added — unsent drafts are the user's unfinished writing,
 * change identity on every edit, and are not needed as context (data minimisation).
 * A draft that is SENT becomes a new message without DRAFT and is then in scope.
 */
export const EXCLUDED_LABELS = Object.freeze(['TRASH', 'SPAM', 'DRAFT']);
export const isExcluded = labelIds => Array.isArray(labelIds) && labelIds.some(l => EXCLUDED_LABELS.includes(l));

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** One header value made safe for a single document line. */
export function cleanHeader(value, max = GMAIL_LIMITS.maxHeaderChars) {
  if (value == null) return '';
  return decodeEncodedWords(String(value)).replace(/[\r\n\t]+/g, ' ').replace(CONTROL, '').replace(/\s{2,}/g, ' ').trim().slice(0, max);
}

/** Case-insensitive header lookup over a Gmail `payload.headers` array (first match). */
export function header(headers, name) {
  if (!Array.isArray(headers)) return null;
  const n = name.toLowerCase();
  const h = headers.find(x => typeof x?.name === 'string' && x.name.toLowerCase() === n);
  return h && typeof h.value === 'string' ? h.value : null;
}

// ── RFC 2047 encoded words (=?UTF-8?B?…?= / =?ISO-8859-1?Q?…?=) ─────────────
function decodeEncodedWords(s) {
  return s.replace(/=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g, (whole, charset, enc, text) => {
    try {
      const bytes = enc.toUpperCase() === 'B'
        ? Buffer.from(text, 'base64')
        : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      return decodeBytes(bytes, charset);
    } catch { return whole; }
  }).replace(/\?=\s+=\?/g, '?==?');
}

function decodeBytes(bytes, charset) {
  const cs = String(charset ?? 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  const label = ['latin1', 'iso-8859-1', 'us-ascii', 'ascii', 'windows-1252', 'cp1252'].includes(cs) ? 'latin1' : 'utf-8';
  try { return new TextDecoder(label, { fatal: false }).decode(bytes); }
  catch { return bytes.toString('utf8'); }
}

/** Gmail body data is base64url. Anything undecodable → ''. */
export function decodeBody(data, charset) {
  if (typeof data !== 'string' || !data) return '';
  try { return decodeBytes(Buffer.from(data, 'base64url'), charset); } catch { return ''; }
}

const charsetOf = part => {
  const ct = header(part?.headers, 'Content-Type') ?? '';
  const m = /charset\s*=\s*"?([^";\s]+)"?/i.exec(ct);
  return m ? m[1] : 'utf-8';
};

// ── HTML → text (no rendering, no scripts, no remote content) ───────────────
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
  eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', aacute: 'á', acirc: 'â', ccedil: 'ç', iacute: 'í', oacute: 'ó', uacute: 'ú',
  auml: 'ä', ouml: 'ö', uuml: 'ü', szlig: 'ß', ntilde: 'ñ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', middot: '·', bull: '•',
};
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<(script|style|head|title|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|table|section|article)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (whole, e) => {
      const k = e.toLowerCase();
      if (k in ENTITIES) return ENTITIES[k];
      const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : k.startsWith('#') ? parseInt(k.slice(1), 10) : NaN;
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── MIME walk ───────────────────────────────────────────────────────────────
/**
 * The body text and attachment metadata of one Gmail payload.
 * Body choice: the first text/plain part; else the first text/html part
 * (converted); a part with a file name (or an attachmentId) is an attachment,
 * never a body.
 */
export function walkPayload(payload) {
  const plain = [], html = [], attachments = [];
  let visited = 0;
  const visit = part => {
    if (!part || typeof part !== 'object' || ++visited > GMAIL_LIMITS.maxPartsWalked) return;
    const mime = String(part.mimeType ?? '').toLowerCase();
    const filename = cleanHeader(part.filename ?? '', 255);
    const body = part.body ?? {};
    const isAttachment = Boolean(filename) || (typeof body.attachmentId === 'string' && body.attachmentId);
    if (isAttachment) {
      if (attachments.length < GMAIL_LIMITS.maxAttachments) {
        attachments.push({
          filename: filename || null,
          mimeType: cleanHeader(mime, 100) || null,
          size: Number.isFinite(body.size) && body.size >= 0 ? body.size : null,
          partId: typeof part.partId === 'string' ? part.partId.slice(0, 50) : null,
          attachmentId: typeof body.attachmentId === 'string' ? body.attachmentId.slice(0, 200) : null,
          inline: /inline/i.test(header(part.headers, 'Content-Disposition') ?? ''),
        });
      }
    } else if (mime === 'text/plain') {
      plain.push(decodeBody(body.data, charsetOf(part)));
    } else if (mime === 'text/html') {
      html.push(decodeBody(body.data, charsetOf(part)));
    }
    if (Array.isArray(part.parts)) for (const p of part.parts) visit(p);
  };
  visit(payload);
  const plainText = plain.filter(Boolean).join('\n\n');
  const htmlText = html.filter(Boolean).map(htmlToText).join('\n\n');
  const format = plainText ? 'text/plain' : htmlText ? 'text/html' : null;
  return { body: plainText || htmlText, format, attachments, partsTruncated: visited > GMAIL_LIMITS.maxPartsWalked };
}

// ── Relationships ───────────────────────────────────────────────────────────
const MSGID_RE = /<[^<>\s]{1,500}>/g;
const idList = v => (cleanHeader(v ?? '', 20_000).match(MSGID_RE) ?? []).slice(0, 50);

/** reply | forward | original, from headers first, then the subject prefix and body marker. */
export function messageKind({ subject, inReplyTo, body }) {
  const s = String(subject ?? '').trim();
  if (/^(fwd?|fw)\s*:/i.test(s) || /-{5,}\s*Forwarded message\s*-{5,}/i.test(String(body ?? '').slice(0, 50_000))) return 'forward';
  if (inReplyTo || /^re\s*:/i.test(s)) return 'reply';
  return 'original';
}

/** A Gmail `internalDate` (ms epoch string) or a Date header → ISO-8601 UTC, else null. */
export function isoTime(internalDate, dateHeader) {
  const ms = Number(internalDate);
  if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  const t = Date.parse(String(dateHeader ?? ''));
  return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null;
}

/** The RFC 5322 Date header's UTC offset ("+05:30"), when it states one. */
export function zoneOf(dateHeader) {
  const m = /([+-])(\d{2})(\d{2})\s*(\([^)]*\))?\s*$/.exec(String(dateHeader ?? '').trim());
  if (m) return `${m[1]}${m[2]}:${m[3]}`;
  return /\b(GMT|UTC|Z)\s*$/i.test(String(dateHeader ?? '').trim()) ? '+00:00' : null;
}

// ── The structured message and its document ─────────────────────────────────
/**
 * Gmail message → a structured, sanitised record (no body for format=metadata).
 * Ids are kept exactly (they are the provenance), within bounds.
 */
export function parseGmailMessage(msg, { includeBody = true } = {}) {
  if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string' || !msg.id) throw new Error('not a Gmail message');
  const p = msg.payload ?? {};
  const headers = Array.isArray(p.headers) ? p.headers : [];
  const subject = cleanHeader(header(headers, 'Subject'));
  const dateHeader = cleanHeader(header(headers, 'Date'), 200);
  const inReplyTo = idList(header(headers, 'In-Reply-To'))[0] ?? null;
  const walked = walkPayload(p);   // format=metadata carries no body data: the body is simply empty
  // The snippet is never substituted for a missing body (it is not the message).
  let body = includeBody ? walked.body : '';
  const truncated = body.length > GMAIL_LIMITS.maxBodyChars;
  if (truncated) body = body.slice(0, GMAIL_LIMITS.maxBodyChars);
  return {
    gmailId: msg.id.slice(0, 200),
    threadId: typeof msg.threadId === 'string' ? msg.threadId.slice(0, 200) : null,
    historyId: msg.historyId != null ? String(msg.historyId).slice(0, 40) : null,
    labelIds: Array.isArray(msg.labelIds) ? msg.labelIds.filter(l => typeof l === 'string').map(l => cleanHeader(l, 100)).sort() : [],
    internalDate: isoTime(msg.internalDate, null),
    date: isoTime(msg.internalDate, dateHeader),
    dateHeader: dateHeader || null,
    zone: zoneOf(dateHeader),
    rfcMessageId: idList(header(headers, 'Message-ID') ?? header(headers, 'Message-Id'))[0] ?? null,
    inReplyTo,
    references: idList(header(headers, 'References')),
    from: cleanHeader(header(headers, 'From')) || null,
    to: cleanHeader(header(headers, 'To')) || null,
    cc: cleanHeader(header(headers, 'Cc')) || null,
    replyTo: cleanHeader(header(headers, 'Reply-To')) || null,
    subject: subject || null,
    kind: messageKind({ subject, inReplyTo, body }),
    attachments: walked.attachments,
    body: includeBody ? body : null,
    bodyFormat: includeBody ? walked.format : null,
    bodyTruncated: truncated,
    sizeEstimate: Number.isFinite(msg.sizeEstimate) ? msg.sizeEstimate : null,
  };
}

/** The document text stored for one message. Field order is fixed (deterministic bytes → stable identity). */
export function renderGmailDocument(m) {
  const line = (k, v) => (v == null || v === '' ? null : `${k}: ${v}`);
  const att = m.attachments.map(a => `  - ${a.filename ?? '(unnamed)'} · ${a.mimeType ?? 'unknown type'} · ${a.size ?? '?'} bytes${a.inline ? ' · inline' : ''}`);
  return [
    'Email message (Gmail)',
    line('Gmail-Message-Id', m.gmailId),
    line('Gmail-Thread-Id', m.threadId),
    line('Message-Id', m.rfcMessageId),
    line('In-Reply-To', m.inReplyTo),
    line('References', m.references.length ? m.references.join(' ') : null),
    line('Kind', m.kind),
    line('Date', m.date ? `${m.date}${m.zone ? ` (sent at UTC${m.zone})` : ''}` : 'unknown'),
    line('From', m.from),
    line('To', m.to),
    line('Cc', m.cc),
    line('Reply-To', m.replyTo),
    line('Subject', m.subject ?? '(no subject)'),
    line('Labels', m.labelIds.length ? m.labelIds.join(', ') : null),
    m.attachments.length ? `Attachments (${m.attachments.length}, metadata only):\n${att.join('\n')}` : null,
    line('Body-Format', m.bodyFormat ?? 'none'),
    m.bodyTruncated ? `Body-Truncated: yes (first ${GMAIL_LIMITS.maxBodyChars} characters kept)` : null,
    '',
    m.body || '(no body)',
  ].filter(x => x !== null).join('\n');
}

/**
 * Thread relationships for a set of parsed messages: each message's parent
 * (the message its In-Reply-To names, when present in the set), in date order.
 */
export function threadRelations(parsed) {
  const byRfc = new Map(parsed.filter(m => m.rfcMessageId).map(m => [m.rfcMessageId, m.gmailId]));
  return [...parsed]
    .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || a.gmailId.localeCompare(b.gmailId))
    .map(m => ({
      gmailId: m.gmailId, threadId: m.threadId, rfcMessageId: m.rfcMessageId, kind: m.kind, date: m.date,
      parent: (m.inReplyTo && byRfc.get(m.inReplyTo)) || null,
      references: m.references.map(r => byRfc.get(r)).filter(Boolean),
    }));
}

export const resourceIdOf = gmailId => `msg:${gmailId}`;
export const gmailIdOf = externalId => (typeof externalId === 'string' && externalId.startsWith('msg:') ? externalId.slice(4) : null);
/** File name of a stored message: carries no content (subjects never reach names or logs). */
export const resourceNameOf = gmailId => `gmail-${String(gmailId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120)}.txt`;
