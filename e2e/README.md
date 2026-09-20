# E2E tests

**These tests have never been run.**

Playwright is installed (`@playwright/test` 1.49.1 resolves to 1.63.0), but the
browser binary cannot be downloaded in this environment:

```
$ npx playwright install chromium
Failed to install browsers
Error: Failed to download Chrome for Testing 153.0.8010.12 (playwright chromium v1243),
caused by: Error: Download failure, code=1
```

`~/.cache/ms-playwright` does not exist. Every spec here is written against real
selectors taken from the components — not invented — and is expected to pass once
a browser is available, but *expected* is not *verified*. No claim is made
anywhere in this repository that any of these has executed.

This distinction matters because of a standing rule on the project: **never claim
a browser test passed when only jsdom ran.**

## Why they exist anyway

The vitest suite runs under jsdom, which cannot observe:

- real rendered pixels (the 360° sphere has never been visually confirmed)
- actual layout, and therefore page-level horizontal overflow
- real focus and fullscreen behaviour
- a stylesheet that is actually attached and applied

Four QA checks report **skipped** rather than passed for exactly this reason —
`h1` count, live regions, `prefers-reduced-motion`, landmark regions. `e2e/a11y.spec.ts`
covers those four in a real browser, which is where they can actually be
measured.

## Specs

| File | Covers |
|---|---|
| `layout.spec.ts` | No page-level horizontal overflow on any route |
| `worlds.spec.ts` | The connected world: cards, SVG map, click-to-select, WASD via graph edge |
| `a11y.spec.ts` | The four checks that skip headlessly |
| `editor.spec.ts` | Editor boots; WebGL failure produces a visible error, not a blank canvas |

## Running them

```bash
npx playwright install chromium     # must succeed first — it does not here
npx playwright test
```

`playwright.config.ts` starts the dev server itself (`webServer.command`), so
`npm run dev` does not need to be running.
