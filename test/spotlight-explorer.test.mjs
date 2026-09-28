/* Gates for the file-explorer surface: the inline star (notes only,
 * rule 3), the shelf (Stage A), and the settings tab's plain root list.
 * The universal overview-lift sort patch and the Overview chip/tint are
 * RETIRED 0.5.0 — this file's own "no lift,
 * no marker" gate (below, in the inline-star section) proves the removal
 * rather than gating a mechanism that no longer exists.
 *
 * Scope, stated plainly: these gates prove the SOURCE is correct against
 * the intended behavior. They do not, and cannot, prove the mechanism
 * renders correctly inside a real Obsidian window — that needs a live
 * verification pass. Source-ready, not live-correct.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadPlugin,
  makeFile,
  makeFolder,
  makeApp,
  makeFileExplorerLeaf,
  makeFakeElement,
  makeFakeEvent,
  makeFileItemsSortedFolderItems,
  makeMenu,
  makeInfinityScrollFixture,
} from './harness.mjs';

const { __test, document } = loadPlugin();
const {
  getFileExplorerView,
  setSpotlightState,
  toggleEntitySpotlight,
  getSpotlightState,
  ensureStarOnRow,
  removeStarFromRow,
  reapplyStars,
  handleStarActivate,
  resolveRowClassification,
  renderShelfForRoot,
  removeShelfForRoot,
  sweepOrphanShelves,
  renderAllShelves,
  revealEntityCandidate,
  unstarShelfEntity,
  handleShelfStarActivate,
  SpotlightSettingTab,
  resolveSpotlightTarget,
  addSpotlightMenuItem,
  isFolderStarred,
  setFolderStarred,
  candidatePath,
  computeStaleFolderStarredPaths,
  cleanupStaleFolderStars,
  computeStaleStarredPaths,
  cleanupStaleStarredPaths,
  positionRevealedRowOneThirdDown,
  isPathStarred,
  spotlightFileIconName,
  getCandidateStarState,
  applyBranchHiddenDomState,
  reapplyBranchHiddenState,
  syncBranchToggleEl,
  computeAutoRevealState,
  turnOffAutoReveal,
  guardScrollAcrossHiddenBranchReveal,
  reconcileStarOverride,
  pillTextForRootPath,
} = __test;

/* ======================================================================
 * The inline star -- notes only (rule 3), never a folder
 * ==================================================================== */

