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
  label:         true,
  comment:       false,
  canvasBlur:    'off'    // 'off'|'min'|'med'|'max' (was boolean `bokeh` pre-zip0236)
};
const SLIDESHOW_LS_KEY = 'sal-slideshow-settings';

let _slideshowState = null;

function _slideshowLoadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SLIDESHOW_LS_KEY) || '{}');
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

// Per-cell slides: link image (if image URL) then every embedded ftext image.
function _slideshowCellSlides(row) {
  if (!row) return [];
  const out = [];
  if (_slideshowIsImageLink(row.link)) out.push({ url: row.link, row });
  if (row.ftext) {
    _slideshowExtractImgs(row.ftext).forEach(u => out.push({ url: u, row }));
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
  _slideshowStart(urls.map(u => ({ url: u, row })));
}

function slideshowOpenGrid() {
  if (_slideshowState) return;
  const slides = _slideshowGridSlides();
  if (!slides.length) {
    if (typeof toast === 'function') toast('No image cells in the active grid.', 2000);
    return;
  }
  _slideshowStart(slides);
}

// (dev0241) S from T → play all images under the project folder's jpgs/
// subdirectory, recursively, in random order. Uses the project FSA handle
// (_fsaDir) from core.js. Each image is wrapped as a blob: URL slide.
async function slideshowOpenJpgsFolder() {
  if (_slideshowState) return;
  const root = (typeof _fsaDir !== 'undefined' && _fsaDir) ? _fsaDir : null;
  if (!root) {
    if (typeof toast === 'function') toast('No project folder set — use the 📂 button first.', 2500);
    return;
  }
  try {
    const perm = await root.queryPermission({ mode: 'read' });
    if (perm !== 'granted') {
      const req = await root.requestPermission({ mode: 'read' });
      if (req !== 'granted') {
        if (typeof toast === 'function') toast('Read permission denied.', 2200);
        return;
      }
    }
  } catch (_) {}
  let jpgsDir;
  try {
    jpgsDir = await root.getDirectoryHandle('jpgs', { create: false });
  } catch (e) {
    if (typeof toast === 'function') toast('No "jpgs" folder in project.', 2200);
    return;
  }
  const files = [];
  async function walk(dir) {
    for await (const entry of dir.values()) {
      if (entry.kind === 'directory') await walk(entry);
      else if (/\.(jpe?g|png|gif|webp|avif|bmp)$/i.test(entry.name)) files.push(entry);
    }
  }
  try { await walk(jpgsDir); }
  catch (e) {
    if (typeof toast === 'function') toast('Folder read failed: ' + e.message, 2500);
    return;
  }
  if (!files.length) {
    if (typeof toast === 'function') toast('No images found under jpgs/.', 2200);
    return;
  }
  for (let i = files.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [files[i], files[j]] = [files[j], files[i]];
  }
  const slides = [];
  for (const fh of files) {
    try {
      const file = await fh.getFile();
      slides.push({ url: URL.createObjectURL(file), row: null });
    } catch (_) {}
  }
  if (!slides.length) {
    if (typeof toast === 'function') toast('Could not read any images.', 2200);
    return;
  }
  if (typeof toast === 'function') toast('Playing ' + slides.length + ' image(s) from jpgs/', 1800);
  _slideshowStart(slides);
}

// ── Core machinery ──────────────────────────────────────────────────────────

function _slideshowStart(slides) {
  const settings = _slideshowLoadSettings();

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
    slides: slides.map(s => Object.assign({}, s, { status: 'pending' })),
    idx: -1,
    timer: null,
    settings,
    front: 'A',     // which <img> is currently visible
    menu: null,
    paused: false   // (zip0236) pause/resume from settings menu
  };

  // Apply transition duration to image layers (live, in case settings change)
  _slideshowApplyTransitionTiming();

  // (dev0262) Phone/touch interaction model:
  //   • Single tap: nothing (used to close — too easy to trigger accidentally).
  //     If Pan is on, single tap still sets a pan aim point.
  //   • Double tap: close.
  //   • One-finger swipe L→R (dx > 0): next image. R→L (dx < 0): previous.
  //   • Two-finger spread/pinch (paused only): scale current image in frame.
  //   • Two-finger pan (paused only): pan current image.
  //   • ✕ button and Esc always close.
  // Desktop (mouse) keeps the legacy click-to-close behavior since accidental
  // mouse clicks are rare and there's no scroll/zoom intent to confuse it with.
  overlay.addEventListener('click', e => {
    if (!_slideshowState) return;
    if (e.target.closest('#slideshowMenu')) return;
    if (e.target.closest('#slideshowCloseBtn')) return;
    // Mouse-only click path (touch is handled by pointer handlers below).
    // PointerEvent.pointerType isn't on every click event, so fall back to
    // detecting touch via the last touch flag.
    if (_slideshowState._touchActive) return;
    if (_slideshowState.settings.pan !== 'off') {
      _slideshowSetPanTargetFromEvent(e);
      return;
    }
    slideshowClose();
  });

  // (dev0262) Touch gestures. We use pointer events with pointerType filter so
  // mouse keeps its existing click-to-close (handled above).
  (function wireTouchSlideshow() {
    const _ptrs = new Map(); // id → {x,y}
    let _pinch = null;       // { scale, tx, ty, dist, mx, my }
    let _swipe = null;       // { x, y, t }
    let _lastTap = 0, _lastTapP = null;
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
      }
    }, true);

    overlay.addEventListener('pointermove', e => {
      if (e.pointerType === 'mouse' || !_ptrs.has(e.pointerId)) return;
      const st = _slideshowState; if (!st) return;
      _ptrs.set(e.pointerId, _xy(e));
      if (_ptrs.size >= 2 && _pinch && st.paused) {
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
        if (_swipe) {
          const dx = p.x - _swipe.x, dy = p.y - _swipe.y;
          const ms = Date.now() - _swipe.t;
          // Horizontal swipe → navigate.
          // User spec: R→L = previous, L→R = next.
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) && ms < 800) {
            _swipe = null;
            _slideshowAdvance(dx > 0 ? +1 : -1);
            return;
          }
          // Quick stationary tap → check for double-tap
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
            // Pan-mode single-tap aims the Ken Burns target (unchanged).
            if (st.settings.pan !== 'off') _slideshowSetPanTargetFromEvent(e);
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

function _slideshowKey(e) {
  if (!_slideshowState) return;
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

  clearTimeout(st.timer);
  clearTimeout(st.delayTimer); // (zip0239) drop any pending pre-zoom delay

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

function _slideshowUpdateLabel(slide) {
  if (!_slideshowState) return;
  const st = _slideshowState;
  const labelEl   = st.overlay.querySelector('#slideshowLabel');
  const commentEl = st.overlay.querySelector('#slideshowComment');
  const row = slide && slide.row;
  const labelText   = (st.settings.label   && row && row.VidTitle) ? String(row.VidTitle) : '';
  const commentText = (st.settings.comment && row && row.comment)  ? String(row.comment)  : '';
  labelEl.textContent   = labelText;
  commentEl.textContent = commentText;
  labelEl.style.opacity   = labelText   ? '1' : '0';
  commentEl.style.opacity = commentText ? '1' : '0';
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

function slideshowClose() {
  if (!_slideshowState) return;
  clearTimeout(_slideshowState.timer);
  clearTimeout(_slideshowState.delayTimer); // (zip0239) cancel any queued zoom
  document.removeEventListener('keydown', _slideshowKey, true);
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
    'z-index:40010'
  ].join(';') + ';';

  menu.innerHTML = _slideshowMenuHtml(settings, baseFs, bigFs);
  _slideshowState.overlay.appendChild(menu);
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
function _slideshowToggleCollapse() {
  if (!_slideshowState || !_slideshowState.menu) return;
  const menu = _slideshowState.menu;
  const collapseBtn = menu.querySelector('#ssMenuCollapse');
  if (!collapseBtn) return;
  const startBtn = menu.querySelector('#ssStart');
  const collapsing = !menu.dataset.collapsed;
  if (collapsing) {
    menu.dataset.collapsed   = '1';
    menu.dataset.origPadding  = menu.style.padding;
    menu.dataset.origMinWidth = menu.style.minWidth;
    menu.dataset.origMaxWidth = menu.style.maxWidth;
    Array.from(menu.children).forEach((el, i) => {
      if (i === 0) return;
      el.style.display = 'none';
    });
    if (startBtn) startBtn.style.display = 'none';
    menu.style.padding  = '3px 5px';
    menu.style.minWidth = 'auto';
    menu.style.maxWidth = 'none';
    collapseBtn.textContent = '+';
    collapseBtn.title = 'Expand';
  } else {
    delete menu.dataset.collapsed;
    Array.from(menu.children).forEach((el, i) => {
      if (i === 0) return;
      el.style.display = '';
    });
    if (startBtn) startBtn.style.display = '';
    menu.style.padding  = menu.dataset.origPadding  || '';
    menu.style.minWidth = menu.dataset.origMinWidth || '';
    menu.style.maxWidth = menu.dataset.origMaxWidth || '';
    collapseBtn.textContent = '−';
    collapseBtn.title = 'Collapse';
  }
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
            margin-bottom:8px;border-radius:6px;
            border:1px solid;${pauseCSS}
            cursor:pointer;font-family:monospace;font-size:${bigFs}px;font-weight:bold;">
      ${paused ? '▶ Resume' : '⏸ Pause'}
    </button>

    <div style="${rowCSS}">
      <span>Each slide</span>
      <span><input id="ssSlideSec"  type="number" min="0.5" max="60" step="0.5"
                   inputmode="decimal" value="${s.slideSec}"
                   style="${numCSS}"> sec</span>
    </div>

    <div style="${rowCSS}">
      <span>Zoom</span>
      <span><input id="ssZoomSec"   type="number" min="0.5" max="60" step="0.5"
                   inputmode="decimal" value="${s.zoomSec}"
                   style="${numCSS}"> sec</span>
    </div>

    <div style="${rowCSS}">
      <span>Zoom</span>
      ${lvlZoom(s.zoom).replace('$ID', 'ssZoomLevel')}
    </div>

    <div style="${rowCSS}">
      <span>Transition</span>
      <span><input id="ssTransSec"  type="number" min="0" max="10" step="0.1"
                   inputmode="decimal" value="${s.transitionSec}"
                   style="${numCSS}"> sec</span>
    </div>

    <div style="${rowCSS}">
      <span>Delay</span>
      <span><input id="ssDelaySec"  type="number" min="0" max="30" step="0.1"
                   inputmode="decimal" value="${s.delaySec}"
                   style="${numCSS}"> sec</span>
    </div>

    <div style="${rowCSS}">
      <span>Loop</span>
      <button class="ss-tog" data-key="loop"    style="${togCSS(s.loop)}">${s.loop?'ON':'OFF'}</button>
    </div>

    <div style="${rowCSS}">
      <span>Pan</span>
      ${lvl(s.pan).replace('$ID', 'ssPan')}
    </div>

    <div style="${rowCSS}">
      <span>Label</span>
      <button class="ss-tog" data-key="label"   style="${togCSS(s.label)}">${s.label?'ON':'OFF'}</button>
    </div>

    <div style="${rowCSS}">
      <span>Comment</span>
      <button class="ss-tog" data-key="comment" style="${togCSS(s.comment)}">${s.comment?'ON':'OFF'}</button>
    </div>

    <div style="${rowCSS};border-bottom:none;">
      <span>CanvasBlur</span>
      ${lvl(s.canvasBlur).replace('$ID', 'ssCanvasBlur')}
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

  // Pause/Resume. Capture the button in a const so the handler doesn't
  // depend on e.currentTarget (which has been observed to flake when the
  // click handler is re-entered through bubbling). Also drop any pending
  // delay-timer so a queued zoom doesn't fire after pause.
  const pauseBtn = menu.querySelector('#ssPause');
  if (pauseBtn) {
    pauseBtn.onclick = e => {
      e.stopPropagation();
      if (!st.paused) {
        st.paused = true;
        clearTimeout(st.timer);
        clearTimeout(st.delayTimer);
        pauseBtn.textContent = '▶ Resume';
        pauseBtn.style.borderColor = '#fc8';
        pauseBtn.style.color = '#fc8';
        pauseBtn.style.background = 'rgba(80,40,0,0.45)';
      } else {
        st.paused = false;
        pauseBtn.textContent = '⏸ Pause';
        pauseBtn.style.borderColor = '#8ef';
        pauseBtn.style.color = '#8ef';
        pauseBtn.style.background = 'rgba(0,40,80,0.45)';
        const dwellMs = st.settings.slideSec * 1000;
        st.timer = setTimeout(() => _slideshowAdvance(+1), dwellMs);
      }
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
window.slideshowOpen           = slideshowOpen;
window.slideshowOpenGrid       = slideshowOpenGrid;
window.slideshowOpenJpgsFolder = slideshowOpenJpgsFolder;
window.slideshowClose          = slideshowClose;
