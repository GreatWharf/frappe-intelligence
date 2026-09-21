'use strict';
/* desk_compat.js: guarded patch for the upstream frappe v16 SidebarHeader
   add_app_item icon bug (renders src="undefined" for icon_html-only items). */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULE = path.resolve(__dirname, '../../frappe_intelligence/public/js/fi/desk_compat.js');

function buggyHeader() {
  function SidebarHeader() {}
  // Same shape as upstream sidebar_header.js: icon branch else icon_url img,
  // never icon_html.
  SidebarHeader.prototype.add_app_item = function (item) {
    const icon = item.icon ? this.icon(item.icon) : '<img class="logo" src="' + item.icon_url + '">';
    this.dropdown_menu.append('<div class="dropdown-menu-item">' + icon + '</div>');
  };
  return SidebarHeader;
}

function fixedHeader() {
  function SidebarHeader() {}
  SidebarHeader.prototype.add_app_item = function (item) {
    const icon = item.icon ? this.icon(item.icon) : item.icon_url
      ? '<img class="logo" src="' + item.icon_url + '">'
      : (item.icon_html || '');
    this.dropdown_menu.append('<div class="dropdown-menu-item">' + icon + '</div>');
  };
  return SidebarHeader;
}

function mockGlobal(SidebarHeader) {
  return {
    frappe: {
      utils: { icon: (name) => '<svg data-icon="' + name + '"></svg>' },
      ui: {
        keys: { get_shortcut_label: (s) => 'Ctrl+' + s },
        SidebarHeader,
      },
    },
  };
}

function freshFi() {
  delete require.cache[MODULE];
  delete globalThis.fi;
  return require(MODULE);
}

test('buggy-shape add_app_item gets patched', () => {
  const fi = freshFi();
  const SidebarHeader = buggyHeader();
  const g = mockGlobal(SidebarHeader);
  assert.equal(fi.patchDeskIconGuard(g), 'patched');
  assert.equal(SidebarHeader.prototype.add_app_item[fi.deskIconGuardMarker], true);
});

test('replacement renders icon_html items without an undefined src', () => {
  const fi = freshFi();
  const SidebarHeader = buggyHeader();
  const g = mockGlobal(SidebarHeader);
  fi.patchDeskIconGuard(g);
  const rows = [];
  const ctx = { dropdown_menu: { append: (html) => rows.push(html) } };
  const render = (item) => { rows.length = 0; SidebarHeader.prototype.add_app_item.call(ctx, item); return rows[0]; };

  const glyph = render({ name: 'crm', label: 'CRM', route: '/desk/crm', icon_html: '<b class="glyph">C</b>' });
  assert.ok(glyph.includes('<b class="glyph">C</b>'));
  assert.ok(!glyph.includes('undefined'));
  assert.ok(glyph.includes('class="dropdown-menu-item"'));
  assert.ok(glyph.includes('data-name="crm"'));
  assert.ok(glyph.includes('data-app-route="/desk/crm"'));
  assert.ok(glyph.includes('<span class="menu-item-title">CRM</span>'));

  const image = render({ name: 'hr', label: 'HR', route: '/desk/hr', icon_url: '/assets/hr.svg' });
  assert.ok(image.includes('<img class="logo" src="/assets/hr.svg">'));
  assert.ok(!image.includes('undefined'));

  const icon = render({ name: 'desktop', label: 'Desktop', route: '/desk', icon: 'home' });
  assert.ok(icon.includes('<svg data-icon="home"></svg>'));

  const full = render({ name: 'web', label: 'Website', route: '', href: 'https://example.com', shortcut: 'W' });
  assert.ok(full.includes('href="https://example.com"'));
  assert.ok(full.includes('class="menu-item-shortcut"'));
  assert.ok(full.includes('Ctrl+W'));
  assert.ok(!full.includes('undefined'));
});

test('already-fixed upstream shape is left untouched', () => {
  const fi = freshFi();
  const SidebarHeader = fixedHeader();
  const original = SidebarHeader.prototype.add_app_item;
  assert.equal(fi.patchDeskIconGuard(mockGlobal(SidebarHeader)), 'clean');
  assert.equal(SidebarHeader.prototype.add_app_item, original);
});

test('double patch is idempotent', () => {
  const fi = freshFi();
  const SidebarHeader = buggyHeader();
  const g = mockGlobal(SidebarHeader);
  assert.equal(fi.patchDeskIconGuard(g), 'patched');
  const replacement = SidebarHeader.prototype.add_app_item;
  assert.equal(fi.patchDeskIconGuard(g), 'already');
  assert.equal(SidebarHeader.prototype.add_app_item, replacement);
});

test('missing SidebarHeader reports absent', () => {
  const fi = freshFi();
  assert.equal(fi.patchDeskIconGuard({}), 'absent');
  assert.equal(fi.patchDeskIconGuard({ frappe: {} }), 'absent');
  assert.equal(fi.patchDeskIconGuard({ frappe: { ui: {} } }), 'absent');
});
