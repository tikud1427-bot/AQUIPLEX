// Test-only worker: allocates EXTERNAL memory (Buffers), which the V8 heap cap
// provably does not bound — see the probe recorded in AQUA_PARSE_ISOLATION.md.
// Exercises the RSS watchdog.
//
// The loop is BOUNDED (40 × 8 MB = 320 MB) and paced. Unbounded, a regression
// here would OOM-kill the whole test run instead of failing one assertion —
// which is exactly what happened the first time this file was written.
const keep = [];
for (let i = 0; i < 40; i++) {
  keep.push(Buffer.alloc(8 * 1024 * 1024, 1));
  await new Promise(r => setTimeout(r, 10));
}
