
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
  if (typeof toast === 'function') toast('Grid: ' + n + '×' + n + ' (' + (n*n) + ' cells)', 1200);
}

function parseGridCell(s) {
  if (!s || s.length < 2) return null;
  const r = parseInt(s[0]), c = GRID_LETTERS.indexOf(s[1].toLowerCase()) + 1;
  if (isNaN(r) || r < 1 || r > GRID_ROWS || c < 1 || c > GRID_COLS) return null;
  return { row: r, col: c };
}
function mkGridCell(r, c) { return r + GRID_LETTERS[c - 1]; }

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
    // C mode: look up UID from active config, then find row
    if (!_gridActiveConfig) return null;
    const uid = _gridActiveConfig[cellStr];
    if (!uid) return null;
    return data.find(r => r.UID === uid) || null;
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
    if (displaySrcs.length >= 2) {
      wrapper.style.cssText = 'position:absolute;inset:0;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;pointer-events:none;z-index:1;background:#000;gap:1px;';
    } else {
      wrapper.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:1;background:#000;';
    }
    displaySrcs.slice(0, 4).forEach(src => {
      const img = document.createElement('img');
      img.src = src;
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
      img.onerror = () => { img.style.display = 'none'; };
      wrapper.appendChild(img);
    });
    cell.appendChild(wrapper);
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
  
  // Build N×N grid (N = _gridGsize, range 2-5)
  for (let r = 1; r <= _gridGsize; r++) {
    for (let c = 1; c <= _gridGsize; c++) {
      const cellStr = mkGridCell(r, c);
      const row = getRowByCellForGrid(cellStr);
      
      const cell = document.createElement('div');
      cell.className = 'grid-cell';
      cell.dataset.cell = cellStr;
      cell.style.cssText = 'position:relative;background:#000;overflow:hidden;';
      
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
            if (window.isYouTubeLink && window.isYouTubeLink(row.link) && window.mountYouTubeClip) {
              window.mountYouTubeClip(vidHost, row.link, segs[0].start, segs[0].dur, muted, undefined, segs);
            } else if (window.isVimeoLink && window.isVimeoLink(row.link) && window.mountVimeoClip) {
              window.mountVimeoClip(vidHost, row.link, segs[0].start, segs[0].dur, muted, undefined, segs);
            } else if (window.isDirectVideoLink && window.isDirectVideoLink(row.link) && window.mountDirectVideoClip) {
              window.mountDirectVideoClip(vidHost, row.link, segs[0].start, segs[0].dur, muted, undefined, segs);
            } else if (window.isInstagramLink && window.isInstagramLink(row.link) && window.mountInstagramEmbed) {
              window.mountInstagramEmbed(vidHost, row.link);
            }
          }, 100);
        } else if (row.link && !isImgLink) {
          _buildFtextImgCell(cell, row);
        } else if (row.link) {
          const img = document.createElement('img');
          img.src = row.link;
          img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;z-index:1;';
          img.onerror = () => { img.style.display = 'none'; };
          cell.appendChild(img);
        }
        cell._rowData = row;
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
  }
  
  // Update info bar
  const srcLabel = _gridSource === 'C' ? 'C:'+(_gridActiveConfig?.gname||'?') : 'T';
  const occupied = (() => {
    let n = 0;
    for (let r = 1; r <= _gridGsize; r++)
      for (let c = 1; c <= _gridGsize; c++)
        if (getRowByCellForGrid(mkGridCell(r, c))) n++;
    return n;
  })();
  // (zip0141) Tailor the help hint string by mode. Dev shows the full
  // edit/save shortcut list; user (Gu) just sees the viewing actions.
  const userModeHere = (typeof _isUserMode === 'function') ? _isUserMode() : false;
  const hint = userModeHere
    ? 'Tap=play · Swipe→=full screen · 2-5=size'
    : 'HOLD=cut · Swipe→=view · Ctrl+L=edit · ^!G=save · 2-5=size';
  // (zip0153) Total cells = _gridGsize²; was hardcoded /25.
  document.getElementById('gridInfo').textContent =
    '['+srcLabel+'] ' + _gridGsize + '×' + _gridGsize + ' · '
    + occupied + '/' + (_gridGsize * _gridGsize) + ' · ' + hint;
  
  gridUpdateSourceBtns();
  overlay.style.display = 'flex';
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
  
  const rowA = getRowByCell(srcCell);
  const rowB = getRowByCell(targetCell);
  
  // Swap cell values in data
  if (rowA) rowA.cell = targetCell;
  if (rowB) rowB.cell = srcCell;
  
  // Update timestamps
  const now = isoNow();
  if (rowA) rowA.DateModified = now;
  if (rowB) rowB.DateModified = now;
  
  save();
  
  // Immediate visual update - just swap the two cells
  gridUpdateCell(srcCell, rowB);  // srcCell now shows rowB's content
  gridUpdateCell(targetCell, rowA);  // targetCell now shows rowA's content
  
  toast('↔ Swapped ' + srcCell + ' ↔ ' + targetCell, 1500);
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
        if (window.isYouTubeLink && window.isYouTubeLink(row.link) && window.mountYouTubeClip) {
          window.mountYouTubeClip(vidHost, row.link, segs[0].start, segs[0].dur, muted, undefined, segs);
        } else if (window.isVimeoLink && window.isVimeoLink(row.link) && window.mountVimeoClip) {
          window.mountVimeoClip(vidHost, row.link, segs[0].start, segs[0].dur, muted, undefined, segs);
        } else if (window.isDirectVideoLink && window.isDirectVideoLink(row.link) && window.mountDirectVideoClip) {
          window.mountDirectVideoClip(vidHost, row.link, segs[0].start, segs[0].dur, muted, undefined, segs);
        } else if (window.isInstagramLink && window.isInstagramLink(row.link) && window.mountInstagramEmbed) {
          window.mountInstagramEmbed(vidHost, row.link);
        }
      }, 50);
    } else if (row.link && !isImgLink) {
      _buildFtextImgCell(cellEl, row);
    } else if (row.link) {
      // Image cell
      const img = document.createElement('img');
      img.src = row.link;
      img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;z-index:1;';
      img.onerror = () => { img.style.display = 'none'; };
      cellEl.appendChild(img);
    }
  } else {
    // Empty cell
    cellEl._rowData = null;
    cellEl.style.background = '#0a0a1a';
  }
  
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
  
  interactor.addEventListener('pointerdown', e => {
    e.preventDefault();
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
    if (!pStart) return;
    const _p = window.rotateXY ? window.rotateXY(e) : { x: e.clientX, y: e.clientY };
    const dx = Math.abs(_p.x - pStart.x);
    const dy = Math.abs(_p.y - pStart.y);
    if (dx > 10 || dy > 10) clearTimeout(holdTmr);
  }, true);
  
  interactor.addEventListener('pointerup', e => {
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
        } else {
          openBrowseForRow(cell._rowData);
        }
        return;
      }
      
      if (_gridCutCell) {
        if (_gridCutCell === cellStr) {
          gridClearCut();
          toast('Cut cancelled', 800);
        } else {
          gridPaste(cellStr);
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
    clearTimeout(holdTmr);
    pStart = null; didHold = false; wasCtrl = false; wasLeftBtn = false;
    cell.style.transform = '';
    cell.style.opacity = '';
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
    _dispatchGesture(dx, dy, ms);
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
  function _dispatchGesture(dx, dy, ms) {
    // Swipe RIGHT → fullscreen view
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
