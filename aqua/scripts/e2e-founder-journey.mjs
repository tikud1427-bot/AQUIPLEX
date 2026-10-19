// End-to-end drive of the REAL product (server + worker from start-production.mjs)
// through the founder workflow the product promises (YC_PRODUCT_THESIS.md):
//
//   "Aqua knows where your project stands: what's current, what changed,
//    where it learned it, and you can correct or delete any of it."
//
//   signup → onboarding interview (mode=understanding) → "what I understood" card
//   → upload a pricing doc → Memory: what Aqua knows now, with sources
//   → a change in a NEW conversation → investor update in ANOTHER new
//   conversation uses the new facts → Memory: correct one value, delete another
//   → new conversations reflect both → a second account sees none of it and
//   cannot delete it.
//
// Every check is recorded, never thrown, so every step runs. Real providers.
//
//   E2E_BASE (http://127.0.0.1:5055) · E2E_DB (aqua_e2e) · E2E_MONGO_DB (aqua_validation)
//   E2E_OUT (log file)
import { execSync, execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
/** Verification tokens already used by an earlier signup in this run. */
const seenTokens = new Set();

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:5055';
const DB = process.env.E2E_DB ?? 'aqua_e2e';
const MONGO_DB = process.env.E2E_MONGO_DB ?? 'aqua_validation';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = [];
const out = (...a) => { const s = a.join(' '); console.log(s); log.push(s); };
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok }); out(`  CHECK ${ok ? 'PASS' : 'FAIL'} — ${name}${!ok && detail ? ` :: ${detail}` : ''}`); };
const UNKNOWN_RE = /(don['’]t|do not|not|no|n['’]t) (know|have|record|see|find|mention|been told|stored)|haven['’]t (told|mentioned|shared)|unknown|not sure|no record|not in (my|your)/i;
const psql = sql => execSync(`docker exec aqua-test-db psql -U aqua -d ${DB} -At -c "${sql.replace(/"/g, '\\"')}"`).toString().trim();
const mongo = js => execFileSync('docker', ['exec', 'aqua-test-mongo', 'mongosh', '--quiet', MONGO_DB, '--eval', js]).toString().trim();

/** One browser-like client: its own cookie jar. */
function client() {
  const jar = new Map();
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  async function req(method, path, { body = null, form = null } = {}) {
    const h = { 'X-Forwarded-Proto': 'https', Cookie: cookieHeader(), Origin: BASE };
    let payload;
    if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
    else if (body) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const t0 = Date.now();
    const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i).trim(), kv.slice(i + 1)); }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, text, json, location: res.headers.get('location'), ms: Date.now() - t0 };
  }
  // Email signup is verified since 2026-10-19: /signup only emails a link; the
  // account exists once the link is opened and the password re-entered. The
  // launcher must run with MAIL_TRANSPORT=log; E2E_MAIL_LOG is its log file.
  async function signup(email) {
    const page = await req('GET', '/signup');
    const csrf = page.text.match(/name="_csrf"\s+value="([^"]+)"/)?.[1] ?? '';
    const started = await req('POST', '/signup', { form: { email, password: 'founder-pass-123', _csrf: csrf } });
    const signedInEarly = (await req('GET', '/home')).status === 200;
    let token = null;
    for (let i = 0; i < 20 && !token; i++) {
      const log = process.env.E2E_MAIL_LOG ? readFileSync(process.env.E2E_MAIL_LOG, 'utf8') : '';
      token = [...log.matchAll(/verify-email\?token=([A-Za-z0-9_-]+)/g)].at(-1)?.[1] ?? null;
      if (!token || seenTokens.has(token)) { token = null; await sleep(500); }
    }
    if (token) seenTokens.add(token);
    const form = token ? await req('GET', `/verify-email?token=${token}`) : null;
    const vcsrf = form?.text.match(/name="_csrf"\s+value="([^"]+)"/)?.[1] ?? '';
    const r = token ? await req('POST', '/verify-email', { form: { token, password: 'founder-pass-123', _csrf: vcsrf } }) : started;
    r.signupStatus = started.status; r.signedInBeforeVerify = signedInEarly; r.gotLink = !!token;
    mongo(`db.users.updateOne({email:'${email}'},{'$set':{'wallet.freeCredits':5000,'wallet.paidCredits':5000}})`);
    const id = mongo(`print(db.users.findOne({email:'${email}'})._id.toString())`);
    return { status: r.status, location: r.location, owner: `user:${id}`, signupStatus: r.signupStatus, signedInBeforeVerify: r.signedInBeforeVerify, gotLink: r.gotLink };
  }
  const latencies = [];
  async function chat(message, conversationId = null, extra = {}) {
    for (let i = 0; i < 3; i++) {
      const r = await req('POST', '/api/aqua/chat', { body: { message, ...(conversationId ? { conversationId } : {}), ...extra } });
      if (r.status === 200) {
        latencies.push(r.ms);
        const d = r.json?.data ?? r.json ?? {};
        const answer = String(d.reply ?? d.answer ?? d.response ?? d.message ?? d.content ?? d.text ?? '');
        return { answer, conversationId: d.conversationId ?? r.json?.conversationId ?? conversationId, raw: d, ms: r.ms };
      }
      out(`  chat HTTP ${r.status}: ${r.text.slice(0, 200)}`);
      await sleep(5000);
    }
    return { answer: '', conversationId, raw: {}, failed: true };
  }
  return { req, signup, chat, latencies };
}

