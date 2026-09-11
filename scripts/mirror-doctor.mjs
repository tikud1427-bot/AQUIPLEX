#!/usr/bin/env node
/**
 * AQUA — mirror doctor.
 *
 * Run this ON THE SERVER that cannot reach Atlas:
 *
 *     node scripts/mirror-doctor.mjs
 *
 * WHY IT EXISTS
 * -------------
 * The mirror has been down since Jul 31 with `EAI_AGAIN` and `secureConnect`
 * timeouts. Those two symptoms have completely different causes — the first is
 * DNS, the second is a network path or an IP allowlist — and the application
 * log cannot tell them apart, because by the time mongoose reports a failure it
 * has already collapsed six layers into one message.
 *
 * So this walks the layers one at a time and stops at the first one that
 * breaks, because everything after a broken layer fails for the same reason and
 * reporting all of it is noise.
 *
 *     1. Is MONGO_URI even set, and does it parse?
 *     2. Does the SRV record resolve?            → DNS
 *     3. Do the hosts resolve to addresses?      → DNS
 *     4. Does a TCP socket open?                 → allowlist / egress / firewall
 *     5. Does TLS complete?                      → certificate / TLS version
 *     6. Does the driver authenticate?           → credentials / user / db
 *     7. Does a write round-trip?                → permissions on the collection
 *
 * Every failure prints the SPECIFIC next action, not "check your connection".
 *
 * Zero new dependencies: node's own dns/net/tls, plus the mongoose the app
 * already has. Read-only except for step 7, which writes one canary document
 * to a dedicated collection and deletes it again.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';

const TIMEOUT_MS = Number(process.env.AQUA_DOCTOR_TIMEOUT_MS) || 8000;

let failed = false;
const ok   = (m, d = '') => console.log(`  ✓ ${m}${d ? `  ${d}` : ''}`);
const bad  = (m, why, ...fix) => {
  failed = true;
  console.log(`  ✗ ${m}`);
  console.log(`      ${why}`);
  for (const f of fix) console.log(`      → ${f}`);
};
const info = (m) => console.log(`    ${m}`);

const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms (${label})`)), ms).unref?.()),
]);

console.log('\nAQUA mirror doctor');
console.log('─'.repeat(70));

// ── 1. Configuration ─────────────────────────────────────────────────────────
const uri = process.env.MONGO_URI;
if (!uri) {
  bad('MONGO_URI is not set',
      'The mirror is off, so durability depends entirely on the data directory.',
      'Set MONGO_URI — or attach a persistent disk and point AQUA_DATA_DIR at it. Either is enough.');
  process.exit(1);
}
if (process.env.AQUA_DISABLE_MONGO_MIRROR === '1') {
  bad('AQUA_DISABLE_MONGO_MIRROR=1',
      'The mirror is explicitly disabled, so nothing below would run in the app either.',
      'Unset it if this environment is meant to be durable.');
}

let parsed;
try {
  parsed = new URL(uri);
  ok('MONGO_URI parses', `scheme=${parsed.protocol.replace(':', '')}`);
} catch (err) {
  bad('MONGO_URI does not parse', err.message,
      'Expected mongodb+srv://user:pass@cluster.xxxxx.mongodb.net/db');
  process.exit(1);
}

const isSrv = parsed.protocol === 'mongodb+srv:';
const hasCreds = !!(parsed.username && parsed.password);
if (!hasCreds) {
  info('no credentials in the URI — fine if you use X.509 or an AWS role, otherwise a problem');
}

// ── 2 & 3. DNS ───────────────────────────────────────────────────────────────
let hosts = [];
if (isSrv) {
  const srvName = `_mongodb._tcp.${parsed.hostname}`;
  try {
    const records = await withTimeout(dns.resolveSrv(srvName), TIMEOUT_MS, 'SRV lookup');
    hosts = records.map(r => ({ host: r.name, port: r.port }));
    ok(`SRV record resolves`, `${hosts.length} host(s)`);
  } catch (err) {
    const code = err.code ?? '';
    bad(`SRV lookup failed for ${srvName}`,
        `${code || err.message} — this is DNS, not MongoDB. The cluster may be perfectly healthy.`,
        code === 'EAI_AGAIN'
          ? 'EAI_AGAIN means the resolver did not answer. On Render this is usually the container having no working DNS for SRV records, or an outbound DNS block.'
          : 'Confirm the cluster hostname is spelled correctly and still exists in Atlas.',
        'Try the non-SRV form: Atlas → Connect → "Node.js driver 2.2.12 or later" gives a mongodb:// URI listing hosts explicitly, which skips SRV entirely.');
    process.exit(1);
  }
} else {
  hosts = [{ host: parsed.hostname, port: Number(parsed.port) || 27017 }];
  ok('direct host (no SRV)', `${parsed.hostname}:${hosts[0].port}`);
}

for (const h of hosts) {
  try {
    const { address } = await withTimeout(dns.lookup(h.host), TIMEOUT_MS, 'A lookup');
    ok(`${h.host} resolves`, address);
    h.address = address;
  } catch (err) {
    bad(`${h.host} does not resolve`, err.code ?? err.message,
        'DNS again — the hostname exists in the SRV record but has no address record.');
  }
}

// ── 4. TCP ───────────────────────────────────────────────────────────────────
const reachable = [];
for (const h of hosts.filter(x => x.address)) {
  const t0 = Date.now();
  try {
    await withTimeout(new Promise((res, rej) => {
      const sock = net.connect({ host: h.address, port: h.port }, () => { sock.end(); res(); });
      sock.on('error', rej);
    }), TIMEOUT_MS, 'TCP connect');
    ok(`TCP ${h.host}:${h.port}`, `${Date.now() - t0}ms`);
    reachable.push(h);
  } catch (err) {
    bad(`TCP ${h.host}:${h.port} failed`,
        `${err.code ?? err.message} — the network path is blocked, not the database.`,
        'THE MOST LIKELY CAUSE: this server\'s outbound IP is not in the Atlas IP Access List.',
        'Atlas → Network Access → add the egress IP. Render static outbound IPs are listed under the service\'s Connect / Networking settings.',
        'A timeout here (rather than ECONNREFUSED) is the signature of a firewall dropping packets silently — which is exactly what an Atlas allowlist miss looks like.');
  }
}
if (!reachable.length) {
  console.log('\n' + '─'.repeat(70));
  console.log('Stopping: nothing below can succeed while no host is reachable.');
  process.exit(1);
}

// ── 5. TLS ───────────────────────────────────────────────────────────────────
const h = reachable[0];
try {
  await withTimeout(new Promise((res, rej) => {
    const sock = tls.connect({ host: h.address, port: h.port, servername: h.host }, () => {
      const cert = sock.getPeerCertificate();
      ok('TLS handshake', `${sock.getProtocol()} · CN=${cert?.subject?.CN ?? '?'} · expires ${cert?.valid_to ?? '?'}`);
      sock.end(); res();
    });
    sock.on('error', rej);
  }), TIMEOUT_MS, 'TLS handshake');
} catch (err) {
  bad('TLS handshake failed', err.message,
      'The socket opens but the secure layer does not — usually an outdated CA bundle or a TLS-inspecting proxy.',
      'This is the layer the app reports as `secureConnect` timeouts.');
}

// ── 6 & 7. Driver: auth, then a real write ───────────────────────────────────
let mongoose;
try {
  mongoose = (await import('mongoose')).default;
} catch {
  bad('mongoose is not resolvable here',
      'Everything above passed, so the network is fine — this is a dependency problem.',
      'Run this from the app directory, after npm install.');
  process.exit(failed ? 1 : 0);
}

let conn;
try {
  conn = await withTimeout(
    mongoose.createConnection(uri, { serverSelectionTimeoutMS: TIMEOUT_MS }).asPromise(),
    TIMEOUT_MS + 2000, 'driver connect');
  ok('driver connected + authenticated', `db=${conn.db.databaseName}`);
} catch (err) {
  const m = err.message ?? '';
  bad('driver connect failed', m,
      /auth/i.test(m)
        ? 'Credentials are wrong, or the user has no access to this database. Atlas → Database Access.'
        : 'Everything below the driver passed, so this is the driver\'s own handshake — check the user, the database name and the replica set name in the URI.');
  process.exit(1);
}

try {
  const col = conn.db.collection('aqua_doctor_canary');
  const doc = { _id: `doctor-${Date.now()}`, at: new Date() };
  await withTimeout(col.insertOne(doc), TIMEOUT_MS, 'write');
  const read = await withTimeout(col.findOne({ _id: doc._id }), TIMEOUT_MS, 'read');
  await col.deleteOne({ _id: doc._id });
  if (read) ok('write → read → delete round-trip', 'the mirror can do its job from here');
  else bad('write succeeded but read returned nothing',
           'Unusual — possibly a read-preference or replica lag problem.',
           'Re-run; if it persists, check the cluster\'s replica set health in Atlas.');
} catch (err) {
  bad('write round-trip failed', err.message,
      'Connected and authenticated, but this user cannot write.',
      'Atlas → Database Access → give the user readWrite on this database.');
}

await conn.close();

console.log('─'.repeat(70));
if (failed) {
  console.log('Something above is broken. Fix the FIRST ✗ and re-run — later failures');
  console.log('are usually consequences of the earlier one.\n');
  process.exit(1);
}
console.log('All layers pass. If the app still reports the mirror as not durable,');
console.log('restart it — the status is derived from recent successes, not from config.\n');
