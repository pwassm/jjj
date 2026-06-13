
// ══════════════════════════════════════════════════════════════════════════════
// MOVING CELLS  (dev0374)  —  optional "ring conveyor" screensaver for the Grid
// ══════════════════════════════════════════════════════════════════════════════
//
// CONCEPT: the 16-cell outer ring of a 5-footprint grid (square 5×5, or layouts
// 17 / 19) rotates CLOCKWISE one whole edge (4 tiles) at a time, pausing between
// edges. A ring cell may start EMPTY — that hole travels counter-clockwise
// corner-to-corner and is what the rotation slides into. (dev0383) If no cell is
// empty the conveyor still runs: 5e becomes the mover, gliding to 1e and around
// the ring just like a hole would. With the empty (or mover) at 5e the
// motion is exactly:
//     move 1  right edge   1e2e3e4e → 2e3e4e5e   (empty lands on 1e)
//     move 2  top edge     1a1b1c1d → 1b1c1d1e   (empty lands on 1a)
//     move 3  left edge     2a3a4a5a → 1a2a3a4a   (empty lands on 5a)
//     move 4  bottom edge   5b5c5d5e → 5a5b5c5d   (empty lands on 5e) → repeat
// (Generalised: it shifts the 4 ring tiles preceding the hole, so any starting
// empty works — at a non-corner the slide just bends around the corner.)
//
// HOW IT STAYS SMOOTH WITHOUT KILLING LIVE VIDEO: it never re-parents or rebuilds
// a cell — it only changes each .grid-cell's CSS grid-area and FLIP-animates the
// gap with a transform. The iframe/<video> node is never removed from the DOM, so
// YouTube/Vimeo/mp4 keep playing and just glide. (Inner-media zoom/COI transforms
// live on the media element, not the cell, so they're untouched.)
//
// DESKTOP-ONLY by design (16 live videos + transforms is too much for phones).
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
  var RING = ['1a','1b','1c','1d','1e','2e','3e','4e','5e','5d','5c','5b','5a','4a','3a','2a'];
  var RC = {
    '1a':[1,1],'1b':[1,2],'1c':[1,3],'1d':[1,4],'1e':[1,5],
    '2e':[2,5],'3e':[3,5],'4e':[4,5],
    '5e':[5,5],'5d':[5,4],'5c':[5,3],'5b':[5,2],'5a':[5,1],
    '4a':[4,1],'3a':[3,1],'2a':[2,1]
  };

  var DESKTOP = !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);

  // ── State ────────────────────────────────────────────────────────────────────
  var running = false;
  var timer   = null;
  var elemAt  = null;       // elemAt[i] = the .grid-cell currently shown at RING[i]
  var gapIdx  = -1;         // ring index of the empty cell

  function gridOpen() {
    var ov = document.getElementById('gridOverlay');
    return ov && ov.style.display === 'flex';
  }

  function eligibleLayout() {
    var lay = (typeof _gridCurrentLayout === 'function') ? _gridCurrentLayout() : 'square';
    if (lay === '17' || lay === '19') return true;
    return lay === 'square' && (typeof _gridGsize === 'undefined' || _gridGsize === 5);
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
    elemAt = new Array(16).fill(null);
    gapIdx = -1;
    for (var i = 0; i < 16; i++) {
      var el = document.querySelector('#gridContainer .grid-cell[data-cell="' + RING[i] + '"]');
      if (!el) return false;
      elemAt[i] = el;
      if (gapIdx < 0 && !el._rowData) gapIdx = i;   // empty cells carry no _rowData
    }
    return true;
  }

  // One edge-slide: rotate the 5-cell window [gap-4 … gap] forward by one, FLIP-
  // animating each element from its old box to its new box. The 4 content tiles
  // move one cell each; the empty slides the whole edge to the far corner.
  function step() {
    if (!running) return;
    var container = document.getElementById('gridContainer');
    if (!container || !gridOpen()) { stop(true); return; }
    for (var v = 0; v < 16; v++) { if (!elemAt[v] || !elemAt[v].isConnected) { stop(true); return; } }

    var gi = gapIdx;
    var W = [(gi + 12) % 16, (gi + 13) % 16, (gi + 14) % 16, (gi + 15) % 16, gi];  // gap-4..gap
    var E = W.map(function (i) { return elemAt[i]; });

    var oldR = E.map(function (el) { return el.getBoundingClientRect(); });

    // FIRST→LAST: drop any prior transform, move each element to its new grid cell.
    for (var k = 0; k < 5; k++) {
      var rc = RC[RING[W[(k + 1) % 5]]];
      E[k].style.transition = 'none';
      E[k].style.transform  = '';
      E[k].style.gridRow    = rc[0];
      E[k].style.gridColumn = rc[1];
    }

    // INVERT: read the new boxes (forces layout), translate back to the old box.
    var newR = E.map(function (el) { return el.getBoundingClientRect(); });
    for (var j = 0; j < 5; j++) {
      var dx = oldR[j].left - newR[j].left;
      var dy = oldR[j].top  - newR[j].top;
      E[j].style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    }

    container.offsetWidth;   // commit the inverted transform before the play frame

    // PLAY: glide each element to its real position.
    requestAnimationFrame(function () {
      for (var m = 0; m < 5; m++) {
        E[m].style.transition = 'transform ' + moveDur + 's ' + EASE;
        E[m].style.transform  = 'translate(0px,0px)';
      }
    });

    // Commit the logical rotation in our position map; the hole moves back 4 cells.
    var snap = W.map(function (i) { return elemAt[i]; });
    for (var n = 0; n < 5; n++) elemAt[W[(n + 1) % 5]] = snap[n];
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
    if (!DESKTOP) { toast('Moving cells is desktop-only (too heavy for phones)', 2200); return; }
    if (!eligibleLayout()) { toast('Moving cells needs a 5×5, 17 or 19 grid', 2200); return; }
    if (!buildElemAt()) { toast('Grid still drawing — try again in a moment', 1800); return; }
    // (dev0383) No empty cell? Run anyway: seed the gap at 5e so that cell itself
    // becomes the mover — it glides 5e→1e and on counter-clockwise around the ring
    // exactly as a blank hole would, every ring tile shifting one slot per edge.
    if (gapIdx < 0) gapIdx = RING.indexOf('5e');

    running = true;
    pinAll();
    toast('▶ Moving cells ON — move ' + moveDur + 's · pause ' + PAUSE + 's   ( { slower · } faster · r stop )', 3200);
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
