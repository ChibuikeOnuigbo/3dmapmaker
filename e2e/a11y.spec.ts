import { expect, test } from '@playwright/test';

/**
 * The four QA checks that report SKIPPED in the headless harness.
 *
 * A11Y-003 (one h1), A11Y-004 (live regions), A11Y-006 (prefers-reduced-motion)
 * and A11Y-010 (landmark regions) all inspect the live document. Nothing is
 * mounted when the registry runs under jsdom, so they skip rather than report a
 * false pass or a false failure. This spec is where they can actually be
 * measured, in a real browser with a real stylesheet attached.
 */

test('A11Y-003 — every route has exactly one h1', async ({ page }) => {
  for (const route of ['/', '/#/editor', '/#/tutorial', '/#/qa', '/#/worlds']) {
    await page.goto(route);
    await page.waitForLoadState('networkidle');
    const count = await page.locator('h1').count();
    expect(count, `${route} has ${count} h1 elements`).toBe(1);
  }
});

test('A11Y-004 — live regions exist to announce state changes', async ({ page }) => {
  await page.goto('/#/editor');
  await page.waitForLoadState('networkidle');

  const live = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll('[aria-live], [role="status"], [role="alert"]'),
    );
    return nodes.map((n) => ({
      live: n.getAttribute('aria-live'),
      role: n.getAttribute('role'),
      tag: n.tagName.toLowerCase(),
    }));
  });

  expect(live.length, 'no aria-live / role=status / role=alert region found').toBeGreaterThan(0);
  // At least one must be assertive enough to interrupt for errors.
  expect(
    live.some((l) => l.role === 'alert' || l.live === 'assertive'),
    'no assertive live region for errors',
  ).toBe(true);
});

test('A11Y-006 — prefers-reduced-motion is honoured', async ({ browser }) => {
  // A real emulation of the OS-level preference, not a guess about the CSS.
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/#/editor');
  await page.waitForLoadState('networkidle');

  const durations = await page.evaluate(() => {
    const sample = Array.from(document.querySelectorAll('body *')).slice(0, 300);
    return sample.map((el) => {
      const cs = getComputedStyle(el);
      return {
        animation: parseFloat(cs.animationDuration) || 0,
        transition: parseFloat(cs.transitionDuration) || 0,
      };
    });
  });

  const longest = durations.reduce(
    (max, d) => Math.max(max, d.animation, d.transition),
    0,
  );
  // The stylesheet clamps both to 0.001ms !important under the media query.
  expect(longest, `longest animation/transition is ${longest}s under reduced motion`).toBeLessThan(
    0.01,
  );

  await context.close();
});

test('A11Y-010 — landmark regions exist in the workbench', async ({ page }) => {
  await page.goto('/#/editor');
  await page.waitForLoadState('networkidle');

  const landmarks = await page.evaluate(() => ({
    header: document.querySelectorAll('header').length,
    nav: document.querySelectorAll('nav').length,
    main: document.querySelectorAll('main').length,
    aside: document.querySelectorAll('aside').length,
    footer: document.querySelectorAll('footer').length,
    // ARIA roles count as landmarks too.
    roleMain: document.querySelectorAll('[role="main"]').length,
    roleNav: document.querySelectorAll('[role="navigation"]').length,
  }));

  const total =
    landmarks.header + landmarks.nav + landmarks.main + landmarks.aside + landmarks.footer +
    landmarks.roleMain + landmarks.roleNav;

  expect(total, `found only ${total} landmarks: ${JSON.stringify(landmarks)}`).toBeGreaterThanOrEqual(3);
  expect(landmarks.header, 'no <header> landmark').toBeGreaterThan(0);
  expect(landmarks.aside, 'no <aside> landmark').toBeGreaterThan(0);
});

test('A11Y-010 — the panorama world has landmarks too', async ({ page }) => {
  await page.goto('/#/worlds');
  await page.waitForLoadState('networkidle');
  expect(await page.locator('.pano-head h1').count()).toBe(1);
  expect(await page.locator('header').count()).toBeGreaterThan(0);
});

test('the viewer stage is labelled and focusable', async ({ page }) => {
  await page.goto('/#/worlds');
  await page.getByTestId('pano-enter-demo-small').click();

  const stage = page.getByTestId('wv-stage');
  await expect(stage).toHaveAttribute('role', 'application');
  await expect(stage).toHaveAttribute('tabindex', '0');
  await expect(stage).toHaveAttribute('aria-label', /panorama viewer/i);
});
