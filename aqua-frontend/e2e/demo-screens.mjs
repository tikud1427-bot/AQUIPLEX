// Screenshots of the Memory and Understanding pages for the demo check
// (DEMO_RUNBOOK.md): 1920×1080, signed in as the account the founder journey
// just created (aqua/scripts/e2e-founder-journey.mjs E2E_SESSION_OUT).
//
//   AQUA_E2E_ORIGIN=http://127.0.0.1:5055 node e2e/demo-screens.mjs <state.json> <outDir>
//
// Also fails (exit 1) if either page shows text the Task 2 leak list forbids.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const ORIGIN = process.env.AQUA_E2E_ORIGIN ?? 'http://127.0.0.1:5055';
const [state, outDir = '../demo/screens'] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const LEAKS = [/\bcustom_/i, /\b(?:simple[_\s]qa|personal[_\s]info|memory[_\s]recall)\b/i, /collection_merge/i, /Domain:/, /^\s*event\s*$/im];
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, storageState: state, extraHTTPHeaders: { 'X-Forwarded-Proto': 'https' } });
const page = await context.newPage();
let leaks = 0;
for (const [name, path, ready] of [['memory', '/aqua/memory', 'What AQUA remembers'], ['understanding', '/aqua/mind', 'A living model of you']]) {
  await page.goto(ORIGIN + path, { waitUntil: 'networkidle' });
  await page.getByText(ready, { exact: false }).first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);   // entrance animations settle
  await page.screenshot({ path: `${outDir}/${name}-1920x1080.png` });
  await page.screenshot({ path: `${outDir}/${name}-full.png`, fullPage: true });
  const text = await page.locator('body').innerText();
  const found = LEAKS.filter(re => re.test(text)).map(String);
  if (found.length) leaks++;
  console.log(`${name}: ${outDir}/${name}-1920x1080.png  leaks=${found.length ? found.join(' ') : 'none'}`);
}
await browser.close();
process.exit(leaks ? 1 : 0);
