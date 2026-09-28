/* Ambiguous =
 * start EMPTY with a first-directory guide; an ICOR vault
 * seeds just the five My Life folders that actually exist (Topics, Projects, Key Elements,
 * Habits, Goals -- never any other folder). Built to four platform
 * conditions exactly:
 *
 *  1. Signal: `.icor-for-life/manifest.json`, read via
 *     `app.vault.adapter.exists`/`read` with `normalizePath` (dot-folders
 *     aren't in the vault index) -- ICOR only if it parses AND
 *     `name === "ICOR for Life Scaffold"` AND `implements` starts with
 *     `"icor-concepts/"`. Never a root manifest.json, folder names, a
 *     theme, or a plugin list. Any failure = empty + guide.
 *  2. Seeding runs inside `workspace.onLayoutReady`, only for the five
 *     `04 Inner World/My Life/{Topics,Projects,Key Elements,Habits,
 *     Goals}` folders where `vault.getFolderByPath` is non-null. Zero
 *     confirmed = empty + guide.
 *  3. First start = `loadData()` returns null. Detected defaults stay IN
 *     MEMORY; never `saveData` on first start until a user action;
 *     before that first save, re-check whether data.json has appeared
 *     externally and reload instead of writing if it has.
 *  4. `onExternalSettingsChange()`: reload; if data arrives, drop the
 *     in-memory defaults, close the guide, refresh shelves.
 *
 * Tests below cover all four conditions plus the four-case detection
 * matrix (ICOR+seeded, ICOR+zero-confirmed, non-ICOR, and the
 * never-re-detect-on-a-real-load case).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugin, makeFile, makeFolder, makeApp, makeFakeElement } from './harness.mjs';

const { __test, PluginClass } = loadPlugin();
const {
  detectIcorScaffold,
  computeIcorSeededRoots,
  defaultSettings,
  migrateSettings,
  DEFAULT_ROOT_PATH,
  AREA_FOLDER_NAMES,
} = __test;

const ICOR_MANIFEST_JSON = JSON.stringify({
  schema: 2,
  name: 'ICOR for Life Scaffold',
  version: '2.0.1',
  implements: 'icor-concepts/1',
});

function makeIcorApp({ areaFolders = AREA_FOLDER_NAMES, manifestOverride, adapterFilesOverride, leaves = [], layoutReady = true } = {}) {
  const folders = areaFolders.map((name) => makeFolder(`${DEFAULT_ROOT_PATH}/${name}`, []));
  const adapterFiles =
    adapterFilesOverride !== undefined
      ? adapterFilesOverride
      : { '.icor-for-life/manifest.json': manifestOverride !== undefined ? manifestOverride : ICOR_MANIFEST_JSON };
  return makeApp({ folders, adapterFiles, leaves, layoutReady });
}

/* ======================================================================
 * Condition 1: detectIcorScaffold
 * ==================================================================== */

test('detectIcorScaffold: a real ICOR manifest (schema 2, name + implements matching) -> true', async () => {
  const app = makeIcorApp();
  assert.equal(await detectIcorScaffold(app), true);
});

test('detectIcorScaffold: the manifest simply does not exist -> false, no throw', async () => {
  const app = makeApp({ adapterFiles: {} });
  assert.equal(await detectIcorScaffold(app), false);
});

test('detectIcorScaffold: the manifest exists but is not valid JSON -> false, no throw', async () => {
  const app = makeIcorApp({ manifestOverride: '{ this is not json' });
  assert.equal(await detectIcorScaffold(app), false);
});

test('detectIcorScaffold: valid JSON, but the wrong `name` -> false', async () => {
  const app = makeIcorApp({ manifestOverride: JSON.stringify({ name: 'Some Other Scaffold', implements: 'icor-concepts/1' }) });
  assert.equal(await detectIcorScaffold(app), false);
});

test('detectIcorScaffold: right `name`, but `implements` does not start with "icor-concepts/" -> false', async () => {
  const app = makeIcorApp({ manifestOverride: JSON.stringify({ name: 'ICOR for Life Scaffold', implements: 'something-else/1' }) });
  assert.equal(await detectIcorScaffold(app), false);
});

test('detectIcorScaffold: right `name`, `implements` missing entirely -> false', async () => {
  const app = makeIcorApp({ manifestOverride: JSON.stringify({ name: 'ICOR for Life Scaffold' }) });
  assert.equal(await detectIcorScaffold(app), false);
});

