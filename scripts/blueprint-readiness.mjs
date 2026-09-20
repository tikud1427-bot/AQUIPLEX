#!/usr/bin/env node
/**
 * AQUIPLEX Blueprint deployment readiness check.
 * This is intentionally a diagnostic, not a gate that pretends unmeasured
 * production behaviour is proven.
 */
const checks = [
  ['AQUA_BRAIN', process.env.AQUA_BRAIN !== 'off', 'Brain kill switch is active'],
  ['DATABASE_URL', !!process.env.DATABASE_URL, 'Postgres is configured'],
  ['AQUA_E6', process.env.AQUA_E6 === 'on', 'E6 understanding is enabled'],
  ['AQUA_E6_COMMIT', process.env.AQUA_E6_COMMIT === 'on', 'E6 canonical commit is enabled'],
  ['AQUA_CONTEXT_V2', process.env.AQUA_CONTEXT_V2 === 'on', 'E8 context engine is enabled'],
  ['AQUA_RETRIEVAL_V3', process.env.AQUA_RETRIEVAL_V3 === 'on', 'E7 retrieval V3 is enabled'],
  ['AQUA_CROSS_ENCODER', process.env.AQUA_CROSS_ENCODER === 'on', 'E7 cross-encoder is enabled'],
];
console.log('AQUIPLEX Blueprint readiness (configuration only)');
for (const [name, ok, text] of checks) console.log(`${ok ? '✓' : '·'} ${name}: ${ok ? text : 'not enabled'}`);
console.log('\nIMPORTANT: configuration readiness is not product proof. Run eval:gate and the World-Model Lift experiment before claiming production quality.');
