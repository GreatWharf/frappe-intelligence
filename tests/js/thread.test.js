'use strict';
/* Thread surface: markdown hardening, tool rows, grouped and scoped approvals. */
const test = require('node:test');
const assert = require('node:assert/strict');
const client = require('./load.cjs').load();
const { markdown, mdURL, gerund, isAutoApproved, safeURL } = client.utils;
const { autoTag } = client;
const source = require('./load.cjs').source();
const tick = () => new Promise((resolve) => setImmediate(resolve));
const copy = (value) => JSON.parse(JSON.stringify(value));
const boot = { enabled: true, is_manager: true, user: 'owner@example.test', providers: [{ name: 'p1', title: 'Work', kind: 'OpenAI', model: 'configured-model', thinking_effort: 'Medium' }], defaults: { max_upload_mb: 10, approval_mode: 'Approve Every Step' }, capabilities: { attachments: true, memory: true } };
function fixture() {
  return { conversation: { name: 'c1', title: 'Private chat', provider: 'p1', archived: 0, owner: 'owner@example.test', shared: 0 }, messages: [{ name: 'm1', role: 'user', content: 'Hello', status: 'complete', creation: '2026-09-17 09:00:00' }], approvals: [], files: [], run: null, can_post: true };
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
    if (method === 'decide_approvals' || method === 'approve') return { ok: true };
    throw new Error('Unmocked method ' + method);
  };
  const app = new window.frappe.intelligence.App({ api, document: window.document });
  window.document.querySelector('#host').appendChild(app.root);
  app.boot = copy(boot); app.provider = 'p1'; app.render();
  t.after(() => { app.poller.stop(); window.clearTimeout(app.searchTimer); dom.window.close(); });
  return { app, window, document: window.document, calls, snapshot };
}
const toolRun = (rows) => rows.map((row, index) => Object.assign({ name: 'a' + (index + 1), status: 'succeeded', creation: '2026-09-17 09:0' + (index + 1) + ':00' }, row));

test('markdown links only allow https:, mailto: and same-page fragments', () => {
  assert.equal(mdURL('https://example.com/page'), 'https://example.com/page');
  assert.equal(mdURL('mailto:owner@example.test'), 'mailto:owner@example.test');
  assert.equal(mdURL('#summary'), '#summary');
  for (const hostile of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'http://example.com', '//evil.test/x', 'file:///etc/passwd', ' vbscript:x ', 'https://user:pass@example.test/x', '#" onclick="alert(1)'])
    assert.equal(mdURL(hostile), '', hostile + ' is refused');
});

test('hostile markdown fixtures never produce executable markup', () => {
  const vectors = [
    ['[click](javascript:alert(1))', 'javascript:'],
    ['[click](data:text/html;base64,PHNjcmlwdD4=)', 'data:'],
    ['<img src=x onerror=alert(1)>', '<img'],
    ['[x](https://example.test/" onclick="alert(1)")', '" onclick'],
    ['before <script>alert(1)</script> after', '<script'],
    ['<script><script>alert(1)</script></script>', '<script'],
    ['<style>body{display:none}</style>text', '<style'],
    ['<iframe src="https://evil.test"></iframe>', '<iframe'],
    ['<object data="x"></object><embed src="x"><form action="https://evil.test">', '<object'],
  ];
  for (const [input, needle] of vectors) {
    const html = markdown(input);
    assert.ok(!html.includes(needle), needle + ' never appears in: ' + html);
  }
  assert.ok(!markdown('[click](javascript:alert(1))').includes('<a '), 'blocked link renders as plain text');
  assert.ok(markdown('[click](javascript:alert(1))').includes('click'), 'link text survives');
  const image = markdown('![diagram](https://example.test/x.png)');
  assert.ok(!image.includes('<img'), 'no image element is emitted');
  const ok = markdown('[docs](https://example.test)');
  assert.ok(ok.includes('target="_blank"') && ok.includes('rel="noopener noreferrer"'), 'safe links open isolated');
  assert.ok(markdown('[jump](#top)').includes('href="#top"'), 'same-page fragments stay anchored');
  const fused = markdown('run <script>alert(1)</script> now');
  assert.ok(fused.includes('run') && fused.includes('now') && !fused.includes('script'), 'blocked pair removed, prose kept');
});

