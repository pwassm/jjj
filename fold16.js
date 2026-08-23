// ══════════════════════════════════════════════════════════════════════════════
// 16F — THE FOLD GRID  (dev0820, animation rebuilt dev0822, dev0824, dev0825)
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
// One crease, not three. The block turns about its own 45° diagonal — the line
// running corner to corner through the circle — exactly as the paper does:
//
//        1a │ 1b            the crease is the / through the circle;
//       ────●────           everything on the 1a side of it turns over
//        2a │ 2b            onto the 2b side.
//
//   • the DIAGONAL cell (1a) has the crease along its far edges, so it turns as
//     a whole and comes down flat on the landing square — face DOWN, which is
//     why what you end up looking at is 1a's BACK;
//   • the two SIDE cells (1b, 2a) are cut in half by the crease, so each folds
//     in half along its own / diagonal — half stays put, half turns over.
//
// One shared angle θ sweeps 0°→180°, driven from a rAF loop rather than CSS
// transitions so every piece stays on the same crease frame by frame. The back
// face rides that sweep from the other side: it is backface-hidden, so it appears
// at 90° edge-on and flattens out to face-up at 180° — the new picture opening
// rather than popping in. The easing is deliberately SLOWEST in the middle, where
// the crease stands up and the raised paper is seen at an angle.
//
// (dev0825) And the block RISES while it does. θ alone is a flat motion — pieces
// pivoting in the plane of the screen, which reads as sliding, not folding. The
// whole block also tilts up about the 45° line through its OUTER corner (see
// _f16Lift / _f16Frames), so the circle — the point furthest from that axis —
// lifts off the plane, peaks at the halfway mark and comes back down folded
// inside. Unfolding runs it backwards: the stack opens, the centre rises, and the
// two creased side cells drop through a pair of shallow ridges that flatten to
// nothing at the end.
//
// (dev0824) Two things this must never show, both learned the hard way:
//   • no blank paper. The reverse of a folding half is the cell's own picture,
//     dimmed — not a manila panel, which put yellow-orange triangles on screen.
//   • no holes. A lifting flap leaves bare grid background behind it, which reads
//     as a hard-edged navy triangle; instead the cell stays whole underneath and
//     DISSOLVES, so no cut edge is ever visible.
// There is also no second "tuck" beat any more: the resting state already hides
// all four cells and shows only the back face, so tucking the leftover triangles
// under was half a second of large shapes moving after the fold had finished.
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

// ── Crease geometry ──────────────────────────────────────────────────────────
// Two mirror-image cases: a block either collapses onto its BOTTOM-RIGHT cell
// (block A, where the outer corner 1a is top-left) or onto its TOP-LEFT cell
// (blocks B and C). Everything else follows from that.
//
//   sign        which way the flap lifts. The crease axis is (1,-1,0); a point
//               offset down-right of it rises toward the viewer at +θ, so the
//               half that moves picks the sign that lifts rather than sinks.
//   *Origin     a point ON the crease, expressed in that element's own box —
//               for the diagonal and landing cells that is the block's centre
//               corner; for a side cell it is its own centre, since the crease
//               runs corner to corner through it.
//   movingClip  the half of a side cell that turns over; staticClip the half
//               that stays. Together they tile the square.
//   tuckTR/BL   how each leftover triangle folds under the landing square: the
//               edge it shares with that square.
const _F16_ORIENT = {
  BR: {
    sign: -1,
    diagOrigin: '100% 100%', backOrigin: '0% 0%',
    movingClip: 'polygon(0 0, 100% 0, 0 100%)',
    staticClip: 'polygon(100% 0, 100% 100%, 0 100%)',
    tuckTR: { o: '50% 100%', t: d => 'rotateX(' + (-d) + 'deg)' },  // via its bottom edge
    tuckBL: { o: '100% 50%', t: d => 'rotateY(' + d + 'deg)' }      // via its right edge
  },
  TL: {
    sign: 1,
    diagOrigin: '0% 0%', backOrigin: '100% 100%',
    movingClip: 'polygon(100% 0, 100% 100%, 0 100%)',
    staticClip: 'polygon(0 0, 100% 0, 0 100%)',
    tuckTR: { o: '0% 50%',  t: d => 'rotateY(' + (-d) + 'deg)' },   // via its left edge
    tuckBL: { o: '50% 0%',  t: d => 'rotateX(' + d + 'deg)' }       // via its top edge
  }
};

