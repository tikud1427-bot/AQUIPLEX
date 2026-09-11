// Test-only worker: never posts a result. Exercises the deadline.
setInterval(() => {}, 1 << 30);
