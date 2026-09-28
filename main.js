/* Spotlight — star a note, folder, or file under a configured root
 * folder, and see it surface on a shelf at the top of that root's own
 * branch in the Obsidian file explorer.
 *
 * ARCHITECTURE (current model — see CHANGELOG.md for how it got here):
 *
 * 1. ROOTS. A root is any folder given by a vault path, with one on/off
 *    switch (`enabled`). Fresh install seeds the five ICOR "My Life"
 *    areas as roots when the vault is detected as an ICOR for Life
 *    scaffold (see `detectIcorScaffold()`/`computeIcorSeededRoots()`,
 *    below); otherwise it starts empty and the settings tab shows a
 *    short setup guide. A member adds any other root by path. Ancestor/
 *    descendant/duplicate roots are refused at add/edit time,
 *    unconditionally (`checkRootCollision()`).
 * 2. CANDIDATES. Under an enabled root, at any depth: every folder is an
 *    ordinary grouping folder (`kind: 'folder'` when the root's
 *    `spotlightFolders` toggle is on, always walked for candidates
 *    beneath it regardless); every `.md` file is an ordinary flat note
 *    (`kind: 'flat'`); every other file is `kind: 'file'`, unconditionally.
 *    These are fully independent identities — a folder and a same-named
 *    note inside it are two separate candidates, never one representing
 *    the other. `findEntityCandidates()` is the one function that knows
 *    this shape. Every root behaves the same way, seeded or hand-added:
 *    any `.md` file under it is a candidate, with no frontmatter
 *    requirement of any kind.
 * 3. STARRING. A note's star, its own `kind: 'flat'`, target, and storage
 *    (`spotlight: true` in the note's own frontmatter) work independently
 *    of a folder's star (`kind: 'folder'`, starrable only when the root's
 *    `spotlightFolders` toggle is on) and a file's star (`kind: 'file'`,
 *    always starrable). Folder and file stars live in `data.json`'s own
 *    `starredPaths` list, since neither carries frontmatter of its own.
 *    Every star/shelf consumer routes through a small set of candidate
 *    helpers (`candidateNode`, `candidatePath`, `getCandidateStarState`,
 *    `setCandidateStarState`, `toggleCandidateSpotlight` — see
 *    "Candidate helpers", below) that dispatch on `candidate.kind` rather
 *    than re-branching at every call site.
 * 4. THE SHELF. Starred candidates render as plugin-drawn rows at the top
 *    of their root's own branch — a "SPOTLIGHT (n)" header plus one row
 *    per starred item. The real row is untouched: same place in the
 *    tree, same star, still there. A shelf row's click reveals the real
 *    row (via Obsidian's own reveal-in-folder behavior) and opens it (for
 *    a note or file) or reveals-and-expands it (for a folder). Clicking
 *    the star on a shelf row directly un-stars the entity and removes it
 *    from the shelf, with no need to find the real row first. A small tab
 *    on the shelf's own bottom edge hides/shows everything below it (the
 *    real branch), for when only the curated shelf should be visible.
 *
 * Hand-written CommonJS, no build step. No ICOR for Life suite code is
 * reproduced here; this plugin only reads that scaffold's own small
 * machine-readable manifest file to detect whether it's installed.
 */

'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, Menu, getFrontMatterInfo, debounce, setIcon, normalizePath } = require('obsidian');

/* ========================================================================
 * Settings model — the root list
 * ==================================================================== */

const DEFAULT_ROOT_PATH = '04 Inner World/My Life';

/** The five My Life areas ICOR seeding looks for -- this list only
 * decides which of the five areas actually exist in this vault, for
 * seeding. There's no per-area type requirement any more: every root,
 * seeded or hand-added, accepts any `.md` note the same way. */
const AREA_FOLDER_NAMES = ['Goals', 'Habits', 'Key Elements', 'Projects', 'Topics'];

/** Fresh-install defaults. An earlier version of this unconditionally
 * seeded the five My Life areas as five roots, on every fresh install,
 * blind to whether the vault was ever an ICOR for Life vault at all --
 * in a non-ICOR vault, with no "My Life" folder at that path at all,
 * every one of the five roots degraded to an
 * inactive settings-tab note, never genuinely empty, never a guide. The
 * five-area seed is now conditional and ASYNC (it needs to read the
 * vault to confirm both "is this actually an ICOR scaffold" and "which
 * of the five area folders actually exist here") -- see
 * `detectIcorScaffold()`/`computeIcorSeededRoots()` and `onload()`'s own
 * doc comment for where that runs. This function itself stays the pure,
 * synchronous "nothing known yet" shape every caller can trust with no
 * vault access at all: EMPTY, so a non-ICOR vault (or an ICOR vault
 * where detection hasn't run yet) shows the settings tab's own guide
 * (`roots.length === 0`) rather than five inert placeholder rows.
 * `collapsedShelfRoots` — added 0.4.1 (a collapsed FOCUS
 * shelf was re-expanding on its own, main.js's own `renderShelfForRoot`
 * doc comment has the mechanism) — persists which roots' own shelves a
 * member has collapsed, by root path, so a rebuild (which happens on
 * nearly every vault event) doesn't silently un-collapse it. */
function defaultSettings() {
  return {
    roots: [],
    collapsedShelfRoots: [],
    starredPaths: [],
    // 0.13.0:
    // which roots' own BRANCHES (everything below the shelf) a member has
    // tucked away, by root path -- mirrors `collapsedShelfRoots` exactly.
    // Default empty = every branch showing; a branch only hides after
    // you click its own hide tab.
    collapsedBranchRoots: [],
    // 0.14.0: whether a member has explicitly dismissed the
    // empty-state ("no directories yet") guide without adding a
    // directory -- the guide otherwise shows any time `roots.length ===
    // 0`, ICOR-seeded-to-nothing or not. `false` (showing) by default,
    // same "never forces an early save" discipline every field here
    // follows.
    guideDismissed: false,
  };
}

/**
 * Forward-migrates whatever `loadData()` returned to the current
 * `{ roots: [{ path, enabled }] }` shape. Pure — never writes; the
 * caller persists once it trusts the read.
 *
 * Shapes told apart by structure:
 *  - `null`/`undefined` → defaults.
 *  - `{ roots: [...] }` where at least one entry carries a `lanes` array
 *    (every 0.3.x shape) → migrated. *    the DEFAULT root's own lanes explode into one root per lane, at
 *    `${DEFAULT_ROOT_PATH}/${lane.folderName}`, carrying the lane's own
 *    `enabled` forward — "a lane that was off becomes a root that is
 *    present but with a per-root `enabled: false`." Every OTHER 0.3.x
 *    root (anything the member added by hand, at any other path,
 *    typically nested below a lane they'd toggled off) collapses to a
 *    single plain enabled root at its own path — "a user-added nested
 *    root under a disabled lane migrates to a plain root" — its own
 *    `lanes` list is simply dropped, since there is no lane concept left
 *    for it to mean anything under. Confirmed against the real installed
 *    `data.json` (2026-09-15): one default-root entry with five lanes
 *    (Projects off, the rest on) plus one nested custom root
 *    (`.../Projects/personal`) with six lanes of its own — this rule
 *    turns that into five area roots plus one plain root, nothing lost
 *    (starred state lives in the notes' own frontmatter, untouched
 *    either way).
 *  - `{ roots: [...] }` with no `lanes` anywhere → already this shape;
 *    defensively re-read rather than trusted verbatim (a root missing
 *    its own `enabled` reads as enabled, matching "present, not yet
 *    explicitly turned off").
 *  - `{ rootPath, folders }` (every pre-phase-2, single-root shape ever
 *    shipped) → recurses through the `{ roots: [{ path, lanes }] }`
 *    branch above with `folders` standing in for that one root's lanes,
 *    so it inherits the exact same "own path, own lanes" handling.
 *
 * Post-processed by `dedupeCollidingRoots()` in the migrated-shape branch only: a real installed
 * `data.json` explodes into a default root that collides with a
 * user-added nested one (`.../Projects` off, `.../Projects/personal`
 * on) — a pair `checkRootCollision()` would refuse outright if a member
 * tried to ADD them fresh, so migration cannot leave that pair standing
 * either. The more specific (longer/deeper path) root wins.
 *
 * `collapsedShelfRoots` (0.4.1) is threaded through every branch, always
 * `[]` for a shape that never had shelves to begin with.
 *
 * @returns {{ settings: object, migrated: boolean }}
 */
function migrateSettings(loaded) {
  if (loaded && Array.isArray(loaded.roots)) {
    const usesLanes = loaded.roots.some((r) => Array.isArray(r.lanes));
    if (!usesLanes) {
      return {
        settings: {
          roots: loaded.roots.map((r) => ({
            path: r.path,
            enabled: r.enabled !== false,
            // 0.7.0: a root saved before this
            // field existed reads as `false` -- "not yet turned on,"
            // matching how a missing `enabled` already reads as "on."
            // Never forces a re-save here (this branch keeps its own
            // `migrated: false`, same as `collapsedShelfRoots` below did
            // when IT was added, 0.4.1) -- the field lands in data.json on
            // the next real write (a root add/edit/toggle), not this read.
            spotlightFolders: r.spotlightFolders === true,
          })),
          collapsedShelfRoots: Array.isArray(loaded.collapsedShelfRoots) ? loaded.collapsedShelfRoots.slice() : [],
          // 0.7.0: folder-star storage (see "Folder star storage" below) --
          // same non-forcing default-on-read pattern as every other field
          // this function has ever added.
          starredPaths: Array.isArray(loaded.starredPaths) ? loaded.starredPaths.slice() : [],
          // 0.13.0: same non-forcing default-on-read pattern, mirroring
          // `collapsedShelfRoots` exactly -- a shape saved before this field
          // existed reads as `[]` (every branch showing), never forces a
          // re-save here.
          collapsedBranchRoots: Array.isArray(loaded.collapsedBranchRoots) ? loaded.collapsedBranchRoots.slice() : [],
          // 0.14.0: same non-forcing pattern again -- a shape
          // saved before this field existed reads as `false` (the guide
          // shows, if `roots` also happens to be empty), never forces a
          // re-save here.
          guideDismissed: loaded.guideDismissed === true,
        },
        migrated: false,
      };
    }
    const migratedRoots = [];
    for (const r of loaded.roots) {
      const lanes = Array.isArray(r.lanes) ? r.lanes : [];
      if (normalizeRootPath(r.path) === DEFAULT_ROOT_PATH && lanes.length) {
        for (const lane of lanes) {
          migratedRoots.push({ path: `${r.path}/${lane.folderName}`, enabled: !!lane.enabled, spotlightFolders: false });
        }
      } else {
        migratedRoots.push({ path: r.path, enabled: true, spotlightFolders: false });
      }
    }
    return {
      settings: { roots: dedupeCollidingRoots(migratedRoots), collapsedShelfRoots: [], starredPaths: [], collapsedBranchRoots: [], guideDismissed: false },
      migrated: true,
    };
  }
  if (loaded && typeof loaded.rootPath === 'string') {
    return migrateSettings({ roots: [{ path: loaded.rootPath, lanes: Array.isArray(loaded.folders) ? loaded.folders : [] }] });
  }
  return { settings: defaultSettings(), migrated: false };
}

/**
 * ICOR-scaffold detection: true only when `.icor-for-life/manifest.json`
 * exists, parses as JSON, AND `name === "ICOR for Life Scaffold"` AND
 * `implements` (a string) starts with `"icor-concepts/"`. Never a
 * root-level `manifest.json` (that path is a DIFFERENT, unrelated file
 * some other tool could easily own), never a
 * folder-name guess (a vault can have its own, unrelated "My Life"
 * folder somewhere else entirely -- a name-based signal would false-
 * positive there), never a theme or installed-plugin-list guess.
 * ANY failure -- the dot-folder genuinely absent, unreadable, malformed
 * JSON, or missing/wrong `name`/`implements` -- resolves `false`, never
 * throws: this plugin's own fresh-install path must degrade to "empty,
 * show the guide," not break onload().
 * @returns {Promise<boolean>}
 */
async function detectIcorScaffold(app) {
  try {
    const adapter = app && app.vault && app.vault.adapter;
    if (!adapter || typeof adapter.exists !== 'function' || typeof adapter.read !== 'function') return false;
    const manifestPath = normalizePath('.icor-for-life/manifest.json');
    const exists = await adapter.exists(manifestPath);
    if (!exists) return false;
    const raw = await adapter.read(manifestPath);
    const parsed = JSON.parse(raw);
    return !!(parsed && parsed.name === 'ICOR for Life Scaffold' && typeof parsed.implements === 'string' && parsed.implements.startsWith('icor-concepts/'));
  } catch (err) {
    return false;
  }
}

/**
 * One root per CONFIRMED-EXISTING folder among the five My Life
 * areas -- an ICOR vault seeds just the five My Life
 * folders (Topics, Projects, Key Elements, Habits, Goals), never any
 * other folder this vault doesn't actually have yet. Reuses
 * `AREA_FOLDER_NAMES` (the same five names `defaultSettings()` used to
 * seed unconditionally pre-0.14.0) rather than a second, hand-typed
 * list that could silently drift from it. `vault.getFolderByPath` --
 * the real vault INDEX, unlike `detectIcorScaffold`'s own raw adapter
 * read -- is deliberately what this checks: these five are ordinary,
 * indexed folders, and the caller (`onload()`) only ever calls this
 * from inside `workspace.onLayoutReady`, where that index is trustworthy
 * (see condition 2's own wording, and `onload()`'s doc comment for why).
 * Returns `[]` when none exist -- the caller's own job to read that as
 * "stay empty, show the guide," never this function's.
 * @returns {{path: string, enabled: true, spotlightFolders: false}[]}
 */
function computeIcorSeededRoots(app) {
  const seeded = [];
  for (const name of AREA_FOLDER_NAMES) {
    const path = `${DEFAULT_ROOT_PATH}/${name}`;
    if (app.vault.getFolderByPath(path)) seeded.push({ path, enabled: true, spotlightFolders: false });
  }
  return seeded;
}

/**
 * Longest-path-wins dedupe for a set of roots that may contain an
 * ancestor/descendant collision — only ever needed against MIGRATED
 * data (a fresh add/edit already refuses any collision outright via
 * `checkRootCollision`, so one can never enter through that path). When
 * two roots in `roots` collide, the one with the LONGER (more specific)
 * path is kept and the other dropped — "collides with a more specific
 * one" reads as the specific one winning.
 * @param {{path:string, enabled:boolean}[]} roots
 */
function dedupeCollidingRoots(roots) {
  const kept = [];
  for (const candidate of roots) {
    const collisionIndex = kept.findIndex((k) => rootsCollide(k.path, candidate.path));
    if (collisionIndex === -1) {
      kept.push(candidate);
      continue;
    }
    if (candidate.path.length > kept[collisionIndex].path.length) {
      kept[collisionIndex] = candidate;
    }
    // else: the already-kept entry is at least as specific — candidate dropped
  }
  return kept;
}

/** Trims whitespace and strips trailing slashes, for root-path comparison
 * only. */
function normalizeRootPath(path) {
  return String(path).trim().replace(/\/+$/, '');
}

/**
 * 0.15.0: the directory pill's
 * own text -- the LAST segment of the root's own normalised path
 * (`normalizeRootPath`, above, already strips a trailing slash, so
 * `'Habits/'` and `'Habits'` resolve identically -- reused rather than a
 * second trim). `04 Inner World/My Life/Habits` becomes `Habits`. An
 * empty path, the vault root (`''`/`'/'`), or any path that normalizes
 * to nothing at all reads `'Vault root'`. The DOM keeps the case exactly
 * as typed; `styles.css`'s own `.spotlight-dir-pill` rule does the
 * visual small-caps transform, so a screen reader still says "Habits,"
 * never "H A B I T S."
 */
function pillTextForRootPath(path) {
  const normalized = normalizeRootPath(path || '');
  if (!normalized) return 'Vault root';
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return 'Vault root';
  return segments[segments.length - 1];
}

/**
 * No root may be an ancestor, descendant, or exact duplicate of another —
 * "Ancestor/descendant roots stay refused,"
 * full stop, no exception for a disabled lane the way 0.3.5 briefly
 * carried (there is no lane left to disable). A DISABLED root still
 * blocks an ancestor/descendant add — this checks path shape only, never
 * `enabled`.
 */
