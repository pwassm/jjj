// ══════════════════════════════════════════════════════════════════════════════
// helpfloat.js — H = FLOATING CONTEXT HELP + BALLOON TOOLTIPS (dev0702)
//
// Two features, one file, both live on slam.com (sealifeandmore.com) AND on
// localhost — there is no host gate: the panel reads the SCREEN, not the URL.
//
//  1. Hf — the floating help window (`H`, or ✕ / Esc / H to close).
//     Shows ONLY what applies to the window you are looking at right now:
//       • ⌨ HOTKEYS — this screen
//       • 👆 GESTURES — this screen (swipe / click / hold / menus)
//       • 🌐 GLOBAL — the any-screen keys, collapsed by default
//     Rows whose meaning CHANGES with live state carry a ◆ badge and list their
//     variants underneath, with the one that is active RIGHT NOW marked "now ▸"
//     in green. That is the answer to "← / → are different while V is playing"
//     and "swipe is different when you're zoomed in" — the panel says which
//     branch you are in, live, and re-checks every 700 ms while it is open.
//     Shift+H still opens the FULL reference (the old Hd/Hu modal); so does the
//     panel's "Full ref" button.
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
var LS_POS   = 'slam-hp-pos';
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
  C:  'C — Collection / Config',   A:  'A — Annotate panel',
  Ev: 'Ev — Video editor',         Xe: 'Xe — Text editor (HTML)',
  Xs: 'Xs — Slide, fullscreen',    V:  'V — Video viewer',
  Ie: 'Ie — Image viewer',         Q:  'Q — Quiz',
  D:  'D — Dictionary',            I:  'I — Instagram staging',
  St: 'St — Bulk staging',         O:  'O — Org review',
  X:  'X — Search results',        SS: 'Slideshow',
  Menu: 'Menu — home / greeting',  H:  'H — Full reference'
};

