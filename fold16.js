// ══════════════════════════════════════════════════════════════════════════════
// 16F — THE FOLD GRID  (dev0820)
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
// 3c. Each block has a CIRCLE at its centre — the interior corner where its four
// cells meet. Double-click a circle and the block folds: its four squares
// collapse onto ONE, three squares vanish, and the face left showing is the BACK
// of the cell diagonally opposite the landing cell.
//
//   circle A (25%,25%)  1a 1b 2a 2b  →  lands on 2b, shows 1a's back  (key 1aB)
//   circle B (50%,50%)  2b 2c 3b 3c  →  lands on 2b, shows 3c's back  (key 3cB)
//   circle C (75%,75%)  3c 3d 4c 4d  →  lands on 3c, shows 4d's back  (key 4dB)
//
// The cascade is 10 → 7 → 4 → 1: fold A and C and you are left with a clean 2×2
// (1a-back, 2c, 3b, 4d-back) with circle B still dead centre, which is what makes
// the last fold possible. B is therefore the OUTER fold — while it is down, A and
// C are inside its stack and their circles are hidden.
//
// Why the diagonal cell's back? Because it folds LAST. Each of the three moving
// squares rotates 180° about the crease it shares with the landing square — the
// two edge-neighbours about their shared edge, the diagonal one about the block's
// 45° crease — so all three land face-DOWN on the landing cell, and the diagonal
// one, released last, ends up on top. Same rule for all three blocks.
//
// Everything here is additive: the three back faces are ordinary grid cells with
// their own c.json keys (1aB / 3cB / 4dB), built by gridShow's normal cell path,
// so they inherit tap-to-play, swipe→view, zoom, COI, cut/paste and the rest for
// free. They are simply hidden until their block folds.
// ══════════════════════════════════════════════════════════════════════════════

const FOLD16_LAYOUT = '16F';

// The ten cells that exist, with their 4×4 placement.
const FOLD16_CELLS = [
  { cs: '1a', r: 1, c: 1 }, { cs: '1b', r: 1, c: 2 },
  { cs: '2a', r: 2, c: 1 }, { cs: '2b', r: 2, c: 2 }, { cs: '2c', r: 2, c: 3 },
  { cs: '3b', r: 3, c: 2 }, { cs: '3c', r: 3, c: 3 }, { cs: '3d', r: 3, c: 4 },
  { cs: '4c', r: 4, c: 3 }, { cs: '4d', r: 4, c: 4 }
];

// ── Fold moves ───────────────────────────────────────────────────────────────
// Each is a crease: where the transform pivots, and the rotation that carries the
// square 180° over that crease onto its neighbour. `t(deg)` is parameterised so
// the same crease drives both halves of the flip — the real cell runs 0°→180°
// (and vanishes at 90° via backface-visibility), while a paper-coloured stand-in
// runs 180°→360° and so appears exactly as the cell disappears. That pair is what
// reads as a sheet of paper turning over rather than a picture blinking out.
const _F16_MV = {
  // fold DOWN onto the cell below (pivot = own bottom edge)
  down:   { o: '50% 100%',  t: d => 'rotateX(' + d + 'deg)' },
  // fold UP onto the cell above (pivot = own top edge)
  up:     { o: '50% 0%',    t: d => 'rotateX(' + (-d) + 'deg)' },
  // fold RIGHT onto the cell to the right (pivot = own right edge)
  right:  { o: '100% 50%',  t: d => 'rotateY(' + (-d) + 'deg)' },
  // fold LEFT onto the cell to the left (pivot = own left edge)
  left:   { o: '0% 50%',    t: d => 'rotateY(' + d + 'deg)' },
  // fold DIAGONALLY down-right (pivot = own bottom-right corner, 45° axis).
  // Reflects the square across the block's anti-diagonal onto the cell below-right.
  diagBR: { o: '100% 100%', t: d => 'rotate3d(1,-1,0,' + d + 'deg)' },
  // fold DIAGONALLY up-left (pivot = own top-left corner, same 45° axis)
  diagTL: { o: '0% 0%',     t: d => 'rotate3d(1,-1,0,' + d + 'deg)' }
};

