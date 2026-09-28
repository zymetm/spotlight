import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugin, makeFile, makeFolder, makeApp, makeMenu } from './harness.mjs';

const { __test, makePlugin } = loadPlugin();
const {
  defaultSettings,
  migrateSettings,
  normalizeRootPath,
  rootsCollide,
  ROOT_COLLISION_MESSAGE,
  findOwningRootEntry,
  DEFAULT_ROOT_PATH,
  isTFile,
  isTFolder,
  findEntityCandidates,
  computeStarredCandidates,
  coerceSpotlightBoolean,
  spliceSpotlightKey,
  computeSpotlightWrite,
  getSpotlightState,
  setSpotlightState,
  todayISODate,
  toggleEntitySpotlight,
  resolveSpotlightTarget,
  addSpotlightMenuItem,
  MENU_CLICK_MAX_AGE_MS,
  getFolderStarredPaths,
  isFolderStarred,
  setFolderStarred,
  toggleFolderSpotlight,
  renameFolderStarredPaths,
  deleteFolderStarredPaths,
  getStarredPaths,
  isPathStarred,
  setPathStarred,
  togglePathSpotlight,
  renamePathStarredPaths,
  deletePathStarredPaths,
  computeStaleStarredPaths,
  cleanupStaleStarredPaths,
  usesPathStore,
  candidateNode,
  candidatePath,
  getCandidateStarState,
  setCandidateStarState,
  toggleCandidateSpotlight,
  spotlightFileIconName,
} = __test;

/* ======================================================================
 * Settings model — defaults, migration (three shapes), collision
 * ==================================================================== */

test('defaultSettings (REVISES the old "seeds the five My Life areas unconditionally" rule -- ambiguous = start EMPTY with a first-directory guide): no roots, no guide dismissed, everything else still empty', () => {
  const settings = defaultSettings();
  // An earlier version unconditionally seeded the five My Life areas on
  // every fresh install, blind to whether the vault was ever an ICOR
  // vault at all -- a non-ICOR vault can have its own,
  // differently-rooted "My Life" folders live elsewhere, not
  // `04 Inner World/My Life/`, so every one of the five degraded to an
  // inactive settings-tab note rather than genuinely empty. The seed is
  // now conditional and async -- see `detectIcorScaffold`/
  // `computeIcorSeededRoots` and the SpotlightPlugin.onload() tests
  // below for where it actually runs.
  assert.deepEqual(settings.roots, []);
  assert.deepEqual(settings.collapsedShelfRoots, []);
  // Every branch showing by default, mirroring
  // collapsedShelfRoots exactly.
  assert.deepEqual(settings.collapsedBranchRoots, []);
  // 0.14.0: the empty-state guide shows by default (nothing dismissed
  // yet) -- computed from `roots.length === 0 && !guideDismissed`, never
  // a separate "showing" flag.
  assert.equal(settings.guideDismissed, false);
});

test('migrateSettings: null/undefined (fresh install) -> defaults, not flagged migrated', () => {
  assert.deepEqual(migrateSettings(null).settings, defaultSettings());
  assert.equal(migrateSettings(null).migrated, false);
  assert.deepEqual(migrateSettings(undefined).settings, defaultSettings());
});

test('migrateSettings: the real installed 0.3.5 shape -- default root\'s lanes explode into five area roots, the nested custom root collapses to a plain root, and the colliding pair (Projects off / Projects-personal on) dedupes to the more specific one', () => {
  const loaded = {
    roots: [
      {
        path: '04 Inner World/My Life',
        lanes: [
          { folderName: 'Key Elements', enabled: true },
          { folderName: 'Habits', enabled: true },
          { folderName: 'Goals', enabled: true },
          { folderName: 'Topics', enabled: true },
          { folderName: 'Projects', enabled: false },
        ],
      },
      {
        path: '04 Inner World/My Life/Projects/personal',
        lanes: [
          { folderName: 'Game Design Automation', enabled: true },
          { folderName: 'Spotlight — Obsidian Plugin', enabled: true },
        ],
      },
    ],
  };
  const { settings, migrated } = migrateSettings(loaded);
  assert.equal(migrated, true);
  // '.../Projects' (off) collides with '.../Projects/personal' (on) --
  // the longer/more specific path wins, the shorter one is dropped
  // entirely (F8): no colliding pair survives migration.
  assert.deepEqual(settings.roots, [
    { path: '04 Inner World/My Life/Key Elements', enabled: true, spotlightFolders: false },
    { path: '04 Inner World/My Life/Habits', enabled: true, spotlightFolders: false },
    { path: '04 Inner World/My Life/Goals', enabled: true, spotlightFolders: false },
    { path: '04 Inner World/My Life/Topics', enabled: true, spotlightFolders: false },
    { path: '04 Inner World/My Life/Projects/personal', enabled: true, spotlightFolders: false },
  ]);
  assert.deepEqual(settings.collapsedShelfRoots, []);
  assert.deepEqual(settings.starredPaths, []);
});

test('migrateSettings (F8): the migration output never contains a colliding pair, checked generically against rootsCollide', () => {
  const { settings } = migrateSettings({
    roots: [
      { path: '04 Inner World/My Life', lanes: [{ folderName: 'Projects', enabled: false }] },
      { path: '04 Inner World/My Life/Projects/personal', lanes: [] },
    ],
  });
  for (let i = 0; i < settings.roots.length; i++) {
    for (let j = i + 1; j < settings.roots.length; j++) {
      assert.equal(rootsCollide(settings.roots[i].path, settings.roots[j].path), false, `${settings.roots[i].path} vs ${settings.roots[j].path}`);
    }
  }
});

