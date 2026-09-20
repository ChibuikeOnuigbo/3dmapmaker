#!/usr/bin/env node
/**
 * scripts/run-qa.mjs — run the QA harness headlessly.
 *
 * The in-browser QA page (apps/web/src/qa/QaPage.tsx) is the human-facing
 * surface. This is the same checks driven from the command line so CI can fail
 * on them. It imports the real check registry rather than re-implementing it,
 * which means a check added to the page is automatically checked here too.
 *
 * Usage:
 *   node scripts/run-qa.mjs            run everything, exit non-zero on failure
 *   node scripts/run-qa.mjs --list     print the check inventory and exit 0
 *   node scripts/run-qa.mjs --json     machine-readable results on stdout
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));

/**
 * The checks live in the app's TS sources. Node cannot import them directly, so
 * they are executed through vitest, which already has the aliases, the jsdom
 * environment and the shims configured. A one-shot test file is generated and
 * pointed at the real registry.
 */
const checksPath = resolve(root, 'apps/web/src/qa/checks.ts');
if (!existsSync(checksPath)) {
  console.error(`Cannot find the QA registry at ${checksPath}`);
  process.exit(2);
}

if (args.has('--list')) {
  // The generated runner must sit inside vitest's include globs
  // (packages/*\/src, apps/web/src), so it goes next to the registry.
  const listPath = resolve(root, 'apps/web/src/qa/.headless-list.test.ts');
  await writeFileSafe(
    listPath,
    `import { describe, it } from 'vitest';
import { runHardeningChecks, CHECK_COUNT, KIND_COUNT } from './checks';
describe('qa inventory', () => {
  it('prints', () => {
    const checks = runHardeningChecks('list');
    console.log(\`QA CHECKS: \${CHECK_COUNT} across \${KIND_COUNT} kinds\`);
    for (const c of checks) console.log(\`  \${c.id}  \${c.name}\`);
    console.log(\`inventory length: \${checks.length}\`);
  });
});
`,
  );
  await runVitest(listPath);
  await rm(listPath);
  process.exit(0);
}

const runnerPath = resolve(root, 'apps/web/src/qa/.headless-run.test.tsx');
await writeFileSafe(
  runnerPath,
  `import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../App';
import { runHardeningChecks, runRegressionChecks, runAuditCheck, runMigrationCheck, CHECK_COUNT, KIND_COUNT } from './checks';

/**
 * Four checks (A11Y-003/004/006/010) refuse to guess: they return 'skip' when the
 * document is empty rather than reporting a pass they did not measure. Mounting
 * the real app before the run turns those into real measurements, so the headless
 * harness reports the same verdict the in-browser QA page does.
 *
 * Vite does not populate document.styleSheets for an imported CSS file under
 * jsdom, so the shipped stylesheet is injected explicitly — A11Y-006 walks
 * document.styleSheets for a prefers-reduced-motion rule and needs to see it.
 */
async function mountApp() {
  const css = readFileSync(resolvePath(process.cwd(), 'apps/web/src/styles/workbench.css'), 'utf8');
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<App />); });
  return () => { act(() => root.unmount()); container.remove(); };
}

describe('QA harness (headless)', () => {
  it('runs every registered check', async () => {
    const unmount = await mountApp();
    const hardening = await runHardeningChecks('run');
    const regression = await runRegressionChecks('run');
    const audit = await runAuditCheck();
    const migration = await runMigrationCheck();
    const all = [...hardening, ...regression, audit, migration];
    const failed = all.filter((c) => c.status === 'fail');
    const summary = {
      registered: CHECK_COUNT,
      kinds: KIND_COUNT,
      ran: all.length,
      passed: all.filter((c) => c.status === 'pass').length,
      // Reported separately: a skip means the check could not be measured in
      // this environment, which is not the same as a pass.
      skipped: all.filter((c) => c.status === 'skip').length,
      failed: failed.length,
      failures: failed.map((c) => ({ id: c.id, name: c.name, detail: c.detail })),
    };
    unmount();
    console.log('QA_RESULT ' + JSON.stringify(summary));
    expect(failed, JSON.stringify(summary.failures, null, 2)).toEqual([]);
  }, 120_000);
});
`,
);

const code = await runVitest(runnerPath);
await rm(runnerPath);
process.exit(code);

/* ------------------------------------------------------------- helpers --- */

async function writeFileSafe(path, contents) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, contents, 'utf8');
}

async function rm(path) {
  const { unlink } = await import('node:fs/promises');
  await unlink(path).catch(() => undefined);
}

async function runVitest(testPath) {
  const { spawn } = await import('node:child_process');
  const rel = testPath.slice(root.length + 1);
  return await new Promise((done) => {
    const child = spawn(
      process.execPath,
      [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', rel, '--reporter=basic'],
      { cwd: root, stdio: 'inherit' },
    );
    child.on('exit', (c) => done(c ?? 1));
    child.on('error', (err) => {
      console.error(`Failed to start vitest: ${err.message}`);
      done(2);
    });
  });
}
