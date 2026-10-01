/* The harness the Spotlight gates load the real main.js through.
 *
 * There is no real `obsidian` npm package to install — Obsidian injects
 * that module at runtime inside the app. To test main.js's pure logic
 * outside Obsidian, this harness runs the file's source in a Node `vm`
 * sandbox with a minimal stub of `obsidian`, and returns the
 * `module.exports.__test` surface main.js already exposes.
 *
 * In scope: settings reconciliation, discovery/shape classification, and
 * the storage-layer functions (getSpotlightState, spliceSpotlightKey,
 * computeSpotlightWrite, setSpotlightState, createLaneStub,
 * toggleSpotlightForLaneChild) — everything main.js currently does. Out of
 * scope, because main.js doesn't build it yet: the file-explorer sort
 * patch, star injection, and pinned lane (all gated on Spikes 1/1b).
 *
 * Shape studied from the ICOR for Life suite's own test harnesses (a Node
 * `vm` sandbox + stubbed `obsidian` module + `__test` export) — no code
 * reused, see README.md "Studied, not copied".
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(repo, 'main.js'), 'utf8');
const nodeRequire = createRequire(import.meta.url);

/**
 * A byte-faithful port of Obsidian's own `getFrontMatterInfo`, not
 * an approximation of the public d.ts comments. Earlier drafts of this
 * harness guessed at whether `to` includes the trailing newline before the
 * closing `---` — a guess main.js's own tests would then only confirm
 * against itself, which proves internal consistency, not API conformance.
 * `getFrontMatterInfo` is PUBLIC API (documented
 * in obsidian.d.ts) — this confirms a public function's exact
 * byte-level semantics the type declaration doesn't spell out. It's a
 * clean-room re-expression (renamed variables, restructured control flow)
 * of the algorithm, not copied text.
 *
 * The two constants below are the same regexes Obsidian uses internally
 * for this (`/^---(\r?\n)/g` and
 * `/---(\r?\n|$)/g`). The result: `to` DOES include the trailing newline
 * before the closing fence — `data.slice(from, to)` for
 * "---\ntype: topic\n---\nBody\n" is exactly "type: topic\n" — which is
 * what main.js's spliceSpotlightKey()/computeSpotlightWrite() were already built
 * against. This confirms that assumption rather than changing it.
 */
const OPEN_FENCE = /^---(\r?\n)/g;
const CLOSE_FENCE = /---(\r?\n|$)/g;

function getFrontMatterInfo(content) {
  OPEN_FENCE.lastIndex = 0;
  if (!OPEN_FENCE.exec(content)) {
    return { exists: false, contentStart: 0, from: 0, to: 0, frontmatter: '' };
  }
  const from = OPEN_FENCE.lastIndex;
  CLOSE_FENCE.lastIndex = from;
  let closeMatch = CLOSE_FENCE.exec(content);
  // The closing fence must start its own line — reject a "---" the regex
  // finds mid-line (e.g. inside a YAML string value) and keep scanning.
  while (closeMatch && content.charAt(closeMatch.index - 1) !== '\n') {
    closeMatch = CLOSE_FENCE.exec(content);
  }
  if (!closeMatch) {
    return { exists: false, contentStart: 0, from: 0, to: 0, frontmatter: '' };
  }
  const to = closeMatch.index;
  const contentStart = CLOSE_FENCE.lastIndex;
  return { exists: true, frontmatter: content.slice(from, to), from, to, contentStart };
}

/** Minimal TFile/TFolder-shaped plain objects — main.js duck-types both
 * (`isTFile`/`isTFolder`), so no real class is needed. */
export function makeFile(path, { content = '' } = {}) {
  const name = path.split('/').pop();
  const dot = name.lastIndexOf('.');
  return {
    path,
    name,
    basename: dot === -1 ? name : name.slice(0, dot),
    extension: dot === -1 ? '' : name.slice(dot + 1),
    _content: content,
    parent: null, // set by makeFolder() when this file is passed in as a child
  };
}

/** Sets `.parent` on each direct child, the same mutual back-reference
 * real TFolder/TFile objects carry — main.js's context-menu resolver
 * (resolveSpotlightTarget) walks `.parent`/`.parent.parent`, unlike the
 * discovery functions above it, which only ever walk `folder.children`
 * downward and never needed this before. Build fixtures innermost-first
 * (stub, then its entity-folder, then the lane, then the root) so each
 * folder already has its children built by the time it's constructed. */
export function makeFolder(path, children = []) {
  const name = path.split('/').pop();
  const folder = { path, name, children, parent: null };
  for (const child of children) child.parent = folder;
  return folder;
}

/** Recursively finds a child of `folder` (or `folder` itself) by path —
 * the search getAbstractFileByPath below runs against every root folder
 * a fixture registered. */
function findAbstractInFolder(folder, path) {
  if (folder.path === path) return folder;
  for (const child of folder.children || []) {
    if (child.path === path) return child;
    if (Array.isArray(child.children)) {
      const nested = findAbstractInFolder(child, path);
      if (nested) return nested;
    }
  }
  return null;
}

/** A vault stub covering exactly what main.js calls: getFolderByPath,
 * getAbstractFileByPath, process(), create(). `process()` mutates the
 * in-memory `_content` the same way Obsidian would mutate the file on
 * disk.
 *
 * `adapter.exists()`, 2026-09-07 —
 * added specifically to test refreshFolderToggles()'s new disambiguation:
 * a real Obsidian `vault.adapter.exists()` hits the filesystem directly,
 * independent of whatever the in-memory folder index (`getFolderByPath`)
 * currently knows, which is exactly the property that makes it useful for
 * telling "not indexed yet" apart from "genuinely doesn't exist." Defaults
 * to agreeing with `folders` (so every existing fixture that never heard
 * of this keeps working unchanged); pass `adapterExists` (a path predicate)
 * to a test that specifically wants the two to disagree — the "index
 * hasn't caught up, but the path is really there" fixture. */
