
// ══════════════════════════════════════════════════════════════════════════════
// GRID VIEW
// ══════════════════════════════════════════════════════════════════════════════

const GRID_ROWS = 5, GRID_COLS = 5;
const GRID_LETTERS = 'abcde';

// ── (zip0153) Variable grid size ─────────────────────────────────────────────
// _gridGsize is the live edge length (2-5). The grid still uses the same cell
// labelling — 1a, 1b, 2a, 2b for a 2x2; 1a..5e for a 5x5 — just constrained to
// the top-left _gridGsize × _gridGsize square. Cells outside that square are
// not iterated/rendered, but their data in ml.json (row.cell='4d' etc.) stays
// intact and reappears when the user grows the grid back. Persisted in
// ml.json's _salMeta._salGsize so reload restores the last-used size.
var _gridGsize = 5;

function _gridApplyContainerCSS() {
  const c = document.getElementById('gridContainer');
  if (!c) return;
  c.style.gridTemplateRows    = 'repeat(' + _gridGsize + ',1fr)';
  c.style.gridTemplateColumns = 'repeat(' + _gridGsize + ',1fr)';
}

// Set the active grid size (clamped 2-5), persist to ml.json meta, redraw.
// Called from the number-key handler (2/3/4/5) and during C-config activation.
function _setGridGsize(n, opts) {
  n = parseInt(n, 10);
  if (!(n >= 2 && n <= 5)) return;
  if (n === _gridGsize && !(opts && opts.force)) {
    _gridApplyContainerCSS();
    return;
  }
  _gridGsize = n;
  _gridApplyContainerCSS();
  // Persist to meta + save (skip when caller will save shortly anyway)
  if (!opts || !opts.skipSave) {
    if (!metaRow) metaRow = { _salMeta: true };
    metaRow._salGsize = n;
    if (typeof save === 'function') save();
  }
  // Re-render the grid contents at the new size
  if (document.getElementById('gridOverlay')?.style.display === 'flex'
      && typeof gridShow === 'function') {
    gridShow();
  }
  _gridToast('Grid: ' + n + '×' + n + ' (' + (n*n) + ' cells)', 1200);
}

function parseGridCell(s) {
  if (!s || s.length < 2) return null;
  const r = parseInt(s[0]), c = GRID_LETTERS.indexOf(s[1].toLowerCase()) + 1;
  if (isNaN(r) || r < 1 || r > GRID_ROWS || c < 1 || c > GRID_COLS) return null;
  return { row: r, col: c };
}
function mkGridCell(r, c) { return r + GRID_LETTERS[c - 1]; }

// ── (dev0370) Special non-square layouts 17 & 19 ────────────────────────────
// Both sit on a 5×5 footprint (gsize 5) and keep the 16-cell outer ring. They
// only change the central 3×3 (rows 2-4 × cols b-d): layout 17 merges it into
// one big landscape cell "1L"; layout 19 splits it into three portrait cells
// "1P"/"2P"/"3P". The layout is chosen by the active config's `cells` value (17
// or 19) and is reachable ONLY from C — the 2-5 size keys are inert while one
// is active (see core.js). Each special cell obeys every normal cell rule
// (tap-to-play, swipe→view, zoom, COI, cut) because gridShow builds it with the
// same code path; only its grid-area — and therefore its size — differs.
function _gridCurrentLayout() {
  if (_gridSource === 'C' && _gridActiveConfig) {
    const cn = parseInt(_gridActiveConfig.cells, 10);
    if (cn === 17) return '17';
    if (cn === 19) return '19';
  }
  return 'square';
}

// True for any c.json key that addresses a grid cell — the standard 1a..5e plus
// the special 1L / 1P / 2P / 3P. The per-cell zoom scanners use this so zooms
// stored on the big/portrait cells ("UID/zoom") restore like every other cell.
function _isGridConfigCellKey(k) {
  return /^[1-9][a-e]$/.test(k) || k === '1L' || /^[123]P$/.test(k);
}

// Ordered list of the cells a layout renders, each with its CSS grid placement
// ({ cs, r, c, rs:rowSpan, cls:colSpan }). Square layouts enumerate the
// gsize×gsize block (auto-flowed, no explicit area). The special layouts drop
// the central nine cells and add the merged center, in a natural reading order
// (top row, then row 2's edges around the center, then the side cells, then the
// bottom row). Shared by gridShow, the occupancy count and the slideshow walk
// so all three agree on which cells exist and in what order.
function _gridCellList(gsize, layout) {
  const out = [];
  if (layout === '17' || layout === '19') {
    for (let c = 1; c <= 5; c++) out.push({ cs: mkGridCell(1, c), r: 1, c: c, rs: 1, cls: 1 });
    out.push({ cs: '2a', r: 2, c: 1, rs: 1, cls: 1 });
    if (layout === '17') {
      out.push({ cs: '1L', r: 2, c: 2, rs: 3, cls: 3 });
    } else {
      out.push({ cs: '1P', r: 2, c: 2, rs: 3, cls: 1 });
      out.push({ cs: '2P', r: 2, c: 3, rs: 3, cls: 1 });
      out.push({ cs: '3P', r: 2, c: 4, rs: 3, cls: 1 });
    }
    out.push({ cs: '2e', r: 2, c: 5, rs: 1, cls: 1 });
    out.push({ cs: '3a', r: 3, c: 1, rs: 1, cls: 1 });
    out.push({ cs: '3e', r: 3, c: 5, rs: 1, cls: 1 });
    out.push({ cs: '4a', r: 4, c: 1, rs: 1, cls: 1 });
    out.push({ cs: '4e', r: 4, c: 5, rs: 1, cls: 1 });
    for (let c = 1; c <= 5; c++) out.push({ cs: mkGridCell(5, c), r: 5, c: c, rs: 1, cls: 1 });
    return out;
  }
  for (let r = 1; r <= gsize; r++)
    for (let c = 1; c <= gsize; c++)
      out.push({ cs: mkGridCell(r, c), r: r, c: c, rs: 1, cls: 1 });
  return out;
}

// Get data row by cell string
function getRowByCell(cellStr) {
  return data.find(r => r.cell === cellStr && (r.show === undefined || r.show === '1'));
}

// Check if row is a video
// (zip0162) Moved to core.js so it's available before grid.js loads.

var _gridPlayers = {}; // Track mounted players for cleanup
var _gridCutCell = null; // Cell currently "cut" for paste
var _cameFromGrid = false; // Track if we came from grid (for return navigation)
var _lastGridRow = null; // Last selected/edited row (for E key)
var _gridName = ''; // Current grid name (for c.json export)
var _gridSource = 'T'; // 'T' = from Table cell assignments | 'C' = from active c.json config
var _gridActiveConfig = null; // The currently active c.json config object (when _gridSource='C')
// (dev0346) Per-cell individual zoom factors, keyed by row UID (1 = none, so
// only stored when ≠1). Multiplies the global grid zoom for that one cell.
// Adjusted live with Ctrl+wheel; persisted to c.json as the cell value
// "UID/zoom" (a bare "UID" = full size). Session-lived; cleared + repopulated
// from the active config on C-activation (see _gridApplyConfigZoom).
var _gridCellZoom = {};

// (dev0364) Transient per-cell PAN offset (UID → {x,y} px), applied on top of the
// zoom/COI transform. Set by the Shift+drag gesture; session-only (NOT persisted —
// reload loses it). To keep a framing, Alt-click it as a COI. Cleared on the
// second-Z full zoom reset alongside _gridCellZoom.
var _gridCellPan = {};

function gridCleanupPlayers() {
  Object.keys(_gridPlayers).forEach(id => {
    if (window.stopCellVideoLoop) window.stopCellVideoLoop(id);
  });
  _gridPlayers = {};
}

// (zip0144) Scale an HTML/text cell preview so the entire ftext is
// visible inside the cell, not just the top-left corner. Renders the
// inner content at a fixed virtual width (600px) so font sizes /
// margins / images keep their relative proportions, then JS-scales
// down to whatever the cell's actual pixel dimensions are after
// layout. We measure the content's natural height (which depends on
// the row's HTML — could be one line or many) and pick the smaller of
// width-fit / height-fit to guarantee everything fits.
//
// Re-fit on window resize via ResizeObserver — the grid is fluid
// (5 cols × 5 rows of viewport) so cell width changes whenever the
// device rotates or the window is resized.
// Fit a scaled, chrome-clipped IG iframe into a grid cell. IG's embed layout
// at 326-wide has a ~54px header strip and ~80px footer strip; we render the
// iframe at a fixed natural size (326×620), scale it so its width matches
// the cell, and offset top so the header is clipped above the visible area.
function fitGridIgFrame(cellEl, iframe) {
  const NAT_W = 326, HEADER = 54;
  function fit() {
    if (!cellEl.isConnected) return;
    const cw = cellEl.clientWidth;
    if (!cw) return;
    const scale = cw / NAT_W;
    iframe.style.transform = 'scale(' + scale + ')';
    iframe.style.left = '0px';
    iframe.style.top = (-HEADER * scale) + 'px';
  }
  requestAnimationFrame(fit);
  setTimeout(fit, 50);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(fit).observe(cellEl);
  }
}

function fitGridHtmlThumb(cellEl, wrapEl, innerEl) {
  const VIRT_W = 600;
  function fit() {
    if (!cellEl.isConnected) return;
    const cw = cellEl.clientWidth;
    const ch = cellEl.clientHeight;
    if (!cw || !ch) return;
    // Reset transform so scrollHeight reflects the natural unscaled
    // height. Without this reset, repeated calls compound their
    // measurements and the fit ratio gets progressively wrong.
    innerEl.style.transform = '';
    innerEl.style.width = VIRT_W + 'px';
    const naturalH = Math.max(1, innerEl.scrollHeight);
    const scale = Math.min(cw / VIRT_W, ch / naturalH);
    innerEl.style.transform = 'scale(' + scale + ')';
    // Center horizontally and vertically inside the cell when the
    // scaled content is smaller than the cell on either axis.
    const offX = Math.max(0, (cw - VIRT_W * scale) / 2);
    const offY = Math.max(0, (ch - naturalH * scale) / 2);
    innerEl.style.left = offX + 'px';
    innerEl.style.top  = offY + 'px';
  }
  // First fit happens on the next animation frame (the grid is mid-
  // build at this point and cells haven't been measured yet). A second
  // pass at 0ms catches images that load asynchronously and resize
  // the natural height after the initial measurement.
  requestAnimationFrame(fit);
  setTimeout(fit, 50);
  // Watch the cell — re-fit on window resize / device rotation.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(fit);
    ro.observe(cellEl);
  }
}

// Update visual state of T / C source buttons
function gridUpdateSourceBtns() {
  const tBtn = document.getElementById('gridSrcT');
  const cBtn = document.getElementById('gridSrcC');
  if (!tBtn || !cBtn) return;
  const activeStyle  = 'opacity:1;transform:scale(1.08);box-shadow:0 0 10px rgba(255,255,255,0.25);font-size:13px;padding:8px 18px;font-weight:bold;';
  const inactiveStyle = 'opacity:0.55;transform:scale(1);box-shadow:none;font-size:11px;padding:7px 14px;font-weight:normal;';
  if (_gridSource === 'T') {
    tBtn.style.cssText = tBtn.style.cssText.replace(/opacity:[^;]+;|transform:[^;]+;|box-shadow:[^;]+;|font-size:[^;]+;|padding:[^;]+;|font-weight:[^;]+;/g, '');
    Object.assign(tBtn.style, {opacity:'1', transform:'scale(1.08)', boxShadow:'0 0 10px rgba(100,255,180,0.3)', fontSize:'13px', padding:'8px 18px', fontWeight:'bold', borderColor:'#8fe', color:'#8fe'});
    Object.assign(cBtn.style, {opacity:'0.5', transform:'scale(1)', boxShadow:'none', fontSize:'11px', padding:'7px 14px', fontWeight:'normal', borderColor:'#8ef', color:'#8ef'});
  } else {
    Object.assign(cBtn.style, {opacity:'1', transform:'scale(1.08)', boxShadow:'0 0 10px rgba(100,180,255,0.3)', fontSize:'13px', padding:'8px 18px', fontWeight:'bold', borderColor:'#adf', color:'#adf'});
    Object.assign(tBtn.style, {opacity:'0.5', transform:'scale(1)', boxShadow:'none', fontSize:'11px', padding:'7px 14px', fontWeight:'normal', borderColor:'#5fa', color:'#5fa'});
  }
  // Show grid name label only in T mode; show config name in C mode
  const nameLabel = document.getElementById('gridNameLabel');
  if (nameLabel) {
    if (_gridSource === 'C' && _gridActiveConfig) {
      nameLabel.textContent = _gridActiveConfig.gname || 'unnamed collection';
      nameLabel.style.color = '#8ef';
    } else {
      nameLabel.textContent = _gridName || 'unnamed';
      nameLabel.style.color = _gridName ? '#ff8' : '#666';
    }
  }
}

