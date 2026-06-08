# Session summary — Grid COI rework + desktop mouse zoom/pan (dev0363→0364)

_Date: 2026-06-07. Branch base: `main`. Repo: pwassm/jjj._

## Goal of this session
Continue the deferred task from memory (`project_grid_desktop_zoom_pan`): add **desktop
mouse-hold zoom + pan** to grid (G) cells, mirroring the phone pinch and the V-player
(vp.js) hold-zoom/pan. Along the way the user redefined how **COI** (center-of-interest)
is stored.

## Decisions made (user-confirmed)
1. **Gesture model = Shift-gated, both modes.** Plain-hold = cut and plain-drag = swipe are
   already taken in the grid cell interactor, and Ctrl/Alt are also used, so the new gesture
   uses **Shift**:
   - **Shift + hold (left button)** → zoom **in** (accelerating ramp, like vp.js).
   - **Shift + hold (right button)** → zoom **out**.
   - **Shift + drag** → **pan** (only meaningful when zoomed > ~1.05×).
   - Desktop only (phones keep pinch).
2. **Pan persistence = transient (session only).** Pan offset lives in a JS map, lost on
   reload. User will Alt-click to save a framing as a COI if they want it persisted.
3. **COI storage moved OUT of the UID and into the row's `COI` column** (the dev0349
   `parentUID@fx,fy` clone-row scheme is dropped — **one COI per row** now).
   - **Format:** `COI` column = three `@@`-separated fields → `x,y@@zoom@@frameRef`
     - `x,y` = cell fractions 0..1 (e.g. `0.425,0.146`)
     - `zoom` = effective cell zoom captured when COI set (1 decimal, e.g. `1.8`)
     - `frameRef` = `frame<N>` for video (N ≈ video currentTime × 30 fps) or literal `image`
   - Only `x,y` drives rendering today; `zoom`/`frameRef` are recorded for the **coming
     time-based autozoom** feature.
4. **Legacy backfill** for the 3 pre-existing COI rows: `zoom=1.0`, `frame0` (video) / `image`.
5. **Existing clone rows:** merge COI onto the parent and delete the clone (859 was an
   orphan with no parent, so it was *promoted* instead of deleted).

## COMPLETED & on disk (this = dev0363, ready to ship)

### Data migration — `ml.json` (do NOT commit; user pushes data separately)
- **755** (mp4 video): parent `COI` set to `0.425,0.146@@1.0@@frame0`; clone `755@0.425,0.146` deleted.
- **859** (YouTube): no parent existed → clone `859@0.755,0.187` **promoted** to plain UID `859`,
  `COI` set to `0.755,0.187@@1.0@@frame0`.
- **19** (jpg image): parent `COI` set to `0.685,0.335@@1.0@@image`; parent given `cell:"3c"`
  (transferred from clone); clone `19@0.685,0.335` deleted.
- Verified via Node: both JSON files parse, all 3 COIs present, **no `@`-suffix UIDs remain**.

### Config fix — `c.json` (do NOT commit; data)
- Line 588 `"3c": "19@0.685,0.335"` → `"3c": "19"` (the saved config referenced the deleted clone).

### Code — `grid.js` (COMMIT THIS)
- `_gridParseCOI(s)` now takes the first `@@` field then splits on `,` (tolerates bare `fx,fy` too).
- `_gridRowCOI(row)` now reads **`row.COI`** (column) instead of the UID `@` suffix.
- `gridSetCOI(cellEl, cellStr, e)` rewritten: writes `row.COI = "fx,fy@@zoom@@frameRef"` straight
  onto the row (no clone, no `data.push`), captures current zoom (`_gridZoomForCell(cell).toFixed(1)`)
  and video frame (`seeLearnVideoPlayers['grid-vid-'+cellStr].getCurrentTime()*30`, best-effort
  synchronous, falls back to `frame0`), bumps `DateModified`, `save()`, and **re-applies the crop
  live** via `_gridApplyZoomToCell(cellEl)`.
- Comment headers updated (dev0348→dev0363).

### Version — `index.html` (COMMIT THIS)
- `HELP_VERSION_STR` bumped `dev0362` → `dev0363`.

## BUILT & VERIFIED — the Shift mouse zoom/pan gesture (dev0364)
Done and on disk in **grid.js** + version bump in **index.html**. Verified live in the
preview on the real 5×5 grid (geometry via `getBoundingClientRect` / `el.style.transform`,
not screenshots): Shift+hold-LMB ramps zoom in (snaps 0.1 on release, rect grows 474→531px),
Shift+hold-RMB ramps out (deletes the per-cell entry at 1.0×), effective-zoom floor holds at
0.2×, Shift+drag pans (img/video via `calc(% + px)`, iframe via px; delta exact), 2nd-Z reset
clears `_gridCellPan`, Shift+contextmenu suppressed, no console errors. Implementation notes:

1. **Transient pan state + render integration**
   - Add `var _gridCellPan = {};` (UID → `{x,y}` px offset, session-only) near `_gridCellZoom` (line ~78).
   - Add helper `_gridCellPanForCell(cellEl)` near `_gridCOIForCell` → returns `{x,y}` or null.
   - Thread pan into the transform builders (additive, defaults to no-op):
     - `_gridAnchoredTransform(coi, Z, pan)` — append pan px via `calc(tx% + Xpx)` so the %-anchor
       and px-pan combine in one transform. Used by img/box/video paths.
     - `_gridApplyCoverFit` iframe px branch — add `pan.x`/`pan.y` to the computed `tx`/`ty`.
     - `_gridApplyZoomToCell` (img/box) and `_gridApplyCoverFit` (video) — fetch pan + pass it in.
   - In `gridResetZoom`, clear `_gridCellPan = {}` alongside `_gridCellZoom = {}` on the 2nd-Z full reset.

2. **Gesture state machine inside `gridWireInteractor(interactor, cell, cellStr)`** (grid.js ~1227)
   - At the **top of the existing pointerdown** (after the Alt-click COI check, before `pStart` is set):
     ```js
     if (e.shiftKey && e.pointerType === 'mouse' &&
         !(typeof _isMobileDevice === 'function' && _isMobileDevice()) &&
         _gridCellZoomTarget(cell) && (e.button === 0 || e.button === 2)) {
       e.preventDefault(); e.stopPropagation();
       _szBegin(e); pStart = null; return;   // normal gesture path bails on null pStart
     }
     ```
   - Add closure vars + functions: `_szActive/_szDown/_szDragging/_szStart/_szPanBase/_szDelay/_szTimer/_szStep/_szBtn`,
     and `_szStop/_szBegin/_szMove/_szEnd/_szCancel`.
     - `_szBegin`: setPointerCapture; `dir = (button===2)?-1:1`; 180ms settle then `setInterval(50ms)`
       ramping `_gridCellZoom[UID] += dir*step` (step 0.01→0.08, +0.004/tick), floor `_GRID_ZOOM_MIN`
       (0.2), `_gridApplyZoomToCell(cell)` each tick.
     - `_szMove`: >8px → `_szDragging=true`, `_szStop()`, capture pan base; while dragging AND
       `_gridZoomForCell(cell) > 1.05`, set `_gridCellPan[UID] = base + delta`, `_gridApplyZoomToCell(cell)`.
     - `_szEnd`: `_szStop()`, snap `_gridCellZoom[UID]` via `_gridSnapZoom` (delete entry if ≈1.0),
       `_gridApplyZoomToCell`, `_gridToast` with the cell + final zoom.
     - `_szCancel`: clear all state.
   - At the **top of the existing pointermove / pointerup / pointercancel** handlers add
     `if (_szActive) { _szMove(e)/_szEnd(e)/_szCancel(); return; }` BEFORE their `if (!pStart) return;`.
   - Add `interactor.addEventListener('contextmenu', ev => { if (ev.shiftKey || _szActive) ev.preventDefault(); }, true);`
     to suppress the right-click menu during Shift+right zoom-out.

3. **Info bar hint** (grid.js ~1017): append `· ⇧drag=zoom/pan` to the dev info-bar string.

4. **Verify** (preview): use `getBoundingClientRect()` / `el.style.transform`, **NOT screenshots**
   (remote Cloudflare images time out in preview — see memory `feature_grid_clean_playback`).
   Confirm: Shift+hold scales a cell up; Shift+right shrinks it; Shift+drag at >1× shifts the
   transform translate; bare-Z still resets.

5. **Bump** `HELP_VERSION_STR` → `dev0364`, then commit grid.js + index.html.

## Key references / gotchas
- vp.js mouse ramp to mirror: `wireMouseV()` at **vp.js:561–644** (180ms settle, 50ms interval,
  step 0.015→0.12, pan at scale>1.05, dblclick reset).
- Grid zoom machinery: `_gridCellZoom` (grid.js:78), `gridAdjustCellZoom` (655), `gridResetZoom` (641),
  `_gridSnapZoom` (332), `_GRID_ZOOM_MIN=0.2` / `_GRID_ZOOM_STEP=0.1` (322–323),
  `_gridApplyZoomToCell` (435), `_gridApplyCoverFit` (449), `_gridAnchoredTransform` (401).
- Cell interactor (all the conflicting gestures): `gridWireInteractor` grid.js:1227.
- Per-cell zoom persists to c.json on config save (collection.js:107); pan stays transient.
- **Commit policy** (memory `feedback_ready_to_commit`): stage only code files I changed
  (grid.js, index.html, this summary) — never blanket-add `ml.json`/`c.json`/data; the user
  pushes data themselves.
- Model: **Opus** throughout (user preference; this is hot-path/stateful work — Opus is right).

## Task list state
1. ✅ Migrate 3 COI rows in ml.json → COI column (dev0363)
2. ✅ Refactor grid.js COI read/write to COI column (dev0363)
3. ✅ Add Shift-gated desktop mouse zoom/pan (dev0364 — built + verified in preview)
4. ✅ Bump HELP_VERSION_STR → dev0364, verify, commit code (grid.js + index.html + this summary)
