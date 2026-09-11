/**
 * AQUA — User Understanding System (UUS) flags
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE flag for the whole sprint, deliberately.
 *
 * The platform already carries seven Brain flags and two PIC flags. Every one
 * of them was justified in isolation and the aggregate is now hard to reason
 * about — twice a stage has shipped dark because nothing reported its flag.
 * So UUS gets a single switch, and the sub-fixes ride on it.
 *
 * WHAT IS *NOT* BEHIND THIS FLAG
 * ------------------------------
 * The word-sense guard on tech terms and the compound-role pattern are BUG
 * FIXES, not features. A bug fix behind a flag is a bug that stays. They ship
 * unflagged and are pinned by tests instead.
 *
 * What IS behind it: anything that changes stored values for existing users —
 * currently the explicit-belief path (a stated fact jumping from inference
 * confidence to 0.9).
 *
 * Read at CALL time, never cached at module load, so tests and the flagproof
 * harness can flip it. Same idiom as pic/core.js consolidateEnabled().
 */

/** OFF unless exactly 'on'. */
export function uusEnabled() {
  return String(process.env.AQUA_UUS ?? '').toLowerCase() === 'on';
}