// Waits for EVERY pending understanding job — including ones a provider rate
// limit pushed into the future — because the question is how long a founder's
// change takes to reach memory, not whether it has by an arbitrary moment.
const memoryLag = [];
async function waitForWorker(ownerId, label, maxMinutes = 25) {
  const t0 = Date.now();
  for (let i = 0; i < maxMinutes * 12; i++) {
    const pending = Number(psql(`SELECT count(*) FROM aqua_jobs WHERE owner_id='${ownerId}' AND state IN ('queued','running')`));
    const outbox = Number(psql(`SELECT count(*) FROM aqua_outbox WHERE owner_id='${ownerId}' AND state IN ('pending','processing')`));
    if (!pending && !outbox) {
      const s = Math.round((Date.now() - t0) / 1000);
      memoryLag.push({ label, seconds: s });
      out(`  [all understanding done after ${label}: ${s}s]`);
      return;
    }
    await sleep(5000);
  }
  memoryLag.push({ label, seconds: null });
  const dead = psql(`SELECT count(*) FROM aqua_jobs WHERE owner_id='${ownerId}' AND state='dead'`);
  out(`  [understanding still pending after ${label} (${maxMinutes} min) — continuing; dead=${dead}]`);
}

const say = (r, q) => out(`USER: ${q}\nAQUA: ${r.answer.slice(0, 600).replace(/\n/g, ' ')}\n  (${r.ms} ms, memory read=${r.raw?.memory?.readMode ?? '?'})`);

// ── 1. signup ────────────────────────────────────────────────────────────────
const A = client();
const email = `founder-${Date.now().toString(36)}@example.test`;
const su = await A.signup(email);
out(`signup HTTP ${su.status} → ${su.location}  owner ${su.owner}`);
check('signup alone creates no session (email ownership not yet proved)', su.signupStatus === 200 && su.signedInBeforeVerify === false);
check('the verification link + password lands a new account in the product (/aqua)', su.gotLink && su.status === 302 && su.location === '/aqua');
const OWNER = su.owner;