test('detectIcorScaffold: `implements` present but not a string -> false, never throws on .startsWith', async () => {
  const app = makeIcorApp({ manifestOverride: JSON.stringify({ name: 'ICOR for Life Scaffold', implements: 42 }) });
  assert.equal(await detectIcorScaffold(app), false);
});

test('detectIcorScaffold: a ROOT-level manifest.json is never consulted -- only the dot-folder one counts, even when it names the right thing', async () => {
  const app = makeApp({ adapterFiles: { 'manifest.json': ICOR_MANIFEST_JSON } }); // no `.icor-for-life/manifest.json` at all
  assert.equal(await detectIcorScaffold(app), false);
});

test('detectIcorScaffold: adapter.exists/read throwing (a real filesystem error) -> false, never propagates', async () => {
  const app = makeApp({});
  app.vault.adapter.exists = async () => {
    throw new Error('simulated filesystem error');
  };
  await assert.doesNotReject(async () => {
    assert.equal(await detectIcorScaffold(app), false);
  });
});

test('detectIcorScaffold: no app.vault.adapter at all (a stripped-down fixture) -> false, no throw', async () => {
  assert.equal(await detectIcorScaffold({ vault: {} }), false);
  assert.equal(await detectIcorScaffold({}), false);
});

/* ======================================================================
 * Condition 2: computeIcorSeededRoots
 * ==================================================================== */

test('computeIcorSeededRoots: all five My Life areas exist -> five enabled roots, spotlightFolders off, no other root anywhere', () => {
  const app = makeIcorApp();
  const seeded = computeIcorSeededRoots(app);
  assert.deepEqual(
    seeded.map((r) => r.path).sort(),
    AREA_FOLDER_NAMES.map((name) => `${DEFAULT_ROOT_PATH}/${name}`).sort(),
  );
  assert.ok(seeded.every((r) => r.enabled === true && r.spotlightFolders === false));
  assert.ok(seeded.every((r) => !r.path.includes('Workspace')), 'no unrelated root, ever, from this seeding path');
});

test('computeIcorSeededRoots: only SOME of the five areas exist here -> only those are seeded', () => {
  const app = makeIcorApp({ areaFolders: ['Goals', 'Topics'] });
  const seeded = computeIcorSeededRoots(app);
  assert.deepEqual(
    seeded.map((r) => r.path).sort(),
    [`${DEFAULT_ROOT_PATH}/Goals`, `${DEFAULT_ROOT_PATH}/Topics`].sort(),
  );
});

test('computeIcorSeededRoots: none of the five areas exist -> []', () => {
  const app = makeIcorApp({ areaFolders: [] });
  assert.deepEqual(computeIcorSeededRoots(app), []);
});

/* ======================================================================
 * The four-case detection matrix
 * ==================================================================== */

test('four-case matrix, case 1: ICOR vault + all five areas confirmed -> seeds all five', async () => {
  const app = makeIcorApp();
  assert.equal(await detectIcorScaffold(app), true);
  assert.equal(computeIcorSeededRoots(app).length, 5);
});

test('four-case matrix, case 2: ICOR vault + ZERO area folders confirmed -> stays empty (the guide shows)', async () => {
  const app = makeIcorApp({ areaFolders: [] });
  assert.equal(await detectIcorScaffold(app), true, 'the scaffold itself is genuinely ICOR');
  assert.deepEqual(computeIcorSeededRoots(app), [], 'but none of the five areas exist here yet -- nothing to seed');
});

test('four-case matrix, case 3: a non-ICOR vault with similarly-named folders elsewhere ("My Life" folders under a different root entirely, no .icor-for-life at all) -> never detected, never seeded, folder names are never the signal', async () => {
  const app = makeApp({
    folders: [makeFolder('Other Vault/My Life/Goals', []), makeFolder('Other Vault/My Life/Topics', [])],
    adapterFiles: {}, // no .icor-for-life/manifest.json anywhere
  });
  assert.equal(await detectIcorScaffold(app), false);
  // Even if detection were (wrongly) skipped, the seeding function itself
  // only ever looks under DEFAULT_ROOT_PATH ('04 Inner World/My Life'),
  // never this other path -- confirms the folder-name coincidence alone can
  // never seed anything either.
  assert.deepEqual(computeIcorSeededRoots(app), []);
});

