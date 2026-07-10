// ══════════════════════════════════════════════════════════════════════════════
// hotkeys.js — GLOBAL HOTKEY REGISTRY + DISPATCHER (dev0542)
//
// Single source of truth for the global (screen-switching) hotkeys that used to
// live as a 500-line if-chain in vp.js `window._executeHotkey`. Each registry
// entry carries its own help text, so the H screen's "Global" panel is rendered
// LIVE from this table (see _hotkeysHelpSection at the bottom + _helpData() in
// core.js) — the help can no longer drift from what the keys actually do.
//
// Two kinds of entries:
//   • fn entries  — dispatched by _executeHotkey below. core.js's window-capture
//     listener forwards bare letters here (see core.js ~line 401).
//   • doc entries (no fn) — interactions handled elsewhere, listed here ONLY so
//     H shows the complete picture; `impl` says where the real handler lives.
//     Three flavours: (a) window-capture keys owned by core.js (Ctrl+D / Alt+R /
//     Shift+F, screen-gated grid keys); (b) GESTURES — swipe/mouse idioms; and
//     (c) MENUS — the hamburger + right-click context menus. Gestures and menus
//     stay screen-local by design; they are documented, not dispatched, from
//     here. When migrating a screen's KEY into the registry, replace its doc
//     entry with a fn entry (gestures/menus have no fn form).
//
// Entry fields:
//   key    lowercase key as delivered by core.js's dispatcher (fn entries only)
//   label  how the binding is displayed in Help ('T', 'Ctrl+D', 'Swipe → cell')
//   group  Help grouping line
//   desc   what the key/gesture does — THIS IS WHAT H RENDERS
//   scope  where it fires: 'global' or a screen code (doc entries)
//   impl   doc entries: file/handler that actually owns the interaction
//   helpSection  doc entries: which Help sub-section it renders under —
//                default 'Screen-gated hotkeys'; also 'Gestures' and 'Menus'
//   dev    doc entries: true = dev-only (hidden from the Hu/Hum user help)
//   fn(ctx) executable handler; ctx = open-overlay snapshot (see _hkCtx)
//
// Keys blocked in user mode (public site) are listed in HK_USER_BLOCKED — the
// help's dev/user marking is derived from that same list, so it can't drift
// either.
// ══════════════════════════════════════════════════════════════════════════════

// (zip0141/dev0315) User mode (Gu/Cu only): these keys lead to dev-only screens
// and must never fire on the public site. G/V/C/H stay accessible — those are
// the user's home/view/config/help surfaces.
const HK_USER_BLOCKED = ['t', 'e', 'a', 'd', 'm', 'l', 'w', 'f', 'i', 's', 'o', 'x'];

// Snapshot of which overlays are open — computed once per dispatch and passed
// to every handler (same flags the old vp.js if-chain computed up front).
function _hkCtx() {
  return {
    veOpen:   !!document.getElementById('video-editor-overlay'),
    ebOpen:   document.getElementById('browseOverlay')?.style.display === 'flex',
    gridOpen: document.getElementById('gridOverlay')?.style.display === 'flex',
    vpOpen:   document.getElementById('gridFullscreen')?.style.display === 'flex',
    teOpen:   !!document.getElementById('textEditorOverlay'),
    tgOpen:   _cMode,
  };
}

// Shared teardown used by the covering staging screens (I/St/O/X): close
// whatever screen is showing so no grid/V videos keep playing behind the
// covering overlay. Verbatim from the four identical blocks in the old chain.
function _hkTeardownForStaging(ctx) {
  if (ctx.vpOpen) vpClose();
  if (ctx.veOpen) { const cb = document.getElementById('v2close'); if (cb) cb.click(); }
  if (ctx.ebOpen) {
    brSave();
    document.getElementById('browseOverlay').style.display = 'none';
    document.getElementById('wrap').style.marginRight = '';
    brClearMedia();
  }
  if (ctx.gridOpen) {
    gridCleanupPlayers();
    gridHideContextMenu();
    document.getElementById('gridOverlay').style.display = 'none';
  }
  if (ctx.tgOpen) closeCScreen();
}