test('migrateSettings: ancient {rootPath, folders} shape -- one root, own lanes carried through the same explode/collapse rule', () => {
  const { settings, migrated } = migrateSettings({
    rootPath: '04 Inner World/My Life',
    folders: [{ folderName: 'Topics', enabled: true }, { folderName: 'Projects', enabled: false }],
  });
  assert.equal(migrated, true);
  assert.deepEqual(settings.roots, [
    { path: '04 Inner World/My Life/Topics', enabled: true, spotlightFolders: false },
    { path: '04 Inner World/My Life/Projects', enabled: false, spotlightFolders: false },
  ]);
});

test('migrateSettings: ancient shape with no folders at all -- one plain enabled root at rootPath, nothing lost', () => {
  const { settings, migrated } = migrateSettings({ rootPath: 'Workspace', folders: [] });
  assert.equal(migrated, true);
  assert.deepEqual(settings.roots, [{ path: 'Workspace', enabled: true, spotlightFolders: false }]);
});

test('migrateSettings: already current {roots:[{path,enabled}]} shape -- passed through, not flagged migrated, a missing `enabled` reads as true', () => {
  const { settings, migrated } = migrateSettings({ roots: [{ path: 'Workspace', enabled: false }, { path: '04 Inner World/My Life/Goals' }] });
  assert.equal(migrated, false);
  assert.deepEqual(settings.roots, [
    { path: 'Workspace', enabled: false, spotlightFolders: false },
    { path: '04 Inner World/My Life/Goals', enabled: true, spotlightFolders: false },
  ]);
});

test('migrateSettings (0.7.0): a 0.6.1 data.json shape (no spotlightFolders/starredPaths at all) adds spotlightFolders: false per root and starredPaths: [] -- everything else identical', () => {
  const loaded061 = {
    roots: [
      { path: '04 Inner World/My Life/Goals', enabled: true },
      { path: 'Workspace', enabled: false },
    ],
    collapsedShelfRoots: ['Workspace'],
  };
  const { settings, migrated } = migrateSettings(loaded061);
  assert.equal(migrated, false);
  assert.deepEqual(settings.roots, [
    { path: '04 Inner World/My Life/Goals', enabled: true, spotlightFolders: false },
    { path: 'Workspace', enabled: false, spotlightFolders: false },
  ]);
  assert.deepEqual(settings.collapsedShelfRoots, ['Workspace']);
  assert.deepEqual(settings.starredPaths, []);
});

test('migrateSettings (0.7.0): a root that already carries spotlightFolders: true, and a settings object that already carries starredPaths, both survive the round-trip unchanged', () => {
  const { settings } = migrateSettings({
    roots: [{ path: 'Workspace', enabled: true, spotlightFolders: true }],
    starredPaths: ['Workspace/Some Bucket'],
  });
  assert.deepEqual(settings.roots, [{ path: 'Workspace', enabled: true, spotlightFolders: true }]);
  assert.deepEqual(settings.starredPaths, ['Workspace/Some Bucket']);
});

test('migrateSettings: collapsedShelfRoots survives a settings round-trip on the already-current shape; missing on load reads as []', () => {
  const withCollapsed = migrateSettings({ roots: [{ path: 'Workspace', enabled: true }], collapsedShelfRoots: ['Workspace'] });
  assert.deepEqual(withCollapsed.settings.collapsedShelfRoots, ['Workspace']);

  const withoutCollapsed = migrateSettings({ roots: [{ path: 'Workspace', enabled: true }] });
  assert.deepEqual(withoutCollapsed.settings.collapsedShelfRoots, []);
});

test('migrateSettings: collapsedBranchRoots survives a settings round-trip on the already-current shape; missing on load reads as [] -- never forces a migrated flag on its own', () => {
  const withHidden = migrateSettings({ roots: [{ path: 'Workspace', enabled: true }], collapsedBranchRoots: ['Workspace'] });
  assert.deepEqual(withHidden.settings.collapsedBranchRoots, ['Workspace']);
  assert.equal(withHidden.migrated, false);

  const withoutHidden = migrateSettings({ roots: [{ path: 'Workspace', enabled: true }] });
  assert.deepEqual(withoutHidden.settings.collapsedBranchRoots, []);
  assert.equal(withoutHidden.migrated, false);
});

test('migrateSettings: a 0.12.0 shape (no collapsedBranchRoots at all, the real pre-0.13.0 data.json) migrates to collapsedBranchRoots: [] -- every other field byte-identical', () => {
  const loaded012 = {
    roots: [{ path: '04 Inner World/My Life/Projects', enabled: true, spotlightFolders: true }],
    collapsedShelfRoots: ['04 Inner World/My Life/Projects'],
    starredPaths: ['04 Inner World/My Life/Projects/Some Bucket'],
  };
  const { settings, migrated } = migrateSettings(loaded012);
  assert.equal(migrated, false);
  assert.deepEqual(settings.collapsedBranchRoots, []);
  assert.deepEqual(settings.roots, [{ path: '04 Inner World/My Life/Projects', enabled: true, spotlightFolders: true }]);
  assert.deepEqual(settings.collapsedShelfRoots, ['04 Inner World/My Life/Projects']);
  assert.deepEqual(settings.starredPaths, ['04 Inner World/My Life/Projects/Some Bucket']);
});

test('migrateSettings: the real 0.3.x-shape migration path also lands on collapsedBranchRoots: []', () => {
  const { settings } = migrateSettings({ rootPath: 'Workspace', folders: [{ folderName: 'Workstreams', enabled: true }] });
  assert.deepEqual(settings.collapsedBranchRoots, []);
});

test('normalizeRootPath / rootsCollide: ancestor, descendant, duplicate all collide; siblings do not', () => {
  assert.equal(normalizeRootPath('Workspace/'), 'Workspace');
  assert.equal(rootsCollide('Workspace', 'Workspace'), true);
  assert.equal(rootsCollide('Workspace', 'Workspace/Sub'), true);
  assert.equal(rootsCollide('Workspace/Sub', 'Workspace'), true);
  assert.equal(rootsCollide('Workspace', '04 Inner World'), false);
});