export function makeVault({ folders = [], files = {}, adapterExists, adapterFiles = {} } = {}) {
  const foldersByPath = new Map(folders.map((f) => [f.path, f]));
  const created = [];
  const renameBus = makeBus();
  return {
    getFolderByPath: (path) => foldersByPath.get(path) || null,
    // `adapterFiles` (0.14.0, ICOR-awareness detection): a plain
    // `{path: content}` map standing in for raw filesystem reads OUTSIDE
    // the vault's own index -- a dot-folder like `.icor-for-life/` is
    // never indexed (main.js's own detection doc comment says so), so
    // `detectIcorScaffold()` reads it through `adapter.exists`/`adapter.
    // read` directly, never `getAbstractFileByPath`. A test wires the
    // manifest's raw text here, not into `files`/`folders`.
    adapter: {
      exists: async (path) => {
        if (Object.prototype.hasOwnProperty.call(adapterFiles, path)) return true;
        return typeof adapterExists === 'function' ? adapterExists(path) : foldersByPath.has(path);
      },
      read: async (path) => {
        if (Object.prototype.hasOwnProperty.call(adapterFiles, path)) return adapterFiles[path];
        throw new Error(`ENOENT: no such file, read '${path}'`);
      },
    },
    /** Searches every registered root folder's own subtree, then files
     * created via vault.create() during the test. Fixtures that only ever
     * do `app.vault._files[file.path] = file._content` WITHOUT also
     * wiring that file into a folder's `children` (a shortcut several
     * older gates use, since they never needed path-based lookup) are NOT
     * findable this way — deliberately: reconstructing a stand-in object
     * from raw content risks silently shadowing the real one (an empty
     * default `_content` would win over the fixture's actual stored
     * content). Register the file into a folder passed to makeApp's
     * `folders` when a test needs getAbstractFileByPath to see it. */
    getAbstractFileByPath: (path) => {
      for (const folder of folders) {
        const found = findAbstractInFolder(folder, path);
        if (found) return found;
      }
      return created.find((f) => f.path === path) || null;
    },
    process: async (file, fn) => {
      if (file.path in files === false && file._content === undefined) {
        throw new Error(`no such file in fixture: ${file.path}`);
      }
      const current = file._content !== undefined ? file._content : files[file.path];
      const next = fn(current);
      file._content = next;
      files[file.path] = next;
      return next;
    },
    create: async (path, content) => {
      if (files[path] !== undefined) throw new Error(`file already exists: ${path}`);
      // Case-insensitive-filesystem simulation (Windows/macOS default) —
      // added for the stub-adoption fixture (main.js's createLaneStub),
      // reproducing a real collision seen on Windows. A real Windows
      // vault.create() throws when a path differs from an existing one
      // only in case; this stub's own `files` keys are otherwise a plain
      // JS object (case-sensitive by default), so without this check a
      // fixture could never reproduce the failure this exists to test.
      const lower = path.toLowerCase();
      for (const existingPath of Object.keys(files)) {
        if (existingPath.toLowerCase() === lower && existingPath !== path) {
          throw new Error(`File already exists.`);
        }
      }
      const file = makeFile(path, { content });
      files[path] = content;
      created.push(file);
      return file;
    },
    // `.on(evt, cb)` / `._emit(evt, ...)` — a generic bus (despite the
    // `renameBus` name, kept from when this only needed to cover
    // 'rename') mirroring Obsidian's own vault events. Covers both
    // `.on('rename', ...)` (PRD §10 step 9, Spike 2's one
    // confirmed-necessary listener) and `.on('delete', ...)` (added
    // 2026-09-07 — a starred entity's backing file disappearing is a
    // different case Spike 2 never tested; see installRowInjection's own
    // doc comment). A test fires either manually; this stub's own
    // create()/process() don't trigger them.
    on: renameBus.on,
    _emit: renameBus._emit,
    _files: files,
    _created: created,
    // Exposed raw, same convention as `_files` above — lets a cold-boot
    // race fixture simulate "the vault index catches up" by registering a
    // folder AFTER construction (`vault._foldersByPath.set(path, folder)`),
    // the same way `leaves.push(leaf)` simulates a late-appearing
    // file-explorer leaf elsewhere in these fixtures.
    _foldersByPath: foldersByPath,
  };
}

/** A metadataCache stub: reads frontmatter straight from the fixture's
 * live file content via the same getFrontMatterInfo + a tiny YAML-ish
 * `spotlight:` line reader — enough to test getSpotlightState without a
 * real YAML parser. Deliberately reads ONLY `spotlight:` — a fixture's
 * `focus:` line (an unrelated key some other tool might write) is never picked
 * up here, matching main.js's own read site exactly (§ "reads spotlight
 * state" — never a `focus:` legacy fallback). `.on('changed', ...)` /
 * `._emit('changed', file)` mirror Obsidian's own event (main.js's
 * metadataCache.on('changed', ...) listener, wired for the hand-edit /
 * other-tool case and to self-correct the requestSort()-before-reparse
 * race after our own writes) — a test fires it manually with `._emit`,
 * since this stub's own `process()`/`create()` don't fire it
 * automatically the way a real Obsidian re-parse would. */
export function makeMetadataCache(vault) {
  const bus = makeBus();
  return {
    getFileCache: (file) => {
      const data = file._content !== undefined ? file._content : vault._files[file.path];
      if (typeof data !== 'string') return null;
      const fm = getFrontMatterInfo(data);
      if (!fm.exists) return null;
      const block = data.slice(fm.from, fm.to);
      const frontmatter = {};
      const spotlightMatch = /^spotlight:\s*(.*)$/m.exec(block);
      if (spotlightMatch) {
        const raw = spotlightMatch[1].trim();
        let value = raw;
        if (raw === 'true') value = true;
        else if (raw === 'false') value = false;
        else if (/^-?\d+$/.test(raw)) value = Number(raw);
        frontmatter.spotlight = value;
      }
      // `type:` — 0.4.0's own root-area gate (main.js's
      // getEntityFrontmatterType) needs this read alongside `spotlight:`,
      // same line-based extraction, no real YAML parser.
      const typeMatch = /^type:\s*(.*)$/m.exec(block);
      if (typeMatch) frontmatter.type = typeMatch[1].trim();
      return { frontmatter };
    },
    on: bus.on,
    _emit: bus._emit,
  };
}

/**
 * Simulates `getSortedFolderItems`'s real return shape: sorts
 * `folder.children` (real TFile/TFolder), then for each one looks it up
 * in `this.fileItems` and returns THAT row object — silently dropping any
 * child with no materialized `fileItems` entry, never the raw
 * abstract file itself.
 *
 * Reads `this.fileItems` (not a closed-over `view` reference) so it can
 * be assigned onto a fake view CLASS's prototype — the same shape
 * `around()`'s prototype patch needs to target, matching real Obsidian —
 * rather than as a one-off instance property, which the patch could never
 * see (an own property shadows the prototype method `around()` patches).
 * Typical fixture use:
 * `FakeExplorerView.prototype.getSortedFolderItems =
 * makeFileItemsSortedFolderItems();` then set `view.fileItems` per
 * instance as usual.
 *
 * @param {(children: Array, folder: object) => Array} [sortComparator] -
 *   defaults to identity (whatever order folder.children already has);
 *   pass one to simulate a member's own active sort mode.
 */
export function makeFileItemsSortedFolderItems(sortComparator = (children) => children) {
  return function getSortedFolderItems(folder) {
    const ordered = sortComparator(folder.children.slice(), folder);
    return ordered.map((child) => this.fileItems[child.path]).filter(Boolean);
  };
}

/** A minimal event bus: `.on(evt, cb)` registers and returns a ref object
 * (mirroring Obsidian's EventRef shape enough for registerEvent() to hold
 * it); `._emit(evt, ...args)` fires every registered callback for that
 * event — used to drive `workspace.on('file-menu', ...)` end-to-end in a
 * test without a real Obsidian window. */