// The covering staging screens (dev0429 I, dev0447 St, dev0466 O, dev0521 X).
// Each toggles itself on its own key; any OTHER nav key closes it first, then
// falls through to open the requested screen. Order here mirrors the old
// if-chain order (i → s → o → x) so cross-screen presses behave identically.
const HK_STAGING = [
  { key: 'i', isOpen: () => (typeof window.isIgScreenOpen === 'function') && window.isIgScreenOpen(),
    open: () => { if (window.openIgScreen) window.openIgScreen(); },
    close: () => { if (window.closeIgScreen) window.closeIgScreen(); } },
  { key: 's', isOpen: () => (typeof window.isStScreenOpen === 'function') && window.isStScreenOpen(),
    open: () => { if (window.openStScreen) window.openStScreen(); },
    close: () => { if (window.closeStScreen) window.closeStScreen(); } },
  { key: 'o', isOpen: () => (typeof window.isOScreenOpen === 'function') && window.isOScreenOpen(),
    open: () => { if (window.openOScreen) window.openOScreen(); },
    close: () => { if (window.closeOScreen) window.closeOScreen(); } },
  { key: 'x', isOpen: () => (typeof window.isXScreenOpen === 'function') && window.isXScreenOpen(),
    open: () => { if (window.openXScreen) window.openXScreen(); },
    close: () => { if (window.closeXScreen) window.closeXScreen(); } },
];

