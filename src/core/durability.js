/**
 * AQUA — durability self-check.
 *
 * THE PROBLEM THIS EXISTS FOR
 * ---------------------------
 * AQUA has two independent ways to survive a redeploy, and until now nothing
 * checked whether EITHER of them was working:
 *
 *   1. The Mongo mirror — every store file copied to Atlas.
 *   2. AQUA_DATA_DIR pointing at a persistent mount (a Render disk).
 *
 * Either one alone is enough. With neither, the service runs perfectly, reports
 * healthy, and loses everything on the next deploy.
 *
 * The existing signal was one `warn()` at the moment of the first failed
 * write — once per process, buried among forty startup lines, and only
 * CONDITIONALLY true: it says data will not survive "until MONGO_URI is
 * reachable", which is wrong if the data directory is a mounted disk. Nobody
 * was told the second path exists.
 *
 * That matters more now than it did a week ago. The understanding work writes
 * far more per-owner state than anything before it — beliefs, goals, the world
 * model, the intro conversation — so a wipe now costs a user the three minutes
 * they spent teaching the product about themselves, which is the one thing it
 * promises not to waste.
 *
 * EPHEMERALITY IS PROVEN, NOT GUESSED
 * -----------------------------------
 * Path heuristics ("/tmp is ephemeral, /var/data probably isn't") are guesses,
 * and a guess printed as a verdict is how a health signal starts lying — the
 * exact failure the Jul 31 mirror work was about.
 *
 * So this measures instead. Every boot appends a record to a file INSIDE the
 * data directory. If that file comes back empty on a boot that is not the first
 * one, the directory did not survive — which is not an inference, it is an
 * observation. The verdict distinguishes "proven ephemeral" from "not yet
 * known", and says which it is.
 *
 * PURE CORE
 * ---------
 * `assessDurability` takes everything as arguments so the verdict logic can be
 * tested without a filesystem, a clock or a cluster. Only `recordBoot` touches
 * disk.
 */
import fs from 'node:fs';
import path from 'node:path';

const BOOT_LOG = '.aqua-boot-log.json';
const MAX_BOOTS = 20;

export const RISK = Object.freeze({
  SAFE: 'safe',
  UNPROVEN: 'unproven',
  AT_RISK: 'at_risk',
});

/**
 * Append this boot to the data directory's own record and return the history.
 *
 * Fail-open: if this cannot be written, durability is UNKNOWN, not broken, and
 * a diagnostic that crashes the boot it is diagnosing is worse than no
 * diagnostic.
 *
 * @returns {{ boots: number, firstSeenAt: number|null, writable: boolean }}
 */
export function recordBoot(dataDir, { now = Date.now(), fsImpl = fs } = {}) {
  const file = path.join(dataDir, BOOT_LOG);
  let history = [];
  try {
    history = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    if (!Array.isArray(history)) history = [];
  } catch { /* first boot, or the directory was replaced */ }

  history.push(now);
  if (history.length > MAX_BOOTS) history = history.slice(-MAX_BOOTS);

  try {
    fsImpl.writeFileSync(file, JSON.stringify(history));
  } catch {
    return { boots: history.length, firstSeenAt: history[0] ?? null, writable: false };
  }
  return { boots: history.length, firstSeenAt: history[0] ?? null, writable: true };
}

/**
 * The verdict. Pure.
 *
 * @param {object} args
 * @param {string} args.dataDir
 * @param {object} args.mirror        getMirrorStatus() output
 * @param {object} args.bootHistory   recordBoot() output
 * @param {number} [args.processUptimeS]
 * @returns {{ risk, safe, verdict, reasons: string[], actions: string[] }}
 */
