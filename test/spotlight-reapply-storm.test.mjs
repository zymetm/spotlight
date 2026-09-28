/* Gates for 0.13.5:
 * a hide click fired while Obsidian Sync was actively writing triggered
 * ~12 reapply passes/second and 50-55ms long tasks -- "the plugin's own
 * MutationObserver... reacts to any childList mutation in the
 * explorer... and has no guard against external mutation of the explorer
 * or of its own data.json." Three independent mechanisms, three groups of
 * tests below:
 *
 *  1. `syncBranchToggleEl` becomes idempotent -- a same-value re-sync (what
 *     every reapply pass does for every already-correct hidden root) does
 *     zero DOM work, instead of unconditionally rewriting class/aria/icon
 *     every single pass ("syncBranchToggleEl
 *     runs on every reapply pass and writes the *same* value each time").
 *  2. `scheduleStarReapply` gets a burst budget + minimum interval, so a
 *     sustained storm of externally-triggered mutations coalesces into a
 *     bounded number of passes instead of one per animation frame for as
 *     long as the churn continues.
 *  3. The plugin's own `MutationObserver` callback filters out mutation
 *     records it caused itself (the branch toggle's own chevron icon
 *     swap) via `isSelfCausedMutation`, so a self-caused DOM write never
 *     even reaches `scheduleStarReapply()`.
 *
 * Must NOT regress (asserted here, not just claimed): the star-click
 * optimistic paint stays a direct, same-task `runReapply()` call, never
 * throttled; a small human-paced burst (2-3 passes, one native
 * expand/collapse cycle) still fires every pass at full rAF speed; idle
 * stays at 0 passes however long real time advances; a genuinely external
 * mutation record is never silently dropped.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugin, makeFile, makeFolder, makeApp, makeFakeElement, FakeMutationObserver } from './harness.mjs';

const { __test, document, obsidian } = loadPlugin();
const { syncBranchToggleEl, renderAllShelves, isSelfCausedMutation, isSpotlightOwnedNode } = __test;

/* ------------------------------------------------------------------ *
 * 1. syncBranchToggleEl idempotence
 * ------------------------------------------------------------------ */

function makeToggleEl() {
  const toggle = document.createElement('div');
  toggle.className = 'spotlight-branch-toggle';
  const tab = document.createElement('span');
  tab.className = 'spotlight-branch-toggle-tab';
  toggle.appendChild(tab);
  return toggle;
}

test('syncBranchToggleEl (0.13.5): the FIRST sync on a freshly created band always does the real work, even for hidden=false (no aria-expanded attribute yet to compare against)', () => {
  const before = obsidian.setIcon.callCount;
  const toggle = makeToggleEl();
  syncBranchToggleEl(toggle, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.getAttribute('aria-label'), 'Hide everything below the shelf');
  assert.equal(toggle.classList.contains('is-hidden'), false);
  assert.equal(obsidian.setIcon.callCount, before + 1, 'the very first sync must paint the icon');
});

test('syncBranchToggleEl: a SECOND call with the SAME hidden value is a no-op -- no class/attribute/icon rewrite, exactly what every reapply pass over an unchanged hidden root does', () => {
  const toggle = makeToggleEl();
  syncBranchToggleEl(toggle, true); // first call -- real work
  const afterFirst = obsidian.setIcon.callCount;

  // Three more passes, unchanged -- an earlier measured storm ran ~12/s for 14s; this
  // is the exact call this plugin's own render path makes on every one
  // of those passes for every already-hidden root with an existing band.
  syncBranchToggleEl(toggle, true);
  syncBranchToggleEl(toggle, true);
  syncBranchToggleEl(toggle, true);

  assert.equal(obsidian.setIcon.callCount, afterFirst, 'no icon rewrite across three unchanged re-syncs');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.classList.contains('is-hidden'), true);
});