function makeBus() {
  const handlers = {};
  return {
    on: (evt, cb) => {
      (handlers[evt] || (handlers[evt] = [])).push(cb);
      return { evt, cb };
    },
    /** Mirrors Obsidian's own `Events.prototype.offref`:
     * removes exactly the one listener the matching `on()` call returned,
     * by identity, never by re-matching `evt`/`cb` separately -- the same
     * one-shot-listener discipline `guardScrollAcrossHiddenBranchReveal`
     * depends on. */
    offref: (ref) => {
      if (!ref || !handlers[ref.evt]) return;
      handlers[ref.evt] = handlers[ref.evt].filter((cb) => cb !== ref.cb);
    },
    _emit: (evt, ...args) => {
      // Snapshot before iterating -- a listener that calls `offref` on
      // itself (or on another handler for the SAME event) during
      // dispatch, exactly what the new one-shot guard does, must not
      // skip or re-run a sibling listener because the live array
      // mutated mid-iteration. Mirrors real `Events.trigger()`'s own
      // safety here (it iterates a copy internally).
      for (const cb of (handlers[evt] || []).slice()) cb(...args);
    },
  };
}

/**
 * `getLeavesOfType('file-explorer')` defaults to an empty array — the
 * shape of "no file-explorer leaf found" that getFileExplorerView()
 * (main.js, PRD §8.1) already handles by degrading quietly. Every one of
 * the pre-§8/§9/§10 fixtures relies on this default so onload()'s new
 * installFileExplorerIntegration() call doesn't need touching in tests
 * that aren't about it. Pass `leaves` to opt a test into a real fixture
 * (see makeFileExplorerLeaf below).
 */
/**
 * `plugins` mirrors Obsidian's own `app.plugins` shape closely enough for
 * isCommunityPluginActive() (PRD §8.5, §10 step 13): `.plugins[id]`
 * (present + `._loaded`) and `.enabledPlugins` (a Set of ids). Defaults to
 * "nothing installed" — pass `plugins: { plugins: { X: { _loaded: true }
 * }, enabledPlugins: new Set(['X']) }` to simulate a conflicting plugin
 * being active.
 */
export function makeApp({
  folders = [],
  files = {},
  leaves = [],
  plugins = { plugins: {}, enabledPlugins: new Set() },
  layoutReady = true,
  adapterExists,
  adapterFiles = {},
} = {}) {
  const vault = makeVault({ folders, files, adapterExists, adapterFiles });
  const metadataCache = makeMetadataCache(vault);
  const workspaceBus = makeBus();
  // `onLayoutReady(cb)` — mirrors Obsidian's own idiom (main.js's cold-boot
  // retry path, 2026-09-07, calls back
  // immediately when the layout is already ready (`layoutReady: true`,
  // the default — most fixtures don't care), or queues the callback for a
  // test to fire manually via `app.workspace._fireLayoutReady()` when
  // constructed with `layoutReady: false` (the cold-boot-race fixture,
  // where the file-explorer leaf isn't in `leaves` yet at construction
  // time and gets added before firing this).
  let layoutReadyFired = layoutReady;
  const layoutReadyBus = makeBus();
  // `app.nextFrame(cb)`: mirrors the real, confirmed shape.
  // `nextFrame` pushes onto a single shared queue
  // (real Obsidian batches it behind one `requestAnimationFrame`; this
  // stub never fires automatically -- a test flushes it explicitly with
  // `app._runNextFrame()`, the same manual-flush convention this
  // harness's `debounce` stub already uses for a different async seam).
  // Queued in registration order and drained FIFO, matching real
  // Obsidian's own `onNextFrame` loop exactly -- this is the property
  // `positionRevealedRowOneThirdDown`'s own timing argument depends on: a
  // fixture's `revealInFolder` that ALSO queues through this same
  // `nextFrame` proves ordering, not just that both eventually ran.
  let nextFrameEvents = [];
  const workspace = {
    on: workspaceBus.on,
    offref: workspaceBus.offref,
    _emit: workspaceBus._emit,
    getLeavesOfType: (type) => (type === 'file-explorer' ? leaves : []),
    // The shelf's own reveal-and-open route (main.js revealEntityCandidate,
    // 0.4.0) asks for a leaf to open the file in — a plain fixture leaf
    // recording the last file opened is enough; no real pane management.
    getLeaf: () => ({
      openFile: async (file) => {
        workspace._lastOpenedFile = file;
      },
    }),
    onLayoutReady: (cb) => {
      if (layoutReadyFired) {
        cb();
        return;
      }
      layoutReadyBus.on('ready', cb);
    },
    _fireLayoutReady: () => {
      if (layoutReadyFired) return;
      layoutReadyFired = true;
      layoutReadyBus._emit('ready');
    },
  };
  return {
    vault,
    metadataCache,
    workspace,
    plugins,
    nextFrame: (cb) => {
      nextFrameEvents.push(cb);
    },
    /** Test-only: drains the queue exactly once, in registration order,
     * matching real Obsidian's own single-rAF `onNextFrame` pass. Not
     * auto-invoked -- a test calls it after triggering whatever queued
     * onto `nextFrame` (a fixture's own `revealInFolder`, then main.js's
     * own `positionRevealedRowOneThirdDown`) to assert the FINAL state
     * both left behind. */
    _runNextFrame: () => {
      const events = nextFrameEvents;
      nextFrameEvents = [];
      for (const cb of events) cb();
    },
  };
}

/**
 * A `WorkspaceLeaf`-shaped fixture holding a fake file-explorer `view`:
 * `loadIfDeferred()` (a no-op here — this harness never exercises the
 * deferred-view case itself, only that main.js calls it when present) and
 * `.view`. Pass `viewOverrides` to shape the view (fileItems,
 * requestSort, getSortedFolderItems, constructor.prototype, containerEl).
 */
export function makeFileExplorerLeaf(viewOverrides = {}) {
  const view = {
    fileItems: {},
    containerEl: makeFakeElement('div'),
    constructor: { prototype: {} },
    ...viewOverrides,
  };
  return {
    view,
    loadIfDeferred: async () => {},
  };
}

/** A minimal `view.tree.infinityScroll`-shaped fixture (0.8.1, the
 * shelf's row-position-a-third-down build): just enough surface for
 * `positionRevealedRowOneThirdDown` to run against. `scrollEl` is a
 * plain mutable `{ scrollTop, clientHeight, scrollHeight }` (the real
 * one is a DOM element; nothing here needs its other surface).
 * `findElementTop(item)` looks `item.file.path` up in `rowTops`, a plain
 * `path -> top` map the caller supplies -- this stubs OBSIDIAN's own
 * recursive virtual-tree measurement (real signature:
 * `findElementTop(target, rootEl, rootTop)`), not main.js's own code; a
 * gate on main.js's geometry math needs only a known input/output pair
 * for that call, never a reimplementation of Obsidian's real layout
 * algorithm. `compute()`/`updateVirtualDisplay()` are no-ops that count
 * their own calls, so a test can assert main.js called them (mirroring
 * `scrollIntoView`'s own preamble/postamble) without caring what a real
 * layout pass would have done. */
