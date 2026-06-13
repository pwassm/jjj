
// ══════════════════════════════════════════════════════════════════════════════
// FLY CELLS  (dev0385)  —  click-to-fling toy for the Grid  (pure play)
// ══════════════════════════════════════════════════════════════════════════════
//
// CONCEPT: press  r  on the Grid to enter "fly mode". Now CLICK any cell and it
// glides off to a RANDOM spot inside the grid — not constrained to the ring, an
// edge, or a direction (unlike the movingcells.js conveyor). Any cell can fly:
// ring cells, the center, and the big spanning cells of layouts 17 (1L) and 19
// (1P/2P/3P). Click as many as you like — unlimited cells can be in flight, each
// floating ON TOP of the stationary cells (so the originals stay visible
// underneath the gap it left, and the flown cell overlays wherever it lands).
// Press  r  again to send everything home (reset to base); a second  r  with
// nothing in flight leaves fly mode.
//
// HOW IT KEEPS LIVE VIDEO ALIVE: exactly like movingcells.js — it NEVER reparents
// or rebuilds a cell. A flung cell just gets a CSS transform (translate + a little
// playful rotate/scale) and a raised z-index, animated. The iframe/<video> node
// is never touched, so YouTube/Vimeo/mp4 keep playing as they sail across. Inner-
// media zoom/COI transforms live on the media element (not the cell), so they're
// untouched too. We intercept the click in capture-phase BEFORE the cell's
// .grid-interactor sees it, so the normal tap-to-play never fires in fly mode.
//
// ──────────────────────────────────────────────────────────────────────────────
// CUT-OUT INSTRUCTIONS — to remove the feature entirely, with zero grid impact:
//   1. delete this file
//   2. delete  'flycells.js'  from the files[] array in index.html
//   3. in collection.js, restore the  r / R  grid key branch to call only
//      MovingCells.toggle()  (search "FlyCells" there)
//   4. delete the one  window.FlyCells?.stop()  line in gridClose() (xe.js)
// Nothing else references it.
// ──────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── Tunables ──────────────────────────────────────────────────────────────
  var FLY_DUR  = 0.7;                          // seconds for one fling glide
  var EASE     = 'cubic-bezier(.34,1.2,.34,1)';// slight overshoot — feels springy
  var MAX_ROT  = 7;                            // ± degrees of playful tilt
  var SCALE_LO = 0.9, SCALE_HI = 1.12;         // random pop on landing

  // ── State ──────────────────────────────────────────────────────────────────
  var active = false;
  var flung  = new Set();   // cells currently displaced from home
  var zc     = 200;         // climbing z-index (interactor sits at 100)
  var wired  = false;       // capture click listener attached once

  function container() { return document.getElementById('gridContainer'); }
  function gridOpen() {
    var ov = document.getElementById('gridOverlay');
    return !!(ov && ov.style.display === 'flex');
  }
  function rand(a, b) { return a + Math.random() * (b - a); }

  // Send one cell to a fresh random destination inside the grid.
  function fling(cell) {
    var cont = container();
    if (!cont || !cell) return;
    var cr = cont.getBoundingClientRect();
    var b  = cell.getBoundingClientRect();

    // Record the cell's HOME (untransformed) box once, the first time we touch
    // it — before any transform exists, so b is the true layout position. All
    // later flings translate relative to this fixed home, so re-clicking a cell
    // already mid-flight still lands correctly.
    if (!cell._flyHome) cell._flyHome = { l: b.left - cr.left, t: b.top - cr.top };

    var maxX = Math.max(0, cr.width  - b.width);
    var maxY = Math.max(0, cr.height - b.height);
    var tx = rand(0, maxX) - cell._flyHome.l;
    var ty = rand(0, maxY) - cell._flyHome.t;
    var rot = rand(-MAX_ROT, MAX_ROT);
    var sc  = rand(SCALE_LO, SCALE_HI);

    cell.style.transition      = 'transform ' + FLY_DUR + 's ' + EASE;
    cell.style.transformOrigin = 'center center';
    cell.style.transform = 'translate(' + tx + 'px,' + ty + 'px) rotate(' + rot + 'deg) scale(' + sc + ')';
    cell.style.zIndex    = ++zc;        // grid items honor z-index — floats on top
    flung.add(cell);
  }

  // Capture-phase click handler — eats the tap before .grid-interactor reacts.
  function onPointerDown(e) {
    if (!active) return;
    if (e.button !== undefined && e.button !== 0) return;  // left / touch only
    var cell = e.target && e.target.closest ? e.target.closest('.grid-cell') : null;
    if (!cell || !container().contains(cell)) return;
    e.preventDefault();
    e.stopPropagation();
    fling(cell);
  }

  // Glide every flung cell home, then clear our inline styles once it lands.
  function resetAll() {
    flung.forEach(function (cell) {
      if (!cell.isConnected) return;
      cell.style.transition = 'transform ' + FLY_DUR + 's ' + EASE;
      cell.style.transform  = '';
    });
    var snapshot = Array.from(flung);
    setTimeout(function () {
      snapshot.forEach(function (cell) {
        if (!cell || !cell.isConnected) return;
        cell.style.transition = '';
        cell.style.transform  = '';
        cell.style.zIndex     = '';
        cell.style.transformOrigin = '';
        delete cell._flyHome;
      });
    }, FLY_DUR * 1000 + 60);
    flung.clear();
    zc = 200;
  }

  function ensureWired() {
    if (wired) return;
    var cont = container();
    if (!cont) return;
    // Capture phase so we run before the per-cell interactor's pointerdown.
    cont.addEventListener('pointerdown', onPointerDown, true);
    wired = true;
  }

  function start() {
    if (!gridOpen()) return;
    ensureWired();
    active = true;
    toast('✈ Fly mode ON — click cells to fling them anywhere · r resets to base', 3000);
  }

  // r while running: if anything is in flight, snap it all home (stay in fly
  // mode so you can keep playing). If everything is already home, leave fly mode.
  function toggle() {
    if (!active) { start(); return; }
    if (flung.size) {
      resetAll();
      toast('↩ Cells reset to base — still flying (r again to exit)', 2000);
    } else {
      active = false;
      toast('✈ Fly mode OFF', 1400);
    }
  }

  // Hard stop — used by gridClose(). Snap home silently and drop the mode.
  function stop() {
    if (flung.size) {
      flung.forEach(function (cell) {
        if (!cell.isConnected) return;
        cell.style.transition = 'none';
        cell.style.transform  = '';
        cell.style.zIndex     = '';
        cell.style.transformOrigin = '';
        delete cell._flyHome;
      });
      flung.clear();
    }
    active = false;
    zc = 200;
  }

  window.FlyCells = {
    toggle: toggle,
    start:  start,
    stop:   stop,
    get active() { return active; }
  };
})();
