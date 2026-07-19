
// ══════════════════════════════════════════════════════════════════════════════
// GRID VIEW
// ══════════════════════════════════════════════════════════════════════════════

// (dev0502) Columns widened to 9 so portrait grids can address a..i (P27 = 3×9).
// Square grids still only ever generate a..e — the extra letters are inert there.
const GRID_ROWS = 5, GRID_COLS = 9;
const GRID_LETTERS = 'abcdefghi';

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
  // (dev0502) Portrait layouts use a true rows×cols rectangle (not the square
  // gsize footprint) so the 9:16 cells tile the 16:9 screen edge to edge.
  const pd = (typeof _gridCurrentLayout === 'function') ? _gridPortraitDims(_gridCurrentLayout()) : null;
  if (pd) {
    c.style.gridTemplateRows    = 'repeat(' + pd.rows + ',1fr)';
    c.style.gridTemplateColumns = 'repeat(' + pd.cols + ',1fr)';
    return;
  }
  c.style.gridTemplateRows    = 'repeat(' + _gridGsize + ',1fr)';
  c.style.gridTemplateColumns = 'repeat(' + _gridGsize + ',1fr)';
}

// Set the active grid size (clamped 2-5), persist to ml.json meta, redraw.
// Called from the number-key handler (2/3/4/5) and during C-config activation.
function _setGridGsize(n, opts) {
  n = parseInt(n, 10);
  if (!(n >= 2 && n <= 5)) return;
  // (dev0502) Choosing a square size always exits a T-source portrait layout
  // (P3/P12/P27). Detect it first so we still force a full re-render even when
  // the target size equals the current gsize (otherwise the early-out below
  // would skip the redraw and the portrait grid would stay on screen).
  const wasPortrait = !!(metaRow && metaRow._salLayout && metaRow._salLayout !== 'square');
  if (wasPortrait) metaRow._salLayout = 'square';
  if (n === _gridGsize && !wasPortrait && !(opts && opts.force)) {
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
// ── (dev0502) Portrait grids for YouTube Shorts ─────────────────────────────
// 9:16 cells tiled on a 16:9 1080p screen. The math: to fit a 9:16 cell in a
// 16:9 frame you want columns/rows = (16/9)² ≈ 3.16, i.e. ~3 columns per row.
// Rounding 3.16·rows to whole columns gives the three usable sizes:
//   P3  = 1×3  (1a-1c)        P12 = 2×6  (1a-1f, 2a-2f)
//   P27 = 3×9  (1a-1i .. 3a-3i)
// (4 rows → 13 cols = 52 cells was dropped: cells too small to embed a short.)
// A portrait grid is just another LAYOUT, keyed off the active config's `cells`
// value (3/12/27) for C-source, or meta._salLayout for a T-source Mark-Grid run.
// Cells are addressed with the normal 1a/2f scheme in left-to-right, top-to-
// bottom reading order, so swap/zoom/COI/cut all work unchanged.
const PORTRAIT_LAYOUTS = { 3: { rows: 1, cols: 3 }, 12: { rows: 2, cols: 6 }, 27: { rows: 3, cols: 9 } };

// {rows,cols} for a portrait layout token ('P3'|'P12'|'P27'), else null. Accepts
// either the 'P##' token or the bare cell-count number (3/12/27).
function _gridPortraitDims(layout) {
  if (typeof layout === 'string' && layout.charAt(0) === 'P') layout = layout.slice(1);
  return PORTRAIT_LAYOUTS[parseInt(layout, 10)] || null;
}
// Total cells a layout renders (square → gsize²; specials → their fixed count).
function _gridLayoutCount(layout, gsize) {
  if (layout === '17') return 17;
  if (layout === '19') return 19;
  const pd = _gridPortraitDims(layout);
  if (pd) return pd.rows * pd.cols;
  return gsize * gsize;
}
// Short human label for the grid-info bar / C status line.
function _gridLayoutLabel(layout, gsize) {
  if (layout === 'square') return gsize + '×' + gsize;
  const pd = _gridPortraitDims(layout);
  if (pd) return '▯ ' + pd.rows + '×' + pd.cols + ' portrait';
  return 'layout ' + layout;
}

// (dev0502) Derive a saved config's {layout, gsize} from its `cells` value. The
// gsize is the square footprint (5 for the specials/portrait, which ignore it).
function _gridConfigLayout(cfg) {
  const cn = parseInt(cfg && cfg.cells, 10);
  if (cn === 17) return { layout: '17', gsize: 5 };
  if (cn === 19) return { layout: '19', gsize: 5 };
  if (PORTRAIT_LAYOUTS[cn]) return { layout: 'P' + cn, gsize: 5 };
  if (cn === 4)  return { layout: 'square', gsize: 2 };
  if (cn === 9)  return { layout: 'square', gsize: 3 };
  if (cn === 16) return { layout: 'square', gsize: 4 };
  return { layout: 'square', gsize: 5 };   // 25 + older entries without `cells`
}
// (dev0502) Shared C-activation: clear every row.cell, then mirror the config's
// cell→UID map onto row.cell for the layout's cell list (square/17/19/portrait).
// Returns the {layout, gsize}. Used by cMakeActive and the mobile config picker.
function _gridApplyConfigToRows(cfg, rows) {
  const info = _gridConfigLayout(cfg);
  rows.forEach(r => { if (r && r.cell) r.cell = ''; });
  for (const spec of _gridCellList(info.gsize, info.layout)) {
    const uid = (typeof _gridParseCellVal === 'function')
      ? _gridParseCellVal(cfg[spec.cs]).uid
      : (cfg[spec.cs] ? String(cfg[spec.cs]) : '');
    if (uid) { const row = rows.find(d => String(d.UID) === uid); if (row) row.cell = spec.cs; }
  }
  return info;
}

function _gridCurrentLayout() {
  if (_gridSource === 'C' && _gridActiveConfig) {
    const cn = parseInt(_gridActiveConfig.cells, 10);
    if (cn === 17) return '17';
    if (cn === 19) return '19';
    if (PORTRAIT_LAYOUTS[cn]) return 'P' + cn;
  }
  // (dev0502) T-source portrait grids (3/12/27) park their layout token in meta.
  // Square Mark-Grid runs and every _setGridGsize reset it to 'square', so a stale
  // portrait layout never lingers under a later square grid.
  if (_gridSource === 'T' && typeof metaRow !== 'undefined' && metaRow
      && metaRow._salLayout && metaRow._salLayout !== 'square') {
    return metaRow._salLayout;
  }
  return 'square';
}

// True for any c.json key that addresses a grid cell — the standard 1a..5e plus
// the special 1L / 1P / 2P / 3P. The per-cell zoom scanners use this so zooms
// stored on the big/portrait cells ("UID/zoom") restore like every other cell.
function _isGridConfigCellKey(k) {
  // (dev0502) Columns now run a..i so portrait cells (1f..3i) count as cell keys.
  return /^[1-9][a-i]$/.test(k) || k === '1L' || /^[123]P$/.test(k);
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
  // (dev0502) Portrait grids: a plain rows×cols block (cols can exceed 5), each
  // cell explicitly placed so gridShow lines them up against the rect template.
  const pd = _gridPortraitDims(layout);
  if (pd) {
    for (let r = 1; r <= pd.rows; r++)
      for (let c = 1; c <= pd.cols; c++)
        out.push({ cs: mkGridCell(r, c), r: r, c: c, rs: 1, cls: 1 });
    return out;
  }
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
  gridStepFramesOff();   // (dev0564) leaving/rebuilding the grid exits step-frame mode
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
  const NAT_W = 326, NAT_H = 620, HEADER = 54;
  // (dev0541) Natural-px height of the embed's picture: it runs from just under
  // the header down to HEADER + MEDIA_H, and below that is the like/caption
  // footer. Bounds the COI pan so it can slide to the picture bottom but not
  // into the caption, and (dev0608) sets the height cover-fit fills.
  //
  // (dev0608) MEASURED, and only approximately true: a reel's media box comes
  // out at exactly 4:5, but a photo post measured 1.334 (served natural
  // 326×434) — IG does NOT cap embeds at 4:5. So this is an assumption that is
  // right for reels, under-estimates taller posts (harmless: cover-fit just
  // crops a little more), and OVER-estimates squarer ones — a square or
  // landscape post in a very tall cell can still leak caption below the
  // picture. The real aspect cannot be sensed at runtime: the embed is
  // cross-origin, and its MEASURE postMessage reports height:0. Fixing the
  // remainder needs the post's true og:image dimensions fetched at enrich time
  // (the /p/ OG-tag scrape already reads them) and stored on the row for this
  // function to read — the "more IG information" build, deliberately deferred.
  const MEDIA_H = Math.round(NAT_W * 5 / 4);
  function fit() {
    if (!cellEl.isConnected) return;
    const cw = cellEl.clientWidth, ch = cellEl.clientHeight;
    if (!cw) return;
    // (dev0608) COVER-fit, was width-fit. Pinning scale to cw/NAT_W meant any
    // cell TALLER than 1.25×its width ran out of picture and filled the
    // remainder with IG's caption — in a 12P/portrait grid that was ~30% of
    // every cell as text. Taking the larger of the two ratios keeps the picture
    // covering the cell and pushes the caption out of view, at the cost of
    // cropping the sides (4:5 media in a 9:16 cell loses ~21% per side). Cells
    // at or below 1.25 aspect — every landscape/square grid — still take the
    // width ratio and render exactly as before. Mirrors dev0502's cover-fit for
    // images in portrait grids.
    const scale = Math.max(cw / NAT_W, ch / MEDIA_H);
    // (dev0541) Vertical pan from the row's COI fy. A short landscape cell only
    // shows a thin top strip of the scaled IG picture, hiding a subject in its
    // lower half. fy=0 keeps the old top-aligned crop; higher fy slides the
    // visible window down toward the picture bottom. Alt-click lower on the
    // cell to reveal lower content (COI is now allowed on IG cells — gridSetCOI).
    const coi = _gridCOIForCell(cellEl);
    const fy = coi ? coi.fy : 0;
    const winNat = ch ? (ch / scale) : MEDIA_H;
    const panNat = fy * Math.max(0, MEDIA_H - winNat);
    // (dev0608) Horizontal pan, newly meaningful: width-fit left no horizontal
    // overflow, so fx did nothing and left was always 0. Cover-fit crops the
    // sides, so honour fx the same way fy works (0=left, 1=right) and CENTRE by
    // default — fx's 0 default would otherwise hard-left-align every cell.
    const fx = coi ? coi.fx : 0.5;
    const winNatW = scale ? (cw / scale) : NAT_W;
    const panNatX = fx * Math.max(0, NAT_W - winNatW);
    iframe.style.transform = 'scale(' + scale + ')';
    iframe.style.left = (-panNatX * scale) + 'px';
    iframe.style.top = (-(HEADER + panNat) * scale) + 'px';
  }
  iframe._igFit = fit;   // (dev0541) let gridSetCOI re-run the fit after a COI change
  requestAnimationFrame(fit);
  setTimeout(fit, 50);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(fit).observe(cellEl);
  }
}

// ── Embed cell arming (dev0604 IG · dev0606 TikTok) ─────────────────────────
// An IG or TikTok embed is a cross-origin iframe: its play button only responds
// to a real click landing INSIDE the frame, and nothing can drive it from out
// here (same wall as V — see _vpWireEmbedGestures). But .grid-interactor (z:100)
// owns every cell click, so the caret was unclickable. Rather than surrender the
// cell's gestures (swipe→V, alt-click COI per dev0541, cut/paste), an embed cell
// is ARMED by a first plain click: the interactor goes inert, the embed takes
// pointer events, and the NEXT click reaches the caret. Moving off disarms.
// Sizing was never the obstacle for IG — fitGridIgFrame keeps the iframe at its
// natural 326×620 and only CSS-scales it, so IG believes it's full-size (cf.
// the YT tile spinner) and clicks map correctly through the transform. TikTok's
// iframe is sized to the cell instead, so on a small cell its player may balk at
// the tile the way YT does; if so, the fix is IG's natural-size + scale trick.
//
// MOUSE ONLY, deliberately: disarm hangs on mouseleave, which touch never
// fires, so a tap would strand the cell inert with no way back to V. Touch
// keeps its gestures and plays in V. Repeats are impossible either way (no JS
// API), so this buys exactly one play per click — which is all either allows.
//
// Both providers are tagged .grid-embed-wrap on the element wrapping their
// iframe: IG at its two build sites (gridShow / gridUpdateCell), TikTok on the
// vidHost in _gridMountVideo, since it rides the normal video branch.
let _gridEmbedArmed = null;   // { cell, onLeave } — at most one armed cell

function _gridIsEmbedCell(cellEl) {
  const row = cellEl && cellEl._rowData;
  if (!row || !row.link || !cellEl.querySelector('.grid-embed-wrap')) return false;
  return !!((window.isInstagramLink && window.isInstagramLink(row.link))
    || (window.isTikTokLink && window.isTikTokLink(row.link)));
}

function _gridEmbedDisarm() {
  const st = _gridEmbedArmed;
  if (!st) return;
  _gridEmbedArmed = null;
  try { st.cell.removeEventListener('mouseleave', st.onLeave); } catch (_) {}
  try { window.removeEventListener('blur', st.onBlur); } catch (_) {}
  if (!st.cell.isConnected) return;   // grid re-rendered under us
  const wrap  = st.cell.querySelector('.grid-embed-wrap');
  const frame = wrap && wrap.querySelector('iframe');
  const inter = st.cell.querySelector('.grid-interactor');
  if (wrap)  wrap.style.pointerEvents  = 'none';
  if (frame) frame.style.pointerEvents = 'none';
  if (inter) inter.style.pointerEvents = '';
  const badge = st.cell.querySelector('.grid-embed-armed');
  if (badge) badge.remove();
}

function _gridEmbedArm(cellEl) {
  if (_gridEmbedArmed && _gridEmbedArmed.cell === cellEl) return;   // already armed
  _gridEmbedDisarm();                                               // one at a time
  const wrap  = cellEl.querySelector('.grid-embed-wrap');
  const frame = wrap && wrap.querySelector('iframe');
  const inter = cellEl.querySelector('.grid-interactor');
  if (!wrap || !frame || !inter) return;
  wrap.style.pointerEvents  = 'auto';
  frame.style.pointerEvents = 'auto';
  inter.style.pointerEvents = 'none';
  // Badge sits above the dead interactor and stays pointer-events:none, so the
  // click still falls through to the embed. Provider colours match V's
  // "Open on …" button so an armed cell reads as the same thing in both screens.
  const link = (cellEl._rowData && cellEl._rowData.link) || '';
  const isTT = !!(window.isTikTokLink && window.isTikTokLink(link));
  const badge = document.createElement('div');
  badge.className = 'grid-embed-armed';
  badge.textContent = '▶ play';
  badge.style.cssText = 'position:absolute;left:4px;top:4px;z-index:101;pointer-events:none;'
    + 'font:bold 9px monospace;color:#fff;padding:2px 5px;border-radius:3px;'
    + 'background:' + (isTT
        ? 'linear-gradient(135deg,#25F4EE 0%,#000 50%,#FE2C55 100%)'
        : 'linear-gradient(135deg,#833ab4 0%,#fd1d1d 50%,#fcb045 100%)') + ';'
    + 'text-shadow:0 1px 2px rgba(0,0,0,0.4);';
  cellEl.appendChild(badge);
  const onLeave = () => _gridEmbedDisarm();
  cellEl.addEventListener('mouseleave', onLeave);

  // (dev0607) The click that starts the embed also moves KEYBOARD focus into
  // its document, and from then on every global hotkey — T above all — is
  // delivered there instead of here. Cross-origin, so we can neither read those
  // keys nor ask for them back: the only move is to not leave focus there.
  // Blur fires after the click has already reached the embed, so taking focus
  // straight back costs the embed nothing (clicks never needed focus, and there
  // is no JS API whose keyboard we'd want). Net: the cell plays AND T still
  // works with the pointer sitting on it.
  const onBlur = () => setTimeout(() => {
    if (document.activeElement !== frame) return;   // focus went elsewhere — not ours to take
    try { frame.blur(); } catch (_) {}
    // Only re-focus while the window is still ours; if the user alt-tabbed away
    // mid-play, window.focus() would try to raise the browser at them.
    if (document.hasFocus()) { try { window.focus(); } catch (_) {} }
  }, 0);
  window.addEventListener('blur', onBlur);

  _gridEmbedArmed = { cell: cellEl, onLeave: onLeave, onBlur: onBlur };
}

function fitGridHtmlThumb(cellEl, wrapEl, innerEl) {
  const VIRT_W = 600;
  // (dev0588) The sectioned 1a text cell mutates innerEl (section switch,
  // details toggle) and needs to re-measure — park the fit closure on the cell.
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
  cellEl._htmlThumbFit = fit;
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

// ── (dev0588) Sectioned text slide in cell 1a ───────────────────────────────
// A text slide (ltype 't' / VidRange 'text') sitting on grid cell 1a renders
// in SECTIONS: the ftext splits at each top-level <hr> and only the current
// section shows — the portion above the first separator at start — with every
// <details> collapsed. Interactions (both modes; arrows arrive from core.js's
// window-capture dispatcher via window._gridSectionKey):
//   tap a summary line → toggle that one collapsible open/closed
//   → / ←              → next / previous section
//   ↓ / ↑              → expand / collapse every collapsible in the section
// Every other cell keeps the whole-document thumbnail.
// (dev0617) Shared top-level-<hr> section splitter. Takes rendered ftext HTML,
// returns an array of section-HTML strings (always ≥1). Used by the 1a grid
// cell below, the fullscreen text viewer (vp.js) and the Xs slide preview
// (xe.js) so all three break pages at exactly the same separators.
window._salSplitSections = function (html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  // A slide saved with a .te-slide color wrapper keeps that wrapper on each
  // section, so the bg/text colors survive the split (and
  // _gridThumbApplySlideColors still finds it).
  let host = tmp, slideWrap = null;
  const only = tmp.children.length === 1 ? tmp.children[0] : null;
  if (only && only.classList && only.classList.contains('te-slide')) { host = only; slideWrap = only; }
  // (dev0593) Hoist any section-divider <hr> that a wrapper swallowed up to a
  // direct child of host, so the top-level split below still sees it. A
  // select-all delete in Xe can leave a stray <h1>/<div> that later absorbs the
  // ══ divider (<h1><div><hr></div></h1>); without this the divider is invisible
  // to the splitter and the whole slide collapses into one section. Skip <hr>
  // inside <details> (those are in-body rules, not section breaks). Unwrapping
  // an ancestor preserves child order, so content on either side of the divider
  // lands in the correct section.
  host.querySelectorAll('hr').forEach(hr => {
    if (hr.closest('details')) return;
    let guard = 0;
    while (hr.parentNode && hr.parentNode !== host && guard++ < 30) {
      const p = hr.parentNode, pp = p.parentNode;
      while (p.firstChild) pp.insertBefore(p.firstChild, p);
      pp.removeChild(p);
    }
  });
  const sections = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    const box = document.createElement('div');
    cur.forEach(n => box.appendChild(n));
    if (!box.textContent.trim() && !box.querySelector('img,video,details,table')) { cur = []; return; }
    if (slideWrap) {
      const w = slideWrap.cloneNode(false);
      w.innerHTML = box.innerHTML;
      sections.push(w.outerHTML);
    } else {
      sections.push(box.innerHTML);
    }
    cur = [];
  };
  Array.from(host.childNodes).forEach(n => {
    if (n.nodeType === 1 && n.tagName === 'HR') flush();
    else cur.push(n);
  });
  flush();
  if (!sections.length) sections.push(html);
  return sections;
};

// (dev0624→dev0636) A section whose ENTIRE content is a bare cell designation
// ("1a"…"5e", "1L", "1P"…"3P") or "G" is a *pointer page*: viewers show that
// cell's row (or the whole grid) instead of the literal letters. This matcher
// was born inside Xs (xe.js dev0624); it moved here so the V fullscreen text
// viewer (vp.js) — the path slam.com/Gu visitors actually take — applies the
// SAME rule and the two contexts can't diverge again. Returns 'G', a canonical
// cell string ("1b", "1L"), or null.
window._salSectCellSpec = function (sectHtml) {
  const tmp = document.createElement('div');
  tmp.innerHTML = sectHtml || '';
  if (tmp.querySelector('img,video,iframe,hr,table')) return null; // media = not a bare designation
  const t = (tmp.textContent || '').replace(/[ ​]/g, ' ').trim();
  if (/^g$/i.test(t)) return 'G';
  if (t.length === 2 && /[1-9]/.test(t[0]) && /[a-iPL]/i.test(t[1])) {
    const c2 = t[1];
    return t[0] + (/[pl]/i.test(c2) ? c2.toUpperCase() : c2.toLowerCase());
  }
  return null;
};

function _gridSectionSetup(cell, wrap, inner, row) {
  const html = (typeof renderFtext === 'function') ? renderFtext(row.ftext) : (row.ftext || '');
  const sections = window._salSplitSections(html);
  // (dev0643) Resume on the section the viewer last left — leaving the 1a cell
  // for ANY reason (into V, out to the menu, a config switch, a grid rebuild)
  // used to snap it back to section 0. Remember the last index per row UID (the
  // fullscreen reader writes the same map, so paging there is honored too).
  window._salSectIdxByUid = window._salSectIdxByUid || {};
  let startIdx = window._salSectIdxByUid[row.UID] || 0;
  if (!(startIdx >= 0 && startIdx < sections.length)) startIdx = 0;
  cell._salSect = { list: sections, idx: startIdx, inner: inner, uid: row.UID };
  // Re-fit whenever a collapsible toggles ('toggle' doesn't bubble — capture).
  inner.addEventListener('toggle', () => { if (cell._htmlThumbFit) cell._htmlThumbFit(); }, true);
  _gridSectionRender(cell);
}

function _gridSectionRender(cell) {
  const s = cell._salSect;
  if (!s) return;
  s.inner.innerHTML = s.list[s.idx] || '';
  // Start collapsed — a tap on the summary (or ↓) reveals the hidden body.
  s.inner.querySelectorAll('details[open]').forEach(d => d.removeAttribute('open'));
  // (dev0643) Persist the current section so a later rebuild resumes here.
  if (s.uid != null) {
    window._salSectIdxByUid = window._salSectIdxByUid || {};
    window._salSectIdxByUid[s.uid] = s.idx;
  }
  if (cell._htmlThumbFit) requestAnimationFrame(cell._htmlThumbFit);
}

// Which <summary> sits under viewport point (x,y) in this cell? Cell content
// is pointer-events:none BELOW the interactor, and elementFromPoint skips
// pointer-events:none targets — so momentarily flip both, probe, restore.
function _gridSectionSummaryAt(cell, x, y) {
  const s = cell._salSect;
  if (!s || !s.inner.isConnected) return null;
  const wrap = s.inner.parentNode;
  const inter = cell.querySelector('.grid-interactor');
  const pw = wrap.style.pointerEvents, pi = inter ? inter.style.pointerEvents : '';
  wrap.style.pointerEvents = 'auto';
  if (inter) inter.style.pointerEvents = 'none';
  const el = document.elementFromPoint(x, y);
  wrap.style.pointerEvents = pw || 'none';
  if (inter) inter.style.pointerEvents = pi;
  const sum = (el && el.closest) ? el.closest('summary') : null;
  return (sum && cell.contains(sum)) ? sum : null;
}

function _gridSectionToggleSummary(cell, sum) {
  const d = sum.closest('details');
  if (!d) return;
  if (d.hasAttribute('open')) d.removeAttribute('open');
  else d.setAttribute('open', '');
  if (cell._htmlThumbFit) cell._htmlThumbFit();
}

// Arrow-key section nav for the 1a text slide — called from core.js's
// window-capture dispatcher while G is open. Returns true when consumed;
// false (1a isn't a sectioned text cell) leaves arrows inert as before.
window._gridSectionKey = function (key) {
  const cell = document.querySelector('#gridContainer .grid-cell[data-cell="1a"]');
  if (!cell || !cell._salSect || !cell._salSect.inner.isConnected) return false;
  const s = cell._salSect;
  if (key === 'ArrowRight' || key === 'ArrowLeft') {
    const dir = key === 'ArrowRight' ? 1 : -1;
    const ni = s.idx + dir;
    if (ni < 0 || ni >= s.list.length) {
      _gridToast(dir > 0 ? 'Last section' : 'First section', 900);
      return true;
    }
    s.idx = ni;
    _gridSectionRender(cell);
    if (s.list.length > 1) _gridToast('Section ' + (ni + 1) + '/' + s.list.length, 900);
    return true;
  }
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const open = key === 'ArrowDown';
    s.inner.querySelectorAll('details').forEach(d => {
      if (open) d.setAttribute('open', ''); else d.removeAttribute('open');
    });
    if (cell._htmlThumbFit) cell._htmlThumbFit();
    return true;
  }
  return false;
};

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
    // (dev0609) A link cell holds the media URL itself, not a UID — synthesize
    // (or adopt) a row for it so the rest of the grid can't tell the difference.
    if (pv.link) return _gridLinkCellRow(pv.link, cellStr);
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

