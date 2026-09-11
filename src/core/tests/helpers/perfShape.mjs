/**
 * AQUA — measuring a SHAPE instead of a stopwatch
 * Blueprint: test-suite hygiene · the flake class
 *
 * THE PROBLEM
 * -----------
 * 18 tests in this battery assert a wall-clock budget. Two of them are named
 * for an algorithmic property they do not actually measure:
 *
 *   'perf: forensics + research + cause stay LINEAR — 300 facts under 1.5s'
 *      → assert.ok(ms < 1500)
 *
 *   'query fast (adjacency-INDEXED, NOT A SCAN)'
 *      → assert.ok(queryMs < 200)
 *
 * "Stays linear" and "took under 1500 ms" are different claims. The first is a
 * property of the algorithm; the second is a property of the machine on the
 * day. Under the parallel battery those absolute numbers move with unrelated
 * load, which is exactly the flake seen twice in one session — and each time
 * the suite passed in isolation, so the failure taught nobody anything.
 *
 * Loosening the budget would be the obvious fix and the wrong one: it hides a
 * real regression to silence a false one.
 *
 * THE FIX — MEASURE THE RATIO
 * ---------------------------
 * Run the work at N and at 2N and compare. Machine load slows BOTH
 * measurements, so it largely cancels; what survives is the shape.
 *
 *   linear      2N costs ~2× N
 *   quadratic   2N costs ~4× N
 *
 * A ceiling between them separates the two robustly, and — unlike a stopwatch
 * — it actually fails when someone makes the algorithm quadratic on a fast
 * machine, which an absolute budget would happily pass.
 *
 * ⚠ SHARED MUTABLE STATE INVALIDATES THE RATIO
 * ---------------------------------------------
 * `work(n)` and `work(2n)` must start from the SAME state, or the ratio
 * measures accumulation instead of the algorithm.
 *
 * This is not hypothetical. FLAKE-1 used this helper on the FI-2 intelligence
 * pass, whose workload writes into module-level singleton stores. Each sample
 * left its data behind, so the 2n sample ran against a store holding
 * everything before it:
 *
 *   accumulating store   4.11×   → reported as "quadratic"
 *   isolated per sample  1.90×   → linear
 *
 * The finding was an artefact of the harness. `reset` exists so the next
 * caller does not repeat it, and it is REQUIRED to be passed explicitly when
 * the workload touches shared state — an omission that reads as a
 * conscientious default is how the first one happened.
 *
 * WHAT THIS DOES NOT REPLACE
 * --------------------------
 * A genuine latency SLO ("a chat turn must answer inside 2s") is a wall-clock
 * claim and should stay one. This is only for tests whose NAME already claims
 * a scaling property — where the stopwatch was a proxy, not the point.
 */

/**
 * Assert that doubling the input does not more than `maxRatio` the cost.
 *
 * @param {(n:number)=>unknown|Promise<unknown>} work  run the workload at size n
 * @param {object} [opts]
 * @param {number} [opts.n]         base size
 * @param {number} [opts.maxRatio]  2.5 sits between linear (2) and quadratic (4)
 * @param {number} [opts.floorMs]   below this, timer noise dominates and the
 *                                  ratio is meaningless — so the check is
 *                                  SKIPPED rather than asserted on noise
 * @param {number} [opts.samples]   best-of, to blunt a single unlucky slice
 */
export async function assertScalesLinearly(work, {
  n = 100, maxRatio = 2.5, floorMs = 15, samples = 3, label = 'workload',
  reset = null,
} = {}) {
  /** Run before EVERY sample, including the warm-up. See the header. */
  const fresh = async () => { if (reset) await reset(); };
  const bestOf = async (size) => {
    let best = Infinity;
    for (let i = 0; i < samples; i++) {
      await fresh();
      const t = performance.now();
      await work(size);
      best = Math.min(best, performance.now() - t);
    }
    return best;
  };

  // Warm up first: a cold first call measures module loading and JIT, not the
  // algorithm, and it would make the small size look artificially slow — which
  // flatters the ratio and hides a real regression.
  await fresh();
  await work(n);

  const small = await bestOf(n);
  const large = await bestOf(n * 2);

  if (small < floorMs) {
    // Honest skip. At single-digit milliseconds the ratio is dominated by
    // timer resolution and GC, and asserting on it would create the very flake
    // this helper exists to remove.
    return { skipped: true, reason: `base sample ${small.toFixed(1)}ms is below the ${floorMs}ms noise floor`, small, large };
  }

  const ratio = large / small;
  if (ratio > maxRatio) {
    throw new Error(
      `${label} does not scale linearly: doubling the input cost ${ratio.toFixed(2)}× ` +
      `(${small.toFixed(0)}ms → ${large.toFixed(0)}ms, ceiling ${maxRatio}×). ` +
      'Linear is ~2×, quadratic is ~4×.');
  }
  return { skipped: false, ratio, small, large };
}
