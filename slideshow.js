// ══════════════════════════════════════════════════════════════════════════════
// SLIDESHOW (zip0235) — Full-window image slideshow with settings menu.
//
// Two sources:
//   1. slideshowOpen(row|ftext)  — images embedded in a row's ftext.
//   2. slideshowOpenGrid()       — images from the active grid in cell order;
//                                  per cell, link image (if any) first then
//                                  every <img> in row.ftext. Hotkey: S.
//
// On open, a settings menu appears OVER the first image; the slideshow
// auto-advances every `slideSec` seconds with a `transitionSec` crossfade.
// Tap-outside or the Start button dismisses the menu; a ⚙ gear icon in
// the top-right re-opens it.
//
// Settings (persisted to localStorage as `sal-slideshow-settings`):
//   slideSec, zoomSec, zoom (off|min|med|max), transitionSec,
//   loop, pan, label, comment, bokeh
// Functional this pass: slideSec, transitionSec, loop, label, comment.
// Stubbed (persist only; no animation yet): zoomSec, zoom, pan, bokeh.
//
// Each slide carries a {url, row} so label (row.VidTitle) and comment
// (row.comment) overlays can render per-cell metadata. ftext images
// inherit their host row's metadata.
//
// The overlay mounts inside #rotateWrap (when present) so portrait phones
// inherit the wrap's 90° rotation and show images in visual landscape.
// ══════════════════════════════════════════════════════════════════════════════

const SLIDESHOW_DEFAULTS = {
  slideSec:      5,
  zoomSec:       3,
  zoom:          'off',   // 'off'|'min'|'med'|'max'
  transitionSec: 1,
  delaySec:      0,       // (zip0239) pause after crossfade before zoom/pan starts
  loop:          true,
  pan:           'off',    // 'off'|'min'|'med'|'max'
  // (dev0265) label/comment are now size-valued, not boolean:
  //   'off' | 'small' | 'med' | 'large' | 'largest'
  // 'small' matches the pre-dev0265 ON font size.
  labelSize:     'small',
  commentSize:   'off',
  order:         'order', // (dev0265) 'order'|'random' — show in cell/file order or shuffled
  canvasBlur:    'off',   // 'off'|'min'|'med'|'max' (was boolean `bokeh` pre-zip0236)
  // (dev0279) Which media types participate in the show:
  //   'image' — image slides only (legacy behavior)
  //   'video' — direct-video slides only (played via the full V player)
  //   'both'  — images and videos interleaved in cell order
  // Only direct video files (.mp4/.webm/…) are eligible — YouTube/Vimeo links
  // are never collected as video slides.
  showMode:      'image'
};

// Fisher-Yates shuffle (in place) — used when settings.order === 'random'.
function _slideshowShuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
const SLIDESHOW_LS_KEY = 'sal-slideshow-settings';

// (dev0281) Stacking layers (all children of #rotateWrap, which is a single
// stacking context):
//   overlay 40000 (image layers + gesture catcher)
//   video   41000 (the V player #gridFullscreen, lifted above the overlay)
//   menu    42000 (settings menu + collapsed "+" stub — ALWAYS on top, even
//                  over a playing video, so it stays reachable)
// The menu must be a sibling of the overlay (mounted in the overlay's parent),
// not a child: a child of the 40000 overlay can never paint above the 41000
// video, since stacking contexts confine descendants.
const SLIDESHOW_VIDEO_Z = 41000;
const SLIDESHOW_MENU_Z  = 42000;

let _slideshowState = null;

function _slideshowLoadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SLIDESHOW_LS_KEY) || '{}');
    // (dev0265) Migrate legacy boolean `label`/`comment` → sized variants.
    if (typeof s.labelSize   === 'undefined' && typeof s.label   === 'boolean') {
      s.labelSize   = s.label   ? 'small' : 'off';
    }
    if (typeof s.commentSize === 'undefined' && typeof s.comment === 'boolean') {
      s.commentSize = s.comment ? 'small' : 'off';
    }
    delete s.label; delete s.comment;
    return Object.assign({}, SLIDESHOW_DEFAULTS, s);
  } catch (_) {
    return Object.assign({}, SLIDESHOW_DEFAULTS);
  }
}

function _slideshowSaveSettings(settings) {
  try { localStorage.setItem(SLIDESHOW_LS_KEY, JSON.stringify(settings)); }
  catch (_) {}
}

// Extract <img src="..."> URLs from an ftext string, in document order.
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