function rootsCollide(pathA, pathB) {
  const a = normalizeRootPath(pathA);
  const b = normalizeRootPath(pathB);
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

const ROOT_COLLISION_MESSAGE = 'Spotlight can watch several folders, but not folders inside each other.';

/**
 * `path` rewritten under a rename `oldPath -> newPath` -- exact match or
 * a descendant (`oldPath + '/...'`), the SAME prefix-rewrite semantics
 * `renamePathStarredPaths` already uses for `starredPaths`. Returns
 * `path` UNCHANGED when the rename doesn't touch it at all (no `oldPath`
 * prefix match), so a caller can always compare the result against the
 * input to learn whether anything actually happened.
 */
function computeRenamedRootPath(path, oldPath, newPath) {
  if (path === oldPath) return newPath;
  if (path.startsWith(`${oldPath}/`)) return newPath + path.slice(oldPath.length);
  return path;
}

/**
 * f4r: "when a
 * configured root folder (or any ancestor of it) is renamed or moved in
 * the vault, the root's path in settings follows it, and its per-root
 * state follows too (collapsedBranchRoots hidden state,
 * collapsedShelfRoots, ... anything keyed by root path)." This is the
 * whole mechanism: every `settings.roots[].path`, plus every entry in
 * `collapsedShelfRoots`/`collapsedBranchRoots`, that equals `oldPath` or
 * sits under it is rewritten to the same relative position under
 * `newPath` -- ONE `vault.on('rename')` firing (a root renamed directly,
 * OR an ANCESTOR folder renamed/moved, taking one or more roots with it;
 * the same event either way, `registerRowInjectionEvents` never needs to
 * tell them apart).
 *
 * Collision refusal ("If a rename would make a root nest inside/around
 * another root, keep the existing refusal rules sensible"): the vault
 * rename has ALREADY happened by the time this runs -- this plugin
 * cannot undo a member's own file-system action -- so a root whose
 * candidate new path would nest inside/around ANOTHER currently
 * configured root (checked with the SAME `rootsCollide` every add/edit
 * in the settings tab already refuses through) is left at its OLD path
 * in settings instead of being updated to the colliding one. That old
 * path no longer resolves to a real folder (the rename already moved
 * it), so the root degrades exactly the way any other missing-folder
 * root already does -- an inactive settings-tab note, never a throw,
 * never a silently invalid pair of overlapping roots. Every OTHER root
 * this same rename touches is unaffected by one root's own refusal.
 *
 * Writes at most once (`saveSettings()` called only when something
 * actually changed), same "return whether anything changed" discipline
 * `renamePathStarredPaths`/`deletePathStarredPaths` already use.
 *
 * Deliberately never touches `starredPaths` -- `renamePathStarredPaths`
 * (called alongside this, same rename event) already rewrites every
 * path-store star generically, root or not; folding that in here too
 * would just be a second, divergent copy of the same rewrite.
 */
async function applyRootFollowsRename(plugin, oldPath, newPath) {
  const prevRoots = plugin.settings.roots;
  const candidates = prevRoots.map((r) => computeRenamedRootPath(r.path, oldPath, newPath));

  // Collision refusal, per-root: a candidate that actually changed is
  // checked against every OTHER root's own candidate (untouched roots'
  // candidates equal their own unchanged path) -- reverted to its own
  // OLD path on a collision, never silently applied.
  const finalPaths = candidates.slice();
  for (let i = 0; i < finalPaths.length; i++) {
    if (finalPaths[i] === prevRoots[i].path) continue; // this root's own path is untouched by this rename
    const collides = finalPaths.some((p, j) => j !== i && rootsCollide(p, finalPaths[i]));
    if (collides) {
      console.warn(
        `[spotlight] root rename refused -- "${finalPaths[i]}" would nest inside/around another configured root; "${prevRoots[i].path}" stays configured at its old (now-missing) path instead of an invalid overlapping pair`,
      );
      finalPaths[i] = prevRoots[i].path;
    }
  }

  let rootsChanged = false;
  const nextRoots = prevRoots.map((r, i) => {
    if (finalPaths[i] === r.path) return r;
    rootsChanged = true;
    return { ...r, path: finalPaths[i] };
  });

  // `collapsedShelfRoots`/`collapsedBranchRoots`: rewritten per-root,
  // using the SAME old/new path pair as the root whose own state it is --
  // a refused root's own entries stay at its old path too (never
  // rewritten to a path settings never actually adopted).
  let listsChanged = false;
  const rewriteList = (list) => {
    if (!Array.isArray(list) || list.length === 0) return list;
    let changed = false;
    const next = list.map((p) => {
      for (let i = 0; i < prevRoots.length; i++) {
        if (finalPaths[i] === prevRoots[i].path) continue; // this root's own rename never landed (refused or untouched)
        const from = prevRoots[i].path;
        const to = finalPaths[i];
        if (p === from) {
          changed = true;
          return to;
        }
        if (p.startsWith(`${from}/`)) {
          changed = true;
          return to + p.slice(from.length);
        }
      }
      return p;
    });
    if (changed) listsChanged = true;
    return changed ? [...new Set(next)] : list;
  };
  const nextShelf = rewriteList(plugin.settings.collapsedShelfRoots);
  const nextBranch = rewriteList(plugin.settings.collapsedBranchRoots);

  if (!rootsChanged && !listsChanged) return false;
  if (rootsChanged) plugin.settings.roots = nextRoots;
  if (listsChanged) {
    plugin.settings.collapsedShelfRoots = nextShelf;
    plugin.settings.collapsedBranchRoots = nextBranch;
  }
  await plugin.saveSettings();
  return true;
}

/**
 * f4r's own delete-side twin ("root deleted (clean removal, no stuck
 * hidden state)"): any configured root equal to `path`, or nested under
 * it (an ANCESTOR folder deleted, taking one or more roots with it), is
 * dropped from `settings.roots` outright -- a genuinely confirmed vault
 * `delete` event, never the ambiguous "missing at startup, might still
 * be syncing down" case `cleanupStaleStarredPaths`'s own doc comment
 * argues against auto-pruning (that one fires on a LOAD-TIME guess; this
 * one fires on Obsidian's own confirmation the deletion already
 * happened). Matching entries in `collapsedShelfRoots`/
 * `collapsedBranchRoots` are dropped the same way, by the same
 * exact-or-nested test, so a folder later recreated at the same path
 * never silently inherits a dead hidden/collapsed state.
 *
 * Deliberately never touches `starredPaths` -- `deletePathStarredPaths`
 * (called alongside this, same delete event) already drops every
 * path-store star generically, root or not.
 */
async function removeRootAwareState(plugin, path) {
  const prevRoots = plugin.settings.roots;
  const survivors = prevRoots.filter((r) => r.path !== path && !r.path.startsWith(`${path}/`));
  let changed = survivors.length !== prevRoots.length;

  const dropFromList = (list) => {
    if (!Array.isArray(list) || list.length === 0) return { list, changed: false };
    const next = list.filter((p) => p !== path && !p.startsWith(`${path}/`));
    return { list: next, changed: next.length !== list.length };
  };
  const shelfResult = dropFromList(plugin.settings.collapsedShelfRoots);
  const branchResult = dropFromList(plugin.settings.collapsedBranchRoots);

  if (!changed && !shelfResult.changed && !branchResult.changed) return false;
  plugin.settings.roots = survivors;
  if (shelfResult.changed) plugin.settings.collapsedShelfRoots = shelfResult.list;
  if (branchResult.changed) plugin.settings.collapsedBranchRoots = branchResult.list;
  await plugin.saveSettings();
  return true;
}

/** The most specific ENABLED root that contains `path` (or equals it) —
 * picking the deepest match matters for a migrated vault where a custom
 * root still sits nested below a disabled area root (the real installed
 * data.json's own `.../Projects/personal` beneath a disabled `.../
 * Projects`, post-migration): the inner, enabled root wins, the outer,
 * disabled one is simply never consulted. Pure — path strings only, no
 * vault access. */
function findOwningRootEntry(roots, path) {
  let best = null;
  for (const r of roots || []) {
    if (!r.enabled) continue;
    if (path !== r.path && !path.startsWith(`${r.path}/`)) continue;
    if (!best || r.path.length > best.path.length) best = r;
  }
  return best;
}

/* ========================================================================
 * Discovery and shape classification, any depth.
 *
 * RETIRED 0.11.0: "Since we
 * flattened everything, didn't we do away with the convention that a
 * folder has to have a stubfile of the same name? So if there's a file
 * with the same name as the folder, it's not neccessarily representative
 * of that folder, it just is contained by it and happens to have the
 * same name." The GL-063 "carrier folder" convention (a folder holding a
 * same-named `.md` note, that note treated as the folder's own
 * representative) is GONE from this plugin's candidate model. There is
 * no more `kind: 'carrier'`, `findCarrierStub()` no longer exists, and
 * "rule 2" (nothing inside a carrier folder is ever walked) is gone with
 * it -- EVERY folder is now a plain grouping folder: always walked, at
 * any depth, and a `kind: 'folder'` candidate in its own right when the
 * root's `spotlightFolders` toggle is on, whether or not it happens to
 * contain a same-named note. A same-named note inside it is simply a
 * `kind: 'flat'` note candidate like any other -- the two are entirely
 * independent identities now, never one "representing" the other. See
 * the header comment's BUILD STATE (v0.11.0) entry for the full ruling.
 * ==================================================================== */

function isTFolder(x) {
  return !!x && Array.isArray(x.children);
}

function isTFile(x) {
  return !!x && !isTFolder(x) && typeof x.extension === 'string' && typeof x.basename === 'string';
}

/**
 * Every candidate under `rootFolder`, at any depth. Three kinds, each
 * independent of the other two:
 *  - `kind: 'flat'`, star target `entityNote` -- any `.md` note, ANY
 *    folder it happens to sit in, same-named as that folder or not.
 *    Unconditional -- every root treats every note the same way, with
 *    no frontmatter requirement.
 *  - `kind: 'folder'`, star target `target` -- any folder at all
 *    (0.11.0: including one holding a same-named note, which used to be
 *    a special "carrier" case this function skipped as a folder
 *    candidate; it doesn't any more), when `spotlightFolders` is true.
 *    Always still walked afterward for
 *    candidates beneath it, toggle on or off.
 *  - `kind: 'file'`, star target `target` -- any non-`.md` file, at any
 *    depth, unconditionally -- never gated by
 *    `spotlightFolders`.
 * `rootFolder` itself is never a candidate, either toggle's state
 * notwithstanding -- this function only ever pushes for a CHILD found
 * while walking, never for the folder passed in as the starting point.
 * @param {*} rootFolder
 * @param {{ spotlightFolders?: boolean }} options
 * @returns {({ kind: 'flat', entityNote: * } | { kind: 'folder'|'file', target: * })[]}
 */
function findEntityCandidates(rootFolder, { spotlightFolders = false } = {}) {
  const results = [];
  if (!rootFolder) return results;
  const walk = (folder) => {
    for (const child of folder.children) {
      if (isTFile(child)) {
        if (child.extension !== 'md') {
          // 0.10.0: every non-note file under an enabled root is a
          // candidate too, at any depth, always -- never tied to
          // spotlightFolders.
          results.push({ kind: 'file', target: child });
          continue;
        }
        results.push({ kind: 'flat', entityNote: child });
        continue;
      }
      if (isTFolder(child)) {
        // 0.11.0: no more carrier-stub check here at all -- EVERY folder
        // is a plain grouping folder now, a candidate in its own right
        // when folder mode is on, and always still walked at any
        // depth for whatever it contains, including a same-named note
        // that used to make it a "carrier" -- that note is found and
        // classified on its own merits, as a `kind: 'flat'` candidate,
        // by the `isTFile` branch above, the next time `walk()` reaches
        // it as one of this folder's own children.
        if (spotlightFolders) results.push({ kind: 'folder', target: child });
        walk(child);
      }
    }
  };
  walk(rootFolder);
  return results;
}

/** Starred candidates only — what the shelf renders and what the
 * settings tab's "N starred" half counts. Pure: `isStarred` is injected,
 * called with the candidate's own
 * NOTE, unchanged since 0.4.0. `isFolderStarred` (0.7.0, 0.10.0: also
 * called for a `kind: 'file'` candidate, not just `'folder'` -- see its
 * own updated doc comment at its definition) is a second, separately-
 * injected predicate, called with the candidate's own TFolder/TFile,
 * since a folder or file candidate's star lives in a different store
 * (data.json's `starredPaths`, see "Path star storage" above), never a
 * note's frontmatter, so it needs its own read function rather than
 * overloading `isStarred`'s existing note-only contract. Omitting
 * `isFolderStarred` on a call that also passes `spotlightFolders: true`
 * (or that simply has a file candidate present, which needs no toggle at
 * all) simply reads every folder/file candidate as un-starred, never a
 * throw. */
function computeStarredCandidates(rootFolder, { isStarred, isFolderStarred, spotlightFolders = false }) {
  return findEntityCandidates(rootFolder, { spotlightFolders }).filter((c) =>
    c.kind === 'folder' || c.kind === 'file' ? (isFolderStarred ? isFolderStarred(c.target) : false) : isStarred(c.entityNote),
  );
}

/* ========================================================================
 * Storage layer — unchanged from 0.1–0.3.x. Never
 * app.fileManager.processFrontMatter() (reparses/reserializes the WHOLE
 * block, destroying comments/quote style, can delete the block outright
 * on an empty result). Always vault.process() + getFrontMatterInfo() + a
 * single-key splice.
 * ==================================================================== */

const SPOTLIGHT_TRUE_STRINGS = new Set(['true', 'yes', '1']);

/** A lenient boolean coercion for a frontmatter value. Never throws. */
function coerceSpotlightBoolean(value) {
  if (value === true) return true;
  if (value === 1) return true;
  if (typeof value === 'string' && SPOTLIGHT_TRUE_STRINGS.has(value.trim().toLowerCase())) return true;
  return false;
}

/** Reads spotlight state straight from Obsidian's own metadata cache —
 * never cached by this plugin. Degrades to not-spotlighted on any error,
 * missing key, or malformed frontmatter. */
function getSpotlightState(app, entityNote) {
  try {
    const cache = app.metadataCache.getFileCache(entityNote);
    return coerceSpotlightBoolean(cache && cache.frontmatter && cache.frontmatter.spotlight);
  } catch (err) {
    console.error('[spotlight] getSpotlightState failed for', entityNote && entityNote.path, err);
    return false;
  }
}

/**
 * Strips any existing `spotlight:` line from a frontmatter block's raw
 * text and, when turning spotlight on, appends a fresh one — never writes
 * `spotlight: false` (remove the key entirely when turning it off).
 * Detects and matches the block's own dominant line ending. Line-position
 * based (not a single regex) so it correctly replaces an existing
 * `spotlight:` line even when it's the very FIRST line of the block.
 */
function spliceSpotlightKey(frontmatterText, spotlight) {
  const eol = frontmatterText.includes('\r\n') ? '\r\n' : '\n';
  let lines = frontmatterText.length === 0 ? [] : frontmatterText.split(/\r\n|\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines = lines.filter((line) => !/^spotlight:\s*/.test(line));
  if (spotlight) lines.push('spotlight: true');
  if (lines.length === 0) return '';
  return lines.join(eol) + eol;
}

/** The exact write shape, plus the no-fence guard: a star click must
 * never do nothing — prepend a fresh fence when the note has none. Pure:
 * takes the file's current text, returns its replacement. */
function computeSpotlightWrite(data, spotlight) {
  const fm = getFrontMatterInfo(data);
  if (!fm.exists) {
    if (!spotlight) return data;
    const eol = data.includes('\r\n') ? '\r\n' : '\n';
    return `---${eol}spotlight: true${eol}---${eol}${data}`;
  }
  const before = data.slice(0, fm.from);
  const block = data.slice(fm.from, fm.to);
  const after = data.slice(fm.to);
  return before + spliceSpotlightKey(block, spotlight) + after;
}

/** Writes spotlight state to `entityNote`'s own frontmatter. Never
 * throws — surfaces a visible Notice and resolves `false` on failure
 * (read-only vault, permissions, ...): leave that entity un-starred,
 * never fall back to a different store. */
async function setSpotlightState(app, entityNote, spotlight) {
  try {
    await app.vault.process(entityNote, (data) => computeSpotlightWrite(data, spotlight));
    return true;
  } catch (err) {
    new Notice(`Spotlight: couldn't update "${entityNote.path}" — ${(err && err.message) || err}`);
    console.error('[spotlight] setSpotlightState failed for', entityNote.path, err);
    return false;
  }
}

/** `YYYY-MM-DD` in LOCAL time — deliberately not `toISOString()` (UTC,
 * off-by-one near local midnight). Kept even though no stub-creation
 * path calls it any more (0.4.0 retired the last one, see README's dated
 * note); left in `__test` in case a future entity-write path needs it
 * again. */
function todayISODate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Toggles spotlight for `entityNote` — reads current state fresh and
 * flips it, same "never a stale replay" discipline the old
 * `toggleSpotlightForLaneChild` always had, simplified now that the
 * target is always the note itself (rule 3), never a folder needing its
 * own classification first. `null` on a failed write (the note stays
 * whatever it already was); the flipped boolean on success. */
async function toggleEntitySpotlight(app, entityNote) {
  const current = getSpotlightState(app, entityNote);
  const ok = await setSpotlightState(app, entityNote, !current);
  return ok ? !current : null;
}

/* ========================================================================
 * Path star storage (renamed from
 * "Folder star storage" once a FILE could
 * also live here). A folder
 * carries no frontmatter, and a non-note file's frontmatter (if it even
 * has any, e.g. a `.base`) is never this plugin's to touch, so the
 * note-star mechanism above (getSpotlightState / setSpotlightState, the
 * note's own `spotlight:` key) cannot reach either shape. Storage moves
 * to the plugin's own `data.json`, a top-level `starredPaths: string[]`
 * field holding the vault paths of every starred NON-NOTE target, folder
 * or file alike -- the field's own name and shape are UNCHANGED by
 * 0.10.0, only what can populate it grew.
 *
 * THIS IS THE ONE, NAMED EXCEPTION to this plugin's standing "never touch
 * data.json for entity state" discipline (the storage-layer comment
 * above this file's §"Storage layer" heading) -- lifted ONLY for this one
 * field. `settings.roots` and `settings.collapsedShelfRoots` are read and
 * written exactly as every build before this one already did; nothing
 * about their own shape or write path changes here.
 *
 * Built generically (a plain path list, not `folderStars` or similar) so
 * the queued bases feature (task update 2026-09-09) can plug into this
 * same store later without a second field or a migration of this one --
 * 0.10.0 closes that queued item directly: a `.base` file is now just a
 * `kind: 'file'` candidate, starred through this exact store, no separate
 * mechanism ever had to be built for it.
 *
 * Every write funnels through `setPathStarred()` -- the module's own
 * single mutation point -- so a future caller (a bulk import) inherits
 * the same persist-then-notify shape without reimplementing it. Reads/
 * writes reach this store only from the same trusted-event-gated call
 * sites the note star already uses (`handleStarActivate`,
 * `addSpotlightMenuItem`, `handleShelfStarActivate`) -- this module
 * itself adds no separate guard, the same way `setSpotlightState` above
 * adds none of its own either.
 *
 * NAMING (0.10.0): every function here was named `...Folder...` when only
 * a folder could use this store. Renamed to say `Path` instead, since a
 * file uses it identically now; the OLD names are kept as thin aliases
 * (same function, second name) immediately below each rename so nothing
 * else in this file, or a test written against the old names, has to
 * change on this account alone. The `starredPaths` FIELD name itself was
 * never folder-specific and is unchanged.
 * ==================================================================== */

/** `[]` for a plugin whose settings predate this field, or whose
 * `starredPaths` was ever coerced into something else -- never a throw. */
function getStarredPaths(plugin) {
  return Array.isArray(plugin.settings.starredPaths) ? plugin.settings.starredPaths : [];
}
/** 0.10.0 alias -- see the "NAMING" note above. */
const getFolderStarredPaths = getStarredPaths;

function isPathStarred(plugin, path) {
  return getStarredPaths(plugin).includes(path);
}
/** 0.10.0 alias -- see the "NAMING" note above. */
const isFolderStarred = isPathStarred;

/** The one place `settings.starredPaths` is ever assigned. Never throws:
 * mirrors `setSpotlightState`'s own "surface a Notice, resolve false"
 * discipline, even though a plugin-settings write is far less likely to
 * fail than a vault file write. */
async function setPathStarred(plugin, path, starred) {
  // this is the module's
  // own single mutation point (see the file header comment above), so
  // guarding here closes every star-action write path at once --
  // `handleStarActivate`'s row star, `addSpotlightMenuItem`'s folder/file
  // menu item, and the shelf star (already guarded upstream in
  // `unstarShelfEntity`, but a torn-down instance must never reach
  // `saveSettings()` from here either). Mirrors `unstarShelfEntity`'s
  // own `plugin._unloaded` check, same shape as `toggleEntitySpotlight`'s
  // sibling guard.
  if (plugin._unloaded) return false;
  try {
    const current = new Set(getStarredPaths(plugin));
    if (starred) current.add(path);
    else current.delete(path);
    plugin.settings.starredPaths = [...current];
    await plugin.saveSettings();
    return true;
  } catch (err) {
    new Notice(`Spotlight: couldn't update "${path}", ${(err && err.message) || err}`);
    console.error('[spotlight] setPathStarred failed for', path, err);
    return false;
  }
}
/** 0.10.0 alias -- see the "NAMING" note above. */
const setFolderStarred = setPathStarred;

/** Mirrors `toggleEntitySpotlight`'s own contract: `null` on a failed
 * write (the folder/file stays whatever it already was), the flipped
 * boolean on success. */
async function togglePathSpotlight(plugin, path) {
  const current = isPathStarred(plugin, path);
  const ok = await setPathStarred(plugin, path, !current);
  return ok ? !current : null;
}
/** 0.10.0 alias -- see the "NAMING" note above. */
const toggleFolderSpotlight = togglePathSpotlight;

/**
 * Rewrites every stored path equal to `oldPath`, or nested under it
 * (`oldPath + '/...'`), to the same relative position under `newPath` --
 * a starred folder/file itself, and any starred DESCENDANT folder/file
 * stored separately, both move together. Idempotent by construction: once
 * a path has been rewritten it no longer starts with `oldPath`, so a
 * second call with the same (now-stale) `oldPath` -- Obsidian's own
 * `rename` event firing more than once for the same move, once for the
 * folder and again for a descendant, is not settled either way (main.js's
 * `registerRowInjectionEvents`, see its own doc comment) -- simply
 * matches nothing and no-ops rather than corrupting an already-rewritten
 * entry. Returns whether anything actually changed, so the caller never
 * writes `data.json` on a no-op rename (a path this store has nothing
 * stored under). Works identically for a renamed FILE (a starred `.png`
 * moved or renamed) as it always did for a folder -- `p === oldPath`
 * matches a starred file's own exact path the same way it matches a
 * starred folder's, no folder-specific branch was ever here to begin
 * with.
 */
async function renamePathStarredPaths(plugin, oldPath, newPath) {
  const current = getStarredPaths(plugin);
  if (current.length === 0) return false;
  let changed = false;
  const rewritten = current.map((p) => {
    if (p === oldPath) {
      changed = true;
      return newPath;
    }
    if (p.startsWith(`${oldPath}/`)) {
      changed = true;
      return newPath + p.slice(oldPath.length);
    }
    return p;
  });
  if (!changed) return false;
  plugin.settings.starredPaths = [...new Set(rewritten)];
  await plugin.saveSettings();
  return true;
}
/** 0.10.0 alias -- see the "NAMING" note above. */
const renameFolderStarredPaths = renamePathStarredPaths;

/** Drops any stored path equal to `path`, or nested under it -- a
 * deleted folder/file's own star and every starred descendant's,
 * together. Idempotent the same way `renamePathStarredPaths` is: nothing
 * left matching `path` on a second call for the same delete. Works
 * identically for a deleted FILE as it always did for a folder -- see
 * `renamePathStarredPaths`'s own doc comment. */
async function deletePathStarredPaths(plugin, path) {
  const current = getStarredPaths(plugin);
  const next = current.filter((p) => p !== path && !p.startsWith(`${path}/`));
  if (next.length === current.length) return false;
  plugin.settings.starredPaths = next;
  await plugin.saveSettings();
  return true;
}
/** 0.10.0 alias -- see the "NAMING" note above. */
const deleteFolderStarredPaths = deletePathStarredPaths;

/** Never mutates. `starredPaths` entries whose path no longer resolves
 * to a real folder OR FILE in this vault -- the settings tab's own LIVE
 * count for the cleanup button. A folder that has since grown its own
 * same-named entity note still counts
 * as live here: it only asks whether SOMETHING real sits at that path,
 * never what `findEntityCandidates` would go on to classify it as --
 * "it is a real folder or file" is the whole test.
 * Reads through `vault.getAbstractFileByPath` (resolves a
 * TFolder OR a TFile) rather than `vault.getFolderByPath` (folder only),
 * since a starred path can now be either shape -- the old, folder-only
 * read would otherwise misreport every live starred FILE as stale. */
function computeStaleStarredPaths(plugin) {
  return getStarredPaths(plugin).filter((p) => !plugin.app.vault.getAbstractFileByPath(p));
}
/** 0.10.0 alias -- see the "NAMING" note above. */
const computeStaleFolderStarredPaths = computeStaleStarredPaths;

/**
 * an event that never
 * fires (a starred folder or file renamed or deleted while Obsidian is
 * closed, on another synced device, or converted while this vault's
 * synced copy has not caught up yet) cannot be handled by
 * the rename/delete listeners above, so a stale path can sit in
 * `starredPaths` forever -- inert until a NEW folder or file is later
 * created at that exact stale path, which then reads as already starred
 * with no user action at all.
 *
 * NEVER an automatic prune. A folder or file
 * that is a cloud-sync placeholder, or sits inside a root that has
 * not finished syncing down yet, can be genuinely (if temporarily) absent
 * at startup -- an eager prune there would silently delete a real star.
 * This is the "clean up missing folders" (0.10.0: files too) action
 * always a
 * member's own click, from the settings tab, never run on load or on a
 * timer. This is the ONLY call site that invokes it.
 *
 * Writes at most once, same "return whether anything actually changed"
 * discipline `renamePathStarredPaths`/`deletePathStarredPaths` above
 * already use -- a zero-stale click never touches `data.json`.
 */
async function cleanupStaleStarredPaths(plugin) {
  if (plugin._unloaded) return { removed: 0 };
  const stale = computeStaleStarredPaths(plugin);
  if (stale.length === 0) return { removed: 0 };
  const staleSet = new Set(stale);
  plugin.settings.starredPaths = getStarredPaths(plugin).filter((p) => !staleSet.has(p));
  await plugin.saveSettings();
  return { removed: stale.length };
}
/** 0.10.0 alias -- see the "NAMING" note above the "Path star storage"
 * section header. */
const cleanupStaleFolderStars = cleanupStaleStarredPaths;

/* ========================================================================
 * Candidate helpers -- generic across a note candidate (`kind: 'flat'`,
 * star target `entityNote` -- 0.11.0 retired the second note kind,
 * `'carrier'`, along with the whole GL-063 convention it existed for)
 * and a path-store candidate (0.7.0 `kind: 'folder'`, 0.10.0 also
 * `kind: 'file'`, star target `target` either way) so every consumer
 * below reads and writes through one small surface instead of
 * re-branching on `kind` itself at every call site. `usesPathStore()` is
 * the one place that union is named -- every helper below dispatches
 * through it rather than repeating its own
 * `kind === 'folder' || kind === 'file'` test.
 * ==================================================================== */

/** Whether `candidate`'s star lives in `data.json`'s `starredPaths`
 * (a folder or a file, neither of which carries usable frontmatter for
 * this plugin's own note-star mechanism) rather than in a note's own
 * `spotlight:` frontmatter key. */
function usesPathStore(candidate) {
  return candidate.kind === 'folder' || candidate.kind === 'file';
}

/** The TFile/TFolder a candidate's star actually targets. */
function candidateNode(candidate) {
  return usesPathStore(candidate) ? candidate.target : candidate.entityNote;
}

function candidatePath(candidate) {
  return candidateNode(candidate).path;
}

/**
 * 0.13.3 (p7m, star + shelf must feel
 * immediate). `plugin._optimisticStarOverrides` (a `Map<path, boolean>`)
 * is consulted FIRST, before either real storage layer -- the ONE place
 * every reader of star state (this function, and everything that calls
 * it: `reapplyStars`, `computeStarredCandidates`, `computeRootCounts`,
 * ...) sees an OPTIMISTIC value a click just painted, before the write
 * that will make it real has actually landed. `handleStarActivate`/
 * `handleShelfStarActivate` set an entry here synchronously at click
 * time, THEN call a real reapply pass -- with the override in place,
 * that pass reads this ONE path's state as the NEW value everywhere
 * (the inline star, the shelf), while every OTHER path still reads
 * genuinely live state, unaffected.
 *
 * 0.13.4 (an intermittent flicker on
 * rapid successive stars, and on the branch-toggle band while a star
 * write was still settling): the entry is no longer removed the instant
 * ITS OWN write settles -- see `reconcileStarOverride`'s own doc comment
 * for why that was the bug, and why clearing now happens there instead.
 */
function getCandidateStarState(plugin, candidate) {
  const path = candidatePath(candidate);
  if (plugin._optimisticStarOverrides && plugin._optimisticStarOverrides.has(path)) {
    return plugin._optimisticStarOverrides.get(path);
  }
  return readLiveStarState(plugin, candidate);
}

/** The real, non-optimistic storage read `getCandidateStarState` falls
 * through to once no override is in play -- factored out (0.13.4) so
 * `reconcileStarOverride` can compare an override's own value against
 * genuinely live storage without re-consulting the override itself
 * (which would trivially "match" every time and never reconcile
 * anything). */
function readLiveStarState(plugin, candidate) {
  return usesPathStore(candidate) ? isPathStarred(plugin, candidate.target.path) : getSpotlightState(plugin.app, candidate.entityNote);
}

/**
 * Fixes a real bug, root-caused with a
 * deferred-write test harness: a rapid re-click on the SAME
 * path, or a click while an EARLIER click on that same path was still
 * settling, could flicker back to a stale value. The old design cleared
 * `plugin._optimisticStarOverrides` for a path the instant THAT ONE
 * write's own promise resolved, unconditionally. Two writes to the same
 * path racing (a fast re-click, or simply two writes overlapping) breaks
 * that: write1 (the OLDER, now-superseded click) can settle AFTER write2
 * (the newer click) has already overwritten the override with its own,
 * correct value -- deleting the override at THAT moment falls through to
 * LIVE storage, which for a frontmatter-backed candidate reads
 * `app.metadataCache`'s own cache of the file, itself a SEPARATE,
 * asynchronous re-parse that can lag behind `vault.process()`'s own
 * promise resolving by a real, measurable amount (this file's own
 * `registerRowInjectionEvents` doc comment already names this exact
 * "requestSort()-before-reparse race" for sort order; it applies here
 * identically). Reading live at that moment can show write1's OWN target
 * value (once its belated cache reparse lands) even though write2's
 * write for the SAME path hasn't happened yet -- a visible flip back to
 * the stale value, corrected only once write2 eventually confirms too.
 *
 * Fixed: an override is cleared ONLY here, and only once BOTH of these
 * hold:
 *  1. `plugin._starWritesInFlight` (a `Map<path, number>`, incremented
 *     before a write starts and decremented in its own `finally`,
 *     regardless of success or failure) reads zero or absent for this
 *     path -- no write for this path is still outstanding. A path with
 *     more than one write in flight is a path a NEWER click has already
 *     taken over; only that newer click's own eventual settle is allowed
 *     to reconcile it.
 *  2. Live storage (bypassing the override, `readLiveStarState`) already
 *     equals the override's OWN current value -- "confirmed," not
 *     "written." For a frontmatter-backed candidate this function is
 *     called from `registerRowInjectionEvents`'s `metadataCache.on(
 *     'changed', ...)` handler, never from a write's own settle -- the
 *     'changed' event IS Obsidian's own confirmation that its cache has
 *     actually caught up, which a bare `await vault.process(...)`
 *     resolving is not. For a path-store candidate (folder/file,
 *     `settings.starredPaths`) there is no separate cache to lag behind
 *     -- `isPathStarred` reads `plugin.settings` synchronously, already
 *     updated before `setPathStarred`'s own write resolves -- so that
 *     store reconciles at settle time directly (see `handleStarActivate`/
 *     `handleShelfStarActivate`'s own call sites).
 *
 * Residual, named rather than engineered around: if a write's cache
 * reparse is still mid-flight at the
 * exact instant its OWN in-flight count drops to zero (a very tight
 * window Obsidian's own per-file write serialization makes unlikely, not
 * impossible), a stray late 'changed' could momentarily reconcile against
 * a value that's about to change again. Not fixed here -- would need a
 * second timer/backstop this build deliberately doesn't add unless it's
 * seen to happen live.
 */
function reconcileStarOverride(plugin, path, candidate) {
  if (!plugin._optimisticStarOverrides || !plugin._optimisticStarOverrides.has(path)) return;
  if (plugin._starWritesInFlight && plugin._starWritesInFlight.get(path)) return; // a newer write for this path still owns the display
  const overrideValue = plugin._optimisticStarOverrides.get(path);
  if (readLiveStarState(plugin, candidate) === overrideValue) {
    plugin._optimisticStarOverrides.delete(path);
  }
}

async function setCandidateStarState(plugin, candidate, starred) {
  if (usesPathStore(candidate)) return setPathStarred(plugin, candidate.target.path, starred);
  return setSpotlightState(plugin.app, candidate.entityNote, starred);
}

/** Mirrors `toggleEntitySpotlight`'s own contract (read fresh, flip,
 * return the flipped value) across both storage layers. */
async function toggleCandidateSpotlight(plugin, candidate) {
  if (usesPathStore(candidate)) return togglePathSpotlight(plugin, candidate.target.path);
  return toggleEntitySpotlight(plugin.app, candidate.entityNote);
}

/* ========================================================================
 * Context-menu route — the entity resolver both the menu and the inline
 * star share.
 * ==================================================================== */

/**
 * Resolves `file` to a starrable candidate, or `null`. A TFolder resolves
 * too, but ONLY under a root whose
 * own `spotlightFolders` toggle is on, and never as the root folder
 * itself. A non-`.md` TFile resolves too,
 * unconditionally -- no toggle gates it, the same way none ever gated a
 * `.md` note. A folder that happens to hold a same-named note is
 * not a special case here -- it resolves as an ordinary `'folder'`
 * candidate exactly like any other, and its same-named note resolves as
 * an ordinary `'flat'` candidate exactly like any other, two fully
 * independent lookups, neither one aware the other exists. Either way, a
 * candidate is only ever resolved when it's genuinely one
 * `findEntityCandidates` produces under some enabled root (the single
 * source of truth for that, reused directly rather than re-derived a
 * second, potentially-divergent way).
 * @returns {({ kind: 'flat', entityNote: * } | { kind: 'folder'|'file', target: * }) & { rootEntry: * } | null}
 */
function resolveSpotlightTarget(plugin, file) {
  const rootEntry = findOwningRootEntry(plugin.settings.roots, file.path);
  if (!rootEntry) return null;
  const spotlightFolders = rootEntry.spotlightFolders === true;
  if (isTFolder(file)) {
    if (!spotlightFolders) return null;
    if (file.path === rootEntry.path) return null; // the root folder itself is never a candidate
  } else if (!isTFile(file)) {
    return null;
  }
  const rootFolder = plugin.getRootFolder(rootEntry.path);
  if (!rootFolder) return null;
  const candidates = findEntityCandidates(rootFolder, { spotlightFolders });
  const found = candidates.find((c) => candidatePath(c) === file.path);
  return found ? { ...found, rootEntry } : null;
}

// Electron-remote-callback defense: a
// native context-menu item's onClick is registered the moment the menu
// is BUILT, not when it's clicked, and Electron's own remote-callback
// registry does not reliably release that registration just because the
// JS objects that made it become unreachable. `evt.isTrusted` is the one
// property no page script can spoof; this refuses anything that isn't a
// timely, genuinely-trusted response to the menu it was built for.
const MENU_CLICK_MAX_AGE_MS = 30_000;

/** Builds the "Spotlight this" / "Remove from Spotlight" menu item for
 * one `file-menu` event, or adds nothing when `file` isn't a candidate —
 * including every folder outside a `spotlightFolders`-enabled root (see
 * `resolveSpotlightTarget`'s own doc comment for the full history). A
 * folder that happens to hold a same-named note (0.11.0 retired that
 * convention's special handling) gets this menu item on its own row
 * exactly like any other folder, and its note gets it independently on
 * the note's own row. Reads/writes through the generic candidate helpers
 * so this fires the SAME menu item, wired to the RIGHT storage layer,
 * for a note, a folder, or a file candidate alike. */
function addSpotlightMenuItem(plugin, menu, file) {
  const candidate = resolveSpotlightTarget(plugin, file);
  if (!candidate) return;
  const builtAt = Date.now();
  const isSpotlighted = getCandidateStarState(plugin, candidate);
  menu.addItem((item) => {
    item
      .setTitle(isSpotlighted ? 'Remove from Spotlight' : 'Spotlight this')
      .setIcon('star')
      .onClick(async () => {
        const age = Date.now() - builtAt;
        if (age > MENU_CLICK_MAX_AGE_MS) {
          console.warn(`[spotlight] addSpotlightMenuItem onClick fired ${age}ms after its menu was built (>${MENU_CLICK_MAX_AGE_MS}ms) — refused`);
          return;
        }
        try {
          await toggleCandidateSpotlight(plugin, candidate);
          plugin.requestExplorerSort();
          plugin.scheduleStarReapply();
        } catch (err) {
          console.error('[spotlight] addSpotlightMenuItem onClick failed', err);
        }
      });
  });
}

/** Obtains the file-explorer's live view: the leaf, then
 * `loadIfDeferred()` before touching anything else (a leaf can be a
 * placeholder with none of the real view's methods until loaded, since
 * Obsidian 1.7.2). `null` when no file-explorer leaf exists at all. */
async function getFileExplorerView(app) {
  const leaves = app.workspace.getLeavesOfType('file-explorer');
  if (!leaves || leaves.length === 0) return null;
  const leaf = leaves[0];
  if (typeof leaf.loadIfDeferred === 'function') {
    await leaf.loadIfDeferred();
  }
  return leaf.view || null;
}

/* ========================================================================
 * Row injection: the inline star. Rule 3 ORIGINALLY read "notes only,
 * never a folder". REVISED
 * 0.7.0: under a root with `spotlightFolders`
 * on, a grouping folder's own row gets a star too, same mechanism, same
 * placement (first child of the row's own title element), a carrier
 * folder's row still never does (its note does instead, unchanged). See
 * the header comment's BUILD STATE (v0.7.0) entry for the full ruling.
 * ==================================================================== */

/**
 * RETIRED 0.15.1. Used to be
 * a hand-rolled Lucide `star` SVG string, written via `star.innerHTML =
 * STAR_SVG_MARKUP` at both call sites below -- the file's own 0.4.1/
 * 0.4.2 BUILD STATE notes had named the swap to `setIcon()` "not cheap
 * against everything else in this pass" and left it hand-rolled; that
 * trade no longer held once the same platform-native-icon-over-hand-
 * rolled-SVG preference (F10) that already drove the folder/file kind
 * icons (`ensureStarOnRow`'s own sibling call sites) was extended here
 * too. The polygon this constant held was Lucide's own stock `star`
 * glyph already (same points, same viewBox), and every visual property
 * that matters -- stroke-width, fill, size -- is an inherited SVG
 * property this file's own CSS overrides regardless of which markup
 * produced the `<svg>`, so `setIcon(star, 'star')` reproduces the exact
 * same look with no CSS change needed.
 */

/** Resolves a row's classification fresh from its own `data-path`
 * attribute at the moment of activation — never a value captured when
 * the star was first created (a recycled/reclassified row must never
 * write against stale state). `getAbstractFileByPath` returns either a
 * TFile or a TFolder for that path; `resolveSpotlightTarget` (0.7.0)
 * already branches on which, so no separate folder branch is needed
 * here; this function's own job (re-read the path, hand it to the one
 * resolver) is unchanged. */
function resolveRowClassification(plugin, titleEl) {
  const path = titleEl && titleEl.getAttribute && titleEl.getAttribute('data-path');
  if (!path) return null;
  const abstractFile = typeof plugin.app.vault.getAbstractFileByPath === 'function' ? plugin.app.vault.getAbstractFileByPath(path) : null;
  if (!abstractFile) return null;
  return resolveSpotlightTarget(plugin, abstractFile);
}

/** Toggles spotlight for whatever entity `titleEl` CURRENTLY represents.
 * Trusted-event gated: refuses anything whose originating event isn't
 * `evt.isTrusted === true`.
 *
 * Paints OPTIMISTICALLY, so the click feels immediate:
 * flips `plugin._optimisticStarOverrides` for this ONE path BEFORE the
 * write even starts, then runs a REAL, full reapply pass synchronously,
 * in the SAME task -- with the override in place, `getCandidateStarState`
 * (which both `reapplyStars`, for the inline star, and
 * `computeStarredCandidates`, for the shelf, read through) reports the
 * NEW state for this path everywhere, while every OTHER path still reads
 * genuinely live state. This is why the reapply call has to come AFTER
 * setting the override, never before it, and why the override has to
 * exist at all: calling a real reapply pass BEFORE the underlying write
 * lands, with NO override, would read this path's still-unwritten LIVE
 * state and silently repaint it back to what it already was -- exactly
 * undoing an optimistic paint that tried to skip straight to a plain
 * `starEl.classList.toggle(...)` instead.
 *
 * Fixes an intermittent flicker on
 * rapid successive stars: the override is no longer removed the instant
 * THIS write's own promise settles -- see `reconcileStarOverride`'s own
 * doc comment for the race that caused, and how clearing now works
 * instead. `plugin._starWritesInFlight` (a `Map<path, number>`) is
 * incremented before the write starts and decremented in this function's
 * own `finally`, so a path with more than one write outstanding is never
 * reconciled by an OLDER one settling first. */
async function handleStarActivate(plugin, titleEl, starEl, evt) {
  try {
    if (!evt || evt.isTrusted !== true) {
      console.warn('[spotlight] handleStarActivate refused — origin is not a trusted user event');
      return;
    }
    const classification = resolveRowClassification(plugin, titleEl);
    if (!classification) return;
    const path = candidatePath(classification);
    const previousState = getCandidateStarState(plugin, classification);
    const optimisticState = !previousState;

    plugin._optimisticStarOverrides = plugin._optimisticStarOverrides || new Map();
    plugin._optimisticStarOverrides.set(path, optimisticState);
    plugin._starWritesInFlight = plugin._starWritesInFlight || new Map();
    plugin._starWritesInFlight.set(path, (plugin._starWritesInFlight.get(path) || 0) + 1);
    plugin.runReapply();

    let ok = false;
    try {
      ok = await setCandidateStarState(plugin, classification, optimisticState);
    } finally {
      const remaining = (plugin._starWritesInFlight.get(path) || 1) - 1;
      if (remaining <= 0) plugin._starWritesInFlight.delete(path);
      else plugin._starWritesInFlight.set(path, remaining);

      // A path-store candidate (folder/file) has no separate metadata
      // cache to lag behind `setCandidateStarState`'s own promise --
      // `plugin.settings.starredPaths` is already updated by the time it
      // resolves -- so it's safe, and necessary (nothing else will ever
      // do it), to reconcile right here.
      //
      // 0.13.6: the
      // `usesPathStore(...)` guard that used to gate this call is GONE --
      // a frontmatter-backed candidate now reconciles here too, not only
      // through `registerRowInjectionEvents`'s `metadataCache.on(
      // 'changed', ...)` handler. Two gaps that guard left uncovered:
      // (1) a write whose content didn't actually change on disk (this
      // path was already at the target value) never fires a `'changed'`
      // event at all, so the override sat forever, correct by luck, never
      // actually reconciled; (2) a `'changed'` that arrives WHILE a write
      // is still in flight for this path early-returns inside
      // `reconcileStarOverride` itself (a newer click still owns the
      // display) and is never retried once that write settles. Safe to
      // call unconditionally: `reconcileStarOverride` only ever deletes
      // the override when live storage ALREADY agrees with it -- for a
      // frontmatter candidate whose metadata cache hasn't caught up yet,
      // `readLiveStarState` still returns the STALE value here, the
      // comparison fails, and the override is correctly left in place
      // (the eventual `'changed'` event, or a later click's own settle,
      // still gets a turn at reconciling it) -- never the 0.13.4 flicker,
      // which was caused by deleting an override unconditionally, not by
      // calling this function unconditionally.
      reconcileStarOverride(plugin, path, classification);
    }
    if (!ok) {
      // A genuine write failure: only force a revert if no NEWER click is
      // still relying on this path's own override -- otherwise a newer
      // click already owns the display and will resolve its own outcome
      // when ITS write settles.
      if (!plugin._starWritesInFlight.get(path)) {
        if (plugin._optimisticStarOverrides) plugin._optimisticStarOverrides.delete(path);
        plugin.runReapply(); // live state never changed for this write -- this correctly reverts
      }
      new Notice(`Spotlight: couldn't toggle that star`);
      return;
    }
    plugin.requestExplorerSort();
    plugin.scheduleStarReapply(); // safety net; the star-state cache already agrees, so this is a no-op pass
  } catch (err) {
    new Notice(`Spotlight: couldn't toggle that star — ${(err && err.message) || err}`);
    console.error('[spotlight] handleStarActivate failed', err);
  }
}

/** Ensures `titleEl` carries exactly one correctly-stated star. Called
 * for a candidate note's own row (`kind: 'flat'`) exactly as always, AND
 * (0.7.0) for a grouping folder's own row when its root's
 * `spotlightFolders` toggle is on, AND (0.10.0) for a non-note file's
 * own row, unconditionally. 0.11.0 retired the GL-063 carrier
 * convention: a folder that happens to hold a same-named note now gets
 * its own star on its own row exactly like any other folder candidate,
 * and the note gets its own star on ITS own, separate row exactly like
 * any other flat note candidate -- two fully independent rows, neither
 * one a special case of the other any more. This function and every
 * caller already dispatch generically on `candidate.kind`/
 * `candidatePath()`, so nothing here had to change for that. The star's
 * own click/keydown listeners below already `stopPropagation()`/
 * `preventDefault()` before doing anything else, which is exactly what a
 * folder row's star needs to keep its click from also toggling that
 * folder's native expand/collapse (a folder title row is clickable for
 * that in Obsidian, a note title row isn't). */
function ensureStarOnRow(plugin, titleEl, classification) {
  if (!titleEl) return;
  const node = candidateNode(classification);
  const isSpotlighted = getCandidateStarState(plugin, classification);
  if (!titleEl.getAttribute('data-path')) {
    titleEl.setAttribute('data-path', node.path);
  }
  let star = titleEl.querySelector(':scope > .spotlight-star');
  if (!star) {
    star = document.createElement('span');
    star.className = 'spotlight-star';
    // 0.15.1: Obsidian's own
    // `setIcon()`, not a hand-rolled `innerHTML` write -- the same
    // "platform-native icon over a hand-rolled SVG" preference F10
    // already established for the folder/file kind icons below
    // (`ensureStarOnRow`'s own sibling call sites). `STAR_SVG_MARKUP`'s
    // polygon IS Lucide's own stock `star` glyph (same points, same
    // viewBox), and every visual property that matters here --
    // stroke-width, fill, size -- is an inherited SVG property this
    // file's own CSS (`.spotlight-star svg`/`.spotlight-star.is-on svg`,
    // a descendant selector, not `>`) already overrides regardless of
    // what markup produced the `<svg>`, exactly the same contract
    // `.spotlight-shelf-folder-icon svg`/`.spotlight-shelf-file-icon svg`
    // already prove out live for a `setIcon()`-drawn icon. No visual
    // change intended.
    if (typeof setIcon === 'function') setIcon(star, 'star');
    star.setAttribute('role', 'button');
    star.setAttribute('tabindex', '0');
    star.addEventListener('click', (evt) => {
      evt.stopPropagation();
      evt.preventDefault();
      handleStarActivate(plugin, titleEl, star, evt).catch((err) => console.error('[spotlight] unhandled handleStarActivate rejection', err));
    });
    star.addEventListener('keydown', (evt) => {
      if (evt.key !== 'Enter' && evt.key !== ' ') return;
      evt.stopPropagation();
      evt.preventDefault();
      handleStarActivate(plugin, titleEl, star, evt).catch((err) => console.error('[spotlight] unhandled handleStarActivate rejection', err));
    });
    // a middle-click on
    // the star must not bubble into the row's own native `auxclick` ->
    // `onSelfClick` handler (a folder row toggles collapse on button 1
    // the same way it does on button 0). Same stopPropagation/
    // preventDefault treatment as click/keydown above, no activation --
    // a middle-click is not a request to toggle the star.
    star.addEventListener('auxclick', (evt) => {
      evt.stopPropagation();
      evt.preventDefault();
    });
    // Insert immediately before the row's own `.tree-item-inner` (the
    // title text), never before `children[0]`: on a note row `.tree-item-inner` already
    // IS the first child, so this is byte-identical to the old
    // behaviour there. On a folder row the first child is the live
    // `.collapse-icon` chevron `setCollapsible` prepends -- inserting
    // before THAT put the star a full chevron-slot further left than
    // the margin formula (styles.css §7.6) was measured for. Falls back
    // to the old `children[0] || null` shape only if `.tree-item-inner`
    // is somehow absent, which should never happen on a real Obsidian
    // row. Margin formula intentionally left untouched here -- this is
    // placement only, not a look change.
    const innerEl = titleEl.querySelector(':scope > .tree-item-inner');
    titleEl.insertBefore(star, innerEl || titleEl.children[0] || null);
  }
  star.classList.toggle('is-on', isSpotlighted);
  star.setAttribute('aria-pressed', isSpotlighted ? 'true' : 'false');
  star.setAttribute('aria-label', isSpotlighted ? 'Remove from Spotlight' : 'Spotlight this');
}

function removeStarFromRow(titleEl) {
  const star = titleEl && titleEl.querySelector(':scope > .spotlight-star');
  if (star) star.remove();
}

/** Every candidate note across every enabled root, materialized in
 * `view.fileItems` right now, gets a correctly-stated star; a star this
 * plugin previously painted whose row is no longer a candidate (a root
 * just disabled, a note moved out from under one, ...) gets swept.
 * Deduped by path across overlapping roots — a pre-existing migrated
 * nesting (an enabled custom root beneath a disabled area root) can't
 * double-paint the same row, and a fresh add can't create that nesting
 * any more (rootsCollide refuses it unconditionally).
 *
 * Rewritten after a noticeable
 * pass cost on a root with ~14,771 items. Root-caused live: the
 * structural WALK itself (`findEntityCandidates`) is cheap (confirmed:
 * ~1.6ms for 14,629 plain nodes); the per-candidate star-state read
 * (`getCandidateStarState`) is also cheap in aggregate (~9ms for the
 * whole root, confirmed against `computeRootCounts`). The measured ~46ms
 * this function alone cost, isolated with direct instrumentation, was
 * real DOM work: `ensureStarOnRow`'s own `querySelector`/`getAttribute`/
 * `setAttribute`/`classList` calls, run for EVERY candidate on EVERY
 * pass, including the ~14,600 whose star state has not changed since the
 * last pass. `plugin._starStateCache` (a plain `Map<path, boolean>`)
 * remembers the LAST star state this function itself observed and acted
 * on for each path; a candidate whose path was already painted last pass
 * (`plugin._paintedStarPaths.has(path)`) AND whose state hasn't changed
 * since (`cache.get(path) === currentState`) skips `ensureStarOnRow`
 * entirely -- no DOM touch at all, only the (already-cheap) state read
 * that's needed to make that comparison. A brand-new candidate, or one
 * whose state DID change (including the exact one row a star click just
 * flipped), still gets the full treatment, same as always.
 */
function reapplyStars(plugin) {
  const view = plugin.explorerView;
  if (!view || !view.fileItems) return;
  plugin._starStateCache = plugin._starStateCache || new Map();
  const previouslyPainted = plugin._paintedStarPaths || new Set();
  const touchedPaths = new Set();
  for (const rootEntry of plugin.settings.roots) {
    if (!rootEntry.enabled) continue;
    const rootFolder = plugin.getRootFolder(rootEntry.path);
    if (!rootFolder) continue;
    const candidates = findEntityCandidates(rootFolder, {
      spotlightFolders: rootEntry.spotlightFolders === true,
    });
    for (const candidate of candidates) {
      const path = candidatePath(candidate);
      if (touchedPaths.has(path)) continue;
      const item = view.fileItems[path];
      if (!item) continue; // row not (yet) materialized
      touchedPaths.add(path);
      const currentState = getCandidateStarState(plugin, candidate);
      if (previouslyPainted.has(path) && plugin._starStateCache.get(path) === currentState) {
        continue; // nothing changed since the last pass -- no DOM touch needed
      }
      ensureStarOnRow(plugin, item.selfEl, candidate);
      plugin._starStateCache.set(path, currentState);
    }
  }
  // `plugin._paintedStarPaths` (0.7.0 rename, was `plugin.starredPaths`):
  // the in-memory set of rows this plugin has actually drawn a star onto
  // right now. Renamed specifically to stop colliding, in name only, with
  // the NEW `plugin.settings.starredPaths` (the persisted folder-star
  // list, "Folder star storage" above). The two were never the same
  // thing (one is a live DOM-painted-rows cache, the other is durable
  // state), but sharing a name invited exactly the kind of confusion this
  // build is trying to avoid.
  for (const path of previouslyPainted) {
    if (touchedPaths.has(path)) continue;
    const item = view.fileItems[path];
    if (item) removeStarFromRow(item.selfEl);
    plugin._starStateCache.delete(path);
  }
  plugin._paintedStarPaths = touchedPaths;
}

/* ========================================================================
 * The shelf — plugin-drawn rows at the top of a root's own branch.
 * ==================================================================== */

/** Reveals a candidate's real row — expands every collapsed ancestor,
 * scrolls it into view, and briefly highlights it — using Obsidian's own
 * `view.revealInFolder()`, the same call Obsidian's bookmarks pane uses
 * for a plain folder, so a folder candidate reveals the same way a note
 * does, no special-casing needed. A folder is never "opened" as a
 * document (there's no note to load into a pane), so a folder shelf
 * row's click reveals and expands the folder itself. A file candidate
 * (any non-`.md` file) IS opened, the same way a note always has been —
 * see `leaf.openFile()`'s own call site, further down this function,
 * which already handles the viewable-vs-default-app split correctly
 * either way. */
/** Nudges the explorer's own scroll container so a just-revealed row
 * lands about a third of the way down the visible pane, rather than
 * wherever Obsidian's own default reveal position leaves it — so you can
 * still see some of the rows above it, and most of its own just-expanded
 * children below it. Applies to a note row and a folder row alike.
 *
 * This has to run in the same animation frame as Obsidian's own reveal
 * scroll, immediately after it, or the two scrolls fight each other.
 * It reads the explorer's real scroll position through the same
 * internal, undocumented properties Obsidian's own reveal logic uses
 * (there's no public API for "where is this row, right now, in the
 * visible pane") and schedules its own adjustment on the same frame
 * timer Obsidian schedules its reveal on, so it always runs immediately
 * after rather than racing it with a guessed delay.
 *
 * Skips outright, rather than guessing at a fallback, if the app's own
 * frame-scheduling helper isn't present. */
function positionRevealedRowOneThirdDown(plugin, node) {
  const view = plugin.explorerView;
  if (!view) return;
  if (typeof plugin.app.nextFrame !== 'function') return;
  plugin.app.nextFrame(() => {
    if (plugin._unloaded) return;
    const item = view.fileItems && view.fileItems[node.path];
    const infinityScroll = view.tree && view.tree.infinityScroll;
    if (!item || !infinityScroll) return;
    const scrollEl = infinityScroll.scrollEl;
    if (!scrollEl) return;
    if (typeof infinityScroll.compute === 'function') {
      infinityScroll.compute(true);
      for (
        let i = 0;
        i < 9 && infinityScroll.rootEl && infinityScroll.rootEl.info && !infinityScroll.rootEl.info.computed;
        i++
      ) {
        infinityScroll.compute(true);
      }
    }
    if (typeof infinityScroll.findElementTop !== 'function') return;
    const rootTop = typeof infinityScroll.getRootTop === 'function' ? infinityScroll.getRootTop() : 0;
    const rowTop = infinityScroll.findElementTop(item, infinityScroll.rootEl, rootTop);
    if (rowTop === null || rowTop === undefined) return;
    const target = rowTop - scrollEl.clientHeight / 3;
    const max = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    scrollEl.scrollTop = Math.min(Math.max(target, 0), max);
    if (typeof infinityScroll.updateVirtualDisplay === 'function') infinityScroll.updateVirtualDisplay();
  });
}

/**
 * The plugin-owned
 * class that hides a root's own BRANCH -- everything below the shelf --
 * while leaving the shelf itself showing. `.spotlight-branch-hidden >
 * .tree-item-children { display: none }` (styles.css) does the actual
 * hiding; this function's whole job is the class flip PLUS an
 * `infinityScroll.invalidate()` pair required around
 * EVERY hide/un-hide, mirroring Obsidian's own `updateCollapsed`:
 * `invalidate(item, true)` BEFORE the DOM changes, `invalidate(item)` AFTER
 * -- without it, a blank gap and missing rows. Never
 * `item.setCollapsed`/`is-collapsed` (that class also hides the SHELF, the
 * one thing this feature must never touch), never detaches `childrenEl`.
 *
 * Idempotent by design: if the class is already in the state asked for,
 * this is a no-op that skips `invalidate()` entirely, so calling it
 * defensively (every shelf rebuild, `removeShelfForRoot`) costs nothing on
 * the far more common "nothing changed" path. `typeof ... === 'function'`
 * guarded the same way `positionRevealedRowOneThirdDown` already is —
 * `view.tree.infinityScroll` may not exist in every environment this runs
 * in (a test harness, an Obsidian build this was never confirmed against).
 * Returns whether the class actually changed, so a caller that also wants
 * to know can (nothing currently does).
 */
/** Reverse lookup: the `view.fileItems` entry whose own `.el` is `el`,
 * or `null` -- `view.fileItems` is keyed by PATH, but a caller here
 * sometimes only has the DOM node itself (0.13.6, `sweepOrphanShelves`'s
 * own fix, an orphan shelf's
 * `data-spotlight-shelf-root` attribute names the root's OLD path, which
 * a rename has already re-keyed `fileItems` away from, so looking the
 * item up BY that stale path finds nothing even though the same DOM row
 * (same `.el`, same live listeners) is still sitting right there under
 * its new key. A plain `Object.values` scan -- `view.fileItems` is never
 * large enough (one entry per materialized row) for this to be a real
 * cost, and it only ever runs on the already-rare orphan-sweep path,
 * never on every reapply. */
function findItemByEl(view, el) {
  if (!view || !view.fileItems || !el) return null;
  for (const item of Object.values(view.fileItems)) {
    if (item && item.el === el) return item;
  }
  return null;
}

function applyBranchHiddenDomState(plugin, item, hidden) {
  if (!item || !item.el || !item.el.classList) return false;
  const wasHidden = item.el.classList.contains('spotlight-branch-hidden');
  if (wasHidden === !!hidden) return false;
  const view = plugin.explorerView;
  const infinityScroll = view && view.tree && view.tree.infinityScroll;
  const canInvalidate = infinityScroll && typeof infinityScroll.invalidate === 'function';
  if (canInvalidate) infinityScroll.invalidate(item, true);
  item.el.classList.toggle('spotlight-branch-hidden', !!hidden);
  if (canInvalidate) infinityScroll.invalidate(item);
  return true;
}

/**
 * Fixes a rendering bug: scrolling the file explorer with several shelf
 * directories open could produce a white flash, then a gap where a
 * branch's rows briefly vanished. Root cause: `applyBranchHiddenDomState`,
 * above, already pairs its one DOM mutation (the branch-hidden class
 * flip) with a call telling Obsidian's virtualized list that this row's
 * height changed — but every OTHER mutation that changes `item.el`'s own
 * rendered height (a shelf appearing or disappearing, its row count
 * changing, or the shelf's own collapse toggle) never told the list at
 * all. Obsidian caches each row's own height and the running total used
 * to position every row below it; either one going stale is invisible
 * until the next scroll forces a recompute using the stale numbers —
 * hence a flash and a gap that only shows up on scroll, not immediately.
 *
 * This calls the list's own per-row invalidation, not its per-branch
 * (self-plus-descendants) form — unlike the hide/show toggle, none of
 * these mutations touch anything inside the row's own children, only the
 * row's own height, so only the row itself needs to be marked stale.
 *
 * Every call site below calls this ONLY when it just confirmed a real
 * height-changing DOM mutation actually happened -- never unconditionally
 * on every render pass. 0.13.2's own hard-learned lesson (see
 * `reapplyBranchHiddenState`'s own doc comment) is exactly why: an
 * unconditional `invalidate()` on every pass fed a self-sustaining
 * reapply cascade through this plugin's own MutationObserver. Idempotent
 * by construction here too -- a caller that mistakenly calls this when
 * nothing changed costs one harmless debounced recompute, never a class
 * flip or any other visible effect, but it should still never be called
 * on a "nothing changed" path.
 */
function invalidateItemHeight(plugin, item) {
  if (!item) return;
  const view = plugin.explorerView;
  const infinityScroll = view && view.tree && view.tree.infinityScroll;
  if (infinityScroll && typeof infinityScroll.invalidate === 'function') infinityScroll.invalidate(item);
}

/**
 * True iff `node` (or an ancestor, walked via `parentNode`, bounded so a
 * malformed/circular chain can never hang) carries a plugin-owned class --
 * every class this plugin ever puts on an explorer element is prefixed
 * `spotlight-` (the shelf, its header/rows/star/icon rows, the branch
 * toggle and its tab -- confirmed by grep, there is no exception). Used by
 * `isSelfCausedMutation`, below, to recognise the plugin's OWN DOM writes
 * without needing every write site to remember to suppress the observer
 * around itself.
 *
 * ONE exception carved out
 * of the `spotlight-` prefix test -- `spotlight-branch-hidden` is the one
 * class this plugin ever puts on an element it does NOT own:
 * `applyBranchHiddenDomState` toggles it directly on `item.el`, Obsidian's
 * OWN row, never a plugin-created wrapper (see its own doc comment). The
 * OLD, unqualified prefix test walked up from ANY mutated node, found
 * `spotlight-branch-hidden` on that ancestor `item.el` whenever a root's
 * branch was hidden, and misread EVERY genuinely external mutation
 * anywhere under that hidden branch (Sync writing a file, a bulk rename,
 * another plugin) as this plugin's own -- silently dropped by
 * `isSelfCausedMutation`, below, exactly the mutations a hidden root most
 * needs this observer to still catch. The regex below matches the SAME
 * `spotlight-` prefix everywhere else (the shelf, the branch toggle, the
 * star, all still genuinely plugin-created markup this plugin does own),
 * but never on `spotlight-branch-hidden` specifically -- a negative
 * lookahead, not a `.closest()` call, since this walk already handles a
 * node with no `.closest()` at all (a text node, or a harness stub),
 * which `isSelfCausedMutation`'s own mutation records can carry.
 */
const SPOTLIGHT_OWNED_CLASS_RE = /(^|\s)spotlight-(?!branch-hidden(?:\s|$))/;

function isSpotlightOwnedNode(node) {
  let cur = node;
  let hops = 0;
  while (cur && hops < 60) {
    const cls = typeof cur.className === 'string' ? cur.className : '';
    if (SPOTLIGHT_OWNED_CLASS_RE.test(cls)) return true;
    cur = cur.parentNode;
    hops++;
  }
  return false;
}

/**
 * True iff EVERY record in `records` was caused by this plugin's own DOM
 * writes -- the toggle band's own click handler (`toggleBranch`, in
 * `renderShelfForRoot`) and `revealEntityCandidate`'s folder-click-while-
 * hidden un-hide path both call `syncBranchToggleEl` OUTSIDE
 * `runReapply`'s own disconnect/reconnect window, by design (in place,
 * no reapply needed), so the band's own chevron `setIcon()`
 * swap -- a real `childList` mutation -- reaches this plugin's own
 * `MutationObserver` (`childList: true, subtree: true` over the whole
 * explorer) same as any genuinely external one would. Filtering here,
 * at the single choke point every mutation batch passes through before
 * `scheduleStarReapply()` is ever called, covers those two sites AND any
 * future one without each having to remember to suppress the observer
 * itself -- and never drops a genuinely external record the way wrapping
 * a write in `disconnect()`/`observe()` around a synchronous window would
 * risk if an external mutation ever landed inside it (it can't, in
 * practice, JS being single-threaded, but this reads correct without
 * relying on that).
 *
 * Every reapply-pass-internal write (`renderAllShelves` and everything it
 * calls) already runs inside `runReapply`'s own disconnect/reconnect
 * window and never reaches this function's records at all -- this only
 * ever sees mutations from OUTSIDE a pass: a click handler's own
 * in-place write, or genuine external churn (Sync, a bulk rename,
 * another plugin).
 *
 * A record with no target at all, or an EMPTY `records` array/undefined
 * (this plugin's own observer always passes a real, non-empty array, but
 * a test, or a future browser quirk, might not) is treated as RELEVANT,
 * never silently swallowed -- "no information" is never grounds to
 * suppress a reapply.
 */
function isSelfCausedMutation(records) {
  if (!records || records.length === 0) return false;
  for (const record of records) {
    if (!record || !isSpotlightOwnedNode(record.target)) return false;
  }
  return true;
}

/**
 * Syncs a branch toggle band's own visual/ARIA state to `hidden` -- the ONE
 * place that logic lives, called from three sites: the band's own creation
 * (`renderShelfForRoot`), its own click/keydown handler (in place, no
 * reapply), and `revealEntityCandidate`'s folder-click-while-hidden path
 * (which un-hides a DIFFERENT root's band than whichever row was clicked --
 * see its own doc comment). Reads the tab child via `:scope > .cls` rather
 * than closing over it, so a caller holding only the outer `toggleEl` (the
 * reveal path, which finds it by query) can still update the icon.
 *
 * Made IDEMPOTENT after `syncBranchToggleEl` was found running on every
 * reapply pass and writing
 * the *same* value each time -- both of `renderShelfForRoot`'s own call
 * sites call this defensively on EVERY pass for EVERY root that already
 * has a band, hidden or shown, changed or not; under a burst of
 * externally-triggered passes (Sync rewriting unrelated files elsewhere
 * in the vault) that turned into 543 same-value DOM writes on the toggle
 * band alone over ~14 seconds -- real `childList` mutations (the chevron
 * `setIcon()` swap) that cost real main-thread time and, pre-0.13.5, fed
 * right back into this plugin's own `MutationObserver`). Compared against
 * `aria-expanded` specifically, not `is-hidden`: a freshly created band
 * (this function's OTHER caller, `renderShelfForRoot`'s creation site)
 * has no `aria-expanded` attribute yet at all (`getAttribute` returns
 * `null`, which never equals the string `'true'`/`'false'`), so the very
 * first sync always falls through and does the real work -- only a
 * SECOND call with the identical `hidden` value is skipped.
 */
function syncBranchToggleEl(toggleEl, hidden) {
  if (!toggleEl || !toggleEl.classList) return;
  const desiredExpanded = hidden ? 'false' : 'true';
  const currentExpanded = typeof toggleEl.getAttribute === 'function' ? toggleEl.getAttribute('aria-expanded') : null;
  if (currentExpanded === desiredExpanded) return; // already in sync -- no-op, no DOM write at all
  toggleEl.classList.toggle('is-hidden', !!hidden);
  // role=button/tabindex=0/Enter-Space toggles/aria-expanded true-false;
  // the hover label IS the
  // aria-label, same convention every other plugin-drawn control on this
  // surface already uses (the star, the shelf header) -- Obsidian shows
  // its own tooltip off `aria-label` on hover, no separate `title`
  // attribute needed.
  toggleEl.setAttribute('aria-expanded', desiredExpanded);
  toggleEl.setAttribute('aria-label', hidden ? 'Show everything below the shelf' : 'Hide everything below the shelf');
  const tab = typeof toggleEl.querySelector === 'function' ? toggleEl.querySelector(':scope > .spotlight-branch-toggle-tab') : null;
  if (tab && typeof setIcon === 'function') setIcon(tab, hidden ? 'chevron-down' : 'chevron-up');
}

/**
 * Re-asserts the "branch hidden" state on every currently-hidden,
 * currently-enabled root's own row, on every reapply pass — but without
 * telling Obsidian's virtualized list to recompute every time. An
 * earlier version did that unconditionally on every pass, which turned
 * out to be expensive: that recompute is debounced and itself touches
 * the row's own children, which this plugin's own change-observer sees,
 * which schedules another reapply pass, which invalidated again — a
 * self-feeding loop with real, measurable cost (a startup stall, a
 * stuttering scrollbar, and a delayed star/shelf update) whenever any
 * root's branch was hidden.
 *
 * Fix: invalidate only on a genuine event, never on a bare "is this root
 * still hidden" check that's true on every single pass:
 *  1. A row rebuilt after Obsidian reconnects the file-explorer view is
 *     still covered — the state-apply call below is already a no-op
 *     when the row's class is already correct, so running it every pass
 *     costs nothing extra, and still restores the class instantly the
 *     one time it's actually needed.
 *  2. A native re-expand of a hidden root's own collapsed folder icon is
 *     detected directly, by tracking that row's own collapsed/expanded
 *     flag across passes, instead of assumed on every pass. Only a
 *     genuine collapsed-to-expanded transition re-hides the row; a root
 *     seen for the first time never fires one, the same "never act on
 *     an unknown transition" rule the shelf's own empty-state handling
 *     already follows.
 *
 * Scoped to enabled roots only — a disabled root's own persisted hidden
 * state survives, but must never keep hiding a branch nobody can
 * currently reach a shelf for.
 */
function reapplyBranchHiddenState(plugin) {
  const view = plugin.explorerView;
  if (!view || !view.fileItems) return;
  const hiddenPaths = plugin.settings.collapsedBranchRoots;
  if (!hiddenPaths || hiddenPaths.length === 0) return;
  const enabledPaths = new Set(plugin.settings.roots.filter((r) => r.enabled).map((r) => r.path));
  const infinityScroll = view.tree && view.tree.infinityScroll;
  const canInvalidate = infinityScroll && typeof infinityScroll.invalidate === 'function';
  plugin._branchCollapsedSeen = plugin._branchCollapsedSeen || new Map();
  for (const path of hiddenPaths) {
    if (!enabledPaths.has(path)) continue;
    const item = view.fileItems[path];
    if (!item || !item.el || !item.el.classList) continue;
    // Idempotent -- a no-op, no invalidate, when the class is already
    // correct (the overwhelming majority of passes).
    applyBranchHiddenDomState(plugin, item, true);
    const wasCollapsed = plugin._branchCollapsedSeen.get(path);
    const isCollapsed = !!item.collapsed;
    if (canInvalidate && wasCollapsed === true && isCollapsed === false) {
      // A genuine native re-expand happened since the last pass -- and
      // ONLY then -- re-measure.
      infinityScroll.invalidate(item, true);
      infinityScroll.invalidate(item);
    }
    plugin._branchCollapsedSeen.set(path, isCollapsed);
  }
}

/**
 * Mitigates Obsidian's own "auto-reveal active file" scrolling to the
 * wrong spot when the file it targets lives under a branch this plugin
 * has hidden — auto-reveal's own scroll measures off a hidden element,
 * which gets the position wrong.
 *
 * An earlier version of this fix assumed Obsidian's own reveal-on-open
 * behavior ran synchronously inside the same call this plugin uses to
 * open a file, and restored the scroll position in the same animation
 * frame on that assumption. That assumption was wrong: Obsidian's own
 * reveal fires from a separately-scheduled event, on a short timer, not
 * tied to the animation-frame queue at all — so the two scrolls raced
 * each other with no guaranteed order, and the restore sometimes lost.
 *
 * Fix: react to the real, causal event directly instead of racing a
 * guess against it. This registers a one-shot listener for Obsidian's
 * own file-open event immediately before opening the file. Obsidian's
 * own file-explorer listener for that same event was registered long
 * before this plugin loaded, and event listeners fire in registration
 * order — so Obsidian's own reveal scroll always runs before this
 * plugin's freshly-registered listener, in the same synchronous pass.
 * That listener restores the scroll position immediately afterward, in
 * the same call stack, then unregisters itself so it can never fire on
 * some later, unrelated file-open. The target path is checked before
 * restoring (never before cleaning up), so an unrelated file-open that
 * slips in first is left alone.
 *
 * The original animation-frame-based restore stays too, as a harmless
 * secondary backstop, and this degrades gracefully (frame-based restore
 * only) if a future Obsidian version doesn't support the event listener
 * this relies on.
 *
 * Scope, and why it stops here: only the shelf-click-initiated open this
 * plugin drives itself. A file opened some other way while its own
 * branch is hidden (a wikilink click, the Quick Switcher, Obsidian's own
 * "Reveal file in navigation" command), or Obsidian's own native re-sort
 * re-running its reveal logic on its own account, still has no
 * equivalent "about to happen" moment this plugin can hook — see the
 * README's own Known Limits section.
 *
 * @param {*} plugin
 * @param {*} node - the file/folder about to be opened; used only to
 *   confirm a file-open event is really THIS open before restoring.
 */
function guardScrollAcrossHiddenBranchReveal(plugin, node) {
  const view = plugin.explorerView;
  const infinityScroll = view && view.tree && view.tree.infinityScroll;
  const scrollEl = infinityScroll && infinityScroll.scrollEl;
  if (!scrollEl) return;

  const capturedScrollTop = scrollEl.scrollTop;
  const restore = () => {
    if (plugin._unloaded) return;
    scrollEl.scrollTop = capturedScrollTop;
    if (typeof infinityScroll.updateVirtualDisplay === 'function') infinityScroll.updateVirtualDisplay();
  };

  // 0.13.6: the 'file-open'
  // listener -- the one that can accumulate/leak, per this whole fix --
  // is only ever worth holding when auto-reveal is actually on
  // SOMEWHERE (`computeAutoRevealState`'s own `anyOn`, the same test
  // every other auto-reveal-aware call site in this file already runs).
  // With auto-reveal fully off, Obsidian's own `revealActiveFile()`
  // never runs on a file-open, so there is nothing this listener could
  // ever catch -- it would only ever register, wait its full ~1s, and
  // tear itself down having done nothing. The `nextFrame` restore just
  // below stays UNCONDITIONAL either way: it is the pre-existing,
  // already-cheap backstop (a same-value write when nothing moved the
  // scroll), never the thing this finding is about.
  const workspace = plugin.app.workspace;
  const autoRevealOn = computeAutoRevealState(plugin.app).anyOn;
  if (autoRevealOn && workspace && typeof workspace.on === 'function' && typeof workspace.offref === 'function') {
    // 0.13.6: ONE pending ref,
    // held on the plugin itself, not a local `let` this function's own
    // closure would otherwise lose on return. A second shelf click
    // before the FIRST click's own 'file-open' ever arrives -- a rapid
    // double-click, or (see the timeout below) a click on a file that
    // never fires 'file-open' at all -- used to leave the first
    // listener registered forever, silently accumulating one live
    // 'file-open' subscriber per orphaned click for the rest of the
    // session. Any previous pending ref (and its own timeout) is torn
    // down before this one is created.
    if (plugin._revealGuardRef) {
      workspace.offref(plugin._revealGuardRef);
      plugin._revealGuardRef = null;
    }
    if (plugin._revealGuardTimeoutId) {
      clearTimeout(plugin._revealGuardTimeoutId);
      plugin._revealGuardTimeoutId = null;
    }
    plugin._revealGuardRef = workspace.on('file-open', (openedFile) => {
      // Cleanup runs unconditionally, on the FIRST file-open this listener
      // sees, matched or not -- an unmatched one (some unrelated file
      // opened first) must never leave this listener lingering to mis-fire
      // on a later, unrelated open.
      workspace.offref(plugin._revealGuardRef);
      plugin._revealGuardRef = null;
      if (plugin._revealGuardTimeoutId) {
        clearTimeout(plugin._revealGuardTimeoutId);
        plugin._revealGuardTimeoutId = null;
      }
      if (plugin._unloaded) return;
      if (node && openedFile && typeof openedFile.path === 'string' && openedFile.path !== node.path) return;
      restore();
    });
    // 0.13.6: a click that never
    // produces a 'file-open' at all -- a non-viewable file (routed to
    // `openWithDefaultApp`, never `setViewState`) or a click on the file
    // already open in the active leaf (Obsidian's own `openFile`
    // short-circuits, no event fires) -- would otherwise leave
    // `_revealGuardRef` pending forever: the same "orphaned listener"
    // failure the tracked ref above fixes for a rapid double-click,
    // triggered a different way. ~1s is generously longer than any real
    // 'file-open' this click could still be waiting on.
    plugin._revealGuardTimeoutId = setTimeout(() => {
      plugin._revealGuardTimeoutId = null;
      if (plugin._revealGuardRef) {
        workspace.offref(plugin._revealGuardRef);
        plugin._revealGuardRef = null;
      }
    }, 1000);
  }

  if (typeof plugin.app.nextFrame === 'function') {
    plugin.app.nextFrame(restore);
  }
}

function revealEntityCandidate(plugin, candidate, rootEntry) {
  const view = plugin.explorerView;
  const node = candidateNode(candidate);

  // A shelf row's click
  // behaves differently while its own root's branch is hidden -- only ever
  // reachable when the caller (renderShelfForRoot) hands its own `rootEntry`
  // in; every other call site (and every pre-0.13.0 test) omits it, which
  // reads as "branch showing," i.e. byte-identical to every build before
  // this one.
  const hiddenRoot =
    rootEntry && (plugin.settings.collapsedBranchRoots || []).includes(rootEntry.path) ? rootEntry : null;

  if (hiddenRoot) {
    if (candidate.kind !== 'folder') {
      // A note or file shelf row, branch hidden: open the file ONLY -- no
      // `revealInFolder`, no one-third scroll nudge, the branch stays
      // hidden. Duplicates the two-line `leaf.openFile()` call below rather
      // than falling through to it, specifically so it can `return` before
      // `positionRevealedRowOneThirdDown` ever runs.
      //
      // Guards the explorer's own
      // scroll position around this call, so a member with auto-reveal on
      // never has the Files panel jump toward this now-invisible row --
      // see `guardScrollAcrossHiddenBranchReveal`'s own doc comment for
      // exactly why this is the one call site that mitigation can reach.
      guardScrollAcrossHiddenBranchReveal(plugin, node);
      const leaf = typeof plugin.app.workspace.getLeaf === 'function' ? plugin.app.workspace.getLeaf(false) : null;
      if (leaf && typeof leaf.openFile === 'function') {
        // 0.13.6: `openFile`
        // returns a promise (a broken/missing file, a read error) that
        // nothing here was awaiting -- an unhandled rejection on a plain
        // row click. Caught and logged, same shape as every other
        // fire-and-forget write in this file, never surfaced as a
        // `Notice` (a failed open already shows Obsidian's own error).
        const openPromise = leaf.openFile(node);
        if (openPromise && typeof openPromise.catch === 'function') {
          openPromise.catch((err) => console.error('[spotlight] leaf.openFile failed (branch-hidden reveal)', err));
        }
      }
      return;
    }
    // A folder shelf row, branch hidden: un-hide first -- and it STAYS
    // un-hidden, it never re-hides afterwards
    // -- then fall through to the EXACT existing reveal/expand path below,
    // unchanged.
    const rootItem = view && view.fileItems && view.fileItems[hiddenRoot.path];
    applyBranchHiddenDomState(plugin, rootItem, false);
    // Syncs the OWNING root's own band in place, the same way the band's
    // own click handler does -- no `requestExplorerSort()`/
    // `scheduleStarReapply()` here either (see the render signature's own
    // doc comment: a reapply would remove-and-recreate every row on that
    // shelf, unrelated to the row actually clicked here).
    const toggleEl = rootItem && rootItem.el && typeof rootItem.el.querySelector === 'function' ? rootItem.el.querySelector(':scope > .spotlight-branch-toggle') : null;
    if (toggleEl) syncBranchToggleEl(toggleEl, false);
    plugin
      .setBranchHidden(hiddenRoot.path, false)
      .catch((err) => console.error('[spotlight] setBranchHidden failed while un-hiding from a shelf folder click', err));
  }

  if (view && typeof view.revealInFolder === 'function') {
    view.revealInFolder(node);
  }
  positionRevealedRowOneThirdDown(plugin, node);
  if (candidate.kind === 'folder') {
    // A folder shelf row's click doesn't just reveal the folder — it
    // expands it too. Obsidian's own reveal call expands every collapsed
    // ancestor on the way to the target, but leaves the target folder
    // itself exactly as collapsed as it already was, so this expands it
    // directly, using the same public tree-item method Obsidian's own
    // reveal logic uses for every ancestor (idempotent — a no-op if
    // already expanded — and without animation, to match).
    const item = view && view.fileItems && view.fileItems[node.path];
    if (item && typeof item.setCollapsed === 'function') {
      item.setCollapsed(false, false);
    }
    // Obsidian's own reveal call scrolls this same item into view on a
    // deferred callback that fires after this function returns, by which
    // point the folder is already expanded — the scroll lands on the
    // final, expanded state. `positionRevealedRowOneThirdDown`, called
    // above, queues its own adjustment right behind that one and
    // re-lands the row a third of the way down the pane; see its own
    // doc comment for the full timing argument.
    return;
  }
  // A `kind: 'file'` candidate has no `.entityNote` at all, hence
  // `candidateNode(candidate)` here rather than `candidate.entityNote`.
  // `leaf.openFile()` is the exact call Obsidian's own file-explorer row
  // click makes for any file, note or not, and it already contains the
  // viewable-vs-default-app split this needs — a registered view type
  // for the file's extension opens it in this leaf; none registered
  // opens it in the OS's own default app instead. Nothing here
  // re-implements that split; it would just be a second, potentially
  // divergent copy of logic Obsidian's own explorer already handles.
  const leaf = typeof plugin.app.workspace.getLeaf === 'function' ? plugin.app.workspace.getLeaf(false) : null;
  if (leaf && typeof leaf.openFile === 'function') {
    // Guards against an unhandled promise rejection the same way the
    // branch-hidden call site above does.
    const openPromise = leaf.openFile(candidateNode(candidate));
    if (openPromise && typeof openPromise.catch === 'function') {
      openPromise.catch((err) => console.error('[spotlight] leaf.openFile failed (shelf row reveal)', err));
    }
  }
}

/** The shelf's own "Remove from Spotlight" action, factored out of the
 * Menu-wiring below it so it's directly callable/testable without
 * simulating a real contextmenu -> Menu -> MenuItem round trip.
 * `plugin._unloaded` guarded:
 * a shelf row is plugin-owned DOM with its own live listeners — if it
 * somehow outlives `onunload()` (the orphan-sweep below is what should
 * prevent that, but this is one write path that could
 * still fire after), it must not write to a note after this plugin
 * instance has already torn itself down. */
async function unstarShelfEntity(plugin, candidate) {
  if (plugin._unloaded) return;
  await setCandidateStarState(plugin, candidate, false);
  plugin.requestExplorerSort();
  plugin.scheduleStarReapply();
}

/** The shelf star's own activation handler:
 * clicking the star directly un-spotlights the row without touching the
 * full row's reveal-and-open behavior. Trusted-event gated the same way
 * as `handleStarActivate`.
 * Everything on the shelf is, by construction, already starred, so there
 * is nothing to toggle; this is unconditionally a removal.
 *
 * REWRITTEN 0.13.3 (p7m, "before it leaves the
 * shelf" must feel immediate) -- the same optimistic-override pattern
 * `handleStarActivate` uses (see its own doc comment for the full
 * argument for why the override has to be set BEFORE the reapply call,
 * never after): this candidate's own path is marked "not starred" in
 * `plugin._optimisticStarOverrides` synchronously, then a real reapply
 * pass runs immediately, in the SAME task -- with the override in place
 * `computeStarredCandidates` no longer includes this path, so the row
 * leaves the shelf right away, before the write that will make it real
 * has landed. Deliberately does NOT call the shared `unstarShelfEntity`
 * (the context-menu route's own path, left exactly as it was): that
 * route is a slower, deliberate action where instant feedback matters
 * less, and reusing it here would mean writing AND awaiting from inside
 * a function this one also wants to wrap with its own override
 * lifecycle. */
async function handleShelfStarActivate(plugin, candidate, evt) {
  try {
    if (!evt || evt.isTrusted !== true) {
      console.warn('[spotlight] handleShelfStarActivate refused, origin is not a trusted user event');
      return;
    }
    if (plugin._unloaded) return;
    const path = candidatePath(candidate);
    plugin._optimisticStarOverrides = plugin._optimisticStarOverrides || new Map();
    plugin._optimisticStarOverrides.set(path, false);
    plugin._starWritesInFlight = plugin._starWritesInFlight || new Map();
    plugin._starWritesInFlight.set(path, (plugin._starWritesInFlight.get(path) || 0) + 1);
    plugin.runReapply();

    let ok = false;
    try {
      ok = await setCandidateStarState(plugin, candidate, false);
    } finally {
      const remaining = (plugin._starWritesInFlight.get(path) || 1) - 1;
      if (remaining <= 0) plugin._starWritesInFlight.delete(path);
      else plugin._starWritesInFlight.set(path, remaining);
      // Same 0.13.4 rule as `handleStarActivate`'s own finally, and the
      // SAME 0.13.6 fix: no
      // `usesPathStore(...)` guard any more -- see its own comment there
      // for the full argument.
      reconcileStarOverride(plugin, path, candidate);
    }
    if (!ok) {
      if (!plugin._starWritesInFlight.get(path)) {
        if (plugin._optimisticStarOverrides) plugin._optimisticStarOverrides.delete(path);
        plugin.runReapply(); // live state never changed -- the row comes back
      }
      new Notice(`Spotlight: couldn't remove that from the shelf`);
      return;
    }
    plugin.requestExplorerSort();
    plugin.scheduleStarReapply(); // safety net; the star-state cache already agrees, so this is a no-op pass
  } catch (err) {
    new Notice(`Spotlight: couldn't remove that from the shelf, ${(err && err.message) || err}`);
    console.error('[spotlight] handleShelfStarActivate failed', err);
  }
}

/** Removes a root's own shelf DOM, if present, and clears its cached
 * starred-signature (F4, below) so a later rebuild for the SAME root
 * never skips itself believing nothing changed. Queries `item.el`, not
 * `item.childrenEl` — the shelf's own home since F1 (see
 * `renderShelfForRoot`'s doc comment).
 *
 * Also removes the branch toggle (`renderShelfForRoot`'s
 * sibling of the shelf), created only when the shelf renders and removed
 * with it here, and un-hides `item.el` if it was branch-hidden — a
 * root that isn't drawing its own shelf right now (disabled, or a nested
 * root under an enabled ancestor, §3.3) has no band to reach the setting
 * from, so it must never keep visually hiding real files. The PERSISTED
 * `collapsedBranchRoots` entry is untouched here (mirrors
 * `collapsedShelfRoots`'s own survive-a-disable behaviour): re-enabling the
 * root restores its hidden state, same as re-enabling restores a collapsed
 * shelf. */
function removeShelfForRoot(plugin, rootEntry) {
  if (plugin._shelfSignatures) plugin._shelfSignatures.delete(rootEntry.path);
  const view = plugin.explorerView;
  const item = view && view.fileItems && view.fileItems[rootEntry.path];
  const container = item && item.el;
  const existing = container && container.querySelector && container.querySelector(':scope > .spotlight-shelf');
  if (existing) existing.remove();
  const toggle = container && container.querySelector && container.querySelector(':scope > .spotlight-branch-toggle');
  if (toggle) toggle.remove();
  // 0.13.6: removing the shelf/band
  // shrinks `item.el`'s own rendered height back to a bare row -- see
  // `invalidateItemHeight`'s own doc comment. Only when something was
  // actually removed (`existing` or `toggle` truthy); a root that never
  // had one costs nothing.
  if (item && (existing || toggle)) invalidateItemHeight(plugin, item);
  if (item) applyBranchHiddenDomState(plugin, item, false);
}

/**
 * Removes any `.spotlight-shelf` found anywhere in the explorer that no
 * longer corresponds to a CURRENTLY CONFIGURED root — an orphan left
 * behind by `removeRoot`/`setRootPath`: those two never used to sweep the shelf they'd made
 * unreachable-by-path, leaving it sitting in the DOM with live listeners
 * that could still write `spotlight` into a note, including after
 * unload). Each shelf carries its own `data-spotlight-shelf-root`
 * attribute (set when built, below) naming the root it belongs to — a
 * DISABLED root's shelf is NOT an orphan by this test (its path is still
 * configured; `renderAllShelves` removes it deliberately, by path,
 * itself) — only a root that has actually left `settings.roots`
 * (removed, or renamed out from under the old path) counts here.
 */
function sweepOrphanShelves(plugin) {
  const view = plugin.explorerView;
  if (!view || !view.containerEl || typeof view.containerEl.querySelectorAll !== 'function') return;
  const validPaths = new Set(plugin.settings.roots.map((r) => r.path));
  // Tracks which owning rows THIS pass already invalidated, so a root
  // whose shelf AND toggle are both orphaned together (the common case
  // -- they're built and removed as a pair) still invalidates exactly
  // once, matching `removeShelfForRoot`'s own single, OR-gated
  // `if (existing || toggle) invalidateItemHeight(...)` call, while a
  // toggle orphaned ALONE (its shelf already gone before this pass ran --
  // a "band-only orphan") still gets the call this loop used to
  // skip entirely.
  const invalidatedOwners = new Set();
  for (const shelf of view.containerEl.querySelectorAll('.spotlight-shelf')) {
    const rootPath = shelf.getAttribute('data-spotlight-shelf-root');
    if (validPaths.has(rootPath)) continue;
    const owner = shelf.parentNode;
    shelf.remove();
    if (rootPath && plugin._shelfSignatures) plugin._shelfSignatures.delete(rootPath);
    if (rootPath && plugin._shelfHadStars) plugin._shelfHadStars.delete(rootPath);
    // The branch's own hidden state is this shelf's
    // problem too now, not only the shelf DOM's -- an orphaned root
    // (removed, or renamed out from under its old path) must never leave
    // real files invisible behind a class nobody can reach a band to
    // clear any more.
    //
    // 0.13.6: un-hides through the
    // SAME real invalidate path `onunload()`'s own fix now uses, not a
    // bare `classList.remove()` -- a stale cached row height in the
    // virtualised list otherwise survives an un-hide that never told
    // `infinityScroll` about it. `findItemByEl` looks the owning row up
    // by DOM identity, not by `rootPath` (read off the shelf's own
    // attribute, which is exactly the stale value this whole function
    // exists to route around) -- see its own doc comment. Falls back to
    // the bare strip only when no `fileItems` entry can be found at all,
    // never leaves the class on with no attempt at the real path.
    const ownerItem = findItemByEl(view, owner);
    if (ownerItem) {
      // 0.13.6: the shelf removal just
      // above ALSO shrank the owner's own rendered height, independent
      // of whatever `applyBranchHiddenDomState` does for the branch-
      // hidden class -- see `invalidateItemHeight`'s own doc comment.
      invalidateItemHeight(plugin, ownerItem);
      invalidatedOwners.add(ownerItem);
      applyBranchHiddenDomState(plugin, ownerItem, false);
    } else if (owner && owner.classList) {
      owner.classList.remove('spotlight-branch-hidden');
    }
  }
  // The toggle is the shelf's own sibling (never inside it), created and
  // removed alongside it ("removed with it in
  // removeShelfForRoot and the orphan sweep") -- swept the same way, by
  // the SAME `data-spotlight-shelf-root` attribute (set alongside the
  // shelf's own, below).
  for (const toggle of view.containerEl.querySelectorAll('.spotlight-branch-toggle')) {
    const rootPath = toggle.getAttribute('data-spotlight-shelf-root');
    if (validPaths.has(rootPath)) continue;
    // 0.15.1:
    // capture the owner before `.remove()` (a removed node's own
    // `.parentNode` goes `null`), same as the shelf loop above.
    const owner = toggle.parentNode;
    toggle.remove();
    const ownerItem = findItemByEl(view, owner);
    // Invalidate only if the shelf loop above didn't already do it for
    // this SAME owner -- the ordinary case (a root's shelf and toggle
    // orphaned together) already got its one call there; this is for
    // a toggle whose own shelf was already
    // gone before this pass ran, which this loop used to remove with no
    // invalidate at all (see `invalidatedOwners`'s own doc comment).
    if (ownerItem && !invalidatedOwners.has(ownerItem)) {
      invalidateItemHeight(plugin, ownerItem);
      invalidatedOwners.add(ownerItem);
    }
  }
}

/**
 * RETIRED. This function
 * used to read `--nav-item-children-margin-start` off `document.body`
 * once per render and write the result back as an inline
 * `--spotlight-shelf-indent` on every shelf/band, to satisfy the rule
 * that the shelf's left edge is a pure function of root depth --
 * never
 * tuned to what looks right today, and independent of hidden/shown,
 * collapsed, measured-or-not, render order, or which other roots
 * exist -- see this file's own git history for the full account
 * of the two-bug `getBoundingClientRect()` approach it
 * replaced.
 *
 * `styles.css` now reads `--nav-item-children-margin-start` DIRECTLY in
 * the shelf's and band's own `margin-inline-start` (see its own doc
 * comment, `:where(body)` block) -- a real DOM inheritance through the
 * actual cascade, not a value this plugin captured off `document.body`
 * and re-wrote on every reapply pass. The same rule holds the same
 * way it always did (one global constant, so same-depth roots
 * always align) but now needs no JS measurement step, and picks up a
 * LIVE theme/snippet change on the very next paint instead of waiting
 * for a reapply pass to notice it.
 */

/**
 * The shelf icon for a `kind: 'file'` row, chosen by extension. Obsidian's
 * own file-explorer row draws no per-extension icon at all for a non-note
 * file — just a small text badge with the raw extension — so there's no
 * existing icon choice to match here. This picks from three of Obsidian's
 * own icon names (also used elsewhere in the app for these file kinds):
 * an image extension gets `image`, an audio extension gets `file-audio`,
 * and everything else (video, `.base`, `.canvas`, unknown) gets
 * `file-text`.
 */
const SPOTLIGHT_IMAGE_EXTENSIONS = new Set(['bmp', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif']);
const SPOTLIGHT_AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', '3gp', 'flac', 'ogg', 'oga', 'opus']);

function spotlightFileIconName(extension) {
  const ext = String(extension || '').toLowerCase();
  if (SPOTLIGHT_IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (SPOTLIGHT_AUDIO_EXTENSIONS.has(ext)) return 'file-audio';
  return 'file-text';
}

/** Builds one shelf ROW for `candidate`, wired with every listener it
 * needs (reveal on row click, un-spotlight on the star or the context
 * menu) -- extracted 0.13.4 from what used to be `renderShelfForRoot`'s
 * own inline build loop, so both a first-time full build AND
 * `diffShelfRows`' incremental one (below) share exactly one row-shape
 * definition. Does NOT append the row anywhere -- the caller decides
 * append vs. positional `insertBefore`. `rows`/`header` are the shelf's
 * own (already-existing-or-about-to-exist) containers, closed over only
 * for `moveFocusBeforeRemoval`'s own neighbour-row lookup, unchanged from
 * the pre-0.13.4 inline version. */
function buildShelfRow(plugin, rootEntry, candidate, rows, header) {
  const row = document.createElement('div');
  row.className = 'spotlight-shelf-row';
  row.setAttribute('data-spotlight-shelf-path', candidatePath(candidate));

  const star = document.createElement('span');
  star.className = 'spotlight-shelf-star';
  // 0.15.1: `setIcon()`, same
  // fix and same reasoning as `ensureStarOnRow`'s own inline star, above.
  if (typeof setIcon === 'function') setIcon(star, 'star');
  // clicking the star directly un-spotlights
  // the entity and removes it from the shelf, without going through the
  // full list below. This is its own control, sibling to the title,
  // never nested inside it (no button-in-button), with its own
  // role/tabindex/aria-label, guarded the same way the inline star is.
  star.setAttribute('role', 'button');
  star.setAttribute('tabindex', '0');
  star.setAttribute('aria-label', 'Remove from Spotlight');

  // The kind icon (folder / file-text) is DROPPED here: it was the
  // third object crowding the star and
  // consumed the horizontal budget the +40px title column needs.
  const title = document.createElement('span');
  title.className = 'spotlight-shelf-title';
  // 0.7.0: a folder candidate's own title is its folder name
  // (`target.name`), there's no note `.basename` to fall back to.
  // 0.10.0: a `kind: 'file'` candidate's own title is its file name
  // WITH extension (`target.name`, e.g. "diagram.png") -- never
  // `.basename` (which a TFile also has, but which would drop the
  // extension) -- "two files that differ only by
  // extension stay distinct." 0.11.0: `kind: 'carrier'` is gone (the
  // GL-063 convention it named is retired) -- `kind: 'flat'` is now
  // the only note kind, always its own basename, whether or not it
  // happens to share a folder's name; a folder holding a same-named
  // note shows on the shelf as two ordinary, independent rows now (the
  // folder icon, below, is what tells them apart), never one row
  // borrowing the other's name.
  title.textContent = candidate.kind === 'folder' || candidate.kind === 'file' ? candidate.target.name : candidate.entityNote.basename;
  // role/tabindex/Enter-Space live on the TITLE now. The row itself keeps only its plain click listener
  // (below) so the whole line still jumps to/opens the real row on a
  // mouse click, while keyboard focus lands on the title, not the star,
  // when tabbing onto the row.
  title.setAttribute('role', 'button');
  title.setAttribute('tabindex', '0');

  row.appendChild(star);
  // a FOLDER shelf row (never a note row)
  // gets its own kind icon, between the star and the title, drawn via
  // Obsidian's OWN setIcon() -- the platform-native icon, preferred over a
  // hand-rolled SVG. This deliberately reopens the "kind icon" an
  // earlier version dropped (see styles.css's own comment
  // there): the title column no longer shares one rail with a note
  // row's own for a folder row specifically, and that is this ruling,
  // not a regression of it -- see the "geometry arithmetic" test
  // (test/spotlight-explorer.test.mjs) for the exact math.
  if (candidate.kind === 'folder') {
    const kindIcon = document.createElement('span');
    kindIcon.className = 'spotlight-shelf-folder-icon';
    if (typeof setIcon === 'function') setIcon(kindIcon, 'folder');
    row.appendChild(kindIcon);
  } else if (candidate.kind === 'file') {
    // A file shelf row gets its own kind icon too, same placement, same
    // mechanism (Obsidian's own `setIcon()`) as the folder icon above —
    // see `spotlightFileIconName()`'s own doc comment for how the icon
    // is chosen. `.spotlight-shelf-file-icon`
    // shares every size/colour rule `.spotlight-shelf-folder-icon` has
    // in styles.css (one selector, two class names) rather than
    // reusing the folder class outright -- a future geometry test can
    // still tell which kind of row it measured.
    const kindIcon = document.createElement('span');
    kindIcon.className = 'spotlight-shelf-file-icon';
    if (typeof setIcon === 'function') setIcon(kindIcon, spotlightFileIconName(candidate.target.extension));
    row.appendChild(kindIcon);
  }
  row.appendChild(title);

  // Moves focus off a star about to disappear -- before the write, so
  // the currently-focused element is still the real one to check
  // against. Prefers the next row's star, then the previous row's, then
  // the shelf header itself, so a keyboard member never loses focus
  // into thin air when their row vanishes out from under them.
  // Wrapped in its own try/catch: this
  // used to run `rows.children.indexOf(row)`, which throws in a real
  // browser (`HTMLCollection` has no `indexOf`, only Array does) so the
  // click listener below never reached `handleShelfStarActivate` at all,
  // even though it has its own try/catch, because this call happens
  // BEFORE that function is invoked. Fixed below to use
  // `Array.prototype.indexOf.call`, but this try/catch stays as the
  // backstop: a focus-move failure must never again block the write.
  const moveFocusBeforeRemoval = () => {
    try {
      if (typeof document === 'undefined' || document.activeElement !== star) return;
      const idx = Array.prototype.indexOf.call(rows.children, row);
      const nextRow = rows.children[idx + 1];
      const prevRow = rows.children[idx - 1];
      const nextStar = nextRow && typeof nextRow.querySelector === 'function' ? nextRow.querySelector(':scope > .spotlight-shelf-star') : null;
      const prevStar = prevRow && typeof prevRow.querySelector === 'function' ? prevRow.querySelector(':scope > .spotlight-shelf-star') : null;
      const target = nextStar || prevStar || header;
      if (target && typeof target.focus === 'function') target.focus();
    } catch (err) {
      console.error('[spotlight] moveFocusBeforeRemoval failed, continuing without moving focus', err);
    }
  };

  row.addEventListener('click', () => revealEntityCandidate(plugin, candidate, rootEntry));
  title.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Enter' && evt.key !== ' ') return;
    evt.preventDefault();
    revealEntityCandidate(plugin, candidate, rootEntry);
  });
  star.addEventListener('click', (evt) => {
    evt.stopPropagation();
    evt.preventDefault();
    moveFocusBeforeRemoval();
    handleShelfStarActivate(plugin, candidate, evt).catch((err) => console.error('[spotlight] unhandled handleShelfStarActivate rejection', err));
  });
  star.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Enter' && evt.key !== ' ') return;
    evt.stopPropagation();
    evt.preventDefault();
    moveFocusBeforeRemoval();
    handleShelfStarActivate(plugin, candidate, evt).catch((err) => console.error('[spotlight] unhandled handleShelfStarActivate rejection', err));
  });
  row.addEventListener('contextmenu', (evt) => {
    evt.preventDefault();
    const menu = new Menu();
    menu.addItem((menuItem) =>
      menuItem
        .setTitle('Remove from Spotlight')
        .setIcon('star')
        .onClick(() => unstarShelfEntity(plugin, candidate)),
    );
    if (typeof menu.showAtMouseEvent === 'function') menu.showAtMouseEvent(evt);
  });

  return row;
}

/**
 * 0.13.4 ("there is now an intermittent
 * flicker when some items are added to the shelf ... if you click
 * several in rapid succession it almost always starts to happen").
 * Root-caused live-suspect #2, confirmed with an instrumented test
 * (`test/spotlight-explorer.test.mjs`, the "REWRITTEN 0.13.4" gate):
 * `renderShelfForRoot` used to `existing.remove()` the WHOLE shelf and
 * rebuild every row from scratch on ANY change to the starred set, even
 * for the rows that hadn't changed at all -- visible DOM churn (and a
 * real teardown-then-recreate, not merely a repaint) on every single
 * star click, compounding with rapid clicks into what read as flicker.
 *
 * Reconciles `existing`'s own `.spotlight-shelf-rows` container against
 * the new, already-final `starred` list, in place: a candidate whose row
 * already exists is kept (and moved into position if the order changed,
 * never rebuilt); a newly-starred candidate gets exactly one new row,
 * built via `buildShelfRow`; a candidate that left the starred set has
 * exactly its own row removed. The shelf/header/toggle/rows CONTAINERS
 * themselves are never touched here -- only their children.
 */
/**
 * @returns {boolean} whether the shelf's own ROW COUNT changed (a row
 *   added or removed) -- reordering/keeping the same set does not
 *   change `shelfEl`'s own rendered height, only a genuine add/remove
 *   does. 0.13.6: the caller uses this
 *   to decide whether `item.el`'s own height actually changed and
 *   `infinityScroll` needs telling -- see `invalidateItemHeight`'s own
 *   doc comment.
 */
function diffShelfRows(plugin, rootEntry, shelfEl, starred) {
  const rows = shelfEl.querySelector(':scope > .spotlight-shelf-rows');
  if (!rows) return false; // defensive -- every shelf this function is ever called on has one
  const countBefore = rows.children.length;
  const header = shelfEl.querySelector(':scope > .spotlight-shelf-header');

  const existingByPath = new Map();
  for (const rowEl of Array.from(rows.children)) {
    const path = rowEl.getAttribute && rowEl.getAttribute('data-spotlight-shelf-path');
    if (path) existingByPath.set(path, rowEl);
  }

  const keep = new Set();
  for (const candidate of starred) {
    const path = candidatePath(candidate);
    keep.add(path);
    const currentAtCursor = rows.children[keep.size - 1];
    let rowEl = existingByPath.get(path);
    if (!rowEl) {
      rowEl = buildShelfRow(plugin, rootEntry, candidate, rows, header);
    }
    if (currentAtCursor !== rowEl) {
      rows.insertBefore(rowEl, currentAtCursor || null);
    }
  }

  // Anything left in `existingByPath` whose path never appeared in the
  // new `starred` list is a row that left the shelf -- remove exactly
  // that one row, nothing else.
  for (const [path, rowEl] of existingByPath) {
    if (!keep.has(path)) rowEl.remove();
  }
  return rows.children.length !== countBefore;
}

/**
 * Builds (or rebuilds) one root's own shelf from an ALREADY-FINAL
 * `starred` list — nothing when it's empty (rule 4). The cross-root
 * dedupe AND the one-fence-per-branch rollup (§3.3) both happen in the
 * caller (`renderAllShelves`) now, not here; this function only ever
 * draws what it's handed.
 *
 * `view.fileItems` holds a row for every file/folder at load, not just
 * visible ones, so this reaches a collapsed root exactly like
 * `reapplyStars` already reaches a collapsed lane.
 *
 * PLACEMENT, the shelf is now a
 * child of the row's own `.el` (the outer wrapper), inserted immediately
 * BEFORE `.childrenEl` — never INSIDE `.childrenEl` any more. Obsidian's
 * own infinity-scroll layout pass rewrites `childrenEl`'s contents
 * wholesale (`setChildrenInPlace`) on every scroll frame; a shelf placed
 * inside it was being deleted and force-reinserted by this plugin's own
 * MutationObserver on nearly every scroll, which also threw off
 * `childrenEl`'s own height math (and, through that, `revealInFolder`'s
 * scroll target). `.el` is never rewritten this way, and it's the same
 * element Obsidian's own collapse toggle marks `.is-collapsed` on
 * (styles.css's own `.is-collapsed > .spotlight-shelf` rule hides the
 * shelf under a collapsed root, now that it's no longer a genuine child
 * of `childrenEl`, which already hid itself).
 *
 * SIGNATURE CACHE, rebuilding
 * (remove, then recreate) on every reapply — which fires on nearly any
 * vault activity — emits `childList` mutations that wake OTHER installed
 * ICOR plugins' own MutationObservers into a full sweep of the explorer.
 * `plugin._shelfSignatures` (a `Map<rootPath, string>`) remembers the
 * last-rendered starred-path list per root; an unchanged signature with
 * the shelf already present (or already correctly absent) returns
 * WITHOUT touching the DOM at all.
 *
 * DIFF, NOT REBUILD, a signature
 * CHANGE with the shelf already present no longer means `existing.remove()`
 * -- see `diffShelfRows`' own doc comment. Only a transition to/from
 * EMPTY (no shelf can exist with zero starred items) still tears the
 * whole shelf down; every other change reconciles rows in place.
 */
function renderShelfForRoot(plugin, rootEntry, starred) {
  const view = plugin.explorerView;
  if (!view || !view.fileItems) return;
  const item = view.fileItems[rootEntry.path];
  if (!item || !item.el || !item.childrenEl) return; // root not materialized yet

  plugin._shelfSignatures = plugin._shelfSignatures || new Map();
  // Lazy-init the same way, for a caller (a test, or a
  // future one) that never ran `installRowInjection()` first.
  plugin._shelfHadStars = plugin._shelfHadStars || new Map();
  // The branch-hidden flag deliberately does NOT fold
  // into the signature (unlike `spotlightFolders` just below it) -- it
  // never changes what candidates this root discovers, and folding it in
  // would force a full remove-and-recreate of every row on the shelf
  // (destroying the just-focused band's own DOM one frame after a
  // keyboard Enter/Space toggles it) for a state change this function
  // already applies in place, below, exactly like `collapsedShelfRoots`
  // (`is-collapsed`) already isn't in this signature either, for the same
  // reason.
  const branchHidden = (plugin.settings.collapsedBranchRoots || []).includes(rootEntry.path);
  // 0.7.0: `candidatePath(c)`, not `c.entityNote.path` -- a folder
  // candidate has no `.entityNote` at all (see the "Candidate helpers"
  // block above) and would throw here on the very first shelf rebuild
  // after a root's `spotlightFolders` toggle went on.
  const signature = JSON.stringify([rootEntry.spotlightFolders === true, starred.map((c) => candidatePath(c))]);
  const existing = item.el.querySelector(':scope > .spotlight-shelf');
  // 0.13.6, live-verified residue:
  // a shelf built by a PRE-0.13.6 install (still sitting in the DOM --
  // Obsidian does not recreate file-explorer rows just because a plugin
  // reloaded/updated) can still carry the OLD inline
  // `--spotlight-shelf-indent` this build no longer ever sets. Neither
  // branch below (the short-circuit return, nor the diff-in-place
  // reconcile) otherwise touches that element's inline style at all, so
  // a stale-but-numerically-correct-today value would keep shadowing the
  // real CSS cascade — silently defeating the very point of this
  // condition (a live theme/snippet change picked up with no reapply
  // needed) for exactly the shelves that existed before the upgrade,
  // until some OTHER change happened to force a full rebuild. Cheap and
  // idempotent (`removeProperty` on an unset property is a no-op) --
  // run unconditionally, on every call, before either branch.
  if (existing && existing.style && typeof existing.style.removeProperty === 'function') {
    existing.style.removeProperty('--spotlight-shelf-indent');
  }
  if (plugin._shelfSignatures.get(rootEntry.path) === signature && (existing || starred.length === 0)) {
    // Unchanged since the last render -- zero DOM mutation on the SHELF
    // itself (F4). Still worth a cheap, idempotent
    // defensive sync of the branch-hidden state on the way out -- covers
    // any caller that reaches this function without first running
    // `reapplyBranchHiddenState` (every real caller does, but a future one
    // might not), so settings and DOM can never quietly drift apart on a
    // path that never rebuilds.
    applyBranchHiddenDomState(plugin, item, branchHidden);
    const existingToggleForSync = item.el.querySelector && item.el.querySelector(':scope > .spotlight-branch-toggle');
    if (existingToggleForSync) syncBranchToggleEl(existingToggleForSync, branchHidden);
    return;
  }
  plugin._shelfSignatures.set(rootEntry.path, signature);

  // 0.13.4:
  // a signature change with the shelf ALREADY present and something
  // still starred is reconciled in place, never torn down. Only a
  // transition through/to EMPTY still falls through to a full
  // remove-and-recreate below (there is no shelf to diff against).
  if (existing && starred.length > 0) {
    const rowCountChanged = diffShelfRows(plugin, rootEntry, existing, starred);
    // 0.13.6: a row added or removed
    // changes the shelf's own rendered height, and therefore `item.el`'s
    // -- see `invalidateItemHeight`'s own doc comment. A pure reorder
    // (row count unchanged) never does, so this only fires when
    // `diffShelfRows` actually reports a real change.
    if (rowCountChanged) invalidateItemHeight(plugin, item);
    const header = existing.querySelector(':scope > .spotlight-shelf-header');
    const label = header && header.querySelector(':scope > .spotlight-shelf-header-label');
    if (label) label.textContent = `SPOTLIGHT (${starred.length})`;
    if (plugin._shelfHadStars) plugin._shelfHadStars.set(rootEntry.path, true);
    applyBranchHiddenDomState(plugin, item, branchHidden);
    const toggleForSync = item.el.querySelector && item.el.querySelector(':scope > .spotlight-branch-toggle');
    if (toggleForSync) syncBranchToggleEl(toggleForSync, branchHidden);
    return;
  }

  // 0.13.6: reaching this line with
  // `existing` truthy means the shelf (and its band) are about to be
  // removed outright -- `item.el`'s own height is about to shrink back
  // to a bare row. See `invalidateItemHeight`'s own doc comment.
  if (existing) {
    existing.remove();
    invalidateItemHeight(plugin, item);
  }
  // The branch toggle is the shelf's own sibling, created
  // only when the shelf renders and removed with it -- so
  // any rebuild that's about to remove/recreate the shelf removes the old
  // band here too, before the `starred.length === 0` early-out below.
  const existingToggle = item.el.querySelector && item.el.querySelector(':scope > .spotlight-branch-toggle');
  if (existingToggle) existingToggle.remove();
  if (starred.length === 0) {
    // Per "un-starring the last item forgets the hidden
    // state" -- an empty root can never hide a branch with no shelf, and
    // therefore no band, left to un-hide it from. The DOM always un-hides
    // here regardless (no shelf, no band, nothing may stay hidden), but
    // the PERSISTED setting is cleared only on a genuine transition FROM
    // having stars TO having none THIS SESSION -- `_shelfHadStars` (reset
    // per view acquisition, `installRowInjection`) tells a real un-star
    // apart from a cold-boot pass whose metadata simply hasn't resolved
    // yet, which would otherwise erase a member's hidden setting the very
    // first time an empty-looking pass ran before anything was indexed.
    const hadStarsBefore = plugin._shelfHadStars && plugin._shelfHadStars.get(rootEntry.path) === true;
    if (plugin._shelfHadStars) plugin._shelfHadStars.set(rootEntry.path, false);
    applyBranchHiddenDomState(plugin, item, false);
    if (branchHidden && hadStarsBefore) {
      plugin
        .setBranchHidden(rootEntry.path, false)
        .catch((err) => console.error('[spotlight] setBranchHidden failed clearing an emptied root', err));
    }
    return;
  }
  if (plugin._shelfHadStars) plugin._shelfHadStars.set(rootEntry.path, true);

  const collapsed = (plugin.settings.collapsedShelfRoots || []).includes(rootEntry.path);

  const shelf = document.createElement('div');
  shelf.className = collapsed ? 'spotlight-shelf is-collapsed' : 'spotlight-shelf';
  shelf.setAttribute('data-spotlight-shelf-root', rootEntry.path);
  // 0.13.6: no inline
  // `--spotlight-shelf-indent` set here any more -- `styles.css`'s own
  // `margin-inline-start` now reads `--nav-item-children-margin-start`
  // directly, inherited through the real DOM cascade from wherever a
  // theme/snippet sets it, never a value this plugin measured and wrote
  // back. See `measureShelfRail`'s own retirement comment, above, for
  // the full account.

  const header = document.createElement('div');
  header.className = 'spotlight-shelf-header';
  header.setAttribute('role', 'button');
  header.setAttribute('tabindex', '0');
  const chevron = document.createElement('span');
  chevron.className = 'spotlight-shelf-chevron';
  // Obsidian's own tree-collapse glyph via
  // the public setIcon() API, not a hand-typed unicode triangle.
  if (typeof setIcon === 'function') setIcon(chevron, collapsed ? 'chevron-right' : 'chevron-down');
  const label = document.createElement('span');
  label.className = 'spotlight-shelf-header-label';
  // SPOTLIGHT, not FOCUS -- the word
  // an earlier design reference used and the shelf reintroduced. Guarded by a test assertion (spotlight-explorer.test.mjs,
  // the "one row for the starred carrier entity" test), never rely on
  // this comment alone.
  label.textContent = `SPOTLIGHT (${starred.length})`;
  header.appendChild(chevron);
  header.appendChild(label);
  // The existing header gets its
  // own hover/aria label too, now that a second, visually similar control
  // sits right below it.
  header.setAttribute('aria-label', collapsed ? 'Expand Spotlight list' : 'Collapse Spotlight list');

  const rows = document.createElement('div');
  rows.className = 'spotlight-shelf-rows';

  const toggleCollapsed = () => {
    const nowCollapsed = shelf.classList.toggle('is-collapsed');
    if (typeof setIcon === 'function') setIcon(chevron, nowCollapsed ? 'chevron-right' : 'chevron-down');
    header.setAttribute('aria-label', nowCollapsed ? 'Expand Spotlight list' : 'Collapse Spotlight list');
    // 0.13.6: the shelf's OWN collapse
    // toggle hides/shows `.spotlight-shelf-rows` (styles.css's own
    // `.is-collapsed` rule) -- exactly the same class of `item.el`
    // height change as a shelf appearing/disappearing, just smaller.
    // Pre-dates 0.13.0 entirely (0.4.1's own original collapse feature)
    // -- see `invalidateItemHeight`'s own doc comment.
    invalidateItemHeight(plugin, item);
    plugin.setShelfCollapsed(rootEntry.path, nowCollapsed);
  };
  header.addEventListener('click', toggleCollapsed);
  header.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Enter' && evt.key !== ' ') return;
    evt.preventDefault();
    toggleCollapsed();
  });

  for (const candidate of starred) {
    rows.appendChild(buildShelfRow(plugin, rootEntry, candidate, rows, header));
  }

  shelf.appendChild(header);
  shelf.appendChild(rows);

  // the branch toggle -- a small tab hanging off the shelf's own bottom
  // stroke line, hides/shows everything below the shelf (the real branch),
  // leaving only the shelf itself in view. A SIBLING of the shelf, never a
  // child of it (`.spotlight-shelf { overflow: hidden }` would clip
  // anything hanging off its border) and never inside `childrenEl` either
  // (infinity-scroll rewrites that wholesale on every scroll frame).
  // Created only when the shelf itself renders (starred.length > 0, already
  // guarded by the early-return above) and removed with it (this function's
  // own `existingToggle` cleanup above, and `removeShelfForRoot`/the orphan
  // sweep). Blocked outright on the vault root --
  // `normalizeRootPath` reduces `'/'` (or `''`) to `''`, and there is
  // no row for the vault root in `view.fileItems` to begin with, but this
  // guard stands regardless of that, in case a future Obsidian build ever
  // materializes one.
  const isVaultRootEntry = normalizeRootPath(rootEntry.path) === '';
  let toggle = null;
  if (isVaultRootEntry) {
    shelf.classList.remove('has-branch-toggle');
  } else {
    // Shelf geometry: margin-bottom goes from 6px to 0 --
    // the band itself now supplies that gap (see styles.css).
    shelf.classList.add('has-branch-toggle');

    toggle = document.createElement('div');
    toggle.className = 'spotlight-branch-toggle';
    toggle.setAttribute('role', 'button');
    toggle.setAttribute('tabindex', '0');
    // Same attribute the shelf itself carries, same reason: the orphan
    // sweep and (defensively) the settings-driven caches key off it.
    toggle.setAttribute('data-spotlight-shelf-root', rootEntry.path);
    const tab = document.createElement('span');
    tab.className = 'spotlight-branch-toggle-tab';
    toggle.appendChild(tab);
    syncBranchToggleEl(toggle, branchHidden);

    // Applies IN PLACE, no `requestExplorerSort()` /
    // `scheduleStarReapply()` -- exactly the discipline the shelf header's
    // OWN `toggleCollapsed` above already follows (a class flip that
    // changes no sort order and no candidate set never needs a reapply).
    // Deliberately NOT folded into the shelf's own render signature either
    // (see that signature's own doc comment, above): a reapply here would
    // remove-and-recreate every row on the shelf a frame after a keyboard
    // Enter/Space fires, dropping focus off the very control that was
    // just used.
    const toggleBranch = () => {
      const nowHidden = !toggle.classList.contains('is-hidden');
      // The DOM (item.el's own class, plus the mirrored invalidate pair)
      // and this band's own icon/aria both flip INSTANTLY, no animation --
      // never waiting on the settings write
      // below, which is fire-and-forget from this handler's own point of
      // view (its own `.catch` logs, never blocks or throws into the
      // click).
      applyBranchHiddenDomState(plugin, item, nowHidden);
      syncBranchToggleEl(toggle, nowHidden);
      plugin
        .setBranchHidden(rootEntry.path, nowHidden)
        .catch((err) => console.error('[spotlight] setBranchHidden failed', err));
    };
    toggle.addEventListener('click', (evt) => {
      // "Stop propagation so the click never
      // reaches the native row." The band sits outside the native row's
      // own `selfEl` regardless (a sibling of `childrenEl` inside `item.el`,
      // never inside `selfEl`), so this is belt-and-suspenders, same as
      // every other plugin-drawn control on this surface already does.
      if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
      toggleBranch();
    });
    toggle.addEventListener('keydown', (evt) => {
      if (evt.key !== 'Enter' && evt.key !== ' ') return;
      if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
      evt.preventDefault();
      toggleBranch();
    });
  }

  // F1: a sibling of childrenEl, inside el -- never a child of childrenEl
  // itself. Guarded:
  // a real DOM insertBefore throws when the reference node isn't
  // currently item.el's own child; that should always hold here since
  // childrenEl is a standing part of a materialized folder row, but the
  // fallback keeps this from ever throwing into a reapply pass if that
  // assumption is ever wrong on some Obsidian build.
  if (item.childrenEl.parentNode === item.el) {
    item.el.insertBefore(shelf, item.childrenEl);
    if (toggle) item.el.insertBefore(toggle, item.childrenEl);
  } else {
    item.el.appendChild(shelf);
    if (toggle) item.el.appendChild(toggle);
  }

  // 0.13.6: a brand-new shelf (+ band)
  // just grew `item.el`'s own rendered height from a bare row -- see
  // `invalidateItemHeight`'s own doc comment.
  invalidateItemHeight(plugin, item);

  // Re-apply the class here
  // too, on every render this function actually performs -- covers the
  // "item.el is rebuilt" case (a freshly (re)acquired explorer view) as
  // soon as this root's OWN shelf next rebuilds, without waiting on the
  // next `reapplyBranchHiddenState` pass. Idempotent (see its own doc
  // comment): a no-op, no `invalidate()` call, when `item.el` already
  // carries the correct class.
  applyBranchHiddenDomState(plugin, item, branchHidden);
}

