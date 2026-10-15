"use strict";
/**
 * Activation and retention from product events. Pure: events in, numbers out.
 *
 * DEFINITIONS (see PRODUCT_SCORECARD.md for why):
 *   cohort          ISO week (UTC, Monday start) of signup_completed.
 *   first chat      the first chat_turn after signup.
 *   gave context    an upload_completed or project_created within 7 days.
 *   ACTIVATED       chat turns on >= 2 distinct UTC days within 7 days of signup.
 *                   Aqua's promise (it keeps your project's current state across
 *                   sessions) can only be experienced in a SECOND session, so a
 *                   single busy first day does not count.
 *   retained wN     >= 1 chat turn in days [7N, 7N+7) after signup.
 *
 * A user is only counted in a rate once the window it needs has fully
 * elapsed ("eligible"); a 2-day-old account is neither activated nor not.
 */

const DAY = 24 * 3600 * 1000;

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7;            // Mon=0
  d.setUTCDate(d.getUTCDate() - dow + 3);         // Thursday of this week
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThu) / DAY - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const utcDay = (t) => Math.floor(t / DAY);
const rate = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);   // percent, 1 dp; null = no eligible users

/**
 * @param {Array<{userId:string, event:string, at:Date|string|number}>} events
 * @param {{ now?: Date|number }} [opts]
 */
function computeActivation(events, opts = {}) {
  const now = new Date(opts.now ?? Date.now()).getTime();
  const byUser = new Map();
  for (const e of events) {
    if (!e || !e.userId || !e.event) continue;
    const t = new Date(e.at).getTime();
    if (!Number.isFinite(t)) continue;
    if (!byUser.has(e.userId)) byUser.set(e.userId, []);
    byUser.get(e.userId).push({ event: e.event, t });
  }

  const cohorts = new Map();
  const cohort = (key) => {
    if (!cohorts.has(key)) {
      cohorts.set(key, {
        cohort: key, signups: 0, firstChat: 0, gaveContext: 0,
        eligible7d: 0, activated7d: 0, eligibleW1: 0, retainedW1: 0, eligibleW4: 0, retainedW4: 0,
        minutesToFirstChat: [],
      });
    }
    return cohorts.get(key);
  };

  let chatTurns = 0, corrections = 0, forgets = 0;
  for (const [, list] of byUser) {
    list.sort((a, b) => a.t - b.t);
    for (const e of list) {
      if (e.event === "chat_turn") chatTurns++;
      else if (e.event === "memory_corrected") corrections++;
      else if (e.event === "memory_forgotten") forgets++;
    }
    const signup = list.find((e) => e.event === "signup_completed");
    if (!signup) continue;                         // pre-instrumentation account: no cohort
    const s = signup.t;
    const c = cohort(isoWeek(new Date(s)));
    c.signups++;

    const chats = list.filter((e) => e.event === "chat_turn" && e.t >= s);
    if (chats.length) {
      c.firstChat++;
      c.minutesToFirstChat.push((chats[0].t - s) / 60000);
    }
    if (list.some((e) => (e.event === "upload_completed" || e.event === "project_created") && e.t >= s && e.t < s + 7 * DAY)) {
      c.gaveContext++;
    }
    if (now >= s + 7 * DAY) {
      c.eligible7d++;
      const days = new Set(chats.filter((e) => e.t < s + 7 * DAY).map((e) => utcDay(e.t)));
      if (days.size >= 2) c.activated7d++;
    }
    for (const [n, el, re] of [[1, "eligibleW1", "retainedW1"], [4, "eligibleW4", "retainedW4"]]) {
      const from = s + 7 * n * DAY, to = from + 7 * DAY;
      if (now < to) continue;
      c[el]++;
      if (chats.some((e) => e.t >= from && e.t < to)) c[re]++;
    }
  }

  const median = (xs) => {
    if (!xs.length) return null;
    const v = [...xs].sort((a, b) => a - b);
    const m = Math.floor(v.length / 2);
    return Math.round((v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2) * 10) / 10;
  };

  const rows = [...cohorts.values()].sort((a, b) => a.cohort.localeCompare(b.cohort)).map((c) => ({
    cohort: c.cohort,
    signups: c.signups,
    firstChatPct: rate(c.firstChat, c.signups),
    medianMinutesToFirstChat: median(c.minutesToFirstChat),
    gaveContextPct: rate(c.gaveContext, c.signups),
    activated7dPct: rate(c.activated7d, c.eligible7d),
    eligible7d: c.eligible7d,
    retainedW1Pct: rate(c.retainedW1, c.eligibleW1),
    eligibleW1: c.eligibleW1,
    retainedW4Pct: rate(c.retainedW4, c.eligibleW4),
    eligibleW4: c.eligibleW4,
  }));

  return {
    generatedAt: new Date(now).toISOString(),
    users: byUser.size,
    cohorts: rows,
    totals: {
      chatTurns, corrections, forgets,
      correctionsPer100Turns: chatTurns ? Math.round((10000 * corrections) / chatTurns) / 100 : null,
    },
  };
}

module.exports = { computeActivation, isoWeek };
