// ══════════════════════════════════════════════════════════════════════════════
// 16F — THE FOLD GRID  (dev0820; animation rebuilt dev0822, dev0824, dev0825, dev0828)
// Fold speed is adjustable at runtime — see the pill / _fold16Slow (dev0826).
// ══════════════════════════════════════════════════════════════════════════════
//
// A paper-fortune-teller grid. Ten cells sit on a 4×4 footprint in a staircase
// down the diagonal; the six positions NOT used (1c, 1d, 2d, 3a, 4a, 4b) stay
// empty, which is what gives the layout its silhouette:
//
//        a    b    c    d
//   1  [1a] [1b]   ·    ·
//   2  [2a] [2b] [2c]   ·
//   3    ·  [3b] [3c] [3d]
//   4    ·    ·  [4c] [4d]
//
// Three overlapping 2×2 BLOCKS run down that diagonal, sharing the cells 2b and
// 3c. Each has a CIRCLE at the interior corner where its four cells meet.
// Double-click it and the block folds four squares into one:
//
//   circle A (1a/1b/2a/2b) → lands on 2b, shows 1a's back  (c.json key 1aB)
//   circle B (2b/2c/3b/3c) → lands on 2b, shows 3c's back  (key 3cB)
//   circle C (3c/3d/4c/4d) → lands on 3c, shows 4d's back  (key 4dB)
//
// The cascade is 10 → 7 → 4 → 1: fold A and C and you are left with a clean 2×2
// (1a-back, 2c, 3b, 4d-back) with circle B still dead centre, which is what makes
// the last fold possible. B is the OUTER fold — while it is down, A and C are
// inside its stack and their circles are hidden.
//
// ── THE FOLD ────────────────────────────────────────────────────────────────
// (dev0828) Driven by CORNER PATHS, not by rotations. Every corner of the block
// sits at a fixed distance from the circle — the three OUTER corners a cell-
// diagonal away, the edge corners one cell — so the collapse is a spherical
// motion about the circle and each corner simply travels its own arc.
//
// The three outer corners (of the two side cells and of the corner cell) all
// rise to a single APEX one cell-diagonal directly above the circle, meet there,
// then come down together onto the far corner of the landing square:
//
//        1a │ 1b                    ●  apex, all three corners
//       ────●────      →           /|\      meet here
//        2a │ 2b                  1 2 3
//
// That is the shape of the paper: the middle lifts to a point, everything
// gathers to it, and it drops flat. No fixed hinge produces that path, which is
// why the earlier rotate3d versions could only ever look like sliding. Corners
// shared with the landing square never move, and the circle never moves.
//
// Each moving cell is cut along the crease through the circle into two TRIANGLES,
// and each triangle is drawn by solving the 2D affine matrix that maps its flat
// corners onto its projected ones — three points determine an affine map exactly,
// so a triangle can be sent wherever three corners go, with no rigid-body
// constraint and no origami CSS refuses to express. Depth comes from a
// perspective divide about the middle of the grid.
//
// The corner cell is TWO-SIDED: its own picture until it turns past edge-on
// (detected from the projected triangle's signed area flipping), the back face's
// after. The back's own flat corners are where the front's corners LAND, so when
// the fold completes its matrix is the identity and the new picture sits square
// on the landing cell rather than mirrored.
//
// Two things this must never show, both learned the hard way (dev0824):
//   • no blank paper. Nothing on screen is ever a flat sheet of paper colour —
//     a manila stand-in for the reverse of a flap put yellow-orange triangles
//     across the grid.
//   • no holes. A lifting flap leaves bare grid background behind it, which reads
//     as a hard-edged navy triangle; instead the source cells stay WHOLE
//     underneath and dissolve, so no cut edge is ever visible.
//
// This only works if the cells are SQUARE. A 180° turn about a rectangle's
// corner-to-corner diagonal does NOT land the diagonal cell on the landing cell
// (on a 16:9 screen a 4×4 of full-width cells misses by hundreds of pixels), so
// 16F lays itself out as a centred square — see _fold16ApplyTemplate.
//
// Everything here is additive: the three back faces are ordinary grid cells with
// their own c.json keys, built by gridShow's normal cell path, so they inherit
// tap-to-play, swipe→view, zoom, COI, cut/paste and the rest for free. They are
// simply hidden until their block folds.
// ══════════════════════════════════════════════════════════════════════════════

const FOLD16_LAYOUT = '16F';

// The ten cells that exist, with their 4×4 placement.
const FOLD16_CELLS = [
  { cs: '1a', r: 1, c: 1 }, { cs: '1b', r: 1, c: 2 },
  { cs: '2a', r: 2, c: 1 }, { cs: '2b', r: 2, c: 2 }, { cs: '2c', r: 2, c: 3 },
  { cs: '3b', r: 3, c: 2 }, { cs: '3c', r: 3, c: 3 }, { cs: '3d', r: 3, c: 4 },
  { cs: '4c', r: 4, c: 3 }, { cs: '4d', r: 4, c: 4 }
];


