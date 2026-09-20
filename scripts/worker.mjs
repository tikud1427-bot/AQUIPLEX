#!/usr/bin/env node
/** AQUIPLEX platform worker entrypoint. Canonical engine worker lives under aqua/scripts. */
await import('../aqua/scripts/worker.mjs');
