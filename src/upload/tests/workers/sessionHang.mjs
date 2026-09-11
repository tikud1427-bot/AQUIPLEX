// Test-only session worker: accepts messages and never answers. Exercises the
// per-request deadline and the worker replacement that follows it.
import { parentPort } from 'node:worker_threads';
parentPort.on('message', () => { /* deliberately silent */ });
setInterval(() => {}, 1 << 30);