// The three blocks, named by their 2×2 corners. `land` is the square everything
// collapses onto, `diag` the one opposite it whose back ends up showing, `back`
// the c.json key holding that back face.
const FOLD16_BLOCKS = [
  {
    id: 'A', orient: 'BR', tl: '1a', tr: '1b', bl: '2a', br: '2b',
    cells: ['1a', '1b', '2a', '2b'], land: '2b', diag: '1a', back: '1aB',
    label: 'Fold 1a·1b·2a·2b onto 2b'
  },
  {
    id: 'B', orient: 'TL', tl: '2b', tr: '2c', bl: '3b', br: '3c',
    cells: ['2b', '2c', '3b', '3c'], land: '2b', diag: '3c', back: '3cB',
    label: 'Fold the centre four onto 2b'
  },
  {
    id: 'C', orient: 'TL', tl: '3c', tr: '3d', bl: '4c', br: '4d',
    cells: ['3c', '3d', '4c', '4d'], land: '3c', diag: '4d', back: '4dB',
    label: 'Fold 3c·3d·4c·4d onto 3c'
  }
];

const FOLD16_BACK_KEYS = FOLD16_BLOCKS.map(b => b.back);

// Live fold state — session-lived, always starts flat. Reset whenever the grid
// renders something that is not a 16F (see gridShow), so a stale fold can never
// haunt the next grid.
var _fold16 = { A: false, B: false, C: false };

const _F16_MS = 620;      // the crease sweep, 0° → 180°
const _F16_TUCK_MS = 240; // (dev0824) folded into the single sweep above

// ── (dev0826) Fold speed ─────────────────────────────────────────────────────
// Multiplies the fold's duration so the intermediate shapes can be watched or
// screenshotted. ONLY the clock changes — every angle, offset and easing curve is
// untouched, so what you see at 1/5 is exactly what happens at full speed, which
// is the whole point of being able to slow it down and point at a frame.
//
// Driven by the ⏱ pill at the bottom-left of the grid (dev only) or from the
// console with _fold16Slow(n). Persisted, so a reload keeps whatever it is set
// to. NOTE the stored value wins over this default, so bumping the default alone
// will not speed up a browser that has already been slowed.
const _F16_SLOW_STEPS = [1, 1.5, 2, 3, 5, 8, 12];
const _F16_SLOW_KEY = 'slam-fold16-slow';
var _F16_SLOW = 5;
try {
  const _sv = parseFloat(localStorage.getItem(_F16_SLOW_KEY));
  if (_sv > 0) _F16_SLOW = _sv;
} catch (_) {}

function _fold16Slow(n) {
  n = parseFloat(n);
  if (!(n > 0)) return _F16_SLOW;
  _F16_SLOW = n;
  try { localStorage.setItem(_F16_SLOW_KEY, String(n)); } catch (_) {}
  _f16PaintSpeed();
  return _F16_SLOW;
}
// Step through the ladder; dir +1 = slower, -1 = faster.
function _f16SlowStep(dir) {
  let i = _F16_SLOW_STEPS.indexOf(_F16_SLOW);
  if (i < 0) {  // a console-set value that is not on the ladder — find its place
    i = 0;
    for (let k = 0; k < _F16_SLOW_STEPS.length; k++) if (_F16_SLOW_STEPS[k] <= _F16_SLOW) i = k;
  }
  const j = Math.max(0, Math.min(_F16_SLOW_STEPS.length - 1, i + dir));
  _fold16Slow(_F16_SLOW_STEPS[j]);
}
function _f16SlowLabel() {
  return _F16_SLOW === 1 ? 'full speed' : '1/' + _F16_SLOW;
}
function _f16Dur() { return (_F16_MS + _F16_TUCK_MS) * _F16_SLOW; }

// The pill itself. Lives on the OVERLAY, not the grid container — the container
// is a CSS grid and any child of it gets placed into a track.
function _f16PaintSpeed() {
  const el = document.getElementById('fold16Speed');
  if (!el) return;
  el.querySelector('.f16-speed-num').textContent =
    (_F16_SLOW % 1 === 0) ? String(_F16_SLOW) : _F16_SLOW.toFixed(1);
  el.querySelector('.f16-speed-ms').textContent = Math.round(_f16Dur()) + ' ms';
  el.querySelector('.f16-speed-cap').textContent =
    _F16_SLOW === 1 ? 'FULL SPEED' : _f16SlowLabel() + ' SPEED';
}

