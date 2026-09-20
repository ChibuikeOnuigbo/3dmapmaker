/**
 * The four accessibility checks that `scripts/run-qa.mjs` reports as *skipped*.
 *
 * A11Y-003 (one h1), A11Y-004 (live regions), A11Y-006 (reduced motion) and
 * A11Y-010 (landmarks) all bail out when nothing is mounted, because the QA
 * harness runs them against an empty document. That was honest — the harness
 * said "skipped" rather than "passed" — but a skip is not a pass, and four
 * accessibility requirements were effectively unverified.
 *
 * This file mounts the real `<App />` into a real jsdom document and runs the
 * *actual check functions* from `checks.ts`. Nothing here re-implements a check;
 * the same code the QA page runs is what runs here, so a regression in either
 * place shows up in both. Each assertion also requires the result to be a pass
 * and **not** a skip, so a guard quietly re-firing cannot be mistaken for
 * coverage.
 *
 * `e2e/a11y.spec.ts` covers the same ground in a real browser once one is
 * available; this is the in-process verification that runs today.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from '../App';
import { runHardeningChecks, type QaCheck } from './checks';

const CSS_PATH = resolve(process.cwd(), 'apps/web/src/styles/workbench.css');

/**
 * The four ids that skip in the headless harness.
 *
 * Listed explicitly rather than derived from the run output: if a fifth check
 * starts skipping, this file does not silently absorb it.
 */
const SKIPPED_IN_HARNESS = ['A11Y-003', 'A11Y-004', 'A11Y-006', 'A11Y-010'];

let container: HTMLElement;
let root: Root;
let results: QaCheck[];

/** Mount one route and collect the hardening results for it. */
async function collect(route: string): Promise<QaCheck[]> {
  window.location.hash = route;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<App />);
  });
  return (await runHardeningChecks('run')) as QaCheck[];
}

function check(results: QaCheck[], id: string): QaCheck {
  const found = results.find((r) => r.id === id);
  if (!found) throw new Error(`check ${id} did not run`);
  return found;
}

/**
 * Attach the real stylesheet.
 *
 * Vite does not populate `document.styleSheets` for an imported CSS file under
 * jsdom, so A11Y-006 — which walks `document.styleSheets` for a
 * `prefers-reduced-motion` media rule — cannot see the app's own CSS. Injecting
 * the actual file as a `<style>` element lets jsdom parse it for real, so the
 * check inspects the shipped stylesheet rather than a stub.
 */
function attachStylesheet(): void {
  const css = readFileSync(CSS_PATH, 'utf8');
  const style = document.createElement('style');
  style.setAttribute('data-qa', 'workbench');
  style.textContent = css;
  document.head.appendChild(style);
}

describe('the four accessibility checks that skip headlessly', () => {
  beforeEach(() => {
    attachStylesheet();
  });

  afterEach(() => {
    if (root) act(() => root.unmount());
    container?.remove();
    window.location.hash = '';
  });

  it('A11Y-003, A11Y-004, A11Y-006 and A11Y-010 all pass on the landing route', async () => {
    results = await collect('#/');

    for (const id of SKIPPED_IN_HARNESS) {
      const r = check(results, id);
      // Note: `status` is the only verdict field on QaCheck — there is no `ok`.
      // A skip is its own status, so asserting 'pass' rules out both skip and fail.
      expect(r.status, `${id} reported '${r.status}': ${r.detail}`).toBe('pass');
    }
  }, 30000);

  it('A11Y-003 finds exactly one h1 on every route', async () => {
    for (const route of ['#/', '#/worlds', '#/tutorial']) {
      results = await collect(route);
      const r = check(results, 'A11Y-003');
      expect(r.status, `${route}: ${r.detail}`).toBe('pass');
      expect(r.detail).toMatch(/one h1/);
      // tear down before the next mount
      act(() => root.unmount());
      container.remove();
    }
  }, 30000);

  it('A11Y-006 reads the real prefers-reduced-motion rule from the shipped CSS', async () => {
    results = await collect('#/');
    const r = check(results, 'A11Y-006');
    expect(r.status, `${r.status}: ${r.detail}`).toBe('pass');
    expect(r.detail).toMatch(/prefers-reduced-motion/);

    // Independent confirmation straight from the file, so the check cannot be
    // satisfied by a stylesheet jsdom happened to synthesise.
    const css = readFileSync(CSS_PATH, 'utf8');
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  }, 30000);

  it('the whole hardening suite is green once the app is mounted', async () => {
    results = await collect('#/');
    const skipped = results.filter((r) => r.status === 'skip');
    const failed = results.filter((r) => r.status === 'fail');

    // With the app mounted and the stylesheet attached there is nothing left for
    // these checks to be unable to see, so nothing should skip or fail.
    expect(skipped.map((r) => r.id), 'these checks should no longer skip').toEqual([]);
    expect(
      failed.map((r) => `${r.id}: ${r.detail}`),
    ).toEqual([]);
    expect(results.length).toBeGreaterThan(90);
  }, 30000);
});
