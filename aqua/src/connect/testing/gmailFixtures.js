/**
 * AQUA Connect — deterministic Gmail fixtures (Gmail Phase 1, test-only)
 *
 * A small mailbox in Gmail API message format (users.messages.get, format=full)
 * covering: several senders/recipients and threads, different dates and time
 * zones, plain-text, HTML and multipart/alternative bodies, attachments and
 * their metadata, replies and a forward, a duplicate delivery (same
 * Message-ID, different Gmail id), a message missing optional fields, a large
 * body, RFC 2047 encoded headers and a Latin-1 body, and SPAM/TRASH messages
 * outside the synced scope.
 *
 * Every message carries a unique CANARY token in its body (and some in their
 * subjects), so a test can prove where Gmail content does — and does not —
 * appear. All addresses use the reserved example.test domain.
 */
export const FIXTURE_ACCOUNT = 'alex.rivera@example.test';
export const OTHER_ACCOUNT = 'jordan.blake@example.test';

const b64 = s => Buffer.from(s, 'utf8').toString('base64url');
const b64latin1 = s => Buffer.from(s, 'latin1').toString('base64url');

/**
 * Build a Gmail API message from a compact spec.
 * @param {object} s  { id, threadId, date?, internalDate?, labels?, headers: {…}, text?, html?, attachments?: [{ filename, mimeType, size, inline? }], latin1? }
 */
export function buildMessage(s) {
  const headers = Object.entries({ ...(s.date ? { Date: s.date } : {}), ...s.headers })
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([name, value]) => ({ name, value }));
  let n = 0;
  const leaf = (mime, content, latin1 = false) => ({
    partId: '', mimeType: mime, filename: '',
    headers: [{ name: 'Content-Type', value: `${mime}; charset="${latin1 ? 'ISO-8859-1' : 'UTF-8'}"` }],
    body: { size: Buffer.byteLength(content, latin1 ? 'latin1' : 'utf8'), data: latin1 ? b64latin1(content) : b64(content) },
  });
  let body;
  if (s.text != null && s.html != null) body = { partId: '', mimeType: 'multipart/alternative', filename: '', headers: [], body: { size: 0 }, parts: [leaf('text/plain', s.text, s.latin1), leaf('text/html', s.html)] };
  else if (s.html != null) body = leaf('text/html', s.html);
  else if (s.text != null) body = leaf('text/plain', s.text, s.latin1);
  else body = { partId: '', mimeType: 'text/plain', filename: '', headers: [], body: { size: 0 } };
  let payload = body;
  if (s.attachments?.length) {
    payload = {
      partId: '', mimeType: 'multipart/mixed', filename: '', headers: [], body: { size: 0 },
      parts: [body, ...s.attachments.map((a, i) => ({
        partId: '', mimeType: a.mimeType, filename: a.filename,
        headers: [{ name: 'Content-Disposition', value: `${a.inline ? 'inline' : 'attachment'}; filename="${a.filename}"` }],
        body: { size: a.size, attachmentId: `ATT-${s.id}-${i + 1}` },
      }))],
    };
  }
  const number = p => { p.partId = String(n++); for (const c of p.parts ?? []) number(c); };
  number(payload);
  payload.headers = [...headers, ...(payload.headers ?? [])];
  const internalDate = s.internalDate ?? Date.parse(s.date);
  return {
    id: s.id, threadId: s.threadId, labelIds: s.labels === undefined ? ['INBOX'] : s.labels,
    snippet: String(s.text ?? s.html ?? '').replace(/<[^>]*>/g, '').slice(0, 100),
    historyId: '0', internalDate: String(internalDate),
    sizeEstimate: JSON.stringify(payload).length,
    payload,
  };
}

const LARGE = `CANARY_M08_HEAD quarterly export follows.\n` + 'row,value,notes\n'.repeat(1) +
  Array.from({ length: 12_000 }, (_, i) => `${i},${(i * 7) % 1000},routine line ${i}`).join('\n') + `\nCANARY_M08_TAIL end of export.`;

