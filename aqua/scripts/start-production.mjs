#!/usr/bin/env node
/**
 * AQUIPLEX production launcher.
 *
 * The user-facing HTTP process is the platform root (../index.js). The
 * cognition worker is aqua/scripts/worker.mjs. They are intentionally separate
 * processes: HTTP answers requests; the worker owns durable learning.
 *
 * Starting only the web process creates a deceptively healthy deployment in
 * which Aqua answers but stops learning after the response. Starting both is
 * the production contract for the closed intelligence loop.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const AQUA_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const PLATFORM_ROOT = path.resolve(AQUA_ROOT, '..');
const children = new Map();
let stopping = false;

function start(name, script, cwd, args = []) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd,
    env: process.env,
    stdio: 'inherit',
  });
  children.set(name, child);
  child.on('exit', (code, signal) => {
    children.delete(name);
    if (stopping) return;
    console.error(`[PRODUCTION] ${name} exited code=${code ?? 'null'} signal=${signal ?? 'none'}`);
    // A dead cognition worker means the product can answer but cannot learn.
    // A dead HTTP process means the product is unavailable. Either condition
    // invalidates this combined launcher, so terminate the sibling too.
    shutdown(1);
  });
  child.on('error', err => {
    console.error(`[PRODUCTION] ${name} failed to start: ${err.message}`);
    shutdown(1);
  });
  console.log(`[PRODUCTION] started ${name} pid=${child.pid}`);
  return child;
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const [name, child] of children) {
    console.log(`[PRODUCTION] stopping ${name} pid=${child.pid}`);
    child.kill('SIGTERM');
  }
  const timer = setTimeout(() => process.exit(code), 10_000);
  timer.unref();
  if (!children.size) process.exit(code);
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

// The platform server is index.js at repository root; aqua/package.json's
// historical `server.js` entry is stale and must not be used for production.
start('server', path.join(PLATFORM_ROOT, 'index.js'), PLATFORM_ROOT);
start('worker', path.join(AQUA_ROOT, 'scripts', 'worker.mjs'), AQUA_ROOT);
