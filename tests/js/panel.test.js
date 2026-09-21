'use strict';
/* Panel shell contract tests: state persistence, width clamping, shortcut guards,
   the pill as sole launcher and the full-page handoff. */
const test = require('node:test');
const assert = require('node:assert/strict');
const client = require('./load.cjs').load();
const source = require('./load.cjs').source();
const tick = () => new Promise((resolve) => setImmediate(resolve));
const copy = (value) => JSON.parse(JSON.stringify(value));
const boot = { enabled: true, is_manager: true, user: 'user@example.test', providers: [{ name: 'p1', title: 'Work', kind: 'OpenAI', model: 'configured-model', thinking_effort: 'Medium' }], defaults: { max_upload_mb: 10, approval_mode: 'Approve Every Step' }, capabilities: { attachments: true, memory: true } };
function row(name, title) { return { name, title: title || 'Chat ' + name, provider: 'p1', modified: '2026-09-16 10:24:00', archived: 0, owner: 'user@example.test', shared: 0 }; }
function fixtureFor(name) { return { conversation: row(name), messages: [{ name: 'm1', role: 'user', content: 'Hello', status: 'complete' }], approvals: [], files: [], run: null, can_post: true }; }
function memoryStorage() {
  const data = new Map();
  return { getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => { data.set(key, String(value)); }, removeItem: (key) => { data.delete(key); }, clear: () => data.clear() };
}
function installStorage(window) {
  const storage = memoryStorage();
  try { Object.defineProperty(window, 'localStorage', { value: storage, configurable: true }); return storage; }
  catch (_) { try { window.localStorage.clear(); } catch (__) { /* no storage host */ } return window.localStorage || storage; }
}
function deskHarness(t, options = {}) {
  const { JSDOM } = process.env.FI_REAL_DOM === '1' ? require('jsdom') : require('./dom-harness.cjs');
  const dom = new JSDOM('<!doctype html><html><body>' + (options.html || '') + '</body></html>', { url: 'https://desk.example.test/desk', runScripts: 'outside-only', pretendToBeVisual: true });
  const window = dom.window;
  const storage = installStorage(window);
  if (options.state !== undefined) storage.setItem('fi-panel-state', typeof options.state === 'string' ? options.state : JSON.stringify(options.state));
  const routes = []; let route = options.route || ['home'];
  const calls = [];
  window.frappe = {
    boot: {}, session: { user: 'user@example.test' },
    get_route: () => route, set_route: (...parts) => { route = parts; routes.push(parts); },
    call: ({ method, args, callback, error }) => {
      const name = String(method).replace('frappe_intelligence.api.', '');
      calls.push({ method: name, args });
      try {
        if (options.api && options.api[name]) { callback({ message: options.api[name](args || {}) }); return { catch: () => {} }; }
        if (name === 'bootstrap') { callback({ message: copy(boot) }); return { catch: () => {} }; }
        if (name === 'list_conversations') { callback({ message: Number(args && args.shared) ? [] : [row('c1', 'First chat'), row('c2', 'Second chat')] }); return { catch: () => {} }; }
        if (name === 'get_conversation') { callback({ message: fixtureFor(args.conversation) }); return { catch: () => {} }; }
        callback({ message: {} }); return { catch: () => {} };
      } catch (failure) { if (error) error(failure); return { catch: () => {} }; }
    }
  };
  window.eval(source);
  const fi = window.frappe.intelligence;
  // API/request promises resolve as microtasks and re-arm timers (poller,
  // request guards) after a synchronous test body returns. Drain a real timer
  // turn before stopping the poller and closing the window so cleanup wins.
  t.after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    const app = fi.currentApp && fi.currentApp();
    if (app) app.poller.stop();
    dom.window.close();
  });
  return { window, document: window.document, fi, storage, routes, calls };
}

test('panel exports the public API plus state helpers', () => {
  for (const key of ['syncDesk', 'openDrawer', 'closeDrawer', 'drawerVisible', 'hideDrawerChrome', 'installPanel', 'toggle', 'close', 'clampDrawerWidth']) assert.equal(typeof client[key], 'function', key);
  assert.equal(typeof client.panelState.read, 'function');
  assert.equal(typeof client.panelState.write, 'function');
});