export function makeInfinityScrollFixture({ rowTops = {}, scrollTop = 0, clientHeight = 300, scrollHeight = 1000 } = {}) {
  const scrollEl = { scrollTop, clientHeight, scrollHeight };
  const rootEl = { info: { computed: true } };
  const infinityScroll = {
    scrollEl,
    rootEl,
    computeCalls: 0,
    compute() {
      infinityScroll.computeCalls += 1;
    },
    getRootTop() {
      return 0;
    },
    findElementTop(item) {
      const path = item && item.file && item.file.path;
      return path && Object.prototype.hasOwnProperty.call(rowTops, path) ? rowTops[path] : null;
    },
    updateVirtualDisplayCalls: 0,
    updateVirtualDisplay() {
      infinityScroll.updateVirtualDisplayCalls += 1;
    },
  };
  return { scrollEl, infinityScroll };
}

/** Returns an HTMLCollection-shaped snapshot of `arr`: numeric indices and
 * `.length`, iterable via `for...of`, but with NO Array.prototype methods --
 * a real HTMLCollection has no `indexOf`/`find`/`filter`/`map`, only Array
 * does; calling one on the real thing throws a TypeError. This reproduces
 * that on purpose (main.js called
 * `.indexOf` on `rows.children` in a real browser and threw before
 * `handleShelfStarActivate` ever ran; this harness's OLD `children: []`, a
 * plain Array, could not see the fault, so 85 tests stayed green on a
 * build that did not work). Not live in the strict DOM sense (each read
 * takes a fresh snapshot rather than sharing one mutable object), but that
 * distinction never matters here since nothing in this suite holds a
 * `.children` reference across a mutation. */
function collectionView(arr) {
  const view = { length: arr.length };
  for (let i = 0; i < arr.length; i++) view[i] = arr[i];
  view[Symbol.iterator] = function* () {
    for (let i = 0; i < view.length; i++) yield view[i];
  };
  return view;
}

/** A minimal fake DOM element — just enough surface for main.js's row-
 * injection and pinned-lane-style code (createElement / classList /
 * attributes / children / insertBefore / querySelector(':scope > .x') /
 * addEventListener) to run and be asserted against outside a real
 * browser. Not a general DOM shim — only the operations main.js actually
 * calls are implemented.
 *
 * `children` is exposed via the getter below as a `collectionView(...)` of
 * the element's own internal `_kids` array, never `_kids` itself -- so a
 * caller only ever sees the HTMLCollection-shaped, method-free snapshot.
 * `_kids` is this harness's own plumbing (appendChild/insertBefore/remove/
 * querySelector/querySelectorAll all mutate or read it directly) and a test
 * that needs Array methods on a node's children reaches for
 * `Array.from(el.children)`, matching what real production code has to do
 * against a real HTMLCollection too. */
export function makeFakeElement(tagName) {
  const listeners = {};
  const el = {
    tagName: String(tagName || 'div').toUpperCase(),
    id: '',
    _kids: [],
    get children() {
      return collectionView(el._kids);
    },
    parentNode: null,
    innerHTML: '',
    textContent: '',
    // Real DOM nodes always carry this (true once attached to the
    // document). main.js's own `ensureExplorerViewConnected` reads it to notice a
    // stale file-explorer view whose container left the document (the
    // File explorer tab closed/reopened, a workspace loaded) — a test
    // flips it to `false` directly to simulate that, rather than this
    // harness computing it from a real parent-chain walk.
    isConnected: true,
    // A minimal inline-style stub — just enough for main.js's own
    // measured-not-guessed indent reads/writes: `.style.paddingInlineStart` (settable by a
    // test, to simulate Obsidian's own inline indent) and
    // `.style.setProperty(name, value)` (main.js writes
    // `--spotlight-row-indent`/`--spotlight-shelf-indent` through this).
    // Real CSSStyleDeclaration also supports `getPropertyValue`; added
    // for symmetry even though nothing reads it back through that name
    // yet.
    style: {
      paddingInlineStart: '',
      _props: {},
      setProperty(name, value) {
        this._props[name] = value;
      },
      getPropertyValue(name) {
        return this._props[name] || '';
      },
      removeProperty(name) {
        delete this._props[name];
      },
    },
    _attrs: {},
    _classes: new Set(),
    get className() {
      return [...el._classes].join(' ');
    },
    set className(value) {
      el._classes = new Set(String(value).split(/\s+/).filter(Boolean));
    },
    classList: {
      add: (c) => el._classes.add(c),
      remove: (c) => el._classes.delete(c),
      toggle: (c, force) => {
        const on = force === undefined ? !el._classes.has(c) : !!force;
        if (on) el._classes.add(c);
        else el._classes.delete(c);
        return on;
      },
      contains: (c) => el._classes.has(c),
    },
    setAttribute: (name, value) => {
      el._attrs[name] = String(value);
    },
    getAttribute: (name) => (name in el._attrs ? el._attrs[name] : null),
    removeAttribute: (name) => {
      delete el._attrs[name];
    },
    // A no-op default (a real element also just accepts a `.focus()` call
    // silently in most cases). `makeFakeDocument().createElement` below
    // overrides this on every element IT creates -- the elements main.js
    // itself builds -- to actually move `document.activeElement`, since
    // that link is what `moveFocusBeforeRemoval()`'s guard depends on.
    focus: () => {},
    // Real DOM (the WHATWG "pre-insert" steps `appendChild`/`insertBefore`
    // both run through) removes a node from wherever it CURRENTLY lives
    // -- any parent, including this same one -- before placing it in its
    // new spot; a node is never a child of two places, or of the same
    // place twice. Added for the shelf-diff
    // rebuild fix: `diffShelfRows`' own "move an existing row into
    // position" step relies on exactly this, the same way a real browser
    // would -- without it, re-inserting an ALREADY-present child produced
    // a silent duplicate `_kids` entry instead of a move, an artifact of
    // this fake element, not of `diffShelfRows` itself (confirmed by
    // reverting the fix and watching the SAME test fail on the count, not
    // on which row moved).
    appendChild: (child) => {
      if (child.parentNode && typeof child.parentNode._kids === 'object') {
        const oldIdx = child.parentNode._kids.indexOf(child);
        if (oldIdx !== -1) child.parentNode._kids.splice(oldIdx, 1);
      }
      child.parentNode = el;
      el._kids.push(child);
      return child;
    },
    insertBefore: (child, refChild) => {
      if (child.parentNode && typeof child.parentNode._kids === 'object') {
        const oldIdx = child.parentNode._kids.indexOf(child);
        if (oldIdx !== -1) child.parentNode._kids.splice(oldIdx, 1);
      }
      child.parentNode = el;
      const idx = refChild ? el._kids.indexOf(refChild) : -1;
      if (idx === -1) el._kids.push(child);
      else el._kids.splice(idx, 0, child);
      return child;
    },
    remove: () => {
      if (!el.parentNode) return;
      const idx = el.parentNode._kids.indexOf(el);
      if (idx !== -1) el.parentNode._kids.splice(idx, 1);
      el.parentNode = null;
    },
    /** Supports exactly the one selector shape main.js uses: ':scope > .cls' */
    querySelector: (selector) => {
      const m = /^:scope\s*>\s*\.(.+)$/.exec(String(selector).trim());
      if (!m) throw new Error(`makeFakeElement.querySelector: unsupported selector "${selector}"`);
      const cls = m[1];
      return el._kids.find((c) => c.classList && c.classList.contains(cls)) || null;
    },
    /** Supports exactly the one shape main.js uses: a plain `.classname`
     * (recursive descendant search, matching real `querySelectorAll`'s
     * own default). Used by `sweepOrphanShelves`/`onunload`'s own F2
     * fix to find every
     * `.spotlight-shelf` anywhere under the explorer container,
     * regardless of depth. */
    querySelectorAll: (selector) => {
      const m = /^\.(.+)$/.exec(String(selector).trim());
      if (!m) throw new Error(`makeFakeElement.querySelectorAll: unsupported selector "${selector}"`);
      const cls = m[1];
      const results = [];
      const walk = (node) => {
        for (const child of node._kids) {
          if (child.classList && child.classList.contains(cls)) results.push(child);
          walk(child);
        }
      };
      walk(el);
      return results;
    },
    addEventListener: (evt, handler) => {
      (listeners[evt] || (listeners[evt] = [])).push(handler);
    },
    removeEventListener: (evt, handler) => {
      if (!listeners[evt]) return;
      listeners[evt] = listeners[evt].filter((h) => h !== handler);
    },
    // Returns each handler's own return value (an array) — most DOM
    // listeners return nothing, but main.js's own blur/Enter commit
    // handlers (F7, 2026-09-15) return their commit promise on purpose
    // exactly so a test can `await Promise.all(el._fire(...))` instead
    // of racing a real timer.
    //
    // BUBBLES to `parentNode` (0.7.0, folder-row fixture, design item 7).
    // A real DOM event bubbles by default, and main.js's own folder-row
    // star relies on that: its `stopPropagation()` is only a real
    // guarantee if NOT calling it would otherwise let the click reach a
    // folder row's own native collapse-toggle listener on an ancestor.
    // Before this, `_fire` only ever ran listeners on the exact element
    // it was called on, so a test could assert `evt._stopped === true`
    // but never that a parent's own listener was actually kept from
    // running: the "assumed, not tested for real" gap design item 7
    // exists to close. Stops climbing once `eventObj._stopped` is true
    // (set by `evt.stopPropagation()`, defined on `makeFakeEvent()`'s own
    // shape), checked AFTER this level's own listeners run, matching
    // real bubbling order (target first, then each ancestor, unless
    // stopped). A plain object with no `_stopped` property (several
    // existing fixtures fire `{}` directly) never sets it, so it simply
    // bubbles all the way to the top with no listeners found beyond the
    // one(s) already asserted against. Harmless: no other existing
    // fixture places conflicting listeners on an ancestor.
    _fire: (evt, eventObj) => {
      const results = [];
      for (const h of listeners[evt] || []) results.push(h(eventObj));
      if (el.parentNode && !(eventObj && eventObj._stopped)) {
        results.push(...el.parentNode._fire(evt, eventObj));
      }
      return results;
    },
  };
  return el;
}

