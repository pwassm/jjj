
// ══════════════════════════════════════════════════════════════════════════════
// FLY CELLS 2  (dev0387)  —  Grid "moving cells" VARIANT 2  (smooth swap engine)
// ══════════════════════════════════════════════════════════════════════════════
//
// Sibling of flycells.js (variant 1). Same family entry:  r  starts the conveyor,
// then a NUMBER key picks the variant —  1 = v1 (cascade fill),  2 = v2 (this).
// (Routing lives in collection.js.)
//
// WHAT'S DIFFERENT FROM v1:
//   1. SINGLE CLEAN PATH, NO COURSE CHANGES. v1 re-cascaded a whole footprint
//      group on every tick, so a cell already gliding got retargeted mid-flight →
//      the motion broke into 2-3 segments with kinks once several cells moved. v2
//      uses a UNIT-GRID SWAP engine: each move is a straight-line translate, and a
//      cell that is mid-animation is BUSY and is never chosen / retargeted until it
//      lands. So every cell follows one continuous path, however many are moving.
//   2. BIG / PORTRAIT CELLS DISPLACE PERMANENTLY. In layouts 17/19, clicking the
//      big 1L (3×3) or a portrait 1P/2P/3P (3×1) relocates it onto a destination
//      footprint of its own shape; the small cells sitting there are pushed into
//      the units it vacates, and it STAYS (v1 free-floated/snapped — gone here).
//      Two equal-shape cells (e.g. two P's) simply trade places.
//
// THE PARADIGM: every cell is a rectangle of unit slots on the gsize×gsize (or 5×5
// for 17/19) grid. `occ[r][c]` tracks which element owns each unit. A move is a
// PERMUTATION of a set of units (a swap, or a big cell + the smalls it displaces),
// so the unit set is conserved and every animation is a straight A→B glide. We
// FLIP only the involved cells (every cell is pinned to an explicit grid-area, so
// reassigning a few never reflows the rest). Live video keeps playing — cells are
// never reparented, only their grid-area + transform change. Clicks are caught in
// capture before .grid-interactor. Desktop-only (same gate as the conveyor).
//
// ──────────────────────────────────────────────────────────────────────────────
// CUT-OUT INSTRUCTIONS: 1) delete this file  2) remove 'flycells2.js' from files[]
// in index.html  3) drop the FlyCells2 branches in collection.js (search FlyCells2)
// 4) delete the window.FlyCells2?.stop() line in gridClose() (xe.js). Nothing else
// references it.
// ──────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── Tunables ──────────────────────────────────────────────────────────────
  var MOVE_DUR = 2.5;   // x: seconds for one straight glide
  var REFIRE   = 3.3;   // y: seconds between a mover's successive moves
  var EASE     = 'cubic-bezier(.4,0,.2,1)';

  var DESKTOP = !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);

  // ── State ──────────────────────────────────────────────────────────────────
  var active = false;
  var wired  = false;
  var movers = new Map();         // element → REFIRE timeout id
  var occ    = null;              // occ[r][c] = element owning unit (r,c)  (1-based)
  var dims   = { R: 0, C: 0 };
  var smalls = [];                // all 1×1 cells
  var allCells = [];
  var zc = 200;

  function container() { return document.getElementById('gridContainer'); }
  function gridOpen()  { var o = document.getElementById('gridOverlay'); return !!(o && o.style.display === 'flex'); }
  function layout()    { return (typeof _gridCurrentLayout === 'function') ? _gridCurrentLayout() : 'square'; }
  function randInt(n)  { return Math.floor(Math.random() * n); }
  function now()       { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function busy(el)    { return (el._fc2Busy || 0) > now(); }
  function cl(p)       { return { r: p.r, c: p.c, rs: p.rs, cls: p.cls }; }
  function samePos(a, b) { return a.r === b.r && a.c === b.c && a.rs === b.rs && a.cls === b.cls; }
  function unitsOf(p)  { var u = []; for (var r = p.r; r < p.r + p.rs; r++) for (var c = p.c; c < p.c + p.cls; c++) u.push([r, c]); return u; }

  function setPos(el, p) {
    el._fc2Pos = p;
    el.style.gridRow    = p.r + ' / span ' + p.rs;
    el.style.gridColumn = p.c + ' / span ' + p.cls;
  }

  // Build the unit grid + occupancy from the active layout. Pin every cell to an
  // explicit grid-area (square cells are normally auto-flowed) and capture its
  // home area for restore.
  function build() {
    var cont = container(); if (!cont) return false;
    var gsize = (typeof _gridGsize !== 'undefined') ? _gridGsize : 5;
    var specs = (typeof _gridCellList === 'function') ? _gridCellList(gsize, layout()) : [];
    if (!specs.length) return false;

    dims.R = 0; dims.C = 0; smalls = []; allCells = [];
    var placed = [];
    for (var i = 0; i < specs.length; i++) {
      var s = specs[i];
      var el = cont.querySelector('.grid-cell[data-cell="' + s.cs + '"]');
      if (!el) continue;
      if (el._fc2HomeGR === undefined) { el._fc2HomeGR = el.style.gridRow; el._fc2HomeGC = el.style.gridColumn; }
      var p = { r: s.r, c: s.c, rs: s.rs, cls: s.cls };
      setPos(el, p);
      el._fc2Busy = 0;
      placed.push(el);
      allCells.push(el);
      if (s.rs === 1 && s.cls === 1) smalls.push(el);
      dims.R = Math.max(dims.R, s.r + s.rs - 1);
      dims.C = Math.max(dims.C, s.c + s.cls - 1);
    }
    if (!placed.length) return false;

    occ = [];
    for (var r = 0; r <= dims.R; r++) occ.push(new Array(dims.C + 1).fill(null));
    placed.forEach(function (el) { unitsOf(el._fc2Pos).forEach(function (u) { occ[u[0]][u[1]] = el; }); });
    return true;
  }

  // Plan a move for element E. Returns a batch [{el,to}, …] (a unit permutation)
  // or null if nothing valid/free right now.
  function planMove(E) {
    var pos = E._fc2Pos;
    // ── Small cell: swap with a random OTHER free small cell ──────────────────
    if (pos.rs === 1 && pos.cls === 1) {
      var cands = smalls.filter(function (s) { return s !== E && !busy(s); });
      if (!cands.length) return null;
      var T = cands[randInt(cands.length)];
      return [{ el: E, to: cl(T._fc2Pos) }, { el: T, to: cl(pos) }];
    }
    // ── Big / portrait: enumerate same-shape destinations, pick a valid one ───
    var rs = pos.rs, cls = pos.cls, opts = [];
    for (var r = 1; r + rs - 1 <= dims.R; r++) {
      for (var c = 1; c + cls - 1 <= dims.C; c++) {
        if (r === pos.r && c === pos.c) continue;
        var plan = planBigInto(E, { r: r, c: c, rs: rs, cls: cls });
        if (plan) opts.push(plan);
      }
    }
    return opts.length ? opts[randInt(opts.length)] : null;
  }

  // Try to move big/portrait E into footprint N. Either a clean swap with one
  // same-shape partner, or a displacement that pushes the small cells in N\O into
  // the units E vacates (O\N). Returns a batch or null if invalid/busy.
  function planBigInto(E, N) {
    var O = E._fc2Pos;
    var Ounits = unitsOf(O), Nunits = unitsOf(N);
    var Oset = {}; Ounits.forEach(function (u) { Oset[u[0] + ',' + u[1]] = 1; });
    var NminusO = [], overlap = [], seen = [];
    for (var k = 0; k < Nunits.length; k++) {
      var u = Nunits[k];
      if (Oset[u[0] + ',' + u[1]]) continue;          // E's own unit — no conflict
      NminusO.push(u);
      var o = occ[u[0]][u[1]];
      if (o && o !== E && seen.indexOf(o) < 0) { seen.push(o); overlap.push(o); }
    }
    if (!overlap.length) return null;

    // Swap with a single same-shape partner that exactly fills N.
    if (overlap.length === 1) {
      var P = overlap[0];
      if (samePos(P._fc2Pos, N) && P._fc2Pos.rs === O.rs && P._fc2Pos.cls === O.cls) {
        return busy(P) ? null : [{ el: E, to: cl(N) }, { el: P, to: cl(O) }];
      }
    }
    // Otherwise every displaced occupant must be a free SMALL cell.
    for (var i = 0; i < overlap.length; i++) {
      var ov = overlap[i];
      if (ov._fc2Pos.rs !== 1 || ov._fc2Pos.cls !== 1 || busy(ov)) return null;
    }
    var Nset = {}; Nunits.forEach(function (u) { Nset[u[0] + ',' + u[1]] = 1; });
    var V = Ounits.filter(function (u) { return !Nset[u[0] + ',' + u[1]]; });   // O\N
    var D = NminusO.map(function (u) { return occ[u[0]][u[1]]; });               // smalls to displace
    if (D.length !== V.length) return null;

    // Nearest-greedy bijection D→V to keep the straight paths from crossing.
    var batch = [{ el: E, to: cl(N) }], usedV = new Array(V.length).fill(false);
    for (var di = 0; di < D.length; di++) {
      var du = NminusO[di], best = -1, bd = 1e9;
      for (var vi = 0; vi < V.length; vi++) {
        if (usedV[vi]) continue;
        var dist = Math.abs(V[vi][0] - du[0]) + Math.abs(V[vi][1] - du[1]);
        if (dist < bd) { bd = dist; best = vi; }
      }
      usedV[best] = true;
      batch.push({ el: D[di], to: { r: V[best][0], c: V[best][1], rs: 1, cls: 1 } });
    }
    return batch;
  }

  // Apply a batch: reassign grid-areas + occupancy, then FLIP every involved cell
  // along a single straight line. Marks them busy for the glide's duration.
  function animateBatch(batch) {
    var cont = container(); if (!cont) return;
    var olds = batch.map(function (b) { return b.el.getBoundingClientRect(); });
    batch.forEach(function (b) { b.el.style.transition = 'none'; b.el.style.transform = ''; });
    batch.forEach(function (b) { setPos(b.el, b.to); });
    // The batch is a permutation of one unit set, so reassigning every new unit
    // fully repopulates occ for the cells that moved.
    batch.forEach(function (b) { unitsOf(b.to).forEach(function (u) { occ[u[0]][u[1]] = b.el; }); });

    cont.offsetWidth;                                   // force the new layout
    var news = batch.map(function (b) { return b.el.getBoundingClientRect(); });
    for (var i = 0; i < batch.length; i++) {
      var dx = olds[i].left - news[i].left, dy = olds[i].top - news[i].top;
      batch[i].el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    }
    cont.offsetWidth;                                   // commit inverted transforms

    var endAt = now() + MOVE_DUR * 1000;
    batch.forEach(function (b) { b.el._fc2Busy = endAt; b.el.style.zIndex = ++zc; });
    batch[0].el.style.zIndex = ++zc;                    // mover (incl. big cell) rides on top
    requestAnimationFrame(function () {
      batch.forEach(function (b) {
        b.el.style.transition = 'transform ' + MOVE_DUR + 's ' + EASE;
        b.el.style.transform  = 'translate(0,0)';
      });
    });
  }

  function step(E) {
    if (!E.isConnected) { stopMover(E); return; }
    if (busy(E)) return;                                // never interrupt an in-flight glide
    var batch = planMove(E);
    if (batch) animateBatch(batch);
  }

  function arm(E) {
    if (!movers.has(E)) return;
    movers.set(E, setTimeout(function () {
      if (!active || !movers.has(E)) return;
      step(E);
      arm(E);
    }, REFIRE * 1000));
  }

  function startMover(E) {
    if (movers.has(E)) { step(E); return; }             // re-click → kick a move if free
    movers.set(E, null);
    step(E);
    arm(E);
  }

  function stopMover(E) {
    var id = movers.get(E);
    if (id) clearTimeout(id);
    movers.delete(E);
  }

  function onPointerDown(e) {
    if (!active) return;
    if (e.button !== undefined && e.button !== 0) return;
    var cont = container();
    var cell = e.target && e.target.closest ? e.target.closest('.grid-cell') : null;
    if (!cell || !cont || !cont.contains(cell) || cell._fc2Pos === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    startMover(cell);
  }

  function ensureWired() {
    if (wired) return;
    var cont = container(); if (!cont) return;
    cont.addEventListener('pointerdown', onPointerDown, true);
    wired = true;
  }

  function restoreAll() {
    var cont = container(); if (!cont) return;
    var cells = cont.querySelectorAll('.grid-cell');
    cells.forEach(function (el) {
      el.style.transition = 'none';
      el.style.transform  = '';
      el.style.zIndex     = '';
      if (el._fc2HomeGR !== undefined) { el.style.gridRow = el._fc2HomeGR; el.style.gridColumn = el._fc2HomeGC; }
      delete el._fc2HomeGR; delete el._fc2HomeGC; delete el._fc2Pos; delete el._fc2Busy;
    });
    requestAnimationFrame(function () {
      cells.forEach(function (el) { if (el.isConnected) el.style.transition = ''; });
    });
  }

  function start() {
    if (!gridOpen()) return false;
    if (!DESKTOP) { toast('Variant 2 is desktop-only (too heavy for phones)', 2200); return false; }
    if (!build()) { toast('Grid still drawing — try again in a moment', 1600); return false; }
    ensureWired();
    active = true;
    zc = 200;
    toast('✦ Variant 2 — click cells: each glides in one smooth path, swapping places. Big 1L / portrait cells push the small cells aside & stay. ( r exits )', 4800);
    return true;
  }

  function stop() {
    movers.forEach(function (id) { if (id) clearTimeout(id); });
    movers.clear();
    if (occ) restoreAll();
    occ = null; smalls = []; allCells = [];
    active = false; zc = 200;
  }

  window.FlyCells2 = {
    start: start,
    stop:  stop,
    get active() { return active; }
  };
})();
