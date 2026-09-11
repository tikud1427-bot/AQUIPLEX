// Test-only session worker: dies on the first request. Exercises the respawn
// path — a death must reject THAT request, not the whole batch.
import { parentPort } from 'node:worker_threads';
parentPort.on('message', () => process.exit(3));
