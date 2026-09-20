import { expect, test } from '@playwright/test';

/**
 * The editor workbench.
 *
 * The point of these is that a missing WebGL context must produce a visible,
 * actionable error rather than a blank canvas. Under jsdom WebGL is always null,
 * so that path is the one the component tests cover; here we confirm the
 * opposite case too — that a real browser actually gets a scene — and that the
 * chrome around it is real.
 */

test('the editor boots and shows the workbench chrome', async ({ page }) => {
  await page.goto('/#/editor');
  await page.waitForLoadState('networkidle');

  await expect(page.locator('header.app-header')).toBeVisible();
  await expect(page.locator('aside[aria-label="Content"]')).toBeVisible();
  await expect(page.locator('aside[aria-label="Properties"]')).toBeVisible();
});

test('either a live canvas or an actionable error — never a blank viewport', async ({ page }) => {
  await page.goto('/#/editor');
  await page.waitForLoadState('networkidle');

  const canvas = page.locator('canvas').first();
  const error = page.locator('.viewport-error').first();

  const hasCanvas = (await canvas.count()) > 0 && (await canvas.isVisible().catch(() => false));
  const hasError = (await error.count()) > 0 && (await error.isVisible().catch(() => false));

  expect(
    hasCanvas || hasError,
    'viewport rendered neither a canvas nor an error state',
  ).toBe(true);

  if (hasError) {
    // The error must be actionable: an alert role and real text, not a stub.
    await expect(error.locator('[role="alert"]').first()).toBeVisible();
    const text = ((await error.textContent()) ?? '').trim();
    expect(text.length, 'error banner has no message').toBeGreaterThan(10);
  } else {
    // A real browser should reach here. Confirm the canvas has non-zero size —
    // a 0×0 canvas is the classic silent failure.
    const box = await canvas.boundingBox();
    expect(box, 'canvas has no bounding box').not.toBeNull();
    expect(box!.width).toBeGreaterThan(100);
    expect(box!.height).toBeGreaterThan(100);
  }
});

test('panels open with real content', async ({ page }) => {
  await page.goto('/#/editor');
  await page.waitForLoadState('networkidle');

  // Panels are behind the left aside; open the layers panel and assert it has
  // actual rows rather than an empty shell.
  const layersButton = page.getByRole('button', { name: /layers/i }).first();
  if (await layersButton.count()) {
    await layersButton.click();
    await expect(page.getByTestId('layers-panel')).toBeVisible();
    expect((await page.getByTestId('layers-panel').textContent())?.length ?? 0).toBeGreaterThan(0);
  }
});

test('navigation controls respond', async ({ page }) => {
  await page.goto('/#/editor');
  await page.waitForLoadState('networkidle');

  const zoomIn = page.getByTestId('zoom-in');
  if (await zoomIn.count()) {
    await expect(zoomIn).toBeEnabled();
    await zoomIn.click();
    // The compass and scale bar must still be present and labelled afterwards.
    await expect(page.getByTestId('compass')).toBeVisible();
    await expect(page.getByTestId('scale-bar')).toHaveAttribute('aria-label', /scale/i);
  }
});

test('typing in a panel field does not trigger camera keys', async ({ page }) => {
  await page.goto('/#/editor');
  await page.waitForLoadState('networkidle');

  const field = page.locator('input[type="text"], input:not([type]), textarea').first();
  if (!(await field.count())) return;

  await field.focus();
  await page.keyboard.type('wasd');

  // The requirement is that WASD is never bound globally: the characters must
  // land in the field rather than moving the camera.
  await expect(field).toHaveValue(/wasd/i);
});

test('the QA page runs its checks in a real browser', async ({ page }) => {
  await page.goto('/#/qa');
  await page.waitForLoadState('networkidle');

  await expect(page.locator('.qa-page h1')).toHaveText('QA harness');
  await expect(page.locator('.qa-summary')).toBeVisible();

  // This is the route that makes the four skipped accessibility checks execute
  // for real, because the document is now mounted. Give the run time.
  const runButton = page.getByRole('button', { name: /run/i }).first();
  if (await runButton.count()) {
    await runButton.click();
    await page.waitForTimeout(15_000);
  }

  const summary = ((await page.locator('.qa-summary').textContent()) ?? '').trim();
  expect(summary.length, 'QA summary is empty').toBeGreaterThan(0);
  expect(summary, 'QA summary reports a failure').not.toMatch(/\bfail(ed|ure)?\s*[:\s]*[1-9]/i);
});