// (dev0826) Wheel stepping. Finer than the −/+ ladder so a specific frame can be
// dialled in: half a step per notch, clamped to a sane range.
const _F16_SLOW_MIN = 0.5, _F16_SLOW_MAX = 30;
function _f16SlowWheel(dy) {
  const step = _F16_SLOW < 3 ? 0.5 : 1;
  let n = _F16_SLOW + (dy < 0 ? step : -step);
  n = Math.round(n * 2) / 2;
  _fold16Slow(Math.max(_F16_SLOW_MIN, Math.min(_F16_SLOW_MAX, n)));
}
function _f16SpeedPill() {
  const overlay = document.getElementById('gridOverlay');
  if (!overlay) return;
  const old = document.getElementById('fold16Speed');
  if (old) old.remove();
  // Dev tuning aid — a viewer has no reason to be shown a fold-speed control.
  if (typeof _isUserMode === 'function' && _isUserMode()) return;
  const wrap = document.createElement('div');
  wrap.id = 'fold16Speed';
  wrap.className = 'fold16-speed';
  wrap.title = 'Fold speed — roll the wheel over this box';
  wrap.innerHTML =
      '<div class="f16-speed-cap">' + (_F16_SLOW === 1 ? 'FULL SPEED' : _f16SlowLabel() + ' SPEED') + '</div>'
    + '<div class="f16-speed-row">'
    +   '<span class="f16-speed-btn" data-dir="-1" title="Faster">−</span>'
    +   '<span class="f16-speed-num"></span>'
    +   '<span class="f16-speed-btn" data-dir="1" title="Slower">+</span>'
    + '</div>'
    + '<div class="f16-speed-ms"></div>';
  wrap.querySelectorAll('.f16-speed-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      _f16SlowStep(parseInt(btn.dataset.dir, 10));
    }, true);
  });
  // The wheel is the main control. passive:false so preventDefault sticks, and in
  // CAPTURE so the grid's own Ctrl+wheel per-cell zoom never sees it.
  wrap.addEventListener('wheel', e => {
    e.preventDefault(); e.stopPropagation();
    _f16SlowWheel(e.deltaY);
  }, { capture: true, passive: false });
  ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu']
    .forEach(t => wrap.addEventListener(t, e => e.stopPropagation(), true));
  overlay.appendChild(wrap);
  _f16PaintSpeed();
}
var _fold16Busy = false;  // one fold at a time; clicks are swallowed mid-fold

function _fold16Block(id) { return FOLD16_BLOCKS.find(b => b.id === id) || null; }

// Block whose back face this c.json key is ('1aB' → 'A'), else null.
function _fold16BackBlock(key) {
  const b = FOLD16_BLOCKS.find(x => x.back === key);
  return b ? b.id : null;
}
function _fold16IsBackKey(k) { return FOLD16_BACK_KEYS.indexOf(k) !== -1; }

// The 13 specs gridShow renders: the ten staircase cells, then the three back
// faces parked on top of their landing cell (hidden until their block folds).
function _fold16CellList() {
  const out = FOLD16_CELLS.map(o => ({ cs: o.cs, r: o.r, c: o.c, rs: 1, cls: 1 }));
  for (const b of FOLD16_BLOCKS) {
    const land = FOLD16_CELLS.find(o => o.cs === b.land);
    out.push({ cs: b.back, r: land.r, c: land.c, rs: 1, cls: 1, foldBack: b.id });
  }
  return out;
}

function _fold16Reset() { _fold16 = { A: false, B: false, C: false }; _fold16Busy = false; }

// ── Layout ───────────────────────────────────────────────────────────────────
// A centred SQUARE 4×4 with no gaps — square because the diagonal crease only
// lands true on square cells, gapless because the ten cells are meant to read as
// one sheet of paper. Called from _gridApplyContainerCSS. The track size is
// stashed on the element so the circles can be placed from grid geometry rather
// than from cells that may currently be folded away (and therefore zero-sized).
function _fold16ApplyTemplate(c) {
  if (!c) return;
  const r = c.getBoundingClientRect();
  const side = Math.min(r.width, r.height);
  const cell = side > 8 ? Math.floor((side - 4) / 4) : 0;
  if (cell > 0) {
    c.style.gridTemplateRows    = 'repeat(4,' + cell + 'px)';
    c.style.gridTemplateColumns = 'repeat(4,' + cell + 'px)';
  } else {
    // (dev0823) Nothing to measure yet — gridShow builds the whole grid while the
    // overlay is still display:none, so the FIRST call here always lands on this
    // branch and getBoundingClientRect returns zeros. Fall back to vmin, which
    // needs no measurement and already means "the smaller side of the viewport":
    // 4 × 25vmin is exactly the centred square we want. _fold16Render runs again
    // once the overlay is up and replaces this with the measured version.
    c.style.gridTemplateRows    = 'repeat(4,25vmin)';
    c.style.gridTemplateColumns = 'repeat(4,25vmin)';
  }
  c.style.gap = '0px';
  c.style.justifyContent = 'center';
  c.style.alignContent = 'center';
  c._f16Cell = cell;
  c._f16Rect = r;
}

// ── Visibility ───────────────────────────────────────────────────────────────
// Which of the 13 cells are on screen for the current fold state. A folded block
// hides all four of its own cells and shows its back face on the landing square —
// and because B contains 2b and 3c, folding B also swallows whatever A and C had
// left sitting there.
function _fold16Visible() {
  const hidden = new Set();
  const shown = new Set();
  if (_fold16.A) { _fold16Block('A').cells.forEach(c => hidden.add(c)); shown.add('1aB'); }
  if (_fold16.C) { _fold16Block('C').cells.forEach(c => hidden.add(c)); shown.add('4dB'); }
  if (_fold16.B) {
    _fold16Block('B').cells.forEach(c => hidden.add(c));
    shown.delete('1aB');   // A's stack is now inside B's
    shown.delete('4dB');   // and so is C's
    shown.add('3cB');
  }
  return { hidden, shown };
}

// A block can only be worked while its four cells are actually on the table —
// so A and C are locked away while the outer fold B is down.
function _fold16Enabled(id) { return (id === 'B') ? true : !_fold16.B; }

function _f16Cell(container, cs) {
  return container.querySelector('.grid-cell[data-cell="' + cs + '"]');
}

