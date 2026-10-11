/**
 * Which database a TEST run may talk to.
 *
 * Only the one it was explicitly given: AQUA_TEST_DATABASE_URL. Otherwise
 * DATABASE_URL is forced to the empty string — present, so dotenv will not fill
 * it from a developer's `.env`, and empty, so `pool.isConfigured()` is false and
 * live-DB suites skip. See scripts/run-tests.mjs for the incident that made
 * this necessary (a battery writing jobs into a real database).
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{ DATABASE_URL: string }}
 */
export function testDatabaseEnv(env = {}) {
  const target = typeof env.AQUA_TEST_DATABASE_URL === 'string' ? env.AQUA_TEST_DATABASE_URL.trim() : '';
  return { DATABASE_URL: target };
}