// Image URL test — accepts known image extensions, excludes video hosts.
function _slideshowIsImageLink(link) {
  if (!link || typeof link !== 'string') return false;
  const t = link.trim();
  if (!/^https?:\/\//i.test(t)) return false;
  if (/youtu\.be|youtube\.com|vimeo\.com/i.test(t)) return false;
  const path = t.split(/[?#]/)[0];
  return /\.(jpg|jpeg|png|gif|webp|svg|bmp|avif)$/i.test(path);
}

// (dev0279) Direct-video link test — a downloadable video file we can play in
// a native <video> element via the V player's vpMountDirectVideo path. By
// design this EXCLUDES YouTube/Vimeo (and anything non-file): the slideshow
// video feature is scoped to linked video files only.
function _slideshowIsDirectVideoLink(link) {
  if (!link || typeof link !== 'string') return false;
  const t = link.trim();
  if (!/^https?:\/\//i.test(t)) return false;
  if (/youtu\.be|youtube\.com|vimeo\.com/i.test(t)) return false;
  return /\.(mp4|mov|webm|ogg|avi|mkv|m4v)(\?|#|$)/i.test(t);
}

// (dev0279) Filter a canonical slide list by the Show setting. Slides carry a
// `kind` of 'image' or 'video'; anything untagged is treated as an image.
function _slideshowFilterByShow(list, mode) {
  if (mode === 'video') return list.filter(s => s.kind === 'video');
  if (mode === 'image') return list.filter(s => s.kind !== 'video');
  return list.slice(); // 'both'
}

// Per-cell slides: link image (if image URL) OR a direct-video slide (if the
// link is a playable video file), then every embedded ftext image.
function _slideshowCellSlides(row) {
  if (!row) return [];
  const out = [];
  if (_slideshowIsImageLink(row.link)) out.push({ url: row.link, row, kind: 'image' });
  else if (_slideshowIsDirectVideoLink(row.link)) out.push({ url: row.link, row, kind: 'video' });
  if (row.ftext) {
    _slideshowExtractImgs(row.ftext).forEach(u => out.push({ url: u, row, kind: 'image' }));
  }
  return out;
}

// Grid source: walk active grid in cell order, collect slides.
function _slideshowGridSlides() {
  const gsize = (typeof _gridGsize === 'number' && _gridGsize >= 2 && _gridGsize <= 5)
    ? _gridGsize : 5;
  const out = [];
  for (let r = 1; r <= gsize; r++) {
    for (let c = 1; c <= gsize; c++) {
      const cs = (typeof mkGridCell === 'function')
        ? mkGridCell(r, c)
        : (r + 'abcde'[c - 1]);
      const row = (typeof getRowByCell === 'function')
        ? getRowByCell(cs)
        : (typeof data !== 'undefined' ? data.find(d => d.cell === cs) : null);
      _slideshowCellSlides(row).forEach(s => out.push(s));
    }
  }
  return out;
}

function slideshowOpen(source) {
  if (_slideshowState) return;
  const isRow = source && typeof source === 'object' && 'ftext' in source;
  const ftext = isRow ? (source.ftext || '') : (source || '');
  const row   = isRow ? source : null;
  const urls = _slideshowExtractImgs(ftext);
  if (!urls.length) {
    if (typeof toast === 'function') toast('No images found in this slide.', 2000);
    return;
  }
  const slides = urls.map(u => ({ url: u, row, kind: 'image' }));
  // (dev0279) _slideshowStart now takes a single canonical (in-order) list and
  // derives the working set from the Show + Order settings internally.
  _slideshowStart(slides, { sourceKind: 'ftext' });
}

function slideshowOpenGrid() {
  // (dev0279) Canonical cell-order, all media kinds. The Show filter and the
  // random shuffle are applied inside _slideshowStart.
  const ordered = _slideshowGridSlides();
  if (!ordered.length) {
    if (typeof toast === 'function') toast('No image or video cells in the active grid.', 2000);
    return;
  }
  // (dev0283) Close any current show only now that we have slides, so a live
  // source-switch from the menu never leaves a gap on the screen behind.
  slideshowClose();
  _slideshowStart(ordered, { sourceKind: 'grid' });
}

// ── External / folder sources (File System Access API) ──────────────────────
// (dev0282) Persist a designated source-folder handle separately from the
// project folder (_fsaDir). It lives in the same IndexedDB db (`sal-fsa`) under
// a distinct key so picking a slideshow source never touches the project
// folder, and the folder may live anywhere on disk (not a project subdir).
function _ssSrcDB() {
  return new Promise((res, rej) => {
    const q = indexedDB.open('sal-fsa', 1);
    q.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
    };
    q.onsuccess = e => res(e.target.result);
    q.onerror   = e => rej(e.target.error);
  });
}
async function _ssSrcSave(h) {
  try { const db = await _ssSrcDB(); db.transaction('handles', 'readwrite').objectStore('handles').put(h, 'ssSource'); }
  catch (_) {}
}
async function _ssSrcLoad() {
  try {
    const db = await _ssSrcDB();
    return await new Promise(res => {
      const q = db.transaction('handles', 'readonly').objectStore('handles').get('ssSource');
      q.onsuccess = e => res(e.target.result || null);
      q.onerror   = () => res(null);
    });
  } catch (_) { return null; }
}
// Cached display name of the saved source folder so the menu (built
// synchronously) can label the dropdown without an async IDB read.
let _ssSourceName = '';
(async () => { try { const h = await _ssSrcLoad(); if (h) _ssSourceName = h.name; } catch (_) {} })();

// (dev0282) Walk a directory handle recursively, collect image files in walk
// order, and build blob: URL slides. Requests read permission if needed.
// Returns [] (after toasting) on denial/failure. Shared by jpgs/ and the
// external folder source.
async function _slideshowFolderSlides(dirHandle) {
  try {
    if ((await dirHandle.queryPermission({ mode: 'read' })) !== 'granted') {
      if ((await dirHandle.requestPermission({ mode: 'read' })) !== 'granted') {
        if (typeof toast === 'function') toast('Read permission denied.', 2200);
        return [];
      }
    }
  } catch (_) {}
  const files = [];
  async function walk(dir) {
    for await (const entry of dir.values()) {
      if (entry.kind === 'directory') await walk(entry);
      else if (/\.(jpe?g|png|gif|webp|avif|bmp)$/i.test(entry.name)) files.push(entry);
    }
  }
  try { await walk(dirHandle); }
  catch (e) {
    if (typeof toast === 'function') toast('Folder read failed: ' + e.message, 2500);
    return [];
  }
  // (dev0268) Build slides in walk order so the in-order snapshot is correct;
  // Show + Order (incl. shuffle) are applied inside _slideshowStart.
  const slides = [];
  for (const fh of files) {
    try {
      const file = await fh.getFile();
      slides.push({ url: URL.createObjectURL(file), row: null, kind: 'image' });
    } catch (_) {}
  }
  return slides;
}

// (dev0241) S from T → play all images under the project folder's jpgs/
// subdirectory, recursively. Uses the project FSA handle (_fsaDir) from core.js.
async function slideshowOpenJpgsFolder() {
  const root = (typeof _fsaDir !== 'undefined' && _fsaDir) ? _fsaDir : null;
  if (!root) {
    if (typeof toast === 'function') toast('No project folder set — use the 📂 button first.', 2500);
    return;
  }
  let jpgsDir;
  try {
    jpgsDir = await root.getDirectoryHandle('jpgs', { create: false });
  } catch (e) {
    if (typeof toast === 'function') toast('No "jpgs" folder in project.', 2200);
    return;
  }
  const slides = await _slideshowFolderSlides(jpgsDir);
  if (!slides.length) {
    if (typeof toast === 'function') toast('No images found under jpgs/.', 2200);
    return;
  }
  if (typeof toast === 'function') toast('Playing ' + slides.length + ' image(s) from jpgs/', 1800);
  // (dev0283) Swap in only after the walk succeeds — keeps the current show
  // (if any) on screen during the read instead of dropping to the view behind.
  slideshowClose();
  _slideshowStart(slides, { sourceKind: 'jpgs' });
}

// (dev0282) Play images from a designated folder ANYWHERE on disk, chosen via
// showDirectoryPicker (read-only). The handle is persisted (key 'ssSource') so
// it survives reloads. It is independent of the project folder and never
// mutates it.
//   reuseSaved=true  → try the saved handle (re-granting read if needed); only
//                      falls back to the picker if there is no saved handle.
//   reuseSaved=false → always show the picker (the menu's 📁 button). Must be
//                      called directly from a click handler — do NOT await any
//                      IDB read before the picker or the user gesture is lost.
async function slideshowOpenSourceFolder(reuseSaved) {
  if (!window.showDirectoryPicker) {
    if (typeof toast === 'function') toast('File System Access API not available.\nUse Edge or Chrome 86+.', 2800);
    return;
  }
  let dir = null;
  // Only attempt the reuse path when we actually have a saved folder — that way
  // the picker (reuseSaved=false / nothing saved) is reached with NO await
  // before it, preserving the click's user activation.
  if (reuseSaved && _ssSourceName) {
    dir = await _ssSrcLoad();
    if (dir) {
      try {
        if ((await dir.queryPermission({ mode: 'read' })) !== 'granted') {
          if ((await dir.requestPermission({ mode: 'read' })) !== 'granted') dir = null;
        }
      } catch (_) { dir = null; }
    }
  }
  if (!dir) {
    try { dir = await window.showDirectoryPicker({ mode: 'read', id: 'sal-ss-source' }); }
    catch (e) {
      if (e.name !== 'AbortError' && typeof toast === 'function') toast('Folder pick failed:\n' + e.message, 2800);
      return;   // keep the current show (if any) running
    }
    await _ssSrcSave(dir);
    _ssSourceName = dir.name;
  }
  if (typeof toast === 'function') toast('Reading "' + dir.name + '"…', 1500);
  const slides = await _slideshowFolderSlides(dir);
  if (!slides.length) {
    if (typeof toast === 'function') toast('No images found in "' + dir.name + '".', 2200);
    return;   // keep the current show (if any) running — don't drop to the view behind
  }
  if (typeof toast === 'function') toast('Playing ' + slides.length + ' image(s) from "' + dir.name + '"', 1800);
  // (dev0283) Swap in only after the walk succeeds, so switching source from
  // a live show never flashes the grid/table sitting behind the slideshow.
  slideshowClose();
  _slideshowStart(slides, { sourceKind: 'folder' });
}

// ── Core machinery ──────────────────────────────────────────────────────────

function _slideshowStart(allOrdered, opts) {
  const settings = _slideshowLoadSettings();
  // (dev0279) `allOrdered` is the full canonical (in-order) slide list across
  // every media kind. The working set shown is derived from it via the Show
  // filter, then shuffled if Order is random. The full list is retained so the
  // Show dropdown can re-filter live without re-walking the source.
  const allCanonical = (allOrdered || []).map(s => Object.assign({}, s, { status: 'pending' }));
  let filtered = _slideshowFilterByShow(allCanonical, settings.showMode);
  // Don't open an empty show: if the chosen mode has nothing, fall back to all.
  if (!filtered.length && allCanonical.length) filtered = allCanonical.slice();
  const inOrder = filtered.map(s => Object.assign({}, s, { status: 'pending' }));
  const working = (settings.order === 'random')
    ? _slideshowShuffle(filtered.map(s => Object.assign({}, s, { status: 'pending' })))
    : filtered.map(s => Object.assign({}, s, { status: 'pending' }));

  const overlay = document.createElement('div');
  overlay.id = 'slideshowOverlay';
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:40000',
    'background:#000', 'overflow:hidden',
    'user-select:none', '-webkit-user-select:none',
    // (dev0262) touch-action:none so the browser doesn't claim two-finger
    // gestures for page-pinch or pointercancel the swipe — our pointer
    // handlers do all gesture work.
    'touch-action:none'
  ].join(';') + ';';

  // Two stacked <img> layers for crossfade. Both fixed-position absolute,
  // object-fit:contain to letterbox. Start hidden; opacity animates.
  // (zip0237) Add `transform-origin:center` so the zoom-in animates around
  // the image center, and a scale(1) starting transform that gets animated
  // to the zoom target by _slideshowShow().
  const layerCSS = 'position:absolute;inset:0;width:100%;height:100%;'
                 + 'object-fit:contain;opacity:0;pointer-events:none;'
                 + 'user-select:none;-webkit-user-drag:none;'
                 + 'transform-origin:center center;transform:scale(1);';
  // (zip0237) Background blur layers — same image, object-fit:cover so they
  // fill the entire viewport (covering letterbox bars), plus filter:blur and
  // a slight scale to avoid the blur kernel showing transparent edges.
  // Always loaded with the same src as their paired fg img, but only visible
  // when canvasBlur != 'off'.
  const bgCSS    = 'position:absolute;inset:0;width:100%;height:100%;'
                 + 'object-fit:cover;opacity:0;pointer-events:none;'
                 + 'user-select:none;-webkit-user-drag:none;'
                 + 'transform:scale(1.06);';

  overlay.innerHTML = `
    <img id="slideshowBgA"  style="${bgCSS}"    alt="">
    <img id="slideshowBgB"  style="${bgCSS}"    alt="">
    <img id="slideshowImgA" style="${layerCSS}" alt="">
    <img id="slideshowImgB" style="${layerCSS}" alt="">
    <div id="slideshowLabel" style="position:absolute;top:14px;left:0;right:0;
         text-align:center;color:#fff;font-family:sans-serif;font-size:20px;
         font-weight:bold;text-shadow:0 2px 8px rgba(0,0,0,0.9);
         padding:0 60px;pointer-events:none;opacity:0;
         transition:opacity 0.4s;"></div>
    <div id="slideshowComment" style="position:absolute;bottom:36px;left:0;right:0;
         text-align:center;color:#ddd;font-family:sans-serif;font-size:15px;
         text-shadow:0 2px 8px rgba(0,0,0,0.9);padding:0 60px;
         pointer-events:none;opacity:0;transition:opacity 0.4s;"></div>
    <div id="slideshowStatus" style="position:absolute;top:50%;left:50%;
         transform:translate(-50%,-50%);color:#666;font-family:monospace;
         font-size:14px;pointer-events:none;">Loading…</div>
    <div id="slideshowCounter" style="position:absolute;bottom:10px;right:14px;
         color:rgba(255,255,255,0.45);font-family:monospace;font-size:11px;
         pointer-events:none;letter-spacing:0.05em;"></div>
    <button id="slideshowCloseBtn" title="Close (Esc)"
            style="position:absolute;top:10px;left:10px;width:38px;height:38px;
                   border-radius:6px;border:1px solid rgba(255,255,255,0.35);
                   background:rgba(0,0,0,0.55);color:#fff;font-size:18px;
                   cursor:pointer;padding:0;z-index:40005;">✕</button>
  `;

  // Mount inside #rotateWrap so portrait phones inherit the wrap's
  // 90° rotation and the slideshow renders in visual landscape.
  const parent = document.getElementById('rotateWrap') || document.body;
  parent.appendChild(overlay);

  _slideshowState = {
    overlay,
    slides: working,
    // (dev0279) Full canonical slide list (every media kind, in-order). Used
    // by the Show dropdown to re-filter the working set live mid-show.
    _allSlides: allCanonical,
    // (dev0268) In-order snapshot captured at start. Used by the Order
    // toggle to restore canonical order when switching random → in-order
    // mid-show, and re-saved when the ftext slideset toggle is used.
    _inOrderSnapshot: inOrder,
    idx: -1,
    timer: null,
    settings,
    front: 'A',     // which <img> is currently visible
    menu: null,
    // (dev0283) Which source produced these slides ('grid'|'jpgs'|'folder'|
    // 'ftext'). Set HERE, before _slideshowOpenMenu runs at the end of start,
    // so the menu's Source dropdown shows the right value on first paint.
    // (Previously set by the opener AFTER start returned — the menu had
    // already been built with it undefined, so it defaulted to "Grid".)
    sourceKind: (opts && opts.sourceKind) || null,
    paused: false,  // (zip0236) pause/resume from settings menu
    // (dev0268) ftext-toggle bookkeeping. When the user gestures up on a
    // paused slide whose URL appears in row.ftext, we save the current
    // slides/snapshot here and replace them with the ftext-derived set.
    _ftextMode: false,
    _beforeFtextSlides: null,
    _beforeFtextSnapshot: null,
    _beforeFtextIdx: -1,
    // (dev0279) Video-slide bookkeeping. While a direct-video slide is playing
    // we hand control to the full V player (gridOpenFullscreen) mounted over
    // the slideshow; these track that hand-off so we can resume on close.
    _videoActive: false,
    _vpObserver: null,
    _prevFsZ: '',
    // (dev0281) Direction the show advances when the current video closes:
    // +1 (R→L flick = next) or -1 (L→R flick = previous). Reset after each use.
    _closeDir: 1,
    // (dev0281) Per-session video playback prefs, captured when a video closes
    // and re-applied to subsequent videos. `muted` starts null = use the row's
    // T "Mute" field; once the user toggles it, the session choice wins.
    // `speed` likewise. `ab` holds A-B loop points keyed by video URL.
    _vpSession: { muted: null, speed: null, ab: {} }
  };

  // Apply transition duration to image layers (live, in case settings change)
  _slideshowApplyTransitionTiming();

  // (dev0265) Desktop mouse — modeled on V/vp.js:
  //   • Hold LMB: after 180ms settle, scale ramps up (slow→fast) capped at MAX,
  //     persists across mouseups (does NOT revert on release).
  //   • Drag > 8px during press: cancel zoom, enter drag mode. If currently
  //     zoomed (>1.05), drag pans; otherwise drag tracks for a horizontal
  //     swipe (release → navigate). L→R = previous; R→L = next.
  //   • Double-click: reset zoom to 1× / pan to 0,0.
  //   • Hold again at any time to zoom further.
  (function wireMouseSlideshow() {
    const HOLD_MS    = 180;
    const MAX_SCALE  = 8;
    const SWIPE_DX   = 50;
    const SWIPE_MS   = 800;

    function _frontImg() {
      const st = _slideshowState; if (!st) return null;
      return st.overlay.querySelector('#slideshowImg' + st.front);
    }
    function _ensureMZ() {
      const st = _slideshowState;
      if (!st._mouseZoom) st._mouseZoom = { scale: 1, tx: 0, ty: 0 };
      return st._mouseZoom;
    }
    // Stamp the mouseZoom transform onto the front layer; also mirror into
    // _manualZoom so _slideshowIsZoomed() reports correctly (gesture meaning
    // switches to pan when zoomed).
    function _applyMZ() {
      const st = _slideshowState; if (!st) return;
      const mz = _ensureMZ();
      st._manualZoom = (mz.scale > 1.02) ? { scale: mz.scale, tx: mz.tx, ty: mz.ty } : null;
      // (dev0268) Hold-to-zoom past the manual-zoom threshold also pauses
      // the show. Pause persists across L↔R navigation (zoom resets per
      // slide, paused does not) — only a single tap (or the menu's
      // Resume button) re-arms the dwell timer.
      if (mz.scale > 1.02 && !st.paused) _slideshowPause();
      const f = _frontImg(); if (!f) return;
      f.style.transition = 'none';
      f.style.transform  = 'translate(' + mz.tx + 'px,' + mz.ty + 'px) scale(' + mz.scale + ')';
    }

    let down = null;       // { x0, y0, t0, dragging, panBase }
    let zoomDelay = null, zoomTimer = null, zoomStep = 0;
    let zoomStarted = false; // (dev0268) hold-zoom actually ran during this press
    function _stopZoom() {
      if (zoomDelay) { clearTimeout(zoomDelay);   zoomDelay = null; }
      if (zoomTimer) { clearInterval(zoomTimer);  zoomTimer = null; }
    }
    function _startZoom() {
      zoomStarted = true; // (dev0268) so mouseup can suppress click-resume
      const mz = _ensureMZ();
      zoomStep = 0.015; // 0.015 × 20Hz ≈ 0.3 scale/sec (slow start)
      zoomTimer = setInterval(() => {
        if (!_slideshowState) { _stopZoom(); return; }
        if (mz.scale >= MAX_SCALE) { _stopZoom(); return; }
        mz.scale = Math.min(MAX_SCALE, mz.scale + zoomStep);
        zoomStep = Math.min(0.12, zoomStep + 0.003); // → ~2.4 scale/sec
        _applyMZ();
      }, 50);
    }

    overlay.addEventListener('mousedown', e => {
      if (!_slideshowState) return;
      if (e.button !== 0) return;
      if (e.target.closest('#slideshowMenu')) return;
      if (e.target.closest('#slideshowCloseBtn')) return;
      if (_slideshowState._touchActive) return;
      e.preventDefault();
      down = { x0: e.clientX, y0: e.clientY, t0: Date.now(), dragging: false, panBase: null };
      zoomStarted = false; // (dev0268) reset per press
      zoomDelay = setTimeout(_startZoom, HOLD_MS);
    });
    overlay.addEventListener('mousemove', e => {
      if (!down) return;
      const dx = e.clientX - down.x0, dy = e.clientY - down.y0;
      if (!down.dragging && Math.hypot(dx, dy) > 8) {
        // Movement → cancel any pending/running zoom, enter drag mode
        down.dragging = true;
        _stopZoom();
        const mz = _ensureMZ();
        down.panBase = { tx: mz.tx, ty: mz.ty };
      }
      if (down.dragging) {
        const mz = _ensureMZ();
        if (mz.scale > 1.05) {
          mz.tx = down.panBase.tx + dx;
          mz.ty = down.panBase.ty + dy;
          _applyMZ();
        }
        // At ~1× we just track for swipe-on-release; no transform changes.
      }
    });
    overlay.addEventListener('mouseup', e => {
      if (!down) return;
      _stopZoom();
      const wasDragging = down.dragging;
      const dx = e.clientX - down.x0, dy = e.clientY - down.y0;
      const ms = Date.now() - down.t0;
      const mz = _ensureMZ();
      const heldZoom = zoomStarted; // (dev0268) snapshot before reset
      down = null;
      const st = _slideshowState;
      if (wasDragging && mz.scale < 1.1) {
        const horiz = Math.abs(dx) > SWIPE_DX && Math.abs(dx) > Math.abs(dy) && ms < SWIPE_MS;
        const vert  = Math.abs(dy) > SWIPE_DX && Math.abs(dy) > Math.abs(dx) && ms < SWIPE_MS;
        if (horiz) {
          // Horizontal swipe at ~1× → navigate. Pause (if any) persists.
          _slideshowAdvance(dx > 0 ? -1 : +1);
        } else if (vert && st && st.paused) {
          // (dev0268) Vertical drag on a paused, unzoomed slide toggles
          // the slideset between original and the current row's ftext
          // images. Both helpers are silent when not applicable.
          if (dy < 0) _slideshowMaybeSwitchToFtextSet();
          else        _slideshowMaybeRestoreOriginalSet();
        }
      } else if (!wasDragging && !heldZoom && st && st.paused) {
        // (dev0268) Single click on a paused slide resumes playback.
        // `heldZoom` guard: a press that triggered hold-zoom is not a
        // "click" — release just ends the zoom; pause stays.
        _slideshowResume();
      }
      // Zoom persists across releases (V-style). No reset here.
    });
    overlay.addEventListener('mouseleave', () => {
      if (!down) return;
      _stopZoom();
      down = null;
    });
    // Double-click → reset zoom & pan to 1× / center, restore auto Ken Burns.
    overlay.addEventListener('dblclick', e => {
      if (!_slideshowState) return;
      if (e.target.closest('#slideshowMenu')) return;
      if (e.target.closest('#slideshowCloseBtn')) return;
      _stopZoom();
      _slideshowState._mouseZoom = { scale: 1, tx: 0, ty: 0 };
      _slideshowState._manualZoom = null;
      const f = _frontImg();
      if (f) f.style.transition = 'transform 0.25s ease-out';
      _slideshowApplyZoom();
    });
  })();

  // (dev0262) Touch gestures. We use pointer events with pointerType filter so
  // mouse keeps its existing click-to-close (handled above).
  (function wireTouchSlideshow() {
    const _ptrs = new Map(); // id → {x,y}
    let _pinch = null;       // { scale, tx, ty, dist, mx, my }
    let _swipe = null;       // { x, y, t }
    let _lastTap = 0, _lastTapP = null;
    // (dev0268) Single-finger long-press hold-zoom — mirrors the desktop
    // mouse-hold gesture so phone users get the same model. Pinch zoom
    // continues to work; the two coexist (pinch supersedes long-press).
    let _longPressDelay = null, _longPressTimer = null;
    let _longPressZoomStarted = false;
    let _longPressStep = 0;
    function _stopLongPressZoom() {
      if (_longPressDelay) { clearTimeout(_longPressDelay); _longPressDelay = null; }
      if (_longPressTimer) { clearInterval(_longPressTimer); _longPressTimer = null; }
    }
    function _startLongPressZoom() {
      const st = _slideshowState; if (!st) return;
      _longPressZoomStarted = true;
      st._manualZoom = st._manualZoom || { scale: 1, tx: 0, ty: 0 };
      _longPressStep = 0.015;
      _longPressTimer = setInterval(() => {
        const ss = _slideshowState; if (!ss) { _stopLongPressZoom(); return; }
        const m = ss._manualZoom || (ss._manualZoom = { scale: 1, tx: 0, ty: 0 });
        if (m.scale >= 8) { _stopLongPressZoom(); return; }
        m.scale = Math.min(8, m.scale + _longPressStep);
        _longPressStep = Math.min(0.12, _longPressStep + 0.003);
        _applyManual(); // also triggers _slideshowPause via the scale check
      }, 50);
    }
    // Per-slide manual zoom override (paused pinch). Reset when slide changes.
    function _front() {
      const st = _slideshowState;
      if (!st) return null;
      return st.overlay.querySelector('#slideshowImg' + st.front);
    }
    function _applyManual() {
      const st = _slideshowState; if (!st) return;
      const f = _front(); if (!f) return;
      const m = st._manualZoom || { scale: 1, tx: 0, ty: 0 };
      // (dev0268) Pinch or single-finger long-press zoom past the manual
      // threshold also pauses the show. Single tap resumes.
      if (m.scale > 1.02 && !st.paused) _slideshowPause();
      // Kill the running transition so pinch tracks the fingers in real time.
      f.style.transition = 'none';
      f.style.transform  = 'translate(' + m.tx + 'px,' + m.ty + 'px) scale(' + m.scale + ')';
    }
    function _xy(e) {
      return (typeof window.rotateXY === 'function')
        ? window.rotateXY(e)
        : { x: e.clientX, y: e.clientY };
    }

    overlay.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse') return;
      if (e.target.closest('#slideshowMenu')) return;
      if (e.target.closest('#slideshowCloseBtn')) return;
      const st = _slideshowState; if (!st) return;
      st._touchActive = true;
      try { overlay.setPointerCapture(e.pointerId); } catch(_) {}
      const p = _xy(e);
      _ptrs.set(e.pointerId, p);

      if (_ptrs.size >= 2) {
        _swipe = null;
        // (dev0268) Pinch supersedes long-press hold — cancel any pending
        // hold-zoom now that a second finger has joined.
        _stopLongPressZoom();
        _longPressZoomStarted = false;
        const [a, b] = [..._ptrs.values()];
        const m = st._manualZoom || { scale: 1, tx: 0, ty: 0 };
        _pinch = {
          scale: m.scale, tx: m.tx, ty: m.ty,
          dist: Math.hypot(b.x - a.x, b.y - a.y),
          mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2
        };
      } else {
        _pinch = null;
        _swipe = { x: p.x, y: p.y, t: Date.now() };
        // (dev0268) Schedule a single-finger long-press hold-zoom. Cancelled
        // on movement > 8px (it's a swipe), on pointerup (release), on a
        // second finger (it becomes pinch), or on pointercancel.
        _longPressZoomStarted = false;
        _stopLongPressZoom();
        _longPressDelay = setTimeout(_startLongPressZoom, 180);
      }
    }, true);

    overlay.addEventListener('pointermove', e => {
      if (e.pointerType === 'mouse' || !_ptrs.has(e.pointerId)) return;
      const st = _slideshowState; if (!st) return;
      _ptrs.set(e.pointerId, _xy(e));
      // (dev0268) Single-finger motion beyond ~8px cancels the pending
      // long-press hold-zoom — the user is swiping, not holding.
      if (_ptrs.size === 1 && _swipe && !_longPressZoomStarted) {
        const cp = _xy(e);
        if (Math.hypot(cp.x - _swipe.x, cp.y - _swipe.y) > 8) {
          _stopLongPressZoom();
        }
      }
      // (dev0268) Pinch was previously gated on `st.paused` (user had to
      // pause first). Now pinch zoom triggers _slideshowPause itself via
      // _applyManual's scale check, so we can let it run any time.
      if (_ptrs.size >= 2 && _pinch) {
        const [a, b] = [..._ptrs.values()];
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        const mx   = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const ns   = Math.min(8, Math.max(0.5, _pinch.scale * dist / _pinch.dist));
        const ntx  = _pinch.tx + (mx - _pinch.mx);
        const nty  = _pinch.ty + (my - _pinch.my);
        st._manualZoom = { scale: ns, tx: ntx, ty: nty };
        _applyManual();
      }
    }, true);

    overlay.addEventListener('pointerup', e => {
      if (e.pointerType === 'mouse' || !_ptrs.has(e.pointerId)) return;
      const st = _slideshowState; if (!st) return;
      const p = _xy(e);
      _ptrs.delete(e.pointerId);

      if (_ptrs.size === 0) {
        // Clear the touch-active flag on a short delay so the synthesized
        // mouse `click` that may follow the touch sequence is suppressed.
        setTimeout(() => { if (_slideshowState) _slideshowState._touchActive = false; }, 350);
        // (dev0268) If long-press hold-zoom actually ran during this
        // press, skip both swipe and tap detection — release just ends
        // the zoom; pause stays. Always cancel any pending hold timer.
        const heldLPZ = _longPressZoomStarted;
        _longPressZoomStarted = false;
        _stopLongPressZoom();
        if (heldLPZ) { _swipe = null; _pinch = null; return; }
        if (_swipe) {
          const dx = p.x - _swipe.x, dy = p.y - _swipe.y;
          const ms = Date.now() - _swipe.t;
          // Horizontal swipe → navigate (dev0265: standardized to desktop conv).
          // L→R (dx > 0) = previous; R→L (dx < 0) = next.
          // When the current image is zoomed (manual pinch or auto-zoom > 1),
          // a single-finger drag is a pan, not a navigation — skip and let the
          // dedicated pan path handle it via _slideshowSetPanTargetFromEvent.
          const zoomedNow = _slideshowIsZoomed();
          if (!zoomedNow && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) && ms < 800) {
            _swipe = null;
            _slideshowAdvance(dx > 0 ? -1 : +1);
            return;
          }
          // (dev0268) Vertical swipe on a paused, unzoomed slide toggles
          // the slideset between original and the current row's ftext
          // images. Both helpers are silent when not applicable.
          if (!zoomedNow && st.paused && Math.abs(dy) > 50
              && Math.abs(dy) > Math.abs(dx) && ms < 800) {
            _swipe = null;
            if (dy < 0) _slideshowMaybeSwitchToFtextSet();
            else        _slideshowMaybeRestoreOriginalSet();
            return;
          }
          // Quick stationary tap → check for double-tap, then resume, then pan-aim.
          if (Math.abs(dx) < 14 && Math.abs(dy) < 14 && ms < 300) {
            const now = Date.now();
            if (now - _lastTap < 350 && _lastTapP &&
                Math.abs(p.x - _lastTapP.x) < 30 &&
                Math.abs(p.y - _lastTapP.y) < 30) {
              _lastTap = 0; _lastTapP = null;
              _swipe = null; slideshowClose(); return;
            }
            _lastTap = now; _lastTapP = p;
            _swipe = null;
            // (dev0268) Tap on a paused slide resumes playback (covers
            // zoom-induced and menu-triggered pause). Otherwise falls back
            // to pan-aim when Ken Burns pan is on.
            if (st.paused) {
              _slideshowResume();
            } else if (st.settings.pan !== 'off') {
              _slideshowSetPanTargetFromEvent(e);
            }
            return;
          }
        }
        _swipe = null; _pinch = null;
      } else if (_ptrs.size === 1 && _pinch) {
        _pinch = null;
      }
    }, true);

    overlay.addEventListener('pointercancel', e => {
      if (e.pointerType === 'mouse') return;
      _ptrs.delete(e.pointerId);
      if (_ptrs.size === 0) {
        _swipe = null; _pinch = null;
        // (dev0268) Also tear down any long-press hold-zoom state.
        _stopLongPressZoom();
        _longPressZoomStarted = false;
        if (_slideshowState) _slideshowState._touchActive = false;
      }
    }, true);
  })();

  overlay.querySelector('#slideshowCloseBtn').onclick = e => {
    e.stopPropagation();
    slideshowClose();
  };

  document.addEventListener('keydown', _slideshowKey, true);

  // Show first slide (no crossfade for the initial paint).
  _slideshowShow(0, { initial: true });
  // And immediately open the settings menu over it.
  _slideshowOpenMenu();
}

