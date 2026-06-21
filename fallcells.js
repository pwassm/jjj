
// ══════════════════════════════════════════════════════════════════════════════
// FALL CELLS  (dev0460)  —  Grid "moving cells" VARIANT — hotkey  F
// ══════════════════════════════════════════════════════════════════════════════
//
// A perimeter "waterfall" conveyor for the 16-cell outer ring (square 5×5, or the
// 17 / 19 layouts — all three share the same ring). Sibling to the r CONVEYOR
// (movingcells.js) and the 1 / 2 FlyCells variants, but it has its OWN dedicated
// key: F toggles it on/off. Starting it stops whatever other moving mode was on;
// r (master off) and the 1 / 2 variant keys stop it in turn (orchestrated by the
// _gm* family in collection.js).
//
// THE CHOREOGRAPHY (as specified):
//   1. INTRO — the right column 1e 2e 3e 4e 5e fades out one-by-one (~0.5s each).
//      Those five cells leave the visible belt and become a "reserve" pool; their
//      ring slots are now empty (gaps), so the right column reads as a drain.
//   2. OPENING SLIDE — the top row 1a 1b 1c 1d glides RIGHT one cell (~1s), so a
//      fresh cell lands on 1e, poised at the top of the empty drain.
//   3. THE CLIFF (dev0461) — ONE cell at a time falls off the edge: the cell at 1e
//      drops the whole empty right column to 5e ALONE — nothing else moves during
//      the drop. Only once it has landed does the rest ADVANCE one notch clockwise:
//      the left column (2a 3a 4a 5a) rises, the bottom row (5b 5c 5d) slides left,
//      the landed cell turns the corner 5e→5d, and the top row (1b 1c 1d) feeds
//      right — delivering the next cell to 1e. Then that one falls. Repeat.
//   4. RE-ENTRY — every 5–10s one faded reserve cell CROSSFADES back in over a
//      random target (a belt cell, a static centre cell, or 1L / 1P-3P): the old
//      occupant fades out (becoming the new reserve) as the reserve fades in. The
//      reserve pool stays at five; the cast of on-screen cells keeps shuffling.
//
// KEEPS LIVE VIDEO ALIVE: like movingcells.js / flycells.js it NEVER reparents or
// rebuilds a cell — it only reassigns CSS grid-area and FLIP-animates with a
// transform (and tweaks opacity for the fades), so YouTube/Vimeo/mp4 keep playing
// as they glide. DESKTOP-ONLY by design (16 live videos + transforms is too heavy
// for phones — same gate as the conveyor).
//
// ──────────────────────────────────────────────────────────────────────────────
// CUT-OUT INSTRUCTIONS — to remove the feature entirely, with zero grid impact:
//   1. delete this file
//   2. delete  'fallcells.js'  from the files[] array in index.html
//   3. in collection.js drop the FallCells references in _gmAnyMoving / _gmStopAll
//      and the whole window._gmToggleFall function (search "FallCells" / "Fall")
//   4. in core.js delete the bare-'f' grid intercept (search "_gmToggleFall")
//   5. delete the one  window.FallCells?.stop()  line in gridClose() (xe.js)
// Nothing else references it.
// ──────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── Tunables ────────────────────────────────────────────────────────────────
  // (dev0461) ~half the speed of dev0460, and the fall is now ISOLATED: a single
  // cell drops the whole right column ALONE before anything else moves. Every cell
  // moves at the same ~2s-per-cell rate (FALL_DUR = 4 cells × that rate). FALL_DUR
  // is the main knob — shrink it if the lone drop feels too slow/still.
  var FADE_OUT   = 1.0;   // seconds per right-column fade in the intro
  var TOP_SLIDE  = 2.0;   // seconds for the opening top-row shift-right
  var FALL_DUR   = 8.0;   // seconds for ONE cell to fall the full column 1e→5e (solo)
  var ADVANCE    = 2.0;   // seconds for the rest of the ring to shift one notch
  var PAUSE      = 0.4;   // brief settle between the fall and the advance
  var CROSSFADE  = 1.6;   // seconds for a reserve-cell re-entry crossfade
  var INJECT_MIN = 10, INJECT_MAX = 20;   // seconds between random re-entries
  var EASE      = 'cubic-bezier(.4,0,.2,1)';
  var FALL_EASE = 'cubic-bezier(.45,0,.9,.4)';   // accelerating — a gravity-like drop

  // ── Ring geometry (clockwise from top-left) + 1-based [row,col] placement ────
  var RING = ['1a','1b','1c','1d','1e','2e','3e','4e','5e','5d','5c','5b','5a','4a','3a','2a'];
  var RC = {
    '1a':[1,1],'1b':[1,2],'1c':[1,3],'1d':[1,4],'1e':[1,5],
    '2e':[2,5],'3e':[3,5],'4e':[4,5],
    '5e':[5,5],'5d':[5,4],'5c':[5,3],'5b':[5,2],'5a':[5,1],
    '4a':[4,1],'3a':[3,1],'2a':[2,1]
  };
  var COL_E = ['1e','2e','3e','4e','5e'];   // the right column — the drain

  var DESKTOP = !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);

  // ── State ─────────────────────────────────────────────────────────────────────
  var active = false;
  var phase  = 'off';        // 'off' | 'intro' | 'slide' | 'run'
  var falling = false;       // true only while a cell is mid-drop (gates re-entries)
  var cycleTimer = null, injectTimer = null;
  var introTimers = [];
  var ring     = null;       // ring[i] = .grid-cell at RING[i], or null (gap)
  var statics  = null;       // [{ el }] non-ring centre cells (swap targets)
  var reserve  = null;       // [el] faded-out cells waiting to re-enter
  var zc = 300;              // climbing z-index for re-entering cells

  function container() { return document.getElementById('gridContainer'); }
  function gridOpen()  { var o = document.getElementById('gridOverlay'); return !!(o && o.style.display === 'flex'); }
  function layout()    { return (typeof _gridCurrentLayout === 'function') ? _gridCurrentLayout() : 'square'; }
  function rint(n)     { return Math.floor(Math.random() * n); }
  function rrange(a, b){ return a + Math.random() * (b - a); }
  function cellEl(cs)  { return document.querySelector('#gridContainer .grid-cell[data-cell="' + cs + '"]'); }

  function eligibleLayout() {
    var lay = layout();
    if (lay === '17' || lay === '19') return true;
    return lay === 'square' && (typeof _gridGsize === 'undefined' || _gridGsize === 5);
  }

  // Pin every cell to explicit grid placement (square cells are normally auto-
  // flowed) and capture its HOME area so stop() can restore it. Splits the cells
  // into the 16-slot ring vs. the static centre cells. Returns false if the ring
  // isn't fully laid out yet.
  function pinAndCapture() {
    ring = new Array(16).fill(null);
    statics = [];
    var lay = layout();
    var specs = (typeof _gridCellList === 'function') ? _gridCellList(5, lay) : [];
    if (!specs.length) return false;
    specs.forEach(function (s) {
      var el = cellEl(s.cs);
      if (!el) return;
      if (el._fallHomeGR === undefined) { el._fallHomeGR = el.style.gridRow; el._fallHomeGC = el.style.gridColumn; }
      el.style.gridRow    = s.r + (s.rs  > 1 ? ' / span ' + s.rs  : '');
      el.style.gridColumn = s.c + (s.cls > 1 ? ' / span ' + s.cls : '');
      el.style.willChange = 'transform, opacity';
      var ri = RING.indexOf(s.cs);
      if (ri >= 0) ring[ri] = el;
      else statics.push({ el: el });
    });
    for (var i = 0; i < 16; i++) if (!ring[i]) return false;
    return true;
  }

  // FLIP a batch of moves. `moves` = [{ el, to }] where `to` is the destination
  // ring index. Old rects are read FIRST (including any in-flight transform) so
  // concurrent fades/glides chain smoothly, then each element is reassigned to its
  // new grid-area, inverted back to the old box, and played forward over `dur`.
  function flipMove(moves, dur, ease) {
    var cont = container(); if (!cont) return;
    var olds = moves.map(function (m) { return m.el.getBoundingClientRect(); });
    moves.forEach(function (m) {
      var rc = RC[RING[m.to]];
      m.el.style.transition = 'none';
      m.el.style.transform  = '';
      m.el.style.gridRow    = rc[0];
      m.el.style.gridColumn = rc[1];
    });
    cont.offsetWidth;                                   // force the new layout
    moves.forEach(function (m, k) {
      var nr = m.el.getBoundingClientRect();
      m.el.style.transform = 'translate(' + (olds[k].left - nr.left) + 'px,' + (olds[k].top - nr.top) + 'px)';
    });
    cont.offsetWidth;                                   // commit inverted transforms
    requestAnimationFrame(function () {
      moves.forEach(function (m) {
        m.el.style.transition = 'transform ' + dur + 's ' + (ease || EASE);
        m.el.style.transform  = 'translate(0,0)';
      });
    });
  }

  // ── Phase 1: intro — fade the right column out, one cell at a time ───────────
  function runIntro() {
    phase = 'intro';
    var delay = 0;
    COL_E.forEach(function (cs, n) {
      var ri = RING.indexOf(cs);
      var t = setTimeout(function () {
        if (!active) return;
        var el = ring[ri];
        if (el) {
          el.style.transition = 'opacity ' + FADE_OUT + 's ease';
          el.style.opacity = '0';
          el.style.pointerEvents = 'none';
          ring[ri] = null;                          // slot becomes a gap
          if (reserve.indexOf(el) < 0) reserve.push(el);
        }
        if (n === COL_E.length - 1) {
          setTimeout(function () { if (active) firstSlide(); }, FADE_OUT * 1000);
        }
      }, delay);
      introTimers.push(t);
      delay += FADE_OUT * 1000;
    });
  }

  // ── Phase 2: opening slide — top row 1a 1b 1c 1d glides right one cell ───────
  function firstSlide() {
    phase = 'slide';
    if (!container() || !gridOpen()) { stop(true); return; }
    var moves = [];
    [0, 1, 2, 3].forEach(function (i) { if (ring[i]) moves.push({ el: ring[i], to: i + 1 }); });
    // Commit occupancy: slots 1..4 take old 0..3; slot 0 (1a) becomes a gap.
    var snap = [ring[0], ring[1], ring[2], ring[3]];
    ring[1] = snap[0]; ring[2] = snap[1]; ring[3] = snap[2]; ring[4] = snap[3]; ring[0] = null;
    flipMove(moves, TOP_SLIDE);
    setTimeout(function () {
      if (!active) return;
      phase = 'run';
      cycle();
      scheduleInject();
    }, TOP_SLIDE * 1000);
  }

  // ── Phase 3: the cliff — one cell falls 1e→5e ALONE, then the rest advances ──
  // One full cycle = FALL (solo drop, everything else frozen) → ADVANCE (the rest
  // of the ring shifts one notch, refilling 1e). cycleTimer chains the two.
  function cycle() {
    if (!active || phase !== 'run') return;
    var cont = container();
    if (!cont || !gridOpen()) { stop(true); return; }

    var faller = ring[4];                               // the cell poised at 1e
    if (faller && !faller.isConnected) { stop(true); return; }

    if (faller) {
      // FALL: glide the lone cell straight down the empty column to 5e (slot 8).
      // Nothing else is touched, so the grid is still but for this one drop.
      falling = true;
      flipMove([{ el: faller, to: 8 }], FALL_DUR, FALL_EASE);
      ring[8] = faller;                                 // landed at 5e
      ring[4] = null;                                   // 1e now empty (chute clear)
      cycleTimer = setTimeout(function () {
        falling = false;
        advanceThenNext();
      }, (FALL_DUR + PAUSE) * 1000);
    } else {
      // No cell at the edge (the lone circulating gap is passing 1e) — just
      // advance to feed the next one in.
      advanceThenNext();
    }
  }

  function advanceThenNext() {
    if (!active || phase !== 'run') return;
    doAdvance();
    cycleTimer = setTimeout(cycle, (ADVANCE + PAUSE) * 1000);
  }

  // Rigid clockwise rotation of the whole ring by one slot: the just-landed cell
  // at 5e turns the corner to 5d, the bottom row slides left, the left column
  // rises, and the top row feeds right — delivering a fresh cell to 1e. The empty
  // column interior (2e-4e) just rotates empties, so the chute stays clear.
  function doAdvance() {
    var cont = container();
    if (!cont || !gridOpen()) { stop(true); return; }
    var moves = [], next = new Array(16).fill(null);
    for (var i = 0; i < 16; i++) {
      var el = ring[i];
      if (!el) continue;
      if (!el.isConnected) { stop(true); return; }
      var to = (i + 1) % 16;
      moves.push({ el: el, to: to });
      next[to] = el;
    }
    flipMove(moves, ADVANCE);
    ring = next;                                        // the lone gap rotates too
  }

  // ── Phase 4: random re-entry — a reserve cell crossfades over a live cell ─────
  function scheduleInject() {
    if (!active) return;
    injectTimer = setTimeout(function () {
      if (!active) return;
      injectOnce();
      scheduleInject();
    }, rrange(INJECT_MIN, INJECT_MAX) * 1000);
  }

  function injectOnce() {
    if (!container()) return;
    if (falling) return;               // (dev0461) never disturb the screen mid-drop
    // Reserve cells that actually carry content (an empty cell would fade in to
    // nothing), and live targets (ring occupants + static centre cells) with
    // content. Reserve ghosts are never targets (they're invisible).
    var rcand = reserve.filter(function (el) { return el && el.isConnected && el._rowData; });
    if (!rcand.length) return;
    var tcand = [];
    for (var i = 0; i < 16; i++) if (ring[i] && ring[i]._rowData) tcand.push({ el: ring[i], slot: i, st: null });
    statics.forEach(function (s) { if (s.el && s.el._rowData) tcand.push({ el: s.el, slot: -1, st: s }); });
    if (!tcand.length) return;

    var R = rcand[rint(rcand.length)];
    var T = tcand[rint(tcand.length)];
    if (R === T.el) return;

    // Park the reserve exactly over the target (adopt its grid-area), invisible
    // and on top, ready to fade in.
    R.style.transition = 'none';
    R.style.transform  = '';
    R.style.gridRow    = T.el.style.gridRow;
    R.style.gridColumn = T.el.style.gridColumn;
    R.style.opacity    = '0';
    R.style.zIndex     = ++zc;
    R.style.pointerEvents = '';
    container().offsetWidth;

    // Hand the role to R immediately so the next advance carries R (not T): T drops
    // out of the belt / static set and becomes the new reserve ghost.
    if (T.slot >= 0)      ring[T.slot] = R;
    else if (T.st)        T.st.el = R;
    var idx = reserve.indexOf(R); if (idx >= 0) reserve.splice(idx, 1);

    requestAnimationFrame(function () {
      R.style.transition = 'opacity ' + CROSSFADE + 's ease';
      R.style.opacity = '1';
      T.el.style.transition = 'opacity ' + CROSSFADE + 's ease';
      T.el.style.opacity = '0';
    });

    setTimeout(function () {
      T.el.style.pointerEvents = 'none';
      if (reserve.indexOf(T.el) < 0) reserve.push(T.el);
    }, CROSSFADE * 1000);
  }

  // Snap every cell home, dropping all inline styling this feature added.
  function restoreAll() {
    var cont = container(); if (!cont) return;
    var cells = cont.querySelectorAll('.grid-cell');
    cells.forEach(function (el) {
      el.style.transition = 'none';
      el.style.transform  = '';
      el.style.opacity    = '';
      el.style.zIndex     = '';
      el.style.pointerEvents = '';
      el.style.willChange = '';
      if (el._fallHomeGR !== undefined) { el.style.gridRow = el._fallHomeGR; el.style.gridColumn = el._fallHomeGC; }
      delete el._fallHomeGR; delete el._fallHomeGC;
    });
    requestAnimationFrame(function () {
      cells.forEach(function (el) { if (el.isConnected) el.style.transition = ''; });
    });
  }

  function start() {
    if (active) return false;
    if (!gridOpen()) return false;
    if (!DESKTOP) { toast('Fall cells is desktop-only (too heavy for phones)', 2200); return false; }
    if (!eligibleLayout()) { toast('Fall cells needs a 5×5, 17 or 19 grid', 2200); return false; }
    reserve = [];
    if (!pinAndCapture()) { toast('Grid still drawing — try again in a moment', 1800); restoreAll(); ring = statics = reserve = null; return false; }
    active = true;
    zc = 300;
    toast('▼ Fall cells ON — cells drop off the cliff one at a time; the belt advances between drops; faded cells re-enter at random.   ( F or r stop )', 4200);
    runIntro();
    return true;
  }

  // Full stop + restore. Safe to call when not running.
  function stop(silent) {
    var was = active;
    active = false;
    phase = 'off';
    if (cycleTimer)  { clearTimeout(cycleTimer);  cycleTimer = null; }
    if (injectTimer) { clearTimeout(injectTimer); injectTimer = null; }
    introTimers.forEach(function (t) { clearTimeout(t); });
    introTimers = [];
    falling = false;
    if (ring || statics || reserve) restoreAll();
    ring = statics = reserve = null;
    if (!silent && was && typeof toast === 'function') toast('■ Fall cells OFF', 1400);
  }

  function toggle() { if (active) stop(false); else start(); }

  window.FallCells = {
    start:  start,
    stop:   stop,
    toggle: toggle,
    get active() { return active; }
  };
})();