/**
 * Rebuilds every enabled root's own shelf. Sweeps orphans first (F2).
 *
 * ONE FENCE PER BRANCH -- this is a
 * design invariant, not a settings accident: the outermost enabled
 * root owns its branch's single shelf. A nested enabled root draws no
 * shelf while an ancestor root is enabled, and its starred entities
 * appear on the ancestor's shelf, deduplicated by path. Two enabled
 * roots can still be ancestor/descendant of each other post-migration
 * (`dedupeCollidingRoots` only runs at migration time; a member is free
 * to re-enable one by hand afterward with no re-check — `setRootEnabled`
 * never calls `checkRootCollision`). Processed shortest-path-first so an
 * outer, often area-typed root's own candidates claim a path before a
 * nested, usually type-agnostic root's laxer rule would grab it first —
 * the same cross-root dedupe discipline `reapplyStars` already applies,
 * generalized here to also decide WHICH root gets to draw at all.
 */
function renderAllShelves(plugin) {
  sweepOrphanShelves(plugin);
  const enabled = plugin.settings.roots.filter((r) => r.enabled);

  const outermostOf = (entry) => {
    let outer = entry;
    for (const other of enabled) {
      if (other !== entry && rootsCollide(other.path, entry.path) && other.path.length < outer.path.length) {
        outer = other;
      }
    }
    return outer;
  };

  const claimedPaths = new Set();
  const contentByOwner = new Map();
  const bySpecificity = [...enabled].sort((a, b) => a.path.length - b.path.length);
  for (const rootEntry of bySpecificity) {
    const rootFolder = plugin.getRootFolder(rootEntry.path);
    const allStarred = rootFolder
      ? computeStarredCandidates(rootFolder, {
          // 0.13.3 (p7m): route through the SAME optimistic-override check
          // `getCandidateStarState` applies -- `computeStarredCandidates`
          // takes these two callbacks directly rather than a candidate
          // dispatcher, so without this the shelf would read genuinely
          // live state for a path a click just optimistically flipped,
          // completely missing the override `handleStarActivate`/
          // `handleShelfStarActivate` just set. `undefined` (no override
          // for this path) falls through to the exact same live read
          // these two callbacks already did.
          isStarred: (note) => {
            const override = plugin._optimisticStarOverrides && plugin._optimisticStarOverrides.get(note.path);
            return override !== undefined ? override : getSpotlightState(plugin.app, note);
          },
          isFolderStarred: (folder) => {
            const override = plugin._optimisticStarOverrides && plugin._optimisticStarOverrides.get(folder.path);
            return override !== undefined ? override : isFolderStarred(plugin, folder.path);
          },
          spotlightFolders: rootEntry.spotlightFolders === true,
        })
      : [];
    const fresh = allStarred.filter((c) => !claimedPaths.has(candidatePath(c)));
    for (const c of fresh) claimedPaths.add(candidatePath(c));
    const owner = outermostOf(rootEntry);
    contentByOwner.set(owner, (contentByOwner.get(owner) || []).concat(fresh));
  }

  for (const rootEntry of plugin.settings.roots) {
    if (!rootEntry.enabled) {
      removeShelfForRoot(plugin, rootEntry);
      continue;
    }
    const owner = outermostOf(rootEntry);
    if (owner !== rootEntry) {
      removeShelfForRoot(plugin, rootEntry); // nested under an enabled ancestor -- never its own shelf (§3.3)
      continue;
    }
    renderShelfForRoot(plugin, rootEntry, contentByOwner.get(rootEntry) || []);
  }
}