function _slideshowApplyTransitionTiming() {
  if (!_slideshowState) return;
  const st = _slideshowState;
  const t = st.settings.transitionSec;
  const z = st.settings.zoomSec;
  // (zip0237) fg img layers: opacity crossfade over transitionSec, plus a
  // transform animation over zoomSec for the zoom-in effect.
  ['A', 'B'].forEach(letter => {
    const img = st.overlay.querySelector('#slideshowImg' + letter);
    if (img) {
      img.style.transition =
        'opacity ' + t + 's ease-in-out, '
      + 'transform ' + z + 's ease-out';
    }
    // bg layers: opacity + filter both animate over transitionSec so blur
    // intensity changes don't snap.
    const bg = st.overlay.querySelector('#slideshowBg' + letter);
    if (bg) {
      bg.style.transition =
        'opacity ' + t + 's ease-in-out, '
      + 'filter ' + t + 's ease-in-out';
    }
  });
}

// (zip0237) Zoom level → end-state scale. "off" stays at 1.0 so no animation.
// (zip0239) max bumped 1.50 → 2.50 so high-resolution images zoom hard
// enough to reveal detail. min/med pushed slightly to keep the gaps even.
function _slideshowZoomScale(level) {
  if (level === 'min') return 1.20;
  if (level === 'med') return 1.50;
  if (level === 'max') return 2.50;
  if (level === 'supermax') return 0;  // sentinel: computed from naturalWidth in onload
  return 1.0;
}

