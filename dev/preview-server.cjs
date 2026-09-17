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
  '/page.js': ['frappe_intelligence/frappe_intelligence/page/intelligence_chat/intelligence_chat.js', 'application/javascript; charset=utf-8']
};
/* Pinned contract fixtures for direct HTTP checks. The in-browser mock in dev/preview.js owns live preview state. */
const skillsFixture = {
  tools: [
    { name: 'search_records', description: 'Find records you can access.', mutates: false, external: false, version: '1', enabled: 1 },
    { name: 'create_todo', description: 'Create a private ToDo for yourself.', mutates: true, external: false, version: '2', enabled: 1 }
  ],
  scopes: { read: ['Customer', 'ToDo'], write: ['ToDo'] },
  never_allow: ['User', 'DocType'],
  learned_skills: [
    { name: 'skill-month-end-close', title: 'Month-end close helper', description: 'Guides the assistant through the fictional month-end checklist.', instructions: 'Summarize open ToDos before listing overdue invoices.', origin: 'Seeded', enabled: 1, shared: 1, version: 3, can_edit: 1, scope_read: 'ToDo\nSales Invoice', scope_write: 'ToDo' },
    { name: 'skill-supplier-follow-up', title: 'Supplier follow-up drafts', description: 'Drafts follow-up notes for late suppliers. Nothing is sent.', instructions: 'Draft a short note. Never send anything.', origin: 'Learned', enabled: 0, shared: 0, version: 1, can_edit: 1, scope_read: 'Supplier', scope_write: '' }
  ]
};
const api = {
  '/api/method/frappe_intelligence.api.skills': () => skillsFixture,
  '/api/method/frappe_intelligence.api.save_provider': (payload) => ({
    name: payload.name || 'provider-preview', title: payload.title || 'Preview provider', kind: payload.kind || 'OpenAI', model: payload.model || 'fixture-model',
    enabled: payload.enabled == null ? 1 : payload.enabled, is_shared: payload.is_shared || 0, thinking_effort: payload.thinking_effort || 'Auto', has_api_key: true, can_edit: true
  })
};
const port = Number(process.env.PORT || 8789);
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const fixture = api[pathname];
  if (fixture) {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      let payload = {};
      try { payload = body ? JSON.parse(body) : {}; } catch { payload = {}; }
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(JSON.stringify({ message: fixture(payload) }));
    });
    return;
  }
  const entry = files[pathname];
  if (!entry) { response.writeHead(404); response.end('Not found'); return; }
  response.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(path.join(root, entry[0])).pipe(response);
});
server.listen(port, '127.0.0.1', () => console.log(`Mock Intelligence preview: http://127.0.0.1:${port} - fixture data only; no live Frappe or provider calls.`));
process.on('SIGTERM', () => server.close());
