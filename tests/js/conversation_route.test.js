'use strict';
/* Conversation deep-links: list rows (get_form_link) and stray Form routes
   (global-search/awesomebar hits) both land on the /desk/intelligence/<name>
   chat page instead of a Form view. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const LIST_MODULE = path.resolve(__dirname, '../../frappe_intelligence/public/js/intelligence_conversation_list.js');
const FORM_MODULE = path.resolve(__dirname, '../../frappe_intelligence/public/js/intelligence_conversation_form.js');

function freshRequire(file) {
  delete require.cache[file];
  delete globalThis.fi;
  return require(file);
}

test('conversationRoute encodes the docname into the chat page URL', () => {
  const fi = freshRequire(LIST_MODULE);
  assert.equal(fi.conversationRoute('abc123'), '/desk/intelligence/abc123');
  assert.equal(fi.conversationRoute('chat 1/x'), '/desk/intelligence/chat%201%2Fx');
});

test('listview settings register get_form_link for the List view', () => {
  globalThis.frappe = {};
  const fi = freshRequire(LIST_MODULE);
  const settings = globalThis.frappe.listview_settings['Intelligence Conversation'];
  assert.equal(settings, fi.conversationListSettings);
  assert.equal(typeof settings.get_form_link, 'function');
  assert.equal(settings.get_form_link({ name: 'c 9' }), '/desk/intelligence/c%209');
  delete globalThis.frappe;
});

test('form script redirects onload to the chat page', () => {
  const registrations = [];
  const routes = [];
  globalThis.frappe = {
    ui: { form: { on: (doctype, handlers) => registrations.push([doctype, handlers]) } },
    set_route: (...args) => routes.push(args),
  };
  freshRequire(FORM_MODULE);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0][0], 'Intelligence Conversation');
  assert.equal(typeof registrations[0][1].onload, 'function');
  registrations[0][1].onload({ doc: { name: 'c1' } });
  assert.deepEqual(routes, [['intelligence', 'c1']]);
  delete globalThis.frappe;
});

test('form redirect registration is a no-op without frappe.ui.form', () => {
  const fi = freshRequire(FORM_MODULE);
  assert.equal(fi.registerConversationFormRedirect({}), false);
  assert.equal(fi.registerConversationFormRedirect({ frappe: {} }), false);
  assert.equal(fi.conversationFormRoute('c2').join('/'), 'intelligence/c2');
});