test('fenced code keeps blocked markup as escaped literal text', () => {
  const html = markdown('```html\n<script>alert(1)</script>\n```');
  assert.ok(!html.includes('<script'), 'no live script element');
  assert.ok(html.includes('&lt;script&gt;'), 'escaped text kept inside the fence');
});

test('multi-line blocked elements swallow their body across lines', () => {
  const leaked = markdown('<script>\nalert(document.cookie)\n</script>');
  assert.ok(!leaked.includes('alert'), 'the script body never leaks as text: ' + leaked);
  assert.ok(!leaked.includes('<script'), 'no live tag');
  const styled = markdown('intro\n<style>\nbody{display:none}\n</style>\noutro');
  assert.ok(!styled.includes('display:none'), 'style body swallowed');
  assert.ok(styled.includes('intro') && styled.includes('outro'), 'surrounding prose survives');
  const framed = markdown('<iframe src="https://evil.test">\nfallback text\n</iframe> rest');
  assert.ok(!framed.includes('fallback text'), 'iframe fallback swallowed');
  assert.ok(framed.includes('rest'), 'text after the close tag survives');
  const formed = markdown('<form action="https://evil.test">\n<input name="password">\n</form>');
  assert.ok(!formed.includes('password'), 'form contents swallowed');
  const unclosed = markdown('<script>\nalert(1)\ntrailing prose');
  assert.ok(!unclosed.includes('alert') && !unclosed.includes('trailing'), 'an unclosed blocked element swallows to the end');
});

test('safeURL restricts external targets to https: and keeps internal paths', () => {
  assert.equal(safeURL('https://files.example.test/x.pdf'), 'https://files.example.test/x.pdf');
  assert.equal(safeURL('http://files.example.test/x.pdf'), '', 'plain http is refused');
  assert.equal(safeURL('ftp://files.example.test/x'), '', 'other schemes refused');
  assert.equal(safeURL('/files/report.pdf'), '/files/report.pdf');
  assert.equal(safeURL('/app/sales-invoice/INV-1'), '/app/sales-invoice/INV-1');
  assert.equal(safeURL('/etc/passwd'), '', 'unexpected internal paths refused');
  assert.equal(safeURL('//evil.test/x'), '', 'protocol-relative refused');
  assert.equal(safeURL('https://user:pass@example.test/x'), '', 'userinfo refused');
});

test('a resolved row announces its status word in the row label', (t) => {
  const { app, snapshot } = harness(t); app.selected = 'c1';
  snapshot.run = { name: 'r1', state: 'completed' };
  snapshot.approvals = toolRun([
    { tool_name: 'search_records', status: 'succeeded', preview: { summary: 'Search Supplier records.', operation: 'search', target: { doctype: 'Supplier' } } },
    { tool_name: 'update_record', status: 'failed', creation: '2026-09-17 09:02:00', preview: { action: "Update Supplier 'Acme Corp'", summary: 'Update it.', doctype: 'Supplier', name: 'Acme Corp' } },
  ]);
  app.accept('c1', copy(snapshot));
  const group = app.slot('messages').querySelector('.fi-tool-group');
  group.querySelector('.fi-tool-group-head').click();
  const rows = group.querySelectorAll('.fi-tool-row');
  assert.ok(rows[0].getAttribute('aria-label').endsWith(', done'), 'succeeded row says done');
  assert.ok(rows[1].getAttribute('aria-label').endsWith(', failed'), 'failed row says failed');
  assert.equal(rows[0].querySelector('.fi-tool-done').getAttribute('role'), 'img', 'status icon exposes a role');
});

test('tables render inside a horizontal-scroll wrapper', () => {
  const html = markdown('| A | B |\n| --- | --- |\n| 1 | 2 |');
  assert.ok(html.startsWith('<div class="fi-table-wrap"><table>'), 'wrapper present');
});

