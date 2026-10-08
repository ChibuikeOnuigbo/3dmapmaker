/**
 * tools-render/get-browser.mjs — get a browser the harness can drive.
 *
 *   node tools-render/get-browser.mjs            install into tools-render/.browser
 *   node tools-render/get-browser.mjs --check    only report what is already there
 *
 * The world E2E harness (tools-render/world-e2e.mjs) needs two things:
 *
 *   playwright-core       the driver
 *   a chromium binary     the browser, plus its system libraries
 *
 * This script fetches both into `tools-render/.browser/` (git ignored, never
 * part of the app) so a fresh checkout can run the browser tests with one
 * command and no system packages:
 *
 *   node tools-render/get-browser.mjs
 *   node tools-render/world-e2e.mjs
 *
 * If you already have Chromium (or Chrome) on the machine, you do not need
 * this at all — point the harness straight at it:
 *
 *   PM_CHROMIUM=/usr/bin/chromium node tools-render/world-e2e.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BROWSER_DIR = path.join(HERE, '.browser');
export const MODULES_DIR = path.join(BROWSER_DIR, 'node_modules');
export const LIB_DIR = path.join(BROWSER_DIR, 'lib');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');

function report() {
  const out = { modules: fs.existsSync(MODULES_DIR), libs: fs.existsSync(LIB_DIR), chromium: null, note: null };
  const pw = path.join(MODULES_DIR, 'playwright-core');
  out.playwright = fs.existsSync(pw);
  const sparticuz = path.join(MODULES_DIR, '@sparticuz', 'chromium');
  if (fs.existsSync(sparticuz) && fs.existsSync(LIB_DIR)) out.chromium = 'sparticuz (bundled, libraries unpacked)';
  if (process.env.PM_CHROMIUM) out.chromium = process.env.PM_CHROMIUM + ' (from PM_CHROMIUM)';
  for (const guess of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']) {
    if (!out.chromium && fs.existsSync(guess)) out.chromium = guess + ' (system)';
  }
  const libs = ['libnss3.so', 'libnspr4.so'].map((n) => [n, findLib(n)]);
  out.systemLibs = Object.fromEntries(libs.map(([n, p]) => [n, p || 'not found']));
  return out;
}

/** Look for a shared library in the usual places (and in our own unpacked set). */
export function findLib(name) {
  const dirs = [LIB_DIR, '/usr/lib/x86_64-linux-gnu', '/usr/lib64', '/usr/lib', '/lib/x86_64-linux-gnu', path.join(os.homedir(), '.local/lib')];
  for (const d of dirs) {
    try {
      if (fs.existsSync(path.join(d, name))) return path.join(d, name);
      const hit = fs.readdirSync(d).find((f) => f.startsWith(name));
      if (hit) return path.join(d, hit);
    } catch { /* next */ }
  }
  return null;
}

/** The environment the harness needs to launch a bundled chromium. */
export function browserEnv() {
  const env = { ...process.env };
  if (fs.existsSync(LIB_DIR)) env.LD_LIBRARY_PATH = [LIB_DIR, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  env.FONTCONFIG_PATH ??= path.join(BROWSER_DIR, 'fonts');
  return env;
}

function run(cmd, cmdArgs, cwd) {
  console.log(`$ ${cmd} ${cmdArgs.join(' ')}`);
  execFileSync(cmd, cmdArgs, { cwd, stdio: 'inherit' });
}

export async function provision({ quiet = false } = {}) {
  const log = quiet ? () => {} : (m) => console.log(m);
  fs.mkdirSync(BROWSER_DIR, { recursive: true });
  if (!fs.existsSync(path.join(BROWSER_DIR, 'package.json'))) {
    fs.writeFileSync(path.join(BROWSER_DIR, 'package.json'),
      `${JSON.stringify({ name: 'panorama-maps-browser-tools', private: true, description: 'browser testing tools (git ignored)' }, null, 2)}\n`);
  }
  if (!fs.existsSync(path.join(MODULES_DIR, 'playwright-core')) || !fs.existsSync(path.join(MODULES_DIR, '@sparticuz', 'chromium'))) {
    log('• installing playwright-core + @sparticuz/chromium (one time, network required)…');
    run('npm', ['install', '--no-audit', '--no-fund', 'playwright-core', '@sparticuz/chromium'], BROWSER_DIR);
  } else {
    log('• browser tools already installed');
  }

  // the lambda build ships its own NSS/NSPR: unpack them next to the binary
  const libDir = LIB_DIR;
  const br = path.join(MODULES_DIR, '@sparticuz', 'chromium', 'bin', 'al2023.tar.br');
  if (fs.existsSync(br) && !fs.existsSync(path.join(libDir, 'libnss3.so'))) {
    log('• unpacking the browser’s own system libraries…');
    const { brotliDecompressSync } = await import('node:zlib');
    fs.mkdirSync(libDir, { recursive: true });
    const tar = path.join(BROWSER_DIR, 'al2023.tar');
    fs.writeFileSync(tar, brotliDecompressSync(fs.readFileSync(br)));
    run('tar', ['xf', tar, '-C', libDir, '--strip-components=1'], BROWSER_DIR);
    fs.rmSync(tar, { force: true });
  }
  return report();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (checkOnly) {
    console.log(JSON.stringify(report(), null, 2));
  } else {
    try {
      const out = await provision();
      console.log('\nready:');
      console.log(JSON.stringify(out, null, 2));
      console.log('\nnow run:  node tools-render/world-e2e.mjs');
    } catch (err) {
      console.error(`\ncould not provision a browser: ${err.message}`);
      console.error('If the machine has no network, use your own Chromium instead:');
      console.error('  PM_CHROMIUM=/path/to/chromium node tools-render/world-e2e.mjs');
      process.exit(1);
    }
  }
}
