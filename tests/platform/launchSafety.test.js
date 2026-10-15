/**
 * Launch safety + the first-run funnel.
 *
 * WHY THESE ARE STATIC ASSERTIONS AND NOT A BOOTED APP
 * ---------------------------------------------------
 * `startServer()` awaits a live Mongo connection before it listens, so there is
 * no way to stand this app up in a test process without a database. Stubbing
 * mongoose far enough to get past model compilation produces a fake app, and a
 * green result against a fake app is worth less than no result — it is the same
 * trap as proving a module while its wiring stays unverified.
 *
 * So this suite pins the two things that CAN be checked without a database:
 * that the middleware is present in the right ORDER, and that the redirect
 * decision is what it claims to be. The behaviour of helmet and
 * express-rate-limit themselves is their maintainers' job, not ours; what is
 * ours is whether they are mounted where they can do anything.
 *
 * The end-to-end check belongs in a real environment. See LAUNCH_SAFETY_APPLY.md
 * for the three curl commands.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
const at = (needle) => {
  const i = SRC.indexOf(needle);
  assert.ok(i > -1, `not found in index.js: ${needle}`);
  return i;
};

// ── Security headers ─────────────────────────────────────────────────────────

test('helmet is required and mounted', () => {
  assert.match(SRC, /require\("helmet"\)/);
  assert.match(SRC, /app\.use\(helmet\(/);
});

test('helmet is mounted BEFORE the body parsers, so every route below is covered', () => {
  assert.ok(at('app.use(helmet(') < at('const platformJson = express.json('));
  assert.ok(at('app.use(helmet(') < at('app.use(express.urlencoded('));
});

test('helmet is mounted AFTER the Razorpay webhook, whose raw body must stay untouched', () => {
  assert.ok(at('_webhookLog') < at('app.use(helmet('));
});

test('CSP is off DELIBERATELY, and the reason is written down', () => {
  // A wrong CSP breaks an EJS + Vite app silently and only in a browser. If
  // someone turns it on, they should do it with the console open — not by
  // flipping a flag because a linter complained.
  assert.match(SRC, /contentSecurityPolicy:\s*false/);
  assert.match(SRC, /CSP IS DELIBERATELY OFF/);
});

// ── Rate limiting ────────────────────────────────────────────────────────────

test('express-rate-limit is required and two limiters exist', () => {
  assert.match(SRC, /require\("express-rate-limit"\)/);
  assert.match(SRC, /const authLimiter\s*=\s*rateLimit\(/);
  assert.match(SRC, /const engineLimiter\s*=\s*rateLimit\(/);
});

test('every credential entry point is rate limited', () => {
  // Brute force on /login, account-creation abuse on /signup, and OAuth
  // round-trips that cost us sockets on /auth/google.
  assert.match(SRC, /app\.post\("\/login",\s*authLimiter/);
  assert.match(SRC, /app\.post\("\/signup",\s*authLimiter/);
  assert.match(SRC, /app\.get\("\/auth\/google",\s*authLimiter/);
});

test('the LLM engine is rate limited BEFORE the auth check', () => {
  // An unauthenticated flood still costs sockets and event-loop time, so the
  // limiter has to sit in front of requireLogin, not behind it.
  // Since E11 the chain is the `aquaAccess` array, mounted at /api/aqua and /v1.
  assert.match(SRC, /app\.use\("\/api\/aqua", \.\.\.aquaAccess\)/);
  const def = SRC.indexOf('const aquaAccess = [');
  assert.ok(def > -1);
  const block = SRC.slice(def, SRC.indexOf('];', def));
  assert.ok(block.includes('engineLimiter') && block.includes('requireLogin'), block);
  assert.ok(block.indexOf('engineLimiter') < block.indexOf('requireLogin'), block);
});

test('trust proxy is set — without it every user shares one rate-limit bucket', () => {
  // Behind Render every request arrives from the proxy address. This was
  // already present; pinned here because removing it would silently turn the
  // limiters above into a way for one abuser to lock out everybody.
  assert.match(SRC, /app\.set\("trust proxy",\s*1\)/);
});

test('static assets are NOT rate limited', () => {
  // A single page load fetches a dozen content-hashed assets. A global limiter
  // loose enough for that is useless for the two things worth protecting, which
  // is why there are two limiters and no global one.
  assert.ok(!/app\.use\(\s*(auth|engine)Limiter\s*\)/.test(SRC), 'a limiter is mounted globally');
});

// ── The first-run funnel ─────────────────────────────────────────────────────

test('signup lands in the PRODUCT, not the workspace dashboard', () => {
  // The landing page promises "The AI that already understands your work" and
  // signup used to drop the user on /home — nineteen links — where they had to
  // find "Open Aqua" before meeting the thing they signed up for.
  const i = at('app.post("/signup"');
  const block = SRC.slice(i, i + 2600);
  assert.match(block, /res\.redirect\("\/aqua"\)/);
  assert.ok(!/res\.redirect\("\/home"\)/.test(block), 'signup still redirects to /home');
});

test('a NEW Google account goes to the product; a returning one keeps the workspace', () => {
  assert.match(SRC, /user\.\$locals\.justCreated = true/);
  // A returning user's destination is the switch-account target, whose
  // default is /home (takePostLoginNext(req, "/home")).
  assert.match(SRC, /firstRun \? "\/aqua" : \(req\._postLoginNext \|\| "\/home"\)/);
  assert.match(SRC, /req\._postLoginNext = takePostLoginNext\(req, "\/home"\)/);
});

test('the first-run marker is never persisted', () => {
  // `$locals` is mongoose's per-document scratch space. Using a real schema
  // field would mean a migration for something that lives for one request.
  assert.ok(!/justCreated:\s*\{/.test(fs.readFileSync(path.join(__dirname, '..', '..', 'models', 'User.js'), 'utf8')),
    'justCreated leaked into the User schema');
});

test('/home is NOT removed — a returning user still has a workspace', () => {
  // The finding was that /home sat in the FIRST-RUN path, not that /home is
  // wrong. Login is untouched.
  assert.match(SRC, /app\.get\("\/home", requireLogin/);
  const i = at('app.post("/login"');
  assert.match(SRC.slice(i, i + 1600), /takePostLoginNext\(req, "\/home"\)/);
});

test('the 50 MB JSON parser runs only for signed-in engine calls', () => {
  // It used to be global and pre-auth: any anonymous POST to any route could
  // make the server buffer and parse 50 MB.
  assert.ok(!/app\.use\(express\.json\(\{ limit: "50mb" \}\)\)/.test(SRC), 'global 50mb parser is back');
  assert.match(SRC, /const platformJson = express\.json\(\{ limit: "1mb" \}\)/);
  const def = at('const aquaAccess = [');
  const block = SRC.slice(def, SRC.indexOf('];', def));
  assert.ok(block.indexOf('requireLogin') < block.indexOf('aquaJson'), 'aquaJson must come after requireLogin');
});
