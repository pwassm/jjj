# Local Media Manifest — design v0.2

## Concept

Add a `review` mode to ssmenu — same engine, slideshow-specific behaviors off (no auto-advance, no transitions), rating features on (keyboard rating, queue, tallies). Files get rated `a/s/d/f` (best/good/fair/poor); the rating moves the file into a per-rating subdir under each drive's `Assets/` umbrella. Ratings preserve — `f_/` files stay on disk so Everything/dedup tools can match by name across drives. An IDB-backed manifest tracks granted roots and (for opted-in roots) a file inventory with cached metadata. Lives separately from `ml.json`, which is the web/Cloudflare medialinks catalog. Entry from T (Table) screen via new `R` hotkey (mnemonic Review).

## Folder layout

- All media to be triaged lives under `Drive:\Assets\` — capital A, one per drive.
- Source folders are subdirs of `Assets\`: e.g. `M:\Assets\dcim_phone\`, `M:\Assets\editing_backlog\`.
- Rating destinations live at the `Assets\` level: `M:\Assets\a_\`, `s_\`, `d_\`, `f_\`.
- Trailing underscore so Windows filemanager keyboard nav (typing `a`) jumps straight to the rating directory.
- Destination preserves source subpath:
  `<drive>\Assets\<srcRel>\file.ext` → `<drive>\Assets\<rating>_\<srcRel>\file.ext`
  Example: `M:\Assets\dcim_phone\2026\03\IMG.mp4` rated `a` → `M:\Assets\a_\dcim_phone\2026\03\IMG.mp4`.

## Rating semantics

- `a` best — likely to edit & publish
- `s` good — keep, may edit
- `d` fair — keep, low priority
- `f` poor — keep but de-prioritize; bait for cross-drive dedup
- `f_` is **not** erase. Poor files stay on disk so external tools surface them.

## FSA permissions

- User grants `<drive>\Assets\` per drive — one click per session per drive (`requestPermission()` needs user gesture).
- Handles persist in IDB via structured clone. On page load, `queryPermission()` each stored handle; non-granted roots show as "click to re-grant" tiles.
- Single-handle-per-drive keeps permission scope narrow: an origin compromise can only touch `Assets\`, not the whole drive.
- Browser default is session-scoped — closing the tab effectively revokes; next session re-prompts with one click.
- Requires Chrome 123+ for `FileSystemFileHandle.move()` across folders within the granted tree.

## IDB schema (`localmedia` DB)

- **`roots`** — `{ id, drive, name, handle (persisted FileSystemDirectoryHandle), addedAt, lastOpenedAt, indexed: bool, lastIndexedAt }`
  - One row per drive's `Assets\` grant.
  - Shared with ssmenu — its Source dropdown reads from this store.
- **`files`** (only for `indexed: true` roots) — `{ rootId, relPath, size, mtime, kind (video|image), width, height, durationMs?, takenAt?, rating?, uploadState?, cloudflareId?, tags? }`
  - `relPath` is relative to the granted root (starts inside `Assets\`).
- **`pendingMoves`** — `{ rootId, relPath, targetRel, queuedAt }` — hybrid-move queue.

## Move pipeline (hybrid)

1. Press `a/s/d/f` → write `files.rating` + `pendingMoves` row, advance UI immediately.
2. Auto-flush on: (a) 5s idle, (b) leaving folder, (c) page close, (d) manual `F` key.
3. Flush walks `pendingMoves`, calls `srcFile.move(destDir, name)` per row, removes on success.
4. Destination dirs auto-created via `getDirectoryHandle(name, {create: true})` walking the target subpath.
5. Failures (name collision, lost permission) stay queued and surface in UI for retry/resolve.
6. All moves stay within the single granted handle tree, so `move()` is fast and atomic.

## Indexing (opt-in per root)

- "Index this root" button walks the tree, populates `files` with metadata.
  - Dimensions / duration via `<video>` / `<img>` decode.
  - Date via `File.lastModified`.
- Revisit a folder → cheap dir-walk diff against IDB (`name+mtime`). Only new/changed files re-extract metadata; deleted files marked.
- Manual "re-index" escape hatch wipes the root's `files` rows and rebuilds.
- Non-indexed roots use live walk only, no `files` rows written. Rating still works (writes to `pendingMoves` keyed by relPath).

## Review-mode UX

ssmenu in `review` mode. Slideshow-specific behaviors (transitions, auto-advance timer) are off; review-specific UI and keys are on.

- **Top of preview pane**: path breadcrumb (orientation while navigating).
- **Left**: folder tree of current root, with per-folder rating tallies (indexed) or live counts (non-indexed).
- **Center**: large preview — video plays inline, image fits.
- **Right**: file meta (path, dims, date, rating, tags) + pending-queue depth + flush button.
- **Default sort**: date desc (camera workflow).
- **Mode toggle**: `Tab` (or UI button) flips between slideshow and review without losing folder/file context.
- **Keys**:
  - `←/→` prev/next file in current folder
  - `a s d f` rate-and-advance
  - `n` skip to next unrated
  - `space` play/pause
  - `z` undo last move — multi-level stack; pulls from queue, or reverses physical move if already flushed
  - `enter` descend into subfolder
  - `backspace` up a level
  - `F` flush queue now
  - `Tab` toggle slideshow/review

## Integration points

- **ssmenu becomes mode-aware.** Slideshow mode is current behavior; review mode is the file-management UI described above. Same engine, parameterized via `?mode=review` URL param or in-page toggle. Slideshow-specific behaviors (auto-advance timer, transitions) gate on `mode === 'slideshow'`.
- **T screen `R` hotkey** opens ssmenu in review mode. New screen code `R` (Review) — add to the screens table in CLAUDE.md.
- **ssmenu Source dropdown** reads `roots` table → replaces the `vpDiskRoot:NAME` localStorage hack. Migration: on first launch, seed `roots` from existing `vpDiskRoot:*` keys; leave localStorage in place for now.
- **ml.json**: no link in v0. Future bridge candidate — when a file reaches `uploadState='uploaded'`, optionally create/link an `ml.json` row.
- **tags.json**: schema field reserved in `files`, no UI in v0.

## Out of scope for v0

- Cloudflare upload (schema field reserved, no UI/API)
- Tag editing via `tags.json` (field reserved, read-only or absent in UI)
- In-app dedup detection (user uses Everything externally)
- Auto-import of camera dumps into `Assets\` (manual organize)
- Migration tooling to move existing DCIMs into `Assets\` (one-time user task)

## Build sequence

**Shipped (dev0298–dev0300):**

1. ssmenu is mode-aware (`slideshow` default; `review` triage mode).
2. T-screen `R` hotkey opens ssmenu in review mode (left-hand pick — see [[left-hand-hotkeys]]).
3. Walk skips `a_/s_/d_/f_` subdirs in review so already-rated files don't re-queue.
4. `a/s/d/f` rating: walks/creates `<root>/<rating>_/<srcRelDir>/` and calls FSA `fh.move()`. No queue yet — direct move on keypress (simpler than the hybrid queue from the design).
5. Vprime — inline `<video controls muted>` for video slides in review mode. NOT the full V player; V would block a/s/d/f via `_videoActive` and bind them to AB-marker movement. Frame visible via auto-seek to 0.1s after metadata loads.
6. Bottom-left tally card showing `a-#  s-#  d-#  f-#` updated per move.

