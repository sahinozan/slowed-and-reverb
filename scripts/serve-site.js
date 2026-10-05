'use strict';

// Serves site/ locally the way Cloudflare serves it: pages at clean addresses
// (/guide serves guide.html, /guide.html redirects to /guide), 404.html with a
// 404 status for unknown addresses, and nothing listed in .assetsignore.
// Query strings are ignored, as they are for the version stamps.
//
//   npm run site:serve            http://localhost:8080
//   npm run site:serve -- 9000    another port

const fs = require('fs');
const http = require('http');
const path = require('path');

const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml'
});
const contentType = (file) => TYPES[path.extname(file)] || 'application/octet-stream';

const siteRoot = path.join(__dirname, '..', 'site');
const port = Number(process.argv[2]) || 8080;
const hidden = new Set(
  fs.readFileSync(path.join(siteRoot, '.assetsignore'), 'utf8')
    .split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
    .concat('.assetsignore', '_headers')
);

function fileFor(pathname) {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (relative.split('/').includes('..') || hidden.has(relative)) return null;
  for (const candidate of [relative, `${relative}.html`, path.join(relative, 'index.html')]) {
    const file = path.join(siteRoot, candidate);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return null;
}

function send(response, status, file) {
  response.writeHead(status, { 'content-type': contentType(file), 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(response);
}

http.createServer((request, response) => {
  const { pathname } = new URL(request.url, 'http://localhost');
  if (pathname.endsWith('.html')) {
    const clean = pathname.replace(/(index)?\.html$/, '');
    response.writeHead(307, { location: clean || '/' });
    response.end();
    return;
  }
  const file = fileFor(pathname);
  if (file) send(response, 200, file);
  else send(response, 404, path.join(siteRoot, '404.html'));
}).listen(port, '127.0.0.1', () => {
  console.log(`site/ at http://localhost:${port}`);
});