test('clampDrawerWidth clamps to the minimum width and the viewport margin', () => {
  assert.equal(client.clampDrawerWidth(420, 1440), 420);
  assert.equal(client.clampDrawerWidth(120, 1440), 360, 'minimum 360 wins');
  assert.equal(client.clampDrawerWidth(9999, 1440), 1360, 'viewport minus 80 margin caps the width');
  assert.equal(client.clampDrawerWidth(700, 380), 360, 'tiny viewports still allow the minimum');
  assert.equal(client.clampDrawerWidth('wide', 1440), 420, 'non-numeric input falls back to the default');
  assert.equal(client.clampDrawerWidth(500, 0), 500, 'unknown viewport skips the margin clamp');
});

test('panel state round-trips, merges and falls back on corrupt storage', (t) => {
  const { fi, storage } = deskHarness(t);
  // panelState.read() returns vm-realm objects under the lightweight DOM, so
  // compare a JSON copy to keep assert.deepEqual (deepStrictEqual) happy.
  assert.deepEqual(copy(fi.panelState.read()), { open: false, width: 420, conversation: null }, 'defaults without stored state');
  fi.panelState.write({ open: true, width: 500, conversation: 'c1' });
  assert.deepEqual(copy(fi.panelState.read()), { open: true, width: 500, conversation: 'c1' });
  fi.panelState.write({ width: 640 });
  assert.deepEqual(copy(fi.panelState.read()), { open: true, width: 640, conversation: 'c1' }, 'writes merge with stored state');
  storage.setItem('fi-panel-state', '{not json');
  assert.deepEqual(copy(fi.panelState.read()), { open: false, width: 420, conversation: null }, 'corrupt JSON falls back to defaults');
  storage.setItem('fi-panel-state', JSON.stringify({ open: 1, width: 40, conversation: 42 }));
  assert.deepEqual(copy(fi.panelState.read()), { open: true, width: 360, conversation: null }, 'values are coerced, clamped and validated');
  storage.setItem('fi-panel-state', '"just a string"');
  assert.deepEqual(copy(fi.panelState.read()), { open: false, width: 420, conversation: null }, 'a non-object payload falls back to defaults');
});

