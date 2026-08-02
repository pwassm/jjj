// ══════════════════════════════════════════════════════════════════════════════
// helpfloat.js — H = FLOATING CONTEXT HELP + BALLOON TOOLTIPS (dev0702/0703)
//
// Two features, one file, both live on slam.com (sealifeandmore.com) AND on
// localhost — there is no host gate: the panel reads the SCREEN, not the URL.
//
//  1. Hf — the floating help strip (`H`, or ✕ / Esc / H to close).
//     (dev0703) A full-width band across the TOP of the screen, split into three
//     columns so nothing has to scroll:
//       1  ⌨ HOTKEYS — this screen
//       2  👆 MOUSE / SWIPE — this screen
//       3  🌐 GLOBAL KEYS that actually reach the dispatcher FROM this screen
//     Column 3 is filtered, not a dump: core.js's window-capture listener bails
//     out entirely for Ev / Xe / D / Slideshow / Menu, and several global keys
//     no-op while the grid or a viewer is up. Promising a key that is swallowed
//     before it arrives is exactly the kind of drift this panel exists to kill.
//
//     Rows whose meaning CHANGES with live state carry a ◆ badge and list their
//     variants underneath, with the one that is active RIGHT NOW marked "now ▸"
//     in green — the answer to "← / → are different while V is playing" and
//     "swipe is different when you're zoomed in". Re-checked every 700 ms.
//     Shift+H opens the FULL reference (the old Hd/Hu modal) instead.
//
//     NO SCROLL BARS: hpFit() steps the base font down from 17px until the tall
//     est column fits the band. Only if it still overflows at the 9px floor does
//     the body get a scrollbar — clipping the text silently would be worse.
//
//  2. Balloons — hover (or touch-and-hold) any icon button and a styled balloon
//     names its function. Sources the text from the `title` the control already
//     carries (moved to data-tip on first hover so the slow native tooltip stops
//     competing), so every button that was already documented gets a balloon for
//     free and can't drift. Table cells / inputs are excluded — `td.title` is
//     full-cell-text, not a function name.
//
// ── WHERE THE CONTENT COMES FROM ─────────────────────────────────────────────
// Nothing here re-types a hotkey list. Three live sources, merged per screen:
//   • window.HOTKEYS      (hotkeys.js registry) — entries whose `scope` names
//                          this screen, plus the global fn entries.
//   • window._helpData()  (core.js HELP_DATA)  — the per-screen section whose
//                          `id` matches this screen code.
//   • HP_EXTRA (below)    — only the screens neither source covers (I/St/O/X,
//                          Slideshow, Menu). Everything else stays derived.
// So the panel inherits every future edit to those two tables automatically.
//
// ── KEY OWNERSHIP ────────────────────────────────────────────────────────────
// This file is loaded FIRST (see the files[] list in index.html) so its
// window-capture keydown listener registers before core.js's and therefore runs
// first. It claims `h` with stopImmediatePropagation() — which also stops
// core.js's listener on the same node, so the old `h` → openHelp() path can no
// longer double-fire. That is what lets H work on Ev / Xe / D / Slideshow, all
// of which core.js deliberately bails out of before reaching its dispatcher.
// The hamburger panel keeps its own `h` (bail below) and hotkeys.js keeps a
// fallback fn entry for the case where this file failed to load.
// ══════════════════════════════════════════════════════════════════════════════