test('gerund labels and auto-approval detection helpers', () => {
  assert.equal(gerund('Search Supplier records'), 'Searching Supplier records');
  assert.equal(gerund("Read Supplier 'Acme Corp'"), "Reading Supplier 'Acme Corp'");
  assert.equal(gerund('Delete Invoice INV-1'), 'Deleting Invoice INV-1');
  assert.equal(gerund('Anything else'), 'Anything else');
  assert.ok(isAutoApproved({ status: 'succeeded', decided_by: '', source: 'policy:Read auto-approve' }));
  assert.ok(isAutoApproved({ status: 'approved', decided_by: '', source: 'grant:g1' }));
  assert.ok(!isAutoApproved({ status: 'pending', decided_by: '', source: 'policy:p' }), 'pending is never auto');
  assert.ok(!isAutoApproved({ status: 'succeeded' }), 'missing fields stay manual');
  assert.ok(!isAutoApproved({ status: 'succeeded', decided_by: '', source: '' }), 'empty source stays manual');
  assert.ok(!isAutoApproved({ status: 'succeeded', decided_by: 'owner@example.test', source: 'policy:p' }), 'a recorded decider stays manual');
  assert.equal(autoTag('policy:Read auto-approve'), 'Auto-approved by policy');
  assert.equal(autoTag('grant:g1'), 'Auto-approved by grant');
});

test('a single resolved action renders as one tool row with a gerund label', (t) => {
  const { app, snapshot } = harness(t); app.selected = 'c1';
  snapshot.run = { name: 'r1', state: 'completed' };
  snapshot.approvals = toolRun([
    { tool_name: 'search_records', preview: { summary: 'Search permitted Supplier records.', operation: 'search', target: { doctype: 'Supplier' }, details: { limit: 5 } } },
  ]);
  app.accept('c1', copy(snapshot));
  const messages = app.slot('messages');
  assert.equal(messages.querySelectorAll('.fi-tool-group').length, 0, 'one action never groups');
  const block = messages.querySelector('.fi-tool-block');
  assert.ok(block, 'single tool row rendered');
  const row = block.querySelector('.fi-tool-row');
  assert.ok(row.querySelector('.fi-tool-label').textContent.includes('Searching Supplier records'));
  assert.ok(row.querySelector('.fi-tool-context').textContent.includes('Supplier'));
  assert.ok(row.querySelector('.fi-tool-status .fi-tool-done'), 'resolved row carries a tick');
  assert.equal(row.getAttribute('aria-expanded'), 'false');
  assert.ok(block.querySelector('.fi-tool-detail').hidden, 'detail collapsed by default');
  row.click();
  assert.equal(row.getAttribute('aria-expanded'), 'true');
  assert.ok(!block.querySelector('.fi-tool-detail').hidden, 'row expands in place');
  assert.ok(block.querySelector('.fi-tool-args'), 'args grid in the detail');
  app.accept('c1', copy(snapshot));
  assert.equal(app.slot('messages').querySelector('.fi-tool-row').getAttribute('aria-expanded'), 'true', 'expansion survives re-renders');
});

test('consecutive resolved actions collapse into a group; delete actions are flagged', (t) => {
  const { app, snapshot } = harness(t); app.selected = 'c1';
  snapshot.run = { name: 'r1', state: 'completed' };
  snapshot.approvals = toolRun([
    { tool_name: 'search_records', preview: { summary: 'Search permitted Supplier records.', operation: 'search', target: { doctype: 'Supplier' } } },
    { tool_name: 'delete_record', preview: { action: "Delete Supplier 'Old Corp'", summary: 'Delete it.', doctype: 'Supplier', name: 'Old Corp', operation: 'delete' } },
  ]);
  app.accept('c1', copy(snapshot));
  const group = app.slot('messages').querySelector('.fi-tool-group');
  assert.ok(group, 'consecutive actions collapse');
  assert.ok(group.querySelector('.fi-tool-group-head').textContent.includes('Used 2 tools'));
  group.querySelector('.fi-tool-group-head').click();
  const rows = group.querySelectorAll('.fi-tool-row');
  assert.equal(rows.length, 2);
  assert.ok(rows[1].querySelector('.fi-tool-alert'), 'delete-implying action carries the alert icon');
  assert.ok(!rows[0].querySelector('.fi-tool-alert'), 'search action does not');
});

