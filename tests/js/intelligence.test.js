'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const client = require('../../frappe_intelligence/public/js/intelligence.js');
const { esc, safeURL, markdown, contextFromRoute, userError, previewHTML } = client.utils;
const source = fs.readFileSync(path.resolve(__dirname, '../../frappe_intelligence/public/js/intelligence.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const copy = (value) => JSON.parse(JSON.stringify(value));
const boot = { enabled: true, is_manager: true, providers: [{ name: 'p1', title: 'Work', kind: 'OpenAI', model: 'configured-model' }], defaults: { max_upload_mb: 10 }, capabilities: { attachments: true, memory: true } };
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
    if (method === 'create_conversation') return copy(snapshot.conversation);
    if (method === 'send_message') { snapshot.run = { name: 'r1', state: 'running' }; snapshot.messages.push({ name: 'm2', role: 'user', content: args.content }); return copy(snapshot.run); }
    throw new Error('Unmocked method ' + method);
  };
  const app = new window.frappe.intelligence.App({ api, document: window.document });
  window.document.querySelector('#host').appendChild(app.root);
  app.boot = copy(boot); app.provider = 'p1'; app.render();
  t.after(() => { app.poller.stop(); window.clearTimeout(app.searchTimer); dom.window.close(); });
  return { app, window, document: window.document, calls, snapshot };
}
function input(app, window, text) { const field = app.$('textarea'); field.value = text; field.dispatchEvent(new window.Event('input', { bubbles: true })); }

test('modal work restores focus after controls are disabled so Escape still closes it', async (t) => {
  const { app, document, window } = harness(t);
  const modal = app.dialog('Edit note', '<input name="note"><button>Save</button>');
  await tick();
  const field = modal.element.querySelector('input'); field.focus();
  await modal.run(async () => { document.body.setAttribute('tabindex', '-1'); document.body.focus(); });
  assert.equal(document.activeElement, field);
  field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(app.modal, null);
});

