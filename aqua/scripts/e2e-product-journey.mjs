// End-to-end drive of the REAL product (server + worker from start-production.mjs):
// signup → session → chat (facts + a correction) → file upload → NEW conversation
// questions → role change → another NEW conversation. Prints answers + DB state,
// the verification verdict and memory read mode of every answer, and an
// automatic PASS/FAIL per user journey (P0 2026-10-12).
//
//   E2E_PHASE=full (default)     the whole journey; saves the session to E2E_STATE
//   E2E_PHASE=after-restart      reload that session after the launcher was
//                                restarted and ask in a NEW conversation
import { execSync, execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:5055';
const EMAIL = `e2e-${Date.now().toString(36)}@example.test`;
const PASSWORD = 'e2e-password-123';
const DB = process.env.E2E_DB ?? 'aqua_e2e';
const PHASE = process.env.E2E_PHASE ?? 'full';
const STATE = process.env.E2E_STATE ?? 'e2e-product.state.json';
const jar = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = [];
const out = (...a) => { const s = a.join(' '); console.log(s); log.push(s); };
const checks = [];
/** An automatic check on a real answer. Recorded, never thrown: every journey runs. */
const check = (name, ok) => { checks.push({ name, ok }); out(`  CHECK ${ok ? 'PASS' : 'FAIL'} — ${name}`); };
// Models answer with typographic apostrophes ("don’t") as often as straight ones.
const UNKNOWN_RE = /(don['’]t|do not|not|no|n['’]t) (know|have|record|see|find|mention|been told|stored)|haven['’]t (told|mentioned|shared)|unknown|not sure|no record|not in (my|your)/i;
const INVENTED_NAME_RE = /\b(?:named|name is|called)\s+[A-Z][a-z]+/;

function storeCookies(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    jar.set(kv.slice(0, i).trim(), kv.slice(i + 1));
  }
}
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
async function req(method, path, { body = null, form = null, headers = {} } = {}) {
  const h = { 'X-Forwarded-Proto': 'https', Cookie: cookieHeader(), ...headers };
  let payload;
  if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
  else if (body) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect: 'manual' });
  storeCookies(res);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json, location: res.headers.get('location') };
}
const psql = sql => execSync(`docker exec aqua-test-db psql -U aqua -d ${DB} -At -c "${sql.replace(/"/g, '\\"')}"`).toString().trim();

const answerOf = j => {
  const d = j?.data ?? j ?? {};
  return d.reply ?? d.answer ?? d.response ?? d.message ?? d.content ?? d.text ?? JSON.stringify(Object.keys(d));
};
/** What served this answer: the verification verdict and the memory read mode. */
const meta = raw => {
  const d = raw?.data ?? raw ?? {};
  const v = d.verification ?? {};
  return `[verification=${v.status ?? '?'} verified=${v.verified ?? '?'}${v.error ? ` error=${String(v.error).slice(0, 80)}` : ''}`
    + ` | memory read=${d.memory?.readMode ?? '?'}${d.memory?.degraded ? ' DEGRADED' : ''} injected=${d.memory?.injected ?? '?'}`
    + ` | wmClaims=${d.worldModel?.claims?.length ?? 0}]`;
};
async function chat(message, conversationId = null) {
  for (let i = 0; i < 3; i++) {
    const r = await req('POST', '/api/aqua/chat', { body: { message, ...(conversationId ? { conversationId } : {}) } });
    if (r.status === 200) {
      const d = r.json?.data ?? r.json ?? {};
      return { answer: String(answerOf(r.json)), conversationId: d.conversationId ?? r.json?.conversationId ?? conversationId, raw: r.json };
    }
    out(`  chat HTTP ${r.status}: ${r.text.slice(0, 300)}`);
    await sleep(5000);
  }
  throw new Error('chat failed');
}
async function ask(q, name, ok, conversationId = null) {
  const r = await chat(q, conversationId);
  out(`USER: ${q}\nAQUA: ${r.answer.slice(0, 500).replace(/\n/g, ' ')}\n  ${meta(r.raw)}`);
  if (name) check(name, ok(r.answer));
  return r;
}
async function waitForWorker(ownerId, label) {
  for (let i = 0; i < 120; i++) {
    const pending = Number(psql(`SELECT count(*) FROM aqua_jobs WHERE owner_id='${ownerId}' AND state IN ('queued','running') AND run_after <= now()`));
    const outbox = Number(psql(`SELECT count(*) FROM aqua_outbox WHERE owner_id='${ownerId}' AND state IN ('pending','processing')`));
    if (!pending && !outbox) { out(`  [worker idle after ${label}: ${i * 5}s]`); return; }
    await sleep(5000);
  }
  out(`  [worker still busy after ${label} — continuing]`);
}
const summary = file => {
  out(`\nSUMMARY ${checks.filter(c => c.ok).length}/${checks.length} checks passed`);
  writeFileSync(file, log.join('\n'));
};

// ── after a launcher restart: same session, NEW conversation ──
if (PHASE === 'after-restart') {
  const st = JSON.parse(readFileSync(STATE, 'utf8'));
  for (const [k, v] of st.jar) jar.set(k, v);
  const OWNER = st.owner;
  out(`=== after restart — owner ${OWNER}, NEW conversation ===`);
  out(`claims in canonical store for owner: ${psql(`SELECT count(*) FROM aqua_claims WHERE owner_id='${OWNER}'`)}`);
  await ask('Who is my biggest client right now, and when is the mug launch?',
    'current client (Juniper) and corrected launch date (17) survive a restart',
    a => /juniper/i.test(a) && /17/.test(a));
  await ask('What is the wholesale price per mug, and who is my studio assistant?',
    'document fact (16) and conversation fact (Tom) survive a restart',
    a => /16/.test(a) && /tom/i.test(a));
  await ask("What's my dentist's name?", 'unknown stays unknown after a restart',
    a => UNKNOWN_RE.test(a) && !INVENTED_NAME_RE.test(a));
  summary(process.env.E2E_OUT ?? 'e2e-product.restart.log');
  process.exit(0);
}