test('findOwningRootEntry: picks the most specific ENABLED root; a disabled outer root never wins even when it matches', () => {
  const roots = [
    { path: '04 Inner World/My Life/Projects', enabled: false },
    { path: '04 Inner World/My Life/Projects/personal', enabled: true },
  ];
  const found = findOwningRootEntry(roots, '04 Inner World/My Life/Projects/personal/Spotlight — Obsidian Plugin/Spotlight — Obsidian Plugin.md');
  assert.equal(found.path, '04 Inner World/My Life/Projects/personal');
  assert.equal(findOwningRootEntry(roots, '04 Inner World/My Life/Projects/client/Cardboard Alchemy.md'), null); // only the disabled root covers this path
});

/* ======================================================================
 * Discovery — carrier vs. grouping vs. flat, at depth 1-4
 * ==================================================================== */

test('findEntityCandidates: a flat note at root depth is a candidate', () => {
  const note = makeFile('Goals/Reach Goal Weight.md');
  const root = makeFolder('Goals', [note]);
  const candidates = findEntityCandidates(root, {});
  assert.deepEqual(candidates, [{ kind: 'flat', entityNote: note }]);
});

// RETIRED: the old "carrier folder"
// convention is gone. A folder that happens to hold a same-named `.md`
// note is now an ordinary grouping folder, always walked, never special;
// the note is an ordinary flat candidate. The tests below replace the
// old carrier-specific assertions ("nothing inside it is walked", "a
// carrier is doubled") with the new flat behaviour.

test('findEntityCandidates: a folder holding a same-named note (the old GL-063 shape) at depth 2 -- the note is an ordinary flat candidate, and content inside the folder IS walked now', () => {
  const innerNote = makeFile('Projects/client/Cardboard Alchemy/support/notes.md');
  const support = makeFolder('Projects/client/Cardboard Alchemy/support', [innerNote]);
  const stub = makeFile('Projects/client/Cardboard Alchemy/Cardboard Alchemy.md');
  const sameNamedFolder = makeFolder('Projects/client/Cardboard Alchemy', [stub, support]);
  const bucket = makeFolder('Projects/client', [sameNamedFolder]);
  const root = makeFolder('Projects', [bucket]);
  const candidates = findEntityCandidates(root, {});
  // The stub note is a flat candidate, AND the note nested inside the
  // support/ folder is now ALSO reached and found -- there is no more
  // carrier boundary stopping the walk at "Cardboard Alchemy".
  assert.deepEqual(candidates, [
    { kind: 'flat', entityNote: stub },
    { kind: 'flat', entityNote: innerNote },
  ]);
});

test('findEntityCandidates: depth 4 -- a same-named note three grouping folders down is found as a flat candidate; every grouping folder above it is never a candidate with the folder toggle off', () => {
  const stub = makeFile('Root/a/b/c/Entity/Entity.md');
  const sameNamedFolder = makeFolder('Root/a/b/c/Entity', [stub]);
  const c = makeFolder('Root/a/b/c', [sameNamedFolder]);
  const b = makeFolder('Root/a/b', [c]);
  const a = makeFolder('Root/a', [b]);
  const root = makeFolder('Root', [a]);
  const candidates = findEntityCandidates(root, {});
  assert.deepEqual(candidates, [{ kind: 'flat', entityNote: stub }]);
  const candidatePaths = candidates.map((c2) => c2.entityNote.path);
  assert.ok(!candidatePaths.includes('Root/a'));
  assert.ok(!candidatePaths.includes('Root/a/b'));
  assert.ok(!candidatePaths.includes('Root/a/b/c'));
});

test('findEntityCandidates: spotlightFolders default (omitted) -- no folder candidates, ever, same-named note or not', () => {
  const stub = makeFile('Root/a/b/c/Entity/Entity.md');
  const sameNamedFolder = makeFolder('Root/a/b/c/Entity', [stub]);
  const c = makeFolder('Root/a/b/c', [sameNamedFolder]);
  const b = makeFolder('Root/a/b', [c]);
  const a = makeFolder('Root/a', [b]);
  const root = makeFolder('Root', [a]);
  const candidates = findEntityCandidates(root, {});
  assert.deepEqual(candidates, [{ kind: 'flat', entityNote: stub }]);
  assert.equal(candidates.some((cand) => cand.kind === 'folder'), false);
});

test('findEntityCandidates: spotlightFolders: true -- every grouping folder at depth 1, 3, AND the depth-4 folder that happens to share its note\'s name are ALL "folder" candidates, and the note is its own independent "flat" candidate, not a doubled pair', () => {
  const stub = makeFile('Root/a/b/c/Entity/Entity.md');
  const sameNamedFolder = makeFolder('Root/a/b/c/Entity', [stub]);
  const c = makeFolder('Root/a/b/c', [sameNamedFolder]);
  const b = makeFolder('Root/a/b', [c]);
  const a = makeFolder('Root/a', [b]);
  const root = makeFolder('Root', [a]);
  const candidates = findEntityCandidates(root, { spotlightFolders: true });

  const folderPaths = candidates
    .filter((cand) => cand.kind === 'folder')
    .map((cand) => cand.target.path)
    .sort();
  assert.deepEqual(folderPaths, ['Root/a', 'Root/a/b', 'Root/a/b/c', 'Root/a/b/c/Entity'].sort());

  assert.equal(candidates.some((cand) => candidatePath(cand) === 'Root'), false);

  // The same-named note is a flat candidate -- neither doubled nor
  // merged with its folder's own candidate; exactly two independent
  // candidates share that branch, the folder's and the note's.
  assert.equal(candidates.filter((cand) => cand.kind === 'flat').length, 1);
  assert.equal(candidates.some((cand) => cand.kind === 'folder' && cand.target.path === sameNamedFolder.path), true);
  assert.equal(candidates.filter((cand) => candidatePath(cand) === sameNamedFolder.path || candidatePath(cand) === stub.path).length, 2);
});