test('entrypoint is safe when loaded on a non-Desk website and in Node', () => {
  vm.runInNewContext(source, { globalThis: {}, URL, Set, Map });
  assert.equal(typeof client.App, 'function');
});
test('escapes every HTML attribute delimiter', () => { assert.equal(esc('<&>"\''), '&lt;&amp;&gt;&quot;&#39;'); });
test('safe links block active schemes, protocol-relative links, credentials, control characters and backslashes', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,hi', '//evil.test/x', 'https://u:p@evil.test', 'https:\\evil.test', '/\\evil.test', '/api/method/delete', '/app/../api/method/delete', '/private/files/%2e%2e/%2e%2e/api/method/delete', 'https://good.test/\nx']) assert.equal(safeURL(value), '', value);
  assert.equal(safeURL('/app/sales-order/SO-001'), '/app/sales-order/SO-001');
  assert.equal(safeURL('/desk/sales-order/SO-001'), '/desk/sales-order/SO-001');
  assert.equal(safeURL('https://example.test/docs'), 'https://example.test/docs');
});
test('Markdown never passes model HTML, SVG, images, or event handlers through', () => {
  const output = markdown('<img src=x onerror=alert(1)>\n![tracking](https://evil.test/pixel)\n<script>bad()</script>\n[click](javascript:alert)\n**Useful** `const x = "<";`');
  assert.ok(!/<(?:img|script|svg)\b/.test(output));
  assert.ok(!output.includes('href="javascript:'));
  assert.ok(output.includes('&lt;img'));
  assert.ok(output.includes('[Image not loaded]'));
  assert.ok(output.includes('<strong>Useful</strong>'));
});
test('Markdown supports readable tables, lists, safe links and escaped code fences', () => {
  const output = markdown('## Result\n\n| Name | Total |\n| --- | --- |\n| <b>One</b> | 20 |\n\n- First\n- Second\n\n```js\n</code><script>x</script>\n```\n[Docs](https://example.test)');
  assert.ok(output.includes('<table>')); assert.ok(output.includes('<ul><li>First</li><li>Second</li></ul>'));
  assert.ok(output.includes('&lt;/code&gt;&lt;script&gt;')); assert.ok(output.includes('rel="noopener noreferrer"'));
});
test('Markdown renders triple-star bold italic without leaking literal asterisks', () => {
  const output = markdown('***Total due: USD 4,350*** and **plain bold**');
  assert.ok(output.includes('<strong><em>Total due: USD 4,350</em></strong>'));
  assert.ok(output.includes('<strong>plain bold</strong>'));
  assert.ok(!output.includes('*'));
});
test('context contains only explicit route identifiers, never page data', () => {
  assert.deepEqual(contextFromRoute(['Form', 'Customer', 'C-001', { secret: 'do not copy' }]), { doctype: 'Customer', name: 'C-001' });
  assert.deepEqual(contextFromRoute(['List', 'Sales Order', 'List', 'private-filter']), { doctype: 'Sales Order' });
  assert.deepEqual(contextFromRoute(['Form', 'Customer', 'new-customer-1']), { doctype: 'Customer' });
  assert.equal(contextFromRoute(['query-report', 'Payroll']), null); assert.equal(contextFromRoute(['intelligence']), null);
});
test('errors discard tracebacks and treat server messages as text', () => {
  assert.ok(userError({ status: 403 }).includes('permission'));
  assert.ok(!userError({ exception: 'secret api key' }).includes('secret'));
  assert.equal(userError({ _server_messages: JSON.stringify([JSON.stringify({ message: '<b>Not allowed</b>' })]) }), 'Not allowed');
});
test('preview only renders supplied review data as escaped content, without tool metadata', () => {
  const output = previewHTML({ summary: '<img src=x>', target: { name: '</pre><script>x</script>' }, metadata: { secret: 'DO_NOT_RENDER' } });
  assert.ok(output.includes('&lt;img')); assert.ok(!output.includes('<script>')); assert.ok(!output.includes('DO_NOT_RENDER'));
});
test('poller never overlaps tasks, and stop prevents a late in-flight task from rearming', async () => {
  let id = 0, running = 0, maximum = 0, release; const timers = new Map();
  const poller = new client.Poller(async () => { running++; maximum = Math.max(maximum, running); await new Promise((resolve) => { release = resolve; }); running--; return 5; }, (fn) => { timers.set(++id, fn); return id; }, (key) => timers.delete(key));
  poller.start(0); const first = timers.get(1); timers.delete(1); const pending = first();
  poller.start(0); const second = timers.get(2); timers.delete(2); await second();
  assert.equal(maximum, 1); poller.stop(); release(); await pending; assert.equal(timers.size, 0);
});
test('production DOM renderer blocks injection in messages, conversation titles and approval details', async (t) => {
  const { app, document, snapshot } = harness(t);
  snapshot.conversation.title = '<img src=x onerror=alert(1)>';
  snapshot.messages.push({ name: 'm3', role: 'assistant', content: '<script>globalThis.hacked = true</script>\n![pixel](https://evil.test/a.png)' });
  snapshot.messages.push({ name: 'tool', role: 'tool', content: 'MODEL_TOOL_METADATA_MUST_NOT_APPEAR' });
  snapshot.approvals = [{ name: 'a1', tool_name: '<svg/onload=alert(1)>', status: 'pending', preview: { summary: '<img src=x>', target: { doctype: 'Customer' } } }];
  app.selected = 'c1'; app.accept('c1', snapshot);
  // The only img allowed is the fixed product logo on assistant avatars; user
  // content must never render one.
  for (const node of document.querySelectorAll('img')) assert.equal(node.getAttribute('src'), '/assets/frappe_intelligence/images/intelligence.svg');
  assert.equal(document.querySelectorAll('script, iframe').length, 0);
  assert.equal(app.slot('title').textContent, snapshot.conversation.title);
  assert.ok(!app.root.textContent.includes('MODEL_TOOL_METADATA_MUST_NOT_APPEAR'));
  assert.equal(app.$('[data-action="approve"]').textContent.trim(), 'Approve action');
});
test('sending through real composer creates once, submits once, clears only on acknowledged run', async (t) => {
  const { app, window, calls } = harness(t);
  input(app, window, 'Review this week');
  const first = app.send(); const second = app.send();
  assert.equal(app.$('.fi-send').disabled, true);
  await Promise.all([first, second]);
  assert.equal(calls.filter((call) => call.method === 'create_conversation').length, 1);
  assert.equal(calls.filter((call) => call.method === 'send_message').length, 1);
  assert.equal(app.$('textarea').value, ''); assert.equal(app.snapshot.run.state, 'running');
  assert.equal(app.$('.fi-send').disabled, true);
});
test('failed send keeps draft and provides actionable error, without claiming success', async (t) => {
  const { app, window } = harness(t, { send_message: () => { throw { userMessage: 'Provider is disabled.' }; } });
  input(app, window, 'Keep this draft'); await app.send();
  assert.equal(app.draft().text, 'Keep this draft'); assert.equal(app.$('textarea').value, 'Keep this draft');
  assert.ok(app.slot('banner').textContent.includes('Provider is disabled.')); assert.equal(app.watched.size, 0);
});
test('composer handles Shift+Enter and IME without sending, Enter sends', async (t) => {
  const { app, window, calls } = harness(t); input(app, window, 'A message');
  const field = app.$('textarea');
  field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
  field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
  await tick(); assert.equal(calls.length, 0);
  field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await tick(); assert.equal(calls.filter((call) => call.method === 'send_message').length, 1);
});
test('late conversation fetch cannot overwrite a more recent selection', async (t) => {
  const releases = {};
  const { app } = harness(t, { get_conversation: ({ conversation }) => new Promise((resolve) => { releases[conversation] = resolve; }) });
  const one = app.select('one'), two = app.select('two');
  const second = fixture(); second.conversation.name = 'two'; second.conversation.title = 'Second'; releases.two(second); await two;
  const first = fixture(); first.conversation.name = 'one'; first.conversation.title = 'First'; releases.one(first); await one;
  assert.equal(app.selected, 'two'); assert.equal(app.slot('title').textContent, 'Second');
});
test('search request sequencing ignores a stale server response', async (t) => {
  let call = 0; const resolve = [];
  const { app } = harness(t, { list_conversations: () => new Promise((done) => { resolve[call++] = done; }) });
  app.search = 'old'; const old = app.refreshList(); app.search = 'new'; const current = app.refreshList();
  resolve[1]([{ name: 'new', title: 'New match' }]); await current; resolve[0]([{ name: 'old', title: 'Wrong match' }]); await old;
  assert.equal(app.conversations[0].name, 'new'); assert.ok(!app.slot('conversations').textContent.includes('Wrong match'));
});
test('approval controls enforce duplicate guards and exact decision API', async (t) => {
  let release;
  const { app, snapshot, calls } = harness(t, { approve: () => new Promise((resolve) => { release = () => { snapshot.approvals[0].status = 'approved'; snapshot.run.state = 'running'; resolve({}); }; }) });
  snapshot.run = { name: 'r1', state: 'awaiting_approval' }; snapshot.approvals = [{ name: 'a1', tool_name: 'read_document', preview: { summary: 'Read a record' }, status: 'pending' }];
  app.selected = 'c1'; app.accept('c1', copy(snapshot));
  const element = app.$('[data-action="approve"]'); const first = app.action('approve', element), second = app.action('approve', element); await tick();
  assert.equal(element.disabled, true); assert.equal(calls.filter((call) => call.method === 'approve').length, 1); release(); await Promise.all([first, second]);
  const call = calls.find((entry) => entry.method === 'approve'); assert.deepEqual(copy(call.args), { approval: 'a1', decision: 'approve' }); assert.equal(app.$('[data-action="approve"]'), null);
});
test('closing does not cancel a run and background completion updates launcher notification', async (t) => {
  const { app, snapshot, calls } = harness(t); app.selected = 'c1'; snapshot.run = { name: 'r1', state: 'running' }; app.accept('c1', copy(snapshot));
  let notification; app.onBackground = (name, text) => { notification = { name, text }; };
  app.hide(); assert.equal(app.visible, false); assert.equal(calls.filter((call) => call.method === 'cancel').length, 0);
  snapshot.run.state = 'completed'; app.accept('c1', copy(snapshot));
  assert.equal(app.watched.size, 0); assert.equal(notification.name, 'c1'); assert.ok(notification.text.includes('Completed'));
});
test('context removal affects submitted payload; page content never enters the payload', async (t) => {
  const { app, window, calls } = harness(t); app.context = { doctype: 'Customer', name: 'C-001' }; app.renderContext();
  app.$('[data-action="remove-context"]').click(); input(app, window, 'Proceed'); await app.send();
  assert.equal(calls.find((call) => call.method === 'send_message').args.context, null);
});
test('attachments reject unsupported and oversized files before any API operation', async (t) => {
  const { app, calls } = harness(t);
  await app.upload({ name: 'bad.html', size: 20 }); await app.upload({ name: 'server.log', size: 20 }); await app.upload({ name: 'too-big.pdf', size: 11 * 1024 * 1024 });
  assert.equal(calls.length, 0); assert.ok(app.slot('banner').textContent.includes('10 MB'));
});
test('memory modal saves real scoped content and deletes only on confirmation', async (t) => {
  const rows = []; const { app, window, document, calls } = harness(t, { list_memories: () => copy(rows), save_memory: (args) => { rows.push({ name: 'mem1', content: args.content, scope: args.scope }); return rows[0]; }, delete_memory: () => { rows.length = 0; return {}; } });
  app.selected = 'c1'; app.memoryDialog(); await tick();
  const modal = document.querySelector('.fi-modal-overlay'), scope = modal.querySelector('[data-memory-scope]'); scope.value = 'conversation'; scope.dispatchEvent(new window.Event('change')); await tick();
  const form = modal.querySelector('form'); form.elements.content.value = '<script>not executable</script>Useful note'; form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await tick();
  const saved = calls.find((call) => call.method === 'save_memory'); assert.equal(saved.args.scope, 'conversation'); assert.equal(saved.args.conversation, 'c1');
  assert.equal(modal.querySelector('script'), null);
  const remove = modal.querySelector('[data-action="memory-delete"]'); remove.click(); assert.equal(rows.length, 1); remove.click(); await tick(); assert.equal(rows.length, 0);
});
test('provider editor includes disabled managed configurations, preserves blank keys and submits actual values', async (t) => {
  const disabled = { name: 'disabled', title: 'Disabled provider', kind: 'Custom', model: 'configured-model', base_url: 'https://api.example.test/v1', enabled: 0, is_shared: 0, has_api_key: true, can_edit: true };
  const { app, window, document, calls } = harness(t, { provider_details: () => copy(disabled), save_provider: () => ({}), bootstrap: () => copy(boot) });
  app.boot.managed_providers = [disabled]; app.providerDialog();
  const modal = document.querySelector('.fi-modal-overlay'); modal.querySelector('[data-provider="disabled"]').click(); await tick();
  const form = modal.querySelector('form'); assert.equal(form.elements.api_key.value, ''); assert.equal(form.elements.enabled.checked, false);
  form.elements.enabled.checked = true; form.elements.title.value = 'Re-enabled'; form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await tick();
  const save = calls.find((call) => call.method === 'save_provider'); assert.equal(save.args.api_key, null); assert.equal(save.args.enabled, 1); assert.equal(save.args.name, 'disabled');
  assert.equal(document.querySelector('.fi-modal-overlay'), null);
});
test('provider save failure does not close modal or show success', async (t) => {
  const { app, window, document } = harness(t, { save_provider: () => { throw { userMessage: 'This endpoint is not allowlisted.' }; } }); app.providerDialog();
  const form = document.querySelector('.fi-modal form'); form.elements.title.value = 'Custom'; form.elements.model.value = 'model';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await tick();
  assert.ok(document.querySelector('.fi-modal')); assert.ok(document.querySelector('.fi-modal-error').textContent.includes('not allowlisted'));
});
test('cancel is idempotently guarded and retains server-confirmed state', async (t) => {
  let release;
  const { app, snapshot, calls } = harness(t, { cancel: () => new Promise((resolve) => { release = () => { snapshot.run.state = 'cancelled'; resolve({}); }; }) });
  app.selected = 'c1'; snapshot.run = { name: 'r1', state: 'running' }; app.accept('c1', copy(snapshot));
  const stop = app.$('[data-action="cancel"]'), first = app.action('cancel', stop), second = app.action('cancel', stop); await tick();
  assert.equal(stop.disabled, true); assert.equal(calls.filter((call) => call.method === 'cancel').length, 1); release(); await Promise.all([first, second]);
  assert.equal(app.snapshot.run.state, 'cancelled'); assert.equal(app.$('[data-action="cancel"]'), null); assert.ok(app.slot('run').textContent.includes('not reversed'));
});
test('private upload uses CSRF-protected multipart, preserves File IDs and rejects non-private responses', async (t) => {
  const { app, window, calls } = harness(t);
  window.FormData = class { constructor() { this.values = new Map(); } append(key, value) { this.values.set(key, value); } get(key) { return this.values.get(key); } };
  window.AbortController = AbortController; window.frappe.csrf_token = 'test-csrf-token'; let upload;
  window.fetch = async (url, options) => { upload = { url, options }; return { ok: true, status: 200, json: async () => ({ message: { name: 'file1', file_name: 'report.pdf', is_private: 1 } }) }; };
  const first = app.upload({ name: 'report.pdf', size: 100 }), second = app.upload({ name: 'report.pdf', size: 100 }); await Promise.all([first, second]);
  assert.equal(upload.options.headers['X-Frappe-CSRF-Token'], 'test-csrf-token'); assert.equal(upload.options.credentials, 'same-origin'); assert.equal(upload.options.body.get('conversation'), 'c1'); assert.equal(app.draft().attachments[0].name, 'file1');
  assert.equal(calls.filter((call) => call.method === 'create_conversation').length, 1);
  window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ message: { name: 'file2', file_name: 'public.pdf', is_private: '0' } }) });
  await app.upload({ name: 'public.pdf', size: 100 }); assert.equal(app.draft().attachments.length, 1); assert.ok(app.slot('banner').textContent.includes('did not confirm a private attachment'));
});
test('editing a shared provider preserves allowed roles, token limit and timeout', async (t) => {
  const provider = { name: 'shared', title: 'Restricted shared provider', kind: 'OpenAI', model: 'configured-model', enabled: 1, is_shared: 1, allowed_roles: 'Accounts Manager\nSales Manager', max_tokens: 8192, timeout: 90, can_edit: true };
  const { app, window, document, calls } = harness(t, { provider_details: () => copy(provider), save_provider: () => ({}), bootstrap: () => copy(boot) });
  app.boot.managed_providers = [provider]; app.providerDialog();
  const modal = document.querySelector('.fi-modal-overlay'); modal.querySelector('[data-provider="shared"]').click(); await tick();
  const form = modal.querySelector('form'); assert.equal(form.elements.allowed_roles.value, provider.allowed_roles); assert.equal(form.querySelector('[data-allowed-roles]').hidden, false);
  form.elements.title.value = 'Renamed safely'; form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await tick();
  const call = calls.find((entry) => entry.method === 'save_provider'); assert.equal(call.args.allowed_roles, provider.allowed_roles); assert.equal(call.args.max_tokens, 8192); assert.equal(call.args.timeout, 90); assert.equal(call.args.is_shared, 1);
});
test('saved files remain visible on reload and are reused only after explicit selection', async (t) => {
  const { app, window, document, calls, snapshot } = harness(t);
  snapshot.files = [{ name: 'file-1', file_name: '<private-report>.pdf', file_url: '/private/files/report.pdf', is_private: 1 }];
  app.selected = 'c1'; app.accept('c1', snapshot); assert.equal(app.draft().attachments.length, 0);
  app.$('[data-action="files"]').click(); const reuse = document.querySelector('[data-action="reuse-file"]'); assert.ok(reuse); reuse.click(); reuse.click();
  assert.equal(app.draft().attachments.length, 1); assert.equal(document.querySelector('.fi-saved-file-row strong').textContent, '<private-report>.pdf');
  app.modal.close(); input(app, window, 'Review the selected file'); await app.send();
  const request = calls.find((entry) => entry.method === 'send_message'); assert.deepEqual(JSON.parse(request.args.attachments), ['file-1']); assert.equal(calls.filter((entry) => entry.method === 'upload_attachment').length, 0);
});
test('pagination loads more than 200 rows without replacing current run, duplicating messages, or losing history on polling', async (t) => {
  const rows = Array.from({ length: 401 }, (_, index) => ({ name: 'message-' + (index + 1), sequence: index + 1, role: 'user', content: 'Message ' + (index + 1) }));
  const { app, calls, snapshot } = harness(t, { get_conversation: (args) => ({ conversation: { name: 'c1', title: 'Long chat', provider: 'p1' }, messages: rows.filter((row) => !args.before_sequence || row.sequence < args.before_sequence).slice(-200), has_earlier_messages: args.before_sequence > 201, run: { name: 'stale-run', state: 'queued' }, approvals: [] }) });
  app.selected = 'c1'; snapshot.messages = rows.slice(-200); snapshot.has_earlier_messages = true; snapshot.run = { name: 'current-run', state: 'awaiting_approval' }; snapshot.approvals = [{ name: 'a1', tool_name: 'read', status: 'pending', preview: { summary: 'Current approval' } }]; app.accept('c1', snapshot);
  app.slot('thread').scrollTop = 17; await app.loadEarlier(); assert.equal(app.snapshot.messages.length, 400); assert.equal(app.snapshot.run.name, 'current-run'); assert.equal(app.snapshot.approvals[0].name, 'a1'); assert.equal(app.slot('thread').scrollTop, 17);
  await app.loadEarlier(); assert.equal(app.snapshot.messages.length, 401); assert.equal(app.snapshot.has_earlier_messages, false); assert.equal(app.$('[data-action="earlier"]'), null);
  const fresh = fixture(); fresh.messages = rows.slice(-200); fresh.has_earlier_messages = true; fresh.run = { name: 'current-run', state: 'completed' }; app.accept('c1', fresh);
  assert.equal(app.snapshot.messages.length, 401); assert.equal(app.snapshot.messages[0].sequence, 1); assert.equal(app.snapshot.has_earlier_messages, false); assert.equal(app.snapshot.run.state, 'completed');
  assert.deepEqual(calls.filter((entry) => entry.method === 'get_conversation').map((entry) => entry.args.before_sequence), [202, 2]);
});
test('unchanged authoritative polls preserve focused sidebar and run controls', (t) => {
  const { app, snapshot, document } = harness(t); app.conversations = [snapshot.conversation]; app.selected = 'c1'; snapshot.run = { name: 'r1', state: 'running' }; app.accept('c1', copy(snapshot));
  const row = app.$('[data-action="select"]'), cancel = app.$('[data-action="cancel"]'); row.focus(); app.accept('c1', copy(snapshot));
  assert.equal(app.$('[data-action="select"]'), row); assert.equal(document.activeElement, row); assert.equal(app.$('[data-action="cancel"]'), cancel);
});
test('keyboard Escape closes mobile conversation sidebar and restores toggle focus', (t) => {
  const { app, window, document } = harness(t); const toggle = app.$('[data-action="sidebar"]'); toggle.click();
  assert.equal(app.root.classList.contains('fi-sidebar-open'), true); app.$('[data-input="search"]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(app.root.classList.contains('fi-sidebar-open'), false); assert.equal(document.activeElement, toggle); assert.equal(toggle.getAttribute('aria-expanded'), 'false');
});
test('archived conversation is read-only while history remains readable', (t) => {
  const { app, snapshot } = harness(t); app.selected = 'c1'; snapshot.conversation.archived = 1; app.accept('c1', snapshot);
  assert.equal(app.$('textarea').disabled, true); assert.equal(app.$('[data-action="attach"]').disabled, true); assert.ok(app.slot('messages').textContent.includes('Hello'));
});
test('tool action cards interleave chronologically instead of trailing the final answer', (t) => {
  const { app, snapshot } = harness(t); app.selected = 'c1';
  snapshot.messages = [
    { name: 'm1', role: 'user', content: 'Brief me', status: 'complete', creation: '2026-09-17 09:00:00' },
    { name: 'm2', role: 'assistant', content: 'On it', status: 'complete', creation: '2026-09-17 09:00:05' },
    { name: 'm3', role: 'assistant', content: 'The final briefing', status: 'complete', creation: '2026-09-17 09:02:00' },
  ];
  snapshot.run = { name: 'r1', state: 'completed' };
  snapshot.approvals = [{ name: 'a1', tool_name: 'search_records', status: 'succeeded', creation: '2026-09-17 09:01:00', preview: { summary: 'Search permitted records' } }];
  app.accept('c1', copy(snapshot));
  const text = app.slot('messages').textContent;
  // The answer must follow the actions that produced it; grouping all cards
  // after all messages buries it mid-thread.
  assert.ok(text.indexOf('On it') < text.indexOf('search_records'));
  assert.ok(text.indexOf('search_records') < text.indexOf('The final briefing'));
});

test('a completed run leaves no status chip: the answer in the thread is the outcome', (t) => {
  const { app, snapshot } = harness(t); app.selected = 'c1';
  snapshot.run = { name: 'r1', state: 'completed' };
  app.accept('c1', copy(snapshot));
  assert.equal(app.slot('run').hidden, true);
  assert.equal(app.slot('run').textContent, '');
});

test('every non-completed run state still surfaces the status chip', (t) => {
  const { app, snapshot } = harness(t); app.selected = 'c1';
  for (const state of ['queued', 'running', 'awaiting_approval', 'failed', 'cancelled', 'needs_reconciliation']) {
    snapshot.run = { name: 'r1', state };
    app.accept('c1', copy(snapshot));
    assert.equal(app.slot('run').hidden, false, state);
    assert.ok(app.slot('run').textContent.trim().length > 0, state);
  }
  // A cancelled-completed edge: cancel_requested must keep the chip even when the state settled.
  snapshot.run = { name: 'r1', state: 'completed', cancel_requested: true };
  app.accept('c1', copy(snapshot));
  assert.equal(app.slot('run').hidden, false);
});

test('the assistant avatar, welcome mark and launcher use the product logo, never the CSS star', (t) => {
  const { app } = harness(t);
  const html = app.messageHTML({ name: 'm1', role: 'assistant', content: 'Hi', status: 'complete', creation: '2026-09-17 09:00:00' });
  assert.ok(html.includes('fi-avatar-logo'));
  assert.ok(html.includes('/assets/frappe_intelligence/images/intelligence.svg'));
  assert.ok(!source.includes('<span class="fi-mark"'), 'no CSS-star marks remain in the client');
  assert.ok(source.includes('fi-welcome-logo') && source.includes('fi-toggle-logo'));
});

test('the welcome screen greets by name with a daypart, escapes it, and falls back', (t) => {
  const { app } = harness(t);
  const welcome = (patch) => {
    app.boot = Object.assign(copy(boot), patch);
    app.messageSignature = null;
    app.render();
    return app.slot('messages').innerHTML;
  };
  const fallback = welcome({});
  assert.ok(fallback.includes('How can I help?'), 'fallback greeting without a name');
  assert.ok(fallback.includes('data-prompt="Give me my briefing for today'), 'briefing starter present');
  const named = welcome({ user_name: 'Rishi <script>' });
  assert.match(named, /Good (morning|afternoon|evening), Rishi &lt;script&gt;\./);
  assert.ok(!named.includes('<script>'), 'the name is escaped');
});

test('syncDesk moves conversations and navigation into the Desk sidebar on our page only', (t) => {
  const { app, window, document } = harness(t);
  window.frappe.boot = {}; window.frappe.session = { user: 'user@example.test' };
  let route = ['intelligence-chat'];
  window.frappe.get_route = () => route;
  const sidebar = document.createElement('aside'); sidebar.className = 'body-sidebar';
  const standard = document.createElement('div'); standard.className = 'standard-items-sections'; sidebar.appendChild(standard);
  const top = document.createElement('div'); top.className = 'body-sidebar-top'; sidebar.appendChild(top);
  document.body.appendChild(sidebar);
  window.frappe.intelligence.syncDesk();
  const section = sidebar.querySelector('[data-fi-desk]');
  assert.ok(section, 'section injected');
  assert.equal(standard.nextSibling, section, 'sits right below Search and Notifications');
  assert.equal(document.body.classList.contains('fi-desk-active'), true);
  for (const label of ['New conversation', 'Conversations', 'Approvals', 'Skills', 'Memory', 'Providers & models', 'Scope'])
    assert.ok(section.textContent.includes(label), label);
  // The in-page app paints the same rows into the Desk list.
  app.conversations = [{ name: 'c9', title: 'Quarterly review', modified: '2026-09-17 09:00:00' }];
  app.sidebarSignature = null; app.renderSidebar();
  assert.ok(sidebar.querySelector('[data-fi-desk-list]').textContent.includes('Quarterly review'));
  // Clicks inside the Desk section drive the singleton app.
  const seen = [];
  const original = window.frappe.intelligence.App.prototype.action;
  window.frappe.intelligence.App.prototype.action = function (name) { seen.push(name); };
  t.after(() => { window.frappe.intelligence.App.prototype.action = original; });
  sidebar.querySelector('[data-fi-desk-list] [data-action="select"]').click();
  section.querySelector('[data-action="new"]').click();
  assert.deepEqual(seen, ['select', 'new']);
  // Leaving our route removes the section and the body class again.
  route = ['home'];
  window.frappe.intelligence.syncDesk();
  assert.equal(sidebar.querySelector('[data-fi-desk]'), null);
  assert.equal(document.body.classList.contains('fi-desk-active'), false);
});
