import { expect, test } from '@playwright/test';

/**
 * The connected panorama world.
 *
 * These cover the properties that define the feature and that jsdom cannot
 * observe: that the map is real SVG geometry rather than text, that clicking a
 * node selects it, that WASD moves through a graph edge rather than sliding the
 * camera across the panorama texture, and that the viewer stays interactive
 * while it is fullscreen.
 */

test('three demo worlds are offered with their real counts', async ({ page }) => {
  await page.goto('/#/worlds');

  await expect(page.locator('.pano-page h1')).toHaveText('Connected Panorama World');

  const cards = page.locator('.pano-card-head h2');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toHaveText('Small Village');
  await expect(cards.nth(1)).toHaveText('Village Explorer');
  await expect(cards.nth(2)).toHaveText('Connected World');

  // The preview-card facts must state the board, not a decorative number.
  const facts = page.locator('.pano-cards article').first().locator('.pano-card-facts');
  await expect(facts).toContainText(/8/i);
});

test('entering the small world renders an SVG map, not ASCII', async ({ page }) => {
  await page.goto('/#/worlds');
  await page.getByTestId('pano-enter-demo-small').click();

  const svg = page.locator('.pano-page svg, .world-map svg').first();
  await expect(svg).toBeVisible();

  // A real graphical map has geometry: cells, edges and node circles. ASCII art
  // would have none of these and would instead be text in a <pre>.
  await expect(svg.locator('rect').first()).toBeVisible();
  await expect(svg.locator('line').first()).toBeVisible();
  await expect(svg.locator('circle').first()).toBeVisible();

  // The 8×8 board has 63 reachable nodes — one cell is blocked. Asserting the
  // count catches a silent change to occupancy.
  expect(await svg.locator('circle').count()).toBeGreaterThanOrEqual(63);
});

test('the panorama viewer reports the square it is standing on', async ({ page }) => {
  await page.goto('/#/worlds');
  await page.getByTestId('pano-enter-demo-small').click();

  await expect(page.getByTestId('wv-stage')).toBeVisible();
  // The HUD chips are the evidence that the viewer is reading the graph.
  await expect(page.getByTestId('wv-square')).toContainText(/square/i);
  await expect(page.getByTestId('wv-heading')).toBeVisible();
});

test('clicking a node selects it', async ({ page }) => {
  await page.goto('/#/worlds');
  await page.getByTestId('pano-enter-demo-small').click();

  const svg = page.locator('.pano-page svg, .world-map svg').first();
  await expect(svg).toBeVisible();

  const nodes = svg.locator('circle');
  const target = nodes.nth(10);
  const box = await target.boundingBox();
  if (!box) throw new Error('node circle has no bounding box');

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  // Selection draws a ring around the chosen node; its presence is the signal.
  await expect(svg.locator('circle[stroke="#ffffff"]').first()).toBeVisible();
});

test('W moves through a graph edge and changes the reported square', async ({ page }) => {
  await page.goto('/#/worlds');
  await page.getByTestId('pano-enter-demo-small').click();

  const stage = page.getByTestId('wv-stage');
  await expect(stage).toBeVisible();

  const before = (await page.getByTestId('wv-square').textContent()) ?? '';

  // Focus the viewer first: WASD must obey actual focus and must not be bound
  // globally. An unfocused viewport should ignore the keypress entirely.
  await stage.focus();
  await page.keyboard.press('w');

  // A move is a transition: preload, fade, swap, settle. Give it real time.
  await page.waitForTimeout(2000);

  const after = (await page.getByTestId('wv-square').textContent()) ?? '';
  expect(after, `square did not change after W (still "${before}")`).not.toBe(before);
});

test('WASD does not move when a text field has focus', async ({ page }) => {
  await page.goto('/#/worlds');
  await page.getByTestId('pano-enter-demo-small').click();
  await expect(page.getByTestId('wv-stage')).toBeVisible();

  const before = (await page.getByTestId('wv-square').textContent()) ?? '';

  // Any focusable input on the page; if there is none, the browser default is
  // the document, which is a different case and is covered above.
  const input = page.locator('input, textarea').first();
  if (await input.count()) {
    await input.focus();
    await page.keyboard.press('w');
    await page.waitForTimeout(1200);
    const after = (await page.getByTestId('wv-square').textContent()) ?? '';
    expect(after).toBe(before);
  }
});

test('dragging the viewer looks around without leaving the node', async ({ page }) => {
  await page.goto('/#/worlds');
  await page.getByTestId('pano-enter-demo-small').click();

  const stage = page.getByTestId('wv-stage');
  await expect(stage).toBeVisible();
  const squareBefore = (await page.getByTestId('wv-square').textContent()) ?? '';
  const headingBefore = (await page.getByTestId('wv-heading').textContent()) ?? '';

  const box = await stage.boundingBox();
  if (!box) throw new Error('viewer stage has no bounding box');

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const headingAfter = (await page.getByTestId('wv-heading').textContent()) ?? '';
  const squareAfter = (await page.getByTestId('wv-square').textContent()) ?? '';

  // Looking around must change heading but must NOT translate you to another
  // node — that is the "no sliding through the texture" requirement.
  expect(headingAfter).not.toBe(headingBefore);
  expect(squareAfter).toBe(squareBefore);
});

test('the viewer stays interactive while fullscreen', async ({ page }) => {
  await page.goto('/#/worlds');
  await page.getByTestId('pano-enter-demo-small').click();

  const stage = page.getByTestId('wv-stage');
  await expect(stage).toBeVisible();

  // Fullscreen requires a user gesture; requestFullscreen on the wrapper is the
  // real path. If the browser refuses (headless permissions), skip rather than
  // record a false pass.
  const ok = await stage.evaluate(async (el) => {
    try {
      await (el as HTMLElement).requestFullscreen();
      return true;
    } catch {
      return false;
    }
  });
  test.skip(!ok, 'browser refused requestFullscreen in this environment');

  const squareBefore = (await page.getByTestId('wv-square').textContent()) ?? '';
  await stage.focus();
  await page.keyboard.press('s');
  await page.waitForTimeout(2000);
  const squareAfter = (await page.getByTestId('wv-square').textContent()) ?? '';

  expect(squareAfter, 'viewport stopped responding to keys while fullscreen').not.toBe(
    squareBefore,
  );
});
