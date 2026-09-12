import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Only these public design mockups are exposed on loopback; never serve the vault repo.
const root = path.dirname(fileURLToPath(import.meta.url));
const pages = new Set(['index.html', 'initial-comparison.html', '01-monolith.html', '02-quiet-vault.html', '03-atlas-network.html', 'mobile-app.html', 'orbit-globe.js', 'orbit-globe.css', 'web-premium.css']);
const port = 4178;
const server = http.createServer((req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
  const pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!pages.has(name)) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const bytes = fs.readFileSync(path.join(root, name));
    res.writeHead(200, {'Content-Type':name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch { res.writeHead(404); res.end('Design file not ready'); }
});
server.on('error', error => { console.error(`Preview server could not start: ${error.code}`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`KEYATLAS_DESIGN_PREVIEW http://127.0.0.1:${port}/`));
