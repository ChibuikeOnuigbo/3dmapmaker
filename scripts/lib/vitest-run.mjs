/**
 * scripts/lib/vitest-run.mjs — shared plumbing for the CLI tools.
 *
 * The app's real logic lives in TypeScript under paths Node cannot import
 * directly. Rather than re-implementing any of it in plain JS (which would
 * benchmark or audit a copy rather than the shipped code), these scripts
 * generate a one-shot test file that imports the real modules and run it
 * through vitest, which already has the aliases and environment configured.
 *
 * The generated file must live inside vitest's include globs
 * (`packages/*\/src/**`, `apps/web/src/**`), so callers pass a path under one
 * of those trees and it is removed again afterwards.
 */
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';

export const repoRoot = resolve(import.meta.dirname, '..', '..');

/** Relative-to-root path vitest expects on its command line. */
export async function runGenerated(relPath, contents, { quiet = true } = {}) {
  const abs = resolve(repoRoot, relPath);
  await writeFile(abs, contents, 'utf8');
  try {
    return await spawnVitest(relPath, quiet);
  } finally {
    await unlink(abs).catch(() => undefined);
  }
}

function spawnVitest(relPath, quiet) {
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      [
        resolve(repoRoot, 'node_modules/vitest/vitest.mjs'),
        'run',
        relPath,
        quiet ? '--reporter=basic' : '--reporter=verbose',
      ],
      { cwd: repoRoot, stdio: 'inherit' },
    );
    child.on('exit', (code) => done(code ?? 1));
    child.on('error', (err) => {
      console.error(`Failed to start vitest: ${err.message}`);
      done(2);
    });
  });
}