// ── Render ───────────────────────────────────────────────────────────────────
// Called at the end of every 16F gridShow: paints the circles and snaps every
// cell to the current fold state (no animation — gridShow rebuilt the DOM, so
// there is nothing to animate FROM).
function _fold16Render(container) {
  if (!container) return;
  // Do NOT touch container.style.position. #gridContainer is position:absolute +
  // inset:0 and that is the ONLY thing giving it size — #gridOverlay is a
  // flexbox, so switching to relative collapses it to about ten pixels wide
  // (dev0821). Absolute already makes it a positioned ancestor, which is all the
  // circles need.
  container.style.perspective = '1400px';
  _f16InjectCSS();
  _fold16ApplyTemplate(container);
  container.querySelectorAll('.fold16-circle, .fold16-mover, .fold16-ghost').forEach(el => el.remove());

  const vis = _fold16Visible();
  for (const spec of _fold16CellList()) {
    const el = _f16Cell(container, spec.cs);
    if (!el) continue;
    _f16ClearFx(el);
    if (spec.foldBack) {
      // Back faces carry a marker so the shared double-tap handler in grid.js
      // routes a double-click here to "unfold" instead of the text editor.
      el.dataset.fold16Back = spec.foldBack;
      _f16SetShown(el, vis.shown.has(spec.cs), spec.cs);
    } else {
      _f16SetShown(el, !vis.hidden.has(spec.cs), spec.cs);
    }
  }
  _f16PlaceCircles(container);
  _f16SpeedPill();
  _f16WireContainer(container);
}

// Reset every transform-ish property this module ever sets on a real grid cell.
function _f16ClearFx(el) {
  el.style.transform = '';
  el.style.transition = '';
  el.style.transformOrigin = '';
  el.style.clipPath = '';
  el.style.webkitClipPath = '';
  el.style.backfaceVisibility = '';
  el.style.webkitBackfaceVisibility = '';
  el.style.zIndex = '';
  el.style.opacity = '';
}

// Show or hide a cell. Hiding pauses any player inside it — a folded square is
// out of sight, and a video that keeps talking from under the fold is a bug.
function _f16SetShown(el, on, cs) {
  el.style.display = on ? '' : 'none';
  if (!on && typeof gridTogglePauseCell === 'function') {
    try { gridTogglePauseCell(cs); } catch (_) {}
  }
}

// (dev0823) Where the grid actually IS, read back off a real cell rather than
// recomputed from the template. Whatever the tracks ended up being — measured px,
// the vmin fallback, even plain fractions — one visible cell plus its known row
// and column gives the true origin and track size. A folded block's own cells are
// display:none and measure zero, so walk the list until one answers; with every
// block folded that is the surviving back face, which is a real element sitting
// on a real landing square. Returns null only if the grid is not laid out at all.
function _f16Geom(container) {
  const cr = container.getBoundingClientRect();
  for (const spec of _fold16CellList()) {
    const el = _f16Cell(container, spec.cs);
    if (!el || !el.offsetWidth) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    return {
      cw: r.width, ch: r.height,
      ox: r.left - cr.left - (spec.c - 1) * r.width,
      oy: r.top  - cr.top  - (spec.r - 1) * r.height
    };
  }
  return null;
}

// Circles sit on grid geometry, not on the block's own cells — a folded block's
// cells are gone, but its circle still has to be there to unfold it.
function _f16PlaceCircles(container) {
  const g = _f16Geom(container);
  if (!g) return;
  const ox = g.ox, oy = g.oy, cell = g.cw;
  for (const b of FOLD16_BLOCKS) {
    if (!_fold16Enabled(b.id)) continue;      // hidden while B is down
    const tl = FOLD16_CELLS.find(o => o.cs === b.tl);
    const folded = !!_fold16[b.id];
    const dot = document.createElement('div');
    dot.className = 'fold16-circle' + (folded ? ' f16-folded' : '');
    dot.dataset.f16 = b.id;
    // The shared corner of the block's four cells = the bottom-right corner of
    // its top-left cell.
    dot.style.left = (ox + tl.c * cell) + 'px';
    dot.style.top  = (oy + tl.r * g.ch) + 'px';
    dot.title = (folded ? 'Double-click to unfold' : b.label) + ' (double-click)';
    dot.addEventListener('dblclick', e => {
      e.preventDefault(); e.stopPropagation();
      _fold16Toggle(b.id);
    }, true);
    ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'contextmenu']
      .forEach(t => dot.addEventListener(t, e => e.stopPropagation(), true));
    container.appendChild(dot);
  }
}

