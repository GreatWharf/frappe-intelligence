'use strict';
/* Desk sidebar contract tests: recent chats injected into the native v16
   sidebar as native markup (section break + link items) on the Intelligence
   workspace only, idempotent across route changes, live-synced by the app. */
const test = require('node:test');
const assert = require('node:assert/strict');
const source = require('./load.cjs').source();

const SIDEBAR = '<div class="body-sidebar"><div class="sidebar-items">'
	+ '<div class="sidebar-item-container" item-name="Chat" data-id="Chat" title="Chat"><div class="standard-sidebar-item"><a class="item-anchor" href="/desk/intelligence"><span class="sidebar-item-icon"></span><span class="sidebar-item-label">Chat</span><div class="sidebar-item-control"></div></a></div><div class="sidebar-child-item nested-container"></div></div>'
	+ '<div class="sidebar-item-container" item-name="Conversations" data-id="Conversations" title="Conversations"><div class="standard-sidebar-item"><a class="item-anchor" href="/desk/List/Intelligence%20Conversation"><span class="sidebar-item-icon"></span><span class="sidebar-item-label">Conversations</span><div class="sidebar-item-control"></div></a></div><div class="sidebar-child-item nested-container"></div></div>'
	+ '<div class="sidebar-item-container" item-name="Settings" data-id="Settings" title="Settings"><div class="standard-sidebar-item"><a class="item-anchor" href="/desk/Form/Intelligence%20Settings"><span class="sidebar-item-icon"></span><span class="sidebar-item-label">Settings</span><div class="sidebar-item-control"></div></a></div><div class="sidebar-child-item nested-container"></div></div>'
	+ '</div></div>';

function row(name, title) { return { name, title: title || 'Chat ' + name, provider: 'p1', modified: '2026-09-20 10:24:00', archived: 0, owner: 'user@example.test', shared: 0 }; }

function memoryStorage() {
	const data = new Map();
	return { getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => { data.set(key, String(value)); }, removeItem: (key) => { data.delete(key); }, clear: () => data.clear() };
}
function installStorage(window) {
	const storage = memoryStorage();
	try { Object.defineProperty(window, 'localStorage', { value: storage, configurable: true }); return storage; }
	catch (_) { try { window.localStorage.clear(); } catch (__) { /* no storage host */ } return window.localStorage || storage; }
}