test('findEntityCandidates: spotlightFolders: true -- every folder is a candidate, and every note is a candidate too, with no type: check anywhere, including a note nested inside a folder that shares its own name', () => {
  const stub = makeFile('Goals/Fitness/Fitness.md', { content: '---\ntype: goal\n---\n' });
  const innerNote = makeFile('Goals/Fitness/inner-note.md');
  const sameNamedFolder = makeFolder('Goals/Fitness', [stub, innerNote]);
  const bucket = makeFolder('Goals/Bucket', [sameNamedFolder]);
  const root = makeFolder('Goals', [bucket]);
  const candidates = findEntityCandidates(root, { spotlightFolders: true });

  // Every folder is a candidate, typed root or not.
  assert.ok(candidates.some((cand) => cand.kind === 'folder' && cand.target.path === 'Goals/Bucket'));
  assert.ok(candidates.some((cand) => cand.kind === 'folder' && cand.target.path === 'Goals/Fitness'));
  // Both notes are flat candidates -- Fitness.md (which carries `type:
  // goal`) and inner-note.md (which carries no `type:` at all): the
  // check that used to require a match is gone, so neither note's
  // own frontmatter matters here any more.
  assert.deepEqual(
    candidates.filter((cand) => cand.kind === 'flat').map((cand) => cand.entityNote.path).sort(),
    [innerNote.path, stub.path].sort(),
  );
});

test('findEntityCandidates: any root accepts any .md note, with no type: check at all', () => {
  const anything = makeFile('Workspace/Some Task.md');
  const root = makeFolder('Workspace', [anything]);
  const candidates = findEntityCandidates(root, {});
  assert.deepEqual(candidates, [{ kind: 'flat', entityNote: anything }]);
});

// FLIPPED: every file in a tracked
// directory is now star-able. A non-.md flat file used to be
// skipped outright (0.9.0 and earlier) -- it is now a `kind: 'file'`
// candidate, unconditionally, at any depth under an enabled root, the
// same way a non-carrier folder became one at 0.7.0. This test's own
// name and assertion are the exact inverse of what they were before this
// build.
test('findEntityCandidates: a non-.md flat file IS a candidate, kind "file", target the TFile', () => {
  const asset = makeFile('Goals/cover.png');
  const root = makeFolder('Goals', [asset]);
  assert.deepEqual(findEntityCandidates(root, {}), [{ kind: 'file', target: asset }]);
});

test('findEntityCandidates: a non-.md file is not gated by spotlightFolders -- unconditional either way', () => {
  const asset = makeFile('Goals/cover.png');
  const root = makeFolder('Goals', [asset]);
  const off = findEntityCandidates(root, { spotlightFolders: false });
  const on = findEntityCandidates(root, { spotlightFolders: true });
  assert.deepEqual(off, [{ kind: 'file', target: asset }]);
  assert.deepEqual(on, [{ kind: 'file', target: asset }]);
});

test('findEntityCandidates: a non-.md file beside a same-named note IS a candidate now -- the old carrier boundary that used to exclude it is gone', () => {
  const stub = makeFile('X/X.md');
  const sibling = makeFile('X/sibling.png');
  const sameNamedFolder = makeFolder('X', [stub, sibling]);
  const root = makeFolder('Root', [sameNamedFolder]);
  const candidates = findEntityCandidates(root, {});
  // Both the note and the PNG beside it are found -- there is no more
  // carrier boundary stopping either one: a folder with a markdown file
  // and two PNG images is no longer distinguishable from any other folder.
  assert.deepEqual(candidates, [
    { kind: 'flat', entityNote: stub },
    { kind: 'file', target: sibling },
  ]);
});

test('findEntityCandidates: a non-.md file inside a PLAIN (non-carrier) bucket folder IS a candidate, at any depth', () => {
  const deepAsset = makeFile('Root/Bucket/Sub/diagram.png');
  const sub = makeFolder('Root/Bucket/Sub', [deepAsset]);
  const bucket = makeFolder('Root/Bucket', [sub]);
  const root = makeFolder('Root', [bucket]);
  const candidates = findEntityCandidates(root, {});
  assert.deepEqual(candidates, [{ kind: 'file', target: deepAsset }]);
});

test('findEntityCandidates: a .base file is just a file candidate -- closes the 2026-09-09 "bases starrable" task', () => {
  const base = makeFile('Goals/tracker.base');
  const root = makeFolder('Goals', [base]);
  assert.deepEqual(findEntityCandidates(root, {}), [{ kind: 'file', target: base }]);
});

test('computeStarredCandidates: only the starred subset, root order preserved', () => {
  const a = makeFile('Goals/A.md');
  const b = makeFile('Goals/B.md');
  const root = makeFolder('Goals', [a, b]);
  const starred = computeStarredCandidates(root, {
    isStarred: (note) => note === b,
  });
  assert.deepEqual(starred, [{ kind: 'flat', entityNote: b }]);
});

/* ======================================================================
 * Storage layer — unchanged behavior, re-confirmed against the new file
 * ==================================================================== */

test('coerceSpotlightBoolean: true/1/"true"/"yes"/"1" (any case, trimmed) -> true; everything else -> false', () => {
  assert.equal(coerceSpotlightBoolean(true), true);
  assert.equal(coerceSpotlightBoolean(1), true);
  assert.equal(coerceSpotlightBoolean(' TRUE '), true);
  assert.equal(coerceSpotlightBoolean('yes'), true);
  assert.equal(coerceSpotlightBoolean('1'), true);
  assert.equal(coerceSpotlightBoolean(false), false);
  assert.equal(coerceSpotlightBoolean('no'), false);
  assert.equal(coerceSpotlightBoolean(undefined), false);
});