// ── Step-frame mode (dev0564/0565, hotkey A on the grid) ─────────────────────
// Toggles every cell whose row has saved `steps` ("x,s,d" from the V step
// panel) to loop its LOCAL step clip (steps/<VidTitle>.<x_s_d>.mp4, stepped
// playback baked in by proxy /frame/grab; freeze = 5s still clip) in a plain
// muted <video> overlay — the only way to show YT frames with ZERO player
// chrome (a paused in-cell YT iframe paints its own centre play button; see
// _gridPlayStepsRoute). If the clip doesn't exist yet (steps saved before
// dev0564, or Save's grab failed), the overlay GRABS IT ON DEMAND through the
// proxy and then plays it — so old rows just work. Overlays sit at z-index:50
// — above the media (z:1), below the interactor (z:100) — so clicks/swipes
// still work, and grid video is ALWAYS muted (zip0152) so the covered player
// can't leak audio. steps/ is gitignored (grabbed YT material stays local,
// never the public site).
let _gridStepFrameMode = false;
const _gridStepGrabbing = {};   // clip name → true while an on-demand grab runs

function gridStepFramesOff() {
  document.querySelectorAll('.grid-step-frame').forEach(el => {
    const v = el.querySelector('video');
    if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {} }
    el.remove();
  });
  _gridStepFrameMode = false;
}

