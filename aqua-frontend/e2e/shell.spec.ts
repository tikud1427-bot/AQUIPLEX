import { expect, test, type Page } from '@playwright/test';

/**
 * Shell regression coverage — NOT YET RUN. See playwright.config.ts.
 *
 * These need a signed-in session against a running backend; AQUA sits behind
 * `requireLogin` on /aqua. Point `AQUA_E2E_BASE_URL` at an environment where a
 * session exists, or add a storage-state step in CI. Everything is skipped
 * rather than failed when the app redirects to login, so an unauthenticated
 * run reports honestly instead of red.
 */

async function ensureSignedIn(page: Page) {
  // Relative to baseURL (/aqua/): an absolute '/' is the site root on the real
  // server (it redirects to the platform's /home), not the app.
  await page.goto('./');
  const composer = page.getByLabel('Message AQUA');
  const reachable = await composer.isVisible().catch(() => false);
  test.skip(!reachable, 'no authenticated session — set AQUA_E2E_BASE_URL');
}

async function expectNoHorizontalPageScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'the page itself must never scroll sideways').toBeLessThanOrEqual(1);
}

test.describe('smoke', () => {
  test('send a message, get an answer, reload, it is still there', async ({ page }) => {
    await ensureSignedIn(page);

    const composer = page.getByLabel('Message AQUA');
    await composer.fill('Give me a four column table of anything.');
    await page.getByRole('button', { name: 'Send message' }).click();

    // The live region publishes one sentence per turn — assert on that rather
    // than on token text, which is exactly what it exists to avoid.
    await expect(page.getByRole('status')).toContainText(/answering|Answer complete/i);
    await expect(page.getByRole('status')).toContainText('Answer complete.', { timeout: 120_000 });

    await expect(page).toHaveURL(/\/c\/[^/]+$/);
    const url = page.url();
    await page.reload();
    await expect(page).toHaveURL(url);
    await expect(page.locator('.message-row')).toHaveCount(2);
  });
});

test.describe('responsive shell', () => {
  test('no accidental horizontal scrolling anywhere in the shell', async ({ page }) => {
    await ensureSignedIn(page);
    await expectNoHorizontalPageScroll(page);
  });

  test('header controls survive a very long conversation title', async ({ page }) => {
    await ensureSignedIn(page);
    await page.evaluate(() => {
      const h1 = document.querySelector('header h1');
      if (h1) h1.textContent = 'A '.repeat(160) + 'title that has no business being this long';
    });
    // The title yields; the artifacts control stays inside the viewport.
    const artifacts = page.getByRole('button', { name: 'Open artifacts' });
    const box = await artifacts.boundingBox();
    const width = page.viewportSize()?.width ?? 0;
    expect(box, 'artifacts button must still be laid out').not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
    await expectNoHorizontalPageScroll(page);
  });
});

test.describe('mobile interaction', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 1280) >= 768, 'phone widths only');

  test('the sidebar drawer opens, traps focus, closes on Escape and restores focus', async ({ page }) => {
    await ensureSignedIn(page);
    const trigger = page.getByRole('button', { name: 'Open menu' });
    await trigger.click();

    const drawer = page.getByRole('dialog', { name: 'Conversations' });
    await expect(drawer).toBeVisible();
    await expect(page.getByLabel('Search conversations')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('the artifacts panel behaves like a modal too', async ({ page }) => {
    await ensureSignedIn(page);
    const trigger = page.getByRole('button', { name: 'Open artifacts' });
    await trigger.click();

    const panel = page.getByRole('dialog', { name: 'Artifacts' });
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('settings tabs are all reachable without scrolling the dialog sideways', async ({ page }) => {
    await ensureSignedIn(page);
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('button', { name: 'Settings' }).click();

    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();

    const overflow = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow, 'the dialog itself must not pan; the tab strip does').toBeLessThanOrEqual(1);

    for (const name of ['General', 'Memory', 'Account', 'Shortcuts', 'About']) {
      await dialog.getByRole('tab', { name }).click();
      await expect(dialog.getByRole('tab', { name })).toHaveAttribute('data-state', 'active');
    }
  });

  test('the composer stays above the keyboard and the send button is reachable', async ({ page }) => {
    await ensureSignedIn(page);
    const composer = page.getByLabel('Message AQUA');
    await composer.fill('hello');
    const send = page.getByRole('button', { name: 'Send message' });
    const box = await send.boundingBox();
    const vh = page.viewportSize()?.height ?? 0;
    expect(box).not.toBeNull();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(vh);
    await expectNoHorizontalPageScroll(page);
  });
});

test.describe('keyboard', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 1280) < 768, 'pointer widths only');

  test('the first tab stop skips the sidebar and lands on the conversation', async ({ page }) => {
    await ensureSignedIn(page);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to conversation' })).toBeFocused();
  });
});
