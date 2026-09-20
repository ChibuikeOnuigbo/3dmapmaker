import { expect, test } from '@playwright/test';

/**
 * No page-level horizontal overflow, on any route.
 *
 * This is a hard requirement and it is the one jsdom structurally cannot check:
 * it has no layout engine, so `scrollWidth` is meaningless there. Panels are
 * allowed to scroll internally — that is the intended design — but the document
 * itself must never scroll sideways.
 */
const ROUTES = ['/', '/#/editor', '/#/tutorial', '/#/qa', '/#/worlds'];

for (const route of ROUTES) {
  test(`no horizontal page overflow on ${route}`, async ({ page }) => {
    await page.goto(route);
    // Let fonts, the SVG map and any async demo build settle.
    await page.waitForLoadState('networkidle');

    const metrics = await page.evaluate(() => {
      const de = document.documentElement;
      return {
        scrollWidth: de.scrollWidth,
        clientWidth: de.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        // Anything wider than the viewport is a candidate culprit.
        offenders: Array.from(document.querySelectorAll('*'))
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.right > de.clientWidth + 1;
          })
          .slice(0, 10)
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            cls: (el as HTMLElement).className?.toString?.().slice(0, 60) ?? '',
            right: Math.round(el.getBoundingClientRect().right),
          })),
      };
    });

    // 1px tolerance for sub-pixel rounding at fractional device pixel ratios.
    expect(
      metrics.scrollWidth,
      `document scrolls horizontally by ${metrics.scrollWidth - metrics.clientWidth}px; offenders: ${JSON.stringify(metrics.offenders)}`,
    ).toBeLessThanOrEqual(metrics.clientWidth + 1);
  });
}

test('overflow stays absent when the window is narrow', async ({ page }) => {
  // A phone-width viewport is where panels are most likely to force the page wide.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/editor');
  await page.waitForLoadState('networkidle');

  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
});

test('a wide viewport does not stretch content past the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.goto('/#/worlds');
  await page.waitForLoadState('networkidle');

  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
});
