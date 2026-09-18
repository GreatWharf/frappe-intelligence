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
  await page.locator('[data-action="menu"]').click();
  await page.locator('.fi-menu [data-action="settings"]').click();
  const dimensions = await page.locator('.fi-provider-form').evaluate((form) => {
    const box = (name) => { const rect = form.elements[name].getBoundingClientRect(); return { width: rect.width, height: rect.height }; };
    return { provider: box('kind'), model: box('model'), title: box('title'), key: box('api_key') };
  });
  expect(Math.abs(dimensions.provider.width - dimensions.model.width) <= 2, 'Provider and Model ID must use equal-width columns: ' + JSON.stringify(dimensions));
  expect(Math.abs(dimensions.provider.height - dimensions.model.height) <= 1, 'Provider select and Model ID input must have matching heights');
  expect(Math.abs(dimensions.title.height - dimensions.key.height) <= 1, 'Provider input heights must be consistent');
  const primary = await page.locator('.fi-provider-form button[type="submit"]').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(neutral(primary), 'Default primary controls must use the native neutral theme, not green: ' + primary);
  const inputLight = await readable('.fi-provider-form input[name="title"]');
  expect(ratio(inputLight.text, inputLight.bg) >= 4.5, 'Dialog inputs must meet 4.5:1 contrast in light mode: ' + JSON.stringify(inputLight));
  await page.locator('.fi-modal-overlay [data-action="modal-close"]').click();
  await page.waitForSelector('.fi-modal-overlay', { state: 'detached' });
  await page.locator('#theme-toggle').click();
  await page.locator('[data-action="menu"]').click();
  await page.locator('.fi-menu [data-action="settings"]').click();
  const dark = await page.locator('.fi-provider-form button[type="submit"]').evaluate((el) => { const s = getComputedStyle(el); return { background: s.backgroundColor, text: s.color }; });
  expect(neutral(dark.background) && neutral(dark.text) && dark.background !== dark.text, 'Dark-mode primary controls must retain neutral contrast');
  const inputDark = await readable('.fi-provider-form input[name="title"]');
  expect(ratio(inputDark.text, inputDark.bg) >= 4.5, 'Dialog inputs must meet 4.5:1 contrast in dark mode: ' + JSON.stringify(inputDark));
  await page.locator('.fi-modal-overlay [data-action="modal-close"]').click();
  await page.waitForSelector('.fi-modal-overlay', { state: 'detached' });
  const composerDark = await readable('.fi-composer textarea');
  expect(ratio(composerDark.text, composerDark.bg) >= 4.5, 'Composer text must meet 4.5:1 contrast in dark mode: ' + JSON.stringify(composerDark));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-action="menu"]').click();
  await page.locator('.fi-menu [data-action="settings"]').click();
  const mobile = await page.locator('.fi-provider-form').evaluate((form) => {
    const provider = form.elements.kind.getBoundingClientRect(), model = form.elements.model.getBoundingClientRect();
    return { providerBottom: provider.bottom, modelTop: model.top, width: document.documentElement.scrollWidth, viewport: innerWidth };
  });
  expect(mobile.modelTop >= mobile.providerBottom, 'Provider and model fields must stack on phones');
  expect(mobile.width <= mobile.viewport, 'Provider editor must not overflow the phone viewport');
  assert.deepEqual(failures, [], failures.join('\n'));
  console.log('Native Desk layout contracts passed: single page hierarchy, neutral theme/focus, text contrast in both themes, balanced controls and mobile stacking.');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.kill('SIGTERM'); });