/* ========================================================================
 * Conflict detection — the star still collides with Iconize's own guard,
 * unchanged. The sort-patcher conflict check (obsidian-custom-sort, File
 * Explorer++, Pinup, Pinit) is RETIRED 0.5.0 along with the lift it
 * existed to protect — "no lift installed = nothing to contest" is now
 * true unconditionally, not just in degraded mode. See BUILD STATE
 * (v0.5.0) at the top of this file.
 * ==================================================================== */

/** `app.plugins.plugins[id]` existing AND `._loaded` AND present in
 * `enabledPlugins` — a disabled-but-still-registered plugin object can
 * linger in `.plugins` without being active. */
function isCommunityPluginActive(app, id) {
  if (!id) return false;
  const plugins = app.plugins;
  if (!plugins || !plugins.plugins || !plugins.plugins[id]) return false;
  if (!plugins.plugins[id]._loaded) return false;
  if (plugins.enabledPlugins && typeof plugins.enabledPlugins.has === 'function' && !plugins.enabledPlugins.has(id)) {
    return false;
  }
  return true;
}

/** Iconize's real id is `obsidian-icon-folder` (confirmed against both
 * community-plugins.json and the shipped plugin's own manifest.json,
 * 2026-09-07) — its display name changed, its id didn't. */