/** A `MouseEvent`/`KeyboardEvent`-shaped mock: just enough for main.js's
 * click/keydown handlers (`stopPropagation`, `preventDefault`, `.key`,
 * `isTrusted`). `isTrusted` defaults to `true` — every existing call site
 * that builds one of these represents a real (simulated) user action;
 * pass `{ isTrusted: false }` explicitly to exercise the provenance gate
 * `handleStarActivate` added 2026-09-08 for a script-dispatched event. */
export function makeFakeEvent(overrides = {}) {
  const evt = {
    _stopped: false,
    _prevented: false,
    isTrusted: true,
    stopPropagation() {
      evt._stopped = true;
    },
    preventDefault() {
      evt._prevented = true;
    },
    ...overrides,
  };
  return evt;
}

/** `activeElement` is real, settable state here:
 * `moveFocusBeforeRemoval()`'s own guard reads
 * `document.activeElement !== star` before touching `rows.children`, and a
 * fixture needs to actually put the star there (`document.activeElement =
 * star`) to reach that code path at all -- a test that never sets it can
 * never exercise the branch the bug lived in, real Array-shaped `children`
 * or not. `createElement`'s elements get a working `.focus()` wired to
 * this SAME state (not a generic one); an element built directly via the
 * standalone `makeFakeElement` export elsewhere in a fixture keeps the
 * inert default and is never the thing under focus here, matching how
 * main.js only ever builds the star/row/title elements itself. */
function makeFakeDocument() {
  const head = makeFakeElement('head');
  // 0.13.3 (the shelf-indent rewrite, "f(root depth) only"): `document.body`
  // is what `measureShelfRail()` now reads a custom property off of --
  // always connected in a real browser, unlike any one root's own row, so
  // this fixture needs one too. `_customProperties` is this harness's own
  // plumbing (paired with the `getComputedStyle` stub `loadPlugin` wires
  // up below), not a real CSSOM -- a test sets it directly to control
  // what a controlled "theme" declares.
  const body = makeFakeElement('body');
  body._customProperties = {};
  const state = { activeElement: null };
  return {
    head,
    body,
    createElement: (tag) => {
      const el = makeFakeElement(tag);
      el.focus = () => {
        state.activeElement = el;
      };
      return el;
    },
    get activeElement() {
      return state.activeElement;
    },
    set activeElement(el) {
      state.activeElement = el;
    },
  };
}

/** A minimal `getComputedStyle(el)` stand-in -- just enough for
 * `measureShelfRail()`'s own `getPropertyValue('--nav-item-children-
 * margin-start')` read off `document.body`. Real `getComputedStyle`
 * resolves ANY element's cascaded/inherited values; this stub only ever
 * needs to answer for `document.body` itself (the one element
 * `measureShelfRail` reads), so it reads straight off `el._customProperties`
 * (a fixture sets `document.body._customProperties['--nav-item-children-
 * margin-start'] = '19px'` to simulate a theme that declares a
 * non-default value), defaulting to `''` -- the same "not declared"
 * shape a real browser returns for an unset custom property, which
 * `measureShelfRail`'s own `|| '12px'` fallback already handles. */
function makeGetComputedStyle() {
  return (el) => ({
    getPropertyValue: (name) => (el && el._customProperties && el._customProperties[name]) || '',
  });
}

/** A `Menu`-shaped mock: `.addItem(cb)` builds one `MenuItem`-shaped
 * object (`.setTitle`, `.setIcon`, `.onClick`, all chainable) and records
 * it in `.items` so a test can find the item Spotlight added and fire its
 * click handler directly. */
export function makeMenu() {
  const items = [];
  return {
    items,
    addItem(cb) {
      const item = {
        title: null,
        icon: null,
        clickHandler: null,
        setTitle(t) {
          item.title = t;
          return item;
        },
        setIcon(i) {
          item.icon = i;
          return item;
        },
        onClick(fn) {
          item.clickHandler = fn;
          return item;
        },
      };
      cb(item);
      items.push(item);
      return this;
    },
  };
}