/* ======================================================================
 * Condition 3: first-start persistence discipline, exercised through
 * SpotlightPlugin.onload() end to end.
 * ==================================================================== */

function makeFirstStartFixture({ areaFolders = AREA_FOLDER_NAMES, manifestOverride, adapterFilesOverride, dir = '.obsidian/plugins/spotlight', layoutReady = true } = {}) {
  const app = makeIcorApp({ areaFolders, manifestOverride, adapterFilesOverride, leaves: [], layoutReady });
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate', dir });
  plugin.saved = null; // loadData() -> null -- the exact, only definition of "first start"
  return { app, plugin };
}

test('SpotlightPlugin.onload (0.14.0, condition 3): a genuine first start in an ICOR vault seeds the five areas IN MEMORY, but never calls saveData at all', async () => {
  const { plugin } = makeFirstStartFixture();
  await plugin.onload();
  await plugin.explorerReady;

  assert.deepEqual(
    plugin.settings.roots.map((r) => r.path).sort(),
    AREA_FOLDER_NAMES.map((name) => `${DEFAULT_ROOT_PATH}/${name}`).sort(),
    'seeded in memory',
  );
  assert.equal(plugin.saved, null, 'never written -- no user action happened yet');
  assert.equal(plugin._firstStartPending, true, 'still pending -- nothing has saved yet');
});

test('SpotlightPlugin.onload (0.14.0, condition 2): seeding genuinely runs INSIDE workspace.onLayoutReady, not onload()\'s own synchronous body -- roots stay empty until layout actually fires ready', async () => {
  // `layoutReady: false` -- the same cold-boot-race fixture shape this
  // harness already supports (test/spotlight-explorer.test.mjs, "onload
  // (F6): does not acquire the file-explorer view before layout is
  // ready"); a test fires it manually via `app.workspace._fireLayoutReady()`.
  const { app, plugin } = makeFirstStartFixture({ layoutReady: false });

  await plugin.onload();
  assert.deepEqual(plugin.settings.roots, [], 'onload() itself never seeds -- layout has not fired ready yet');
  assert.equal(plugin._firstStartPending, true);

  app.workspace._fireLayoutReady();
  await plugin.explorerReady;
  assert.deepEqual(
    plugin.settings.roots.map((r) => r.path).sort(),
    AREA_FOLDER_NAMES.map((name) => `${DEFAULT_ROOT_PATH}/${name}`).sort(),
    'seeded only once layout genuinely became ready',
  );
});

test('SpotlightPlugin.onload (0.14.0, condition 3): a genuine first start in a NON-ICOR vault stays empty, never calls saveData', async () => {
  const app = makeApp({ leaves: [] }); // no .icor-for-life/manifest.json, no My Life folders
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate', dir: '.obsidian/plugins/spotlight' });
  plugin.saved = null;

  await plugin.onload();
  await plugin.explorerReady;

  assert.deepEqual(plugin.settings.roots, []);
  assert.equal(plugin.saved, null);
  assert.equal(plugin._firstStartPending, true);
});

test('SpotlightPlugin.onload (0.14.0, condition 3): ICOR vault but zero confirmed area folders -- stays empty in memory too, never calls saveData', async () => {
  const { plugin } = makeFirstStartFixture({ areaFolders: [] });
  await plugin.onload();
  await plugin.explorerReady;

  assert.deepEqual(plugin.settings.roots, []);
  assert.equal(plugin.saved, null);
});

test('SpotlightPlugin.onload (0.14.0, condition 3): NOT a first start (loadData returns a real, even genuinely empty, shape) -- ICOR detection never runs at all, even in a real ICOR vault', async () => {
  const { app } = makeFirstStartFixture(); // a genuine ICOR vault, all five areas present
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate', dir: '.obsidian/plugins/spotlight' });
  // A real, previously-saved shape -- deliberately empty roots, exactly
  // the shape a member who explicitly removed every root would have.
  plugin.saved = { roots: [], collapsedShelfRoots: [], starredPaths: [], collapsedBranchRoots: [], guideDismissed: true };

  await plugin.onload();
  await plugin.explorerReady;

  assert.deepEqual(plugin.settings.roots, [], 'stays exactly what was saved -- existing data.json always wins, detection never touches it');
  assert.equal(plugin._firstStartPending, false, 'this was never a first start to begin with');
});