// The crease axis. Cells are square (see _fold16ApplyTemplate), so the corner-to-
// corner diagonal is exactly 45° and this constant vector is the real crease.
function _f16Rot(deg) { return 'rotate3d(1,-1,0,' + deg + 'deg)'; }

// ── (dev0825) The rise ───────────────────────────────────────────────────────
// The centre of the block lifts OFF the plane during the fold and ends tucked
// inside — the whole block tilts up about the 45° line through its OUTER corner,
// the corner of the landing square furthest from the circle. The circle itself is
// the point furthest from that axis, so it rises highest; the outer corner is
// pinned and never moves. Peaks at the halfway point and is back to zero at both
// ends, so the start and finish are untouched.
//
// This tilt and each piece's own crease turn about PARALLEL axes — both run at
// 45°, one through the block's outer corner and one through the circle — which is
// what makes it composable on a single element instead of needing a wrapper per
// piece. transform-origin is put on the block's outer corner (often outside the
// element's own box, which is legal), and the crease is expressed relative to it:
// translate out to the crease, turn, translate back, then apply the tilt. Read
// right to left, CSS applies the innermost first.
const _F16_LIFT_DEG = 30;
function _f16Lift(t) { return _F16_LIFT_DEG * Math.sin(Math.PI * t); }

function _f16Compose(lam, d, th) {
  return _f16Rot(lam)
    + ' translate(' + d[0] + 'px,' + d[1] + 'px) '
    + _f16Rot(th)
    + ' translate(' + (-d[0]) + 'px,' + (-d[1]) + 'px)';
}

// Per-piece geometry for one block at cell size c: `o` is the block's outer
// corner in that element's own coordinates (the shared tilt origin), `d` the
// vector from it to that piece's own crease axis. The two orientations are
// mirror images — for TL the outer corner is the landing cell's top-left and the
// rest of the block lies down-right of it; for BR it is the bottom-right corner
// and the block lies up-left.
function _f16Frames(orient, c) {
  if (orient === 'TL') return {
    land: { o: '0px 0px',                    d: [0, 0] },
    tr:   { o: (-c) + 'px 0px',              d: [1.5 * c, 0.5 * c] },
    bl:   { o: '0px ' + (-c) + 'px',         d: [0.5 * c, 1.5 * c] },
    diag: { o: (-c) + 'px ' + (-c) + 'px',   d: [c, c] },
    back: { o: '0px 0px',                    d: [c, c] }
  };
  return {
    land: { o: c + 'px ' + c + 'px',             d: [0, 0] },
    tr:   { o: c + 'px ' + (2 * c) + 'px',       d: [-0.5 * c, -1.5 * c] },
    bl:   { o: (2 * c) + 'px ' + c + 'px',       d: [-1.5 * c, -0.5 * c] },
    diag: { o: (2 * c) + 'px ' + (2 * c) + 'px', d: [-c, -c] },
    back: { o: c + 'px ' + c + 'px',             d: [-c, -c] }
  };
}

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
  if (el) el.querySelector('.f16-speed-val').textContent = _f16SlowLabel();
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
  wrap.innerHTML = '<span class="f16-speed-btn" data-dir="-1" title="Faster">−</span>'
    + '<span class="f16-speed-val">' + _f16SlowLabel() + '</span>'
    + '<span class="f16-speed-btn" data-dir="1" title="Slower">+</span>';
  wrap.querySelectorAll('.f16-speed-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      _f16SlowStep(parseInt(btn.dataset.dir, 10));
    }, true);
  });
  ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu']
    .forEach(t => wrap.addEventListener(t, e => e.stopPropagation(), true));
  overlay.appendChild(wrap);
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

// (dev0824) The REVERSE of a folding half. This used to be a blank manila panel,
// which is what put yellow-orange triangles across the grid — nothing on this
// screen should be a flat sheet of paper colour. It is now the cell's own picture
// again, dimmed: past 90° you see the same image darkened, the way paper reads
// when the light is behind it. Rides 180° ahead of the front half, so it takes
// over exactly as the front turns edge-on.
function _f16Back(srcEl, clip, origin, deg) {
  const p = _f16Mover(srcEl, clip, origin, deg);
  p.classList.add('fold16-reverse');
  return p;
}