test('syncBranchToggleEl (0.13.5): a GENUINE value change still does the full work, every time', () => {
  const toggle = makeToggleEl();
  syncBranchToggleEl(toggle, false);
  const afterShow = obsidian.setIcon.callCount;
  syncBranchToggleEl(toggle, true);
  assert.equal(obsidian.setIcon.callCount, afterShow + 1, 'a real hidden<->shown transition must repaint the icon');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  syncBranchToggleEl(toggle, false);
  assert.equal(obsidian.setIcon.callCount, afterShow + 2, 'and flipping back again is real work too');
});

/* ------------------------------------------------------------------ *
 * renderAllShelves end-to-end: an unchanged pass over a real hidden
 * root's own toggle band does zero icon work on the second/third pass.
 * ------------------------------------------------------------------ */

function makeBranchFixture() {
  const flat = makeFile('Goals/Alpha.md', { content: '---\ntype: goal\nspotlight: true\n---\n' });
  const root = makeFolder('Goals', [flat]);
  const rootEl = makeFakeElement('div');
  const rootChildrenEl = makeFakeElement('div');
  rootEl.appendChild(rootChildrenEl);
  const app = makeApp({ folders: [root], files: { [flat.path]: flat._content } });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.settings = {
    roots: [{ path: 'Goals', enabled: true }],
    collapsedShelfRoots: [],
    collapsedBranchRoots: ['Goals'],
  };
  plugin.explorerView = { fileItems: { Goals: { file: root, el: rootEl, childrenEl: rootChildrenEl } } };
  return { plugin, rootEl };
}

test('renderAllShelves (0.13.5): re-running a pass with nothing changed does not repaint an already-synced, already-hidden branch toggle', () => {
  const { plugin, rootEl } = makeBranchFixture();
  renderAllShelves(plugin); // first pass -- real paint, creates the band
  const toggle = rootEl.querySelector(':scope > .spotlight-branch-toggle');
  assert.ok(toggle, 'sanity: the band actually rendered');
  const before = obsidian.setIcon.callCount;

  renderAllShelves(plugin); // second pass -- nothing changed
  renderAllShelves(plugin); // a third, for good measure -- an earlier measured storm ran many more than this
  renderAllShelves(plugin);

  assert.equal(obsidian.setIcon.callCount, before, 'three unchanged passes must not rewrite the toggle icon even once');
});

/* ------------------------------------------------------------------ *
 * 2. scheduleStarReapply: burst budget + minimum interval
 * ------------------------------------------------------------------ */

function makeSchedulerPlugin(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { PluginClass } = loadPlugin({ requestAnimationFrame: (cb) => setTimeout(cb, 0) });
  const plugin = new PluginClass({}, { id: 'spotlight', version: '0.0.0-gate' });
  let passCount = 0;
  const passTimestamps = [];
  // Stubs the FULL reapply cost (star/shelf walk) away, on purpose -- this
  // group tests the SCHEDULING logic in isolation, not the render cost --
  // but still reproduces the one side effect `scheduleStarReapply`'s own
  // burst-budget check depends on: the real `runReapply()` logs every
  // pass's timestamp to `this._reapplyPassLog` BEFORE doing any rendering
  // work, so this stub does exactly that and nothing else.
  plugin.runReapply = () => {
    passCount++;
    const now = Date.now();
    passTimestamps.push(now);
    plugin._reapplyPassLog = plugin._reapplyPassLog || [];
    plugin._reapplyPassLog.push(now);
  };
  return { plugin, getPassCount: () => passCount, passTimestamps };
}

