'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const client = require('../../frappe_intelligence/public/js/intelligence.js');
const { skillsHTML, queueHTML, scopeState, scopeProblem, scopeHTML, stamp } = client.utils;
const source = fs.readFileSync(path.resolve(__dirname, '../../frappe_intelligence/public/js/intelligence.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const copy = (value) => JSON.parse(JSON.stringify(value));
const boot = { enabled: true, is_manager: true, providers: [{ name: 'p1', title: 'Work', kind: 'OpenAI', model: 'configured-model' }], defaults: { max_upload_mb: 10 }, capabilities: { attachments: true, memory: true } };
const skillsFixture = {
  tools: [
    { name: 'search_records', description: 'Find records you can access.', mutates: false, external: false, version: '1' },
    { name: 'create_todo', description: 'Create a private ToDo for yourself.', mutates: true, external: false, version: '2' },
    { name: 'update_event', description: 'Reschedule an existing event.', mutates: true, external: false, version: '1' },
  ],
  scopes: { read: ['Customer', 'ToDo'], write: ['ToDo'] },
  never_allow: ['User', 'DocType'],
};
const settingsFixture = { name: 'Intelligence Settings', enabled_tools: 'search_records\ncreate_todo', allowed_read_doctypes: 'Customer\nToDo', allowed_write_doctypes: 'ToDo' };
const queueFixture = [
  { name: 'a1', conversation: 'c1', tool_name: 'create_todo', preview_json: JSON.stringify({ summary: 'Create a follow-up ToDo.', target: { doctype: 'ToDo' } }), status: 'pending', expires_at: '2026-09-18 14:05:00', creation: '2026-09-16 14:05:00' },
  { name: 'a2', conversation: 'c2', tool_name: 'read_document', preview_json: JSON.stringify({ summary: 'Read Customer C-001.', target: { doctype: 'Customer', name: 'C-001' } }), status: 'pending', expires_at: '', creation: '2026-09-17 09:30:00' },
];
function fixture() {
  return { conversation: { name: 'c1', title: 'Private chat', provider: 'p1', archived: 0 }, messages: [{ name: 'm1', role: 'user', content: 'Hello', status: 'complete' }], approvals: [], files: [], run: null };
}
function harness(t, override = {}) {
  const { JSDOM } = process.env.FI_REAL_DOM === '1' ? require('jsdom') : require('./dom-harness.cjs');
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'https://desk.example.test/app/intelligence', runScripts: 'outside-only', pretendToBeVisual: true });
  const window = dom.window; window.frappe = {};
  window.eval(source);
  const calls = [], snapshot = fixture();
  const api = async (method, args) => {
    calls.push({ method, args });
    if (override[method]) return override[method](args, snapshot);
    if (method === 'bootstrap') return copy(boot);
    if (method === 'list_conversations') return [copy(snapshot.conversation)];
    if (method === 'get_conversation') return copy(snapshot);
    throw new Error('Unmocked method ' + method);
  };
  const app = new window.frappe.intelligence.App({ api, document: window.document });
  window.document.querySelector('#host').appendChild(app.root);
  app.boot = copy(boot); app.provider = 'p1'; app.render();
  t.after(() => { app.poller.stop(); window.clearTimeout(app.searchTimer); dom.window.close(); });
  return { app, window, document: window.document, calls, snapshot };
}

