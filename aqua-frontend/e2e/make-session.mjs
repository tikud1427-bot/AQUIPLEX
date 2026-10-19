// Creates a real account on a running local server and writes a Playwright
// storageState with its session cookie, so e2e/*.spec.ts can run signed in.
//
//   AQUA_E2E_ORIGIN=http://127.0.0.1:5055 node e2e/make-session.mjs [out.json]
//
// Local/test servers only: the server runs with NODE_ENV=production cookies
// (Secure), so requests carry X-Forwarded-Proto: https (trust proxy is set).
import { writeFileSync } from 'node:fs';

const ORIGIN = process.env.AQUA_E2E_ORIGIN ?? 'http://127.0.0.1:5055';
const out = process.argv[2] ?? 'e2e/.auth/state.json';
const jar = new Map();
const req = async (method, path, form) => {
  const headers = { 'X-Forwarded-Proto': 'https', Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
  let body;
  if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  const res = await fetch(ORIGIN + path, { method, headers, body, redirect: 'manual' });
  for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
  return { status: res.status, text: await res.text(), location: res.headers.get('location') };
};

const page = await req('GET', '/signup');
const csrf = page.text.match(/name="_csrf"\s+value="([^"]+)"/)?.[1] ?? '';
const email = `pw-${Date.now().toString(36)}@example.test`;
const r = await req('POST', '/signup', { email, password: 'playwright-pass-1', _csrf: csrf });
if (r.status !== 302 || !jar.has('aidex_session')) throw new Error(`signup failed: ${r.status} ${r.text.slice(0, 200)}`);
// An ESTABLISHED account: a brand-new one is (correctly) sent to the onboarding
// interview first, and the shell specs test the app after that. Done the way a
// person does it: one onboarding message, then "show me what you understand".
const api = async (path, body) => {
  const res = await fetch(ORIGIN + path, {
    method: 'POST',
    headers: { 'X-Forwarded-Proto': 'https', Origin: ORIGIN, 'Content-Type': 'application/json',
      Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const intro = await api('/api/aqua/chat', { message: "I'm testing the app: I run a small design studio.", mode: 'understanding' });
const conversationId = intro.json?.data?.conversationId ?? intro.json?.conversationId ?? null;
const done = await api('/api/aqua/understanding/intro/complete', { conversationId });
if (intro.status !== 200 || done.status !== 200) throw new Error(`onboarding failed: chat ${intro.status}, complete ${done.status}`);
const host = new URL(ORIGIN).hostname;
writeFileSync(out, JSON.stringify({
  cookies: [{ name: 'aidex_session', value: jar.get('aidex_session'), domain: host, path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }],
  origins: [],
}, null, 2));
console.log(`session for ${email} → ${out}`);
