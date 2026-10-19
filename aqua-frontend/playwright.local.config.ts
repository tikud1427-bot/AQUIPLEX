import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Runs the e2e specs signed in against a LOCAL server started with the real
 * launcher (see e2e/make-session.mjs). Same projects and specs as
 * playwright.config.ts; adds the stored session and the forwarded-proto header
 * the production-mode session cookie needs over plain http.
 *
 *   AQUA_E2E_BASE_URL=http://127.0.0.1:5055/aqua/ npx playwright test -c playwright.local.config.ts
 */
export default defineConfig({
  ...base,
  webServer: undefined,
  use: {
    ...base.use,
    baseURL: process.env.AQUA_E2E_BASE_URL ?? 'http://127.0.0.1:5055/aqua/',
    storageState: process.env.AQUA_E2E_STATE ?? 'e2e/.auth/state.json',
    extraHTTPHeaders: { 'X-Forwarded-Proto': 'https' },
  },
});
