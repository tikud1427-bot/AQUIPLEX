#!/usr/bin/env node
/**
 * One "application process" for the Phase 2b multi-process tests.
 *
 *   node storeProcess.mjs '<json list of ops>'
 *
 * The parent sets the environment: DATABASE_URL (the disposable test database),
 * AQUA_DATA_DIR (this process's own disk), AQUA_STORE_PARTITIONS (the mode),
 * and blanks MONGO_URI so dataDir.js never hydrates from a real cluster.
 *
 * Ops run in order. Each op's result is collected; the list is printed as JSON
 * on the last stdout line.
 *   { op: 'boot' }                         configurePartitionBindings (what the server/worker do)
 *   { op: 'load', owner }                  ensureOwnerLoaded (the unit-of-work load)
 *   { op: 'barrier', dir, name, n }        wait until n processes reached this barrier
 *   { op: 'call', module, fn, args }       call an exported function of a store module
 *   { op: 'flush' }                        flushOwnerBindings + the JSON writers
 *   { op: 'status' }                       ownerBindingStatus()
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';

// TEST ONLY: run this "host" with a wrong clock (Phase 2c clock-independence tests).
if (process.env.STORE_PROCESS_CLOCK_SKEW_MS) {
  const skew = Number(process.env.STORE_PROCESS_CLOCK_SKEW_MS);
  const realNow = Date.now.bind(Date);
  Date.now = () => realNow() + skew;
}

const ops = JSON.parse(process.argv[2] ?? '[]');
const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const MODULES = {
  reflection: 'brain/reflectionV2/reflectionStore.js',
  reflectionV2: 'brain/reflectionV2/index.js',
  mind: 'mind/mindStore.js',
  redactions: 'memory/recallRedactions.js',
  conversations: 'memory/conversationStore.js',
  graph: 'reasoning/reasoningGraph.js',
  ids: 'brain/identity/idStore.js',
  annotations: 'brain/worldModel/annotationStore.js',
  evidence: 'files/evidenceStore.js',
  fileindex: 'files/fileSearchIndex.js',
  uko: 'files/ukoStore.js',
  attachments: 'upload/attachmentStore.js',
  pic: 'pic/picStore.js',
  vectors: 'embeddings/vectorStore.js',
  projects: 'project/projectMemory.js',
  projectIndex: 'project/projectIndex.js',
  artifacts: 'artifacts/artifactStore.js',
  cognition: 'cognition/cognitiveStore.js',
  ledger: 'intelligence/learningLedger.js',
  binding: 'core/storage/ownerBinding.js',
  storage: 'core/storage/index.js',
};
const load = name => import(pathToFileURL(path.join(src, MODULES[name])).href);

/** Make results JSON-safe: Maps become objects. */
const plain = v => JSON.parse(JSON.stringify(v, (_k, x) => (x instanceof Map ? Object.fromEntries(x) : x)) ?? 'null');