/** A minimal DOM-element-shaped mock: `.empty()`, `.createEl(tag, opts)`,
 * `.createDiv(opts)` all nest further mocks of the same shape (recording
 * `tagName`/`text`/`cls`/`children`), so a settings tab that partitions
 * its own re-render (only rebuilding a sub-container, not the whole pane)
 * can be smoke-tested the same way the flat version was — AND, since
 * 2026-09-08, so a test can actually assert a
 * specific note's text/class rendered, via `_findAll(className)` below,
 * not just that `display()` didn't throw. Before this fix, `createEl`/
 * `createDiv` ignored their arguments entirely and returned a blank
 * element with nowhere to record what was asked for — every settings-tab
 * "note" assertion in this suite was structurally unable to see the text
 * a real member would read on screen. */
function makeEl(tagName = 'div') {
  const el = {
    tagName,
    // 0.15.1:
    // `.text` is READ-ONLY here, on purpose. A real Obsidian/DOM element
    // has no settable `.text` property on a plain span/div (the real API
    // is `HTMLElement.prototype.setText`, plus `createEl(tag, {text})`)
    // -- assigning `el.text = '...'` against a real element silently
    // creates an inert own property that changes nothing on screen.
    // Before this fix `.text` was a plain writable field here, so
    // main.js's own `stateEl.text = ...`/`pillEl.text = ...` bug (the
    // Tracked/Off label and the directory pill never updating live)
    // APPEARED to work in every test that read it back afterward, hiding
    // a real defect end to end. Only `setText()` (below) or
    // `createEl(tag, {text})` can change what this getter returns now --
    // the one real surface a plugin actually has for this, so a caller
    // that regresses back to a bare `.text =` write fails the very next
    // assertion that reads it.
    _text: '',
    get text() {
      return el._text;
    },
    setText(t) {
      el._text = String(t);
    },
    // 0.15.1:
    // `true` by default, matching `makeFakeElement`'s own identical
    // field/default -- a real DOM node carries this (true once attached
    // to the document), and a freshly-built settings-tab element is,
    // for every test that never says otherwise, exactly that: open, on
    // screen. A test flips it to `false` directly to simulate a closed
    // tab (`reloadSettingsFromDisk()`'s and the auto-reveal
    // `layout-change` listener's own new guards, main.js).
    isConnected: true,
    cls: [],
    children: [],
    _emptyCallCount: 0,
    _attrs: {},
    empty() {
      el._emptyCallCount += 1;
      el.children = [];
    },
    createEl(tag, opts = {}) {
      const child = makeEl(tag);
      if (opts.text !== undefined) child.setText(opts.text);
      if (opts.cls) child.cls = Array.isArray(opts.cls) ? opts.cls.slice() : String(opts.cls).split(/\s+/).filter(Boolean);
      if (opts.attr) {
        for (const [k, v] of Object.entries(opts.attr)) child._attrs[k] = String(v);
      }
      el.children.push(child);
      return child;
    },
    createDiv(opts = {}) {
      return el.createEl('div', opts);
    },
    // 0.15.0: real Obsidian elements support
    // both `.classList`/`.addClass`/`.removeClass` and `.setAttribute`/
    // `.getAttribute` -- added here so `containerEl.classList.add(
    // 'spotlight-settings')` and a section wrapper's own `data-section`
    // attribute (§5.2's own structure) both work the same way they would
    // against a real settings-tab `containerEl`, not just against a
    // `createEl()`-built child. `cls` (the plain array `_findAll` already
    // walks) and `classList` stay in sync either way.
    classList: {
      add: (c) => {
        if (!el.cls.includes(c)) el.cls.push(c);
      },
      remove: (c) => {
        el.cls = el.cls.filter((x) => x !== c);
      },
      toggle: (c, force) => {
        const on = force === undefined ? !el.cls.includes(c) : !!force;
        if (on) el.classList.add(c);
        else el.classList.remove(c);
        return on;
      },
      contains: (c) => el.cls.includes(c),
    },
    addClass: (c) => el.classList.add(c),
    removeClass: (c) => el.classList.remove(c),
    setAttribute: (name, value) => {
      el._attrs[name] = String(value);
    },
    getAttribute: (name) => (name in el._attrs ? el._attrs[name] : null),
    /** Recursively finds every descendant (this element's own subtree,
     * NOT itself) whose class list contains `className` — enough to
     * assert a settings-tab note actually rendered with the expected
     * text, without a real DOM/CSS engine. */
    _findAll(className) {
      const out = [];
      const walk = (node) => {
        for (const c of node.children || []) {
          if (c.cls && c.cls.includes(className)) out.push(c);
          walk(c);
        }
      };
      walk(el);
      return out;
    },
  };
  return el;
}

/**
 * Interactive `Setting`/component stubs: the settings tab's own onChange/onClick handlers — the
 * collision-refusal note on the add-root field and the edit-existing-root
 * field — were never actually exercised by this suite; the PREVIOUS
 * `Setting` stub was a `Proxy` that swallowed every `addText`/`addToggle`/
 * `addButton` callback without ever invoking it, so no test could reach
 * the handler a real member's keystroke or click fires). Each component
 * records the handler it's given and exposes a `type()`/`toggle()`/
 * `click()` test helper that invokes it — since this harness's own
 * `debounce()` (below) is a synchronous passthrough, calling `type()`
 * fires a debounced `onChange()` immediately, matching what a real
 * member would eventually see with no fake timer needed.
 */
