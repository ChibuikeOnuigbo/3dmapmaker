#!/usr/bin/env node
/**
 * scripts/build-rust.mjs — build the native core and report honestly.
 *
 * The native core is a Cargo workspace under `crates/`. This script:
 *   1. locates a Rust toolchain (PATH, ~/.cargo/bin, ~/.rusttoolchain, or a
 *      RUSTUP_HOME/CARGO_HOME override),
 *   2. builds the workspace for the host target and for wasm32-unknown-unknown,
 *   3. runs `cargo test` when asked,
 *   4. prints the resulting binary/wasm paths and sizes.
 *
 * It never reports success it did not observe. If no toolchain is present, or
 * `crates/` has not been populated, it says so and exits non-zero — a missing
 * toolchain is a real, reportable state, not something to paper over.
 *
 * Usage:
 *   node scripts/build-rust.mjs            build host + wasm
 *   node scripts/build-rust.mjs --test     also run cargo test
 *   node scripts/build-rust.mjs --host     host target only (skip wasm)
 *   node scripts/build-rust.mjs --json     machine-readable report
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const runTests = args.has('--test');
const jsonOnly = args.has('--json');
const hostOnly = args.has('--host');

const WASM_TARGET = 'wasm32-unknown-unknown';

/* ------------------------------------------------------- toolchain lookup --- */

/** Candidate toolchain bin directories, best first. */
function toolchainDirs() {
  const dirs = [];
  if (process.env.CARGO_HOME) dirs.push(join(process.env.CARGO_HOME, 'bin'));
  if (process.env.RUST_TOOLCHAIN) dirs.push(join(process.env.RUST_TOOLCHAIN, 'bin'));
  dirs.push(join(homedir(), '.rusttoolchain', 'bin'));
  dirs.push(join(homedir(), '.cargo', 'bin'));
  return dirs;
}

/**
 * Find a directory that actually contains a runnable cargo. `command -v` alone
 * is not enough: a toolchain is often installed somewhere off PATH, and the
 * whole point of this script is to work in that situation.
 */
function locateToolchain() {
  for (const dir of toolchainDirs()) {
    if (existsSync(join(dir, 'cargo')) || existsSync(join(dir, 'cargo.exe'))) {
      const probe = spawnSync(join(dir, 'cargo'), ['--version'], { encoding: 'utf8' });
      if (probe.status === 0) return { dir, cargo: join(dir, 'cargo'), version: probe.stdout.trim() };
    }
  }
  const onPath = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
  if (onPath.status === 0) return { dir: null, cargo: 'cargo', version: onPath.stdout.trim() };
  return null;
}

/* --------------------------------------------------------- crate discovery --- */

/**
 * Every crate in the workspace that has a Cargo.toml, so a missing member is
 * reported by name rather than as a silent no-op build.
 */
