/* Local-only mock preview host. This is not a Frappe server and never calls a provider. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const files = {
  '/': ['dev/preview.html', 'text/html; charset=utf-8'],
  '/preview.js': ['dev/preview.js', 'application/javascript; charset=utf-8'],
  '/assets/frappe_intelligence/js/intelligence.js': ['frappe_intelligence/public/js/intelligence.js', 'application/javascript; charset=utf-8'],
  '/assets/frappe_intelligence/css/intelligence.css': ['frappe_intelligence/public/css/intelligence.css', 'text/css; charset=utf-8'],
  '/page.js': ['frappe_intelligence/frappe_intelligence/page/intelligence-chat/intelligence-chat.js', 'application/javascript; charset=utf-8']
};
const port = Number(process.env.PORT || 8789);
const server = http.createServer((request, response) => {
  const entry = files[new URL(request.url, 'http://localhost').pathname];
  if (!entry) { response.writeHead(404); response.end('Not found'); return; }
  response.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(path.join(root, entry[0])).pipe(response);
});
server.listen(port, '127.0.0.1', () => console.log(`Mock Intelligence preview: http://127.0.0.1:${port} — fixture data only; no live Frappe or provider calls.`));
process.on('SIGTERM', () => server.close());
