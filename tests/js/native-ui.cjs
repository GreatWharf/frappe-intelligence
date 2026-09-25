/* Browser layout contracts for the native Desk restyle; APIs remain mock fixtures. */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const port = Number(process.env.NATIVE_PREVIEW_PORT || 8793);
const base = 'http://127.0.0.1:' + port;
const server = spawn(process.execPath, [path.join(root, 'dev/preview-server.cjs')], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Preview did not start')), 15000);
  server.stdout.on('data', (chunk) => { if (String(chunk).includes('Mock Intelligence preview:')) { clearTimeout(timer); resolve(); } });
  server.on('error', (error) => { clearTimeout(timer); reject(error); });
  server.on('exit', (code) => { clearTimeout(timer); reject(new Error('Preview stopped: ' + code)); });
});
let browser;
(async () => {
  await ready;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1040 }, reducedMotion: 'reduce' });
  await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.goto(base + '/?scene=empty');
  await page.waitForSelector('.fi-welcome');
  const failures = [];
  const expect = (condition, message) => { if (!condition) failures.push(message); };
  expect(await page.locator('.fi-brand').count() === 0, 'Sidebar must not repeat the Intelligence product heading');
  expect(!(await page.locator('.mock-breadcrumb').textContent()).includes('Intelligence'), 'Preview breadcrumb must not repeat the page title');
  expect(await page.locator('.mock-logo').textContent() !== 'Desk', 'Preview must not invent a second application called Desk');
  expect(await page.locator('.fi-app').evaluate((el) => getComputedStyle(el).borderTopWidth) === '0px', 'Full-page chat must not have a second enclosing card border');
  // The header menu is gone: management lives in native Desk pages.
  expect(await page.locator('[data-action="menu"]').count() === 0, 'The three-dot header menu must not render');
  expect(await page.locator('.fi-menu-wrap').count() === 0, 'No menu wrapper may remain in the header');
  // The subtitle carries access state only: no provider title, model or effort.
  const subtitle = await page.locator('[data-slot="subtitle"]').textContent();
  expect(subtitle.trim() === 'Private · only you', 'Subtitle shows access state only: ' + JSON.stringify(subtitle));
  // Page mode pins the app into the remaining viewport so only the thread scrolls.
  const pin = await page.locator('.fi-app').evaluate((el) => ({ height: el.style.height, overflow: getComputedStyle(el).overflow }));
  expect(/^\d+px$/.test(pin.height), 'The page app is pinned to the remaining viewport: ' + JSON.stringify(pin));
  expect(pin.overflow === 'hidden', 'The pinned app clips to its own box: ' + pin.overflow);
  await page.locator('.fi-composer textarea').click();
  const focus = await page.locator('.fi-composer').evaluate((el) => {
    const style = getComputedStyle(el); return { border: style.borderColor, shadow: style.boxShadow };
  });
  const neutral = (color) => { const rgb = (color.match(/\d+/g) || []).slice(0, 3).map(Number); return rgb.length === 3 && Math.max(...rgb) - Math.min(...rgb) <= 6; };
  const rgb = (color) => (color.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(rgb(a)), y = lum(rgb(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const readable = async (selector) => page.locator(selector).first().evaluate((el) => {
    const style = getComputedStyle(el);
    let bg = style.backgroundColor, node = el;
    while ((/rgba?\(0, 0, 0, 0\)|transparent/.test(bg)) && node.parentElement) { node = node.parentElement; bg = getComputedStyle(node).backgroundColor; }
    return { text: style.color, bg };
  });
  expect(neutral(focus.border), 'Mouse focus must not apply a green composer border: ' + focus.border);
  expect(focus.shadow === 'none', 'Mouse focus must not create a colored composer halo: ' + focus.shadow);
  const composerLight = await readable('.fi-composer textarea');
  expect(ratio(composerLight.text, composerLight.bg) >= 4.5, 'Composer text must meet 4.5:1 contrast in light mode: ' + JSON.stringify(composerLight));
  // A selected conversation: the header stays one row and the subtitle still
  // shows no provider title, model or effort.
  await page.goto(base + '/?scene=approval');
  await page.waitForSelector('[data-action="approve"]');
  const chatSubtitle = await page.locator('[data-slot="subtitle"]').textContent();
  expect(!/effort|gpt-4\.1|Work account/.test(chatSubtitle), 'Selected conversation subtitle hides provider, model and effort: ' + JSON.stringify(chatSubtitle));
  // Buttons differ in height (icon buttons vs the labeled New button) and the
  // header center-aligns them, so "one row" means one shared vertical center,
  // not one shared top. A wrapped second line would split the centers wide.
  const pageRow = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('.fi-app:not(.fi-drawer-app) .fi-header-actions [data-action]')).filter((node) => node.offsetParent !== null);
    const centers = buttons.map((node) => { const rect = node.getBoundingClientRect(); return (rect.top + rect.bottom) / 2; });
    return { spread: centers.length ? Math.max(...centers) - Math.min(...centers) : 0, count: buttons.length };
  });
  expect(pageRow.count >= 3 && pageRow.spread <= 2, 'Page header actions share one row with a conversation open: ' + JSON.stringify(pageRow));
  await page.locator('#theme-toggle').click();
  const composerDark = await readable('.fi-composer textarea');
  expect(ratio(composerDark.text, composerDark.bg) >= 4.5, 'Composer text must meet 4.5:1 contrast in dark mode: ' + JSON.stringify(composerDark));
  // Drawer mode: at the default 420px and the 360px minimum the header actions
  // stay on one row and the conversation title truncates instead of wrapping.
  await page.goto(base + '/?scene=empty');
  await page.waitForSelector('.fi-welcome');
  await page.evaluate(() => localStorage.setItem('fi-panel-state', JSON.stringify({ open: false, width: 420, conversation: 'chat-1' })));
  await page.evaluate(() => frappe.set_route('Form', 'Customer', 'Northstar Components'));
  await page.locator('.fi-global-toggle').click();
  await page.waitForFunction(() => {
    const title = document.querySelector('.fi-drawer-shell:not([hidden]) [data-slot="title"]');
    return title && title.textContent.trim() === 'Review outstanding sales orders';
  });
  const drawerRow = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('.fi-drawer-app .fi-header-actions [data-action]')).filter((node) => node.offsetParent !== null);
    const centers = buttons.map((node) => { const rect = node.getBoundingClientRect(); return (rect.top + rect.bottom) / 2; });
    return { spread: centers.length ? Math.max(...centers) - Math.min(...centers) : 0, count: buttons.length, width: Math.round(document.querySelector('.fi-drawer-shell').getBoundingClientRect().width) };
  });
  expect(drawerRow.width === 420 && drawerRow.count >= 5 && drawerRow.spread <= 2, 'Drawer header actions share one row at 420px: ' + JSON.stringify(drawerRow));
  const compact = await page.evaluate(() => {
    document.querySelector('.fi-drawer-shell').style.width = '360px';
    const buttons = Array.from(document.querySelectorAll('.fi-drawer-app .fi-header-actions [data-action]')).filter((node) => node.offsetParent !== null);
    const centers = buttons.map((node) => { const rect = node.getBoundingClientRect(); return (rect.top + rect.bottom) / 2; });
    const title = document.querySelector('.fi-drawer-app .fi-heading h2');
    return { spread: centers.length ? Math.max(...centers) - Math.min(...centers) : 0, truncated: title.scrollWidth > title.clientWidth + 4 };
  });
  expect(compact.spread <= 2, 'Drawer header actions still share one row at the 360px minimum: ' + JSON.stringify(compact));
  expect(compact.truncated, 'The conversation title truncates with an ellipsis instead of pushing the actions onto a second line');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + '/?scene=empty');
  await page.waitForSelector('.fi-welcome');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'The app must not overflow the phone viewport');
  assert.deepEqual(failures, [], failures.join('\n'));
  console.log('Native Desk layout contracts passed: single page hierarchy, no header menu, state-only subtitle, page-mode pin, single-row page and drawer headers, title truncation, neutral theme/focus and text contrast in both themes.');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.kill('SIGTERM'); });
