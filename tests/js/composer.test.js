'use strict';
/* Composer: provider, model and effort pickers, attachment chips, send payload. */
const test = require('node:test');
const assert = require('node:assert/strict');
const client = require('./load.cjs').load();
const source = require('./load.cjs').source();
const { fileSize } = client.utils;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const copy = (value) => JSON.parse(JSON.stringify(value));
const boot = {
  enabled: true, is_manager: true, user: 'owner@example.test',
  providers: [
    { name: 'p1', title: 'Work', kind: 'OpenAI', model: 'gpt-4.1', thinking_effort: 'Medium', models: 'gpt-4.1\ngpt-4.1-mini\ngpt-4o\ngpt-4o-mini\no1\no3\no3-mini\no4-mini\ngpt-3.5-turbo' },
    { name: 'p2', title: 'Personal', kind: 'Custom', model: 'kimi-k3', models: '' },
  ],
  defaults: { max_upload_mb: 10, approval_mode: 'Approve Every Step' }, capabilities: { attachments: true, memory: true },
};
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
    throw new Error('Unmocked method ' + method);
  };
  const app = new window.frappe.intelligence.App({ api, document: window.document });
  window.document.querySelector('#host').appendChild(app.root);
  app.boot = copy(boot); app.provider = 'p1'; app.render();
  t.after(() => { app.poller.stop(); window.clearTimeout(app.searchTimer); dom.window.close(); });
  return { app, window, document: window.document, calls, snapshot };
}
const key = (window, node, value) => node.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
const pickers = (app, name) => app.$('[data-picker="' + name + '"]');
const button = (app, name) => app.$('[data-picker-btn="' + name + '"]');
const menu = (app, name) => app.$('[data-picker-menu="' + name + '"]');
const options = (app, name) => Array.from(app.$('[data-picker-options="' + name + '"]').querySelectorAll('[data-picker-option]'));
function type(app, window, text) { const field = app.$('textarea'); field.value = text; field.dispatchEvent(new window.Event('input', { bubbles: true })); }

test('file sizes format defensively', () => {
  assert.equal(fileSize(0), '');
  assert.equal(fileSize(undefined), '');
  assert.equal(fileSize('oops'), '');
  assert.equal(fileSize(512), '1 KB');
  assert.equal(fileSize(2500), '3 KB');
  assert.equal(fileSize(7340032), '7 MB');
  assert.equal(fileSize(1572864), '1.5 MB');
});

test('provider and model pickers replace the native select', (t) => {
  const { app } = harness(t);
  const select = app.$('[data-input="provider"]');
  assert.ok(select.classList.contains('fi-select-hidden'), 'native select visually retired');
  assert.equal(select.getAttribute('aria-hidden'), 'true');
  assert.ok(app.$('.fi-pickers'), 'picker host rendered');
  assert.ok(pickers(app, 'provider') && pickers(app, 'model'), 'both dropdowns present');
  assert.equal(button(app, 'provider').getAttribute('aria-haspopup'), 'listbox');
  assert.ok(button(app, 'provider').textContent.includes('Work'), 'provider button shows the title');
  assert.ok(button(app, 'model').textContent.includes('gpt-4.1'), 'model button shows the default model');
});

test('provider menu opens upward with listbox semantics and picks a provider', (t) => {
  const { app, window } = harness(t);
  const btn = button(app, 'provider');
  btn.click();
  assert.equal(menu(app, 'provider').hidden, false, 'menu opens');
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  const list = app.$('[data-picker-options="provider"]');
  assert.equal(list.getAttribute('role'), 'listbox');
  const rows = options(app, 'provider');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].getAttribute('role'), 'option');
  assert.equal(rows[0].getAttribute('aria-selected'), 'true', 'current provider marked');
  assert.ok(rows[0].querySelector('.fi-dropdown-check .fi-icon'), 'check on the selected row');
  assert.ok(rows[0].textContent.includes('gpt-4.1'), 'provider row hints at its model');
  assert.equal(rows[1].getAttribute('aria-selected'), 'false');
  app.draft().model = 'stale-model';
  rows[1].click();
  assert.equal(app.provider, 'p2', 'provider switches');
  assert.equal(app.$('[data-input="provider"]').value, 'p2', 'hidden select stays in sync');
  assert.equal(app.draft().model, '', 'stale model choice resets on provider switch');
  assert.equal(menu(app, 'provider').hidden, true, 'menu closes after a pick');
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  assert.equal(window.document.activeElement, btn, 'focus returns to the button');
});

