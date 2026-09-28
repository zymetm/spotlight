# Changelog

All notable changes to this plugin are documented here. Dates are when
the change shipped.

## 0.16.0 — 2026-09-28

First public release, under the name **Spotlight** (renamed from
Spotlight-IFL_MZ). If you installed an earlier build manually, a manual
install moves from `.obsidian/plugins/spotlight-ifl-mz/` to
`.obsidian/plugins/spotlight/` — copy `data.json` across if you have one
(it holds folder and file stars, plus your configured roots); a note's
own star lives in its frontmatter and needs nothing done for it.

**Removed:** the `type:` frontmatter requirement for the five ICOR My
Life area roots. Every root now works the same way, in every vault: any
Markdown note under an enabled root is starrable, with no `type:` check
anywhere. This closes out a rule that only ever made sense under the
plugin's earlier carrier/bucket layout, retired when My Life flattened.

## 0.15.2 — 2026-09-28

Fixed a text-contrast issue on the settings tab's directory pill in
light-mode themes with a high-saturation accent color.

## 0.15.1 — 2026-09-28

Settings-tab fixes: the "Tracked/Off" label and the directory path pill
now update immediately when you toggle a root or edit its path, instead
of requiring a re-open of the settings tab. Fixed a couple of stale-row
rendering glitches on the shelf and the hidden-branch toggle. Star icons
now render through Obsidian's own icon API.

## 0.15.0 — 2026-09-28

Settings tab redesign: each root now renders as its own card (path,
toggle, counts, and the "Spotlight folders too" option all grouped
together, with a clear border under any theme), reorganized into four
sections — Add, Active Spotlight directories, Clean up, and Auto-reveal.

## 0.14.0 — 2026-09-28

Added ICOR for Life awareness. On first install, Spotlight now checks
whether the vault is actually running the ICOR for Life scaffold before
seeding any default roots, and only seeds a root for each of the five
"My Life" areas that actually exist there. In any other vault, Spotlight
starts with no roots configured and shows a short setup guide instead.

## 0.13.0 – 0.13.6 — 2026-09-27 to 2026-09-28

Added a hide/show toggle for the folder tree below each shelf, so you
can view just the curated shelf without the raw folder contents beneath
it. Added a warning in settings when Obsidian's own "auto-reveal active
file" could scroll into a hidden branch, with a one-click way to turn it
off. Several fixes to rapid-star and toggle flicker, a startup pause,
and shelf/row rendering edge cases found along the way.

## 0.12.0 — 2026-09-22

Spotlight's star and accent colors now follow the active theme's own
accent color instead of a fixed color.

## 0.11.0 — 2026-09-21

Removed the "carrier folder" special case: a folder is never treated as
represented by a same-named note inside it. Every folder is an ordinary,
independently starrable item; every note is an ordinary, independently
starrable item. A folder and a note of the same name can now both be
starred at once, as two separate shelf rows.

## 0.10.0 — 2026-09-21

Every file under an enabled root — not just Markdown notes and folders —
is now starrable: images, PDFs, `.base` and `.canvas` files, anything.

## 0.8.0 – 0.9.0 — 2026-09-21

Added a "Clean up stale stars" button in settings. Folders now get their
own icon on the shelf, and clicking a folder's shelf row expands it.
Refined which folders count as independently starrable.

## 0.7.0 – 0.7.1 — 2026-09-21

Added a per-root "Spotlight folders too" toggle, letting subfolders
inside a root be starred and shelved, not just notes. (Folder stars live
in the plugin's own data file, since a folder has no frontmatter of its
own to hold one.)

## 0.6.0 – 0.6.1 — 2026-09-21

Clicking a shelf row's own star now un-stars it directly, without
needing to find and un-star the real row in the tree.

## 0.5.0 – 0.5.1 — 2026-09-16 to 2026-09-21

Removed an earlier "Overview" visual treatment for folder/note pairs
(the fill/edge/chip styling from 0.4.0–0.4.4) — it didn't carry over
cleanly to a non-ICOR vault and no longer made sense once its target
vault structure flattened. The shelf itself is unaffected; its header
now reads "SPOTLIGHT (n)".

## 0.4.0 — 2026-09-15

Replaced the plugin's original per-branch "lane" toggle model with the
current one: any folder can be configured as a root, with a single
on/off switch, and starred items surface on a shelf at the top of that
root's branch. This is the model every later release builds on.

## Early development (0.1.0 – 0.3.3) — 2026-09-06 to 2026-09-08

Initial build: settings UI, note discovery, and the frontmatter-based
star (originally under a `focus:` key, renamed to `spotlight:` in
0.2.0). Added support for more than one configured root, with a
collision rule preventing overlapping roots. Renamed the plugin itself
to Spotlight-IFL_MZ (from an earlier working name) during this period.