test('spliceSpotlightKey / computeSpotlightWrite: replaces an existing key wherever it sits, appends when turning on, omits when turning off, fences a bare note', () => {
  assert.equal(spliceSpotlightKey('type: goal\n', true), 'type: goal\nspotlight: true\n');
  assert.equal(spliceSpotlightKey('spotlight: true\ntype: goal\n', false), 'type: goal\n');
  assert.equal(computeSpotlightWrite('Body only, no fence\n', true), '---\nspotlight: true\n---\nBody only, no fence\n');
  assert.equal(computeSpotlightWrite('Body only, no fence\n', false), 'Body only, no fence\n');
});

test('toggleEntitySpotlight: flips current state and writes it; null on a failed write', async () => {
  const app = makeApp({ files: { 'Goals/A.md': '---\ntype: goal\n---\n' } });
  const note = makeFile('Goals/A.md', { content: '---\ntype: goal\n---\n' });
  const result = await toggleEntitySpotlight(app, note);
  assert.equal(result, true);
  assert.equal(getSpotlightState(app, note), true);
});

test('todayISODate: local YYYY-MM-DD shape', () => {
  assert.match(todayISODate(), /^\d{4}-\d{2}-\d{2}$/);
});

/* ======================================================================
 * Folder star storage -- data.json's
 * own `starredPaths`, the one named exception to "never touch data.json"
 * ==================================================================== */

/** A minimal plugin-shaped fixture -- just `settings` + `saveSettings()`
 * -- for the storage-layer functions below, none of which touch the
 * vault or the explorer at all. */
function makeStoragePlugin(starredPaths = []) {
  const plugin = { settings: { roots: [], starredPaths } };
  plugin.saveSettings = async () => {
    plugin._saved = JSON.parse(JSON.stringify(plugin.settings));
  };
  return plugin;
}

test('getFolderStarredPaths / isFolderStarred: reads settings.starredPaths, defaulting to [] when missing or malformed', () => {
  assert.deepEqual(getFolderStarredPaths({ settings: {} }), []);
  assert.deepEqual(getFolderStarredPaths({ settings: { starredPaths: 'not-an-array' } }), []);
  const plugin = makeStoragePlugin(['Workspace/Bucket']);
  assert.deepEqual(getFolderStarredPaths(plugin), ['Workspace/Bucket']);
  assert.equal(isFolderStarred(plugin, 'Workspace/Bucket'), true);
  assert.equal(isFolderStarred(plugin, 'Workspace/Other'), false);
});

test('setFolderStarred: adds on true, removes on false, persists via saveSettings, never duplicates', async () => {
  const plugin = makeStoragePlugin([]);
  await setFolderStarred(plugin, 'Workspace/Bucket', true);
  assert.deepEqual(plugin.settings.starredPaths, ['Workspace/Bucket']);
  assert.deepEqual(plugin._saved.starredPaths, ['Workspace/Bucket']);
  await setFolderStarred(plugin, 'Workspace/Bucket', true); // no duplicate
  assert.deepEqual(plugin.settings.starredPaths, ['Workspace/Bucket']);
  await setFolderStarred(plugin, 'Workspace/Bucket', false);
  assert.deepEqual(plugin.settings.starredPaths, []);
});

test('toggleFolderSpotlight: flips current state, returns the flipped value', async () => {
  const plugin = makeStoragePlugin([]);
  const first = await toggleFolderSpotlight(plugin, 'Workspace/Bucket');
  assert.equal(first, true);
  assert.equal(isFolderStarred(plugin, 'Workspace/Bucket'), true);
  const second = await toggleFolderSpotlight(plugin, 'Workspace/Bucket');
  assert.equal(second, false);
  assert.equal(isFolderStarred(plugin, 'Workspace/Bucket'), false);
});

test('renameFolderStarredPaths: rewrites the folder\'s own starred path AND every starred descendant\'s, idempotently on a repeat call with the same old path', async () => {
  const plugin = makeStoragePlugin(['Workspace/Bucket', 'Workspace/Bucket/Sub', 'Workspace/Unrelated']);
  const changed = await renameFolderStarredPaths(plugin, 'Workspace/Bucket', 'Workspace/Renamed');
  assert.equal(changed, true);
  assert.deepEqual(
    [...plugin.settings.starredPaths].sort(),
    ['Workspace/Renamed', 'Workspace/Renamed/Sub', 'Workspace/Unrelated'].sort(),
  );
  // A second call with the SAME (now-stale) oldPath matches nothing --
  // idempotent, no corruption, no write.
  plugin._saved = null;
  const changedAgain = await renameFolderStarredPaths(plugin, 'Workspace/Bucket', 'Workspace/Renamed');
  assert.equal(changedAgain, false);
  assert.equal(plugin._saved, null); // saveSettings never called on a no-op
  assert.deepEqual(
    [...plugin.settings.starredPaths].sort(),
    ['Workspace/Renamed', 'Workspace/Renamed/Sub', 'Workspace/Unrelated'].sort(),
  );
});

test('renameFolderStarredPaths: a rename that touches nothing stored (e.g. a note rename) is a no-op, no write', async () => {
  const plugin = makeStoragePlugin(['Workspace/Bucket']);
  const changed = await renameFolderStarredPaths(plugin, 'Workspace/Unstarred.md', 'Workspace/Renamed.md');
  assert.equal(changed, false);
  assert.equal(plugin._saved, undefined);
  assert.deepEqual(plugin.settings.starredPaths, ['Workspace/Bucket']);
});

