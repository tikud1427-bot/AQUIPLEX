/**
 * AQUA Eval — reproducibility manifest
 * Blueprint E2/PR-1
 *
 * Every run stamps what produced it: commit, node version, platform, suite
 * content hash, and the timestamp. Borrowed wholesale from AQEval's discipline
 * at `evaluation/` — a score without the conditions that produced it is not a
 * measurement, it is a rumour.
 *
 * THE MANIFEST IS EXCLUDED FROM COMPARISON, ON PURPOSE.
 * The report is split into a `manifest` (which changes every run — clock,
 * maybe commit) and a `result` (which must not). Two runs of the same commit
 * over the same suite produce a BYTE-IDENTICAL `result`. That is the property
 * a regression gate stands on: if `result` moved, behaviour moved, and nothing
 * else can explain it.
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Not a git checkout (a tarball apply, a CI export). Recorded honestly as
    // unknown rather than omitted — an absent field reads like an oversight,
    // and someone will later assume the run was on a known commit.
    return 'unknown';
  }
}

function gitDirty() {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length > 0;
  } catch {
    return null;
  }
}

/** Content hash of the cases — proves two runs graded the same dataset. */
export function suiteFingerprint(suite) {
  const material = JSON.stringify({
    id: suite.id,
    cases: suite.cases.map(c => c.id).sort(),
    count: suite.cases.length,
  });
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
}

export function buildManifest(suite, { extra = {} } = {}) {
  return {
    ranAt: new Date().toISOString(),
    commit: gitCommit(),
    dirty: gitDirty(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    suiteId: suite.id,
    suiteFingerprint: suiteFingerprint(suite),
    caseCount: suite.cases.length,
    ...extra,
  };
}