test('dropdown keyboard: arrows move, Enter picks, Escape closes', (t) => {
  const { app, window } = harness(t);
  const btn = button(app, 'provider');
  key(window, btn, 'ArrowDown');
  assert.equal(menu(app, 'provider').hidden, false, 'ArrowDown opens the menu');
  key(window, app.$('[data-picker-search="provider"]') || btn, 'ArrowDown');
  let rows = options(app, 'provider');
  assert.ok(rows[1].classList.contains('is-active'), 'active row moves down');
  key(window, btn, 'ArrowUp');
  rows = options(app, 'provider');
  assert.ok(rows[0].classList.contains('is-active'), 'active row moves up');
  key(window, btn, 'ArrowDown');
  key(window, btn, 'Enter');
  assert.equal(app.provider, 'p2', 'Enter picks the active row');
  assert.equal(menu(app, 'provider').hidden, true);
  key(window, btn, 'ArrowDown');
  assert.equal(menu(app, 'provider').hidden, false);
  key(window, btn, 'Escape');
  assert.equal(menu(app, 'provider').hidden, true, 'Escape closes');
  assert.equal(window.document.activeElement, btn, 'Escape refocuses the button');
  assert.equal(app.provider, 'p2', 'Escape does not change the value');
});

test('menus over seven rows offer search that filters options', (t) => {
  const { app, window } = harness(t);
  button(app, 'provider').click();
  assert.ok(!app.$('[data-picker-search="provider"]'), 'two providers: no search box');
  button(app, 'provider').click();
  button(app, 'model').click();
  const search = app.$('[data-picker-search="model"]');
  assert.ok(search, 'nine-model catalog gets a search box');
  assert.equal(window.document.activeElement, search, 'search box takes focus');
  search.value = 'mini';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  const rows = options(app, 'model');
  assert.equal(rows.length, 4, 'filter narrows the list');
  assert.ok(rows.every((row) => row.textContent.toLowerCase().includes('mini')));
  search.value = 'zzzz';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(options(app, 'model').length, 0);
  assert.ok(app.$('[data-picker-options="model"]').textContent.includes('No matches'));
});

test('model menu marks the default and empty catalogs offer a custom model row', (t) => {
  const { app, window } = harness(t);
  button(app, 'model').click();
  let rows = options(app, 'model');
  assert.equal(rows.length, 9, 'catalog rows listed');
  assert.equal(rows[0].getAttribute('aria-selected'), 'true', 'default checked');
  assert.ok(rows[0].textContent.includes('Default'));
  button(app, 'model').click();
  // Switch to the provider with no stored catalog.
  button(app, 'provider').click();
  options(app, 'provider')[1].click();
  assert.ok(button(app, 'model').textContent.includes('kimi-k3'), 'configured model is the only default');
  button(app, 'model').click();
  rows = options(app, 'model');
  assert.equal(rows.length, 2, 'default entry plus the custom row');
  assert.equal(rows[0].getAttribute('aria-selected'), 'true');
  assert.ok(rows[1].textContent.includes('Custom model ID'), 'custom row offered');
  rows[1].click();
  const custom = app.$('[data-picker-custom]');
  assert.ok(custom, 'inline input revealed');
  custom.value = 'my-fine-tune-9';
  key(window, custom, 'Enter');
  assert.equal(app.draft().model, 'my-fine-tune-9');
  assert.ok(button(app, 'model').textContent.includes('my-fine-tune-9'), 'button shows the custom model');
  button(app, 'model').click();
  rows = options(app, 'model');
  assert.ok(rows.some((row) => row.dataset.value === 'my-fine-tune-9' && row.getAttribute('aria-selected') === 'true'), 'custom value listed and checked');
});

test('the provider picker locks mid-conversation while model and effort stay live', (t) => {
  const { app, snapshot } = harness(t);
  app.selected = 'c1';
  app.accept('c1', copy(snapshot));
  assert.equal(button(app, 'provider').disabled, true, 'provider stays locked');
  assert.equal(button(app, 'model').disabled, false, 'model can change mid-conversation');
  assert.equal(button(app, 'effort').disabled, false, 'effort can change mid-conversation');
  assert.ok(button(app, 'provider').title.includes('original provider'), 'existing tooltip kept');
});