class FakeTextComponent {
  constructor() {
    this.value = '';
    this.placeholder = '';
    this._onChange = null;
    // A real Obsidian TextComponent exposes `.inputEl` (the actual
    // `<input>`) for exactly this: a caller that needs a raw DOM event
    // (blur, a specific keydown) an onChange callback alone can't give
    // it. main.js's 0.4.1 root-path field
    // commits on blur/Enter via this, not on every keystroke.
    this.inputEl = makeFakeElement('input');
  }
  setPlaceholder(p) {
    this.placeholder = p;
    return this;
  }
  setValue(v) {
    this.value = v;
    return this;
  }
  onChange(cb) {
    this._onChange = cb;
    return this;
  }
  async type(v) {
    this.value = v;
    if (this._onChange) await this._onChange(v);
  }
  /** Test convenience: fires the same 'blur' event main.js's own
   * `text.inputEl.addEventListener('blur', ...)` listens for, and awaits
   * whatever the listener returned (main.js's own commit promise). */
  async blur() {
    await Promise.all(this.inputEl._fire('blur', {}));
  }
  /** Test convenience: an Enter keydown, matching main.js's own commit-
   * on-Enter listener. */
  async pressEnter() {
    await Promise.all(this.inputEl._fire('keydown', { key: 'Enter', preventDefault() {} }));
  }
}
class FakeToggleComponent {
  constructor() {
    this.value = false;
    this._onChange = null;
  }
  setValue(v) {
    this.value = v;
    return this;
  }
  setTooltip(t) {
    this.tooltip = t;
    return this;
  }
  onChange(cb) {
    this._onChange = cb;
    return this;
  }
  async toggle(v) {
    this.value = v;
    if (this._onChange) await this._onChange(v);
  }
}
class FakeButtonComponent {
  constructor() {
    this.text = '';
    this._onClick = null;
  }
  setButtonText(t) {
    this.text = t;
    return this;
  }
  setCta() {
    return this;
  }
  setIcon(i) {
    this.icon = i;
    return this;
  }
  onClick(cb) {
    this._onClick = cb;
    return this;
  }
  async click() {
    if (this._onClick) await this._onClick();
  }
}
class FakeExtraButtonComponent {
  constructor() {
    this._onClick = null;
  }
  setIcon(i) {
    this.icon = i;
    return this;
  }
  setTooltip(t) {
    this.tooltip = t;
    return this;
  }
  onClick(cb) {
    this._onClick = cb;
    return this;
  }
  async click() {
    if (this._onClick) await this._onClick();
  }
}
class FakeSetting {
  constructor(containerEl) {
    this.containerEl = containerEl;
    // Registers itself on its own containerEl so a test can retrieve the
    // Setting a settings-tab render just built (e.g. `addEl._settings[0]
    // .textComponent`) without main.js needing to hand back a reference —
    // matches how a real test would query the rendered DOM for the row it
    // cares about, just keyed on the fake element instead of a selector.
    if (containerEl) {
      containerEl._settings = containerEl._settings || [];
      containerEl._settings.push(this);
    }
  }
  setName(n) {
    this.nameText = n;
    return this;
  }
  setDesc(d) {
    this.descText = d;
    return this;
  }
  addText(cb) {
    this.textComponent = new FakeTextComponent();
    cb(this.textComponent);
    return this;
  }
  addToggle(cb) {
    this.toggleComponent = new FakeToggleComponent();
    cb(this.toggleComponent);
    return this;
  }
  addButton(cb) {
    this.buttonComponent = new FakeButtonComponent();
    cb(this.buttonComponent);
    return this;
  }
  addExtraButton(cb) {
    this.extraButtonComponent = new FakeExtraButtonComponent();
    cb(this.extraButtonComponent);
    return this;
  }
  // 0.15.0: a real, public `Setting` method
  // (marks the row a section heading, `setting-item-heading` in real
  // Obsidian's own CSS) -- the mockup's own §5.2 structure uses it for
  // every section's own title row. This mock has no real `settingEl` to
  // add a class to (a `FakeSetting` never becomes a DOM child at all,
  // only registers itself on `containerEl._settings` -- see the
  // constructor's own comment), so a plain flag stands in, checkable the
  // same way a test already reads `nameText`/`descText`.
  setHeading() {
    this.isHeading = true;
    return this;
  }
  // 0.15.0: a real, public `Setting` method (adds a class to the
  // row's own `settingEl`) -- used for `spotlight-dir-option`, the
  // "Spotlight folders too" row's own selector hook (§5.4's CSS rule
  // targets it directly: `.spotlight-dir-card .setting-item.spotlight-
  // dir-option`). Same "no real settingEl, a plain field stands in"
  // shape as `setHeading()` just above.
  setClass(cls) {
    this.extraClass = cls;
    return this;
  }
}

function makeObsidian() {
  class Component {
    constructor() {
      this._events = [];
    }
    registerEvent(e) {
      this._events.push(e);
    }
    addSettingTab() {}
    // mobile-support: a stand-in for the real `Plugin.addCommand`; a test
    // reads `plugin._commands` to see what the plugin registered.
    addCommand(cmd) {
      (this._commands = this._commands || []).push(cmd);
      return cmd;
    }
  }
  const obsidianModule = {
    // mobile-support (ruling m3s): the real `Platform` export. Every flag is
    // desktop by default; a test flips `obsidian.Platform.isMobile` /
    // `.isPhone` at runtime, which main.js reads at call time.
    Platform: { isMobile: false, isPhone: false, isTablet: false, isDesktop: true, isDesktopApp: true, isIosApp: false, isAndroidApp: false },
    Plugin: class extends Component {
      constructor(app, manifest) {
        super();
        this.app = app;
        this.manifest = manifest;
        this.saved = null;
      }
      async loadData() {
        return this.saved === null ? null : JSON.parse(JSON.stringify(this.saved));
      }
      async saveData(d) {
        this.saved = JSON.parse(JSON.stringify(d));
      }
    },
    PluginSettingTab: class {
      constructor(app, plugin) {
        this.app = app;
        this.plugin = plugin;
        this.containerEl = makeEl();
      }
    },
    Setting: FakeSetting,
    Notice: class {
      constructor(msg) {
        this.msg = msg;
      }
    },
    /** A `Menu`-shaped mock a plugin can `new Menu()` itself (the shelf's
     * own right-click route, which — unlike the `file-menu` route — gets
     * no menu handed to it by Obsidian) — same chainable `.addItem(cb)`
     * shape as the standalone `makeMenu()` helper above, so a test can
     * find the item Spotlight added and fire its click handler directly. */
    Menu: class {
      constructor() {
        this.items = [];
      }
      addItem(cb) {
        const item = {
          title: null,
          icon: null,
          clickHandler: null,
          setTitle(t) {
            item.title = t;
            return item;
          },
          setIcon(i) {
            item.icon = i;
            return item;
          },
          onClick(fn) {
            item.clickHandler = fn;
            return item;
          },
        };
        cb(item);
        this.items.push(item);
        return this;
      }
      showAtMouseEvent(evt) {
        this._shownAtEvent = evt;
      }
      showAtPosition(pos) {
        this._shownAtPosition = pos;
      }
    },
    // Synchronous passthrough — a gate cares that the eventual call
    // happens, not about the real timer in between (same choice the ICOR
    // suite's own test harness makes for the identical reason). This is
    // also what makes FakeTextComponent#type() above able to fire a
    // debounced onChange() immediately with no fake timer.
    debounce: (fn) => fn,
    getFrontMatterInfo,
    // A real, public Obsidian export (0.14.0, ICOR-awareness detection):
    // normalizes a path the same shape real Obsidian's own does -- forward
    // slashes, no leading/trailing slash, no doubled slash. Good enough
    // for `.icor-for-life/manifest.json` and `${manifest.dir}/data.json`,
    // the only two paths this plugin ever normalizes.
    normalizePath: (path) =>
      String(path)
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .replace(/^\//, '')
        .replace(/\/$/, ''),
    // A real, public export of the obsidian module — see
    // getInstalledAppVersionLabel's doc
    // comment in main.js. A fixed test value so getInstalledAppVersionLabel
    // has something to confirm against, not the fallback-only path.
    apiVersion: '1.13.7-test',
    // A real, public Obsidian export (`setIcon(el, iconId)`): clears
    // `el` and marks it with the icon id it was asked to render, cheap
    // enough for a test to assert against without a real Lucide sprite
    // sheet. main.js's own shelf-header chevron is one call site that uses this.
    // `.callCount` lets a test assert `syncBranchToggleEl`'s idempotence
    // directly — a same-value re-sync must do zero icon work. Scoped to
    // THIS `makeObsidian()` call (a fresh counter per `loadPlugin()`,
    // never shared across tests) via closure, not a module-level
    // singleton. A function property survives `typeof setIcon ===
    // 'function'` guards exactly like a plain function would.
    setIcon: Object.assign(
      (el, iconId) => {
        setIconFn.callCount++;
        if (!el) return;
        el.innerHTML = '';
        el.setAttribute('data-icon', iconId);
      },
      { callCount: 0 },
    ),
  };
  const setIconFn = obsidianModule.setIcon;
  return obsidianModule;
}

/** Loads main.js as a function in the CURRENT vm context (not a new
 * `vm.createContext` realm) — deliberately, so the plain objects/arrays
 * main.js builds (settings lists, classification results, ...) share this
 * file's own Object/Array prototypes. A separate-realm sandbox would make
 * `assert.deepEqual` report structurally-identical objects as unequal,
 * since Node's strict deep-equal also compares [[Prototype]] identity.
 * Returns the plugin class, the `__test` surface, the stub obsidian
 * module, and a `makePlugin(app, saved)`. */
/**
 * `document` / `MutationObserver` / `requestAnimationFrame` are passed as
 * extra parameters to the compiled function (alongside `require` /
 * `module` / `exports` / `console`) rather than left as free identifiers —
 * a function parameter shadows the outer scope, so any reference to these
 * names inside main.js resolves to what's passed here instead of Node's
 * real globals (which don't have `document` at all). In real Obsidian,
 * main.js is loaded as an ordinary CommonJS module in an Electron
 * renderer, where these ARE real browser globals — this only matters
 * inside this harness's sandboxed compileFunction call.
 *
 * `MutationObserver` is passed as `undefined` on purpose by default: it
 * exercises main.js's own `typeof MutationObserver !== 'undefined'` guard
 * (installRowInjection) rather than faking observer semantics this
 * harness doesn't need for the row-injection logic under test — the
 * MutationObserver wiring itself is source-level only, pending a live
 * confirmation pass.
 */
/**
 * `requestAnimationFrame` override, for testing
 * scheduleStarReapply's setTimeout backstop. The default here --
 * `(cb) => setTimeout(cb, 0)` -- fires quickly and would make a naive
 * "does the backstop rescue a stalled reapply" test pass on 0.3.1 too,
 * proving nothing (0.3.1's rAF-only scheduleStarReapply also resolves
 * fine when rAF itself resolves fine). A test that actually exercises the
 * backstop needs `requestAnimationFrame` to behave like the real,
 * confirmed-live symptom -- a callback that is registered but never
 * fires (window unfocused/hidden) -- which only `loadPlugin({
 * requestAnimationFrame: () => {} })` (a no-op override) can simulate.
 */
/**
 * A minimal `MutationObserver` stand-in for `loadPlugin({ MutationObserver
 * })`. Real
 * enough to exercise `installRowInjection`'s actual `new MutationObserver
 * (cb)` / `.observe()` / `.disconnect()` calls, but delivery is manual —
 * a test calls `instance.deliver(records)` (or `instance.deliver()` for a
 * bare, no-argument callback invocation, matching how a real browser can
 * call back with an empty/irrelevant record set) whenever it wants to
 * simulate a mutation batch landing, rather than this fake actually
 * watching the fake DOM. `observeCallCount`/`disconnectCallCount` let a
 * test assert the disconnect-around-own-writes discipline without needing
 * real mutation semantics at all. The single instance most recently
 * constructed is also kept on the class itself (`FakeMutationObserver
 * .lastInstance`) so a test that only has the `plugin` (not the raw
 * constructor closure) can still reach it after `installRowInjection()`
 * runs, exactly the way `plugin.starObserver` would let live code reach
 * it.
 */
export class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.observing = false;
    this.observeCallCount = 0;
    this.disconnectCallCount = 0;
    FakeMutationObserver.lastInstance = this;
  }
  observe(target, options) {
    this.observing = true;
    this.observeCallCount++;
    this.target = target;
    this.options = options;
  }
  disconnect() {
    this.observing = false;
    this.disconnectCallCount++;
  }
  takeRecords() {
    return [];
  }
  /** Simulates a real observer callback firing with `records` (an array
   * of `{ target, addedNodes, removedNodes }`-shaped objects — only the
   * fields main.js's own filter reads need to be present). Omit `records`
   * entirely to simulate a bare callback invocation. Silently a no-op
   * while `disconnect()`-ed, matching real `MutationObserver` semantics
   * (a disconnected observer never delivers, and never queues what
   * happened while it was disconnected). */
  deliver(records) {
    if (!this.observing) return;
    this.callback(records, this);
  }
}

