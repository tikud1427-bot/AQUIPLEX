/**
 * Symbol Graph tests — events, background jobs, embedded SQL.
 * Direct unit tests on buildSymbolGraph; every assertion is exact.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSymbolGraph, clearSymbolGraph,
  getEvents, getJobs, findEvents, getModels,
  serializeSymbolGraph, getSymbolGraphStats,
} from '../symbolGraph.js';

const js = (path, content) => ({ path, content, lang: 'javascript' });
const py = (path, content) => ({ path, content, lang: 'python' });
const build = (ws, files) => { clearSymbolGraph(ws); return buildSymbolGraph(ws, files); };

// ── Events ──────────────────────────────────────────────────────────────────
test('events: emit + listen captured with name, op, line', () => {
  const ws = 'e1';
  build(ws, [js('a.js', [
    "emitter.emit('user.created', user);",   // line 1  emit
    "emitter.on('user.created', handler);",   // line 2  listen
    "socket.once('disconnect', cb);",         // line 3  listen
  ].join('\n'))]);
  const ev = getEvents(ws);
  assert.equal(ev.length, 3);
  const emit = ev.find(e => e.op === 'emit');
  assert.equal(emit.name, 'user.created');
  assert.equal(emit.line, 1);
  assert.equal(ev.filter(e => e.op === 'listen').length, 2);
});

test('events: op classification (emit / listen / off)', () => {
  const ws = 'e2';
  build(ws, [js('a.js', [
    "x.emit('a');",
    "x.on('b');",
    "x.addListener('c');",
    "x.off('d');",
    "x.removeListener('e');",
  ].join('\n'))]);
  const byName = Object.fromEntries(getEvents(ws).map(e => [e.name, e.op]));
  assert.equal(byName.a, 'emit');
  assert.equal(byName.b, 'listen');
  assert.equal(byName.c, 'listen');
  assert.equal(byName.d, 'off');
  assert.equal(byName.e, 'off');
});

test('events in comments/strings are ignored; findEvents/getEvents(op) filter', () => {
  const ws = 'e3';
  build(ws, [js('a.js', [
    "// bus.emit('ghost');",
    "const s = \"bus.on('fake')\";",
    "bus.emit('order.paid');",
    "bus.on('order.paid');",
  ].join('\n'))]);
  assert.equal(getEvents(ws).length, 2, 'comment + string excluded');
  assert.equal(findEvents(ws, 'order').length, 2);
  assert.equal(getEvents(ws, 'emit').length, 1);
});

// ── Jobs ────────────────────────────────────────────────────────────────────
test('jobs: BullMQ queue/worker construction', () => {
  const ws = 'j1';
  build(ws, [js('q.js', [
    "const emails = new Queue('emails');",       // line 1
    "const w = new Worker('emails', handler);",  // line 2
  ].join('\n'))]);
  const jobs = getJobs(ws, 'queue');
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every(j => j.name === 'emails'));
  assert.equal(jobs.find(j => j.line === 1).name, 'emails');
});

test('jobs: .process and Queue.add handlers (Set.add not matched)', () => {
  const ws = 'j2';
  build(ws, [js('q.js', [
    "emailQueue.process('sendWelcome', fn);",  // bull
    "mailQueue.add('digest', data);",          // bull (receiver has 'queue')
    "mySet.add('notAJob');",                    // must NOT match
  ].join('\n'))]);
  const names = getJobs(ws, 'bull').map(j => j.name).sort();
  assert.deepEqual(names, ['digest', 'sendWelcome']);
  assert.ok(!getJobs(ws).some(j => j.name === 'notAJob'), 'Set.add is not a job');
});

test('jobs: agenda + cron + CronJob', () => {
  const ws = 'j3';
  build(ws, [js('s.js', [
    "agenda.define('cleanup', fn);",
    "cron.schedule('0 0 * * *', fn);",
    "const c = new CronJob('* * * * *', fn);",
  ].join('\n'))]);
  assert.equal(getJobs(ws, 'agenda').length, 1);
  assert.equal(getJobs(ws, 'cron').length, 2, 'cron.schedule + CronJob');
});

test('jobs: python celery task decorators', () => {
  const ws = 'j4';
  build(ws, [py('tasks.py', [
    "@shared_task",
    "def process_data(x):",
    "    return x",
    "@app.task(bind=True)",
    "def send_report(self):",
    "    pass",
  ].join('\n'))]);
  const names = getJobs(ws, 'celery').map(j => j.name).sort();
  assert.deepEqual(names, ['process_data', 'send_report']);
});

test('jobs in comments ignored', () => {
  const ws = 'j5';
  build(ws, [js('q.js', "// const x = new Queue('ghost');\nconst y = new Queue('real');")]);
  const jobs = getJobs(ws);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, 'real');
});

// ── Embedded SQL ──────────────────────────────────────────────────────────────
test('embedded SQL: CREATE TABLE inside a JS template string is detected', () => {
  const ws = 's1';
  build(ws, [js('db.js', "await db.query(`CREATE TABLE sessions (id INT PRIMARY KEY, tok TEXT)`);")]);
  const sql = getModels(ws, 'sql');
  assert.equal(sql.length, 1);
  assert.equal(sql[0].name, 'sessions');
});

// ── Serialize + stats ──────────────────────────────────────────────────────────
test('serialize + stats include events and jobs', () => {
  const ws = 'st1';
  build(ws, [js('a.js', [
    "bus.emit('a');",
    "const q = new Queue('emails');",
    "emailQueue.process('job1', fn);",
  ].join('\n'))]);
  const ser = serializeSymbolGraph(ws);
  assert.ok(Array.isArray(ser.events) && Array.isArray(ser.jobs));
  const s = getSymbolGraphStats(ws);
  assert.equal(s.events, 1);
  assert.equal(s.jobs, 2);
  assert.equal(s.byOp.emit, 1);
  assert.equal(s.byJobSystem.queue, 1);
  assert.equal(s.byJobSystem.bull, 1);
});