test('saveSettings (0.14.0, condition 3): the first real save after a first start actually writes, and clears the pending flag', async () => {
  const { plugin } = makeFirstStartFixture({ areaFolders: [] }); // stays empty
  await plugin.onload();
  await plugin.explorerReady;
  assert.equal(plugin.saved, null);

  const result = await plugin.addRoot('Some Folder');
  assert.equal(result.ok, true);
  assert.ok(plugin.saved, 'the first user action actually persisted');
  assert.equal(plugin._firstStartPending, false);
  assert.deepEqual(plugin.saved.roots.map((r) => r.path), ['Some Folder']);
});

test('saveSettings (0.14.0, condition 3): if data.json appears externally between load and this session\'s own first save, the write is abandoned and the session reloads from disk instead of clobbering it', async () => {
  const { plugin } = makeFirstStartFixture(); // ICOR, would seed 5 roots in memory
  await plugin.onload();
  await plugin.explorerReady;
  assert.deepEqual(plugin.settings.roots.map((r) => r.path).sort(), AREA_FOLDER_NAMES.map((n) => `${DEFAULT_ROOT_PATH}/${n}`).sort());

  // Simulate a sync/another device writing data.json to disk in between --
  // the adapter now reports it exists, but this session's own `loadData()`
  // (a separate, in-memory `plugin.saved`) is what actually gets re-read.
  const dataPath = '.obsidian/plugins/spotlight/data.json';
  plugin.app.vault.adapter.exists = async (p) => p === dataPath;
  const realData = { roots: [{ path: 'Externally Added', enabled: true, spotlightFolders: false }], collapsedShelfRoots: [], starredPaths: [], collapsedBranchRoots: [], guideDismissed: true };
  plugin.saved = null; // stays null through this whole test -- the write is abandoned, never a real saveData() call
  plugin.loadData = async () => realData; // stand in for the external write landing

  const result = await plugin.addRoot('A Local Add'); // this session's own attempted first save

  // The local add is NOT what ended up "saved" -- the external data won,
  // and settings now reflect exactly what was externally written.
  assert.deepEqual(plugin.settings.roots.map((r) => r.path), ['Externally Added']);
  assert.equal(plugin._firstStartPending, false, 'reloading also clears the pending flag -- real data answered the question');
  // The literal spec ("reload instead of writing") means this session's
  // own data.json write is genuinely abandoned, not merely reordered --
  // `addRoot`'s in-memory push (now overwritten by the reload) never
  // reached disk at all. `result.ok` is still true (the collision check
  // itself passed); the member's local add is simply lost this attempt.
  assert.equal(plugin.saved, null, 'the local add was never actually written to disk -- reload wins outright, not a merge');
  assert.equal(result.ok, true, 'addRoot itself still reports success -- it has no way to know its own write got pre-empted by a reload');
});

/* ======================================================================
 * 0.15.1:
 * `runFirstStartIcorDetection` re-checks `_firstStartPending`/`_unloaded`
 * right before its own `this.settings.roots = seeded` write, not only at
 * the top of the method -- the one real `await` inside it
 * (`detectIcorScaffold`'s own adapter read) is exactly the window in
 * which real settings could land (a reload) or the plugin could unload.
 * ==================================================================== */

test('runFirstStartIcorDetection (0.15.1, condition 4): real settings landing mid-detection (a reload) are never clobbered once detection resolves', async () => {
  const { app, plugin } = makeFirstStartFixture(); // a genuine ICOR vault, all five areas present
  // Called directly (not through onload()), so this method's own
  // preconditions -- what onload()'s ternary already checked, and
  // `this.settings` itself, normally set synchronously earlier in
  // onload() -- are set up by hand here, matching a genuine first-start
  // shape (roots: []).
  plugin.settings = defaultSettings();
  plugin._firstStartPending = true;
  let resolveRead;
  const readDeferred = new Promise((resolve) => {
    resolveRead = resolve;
  });
  app.vault.adapter.read = () => readDeferred;

  const detectionPromise = plugin.runFirstStartIcorDetection();
  // Let `detectIcorScaffold`'s own `await adapter.exists(...)` resolve
  // and reach the now-blocked `adapter.read(...)` call.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  // Real settings land (a synced data.json, `reloadSettingsFromDisk()`)
  // WHILE detection's own read is still in flight.
  const externalRoots = [{ path: 'Externally Added', enabled: true, spotlightFolders: false }];
  plugin.settings = { roots: externalRoots.slice(), collapsedShelfRoots: [], starredPaths: [], collapsedBranchRoots: [], guideDismissed: false };
  plugin._firstStartPending = false;

  resolveRead(ICOR_MANIFEST_JSON); // detection now resolves true, would seed the 5 areas
  await detectionPromise;

  assert.deepEqual(plugin.settings.roots, externalRoots, 'the externally-landed roots survive untouched -- seeding never overwrote them');
});