test('deleteFolderStarredPaths: drops the folder\'s own starred path AND every starred descendant\'s; idempotent on a repeat call', async () => {
  const plugin = makeStoragePlugin(['Workspace/Bucket', 'Workspace/Bucket/Sub', 'Workspace/Unrelated']);
  const changed = await deleteFolderStarredPaths(plugin, 'Workspace/Bucket');
  assert.equal(changed, true);
  assert.deepEqual(plugin.settings.starredPaths, ['Workspace/Unrelated']);
  plugin._saved = null;
  const changedAgain = await deleteFolderStarredPaths(plugin, 'Workspace/Bucket');
  assert.equal(changedAgain, false);
  assert.equal(plugin._saved, null);
});

/* ======================================================================
 * Candidate helpers (0.7.0) -- generic across a note candidate and a
 * folder candidate
 * ==================================================================== */

test('candidateNode / candidatePath: a flat/carrier candidate resolves through entityNote, a folder or file candidate through target', () => {
  const note = makeFile('Goals/A.md');
  const folder = makeFolder('Workspace/Bucket', []);
  const asset = makeFile('Workspace/Bucket/cover.png');
  assert.equal(candidateNode({ kind: 'flat', entityNote: note }), note);
  assert.equal(candidatePath({ kind: 'carrier', entityNote: note }), note.path);
  assert.equal(candidateNode({ kind: 'folder', target: folder }), folder);
  assert.equal(candidatePath({ kind: 'folder', target: folder }), folder.path);
  // 0.10.0: a `kind: 'file'` candidate dispatches through `target`
  // exactly like a `kind: 'folder'` candidate does.
  assert.equal(candidateNode({ kind: 'file', target: asset }), asset);
  assert.equal(candidatePath({ kind: 'file', target: asset }), asset.path);
});

test('usesPathStore: true for folder and file candidates, false for flat/carrier note candidates', () => {
  assert.equal(usesPathStore({ kind: 'folder', target: {} }), true);
  assert.equal(usesPathStore({ kind: 'file', target: {} }), true);
  assert.equal(usesPathStore({ kind: 'flat', entityNote: {} }), false);
  assert.equal(usesPathStore({ kind: 'carrier', entityNote: {} }), false);
});

test('getCandidateStarState / setCandidateStarState / toggleCandidateSpotlight: dispatch to the right storage layer by candidate.kind', async () => {
  const app = makeApp({ files: { 'Goals/A.md': '---\ntype: goal\n---\n' } });
  const note = makeFile('Goals/A.md', { content: '---\ntype: goal\n---\n' });
  const plugin = makeStoragePlugin([]);
  plugin.app = app;

  const noteCandidate = { kind: 'flat', entityNote: note };
  assert.equal(getCandidateStarState(plugin, noteCandidate), false);
  await setCandidateStarState(plugin, noteCandidate, true);
  assert.equal(getCandidateStarState(plugin, noteCandidate), true);
  assert.equal(await toggleCandidateSpotlight(plugin, noteCandidate), false);

  const folder = makeFolder('Workspace/Bucket', []);
  const folderCandidate = { kind: 'folder', target: folder };
  assert.equal(getCandidateStarState(plugin, folderCandidate), false);
  await setCandidateStarState(plugin, folderCandidate, true);
  assert.equal(getCandidateStarState(plugin, folderCandidate), true);
  assert.equal(await toggleCandidateSpotlight(plugin, folderCandidate), false);

  // 0.10.0: a `kind: 'file'` candidate dispatches through the SAME
  // path-based store a folder candidate uses (starredPaths), never a
  // note's own frontmatter.
  const asset = makeFile('Workspace/Bucket/cover.png');
  const fileCandidate = { kind: 'file', target: asset };
  assert.equal(getCandidateStarState(plugin, fileCandidate), false);
  await setCandidateStarState(plugin, fileCandidate, true);
  assert.equal(getCandidateStarState(plugin, fileCandidate), true);
  assert.deepEqual(plugin.settings.starredPaths.slice().sort(), ['Workspace/Bucket/cover.png']);
  assert.equal(await toggleCandidateSpotlight(plugin, fileCandidate), false);
  // Toggling the file back off leaves the store empty -- the folder was
  // already toggled off above, so nothing from either path-store write
  // survives, and neither one ever touched the note's own frontmatter.
  assert.deepEqual(plugin.settings.starredPaths, []);
  assert.equal(getSpotlightState(app, note), false);
});

/* ======================================================================
 * Path star storage (0.7.0, file candidates 0.10.0) -- the rename/
 * delete/stale-prune surface now shared by folders and files alike
 * ==================================================================== */

function makeStarredPathsPlugin(starredPaths) {
  return { settings: { starredPaths }, saveSettings: async function () {} };
}

test('setPathStarred / isPathStarred / togglePathSpotlight: works identically for a file path as a folder path', async () => {
  const plugin = makeStarredPathsPlugin([]);
  assert.equal(isPathStarred(plugin, 'Goals/cover.png'), false);
  assert.equal(await setPathStarred(plugin, 'Goals/cover.png', true), true);
  assert.equal(isPathStarred(plugin, 'Goals/cover.png'), true);
  assert.deepEqual(getStarredPaths(plugin), ['Goals/cover.png']);
  assert.equal(await togglePathSpotlight(plugin, 'Goals/cover.png'), false);
  assert.equal(isPathStarred(plugin, 'Goals/cover.png'), false);
});

test('renamePathStarredPaths: rewrites a starred FILE path exactly like a folder path, no descendant fan-out needed', async () => {
  const plugin = makeStarredPathsPlugin(['Goals/cover.png', 'Goals/Bucket']);
  const changed = await renamePathStarredPaths(plugin, 'Goals/cover.png', 'Goals/renamed-cover.png');
  assert.equal(changed, true);
  assert.deepEqual(plugin.settings.starredPaths.slice().sort(), ['Goals/Bucket', 'Goals/renamed-cover.png']);
});

