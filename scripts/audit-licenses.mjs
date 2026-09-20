#!/usr/bin/env node
/**
 * scripts/audit-licenses.mjs — dependency licence audit.
 *
 * Walks the installed dependency tree, reads each package's own manifest, and
 * reports the licence it declares. Nothing here is a hardcoded list of expected
 * answers: the output is whatever the installed tree actually says, so a new
 * dependency shows up as "unknown" rather than being silently assumed permissive.
 *
 * Exits non-zero when a package declares a copyleft licence (which would change
 * what we may ship) or declares no licence at all (which means we have no
 * permission to redistribute it).
 *
 * Usage:
 *   node scripts/audit-licenses.mjs
 *   node scripts/audit-licenses.mjs --json
 *   node scripts/audit-licenses.mjs --allow-copyleft   do not fail on copyleft
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const jsonOnly = args.has('--json');
const allowCopyleft = args.has('--allow-copyleft');

/**
 * Licences that require derivative works to be shared under the same terms.
 * Listed by SPDX prefix because the tree contains both bare ids and `-only`/
 * `-or-later` suffixes (`GPL-3.0-only`, `AGPL-3.0-or-later`, …).
 */
const COPYLEFT_PREFIXES = ['AGPL', 'GPL', 'LGPL', 'MPL', 'EUPL', 'OSL', 'SSPL', 'CECILL', 'EPL', 'APSL', 'CPL', 'NPL', 'RPL', 'SPL', 'WTFPL'];
const PERMISSIVE_IDS = new Set([
  'MIT', 'MIT-0', 'Apache-2.0', 'Apache-1.1', 'BSD-2-Clause', 'BSD-3-Clause', 'BSD-3-Clause-Clear',
  'ISC', '0BSD', 'Unlicense', 'BlueOak-1.0.0', 'Zlib', 'Python-2.0', 'Artistic-2.0', 'AFL-2.1',
  'PostgreSQL', 'X11', 'Curl', 'JSON', 'ICU', 'NCSA', 'Fair', 'Sax-Pd',
]);
/** Attribution-only: free to redistribute provided credit is kept. */
const ATTRIBUTION_PREFIXES = ['CC-BY'];
const PUBLIC_DOMAIN = new Set(['CC0-1.0', 'Unlicense', 'WTFPL']);

const roots = [
  join(root, 'node_modules'),
  join(root, 'apps', 'web', 'node_modules'),
  ...['gis', 'project', 'layers', 'terrain', 'camera', 'input', 'panorama', 'scene-core', 'world', 'assets', 'physics', 'performance', 'tutorial', 'ui']
    .map((p) => join(root, 'packages', p, 'node_modules')),
];

/** Every `node_modules/<pkg>/package.json`, including scoped and nested trees. */
async function collectManifests(dir, seen, out, depth = 0) {
  if (!existsSync(dir) || depth > 6) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;

    if (entry.name.startsWith('@')) {
      await collectManifests(join(dir, entry.name), seen, out, depth + 1);
      continue;
    }
    // Nested node_modules belong to the package above them; recurse so a
    // duplicate at a different version is still reported.
    if (entry.name === 'node_modules') {
      await collectManifests(join(dir, entry.name), seen, out, depth + 1);
      continue;
    }
    const manifest = join(dir, entry.name, 'package.json');
    if (seen.has(manifest)) continue;
    seen.add(manifest);
    out.push(manifest);
  }
}

const seen = new Set();
const manifestPaths = [];
for (const r of roots) await collectManifests(r, seen, manifestPaths);

const packages = [];
for (const path of manifestPaths) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    continue;
  }
  const name = manifest.name ?? path;
  // Workspace packages are ours; they are not third-party dependencies.
  if (name.startsWith('@3dmm/')) continue;
  const declared = manifest.license ?? manifest.licenses ?? null;
  const id = normaliseLicense(declared);
  packages.push({
    name,
    version: manifest.version ?? 'unknown',
    license: id,
    classification: classify(id),
    private: manifest.private === true,
    path: path.slice(root.length + 1),
  });
}

function normaliseLicense(declared) {
  if (!declared) return null;
  if (typeof declared === 'string') return declared.trim();
  if (Array.isArray(declared)) {
    return declared.map((d) => (typeof d === 'string' ? d : d?.type ?? 'unknown')).join(' OR ');
  }
  return declared.type ?? null;
}

/**
 * Classify one bare SPDX identifier, with no expression operators.
 */