const KNOWN_DECORATION_CONFLICTS = [{ id: 'obsidian-icon-folder', label: 'Iconize' }];

function detectActiveDecorationConflicts(app) {
  try {
    return KNOWN_DECORATION_CONFLICTS.filter((entry) => isCommunityPluginActive(app, entry.id)).map((entry) => entry.label);
  } catch (err) {
    console.error('[spotlight] detectActiveDecorationConflicts failed — treating as none detected', err);
    return [];
  }
}

/** Fires at most once per load; no-ops when nothing detected. */
function reportDecorationConflicts(plugin) {
  if (plugin.decorationNoticeShown) return;
  const active = detectActiveDecorationConflicts(plugin.app);
  if (active.length === 0) return;
  plugin.decorationNoticeShown = true;
  new Notice(
    `Spotlight: ${active.join(', ')} won't render a new icon on a row Spotlight has already starred, even after ` +
      "unstarring — set icons first, or disable one of the two while assigning them.",
  );
}

/**
 * `scheduleStarReapply`'s burst-budget/minimum-interval constants -- see that
 * method's own doc comment for the reasoning. `REAPPLY_BURST_BUDGET` is
 * deliberately sized to the 2-3 passes a single native expand/collapse
 * cycle already costs, so ordinary
 * interactive use never gets throttled; only a budget-exhausting,
 * sustained burst (externally-triggered churn) waits out
 * `REAPPLY_MIN_INTERVAL_MS` between passes.
 */