export function loadPlugin({ requestAnimationFrame: rafOverride, MutationObserver: mutationObserverOverride } = {}) {
  const obsidian = makeObsidian();
  const fakeDocument = makeFakeDocument();
  const moduleObj = { exports: {} };
  const fn = vm.compileFunction(
    source,
    ['require', 'module', 'exports', 'console', 'document', 'window', 'MutationObserver', 'requestAnimationFrame', 'getComputedStyle'],
    { filename: 'main.js' },
  );
  fn(
    (name) => (name === 'obsidian' ? obsidian : nodeRequire(name)),
    moduleObj,
    moduleObj.exports,
    console,
    fakeDocument,
    // main.js now calls `window.setTimeout`/`window.clearTimeout`
    // (eslint-plugin-obsidianmd's no-bare-timer rule) instead of the
    // bare globals -- this harness has no real browser `window`, so it
    // provides one. Each method reads `globalThis.<name>` at CALL time,
    // not once here at load time, so a test that swaps in Node's own
    // mock timers afterward (`t.mock.timers.enable()`, which patches
    // `globalThis.setTimeout` in place) still reaches the mock -- a
    // stub that captured the real functions once, upfront, would keep
    // calling the ORIGINAL timers forever, deaf to a mock installed
    // later in the very same process.
    {
      setTimeout: (...args) => globalThis.setTimeout(...args),
      clearTimeout: (...args) => globalThis.clearTimeout(...args),
      setInterval: (...args) => globalThis.setInterval(...args),
      clearInterval: (...args) => globalThis.clearInterval(...args),
    },
    // `undefined` by default (still exercises
    // main.js's own `typeof MutationObserver !== 'undefined'` guard in
    // `installRowInjection`). A real constructor can be passed too, to
    // test the fix for a burst of externally-triggered explorer
    // mutations driving an unbounded reapply-pass rate — this adds the ability to
    // pass a real constructor through — `FakeMutationObserver` below —
    // so a test can drive `installRowInjection`'s actual observer
    // wiring (the callback it registers, the records it filters) instead
    // of only ever exercising the no-observer branch.
    mutationObserverOverride,
    rafOverride || ((cb) => setTimeout(cb, 0)),
    makeGetComputedStyle(),
  );
  const PluginClass = moduleObj.exports;
  return {
    PluginClass,
    __test: PluginClass.__test,
    obsidian,
    document: fakeDocument,
    makePlugin(app, saved = null) {
      // `name` added 2026-09-08 (the settings
      // tab's own <h2> must read `this.manifest.name`, never a hardcoded
      // string, so it can't drift from manifest.json again) — matches the
      // real shipped manifest's own `name` field exactly.
      const plugin = new PluginClass(app, { id: 'spotlight', name: 'Spotlight', version: '0.0.0-gate' });
      plugin.saved = saved;
      return plugin;
    },
  };
}
