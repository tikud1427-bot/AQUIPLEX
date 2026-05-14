"use strict";
/**
 * utils/date/getISTDayRange.js
 * AQUIPLEX — IST (Asia/Kolkata, UTC+5:30) day boundary helpers.
 *
 * All daily reset logic MUST use these helpers to avoid UTC/local ambiguity.
 * India is UTC+5:30. A new calendar day starts at 00:00 IST = 18:30 UTC previous day.
 *
 * Exports:
 *   getISTDayRange()  → { start: Date, end: Date }   (UTC Date objects for Mongo queries)
 *   getISTDateStr()   → "YYYY-MM-DD" string in IST
 *   nextISTMidnight() → Date (UTC) of next IST midnight
 *
 * Usage:
 *   const { start, end } = getISTDayRange();
 *   User.find({ createdAt: { $gte: start, $lt: end } })
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 5h 30m in ms

/**
 * nowIST — current UTC time shifted to IST wall-clock.
 * This is a "fake" local Date; only use for arithmetic, not display.
 */
function nowIST() {
  return new Date(Date.now() + IST_OFFSET_MS);
}

/**
 * getISTDateStr — returns current date as "YYYY-MM-DD" in IST timezone.
 * Fixes User.js todayStr() which used UTC.
 */
function getISTDateStr() {
  return nowIST().toISOString().slice(0, 10); // "YYYY-MM-DD" in IST wall clock
}

/**
 * nextISTMidnight — returns the next IST midnight as a UTC Date.
 * Fixes User.js nextDayReset() which used server local time setHours(0,0,0,0).
 *
 * Algorithm:
 *   1. Get current IST wall-clock date
 *   2. Advance to tomorrow at 00:00 IST
 *   3. Convert back to UTC (subtract IST_OFFSET_MS)
 */
function nextISTMidnight() {
  const ist = nowIST(); // shifted to IST wall clock
  // Build tomorrow 00:00:00.000 IST (as if it were UTC)
  const tomorrowIST = new Date(Date.UTC(
    ist.getUTCFullYear(),
    ist.getUTCMonth(),
    ist.getUTCDate() + 1,
    0, 0, 0, 0
  ));
  // Convert IST wall-clock midnight → actual UTC
  return new Date(tomorrowIST.getTime() - IST_OFFSET_MS);
}

/**
 * getISTDayRange — start/end UTC boundaries for the current IST calendar day.
 *
 * start = today 00:00 IST in UTC
 * end   = tomorrow 00:00 IST in UTC  (exclusive upper bound)
 */
function getISTDayRange() {
  const ist = nowIST();

  // Today 00:00:00.000 IST → UTC
  const startIST = new Date(Date.UTC(
    ist.getUTCFullYear(),
    ist.getUTCMonth(),
    ist.getUTCDate(),
    0, 0, 0, 0
  ));
  const start = new Date(startIST.getTime() - IST_OFFSET_MS);

  // Tomorrow 00:00:00.000 IST → UTC
  const endIST = new Date(Date.UTC(
    ist.getUTCFullYear(),
    ist.getUTCMonth(),
    ist.getUTCDate() + 1,
    0, 0, 0, 0
  ));
  const end = new Date(endIST.getTime() - IST_OFFSET_MS);

  return { start, end };
}

module.exports = {
  getISTDayRange,
  getISTDateStr,
  nextISTMidnight,
};