// The three blocks. `land` is the square everything collapses onto, `back` is the
// c.json key whose picture is revealed there, `x`/`y` place the circle as a % of
// the container (the interior corners of a 4×4 sit at 25/50/75%). `moves` maps
// each departing cell to its crease; the DIAGONAL one is listed last and is
// delayed so it settles on top.
const FOLD16_BLOCKS = [
  {
    id: 'A', cells: ['1a', '1b', '2a', '2b'], land: '2b', diag: '1a', back: '1aB',
    x: 25, y: 25, label: 'Fold 1a·1b·2a·2b onto 2b',
    moves: [['1b', 'down'], ['2a', 'right'], ['1a', 'diagBR']]
  },
  {
    id: 'B', cells: ['2b', '2c', '3b', '3c'], land: '2b', diag: '3c', back: '3cB',
    x: 50, y: 50, label: 'Fold the centre four onto 2b',
    moves: [['2c', 'left'], ['3b', 'up'], ['3c', 'diagTL']]
  },
  {
    id: 'C', cells: ['3c', '3d', '4c', '4d'], land: '3c', diag: '4d', back: '4dB',
    x: 75, y: 75, label: 'Fold 3c·3d·4c·4d onto 3c',
    moves: [['3d', 'left'], ['4c', 'up'], ['4d', 'diagTL']]
  }
];

const FOLD16_BACK_KEYS = FOLD16_BLOCKS.map(b => b.back);

// Live fold state — session-lived, always starts flat. Reset whenever the grid
// renders something that is not a 16F (see gridShow), so a stale fold can never
// haunt the next grid.
var _fold16 = { A: false, B: false, C: false };

const _F16_MS = 360;      // one crease's travel time
const _F16_DIAG_DELAY = 190;  // the diagonal square is released this much later
var _fold16Busy = false;  // one fold at a time; ignore clicks mid-animation

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
  container.style.position = 'relative';
  container.style.perspective = '1600px';
  _f16InjectCSS();
  container.querySelectorAll('.fold16-circle, .fold16-paper').forEach(el => el.remove());

  const vis = _fold16Visible();
  for (const spec of _fold16CellList()) {
    const el = _f16Cell(container, spec.cs);
    if (!el) continue;
    el.style.transform = '';
    el.style.transition = '';
    if (spec.foldBack) {
      // Back faces carry a marker so the shared double-tap handler in grid.js
      // can route a double-click here to "unfold" instead of the text editor.
      el.dataset.fold16Back = spec.foldBack;
      _f16SetShown(el, vis.shown.has(spec.cs), spec.cs);
    } else {
      _f16SetShown(el, !vis.hidden.has(spec.cs), spec.cs);
    }
  }

  for (const b of FOLD16_BLOCKS) {
    const folded = !!_fold16[b.id];
    if (!_fold16Enabled(b.id)) continue;      // hidden while B is down
    const dot = document.createElement('div');
    dot.className = 'fold16-circle' + (folded ? ' f16-folded' : '');
    dot.style.left = b.x + '%';
    dot.style.top = b.y + '%';
    dot.title = (folded ? 'Double-click to unfold' : b.label) + ' (double-click)';
    dot.addEventListener('dblclick', e => {
      e.preventDefault(); e.stopPropagation();
      _fold16Toggle(b.id);
    }, true);
    // Swallow the press so the grid's hold-to-cut / swipe gestures never see it.
    ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'contextmenu']
      .forEach(t => dot.addEventListener(t, e => e.stopPropagation(), true));
    container.appendChild(dot);
  }
}

// Show or hide a cell. Hiding pauses any player inside it — a folded square is
// out of sight, and a video that keeps talking from under the fold is a bug.
function _f16SetShown(el, on, cs) {
  el.style.display = on ? '' : 'none';
  el.style.opacity = '';
  if (!on && typeof gridTogglePauseCell === 'function') {
    try { gridTogglePauseCell(cs); } catch (_) {}
  }
}

// ── The fold ─────────────────────────────────────────────────────────────────
function _fold16Toggle(id) {
  if (_fold16Busy) return;
  if (!_fold16Enabled(id)) return;
  const container = document.getElementById('gridContainer');
  if (!container) return;
  const b = _fold16Block(id);
  if (!b) return;
  if (_fold16[id]) _fold16Unfold(container, b);
  else _fold16Fold(container, b);
}