function gridToggleStepFrames() {
  if (_gridStepFrameMode) {
    gridStepFramesOff();
    if (typeof toast === 'function') toast('Step frames off', 1200);
    return;
  }
  // Match the grid's image fit policy (dev0502): portrait grids cover, else contain.
  const fit = _gridPortraitDims(_gridCurrentLayout()) ? 'cover' : 'contain';
  const proxyBase = (typeof PROXY_BASE !== 'undefined') ? PROXY_BASE : 'http://127.0.0.1:8081';
  let n = 0;
  document.querySelectorAll('#gridContainer .grid-cell').forEach(cell => {
    const row = cell._rowData;
    if (!row || !row.steps) return;
    const parts = String(row.steps).split(',');
    const x = parseFloat(parts[0]), s = parseInt(parts[1], 10), d = parseInt(parts[2], 10);
    if (!isFinite(x) || !isFinite(s) || !isFinite(d) || x < 0 || s < 0 || d < 0) return;
    const name = (typeof window.stepClipName === 'function') ? window.stepClipName(row) : '';
    if (!name) return;

    const ov = document.createElement('div');
    ov.className = 'grid-step-frame';
    ov.style.cssText = 'position:absolute;inset:0;background:#000;z-index:50;pointer-events:none;';
    cell.appendChild(ov);
    n++;

    const hint = msg => {
      ov.innerHTML = '<div style="position:absolute;inset:0;display:flex;align-items:center;'
        + 'justify-content:center;text-align:center;color:#fa0;font:bold 12px sans-serif;'
        + 'padding:8px;">' + msg + '</div>';
    };
    const mount = srcUrl => {
      ov.innerHTML = '';
      const vid = document.createElement('video');
      vid.muted = true; vid.autoplay = true; vid.loop = true; vid.playsInline = true;
      vid.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:' + fit + ';';
      vid.onerror = () => onMissing();
      vid.src = srcUrl;
      ov.appendChild(vid);
      vid.play && vid.play().catch(() => {});
    };
    // Clip 404s → grab it on demand (steps saved pre-dev0564, or a re-save
    // whose grab failed). One grab per clip name at a time.
    let attempted = false;
    async function onMissing() {
      if (attempted || _gridStepGrabbing[name]) { hint('Step clip not ready yet'); return; }
      attempted = true;
      if (!/^https?:\/\//i.test(row.link || '')) { hint('No step clip —<br>web videos only'); return; }
      _gridStepGrabbing[name] = true;
      hint('⏳ Grabbing step clip…');
      try {
        const r = await fetch(proxyBase + '/frame/grab', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: row.link, name, x, s, d })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
        if (!ov.isConnected) return;               // mode toggled off meanwhile
        mount('steps/' + encodeURIComponent(name) + '?t=' + Date.now());  // bust the 404
      } catch (e) {
        hint('Step clip failed —<br>' + String(e && e.message ? e.message : e).slice(0, 120)
          + '<br>(proxy on 8081? off VPN?)');
      } finally {
        delete _gridStepGrabbing[name];
      }
    }
    mount('steps/' + encodeURIComponent(name));
  });
  _gridStepFrameMode = n > 0;
  if (typeof toast === 'function')
    toast(n ? ('🖼 Step frames — ' + n + ' cell' + (n === 1 ? '' : 's') + ' (A toggles back)')
            : 'No grid cells have saved steps.', 1800);
}
window.gridToggleStepFrames = gridToggleStepFrames;

