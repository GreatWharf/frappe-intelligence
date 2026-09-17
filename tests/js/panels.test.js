'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const client = require('../../frappe_intelligence/public/js/intelligence.js');
const { skillsHTML, learnedSkillsHTML, effortOptions, queueHTML, scopeState, scopeProblem, scopeHTML, stamp } = client.utils;
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

const learnedFixture = [
  { name: 'skill-month-end', title: 'Month-end close', description: 'Walk through the month-end checklist.', instructions: 'Summarize open ToDos first.', origin: 'Seeded', enabled: 1, shared: 1, version: '3', owner: 'Administrator', scope_read: 'ToDo', scope_write: 'ToDo' },
  { name: 'skill-follow-up', title: 'Supplier follow-up', description: 'Draft follow-up notes for late suppliers.', instructions: 'Draft only, never send.', origin: 'Learned', enabled: 0, shared: 0, version: '1', owner: 'jamie@example.test', scope_read: 'Supplier', scope_write: '' },
];
const skillsWithLearned = Object.assign({}, skillsFixture, { learned_skills: learnedFixture });

test('learnedSkillsHTML renders titles, code names, origin badges, Off state and versions', () => {
  const html = learnedSkillsHTML(learnedFixture, { isManager: true, user: 'jamie@example.test' });
  assert.ok(html.includes('Learned skills'));
  assert.ok(html.includes('Month-end close'));
  assert.ok(html.includes('<code>skill-month-end</code>'));
  assert.ok(html.includes('>Seeded</span>'));
  assert.ok(html.includes('>Learned</span>'));
  assert.ok(html.includes('v3'));
  assert.equal(html.match(/fi-badge">Off</g).length, 1);
  const off = html.split('fi-learned-row').find((chunk) => chunk.includes('skill-follow-up'));
  assert.ok(off.includes('Off'));
  const on = html.split('fi-learned-row').find((chunk) => chunk.includes('skill-month-end'));
  assert.ok(!on.includes('Off'));
});
test('learnedSkillsHTML escapes hostile content and tolerates malformed payloads', () => {
  const hostile = learnedSkillsHTML([{ name: '<img src=x>', title: '<script>alert(1)</script>', description: '<b>bad</b>', origin: '<i>', enabled: 0, version: '<v>' }], { isManager: true });
  assert.ok(!hostile.includes('<img'));
  assert.ok(!hostile.includes('<script>'));
  assert.ok(!hostile.includes('<v>'));
  assert.ok(hostile.includes('&lt;img'));
  assert.equal(learnedSkillsHTML(null), '');
  assert.equal(learnedSkillsHTML('nope'), '');
  assert.equal(learnedSkillsHTML([]), '');
});
test('learnedSkillsHTML gates edit controls to managers and owners', () => {
  const manager = learnedSkillsHTML(learnedFixture, { isManager: true, user: 'jamie@example.test' });
  assert.equal(manager.match(/data-action="skill-edit"/g).length, 2);
  const owner = learnedSkillsHTML(learnedFixture, { isManager: false, user: 'jamie@example.test' });
  assert.equal(owner.match(/data-action="skill-edit"/g).length, 1);
  assert.ok(owner.split('fi-learned-row').find((chunk) => chunk.includes('skill-follow-up')).includes('skill-edit'));
  const flagged = learnedSkillsHTML([{ name: 'skill-flagged', title: 'Flagged', description: '', origin: 'Learned', enabled: 1, shared: 0, version: '1', can_edit: 1 }], { isManager: false, user: 'stranger@example.test' });
  assert.equal(flagged.match(/data-action="skill-edit"/g).length, 1);
  const stranger = learnedSkillsHTML(learnedFixture, { isManager: false, user: 'stranger@example.test' });
  assert.ok(!stranger.includes('skill-edit'));
  assert.ok(!stranger.includes('data-input="skill-enabled"'));
});
test('skillsHTML places the learned skills section between the tools list and the scopes', () => {
  const html = skillsHTML(skillsWithLearned, { isManager: true, user: 'jamie@example.test' });
  assert.ok(html.includes('Learned skills'));
  assert.ok(html.indexOf('search_records') < html.indexOf('Learned skills'));
  assert.ok(html.indexOf('Learned skills') < html.indexOf('Readable doctypes'));
  assert.ok(!skillsHTML(skillsFixture).includes('Learned skills'));
});
test('effortOptions lists every effort level with Auto as the fallback default', () => {
  const html = effortOptions();
  for (const effort of ['Auto', 'Low', 'Medium', 'High', 'Max']) assert.ok(html.includes('>' + effort + '</option>'), effort);
  assert.ok(html.includes('<option selected>Auto</option>'));
  const high = effortOptions('High');
  assert.ok(high.includes('<option selected>High</option>'));
  assert.ok(!high.includes('<option selected>Auto</option>'));
  assert.ok(effortOptions('Bogus').includes('<option selected>Auto</option>'));
});
test('skills dialog renders the learned skills section with badges and rows', async (t) => {
  const { app, document } = harness(t, { skills: () => copy(skillsWithLearned) });
  app.boot.user = 'jamie@example.test';
  app.skillsDialog(); await tick();
  const modal = document.querySelector('.fi-modal-overlay');
  assert.ok(modal.textContent.includes('Learned skills'));
  assert.ok(modal.textContent.includes('Month-end close'));
  assert.equal(modal.querySelectorAll('.fi-learned-row').length, 2);
  assert.deepEqual(Array.from(modal.querySelectorAll('.fi-badge-origin')).map((node) => node.textContent), ['Seeded', 'Learned']);
});
test('learned skill toggle saves enabled through the Frappe client single-value API', async (t) => {
  const { app, window, document, calls } = harness(t, { skills: () => copy(skillsWithLearned), 'frappe.client.set_value': () => ({}) });
  app.boot.user = 'jamie@example.test';
  app.skillsDialog(); await tick();
  const modal = document.querySelector('.fi-modal-overlay');
  const toggle = Array.from(modal.querySelectorAll('[data-input="skill-enabled"]')).find((node) => node.dataset.name === 'skill-follow-up');
  assert.ok(toggle);
  assert.equal(toggle.checked, false);
  toggle.checked = true; toggle.dispatchEvent(new window.Event('change', { bubbles: true })); await tick();
  const save = calls.find((call) => call.method === 'frappe.client.set_value');
  assert.equal(save.args.doctype, 'Intelligence Skill');
  assert.equal(save.args.name, 'skill-follow-up');
  assert.deepEqual(copy(save.args.fieldname), { enabled: 1 });
  assert.equal(modal.querySelector('[data-input="skill-enabled"][data-name="skill-follow-up"]').checked, true);
});
test('learned skill toggle reverts optimistic state and shows the server error verbatim on failure', async (t) => {
  const { app, window, document } = harness(t, { skills: () => copy(skillsWithLearned), 'frappe.client.set_value': () => { throw { userMessage: 'Skill validation failed verbatim.' }; } });
  app.boot.user = 'jamie@example.test';
  app.skillsDialog(); await tick();
  const modal = document.querySelector('.fi-modal-overlay');
  const toggle = Array.from(modal.querySelectorAll('[data-input="skill-enabled"]')).find((node) => node.dataset.name === 'skill-follow-up');
  toggle.checked = true; toggle.dispatchEvent(new window.Event('change', { bubbles: true })); await tick();
  assert.equal(modal.querySelector('.fi-modal-error').textContent, 'Skill validation failed verbatim.');
  assert.equal(modal.querySelector('[data-input="skill-enabled"][data-name="skill-follow-up"]').checked, false);
});
test('learned skill edit saves title, description, instructions and newline scope lists, then re-renders', async (t) => {
  const { app, window, document, calls } = harness(t, { skills: () => copy(skillsWithLearned), 'frappe.client.set_value': () => ({}) });
  app.boot.user = 'jamie@example.test';
  app.skillsDialog(); await tick();
  const modal = document.querySelector('.fi-modal-overlay');
  Array.from(modal.querySelectorAll('[data-action="skill-edit"]')).find((node) => node.dataset.name === 'skill-month-end').click(); await tick();
  const form = modal.querySelector('form[data-form="skill-edit"]');
  assert.ok(form);
  assert.equal(form.elements.title.value, 'Month-end close');
  assert.equal(form.elements.scope_read.value, 'ToDo');
  form.elements.title.value = 'Month-end close v2';
  form.elements.description.value = 'Updated description.';
  form.elements.instructions.value = 'First summarize.\nThen list.';
  form.elements.scope_read.value = 'ToDo\nCustomer';
  form.elements.scope_write.value = 'ToDo';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await tick();
  const save = calls.find((call) => call.method === 'frappe.client.set_value');
  assert.equal(save.args.doctype, 'Intelligence Skill');
  assert.equal(save.args.name, 'skill-month-end');
  assert.deepEqual(copy(save.args.fieldname), { title: 'Month-end close v2', description: 'Updated description.', instructions: 'First summarize.\nThen list.', scope_read: 'ToDo\nCustomer', scope_write: 'ToDo' });
  assert.equal(calls.filter((call) => call.method === 'skills').length, 2);
  assert.equal(modal.querySelector('form[data-form="skill-edit"]'), null);
  assert.ok(modal.textContent.includes('Learned skills'));
});
test('learned skill edit shows the seeded hint only for seeded playbooks', async (t) => {
  const { app, document } = harness(t, { skills: () => copy(skillsWithLearned), 'frappe.client.set_value': () => ({}) });
  app.boot.user = 'jamie@example.test';
  app.skillsDialog(); await tick();
  const modal = document.querySelector('.fi-modal-overlay');
  Array.from(modal.querySelectorAll('[data-action="skill-edit"]')).find((node) => node.dataset.name === 'skill-month-end').click(); await tick();
  assert.ok(modal.textContent.includes('Seeded playbook; edits are allowed'));
  modal.querySelector('[data-action="skill-edit-cancel"]').click(); await tick();
  Array.from(modal.querySelectorAll('[data-action="skill-edit"]')).find((node) => node.dataset.name === 'skill-follow-up').click(); await tick();
  assert.ok(!modal.textContent.includes('Seeded playbook'));
});
test('learned skill rows give owners edit controls on their own skills only', async (t) => {
  const { app, document } = harness(t, { skills: () => copy(skillsWithLearned) });
  app.boot.is_manager = false; app.boot.user = 'jamie@example.test';
  app.skillsDialog(); await tick();
  const modal = document.querySelector('.fi-modal-overlay');
  assert.deepEqual(Array.from(modal.querySelectorAll('[data-action="skill-edit"]')).map((node) => node.dataset.name), ['skill-follow-up']);
});
test('learned skill rows hide every edit control from non-manager non-owners', async (t) => {
  const { app, document } = harness(t, { skills: () => copy(skillsWithLearned) });
  app.boot.is_manager = false; app.boot.user = 'stranger@example.test';
  app.skillsDialog(); await tick();
  const modal = document.querySelector('.fi-modal-overlay');
  assert.ok(modal.textContent.includes('Month-end close'));
  assert.equal(modal.querySelector('[data-action="skill-edit"]'), null);
  assert.equal(modal.querySelector('[data-input="skill-enabled"]'), null);
});
test('provider dialog includes thinking_effort in the save payload', async (t) => {
  const { app, window, document, calls } = harness(t, { save_provider: () => ({}), bootstrap: () => copy(boot) });
  app.providerDialog();
  const modal = document.querySelector('.fi-modal-overlay');
  const form = modal.querySelector('form');
  assert.ok(form.elements.thinking_effort);
  assert.equal(form.elements.thinking_effort.value, 'Auto');
  form.elements.title.value = 'Effort provider';
  form.elements.model.value = 'configured-model';
  form.elements.thinking_effort.value = 'High';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await tick();
  assert.equal(calls.find((call) => call.method === 'save_provider').args.thinking_effort, 'High');
});
test('provider dialog restores a saved thinking effort when editing', async (t) => {
  const provider = { name: 'effortful', title: 'Effort provider', kind: 'OpenAI', model: 'configured-model', enabled: 1, is_shared: 0, thinking_effort: 'Max', can_edit: true };
  const { app, window, document, calls } = harness(t, { provider_details: () => copy(provider), save_provider: () => ({}), bootstrap: () => copy(boot) });
  app.boot.managed_providers = [provider]; app.providerDialog();
  const modal = document.querySelector('.fi-modal-overlay'); modal.querySelector('[data-provider="effortful"]').click(); await tick();
  const form = modal.querySelector('form'); assert.equal(form.elements.thinking_effort.value, 'Max');
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await tick();
  assert.equal(calls.find((call) => call.method === 'save_provider').args.thinking_effort, 'Max');
});