test('scheduleStarReapply: a sustained mutation storm coalesces into a bounded number of passes -- never one per mutation', (t) => {
  const { plugin, getPassCount } = makeSchedulerPlugin(t);

  // 200 externally-triggered mutations spread over 2 simulated seconds --
  // the same shape as a real, measured ~12/s-for-14s storm, sized to run
  // instantly under mock time. Each call is exactly what this plugin's
  // own MutationObserver callback does on an unfiltered external record.
  const mutationCount = 200;
  const totalMs = 2000;
  for (let i = 0; i < mutationCount; i++) {
    plugin.scheduleStarReapply();
    t.mock.timers.tick(totalMs / mutationCount);
  }
  t.mock.timers.tick(400); // let a still-pending deferred pass land

  const passCount = getPassCount();
  assert.ok(passCount >= 1, 'a trailing pass must still land -- churn must never be silently dropped');
  assert.ok(passCount < mutationCount, `expected far fewer than ${mutationCount} passes, got ${passCount}`);
  // Burst budget 3 (near-instant) + ~2000ms/250ms min-interval passes
  // (~8) + slack for the trailing pass and rounding -- generous, but
  // still an order of magnitude below the ~200 passes today's
  // unthrottled code produces under this exact storm.
  assert.ok(passCount <= 20, `expected a BOUNDED pass count under sustained churn, got ${passCount}`);
});

test('scheduleStarReapply (0.13.5): once throttled, passes are spaced at least REAPPLY_MIN_INTERVAL_MS apart', (t) => {
  const { plugin, passTimestamps } = makeSchedulerPlugin(t);
  for (let i = 0; i < 200; i++) {
    plugin.scheduleStarReapply();
    t.mock.timers.tick(10);
  }
  t.mock.timers.tick(400);

  assert.ok(passTimestamps.length >= 4, 'need enough passes to check post-budget spacing');
  // Skip the first 3 (the un-throttled burst budget) -- every pass AFTER
  // that must be spaced out.
  for (let i = 4; i < passTimestamps.length; i++) {
    const gap = passTimestamps[i] - passTimestamps[i - 1];
    assert.ok(gap >= 200, `pass ${i} landed only ${gap}ms after the previous one -- expected roughly REAPPLY_MIN_INTERVAL_MS (250ms) apart once throttled`);
  }
});

test('scheduleStarReapply: a normal small burst (2-3 mutations from one native expand/collapse cycle, 0.13.3\'s own measured number) fires every pass at full rAF speed -- untouched by the storm ceiling', (t) => {
  const { plugin, getPassCount } = makeSchedulerPlugin(t);

  plugin.scheduleStarReapply();
  t.mock.timers.tick(5);
  plugin.scheduleStarReapply();
  t.mock.timers.tick(5);
  plugin.scheduleStarReapply();
  t.mock.timers.tick(5);

  assert.equal(getPassCount(), 3, 'a small, human-paced burst must still get a pass for every mutation -- never throttled');
});

test('scheduleStarReapply: idle stays idle -- no mutation, no pass, however long time advances', (t) => {
  const { plugin, getPassCount } = makeSchedulerPlugin(t);
  t.mock.timers.tick(10_000);
  assert.equal(getPassCount(), 0);
});

test('scheduleStarReapply: a direct plugin.runReapply() call (the star-click optimistic path) is never throttled -- it bypasses the scheduler entirely', (t) => {
  const { plugin, getPassCount } = makeSchedulerPlugin(t);
  // Simulate several rapid star clicks, each calling runReapply()
  // DIRECTLY the way handleStarActivate does -- never through
  // scheduleStarReapply.
  for (let i = 0; i < 10; i++) plugin.runReapply();
  assert.equal(getPassCount(), 10, 'every direct call must still run, synchronously, uncoalesced and unthrottled');
});

/* ------------------------------------------------------------------ *
 * 3. Self-caused mutation filtering
 * ------------------------------------------------------------------ */

test('isSpotlightOwnedNode: recognises a plugin-owned element by its spotlight- prefixed class, walking up through an unprefixed ancestor', () => {
  const outer = document.createElement('div'); // e.g. the native tree-item row
  const toggle = document.createElement('div');
  toggle.className = 'spotlight-branch-toggle';
  const tab = document.createElement('span');
  tab.className = 'spotlight-branch-toggle-tab';
  outer.appendChild(toggle);
  toggle.appendChild(tab);

  assert.equal(isSpotlightOwnedNode(tab), true, 'the tab itself is plugin-owned');
  assert.equal(isSpotlightOwnedNode(outer), false, 'the native ancestor is not, even though a plugin-owned child hangs off it');
});