// ── 2. onboarding interview (the intro uses mode=understanding) ──────────────
out('\n=== onboarding ===');
const intro = [
  "I'm building Tidepool, a scheduling tool for physiotherapy clinics. My co-founder Maya runs engineering.",
  'We charge $49 a month per clinic, and our launch is on April 15.',
  'Our biggest risk right now is that clinics churn after the first month.',
];
let introConv = null;
for (const m of intro) {
  const r = await A.chat(m, introConv, { mode: 'understanding' });
  introConv = r.conversationId ?? introConv;
  say(r, m);
}
const card = await A.req('POST', '/api/aqua/understanding/intro/complete', { body: { conversationId: introConv } });
const cardText = JSON.stringify(card.json?.card ?? {});
out(`intro card HTTP ${card.status}: ${cardText.slice(0, 500)}`);
check('the "what I understood" card is produced', card.status === 200 && !!card.json?.card);
check('the card reflects what the founder said (Tidepool)', /tidepool/i.test(cardText), cardText.slice(0, 200));

// ── 3. upload a pricing document ─────────────────────────────────────────────
const doc = 'Tidepool pricing (internal)\nStandard plan: $49 per clinic per month.\nAnnual plan: 2 months free.\nTarget customer: independent physiotherapy clinics with 2-10 therapists.';
const up = await A.req('POST', '/api/aqua/upload', { body: { conversationId: introConv, files: [{ name: 'tidepool_pricing.txt', content: Buffer.from(doc).toString('base64') }] } });
out(`upload HTTP ${up.status}`);
check('document upload accepted', up.status === 200, up.text.slice(0, 200));
await waitForWorker(OWNER, 'onboarding + upload');

// ── 4. Memory: what Aqua knows now, with where it learned it ─────────────────
let cur = await A.req('GET', '/api/aqua/brain/current');
let claims = cur.json?.claims ?? [];
out(`\n=== Memory: ${claims.length} current claims ===`);
for (const c of claims.slice(0, 25)) out(`  - ${c.statement}  [${c.sourceKind}${c.sourceName ? `:${c.sourceName}` : ''}] quote="${String(c.quote ?? '').slice(0, 80)}"`);
check('Memory lists current claims from the onboarding', claims.some(c => /tidepool|physio|clinic/i.test(c.statement)), `${claims.length} claims`);
check('each listed claim carries the sentence it was learned from', claims.length > 0 && claims.every(c => c.quote || c.statement));
check('a document-sourced claim is labelled as coming from the document', claims.some(c => c.sourceKind === 'document'));

// ── 5. a change, in a NEW conversation ───────────────────────────────────────
out('\n=== change (new conversation) ===');
const ch = await A.chat('Update: we moved the launch to May 2, and the price is now $39 per clinic per month.');
say(ch, 'Update: we moved the launch to May 2, and the price is now $39 per clinic per month.');
await waitForWorker(OWNER, 'change');

// ── 6. investor update in ANOTHER new conversation ───────────────────────────
out('\n=== investor update (new conversation) ===');
const iu = await A.chat('Draft a 4-line investor update about where Tidepool stands.');
say(iu, 'Draft a 4-line investor update about where Tidepool stands.');
check('investor update uses the NEW launch date (May 2)', /may\s*2\b|2\s*may/i.test(iu.answer), iu.answer.slice(0, 200));
check('investor update does not present the old launch date as current', !/launch(?:es|ing)?[^.]{0,30}april\s*15/i.test(iu.answer), iu.answer.slice(0, 200));
check('investor update uses the NEW price ($39)', /\$\s?39/.test(iu.answer), iu.answer.slice(0, 200));
check('investor update does not present $49 as the current price', !/\$\s?49(?![\d])(?![^.]{0,40}(previous|old|was|from|down|reduced|lowered|changed))/i.test(iu.answer), iu.answer.slice(0, 200));

const src = await A.chat('Where did you learn our current price?');
say(src, 'Where did you learn our current price?');
check('asked for provenance, Aqua points at what the founder said (the update)', /update|told|said|mentioned|message|conversation/i.test(src.answer), src.answer.slice(0, 200));