// (dev0824) A still copy left behind where a folding piece used to be, fading out
// as the fold proceeds. Paper lifting off a table really does leave a hole, but a
// hard-edged hole here is a navy triangle of grid background — the blue the fold
// was showing. Dissolving the picture instead reads as the paper coming away and
// leaves no cut edge anywhere.
function _f16Ghost(srcEl) {
  const gh = _f16Mover(srcEl, '', '50% 50%', 0);
  gh.classList.add('fold16-ghost');
  gh.style.transform = '';
  gh.style.backfaceVisibility = '';
  gh.style.zIndex = '55';
  return gh;
}

// A live copy of a cell clipped to one half. Iframes and videos are stripped —
// a cloned iframe would reload the provider, and the poster underneath is all we
// need for half a second of motion.
function _f16Mover(srcEl, clip, origin, deg) {
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
  m.style.backfaceVisibility = 'hidden';
  m.style.webkitBackfaceVisibility = 'hidden';
  m.style.transform = _f16Rot(deg);
  return m;
}

// folding === true  → 0° to 180°, then tuck the leftovers under
// folding === false → untuck, then 180° back to 0°
function _fold16Run(container, b, folding) {
  _fold16Busy = true;
  const g = _F16_ORIENT[b.orient];
  const sgn = g.sign;

  // Both beats need the block's four cells present, so drop the state and
  // re-render first: on a fold that is a no-op, on an unfold it puts the cells
  // back so they have something to swing open from.
  if (!folding) { _fold16[b.id] = false; _fold16Render(container); }

  // (dev0825) Cell size drives the crease offsets, so the whole block has to be
  // measured before anything moves. Without it fall back to the flat fold.
  const geo = _f16Geom(container);
  const cellPx = geo ? geo.cw : 0;
  const F = _f16Frames(b.orient, cellPx);
  // No measurement, no rise: fall back to each piece turning about its own crease
  // with the block flat. Correct endpoints either way, just without the lift.
  const liftOn = cellPx > 0;
  if (!liftOn) {
    F.diag = { o: g.diagOrigin, d: [0, 0] };
    F.back = { o: g.backOrigin, d: [0, 0] };
    F.land = { o: '50% 50%', d: [0, 0] };
    F.tr   = { o: '50% 50%', d: [0, 0] };
    F.bl   = { o: '50% 50%', d: [0, 0] };
  }

  const diag = _f16Cell(container, b.diag);
  const back = _f16Cell(container, b.back);
  const land = _f16Cell(container, b.land);
  const sides = [
    { el: _f16Cell(container, b.tr), fr: F.tr },
    { el: _f16Cell(container, b.bl), fr: F.bl }
  ].filter(s => s.el);

  // The diagonal cell turns as a whole about the block crease…
  if (diag) {
    diag.style.display = '';
    diag.style.transformOrigin = F.diag.o;
    diag.style.backfaceVisibility = 'hidden';
    diag.style.webkitBackfaceVisibility = 'hidden';
    diag.style.zIndex = '73';
  }
  // …and the back face rides the same crease from the other side: hidden while
  // it faces away, edge-on at 90°, flat and face-up at 180°.
  if (back) {
    back.style.display = '';
    back.style.transformOrigin = F.back.o;
    back.style.backfaceVisibility = 'hidden';
    back.style.webkitBackfaceVisibility = 'hidden';
    back.style.zIndex = '74';
  }
  // The landing square tilts with the rest of the block — it has no crease of its
  // own, but it owns the corner the whole block pivots on, and leaving it flat is
  // what made the old fold look like pieces sliding rather than paper lifting.
  if (land) {
    land.style.display = '';
    land.style.transformOrigin = F.land.o;
    land.style.zIndex = '58';
  }

  // (dev0824) Each side cell is creased corner to corner. The half beyond the
  // crease lifts — a clipped clone, with its dimmed reverse riding behind it —
  // while the cell itself stays WHOLE underneath as a ghost that fades out. The
  // old version clipped the real cell down to its static half, so the moment the
  // flap rose you were looking at bare grid background through a triangular hole:
  // that is where the blue came from. Nothing is cut away now; it dissolves.
  const movers = [], backs = [], ghosts = [];
  for (const s of sides) {
    s.el.style.display = '';
    s.el.style.clipPath = '';
    s.el.style.webkitClipPath = '';
    s.el.style.transform = '';
    s.el.style.zIndex = '55';
    const m = _f16Mover(s.el, g.movingClip, s.fr.o, 0);
    const p = _f16Back(s.el, g.movingClip, s.fr.o, 0);
    m.style.zIndex = '71'; p.style.zIndex = '70';
    container.appendChild(m); container.appendChild(p);
    movers.push({ el: m, fr: s.fr }); backs.push({ el: p, fr: s.fr });
    ghosts.push(s.el);
    // (dev0825) The static half is a clone too now, so it can ride the block tilt
    // while the real cell stays put underneath and dissolves. Without it the half
    // that does NOT turn stayed flat on the plane while everything around it rose,
    // and the crease tore open down the middle of the square.
    const st = _f16Mover(s.el, g.staticClip, s.fr.o, 0);
    st.style.zIndex = '69';
    container.appendChild(st);
    movers.push({ el: st, fr: s.fr, still: true });
  }
  // The corner square turns away bodily, so its footprint needs a ghost of its
  // own — otherwise the one square that travels furthest leaves the largest hole.
  if (diag) {
    const gh = _f16Ghost(diag);
    container.appendChild(gh);
    ghosts.push(gh);
  }

  const sweep = t => {                   // t = 0 (flat) … 1 (folded)
    const th = 180 * t;
    const lam = liftOn ? sgn * _f16Lift(t) : 0;   // the block tilting up off the plane
    if (diag) diag.style.transform = _f16Compose(lam, F.diag.d, sgn * th);
    if (back) back.style.transform = _f16Compose(lam, F.back.d, sgn * (th - 180));
    if (land) land.style.transform = _f16Compose(lam, F.land.d, 0);
    movers.forEach(m => {
      m.el.style.transform = _f16Compose(lam, m.fr.d, m.still ? 0 : sgn * th);
    });
    backs.forEach(p => {
      p.el.style.transform = _f16Compose(lam, p.fr.d, sgn * (th + 180));
    });
    // Everything left behind dissolves over the first two thirds, so the picture
    // is gone before the corner square lands on top of where it used to be.
    const fade = Math.max(0, 1 - t / 0.66);
    ghosts.forEach(el => { el.style.opacity = String(fade); });
  };

  const finish = () => {
    movers.forEach(m => m.el.remove());
    backs.forEach(p => p.el.remove());
    if (land) { land.style.transform = ''; land.style.transformOrigin = ''; land.style.zIndex = ''; }
    ghosts.forEach(el => { el.style.opacity = ''; });
    if (diag) { const gh = container.querySelector('.fold16-ghost'); if (gh) gh.remove(); }
    container.querySelectorAll('.fold16-ghost').forEach(el => el.remove());
    _fold16[b.id] = folding;
    _fold16Render(container);
    _fold16Busy = false;
    if (folding && typeof _gridToast === 'function') _gridToast(b.diag + ' back', 1100);
  };

  // (dev0824) One continuous turn, no second beat. The old tuck-the-ears stage
  // existed to make the folded footprint exactly one square, but the resting
  // state already does that — _fold16Visible hides all four cells and shows only
  // the back face — so all the tuck ever did was rotate two big half-squares
  // across the grid after the fold had visually finished.
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
    '  position:absolute; left:10px; bottom:10px; z-index:95;',
    '  display:flex; align-items:center; gap:2px;',
    '  font:11px/1 monospace; color:#fc9; user-select:none;',
    '  background:rgba(0,0,0,0.62); border:1px solid rgba(255,180,80,0.42);',
    '  border-radius:5px; padding:3px 4px;',
    '}',
    '.fold16-speed .f16-speed-val { min-width:56px; text-align:center; padding:0 3px; }',
    '.fold16-speed .f16-speed-btn {',
    '  cursor:pointer; padding:2px 7px; border-radius:3px; color:#ffd;',
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
