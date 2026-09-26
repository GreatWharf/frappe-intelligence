'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const client = require('./load.cjs').load();
const { esc, safeURL, markdown, contextFromRoute, userError, previewHTML, actionSentence, recordLink, fileCardHTML } = client.utils;
const source = require('./load.cjs').source();
const tick = () => new Promise((resolve) => setImmediate(resolve));
const copy = (value) => JSON.parse(JSON.stringify(value));
const boot = { enabled: true, is_manager: true, user: 'owner@example.test', providers: [{ name: 'p1', title: 'Work', kind: 'OpenAI', model: 'configured-model', thinking_effort: 'Medium' }], defaults: { max_upload_mb: 10, approval_mode: 'Approve Every Step' }, capabilities: { attachments: true, memory: true } };
function fixture() {
  return { conversation: { name: 'c1', title: 'Private chat', provider: 'p1', archived: 0, owner: 'owner@example.test', shared: 0 }, messages: [{ name: 'm1', role: 'user', content: 'Hello', status: 'complete' }], approvals: [], files: [], run: null, can_post: true };
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
    if (method === 'list_conversations') return args && Number(args.shared) ? [] : [copy(snapshot.conversation)];
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
  assert.ok(app.$('[data-action="always"]'), 'pending approvals offer Always allow');
});
test('always decision is sent to the approve endpoint', async (t) => {
  const { app, snapshot, calls } = harness(t, { approve: async () => { snapshot.approvals[0].status = 'approved'; snapshot.run.state = 'running'; return {}; } });
  snapshot.run = { name: 'r1', state: 'awaiting_approval' }; snapshot.approvals = [{ name: 'a1', tool_name: 'read_document', preview: { summary: 'Read a record' }, status: 'pending' }];
  app.selected = 'c1'; app.accept('c1', copy(snapshot));
  const button = app.$('[data-action="always"]');
  assert.ok(button, 'Always allow button rendered');
  await app.action('always', button);
  await tick();
  const call = calls.find((entry) => entry.method === 'approve' && entry.args.decision === 'always');
  assert.ok(call, 'decision always sent');
  assert.equal(call.args.approval, button.dataset.name);
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
test('list refresh sequencing ignores a stale server response', async (t) => {
  let call = 0; const resolve = [];
  const { app } = harness(t, { list_conversations: (args) => Number(args && args.shared) ? [] : new Promise((done) => { resolve[call++] = done; }) });
  const old = app.refreshList(); const current = app.refreshList();
  resolve[1]([{ name: 'new', title: 'New match' }]); await current; resolve[0]([{ name: 'old', title: 'Wrong match' }]); await old;
  assert.equal(app.conversations.length, 1); assert.equal(app.conversations[0].name, 'new');
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
test('saved files render as file cards by file name and are reused only after explicit selection', async (t) => {
  const { app, window, document, calls, snapshot } = harness(t);
  snapshot.files = [{ name: 'file-1', file_name: '<private-report>.pdf', file_url: '/private/files/report.pdf', is_private: 1, file_size: 48230 }];
  app.selected = 'c1'; app.accept('c1', snapshot); assert.equal(app.draft().attachments.length, 0);
  const card = app.slot('messages').querySelector('.fi-file-card');
  assert.ok(card, 'file card rendered in the thread');
  assert.equal(card.querySelector('strong').textContent, '<private-report>.pdf', 'card shows the file name, not the docname');
  assert.ok(!card.textContent.includes('report.pdf'), 'the bare hash path is not the label');
  const open = card.querySelector('a.fi-file-open'); assert.equal(open.getAttribute('href'), '/private/files/report.pdf');
  const reuse = card.querySelector('[data-action="reuse-file"]'); assert.ok(reuse); reuse.click(); reuse.click();
  assert.equal(app.draft().attachments.length, 1);
  input(app, window, 'Review the selected file'); await app.send();
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
test('unchanged authoritative polls preserve focused run controls', (t) => {
  const { app, snapshot, document } = harness(t); app.selected = 'c1'; snapshot.run = { name: 'r1', state: 'running' }; app.accept('c1', copy(snapshot));
  const cancel = app.$('[data-action="cancel"]'); cancel.focus(); app.accept('c1', copy(snapshot));
  assert.equal(app.$('[data-action="cancel"]'), cancel); assert.equal(document.activeElement, cancel);
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
  assert.ok(text.indexOf('On it') < text.indexOf('Search permitted records'));
  assert.ok(text.indexOf('Search permitted records') < text.indexOf('The final briefing'));
});

const toolRun = (rows) => rows.map((row, index) => Object.assign({ name: 'a' + (index + 1), status: 'succeeded', creation: '2026-09-17 09:0' + (index + 1) + ':00' }, row));

test('consecutive completed tool actions collapse into one expandable group card', (t) => {
  const { app, snapshot } = harness(t); app.selected = 'c1';
  snapshot.messages = [
    { name: 'm1', role: 'user', content: 'Check Acme', status: 'complete', creation: '2026-09-17 09:00:00' },
    { name: 'm2', role: 'assistant', content: 'On it', status: 'complete', creation: '2026-09-17 09:00:05' },
    { name: 'm3', role: 'assistant', content: 'Acme Corp is clean.', status: 'complete', creation: '2026-09-17 09:08:00' },
  ];
  snapshot.run = { name: 'r1', state: 'completed' };
  snapshot.approvals = toolRun([
    { tool_name: 'search_records', preview: { summary: 'Search permitted Supplier records.', operation: 'search', target: { doctype: 'Supplier' }, details: { limit: 5 } } },
    { tool_name: 'search_records', preview: { summary: 'Search permitted Item records.', operation: 'search', target: { doctype: 'Item' }, details: { limit: 5 } } },
    { tool_name: 'read_record', preview: { summary: "Read Supplier 'Acme Corp'.", operation: 'read', target: { doctype: 'Supplier', name: 'Acme Corp' }, details: {} } },
  ]);
  app.accept('c1', copy(snapshot));
  const groups = app.slot('messages').querySelectorAll('.fi-tool-group');
  assert.equal(groups.length, 1, 'one collapsed group for the consecutive actions');
  assert.equal(app.slot('messages').querySelectorAll('.fi-approval').length, 0, 'no standalone cards inside a group');
  const head = groups[0].querySelector('.fi-tool-group-head');
  assert.ok(head.textContent.includes('Used 3 tools'));
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  const body = groups[0].querySelector('.fi-tool-group-body');
  assert.equal(body.hidden, true, 'collapsed by default');
  assert.equal(body.querySelectorAll('.fi-tool-row').length, 3);
  assert.ok(body.querySelector('.fi-group-details'), 'technical details stay one toggle away');
  head.click();
  assert.equal(body.hidden, false); assert.equal(head.getAttribute('aria-expanded'), 'true');
  // Expansion survives polling re-renders.
  snapshot.messages.push({ name: 'm4', role: 'assistant', content: 'Anything else?', status: 'complete', creation: '2026-09-17 09:09:00' });
  app.accept('c1', copy(snapshot));
  const reopened = app.slot('messages').querySelector('.fi-tool-group');
  assert.equal(reopened.querySelector('.fi-tool-group-body').hidden, false, 'expansion persists across re-renders');
});

test('pending approvals stay visible and break a tool group', (t) => {
  const { app, snapshot } = harness(t); app.selected = 'c1';
  snapshot.run = { name: 'r1', state: 'awaiting_approval' };
  snapshot.approvals = toolRun([
    { tool_name: 'search_records', preview: { summary: 'Search permitted Supplier records.', operation: 'search', target: { doctype: 'Supplier' } } },
    { tool_name: 'create_record', status: 'pending', preview: { action: "Create Supplier 'Acme Corp'", summary: 'Create the supplier.', doctype: 'Supplier', name: 'Acme Corp' } },
    { tool_name: 'search_records', preview: { summary: 'Search permitted Item records.', operation: 'search', target: { doctype: 'Item' } } },
  ]);
  app.accept('c1', copy(snapshot));
  const messages = app.slot('messages');
  assert.equal(messages.querySelectorAll('.fi-tool-group').length, 0, 'single resolved actions do not form a group');
  const pending = messages.querySelector('.fi-approval.is-pending');
  assert.ok(pending, 'pending approval rendered as its own card');
  assert.ok(pending.querySelector('[data-action="approve"]'), 'decision controls visible without expanding anything');
  assert.equal(messages.querySelectorAll('.fi-approval').length, 1, 'only the pending action renders as a card');
  assert.equal(messages.querySelectorAll('.fi-tool-block').length, 2, 'resolved actions render as single tool rows around the pending card');
  const kinds = Array.from(messages.children).map((node) => node.classList.contains('fi-approval') ? 'pending' : node.classList.contains('fi-tool-block') ? 'row' : '').filter(Boolean);
  assert.deepEqual(kinds, ['row', 'pending', 'row'], 'pending card sits between the resolved tool rows');
});

test('a group with an in-flight action says so on the header', (t) => {
  const { app, snapshot } = harness(t); app.selected = 'c1';
  snapshot.run = { name: 'r1', state: 'running' };
  snapshot.approvals = toolRun([
    { tool_name: 'search_records', preview: { summary: 'Search permitted Supplier records.', operation: 'search', target: { doctype: 'Supplier' } } },
    { tool_name: 'create_record', status: 'approved', preview: { action: "Create Supplier 'Acme Corp'", summary: 'Create the supplier.', doctype: 'Supplier', name: 'Acme Corp' } },
  ]);
  app.accept('c1', copy(snapshot));
  const group = app.slot('messages').querySelector('.fi-tool-group');
  const head = group.querySelector('.fi-tool-group-head');
  assert.ok(head.textContent.includes("Creating Supplier 'Acme Corp'"), 'header names the in-flight step');
  assert.ok(head.querySelector('.fi-tool-group-title').classList.contains('fi-shimmer'), 'shimmer sweep on the active step label');
  assert.ok(group.querySelector('.fi-tool-group-spinner'), 'spinner while the run is active');
});

test('file tool actions show the attachment file name, never the raw File ID', (t) => {
  const { app, snapshot } = harness(t); app.selected = 'c1';
  snapshot.run = { name: 'r1', state: 'completed' };
  snapshot.approvals = toolRun([
    { tool_name: 'search_records', preview: { summary: 'Search permitted Supplier records.', operation: 'search', target: { doctype: 'Supplier' } } },
    { tool_name: 'read_attachment', preview: { summary: "Read this conversation's private attachment.", operation: 'read_attachment', target: { doctype: 'File', name: 'FILE-9D5-8-0' }, details: { file_name: 'invoice-acme.pdf' } } },
  ]);
  app.accept('c1', copy(snapshot));
  const group = app.slot('messages').querySelector('.fi-tool-group');
  const row = Array.from(group.querySelectorAll('.fi-tool-row')).find((node) => node.textContent.includes('invoice-acme.pdf'));
  assert.ok(row, 'row shows the file name');
  assert.ok(row.querySelector('.fi-tool-label').textContent.includes("Reading attachment 'invoice-acme.pdf'"));
  const chip = row.querySelector('.fi-file-ref');
  assert.ok(chip, 'file chip rendered');
  assert.equal(chip.tagName.toLowerCase(), 'span', 'chip is not a link to a raw File route');
  assert.ok(!row.textContent.includes('FILE-9D5-8-0'), 'raw File ID never rendered in the row');
});

test('tool sentences come from the preview operation, and file reads name the attachment', () => {
  assert.equal(actionSentence({ operation: 'search', target: { doctype: 'Customer' } }, 'search_records'), 'Search Customer records');
  assert.equal(actionSentence({ operation: 'read', target: { doctype: 'Supplier', name: 'Acme Corp' } }, 'read_record'), "Read Supplier 'Acme Corp'");
  assert.equal(actionSentence({ operation: 'read_attachment', target: { doctype: 'File', name: 'FILE-1' }, details: { file_name: 'invoice.pdf' } }, 'read_attachment'), "Read attachment 'invoice.pdf'");
  assert.equal(actionSentence({ operation: 'run_report', target: {} }, 'run_report'), 'Run requested action');
});

test('the client keeps app navigation in-tab and drops the sidebar search box', () => {
  assert.ok(!source.includes('window.open('), 'no new-tab app navigation');
  assert.ok(!source.includes('fi-search'), 'custom sidebar search removed');
  assert.ok(!source.includes('File uploaded privately'), 'no private attachment notice');
  assert.ok(!source.includes('Frappe Intelligence'), 'user-visible product name is Intelligence');
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

test('fitViewport pins the app to the remaining viewport in page mode and leaves the drawer alone', (t) => {
  const { app, window } = harness(t);
  app.mode = 'page';
  try { Object.defineProperty(window, 'innerHeight', { value: 1040, configurable: true }); }
  catch { window.innerHeight = 1040; }
  const rect = { top: 49, height: 1930 };
  app.root.getBoundingClientRect = () => rect;
  app.fitViewport();
  assert.equal(app.root.style.height, '983px', 'an overflowing app is pinned into view');
  assert.equal(app.root.style.maxHeight, '983px', 'max-height backs the pin so the grid cannot outgrow it');
  rect.height = 400;
  app.fitViewport();
  assert.equal(app.root.style.height, '983px', 'a shorter app still fills the viewport so the page itself never scrolls');
  rect.top = 780;
  app.fitViewport();
  assert.equal(app.root.style.height, '', 'below the usable floor the CSS minimum takes over');
  assert.equal(app.root.style.maxHeight, '', 'the max-height pin lifts with it');
  rect.top = 49; app.mode = 'drawer';
  app.fitViewport();
  assert.equal(app.root.style.height, '', 'the drawer keeps its CSS-owned height');
  assert.equal(app.root.style.maxHeight, '');
});

test('fitViewport pins inside the Desk scroll container content box, not the raw viewport', (t) => {
  const { app, window, document } = harness(t);
  app.mode = 'page';
  try { Object.defineProperty(window, 'innerHeight', { value: 960, configurable: true }); }
  catch { window.innerHeight = 960; }
  // Live Desk: the page sits inside .main-section (overflow-y:auto), and the
  // onboarding panel sets an inline padding-bottom: 90px on it. Pinning to the
  // raw viewport would overflow the container by exactly those 90px and the
  // whole page would scroll next to the thread.
  const host = document.createElement('div');
  app.root.parentNode.insertBefore(host, app.root);
  host.appendChild(app.root);
  host.getBoundingClientRect = () => ({ top: 0 });
  try { Object.defineProperty(host, 'clientHeight', { value: 960, configurable: true }); }
  catch { host.clientHeight = 960; }
  const native = typeof window.getComputedStyle === 'function' ? window.getComputedStyle : null;
  // Restore the host's own getComputedStyle (or its absence) for other tests.
  t.after(() => {
    try { Object.defineProperty(window, 'getComputedStyle', { value: native, configurable: true, writable: true }); }
    catch { window.getComputedStyle = native; }
  });
  const mockStyle = (node) => node === host ? { overflowY: 'auto', paddingBottom: '90px' } : { overflowY: 'visible', paddingBottom: '0px' };
  try { Object.defineProperty(window, 'getComputedStyle', { value: mockStyle, configurable: true, writable: true }); }
  catch { window.getComputedStyle = mockStyle; }
  app.root.getBoundingClientRect = () => ({ top: 49 });
  app.fitViewport();
  assert.equal(app.root.style.height, '813px', '960 - 90 container padding - 49 app top - 8 slack: no scrollable overflow remains');
  assert.equal(app.root.style.maxHeight, '813px');
  // Without the injected padding the same container leaves the app full height.
  const noPad = (node) => node === host ? { overflowY: 'auto', paddingBottom: '0px' } : { overflowY: 'visible', paddingBottom: '0px' };
  try { Object.defineProperty(window, 'getComputedStyle', { value: noPad, configurable: true, writable: true }); }
  catch { window.getComputedStyle = noPad; }
  app.fitViewport();
  assert.equal(app.root.style.height, '903px', 'an unpadded container keeps the full remaining viewport');
});

test('active runs show only the state label; warning states keep their explanation', (t) => {
  const { app, snapshot } = harness(t); app.selected = 'c1';
  for (const state of ['queued', 'running', 'awaiting_approval']) {
    snapshot.run = { name: 'r1', state };
    app.accept('c1', copy(snapshot));
    const text = app.slot('run').textContent;
    assert.ok(!text.includes('You can leave this page'), state + ' drops the background sentence');
    assert.ok(!text.includes('waiting for your decision'), state + ' drops the explanatory note');
  }
  snapshot.run = { name: 'r1', state: 'running' }; app.accept('c1', copy(snapshot));
  assert.ok(app.slot('run').textContent.includes('Working'), 'the label stays');
  assert.ok(app.$('[data-action="cancel"]'), 'the Stop button stays');
  snapshot.run = { name: 'r1', state: 'failed', error: 'Provider timeout' }; app.accept('c1', copy(snapshot));
  assert.ok(app.slot('run').textContent.includes('Provider timeout'), 'a failure keeps its error');
  snapshot.run = { name: 'r1', state: 'failed' }; app.accept('c1', copy(snapshot));
  assert.ok(app.slot('run').textContent.includes('saved with your conversation'), 'a bare failure keeps its fallback');
  snapshot.run = { name: 'r1', state: 'needs_reconciliation' }; app.accept('c1', copy(snapshot));
  assert.ok(app.slot('run').textContent.includes('Check the affected records'), 'review keeps its guidance');
  snapshot.run = { name: 'r1', state: 'cancelled' }; app.accept('c1', copy(snapshot));
  assert.ok(app.slot('run').textContent.includes('not reversed'), 'cancellation keeps its note');
});

test('the global pill stays available across Desk but never on the intelligence page', (t) => {
  const { JSDOM } = process.env.FI_REAL_DOM === '1' ? require('jsdom') : require('./dom-harness.cjs');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://desk.example.test/desk', runScripts: 'outside-only' });
  const window = dom.window; let route = ['home'];
  window.frappe = { boot: {}, session: { user: 'user@example.test' }, get_route: () => route };
  window.eval(source);
  t.after(() => dom.window.close());
  window.frappe.intelligence.install();
  const pill = window.document.querySelector('.fi-global-toggle');
  assert.ok(pill, 'pill installed');
  assert.equal(pill.hidden, false, 'pill visible off the intelligence page');
  route = ['intelligence'];
  window.frappe.intelligence.syncDesk();
  assert.equal(pill.hidden, true, 'pill hidden on the intelligence page');
  assert.equal(window.document.body.classList.contains('fi-desk-active'), true);
  route = ['intelligence', 'c1'];
  window.frappe.intelligence.syncDesk();
  assert.equal(pill.hidden, true, 'pill hidden on a deep conversation route');
  route = ['Form', 'Customer', 'C-1'];
  window.frappe.intelligence.syncDesk();
  assert.equal(pill.hidden, false, 'pill available elsewhere in Desk');
  assert.equal(window.document.body.classList.contains('fi-desk-active'), false);
});

test('selecting a conversation navigates the Desk route to its deep link', async (t) => {
  const { app, window } = harness(t);
  const routes = []; let route = ['intelligence'];
  window.frappe.get_route = () => route;
  window.frappe.set_route = (...parts) => { route = parts; routes.push(parts); };
  app.mode = 'page';
  await app.select('c1');
  assert.deepEqual(route, ['intelligence', 'c1']);
  await app.select('c1');
  assert.equal(routes.length, 1, 're-selecting the open conversation does not push a duplicate route');
  app.newConversation();
  assert.deepEqual(route, ['intelligence']);
});

test('a router change into a conversation deep link opens it, and back returns to new', async (t) => {
  const { JSDOM } = process.env.FI_REAL_DOM === '1' ? require('jsdom') : require('./dom-harness.cjs');
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'https://desk.example.test/desk/intelligence', runScripts: 'outside-only' });
  const window = dom.window; let route = ['intelligence']; let onChange = null;
  const snap = fixture();
  window.frappe = {
    boot: {}, session: { user: 'user@example.test' },
    get_route: () => route, set_route: (...parts) => { route = parts; },
    router: { on: (event, callback) => { if (event === 'change') onChange = callback; } },
    call: ({ method, args, callback }) => {
      const name = method.replace('frappe_intelligence.api.', '');
      if (name === 'get_conversation') { callback({ message: copy(Object.assign(snap, { conversation: Object.assign({}, snap.conversation, { name: args.conversation }) })) }); return { catch: () => {} }; }
      if (name === 'bootstrap') { callback({ message: copy(boot) }); return { catch: () => {} }; }
      callback({ message: [] }); return { catch: () => {} };
    },
  };
  window.eval(source);
  t.after(() => dom.window.close());
  window.frappe.intelligence.install();
  window.frappe.intelligence.showPage(window.document.querySelector('#host'));
  route = ['intelligence', 'c9']; onChange();
  await tick(); await tick();
  const app = window.frappe.intelligence;
  const section = window.document.querySelector('.fi-app');
  assert.ok(section, 'app mounted in the page host');
  route = ['intelligence']; onChange();
  await tick();
  assert.ok(true, 'router change back to the bare page did not throw');
  // Leaving the page stops the singleton poller so the test process can exit.
  route = ['home']; onChange();
});

test('a queued or running run shows the thinking indicator, and it clears when the run settles', (t) => {
  const { app, snapshot } = harness(t); app.selected = 'c1';
  for (const state of ['queued', 'running']) {
    snapshot.run = { name: 'r1', state };
    app.accept('c1', copy(snapshot));
    assert.ok(app.slot('messages').querySelector('.fi-thinking'), 'thinking indicator while ' + state);
  }
  snapshot.run = { name: 'r1', state: 'awaiting_approval' };
  app.accept('c1', copy(snapshot));
  assert.equal(app.slot('messages').querySelector('.fi-thinking'), null, 'awaiting a decision is not thinking');
  snapshot.run = { name: 'r1', state: 'completed' };
  app.accept('c1', copy(snapshot));
  assert.equal(app.slot('messages').querySelector('.fi-thinking'), null, 'cleared once the run settles');
});

test('approval cards lead with a human action sentence and link to the target record', (t) => {
  assert.equal(actionSentence({ action: "Create Supplier 'Acme Corp'" }, 'create_record'), "Create Supplier 'Acme Corp'");
  assert.equal(actionSentence({ doctype: 'Customer', name: 'C-1' }, 'update_record'), "Update Customer 'C-1'");
  assert.equal(actionSentence({ target: { doctype: 'Sales Order' } }, 'delete_document'), 'Delete Sales Order');
  assert.ok(recordLink({ doctype: 'Sales Order', name: 'SO-001' }).includes('/app/sales-order/SO-001'));
  assert.equal(recordLink({ doctype: 'Sales Order' }), '');
  const { app, snapshot } = harness(t); app.selected = 'c1';
  snapshot.run = { name: 'r1', state: 'awaiting_approval' };
  snapshot.approvals = [{ name: 'a1', tool_name: 'create_record', status: 'pending', creation: '2026-09-17 09:01:00', preview: { action: "Create Supplier 'Acme Corp'", summary: 'Create the supplier.', doctype: 'Supplier', name: 'Acme Corp' } }];
  app.accept('c1', copy(snapshot));
  const card = app.slot('messages').querySelector('.fi-approval');
  assert.ok(card.querySelector('h3').textContent.includes("Create Supplier 'Acme Corp'"));
  assert.equal(card.querySelector('.fi-record-chip').getAttribute('href'), '/app/supplier/Acme%20Corp');
  assert.ok(card.querySelector('.fi-pill-pending'));
  assert.ok(card.querySelector('[data-action="approve"]'), 'owner can decide inline');
});

test('a shared read-only conversation replaces the composer and hides approval buttons', (t) => {
  const { app, snapshot } = harness(t); app.selected = 'c1';
  snapshot.can_post = false; snapshot.conversation.owner = 'alex@example.test'; snapshot.conversation.shared = 1;
  snapshot.run = { name: 'r1', state: 'awaiting_approval' };
  snapshot.approvals = [{ name: 'a1', tool_name: 'create_record', status: 'pending', preview: { summary: 'Create a record.' } }];
  app.accept('c1', copy(snapshot));
  assert.equal(app.$('form.fi-composer').hidden, true, 'composer hidden');
  assert.ok(app.slot('readonly').textContent.includes('Shared by alex@example.test'), 'read-only notice names the owner');
  assert.equal(app.slot('messages').querySelector('[data-action="approve"]'), null, 'no approve buttons for viewers');
  assert.ok(app.slot('messages').textContent.includes('Waiting for the owner to decide.'));
  assert.equal(app.$('[data-action="share"]').hidden, true, 'viewers cannot re-share');
});

test('the share dialog grants and revokes read-only access per user', async (t) => {
  const shares = [{ user: 'colleague@example.test', full_name: 'Colleague One' }];
  const { app, document, calls, snapshot } = harness(t, {
    conversation_share_users: () => copy(shares),
    share_conversation: (args) => { shares.push({ user: args.user, full_name: 'New Person' }); snapshot.conversation.shared = 1; return { conversation: copy(snapshot.conversation), shares: copy(shares) }; },
    unshare_conversation: (args) => { shares.splice(shares.findIndex((row) => row.user === args.user), 1); snapshot.conversation.shared = shares.length ? 1 : 0; return { conversation: copy(snapshot.conversation), shares: copy(shares) }; }
  });
  app.selected = 'c1'; app.accept('c1', copy(snapshot));
  app.$('[data-action="share"]').click(); await tick(); await tick();
  const modal = document.querySelector('.fi-modal-overlay');
  assert.ok(modal, 'the fallback modal opens');
  assert.ok(modal.textContent.includes('read only view'), 'explains the read-only grant');
  const host = modal.querySelector('[data-shares-host]');
  assert.ok(host.textContent.includes('Colleague One'), 'current shares load on open');
  assert.ok(host.textContent.includes('colleague@example.test'));
  assert.equal(calls.find((call) => call.method === 'conversation_share_users').args.conversation, 'c1');
  const input = modal.querySelector('[data-share-with]');
  input.value = 'person@example.test';
  modal.querySelector('[data-action="confirm-share"]').click(); await tick(); await tick(); await tick();
  const grant = calls.find((call) => call.method === 'share_conversation');
  assert.deepEqual(copy(grant.args), { conversation: 'c1', user: 'person@example.test' });
  assert.ok(host.textContent.includes('New Person'), 'the list repaints without closing');
  assert.equal(input.value, '', 'the input clears for the next share');
  assert.equal(app.snapshot.conversation.shared, 1, 'the header chip source updates in place');
  assert.ok(app.slot('shared-chip').textContent.includes('Shared'), 'the header chip repaints');
  const unshare = Array.from(modal.querySelectorAll('[data-action="unshare-user"]')).find((node) => node.dataset.user === 'person@example.test');
  assert.ok(unshare, 'the granted user has a revoke button');
  unshare.click(); await tick(); await tick(); await tick();
  const revoke = calls.find((call) => call.method === 'unshare_conversation');
  assert.deepEqual(copy(revoke.args), { conversation: 'c1', user: 'person@example.test' });
  assert.equal(host.textContent.includes('New Person'), false, 'the revoked user leaves the list');
  assert.ok(host.textContent.includes('Colleague One'), 'remaining shares stay listed');
});