function hpScreen() {
  if (flexOpen('helpModal'))            return 'H';
  if ($id('dictOverlay'))               return 'D';
  if ($id('teSlideOverlay'))            return 'Xs';
  if ($id('textEditorOverlay'))         return 'Xe';
  if ($id('video-editor-overlay'))      return 'Ev';
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
    // ── G ──
    gSect: probe(function () {
      var c = document.querySelector('#gridContainer .grid-cell[data-cell="1a"]');
      return !!(c && c._salSect && c._salSect.inner && c._salSect.inner.isConnected);
    }, false),
    gTextCell: probe(function () {
      return !!document.querySelector('#gridContainer .grid-cell[data-cell="1a"]');
    }, false),
    bufPanel:  probe(function () { return !!(window._gridBufPanelOpen && window._gridBufPanelOpen()); }, false),
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
    hide: ['← →', '←   →'],
    d: 'Depends on what the page is doing right now:',
    variants: [
      { d: 'Page the lesson slide back / forward (multi-section page, video not paused)',
        on: function (s) { return s.sectNav && !s.paused; } },
      { d: 'Previous / next slideshow slide — closes V on the way',
        on: function (s) { return s.slideshow && s.playing; } },
      { d: 'Frame-step ±1/30 s (a playing video is paused first so the step shows)',
        on: function (s) { return s.video; } },
      { d: 'Nothing to step here (no video on this page)', on: function () { return true; } }
    ],
    note: 'Shift+← / → always frame-steps, even on a slide page that would otherwise page.' },

  // ── V / Ie: the swipe, and why it sometimes refuses to close.
  { screens: ['V', 'Ie', 'Q', 'Xs'], k: 'Swipe ←  /  drag R→L', kind: 'gesture',
    hide: ['Swipe ← on image', 'Swipe ← in a viewer', 'Swipe ← (top bar)',
           'Swipe ← (from edge)', 'Swipe ←'],
    d: 'Depends on the zoom:',
    variants: [
      { d: 'PANS the zoomed picture — the swipe no longer closes the viewer',
        on: function (s) { return s.zoom > 1.05; } },
      { d: 'Closes the viewer and returns to the Grid',
        on: function (s) { return s.zoom <= 1.05; } }
    ],
    note: 'Double-click (double-tap) resets the zoom to 1× and gives the closing swipe back. '
        + 'Esc and the ✕ button always close, zoomed or not.' },

  // ── V / Ie: vertical arrows.
  { screens: ['V', 'Ie', 'Xs', 'Q'], k: '↑  /  ↓', kind: 'key',
    hide: ['↑ ↓'],
    d: 'Depends on what is open:',
    variants: [
      { d: '↓ returns to the Grid (you are in the expanded text reader); ↑ is inert',
        on: function (s) { return s.textReader; } },
      { d: 'Mark / un-mark this slide for deletion (slideshow triage)',
        on: function (s) { return s.slideshow && s.video; } },
      { d: 'Inert — a video owns the arrows here', on: function (s) { return s.video; } },
      { d: 'Previous / next row in the current filter', on: function () { return true; } }
    ] },

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
    d: 'Shared keys — the CLEAN PLAYBACK panel takes them while it is up:',
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
      { d: 'LOCKED — a C-source 17 / 19 / portrait layout is active; resize it on the C screen',
        on: function (s) { return s.layoutLocked; } },
      { d: 'Resize the grid: 2 → 2×2, 3 → 3×3, 4 → 4×4, 5 → 5×5 (1 and 6–9 do nothing)',
        on: function () { return true; } }
    ] },

  // ── Letters whose meaning flips between T and G. Listed on BOTH screens so
  //    neither reader has to guess which one they are holding.
  { screens: ['T', 'G'], k: 'A', kind: 'key',
    hide: ['A', 'A  or  Ctrl+I'],
    d: 'Same key, two jobs:',
    variants: [
      { d: 'Grid: toggle STEP-FRAME mode — cells with saved steps loop their local clip',
        on: function (s) { return s.code === 'G'; } },
      { d: 'Table: toggle the floating preview of the focused row (Ctrl+I does the same)',
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
      { d: 'Table: toggle the filter modal — tags ∧ text search (Shift+F clears every filter)',
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
  I: { desc: 'ig.json review — enrich / download / promote Instagram rows. The list is windowed; filters persist per browser.',
    rows: [
      { k: '↑ / ↓',  d: 'Move the focused row' },
      { k: 'Enter',  d: 'Open the focused post' },
      { k: 'Space',  d: 'Select / deselect the focused row' },
      { k: 'f',      d: 'Focus the filter box  ·  Shift+F clears the text filter' },
      { k: 'd',      d: 'Download the selected rows' },
      { k: 'e',      d: 'Enrich the selected rows (cookieless /p OG-tag fetch)' },
      { k: 'c',      d: 'Clear the selection' },
      { k: 'r',      d: 'Reset the selected rows back to “new” so they can be retried' },
      { k: 'a',      d: 'Toggle the auto-enrich panel' },
      { k: 'm',      d: 'Clear, then select the top 18' },
      { k: 'w',      d: 'Paste an IG URL from the clipboard as a new Unharvested single' },
      { k: '⇧N / ⇧D / ⇧E / ⇧A', d: 'Status filter: new / downloaded / enriched / all' },
      { k: 'Ctrl+I', d: 'Toggle the floating preview' },
      { k: 't',      d: 'Leave — back to the Table (Esc no longer closes the screen)' }
    ] },
  St: { desc: 'Bulk staging over s.json — import links in bulk, fill their metadata, then promote the good ones into ml.json.',
    rows: [
      { k: '↑ / ↓',      d: 'Move the focused row' },
      { k: 'w',          d: 'Import links from the clipboard' },
      { k: 'a',          d: 'Add the focused row to ml.json (promote)' },
      { k: 'd / Delete', d: 'Delete the focused row (archived to sdeleted.json)' },
      { k: 'e',          d: 'Fill Res / Size / Len metadata' },
      { k: 'c',          d: 'Open the L1 / L2 bulk-category dialog' },
      { k: 'f',          d: 'Focus the search box  ·  Shift+F clears the filters' },
      { k: 'Ctrl+Z',     d: 'Undo the last Delete / Add' },
      { k: 'Ctrl+I',     d: 'Toggle the floating preview window' },
      { k: 'Esc / t',    d: 'Leave — back to the Table' }
    ] },
  O: { desc: 'Org-review over o.json — Orgzly notes imported by orgToO.js.',
    rows: [
      { k: '↑ / ↓',  d: 'Move the focused row' },
      { k: 'r',      d: 'Toggle the reading pane' },
      { k: 'f',      d: 'Focus the search box  ·  Shift+F clears EVERY filter, column boxes included' },
      { k: 'Delete', d: 'Delete the focused record (archived)' },
      { k: 'Esc / t', d: 'Leave — back to the Table' }
    ] },
  X: { desc: 'Search-results review over x.json — hits from the linkfinders tools. Promote canonicalises YouTube / Vimeo links.',
    rows: [
      { k: '↑ / ↓',     d: 'Move the focused row' },
      { k: '← / →',     d: 'Seek the preview back / forward' },
      { k: 'w',         d: 'Import results from the clipboard' },
      { k: 'a',         d: 'Add the focused row to ml.json (promote)' },
      { k: 'd / Delete', d: 'Delete the focused row (archived to xdeleted.json)' },
      { k: 'e',         d: 'Fill Res / Size / Len metadata' },
      { k: 'c',         d: 'Open the Source / Query bulk dialog' },
      { k: 'f',         d: 'Focus the search box  ·  Shift+F clears the filters' },
      { k: 'Ctrl+↓',    d: 'PERMANENT delete → xdeleted.json (that video will not come back on a re-run)' },
      { k: 'Ctrl+Z',    d: 'Undo the last Delete / Add' },
      { k: 'Esc / t',   d: 'Leave — back to the Table' }
    ] },
  SS: { desc: 'Slideshow / Review. Owns the keyboard outright — global hotkeys stand down while it is up.',
    rows: [
      { k: '→ / Space', d: 'Next slide' },
      { k: '←',         d: 'Previous slide' },
      { k: '↑ / ↓',     d: 'Mark / un-mark this slide for deletion (Review triage)' },
      { k: 'Esc',       d: 'Close the slideshow' },
      { k: 'Swipe ← / →', d: 'Previous / next slide', kind: 'gesture' }
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
  G: ['Hold a cell, click another', 'R-click a grid cell'],
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
// buckets the renderer draws.
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

  // 5 — the global any-screen keys (their own collapsed section; a key already
  //     listed above is NOT repeated — the screen-specific meaning wins).
  var blocked = window.HK_USER_BLOCKED || [];
  reg.forEach(function (h) {
    if (typeof h.fn !== 'function' || !h.label || !h.desc) return;
    if (seen[normKey(h.label)]) return;
    globals.push({ k: h.label, d: h.desc, dev: blocked.indexOf(h.key) >= 0 });
  });
  reg.forEach(function (h) {
    if (typeof h.fn === 'function' || !h.label || !h.desc) return;
    if (h.scope !== 'global') return;
    if (seen[normKey(h.label)]) return;
    globals.push({ k: h.label, d: h.desc, dev: h.dev });
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
    else if (!s.textReader) c.push({ t: '⤢ 1× (swipe closes)', on: false });
    if (s.sectNav) c.push({ t: '▤ paged slide', on: true });
    if (s.slideshow) c.push({ t: '🖼 in slideshow', on: true });
    if (s.textReader) c.push({ t: '📖 text reader', on: true });
  } else if (s.code === 'G') {
    c.push({ t: s.gridSrc === 'C' ? 'source: C' + (s.cfgName ? ' · ' + s.cfgName : '') : 'source: T', on: s.gridSrc === 'C' });
    c.push({ t: 'layout: ' + s.layout + (s.layoutLocked ? ' (locked)' : ''), on: s.layoutLocked });
    if (s.gSect)    c.push({ t: '▤ 1a is a paged slide', on: true });
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
// ─────────────────────────────────────────────────────────────────────────────
function injectCss() {
  if ($id('hpCss')) return;
  var st = document.createElement('style');
  st.id = 'hpCss';
  st.textContent = [
    '#hpPanel{position:fixed;z-index:10000050;width:430px;max-width:calc(100vw - 20px);',
      'max-height:78vh;display:flex;flex-direction:column;background:rgba(10,10,26,0.985);',
      'border:2px solid #4af;border-radius:10px;box-shadow:0 8px 40px rgba(0,0,0,0.92);',
      'font-family:monospace;color:#cde;overflow:hidden;}',
    '#hpPanel.hp-hidden{display:none;}',
    '#hpHead{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#16213e;',
      'border-bottom:1px solid #2a2a4a;cursor:move;user-select:none;touch-action:none;}',
    '#hpHead .hp-t{flex:1;font-size:13px;font-weight:bold;color:#8cf;white-space:nowrap;',
      'overflow:hidden;text-overflow:ellipsis;}',
    '#hpPanel button{background:#1a1a2e;border:1px solid #46c;color:#bde;border-radius:4px;',
      'font-family:monospace;font-size:11px;padding:3px 8px;cursor:pointer;}',
    '#hpPanel button:hover{background:#24406e;border-color:#8cf;}',
    '#hpChips{display:flex;flex-wrap:wrap;gap:5px;padding:7px 10px 0;}',
    '#hpChips span{font-size:10px;padding:2px 7px;border-radius:9px;border:1px solid #2a3a5a;',
      'background:#111a2e;color:#8a9;}',
    '#hpChips span.on{border-color:#3d8;background:#0d2a1e;color:#7ec;}',
    '#hpDesc{padding:7px 10px 0;font-size:10px;line-height:1.5;color:#778;}',
    '#hpBody{overflow-y:auto;padding:4px 10px 10px;}',
    '.hp-sec{margin-top:10px;color:#556;font-size:10px;letter-spacing:0.06em;',
      'border-bottom:1px solid #1e2440;padding-bottom:3px;}',
    '.hp-sec.hp-fold{cursor:pointer;color:#79a;}',
    '.hp-row{display:flex;gap:9px;padding:4px 0;border-bottom:1px solid #14182c;align-items:baseline;}',
    '.hp-k{flex:0 0 118px;color:#fd8;font-size:11px;font-weight:bold;word-break:break-word;}',
    '.hp-d{flex:1;color:#bcd;font-size:11px;line-height:1.45;}',
    '.hp-dev{color:#647;font-size:9px;margin-left:5px;}',
    '.hp-badge{display:inline-block;background:#3a2a52;border:1px solid #96f;color:#c9f;',
      'border-radius:3px;font-size:9px;padding:0 4px;margin-right:5px;vertical-align:1px;}',
    '.hp-var{display:flex;gap:6px;font-size:10.5px;line-height:1.45;padding:2px 0 2px 10px;color:#89a;}',
    '.hp-var .hp-mark{flex:0 0 40px;color:#445;font-size:9px;}',
    '.hp-var.live{color:#8f9;}',
    '.hp-var.live .hp-mark{color:#3d8;font-weight:bold;}',
    '.hp-note{font-size:9.5px;color:#667;padding:2px 0 2px 10px;line-height:1.45;font-style:italic;}',
    '#hpFoot{padding:6px 10px;border-top:1px solid #2a2a4a;background:#0c1020;font-size:9.5px;color:#667;}',
    '#hpTip{position:fixed;z-index:10000060;pointer-events:none;max-width:280px;',
      'background:#101a30;color:#dfe;border:1px solid #6af;border-radius:6px;padding:5px 9px;',
      'font-family:monospace;font-size:11px;line-height:1.4;box-shadow:0 4px 18px rgba(0,0,0,0.8);',
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
var _hpTimer = null, _hpScreenAt = null, _hpGlobalOpen = false;
try { _hpGlobalOpen = localStorage.getItem(LS_GLOB) === '1'; } catch (_) {}

function hpIsOpen() { var p = $id(PANEL_ID); return !!p && !p.classList.contains('hp-hidden'); }

function hpBuild() {
  injectCss();
  var p = document.createElement('div');
  p.id = PANEL_ID;
  p.innerHTML =
      '<div id="hpHead">'
    +   '<span class="hp-t" id="hpTitle">Help</span>'
    +   '<button id="hpFull" title="Open the FULL reference — every screen, every key (Shift+H)">Full ref</button>'
    +   '<button id="hpClose" title="Close this panel (H or Esc)">✕</button>'
    + '</div>'
    + '<div id="hpChips"></div>'
    + '<div id="hpDesc"></div>'
    + '<div id="hpBody"></div>'
    + '<div id="hpFoot">'
    +   '<span class="hp-badge">◆</span>behaviour changes with context — the green <b>now ▸</b> is what it does at this moment. '
    +   'H closes · Shift+H = full reference.'
    + '</div>';
  // Appended to <body>, i.e. OUTSIDE #rotateWrap — same as the shareable menu,
  // so the drag maths can use raw client coords without rotateXY().
  document.body.appendChild(p);

  $id('hpClose').addEventListener('click', hpClose);
  $id('hpFull').addEventListener('click', function () {
    if (typeof openHelp === 'function') openHelp();
  });
  hpWireDrag(p, $id('hpHead'));
  hpRestorePos(p);
  return p;
}

function hpRestorePos(p) {
  var pos = null;
  try { pos = JSON.parse(localStorage.getItem(LS_POS) || 'null'); } catch (_) {}
  if (pos && isFinite(pos.l) && isFinite(pos.t)) {
    p.style.left = Math.max(0, Math.min(window.innerWidth  - 80, pos.l)) + 'px';
    p.style.top  = Math.max(0, Math.min(window.innerHeight - 40, pos.t)) + 'px';
  } else {
    p.style.left = Math.max(8, window.innerWidth - 450) + 'px';
    p.style.top  = '64px';
  }
}

function hpWireDrag(p, head) {
  var d = null;
  head.addEventListener('pointerdown', function (e) {
    if (e.target.tagName === 'BUTTON') return;
    var r = p.getBoundingClientRect();
    d = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    try { head.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  });
  head.addEventListener('pointermove', function (e) {
    if (!d) return;
    var l = Math.max(0, Math.min(window.innerWidth  - 60, e.clientX - d.dx));
    var t = Math.max(0, Math.min(window.innerHeight - 30, e.clientY - d.dy));
    p.style.left = l + 'px'; p.style.top = t + 'px';
  });
  function end() {
    if (!d) return;
    d = null;
    var r = p.getBoundingClientRect();
    try { localStorage.setItem(LS_POS, JSON.stringify({ l: Math.round(r.left), t: Math.round(r.top) })); } catch (_) {}
  }
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);
}

function rowHtml(r) {
  var h = '<div class="hp-row"><div class="hp-k">'
        + (r.ctx ? '<span class="hp-badge">◆</span>' : '')
        + esc(r.k) + '</div><div class="hp-d">' + esc(r.d)
        + (r.dev ? '<span class="hp-dev">dev</span>' : '');
  if (r.ctx) {
    for (var i = 0; i < r.ctx.length; i++) {
      var live = (i === r.live);
      h += '<div class="hp-var' + (live ? ' live' : '') + '" data-var="' + i + '">'
         + '<span class="hp-mark">' + (live ? 'now ▸' : '▹') + '</span>'
         + '<span>' + esc(r.ctx[i].d) + '</span></div>';
    }
    if (r.note) h += '<div class="hp-note">' + esc(r.note) + '</div>';
  }
  return h + '</div></div>';
}

function hpRender() {
  var p = $id(PANEL_ID) || hpBuild();
  var s = hpState();
  _hpScreenAt = s.code;
  var R = hpRows(s);

  $id('hpTitle').textContent = '⌨ ' + (HP_TITLES[s.code] || s.code);

  var chips = hpChips(s);
  $id('hpChips').innerHTML = chips.map(function (c) {
    return '<span class="' + (c.on ? 'on' : '') + '">' + esc(c.t) + '</span>';
  }).join('');

  $id('hpDesc').innerHTML = R.desc ? esc(R.desc) : '';

  var h = '';
  if (R.keys.length) {
    h += '<div class="hp-sec">⌨ HOTKEYS — THIS SCREEN</div>';
    R.keys.forEach(function (r) { h += rowHtml(r); });
  }
  if (R.gests.length) {
    h += '<div class="hp-sec">👆 GESTURES &amp; CONTROLS — THIS SCREEN</div>';
    R.gests.forEach(function (r) { h += rowHtml(r); });
  }
  if (!R.keys.length && !R.gests.length) {
    h += '<div class="hp-sec">NOTHING SCREEN-SPECIFIC HERE</div>'
       + '<div class="hp-row"><div class="hp-d">This window has no keys or gestures of its own — the global list below is all of it.</div></div>';
  }
  if (R.globals.length) {
    h += '<div class="hp-sec hp-fold" id="hpFold">'
       + (_hpGlobalOpen ? '▾' : '▸') + ' 🌐 GLOBAL — ANY SCREEN (' + R.globals.length + ')</div>'
       + '<div id="hpGlob" style="display:' + (_hpGlobalOpen ? 'block' : 'none') + '">';
    R.globals.forEach(function (r) { h += rowHtml(r); });
    h += '</div>';
  }
  var body = $id('hpBody');
  var keepScroll = body.scrollTop;
  body.innerHTML = h;
  body.scrollTop = keepScroll;

  var fold = $id('hpFold');
  if (fold) fold.addEventListener('click', function () {
    _hpGlobalOpen = !_hpGlobalOpen;
    try { localStorage.setItem(LS_GLOB, _hpGlobalOpen ? '1' : '0'); } catch (_) {}
    hpRender();
  });
}

// Cheap re-check while the panel is up: if the screen changed, redraw; otherwise
// just re-point the "now ▸" markers and refresh the chips. Full re-render on
// every tick would fight the reader's scroll position.
function hpTick() {
  if (!hpIsOpen()) return;
  var s = hpState();
  if (s.code !== _hpScreenAt) { hpRender(); return; }

  var chips = hpChips(s);
  $id('hpChips').innerHTML = chips.map(function (c) {
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
  hpRestorePos(p);
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
  var txt = el.getAttribute('data-tip') || '';
  $id('hpTipTxt').textContent = txt;
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
