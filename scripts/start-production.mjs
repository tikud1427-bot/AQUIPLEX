#!/usr/bin/env node
/**
 * AQUIPLEX platform production entrypoint. The canonical launcher (server +
 * cognition worker, each one's death stops the other) lives under aqua/scripts.
 * Kept as a shim so `npm run start:production` and deploy configs keep working.
 */
await import('../aqua/scripts/start-production.mjs');
