#!/usr/bin/env node
/**
 * AQUIPLEX production launcher.
 *
 * The HTTP platform and the cognition worker are separate processes by design:
 * the API must remain responsive while understanding/reflection/embedding work
 * drains durably from Postgres. A production deployment that starts only the
 * API silently disables the learning loop, so this launcher starts both.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const root = new URL('..', import.meta.url).pathname.replace(/\\/g, '/');
const children = new Map();

function start(name, command, args) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  children.set(name, child);
  child.on('exit', (code, signal) => {
    children.delete(name);
    console.error(`[PRODUCTION] ${name} exited code=${code ?? 'null'} signal=${signal ?? 'none'}`);
    if (name === 'server' && !shuttingDown) shutdown(code ?? 1);
  });
  child.on('error', err => {
    console.error(`[PRODUCTION] ${name} failed to start: ${err?.message ?? err}`);
    if (!shuttingDown) shutdown(1);
  });
  console.log(`[PRODUCTION] started ${name} pid=${child.pid}`);
  return child;
}

let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const [name, child] of children) {
    try {
      console.log(`[PRODUCTION] stopping ${name} pid=${child.pid}`);
      child.kill('SIGTERM');
    } catch {}
  }
  const timer = setTimeout(() => process.exit(code), 10_000);
  timer.unref();
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

start('server', process.execPath, ['index.js']);
start('worker', process.execPath, ['aqua/scripts/worker.mjs']);
