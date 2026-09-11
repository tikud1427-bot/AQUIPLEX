/**
 * File Intelligence 2.0 — end-to-end over the REAL lifecycle.
 *
 * Runs ingestFiles() (classify → parse → enrich → evidence → graph → PIC)
 * with injected document/media pipelines (same offline seam parsers.js
 * documents), on a mixed batch: two conflicting reports, an OCR "scan"
 * image, a source file — then exercises the FI-2 surface end to end:
 * forensics, research, compare, cause — plus a linear-scan perf guard.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-fi2e2e-'));
process.env.AQUA_DATA_DIR = TMP;
process.env.AQUA_PIC = 'on';

const { ingestFiles } = await import('../fileEngine.js');
const ES = await import('../evidenceStore.js');
const US = await import('../ukoStore.js');
const pic = await import('../../pic/core.js');

const O = 'owner-fi2';
const doc = (content) => ({
  title: 'doc', format: 'pdf', metadata: { pages: 2 },
  content, pages: 2, sections: [], language: 'en', truncated: false,
});
const deps = {
  processDocument: async (name) => doc(FIXTURES[name]),
  processMedia: async (name) => ({
    title: name, format: 'png', metadata: { analyzed: true, ocr: true, model: 'fake-vision' },
    content: FIXTURES[name], pages: null,
    sections: [{ heading: 'OCR', text: FIXTURES[name] }], language: 'en', truncated: false,
  }),
};

const FIXTURES = {
  'reportA.pdf': 'Northwind Ltd raised 4000000 in funding on 2026-01-05. The platform launched on 2026-02-10 following the Northwind funding round.',
  'reportB.pdf': 'Northwind Ltd raised 9000000 in funding on 2026-01-05. Audit for Northwind is scheduled for 2031-06-01.',
  'scan.png':    'Receipt shows Northwind Ltd paid 4500 on 2026-01-20 at the office.',
  'notes.txt':   'const northwindTotal = 4500; // running tally for Northwind',
};

let out;
before(async () => {
  out = await ingestFiles({
    files: Object.keys(FIXTURES).map(name => ({ name, buffer: Buffer.from(FIXTURES[name]) })),
    ownerId: O, conversationId: null, deps,
  });
});

test('mixed batch ingests through one lifecycle into one knowledge space', () => {
  assert.equal(out.results.filter(r => r.status === 'ready').length, 4);
  assert.equal(out.ukoIds.length, 4);
  assert.ok(out.graph && out.graph.entities >= 1, 'cross-file graph built');
  assert.ok(ES.listFacts(O, { limit: 1000 }).length >= 3, 'grounded facts stored');
});

test('forensics via PIC: number conflict + future date surfaced from real ingest', () => {
  const f = pic.getForensics(O);
  const types = new Set(f.findings.map(x => x.type));
  assert.ok(types.has('edited_number'), '4M vs 9M funding figures flagged');
  assert.ok(types.has('future_dated_content'), '2031 audit flagged');
});

test('research via PIC: contested funding claim; comparison of the two reports disagrees', () => {
  const r = pic.getResearch(O, { mode: 'consensus' });
  assert.ok(r.contested.length >= 1, 'conflicting funding numbers are contested');
  const [a, b] = out.ukoIds.slice(0, 2);
  const ua = US.listUKOs(O, { limit: 10 }).find(u => u.sourceFile.name === 'reportA.pdf');
  const ub = US.listUKOs(O, { limit: 10 }).find(u => u.sourceFile.name === 'reportB.pdf');
  const cmp = pic.compareKnowledgeFiles(O, ua.id, ub.id);
  assert.ok(cmp.disagreements.length >= 1);
  assert.ok(cmp.sharedEntities.some(e => e.entity.toLowerCase().includes('northwind')));
  void a; void b;
});

test('cause via PIC: launch attributed to the funding round with citations', () => {
  const c = pic.whatCaused(O, 'platform launched');
  assert.ok(c.causes.length >= 1);
  assert.ok(c.causes[0].event.toLowerCase().includes('funding'));
  assert.ok(c.causes[0].citations.length >= 1);
});

test('AQUA_PIC=off silences the whole FI-2 surface', () => {
  process.env.AQUA_PIC = 'off';
  assert.equal(pic.getForensics(O), null);
  assert.equal(pic.getResearch(O, {}), null);
  assert.equal(pic.whatCaused(O, 'launch'), null);
  process.env.AQUA_PIC = 'on';
});

test('perf: the FI-2 pass has no runaway ceiling — the shape itself is counted elsewhere', async () => {
  // 🔴 I NEARLY RETRACTED A CORRECT FINDING ON ONE MEASUREMENT.
  //
  // FLAKE-1 reported this pass as quadratic at 3.96×. Investigating today, a
  // single better-isolated reading came back at 1.90× and I concluded the
  // finding had been an artefact of accumulating store state.
  //
  // It was not. With ALL THREE singleton stores purged per sample, four
  // consecutive runs give 3.12×, 3.31×, 3.73×, 3.09× — superlinear, close to
  // the original number. The 1.90× was the outlier.
  //
  // Two things are true and worth keeping separate:
  //
  //   the FINDING stands       the pass is superlinear, ~3.2×
  //   the HARNESS was wrong    it purged one store of three, so the earlier
  //                            figure was inflated by accumulation
  //
  // The lesson is the retraction, not the finding: one reading is not a
  // measurement, and I was one commit away from deleting a real result
  // because a single number disagreed with it.
  //
  // FINDING-1 is unaffected either way — its 73,500 contradiction edges were
  // counted DIRECTLY, never inferred from a ratio.
  //
  // The ceiling catches a WORSENING; the lower bound inverts when someone
  // makes it linear.
  const { createEvidence, createFact } = await import('../evidence.js');
  const { createUKO } = await import('../uko.js');
  const { rebuildOwnerGraph } = await import('../../reasoning/graphBuilder.js');
  const G = await import('../../reasoning/reasoningGraph.js');
  const { assertScalesLinearly } = await import('../../core/tests/helpers/perfShape.mjs');

  const owners = [];
  const workload = (factCount) => {
    const P = `owner-fi2-perf-${owners.length}`;
    owners.push(P);
    const perFile = Math.ceil(factCount / 6);
    for (let f = 0; f < 6; f++) {
      const u = createUKO({ ownerId: P, sourceFile: { name: `bulk${f}.pdf`, ext: '.pdf', bytes: 1, hash: String(f).padEnd(64, 'x') }, fileType: 'document' });
      u.id = `bulk${f}`; US.saveUKO(u);
      for (let i = 0; i < perFile; i++) {
        const st = `Item ${i} for VendorCo recorded value ${1000 + i} on 2026-0${(i % 6) + 1}-1${i % 9}`;
        const ev = ES.saveEvidence(P, createEvidence({ sourceFileId: u.id, sourceFileName: u.sourceFile.name, sourceType: 'document', extractionMethod: 'structural', location: { page: i }, snippet: st }));
        ES.saveFact(P, createFact({ statement: st, entities: ['VendorCo'], evidence: [ev] }), { sourceFileId: u.id });
      }
    }
    rebuildOwnerGraph({ evidenceStore: ES, ukoStore: US }, P);
    pic.getForensics(P);
    pic.getResearch(P, { mode: 'consensus' });
    pic.getResearch(P, { mode: 'gaps' });
    pic.whatCaused(P, 'Item 40');
  };
  // ALL THREE stores, not just evidence. The workload writes to the UKO store
  // and the reasoning graph too, and purging one of three leaves the ratio
  // measuring the other two.
  const reset = () => {
    for (const o of owners) { ES.purgeOwner?.(o); US.purgeOwner?.(o); G.purgeOwner?.(o); }
    owners.length = 0;
  };

  // n RAISED to 600 after FIX-5.
  //
  // Bucketing the contradiction pass made this ~4× faster, and at 60–130ms the
  // timing ratio stopped being an instrument: three isolated samples at n=300
  // read 2.80×, 3.31×, 1.86× and the pin flaked one run in four. At n=600 the
  // same three samples read 3.42×, 6.39×, 5.17× — still clearly superlinear,
  // measured where the numbers are large enough to mean something.
  //
  // This is the THIRD time a lower bound on a timing ratio has needed
  // attention here, and it is the fragile direction by nature. The contradiction
  // stage — the one FIX-5 fixed — is pinned EXACTLY by a comparison counter in
  // contradictionCost.test.js. This assertion covers the rest of the pass,
  // where no counter exists yet, and should be replaced by one when the next
  // superlinear stage is identified.
  // ✅ THE LOWER BOUND IS GONE. IT WAS REPLACED BY A COUNTER, AS PLANNED ABOVE.
  //
  // The paragraph above asked for exactly this: "should be replaced by [a
  // counter] when the next superlinear stage is identified." It has been.
  // Timing each stage separately at 600 and 1200 facts:
  //
  //     rebuildGraph  1.19×      consensus   1.19×
  //     forensics     4.60×      gaps        1.74×
  //                              whatCaused  1.61×
  //
  // The superlinearity is the `edited_number` rule in `forensicEngine.js`,
  // whose number-masking collapses a table's rows into one group and then
  // compares them every-pair. It is now counted EXACTLY — 11,175 / 44,850 /
  // 179,700 comparisons at 150 / 300 / 600 facts, precisely n(n−1)/2 — and
  // pinned in `editedNumberCost.test.js`.
  //
  // THE FINDING SURVIVED; THE INSTRUMENT DID NOT. Nine readings of the old
  // `ratio > 2.4` assertion spread 2.08–2.90× and did not converge in the
  // sample count: `samples: 3` read LOWER than `samples: 1`, `samples: 5`
  // higher. The threshold sat inside its own noise band, so it flaked about
  // one run in six and could not tell a regression from a busy CPU.
  //
  // THE CEILING STAYS. An upper bound is the robust direction — a slow slice
  // can only push a ratio UP, so `maxRatio` fails loudly on a real worsening
  // and never on a quiet one. `samples: 3` restores the helper's own best-of
  // default, which the previous `samples: 1` defeated, in a test whose header
  // says "one reading is not a measurement".
  await assertScalesLinearly(workload, {
    n: 600, samples: 3, maxRatio: 8, reset, label: 'FI-2 pass',
  });
});

