// End-to-end drive of the REAL product (server + worker from start-production.mjs):
// signup → session → chat (facts + a correction) → file upload → NEW conversation
// questions → role change → another NEW conversation. Prints answers + DB state.
import { execSync, execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:5055';
const EMAIL = `e2e-${Date.now().toString(36)}@example.test`;
const PASSWORD = 'e2e-password-123';
const jar = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = [];
const out = (...a) => { const s = a.join(' '); console.log(s); log.push(s); };

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
const psql = sql => execSync(`docker exec aqua-test-db psql -U aqua -d aqua_e2e -At -c "${sql.replace(/"/g, '\\"')}"`).toString().trim();

const answerOf = j => {
  const d = j?.data ?? j ?? {};
  return d.reply ?? d.answer ?? d.response ?? d.message ?? d.content ?? d.text ?? JSON.stringify(Object.keys(d));
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
async function waitForWorker(ownerId, label) {
  for (let i = 0; i < 120; i++) {
    const pending = Number(psql(`SELECT count(*) FROM aqua_jobs WHERE owner_id='${ownerId}' AND state IN ('queued','running')`));
    const outbox = Number(psql(`SELECT count(*) FROM aqua_outbox WHERE owner_id='${ownerId}' AND state IN ('pending','processing')`));
    if (!pending && !outbox) { out(`  [worker idle after ${label}: ${i * 5}s]`); return; }
    await sleep(5000);
  }
  out(`  [worker still busy after ${label} — continuing]`);
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
  out(`USER: ${f}\nAQUA: ${r.answer.slice(0, 220).replace(/\n/g, ' ')}`);
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

// ── 4. NEW conversation: synthesis questions ──
out('\n=== conversation 2 (new) ===');
const qs2 = [
  "When is the mug launch, and what's holding it up?",
  'How much does my biggest client pay per mug?',
  'Draft a short note to my studio assistant about the launch plan.',
  "What's my accountant's name?",
];
for (const q of qs2) { const r = await chat(q); out(`USER: ${q}\nAQUA: ${r.answer.slice(0, 500).replace(/\n/g, ' ')}\n`); }

// ── 5. role change in conversation 1, then a NEW conversation ──
out('\n=== conversation 1: role change ===');
const ch = await chat('My biggest client is now Juniper Hotel; Fennel stopped ordering.', conv1);
out(`AQUA: ${ch.answer.slice(0, 200).replace(/\n/g, ' ')}`);
await waitForWorker(OWNER, 'role change');
out(psql(`SELECT state||' | '||left(statement_text,70) FROM aqua_claims WHERE owner_id='${OWNER}' AND predicate='related_to' ORDER BY asserted_at`));
out('\n=== conversation 3 (new) ===');
for (const q of ['Who is my biggest client right now?']) { const r = await chat(q); out(`USER: ${q}\nAQUA: ${r.answer.slice(0, 400).replace(/\n/g, ' ')}\n`); }

writeFileSync(process.env.E2E_OUT ?? 'e2e-product.log', log.join('\n'));