// ── THE REGISTRY ─────────────────────────────────────────────────────────────
window.HOTKEYS = [

  // ── Registry-dispatched screen keys (fn entries) ───────────────────────────
  { key: 'i', label: 'I', group: 'Screens', scope: 'global',
    desc: 'Toggle the I (Instagram staging) screen — ig.json review/enrich/promote',
    fn(ctx) { /* handled via HK_STAGING in the dispatcher */ } },

  { key: 's', label: 'S', group: 'Screens', scope: 'global',
    desc: 'Toggle the St (bulk staging) screen — s.json links (from the Table; from the Grid, S plays the slideshow)',
    fn(ctx) { /* handled via HK_STAGING in the dispatcher */ } },

  { key: 'o', label: 'O', group: 'Screens', scope: 'global',
    desc: 'Toggle the O (org-review) screen — Orgzly notes in o.json',
    fn(ctx) { /* handled via HK_STAGING in the dispatcher */ } },

  { key: 'x', label: 'X', group: 'Screens', scope: 'global',
    desc: 'Toggle the X (search-results) screen — finder hits in x.json',
    fn(ctx) { /* handled via HK_STAGING in the dispatcher */ } },

  { key: 't', label: 'T', group: 'Screens', scope: 'global',
    desc: 'Return to the Table (saves an open E screen first)',
    fn(ctx) {
      if (ctx.tgOpen) { closeGridList(); return; }
      if (ctx.vpOpen) vpClose();
      if (ctx.veOpen) {
        const cb = document.getElementById('v2close');
        if (cb) cb.click();
        window._cameFromGrid = false;
        setTimeout(() => buildTable(), 50);
        return;
      }
      if (ctx.ebOpen) {
        brSave();
        document.getElementById('browseOverlay').style.display = 'none';
        document.getElementById('wrap').style.marginRight = '';
        brClearMedia();
      }
      if (ctx.gridOpen) {
        gridCleanupPlayers();
        gridClearCut();
        gridHideContextMenu();
        document.getElementById('gridOverlay').style.display = 'none';
      }
      _cameFromGrid = false;
      buildTable();
    } },

  { key: 'g', label: 'G', group: 'Screens', scope: 'global',
    desc: 'Open the Grid (in the Grid: open the hovered cell’s source page — its linkpage, or the link itself for YouTube/Vimeo/IG/articles; for a raw image with no source page, dev opens a reverse-image search, user gets a toast)',
    fn(ctx) {
      if (ctx.tgOpen) { closeGridList(); gridShow(); return; }
      // If in VP (Video/Image View), close it and stay in grid
      if (ctx.vpOpen) { vpClose(); return; } // Grid is already showing behind VP
      // If already in grid (and not in VP), open the hovered cell's link in a new tab
      if (ctx.gridOpen) {
        if (window._gridOpenLink) window._gridOpenLink();
        return;
      }
      // Close VE and go to grid
      if (ctx.veOpen) {
        const cb = document.getElementById('v2close');
        if (cb) cb.click();
        setTimeout(() => { buildTable(); gridShow(); }, 50);
        return;
      }
      // Close EB and go to grid
      if (ctx.ebOpen) {
        brSave();
        document.getElementById('browseOverlay').style.display = 'none';
        document.getElementById('wrap').style.marginRight = '';
        brClearMedia();
      }
      buildTable();
      gridShow();
    } },

  { key: 'e', label: 'E', group: 'Screens', scope: 'global',
    desc: 'Open the Editor for the focused row — video → Ev, ftext → Xe, image → Ie; ttxt/ctxt/ss column focus edits THAT field',
    fn(ctx) {
      // E = Editor — Video Editor for video rows, Text/HTML editor for ftext rows
      // (zip0133) Routing is row-content based:
      //   - isVideoRow(row)  → openVideoEditor (the existing E screen)
      //   - row.ftext or VidRange='text' → gridOpenTextEditor
      //   - otherwise → "no editor for this row type" toast.
      if (ctx.teOpen) return;
      if (ctx.veOpen) return; // already in VE

      // (dev0378) Column-targeted editing. When the focused column is T's `ttxt`
      // or C's `ctxt`, E opens THAT field in the HTML editor (a details block),
      // instead of the row's default media/ftext editor. The C-screen reuses the
      // same table engine, so `focus`/visCols() resolve against _cData in _cMode
      // and the editor's save() routes to c.json via the boot.js patch.
      // (dev0383) C's `ss` field edits in the SAME editor.
      if (!ctx.gridOpen && focus !== null && typeof visCols === 'function') {
        const _fcol = visCols()[focus.c];
        if (_fcol === 'ttxt' || _fcol === 'ctxt' || _fcol === 'ss') {
          if (ctx.vpOpen) vpClose();
          const _tdi = vr(focus.r);
          const _trow = (_tdi >= 0 && _tdi < data.length) ? data[_tdi] : null;
          if (!_trow) { toast('No row focused', 1500); return; }
          if (typeof gridOpenTextEditor === 'function') {
            gridOpenTextEditor(_trow.cell || '', _trow, { field: _fcol });
          } else {
            toast('Text editor not available', 1800);
          }
          return;
        }
      }
      if (ctx.vpOpen) vpClose();

      let rowToEdit = null;
      if (!ctx.gridOpen && focus !== null) {
        const di = vr(focus.r);
        if (di >= 0 && di < data.length) rowToEdit = data[di];
      }
      if (!rowToEdit && _lastGridRow) rowToEdit = _lastGridRow;

      if (!rowToEdit) {
        // (zip0184) No focused row — select the first visible filtered row
        // (same set that arrow-key navigation uses) and open its editor.
        const _visList = (typeof brGetVisibleRows === 'function')
          ? brGetVisibleRows()
          : (typeof data !== 'undefined' ? data.map((_, i) => i) : []);
        if (!_visList.length) { toast('No rows available', 1500); return; }
        const _firstDi = _visList[0];
        rowToEdit = (typeof data !== 'undefined') ? data[_firstDi] : null;
        if (!rowToEdit) { toast('No rows available', 1500); return; }
        // Also update T's focused row so it's highlighted when returning to T
        if (typeof window._setFocusToRow === 'function') window._setFocusToRow(rowToEdit);
      }

      // (zip0178) Seed _brRows / _brIdx so arrow-key navigation in Xe / Ie
      // knows where to start without reinitialising the filter context.
      _ensureBrRows();
      {
        const _di = (typeof data !== 'undefined') ? data.indexOf(rowToEdit) : -1;
        if (_di >= 0) {
          const _fi = window._brRows.indexOf(_di);
          if (_fi >= 0) window._brIdx = _fi;
        }
      }

      // (dev0462) Mouse-column-gated ftext routing. For a row that is ALSO a
      // video, ftext only wins when the mouse is over the `ftext` column
      // (x-span only). Pure text rows (VidRange==='text' or ltype==='w') always
      // open Xe. Skip the gate when the grid overlay is up.
      const _overFtextCol = !ctx.gridOpen
        && (typeof _colUnderMouse === 'function') && _colUnderMouse() === 'ftext';
      const _isVidRow = isVideoRow(rowToEdit);
      const isText = _overFtextCol
        || rowToEdit.VidRange === 'text'
        || rowToEdit.ltype === 'w'
        || (typeof rowToEdit.ftext === 'string' && rowToEdit.ftext.length > 0 && !_isVidRow);

      if (isText) {
        // Route to the HTML/text editor (handles both rich-text slides and
        // JSON quiz definitions — the editor itself detects which).
        if (typeof gridOpenTextEditor === 'function') {
          gridOpenTextEditor(rowToEdit.cell || '', rowToEdit);
        } else {
          toast('Text editor not available', 1800);
        }
        return;
      }

      // (zip0178) Image rows → Ie: image fullscreen + Annotate panel side by side.
      if (rowToEdit.link && !isVideoRow(rowToEdit)) {
        _cameFromGrid = ctx.gridOpen;
        if (ctx.gridOpen) {
          gridCleanupPlayers();
          gridHideContextMenu();
          document.getElementById('gridOverlay').style.display = 'none';
        }
        openIe(rowToEdit);
        return;
      }

      if (!isVideoRow(rowToEdit)) {
        toast('E = Editor (videos, ftext, or image rows)\nUse A to annotate', 1800);
        return;
      }

      _cameFromGrid = ctx.gridOpen;
      if (ctx.gridOpen) {
        gridCleanupPlayers();
        gridHideContextMenu();
        document.getElementById('gridOverlay').style.display = 'none';
      }
      // Close Annotate if open
      if (ctx.ebOpen) {
        brSave();
        document.getElementById('browseOverlay').style.display = 'none';
        document.getElementById('wrap').style.marginRight = '';
        brClearThumb();
      }
      if (window.openVideoEditor) window.openVideoEditor(rowToEdit);
    } },

  { key: 'a', label: 'A', group: 'Screens', scope: 'global',
    desc: 'Annotate panel from V; on the Grid, A toggles STEP-FRAME mode (cells with saved steps loop their local step clip, grabbed on demand); in the Table, bare A toggles the row preview — see below',
    fn(ctx) {
      // A = Annotate panel (images and videos), from V. (dev0538) From the
      // bare Table screen, core.js intercepts 'a' as the row-preview toggle
      // before it ever reaches this handler.
      if (ctx.veOpen) return; // VE takes priority

      // (dev0564) On the bare grid (no V/C/annotate overlay on top), A toggles
      // step-frame mode instead of Annotate — cells with saved steps swap to
      // their pre-grabbed local frame jpgs (grid.js gridToggleStepFrames).
      if (ctx.gridOpen && !ctx.vpOpen && !ctx.ebOpen && !ctx.tgOpen) {
        if (window.gridToggleStepFrames) window.gridToggleStepFrames();
        return;
      }

      if (ctx.tgOpen) closeCScreen(); // close C-screen before opening annotate
      if (ctx.vpOpen) vpClose();

      // Toggle: if already open, close it
      if (ctx.ebOpen) { brSave(); brClose(); return; }

      let startDi = undefined;
      if (!ctx.gridOpen && focus !== null) {
        startDi = vr(focus.r);
      } else if (_lastGridRow) {
        startDi = data.indexOf(_lastGridRow);
      }

      _cameFromGrid = ctx.gridOpen;
      brOpen(startDi);
    } },

  { key: 'h', label: 'H', group: 'Screens', scope: 'global',
    desc: 'Toggle Help (works from any screen, any mode)',
    fn(ctx) {
      // (zip0155) Works from any screen and in any mode.
      if (ctx.teOpen || ctx.veOpen) return; // text/video editors own their own keys
      if (typeof isHelpOpen === 'function' && typeof openHelp === 'function') {
        isHelpOpen() ? closeHelp() : openHelp();
      }
    } },

  { key: 'v', label: 'V', group: 'Screens', scope: 'global',
    desc: 'View the focused T row / last grid row fullscreen (V/I/Q/Xs); toggles closed if already open',
    fn(ctx) {
      // (zip0159) Mirrors swipe-right behaviour.
      if (ctx.teOpen) return;
      if (ctx.veOpen) return;
      // Toggle: if fullscreen viewer is already open, close it.
      if (ctx.vpOpen) { vpClose(); return; }

      let row = null;
      // From T: use focused row
      if (!ctx.gridOpen && focus !== null) {
        const di = vr(focus.r);
        if (di >= 0 && di < data.length) row = data[di];
      }
      // From G: use last interacted grid row
      if (!row && typeof _lastGridRow !== 'undefined' && _lastGridRow) row = _lastGridRow;
      // Fallback: last UID
      if (!row && window._lastUID) {
        row = data.find(r => String(r.UID) === String(window._lastUID));
      }
      if (!row) { toast('Select a row first', 1500); return; }
      // Ensure grid overlay is visible if it isn't (V sits on top of it
      // visually but needs its DOM siblings to be present). Track when V
      // forced it open from T so vpClose can hide it again.
      const gOvl = document.getElementById('gridOverlay');
      if (gOvl && gOvl.style.display !== 'flex') {
        gOvl.style.display = 'flex';
        window._vpForcedGridFromT = true;
      }
      gridOpenFullscreen(row);
    } },

  { key: 'c', label: 'C', group: 'Screens', scope: 'global',
    desc: 'Toggle the Collection/Config screen (c.json grid configs)',
    fn(ctx) {
      // (dev0376) Caption toggle moved to Shift+C, handled in core.js before
      // the key is lowercased.
      if (ctx.teOpen) return;
      // (dev0571) User/mobile mode: 'c' opens the FRIENDLY config picker overlay
      // (_showMobileCPicker), NOT the dev C-table. openCScreen() renders the raw
      // Table engine, which is hidden in user mode — so on the public site 'c' hid
      // the grid and showed a blank table = BLACK SCREEN (user report). The picker
      // floats above the grid (z 999991); leave the grid mounted behind it, toggle.
      const userC = (typeof _isUserMode === 'function' && _isUserMode())
                 || (typeof _isMobileDevice === 'function' && _isMobileDevice());
      if (userC) {
        const open = document.getElementById('mobileCPicker');
        if (open) { open.remove(); return; }                       // toggle off
        if (typeof _showMobileCPicker === 'function') _showMobileCPicker();
        return;
      }
      if (ctx.tgOpen) { closeCScreen(); return; } // toggle off
      // Close any open overlays first
      if (ctx.vpOpen) vpClose();
      // (dev0376) Close the grid overlay too — openCScreen() doesn't hide it.
      if (ctx.gridOpen) {
        const gOvl = document.getElementById('gridOverlay');
        if (gOvl) gOvl.style.display = 'none';
      }
      if (ctx.veOpen) {
        const cb = document.getElementById('v2close');
        if (cb) cb.click();
      }
      if (ctx.ebOpen) {
        brSave();
        document.getElementById('browseOverlay').style.display = 'none';
        document.getElementById('wrap').style.marginRight = '';
        brClearMedia();
      }
      openCScreen();
    } },

  { key: 'd', label: 'D', group: 'Screens', scope: 'global',
    desc: 'Open the Dictionary — on the focused row’s first tag when in the Table',
    fn(ctx) {
      // (zip0158) If T is the active screen and the focused row has any tag,
      // open the dictionary FOR that tag (tree view, ancestors expanded, tag
      // selected). Otherwise open the dictionary to its last state.
      if (ctx.veOpen) return;
      let opened = false;
      if (!ctx.gridOpen && !ctx.vpOpen && !ctx.ebOpen && !ctx.tgOpen
          && typeof focus !== 'undefined' && focus !== null
          && typeof vr === 'function'
          && Array.isArray(data)) {
        const di = vr(focus.r);
        const row = data[di];
        const ids = row && Array.isArray(row.tags) ? row.tags : [];
        if (ids.length > 0 && typeof window.openDictForTag === 'function') {
          window.openDictForTag(ids[0]);
          opened = true;
        }
      }
      if (!opened && window.openDictionary) window.openDictionary();
    } },

  { key: 'l', label: 'W  or  L', group: 'Import & filter', scope: 'global',
    desc: 'Smart clipboard import — bare media links, or @channel + CSV (T only)',
    fn(ctx) {
      // L = same as W (smart clipboard import)
      if (ctx.teOpen || ctx.veOpen || ctx.ebOpen || ctx.gridOpen || ctx.vpOpen || ctx.tgOpen) return;
      if (document.getElementById('dictOverlay'))    return;  // Dictionary open
      if (document.getElementById('mergeModal'))     return;  // Merge modal open
      if (typeof wantLinks === 'function') wantLinks();
    } },

  { key: 'w', label: null, group: 'Import & filter', scope: 'global',
    desc: null, // rendered under the 'W  or  L' row above
    fn(ctx) {
      // W = smart clipboard import (Rule 1 bare links or Rule 2 channel CSV)
      if (ctx.teOpen || ctx.veOpen || ctx.ebOpen || ctx.gridOpen || ctx.vpOpen || ctx.tgOpen) return;
      if (document.getElementById('dictOverlay'))    return;
      if (document.getElementById('mergeModal'))     return;
      if (typeof wantLinks === 'function') wantLinks();
    } },

  { key: 'f', label: 'F', group: 'Import & filter', scope: 'global',
    desc: 'Toggle the filter modal — tags ∧ text search (T only; in the Grid, F toggles FallCells)',
    fn(ctx) {
      // F = open filter modal (T-view only). Modal is composite: tags ∧
      // text-field substring matches across VidAuthor / VidTitle / link /
      // ftext. Pressing F again toggles it closed.
      if (ctx.teOpen || ctx.veOpen || ctx.ebOpen || ctx.gridOpen || ctx.vpOpen || ctx.tgOpen) return;
      if (document.getElementById('dictOverlay'))    return;
      if (document.getElementById('mergeModal'))     return;
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
      if (typeof window.openFilterModal === 'function') window.openFilterModal();
    } },

  // ── Doc entries — keys owned elsewhere, listed so Help shows the full map ──
  // (Replace with fn entries as their handlers migrate into the registry.)

  { label: 'A  or  Ctrl+I', group: 'Table (window-capture)', scope: 'T', dev: true,
    impl: 'core.js window-capture (dev0538) + rowPreviewOpen',
    desc: 'Toggle the floating preview of the focused row (Space = play/pause)' },

  { label: 'Ctrl+D', group: 'Table (window-capture)', scope: 'T', dev: true,
    impl: 'core.js window-capture (dev0352)',
    desc: 'Duplicate the focused row' },

  { label: 'Alt+R', group: 'Table (window-capture)', scope: 'T', dev: true,
    impl: 'core.js window-capture (dev0352)',
    desc: 'Re-sort by DateModified — newest rows to the top' },

  { label: 'Shift+F', group: 'Table (window-capture)', scope: 'T', dev: true,
    impl: 'core.js window-capture',
    desc: 'Clear all filters instantly' },

  { label: 'R', group: 'Table (window-capture)', scope: 'T', dev: true,
    impl: 'core.js table-level handler',
    desc: 'Slideshow — Review mode (local-media triage)' },

  { label: 'Q', group: 'Table (window-capture)', scope: 'T', dev: true,
    impl: 'core.js table-level handler (dev0305)',
    desc: 'Open the Q local-media table (q.html, new tab)' },

  { label: '2 / 3 / 4 / 5', group: 'Grid (window-capture)', scope: 'G', dev: false,
    impl: 'core.js window-capture (zip0153)',
    desc: 'Resize grid to 2×2 / 3×3 / 4×4 / 5×5 (locked while a C-source 17/19/portrait layout is active)' },

  { label: '1–9', group: 'Grid (window-capture)', scope: 'G', dev: false,
    impl: 'core.js window-capture (dev0387)',
    desc: 'While a moving-cells mode is active: pick the variant' },

  { label: 'Shift+C', group: 'Grid (window-capture)', scope: 'G', dev: false,
    impl: 'core.js window-capture (dev0376)',
    desc: 'Toggle closed captions on all YT/Vimeo grid cells' },

  { label: 'Ctrl+V', group: 'Grid', scope: 'G', dev: true,
    impl: 'collection.js _gridPasteSource (dev0548)',
    desc: 'Over a hovered cell: paste the clipboard URL into the row’s linkpage (the source page found via g’s reverse-image search), clearing its “noLinkpageYet” marker. The bottom-left pill counts how many rows still need a source.' },

  { label: 'F', group: 'Grid (window-capture)', scope: 'G', dev: false,
    impl: 'core.js window-capture (dev0460)',
    desc: 'Toggle FallCells (perimeter waterfall conveyor)' },

  { label: 'S', group: 'Grid (window-capture)', scope: 'G', dev: false,
    impl: 'core.js window-capture (dev0516)',
    desc: 'Play the grid as a slideshow' },

  { label: 'Esc', group: 'Everywhere', scope: 'global', dev: false,
    impl: 'core.js window-capture + per-screen handlers',
    desc: 'Defocus text / deselect row; steps back Xs→Xe→T and closes V/Ie/Ev (never closes T)' },

  { label: '0', group: 'Everywhere', scope: 'global', dev: false,
    impl: 'core.js window-capture (dev0570) → boot.js _toggleFullscreen',
    desc: 'Toggle browser fullscreen (the F11 equivalent) — works from any screen' },

  // ── Gestures — swipe / mouse idioms (no fn; documented, not dispatched) ────
  // helpSection:'Gestures' renders these as their own Help sub-section. Because
  // that name has no "hotkey" in it, the Hum mobile filter keeps the swipe/tap
  // rows and drops the Shift/Ctrl/Alt/R-click rows on its own.
  { label: 'Swipe → on a cell', group: 'Gestures', scope: 'G', dev: false, helpSection: 'Gestures',
    impl: 'grid.js pointer swipe',
    desc: 'Open that cell fullscreen — V (video) / Ie (image) / Xs (slide) / Q (quiz)' },

  { label: 'Swipe ← on a cell', group: 'Gestures', scope: 'G', dev: false, helpSection: 'Gestures',
    impl: 'grid.js pointer swipe',
    desc: 'Toggle that cell’s video play/pause' },

  { label: 'Swipe ← in a viewer', group: 'Gestures', scope: 'V/Ie/Xs/Q', dev: false, helpSection: 'Gestures',
    impl: 'vp.js / viewer swipe-back',
    desc: 'Close the fullscreen viewer and return to the Grid' },

  { label: 'Shift-hold LMB / RMB', group: 'Gestures', scope: 'G', dev: true, helpSection: 'Gestures',
    impl: 'grid.js wireMouseV (dev0364)',
    desc: 'Zoom the hovered cell in (left) / out (right); Ctrl+Shift+LMB also zooms out (Firefox-safe)' },

  { label: 'Shift+drag on a cell', group: 'Gestures', scope: 'G', dev: true, helpSection: 'Gestures',
    impl: 'grid.js _gridCellPan (dev0364)',
    desc: 'Pan the zoomed cell content (transient — not saved)' },

  { label: 'Alt+click a cell', group: 'Gestures', scope: 'G', dev: true, helpSection: 'Gestures',
    impl: 'grid.js COI persist (dev0364)',
    desc: 'Save the current zoom/pan framing (COI) onto that row' },

  { label: 'Ctrl+click a cell', group: 'Gestures', scope: 'G', dev: true, helpSection: 'Gestures',
    impl: 'grid.js',
    desc: 'Open the Editor (Ev / Ie) for that cell' },

  { label: 'Hold a cell, click another', group: 'Gestures', scope: 'G', dev: true, helpSection: 'Gestures',
    impl: 'grid.js cut/swap',
    desc: 'Cut a cell, then swap it with the next cell you click' },

  { label: 'R-click in V', group: 'Gestures', scope: 'V', dev: true, helpSection: 'Gestures',
    impl: 'vp.js floating step button (dev0410)',
    desc: 'Open the floating step-button panel (frame nudge, free-run wheel, ping-pong/loop); right-click again closes it. '
      + 'Wheel the rate box down to 0 = freeze frame; wheel the frames box down to 0 = hold the start frame (dev0555)' },

  { label: 'Swipe → / ← title bar', group: 'Gestures', scope: 'Xe', dev: true, helpSection: 'Gestures',
    impl: 'xe.js title-bar swipe',
    desc: 'Auto-save, then preview the slide (→) or close back to the Table (←)' },

  { label: 'Shift+click down a column', group: 'Gestures', scope: 'T', dev: true, helpSection: 'Gestures',
    impl: 'core.js range select',
    desc: 'Range-select rows in that column, then bulk-set one value across all of them' },

  // ── Menus — hamburger + right-click context menus (no fn) ──────────────────
  { label: '☰ button (top-left)', group: 'Menus', scope: 'global', dev: false, helpSection: 'Menus',
    impl: 'boot.js _showShareableMenu',
    desc: 'Open the home menu — greeting, Search, saved views & Collections (the shareable landing page; this replaced the old M key)' },

  { label: 'R-click a grid cell', group: 'Menus', scope: 'G', dev: true, helpSection: 'Menus',
    impl: 'grid.js context menu',
    desc: 'Cell context menu — T / V / E / D actions for that row' },

  { label: 'R-click a tag chip', group: 'Menus', scope: 'T/A', dev: true, helpSection: 'Menus',
    impl: 'tags.js chip menu',
    desc: 'Tag menu — Copy tag / open Dictionary / Filter by tag / Remove from row' },

  { label: 'R-click a tag cell', group: 'Menus', scope: 'T', dev: true, helpSection: 'Menus',
    impl: 'core.js',
    desc: 'Paste the copied tag onto this row (when one is on the clipboard)' },

  { label: 'R-click a Dictionary node', group: 'Menus', scope: 'D', dev: true, helpSection: 'Menus',
    impl: 'dictionary context menu',
    desc: 'Node menu — Cut / Paste / Delete / GBIF lookup' },

  { label: 'R-click a segment tab', group: 'Menus', scope: 'Ev', dev: true, helpSection: 'Menus',
    impl: 'video.js',
    desc: 'Rename / relabel that video segment' },
];