test('auto-approved actions render as collapsed rows with a muted tag', (t) => {
  const { app, snapshot } = harness(t); app.selected = 'c1';
  snapshot.run = { name: 'r1', state: 'completed' };
  snapshot.approvals = toolRun([
    { tool_name: 'read_record', status: 'approved', decided_by: '', source: 'policy:Read auto-approve', preview: { summary: "Read Supplier 'Acme Corp'.", operation: 'read', target: { doctype: 'Supplier', name: 'Acme Corp' } } },
    { tool_name: 'search_records', preview: { summary: 'Search permitted Item records.', operation: 'search', target: { doctype: 'Item' } } },
  ]);
  app.accept('c1', copy(snapshot));
  const group = app.slot('messages').querySelector('.fi-tool-group');
  assert.ok(group, 'auto-approved rows join the sealed group');
  group.querySelector('.fi-tool-group-head').click();
  const rows = group.querySelectorAll('.fi-tool-block');
  assert.ok(rows[0].classList.contains('fi-tool-auto'), 'auto row flagged');
  assert.equal(rows[0].querySelector('.fi-tool-tag').textContent, 'Auto-approved by policy');
  assert.ok(rows[0].querySelector('.fi-tool-detail'), 'full preview stays one toggle away');
  assert.ok(!rows[1].classList.contains('fi-tool-auto'), 'manually approved row has no tag');
  assert.ok(!rows[1].querySelector('.fi-tool-tag'));
});

test('assistant narration lands before the tool row it announces', (t) => {
  const { app, snapshot } = harness(t); app.selected = 'c1';
  snapshot.run = { name: 'r1', state: 'completed' };
  snapshot.messages.push({ name: 'm2', role: 'assistant', content: 'Let me look that up.', status: 'complete', creation: '2026-09-17 09:00:30' });
  snapshot.approvals = toolRun([
    { tool_name: 'search_records', creation: '2026-09-17 09:01:00', preview: { summary: 'Search permitted Supplier records.', operation: 'search', target: { doctype: 'Supplier' } } },
  ]);
  app.accept('c1', copy(snapshot));
  const kinds = Array.from(app.slot('messages').children).map((node) => node.classList.contains('fi-message-assistant') ? 'prose' : node.classList.contains('fi-tool-block') ? 'row' : '').filter(Boolean);
  assert.deepEqual(kinds, ['prose', 'row'], 'prose precedes the tool row in the DOM');
});

test('multiple pending approvals collapse into one grouped card', async (t) => {
  const { app, snapshot, calls } = harness(t); app.selected = 'c1';
  snapshot.run = { name: 'r1', state: 'awaiting_approval' };
  snapshot.approvals = toolRun([
    { tool_name: 'create_record', status: 'pending', preview: { action: "Create Supplier 'Acme Corp'", summary: 'Create the supplier.', doctype: 'Supplier', name: 'Acme Corp' } },
    { tool_name: 'update_record', status: 'pending', preview: { action: "Update Supplier 'Acme Corp'", summary: 'Update it.', doctype: 'Supplier', name: 'Acme Corp' } },
    { tool_name: 'delete_record', status: 'pending', preview: { action: "Delete Supplier 'Old Corp'", summary: 'Delete it.', doctype: 'Supplier', name: 'Old Corp' } },
  ]);
  app.accept('c1', copy(snapshot));
  const messages = app.slot('messages');
  assert.equal(messages.querySelectorAll('.fi-approval').length, 1, 'one grouped card for the run');
  const card = messages.querySelector('.fi-approval-bulk');
  assert.ok(card);
  assert.ok(card.textContent.includes('3 actions need your approval'));
  const rows = card.querySelectorAll('.fi-bulk-row');
  assert.equal(rows.length, 3);
  assert.ok(rows[0].querySelector('.fi-bulk-summary').textContent.includes("Create Supplier 'Acme Corp'"));
  assert.ok(rows[0].querySelector('[data-action="approve"]') && rows[0].querySelector('[data-action="deny"]'), 'each row decides on its own');
  const remember = card.querySelector('[data-input="bulk-remember"]');
  assert.ok(remember, 'remember checkbox rendered');
  assert.equal(remember.checked, false, 'remember starts unchecked');
  assert.ok(card.querySelector('[data-action="approve-all"]').textContent.includes('Approve all 3'));
  card.querySelector('[data-action="approve-all"]').click();
  await tick(); await tick();
  const bulk = calls.find((call) => call.method === 'decide_approvals');
  assert.ok(bulk, 'bulk endpoint called once');
  assert.deepEqual(JSON.parse(bulk.args.names), ['a1', 'a2', 'a3']);
  assert.equal(bulk.args.decision, 'approve', 'unchecked bulk approve stays one-off');
  assert.equal(bulk.args.scope, undefined, 'no scope means no grant server-side');
});