test('runFirstStartIcorDetection (0.15.1, condition 4): the plugin unloading mid-detection is never clobbered by a late seed write', async () => {
  const { app, plugin } = makeFirstStartFixture();
  plugin.settings = defaultSettings();
  plugin._firstStartPending = true;
  let resolveRead;
  const readDeferred = new Promise((resolve) => {
    resolveRead = resolve;
  });
  app.vault.adapter.read = () => readDeferred;

  const detectionPromise = plugin.runFirstStartIcorDetection();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  plugin._unloaded = true; // simulates the plugin being disabled mid-detection
  resolveRead(ICOR_MANIFEST_JSON);
  await detectionPromise;

  assert.deepEqual(plugin.settings.roots, [], 'never seeded past unload');
});

/* ======================================================================
 * Condition 4: onExternalSettingsChange()
 * ==================================================================== */

test('onExternalSettingsChange (0.14.0, condition 4): reloads from disk, drops in-memory first-start defaults, refreshes shelves', async () => {
  const { plugin } = makeFirstStartFixture(); // first start, would seed 5 roots in memory
  await plugin.onload();
  await plugin.explorerReady;
  assert.equal(plugin._firstStartPending, true);

  const externalData = { roots: [{ path: 'Real Root', enabled: true, spotlightFolders: false }], collapsedShelfRoots: [], starredPaths: [], collapsedBranchRoots: [], guideDismissed: false };
  plugin.loadData = async () => externalData;

  let reapplyCalls = 0;
  const realRunReapply = plugin.runReapply.bind(plugin);
  plugin.runReapply = () => {
    reapplyCalls += 1;
    realRunReapply();
  };

  await plugin.onExternalSettingsChange();

  assert.deepEqual(plugin.settings.roots.map((r) => r.path), ['Real Root'], 'the in-memory ICOR-seeded defaults are gone -- real data won');
  assert.equal(plugin._firstStartPending, false);
  assert.ok(reapplyCalls >= 1, 'shelves refreshed');
});

test('onExternalSettingsChange (0.14.0, condition 4): re-renders an open settings tab too, so the guide actually closes on screen', async () => {
  const { plugin } = makeFirstStartFixture({ areaFolders: [] }); // stays empty -- guide showing
  await plugin.onload();
  await plugin.explorerReady;
  assert.deepEqual(plugin.settings.roots, []);

  let displayCalls = 0;
  plugin.settingTab.display = () => {
    displayCalls += 1;
  };

  const externalData = { roots: [{ path: 'Now Real', enabled: true, spotlightFolders: false }], collapsedShelfRoots: [], starredPaths: [], collapsedBranchRoots: [], guideDismissed: false };
  plugin.loadData = async () => externalData;

  await plugin.onExternalSettingsChange();

  assert.equal(displayCalls, 1);
});

test('onExternalSettingsChange: never rebuilds an already-closed settings tab', async () => {
  const { plugin } = makeFirstStartFixture({ areaFolders: [] }); // stays empty -- guide showing
  await plugin.onload();
  await plugin.explorerReady;

  let displayCalls = 0;
  plugin.settingTab.display = () => {
    displayCalls += 1;
  };
  // The member closed the pane -- a real DOM node's `containerEl` goes
  // disconnected the moment it leaves the document; `plugin.settingTab`
  // itself is untouched (Obsidian doesn't null it out on close).
  plugin.settingTab.containerEl.isConnected = false;

  const externalData = { roots: [{ path: 'Now Real', enabled: true, spotlightFolders: false }], collapsedShelfRoots: [], starredPaths: [], collapsedBranchRoots: [], guideDismissed: false };
  plugin.loadData = async () => externalData;

  await plugin.onExternalSettingsChange();

  // Real settings still land -- only the (pointless) rebuild is skipped.
  assert.deepEqual(plugin.settings.roots.map((r) => r.path), ['Now Real']);
  assert.equal(displayCalls, 0, 'a closed tab is never rebuilt');
});

