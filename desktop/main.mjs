#!/usr/bin/env node
/**
 * Panorama Maps — desktop/main.mjs
 *
 * Double-click launcher. Starts the desktop app (database + app server) and
 * opens it in the default browser. One process, one port, no install.
 *
 *   node desktop/main.mjs                 Linux · macOS · Windows
 *   node desktop/main.mjs --port 8080     pick the port
 *   node desktop/main.mjs --no-open       do not open a browser
 *   node desktop/main.mjs --host 0.0.0.0  reachable from other devices
 *   node desktop/main.mjs --data-dir DIR  where worlds are kept
 *
 * Ctrl+C stops the app (the database is closed cleanly).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDesktopApp, openInBrowser, APP_ROOT } from './server.mjs';
import { defaultDataDir } from './db.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { open: true, port: null, host: null, dataDir: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-open') out.open = false;
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--data-dir') out.dataDir = path.resolve(argv[++i]);
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Panorama Maps — desktop

  node desktop/main.mjs [--port 7654] [--host 127.0.0.1] [--no-open] [--data-dir DIR]

  Worlds and their images are kept in the desktop database:
    ${defaultDataDir()}
`);
  process.exit(0);
}

const BANNER = `
  Panorama Maps — desktop
  ────────────────────────────────────────────────
   worlds database : %DIR%
   app files       : %ROOT%
`;

try {
  const { url, port, app } = await startDesktopApp({
    port: args.port || Number(process.env.PM_PORT) || 7654,
    host: args.host || process.env.PM_HOST || '127.0.0.1',
    dataDir: args.dataDir || defaultDataDir(),
    quiet: args.quiet,
  });

  const stats = app.db.stats();
  if (!args.quiet) {
    console.log(BANNER.replace('%DIR%', `${stats.path} (${stats.engine})`).replace('%ROOT%', APP_ROOT));
    console.log(`   storage         : ${stats.worlds} world(s) · ${stats.assets} image(s) · ${(stats.assetBytes / 1048576).toFixed(1)} MB`);
    console.log(`   open at         : ${url}`);
    console.log(`   stop with       : Ctrl+C\n`);
  }
  if (args.open) {
    const ok = await openInBrowser(url);
    if (!ok && !args.quiet) console.log(`   (could not start a browser automatically — open ${url} yourself)\n`);
  }

  const shutdown = async () => {
    if (!args.quiet) console.log('\n  saving database and stopping…');
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (err) => { console.error('desktop app error:', err); });
} catch (err) {
  console.error(`\n  Panorama Maps desktop could not start: ${err.message}\n`);
  console.error('  Tip: Node 18 or newer is required (Node 22.5+ gives you the SQLite database).');
  process.exit(1);
}