// Compute the scale needed to reach 1 device-pixel per image pixel.
// fitScale = how the `object-fit:contain` shrinks the image to fill the
// container. Inverting that (divided by dpr) brings it back to 1:1.
// Capped 1–10 so tiny thumbnails don't go insane and no negative zoom.
function _slideshowSuperMaxScale(img) {
  const nW = img.naturalWidth;
  const nH = img.naturalHeight;
  const cW = img.clientWidth  || window.innerWidth;
  const cH = img.clientHeight || window.innerHeight;
  if (!nW || !nH) return 2.5;
  const fitScale = Math.min(cW / nW, cH / nH);
  const dpr = window.devicePixelRatio || 1;
  return Math.min(10.0, Math.max(1.0, 1.0 / (fitScale * dpr)));
}

// Pan level → fractional translation multiplier.
// 'off'=0 (no pan), 'min'=gentle, 'med'=moderate, 'max'=full (legacy behavior).
function _slideshowPanFactor(level) {
  if (level === 'min') return 0.30;
  if (level === 'med') return 0.60;
  if (level === 'max') return 1.00;
  return 0.0;
}

// (zip0237) Blur level → CSS blur radius in px.
function _slideshowBlurPx(level) {
  if (level === 'min') return 8;
  if (level === 'med') return 18;
  if (level === 'max') return 32;
  return 0;
}

// Apply the current canvasBlur setting live. Sets filter on both bg layers,
// and matches the front bg's opacity to whether blur is enabled. Called when
// the user changes the dropdown mid-slideshow.
function _slideshowApplyCanvasBlur() {
  if (!_slideshowState) return;
  const st = _slideshowState;
  const px = _slideshowBlurPx(st.settings.canvasBlur);
  const show = px > 0;
  ['A', 'B'].forEach(letter => {
    const bg = st.overlay.querySelector('#slideshowBg' + letter);
    if (!bg) return;
    bg.style.filter  = show ? ('blur(' + px + 'px)') : 'none';
    // Only the front-paired bg should be visible (back is paired with the
    // not-yet-shown back fg). After a crossfade, st.front updates.
    bg.style.opacity = (show && letter === st.front) ? '1' : '0';
  });
}

// (zip0238) Pan / Ken Burns helpers.
//
// Pan target is stored on each slide as fractional container coords
// {x: 0..1, y: 0..1} (0,0 = top-left, 0.5,0.5 = center). When pan is on,
// _slideshowShow pre-assigns a random target if the slide doesn't have one;
// a click/tap on the overlay overwrites it with the touched point.
//
// The end-of-zoom transform brings the target to screen center: with
// transform-origin at center, applying scale(N) leaves a target pixel
// (fx*W, fy*H) at (W/2 + N*(fx*W - W/2), H/2 + N*(fy*H - H/2)). A subsequent
// translate by (-N*W*(fx-0.5), -N*H*(fy-0.5)) brings it back to (W/2, H/2).
// Order: `translate(...) scale(N)` — scale first, then translate in screen
// pixels (CSS applies right-to-left in effect).
function _slideshowPickRandomPanTarget() {
  const angle = Math.random() * 2 * Math.PI;
  const dist  = 0.15 + Math.random() * 0.15; // 15-30% from center
  return {
    x: 0.5 + Math.cos(angle) * dist,
    y: 0.5 + Math.sin(angle) * dist
  };
}

function _slideshowComputePanTransform(targetScale) {
  if (!_slideshowState) return 'translate(0,0) scale(1)';
  const st = _slideshowState;
  if (!(targetScale > 1.0)) return 'translate(0,0) scale(1)';

  const panFactor = _slideshowPanFactor(st.settings.pan);
  let fx = 0.5, fy = 0.5;
  if (panFactor > 0 && st.idx >= 0) {
    const slide = st.slides[st.idx];
    if (slide && slide.panTarget) {
      fx = slide.panTarget.x;
      fy = slide.panTarget.y;
    }
  }
  const w = st.overlay.clientWidth  || window.innerWidth;
  const h = st.overlay.clientHeight || window.innerHeight;
  const dx = -targetScale * w * (fx - 0.5) * panFactor;
  const dy = -targetScale * h * (fy - 0.5) * panFactor;
  return 'translate(' + dx + 'px, ' + dy + 'px) scale(' + targetScale + ')';
}

// (zip0238) Convert a click/touch on the overlay into a pan target for the
// current slide, then re-apply the transform so the image smoothly re-aims
// at the tapped point.
//
// Uses window.rotateXY to handle portrait-phone rotation correctly — the
// overlay is mounted inside #rotateWrap so its local coords match wrap-local,
// which is what rotateXY returns.
function _slideshowSetPanTargetFromEvent(e) {
  if (!_slideshowState) return;
  const st = _slideshowState;
  if (st.idx < 0) return;
  const slide = st.slides[st.idx];
  if (!slide) return;
  const p = (typeof window.rotateXY === 'function')
    ? window.rotateXY(e)
    : { x: e.clientX, y: e.clientY };
  const w = st.overlay.clientWidth  || window.innerWidth;
  const h = st.overlay.clientHeight || window.innerHeight;
  if (!w || !h) return;
  const fx = Math.max(0, Math.min(1, p.x / w));
  const fy = Math.max(0, Math.min(1, p.y / h));
  slide.panTarget = { x: fx, y: fy };
  _slideshowApplyZoom();
}

// Apply the current zoom (and pan target) live to the front fg layer. Used
// when the user changes the Zoom dropdown, toggles Pan, or taps to aim — the
// CSS transition smoothly animates from the current state to the new target.
function _slideshowApplyZoom() {
  if (!_slideshowState) return;
  const st = _slideshowState;
  const front = st.overlay.querySelector('#slideshowImg' + st.front);
  if (!front) return;
  let scale = _slideshowZoomScale(st.settings.zoom);
  if (scale === 0) scale = _slideshowSuperMaxScale(front);
  front.style.transform = _slideshowComputePanTransform(scale);
}

// (dev0265) "Is the current slide currently zoomed in?" — true if the user has
// pinched/held to zoom (manualZoom.scale > 1) OR the auto-zoom Ken Burns has
// pushed the front layer past 1.0. Used to switch gesture meaning from
// navigate → pan when zoomed.
function _slideshowIsZoomed() {
  const st = _slideshowState;
  if (!st) return false;
  const m = st._manualZoom;
  return !!(m && m.scale > 1.02);
}

// (dev0279) ── Direct-video slides ───────────────────────────────────────────
// A video slide is played by the project's normal full-window V player
// (gridOpenFullscreen → vpMountDirectVideo), which carries its own toolbar
// (play/scrub/speed/CC/mute/A-B/Selected-Full) and the same mouse + touch
// gestures (hold-to-zoom, drag-pan, R→L swipe-to-close, double-click reset).
//
// V mounts into #gridFullscreen (z-index 28500 by default), which sits BELOW
// the slideshow overlay (z 40000). We temporarily lift it above the slideshow
// for the duration of playback, watch for it closing, then advance the show.
function _slideshowPlayVideo(slide) {
  const st = _slideshowState;
  if (!st) return;
  if (typeof gridOpenFullscreen !== 'function' || !slide || !slide.row) {
    // Can't play — skip to the next slide so the show doesn't stall.
    _slideshowAdvance(+1);
    return;
  }
  st._videoActive = true;
  st._closeDir = 1; // default: closing/finishing advances to the NEXT slide
  clearTimeout(st.timer);
  clearTimeout(st.delayTimer);

  const fs = document.getElementById('gridFullscreen');
  if (fs) {
    st._prevFsZ = fs.style.zIndex || '';
    // Above the slideshow overlay (image), but below the menu (which stays on top).
    fs.style.zIndex = '' + SLIDESHOW_VIDEO_Z;
  }
  _slideshowWatchVpClose();
  gridOpenFullscreen(slide.row);
  // (dev0280) In a slideshow a video plays its selection ONCE and then the show
  // advances — it must not loop like a standalone V. gridOpenFullscreen creates
  // _vpState synchronously (the player mounts a tick later), so the flag is in
  // place before playback starts. vp.js honours it in the segment walk and on
  // the native 'ended' event.
  if (typeof _vpState !== 'undefined' && _vpState) {
    _vpState.slideshowNoLoop = true;
    // (dev0281) Apply this session's playback prefs over the row defaults.
    // Mute + speed are read at mount (50 ms later); A-B is honoured by the
    // timeline loop. Setting them now (before mount) is enough.
    const sess = st._vpSession || (st._vpSession = { muted: null, speed: null, ab: {} });
    if (sess.muted !== null) _vpState.muted = sess.muted;
    if (sess.speed !== null) _vpState.speed = sess.speed;
    const ab = (sess.ab && slide.url) ? sess.ab[slide.url] : null;
    if (ab) { _vpState.aPoint = ab.a; _vpState.bPoint = ab.b; }
  }
}

