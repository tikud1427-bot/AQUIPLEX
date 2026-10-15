#!/usr/bin/env node
/**
 * Activation / retention report from product events. READ-ONLY.
 *
 *   node scripts/activation-report.mjs --mongo <uri> [--days 120] [--json out.json]
 *
 * The Mongo URI must be passed explicitly (or ANALYTICS_MONGO_URI): this script
 * deliberately does NOT read .env, so it can never be pointed at production by
 * accident. It only runs find() on the productevents collection and prints
 * aggregate numbers — no user ids, no content.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mongoose = require('mongoose');
const ProductEvent = require('../models/ProductEvent');
const { computeActivation } = require('../services/analytics/activation');

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const uri = arg('--mongo') || process.env.ANALYTICS_MONGO_URI;
const days = Number(arg('--days') || 120);
const out = arg('--json');

if (!uri) {
  console.error('usage: node scripts/activation-report.mjs --mongo <uri> [--days N] [--json file]');
  process.exit(2);
}

await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
try {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const events = await ProductEvent.find({ at: { $gte: since } }, { _id: 0, userId: 1, event: 1, at: 1 }).lean();
  const report = { windowDays: days, events: events.length, ...computeActivation(events) };
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`events=${report.events} users=${report.users} window=${days}d`);
  console.table(report.cohorts);
  console.log('totals', report.totals);
} finally {
  await mongoose.disconnect();
}