export function assessDurability({ dataDir, mirror = {}, bootHistory = {}, restartCount = null } = {}) {
  const reasons = [];
  const actions = [];

  const mirrorDurable = mirror?.durable === true;
  const mirrorConfigured = mirror?.configured === true || mirror?.enabled === true;

  // ── Path 1: the mirror ────────────────────────────────────────────────────
  if (mirrorDurable) {
    reasons.push('the Mongo mirror is writing successfully');
  } else if (!mirrorConfigured) {
    reasons.push('no Mongo mirror is configured (MONGO_URI unset)');
    actions.push('Set MONGO_URI, or rely on a persistent disk — either is enough.');
  } else {
    reasons.push(`the Mongo mirror is not durable${mirror?.verdict ? ` (${mirror.verdict})` : ''}`);
    actions.push('Run `node scripts/mirror-doctor.mjs` on the server to see which layer is failing.');
  }

  // ── Path 2: the data directory ────────────────────────────────────────────
  // "Boots recorded > 1" means a previous boot's file was still there when this
  // one started: the directory survived at least one restart. That is evidence,
  // not a guess about the path.
  const boots = Number(bootHistory?.boots ?? 0);
  const dirWritable = bootHistory?.writable !== false;
  const survivedRestart = boots > 1;

  // A restart count from the platform (Render exposes none, but a caller may
  // pass one) turns "first boot" into "wiped" when it disagrees with the log.
  const knownWiped = Number.isFinite(restartCount) && restartCount > 0 && boots <= 1;

  if (!dirWritable) {
    reasons.push(`the data directory is not writable (${dataDir})`);
    actions.push(`Fix permissions on ${dataDir}, or set AQUA_DATA_DIR to a writable mount.`);
  } else if (knownWiped) {
    reasons.push('the data directory was empty on a boot that is not the first — it does NOT survive restarts');
    actions.push('Attach a persistent disk and point AQUA_DATA_DIR at its mount path.');
  } else if (survivedRestart) {
    reasons.push(`the data directory has survived ${boots - 1} restart(s)`);
  } else {
    reasons.push('the data directory has not yet survived a restart, so persistence is unproven');
    actions.push('Redeploy once and re-check: if the boot count resets to 1, the directory is ephemeral.');
  }

  const diskDurable = dirWritable && survivedRestart;

  // ── Verdict ───────────────────────────────────────────────────────────────
  // Either path alone is enough. This is the whole point of stating both: an
  // operator chasing an unreachable Atlas cluster may be one env var away from
  // being safe without it.
  let risk;
  let verdict;
  if (mirrorDurable || diskDurable) {
    risk = RISK.SAFE;
    verdict = mirrorDurable && diskDurable
      ? 'Durable — both the mirror and the data directory are holding.'
      : mirrorDurable
        ? 'Durable via the Mongo mirror.'
        : 'Durable via the data directory, which has survived a restart.';
  } else if (!dirWritable || knownWiped) {
    risk = RISK.AT_RISK;
    verdict = 'NOT DURABLE — a redeploy will lose every world model, memory and conversation.';
  } else {
    risk = RISK.UNPROVEN;
    verdict = 'Durability UNPROVEN — neither path has been shown to work yet.';
  }

  if (risk !== RISK.SAFE) {
    actions.push('Until one path is proven, treat this instance as scratch: do not ask real users to spend time teaching it.');
  }

  return { risk, safe: risk === RISK.SAFE, verdict, reasons, actions, dataDir, boots };
}

/** One block, formatted for a deploy log someone actually reads. */
export function formatDurabilityReport(assessment) {
  const bar = '─'.repeat(70);
  const head = assessment.safe ? '[DURABILITY] ok' : '[DURABILITY] ⚠⚠  ATTENTION';
  const lines = [
    '', bar, `${head}  —  ${assessment.verdict}`, bar,
    ...assessment.reasons.map(r => `  · ${r}`),
  ];
  if (assessment.actions.length) {
    lines.push('  what to do:');
    // Deduped: two failing paths often suggest the same action, and a repeated
    // instruction reads as noise rather than emphasis.
    lines.push(...[...new Set(assessment.actions)].map(a => `    → ${a}`));
  }
  lines.push(`  data dir: ${assessment.dataDir}  ·  boots recorded: ${assessment.boots}`);
  lines.push(bar, '');
  return lines.join('\n');
}