// ── DISPATCHER ────────────────────────────────────────────────────────────────
// Called by core.js's window-capture listener for bare-letter keys. Preamble
// order is verbatim from the old vp.js chain: preview/tag-editor teardown →
// Xe auto-save → user-mode block → staging-screen toggles → registry lookup.
window._executeHotkey = function(key) {
  // (dev0330/0332) Leaving T for any screen → hide the focused-row preview pane
  // (rowPreviewHide REMEMBERS the pane; returning to T re-shows it).
  if (window.rowPreviewHide) window.rowPreviewHide();
  // (dev0540) Leaving T also dismisses the inline tag-editor popup.
  if (window._tCloseTagEditor) window._tCloseTagEditor();

  const ctx = _hkCtx();

  // (zip0183) TGAD hotkeys work from Xe (text editor) even when the overlay is
  // focused (editor blurred). Auto-save and close Xe first, then dispatch. Keys
  // Xe owns exclusively (S, ArrowUp/Down, Esc) never reach here — xe.js's
  // capture-phase listener intercepts them first.
  if (ctx.teOpen && (key === 't' || key === 'g' || key === 'a' || key === 'd' || key === 'm')) {
    if (typeof _textEditorDoSave === 'function') _textEditorDoSave();
    if (typeof textEditorClose === 'function') textEditorClose();
    ctx.teOpen = false;
  }

  // (zip0141/dev0315) User mode: block keys that lead to dev-only screens.
  const userMode = (typeof _isUserMode === 'function') ? _isUserMode() : false;
  if (userMode && HK_USER_BLOCKED.includes(key)) return;

  // Staging screens (I/St/O/X): own key toggles; any other key closes them
  // first, then falls through. Same order + semantics as the old chain.
  for (const s of HK_STAGING) {
    if (key === s.key) {
      if (s.isOpen()) { s.close(); return; }
      _hkTeardownForStaging(ctx);
      s.open();
      return;
    }
    if (s.isOpen()) s.close();
  }

  // Registry lookup for everything else.
  const entry = window.HOTKEYS.find(h => h.key === key && typeof h.fn === 'function');
  if (entry) entry.fn(ctx);
};

