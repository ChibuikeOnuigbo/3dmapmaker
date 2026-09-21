/**
 * tools-render/modal-qa.mjs — studio choice modal, screenshot + geometry QA.
 *
 * Usage (any machine with Chromium):
 *   npm i -D playwright            # npx playwright install chromium
 *   node tools-render/modal-qa.mjs [baseUrl]
 *
 * The sandbox CI cannot download Chromium (CDN firewalled, NSS libs absent),
 * so this script is the reproducible QA record: it captures desktop/tablet/
 * mobile screenshots of the actual dialog AND measures every bounding box,
 * asserting the modal's spacing system numerically (per the design spec):
 *
 *   - uniform side padding on title / description / options / footer
 *   - equal heights and equal widths across all option rows
 *   - consistent vertical gaps between options
 *   - title, description, options, Cancel never touch the card edges
 *   - modal never touches the viewport edges at 430px and 1440px
 *
 * Output: qa/modal/{viewport}.png + bboxes.json + a pass/fail summary.
 */
import { mkdir, writeFile } from 'node:fs/promises';

const BASE = process.argv[2] ?? 'http://localhost:8080';
const OUT = new URL('../qa/modal/', import.meta.url).pathname;

const VIEWPORTS = [
  { name: 'desktop-1440', w: 1440, h: 900 },
  { name: 'tablet-768', w: 768, h: 1024 },
  { name: 'mobile-430', w: 430, h: 932 },
  { name: 'mobile-360', w: 360, h: 800 },
];

async function launch() {
  const { chromium } = await import('playwright');
  try {
    return await chromium.launch({ headless: true });
  } catch {
    // artifacts-only environments: fall back to the bundled binary package
    const sp = (await import('@sparticuz/chromium')).default;
    return await chromium.launch({
      headless: true,
      executablePath: await sp.executablePath(),
      args: sp.args,
    });
  }
}

const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

const browser = await launch();
await mkdir(OUT, { recursive: true });
const failures = [];

for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  // landing → demos page → first demo card → the studio choice dialog
  await page.click('[data-act="demos"]');
  await page.waitForSelector('.land-card', { timeout: 15000 });
  await page.click('.land-card');
  await page.waitForSelector('.land-pop .lp-opt', { timeout: 8000 });

  const boxes = await page.evaluate(async () => {
    const r = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom };
    };
    return {
      vw: innerWidth, vh: innerHeight,
      pop: r('.land-pop'), title: r('.land-pop h3'), desc: r('.land-pop p'),
      opts: [...document.querySelectorAll('.lp-opt')].map((el) => {
        const b = el.getBoundingClientRect();
        const icon = el.querySelector('.li').getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom, iconX: icon.x, iconW: icon.width };
      }),
      cancel: r('.lp-cancel'),
    };
  });

  await writeFile(`${OUT}${vp.name}.bboxes.json`, JSON.stringify(boxes, null, 2));
  await page.screenshot({ path: `${OUT}${vp.name}.png` });
  await page.screenshot({ path: `${OUT}${vp.name}-modal.png`, clip: boxes.pop });

  // ---- numeric assertions ----------------------------------------------
  const fail = (m) => failures.push(`${vp.name}: ${m}`);
  const M_L = boxes.title.x - boxes.pop.x;             // modal internal left pad
  const M_R = boxes.pop.right - boxes.title.right;     // right padding
  if (!near(M_L, M_R, 2)) fail(`head side padding asymmetric L${M_L.toFixed(1)} R${M_R.toFixed(1)}`);
  if (M_L < 16) fail(`crammed: title only ${M_L.toFixed(1)}px from card edge`);
  const hs = boxes.opts.map(o => o.h);
  if (!hs.every(h => near(h, hs[0]))) fail(`unequal option heights ${hs.join(', ')}`);
  const ws = boxes.opts.map(o => o.w);
  if (!ws.every(w => near(w, ws[0]))) fail(`unequal option widths ${ws.join(', ')}`);
  if (!(hs[0] >= 48 && hs[0] <= 56)) fail(`option height ${hs[0]} outside 48..56`);
  for (let i = 0; i < boxes.opts.length; i++) {
    const o = boxes.opts[i];
    if (!near(o.x - boxes.pop.x, M_L, 2)) fail(`option ${i} does not share head left padding`);
    if (!(o.iconX - o.x >= 14 && o.iconW >= 12)) fail(`option ${i} icon geometry off`);
  }
  for (let i = 1; i < boxes.opts.length; i++) {
    const gap = boxes.opts[i].y - boxes.opts[i - 1].bottom;
    if (!near(gap, 10, 2)) fail(`gap between options ${i - 1}/${i} is ${gap.toFixed(1)}, expected ~10`);
  }
  if (!(boxes.cancel.x > boxes.pop.x && boxes.cancel.bottom <= boxes.pop.bottom)) fail('cancel outside card');
  if (!(boxes.pop.x >= 12 && boxes.vw - boxes.pop.right >= 12)) fail('modal touches viewport edge');
  if (!(boxes.title.y - boxes.pop.y >= 18)) fail(`title hugs top of card (${(boxes.title.y - boxes.pop.y).toFixed(1)}px)`);
  if (!(boxes.desc.bottom - boxes.title.bottom >= 4)) fail('desc collides with title');
  if (!(boxes.opts[0].y - boxes.desc.bottom >= 14)) fail('first option too close to description');
  if (!(boxes.pop.bottom - boxes.cancel.bottom >= 10)) fail('cancel touches card bottom');

  await page.close();
  console.log(`✓ ${vp.name} captured`);
}

await browser.close();
if (failures.length) {
  console.error('\nMODAL QA FAILURES:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log(`\nMODAL QA GREEN — screenshots + geometry in ${OUT}`);