function sidebarHarness(t, options = {}) {
	const { JSDOM } = process.env.FI_REAL_DOM === '1' ? require('jsdom') : require('./dom-harness.cjs');
	const url = options.url || 'https://desk.example.test/desk/intelligence';
	const dom = new JSDOM('<!doctype html><html><body>' + (options.sidebar === '' ? '' : (options.sidebar || SIDEBAR)) + '</body></html>', { url, runScripts: 'outside-only', pretendToBeVisual: true });
	const window = dom.window;
	try { if (!window.location) window.location = { pathname: new URL(url).pathname }; } catch (_) { /* real jsdom parses the url */ }
	const storage = installStorage(window);
	const changes = [];
	const jqHandlers = {};
	const calls = [];
	let activeMarks = 0;
	let route = ['intelligence'];
	const sidebar = options.title === null ? null : {
		sidebar_title: options.title === undefined ? 'Intelligence' : options.title,
		sidebar_expanded: true,
		editor: { edit_mode: !!options.editMode },
		set_active_workspace_item() { activeMarks++; }
	};
	window.frappe = {
		boot: {}, session: { user: 'user@example.test' },
		get_route: () => route, set_route: (...parts) => { route = parts; },
		router: { on: (event, cb) => { if (event === 'change') changes.push(cb); } },
		app: sidebar === null && options.title === null ? {} : { sidebar },
		utils: { icon: (name) => '<svg class="es-icon" data-icon="' + name + '"></svg>' },
		call: ({ method, args, callback, error }) => {
			const name = String(method).replace('frappe_intelligence.api.', '');
			calls.push({ method: name, args });
			try {
				if (options.api && options.api[name]) { callback({ message: options.api[name](args || {}) }); return { catch: () => {} }; }
				if (name === 'list_conversations') { callback({ message: [row('c1', 'First chat'), row('c2', 'Second chat')] }); return { catch: () => {} }; }
				callback({ message: {} }); return { catch: () => {} };
			} catch (failure) { if (error) error(failure); return { catch: () => {} }; }
		}
	};
	if (options.jquery) window.jQuery = () => ({ on: (name, cb) => { jqHandlers[name] = cb; } });
	window.eval(source);
	const fi = window.fi;
	const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
	// Boot waits for DOMContentLoaded, which jsdom fires on its own schedule:
	// wait on the condition, never on a fixed delay.
	const waitFor = async (fn, timeout = 3000) => {
		const deadline = Date.now() + timeout;
		let value;
		while (Date.now() < deadline) {
			if ((value = fn())) return value;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		return value;
	};
	const fireChange = async () => { for (const cb of changes) cb(window.frappe.router); await settle(); };
	t.after(async () => {
		await new Promise((resolve) => setTimeout(resolve, 40));
		dom.window.close();
	});
	return {
		window, document: window.document, fi, storage, calls, jqHandlers, fireChange, settle, waitFor,
		items: () => window.document.querySelector('.sidebar-items'),
		section: () => window.document.querySelector('[data-fi-recent-chats]'),
		activeMarks: () => activeMarks
	};
}

test('desk sidebar API is exposed on the fi namespace', (t) => {
	const { fi } = sidebarHarness(t);
	assert.equal(typeof fi.deskSidebar.ensure, 'function');
	assert.equal(typeof fi.deskSidebar.refresh, 'function');
	assert.equal(typeof fi.deskSidebar.sync, 'function');
});

test('renders recent chats as native items after Conversations', async (t) => {
	const { section, items, waitFor, activeMarks } = sidebarHarness(t);
	const root = await waitFor(() => section());
	assert.ok(root, 'section exists');
	assert.ok(root.classList.contains('sidebar-item-container'), 'native container class');
	assert.ok(root.classList.contains('section-item'), 'native section class');
	assert.equal(root.getAttribute('data-id'), 'Recent chats');
	assert.equal(root.querySelector('.section-break .sidebar-item-label').textContent, 'Recent chats');
	const anchors = Array.from(root.querySelectorAll('.nested-container a.item-anchor'));
	assert.equal(anchors.length, 2);
	assert.equal(anchors[0].getAttribute('href'), '/desk/intelligence/c1');
	assert.equal(anchors[1].getAttribute('href'), '/desk/intelligence/c2');
	assert.equal(anchors[0].querySelector('.sidebar-item-label').textContent, 'First chat');
	assert.ok(anchors[0].parentNode.classList.contains('indent'), 'nested items indent like native');
	const order = Array.from(items().children).map((el) => el.getAttribute('data-id'));
	assert.deepEqual(order, ['Chat', 'Conversations', 'Recent chats', 'Settings']);
	assert.ok(activeMarks() > 0, 'native sidebar asked to re-mark the active row');
});

test('marks the open conversation active', async (t) => {
	const { section, waitFor } = sidebarHarness(t, { url: 'https://desk.example.test/desk/intelligence/c2' });
	await waitFor(() => section());
	const anchors = Array.from(section().querySelectorAll('a.item-anchor'));
	assert.equal(anchors[0].parentNode.classList.contains('active-sidebar'), false);
	assert.equal(anchors[1].parentNode.classList.contains('active-sidebar'), true);
});

test('stays out of other workspaces and of edit mode', async (t) => {
	const other = sidebarHarness(t, { title: 'CRM' });
	await other.settle();
	assert.equal(other.section(), null, 'no section on another workspace');
	assert.equal(other.calls.filter((call) => call.method === 'list_conversations').length, 0, 'no fetch outside Intelligence');

	const editing = sidebarHarness(t, { editMode: true });
	await editing.settle();
	assert.equal(editing.section(), null, 'no section while the sidebar editor is open');
	assert.equal(editing.calls.filter((call) => call.method === 'list_conversations').length, 0);
});

test('hides the section when there is nothing to show', async (t) => {
	const { section, settle } = sidebarHarness(t, { api: { list_conversations: () => [] } });
	await settle();
	assert.equal(section(), null);
});

test('caps the list at eight and escapes titles', async (t) => {
	const rows = [];
	for (let index = 0; index < 10; index++) rows.push(row('n' + index, 'Chat number ' + index));
	rows[0] = row('evil', '<img src=x onerror=alert(1)> nasty');
	const { section, waitFor } = sidebarHarness(t, { api: { list_conversations: () => rows } });
	await waitFor(() => section());
	const anchors = Array.from(section().querySelectorAll('.nested-container a.item-anchor'));
	assert.equal(anchors.length, 8);
	assert.equal(anchors[0].querySelector('.sidebar-item-label').textContent, '<img src=x onerror=alert(1)> nasty');
	assert.equal(section().querySelector('img'), null, 'title text is never parsed as HTML');
});

test('is idempotent across route changes and re-injects after a sidebar rebuild', async (t) => {
	const harness = sidebarHarness(t);
	await harness.waitFor(() => harness.section());
	await harness.fireChange();
	await harness.fireChange();
	assert.equal(harness.document.querySelectorAll('[data-fi-recent-chats]').length, 1, 'still one section');
	assert.equal(harness.calls.filter((call) => call.method === 'list_conversations').length, 1, 'one fetch while the section lives');
	// A native rebuild wipes .sidebar-items; the next route change must restore the section.
	harness.items().innerHTML = SIDEBAR.match(/<div class="sidebar-items">(.*)<\/div><\/div>$/s)[1];
	assert.equal(harness.section(), null, 'rebuild wiped the section');
	await harness.fireChange();
	assert.ok(harness.section(), 'section re-injected after the rebuild');
});

const NATIVE_ITEMS = SIDEBAR.match(/<div class="sidebar-items">(.*)<\/div><\/div>$/s)[1];

test('re-injects when the sidebar rebuilds without a route change', async (t) => {
	const harness = sidebarHarness(t);
	await harness.waitFor(() => harness.section());
	const fetches = () => harness.calls.filter((call) => call.method === 'list_conversations').length;
	assert.equal(fetches(), 1);
	// frappe rebuilds .sidebar-items on workspace switches with no router event.
	harness.items().innerHTML = '';
	harness.items().innerHTML = NATIVE_ITEMS;
	assert.equal(harness.section(), null, 'rebuild wiped the section');
	assert.ok(await harness.waitFor(() => harness.section()), 'section restored by the mutation watch alone');
	assert.equal(fetches(), 2, 'the rebuild burst coalesces into one refetch');
	const order = Array.from(harness.items().children).map((el) => el.getAttribute('data-id'));
	assert.deepEqual(order, ['Chat', 'Conversations', 'Recent chats', 'Settings']);
});

test('appears when the workspace switches to Intelligence without a route change', async (t) => {
	const harness = sidebarHarness(t, { title: 'CRM' });
	await harness.settle();
	assert.equal(harness.section(), null, 'nothing while another workspace is showing');
	assert.equal(harness.calls.filter((call) => call.method === 'list_conversations').length, 0);
	// Opening the Intelligence workspace swaps sidebar_title and rebuilds the
	// items natively; no router change fires for the workspace switch alone.
	harness.window.frappe.app.sidebar.sidebar_title = 'Intelligence';
	harness.items().innerHTML = NATIVE_ITEMS;
	assert.ok(await harness.waitFor(() => harness.section()), 'section appears with the Intelligence sidebar');
	assert.equal(harness.calls.filter((call) => call.method === 'list_conversations').length, 1);
});

test('keeps ignoring rebuilds of other workspaces', async (t) => {
	const harness = sidebarHarness(t, { title: 'CRM' });
	await harness.settle();
	harness.items().innerHTML = NATIVE_ITEMS;
	await harness.settle();
	assert.equal(harness.section(), null);
	assert.equal(harness.calls.filter((call) => call.method === 'list_conversations').length, 0, 'never fetches outside Intelligence');
});

test('sync refreshes rows in place and drops the section when empty', async (t) => {
	const { fi, section, waitFor } = sidebarHarness(t);
	await waitFor(() => section());
	fi.deskSidebar.sync([row('c9', 'Fresh title')]);
	let anchors = Array.from(section().querySelectorAll('.nested-container a.item-anchor'));
	assert.equal(anchors.length, 1);
	assert.equal(anchors[0].getAttribute('href'), '/desk/intelligence/c9');
	assert.equal(anchors[0].querySelector('.sidebar-item-label').textContent, 'Fresh title');
	fi.deskSidebar.sync([]);
	assert.equal(section(), null, 'empty list removes the section');
});

test('collapses, persists and restores the section state', async (t) => {
	const { section, storage, waitFor } = sidebarHarness(t);
	await waitFor(() => section());
	const header = section().querySelector(':scope > .standard-sidebar-item') || section().querySelector('.standard-sidebar-item');
	const nested = section().querySelector(':scope > .sidebar-child-item') || section().querySelector('.nested-container');
	assert.equal(nested.classList.contains('hidden'), false, 'open by default');
	header.dispatchEvent(harness_event(section().ownerDocument, 'click'));
	assert.equal(nested.classList.contains('hidden'), true, 'collapsed after click');
	const saved = JSON.parse(storage.getItem('section-breaks-state'));
	assert.equal(saved.intelligence['Recent chats'], true, 'native section-breaks-state bucket');
	header.dispatchEvent(harness_event(section().ownerDocument, 'click'));
	assert.equal(nested.classList.contains('hidden'), false);
	assert.equal(JSON.parse(storage.getItem('section-breaks-state')).intelligence['Recent chats'], false);
});

// dom-harness events need no constructor of their own; use the document's.
function harness_event(doc, type) {
	const win = doc.defaultView;
	if (win && typeof win.Event === 'function') return new win.Event(type, { bubbles: true });
	return { type, bubbles: true };
}

test('refresh forces a refetch on the next tick', async (t) => {
	const harness = sidebarHarness(t);
	await harness.waitFor(() => harness.section());
	assert.equal(harness.calls.filter((call) => call.method === 'list_conversations').length, 1);
	harness.fi.deskSidebar.refresh();
	await harness.settle();
	assert.equal(harness.calls.filter((call) => call.method === 'list_conversations').length, 2, 'refetched');
	assert.equal(harness.document.querySelectorAll('[data-fi-recent-chats]').length, 1, 'still one section');
});

test('tolerates a missing Desk sidebar and a failed fetch', async (t) => {
	const bare = sidebarHarness(t, { title: null, sidebar: '' });
	await bare.settle();
	assert.equal(bare.calls.filter((call) => call.method === 'list_conversations').length, 0, 'no Desk sidebar, no fetch');

	const failing = sidebarHarness(t, { api: { list_conversations: () => { throw new Error('boom'); } } });
	await failing.settle();
	assert.equal(failing.section(), null, 'a failed fetch renders nothing');
});

test('mirrors the native collapse affordance', async (t) => {
	const { section, jqHandlers, waitFor } = sidebarHarness(t, { jquery: true });
	await waitFor(() => section());
	const root = section();
	const header = root.querySelector('.section-break');
	const divider = root.querySelector('.divider');
	assert.ok(jqHandlers['sidebar-expand.fiDeskSidebar'], 'listening for the native sidebar toggle');
	jqHandlers['sidebar-expand.fiDeskSidebar']({}, { sidebar_expand: false });
	assert.equal(header.classList.contains('hidden'), true, 'icon rail hides the section label');
	assert.equal(divider.classList.contains('hidden'), false, 'icon rail shows the divider');
	jqHandlers['sidebar-expand.fiDeskSidebar']({}, { sidebar_expand: true });
	assert.equal(header.classList.contains('hidden'), false);
	assert.equal(divider.classList.contains('hidden'), true);
});