const REAPPLY_BURST_BUDGET = 3;
const REAPPLY_BURST_WINDOW_MS = 1000;
const REAPPLY_MIN_INTERVAL_MS = 250;

/* ========================================================================
 * The plugin
 * ==================================================================== */

class SpotlightPlugin extends Plugin {
  async onload() {
    // 0.14.0: "first start" is EXACTLY `loadData()`
    // returning null/undefined -- never "roots is empty" or "migrated is
    // false" (an already-current, genuinely-empty shape read back from a
    // real, previously-saved data.json is NOT a first start, and must
    // never re-trigger ICOR detection or reseed over a member's own
    // deliberate empty state). `_firstStartPending` stays true until this
    // session's own first real save (`saveSettings()`, a user action) or
    // until real data arrives externally (`onExternalSettingsChange()`),
    // whichever comes first -- see both their own doc comments.
    const rawLoaded = await this.loadData();
    this._firstStartPending = rawLoaded === null || rawLoaded === undefined;
    const { settings, migrated } = migrateSettings(rawLoaded);
    this.settings = settings;
    if (migrated) await this.saveSettings();

    this.settingTab = new SpotlightSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => addSpotlightMenuItem(this, menu, file)));

    // Registered ONCE, here, for the plugin's whole lifetime — moved out
    // of installFileExplorerIntegration()'s own installRowInjection() step
    //: that step can now run
    // more than once per session (ensureExplorerViewConnected(), below,
    // re-acquires the view after the File explorer tab is closed/reopened
    // or a workspace loads), and these listeners don't depend on which
    // view instance is currently live — re-registering them on every
    // re-acquisition would accumulate duplicate handlers, each firing an
    // extra (harmless but wasteful) reapply per vault event.
    this.registerRowInjectionEvents();

    // F3: a 'layout-change' fires when the File explorer tab (or any
    // leaf) closes/reopens, or a saved workspace loads — any of which can
    // leave `this.explorerView` pointing at a view whose `containerEl` is
    // no longer attached to the document, with this plugin's own
    // MutationObserver now watching a dead node and every surface (star,
    // shelf) silently frozen for the rest of the session.
    this.registerEvent(this.app.workspace.on('layout-change', () => this.ensureExplorerViewConnected()));

    // F6: acquired only once layout has actually finished restoring —
    // `installFileExplorerIntegration()` calls `loadIfDeferred()` on
    // whatever file-explorer leaf it finds, which force-loads a leaf
    // Obsidian would otherwise have left deferred at cold start. Calling
    // this eagerly from onload()'s own synchronous body defeated that
    // deferral on every launch; `onLayoutReady()` fires immediately if
    // layout is already settled (a plugin enabled mid-session), or queues
    // for when it is (cold start) — never both, and never before.
    // `this.explorerReady` is the one promise every caller (including
    // tests) can await to know the initial acquisition attempt has
    // actually finished, success or failure — onload() itself does NOT
    // await it, matching "acquire only inside onLayoutReady," not
    // "block onload on it."
    this.app.workspace.onLayoutReady(() => {
      if (this._unloaded) return;
      // 0.14.0: ICOR detection + seeding run HERE,
      // inside `onLayoutReady` (the vault's own folder index is
      // trustworthy by this point, unlike at `onload()`'s own
      // synchronous start) -- and ONLY on a genuine first start, never
      // re-run on a later `layout-change`-triggered re-acquisition, and
      // never for a session that loaded REAL settings, even genuinely
      // empty ones (`_firstStartPending` is the one flag that tells the
      // two apart). Chained BEFORE `installFileExplorerIntegration()`
      // (never a separate, later-assigned promise -- `this.explorerReady`
      // must be set SYNCHRONOUSLY, in this same tick, exactly like every
      // release before 0.14.0: it is the one promise every caller,
      // including every test, awaits to know the whole acquisition
      // attempt has finished; assigning it one microtask late here would
      // silently break `await plugin.explorerReady` everywhere), so the
      // very first shelf render already reflects any seeded roots
      // instead of painting empty once and again a tick later.
      const seed = this._firstStartPending ? this.runFirstStartIcorDetection() : Promise.resolve();
      this.explorerReady = seed
        .catch((err) => {
          console.error('[spotlight] first-start ICOR detection failed — staying empty, the guide still shows', err);
        })
        .then(() => {
          if (this._unloaded) return false;
          return this.installFileExplorerIntegration().catch((err) => {
            console.error('[spotlight] file-explorer integration failed to install — inline star / shelf inactive this session', err);
            return false;
          });
        });
    });
  }

  /** 0.14.0, conditions 1+2 together, run once, only on a
   * genuine first start (see `onload()`'s own doc comment). Detects
   * whether this vault is an ICOR for Life scaffold at all
   * (`detectIcorScaffold`), and if so, seeds `this.settings.roots` with
   * whichever of the five My Life areas actually exist here
   * (`computeIcorSeededRoots`) — IN MEMORY ONLY, never a `saveSettings()`
   * call: condition 3's own "never saveData on first start until a user
   * action" means a member who never touches this vault again this
   * session must never see a data.json appear from nothing. Never
   * throws past its own caller (`onload()`'s own `.catch`) — any failure
   * here degrades to "stay empty," the guide showing, exactly like a
   * genuine non-ICOR vault would; this method itself never needs its own
   * try/catch because `detectIcorScaffold` already never throws and
   * `computeIcorSeededRoots` is a synchronous, non-throwing vault read. */
  async runFirstStartIcorDetection() {
    const isIcor = await detectIcorScaffold(this.app);
    if (!isIcor) return; // stays empty -- the guide shows
    const seeded = computeIcorSeededRoots(this.app);
    if (seeded.length === 0) return; // ICOR, but none of the five areas exist here yet either -- stays empty
    // 0.15.1:
    // re-checked HERE, after the one real await above, not just at the
    // top of the method -- `detectIcorScaffold`'s own file read is
    // exactly the window in which either could have changed:
    // `_unloaded` if the plugin was disabled mid-detection, or
    // `_firstStartPending` if real settings already landed via
    // `reloadSettingsFromDisk()`/`onExternalSettingsChange()` (a synced
    // data.json arriving) or `saveSettings()`'s own first-save race
    // guard, EACH of which already swapped `this.settings` for a fresh
    // object. Without this check, this line would clobber that fresh,
    // REAL object's `roots` with stale in-memory seeded data -- the same
    // "existing data.json always wins" bug class 0.14.0 was built to
    // prevent everywhere else, just reachable here through a narrower
    // door.
    if (!this._firstStartPending || this._unloaded) return;
    this.settings.roots = seeded;
  }

  /** Vault/metadataCache listeners this build's whole reapply cycle
   * depends on — registered exactly once per plugin lifetime (see
   * onload()'s own doc comment for why this is no longer inside
   * installRowInjection()). None of these touch `this.explorerView`
   * directly; `requestExplorerSort()`/`scheduleStarReapply()` already
   * no-op safely when there is none.
   *
   * 0.7.0, `rename`/`delete` now read their
   * own arguments (`file`, and `rename`'s own `oldPath`), previously
   * discarded (`() => {...}`), to keep `settings.starredPaths` (folder
   * star storage, above) in step with the vault: a starred folder that
   * moves keeps its star under the new path; a starred folder that's
   * deleted stops carrying dead state forever. Whether Obsidian's own
   * `rename` event fires once for a renamed FOLDER or once per
   * descendant is not settled from source alone (main.js's own asar read
   * found a single trigger site keyed on one path at a time; whether the
   * adapter fans that out per descendant for a directory move wasn't
   * confirmed either way). `renameFolderStarredPaths`'s own prefix
   * rewrite is idempotent either way (see its doc comment), so this
   * doesn't need to know which.
   *
   * 0.13.6: `applyRootFollowsRename`/
   * `removeRootAwareState` run alongside the star-path rewrite/drop
   * above -- a configured root (or an ANCESTOR of one) that moves keeps
   * its settings (path, hidden/collapsed state) attached; one that's
   * deleted (or loses an ancestor) drops cleanly, no stuck state. See
   * their own doc comments for the full account, including the
   * collision-refusal rule. */
  registerRowInjectionEvents() {
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file && typeof file.path === 'string' && typeof oldPath === 'string') {
          renameFolderStarredPaths(this, oldPath, file.path).catch((err) => console.error('[spotlight] renameFolderStarredPaths failed', err));
          applyRootFollowsRename(this, oldPath, file.path).catch((err) => console.error('[spotlight] applyRootFollowsRename failed', err));
        }
        this.requestExplorerSort();
        this.scheduleStarReapply();
      }),
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file && typeof file.path === 'string') {
          deleteFolderStarredPaths(this, file.path).catch((err) => console.error('[spotlight] deleteFolderStarredPaths failed', err));
          removeRootAwareState(this, file.path).catch((err) => console.error('[spotlight] removeRootAwareState failed', err));
        }
        this.requestExplorerSort();
        this.scheduleStarReapply();
      }),
    );
    this.registerEvent(
      this.app.vault.on('create', () => {
        this.requestExplorerSort();
        this.scheduleStarReapply();
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        const classification = resolveSpotlightTarget(this, file);
        if (!classification) return;
        const path = candidatePath(classification);
        // 0.13.3 (p7m): `reapplyStars`'s own star-state cache skips a
        // path whose LAST-KNOWN state still matches -- deleting this
        // ONE path's own entry (never a blanket clear; every other
        // path's own cache stays intact) guarantees the very re-render
        // this event is announcing always repaints, even if some
        // OTHER reapply pass had already re-observed and re-cached this
        // path's state from a stale metadata read in between.
        if (this._starStateCache) this._starStateCache.delete(path);
        // 0.13.4: THIS event is
        // Obsidian's own confirmation that its metadata cache has
        // actually caught up for this file -- the one, correct place a
        // frontmatter-backed candidate's optimistic override gets
        // reconciled. See `reconcileStarOverride`'s own doc comment.
        reconcileStarOverride(this, path, classification);
        this.requestExplorerSort();
        this.scheduleStarReapply();
      }),
    );
  }

  /** F3: re-acquires the
   * file-explorer view whenever the currently-held one is missing or its
   * `containerEl` is no longer attached to the document — closing and
   * reopening the File explorer tab, or loading a workspace, both leave
   * the OLD view (and this plugin's observer on its OLD, now-detached
   * container) behind silently otherwise. Tears down the stale view's own
   * observer first, then re-runs full acquisition. */
  ensureExplorerViewConnected() {
    if (this._unloaded) return;
    const connected = this.explorerView && this.explorerView.containerEl && this.explorerView.containerEl.isConnected;
    if (connected) return;
    if (this.explorerView) {
      if (this.starObserver) {
        this.starObserver.disconnect();
        this.starObserver = null;
      }
    }
    this.explorerView = null;
    this.explorerReady = this.installFileExplorerIntegration().catch((err) => {
      console.error('[spotlight] re-acquiring the file-explorer view failed', err);
      return false;
    });
  }

  onunload() {
    this._unloaded = true;

    if (this._reapplyBackstopId) {
      clearTimeout(this._reapplyBackstopId);
      this._reapplyBackstopId = null;
    }
    this._reapplyScheduled = false;

    // 0.13.6: the reveal guard's
    // own pending 'file-open' listener and its backstop timeout, torn
    // down the same way every other tracked listener/timer in this
    // function already is -- a click on a branch-hidden shelf row right
    // before this plugin unloads must never leave either one live past
    // that point.
    if (this._revealGuardRef && this.app && this.app.workspace && typeof this.app.workspace.offref === 'function') {
      this.app.workspace.offref(this._revealGuardRef);
    }
    this._revealGuardRef = null;
    if (this._revealGuardTimeoutId) {
      clearTimeout(this._revealGuardTimeoutId);
      this._revealGuardTimeoutId = null;
    }

    if (this.explorerView && this.explorerView.fileItems) {
      for (const path of this._paintedStarPaths || []) {
        const item = this.explorerView.fileItems[path];
        if (item) removeStarFromRow(item.selfEl);
      }
    }
    // a blanket sweep of
    // every `.spotlight-star` actually in the explorer's DOM, not only
    // the paths `_paintedStarPaths` remembers painting -- symmetric with
    // the shelf's own blanket sweep just below. `_paintedStarPaths` is a
    // live cache, not the source of truth for what's on screen; a star
    // this cache never observed (or has since forgotten) would otherwise
    // survive unload with a live, now-unguarded click target, now that
    // `setFolderStarred` writes `data.json` and not just one note.
    if (this.explorerView && this.explorerView.containerEl && typeof this.explorerView.containerEl.querySelectorAll === 'function') {
      for (const star of this.explorerView.containerEl.querySelectorAll('.spotlight-star')) {
        star.remove();
      }
    }
    // F2: a blanket sweep of every
    // `.spotlight-shelf` in the explorer, not just one per currently-
    // configured root — a shelf a prior `removeRoot`/`setRootPath` call
    // already orphaned (no longer reachable by path through
    // `this.settings.roots`) would otherwise survive unload with live
    // listeners still attached, `unstarShelfEntity`'s own
    // `plugin._unloaded` guard notwithstanding (belt and suspenders, not
    // a reason to skip actually removing the DOM).
    // 0.15.1:
    // tracks which owning rows the two sweeps just below already
    // invalidated, so a root whose shelf AND toggle are both swept in
    // the same unload (the ordinary case -- they're built and removed as
    // a pair) still invalidates exactly once, matching
    // `removeShelfForRoot`'s own single, OR-gated
    // `if (existing || toggle) invalidateItemHeight(...)` call, the same
    // discipline `sweepOrphanShelves` now also follows.
    const unloadInvalidatedOwners = new Set();
    if (this.explorerView && this.explorerView.containerEl && typeof this.explorerView.containerEl.querySelectorAll === 'function') {
      for (const shelf of this.explorerView.containerEl.querySelectorAll('.spotlight-shelf')) {
        // Capture the owning row BEFORE `.remove()` -- a removed node's
        // own `.parentNode` goes `null`, the same reason
        // `sweepOrphanShelves` already captures `owner` first. This
        // blanket sweep shrinks the owning row back to a bare row, the
        // exact height-changing mutation `invalidateItemHeight`'s own doc
        // comment describes (`removeShelfForRoot`'s single-root remove
        // already accounts for it) -- unload never told `infinityScroll`
        // about it before this fix, so disabling the plugin with several
        // shelves open could leave the SAME stale-row-height flash/gap
        // waiting for the next scroll, even with
        // the plugin off.
        const owner = shelf.parentNode;
        shelf.remove();
        const ownerItem = findItemByEl(this.explorerView, owner);
        if (ownerItem && !unloadInvalidatedOwners.has(ownerItem)) {
          invalidateItemHeight(this, ownerItem);
          unloadInvalidatedOwners.add(ownerItem);
        }
      }
    }
    // 0.13.6: un-hide through the
    // REAL invalidate path first, for every root this plugin actually
    // knows is hidden -- `applyBranchHiddenDomState` calls
    // `infinityScroll.invalidate(item, true)`/`invalidate(item)` around
    // the class flip, exactly like every OTHER un-hide site in this file
    // already does, so the virtualised list's cached row heights are
    // told about the reveal instead of going stale the way a bare
    // `classList.remove()` below leaves them. Must run BEFORE the
    // blanket strip just below -- `applyBranchHiddenDomState` is
    // idempotent (a no-op, no `invalidate()` call, once the class is
    // already gone), so if the blanket strip ran first this loop would
    // find nothing left to do and the whole fix would be a no-op.
    if (this.explorerView && this.explorerView.fileItems) {
      for (const path of this.settings.collapsedBranchRoots || []) {
        const item = this.explorerView.fileItems[path];
        if (item) applyBranchHiddenDomState(this, item, false);
      }
    }
    // The branch toggle is a SIBLING of the shelf, so the
    // blanket sweep above never reaches it -- swept here the same way,
    // symmetric with the shelf's own. Also strips `spotlight-branch-hidden`
    // off of every row that carries it: that class is the ONLY thing
    // keeping real files invisible, and this plugin unloading must never
    // leave a member's file explorer permanently missing rows. Backstop
    // ONLY as of 0.13.6 -- the loop just above already un-hides every
    // root this plugin's OWN settings know about, through the real
    // invalidate path; this blanket strip stays to catch anything that
    // loop can't reach (a stale class left by a build predating
    // `collapsedBranchRoots`, or a row this plugin lost track of) --
    // belt and suspenders, never the only mechanism.
    if (this.explorerView && this.explorerView.containerEl && typeof this.explorerView.containerEl.querySelectorAll === 'function') {
      for (const toggle of this.explorerView.containerEl.querySelectorAll('.spotlight-branch-toggle')) {
        // Same fix as the shelf sweep just above, same reason -- the
        // band is its own row-height contributor (it renders
        // as the shelf's own sibling), so removing it unconditionally is
        // exactly the kind of mutation `invalidateItemHeight` exists for.
        // Skipped when the shelf sweep above already invalidated this
        // SAME owner (see `unloadInvalidatedOwners`'s own doc comment).
        const owner = toggle.parentNode;
        toggle.remove();
        const ownerItem = findItemByEl(this.explorerView, owner);
        if (ownerItem && !unloadInvalidatedOwners.has(ownerItem)) {
          invalidateItemHeight(this, ownerItem);
          unloadInvalidatedOwners.add(ownerItem);
        }
      }
      for (const hidden of this.explorerView.containerEl.querySelectorAll('.spotlight-branch-hidden')) {
        hidden.classList.remove('spotlight-branch-hidden');
      }
    }
    this._shelfSignatures = new Map();
    this._shelfHadStars = new Map();
    this._branchCollapsedSeen = new Map();
    this._paintedStarPaths = new Set();
    this._starStateCache = new Map();
    this._optimisticStarOverrides = new Map();
    this._starWritesInFlight = new Map();

    if (this.starObserver) {
      this.starObserver.disconnect();
      this.starObserver = null;
    }
    this.explorerView = null;
  }

  /** 0.14.0, condition 3's second half: the FIRST real save this
   * session (`_firstStartPending` still true — see `onload()`'s own doc
   * comment for exactly what that flag means) re-checks whether
   * data.json has appeared on disk since this session's own load, since
   * another device/process could have synced one down in the meantime.
   * If it has, existing data.json always wins (this file's own standing
   * rule, independent of 0.14.0): this specific write is abandoned and
   * the session reloads from what is genuinely on disk instead of
   * clobbering it with whatever this session computed in memory (ICOR
   * detection's own seeded roots, or a member's very first click in an
   * empty vault, whichever prompted this call). `this.manifest.dir` is a
   * real, documented Obsidian `PluginManifest` field (the plugin's own
   * folder under `.obsidian/plugins/`) — guarded for a shape that omits
   * it (an older test fixture, some future host), in which case this
   * re-check simply cannot run and the write proceeds exactly like every
   * pre-0.14.0 release always did. */
  async saveSettings() {
    if (this._firstStartPending) {
      const dir = this.manifest && this.manifest.dir;
      const adapter = this.app && this.app.vault && this.app.vault.adapter;
      if (typeof dir === 'string' && adapter && typeof adapter.exists === 'function') {
        let appeared = false;
        try {
          appeared = await adapter.exists(normalizePath(`${dir}/data.json`));
        } catch (err) {
          appeared = false;
        }
        if (appeared) {
          await this.reloadSettingsFromDisk();
          return;
        }
      }
      this._firstStartPending = false;
    }
    await this.saveData(this.settings);
  }

  /** 0.14.0 — shared by `saveSettings()`'s own first-save race
   * guard and `onExternalSettingsChange()` (condition 4): both mean the
   * same thing in substance, real data now exists on disk and it always
   * wins over whatever this session was carrying in memory. Drops
   * `_firstStartPending` (there is nothing left to detect or seed once
   * real data has answered the question), and refreshes the explorer so
   * the new settings actually paint — `runReapply()` already no-ops
   * safely if the file-explorer integration hasn't finished installing
   * yet. Also refreshes the settings tab itself, if it exists, so an
   * open tab showing the empty-state guide (or five stale seeded roots
   * this session guessed at) updates to match, rather than waiting for a
   * member to close and reopen it — this is the "close the guide" half
   * of condition 4; the guide's own visibility is computed straight from
   * `settings.roots`/`settings.guideDismissed`, never a separate flag
   * this method has to remember to clear. A shape that forward-migrates
   * on this read (a genuinely old shape arriving from an older device)
   * is persisted forward immediately, mirroring `onload()`'s own
   * identical migrated-on-load handling. */
  async reloadSettingsFromDisk() {
    const { settings, migrated } = migrateSettings(await this.loadData());
    this.settings = settings;
    this._firstStartPending = false;
    // 0.15.1:
    // cleared here too, not only on unload/view-reacquisition -- the
    // signature cache is what lets `renderShelfForRoot` skip touching a
    // shelf's DOM entirely when the starred-path list hasn't changed
    // (F4), but `collapsedShelfRoots` (the shelf's own `is-collapsed`
    // class) is deliberately NOT part of that signature (see its own
    // doc comment) and is only ever re-applied when a shelf actually
    // rebuilds. Real settings landing externally can change
    // `collapsedShelfRoots` with the starred set itself untouched, which
    // this cache would otherwise read as "unchanged" and skip forever --
    // clearing it forces the next reapply pass to touch every shelf at
    // least once, so an external collapse/expand genuinely re-applies.
    this._shelfSignatures = new Map();
    this.runReapply();
    // 0.15.1:
    // never rebuild a settings tab that isn't actually on screen --
    // `this.settingTab` (set once in `onload()`) keeps existing after a
    // member closes the pane; its `containerEl.isConnected` goes false
    // the moment it leaves the document. Tearing down and rebuilding a
    // pane nobody is looking at is wasted work at best, and blows away
    // whatever a member is doing in it (an uncommitted keystroke in the
    // path field, focus, scroll position) the instant they reopen it, if
    // this reload happened to land while it was open and got rebuilt
    // out from under them mid-edit. A genuinely connected (open) tab
    // still rebuilds exactly as before -- this is a pure guard, not a
    // new debounce; Obsidian calls `display()` itself the next time a
    // closed tab actually reopens.
    if (this.settingTab && typeof this.settingTab.display === 'function' && this.settingTab.containerEl && this.settingTab.containerEl.isConnected) {
      this.settingTab.display();
    }
    if (migrated) await this.saveSettings();
  }

  /** 0.14.0, condition 4 — Obsidian's own documented `Plugin`
   * lifecycle hook: fires when `data.json` changes on disk from OUTSIDE
   * this session (Sync, another device, a hand-edit), never for this
   * session's own `saveData()` calls. Reloads and reconciles exactly
   * like `reloadSettingsFromDisk()` already does for the first-save
   * race, since both are the same event in substance. */
  async onExternalSettingsChange() {
    await this.reloadSettingsFromDisk();
  }

  checkRootExists(path) {
    return !!this.app.vault.getFolderByPath(path);
  }

  getRootFolder(path) {
    return this.app.vault.getFolderByPath(path);
  }

  /**
   * Pure collision check, no mutation. Blanket ancestor/descendant/
   * duplicate refusal — checked against every
   * configured root regardless of `enabled`.
   * @param {string} path - the candidate path (not yet normalized).
   * @param {string|null} excludePath - the root's OWN current path, for
   *   an edit — excluded so re-saving a root's own unchanged path is
   *   never a false self-collision. `null` for an add.
   * @returns {{ ok: true, normalized: string } | { ok: false, reason: string }}
   */
  checkRootCollision(path, excludePath) {
    const normalized = normalizeRootPath(path) || DEFAULT_ROOT_PATH;
    for (const r of this.settings.roots) {
      if (r.path === excludePath) continue;
      if (rootsCollide(r.path, normalized)) return { ok: false, reason: ROOT_COLLISION_MESSAGE };
    }
    return { ok: true, normalized };
  }

  /** Adds a new root, `enabled: true` by default — every discovered
   * candidate beneath it is live immediately, on the very next reapply
   * (no per-root discovery to persist any more, so there is nothing left
   * to delay this the way the old lane-reconcile cold-boot race could). */
  async addRoot(path) {
    const check = this.checkRootCollision(path, null);
    if (!check.ok) return check;
    this.settings.roots.push({ path: check.normalized, enabled: true, spotlightFolders: false });
    await this.saveSettings();
    this.requestExplorerSort();
    this.scheduleStarReapply();
    return { ok: true };
  }

  async removeRoot(path) {
    this.settings.roots = this.settings.roots.filter((r) => r.path !== path);
    if (this.settings.collapsedShelfRoots) {
      this.settings.collapsedShelfRoots = this.settings.collapsedShelfRoots.filter((p) => p !== path);
    }
    // 0.13.0: mirrors the `collapsedShelfRoots` cleanup immediately above,
    // exactly -- a removed root can never come back already branch-hidden
    // with no visible way to un-hide it (there is no row, and so no band,
    // for a root that no longer exists).
    if (this.settings.collapsedBranchRoots) {
      this.settings.collapsedBranchRoots = this.settings.collapsedBranchRoots.filter((p) => p !== path);
    }
    await this.saveSettings();
    this.requestExplorerSort();
    this.scheduleStarReapply();
  }

  async setRootPath(oldPath, newPath) {
    const check = this.checkRootCollision(newPath, oldPath);
    if (!check.ok) return check;
    const entry = this.settings.roots.find((r) => r.path === oldPath);
    if (!entry) return { ok: false, reason: 'root not found' };
    entry.path = check.normalized;
    await this.saveSettings();
    this.requestExplorerSort();
    this.scheduleStarReapply();
    return { ok: true };
  }

  async setRootEnabled(path, enabled) {
    const entry = this.settings.roots.find((r) => r.path === path);
    if (!entry) return;
    entry.enabled = !!enabled;
    await this.saveSettings();
    this.requestExplorerSort();
    this.scheduleStarReapply();
  }

  /** 0.7.0: flips one root's own
   * `spotlightFolders` toggle. `requestExplorerSort()` +
   * `scheduleStarReapply()`, same as every other root mutation above:
   * the toggle changes what `findEntityCandidates` finds under this root
   * (grouping folders become candidates or stop being ones), so both the
   * inline stars and the shelf need a full re-derive, not just a redraw. */
  async setRootSpotlightFolders(path, spotlightFolders) {
    const entry = this.settings.roots.find((r) => r.path === path);
    if (!entry) return;
    entry.spotlightFolders = !!spotlightFolders;
    await this.saveSettings();
    this.requestExplorerSort();
    this.scheduleStarReapply();
  }

  /** `{ found, starred }` for one root — the settings tab's own
   * read-only line. Zero/zero for a root that doesn't exist in this
   * vault, never a throw. 0.7.0: `found`/`starred` include folder
   * candidates when `spotlightFolders` is on for this root, read through
   * the same `getCandidateStarState` dispatcher every other consumer
   * uses, never a second, folder-only count. */
  computeRootCounts(rootEntry) {
    const rootFolder = this.getRootFolder(rootEntry.path);
    if (!rootFolder) return { found: 0, starred: 0 };
    const spotlightFolders = rootEntry.spotlightFolders === true;
    const candidates = findEntityCandidates(rootFolder, { spotlightFolders });
    const starred = candidates.filter((c) => getCandidateStarState(this, c)).length;
    return { found: candidates.length, starred };
  }

  async installFileExplorerIntegration() {
    if (this.explorerView) return true;
    const view = await getFileExplorerView(this.app);
    if (!view) {
      console.debug('[spotlight] no file-explorer leaf found — inline star and the shelf are inactive this session (settings and the context-menu route still work)');
      return false;
    }
    this.explorerView = view;
    this.installRowInjection();

    try {
      reportDecorationConflicts(this);
    } catch (err) {
      console.error('[spotlight] reportDecorationConflicts failed — non-fatal', err);
    }

    return true;
  }

  /** Per-VIEW setup only now (F3, 2026-09-15) — the vault/metadataCache
   * listeners this used to also register live in `registerRowInjectionEvents()`
   * instead, called once from `onload()`, since this method can now run
   * again for a freshly re-acquired view within the same session. */
  installRowInjection() {
    this._paintedStarPaths = new Set();
    // 0.13.3: a freshly (re-)acquired view's rows carry no memory of what
    // star state this plugin last painted onto the OLD (now-discarded)
    // row objects -- never trust it across a view swap, same discipline
    // as `_paintedStarPaths` right above.
    this._starStateCache = new Map();
    // No optimistic override should ever legitimately outlive a view swap
    // either -- a click that was mid-flight against the OLD view has
    // nothing left to reconcile against.
    this._optimisticStarOverrides = new Map();
    // 0.13.4: same reasoning -- a write mid-flight against the OLD view
    // has nothing left to reconcile against either.
    this._starWritesInFlight = new Map();
    this._shelfSignatures = new Map(); // a freshly (re-)acquired view has no shelf DOM yet -- never trust a cached signature across a view swap
    // Same "no DOM yet, never trust a cache across a view
    // swap" discipline for the has-this-root-ever-had-stars-this-session
    // tracker (the one `starred.length === 0` uses to tell a real un-star
    // apart from a cold-boot pass that just hasn't resolved metadata yet).
    this._shelfHadStars = new Map();
    // 0.13.2: same reason -- a freshly (re-)acquired view's `item.collapsed`
    // has no relationship to whatever this plugin last observed on the OLD
    // view's own (now-discarded) row objects.
    this._branchCollapsedSeen = new Map();

    if (typeof MutationObserver !== 'undefined' && this.explorerView.containerEl) {
      // 0.13.5:
      // filter out this plugin's OWN childList writes -- see
      // `isSelfCausedMutation`'s own doc comment -- before ever calling
      // `scheduleStarReapply()`, so a self-caused mutation never queues a
      // pass at all (as opposed to queuing one that then turns out to be
      // a no-op, which still costs a pass).
      this.starObserver = new MutationObserver((records) => {
        if (isSelfCausedMutation(records)) return;
        this.scheduleStarReapply();
      });
      this.starObserver.observe(this.explorerView.containerEl, { childList: true, subtree: true });
    }

    this.runReapply();
  }

  /** rAF-coalesced, with a `setTimeout` backstop: `requestAnimationFrame`
   * does not fire while the window is unfocused/hidden (confirmed live,
   * 2026-09-08) — exactly the span a root/lane edit through the Settings
   * popout runs under. `setTimeout` is throttled but not suspended while
   * hidden, so it's a real, if possibly delayed, guarantee. Whichever
   * fires first runs the pass and cancels the other.
   *
   * BURST BUDGET + MINIMUM INTERVAL: a hide click fired while Obsidian Sync
   * was actively writing triggered ~12 reapply passes/second and 50-55ms
   * long tasks, since the plugin's own MutationObserver reacts to any
   * childList mutation in the explorer, with no guard against
   * external mutation. Coalescing WITHIN one rAF frame (the guard
   * above) was never the gap -- back-to-back FRAMES, each with its own
   * fresh mutation to react to, were: nothing capped how often a NEW
   * episode could start right after the previous one just finished. Not
   * a pure trailing debounce either -- a burst this size can run 14
   * real seconds, and a plain debounce would leave every row Obsidian
   * re-renders unpainted for the whole span. Instead: the first
   * `REAPPLY_BURST_BUDGET` passes within any trailing
   * `REAPPLY_BURST_WINDOW_MS` window still arm at full rAF speed, no
   * throttle at all -- this is deliberately sized to the 2-3 passes a
   * single native expand/collapse cycle already costs, so that ordinary interactive use is never slowed
   * down. Only once the budget for the current window is spent does a
   * NEW episode get deferred, to `lastPassAt + REAPPLY_MIN_INTERVAL_MS`
   * -- a real, if delayed, pass is still guaranteed (never silently
   * dropped), just spaced out under sustained churn.
   *
   * `this._reapplyPassLog` (a plain array of `Date.now()` timestamps,
   * pushed to by `runReapply()` itself, not here) is what the budget
   * check reads -- every pass counts toward it, including a DIRECT
   * `plugin.runReapply()` call that never goes through this method at
   * all (the star-click optimistic-paint path, `handleStarActivate`).
   * That direct path is itself never
   * throttled -- it bypasses this method entirely, so the immediate
   * same-task star paint is untouched by any of this -- but its own
   * passes still count as load against the NEXT scheduled pass's budget,
   * which is correct: a click landing mid-burst should not reset the
   * clock on churn that was already happening. */
  scheduleStarReapply() {
    if (this._reapplyScheduled) return;
    this._reapplyScheduled = true;
    const run = () => {
      if (!this._reapplyScheduled) return;
      clearTimeout(this._reapplyBackstopId);
      this._reapplyBackstopId = null;
      this._reapplyScheduled = false;
      this.runReapply();
    };
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 0);
    // Tracked on the instance
    // so `onunload()` can cancel it outright — an untracked timer fired
    // by a pending reapply could otherwise still run after unload,
    // calling into `runReapply()` on a torn-down instance (harmless in
    // practice, since that guards on `this.explorerView`, but a dangling
    // timer holding this instance's closure alive past unload is
    // needless). Reused for BOTH the immediate-arm backstop and the
    // burst-budget deferral timer below -- only one is ever live at a
    // time for a given episode, and either way `onunload()`'s single
    // `clearTimeout(this._reapplyBackstopId)` covers it.
    const arm = () => {
      raf(run);
      this._reapplyBackstopId = setTimeout(run, 250);
    };
    this._reapplyPassLog = this._reapplyPassLog || [];
    const now = Date.now();
    const recentPassCount = this._reapplyPassLog.filter((t) => t >= now - REAPPLY_BURST_WINDOW_MS).length;
    if (recentPassCount < REAPPLY_BURST_BUDGET) {
      arm();
    } else {
      const lastPassAt = this._reapplyPassLog[this._reapplyPassLog.length - 1] || 0;
      this._reapplyBackstopId = setTimeout(arm, Math.max(0, lastPassAt + REAPPLY_MIN_INTERVAL_MS - now));
    }
  }

  /** Persists which roots' own shelves are collapsed --
   * read by `renderShelfForRoot` on every (re)build so a
   * member's collapse survives the next reapply, which fires on nearly
   * any vault activity. */
  async setShelfCollapsed(rootPath, collapsed) {
    const set = new Set(this.settings.collapsedShelfRoots || []);
    if (collapsed) set.add(rootPath);
    else set.delete(rootPath);
    this.settings.collapsedShelfRoots = [...set];
    await this.saveSettings();
  }

  /** Persists which roots' own BRANCHES (everything below the shelf)
   * a member has tucked away -- mirrors `setShelfCollapsed` above
   * exactly, same shape, same "read by the render pass on every (re)build"
   * discipline. The DOM class + `infinityScroll.invalidate()` pair this
   * state drives is applied by the caller (`applyBranchHiddenDomState`,
   * below) BEFORE this resolves, never after -- a member must see the files
   * tuck away or come back instantly, not wait on a settings write. */
  async setBranchHidden(rootPath, hidden) {
    const set = new Set(this.settings.collapsedBranchRoots || []);
    if (hidden) set.add(rootPath);
    else set.delete(rootPath);
    this.settings.collapsedBranchRoots = [...set];
    await this.saveSettings();
  }

  /** Disconnects the observer around its own writes (so it never
   * re-triggers itself), then reconnects regardless of outcome. Runs the
   * star pass and the shelf rebuild — the two surfaces this build's whole
   * reapply cycle now drives (the Overview-marker pass is RETIRED 0.5.0).
   * 0.13.0: `reapplyBranchHiddenState` runs FIRST, not after —
   * `renderAllShelves`'s own `removeShelfForRoot` call (inside it) must be
   * the LAST word on a disabled/non-owner root's own item.el for this pass,
   * since that is what keeps a branch-hidden setting on a root nobody can
   * currently reach a band for from silently hiding real files (see
   * `reapplyBranchHiddenState`'s own doc comment). */
  runReapply() {
    if (!this.explorerView) return;
    // 0.13.5: logs EVERY pass, however triggered -- see
    // `scheduleStarReapply`'s own doc comment for why a direct call (the
    // star-click optimistic path) has to count here too. Trimmed
    // opportunistically so this never grows unbounded across a long
    // session; only the last few passes are ever read (the trailing
    // `REAPPLY_BURST_WINDOW_MS` window), so keeping more than that costs
    // memory for nothing.
    this._reapplyPassLog = this._reapplyPassLog || [];
    this._reapplyPassLog.push(Date.now());
    const keepFrom = this._reapplyPassLog.length - (REAPPLY_BURST_BUDGET + 8);
    if (keepFrom > 0) this._reapplyPassLog.splice(0, keepFrom);
    const apply = () => {
      reapplyStars(this);
      reapplyBranchHiddenState(this);
      renderAllShelves(this);
    };
    if (!this.starObserver) {
      apply();
      return;
    }
    try {
      this.starObserver.disconnect();
      apply();
    } finally {
      this.starObserver.observe(this.explorerView.containerEl, { childList: true, subtree: true });
    }
  }

  requestExplorerSort() {
    if (this.explorerView && typeof this.explorerView.requestSort === 'function') {
      this.explorerView.requestSort();
    }
  }
}