// Watch #gridFullscreen for its display flipping back to 'none' (which vpClose
// does), then resume the slideshow. Using a MutationObserver keeps us decoupled
// from V's internals — any close path (✕ button, swipe, navigation) triggers it.
function _slideshowWatchVpClose() {
  const st = _slideshowState;
  if (!st) return;
  const fs = document.getElementById('gridFullscreen');
  if (!fs) return;
  if (st._vpObserver) { try { st._vpObserver.disconnect(); } catch (_) {} }
  const obs = new MutationObserver(() => {
    if (!_slideshowState) { obs.disconnect(); return; }
    if (fs.style.display === 'none') {
      obs.disconnect();
      if (_slideshowState) _slideshowState._vpObserver = null;
      _slideshowAfterVideoClose();
    }
  });
  obs.observe(fs, { attributes: true, attributeFilter: ['style'] });
  st._vpObserver = obs;
}

function _slideshowAfterVideoClose() {
  const st = _slideshowState;
  if (!st) return;
  // Re-entrancy guard: only the first close-notification for a given video
  // does the resume. Protects against a style mutation arriving twice (or a
  // stale observer) re-triggering the advance.
  if (!st._videoActive) return;
  st._videoActive = false;
  const fs = document.getElementById('gridFullscreen');
  if (fs) fs.style.zIndex = st._prevFsZ || '';
  // (dev0281) Advance in the direction the close gesture asked for: R→L flick
  // → next (+1), L→R flick → previous (-1). Natural end / ✕ default to +1.
  const dir = st._closeDir || 1;
  st._closeDir = 1;
  // A single-slide show with one video would just relaunch V forever on close;
  // treat closing as exit instead. Otherwise advance.
  if (st.slides.length <= 1) { slideshowClose(); return; }
  _slideshowAdvance(dir);
}

// (dev0281) Called by the V player (vp.js) when a horizontal flick on a
// slideshow video should navigate: dir = +1 (R→L = next) or -1 (L→R = prev).
// V follows this with vpClose(); the observer then advances in this direction.
// No-op outside an active slideshow video so standalone V is unaffected.
window._slideshowVideoSwipe = function (dir) {
  if (_slideshowState && _slideshowState._videoActive) {
    _slideshowState._closeDir = (dir < 0) ? -1 : 1;
  }
};

// (dev0281) Called by vpClose (vp.js) just before it tears down _vpState, so
// the user's mute / speed / A-B choices survive into the next video this
// session. Keyed per-URL for A-B; mute + speed are session-global.
window._slideshowCaptureVp = function (vp) {
  const st = _slideshowState;
  if (!st || !vp) return;
  const sess = st._vpSession || (st._vpSession = { muted: null, speed: null, ab: {} });
  sess.muted = !!vp.muted;
  if (typeof vp.speed === 'number') sess.speed = vp.speed;
  const url = (vp.row && vp.row.link) ? vp.row.link : null;
  if (url) {
    if (vp.aPoint != null && vp.bPoint != null) sess.ab[url] = { a: vp.aPoint, b: vp.bPoint };
    else delete sess.ab[url]; // A-B cleared → forget it
  }
};

function _slideshowKey(e) {
  if (!_slideshowState) return;
  // (dev0279) While a video plays, the V player owns the keyboard (Space,
  // arrows for frame-step, M). Stand down so we don't double-handle.
  if (_slideshowState._videoActive) return;
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopImmediatePropagation();
    slideshowClose();
  } else if (e.key === 'ArrowRight' || e.key === ' ') {
    e.preventDefault();
    _slideshowAdvance(+1);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    _slideshowAdvance(-1);
  }
}

// Show slide `i`. With `opts.initial=true` skips the crossfade and just sets
// the front layer's opacity to 1 once it loads. Otherwise loads into the back
// layer and crossfades.
function _slideshowShow(i, opts) {
  if (!_slideshowState) return;
  const st = _slideshowState;
  opts = opts || {};
  st.idx = i;
  const slide = st.slides[i];

  const statusEl  = st.overlay.querySelector('#slideshowStatus');
  const counterEl = st.overlay.querySelector('#slideshowCounter');

  counterEl.textContent = (i + 1) + ' / ' + st.slides.length;

  // (dev0262) Reset any manual pinch-zoom override when navigating to a new
  // slide. The next slide should start at its normal scale, not inherit the
  // previous slide's pinched scale/pan.
  st._manualZoom = null;
  st._mouseZoom  = null; // (dev0265) desktop hold-LMB zoom — fresh per slide

  clearTimeout(st.timer);
  clearTimeout(st.delayTimer); // (zip0239) drop any pending pre-zoom delay

  // (dev0279) Video slide → hand off to the full V player rather than the
  // image crossfade path. Auto-advance is suspended while V is up; the show
  // resumes when V closes (see _slideshowAfterVideoClose).
  if (slide && slide.kind === 'video') {
    _slideshowPlayVideo(slide);
    return;
  }

  // Decide which layer to load into. Initial paint → front layer; otherwise
  // back layer (so old image stays visible until the new one is ready).
  const frontEl = st.overlay.querySelector('#slideshowImg' + st.front);
  const backLetter = st.front === 'A' ? 'B' : 'A';
  const backEl  = st.overlay.querySelector('#slideshowImg' + backLetter);
  const targetLetter = opts.initial ? st.front : backLetter;
  const targetEl = opts.initial ? frontEl : backEl;
  const targetBg = st.overlay.querySelector('#slideshowBg' + targetLetter);

  // (zip0237/0238) Reset the target fg layer to scale(1) at the centered
  // position with transitions OFF, so we don't see it shrink/slide back from
  // its previous zoomed-and-panned state. Force reflow, then restore
  // transitions so the upcoming opacity + zoom-pan animations run.
  targetEl.style.transition = 'none';
  targetEl.style.transform  = 'translate(0,0) scale(1)';
  void targetEl.offsetHeight; // flush reflow
  _slideshowApplyTransitionTiming();

  // Show status until image loads (only visible if both layers are blank).
  if (opts.initial) statusEl.style.display = 'block';

  const myIdx = i;
  targetEl.onload = () => {
    if (!_slideshowState || _slideshowState.idx !== myIdx) return;
    slide.status = 'ready';
    statusEl.style.display = 'none';

    const blurOn = st.settings.canvasBlur !== 'off';

    if (opts.initial) {
      frontEl.style.opacity = '1';
      if (targetBg && blurOn) targetBg.style.opacity = '1';
    } else {
      // Crossfade: bring back fg+bg layer to 1, fade front fg+bg to 0,
      // then swap the front pointer.
      backEl.style.opacity = '1';
      frontEl.style.opacity = '0';
      const frontBg = st.overlay.querySelector('#slideshowBg' + st.front);
      if (frontBg) frontBg.style.opacity = '0';
      if (targetBg && blurOn) targetBg.style.opacity = '1';
      const swapMs = st.settings.transitionSec * 1000;
      setTimeout(() => {
        if (!_slideshowState) return;
        st.front = backLetter;
      }, swapMs + 30);
    }

    // (zip0237) Kick off the zoom animation. Setting the new transform value
    // in a rAF (so the browser commits the scale(1) start state first) makes
    // the transition fire reliably.
    // (zip0238) If pan is on, ensure this slide has a target — random if the
    // user hasn't tapped to aim. Then animate to the combined zoom+pan
    // transform (computePanTransform handles the math).
    if (st.settings.pan !== 'off' && !slide.panTarget) {
      slide.panTarget = _slideshowPickRandomPanTarget();
    }
    let targetScale = _slideshowZoomScale(st.settings.zoom);
    if (targetScale === 0) targetScale = _slideshowSuperMaxScale(targetEl);
    const triggerZoom = () => {
      if (!_slideshowState || _slideshowState.idx !== myIdx) return;
      requestAnimationFrame(() => {
        if (!_slideshowState || _slideshowState.idx !== myIdx) return;
        targetEl.style.transform = _slideshowComputePanTransform(targetScale);
      });
    };
    if (targetScale > 1.0) {
      // (zip0239) `delaySec` pauses the zoom/pan animation start so the
      // slide sits motionless for a moment before the Ken Burns kicks in.
      // Cleared by clearTimeout(st.delayTimer) on advance/close.
      clearTimeout(st.delayTimer);
      const delayMs = Math.max(0, (st.settings.delaySec || 0) * 1000);
      if (delayMs > 0) {
        st.delayTimer = setTimeout(triggerZoom, delayMs);
      } else {
        triggerZoom();
      }
    }

    _slideshowUpdateLabel(slide);

    // Hook for future MPix filter:
    //   const mpix = (targetEl.naturalWidth * targetEl.naturalHeight) / 1e6;
    //   if (mpix < threshold) { slide.status = 'filtered'; _slideshowAdvance(+1); return; }

    // (zip0236) Skip scheduling the auto-advance while paused. Resume button
    // re-arms the timer with a fresh slideSec dwell.
    if (!st.paused) {
      const dwellMs = st.settings.slideSec * 1000;
      st.timer = setTimeout(() => _slideshowAdvance(+1), dwellMs);
    }
  };
  targetEl.onerror = () => {
    if (!_slideshowState || _slideshowState.idx !== myIdx) return;
    slide.status = 'error';
    _slideshowAdvance(+1);
  };

  // (zip0237) Always load src into the bg layer too — that way, if the user
  // toggles canvasBlur on mid-slide, the blur appears immediately rather
  // than waiting for the next slide.
  slide.status = 'loading';
  targetEl.src = slide.url;
  if (targetBg) targetBg.src = slide.url;
  // Pre-set the bg filter so it matches the current setting (in case the
  // global filter wasn't applied yet — e.g. very first slide).
  if (targetBg) {
    const px = _slideshowBlurPx(st.settings.canvasBlur);
    targetBg.style.filter = px > 0 ? ('blur(' + px + 'px)') : 'none';
  }
}

// (dev0265) Size buckets for label/comment overlays. 'largest' = giant text
// that spans the full screen — pinned to viewport center, wraps if needed.
function _slideshowSizePx(size, kind) {
  // kind: 'label' or 'comment'. label has a slightly larger base.
  const base = kind === 'label' ? 20 : 15;
  if (size === 'small')   return base;
  if (size === 'med')     return base + 4;
  if (size === 'large')   return base + 10;
  if (size === 'largest') return 0; // sentinel: handled separately
  return 0;
}

function _slideshowUpdateLabel(slide) {
  if (!_slideshowState) return;
  const st = _slideshowState;
  const labelEl   = st.overlay.querySelector('#slideshowLabel');
  const commentEl = st.overlay.querySelector('#slideshowComment');
  const row = slide && slide.row;
  const ls = st.settings.labelSize   || 'off';
  const cs = st.settings.commentSize || 'off';
  const labelText   = (ls !== 'off' && row && row.VidTitle) ? String(row.VidTitle) : '';
  const commentText = (cs !== 'off' && row && row.comment)  ? String(row.comment)  : '';

  _slideshowStyleOverlayText(labelEl,   ls, 'label',   labelText);
  _slideshowStyleOverlayText(commentEl, cs, 'comment', commentText);
}