test('renamePathStarredPaths: a rename that matches nothing stored is a no-op, never writes', async () => {
  const plugin = makeStarredPathsPlugin(['Goals/cover.png']);
  const originalArray = plugin.settings.starredPaths;
  const changed = await renamePathStarredPaths(plugin, 'Goals/unrelated.png', 'Goals/still-unrelated.png');
  assert.equal(changed, false);
  assert.equal(plugin.settings.starredPaths, originalArray); // same array reference -- never reassigned
});

test('deletePathStarredPaths: drops a starred FILE path exactly like a folder path', async () => {
  const plugin = makeStarredPathsPlugin(['Goals/cover.png', 'Goals/Bucket']);
  const changed = await deletePathStarredPaths(plugin, 'Goals/cover.png');
  assert.equal(changed, true);
  assert.deepEqual(plugin.settings.starredPaths, ['Goals/Bucket']);
});

test('computeStaleStarredPaths: reads through vault.getAbstractFileByPath, so a live FILE path is never misreported as stale', () => {
  const liveFile = makeFile('Goals/cover.png');
  const goals = makeFolder('Goals', [liveFile]);
  const app = makeApp({ folders: [goals] });
  const plugin = { settings: { starredPaths: ['Goals/cover.png', 'Goals/gone.png'] }, app };
  assert.deepEqual(computeStaleStarredPaths(plugin), ['Goals/gone.png']);
});

test('cleanupStaleStarredPaths: removes a stale FILE path on a member click, leaves a live one, writes at most once', async () => {
  const liveFile = makeFile('Goals/cover.png');
  const goals = makeFolder('Goals', [liveFile]);
  const app = makeApp({ folders: [goals] });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.settings = { starredPaths: ['Goals/cover.png', 'Goals/gone.png'] };
  const result = await cleanupStaleStarredPaths(plugin);
  assert.deepEqual(result, { removed: 1 });
  assert.deepEqual(plugin.settings.starredPaths, ['Goals/cover.png']);

  // A second call, nothing stale left -- never touches saveSettings again.
  let savedAgain = false;
  const originalSave = plugin.saveSettings.bind(plugin);
  plugin.saveSettings = async () => {
    savedAgain = true;
    return originalSave();
  };
  const secondResult = await cleanupStaleStarredPaths(plugin);
  assert.deepEqual(secondResult, { removed: 0 });
  assert.equal(savedAgain, false);
});

/* ======================================================================
 * Shelf file-kind icon (0.10.0) -- spotlightFileIconName
 * ==================================================================== */

test('spotlightFileIconName: image extensions -> "image"', () => {
  for (const ext of ['png', 'PNG', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'bmp']) {
    assert.equal(spotlightFileIconName(ext), 'image');
  }
});

test('spotlightFileIconName: audio extensions -> "file-audio"', () => {
  for (const ext of ['mp3', 'wav', 'm4a', '3gp', 'flac', 'ogg', 'oga', 'opus']) {
    assert.equal(spotlightFileIconName(ext), 'file-audio');
  }
});

test('spotlightFileIconName: everything else (pdf, video, base, canvas, unknown) -> "file-text"', () => {
  for (const ext of ['pdf', 'mp4', 'webm', 'base', 'canvas', 'docx', 'zip', '']) {
    assert.equal(spotlightFileIconName(ext), 'file-text');
  }
});

/* ======================================================================
 * The context-menu route — resolveSpotlightTarget / addSpotlightMenuItem
 * ==================================================================== */

function makeCardboardFixture({ projectsEnabled = true } = {}) {
  const stub = makeFile('04 Inner World/My Life/Projects/client/Cardboard Alchemy/Cardboard Alchemy.md', {
    content: '---\ntype: project\n---\n',
  });
  const support = makeFolder('04 Inner World/My Life/Projects/client/Cardboard Alchemy/support', [
    makeFile('04 Inner World/My Life/Projects/client/Cardboard Alchemy/support/notes.md', { content: 'no frontmatter' }),
  ]);
  const carrier = makeFolder('04 Inner World/My Life/Projects/client/Cardboard Alchemy', [stub, support]);
  const bucket = makeFolder('04 Inner World/My Life/Projects/client', [carrier]);
  const flatProject = makeFile('04 Inner World/My Life/Projects/incubator-idea.md', { content: '---\ntype: project\n---\n' });
  const incubator = makeFolder('04 Inner World/My Life/Projects', [bucket, flatProject]);

  const files = {
    [stub.path]: stub._content,
    [flatProject.path]: flatProject._content,
    '04 Inner World/My Life/Projects/client/Cardboard Alchemy/support/notes.md': 'no frontmatter',
  };
  const app = makeApp({ folders: [incubator, bucket, carrier, support], files });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.saved = { roots: [{ path: '04 Inner World/My Life/Projects', enabled: projectsEnabled }] };
  return { plugin, stub, carrier, flatProject, bucket, files, app };
}

test('resolveSpotlightTarget: a note sharing its own folder\'s name resolves as an ordinary "flat" candidate now, not "carrier"', async () => {
  const { plugin, stub } = makeCardboardFixture();
  await plugin.onload();
  await plugin.explorerReady;
  const found = resolveSpotlightTarget(plugin, stub);
  assert.equal(found.kind, 'flat');
  assert.equal(found.entityNote, stub);
});

test('resolveSpotlightTarget: a folder that happens to share its own note\'s name never resolves without the folder toggle on -- same as any other folder, no special carrier exception any more', async () => {
  const { plugin, carrier } = makeCardboardFixture();
  await plugin.onload();
  await plugin.explorerReady;
  assert.equal(resolveSpotlightTarget(plugin, carrier), null);
});