// (dev0822) A 40px circle is a small target, and a double-click that lands a few
// pixels off it used to fall through to the cell underneath — which in dev mode
// opens the text editor. Catch near-misses on the container in CAPTURE, before
// any cell sees them, and swallow every double-click outright while a fold is
// running.
function _f16WireContainer(container) {
  if (container._f16Wired) return;
  container._f16Wired = true;
  container.addEventListener('dblclick', e => {
    if (_fold16Busy) { e.preventDefault(); e.stopPropagation(); return; }
    const hit = _f16CircleAt(container, e.clientX, e.clientY);
    if (!hit) return;
    e.preventDefault(); e.stopPropagation();
    _fold16Toggle(hit);
  }, true);
  // (dev0824) …and the OTHER double-tap path. grid.js cannot rely on dblclick —
  // its cells preventDefault on pointerdown, which suppresses the browser's
  // synthesized dblclick — so it detects double-taps itself from two pointerups
  // inside 400ms. That never produces a dblclick event, so the handler above
  // cannot see it, and a near-miss on a circle was still reaching the cell and
  // opening the text editor. Record where the last release landed; _runDoubleTapAction
  // asks _fold16ClaimDoubleTap() about it before doing anything else.
  container.addEventListener('pointerup', e => {
    _f16LastPt = { x: e.clientX, y: e.clientY };
  }, true);
  // (dev0823) The square footprint and the circle positions are both measured, so
  // re-measure when the window changes shape. Guarded on the layout still being
  // 16F — _fold16Render on anything else would paint circles onto a normal grid.
  window.addEventListener('resize', () => {
    if (_fold16Busy) return;
    if (typeof _gridCurrentLayout === 'function' && _gridCurrentLayout() !== FOLD16_LAYOUT) return;
    const c = document.getElementById('gridContainer');
    if (c && c.offsetWidth) _fold16Render(c);
  });
}

// (dev0824) Where the last pointer release landed inside the grid, for the
// pointerup-based double-tap path above.
var _f16LastPt = null;

// Does the fold grid want this double-tap? Called first thing in grid.js's shared
// _runDoubleTapAction. Returns true when the tap has been handled (or should be
// thrown away) and the caller must not fall through to the editor routes.
function _fold16ClaimDoubleTap() {
  if (typeof _gridCurrentLayout === 'function' && _gridCurrentLayout() !== FOLD16_LAYOUT) return false;
  if (_fold16Busy) return true;              // mid-fold: swallow, never edit
  const container = document.getElementById('gridContainer');
  if (!container || !_f16LastPt) return false;
  const hit = _f16CircleAt(container, _f16LastPt.x, _f16LastPt.y);
  if (!hit) return false;
  _fold16Toggle(hit);
  return true;
}

// Block id whose circle is within a forgiving radius of this point, else null.
function _f16CircleAt(container, cx, cy) {
  let best = null, bestD = 46;   // px — generous, the circles are 100px+ apart
  container.querySelectorAll('.fold16-circle').forEach(dot => {
    const r = dot.getBoundingClientRect();
    const d = Math.hypot(cx - (r.left + r.width / 2), cy - (r.top + r.height / 2));
    if (d < bestD) { bestD = d; best = dot.dataset.f16; }
  });
  return best;
}

// ── The fold ─────────────────────────────────────────────────────────────────
function _fold16Toggle(id) {
  if (_fold16Busy) return;
  if (!_fold16Enabled(id)) return;
  const container = document.getElementById('gridContainer');
  if (!container) return;
  const b = _fold16Block(id);
  if (!b) return;
  if (_fold16[id]) _fold16Run(container, b, false);
  else _fold16Run(container, b, true);
}

function _f16Ease(p) { return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; }

// (dev0824) The fold's own easing: quick off the flat, SLOW through the middle,
// quick down onto the landing square. The middle is where the crease stands up
// and the raised paper is seen edge-on at an angle — the part worth watching —
// and an ordinary ease-in-out is at its fastest exactly there. Derivative is
// 1 + a·cos(2πp): 1.75 at each end, 0.25 at the halfway point.
function _f16EaseFold(p) { return p + 0.75 * Math.sin(2 * Math.PI * p) / (2 * Math.PI); }

function _f16Animate(dur, onFrame, onDone, ease) {
  const fn = ease || _f16Ease;
  const t0 = performance.now();
  (function step(now) {
    const p = Math.min(1, (now - t0) / dur);
    onFrame(fn(p));
    if (p < 1) requestAnimationFrame(step);
    else if (onDone) onDone();
  })(performance.now());
}


// A live copy of a cell clipped to one half. Iframes and videos are stripped —
// a cloned iframe would reload the provider, and the poster underneath is all we
// need for half a second of motion.
function _f16Mover(srcEl, clip, origin) {
  const m = srcEl.cloneNode(true);
  m.className = (srcEl.className || '') + ' fold16-mover';
  delete m.dataset.cell;          // never let _f16Cell find the clone
  delete m.dataset.fold16Back;
  m.removeAttribute('data-cell');
  m.querySelectorAll('iframe, video').forEach(n => n.remove());
  m.style.pointerEvents = 'none';
  m.style.display = '';
  m.style.clipPath = clip;
  m.style.webkitClipPath = clip;
  m.style.transformOrigin = origin;
  m.style.transform = '';
  return m;
}

// ── (dev0828) The collapse ───────────────────────────────────────────────────
// Rewritten from rotations to CORNER PATHS. Every corner of the block sits at a
// fixed distance from the circle — the three outer corners a cell-diagonal away,
// the edge corners one cell — so the whole fold is a spherical motion about the
// circle and each corner just travels its own arc on that sphere.
//
// The three OUTER corners (of the two side cells and of the corner cell — 1, 2
// and 3) all rise to a single APEX one cell-diagonal directly above the circle,
// meet there, then come down together onto the far corner of the landing square.
// That is the shape of the paper fold: the middle lifts into a point, everything
// gathers to it, and it drops flat. No fixed hinge can produce that path, which
// is why rotate3d could only ever slide.
//
// Corners shared with the landing square never move; the circle never moves.
//
// Rendering: each moving cell is cut along the crease through the circle into two
// TRIANGLES, and each triangle is drawn by solving the 2D affine matrix that maps
// its flat corners onto its projected ones. Three points determine an affine map
// exactly, so a triangle can be sent anywhere three corners go — no rigid-body
// constraint, no origami that CSS refuses to express.
const _F16_CAM = 1700;   // perspective distance in px; larger = flatter