function _slideshowStyleOverlayText(el, size, kind, text) {
  if (!el) return;
  el.textContent = text;
  el.style.opacity = text ? '1' : '0';
  if (!text || size === 'off') return;
  if (size === 'largest') {
    // Full-screen overlay: centered, line-height 1.1, ~10vw font (caps at
    // ~12vh so very tall windows don't go absurd). Word-wraps inside viewport.
    Object.assign(el.style, {
      top: '0', bottom: '0', left: '0', right: '0',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      textAlign: 'center', padding: '4vw',
      fontSize: 'min(12vh, 10vw)', lineHeight: '1.1',
      fontWeight: 'bold',
      color: kind === 'label' ? '#fff' : '#ddd'
    });
  } else {
    const px = _slideshowSizePx(size, kind);
    // Restore positional defaults that 'largest' may have overridden.
    if (kind === 'label') {
      Object.assign(el.style, {
        top: '14px', bottom: '', left: '0', right: '0',
        display: '', alignItems: '', justifyContent: '',
        textAlign: 'center', padding: '0 60px',
        fontSize: px + 'px', lineHeight: '',
        fontWeight: 'bold', color: '#fff'
      });
    } else {
      Object.assign(el.style, {
        top: '', bottom: '36px', left: '0', right: '0',
        display: '', alignItems: '', justifyContent: '',
        textAlign: 'center', padding: '0 60px',
        fontSize: px + 'px', lineHeight: '',
        fontWeight: '', color: '#ddd'
      });
    }
  }
}

// Step idx by `step` (+1 or -1), skipping `filtered`/`error` slides. Respects
// loop:false (stops at the ends).
function _slideshowAdvance(step) {
  if (!_slideshowState) return;
  const st = _slideshowState;
  const n = st.slides.length;
  if (!n) return;

  let next = st.idx;
  for (let tried = 0; tried < n; tried++) {
    next += step;
    if (next < 0 || next >= n) {
      if (!st.settings.loop) {
        // End of slideshow — pause, leave current slide up.
        clearTimeout(st.timer);
        if (typeof toast === 'function') toast('Slideshow ended.', 1500);
        return;
      }
      next = (next + n) % n;
    }
    const s = st.slides[next];
    if (s.status === 'filtered' || s.status === 'error') continue;
    _slideshowShow(next);
    return;
  }
  // Everything filtered/errored.
  if (typeof toast === 'function') toast('No viewable images.', 1800);
  slideshowClose();
}

// (dev0268) ── Pause / resume helpers ─────────────────────────────────────
// Three entry points now want to flip the paused state: the menu Pause
// button, zoom-induced auto-pause (mouse hold or pinch), and the single-
// tap-resume gesture. Centralizing keeps the button visual in sync no
// matter who triggered it.
function _slideshowPause() {
  const st = _slideshowState;
  if (!st || st.paused) return;
  st.paused = true;
  clearTimeout(st.timer);
  clearTimeout(st.delayTimer);
  _slideshowSyncPauseBtn();
}

function _slideshowResume() {
  const st = _slideshowState;
  if (!st || !st.paused) return;
  st.paused = false;
  _slideshowSyncPauseBtn();
  const dwellMs = st.settings.slideSec * 1000;
  st.timer = setTimeout(() => _slideshowAdvance(+1), dwellMs);
}

function _slideshowSyncPauseBtn() {
  const st = _slideshowState;
  if (!st || !st.menu) return;
  const btn = st.menu.querySelector('#ssPause');
  if (!btn) return;
  if (st.paused) {
    btn.textContent = '▶ Resume';
    btn.style.borderColor = '#fc8';
    btn.style.color = '#fc8';
    btn.style.background = 'rgba(80,40,0,0.45)';
  } else {
    btn.textContent = '⏸ Pause';
    btn.style.borderColor = '#8ef';
    btn.style.color = '#8ef';
    btn.style.background = 'rgba(0,40,80,0.45)';
  }
}

function _slideshowUpdateCounter() {
  const st = _slideshowState;
  if (!st) return;
  const el = st.overlay.querySelector('#slideshowCounter');
  if (el) el.textContent = (st.idx + 1) + ' / ' + st.slides.length;
}

// (dev0268) Apply a live Order setting change to the running slideshow
// (was: deferred to next slideshowOpen* call). Keeps the visible slide on
// screen — only the surrounding sequence rearranges. Random uses an
// in-place shuffle; In-order restores from the snapshot captured at start.
function _slideshowApplyOrderChange() {
  const st = _slideshowState;
  if (!st || !st.slides.length) return;
  const curUrl = (st.idx >= 0 && st.slides[st.idx]) ? st.slides[st.idx].url : null;
  if (st.settings.order === 'random') {
    _slideshowShuffle(st.slides);
  } else if (st._inOrderSnapshot) {
    st.slides = st._inOrderSnapshot.map(s => Object.assign({}, s, { status: 'pending' }));
  }
  // Re-locate the visible slide in the new array so the next advance
  // picks up from the right place, and mark it ready (its image is
  // already loaded into the front layer).
  if (curUrl) {
    for (let i = 0; i < st.slides.length; i++) {
      if (st.slides[i].url === curUrl) {
        st.slides[i].status = 'ready';
        st.idx = i;
        break;
      }
    }
  }
  _slideshowUpdateCounter();
}

// (dev0279) Apply a live Show ('image'|'video'|'both') change. Re-derives the
// working set from the full canonical list (_allSlides), preserving Order. If
// the currently-visible slide survives the filter it stays on screen; otherwise
// we jump to the first slide of the new set (which may launch the V player).
function _slideshowApplyShowChange() {
  const st = _slideshowState;
  if (!st) return;
  const all = st._allSlides || [];
  const filtered = _slideshowFilterByShow(all, st.settings.showMode);
  if (!filtered.length) {
    if (typeof toast === 'function') {
      toast('No ' + (st.settings.showMode === 'video' ? 'videos' : 'images')
            + ' in this slideshow.', 2000);
    }
    return; // leave the current set untouched
  }
  const curUrl = (st.idx >= 0 && st.slides[st.idx]) ? st.slides[st.idx].url : null;
  st._inOrderSnapshot = filtered.map(s => Object.assign({}, s, { status: 'pending' }));
  st.slides = (st.settings.order === 'random')
    ? _slideshowShuffle(filtered.map(s => Object.assign({}, s, { status: 'pending' })))
    : filtered.map(s => Object.assign({}, s, { status: 'pending' }));

  let newIdx = -1;
  if (curUrl) {
    for (let i = 0; i < st.slides.length; i++) {
      if (st.slides[i].url === curUrl) { newIdx = i; break; }
    }
  }
  if (newIdx >= 0) {
    // Current slide survives — keep it on screen, just re-anchor the index.
    st.slides[newIdx].status = 'ready';
    st.idx = newIdx;
    _slideshowUpdateCounter();
  } else {
    // Current slide filtered out — show the first slide of the new set.
    st.idx = -1;
    _slideshowUpdateCounter();
    _slideshowShow(0);
  }
}

// (dev0268) Swap the active slideset to the images embedded in the current
// slide's row.ftext — but ONLY if the visible slide's URL is itself one of
// those ftext images. Link images aren't in ftext, so they can't trigger.
// Stays paused; user resumes with a tap. Silent (returns false) when not
// applicable so callers can suppress the message.
function _slideshowMaybeSwitchToFtextSet() {
  const st = _slideshowState;
  if (!st || st.idx < 0) return false;
  const slide = st.slides[st.idx];
  if (!slide || !slide.row || !slide.row.ftext) return false;
  if (st._ftextMode) return false;                  // already switched
  const urls = _slideshowExtractImgs(slide.row.ftext);
  if (!urls.length) return false;
  const inFtext = urls.indexOf(slide.url);
  if (inFtext < 0) return false;                    // current slide not part of ftext
  st._beforeFtextSlides   = st.slides;
  st._beforeFtextSnapshot = st._inOrderSnapshot;
  st._beforeFtextIdx      = st.idx;
  st._ftextMode = true;
  const newSlides = urls.map(u => ({
    url: u, row: slide.row, kind: 'image',
    status: u === slide.url ? 'ready' : 'pending'
  }));
  st.slides = newSlides;
  st._inOrderSnapshot = newSlides.map(s => Object.assign({}, s, { status: 'pending' }));
  st.idx = inFtext;
  _slideshowUpdateCounter();
  if (typeof toast === 'function') {
    toast('Slideset → ' + urls.length + ' image' + (urls.length === 1 ? '' : 's')
          + ' from this slide. Tap to play.', 2400);
  }
  return true;
}

// (dev0268) Counterpart to the switch above — gesture down restores the
// slideset that was active before the ftext switch.
function _slideshowMaybeRestoreOriginalSet() {
  const st = _slideshowState;
  if (!st || !st._ftextMode || !st._beforeFtextSlides) return false;
  const curUrl = (st.idx >= 0 && st.slides[st.idx]) ? st.slides[st.idx].url : null;
  st.slides = st._beforeFtextSlides;
  st._inOrderSnapshot = st._beforeFtextSnapshot;
  st._beforeFtextSlides = null;
  st._beforeFtextSnapshot = null;
  st._ftextMode = false;
  let newIdx = -1;
  if (curUrl) {
    for (let i = 0; i < st.slides.length; i++) {
      if (st.slides[i].url === curUrl) { newIdx = i; break; }
    }
  }
  st.idx = newIdx >= 0 ? newIdx : Math.max(0, st._beforeFtextIdx || 0);
  st._beforeFtextIdx = -1;
  if (newIdx >= 0) st.slides[newIdx].status = 'ready';
  _slideshowUpdateCounter();
  if (typeof toast === 'function') toast('Returned to original slideset. Tap to play.', 2000);
  return true;
}

function slideshowClose() {
  if (!_slideshowState) return;
  clearTimeout(_slideshowState.timer);
  clearTimeout(_slideshowState.delayTimer); // (zip0239) cancel any queued zoom
  // (dev0279) Stop watching the V player and undo our z-index lift if a video
  // hand-off was in flight when the show was closed.
  if (_slideshowState._vpObserver) {
    try { _slideshowState._vpObserver.disconnect(); } catch (_) {}
    _slideshowState._vpObserver = null;
  }
  // (dev0281) If a video was playing, the observer is now disconnected, so
  // close the V player ourselves and undo the z-index lift. (Closing from the
  // always-on-top menu's ✕ must tear down both layers.)
  const _fs = document.getElementById('gridFullscreen');
  if (_fs && _slideshowState._videoActive) {
    _fs.style.zIndex = _slideshowState._prevFsZ || '';
    if (typeof vpClose === 'function') vpClose();
  }
  document.removeEventListener('keydown', _slideshowKey, true);
  // (dev0281) Menu + stub are siblings of the overlay now — remove explicitly.
  if (_slideshowState.menu && _slideshowState.menu.parentNode) _slideshowState.menu.remove();
  if (_slideshowState.collapsedStub && _slideshowState.collapsedStub.parentNode) _slideshowState.collapsedStub.remove();
  if (_slideshowState.overlay && _slideshowState.overlay.parentNode) {
    _slideshowState.overlay.remove();
  }
  _slideshowState = null;
}

// ── Settings menu ───────────────────────────────────────────────────────────

