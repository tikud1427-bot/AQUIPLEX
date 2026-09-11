// Test-only worker: allocates V8-HEAP memory (arrays of strings), which
// resourceLimits DOES bound. Paired with hog.mjs to show the two halves.
const keep = [];
for (let i = 0; i < 60; i++) keep.push(new Array(1_000_000).fill('xxxxxxxx'));