test('resolveSpotlightTarget: a flat note directly under the root resolves as "flat"', async () => {
  const { plugin, flatProject } = makeCardboardFixture();
  await plugin.onload();
  await plugin.explorerReady;
  const found = resolveSpotlightTarget(plugin, flatProject);
  assert.equal(found.kind, 'flat');
  assert.equal(found.entityNote, flatProject);
});

test('resolveSpotlightTarget (regression): a note with no type: frontmatter at all, nested inside a folder that shares another note\'s name, still resolves under a seeded My Life area root -- the old area type gate is gone, not merely bypassed by a lucky match', async () => {
  const { plugin } = makeCardboardFixture();
  const inner = makeFile('04 Inner World/My Life/Projects/client/Cardboard Alchemy/support/notes.md', { content: 'no frontmatter' });
  await plugin.onload();
  await plugin.explorerReady;
  const found = resolveSpotlightTarget(plugin, inner);
  assert.equal(found.kind, 'flat');
  assert.equal(found.entityNote.path, inner.path);
});

test('resolveSpotlightTarget: a note nested inside a folder that shares another note\'s name resolves regardless of its own type: value', async () => {
  const matchingInner = makeFile('04 Inner World/My Life/Projects/client/Cardboard Alchemy/support/notes.md', {
    content: '---\ntype: project\n---\n',
  });
  const support = makeFolder('04 Inner World/My Life/Projects/client/Cardboard Alchemy/support', [matchingInner]);
  const stub = makeFile('04 Inner World/My Life/Projects/client/Cardboard Alchemy/Cardboard Alchemy.md', {
    content: '---\ntype: project\n---\n',
  });
  const sameNamedFolder = makeFolder('04 Inner World/My Life/Projects/client/Cardboard Alchemy', [stub, support]);
  const bucket = makeFolder('04 Inner World/My Life/Projects/client', [sameNamedFolder]);
  const root = makeFolder('04 Inner World/My Life/Projects', [bucket]);
  const files = { [stub.path]: stub._content, [matchingInner.path]: matchingInner._content };
  const app = makeApp({ folders: [root, bucket, sameNamedFolder, support], files });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.saved = { roots: [{ path: '04 Inner World/My Life/Projects', enabled: true }] };
  await plugin.onload();
  await plugin.explorerReady;
  const found = resolveSpotlightTarget(plugin, matchingInner);
  assert.equal(found.kind, 'flat');
  assert.equal(found.entityNote, matchingInner);
});

test('resolveSpotlightTarget: a disabled root resolves nothing at all', async () => {
  const { plugin, stub } = makeCardboardFixture({ projectsEnabled: false });
  await plugin.onload();
  await plugin.explorerReady;
  assert.equal(resolveSpotlightTarget(plugin, stub), null);
});

test('resolveSpotlightTarget (regression): a note under a seeded My Life area root resolves regardless of its own type: value -- a mismatched type is no longer a reason to refuse it', async () => {
  const mismatched = makeFile('04 Inner World/My Life/Goals/Not A Goal.md', { content: '---\ntype: topic\n---\n' });
  const root = makeFolder('04 Inner World/My Life/Goals', [mismatched]);
  const app = makeApp({ folders: [root], files: { [mismatched.path]: mismatched._content } });
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass(app, { id: 'spotlight', version: '0.0.0-gate' });
  plugin.saved = { roots: [{ path: '04 Inner World/My Life/Goals', enabled: true }] };
  await plugin.onload();
  await plugin.explorerReady;
  const found = resolveSpotlightTarget(plugin, mismatched);
  assert.equal(found.kind, 'flat');
  assert.equal(found.entityNote, mismatched);
});

test('addSpotlightMenuItem: not-yet-spotlighted carrier note gets "Spotlight this"; clicking it spotlights the note', async () => {
  const { plugin, stub } = makeCardboardFixture();
  await plugin.onload();
  await plugin.explorerReady;
  const menu = makeMenu();
  addSpotlightMenuItem(plugin, menu, stub);
  assert.equal(menu.items.length, 1);
  assert.equal(menu.items[0].title, 'Spotlight this');
  await menu.items[0].clickHandler();
  assert.equal(getSpotlightState(plugin.app, stub), true);
});

test('addSpotlightMenuItem: already-spotlighted note gets "Remove from Spotlight"; clicking it clears the key', async () => {
  const { plugin, flatProject, app } = makeCardboardFixture();
  app.vault._files[flatProject.path] = '---\ntype: project\nspotlight: true\n---\n';
  flatProject._content = app.vault._files[flatProject.path];
  await plugin.onload();
  await plugin.explorerReady;
  const menu = makeMenu();
  addSpotlightMenuItem(plugin, menu, flatProject);
  assert.equal(menu.items[0].title, 'Remove from Spotlight');
  await menu.items[0].clickHandler();
  assert.equal(getSpotlightState(plugin.app, flatProject), false);
});

test('addSpotlightMenuItem: adds nothing for the carrier FOLDER (rule 3 -- folder never starrable)', async () => {
  const { plugin, carrier } = makeCardboardFixture();
  await plugin.onload();
  await plugin.explorerReady;
  const menu = makeMenu();
  addSpotlightMenuItem(plugin, menu, carrier);
  assert.equal(menu.items.length, 0);
});

test('addSpotlightMenuItem: a menu click older than MENU_CLICK_MAX_AGE_MS is refused, no write', async () => {
  const { plugin, stub } = makeCardboardFixture();
  await plugin.onload();
  await plugin.explorerReady;
  const menu = makeMenu();
  addSpotlightMenuItem(plugin, menu, stub);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + MENU_CLICK_MAX_AGE_MS + 1000;
    await menu.items[0].clickHandler();
  } finally {
    Date.now = realNow;
  }
  assert.equal(getSpotlightState(plugin.app, stub), false);
});
