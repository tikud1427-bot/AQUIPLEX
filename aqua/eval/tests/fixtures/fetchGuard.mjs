// Preloaded with `node --import` by answerRunner.test.js: counts every fetch to a
// non-loopback host (and refuses it). On exit, writes the count to FETCH_GUARD_OUT.
import { writeFileSync } from 'node:fs';
const real = globalThis.fetch;
let external = 0;
globalThis.fetch = async (url, init) => {
  const u = new URL(typeof url === 'string' ? url : url.url);
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname)) {
    external++;
    throw new Error(`fetchGuard: external request refused (${u.hostname})`);
  }
  return real(url, init);
};
process.on('exit', () => { if (process.env.FETCH_GUARD_OUT) writeFileSync(process.env.FETCH_GUARD_OUT, String(external)); });
