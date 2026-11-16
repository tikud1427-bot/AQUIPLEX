/**
 * Spawn storeProcess.mjs children: each is one application process with its
 * own data directory, pg pool and in-memory stores (Phase 2b tests).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'storeProcess.mjs');

export const tempDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/**
 * The Phase 2b suites write the REAL store keys (.aqua-history.json, …) and
 * clean them between tests. The runner executes files in parallel, so two such
 * suites would wipe each other's rows. Each takes this session-level advisory
 * lock for its whole lifetime: they run one after another, everything else in
 * parallel. Returns the release function.
 */
export async function acquireStoreKeyLock(url = process.env.DATABASE_URL) {
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('SELECT pg_advisory_lock(84125311)');
  return async () => {
    try { await client.query('SELECT pg_advisory_unlock(84125311)'); } finally { await client.end(); }
  };
}

/**
 * @param {object} opts
 * @param {string} opts.dataDir      AQUA_DATA_DIR for this process
 * @param {string} [opts.partitions] AQUA_STORE_PARTITIONS
 * @param {boolean} [opts.database]  pass DATABASE_URL (default true)
 * @param {Array} ops
 * @returns {Promise<Array>} each op's result
 */
export function runProcess({ dataDir, partitions = '', database = true, env = {} }, ops) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, JSON.stringify(ops)], {
      env: {
        ...process.env,
        AQUA_DATA_DIR: dataDir,
        AQUA_STORE_PARTITIONS: partitions,
        DATABASE_URL: database ? process.env.DATABASE_URL : '',
        MONGO_URI: '',
        AQUA_DISABLE_MONGO_MIRROR: '1',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('exit', code => {
      const last = out.trim().split('\n').pop();
      try { resolve(Object.assign(JSON.parse(last), { stdout: out, stderr: err, code })); }
      catch { reject(new Error(`process exited ${code} without a result.\nstdout:\n${out}\nstderr:\n${err}`)); }
    });
  });
}
