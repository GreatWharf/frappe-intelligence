/* Optional real-browser panel suite: shortcut, pill, resize persistence and the full-page handoff.
 * Runs against the explicit local mock preview; this does not certify live Frappe/provider behavior.
 */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'dev/screenshots');
const port = Number(process.env.PANEL_PREVIEW_PORT || 8895);
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
  await ready; fs.mkdirSync(output, { recursive: true });
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1040 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await context.newPage(), errors = [], outbound = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => { if (!route.request().url().startsWith(base)) { outbound.push(route.request().url()); await route.abort(); } else await route.continue(); });
  const screenshot = (name) => page.screenshot({ path: path.join(output, name + '.png'), fullPage: true });
  const drawer = page.locator('.fi-drawer-shell');
  // The drawer clears [hidden] first, then animateOpen() applies is-open on the
  // next frame and the shell slides in over .22s. A :not([hidden]) wait resolves
  // while the shell is still translated off-screen, so measuring or pressing the
  // resize strip then can land outside the viewport on a slow runner.
  const waitForDrawerSettled = () => page.waitForFunction(() => {
    const shell = document.querySelector('.fi-drawer-shell');
    if (!shell || shell.hidden || !shell.classList.contains('is-open')) return false;
    const rect = shell.getBoundingClientRect();
    return Math.abs(rect.right - window.innerWidth) < 1;
  });
  await page.goto(base + '/?scene=context');
  await page.waitForSelector('.fi-drawer-shell:not([hidden]) .fi-context-chip');
  await waitForDrawerSettled();
  assert.ok((await page.locator('.fi-context-chip').textContent()).includes('Northstar Components'), 'the drawer opens with the record context chip');
  await screenshot('panel-drawer-context');
  await page.keyboard.press('Control+Shift+I');
  await page.waitForSelector('.fi-drawer-shell', { state: 'hidden' });
  assert.equal(await drawer.isVisible(), false, 'Ctrl+Shift+I closes the drawer');
  await page.locator('.fi-global-toggle').click();
  await waitForDrawerSettled();
  assert.equal(await drawer.isVisible(), true, 'the pill reopens the drawer');
  const strip = page.locator('.fi-drawer-resize');
  const before = (await drawer.boundingBox()).width;
  const handle = await strip.boundingBox();
  // Aim at the strip's inner sliver: its midpoint is exactly the shell's
  // border pixel, which hit-tests differently across platforms.
  const startX = handle.x + handle.width - 1, startY = handle.y + handle.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - 120, startY, { steps: 6 });
  const dragged = (await drawer.boundingBox()).width;
  if (Math.abs(dragged - (before + 120)) > 6) {
    const diag = await page.evaluate(
      ([x, y]) => {
        const shell = document.querySelector('.fi-drawer-shell');
        const hit = document.elementFromPoint(x, y);
        const rect = shell.getBoundingClientRect();
        return {
          hit: hit ? hit.className || hit.tagName : null,
          press: { x, y },
          shellRect: { left: rect.left, width: rect.width },
          shellClass: shell.className,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          computedWidth: getComputedStyle(shell).width,
        };
      },
      [startX, startY]
    );
    throw new assert.AssertionError({
      message: 'dragging the strip widens the drawer: ' + before + ' -> ' + dragged + '; at the press point: ' + JSON.stringify(diag) + '; page errors: ' + JSON.stringify(errors),
    });
  }
  await page.mouse.up();
  await page.waitForFunction(() => !document.querySelector('.fi-drawer-shell').classList.contains('is-resizing'));
  await screenshot('panel-drawer-resized');
  await page.reload();
  await waitForDrawerSettled();
  const restored = (await drawer.boundingBox()).width;
  assert.ok(Math.abs(restored - dragged) <= 6, 'the dragged width survives reload: ' + dragged + ' -> ' + restored);
  await page.locator('[data-action="open-full-page"]').click();
  await page.waitForSelector('.fi-drawer-shell', { state: 'hidden' });
  await page.waitForSelector('#page:not([hidden]) .fi-app');
  assert.equal(await page.evaluate(() => frappe.get_route()[0]), 'intelligence', 'open full page routes to the Intelligence page');
  assert.ok(await page.locator('#page .fi-welcome').isVisible(), 'the page app renders after the handoff');
  await screenshot('panel-full-page');
  assert.deepEqual(errors, []); assert.deepEqual(outbound, []);
  console.log('Panel browser flows passed: context chip, shortcut toggle, pill reopen, drag-resize persistence across reload, full-page handoff.');
  console.log('Screenshots saved to ' + output + '. Fixture host only; no live Frappe or provider validation.');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.kill('SIGTERM'); });