test('onExternalSettingsChange (0.14.0, condition 4): an old (migrated) shape arriving externally is forward-migrated and persisted, same as onload()\'s own handling', async () => {
  const { plugin } = makeFirstStartFixture({ areaFolders: [] });
  await plugin.onload();
  await plugin.explorerReady;

  // A 0.3.x lane-shaped external write (an old device, or a very stale
  // sync conflict resolution).
  plugin.loadData = async () => ({
    roots: [{ path: DEFAULT_ROOT_PATH, lanes: [{ folderName: 'Goals', enabled: true }] }],
  });

  await plugin.onExternalSettingsChange();

  assert.deepEqual(plugin.settings.roots.map((r) => r.path), [`${DEFAULT_ROOT_PATH}/Goals`]);
  assert.ok(plugin.saved, 'forward-migrated shape was persisted, mirroring onload()\'s own "if migrated, save" rule');
});

/* ======================================================================
 * The empty-state guide's own settings-tab surface (minimal, functional
 * -- the real visual design is 0.15.0's own job).
 * ==================================================================== */

test('settings tab (0.14.0 empty-guide plumbing, REVISED 0.15.0 -- the mockup\'s own guide replaces the minimal 0.14.0 one): the guide renders when roots is empty, purely from the count -- guideDismissed no longer suppresses it', async () => {
  const { plugin } = makeFirstStartFixture({ areaFolders: [] });
  await plugin.onload();
  await plugin.explorerReady;
  plugin.settingTab.display();

  const guideEls = plugin.settingTab.containerEl._findAll('spotlight-dir-empty');
  assert.equal(guideEls.length, 1, 'the guide shows -- roots.length === 0');

  // 0.15.0: the redesigned guide keeps
  // only "Go to the Add field," no Dismiss button -- the guide's own
  // visibility no longer consults `guideDismissed` at all, a real,
  // named behaviour change, not a bug. `dismissGuide()`
  // itself is gone too now -- nothing calls it any more (no button wires
  // to it, this test was its last caller) -- but the FIELD it used to
  // write, `guideDismissed`, still round-trips through
  // `defaultSettings()`/`migrateSettings()` unchanged, for compatibility
  // with a data.json an older build already wrote one into. Written
  // directly here (what a member's OWN prior dismissal, or an older
  // build, would have left on disk) rather than through the retired
  // method.
  plugin.settings.guideDismissed = true;
  await plugin.saveSettings();
  plugin.settingTab.display();

  const guideElsAfter = plugin.settingTab.containerEl._findAll('spotlight-dir-empty');
  assert.equal(guideElsAfter.length, 1, 'still shows -- guideDismissed has no rendering effect any more');
  assert.equal(plugin.saved.guideDismissed, true, 'the field itself still persists, even though nothing reads it for display any more');
});

test('SpotlightPlugin: dismissGuide() is gone -- nothing calls it any more since 0.15.0 dropped the Dismiss button, and it was dead weight', async () => {
  const { plugin } = makeFirstStartFixture({ areaFolders: [] });
  await plugin.onload();
  await plugin.explorerReady;
  assert.equal(typeof plugin.dismissGuide, 'undefined');
});

test('settings tab (0.15.0): the guide never renders once real roots exist', async () => {
  const { plugin } = makeFirstStartFixture(); // seeds 5 roots
  await plugin.onload();
  await plugin.explorerReady;
  plugin.settingTab.display();

  assert.equal(plugin.settingTab.containerEl._findAll('spotlight-dir-empty').length, 0);
});

/* ======================================================================
 * defaultSettings()/migrateSettings() shape sanity (guideDismissed
 * threads through every branch, non-forcing on read).
 * ==================================================================== */

test('migrateSettings (0.14.0): a shape saved before guideDismissed existed reads as false, never forces a re-save on its own', () => {
  const loaded = { roots: [{ path: 'X', enabled: true }], collapsedShelfRoots: [], starredPaths: [], collapsedBranchRoots: [] };
  const { settings, migrated } = migrateSettings(loaded);
  assert.equal(settings.guideDismissed, false);
  assert.equal(migrated, false);
});

test('migrateSettings (0.14.0): guideDismissed: true survives a settings round-trip', () => {
  const loaded = { roots: [], collapsedShelfRoots: [], starredPaths: [], collapsedBranchRoots: [], guideDismissed: true };
  assert.equal(migrateSettings(loaded).settings.guideDismissed, true);
});