// Resolve a grid cell to a data row — respects current source mode
function getRowByCellForGrid(cellStr) {
  if (_gridSource === 'T') {
    return data.find(r => r.cell === cellStr && (r.show === undefined || r.show === '1'));
  } else {
    // C mode: look up UID from active config, then find row. (dev0346) The cell
    // value may carry a per-cell zoom suffix ("UID/zoom") — parse out the UID.
    if (!_gridActiveConfig) return null;
    const pv = _gridParseCellVal(_gridActiveConfig[cellStr]);
    if (!pv.uid) return null;
    return data.find(r => String(r.UID) === pv.uid) || null;
  }
}

// Pause a specific cell's video without destroying the player
function gridTogglePauseCell(cellStr) {
  const vidId = 'grid-vid-' + cellStr;
  const player = window.seeLearnVideoPlayers && window.seeLearnVideoPlayers[vidId];
  if (!player) return;
  
  // Check if currently paused (YouTube has getPlayerState, Vimeo has getPaused)
  let isPaused = false;
  
  if (typeof player.getPlayerState === 'function') {
    // YouTube: 1=playing, 2=paused
    try { isPaused = player.getPlayerState() !== 1; } catch(e) {}
  } else if (typeof player.getPaused === 'function') {
    // Vimeo: returns promise
    try { isPaused = player._salPaused || false; } catch(e) {}
  }
  
  // Check our own tracking flag
  if (player._gridPaused !== undefined) {
    isPaused = player._gridPaused;
  }
  
  if (isPaused) {
    // Resume playing
    player._gridPaused = false;
    try {
      if (typeof player.playVideo === 'function') player.playVideo();
      else if (typeof player.play === 'function') player.play();
    } catch(e) {}
    toast('▶ Playing ' + cellStr, 800);
  } else {
    // Pause
    player._gridPaused = true;
    // Stop the loop timer
    if (window.seeLearnVideoTimers && window.seeLearnVideoTimers[vidId]) {
      clearInterval(window.seeLearnVideoTimers[vidId]);
      delete window.seeLearnVideoTimers[vidId];
    }
    try {
      if (typeof player.pauseVideo === 'function') player.pauseVideo();
      else if (typeof player.pause === 'function') player.pause();
    } catch(e) {}
    toast('⏸ Paused ' + cellStr, 800);
  }
}

// (dev0335) Space in G pauses/unpauses ALL grid videos at once. The action is
// derived from live state (if any cell is playing → pause all; else play all) so
// it stays correct across re-renders without a tracking flag. Uses the same
// _salPaused / _gridPaused flags the per-cell toggle and the loop intervals
// already honor, so segment looping resumes cleanly on unpause (no timers torn
// down). Note: YouTube paints a center play arrow on each paused cell — that's
// YT's own paused-state chrome and can't be removed cross-origin.
function gridToggleAllPause() {
  const players = window.seeLearnVideoPlayers || {};
  const ids = Object.keys(players).filter(k => k.indexOf('grid-vid-') === 0);
  if (!ids.length) { if (typeof toast === 'function') toast('No videos in grid', 800); return; }
  const pauseAll = ids.some(id => players[id] && players[id]._gridPaused !== true);
  ids.forEach(id => {
    const p = players[id];
    if (!p) return;
    p._gridPaused = pauseAll;
    p._salPaused  = pauseAll;
    try {
      if (pauseAll) { if (typeof p.pauseVideo === 'function') p.pauseVideo(); else if (typeof p.pause === 'function') p.pause(); }
      else          { if (typeof p.playVideo  === 'function') p.playVideo();  else if (typeof p.play  === 'function') p.play();  }
    } catch (e) {}
  });
  if (typeof toast === 'function') toast(pauseAll ? '⏸ Paused all' : '▶ Playing all', 900);
}

function gridClearCut() {
  _gridCutCell = null;
  document.querySelectorAll('.grid-cell.cut').forEach(el => el.classList.remove('cut'));
  const cutInfo = document.getElementById('gridCutInfo');
  if (cutInfo) cutInfo.style.display = 'none';
}

// ── Clean-playback buffering (dev0336) ───────────────────────────────────────
// G can play YouTube cells through a desktop-only A/B double-buffer that hides
// YT's seek/re-buffer flash at the segment loop point (see
// mountYouTubeClipBuffered in video.js). Mode is persisted in ml-settings and
// cycled with Ctrl+B: 'off' → 'cut' (instant swap) → 'fade' (crossfade).
function _gridBufferMode() {
  const m = (typeof window.getSetting === 'function') ? window.getSetting('gridBuffer') : null;
  return (m === 'cut' || m === 'fade') ? m : 'off';
}

// Seconds of hidden warm-up before a buffered layer is revealed — long enough to
// outlast YouTube's startup/title/spinner chrome. User-tunable with −/+ in G
// (persisted), since the right value depends on connection speed and how far the
// segment seeks jump. Default 3.5; clamped 1–8.
const _GRID_PREROLL_DEFAULT = 3.5;
function _gridBufferPreroll() {
  let v = (typeof window.getSetting === 'function') ? Number(window.getSetting('gridBufferPreroll')) : NaN;
  if (!isFinite(v) || v <= 0) v = _GRID_PREROLL_DEFAULT;
  return Math.max(1, Math.min(8, v));
}

// Buffering is heavy (2 iframes/cell) — only engage on desktop and small grids.
// Larger/mobile grids transparently fall back to the single-iframe mount.
function _gridBufferEligible() {
  const desktop = (typeof _isMobileDevice === 'function') ? !_isMobileDevice() : true;
  return desktop && _gridGsize <= 4;
}

// ── Cover-fit + zoom (dev0338 / dev0346) ─────────────────────────────────────
// A YouTube/Vimeo iframe shows the video letterboxed to the clip's native aspect;
// when that differs from the cell, the cell gets black bars (and fill looks
// inconsistent across a grid of mixed-aspect clips). We make the player COVER
// the cell like an image (object-fit:cover): size the iframe assuming the
// standard 16:9 so the video edges reach the cell, then let the cell's
// overflow:hidden clip the excess. <video> elements cover natively.
//
// (dev0346) Zoom. On top of that 16:9-cover baseline we ride a CSS
// transform:scale — the same factor scales <img> and <video> too — so the whole
// grid (or a single cell) zooms with the mouse wheel. transform is cheap (no
// giant iframes) and uniform across content types. The effective factor is
// global × per-cell: _gridFillZoom() is the whole-grid zoom (wheel / `[` `]`),
// _gridCellZoom[UID] the optional per-cell multiplier (Ctrl+wheel). 1.0 = plain
// cover (video) / contain (image); floor 0.2; no upper limit. IG / quiz / text
// cells have no zoom target and are never scaled. Players mount async, so we
// watch for them + re-fit.
const _GRID_FILLZOOM_DEFAULT = 1.0;   // 1.0 = plain 16:9 cover / image-contain
const _GRID_ZOOM_MIN  = 0.2;          // bottom level (user spec)
const _GRID_ZOOM_STEP = 0.1;          // (dev0350) per [ ] press — was 0.2
function _gridFillZoom() {
  let v = (typeof window.getSetting === 'function') ? Number(window.getSetting('gridFillZoom')) : NaN;
  if (!isFinite(v) || v <= 0) v = _GRID_FILLZOOM_DEFAULT;
  return Math.max(_GRID_ZOOM_MIN, v);   // floor only — no upper limit
}

// Snap a zoom value to the 0.1 grid (and the floor). 0.1 multiples land on
// clean one-decimal numbers so they JSON-stringify tidily into c.json.
function _gridSnapZoom(v) {
  return Math.max(_GRID_ZOOM_MIN, Math.round(Number(v) * 10) / 10);
}

// Effective zoom for one cell = global × that cell's stored per-cell factor.
function _gridZoomForCell(cellEl) {
  // (dev0359) No zoom on phones/tablets — zoomed cells look bad on small
  // screens, so the grid always renders at plain cover/contain there. The
  // stored global "Zoom" + per-cell "UID/zoom" values are kept in c.json
  // (and still apply on desktop); they're just ignored for mobile rendering.
  if (typeof _isMobileDevice === 'function' && _isMobileDevice()) return 1;
  const g = _gridFillZoom();
  const row = cellEl && cellEl._rowData;
  const indiv = (row && row.UID && _gridCellZoom[row.UID] > 0) ? _gridCellZoom[row.UID] : 1;
  return g * indiv;
}

// ── Center-of-interest (COI) anchoring (dev0348 → dev0363) ───────────────────
// A COI is the point the user Alt-clicked on a cell. As of dev0363 it lives in
// the row's "COI" *column* (the dev0349 "parentUID@fx,fy" clone-row scheme was
// dropped — one COI per row now). The column holds three @@-separated fields:
//     "fx,fy@@zoom@@frameRef"
//   e.g. "0.425,0.146@@1.8@@frame120"  or  "0.685,0.335@@1.0@@image"
// where fx,fy are cell fractions 0..1, zoom is the effective cell zoom captured
// when the COI was set, and frameRef is "frame<N>" (video, N≈currentTime×30 fps)
// or the literal "image". Only fx,fy drives rendering today; zoom + frameRef are
// recorded for the coming time-based autozoom. Zoom scales the cell toward the
// point instead of its center, so an off-center subject stays in view as the
// cell enlarges. The centering pan is CLAMPED so the scaled content never
// exposes a gap — which is why a near-edge COI only drifts toward center as zoom
// grows (at 1× there's no room to pan; at high zoom there's enough overflow).
function _gridParseCOI(s) {
  if (!s) return null;
  // Accept the full COI column string (use its first @@-field) or a bare "fx,fy".
  const p = String(s).split('@@')[0].split(',');
  if (p.length < 2) return null;
  const fx = parseFloat(p[0]), fy = parseFloat(p[1]);
  if (!isFinite(fx) || !isFinite(fy)) return null;
  return { fx: Math.max(0, Math.min(1, fx)), fy: Math.max(0, Math.min(1, fy)) };
}
// Pull a COI off a row's COI column; rows with an empty/absent COI have none.
function _gridRowCOI(row) {
  if (!row || !row.COI) return null;
  return _gridParseCOI(row.COI);
}
function _gridCOIForCell(cellEl) {
  return cellEl ? _gridRowCOI(cellEl._rowData) : null;
}
// (dev0364) Transient drag-pan offset for a cell, or null when none/zero.
function _gridCellPanForCell(cellEl) {
  const row = cellEl && cellEl._rowData;
  if (!row || row.UID == null) return null;
  const p = _gridCellPan[row.UID];
  return (p && (p.x || p.y)) ? p : null;
}

// Translate FRACTION (of the element's own box) along one axis so the COI point
// `f` ends up centered, clamped to keep the scaled box covering the cell. Used
// for cell-sized elements (img / montage box / <video>) where translate-% is
// relative to the box = the cell, so no pixel measurement is needed.
function _gridAnchorFrac(f, Z) {
  const desired = 0.5 - Z * f;   // shift that puts f at cell center
  const lo = 1 - Z;              // Z>=1 → lo<=0: clamp range [lo, 0]
  if (lo <= 0) return Math.max(lo, Math.min(0, desired));
  return lo / 2;                 // Z<1 (content smaller than cell): just center
}

// Pixel translate for an element whose base box (baseLen at basePos, in cell
// coords) may differ from the cell (the oversized cover iframe). Same clamp.
function _gridAnchorPx(cellLen, basePos, baseLen, f, Z) {
  const desired = cellLen / 2 - basePos - Z * (f * cellLen - basePos);
  const tMin = cellLen - basePos - Z * baseLen;   // far edge reaches cellLen
  const tMax = -basePos;                            // near edge reaches 0
  if (tMin <= tMax) return Math.max(tMin, Math.min(tMax, desired));
  return (cellLen - Z * baseLen) / 2 - basePos;    // can't cover → center
}

// Build the `transform` string for a cell-sized element (img / box / video):
// translate the COI to center (clamped) then scale. transform-origin must be 0 0.
function _gridAnchoredTransform(coi, Z, pan) {
  const fx = coi ? coi.fx : 0.5, fy = coi ? coi.fy : 0.5;
  const tx = _gridAnchorFrac(fx, Z) * 100, ty = _gridAnchorFrac(fy, Z) * 100;
  // (dev0364) Optional transient pan in px, combined with the %-anchor via calc().
  const px = (pan && pan.x) ? pan.x : 0, py = (pan && pan.y) ? pan.y : 0;
  const xv = px ? 'calc(' + tx + '% + ' + px + 'px)' : tx + '%';
  const yv = py ? 'calc(' + ty + '% + ' + py + 'px)' : ty + '%';
  return 'translate(' + xv + ',' + yv + ') scale(' + Z + ')';
}