function _slideshowOpenMenu() {
  if (!_slideshowState || _slideshowState.menu) return;
  const settings = _slideshowState.settings;

  // (zip0239) On cellphone/mobile, reduce font sizes by 1 px so the menu
  // takes less vertical room and feels less heavy on small screens.
  const mobile = (typeof _isMobileDevice === 'function') ? _isMobileDevice() : false;
  const baseFs = mobile ? 11 : 13;
  const bigFs  = mobile ? 12 : 14;
  const pad    = mobile ? '10px 12px' : '12px 14px';

  const menu = document.createElement('div');
  menu.id = 'slideshowMenu';
  // (zip0236) Positioned on the right side, vertically centered. Narrower
  // than before so it doesn't block the image. Hugs the right edge with a
  // small gap so the ⚙ gear button (top-right) stays tappable.
  menu.style.cssText = [
    'position:absolute', 'right:16px', 'top:50%',
    'transform:translateY(-50%)',
    'background:rgba(14,14,28,0.94)',
    'border:1px solid #4af', 'border-radius:10px',
    'padding:' + pad, 'min-width:200px', 'max-width:240px',
    'color:#eee', 'font-family:monospace', 'font-size:' + baseFs + 'px',
    'box-shadow:0 8px 32px rgba(0,0,0,0.9)',
    'z-index:' + SLIDESHOW_MENU_Z
  ].join(';') + ';';

  menu.innerHTML = _slideshowMenuHtml(settings, baseFs, bigFs);
  // (dev0281) Mount as a SIBLING of the overlay (in its parent) so it can paint
  // above the video layer, which lives outside the overlay's stacking context.
  (_slideshowState.overlay.parentNode || document.body).appendChild(menu);
  _slideshowState.menu = menu;

  _slideshowWireMenu(menu);
}

function _slideshowCloseMenu() {
  if (!_slideshowState || !_slideshowState.menu) return;
  _slideshowState.menu.remove();
  _slideshowState.menu = null;
}

// Collapse the menu in place: hide every row except the collapse button itself
// (which lives in the first-row Start+collapse flex). Tapping the button again
// (now showing "+") restores. Original sizing is stashed in dataset and put
// back on expand.
// (dev0265) Collapse to a "+" stub; expand by tearing down and rebuilding the
// menu from the current settings. The rebuild guarantees that any new rows
// (Close, Order, page-2 controls, pager) appear on re-expand — the previous
// just-hide-children approach was prone to stale state on mobile pagination.
function _slideshowToggleCollapse() {
  if (!_slideshowState) return;
  const st = _slideshowState;
  if (st.menuCollapsed) {
    st.menuCollapsed = false;
    if (st.collapsedStub && st.collapsedStub.parentNode) st.collapsedStub.remove();
    st.collapsedStub = null;
    _slideshowOpenMenu();
    return;
  }
  // Collapse: drop the menu entirely, leave a small "+" button in its place.
  st.menuCollapsed = true;
  if (st.menu && st.menu.parentNode) st.menu.remove();
  st.menu = null;
  const stub = document.createElement('button');
  stub.id = 'slideshowMenuStub';
  stub.title = 'Expand settings';
  stub.textContent = '+';
  stub.style.cssText = [
    'position:absolute', 'right:16px', 'top:50%',
    'transform:translateY(-50%)',
    'background:rgba(0,0,0,0.55)', 'color:#aaa',
    'border:1px solid rgba(255,255,255,0.35)', 'border-radius:6px',
    'padding:4px 9px', 'font-family:monospace', 'font-size:16px',
    'cursor:pointer', 'z-index:' + SLIDESHOW_MENU_Z, 'line-height:1'
  ].join(';') + ';';
  stub.onclick = e => { e.stopPropagation(); _slideshowToggleCollapse(); };
  // (dev0281) Sibling of the overlay (see _slideshowOpenMenu) so the collapsed
  // "+" stays tappable over a playing video too.
  (st.overlay.parentNode || document.body).appendChild(stub);
  st.collapsedStub = stub;
}

// (dev0265) Reusable size dropdown for Title/Comment overlays.
function _slideshowSizeSelect(id, cur, selCSS) {
  const opts = ['off','small','med','large','largest'];
  return '<select id="' + id + '" style="' + selCSS + '">' +
    opts.map(o => '<option value="' + o + '"' + (cur === o ? ' selected' : '') + '>' + o + '</option>').join('') +
    '</select>';
}