function makeCardboardExplorerFixture() {
  const stub = makeFile('04 Inner World/My Life/Projects/client/Cardboard Alchemy/Cardboard Alchemy.md', {
    content: '---\ntype: project\n---\n',
  });
  const carrier = makeFolder('04 Inner World/My Life/Projects/client/Cardboard Alchemy', [stub]);
  const bucket = makeFolder('04 Inner World/My Life/Projects/client', [carrier]);
  const root = makeFolder('04 Inner World/My Life/Projects', [bucket]);
  const files = { [stub.path]: stub._content };

  const stubTitleEl = makeFakeElement('div');
  const folderTitleEl = makeFakeElement('div');
  class FakeExplorerView {}
  FakeExplorerView.prototype.requestSort = function () {};
  FakeExplorerView.prototype.getSortedFolderItems = makeFileItemsSortedFolderItems();
  const view = new FakeExplorerView();
  view.fileItems = {
    [stub.path]: { file: stub, selfEl: stubTitleEl },
    [carrier.path]: { file: carrier, selfEl: folderTitleEl },
  };
  view.containerEl = makeFakeElement('div');
  const leaf = { view, loadIfDeferred: async () => {} };

  const app = makeApp({ folders: [root, bucket, carrier], files, leaves: [leaf] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.saved = { roots: [{ path: '04 Inner World/My Life/Projects', enabled: true }] };
  return { plugin, stub, stubTitleEl, carrier, folderTitleEl, app };
}

test('reapplyStars: the carrier note\'s row gets a star; the carrier FOLDER\'s own row never does (rule 3)', async () => {
  const { plugin, stubTitleEl, folderTitleEl } = makeCardboardExplorerFixture();
  await plugin.onload();
  await plugin.explorerReady;
  assert.ok(stubTitleEl.querySelector(':scope > .spotlight-star'));
  assert.equal(folderTitleEl.querySelector(':scope > .spotlight-star'), null);
});

test('ensureStarOnRow: the inline star is drawn via Obsidian\'s own setIcon(\'star\'), never a hand-rolled innerHTML write', async () => {
  const { plugin, stubTitleEl } = makeCardboardExplorerFixture();
  await plugin.onload();
  await plugin.explorerReady;
  const star = stubTitleEl.querySelector(':scope > .spotlight-star');
  assert.ok(star);
  assert.equal(star.getAttribute('data-icon'), 'star', 'setIcon(star, \'star\') actually ran');
});

test('reapplyStars: a SECOND pass with nothing changed never touches the DOM for a row already correctly painted', async () => {
  const { plugin, stubTitleEl } = makeCardboardExplorerFixture();
  await plugin.onload();
  await plugin.explorerReady;
  assert.ok(stubTitleEl.querySelector(':scope > .spotlight-star'), 'painted once, normally, on the first pass');

  // Spy on the ONE DOM read `ensureStarOnRow` always performs first
  // (`titleEl.querySelector(':scope > .spotlight-star')`, to find the
  // existing star) -- a call proves the row's own DOM was touched again;
  // its absence proves the skip fired.
  let queryCalls = 0;
  const realQuerySelector = stubTitleEl.querySelector.bind(stubTitleEl);
  stubTitleEl.querySelector = (sel) => {
    queryCalls += 1;
    return realQuerySelector(sel);
  };

  reapplyStars(plugin); // nothing changed since the first pass -- must skip

  assert.equal(queryCalls, 0, 'ensureStarOnRow never ran for this row -- the star-state cache skip fired');
});

test('reapplyStars: sweeps a star whose root was disabled since it last painted', async () => {
  const { plugin, stubTitleEl } = makeCardboardExplorerFixture();
  await plugin.onload();
  await plugin.explorerReady;
  assert.ok(stubTitleEl.querySelector(':scope > .spotlight-star'));
  await plugin.setRootEnabled('04 Inner World/My Life/Projects', false);
  reapplyStars(plugin);
  assert.equal(stubTitleEl.querySelector(':scope > .spotlight-star'), null);
});

test('handleStarActivate: refuses an untrusted (non-isTrusted) event -- no write', async () => {
  const { plugin, stub, stubTitleEl } = makeCardboardExplorerFixture();
  await plugin.onload();
  await plugin.explorerReady;
  stubTitleEl.setAttribute('data-path', stub.path);
  const star = stubTitleEl.querySelector(':scope > .spotlight-star');
  const evt = makeFakeEvent({ isTrusted: false });
  await handleStarActivate(plugin, stubTitleEl, star, evt);
  assert.equal(getSpotlightState(plugin.app, stub), false);
});

test('handleStarActivate: a trusted click toggles the note and repaints the star', async () => {
  const { plugin, stub, stubTitleEl } = makeCardboardExplorerFixture();
  await plugin.onload();
  await plugin.explorerReady;
  const star = stubTitleEl.querySelector(':scope > .spotlight-star');
  const evt = makeFakeEvent({ isTrusted: true });
  await handleStarActivate(plugin, stubTitleEl, star, evt);
  assert.equal(getSpotlightState(plugin.app, stub), true);
  assert.equal(star.classList.contains('is-on'), true);
});

/* ======================================================================
 * Optimistic paint (0.13.3, p7m, "Star
 * click -> orange star + shelf update must feel immediate"). The star
 * (and the shelf) must reflect a click's OWN new state synchronously,
 * before the frontmatter/data.json write it started even resolves, via
 * `plugin._optimisticStarOverrides` -- every reader of star state
 * (`getCandidateStarState`, and everything built on it) sees the click's
 * own intended value for that ONE path while the write is still in
 * flight, and a genuine write failure reverts it.
 * ==================================================================== */

test('handleStarActivate (0.13.3, optimistic paint): the star is already painted before the write settles', async () => {
  const { plugin, stub, stubTitleEl } = makeCardboardExplorerFixture();
  await plugin.onload();
  await plugin.explorerReady;
  const star = stubTitleEl.querySelector(':scope > .spotlight-star');
  const evt = makeFakeEvent({ isTrusted: true });

  // Hold the write open so the optimistic (pre-resolution) state can be
  // observed -- the real `vault.process` still runs, just later.
  const realProcess = plugin.app.vault.process;
  let releaseWrite;
  plugin.app.vault.process = (file, fn) =>
    new Promise((resolve) => {
      releaseWrite = () => resolve(realProcess(file, fn));
    });

  const pending = handleStarActivate(plugin, stubTitleEl, star, evt);
  await Promise.resolve(); // let the synchronous portion (before the first real await) run
  await Promise.resolve(); // and the microtask the optimistic reapply itself may have queued

  assert.equal(star.classList.contains('is-on'), true, 'painted instantly -- the write has not resolved yet');
  assert.equal(getSpotlightState(plugin.app, stub), false, 'and genuinely NOT written yet -- this really is optimistic, not just fast');

  releaseWrite();
  await pending;
  assert.equal(star.classList.contains('is-on'), true);
  assert.equal(getSpotlightState(plugin.app, stub), true, 'now genuinely written too');
});

test('handleStarActivate (0.13.3, optimistic paint): reverts the star if the write ultimately fails', async () => {
  const { plugin, stub, stubTitleEl } = makeCardboardExplorerFixture();
  await plugin.onload();
  await plugin.explorerReady;
  const star = stubTitleEl.querySelector(':scope > .spotlight-star');
  const evt = makeFakeEvent({ isTrusted: true });
  plugin.app.vault.process = async () => {
    throw new Error('disk full');
  };

  await handleStarActivate(plugin, stubTitleEl, star, evt);

  assert.equal(star.classList.contains('is-on'), false, 'reverted back to unstarred -- the write never actually landed');
  assert.equal(getSpotlightState(plugin.app, stub), false);
  assert.equal(plugin._optimisticStarOverrides.has(stub.path), false, 'the override is cleared either way, success or failure');
});

/* ======================================================================
 * 0.13.4: "responsive, but there is now
 * an intermittent flicker when some items are added to the shelf ...
 * doesn't happen on every addition ... but if you click several in rapid
 * succession it almost always starts to happen." Root-caused live with
 * this exact deferred-write mock (not guessed): `vault.process()`'s own
 * promise resolving is NOT the same moment `app.metadataCache` actually
 * re-parses the file -- a real, separate, asynchronous step this file's
 * own `registerRowInjectionEvents` doc comment already named ("the
 * requestSort()-before-reparse race after our own writes") for sort
 * order, but which 0.13.3's optimistic-override lifecycle didn't yet
 * account for. `makeDeferredProcess` splits the two apart: `settle()`
 * resolves the write's own promise (what `await` unblocks on), entirely
 * independently of `applyToCache()` (what a real metadataCache re-parse
 * would eventually do) -- a real Obsidian write can have the first
 * happen well before the second.
 * ==================================================================== */

/** @returns {Array<{file, next, settle: () => void, applyToCache: () => void}>} */
function makeDeferredProcess(plugin) {
  const writes = [];
  plugin.app.vault.process = (file, fn) => {
    const current = file._content !== undefined ? file._content : plugin.app.vault._files[file.path];
    const next = fn(current);
    let resolvePromise;
    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    writes.push({
      file,
      next,
      settle: () => resolvePromise(next),
      applyToCache: () => {
        file._content = next;
        plugin.app.vault._files[file.path] = next;
      },
    });
    return promise;
  };
  return writes;
}

test('handleStarActivate (0.13.4, override race): a write settling must never flip a path back to a stale value while a NEWER click on that same path is still in flight', async () => {
  const { plugin, stub, stubTitleEl } = makeCardboardExplorerFixture();
  await plugin.onload();
  await plugin.explorerReady;
  const star = stubTitleEl.querySelector(':scope > .spotlight-star');
  const evt = makeFakeEvent({ isTrusted: true });
  const writes = makeDeferredProcess(plugin);

  // Click 1: unstarred -> starred (write1).
  const pending1 = handleStarActivate(plugin, stubTitleEl, star, evt);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(star.classList.contains('is-on'), true, 'click 1 paints starred optimistically');

  // Click 2, same row, BEFORE write1 settles: starred -> unstarred (write2)
  // -- the latest, current intent.
  const pending2 = handleStarActivate(plugin, stubTitleEl, star, evt);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(star.classList.contains('is-on'), false, 'click 2 paints unstarred optimistically, overriding click 1');

  assert.equal(writes.length, 2);
  const [write1, write2] = writes;

  // write1 (the OLDER, now-superseded click) settles FIRST -- its own
  // promise resolves, but nothing has told the metadata cache about it
  // yet (no applyToCache(), no 'changed' emitted).
  write1.settle();
  await pending1;
  assert.equal(star.classList.contains('is-on'), false, 'write1 settling alone must not touch the row -- click 2 still owns it');

  // NOW simulate write1's own belated cache catch-up landing -- this is
  // exactly the moment a real Obsidian re-parse could arrive.
  write1.applyToCache();
  plugin.app.metadataCache._emit('changed', stub);
  await new Promise((resolve) => setTimeout(resolve, 0)); // let the coalesced reapply this schedules actually run

  assert.equal(
    star.classList.contains('is-on'),
    false,
    'write1\'s own belated cache confirmation must never resurrect its stale (superseded) value -- a write2 is still in flight for this path',
  );
  assert.equal(getCandidateStarState(plugin, resolveRowClassification(plugin, stubTitleEl)), false);

  // Finally write2 (click 2's own write, the current intent) settles and
  // is confirmed for real.
  write2.settle();
  await pending2;
  write2.applyToCache();
  plugin.app.metadataCache._emit('changed', stub);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(star.classList.contains('is-on'), false);
  assert.equal(getSpotlightState(plugin.app, stub), false);
  assert.equal(plugin._optimisticStarOverrides.has(stub.path), false, 'settles cleanly, confirmed, once truly landed');
  assert.equal(plugin._starWritesInFlight.has(stub.path), false, 'no write left outstanding for this path');
});

/* ======================================================================
 * 0.13.6: `handleStarActivate`/
 * `handleShelfStarActivate` used to reconcile a settling write's own
 * override ONLY for a path-store (folder/file) candidate -- a
 * frontmatter-backed NOTE candidate reconciled exclusively through
 * `registerRowInjectionEvents`'s `metadataCache.on('changed', ...)`
 * listener. Two real gaps that left uncovered: (1) a write whose content
 * never actually changed on disk (this path was already at the target
 * value) never fires a 'changed' event at all -- the override then had
 * no path to clear through, ever. (2) a 'changed' that arrives WHILE a
 * write is still counted in flight for that path bails inside
 * `reconcileStarOverride`'s own in-flight guard, and nothing ever
 * retried it once the write settled. The `usesPathStore(...)` guard at
 * both call sites is gone -- `reconcileStarOverride` runs unconditionally
 * now, safe because it only ever clears an override once LIVE storage
 * already agrees with it (see its own doc comment).
 * ==================================================================== */

test('handleStarActivate (0.13.6, condition D): a frontmatter candidate reconciles its override AT SETTLE TIME when live storage already agrees -- no metadataCache "changed" event required at all', async () => {
  const { plugin, stub, stubTitleEl } = makeCardboardExplorerFixture();
  await plugin.onload();
  await plugin.explorerReady;
  const star = stubTitleEl.querySelector(':scope > .spotlight-star');
  const evt = makeFakeEvent({ isTrusted: true });
  const writes = makeDeferredProcess(plugin);

  const pending = handleStarActivate(plugin, stubTitleEl, star, evt);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(plugin._optimisticStarOverrides.has(stub.path), true, 'sanity: an override is in play while the write is in flight');

  const [write1] = writes;
  // Simulate an unchanged-content write: live storage already agrees
  // with the override's own value the instant the write settles -- no
  // metadataCache._emit('changed', ...) anywhere in this test.
  write1.applyToCache();
  write1.settle();
  await pending;

  assert.equal(
    plugin._optimisticStarOverrides.has(stub.path),
    false,
    '0.13.6: the settle-time call reconciles a frontmatter candidate too -- it no longer waits exclusively for a "changed" event',
  );
});

test('handleStarActivate (0.13.6, condition D): a "changed" event that arrives WHILE this write is still counted in-flight is retried once the write itself settles, not left stuck forever', async () => {
  const { plugin, stub, stubTitleEl } = makeCardboardExplorerFixture();
  await plugin.onload();
  await plugin.explorerReady;
  const star = stubTitleEl.querySelector(':scope > .spotlight-star');
  const evt = makeFakeEvent({ isTrusted: true });
  const writes = makeDeferredProcess(plugin);

  const pending = handleStarActivate(plugin, stubTitleEl, star, evt);
  await Promise.resolve();
  await Promise.resolve();
  const [write1] = writes;

  // The cache catches up and fires 'changed' WHILE this write is still
  // the one outstanding write for this path -- `reconcileStarOverride`'s
  // own in-flight guard bails, exactly as designed.
  write1.applyToCache();
  plugin.app.metadataCache._emit('changed', stub);
  assert.equal(plugin._optimisticStarOverrides.has(stub.path), true, 'sanity: the in-flight guard really did bail -- nothing reconciled yet');

  // The write itself settles right after.
  write1.settle();
  await pending;

  assert.equal(
    plugin._optimisticStarOverrides.has(stub.path),
    false,
    '0.13.6: the settle-time call retries reconciliation -- the "changed" the in-flight guard skipped is not lost forever',
  );
});

test('resolveRowClassification: reads data-path fresh, refuses a folder row (rule 3) even if data-path points at a carrier folder', async () => {
  const { plugin, carrier, folderTitleEl } = makeCardboardExplorerFixture();
  await plugin.onload();
  await plugin.explorerReady;
  folderTitleEl.setAttribute('data-path', carrier.path);
  assert.equal(resolveRowClassification(plugin, folderTitleEl), null);
});

/* ======================================================================
 * The Overview treatment is RETIRED: "Overview" is not an official ICOR
 * term, and once My Life flattened, a carrier folder's
 * own note is no longer distinguishable from any other line in the
 * branch. This gate proves the removal held -- a carrier note keeps its
 * star (kept, rule 3) but paints no chip/fill/edge, its own folder is
 * never sorted (no lift), and the functions that used to do either are
 * gone from the module entirely, not merely unused.
 * ==================================================================== */

test('Overview treatment removal (0.5.0): a carrier note gets its star but no Overview mark; its folder is never sorted; the retired functions are gone from __test', async () => {
  const stub = makeFile('04 Inner World/My Life/Projects/client/Cardboard Alchemy/Cardboard Alchemy.md', {
    content: '---\ntype: project\n---\n',
  });
  const sibling = makeFile('04 Inner World/My Life/Projects/client/Cardboard Alchemy/notes.md');
  // stub deliberately NOT first in the folder's own children -- if a lift
  // patch were still installed, native order would be disturbed and this
  // test would catch it.
  const carrier = makeFolder('04 Inner World/My Life/Projects/client/Cardboard Alchemy', [sibling, stub]);
  const bucket = makeFolder('04 Inner World/My Life/Projects/client', [carrier]);
  const root = makeFolder('04 Inner World/My Life/Projects', [bucket]);
  const files = { [stub.path]: stub._content };

  const stubTitleEl = makeFakeElement('div');
  const siblingTitleEl = makeFakeElement('div');
  class FakeExplorerView {}
  FakeExplorerView.prototype.requestSort = function () {};
  const nativeGetSortedFolderItems = makeFileItemsSortedFolderItems();
  FakeExplorerView.prototype.getSortedFolderItems = nativeGetSortedFolderItems;
  const view = new FakeExplorerView();
  view.fileItems = {
    [stub.path]: { file: stub, selfEl: stubTitleEl },
    [sibling.path]: { file: sibling, selfEl: siblingTitleEl },
  };
  view.containerEl = makeFakeElement('div');
  const leaf = { view, loadIfDeferred: async () => {} };
  const app = makeApp({ folders: [root, bucket, carrier], files, leaves: [leaf] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.saved = { roots: [{ path: '04 Inner World/My Life/Projects', enabled: true }] };

  await plugin.onload();
  await plugin.explorerReady;

  // The star still paints (kept, rule 3) ...
  assert.ok(stubTitleEl.querySelector(':scope > .spotlight-star'));
  // ... but no Overview marker of any kind, on the carrier note's own row.
  assert.equal(stubTitleEl.classList.contains('spotlight-overview-row'), false);
  assert.equal(stubTitleEl.querySelector(':scope > .spotlight-overview-fill'), null);
  assert.equal(stubTitleEl.querySelector(':scope > .spotlight-overview-edge'), null);
  assert.equal(stubTitleEl.querySelector(':scope > .spotlight-overview-chip'), null);

  // No lift: the prototype's own getSortedFolderItems is the exact same
  // function reference before and after onload -- never wrapped -- and
  // calling it directly returns native (unlifted) order.
  assert.equal(FakeExplorerView.prototype.getSortedFolderItems, nativeGetSortedFolderItems);
  assert.equal(plugin.uninstallSortPatch, undefined);
  const sorted = view.getSortedFolderItems(carrier);
  assert.deepEqual(sorted.map((i) => i.file), [sibling, stub]);

  // The functions themselves are gone from the module, not merely unused.
  for (const name of [
    'isOverviewNote',
    'ensureOverviewMarkOnRow',
    'removeOverviewMarkFromRow',
    'reapplyOverviewMarkers',
    'OVERVIEW_CHIP_TEXT',
    'liftOverviewToFront',
    'createGetSortedFolderItemsPatch',
    'around',
    'unwrapVaultItem',
    'getInstalledAppVersionLabel',
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(__test, name), false, `__test.${name} should no longer be exported`);
  }
});

/* ======================================================================
 * The shelf (Stage A)
 * ==================================================================== */

/** `rootEl` is the row's own outer wrapper (Obsidian's `.el`, F1's home
 * for the shelf); `rootChildrenEl` is a genuine CHILD of it, matching the
 * real DOM relationship `renderShelfForRoot`'s F1 guard checks
 * (`item.childrenEl.parentNode === item.el`) before it will `insertBefore`
 * rather than fall back to a plain `appendChild`. */
function makeShelfFixture() {
  const stub = makeFile('04 Inner World/My Life/Projects/client/Cardboard Alchemy/Cardboard Alchemy.md', {
    content: '---\ntype: project\nspotlight: true\n---\n',
  });
  const carrier = makeFolder('04 Inner World/My Life/Projects/client/Cardboard Alchemy', [stub]);
  const bucket = makeFolder('04 Inner World/My Life/Projects/client', [carrier]);
  const flatUnstarred = makeFile('04 Inner World/My Life/Projects/idea.md', { content: '---\ntype: project\n---\n' });
  const root = makeFolder('04 Inner World/My Life/Projects', [bucket, flatUnstarred]);
  const files = { [stub.path]: stub._content, [flatUnstarred.path]: flatUnstarred._content };

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

  const app = makeApp({ folders: [root, bucket, carrier], files });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [{ path: '04 Inner World/My Life/Projects', enabled: true }], collapsedShelfRoots: [] };
  plugin.explorerView = view;
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => renderAllShelves(plugin);
  return { plugin, view, rootEl, rootChildrenEl, containerEl, stub, flatUnstarred, carrier };
}

test('renderShelfForRoot: one row for the starred carrier entity, named after its folder; the unstarred flat note is not on it', () => {
  const { plugin, rootEl } = makeShelfFixture();
  const entry = plugin.settings.roots[0];
  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  assert.ok(shelf, 'shelf should render when something is starred');
  // the shelf header reads SPOTLIGHT, not
  // FOCUS (an earlier design reference used that word, and it was already
  // struck once before for the v1 ring label). A regex, not
  // an exact-count string, so this stays true regardless of fixture
  // starred-count churn -- it is the header WORD this guards, not a number.
  const header = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-header'));
  const label = Array.from(header.children).find((c) => c.classList.contains('spotlight-shelf-header-label'));
  assert.match(label.textContent, /^SPOTLIGHT \(\d+\)$/);
  const rows = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  assert.equal(rows.children.length, 1);
  const title = Array.from(rows.children[0].children).find((c) => c.classList.contains('spotlight-shelf-title'));
  assert.equal(title.textContent, 'Cardboard Alchemy');
});

test('reloadSettingsFromDisk: clears _shelfSignatures, discarding whatever the cache held from before the reload', async () => {
  const { plugin } = makeShelfFixture();
  const entry = plugin.settings.roots[0];
  renderAllShelves(plugin); // populates _shelfSignatures the same way any real reapply pass does
  assert.ok(plugin._shelfSignatures && plugin._shelfSignatures.get(entry.path), 'sanity: a real signature is cached for this root before reload');

  // Isolates the clear itself from the repopulation a real reapply pass
  // (runReapply -> renderAllShelves) would immediately do right after --
  // `reloadSettingsFromDisk()` calls both in the same breath, and without
  // stubbing this out the map would already show entries again by the
  // time this test could look, masking whether the clear itself actually
  // ran.
  plugin.runReapply = () => {};
  plugin.loadData = async () => ({
    roots: plugin.settings.roots,
    collapsedShelfRoots: [entry.path],
    starredPaths: [],
    collapsedBranchRoots: [],
    guideDismissed: true,
  });

  await plugin.reloadSettingsFromDisk();

  // Before this fix, `_shelfSignatures` was never touched by
  // `reloadSettingsFromDisk()` at all -- a root whose starred set never
  // changes but whose `collapsedShelfRoots` membership DID (an external
  // write) would keep reading its OLD, now-stale-relative-to-this-reload
  // signature as "unchanged" forever, since `renderShelfForRoot`'s own
  // signature never includes `collapsedShelfRoots` in the first place
  // (see its own doc comment) -- the cache is the only thing standing
  // between a real external change and a render pass that actually looks
  // at it again.
  assert.equal(plugin._shelfSignatures.size, 0, 'the stale entry is gone');
  assert.deepEqual(plugin.settings.collapsedShelfRoots, [entry.path]);
});

test('renderShelfForRoot: the shelf is a child of item.el, inserted as a sibling BEFORE item.childrenEl -- never a child of childrenEl itself', () => {
  const { plugin, rootEl, rootChildrenEl } = makeShelfFixture();
  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  assert.ok(shelf);
  assert.equal(shelf.parentNode, rootEl);
  assert.equal(rootChildrenEl.querySelector(':scope > .spotlight-shelf'), null); // never inside childrenEl
  const idx = Array.from(rootEl.children).indexOf(shelf);
  // The branch toggle is now the shelf's own sibling,
  // inserted between it and childrenEl -- so the shelf no longer sits
  // IMMEDIATELY before childrenEl, but it still comes strictly before it,
  // and the toggle (never the shelf itself) is what's now adjacent.
  const toggle = rootEl.querySelector(':scope > .spotlight-branch-toggle');
  assert.ok(toggle, 'the branch toggle renders alongside the shelf');
  assert.equal(rootEl.children[idx + 1], toggle);
  assert.equal(rootEl.children[idx + 2], rootChildrenEl);
});

test('renderShelfForRoot: nothing starred under the root -> no shelf at all', () => {
  const stub = makeFile('Goals/A.md', { content: '---\ntype: goal\n---\n' }); // no spotlight: true
  const root = makeFolder('Goals', [stub]);
  const rootEl = makeFakeElement('div');
  const rootChildrenEl = makeFakeElement('div');
  rootEl.appendChild(rootChildrenEl);
  const app = makeApp({ folders: [root], files: { [stub.path]: stub._content } });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [{ path: 'Goals', enabled: true }], collapsedShelfRoots: [] };
  plugin.explorerView = { fileItems: { Goals: { file: root, el: rootEl, childrenEl: rootChildrenEl } } };

  renderAllShelves(plugin);
  assert.equal(rootEl.querySelector(':scope > .spotlight-shelf'), null);
});

test('renderShelfForRoot: re-renders idempotently -- a second call replaces, never duplicates, the shelf', () => {
  const { plugin, rootEl } = makeShelfFixture();
  const entry = plugin.settings.roots[0];
  renderAllShelves(plugin);
  renderAllShelves(plugin);
  const shelves = Array.from(rootEl.children).filter((c) => c.classList.contains('spotlight-shelf'));
  assert.equal(shelves.length, 1);
});

test('renderShelfForRoot: two reapplies with unchanged stars emit no DOM mutation on the shelf -- the second call does not even remove+recreate it', () => {
  const { plugin, rootEl } = makeShelfFixture();
  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  assert.ok(shelf);
  renderAllShelves(plugin); // nothing starred/unstarred in between
  const shelfAfter = rootEl.querySelector(':scope > .spotlight-shelf');
  assert.equal(shelfAfter, shelf, 'the exact same DOM node -- never removed and recreated when nothing changed');
});

test('renderShelfForRoot (F4, REWRITTEN 0.13.4): once the starred set changes, the shelf/header/rows CONTAINERS are the SAME nodes -- only the one new row is added, never a teardown+rebuild', async () => {
  // 0.13.4 (an intermittent flicker on rapid
  // successive stars): the shelf used to `existing.remove()` and rebuild
  // EVERY row from scratch on any change to the starred set, even the
  // rows that hadn't changed at all. Confirmed live-suspect #2. Fixed:
  // diff/append -- the shelf, header and rows containers persist across a
  // change; only the row(s) that actually entered or left the starred set
  // are added or removed.
  const { plugin, rootEl, flatUnstarred } = makeShelfFixture();
  renderAllShelves(plugin);
  const firstShelf = rootEl.querySelector(':scope > .spotlight-shelf');
  const firstHeader = Array.from(firstShelf.children).find((c) => c.classList.contains('spotlight-shelf-header'));
  const firstRows = Array.from(firstShelf.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  const firstRow = firstRows.children[0];

  await setSpotlightState(plugin.app, flatUnstarred, true);
  renderAllShelves(plugin);

  const secondShelf = rootEl.querySelector(':scope > .spotlight-shelf');
  assert.equal(secondShelf, firstShelf, 'the shelf container itself is the SAME node -- never torn down and recreated');
  const secondHeader = Array.from(secondShelf.children).find((c) => c.classList.contains('spotlight-shelf-header'));
  assert.equal(secondHeader, firstHeader, 'the header is the SAME node too -- its label text updates in place');
  assert.match(secondHeader.querySelector(':scope > .spotlight-shelf-header-label').textContent, /^SPOTLIGHT \(2\)$/);
  const rows = Array.from(secondShelf.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  assert.equal(rows, firstRows, 'the rows container is the SAME node');
  assert.equal(rows.children.length, 2, 'grew by exactly the one row that actually changed');
  assert.equal(Array.from(rows.children).includes(firstRow), true, 'the pre-existing row for the already-starred candidate is untouched, not recreated');
});

test('shelf row click reveals the real note row (view.revealInFolder) and opens it', () => {
  const { plugin, view, rootEl, stub } = makeShelfFixture();
  const entry = plugin.settings.roots[0];
  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  const rows = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  const row = rows.children[0];
  row._fire('click', {});
  assert.equal(view._revealed, stub);
  assert.equal(plugin.app.workspace._lastOpenedFile, stub);
});

test('shelf row right-click offers Unstar (fired via the row\'s own contextmenu listener); clears spotlight and re-renders the shelf away', async () => {
  const { plugin, rootEl, stub } = makeShelfFixture();
  const entry = plugin.settings.roots[0];
  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  const rows = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  const row = rows.children[0];

  // The real path is contextmenu -> new Menu() -> the "Remove from
  // Spotlight" item's onClick -> unstarShelfEntity(); that last step is
  // exactly what's under test here, exercised directly rather than via a
  // captured Menu instance the row's own handler never exposes.
  row._fire('contextmenu', { preventDefault() {} });
  await unstarShelfEntity(plugin, { entityNote: stub });

  assert.equal(getSpotlightState(plugin.app, stub), false);
  assert.equal(rootEl.querySelector(':scope > .spotlight-shelf'), null);
});

/* ----------------------------------------------------------------------
 * The shelf star's own click un-spotlights:
 * no more scrolling to the real row to unstar from there. Sibling to
 * shelf-row-click-reveals above, not a replacement for it -- the row's
 * plain click still jumps to/opens the real row; only the star itself
 * removes.
 * -------------------------------------------------------------------- */

test('buildShelfRow: the shelf star is drawn via Obsidian\'s own setIcon(\'star\'), never a hand-rolled innerHTML write', () => {
  const { plugin, rootEl } = makeShelfFixture();
  renderAllShelves(plugin);
  const star = rootEl.querySelectorAll('.spotlight-shelf-star')[0];
  assert.ok(star);
  assert.equal(star.getAttribute('data-icon'), 'star', 'setIcon(star, \'star\') actually ran');
});

test('shelf star click (trusted): un-spotlights via setSpotlightState, and never reveals/opens the real row', async () => {
  const { plugin, view, rootEl, stub } = makeShelfFixture();
  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  const rows = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  const row = rows.children[0];
  const star = Array.from(row.children).find((c) => c.classList.contains('spotlight-shelf-star'));

  const evt = makeFakeEvent({ isTrusted: true });
  await Promise.all(star._fire('click', evt));

  assert.equal(getSpotlightState(plugin.app, stub), false);
  assert.equal(view._revealed, undefined, 'revealInFolder must never fire from a star click');
  assert.equal(plugin.app.workspace._lastOpenedFile, undefined, 'the note must never open from a star click');
});

test('shelf star click in a real browser: the star itself holds focus first (tabindex=0, a real mousedown focuses before click fires) -- the write must still land, not throw', async () => {
  const { plugin, rootEl, stub } = makeShelfFixture();
  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  const header = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-header'));
  const rows = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  const row = rows.children[0];
  const star = Array.from(row.children).find((c) => c.classList.contains('spotlight-shelf-star'));

  // The one thing every prior shelf-star test skipped: a real click
  // focuses its target first. Without this line, moveFocusBeforeRemoval's
  // own guard (`document.activeElement !== star`) returns early and the
  // buggy `rows.children.indexOf(row)` line below it never runs at all --
  // which is exactly how 85 tests stayed green on a build that did not
  // work in a real browser.
  document.activeElement = star;

  const evt = makeFakeEvent({ isTrusted: true });
  await Promise.all(star._fire('click', evt));

  assert.equal(getSpotlightState(plugin.app, stub), false, 'the unstar write must land even when the star held focus');
  assert.equal(document.activeElement, header, 'with no sibling row left, focus falls back to the shelf header');
});

test('shelf star click (untrusted, isTrusted: false): refuses -- no write, no reveal', async () => {
  const { plugin, view, rootEl, stub } = makeShelfFixture();
  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  const rows = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  const row = rows.children[0];
  const star = Array.from(row.children).find((c) => c.classList.contains('spotlight-shelf-star'));

  const evt = makeFakeEvent({ isTrusted: false });
  await Promise.all(star._fire('click', evt));

  assert.equal(getSpotlightState(plugin.app, stub), true, 'still starred -- untrusted event refused');
  assert.equal(view._revealed, undefined);
  assert.equal(plugin.app.workspace._lastOpenedFile, undefined);
});

test('shelf title click reveals only -- never touches spotlight state', () => {
  const { plugin, view, rootEl, stub } = makeShelfFixture();
  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  const rows = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  const row = rows.children[0];

  // The title has no click listener of its own (the row's plain click
  // covers it, matching real-DOM bubbling); this exercises the row click
  // the title's presence relies on, confirming the title click path is
  // reveal-only and spotlight state is untouched.
  row._fire('click', {});

  assert.equal(view._revealed, stub);
  assert.equal(plugin.app.workspace._lastOpenedFile, stub);
  assert.equal(getSpotlightState(plugin.app, stub), true, 'a reveal must never change spotlight state');
});

test('Enter on the shelf title reveals only -- never unstars', () => {
  const { plugin, view, rootEl, stub } = makeShelfFixture();
  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  const rows = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  const row = rows.children[0];
  const title = Array.from(row.children).find((c) => c.classList.contains('spotlight-shelf-title'));

  title._fire('keydown', { key: 'Enter', preventDefault() {} });

  assert.equal(view._revealed, stub);
  assert.equal(plugin.app.workspace._lastOpenedFile, stub);
  assert.equal(getSpotlightState(plugin.app, stub), true);
});

test('Enter on the shelf star (trusted) un-spotlights only -- never reveals/opens', async () => {
  const { plugin, view, rootEl, stub } = makeShelfFixture();
  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  const rows = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  const row = rows.children[0];
  const star = Array.from(row.children).find((c) => c.classList.contains('spotlight-shelf-star'));

  const evt = makeFakeEvent({ isTrusted: true, key: 'Enter' });
  await Promise.all(star._fire('keydown', evt));

  assert.equal(getSpotlightState(plugin.app, stub), false);
  assert.equal(view._revealed, undefined);
  assert.equal(plugin.app.workspace._lastOpenedFile, undefined);
});

test('shelf row markup: role/tabindex live on the title, not the row -- no button nested inside a button', () => {
  const { plugin, rootEl } = makeShelfFixture();
  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  const rows = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  const row = rows.children[0];
  const title = Array.from(row.children).find((c) => c.classList.contains('spotlight-shelf-title'));
  const star = Array.from(row.children).find((c) => c.classList.contains('spotlight-shelf-star'));

  assert.equal(row.getAttribute('role'), null, 'the row itself is no longer a button -- only a plain click listener');
  assert.equal(row.getAttribute('tabindex'), null);
  assert.equal(title.getAttribute('role'), 'button');
  assert.equal(title.getAttribute('tabindex'), '0');
  assert.equal(star.getAttribute('role'), 'button');
  assert.equal(star.getAttribute('tabindex'), '0');
  assert.equal(star.getAttribute('aria-label'), 'Remove from Spotlight');
});

test('handleShelfStarActivate: refuses once the plugin has unloaded (unstarShelfEntity\'s own F2 guard, exercised through the star path)', async () => {
  const { plugin, stub } = makeShelfFixture();
  plugin._unloaded = true;
  const evt = makeFakeEvent({ isTrusted: true });
  await handleShelfStarActivate(plugin, { entityNote: stub }, evt);
  assert.equal(getSpotlightState(plugin.app, stub), true); // unchanged -- still starred
});

test('unstarShelfEntity: refuses to write once the plugin has unloaded', async () => {
  const { plugin, stub } = makeShelfFixture();
  plugin._unloaded = true;
  await unstarShelfEntity(plugin, { entityNote: stub });
  assert.equal(getSpotlightState(plugin.app, stub), true); // unchanged -- still starred
});

test('handleShelfStarActivate (0.13.3, optimistic paint): the row leaves the shelf before the write settles', async () => {
  const { plugin, rootEl, stub } = makeShelfFixture();
  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  assert.ok(Array.from(shelf.querySelectorAll('.spotlight-shelf-row')).some((r) => r.getAttribute('data-spotlight-shelf-path') === stub.path));

  const realProcess = plugin.app.vault.process;
  let releaseWrite;
  plugin.app.vault.process = (file, fn) =>
    new Promise((resolve) => {
      releaseWrite = () => resolve(realProcess(file, fn));
    });

  const evt = makeFakeEvent({ isTrusted: true });
  const pending = handleShelfStarActivate(plugin, { entityNote: stub }, evt);
  await Promise.resolve();
  await Promise.resolve();

  const shelfDuring = rootEl.querySelector(':scope > .spotlight-shelf');
  // `stub` was the ONLY starred item on this root's own shelf (per
  // `makeShelfFixture`), so un-starring it optimistically doesn't just
  // remove its row -- with zero starred candidates left, the whole shelf
  // is removed (rule 4). Either way is "left the shelf": no row for this
  // path exists inside whatever `.spotlight-shelf` (if any) is present.
  const stillThereDuring = !!(shelfDuring && Array.from(shelfDuring.querySelectorAll('.spotlight-shelf-row')).some((r) => r.getAttribute('data-spotlight-shelf-path') === stub.path));
  assert.equal(stillThereDuring, false, 'left the shelf instantly -- the write has not resolved yet');
  assert.equal(getSpotlightState(plugin.app, stub), true, 'genuinely NOT written yet');

  releaseWrite();
  await pending;
  assert.equal(getSpotlightState(plugin.app, stub), false, 'now genuinely written too');
});

test('handleShelfStarActivate (0.13.3, optimistic paint): the row comes BACK if the write ultimately fails', async () => {
  const { plugin, rootEl, stub } = makeShelfFixture();
  renderAllShelves(plugin);
  plugin.app.vault.process = async () => {
    throw new Error('disk full');
  };

  const evt = makeFakeEvent({ isTrusted: true });
  await handleShelfStarActivate(plugin, { entityNote: stub }, evt);

  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  const stillThere = shelf && Array.from(shelf.querySelectorAll('.spotlight-shelf-row')).some((r) => r.getAttribute('data-spotlight-shelf-path') === stub.path);
  assert.equal(stillThere, true, 'the row came back -- the write never actually landed');
  assert.equal(getSpotlightState(plugin.app, stub), true);
  assert.equal(plugin._optimisticStarOverrides.has(stub.path), false);
});

test('revealEntityCandidate: guards a missing revealInFolder / getLeaf gracefully (degraded mode)', () => {
  const stub = makeFile('X/X.md');
  const plugin = { explorerView: {}, app: { workspace: {} } };
  assert.doesNotThrow(() => revealEntityCandidate(plugin, { entityNote: stub }));
});

/* ---------------------------------------------------------------------
 * F6: the file-explorer view is acquired only
 * once layout has actually finished restoring, never eagerly from
 * onload()'s own synchronous body -- acquiring eagerly force-loads a
 * deferred leaf via loadIfDeferred(), defeating Obsidian's own deferred
 * loading at cold start.
 * ------------------------------------------------------------------- */

test('onload (F6): does not acquire the file-explorer view before layout is ready; acquires it once onLayoutReady fires', async () => {
  class FakeExplorerView {}
  FakeExplorerView.prototype.requestSort = function () {};
  FakeExplorerView.prototype.getSortedFolderItems = makeFileItemsSortedFolderItems();
  const view = new FakeExplorerView();
  view.fileItems = {};
  view.containerEl = makeFakeElement('div');
  const leaf = { view, loadIfDeferred: async () => {} };
  // layoutReady: false -- the same cold-boot-race fixture shape this
  // harness already supports; a test fires it manually via
  // `app.workspace._fireLayoutReady()`.
  const app = makeApp({ leaves: [leaf], layoutReady: false });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.saved = null;

  await plugin.onload();
  assert.equal(plugin.explorerView, undefined, 'not acquired yet -- layout has not fired ready');

  app.workspace._fireLayoutReady();
  await plugin.explorerReady;
  assert.equal(plugin.explorerView, view, 'acquired once layout is actually ready');
});

/* ---------------------------------------------------------------------
 * F3: closing/reopening the File explorer tab,
 * or loading a workspace, can leave `this.explorerView` pointing at a
 * view whose containerEl is no longer attached to the document -- every
 * surface (star, shelf) silently frozen for the rest of the session
 * unless the view is re-acquired.
 * ------------------------------------------------------------------- */

test('ensureExplorerViewConnected (F3): re-acquires a fresh file-explorer view once the held one is disconnected, tearing down the stale observer first', async () => {
  class FakeExplorerView {}
  FakeExplorerView.prototype.requestSort = function () {};
  FakeExplorerView.prototype.getSortedFolderItems = makeFileItemsSortedFolderItems();
  const freshView = new FakeExplorerView();
  freshView.fileItems = {};
  freshView.containerEl = makeFakeElement('div');
  const leaf = { view: freshView, loadIfDeferred: async () => {} };
  const app = makeApp({ leaves: [leaf] });

  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [], collapsedShelfRoots: [] };

  const staleContainerEl = makeFakeElement('div');
  staleContainerEl.isConnected = false; // the File explorer tab closed/reopened
  const staleView = { containerEl: staleContainerEl };
  plugin.explorerView = staleView;
  let staleObserverDisconnected = false;
  plugin.starObserver = { disconnect: () => { staleObserverDisconnected = true; } };

  plugin.ensureExplorerViewConnected();
  await plugin.explorerReady;

  assert.equal(staleObserverDisconnected, true);
  assert.equal(plugin.explorerView, freshView);
});

test('ensureExplorerViewConnected (F3): a still-connected view is left alone -- no re-acquisition churn on every layout-change', async () => {
  const app = makeApp({});
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [], collapsedShelfRoots: [] };
  const connectedView = { containerEl: makeFakeElement('div') }; // isConnected: true by default
  plugin.explorerView = connectedView;

  plugin.ensureExplorerViewConnected();

  assert.equal(plugin.explorerView, connectedView); // unchanged
  assert.equal(plugin.explorerReady, undefined); // never even attempted a re-acquisition
});

/* ---------------------------------------------------------------------
 * F2: orphan shelves swept, not left with live
 * listeners once their own root is no longer configured.
 * ------------------------------------------------------------------- */

test('sweepOrphanShelves (F2): a shelf whose root is no longer in settings.roots at all is removed', () => {
  const { plugin, rootEl } = makeShelfFixture();
  renderAllShelves(plugin);
  assert.ok(rootEl.querySelector(':scope > .spotlight-shelf'));

  plugin.settings.roots = []; // e.g. removeRoot() already ran
  sweepOrphanShelves(plugin);
  assert.equal(rootEl.querySelector(':scope > .spotlight-shelf'), null);
});

test('sweepOrphanShelves: un-hides an orphaned root through the real invalidate path, even when the owning row has been re-keyed to a NEW fileItems path (a rename)', () => {
  const { plugin, view, rootEl } = makeShelfFixture();
  const rootPath = '04 Inner World/My Life/Projects';
  plugin.settings.collapsedBranchRoots = [rootPath];
  const calls = [];
  view.tree = { infinityScroll: { invalidate: (item, force) => calls.push({ item, force: !!force }) } };

  renderAllShelves(plugin); // builds the shelf + band, applies the hidden state
  assert.ok(rootEl.querySelector(':scope > .spotlight-shelf'));
  assert.equal(rootEl.classList.contains('spotlight-branch-hidden'), true);
  calls.length = 0; // only the sweep's own invalidate calls matter below

  // Simulate a rename: Obsidian re-keys `fileItems` to the NEW path,
  // re-using the SAME row (`.el`) -- but this plugin's own settings
  // still name the OLD path, so the shelf/band (tagged
  // data-spotlight-shelf-root=OLD path) now reads as an orphan.
  const item = view.fileItems[rootPath];
  delete view.fileItems[rootPath];
  view.fileItems['04 Inner World/My Life/Renamed'] = item;
  plugin.settings.roots = []; // the root itself is gone from settings too

  sweepOrphanShelves(plugin);

  assert.equal(rootEl.querySelector(':scope > .spotlight-shelf'), null, 'the orphan shelf is removed');
  assert.equal(rootEl.classList.contains('spotlight-branch-hidden'), false, 'un-hidden');
  assert.ok(
    calls.some((c) => c.item === item && c.force === true) && calls.some((c) => c.item === item && c.force === false),
    'invalidate(item, true) then invalidate(item) ran, through the REAL item found by DOM identity -- not a bare classList.remove() with zero invalidate calls',
  );
});

test('removeRoot end-to-end (F2): no orphan shelf survives; the settings tab side is exercised via renderAllShelves after the settings mutation', () => {
  const { plugin, rootEl } = makeShelfFixture();
  renderAllShelves(plugin);
  assert.ok(rootEl.querySelector(':scope > .spotlight-shelf'));

  plugin.settings.roots = plugin.settings.roots.filter((r) => r.path !== '04 Inner World/My Life/Projects');
  renderAllShelves(plugin); // the same call runReapply() makes; sweeps first (F2), then renders nothing for a root that's gone
  assert.equal(rootEl.querySelector(':scope > .spotlight-shelf'), null);
});

/* ---------------------------------------------------------------------
 * F8: cross-root shelf dedupe -- a migrated (or
 * hand-toggled) vault can carry two ENABLED, overlapping roots; the same
 * starred carrier must not double-list on two shelves.
 * ------------------------------------------------------------------- */

test('renderAllShelves (F8 + §3.3): a carrier reachable from two overlapping ENABLED roots appears on exactly one shelf -- the OUTERMOST root\'s own (§3.3 supersedes F8\'s original settings-array-order dedupe with a path-based rule)', () => {
  const stub = makeFile('Projects/client/Cardboard Alchemy/Cardboard Alchemy.md', { content: '---\ntype: project\nspotlight: true\n---\n' });
  const carrier = makeFolder('Projects/client/Cardboard Alchemy', [stub]);
  const client = makeFolder('Projects/client', [carrier]);
  const projects = makeFolder('Projects', [client]);
  const app = makeApp({ folders: [projects, client, carrier], files: { [stub.path]: stub._content } });

  const projectsEl = makeFakeElement('div');
  const projectsChildrenEl = makeFakeElement('div');
  projectsEl.appendChild(projectsChildrenEl);
  const clientEl = makeFakeElement('div');
  const clientChildrenEl = makeFakeElement('div');
  clientEl.appendChild(clientChildrenEl);
  const containerEl = makeFakeElement('div');
  containerEl.appendChild(projectsEl);
  containerEl.appendChild(clientEl);

  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  // Both enabled and overlapping -- exactly the shape checkRootCollision
  // would refuse on a fresh add, but setRootEnabled() never re-checks it.
  plugin.settings = {
    roots: [
      { path: 'Projects', enabled: true },
      { path: 'Projects/client', enabled: true },
    ],
    collapsedShelfRoots: [],
  };
  plugin.explorerView = {
    fileItems: {
      Projects: { file: projects, el: projectsEl, childrenEl: projectsChildrenEl },
      'Projects/client': { file: client, el: clientEl, childrenEl: clientChildrenEl },
    },
    containerEl,
  };

  renderAllShelves(plugin);

  const onProjects = projectsEl.querySelector(':scope > .spotlight-shelf');
  const onClient = clientEl.querySelector(':scope > .spotlight-shelf');
  // Exactly one of the two carries it -- 'Projects' is the OUTERMOST
  // enabled root of the pair (§3.3), so it owns the branch's one shelf;
  // 'Projects/client', nested under an enabled ancestor, draws none of
  // its own at all.
  assert.ok(onProjects, 'the outermost enabled root owns the branch\'s one shelf');
  assert.equal(onClient, null, 'the nested, overlapping root never draws its own shelf');
});

test('renderAllShelves: a disabled root gets its shelf removed even if it was previously rendered', () => {
  const { plugin, rootEl } = makeShelfFixture();
  renderAllShelves(plugin);
  assert.ok(rootEl.querySelector(':scope > .spotlight-shelf'));
  plugin.settings.roots[0].enabled = false;
  renderAllShelves(plugin);
  assert.equal(rootEl.querySelector(':scope > .spotlight-shelf'), null);
});

/* ---------------------------------------------------------------------
 * a collapsed shelf must not silently
 * re-expand on the very next reapply -- which fires on nearly any vault
 * activity via the MutationObserver.
 * ------------------------------------------------------------------- */

test('shelf collapse survives a reapply: clicking the header persists into settings.collapsedShelfRoots, and the NEXT render starts collapsed', async () => {
  const { plugin, rootEl, entry } = (() => {
    const fixture = makeShelfFixture();
    return { ...fixture, entry: fixture.plugin.settings.roots[0] };
  })();
  renderAllShelves(plugin);
  const header = Array.from(rootEl.querySelector(':scope > .spotlight-shelf').children).find((c) => c.classList.contains('spotlight-shelf-header'));
  await Promise.all(header._fire('click', {}));
  assert.deepEqual(plugin.settings.collapsedShelfRoots, ['04 Inner World/My Life/Projects']);

  // Force past F4's own unchanged-signature cache -- a real vault event
  // that woke the reapply cycle up would also have changed SOMETHING
  // (this assertion only cares that a genuine rebuild re-reads the
  // persisted collapsed set, not that F4's cache itself is exercised
  // here too; F4 has its own dedicated test above).
  plugin._shelfSignatures = new Map();
  renderAllShelves(plugin);
  const shelfAfter = rootEl.querySelector(':scope > .spotlight-shelf');
  assert.equal(shelfAfter.classList.contains('is-collapsed'), true);
});

/* ======================================================================
 * The settings tab -- plain root list, add/remove/enable, counts
 * ==================================================================== */

test('settings tab: renders one row per root with an enabled toggle and a "N found, M starred" line', () => {
  const stub = makeFile('Goals/A.md', { content: '---\ntype: goal\nspotlight: true\n---\n' });
  const other = makeFile('Goals/B.md', { content: '---\ntype: goal\n---\n' });
  const root = makeFolder('Goals', [stub, other]);
  const app = makeApp({ folders: [root], files: { [stub.path]: stub._content, [other.path]: other._content } });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [{ path: 'Goals', enabled: true }] };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();

  // 0.15.0: the counts line is `.spotlight-dir-counts` now,
  // living inside the card -- never `.spotlight-settings-note` (that
  // class stays for refusal/warning notes only).
  const countEls = tab.rootsListEl._findAll ? tab.rootsListEl._findAll('spotlight-dir-counts') : [];
  const text = countEls.map((e) => e.text).join(' ');
  assert.match(text, /2 entities found, 1 starred/);
});

/* ======================================================================
 * 0.15.0. §5.9's
 * own pin list: pill text (a normal path, a trailing slash, the vault
 * root), the counts element sitting inside `.spotlight-dir-card`, the
 * empty guide appearing at zero roots and disappearing after the first
 * Add, and the section order.
 * ==================================================================== */

test('pillTextForRootPath (§5.5): the last path segment; a trailing slash normalizes the same as none; empty/vault-root reads "Vault root"', () => {
  assert.equal(pillTextForRootPath('04 Inner World/My Life/Habits'), 'Habits');
  assert.equal(pillTextForRootPath('Habits/'), 'Habits');
  assert.equal(pillTextForRootPath('Habits'), 'Habits');
  assert.equal(pillTextForRootPath(''), 'Vault root');
  assert.equal(pillTextForRootPath('/'), 'Vault root');
  assert.equal(pillTextForRootPath(undefined), 'Vault root');
});

test('settings tab (0.15.0): the pill on a rendered card reads the same last-segment text', () => {
  const app = makeApp({ folders: [] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [{ path: '04 Inner World/My Life/Habits', enabled: true }] };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();

  const cardEl = tab.rootsListEl.children[0];
  const pillEl = cardEl.children[0].children[0];
  assert.equal(pillEl.tagName, 'span');
  assert.ok(pillEl.cls.includes('spotlight-dir-pill'));
  assert.equal(pillEl.text, 'Habits');
});

test('settings tab (0.15.0): the counts element sits INSIDE .spotlight-dir-card, not as a sibling of it', () => {
  const stub = makeFile('Goals/A.md', { content: '---\ntype: goal\nspotlight: true\n---\n' });
  const root = makeFolder('Goals', [stub]);
  const app = makeApp({ folders: [root], files: { [stub.path]: stub._content } });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [{ path: 'Goals', enabled: true }] };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();

  const cardEl = tab.rootsListEl.children[0];
  const countsInsideCard = cardEl._findAll('spotlight-dir-counts');
  assert.equal(countsInsideCard.length, 1, 'the counts <p> is a genuine descendant of the card, findable from the card itself');
  assert.match(countsInsideCard[0].text, /1 entity found, 1 starred/);
});

test('settings tab (0.15.0): a disabled root\'s card gets .is-off, and its counts read "Not tracked. Turn on to count."', async () => {
  const root = makeFolder('Workspace', []); // must genuinely exist -- a missing path takes the OTHER branch (the "doesn't exist" note), never renderCountsFor at all
  const app = makeApp({ folders: [root] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [{ path: 'Workspace', enabled: false }] };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();

  const cardEl = tab.rootsListEl.children[0];
  assert.ok(cardEl.cls.includes('is-off'));
  const countsEls = cardEl._findAll('spotlight-dir-counts');
  assert.equal(countsEls[0].text, 'Not tracked. Turn on to count.');

  // Flipping the toggle on clears .is-off and shows a real count.
  const actionsEl = cardEl.children[0].children[1];
  await actionsEl._settings[0].toggleComponent.toggle(true);
  assert.equal(cardEl.cls.includes('is-off'), false);
  assert.match(cardEl._findAll('spotlight-dir-counts')[0].text, /entities found/);
});

test('settings tab: toggling a root live-updates the Tracked/Off label via setText, not a dead .text write', async () => {
  const root = makeFolder('Workspace', []);
  const app = makeApp({ folders: [root] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [{ path: 'Workspace', enabled: true }] };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();

  const cardEl = tab.rootsListEl.children[0];
  const headEl = cardEl.children[0];
  const actionsEl = headEl.children[1];
  // `stateEl` is `.spotlight-dir-state`, created before the Setting/
  // toggle it sits alongside (`FakeSetting` never appends a DOM child of
  // its own -- see its own constructor comment), so it's still
  // `actionsEl.children[0]`.
  const stateEl = actionsEl.children[0];
  assert.ok(stateEl.cls.includes('spotlight-dir-state'));
  assert.equal(stateEl.text, 'Tracked');

  await actionsEl._settings[0].toggleComponent.toggle(false);
  // Before this fix, `stateEl.text = ...` was a bare property write --
  // harmless against this harness's OLD plain-field `.text`, but a
  // silent no-op against a real Obsidian element (no setter), so this
  // label never actually updated live. The harness's `.text` is now a
  // read-only getter backed by `setText()`, matching the real API
  // surface, so this assertion fails again if that regresses.
  assert.equal(stateEl.text, 'Off');

  await actionsEl._settings[0].toggleComponent.toggle(true);
  assert.equal(stateEl.text, 'Tracked');
});

test('settings tab (0.15.0): the empty guide appears at zero roots and disappears after the first Add', async () => {
  const app = makeApp({ folders: [] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [] };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();
  assert.equal(tab.rootsListEl._findAll('spotlight-dir-empty').length, 1);
  assert.equal(tab.rootsListEl.children.length, 1, 'only the guide, no cards');

  const addRow = tab.addSectionEl.children[0];
  const addSetting = addRow._settings[0];
  await addSetting.textComponent.type('Workspace');
  await addSetting.buttonComponent.click();

  assert.equal(tab.rootsListEl._findAll('spotlight-dir-empty').length, 0, 'gone once a real directory exists');
  assert.equal(tab.rootsListEl.children.length, 1, 'exactly one card now, the guide is not still sitting there too');
});

test('settings tab (0.15.0): section order top to bottom is add, directories, cleanup, auto-reveal, by data-section', () => {
  const app = makeApp({ folders: [] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [] };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();

  const sections = tab.containerEl._findAll('spotlight-settings-section');
  assert.deepEqual(
    sections.map((s) => s.getAttribute('data-section')),
    ['add', 'directories', 'cleanup', 'auto-reveal'],
  );
  assert.ok(tab.containerEl.cls.includes('spotlight-settings'));
});

test('settings tab: "Add" a valid new root persists it enabled by default and re-renders', async () => {
  const app = makeApp({ folders: [] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [] };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();
  // 0.15.0: the Add control lives in its own top section now,
  // `tab.addSectionEl`, never inside the directories list.
  const addRow = tab.addSectionEl.children[0];
  const setting = addRow._settings[0];
  await setting.textComponent.type('Workspace');
  await setting.buttonComponent.click();

  assert.deepEqual(plugin.settings.roots, [{ path: 'Workspace', enabled: true, spotlightFolders: false }]);
});

test('0.12.0: a refused "Add another root" (nested inside an existing root) renders a p carrying spotlight-settings-error alongside spotlight-settings-note', async () => {
  const app = makeApp({ folders: [] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [{ path: 'Workspace', enabled: true }] };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();
  const addRow = tab.addSectionEl.children[0];
  const setting = addRow._settings[0];
  await setting.textComponent.type('Workspace/Sub'); // inside the already-configured "Workspace" root
  await setting.buttonComponent.click();

  // Refused -- the roots list must be unchanged.
  assert.deepEqual(plugin.settings.roots, [{ path: 'Workspace', enabled: true }]);

  const addNoteEl = addRow.children[0];
  const errorEls = addNoteEl._findAll ? addNoteEl._findAll('spotlight-settings-error') : [];
  assert.equal(errorEls.length, 1, 'the refusal note must carry spotlight-settings-error');
  assert.ok(errorEls[0].cls.includes('spotlight-settings-note'), 'the error class rides ALONGSIDE spotlight-settings-note, never in place of it');
});

test('0.12.0 (REVISED 0.15.0, mockup choice 5 -- the counts line is accent now, not muted): the "N found, M starred" counts line is .spotlight-dir-counts, never .spotlight-settings-error', () => {
  const stub = makeFile('Goals/A.md', { content: '---\ntype: goal\nspotlight: true\n---\n' });
  const other = makeFile('Goals/B.md', { content: '---\ntype: goal\n---\n' });
  const root = makeFolder('Goals', [stub, other]);
  const app = makeApp({ folders: [root], files: { [stub.path]: stub._content, [other.path]: other._content } });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [{ path: 'Goals', enabled: true }] };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();

  const countEls = tab.rootsListEl._findAll ? tab.rootsListEl._findAll('spotlight-dir-counts') : [];
  const text = countEls.map((e) => e.text).join(' ');
  assert.match(text, /2 entities found, 1 starred/);
  const errorEls = tab.rootsListEl._findAll ? tab.rootsListEl._findAll('spotlight-settings-error') : [];
  assert.equal(errorEls.length, 0, 'the counts line is never classed as an error, even though it is accent-coloured now');
});

test('settings tab: removing a root drops it from the list', async () => {
  const app = makeApp({ folders: [] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [{ path: 'Workspace', enabled: true }] };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();
  // 0.15.0: the enabled toggle + trash button now live in the
  // card's own head, `.spotlight-dir-card-actions` -- `cardEl.children`
  // is `[headEl, pathEl, noteEl, countsEl]`; `headEl.children` is
  // `[pillEl, actionsEl]`.
  const cardEl = tab.rootsListEl.children[0];
  const actionsEl = cardEl.children[0].children[1];
  const setting = actionsEl._settings[0];
  await setting.extraButtonComponent.click();

  assert.deepEqual(plugin.settings.roots, []);
});

/* ---------------------------------------------------------------------
 * F7: the existing root's own path field used
 * to commit (and save) on a 400ms debounce off every keystroke, and
 * rebuilt the whole roots list on success -- destroying the very
 * <input> a member was still typing into, and saving a junk
 * intermediate value if they paused mid-word.
 * ------------------------------------------------------------------- */

test('settings tab (F7): typing with a pause (no blur, no Enter) never saves a partial path', async () => {
  const app = makeApp({ folders: [] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [{ path: 'Workspace', enabled: true }], collapsedShelfRoots: [] };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();
  // 0.15.0: the path field is its own Setting now, in the
  // card's own `.spotlight-dir-path` sub-element -- `cardEl.children` is
  // `[headEl, pathEl, noteEl, countsEl]`.
  const cardEl = tab.rootsListEl.children[0];
  const setting = cardEl.children[1]._settings[0];
  await setting.textComponent.type('Workspace/Sub'); // onChange only -- no debounce timer this harness could even simulate pausing mid-way through any more
  // A pause mid-typing has nothing to fire on now (F7 removed the
  // debounce entirely) -- the only way anything commits is blur/Enter,
  // neither of which happened yet.
  assert.deepEqual(plugin.settings.roots, [{ path: 'Workspace', enabled: true }]);
});

test('settings tab (F7): commits on blur, refreshes only this row (never rebuilds the whole list)', async () => {
  const app = makeApp({ folders: [] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [{ path: 'Workspace', enabled: true }], collapsedShelfRoots: [] };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();
  const rootsListElBeforeCommit = tab.rootsListEl;
  const cardEl = tab.rootsListEl.children[0];
  const setting = cardEl.children[1]._settings[0];
  await setting.textComponent.type('Workspace Renamed');
  await setting.textComponent.blur();

  assert.deepEqual(plugin.settings.roots, [{ path: 'Workspace Renamed', enabled: true }]);
  // The SAME rootsListEl/cardEl objects -- renderRootsList() (a full
  // rebuild) never ran; only renderCountsFor() touched anything.
  assert.equal(tab.rootsListEl, rootsListElBeforeCommit);
  assert.equal(tab.rootsListEl.children[0], cardEl);
  // The pill's own text follows the committed path too. This is the "edit a
  // path -> pill updates" case -- before an earlier fix, `pillEl.text = ...`
  // was a bare property write, invisible against a real Obsidian element
  // (no setter), so the pill silently kept showing the OLD path segment
  // after every commit. Proven red with `main.js` reverted alone against
  // this test's OWN harness fix (`.text` read-only, `setText()` the only
  // real writer) -- restoring `main.js` alone (harness fix kept) makes
  // this assertion fail again.
  const pillEl = cardEl.children[0].children[0];
  assert.equal(pillEl.text, 'Workspace Renamed'); // the last PATH segment (split on '/') -- no slash in this path, so the whole string is that segment
});

test('settings tab: the path label/input id pair is built from the root\'s own forEach index, never pillEl.text (undefined on a real element)', () => {
  const app = makeApp({ folders: [] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = {
    roots: [
      { path: 'Workspace', enabled: true },
      { path: '04 Inner World', enabled: true },
    ],
    collapsedShelfRoots: [],
  };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();

  const ids = tab.rootsListEl.children.map((cardEl, i) => {
    const pathEl = cardEl.children[1];
    const label = pathEl.children[0];
    const input = pathEl._settings[0].textComponent.inputEl;
    assert.equal(label.getAttribute('for'), `spotlight-dir-path-input-${i}`);
    assert.equal(input.getAttribute('id'), `spotlight-dir-path-input-${i}`);
    return input.getAttribute('id');
  });
  // Never `undefined` (what `pillEl.text` reads back as on a real
  // element), and no duplicate across cards -- a real member tabbing
  // through the settings pane depends on each label pairing with its
  // OWN input, not the first one in the DOM.
  assert.ok(ids.every((id) => id && !id.includes('undefined')));
  assert.equal(new Set(ids).size, ids.length);
});

test('settings tab (F7): commits on Enter the same way blur does', async () => {
  const app = makeApp({ folders: [] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [{ path: 'Workspace', enabled: true }], collapsedShelfRoots: [] };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();
  const setting = tab.rootsListEl.children[0].children[1]._settings[0];
  await setting.textComponent.type('Workspace Renamed');
  await setting.textComponent.pressEnter();

  assert.deepEqual(plugin.settings.roots, [{ path: 'Workspace Renamed', enabled: true }]);
});

test('settings tab (F7): a refused (colliding) commit on blur reverts the field and never saves', async () => {
  const app = makeApp({ folders: [] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, {
    id: 'spotlight',
    name: 'Spotlight',
    version: '0.0.0-gate',
  });
  plugin.settings = {
    roots: [
      { path: 'Workspace', enabled: true },
      { path: '04 Inner World', enabled: true },
    ],
    collapsedShelfRoots: [],
  };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();
  const setting = tab.rootsListEl.children[0].children[1]._settings[0]; // editing 'Workspace'
  await setting.textComponent.type('04 Inner World/My Life'); // collides with the second root
  await setting.textComponent.blur();

  assert.deepEqual(plugin.settings.roots, [
    { path: 'Workspace', enabled: true },
    { path: '04 Inner World', enabled: true },
  ]); // unchanged -- refused
  assert.equal(setting.textComponent.value, 'Workspace'); // reverted, not left showing the refused value
});

test('settings tab: the counts line sits BEFORE the path-edit refusal note in DOM order, matching mockup §5.2', async () => {
  const root = makeFolder('Workspace', []);
  const app = makeApp({ folders: [root] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, {
    id: 'spotlight',
    name: 'Spotlight',
    version: '0.0.0-gate',
  });
  plugin.settings = {
    roots: [
      { path: 'Workspace', enabled: true },
      { path: '04 Inner World', enabled: true },
    ],
    collapsedShelfRoots: [],
  };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();
  const cardEl = tab.rootsListEl.children[0];
  // `cardEl.children` is `[headEl, pathEl, countsEl, noteEl]` now (0.15.0
  // built `[headEl, pathEl, noteEl, countsEl]` -- the note div first only
  // because the commit closure needed something to close over before
  // `countsEl` existed yet, not because of any layout intent).
  const countsIndex = cardEl.children.findIndex((c) => c._findAll('spotlight-dir-counts').length > 0 || (c.cls && c.cls.includes('spotlight-dir-counts')));
  assert.notEqual(countsIndex, -1, 'sanity: the counts element is findable');

  const setting = cardEl.children[1]._settings[0];
  await setting.textComponent.type('04 Inner World/My Life'); // collides -- forces the refusal note to actually render
  await setting.textComponent.blur();

  const noteIndex = cardEl.children.findIndex((c) => c._findAll('spotlight-settings-error').length > 0);
  assert.notEqual(noteIndex, -1, 'sanity: the refusal note actually rendered');
  assert.ok(countsIndex < noteIndex, `counts (index ${countsIndex}) must come before the refusal note (index ${noteIndex})`);
});

test('settings tab: adding a root nested inside an existing one is refused, blanket rule, even though the outer root is disabled', async () => {
  const app = makeApp({ folders: [] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [{ path: '04 Inner World/My Life/Projects', enabled: false }] };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();
  const addRow = tab.addSectionEl.children[0];
  const setting = addRow._settings[0];
  await setting.textComponent.type('04 Inner World/My Life/Projects/personal');
  await setting.buttonComponent.click();

  assert.equal(plugin.settings.roots.length, 1); // refused, nothing added
});

/* ---------------------------------------------------------------------
 * §3.3: one fence per branch. The
 * outermost enabled root owns the branch's single shelf; a nested
 * enabled root draws NONE of its own, and its own starred entities roll
 * up onto the ancestor's shelf, deduplicated by path.
 * ------------------------------------------------------------------- */

test('renderAllShelves (§3.3): a nested enabled root draws no shelf of its own; its own starred entities appear on the OUTER root\'s single shelf', () => {
  // Outer root: Projects (area-typed). Inner, nested, ALSO enabled root:
  // Projects/personal (custom, no area). Each has its OWN starred
  // entity, distinct from the other's -- this proves rollup (combining
  // content), not just "the same candidate resolved twice."
  const outerOnly = makeFile('Projects/idea.md', { content: '---\ntype: project\nspotlight: true\n---\n' });
  const stub = makeFile('Projects/personal/Widget/Widget.md', { content: '---\nspotlight: true\n---\n' });
  const widget = makeFolder('Projects/personal/Widget', [stub]);
  const personal = makeFolder('Projects/personal', [widget]);
  const projects = makeFolder('Projects', [personal, outerOnly]);
  const files = { [outerOnly.path]: outerOnly._content, [stub.path]: stub._content };
  const app = makeApp({ folders: [projects, personal, widget], files });

  const projectsEl = makeFakeElement('div');
  const projectsChildrenEl = makeFakeElement('div');
  projectsEl.appendChild(projectsChildrenEl);
  const personalEl = makeFakeElement('div');
  const personalChildrenEl = makeFakeElement('div');
  personalEl.appendChild(personalChildrenEl);
  const containerEl = makeFakeElement('div');
  containerEl.appendChild(projectsEl);
  containerEl.appendChild(personalEl);

  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.settings = {
    roots: [
      { path: 'Projects', enabled: true },
      { path: 'Projects/personal', enabled: true },
    ],
    collapsedShelfRoots: [],
  };
  plugin.explorerView = {
    fileItems: {
      Projects: { file: projects, el: projectsEl, childrenEl: projectsChildrenEl },
      'Projects/personal': { file: personal, el: personalEl, childrenEl: personalChildrenEl },
    },
    containerEl,
  };

  renderAllShelves(plugin);

  const onProjects = projectsEl.querySelector(':scope > .spotlight-shelf');
  const onPersonal = personalEl.querySelector(':scope > .spotlight-shelf');
  assert.ok(onProjects, 'the outermost enabled root owns the branch\'s one shelf');
  assert.equal(onPersonal, null, 'the nested enabled root draws none of its own');

  const rows = Array.from(onProjects.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  const titles = Array.from(rows.children).map((r) => Array.from(r.children).find((c) => c.classList.contains('spotlight-shelf-title')).textContent).sort();
  // Both the outer root's OWN candidate and the nested root's own
  // candidate appear together, combined onto the one shelf.
  assert.deepEqual(titles, ['Widget', 'idea']);
});

/* ---------------------------------------------------------------------
 * Contrast self-check — reproduces
 * her own published worst-case ratios from the same token values styles.css
 * declares, across her four measured grounds. `color-mix(in srgb, X N%,
 * transparent)` composited onto each ground, per the CSS Color 4 spec
 * (mixing with `transparent` keeps the RGB, scales alpha by N%).
 * ------------------------------------------------------------------- */

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function relativeLuminance(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
function contrastRatio(hexA, hexB) {
  const a = relativeLuminance(hexA);
  const b = relativeLuminance(hexB);
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}
/** 0.15.2 (k1t): the same `color-mix(in srgb, X N%, transparent)`
 * composite this file's own header comment already describes (mixing
 * with `transparent` keeps the RGB, scales alpha by N%) -- alpha-blends
 * `fgHex` over `groundHex` at `alpha` (0-1) and returns the resulting hex,
 * so a test can compute what a real `hsla(..., alpha)` tint actually
 * paints, not just assert the CSS declares some alpha value. */
function mixOverGround(fgHex, groundHex, alpha) {
  const fg = parseInt(fgHex.replace('#', ''), 16);
  const gd = parseInt(groundHex.replace('#', ''), 16);
  const mix = (shift) => {
    const f = (fg >> shift) & 255;
    const g = (gd >> shift) & 255;
    return Math.round(f * alpha + g * (1 - alpha));
  };
  const r = mix(16), g = mix(8), b = mix(0);
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

// the four measured grounds, and the
// `--spotlight-accent` (-> --spotlight-marker) fallback each theme block
// resolves to (styles.css's own literals -- the test can't see a real
// INKLINE theme.css, so it checks what this file actually declares,
// exactly as the file's own header comments already do for the star).
const GROUNDS = {
  stockDark: '#282828',
  stockLight: '#f6f6f6',
  inklineDark: '#07080b',
  inklineLight: '#f1ede2',
};
const ACCENT_FOR_GROUND = {
  stockDark: '#ff5a2d', // --spotlight-marker's dark-block fallback
  stockLight: '#d43f16', // --spotlight-marker's light-block fallback
  inklineDark: '#ff5a2d',
  inklineLight: '#d43f16',
};

test('contrast self-check: the fence (non-text, accent vs ground) clears 3:1 on all four grounds; worst case measured 3.97:1', () => {
  const ratios = {};
  for (const key of Object.keys(GROUNDS)) {
    ratios[key] = contrastRatio(GROUNDS[key], ACCENT_FOR_GROUND[key]);
    assert.ok(ratios[key] >= 3, `${key}: ${ratios[key].toFixed(2)}:1 must clear 3:1`);
  }
  const worst = Math.min(...Object.values(ratios));
  assert.equal(worst.toFixed(2), '3.97');
});

test('contrast self-check: --spotlight-header-text on the plain ground clears 4.5:1 on all four grounds; worst case measured 4.74:1', () => {
  const HEADER_TEXT_FOR_GROUND = {
    stockDark: '#ff5a2d',
    stockLight: '#b93613',
    inklineDark: '#ff5a2d',
    inklineLight: '#b93613',
  };
  const ratios = {};
  for (const key of Object.keys(GROUNDS)) {
    ratios[key] = contrastRatio(GROUNDS[key], HEADER_TEXT_FOR_GROUND[key]);
    assert.ok(ratios[key] >= 4.5, `${key}: ${ratios[key].toFixed(2)}:1 must clear 4.5:1`);
  }
  const worst = Math.min(...Object.values(ratios));
  assert.equal(worst.toFixed(2), '4.74');
});

/* ---------------------------------------------------------------------
 * 0.15.2: the directory pill's own light-mode
 * tint. Unlike GROUNDS/ACCENT_FOR_GROUND above (styles.css's own
 * FALLBACK literals, a belt-only check for when --color-accent is
 * unset), these two values are the REAL, live-installed INKLINE light
 * numbers -- confirmed read-only against
 * `.obsidian/themes/ICOR for Life - INKLINE/theme.css`, the same file
 * whatever theme is actually applied resolves `--accent-h/-s/-l`/
 * `--background-primary` from: `--accent-h:13 --accent-s:81%
 * --accent-l:40%` -- `hsl(13, 81%, 40%)`, the exact formula
 * `hsla(var(--accent-h), var(--accent-s), var(--accent-l), alpha)` in
 * styles.css computes from too, rounds to `#b93713`/rgb(185,55,19) (a
 * 1-unit green-channel drift off the theme's own literal source hex,
 * `#b93613` -- CSS's `hsl()` and a hex are two different roundings of
 * the same colour, immaterial to the ratio); `--ink` (INKLINE light's
 * own `--background-primary`) == `#f6f3ec` == rgb(246,243,236). This is
 * the exact pair 1 at
 * the then-12% tint) and the exact pair `--spotlight-pill-tint`'s own
 * doc comment (styles.css) re-derives its whole alpha table from. */
test('contrast self-check: the pill\'s own light-mode tint (--spotlight-pill-tint, 6%) clears 4.5:1; the discriminator proves the OLD 12% value (--spotlight-marker-soft, still shared with the star hover) does not', () => {
  const accent = '#b93713'; // INKLINE light, live: hsl(13, 81%, 40%), CSS's own hsl()-rounded value (not the theme's literal #b93613 hex -- see this block's own doc comment)
  const ground = '#f6f3ec'; // INKLINE light, live: --background-primary / --ink

  const at6pct = contrastRatio(accent, mixOverGround(accent, ground, 0.06));
  assert.ok(at6pct >= 4.5, `0.15.2's own 6% tint must clear 4.5:1, got ${at6pct.toFixed(2)}`);
  assert.equal(at6pct.toFixed(2), '4.80', 'must match --spotlight-pill-tint\'s own doc comment (styles.css) exactly, not just clear the floor');

  // Discriminator: the OLD value must still fail, closely reproducing
  // 1 measurement (4.38 here -- this helper rounds
  // the blended background to whole pixel values per channel before
  // computing luminance, a real-pixel model; styles.css's own doc
  // comment quotes 4.39 from a continuous, unrounded blend -- both
  // describe the same colour to within a rounding step) -- proves this
  // test's model (accent/ground pair, alpha-blend math) is the same one
  // that produced her real number, not a model that would pass
  // regardless of alpha.
  const at12pct = contrastRatio(accent, mixOverGround(accent, ground, 0.12));
  assert.ok(at12pct < 4.5, `sanity: the pre-0.15.2 12% tint must still fail, got ${at12pct.toFixed(2)}`);
  assert.equal(at12pct.toFixed(2), '4.38');
});

test('styles.css: --spotlight-pill-tint is 0.06 in the light block only, dark/base stay at 0.13 (unchanged), and .spotlight-dir-pill reads the new token, never the shared --spotlight-marker-soft', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

  const lightBody = extractCssRuleBody(css, ':where(body.theme-light)');
  assert.match(lightBody, /--spotlight-pill-tint:\s*hsla\(var\(--accent-h\), var\(--accent-s\), var\(--accent-l\), 0\.06\)/, 'light block must declare the new 6% tint, theme-token based');

  for (const selector of [':where(body)', ':where(body.theme-dark)']) {
    const body = extractCssRuleBody(css, selector);
    if (!body || !/--spotlight-pill-tint:/.test(body)) continue;
    assert.match(body, /--spotlight-pill-tint:\s*hsla\(var\(--accent-h\), var\(--accent-s\), var\(--accent-l\), 0\.13\)/, `${selector}: --spotlight-pill-tint must stay at 0.13, unchanged`);
  }

  // The star's own `.is-on:hover` background is untouched -- still the
  // ORIGINAL shared token, never repointed to the pill's own new one.
  const starHoverBody = extractCssRuleBody(css, '.spotlight-star.is-on:hover');
  assert.match(starHoverBody, /background:\s*var\(--spotlight-marker-soft\)/, 'the star hover tint must stay on --spotlight-marker-soft, untouched by the pill-only fix');

  const pillBody = extractCssRuleBody(css, '.spotlight-dir-pill');
  assert.match(pillBody, /background:\s*var\(--spotlight-pill-tint\)/, '.spotlight-dir-pill must read the new pill-only token');
  assert.doesNotMatch(pillBody, /background:\s*var\(--spotlight-marker-soft\)/, '.spotlight-dir-pill must NOT still read the shared token');
});

/* ---------------------------------------------------------------------
 * 0.4.3 — a live report on 0.4.2: shelf rows felt cramped (a big star
 * crowding the fence line) and stacked "right on top of each other."
 * CSS-source checks (there is no rendering engine in this harness to
 * measure real pixel gaps against) that the specific fix values landed
 * and haven't quietly regressed.
 * ------------------------------------------------------------------- */

/** Extracts one CSS rule's own `{...}` body by selector, tolerating
 * nested parens inside declaration VALUES (e.g. `calc(var(...) + 2px)`)
 * -- a naive `[^}]*` still works for that (parens never nest a `}`), but
 * a naive `[^)]*` inside a value does NOT tolerate a nested `var(...)`
 * inside a `calc(...)`, which is exactly this file's own shape. Kept as
 * a small helper so a test asserts against the real declaration text,
 * not a hand-copied re-statement of it. */
function extractCssRuleBody(css, selector) {
  const marker = `${selector} {`;
  const start = css.indexOf(marker);
  if (start === -1) return null;
  const open = start + marker.length - 1;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

/* ---------------------------------------------------------------------
 * 0.12.0: "I want to give error
 * text ... set to the theme's accent color. Also, I want to set the
 * spotlight elements to the theme's accent color ... that would be for
 * the starred stars, the shelf stroke line, and the "Spotlight" eyebrow
 * and collapse-arrow ... so it will adopt whatever accent color is set
 * for a given theme, and the error text should also be set to the
 * accent color." Source-level checks that the token chain actually
 * repoints to `--color-accent` (star/fence/header) and `--accent-h/-s/-l`
 * (the soft hover tint), and that the new error class exists, reads the
 * accent alias, and is declared after `.spotlight-settings-note` so it
 * wins at equal specificity.
 * ------------------------------------------------------------------- */

test('0.12.0: each theme block names --color-accent first for --spotlight-marker and --spotlight-header-text', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  for (const selector of [':where(body)', ':where(body.theme-dark)', ':where(body.theme-light)']) {
    const body = extractCssRuleBody(css, selector);
    assert.ok(body, `selector ${selector} must exist`);
    if (!/--spotlight-marker:/.test(body)) continue; // the second `:where(body)` block (star-rest/hover tokens) shares the selector text -- only the marker-family block matters here
    assert.match(body, /--spotlight-marker:\s*var\(--color-accent,/, `${selector}: --spotlight-marker must read --color-accent first`);
    assert.match(body, /--spotlight-header-text:\s*var\(--color-accent,/, `${selector}: --spotlight-header-text must read --color-accent first`);
  }
});

test('0.12.0: --spotlight-marker-soft derives from --accent-h/-s/-l in every theme block, never a fixed rgba literal', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const matches = [...css.matchAll(/--spotlight-marker-soft:\s*([^;]+);/g)];
  assert.equal(matches.length, 3, 'exactly three theme blocks declare --spotlight-marker-soft');
  for (const [, value] of matches) {
    assert.match(value, /^hsla\(var\(--accent-h\), var\(--accent-s\), var\(--accent-l\), 0\.1[23]\)$/, `--spotlight-marker-soft must derive from --accent-h/-s/-l: got "${value}"`);
  }
});

test('0.12.0: .spotlight-settings-error exists, reads --spotlight-accent, and is declared after .spotlight-settings-note', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const noteIndex = css.indexOf('.spotlight-settings-note {');
  const errorIndex = css.indexOf('.spotlight-settings-error {');
  assert.ok(noteIndex !== -1, '.spotlight-settings-note must exist');
  assert.ok(errorIndex !== -1, '.spotlight-settings-error must exist');
  assert.ok(errorIndex > noteIndex, '.spotlight-settings-error must be declared AFTER .spotlight-settings-note to win at equal specificity');
  const body = extractCssRuleBody(css, '.spotlight-settings-error');
  assert.match(body, /color:\s*var\(--spotlight-accent\)/, '.spotlight-settings-error must read --spotlight-accent, not --color-accent directly');
});

/* ---------------------------------------------------------------------
 * 0.4.4 — `--nav-item-padding` is
 * Obsidian's own FOUR-VALUE shorthand (`4px 8px 4px 24px`), never a
 * length; 0.4.3 used it as one in five declarations, every one invalid
 * and silently dropped whole by the browser -- the actual cause of the
 * fence-at-x=0, no-padding-on-shelf-rows, and chip-overlay/missing-fill
 * defects that looked like separate bugs at the time. New HARD rule below.
 * ------------------------------------------------------------------- */

test('CSS lint (0.4.4, HARD): --nav-item-padding is never READ as a length (var(--nav-item-padding ...)) anywhere in styles.css -- it is Obsidian\'s own 4-value shorthand, not a length, and every 0.4.3 use as one was silently dropped by the browser', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  // Checks for an actual USE (a `var(--nav-item-padding` reference, the
  // only shape that can appear as a length operand), not a bare mention
  // of the token's own name -- this file's own history comments (this
  // section, and §7.0's own account above) name it by design, to
  // document exactly what went wrong and why it must never come back.
  assert.ok(!css.includes('var(--nav-item-padding'), 'no declaration may read --nav-item-padding as a length');
});

test('styles.css (0.4.4): the shelf star is one glyph size with the real-row star -- box 1em, glyph 0.95em, never larger', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const starBody = extractCssRuleBody(css, '.spotlight-shelf-star');
  assert.ok(starBody, '.spotlight-shelf-star rule must exist');
  assert.match(starBody, /width:\s*1em/);
  assert.match(starBody, /height:\s*1em/);
  const svgBody = extractCssRuleBody(css, '.spotlight-shelf-star svg');
  assert.ok(svgBody);
  assert.match(svgBody, /width:\s*0\.95em/);
  assert.match(svgBody, /height:\s*0\.95em/);
  // The real row star's own glyph, unchanged since 0.3.x -- confirms
  // "one star glyph size in the plugin," not just a coincidence of two
  // separately-chosen numbers.
  const realStarSvgBody = extractCssRuleBody(css, '.spotlight-star svg');
  assert.ok(realStarSvgBody);
  assert.match(realStarSvgBody, /width:\s*0\.95em/);
  assert.match(realStarSvgBody, /height:\s*0\.95em/);
  assert.ok(!css.includes('var(--icon-xs'), '0.4.3\'s --icon-xs guess must not be READ anywhere -- it was never tied to the star');
});

test('styles.css (0.4.4): the kind icon is gone -- no .spotlight-shelf-icon rule exists any more', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.equal(extractCssRuleBody(css, '.spotlight-shelf-icon'), null);
});

test('styles.css (0.4.4): shelf row/header vertical rhythm matches the real rows exactly -- 4px block padding, tight line-height, 2px margin-bottom (27px pitch)', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  for (const selector of ['.spotlight-shelf-row', '.spotlight-shelf-header']) {
    const body = extractCssRuleBody(css, selector);
    assert.ok(body, `${selector} rule must exist`);
    assert.match(body, /padding-block:\s*var\(--size-4-1,\s*4px\)/, selector);
    assert.match(body, /line-height:\s*var\(--line-height-tight,\s*1\.3\)/, selector);
    assert.match(body, /margin-bottom:\s*var\(--nav-item-margin-bottom,\s*2px\)/, selector);
  }
});

test('geometry arithmetic (§7.5\'s "the four numbers"): the shelf\'s own title column lands at the SAME +40px offset as a real child row\'s title column', () => {
  // Shelf side: rail + border + fence's own inline padding + star box + gap.
  const rail = 12; // --spotlight-shelf-indent default, --size-4-3
  const fenceBorder = 1; // --spotlight-fence-width
  const fenceInlinePadding = 8; // --size-4-2
  const starBoxPx = 13; // 1em at the nav's own 13px base (--nav-item-size)
  const gapToTitle = 6;
  const shelfTitleX = rail + fenceBorder + fenceInlinePadding + starBoxPx + gapToTitle;
  assert.equal(shelfTitleX, 40);

  // Real row side: rail + the children container's own padding-start +
  // the row's own inline-start (the left quarter of --nav-item-padding's
  // 4-value shorthand, 24px -- read as a fact about Obsidian's own
  // shorthand, never applied as a length in this plugin's own CSS).
  const childrenContainerPaddingStart = 4; // --nav-item-children-padding-start, --size-2-2
  const rowOwnInlineStart = 24; // --nav-item-padding's own 4th (left) value
  const realRowTitleX = rail + childrenContainerPaddingStart + rowOwnInlineStart;
  assert.equal(realRowTitleX, 40);

  assert.equal(shelfTitleX, realRowTitleX, 'one shared title rail for the shelf, the SPOTLIGHT header, and every real filename in the branch');
});

/* §7.6's own three-point live-devtools check, encoded where a fixture
 * without a real layout engine allows: the RAIL MEASUREMENT function
 * itself (point 1: "the fence's left border and the guide continue as
 * one line" depends entirely on this reading the real rail, not a
 * padding value), and the geometry arithmetic above (point 2: "the
 * SPOTLIGHT label, every shelf title and every real filename share one left
 * edge"). Point 3 ("a shelf row and a real row measure the same
 * height") has no pixel-measuring engine here to check against; the
 * vertical-rhythm CSS-source test above confirms the DECLARED recipe is
 * identical, which is the closest a fixture like this can get -- actual
 * pixel height needs a live devtools check. */

/* ======================================================================
 * The shelf/band indent -- 0.13.3 fixed the rule that the shelf's left
 * edge is a pure function of root depth (so same-depth shelves always align) by
 * having `measureShelfRail()` read `--nav-item-children-margin-start` off
 * `document.body` once per render and write it back as an inline
 * `--spotlight-shelf-indent` on every shelf/band.
 *
 * 0.13.6 drops that whole JS
 * measure-and-write step: `measureShelfRail()` is RETIRED (see its own
 * retirement comment in main.js, above `renderShelfForRoot`), and
 * `styles.css`'s own `margin-inline-start` for BOTH `.spotlight-shelf`
 * and `.spotlight-branch-toggle` now reads `--nav-item-children-margin-
 * start` DIRECTLY -- an ordinary CSS inheritance through the real DOM
 * (the shelf/band are genuine children of `item.el`, inside the actual
 * Files-panel tree), not a value this plugin captured off
 * `document.body` and re-wrote on every reapply pass. The same
 * rule holds the same way (one global custom property -> every
 * same-depth shelf/band resolves the identical margin), but now needs no
 * JS measurement at all, and a live theme/snippet change is picked up on
 * the very next paint instead of waiting for a reapply pass to notice.
 * ==================================================================== */

test('styles.css (0.13.6, condition C): both .spotlight-shelf and .spotlight-branch-toggle read --nav-item-children-margin-start directly in their own margin-inline-start, never --spotlight-shelf-indent', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  for (const selector of ['.spotlight-shelf', '.spotlight-branch-toggle']) {
    const body = extractCssRuleBody(css, selector);
    assert.ok(body, `${selector} rule must exist`);
    assert.match(body, /margin:[^;]*var\(--nav-item-children-margin-start,\s*var\(--size-4-3,\s*12px\)\)/, `${selector} must inherit the real rail, fallback unchanged`);
  }
  // A handful of doc-comment mentions of the retired token name are fine
  // (the history stays legible) -- what must be gone is any ACTUAL use:
  // a declaration, or a var() reference.
  assert.doesNotMatch(css, /--spotlight-shelf-indent\s*:/, 'no declaration of the retired custom property');
  assert.doesNotMatch(css, /var\(--spotlight-shelf-indent/, 'no var() reference to the retired custom property');
});

test('renderShelfForRoot (0.13.6, condition C): sets no inline --spotlight-shelf-indent on a freshly-built shelf, regardless of --nav-item-children-margin-start on document.body -- the CSS cascade handles it now, not JS', () => {
  document.body._customProperties['--nav-item-children-margin-start'] = '19px';
  try {
    const { plugin, rootEl } = makeShelfFixture();
    renderAllShelves(plugin);
    const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
    assert.ok(shelf);
    assert.equal(shelf.style.getPropertyValue('--spotlight-shelf-indent'), '', 'no inline override -- the shelf leans on CSS inheritance instead');
  } finally {
    delete document.body._customProperties['--nav-item-children-margin-start'];
  }
});

test('renderShelfForRoot (0.13.6, condition C): a signature-change reconcile pass (the "existing shelf, still starred" branch) ALSO sets no inline indent', () => {
  const { plugin, rootEl, flatUnstarred } = makeShelfFixture();
  renderAllShelves(plugin);
  assert.ok(rootEl.querySelector(':scope > .spotlight-shelf'));

  // Force the reconcile-in-place branch (existing shelf, still > 0
  // starred): star a second candidate so the signature changes without
  // the shelf ever going empty.
  return setSpotlightState(plugin.app, flatUnstarred, true).then(() => {
    renderAllShelves(plugin);
    const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
    assert.ok(shelf);
    assert.equal(shelf.style.getPropertyValue('--spotlight-shelf-indent'), '');
  });
});

test('renderShelfForRoot (0.13.6, condition C, live-verified residue): a shelf left over from a PRE-0.13.6 install, still carrying the OLD inline --spotlight-shelf-indent, has it stripped on the very next pass -- even the unchanged-signature short-circuit path', () => {
  const { plugin, rootEl } = makeShelfFixture();
  renderAllShelves(plugin); // builds the shelf fresh, 0.13.6-shaped (no inline indent)
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  assert.ok(shelf);

  // Simulate what a live reload of an UPGRADED plugin actually found:
  // Obsidian doesn't recreate file-explorer rows just because a plugin
  // reloaded, so a shelf a PRIOR (0.13.0-0.13.5) install built can still
  // be sitting in the DOM with its own old inline value.
  shelf.style.setProperty('--spotlight-shelf-indent', '19px');

  // Same signature as before (nothing starred/unstarred) -- this is the
  // SHORT-CIRCUIT "unchanged" path, the one branch most likely to never
  // otherwise touch the shelf's own inline style at all.
  renderAllShelves(plugin);

  assert.equal(
    rootEl.querySelector(':scope > .spotlight-shelf').style.getPropertyValue('--spotlight-shelf-indent'),
    '',
    'the stale inline override left by an old install is cleared, even on the path that changes nothing else',
  );
});

/* ======================================================================
 * Auto-reveal -- a settings-tab line reporting whether at least one
 * file-explorer pane has "auto-reveal active file" on, with a one-way
 * "Turn off" button. Per-LEAF view state, read through the documented
 * `WorkspaceLeaf.getViewState()`, never app-wide.
 * ==================================================================== */

function makeFakeLeaf(autoReveal) {
  const state = { autoReveal };
  let setCalls = 0;
  return {
    getViewState: () => ({ type: 'file-explorer', state: { ...state } }),
    setViewState: async (vs) => {
      setCalls += 1;
      Object.assign(state, vs.state);
    },
    get _setCalls() {
      return setCalls;
    },
    get _state() {
      return { ...state };
    },
  };
}

test('computeAutoRevealState: 0 leaves -- reports the file explorer as not open, never throws', () => {
  const app = { workspace: { getLeavesOfType: () => [] } };
  const result = computeAutoRevealState(app);
  assert.deepEqual(result.leaves, []);
  assert.equal(result.anyOn, false);
});

test('computeAutoRevealState: one leaf, auto-reveal on', () => {
  const leaf = makeFakeLeaf(true);
  const app = { workspace: { getLeavesOfType: (type) => (type === 'file-explorer' ? [leaf] : []) } };
  const result = computeAutoRevealState(app);
  assert.equal(result.anyOn, true);
  assert.deepEqual(result.onLeaves, [leaf]);
});

test('computeAutoRevealState: one leaf, auto-reveal off', () => {
  const leaf = makeFakeLeaf(false);
  const app = { workspace: { getLeavesOfType: () => [leaf] } };
  const result = computeAutoRevealState(app);
  assert.equal(result.anyOn, false);
  assert.deepEqual(result.onLeaves, []);
});

test('computeAutoRevealState: several leaves, mixed on/off -- anyOn true, onLeaves lists only the on ones', () => {
  const on1 = makeFakeLeaf(true);
  const off = makeFakeLeaf(false);
  const on2 = makeFakeLeaf(true);
  const app = { workspace: { getLeavesOfType: () => [on1, off, on2] } };
  const result = computeAutoRevealState(app);
  assert.equal(result.anyOn, true);
  assert.deepEqual(result.onLeaves, [on1, on2]);
});

test('computeAutoRevealState: a deferred-style leaf (getViewState present, no other surface) still reads correctly', () => {
  // Mirrors main.js's own "works on deferred leaves" claim: nothing here
  // depends on any surface beyond getViewState/setViewState.
  const leaf = makeFakeLeaf(true);
  delete leaf.someUnrelatedField;
  const app = { workspace: { getLeavesOfType: () => [leaf] } };
  assert.equal(computeAutoRevealState(app).anyOn, true);
});

test('turnOffAutoReveal: flips every ON leaf via setViewState({...vs, state:{...vs.state, autoReveal:false}}), leaves an already-off leaf untouched, calls requestSaveLayout once', async () => {
  const on1 = makeFakeLeaf(true);
  const off = makeFakeLeaf(false);
  const on2 = makeFakeLeaf(true);
  let saveLayoutCalls = 0;
  const app = { workspace: { getLeavesOfType: () => [on1, off, on2], requestSaveLayout: () => { saveLayoutCalls += 1; } } };

  const count = await turnOffAutoReveal(app);

  assert.equal(count, 2);
  assert.equal(on1._state.autoReveal, false);
  assert.equal(on2._state.autoReveal, false);
  assert.equal(on1._setCalls, 1);
  assert.equal(on2._setCalls, 1);
  assert.equal(off._setCalls, 0, 'an already-off leaf is never written to');
  assert.equal(saveLayoutCalls, 1);
});

test('turnOffAutoReveal: preserves every OTHER key on the leaf\'s own view state, never just replaces it wholesale', async () => {
  const state = { autoReveal: true, sortOrder: 'alphabetical', focusedItem: '04 Inner World' };
  const leaf = {
    getViewState: () => ({ type: 'file-explorer', state: { ...state }, icon: 'folder' }),
    setViewState: async (vs) => {
      leaf._passed = vs;
    },
  };
  const app = { workspace: { getLeavesOfType: () => [leaf] } };

  await turnOffAutoReveal(app);

  assert.equal(leaf._passed.type, 'file-explorer', 'the OUTER view-state shape survives (type, icon, ...)');
  assert.equal(leaf._passed.icon, 'folder');
  assert.equal(leaf._passed.state.sortOrder, 'alphabetical', 'every OTHER state key survives untouched');
  assert.equal(leaf._passed.state.focusedItem, '04 Inner World');
  assert.equal(leaf._passed.state.autoReveal, false);
});

test('turnOffAutoReveal: no leaves at all, or a leaf with no setViewState -- no throw, no write attempted', async () => {
  await assert.doesNotReject(turnOffAutoReveal({ workspace: { getLeavesOfType: () => [] } }));
  await assert.doesNotReject(turnOffAutoReveal({ workspace: { getLeavesOfType: () => [{ getViewState: () => ({ state: { autoReveal: true } }) }] } }));
});

test('settings tab: no file-explorer leaf open -- reports it, no button, never throws', () => {
  const app = makeApp({}); // default workspace stub: getLeavesOfType -> []
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [] };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();

  // 0.15.0: `tab.autoRevealEl` now ALSO carries its own heading
  // Setting directly (`._settings[0]`), so the row itself is reliably
  // `.children[0]._settings[0]` -- the old ternary here was guarding
  // against a shape that no longer applies.
  const settingRow = tab.autoRevealEl.children[0]._settings[0];
  assert.match(settingRow.descText, /not open/);
  assert.equal(settingRow.buttonComponent, undefined, 'no Turn off button when there is nothing to turn off');
});

test('settings tab: auto-reveal ON -- shows the accent-styled warning note and a Turn off button; clicking it turns every on-leaf off and re-renders to the OFF state', async () => {
  const leaf = makeFakeLeaf(true);
  const app = makeApp({});
  app.workspace.getLeavesOfType = (type) => (type === 'file-explorer' ? [leaf] : []);
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [] };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();

  const rowEl = tab.autoRevealEl.children[0];
  const settingRow = rowEl._settings[0];
  assert.match(settingRow.descText, /^On,/);
  const warningNotes = rowEl._findAll('spotlight-settings-error');
  assert.equal(warningNotes.length, 1);
  assert.match(warningNotes[0].text, /jump the Files panel to an invisible row/);
  assert.ok(settingRow.buttonComponent, 'a Turn off button renders');
  assert.equal(settingRow.buttonComponent.text, 'Turn off');

  await settingRow.buttonComponent.click();

  assert.equal(leaf._state.autoReveal, false, 'the leaf itself was actually turned off');
  const rowAfter = tab.autoRevealEl.children[0];
  const settingAfter = rowAfter._settings[0];
  assert.match(settingAfter.descText, /^Off\./);
  assert.equal(settingAfter.buttonComponent, undefined, 'the button is gone once there is nothing left to turn off');
});

test('settings tab: auto-reveal already OFF -- no warning note, no button', () => {
  const leaf = makeFakeLeaf(false);
  const app = makeApp({});
  app.workspace.getLeavesOfType = () => [leaf];
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [] };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();

  const rowEl = tab.autoRevealEl.children[0];
  const settingRow = rowEl._settings[0];
  assert.match(settingRow.descText, /^Off\./);
  assert.equal(rowEl._findAll('spotlight-settings-error').length, 0);
  assert.equal(settingRow.buttonComponent, undefined);
});

test('settings tab: the layout-change listener is registered exactly once, on the PLUGIN (auto-cleaned on unload), never re-registered on a second display()', () => {
  const app = makeApp({});
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [] };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();
  tab.display();
  tab.display();

  const layoutChangeHandlers = (plugin._events || []).filter((e) => e && e.evt === 'layout-change');
  assert.equal(layoutChangeHandlers.length, 1);
});

test('settings tab: the layout-change auto-reveal re-render is skipped once the tab is closed', () => {
  const leaf = makeFakeLeaf(true);
  const app = makeApp({});
  app.workspace.getLeavesOfType = () => [leaf];
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [] };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();

  let renderCalls = 0;
  const realRender = tab.renderAutoRevealSection.bind(tab);
  tab.renderAutoRevealSection = () => {
    renderCalls += 1;
    realRender();
  };

  const layoutChangeHandler = (plugin._events || []).find((e) => e && e.evt === 'layout-change');
  assert.ok(layoutChangeHandler, 'sanity: the listener is registered');

  // Still open -- fires normally.
  app.workspace._emit('layout-change');
  assert.equal(renderCalls, 1);

  // The member closed the pane.
  tab.containerEl.isConnected = false;
  app.workspace._emit('layout-change');
  assert.equal(renderCalls, 1, 'no re-render against a closed tab');
});

test('settings tab: auto-reveal never changes automatically -- rendering the tab, alone, writes nothing', () => {
  const leaf = makeFakeLeaf(true);
  const app = makeApp({});
  app.workspace.getLeavesOfType = () => [leaf];
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [] };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();
  tab.display();

  assert.equal(leaf._state.autoReveal, true, 'still on -- display() alone never writes');
  assert.equal(leaf._setCalls, 0);
});

/* ======================================================================
 * Folder spotlighting -- a per-root
 * "Spotlight folders too" toggle lets a grouping folder itself be
 * starred and shelved, alongside a note. REVISED: under that same toggle, a CARRIER folder is starrable
 * too now, its own SECOND, independent 'folder' candidate alongside its
 * stub note's 'carrier' one -- see the "carrier folder is starrable too"
 * section further down this file for the tests that prove it.
 * ==================================================================== */

/** `Workspace/Workstreams` (a grouping folder, the folder candidate under
 * test) contains `Workspace/Workstreams/Client` (a CARRIER folder, own stub
 * `Client.md`) -- picked specifically so a folder-mode test also
 * exercises the carrier's OWN doubled candidacy (c4n) for free, since
 * this fixture's own `carrierTitleEl` already stands in for the carrier
 * folder's own row. */
function makeFolderModeFixture({ spotlightFolders = true, starredPaths = [] } = {}) {
  const stub = makeFile('Workspace/Workstreams/Client/Client.md', { content: '---\n---\n' });
  const carrier = makeFolder('Workspace/Workstreams/Client', [stub]);
  const bucket = makeFolder('Workspace/Workstreams', [carrier]);
  const root = makeFolder('Workspace', [bucket]);
  const files = { [stub.path]: stub._content };

  const bucketTitleEl = makeFakeElement('div');
  const stubTitleEl = makeFakeElement('div');
  const carrierTitleEl = makeFakeElement('div');
  class FakeExplorerView {}
  FakeExplorerView.prototype.requestSort = function () {};
  FakeExplorerView.prototype.getSortedFolderItems = makeFileItemsSortedFolderItems();
  const view = new FakeExplorerView();
  view.fileItems = {
    [bucket.path]: { file: bucket, selfEl: bucketTitleEl },
    [stub.path]: { file: stub, selfEl: stubTitleEl },
    [carrier.path]: { file: carrier, selfEl: carrierTitleEl },
  };
  view.containerEl = makeFakeElement('div');
  const leaf = { view, loadIfDeferred: async () => {} };

  const app = makeApp({ folders: [root, bucket, carrier], files, leaves: [leaf] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.saved = { roots: [{ path: 'Workspace', enabled: true, spotlightFolders }], starredPaths };
  return { plugin, app, root, bucket, bucketTitleEl, stub, stubTitleEl, carrier, carrierTitleEl };
}

test('reapplyStars (c4n, REVISES the old "the carrier FOLDER\'s own row never does" rule): spotlightFolders on -- the grouping folder\'s own row, the carrier note\'s own row, AND the carrier FOLDER\'s own row all get a star', async () => {
  const { plugin, bucketTitleEl, stubTitleEl, carrierTitleEl } = makeFolderModeFixture();
  await plugin.onload();
  await plugin.explorerReady;
  assert.ok(bucketTitleEl.querySelector(':scope > .spotlight-star'));
  assert.ok(stubTitleEl.querySelector(':scope > .spotlight-star'));
  assert.ok(carrierTitleEl.querySelector(':scope > .spotlight-star'), 'c4n: the carrier folder\'s own row now gets one too, independent of its note\'s');
});

test('reapplyStars (0.7.0): spotlightFolders off (default) -- byte-identical to 0.6.1, the grouping folder\'s row never gets a star', async () => {
  const { plugin, bucketTitleEl, stubTitleEl } = makeFolderModeFixture({ spotlightFolders: false });
  await plugin.onload();
  await plugin.explorerReady;
  assert.equal(bucketTitleEl.querySelector(':scope > .spotlight-star'), null);
  assert.ok(stubTitleEl.querySelector(':scope > .spotlight-star'));
});

test('ensureStarOnRow (0.7.0, design item 7): a folder row\'s star click stars the folder WITHOUT triggering the row\'s own native collapse-toggle listener -- a real bubbling test, not an assumed stopPropagation', async () => {
  const { plugin, bucket, bucketTitleEl } = makeFolderModeFixture();
  await plugin.onload();
  await plugin.explorerReady;

  // Simulates Obsidian's own native handler: a folder's title row toggles
  // collapsed state on click. Registered directly on the title element the
  // star is inserted into as first child -- exactly the ancestor a real,
  // un-stopped click would bubble to.
  let collapseToggled = 0;
  bucketTitleEl.addEventListener('click', () => {
    collapseToggled += 1;
  });

  const star = bucketTitleEl.querySelector(':scope > .spotlight-star');
  assert.ok(star);
  const evt = makeFakeEvent({ isTrusted: true });
  await Promise.all(star._fire('click', evt));

  assert.equal(isFolderStarred(plugin, bucket.path), true);
  assert.equal(collapseToggled, 0, "the folder's own native collapse listener must never fire from a star click");
});

test('ensureStarOnRow: on a folder row, the star lands after the chevron -- its next sibling is .tree-item-inner, never the chevron itself', async () => {
  const { plugin, bucketTitleEl } = makeFolderModeFixture();
  // Simulates Obsidian's own real DOM shape, built before Spotlight ever
  // touches the row: `setCollapsible` prepends `.collapse-icon`, then
  // the explorer's own render puts `.tree-item-inner` (the title text)
  // next. Neither exists in this harness's bare fixture element by
  // default, so a test has to build them the same way the real explorer
  // would, in the same order, before `ensureStarOnRow` ever runs.
  const chevron = makeFakeElement('div');
  chevron.classList.add('collapse-icon');
  const inner = makeFakeElement('div');
  inner.classList.add('tree-item-inner');
  bucketTitleEl.appendChild(chevron);
  bucketTitleEl.appendChild(inner);

  await plugin.onload();
  await plugin.explorerReady;

  const kids = Array.from(bucketTitleEl.children);
  const starIndex = kids.findIndex((k) => k.classList.contains('spotlight-star'));
  assert.notEqual(starIndex, -1, 'the star must be inserted');
  assert.equal(kids[starIndex - 1], chevron, 'the chevron stays put, never displaced by the star');
  assert.equal(kids[starIndex + 1], inner, "the star's next sibling must be .tree-item-inner, not the chevron");
});

test('ensureStarOnRow: a middle-click (auxclick) on a folder row\'s star never bubbles to the row\'s own native collapse listener', async () => {
  const { plugin, bucketTitleEl } = makeFolderModeFixture();
  await plugin.onload();
  await plugin.explorerReady;

  let collapseToggled = 0;
  bucketTitleEl.addEventListener('auxclick', () => {
    collapseToggled += 1;
  });

  const star = bucketTitleEl.querySelector(':scope > .spotlight-star');
  assert.ok(star);
  const evt = makeFakeEvent({ isTrusted: true, button: 1 });
  star._fire('auxclick', evt);

  assert.equal(evt._stopped, true, 'the star must stop the auxclick from bubbling');
  assert.equal(collapseToggled, 0, "a middle-click on the star must never reach the folder row's own native collapse listener");
});

test('setFolderStarred: refuses to write once the plugin has unloaded', async () => {
  const { plugin, bucket } = makeFolderModeFixture();
  await plugin.onload();
  await plugin.explorerReady;
  plugin._unloaded = true;

  const result = await setFolderStarred(plugin, bucket.path, true);

  assert.equal(result, false);
  assert.equal(isFolderStarred(plugin, bucket.path), false, 'no write reaches data.json after unload');
});

test('handleStarActivate: after onunload, a leftover star click performs no write, even for a folder star', async () => {
  const { plugin, bucket, bucketTitleEl } = makeFolderModeFixture();
  await plugin.onload();
  await plugin.explorerReady;
  const star = bucketTitleEl.querySelector(':scope > .spotlight-star');
  assert.ok(star, 'sanity: the star painted before unload');

  plugin.onunload();

  const evt = makeFakeEvent({ isTrusted: true });
  await handleStarActivate(plugin, bucketTitleEl, star, evt);

  assert.equal(isFolderStarred(plugin, bucket.path), false, 'a torn-down instance must never write data.json from a stale star click');
});

test('onunload: sweeps every .spotlight-star out of the explorer DOM by class, not only via _paintedStarPaths', async () => {
  const { plugin, stubTitleEl } = makeFolderModeFixture();
  await plugin.onload();
  await plugin.explorerReady;

  // Attach the row into the explorer's own containerEl tree AFTER paint,
  // for this test only -- makeFolderModeFixture's containerEl otherwise
  // has no real parent/child relationship to the title elements, which
  // the old, path-keyed sweep never needed but a real by-class
  // querySelectorAll does.
  plugin.explorerView.containerEl.appendChild(stubTitleEl);
  assert.ok(stubTitleEl.querySelector(':scope > .spotlight-star'), 'sanity: star painted before unload');

  // Simulates the exact gap the blanket sweep closes: `_paintedStarPaths`
  // has gone stale (cleared here to stand in for a row this cache never
  // observed), so the old path-keyed sweep alone would miss this star.
  plugin._paintedStarPaths = new Set();

  plugin.onunload();

  assert.equal(stubTitleEl.querySelector(':scope > .spotlight-star'), null, 'the blanket by-class sweep must remove it anyway');
});

test('onunload: un-hides every collapsedBranchRoots entry through the real invalidate path BEFORE the blanket class strip, not a bare classList.remove() with no invalidate call', () => {
  const { plugin, view, rootEntry, invalidateCalls } = makeBranchToggleFixture({ collapsedBranchRoots: ['04 Inner World/My Life/Projects'] });
  const rootItem = view.fileItems[rootEntry.path];
  rootItem.el.classList.add('spotlight-branch-hidden');
  invalidateCalls.length = 0; // only the onunload's own calls matter below

  plugin.onunload();

  assert.equal(rootItem.el.classList.contains('spotlight-branch-hidden'), false, 'un-hidden');
  assert.ok(
    invalidateCalls.some((c) => c.path === rootEntry.path && c.force === true) && invalidateCalls.some((c) => c.path === rootEntry.path && c.force === false),
    'invalidate(item, true) then invalidate(item) ran -- the virtualised list was actually told about the reveal, not just a silent class strip',
  );
});

test('onunload: the blanket shelf/toggle sweep invalidates the owning row\'s height exactly once, even though both the shelf and its toggle are removed', () => {
  const { plugin, view, rootEntry, invalidateCalls } = makeBranchToggleFixture();
  renderAllShelves(plugin);
  const rootItem = view.fileItems[rootEntry.path];
  assert.ok(rootItem.el.querySelector(':scope > .spotlight-shelf'), 'sanity: shelf rendered before unload');
  assert.ok(rootItem.el.querySelector(':scope > .spotlight-branch-toggle'), 'sanity: toggle rendered before unload');
  invalidateCalls.length = 0; // only the onunload sweep's own calls matter below

  plugin.onunload();

  assert.equal(rootItem.el.querySelector(':scope > .spotlight-shelf'), null, 'shelf swept');
  assert.equal(rootItem.el.querySelector(':scope > .spotlight-branch-toggle'), null, 'toggle swept');
  // Before this fix, neither sweep called invalidate at all -- a member
  // disabling the plugin with shelves open could see the exact
  // stale-row-height flash/gap reported on the next
  // scroll, even with the plugin off. Exactly one call, not two: the
  // shelf and toggle sweeps share `unloadInvalidatedOwners` so the SAME
  // owning row is never invalidated twice for one unload, matching
  // `removeShelfForRoot`'s own single, OR-gated call.
  const forSameRoot = invalidateCalls.filter((c) => c.path === rootEntry.path);
  assert.equal(forSameRoot.length, 1, 'exactly one invalidate call for the one owning row');
});

test('sweepOrphanShelves: a band-only orphan -- a toggle left behind with no matching shelf -- still invalidates its owning row\'s height', () => {
  const { plugin, view, rootEntry, invalidateCalls } = makeBranchToggleFixture();
  renderAllShelves(plugin);
  const rootItem = view.fileItems[rootEntry.path];
  // Simulates the shelf already having been swept in a PRIOR pass (or by
  // some other path) while its own toggle survived -- the exact "band-
  // only orphan" case: the shelf loop finds nothing for this root,
  // so only the toggle loop ever reaches its owning row.
  const shelf = rootItem.el.querySelector(':scope > .spotlight-shelf');
  shelf.remove();
  assert.ok(rootItem.el.querySelector(':scope > .spotlight-branch-toggle'), 'sanity: the toggle alone survives');
  invalidateCalls.length = 0;

  plugin.settings.roots = []; // orphan it
  sweepOrphanShelves(plugin);

  assert.equal(rootItem.el.querySelector(':scope > .spotlight-branch-toggle'), null, 'the lone toggle is still swept');
  const forSameRoot = invalidateCalls.filter((c) => c.path === rootEntry.path && c.force === false);
  // Before this fix, the toggle loop removed the band but never called
  // invalidate at all when it was the only thing left to remove for a
  // root (the shelf loop just above it had nothing to invalidate,
  // finding no shelf).
  assert.equal(forSameRoot.length, 1, 'the toggle-only removal still told infinityScroll the row shrank');
});

test('resolveSpotlightTarget (0.7.0): a grouping folder resolves as kind: "folder" when its root has spotlightFolders on; resolves nothing when off', async () => {
  const { plugin, bucket } = makeFolderModeFixture();
  await plugin.onload();
  await plugin.explorerReady;
  const on = resolveSpotlightTarget(plugin, bucket);
  assert.equal(on.kind, 'folder');
  assert.equal(on.target, bucket);

  await plugin.setRootSpotlightFolders('Workspace', false);
  assert.equal(resolveSpotlightTarget(plugin, bucket), null);
});

test('resolveSpotlightTarget: the root folder itself never resolves, even with spotlightFolders on', async () => {
  const { plugin, root } = makeFolderModeFixture();
  await plugin.onload();
  await plugin.explorerReady;
  assert.equal(resolveSpotlightTarget(plugin, root), null);
});

test('resolveSpotlightTarget (c4n, 2026-09-21, REVISES the old "a carrier folder\'s own row never resolves" rule): a carrier folder\'s own row now resolves as kind: "folder" when spotlightFolders is on; resolves nothing when off', async () => {
  const { plugin, carrier } = makeFolderModeFixture();
  await plugin.onload();
  await plugin.explorerReady;
  const on = resolveSpotlightTarget(plugin, carrier);
  assert.equal(on.kind, 'folder');
  assert.equal(on.target, carrier);

  await plugin.setRootSpotlightFolders('Workspace', false);
  assert.equal(resolveSpotlightTarget(plugin, carrier), null);
});

test('addSpotlightMenuItem (0.7.0): with spotlightFolders on, a grouping folder\'s file-menu gets "Spotlight this"; clicking it stars the folder through the folder store', async () => {
  const { plugin, bucket } = makeFolderModeFixture();
  await plugin.onload();
  await plugin.explorerReady;
  const menu = makeMenu();
  addSpotlightMenuItem(plugin, menu, bucket);
  assert.equal(menu.items.length, 1);
  assert.equal(menu.items[0].title, 'Spotlight this');
  await menu.items[0].clickHandler();
  assert.equal(isFolderStarred(plugin, bucket.path), true);
});

test('addSpotlightMenuItem (0.7.0): with spotlightFolders off (default), a grouping folder gets no menu item at all', async () => {
  const { plugin, bucket } = makeFolderModeFixture({ spotlightFolders: false });
  await plugin.onload();
  await plugin.explorerReady;
  const menu = makeMenu();
  addSpotlightMenuItem(plugin, menu, bucket);
  assert.equal(menu.items.length, 0);
});

test('addSpotlightMenuItem (c4n, REVISES the old "a carrier folder\'s own row never gets one" rule): a carrier folder\'s own row now gets "Spotlight this" too, with spotlightFolders on; clicking it stars the folder through the folder store, independent of its own stub note', async () => {
  const { plugin, carrier } = makeFolderModeFixture();
  await plugin.onload();
  await plugin.explorerReady;
  const menu = makeMenu();
  addSpotlightMenuItem(plugin, menu, carrier);
  assert.equal(menu.items.length, 1);
  assert.equal(menu.items[0].title, 'Spotlight this');
  await menu.items[0].clickHandler();
  assert.equal(isFolderStarred(plugin, carrier.path), true);
});

test('addSpotlightMenuItem (regression): with spotlightFolders off (default), a folder holding a same-named note still gets no menu item on its own row -- only the note\'s own row does', async () => {
  const { plugin, carrier } = makeFolderModeFixture({ spotlightFolders: false });
  await plugin.onload();
  await plugin.explorerReady;
  const menu = makeMenu();
  addSpotlightMenuItem(plugin, menu, carrier);
  assert.equal(menu.items.length, 0);
});

test('registerRowInjectionEvents (0.7.0): a vault rename rewrites a starred folder\'s own stored path and its starred descendant\'s; a vault delete drops both, leaving an unrelated stored path untouched', async () => {
  const bucketPath = 'Workspace/Workstreams';
  const { plugin, bucket } = makeFolderModeFixture({
    starredPaths: [bucketPath, `${bucketPath}/Sub`, 'Unrelated'],
  });
  assert.equal(bucket.path, bucketPath);
  await plugin.onload();
  await plugin.explorerReady;

  plugin.app.vault._emit('rename', { path: 'Workspace/Renamed' }, bucket.path);
  assert.deepEqual([...plugin.settings.starredPaths].sort(), ['Workspace/Renamed', 'Workspace/Renamed/Sub', 'Unrelated'].sort());

  plugin.app.vault._emit('delete', { path: 'Workspace/Renamed' });
  assert.deepEqual(plugin.settings.starredPaths, ['Unrelated']);
});

/** Folder-mode shelf fixture -- a grouping folder starred directly
 * through `settings.starredPaths` (the folder store), shelved at the
 * root's own branch exactly like a starred note is. */
function makeFolderShelfFixture({ starredPaths } = {}) {
  const stub = makeFile('Workspace/Workstreams/Client/Client.md', { content: '---\n---\n' });
  const carrier = makeFolder('Workspace/Workstreams/Client', [stub]);
  const bucket = makeFolder('Workspace/Workstreams', [carrier]);
  const root = makeFolder('Workspace', [bucket]);
  const files = { [stub.path]: stub._content };

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

  const app = makeApp({ folders: [root, bucket, carrier], files });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.settings = {
    roots: [{ path: 'Workspace', enabled: true, spotlightFolders: true }],
    collapsedShelfRoots: [],
    starredPaths: starredPaths || [bucket.path],
  };
  plugin.explorerView = view;
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => renderAllShelves(plugin);
  return { plugin, view, rootEl, rootChildrenEl, containerEl, bucket, carrier, stub };
}

test('renderAllShelves (0.7.0): a starred grouping folder renders on the shelf, titled by its own folder name, keyed by its own path', () => {
  const { plugin, rootEl, bucket } = makeFolderShelfFixture();
  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  assert.ok(shelf);
  const rows = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  assert.equal(rows.children.length, 1);
  const row = rows.children[0];
  assert.equal(row.getAttribute('data-spotlight-shelf-path'), bucket.path);
  const title = Array.from(row.children).find((c) => c.classList.contains('spotlight-shelf-title'));
  assert.equal(title.textContent, bucket.name);
});

test('revealEntityCandidate (0.7.0): a folder candidate reveals via view.revealInFolder but is never opened as a document', () => {
  const { plugin, view, bucket } = makeFolderShelfFixture();
  const candidate = { kind: 'folder', target: bucket };
  revealEntityCandidate(plugin, candidate);
  assert.equal(view._revealed, bucket);
  assert.equal(plugin.app.workspace._lastOpenedFile, undefined);
});

test('unstarShelfEntity (0.7.0): un-spotlights a folder candidate through the folder store and removes it from the shelf', async () => {
  const { plugin, rootEl, bucket } = makeFolderShelfFixture();
  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  assert.ok(shelf);

  // Exercised directly, the same way the existing note-star gate does
  // (row right-click contextmenu test, above) -- the click listener
  // itself is fire-and-forget (`.catch()`, never returned), so firing it
  // through `_fire` alone never lets a test deterministically await the
  // full chain down to the shelf rebuild; `unstarShelfEntity` IS that
  // chain's own entry point either way.
  await unstarShelfEntity(plugin, { kind: 'folder', target: bucket });

  assert.equal(isFolderStarred(plugin, bucket.path), false);
  assert.equal(rootEl.querySelector(':scope > .spotlight-shelf'), null); // nothing left starred -- no shelf
});

test('handleShelfStarActivate (0.7.0): a trusted shelf-star click reaches the folder store through the full click -> handler chain (fired directly, not via the fire-and-forget DOM listener)', async () => {
  const { plugin, rootEl, bucket } = makeFolderShelfFixture();
  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  const rows = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  const star = Array.from(rows.children[0].children).find((c) => c.classList.contains('spotlight-shelf-star'));
  assert.ok(star);
  const evt = makeFakeEvent({ isTrusted: true });
  await handleShelfStarActivate(plugin, { kind: 'folder', target: bucket }, evt);
  assert.equal(isFolderStarred(plugin, bucket.path), false);
});

test('settings tab (0.7.0): renders "Spotlight folders too" as its own Setting row per root, toggling it persists via setRootSpotlightFolders', async () => {
  const app = makeApp({ folders: [] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [{ path: 'Workspace', enabled: true, spotlightFolders: false }], starredPaths: [] };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();
  const cardEl = tab.rootsListEl.children[0];
  // 0.15.0: path/enabled/remove split across the card's own
  // head and path sub-elements now (see the dedicated tests for those);
  // "Spotlight folders too" is the one Setting registered DIRECTLY on
  // the card itself, `cardEl._settings[0]` -- never a second `.addToggle()`
  // on another Setting, which would just clobber its component.
  const folderSetting = cardEl._settings[0];
  assert.equal(folderSetting.nameText, 'Spotlight folders too');
  assert.equal(folderSetting.extraClass, 'spotlight-dir-option');
  assert.equal(folderSetting.toggleComponent.value, false);

  await folderSetting.toggleComponent.toggle(true);
  assert.equal(plugin.settings.roots[0].spotlightFolders, true);
});

/* ======================================================================
 * Folder star cleanup -- a settings-tab button that prunes
 * `starredPaths` entries whose folder no longer exists in this vault.
 * Never automatic: this is the one and only place `cleanupStaleFolderStars`
 * is ever called from.
 * ==================================================================== */

test('computeStaleFolderStarredPaths: a path with no real folder is stale; a path that resolves to any real folder (including a carrier) is live', () => {
  const stub = makeFile('Goals/Sub/Sub.md', { content: '---\n---\n' });
  const carrier = makeFolder('Goals/Sub', [stub]);
  const goals = makeFolder('Goals', [carrier]);
  const app = makeApp({ folders: [goals, carrier], files: { [stub.path]: stub._content } });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [], starredPaths: ['Goals', 'Goals/Sub', 'Goals/Gone'] };

  const stale = computeStaleFolderStarredPaths(plugin);
  assert.deepEqual(stale, ['Goals/Gone']);
});

test('computeStaleFolderStarredPaths: `[]` for a plugin whose settings predate `starredPaths`, never a throw', () => {
  const app = makeApp({ folders: [] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [] }; // no starredPaths field at all
  assert.deepEqual(computeStaleFolderStarredPaths(plugin), []);
});

test('cleanupStaleFolderStars: removes every stale path, keeps every live one, writes once, reports the count removed', async () => {
  const goals = makeFolder('Goals', []);
  const app = makeApp({ folders: [goals] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [], starredPaths: ['Goals', 'Goals/Gone', 'Elsewhere/AlsoGone'] };
  assert.equal(plugin.saved, null);

  const result = await cleanupStaleFolderStars(plugin);

  assert.deepEqual(result, { removed: 2 });
  assert.deepEqual(plugin.settings.starredPaths, ['Goals']);
  // A real write actually landed in `data.json` (`plugin.saved`, the
  // harness's own `saveData` sink), not just the in-memory object.
  assert.deepEqual(plugin.saved.starredPaths, ['Goals']);
});

test('cleanupStaleFolderStars: nothing stale -> `{ removed: 0 }`, and data.json is never touched', async () => {
  const goals = makeFolder('Goals', []);
  const app = makeApp({ folders: [goals] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [], starredPaths: ['Goals'] };

  const result = await cleanupStaleFolderStars(plugin);

  assert.deepEqual(result, { removed: 0 });
  assert.deepEqual(plugin.settings.starredPaths, ['Goals']);
  assert.equal(plugin.saved, null, 'saveData/saveSettings must never fire on a zero-case cleanup');
});

test('cleanupStaleFolderStars: guarded by `_unloaded`, same discipline as `setFolderStarred`', async () => {
  const app = makeApp({ folders: [] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [], starredPaths: ['Goals/Gone'] };
  plugin._unloaded = true;

  const result = await cleanupStaleFolderStars(plugin);

  assert.deepEqual(result, { removed: 0 });
  assert.deepEqual(plugin.settings.starredPaths, ['Goals/Gone'], 'a torn-down instance must never mutate starredPaths');
  assert.equal(plugin.saved, null);
});

test('settings tab: "Clean up stale stars" renders after the roots list, its description carries the LIVE stale count, and clicking removes stale entries, reports the count, and refreshes itself', async () => {
  const goals = makeFolder('Goals', []);
  const app = makeApp({ folders: [goals] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [], starredPaths: ['Goals', 'Goals/Gone'] };
  plugin.requestExplorerSort = () => {
    plugin._sortCalled = true;
  };
  plugin.scheduleStarReapply = () => {
    plugin._reapplyCalled = true;
  };

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();

  // 0.15.0: the section heading itself (registered directly on
  // `cleanupEl`, no child div) carries the OLD "Clean up stale stars"
  // wording now; the row's own name shortens to "Remove stars for
  // missing files" so it never repeats
  // the heading word for word.
  assert.equal(tab.cleanupEl._settings[0].nameText, 'Clean up stale stars');
  const rowEl = tab.cleanupEl.children[0];
  const setting = rowEl._settings[0];
  assert.equal(setting.nameText, 'Remove stars for missing files');
  // 0.10.0: the description now names files alongside folders, since a
  // stale starred path can be either shape.
  assert.match(setting.descText, /^Remove stars kept for files and folders that no longer exist in this vault\. 1 stale\.$/);

  await setting.buttonComponent.click();

  assert.deepEqual(plugin.settings.starredPaths, ['Goals']);
  assert.equal(plugin._sortCalled, true);
  assert.equal(plugin._reapplyCalled, true);

  // Refreshed in place -- same `cleanupEl`, a fresh row/Setting underneath.
  const refreshedRowEl = tab.cleanupEl.children[0];
  const refreshedSetting = refreshedRowEl._settings[0];
  assert.match(refreshedSetting.descText, /Nothing to clean\.$/);
});

// 0.10.0: the clean-up button now also prunes
// a starred FILE path that no longer resolves to anything real, using
// `vault.getAbstractFileByPath` (resolves a TFolder OR a TFile) rather
// than the old folder-only `vault.getFolderByPath` read -- proving the
// bug the old read would have had, had it ever been asked about a file.
test('settings tab: "Clean up stale stars" prunes a stale FILE path too, and leaves a live one alone', async () => {
  const liveFile = makeFile('Goals/cover.png');
  const goalsWithFile = makeFolder('Goals', [liveFile]);
  const app = makeApp({ folders: [goalsWithFile] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [], starredPaths: ['Goals/cover.png', 'Goals/gone.png'] };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();

  const rowEl = tab.cleanupEl.children[0];
  const setting = rowEl._settings[0];
  assert.match(setting.descText, /1 stale\.$/);

  await setting.buttonComponent.click();

  // The live file's own star survives; only the dead path is pruned.
  assert.deepEqual(plugin.settings.starredPaths, ['Goals/cover.png']);
});

test('settings tab: "Clean up stale stars" with nothing stale never calls reapply/sort on click', async () => {
  const goals = makeFolder('Goals', []);
  const app = makeApp({ folders: [goals] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [], starredPaths: ['Goals'] };
  plugin.requestExplorerSort = () => {
    plugin._sortCalled = true;
  };
  plugin.scheduleStarReapply = () => {
    plugin._reapplyCalled = true;
  };

  const tab = new SpotlightSettingTab(app, plugin);
  tab.display();
  const setting = tab.cleanupEl.children[0]._settings[0];
  assert.match(setting.descText, /Nothing to clean\.$/);

  await setting.buttonComponent.click();

  assert.equal(plugin._sortCalled, undefined);
  assert.equal(plugin._reapplyCalled, undefined);
});

/* ======================================================================
 * The folder icon on a shelf row -- a
 * folder shelf row (never a note row) gets its own kind icon between the
 * star and the title, via Obsidian's own setIcon().
 * ==================================================================== */

/** A shelf carrying BOTH a starred grouping folder and a starred flat
 * note under the same enabled root, so a single render proves a folder
 * row and a note row side by side. */
function makeMixedShelfFixture() {
  const stub = makeFile('Workspace/Workstreams/Client/Client.md', { content: '---\n---\n' });
  const carrier = makeFolder('Workspace/Workstreams/Client', [stub]);
  const bucket = makeFolder('Workspace/Workstreams', [carrier]);
  const flat = makeFile('Workspace/idea.md', { content: '---\ntype: project\nspotlight: true\n---\n' });
  const root = makeFolder('Workspace', [bucket, flat]);
  const files = { [stub.path]: stub._content, [flat.path]: flat._content };

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

  const app = makeApp({ folders: [root, bucket, carrier], files });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.settings = {
    roots: [{ path: 'Workspace', enabled: true, spotlightFolders: true }],
    collapsedShelfRoots: [],
    starredPaths: [bucket.path],
  };
  plugin.explorerView = view;
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => renderAllShelves(plugin);
  return { plugin, view, rootEl, bucket, flat };
}

test('shelf row (0.8.0): a FOLDER row gets its own folder icon between the star and the title, via setIcon; a NOTE row on the SAME shelf gets none', () => {
  const { plugin, rootEl, bucket, flat } = makeMixedShelfFixture();
  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  assert.ok(shelf);
  const rows = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  assert.equal(rows.children.length, 2);

  const folderRow = Array.from(rows.children).find((r) => r.getAttribute('data-spotlight-shelf-path') === bucket.path);
  const noteRow = Array.from(rows.children).find((r) => r.getAttribute('data-spotlight-shelf-path') === flat.path);
  assert.ok(folderRow);
  assert.ok(noteRow);

  const folderChildren = Array.from(folderRow.children);
  assert.equal(folderChildren.length, 3, 'star, folder icon, title');
  assert.ok(folderChildren[0].classList.contains('spotlight-shelf-star'));
  assert.ok(folderChildren[1].classList.contains('spotlight-shelf-folder-icon'));
  assert.equal(folderChildren[1].getAttribute('data-icon'), 'folder');
  assert.ok(folderChildren[2].classList.contains('spotlight-shelf-title'));

  const noteChildren = Array.from(noteRow.children);
  assert.equal(noteChildren.length, 2, 'star, title -- unchanged');
  assert.ok(noteChildren[0].classList.contains('spotlight-shelf-star'));
  assert.ok(noteChildren[1].classList.contains('spotlight-shelf-title'));
});

test('styles.css (0.10.0): .spotlight-shelf-file-icon matches .spotlight-shelf-folder-icon\'s own size and colour rules exactly', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const body = extractCssRuleBody(css, '.spotlight-shelf-file-icon');
  assert.ok(body, '.spotlight-shelf-file-icon rule must exist');
  assert.match(body, /width:\s*0\.95em/);
  assert.match(body, /height:\s*0\.95em/);
  assert.match(body, /color:\s*currentColor/);
  assert.doesNotMatch(body, /--spotlight-accent/);
});

test('styles.css (0.8.0): .spotlight-shelf-folder-icon is sized to the star\'s own glyph (0.95em) and coloured currentColor, never the accent', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const body = extractCssRuleBody(css, '.spotlight-shelf-folder-icon');
  assert.ok(body, '.spotlight-shelf-folder-icon rule must exist');
  assert.match(body, /width:\s*0\.95em/);
  assert.match(body, /height:\s*0\.95em/);
  assert.match(body, /color:\s*currentColor/);
  assert.doesNotMatch(body, /--spotlight-accent/);
});

test('geometry arithmetic: a FOLDER shelf row\'s title lands exactly icon + gap further right than a NOTE row\'s own, reusing the SAME shared gap token the star already has to the title', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const rowBody = extractCssRuleBody(css, '.spotlight-shelf-row');
  const gapMatch = rowBody.match(/gap:\s*(\d+(?:\.\d+)?)px/);
  assert.ok(gapMatch, '.spotlight-shelf-row must declare its own gap');
  const gapToTitle = parseFloat(gapMatch[1]);
  assert.equal(gapToTitle, 6, 'the SAME token the star already uses to the title -- not a second, new one');

  const iconBody = extractCssRuleBody(css, '.spotlight-shelf-folder-icon');
  const iconMatch = iconBody.match(/width:\s*(\d+(?:\.\d+)?)em/);
  assert.ok(iconMatch, '.spotlight-shelf-folder-icon must declare its own em-based width');
  const iconEm = parseFloat(iconMatch[1]);
  assert.equal(iconEm, 0.95);

  const navBasePx = 13; // --nav-item-size, the same base the existing +40px note-row test above uses for the star box
  const noteRowTitleX = 40; // unchanged (the existing geometry test above)
  const folderRowTitleX = noteRowTitleX + iconEm * navBasePx + gapToTitle;

  // Flexbox `gap` on `.spotlight-shelf-row` applies uniformly between
  // EVERY child, so the folder icon, inserted between the star and the
  // title, reuses the SAME 6px token twice (star -> icon, icon -> title)
  // with no new spacing rule added anywhere.
  assert.equal(folderRowTitleX, 58.35);
});

/* ======================================================================
 * Click on a folder shelf row reveals AND expands the folder (0.8.0):
 * `revealInFolder` alone only expands
 * ANCESTORS, leaving the
 * target folder itself exactly as collapsed as it already was.
 * ==================================================================== */

test('revealEntityCandidate (0.8.0): a folder candidate reveals AND expands itself via the tree item\'s own setCollapsed(false, false)', () => {
  const { plugin, view, bucket } = makeFolderShelfFixture();
  const calls = [];
  view.fileItems[bucket.path] = { file: bucket, setCollapsed: (...args) => calls.push(args) };

  revealEntityCandidate(plugin, { kind: 'folder', target: bucket });

  assert.equal(view._revealed, bucket);
  assert.deepEqual(calls, [[false, false]]);
});

test('shelf row click (0.8.0): a folder row\'s real click end to end reveals AND expands the folder', () => {
  const { plugin, view, rootEl, bucket } = makeFolderShelfFixture();
  const calls = [];
  view.fileItems[bucket.path] = { file: bucket, setCollapsed: (...args) => calls.push(args) };
  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  const rows = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  const row = rows.children[0];

  row._fire('click', {});

  assert.equal(view._revealed, bucket);
  assert.deepEqual(calls, [[false, false]]);
});

test('revealEntityCandidate (0.8.0): guards a folder tree item with no setCollapsed method gracefully -- no throw', () => {
  const { plugin, bucket } = makeFolderShelfFixture();
  // view.fileItems[bucket.path] intentionally left unset -- reveal must
  // not throw just because the row isn't (yet) materialized.
  assert.doesNotThrow(() => revealEntityCandidate(plugin, { kind: 'folder', target: bucket }));
});

test('revealEntityCandidate (0.8.0): a NOTE candidate never touches any tree item\'s collapse state', () => {
  const { plugin, view, stub } = makeShelfFixture();
  const calls = [];
  view.fileItems[stub.path] = { file: stub, setCollapsed: (...args) => calls.push(args) };

  revealEntityCandidate(plugin, { entityNote: stub });

  assert.equal(view._revealed, stub);
  assert.equal(plugin.app.workspace._lastOpenedFile, stub);
  assert.deepEqual(calls, [], 'a note row click must never call setCollapsed on anything');
});

/* ======================================================================
 * A revealed row lands a third of the way down the explorer (0.8.1):
 * `positionRevealedRowOneThirdDown`, queued
 * onto `plugin.app.nextFrame` right behind Obsidian's own
 * `revealInFolder` scroll, in the SAME batched frame.
 * ==================================================================== */

test('positionRevealedRowOneThirdDown: a note reveal lands the scroller at row top minus a third of the visible height', () => {
  const { plugin, view, stub } = makeShelfFixture();
  const item = { file: stub };
  view.fileItems[stub.path] = item;
  const { scrollEl, infinityScroll } = makeInfinityScrollFixture({
    rowTops: { [stub.path]: 900 },
    clientHeight: 300,
    scrollHeight: 3000,
  });
  view.tree = { infinityScroll };

  revealEntityCandidate(plugin, { entityNote: stub });
  plugin.app._runNextFrame();

  assert.equal(scrollEl.scrollTop, 900 - 300 / 3);
  assert.ok(infinityScroll.computeCalls >= 1, 'compute(true) must run before findElementTop, matching scrollIntoView\'s own preamble');
  assert.equal(infinityScroll.updateVirtualDisplayCalls, 1);
});

test('positionRevealedRowOneThirdDown: a folder reveal lands the scroller the same way, after setCollapsed(false, false)', () => {
  const { plugin, view, bucket } = makeFolderShelfFixture();
  const calls = [];
  const item = { file: bucket, setCollapsed: (...args) => calls.push(args) };
  view.fileItems[bucket.path] = item;
  const { scrollEl, infinityScroll } = makeInfinityScrollFixture({
    rowTops: { [bucket.path]: 640 },
    clientHeight: 240,
    scrollHeight: 2000,
  });
  view.tree = { infinityScroll };

  revealEntityCandidate(plugin, { kind: 'folder', target: bucket });
  plugin.app._runNextFrame();

  assert.deepEqual(calls, [[false, false]], 'the folder must already be expanded (synchronous) before the deferred scroll runs');
  assert.equal(scrollEl.scrollTop, 640 - 240 / 3);
});

test('positionRevealedRowOneThirdDown: clamps at 0 for a row near the top', () => {
  const { plugin, view, stub } = makeShelfFixture();
  view.fileItems[stub.path] = { file: stub };
  const { scrollEl, infinityScroll } = makeInfinityScrollFixture({
    rowTops: { [stub.path]: 20 }, // 20 - 300/3 (100) would go negative
    clientHeight: 300,
    scrollHeight: 3000,
  });
  view.tree = { infinityScroll };

  revealEntityCandidate(plugin, { entityNote: stub });
  plugin.app._runNextFrame();

  assert.equal(scrollEl.scrollTop, 0);
});

test('positionRevealedRowOneThirdDown: clamps at max scroll for a row near the bottom', () => {
  const { plugin, view, stub } = makeShelfFixture();
  view.fileItems[stub.path] = { file: stub };
  const { scrollEl, infinityScroll } = makeInfinityScrollFixture({
    rowTops: { [stub.path]: 2950 }, // 2950 - 100 (2850) would exceed max scroll
    clientHeight: 300,
    scrollHeight: 3000,
  });
  view.tree = { infinityScroll };

  revealEntityCandidate(plugin, { entityNote: stub });
  plugin.app._runNextFrame();

  const max = 3000 - 300; // scrollHeight - clientHeight
  assert.equal(scrollEl.scrollTop, max);
});

test('positionRevealedRowOneThirdDown: runs AFTER Obsidian\'s own revealInFolder scroll -- same nextFrame batch, later in the queue', () => {
  const { plugin, view, stub } = makeShelfFixture();
  view.fileItems[stub.path] = { file: stub };
  const { scrollEl, infinityScroll } = makeInfinityScrollFixture({
    rowTops: { [stub.path]: 900 },
    clientHeight: 300,
    scrollHeight: 3000,
  });
  view.tree = { infinityScroll };

  // Replaces the fixture's own synchronous revealInFolder with one that
  // matches Obsidian's own real shape:
  // it queues its own edge-aligned scroll via the SAME `app.nextFrame`
  // queue main.js's own positioning uses, rather than scrolling
  // synchronously. If main.js ever regressed to running its own
  // positioning BEFORE this (e.g. calling it synchronously, or through a
  // separate timer queue), Obsidian's own callback -- registered after,
  // in this test -- would win and this assertion would fail.
  Object.getPrototypeOf(view).revealInFolder = function (file) {
    this._revealed = file;
    plugin.app.nextFrame(() => {
      scrollEl.scrollTop = 9999; // a deliberately wrong, edge-aligned stand-in
    });
  };

  revealEntityCandidate(plugin, { entityNote: stub });
  plugin.app._runNextFrame();

  assert.equal(scrollEl.scrollTop, 900 - 300 / 3, 'the LATER-queued callback (this plugin\'s own) must win');
});

test('positionRevealedRowOneThirdDown: no plugin.app.nextFrame -- skips outright, no throw', () => {
  const { plugin, view, stub } = makeShelfFixture();
  view.fileItems[stub.path] = { file: stub };
  const { infinityScroll } = makeInfinityScrollFixture({ rowTops: { [stub.path]: 900 } });
  view.tree = { infinityScroll };
  delete plugin.app.nextFrame;

  assert.doesNotThrow(() => revealEntityCandidate(plugin, { entityNote: stub }));
});

test('positionRevealedRowOneThirdDown: no view.tree.infinityScroll -- skips outright, no throw', () => {
  const { plugin, stub } = makeShelfFixture();
  assert.doesNotThrow(() => {
    revealEntityCandidate(plugin, { entityNote: stub });
    plugin.app._runNextFrame();
  });
});

test('positionRevealedRowOneThirdDown: the row is not (yet) materialized in view.fileItems -- skips outright, no throw', () => {
  const { plugin, view, stub } = makeShelfFixture();
  const { infinityScroll } = makeInfinityScrollFixture({ rowTops: { [stub.path]: 900 } });
  view.tree = { infinityScroll };
  // view.fileItems[stub.path] intentionally left unset.
  assert.doesNotThrow(() => {
    revealEntityCandidate(plugin, { entityNote: stub });
    plugin.app._runNextFrame();
  });
});

test('positionRevealedRowOneThirdDown: a plugin torn down before the deferred frame fires never touches the scroller', () => {
  const { plugin, view, stub } = makeShelfFixture();
  view.fileItems[stub.path] = { file: stub };
  const { scrollEl, infinityScroll } = makeInfinityScrollFixture({ rowTops: { [stub.path]: 900 } });
  view.tree = { infinityScroll };

  revealEntityCandidate(plugin, { entityNote: stub });
  plugin._unloaded = true;
  plugin.app._runNextFrame();

  assert.equal(scrollEl.scrollTop, 0, 'untouched -- the fixture default, never the computed target');
});

test('positionRevealedRowOneThirdDown: findElementTop returning null (item not yet in the virtual tree) skips the scrollTop write', () => {
  const { plugin, view, stub } = makeShelfFixture();
  view.fileItems[stub.path] = { file: stub };
  const { scrollEl, infinityScroll } = makeInfinityScrollFixture({ rowTops: {} }); // no entry -> findElementTop returns null
  scrollEl.scrollTop = 55;
  view.tree = { infinityScroll };

  revealEntityCandidate(plugin, { entityNote: stub });
  plugin.app._runNextFrame();

  assert.equal(scrollEl.scrollTop, 55, 'left exactly as it was -- never overwritten with NaN');
});

/* ======================================================================
 * A carrier folder is starrable too, alongside its stub note (0.9.0) --
 * under a root's own
 * `spotlightFolders` toggle, EVERY grouping folder is a `kind: 'folder'`
 * candidate now, including a carrier folder: two independent stars, two
 * independent rows.
 * ==================================================================== */

/** A single-root fixture whose one entity is itself a carrier folder
 * directly under the root (no intervening plain bucket) -- the shape
 * this adds a second candidate to. */
function makeCarrierFolderShelfFixture({ starredPaths = [] } = {}) {
  const stub = makeFile('Workspace/Workstreams/Client/Client.md', { content: '---\nspotlight: true\n---\n' });
  const carrier = makeFolder('Workspace/Workstreams/Client', [stub]);
  const root = makeFolder('Workspace', [carrier]);
  const files = { [stub.path]: stub._content };

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

  const app = makeApp({ folders: [root, carrier], files });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.settings = {
    roots: [{ path: 'Workspace', enabled: true, spotlightFolders: true }],
    collapsedShelfRoots: [],
    starredPaths,
  };
  plugin.explorerView = view;
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => renderAllShelves(plugin);
  return { plugin, view, rootEl, carrier, stub };
}

test('renderAllShelves: a carrier folder\'s own folder-star (starredPaths) AND its stub note\'s own star (frontmatter) are independent -- both on shows two rows, the folder row carrying the folder icon, the note row plain', () => {
  const { plugin, rootEl, carrier, stub } = makeCarrierFolderShelfFixture({ starredPaths: [] });
  // The carrier folder's own star -- a data.json entry, added directly
  // (mirrors what setFolderStarred would persist), never derived from
  // the note's own frontmatter.
  plugin.settings.starredPaths = [carrier.path];

  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  assert.ok(shelf, 'both stars on -- a shelf renders');
  const rows = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  assert.equal(rows.children.length, 2, 'the carrier folder\'s own row AND its stub note\'s own row, both shown, never collapsed into one');

  const folderRow = Array.from(rows.children).find((r) => r.getAttribute('data-spotlight-shelf-path') === carrier.path);
  const noteRow = Array.from(rows.children).find((r) => r.getAttribute('data-spotlight-shelf-path') === stub.path);
  assert.ok(folderRow, 'the carrier folder\'s own kind: folder row, keyed by the FOLDER\'s own path');
  assert.ok(noteRow, 'the stub note\'s own kind: carrier row, keyed by the NOTE\'s own path -- a different identity');

  const folderIcon = Array.from(folderRow.children).find((c) => c.classList.contains('spotlight-shelf-folder-icon'));
  assert.ok(folderIcon, 'the folder row carries the folder icon, same as any other folder candidate');
  const noteIcon = Array.from(noteRow.children).find((c) => c.classList.contains('spotlight-shelf-folder-icon'));
  assert.equal(noteIcon, undefined, 'the note row never does');
});

test('renderAllShelves: only the carrier folder starred (its note not) -- one row, the folder row', () => {
  const { plugin, rootEl, carrier, stub } = makeCarrierFolderShelfFixture({ starredPaths: [] });
  plugin.settings.starredPaths = [carrier.path];
  // stub's own frontmatter has no `spotlight: true` this time (mutating
  // the fixture file's own `_content` directly -- the metadataCache
  // stub reads THAT over `vault._files` whenever it's set, matching how
  // `makeFile`'s own initial content is read everywhere else in this
  // suite).
  stub._content = '---\n---\n';

  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  const rows = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  assert.equal(rows.children.length, 1);
  assert.equal(rows.children[0].getAttribute('data-spotlight-shelf-path'), carrier.path);
});

test('renderAllShelves (regression): spotlightFolders OFF -- a carrier folder\'s own starredPaths entry is simply never read; only its note\'s own star can ever show', () => {
  const { plugin, rootEl, carrier, stub } = makeCarrierFolderShelfFixture();
  plugin.settings.starredPaths = [carrier.path];
  plugin.settings.roots[0].spotlightFolders = false; // the toggle off -- byte-identical to 0.8.1

  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  assert.ok(shelf, 'the note is still starred, so a shelf still renders');
  const rows = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  assert.equal(rows.children.length, 1, 'the folder\'s own starredPaths entry is never surfaced with the toggle off');
  assert.equal(rows.children[0].getAttribute('data-spotlight-shelf-path'), stub.path);
});

test('renderAllShelves: a carrier folder\'s own folder-star and its stub note\'s own star, reachable from two overlapping ENABLED roots, dedupe INDEPENDENTLY -- a folder path and a note path are different candidate identities, neither collapses into or suppresses the other', () => {
  const stub = makeFile('Projects/client/Cardboard Alchemy/Cardboard Alchemy.md', { content: '---\ntype: project\nspotlight: true\n---\n' });
  const carrier = makeFolder('Projects/client/Cardboard Alchemy', [stub]);
  const client = makeFolder('Projects/client', [carrier]);
  const projects = makeFolder('Projects', [client]);
  const app = makeApp({ folders: [projects, client, carrier], files: { [stub.path]: stub._content } });

  const projectsEl = makeFakeElement('div');
  const projectsChildrenEl = makeFakeElement('div');
  projectsEl.appendChild(projectsChildrenEl);
  const clientEl = makeFakeElement('div');
  const clientChildrenEl = makeFakeElement('div');
  clientEl.appendChild(clientChildrenEl);
  const containerEl = makeFakeElement('div');
  containerEl.appendChild(projectsEl);
  containerEl.appendChild(clientEl);

  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.settings = {
    roots: [
      { path: 'Projects', enabled: true, spotlightFolders: true },
      { path: 'Projects/client', enabled: true, spotlightFolders: true },
    ],
    collapsedShelfRoots: [],
    starredPaths: [carrier.path], // the carrier FOLDER's own star, reachable via either root
  };
  plugin.explorerView = {
    fileItems: {
      Projects: { file: projects, el: projectsEl, childrenEl: projectsChildrenEl },
      'Projects/client': { file: client, el: clientEl, childrenEl: clientChildrenEl },
    },
    containerEl,
  };

  renderAllShelves(plugin);

  const onProjects = projectsEl.querySelector(':scope > .spotlight-shelf');
  const onClient = clientEl.querySelector(':scope > .spotlight-shelf');
  assert.ok(onProjects, 'the outermost enabled root still owns the branch\'s one shelf');
  assert.equal(onClient, null, 'the nested root still draws none of its own');

  const rows = Array.from(onProjects.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  // The carrier folder's own row (starred via starredPaths) AND its stub
  // note's own row (starred via frontmatter) BOTH appear, exactly once
  // each -- never doubled by being reachable through two overlapping
  // roots, and never collapsed into ONE row by treating the folder path
  // and the note path as the same identity.
  assert.equal(rows.children.length, 2);
  const paths = Array.from(rows.children)
    .map((r) => r.getAttribute('data-spotlight-shelf-path'))
    .sort();
  assert.deepEqual(paths, [carrier.path, stub.path].sort());
});

/* ========================================================================
 * 0.10.0: every file under a root is
 * starrable -- a non-`.md` file directly under a root, or inside a PLAIN
 * (non-carrier) folder beneath it, is a `kind: 'file'` candidate,
 * unconditionally, never gated on `spotlightFolders` the way a folder
 * candidate is. `findEntityCandidates`'s own discovery-layer gates
 * (candidate at all vs. not, area-gate bypass, carrier exclusion) are
 * covered in spotlight.test.mjs; this section covers the explorer-facing
 * surface: the context menu, the inline star, the shelf row's title/icon,
 * the open route, and the rename/delete listeners.
 * ==================================================================== */

/** A plain (non-carrier) root holding one PNG directly and one PNG two
 * levels down inside a bucket folder -- both are candidates, at any
 * depth, with NO `spotlightFolders` toggle needed (default `false`,
 * proving files are unconditional, unlike a folder candidate). */
function makeFileModeFixture({ starredPaths = [] } = {}) {
  const cover = makeFile('Workspace/cover.png');
  const deepAsset = makeFile('Workspace/Bucket/Sub/diagram.png');
  const sub = makeFolder('Workspace/Bucket/Sub', [deepAsset]);
  const bucket = makeFolder('Workspace/Bucket', [sub]);
  const root = makeFolder('Workspace', [cover, bucket]);

  const coverTitleEl = makeFakeElement('div');
  const deepAssetTitleEl = makeFakeElement('div');
  class FakeExplorerView {}
  FakeExplorerView.prototype.requestSort = function () {};
  FakeExplorerView.prototype.getSortedFolderItems = makeFileItemsSortedFolderItems();
  const view = new FakeExplorerView();
  view.fileItems = {
    [cover.path]: { file: cover, selfEl: coverTitleEl },
    [deepAsset.path]: { file: deepAsset, selfEl: deepAssetTitleEl },
  };
  view.containerEl = makeFakeElement('div');
  const leaf = { view, loadIfDeferred: async () => {} };

  const app = makeApp({ folders: [root, bucket, sub], leaves: [leaf] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  // spotlightFolders left at its default (false) throughout this fixture
  // ON PURPOSE -- a file candidate must resolve even when folder mode is
  // off, proving the two are genuinely independent.
  plugin.saved = { roots: [{ path: 'Workspace', enabled: true }], starredPaths };
  return { plugin, app, root, cover, coverTitleEl, bucket, sub, deepAsset, deepAssetTitleEl };
}

test('resolveSpotlightTarget (0.10.0): a non-.md file resolves as kind: "file" with spotlightFolders OFF (default) -- unconditional, no toggle needed', async () => {
  const { plugin, cover, deepAsset } = makeFileModeFixture();
  await plugin.onload();
  await plugin.explorerReady;
  const found = resolveSpotlightTarget(plugin, cover);
  assert.equal(found.kind, 'file');
  assert.equal(found.target, cover);

  const foundDeep = resolveSpotlightTarget(plugin, deepAsset);
  assert.equal(foundDeep.kind, 'file');
  assert.equal(foundDeep.target, deepAsset);
});

test('addSpotlightMenuItem (0.10.0): a non-.md file\'s file-menu gets "Spotlight this"; clicking it stars the file through the path store', async () => {
  const { plugin, cover } = makeFileModeFixture();
  await plugin.onload();
  await plugin.explorerReady;
  const menu = makeMenu();
  addSpotlightMenuItem(plugin, menu, cover);
  assert.equal(menu.items.length, 1);
  assert.equal(menu.items[0].title, 'Spotlight this');
  await menu.items[0].clickHandler();
  assert.equal(isPathStarred(plugin, cover.path), true);
});

test('reapplyStars (0.10.0): a non-.md file\'s row gets a star with spotlightFolders OFF (default) -- unconditional, at any depth', async () => {
  const { plugin, coverTitleEl, deepAssetTitleEl } = makeFileModeFixture();
  await plugin.onload();
  await plugin.explorerReady;
  assert.ok(coverTitleEl.querySelector(':scope > .spotlight-star'), 'a file directly under the root gets a star');
  assert.ok(deepAssetTitleEl.querySelector(':scope > .spotlight-star'), 'a file two levels down inside a plain bucket folder gets one too');
});

test('handleStarActivate (0.10.0): a trusted click on a file row\'s star toggles it through the path store, never a note\'s frontmatter', async () => {
  const { plugin, cover, coverTitleEl } = makeFileModeFixture();
  await plugin.onload();
  await plugin.explorerReady;
  const star = coverTitleEl.querySelector(':scope > .spotlight-star');
  assert.equal(star.classList.contains('is-on'), false);
  const evt = makeFakeEvent({ isTrusted: true });
  await handleStarActivate(plugin, coverTitleEl, star, evt);
  assert.equal(isPathStarred(plugin, cover.path), true);
  assert.equal(star.classList.contains('is-on'), true);
});

test('registerRowInjectionEvents (0.10.0): a vault rename rewrites a starred FILE\'s own stored path; a vault delete drops it, leaving an unrelated stored path untouched', async () => {
  const coverPath = 'Workspace/cover.png';
  const { plugin, cover } = makeFileModeFixture({ starredPaths: [coverPath, 'Unrelated'] });
  assert.equal(cover.path, coverPath);
  await plugin.onload();
  await plugin.explorerReady;

  plugin.app.vault._emit('rename', { path: 'Workspace/renamed-cover.png' }, cover.path);
  assert.deepEqual([...plugin.settings.starredPaths].sort(), ['Workspace/renamed-cover.png', 'Unrelated'].sort());

  plugin.app.vault._emit('delete', { path: 'Workspace/renamed-cover.png' });
  assert.deepEqual(plugin.settings.starredPaths, ['Unrelated']);
});

/* ======================================================================
 * f4r: a configured
 * root's own path in settings FOLLOWS a rename or an ancestor rename,
 * and its per-root state (collapsedShelfRoots, collapsedBranchRoots)
 * follows with it; a deleted root (or a deleted ancestor) drops
 * cleanly, no stuck hidden state; a rename that would nest one root
 * inside/around another is refused, sensibly, per the SAME collision
 * rule the settings tab already enforces on an add/edit.
 * ==================================================================== */

function makeRootRenameFixture({ roots, collapsedShelfRoots = [], collapsedBranchRoots = [], starredPaths = [] } = {}) {
  const app = makeApp({});
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.saved = { roots, collapsedShelfRoots, collapsedBranchRoots, starredPaths };
  return { plugin, app };
}

test('registerRowInjectionEvents: a configured root renamed directly -- its own settings.roots path, collapsedShelfRoots and collapsedBranchRoots entries all follow', async () => {
  const { plugin } = makeRootRenameFixture({
    roots: [{ path: 'Workspace', enabled: true, spotlightFolders: false }],
    collapsedShelfRoots: ['Workspace'],
    collapsedBranchRoots: ['Workspace'],
  });
  await plugin.onload();
  await plugin.explorerReady;

  plugin.app.vault._emit('rename', { path: 'Workspace Renamed' }, 'Workspace');

  assert.deepEqual(plugin.settings.roots.map((r) => r.path), ['Workspace Renamed']);
  assert.deepEqual(plugin.settings.collapsedShelfRoots, ['Workspace Renamed']);
  assert.deepEqual(plugin.settings.collapsedBranchRoots, ['Workspace Renamed']);
});

test('registerRowInjectionEvents: an ANCESTOR of a configured root is renamed -- the root\'s own (nested) path follows the prefix rewrite, same for its hidden state', async () => {
  const { plugin } = makeRootRenameFixture({
    roots: [{ path: 'Projects/client/Cardboard Alchemy', enabled: true }],
    collapsedBranchRoots: ['Projects/client/Cardboard Alchemy'],
  });
  await plugin.onload();
  await plugin.explorerReady;

  // The ANCESTOR 'Projects/client' is what actually got renamed -- the
  // root itself, two levels further down, is never renamed directly.
  plugin.app.vault._emit('rename', { path: 'Projects/renamed-client' }, 'Projects/client');

  assert.deepEqual(plugin.settings.roots.map((r) => r.path), ['Projects/renamed-client/Cardboard Alchemy']);
  assert.deepEqual(plugin.settings.collapsedBranchRoots, ['Projects/renamed-client/Cardboard Alchemy']);
});

test('registerRowInjectionEvents: a root MOVED to a different parent entirely -- the same rename event shape, the same follow', async () => {
  const { plugin } = makeRootRenameFixture({ roots: [{ path: 'Workspace', enabled: true }] });
  await plugin.onload();
  await plugin.explorerReady;

  plugin.app.vault._emit('rename', { path: 'Archive/Workspace' }, 'Workspace');

  assert.deepEqual(plugin.settings.roots.map((r) => r.path), ['Archive/Workspace']);
});

test('registerRowInjectionEvents: a configured root DELETED -- clean removal from roots, collapsedShelfRoots and collapsedBranchRoots, no stuck hidden state; an unrelated root is untouched', async () => {
  const { plugin } = makeRootRenameFixture({
    roots: [
      { path: 'Workspace', enabled: true },
      { path: 'Goals', enabled: true },
    ],
    collapsedShelfRoots: ['Workspace'],
    collapsedBranchRoots: ['Workspace'],
  });
  await plugin.onload();
  await plugin.explorerReady;

  plugin.app.vault._emit('delete', { path: 'Workspace' });

  assert.deepEqual(plugin.settings.roots.map((r) => r.path), ['Goals'], 'the deleted root is gone; the unrelated one is untouched');
  assert.deepEqual(plugin.settings.collapsedShelfRoots, []);
  assert.deepEqual(plugin.settings.collapsedBranchRoots, []);
});

test('registerRowInjectionEvents: an ANCESTOR of a configured root is deleted -- the root drops too, cleanly, no stuck hidden state', async () => {
  const { plugin } = makeRootRenameFixture({
    roots: [{ path: 'Projects/client/Cardboard Alchemy', enabled: true }],
    collapsedBranchRoots: ['Projects/client/Cardboard Alchemy'],
  });
  await plugin.onload();
  await plugin.explorerReady;

  plugin.app.vault._emit('delete', { path: 'Projects/client' });

  assert.deepEqual(plugin.settings.roots, []);
  assert.deepEqual(plugin.settings.collapsedBranchRoots, []);
});

test('registerRowInjectionEvents: a rename that would nest one root inside/around another is refused -- the moved root stays at its old (now-missing) path; the untouched root is unaffected', async () => {
  const { plugin } = makeRootRenameFixture({
    roots: [
      { path: 'Projects/client', enabled: true },
      { path: 'Work', enabled: true },
    ],
  });
  await plugin.onload();
  await plugin.explorerReady;

  // Renaming the ANCESTOR 'Projects' to 'Work' would move the first root
  // to 'Work/client' -- nested inside the second, already-configured
  // root 'Work'. The vault rename itself already happened (this plugin
  // cannot undo a member's own file-system action); only the SETTINGS
  // follow is refused, the same collision rule the settings tab already
  // enforces on an add/edit.
  //
  // A console.warn spy, not just the unchanged-roots assertion below --
  // "nothing changed" is also exactly what a build with NO such mechanism
  // at all would produce, so the warn is what actually proves the
  // refusal branch ran, rather than the feature simply being absent.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    plugin.app.vault._emit('rename', { path: 'Work' }, 'Projects');
  } finally {
    console.warn = realWarn;
  }
  assert.ok(warnings.some((w) => w.includes('root rename refused')), 'the refusal branch actually ran and said why');

  assert.deepEqual(
    plugin.settings.roots.map((r) => r.path).sort(),
    ['Projects/client', 'Work'].sort(),
    'the colliding root refuses the rename and stays at its old (now-missing) path; the untouched root is unaffected',
  );
});

/** A shelf fixture with one starred FILE candidate (via starredPaths,
 * the same store a folder candidate uses) directly under a plain root --
 * mirrors makeFolderShelfFixture, swapping the starred grouping folder
 * for a starred PNG. */
function makeFileShelfFixture({ extension = 'png' } = {}) {
  const asset = makeFile(`Workspace/cover.${extension}`);
  const root = makeFolder('Workspace', [asset]);

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

  const app = makeApp({ folders: [root] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.settings = {
    roots: [{ path: 'Workspace', enabled: true }],
    collapsedShelfRoots: [],
    starredPaths: [asset.path],
  };
  plugin.explorerView = view;
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => renderAllShelves(plugin);
  return { plugin, view, rootEl, asset };
}

test('shelf row (0.10.0): a FILE row shows the name WITH extension and its own file-kind icon, between the star and the title', () => {
  const { plugin, rootEl, asset } = makeFileShelfFixture({ extension: 'png' });
  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  const rows = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  const row = rows.children[0];
  assert.equal(row.getAttribute('data-spotlight-shelf-path'), asset.path);

  const children = Array.from(row.children);
  assert.equal(children.length, 3, 'star, file icon, title');
  assert.ok(children[0].classList.contains('spotlight-shelf-star'));
  assert.ok(children[1].classList.contains('spotlight-shelf-file-icon'));
  assert.equal(children[1].getAttribute('data-icon'), 'image');
  assert.ok(children[2].classList.contains('spotlight-shelf-title'));
  // WITH extension -- a note row shows the basename, a file row shows the
  // real file name, so two files differing only by extension stay
  // distinct.
  assert.equal(children[2].textContent, 'cover.png');
});

function findFileIconInShelf(rootEl) {
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  const rows = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  const row = rows.children[0];
  return Array.from(row.children).find((c) => c.classList.contains('spotlight-shelf-file-icon'));
}

test('shelf row (0.10.0): the file icon follows the extension -- audio gets file-audio, an unknown/other extension gets file-text', () => {
  const audio = makeFileShelfFixture({ extension: 'mp3' });
  renderAllShelves(audio.plugin);
  assert.equal(findFileIconInShelf(audio.rootEl).getAttribute('data-icon'), 'file-audio');

  const base = makeFileShelfFixture({ extension: 'base' });
  renderAllShelves(base.plugin);
  assert.equal(findFileIconInShelf(base.rootEl).getAttribute('data-icon'), 'file-text');
});

test('revealEntityCandidate (0.10.0): a FILE candidate reveals via view.revealInFolder, then opens via leaf.openFile -- the EXACT call Obsidian\'s own explorer row click makes, never setCollapsed', () => {
  const { plugin, view, asset } = makeFileShelfFixture();
  revealEntityCandidate(plugin, { kind: 'file', target: asset });
  assert.equal(view._revealed, asset);
  // `leaf.openFile(candidateNode(candidate))` -- the SAME call a note
  // candidate goes through. main.js does not re-implement Obsidian's own
  // viewable-vs-default-app split (WorkspaceLeaf.prototype.openFile's own
  // `viewRegistry.getTypeByExtension` / `app.openWithDefaultApp` branch:
  // it hands the TFile to
  // the exact primitive that split already lives inside, for a note and
  // a file alike.
  assert.equal(plugin.app.workspace._lastOpenedFile, asset);
});

test('shelf row click (0.10.0): a file row\'s real click end to end reveals then opens it, via the same leaf.openFile route', () => {
  const { plugin, view, rootEl, asset } = makeFileShelfFixture();
  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  const rows = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  const row = rows.children[0];

  row._fire('click', {});

  assert.equal(view._revealed, asset);
  assert.equal(plugin.app.workspace._lastOpenedFile, asset);
});

test('unstarShelfEntity (0.10.0): un-spotlights a file candidate through the path store and removes it from the shelf', async () => {
  const { plugin, rootEl, asset } = makeFileShelfFixture();
  renderAllShelves(plugin);
  assert.ok(rootEl.querySelector(':scope > .spotlight-shelf'));

  await unstarShelfEntity(plugin, { kind: 'file', target: asset });

  assert.equal(isPathStarred(plugin, asset.path), false);
  assert.equal(rootEl.querySelector(':scope > .spotlight-shelf'), null);
});

test('settings tab (0.10.0): "N found, M starred" on a plain root counts file candidates too', async () => {
  const { plugin, cover } = makeFileModeFixture({ starredPaths: [] });
  await plugin.onload();
  await plugin.explorerReady;
  const counts = plugin.computeRootCounts(plugin.settings.roots[0]);
  assert.equal(counts.found, 2, 'cover.png and Bucket/Sub/diagram.png');
  assert.equal(counts.starred, 0);

  plugin.settings.starredPaths = [cover.path];
  const countsAfter = plugin.computeRootCounts(plugin.settings.roots[0]);
  assert.equal(countsAfter.starred, 1);
});

/* ========================================================================
 * 0.11.0: the GL-063 carrier rule leaves
 * the plugin entirely. "Since we flattened everything, didn't we do away
 * with the convention that a folder has to have a stubfile of the same
 * name? So if there's a file with the same name as the folder, it's not
 * neccessarily representative of that folder, it just is contained by it
 * and happens to have the same name." A folder that shares its name with
 * a note is now an ordinary folder candidate; the note is an ordinary
 * flat candidate; both may star and shelve independently. The pair
 * itself was already covered end to end by the c4n-era fixtures above
 * (`makeFolderModeFixture`/`makeCarrierFolderShelfFixture`), which still
 * pass unchanged since the underlying mechanism never special-cased
 * `kind` at any of those call sites -- the two tests below are the
 * dedicated 0.11.0 proofs the brief asked for: the pair on the shelf
 * together, named without carrier terminology, and the migration
 * guarantee that a note starred under the old model keeps its star.
 * ==================================================================== */

test('renderAllShelves: a folder and its same-named note both starred both sit on the shelf as two independent rows, the folder icon telling them apart', () => {
  const stub = makeFile('Workspace/Workstreams/Client/Client.md', { content: '---\nspotlight: true\n---\n' });
  const sameNamedFolder = makeFolder('Workspace/Workstreams/Client', [stub]);
  const root = makeFolder('Workspace', [sameNamedFolder]);
  const files = { [stub.path]: stub._content };

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

  const app = makeApp({ folders: [root, sameNamedFolder], files });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.settings = {
    roots: [{ path: 'Workspace', enabled: true, spotlightFolders: true }],
    collapsedShelfRoots: [],
    starredPaths: [sameNamedFolder.path], // the folder's own star, independent of the note's frontmatter star
  };
  plugin.explorerView = view;

  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  assert.ok(shelf, 'both the folder star and the note star are on -- a shelf renders');
  const rows = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  assert.equal(rows.children.length, 2, 'the folder\'s own row AND the note\'s own row, both shown, never collapsed into one');

  const folderRow = Array.from(rows.children).find((r) => r.getAttribute('data-spotlight-shelf-path') === sameNamedFolder.path);
  const noteRow = Array.from(rows.children).find((r) => r.getAttribute('data-spotlight-shelf-path') === stub.path);
  assert.ok(folderRow, 'the folder\'s own kind: folder row, keyed by the FOLDER\'s own path');
  assert.ok(noteRow, 'the note\'s own kind: flat row, keyed by the NOTE\'s own path -- a different identity');

  const folderIcon = Array.from(folderRow.children).find((c) => c.classList.contains('spotlight-shelf-folder-icon'));
  assert.ok(folderIcon, 'the folder row carries the folder icon');
  const noteIcon = Array.from(noteRow.children).find((c) => c.classList.contains('spotlight-shelf-folder-icon'));
  assert.equal(noteIcon, undefined, 'the note row never does -- the icon is what tells the pair apart now, not a borrowed name');

  // The note's title is its own plain basename -- the retired
  // `kind === 'carrier'` branch used to show the PARENT folder's name
  // here instead; that branch is gone.
  const noteTitle = Array.from(noteRow.children).find((c) => c.classList.contains('spotlight-shelf-title'));
  assert.equal(noteTitle.textContent, 'Client');
});

test('migration: a note starred under the old model (kind: "carrier" as of 0.10.0) keeps spotlight: true and its shelf row survives reclassification to kind: "flat", no data.json write, no frontmatter write', async () => {
  const stub = makeFile('Workspace/Workstreams/Client/Client.md', { content: '---\nspotlight: true\n---\n' });
  const sameNamedFolder = makeFolder('Workspace/Workstreams/Client', [stub]);
  const root = makeFolder('Workspace', [sameNamedFolder]);
  const files = { [stub.path]: stub._content };
  const app = makeApp({ folders: [root, sameNamedFolder], files });
  const { PluginClass, __test } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.saved = { roots: [{ path: 'Workspace', enabled: true }] };

  // Before this build, findEntityCandidates would have classified this
  // note as kind: 'carrier' (its folder's own name matches). Confirm the
  // NEW classification is 'flat' -- proving the reclassification itself,
  // not assuming it.
  const candidates = __test.findEntityCandidates(root, {});
  assert.deepEqual(candidates, [{ kind: 'flat', entityNote: stub }]);

  await plugin.onload();
  await plugin.explorerReady;

  // The star survives: still reads true straight off the note's own
  // frontmatter, the exact storage layer 'flat' and 'carrier' always
  // shared -- nothing about this note's own file content changed.
  assert.equal(__test.getSpotlightState(plugin.app, stub), true);
  assert.equal(stub._content, '---\nspotlight: true\n---\n', 'no write happened to reclassify it');

  // The shelf row survives too, built from the SAME candidate, now
  // labeled 'flat'.
  const found = resolveSpotlightTarget(plugin, stub);
  assert.equal(found.kind, 'flat');
  assert.equal(getCandidateStarState(plugin, found), true);
});

/* ======================================================================
 * The branch toggle -- a tab hanging off the shelf's own
 * bottom stroke line hides/shows everything BELOW the shelf (the real
 * branch), leaving the shelf's own starred rows in view. A platform
 * review of the design supplies the numbered conditions cited below.
 * ==================================================================== */

/** A bare `invalidate` spy -- `view.tree.infinityScroll` shaped just
 * enough for `applyBranchHiddenDomState`/`reapplyBranchHiddenState` to run
 * against. Deliberately does NOT also implement
 * `compute`/`findElementTop`/`updateVirtualDisplay` -- those are guarded
 * by their own `typeof === 'function'` checks in
 * `positionRevealedRowOneThirdDown`, which this fixture never needs to
 * exercise. */
function makeInvalidateSpy() {
  const calls = [];
  return { calls, invalidate: (item, force) => calls.push({ path: item && item.file && item.file.path, force: !!force }) };
}

/** Extends `makeShelfFixture()`'s one starred NOTE root with an
 * `invalidate` spy already wired onto `view.tree.infinityScroll`, and an
 * optional `collapsedBranchRoots` seed. */
function makeBranchToggleFixture({ collapsedBranchRoots = [] } = {}) {
  const fixture = makeShelfFixture();
  const { invalidate, calls } = makeInvalidateSpy();
  fixture.view.tree = { infinityScroll: { invalidate } };
  fixture.plugin.settings.collapsedBranchRoots = collapsedBranchRoots.slice();
  fixture.invalidateCalls = calls;
  fixture.rootEntry = fixture.plugin.settings.roots[0];
  return fixture;
}

test('renderShelfForRoot: the branch toggle renders only when the shelf itself renders -- nothing starred, no band, same as no shelf', () => {
  const stub = makeFile('Goals/A.md', { content: '---\ntype: goal\n---\n' }); // no spotlight: true
  const root = makeFolder('Goals', [stub]);
  const rootEl = makeFakeElement('div');
  const rootChildrenEl = makeFakeElement('div');
  rootEl.appendChild(rootChildrenEl);
  const app = makeApp({ folders: [root], files: { [stub.path]: stub._content } });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [{ path: 'Goals', enabled: true }], collapsedShelfRoots: [], collapsedBranchRoots: [] };
  plugin.explorerView = { fileItems: { Goals: { file: root, el: rootEl, childrenEl: rootChildrenEl } } };

  renderAllShelves(plugin);
  assert.equal(rootEl.querySelector(':scope > .spotlight-shelf'), null);
  assert.equal(rootEl.querySelector(':scope > .spotlight-branch-toggle'), null);
});

test('renderShelfForRoot: the toggle renders alongside the shelf, defaults to showing (chevron-up, aria-expanded true)', () => {
  const { plugin, rootEl } = makeBranchToggleFixture();
  renderAllShelves(plugin);
  const toggle = rootEl.querySelector(':scope > .spotlight-branch-toggle');
  assert.ok(toggle);
  assert.equal(toggle.getAttribute('role'), 'button');
  assert.equal(toggle.getAttribute('tabindex'), '0');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.getAttribute('aria-label'), 'Hide everything below the shelf');
  assert.equal(toggle.classList.contains('is-hidden'), false);
  const tab = toggle.querySelector(':scope > .spotlight-branch-toggle-tab');
  assert.ok(tab);
  assert.equal(tab.getAttribute('data-icon'), 'chevron-up');
});

test('renderShelfForRoot: a root already in collapsedBranchRoots renders the toggle pre-hidden (chevron-down, aria-expanded false) and item.el already carries spotlight-branch-hidden', () => {
  const { plugin, rootEl, rootEntry } = makeBranchToggleFixture({ collapsedBranchRoots: ['04 Inner World/My Life/Projects'] });
  renderAllShelves(plugin);
  const toggle = rootEl.querySelector(':scope > .spotlight-branch-toggle');
  assert.equal(toggle.classList.contains('is-hidden'), true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-label'), 'Show everything below the shelf');
  const tab = toggle.querySelector(':scope > .spotlight-branch-toggle-tab');
  assert.equal(tab.getAttribute('data-icon'), 'chevron-down');
  assert.equal(rootEl.classList.contains('spotlight-branch-hidden'), true, 'the class lands on item.el');
});

test('renderShelfForRoot: the shelf header itself gets an aria-label too, per the design spec', () => {
  const { plugin, rootEl } = makeBranchToggleFixture();
  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  const header = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-header'));
  assert.equal(header.getAttribute('aria-label'), 'Collapse Spotlight list');
  header._fire('click', {});
  assert.equal(header.getAttribute('aria-label'), 'Expand Spotlight list');
});

test('renderShelfForRoot: no band at all for a root whose path normalizes to the vault root', () => {
  const stub = makeFile('client.md', { content: '---\ntype: project\nspotlight: true\n---\n' });
  const root = makeFolder('', [stub]);
  const rootEl = makeFakeElement('div');
  const rootChildrenEl = makeFakeElement('div');
  rootEl.appendChild(rootChildrenEl);
  const app = makeApp({ folders: [root], files: { [stub.path]: stub._content } });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [{ path: '', enabled: true }], collapsedShelfRoots: [], collapsedBranchRoots: [] };
  plugin.explorerView = { fileItems: { '': { file: root, el: rootEl, childrenEl: rootChildrenEl } } };

  renderAllShelves(plugin);
  assert.ok(rootEl.querySelector(':scope > .spotlight-shelf'), 'the shelf itself still renders');
  assert.equal(rootEl.querySelector(':scope > .spotlight-branch-toggle'), null, 'but no band -- the vault root can never be branch-hidden');
  assert.equal(rootEl.classList.contains('has-branch-toggle'), false);
});

test('branch toggle click: hides the branch -- item.el gets spotlight-branch-hidden, invalidate(item,true) THEN invalidate(item), band flips to chevron-down/is-hidden, persisted', async () => {
  const { plugin, rootEl, invalidateCalls, rootEntry } = makeBranchToggleFixture();
  renderAllShelves(plugin);
  const toggle = rootEl.querySelector(':scope > .spotlight-branch-toggle');
  // 0.13.6: the initial build above now
  // ALSO invalidates item's height once, for the freshly-created shelf
  // itself (see `invalidateItemHeight`'s own doc comment, tested on its
  // own further down) -- cleared here so this test still isolates only
  // the CLICK's own invalidate(item,true)/invalidate(item) pair.
  invalidateCalls.length = 0;

  toggle._fire('click', {});
  // main.js's own handler fires plugin.setBranchHidden(...) unawaited --
  // let its microtask settle before asserting the persisted write.
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(rootEl.classList.contains('spotlight-branch-hidden'), true);
  assert.equal(toggle.classList.contains('is-hidden'), true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  const tab = toggle.querySelector(':scope > .spotlight-branch-toggle-tab');
  assert.equal(tab.getAttribute('data-icon'), 'chevron-down');
  assert.deepEqual(invalidateCalls, [
    { path: rootEntry.path, force: true },
    { path: rootEntry.path, force: false },
  ]);
  assert.deepEqual(plugin.settings.collapsedBranchRoots, [rootEntry.path]);
  assert.deepEqual(plugin.saved.collapsedBranchRoots, [rootEntry.path], 'actually persisted through saveData, not just in memory');
});

/* ======================================================================
 * 0.13.6 ("scrolling the file explorer
 * with several shelf directories open... a white flash, then everything
 * under 'Goals' disappeared... seen on previous reviews too"). Root
 * cause, confirmed by an exhaustive audit of every `infinityScroll.
 * invalidate(` call site in main.js against every DOM mutation that
 * changes `item.el`'s own rendered height: `applyBranchHiddenDomState`
 * already pairs its ONE mutation (the branch-hidden class flip) with an
 * invalidate() call, but a shelf appearing, disappearing, changing its
 * own row count, or collapsing via its own header chevron -- none of
 * these ever told `infinityScroll` at all, predating 0.13.0 entirely
 * (the shelf/collapse features are 0.4.0/0.4.1). Obsidian's own cached
 * per-row height (`item.info.height`, confirmed live via `eval` against
 * the shipped 1.13.x build) goes stale relative to the real DOM whenever
 * that happens; the staleness is invisible until a scroll pass makes
 * Obsidian's own virtualiser recycle/reposition rows using that stale
 * cumulative math -- a flash as rows reposition wrong, then a gap as
 * rows below the stale point land off-window. These tests assert
 * `invalidateItemHeight` (a single, un-paired `invalidate(item)` -- only
 * `item.el`'s own height changed, never `childrenEl`'s descendants) now
 * runs at every one of those five sites, and ONLY when a real height
 * change actually happened -- never on a pure reorder or an unconditional
 * per-pass basis (0.13.2's own hard-learned cascade lesson).
 * ==================================================================== */

test('renderShelfForRoot (0.13.6): a FRESH shelf build (no shelf existed before, now something is starred) invalidates the root item once', () => {
  const { plugin, rootEntry, invalidateCalls } = makeBranchToggleFixture();
  renderAllShelves(plugin);
  assert.deepEqual(invalidateCalls, [{ path: rootEntry.path, force: false }], 'one un-paired invalidate(item), not the hide/show pair');
});

test('renderShelfForRoot (0.13.6): the shelf transitioning to EMPTY (existing shelf removed) invalidates the root item once', () => {
  const { plugin, rootEntry, invalidateCalls, stub } = makeBranchToggleFixture();
  renderAllShelves(plugin); // builds it fresh
  invalidateCalls.length = 0;

  return setSpotlightState(plugin.app, stub, false).then(() => {
    renderAllShelves(plugin); // the only starred candidate un-starred -- shelf removed
    assert.deepEqual(invalidateCalls, [{ path: rootEntry.path, force: false }]);
  });
});

test('renderShelfForRoot (0.13.6): a signature-change reconcile pass that adds a row invalidates the root item once; a pure REORDER (same row count) never does', () => {
  const { plugin, rootEntry, invalidateCalls, flatUnstarred } = makeBranchToggleFixture();
  renderAllShelves(plugin);
  invalidateCalls.length = 0;

  // Add a second starred candidate -- the diff-in-place branch, row count
  // 1 -> 2.
  return setSpotlightState(plugin.app, flatUnstarred, true).then(() => {
    renderAllShelves(plugin);
    assert.deepEqual(invalidateCalls, [{ path: rootEntry.path, force: false }], 'a real row-count change invalidates');
    invalidateCalls.length = 0;

    // A second pass with NOTHING changed at all (same signature) hits the
    // short-circuit path entirely -- no diff, no invalidate.
    renderAllShelves(plugin);
    assert.deepEqual(invalidateCalls, [], 'unchanged signature -- the short-circuit path never invalidates');
  });
});

test('renderShelfForRoot (0.13.6): the shelf\'s OWN collapse toggle (its header chevron, 0.4.1, unrelated to the branch-hidden band) invalidates the root item', () => {
  const { plugin, rootEl, rootEntry, invalidateCalls } = makeBranchToggleFixture();
  renderAllShelves(plugin);
  invalidateCalls.length = 0;

  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  const header = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-header'));
  assert.ok(header, 'sanity: the shelf header exists');
  header._fire('click', {});

  assert.deepEqual(invalidateCalls, [{ path: rootEntry.path, force: false }]);
});

test('removeShelfForRoot (0.13.6): removing an existing shelf+band invalidates the root item once; a root with no shelf costs nothing', () => {
  const { plugin, rootEntry, invalidateCalls } = makeBranchToggleFixture();
  renderAllShelves(plugin);
  invalidateCalls.length = 0;

  removeShelfForRoot(plugin, rootEntry);
  assert.deepEqual(invalidateCalls, [{ path: rootEntry.path, force: false }]);

  invalidateCalls.length = 0;
  removeShelfForRoot(plugin, rootEntry); // already gone -- nothing to invalidate
  assert.deepEqual(invalidateCalls, []);
});

test('sweepOrphanShelves (0.13.6): removing an orphaned shelf invalidates the owning item\'s own height too, not only the branch-hidden un-hide', () => {
  const { plugin, view, rootEl, rootEntry, invalidateCalls } = makeBranchToggleFixture({ collapsedBranchRoots: ['04 Inner World/My Life/Projects'] });
  renderAllShelves(plugin);
  assert.ok(rootEl.querySelector(':scope > .spotlight-shelf'));
  invalidateCalls.length = 0;

  plugin.settings.roots = []; // orphan it
  sweepOrphanShelves(plugin);

  // Both calls land on the SAME item: one for the shelf's own height
  // shrinking (this fix), one un-paired... actually the un-hide pair
  // (applyBranchHiddenDomState) -- three invalidate calls in total:
  // this fix's own single call, then the hide/show pair.
  assert.deepEqual(invalidateCalls, [
    { path: rootEntry.path, force: false }, // this fix: the shelf's own removal
    { path: rootEntry.path, force: true }, // applyBranchHiddenDomState un-hide, before
    { path: rootEntry.path, force: false }, // applyBranchHiddenDomState un-hide, after
  ]);
});

test('branch toggle click + the coalesced pass that follows it: the shelf itself is never rebuilt', async () => {
  // Instrumented, not guessed: `branchHidden` was already excluded from
  // `renderShelfForRoot`'s own signature (0.13.0, so a band click alone
  // never changes it) -- this proves that holds through a SUBSEQUENT
  // pass too (the coalesced safety-net one a real invalidate() ->
  // Obsidian compute() -> this plugin's own MutationObserver chain fires
  // afterward; exercised here directly, since this harness does not wire
  // a real MutationObserver/rAF for that chain -- live measurement showed
  // 2-3 reapply passes per native expand/collapse cycle).
  const { plugin, rootEl } = makeBranchToggleFixture();
  renderAllShelves(plugin);
  const toggle = rootEl.querySelector(':scope > .spotlight-branch-toggle');

  let shelfInserts = 0;
  const realInsertBefore = rootEl.insertBefore.bind(rootEl);
  rootEl.insertBefore = (child, ref) => {
    if (child.classList && child.classList.contains('spotlight-shelf')) shelfInserts += 1;
    return realInsertBefore(child, ref);
  };

  toggle._fire('click', {});
  await Promise.resolve();
  await Promise.resolve();
  plugin.runReapply(); // the pass that follows

  assert.equal(shelfInserts, 0, 'the band click, and the pass it eventually triggers, must never re-insert (rebuild) the shelf itself');
});

test('handleShelfStarActivate + a band click while the unstar write is still settling: the row must not flicker back onto the shelf', async () => {
  // Root-caused live-suspect #1 surfacing through a DIFFERENT trigger:
  // the same flicker was seen on the branch-toggle band once a star
  // write was in flight -- not because the band's own click does
  // anything wrong (the previous test proves it doesn't touch the
  // shelf), but because ANY subsequent reapply pass -- including the
  // safety-net one following a band click -- caught the shelf mid-write,
  // before Obsidian's own metadataCache had confirmed it. This is the
  // exact same deferred-write technique as the override-race test above,
  // applied to the shelf's OWN star (`handleShelfStarActivate`) instead
  // of the inline row's.
  const { plugin, rootEl, stub, flatUnstarred } = makeBranchToggleFixture();
  // This fixture builds `plugin` by hand rather than through `onload()`,
  // so the metadataCache 'changed' listener `reconcileStarOverride`
  // depends on is never registered by default -- wire it explicitly, or
  // this test's own `metadataCache._emit('changed', ...)` calls below
  // would reach no listener at all and pass vacuously.
  plugin.registerRowInjectionEvents();
  // Both candidates start starred, so un-starring one still leaves the
  // shelf non-empty -- the diff path (0.13.4), not the to-empty full
  // removal path.
  await setSpotlightState(plugin.app, flatUnstarred, true);
  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  const rows = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  assert.equal(rows.children.length, 2, 'both candidates start on the shelf');

  const stubCandidate = resolveSpotlightTarget(plugin, stub);
  const evt = makeFakeEvent({ isTrusted: true });
  const writes = makeDeferredProcess(plugin);

  const pending = handleShelfStarActivate(plugin, stubCandidate, evt);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(rows.children.length, 1, 'optimistic paint: the row leaves the shelf immediately');

  // Click the band WHILE the write is still open -- its own click never
  // touches the shelf (previous test), but simulate the pass a real
  // invalidate() chain eventually fires afterward, still BEFORE the
  // write settles.
  const toggle = rootEl.querySelector(':scope > .spotlight-branch-toggle');
  toggle._fire('click', {});
  plugin.runReapply();
  assert.equal(rows.children.length, 1, 'still just the one row -- nothing has settled yet');

  // The write's own promise resolves, but nothing has told the metadata
  // cache about it yet.
  assert.equal(writes.length, 1);
  writes[0].settle();
  await pending;
  plugin.runReapply(); // another pass, exactly like the band-triggered one above
  assert.equal(
    rows.children.length,
    1,
    'the write settling (its own promise resolving) must not resurrect the row -- metadataCache has not confirmed it yet',
  );

  // NOW simulate the belated cache catch-up + Obsidian's own 'changed'
  // event -- the one, correct moment this override is allowed to clear.
  writes[0].applyToCache();
  plugin.app.metadataCache._emit('changed', stub);
  plugin.runReapply();
  assert.equal(rows.children.length, 1, 'confirmed unstarred -- stays off the shelf, this time for real');
  assert.equal(plugin._optimisticStarOverrides.has(stub.path), false);
});

test('handleShelfStarActivate (0.13.6, condition D): reconciles a frontmatter candidate\'s override AT SETTLE TIME when live storage already agrees, no metadataCache "changed" event required', async () => {
  const { plugin, rootEl, stub, flatUnstarred } = makeBranchToggleFixture();
  plugin.registerRowInjectionEvents();
  await setSpotlightState(plugin.app, flatUnstarred, true); // both starred -- the diff path, not to-empty removal
  renderAllShelves(plugin);
  const shelf = rootEl.querySelector(':scope > .spotlight-shelf');
  const rows = Array.from(shelf.children).find((c) => c.classList.contains('spotlight-shelf-rows'));
  assert.equal(rows.children.length, 2);

  const stubCandidate = resolveSpotlightTarget(plugin, stub);
  const evt = makeFakeEvent({ isTrusted: true });
  const writes = makeDeferredProcess(plugin);

  const pending = handleShelfStarActivate(plugin, stubCandidate, evt);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(plugin._optimisticStarOverrides.has(stub.path), true);

  // Unchanged-content write: live storage already agrees the instant
  // this settles -- no metadataCache._emit('changed', ...) at all.
  writes[0].applyToCache();
  writes[0].settle();
  await pending;

  assert.equal(
    plugin._optimisticStarOverrides.has(stub.path),
    false,
    '0.13.6: the shelf star\'s own settle-time call reconciles a frontmatter candidate too',
  );
});

test('branch toggle keydown Enter/Space: toggles exactly like a click', async () => {
  const { plugin, rootEl } = makeBranchToggleFixture();
  renderAllShelves(plugin);
  const toggle = rootEl.querySelector(':scope > .spotlight-branch-toggle');
  toggle._fire('keydown', { key: 'Enter', preventDefault() {} });
  await Promise.resolve();
  assert.equal(rootEl.classList.contains('spotlight-branch-hidden'), true);
  toggle._fire('keydown', { key: ' ', preventDefault() {} });
  await Promise.resolve();
  assert.equal(rootEl.classList.contains('spotlight-branch-hidden'), false);
});

test('branch toggle click, hidden -> showing: the reverse trip un-hides and persists an empty collapsedBranchRoots', async () => {
  const { plugin, rootEl, rootEntry } = makeBranchToggleFixture({ collapsedBranchRoots: ['04 Inner World/My Life/Projects'] });
  renderAllShelves(plugin);
  const toggle = rootEl.querySelector(':scope > .spotlight-branch-toggle');
  assert.equal(rootEl.classList.contains('spotlight-branch-hidden'), true);

  toggle._fire('click', {});
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(rootEl.classList.contains('spotlight-branch-hidden'), false);
  assert.equal(toggle.classList.contains('is-hidden'), false);
  assert.deepEqual(plugin.settings.collapsedBranchRoots, []);
});

/* ----------------------------------------------------------------------
 * Shelf row clicks while the branch is hidden -- passing the row's own `rootEntry` is what makes this
 * reachable at all; every OTHER call site (and every pre-0.13.0 test
 * above and in spotlight.test.mjs) omits it, which reads as "branch
 * showing" -- byte-identical to every build before this one.
 * -------------------------------------------------------------------- */

test('revealEntityCandidate: a NOTE shelf row, branch hidden -- opens the file ONLY, no revealInFolder, no scroll nudge, branch stays hidden', () => {
  const { plugin, view, stub, rootEntry } = makeBranchToggleFixture({ collapsedBranchRoots: ['04 Inner World/My Life/Projects'] });
  const rootItem = view.fileItems[rootEntry.path];
  rootItem.el.classList.add('spotlight-branch-hidden'); // the DOM state a prior render would already have applied

  revealEntityCandidate(plugin, { entityNote: stub }, rootEntry);

  assert.equal(plugin.app.workspace._lastOpenedFile, stub);
  assert.equal(view._revealed, undefined, 'revealInFolder must never be called');
  assert.equal(rootItem.el.classList.contains('spotlight-branch-hidden'), true, 'the branch stays hidden');
});

test('revealEntityCandidate: a FILE shelf row, branch hidden -- same open-only behaviour as a note', () => {
  const { plugin, view, asset } = makeFileShelfFixture();
  const owningRoot = plugin.settings.roots[0];
  plugin.settings.collapsedBranchRoots = [owningRoot.path];

  revealEntityCandidate(plugin, { kind: 'file', target: asset }, owningRoot);

  assert.equal(view._revealed, undefined, 'revealInFolder must never be called for a hidden branch\'s file row');
  assert.equal(plugin.app.workspace._lastOpenedFile, asset);
});

test('revealEntityCandidate: a FOLDER shelf row, branch hidden -- un-hides FIRST (stays un-hidden), THEN runs the existing reveal/expand path unchanged', () => {
  const { plugin, view, bucket } = makeFolderShelfFixture();
  const rootEntry = plugin.settings.roots[0];
  plugin.settings.collapsedBranchRoots = [rootEntry.path];
  const { invalidate, calls } = makeInvalidateSpy();
  view.tree = { infinityScroll: { invalidate } };
  const rootItem = view.fileItems[rootEntry.path];
  rootItem.el.classList.add('spotlight-branch-hidden');
  const setCollapsedCalls = [];
  view.fileItems[bucket.path] = { file: bucket, setCollapsed: (...args) => setCollapsedCalls.push(args) };

  revealEntityCandidate(plugin, { kind: 'folder', target: bucket }, rootEntry);

  assert.equal(rootItem.el.classList.contains('spotlight-branch-hidden'), false, 'un-hidden first');
  assert.deepEqual(calls, [
    { path: rootEntry.path, force: true },
    { path: rootEntry.path, force: false },
  ]);
  assert.deepEqual(plugin.settings.collapsedBranchRoots, [], 'persisted as not-hidden');
  // ...then the EXACT existing path, unchanged: reveal, expand.
  assert.equal(view._revealed, bucket);
  assert.deepEqual(setCollapsedCalls, [[false, false]]);
});

test('revealEntityCandidate: a FOLDER shelf row un-hidden via click stays un-hidden -- it does not re-hide afterwards', () => {
  const { plugin, view, bucket } = makeFolderShelfFixture();
  const rootEntry = plugin.settings.roots[0];
  plugin.settings.collapsedBranchRoots = [rootEntry.path];
  view.tree = { infinityScroll: { invalidate: () => {} } };
  const rootItem = view.fileItems[rootEntry.path];
  rootItem.el.classList.add('spotlight-branch-hidden');

  revealEntityCandidate(plugin, { kind: 'folder', target: bucket }, rootEntry);
  // A second, unrelated call (e.g. a different folder on the same shelf)
  // must find the branch already showing -- nothing re-hides it.
  revealEntityCandidate(plugin, { kind: 'folder', target: bucket }, rootEntry);

  assert.equal(rootItem.el.classList.contains('spotlight-branch-hidden'), false);
});

test('revealEntityCandidate: branch SHOWING behaves exactly as every pre-0.13.0 build -- rootEntry present but not in collapsedBranchRoots changes nothing', () => {
  const { plugin, view, stub, rootEntry } = makeBranchToggleFixture(); // collapsedBranchRoots: []
  revealEntityCandidate(plugin, { entityNote: stub }, rootEntry);
  assert.equal(view._revealed, stub);
  assert.equal(plugin.app.workspace._lastOpenedFile, stub);
});

/* ----------------------------------------------------------------------
 * guardScrollAcrossHiddenBranchReveal (0.13.0, fixed in 0.13.1) --
 * mitigates Obsidian's own auto-reveal jumping the explorer to a wrong
 * spot when a shelf click, branch hidden, opens a file.
 *
 * 0.13.0's own fix assumed `onFileOpen`'s `revealActiveFile()` call ran
 * SYNCHRONOUSLY inside `openFile()` and restored on the same
 * `app.nextFrame` (rAF) batch on that basis -- live QA (auto-reveal ON)
 * showed the restore did not reliably hold. Root cause, read more
 * carefully: `'file-open'` is dispatched
 * through `Workspace.prototype.requestActiveLeafEvents`, a REAL
 * `setTimeout`-based debounce (delay 0, but still a macrotask, not rAF) --
 * a genuine, unforced race against `app.nextFrame`, which is exactly why
 * it held with nothing to race (auto-reveal off) and failed inconsistently
 * with something to race (auto-reveal on).
 *
 * 0.13.1 fixes it by reacting to the REAL event instead: a one-shot
 * `workspace.on('file-open', ...)` listener, registered before the open,
 * restores INSIDE that event's own synchronous dispatch (Obsidian's own
 * listener, registered long before this plugin loaded, always runs
 * first -- confirmed `Events.prototype.trigger` dispatches registration-
 * order over a snapshot) -- no timing guess left anywhere in this path.
 * The original `app.nextFrame` restore stays as a harmless secondary
 * backstop.
 * -------------------------------------------------------------------- */

test('guardScrollAcrossHiddenBranchReveal: with no workspace.on/offref, falls back to the nextFrame-only restore (0.13.0\'s own path)', () => {
  const scrollEl = { scrollTop: 500 };
  let updateCalls = 0;
  const infinityScroll = { scrollEl, updateVirtualDisplay: () => { updateCalls += 1; } };
  const queued = [];
  const plugin = { explorerView: { tree: { infinityScroll } }, app: { nextFrame: (cb) => queued.push(cb) } }; // no app.workspace at all

  guardScrollAcrossHiddenBranchReveal(plugin);
  scrollEl.scrollTop = 9999; // simulates a wrong jump, in between
  assert.equal(queued.length, 1);
  queued[0]();

  assert.equal(scrollEl.scrollTop, 500, 'restored to whatever it was BEFORE the call');
  assert.equal(updateCalls, 1);
});

test('guardScrollAcrossHiddenBranchReveal: a plugin unloaded before the queued frame runs never writes to a torn-down explorer', () => {
  const scrollEl = { scrollTop: 500 };
  const infinityScroll = { scrollEl };
  const queued = [];
  const plugin = { explorerView: { tree: { infinityScroll } }, app: { nextFrame: (cb) => queued.push(cb) } };

  guardScrollAcrossHiddenBranchReveal(plugin);
  scrollEl.scrollTop = 9999;
  plugin._unloaded = true;
  queued[0]();

  assert.equal(scrollEl.scrollTop, 9999, 'left alone -- the plugin already tore itself down');
});

test('guardScrollAcrossHiddenBranchReveal: no scrollEl, or no app.nextFrame -- no throw, nothing queued', () => {
  assert.doesNotThrow(() => guardScrollAcrossHiddenBranchReveal({ explorerView: null, app: {} }));
  assert.doesNotThrow(() => guardScrollAcrossHiddenBranchReveal({ explorerView: { tree: { infinityScroll: {} } }, app: {} }));
  const queued = [];
  const plugin = { explorerView: { tree: { infinityScroll: { scrollEl: { scrollTop: 1 } } } }, app: {} }; // no nextFrame at all
  assert.doesNotThrow(() => guardScrollAcrossHiddenBranchReveal(plugin));
  assert.equal(queued.length, 0);
});

test('guardScrollAcrossHiddenBranchReveal (0.13.1): restores on the REAL file-open event, which runs AFTER a nextFrame that fired too early -- the exact race a live QA pass caught', () => {
  const scrollEl = { scrollTop: 300 };
  const infinityScroll = { scrollEl };
  const queued = [];
  const app = makeApp({});
  // 0.13.6: the file-open listener
  // is now only registered when auto-reveal is actually on somewhere --
  // this test is exercising exactly that race, so it needs a leaf that
  // reports `autoReveal: true` for the listener to be worth holding at
  // all (see `computeAutoRevealState`'s own doc comment).
  app.workspace.getLeavesOfType = () => [makeFakeLeaf(true)];
  app.nextFrame = (cb) => queued.push(cb);
  const node = { path: 'target.md' };
  const plugin = { explorerView: { tree: { infinityScroll } }, app };

  guardScrollAcrossHiddenBranchReveal(plugin, node);

  // The nextFrame backstop fires FIRST (0.13.0's own, now-proven-racy
  // path) -- correctly restores to 300 at this point.
  assert.equal(queued.length, 1);
  queued[0]();
  assert.equal(scrollEl.scrollTop, 300);

  // THEN Obsidian's own debounced auto-reveal finally fires, jumping the
  // scroll -- this is the part 0.13.0 had no way to catch.
  scrollEl.scrollTop = 101;
  app.workspace._emit('file-open', node);

  assert.equal(scrollEl.scrollTop, 300, 'the file-open listener restores it AGAIN, after the late jump -- this is what 0.13.0 was missing');
});

test('guardScrollAcrossHiddenBranchReveal (0.13.1): an UNRELATED file-open (a different path) firing first is left alone, but the listener still cleans itself up', () => {
  const scrollEl = { scrollTop: 300 };
  const infinityScroll = { scrollEl };
  const app = makeApp({});
  // 0.13.6: the listener is only registered when auto-reveal is
  // actually on -- see the 3514 test's own comment.
  app.workspace.getLeavesOfType = () => [makeFakeLeaf(true)];
  delete app.nextFrame; // isolate the file-open path
  const node = { path: 'target.md' };
  const plugin = { explorerView: { tree: { infinityScroll } }, app };

  guardScrollAcrossHiddenBranchReveal(plugin, node);
  scrollEl.scrollTop = 9999;
  app.workspace._emit('file-open', { path: 'something-else.md' });
  assert.equal(scrollEl.scrollTop, 9999, 'not this plugin\'s own open -- left untouched');

  // The listener already unregistered itself on that first (unmatched)
  // firing -- a LATER, genuinely matching file-open must not restore
  // either, proving cleanup happened rather than a lucky no-op.
  app.workspace._emit('file-open', node);
  assert.equal(scrollEl.scrollTop, 9999, 'the listener is gone -- it does not get a second chance');
});

test('guardScrollAcrossHiddenBranchReveal (0.13.1): the listener is one-shot -- a second file-open for the SAME file does not restore again', () => {
  const scrollEl = { scrollTop: 300 };
  const infinityScroll = { scrollEl };
  const app = makeApp({});
  app.workspace.getLeavesOfType = () => [makeFakeLeaf(true)];
  delete app.nextFrame;
  const node = { path: 'target.md' };
  const plugin = { explorerView: { tree: { infinityScroll } }, app };

  guardScrollAcrossHiddenBranchReveal(plugin, node);
  app.workspace._emit('file-open', node);
  assert.equal(scrollEl.scrollTop, 300);

  scrollEl.scrollTop = 555; // some later, unrelated scroll a member did themselves
  app.workspace._emit('file-open', node); // an unrelated later open of the SAME path
  assert.equal(scrollEl.scrollTop, 555, 'a stale listener would have clobbered this -- it must already be gone');
});

test('guardScrollAcrossHiddenBranchReveal (0.13.1): a plugin unloaded before file-open fires never writes, but still cleans up', () => {
  const scrollEl = { scrollTop: 300 };
  const infinityScroll = { scrollEl };
  const app = makeApp({});
  app.workspace.getLeavesOfType = () => [makeFakeLeaf(true)];
  delete app.nextFrame;
  const node = { path: 'target.md' };
  const plugin = { explorerView: { tree: { infinityScroll } }, app };

  guardScrollAcrossHiddenBranchReveal(plugin, node);
  scrollEl.scrollTop = 9999;
  plugin._unloaded = true;
  app.workspace._emit('file-open', node);

  assert.equal(scrollEl.scrollTop, 9999, 'left alone -- the plugin already tore itself down');
});

test('guardScrollAcrossHiddenBranchReveal (0.13.1): no workspace.offref (an older/atypical app shape) -- skips the listener path outright, never throws, nextFrame still works', () => {
  const scrollEl = { scrollTop: 300 };
  const infinityScroll = { scrollEl };
  const queued = [];
  const plugin = {
    explorerView: { tree: { infinityScroll } },
    app: { nextFrame: (cb) => queued.push(cb), workspace: { on: () => ({}) } }, // on() but no offref()
  };
  assert.doesNotThrow(() => guardScrollAcrossHiddenBranchReveal(plugin, { path: 'x.md' }));
  assert.equal(queued.length, 1);
});

/* ----------------------------------------------------------------------
 * 0.13.6: listener hygiene --
 * ONE pending ref, torn down by a newer call, by its own ~1s backstop
 * timeout, or by onunload(); skipped entirely with auto-reveal off.
 * -------------------------------------------------------------------- */

test('guardScrollAcrossHiddenBranchReveal (0.13.6, condition B): auto-reveal OFF everywhere -- no listener is ever registered, a genuinely matching file-open does not restore', () => {
  const scrollEl = { scrollTop: 300 };
  const infinityScroll = { scrollEl };
  const app = makeApp({}); // default: no leaves at all, computeAutoRevealState(...).anyOn === false
  delete app.nextFrame; // isolate the listener path
  const node = { path: 'target.md' };
  const plugin = { explorerView: { tree: { infinityScroll } }, app };

  guardScrollAcrossHiddenBranchReveal(plugin, node);
  assert.equal(plugin._revealGuardRef, undefined, 'no ref -- the listener was never added');

  scrollEl.scrollTop = 9999;
  app.workspace._emit('file-open', node); // a real match, but no listener is there to catch it
  assert.equal(scrollEl.scrollTop, 9999, 'nothing restores -- auto-reveal off means nothing to guard against');
});

test('guardScrollAcrossHiddenBranchReveal (0.13.6, condition B): a second click before the first click\'s own file-open arrives offrefs the FIRST ref, never double-registers', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // isolates the two real 1s backstops this test would otherwise leave dangling
  const scrollEl = { scrollTop: 300 };
  const infinityScroll = { scrollEl };
  const app = makeApp({});
  app.workspace.getLeavesOfType = () => [makeFakeLeaf(true)];
  delete app.nextFrame;
  const plugin = { explorerView: { tree: { infinityScroll } }, app };

  guardScrollAcrossHiddenBranchReveal(plugin, { path: 'first.md' });
  const firstRef = plugin._revealGuardRef;
  assert.ok(firstRef, 'first click registered a ref');

  guardScrollAcrossHiddenBranchReveal(plugin, { path: 'second.md' });
  const secondRef = plugin._revealGuardRef;
  assert.ok(secondRef, 'second click registered its own ref');
  assert.notEqual(secondRef, firstRef, 'a fresh ref, not the reused first one');

  // The FIRST click's own file-open, arriving late, must find nothing --
  // its ref was offref'd the instant the second click fired, exactly the
  // "one pending ref" rule this fix adds.
  scrollEl.scrollTop = 9999;
  app.workspace._emit('file-open', { path: 'first.md' });
  assert.equal(scrollEl.scrollTop, 9999, 'the stale first listener is gone -- it never restores');
});

test('guardScrollAcrossHiddenBranchReveal (0.13.6, condition B): no file-open ever arrives (a non-viewable file, or a click on the already-open file) -- the ~1s backstop offrefs the ref itself', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scrollEl = { scrollTop: 300 };
  const infinityScroll = { scrollEl };
  const app = makeApp({});
  app.workspace.getLeavesOfType = () => [makeFakeLeaf(true)];
  delete app.nextFrame;
  const plugin = { explorerView: { tree: { infinityScroll } }, app };

  guardScrollAcrossHiddenBranchReveal(plugin, { path: 'ghost.md' });
  assert.ok(plugin._revealGuardRef, 'registered, waiting for a file-open that will never come');

  t.mock.timers.tick(1000);
  assert.equal(plugin._revealGuardRef, null, 'the backstop timeout cleared it itself');
});

test('onunload (0.13.6, condition B): a pending reveal-guard ref and its backstop timeout are torn down, not left to fire against a torn-down plugin', () => {
  const { plugin, rootEl, stub, rootEntry } = makeBranchToggleFixture();
  const scrollEl = { scrollTop: 300 };
  plugin.explorerView.tree.infinityScroll.scrollEl = scrollEl;
  plugin.app.workspace.getLeavesOfType = () => [makeFakeLeaf(true)];
  delete plugin.app.nextFrame;

  guardScrollAcrossHiddenBranchReveal(plugin, stub);
  const ref = plugin._revealGuardRef;
  assert.ok(ref, 'sanity: a ref is pending before unload');
  const timeoutId = plugin._revealGuardTimeoutId;
  assert.ok(timeoutId, 'sanity: its backstop timeout is pending too');

  plugin.onunload();

  assert.equal(plugin._revealGuardRef, null);
  assert.equal(plugin._revealGuardTimeoutId, null);
  // The offref actually ran -- a late file-open finds no listener at all.
  scrollEl.scrollTop = 9999;
  plugin.app.workspace._emit('file-open', stub);
  assert.equal(scrollEl.scrollTop, 9999, 'no listener left to restore it');
});

test('revealEntityCandidate / guardScrollAcrossHiddenBranchReveal (0.13.6, condition B): a rejecting leaf.openFile() promise is caught, never an unhandled rejection', async () => {
  const { plugin, stub, rootEntry } = makeBranchToggleFixture({ collapsedBranchRoots: ['04 Inner World/My Life/Projects'] });
  plugin.app.workspace.getLeaf = () => ({ openFile: () => Promise.reject(new Error('simulated open failure')) });

  let unhandled = null;
  const onUnhandled = (err) => { unhandled = err; };
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.doesNotThrow(() => revealEntityCandidate(plugin, { entityNote: stub }, rootEntry));
    // Let the rejected promise's own microtask (and this file's .catch)
    // actually run before checking nothing leaked past it.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.equal(unhandled, null, 'the rejection was caught by main.js\'s own .catch, never surfaced as unhandled');
});

test('revealEntityCandidate, end to end: a note shelf click, branch hidden, undoes a LATE auto-reveal scroll delivered via a real file-open event -- reproduces the exact failure a live QA pass found and confirms the fix', () => {
  const { plugin, view, stub, rootEntry } = makeBranchToggleFixture({ collapsedBranchRoots: ['04 Inner World/My Life/Projects'] });
  const rootItem = view.fileItems[rootEntry.path];
  rootItem.el.classList.add('spotlight-branch-hidden');
  const scrollEl = { scrollTop: 500 };
  view.tree.infinityScroll.scrollEl = scrollEl;
  const queued = [];
  plugin.app.nextFrame = (cb) => queued.push(cb);
  // 0.13.6: the file-open listener
  // this whole test exercises is only registered when auto-reveal is
  // actually on somewhere -- exactly the condition the scenario this test
  // simulates ("a LATE auto-reveal scroll") implies.
  plugin.app.workspace.getLeavesOfType = () => [makeFakeLeaf(true)];
  plugin.app.workspace.getLeaf = () => ({
    openFile: (file) => {
      plugin.app.workspace._lastOpenedFile = file;
      // Real Obsidian does NOT jump the scroll synchronously here --
      // openFile() returns first, and the wrong scroll only lands once
      // the debounced 'file-open' event fires, simulated below.
    },
  });

  revealEntityCandidate(plugin, { entityNote: stub }, rootEntry);
  assert.equal(plugin.app.workspace._lastOpenedFile, stub);

  // The nextFrame backstop fires first, finding nothing yet to undo.
  assert.equal(queued.length, 1);
  queued[0]();
  assert.equal(scrollEl.scrollTop, 500);

  // THEN the real, debounced auto-reveal scroll finally lands.
  scrollEl.scrollTop = 9999;
  plugin.app.workspace._emit('file-open', stub);

  assert.equal(scrollEl.scrollTop, 500, 'the file-open listener catches the LATE jump nextFrame could not');
  assert.equal(rootItem.el.classList.contains('spotlight-branch-hidden'), true, 'the branch is still hidden -- only the scroll position was ever in question');
});

/* ----------------------------------------------------------------------
 * Un-starring the last shelf item forgets the hidden state: per the
 * design spec, un-starring the last item forgets the hidden state.
 * -------------------------------------------------------------------- */

test('renderShelfForRoot: the star count dropping to 0 clears both the persisted hidden entry and item.el\'s own class', async () => {
  const { plugin, rootEl, stub, rootEntry } = makeBranchToggleFixture({ collapsedBranchRoots: ['04 Inner World/My Life/Projects'] });
  renderAllShelves(plugin);
  assert.ok(rootEl.querySelector(':scope > .spotlight-branch-toggle'));
  assert.equal(rootEl.classList.contains('spotlight-branch-hidden'), true);

  await setSpotlightState(plugin.app, stub, false); // the only starred item on this root
  renderAllShelves(plugin);

  assert.equal(rootEl.querySelector(':scope > .spotlight-shelf'), null);
  assert.equal(rootEl.querySelector(':scope > .spotlight-branch-toggle'), null);
  assert.equal(rootEl.classList.contains('spotlight-branch-hidden'), false);
  assert.deepEqual(plugin.settings.collapsedBranchRoots, []);
});

/* ----------------------------------------------------------------------
 * applyBranchHiddenDomState / reapplyBranchHiddenState -- the two
 * functions the platform review's conditions 2 and 5 are built from directly.
 * -------------------------------------------------------------------- */

test('applyBranchHiddenDomState: idempotent -- calling it with the state already in force is a no-op, no invalidate call', () => {
  const el = makeFakeElement('div');
  const item = { el, file: { path: 'X' } };
  const calls = [];
  const plugin = { explorerView: { tree: { infinityScroll: { invalidate: (i, f) => calls.push({ i, f }) } } } };

  assert.equal(applyBranchHiddenDomState(plugin, item, true), true);
  assert.equal(calls.length, 2);
  assert.equal(applyBranchHiddenDomState(plugin, item, true), false, 'already hidden -- no-op');
  assert.equal(calls.length, 2, 'no extra invalidate calls on the no-op path');
  assert.equal(el.classList.contains('spotlight-branch-hidden'), true);
});

test('applyBranchHiddenDomState: guards a missing item/el, and a missing/non-function invalidate, with no throw', () => {
  assert.doesNotThrow(() => applyBranchHiddenDomState({ explorerView: null }, null, true));
  assert.doesNotThrow(() => applyBranchHiddenDomState({ explorerView: null }, { el: null }, true));
  const el = makeFakeElement('div');
  assert.doesNotThrow(() => applyBranchHiddenDomState({ explorerView: {} }, { el }, true));
  assert.equal(el.classList.contains('spotlight-branch-hidden'), true, 'the class still flips even with no infinityScroll to invalidate');
});

/* ----------------------------------------------------------------------
 * 0.13.2: 0.13.0/0.13.1's unconditional
 * per-pass invalidate was itself the bug -- a startup pause, a flickering
 * scrollbar, and delayed star/shelf updates, all traced to
 * `reapplyBranchHiddenState` calling `infinityScroll.invalidate(item, true)`
 * on EVERY reapply pass for every hidden root. `invalidate()` isn't free:
 * it schedules Obsidian's own `compute()` on a REAL 50ms-debounced timer,
 * which mutates `childrenEl`,
 * which this plugin's own MutationObserver sees, which schedules another
 * reapply pass, which called `invalidate()` again -- a self-feeding
 * cascade, confirmed live: idle reapply count over 10s was 0 with nothing
 * hidden and 3 with roots hidden, same settings otherwise. Each pass also
 * separately costs ~60ms (a pre-existing, unrelated `renderAllShelves`
 * cost on a large root, reported as its own ticket). Fixed: invalidate
 * only on a genuine `item.collapsed` true-to-false TRANSITION (a real
 * native re-expand), tracked per root across passes in
 * `plugin._branchCollapsedSeen` -- never on a bare "still hidden" check
 * that is true on every single pass.
 * -------------------------------------------------------------------- */

/** A hidden root's item, already carrying the class -- the realistic
 * steady state this fix targets: this plugin (or a prior pass) already
 * hid it; the class-application itself is therefore already a no-op
 * before ANY of these tests' own assertions begin. Isolates the
 * transition-tracking logic under test from `applyBranchHiddenDomState`'s
 * own, separately-tested, first-time-hiding invalidate. */
function makeAlreadyHiddenItem(collapsed) {
  const el = makeFakeElement('div');
  el.classList.add('spotlight-branch-hidden');
  return { el, file: { path: 'Workspace' }, collapsed };
}

test('reapplyBranchHiddenState (0.13.2 fix): two consecutive passes on an ALREADY-hidden root with item.collapsed unchanged -- ZERO invalidate calls', () => {
  const item = makeAlreadyHiddenItem(false);
  const calls = [];
  const plugin = {
    explorerView: { fileItems: { 'Workspace': item }, tree: { infinityScroll: { invalidate: (i, f) => calls.push({ i, f }) } } },
    settings: { roots: [{ path: 'Workspace', enabled: true }], collapsedBranchRoots: ['Workspace'] },
  };

  reapplyBranchHiddenState(plugin); // first observation -- no prior state to compare, never fires
  reapplyBranchHiddenState(plugin); // unchanged since the first -- still never fires

  assert.equal;
  assert.equal(item.el.classList.contains('spotlight-branch-hidden'), true);
});

test('reapplyBranchHiddenState (0.13.2 fix): a genuine item.collapsed true -> false transition (a real native re-expand) fires exactly invalidate(before)+invalidate(after)', () => {
  const item = makeAlreadyHiddenItem(true);
  const calls = [];
  const plugin = {
    explorerView: { fileItems: { 'Workspace': item }, tree: { infinityScroll: { invalidate: (i, f) => calls.push({ i, f }) } } },
    settings: { roots: [{ path: 'Workspace', enabled: true }], collapsedBranchRoots: ['Workspace'] },
  };

  reapplyBranchHiddenState(plugin); // observes collapsed: true, first time -- no fire
  assert.equal(calls.length, 0);

  item.collapsed = false; // Obsidian's own native arrow click happened between passes
  reapplyBranchHiddenState(plugin);

  assert.deepEqual(calls, [
    { i: item, f: true },
    { i: item, f: undefined },
  ]);

  // A THIRD pass, nothing changed since -- must not fire again.
  reapplyBranchHiddenState(plugin);
  assert.equal(calls.length, 2, 'no repeat firing once the transition has already been observed and handled once');
});

test('reapplyBranchHiddenState (0.13.2 fix): item.collapsed flipping false -> true (a native COLLAPSE, not an expand) never fires -- only true -> false does', () => {
  const item = makeAlreadyHiddenItem(false);
  const calls = [];
  const plugin = {
    explorerView: { fileItems: { 'Workspace': item }, tree: { infinityScroll: { invalidate: (i, f) => calls.push({ i, f }) } } },
    settings: { roots: [{ path: 'Workspace', enabled: true }], collapsedBranchRoots: ['Workspace'] },
  };

  reapplyBranchHiddenState(plugin);
  item.collapsed = true;
  reapplyBranchHiddenState(plugin);

  assert.equal(calls.length, 0);
});

test('reapplyBranchHiddenState (0.13.2 fix): the FIRST-EVER pass on a root that is not yet hidden in the DOM still applies the class, invalidating exactly once (via applyBranchHiddenDomState, not the transition tracker)', () => {
  const el = makeFakeElement('div'); // no pre-existing class -- a fresh row
  const item = { el, file: { path: 'Workspace' }, collapsed: false };
  const calls = [];
  const plugin = {
    explorerView: { fileItems: { 'Workspace': item }, tree: { infinityScroll: { invalidate: (i, f) => calls.push({ i, f }) } } },
    settings: { roots: [{ path: 'Workspace', enabled: true }], collapsedBranchRoots: ['Workspace'] },
  };

  reapplyBranchHiddenState(plugin);

  assert.deepEqual(calls, [
    { i: item, f: true },
    { i: item, f: undefined },
  ]);
  assert.equal(el.classList.contains('spotlight-branch-hidden'), true);

  // A second pass, nothing changed -- must not fire again.
  reapplyBranchHiddenState(plugin);
  assert.equal(calls.length, 2);
});

test('reapplyBranchHiddenState: skips a DISABLED root\'s own persisted hidden entry -- it must never visually hide a branch nobody can currently reach a band for', () => {
  const el = makeFakeElement('div');
  const item = { el, file: { path: 'Workspace' } };
  const calls = [];
  const plugin = {
    explorerView: { fileItems: { 'Workspace': item }, tree: { infinityScroll: { invalidate: (i, f) => calls.push({ i, f }) } } },
    settings: { roots: [{ path: 'Workspace', enabled: false }], collapsedBranchRoots: ['Workspace'] },
  };

  reapplyBranchHiddenState(plugin);

  assert.equal(calls.length, 0);
  assert.equal(el.classList.contains('spotlight-branch-hidden'), false);
});

test('reapplyBranchHiddenState: no explorerView, or nothing hidden -- no throw, no-op', () => {
  assert.doesNotThrow(() => reapplyBranchHiddenState({ explorerView: null, settings: { roots: [], collapsedBranchRoots: [] } }));
  assert.doesNotThrow(() =>
    reapplyBranchHiddenState({ explorerView: { fileItems: {} }, settings: { roots: [], collapsedBranchRoots: [] } }),
  );
});

/* ----------------------------------------------------------------------
 * removeShelfForRoot -- the branch toggle is removed with the shelf
 *, and a disabled/non-owner root's own item.el is un-hidden
 * even though its persisted setting survives (mirrors collapsedShelfRoots).
 * -------------------------------------------------------------------- */

test('removeShelfForRoot: removes the branch toggle alongside the shelf, and un-hides item.el -- the persisted collapsedBranchRoots entry survives', () => {
  const { plugin, rootEl, rootEntry } = makeBranchToggleFixture({ collapsedBranchRoots: ['04 Inner World/My Life/Projects'] });
  renderAllShelves(plugin);
  assert.ok(rootEl.querySelector(':scope > .spotlight-branch-toggle'));
  assert.equal(rootEl.classList.contains('spotlight-branch-hidden'), true);

  removeShelfForRoot(plugin, rootEntry);

  assert.equal(rootEl.querySelector(':scope > .spotlight-shelf'), null);
  assert.equal(rootEl.querySelector(':scope > .spotlight-branch-toggle'), null);
  assert.equal(rootEl.classList.contains('spotlight-branch-hidden'), false, 'un-hidden -- no band left to reach the setting from');
  assert.deepEqual(plugin.settings.collapsedBranchRoots, ['04 Inner World/My Life/Projects'], 'the SETTING survives, mirroring collapsedShelfRoots');
});

test('renderAllShelves: disabling a branch-hidden root un-hides its real files -- a stale setting never leaves a disabled root\'s branch invisible', () => {
  const { plugin, rootEl, rootEntry } = makeBranchToggleFixture({ collapsedBranchRoots: ['04 Inner World/My Life/Projects'] });
  renderAllShelves(plugin);
  assert.equal(rootEl.classList.contains('spotlight-branch-hidden'), true);

  rootEntry.enabled = false;
  renderAllShelves(plugin);

  assert.equal(rootEl.classList.contains('spotlight-branch-hidden'), false);
  assert.equal(rootEl.querySelector(':scope > .spotlight-shelf'), null);
});

/* ----------------------------------------------------------------------
 * The plugin's own settings methods -- setBranchHidden, and removeRoot's
 * cleanup (mirrors setShelfCollapsed / removeRoot's own
 * collapsedShelfRoots handling exactly).
 * -------------------------------------------------------------------- */

test('plugin.setBranchHidden: adds/removes a root path from collapsedBranchRoots and persists via saveData', async () => {
  const app = makeApp({});
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.settings = { roots: [{ path: 'Workspace', enabled: true }], collapsedShelfRoots: [], collapsedBranchRoots: [] };

  await plugin.setBranchHidden('Workspace', true);
  assert.deepEqual(plugin.settings.collapsedBranchRoots, ['Workspace']);
  assert.deepEqual(plugin.saved.collapsedBranchRoots, ['Workspace']);

  await plugin.setBranchHidden('Workspace', false);
  assert.deepEqual(plugin.settings.collapsedBranchRoots, []);
  assert.deepEqual(plugin.saved.collapsedBranchRoots, []);
});

test('plugin.removeRoot: mirrors its own collapsedShelfRoots cleanup -- a removed root\'s collapsedBranchRoots entry goes with it', async () => {
  const app = makeApp({});
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.settings = {
    roots: [{ path: 'Workspace', enabled: true }, { path: 'Goals', enabled: true }],
    collapsedShelfRoots: ['Workspace'],
    collapsedBranchRoots: ['Workspace'],
  };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  await plugin.removeRoot('Workspace');

  assert.deepEqual(plugin.settings.roots.map((r) => r.path), ['Goals']);
  assert.deepEqual(plugin.settings.collapsedShelfRoots, []);
  assert.deepEqual(plugin.settings.collapsedBranchRoots, []);
});

/* ----------------------------------------------------------------------
 * The shelf indent is `f(root depth) only` -- 0.13.3 held this by JS-measuring
 * one global value and writing it as an inline `--spotlight-shelf-indent`
 * on every shelf. 0.13.6 holds it
 * a different way: NO inline value is ever written any more (see
 * `measureShelfRail`'s own retirement comment) -- `styles.css`'s own
 * `margin-inline-start` reads `--nav-item-children-margin-start` through
 * the real cascade instead, so every shelf/band in the vault resolves
 * the SAME custom property by construction, whether hidden or shown,
 * regardless of render order or which other roots exist. These tests
 * assert the new invariant directly: nothing is ever written inline,
 * on any of the scenarios the 0.13.3 tests used to name explicitly.
 * Real pixel alignment across depths/themes needs a live devtools check,
 * same as this file's own §7.6 note already says for shelf-row height.
 * -------------------------------------------------------------------- */

test('renderShelfForRoot (0.13.6, condition C): hidden vs shown -- neither writes an inline --spotlight-shelf-indent', () => {
  const { plugin, rootEl, rootEntry } = makeBranchToggleFixture();

  renderAllShelves(plugin); // showing
  const shownIndent = rootEl.querySelector(':scope > .spotlight-shelf').style.getPropertyValue('--spotlight-shelf-indent');

  plugin.settings.collapsedBranchRoots = [rootEntry.path];
  renderAllShelves(plugin); // hidden -- forces a rebuild (branch-hidden isn't in the signature, but the root's OWN class already differs going in)
  const hiddenIndent = rootEl.querySelector(':scope > .spotlight-shelf').style.getPropertyValue('--spotlight-shelf-indent');

  assert.equal(shownIndent, '');
  assert.equal(hiddenIndent, '');
});

test('renderAllShelves (0.13.6, condition C): two sibling roots at the SAME depth -- neither gets an inline indent, regardless of render order or which other roots exist', () => {
  const goal = makeFile('Goals/A.md', { content: '---\ntype: goal\nspotlight: true\n---\n' });
  const goalsRoot = makeFolder('Goals', [goal]);
  const topic = makeFile('Topics/B.md', { content: '---\ntype: topic\nspotlight: true\n---\n' });
  const topicsRoot = makeFolder('Topics', [topic]);
  const app = makeApp({ folders: [goalsRoot, topicsRoot], files: { [goal.path]: goal._content, [topic.path]: topic._content } });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.settings = {
    roots: [
      { path: 'Goals', enabled: true },
      { path: 'Topics', enabled: true },
    ],
    collapsedShelfRoots: [],
    collapsedBranchRoots: [],
  };
  const goalsEl = makeFakeElement('div');
  const goalsChildrenEl = makeFakeElement('div');
  goalsEl.appendChild(goalsChildrenEl);
  const topicsEl = makeFakeElement('div');
  const topicsChildrenEl = makeFakeElement('div');
  topicsEl.appendChild(topicsChildrenEl);
  plugin.explorerView = {
    fileItems: {
      Goals: { file: goalsRoot, el: goalsEl, childrenEl: goalsChildrenEl },
      Topics: { file: topicsRoot, el: topicsEl, childrenEl: topicsChildrenEl },
    },
  };
  plugin.requestExplorerSort = () => {};
  plugin.scheduleStarReapply = () => {};

  renderAllShelves(plugin);

  const goalsIndent = goalsEl.querySelector(':scope > .spotlight-shelf').style.getPropertyValue('--spotlight-shelf-indent');
  const topicsIndent = topicsEl.querySelector(':scope > .spotlight-shelf').style.getPropertyValue('--spotlight-shelf-indent');
  assert.equal(goalsIndent, topicsIndent);
  assert.equal(goalsIndent, ''); // neither ever gets an inline override -- alignment is the CSS cascade's job now
});

test('renderAllShelves (0.13.6, condition C): adding a second root never shifts an already-rendered shelf\'s own indent -- there is nothing inline left to shift', () => {
  const { plugin, rootEl } = makeShelfFixture();
  renderAllShelves(plugin);
  const before = rootEl.querySelector(':scope > .spotlight-shelf').style.getPropertyValue('--spotlight-shelf-indent');

  const otherRoot = makeFolder('Goals', []);
  plugin.explorerView.fileItems.Goals = { file: otherRoot, el: makeFakeElement('div'), childrenEl: makeFakeElement('div') };
  plugin.settings.roots.push({ path: 'Goals', enabled: true });
  renderAllShelves(plugin);

  const after = rootEl.querySelector(':scope > .spotlight-shelf').style.getPropertyValue('--spotlight-shelf-indent');
  assert.equal(before, '');
  assert.equal(after, '');
});

/* ----------------------------------------------------------------------
 * styles.css source rules this feature adds.
 * -------------------------------------------------------------------- */

test('styles.css: the hidden-branch rule targets .tree-item-children with display: none, keyed off the plugin\'s own class -- never .is-collapsed', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const body = extractCssRuleBody(css, '.spotlight-branch-hidden > .tree-item-children');
  assert.ok(body, '.spotlight-branch-hidden > .tree-item-children rule must exist');
  assert.match(body, /display:\s*none/);
});

test('styles.css: the branch toggle is hidden under a native .is-collapsed root, same rule shape the shelf itself already has', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const body = extractCssRuleBody(css, '.is-collapsed > .spotlight-branch-toggle');
  assert.ok(body, '.is-collapsed > .spotlight-branch-toggle rule must exist');
  assert.match(body, /display:\s*none/);
});

test('styles.css: the shelf\'s own margin-bottom is zeroed only when the toggle is present (.has-branch-toggle)', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const body = extractCssRuleBody(css, '.spotlight-shelf.has-branch-toggle');
  assert.ok(body, '.spotlight-shelf.has-branch-toggle rule must exist');
  assert.match(body, /margin-bottom:\s*0/);
});

test('styles.css: the band is 14px on a mouse, 24px under @media (pointer: coarse)', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const bandBody = extractCssRuleBody(css, '.spotlight-branch-toggle');
  assert.ok(bandBody, '.spotlight-branch-toggle rule must exist');
  assert.match(bandBody, /height:\s*14px/);
  const coarseIdx = css.indexOf('@media (pointer: coarse)');
  assert.ok(coarseIdx !== -1, '@media (pointer: coarse) must exist');
  const coarseBody = extractCssRuleBody(css.slice(coarseIdx), '.spotlight-branch-toggle');
  assert.ok(coarseBody, 'the coarse-pointer override must re-declare .spotlight-branch-toggle');
  assert.match(coarseBody, /height:\s*24px/);
});

test('styles.css: hidden state colours the tab the accent, at rest AND on hover -- never flattened to one colour', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const restBody = extractCssRuleBody(css, '.spotlight-branch-toggle.is-hidden .spotlight-branch-toggle-tab');
  assert.ok(restBody);
  assert.match(restBody, /color:\s*var\(--spotlight-accent\)/);
  // The showing-state hover rule explicitly excludes .is-hidden, so hidden
  // never gets a hover colour override at all -- confirmed by its absence
  // rather than a positive assertion (nothing to read a colour off of).
  const showingHoverBody = extractCssRuleBody(css, '.spotlight-branch-toggle:not(.is-hidden):hover .spotlight-branch-toggle-tab');
  assert.ok(showingHoverBody);
  assert.match(showingHoverBody, /color:\s*var\(--text-normal\)/);
});