test('isSpotlightOwnedNode: a NATIVE row nested under a hidden branch (item.el carrying spotlight-branch-hidden, Obsidian\'s OWN class target, not plugin-created markup) is never mistaken for plugin-owned', () => {
  const hiddenItemEl = document.createElement('div'); // Obsidian's OWN row -- this plugin only ever toggles a class on it, never creates it
  hiddenItemEl.className = 'tree-item nav-folder-title spotlight-branch-hidden';
  const nativeChild = document.createElement('div'); // a real file row somewhere under the hidden branch
  nativeChild.className = 'tree-item nav-file-title';
  hiddenItemEl.appendChild(nativeChild);

  assert.equal(isSpotlightOwnedNode(nativeChild), false, 'a genuinely native row must never read as plugin-owned just because an ancestor is branch-hidden');
  assert.equal(isSpotlightOwnedNode(hiddenItemEl), false, 'the hidden item.el itself is not plugin-owned either -- only the class on it is this plugin\'s');
});

test('isSpotlightOwnedNode (0.13.6, condition E): a real plugin-owned element (the shelf) STILL reads as owned even nested under a spotlight-branch-hidden ancestor', () => {
  const hiddenItemEl = document.createElement('div');
  hiddenItemEl.className = 'tree-item nav-folder-title spotlight-branch-hidden';
  const shelf = document.createElement('div');
  shelf.className = 'spotlight-shelf';
  hiddenItemEl.appendChild(shelf);

  assert.equal(isSpotlightOwnedNode(shelf), true, 'the shelf itself is still recognised -- only spotlight-branch-hidden is carved out of the prefix test, nothing else');
});

test('isSelfCausedMutation (0.13.5): a record whose target is the branch toggle\'s own tab (the chevron icon swap) is self-caused', () => {
  const toggle = makeToggleEl();
  const tab = toggle.querySelector(':scope > .spotlight-branch-toggle-tab');
  const records = [{ target: tab, addedNodes: [], removedNodes: [] }];
  assert.equal(isSelfCausedMutation(records), true);
});

test('isSelfCausedMutation: a record whose target is a NATIVE explorer element is never self-caused -- real external churn must never be silently dropped', () => {
  const nativeChildrenEl = document.createElement('div');
  const records = [{ target: nativeChildrenEl, addedNodes: [], removedNodes: [] }];
  assert.equal(isSelfCausedMutation(records), false);
});

test('isSelfCausedMutation: a MIXED batch (one plugin-owned record, one native) is treated as relevant -- ANY genuinely external record in the batch means the whole batch is real', () => {
  const toggle = makeToggleEl();
  const tab = toggle.querySelector(':scope > .spotlight-branch-toggle-tab');
  const nativeChildrenEl = document.createElement('div');
  const records = [
    { target: tab, addedNodes: [], removedNodes: [] },
    { target: nativeChildrenEl, addedNodes: [], removedNodes: [] },
  ];
  assert.equal(isSelfCausedMutation(records), false);
});

test('isSelfCausedMutation: an empty or missing record set is treated as RELEVANT, never silently swallowed', () => {
  assert.equal(isSelfCausedMutation([]), false);
  assert.equal(isSelfCausedMutation(undefined), false);
  assert.equal(isSelfCausedMutation(null), false);
});

test('isSelfCausedMutation: a mutation under a hidden branch (Sync writing a file, a bulk rename, another plugin) is never silently dropped as self-caused', () => {
  const hiddenItemEl = document.createElement('div'); // Obsidian's OWN row, carrying the class this plugin toggled onto it
  hiddenItemEl.className = 'tree-item nav-folder-title spotlight-branch-hidden';
  const nativeChild = document.createElement('div'); // some real row Sync/a bulk rename/another plugin touched
  nativeChild.className = 'tree-item nav-file-title';
  hiddenItemEl.appendChild(nativeChild);

  const records = [{ target: nativeChild, addedNodes: [], removedNodes: [] }];
  assert.equal(isSelfCausedMutation(records), false, 'a genuinely external mutation under a hidden root must still trigger a reapply -- the OLD unqualified spotlight- prefix test read the ancestor\'s own spotlight-branch-hidden class and wrongly dropped this');
});