/**
 * "auto-reveal active file" is per FILE-EXPLORER-LEAF view state
 * (`autoReveal`), never app-wide -- a vault can have more than one file
 * explorer pane open, each independently toggled via the Files panel's own
 * button. Read through the documented `WorkspaceLeaf.getViewState()`
 * public API, never `view.autoRevealFile` (Obsidian's OWN internal field
 * name for it, confirmed to exist but not the sanctioned read path here).
 * Pure -- never mutates, so the settings tab can call this on every
 * `display()`/re-render without side effects.
 * @returns {{ leaves: object[], onLeaves: object[], anyOn: boolean }}
 */
function computeAutoRevealState(app) {
  const leaves = app && app.workspace && typeof app.workspace.getLeavesOfType === 'function' ? app.workspace.getLeavesOfType('file-explorer') : [];
  const onLeaves = leaves.filter((leaf) => {
    const vs = leaf && typeof leaf.getViewState === 'function' ? leaf.getViewState() : null;
    return !!(vs && vs.state && vs.state.autoReveal === true);
  });
  return { leaves, onLeaves, anyOn: onLeaves.length > 0 };
}

/**
 * Turns auto-reveal OFF for every file-explorer leaf that currently has it
 * on -- `leaf.setViewState({ ...vs, state: {
 * ...vs.state, autoReveal: false } })`, awaited per leaf (works on a
 * deferred leaf too, per minAppVersion 1.7.2), then
 * `app.workspace.requestSaveLayout()` once, after every leaf has settled.
 * ONLY ever called from the settings tab's own "Turn off" button click --
 * never automatically, never on load, never a background pass. There is no
 * symmetric "turn on" here by design: a member
 * turns it back on from the Files panel's own button, this plugin only
 * ever offers the one-way "off."
 * @returns {Promise<number>} how many leaves were actually turned off.
 */
