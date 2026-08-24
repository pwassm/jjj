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
// and must never fire on the public site. G/C/H stay accessible — those are the
// user's home/config/help surfaces.
// (dev0708) 'v' JOINS THE LIST, and for a different reason than the rest — it
// does not lead to a dev-only screen, it leads to the WRONG ITEM. From the grid
// the handler below takes _lastGridRow, and in Gu a viewer who has not yet
// touched a cell has no such row; it then falls through to window._lastUID, a
// leftover from some earlier grid or session. So v in Gu played a video with no
// relation to what was on screen (user report). V the SCREEN is unaffected and
// still reachable the way a viewer actually reaches it — the swipe, or tapping a
// cell — this only makes the bare KEY inert there. Because the help derives its
// dev/user marking from this list, the V row also leaves the Gu panel.
// (dev0711) 'l' left this list with its registry entry: nothing dispatches the
// letter any more (core.js claims it on the grid and forwards it nowhere else),
// so blocking it here would be guarding a door that no longer exists.
const HK_USER_BLOCKED = ['t', 'e', 'a', 'd', 'm', 'w', 'f', 'i', 's', 'o', 'x', 'v'];
// (dev0702) helpfloat.js's floating panel marks its "global" rows dev/user from
// this same list, so its marking can't drift from the dispatcher's either.
window.HK_USER_BLOCKED = HK_USER_BLOCKED;

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
  // (dev0837) St moved to SHIFT+S. `shift: true` keeps it out of the bare-letter
  // toggle below — the dispatcher only ever sees a lowercased key, so a bare s can
  // no longer open it — while leaving it in this list so every OTHER nav key still
  // closes it on the way past. ⇧S reaches it through window._hkStagingToggle,
  // claimed in core.js's window-capture handler (bare s stays the grid slideshow).
  { key: 's', shift: true, isOpen: () => (typeof window.isStScreenOpen === 'function') && window.isStScreenOpen(),
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

  { key: 's', label: 'Shift+S', group: 'Screens', scope: 'global',
    desc: '(dev0837) Toggle the St (bulk staging) screen — the s.json link catalogue. Moved off bare s, which now means only the slideshow (on the Grid) and nothing at all elsewhere.',
    fn(ctx) { /* handled via window._hkStagingToggle, claimed in core.js */ } },

  { key: 'o', label: 'O', group: 'Screens', scope: 'global',
    desc: 'Toggle the O (org-review) screen — Orgzly notes in o.json',
    fn(ctx) { /* handled via HK_STAGING in the dispatcher */ } },

  { key: 'x', label: 'X', group: 'Screens', scope: 'global',
    desc: 'Toggle the X (search-results) screen — finder hits in x.json',
    fn(ctx) { /* handled via HK_STAGING in the dispatcher */ } },

  { key: 't', label: 'T', group: 'Screens', scope: 'global',
    desc: 'Return to the Table (saves an open E screen first). On the grid this is the constantly-used way back; only while FUN MODE is on does t mean turnaround instead (dev0837).',
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
    desc: 'Open the Grid — from a fullscreen page (V/Ie/Xs/Q) it closes that page and drops you back on the Grid. In the Grid itself G opens the hovered cell’s SOURCE PAGE instead (its linkpage, or the link itself for YouTube/Vimeo/IG/articles; for a raw image with no source page, either mode opens a Google Lens reverse-image search; a raw video gets a toast).',
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
    desc: 'Open the Editor for the focused row — video → Ev, ftext → Xe, image → Ie; ttxt/ctxt/ss/pres column focus edits THAT field',
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
      // (dev0644) C's `pres` (instructional presentation deck) too.
      if (!ctx.gridOpen && focus !== null && typeof visCols === 'function') {
        const _fcol = visCols()[focus.c];
        if (_fcol === 'ttxt' || _fcol === 'ctxt' || _fcol === 'ss' || _fcol === 'pres') {
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

  { key: 'h', label: 'H  /  ⇧H', group: 'Screens', scope: 'global',
    desc: 'Toggle the floating CONTEXT help — the keys and gestures of THIS window only, with the context-sensitive ones (◆) marked live. ⇧H opens this full reference instead.',
    fn(ctx) {
      // (dev0702) helpfloat.js owns `h` outright: its window-capture listener is
      // registered first (helpfloat.js leads the script list in index.html) and
      // stopImmediatePropagation()s, so core.js never reaches this dispatcher for
      // h. That is what lets H work on Ev / Xe / D / Slideshow, which core.js
      // bails out of before dispatching. This fn is the FALLBACK for a load where
      // helpfloat.js is missing — it keeps the old full-reference behaviour.
      if (typeof window.hpToggle === 'function') { window.hpToggle(); return; }
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

  // (dev0711) The old bare-`l` clipboard-import entry is GONE. It called exactly
  // the same wantLinks() behind exactly the same guards as `w` — a duplicate
  // alias, not a second feature — and it was standing on the letter `l` (cLean)
  // wanted for the grid. `w` is the import key everywhere now; `l` is the grid's
  // clean-view toggle (core.js window-capture → _gridToggleClean) and nothing at
  // all on T or any other screen.
  { key: 'w', label: 'W', group: 'Import & filter', scope: 'global',
    desc: 'Smart clipboard import — bare media links, or @channel + CSV. The Table and the Ig screen only, since those are where there is a row to import into. (dev0838) On the GRID the letter never even reaches here: core.js swallows a bare w there, and gives it to the waterfall while fun mode is on.',
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

  { label: 'Shift+T', group: 'Table (window-capture)', scope: 'T', dev: true,
    impl: 'core.js window-capture (dev0580) + tInsertTextRowAboveCellA',
    desc: 'Insert a new empty text row (ltype t, UID <1a-row>_t) at grid cell 1a — bumps every assigned cell one slot (5e falls off) and switches to the 5×5/25 grid' },

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
    impl: 'core.js window-capture (dev0376/0704)',
    desc: 'Toggle closed captions on all YT/Vimeo grid cells. (dev0704) USER MODE SWAPS THE PAIR on the grid: there bare c toggles the captions (zoom level 1 to see them) and Shift+C opens the grid picker. Dev is unchanged.' },

  { label: 'L', group: 'Grid (window-capture)', scope: 'G', dev: false,
    impl: 'core.js window-capture (dev0710) → grid.js _gridToggleClean',
    desc: 'cLean view — hides every piece of chrome the app paints over the pictures: the per-cell labels (1a, 1b …), the top-left info line, the floating ← back arrow and (dev0721) the bottom-right button strip (grid name / T / C / TM) plus the UID and version badges. Nothing stops working; L again restores them. Persisted in localStorage (slam-grid-clean). Grid overlay only — (dev0711) bare l means NOTHING on any other screen now (its old clipboard-import alias of w was retired), and in a full-screen cell V keeps it (save loop).' },

  { label: 'Ctrl+V', group: 'Grid', scope: 'G', dev: true,
    impl: 'collection.js _gridPasteSource (dev0548)',
    desc: 'Over a hovered cell: paste the clipboard URL into the row’s linkpage (the source page found via g’s reverse-image search), clearing its “noLinkpageYet” marker. The bottom-left pill counts how many rows still need a source.' },

  { label: 'F', group: 'Grid (window-capture)', scope: 'G', dev: false,
    impl: 'core.js window-capture (dev0460/0705) → collection.js _gmFunKey',
    desc: 'F is FUN, and (dev0837) nothing but the DOOR. Out of fun mode it raises the FUN MODES window: the three modes on one letter each (W = waterfall, R = ring, T = turnaround), the ring’s variant numbers (1 = cascade, 2 = swap), the { } speed keys and — the part that was documented nowhere — what a CLICK on a cell does in each mode. In fun mode it LEAVES, silently: every engine stops and the card goes. It is no longer also the waterfall toggle (the old F,F), which made one key mean two things at once — w owns the waterfall now. A floating ✕ under cell 5c does the same job for anyone without a keyboard. Esc only hides the card and leaves whatever is running alone.' },

  { label: 'W  /  R  /  T  (in fun mode)', group: 'Grid (window-capture)', scope: 'G', dev: false,
    impl: 'core.js window-capture (dev0837) → collection.js _gmChoiceKey',
    desc: 'The three fun modes, one letter each, claimed ONLY while fun mode is on — f has raised the card, or something is already running. W = waterfall, R = ring, T = turnaround; each pressed again stops its own mode and puts the chooser back. OUTSIDE fun mode: t goes back to the Table (dev0836 briefly gave bare t to turnaround; dev0837 reverts that — t→Table from the grid is used constantly), and (dev0838) bare w does NOTHING here at all, swallowed rather than forwarded to the clipboard import, which belongs to the Table and the Ig screen where there is a row to import into. R is the exception — it has started the ring cold since dev0374 and still does. TURNAROUND itself: click any cell and it turns over on its LONG midline (a landscape cell about its horizontal one, a portrait cell about its vertical one) to show the back — the row’s tag chips in the top half, one per line with the longest chip sized to span the card, and the first five lines of its ftext below. Click again and it turns back, a video resuming from exactly the frame it stopped on. (dev0839) The picture turns at a STEADY angular rate and at full brightness, against a black-grey backdrop laid over the cell’s slot for the duration — a dimming pass over the media was tried and removed, because opacity reads faster than foreshortening and every version of it looked like the picture fading out rather than turning. A box floats under cell 5c with the spin number (1-20, default 5): a turn lasts 2/n seconds — the default 5 gives 0.4s, 1 is the slowest at two full seconds — and the value is remembered for next time.' },

  { label: 'S', group: 'Grid (window-capture)', scope: 'G', dev: false,
    impl: 'core.js window-capture (dev0516)',
    desc: 'Play the grid as a slideshow' },

  { label: 'B', group: 'Grid (window-capture)', scope: 'G', dev: false,
    impl: 'core.js window-capture (dev0638/0673/0674) → grid.js gridBufferScopeCycle',
    desc: 'First press raises the sticky CLEAN PLAYBACK panel (bottom-left; Esc closes it) showing mode, scope, pre-roll, adaptive and the measured spin-up. While it is up, b cycles how far buffered playback reaches: NORMAL (desktop squares ≤4×4) → WIDE (plus the 17/19 layouts — the default since dev0673) → ALL (every size & device; 2 players per cell, so 27 cells = 54) → NONE (hard off). Anything outside the scope falls back to the single-iframe mount and shows YT’s center play/pause chrome. Ctrl+B still cycles the buffer MODE (off/cut/fade); ?buf=normal|wide|all|0 sets the scope for one load.' },

  { label: 'Shift+B', group: 'Grid (window-capture)', scope: 'G', dev: false,
    impl: 'core.js window-capture (dev0673) → grid.js gridBufferAdapt',
    desc: 'Raises the same CLEAN PLAYBACK panel; while it is up, toggles adaptive per-segment pre-roll (default ON). Each segment warms its hidden layer for min(global pre-roll, its own duration ÷ 2.5) rather than one flat value, floored at 0.8s and never more than half a segment. (dev0674) It also measures each cell’s real seek→playing latency and uses that as the floor, climbing 25% after any reveal it had to show dirty and relaxing on clean laps — so a slow cell tunes itself up without you pressing anything.' },

  { label: '[  /  ]', group: 'Grid', scope: 'G', dev: true,
    impl: 'collection.js (dev0346/0674)',
    desc: 'Whole-grid zoom ±0.1 — EXCEPT while the CLEAN PLAYBACK panel is open (b), where they become buffer pre-roll ∓0.5s with the panel as the live readout. − / + always adjust the pre-roll regardless of the panel. Ctrl+[ / Ctrl+] zoom just the hovered cell either way.' },

  { label: 'Z', group: 'Viewer', scope: 'V', dev: false,
    impl: 'vp.js vpKeyHandler (dev0672) → _vpEmbedZoomArm',
    desc: 'On an IG/TikTok post in V: arm/disarm the ⤢ zoom (same as the toolbar button). Armed = hold to enlarge, drag to pan, double-click for usual size; disarm to hand the picture back to the player. Inert on any other kind of row, where Z still rotates a visible crop frame.' },

  { label: 'Q  /  Shift+Q', group: 'Grid (window-capture)', scope: 'G', dev: false,
    impl: 'core.js window-capture (dev0669/0671) → grid.js gridNewEmbed',
    desc: 'New embed — reload the hovered IG/TikTok cell (Shift+Q: every embed on the grid) so it can play in the cell again. Those embeds allow ONE inline play each; after it the caret only offers to open the post on their site. Mostly a manual override now: since dev0671 a played cell re-primes itself once its clip has run. Also on the cell’s right-click menu and the ↻ chip on an armed cell.' },

  { label: 'Esc', group: 'Everywhere', scope: 'global', dev: false,
    impl: 'core.js window-capture + per-screen handlers',
    desc: 'Defocus text / deselect row; steps back Xs→Xe→T and closes V/Ie/Ev (never closes T)' },

  { label: '0', group: 'Everywhere', scope: 'global', dev: false,
    impl: 'core.js window-capture (dev0570) → boot.js _toggleFullscreen',
    // (dev0703) Don't call it "the F11 key": F11 is the WINDOWS browser
    // shortcut. On a Mac the browser's own fullscreen is Ctrl+⌘+F (and ⌘+Ctrl+F
    // in Safari), so `0` is the one binding that means the same thing on both.
    desc: 'Toggle browser fullscreen from any screen — the app’s own key for it (the browser’s equivalent is F11 on Windows, Ctrl+⌘+F on a Mac)' },

  { label: 'Ctrl+.', group: 'Everywhere', scope: 'global', dev: true,
    impl: 'screenrec.js window-capture (dev0723) → /rec/start · getDisplayMedia',
    desc: 'SCREEN RECORDER — press once to go full-window (if it isn’t already) and start recording the whole screen, mouse pointer and all, with no sound; press again to stop. Saves Downloads/ScreenRecording_<date-time>.mp4 at a modest 1280-wide / 20fps, so a few minutes of demo is a few MB. A small red dot in the top-right corner says it is running (clicking it stops too). It records through proxy.js — ffmpeg gdigrab, no dialog — and only if that is not running does it fall back to the browser’s own capture, which asks you to pick a screen first. Dev mode only.' },

  // ── Gestures — swipe / mouse idioms (no fn; documented, not dispatched) ────
  // helpSection:'Gestures' renders these as their own Help sub-section. Because
  // that name has no "hotkey" in it, the Hum mobile filter keeps the swipe/tap
  // rows and drops the Shift/Ctrl/Alt/R-click rows on its own.
  { label: 'Swipe → on a cell', group: 'Gestures', scope: 'G', dev: false, helpSection: 'Gestures',
    impl: 'grid.js pointer swipe',
    desc: 'Open that cell fullscreen — V (video) / Ie (image) / Xs (slide) / Q (quiz)' },

  { label: 'Swipe ← within a cell', group: 'Gestures', scope: 'G', dev: false, helpSection: 'Gestures',
    impl: 'grid.js pointer swipe',
    desc: 'Toggle that cell’s video play/pause — the swipe has to start and end inside the SAME cell. On the sectioned 1a lesson cell it advances a section instead.' },

  // (dev0703) The user-mode escape hatch, undocumented until now — and the one
  // gesture a Gu viewer cannot do without, since Gu hides the ☰ / Configs chrome.
  { label: 'Swipe ← across a border', group: 'Gestures', scope: 'G', dev: false, helpSection: 'Gestures',
    impl: 'grid.js gridShow overlay pointer handler (dev0369/0699) → _returnToMenuFromGrid',
    desc: 'Gu only — leave the Grid for the Main Page you came from. The swipe must START in one cell and END in a different one (or off the grid); one that stays inside a cell just pauses that cell. Esc does the same. In DEV mode this is deliberately off — there the same drag is how you pause a cell, and a swipe that drifted a few px past the edge used to throw the whole grid away.' },

  // (dev0703) THE app-wide swipe rule. Stated once here; helpfloat.js renders it
  // per screen with the live branch marked. Implemented by vp.js _vpHorizSwipe
  // and slideshow.js _slideshowHorizSwipe, which are twins on purpose.
  // Scope stops at the fullscreen pages: on G the back gesture is the
  // cross-a-border swipe above, and Cu states its own. helpfloat.js's per-screen
  // ◆ row supersedes this one in the floating panel; it stays here so the FULL
  // reference carries the rule in one sentence.
  { label: 'Swipe ←  (the back gesture)', group: 'Gestures', scope: 'V/Ie/Xs/Q/SS', dev: false, helpSection: 'Gestures',
    impl: 'vp.js _vpHorizSwipe + slideshow.js _slideshowHorizSwipe (dev0703)',
    desc: 'PREVIOUS VIEW, everywhere: closes the viewer / the slideshow / the grid-choice list and hands you back the screen you came from. The one exception is a zoomed picture, where a drag pans instead — double-click to reset the zoom and the gesture comes back.' },

  // (dev0711) The visible twin of the rule above. Same destination, drawn rather
  // than hidden — a phone has no Esc key and a swipe is invisible until someone
  // tells you it exists.
  { label: '← button (left edge)', group: 'Gestures', scope: 'G/V/Ie/Xs/Q/SS/Cu/T/C/A', dev: false, helpSection: 'Gestures',
    impl: 'backarrow.js #salBackArrow (dev0711)',
    desc: 'PREVIOUS VIEW — the round ← at the middle of the left edge does exactly what Esc and the back swipe do. User mode only, and not on the home menu (nothing is behind it) or in a presentation (PM draws its own ‹ › and ✕). On the grid, L hides it with the rest of the chrome.' },

  { label: '⇧ Swipe ←  /  ⇧ Swipe →', group: 'Gestures', scope: 'SS/V/Xs', dev: false, helpSection: 'Gestures',
    impl: 'vp.js _vpHorizSwipe + slideshow.js _slideshowHorizSwipe (dev0703)',
    desc: 'PREVIOUS / NEXT slide, inside a slideshow (SS) or a presentation deck (PM). Holding Shift is what says “move within this show” rather than “leave it”. Plain swipe → is the same as ⇧ swipe → (next slide), so a phone — which has no Shift key — can still page forward.' },

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

  { label: 'Swipe → title bar / FAST swipe ← anywhere', group: 'Gestures', scope: 'Xe', dev: true, helpSection: 'Gestures',
    impl: 'xe.js swipe + flick',
    desc: 'Auto-save, then preview the slide (→ on title bar) or leave Xe (fast ← anywhere → back to Grid/T; slow ← drag still selects text)' },

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
    if (key === s.key && !s.shift) {
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

// (dev0837) Toggle a SHIFT-keyed staging screen. Same three steps the bare-letter
// branch above runs — user-mode gate, tear down whatever is showing, open — so ⇧S
// behaves exactly as bare s did, rather than a second half-copy of the logic.
window._hkStagingToggle = function(key) {
  const userMode = (typeof _isUserMode === 'function') ? _isUserMode() : false;
  if (userMode && HK_USER_BLOCKED.includes(key)) return;
  const item = HK_STAGING.find(s => s.key === key);
  if (!item) return;
  if (item.isOpen()) { item.close(); return; }
  const ctx = _hkCtx();
  _hkTeardownForStaging(ctx);
  item.open();
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