// Locate the zoomable element inside a cell, if any. A video host (YT/Vimeo/mp4),
// a direct <img>, or an ftext-image montage box is zoomable; IG / quiz / text
// cells return null, so they're skipped by both global and per-cell zoom.
function _gridCellZoomTarget(cellEl) {
  if (!cellEl) return null;
  const host = cellEl.querySelector('[id^="grid-vid-"]');
  if (host) return { kind: 'vid', el: host };
  const img = cellEl.querySelector('img.grid-zoom-img');
  if (img) return { kind: 'img', el: img };
  const box = cellEl.querySelector('.grid-zoom-box');   // montage of ftext images
  if (box) return { kind: 'box', el: box };
  return null;
}

// (dev0350) Is this row an "X" (html-teXt) row — ftext present, no picture/video
// link? Mirrors the grid's text-cell test. Used by the G ctrl-click router to
// open Xe (the text editor) for X cells, the way video cells open E.
function _gridIsTextRow(row) {
  if (!row) return false;
  if (typeof isVideoRow === 'function' && isVideoRow(row)) return false;
  if (/\.(jpe?g|png|gif|webp|svg|bmp|tiff?|avif)(\?|#|$)/i.test(row.link || '')) return false;
  return row.VidRange === 'text' || !!(row.ftext && String(row.ftext).trim());
}

// Apply the current effective zoom to a single cell's content (no remount).
// img / montage box are cell-sized, so a translate-% + scale (origin 0 0)
// anchors them to the COI without needing the cell's pixel size — works even
// before layout settles. The video host defers to _gridApplyCoverFit.
function _gridApplyZoomToCell(cellEl) {
  const t = _gridCellZoomTarget(cellEl);
  if (!t) return;
  const z = _gridZoomForCell(cellEl);
  if (t.kind === 'vid') { _gridApplyCoverFit(t.el, z); return; }
  const coi = _gridCOIForCell(cellEl);
  // (dev0349) A COI'd image must COVER the cell (like <video>) so its anchored
  // crop fills the cell with no letterbox — the shared anchor math assumes the
  // visible content fills the box. Plain images stay 'contain' (whole image).
  if (t.kind === 'img') t.el.style.objectFit = coi ? 'cover' : 'contain';
  t.el.style.transformOrigin = '0 0';
  t.el.style.transform = _gridAnchoredTransform(coi, z, _gridCellPanForCell(cellEl));
}

function _gridApplyCoverFit(host, zOverride) {
  if (!host) return;
  const w = host.clientWidth, h = host.clientHeight;
  if (!w || !h) return;
  host.style.overflow = 'hidden';
  const VID = 16 / 9;
  // zOverride lets a caller pass a precomputed factor; otherwise derive it from
  // the host's cell (global × per-cell). The async MutationObserver re-fit calls
  // with no override, so live zoom changes are picked up on the next mutation.
  const cellEl = host.closest('.grid-cell');
  const Z = (typeof zOverride === 'number') ? zOverride : _gridZoomForCell(cellEl);
  const coi = _gridCOIForCell(cellEl);
  const pan = _gridCellPanForCell(cellEl);   // (dev0364) transient drag-pan, may be null
  host.querySelectorAll('iframe, video').forEach(el => {
    if (el.tagName === 'VIDEO') {
      // <video> covers the cell natively (box = cell); zoom + COI ride on a
      // transform, same translate-% math as the image path.
      el.style.position = 'absolute'; el.style.inset = '0';
      el.style.left = ''; el.style.top = '';
      el.style.width = '100%'; el.style.height = '100%';
      el.style.objectFit = 'cover';
      el.style.transformOrigin = '0 0';
      el.style.transform = _gridAnchoredTransform(coi, Z, pan);
      return;
    }
    // iframe: size to cover the cell (16:9 assumption) and center, then zoom via
    // transform:scale. Sizing stays at the plain cover so scale=1 fills the cell
    // and scale<1 reveals letterbox (a true zoom-out). The cover box is larger
    // than the cell, so COI pan uses the pixel clamp (origin 0 0).
    let iw, ih;
    if (w / h > VID) { iw = w; ih = w / VID; } else { ih = h; iw = h * VID; }
    iw = Math.ceil(iw); ih = Math.ceil(ih);
    const ox = Math.round((w - iw) / 2), oy = Math.round((h - ih) / 2);
    el.style.position = 'absolute';
    el.style.maxWidth = 'none'; el.style.maxHeight = 'none';
    el.style.width = iw + 'px'; el.style.height = ih + 'px';
    el.style.left = ox + 'px';
    el.style.top  = oy + 'px';
    const fx = coi ? coi.fx : 0.5, fy = coi ? coi.fy : 0.5;
    let tx = _gridAnchorPx(w, ox, iw, fx, Z), ty = _gridAnchorPx(h, oy, ih, fy, Z);
    if (pan) { tx += pan.x; ty += pan.y; }   // (dev0364) add transient drag-pan
    el.style.transformOrigin = '0 0';
    el.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + Z + ')';
  });
}

// Wire a video host for cover-fit: the player iframe/video is inserted async
// (YT/Vimeo replace a placeholder), so watch the subtree, and re-fit on resize.
function _gridCoverFitHost(host) {
  if (!host || host._coverWired) return;
  host._coverWired = true;
  const refit = () => _gridApplyCoverFit(host);
  if (typeof MutationObserver !== 'undefined') {
    const mo = new MutationObserver(refit);
    mo.observe(host, { childList: true, subtree: true });
    setTimeout(() => { try { mo.disconnect(); } catch (_) {} }, 9000); // iframes settle by then
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(refit).observe(host);
  requestAnimationFrame(refit);
  setTimeout(refit, 400);
}

// Re-apply zoom to every live cell (after a global-zoom change — no remount).
function _gridRefitAll() {
  document.querySelectorAll('#gridContainer .grid-cell').forEach(_gridApplyZoomToCell);
}

// Parse a c.json cell value into { uid, zoom }. Stored as "UID/zoom" (e.g.
// "204/1.8"); a bare "UID" means full size (zoom 1). Tolerates blanks/null.
function _gridParseCellVal(v) {
  const s = (v === undefined || v === null) ? '' : String(v).trim();
  if (!s) return { uid: '', zoom: 1 };
  const i = s.indexOf('/');
  if (i < 0) return { uid: s, zoom: 1 };
  const z = parseFloat(s.slice(i + 1));
  return { uid: s.slice(0, i).trim(), zoom: (isFinite(z) && z > 0) ? z : 1 };
}

// (dev0346) Restore zoom state when a c.json config is activated: the global
// whole-grid zoom from its "Zoom" column, and each cell's per-cell zoom from the
// "UID/zoom" cell values. Clears any stale per-cell zooms first.
function _gridApplyConfigZoom(cfg) {
  _gridCellZoom = {};
  if (!cfg) return;
  const gz = parseFloat(cfg.Zoom);
  if (isFinite(gz) && gz > 0 && typeof window.setSetting === 'function') {
    window.setSetting('gridFillZoom', _gridSnapZoom(gz));
  }
  Object.keys(cfg).forEach(k => {
    if (!_isGridConfigCellKey(k)) return;
    const pv = _gridParseCellVal(cfg[k]);
    if (pv.uid && pv.zoom !== 1) _gridCellZoom[pv.uid] = pv.zoom;
  });
}

// Single entry point for mounting a video cell — picks the buffered YT path
// when enabled+eligible, else the normal per-platform mounts. Shared by the
// full-grid build (gridShow) and the single-cell update (gridUpdateCell).
function _gridMountVideo(vidHost, row, segs, muted) {
  const useBuffer = _gridBufferMode() !== 'off'
    && _gridBufferEligible()
    && window.mountYouTubeClipBuffered
    && window.isYouTubeLink && window.isYouTubeLink(row.link);
  if (useBuffer) {
    window.mountYouTubeClipBuffered(vidHost, row.link, segs, muted,
      _gridBufferMode() === 'fade' ? 'fade' : 'cut', _gridBufferPreroll());
    _gridCoverFitHost(vidHost);
    return;
  }
  if (window.isYouTubeLink && window.isYouTubeLink(row.link) && window.mountYouTubeClip) {
    window.mountYouTubeClip(vidHost, row.link, segs[0].start, segs[0].dur, muted, undefined, segs);
    _gridCoverFitHost(vidHost);
  } else if (window.isVimeoLink && window.isVimeoLink(row.link) && window.mountVimeoClip) {
    window.mountVimeoClip(vidHost, row.link, segs[0].start, segs[0].dur, muted, undefined, segs);
    _gridCoverFitHost(vidHost);
  } else if (window.isDirectVideoLink && window.isDirectVideoLink(row.link) && window.mountDirectVideoClip) {
    window.mountDirectVideoClip(vidHost, row.link, segs[0].start, segs[0].dur, muted, undefined, segs);
    _gridCoverFitHost(vidHost);
  } else if (window.isInstagramLink && window.isInstagramLink(row.link) && window.mountInstagramEmbed) {
    window.mountInstagramEmbed(vidHost, row.link);
  }
}

// Ctrl+B in G cycles off → cut → fade. Desktop-only; mobile gets a hint and no
// change. Re-renders the grid so live video cells remount with the new strategy.
function gridCycleBufferMode() {
  if (typeof _isMobileDevice === 'function' && _isMobileDevice()) {
    if (typeof toast === 'function') toast('Buffered playback is desktop-only', 1600);
    return;
  }
  const order = ['off', 'cut', 'fade'];
  const next = order[(order.indexOf(_gridBufferMode()) + 1) % order.length];
  if (typeof window.setSetting === 'function') window.setSetting('gridBuffer', next);
  const labels = {
    off:  '○ Buffer OFF — single iframe',
    cut:  '◐ Buffer CUT — instant double-buffer swap',
    fade: '◑ Buffer CROSSFADE — dissolve end→start'
  };
  const note = (next !== 'off' && _gridGsize > 4) ? '  ·  ≤4×4 only (falls back at 5×5)' : '';
  const roll = next === 'off' ? '' : ('  ·  pre-roll ' + _gridBufferPreroll().toFixed(1) + 's (−/+ to tune)');
  if (typeof toast === 'function') toast(labels[next] + note + roll, 2400);
  if (typeof gridShow === 'function'
      && document.getElementById('gridOverlay')?.style.display === 'flex') {
    gridShow();
  }
}

// −/+ in G nudges the buffer pre-roll by 0.5s (clamped 1–8) and persists it.
// Re-renders so live buffered cells remount with the new warm-up. A longer
// pre-roll more fully hides YT's startup chrome (esp. across multi-segment seeks)
// at the cost of a longer initial poster + more skipped lead on start<pre-roll
// segments.
function gridAdjustPreroll(delta) {
  const next = Math.max(1, Math.min(8, Math.round((_gridBufferPreroll() + delta) * 2) / 2));
  if (typeof window.setSetting === 'function') window.setSetting('gridBufferPreroll', next);
  const on = _gridBufferMode() !== 'off';
  if (typeof toast === 'function') {
    toast('Buffer pre-roll: ' + next.toFixed(1) + 's' + (on ? '' : '  (turn buffer on with ^B)'), 1500);
  }
  if (on && typeof gridShow === 'function'
      && document.getElementById('gridOverlay')?.style.display === 'flex') {
    gridShow();
  }
}

// (dev0351) Grid size/zoom toasts sit just above the grid (not dead-center,
// where they'd cover the cells being resized/zoomed). Falls back to a normal
// centered toast if the container or toast() isn't available.
function _gridToast(msg, ms) {
  const gc = document.getElementById('gridContainer');
  if (typeof toast === 'function') toast(msg, ms, gc ? { aboveEl: gc } : undefined);
}

// (dev0346) Nudge the WHOLE-GRID zoom (mouse wheel up/down, or `[` / `]`) by
// ±0.1, floor 0.2, no upper limit; persisted in the gridFillZoom setting. Live
// re-fit (no remount) so it tracks the wheel smoothly. 1.0 = plain cover/contain;
// >1 zooms in (crops), <1 zooms out (shrinks with margin).
function gridAdjustFillZoom(delta) {
  _gridZResetArmed = false;   // (dev0350) a zoom nudge breaks the Z double-reset chain
  const next = _gridSnapZoom(_gridFillZoom() + delta);
  if (typeof window.setSetting === 'function') window.setSetting('gridFillZoom', next);
  _gridToast('Zoom: ' + next.toFixed(1) + '×', 1000);
  _gridRefitAll();
}

// (dev0350) Z in G resets zoom in two stages. FIRST press: whole-grid (window)
// zoom → 1.0, but each cell KEEPS its relative per-cell zoom. SECOND consecutive
// Z (no [ ] / Ctrl+[ ] nudge in between) also clears every per-cell zoom,
// flattening the grid to a uniform 1.0. _gridZResetArmed tracks stage one; any
// zoom nudge disarms it.
var _gridZResetArmed = false;
function gridResetZoom() {
  if (typeof window.setSetting === 'function') window.setSetting('gridFillZoom', _GRID_FILLZOOM_DEFAULT);
  if (_gridZResetArmed) {
    _gridCellZoom = {};               // second Z → also flatten per-cell zooms
    _gridCellPan = {};                // (dev0364) and drop transient drag-pans
    _gridZResetArmed = false;
    _gridToast('Zoom reset: whole grid + all cells → 1.0×', 1400);
  } else {
    _gridZResetArmed = true;          // first Z → window zoom only; cells keep relative
    _gridToast('Window zoom → 1.0× (cells keep relative · Z again resets all)', 1800);
  }
  _gridRefitAll();
}

// (dev0368) Shift+Z restores every cell's relative (per-cell) zoom to the value
// saved in the active c.json config — reverting any unsaved Ctrl+[ ] / Shift-drag
// tweaks WITHOUT touching the whole-grid (window) zoom. Mirrors the per-cell half
// of _gridApplyConfigZoom. No active config → no-op toast.
function gridRestoreCellZoomFromConfig() {
  const cfg = window._gridActiveConfig;
  if (!cfg) { if (typeof toast === 'function') toast('No active config to restore cell zooms from', 1600); return; }
  _gridCellZoom = {};
  _gridCellPan = {};                  // drop any transient drag-pans too
  Object.keys(cfg).forEach(k => {
    if (!_isGridConfigCellKey(k)) return;
    const pv = _gridParseCellVal(cfg[k]);
    if (pv.uid && pv.zoom !== 1) _gridCellZoom[pv.uid] = pv.zoom;
  });
  _gridZResetArmed = false;
  _gridToast('Per-cell zooms restored from config', 1500);
  _gridRefitAll();
}

// (dev0347) Ctrl+[ / Ctrl+] over a cell (the one under the mouse) nudges just
// THAT cell's zoom — a multiplier on top of the global zoom. Only video/image/
// montage cells are zoomable; stored per row UID so it can persist to c.json
// ("UID/zoom") and restore. Snapped to 0.2; exactly 1.0 clears the per-cell entry.
function gridAdjustCellZoom(cellEl, delta) {
  _gridZResetArmed = false;   // (dev0350) a per-cell zoom nudge breaks the Z double-reset chain
  if (!cellEl) { if (typeof toast === 'function') toast('Hover a cell, then Ctrl+[ or Ctrl+]', 1200); return; }
  const t = _gridCellZoomTarget(cellEl);
  if (!t) { if (typeof toast === 'function') toast('No per-cell zoom for this cell', 1000); return; }
  const row = cellEl._rowData;
  if (!row || !row.UID) { if (typeof toast === 'function') toast('Cell needs a UID to store its zoom', 1200); return; }
  const cur = _gridCellZoom[row.UID] > 0 ? _gridCellZoom[row.UID] : 1;
  const next = _gridSnapZoom(cur + delta);
  if (Math.abs(next - 1) < 1e-9) delete _gridCellZoom[row.UID];
  else _gridCellZoom[row.UID] = next;
  _gridApplyZoomToCell(cellEl);
  _gridToast((cellEl.dataset.cell || 'cell') + ' zoom: ' + next.toFixed(1) + '×', 1000);
}

// (dev0347) Last grid cell the mouse moved over — the target for Ctrl+[ / Ctrl+]
// per-cell zoom. Tracked by a mousemove listener wired once in gridShow.
// (dev0346's mouse-wheel zoom was removed: plain/Ctrl wheel fight the browser's
// own scroll/page-zoom, so zoom is keyboard-driven — [ ] global, Ctrl+[ ] cell.)
var _gridHoverCell = null;

// (dev0363) Alt-click handler: set this row's center-of-interest (COI) — the
// point zoom anchors toward. Writes straight onto the row's "COI" column as
// "fx,fy@@zoom@@frameRef" (see _gridParseCOI's header); the dev0349 clone-row
// scheme is gone, so one COI per row. zoom = the cell's current effective zoom;
// frameRef = "frame<N>" (N≈video currentTime×30 fps) for a video cell, else
// "image". Re-applies the crop live so the cell reframes immediately.
function gridSetCOI(cellEl, cellStr, e) {
  const row = cellEl && cellEl._rowData;
  if (!row || row.UID == null) { if (typeof toast === 'function') toast('Alt-click: no row here for a COI', 1400); return; }
  const tgt = _gridCellZoomTarget(cellEl);
  if (!tgt) { if (typeof toast === 'function') toast('COI only applies to image/video cells', 1400); return; }
  const rect = cellEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const fx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const fy = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
  // zoom: current effective cell zoom (global × per-cell), 1 decimal place.
  const zoom = _gridZoomForCell(cellEl).toFixed(1);
  // frameRef: a video records the current frame (≈ currentTime × 30 fps) so a
  // future autozoom can return to it; non-video cells record "image".
  let frameRef = 'image';
  if (tgt.kind === 'vid') {
    frameRef = 'frame0';
    try {
      const p = (window.seeLearnVideoPlayers || {})['grid-vid-' + cellStr];
      const t = (p && typeof p.getCurrentTime === 'function') ? p.getCurrentTime() : null;
      if (typeof t === 'number' && isFinite(t) && t >= 0) frameRef = 'frame' + Math.round(t * 30);
    } catch (_) {}
  }
  row.COI = fx.toFixed(3) + ',' + fy.toFixed(3) + '@@' + zoom + '@@' + frameRef;
  if (typeof isoNow === 'function') row.DateModified = isoNow();
  if (typeof save === 'function') save();
  // Reframe the clicked cell at once — it now anchors toward the new COI.
  try { _gridApplyZoomToCell(cellEl); } catch (_) {}
  if (typeof toast === 'function') {
    toast('COI ' + Math.round(fx * 100) + '%, ' + Math.round(fy * 100) + '%  ·  ' + frameRef, 1800);
  }
}

// ── ftext-image cell helpers (non-image link rows) ───────────────────────────

function _ftextImgSrcs(ftext) {
  const d = document.createElement('div');
  d.innerHTML = ftext || '';
  return Array.from(d.querySelectorAll('img[src]'))
    .map(img => img.getAttribute('src'))
    .filter(s => s && /^https?:\/\//i.test(s));
}

function _ftextFirstLine(ftext) {
  const d = document.createElement('div');
  d.innerHTML = ftext || '';
  const walker = document.createTreeWalker(d, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode.textContent.trim();
    if (t.length > 3) return t;
  }
  return '';
}

// (dev0277) Grid HTML thumbnails default to dark text on white (a "paper"
// look). But a slide whose .te-slide wrapper paints a DARK background then
// renders dark-on-dark = garbled (Xe/Xs avoid this by defaulting to white
// text). Detect a dark .te-slide background and flip the thumb to that bg
// with light text, matching the slide views. Light backgrounds keep the
// default dark text.
function _gridThumbApplySlideColors(wrap, inner) {
  if (!wrap || !inner) return;
  const slide = inner.querySelector('.te-slide');
  if (!slide) return;
  const bg = slide.style.backgroundColor || slide.style.background || '';
  const m = bg.match(/rgba?\(([^)]+)\)/i);
  if (!m) return;
  const [r, g, b] = m[1].split(',').map(s => parseFloat(s));
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (lum < 0.5) {
    wrap.style.background = bg;
    inner.style.color = '#fff';
  }
}

// (dev0277) One-time injection of table styling for grid HTML thumbnails.
// Pasted tables otherwise render borderless (just runs of text). Scoped to
// .grid-html-thumb so it can't affect any other UI. Border color works on
// both light and dark thumbnail backgrounds.
function _ensureGridThumbTableCss() {
  if (document.getElementById('salGridThumbCss')) return;
  const st = document.createElement('style');
  st.id = 'salGridThumbCss';
  st.textContent =
      '.grid-html-thumb table{border-collapse:collapse;margin:12px 0;max-width:100%;}'
    + '.grid-html-thumb th,.grid-html-thumb td{border:1px solid #999;padding:6px 10px;'
    + 'text-align:left;vertical-align:top;}'
    + '.grid-html-thumb th{font-weight:bold;}';
  document.head.appendChild(st);
}

// Fills `cell` for a row whose link is a non-image URL.
// 4+ ftext images → 2×2 grid of first 4
// 1–3 ftext images → loads all, picks largest by mpix
// 0 ftext images   → empty backdrop (still gets the text overlay)
// Overlays the first ftext text line (or row title / link host) centred near
// the top. Text uses `mix-blend-mode: difference` for auto-contrast on any
// background, plus alpha 0.30 so it's genuinely 70 % transparent.
function _buildFtextImgCell(cell, row) {
  const srcs = _ftextImgSrcs(row.ftext);

  const hue = Math.random() * 360 | 0;
  const overlayColor = 'hsl(' + hue + ',100%,70%)';

  let firstLine = _ftextFirstLine(row.ftext) || row.t1 || row.n1 || '';
  if (!firstLine && row.link) {
    try { firstLine = new URL(row.link).hostname.replace(/^www\./, ''); } catch (e) {}
  }

  // Chunky 8-direction black outline + soft glow so bright text stays readable
  // on any image or video frame. -webkit-text-stroke gives the hard edge,
  // text-shadow adds depth + halo.
  const TEXT_SHADOW =
    '-2px -2px 0 #000,2px -2px 0 #000,-2px 2px 0 #000,2px 2px 0 #000,'
    + '0 -2px 0 #000,0 2px 0 #000,-2px 0 0 #000,2px 0 0 #000,'
    + '0 0 6px #000,0 0 10px #000';

  const buildWith = (displaySrcs) => {
    const wrapper = document.createElement('div');
    // (dev0347) `grid-zoom-box` tags this montage as a zoom target so [ ] and
    // Ctrl+[ ] scale it like a direct image (transform-origin centers the crop).
    wrapper.className = 'grid-zoom-box';
    if (displaySrcs.length >= 2) {
      wrapper.style.cssText = 'position:absolute;inset:0;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;pointer-events:none;z-index:1;background:#000;gap:1px;transform-origin:center center;';
    } else {
      wrapper.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:1;background:#000;transform-origin:center center;';
    }
    displaySrcs.slice(0, 4).forEach(src => {
      const img = document.createElement('img');
      img.src = src;
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
      img.onerror = () => { img.style.display = 'none'; };
      wrapper.appendChild(img);
    });
    cell.appendChild(wrapper);
    _gridApplyZoomToCell(cell);   // (dev0347) apply saved zoom (montage builds async)
    if (firstLine) {
      const lbl = document.createElement('div');
      lbl.style.cssText = 'position:absolute;top:10%;left:5%;right:5%;'
        + 'color:' + overlayColor + ';font-size:15px;font-weight:900;'
        + 'text-align:center;pointer-events:none;z-index:2;'
        + 'text-shadow:' + TEXT_SHADOW + ';'
        + '-webkit-text-stroke:0.5px #000;'
        + 'overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;'
        + '-webkit-box-orient:vertical;line-height:1.15;'
        + 'letter-spacing:0.2px;';
      lbl.textContent = firstLine;
      cell.appendChild(lbl);
    }
  };

  if (srcs.length === 0) {
    buildWith([]);
  } else if (srcs.length >= 4) {
    buildWith(srcs);
  } else {
    let best = { src: srcs[0], mpix: 0 };
    let pending = srcs.length;
    srcs.forEach(src => {
      const tmp = new Image();
      tmp.onload = () => {
        const mp = tmp.naturalWidth * tmp.naturalHeight;
        if (mp > best.mpix) { best.src = src; best.mpix = mp; }
        if (--pending === 0) buildWith([best.src]);
      };
      tmp.onerror = () => { if (--pending === 0) buildWith([best.src]); };
      tmp.src = src;
    });
  }
  return true;
}

function gridShow() {
  gridCleanupPlayers();
  gridClearCut();
  const overlay = document.getElementById('gridOverlay');
  const container = document.getElementById('gridContainer');
  container.innerHTML = '';
  // (zip0153) Apply current grid template before laying out cells.
  // _gridGsize is set on load (from _salMeta._salGsize), on number-key
  // press in G, or by C-config activation (size derived from cfg.cells).
  _gridApplyContainerCSS();
  
  // (dev0370) Build from the active layout's cell list. Square layouts give the
  // gsize×gsize block (auto-flowed); 17/19 give the 16-cell ring + merged center.
  const _layout = _gridCurrentLayout();
  for (const _spec of _gridCellList(_gridGsize, _layout)) {
      const cellStr = _spec.cs;
      const row = getRowByCellForGrid(cellStr);
      
      const cell = document.createElement('div');
      cell.className = 'grid-cell';
      cell.dataset.cell = cellStr;
      cell.style.cssText = 'position:relative;background:#000;overflow:hidden;';
      // (dev0370) Special layouts place every cell explicitly so the spanning
      // center lines up with the ring; square layouts keep auto-flow (unchanged).
      if (_layout !== 'square') {
        cell.style.gridRow    = _spec.r + ' / span ' + _spec.rs;
        cell.style.gridColumn = _spec.c + ' / span ' + _spec.cls;
      }
      
      if (row) {
        const isVid = isVideoRow(row);
        const isText = row.VidRange === 'text' || (row.ftext && !row.link);
        const isQuiz = !!(row.qfile || (row.ftext && !row.link && (row.ftext.trim().startsWith('[') || row.ftext.trim().startsWith('{'))));
        const isImgLink = /\.(jpe?g|png|gif|webp|svg|bmp|tiff?)(\?.*)?$/i.test(row.link || '');
        const hasFtextImgs = !!(row.ftext && row.ftext.includes('<img'));
        const isIG = !!(row.link && window.isInstagramLink && window.isInstagramLink(row.link));

        if (isIG) {
          // Live IG embed clipped to fit. Iframe is rendered at its natural
          // 326×620 size, scaled to cell width, and offset upward by the
          // header height — overflow:hidden on the wrap drops the footer.
          // The center play caret IG paints on reel posters can't be hidden
          // (cross-origin). Click is routed through the cell interactor as
          // usual, so tapping opens V (vpMountInstagram handles full view).
          const igWrap = document.createElement('div');
          igWrap.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:#000;pointer-events:none;z-index:1;';
          const igFrame = document.createElement('iframe');
          igFrame.src = window.instagramEmbedUrl(row.link);
          igFrame.setAttribute('frameborder', '0');
          igFrame.setAttribute('scrolling', 'no');
          igFrame.setAttribute('allowtransparency', 'true');
          igFrame.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; web-share');
          igFrame.style.cssText = 'position:absolute;left:0;top:0;width:326px;height:620px;'
            + 'border:0;background:#000;pointer-events:none;transform-origin:top left;';
          igWrap.appendChild(igFrame);
          cell.appendChild(igWrap);
          fitGridIgFrame(cell, igFrame);
        } else if (isQuiz) {
          // Quiz/HTML cell — show a styled badge
          cell.style.background = '#0a1a0a';
          const badge = document.createElement('div');
          badge.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none;z-index:1;';
          badge.innerHTML = '<div style="font-size:28px;margin-bottom:4px;">📋</div>'
            + '<div style="font-size:10px;color:#8f8;font-family:monospace;text-align:center;padding:0 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:90%;">'
            + escH(row.qfile || row.n1 || 'Quiz') + '</div>';
          cell.appendChild(badge);
        } else if (isText && row.ftext) {
          // (zip0144) HTML/text preview — render the FULL ftext inside
          // a fixed virtual canvas (600px wide), then scale to fit the
          // cell with JS after layout. Previously used a fixed
          // transform:scale(0.7) that just showed the top-left corner
          // at 70%, which clipped most rich-text slides. The new
          // approach shows the entire slide as a true thumbnail.
          const wrap = document.createElement('div');
          wrap.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:#fff;pointer-events:none;z-index:1;';
          const inner = document.createElement('div');
          inner.className = 'grid-html-thumb';
          inner.style.cssText = 'position:absolute;top:0;left:0;width:600px;'
            + 'transform-origin:top left;font-family:Arial,sans-serif;'
            + 'color:#222;padding:16px;box-sizing:border-box;';
          inner.innerHTML = (typeof renderFtext === "function" ? renderFtext(row.ftext) : row.ftext);
          _ensureGridThumbTableCss();
          _gridThumbApplySlideColors(wrap, inner);
          wrap.appendChild(inner);
          cell.appendChild(wrap);
          cell.style.background = '#fff';
          // Scale after the cell has its real dimensions. rAF gives the
          // grid one paint to compute its 5×5 layout; without it the
          // cell measures 0×0 and the scale comes out to NaN.
          fitGridHtmlThumb(cell, wrap, inner);
        } else if (isVid && row.link) {
          const vidHost = document.createElement('div');
          vidHost.id = 'grid-vid-' + cellStr;
          vidHost.style.cssText = 'position:absolute;inset:0;background:#000;pointer-events:none;z-index:1;';
          cell.appendChild(vidHost);
          _gridPlayers[vidHost.id] = true;
          setTimeout(() => {
            // Default to playing from start if no VidRange defined
            // (YT mount caps 99999 to real duration on ready; Vimeo 'ended' loops back)
            const segs = window.parseVideoAsset(row.VidRange) || [{ start: 0, dur: 99999 }];
            // (zip0152) G/Gu policy: video is ALWAYS muted on the grid,
            // regardless of the row's Mute column value. The Mute column
            // still controls V-screen behavior (0 = audio plays, 1 = silent),
            // and is preserved here untouched. Future audio-only cells
            // (mp3/wav rows) should NOT be routed through this branch and
            // will play normally — this mute applies to video only.
            const muted = true;
            _gridMountVideo(vidHost, row, segs, muted);
          }, 100);
        } else if (row.link && !isImgLink) {
          _buildFtextImgCell(cell, row);
        } else if (row.link) {
          const img = document.createElement('img');
          img.className = 'grid-zoom-img';   // (dev0346) wheel-zoom target
          img.src = row.link;
          img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;z-index:1;transform-origin:center center;';
          img.onerror = () => { img.style.display = 'none'; };
          cell.appendChild(img);
        }
        cell._rowData = row;
        _gridApplyZoomToCell(cell);   // (dev0346) apply any saved global/per-cell zoom
      } else {
        cell.style.background = '#0a0a1a';
      }
      
      // Transparent interactor overlay
      const interactor = document.createElement('div');
      interactor.className = 'grid-interactor';
      // (zip0143) `touch-action: none` is critical — without it, mobile
      // browsers (especially Brave and Opera Mini) intercept horizontal
      // swipes for their own back/forward navigation BEFORE pointermove
      // or pointerup fire on the page, so our gesture detection never
      // sees the gesture. This single property makes left/right swipes
      // work consistently across Firefox / Brave / Opera / Edge / Safari.
      interactor.style.cssText = 'position:absolute;inset:0;z-index:100;background:rgba(0,0,0,0.01);cursor:pointer;touch-action:none;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;';
      
      // Cell label
      // (zip0144) Tighter, double-stack text-shadow so the label
      // remains readable on the new white-background HTML thumbnails.
      // The previous single 1px/1px/2px shadow vanished against light
      // page backgrounds.
      const lbl = document.createElement('div');
      lbl.style.cssText = 'position:absolute;top:4px;left:6px;font-size:12px;color:rgba(120,180,255,0.95);font-weight:bold;pointer-events:none;text-shadow:0 0 4px #000,0 0 4px #000,1px 1px 2px #000;';
      lbl.textContent = cellStr;
      interactor.appendChild(lbl);
      
      // Info overlay
      if (row && (row.n1 || row.t1)) {
        const info = document.createElement('div');
        info.style.cssText = 'position:absolute;bottom:4px;left:6px;right:6px;font-size:10px;color:#fff;pointer-events:none;text-shadow:0 0 4px #000,0 0 4px #000,1px 1px 2px #000;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        info.textContent = [row.t1, row.n1].filter(Boolean).join(' · ');
        interactor.appendChild(info);
      }
      
      gridWireInteractor(interactor, cell, cellStr);
      cell.appendChild(interactor);
      container.appendChild(cell);
  }
  
  // Update info bar
  const srcLabel = _gridSource === 'C' ? 'C:'+(_gridActiveConfig?.gname||'?') : 'T';
  const occupied = (() => {
    let n = 0;
    for (const _s of _gridCellList(_gridGsize, _layout))
      if (getRowByCellForGrid(_s.cs)) n++;
    return n;
  })();
  // (zip0141) Tailor the help hint string by mode. Dev shows the full
  // edit/save shortcut list; user (Gu) just sees the viewing actions.
  const userModeHere = (typeof _isUserMode === 'function') ? _isUserMode() : false;
  const hint = userModeHere
    ? 'Tap=play · Swipe→=full screen · 2-5=size'
    : 'HOLD=cut · Swipe→=view · ^L=edit · ^!G=save · 2-5=size · ^B=clean · []=zoom · ^[]=cell · ⇧drag=zoom/pan · Alt-clk=COI';
  // (dev0336) Live buffer-mode badge — shows the current clean-playback mode
  // when on, plus a "(≤4×4)" flag when the current size makes it fall back.
  const _bufMode = _gridBufferMode();
  const _bufTag = _bufMode === 'off' ? ''
    : ' · ⟳' + _bufMode + ' ' + _gridBufferPreroll().toFixed(1) + 's' + (_gridBufferEligible() ? '' : '(≤4×4)');
  // (dev0346) Show the whole-grid zoom whenever it's not 1× (zoomed in OR out).
  const _zoom = _gridFillZoom();
  const _zoomTag = Math.abs(_zoom - 1) > 1e-9 ? ' · ⤢' + _zoom.toFixed(1) + '×' : '';
  // (zip0153) Total cells = _gridGsize²; (dev0370) special layouts show name+count.
  const _total = _layout === '17' ? 17 : _layout === '19' ? 19 : _gridGsize * _gridGsize;
  const _sizeLabel = _layout === 'square' ? (_gridGsize + '×' + _gridGsize) : ('layout ' + _layout);
  document.getElementById('gridInfo').textContent =
    '['+srcLabel+'] ' + _sizeLabel + ' · '
    + occupied + '/' + _total + ' · ' + hint + _bufTag + _zoomTag;
  
  gridUpdateSourceBtns();
  overlay.style.display = 'flex';
  // (dev0347) Track the cell under the mouse so Ctrl+[ / Ctrl+] can zoom it.
  // Bound once — the overlay element persists across re-renders (gridShow only
  // rebuilds the container's children), so a guard flag avoids duplicate binds.
  if (!overlay._hoverWired) {
    overlay._hoverWired = true;
    overlay.addEventListener('mousemove', e => {
      _gridHoverCell = (e.target && e.target.closest) ? e.target.closest('.grid-cell') : null;
    }, true);
    overlay.addEventListener('mouseleave', () => { _gridHoverCell = null; }, true);
  }
  // (dev0369) Grid-level "swipe back to the Main Page" gesture (user mode only).
  // A right-to-left swipe that CROSSES A CELL BOUNDARY — begins in one grid cell
  // and ends in a different cell (or off the grid) — returns to the shareable
  // menu's Main Page. A left-swipe that STAYS inside a single cell keeps its
  // existing per-cell behaviour (pause that cell). Wired in CAPTURE on the overlay
  // (the common ancestor of every cell) so it sees the whole gesture no matter
  // which cell the pointer is released over, and can stopPropagation the per-cell
  // pause when it acts. Pointer-based → fires for mouse AND modern touch; the rare
  // no-pointer-events touch path is covered by the per-cell fallback in
  // _dispatchGesture(). Direction uses wrap-local coords (rotateXY) so it matches
  // the user's view in CSS-rotated portrait; cell hit-testing uses raw viewport
  // coords (elementFromPoint). Modifier-held gestures (Shift/Ctrl zoom+pan, Alt
  // COI) are excluded.
  if (!overlay._swipeWired) {
    overlay._swipeWired = true;
    const _cellAt = (x, y) => {
      const el = document.elementFromPoint(x, y);
      return (el && el.closest) ? el.closest('.grid-cell') : null;
    };
    let _swX = null, _swY = null, _swMod = false, _swCell = null;
    overlay.addEventListener('pointerdown', e => {
      _swX = e.clientX; _swY = e.clientY;
      _swMod = e.shiftKey || e.ctrlKey || e.altKey || e.metaKey;
      _swCell = _cellAt(e.clientX, e.clientY);
    }, true);
    overlay.addEventListener('pointerup', e => {
      const x0 = _swX, y0 = _swY, mod = _swMod, startCell = _swCell;
      _swX = _swY = null; _swMod = false; _swCell = null;
      if (x0 == null || mod || !startCell) return;
      if (typeof _isUserMode === 'function' && !_isUserMode()) return;
      // Direction in the user's visual frame (handles rotated portrait).
      const a = window.rotateXY ? window.rotateXY({ clientX: x0, clientY: y0 }) : { x: x0, y: y0 };
      const b = window.rotateXY ? window.rotateXY(e) : { x: e.clientX, y: e.clientY };
      const dx = b.x - a.x, dy = b.y - a.y;
      if (!(dx < -30 && Math.abs(dx) > Math.abs(dy))) return;   // must be a clear R→L swipe
      // Crossed a cell boundary? End point lands in a different cell (or off-grid).
      if (_cellAt(e.clientX, e.clientY) === startCell) return;  // stayed inside → let per-cell pause run
      e.preventDefault(); e.stopPropagation();
      // (dev0384) Route through the shared helper so it lands on the menu page
      // the grid was launched from (window._smReturnPage), same as Esc.
      if (typeof window._returnToMenuFromGrid === 'function') window._returnToMenuFromGrid();
      else {
        if (typeof gridCleanupPlayers === 'function') gridCleanupPlayers();
        overlay.style.display = 'none';
        if (typeof _showShareableMenu === 'function') _showShareableMenu();
      }
    }, true);
  }
  // (zip0141) Re-apply user-mode chrome AFTER the overlay flips visible —
  // gridUpdateSourceBtns may have re-set display/opacity on the dev
  // buttons. Idempotent and a no-op in dev mode.
  if (typeof _applyUserModeChromeOnGrid === 'function') _applyUserModeChromeOnGrid();
}

function gridCut(cellStr) {
  gridClearCut();
  _gridCutCell = cellStr;
  const cellEl = document.querySelector(`.grid-cell[data-cell="${cellStr}"]`);
  if (cellEl) {
    cellEl.classList.add('cut');
    cellEl.style.outline = '3px solid #ff0';
    cellEl.style.outlineOffset = '-3px';
  }
  // Show cut info balloon
  const cutInfo = document.getElementById('gridCutInfo');
  if (cutInfo) {
    cutInfo.textContent = '✂ Cut: ' + cellStr + ' — click destination to swap';
    cutInfo.style.display = 'block';
  }
  toast('✂ Cut ' + cellStr + ' — click destination', 2000);
}

function gridPaste(targetCell) {
  if (!_gridCutCell) return;
  const srcCell = _gridCutCell;
  gridClearCut();

  if (srcCell === targetCell) return;

  // (dev0371) Resolve via getRowByCellForGrid so swaps work in BOTH sources and
  // for the special 1L/1P-3P cells. getRowByCell only knew row.cell, which the
  // special cells never carry — that's why their transfers silently failed.
  const rowA = getRowByCellForGrid(srcCell);
  const rowB = getRowByCellForGrid(targetCell);
  const now = isoNow();

  if (_gridSource === 'C' && _gridActiveConfig) {
    // In C mode the active config is the live store the grid renders from, so
    // swap the stored cell values (UID or "UID/zoom") there. Re-mirror row.cell
    // for any standard endpoint and clear it for a special one (no r.cell slot).
    const a = _gridActiveConfig[srcCell] || '';
    const b = _gridActiveConfig[targetCell] || '';
    _gridActiveConfig[srcCell]    = b;
    _gridActiveConfig[targetCell] = a;
    if (rowA) { rowA.cell = parseGridCell(targetCell) ? targetCell : ''; rowA.DateModified = now; }
    if (rowB) { rowB.cell = parseGridCell(srcCell)    ? srcCell    : ''; rowB.DateModified = now; }
  } else {
    // T mode: row.cell is the store.
    if (rowA) { rowA.cell = targetCell; rowA.DateModified = now; }
    if (rowB) { rowB.cell = srcCell;    rowB.DateModified = now; }
  }

  save();

  // Immediate visual update — swap the two cells in place (each slot keeps its
  // own size, so the big/portrait cell just shows the newly-assigned content).
  gridUpdateCell(srcCell, rowB);     // srcCell now shows rowB's content
  gridUpdateCell(targetCell, rowA);  // targetCell now shows rowA's content

  // (dev0373) Show the confirmation at the destination cell (where the mouse just
  // clicked) rather than screen-center, so it doesn't cover the grid middle.
  const _tgtEl = document.querySelector('.grid-cell[data-cell="' + targetCell + '"]');
  if (_tgtEl) {
    const r = _tgtEl.getBoundingClientRect();
    toast('↔ Swapped ' + srcCell + ' ↔ ' + targetCell, 1500, { atXY: { x: r.left + r.width / 2, y: r.top + r.height / 2 } });
  } else {
    toast('↔ Swapped ' + srcCell + ' ↔ ' + targetCell, 1500);
  }
}

// Update a single grid cell's visual content without rebuilding entire grid
function gridUpdateCell(cellStr, row) {
  const cellEl = document.querySelector(`.grid-cell[data-cell="${cellStr}"]`);
  if (!cellEl) return;
  
  // Stop any existing video in this cell
  const oldVidHost = cellEl.querySelector('[id^="grid-vid-"]');
  if (oldVidHost && window.stopCellVideoLoop) {
    window.stopCellVideoLoop(oldVidHost.id);
    delete _gridPlayers[oldVidHost.id];
  }
  
  // Remove old content (but keep interactor)
  const interactor = cellEl.querySelector('.grid-interactor');
  cellEl.innerHTML = '';
  
  if (row) {
    cellEl._rowData = row;
    cellEl.style.background = '#000';
    const isVid = isVideoRow(row);
    const isText = row.VidRange === 'text' || (row.ftext && !row.link);
    const isQuiz = !!(row.qfile || (row.ftext && !row.link && (row.ftext.trim().startsWith('[') || row.ftext.trim().startsWith('{'))));
    const isImgLink = /\.(jpe?g|png|gif|webp|svg|bmp|tiff?)(\?.*)?$/i.test(row.link || '');
    const hasFtextImgs = !!(row.ftext && row.ftext.includes('<img'));
    const isIG = !!(row.link && window.isInstagramLink && window.isInstagramLink(row.link));

    if (isIG) {
      // Live IG embed clipped to fit — see gridShow's matching block for the
      // rationale on scaling + header clip.
      const igWrap = document.createElement('div');
      igWrap.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:#000;pointer-events:none;z-index:1;';
      const igFrame = document.createElement('iframe');
      igFrame.src = window.instagramEmbedUrl(row.link);
      igFrame.setAttribute('frameborder', '0');
      igFrame.setAttribute('scrolling', 'no');
      igFrame.setAttribute('allowtransparency', 'true');
      igFrame.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; web-share');
      igFrame.style.cssText = 'position:absolute;left:0;top:0;width:326px;height:620px;'
        + 'border:0;background:#000;pointer-events:none;transform-origin:top left;';
      igWrap.appendChild(igFrame);
      cellEl.appendChild(igWrap);
      fitGridIgFrame(cellEl, igFrame);
    } else if (isQuiz) {
      cellEl.style.background = '#0a1a0a';
      const badge = document.createElement('div');
      badge.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none;z-index:1;';
      badge.innerHTML = '<div style="font-size:28px;margin-bottom:4px;">📋</div>'
        + '<div style="font-size:10px;color:#8f8;font-family:monospace;text-align:center;padding:0 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:90%;">'
        + escH(row.qfile || row.n1 || 'Quiz') + '</div>';
      cellEl.appendChild(badge);
    } else if (isText && row.ftext) {
      // (zip0144) See gridShow's matching block — same shrink-to-fit
      // thumbnail rendering for the HTML/text preview, used when an
      // individual cell is updated (e.g., after a paste or save).
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:#fff;pointer-events:none;z-index:1;';
      const inner = document.createElement('div');
      inner.className = 'grid-html-thumb';
      inner.style.cssText = 'position:absolute;top:0;left:0;width:600px;'
        + 'transform-origin:top left;font-family:Arial,sans-serif;'
        + 'color:#222;padding:16px;box-sizing:border-box;';
      inner.innerHTML = (typeof renderFtext === "function" ? renderFtext(row.ftext) : row.ftext);
      _ensureGridThumbTableCss();
      _gridThumbApplySlideColors(wrap, inner);
      wrap.appendChild(inner);
      cellEl.appendChild(wrap);
      cellEl.style.background = '#fff';
      fitGridHtmlThumb(cellEl, wrap, inner);
    } else if (isVid && row.link) {
      // Video cell
      const vidHost = document.createElement('div');
      vidHost.id = 'grid-vid-' + cellStr;
      vidHost.style.cssText = 'position:absolute;inset:0;background:#000;pointer-events:none;z-index:1;';
      cellEl.appendChild(vidHost);
      _gridPlayers[vidHost.id] = true;
      
      setTimeout(() => {
        // Default to playing from start if no VidRange defined
        const segs = window.parseVideoAsset(row.VidRange) || [{ start: 0, dur: 99999 }];
        // (zip0152) G/Gu policy: video is ALWAYS muted on the grid. See
        // gridShow() for the full rationale. Single-cell update path
        // (e.g., after a paste or swap) must enforce the same rule.
        const muted = true;
        _gridMountVideo(vidHost, row, segs, muted);
      }, 50);
    } else if (row.link && !isImgLink) {
      _buildFtextImgCell(cellEl, row);
    } else if (row.link) {
      // Image cell
      const img = document.createElement('img');
      img.className = 'grid-zoom-img';   // (dev0346) wheel-zoom target
      img.src = row.link;
      img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;z-index:1;transform-origin:center center;';
      img.onerror = () => { img.style.display = 'none'; };
      cellEl.appendChild(img);
    }
  } else {
    // Empty cell
    cellEl._rowData = null;
    cellEl.style.background = '#0a0a1a';
  }
  _gridApplyZoomToCell(cellEl);   // (dev0346) apply saved global/per-cell zoom
  
  // Recreate interactor overlay
  const newInteractor = document.createElement('div');
  newInteractor.className = 'grid-interactor';
  // (zip0143) Same touch-action:none as initial creation — see comment
  // there. Required for Brave/Opera Mini swipe to register.
  newInteractor.style.cssText = 'position:absolute;inset:0;z-index:100;background:rgba(0,0,0,0.01);cursor:pointer;touch-action:none;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;';
  
  // Cell label
  // (zip0144) Match gridShow's label/info shadow strengthening so
  // re-rendered cells stay readable on white HTML thumbnails.
  const lbl = document.createElement('div');
  lbl.style.cssText = 'position:absolute;top:4px;left:6px;font-size:12px;color:rgba(120,180,255,0.95);font-weight:bold;pointer-events:none;text-shadow:0 0 4px #000,0 0 4px #000,1px 1px 2px #000;';
  lbl.textContent = cellStr;
  newInteractor.appendChild(lbl);
  
  // Info overlay
  if (row && (row.n1 || row.t1)) {
    const info = document.createElement('div');
    info.style.cssText = 'position:absolute;bottom:4px;left:6px;right:6px;font-size:10px;color:#fff;pointer-events:none;text-shadow:0 0 4px #000,0 0 4px #000,1px 1px 2px #000;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    info.textContent = [row.t1, row.n1].filter(Boolean).join(' · ');
    newInteractor.appendChild(info);
  }
  
  // Re-wire pointer interactions
  gridWireInteractor(newInteractor, cellEl, cellStr);
  cellEl.appendChild(newInteractor);
}

// Wire up pointer events on an interactor (extracted for reuse)
function gridWireInteractor(interactor, cell, cellStr) {
  let pStart = null;
  let holdTmr = null;
  let didHold = false;
  let wasCtrl = false;
  let wasLeftBtn = false;
  // (zip0142) Manual double-tap timestamp for this cell. Browsers
  // suppress dblclick when pointerdown.preventDefault() is called, so we
  // detect it ourselves from successive pointerups < 400ms apart. See the
  // matching block at the bottom of pointerup, and _runDoubleTapAction()
  // for the action body (extracted from the legacy dblclick listener).
  let _lastShortTapT = 0;
  // (zip0141) In user mode (Gu), no cell editing: skip hold-to-cut,
  // skip context-menu cut/paste, skip double-click into the text editor.
  // Cached once per call — _isUserMode() reads URL/hostname which don't
  // change mid-session.
  const userMode = (typeof _isUserMode === 'function') ? _isUserMode() : false;

  // ── (dev0364) Shift mouse-hold ZOOM + drag-PAN (desktop only) ──────────────
  // Mirrors the V-player's hold-zoom/drag-pan (vp.js wireMouseV), but Shift-gated:
  // plain-hold (=cut) and plain-drag (=swipe) are already taken on a grid cell, as
  // are Ctrl (Ctrl+click→Xe/E) and Alt (Alt-click→COI). Shift+hold-LMB ramps this
  // cell's per-cell zoom IN (accelerating), Shift+hold-RMB ramps OUT, and a
  // Shift+drag pans the zoomed content (transient _gridCellPan, >1.05× only).
  // Phones keep pinch; this never arms there. When active it short-circuits the
  // normal gesture path (pStart left null) in pointermove/up/cancel.
  let _szActive = false, _szDown = false, _szDragging = false;
  let _szStart = null, _szPanBase = null, _szBtn = 0;
  let _szDelay = null, _szTimer = null, _szStep = 0;
  const _szUID = () => (cell._rowData ? cell._rowData.UID : null);
  function _szStop() {
    if (_szDelay) { clearTimeout(_szDelay);  _szDelay = null; }
    if (_szTimer) { clearInterval(_szTimer); _szTimer = null; }
  }
  function _szCancel() {
    _szStop();
    _szActive = _szDown = _szDragging = false;
    _szStart = _szPanBase = null;
    interactor.style.cursor = '';
  }
  function _szBegin(e) {
    const uid = _szUID();
    if (uid == null) return;
    _szActive = true; _szDown = true; _szDragging = false;
    _szBtn = e.button;                       // 0=left → zoom in, 2=right → zoom out
    _szStart = { x: e.clientX, y: e.clientY };
    _szPanBase = null;
    try { interactor.setPointerCapture(e.pointerId); } catch (_) {}
    _gridZResetArmed = false;                // a zoom gesture breaks the Z double-reset chain
    // (dev0368) Direction: right button OR Ctrl+left → OUT, plain left → IN.
    // The Ctrl+Shift+left-hold alias is the Firefox-safe way to zoom out, since
    // Firefox force-shows its native menu on Shift+right-click (no page can block it).
    const dir = (_szBtn === 2 || e.ctrlKey) ? -1 : 1;
    _szStep = 0.01;
    // 180ms settle so a quick Shift+click doesn't zoom.
    _szDelay = setTimeout(() => {
      _szDelay = null;
      _szTimer = setInterval(() => {
        const cur = _gridCellZoom[uid] > 0 ? _gridCellZoom[uid] : 1;
        let next = cur + dir * _szStep;
        // Floor the EFFECTIVE zoom (global × per-cell) at the grid minimum.
        const g = _gridFillZoom();
        if (g * next < _GRID_ZOOM_MIN) next = _GRID_ZOOM_MIN / g;
        _gridCellZoom[uid] = next;
        _szStep = Math.min(0.08, _szStep + 0.004);
        _gridApplyZoomToCell(cell);
      }, 50);
    }, 180);
  }
  function _szMove(e) {
    if (!_szDown) return;
    if (!_szDragging && Math.hypot(e.clientX - _szStart.x, e.clientY - _szStart.y) > 8) {
      _szDragging = true;
      _szStop();                             // a drag cancels the zoom ramp
      const uid = _szUID();
      const b = (_gridCellPan[uid] && typeof _gridCellPan[uid].x === 'number')
        ? _gridCellPan[uid] : { x: 0, y: 0 };
      _szPanBase = { x: b.x, y: b.y, px: e.clientX, py: e.clientY };
      interactor.style.cursor = 'grabbing';
    }
    if (_szDragging && _gridZoomForCell(cell) > 1.05) {
      const uid = _szUID();
      _gridCellPan[uid] = {
        x: _szPanBase.x + (e.clientX - _szPanBase.px),
        y: _szPanBase.y + (e.clientY - _szPanBase.py)
      };
      _gridApplyZoomToCell(cell);
    }
  }
  function _szEnd(e) {
    _szStop();
    const uid = _szUID();
    if (uid != null && _gridCellZoom[uid] > 0) {
      const snapped = _gridSnapZoom(_gridCellZoom[uid]);
      if (Math.abs(snapped - 1) < 1e-9) delete _gridCellZoom[uid];
      else _gridCellZoom[uid] = snapped;
    }
    _gridApplyZoomToCell(cell);
    _gridToast((cell.dataset.cell || 'cell') + ' zoom: ' + _gridZoomForCell(cell).toFixed(1) + '×', 1000);
    try { interactor.releasePointerCapture(e.pointerId); } catch (_) {}
    _szActive = _szDown = _szDragging = false;
    _szStart = _szPanBase = null;
    interactor.style.cursor = '';
  }

  interactor.addEventListener('pointerdown', e => {
    e.preventDefault();
    // (dev0364) Shift + mouse → zoom (LMB in / RMB out) + drag-pan the zoomed cell.
    // Desktop only; only on a zoomable (image/video/montage) cell. Leaves pStart
    // null so the normal tap/hold/swipe path bails for the rest of this gesture.
    if (e.shiftKey && e.pointerType === 'mouse' &&
        !(typeof _isMobileDevice === 'function' && _isMobileDevice()) &&
        _gridCellZoomTarget(cell) && (e.button === 0 || e.button === 2)) {
      e.preventDefault(); e.stopPropagation();
      _szBegin(e);
      pStart = null;
      return;
    }
    // (dev0348) Alt+left-click sets this row's center-of-interest (COI) — the
    // anchor point zoom scales toward. Dev-only; intercepts before any
    // gesture/hold so it doesn't double as a tap. Uses raw client coords vs the
    // cell rect (rotation not handled — this is a desktop dev action).
    if (e.altKey && e.button === 0 && !userMode) {
      e.preventDefault(); e.stopPropagation();
      gridSetCOI(cell, cellStr, e);
      pStart = null;
      return;
    }
    // (zip0174) Translate physical screen coords to wrap-local coords so
    // swipe direction matches user perception in CSS-rotated portrait.
    // No-op when not rotated.
    const _p = window.rotateXY ? window.rotateXY(e) : { x: e.clientX, y: e.clientY };
    pStart = { x: _p.x, y: _p.y, t: Date.now() };
    didHold = false;
    wasCtrl = e.ctrlKey;
    wasLeftBtn = (e.button === 0); // 0=left, 2=right
    
    // (zip0141) Hold-to-cut is dev-only — disabled in user mode (Gu).
    if (!userMode && cell._rowData && !_gridCutCell && !e.ctrlKey) {
      holdTmr = setTimeout(() => {
        didHold = true;
        gridCut(cellStr);
        cell.style.transform = 'scale(0.95)';
        cell.style.opacity = '0.7';
      }, 500);
    }
  }, true);
  
  interactor.addEventListener('pointermove', e => {
    if (_szActive) { _szMove(e); return; }   // (dev0364) Shift zoom/pan gesture owns it
    if (!pStart) return;
    const _p = window.rotateXY ? window.rotateXY(e) : { x: e.clientX, y: e.clientY };
    const dx = Math.abs(_p.x - pStart.x);
    const dy = Math.abs(_p.y - pStart.y);
    if (dx > 10 || dy > 10) clearTimeout(holdTmr);
  }, true);
  
  interactor.addEventListener('pointerup', e => {
    if (_szActive) { _szEnd(e); return; }    // (dev0364) finish Shift zoom/pan gesture
    clearTimeout(holdTmr);
    cell.style.transform = '';
    cell.style.opacity = '';
    if (!pStart) return;
    
    const _p = window.rotateXY ? window.rotateXY(e) : { x: e.clientX, y: e.clientY };
    const dx = _p.x - pStart.x;
    const dy = _p.y - pStart.y;
    const ms = Date.now() - pStart.t;
    const ctrl = wasCtrl;
    const leftBtn = wasLeftBtn;
    pStart = null;
    wasCtrl = false;
    wasLeftBtn = false;
    
    if (didHold) { didHold = false; return; }
    
    // Swipe RIGHT → VP / fullscreen image
    if (dx > 40 && Math.abs(dy) < Math.abs(dx)) {
      if (cell._rowData) {
        _lastGridRow = cell._rowData;
        gridOpenFullscreen(cell._rowData);
      }
      return;
    }
    
    // Swipe LEFT → pause video
    if (dx < -40 && Math.abs(dy) < Math.abs(dx)) {
      gridTogglePauseCell(cellStr);
      return;
    }

    // (dev0371) A cut is pending → any plain (non-Ctrl) press-release on a cell
    // completes the swap, even if it ran a little long or drifted slightly. The
    // old path only pasted inside the <500ms / <15px short-click gate below,
    // which dropped a chunk of deliberate destination clicks. Swipes are already
    // handled above; a real drag (>40px) still falls through to nothing.
    if (_gridCutCell && !ctrl && Math.abs(dx) < 40 && Math.abs(dy) < 40) {
      if (_gridCutCell === cellStr) { gridClearCut(); toast('Cut cancelled', 800); }
      else gridPaste(cellStr);
      return;
    }

    // Short click
    if (Math.abs(dx) < 15 && Math.abs(dy) < 15 && ms < 500) {
      // (zip0142) Ctrl+left-click is dev-only — user mode (Gu) treats it
      // as an ordinary tap (sets last row, does not open the editor).
      if (ctrl && leftBtn && cell._rowData && !userMode) {
        _lastGridRow = cell._rowData;
        _cameFromGrid = true;
        gridCleanupPlayers();
        document.getElementById('gridOverlay').style.display = 'none';
        if (isVideoRow(cell._rowData)) {
          if (window.openVideoEditor) window.openVideoEditor(cell._rowData);
        } else if (_gridIsTextRow(cell._rowData) && typeof gridOpenTextEditor === 'function') {
          // (dev0350) X (html-teXt) cell → Xe editor, mirroring video → E.
          // _cameFromGrid (set above) makes Xe's Esc return here to G.
          gridOpenTextEditor(cell._rowData.cell || '', cell._rowData);
        } else {
          openBrowseForRow(cell._rowData);
        }
        return;
      }
      
      if (cell._rowData) _lastGridRow = cell._rowData;
      
      // (zip0142) Manual double-tap detection. Calling preventDefault on
      // pointerdown (above) suppresses the browser's synthesized dblclick
      // in many browsers — that's why the dblclick listener below stopped
      // firing for HTML cells in dev mode. We rebuild it here from
      // pointerup timestamps so it works on mouse, touch, and pen alike.
      // Threshold matches the standard 400ms double-click window.
      const nowT = Date.now();
      if (nowT - _lastShortTapT < 400 && !userMode) {
        _lastShortTapT = 0;
        _runDoubleTapAction(cell, cellStr);
        return;
      }
      _lastShortTapT = nowT;
    }
  }, true);
  
  interactor.addEventListener('pointercancel', () => {
    if (_szActive) { _szCancel(); return; }  // (dev0364) abort Shift zoom/pan gesture
    clearTimeout(holdTmr);
    pStart = null; didHold = false; wasCtrl = false; wasLeftBtn = false;
    cell.style.transform = '';
    cell.style.opacity = '';
  }, true);

  // (dev0364) Suppress the right-click menu during a Shift+RMB zoom-out (and any
  // time the gesture is mid-flight) so the ramp isn't interrupted by a context menu.
  interactor.addEventListener('contextmenu', ev => {
    if (ev.shiftKey || _szActive) ev.preventDefault();
  }, true);
  
  // (zip0143) TOUCH FALLBACK for browsers that don't fire pointer events
  // reliably on touch (Opera Mini's compressed mode, some Brave shields
  // configs, older Android WebViews). Pointer events are tried first; if
  // pointerdown actually fires for this gesture, _ptrSawDown becomes
  // true and the touch handlers below bow out so we never double-handle.
  // Both code paths share gesture dispatch via _dispatchGesture().
  let _ptrSawDown = false;
  let _tStart = null;
  
  interactor.addEventListener('pointerdown', () => { _ptrSawDown = true; }, true);
  
  interactor.addEventListener('touchstart', e => {
    if (_ptrSawDown) return;            // pointer events are working — bow out
    if (!e.touches || !e.touches.length) return;
    const t = e.touches[0];
    // (zip0174) Translate physical screen coords to wrap-local coords.
    const _p = window.rotateXY ? window.rotateXY(t) : { x: t.clientX, y: t.clientY };
    _tStart = { x: _p.x, y: _p.y, t: Date.now() };
    e.preventDefault();
  }, { passive: false, capture: true });
  
  interactor.addEventListener('touchmove', e => {
    if (_ptrSawDown || !_tStart) return;
    // Just preventDefault to keep the browser from claiming the gesture
    // for a back-swipe. We don't actually track movement here — the
    // delta is computed at touchend.
    e.preventDefault();
  }, { passive: false, capture: true });
  
  interactor.addEventListener('touchend', e => {
    if (_ptrSawDown) { _ptrSawDown = false; return; }
    if (!_tStart) return;
    // changedTouches has the lifted finger; touches is empty by now.
    const t = (e.changedTouches && e.changedTouches[0]) || null;
    if (!t) { _tStart = null; return; }
    const _p = window.rotateXY ? window.rotateXY(t) : { x: t.clientX, y: t.clientY };
    const dx = _p.x - _tStart.x;
    const dy = _p.y - _tStart.y;
    const ms = Date.now() - _tStart.t;
    _tStart = null;
    e.preventDefault();
    _dispatchGesture(dx, dy, ms, t.clientX, t.clientY);
  }, { passive: false, capture: true });
  
  interactor.addEventListener('touchcancel', () => {
    _tStart = null;
    _ptrSawDown = false;
  }, true);
  
  // (zip0143) Single source of truth for what a touch/pointer gesture
  // does on a cell. Used by the pointer-event path AND the touch
  // fallback. Keeps swipe/tap/double-tap semantics consistent. NOTE:
  // this intentionally does NOT handle hold-to-cut or right-click —
  // those only apply on devices with proper pointer/contextmenu events.
  function _dispatchGesture(dx, dy, ms, endX, endY) {
    // Swipe RIGHT → fullscreen view
    if (dx > 40 && Math.abs(dy) < Math.abs(dx)) {
      if (cell._rowData) {
        _lastGridRow = cell._rowData;
        gridOpenFullscreen(cell._rowData);
      }
      return;
    }
    // Swipe LEFT → (dev0369, Gu only) a swipe that crosses into another cell
    // returns to the Main Page; one that stays inside the cell pauses it. This
    // is the touch-fallback mirror of the overlay-level pointer handler in
    // gridShow(), for browsers that don't fire pointer events on touch.
    if (dx < -40 && Math.abs(dy) < Math.abs(dx)) {
      if (userMode && endX != null) {
        const el = document.elementFromPoint(endX, endY);
        const endCell = (el && el.closest) ? el.closest('.grid-cell') : null;
        if (!endCell || (endCell.dataset && endCell.dataset.cell !== cellStr)) {
          // (dev0384) Same shared return-to-menu path as Esc / the pointer swipe.
          if (typeof window._returnToMenuFromGrid === 'function') window._returnToMenuFromGrid();
          else {
            if (typeof gridCleanupPlayers === 'function') gridCleanupPlayers();
            const ov = document.getElementById('gridOverlay');
            if (ov) ov.style.display = 'none';
            if (typeof _showShareableMenu === 'function') _showShareableMenu();
          }
          return;
        }
      }
      gridTogglePauseCell(cellStr);
      return;
    }
    // Short tap
    if (Math.abs(dx) < 15 && Math.abs(dy) < 15 && ms < 500) {
      if (_gridCutCell && !userMode) {
        if (_gridCutCell === cellStr) { gridClearCut(); toast('Cut cancelled', 800); }
        else                          { gridPaste(cellStr); }
        return;
      }
      if (cell._rowData) _lastGridRow = cell._rowData;
      // Manual double-tap detection (same threshold as pointer path)
      const nowT = Date.now();
      if (nowT - _lastShortTapT < 400 && !userMode) {
        _lastShortTapT = 0;
        _runDoubleTapAction(cell, cellStr);
        return;
      }
      _lastShortTapT = nowT;
    }
  }
  
  // Right-click → show context menu OR Ctrl+right-click → View mode
  interactor.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();

    // (dev0355) Swallow the right-click that just navigated C→G (cMakeActive
    // mounts the grid synchronously inside that same contextmenu); without this
    // the menu would pop on the cell the cursor landed on. Guard is short-lived.
    if (window._cRclickNavGuard && (Date.now() - window._cRclickNavGuard) < 700) {
      window._cRclickNavGuard = 0;
      return;
    }

    // (zip0141) In user mode (Gu): no cut/paste menu. Ctrl+right-click
    // for View mode is still allowed (it's a viewing action, not edit).
    if (userMode) {
      if (e.ctrlKey && cell._rowData) {
        _lastGridRow = cell._rowData;
        gridOpenFullscreen(cell._rowData);
      }
      return;
    }
    
    // Ctrl+right-click = View mode (VP fullscreen)
    if (e.ctrlKey && cell._rowData) {
      _lastGridRow = cell._rowData;
      gridOpenFullscreen(cell._rowData);
      return;
    }
    
    // Plain right-click = context menu
    gridShowContextMenu(e.clientX, e.clientY, cellStr, cell._rowData);
  }, true);
  
  // Double-click on text slide → open large text editor
  // (zip0142) Shared body for the dblclick event listener AND the manual
  // double-tap detector in pointerup. Mirrors the original dblclick
  // semantics exactly:
  //   - quiz/JSON ftext rows  → fullscreen view
  //   - text/HTML ftext rows  → open the text editor
  //   - empty cell            → open the text editor with a fresh row
  function _runDoubleTapAction(cellEl, cellS) {
    if (userMode) return; // dev-only path; user mode never edits from G
    const row = cellEl._rowData;
    if (row) {
      const isQuizRow = !!(row.qfile || (row.ftext && !row.link &&
        (row.ftext.trim().startsWith('[') || row.ftext.trim().startsWith('{'))));
      if (isQuizRow) {
        _lastGridRow = row;
        gridOpenFullscreen(row);
      } else if (row.ftext || row.VidRange === 'text') {
        gridOpenTextEditor(cellS, row);
      }
    } else {
      gridOpenTextEditor(cellS, null);
    }
  }
  
  // Legacy dblclick listener (kept as fallback for browsers that DO
  // dispatch dblclick despite pointerdown.preventDefault — desktop
  // Firefox and a few others). Manual detection in pointerup catches
  // everything else.
  interactor.addEventListener('dblclick', e => {
    e.preventDefault();
    e.stopPropagation();
    _runDoubleTapAction(cell, cellStr);
  }, true);
}

// ══════════════════════════════════════════════════════════════════════════════
// GRID CONTEXT MENU
// ══════════════════════════════════════════════════════════════════════════════
let _gridContextMenu = null;

function gridShowContextMenu(x, y, cellStr, row) {
  gridHideContextMenu();
  
  _gridContextMenu = document.createElement('div');
  _gridContextMenu.id = 'gridContextMenu';
  _gridContextMenu.style.cssText = `
    position:fixed; left:${x}px; top:${y}px; z-index:30000;
    background:#1a1a2e; border:1px solid #444; border-radius:6px;
    padding:4px 0; min-width:160px; box-shadow:0 4px 12px rgba(0,0,0,0.5);
  `;
  
  // Text slide option
  const textBtn = document.createElement('div');
  textBtn.innerHTML = '<u>T</u>ext slide';
  textBtn.style.cssText = 'padding:8px 16px; color:#ff8; cursor:pointer; font-size:13px;';
  textBtn.onmouseenter = () => textBtn.style.background = '#2a2a4e';
  textBtn.onmouseleave = () => textBtn.style.background = '';
  textBtn.onclick = () => {
    gridOpenTextEditor(cellStr, row);
    gridHideContextMenu();
  };
  _gridContextMenu.appendChild(textBtn);

  // Quiz file option — set qfile field on this row
  const quizBtn = document.createElement('div');
  quizBtn.innerHTML = '📋 <u>Q</u>uiz file…';
  quizBtn.style.cssText = 'padding:8px 16px; color:#8f8; cursor:pointer; font-size:13px;';
  quizBtn.onmouseenter = () => quizBtn.style.background = '#1a2e1a';
  quizBtn.onmouseleave = () => quizBtn.style.background = '';
  quizBtn.onclick = () => {
    gridHideContextMenu();
    const current = row ? (row.qfile || '') : '';
    const fname = prompt('Quiz / HTML filename (in project folder):\ne.g. caprellid.html', current);
    if (fname === null) return; // cancelled
    // Find or create a row for this cell
    let targetRow = row;
    if (!targetRow) {
      // Create a minimal row for this cell
      let maxUID = 0;
      data.forEach(r => { const n = parseInt(r.UID||'0',10); if(n>maxUID) maxUID=n; });
      targetRow = { UID: String(maxUID+1), cell: cellStr, VidRange:'text', qfile:'', n1:'' };
      data.push(targetRow);
    }
    targetRow.qfile = fname.trim();
    if (!targetRow.n1) targetRow.n1 = fname.replace(/\.[^.]+$/, ''); // use filename as n1
    targetRow.DateModified = isoNow();
    save();
    gridShow();
    toast(fname.trim() ? '✓ Quiz file set: ' + fname.trim() : '✓ Quiz file cleared', 1500);
  };
  _gridContextMenu.appendChild(quizBtn);
  
  // View option (if has content)
  if (row) {
    const viewBtn = document.createElement('div');
    viewBtn.innerHTML = '<u>V</u>iew';
    viewBtn.style.cssText = 'padding:8px 16px; color:#8ef; cursor:pointer; font-size:13px;';
    viewBtn.onmouseenter = () => viewBtn.style.background = '#2a2a4e';
    viewBtn.onmouseleave = () => viewBtn.style.background = '';
    viewBtn.onclick = () => {
      _lastGridRow = row;
      gridOpenFullscreen(row);
      gridHideContextMenu();
    };
    _gridContextMenu.appendChild(viewBtn);
  }

  // (dev0413 / dev0416) Play steps — replay the saved frame-step window
  // (rate x, start s, duration d from row.steps). Routed by link type:
  // Vimeo/direct step in the cell; YouTube opens V, plays in at normal speed
  // from 4s before s, then drops the fsc at s. Always shown; no steps → no-op.
  const stepsBtn = document.createElement('div');
  stepsBtn.innerHTML = '<u>P</u>lay steps';
  stepsBtn.style.cssText = 'padding:8px 16px; color:#8ef; cursor:pointer; font-size:13px;';
  stepsBtn.onmouseenter = () => stepsBtn.style.background = '#2a2a4e';
  stepsBtn.onmouseleave = () => stepsBtn.style.background = '';
  stepsBtn.onclick = () => {
    if (window._gridPlayStepsRoute) window._gridPlayStepsRoute(cellStr, row);
    gridHideContextMenu();                     // no steps → silent no-op
  };
  _gridContextMenu.appendChild(stepsBtn);

  // Delete option
  const deleteBtn = document.createElement('div');
  deleteBtn.innerHTML = '<u>D</u>elete cell';
  deleteBtn.style.cssText = 'padding:8px 16px; color:#f88; cursor:pointer; font-size:13px;';
  deleteBtn.onmouseenter = () => deleteBtn.style.background = '#2a2a4e';
  deleteBtn.onmouseleave = () => deleteBtn.style.background = '';
  deleteBtn.onclick = () => {
    gridDeleteCell(cellStr);
    gridHideContextMenu();
  };
  _gridContextMenu.appendChild(deleteBtn);

  // Separator
  const sep = document.createElement('div');
  sep.style.cssText = 'height:1px; background:#333; margin:4px 0;';
  _gridContextMenu.appendChild(sep);

  // Write to T option
  const writeBtn = document.createElement('div');
  writeBtn.innerHTML = '<u>W</u>rite to T';
  writeBtn.style.cssText = 'padding:8px 16px; color:#fc8; cursor:pointer; font-size:13px;';
  writeBtn.onmouseenter = () => writeBtn.style.background = '#2e2a1a';
  writeBtn.onmouseleave = () => writeBtn.style.background = '';
  writeBtn.onclick = () => { gridWriteToT(); };
  _gridContextMenu.appendChild(writeBtn);

  document.body.appendChild(_gridContextMenu);
  
  // Handle keyboard shortcuts
  const handleKey = e => {
    if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      gridOpenTextEditor(cellStr, row);
      gridHideContextMenu();
    } else if (e.key === 'q' || e.key === 'Q') {
      e.preventDefault();
      quizBtn.onclick();
    } else if (e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      gridDeleteCell(cellStr);
      gridHideContextMenu();
    } else if ((e.key === 'v' || e.key === 'V') && row) {
      e.preventDefault();
      _lastGridRow = row;
      gridOpenFullscreen(row);
      gridHideContextMenu();
    } else if (e.key === 'p' || e.key === 'P') {
      e.preventDefault();
      if (window._gridPlayStepsRoute) window._gridPlayStepsRoute(cellStr, row);   // route by link type
      gridHideContextMenu();                   // no steps → silent no-op
    } else if (e.key === 'w' || e.key === 'W') {
      e.preventDefault();
      gridWriteToT();
    } else if (e.key === 'Escape') {
      gridHideContextMenu();
    }
  };
  document.addEventListener('keydown', handleKey, true);
  _gridContextMenu._keyHandler = handleKey;
  
  // Click outside to close
  setTimeout(() => {
    document.addEventListener('click', gridHideContextMenu, { once: true });
  }, 10);
}