async function turnOffAutoReveal(app) {
  const { onLeaves } = computeAutoRevealState(app);
  for (const leaf of onLeaves) {
    if (typeof leaf.setViewState !== 'function' || typeof leaf.getViewState !== 'function') continue;
    const vs = leaf.getViewState();
    await leaf.setViewState({ ...vs, state: { ...(vs && vs.state), autoReveal: false } });
  }
  if (app && app.workspace && typeof app.workspace.requestSaveLayout === 'function') {
    app.workspace.requestSaveLayout();
  }
  return onLeaves.length;
}

/* ========================================================================
 * Settings tab — a plain root list, no lanes.
 * ==================================================================== */

class SpotlightSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** The settings redesign: four sections, in
   * this order (Add, Active Spotlight Directories, Clean up,
   * Auto-reveal), each its own `div.spotlight-settings-section[data-
   * section]` wrapper this plugin draws itself -- root cause of the OLD
   * layout (mockup §5.1): INKLINE draws a settings "card" by styling
   * each `.setting-item` in a flat plugin pane, but the count line and
   * the refusal notes were bare `<p>` elements between Setting rows,
   * never `.setting-item` themselves, so they got no ground and no side
   * lines. The
   * fix is structural: every element belonging to one directory now
   * lives inside ONE wrapper this plugin draws (`.spotlight-dir-card`,
   * see `renderRootsList()`'s own doc comment), so it reads as a real
   * card under any theme, including stock Obsidian, which draws no
   * cards at all.
   *
   * Each section keeps its own pre-existing rebuild rule (a fresh child
   * div per section, `.empty()` + `createDiv()`), never sharing one
   * container across sections -- unchanged discipline from 0.8.0/0.13.0,
   * just four sections deep now instead of three. */
  display() {
    const { containerEl } = this;
    containerEl.empty();
    // No plugin-name <h2> here — Obsidian already renders the plugin's own name as
    // the settings-tab heading; this one was a redundant second copy.
    containerEl.classList.add('spotlight-settings');

    this.addSectionEl = containerEl.createDiv({ cls: 'spotlight-settings-section', attr: { 'data-section': 'add' } });
    this.renderAddSection();

    this.directoriesSectionEl = containerEl.createDiv({ cls: 'spotlight-settings-section', attr: { 'data-section': 'directories' } });
    this.renderRootsList();

    // 0.8.0, the cleanup button lives in its
    // OWN section container -- never inside the directories section,
    // whose full rebuild (`renderRootsList()`) is unrelated to it and
    // must never touch it.
    this.cleanupSectionEl = containerEl.createDiv({ cls: 'spotlight-settings-section', attr: { 'data-section': 'cleanup' } });
    this.cleanupEl = this.cleanupSectionEl; // kept as an alias -- renderCleanupSection() below still reads `this.cleanupEl`
    this.renderCleanupSection();

    // Its own container too, same
    // "never touch it from an unrelated rebuild" discipline.
    this.autoRevealSectionEl = containerEl.createDiv({ cls: 'spotlight-settings-section', attr: { 'data-section': 'auto-reveal' } });
    this.autoRevealEl = this.autoRevealSectionEl; // kept as an alias, same reason
    this.renderAutoRevealSection();
    // Freshness: re-read on 'layout-change' too, since a
    // member can flip the Files panel's own auto-reveal button, or open a
    // second file-explorer pane, without ever touching this settings tab.
    // Registered ONCE, on the PLUGIN itself (so it's cleaned up
    // automatically on unload the same way every other `registerEvent`
    // call in this file already is), guarded so a member re-opening this
    // settings tab never accumulates a second listener.
    if (!this._autoRevealLayoutListenerRegistered && typeof this.plugin.registerEvent === 'function' && this.plugin.app.workspace && typeof this.plugin.app.workspace.on === 'function') {
      this._autoRevealLayoutListenerRegistered = true;
      // 0.15.1:
      // same `containerEl.isConnected` guard as `reloadSettingsFromDisk()`'s
      // own `display()` call, same reason -- this listener is registered
      // ONCE, on the plugin, for the settings tab's whole lifetime, so it
      // keeps firing on every future `layout-change` long after a member
      // has closed this pane. Rebuilding a section nobody can see is
      // wasted work at best.
      this.plugin.registerEvent(
        this.plugin.app.workspace.on('layout-change', () => {
          if (this.containerEl && this.containerEl.isConnected) this.renderAutoRevealSection();
        }),
      );
    }
  }

  /** The "Add Spotlight to this
   * directory:" section, including the colon in the heading. Unchanged
   * logic underneath (the debounced collision check, the Add button's
   * own refusal handling) — only the refusal note's own home moves, into
   * THIS row's own note element, never a second container. */
  renderAddSection() {
    const el = this.addSectionEl;
    el.empty();
    new Setting(el).setName('Add Spotlight to this directory').setHeading();

    let newRootValue = '';
    const addRowEl = el.createDiv();
    const addNoteEl = addRowEl.createDiv();
    new Setting(addRowEl)
      .setName('Folder path')
      .setDesc("Spotlight watches this folder, at any depth. It can't sit inside, or around, one already listed.")
      .addText((text) => {
        text.setPlaceholder('e.g. Projects/Client A');
        const applyCheck = debounce(
          (value) => {
            newRootValue = value;
            addNoteEl.empty();
            if (!value.trim()) return;
            const check = this.plugin.checkRootCollision(value, null);
            if (!check.ok) addNoteEl.createEl('p', { text: check.reason, cls: ['spotlight-settings-note', 'spotlight-settings-error'] });
          },
          400,
          true,
        );
        text.onChange((value) => {
          newRootValue = value;
          applyCheck(value);
        });
        // §5.7's own "Go to the Add field" button (the empty-state
        // guide, rendered by `renderRootsList()` below) reaches this
        // exact field through this reference.
        this.addRootTextComponent = text;
      })
      .addButton((btn) =>
        btn.setButtonText('Add').onClick(async () => {
          const result = await this.plugin.addRoot(newRootValue);
          addNoteEl.empty();
          if (!result.ok) {
            addNoteEl.createEl('p', { text: result.reason, cls: ['spotlight-settings-note', 'spotlight-settings-error'] });
            return;
          }
          this.renderRootsList();
        }),
      );
  }

  /** Rebuilds every directory card from scratch, inside
   * `.spotlight-dir-list` (mockup §5.2): the pill/state/toggle/trash
   * head, the full-width path field, the counts (or missing-path
   * warning), and the "Spotlight folders too" row -- OR, when
   * `settings.roots.length === 0`, the empty-state guide (§5.7),
   * regardless of which vault this is: first-run ICOR detection
   * (0.14.0) only ever decides what `roots` STARTS with; this section
   * reads the live count fresh on every render, never a separate "first
   * run" flag. 0.14.0's own minimal, functional-only guide (a paragraph
   * plus a Dismiss button) is retired here in favour of the mockup's
   * real one -- see `renderEmptyGuide()`'s own doc comment for the one
   * real behaviour change that comes with it (no Dismiss any more). */
  renderRootsList() {
    const el = this.directoriesSectionEl;
    el.empty();
    new Setting(el)
      .setName('Active Spotlight directories')
      .setDesc('Each folder below gets a SPOTLIGHT shelf at the top of its branch in the file explorer.')
      .setHeading();

    const settings = this.plugin.settings;
    // `this.rootsListEl` kept as the SAME alias every pre-0.15.0 test
    // already reaches (`tab.rootsListEl.children[N]` finding the Nth
    // card) -- it is `.spotlight-dir-list` specifically, not the whole
    // section, so index-0 is the first card (or the empty guide) exactly
    // as it was the first row before.
    const listEl = el.createDiv({ cls: 'spotlight-dir-list' });
    this.rootsListEl = listEl;

    if (settings.roots.length === 0) {
      this.renderEmptyGuide(listEl);
      return;
    }

    settings.roots.forEach((rootEntry, rootIndex) => {
      const cardCls = ['spotlight-dir-card'];
      if (rootEntry.enabled === false) cardCls.push('is-off');
      const exists = this.plugin.checkRootExists(rootEntry.path);
      if (!exists) cardCls.push('is-missing');
      const cardEl = listEl.createDiv({ cls: cardCls });

      const headEl = cardEl.createDiv({ cls: 'spotlight-dir-card-head' });
      const pillEl = headEl.createEl('span', { cls: 'spotlight-dir-pill', text: pillTextForRootPath(rootEntry.path) });
      const actionsEl = headEl.createDiv({ cls: 'spotlight-dir-card-actions' });
      const stateEl = actionsEl.createEl('span', { cls: 'spotlight-dir-state', text: rootEntry.enabled !== false ? 'Tracked' : 'Off' });
      new Setting(actionsEl)
        .addToggle((toggle) =>
          toggle
            .setValue(rootEntry.enabled !== false)
            .setTooltip('Track this root')
            .onChange(async (value) => {
              await this.plugin.setRootEnabled(rootEntry.path, value);
              cardEl.classList.toggle('is-off', !value);
              // `setText()`, not a bare `.text =` write --
              // that property has no setter on a real Obsidian element,
              // so the Tracked/Off label silently never updated live
              // (the toggle itself, and the count line just below, both
              // worked correctly the whole time -- only this label was
              // stuck at whatever it read on the last full render).
              stateEl.setText(value ? 'Tracked' : 'Off');
              this.renderCountsFor(rootEntry, countsEl);
            }),
        )
        .addExtraButton((btn) =>
          btn
            .setIcon('trash')
            .setTooltip('Remove this directory')
            .onClick(async () => {
              await this.plugin.removeRoot(rootEntry.path);
              this.renderRootsList();
            }),
        );

      const pathEl = cardEl.createDiv({ cls: 'spotlight-dir-path' });
      // 0.15.1 (counts BEFORE the
      // refusal note in DOM order now, matching mockup §5.2's own card
      // layout -- 0.15.0 built the note div first only because the
      // commit closure below needed something to close over before
      // `countsEl` existed yet; both are still plain `const` bindings
      // declared up here before that closure runs, so only the CREATION
      // order (and therefore the on-screen order) moves.
      const countsEl = cardEl.createDiv();
      const noteEl = cardEl.createDiv();
      // 0.15.1:
      // built from the root's own position in `settings.roots.forEach`,
      // never `pillEl.text` -- a real Obsidian span has no readable
      // `.text` property at all (only `<a>`/`<option>`/`<title>` do), so
      // this read back `undefined` live regardless of the write-side
      // `setText()` fix just above; `rootIndex` is already unique per
      // root, no need for `listEl.children.length` on top of it.
      const pathInputId = `spotlight-dir-path-input-${rootIndex}`;
      pathEl.createEl('label', { text: 'Folder', cls: 'spotlight-dir-path-label', attr: { for: pathInputId } });
      new Setting(pathEl).addText((text) => {
        text.setValue(rootEntry.path);
        if (text.inputEl) {
          text.inputEl.setAttribute('id', pathInputId);
          text.inputEl.classList.add('spotlight-dir-path-input');
          text.inputEl.title = rootEntry.path;
          // §5.6, items 3-4: the field always shows the path's END while
          // not focused (an overflowing path fades at the START, never
          // the end a member is most likely editing), and the caret
          // lands at the end on focus. `scrollLeft`/`scrollWidth` and
          // the overflow check itself are real-layout-only -- this
          // harness has no layout engine, so the WRITES are exercised
          // and testable, but the actual overflow CONDITION needs a
          // real browser to verify (styles.css's own `.is-overflowing` doc comment).
          const syncOverflow = () => {
            const overflowing = (text.inputEl.scrollWidth || 0) > (text.inputEl.clientWidth || 0);
            text.inputEl.classList.toggle('is-overflowing', overflowing);
            text.inputEl.scrollLeft = text.inputEl.scrollWidth || 0;
          };
          syncOverflow();
          text.inputEl.addEventListener('focus', () => {
            text.inputEl.classList.remove('is-overflowing');
            if (typeof text.inputEl.setSelectionRange === 'function') {
              const end = String(text.inputEl.value || '').length;
              text.inputEl.setSelectionRange(end, end);
            }
          });
          text.inputEl.addEventListener('blur', () => syncOverflow());
        }
        let pending = rootEntry.path;
        text.onChange((value) => {
          pending = value;
        });
        const commit = async () => {
          if (pending === rootEntry.path) return; // nothing actually changed
          const result = await this.plugin.setRootPath(rootEntry.path, pending);
          if (!result.ok) {
            noteEl.empty();
            noteEl.createEl('p', { text: result.reason, cls: ['spotlight-settings-note', 'spotlight-settings-error'] });
            text.setValue(rootEntry.path); // revert the field -- never leave a refused/partial path sitting there
            pending = rootEntry.path;
            return;
          }
          // rootEntry.path was mutated in place by setRootPath() (same
          // object reference this closure already holds) -- no need to
          // re-read it from settings.roots.
          noteEl.empty();
          // `setText()`, not a bare `.text =` write -- see
          // `stateEl.setText()`'s own comment above for the full account
          // of why the old write was a silent no-op live.
          pillEl.setText(pillTextForRootPath(rootEntry.path));
          if (text.inputEl) {
            text.inputEl.title = rootEntry.path;
            const overflowing = (text.inputEl.scrollWidth || 0) > (text.inputEl.clientWidth || 0);
            text.inputEl.classList.toggle('is-overflowing', overflowing);
            text.inputEl.scrollLeft = text.inputEl.scrollWidth || 0;
          }
          this.renderCountsFor(rootEntry, countsEl);
        };
        if (text.inputEl) {
          // Expression-bodied (returns the promise) rather than a
          // fire-and-forget block body — a real DOM dispatchEvent never
          // awaits a listener's return value either way, but returning
          // it here costs nothing and is what lets a test await the
          // commit deterministically instead of racing a timer.
          text.inputEl.addEventListener('blur', () =>
            commit().catch((err) => console.error('[spotlight] committing an edited root path failed', err)),
          );
          text.inputEl.addEventListener('keydown', (evt) => {
            if (evt.key !== 'Enter') return;
            evt.preventDefault();
            return commit().catch((err) => console.error('[spotlight] committing an edited root path failed', err));
          });
        }
      });

      if (!exists) {
        noteEl.createEl('p', {
          text: `"${rootEntry.path}" doesn't exist in this vault yet.`,
          cls: ['spotlight-settings-note', 'spotlight-settings-error'],
        });
      } else {
        this.renderCountsFor(rootEntry, countsEl);
      }

      // A SECOND, separate Setting in
      // this same card -- not a second `.addToggle()` on the one above,
      // which would just replace that Setting's own component reference
      // rather than add a second control. Not as relevant to a
      // flat My Life any more, but live for any OTHER root (a custom
      // root added by path, or any branch in a non-ICOR vault Spotlight
      // is shared with) that still nests entities inside grouping
      // folders.
      // The description reads "whatever
      // it contains", not "subfolders" -- with this toggle on, a
      // subfolder holding its own same-named note is starrable too, its
      // OWN two candidates (the folder itself AND the note), not just a
      // bare grouping folder as older wording implied: a folder that happens to
      // hold a same-named note is not a special case any more --
      // "whatever it contains" already covered it
      // correctly then and needs no further wording change now.
      // 0.15.0: `.setClass('spotlight-dir-option')` -- the mockup's own
      // CSS selector hook (§5.4) beats INKLINE's flat-pane card styling
      // at (0,4,0), never `!important`, so this ONE row inside the card
      // gets a hairline instead of a second nested card.
      new Setting(cardEl)
        .setName('Spotlight folders too')
        .setDesc('Let every subfolder inside this branch be starred and shelved, whatever it contains')
        .setClass('spotlight-dir-option')
        .addToggle((toggle) =>
          toggle
            .setValue(rootEntry.spotlightFolders === true)
            .setTooltip('Also treat grouping folders under this root as starrable')
            .onChange(async (value) => {
              await this.plugin.setRootSpotlightFolders(rootEntry.path, value);
              this.renderCountsFor(rootEntry, countsEl);
            }),
        );
    });
  }

  /** Shows whenever `settings.roots.length
   * === 0`, in ANY vault, replacing an earlier plain-text guide
   * (see `renderRootsList()`'s own doc comment). This guide keeps only "Go to the Add field," not a
   * Dismiss button -- so `settings.guideDismissed` (an earlier field,
   * kept in the settings shape so existing data.json doesn't lose the
   * key) is now read nowhere in THIS render; the guide shows purely from
   * `roots.length === 0`, with no way to hide it while still empty. */
  renderEmptyGuide(el) {
    const guideEl = el.createDiv({ cls: 'spotlight-dir-empty' });
    const iconEl = guideEl.createDiv({ cls: 'spotlight-dir-empty-icon' });
    if (typeof setIcon === 'function') setIcon(iconEl, 'star');
    guideEl.createEl('p', { text: 'No directories yet', cls: 'spotlight-dir-empty-title' });
    guideEl.createEl('p', {
      text: 'Spotlight watches a folder you choose, at any depth, and surfaces anything you star from it on a shelf at the top of its branch in the file explorer.',
    });
    const exampleEl = guideEl.createEl('p', { text: 'For example: ' });
    exampleEl.createEl('code', { text: 'Projects' });
    new Setting(guideEl).addButton((btn) =>
      btn.setButtonText('Go to the Add field').onClick(() => {
        const inputEl = this.addRootTextComponent && this.addRootTextComponent.inputEl;
        if (!inputEl) return;
        if (typeof inputEl.scrollIntoView === 'function') inputEl.scrollIntoView();
        if (typeof inputEl.focus === 'function') inputEl.focus();
      }),
    );
    guideEl.createEl('p', {
      text: "Add as many folders as you like; they can't sit inside each other.",
      cls: 'spotlight-dir-empty-hint',
    });
  }

  /** 0.15.0: now `.spotlight-dir-counts` (accent, mockup §5.4/choice 5 —
   * REVISES 0.12.0's own "the counts line stays muted" rule, confirmed
   * here rather than left silently contradicted), living inside the
   * card, never `.spotlight-settings-note` any more. §5.8/choice 6
   *: a disabled root reads "Not tracked. Turn on to
   * count." instead of a live count — counting against a root nobody is
   * tracking would just be a number nobody asked for. */
  renderCountsFor(rootEntry, el) {
    el.empty();
    if (rootEntry.enabled === false) {
      el.createEl('p', { text: 'Not tracked. Turn on to count.', cls: 'spotlight-dir-counts' });
      return;
    }
    const { found, starred } = this.plugin.computeRootCounts(rootEntry);
    el.createEl('p', {
      text: `${found} ${found === 1 ? 'entity' : 'entities'} found, ${starred} starred.`,
      cls: 'spotlight-dir-counts',
    });
  }

  /** "Clean up stale stars" -- one Setting after the roots list, its own description
   * carrying the LIVE stale count so a member sees what pressing the
   * button will do before they press it. `cleanupStaleStarredPaths` is
   * never called from anywhere else; this button's own click is the ONLY
   * way it runs.
   *
   * Rebuilds into a FRESH child div on every call, mirroring
   * `renderRootsList()`'s own per-row pattern above (`el.createDiv()`
   * after `el.empty()`) rather than handing a reused `this.cleanupEl`
   * straight to `new Setting(...)` -- `FakeSetting` (and a real
   * `Setting`'s own registration bookkeeping in a test harness) never
   * resets on `.empty()`, only on a fresh element, so reusing the same
   * container across refreshes would accumulate stale `Setting`
   * references instead of replacing them.
   */
  renderCleanupSection() {
    this.cleanupEl.empty();
    // Its own heading, the row's own name
    // shortened to "Remove stars for missing files"
    // so it never just repeats the heading word for word.
    new Setting(this.cleanupEl).setName('Clean up stale stars').setHeading();
    const rowEl = this.cleanupEl.createDiv();
    const stale = computeStaleStarredPaths(this.plugin);
    const countLabel = stale.length === 0 ? 'Nothing to clean.' : `${stale.length} stale.`;
    new Setting(rowEl)
      .setName('Remove stars for missing files')
      .setDesc(`Remove stars kept for files and folders that no longer exist in this vault. ${countLabel}`)
      .addButton((btn) =>
        btn.setButtonText('Clean up').onClick(async () => {
          const result = await cleanupStaleStarredPaths(this.plugin);
          new Notice(
            result.removed === 0
              ? 'Spotlight: nothing to clean up'
              : `Spotlight: removed ${result.removed} stale ${result.removed === 1 ? 'star' : 'stars'}`,
          );
          if (result.removed > 0) {
            this.plugin.requestExplorerSort();
            this.plugin.scheduleStarReapply();
          }
          this.renderCleanupSection();
        }),
      );
  }

  /** Shows whether "auto-reveal active file" is currently on for at least
   * one open file-explorer pane, with a one-way "Turn off" button --
   * never a toggle, never "Turn on," never changed automatically. Rebuilds
   * into a fresh child div every call, same `.empty()` + `createDiv()`
   * pattern `renderCleanupSection()` already uses, for the same reason
   * (a reused container never resets a test harness's `FakeSetting`
   * bookkeeping, and a real `Setting`'s own DOM would just accumulate). */
  renderAutoRevealSection() {
    this.autoRevealEl.empty();
    // 0.15.0, mockup §5.2: its own heading, kept exactly as
    // "Auto-reveal active file" -- the ROW's own name below shortens to
    // "Auto-reveal" instead.
    new Setting(this.autoRevealEl).setName('Auto-reveal active file').setHeading();
    const rowEl = this.autoRevealEl.createDiv();
    const { leaves, anyOn } = computeAutoRevealState(this.plugin.app);

    if (leaves.length === 0) {
      new Setting(rowEl).setName('Auto-reveal').setDesc('File explorer not open.');
      return;
    }

    const setting = new Setting(rowEl)
      .setName('Auto-reveal')
      .setDesc(anyOn ? 'On, for at least one file explorer pane.' : 'Off. Safe to use alongside a hidden branch.');

    if (anyOn) {
      const noteEl = rowEl.createDiv();
      // 0.12.0's own accent-styled warning convention (the settings tab's
      // other refusal/warning lines), reused here rather than a third
      // colour invented for this one.
      noteEl.createEl('p', {
        text:
          "With a branch hidden (the tab below the SPOTLIGHT shelf), auto-reveal can jump the Files panel to an invisible row. Turn it off here, or back on any time from the Files panel's own auto-reveal button.",
        cls: ['spotlight-settings-note', 'spotlight-settings-error'],
      });
      setting.addButton((btn) =>
        btn.setButtonText('Turn off').onClick(async () => {
          await turnOffAutoReveal(this.plugin.app);
          this.renderAutoRevealSection();
        }),
      );
    }
  }
}

module.exports = SpotlightPlugin;
module.exports.default = SpotlightPlugin;
module.exports.__test = {
  // settings model
  defaultSettings,
  migrateSettings,
  normalizeRootPath,
  pillTextForRootPath,
  rootsCollide,
  ROOT_COLLISION_MESSAGE,
  findOwningRootEntry,
  dedupeCollidingRoots,
  AREA_FOLDER_NAMES,
  DEFAULT_ROOT_PATH,
  // ICOR awareness
  detectIcorScaffold,
  computeIcorSeededRoots,
  // discovery
  isTFile,
  isTFolder,
  findEntityCandidates,
  computeStarredCandidates,
  // storage layer
  coerceSpotlightBoolean,
  getSpotlightState,
  spliceSpotlightKey,
  computeSpotlightWrite,
  setSpotlightState,
  todayISODate,
  toggleEntitySpotlight,
  // path star storage (0.7.0, folder + file 0.10.0) -- current names
  getStarredPaths,
  isPathStarred,
  setPathStarred,
  togglePathSpotlight,
  renamePathStarredPaths,
  deletePathStarredPaths,
  computeStaleStarredPaths,
  cleanupStaleStarredPaths,
  // f4r (0.13.6): a configured root's own path/state follows a rename or
  // ancestor rename; drops cleanly on delete
  computeRenamedRootPath,
  applyRootFollowsRename,
  removeRootAwareState,
  // path star storage -- 0.7.0-era aliases, kept for anything still
  // written against the old "folder"-named surface (see the "NAMING"
  // note above the "Path star storage" section header in main.js)
  getFolderStarredPaths,
  isFolderStarred,
  setFolderStarred,
  toggleFolderSpotlight,
  renameFolderStarredPaths,
  deleteFolderStarredPaths,
  computeStaleFolderStarredPaths,
  cleanupStaleFolderStars,
  // candidate helpers (0.7.0, file 0.10.0)
  usesPathStore,
  candidateNode,
  candidatePath,
  getCandidateStarState,
  readLiveStarState,
  reconcileStarOverride,
  setCandidateStarState,
  toggleCandidateSpotlight,
  // file kind icon (0.10.0)
  spotlightFileIconName,
  SPOTLIGHT_IMAGE_EXTENSIONS,
  SPOTLIGHT_AUDIO_EXTENSIONS,
  // context-menu route
  resolveSpotlightTarget,
  addSpotlightMenuItem,
  MENU_CLICK_MAX_AGE_MS,
  getFileExplorerView,
  // the inline star
  ensureStarOnRow,
  removeStarFromRow,
  reapplyStars,
  handleStarActivate,
  resolveRowClassification,
  // the shelf
  revealEntityCandidate,
  positionRevealedRowOneThirdDown,
  unstarShelfEntity,
  handleShelfStarActivate,
  renderShelfForRoot,
  removeShelfForRoot,
  sweepOrphanShelves,
  renderAllShelves,
  // measureShelfRail retired 0.13.6 -- see its own retirement comment in
  // main.js, above renderShelfForRoot.
  // the branch toggle
  applyBranchHiddenDomState,
  invalidateItemHeight,
  reapplyBranchHiddenState,
  syncBranchToggleEl,
  guardScrollAcrossHiddenBranchReveal,
  findItemByEl,
  // reapply-pass churn guards
  isSpotlightOwnedNode,
  isSelfCausedMutation,
  // auto-reveal
  computeAutoRevealState,
  turnOffAutoReveal,
  // conflict detection
  isCommunityPluginActive,
  KNOWN_DECORATION_CONFLICTS,
  detectActiveDecorationConflicts,
  reportDecorationConflicts,
  SpotlightSettingTab,
};