test('picking a model mid-conversation persists it and merges the reply', async (t) => {
  const { app, snapshot, calls } = harness(t, {
    set_conversation_model: (args) => ({ name: 'c1', title: 'Private chat', provider: 'p1', model: args.model, effort: '', owner: 'owner@example.test', shared: 0, archived: 0 }),
  });
  app.selected = 'c1';
  app.accept('c1', copy(snapshot));
  const btn = button(app, 'model');
  assert.equal(btn.disabled, false, 'model picker stays live');
  assert.equal(btn.title, 'Change the model for this conversation');
  assert.ok(btn.textContent.includes('gpt-4.1'), 'unset conversation model falls back to the provider default');
  btn.click();
  const rows = options(app, 'model');
  assert.equal(rows.length, 9, 'catalog rows listed');
  assert.equal(rows[0].getAttribute('aria-selected'), 'true', 'provider default current while unset');
  rows[2].click();
  assert.equal(menu(app, 'model').hidden, true, 'menu closes after the pick');
  for (let index = 0; index < 20 && !calls.some((call) => call.method === 'set_conversation_model'); index++) await tick();
  await tick(); await tick();
  const call = calls.find((entry) => entry.method === 'set_conversation_model');
  assert.deepEqual(copy(call.args), { conversation: 'c1', provider: 'p1', model: 'gpt-4o' });
  assert.equal(app.snapshot.conversation.model, 'gpt-4o', 'reply merged into the snapshot');
  assert.ok(button(app, 'model').textContent.includes('gpt-4o'), 'button repaints from the merged snapshot');
  assert.ok(!app.draft().model, 'no draft override is stashed for an open conversation');
});

test('a custom model mid-conversation persists through the same setter', async (t) => {
  const { app, window, snapshot, calls } = harness(t, {
    set_conversation_model: (args) => ({ name: 'c1', title: 'Private chat', provider: args.provider, model: args.model, effort: '', owner: 'owner@example.test', shared: 0, archived: 0 }),
  });
  snapshot.conversation.provider = 'p2';
  app.selected = 'c1';
  app.accept('c1', copy(snapshot));
  assert.equal(app.provider, 'p2', 'the conversation provider wins');
  button(app, 'model').click();
  const rows = options(app, 'model');
  assert.equal(rows.length, 2, 'no catalog: default row plus the custom row');
  rows[1].click();
  const custom = app.$('[data-picker-custom]');
  assert.ok(custom, 'inline input revealed mid-conversation');
  custom.value = 'my-fine-tune-9';
  key(window, custom, 'Enter');
  for (let index = 0; index < 20 && !calls.some((call) => call.method === 'set_conversation_model'); index++) await tick();
  await tick(); await tick();
  const call = calls.find((entry) => entry.method === 'set_conversation_model');
  assert.deepEqual(copy(call.args), { conversation: 'c1', provider: 'p2', model: 'my-fine-tune-9' });
  assert.equal(app.snapshot.conversation.model, 'my-fine-tune-9');
  assert.ok(button(app, 'model').textContent.includes('my-fine-tune-9'), 'button shows the persisted custom model');
});

test('the effort picker lists every effort with the provider default hinted', (t) => {
  const { app } = harness(t);
  const btn = button(app, 'effort');
  assert.ok(btn, 'effort picker rendered next to provider and model');
  assert.equal(btn.getAttribute('aria-label'), 'Reasoning effort');
  assert.equal(btn.title, 'Reasoning effort for the next run');
  assert.ok(btn.textContent.includes('Medium'), 'provider default effort shown on the button');
  btn.click();
  assert.equal(menu(app, 'effort').hidden, false, 'menu opens');
  const list = app.$('[data-picker-options="effort"]');
  assert.equal(list.getAttribute('role'), 'listbox');
  assert.equal(list.getAttribute('aria-label'), 'Reasoning effort');
  const rows = options(app, 'effort');
  assert.deepEqual(rows.map((row) => row.dataset.value), ['Auto', 'Low', 'Medium', 'High', 'Max']);
  assert.equal(rows[2].getAttribute('aria-selected'), 'true', 'the provider default is the current value');
  assert.ok(rows[2].textContent.includes('Default'), 'provider default hinted');
  assert.equal(rows[0].getAttribute('aria-selected'), 'false');
  assert.ok(!rows[0].textContent.includes('Default'), 'other rows unhinted');
  assert.equal(btn.getAttribute('aria-activedescendant'), 'fi-picker-effort-2', 'the default row is announced');
  assert.ok(!app.$('[data-picker-search="effort"]'), 'five rows: no search box');
});