function _f16Norm(v) {
  const m = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / m, v[1] / m, v[2] / m];
}
function _f16Slerp(a, b, u) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  d = Math.max(-1, Math.min(1, d));
  const w = Math.acos(d);
  if (w < 1e-6) return a.slice();
  const s = Math.sin(w), k1 = Math.sin((1 - u) * w) / s, k2 = Math.sin(u * w) / s;
  return [a[0] * k1 + b[0] * k2, a[1] * k1 + b[1] * k2, a[2] * k1 + b[2] * k2];
}

// One corner's arc, in block-local units (landing square = 0..1, circle = (1,1)).
// Corners that do not move, and the circle itself, return a constant.
function _f16Path(S, E) {
  const P = [1, 1];
  const r = Math.hypot(S[0] - P[0], S[1] - P[1]);
  if (r < 1e-9) return () => [P[0], P[1], 0];
  if (Math.abs(S[0] - E[0]) < 1e-9 && Math.abs(S[1] - E[1]) < 1e-9)
    return () => [S[0], S[1], 0];
  const dS = _f16Norm([S[0] - P[0], S[1] - P[1], 0]);
  const dE = _f16Norm([E[0] - P[0], E[1] - P[1], 0]);
  // The outer corners (a cell-diagonal out) go straight up to the shared apex.
  // The edge corners lift over a waypoint between where they start and land, so
  // the paper billows instead of sliding round the circle in-plane.
  const dW = (r > 1.2) ? [0, 0, 1] : _f16Norm([dS[0] + dE[0], dS[1] + dE[1], 1.7]);
  return t => {
    const d = (t <= 0.5) ? _f16Slerp(dS, dW, t * 2) : _f16Slerp(dW, dE, t * 2 - 1);
    return [P[0] + r * d[0], P[1] + r * d[1], r * d[2]];
  };
}

// Block-local → container pixels. A BR block (block A) is the same geometry
// mirrored through the landing square, so one flag covers both orientations.
function _f16Place(o, p) {
  const bx = o.flip ? (1 - p[0]) : p[0];
  const by = o.flip ? (1 - p[1]) : p[1];
  return { X: o.landX + bx * o.cell, Y: o.landY + by * o.cell, Z: p[2] * o.cell };
}
// Perspective about the middle of the grid: rising toward the viewer grows.
function _f16Project(o, q) {
  const s = _F16_CAM / (_F16_CAM - q.Z);
  return [o.cx + (q.X - o.cx) * s, o.cy + (q.Y - o.cy) * s];
}

// The affine matrix taking a triangle's flat corners v[] to its live corners w[],
// both in the element's own pixel frame. Returns null for a degenerate triangle
// (the two halves of a side cell collapse onto each other at the end of a fold).
function _f16Affine(v, w) {
  const Ax = v[1][0] - v[0][0], Ay = v[1][1] - v[0][1];
  const Bx = v[2][0] - v[0][0], By = v[2][1] - v[0][1];
  const det = Ax * By - Ay * Bx;
  if (Math.abs(det) < 1e-6) return null;
  const ax = w[1][0] - w[0][0], ay = w[1][1] - w[0][1];
  const bx = w[2][0] - w[0][0], by = w[2][1] - w[0][1];
  const a = (ax * By - bx * Ay) / det;
  const c = (bx * Ax - ax * Bx) / det;
  const b = (ay * By - by * Ay) / det;
  const d = (by * Ax - ay * Bx) / det;
  const e = w[0][0] - (a * v[0][0] + c * v[0][1]);
  const f = w[0][1] - (b * v[0][0] + d * v[0][1]);
  return 'matrix(' + a + ',' + b + ',' + c + ',' + d + ',' + e + ',' + f + ')';
}

// Which cell sits in each block-local slot. Block-local always puts the landing
// square at 0..1 and the corner square at 1..2; for a BR block that is a mirror,
// so its "right" slot is the cell to the LEFT of the landing square.
function _f16Slots(b) {
  return (b.orient === 'BR')
    ? { R: b.bl, B: b.tr, D: b.diag }
    : { R: b.tr, B: b.bl, D: b.diag };
}

// Every triangle drawn during a fold: which cell it is cut from, its three flat
// block-local corners, and where each of those corners ends up. The crease in
// each cell runs through the circle, so the two triangles of a side cell fold
// onto each other and the cell finishes as a single triangle inside the landing
// square. The corner square keeps its shape and lands on the landing square
// mirrored, which is exactly why its BACK is what you end up looking at.
function _f16Tris(slots) {
  const P = [1, 1], O = [0, 0];
  const mk = (cell, tri, back) => ({ cell: cell, tri: tri, back: !!back });
  return [
    mk(slots.R, [[[1, 0], [1, 0]], [[2, 0], O], [P, P]]),
    mk(slots.R, [[[2, 0], O], [[2, 1], [1, 0]], [P, P]]),
    mk(slots.B, [[[0, 1], [0, 1]], [P, P], [[0, 2], O]]),
    mk(slots.B, [[P, P], [[1, 2], [0, 1]], [[0, 2], O]]),
    mk(slots.D, [[P, P], [[2, 1], [1, 0]], [[2, 2], O]], true),
    mk(slots.D, [[P, P], [[2, 2], O], [[1, 2], [0, 1]]], true)
  ];
}

