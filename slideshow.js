// ══════════════════════════════════════════════════════════════════════════════
// SLIDESHOW (zip0228 / zip0229) — Full-window image slideshow with two sources:
//
//   1. slideshowOpen(row|ftext)     — images embedded in a row's ftext.
//                                     Mounted by Xe (edit) and Xs (preview).
//   2. slideshowOpenGrid()          — images from the cells of the active
//                                     grid, in cell order. Per cell, the
//                                     row's image link (if any) plays first,
//                                     then every <img> embedded in row.ftext.
//                                     Cells with nothing playable are
//                                     skipped. Hotkey: S (bare).
//
// Both paths share the same overlay + state machine. Each slide has a status
// (pending/loading/ready/filtered/error); _advance() walks past `filtered`
// and `error` automatically. The MPix filter adornment slots in by setting
// slide.status='filtered' inside the img.onload handler — one-spot change.
// ══════════════════════════════════════════════════════════════════════════════

const SLIDESHOW_DEFAULT_DURATION_MS = 5000;

let _slideshowState = null; // { overlay, slides:[{url,status,mpix?}], idx, timer }

// Extract <img src="..."> URLs from an ftext string, in document order.
// Uses DOMParser so we don't trip on attribute-order or quote-style variation.
function _slideshowExtractImgs(ftext) {
  if (!ftext) return [];
  const doc = new DOMParser().parseFromString('<div>' + ftext + '</div>', 'text/html');
  const imgs = doc.querySelectorAll('img[src]');
  const urls = [];
  imgs.forEach(img => {
    const src = img.getAttribute('src');
    if (src && /^https?:\/\//i.test(src)) urls.push(src);
  });
  return urls;
}

// Returns true if `link` looks like an image URL (not a video). Mirrors the
// extensions accepted by core.js `_classifyUrl()` so behavior matches the W
// importer's classification. YouTube/Vimeo are explicitly excluded.
function _slideshowIsImageLink(link) {
  if (!link || typeof link !== 'string') return false;
  const t = link.trim();
  if (!/^https?:\/\//i.test(t)) return false;
  if (/youtu\.be|youtube\.com|vimeo\.com/i.test(t)) return false;
  const path = t.split(/[?#]/)[0];
  return /\.(jpg|jpeg|png|gif|webp|svg|bmp|avif)$/i.test(path);
}

// Per-cell image gathering. Returns the ordered URLs the slideshow will
// play for one cell: the row's link (only if it's an image URL, never a
// video or web article) followed by every <img src> embedded in row.ftext.
// Returns [] for rows with nothing playable. Video cells with no ftext
// images naturally collapse to [] because _slideshowIsImageLink excludes
// YouTube/Vimeo/video file extensions.
function _slideshowCellImgs(row) {
  if (!row) return [];
  const urls = [];
  if (_slideshowIsImageLink(row.link)) urls.push(row.link);
  if (row.ftext) {
    _slideshowExtractImgs(row.ftext).forEach(u => urls.push(u));
  }
  return urls;
}

// Collect image URLs from the active grid in cell order (1a, 1b, …, sized
// by _gridGsize). For each cell, plays the cell's image (if any) followed
// by every image embedded in its ftext, so a "card" cell shows all its
// inner images before the slideshow moves on. Returns [] if no cell has
// any playable image.
function _slideshowGridImgs() {
  const gsize = (typeof _gridGsize === 'number' && _gridGsize >= 2 && _gridGsize <= 5)
    ? _gridGsize : 5;
  const urls = [];
  for (let r = 1; r <= gsize; r++) {
    for (let c = 1; c <= gsize; c++) {
      const cs = (typeof mkGridCell === 'function')
        ? mkGridCell(r, c)
        : (r + 'abcde'[c - 1]);
      const row = (typeof getRowByCell === 'function')
        ? getRowByCell(cs)
        : (typeof data !== 'undefined' ? data.find(d => d.cell === cs) : null);
      _slideshowCellImgs(row).forEach(u => urls.push(u));
    }
  }
  return urls;
}

// Public entry — ftext source. `source` may be a row object (uses row.ftext)
// or a raw HTML string. Silently toasts if no images are found.
function slideshowOpen(source) {
  if (_slideshowState) return; // already open
  const ftext = (source && typeof source === 'object' && 'ftext' in source)
    ? (source.ftext || '')
    : (source || '');
  const urls = _slideshowExtractImgs(ftext);
  if (!urls.length) {
    if (typeof toast === 'function') toast('No images found in this slide.', 2000);
    return;
  }
  _slideshowStart(urls);
}

// Public entry — grid source. Plays image links from the active grid's
// cells, in cell order, skipping non-image cells. Hotkey: Ctrl+Alt+S.
function slideshowOpenGrid() {
  if (_slideshowState) return; // already open
  const urls = _slideshowGridImgs();
  if (!urls.length) {
    if (typeof toast === 'function') toast('No image cells in the active grid.', 2000);
    return;
  }
  _slideshowStart(urls);
}

// Shared overlay setup. Builds the DOM, seeds the state machine, wires
// input handlers, and kicks off the first slide.
function _slideshowStart(urls) {
  const overlay = document.createElement('div');
  overlay.id = 'slideshowOverlay';
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:40000',
    'background:#000', 'display:flex',
    'align-items:center', 'justify-content:center',
    'cursor:pointer', 'overflow:hidden'
  ].join(';') + ';';

  // Stage: image element + status caption.
  overlay.innerHTML = `
    <img id="slideshowImg" style="max-width:100vw;max-height:100vh;width:auto;height:auto;
         object-fit:contain;display:none;user-select:none;-webkit-user-drag:none;" alt="">
    <div id="slideshowStatus" style="color:#666;font-family:monospace;font-size:14px;
         position:absolute;">Loading…</div>
    <div id="slideshowCounter" style="position:absolute;bottom:14px;right:18px;
         color:rgba(255,255,255,0.45);font-family:monospace;font-size:11px;
         pointer-events:none;letter-spacing:0.05em;"></div>
  `;
  document.body.appendChild(overlay);

  _slideshowState = {
    overlay,
    slides: urls.map(u => ({ url: u, status: 'pending' })),
    idx: 0,
    timer: null
  };

  overlay.addEventListener('click', slideshowClose);
  document.addEventListener('keydown', _slideshowKey, true);

  _slideshowShow(0);
}

function _slideshowKey(e) {
  if (!_slideshowState) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    slideshowClose();
  } else if (e.key === 'ArrowRight' || e.key === ' ') {
    e.preventDefault();
    _slideshowAdvance(+1);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    _slideshowAdvance(-1);
  }
}

// Show slide at index `i`. Resets the auto-advance timer. If the slide's image
// fails to load (or eventually: gets filtered by MPix), we move on.
function _slideshowShow(i) {
  if (!_slideshowState) return;
  const st = _slideshowState;
  st.idx = i;

  const slide = st.slides[i];
  const imgEl = st.overlay.querySelector('#slideshowImg');
  const statusEl = st.overlay.querySelector('#slideshowStatus');
  const counterEl = st.overlay.querySelector('#slideshowCounter');

  imgEl.style.display = 'none';
  statusEl.style.display = 'block';
  statusEl.textContent = 'Loading…';
  counterEl.textContent = (i + 1) + ' / ' + st.slides.length;

  clearTimeout(st.timer);

  // Single-use load/error handlers tied to this slide index. If the user has
  // advanced past this slide by the time it loads, we ignore the late event.
  const myIdx = i;
  imgEl.onload = () => {
    if (!_slideshowState || _slideshowState.idx !== myIdx) return;
    slide.status = 'ready';
    statusEl.style.display = 'none';
    imgEl.style.display = '';
    // Hook for future MPix filter:
    //   const mpix = (imgEl.naturalWidth * imgEl.naturalHeight) / 1e6;
    //   if (mpix < threshold) { slide.status = 'filtered'; _slideshowAdvance(+1); return; }
    _slideshowState.timer = setTimeout(() => _slideshowAdvance(+1), SLIDESHOW_DEFAULT_DURATION_MS);
  };
  imgEl.onerror = () => {
    if (!_slideshowState || _slideshowState.idx !== myIdx) return;
    slide.status = 'error';
    _slideshowAdvance(+1);
  };

  slide.status = 'loading';
  imgEl.src = slide.url;
}

// Move by `step` (+1 forward, -1 backward), skipping any slides marked
// `filtered` or `error`. Loops at the ends. If every slide is non-viewable,
// bail out and close.
function _slideshowAdvance(step) {
  if (!_slideshowState) return;
  const st = _slideshowState;
  const n = st.slides.length;
  let next = st.idx;
  for (let tried = 0; tried < n; tried++) {
    next = (next + step + n) % n;
    const s = st.slides[next];
    if (s.status === 'filtered' || s.status === 'error') continue;
    _slideshowShow(next);
    return;
  }
  // No viewable slides remain.
  if (typeof toast === 'function') toast('No viewable images.', 1800);
  slideshowClose();
}

function slideshowClose() {
  if (!_slideshowState) return;
  clearTimeout(_slideshowState.timer);
  document.removeEventListener('keydown', _slideshowKey, true);
  if (_slideshowState.overlay && _slideshowState.overlay.parentNode) {
    _slideshowState.overlay.remove();
  }
  _slideshowState = null;
}

// Expose for inline handlers and cross-module access.
window.slideshowOpen = slideshowOpen;
window.slideshowOpenGrid = slideshowOpenGrid;
window.slideshowClose = slideshowClose;

// ── (zip0231) Slideshow hotkey ───────────────────────────────────────────────
//
//   Bare S → play active grid as a slideshow.
//
// `s` is not in core.js's global-letter list, so this is the only consumer.
// Skipped when the user is typing in an input/textarea/contenteditable, when
// Xe is open (Xe owns S = slide preview), and when overlays that consume
// letter keys are up (dictionary, merge modal, video editor).
//
// (Ctrl+Alt+S was tried as a backup in zip0229/0230 but didn't fire reliably
// on the user's setup — likely OS/extension interception. Removed.)
function _slideshowHotkeyShouldFire() {
  if (_slideshowState) return false;                     // already playing
  const ae = document.activeElement;
  const tag = ae && ae.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
  if (ae && ae.isContentEditable) return false;
  if (document.getElementById('textEditorOverlay'))   return false; // Xe
  if (document.getElementById('video-editor-overlay')) return false; // E
  if (document.getElementById('dictOverlay'))         return false;
  if (document.getElementById('mergeModal'))          return false;
  if (document.getElementById('treeCtxMenu'))         return false;
  if (document.getElementById('chipCtxMenu'))         return false;
  return true;
}

document.addEventListener('keydown', e => {
  if (!e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey &&
      (e.key === 's' || e.key === 'S')) {
    if (!_slideshowHotkeyShouldFire()) return;
    e.preventDefault();
    e.stopPropagation();
    slideshowOpenGrid();
  }
}, true);
