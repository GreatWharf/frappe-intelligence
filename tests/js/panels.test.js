'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const client = require('./load.cjs').load();
const { stamp } = client.utils;
const source = require('./load.cjs').source();
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
    throw new Error('Unmocked method ' + method);
  };
  const app = new window.frappe.intelligence.App({ api, document: window.document });
  window.document.querySelector('#host').appendChild(app.root);
  app.boot = copy(boot); app.provider = 'p1'; app.render();
  t.after(() => { app.poller.stop(); window.clearTimeout(app.searchTimer); dom.window.close(); });
  return { app, window, document: window.document, calls, snapshot };
}
const cssRule = (sheet, selector) => {
  const match = sheet.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
  return (match && match[1]) || '';
};
const baseCSS = fs.readFileSync(path.resolve(__dirname, '../../frappe_intelligence/public/css/intelligence.css'), 'utf8');
const panelCSS = fs.readFileSync(path.resolve(__dirname, '../../frappe_intelligence/public/css/fi/panel.css'), 'utf8');

test('stamp renders a short date with time, or empty text for missing or invalid values', () => {
  assert.equal(stamp(''), '');
  assert.equal(stamp('not-a-date'), '');
  const date = new Date('2026-09-16T14:05:00');
  const expected = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  assert.equal(stamp('2026-09-16 14:05:00'), expected);
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

test('the header has no menu trigger; management lives in native Desk pages', (t) => {
  const { app } = harness(t);
  assert.equal(app.$('.fi-sidebar-footer'), null, 'no custom sidebar footer remains');
  assert.equal(app.$('.fi-menu-wrap'), null, 'the three-dot menu is gone from the header');
  assert.equal(app.$('[data-action="menu"]'), null, 'no menu trigger button');
  assert.equal(app.slot('menu'), null, 'no menu slot');
  for (const action of ['conversations-list', 'settings', 'memory', 'skills', 'scope', 'app-settings']) assert.equal(app.$('[data-action="' + action + '"]'), null, action + ' entry point is gone');
});

test('the header subtitle carries access state only, never provider, model or effort', (t) => {
  const { app, snapshot } = harness(t);
  assert.equal(app.slot('subtitle').textContent, 'Private · only you', 'no conversation selected');
  snapshot.conversation.model = 'configured-model'; snapshot.conversation.effort = 'High';
  app.selected = 'c1'; app.accept('c1', copy(snapshot));
  const subtitle = app.slot('subtitle').textContent;
  assert.equal(subtitle, 'Private · only you', 'a selected conversation still shows state only');
  assert.ok(!subtitle.includes('configured-model') && !subtitle.includes('effort') && !subtitle.includes('Work'), 'no provider title, model or effort leaks into the header');
  snapshot.conversation.archived = 1; app.accept('c1', copy(snapshot));
  assert.equal(app.slot('subtitle').textContent, 'Archived · read only');
  snapshot.conversation.archived = 0; snapshot.can_post = false; snapshot.conversation.owner = 'alex@example.test';
  app.accept('c1', copy(snapshot));
  assert.equal(app.slot('subtitle').textContent, 'Shared by alex@example.test · read only');
});

test('the drawer header actions form a single non-wrapping row', (t) => {
  const { app } = harness(t);
  const header = app.$('.fi-header');
  assert.ok(header, 'header rendered');
  const groups = header.querySelectorAll('.fi-header-actions');
  assert.equal(groups.length, 1, 'one action cluster');
  assert.deepEqual(Array.from(groups[0].querySelectorAll('[data-action]')).map((node) => node.dataset.action), ['share', 'archive', 'new', 'expand', 'close'], 'share, archive, new, expand and close share the row');
  // The CSS contract behind the single row: the title yields and truncates,
  // the action cluster keeps its size and never wraps, in page and drawer mode.
  assert.ok(cssRule(baseCSS, '.fi-header-actions').includes('flex: none'), 'the cluster keeps its size');
  assert.ok(cssRule(baseCSS, '.fi-header-actions').includes('flex-wrap: nowrap'), 'the cluster never wraps');
  assert.ok(cssRule(baseCSS, '.fi-heading').includes('flex: 1 1 auto') && cssRule(baseCSS, '.fi-heading').includes('min-width: 0'), 'the title yields');
  assert.ok(cssRule(baseCSS, '.fi-heading h2, .fi-heading .fi-title-input').includes('text-overflow: ellipsis'), 'the title truncates with an ellipsis');
  assert.ok(cssRule(panelCSS, '.fi-drawer-app .fi-header').includes('flex-wrap: nowrap'), 'the drawer header stays one row');
  assert.ok(!/\.fi-header[^{]*\{[^}]*flex-wrap:\s*wrap\b/.test(baseCSS + panelCSS), 'no header wrap rule survives');
});

// A minimal frappe.ui.Dialog stand-in that renders declarative fields into the
// harness DOM, so tests can prove the native Desk path is chosen and works.
function stubNativeDialogs(window) {
  const instances = [];
  const frappe = window.frappe;
  frappe.ui = frappe.ui || {};
  frappe.ui.freeze = () => {}; frappe.ui.unfreeze = () => {};
  frappe.show_alert = () => {};
  frappe.ui.Dialog = class {
    constructor(options) {
      this.options = options; this.values = {}; this.fields_dict = {};
      const doc = window.document;
      this.wrapper = doc.createElement('div'); this.wrapper.className = 'fi-native-stub';
      this.body = doc.createElement('div');
      this.wrapper.appendChild(this.body);
      this.$body = [this.body]; this.$wrapper = [this.wrapper];
      for (const field of options.fields || []) {
        if (field.fieldtype === 'HTML') { const host = doc.createElement('div'); host.setAttribute('data-fieldname', field.fieldname || ''); host.innerHTML = field.options || ''; this.body.appendChild(host); continue; }
        if (!field.fieldname) continue;
        const control = doc.createElement('div'); control.className = 'frappe-control'; control.setAttribute('data-fieldname', field.fieldname); control.setAttribute('data-fieldtype', field.fieldtype);
        let input;
        if (field.fieldtype === 'Select') {
          input = doc.createElement('select');
          for (const option of field.options || []) { const row = typeof option === 'string' ? { value: option, label: option } : option; const node = doc.createElement('option'); node.value = row.value; node.textContent = row.label; input.appendChild(node); }
        } else if (field.fieldtype === 'Check') { input = doc.createElement('input'); input.setAttribute('type', 'checkbox'); }
        else if (field.fieldtype === 'Small Text') input = doc.createElement('textarea');
        else if (field.fieldtype === 'Button') { input = doc.createElement('button'); input.textContent = field.label || ''; input.addEventListener('click', () => field.click && field.click()); control.appendChild(input); this.body.appendChild(control); this.fields_dict[field.fieldname] = { df: field, input }; continue; }
        else input = doc.createElement('input');
        if (field.fieldtype === 'Password') input.setAttribute('type', 'password');
        input.name = field.fieldname;
        control.appendChild(input); this.body.appendChild(control);
        this.fields_dict[field.fieldname] = { df: field, input };
        if (field.default !== undefined) { this.values[field.fieldname] = field.default; if (field.fieldtype === 'Check') input.checked = !!field.default; else input.value = field.default; }
        else if (field.fieldtype === 'Select') { const first = input.querySelector('option'); if (first) this.values[field.fieldname] = first.value; }
        input.addEventListener('change', () => { this.values[field.fieldname] = field.fieldtype === 'Check' ? (input.checked ? 1 : 0) : input.value; if (field.onchange) field.onchange(); });
      }
      instances.push(this);
    }
    show() { window.document.body.appendChild(this.wrapper); }
    hide() { this.wrapper.remove(); }
    get_values() { return Object.assign({}, this.values); }
    get_value(name) { return this.values[name]; }
    set_value(name, value) { this.values[name] = value; const entry = this.fields_dict[name]; if (entry && entry.input) { if (entry.df.fieldtype === 'Check') entry.input.checked = !!value; else entry.input.value = value == null ? '' : value; } return Promise.resolve(); }
    async set_values(values) { for (const key of Object.keys(values || {})) await this.set_value(key, values[key]); }
    set_df_property(name, prop, value) { const entry = this.fields_dict[name]; if (entry) entry.df[prop] = value; }
    get_primary_btn() { return { prop: () => {} }; }
  };
  return instances;
}
const fieldsByName = (dialog) => { const out = {}; for (const field of dialog.options.fields) if (field.fieldname) out[field.fieldname] = field; return out; };

test('the share dialog on Desk manages per-user read-only grants natively', async (t) => {
  const shares = [{ user: 'colleague@example.test', full_name: 'Colleague One' }];
  const { app, window, document, calls, snapshot } = harness(t, {
    conversation_share_users: () => copy(shares),
    share_conversation: (args) => { shares.push({ user: args.user, full_name: 'New Person' }); return { conversation: { shared: 1 }, shares: copy(shares) }; },
    unshare_conversation: (args) => { shares.splice(shares.findIndex((row) => row.user === args.user), 1); return { conversation: { shared: 0 }, shares: copy(shares) }; }
  });
  app.selected = 'c1'; app.snapshot = snapshot;
  const dialogs = stubNativeDialogs(window);
  app.shareDialog(); await tick(); await tick();
  assert.equal(document.querySelector('.fi-modal-overlay'), null, 'no custom overlay on Desk');
  assert.equal(dialogs.length, 1);
  const dialog = dialogs[0];
  assert.equal(dialog.options.title, 'Share conversation');
  const byField = fieldsByName(dialog);
  assert.equal(byField.share_with.fieldtype, 'Link');
  assert.equal(byField.share_with.options, 'User', 'the picker is a native User link field');
  assert.ok(byField.copy.options.includes('read only view'), 'explains the read-only grant');
  const host = dialog.body.querySelector('[data-shares-host]');
  assert.ok(host.textContent.includes('Colleague One'), 'current shares load on open');
  assert.ok(host.textContent.includes('colleague@example.test'));
  assert.equal(calls.find((call) => call.method === 'conversation_share_users').args.conversation, 'c1');
  dialog.options.primary_action({ share_with: '' }); await tick(); await tick();
  assert.ok(dialog.body.querySelector('.fi-modal-error').textContent.includes('Choose a user'), 'an empty user is rejected inline');
  assert.equal(calls.some((call) => call.method === 'share_conversation'), false, 'no API call for an empty user');
  dialog.options.primary_action({ share_with: 'person@example.test' }); await tick(); await tick(); await tick();
  const grant = calls.find((call) => call.method === 'share_conversation');
  assert.deepEqual(copy(grant.args), { conversation: 'c1', user: 'person@example.test' });
  assert.ok(host.textContent.includes('New Person'), 'the list repaints and the dialog stays open');
  assert.equal(dialog.get_value('share_with'), '', 'the user field clears for the next share');
  assert.equal(app.snapshot.conversation.shared, 1, 'the snapshot merges the new shared flag');
  const unshare = Array.from(host.querySelectorAll('[data-action="unshare-user"]')).find((node) => node.dataset.user === 'person@example.test');
  assert.ok(unshare, 'the granted user has a revoke button');
  unshare.click(); await tick(); await tick(); await tick();
  const revoke = calls.find((call) => call.method === 'unshare_conversation');
  assert.deepEqual(copy(revoke.args), { conversation: 'c1', user: 'person@example.test' });
  assert.equal(host.textContent.includes('New Person'), false, 'the revoked user leaves the list');
  assert.equal(app.snapshot.conversation.shared, 0);
});
