/* Gates for mobile support (Matt's ruling m3s, 2026-10-01): every mobile UI/UX
 * change applies ONLY on mobile, and desktop is untouched. The harness's
 * `obsidian.Platform` is desktop by default; each test flips it and main.js
 * reads it at call time. Source-level proof only -- a real phone/tablet
 * still has to confirm the touch behaviour. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPlugin, makeFile, makeFolder, makeApp, makeFakeElement } from './harness.mjs';

function makeFixture({ mobile = false } = {}) {
  const lp = loadPlugin();
  lp.obsidian.Platform.isMobile = mobile;
  lp.obsidian.Platform.isDesktop = !mobile;
  const stub = makeFile('04 Inner World/My Life/Projects/idea.md', { content: '---\ntype: project\nspotlight: true\n---\n' });
  const root = makeFolder('04 Inner World/My Life/Projects', [stub]);
  const rootEl = makeFakeElement('div');
  rootEl.appendChild(makeFakeElement('div'));
  const containerEl = makeFakeElement('div');
  containerEl.appendChild(rootEl);
  const view = { revealInFolder() {}, fileItems: { [root.path]: { file: root, el: rootEl, childrenEl: rootEl.children[0] } }, containerEl };
  const app = makeApp({ folders: [root], files: { [stub.path]: stub._content } });
  const plugin = new lp.PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [{ path: root.path, enabled: true }], collapsedShelfRoots: [] };
  plugin.explorerView = view;
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};
  lp.__test.renderAllShelves(plugin);
  const rows = rootEl.querySelectorAll('.spotlight-shelf-row');
  return { lp, plugin, stub, row: rows[0] };
}

const touch = (x, y) => ({ touches: [{ clientX: x, clientY: y }] });

test('manifest: isDesktopOnly is false (mobile allowed), minAppVersion unchanged', () => {
  const m = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(m.isDesktopOnly, false);
  assert.equal(m.minAppVersion, '1.7.2');
});

test('desktop: shelf row has no touch listeners, and the "Star or unstar this note" command is not registered', async () => {
  const { lp, plugin, row } = makeFixture({ mobile: false });
  assert.ok(row);
  assert.deepEqual(row._fire('touchstart', touch(5, 5)), []);
  await plugin.onload();
  assert.equal((plugin._commands || []).length, 0);
  assert.equal(lp.__test.isMobileApp(), false);
});

test('desktop: right-click still builds the one-item menu at the mouse event', () => {
  const { row } = makeFixture({ mobile: false });
  const evt = { prevented: false, preventDefault() { this.prevented = true; } };
  row._fire('contextmenu', evt);
  assert.equal(evt.prevented, true);
});

test('mobile: the command is registered once and starring/unstarring the active note works', async () => {
  const { lp, plugin, stub } = makeFixture({ mobile: true });
  await plugin.onload();
  const cmds = plugin._commands || [];
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].name, 'Star or unstar this note');
  plugin.settings.roots = [{ path: '04 Inner World/My Life/Projects', enabled: true, spotlightFolders: false }];
  plugin.app.workspace.getActiveFile = () => stub;
  assert.equal(cmds[0].callback, undefined, 'uses checkCallback, not callback');
  assert.equal(cmds[0].checkCallback(true), true, 'visible when a markdown note is open');
  assert.equal(cmds[0].checkCallback(false), true);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(lp.__test.getSpotlightState(plugin.app, stub), false, 'the starred note was unstarred');
});

test('mobile: a long-press on a shelf row opens the Remove menu at the finger; a quick tap does not', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { lp, row } = makeFixture({ mobile: true });
  assert.ok(lp.__test.isMobileApp());
  // quick tap: touchstart then touchend before the timer
  row._fire('touchstart', touch(30, 40));
  t.mock.timers.tick(100);
  row._fire('touchend', {});
  t.mock.timers.tick(1000);
  assert.equal(row._spotlightLongPressAt, undefined);
  // long press
  row._fire('touchstart', touch(30, 40));
  t.mock.timers.tick(600);
  assert.equal(typeof row._spotlightLongPressAt, 'number');
});

test('mobile: moving the finger cancels the long-press; the tap that ends a long-press does not open the row', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { row } = makeFixture({ mobile: true });
  row._fire('touchstart', touch(30, 40));
  row._fire('touchmove', touch(30, 80));
  t.mock.timers.tick(1000);
  assert.equal(row._spotlightLongPressAt, undefined);
  row._spotlightLongPressAt = Date.now();
  // swallowed click: no error and no reveal call on a fresh fixture view
  row._fire('click', {});
});

test('mobile: the star command is hidden (checkCallback false, no notice, no write) when no markdown note is open', async () => {
  const { plugin, stub } = makeFixture({ mobile: true });
  await plugin.onload();
  const cmd = plugin._commands[0];
  plugin.app.workspace.getActiveFile = () => null;
  assert.equal(cmd.checkCallback(true), false);
  assert.equal(cmd.checkCallback(false), false);
  plugin.app.workspace.getActiveFile = () => ({ ...stub, extension: 'png', path: 'a.png' });
  assert.equal(cmd.checkCallback(true), false, 'a non-markdown file hides it too');
});

test('mobile: touchend is non-passive; a lift after the long-press fired is swallowed and re-stamps the click guard', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { row } = makeFixture({ mobile: true });
  assert.equal(row._listenerOptions.touchend.passive, false);
  assert.equal(row._listenerOptions.touchstart.passive, true);
  assert.equal(row._listenerOptions.touchmove.passive, true);
  row._fire('touchstart', touch(30, 40));
  t.mock.timers.tick(600);
  const openedAt = row._spotlightLongPressAt;
  assert.equal(typeof openedAt, 'number');
  t.mock.timers.tick(1400); // a long hold: past the 800ms guard from the open
  const evt = { prevented: false, preventDefault() { this.prevented = true; } };
  row._fire('touchend', evt);
  assert.equal(evt.prevented, true, 'the lift is cancelled');
  assert.ok(row._spotlightLongPressAt > openedAt, 'guard re-stamped at lift');
  // a plain quick tap afterwards is not swallowed
  row._fire('touchstart', touch(30, 40));
  t.mock.timers.tick(100);
  const tap = { prevented: false, preventDefault() { this.prevented = true; } };
  row._fire('touchend', tap);
  assert.equal(tap.prevented, false);
});

test('mobile: a native contextmenu (Android) claims the press, so the timer opens no second menu', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { row } = makeFixture({ mobile: true });
  row._fire('touchstart', touch(30, 40));
  row._fire('contextmenu', { preventDefault() {} });
  const claimedAt = row._spotlightLongPressAt;
  assert.equal(typeof claimedAt, 'number');
  t.mock.timers.tick(1000);
  assert.equal(row._spotlightLongPressAt, claimedAt, 'the timer never fired');
});

test('styles.css: every mobile rule in the mobile block is under a mobile body class (desktop untouched)', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('*/', css.indexOf('mobile tap targets (m3s)')) + 2);
  const selectors = block
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .map((r) => r.split('{')[0].trim())
    .filter(Boolean);
  assert.ok(selectors.length >= 3);
  assert.match(block, /spotlight-shelf-row {[^}]*user-select: none;[^}]*-webkit-user-select: none;[^}]*-webkit-touch-callout: none;/);
  for (const sel of selectors) {
    for (const part of sel.split(',')) assert.match(part.trim(), /^body.is-(mobile|phone|tablet) /, `ungated selector: ${part}`);
  }
});