**Still to build:**

- `Q` screen — local-media table view (left-hand mirror of T). Separate IDB store; ml.json untouched. Reuse T's table widget eventually by factoring out a shared renderer.
- Multi-root `roots` IDB store (currently still uses ssmenu's single `ssSource` handle in `sal-fsa` DB).
- Path breadcrumb in review-mode preview pane.
- Per-folder rating tallies in a folder-tree pane.
- Mode toggle key (`Tab`) so user can flip slideshow ↔ review without closing.
- Pending-moves queue + hybrid auto-flush (per design — currently direct-move only).
- Multi-level undo (`z`) and skip-to-next-unrated (`n`).
- Indexing (cached metadata: dims, duration, takenAt).
- Tag editing (`tags.json` integration).
- Cloudflare upload state.

## Constraints learned during build

- **Manifest is expected to be ephemeral early on.** User's media is scattered across removable drives; q.json (or whatever backs the Q-screen table) will be wiped and rebuilt repeatedly as schema evolves. Implication: keep schema lean. Store only data that **can't** be re-derived from a disk scan — Cloudflare upload state, manual tags, indexing-cache freshness. Ratings live in disk paths (`a_/` etc.), so they survive wipe + rescan.
- **Rating subdirs lazy-create only.** `s_/` never exists on disk unless you've pressed `s` at least once.
- **Hotkey preference: left-hand.** New global hotkeys default to the left side of the keyboard (Q/W/E/A/S/D/F/Z/X/C/V/B) so the right hand stays on the mouse. T (Table) predates this convention.
- **Don't toast on every successful move.** The bottom-right counter (X / N) already shows progress; per-move toast is noise during rapid triage. Reserve toasts for errors.
