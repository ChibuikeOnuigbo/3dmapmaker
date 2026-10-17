/**
 * tools-render/static-serve.mjs — serve the app folder the way any static host
 * does (no API, no database). Used by the QA scripts to test the web build.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

export { MIME };

/* ---------------- static server (the web build, honestly) ---------------- */

export function serveStatic(dir, port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const abs = path.join(dir, rel);
    if (!abs.startsWith(dir) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' });
    fs.createReadStream(abs).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}`,
  })));
}