test('skillsHTML lists tools, writes badges, scope chips and the never-allow note', () => {
  const html = skillsFixture && skillsHTML(skillsFixture);
  assert.ok(html.includes('search_records'));
  assert.ok(html.includes('Find records you can access.'));
  assert.equal(html.match(/fi-badge-writes/g).length, 2);
  assert.ok(html.includes('Customer') && html.includes('ToDo'));
  assert.ok(html.includes('Always off-limits'));
  assert.ok(html.includes('User') && html.includes('DocType'));
});
test('skillsHTML escapes hostile content and tolerates malformed payloads', () => {
  const hostile = skillsHTML({ tools: [{ name: '<img src=x>', description: '<script>alert(1)</script>', mutates: 0 }], scopes: { read: '<script>' }, never_allow: null });
  assert.ok(!hostile.includes('<img'));
  assert.ok(!hostile.includes('<script>'));
  assert.ok(hostile.includes('&lt;img'));
  const fallback = skillsHTML(null);
  assert.ok(fallback.includes('off-limits'));
  assert.ok(fallback.includes('No tools'));
});
test('queueHTML renders tool, target, summary and requested time per pending approval', () => {
  const html = queueHTML(queueFixture);
  assert.ok(html.includes('create_todo'));
  assert.ok(html.includes('Read Customer C-001.'));
  assert.ok(html.includes('Customer'));
  assert.ok(html.includes('C-001'));
  assert.ok(html.includes('Requested '));
  assert.ok(html.includes('data-action="queue-approve"'));
  assert.ok(html.includes('data-name="a2"'));
  assert.ok(html.includes('data-name="c2"'));
});
test('queueHTML escapes hostile previews and survives malformed rows', () => {
  const html = queueHTML([
    { name: 'a9', conversation: 'c9', tool_name: '<img src=x onerror=alert(1)>', preview_json: '{"summary":"<script>alert(2)</script>"}', status: 'pending', creation: '2026-09-17 10:00:00' },
    null,
    { name: '' },
    { name: 'a10', conversation: 'c1', tool_name: 'noop', preview_json: '{broken json', status: 'pending' },
  ]);
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('noop'));
  assert.ok(queueHTML('nope').includes('No pending approvals'));
  assert.ok(queueHTML([]).includes('No pending approvals'));
});
test('stamp renders a short date with time, or empty text for missing or invalid values', () => {
  assert.equal(stamp(''), '');
  assert.equal(stamp('not-a-date'), '');
  const date = new Date('2026-09-16T14:05:00');
  const expected = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  assert.equal(stamp('2026-09-16 14:05:00'), expected);
});
test('scopeState builds enabled flags and doctype lists from newline settings', () => {
  const state = scopeState(settingsFixture, skillsFixture);
  assert.deepEqual(state.read, ['Customer', 'ToDo']);
  assert.deepEqual(state.write, ['ToDo']);
  assert.deepEqual(state.never_allow, ['User', 'DocType']);
  assert.deepEqual(state.tools.map((tool) => [tool.name, tool.enabled]), [['search_records', true], ['create_todo', true], ['update_event', false]]);
  assert.deepEqual(scopeState(null, null), { tools: [], read: [], write: [], never_allow: [] });
});
test('scopeProblem enforces write-is-a-subset-of-read and the never-allow list', () => {
  const state = { tools: [], read: ['Customer', 'ToDo'], write: ['ToDo'], never_allow: ['User'] };
  assert.equal(scopeProblem(state), '');
  assert.ok(scopeProblem({ tools: [], read: ['Customer'], write: ['Supplier'], never_allow: [] }).includes('readable'));
  assert.ok(scopeProblem({ tools: [], read: ['Customer', 'User'], write: ['User'], never_allow: ['User'] }).includes('off-limits'));
});
test('scopeHTML hides editing affordances when read-only and shows them when editable', () => {
  const state = scopeState(settingsFixture, skillsFixture);
  assert.ok(!scopeHTML(state, { readOnly: true }).includes('data-action="scope-save"'));
  const editable = scopeHTML(state, {});
  assert.ok(editable.includes('data-action="scope-save"'));
  assert.ok(editable.includes('checked'));
});
test('request prefixes app API methods but passes absolute Frappe client methods through', (t) => {
  const { JSDOM } = require('./dom-harness.cjs');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const window = dom.window; const seen = [];
  window.frappe = { call: (options) => { seen.push(options.method); return { catch: () => {} }; } };
  window.eval(source);
  window.frappe.intelligence.request('skills');
  window.frappe.intelligence.request('frappe.client.get_list', { doctype: 'Intelligence Approval' });
  assert.deepEqual(seen, ['frappe_intelligence.api.skills', 'frappe.client.get_list']);
  t.after(() => dom.window.close());
});
test('sidebar exposes skills, approvals and scope entries', (t) => {
  const { app } = harness(t);
  for (const action of ['approvals', 'skills', 'scope']) assert.ok(app.$('[data-action="' + action + '"]'), action);
});
test('skills dialog fetches the pinned contract and renders tools, scopes and the off-limits note', async (t) => {
  const { app, document } = harness(t, { skills: () => copy(skillsFixture) });
  app.skillsDialog(); await tick();
  const modal = document.querySelector('.fi-modal-overlay');
  assert.ok(modal.textContent.includes('search_records'));
  assert.ok(modal.textContent.includes('Create a private ToDo for yourself.'));
  assert.equal(modal.querySelectorAll('.fi-badge-writes').length, 2);
  assert.ok(modal.textContent.includes('Customer'));
  assert.ok(modal.textContent.includes('Always off-limits'));
});
test('skills dialog shows an inline error on fetch failure and retries in place', async (t) => {
  let failures = 1;
  const { app, document } = harness(t, { skills: () => { if (failures--) throw { userMessage: 'Skills endpoint unavailable.' }; return copy(skillsFixture); } });
  app.skillsDialog(); await tick();
  const modal = document.querySelector('.fi-modal-overlay');
  assert.ok(modal.querySelector('.fi-inline-error').textContent.includes('Skills endpoint unavailable.'));
  modal.querySelector('[data-action="skills-retry"]').click(); await tick();
  assert.ok(modal.textContent.includes('search_records'));
  assert.equal(modal.querySelector('.fi-inline-error'), null);
});
test('approval queue lists pending approvals across conversations and approves through the existing endpoint', async (t) => {
  const { app, document, calls } = harness(t, { 'frappe.client.get_list': () => copy(queueFixture), approve: () => ({}) });
  app.approvalsDialog(); await tick();
  const modal = document.querySelector('.fi-modal-overlay');
  assert.ok(modal.textContent.includes('create_todo'));
  assert.ok(modal.textContent.includes('Read Customer C-001.'));
  Array.from(modal.querySelectorAll('[data-action="queue-approve"]')).find((node) => node.dataset.name === 'a2').click();
  await tick();
  const decision = calls.find((call) => call.method === 'approve');
  assert.deepEqual(copy(decision.args), { approval: 'a2', decision: 'approve' });
  assert.equal(calls.filter((call) => call.method === 'frappe.client.get_list').length, 2);
});
test('approval queue deny uses the exact inline decision contract', async (t) => {
  const { app, document, calls } = harness(t, { 'frappe.client.get_list': () => copy(queueFixture), approve: () => ({}) });
  app.approvalsDialog(); await tick();
  const modal = document.querySelector('.fi-modal-overlay');
  Array.from(modal.querySelectorAll('[data-action="queue-deny"]')).find((node) => node.dataset.name === 'a1').click();
  await tick();
  const decision = calls.find((call) => call.method === 'approve');
  assert.deepEqual(copy(decision.args), { approval: 'a1', decision: 'deny' });
});
test('approval queue can jump into the owning conversation', async (t) => {
  const { app, document } = harness(t, { 'frappe.client.get_list': () => copy(queueFixture) });
  app.approvalsDialog(); await tick();
  const modal = document.querySelector('.fi-modal-overlay');
  Array.from(modal.querySelectorAll('[data-action="queue-open"]')).find((node) => node.dataset.name === 'c2').click();
  await tick();
  assert.equal(document.querySelector('.fi-modal-overlay'), null);
  assert.equal(app.selected, 'c2');
});
test('scope editor saves joined newline lists through the Frappe client single-value API', async (t) => {
  const { app, window, document, calls } = harness(t, { skills: () => copy(skillsFixture), 'frappe.client.get': () => copy(settingsFixture), 'frappe.client.set_value': () => ({}) });
  app.scopeDialog(); await tick();
  const modal = document.querySelector('.fi-modal-overlay');
  const todo = Array.from(modal.querySelectorAll('[data-input="scope-tool"]')).find((node) => node.value === 'create_todo');
  todo.checked = false; todo.dispatchEvent(new window.Event('change', { bubbles: true }));
  modal.querySelector('[data-input="scope-add-read"]').value = 'Supplier';
  modal.querySelector('[data-action="scope-add"][data-list="read"]').click();
  modal.querySelector('[data-action="scope-save"]').click(); await tick();
  const save = calls.find((call) => call.method === 'frappe.client.set_value');
  assert.equal(save.args.doctype, 'Intelligence Settings');
  assert.equal(save.args.name, 'Intelligence Settings');
  assert.equal(save.args.fieldname.enabled_tools, 'search_records');
  assert.equal(save.args.fieldname.allowed_read_doctypes, 'Customer\nToDo\nSupplier');
  assert.equal(save.args.fieldname.allowed_write_doctypes, 'ToDo');
  assert.equal(document.querySelector('.fi-modal-overlay'), null);
});
test('scope editor blocks a write scope that is not readable before any server call', async (t) => {
  const { app, document, calls } = harness(t, { skills: () => copy(skillsFixture), 'frappe.client.get': () => copy(settingsFixture), 'frappe.client.set_value': () => ({}) });
  app.scopeDialog(); await tick();
  const modal = document.querySelector('.fi-modal-overlay');
  modal.querySelector('[data-action="scope-remove"][data-list="read"][data-value="ToDo"]').click();
  modal.querySelector('[data-action="scope-save"]').click(); await tick();
  assert.equal(calls.filter((call) => call.method === 'frappe.client.set_value').length, 0);
  const error = modal.querySelector('.fi-modal-error');
  assert.equal(error.hidden, false);
  assert.ok(error.textContent.includes('readable'));
});
test('scope editor shows server validation errors verbatim on save failure', async (t) => {
  const { app, document } = harness(t, { skills: () => copy(skillsFixture), 'frappe.client.get': () => copy(settingsFixture), 'frappe.client.set_value': () => { throw { userMessage: 'Write scope must stay within the read scope.' }; } });
  app.scopeDialog(); await tick();
  const modal = document.querySelector('.fi-modal-overlay');
  modal.querySelector('[data-action="scope-save"]').click(); await tick();
  assert.ok(document.querySelector('.fi-modal-overlay'));
  assert.equal(modal.querySelector('.fi-modal-error').textContent, 'Write scope must stay within the read scope.');
});
test('scope editor is read-only when the user cannot manage settings', async (t) => {
  const { app, document } = harness(t, { skills: () => copy(skillsFixture), 'frappe.client.get': () => copy(settingsFixture) });
  app.boot.is_manager = false;
  app.scopeDialog(); await tick();
  const modal = document.querySelector('.fi-modal-overlay');
  assert.equal(modal.querySelector('[data-action="scope-save"]'), null);
  assert.ok(Array.from(modal.querySelectorAll('[data-input="scope-tool"]')).every((node) => node.disabled));
  assert.ok(modal.textContent.includes('Customer'));
});

test('skillsHTML marks disabled tools with an Off badge and keeps enabled ones clean', () => {
  const html = skillsHTML({
    tools: [
      { name: 'update_event', description: 'Reschedule an event.', mutates: true, external: false, version: '1', enabled: false },
      { name: 'search_records', description: 'Find records.', mutates: false, external: false, version: '1', enabled: true },
    ],
    scopes: { read: ['ToDo'], write: [] },
    never_allow: [],
  });
  assert.equal(html.match(/fi-badge">Off</g).length, 1);
  const row = html.split('fi-skill-row').find((chunk) => chunk.includes('update_event'));
  assert.ok(row.includes('Off'));
  const clean = html.split('fi-skill-row').find((chunk) => chunk.includes('search_records'));
  assert.ok(!clean.includes('Off'));
});