test('a fresh effort choice rides the send payload and clears afterwards', async (t) => {
  const { app, window, calls } = harness(t);
  button(app, 'effort').click();
  options(app, 'effort')[3].click();
  assert.equal(app.draft().effort, 'High', 'the pick lands on the draft');
  assert.ok(button(app, 'effort').textContent.includes('High'), 'button shows the pick');
  type(app, window, 'hello there');
  await app.send();
  await tick(); await tick();
  const sent = calls.find((call) => call.method === 'send_message');
  assert.equal(sent.args.effort, 'High', 'effort rides the payload');
  assert.ok(!('model' in sent.args), 'no model picked, no model key');
  assert.equal(app.draft().effort, '', 'the draft effort clears after send');
  assert.ok(button(app, 'effort').textContent.includes('Medium'), 'button falls back to the provider default');
});

test('picking an effort mid-conversation persists it and merges the reply', async (t) => {
  const { app, snapshot, calls } = harness(t, {
    set_conversation_effort: (args) => ({ name: 'c1', title: 'Private chat', provider: 'p1', model: '', effort: args.effort, owner: 'owner@example.test', shared: 0, archived: 0 }),
  });
  app.selected = 'c1';
  app.accept('c1', copy(snapshot));
  const btn = button(app, 'effort');
  assert.equal(btn.disabled, false, 'effort picker stays live');
  assert.equal(btn.title, 'Change the reasoning effort for this conversation');
  assert.ok(btn.textContent.includes('Medium'), 'empty stored effort falls back to the provider default');
  btn.click();
  const rows = options(app, 'effort');
  assert.equal(rows[2].getAttribute('aria-selected'), 'true', 'provider default current while unset');
  rows[4].click();
  assert.equal(menu(app, 'effort').hidden, true, 'menu closes after the pick');
  for (let index = 0; index < 20 && !calls.some((call) => call.method === 'set_conversation_effort'); index++) await tick();
  await tick(); await tick();
  const call = calls.find((entry) => entry.method === 'set_conversation_effort');
  assert.deepEqual(copy(call.args), { conversation: 'c1', effort: 'Max' });
  assert.ok(!calls.some((entry) => entry.method === 'set_conversation_model'), 'effort never touches the model setter');
  assert.equal(app.snapshot.conversation.effort, 'Max', 'reply merged into the snapshot');
  assert.ok(button(app, 'effort').textContent.includes('Max'), 'button repaints from the merged snapshot');
});

test('read-only conversations disable all three pickers', (t) => {
  const { app, snapshot } = harness(t);
  snapshot.can_post = false;
  app.selected = 'c1';
  app.accept('c1', copy(snapshot));
  assert.equal(button(app, 'provider').disabled, true);
  assert.equal(button(app, 'model').disabled, true, 'model locks for a read-only viewer');
  assert.equal(button(app, 'effort').disabled, true, 'effort locks for a read-only viewer');
});

test('attachment chips show size and truncate long names with a title', (t) => {
  const { app } = harness(t);
  app.draft().attachments = [
    { name: 'FILE-1', file_name: 'a-very-long-attachment-name-that-keeps-going.pdf', file_size: 1536000 },
    { name: 'FILE-2', file_name: 'notes.txt', file_size: 2500 },
    { name: 'FILE-3', file_name: 'mystery.md' },
  ];
  app.renderAttachments();
  const chips = app.slot('attachments').querySelectorAll('.fi-file-chip');
  assert.equal(chips.length, 3);
  assert.equal(chips[0].getAttribute('title'), 'a-very-long-attachment-name-that-keeps-going.pdf', 'full name on the title');
  assert.ok(chips[0].querySelector('.fi-file-chip-name'), 'name span carries the ellipsis class');
  assert.equal(chips[0].querySelector('.fi-file-chip-size').textContent, '1.5 MB');
  assert.equal(chips[1].querySelector('.fi-file-chip-size').textContent, '3 KB');
  assert.ok(!chips[2].querySelector('.fi-file-chip-size'), 'missing size renders nothing');
  assert.ok(chips[0].querySelector('[data-action="remove-file"][data-name="FILE-1"]'), 'remove wiring kept');
});