/** The fixture messages, in delivery order. */
export function fixtureMessages() {
  return [
    buildMessage({ id: '18c0000000000001', threadId: 'thr-budget', date: 'Mon, 5 Jan 2026 09:15:00 +0530',
      headers: { From: 'Priya Sharma <priya@acme.example.test>', To: 'Alex Rivera <alex.rivera@example.test>, Sam Okafor <sam@acme.example.test>', Cc: 'finance@acme.example.test',
        Subject: 'Q1 budget for CANARY_S01 project', 'Message-ID': '<budget-1@acme.example.test>' },
      text: 'Hi Alex,\n\nThe CANARY_M01 budget is 42,000 USD for Q1. Please confirm by Friday.\n\nPriya' }),
    buildMessage({ id: '18c0000000000002', threadId: 'thr-budget', date: 'Sun, 4 Jan 2026 21:30:00 -0800',
      headers: { From: 'Alex Rivera <alex.rivera@example.test>', To: 'Priya Sharma <priya@acme.example.test>', Subject: 'Re: Q1 budget for CANARY_S01 project',
        'Message-ID': '<budget-2@example.test>', 'In-Reply-To': '<budget-1@acme.example.test>', References: '<budget-1@acme.example.test>' },
      labels: ['SENT'],
      text: 'Confirmed: CANARY_M02 budget approved.\n\nOn Mon, Priya wrote:\n> The budget is 42,000 USD',
      html: '<div>Confirmed: <b>CANARY_M02</b> budget approved.</div><blockquote>The budget is 42,000 USD</blockquote>' }),
    buildMessage({ id: '18c0000000000003', threadId: 'thr-budget', date: 'Mon, 5 Jan 2026 07:02:00 +0000',
      headers: { From: 'Sam Okafor <sam@acme.example.test>', To: 'Priya Sharma <priya@acme.example.test>, Alex Rivera <alex.rivera@example.test>', Cc: 'Lee Chen <lee@partner.example.test>, finance@acme.example.test',
        Subject: 'RE: Q1 budget for CANARY_S01 project', 'Message-ID': '<budget-3@acme.example.test>', 'In-Reply-To': '<budget-2@example.test>', References: '<budget-1@acme.example.test> <budget-2@example.test>' },
      text: 'Adding Lee. CANARY_M03 numbers look right to me.' }),
    buildMessage({ id: '18c0000000000004', threadId: 'thr-newsletter', date: 'Tue, 6 Jan 2026 14:00:00 GMT',
      headers: { From: '"Product News" <news@vendor.example.test>', To: 'alex.rivera@example.test', Subject: 'Your weekly digest', 'Message-ID': '<digest-77@vendor.example.test>' },
      html: '<html><head><style>p{color:red}</style><title>t</title></head><body><script>alert("x")</script><p>Release CANARY_M04 &amp; notes &lt;beta&gt;</p><ul><li>Item one</li><li>Caf&eacute; &#233; &#x2713;</li></ul><img src="https://tracker.example.test/p.gif"></body></html>' }),
    buildMessage({ id: '18c0000000000005', threadId: 'thr-contract', date: 'Wed, 7 Jan 2026 10:45:00 -0330',
      headers: { From: 'Alex Rivera <alex.rivera@example.test>', To: 'Jordan Blake <jordan.blake@example.test>', Subject: 'Fwd: signed contract', 'Message-ID': '<fwd-1@example.test>' },
      labels: ['SENT', 'IMPORTANT'],
      text: 'FYI see below.\n\n---------- Forwarded message ---------\nFrom: Legal <legal@acme.example.test>\nDate: Tue, 6 Jan 2026\nSubject: signed contract\n\nCANARY_M05 contract is countersigned.',
      attachments: [{ filename: 'contract-signed.pdf', mimeType: 'application/pdf', size: 248_331 }] }),
    buildMessage({ id: '18c0000000000006', threadId: 'thr-photos', date: 'Thu, 8 Jan 2026 18:20:00 +0900',
      headers: { From: 'Mina Sato <mina@photos.example.test>', To: 'alex.rivera@example.test', Subject: 'Site photos and sheet', 'Message-ID': '<photos-1@photos.example.test>' },
      text: 'Photos from the CANARY_M06 site visit attached.',
      attachments: [
        { filename: 'site-1.jpg', mimeType: 'image/jpeg', size: 1_843_200 },
        { filename: 'logo.png', mimeType: 'image/png', size: 5_120, inline: true },
        { filename: 'measurements.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 33_410 },
      ] }),
    // Missing optional fields: no Subject, no To (Bcc delivery), no Date header, no Message-ID, no labels.
    buildMessage({ id: '18c0000000000007', threadId: 'thr-bcc', internalDate: 1_767_960_000_000, labels: [],
      headers: { From: 'noreply@alerts.example.test' },
      text: 'CANARY_M07 automated notice without a subject.' }),
    buildMessage({ id: '18c0000000000008', threadId: 'thr-export', date: 'Fri, 9 Jan 2026 23:59:59 +0545',
      headers: { From: 'Exports <exports@data.example.test>', To: 'alex.rivera@example.test', Subject: 'Large export', 'Message-ID': '<export-1@data.example.test>' },
      text: LARGE }),
    // Duplicate delivery of message 1 (same RFC Message-ID, different Gmail id, different thread).
    buildMessage({ id: '18c0000000000009', threadId: 'thr-budget-dup', date: 'Mon, 5 Jan 2026 09:15:00 +0530',
      headers: { From: 'Priya Sharma <priya@acme.example.test>', To: 'Alex Rivera <alex.rivera@example.test>, Sam Okafor <sam@acme.example.test>', Cc: 'finance@acme.example.test',
        Subject: 'Q1 budget for CANARY_S01 project', 'Message-ID': '<budget-1@acme.example.test>' },
      text: 'Hi Alex,\n\nThe CANARY_M01 budget is 42,000 USD for Q1. Please confirm by Friday.\n\nPriya' }),
    // RFC 2047 subject and a Latin-1 body.
    buildMessage({ id: '18c000000000000a', threadId: 'thr-intl', date: 'Sat, 10 Jan 2026 08:00:00 +0100',
      headers: { From: '=?UTF-8?B?w4lsb2RpZSBNYXJ0aW4=?= <elodie@example.test>', To: 'alex.rivera@example.test', Subject: '=?UTF-8?Q?R=C3=A9union_CANARY=5FS10?=', 'Message-ID': '<intl-1@example.test>' },
      latin1: true, text: 'Réunion confirmée à 9h. CANARY_M10 café.' }),
    buildMessage({ id: '18c000000000000b', threadId: 'thr-spam', date: 'Sat, 10 Jan 2026 09:00:00 +0000', labels: ['SPAM'],
      headers: { From: 'winner@spam.example.test', To: 'alex.rivera@example.test', Subject: 'You won', 'Message-ID': '<spam@spam.example.test>' },
      text: 'CANARY_M11 spam body.' }),
    buildMessage({ id: '18c000000000000c', threadId: 'thr-old', date: 'Thu, 1 Jan 2026 12:00:00 +0000', labels: ['TRASH'],
      headers: { From: 'old@example.test', To: 'alex.rivera@example.test', Subject: 'Old note', 'Message-ID': '<old@example.test>' },
      text: 'CANARY_M12 trashed body.' }),
  ];
}

/** Ids inside the synced scope (not SPAM/TRASH). */
export const IN_SCOPE_IDS = Object.freeze(['18c0000000000001', '18c0000000000002', '18c0000000000003', '18c0000000000004', '18c0000000000005', '18c0000000000006', '18c0000000000007', '18c0000000000008', '18c0000000000009', '18c000000000000a']);
export const OUT_OF_SCOPE_IDS = Object.freeze(['18c000000000000b', '18c000000000000c']);

/** Every canary token the fixtures contain (bodies and subjects). */
export const CANARIES = Object.freeze([
  'CANARY_M01', 'CANARY_M02', 'CANARY_M03', 'CANARY_M04', 'CANARY_M05', 'CANARY_M06', 'CANARY_M07',
  'CANARY_M08_HEAD', 'CANARY_M08_TAIL', 'CANARY_M10', 'CANARY_M11', 'CANARY_M12', 'CANARY_S01', 'CANARY_S10',
]);

/** Load the fixture mailbox into a mock service. */
export function loadFixtureMailbox(svc, email = FIXTURE_ACCOUNT) {
  for (const m of fixtureMessages()) svc.addMessage(email, m);
}

/** A small mailbox for another account (owner-isolation tests). */
export function otherMailbox(svc, email = OTHER_ACCOUNT) {
  svc.addMessage(email, buildMessage({ id: '19d0000000000001', threadId: 'thr-o1', date: 'Mon, 5 Jan 2026 10:00:00 +0000',
    headers: { From: 'casey@other.example.test', To: email, Subject: 'Hello', 'Message-ID': '<o1@other.example.test>' }, text: 'CANARY_OTHER1 hello.' }));
  svc.addMessage(email, buildMessage({ id: '19d0000000000002', threadId: 'thr-o1', date: 'Mon, 5 Jan 2026 11:00:00 +0000',
    headers: { From: email, To: 'casey@other.example.test', Subject: 'Re: Hello', 'Message-ID': '<o2@other.example.test>', 'In-Reply-To': '<o1@other.example.test>' }, text: 'CANARY_OTHER2 reply.' }));
}