/* ------------------------------------------------------------------ *
 * End-to-end: the plugin's own starObserver callback, wired through
 * installRowInjection(), actually applies the filter before ever
 * calling scheduleStarReapply().
 * ------------------------------------------------------------------ */

function makeObserverFixture() {
  const flat = makeFile('Goals/Alpha.md', { content: '---\ntype: goal\nspotlight: true\n---\n' });
  const root = makeFolder('Goals', [flat]);
  const rootEl = makeFakeElement('div');
  const rootChildrenEl = makeFakeElement('div');
  rootEl.appendChild(rootChildrenEl);
  const containerEl = makeFakeElement('div');
  containerEl.appendChild(rootEl);

  class FakeExplorerView {}
  FakeExplorerView.prototype.revealInFolder = function (file) {
    this._revealed = file;
  };
  const view = new FakeExplorerView();
  view.fileItems = { [root.path]: { file: root, el: rootEl, childrenEl: rootChildrenEl } };
  view.containerEl = containerEl;

  const app = makeApp({ folders: [root], files: { [flat.path]: flat._content } });
  const { PluginClass, __test: localTest } = loadPlugin({ MutationObserver: FakeMutationObserver, requestAnimationFrame: (cb) => cb() });
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [{ path: 'Goals', enabled: true }], collapsedShelfRoots: [], collapsedBranchRoots: [] };
  plugin.explorerView = view;
  plugin.requestExplorerSort = () => {};
  plugin.installRowInjection();
  return { plugin, view, rootEl, rootChildrenEl, renderAllShelvesLocal: localTest.renderAllShelves };
}

test('starObserver callback (0.13.5, end-to-end through installRowInjection): a record targeting the plugin\'s own branch-toggle tab never reaches scheduleStarReapply()', () => {
  const { plugin, rootEl, renderAllShelvesLocal } = makeObserverFixture();
  renderAllShelvesLocal(plugin); // build a real band to reference
  const toggle = rootEl.querySelector(':scope > .spotlight-branch-toggle');
  const tab = toggle.querySelector(':scope > .spotlight-branch-toggle-tab');
  assert.ok(plugin.starObserver, 'sanity: the fake MutationObserver actually got wired');

  let scheduleCalls = 0;
  plugin.scheduleStarReapply = () => {
    scheduleCalls++;
  };

  plugin.starObserver.deliver([{ target: tab, addedNodes: [], removedNodes: [] }]);
  assert.equal(scheduleCalls, 0, 'the plugin must not react to its own DOM writes');
});

test('starObserver callback: a record targeting a native explorer element still schedules a pass -- real external churn is never dropped', () => {
  const { plugin, rootChildrenEl } = makeObserverFixture();
  let scheduleCalls = 0;
  plugin.scheduleStarReapply = () => {
    scheduleCalls++;
  };
  plugin.starObserver.deliver([{ target: rootChildrenEl, addedNodes: [], removedNodes: [] }]);
  assert.equal(scheduleCalls, 1);
});

test('starObserver callback: while disconnected (inside a real reapply pass\'s own disconnect/reconnect window), delivery is a no-op -- matches real MutationObserver.disconnect() semantics', () => {
  const { plugin, rootChildrenEl } = makeObserverFixture();
  let scheduleCalls = 0;
  plugin.scheduleStarReapply = () => {
    scheduleCalls++;
  };
  plugin.starObserver.disconnect();
  plugin.starObserver.deliver([{ target: rootChildrenEl, addedNodes: [], removedNodes: [] }]);
  assert.equal(scheduleCalls, 0, 'a disconnected observer never delivers');
});