// (dev0279) Show dropdown — which media kinds appear in the slideshow.
function _slideshowShowSelect(id, cur, selCSS) {
  const opts = [['image','Image only'],['video','Video only'],['both','Both']];
  return '<select id="' + id + '" style="' + selCSS + '">' +
    opts.map(o => '<option value="' + o[0] + '"' + (cur === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') +
    '</select>';
}

function _slideshowMenuHtml(s, baseFs, bigFs) {
  baseFs = baseFs || 13;
  bigFs  = bigFs  || 14;

  const rowCSS  = 'display:flex;align-items:center;justify-content:space-between;'
                + 'padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06);'
                + 'gap:8px;';
  const numCSS  = 'width:48px;padding:3px 5px;font-family:monospace;font-size:' + baseFs + 'px;'
                + 'background:#0a0a1a;border:1px solid #4af;color:#fff;border-radius:4px;'
                + 'text-align:center;outline:none;';
  const selCSS  = 'padding:3px 6px;font-family:monospace;font-size:' + baseFs + 'px;'
                + 'background:#0a0a1a;border:1px solid #4af;color:#fff;border-radius:4px;'
                + 'outline:none;cursor:pointer;';
  const togCSS  = (on) => 'padding:3px 12px;border-radius:5px;cursor:pointer;'
                + 'font-family:monospace;font-size:' + baseFs + 'px;font-weight:bold;border:1px solid;'
                + (on ? 'border-color:#5f5;color:#afa;background:rgba(0,80,0,0.4);'
                      : 'border-color:#666;color:#888;background:rgba(40,40,50,0.4);');
  // 4-state level select (off/min/med/max) — used for Pan and CanvasBlur.
  const lvl = (cur) => `
        <select id="$ID" style="${selCSS}">
          <option value="off"${cur==='off'?' selected':''}>off</option>
          <option value="min"${cur==='min'?' selected':''}>min</option>
          <option value="med"${cur==='med'?' selected':''}>med</option>
          <option value="max"${cur==='max'?' selected':''}>max</option>
        </select>`;
  // 5-state zoom select — adds supermax for adaptive 1:1 pixel zoom.
  const lvlZoom = (cur) => `
        <select id="$ID" style="${selCSS}">
          <option value="off"${cur==='off'?' selected':''}>off</option>
          <option value="min"${cur==='min'?' selected':''}>min</option>
          <option value="med"${cur==='med'?' selected':''}>med</option>
          <option value="max"${cur==='max'?' selected':''}>max</option>
          <option value="supermax"${cur==='supermax'?' selected':''}>supermax</option>
        </select>`;

  const paused = !!(_slideshowState && _slideshowState.paused);
  const pauseCSS = paused
    ? 'border-color:#fc8;color:#fc8;background:rgba(80,40,0,0.45);'
    : 'border-color:#8ef;color:#8ef;background:rgba(0,40,80,0.45);';

  // (dev0282) Source dropdown. "Grid" is offered only when a grid is open
  // (otherwise switching to it would just fail and leave nothing playing).
  // "Folder…" picks/uses an external read-only folder anywhere on disk.
  const srcKind = (_slideshowState && _slideshowState.sourceKind) || '';
  const _g = document.getElementById('gridOverlay');
  const gridAvail = (_g && getComputedStyle(_g).display !== 'none') || srcKind === 'grid';
  const folderLabel = _ssSourceName
    ? ('📁 ' + (_ssSourceName.length > 12 ? _ssSourceName.slice(0, 11) + '…' : _ssSourceName))
    : 'Folder…';
  const srcOpts = [];
  if (gridAvail) srcOpts.push(['grid', 'Grid']);
  srcOpts.push(['jpgs', 'Project jpgs']);
  srcOpts.push(['folder', folderLabel]);
  const sourceSelect = '<select id="ssSource" style="' + selCSS + '">' +
    srcOpts.map(o => '<option value="' + o[0] + '"' + (srcKind === o[0] ? ' selected' : '') +
      '>' + o[1] + '</option>').join('') + '</select>';

  return `
    <div style="display:flex;align-items:center;gap:5px;margin-bottom:5px;">
      <button id="ssStart" style="flex:1;padding:4px 8px;border-radius:6px;
              border:1px solid #5f5;background:rgba(0,100,0,0.45);color:#afa;
              cursor:pointer;font-family:monospace;font-size:${bigFs}px;font-weight:bold;">
        Start ▶▶
      </button>
      <button id="ssMenuCollapse" title="Collapse"
              style="padding:4px 7px;border-radius:5px;
                     border:1px solid rgba(255,255,255,0.25);
                     background:rgba(0,0,0,0.35);color:#aaa;cursor:pointer;
                     font-family:monospace;font-size:${bigFs}px;line-height:1;">−</button>
    </div>
    <button id="ssPause" style="display:block;width:100%;padding:4px 8px;
            margin-bottom:6px;border-radius:6px;
            border:1px solid;${pauseCSS}
            cursor:pointer;font-family:monospace;font-size:${bigFs}px;font-weight:bold;">
      ${paused ? '▶ Resume' : '⏸ Pause'}
    </button>
    <button id="ssClose" style="display:block;width:100%;padding:4px 8px;
            margin-bottom:8px;border-radius:6px;
            border:1px solid #f88;color:#fbb;background:rgba(80,0,0,0.45);
            cursor:pointer;font-family:monospace;font-size:${bigFs}px;font-weight:bold;">
      ✕ Close
    </button>

    <div class="ss-row ss-page-1" style="${rowCSS}">
      <span>Source</span>
      <span style="display:flex;align-items:center;gap:5px;">
        ${sourceSelect}
        <button id="ssSourcePick" title="Choose a folder on your computer (read-only)"
                style="padding:3px 8px;border-radius:4px;border:1px solid #4af;
                       background:rgba(0,40,80,0.45);color:#8ef;cursor:pointer;
                       font-family:monospace;font-size:${baseFs}px;line-height:1;">📁</button>
      </span>
    </div>

    <div class="ss-row ss-page-1" style="${rowCSS}">
      <span>Show</span>
      ${_slideshowShowSelect('ssShowMode', s.showMode, selCSS)}
    </div>

    <div class="ss-row ss-page-1" style="${rowCSS}">
      <span>Each slide</span>
      <span><input id="ssSlideSec"  type="number" min="0.5" max="60" step="0.5"
                   inputmode="decimal" value="${s.slideSec}"
                   style="${numCSS}"> sec</span>
    </div>

    <div class="ss-row ss-page-1" style="${rowCSS}">
      <span>Zoom</span>
      <span><input id="ssZoomSec"   type="number" min="0.5" max="60" step="0.5"
                   inputmode="decimal" value="${s.zoomSec}"
                   style="${numCSS}"> sec</span>
    </div>

    <div class="ss-row ss-page-1" style="${rowCSS}">
      <span>Zoom</span>
      ${lvlZoom(s.zoom).replace('$ID', 'ssZoomLevel')}
    </div>

    <div class="ss-row ss-page-1" style="${rowCSS}">
      <span>Transition</span>
      <span><input id="ssTransSec"  type="number" min="0" max="10" step="0.1"
                   inputmode="decimal" value="${s.transitionSec}"
                   style="${numCSS}"> sec</span>
    </div>

    <div class="ss-row ss-page-1" style="${rowCSS}">
      <span>Delay</span>
      <span><input id="ssDelaySec"  type="number" min="0" max="30" step="0.1"
                   inputmode="decimal" value="${s.delaySec}"
                   style="${numCSS}"> sec</span>
    </div>

    <div class="ss-row ss-page-1" style="${rowCSS}">
      <span>Loop</span>
      <button class="ss-tog" data-key="loop"    style="${togCSS(s.loop)}">${s.loop?'ON':'OFF'}</button>
    </div>

    <div class="ss-row ss-page-2" style="${rowCSS}">
      <span>Pan</span>
      ${lvl(s.pan).replace('$ID', 'ssPan')}
    </div>

    <div class="ss-row ss-page-2" style="${rowCSS}">
      <span>Title</span>
      ${_slideshowSizeSelect('ssLabelSize', s.labelSize, selCSS)}
    </div>

    <div class="ss-row ss-page-2" style="${rowCSS}">
      <span>Comment</span>
      ${_slideshowSizeSelect('ssCommentSize', s.commentSize, selCSS)}
    </div>

    <div class="ss-row ss-page-2" style="${rowCSS}">
      <span>Order</span>
      <button id="ssOrder" style="${togCSS(true)}">
        ${s.order === 'order' ? 'IN ORDER' : 'RANDOM'}
      </button>
    </div>

    <div class="ss-row ss-page-2" style="${rowCSS};border-bottom:none;">
      <span>CanvasBlur</span>
      ${lvl(s.canvasBlur).replace('$ID', 'ssCanvasBlur')}
    </div>

    <div id="ssPager" style="display:none;align-items:center;justify-content:space-between;
         margin-top:6px;padding-top:5px;border-top:1px solid rgba(255,255,255,0.18);">
      <button id="ssPagePrev" style="padding:3px 10px;border-radius:5px;
              border:1px solid #4af;background:rgba(0,40,80,0.45);color:#8ef;
              cursor:pointer;font-family:monospace;font-size:${bigFs}px;
              font-weight:bold;">◀</button>
      <span id="ssPageLabel" style="font-size:${baseFs}px;color:#aaa;">1 / 2</span>
      <button id="ssPageNext" style="padding:3px 10px;border-radius:5px;
              border:1px solid #4af;background:rgba(0,40,80,0.45);color:#8ef;
              cursor:pointer;font-family:monospace;font-size:${bigFs}px;
              font-weight:bold;">▶</button>
    </div>
  `;
}

function _slideshowWireMenu(menu) {
  const st = _slideshowState;
  if (!st) return;

  // Start and collapse buttons both collapse the menu in place; tapping
  // the (now-"+") collapse button expands it again. With the top-right ⚙
  // gear removed, this is the only way to manage menu visibility.
  menu.querySelector('#ssStart').onclick = e => {
    e.stopPropagation();
    _slideshowToggleCollapse();
  };
  const collapseBtn = menu.querySelector('#ssMenuCollapse');
  if (collapseBtn) {
    collapseBtn.onclick = e => {
      e.stopPropagation();
      _slideshowToggleCollapse();
    };
  }

  // (dev0265) Close button — exits the slideshow from inside the menu.
  const closeBtn = menu.querySelector('#ssClose');
  if (closeBtn) {
    closeBtn.onclick = e => { e.stopPropagation(); slideshowClose(); };
  }

  // (dev0265) Order toggle — flips between in-order and random. Note: this
  // does NOT reshuffle the currently-playing slides (advancing through a
  // visibly reordered list mid-show is jarring); the new value applies the
  // next time slideshowOpenGrid / slideshowOpenJpgsFolder runs.
  const orderBtn = menu.querySelector('#ssOrder');
  if (orderBtn) {
    orderBtn.onclick = e => {
      e.stopPropagation();
      st.settings.order = (st.settings.order === 'order') ? 'random' : 'order';
      _slideshowSaveSettings(st.settings);
      // (dev0265) Both states are "activated" — just flip the label and
      // leave the green color in place. RANDOM should not look disabled.
      orderBtn.textContent = (st.settings.order === 'order') ? 'IN ORDER' : 'RANDOM';
      // (dev0268) Apply live — was previously deferred to the next
      // slideshow open. The visible slide stays on screen; only the
      // surrounding sequence is shuffled (or restored to in-order).
      _slideshowApplyOrderChange();
    };
  }

  // (dev0265) Mobile pagination — split rows across two pages; ◀ ▶ flip them.
  // Desktop ignores it (all rows visible, pager hidden) so nothing is hidden
  // when the menu fits comfortably.
  const mobile = (typeof _isMobileDevice === 'function') ? _isMobileDevice() : false;
  const pager  = menu.querySelector('#ssPager');
  const pageLabel = menu.querySelector('#ssPageLabel');
  if (mobile && pager) {
    pager.style.display = 'flex';
    let page = 1;
    function applyPage() {
      menu.querySelectorAll('.ss-row').forEach(row => {
        const onPage1 = row.classList.contains('ss-page-1');
        const visible = (page === 1) ? onPage1 : !onPage1;
        row.style.display = visible ? '' : 'none';
      });
      if (pageLabel) pageLabel.textContent = page + ' / 2';
    }
    applyPage();
    menu.querySelector('#ssPagePrev').onclick = e => {
      e.stopPropagation();
      page = page === 1 ? 2 : 1; applyPage();
    };
    menu.querySelector('#ssPageNext').onclick = e => {
      e.stopPropagation();
      page = page === 2 ? 1 : 2; applyPage();
    };
  }

  // Pause/Resume. Capture the button in a const so the handler doesn't
  // depend on e.currentTarget (which has been observed to flake when the
  // click handler is re-entered through bubbling). Also drop any pending
  // delay-timer so a queued zoom doesn't fire after pause.
  // (dev0268) Delegate to the central pause/resume helpers so that the
  // menu Pause button, zoom-induced auto-pause, and single-tap resume
  // all share one source of truth (and keep the button visual in sync).
  const pauseBtn = menu.querySelector('#ssPause');
  if (pauseBtn) {
    pauseBtn.onclick = e => {
      e.stopPropagation();
      if (st.paused) _slideshowResume();
      else           _slideshowPause();
    };
  }

  // Numeric inputs — commit on input event (live) and persist.
  function wireNum(id, key, min, max) {
    const el = menu.querySelector('#' + id);
    if (!el) return;
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      if (isNaN(v)) return;
      const clamped = Math.max(min, Math.min(max, v));
      st.settings[key] = clamped;
      _slideshowSaveSettings(st.settings);
      // (zip0237) Both transitionSec and zoomSec live in the layer
      // `transition` CSS string, so re-apply on either change.
      if (key === 'transitionSec' || key === 'zoomSec') {
        _slideshowApplyTransitionTiming();
      }
      // For slideSec changes, the current dwell timer is already scheduled —
      // the new value takes effect after the next advance. That matches user
      // expectations (current slide finishes its current dwell).
    });
    // Stop bubble so clicks on the spinner don't dismiss the slideshow.
    el.addEventListener('click', e => e.stopPropagation());
  }
  wireNum('ssSlideSec', 'slideSec',     0.5, 60);
  wireNum('ssZoomSec',  'zoomSec',      0.5, 60);
  wireNum('ssTransSec', 'transitionSec', 0,  10);
  wireNum('ssDelaySec', 'delaySec',      0,  30); // (zip0239) pre-animation pause

  // Toggles — flip the boolean, restyle in place, persist, re-apply label.
  menu.querySelectorAll('.ss-tog').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const key = btn.dataset.key;
      st.settings[key] = !st.settings[key];
      _slideshowSaveSettings(st.settings);
      const on = st.settings[key];
      btn.textContent = on ? 'ON' : 'OFF';
      btn.style.cssText = btn.style.cssText.replace(/border-color:[^;]+;color:[^;]+;background:[^;]+;?/, '')
        + (on ? 'border-color:#5f5;color:#afa;background:rgba(0,80,0,0.4);'
              : 'border-color:#666;color:#888;background:rgba(40,40,50,0.4);');
      if (key === 'label' || key === 'comment') {
        _slideshowUpdateLabel(st.slides[st.idx]);
      }
    };
  });

  // Pan select — 4-state (off/min/med/max). Assign a random target when
  // turning on from off so the effect is immediately visible.
  const ssPanSel = menu.querySelector('#ssPan');
  if (ssPanSel) {
    ssPanSel.addEventListener('change', () => {
      st.settings.pan = ssPanSel.value;
      _slideshowSaveSettings(st.settings);
      if (st.settings.pan !== 'off' && st.idx >= 0) {
        const slide = st.slides[st.idx];
        if (slide && !slide.panTarget) slide.panTarget = _slideshowPickRandomPanTarget();
      }
      _slideshowApplyZoom();
    });
    ssPanSel.addEventListener('click', e => e.stopPropagation());
  }

  // (zip0236) Zoom and CanvasBlur dropdowns. (zip0237) Both apply live to
  // the current slide via dedicated apply* helpers — zoom re-targets the
  // front layer's scale, canvasBlur updates filter + opacity on bg layers.
  function wireSelect(id, key, apply) {
    const sel = menu.querySelector('#' + id);
    if (!sel) return;
    sel.addEventListener('change', () => {
      st.settings[key] = sel.value;
      _slideshowSaveSettings(st.settings);
      if (typeof apply === 'function') apply();
    });
    sel.addEventListener('click', e => e.stopPropagation());
  }
  wireSelect('ssZoomLevel',  'zoom',       _slideshowApplyZoom);
  wireSelect('ssCanvasBlur', 'canvasBlur', _slideshowApplyCanvasBlur);
  // (dev0279) Show dropdown — re-filter the working set live (image/video/both).
  wireSelect('ssShowMode',   'showMode',   _slideshowApplyShowChange);
  // (dev0265) Title/Comment size dropdowns — re-render overlay text on change.
  const reLabel = () => _slideshowUpdateLabel(st.slides[st.idx]);
  wireSelect('ssLabelSize',   'labelSize',   reLabel);
  wireSelect('ssCommentSize', 'commentSize', reLabel);

  // (dev0283) Source dropdown — switching reloads the show from the chosen
  // source. The openers are now non-destructive: each acquires its slides
  // first and only swaps the show in once they're ready, so the current show
  // keeps playing during the switch (no flash of the grid/table behind).
  // For "folder" we reuse the saved handle; the 📁 button always opens the picker.
  const srcSel = menu.querySelector('#ssSource');
  if (srcSel) {
    srcSel.addEventListener('change', () => {
      const v = srcSel.value;
      if (v === 'grid')        slideshowOpenGrid();
      else if (v === 'jpgs')   slideshowOpenJpgsFolder();
      // Reuse the saved folder if there is one; otherwise the picker opens.
      else if (v === 'folder') slideshowOpenSourceFolder(!!_ssSourceName);
    });
    srcSel.addEventListener('click', e => e.stopPropagation());
  }
  const srcPick = menu.querySelector('#ssSourcePick');
  if (srcPick) {
    // 📁 always opens the picker so the user can choose a different folder.
    srcPick.onclick = e => { e.stopPropagation(); slideshowOpenSourceFolder(false); };
  }

  // Clicking on the menu background shouldn't dismiss either.
  menu.addEventListener('click', e => e.stopPropagation());
}

// ── Public hotkey: bare S = play active grid ────────────────────────────────

function _slideshowHotkeyShouldFire() {
  if (_slideshowState) return false;
  const ae = document.activeElement;
  const tag = ae && ae.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
  if (ae && ae.isContentEditable) return false;
  if (document.getElementById('textEditorOverlay'))    return false; // Xe
  if (document.getElementById('video-editor-overlay')) return false; // E
  if (document.getElementById('dictOverlay'))          return false;
  if (document.getElementById('mergeModal'))           return false;
  if (document.getElementById('treeCtxMenu'))          return false;
  if (document.getElementById('chipCtxMenu'))          return false;
  return true;
}

document.addEventListener('keydown', e => {
  if (!e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey &&
      (e.key === 's' || e.key === 'S')) {
    if (!_slideshowHotkeyShouldFire()) return;
    e.preventDefault();
    e.stopPropagation();
    // From G (grid overlay visible) → play grid images. From T (no overlay)
    // → play random images under projectfolder/jpgs/.
    const g = document.getElementById('gridOverlay');
    const gridVisible = g && getComputedStyle(g).display !== 'none';
    if (gridVisible) slideshowOpenGrid();
    else             slideshowOpenJpgsFolder();
  }
}, true);

// Window exposure
window.slideshowOpen             = slideshowOpen;
window.slideshowOpenGrid         = slideshowOpenGrid;
window.slideshowOpenJpgsFolder   = slideshowOpenJpgsFolder;
window.slideshowOpenSourceFolder = slideshowOpenSourceFolder;
window.slideshowClose            = slideshowClose;