// ── 1. signup ──
const page = await req('GET', '/signup');
const csrf = page.text.match(/name="_csrf"\s+value="([^"]+)"/)?.[1] ?? page.text.match(/value="([^"]+)"\s+name="_csrf"/)?.[1];
out(`signup page HTTP ${page.status}, csrf ${csrf ? 'found' : 'MISSING'}`);
const su = await req('POST', '/signup', { form: { email: EMAIL, password: PASSWORD, _csrf: csrf ?? '' } });
out(`signup HTTP ${su.status} → ${su.location}`);
execFileSync('docker', ['exec','aqua-test-mongo','mongosh','--quiet','aqua_validation','--eval', "db.users.updateOne({email:'"+EMAIL+"'},{'$set':{'wallet.freeCredits':5000,'wallet.paidCredits':5000}})"]);
const userId = execFileSync('docker', ['exec','aqua-test-mongo','mongosh','--quiet','aqua_validation','--eval', "print(db.users.findOne({email:'"+EMAIL+"'})._id.toString())"]).toString().trim();
const OWNER = `user:${userId}`;
out(`owner ${OWNER}`);

// ── 2. conversation 1: facts, a correction ──
const facts = [
  "Hi! I'm Lena and I run a small ceramics studio called Kiln & Co in Leeds.",
  'My biggest client is a restaurant called Fennel.',
  'My studio assistant is Tom Reyes.',
  "We're launching a new mug line on March 3.",
  'The mug launch is blocked because our glaze supplier is late.',
  'Actually, the mug launch moved to March 17.',
  'I prefer short bullet-point answers.',
];
let conv1 = null;
out('\n=== conversation 1 ===');
for (const f of facts) {
  const r = await chat(f, conv1);
  conv1 = r.conversationId ?? conv1;
  out(`USER: ${f}\nAQUA: ${r.answer.slice(0, 220).replace(/\n/g, ' ')}\n  ${meta(r.raw)}`);
}

// ── 3. upload a document into conversation 1 ──
const doc = 'Mug line pricing\nRetail price: 28 pounds per mug.\nWholesale price for Fennel: 16 pounds per mug.\nFirst batch: 400 mugs.';
const up = await req('POST', '/api/aqua/upload', { body: { conversationId: conv1, files: [{ name: 'mug_pricing.txt', content: Buffer.from(doc).toString('base64') }] } });
out(`\nupload HTTP ${up.status} results=${JSON.stringify((up.json?.data ?? up.json)?.results?.map(r => [r.name, r.status]))}`);
await waitForWorker(OWNER, 'conversation 1 + upload');

out('\n--- World Model state ---');
out(psql(`SELECT state||' | '||predicate||' | '||left(statement_text,70) FROM aqua_claims WHERE owner_id='${OWNER}' ORDER BY asserted_at`));
out(psql(`SELECT 'sources by kind: '||string_agg(kind||'='||n, ', ') FROM (SELECT kind, count(*) n FROM aqua_sources WHERE owner_id='${OWNER}' GROUP BY kind) x`));
out(psql(`SELECT 'jobs: '||string_agg(kind||':'||state||'='||n, ', ') FROM (SELECT kind, state, count(*) n FROM aqua_jobs WHERE owner_id='${OWNER}' GROUP BY kind, state) x`));

// ── 4. NEW conversation: recall, correction, document × conversation, unknown ──
out('\n=== conversation 2 (new) ===');
await ask("When is the mug launch, and what's holding it up?",
  'corrected fact used (17, not March 3) + blocker, in a new conversation',
  a => /17/.test(a) && /glaze|supplier/i.test(a) && !/launch(?:es|ing)?(?: is)? on march 3\b/i.test(a));
await ask('How much does my biggest client pay per mug?',
  'uploaded document combined with conversation (Fennel wholesale 16)',
  a => /16/.test(a));
await ask('Draft a short note to my studio assistant about the launch plan.',
  'existing personal information recalled (Tom)',
  a => /tom/i.test(a));
await ask("What's my accountant's name?",
  'unknown fact stated as unknown, nothing invented',
  a => UNKNOWN_RE.test(a) && !INVENTED_NAME_RE.test(a));

// ── 5. role change in conversation 1, then a NEW conversation ──
out('\n=== conversation 1: role change ===');
const ch = await chat('My biggest client is now Juniper Hotel; Fennel stopped ordering.', conv1);
out(`AQUA: ${ch.answer.slice(0, 200).replace(/\n/g, ' ')}\n  ${meta(ch.raw)}`);
await waitForWorker(OWNER, 'role change');
out(psql(`SELECT state||' | '||left(statement_text,70) FROM aqua_claims WHERE owner_id='${OWNER}' AND predicate='related_to' ORDER BY asserted_at`));
out('\n=== conversation 3 (new) ===');
await ask('Who is my biggest client right now?',
  'canonical World Model serves the change in a new conversation (Juniper)',
  a => /juniper/i.test(a));
out(`claims in canonical store for owner: ${psql(`SELECT count(*) FROM aqua_claims WHERE owner_id='${OWNER}'`)}`);

writeFileSync(STATE, JSON.stringify({ jar: [...jar.entries()], owner: OWNER }));
summary(process.env.E2E_OUT ?? 'e2e-product.log');
