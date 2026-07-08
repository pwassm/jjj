
// ══════════════════════════════════════════════════════════════════════════════
// FALL CELLS  (dev0460 · reworked dev0463)  —  Grid "moving cells" VARIANT — key F
// ══════════════════════════════════════════════════════════════════════════════
//
// A perimeter conveyor for the 16-cell outer ring (square 5×5, or the 17 / 19
// layouts — all three share the same ring). Sibling to the r CONVEYOR
// (movingcells.js) and the 1 / 2 FlyCells variants, but it has its OWN dedicated
// key: F toggles it on/off. Starting it stops whatever other moving mode was on;
// r (master off) and the 1 / 2 variant keys stop it in turn (orchestrated by the
// _gm* family in collection.js). { / } slow / speed it up live.
//
// THE CHOREOGRAPHY (dev0463):
//   1. INTRO — 1e 2e 3e 4e fade out one-by-one (5e STAYS). Those four cells leave
//      the belt and become a 4-cell "reserve" pool; their ring slots go empty.
//   2. THE CLIFF (dev0562: one continuous slide-tip-fall, per the user's sketch) —
//      each cycle the whole 12-slot loop (the L + the cliff jump 1d → 5e) creeps
//      one notch. The cell leaving 1d slides right at belt speed and, the INSTANT
//      its centre passes the top-right corner of 2d / 1L (= it loses its support),
//      tips AND falls TOGETHER — no pause, no hang — tumbling a full 360° about
//      its own centre, fast from the first airborne frame, landing upright at 5e.
//      On impact it SQUASHES to ½ height (slowly), then settles back to full.
//      The old lander creeps out of 5e during the same cycle (long gone before
//      touchdown); the next cell waits at 1d through the fall + bounce.
//   2b. CLICK-TO-FEATURE — clicking any live cell pulls it out of the choreography
//      and grows it over the 1L position (rows 2-4 × cols 2-4 — the literal 1L in
//      the 17 layout, the 2b-4d block in 5×5 / 19); it holds there 10 s, fades
//      out, and joins the reserve. Its old slot is backfilled from the reserve.
//   3. RE-ENTRY — every 2-3s, 2-3 reserve cells (the hidden 1e-4e) crossfade back
//      in over random live cells (belt / static centre / 1L / 1P-3P); each displaced
//      cell becomes the new reserve. The pool stays at four; the cast keeps churning.
//
// MODEL: the ring is 16 slots (RING below), but occupancy lives on a 12-slot LOOP
// (CHAIN): the L slots plus the jump 1d → 5e. Slots 4-7 (1e-4e) are pure air space
// the faller tumbles through — never occupied after the intro. Each cycle is one
// rigid loop rotation (a cell advances iff the slot ahead is empty or vacating);
// the 1d cell's rotation step IS the cliff jump, animated as slide + tip + fall.
//
// KEEPS LIVE VIDEO ALIVE: like movingcells.js / flycells.js it NEVER reparents or
// rebuilds a cell — it only reassigns CSS grid-area and FLIP-animates with a
// transform (plus opacity for the fades, scaleY for the bounce), so YT/Vimeo/mp4
// keep playing. DESKTOP-ONLY (16 live videos + transforms is too heavy for phones).
//
// ──────────────────────────────────────────────────────────────────────────────
// CUT-OUT INSTRUCTIONS — to remove the feature entirely, with zero grid impact:
//   1. delete this file
//   2. delete  'fallcells.js'  from the files[] array in index.html
//   3. in collection.js drop the FallCells references in _gmAnyMoving / _gmStopAll,
//      the window._gmToggleFall function, and the FallCells branch in the { / }
//      key handlers (search "FallCells" / "Fall")
//   4. in core.js delete the bare-'f' grid intercept (search "_gmToggleFall")
//   5. delete the one  window.FallCells?.stop()  line in gridClose() (xe.js)
// Nothing else references it.
// ──────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── Tunables ────────────────────────────────────────────────────────────────
  // (dev0463) Back to ~dev0460 speed. moveDur is the live speed knob ({ slower /
  // } faster): it's the time for the L to creep one notch AND for the zipper to
  // fall the whole column — so the drop looks ~4× faster than the creep.
  var moveDur   = 0.9;    // seconds per cycle's motion (live; { / } adjust)  (dev0464: ~30% faster)
  var MIN_DUR = 0.3, MAX_DUR = 4.0, DUR_STEP = 0.15;
  var PAUSE     = 0.2;    // seconds parked after the bounce, before the next cycle
  var FADE_OUT  = 0.5;    // seconds per cell in the intro fade
  var GAP_FADE  = 0.6;    // seconds to fade a spare into an undesired belt gap
  var SUB_MIN = 2.0, SUB_MAX = 3.0;            // seconds between re-entry bursts
  var SUB_FADE_MIN = 2.0, SUB_FADE_MAX = 3.0;  // (dev0464) slow, obvious substitution crossfade
  var SUB_CELLS_MIN = 2, SUB_CELLS_MAX = 3;    // cells swapped per burst
  // Impact bounce (fixed, not scaled by moveDur). (dev0464) Slower squash, and the
  // cell never rises above its own height — it compresses to ½ then settles back to
  // 1 (no overshoot, no stretch phase).
  var SQUASH = 0.35, SETTLE = 0.30;   // seconds per phase
  var BOUNCE = SQUASH + SETTLE;
  // (dev0559) Click-to-feature: grow to the 1L block, hold, fade away.
  var CLICK_GROW = 1.2, CLICK_HOLD = 10, CLICK_FADE = 1.0;   // seconds
  var EASE      = 'cubic-bezier(.4,0,.2,1)';
  // (dev0562) "Pushed off a cliff", per the user's sketch: the faller's whole
  // journey is ONE timeline. It slides right at belt speed; the INSTANT its centre
  // passes the top-right corner of 2d / 1L (halfway to 1e — where a real block
  // loses its support) it tips AND falls TOGETHER — rotation about its own CENTRE,
  // vertical drop starting immediately at full speed (linear with a slight
  // second-half acceleration; no gravity ease-in, no hang at the edge). It spins
  // a full 360° so it lands upright at 5e for the squash-bounce.
  // The slide-to-tip takes moveDur/2, the tip+fall takes moveDur → 1.5×moveDur total.

  // ── Ring geometry (clockwise from top-left) + 1-based [row,col] placement ────
  var RING = ['1a','1b','1c','1d','1e','2e','3e','4e','5e','5d','5c','5b','5a','4a','3a','2a'];
  var RC = {
    '1a':[1,1],'1b':[1,2],'1c':[1,3],'1d':[1,4],'1e':[1,5],
    '2e':[2,5],'3e':[3,5],'4e':[4,5],
    '5e':[5,5],'5d':[5,4],'5c':[5,3],'5b':[5,2],'5a':[5,1],
    '4a':[4,1],'3a':[3,1],'2a':[2,1]
  };
  var FADE_CELLS = ['1e','2e','3e','4e'];   // (dev0463) 5e no longer fades
  var SLOT_1D = 3, SLOT_5E = 8;             // ring indices of the cliff edge + landing pad
  // (dev0562) The belt is a 12-slot LOOP: the L (1a-1d, 5e-2a up the left) plus the
  // cliff jump 1d → 5e. CHAIN[k] moves into CHAIN[(k+1)%12]; slots 4-7 (1e-4e, the
  // old chute) are pure air space the faller tumbles through — never occupied.
  var CHAIN = [3, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2];
  // (dev0464) Slots that must NEVER be empty (everything but the right-column chute
  // 1e-5e = ring indices 4-8). An empty here is undesirable and gets filled from
  // the reserve; the first such fill promotes a spare into the belt, after which the
  // flow runs gap-free (13 belt cells = full L + a cell always transiting the chute).
  var FILL_SLOTS = [0,1,2,3,9,10,11,12,13,14,15];

  var DESKTOP = !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);

  // ── State ─────────────────────────────────────────────────────────────────────
  var active = false;
  var phase  = 'off';        // 'off' | 'intro' | 'run'
  var cycleTimer = null, injectTimer = null;
  var introTimers = [], fxTimers = [];
  var ring     = null;       // ring[i] = .grid-cell at RING[i], or null (gap)
  var statics  = null;       // [{ el }] non-ring centre cells (swap targets)
  var reserve  = null;       // [el] faded-out cells waiting to re-enter
  var zipperEl = null;       // the cell currently dropping (excluded from re-entry)
  var zoomEl   = null;       // the cell currently featured at 1L (one at a time)
  var zc = 300;              // climbing z-index for re-entering / dropping cells

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
  // flowed) and capture its HOME area so stop() can restore it. transform-origin
  // is bottom-centre so the landing squash/stretch compresses against the floor.
  // Splits cells into the 16-slot ring vs. the static centre cells. Returns false
  // if the ring isn't fully laid out yet.
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
      el.style.transformOrigin = '50% 100%';
      var ri = RING.indexOf(s.cs);
      if (ri >= 0) ring[ri] = el;
      else statics.push({ el: el });
    });
    for (var i = 0; i < 16; i++) if (!ring[i]) return false;
    return true;
  }

  // ── Phase 1: intro — fade 1e-4e out, one cell at a time (5e stays) ───────────
  function runIntro() {
    phase = 'intro';
    var delay = 0;
    FADE_CELLS.forEach(function (cs, n) {
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
        if (n === FADE_CELLS.length - 1) {
          setTimeout(function () {
            if (!active) return;
            phase = 'run';
            cycle();
            scheduleInject();
          }, FADE_OUT * 1000);
        }
      }, delay);
      introTimers.push(t);
      delay += FADE_OUT * 1000;
    });
  }

  // ── Phase 2: the cliff — one continuous slide-tip-fall (dev0562, per sketch) ──
  // Every cycle the whole 12-slot loop advances one notch (a cell moves iff the
  // slot ahead is empty or being vacated). The cell leaving 1d gets the SPECIAL
  // move — the cliff jump straight to 5e, as ONE timeline:
  //   • it slides right at belt speed, flat, pushed by the cell behind it;
  //   • the INSTANT its centre passes the top-right corner of 2d / 1L (halfway to
  //     1e — where a real block loses its support) it tips AND falls TOGETHER,
  //     immediately, no pause and no hang at the edge;
  //   • it tumbles about its own CENTRE, a full 360°, dropping at full speed from
  //     the first airborne frame, and lands upright at 5e for the squash-bounce.
  // Meanwhile the old lander creeps out of 5e (gone well before touchdown) and the
  // next cell arrives at 1d, where it waits out the fall + bounce — then it's next.
  function cycle() {
    if (!active || phase !== 'run') return;
    var cont = container();
    if (!cont || !gridOpen()) { stop(true); return; }

    // Who moves? Walk the loop backwards from each gap: the cell behind a gap (or
    // behind a mover) advances. A full loop is a rigid rotation — everyone moves.
    var canMove = new Array(12).fill(false), gaps = [];
    for (var g = 0; g < 12; g++) if (!ring[CHAIN[g]]) gaps.push(g);
    if (!gaps.length) canMove.fill(true);
    else gaps.forEach(function (gp) {
      var k = (gp + 11) % 12;
      while (k !== gp && ring[CHAIN[k]]) { canMove[k] = true; k = (k + 11) % 12; }
    });

    var faller = null, moves = [], next = ring.slice();
    for (var n = 0; n < 12; n++) {
      if (!canMove[n]) continue;
      var i = CHAIN[n], el = ring[i];
      if (!el) continue;
      if (!el.isConnected) { stop(true); return; }
      if (i === SLOT_1D) faller = el;                   // the cliff jump 1d → 5e
      else moves.push({ el: el, to: CHAIN[(n + 1) % 12] });
      if (next[i] === el) next[i] = null;               // vacate (unless already re-filled)
      next[CHAIN[(n + 1) % 12]] = el;
    }
    ring = next;                                        // commit occupancy

    // FLIP: read old boxes, assign new grid areas, invert.
    var fOld = faller ? faller.getBoundingClientRect() : null;
    var lOld = moves.map(function (m) { return m.el.getBoundingClientRect(); });
    moves.forEach(function (m) {
      var rc = RC[RING[m.to]];
      m.el.style.transition = 'none'; m.el.style.transform = '';
      m.el.style.gridRow = rc[0]; m.el.style.gridColumn = rc[1];
    });
    var sdx = 0, sdy = 0;
    if (faller) {
      faller.style.transition = 'none'; faller.style.transform = '';
      faller.style.gridRow = RC['5e'][0]; faller.style.gridColumn = RC['5e'][1];
      faller.style.zIndex = ++zc;                       // covers everything on the way down
      faller.style.transformOrigin = '50% 50%';         // tumbles about its centre
    }
    cont.offsetWidth;                                   // force the new layout
    moves.forEach(function (m, k) {
      var nr = m.el.getBoundingClientRect();
      m.el.style.transform = 'translate(' + (lOld[k].left - nr.left) + 'px,' + (lOld[k].top - nr.top) + 'px)';
    });
    if (faller) {
      var fNew = faller.getBoundingClientRect();
      sdx = fOld.left - fNew.left; sdy = fOld.top - fNew.top;   // 5e → back up at 1d
      faller.style.transform = 'translate(' + sdx + 'px,' + sdy + 'px)';
    }
    cont.offsetWidth;                                   // commit inverted transforms

    var z = faller;
    if (z) zipperEl = z;
    requestAnimationFrame(function () {
      moves.forEach(function (m) {
        m.el.style.transition = 'transform ' + moveDur + 's ' + EASE;
        m.el.style.transform  = 'translate(0,0)';
      });
      if (z) {
        // ONE timeline, 1.5×moveDur: linear slide to the tipping point (½ cell at
        // belt speed = moveDur/2), then tip + fall TOGETHER for the last moveDur.
        // Vertical is immediate and near-linear (55% of the height left at fall-
        // mid = mild acceleration, zero hang); the sideways drift into column e is
        // 90% done by fall-mid; rotation runs straight 0→360° about the centre.
        var fa = z.animate([
          { transform: 'translate(' + sdx + 'px,' + sdy + 'px) rotate(0deg)',                        offset: 0,     easing: 'linear' },
          { transform: 'translate(' + (sdx / 2) + 'px,' + sdy + 'px) rotate(0deg)',                  offset: 1 / 3, easing: 'linear' },
          { transform: 'translate(' + (sdx * 0.1) + 'px,' + (sdy * 0.55) + 'px) rotate(180deg)',     offset: 2 / 3, easing: 'linear' },
          { transform: 'translate(0px,0px) rotate(360deg)',                                          offset: 1 }
        ], { duration: moveDur * 1500, fill: 'forwards' });
        z._fallAnim = fa;
        fa.onfinish = function () {
          z._fallAnim = null;
          if (!active || !z.isConnected) { try { fa.cancel(); } catch (e) {} return; }
          z.style.transition = 'none';
          z.style.transform  = 'translate(0,0)';        // upright at 5e (360° ≡ 0°)
          z.style.transformOrigin = '50% 100%';         // floor origin for the squash
          try { fa.cancel(); } catch (e) {}             // drop fill-forwards so inline renders
          cont.offsetWidth;
          bounce(z);
        };
      }
    });

    fillLGaps();                                        // no empties off the belt
    var total = z ? (moveDur * 1.5 + BOUNCE + PAUSE) : (moveDur + PAUSE);
    cycleTimer = setTimeout(function () { zipperEl = null; cycle(); }, total * 1000);
  }

  // (dev0464) Fill any undesired belt gap (an empty slot outside the right-column
  // chute) by fading a spare cell in from the reserve. Gaps only arise structurally
  // when a drop's lander reaches 5e "behind" the bottom-row creep; the first fill
  // promotes one spare into the belt (12 → 13 cells), after which the flow is
  // gap-free and this is a no-op. Right-column empties (1e-5e) are left alone.
  function fillLGaps() {
    for (var n = 0; n < FILL_SLOTS.length; n++) {
      var idx = FILL_SLOTS[n];
      if (ring[idx]) continue;
      var sp = null, j;
      for (j = 0; j < reserve.length; j++) {
        if (reserve[j] && reserve[j].isConnected && reserve[j]._rowData) { sp = reserve[j]; break; }
      }
      if (!sp) break;                                   // no spare available — leave it
      reserve.splice(j, 1);
      var rc = RC[RING[idx]];
      sp.style.transition = 'none'; sp.style.transform = '';
      sp.style.gridRow = rc[0]; sp.style.gridColumn = rc[1];
      sp.style.opacity = '0'; sp.style.pointerEvents = ''; sp.style.zIndex = ++zc;
      ring[idx] = sp;
      container().offsetWidth;                          // commit opacity:0 before fading in
      sp.style.transition = 'opacity ' + GAP_FADE + 's ease';
      sp.style.opacity = '1';
    }
  }

  // Squash on impact: ½ height → settle back to full (no overshoot). transform-origin
  // is bottom-centre (set at pin time) so it compresses onto the floor. A mild
  // counter-scale on X keeps it feeling springy rather than rubbery.
  function bounce(z) {
    if (!active || !z.isConnected) return;
    // (dev0464) Slow squash to ½ height, then settle back to full — never taller
    // than its starting height (no overshoot, no stretch phase).
    z.style.transition = 'transform ' + SQUASH + 's ease-out';
    z.style.transform  = 'translate(0,0) scaleX(1.08) scaleY(0.5)';     // squash
    fxTimers.push(setTimeout(function () {
      if (!active || !z.isConnected) return;
      z.style.transition = 'transform ' + SETTLE + 's cubic-bezier(.2,.7,.3,1)';
      z.style.transform  = 'translate(0,0) scaleX(1) scaleY(1)';        // settle (no overshoot)
    }, SQUASH * 1000));
  }

  // ── Phase 3: re-entry — bursts of 2-3 reserve cells crossfade over live cells ──
  function scheduleInject() {
    if (!active) return;
    injectTimer = setTimeout(function () {
      if (!active) return;
      var burst = SUB_CELLS_MIN + rint(SUB_CELLS_MAX - SUB_CELLS_MIN + 1);
      for (var k = 0; k < burst; k++) injectOnce();
      scheduleInject();
    }, rrange(SUB_MIN, SUB_MAX) * 1000);
  }

  function injectOnce() {
    if (!container()) return;
    // Reserve cells that carry content (an empty cell would fade in to nothing),
    // and live targets (ring occupants + static centre cells) with content. The
    // dropping zipper is never a target (don't disturb a cell mid-fall).
    var rcand = reserve.filter(function (el) { return el && el.isConnected && el._rowData; });
    if (!rcand.length) return;
    var tcand = [];
    for (var i = 0; i < 16; i++) {
      var re = ring[i];
      // Never swap over the faller mid-fall.
      if (re && re !== zipperEl && re._rowData) tcand.push({ el: re, slot: i, st: null });
    }
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

    // Hand the role to R immediately so the next cycle carries R (not T): T drops
    // out of the belt / static set and becomes the new reserve ghost.
    if (T.slot >= 0)      ring[T.slot] = R;
    else if (T.st)        T.st.el = R;
    var idx = reserve.indexOf(R); if (idx >= 0) reserve.splice(idx, 1);

    var fade = rrange(SUB_FADE_MIN, SUB_FADE_MAX);   // (dev0464) slow & obvious
    requestAnimationFrame(function () {
      R.style.transition = 'opacity ' + fade + 's ease';
      R.style.opacity = '1';
      T.el.style.transition = 'opacity ' + fade + 's ease';
      T.el.style.opacity = '0';
    });

    fxTimers.push(setTimeout(function () {
      T.el.style.pointerEvents = 'none';
      if (reserve.indexOf(T.el) < 0) reserve.push(T.el);
    }, fade * 1000));
  }

  // ── Click-to-feature (dev0559): click a live cell → it grows over the 1L block
  // (rows 2-4 × cols 2-4 — the real 1L in the 17 layout, 2b-4d in 5×5 / 19),
  // holds there CLICK_HOLD seconds, fades out and joins the reserve. Its old slot
  // is backfilled from the reserve (belt slots via fillLGaps next cycle; a static
  // centre slot immediately). One featured cell at a time. Capture-phase so the
  // cell's normal click behaviour doesn't also fire while fall mode is on.
  function onCellClick(e) {
    if (!active || phase !== 'run') return;
    var el = e.target && e.target.closest ? e.target.closest('#gridContainer .grid-cell') : null;
    if (!el || zoomEl || el === zipperEl || !el._rowData) return;
    if (reserve.indexOf(el) >= 0) return;               // faded ghosts aren't featured
    e.stopPropagation(); e.preventDefault();

    // Pull it out of the choreography.
    var ri = ring.indexOf(el);
    if (ri >= 0) ring[ri] = null;                       // belt gap → fillLGaps refills
    else for (var s = 0; s < statics.length; s++)
      if (statics[s].el === el) { backfillStatic(statics[s]); break; }

    zoomEl = el;
    var old = el.getBoundingClientRect();
    el.style.transition = 'none';
    el.style.transform  = '';
    el.style.transformOrigin = '0 0';                   // FLIP scale from the top-left
    el.style.gridRow    = '2 / span 3';
    el.style.gridColumn = '2 / span 3';
    el.style.zIndex     = ++zc;
    container().offsetWidth;
    var nr = el.getBoundingClientRect();
    el.style.transform = 'translate(' + (old.left - nr.left) + 'px,' + (old.top - nr.top) + 'px) ' +
                         'scale(' + (old.width / nr.width) + ',' + (old.height / nr.height) + ')';
    container().offsetWidth;
    requestAnimationFrame(function () {
      el.style.transition = 'transform ' + CLICK_GROW + 's ' + EASE;
      el.style.transform  = 'translate(0,0) scale(1,1)';
    });

    fxTimers.push(setTimeout(function () {              // hold, then fade away
      if (!active || !el.isConnected) { if (zoomEl === el) zoomEl = null; return; }
      el.style.transition = 'opacity ' + CLICK_FADE + 's ease';
      el.style.opacity = '0';
      fxTimers.push(setTimeout(function () {
        if (!active) return;
        el.style.pointerEvents = 'none';
        el.style.transformOrigin = '50% 100%';          // back to floor-squash origin
        if (reserve.indexOf(el) < 0) reserve.push(el);
        if (zoomEl === el) zoomEl = null;
      }, CLICK_FADE * 1000));
    }, (CLICK_GROW + CLICK_HOLD) * 1000));
  }

  // Replace a featured-away static centre cell with a spare from the reserve,
  // faded in at the same grid position (mirrors fillLGaps for the belt).
  function backfillStatic(st) {
    var gr = st.el.style.gridRow, gc = st.el.style.gridColumn;
    st.el = null;
    var sp = null, j;
    for (j = 0; j < reserve.length; j++) {
      if (reserve[j] && reserve[j].isConnected && reserve[j]._rowData) { sp = reserve[j]; break; }
    }
    if (!sp) return;                                    // no spare — spot stays empty
    reserve.splice(j, 1);
    sp.style.transition = 'none'; sp.style.transform = '';
    sp.style.gridRow = gr; sp.style.gridColumn = gc;
    sp.style.opacity = '0'; sp.style.pointerEvents = ''; sp.style.zIndex = ++zc;
    st.el = sp;
    container().offsetWidth;
    sp.style.transition = 'opacity ' + GAP_FADE + 's ease';
    sp.style.opacity = '1';
  }

  // Snap every cell home, dropping all inline styling this feature added.
  function restoreAll() {
    var cont = container(); if (!cont) return;
    var cells = cont.querySelectorAll('.grid-cell');
    cells.forEach(function (el) {
      // (dev0560) Kill any live WAAPI tip/fall — its fill:forwards would otherwise
      // override the reset transform and pin the cell mid-air.
      if (el._fallAnim) { try { el._fallAnim.cancel(); } catch (e) {} el._fallAnim = null; }
      el.style.transition = 'none';
      el.style.transform  = '';
      el.style.opacity    = '';
      el.style.zIndex     = '';
      el.style.pointerEvents = '';
      el.style.willChange = '';
      el.style.transformOrigin = '';
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
    zc = 300; zipperEl = null; zoomEl = null;
    container().addEventListener('click', onCellClick, true);
    toast('▼ Fall cells ON — cells drop off the cliff & bounce; the belt creeps along; hidden cells re-enter constantly. Click a cell to feature it big for 10 s.   ( { slower · } faster · F / r stop )', 4600);
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
    fxTimers.forEach(function (t) { clearTimeout(t); });
    introTimers = []; fxTimers = []; zipperEl = null; zoomEl = null;
    var cont = container();
    if (cont) cont.removeEventListener('click', onCellClick, true);
    if (ring || statics || reserve) restoreAll();
    ring = statics = reserve = null;
    if (!silent && was && typeof toast === 'function') toast('■ Fall cells OFF', 1400);
  }

  function toggle() { if (active) stop(false); else start(); }

  function announceSpeed() {
    if (typeof _gridToast === 'function') _gridToast('Fall speed: ' + moveDur.toFixed(1) + 's / cycle', 1100);
    else if (typeof toast === 'function') toast('Fall speed: ' + moveDur.toFixed(1) + 's', 1100);
  }
  function slower() { moveDur = Math.min(MAX_DUR, +(moveDur + DUR_STEP).toFixed(2)); announceSpeed(); }  // { key
  function faster() { moveDur = Math.max(MIN_DUR, +(moveDur - DUR_STEP).toFixed(2)); announceSpeed(); }  // } key

  window.FallCells = {
    start:  start,
    stop:   stop,
    toggle: toggle,
    faster: faster,
    slower: slower,
    get active() { return active; }
  };
})();