test('send includes a model only for a custom choice on a new conversation', async (t) => {
  const { app, window, calls } = harness(t);
  type(app, window, 'hello there');
  app.draft().model = 'gpt-4o';
  await app.send();
  await tick(); await tick();
  let sent = calls.find((call) => call.method === 'send_message');
  assert.equal(sent.args.model, 'gpt-4o', 'non-default model rides along');
  // Default model on a fresh conversation sends nothing.
  app.selected = null; app.snapshot = null; app.draft().model = 'gpt-4.1';
  type(app, window, 'second message');
  await app.send();
  await tick(); await tick();
  sent = calls.filter((call) => call.method === 'send_message').pop();
  assert.ok(!('model' in sent.args), 'provider default sends no model key');
  // An open conversation never sends a model, even with a draft override.
  app.selected = null; app.snapshot = null; app.draft().model = 'gpt-4o';
  await app.ensureConversation();
  app.draft().model = 'gpt-4o';
  type(app, window, 'third message');
  await app.send();
  await tick(); await tick();
  sent = calls.filter((call) => call.method === 'send_message').pop();
  assert.ok(!('model' in sent.args), 'existing conversations keep their provider');
});

test('the send button keeps its aria-label contract', (t) => {
  const { app, window } = harness(t);
  assert.equal(app.$('.fi-send').getAttribute('aria-label'), 'Send message');
  assert.equal(app.$('.fi-send').disabled, true, 'empty draft stays disabled');
  type(app, window, 'hello');
  assert.equal(app.$('.fi-send').disabled, false, 'text enables send');
  assert.equal(app.$('.fi-send').getAttribute('aria-label'), 'Send message');
});

test('hostile attachment names stay inert text in chips', (t) => {
  const { app } = harness(t);
  const hostile = '<img src=x onerror="window.__fi_xss=1">.pdf';
  app.draft().attachments = [{ name: 'FILE-9', file_name: hostile, file_size: 1200 }];
  app.renderAttachments();
  const slot = app.slot('attachments');
  assert.equal(slot.querySelector('img'), null, 'hostile markup never becomes an element');
  assert.equal(slot.querySelector('.fi-file-chip-name').textContent, hostile, 'the name survives as literal text');
  assert.equal(slot.querySelector('.fi-file-chip').getAttribute('title'), hostile);
  const remove = slot.querySelector('[data-action="remove-file"]');
  assert.ok(remove.getAttribute('aria-label').includes(hostile), 'the label carries the name as a decoded attribute value');
  assert.equal(remove.getAttribute('onerror'), null, 'no attribute breakout');
  assert.equal(slot.querySelectorAll('button').length, 1, 'exactly one button parsed');
});

test('a hostile custom model string stays a verbatim payload value', async (t) => {
  const { app, window, calls } = harness(t);
  const hostile = 'evil" onclick="alert(1)';
  type(app, window, 'hello there');
  app.draft().model = hostile;
  await app.send();
  await tick(); await tick();
  const sent = calls.find((call) => call.method === 'send_message');
  assert.equal(sent.args.model, hostile, 'the string crosses the wire untouched by interpretation');
  assert.equal(typeof sent.args.model, 'string');
});

test('open menus expose aria-activedescendant and close on Tab', (t) => {
  const { app, window } = harness(t);
  const btn = button(app, 'provider');
  btn.click();
  assert.equal(btn.getAttribute('aria-activedescendant'), 'fi-picker-provider-0', 'the active row is announced');
  key(window, btn, 'ArrowDown');
  assert.equal(btn.getAttribute('aria-activedescendant'), 'fi-picker-provider-1', 'arrow keys move the announcement');
  key(window, btn, 'Tab');
  assert.equal(menu(app, 'provider').hidden, true, 'Tab closes the menu');
  assert.equal(btn.getAttribute('aria-activedescendant'), null, 'closed menus carry no active descendant');
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
});
