#!/usr/bin/env node
/**
 * AQUA — mirror census (READ-ONLY). audit/render-heap-oom, 2026-11-24.
 *
 *   MONGO_URI="<cluster uri>" node aqua/scripts/mirror-census.mjs [--json]
 *
 * Measures the shape of the `aqua_kv` mirror collection: live stores, chunk
 * parts (referenced vs orphaned), preserved conflict copies, the largest
 * stores — and what booting on it costs. Use it to size the production
 * collection before and after the bounded-hydration repair.
 *
 * READ-ONLY BY CONSTRUCTION
 *   · exactly one aggregation: $project of metadata fields + a server-computed
 *     $bsonSize. The `json` field (store contents) is never requested, so no
 *     user data leaves the database and none is printed.
 *   · no insert/update/delete, no canary, no lease (it does NOT import the
 *     app's mongoMirror.js, whose connect() writes a canary doc).
 *   · prints store file names (.aqua-*.json) and numbers only.
 */
import mongoose from 'mongoose';

const uri = process.env.MONGO_URI;
const asJson = process.argv.includes('--json');
if (!uri) { console.error('MONGO_URI is not set.'); process.exit(2); }

const MB = n => +(n / 1e6).toFixed(1);
const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 10_000 }).asPromise();
try {
  const rows = await conn.db.collection('aqua_kv').aggregate([
    { $project: {
      _id: 1, part: 1, of: 1, gen: 1, i: 1, conflict: 1, localRecovery: 1, chunked: 1, parts: 1, bytes: 1, updatedAt: 1,
      size: { $bsonSize: '$$ROOT' },
    } },
  ], { allowDiskUse: false }).toArray();

  const CANARY = '.aqua-mirror-canary', LOCK = '.aqua-mirror-writer';
  const parts = rows.filter(r => r.part === true);
  const nonParts = rows.filter(r => r.part !== true);
  const conflicts = nonParts.filter(r => r.conflict || String(r._id).startsWith('conflict/'));
  const live = nonParts.filter(r => !conflicts.includes(r) && r._id !== CANARY && r._id !== LOCK);
  const key = (of, gen) => `${of}\u0000${gen}`;
  const liveRefs = new Set(live.filter(r => r.chunked).map(r => key(r._id, r.gen)));
  // Conflict manifests reference parts under the LIVE file name (preserveForeignGeneration)
  // or under their own id (preserveLocal).
  const conflictRefs = new Set(conflicts.filter(r => r.chunked).flatMap(r => [key(r.of, r.gen), key(r._id, r.gen)]));
  const sum = a => a.reduce((s, r) => s + (r.size || 0), 0);
  const partsLive = parts.filter(p => liveRefs.has(key(p.of, p.gen)));
  const partsConflict = parts.filter(p => !liveRefs.has(key(p.of, p.gen)) && conflictRefs.has(key(p.of, p.gen)));
  const partsOrphan = parts.filter(p => !liveRefs.has(key(p.of, p.gen)) && !conflictRefs.has(key(p.of, p.gen)));

  // Per live store: its bytes on disk once restored.
  const perStore = live.map(r => {
    const own = partsLive.filter(p => p.of === r._id);
    return { store: String(r._id), chunked: !!r.chunked, parts: r.chunked ? r.parts : 0,
      bytes: r.chunked ? (r.bytes ?? sum(own)) : r.size, updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null };
  }).sort((a, b) => b.bytes - a.bytes);
  const orphanByStore = {};
  for (const p of partsOrphan) { orphanByStore[p.of] ??= { parts: 0, gens: new Set(), size: 0 }; orphanByStore[p.of].parts++; orphanByStore[p.of].gens.add(p.gen); orphanByStore[p.of].size += p.size; }

  const total = sum(rows);
  const liveBytes = perStore.reduce((s, r) => s + r.bytes, 0);
  const report = {
    collection: { docs: rows.length, dataMB: MB(total) },
    liveStores: { count: live.length, MB: MB(liveBytes), largest: perStore.slice(0, 8).map(r => ({ ...r, MB: MB(r.bytes) })) },
    chunkParts: {
      total: parts.length, MB: MB(sum(parts)),
      referencedByLive: { count: partsLive.length, MB: MB(sum(partsLive)) },
      referencedByConflictCopies: { count: partsConflict.length, MB: MB(sum(partsConflict)) },
      orphaned: { count: partsOrphan.length, MB: MB(sum(partsOrphan)),
        byStore: Object.fromEntries(Object.entries(orphanByStore).map(([k, v]) => [k, { parts: v.parts, generations: v.gens.size, MB: MB(v.size) }])) },
    },
    conflictCopies: { count: conflicts.length, MB: MB(sum(conflicts)), chunked: conflicts.filter(r => r.chunked).length,
      localRecovery: conflicts.filter(r => r.localRecovery).length },
    // Calibrated on Node 20/22 in a 512 MB container (V8 heap limit 259 MB), audit/render-heap-oom/MEMORY_PROFILE.md.
    estimates: {
      oldHydrationPeakHeapMB: Math.round(70 + 3.4 * MB(total)),
      boundedHydrationPeakHeapMB: Math.round(70 + 2 * Math.min(10, MB(perStore[0]?.bytes ?? 0))),
      storeLoadPeakHeapMB: Math.round(70 + 2.3 * MB(liveBytes)),
      heapLimitMB: 259,
    },
  };
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('\nAQUA mirror census (read-only)\n' + '─'.repeat(70));
    console.log(`collection      ${report.collection.docs} docs, ${report.collection.dataMB} MB`);
    console.log(`live stores     ${report.liveStores.count}, ${report.liveStores.MB} MB restored to disk`);
    for (const r of report.liveStores.largest) console.log(`  ${r.store.padEnd(32)} ${String(r.MB).padStart(7)} MB${r.chunked ? `  (${r.parts} parts)` : ''}`);
    console.log(`chunk parts     ${report.chunkParts.total} (${report.chunkParts.MB} MB): live ${report.chunkParts.referencedByLive.count}, conflict copies ${report.chunkParts.referencedByConflictCopies.count}, ORPHANED ${report.chunkParts.orphaned.count} (${report.chunkParts.orphaned.MB} MB)`);
    for (const [k, v] of Object.entries(report.chunkParts.orphaned.byStore)) console.log(`  orphaned ${k.padEnd(30)} ${v.generations} generation(s), ${v.MB} MB`);
    console.log(`conflict copies ${report.conflictCopies.count} (${report.conflictCopies.MB} MB), ${report.conflictCopies.chunked} chunked, ${report.conflictCopies.localRecovery} local-recovery`);
    console.log('estimates (Node 20/22, 512 MB instance, heap limit 259 MB):');
    console.log(`  old hydration peak heap      ~${report.estimates.oldHydrationPeakHeapMB} MB`);
    console.log(`  bounded hydration peak heap  ~${report.estimates.boundedHydrationPeakHeapMB} MB`);
    console.log(`  store loading peak heap      ~${report.estimates.storeLoadPeakHeapMB} MB  ← must stay well under 259`);
  }
} finally {
  await conn.close();
}