function classifyOne(id) {
  const bare = id.replace(/-(only|or-later)$/i, '').trim();
  const upper = bare.toUpperCase();
  if (PUBLIC_DOMAIN.has(bare)) return 'public-domain';
  if (PERMISSIVE_IDS.has(bare)) return 'permissive';
  if (ATTRIBUTION_PREFIXES.some((p) => upper.startsWith(p))) return 'attribution';
  if (COPYLEFT_PREFIXES.some((p) => upper.startsWith(p))) return 'copyleft';
  return 'unrecognised';
}

/**
 * Classify an SPDX expression. Real manifests use compound expressions —
 * `(MIT AND Zlib)`, `MIT AND BSD-3-Clause`, `(Apache-2.0 OR MIT)` — and a bare
 * string comparison misreports all of them as unrecognised. The obligation of
 * an expression is the strongest obligation of any term the licensee must
 * accept, so: any copyleft term makes it copyleft; otherwise an unrecognised
 * term is escalated (we cannot assess what we cannot read); otherwise
 * attribution outranks permissive.
 *
 * For `OR` the licensee may choose, so the weakest term governs — but npm
 * manifests almost never use OR, and treating it conservatively is the safe
 * reading for a shipping decision.
 */
function classify(id) {
  if (!id) return 'unknown';
  if (/SEE LICENSE IN/i.test(id)) return 'custom';
  const terms = id
    .replace(/[()]/g, ' ')
    .split(/\s+(?:AND|OR|WITH)\s+|\s+\|\s+/i)
    .map((t) => t.trim())
    .filter(Boolean);
  if (terms.length === 0) return 'unknown';
  const classes = terms.map(classifyOne);
  if (classes.includes('copyleft')) return 'copyleft';
  if (classes.includes('unrecognised')) return 'unrecognised';
  if (classes.includes('attribution')) return 'attribution';
  if (classes.every((c) => c === 'public-domain' || c === 'permissive')) {
    return classes.includes('permissive') ? 'permissive' : 'public-domain';
  }
  return 'unrecognised';
}

const byClassification = {};
for (const p of packages) {
  (byClassification[p.classification] ??= []).push(p);
}

const copyleft = byClassification.copyleft ?? [];
const unknown = byClassification.unknown ?? [];
const unrecognised = byClassification.unrecognised ?? [];
// Attribution-only licences are a real obligation but do not block shipping,
// so they are reported rather than failed on. Copyleft and no-licence-at-all do.
const attribution = byClassification.attribution ?? [];
const blocking = [...copyleft, ...unknown, ...unrecognised].filter((p) => !p.private);

const summary = {
  audited: packages.length,
  byClassification: Object.fromEntries(
    Object.entries(byClassification).map(([k, v]) => [k, v.length]),
  ),
  attention: blocking.map((p) => ({
    name: p.name,
    version: p.version,
    license: p.license ?? 'none declared',
    classification: p.classification,
  })),
  allowCopyleft,
};

if (jsonOnly) {
  process.stdout.write(JSON.stringify({ summary, packages }, null, 2) + '\n');
  process.exit(blocking.length === 0 || allowCopyleft ? 0 : 1);
}

const pad = (v, n) => String(v).padEnd(n);
const lpad = (v, n) => String(v).padStart(n);

console.log(`3DMapMaker Next — dependency licence audit`);
console.log(`${packages.length} installed packages inspected\n`);

for (const [classification, list] of Object.entries(byClassification).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${pad(classification, 14)}${lpad(list.length, 5)}   ${sample(list)}`);
}

if (attribution.length) {
  console.log(`\nAttribution required (${attribution.length}) — credit must be kept when redistributing:`);
  for (const p of attribution.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${pad(p.name, 38)}${pad(p.version, 14)}${p.license}`);
  }
}

if (blocking.length) {
  console.log(`\nNeeds a decision (${blocking.length}):`);
  console.log(`${pad('package', 40)}${pad('version', 14)}${pad('declared', 22)}class`);
  for (const p of blocking.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`${pad(p.name, 40)}${pad(p.version, 14)}${pad(p.license ?? 'none', 22)}${p.classification}`);
  }
}

console.log(
  `\n${copyleft.length} copyleft · ${attribution.length} attribution-only · ${unknown.length} no licence declared · ${unrecognised.length} unrecognised SPDX id`,
);
console.log('This report is derived from each package\'s own manifest at audit time;');
console.log('it is not legal advice, and a package with no declared licence is not');
console.log('therefore free to use — it means no permission to redistribute was given.');

const fail = blocking.length > 0 && !allowCopyleft;
if (fail) {
  console.log('\nFAIL — see the packages above.');
  process.exit(1);
}
console.log('\nOK');
process.exit(0);

function sample(list) {
  const names = list.map((p) => p.name).sort();
  const shown = names.slice(0, 6).join(', ');
  return names.length > 6 ? `${shown}, +${names.length - 6} more` : shown;
}