// ── Clean-playback buffering (dev0336) ───────────────────────────────────────
// G can play YouTube cells through a desktop-only A/B double-buffer that hides
// YT's seek/re-buffer flash at the segment loop point (see
// mountYouTubeClipBuffered in video.js). Mode is persisted in ml-settings and
// cycled with Ctrl+B: 'off' → 'cut' (instant swap) → 'fade' (crossfade).
function _gridBufferMode() {
  const m = (typeof window.getSetting === 'function') ? window.getSetting('gridBuffer') : null;
  // (dev0636) Default is 'cut' when the setting has never been touched. The
  // setting lives in per-origin localStorage and Ctrl+B is deliberately never
  // exposed to Gu (dev0598), so slam.com visitors ALWAYS fell back to the
  // single-iframe mount and saw YT's center play/pause chrome — localhost only
  // looked "fixed" because the dev browser carried a persisted Ctrl+B choice.
  // An explicit 'off' (cycled via Ctrl+B) is still honored, and eligibility
  // (desktop, ≤4×4) still gates the heavy path — mobile/5×5 grids unchanged.
  if (m === 'cut' || m === 'fade' || m === 'off') return m;
  return 'cut';
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
//
// (dev0637) PROOF-OF-CONCEPT expansion switches — try buffered playback on ANY
// grid size (incl. the 27-cell portrait grid) and on fast phones (S25-class):
//   • URL param  ?buf=1  (or buf=all) — this load only; phone-friendly, just
//     add it to a slam.com deep link. ?buf=0 forces buffering fully OFF
//     (escape hatch if a device melts).
//   • window.gridBufferAll(true|false) / setSetting('gridBufferAll', true) —
//     persists on this browser+origin; no-arg call toggles.
// Default behavior (no param, no setting) is unchanged: desktop && ≤4×4.
// Expect pain at scale: buffered = 2 YT iframes per cell, so 27 cells = 54
// live players — desktop-class GPUs sweat, phones likely cap out around 3×3.
let _gridBufAllCache = null;
function _gridBufferAllState() {
  if (_gridBufAllCache === null) {
    // (dev0638) boot.js's pretty-URL rewrite ERASES the query on the public
    // site before the grid ever mounts, so consult the stash it saves first
    // (window._salBufParam); a live location.search read only works in dev.
    let q = (window._salBufParam !== undefined) ? window._salBufParam : null;
    if (q === null) {
      try { q = new URLSearchParams(window.location.search).get('buf'); } catch (_) {}
    }
    if (q === '1' || q === 'all') _gridBufAllCache = 'all';
    else if (q === '0') _gridBufAllCache = 'none';
    else _gridBufAllCache = ((typeof window.getSetting === 'function')
      && window.getSetting('gridBufferAll') === true) ? 'all' : 'normal';
  }
  return _gridBufAllCache;
}
window.gridBufferAll = function (on) {
  const next = (on === undefined) ? (_gridBufferAllState() !== 'all') : !!on;
  if (typeof window.setSetting === 'function') window.setSetting('gridBufferAll', next);
  _gridBufAllCache = next ? 'all' : 'normal';
  if (typeof toast === 'function') {
    toast('Buffer everywhere: ' + (next ? 'ON — all sizes & devices' : 'OFF — desktop ≤4×4 only'), 1800);
  }
  if (typeof gridShow === 'function'
      && document.getElementById('gridOverlay')?.style.display === 'flex') gridShow();
  return next;
};
function _gridBufferEligible() {
  const st = _gridBufferAllState();
  if (st === 'all')  return true;
  if (st === 'none') return false;
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
  // (dev0609) Keyed via _gridCellKey — a UID normally, the link for a link cell.
  const ck = _gridCellKey(cellEl && cellEl._rowData);
  const indiv = (ck && _gridCellZoom[ck] > 0) ? _gridCellZoom[ck] : 1;
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
  const ck = _gridCellKey(cellEl && cellEl._rowData);   // (dev0609) UID or link
  if (!ck) return null;
  const p = _gridCellPan[ck];
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
  // (dev0581) A blank Shift+T text row (ltype='t') has empty ftext, so treat the
  // ltype as the text-row marker too — otherwise its first double-click / Ctrl+click
  // in G never opens Xe (the ftext-truthy gate below misses it until content exists).
  return row.ltype === 't' || row.VidRange === 'text' || !!(row.ftext && String(row.ftext).trim());
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

// Parse a c.json cell value into { uid, link, zoom }. Two grammars:
//   UID cell  — "204" or "204/1.8" (zoom after a slash). The original form.
//   LINK cell — (dev0609) "https://…" or "https://…|1.8". A cell may hold a
//     direct media URL instead of an ml.json UID, so a grid can be built from
//     links that were never promoted into ml.json (see _gridLinkCellRow).
// The two never collide: a UID is digits, a link starts with a scheme. Links
// use "|" for the zoom suffix because a URL is already full of slashes.
// Exactly one of .uid / .link is ever set. Tolerates blanks/null.
function _gridParseCellVal(v) {
  const s = (v === undefined || v === null) ? '' : String(v).trim();
  if (!s) return { uid: '', link: '', zoom: 1 };
  if (_isLinkCellVal(s)) {
    const li = s.indexOf('|');
    if (li < 0) return { uid: '', link: s, zoom: 1 };
    const lz = parseFloat(s.slice(li + 1));
    return { uid: '', link: s.slice(0, li).trim(), zoom: (isFinite(lz) && lz > 0) ? lz : 1 };
  }
  const i = s.indexOf('/');
  if (i < 0) return { uid: s, link: '', zoom: 1 };
  const z = parseFloat(s.slice(i + 1));
  return { uid: s.slice(0, i).trim(), link: '', zoom: (isFinite(z) && z > 0) ? z : 1 };
}

// (dev0609) True when a raw c.json cell value is a link rather than a UID.
function _isLinkCellVal(v) { return /^https?:\/\//i.test(String(v || '').trim()); }

// (dev0609) Encode a cell value for c.json — the inverse of _gridParseCellVal.
// Links take the "|zoom" suffix, UIDs the "/zoom" one; zoom 1 = bare value.
function _gridMakeCellVal(idOrLink, zoom) {
  const s = String(idOrLink || '').trim();
  if (!s) return '';
  if (!(zoom > 0) || Math.abs(zoom - 1) < 1e-9) return s;
  return s + (_isLinkCellVal(s) ? '|' : '/') + zoom;
}

// (dev0609) The key a row's per-cell zoom/pan is stored under. Normally the
// row's ml.json UID; for a link cell it's the link itself, so the zoom round-
// trips to c.json as "link|zoom". Link-ness is checked FIRST because an
// ADOPTED link cell (a proxy over a real ml row) inherits that row's UID —
// keying it by UID would write the cell back as a UID and lose the link.
function _gridCellKey(row) {
  if (!row) return '';
  if (row._salLinkCell) return row.link || '';
  return (row.UID == null) ? '' : String(row.UID);
}

// (dev0609) Cache of link-cell rows, keyed by link, so repeated renders hand
// back the SAME object — cell._rowData identity, _lastGridRow and the zoom/pan
// dicts all depend on it being stable.
var _gridLinkRowCache = {};

// (dev0610) Identity of a media link, for deciding whether two URLs are the same
// post. IG addresses one post several ways — "/p/<id>/" (canonical, what a share
// link and most ml.json rows carry) and "/<author>/reel/<id>/" (what the
// harvester and the c.json cells it writes carry) — so a plain string compare
// would never adopt an IG cell's real ml.json row, however many times it was
// promoted. The shortcode is the post, so IG links reduce to it. Anything else
// is its own trimmed self.
function _gridLinkIdentity(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  const k = window.getInstagramKind && window.getInstagramKind(s);
  return k ? 'ig:' + k.id : s;
}

// (dev0609) Resolve a link cell to something the grid can render. Every cell
// consumer downstream (gridShow, gridOpenFullscreen/V, the zoom + swipe
// handlers) works off a ROW OBJECT, so a link cell only has to produce one.
//
// If ml.json happens to hold a row with this exact link — e.g. the IG entry was
// promoted after the grid was built — we adopt it via Object.create so ftext,
// tags, VidRange, Mode and the rest come along for free, and the cell silently
// upgrades itself. Otherwise we synthesize a bare row that knows only its link;
// isVideoRow/isInstagramLink read row.link alone, so the IG embed still mounts.
//
// Either way the returned object carries an OWN _salLinkCell flag (an adopted
// prototype never does), which is how the save path knows to write the link
// back instead of a UID.
function _gridLinkCellRow(link, cellStr) {
  link = String(link || '').trim();
  if (!link) return null;
  // (dev0610) Matched on link IDENTITY, not raw string — see _gridLinkIdentity.
  const want = _gridLinkIdentity(link);
  const ml = (typeof data !== 'undefined' && Array.isArray(data))
    ? (data.find(r => r && r.link && _gridLinkIdentity(r.link) === want
        && (r.show === undefined || r.show === '1')) || null)
    : null;
  const hit = _gridLinkRowCache[link];
  // Rebuild when adoption flips — ml.json may not have finished loading on the
  // first render, or the row may have been promoted/deleted since.
  if (hit && hit._salMlSrc === ml) { hit.cell = cellStr || ''; return hit; }
  const row = ml ? Object.create(ml) : {};
  row._salLinkCell = true;
  row._salMlSrc = ml;
  row.link = link;
  row.cell = cellStr || '';
  if (!ml) { row.UID = ''; row.show = '1'; row.VidRange = ''; }
  _gridLinkRowCache[link] = row;
  return row;
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
    // (dev0609) Link cells key their zoom by the link — see _gridCellKey.
    const ck = pv.uid || pv.link;
    if (ck && pv.zoom !== 1) _gridCellZoom[ck] = pv.zoom;
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
  } else if (window.isTikTokLink && window.isTikTokLink(row.link) && window.mountTikTokEmbed) {
    window.mountTikTokEmbed(vidHost, row.link);
    // (dev0606) TikTok rides the normal video branch, so its host is a plain
    // [id^=grid-vid-] div rather than an IG-style wrap — tag it so click-to-arm
    // finds it exactly the way it finds an IG cell. Same cross-origin wall, so
    // the same escape: see _gridEmbedArm.
    vidHost.classList.add('grid-embed-wrap');
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
    const ck = pv.uid || pv.link;     // (dev0609) link cells key by link
    if (ck && pv.zoom !== 1) _gridCellZoom[ck] = pv.zoom;
  });
  _gridZResetArmed = false;
  _gridToast('Per-cell zooms restored from config', 1500);
  _gridRefitAll();
}

// (dev0347) Ctrl+[ / Ctrl+] over a cell (the one under the mouse) nudges just
// THAT cell's zoom — a multiplier on top of the global zoom. Only video/image/
// montage cells are zoomable; stored per row UID so it can persist to c.json
// ("UID/zoom") and restore. Snapped to 0.2; exactly 1.0 clears the per-cell entry.
// (dev0609) A link cell stores its zoom under the link instead ("link|zoom").
function gridAdjustCellZoom(cellEl, delta) {
  _gridZResetArmed = false;   // (dev0350) a per-cell zoom nudge breaks the Z double-reset chain
  if (!cellEl) { if (typeof toast === 'function') toast('Hover a cell, then Ctrl+[ or Ctrl+]', 1200); return; }
  const t = _gridCellZoomTarget(cellEl);
  if (!t) { if (typeof toast === 'function') toast('No per-cell zoom for this cell', 1000); return; }
  const ck = _gridCellKey(cellEl._rowData);
  if (!ck) { if (typeof toast === 'function') toast('Cell needs a UID to store its zoom', 1200); return; }
  const cur = _gridCellZoom[ck] > 0 ? _gridCellZoom[ck] : 1;
  const next = _gridSnapZoom(cur + delta);
  if (Math.abs(next - 1) < 1e-9) delete _gridCellZoom[ck];
  else _gridCellZoom[ck] = next;
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
  // (dev0541) An IG embed isn't a zoom target (cross-origin iframe), but it can
  // still take a COI: its fy vertically pans the clipped embed so a subject in
  // the picture's lower half can be framed in a short cell (see fitGridIgFrame).
  const igFrame = (!tgt && cellEl.querySelector) ? cellEl.querySelector('iframe') : null;
  const isIgCell = !!igFrame && !!(row.link && window.isInstagramLink && window.isInstagramLink(row.link));
  if (!tgt && !isIgCell) { if (typeof toast === 'function') toast('COI only applies to image/video cells', 1400); return; }
  const rect = cellEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const fx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const fy = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
  // zoom: current effective cell zoom (global × per-cell), 1 decimal place.
  const zoom = _gridZoomForCell(cellEl).toFixed(1);
  // frameRef: a video records the current frame (≈ currentTime × 30 fps) so a
  // future autozoom can return to it; non-video cells record "image".
  let frameRef = 'image';
  if (tgt && tgt.kind === 'vid') {
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
  try {
    if (isIgCell && igFrame._igFit) igFrame._igFit();   // (dev0541) re-pan the IG embed
    else _gridApplyZoomToCell(cellEl);
  } catch (_) {}
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
  // (dev0618) ANY explicit slide background paints the whole cell — the old
  // dark-only gate (lum<0.5) left a mid-luminance slide (e.g. blue #4488ff,
  // lum≈0.507) on the paper-white default, so the chosen color "didn't show
  // up on G". Text color: the slide's own explicit color wins (it inherits
  // inside the wrapper anyway; setting inner too covers stray content outside
  // it), else contrast-pick white-on-dark / dark-on-light as before.
  wrap.style.background = bg;
  inner.style.color = slide.style.color || (lum < 0.5 ? '#fff' : '#222');
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
          // (cross-origin). Clicks route through the cell interactor as usual;
          // (dev0604) a plain mouse click ARMS the embed so a second click can
          // reach that caret — see _gridEmbedArm. Swipe right still opens V.
          const igWrap = document.createElement('div');
          igWrap.className = 'grid-embed-wrap';
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
          // (dev0588) Cell 1a renders SECTIONED (split at <hr>, details
          // collapsed, arrow/tap nav); every other cell keeps the full thumb.
          if (cellStr === '1a') _gridSectionSetup(cell, wrap, inner, row);
          else inner.innerHTML = (typeof renderFtext === "function" ? renderFtext(row.ftext) : row.ftext);
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
        } else if (row.link && !isImgLink && hasFtextImgs) {
          _buildFtextImgCell(cell, row);
        } else if (row.link) {
          // (dev0465) Direct image. Extensionless links (e.g. phpBB
          // download/file.php?id=) have no .jpg/.png suffix but are still
          // images — try loading as an <img>, and only fall back to the
          // ftext/label montage cell if it genuinely fails to load.
          const img = document.createElement('img');
          img.className = 'grid-zoom-img';   // (dev0346) wheel-zoom target
          img.src = row.link;
          // (dev0502) Portrait grids cover-fit (fill the cell height, crop the
          // ~5% side overshoot) so a 9:16 short fills its near-9:16 cell with no
          // pillarbars; square/landscape grids keep contain so nothing is cut.
          const _imgFit = _gridPortraitDims(_layout) ? 'cover' : 'contain';
          img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:' + _imgFit + ';pointer-events:none;z-index:1;transform-origin:center center;';
          img.onerror = () => { img.remove(); if (!isImgLink) _buildFtextImgCell(cell, row); };
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
  // (zip0153) Total cells = _gridGsize²; (dev0370/0502) special + portrait layouts
  // report their own fixed count + label via the shared helpers.
  const _total = _gridLayoutCount(_layout, _gridGsize);
  const _sizeLabel = _gridLayoutLabel(_layout, _gridGsize);
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
  // (dev0548) Refresh the dev-only "N need source" backlog pill (bottom-left).
  if (typeof window._gridUpdateBacklogPill === 'function') window._gridUpdateBacklogPill();
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
  cellEl._salSect = null;   // (dev0588) drop stale section state on content swap
  
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
      // rationale on scaling + header clip (and dev0604 click-arming).
      const igWrap = document.createElement('div');
      igWrap.className = 'grid-embed-wrap';
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
      // (dev0588) Cell 1a renders SECTIONED — same as gridShow's branch.
      if (cellStr === '1a') _gridSectionSetup(cellEl, wrap, inner, row);
      else inner.innerHTML = (typeof renderFtext === "function" ? renderFtext(row.ftext) : row.ftext);
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
    } else if (row.link && !isImgLink && hasFtextImgs) {
      _buildFtextImgCell(cellEl, row);
    } else if (row.link) {
      // Image cell — (dev0465) also covers extensionless image links
      // (e.g. phpBB download/file.php?id=); fall back to the ftext/label
      // montage cell only if the image genuinely fails to load.
      const img = document.createElement('img');
      img.className = 'grid-zoom-img';   // (dev0346) wheel-zoom target
      img.src = row.link;
      img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;z-index:1;transform-origin:center center;';
      img.onerror = () => { img.remove(); if (!isImgLink) _buildFtextImgCell(cellEl, row); };
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
  // (dev0609) Zoom/pan store key — the row's UID, or its link for a link cell.
  const _szKey = () => _gridCellKey(cell._rowData);
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
    const ck = _szKey();
    if (!ck) return;
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
        const cur = _gridCellZoom[ck] > 0 ? _gridCellZoom[ck] : 1;
        let next = cur + dir * _szStep;
        // Floor the EFFECTIVE zoom (global × per-cell) at the grid minimum.
        const g = _gridFillZoom();
        if (g * next < _GRID_ZOOM_MIN) next = _GRID_ZOOM_MIN / g;
        _gridCellZoom[ck] = next;
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
      const ck = _szKey();
      const b = (_gridCellPan[ck] && typeof _gridCellPan[ck].x === 'number')
        ? _gridCellPan[ck] : { x: 0, y: 0 };
      _szPanBase = { x: b.x, y: b.y, px: e.clientX, py: e.clientY };
      interactor.style.cursor = 'grabbing';
    }
    if (_szDragging && _gridZoomForCell(cell) > 1.05) {
      const ck = _szKey();
      _gridCellPan[ck] = {
        x: _szPanBase.x + (e.clientX - _szPanBase.px),
        y: _szPanBase.y + (e.clientY - _szPanBase.py)
      };
      _gridApplyZoomToCell(cell);
    }
  }
  function _szEnd(e) {
    _szStop();
    const ck = _szKey();
    if (ck && _gridCellZoom[ck] > 0) {
      const snapped = _gridSnapZoom(_gridCellZoom[ck]);
      if (Math.abs(snapped - 1) < 1e-9) delete _gridCellZoom[ck];
      else _gridCellZoom[ck] = snapped;
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
    
    // Swipe RIGHT → VP / fullscreen image. (dev0587) In dev mode a forward-swipe
    // on a text cell opens the Xe editor instead — same routing as double-click
    // (_runDoubleTapAction sends quiz→fullscreen, text→editor). Video/image/IG
    // rows are not text rows, so they still go fullscreen.
    if (dx > 40 && Math.abs(dy) < Math.abs(dx)) {
      if (cell._rowData) {
        _lastGridRow = cell._rowData;
        if (!userMode && _gridIsTextRow(cell._rowData)) _runDoubleTapAction(cell, cellStr);
        else {
          // (dev0617) Sectioned 1a text cell → fullscreen viewer opens on the
          // SAME section the cell was showing (vp.js reads + clears the hint).
          window._vpSectStart = cell._salSect ? cell._salSect.idx : 0;
          gridOpenFullscreen(cell._rowData);
        }
      }
      return;
    }

    // Swipe LEFT → (dev0643) on the sectioned 1a text slide, advance to the
    // NEXT section (there is no video to pause on a text cell); swipe RIGHT
    // above still opens the fullscreen reader. Every other cell pauses/plays.
    if (dx < -40 && Math.abs(dy) < Math.abs(dx)) {
      if (cell._salSect) { if (window._gridSectionKey) window._gridSectionKey('ArrowRight'); return; }
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

      // (dev0604 IG · dev0606 TikTok) Embed cell + plain left-click: arm it so
      // the NEXT click reaches the play caret (nothing else can start a
      // cross-origin embed). Returns before the double-tap check, which costs
      // these rows nothing — _runDoubleTapAction only acts on quiz/text rows.
      // Touch is excluded on purpose (see _gridEmbedArm). Ctrl+click returned
      // above; alt-click (COI) never gets here — pointerdown handles it and
      // clears pStart.
      if (e.pointerType === 'mouse' && leftBtn && _gridIsEmbedCell(cell)) {
        _gridEmbedArm(cell);
        return;
      }

      // (dev0588) Tap on a summary line of the sectioned 1a text slide toggles
      // that collapsible (both modes). Reset the double-tap clock so click-click
      // on a summary keeps toggling instead of ALSO opening the editor —
      // double-click on any non-summary part of the cell still edits.
      if (cell._salSect) {
        const _sum = _gridSectionSummaryAt(cell, e.clientX, e.clientY);
        if (_sum) { _gridSectionToggleSummary(cell, _sum); _lastShortTapT = 0; return; }
      }

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
    // Swipe RIGHT → fullscreen view. (dev0587) Dev-mode forward-swipe on a text
    // cell opens Xe (same as double-click), mirroring the pointer path above.
    if (dx > 40 && Math.abs(dy) < Math.abs(dx)) {
      if (cell._rowData) {
        _lastGridRow = cell._rowData;
        if (!userMode && _gridIsTextRow(cell._rowData)) _runDoubleTapAction(cell, cellStr);
        else {
          // (dev0617) mirror of the pointer path — open on the cell's current section
          window._vpSectStart = cell._salSect ? cell._salSect.idx : 0;
          gridOpenFullscreen(cell._rowData);
        }
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
      // (dev0643) Within-cell swipe left on the sectioned 1a text slide advances
      // a section (touch mirror of the pointer path above).
      if (cell._salSect) { if (window._gridSectionKey) window._gridSectionKey('ArrowRight'); return; }
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
      // (dev0588) Summary tap on the sectioned 1a text slide — touch mirror of
      // the pointer path above.
      if (cell._salSect && endX != null) {
        const _sum = _gridSectionSummaryAt(cell, endX, endY);
        if (_sum) { _gridSectionToggleSummary(cell, _sum); _lastShortTapT = 0; return; }
      }
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

    // (zip0141) In user mode (Gu): no cut/paste/edit menu. Ctrl+right-click
    // still opens View directly. (dev0419) Plain right-click now pops a lean
    // viewer menu — View / Play steps / Play steps All — and nothing else.
    if (userMode) {
      if (e.ctrlKey && cell._rowData) {
        _lastGridRow = cell._rowData;
        gridOpenFullscreen(cell._rowData);
        return;
      }
      gridShowUserContextMenu(e.clientX, e.clientY, cellStr, cell._rowData);
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
      } else if (_gridIsTextRow(row)) {
        // (dev0581) Was `row.ftext || row.VidRange==='text'`, which missed a blank
        // Shift+T text row (empty ftext) — _gridIsTextRow now covers ltype='t' too.
        // (dev0587) Mark the return-to-grid flag so Xe's close path calls
        // gridShow() and the edited cell repaints. Without it, Xe closed and the
        // grid overlay (never hidden) just reappeared showing the STALE cell.
        _lastGridRow = row;
        _cameFromGrid = true;
        gridOpenTextEditor(cellS, row);
      }
    } else {
      // (dev0587) New text row from an empty cell — same fresh-grid return.
      _cameFromGrid = true;
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

// (dev0571) Keep the right-click menu fully ON-SCREEN. Right-clicking a
// bottom-row (or right-edge) cell used to push the menu partly past the viewport
// so its lowest item(s) were clipped — worst on the public Gu menu and on small
// phone screens (the user report). Call this AFTER the menu is in the DOM so its
// real size is measurable: cap its height (scroll if still taller than the
// screen), then flip it up/left off the cursor and clamp inside a small margin.
// Shared by BOTH the user (Gu) and dev (Gd) menus.
function _gridClampContextMenu(menu, x, y) {
  if (!menu) return;
  const m = 6, vw = window.innerWidth, vh = window.innerHeight;
  menu.style.maxHeight = (vh - 2 * m) + 'px';
  menu.style.overflowY = 'auto';
  const r = menu.getBoundingClientRect();
  let left = x, top = y;
  if (left + r.width  > vw - m) left = Math.max(m, x - r.width);        // flip left off cursor
  if (left + r.width  > vw - m) left = Math.max(m, vw - m - r.width);   // else clamp
  if (top  + r.height > vh - m) top  = Math.max(m, y - r.height);       // flip up off cursor
  if (top  + r.height > vh - m) top  = Math.max(m, vh - m - r.height);  // else clamp
  menu.style.left = left + 'px';
  menu.style.top  = top  + 'px';
}

// (dev0419) Lean user-mode (Gu) right-click menu: View / Play steps / Play
// steps All — viewing actions only, no edit/cut/delete/write. Shares the dev
// menu's chrome + close/keyboard plumbing (gridHideContextMenu) but builds its
// own short item list. "Play steps" routes by link type exactly like Gd (in
// cell for Vimeo/direct, in V for YouTube); "Play steps All" converts every
// playing cell with saved steps to in-cell step playback at once.
function gridShowUserContextMenu(x, y, cellStr, row) {
  gridHideContextMenu();

  _gridContextMenu = document.createElement('div');
  _gridContextMenu.id = 'gridContextMenu';
  _gridContextMenu.style.cssText = `
    position:fixed; left:${x}px; top:${y}px; z-index:30000;
    background:#1a1a2e; border:1px solid #444; border-radius:6px;
    padding:4px 0; min-width:160px; box-shadow:0 4px 12px rgba(0,0,0,0.5);
  `;

  const mkItem = (html, onclick) => {
    const b = document.createElement('div');
    b.innerHTML = html;
    b.style.cssText = 'padding:8px 16px; color:#8ef; cursor:pointer; font-size:13px;';
    b.onmouseenter = () => b.style.background = '#2a2a4e';
    b.onmouseleave = () => b.style.background = '';
    b.onclick = onclick;
    return b;
  };

  const doView = () => { if (row) { _lastGridRow = row; gridOpenFullscreen(row); } gridHideContextMenu(); };
  const doSteps = () => { if (window._gridPlayStepsRoute) window._gridPlayStepsRoute(cellStr, row); gridHideContextMenu(); };
  const doStepsAll = () => { if (window.gridPlayStepsAll) window.gridPlayStepsAll(); gridHideContextMenu(); };
  // (dev0516) Slideshow — play the whole active grid as a full-window slideshow
  // (same as the bare-'s' hotkey from G / the hamburger Slideshow item).
  const doSlideshow = () => { gridHideContextMenu(); if (window.slideshowOpenGrid) window.slideshowOpenGrid(); };

  if (row) _gridContextMenu.appendChild(mkItem('<u>V</u>iew', doView));
  _gridContextMenu.appendChild(mkItem('<u>P</u>lay steps', doSteps));
  _gridContextMenu.appendChild(mkItem('Play steps <u>A</u>ll', doStepsAll));
  _gridContextMenu.appendChild(mkItem('<u>S</u>lideshow', doSlideshow));

  document.body.appendChild(_gridContextMenu);
  _gridClampContextMenu(_gridContextMenu, x, y);   // (dev0571) keep on-screen (bottom row / phones)

  const handleKey = e => {
    if ((e.key === 'v' || e.key === 'V') && row) { e.preventDefault(); doView(); }
    else if (e.key === 'p' || e.key === 'P')     { e.preventDefault(); doSteps(); }
    else if (e.key === 'a' || e.key === 'A')     { e.preventDefault(); doStepsAll(); }
    else if (e.key === 's' || e.key === 'S')     { e.preventDefault(); doSlideshow(); }
    else if (e.key === 'Escape')                 { gridHideContextMenu(); }
  };
  document.addEventListener('keydown', handleKey, true);
  _gridContextMenu._keyHandler = handleKey;

  setTimeout(() => {
    document.addEventListener('click', gridHideContextMenu, { once: true });
  }, 10);
}

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

  // (dev0516) Slideshow — play the whole active grid as a full-window slideshow
  // (same as the bare-'s' hotkey from G / the hamburger Slideshow item).
  const slideBtn = document.createElement('div');
  slideBtn.innerHTML = '<u>S</u>lideshow';
  slideBtn.style.cssText = 'padding:8px 16px; color:#8ef; cursor:pointer; font-size:13px;';
  slideBtn.onmouseenter = () => slideBtn.style.background = '#2a2a4e';
  slideBtn.onmouseleave = () => slideBtn.style.background = '';
  slideBtn.onclick = () => {
    gridHideContextMenu();
    if (window.slideshowOpenGrid) window.slideshowOpenGrid();
  };
  _gridContextMenu.appendChild(slideBtn);

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
  _gridClampContextMenu(_gridContextMenu, x, y);   // (dev0571) keep on-screen (bottom row / phones)

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
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      gridHideContextMenu();
      if (window.slideshowOpenGrid) window.slideshowOpenGrid();   // (dev0516) play grid as slideshow
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
