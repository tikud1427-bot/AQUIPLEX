import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The table regression, measured.
 *
 * NOT YET RUN — see the header of playwright.config.ts.
 *
 * `/dev/markdown` renders every fixture from src/test/fixtures/markdownTables.ts
 * inside the real message column. It is a DEV-only route, so this spec runs
 * against `npm run dev`, not a production build.
 *
 * The central assertion is `noCharacterShredding`. It is deliberately not a
 * screenshot: a pixel diff tells you something changed, this tells you WHAT
 * broke. It measures each word's rendered width against the width the same
 * word occupies unwrapped — if a word has been split across lines, its box is
 * narrower than its text, and that is the exact failure in the bug report.
 */

const CARD_BREAKPOINT_PX = 544; // 34rem — matches the container query in globals.css

async function gotoFixtures(page: Page) {
  await page.goto('./dev/markdown'); // relative to baseURL (/aqua/)
  await expect(page.locator('table.md-table').first()).toBeVisible();
}

/** True when the element's content box is narrower than one line of its text. */
async function isWrappedMidWord(el: Locator): Promise<boolean> {
  return el.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()];
    if (rects.length <= 1) return false;
    // More than one client rect means the text broke across lines. Only a
    // break INSIDE a word is a defect, so compare against the longest word.
    const words = (node.textContent ?? '').trim().split(/\s+/).filter(Boolean);
    if (words.length > 1) return false; // multi-word wrapping is normal
    return true; // single word occupying two lines = shredded
  });
}

async function expectNoHorizontalPageScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'the page itself must never scroll sideways').toBeLessThanOrEqual(1);
}

test.describe('markdown tables', () => {
  test('no word is broken across lines, at any viewport', async ({ page }) => {
    await gotoFixtures(page);

    // Wrap every word of every cell so each one can be measured on its own.
    await page.evaluate(() => {
      for (const cell of document.querySelectorAll('td, th')) {
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        const texts: Text[] = [];
        while (walker.nextNode()) texts.push(walker.currentNode as Text);
        for (const t of texts) {
          const parts = (t.textContent ?? '').split(/(\s+)/);
          const frag = document.createDocumentFragment();
          for (const part of parts) {
            if (!part.trim()) {
              frag.append(part);
              continue;
            }
            const span = document.createElement('span');
            span.dataset.word = '1';
            span.textContent = part;
            frag.append(span);
          }
          t.replaceWith(frag);
        }
      }
    });

    const words = page.locator('[data-word]');
    const count = await words.count();
    expect(count).toBeGreaterThan(50);

    const shredded: string[] = [];
    for (let i = 0; i < count; i++) {
      const w = words.nth(i);
      if (await isWrappedMidWord(w)) shredded.push(((await w.textContent()) ?? '').trim());
    }

    // The literal bug: "Cool" rendering as "Co / ol".
    expect(shredded, `words split across lines: ${shredded.join(', ')}`).toEqual([]);
  });

  test('the page never scrolls sideways', async ({ page }) => {
    await gotoFixtures(page);
    await expectNoHorizontalPageScroll(page);
  });

  test('prose tables become cards on narrow columns and stay tables on wide ones', async ({ page }, testInfo) => {
    await gotoFixtures(page);
    const stacked = page.locator('table.md-table[data-md-layout="stack"]').first();
    const firstRow = stacked.locator('tbody tr').first();
    const cellsPerLine = await firstRow.evaluate((tr) => {
      const tops = [...tr.querySelectorAll('td')].map((td) => Math.round(td.getBoundingClientRect().top));
      return new Set(tops).size;
    });
    const cellCount = await firstRow.locator('td').count();

    const width = testInfo.project.use.viewport?.width ?? 1280;
    if (width < CARD_BREAKPOINT_PX) {
      // Card mode: every cell on its own line.
      expect(cellsPerLine).toBe(cellCount);
      await expect(stacked.locator('thead')).toBeHidden();
    } else {
      // Table mode: the row is one line.
      expect(cellsPerLine).toBe(1);
    }
  });

  test('a dense grid keeps its grid and pans inside its own scroller', async ({ page }) => {
    await gotoFixtures(page);
    const scroller = page.locator('.md-table-scroller').filter({
      has: page.locator('table[data-md-layout="scroll"]'),
    });
    await expect(scroller).toHaveAttribute('tabindex', '0');
    await scroller.evaluate((el) => el.scrollBy({ left: 400 }));
    expect(await scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await expectNoHorizontalPageScroll(page);
  });

  test('the scrollable table is reachable by keyboard', async ({ page }) => {
    await gotoFixtures(page);
    const scroller = page.locator('.md-table-scroller[tabindex="0"]').first();
    await scroller.focus();
    await expect(scroller).toBeFocused();
  });

  test('no internal citation marker is visible to the reader', async ({ page }) => {
    await gotoFixtures(page);
    const text = (await page.locator('table.md-table').first().innerText()) ?? '';
    expect(text).not.toMatch(/【\s*\d/);
    expect(text).not.toMatch(/\[\s*\d+\s*\]/);
  });
});