function gridHideContextMenu() {
  if (_gridContextMenu) {
    if (_gridContextMenu._keyHandler) {
      document.removeEventListener('keydown', _gridContextMenu._keyHandler, true);
    }
    _gridContextMenu.remove();
    _gridContextMenu = null;
  }
}

function gridDeleteCell(cellStr) {
  const row = getRowByCell(cellStr);
  if (!row) {
    toast('Cell ' + cellStr + ' is empty', 800);
    return;
  }

  // Clear the cell value
  row.cell = '';
  row.DateModified = isoNow();
  save();

  // Update visual immediately
  gridUpdateCell(cellStr, null);
  toast('🗑 Deleted ' + cellStr, 1000);
}

function gridWriteToT() {
  // Snapshot which row currently occupies each grid slot BEFORE clearing —
  // in T-source mode getRowByCellForGrid() resolves rows BY r.cell, so we must
  // resolve every slot first or clearing erases the lookup (dev0353 bug:
  // cleared first → loop found nothing → all cells wiped).
  const assignments = []; // { row, cellStr }
  for (let r = 1; r <= _gridGsize; r++) {
    for (let c = 1; c <= _gridGsize; c++) {
      const cellStr = mkGridCell(r, c);
      const row = getRowByCellForGrid(cellStr);
      if (row) assignments.push({ row, cellStr });
    }
  }
  // Clear all existing T cell assignments, then stamp the snapshot back in.
  const now = isoNow();
  data.forEach(r => { r.cell = ''; });
  assignments.forEach(({ row, cellStr }) => { row.cell = cellStr; row.DateModified = now; });
  save();
  // Navigate to T
  gridCleanupPlayers();
  gridClearCut();
  gridHideContextMenu();
  document.getElementById('gridOverlay').style.display = 'none';
  window._cameFromGrid = false;
  buildTable();
  toast('✓ Written to T', 1400);
}