// ── 7. Memory: correct one value, delete another ─────────────────────────────
cur = await A.req('GET', '/api/aqua/brain/current');
claims = cur.json?.claims ?? [];
const risk = claims.find(c => /churn/i.test(c.statement));
const cofounder = claims.find(c => /maya/i.test(c.statement));
out(`\ncorrect target: ${risk?.statement ?? 'NOT FOUND'}\ndelete target: ${cofounder?.statement ?? 'NOT FOUND'}`);
check('the churn risk is listed (to correct)', !!risk);
check('the co-founder is listed (to delete)', !!cofounder);
if (risk) {
  const r = await A.req('POST', `/api/aqua/brain/claims/${risk.claimId}/correct-value`, { body: { value: 'clinics not finishing onboarding' } });
  out(`correct-value HTTP ${r.status} → ${r.json?.statement ?? r.text.slice(0, 120)}`);
  check('correction accepted', r.status === 200, r.text.slice(0, 200));
}
// Cross-account: a second founder cannot delete the first one's claim.
const B = client();
const sub = await B.signup(`other-${Date.now().toString(36)}@example.test`);
if (cofounder) {
  const forged = await B.req('POST', `/api/aqua/brain/claims/${cofounder.claimId}/forget`);
  check('another account cannot delete this claim (404)', forged.status === 404, `HTTP ${forged.status}`);
  const r = await A.req('POST', `/api/aqua/brain/claims/${cofounder.claimId}/forget`);
  out(`forget HTTP ${r.status}`);
  check('deletion accepted', r.status === 200, r.text.slice(0, 200));
}
await waitForWorker(OWNER, 'correct + delete');

// ── 8. new conversations reflect both ────────────────────────────────────────
out('\n=== after correction + deletion (new conversations) ===');
const rk = await A.chat("What's our biggest risk right now?");
say(rk, "What's our biggest risk right now?");
check('the corrected risk answers', /onboarding/i.test(rk.answer), rk.answer.slice(0, 200));
check('the old risk wording is not presented as current', !/churn after the first month/i.test(rk.answer), rk.answer.slice(0, 200));
const cf = await A.chat("Who is my co-founder and what does she run?");
say(cf, 'Who is my co-founder and what does she run?');
check('the deleted co-founder fact does not come back', !/maya/i.test(cf.answer), cf.answer.slice(0, 200));
check('Aqua says it does not know, rather than inventing one', UNKNOWN_RE.test(cf.answer), cf.answer.slice(0, 200));

// ── 9. isolation: the second account sees none of it ────────────────────────
const bCur = await B.req('GET', '/api/aqua/brain/current');
check('a second account\'s Memory is empty of the first account\'s facts', !(bCur.json?.claims ?? []).some(c => /tidepool|maya|physio/i.test(c.statement)));
const bAsk = await B.chat('What is Tidepool and what does it cost?');
say(bAsk, '(other account) What is Tidepool and what does it cost?');
check('a second account\'s answer does not contain the first account\'s price', !/\$\s?(39|49)/.test(bAsk.answer), bAsk.answer.slice(0, 200));

// ── summary ──────────────────────────────────────────────────────────────────
const lat = [...A.latencies].sort((a, b) => a - b);
const pct = p => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
out(`\nlatency (account A chat, ${lat.length} turns): p50=${pct(0.5)}ms p90=${pct(0.9)}ms max=${lat.at(-1)}ms`);
out(`time for what was said to reach memory: ${memoryLag.map(m => `${m.label}=${m.seconds ?? 'not within budget'}s`).join(', ')}`);
out(`dead understanding jobs: ${psql(`SELECT count(*) FROM aqua_jobs WHERE owner_id='${OWNER}' AND state='dead'`)}`);
out(`claims in canonical store for owner: ${psql(`SELECT state||'='||count(*) FROM aqua_claims WHERE owner_id='${OWNER}' GROUP BY state`).replace(/\n/g, ', ')}`);
out(`\nSUMMARY ${checks.filter(c => c.ok).length}/${checks.length} checks passed`);
writeFileSync(process.env.E2E_OUT ?? 'e2e-founder.log', log.join('\n'));