// ── HELP INTEGRATION ─────────────────────────────────────────────────────────
// Builds the HELP_DATA-shaped "Global" section rendered by Hd/Hu/Hum and the
// ⬇ Download export (core.js swaps it in for the static GLOBAL entry via
// _helpData()). Because the rows come straight from the registry — and the
// dev/user marking from HK_USER_BLOCKED — this panel cannot drift from the
// dispatcher's actual behavior.
window._hotkeysHelpSection = function() {
  const fnItems = [];
  window.HOTKEYS.forEach(h => {
    if (typeof h.fn !== 'function' || !h.label || !h.desc) return; // 'w' rides the 'W or L' row
    fnItems.push({ key: h.label, desc: h.desc, dev: HK_USER_BLOCKED.includes(h.key) });
  });
  // Doc entries (no fn) are bucketed into named Help sub-sections via their
  // `helpSection` field — default 'Screen-gated hotkeys' for the window-capture
  // keys, plus 'Gestures' and 'Menus'. Order follows first appearance in the
  // registry. Splitting them out means the Hum mobile filter (which keys off the
  // section name) keeps the swipe/tap/button rows and drops the modifier/r-click
  // rows without any per-entry flag.
  const docSections = [];
  window.HOTKEYS.forEach(h => {
    if (typeof h.fn === 'function' || !h.label || !h.desc) return;
    const name = h.helpSection || 'Screen-gated hotkeys';
    let sec = docSections.find(s => s.name === name);
    if (!sec) { sec = { name: name, items: [] }; docSections.push(sec); }
    sec.items.push({
      key: h.label + (h.scope && h.scope !== 'global' ? '  (' + h.scope + ')' : ''),
      desc: h.desc,
      dev: !!h.dev,
    });
  });
  return {
    id: 'GLOBAL', title: 'Global — works from any screen', devOnly: false,
    desc: 'Rendered live from the hotkey registry (hotkeys.js) — this list cannot drift from the code. '
        + 'Single-letter hotkeys fire when no input/editable has focus. '
        + 'The gestures + menus below are documented here too, but each stays owned by its own screen.',
    sections: [
      { name: 'Hotkeys', items: fnItems },
      ...docSections,
    ],
  };
};