(function () {
'use strict';

var PANEL_ID = 'hpPanel';
var TIP_ID   = 'hpTip';
var LS_GLOB  = 'slam-hp-global';

function $id(id) { return document.getElementById(id); }
function flexOpen(id) { var e = $id(id); return !!e && e.style.display === 'flex'; }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// Every cross-file probe below reads a binding owned by another script (some are
// top-level `let`, which lives in the shared global lexical scope and is NOT on
// window). Bare references are correct; try/catch keeps a renamed or not-yet-
// loaded binding from taking the whole panel down.
function probe(fn, dflt) { try { var v = fn(); return v === undefined ? dflt : v; } catch (_) { return dflt; } }

// ─────────────────────────────────────────────────────────────────────────────
// SCREEN DETECTION
// Topmost overlay wins. Order mirrors the real stacking order, so the panel
// names the window that currently owns the keyboard.
// ─────────────────────────────────────────────────────────────────────────────
var HP_TITLES = {
  T:  'T — Table',                 G:  'G — Grid',
  C:  'C — Collection / Config',   Cu: 'Cu — Choose a grid',
  A:  'A — Annotate panel',        Ev: 'Ev — Video editor',
  Xe: 'Xe — Text editor (HTML)',   Xs: 'Xs — Slide, fullscreen',
  V:  'V — Video viewer',          Ie: 'Ie — Image viewer',
  Q:  'Q — Quiz',                  D:  'D — Dictionary',
  I:  'I — Instagram staging',     St: 'St — Bulk staging',
  O:  'O — Org review',            X:  'X — Search results',
  SS: 'SS — Slideshow',            Menu: 'Menu — home / greeting',
  H:  'H — Full reference'
};

function hpScreen() {
  if (flexOpen('helpModal'))            return 'H';
  if ($id('dictOverlay'))               return 'D';
  if ($id('teSlideOverlay'))            return 'Xs';
  if ($id('textEditorOverlay'))         return 'Xe';
  if ($id('video-editor-overlay'))      return 'Ev';
  // (dev0703) The user-mode 'c' is a floating picker over the grid, NOT the dev
  // C table — different screen, different gestures (boot.js _showMobileCPicker).
  if ($id('mobileCPicker'))             return 'Cu';
  // The fullscreen viewer is checked BEFORE the slideshow overlay on purpose: a
  // slideshow playing a video hands the keyboard to V, and V's arrows are what
  // the reader needs listed. The slideshow-ness survives as a context chip.
  if (flexOpen('gridFullscreen')) {
    if ($id('grid-fs-video')) return 'V';               // vp.js video branch
    if ($id('vp-html-topbar')) {                        // quiz / text share it
      var r = window._vpCurrentRow || null;
      var ft = r ? String(r.ftext || '').trim() : '';
      if (r && (r.qfile || ft.charAt(0) === '[' || ft.charAt(0) === '{')) return 'Q';
      return 'Xs';
    }
    return 'Ie';
  }
  if ($id('slideshowOverlay'))          return 'SS';
  if (probe(function () { return window.isIgScreenOpen && window.isIgScreenOpen(); })) return 'I';
  if (probe(function () { return window.isStScreenOpen && window.isStScreenOpen(); })) return 'St';
  if (probe(function () { return window.isOScreenOpen  && window.isOScreenOpen();  })) return 'O';
  if (probe(function () { return window.isXScreenOpen  && window.isXScreenOpen();  })) return 'X';
  if ($id('shareableMenu'))             return 'Menu';
  if (probe(function () { return _cMode; }, false)) return 'C';
  if (flexOpen('gridOverlay'))          return 'G';
  if (flexOpen('browseOverlay'))        return 'A';
  return 'T';
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE STATE PROBE — everything the context rules and the chips need.
// Read-only: nothing here may act (that is why the grid section probe reads the
// 1a cell's _salSect directly instead of calling _gridSectionKey, which PAGES).
// ─────────────────────────────────────────────────────────────────────────────
function hpZoom() {
  // The V host and the Ie image are magnified with a CSS transform whose scale
  // lives in a vp.js closure. Read it back off the computed matrix instead of
  // reaching into that closure — 1.0 means "not zoomed, swipe still closes".
  var fs = $id('gridFullscreen');
  if (!fs || fs.style.display !== 'flex') return 1;
  var els = [$id('grid-fs-video'), fs.querySelector('img')];
  var best = 1;
  for (var i = 0; i < els.length; i++) {
    if (!els[i]) continue;
    var t = '';
    try { t = getComputedStyle(els[i]).transform; } catch (_) {}
    if (!t || t === 'none') continue;
    var m = /matrix\(([^)]+)\)/.exec(t);
    if (!m) continue;
    var p = m[1].split(',').map(Number);
    var sc = Math.hypot(p[0], p[1]);
    if (isFinite(sc) && sc > best) best = sc;
  }
  return best;
}

function hpState() {
  var code = hpScreen();
  var s = {
    code: code,
    userMode: probe(function () { return !!(_isUserMode && _isUserMode()); }, false),
    // ── V / Ie ──
    video:      !!$id('grid-fs-video'),
    playing:    probe(function () { return !!(window._vpIsPlaying && window._vpIsPlaying()); }, false),
    paused:     probe(function () { return !!(window._vpIsPausedNow && window._vpIsPausedNow()); }, false),
    sectNav:    typeof window._vpSectNav === 'function',
    textReader: !!window._vpTextReader,
    slideshow:  !!$id('slideshowOverlay'),
    zoom:       hpZoom(),
    // ── SS ── (its zoom lives in a slideshow.js closure; the helper is global)
    ssZoom:  probe(function () { return !!(window._slideshowIsZoomed && window._slideshowIsZoomed()); }, false),
    ssPaused: probe(function () { return !!(_slideshowState && _slideshowState.paused); }, false),
    ssReview: probe(function () { return !!(_slideshowState && _slideshowState.mode === 'review'); }, false),
    // ── G ──
    gSect: probe(function () {
      var c = document.querySelector('#gridContainer .grid-cell[data-cell="1a"]');
      return !!(c && c._salSect && c._salSect.inner && c._salSect.inner.isConnected);
    }, false),
    bufPanel:  probe(function () { return !!(window._gridBufPanelOpen && window._gridBufPanelOpen()); }, false),
    gCut:      probe(function () { return !!_gridCutCell; }, false),
    fromMenu:  probe(function () { return window._smReturnPage >= 2 && window._smReturnPage <= 6; }, false),
    moving:    probe(function () { return !!(window._gmAnyMoving && window._gmAnyMoving()); }, false),
    gridSrc:   probe(function () { return _gridSource; }, 'T'),
    layout:    probe(function () { return _gridCurrentLayout ? _gridCurrentLayout() : 'square'; }, 'square'),
    cfgName:   probe(function () { return (_gridActiveConfig && _gridActiveConfig.gname) || ''; }, '')
  };
  s.layoutLocked = (s.layout !== 'square' && s.gridSrc === 'C');
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTEXT RULES — the ◆ rows.
// Each rule replaces the flat rows it shadows (`hide` lists their labels
// VERBATIM as HELP_DATA / the registry writes them — they go through the same
// normKey, so this can't drift from the normaliser) and renders its `variants`
// instead. Variants are evaluated TOP-DOWN and the first `on(s)` that is true
// becomes "now ▸", so the order must mirror the real handler's if-chain — that
// is the whole point: if the code re-orders its branches, this list moves too.
// ─────────────────────────────────────────────────────────────────────────────
var HP_CTX = [
  // ── V: the arrows. Mirrors vp.js vpKeyHandler (dev0286 / dev0644 / dev0701).
  { screens: ['V'], k: '←  /  →', kind: 'key',
    hide: ['← →'],
    d: 'Depends on what the page is doing right now:',
    variants: [
      { d: 'Page the lesson slide back / forward (deck page, video not paused)',
        on: function (s) { return s.sectNav && !s.paused; } },
      { d: 'Previous / next slideshow slide — closes V on the way',
        on: function (s) { return s.slideshow && s.playing; } },
      { d: 'Frame-step ±1/30 s (a playing video is paused first so the step shows)',
        on: function (s) { return s.video; } },
      { d: 'Nothing to step here (no video on this page)', on: function () { return true; } }
    ],
    note: 'Shift+← / → always frame-steps, even on a deck page that would otherwise page.' },

  // ── The app-wide back gesture (dev0703). Same rule in V/Ie/Q/Xs and in SS.
  { screens: ['V', 'Ie', 'Q', 'Xs'], k: 'Swipe ←', kind: 'gesture',
    hide: ['Swipe ← on image', 'Swipe ← in a viewer', 'Swipe ← (top bar)',
           'Swipe ← (from edge)', 'Swipe ←', 'Swipe ←  (the back gesture)'],
    d: 'The back gesture — depends on the zoom:',
    variants: [
      { d: 'PANS the zoomed picture — it cannot close while zoomed',
        on: function (s) { return s.zoom > 1.05; } },
      { d: 'Leaves the SLIDESHOW entirely, back to the screen it was launched from',
        on: function (s) { return s.slideshow; } },
      { d: 'Closes this page and returns to the Grid', on: function () { return true; } }
    ],
    note: 'Double-click (double-tap) resets the zoom to 1× and gives the gesture back. Esc and ✕ always close, zoomed or not.' },

  { screens: ['V', 'Xs', 'Q'], k: 'Swipe →   ⇧Swipe ← →', kind: 'gesture',
    hide: ['⇧ Swipe ←  /  ⇧ Swipe →'],
    d: 'Paging INSIDE a deck or a show:',
    variants: [
      { d: 'Deck (PM): → and ⇧→ = next section · ⇧← = previous section',
        on: function (s) { return s.sectNav; } },
      { d: 'Slideshow: → and ⇧→ = next slide · ⇧← = previous slide',
        on: function (s) { return s.slideshow; } },
      { d: 'Nothing to page on this one — it is a single item', on: function () { return true; } }
    ],
    note: 'Plain → does what ⇧→ does so a phone, which has no Shift key, can still move forward.' },

  { screens: ['SS'], k: 'Swipe ←', kind: 'gesture',
    hide: ['Swipe ←', 'Swipe ← / →', 'Swipe ←  (the back gesture)'],
    d: 'The back gesture — depends on the zoom:',
    variants: [
      { d: 'PANS the zoomed slide — it cannot leave while zoomed',
        on: function (s) { return s.ssZoom; } },
      { d: 'LEAVES the slideshow for the screen it was launched from',
        on: function () { return true; } }
    ],
    note: 'Double-click resets the zoom. Ctrl+swipe ← still exits too (kept from dev0595).' },

  { screens: ['SS'], k: 'Swipe →   ⇧Swipe ← →', kind: 'gesture',
    hide: ['⇧ Swipe ←  /  ⇧ Swipe →'],
    d: '→ and ⇧→ = next slide · ⇧← = previous slide.',
    variants: [
      { d: 'Zoomed — a drag pans instead; double-click to reset',
        on: function (s) { return s.ssZoom; } },
      { d: 'Live: paging the show', on: function () { return true; } }
    ],
    note: 'Plain → doubles for ⇧→ so a phone, which has no Shift key, can still move forward.' },

  // ── G: Esc steps back one thing at a time (collection.js). The global Esc row
  //    ("defocus / steps back Xs→Xe→T") is true elsewhere but says nothing about
  //    leaving the grid, which is the thing a Gu viewer most needs to know.
  { screens: ['G'], k: 'Esc', kind: 'key',
    hide: ['Esc'],
    d: 'Steps back one thing at a time:',
    variants: [
      { d: 'Dismiss the CLEAN PLAYBACK panel, stay on the grid', on: function (s) { return s.bufPanel; } },
      { d: 'Cancel the cut cell', on: function (s) { return s.gCut; } },
      { d: 'Leave the Grid for the Main Page you came from',
        on: function (s) { return s.userMode || s.fromMenu; } },
      { d: 'Close the Grid and return to the Table', on: function () { return true; } }
    ],
    note: 'In Gu this is the same result as swiping ← across a cell border.' },

  // ── G: the back gesture is mode-dependent, and Gu viewers depend on it —
  //    it and Esc are their only way off the grid (dev0369/0699).
  { screens: ['G'], k: 'Swipe ← across a border', kind: 'gesture',
    hide: ['Swipe ← across a border'],
    d: 'A swipe that STARTS in one cell and ENDS in another (or off the grid):',
    variants: [
      { d: 'Leaves the Grid for the Main Page you came from — same as Esc',
        on: function (s) { return s.userMode; } },
      { d: 'Nothing — in DEV the drag stays reserved for pausing a cell, so a swipe that drifts past the edge can’t throw the grid away. Use Esc.',
        on: function () { return true; } }
    ],
    note: 'A swipe that stays INSIDE one cell keeps its own meaning: pause/play that cell.' },

  // ── G: arrows only do something when a sectioned t cell is on the grid.
  { screens: ['G'], k: '←  /  →', kind: 'key',
    hide: ['← →'],
    d: 'Depends on the 1a cell:',
    variants: [
      { d: 'Page the sectioned lesson slide in cell 1a back / forward',
        on: function (s) { return s.gSect; } },
      { d: 'Inert — cell 1a is not a sectioned text slide', on: function () { return true; } }
    ],
    note: '↑ expands the t cell to the full-window reader; ↓ inside the reader comes back.' },

  // ── G: the bracket keys are shared between zoom and buffer pre-roll (dev0674).
  { screens: ['G'], k: '[  /  ]', kind: 'key',
    hide: ['[  /  ]'],
    d: 'Shared — the CLEAN PLAYBACK panel takes them while it is up:',
    variants: [
      { d: 'Buffer pre-roll ∓0.5 s — the panel is the live readout',
        on: function (s) { return s.bufPanel; } },
      { d: 'Whole-grid zoom ±0.1 (Ctrl+[ / Ctrl+] zoom just the hovered cell)',
        on: function () { return true; } }
    ],
    note: '− / + always adjust the pre-roll, panel or no panel. b raises the panel; Esc drops it.' },

  // ── G: digits.
  { screens: ['G'], k: '1 – 9', kind: 'key',
    hide: ['2 / 3 / 4 / 5', '1–9'],
    d: 'Depends on what the grid is running:',
    variants: [
      { d: 'Pick the moving-cells variant (a moving mode is running)',
        on: function (s) { return s.moving; } },
      { d: 'LOCKED — a C-source 17 / 19 / portrait layout is active; resize it on C',
        on: function (s) { return s.layoutLocked; } },
      { d: 'Resize: 2 → 2×2, 3 → 3×3, 4 → 4×4, 5 → 5×5 (1 and 6–9 do nothing)',
        on: function () { return true; } }
    ] },

  // ── Letters whose meaning flips between T and G. Listed on BOTH screens so
  //    neither reader has to guess which one they are holding.
  { screens: ['T', 'G'], k: 'A', kind: 'key',
    hide: ['A', 'A  or  Ctrl+I'],
    d: 'Same key, two jobs:',
    variants: [
      { d: 'Grid: toggle STEP-FRAME mode — cells with saved steps loop their clip',
        on: function (s) { return s.code === 'G'; } },
      { d: 'Table: toggle the floating preview of the focused row (= Ctrl+I)',
        on: function (s) { return s.code === 'T'; } }
    ] },

  { screens: ['T', 'G'], k: 'S', kind: 'key',
    hide: ['S'],
    d: 'Same key, two jobs:',
    variants: [
      { d: 'Grid: play the grid as a slideshow', on: function (s) { return s.code === 'G'; } },
      { d: 'Table: open the St bulk-staging screen (s.json)', on: function (s) { return s.code === 'T'; } }
    ] },

  { screens: ['T', 'G'], k: 'F', kind: 'key',
    hide: ['F'],
    d: 'Same key, two jobs:',
    variants: [
      { d: 'Grid: toggle FallCells (the perimeter waterfall conveyor)',
        on: function (s) { return s.code === 'G'; } },
      { d: 'Table: toggle the filter — tags ∧ text (⇧F clears every filter)',
        on: function (s) { return s.code === 'T'; } }
    ] },

  { screens: ['T', 'G'], k: 'G', kind: 'key',
    hide: ['G'],
    d: 'Same key, two jobs:',
    variants: [
      { d: 'Grid: open the hovered cell’s SOURCE PAGE in a new tab (its linkpage, or the link itself for YouTube / Vimeo / IG / articles)',
        on: function (s) { return s.code === 'G'; } },
      { d: 'Table: open the Grid', on: function (s) { return s.code === 'T'; } }
    ] }
];

// ─────────────────────────────────────────────────────────────────────────────
// HP_EXTRA — ONLY the screens HELP_DATA and the registry don't cover. Anything
// that exists in either of those two tables must NOT be duplicated here.
// ─────────────────────────────────────────────────────────────────────────────
var HP_EXTRA = {
  I: { desc: 'ig.json review — enrich / download / promote Instagram rows.',
    rows: [
      { k: '↑ / ↓',  d: 'Move the focused row' },
      { k: 'Enter',  d: 'Open the focused post' },
      { k: 'Space',  d: 'Select / deselect the focused row' },
      { k: 'f',      d: 'Focus the filter box  ·  ⇧F clears the text filter' },
      { k: 'd',      d: 'Download the selected rows' },
      { k: 'e',      d: 'Enrich the selected rows (cookieless /p OG-tag fetch)' },
      { k: 'c',      d: 'Clear the selection' },
      { k: 'r',      d: 'Reset the selected rows to “new” so they can be retried' },
      { k: 'a',      d: 'Toggle the auto-enrich panel' },
      { k: 'm',      d: 'Clear, then select the top 18' },
      { k: 'w',      d: 'Paste an IG URL from the clipboard as a new Unharvested single' },
      { k: '⇧N ⇧D ⇧E ⇧A', d: 'Status filter: new / downloaded / enriched / all' },
      { k: 'Ctrl+I', d: 'Toggle the floating preview' },
      { k: 't',      d: 'Leave — back to the Table (Esc no longer closes this screen)' }
    ] },
  St: { desc: 'Bulk staging over s.json — import links, fill metadata, promote the good ones into ml.json.',
    rows: [
      { k: '↑ / ↓',      d: 'Move the focused row' },
      { k: 'w',          d: 'Import links from the clipboard' },
      { k: 'a',          d: 'Add the focused row to ml.json (promote)' },
      { k: 'd / Delete', d: 'Delete the focused row (archived to sdeleted.json)' },
      { k: 'e',          d: 'Fill Res / Size / Len metadata' },
      { k: 'c',          d: 'Open the L1 / L2 bulk-category dialog' },
      { k: 'f',          d: 'Focus the search box  ·  ⇧F clears the filters' },
      { k: 'Ctrl+Z',     d: 'Undo the last Delete / Add' },
      { k: 'Ctrl+I',     d: 'Toggle the floating preview window' },
      { k: 'Esc / t',    d: 'Leave — back to the Table' }
    ] },
  O: { desc: 'Org-review over o.json — Orgzly notes imported by orgToO.js.',
    rows: [
      { k: '↑ / ↓',   d: 'Move the focused row' },
      { k: 'r',       d: 'Toggle the reading pane' },
      { k: 'f',       d: 'Focus the search box  ·  ⇧F clears EVERY filter, column boxes included' },
      { k: 'Delete',  d: 'Delete the focused record (archived)' },
      { k: 'Esc / t', d: 'Leave — back to the Table' }
    ] },
  X: { desc: 'Search-results review over x.json — hits from the linkfinders tools.',
    rows: [
      { k: '↑ / ↓',      d: 'Move the focused row' },
      { k: '← / →',      d: 'Seek the preview back / forward' },
      { k: 'w',          d: 'Import results from the clipboard' },
      { k: 'a',          d: 'Add the focused row to ml.json (promote)' },
      { k: 'd / Delete', d: 'Delete the focused row (archived to xdeleted.json)' },
      { k: 'e',          d: 'Fill Res / Size / Len metadata' },
      { k: 'c',          d: 'Open the Source / Query bulk dialog' },
      { k: 'f',          d: 'Focus the search box  ·  ⇧F clears the filters' },
      { k: 'Ctrl+↓',     d: 'PERMANENT delete → xdeleted.json (it will not come back on a re-run)' },
      { k: 'Ctrl+Z',     d: 'Undo the last Delete / Add' },
      { k: 'Esc / t',    d: 'Leave — back to the Table' }
    ] },
  // (dev0703) Space became pause/resume and the swipes now follow the app-wide
  // back rule — see _slideshowHorizSwipe. The ◆ swipe rows above cover gestures.
  SS: { desc: 'Slideshow / Review. Owns the keyboard outright — global hotkeys stand down while it is up.',
    rows: [
      { k: 'Space',   d: 'PAUSE / RESUME the show — while a VIDEO slide is up, V owns Space and it plays/pauses that video instead' },
      { k: '→ / ←',   d: 'Next / previous slide' },
      { k: '↑ / ↓',   d: 'Mark / un-mark this slide for deletion (Review triage)' },
      { k: 'a s d f', d: 'Review mode only: rate best / good / fair / poor, then move on' },
      { k: 'Esc',     d: 'Close the slideshow' },
      { k: 'Tap a slide',  d: 'Resume a paused show (otherwise aims the Ken Burns pan)', kind: 'gesture' },
      { k: 'Double-tap',   d: 'Close the slideshow', kind: 'gesture' },
      { k: 'Hold LMB',     d: 'Zoom in (pauses the show); drag to pan; double-click resets', kind: 'gesture' },
      { k: 'Swipe ↑ / ↓',  d: 'On a PAUSED unzoomed slide: switch between the original set and the row’s ftext images', kind: 'gesture' }
    ] },
  Menu: { desc: 'The shareable landing page — greeting, Search, saved views, Collections, My Loops.',
    rows: [
      { k: 'Tab',   d: 'Cycle the tabs' },
      { k: 'f',     d: 'Filter the list' },
      { k: 'Esc',   d: 'Close the menu' },
      { k: 'Tap a card', d: 'Load that Collection / saved view into the Grid', kind: 'gesture' }
    ] },
  H: { desc: 'The full reference (Hd / Hu / Hum). ◀ ▶ page between the developer, taxonomy, desktop-user and mobile-user versions.',
    rows: [
      { k: 'H / Esc', d: 'Close the reference' },
      { k: '◀ / ▶',   d: 'Previous / next help page' },
      { k: '⬇ Download', d: 'Export the whole reference as rich text', kind: 'gesture' }
    ] }
};

// ─────────────────────────────────────────────────────────────────────────────
// COLUMN 3 — which global keys actually REACH the dispatcher from this screen.
//
// core.js's window-capture listener returns early (no dispatch at all) while the
// dictionary, slideshow, video editor or shareable menu is open, and hotkeys.js
// fn entries bail on their own for several overlays. Listing a key that is
// swallowed before it arrives is worse than listing nothing.
// ─────────────────────────────────────────────────────────────────────────────
// Screens where core.js bails wholesale: an explicit ALLOW list.
var HP_GLOBAL_ONLY = {
  Ev:   ['H  /  ⇧H', 'Esc', '0'],
  // (zip0183) Xe is the exception — hotkeys.js auto-saves and closes it first,
  // so these four still work from the editor.
  Xe:   ['T', 'G', 'A', 'D', 'H  /  ⇧H', 'Esc', '0'],
  D:    ['T', 'G', 'H  /  ⇧H', 'Esc', '0'],
  SS:   ['H  /  ⇧H', 'Esc', '0'],
  Menu: ['H  /  ⇧H', 'Esc', '0'],
  H:    ['H  /  ⇧H', 'Esc', '0'],
  Cu:   ['C', 'H  /  ⇧H', 'Esc', '0']
};
// Everywhere else: a DENY list of keys that dispatch but then no-op.
var HP_GLOBAL_OFF = {
  G:  ['W  or  L'],                         // bails while the grid is up
  // The ☰ / ⚙ chrome is HIDDEN behind a fullscreen page (_wireMobileToCBtn
  // hides both whenever #gridFullscreen is up) — verified in the browser, not
  // assumed. Offering a button the viewer cannot see is the same lie as
  // offering a key that never arrives.
  V:  ['W  or  L', 'F', '☰ button (top-left)'],
  Ie: ['W  or  L', 'F', '☰ button (top-left)'],
  Q:  ['W  or  L', 'F', '☰ button (top-left)'],
  Xs: ['W  or  L', 'F', '☰ button (top-left)'],
  C:  ['W  or  L', 'F'], A:  ['W  or  L', 'F'],
  // The staging screens own these letters themselves (core.js bails per-letter).
  I:  ['W  or  L', 'F', 'A', 'D', 'E', 'C'],
  St: ['W  or  L', 'F', 'A', 'D', 'E', 'C'],
  X:  ['W  or  L', 'F', 'A', 'D', 'E', 'C'],
  O:  ['W  or  L', 'F']
};

// ─────────────────────────────────────────────────────────────────────────────
// ROW COLLECTION
// ─────────────────────────────────────────────────────────────────────────────
// Key normaliser used for de-duplication. HELP_DATA and the registry word the
// SAME gesture differently ("Swipe → on cell" vs "Swipe → on a cell",
// "Ctrl+click cell" vs "Ctrl+click a cell"), so articles/prepositions are
// dropped before comparing. Single-token keys keep their word — otherwise the
// 'A' hotkey would normalise to the empty string.
var HP_STOP = { a: 1, an: 1, the: 1, on: 1, 'in': 1, onto: 1 };
function normKey(k) {
  var s = String(k || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[,·]/g, ' ');
  var toks = s.split(/\s+/).filter(Boolean);
  if (toks.length > 1) {
    var f = toks.filter(function (t) { return !HP_STOP[t]; });
    if (f.length) toks = f;
  }
  return toks.join('');
}

// The leftovers that no normaliser should be asked to catch: registry labels a
// HELP_DATA row on that screen already covers, worded structurally differently.
// Explicit on purpose — fuzzy subset-matching collapsed rows that are genuinely
// different ("Click cell" = play/pause vs "Click another cell" = swap the cut
// cell), which is worse than a little duplication.
var HP_DROP = {
  // 'Swipe ← on cell' is HELP_DATA's thinner wording of the registry's
  // 'Swipe ← within a cell' — the registry row says WHY it has to stay inside.
  G: ['Hold a cell, click another', 'R-click a grid cell', 'Swipe ← on cell'],
  T: ['Shift+click down a column']
};

// A row is a GESTURE (not a keystroke) when its binding names a pointer idiom or
// an on-screen control. Structural, like core.js's _itemMobileOk — new rows in
// HELP_DATA get classified for free.
function isGesture(k) {
  return /swipe|pinch|pan|tap|hold|click|drag|wheel|button|menu|☰|r-click/i.test(String(k || ''));
}

function scopeHas(scope, code) {
  if (!scope) return false;
  var parts = String(scope).split('/');
  for (var i = 0; i < parts.length; i++) if (parts[i].trim() === code) return true;
  return false;
}

// Everything the panel shows for one screen, already split into the three
// columns the renderer draws.
function hpRows(s) {
  var code = s.code;
  var keys = [], gests = [], globals = [];
  var seen = {};
  (HP_DROP[code] || []).forEach(function (lbl) { seen[normKey(lbl)] = true; });

  // 1 — context rules first: they own their key and suppress the flat rows.
  HP_CTX.forEach(function (r) {
    if (r.screens.indexOf(code) < 0) return;
    (r.hide || []).forEach(function (lbl) { seen[normKey(lbl)] = true; });
    var live = -1;
    for (var i = 0; i < r.variants.length; i++) {
      if (probe(function () { return r.variants[i].on(s); }, false)) { live = i; break; }
    }
    var row = { k: r.k, d: r.d, ctx: r.variants, live: live, note: r.note, dev: false };
    seen[normKey(r.k)] = true;
    (r.kind === 'gesture' ? gests : keys).push(row);
  });

  function push(list, k, d, dev) {
    if (!k || !d) return;
    var n = normKey(k);
    if (seen[n]) return;
    seen[n] = true;
    list.push({ k: k, d: d, dev: !!dev });
  }

  // 2 — the HELP_DATA panel whose id is this screen.
  var hd = probe(function () { return window._helpData ? window._helpData() : []; }, []) || [];
  hd.forEach(function (sec) {
    if (sec.id !== code || sec.mobileOnly) return;
    (sec.sections || []).forEach(function (sub) {
      (sub.items || []).forEach(function (it) {
        push(isGesture(it.key) ? gests : keys, it.key, it.desc, it.dev);
      });
    });
  });

  // 3 — registry entries scoped to this screen (doc entries: window-capture
  //     keys, gestures, menus that stay owned by their own screen).
  var reg = window.HOTKEYS || [];
  reg.forEach(function (h) {
    if (!h.label || !h.desc) return;
    if (typeof h.fn === 'function') return;         // globals handled below
    if (!scopeHas(h.scope, code)) return;
    push(isGesture(h.label) || h.helpSection === 'Gestures' || h.helpSection === 'Menus'
      ? gests : keys, h.label, h.desc, h.dev);
  });

  // 4 — HP_EXTRA for the screens neither table covers.
  var ex = HP_EXTRA[code];
  if (ex) ex.rows.forEach(function (r) {
    push(r.kind === 'gesture' ? gests : keys, r.k, r.d, r.dev);
  });

  // 5 — column 3: the global keys that actually work FROM here.
  var only = HP_GLOBAL_ONLY[code] || null;
  var off  = HP_GLOBAL_OFF[code] || [];
  var offSet = {}; off.forEach(function (l) { offSet[normKey(l)] = true; });
  var onlySet = null;
  if (only) { onlySet = {}; only.forEach(function (l) { onlySet[normKey(l)] = true; }); }
  var blocked = window.HK_USER_BLOCKED || [];
  function pushGlobal(label, desc, dev) {
    var n = normKey(label);
    if (seen[n]) return;                       // the screen-specific meaning wins
    if (onlySet ? !onlySet[n] : offSet[n]) return;
    globals.push({ k: label, d: desc, dev: dev });
  }
  reg.forEach(function (h) {
    if (typeof h.fn !== 'function' || !h.label || !h.desc) return;
    pushGlobal(h.label, h.desc, blocked.indexOf(h.key) >= 0);
  });
  reg.forEach(function (h) {
    if (typeof h.fn === 'function' || !h.label || !h.desc) return;
    if (h.scope !== 'global') return;
    pushGlobal(h.label, h.desc, !!h.dev);
  });

  if (s.userMode) {
    var keep = function (r) { return !r.dev; };
    keys = keys.filter(keep); gests = gests.filter(keep); globals = globals.filter(keep);
  }
  return { keys: keys, gests: gests, globals: globals, desc: (ex && ex.desc) || hpDescFor(code, hd) };
}

function hpDescFor(code, hd) {
  for (var i = 0; i < hd.length; i++) if (hd[i].id === code) return hd[i].desc || '';
  return '';
}

// Live context chips for the header — the one-glance "where am I / what is it
// doing" line that the ◆ rows then explain in detail.
function hpChips(s) {
  var c = [];
  if (s.code === 'V' || s.code === 'Ie' || s.code === 'Q' || s.code === 'Xs') {
    if (s.video) c.push({ t: s.playing ? '▶ playing' : (s.paused ? '⏸ paused' : '• video idle'), on: true });
    if (s.zoom > 1.05) c.push({ t: '⤢ zoomed ' + s.zoom.toFixed(1) + '×', on: true });
    else if (!s.textReader) c.push({ t: '⤢ 1× — swipe ← leaves', on: false });
    if (s.sectNav) c.push({ t: '▤ deck page', on: true });
    if (s.slideshow) c.push({ t: '🖼 in slideshow', on: true });
    if (s.textReader) c.push({ t: '📖 text reader', on: true });
  } else if (s.code === 'SS') {
    c.push({ t: s.ssPaused ? '⏸ paused' : '▶ running', on: true });
    if (s.ssReview) c.push({ t: 'review mode', on: true });
    c.push({ t: s.ssZoom ? '⤢ zoomed' : '⤢ 1× — swipe ← leaves', on: !!s.ssZoom });
  } else if (s.code === 'G') {
    c.push({ t: s.gridSrc === 'C' ? 'source: C' + (s.cfgName ? ' · ' + s.cfgName : '') : 'source: T', on: s.gridSrc === 'C' });
    c.push({ t: 'layout: ' + s.layout + (s.layoutLocked ? ' (locked)' : ''), on: s.layoutLocked });
    if (s.gSect)    c.push({ t: '▤ 1a is a deck page', on: true });
    if (s.bufPanel) c.push({ t: '⚙ clean-playback panel up', on: true });
    if (s.moving)   c.push({ t: '↻ moving cells', on: true });
  }
  c.push({ t: s.userMode ? 'user mode' : 'dev mode', on: false });
  return c;
}

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// One <style> injected once. Written with plain string concatenation on
// purpose — a stray backtick inside a template literal here would break the
// parse and silently kill the H key (see the save-stale/backtick note).
//
// (dev0703) Every size is in em off --hp-fs so hpFit() can shrink the whole
// strip with one property write until the tallest column fits without a bar.
// ─────────────────────────────────────────────────────────────────────────────
function injectCss() {
  if ($id('hpCss')) return;
  var st = document.createElement('style');
  st.id = 'hpCss';
  st.textContent = [
    '#hpPanel{position:fixed;top:0;left:0;right:0;z-index:10000050;',
      '--hp-fs:15px;font-size:var(--hp-fs);font-family:monospace;color:#cde;',
      'background:rgba(10,10,26,0.975);border-bottom:2px solid #4af;',
      'box-shadow:0 6px 30px rgba(0,0,0,0.85);display:flex;flex-direction:column;}',
    '#hpPanel.hp-hidden{display:none;}',
    '#hpHead{display:flex;align-items:center;gap:0.6em;flex-wrap:wrap;',
      'padding:0.35em 0.7em;background:#16213e;border-bottom:1px solid #2a2a4a;}',
    '#hpTitle{font-size:1.05em;font-weight:bold;color:#8cf;white-space:nowrap;}',
    '#hpChips{display:flex;flex-wrap:wrap;gap:0.35em;flex:1;}',
    '#hpChips span{font-size:0.78em;padding:0.1em 0.6em;border-radius:1em;',
      'border:1px solid #2a3a5a;background:#111a2e;color:#8a9;white-space:nowrap;}',
    '#hpChips span.on{border-color:#3d8;background:#0d2a1e;color:#7ec;}',
    '#hpPanel button{background:#1a1a2e;border:1px solid #46c;color:#bde;border-radius:4px;',
      'font-family:monospace;font-size:0.82em;padding:0.2em 0.7em;cursor:pointer;white-space:nowrap;}',
    '#hpPanel button:hover{background:#24406e;border-color:#8cf;}',
    // The band: three equal columns, capped so it only ever covers the TOP of
    // the screen. overflow:hidden is the no-scrollbar promise; hpFit shrinks the
    // type until the content honours it, and only adds .hp-of as a last resort.
    '#hpBody{display:grid;grid-template-columns:1fr 1fr 1fr;',
      'max-height:calc(80vh - 3em);overflow:hidden;}',
    '#hpBody.hp-of{overflow-y:auto;}',
    '.hp-col{padding:0.35em 0.8em 0.6em;border-left:1px solid #1e2440;min-width:0;}',
    '.hp-col:first-child{border-left:none;}',
    '.hp-colhead{color:#79a;font-size:0.82em;letter-spacing:0.05em;',
      'border-bottom:1px solid #1e2440;padding-bottom:0.2em;margin-bottom:0.25em;}',
    '.hp-cdesc{color:#667;font-size:0.75em;line-height:1.4;margin-bottom:0.3em;}',
    '.hp-row{display:flex;gap:0.6em;padding:0.12em 0;align-items:baseline;}',
    '.hp-k{flex:0 0 6.4em;color:#fd8;font-weight:bold;word-break:break-word;line-height:1.3;}',
    '.hp-d{flex:1;color:#cde;font-size:0.95em;line-height:1.35;min-width:0;}',
    '.hp-dev{color:#647;font-size:0.75em;margin-left:0.4em;}',
    '.hp-badge{display:inline-block;background:#3a2a52;border:1px solid #96f;color:#c9f;',
      'border-radius:3px;font-size:0.75em;padding:0 0.3em;margin-right:0.3em;vertical-align:0.1em;}',
    '.hp-var{display:flex;gap:0.4em;font-size:0.88em;line-height:1.35;padding:0.05em 0 0.05em 0.5em;color:#89a;}',
    '.hp-var .hp-mark{flex:0 0 2.9em;color:#445;font-size:0.85em;}',
    '.hp-var.live{color:#8f9;}',
    '.hp-var.live .hp-mark{color:#3d8;font-weight:bold;}',
    '.hp-note{font-size:0.8em;color:#667;padding:0.05em 0 0.15em 0.5em;line-height:1.35;font-style:italic;}',
    '#hpFoot{padding:0.25em 0.7em;border-top:1px solid #2a2a4a;background:#0c1020;',
      'font-size:0.76em;color:#667;}',
    '#hpTip{position:fixed;z-index:10000060;pointer-events:none;max-width:280px;',
      'background:#101a30;color:#dfe;border:1px solid #6af;border-radius:6px;padding:5px 9px;',
      'font-family:monospace;font-size:12px;line-height:1.4;box-shadow:0 4px 18px rgba(0,0,0,0.8);',
      'opacity:0;transition:opacity .09s;white-space:pre-wrap;}',
    '#hpTip.on{opacity:1;}',
    '#hpTip .hp-arrow{position:absolute;width:8px;height:8px;background:#101a30;',
      'border-right:1px solid #6af;border-bottom:1px solid #6af;transform:rotate(45deg);}'
  ].join('');
  document.head.appendChild(st);
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PANEL
// ─────────────────────────────────────────────────────────────────────────────
var _hpTimer = null, _hpScreenAt = null;

function hpIsOpen() { var p = $id(PANEL_ID); return !!p && !p.classList.contains('hp-hidden'); }

function hpBuild() {
  injectCss();
  var p = document.createElement('div');
  p.id = PANEL_ID;
  p.innerHTML =
      '<div id="hpHead">'
    +   '<span id="hpTitle">Help</span>'
    +   '<span id="hpChips"></span>'
    +   '<button id="hpFull" title="Open the FULL reference — every screen, every key (Shift+H)">Full ref</button>'
    +   '<button id="hpClose" title="Close this panel (H or Esc)">✕</button>'
    + '</div>'
    + '<div id="hpBody"></div>'
    + '<div id="hpFoot">'
    +   '<span class="hp-badge">◆</span>behaviour changes with context — the green <b>now ▸</b> is what it does at this moment. '
    +   'Long entries are trimmed with “…” · H closes · ⇧H = the full untrimmed reference.'
    + '</div>';
  // Appended to <body>, i.e. OUTSIDE #rotateWrap — same as the shareable menu.
  document.body.appendChild(p);

  $id('hpClose').addEventListener('click', hpClose);
  $id('hpFull').addEventListener('click', function () {
    if (typeof openHelp === 'function') openHelp();
  });
  return p;
}

// Several registry entries are paragraphs (B, ⇧B, Ctrl+V, Q/⇧Q all explain a
// whole subsystem). At a third of the window wide, one of those swallows the
// column. Trim to the first ~170 characters on a word boundary — the untrimmed
// text is one ⇧H away, and the footer says so.
function clip(s, n) {
  s = String(s == null ? '' : s);
  if (s.length <= n) return s;
  var cut = s.slice(0, n);
  var sp = cut.lastIndexOf(' ');
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[ ,;.—-]+$/, '') + ' …';
}

function rowHtml(r) {
  var h = '<div class="hp-row"><div class="hp-k">'
        + (r.ctx ? '<span class="hp-badge">◆</span>' : '')
        + esc(r.k) + '</div><div class="hp-d">' + esc(clip(r.d, r.ctx ? 240 : 170))
        + (r.dev ? '<span class="hp-dev">dev</span>' : '');
  if (r.ctx) {
    for (var i = 0; i < r.ctx.length; i++) {
      var live = (i === r.live);
      h += '<div class="hp-var' + (live ? ' live' : '') + '" data-var="' + i + '">'
         + '<span class="hp-mark">' + (live ? 'now ▸' : '▹') + '</span>'
         + '<span>' + esc(clip(r.ctx[i].d, 190)) + '</span></div>';
    }
    if (r.note) h += '<div class="hp-note">' + esc(clip(r.note, 190)) + '</div>';
  }
  return h + '</div></div>';
}

function colHtml(head, desc, rows, empty) {
  var h = '<div class="hp-col"><div class="hp-colhead">' + head + '</div>';
  if (desc) h += '<div class="hp-cdesc">' + esc(desc) + '</div>';
  if (!rows.length) h += '<div class="hp-cdesc">' + esc(empty) + '</div>';
  rows.forEach(function (r) { h += rowHtml(r); });
  return h + '</div>';
}

// Shrink the type until the tallest column fits the band. Stops at the first
// size that fits, so a sparse screen gets large text and a dense one gets as
// much as it can without a scrollbar.
//
// The STARTING size tracks the viewport WIDTH, not just the height: each column
// is a third of the window, and at 17px on a 900px-wide window every second word
// wrapped. Width sets the ceiling, then the height loop takes it from there.
// The band is as tall as its TALLEST column, so equal thirds waste the space:
// column 1 (this screen's hotkeys) routinely carries three times the text of
// column 3 (the handful of globals that reach it), overflowed, and dragged a
// scrollbar in while two thirds of the strip sat empty. Weight the widths by how
// much text each column actually holds — clamped so no column collapses — and
// the tall one gets the room it needs to be short.
function hpBalance() {
  var body = $id('hpBody');
  if (!body) return;
  var cols = body.querySelectorAll('.hp-col');
  if (cols.length !== 3) return;
  var w = [], tot = 0;
  for (var i = 0; i < 3; i++) {
    var n = Math.max(60, (cols[i].textContent || '').length);
    w.push(n); tot += n;
  }
  body.style.gridTemplateColumns = w.map(function (n) {
    return Math.max(0.65, Math.min(1.7, (n / tot) * 3)).toFixed(2) + 'fr';
  }).join(' ');
}

function hpFit() {
  var p = $id(PANEL_ID), body = $id('hpBody');
  if (!p || !body) return;
  body.classList.remove('hp-of');
  hpBalance();
  var top = Math.max(11, Math.min(17, Math.round(window.innerWidth / 95)));
  for (var n = top; n >= 11; n--) {
    p.style.setProperty('--hp-fs', n + 'px');
    if (body.scrollHeight <= body.clientHeight + 1) return;   // reading forces layout
  }
  // Still too tall at the 11px floor — scroll rather than shrink into
  // illegibility or clip. Losing rows silently would be worse than the bar we
  // were trying to avoid, and so would type nobody can read.
  body.classList.add('hp-of');
}

function hpRender() {
  var p = $id(PANEL_ID) || hpBuild();
  var s = hpState();
  _hpScreenAt = s.code;
  var R = hpRows(s);
  var name = HP_TITLES[s.code] || s.code;

  $id('hpTitle').textContent = '⌨ ' + name;
  $id('hpChips').innerHTML = hpChips(s).map(function (c) {
    return '<span class="' + (c.on ? 'on' : '') + '">' + esc(c.t) + '</span>';
  }).join('');

  $id('hpBody').innerHTML =
      colHtml('⌨ HOTKEYS — ' + esc(s.code), R.desc, R.keys,
              'No keys of its own here.')
    + colHtml('👆 MOUSE / SWIPE — ' + esc(s.code), '', R.gests,
              'No pointer gestures of its own here.')
    + colHtml('🌐 GLOBAL KEYS THAT WORK HERE', '', R.globals,
              'This screen owns the keyboard — no global keys reach it.');

  hpFit();
}

// Cheap re-check while the panel is up: if the screen changed, redraw; otherwise
// just re-point the "now ▸" markers and refresh the chips. A full re-render on
// every tick would re-run the font fit and make the strip twitch.
function hpTick() {
  if (!hpIsOpen()) return;
  var s = hpState();
  if (s.code !== _hpScreenAt) { hpRender(); return; }

  $id('hpChips').innerHTML = hpChips(s).map(function (c) {
    return '<span class="' + (c.on ? 'on' : '') + '">' + esc(c.t) + '</span>';
  }).join('');

  var R = hpRows(s);
  var ctxRows = R.keys.concat(R.gests).filter(function (r) { return !!r.ctx; });
  var domRows = [].slice.call(document.querySelectorAll('#hpBody .hp-row'))
    .filter(function (el) { return el.querySelector('.hp-var'); });
  ctxRows.forEach(function (r, n) {
    var el = domRows[n];
    if (!el) return;
    var vs = el.querySelectorAll('.hp-var');
    for (var i = 0; i < vs.length; i++) {
      var live = (i === r.live);
      vs[i].classList.toggle('live', live);
      var mk = vs[i].querySelector('.hp-mark');
      if (mk) mk.textContent = live ? 'now ▸' : '▹';
    }
  });
}

function hpOpen() {
  var p = $id(PANEL_ID) || hpBuild();
  p.classList.remove('hp-hidden');
  hpRender();
  if (_hpTimer) clearInterval(_hpTimer);
  _hpTimer = setInterval(hpTick, 700);
}

function hpClose() {
  var p = $id(PANEL_ID);
  if (p) p.classList.add('hp-hidden');
  if (_hpTimer) { clearInterval(_hpTimer); _hpTimer = null; }
}

function hpToggle() { hpIsOpen() ? hpClose() : hpOpen(); }

window.addEventListener('resize', function () { if (hpIsOpen()) hpFit(); });

window.hpOpen = hpOpen;
window.hpClose = hpClose;
window.hpToggle = hpToggle;
window.hpIsOpen = hpIsOpen;
window.hpScreen = hpScreen;
// Exposed for console debugging ("what does the panel think it is looking at,
// and which rows did it resolve?") and for the offline row-merge check.
window._hpState = hpState;
window._hpRows  = hpRows;

// ─────────────────────────────────────────────────────────────────────────────
// BALLOONS
// Delegated hover tips over icon-ish controls. The text is whatever `title` the
// control already carries; the first hover moves it to data-tip and drops the
// attribute so the OS tooltip stops racing the balloon.
// ─────────────────────────────────────────────────────────────────────────────
// Opt IN: real controls, plus everything inside the fullscreen viewer's chrome
// (vp.js builds some of its readouts as <div title="…">, not buttons).
var TIP_IN  = 'button[title],a[title],[role="button"][title],[data-tip],'
            + '#gridFullscreen [title],#hpPanel [title],#ver-badge,#uid-badge,#userHmBtn,#mobileToCBtn';
// Opt OUT: `td.title` in T is the cell's full text, not a function name; form
// controls keep the native tooltip.
var TIP_OUT = 'td,th,tr,input,textarea,select,option,[data-notip]';

var _tipEl = null, _tipTimer = null, _tipFor = null, _tipPend = null;

function tipNode() {
  if (_tipEl && _tipEl.isConnected) return _tipEl;
  injectCss();
  _tipEl = document.createElement('div');
  _tipEl.id = TIP_ID;
  _tipEl.innerHTML = '<span class="hp-arrow"></span><span id="hpTipTxt"></span>';
  document.body.appendChild(_tipEl);
  return _tipEl;
}

function tipTarget(node) {
  if (!node || !node.closest) return null;
  var el = node.closest(TIP_IN);
  if (!el) return null;
  if (el.matches(TIP_OUT)) return null;
  // Re-read `title` on EVERY hover, not just the first: several controls rewrite
  // their own title as they toggle (vp.js's step/loop buttons, the crop knob).
  // A freshly written title always wins over the cached data-tip.
  var live = el.getAttribute('title');
  if (live != null && live.trim()) {
    el.setAttribute('data-tip', live.trim());
    el.removeAttribute('title');            // kill the competing native tooltip
    return el;
  }
  var txt = el.getAttribute('data-tip');
  return (txt && txt.trim()) ? el : null;
}

function tipShow(el) {
  var t = tipNode();
  $id('hpTipTxt').textContent = el.getAttribute('data-tip') || '';
  t.style.left = '0px'; t.style.top = '0px';
  t.classList.add('on');
  _tipFor = el;

  var r = el.getBoundingClientRect();
  var b = t.getBoundingClientRect();
  var above = r.top > b.height + 14;
  var top = above ? (r.top - b.height - 9) : (r.bottom + 9);
  var left = r.left + r.width / 2 - b.width / 2;
  left = Math.max(6, Math.min(window.innerWidth - b.width - 6, left));
  t.style.left = Math.round(left) + 'px';
  t.style.top  = Math.round(top) + 'px';

  var arrow = t.querySelector('.hp-arrow');
  var ax = Math.max(8, Math.min(b.width - 16, r.left + r.width / 2 - left - 4));
  arrow.style.left = Math.round(ax) + 'px';
  if (above) { arrow.style.top = (b.height - 5) + 'px'; arrow.style.transform = 'rotate(45deg)'; }
  else       { arrow.style.top = '-5px';                arrow.style.transform = 'rotate(225deg)'; }
}

function tipHide() {
  if (_tipTimer) { clearTimeout(_tipTimer); _tipTimer = null; }
  _tipFor = null; _tipPend = null;
  if (_tipEl) _tipEl.classList.remove('on');
}

document.addEventListener('pointerover', function (e) {
  if (e.pointerType === 'touch') return;              // touch uses the hold path
  var el = tipTarget(e.target);
  if (!el) {
    // Left every tippable control — drop both the shown balloon AND a hover that
    // is still counting down, or it would pop up after the pointer had gone.
    if (_tipFor || _tipPend) tipHide();
    return;
  }
  if (el === _tipFor || el === _tipPend) return;
  tipHide();
  _tipPend = el;
  _tipTimer = setTimeout(function () { _tipPend = null; tipShow(el); }, 260);
}, true);

document.addEventListener('pointerout', function (e) {
  var cur = _tipFor || _tipPend;
  if (!cur) return;
  if (e.relatedTarget && cur.contains(e.relatedTarget)) return;
  tipHide();
}, true);

// Touch: press-and-hold ~480 ms on a real control. Deliberately NOT wired for
// grid cells — a hold there is the cut/swap gesture, and this must never look
// like it stole it. The balloon is pointer-events:none and never preventDefaults,
// so the underlying gesture still runs.
document.addEventListener('pointerdown', function (e) {
  if (e.pointerType !== 'touch') { tipHide(); return; }
  var el = tipTarget(e.target);
  if (!el || !el.matches('button,a,[role="button"],[data-tip]')) return;
  _tipPend = el;
  _tipTimer = setTimeout(function () { _tipPend = null; tipShow(el); }, 480);
}, true);
['pointerup', 'pointercancel', 'wheel', 'keydown'].forEach(function (ev) {
  document.addEventListener(ev, function () { tipHide(); }, true);
});
window.addEventListener('scroll', tipHide, true);
window.addEventListener('blur', tipHide);

// ─────────────────────────────────────────────────────────────────────────────
// KEY OWNERSHIP — registered here, first in the script list, so it beats
// core.js's window-capture dispatcher (same node, so stopImmediatePropagation is
// what is needed to stop it, not stopPropagation).
// ─────────────────────────────────────────────────────────────────────────────
window.addEventListener('keydown', function (e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  var ae = document.activeElement;
  var tag = ae && ae.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      || (ae && ae.isContentEditable)) return;        // typing wins, always
  // The hamburger panel owns its own h (hmKeyHandler → full Help). Leave it.
  var hm = $id('hmPanel');
  if (hm && hm.classList.contains('open')) return;

  if (e.key === 'h' || e.key === 'H') {
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.shiftKey) {
      if (typeof isHelpOpen === 'function' && typeof openHelp === 'function') {
        isHelpOpen() ? closeHelp() : openHelp();
      }
    } else {
      hpToggle();
    }
    return false;
  }
  // Esc closes the panel first — same precedence the clean-playback panel has.
  if (e.key === 'Escape' && hpIsOpen()) {
    e.preventDefault(); e.stopImmediatePropagation();
    hpClose();
    return false;
  }
}, true);

})();