test('checked remember box upgrades a bulk approve to a conversation grant; deny never grants', async (t) => {
  const { app, snapshot, calls } = harness(t); app.selected = 'c1';
  snapshot.run = { name: 'r1', state: 'awaiting_approval' };
  snapshot.approvals = toolRun([
    { tool_name: 'create_record', status: 'pending', preview: { action: "Create Supplier 'Acme Corp'", summary: 'Create it.', doctype: 'Supplier', name: 'Acme Corp' } },
    { tool_name: 'update_record', status: 'pending', preview: { action: "Update Supplier 'Acme Corp'", summary: 'Update it.', doctype: 'Supplier', name: 'Acme Corp' } },
  ]);
  app.accept('c1', copy(snapshot));
  const card = app.slot('messages').querySelector('.fi-approval-bulk');
  const remember = card.querySelector('[data-input="bulk-remember"]');
  remember.checked = true;
  card.querySelector('[data-action="approve-all"]').click();
  await tick(); await tick();
  const granted = calls.find((call) => call.method === 'decide_approvals');
  assert.equal(granted.args.decision, 'always');
  assert.equal(granted.args.scope, 'This Conversation');
  assert.ok((app.notice || '').includes('in this conversation'), 'conversation-scoped banner');
  app.accept('c1', copy(snapshot));
  const again = app.slot('messages').querySelector('.fi-approval-bulk');
  again.querySelector('[data-input="bulk-remember"]').checked = true;
  again.querySelector('[data-action="deny-all"]').click();
  await tick(); await tick();
  const denied = calls.filter((call) => call.method === 'decide_approvals').pop();
  assert.equal(denied.args.decision, 'deny', 'deny stays deny');
  assert.equal(denied.args.scope, undefined, 'a checked box never turns a deny into a grant');
});

test('a failed action shows its error in an alert block inside the detail', (t) => {
  const { app, snapshot } = harness(t); app.selected = 'c1';
  snapshot.run = { name: 'r1', state: 'completed' };
  snapshot.approvals = toolRun([
    { tool_name: 'update_record', status: 'failed', error: 'Delivery date cannot be in the past.', preview: { action: "Update Sales Order 'SO-DEMO-1042'", summary: 'Update it.', doctype: 'Sales Order', name: 'SO-DEMO-1042' } },
  ]);
  app.accept('c1', copy(snapshot));
  const block = app.slot('messages').querySelector('.fi-tool-block');
  assert.ok(block.querySelector('.fi-tool-status .fi-tool-failed'), 'failed row carries an x');
  block.querySelector('.fi-tool-row').click();
  const error = block.querySelector('.fi-tool-error');
  assert.ok(error, 'error block rendered');
  assert.equal(error.getAttribute('role'), 'alert');
  assert.ok(error.textContent.includes('Delivery date cannot be in the past.'));
  assert.ok(block.querySelector('.fi-tool-raw'), 'technical details stay available');
});

test('a single pending card offers a conversation-scoped approval', async (t) => {
  const { app, snapshot, calls } = harness(t); app.selected = 'c1';
  snapshot.run = { name: 'r1', state: 'awaiting_approval' };
  snapshot.approvals = toolRun([
    { tool_name: 'create_record', status: 'pending', preview: { action: "Create Supplier 'Acme Corp'", summary: 'Create it.', doctype: 'Supplier', name: 'Acme Corp' } },
  ]);
  app.accept('c1', copy(snapshot));
  const card = app.slot('messages').querySelector('.fi-approval.is-pending');
  const button = card.querySelector('[data-action="conversation"]');
  assert.ok(button, 'For this conversation button rendered');
  assert.ok(button.title.includes('in this conversation'), 'scope tooltip');
  assert.ok(card.querySelector('[data-action="always"]').title.includes('every conversation'), 'always tooltip');
  button.click();
  await tick(); await tick();
  const call = calls.find((entry) => entry.method === 'approve');
  assert.equal(call.args.approval, 'a1');
  assert.equal(call.args.decision, 'always');
  assert.equal(call.args.scope, 'This Conversation');
  assert.ok((app.notice || '').includes('will not ask again in this conversation'), 'scoped banner text');
});
