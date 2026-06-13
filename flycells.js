
// ══════════════════════════════════════════════════════════════════════════════
// FLY CELLS  (dev0385 / revised dev0386)  —  Grid "moving cells" VARIANT 1
// ══════════════════════════════════════════════════════════════════════════════
//
// The Grid has a family of "moving cells" toys. The ring CONVEYOR (movingcells.js)
// is the base, started with  r . While any moving mode runs, the NUMBER keys pick
// a variant:  1  = this one (click-to-fly). (2-9 reserved for future variants.)
// Pressing  r  again turns the whole system off. (Routing lives in collection.js.)
//
// VARIANT 1 — CLICK TO FLY:
//   • Click any cell. Over ~MOVE_DUR seconds it glides to a RANDOM slot, and the
//     cells in between smoothly shift one slot to FILL THE GAP it left — just like
//     the conveyor, but the source and destination are arbitrary, not edge-locked.
//   • Every ~REFIRE seconds that cell picks a NEW random slot and glides again, on
//     its own. Click more cells and they ALL keep moving independently — two, three,
//     as many as you like are in motion at once (heavier hardware permitting).
//   • Cells never tilt or scale: each frame stays its own orthogonal rectangle. It
//     is a pure DISPLACEMENT — a permutation of which cell sits in which slot.
//
// HOW GAP-FILL STAYS GEOMETRICALLY SANE WITH MIXED CELL SIZES (layouts 17 & 19):
//   Cells are bucketed into FOOTPRINT GROUPS by their row/col span. The slot
//   permutation only ever happens WITHIN a group, so a 1×1 ring cell only swaps
//   into 1×1 ring slots, the three 3×1 portrait cells (1P/2P/3P) only swap among
//   themselves, and the lone 3×3 big cell (1L) — which has no same-size partner —
//   instead FREE-FLOATS: it glides to a random spot and STAYS there until its next
//   move (no snapping back to home, which was the old bug). Square grids are one
//   single 1×1 group, so the whole 5×5 cascades.
//
// KEEPS LIVE VIDEO ALIVE: like movingcells.js it NEVER reparents/rebuilds a cell —
// it only reassigns CSS grid-area and FLIP-animates the gap with a transform, so
// YouTube/Vimeo/mp4 keep playing as they glide. Clicks are caught in capture phase
// before the cell's .grid-interactor, so tap-to-play never fires while flying.
//
// DESKTOP-ONLY by design (many live videos + concurrent FLIPs is too heavy for
// phones — same gate as the conveyor).
//
// ──────────────────────────────────────────────────────────────────────────────
// CUT-OUT INSTRUCTIONS — to remove the feature entirely, with zero grid impact:
//   1. delete this file
//   2. delete  'flycells.js'  from the files[] array in index.html
//   3. in collection.js, drop the FlyCells branches from the grid key handler
//      (search "FlyCells" — the digit-key variant routing + the r master toggle)
//   4. delete the one  window.FlyCells?.stop()  line in gridClose() (xe.js)
// Nothing else references it.
// ──────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── Tunables ──────────────────────────────────────────────────────────────
  var MOVE_DUR = 2.5;   // x: seconds for one cell to glide to its new slot
  var REFIRE   = 3.3;   // y: seconds between a mover's successive moves
  var EASE     = 'cubic-bezier(.4,0,.2,1)';

  var DESKTOP = !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);

  // ── State ──────────────────────────────────────────────────────────────────
  var active  = false;
  var wired   = false;            // capture click listener attached once
  var movers  = new Map();        // element → timeout id (its REFIRE timer)
  var groups  = null;             // [{ key, slots:[{gr,gc}], occ:[el,…] }]
  var groupOf = new Map();        // element → its group object
  var zc      = 200;              // climbing z-index (interactor sits at 100)

  function container() { return document.getElementById('gridContainer'); }
  function gridOpen()  { var o = document.getElementById('gridOverlay'); return !!(o && o.style.display === 'flex'); }
  function layout()    { return (typeof _gridCurrentLayout === 'function') ? _gridCurrentLayout() : 'square'; }
  function rand(a, b)  { return a + Math.random() * (b - a); }
  function randInt(n)  { return Math.floor(Math.random() * n); }

  // Build footprint groups from the active layout's cell list. Captures each
  // cell's HOME grid-area and pins every cell to an explicit grid-area (square
  // cells are normally auto-flowed) so the permutation can reassign slots freely.
  function buildGroups() {
    groups = []; groupOf = new Map();
    var cont = container(); if (!cont) return false;
    var gsize = (typeof _gridGsize !== 'undefined') ? _gridGsize : 5;
    var specs = (typeof _gridCellList === 'function') ? _gridCellList(gsize, layout()) : [];
    if (!specs.length) return false;
    var byKey = {};
    for (var i = 0; i < specs.length; i++) {
      var s  = specs[i];
      var el = cont.querySelector('.grid-cell[data-cell="' + s.cs + '"]');
      if (!el) continue;
      if (el._flyHomeGR === undefined) { el._flyHomeGR = el.style.gridRow; el._flyHomeGC = el.style.gridColumn; }
      var gr = s.r + ' / span ' + s.rs;
      var gc = s.c + ' / span ' + s.cls;
      el.style.gridRow = gr; el.style.gridColumn = gc;
      var key = s.rs + 'x' + s.cls;
      if (!byKey[key]) { byKey[key] = { key: key, slots: [], occ: [] }; groups.push(byKey[key]); }
      byKey[key].slots.push({ gr: gr, gc: gc });
      byKey[key].occ.push(el);
      groupOf.set(el, byKey[key]);
    }
    return groups.length > 0;
  }

  // FLIP every element of a group from its current visual box to the box of the
  // slot its new occ-index points at. Reading the old rects first (while any
  // in-flight transform is still applied) lets concurrent movers continue
  // smoothly from wherever they currently are.
  function relayoutGroup(g) {
    var olds = g.occ.map(function (el) { return el.getBoundingClientRect(); });
    for (var k = 0; k < g.occ.length; k++) {
      var el = g.occ[k];
      el.style.transition = 'none';
      el.style.transform  = '';
      el.style.gridRow     = g.slots[k].gr;
      el.style.gridColumn  = g.slots[k].gc;
    }
    container().offsetWidth;                                  // force the new layout
    var news = g.occ.map(function (el) { return el.getBoundingClientRect(); });
    for (var j = 0; j < g.occ.length; j++) {
      var dx = olds[j].left - news[j].left;
      var dy = olds[j].top  - news[j].top;
      if (dx || dy) g.occ[j].style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    }
    container().offsetWidth;                                  // commit inverted transforms
    requestAnimationFrame(function () {
      for (var m = 0; m < g.occ.length; m++) {
        g.occ[m].style.transition = 'transform ' + MOVE_DUR + 's ' + EASE;
        g.occ[m].style.transform  = 'translate(0,0)';
      }
    });
  }

  // Lone big cell (a group of one — e.g. 1L): no swap partner, so it just glides
  // to a random position inside the grid and STAYS, floating over the others.
  function freeFloat(el) {
    var cont = container(); if (!cont) return;
    var cr = cont.getBoundingClientRect();
    if (!el._flyHomeRect) {
      var b = el.getBoundingClientRect();
      el._flyHomeRect = { l: b.left - cr.left, t: b.top - cr.top, w: b.width, h: b.height };
    }
    var h = el._flyHomeRect;
    var tx = rand(0, Math.max(0, cr.width  - h.w)) - h.l;
    var ty = rand(0, Math.max(0, cr.height - h.h)) - h.t;
    el.style.transition = 'transform ' + MOVE_DUR + 's ' + EASE;
    el.style.transform  = 'translate(' + tx + 'px,' + ty + 'px)';   // pure displacement — no tilt/scale
    el.style.zIndex     = ++zc;
  }

  // One move for a mover: permute its group (gap-fill) or free-float if alone.
  function moverStep(el) {
    if (!el.isConnected) { stopMover(el); return; }
    var g = groupOf.get(el);
    if (g && g.occ.length > 1) {
      var i = g.occ.indexOf(el);
      if (i < 0) return;
      var j; do { j = randInt(g.occ.length); } while (j === i);
      var moved = g.occ.splice(i, 1)[0];
      g.occ.splice(j, 0, moved);
      relayoutGroup(g);
      el.style.zIndex = ++zc;       // ride over the others during the glide
    } else {
      freeFloat(el);
    }
  }

  function armNext(el) {
    if (!movers.has(el)) return;
    movers.set(el, setTimeout(function () {
      if (!active || !movers.has(el)) return;
      moverStep(el);
      armNext(el);
    }, REFIRE * 1000));
  }

  // Click → make this cell a mover (immediate first move + its own REFIRE timer).
  // Clicking an existing mover just kicks an extra immediate move.
  function startMover(el) {
    if (movers.has(el)) { moverStep(el); return; }
    movers.set(el, null);
    moverStep(el);
    armNext(el);
  }

  function stopMover(el) {
    var id = movers.get(el);
    if (id) clearTimeout(id);
    movers.delete(el);
  }

  // Capture-phase pointerdown — eats the tap before .grid-interactor reacts.
  function onPointerDown(e) {
    if (!active) return;
    if (e.button !== undefined && e.button !== 0) return;     // left / touch only
    var cont = container();
    var cell = e.target && e.target.closest ? e.target.closest('.grid-cell') : null;
    if (!cell || !cont || !cont.contains(cell)) return;
    e.preventDefault();
    e.stopPropagation();
    startMover(cell);
  }

  function ensureWired() {
    if (wired) return;
    var cont = container(); if (!cont) return;
    cont.addEventListener('pointerdown', onPointerDown, true);  // capture
    wired = true;
  }

  // Snap every cell home and drop all inline styling. Returns grid-area to the
  // captured home (square cells → '' so auto-flow resumes; 17/19 → their spans).
  function restoreAll() {
    var cont = container(); if (!cont) return;
    var cells = cont.querySelectorAll('.grid-cell');
    cells.forEach(function (el) {
      el.style.transition = 'none';
      el.style.transform  = '';
      el.style.zIndex     = '';
      if (el._flyHomeGR !== undefined) { el.style.gridRow = el._flyHomeGR; el.style.gridColumn = el._flyHomeGC; }
      delete el._flyHomeGR; delete el._flyHomeGC; delete el._flyHomeRect;
    });
    requestAnimationFrame(function () {
      cells.forEach(function (el) { if (el.isConnected) el.style.transition = ''; });
    });
  }

  function start() {
    if (!gridOpen()) return false;
    if (!DESKTOP) { toast('Variant 1 is desktop-only (too heavy for phones)', 2200); return false; }
    if (!buildGroups()) { toast('Grid still drawing — try again in a moment', 1600); return false; }
    ensureWired();
    active = true;
    toast('✈ Variant 1 — click cells to fly them to random slots; others fill the gap. Click more for several at once. ( r exits )', 4500);
    return true;
  }

  // Full stop + restore. Safe to call when not running.
  function stop() {
    movers.forEach(function (id) { if (id) clearTimeout(id); });
    movers.clear();
    if (groups) restoreAll();
    groups = null; groupOf = new Map();
    active = false; zc = 200;
  }

  window.FlyCells = {
    start: start,
    stop:  stop,
    get active() { return active; }
  };
})();