function _fold16Fold(container, b) {
  _fold16Busy = true;
  // The landing square keeps its own face until the fold lands on it, so make
  // sure it is visible even if an inner block already folded onto it.
  const papers = [];
  b.moves.forEach(([cs, mvName], i) => {
    const el = _f16Cell(container, cs);
    if (!el) return;
    const mv = _F16_MV[mvName];
    const delay = (i === b.moves.length - 1) ? _F16_DIAG_DELAY : 0;
    const top = (i === b.moves.length - 1);
    // The real cell: flat → 180°, disappearing as it passes edge-on.
    el.style.zIndex = top ? '73' : '71';
    el.style.backfaceVisibility = 'hidden';
    el.style.webkitBackfaceVisibility = 'hidden';
    el.style.transformOrigin = mv.o;
    el.style.transition = 'transform ' + _F16_MS + 'ms cubic-bezier(.45,.05,.3,1) ' + delay + 'ms';
    // The paper stand-in: 180° → 360°, so it takes over at the halfway point and
    // ends face-up on the landing square.
    const paper = _f16MakePaper(el, mv, top);
    papers.push(paper);
    container.appendChild(paper);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.style.transform = mv.t(180);
      paper.style.transition = 'transform ' + _F16_MS + 'ms cubic-bezier(.45,.05,.3,1) ' + delay + 'ms';
      paper.style.transform = mv.t(360);
    }));
  });

  setTimeout(() => {
    _fold16[b.id] = true;
    papers.forEach(p => p.remove());
    _fold16Render(container);
    _fold16Busy = false;
    if (typeof _gridToast === 'function') _gridToast(b.diag + ' back', 1100);
  }, _F16_MS + _F16_DIAG_DELAY + 40);
}

function _fold16Unfold(container, b) {
  _fold16Busy = true;
  // Drop the state first and re-render so the four cells are back in the DOM,
  // then start them from their folded pose and let them swing open.
  _fold16[b.id] = false;
  _fold16Render(container);
  const papers = [];
  b.moves.forEach(([cs, mvName], i) => {
    const el = _f16Cell(container, cs);
    if (!el) return;
    const mv = _F16_MV[mvName];
    // Unfolding reverses the order: the square that landed on top lifts first.
    const delay = (i === b.moves.length - 1) ? 0 : _F16_DIAG_DELAY;
    const top = (i === b.moves.length - 1);
    el.style.zIndex = top ? '73' : '71';
    el.style.backfaceVisibility = 'hidden';
    el.style.webkitBackfaceVisibility = 'hidden';
    el.style.transformOrigin = mv.o;
    el.style.transition = 'none';
    el.style.transform = mv.t(180);
    const paper = _f16MakePaper(el, mv, top);
    paper.style.transform = mv.t(360);
    papers.push(paper);
    container.appendChild(paper);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.style.transition = 'transform ' + _F16_MS + 'ms cubic-bezier(.45,.05,.3,1) ' + delay + 'ms';
      el.style.transform = '';
      paper.style.transition = 'transform ' + _F16_MS + 'ms cubic-bezier(.45,.05,.3,1) ' + delay + 'ms';
      paper.style.transform = mv.t(180);
    }));
  });
  setTimeout(() => {
    papers.forEach(p => p.remove());
    _fold16Render(container);
    _fold16Busy = false;
  }, _F16_MS + _F16_DIAG_DELAY + 40);
}

// A blank manila panel occupying the same grid area as `el`, standing in for the
// reverse of that square while it turns.
function _f16MakePaper(el, mv, top) {
  const p = document.createElement('div');
  p.className = 'fold16-paper';
  p.style.gridRow = el.style.gridRow;
  p.style.gridColumn = el.style.gridColumn;
  p.style.zIndex = top ? '72' : '70';
  p.style.transformOrigin = mv.o;
  p.style.transform = mv.t(180);
  return p;
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
    '  position:absolute; width:34px; height:34px; margin:-17px 0 0 -17px;',
    '  border-radius:50%; border:2px solid rgba(255,238,200,0.9);',
    '  background:radial-gradient(circle at 38% 34%, rgba(255,255,255,0.34), rgba(0,0,0,0.5));',
    '  box-shadow:0 0 0 2px rgba(0,0,0,0.45), 0 2px 7px rgba(0,0,0,0.6);',
    '  cursor:pointer; z-index:90; transition:transform .14s ease, border-color .14s ease;',
    '}',
    '.fold16-circle:hover { transform:scale(1.16); border-color:#fff; }',
    '.fold16-circle.f16-folded { border-color:rgba(255,190,90,0.95);',
    '  background:radial-gradient(circle at 38% 34%, rgba(255,214,140,0.5), rgba(60,30,0,0.6)); }',
    '.fold16-paper {',
    '  position:relative; border-radius:2px; pointer-events:none;',
    '  background:linear-gradient(140deg,#f2c25c 0%,#e0a63c 52%,#c8892a 100%);',
    '  box-shadow:inset 0 0 0 1px rgba(90,55,0,0.35), 0 3px 12px rgba(0,0,0,0.5);',
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
