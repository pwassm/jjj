// ══════════════════════════════════════════════════════════════════════════════
// 16F — THE FOLD GRID  (dev0820, animation rebuilt dev0822)
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
//     in half along its own / diagonal — half stays put, half turns over and
//     shows blank paper;
//   • that leaves two triangles poking out past the landing square, which then
//     TUCK under it (the short second beat) to leave a clean single square.
//
// The whole first beat is one shared angle θ sweeping 0°→180°, driven from a
// rAF loop rather than CSS transitions so every piece stays on the same crease
// frame by frame. The back face rides the same sweep from the other side: it is
// backface-hidden, so it appears at 90° edge-on and flattens out to face-up at
// 180° — the new picture opening rather than popping in.
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
const _F16_TUCK_MS = 240; // the two leftover triangles folding under
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
  container.querySelectorAll('.fold16-circle, .fold16-paper, .fold16-mover').forEach(el => el.remove());

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

function _f16Animate(dur, onFrame, onDone) {
  const t0 = performance.now();
  (function step(now) {
    const p = Math.min(1, (now - t0) / dur);
    onFrame(_f16Ease(p));
    if (p < 1) requestAnimationFrame(step);
    else if (onDone) onDone();
  })(performance.now());
}

// A blank manila triangle standing in for the reverse of a half-square, so the
// side flaps show paper once they pass edge-on instead of blinking out.
function _f16Paper(srcEl, clip, origin, deg) {
  const p = document.createElement('div');
  p.className = 'fold16-paper';
  p.style.gridRow = srcEl.style.gridRow;
  p.style.gridColumn = srcEl.style.gridColumn;
  p.style.clipPath = clip;
  p.style.webkitClipPath = clip;
  p.style.transformOrigin = origin;
  p.style.transform = _f16Rot(deg);
  return p;
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

  const diag = _f16Cell(container, b.diag);
  const back = _f16Cell(container, b.back);
  const land = _f16Cell(container, b.land);
  const sides = [
    { el: _f16Cell(container, b.tr), tuck: g.tuckTR },
    { el: _f16Cell(container, b.bl), tuck: g.tuckBL }
  ].filter(s => s.el);

  // The diagonal cell turns as a whole about the block crease…
  if (diag) {
    diag.style.display = '';
    diag.style.transformOrigin = g.diagOrigin;
    diag.style.backfaceVisibility = 'hidden';
    diag.style.webkitBackfaceVisibility = 'hidden';
    diag.style.zIndex = '73';
  }
  // …and the back face rides the same crease from the other side: hidden while
  // it faces away, edge-on at 90°, flat and face-up at 180°.
  if (back) {
    back.style.display = '';
    back.style.transformOrigin = g.backOrigin;
    back.style.backfaceVisibility = 'hidden';
    back.style.webkitBackfaceVisibility = 'hidden';
    back.style.zIndex = '74';
  }
  if (land) land.style.display = '';

  // Each side cell is cut in half by the crease: the static half stays on the
  // real cell, the moving half is a clipped clone (plus its paper reverse).
  const movers = [], papers = [];
  for (const s of sides) {
    s.el.style.display = '';
    s.el.style.clipPath = g.staticClip;
    s.el.style.webkitClipPath = g.staticClip;
    s.el.style.transformOrigin = s.tuck.o;
    s.el.style.zIndex = '60';           // under the landing square, ready to tuck
    const m = _f16Mover(s.el, g.movingClip, '50% 50%', folding ? 0 : sgn * 180);
    const p = _f16Paper(s.el, g.movingClip, '50% 50%', folding ? sgn * 180 : sgn * 360);
    m.style.zIndex = '71'; p.style.zIndex = '70';
    container.appendChild(m); container.appendChild(p);
    movers.push(m); papers.push(p);
  }

  const sweep = t => {                   // t = 0 (flat) … 1 (folded)
    const th = 180 * t;
    if (diag) diag.style.transform = _f16Rot(sgn * th);
    if (back) back.style.transform = _f16Rot(sgn * (th - 180));
    movers.forEach(m => m.style.transform = _f16Rot(sgn * th));
    papers.forEach(p => p.style.transform = _f16Rot(sgn * (th + 180)));
  };
  const tuck = t => {                    // t = 0 (flat) … 1 (tucked under)
    sides.forEach(s => { s.el.style.transform = s.tuck.t(180 * t); });
  };

  const finish = () => {
    movers.forEach(m => m.remove());
    papers.forEach(p => p.remove());
    _fold16[b.id] = folding;
    _fold16Render(container);
    _fold16Busy = false;
    if (folding && typeof _gridToast === 'function') _gridToast(b.diag + ' back', 1100);
  };

  if (folding) {
    sweep(0); tuck(0);
    _f16Animate(_F16_MS, sweep, () => {
      _f16Animate(_F16_TUCK_MS, tuck, finish);
    });
  } else {
    sweep(1); tuck(1);
    _f16Animate(_F16_TUCK_MS, t => tuck(1 - t), () => {
      _f16Animate(_F16_MS, t => sweep(1 - t), finish);
    });
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
    '.fold16-paper, .fold16-mover { pointer-events:none; }',
    '.fold16-paper {',
    '  position:relative;',
    '  background:linear-gradient(140deg,#f2c25c 0%,#e0a63c 52%,#c8892a 100%);',
    '  box-shadow:inset 0 0 0 1px rgba(90,55,0,0.35);',
    '  backface-visibility:hidden; -webkit-backface-visibility:hidden;',
    '}'
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
window._fold16ApplyTemplate = _fold16ApplyTemplate;