function discoverCrates() {
  const cratesDir = join(root, 'crates');
  if (!existsSync(cratesDir)) return { cratesDir, crates: [], missing: true };
  const crates = [];
  for (const entry of readdirSync(cratesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(cratesDir, entry.name, 'Cargo.toml');
    if (existsSync(manifest)) crates.push({ name: entry.name, manifest });
  }
  return { cratesDir, crates, missing: false };
}

/* ------------------------------------------------------------------ build --- */

function cargo(toolchain, cargoArgs, { capture = false } = {}) {
  const env = { ...process.env };
  if (toolchain.dir) env.PATH = `${toolchain.dir}:${env.PATH ?? ''}`;
  const res = spawnSync(toolchain.cargo, cargoArgs, {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function listArtifacts(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    const full = join(dir, f);
    if (!statSync(full).isFile()) continue;
    if (!/\.(wasm|so|dylib|dll)$/.test(f) || /\.d$/.test(f)) continue;
    out.push({ file: f, bytes: statSync(full).size });
  }
  return out;
}

const report = {
  step: 'start',
  toolchain: null,
  workspace: null,
  targets: {},
  tests: null,
  ok: false,
};

const toolchain = locateToolchain();
const { cratesDir, crates, missing } = discoverCrates();

if (!toolchain) {
  report.step = 'toolchain-missing';
  report.ok = false;
  report.detail =
    'No Rust toolchain found. Searched: ' +
    [...toolchainDirs(), 'PATH'].join(', ') +
    '. Install rustup (https://rustup.rs) or set CARGO_HOME/RUST_TOOLCHAIN to an existing toolchain.';
} else {
  report.toolchain = { version: toolchain.version, bin: toolchain.dir ?? 'PATH' };
  report.workspace = {
    cratesDir: cratesDir.slice(root.length + 1),
    crates: crates.map((c) => c.name),
    populated: !missing && crates.length > 0,
  };

  if (missing || crates.length === 0) {
    report.step = 'workspace-empty';
    report.ok = false;
    report.detail = missing
      ? `crates/ does not exist at ${cratesDir}. The Cargo workspace has not been written yet, so there is nothing to build.`
      : `crates/ exists but contains no crate with a Cargo.toml.`;
  } else {
    let allOk = true;

    report.step = 'host-build';
    const host = cargo(toolchain, ['build', '--release']);
    report.targets.host = {
      ok: host.status === 0,
      artifacts: listArtifacts(join(root, 'target', 'release')),
    };
    allOk &&= host.status === 0;

    if (!hostOnly) {
      report.step = 'wasm-build';
      // There is no reliable dry-run for "is the target's std installed", so the
      // real build is attempted and the failure message is inspected. A missing
      // std component is a fixable toolchain gap, not a code defect, and is
      // reported as such rather than lumped in with compile errors.
      const wasm = cargo(toolchain, ['build', '--release', '--target', WASM_TARGET]);
      const wasmMissingStd = /can't find crate for `core`|wasm32-unknown-unknown.*(not installed|unrecognized)/i.test(
        wasm.stderr,
      );
      report.targets.wasm = {
        ok: wasm.status === 0,
        target: WASM_TARGET,
        missingStd: wasmMissingStd,
        artifacts: listArtifacts(join(root, 'target', WASM_TARGET, 'release')),
      };
      if (wasmMissingStd) {
        report.targets.wasm.note =
          `The ${WASM_TARGET} standard library is not installed. Run: rustup target add ${WASM_TARGET}`;
      }
      allOk &&= wasm.status === 0;
    }

    if (runTests) {
      report.step = 'test';
      const test = cargo(toolchain, ['test', '--release']);
      report.tests = { ok: test.status === 0 };
      allOk &&= test.status === 0;
    }

    report.step = 'done';
    report.ok = allOk;
  }
}

/* ----------------------------------------------------------------- output --- */

if (jsonOnly) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(report.ok ? 0 : 1);
}

console.log('3DMapMaker Next — native core build\n');

if (!toolchain) {
  console.log('TOOLCHAIN: not found');
  console.log(`  searched: ${[...toolchainDirs(), 'PATH'].join('\n            ')}`);
  console.log(`\n${report.detail}`);
  console.log('\nStatus: NOT BUILT — no toolchain. This is a report of the environment, not a build failure of the code.');
  process.exit(1);
}

console.log(`TOOLCHAIN: ${report.toolchain.version} (${report.toolchain.bin})`);
console.log(`WORKSPACE: ${report.workspace.cratesDir} — ${
  report.workspace.populated ? `${report.workspace.crates.length} crate(s): ${report.workspace.crates.join(', ')}` : 'not populated'
}`);

if (!report.workspace.populated) {
  console.log(`\n${report.detail}`);
  console.log('\nStatus: NOT BUILT — nothing to compile.');
  process.exit(1);
}

for (const [name, t] of Object.entries(report.targets)) {
  console.log(`\nTARGET ${name}: ${t.ok ? 'OK' : 'FAILED'}`);
  if (t.target) console.log(`  triple: ${t.target}`);
  for (const a of t.artifacts) console.log(`  ${a.file} — ${(a.bytes / 1024).toFixed(1)} KiB`);
  if (t.missingStd) console.log(`  ${t.note}`);
}

if (report.tests) console.log(`\nTESTS: ${report.tests.ok ? 'OK' : 'FAILED'}`);

console.log(`\nStatus: ${report.ok ? 'BUILD OK' : 'BUILD FAILED'}`);
process.exit(report.ok ? 0 : 1);