const out = [];
for (const o of ops) {
  try {
    if (o.op === 'boot') {
      // Like the real server (router imports the routes, which import the
      // stores) and worker: stores are imported, and so bound, BEFORE configuring.
      for (const name of o.stores ?? ['reflection', 'reflectionV2']) await load(name);
      out.push(await (await load('storage')).configurePartitionBindings());
    } else if (o.op === 'load') {
      out.push(await (await load('binding')).ensureOwnerLoaded(o.owner));
    } else if (o.op === 'barrier') {
      fs.writeFileSync(path.join(o.dir, `${o.name}.${process.pid}`), '');
      const t0 = Date.now();
      while (fs.readdirSync(o.dir).filter(f => f.startsWith(`${o.name}.`)).length < o.n) {
        if (Date.now() - t0 > 20_000) throw new Error(`barrier ${o.name} timed out`);
        await new Promise(r => setTimeout(r, 10));
      }
      out.push('ok');
    } else if (o.op === 'call') {
      const m = await load(o.module);
      out.push(plain(await m[o.fn](...(o.args ?? []))));
    } else if (o.op === 'mindSet') {
      // What every learning path does: mutate the owner's Mind, then touchMind.
      const m = await load('mind');
      const mind = m.getMind(o.owner);
      const at = o.at ?? Date.now();
      mind.facts[o.key] = { key: o.key, value: o.value, ts: at, updatedAt: at };
      m.touchMind(mind);
      out.push('ok');
    } else if (o.op === 'mindDeleteItem') {
      const m = await load('mind');
      const mind = m.getMind(o.owner);
      out.push(m.deleteItem(mind, 'facts', o.key));
      m.touchMind(mind);
    } else if (o.op === 'mindFacts') {
      const m = await load('mind');
      const mind = m.peekMind(o.owner);
      out.push(mind ? Object.fromEntries(Object.entries(mind.facts).map(([k, v]) => [k, v.value])) : null);
    } else if (o.op === 'convKeys') {
      const c = await load('conversations');
      out.push(c.getConversation(o.id).map(m => c.messageKeyOf(o.id, m)));
    } else if (o.op === 'convText') {
      const c = await load('conversations');
      out.push(c.getConversation(o.id).map(m => m.content));
    } else if (o.op === 'picSignal') {
      // What reasoning feedback does: bump a fact's ok/bad counters, then save.
      const p = await load('pic');
      const b = p.picBucket(o.owner);
      const sig = b.signals.get(o.fact) ?? { ok: 0, bad: 0, lastAt: 0 };
      sig.ok += o.ok ?? 0; sig.bad += o.bad ?? 0; sig.lastAt = Date.now();
      b.signals.set(o.fact, sig);
      p.schedulePicSave();
      out.push('ok');
    } else if (o.op === 'artifactCreate') {
      const a = await load('artifacts');
      const m = await a.createArtifact({ ownerId: o.owner, conversationId: 'c', requestId: 'r', format: 'txt', title: o.title ?? 'T',
        spec: {}, packaging: 'raw', files: [{ path: 'a.txt', buffer: Buffer.from(o.text), mime: 'text/plain' }] });
      out.push({ id: m.id, version: m.version });
    } else if (o.op === 'artifactAppend') {
      const a = await load('artifacts');
      const m = await a.appendVersion(o.id, { files: [{ path: 'a.txt', buffer: Buffer.from(o.text), mime: 'text/plain' }], reason: o.text });
      out.push(m ? { version: m.version, versions: m.versions.map(v => v.v) } : null);
    } else if (o.op === 'artifactRead') {
      const a = await load('artifacts');
      const m = await a.getArtifact(o.id);
      if (!m) { out.push(null); continue; }
      const version = o.version ?? m.version;
      await a.ensureArtifactFiles(m, version);
      out.push({ version, text: fs.readFileSync(a.getFileAbsolutePath(m, 'a.txt', version), 'utf8'), versions: m.versions.map(v => v.v) });
    } else if (o.op === 'artifactStream') {
      // Phase 4B: read through openArtifactFileStream (object store → stream, no local copy).
      const a = await load('artifacts');
      const m = await a.getArtifact(o.id);
      if (!m) { out.push(null); continue; }
      try {
        const { stream } = await a.openArtifactFileStream(m, 'a.txt', o.version ?? m.version);
        const chunks = []; for await (const c of stream) chunks.push(Buffer.from(c));
        out.push({ text: Buffer.concat(chunks).toString('utf8'), localCopy: fs.existsSync(a.getFileAbsolutePath(m, 'a.txt', o.version ?? m.version)) });
      } catch (err) { out.push({ error: err.code ?? err.message }); }
    } else if (o.op === 'artifactDelete') {
      const a = await load('artifacts');
      await a.deleteArtifact(o.id);
      out.push('ok');
    } else if (o.op === 'aggSync') {
      const b = (await load('binding'))._bindingsForTests().get(o.storeKey);
      await b.sync();
      out.push(b.status());
    } else if (o.op === 'isRedacted') {
      const r = await load('redactions');
      out.push(r.redactionsFor(o.owner).isRedacted(o.sentence, o.ts ?? null));
    } else if (o.op === 'flush') {
      const b = await load('binding');
      out.push(await b.flushOwnerBindings(10_000));
    } else if (o.op === 'status') {
      out.push((await load('binding')).ownerBindingStatus());
    } else {
      throw new Error(`unknown op ${o.op}`);
    }
  } catch (err) {
    out.push({ error: `${err.name}: ${err.message}` });
  }
}
// The JSON writers (rollback copy) are debounced; drain them like a SIGTERM would.
await (await load('storage')).flushStorage(10_000);
await new Promise(r => setTimeout(r, 700));
console.log(JSON.stringify(out));
const { closePool } = await import(pathToFileURL(path.join(src, 'core/db/pool.js')).href);
await closePool();
process.exit(0);