test('Ctrl+I toggles the panel but never steals italic from text editors', (t) => {
  const { window, document, fi } = deskHarness(t);
  fi.install();
  const pill = document.querySelector('.fi-global-toggle');
  assert.ok(pill, 'pill installed');
  assert.equal(pill.title, 'Intelligence (Ctrl+I)');
  const field = document.createElement('textarea');
  document.body.appendChild(field);
  const guarded = new window.KeyboardEvent('keydown', { key: 'i', ctrlKey: true, bubbles: true, cancelable: true });
  field.dispatchEvent(guarded);
  assert.equal(guarded.defaultPrevented, false, 'Ctrl+I inside a textarea stays italic');
  assert.equal(fi.drawerVisible(), false, 'no drawer opens from an editable');
  const plain = new window.KeyboardEvent('keydown', { key: 'i', ctrlKey: true, bubbles: true, cancelable: true });
  document.body.dispatchEvent(plain);
  assert.equal(plain.defaultPrevented, true);
  assert.equal(fi.drawerVisible(), true, 'Ctrl+I outside editors opens the drawer');
  const alias = new window.KeyboardEvent('keydown', { key: 'I', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
  field.dispatchEvent(alias);
  assert.equal(alias.defaultPrevented, true, 'the Ctrl+Shift+I alias applies even inside editors');
  assert.equal(fi.drawerVisible(), false, 'the alias toggles the drawer closed');
});

test('the floating pill is the sole launcher and toggles the drawer', (t) => {
  const html = '<nav class="navbar"><ul class="navbar-nav"><li class="dropdown-notifications"><a class="notifications-icon" href="#"></a></li></ul></nav>';
  const { document, fi } = deskHarness(t, { html });
  fi.install();
  const pill = document.querySelector('.fi-global-toggle');
  assert.ok(pill, 'the floating pill installs alongside the Desk navbar');
  assert.equal(document.querySelector('.fi-navbar-toggle'), null, 'no navbar entry is injected');
  assert.equal(fi.drawerVisible(), false);
  pill.click();
  assert.equal(fi.drawerVisible(), true, 'the pill opens the drawer');
  pill.click();
  assert.equal(fi.drawerVisible(), false, 'and toggles it closed again');
});

test('boot restores width and conversation on the next open without auto-opening', async (t) => {
  const { document, fi } = deskHarness(t, { state: { open: true, width: 500, conversation: 'c1' }, route: ['Form', 'Customer', 'C-1'] });
  fi.install();
  await tick(); await tick();
  assert.equal(document.querySelector('.fi-drawer-shell'), null, 'no drawer is created at boot');
  assert.equal(fi.drawerVisible(), false, 'stored open state never auto-opens the drawer');
  fi.openDrawer();
  const shell = document.querySelector('.fi-drawer-shell');
  assert.ok(shell, 'drawer created on first open');
  assert.equal(shell.style.width, '500px', 'the persisted width is applied');
  const app = fi.currentApp();
  for (let index = 0; index < 30 && app.selected !== 'c1'; index++) await tick();
  assert.equal(app.selected, 'c1', 'the parked conversation is selected through the normal path');
  assert.deepEqual(copy(fi.panelState.read()), { open: true, width: 500, conversation: 'c1' });
});

test('the resize strip drags the width within clamp bounds and persists on release', (t) => {
  const { window, document, fi } = deskHarness(t);
  fi.install();
  fi.openDrawer();
  const shell = document.querySelector('.fi-drawer-shell');
  const strip = shell.querySelector('.fi-drawer-resize');
  assert.ok(strip, 'resize strip rendered on the drawer edge');
  const down = new window.Event('mousedown', { bubbles: true, cancelable: true });
  down.button = 0; down.clientX = 1000;
  strip.dispatchEvent(down);
  assert.equal(shell.classList.contains('is-resizing'), true, 'dragging marks the shell');
  const move = new window.Event('mousemove', { bubbles: true, cancelable: true });
  move.clientX = 880;
  document.dispatchEvent(move);
  assert.equal(shell.style.width, '540px', 'dragging left widens the drawer');
  assert.equal(fi.panelState.read().width, 420, 'nothing persists mid-drag');
  const up = new window.Event('mouseup', { bubbles: true });
  document.dispatchEvent(up);
  assert.equal(shell.classList.contains('is-resizing'), false);
  assert.equal(fi.panelState.read().width, 540, 'the width persists on release');
});

test('the full-page action shows only in drawer mode and no extras row renders', async (t) => {
  const { document, fi } = deskHarness(t);
  const api = async (method, args) => {
    if (method === 'bootstrap') return copy(boot);
    if (method === 'list_conversations') return [row('c1', 'First chat')];
    if (method === 'get_conversation') return fixtureFor(args.conversation);
    return {};
  };
  const app = new fi.App({ api, document });
  t.after(() => app.poller.stop());
  app.boot = copy(boot); app.provider = 'p1';
  const pageHost = document.createElement('div'); document.body.appendChild(pageHost);
  const drawerHost = document.createElement('div'); document.body.appendChild(drawerHost);
  app.show(pageHost, 'page');
  assert.equal(app.$('[data-action="expand"]').hidden, true, 'page mode hides the full-page action');
  app.conversations = [row('c1', 'First chat')]; app.selected = 'c1';
  app.show(drawerHost, 'drawer');
  assert.equal(app.$('[data-action="expand"]').hidden, false, 'drawer mode shows the full-page action');
  assert.equal(app.$('.fi-header .fi-drawer-extras'), null, 'no custom extras row is injected');
  app.show(pageHost, 'page');
  assert.equal(app.$('[data-action="expand"]').hidden, true, 'leaving drawer mode hides it again');
});

test('expand closes the drawer, parks the conversation and deep-links the page route', async (t) => {
  const { fi, routes } = deskHarness(t, { route: ['Form', 'Customer', 'C-1'] });
  fi.install();
  fi.openDrawer();
  const app = fi.currentApp();
  for (let index = 0; index < 30 && !app.boot; index++) await tick();
  await app.select('c1');
  assert.equal(fi.drawerVisible(), true);
  const button = app.$('[data-action="expand"]');
  assert.ok(button, 'the drawer header exposes the full-page action');
  button.click();
  assert.equal(fi.drawerVisible(), false, 'the drawer closes');
  assert.deepEqual(routes, [['intelligence', 'c1']], 'the page route deep-links the open conversation');
  const state = fi.panelState.read();
  assert.equal(state.open, false);
  assert.equal(state.conversation, 'c1', 'the conversation stays parked for the next drawer session');
});

test('expand with no selection routes to the bare page', async (t) => {
  const { fi, routes } = deskHarness(t, { route: ['home'] });
  fi.install();
  fi.openDrawer();
  const app = fi.currentApp();
  for (let index = 0; index < 30 && !app.boot; index++) await tick();
  const button = app.$('[data-action="expand"]');
  assert.ok(button);
  button.click();
  assert.equal(fi.drawerVisible(), false);
  assert.deepEqual(routes, [['intelligence']]);
});

test('the resize strip is a focusable separator with keyboard steps that persist', (t) => {
  const { window, document, fi } = deskHarness(t);
  fi.install();
  fi.openDrawer();
  const shell = document.querySelector('.fi-drawer-shell');
  const strip = shell.querySelector('.fi-drawer-resize');
  assert.equal(strip.getAttribute('role'), 'separator');
  assert.equal(strip.getAttribute('aria-orientation'), 'vertical');
  assert.equal(strip.getAttribute('aria-hidden'), null, 'an interactive strip is never aria-hidden');
  assert.equal(strip.tabIndex, 0, 'the strip is keyboard focusable');
  const left = new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
  strip.dispatchEvent(left);
  assert.equal(left.defaultPrevented, true);
  assert.equal(shell.style.width, '444px', 'ArrowLeft widens the drawer by one step');
  assert.equal(fi.panelState.read().width, 444, 'each keyboard step persists');
  const right = new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
  strip.dispatchEvent(right);
  assert.equal(shell.style.width, '420px');
  assert.equal(fi.panelState.read().width, 420);
});

test('a __proto__ payload in stored state pollutes nothing and falls back safely', (t) => {
  const { window, fi } = deskHarness(t, { state: '{"__proto__":{"open":true,"width":999,"conversation":"c9"},"width":500}' });
  const state = copy(fi.panelState.read());
  assert.equal(state.open, false, 'the parked __proto__ object never reaches the open flag');
  assert.equal(state.width, 500, 'legitimate sibling fields still apply');
  assert.equal(state.conversation, null);
  assert.equal(window.eval('({}).open'), undefined, 'Object.prototype in the app realm is untouched');
});

test('the pill hides on the Intelligence page route', (t) => {
  const html = '<nav class="navbar"><ul class="navbar-nav"><li class="dropdown-notifications"><a class="notifications-icon" href="#"></a></li></ul></nav>';
  const { document, fi } = deskHarness(t, { html, route: ['intelligence'] });
  fi.install();
  const pill = document.querySelector('.fi-global-toggle');
  assert.ok(pill, 'the pill installs');
  assert.equal(pill.hidden, true, 'the pill hides while the full page is showing');
  assert.equal(document.querySelector('.fi-navbar-toggle'), null, 'no navbar entry is injected');
});

test('hideDrawerChrome syncs toggle state and persists the closed flag', (t) => {
  const { document, fi } = deskHarness(t);
  fi.install();
  fi.openDrawer();
  const pill = document.querySelector('.fi-global-toggle');
  assert.equal(fi.drawerVisible(), true);
  assert.equal(pill.getAttribute('aria-expanded'), 'true', 'opening expands the toggle');
  fi.hideDrawerChrome();
  assert.equal(fi.drawerVisible(), false);
  assert.equal(pill.getAttribute('aria-expanded'), 'false');
  assert.equal(fi.panelState.read().open, false, 'the closed state survives the next boot');
});