function _fold16Run(container, b, folding) {
  _fold16Busy = true;

  // Both directions need the block's four cells in the DOM, so drop the state
  // and re-render first: a no-op on a fold, and on an unfold it puts the cells
  // back so there is something to open.
  if (!folding) { _fold16[b.id] = false; _fold16Render(container); }

  const geo = _f16Geom(container);
  const land = _f16Cell(container, b.land);
  const back = _f16Cell(container, b.back);
  if (!geo || !land) {   // nothing measurable — snap, do not animate into a mess
    _fold16[b.id] = folding;
    _fold16Render(container);
    _fold16Busy = false;
    return;
  }

  const crect = container.getBoundingClientRect();
  const lrect = land.getBoundingClientRect();
  const o = {
    cell: geo.cw, flip: (b.orient === 'BR'),
    landX: lrect.left - crect.left, landY: lrect.top - crect.top,
    cx: crect.width / 2, cy: crect.height / 2
  };
  const slots = _f16Slots(b);

  // Build one clipped clone per triangle. The clone is positioned by the grid on
  // its source cell, so its own pixel frame starts at that cell's top-left.
  const parts = [];
  const ghosts = [];
  for (const spec of _f16Tris(slots)) {
    const src = _f16Cell(container, spec.cell);
    if (!src) continue;
    const srect = src.getBoundingClientRect();
    const ex = srect.left - crect.left, ey = srect.top - crect.top;
    const flat = spec.tri.map(pair => {
      const q = _f16Place(o, [pair[0][0], pair[0][1], 0]);
      return [q.X - ex, q.Y - ey];
    });
    const clip = 'polygon(' + flat.map(p =>
      (p[0] / o.cell * 100).toFixed(3) + '% ' + (p[1] / o.cell * 100).toFixed(3) + '%').join(', ') + ')';
    const el = _f16Mover(src, clip, '0 0', 0);
    el.style.transformOrigin = '0 0';
    el.style.backfaceVisibility = '';
    el.style.zIndex = spec.back ? '76' : '72';
    container.appendChild(el);
    const part = { el: el, flat: flat, ex: ex, ey: ey, paths: spec.tri.map(pr => _f16Path(pr[0], pr[1])) };
    // The corner square is two-sided: its own picture while the front faces us,
    // the BACK cell's once it has turned past edge-on. Both are clipped to the
    // same triangle and driven by the same corners; only one is ever shown. The
    // back's own flat corners are where the front's corners LAND, so when the
    // fold completes its matrix is the identity and the new picture sits square
    // on the landing cell rather than mirrored.
    if (spec.back && back) {
      const brect = back.getBoundingClientRect();
      const bx = brect.left - crect.left, by = brect.top - crect.top;
      const bflat = spec.tri.map(pair => {
        const q = _f16Place(o, [pair[1][0], pair[1][1], 0]);
        return [q.X - bx, q.Y - by];
      });
      const bclip = 'polygon(' + bflat.map(p =>
        (p[0] / o.cell * 100).toFixed(3) + '% ' + (p[1] / o.cell * 100).toFixed(3) + '%').join(', ') + ')';
      const bel = _f16Mover(back, bclip, '0 0', 0);
      bel.style.transformOrigin = '0 0';
      bel.style.backfaceVisibility = '';
      bel.style.zIndex = '77';
      container.appendChild(bel);
      part.backEl = bel; part.bflat = bflat; part.bex = bx; part.bey = by;
    }
    parts.push(part);
  }

  // Nothing is cut away from the grid itself: the source cells stay put and
  // dissolve, so a lifting flap never opens a hard-edged hole onto the
  // background. The landing square keeps its picture until the fold covers it.
  for (const cs of [slots.R, slots.B, slots.D]) {
    const el = _f16Cell(container, cs);
    if (el) { el.style.display = ''; el.style.clipPath = ''; el.style.transform = ''; el.style.zIndex = '55'; ghosts.push(el); }
  }
  if (back) back.style.display = 'none';
  land.style.display = '';
  land.style.zIndex = '58';

  const sweep = t => {
    for (const p of parts) {
      const w3 = p.paths.map(fn => fn(t));
      const wpx = w3.map(q => _f16Project(o, _f16Place(o, q)));
      const front = wpx.map(q => [q[0] - p.ex, q[1] - p.ey]);
      // Signed area flips exactly when the paper turns past edge-on.
      const area = (front[1][0] - front[0][0]) * (front[2][1] - front[0][1])
                 - (front[2][0] - front[0][0]) * (front[1][1] - front[0][1]);
      const flatArea = (p.flat[1][0] - p.flat[0][0]) * (p.flat[2][1] - p.flat[0][1])
                     - (p.flat[2][0] - p.flat[0][0]) * (p.flat[1][1] - p.flat[0][1]);
      const showBack = !!p.backEl && (area * flatArea < 0);
      const m = _f16Affine(p.flat, front);
      p.el.style.display = (m && !showBack) ? '' : 'none';
      if (m && !showBack) p.el.style.transform = m;
      if (p.backEl) {
        const bw = wpx.map(q => [q[0] - p.bex, q[1] - p.bey]);
        const bm = _f16Affine(p.bflat, bw);
        p.backEl.style.display = (bm && showBack) ? '' : 'none';
        if (bm && showBack) p.backEl.style.transform = bm;
      }
    }
    const fade = Math.max(0, 1 - t / 0.55);
    ghosts.forEach(el => { el.style.opacity = String(fade); });
  };

  const finish = () => {
    parts.forEach(p => { p.el.remove(); if (p.backEl) p.backEl.remove(); });
    ghosts.forEach(el => { el.style.opacity = ''; el.style.zIndex = ''; });
    land.style.zIndex = '';
    _fold16[b.id] = folding;
    _fold16Render(container);
    _fold16Busy = false;
    if (folding && typeof _gridToast === 'function') _gridToast(b.diag + ' back', 1100);
  };

  if (folding) {
    sweep(0);
    _f16Animate(_f16Dur(), sweep, finish, _f16EaseFold);
  } else {
    sweep(1);
    _f16Animate(_f16Dur(), t => sweep(1 - t), finish, _f16EaseFold);
  }
}

