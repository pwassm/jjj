
// ══════════════════════════════════════════════════════════════════════════════
// MOVING CELLS  (dev0374)  —  optional "ring conveyor" screensaver for the Grid
// ══════════════════════════════════════════════════════════════════════════════
//
// CONCEPT: the outer ring of an N×N grid — 4(N-1) cells — rotates CLOCKWISE one
// whole edge (N-1 tiles) at a time, pausing between edges. A ring cell may start
// EMPTY — that hole travels counter-clockwise corner-to-corner and is what the
// rotation slides into. (dev0383) If no cell is empty the conveyor still runs:
// the bottom-right corner becomes the mover, gliding to the top-right and on
// around the ring just like a hole would. On a 5×5 (ring 16, empty at 5e):
//     move 1  right edge   1e2e3e4e → 2e3e4e5e   (empty lands on 1e)
//     move 2  top edge     1a1b1c1d → 1b1c1d1e   (empty lands on 1a)
//     move 3  left edge     2a3a4a5a → 1a2a3a4a   (empty lands on 5a)
//     move 4  bottom edge   5b5c5d5e → 5a5b5c5d   (empty lands on 5e) → repeat
// (Generalised: it shifts the N-1 ring tiles preceding the hole, so any starting
// empty works — at a non-corner the slide just bends around the corner.)
//
// (dev0735) N is the LIVE grid size, not a hard-wired 5: a 4×4 runs the same
// conveyor on its 12-cell ring (3 tiles per edge), a 3×3 on its 8-cell ring. The
// 17 / 19 layouts sit on a 5×5 footprint and share the 5×5 ring as before.
//
// HOW IT STAYS SMOOTH WITHOUT KILLING LIVE VIDEO: it never re-parents or rebuilds
// a cell — it only changes each .grid-cell's CSS grid-area and FLIP-animates the
// gap with a transform. The iframe/<video> node is never removed from the DOM, so
// YouTube/Vimeo/mp4 keep playing and just glide. (Inner-media zoom/COI transforms
// live on the media element, not the cell, so they're untouched.)
//
// DESKTOP-FIRST by design (16 live videos + transforms is too much for phones).
// (dev0800) Advisory, not absolute — see collection.js _gmHeavyGate.
//
// ──────────────────────────────────────────────────────────────────────────────
// CUT-OUT INSTRUCTIONS — to remove the feature entirely, with zero grid impact:
//   1. delete this file
//   2. delete  'movingcells.js'  from the files[] array in index.html
//   3. delete the three  MovingCells.*  key handlers in collection.js
//      (search "MovingCells" in the grid keydown listener)
//   4. delete the one  window.MovingCells?.stop()  line in gridClose() (xe.js)
// Nothing else references it.
// ──────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── Tunables ────────────────────────────────────────────────────────────────
  var moveDur = 5;          // Y: seconds for one edge-slide (live, { / } adjust)
  var PAUSE   = 2;          // X: seconds parked between edge-slides
  var MIN_DUR = 1, MAX_DUR = 15;
  var EASE = 'cubic-bezier(.4,0,.2,1)';

  // ── Ring geometry (clockwise from top-left) + 1-based [row,col] placement ────
  // (dev0735) Built for the live grid size at start(), not hard-coded to 5×5.
  // N = grid edge, RLEN = ring length = 4(N-1). RING[i] is the cell string at ring
  // index i (clockwise from the top-left corner); RC[cs] is its [row,col].
  var N = 5, RLEN = 16;
  var RING = [], RC = {};

  function buildGeom(n) {
    N = n;
    RLEN = 4 * (n - 1);
    RING = []; RC = {};
    var add = function (r, c) { var s = r + 'abcde'[c - 1]; RING.push(s); RC[s] = [r, c]; };
    var i;
    for (i = 1; i <= n; i++)     add(1, i);   // top row     →
    for (i = 2; i <= n; i++)     add(i, n);   // right column ↓
    for (i = n - 1; i >= 1; i--) add(n, i);   // bottom row  ←
    for (i = n - 1; i >= 2; i--) add(i, 1);   // left column ↑
  }

  // (dev0800) Shared desktop gate — live detection + a "run it anyway" card.
  // See collection.js _gmHeavyGate. Local fallback if that file ever goes missing.
  function heavyOK() {
    if (typeof window._gmHeavyGate === 'function') return window._gmHeavyGate('The conveyor', start);
    var ok = !!(window.matchMedia && window.matchMedia('(any-pointer: fine)').matches);
    if (!ok) toast('Moving cells is desktop-only (too heavy for phones)', 2200);
    return ok;
  }

  // ── State ────────────────────────────────────────────────────────────────────
  var running = false;
  var timer   = null;
  var elemAt  = null;       // elemAt[i] = the .grid-cell currently shown at RING[i]
  var gapIdx  = -1;         // ring index of the empty cell

  function gridOpen() {
    var ov = document.getElementById('gridOverlay');
    return ov && ov.style.display === 'flex';
  }

  // (dev0735) The grid edge this conveyor should run on, or 0 if the layout has no
  // usable ring: square 3×3 / 4×4 / 5×5 all do (a 2×2 is all corner, no interior),
  // and the 17 / 19 layouts sit on a 5×5 footprint so they keep the 5×5 ring. The
  // portrait layouts (P3/P12/P27) aren't square and stay out.
  function ringSize() {
    var lay = (typeof _gridCurrentLayout === 'function') ? _gridCurrentLayout() : 'square';
    if (lay === '17' || lay === '19') return 5;
    if (lay !== 'square') return 0;
    var n = (typeof _gridGsize === 'number') ? _gridGsize : 5;
    return (n >= 3 && n <= 5) ? n : 0;
  }

  // Pin every cell to explicit grid placement so square-layout auto-flow can't
  // re-shuffle the untouched cells when we start moving ring cells around. Cells
  // that already carry an explicit placement (17/19 ring + spanning centre) and
  // the non-addressable special cells (1L/1P-3P) are left alone.
  function pinAll() {
    var c = document.getElementById('gridContainer');
    if (!c) return;
    c.querySelectorAll('.grid-cell').forEach(function (el) {
      if (el.style.gridRow) return;
      var p = (typeof parseGridCell === 'function') ? parseGridCell(el.dataset.cell) : null;
      if (!p) return;
      el.style.gridRow = p.row;
      el.style.gridColumn = p.col;
    });
  }

  // Map the live ring elements + locate the empty cell. Returns false if the grid
  // isn't fully laid out yet.
  function buildElemAt() {
    elemAt = new Array(RLEN).fill(null);
    gapIdx = -1;
    for (var i = 0; i < RLEN; i++) {
      var el = document.querySelector('#gridContainer .grid-cell[data-cell="' + RING[i] + '"]');
      if (!el) return false;
      elemAt[i] = el;
      if (gapIdx < 0 && !el._rowData) gapIdx = i;   // empty cells carry no _rowData
    }
    return true;
  }

  // One edge-slide: rotate the N-cell window [gap-(N-1) … gap] forward by one,
  // FLIP-animating each element from its old box to its new box. The N-1 content
  // tiles move one cell each; the empty slides the whole edge to the far corner.
  function step() {
    if (!running) return;
    var container = document.getElementById('gridContainer');
    if (!container || !gridOpen()) { stop(true); return; }
    for (var v = 0; v < RLEN; v++) { if (!elemAt[v] || !elemAt[v].isConnected) { stop(true); return; } }

    var gi = gapIdx;
    var W = [];                                    // gap-(N-1) … gap-1, gap
    for (var w = N - 1; w >= 1; w--) W.push((gi + RLEN - w) % RLEN);
    W.push(gi);
    var E = W.map(function (i) { return elemAt[i]; });

    var oldR = E.map(function (el) { return el.getBoundingClientRect(); });

    // FIRST→LAST: drop any prior transform, move each element to its new grid cell.
    for (var k = 0; k < N; k++) {
      var rc = RC[RING[W[(k + 1) % N]]];
      E[k].style.transition = 'none';
      E[k].style.transform  = '';
      E[k].style.gridRow    = rc[0];
      E[k].style.gridColumn = rc[1];
    }

    // INVERT: read the new boxes (forces layout), translate back to the old box.
    var newR = E.map(function (el) { return el.getBoundingClientRect(); });
    for (var j = 0; j < N; j++) {
      var dx = oldR[j].left - newR[j].left;
      var dy = oldR[j].top  - newR[j].top;
      E[j].style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    }

    container.offsetWidth;   // commit the inverted transform before the play frame

    // PLAY: glide each element to its real position.
    requestAnimationFrame(function () {
      for (var m = 0; m < N; m++) {
        E[m].style.transition = 'transform ' + moveDur + 's ' + EASE;
        E[m].style.transform  = 'translate(0px,0px)';
      }
    });

    // Commit the logical rotation in our position map; the hole moves back N-1 cells.
    var snap = W.map(function (i) { return elemAt[i]; });
    for (var n = 0; n < N; n++) elemAt[W[(n + 1) % N]] = snap[n];
    gapIdx = W[0];
  }

  function loop() {
    if (!running) return;
    step();
    timer = setTimeout(loop, (moveDur + PAUSE) * 1000);
  }

  function start() {
    if (running) return;
    if (!gridOpen()) return;
    if (!heavyOK()) return;
    var n = ringSize();
    if (!n) { toast('Moving cells needs a square 3×3-5×5, 17 or 19 grid', 2200); return; }
    buildGeom(n);
    if (!buildElemAt()) { toast('Grid still drawing — try again in a moment', 1800); return; }
    // (dev0383) No empty cell? Run anyway: seed the gap at the bottom-right corner
    // so that cell itself becomes the mover — it glides up the right edge and on
    // counter-clockwise around the ring exactly as a blank hole would, every ring
    // tile shifting one slot per edge.
    if (gapIdx < 0) gapIdx = RING.indexOf(N + 'abcde'[N - 1]);

    running = true;
    pinAll();
    toast('▶ Moving cells ON — move ' + moveDur + 's · pause ' + PAUSE + 's   ( { slower · } faster · r stops · f exits )', 3200);
    timer = setTimeout(loop, 500);
  }

  function stop(silent) {
    running = false;
    if (timer) { clearTimeout(timer); timer = null; }
    if (elemAt) {
      elemAt.forEach(function (el) {
        if (!el || !el.isConnected) return;
        var home = RC[el.dataset.cell];
        el.style.transition = 'none';
        el.style.transform  = '';
        if (home) { el.style.gridRow = home[0]; el.style.gridColumn = home[1]; }
      });
      var snapped = elemAt;
      requestAnimationFrame(function () {
        snapped.forEach(function (el) { if (el && el.isConnected) el.style.transition = ''; });
      });
    }
    if (!silent) toast('■ Moving cells OFF', 1400);
  }

  function toggle() { if (running) stop(false); else start(); }

  function announceSpeed() {
    if (typeof _gridToast === 'function') _gridToast('Conveyor move: ' + moveDur + 's  ·  pause ' + PAUSE + 's', 1100);
    else toast('Conveyor move: ' + moveDur + 's', 1100);
  }
  function slower() { moveDur = Math.min(MAX_DUR, moveDur + 1); announceSpeed(); }  // { key
  function faster() { moveDur = Math.max(MIN_DUR, moveDur - 1); announceSpeed(); }  // } key

  window.MovingCells = {
    toggle: toggle,
    start:  start,
    stop:   stop,
    faster: faster,
    slower: slower,
    get running() { return running; }
  };
})();