// ── CSS ──────────────────────────────────────────────────────────────────────
// Injected once. Note for future edits: no backticks anywhere in this template —
// a stray one kills the whole parse (see the save-stale/backtick trap).
var _f16CssDone = false;
function _f16InjectCSS() {
  if (_f16CssDone) return;
  _f16CssDone = true;
  const s = document.createElement('style');
  s.id = 'fold16-css';
  s.textContent = [
    '.fold16-circle {',
    '  position:absolute; width:40px; height:40px; margin:-20px 0 0 -20px;',
    '  border-radius:50%; border:2px solid rgba(255,238,200,0.92);',
    '  background:radial-gradient(circle at 38% 34%, rgba(255,255,255,0.34), rgba(0,0,0,0.52));',
    '  box-shadow:0 0 0 2px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.65);',
    '  cursor:pointer; z-index:90; transition:transform .14s ease, border-color .14s ease;',
    '}',
    // A transparent collar so a double-click that misses the ring still counts.
    '.fold16-circle::after {',
    '  content:""; position:absolute; left:-14px; top:-14px; right:-14px; bottom:-14px;',
    '  border-radius:50%;',
    '}',
    '.fold16-circle:hover { transform:scale(1.16); border-color:#fff; }',
    '.fold16-circle.f16-folded { border-color:rgba(255,190,90,0.95);',
    '  background:radial-gradient(circle at 38% 34%, rgba(255,214,140,0.5), rgba(60,30,0,0.62)); }',
    // (dev0826) Fold-speed pill, bottom-left of the grid. Bottom-RIGHT is taken
    // by the source buttons and the version badge; top-left by the info bar.
    '.fold16-speed {',
    '  position:absolute; left:14px; bottom:14px; z-index:95;',
    '  font-family:monospace; color:#fc9; user-select:none; text-align:center;',
    '  background:rgba(0,0,0,0.72); border:1px solid rgba(255,180,80,0.45);',
    '  border-radius:7px; padding:6px 10px 5px; min-width:104px;',
    '  box-shadow:0 3px 12px rgba(0,0,0,0.6);',
    '}',
    '.fold16-speed .f16-speed-cap { font-size:9px; letter-spacing:0.09em; color:#c98; }',
    '.fold16-speed .f16-speed-row {',
    '  display:flex; align-items:center; justify-content:center; gap:6px; margin:1px 0 0;',
    '}',
    '.fold16-speed .f16-speed-num {',
    '  font-size:23px; line-height:1.15; color:#ffe; min-width:40px; font-weight:bold;',
    '}',
    '.fold16-speed .f16-speed-ms { font-size:9px; color:#a87; }',
    '.fold16-speed .f16-speed-btn {',
    '  cursor:pointer; padding:1px 7px; border-radius:3px; color:#ffd; font-size:14px;',
    '  background:rgba(255,160,0,0.16);',
    '}',
    '.fold16-speed .f16-speed-btn:hover { background:rgba(255,160,0,0.38); }',
    '.fold16-mover { pointer-events:none; }',
    // (dev0824) The reverse of a folding half — the same picture, darkened, so
    // the flap keeps showing content past edge-on instead of turning into a
    // sheet of blank colour. brightness alone, no tint: a colour cast here is
    // how the manila crept back in.
    '.fold16-reverse { filter:brightness(0.42); }',
    '.fold16-ghost { pointer-events:none; }'
  ].join('\n');
  document.head.appendChild(s);
}

window.FOLD16_LAYOUT = FOLD16_LAYOUT;
window.FOLD16_CELLS = FOLD16_CELLS;
window.FOLD16_BLOCKS = FOLD16_BLOCKS;
window._fold16CellList = _fold16CellList;
window._fold16IsBackKey = _fold16IsBackKey;
window._fold16BackBlock = _fold16BackBlock;
window._fold16Render = _fold16Render;
window._fold16Reset = _fold16Reset;
window._fold16Toggle = _fold16Toggle;
window._fold16ClaimDoubleTap = _fold16ClaimDoubleTap;
window._fold16Slow = _fold16Slow;
window._fold16ApplyTemplate = _fold16ApplyTemplate;
