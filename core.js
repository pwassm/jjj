'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// ESCAPE = always leave text field  (zip0130)
// ══════════════════════════════════════════════════════════════════════════════
// Press Esc when an input/textarea/contenteditable has focus: blur it.
// That's it. Single-letter hotkeys then work because no input has focus.
//
// (Older zip0121 behavior toggled focus back on a second Esc — removed by
// user request: "Escape always leaves text field." Simpler model, no state
// machine, fewer surprises.)
//
// Capture-phase + stopImmediatePropagation when blurring, so existing
// close-on-Esc handlers (which would otherwise close the current screen)
// don't conflict.

(function() {
  function isInput(el) {
    if (!el) return false;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey) return;
    const ae = document.activeElement;
    if (!isInput(ae)) return;  // Not in a field — let other Esc handlers fire normally

    // (zip0161) When the text editor (Xe) is open, let the editor's own Esc
    // handler close it directly (no save). Do NOT blur here.
    if (document.getElementById('textEditorOverlay')) return;

    // In a field: blur it. Block other capture-phase handlers (overlay
    // close-on-Esc) so the screen doesn't close.
    ae.blur();
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
})();

// ══════════════════════════════════════════════════════════════════════════════
// LAST-RECORD MEMORY (zip0122)
// ══════════════════════════════════════════════════════════════════════════════
// Tracks the UID of the most recently viewed/edited/annotated row across all
// screens. Displayed in the badge next to the version. Used to restore focus
// when returning from D (Dictionary) to T or G.
//
// Hooks (each calls setLastUID with the row's UID):
//   - render() in T view (focus changes via arrow keys)
//   - brShow() in Annotate
//   - openVideoEditor wrapper for E
//   - gridOpenFullscreen for V
//   - All _lastGridRow assignments (cell click, grid double-click, etc.)
//
// Restore-from-D: closeDictionary is wrapped to call _restoreFocusToLastUID
// after the dict overlay is gone.

window._lastUID = null;

window.setLastUID = function(uid) {
  if (uid === undefined || uid === null || uid === '') return;
  const s = String(uid);
  if (window._lastUID === s) return;          // no change, skip render
  window._lastUID = s;
  const el = document.getElementById('uid-badge');
  if (!el) return;
  el.style.display = 'block';
  el.textContent = 'UID:' + s;
  el.title = 'Last record: ' + s + ' (focus is restored to this row when leaving D)';
};

// Restore focus in T (or G) to the row with _lastUID, after returning from D.
window._restoreFocusToLastUID = function() {
  if (!window._lastUID) return;
  if (typeof data === 'undefined' || !Array.isArray(data)) return;
  const di = data.findIndex(r => String(r.UID) === window._lastUID);
  if (di < 0) return;

  // If grid is showing, scroll its cell into view (no focus mechanism in G;
  // cell highlight is enough). Otherwise restore T focus.
  const gridOpen = document.getElementById('gridOverlay') &&
                   document.getElementById('gridOverlay').style.display === 'flex';
  if (gridOpen) {
    // Grid doesn't track focus per-cell, but we can scroll the matching cell
    // into view if the row has a `cell` mapping.
    const row = data[di];
    if (row && row.cell) {
      const cellEl = document.querySelector('#gridOverlay [data-cell="' + row.cell + '"]');
      if (cellEl) cellEl.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
    return;
  }

  // T view: set focus, render, scroll into view
  const vi = (typeof sortedIdx !== 'undefined' && sortedIdx)
    ? sortedIdx.indexOf(di) : di;
  if (vi < 0) return;
  focus = { r: vi, c: 0 };
  if (typeof render === 'function') render();
  // (dev0329) Windowed table: the row may not be mounted after render — scroll it
  // into the window (which mounts + focuses it) instead of querying td.focus.
  if (typeof _tScrollRowIntoView === 'function') _tScrollRowIntoView(vi);
};

// ══════════════════════════════════════════════════════════════════════════════
// SINGLE-LETTER HOTKEY CAPTURE (G/T/E)
// ══════════════════════════════════════════════════════════════════════════════
// Since table cells are NOT editable by typing, single letters work as hotkeys
// G = Grid, T = Table, E = VideoEditor, A = Annotate, M = Menu, C = Collection, V = View fullscreen
window._pendingHotkey = null;

// (dev0352) True only when the bare Table screen owns the keyboard — no overlay
// (G/V/E/Xe/Dictionary/slideshow/collection) is on top and we're in dev mode.
// Gates the Ctrl+D / Alt+R Table actions so they never fire over another screen.
function _tScreenActive() {
  if (typeof _isUserMode === 'function' && _isUserMode()) return false;
  if (typeof _cMode !== 'undefined' && _cMode) return false;
  if (document.getElementById('video-editor-overlay')) return false;
  if (document.getElementById('textEditorOverlay'))    return false;
  if (document.getElementById('dictOverlay'))          return false;
  if (document.getElementById('slideshowOverlay'))     return false;
  if (document.getElementById('mergeModal'))           return false;
  const flexOpen = id => { const el = document.getElementById(id); return !!el && el.style.display === 'flex'; };
  if (flexOpen('gridOverlay'))    return false;
  if (flexOpen('gridFullscreen')) return false;
  return true;
}

// (dev0352) Alt+R — re-sort T so the most-recently-modified rows come first,
// pull the list to the top, and focus the new top row. If the row that was
// focused before the re-sort is still visible in the viewport afterwards, keep
// focus on it instead of yanking focus to the top.
function _resortByModified() {
  // Remember the DATA row that was focused (survives the re-sort) + its column.
  const prevDi = (focus && focus.r != null) ? vr(focus.r) : -1;
  const prevC  = (focus && focus.c != null) ? focus.c : 0;

  sortCol = 'DateModified';
  sortDir = 'desc';
  buildSort();

  // Pull to the top first so the window/visibility math reflects the final scroll.
  const wrap = document.getElementById('wrap');
  if (wrap) wrap.scrollTop = 0;
  render();                         // rebuilds _tVisList in the new order, at top

  // Default: focus the new top row.
  let targetVi = _tVisList.length ? _tVisList[0].vi : 0;

  // Exception: previously-focused row still on screen after scroll-to-top → keep it.
  if (prevDi >= 0) {
    const prevPos = _tVisList.findIndex(o => o.di === prevDi);
    if (prevPos >= 0) {
      const rowH = (typeof _tRowHeight === 'function') ? _tRowHeight() : 25;
      const clientH = wrap ? (wrap.clientHeight || 0) : 0;
      const visibleRows = rowH > 0 ? Math.floor(clientH / rowH) : 0;
      if (prevPos < visibleRows) targetVi = _tVisList[prevPos].vi;
    }
  }

  focus = { r: targetVi, c: prevC };
  render();                         // repaint with the focus highlight (still at top)
  toast('↻ Re-sorted by DateModified — newest at top', 1500);
}

window.addEventListener('keydown', function(e) {
  // Skip if in an input field or contenteditable
  const tag = document.activeElement?.tagName;
  // If focus is inside an iframe, activeElement is the iframe itself (tag=IFRAME)
  // — do not block hotkeys in that case (iframe has its own key handling)
  const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
                     document.activeElement?.contentEditable === 'true';
  // (zip0160) Esc in a text field = blur (defocus). This lets the user
  // press Esc once to leave the field, then bare-letter hotkeys work
  // immediately. Without this, the user had to click outside the field.
  if (isEditable && e.key === 'Escape') {
    // (dev0350) Xe (text editor) owns a two-stage Esc (first unfocus, then leave)
    // in its own capture listener — don't pre-blur here or stage one is lost.
    if (document.getElementById('textEditorOverlay')) return;
    e.preventDefault();
    document.activeElement.blur();
    return;
  }
  if (isEditable) return;

  // (dev0352) Modified-key Table actions that must beat the browser defaults,
  // checked BEFORE the bare-modifier bail-out below. Only when the Table screen
  // owns the keyboard — elsewhere the browser default is left intact.
  //   Ctrl/⌘+D = duplicate the focused row (overrides Chrome "bookmark page")
  //   Alt+R    = re-sort T by DateModified (newest first) + refresh focus/scroll
  if (_tScreenActive()) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
        && (e.key === 'd' || e.key === 'D' || e.code === 'KeyD')) {
      e.preventDefault(); e.stopPropagation();
      document.getElementById('dupRowBtn')?.click();
      return false;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey
        && (e.key === 'r' || e.key === 'R' || e.code === 'KeyR')) {
      e.preventDefault(); e.stopPropagation();
      _resortByModified();
      return false;
    }
    // (dev0357→0358) Alt+F was tried as "unfilter" but the browser still opened
    // its native Alt+F menu on some setups — removed per user. Shift+F (handled
    // below in the bare-key dispatcher) remains the clear-all-filters hotkey.
  }

  // Skip if modifiers (let Alt+N, Ctrl+Alt+G etc through)
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  // Skip when overlays that own their own letter shortcuts are open. Each
  // overlay's internal handler decides what to do with letter keys (e.g.
  // Dictionary uses C/A/S/D for cut/paste/delete on the focused tree row;
  // T/G are handled internally to "close + go there"). If we forward keys
  // to the global dispatcher here too, they fire twice — once correctly
  // (in-overlay) and once destructively (opening the wrong screen).
  if (document.getElementById('dictOverlay'))   return;
  if (document.getElementById('mergeModal'))    return;
  if (document.getElementById('treeCtxMenu'))   return;
  if (document.getElementById('chipCtxMenu'))   return;
  // (dev0281) The slideshow is a full-window overlay that owns the keyboard
  // (it has its own Esc/arrows handler and the bare-S guard). Forwarding global
  // letter hotkeys here would open T/G/E/D/etc behind or over the slideshow —
  // e.g. D popping the Dictionary mid-show. Bail entirely while it's open.
  if (document.getElementById('slideshowOverlay')) return;
  // E (Video Editor) handles its own letter keys (T/G/A/N/J/S/M/C/Esc).
  // If we forward keys to the global dispatcher here, they fire on top of
  // E's handler and the wrong screen opens.
  if (document.getElementById('video-editor-overlay')) return;
  // (dev0384) The shareable menu is a full-window overlay that owns the keyboard
  // (its own Tab tab-cycle + `f`→filter handler). Bail so this capture-phase
  // dispatcher doesn't swallow `f` (and the other letter hotkeys) before the
  // menu sees them.
  if (document.getElementById('shareableMenu')) return;

  const k = e.key.toLowerCase();

  // (dev0438) The Ig staging screen owns f / Shift+F (filter focus / clear) and
  // c (hide-completed toggle). Bail WITHOUT preventDefault so ig.js's own
  // capture handler — registered after this one — receives them. Other nav keys
  // (t/g/i/…) still fall through so they close Ig and switch screens as before.
  if (typeof window.isIgScreenOpen === 'function' && window.isIgScreenOpen()
      && (k === 'f' || k === 'c')) {
    return;
  }

  // (dev0447) The St bulk-staging screen owns w (import from clipboard) and f
  // (focus search). (dev0448) It also owns a (add focused row → ml.json) and d
  // (delete focused row). (dev0449) It also owns e (fill Res/Size/Len meta).
  // (dev0451) It also owns c (open the L1/L2 bulk dialog) — without this bail those
  // bare keys would open the Annotate / Dictionary / Edit / Config screens instead.
  // Bail WITHOUT preventDefault so s.js's own capture handler — registered after this
  // one — receives them. Other nav keys (t/g/s/…) still fall through so they close
  // St / switch screens as before.
  if (typeof window.isStScreenOpen === 'function' && window.isStScreenOpen()
      && (k === 'w' || k === 'f' || k === 'a' || k === 'd' || k === 'e' || k === 'c')) {
    return;
  }

  // (dev0466) The O org-review screen owns f (focus search) and r (toggle reading
  // pane). Bail WITHOUT preventDefault so o.js's own capture handler — registered
  // after this one — receives them. Other nav keys (t/g/o/…) still fall through so
  // they close O / switch screens as before.
  if (typeof window.isOScreenOpen === 'function' && window.isOScreenOpen()
      && (k === 'f' || k === 'r')) {
    return;
  }

  // (dev0376) Shift+C = toggle closed captions on all YT/Vimeo grid cells.
  // Only when the grid overlay is open; otherwise falls through so bare 'c'
  // (and Shift+C elsewhere) reaches the C-screen dispatcher normally. Handled
  // here because the dispatcher below lowercases the key, losing the Shift.
  if (k === 'c' && e.shiftKey) {
    const gOpen = document.getElementById('gridOverlay')?.style.display === 'flex';
    const gFs   = document.getElementById('gridFullscreen')?.style.display === 'flex';
    if (gOpen && !gFs) {
      e.preventDefault(); e.stopPropagation();
      if (window._gridToggleCaptions) window._gridToggleCaptions();
      return false;
    }
  }

  // Shift-F = clear all filters instantly (T-view only, not inside text input)
  if (k === 'f' && e.shiftKey) {
    e.preventDefault(); e.stopPropagation();
    rowFilter = null;
    if (typeof window.closeFilterBar === 'function') window.closeFilterBar();
    if (typeof render === 'function') render();
    return false;
  }

  // (zip0153) Number keys 2/3/4/5 resize the grid when G overlay is open.
  // Bare key only — modifiers fall through to other handlers. Suppressed
  // when other overlays own the keys (already filtered above).
  // (dev0387) This window-capture handler runs BEFORE collection.js's grid
  // handler, so it also owns the digits for the "moving cells" variants: while
  // any moving mode is active, 1-9 pick a variant (window._gmSelectDigit) and
  // never resize. Otherwise 2-5 resize as before (1 is unused for sizing).
  if (k >= '1' && k <= '9') {
    const gOpen = document.getElementById('gridOverlay')?.style.display === 'flex';
    // Don't fire if a fullscreen view (V) is on top of the grid — V owns
    // its own keys (Space, A/B, M, ←/→).
    const vpOpen = document.getElementById('gridFullscreen')?.style.display === 'flex';
    if (gOpen && !vpOpen) {
      if (typeof window._gmAnyMoving === 'function' && window._gmAnyMoving()) {
        e.preventDefault();
        e.stopPropagation();
        if (typeof window._gmSelectDigit === 'function') window._gmSelectDigit(k);
        return false;
      }
      if (k >= '2' && k <= '5') {
        e.preventDefault();
        e.stopPropagation();
        // (dev0370) Layouts 17/19 are config-only — the size keys must not switch
        // into or out of them. Swallow the key (no resize) while one is active.
        if (typeof _gridCurrentLayout === 'function' && _gridCurrentLayout() !== 'square') {
          if (typeof _gridToast === 'function') _gridToast('Layout locked — change it from the C screen', 1400);
          return false;
        }
        if (typeof _setGridGsize === 'function') _setGridGsize(parseInt(k, 10));
        return false;
      }
    }
  }
  // (dev0353) When the grid right-click context menu is open it owns its own
  // letter shortcuts (T/Q/D/V/W). Don't let the global dispatcher swallow them
  // (e.g. 'w' = clipboard import) — bail so the menu's capture handler runs.
  if (document.getElementById('gridContextMenu')) return;
  // (dev0460) F → toggle "fall cells" (the perimeter-drain waterfall conveyor)
  // while G is open. Bare key only — Shift+F (clear filters) is handled above, and
  // F is otherwise forwarded to _executeHotkey('f') (the filter modal, a no-op in
  // G). Own it here in window-capture, alongside the digit variant keys, and route
  // to the moving-cells family.
  if (k === 'f' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
    const gOpenF = document.getElementById('gridOverlay')?.style.display === 'flex';
    const vpOpenF = document.getElementById('gridFullscreen')?.style.display === 'flex';
    if (gOpenF && !vpOpenF) {
      e.preventDefault();
      e.stopPropagation();
      if (typeof window._gmToggleFall === 'function') window._gmToggleFall();
      return false;
    }
  }
  // (dev0447) S opens the St staging screen — but Xe (text editor) uses bare 's'
  // for save, so don't forward 's' to the dispatcher while Xe is open; let it
  // reach xe.js. (Slideshow / Dictionary / Video-editor already bail entirely
  // above, so they keep their own 's' too.)
  if (k === 's' && document.getElementById('textEditorOverlay')) return;
  if (k === 'g' || k === 't' || k === 'e' || k === 'm' || k === 'c' || k === 'a' || k === 'd' || k === 'l' || k === 'f' || k === 'w' || k === 'h' || k === 'v' || k === 'i' || k === 's') {
    // (dev0350) On the C (collection/config) screen, 'm' = MakeActive→G and is
    // owned by the C-screen handler (boot.js). Don't also fire the global
    // hamburger-menu dispatcher here, or it pops HM right after. Let the event
    // fall through to that capture-phase handler instead.
    if (k === 'm' && window._cMode) return;
    e.preventDefault();
    e.stopPropagation();
    window._pendingHotkey = k;
    setTimeout(function() {
      if (window._executeHotkey) window._executeHotkey(k);
    }, 0);
    return false;
  }
}, true);

// Canvas for text measurement
const _mc = document.createElement('canvas').getContext('2d');
_mc.font  = '12px monospace';
const CHAR_W   = _mc.measureText('M').width;   // widest monospace char
const PAD_PX   = 16;
const MIN_W    = 20;
const MAX_AUTO = Math.ceil(CHAR_W * 25 + PAD_PX); // 25-char cap for auto-size

function autoColW(col, capChars) {
  let max = _mc.measureText(col).width;
  data.forEach(r => { const w = _mc.measureText(String(r[col] || '')).width; if (w > max) max = w; });
  // capChars overrides the default 25-char cap (MAX_AUTO) — used by the
  // size30max / size60max Views presets. Result is the lesser of the cap and the
  // longest content (never below MIN_W), so short columns stay tight.
  const capPx = (typeof capChars === 'number' && capChars > 0)
    ? Math.ceil(CHAR_W * capChars + PAD_PX) : MAX_AUTO;
  return Math.min(capPx, Math.max(MIN_W, Math.ceil(max) + PAD_PX));
}

// State
var data        = [];
var cols        = [];   // ordered column list (all, including hidden)
var hidden      = new Set();
var metaRow     = null;
var colWidths   = {};   // col → px (saved widths only; absent means use autoColW)
var focus       = null;
var pending     = null;
var checkedRows = new Set();
var sortCol = null, sortDir = 'asc', sortedIdx = null;
var rowFilter = null;  // null = off | {col, val} = show only rows where data[di][col]===val
var _lastRowFilter = null;  // remembered filter for F-toggle restore

// (zip0162) Moved from grid.js so it's available across all modules.
// Check if row is a video.
function isVideoRow(row) {
  if (!row) return false;
  // (dev0285) Slideshow disk-video rows carry a blob: link (no extension) and
  // flag themselves so they're recognised as direct videos.
  if (row._directVideoFile) return true;
  const vrn  = String(row.VidRange || '').trim();
  const link = String(row.link || '').trim();
  const isYT = link && (window.isYouTubeLink ? window.isYouTubeLink(link) : /youtu\.be|youtube\.com/i.test(link));
  const isVimeo = link && (window.isVimeoLink ? window.isVimeoLink(link) : /vimeo\.com/i.test(link));
  const isIG = link && window.isInstagramLink && window.isInstagramLink(link);
  const isTT = link && window.isTikTokLink && window.isTikTokLink(link);
  if (isYT || isVimeo || isIG || isTT) return true;
  if (link && /\.(mp4|mov|webm|ogg|avi|mkv|m4v)(\?|#|$)/i.test(link)) return true;
  if (vrn && vrn !== 'i' && window.parseVideoAsset && window.parseVideoAsset(vrn) !== null) {
    if (/\.(jpg|jpeg|png|gif|webp|svg|bmp|avif)(\?|#|$)/i.test(link)) return false;
    return true;
  }
  return false;
}

// (dev0343) Coarse media classification used by the filter bar's "Only" media
// toggles. Computed live from the link/row — no stored column needed (cheap,
// never goes stale). Three buckets:
//   'video' — isVideoRow (YT/Vimeo/IG/direct-file/numeric asset)
//   'image' — an image-extension link (not a video)
//   'other' — text/html slides, quizzes, empty rows, non-media links
function isImageLink(url) {
  return /\.(jpe?g|png|gif|webp|svg|bmp|tiff?|avif)(\?|#|$)/i.test(String(url || ''));
}
function rowMediaKind(row) {
  if (!row) return 'other';
  if (isVideoRow(row)) return 'video';
  if (isImageLink(row.link)) return 'image';
  return 'other';
}
window.isImageLink  = isImageLink;
window.rowMediaKind = rowMediaKind;

// (dev0343) Read a row's stored orientation, tolerating either column name
// ('P/S' or legacy 'Portrait'). Returns '1' (portrait), '0' (landscape), or
// '' / 'X' (n/a / unknown). Read-only — does not create the column.
function rowPSValue(row) {
  if (!row) return '';
  const v = (row['P/S'] != null && row['P/S'] !== '') ? row['P/S'] : row['Portrait'];
  return String(v == null ? '' : v);
}
window.rowPSValue = rowPSValue;

// Mojibake fix
function fixMojibake(s) {
  if (typeof s !== 'string') return s;
  for (let i = 0; i < 4; i++) {
    try {
      const b = new Uint8Array(s.length); let ok = true;
      for (let j = 0; j < s.length; j++) { const c = s.charCodeAt(j); if (c > 255) { ok = false; break; } b[j] = c; }
      if (!ok) break;
      const d = new TextDecoder('utf-8', { fatal: true }).decode(b);
      if (d === s) break; s = d;
    } catch(e) { break; }
  }
  return s;
}
function fixAll(o) {
  if (Array.isArray(o))       return o.map(fixAll);
  if (o && typeof o === 'object') { const r = {}; for (const k in o) r[k] = fixAll(o[k]); return r; }
  if (typeof o === 'string')  return fixMojibake(o);
  return o;
}

// Date helpers
function isoNow() { return new Date().toISOString().slice(0,19).replace('T',' '); }

// (zip0125) Sequential UID minting.
// Returns the smallest positive integer (as a string) not already used as a
// UID in `data`. UIDs may be numeric strings ("1", "2", "27") or legacy
// alphanumerics ("T1775622304605"); only numeric UIDs participate in the
// "max + 1" computation. Legacy UIDs are preserved but ignored when picking
// the next number.
//
// Single source of truth for new-row UIDs. Reassign UIDs (button in T) is
// what brings everything to a clean 1..N sequence; this function just makes
// sure new rows added between reassignments don't introduce gaps or collisions.
function nextUID() {
  let max = 0;
  if (typeof data !== 'undefined' && Array.isArray(data)) {
    for (const r of data) {
      if (r && r._salIg) continue;
      const v = r && r.UID;
      if (v === undefined || v === null) continue;
      const n = parseInt(String(v), 10);
      // Reject NaN and reject "L1234..." (parseInt on "L1" gives NaN, good;
      // on "1L" it would give 1, which we accept — that's fine, no collision)
      if (!isNaN(n) && n > max) max = n;
    }
  }
  return String(max + 1);
}
// Convert old yy.mm.dd.hh.mm.ss → YYYY-MM-DD HH:MM:SS
function toISO(v) {
  if (!v || typeof v !== 'string') return v;
  const m = v.match(/^(\d{2})\.(\d{2})\.(\d{2})\.(\d{2})\.(\d{2})\.(\d{2})$/);
  if (m) return '20'+m[1]+'-'+m[2]+'-'+m[3]+' '+m[4]+':'+m[5]+':'+m[6];
  return v;
}
function migrateDates(rows) {
  rows.forEach(r => {
    if (r.DateAdded)    r.DateAdded    = toISO(r.DateAdded);
    if (r.DateModified) r.DateModified = toISO(r.DateModified);
  });
}
var _fsaDir = null;
function _fsaDB() { return new Promise((res,rej)=>{ const q=indexedDB.open('sal-fsa',1); q.onupgradeneeded=e=>e.target.result.createObjectStore('handles'); q.onsuccess=e=>res(e.target.result); q.onerror=e=>rej(e.target.error); }); }
async function _fsaSave(h) { try { const db=await _fsaDB(); db.transaction('handles','readwrite').objectStore('handles').put(h,'dir'); } catch(e) {} }
async function _fsaLoad() { try { const db=await _fsaDB(); return await new Promise(res=>{ const q=db.transaction('handles','readonly').objectStore('handles').get('dir'); q.onsuccess=e=>res(e.target.result||null); q.onerror=()=>res(null); }); } catch(e) { return null; } }
async function _getDir() {
  if (_fsaDir) { try { if ((await _fsaDir.queryPermission({mode:'readwrite'})) === 'granted') return _fsaDir; } catch(e) {} _fsaDir = null; }
  const s = await _fsaLoad();
  if (s) { try { if ((await s.queryPermission({mode:'readwrite'})) === 'granted') { _fsaDir = s; return _fsaDir; } } catch(e) {} }
  return null;
}
async function pickFolder() {
  if (!window.showDirectoryPicker) { toast('File System Access API not available.\nUse Edge or Chrome 86+.'); return; }
  try { const h = await window.showDirectoryPicker({mode:'readwrite',id:'jj-project'}); _fsaDir = h; await _fsaSave(h); setFsaStatus('📂 '+h.name); toast('✓ Folder set: '+h.name); }
  catch(e) { if (e.name !== 'AbortError') toast('Folder pick failed:\n'+e.message); }
}
// (dev0345) ftext-loss guard — pure + testable. Backfills ftext into `rows`
// from `prevRows` (the existing on-disk ml.json) for any row whose ftext key is
// ABSENT (undefined). A row with ftext === '' is a deliberate user-clear and is
// left untouched. Returns the number of rows refilled. See writeFileToDisk for
// the why: the localStorage mirror is ftext-stripped, and if `data` was ever
// loaded from it without per-UID rehydration (load()'s fetch-failed fallback),
// in-memory rows carry no ftext — a plain write would blank them on disk. This
// wiped ~198 w-rows on 2026-05-30 (commit "sss").
function _rehydrateFtextFromPrev(rows, prevRows) {
  if (!Array.isArray(rows) || !Array.isArray(prevRows)) return 0;
  const disk = new Map();
  for (const r of prevRows) {
    if (r && !r._salMeta && r.UID != null && typeof r.ftext === 'string' && r.ftext.length > 0) {
      disk.set(String(r.UID), r.ftext);
    }
  }
  if (!disk.size) return 0;
  let n = 0;
  for (const r of rows) {
    if (r && !r._salMeta && r.UID != null && r.ftext === undefined && disk.has(String(r.UID))) {
      r.ftext = disk.get(String(r.UID));
      n++;
    }
  }
  return n;
}
if (typeof module !== 'undefined' && module.exports) module.exports._rehydrateFtextFromPrev = _rehydrateFtextFromPrev;

async function writeFileToDisk(name, jsonData) {
  const dir = await _getDir();
  if (!dir) {
    // (zip0165) Was silently returning false. That's how text-slide edits
    // got lost: localStorage saved them, but ml.json on disk stayed stale,
    // and on Ctrl+R load() preferred the fetched stale ml.json over the
    // fresh localStorage. Now we warn loudly so the user knows their save
    // didn't reach disk and can re-grant FSA permission.
    //
    // (zip0174) But ONLY in dev mode. Users (Gu/Cu) never pick a folder
    // — they're viewing pre-built grids on github.io / phone. The toast
    // was firing when they picked a config from Cu (which mutates
    // data[] cell assignments and calls save()). In user mode the
    // localStorage write is the intended behavior; no toast needed.
    const inUserMode = (typeof _isUserMode === 'function') ? _isUserMode() : false;
    if (!inUserMode && !writeFileToDisk._warnedNoDir) {
      writeFileToDisk._warnedNoDir = true;
      try { toast('⚠ ' + name + ' NOT saved to disk — re-pick project folder (📂 button)', 4500); } catch(e) {}
      console.warn('writeFileToDisk: no FSA dir / permission lost. ' + name + ' saved to localStorage only.');
      // Re-arm the warning after 30s so the user gets reminded if they keep editing
      setTimeout(() => { writeFileToDisk._warnedNoDir = false; }, 30000);
    }
    return false;
  }
  // (dev0345) ftext-loss guard: before overwriting ml.json, read the existing
  // on-disk copy and backfill any row whose ftext key is absent (in-memory copy
  // was loaded from the ftext-stripped localStorage mirror). Self-heals the
  // in-memory rows too (same object refs as data[]), so the UI recovers and
  // subsequent saves are clean. Only runs for ml.json; '' (cleared) is kept.
  if (name === 'ml.json' && Array.isArray(jsonData)) {
    try {
      const cur = await dir.getFileHandle(name, {create:false});
      const prev = JSON.parse(await (await cur.getFile()).text());
      const refilled = _rehydrateFtextFromPrev(jsonData, prev);
      if (refilled) console.warn('writeFileToDisk: ftext-loss guard refilled '
        + refilled + ' row(s) from disk before save (in-memory copy was ftext-stripped).');
    } catch(e) { /* no existing file / parse fail — nothing to protect this write */ }
  }
  try {
    const fh = await dir.getFileHandle(name, {create:true});
    const w  = await fh.createWritable();
    await w.write(JSON.stringify(jsonData, null, 2));
    await w.close();
    writeFileToDisk._warnedNoDir = false; // reset on success
    return true;
  } catch(e) { toast('Write failed:\n'+e.message); _fsaDir = null; return false; }
}
// Append plain text to a file in the project folder (reads existing, appends, writes back).
async function _appendTextFileToDisk(name, text) {
  const dir = await _getDir();
  if (!dir) return false;
  try {
    let existing = '';
    try { const fh = await dir.getFileHandle(name); existing = await (await fh.getFile()).text(); } catch(_) {}
    const fh = await dir.getFileHandle(name, { create: true });
    const w  = await fh.createWritable();
    await w.write(existing + text);
    await w.close();
    return true;
  } catch(e) { return false; }
}

// Append a deleted row to deleted.json in the project folder.
async function _saveToDeletedJson(row) {
  const dir = await _getDir();
  if (!dir) return false;
  try {
    let arr = [];
    try { const fh = await dir.getFileHandle('deleted.json'); arr = JSON.parse(await (await fh.getFile()).text()); if (!Array.isArray(arr)) arr = []; } catch(_) {}
    // (dev0351) Accept a single row OR an array (batch delete) so one read/write
    // covers a multi-row delete — concurrent per-row appends would race the file.
    const _delNow = new Date().toISOString();
    (Array.isArray(row) ? row : [row]).forEach(r => arr.push(Object.assign({}, r, { _deletedAt: _delNow })));
    const fh = await dir.getFileHandle('deleted.json', { create: true });
    const w  = await fh.createWritable();
    await w.write(JSON.stringify(arr, null, 2));
    await w.close();
    return true;
  } catch(e) { return false; }
}

// (zip0251) `warn` flag adds the red-pulse class — used when FSA permission
// has silently lapsed so the user can't miss it. Without this signal,
// writes were silently going to localStorage only and edits looked saved.
function setFsaStatus(m, warn) {
  const el = document.getElementById('fsa-status');
  if (!el) return;
  el.textContent = m || 'No project folder set';
  if (warn) el.classList.add('warn'); else el.classList.remove('warn');
}
// Auto-restore FSA on page load
(async()=>{
  try {
    const s = await _fsaLoad();
    if (!s) return;
    const p = await s.queryPermission({mode:'readwrite'});
    if (p === 'granted') {
      _fsaDir = s;
      setFsaStatus('📂 ' + s.name + ' (ready)');
    } else {
      // (zip0251) Loud warning — red status bar + toast. Silent fallback
      // to localStorage was the silent-fail mode that masked the c.json
      // delete-resurrects bug. Toast fires even when the status bar is
      // hidden (e.g. user lands on G/Xs/C overlays after reload).
      setFsaStatus('📂 ' + s.name + ' — RE-GRANT NEEDED (click 📂 / hamburger)', true);
      try { toast('⚠ Project folder permission lapsed\nClick the 📂 / hamburger to re-grant — edits will only reach localStorage until then', 4000); } catch(e) {}
    }
  } catch(e) {}
})();

// Build the _salMeta object (always complete)
function buildMeta() {
  const m = {
    _salMeta:     true,
    _salPushTime: Date.now(),
    _salColWidths: Object.assign({}, colWidths),
    _salColOrder:  cols.slice(),
    _salHidden:    [...hidden]
  };
  // Persist current sort so reload preserves the order user was working in
  if (sortCol) {
    m._salSort = { col: sortCol, dir: sortDir };
  }
  // (zip0153) Persist live grid size (2-5) so the next load opens at the
  // size the user was last working in.
  if (typeof _gridGsize === 'number' && _gridGsize >= 2 && _gridGsize <= 5) {
    m._salGsize = _gridGsize;
  }
  // Preserve Views data if it exists
  if (metaRow && metaRow._salViews) m._salViews = metaRow._salViews;
  if (metaRow && metaRow._salActiveView) m._salActiveView = metaRow._salActiveView;
  return m;
}

// ══════════════════════════════════════════════════════════════════════════════
// VIEWS SYSTEM
// ══════════════════════════════════════════════════════════════════════════════
// Views are stored inside _salMeta in ml.json:
//   _salViews: { "key": { name, label, colOrder, hidden, colWidths } }
//   _salActiveView: "key"   ← last applied view name

function _getViews() {
  // Returns the _salViews object from current metaRow, or empty object
  if (metaRow && metaRow._salViews && typeof metaRow._salViews === 'object') {
    return metaRow._salViews;
  }
  return {};
}

function _setViews(v) {
  if (!metaRow) metaRow = {};
  metaRow._salViews = v;
}

function viewsSave(name) {
  name = (name || '').trim();
  if (!name) { toast('Enter a view name first', 1500); return; }
  const views = _getViews();
  // Use name as key (slugified for safety, original stored as label)
  const key = name.toLowerCase().replace(/[^a-z0-9_\-]/g, '_');
  views[key] = {
    name: key,
    label: name,
    colOrder: cols.slice(),
    hidden: [...hidden],
    colWidths: Object.assign({}, colWidths)
  };
  _setViews(views);
  if (metaRow) metaRow._salActiveView = key;
  save();
  toast('✓ View "' + name + '" saved', 1500);
  renderViewsPanel();
}

function viewsLoad(key) {
  const views = _getViews();
  const v = views[key];
  if (!v) return;
  cols       = (v.colOrder || []).slice();
  hidden     = new Set(v.hidden || []);
  colWidths  = Object.assign({}, v.colWidths || {});
  if (metaRow) metaRow._salActiveView = key;
  // Rebuild cols to ensure any new data columns are appended
  buildCols();
  buildSort();
  render();
  save();
  toast('✓ View "' + (v.label || key) + '" applied', 1500);
  renderViewsPanel();
  // (dev0355) Close the Views picker once a view is chosen.
  const _vp = document.getElementById('viewsPanel');
  if (_vp) _vp.classList.remove('open');
}

// (dev0324) Built-in size presets used by the Views panel ("size30max",
// "size60max"). Sets EVERY column's width to the lesser of N chars and its
// longest content. Computed live (not a stored view), so it works regardless of
// whether _salViews ever persisted to disk — this is also a quick rescue when a
// long ftext column has blown the table out.
function applySizePreset(capChars) {
  cols.forEach(col => { colWidths[col] = autoColW(col, capChars); });
  if (metaRow) metaRow._salActiveView = null;
  save();
  render();
  toast('✓ Columns sized to ≤ ' + capChars + ' chars (or content)', 1700);
  // (dev0355) Close the Views picker once a preset is chosen.
  const _vp = document.getElementById('viewsPanel');
  if (_vp) _vp.classList.remove('open');
}

function viewsDelete(key) {
  const views = _getViews();
  const lbl = views[key] ? (views[key].label || key) : key;
  if (!confirm('Delete view "' + lbl + '"?')) return;
  delete views[key];
  _setViews(views);
  if (metaRow && metaRow._salActiveView === key) metaRow._salActiveView = null;
  save();
  toast('✓ View "' + lbl + '" deleted', 1500);
  renderViewsPanel();
}

function viewsRename(key) {
  const views = _getViews();
  const v = views[key];
  if (!v) return;
  const newLabel = prompt('Rename view "' + (v.label || key) + '" to:', v.label || key);
  if (!newLabel || !newLabel.trim() || newLabel.trim() === v.label) return;
  v.label = newLabel.trim();
  // Re-key if name changed
  const newKey = v.label.toLowerCase().replace(/[^a-z0-9_\-]/g, '_');
  if (newKey !== key) {
    views[newKey] = Object.assign({}, v, { name: newKey });
    delete views[key];
    if (metaRow && metaRow._salActiveView === key) metaRow._salActiveView = newKey;
  }
  _setViews(views);
  save();
  toast('✓ Renamed to "' + v.label + '"', 1500);
  renderViewsPanel();
}

function renderViewsPanel() {
  const list = document.getElementById('viewsList');
  if (!list) return;
  list.innerHTML = '';

  // (dev0324) Built-in size presets — always shown, independent of saved views
  // (so they work even when _salViews failed to persist to disk). Each sets all
  // column widths to ≤ N chars (or content width if shorter) via applySizePreset.
  const presets = document.createElement('div');
  presets.className = 'vp-presets';
  const plbl = document.createElement('span');
  plbl.className = 'vp-presets-lbl';
  plbl.textContent = 'Quick column size:';
  presets.appendChild(plbl);
  [['size30max', 30], ['size60max', 60]].forEach(arr => {
    const b = document.createElement('button');
    b.className = 'vp-act load';
    b.textContent = arr[0];
    b.title = 'Set every column to ≤ ' + arr[1] + ' chars wide (or its content width, if shorter)';
    b.addEventListener('click', () => applySizePreset(arr[1]));
    presets.appendChild(b);
  });
  list.appendChild(presets);

  const views = _getViews();
  const active = metaRow ? metaRow._salActiveView : null;
  const keys = Object.keys(views);
  if (keys.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'vp-empty';
    empty.innerHTML = 'No saved views yet.<br>Arrange columns, then save a view below.';
    list.appendChild(empty);
    return;
  }
  keys.forEach(key => {
    const v = views[key];
    const isActive = key === active;
    const row = document.createElement('div');
    row.className = 'vp-row' + (isActive ? ' active-view' : '');
    // Name / label
    const nm = document.createElement('div');
    nm.className = 'vp-name';
    nm.title = 'Click to apply this view';
    nm.textContent = (isActive ? '▶ ' : '') + (v.label || key);
    nm.addEventListener('click', () => viewsLoad(key));
    row.appendChild(nm);
    // Col count hint
    const lbl = document.createElement('div');
    lbl.className = 'vp-lbl';
    const visCount = (v.colOrder || []).filter(c => !(v.hidden || []).includes(c)).length;
    lbl.textContent = visCount + ' cols';
    lbl.title = (v.colOrder || []).filter(c => !(v.hidden || []).includes(c)).join(', ');
    row.appendChild(lbl);
    // Load btn
    const loadBtn = document.createElement('button');
    loadBtn.className = 'vp-act load';
    loadBtn.textContent = 'Apply';
    loadBtn.addEventListener('click', () => viewsLoad(key));
    row.appendChild(loadBtn);
    // Rename btn
    const renBtn = document.createElement('button');
    renBtn.className = 'vp-act ren';
    renBtn.textContent = 'Rename';
    renBtn.addEventListener('click', () => viewsRename(key));
    row.appendChild(renBtn);
    // Delete btn
    const delBtn = document.createElement('button');
    delBtn.className = 'vp-act del';
    delBtn.textContent = 'Del';
    delBtn.addEventListener('click', () => viewsDelete(key));
    row.appendChild(delBtn);
    list.appendChild(row);
  });
}

function openViewsPanel() {
  const btn  = document.getElementById('viewsBtn');
  const panel = document.getElementById('viewsPanel');
  if (!panel) return;
  if (panel.classList.contains('open')) { panel.classList.remove('open'); return; }
  renderViewsPanel();
  // Position below the button
  const br = btn.getBoundingClientRect();
  panel.style.top  = (br.bottom + 6) + 'px';
  panel.style.left = Math.max(4, Math.min(br.left, window.innerWidth - 430)) + 'px';
  panel.classList.add('open');
  setTimeout(() => { document.getElementById('viewsNameInp').focus(); }, 60);
}

// Wire up Views panel
document.addEventListener('DOMContentLoaded', () => {}, false);
(function wireViews() {
  document.getElementById('viewsBtn').addEventListener('click', openViewsPanel);
  document.getElementById('viewsCloseBtn').addEventListener('click', () => {
    document.getElementById('viewsPanel').classList.remove('open');
  });
  document.getElementById('viewsSaveBtn').addEventListener('click', () => {
    const inp = document.getElementById('viewsNameInp');
    viewsSave(inp.value);
    inp.value = '';
  });
  document.getElementById('viewsNameInp').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const inp = document.getElementById('viewsNameInp');
      viewsSave(inp.value);
      inp.value = '';
    }
    if (e.key === 'Escape') {
      document.getElementById('viewsPanel').classList.remove('open');
    }
  });
  // Close panel on outside click
  document.addEventListener('pointerdown', e => {
    const panel = document.getElementById('viewsPanel');
    const btn   = document.getElementById('viewsBtn');
    if (panel && panel.classList.contains('open') && !panel.contains(e.target) && e.target !== btn) {
      panel.classList.remove('open');
    }
  }, true);
})();

// (FtextSize) Maintain a numeric per-row character count of ftext so the T
// column is sortable (largest/garbage ftext surfaces with a descending sort).
// Stored as a number → buildSort()'s numeric branch orders it correctly.
// Refreshed on every load and before every save so it never drifts.
function updateFtextSizes() {
  if (!Array.isArray(data)) return;
  // Find (or default) the sortable column key for a metric. Prefers the column
  // the user already created (case-insensitive); else any case-variant on a
  // row; else the given default. Returns the resolved key.
  const resolveKey = (rx, dflt) => {
    let key = (Array.isArray(cols) ? cols.find(c => rx.test(c)) : null) || null;
    if (!key) {
      for (const r of data) {
        if (r && !r._salMeta) { const k = Object.keys(r).find(k => rx.test(k)); if (k) { key = k; break; } }
      }
    }
    return key || dflt;
  };
  const sizeRx = /^ftextsize$/i;
  const junkRx = /^ftextjunk$/i;
  const sizeKey = resolveKey(sizeRx, 'FtextSize');
  // (dev0278) Junk % per row — surfaces markup-heavy entries (bad pastes) so
  // they can be re-cleaned. See ftextStats(): image/link URLs aren't junk.
  const junkKey = resolveKey(junkRx, 'FtextJunk');
  for (const r of data) {
    if (!r || r._salMeta) continue;
    // Drop any other-cased variants so we don't leave empty duplicate columns.
    for (const k of Object.keys(r)) {
      if (k !== sizeKey && sizeRx.test(k)) delete r[k];
      if (k !== junkKey && junkRx.test(k)) delete r[k];
    }
    // String values (like other ml.json fields); buildSort parseFloat-sorts numerically.
    const s = ftextStats(typeof r.ftext === 'string' ? r.ftext : '');
    r[sizeKey] = String(s.bytes);
    r[junkKey] = String(s.junkPct);
  }
}

// Master save: localStorage + disk (non-blocking)
function save() {
  updateFtextSizes();
  // _salIg rows live in instagram.json and are merged in at load(); strip
  // them out of every ml.json write path so the sandbox stays excisable.
  const mlRows = data.filter(r => !(r && r._salIg));
  // (dev0325) Build the meta row ONCE and write it to BOTH targets. The meta row
  // carries named Views (_salViews), the active view, sort, grid size and column
  // layout. Previously it went to disk ONLY, so any View created after the
  // File-System-Access permission lapsed lived solely in a failing disk write
  // and was lost on reload. Mirroring it into localStorage = "ml.json saved
  // everywhere": load() restores Views/layout from whichever copy is newer.
  const meta = buildMeta();
  // 1. localStorage (instant) — LIGHT mirror: meta row + data rows, but ftext
  // (HTML, ~90% of the file) is dropped so this synchronous setItem stays small
  // and never trips the browser's ~5 MB quota (which was silently failing and
  // blocking the UI on every edit). ftext lives only on disk (ml.json);
  // load() rehydrates it by UID when it falls back to this LS copy. An empty
  // string is KEPT (distinguishes a user-cleared ftext from a stripped one).
  // The meta row has no ftext, so the stripper leaves it fully intact.
  const ftextStripper = (k, v) =>
    (k === 'ftext' && typeof v === 'string' && v.length > 0) ? undefined : v;
  try {
    localStorage.setItem('seeandlearn-links', JSON.stringify([meta].concat(mlRows), ftextStripper));
    localStorage.setItem('sal-edited',        Date.now().toString());
    localStorage.setItem('ml-col-widths',     JSON.stringify(colWidths));
    localStorage.setItem('ml-col-order',      JSON.stringify(cols));
    localStorage.setItem('ml-col-hidden',     JSON.stringify([...hidden]));
  } catch(e) {}
  // 2. Disk (async, fire-and-forget — updates m:\jj\ml.json on every change)
  writeFileToDisk('ml.json', [meta].concat(mlRows)).then(ok => {
    if (ok) setFsaStatus('📂 ' + (_fsaDir ? _fsaDir.name : '') + ' — saved ' + new Date().toTimeString().slice(0,8));
  });
}

// Load
async function load() {
  let raw = null;
  let rawSource = null; // 'fetch' or 'localStorage' — for diagnostic toast
  // Try ml.json from server first
  try { const r = await fetch('ml.json?t='+Date.now()); if (r.ok) { raw = await r.json(); rawSource = 'fetch'; } } catch(e) {}

  // (zip0165) Prefer localStorage if it's NEWER than the fetched ml.json.
  // This rescues edits when the disk write silently failed (FSA permission
  // dropped, etc.). We compare localStorage's `sal-edited` timestamp
  // (Date.now() millis at last save) against the max DateModified across
  // the fetched data rows. If localStorage is newer by > 2 seconds, use it.
  // The 2s slop avoids ping-ponging when the two are nominally equal.
  try {
    const lsRaw = localStorage.getItem('seeandlearn-links');
    const lsEdited = parseInt(localStorage.getItem('sal-edited') || '0', 10);
    if (lsRaw && lsEdited) {
      // Find max DateModified in fetched data (skip the meta row)
      let diskMax = 0;
      if (Array.isArray(raw)) {
        for (let i = 0; i < raw.length; i++) {
          const r = raw[i];
          if (!r || r._salMeta) continue;
          const dm = r.DateModified;
          if (typeof dm === 'string' && dm) {
            // ISO format "YYYY-MM-DD HH:MM:SS" or full ISO — Date.parse handles both
            const t = Date.parse(dm.replace(' ', 'T'));
            if (!isNaN(t) && t > diskMax) diskMax = t;
          }
        }
      }
      // (dev0367) The LS-rescue is a DEV-only safety net for failed disk
      // writes. In user mode there's no FSA folder to rescue from, so a stale
      // `sal-edited` (left by a past /unlock edit on this domain) must NEVER
      // be allowed to discard the freshly-fetched ml.json — that's the "site
      // shows old data after I push" bug. Public viewers always trust the fetch.
      const _inUserEarly = (typeof _isUserMode === 'function') ? _isUserMode() : false;
      if (!_inUserEarly && lsEdited > diskMax + 2000) {
        try {
          const lsParsed = JSON.parse(lsRaw);
          if (Array.isArray(lsParsed) && lsParsed.length) {
            // The LS mirror is ftext-stripped (see save()). Rehydrate ftext
            // from the disk-fetched rows by UID so the recovery copy keeps its
            // HTML content. Only fill rows whose ftext is absent — a row with
            // ftext === '' was deliberately cleared and must stay cleared.
            const diskFtext = new Map();
            if (Array.isArray(raw)) {
              for (const r of raw) {
                if (r && !r._salMeta && r.UID != null && typeof r.ftext === 'string') {
                  diskFtext.set(String(r.UID), r.ftext);
                }
              }
            }
            const lsData = lsParsed.filter(r => !r._salMeta);
            for (const r of lsData) {
              if (r && r.ftext === undefined && r.UID != null && diskFtext.has(String(r.UID))) {
                r.ftext = diskFtext.get(String(r.UID));
              }
            }
            // (dev0325) The LS mirror now carries its OWN meta row (Views, layout,
            // sort, grid size). Since LS is the newer copy here, prefer ITS meta
            // so Views created after a lapsed disk permission survive. Fall back
            // to the disk meta (pre-dev0325 LS copies had none), then to no meta.
            const lsMeta = lsParsed.find(r => r && r._salMeta);
            if (lsMeta) {
              raw = [lsMeta].concat(lsData);
            } else if (Array.isArray(raw) && raw.length && raw[0]._salMeta) {
              raw = [raw[0]].concat(lsData);
            } else {
              raw = lsData;
            }
            rawSource = 'localStorage';
            console.warn('load(): localStorage is newer than ml.json — using localStorage. '
              + 'Disk write probably failed; check FSA folder permission.');
            // (zip0174) Toast only shown to devs; users have no folder to re-pick.
            const _inUser = (typeof _isUserMode === 'function') ? _isUserMode() : false;
            if (!_inUser) {
              try { toast('⚠ Loaded from localStorage (disk was stale) — re-pick project folder', 4000); } catch(e) {}
            }
          }
        } catch(e) { console.warn('localStorage parse failed:', e); }
      }
    }
  } catch(e) {}

  // Fallback to localStorage if fetch failed entirely
  if (!raw) { try { const ls = localStorage.getItem('seeandlearn-links'); if (ls) { raw = JSON.parse(ls); rawSource = 'localStorage'; } } catch(e) {} }

  raw = fixAll(raw);

  // Extract meta and data
  if (Array.isArray(raw) && raw.length && raw[0]._salMeta) {
    metaRow = raw[0];
    data    = raw.slice(1);
    // Restore layout from _salMeta
    if (metaRow._salColWidths && typeof metaRow._salColWidths === 'object') colWidths = Object.assign({}, metaRow._salColWidths);
    if (Array.isArray(metaRow._salColOrder) && metaRow._salColOrder.length)  cols    = metaRow._salColOrder.slice();
    if (Array.isArray(metaRow._salHidden))                                    hidden  = new Set(metaRow._salHidden);
    // (zip0153) Restore last-used grid size (2-5). Defaults to 5 on
    // missing/invalid value.
    if (typeof metaRow._salGsize === 'number'
        && metaRow._salGsize >= 2 && metaRow._salGsize <= 5) {
      _gridGsize = metaRow._salGsize;
    }
    // _salViews and _salActiveView are preserved in metaRow as-is; buildMeta() re-emits them
  } else if (Array.isArray(raw)) {
    data = raw;
  }

  // Instagram sandbox merge. instagram.json holds experimental rows (reels,
  // posts) that play via iframe embeds — see video.js mountInstagramEmbed.
  // Merged in with _salIg=true so save() filters them out of ml.json writes.
  // Missing file is fine; the experiment can be excised by deleting it.
  //
  // PAUSED: the IG experiment is on hold, and its sandbox UID (900001) sorts to
  // the top under UID-desc, cluttering the working table. Flip IG_SANDBOX back
  // to true to resume merging instagram.json. The file is left untouched.
  const IG_SANDBOX = false;
  if (IG_SANDBOX) try {
    const igR = await fetch('instagram.json?t=' + Date.now());
    if (igR.ok) {
      const igRaw = await igR.json();
      if (Array.isArray(igRaw)) {
        const igFixed = fixAll(igRaw);
        for (let i = 0; i < igFixed.length; i++) {
          const r = igFixed[i];
          if (r && !r._salMeta) { r._salIg = true; data.push(r); }
        }
      }
    }
  } catch (e) { /* file optional */ }

  // localStorage overrides meta (local edits win over what was on disk)
  try { const cw=localStorage.getItem('ml-col-widths'); if(cw) Object.assign(colWidths, JSON.parse(cw)); } catch(e) {}
  try { const co=localStorage.getItem('ml-col-order');  if(co) { const a=JSON.parse(co); if(Array.isArray(a)&&a.length) cols=a; } } catch(e) {}
  try { const ch=localStorage.getItem('ml-col-hidden'); if(ch) { const a=JSON.parse(ch); if(Array.isArray(a)) hidden=new Set(a); } } catch(e) {}

  updateFtextSizes();   // populate FtextSize before buildCols so the col shows
  buildCols();
  migrateDates(data);   // convert old yy.mm.dd format to ISO on every load
  // Restore last-saved sort state so the table opens in the order the user
  // left it. Falls through to "UID desc" (highest first) — the routine working
  // order for editing — when metadata carries no saved sort.
  if (metaRow && metaRow._salSort && metaRow._salSort.col) {
    sortCol = metaRow._salSort.col;
    sortDir = metaRow._salSort.dir === 'desc' ? 'desc' : 'asc';
  } else {
    sortCol = 'UID';
    sortDir = 'desc';
  }
  // Load the tag dictionary (tags.json). Safe even if file doesn't exist —
  // tagsLib seeds a starter dictionary in that case.
  if (window.tagsLib) {
    try { await window.tagsLib.load(); } catch(e) { console.warn('tags load failed:', e); }
  }
  buildSort();
  render();
}

function buildCols() {
  // Collect all keys that exist in the data
  const seen = new Set();
  data.forEach(r => Object.keys(r).forEach(k => seen.add(k)));
  // Keep existing order for known cols; append any new ones
  const kept  = cols.filter(c => seen.has(c));
  const fresh = [...seen].filter(c => !kept.includes(c));
  cols = kept.length ? [...kept, ...fresh] : [...seen];
}

// Sort
function buildSort() {
  const idxs = data.map((_,i) => i);
  // Apply gname substring filter when in C-mode
  const filtered = (_cMode && _cGnameFilter)
    ? idxs.filter(i => String(data[i].gname||'').toLowerCase().includes(_cGnameFilter))
    : idxs;
  if (!sortCol) { sortedIdx = filtered.length < data.length ? filtered : null; return; }
  const dir  = sortDir === 'desc' ? -1 : 1;
  const isDate = sortCol === 'DateAdded' || sortCol === 'DateModified';
  filtered.sort((a,b) => {
    const va = String(data[a][sortCol]||''), vb = String(data[b][sortCol]||'');
    if (!isDate) {
      const na = parseFloat(va), nb = parseFloat(vb);
      if (!isNaN(na) && !isNaN(nb)) return (na-nb)*dir;
    }
    return va < vb ? -dir : va > vb ? dir : 0;
  });
  sortedIdx = filtered;
}
function vr(vi) { return sortedIdx ? sortedIdx[vi] : vi; }
function visCols() { return cols.filter(c => !hidden.has(c)); }

// (dev0462) Last-seen pointer position + "which T column is under the mouse".
// yt imports (`w`) now auto-fill ftext (caption), which used to force E into the
// ftext editor (Xe) for video rows. _colUnderMouse lets the E hotkey gate ftext
// editing on the pointer's COLUMN (x-span only — it need not be over a row, per
// the spec), so a video row only opens Xe when the mouse sits in the ftext
// column; anywhere else it opens the video editor. Reads the sticky <thead>
// header cells' x-spans against the last pointer x. Returns the column name
// (e.g. 'ftext') or null when the pointer is outside the table's columns.
let _lastPointerX = -1, _lastPointerY = -1;
document.addEventListener('mousemove', e => { _lastPointerX = e.clientX; _lastPointerY = e.clientY; }, { passive: true });
function _colUnderMouse() {
  if (_lastPointerX < 0) return null;
  const ths = document.querySelectorAll('#thead th[data-col]');
  for (const th of ths) {
    const r = th.getBoundingClientRect();
    if (r.width > 0 && _lastPointerX >= r.left && _lastPointerX < r.right) return th.getAttribute('data-col');
  }
  return null;
}
window._colUnderMouse = _colUnderMouse;

// colW returns the width for a column — saved width OR auto-measured
function colW(col) {
  const saved = colWidths[col];
  return (saved !== undefined && saved !== null) ? saved : autoColW(col);
}

// Apply width to a single th+all its tds (without full render)
function applyColW(col, w) {
  colWidths[col] = w;
  const th = document.querySelector('#thead th[data-col="'+CSS.escape(col)+'"]');
  if (th) setThW(th, w);
  // (dev0322) Under table-layout:fixed the <colgroup> is authoritative — moving
  // the matching <col> resizes the entire column in O(1), with no per-row work
  // (the old per-<td> loop made every resize-drag frame O(rows)).
  const colEl = document.querySelector('#colgroup col[data-col="'+CSS.escape(col)+'"]');
  if (colEl) colEl.style.width = w + 'px';
  // (dev0325) Keep the explicit table width in sync — under fixed layout the
  // table width is authoritative, so without this a wider column would steal
  // space from the others instead of widening the table (and scrolling).
  setTableWidth();
}

function setThW(th, w) {
  th.style.width    = w + 'px';
  th.style.minWidth = w + 'px';
  th.style.maxWidth = w + 'px';
}
function setTdW(td, w) {
  td.style.width    = w + 'px';
  td.style.minWidth = w + 'px';
  td.style.maxWidth = w + 'px';
}

// (dev0325) table-layout:fixed only honours the per-column <colgroup> widths
// when the table itself has a DEFINITE width. With width:max-content (or auto)
// Chromium sizes the table to its unwrapped white-space:nowrap content, so a
// long ftext cell blows the column out to ~700k px and the colgroup cap is
// silently ignored — this was the "size30max / size60max not working" bug.
// Setting an explicit px width = sum of every <col> makes fixed layout clamp
// each column to its <col> width (content clipped by overflow:hidden/ellipsis).
// min-width:100% (CSS) still lets the table fill the viewport when columns are
// narrow. O(cols), never O(rows) — safe to call on every resize-drag frame.
function setTableWidth() {
  const cg  = document.getElementById('colgroup');
  const tbl = document.getElementById('tbl');
  if (!cg || !tbl) return;   // stale-HTML fallback path has no colgroup
  let sum = 0;
  for (const c of cg.children) sum += parseFloat(c.style.width) || 0;
  if (sum > 0) tbl.style.width = sum + 'px';
}

// Render
function render() {
  renderHead(); renderBody(); renderStatus(); updateShowAllBtn();
  // (zip0122) Update last-record memory from current T-view focus, so simply
  // navigating with arrows updates the UID badge and gives D something to
  // restore focus to on return.
  if (focus !== null && typeof vr === 'function') {
    try {
      const di = vr(focus.r);
      if (di >= 0 && di < data.length && data[di] && data[di].UID) {
        if (typeof window.setLastUID === 'function') window.setLastUID(data[di].UID);
      }
    } catch (_) {}
  }
  // (dev0332) If the focused-row preview is open, follow the new focus row;
  // if it's remembered-but-hidden and T is the visible screen again, re-show it.
  if (typeof rowPreviewSyncToFocus === 'function') rowPreviewSyncToFocus();
  if (typeof _rpvMaybeReshow === 'function') _rpvMaybeReshow();
}

function buildTable() {
  // Close annotate panel if it somehow persists when not in E mode
  if (!document.getElementById('video-editor-overlay')) {
    const br = document.getElementById('browseOverlay');
    if (br && br.style.display === 'flex') {
      br.style.display = 'none';
      const w = document.getElementById('wrap'); if (w) w.style.marginRight = '';
    }
  }
  render();
}

function renderHead() {
  const thead = document.getElementById('thead');
  thead.innerHTML = '';
  const vc = visCols();

  // (dev0322) Rebuild the <colgroup> so table-layout:fixed has authoritative
  // per-column widths. Order mirrors the cells below: 0=row-num, 1=checkbox,
  // then one <col> per visible column. data-col lets live resize (applyColW)
  // update the matching <col> without a full render. Because of the global
  // box-sizing:border-box, a <col width:N> equals the cell border-box width,
  // so columns render at the same size they did under auto layout.
  const cg = document.getElementById('colgroup');
  if (cg) {
    cg.innerHTML = '';
    const addCol = (w, col) => {
      const c = document.createElement('col');
      c.style.width = w + 'px';
      if (col) c.setAttribute('data-col', col);
      cg.appendChild(c);
    };
    addCol(34);   // row-number column (matches th0/td0)
    addCol(26);   // checkbox column   (matches thcb/tdcb)
    vc.forEach(col => addCol(colW(col), col));
  }

  const tr = document.createElement('tr');

  // Row-number th
  const th0 = document.createElement('th'); th0.className = 'rn'; th0.textContent = '#';
  setThW(th0, 34); addCtxT(th0, {type:'rownum'}); tr.appendChild(th0);

  // Checkbox th
  const thcb = document.createElement('th'); thcb.className = 'cbh';
  setThW(thcb, 26);
  const allCb = document.createElement('input'); allCb.type = 'checkbox';
  allCb.checked       = data.length > 0 && checkedRows.size === data.length;
  allCb.indeterminate = checkedRows.size > 0 && checkedRows.size < data.length;
  allCb.addEventListener('change', () => {
    if (allCb.checked) data.forEach((_,i) => checkedRows.add(i)); else checkedRows.clear();
    renderBody(); renderStatus();
  });
  thcb.appendChild(allCb); tr.appendChild(thcb);

  vc.forEach(col => {
    const w  = colW(col);
    const th = document.createElement('th');
    th.className = 'sortable';
    th.style.position = 'relative';   // needed for absolute .rh child
    setThW(th, w);
    th.setAttribute('data-col', col);
    const arrow = sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    th.textContent = col + arrow;
    th.title = col + ' — click:sort · drag:reorder · right-click:options';
    // (dev0353) Match the 'cell' column tint applied to body cells.
    if (col === 'cell') { th.style.background = 'rgba(95,250,170,0.16)'; th.style.color = '#8fe'; }

    // Resize handle
    const rh = document.createElement('div'); rh.className = 'rh';
    rh.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); startResize(col, th, e.clientX); });
    th.appendChild(rh);

    // Drag-to-reorder (hold and move)
    th.addEventListener('mousedown', e => { if (e.button !== 0 || e.target === rh) return; startColDrag(e, col, th); });
    // Sort on click (only if no drag or resize happened)
    th.addEventListener('click', e => {
      if (e.target === rh || _colDragHappened || _resizeHappened) return;
      if (sortCol === col) sortDir = sortDir === 'asc' ? 'desc' : 'asc'; else { sortCol = col; sortDir = 'asc'; }
      focus = null; pending = null; buildSort(); render();
    });

    addCtxT(th, {type:'col', col});
    tr.appendChild(th);
  });
  thead.appendChild(tr);
  setTableWidth();   // (dev0325) clamp table to sum of <col> widths — see helper
}

// Vimeo thumbnail cache — shared by the Annotate-panel preview (brBuildThumb).
const _vimeoThumbCache = {}; // url → {state:'pending'|'ok'|'fail', src?}

// Async: fetch Vimeo thumbnail via oEmbed, cache result, call onReady(src) when done
function fetchVimeoThumb(url, onReady) {
  if (!url || !/vimeo\.com/i.test(url)) return;
  if (_vimeoThumbCache[url]) {
    if (_vimeoThumbCache[url].state === 'ok') onReady(_vimeoThumbCache[url].src);
    return; // pending or failed — caller will retry on next render
  }
  _vimeoThumbCache[url] = { state: 'pending' };
  fetch('https://vimeo.com/api/oembed.json?url=' + encodeURIComponent(url) + '&width=320')
    .then(r => r.ok ? r.json() : Promise.reject(r.status))
    .then(j => {
      const src = j.thumbnail_url || '';
      _vimeoThumbCache[url] = { state: src ? 'ok' : 'fail', src };
      if (src) onReady(src);
    })
    .catch(() => { _vimeoThumbCache[url] = { state: 'fail' }; });
}

// (dev0330) Focused-row preview pane — Ctrl+I. A small floating ~450×300 (3:2)
// render of the focused T row's media (video / image / html-slide / quiz),
// reusing the SAME branch order + mount helpers as the grid cell renderer
// (grid.js): isVideoRow, renderFtext, _buildFtextImgCell, fitGridHtmlThumb,
// fitGridIgFrame, and window.mount{YouTube,Vimeo,DirectVideo,Instagram}…. It is a
// transient fixed overlay OUTSIDE the virtualized <tbody> so it never interferes
// with row recycling. Controls are deliberately minimal: Space = play/pause the
// video (the only control), Esc / Ctrl+I = close.
const RPV_HOST_ID = 'rpv-host';   // video mounts register under this id in seeLearnVideoPlayers
let _rpvOpen = false;
let _rpvDi   = -1;                // data-row index currently previewed (drives the toggle)
let _rpvWantOpen = false;         // (dev0332) sticky intent: re-show on return to T until an explicit Ctrl+I/Esc close
let _rpvMuted = null;             // (dev0355) null = follow row.Mute; true/false = explicit override set by clicking the pane. Persists across row changes until the pane is dismissed.

// Segment palette — MUST match video.js COLOURS / vp.js VP_COLOURS so a row's
// segment colors are consistent across the V timeline bands, this caption, and
// (planned) the G bottom bar.
const SEG_CAPTION_COLOURS = ['#2a6ef5','#e5732a','#2aa87a','#c03ec0','#c0c03e','#e53a3a'];

// (dev0331) Reusable multicolored segment caption line for a row that has
// VidRange segments + VidComment labels. Returns a single-line <div> with one
// colored span per segment (comment text, or "Seg N" when blank), or null when
// the row has no segments. Pass onSegClick(i, seg) to make each span clickable —
// reserved for the planned G single-segment play actions (see memory). KEEP this
// generic: it is the shared "segments line" the T preview and G both render.
function buildSegmentCaptionLine(row, onSegClick) {
  const segs = (window.parseVideoAsset ? window.parseVideoAsset(row.VidRange) : null) || [];
  if (!segs.length) return null;
  const comments = (row.VidComment || '').split(',').map(s => s.trim());
  const line = document.createElement('div');
  line.className = 'segcap-line';
  line.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  segs.forEach((s, i) => {
    const sp = document.createElement('span');
    sp.style.cssText = 'color:' + SEG_CAPTION_COLOURS[i % SEG_CAPTION_COLOURS.length] + ';'
      + 'font-weight:bold;margin-right:8px;' + (onSegClick ? 'cursor:pointer;' : '');
    sp.textContent = comments[i] || ('Seg ' + (i + 1));
    if (onSegClick) sp.addEventListener('click', e => { e.stopPropagation(); onSegClick(i, s); });
    line.appendChild(sp);
  });
  return line;
}
window.buildSegmentCaptionLine = buildSegmentCaptionLine;

// (dev0331) Full preview-pane caption: up to 4 stacked lines, highest precedence
// first so CSS overflow trims the LOWEST-priority line (title) when space runs
// out. Precedence: 1) segments/VidComment (multicolored, only if vidcomments
// exist) · 2) tags (may wrap to a 2nd line) · 3) VidAuthor + count of rows by
// that author · 4) UID + title.
function buildRowPreviewCaption(row) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:1px;font:11px/1.35 monospace;overflow:hidden;';

  // 1. Segments — only when the row actually has VidComment text.
  if ((row.VidComment || '').trim()) {
    const seg = buildSegmentCaptionLine(row);
    if (seg) wrap.appendChild(seg);
  }
  // 2. Tags (allowed to wrap to a row below).
  const tagIds = Array.isArray(row.tags) ? row.tags : [];
  if (tagIds.length) {
    const t = document.createElement('div');
    t.style.cssText = 'color:#8fe0c0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word;';
    t.textContent = '🏷 ' + tagIds.map(id => (window.tagsLib ? (window.tagsLib.labelFor(id) || id) : id)).join(' · ');
    wrap.appendChild(t);
  }
  // 3. VidAuthor + how many rows share that author.
  const author = (row.VidAuthor || '').trim();
  if (author) {
    let n = 0; for (let i = 0; i < data.length; i++) if ((data[i].VidAuthor || '').trim() === author) n++;
    const a = document.createElement('div');
    a.style.cssText = 'color:#d8c69a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    a.textContent = '👤 ' + author + '  (' + n + ')';
    wrap.appendChild(a);
  }
  // 4. UID + title (lowest precedence — trimmed first if the caption overflows).
  const title = (row.VidTitle || row.t1 || row.n1 || '').trim();
  const idLine = document.createElement('div');
  idLine.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  const uidSpan = document.createElement('span');
  uidSpan.style.cssText = 'color:#6aa6e0;font-weight:bold;';
  uidSpan.textContent = '#' + (row.UID != null && row.UID !== '' ? row.UID : '?');
  idLine.appendChild(uidSpan);
  if (title) {
    const ts = document.createElement('span');
    ts.style.cssText = 'color:#bcd;margin-left:6px;';
    ts.textContent = title;
    idLine.appendChild(ts);
  }
  wrap.appendChild(idLine);
  return wrap;
}

// Internal teardown (idempotent): destroy the mounted video + remove the
// overlay. Leaves the sticky _rpvWantOpen intent untouched — callers decide.
function _rpvTeardown() {
  if (window.stopCellVideoLoop) { try { window.stopCellVideoLoop(RPV_HOST_ID); } catch (_) {} }
  const ov = document.getElementById('rowPreview');
  if (ov) ov.remove();
  _rpvOpen = false;
  _rpvDi = -1;
}

// (dev0332) Hide the pane but REMEMBER it was open, so returning to T re-shows
// it (video restarts from the beginning). Used when leaving T for another
// screen — tears down the video so a backgrounded pane never burns
// YouTube/Vimeo bandwidth.
function rowPreviewHide() { _rpvTeardown(); }
window.rowPreviewHide = rowPreviewHide;

// Explicit close (Ctrl+I toggle / Esc): tear down AND forget the intent, so the
// pane does NOT auto-reappear when you next land on T.
function rowPreviewClose() { _rpvTeardown(); _rpvWantOpen = false; _rpvMuted = null; /* (dev0355) forget mute override on dismiss */ }
window.rowPreviewClose = rowPreviewClose;

// Open (or refresh) the preview for the currently focused row.
function rowPreviewOpen() {
  if (focus === null) { toast('👁 Click a row to focus it, then Ctrl+I', 1600); return; }
  const di = vr(focus.r);
  const row = (di >= 0 && di < data.length) ? data[di] : null;
  if (!row) { toast('👁 No row to preview', 1400); return; }
  _rpvTeardown();   // start clean (tears down any prior video)

  const ov = document.createElement('div');
  ov.id = 'rowPreview';
  ov.style.cssText = 'position:fixed;left:14px;bottom:46px;width:450px;height:300px;'
    + 'z-index:4000;background:#000;border:1px solid #4df;border-radius:6px;'
    + 'box-shadow:0 8px 30px rgba(0,0,0,0.75);overflow:hidden;display:flex;flex-direction:column;';

  // Media host: a fixed-size, position:relative box the grid helpers fill via inset:0.
  // Its id === RPV_HOST_ID so a mounted video registers under that key.
  const host = document.createElement('div');
  host.id = RPV_HOST_ID;
  host.style.cssText = 'position:relative;flex:1 1 auto;background:#000;overflow:hidden;';
  ov.appendChild(host);

  // (dev0355) Video rows get a click-to-mute shield + state badge over the media.
  // The transparent shield sits above the (cross-origin) iframe/video so the
  // click always lands. State lives in _rpvMuted, persisting until dismissed.
  if (window.isVideoRow && window.isVideoRow(row)) {
    const muteShield = document.createElement('div');
    muteShield.id = 'rpvMuteShield';
    muteShield.title = 'Click: toggle audio mute';
    muteShield.style.cssText = 'position:absolute;inset:0;z-index:6;cursor:pointer;background:transparent;';
    muteShield.addEventListener('click', e => { e.stopPropagation(); _rpvToggleMute(); });
    host.appendChild(muteShield);
    const muteBadge = document.createElement('div');
    muteBadge.id = 'rpvMuteBadge';
    muteBadge.style.cssText = 'position:absolute;top:4px;right:6px;z-index:7;font-size:15px;'
      + 'background:rgba(0,0,0,0.55);border-radius:4px;padding:1px 5px;pointer-events:none;user-select:none;';
    muteBadge.textContent = _rpvCurrentMuted() ? '🔇' : '🔊';
    host.appendChild(muteBadge);
  }

  // Caption: up to 4 multicolored precedence lines (segments · tags · author+count · UID/title).
  const cap = document.createElement('div');
  cap.style.cssText = 'flex:0 0 auto;max-height:68px;overflow:hidden;padding:4px 8px;'
    + 'background:#0a1426;border-top:1px solid #1a2a4a;';
  cap.appendChild(buildRowPreviewCaption(row));
  ov.appendChild(cap);

  document.body.appendChild(ov);
  _rpvOpen = true;
  _rpvWantOpen = true;   // (dev0332) remember it across screen switches until an explicit close
  _rpvDi = di;
  _rpvFillHost(host, row);
}

// (dev0332) Keep an OPEN preview pinned to the currently focused row. Any focus
// change (arrow nav, click, edit-move, dev scrolling, sort) calls this; it
// rebuilds the pane for the new row only when focus actually moved to a
// DIFFERENT data row, so it's a cheap no-op otherwise. Closed pane → no-op.
function rowPreviewSyncToFocus() {
  if (!_rpvOpen || focus === null) return;
  const di = vr(focus.r);
  if (di < 0 || di >= data.length || di === _rpvDi) return;
  rowPreviewOpen();   // tears down the old row's video + rebuilds for the new one
}
window.rowPreviewSyncToFocus = rowPreviewSyncToFocus;

// (dev0332) Re-show a remembered-but-hidden pane once its home screen (T) is
// visible again — the video restarts from the beginning (a fresh mount). Called
// from render(), which is the common landing point for every return-to-T path
// (buildTable, closeCScreen). Deferred to a macrotask so a path that renders the
// table then covers it (Grid does buildTable() then gridShow()) settles first;
// if anything is covering T by then, we stay hidden. No-op unless we're in the
// want-but-hidden state, so the normal render path costs nothing.
function _rpvMaybeReshow() {
  if (!_rpvWantOpen || _rpvOpen) return;
  setTimeout(() => {
    if (!_rpvWantOpen || _rpvOpen || focus === null) return;
    const covered = document.getElementById('gridOverlay')?.style.display === 'flex'
      || document.getElementById('gridFullscreen')?.style.display === 'flex'
      || !!document.getElementById('video-editor-overlay')
      || !!document.getElementById('textEditorOverlay')
      || document.getElementById('browseOverlay')?.style.display === 'flex';
    if (covered) return;   // T isn't the visible (uncovered) screen — stay hidden
    rowPreviewOpen();
  }, 0);
}

// Fill the media host from a row — branch order mirrors grid.js (IG / quiz /
// html-slide / video / ftext-image / plain image / empty).
function _rpvFillHost(host, row) {
  const isVid     = window.isVideoRow ? window.isVideoRow(row) : false;
  const isText    = row.VidRange === 'text' || (row.ftext && !row.link);
  const isQuiz    = !!(row.qfile || (row.ftext && !row.link && (row.ftext.trim().startsWith('[') || row.ftext.trim().startsWith('{'))));
  const isImgLink = /\.(jpe?g|png|gif|webp|svg|bmp|tiff?)(\?.*)?$/i.test(row.link || '');
  const isIG      = !!(row.link && window.isInstagramLink && window.isInstagramLink(row.link));

  if (isIG) {
    const igWrap = document.createElement('div');
    igWrap.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:#000;z-index:1;';
    const igFrame = document.createElement('iframe');
    igFrame.src = window.instagramEmbedUrl(row.link);
    igFrame.setAttribute('frameborder', '0');
    igFrame.setAttribute('scrolling', 'no');
    igFrame.setAttribute('allowtransparency', 'true');
    igFrame.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; web-share');
    igFrame.style.cssText = 'position:absolute;left:0;top:0;width:326px;height:620px;border:0;background:#000;transform-origin:top left;';
    igWrap.appendChild(igFrame);
    host.appendChild(igWrap);
    if (typeof fitGridIgFrame === 'function') fitGridIgFrame(host, igFrame);
  } else if (isQuiz) {
    host.style.background = '#0a1a0a';
    const badge = document.createElement('div');
    badge.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:1;';
    const ic = document.createElement('div'); ic.style.cssText = 'font-size:40px;margin-bottom:6px;'; ic.textContent = '📋';
    const lb = document.createElement('div');
    lb.style.cssText = 'font-size:12px;color:#8f8;font-family:monospace;text-align:center;padding:0 10px;';
    lb.textContent = row.qfile || row.n1 || 'Quiz';
    badge.appendChild(ic); badge.appendChild(lb); host.appendChild(badge);
  } else if (isText && row.ftext) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:#fff;z-index:1;';
    const inner = document.createElement('div');
    inner.className = 'grid-html-thumb';
    inner.style.cssText = 'position:absolute;top:0;left:0;width:600px;transform-origin:top left;'
      + 'font-family:Arial,sans-serif;color:#222;padding:16px;box-sizing:border-box;';
    inner.innerHTML = (typeof renderFtext === 'function' ? renderFtext(row.ftext) : row.ftext);
    if (typeof _ensureGridThumbTableCss === 'function') _ensureGridThumbTableCss();
    if (typeof _gridThumbApplySlideColors === 'function') _gridThumbApplySlideColors(wrap, inner);
    wrap.appendChild(inner); host.appendChild(wrap);
    host.style.background = '#fff';
    if (typeof fitGridHtmlThumb === 'function') fitGridHtmlThumb(host, wrap, inner);
  } else if (isVid && row.link) {
    const segs  = (window.parseVideoAsset ? window.parseVideoAsset(row.VidRange) : null) || [{ start: 0, dur: 99999 }];
    // (dev0355) Honor a click-set mute override (_rpvMuted) for the life of the
    // pane; otherwise fall back to the row's Mute column (like V). Default audio-on.
    const muted = _rpvMuted !== null ? _rpvMuted : (String(row.Mute).trim() === '1');
    // Mount after a paint so the host has real dimensions (matches grid timing).
    setTimeout(() => {
      if (!_rpvOpen || !document.getElementById('rowPreview')) return;  // closed before mount
      if (window.isYouTubeLink && window.isYouTubeLink(row.link) && window.mountYouTubeClip) {
        window.mountYouTubeClip(host, row.link, segs[0].start, segs[0].dur, muted, undefined, segs);
      } else if (window.isVimeoLink && window.isVimeoLink(row.link) && window.mountVimeoClip) {
        window.mountVimeoClip(host, row.link, segs[0].start, segs[0].dur, muted, undefined, segs);
      } else if (window.isDirectVideoLink && window.isDirectVideoLink(row.link) && window.mountDirectVideoClip) {
        window.mountDirectVideoClip(host, row.link, segs[0].start, segs[0].dur, muted, undefined, segs);
      } else if (window.isInstagramLink && window.isInstagramLink(row.link) && window.mountInstagramEmbed) {
        window.mountInstagramEmbed(host, row.link);
      } else if (window.isTikTokLink && window.isTikTokLink(row.link) && window.mountTikTokEmbed) {
        window.mountTikTokEmbed(host, row.link);
      }
    }, 60);
  } else if (row.link && !isImgLink) {
    if (typeof _buildFtextImgCell === 'function') _buildFtextImgCell(host, row);
  } else if (row.link) {
    const img = document.createElement('img');
    img.src = row.link;
    img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:1;';
    img.onerror = () => { img.style.display = 'none'; };
    host.appendChild(img);
  } else {
    const e0 = document.createElement('div');
    e0.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#456;font:12px monospace;';
    e0.textContent = '(no media)';
    host.appendChild(e0);
  }
}

// Space toggles play/pause of the preview's video (no-op for image/html/quiz).
// Mirrors gridTogglePauseCell, keyed on RPV_HOST_ID.
function _rpvTogglePlay() {
  const player = window.seeLearnVideoPlayers && window.seeLearnVideoPlayers[RPV_HOST_ID];
  if (!player) return;
  let isPaused = false;
  if (player._gridPaused !== undefined)                 isPaused = player._gridPaused;
  else if (typeof player.getPlayerState === 'function') { try { isPaused = player.getPlayerState() !== 1; } catch (_) {} }
  else if (player._salPaused !== undefined)             isPaused = player._salPaused;
  if (isPaused) {
    player._gridPaused = false;
    try { if (typeof player.playVideo === 'function') player.playVideo(); else if (typeof player.play === 'function') player.play(); } catch (_) {}
  } else {
    player._gridPaused = true;
    if (window.seeLearnVideoTimers && window.seeLearnVideoTimers[RPV_HOST_ID]) {
      clearInterval(window.seeLearnVideoTimers[RPV_HOST_ID]);
      delete window.seeLearnVideoTimers[RPV_HOST_ID];
    }
    try { if (typeof player.pauseVideo === 'function') player.pauseVideo(); else if (typeof player.pause === 'function') player.pause(); } catch (_) {}
  }
}

// (dev0355) Mute control for the preview pane. Clicking the media toggles audio;
// the choice lives in _rpvMuted and persists across row changes (rowPreviewOpen
// reads it on every mount) until the pane is dismissed (rowPreviewClose clears
// it). Player API mirrors video.js applyMuteToLivePlayer.
function _rpvApplyMuteToPlayer(muted) {
  const p = window.seeLearnVideoPlayers && window.seeLearnVideoPlayers[RPV_HOST_ID];
  if (!p) return;
  try {
    if (muted) {
      if (typeof p.mute === 'function') p.mute();
      else if (typeof p.setMuted === 'function') p.setMuted(true);
      else if (typeof p.setVolume === 'function') p.setVolume(0);
    } else {
      if (typeof p.unMute === 'function') p.unMute();
      else if (typeof p.setMuted === 'function') p.setMuted(false);
      else if (typeof p.setVolume === 'function') p.setVolume(1);
    }
  } catch (_) {}
}
function _rpvCurrentMuted() {
  if (_rpvMuted !== null) return _rpvMuted;
  const row = (_rpvDi >= 0 && _rpvDi < data.length) ? data[_rpvDi] : null;
  return row ? String(row.Mute).trim() === '1' : false;
}
function _rpvUpdateMuteBadge() {
  const b = document.getElementById('rpvMuteBadge');
  if (b) b.textContent = _rpvCurrentMuted() ? '🔇' : '🔊';
}
function _rpvToggleMute() {
  _rpvMuted = !_rpvCurrentMuted();
  _rpvApplyMuteToPlayer(_rpvMuted);
  _rpvUpdateMuteBadge();
}

// Ctrl+I toggles the preview for the focused row (re-pressing on the SAME row
// closes it; on a newly-focused row it refreshes to that row). While open:
// Space = play/pause, Esc = close — both handled here (capture phase +
// stopImmediatePropagation) so Esc doesn't also deselect the row and Space
// doesn't scroll the page.
document.addEventListener('keydown', e => {
  const ae = document.activeElement;
  const inEditable = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);

  if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'i') {
    if (inEditable) return;   // allow Ctrl+I (italic) inside text editors
    e.preventDefault();
    const di = focus !== null ? vr(focus.r) : -1;
    if (_rpvOpen && di === _rpvDi) rowPreviewClose();
    else rowPreviewOpen();
    return;
  }

  if (!_rpvOpen || inEditable) return;
  if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault(); e.stopImmediatePropagation();
    _rpvTogglePlay();
  } else if (e.key === 'Escape') {
    e.preventDefault(); e.stopImmediatePropagation();
    rowPreviewClose();
  }
}, true);

// ── T-table virtualization / windowing (dev0327) ─────────────────────────
// renderBody renders ONLY the rows visible in #wrap (+ overscan), with top and
// bottom spacer <tr>s holding the scrollbar at full height. Row height is
// roughly uniform (CSS td height:24px; tag-chip rows a few px taller) and column
// widths come from the <colgroup> under table-layout:fixed, so a windowed subset
// never shifts layout and no per-row measuring is needed. The expensive
// colW()/measureText work runs ONCE per full render (renderBody) and is cached in
// _tCtx; the scroll path (_tRenderWindow) reuses it so scrolling never re-measures
// (that would resurrect the old O(rows²) lag).
let _tVisList = [];                   // [{vi,di}] rows passing the filter, in display order
let _tCtx = null;                     // cached cols/widths/thumb flags for the current full render
let _tRowH = 25;                      // measured AVG row height (px), LOCKED once (see _tMeasureRowH)
let _tRowHLocked = false;             // (dev0332) once true, _tRowH never changes — kills per-keystroke remap jump
let _tWinFirst = -1, _tWinLast = -1;  // last-rendered window range (skip rebuild if unchanged)
let _tScrollWired = false;
const T_OVERSCAN = 8;                 // extra rows rendered above/below the viewport

function _tRowHeight() {
  return _tRowH;
}

function _tWireScroll() {
  if (_tScrollWired) return;
  const wrap = document.getElementById('wrap');
  if (!wrap) return;
  let raf = 0;
  const schedule = (force) => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; _tRenderWindow(force === true); });
  };
  wrap.addEventListener('scroll', () => schedule(false), { passive: true });
  window.addEventListener('resize', () => schedule(true));
  _tScrollWired = true;
}

function _tSpacerRow(h) {
  const tr = document.createElement('tr');
  tr.className = 'vspacer';
  const td = document.createElement('td');
  td.setAttribute('colspan', '999');
  td.style.cssText = 'padding:0;border:0;height:' + h + 'px;';
  tr.appendChild(td);
  return tr;
}

// Render the slice of _tVisList in (or near) the #wrap viewport. force=true
// rebuilds even when the range is unchanged (after renderBody/filter/sort/mode);
// on plain scroll force=false skips the rebuild when the same rows are mounted.
function _tRenderWindow(force) {
  const tbody = document.getElementById('tbody');
  if (!tbody || !_tCtx) return;
  const wrap = document.getElementById('wrap');
  const total = _tVisList.length;
  const rowH = _tRowHeight();
  const clientH = (wrap && wrap.clientHeight) ? wrap.clientHeight : (window.innerHeight || 800);
  let scrollTop = wrap ? wrap.scrollTop : 0;
  // Clamp if the list shrank (filter/sort) below the current scroll offset.
  const maxScroll = Math.max(0, total * rowH - clientH);
  if (wrap && scrollTop > maxScroll) { scrollTop = maxScroll; wrap.scrollTop = scrollTop; }

  let first = Math.max(0, Math.floor(scrollTop / rowH) - T_OVERSCAN);
  let last  = Math.min(total, Math.ceil((scrollTop + clientH) / rowH) + T_OVERSCAN);
  if (!force && first === _tWinFirst && last === _tWinLast) return;
  _tWinFirst = first; _tWinLast = last;

  tbody.innerHTML = '';
  if (first > 0) tbody.appendChild(_tSpacerRow(first * rowH));
  for (let i = first; i < last; i++) {
    const ent = _tVisList[i];
    tbody.appendChild(_tBuildRow(ent.vi, ent.di));
  }
  if (last < total) tbody.appendChild(_tSpacerRow((total - last) * rowH));
}

// Scroll #wrap so display row vi sits in the viewport (below the sticky thead),
// re-render the window to include it, and return its <tr>.
function _tScrollRowIntoView(vi) {
  const wrap = document.getElementById('wrap');
  if (!wrap) return null;
  const rowH = _tRowHeight();
  const clientH = wrap.clientHeight || (window.innerHeight || 800);
  const headH = (document.getElementById('thead') || {}).offsetHeight || 0;
  // ~2 rows of context above/below before we scroll, so the window FOLLOWS focus
  // toward the edges without pinning the row flush against the header/footer.
  const margin = rowH * 2;

  // (dev0332) FAST/COMMON path — the row is already mounted (true for one-step
  // arrow nav and most clicks). Decide purely from REAL DOM geometry, immune to
  // the avg-row-height drift that previously made every keystroke scroll. Scroll
  // only the minimal delta needed to pull it back inside the comfortable band;
  // if it's already comfortably visible, do nothing (no scroll, no rebuild).
  const tr = document.querySelector('#tbody tr[data-vrow="'+vi+'"]');
  if (tr) {
    const wrapRect = wrap.getBoundingClientRect();
    const top = tr.getBoundingClientRect().top - wrapRect.top;   // px below wrap's top edge
    const bot = top + tr.offsetHeight;
    let delta = 0;
    if (top < headH + margin)          delta = top - (headH + margin);     // too high → scroll up
    else if (bot > clientH - margin)   delta = bot - (clientH - margin);   // too low → scroll down
    if (delta !== 0) {
      wrap.scrollTop = Math.max(0, wrap.scrollTop + delta);
      _tRenderWindow(false);   // pull in any rows the scroll newly exposed
    }
    return tr;
  }

  // FALLBACK — row not mounted (a far jump: programmatic focus, click far away).
  // Estimate its position from the virtual list and land it with the same margin.
  const idx = _tVisList.findIndex(o => o.vi === vi);
  if (idx < 0) { _tRenderWindow(true); return document.querySelector('#tbody tr[data-vrow="'+vi+'"]'); }
  const rowTop = idx * rowH, rowBot = rowTop + rowH;
  const before = wrap.scrollTop;
  let st = before;
  if (rowTop - margin < st + headH)        st = rowTop - margin - headH;
  else if (rowBot + margin > st + clientH) st = rowBot + margin - clientH;
  st = Math.max(0, st);
  if (st !== before) wrap.scrollTop = st;
  _tRenderWindow(st !== before);
  return document.querySelector('#tbody tr[data-vrow="'+vi+'"]');
}

function renderBody() {
  const vc = visCols();
  // (dev0324) Per-column widths computed ONCE (not per cell): colW() runs
  // autoColW(), which measureText()s every row, so per-cell calls were O(rows²)
  // — the real cause of the old multi-hundred-ms render() lag.
  const cw = {}; vc.forEach(c => { cw[c] = colW(c); });
  // Widths normally come from the <colgroup> under table-layout:fixed (built in
  // renderHead). If a stale/cached index.html lacks the colgroup or fixed-layout
  // CSS, auto layout would size columns to content and a long ftext cell would
  // blow the table out — so detect that and fall back to per-cell widths (using
  // the hoisted map, so still O(cells), never O(rows²)).
  const _tbl = document.getElementById('tbl');
  const needCellW = !document.getElementById('colgroup')
    || !(_tbl && getComputedStyle(_tbl).tableLayout === 'fixed');
  _tCtx = { vc, cw, needCellW };

  // Build the filtered, ordered row list (no DOM — cheap O(rows)).
  _tVisList = [];
  for (let vi = 0; vi < data.length; vi++) {
    const di = vr(vi);
    if (!rowMatchesFilter(data[di])) continue;
    _tVisList.push({ vi, di });
  }
  _tWireScroll();
  _tRenderWindow(true);
  _tMeasureRowH();   // (dev0328) lock an accurate avg row height; corrects once if off
}

// Measure the mounted rows' avg real height ONCE, then LOCK it for the session.
// (dev0332) Row heights vary (tag-chip rows ~29px vs plain ~25px), so averaging
// only the *currently mounted* subset gave a DIFFERENT _tRowH at different scroll
// positions. Because the spacer heights and the window math both derive from
// _tRowH, re-measuring on every full render (and every arrow key does a full
// render) remapped the whole window and made the focused row jump on each
// keystroke. Locking after the first representative sample keeps the
// scrollTop↔row mapping stable; _tScrollRowIntoView then uses REAL DOM geometry
// (not idx*_tRowH) to decide scrolling, so a slightly-approximate avg is fine.
function _tMeasureRowH() {
  if (_tRowHLocked) return;
  const tbody = document.getElementById('tbody');
  if (!tbody) return;
  const rows = tbody.querySelectorAll('tr[data-vrow]');
  if (rows.length < 4) return;   // wait for a representative sample before locking
  let sum = 0, n = 0;
  rows.forEach(tr => { const h = tr.offsetHeight; if (h > 0) { sum += h; n++; } });
  if (!n) return;
  const avg = sum / n;
  _tRowHLocked = true;
  if (Math.abs(avg - _tRowH) >= 0.5) {
    _tRowH = avg;
    _tWinFirst = _tWinLast = -1;   // invalidate so the corrective render rebuilds
    _tRenderWindow(true);
  }
}

// (dev0381) Rich-HTML columns shown in the table. Their stored value is markup;
// in the cell we render the first meaningful line of text instead of the raw
// tags (the full markup stays in the tooltip, and inline/Xe editing still reads
// the raw row value — see startEdit). This is a per-visible-cell string op on a
// windowed table (~a screenful of rows), so it adds no measurable render cost.
const _RICH_PREVIEW_COLS = new Set(['ftext', 'ttxt', 'ctxt', 'ss']);
function _richCellPreview(html) {
  let s = String(html || '');
  if (!s) return '';
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  // Block boundaries → newlines so "first line" means the first block of text.
  s = s.replace(/<\s*(?:\/p|\/div|\/h[1-6]|\/li|\/tr|\/summary|br|hr)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const line = s.split('\n').map(x => x.replace(/\s+/g, ' ').trim()).find(Boolean);
  return line || '';
}

// (dev0327) Build one <tr> for display row vi / data row di. Reads the cached
// _tCtx so the scroll path never recomputes colW. Returns the tr (caller appends).
function _tBuildRow(vi, di) {
  const row = data[di];
  const { vc, cw, needCellW } = _tCtx;

  const tr = document.createElement('tr');
  tr.setAttribute('data-vrow', vi);
  if (checkedRows.has(di)) tr.classList.add('row-sel');
  if (focus && focus.r === vi) tr.classList.add('row-focus');   // (dev0330) slight focused-row wash

    const td0 = document.createElement('td'); td0.className = 'rn'; td0.textContent = di+1; setTdW(td0,34); addCtxT(td0,{type:'row',di}); tr.appendChild(td0);

    const tdcb = document.createElement('td'); tdcb.className = 'cbc'; setTdW(tdcb,26);
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = checkedRows.has(di);
    cb.addEventListener('change', e => { e.stopPropagation(); if (cb.checked) checkedRows.add(di); else checkedRows.delete(di); renderBody(); renderStatus(); });
    cb.addEventListener('click', e => e.stopPropagation());
    tdcb.appendChild(cb); tr.appendChild(tdcb);

    vc.forEach((col, ci) => {
      // (dev0323/0324) Width normally comes from the <colgroup> under
      // table-layout:fixed, so we don't touch width per cell — colW() runs
      // autoColW() (measureText over every row) and calling it per cell was
      // O(rows²) (the old ~1.6s render() lag: slow Escape-from-A, tag-paste,
      // sort, filter…). needCellW is the stale-HTML fallback; cw is precomputed.
      const td = document.createElement('td');
      if (needCellW) setTdW(td, cw[col]);
      td.setAttribute('data-vi', vi);
      td.setAttribute('data-ci', ci);
      const val = row[col] !== undefined ? String(row[col]) : '';

      // tags column — render chips (or raw comma list if lib not loaded yet)
      if (col === 'tags') {
        td.style.cssText += 'padding:2px 4px;vertical-align:middle;line-height:1.6;';
        const ids = Array.isArray(row.tags) ? row.tags : [];
        if (!window.tagsLib) {
          td.textContent = ids.join(', ');
        } else if (ids.length) {
          td.innerHTML = window.tagsLib.renderChipsForRecord(row);
          // Click a chip → filter the table to that tag (hierarchical).
          // Right-click → context menu with Open in Dictionary / GBIF / Filter.
          [...td.querySelectorAll('.tag-chip')].forEach(chip => {
            chip.addEventListener('click', e => {
              e.stopPropagation();
              const tid = chip.getAttribute('data-tag-id');
              if (!tid) return;
              window.setRowFilter({ col: 'tags', val: tid, hierarchical: true });
            });
            chip.addEventListener('contextmenu', e => {
              e.preventDefault();
              e.stopPropagation();
              const tid = chip.getAttribute('data-tag-id');
              if (!tid) return;
              // We can't easily wire "remove from this row" generically here
              // (no removeFn), so the chip menu in the table is a subset:
              // Open in Dictionary + Check GBIF only. The Annotate panel
              // chip-menu retains the Remove option.
              if (typeof window.openTableChipMenu === 'function') {
                window.openTableChipMenu(e.clientX, e.clientY, tid, row);
              }
            });
            chip.style.cursor = 'pointer';
          });
        } else {
          td.textContent = '';
        }
        td.title = window.tagsLib ? ids.map(id => window.tagsLib.labelFor(id)).join(', ') : ids.join(', ');
        // Don't attach the standard dblclick→inline-edit for this column
        // (it's a structured field — edit via Annotate A hotkey)
        // (zip0186) R-click on the td (not a chip) pastes clipboard tag if one
        // is copied; otherwise shows no menu (chips handle their own menus).
        td.addEventListener('contextmenu', e => {
          if (!e.target.classList.contains('tag-chip') && window._copiedTagId) {
            e.preventDefault(); e.stopPropagation();
            // Close any chip context menu before pasting
            if (window.tagsLib && window.tagsLib.closeMenu) window.tagsLib.closeMenu();
            const m0 = document.getElementById('chipCtxMenu'); if (m0) m0.remove();
            const cid = window._copiedTagId;
            if (!Array.isArray(row.tags)) row.tags = [];
            if (!row.tags.includes(cid)) {
              row.tags = [...row.tags, cid];
              row.DateModified = isoNow();
              save(); render();
              // Defensive: ensure no menu remains after re-render
              setTimeout(() => {
                if (window.tagsLib && window.tagsLib.closeMenu) window.tagsLib.closeMenu();
                const m1 = document.getElementById('chipCtxMenu'); if (m1) m1.remove();
              }, 0);
              // (dev0330) Success toast removed per user — pasting a tag is silent now.
            } else {
              toast('Tag already on this row', 1200);
            }
          }
        });
        td.addEventListener('click',   e => onCell(e, vi, ci));
        td.addEventListener('dblclick', e => {
          e.stopPropagation();
          if (window.openBrowseForRow) window.openBrowseForRow(row);
        });
        if (focus && focus.r === vi && focus.c === ci) td.className = 'focus';
        else if (pending && pending.c === ci && vi >= pending.r1 && vi <= pending.r2) td.className = 'sel';
        tr.appendChild(td);
        return; // skip default rendering below
      }

      // (dev0381) Rich-HTML columns show a readable first-line preview; the raw
      // markup stays in the tooltip (and is what editing operates on).
      if (_RICH_PREVIEW_COLS.has(col) && val) {
        td.textContent = _richCellPreview(val) || val;
        td.title = val;
      } else {
        td.textContent = val; td.title = val;
      }

      if (focus   && focus.r   === vi && focus.c   === ci) td.className = 'focus';
      else if (pending && pending.c === ci && vi >= pending.r1 && vi <= pending.r2) td.className = 'sel';
      // (dev0353) Tint the 'cell' column so its grid-slot values stand out.
      // Only when not focused/selected so those highlights stay visible.
      else if (col === 'cell') td.style.background = 'rgba(95,250,170,0.10)';
      td.addEventListener('click',   e => onCell(e, vi, ci));
      td.addEventListener('dblclick', e => { e.stopPropagation(); startEdit(vi, ci); });
      tr.appendChild(td);
    });
  return tr;
}

function renderStatus() {
  const el = document.getElementById('status'), ck = checkedRows.size, vc = visCols();
  const visCount = rowFilter === null ? data.length
    : data.filter(r => rowMatchesFilter(r)).length;
  let filterNote = '';
  if (rowFilter) {
    if (rowFilter.composite) {
      const parts = [];
      const tags = rowFilter.tags || [];
      if (tags.length && window.tagsLib) {
        parts.push('tags: ' + tags.map(id => window.tagsLib.labelFor(id) || id).join(' ∧ '));
      }
      const text = rowFilter.text || {};
      for (const k in text) {
        const q = (text[k] || '').trim();
        if (q) parts.push(k + '~"' + q + '"');
      }
      filterNote = ' 🔍 '+visCount+'/'+data.length+' rows ('+(parts.join(' · ') || 'empty')+')';
    } else if (rowFilter.col === 'tags' && rowFilter.hierarchical) {
      filterNote = ' 🔍 '+visCount+'/'+data.length+' rows (tag ↧ '+(window.tagsLib?window.tagsLib.labelFor(rowFilter.val):rowFilter.val)+')';
    } else {
      filterNote = ' 🔍 '+visCount+'/'+data.length+' rows ('+rowFilter.col+'="'+rowFilter.val+'" )';
    }
  }
  if (pending) {
    const n = pending.r2-pending.r1+1;
    el.textContent = n+' selected in "'+vc[pending.c]+'"'+(ck?' · '+ck+' ✓':'')+filterNote;
  } else if (focus) {
    el.textContent = 'Focus row '+(focus.r+1)+', col "'+vc[focus.c]+'" — shift-click same col to bulk set'+(ck?' · '+ck+' ✓':'')+filterNote;
  } else {
    el.textContent = data.length+' rows · '+vc.length+' cols'+(hidden.size?' ('+hidden.size+' hidden)':'')+(ck?' · '+ck+' ✓':'')+filterNote;
  }
}

function updateShowAllBtn() {
  const n = hidden.size, btn = document.getElementById('showAllBtn');
  btn.textContent       = n > 0 ? 'Show All Cols ('+n+')' : 'Show All Cols';
  btn.style.borderColor = n > 0 ? '#ff8' : '';
  btn.style.color       = n > 0 ? '#ff8' : '';
  // Clear-filter button visibility (filterBtn was removed; F hotkey opens modal)
  const cb2 = document.getElementById('clearFilterBtn');
  if (!cb2) return;
  cb2.style.display = rowFilter ? 'inline-block' : 'none';
}

// Cell click
function onCell(e, vi, ci) {
  if (_editing) { commitEdit(); return; }
  if (e.shiftKey && focus !== null && focus.c === ci && focus.r !== vi) {
    pending = {c:ci, r1:Math.min(focus.r,vi), r2:Math.max(focus.r,vi)};
    render(); openPopup();
  } else {
    // Fast path: focus change only — just retag classes instead of rebuilding tbody.
    const prev = focus;
    focus = {r:vi, c:ci};
    const hadPending = pending !== null;
    pending = null;
    document.querySelectorAll('#tbody td.focus, #tbody td.sel').forEach(td => {
      td.classList.remove('focus', 'sel');
    });
    document.querySelectorAll('#tbody tr.row-focus').forEach(tr => tr.classList.remove('row-focus'));
    const td = document.querySelector('#tbody td[data-vi="'+vi+'"][data-ci="'+ci+'"]');
    if (td) { td.classList.add('focus'); const ptr = td.closest('tr'); if (ptr) ptr.classList.add('row-focus'); }
    _tScrollRowIntoView(vi);   // (dev0331) shift the window to follow the newly-focused row (no-op if comfortably in view)
    // Mirror render()'s last-UID update so D-screen restore still works.
    try {
      const di = vr(vi);
      if (di >= 0 && di < data.length && data[di] && data[di].UID && typeof window.setLastUID === 'function') {
        window.setLastUID(data[di].UID);
      }
    } catch (_) {}
    // Status bar shows checked count etc.; nothing changes on focus-only click,
    // so we skip renderStatus too. (If you add focus-dependent status later,
    // call renderStatus() here.)
    // (dev0332) The fast path skips render(), so sync the preview pane here too.
    if (typeof rowPreviewSyncToFocus === 'function') rowPreviewSyncToFocus();
    void prev; void hadPending;
  }
}

// Inline cell editing
let _editing = null; // { vi, ci, di, col, td, inp, oldVal }

function startEdit(vi, ci, replaceWith) {
  if (_editing) commitEdit();
  const vc  = visCols();
  const col = vc[ci];
  if (!col) return;
  const di  = vr(vi);
  const td  = document.querySelector('#tbody td[data-vi="'+vi+'"][data-ci="'+ci+'"]');
  if (!td) return;
  const oldVal = String(data[di][col] ?? '');

  focus = {r:vi, c:ci};

  const inp = document.createElement('input');
  inp.type  = 'text';
  inp.value = replaceWith !== undefined ? replaceWith : oldVal;
  inp.style.cssText = 'width:100%;height:22px;padding:2px 4px;border:none;'+
    'outline:2px solid #4df;background:#051830;color:#fff;font:12px monospace;box-sizing:border-box;';

  td.textContent = '';
  td.classList.add('editing');
  td.appendChild(inp);
  inp.focus();
  if (replaceWith !== undefined) inp.setSelectionRange(inp.value.length, inp.value.length);
  else inp.select();

  _editing = { vi, ci, di, col, td, inp, oldVal };

  inp.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const moveCI = e.key === 'Tab' ? (e.shiftKey ? ci - 1 : ci + 1) : null;
      const moveVI = e.key === 'Enter' ? vi + 1 : null;
      commitEdit();
      // Move focus to next cell
      const nvc = visCols();
      if (moveCI !== null && moveCI >= 0 && moveCI < nvc.length) {
        focus = {r:vi, c:moveCI}; render();
        setTimeout(() => { _tScrollRowIntoView(vi); startEdit(vi, moveCI); }, 10);
      } else if (moveVI !== null && moveVI < data.length) {
        focus = {r:moveVI, c:ci}; render();
        setTimeout(() => { _tScrollRowIntoView(moveVI); startEdit(moveVI, ci); }, 10);
      }
    } else if (e.key === 'Escape') {
      cancelEdit();
    }
  });
  inp.addEventListener('blur', () => {
    // Small delay: if user clicked another cell, onCell fires first
    setTimeout(() => { if (_editing && _editing.inp === inp) commitEdit(); }, 80);
  });
}

// t2 choices by t1 — phyla for L
const PHYLA_EXTANT = [
  'Annelida','Arthropoda','Brachiopoda','Bryozoa','Chaetognatha','Chordata',
  'Cnidaria','Ctenophora','Cycliophora','Dicyemida','Echinodermata','Entoprocta',
  'Gastrotricha','Gnathostomulida','Hemichordata','Kinorhyncha','Loricifera',
  'Micrognathozoa','Mollusca','Monoblastozoa','Nematoda','Nematomorpha','Nemertea',
  'Onychophora','Orthonectida','Phoronida','Placozoa','Platyhelminthes','Porifera',
  'Priapulida','Rotifera','Tardigrada','Xenacoelomorpha'
];
const PHYLA_EXTINCT = [
  'Agmata','Petalonamae','Proarticulata','Saccorhytida','Trilobozoa','Vetulicolia'
];
const T2_BY_T1 = {
  H: ['Diet & Nutrition','Supplements','Disease & Conditions','Exercise & Body','Mental Health','Sleep','Medicine & Treatment'],
  A: ['Tennis','Swimming','Cycling','Hiking & Outdoors','Fitness & Training','Games & Competition'],
  L: [...PHYLA_EXTANT, ...PHYLA_EXTINCT],
  O: ['Humor','Science','Nature & Animals','Reference','Miscellaneous']
};

// Columns that represent meaningful content — editing these stamps DateModified
const CONTENT_COLS = new Set(['t1','t2','n1','n2','n3','cname','sname','comment','Val',
  'VidRange','VidTitle','VidComment','VidAuthor','attribution','Topic','tags']);

// Test whether a data row passes the current rowFilter.
// Supports:
//   rowFilter = null                            → everything passes
//   rowFilter = {col, val}                      → classic exact-match
//   rowFilter = {col:'tags', val:<tagId>, hierarchical:true} → tag + descendants
function rowMatchesFilter(row) {
  if (!rowFilter) return true;
  // Composite: tags AND'd with each other AND'd with text-field substring matches.
  // Built by the F-hotkey filter modal.
  if (rowFilter.composite) {
    const tags = rowFilter.tags || [];
    if (tags.length && window.tagsLib) {
      for (const tid of tags) {
        if (!window.tagsLib.matchesQuery(row.tags || [], tid)) return false;
      }
    }
    const text = rowFilter.text || {};
    for (const k in text) {
      const q = (text[k] || '').toLowerCase().trim();
      if (!q) continue;
      if (k === 'anywhere') {
        // OR across all text fields + tag labels
        const textFields = ['VidAuthor', 'VidTitle', 'link', 'VidComment'];
        let found = textFields.some(f => String(row[f] || '').toLowerCase().includes(q));
        if (!found) found = String(row.ftext || '').replace(/<[^>]*>/g, ' ').toLowerCase().includes(q);
        if (!found && window.tagsLib && row.tags) {
          for (const tid of row.tags) {
            const t = window.tagsLib.get(tid);
            if (t && ((t.label||'').toLowerCase().includes(q) || (t.common||'').toLowerCase().includes(q))) {
              found = true; break;
            }
          }
        }
        if (!found) return false;
        continue;
      }
      let val = String(row[k] || '');
      if (k === 'ftext') val = val.replace(/<[^>]*>/g, ' ');
      if (!val.toLowerCase().includes(q)) return false;
    }
    // (dev0343) Media-type toggles — OR within the chosen set (live-computed).
    const media = rowFilter.media || [];
    if (media.length) {
      const kind = window.rowMediaKind ? window.rowMediaKind(row) : 'other';
      if (!media.includes(kind)) return false;
    }
    // (dev0343) Orientation toggles — OR within the chosen set. Reads the P/S
    // column: '1'=portrait, '0'=landscape, 'X'/blank=n/a (never matches).
    const orient = rowFilter.orient || [];
    if (orient.length) {
      const ps = rowPSValue(row);
      const ok = (orient.includes('portrait')  && ps === '1')
              || (orient.includes('landscape') && ps === '0');
      if (!ok) return false;
    }
    return true;
  }
  if (rowFilter.col === 'tags' && rowFilter.hierarchical && window.tagsLib) {
    return window.tagsLib.matchesQuery(row.tags || [], rowFilter.val);
  }
  return String(row[rowFilter.col] || '') === rowFilter.val;
}
window.rowMatchesFilter = rowMatchesFilter;

// Set or clear the row filter from outside scripts (e.g. tags.js Dictionary).
// Pass null to clear. Also calls render() and (when a filter is applied)
// places focus on the first row that survives the filter, so the user can
// immediately press E or A on the result without seeing a "No video" prompt.
window.setRowFilter = function(filter) {
  // Remember any non-null filter so the F hotkey can restore it after a clear.
  // Clearing (filter=null) doesn't overwrite the remembered value — that's
  // the whole point of "toggle".
  if (filter) _lastRowFilter = filter;
  rowFilter = filter;
  pending = null;
  if (filter) {
    let firstVi = -1;
    for (let vi = 0; vi < data.length; vi++) {
      const di = vr(vi);
      if (rowMatchesFilter(data[di])) { firstVi = vi; break; }
    }
    focus = firstVi >= 0 ? { r: firstVi, c: 0 } : null;
  } else {
    focus = null;
  }
  if (typeof render === 'function') render();
};
window.getRowFilter = function() { return rowFilter; };

function commitEdit() {
  if (!_editing) return;
  const { vi, ci, di, col, td, inp, oldVal } = _editing;
  _editing = null;
  const newVal = inp.value;
  td.classList.remove('editing');
  td.textContent = newVal; td.title = newVal;
  if (newVal !== oldVal) {
    data[di][col] = newVal;
    if (_cMode && col !== 'DateModified') {
      // In C-screen: stamp DateModified on any field change
      data[di].DateModified = isoNow();
    } else if (CONTENT_COLS.has(col) && col !== 'DateModified' && data[di].DateModified !== undefined) {
      data[di].DateModified = isoNow();
    }
    save();
    // Refresh DateModified cell in same row if visible
    const dmCI = visCols().indexOf('DateModified');
    if (dmCI >= 0 && CONTENT_COLS.has(col) && col !== 'DateModified') {
      const dmTd = document.querySelector('#tbody td[data-vi="'+vi+'"][data-ci="'+dmCI+'"]');
      if (dmTd && !dmTd.classList.contains('editing')) {
        dmTd.textContent = data[di].DateModified; dmTd.title = data[di].DateModified;
      }
    }
  }
}

function cancelEdit() {
  if (!_editing) return;
  const { td, oldVal } = _editing;
  _editing = null;
  td.classList.remove('editing');
  td.textContent = oldVal; td.title = oldVal;
}

// Global keydown: ONLY Escape to deselect (editing requires double-click)
// Single letters G/T/E are handled by the hotkey capture above
document.addEventListener('keydown', e => {
  // Don't intercept if typing in an input/textarea
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (document.getElementById('overlay').classList.contains('open')) return;
  // Don't capture arrows if grid or VE is open
  if (document.getElementById('gridOverlay')?.style.display === 'flex') return;
  if (document.getElementById('video-editor-overlay')) return;
  // (dev0358) Xe (text editor) owns its own arrow handling (caret when focused,
  // row-hop when not) — never let the table handler also navigate while it's open.
  if (document.getElementById('textEditorOverlay')) return;
  // (dev0448) The St staging screen owns ↑/↓ (move its focused row) and Delete
  // (remove its focused row). Bail so this T-table handler doesn't ALSO move/delete
  // a hidden T row underneath the overlay.
  if (typeof window.isStScreenOpen === 'function' && window.isStScreenOpen()) return;
  // (dev0466) The O org-review screen owns ↑/↓ (move its focused/read row). Bail so
  // this T-table handler doesn't ALSO move a hidden T row underneath the overlay.
  if (typeof window.isOScreenOpen === 'function' && window.isOScreenOpen()) return;

  // Up/Down arrow keys — navigate rows in table (works even when annotate panel open)
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const anOpen = document.getElementById('browseOverlay')?.style.display === 'flex';
    // If annotate is open and a select is focused, let it handle natively
    if (anOpen && tag === 'SELECT') return;
    
    e.preventDefault();
    // Count visible rows (respecting filter and sort)
    const visIdxs = []; // list of vi values that pass filter
    for (let vi = 0; vi < data.length; vi++) {
      const di = vr(vi);
      if (rowMatchesFilter(data[di]))
        visIdxs.push(vi);
    }
    if (!visIdxs.length) return;

    const curVi = focus !== null ? focus.r : -1;
    // Find position in visIdxs
    let pos = visIdxs.indexOf(curVi);
    if (pos < 0) pos = e.key === 'ArrowUp' ? visIdxs.length : -1;
    const newPos = e.key === 'ArrowUp' ? Math.max(0, pos - 1) : Math.min(visIdxs.length - 1, pos + 1);
    const newVi = visIdxs[newPos];
    if (newVi === undefined) return;

    focus = { r: newVi, c: focus !== null ? focus.c : 0 };
    render();                    // rebuilds _tVisList + window at current scroll
    _tScrollRowIntoView(newVi);  // (dev0327) bring the new focus row into the window

    // If annotate panel is open, navigate it to the new row too
    if (anOpen) {
      const di = vr(newVi);
      brSave();
      const fi = _brRows.indexOf(di);
      if (fi >= 0) {
        brShow(fi);
      } else {
        // Row not in current set — refresh
        _brRows = brGetVisibleRows();
        const fi2 = _brRows.indexOf(di);
        if (fi2 >= 0) brShow(fi2);
      }
    }
    return;
  }

  // (dev0357) PageUp / PageDown → move the focus row up / down by one page of
  // rows; Home / End → jump to the FIRST / LAST row of the filtered view. (Row
  // navigation — ArrowUp/Down above step one row; these step a page or to the
  // ends. Replaces the dev0355 column-jump.)
  if (e.key === 'Home' || e.key === 'End' || e.key === 'PageUp' || e.key === 'PageDown') {
    const anOpen = document.getElementById('browseOverlay')?.style.display === 'flex';
    if (anOpen && tag === 'SELECT') return;
    e.preventDefault();
    const visIdxs = [];
    for (let vi = 0; vi < data.length; vi++) { if (rowMatchesFilter(data[vr(vi)])) visIdxs.push(vi); }
    if (!visIdxs.length) return;
    // Page size = whole rows that fit in the table viewport, minus one for overlap.
    const wrap = document.getElementById('wrap');
    const rowH = (typeof _tRowHeight === 'function') ? _tRowHeight() : 25;
    const pageRows = Math.max(1, Math.floor(((wrap && wrap.clientHeight) || 600) / rowH) - 1);
    const curVi = focus !== null ? focus.r : visIdxs[0];
    let pos = visIdxs.indexOf(curVi);
    if (pos < 0) pos = 0;
    let newPos;
    if      (e.key === 'Home')     newPos = 0;
    else if (e.key === 'End')      newPos = visIdxs.length - 1;
    else if (e.key === 'PageUp')   newPos = Math.max(0, pos - pageRows);
    else                           newPos = Math.min(visIdxs.length - 1, pos + pageRows);
    const newVi = visIdxs[newPos];
    if (newVi === undefined) return;
    focus = { r: newVi, c: focus !== null ? focus.c : 0 };
    pending = null;
    render();
    _tScrollRowIntoView(newVi);
    // Keep the Annotate panel in sync when it's open (mirrors ArrowUp/Down).
    if (anOpen) {
      const di = vr(newVi);
      brSave();
      const fi = _brRows.indexOf(di);
      if (fi >= 0) brShow(fi);
      else { _brRows = brGetVisibleRows(); const fi2 = _brRows.indexOf(di); if (fi2 >= 0) brShow(fi2); }
    }
    return;
  }

  // Delete key — remove focused row, save to deleted.json, no confirmation
  if (e.key === 'Delete' && focus !== null) {
    const di = vr(focus.r);
    if (di >= 0 && di < data.length) {
      e.preventDefault();
      const row = data[di];
      _saveToDeletedJson(row); // async, fire-and-forget
      data.splice(di, 1);
      // Fix up checkedRows indices
      const nc = new Set();
      checkedRows.forEach(i => { if (i < di) nc.add(i); else if (i > di) nc.add(i - 1); });
      checkedRows = nc;
      save(); buildSort(); render();
      toast('Row deleted → deleted.json', 1500);
    }
    return;
  }

  if (focus !== null) {
    if (e.key === 'Escape') {
      focus = null; pending = null; render();
    }
  }
});

// Column resize
let _resizeHappened = false;
function startResize(col, th, startX) {
  _resizeHappened = false;
  const startW = th.offsetWidth;
  document.body.style.cursor = 'col-resize';
  const rh = th.querySelector('.rh'); if (rh) rh.classList.add('dragging');
  function onMove(e) {
    _resizeHappened = true;
    const nw = Math.max(MIN_W, startW + e.clientX - startX);
    colWidths[col] = nw;
    applyColW(col, nw);
  }
  function onUp() {
    document.body.style.cursor = '';
    if (rh) rh.classList.remove('dragging');
    if (_resizeHappened) save();
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
    // Suppress the click event that fires immediately after mouseup
    setTimeout(() => { _resizeHappened = false; }, 50);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
}

// Column drag-to-reorder
let _colDrag = null, _colDragHappened = false;
const _ghost    = document.getElementById('col-drag-ghost');
const _dropLine = document.getElementById('col-drop-line');

function startColDrag(e, col, th) {
  _colDragHappened = false;
  _colDrag = {col, th, startX:e.clientX, startY:e.clientY, active:false, dropBefore:null};
  document.addEventListener('mousemove', onColDragMove);
  document.addEventListener('mouseup',   onColDragUp);
}
function onColDragMove(e) {
  if (!_colDrag) return;
  if (!_colDrag.active && (Math.abs(e.clientX-_colDrag.startX)>6 || Math.abs(e.clientY-_colDrag.startY)>4)) {
    _colDrag.active = true;
    _ghost.textContent = '⠿ '+_colDrag.col; _ghost.style.display = 'block';
    _colDrag.th.classList.add('dragging-src');
    const wr = document.getElementById('wrap').getBoundingClientRect();
    _dropLine.style.height = wr.height+'px'; _dropLine.style.top = wr.top+'px'; _dropLine.style.display = 'block';
  }
  if (!_colDrag.active) return;
  _ghost.style.left = e.clientX+'px'; _ghost.style.top = (e.clientY-28)+'px';
  const headers = [...document.querySelectorAll('#thead th[data-col]')];
  headers.forEach(h => h.classList.remove('drag-over'));
  let dropBefore = null, dropX = null;
  for (const hdr of headers) {
    const r = hdr.getBoundingClientRect();
    if (e.clientX < r.left + r.width/2) { dropBefore = hdr.getAttribute('data-col'); dropX = r.left; hdr.classList.add('drag-over'); break; }
  }
  if (dropBefore === null && headers.length) { const r=headers[headers.length-1].getBoundingClientRect(); dropX=r.right; }
  _colDrag.dropBefore = dropBefore;
  if (dropX !== null) _dropLine.style.left = (dropX-2)+'px';
}
function onColDragUp() {
  document.removeEventListener('mousemove', onColDragMove);
  document.removeEventListener('mouseup',   onColDragUp);
  if (!_colDrag) return;
  document.querySelectorAll('#thead th[data-col]').forEach(h => h.classList.remove('drag-over'));
  _ghost.style.display = 'none'; _dropLine.style.display = 'none';
  _colDrag.th.classList.remove('dragging-src');
  if (_colDrag.active) {
    _colDragHappened = true;
    const fromCol = _colDrag.col, toCol = _colDrag.dropBefore;
    if (toCol !== fromCol) {
      const fi = cols.indexOf(fromCol);
      if (fi !== -1) {
        cols.splice(fi, 1);
        if (toCol === null) cols.push(fromCol);
        else { const ti = cols.indexOf(toCol); cols.splice(ti !== -1 ? ti : cols.length, 0, fromCol); }
      }
    }
    save(); render();
  }
  _colDrag = null;
  setTimeout(() => { _colDragHappened = false; }, 50);
}

// Context menu
function addCtxT(el, t) { el.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); showCtx(e.clientX, e.clientY, t); }); }
document.getElementById('wrap').addEventListener('contextmenu', e => e.preventDefault());
// (dev0368) Fallback: a right-click landing OUTSIDE #wrap (the empty strip to the
// right of a narrow table / past the last column header — roughly the right 1/8th
// on a wide screen) still raised the browser's native menu, since the guard above
// only covers the table itself. While the T screen is active, swallow those stray
// right-clicks too. Real form fields are spared so paste/spell menus still work.
// Header/cell right-clicks never reach here — addCtxT stops their propagation.
document.addEventListener('contextmenu', e => {
  if (!_tScreenActive()) return;
  const t = e.target;
  if (t && t.closest && t.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) return;
  e.preventDefault();
});

function showCtx(x, y, target) {
  const menu = document.getElementById('ctxmenu'); menu.innerHTML = '';
  if (target.type === 'col') {
    const col = target.col;
    menu.innerHTML = '<div class="ctx-hdr">COLUMN: '+escH(col)+'</div>';
    addCI(menu, 'Sort A→Z',       () => { sortCol=col; sortDir='asc';  buildSort(); render(); });
    addCI(menu, 'Sort Z→A',       () => { sortCol=col; sortDir='desc'; buildSort(); render(); });
    addCI(menu, 'Clear sort',     () => { sortCol=null; sortedIdx=null; render(); });
    addCS(menu);
    addCI(menu, 'Rename…',        () => renameCol(col));
    addCI(menu, 'Insert before…', () => insertCol(col, 'before'));
    addCI(menu, 'Insert after…',  () => insertCol(col, 'after'));
    addCS(menu);
    addCI(menu, 'Move left',      () => moveCol(col, -1));
    addCI(menu, 'Move right',     () => moveCol(col,  1));
    addCS(menu);
    addCI(menu, 'Reset width (auto)', () => { delete colWidths[col]; save(); render(); });
    addCI(menu, 'Hide',               () => { hidden.add(col); focus=null; pending=null; save(); render(); });
    addCS(menu);
    addCI(menu, 'Delete column…', () => deleteCol(col), true);
  } else if (target.type === 'row' || target.type === 'rownum') {
    const di = target.di;
    menu.innerHTML = '<div class="ctx-hdr">'+(di !== undefined ? 'ROW '+(di+1) : 'ROWS')+'</div>';
    if (di !== undefined) {
      addCI(menu, 'Insert row above', () => insertRow(di));
      addCI(menu, 'Insert row below', () => insertRow(di+1));
      addCS(menu);
      addCI(menu, checkedRows.has(di) ? 'Uncheck' : 'Check', () => { if(checkedRows.has(di))checkedRows.delete(di);else checkedRows.add(di); render(); });
      addCS(menu);
      addCI(menu, 'Delete this row…', () => deleteRow(di), true);
    }
    if (checkedRows.size > 0) { addCS(menu); addCI(menu, 'Delete '+checkedRows.size+' checked…', () => deleteChecked(), true); }
  }
  menu.classList.add('open');
  const mh = menu.children.length * 32;
  menu.style.left = Math.min(x, window.innerWidth-200-8)+'px';
  menu.style.top  = Math.min(y, window.innerHeight-mh-8)+'px';
}
function addCI(menu, label, fn, danger) { const d=document.createElement('div'); d.className='ctx-item'+(danger?' red':''); d.textContent=label; d.addEventListener('click',()=>{closeCtx();fn();}); menu.appendChild(d); }
function addCS(m) { const s=document.createElement('div'); s.className='ctx-sep'; m.appendChild(s); }
function closeCtx() { document.getElementById('ctxmenu').classList.remove('open'); }
document.addEventListener('pointerdown', e => { const m=document.getElementById('ctxmenu'); if(m.classList.contains('open')&&!m.contains(e.target)) closeCtx(); }, true);

// Column / Row operations
function renameCol(col) { const nk=prompt('Rename "'+col+'" to:',col); if(!nk||nk===col)return; if(cols.includes(nk)){alert('"'+nk+'" exists.');return;} cols[cols.indexOf(col)]=nk; data.forEach(r=>{r[nk]=r[col]!==undefined?String(r[col]):'';delete r[col];}); if(hidden.has(col)){hidden.delete(col);hidden.add(nk);} if(colWidths[col]!==undefined){colWidths[nk]=colWidths[col];delete colWidths[col];} save();render(); }
function insertCol(col, where) { const nk=prompt('New column name:'); if(!nk||!nk.trim())return; if(cols.includes(nk)){alert('"'+nk+'" exists.');return;} const i=cols.indexOf(col); cols.splice(where==='after'?i+1:i,0,nk); data.forEach(r=>{if(r[nk]===undefined)r[nk]='';}); save();render(); }
function moveCol(col, dir) { const vc=visCols(),vi=vc.indexOf(col),ni=vi+dir; if(ni<0||ni>=vc.length)return; const ci=cols.indexOf(col),ci2=cols.indexOf(vc[ni]); [cols[ci],cols[ci2]]=[cols[ci2],cols[ci]]; save();render(); }
function deleteCol(col) { if(!confirm('Delete "'+col+'" from ALL rows?'))return; cols=cols.filter(c=>c!==col); hidden.delete(col); data.forEach(r=>delete r[col]); save();render(); }
function insertRow(at) { const r={}; cols.forEach(k=>r[k]=''); let mx=0; data.forEach(rr=>{const n=parseInt(rr.UID||'0',10);if(n>mx)mx=n;}); r.UID=String(mx+1); const now=isoNow(); r.DateAdded=now; r.DateModified=now; data.splice(at,0,r); save();buildSort();render(); }
function deleteRow(di) { if(!confirm('Delete row '+(di+1)+'?'))return; if(data[di])_saveToDeletedJson(data[di]); data.splice(di,1); checkedRows.delete(di); const nc=new Set(); checkedRows.forEach(i=>{if(i<di)nc.add(i);else if(i>di)nc.add(i-1);}); checkedRows=nc; save();buildSort();render(); }
function deleteChecked() { if(!confirm('Delete '+checkedRows.size+' row(s)?'))return; const idxs=[...checkedRows].sort((a,b)=>b-a); const dead=idxs.map(di=>data[di]).filter(Boolean); if(dead.length)_saveToDeletedJson(dead); idxs.forEach(di=>data.splice(di,1)); checkedRows.clear(); save();buildSort();render(); }

// Bulk popup
function openPopup() {
  const vc=visCols(),col=vc[pending.c],count=pending.r2-pending.r1+1;
  document.getElementById('ptitle').textContent = 'Bulk set "'+col+'"';
  document.getElementById('psub').textContent   = count+' row'+(count>1?'s':'')+' selected'+(sortCol?' · sorted by "'+sortCol+'"':'');
  document.getElementById('val').value = '';
  document.getElementById('overlay').classList.add('open');
  setTimeout(() => document.getElementById('val').focus(), 60);
}
function closePopup(clearSel) { document.getElementById('overlay').classList.remove('open'); if(clearSel)pending=null; render(); }
function doApply(r1, r2) {
  const vc  = visCols();
  const col = vc[pending.c];
  const val = document.getElementById('val').value;
  for (let vi = r1; vi <= r2; vi++) {
    const di = vr(vi);
    if (di < 0 || di >= data.length) continue;
    data[di][col] = val;
  }
  save();
}
function applyPopup()    { if(!pending){closePopup(true);return;} doApply(pending.r1,pending.r2); focus={r:pending.r2,c:pending.c}; pending=null; closePopup(false); }
function applyAllPopup() { if(!pending){closePopup(true);return;} doApply(0,data.length-1); focus={r:0,c:pending.c}; pending=null; closePopup(false); }
document.getElementById('applyBtn').addEventListener('click',    applyPopup);
document.getElementById('applyAllBtn').addEventListener('click', applyAllPopup);
document.getElementById('cancelBtn').addEventListener('click',   () => closePopup(true));
document.getElementById('val').addEventListener('keydown', e => { if(e.key==='Enter'){e.preventDefault();applyPopup();} if(e.key==='Escape')closePopup(true); });
document.getElementById('overlay').addEventListener('click', e => { if(e.target===document.getElementById('overlay'))closePopup(true); });

// Hamburger menu
const hmBtn=document.getElementById('hmBtn'), hmPanel=document.getElementById('hmPanel');
function openHM()  { 
  const r = hmBtn.getBoundingClientRect();
  // (zip0155) In user mode, the toolbar is display:none so hmBtn has zero
  // dimensions. Position the panel near the top-left of the viewport
  // instead of (0,0+6). Detect "hidden hmBtn" by checking for zero size.
  if (r.width === 0 && r.height === 0) {
    hmPanel.style.top  = '12px';
    hmPanel.style.left = '12px';
  } else {
    hmPanel.style.top  = (r.bottom + 6) + 'px';
    hmPanel.style.left = Math.min(r.left, window.innerWidth - 250) + 'px';
  }
  hmPanel.classList.add('open');
  // Add keyboard handler when menu opens
  document.addEventListener('keydown', hmKeyHandler, true);
}
function closeHM() { 
  hmPanel.classList.remove('open'); 
  document.removeEventListener('keydown', hmKeyHandler, true);
}
function toggleHM(){
  // (dev0316) In user mode the menu opens via the top-left #userHmBtn and
  // is CSS-filtered to Slideshow + Help only (push/load/settings/folder/
  // dictionary all hidden). The dev0315 unconditional no-op was too
  // aggressive — it broke the slideshow launcher the user wanted in user
  // mode. The bare M-key hotkey is still blocked in vp.js _executeHotkey,
  // so this only opens via an explicit button tap.
  hmPanel.classList.contains('open') ? closeHM() : openHM();
}

// Keyboard handler for menu items
function hmKeyHandler(e) {
  if (!hmPanel.classList.contains('open')) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') { e.preventDefault(); closeHM(); return; }
  if (k === 'f') { e.preventDefault(); closeHM(); pickFolder(); return; }
  if (k === 'd') { e.preventDefault(); closeHM(); if (window.openDictionary) window.openDictionary(); return; }
  if (k === 'p') { e.preventDefault(); closeHM(); toast('☁ Push to GitHub\n[coming soon]'); return; }
  if (k === 'l') { e.preventDefault(); closeHM(); toast('⬇ Load from GitHub\n[coming soon]'); return; }
  if (k === 's') { e.preventDefault(); closeHM(); openSettings(); return; }
  if (k === 'h') { e.preventDefault(); closeHM(); openHelp(); return; }
}

hmBtn.addEventListener('click', e => { e.stopPropagation(); toggleHM(); });
// (zip0234) In-grid hamburger button — same panel, for user/mobile where
// #toolbar (and thus #hmBtn) is hidden. openHM() positions the panel at
// top:12px/left:12px when #hmBtn has zero size, which matches this button.
const _gridHmBtn = document.getElementById('gridHmBtn');
if (_gridHmBtn) _gridHmBtn.addEventListener('click', e => { e.stopPropagation(); toggleHM(); });
// (dev0316) User-mode top-left hamburger. Same panel, CSS hides every dev
// item in user mode so what remains is essentially the Slideshow launcher
// (plus Help). Position-wise this is what #hmBtn used to give devs — the
// toolbar is hidden in user mode so we need a dedicated button.
const _userHmBtn = document.getElementById('userHmBtn');
if (_userHmBtn) _userHmBtn.addEventListener('click', e => { e.stopPropagation(); toggleHM(); });
document.addEventListener('pointerdown', e => {
  if (!hmPanel.classList.contains('open')) return;
  if (hmPanel.contains(e.target)) return;
  if (e.target === hmBtn || e.target === _gridHmBtn || e.target === _userHmBtn) return;
  // Span children of the user-mode hamburger button also count as the button.
  if (_userHmBtn && _userHmBtn.contains(e.target)) return;
  closeHM();
}, true);

document.getElementById('hm-setfolder').addEventListener('click', async () => { closeHM(); await pickFolder(); });
document.getElementById('hm-dict').addEventListener('click', () => { closeHM(); if (window.openDictionary) window.openDictionary(); });
document.getElementById('hm-push').addEventListener('click',   () => { closeHM(); toast('☁ Push to GitHub\n[coming soon]'); });
document.getElementById('hm-loadgh').addEventListener('click', () => { closeHM(); toast('⬇ Load from GitHub\n[coming soon]'); });
document.getElementById('hm-slideshow').addEventListener('click', () => {
  closeHM();
  if (typeof slideshowOpenGrid === 'function') slideshowOpenGrid();
  else if (typeof toast === 'function') toast('Slideshow not loaded yet', 1500);
});
// (dev0360) Change Selection — back to the welcome / shareable menu to pick a
// different grid or item. Shown in user mode (id not in the user-mode hide list).
document.getElementById('hm-changesel')?.addEventListener('click', () => {
  closeHM();
  if (typeof window._showShareableMenu === 'function') window._showShareableMenu();
  else if (typeof toast === 'function') toast('Menu not available', 1500);
});
document.getElementById('hm-settings').addEventListener('click', () => { closeHM(); openSettings(); });
document.getElementById('hm-help').addEventListener('click', () => { closeHM(); openHelp(); });

// ── Settings modal (zip0124) ───────────────────────────────────────────────
// Persistent prefs stored in localStorage under 'ml-settings'. Currently:
//   ytPrivacy: 'normal' (default, signed-in session works) | 'nocookie'
//              (privacy-enhanced; for production deploys to GitHub Pages etc.)
// New settings can be added here; each one is read by the consuming module
// via window.getSetting(key).
window.getSetting = function(key) {
  try {
    const s = JSON.parse(localStorage.getItem('ml-settings') || '{}');
    return s[key];
  } catch(_) { return undefined; }
};
window.setSetting = function(key, val) {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('ml-settings') || '{}'); } catch(_) {}
  s[key] = val;
  try { localStorage.setItem('ml-settings', JSON.stringify(s)); } catch(_) {}
};

function openSettings() {
  // Remove any existing
  const old = document.getElementById('settingsModal');
  if (old) old.remove();

  const ytPrivacy = window.getSetting('ytPrivacy') || 'normal';

  const modal = document.createElement('div');
  modal.id = 'settingsModal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999997;background:rgba(0,0,0,0.7);'
    + 'display:flex;align-items:center;justify-content:center;font-family:monospace;';
  modal.innerHTML = `
    <div style="background:#0d0d1e;border:2px solid #4af;border-radius:10px;padding:20px 24px;
                min-width:420px;max-width:560px;color:#eee;box-shadow:0 12px 40px rgba(0,0,0,0.9);">
      <div style="display:flex;align-items:center;margin-bottom:14px;">
        <h2 style="margin:0;font-size:16px;color:#8ef;flex:1;">⚙ Settings</h2>
        <button id="settingsClose" style="background:none;border:1px solid #555;color:#aaa;
                padding:3px 9px;border-radius:5px;cursor:pointer;font-family:monospace;">✕</button>
      </div>

      <fieldset style="border:1px solid #333;border-radius:6px;padding:12px 14px;margin-bottom:14px;">
        <legend style="color:#8ef;font-size:12px;padding:0 6px;">YouTube embed mode</legend>
        <label style="display:block;cursor:pointer;margin-bottom:8px;">
          <input type="radio" name="ytPrivacy" value="normal"${ytPrivacy==='normal'?' checked':''} style="margin-right:8px;">
          <span style="color:#cfc;font-weight:bold;">Normal (youtube.com)</span> — recommended for development.
          <div style="color:#888;font-size:11px;margin:2px 0 0 22px;line-height:1.4;">
            Embeds use youtube.com so your signed-in browser session is visible to the iframe.
            Bot-detection rarely fires. Use this when working locally.
          </div>
        </label>
        <label style="display:block;cursor:pointer;">
          <input type="radio" name="ytPrivacy" value="nocookie"${ytPrivacy==='nocookie'?' checked':''} style="margin-right:8px;">
          <span style="color:#fca;font-weight:bold;">Privacy-enhanced (youtube-nocookie.com)</span> — for production.
          <div style="color:#888;font-size:11px;margin:2px 0 0 22px;line-height:1.4;">
            No cookies set, no session shared. Use when deploying to GitHub Pages or
            a public host where users won't have your YouTube login. May trigger
            bot-detection more often during heavy use.
          </div>
        </label>
        <div style="color:#777;font-size:10px;margin-top:10px;font-style:italic;">
          Change takes effect the next time a video player is created (close & reopen E or V).
        </div>
      </fieldset>

      <div style="text-align:right;">
        <button id="settingsSave" style="background:#0a3052;border:1px solid #4af;color:#8ef;
                padding:6px 18px;border-radius:5px;cursor:pointer;font-family:monospace;font-size:13px;">
          Save & Close
        </button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  function close() { modal.remove(); }
  modal.querySelector('#settingsClose').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  modal.querySelector('#settingsSave').addEventListener('click', () => {
    const choice = modal.querySelector('input[name="ytPrivacy"]:checked');
    if (choice) window.setSetting('ytPrivacy', choice.value);
    toast('⚙ Settings saved', 1200);
    close();
  });

  // Esc to close (use direct keydown, since the global Esc-toggle won't help
  // here — modal has no input focus to blur).
  function escClose(e) {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      document.removeEventListener('keydown', escClose, true);
      close();
    }
  }
  document.addEventListener('keydown', escClose, true);
}

// Toolbar download button — tries FSA, then browser download
// (dev0353) Save ml.json button removed (data auto-saves on every change).
// Guarded so the now-absent #dlBtn doesn't throw.
document.getElementById('dlBtn')?.addEventListener('click', async () => {
  const payload = [buildMeta()].concat(data);
  const ok = await writeFileToDisk('ml.json', payload);
  if (!ok) { const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}); const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='ml.json';document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(a.href); }
});
document.getElementById('showAllBtn').addEventListener('click', () => { hidden.clear(); save(); render(); });

// Populate Cells: assign 1a-5e to visible rows only; clear cell on invisible rows
// Fill P/S — detect portrait/landscape orientation
function getPSCol() {
  if (cols.includes('P/S'))      return 'P/S';
  if (cols.includes('Portrait')) return 'Portrait';
  cols.push('P/S'); data.forEach(r => { if(r['P/S']===undefined) r['P/S']=''; });
  return 'P/S';
}
async function fetchWithTimeout(url, ms, opts) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), ms);
  try { const r = await fetch(url, Object.assign({}, opts, {signal: ctrl.signal})); clearTimeout(tid); return r; }
  catch(e) { clearTimeout(tid); return null; }
}
async function getImageDims(url) {
  return new Promise(res => {
    const img = new Image(); // no crossOrigin — we only need naturalWidth/Height, not pixel data
    const t = setTimeout(() => res(null), 8000);
    img.onload  = () => { clearTimeout(t); res({w:img.naturalWidth, h:img.naturalHeight}); };
    img.onerror = () => { clearTimeout(t); res(null); };
    img.src = url;
  });
}
// (dev0343) Probe a direct video file (mp4/webm/mov/…) for its pixel dimensions
// by loading only metadata. No CORS needed — videoWidth/Height are exposed even
// cross-origin. Works for http(s) and blob: (disk) URLs.
async function getVideoDims(url) {
  return new Promise(res => {
    const v = document.createElement('video');
    v.preload = 'metadata'; v.muted = true;
    let done = false;
    const finish = (val) => {
      if (done) return; done = true;
      clearTimeout(t);
      try { v.removeAttribute('src'); v.load(); } catch(e) {}
      res(val);
    };
    const t = setTimeout(() => finish(null), 9000);
    v.onloadedmetadata = () => finish(v.videoWidth && v.videoHeight ? {w:v.videoWidth, h:v.videoHeight} : null);
    v.onerror = () => finish(null);
    v.src = url;
  });
}
async function getOEmbedDims(url) {
  try {
    let ep;
    if (/vimeo\.com/i.test(url))               ep = 'https://vimeo.com/api/oembed.json?url=';
    else if (/youtu\.be|youtube\.com/i.test(url)) ep = 'https://www.youtube.com/oembed?format=json&url=';
    else return null;
    const r = await fetchWithTimeout(ep + encodeURIComponent(url), 7000);
    if (!r || !r.ok) return null;
    const j = await r.json();
    if (j.thumbnail_width && j.thumbnail_height) return {w:j.thumbnail_width, h:j.thumbnail_height};
    if (j.width && j.height) return {w:j.width, h:j.height};
  } catch(e) {}
  return null;
}
document.getElementById('fillPSBtn').addEventListener('click', async () => {
  const PS_COL = getPSCol();
  // (dev0343) Process EVERY row, not just rows with a link — text/html/quiz rows
  // (no media link) must be stamped 'X' (n/a) rather than left blank/stale.
  const rows = data;
  if (!rows.length) { toast('No rows.'); return; }
  toast('\u{21ec}\u{21CC} Filling P/S\u2026 0/' + rows.length, 10000);
  let done = 0, changed = 0;
  for (const row of rows) {
    const link = String(row.link || '');
    const kind = rowMediaKind(row);   // 'video' | 'image' | 'other'
    const prev = String(row[PS_COL] || '');
    let ps;
    if (kind === 'other') {
      ps = 'X';                       // teXt / html / quiz / non-media -> n/a
    } else if (/youtube\.com\/shorts\//i.test(link)
            || (window.isInstagramLink && window.isInstagramLink(link) && /\/reel\//i.test(link))) {
      ps = '1';                       // YT Shorts / IG Reels are portrait by definition
    } else if (/youtu\.be|youtube\.com/i.test(link) || /vimeo\.com/i.test(link)) {
      const dims = await getOEmbedDims(link);
      ps = dims ? (dims.h > dims.w ? '1' : '0') : '';
    } else if (window.isDirectVideoLink && window.isDirectVideoLink(link)) {
      const dims = await getVideoDims(link);
      ps = dims ? (dims.h > dims.w ? '1' : '0') : '';
    } else if (kind === 'image') {
      const dims = await getImageDims(link);
      ps = dims ? (dims.h > dims.w ? '1' : '0') : '';
    } else {
      ps = '';                        // media we can't measure (e.g. IG post) -> leave for retry
    }
    // Don't clobber a previously-good orientation with a transient measurement
    // failure: keep '0'/'1' if this pass came up blank. Blank is distinct from
    // 'X' (which means definitively n/a — text/html/quiz).
    if (ps === '' && (prev === '0' || prev === '1')) ps = prev;
    if (prev !== ps) { row[PS_COL] = ps; changed++; }
    done++;
    if (done % 3 === 0 || done === rows.length)
      toast('Filling P/S\u2026 '+done+'/'+rows.length+' ('+changed+' changed)', 10000);
    await new Promise(r => setTimeout(r, 0));
  }
  save(); render();
  toast('\u2713 Fill P/S done: '+changed+' updated of '+done+'\n(col: '+PS_COL+')', 5000);
});

// Fill Mpix — megapixels for images, V for videos
document.getElementById('fillMpixBtn').addEventListener('click', async () => {
  const rows = data.filter(r => r.link);
  if (!rows.length) { toast('No rows with links.'); return; }
  toast('📐 Filling Mpix… 0/' + rows.length, 10000);
  let done = 0, changed = 0;
  for (const row of rows) {
    const link = row.link || '';
    const isVid = isVideoRow(row);
    let mpix = '';
    if (isVid) {
      mpix = 'V';
    } else {
      const dims = await getImageDims(link);
      if (dims && dims.w > 0 && dims.h > 0) {
        const mp = (dims.w * dims.h) / 1_000_000;
        mpix = mp >= 0.1 ? mp.toFixed(1) : mp.toFixed(2);
      } else {
        mpix = 'X';
      }
    }
    if (String(row.MPix||'') !== mpix) { row.MPix = mpix; changed++; }
    done++;
    if (done % 3 === 0 || done === rows.length)
      toast('📐 Filling Mpix… '+done+'/'+rows.length+' ('+changed+' changed)', 10000);
    await new Promise(r => setTimeout(r, 0));
  }
  save(); render();
  toast('✓ Fill Mpix done: '+changed+' updated of '+done+' checked', 4000);
});

// ══════════════════════════════════════════════════════════════════════════════
// SAVE FTEXT IMAGES TO DISK
// ══════════════════════════════════════════════════════════════════════════════
// For each visible (filtered) row with ftext and FTLsaved !== '1':
//   1. Parse ftext for <img> tags
//   2. Derive folder name from the URL slug (last path segment of row.link)
//   3. Derive filename from the preceding <h4> caption (sanitized) — or img-N
//   4. fetch() each image; save bytes under jpgs/<slug>/<filename>.<ext>
//   5. Rewrite saved <img> tags to add onerror fallback to local path
//   6. Set FTLsaved: '1' if every image saved, '0' partial, '-1' none.
//
// CORS: many image hosts don't allow cross-origin fetch. Those will be
// reported as failures (not naming errors). Naming errors (illegal chars
// after sanitisation, empty captions, etc.) are collected separately and
// shown in a popup at the end.

// Replace illegal Windows filename chars. ':' → '-', " and curly quotes → '
// strip < > / \ | ? *, collapse whitespace, trim, limit to 200 chars.
function _sanitiseFsName(s) {
  if (!s) return '';
  let out = String(s)
    .replace(/:/g, '-')
    .replace(/["“”„‟]/g, "'")   // straight+curly double quotes → '
    .replace(/[<>\/\\|?*]/g, '')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/, '')
    .trim();
  if (out.length > 200) out = out.slice(0, 200).trim();
  return out;
}

// Derive folder path parts from a row link: [domain, seg1, seg2, ...]
// e.g. https://121clicks.com/inspirations/fenqiang-liu-great-egret-bird-photography/
//   → ['121clicks.com', 'inspirations', 'fenqiang-liu-great-egret-bird-photography']
function _pathPartsFromLink(link) {
  if (!link) return [];
  try {
    const u = new URL(link);
    const parts = [u.hostname, ...u.pathname.split('/').filter(Boolean)];
    return parts.map(p => _sanitiseFsName(decodeURIComponent(p))).filter(Boolean);
  } catch(_) {
    const s = _sanitiseFsName(link.replace(/^https?:\/\//, '').replace(/\/+$/, ''));
    return s ? [s] : [];
  }
}

// Extract extension from image URL, defaulting to .jpg.
// Normalises .jpeg → .jpg.
function _imgExtFromUrl(url) {
  const path = String(url).split(/[?#]/)[0];
  const m = path.match(/\.([a-z0-9]{2,5})$/i);
  if (!m) return 'jpg';
  const ext = m[1].toLowerCase();
  return ext === 'jpeg' ? 'jpg' : ext;
}

// Walk an ftext HTML string and return an ordered list of { imgEl, caption, src, index }
// Caption priority:
//   1.  <figcaption> in parent <figure> or next sibling
//   1b. Per-image preceding heading: <h2-h5> as the STRICT immediate previous
//       sibling of <img>, gated by row-level uniqueness check so we don't tag
//       many images with the same article-level heading. See _perImgPrecedingHeadings.
//   2.  Nearest <p> above OR below (heuristic: 2+ <p>s after img → caption is above)
//   3.  alt attribute, after row-level cleaning — auto-generated "Image N:" prefix
//       stripped and the common trailing suffix shared across every alt in the row
//       (article-name boilerplate) stripped. See _cleanRowAlts.
//   4.  URL basename (filename slug, with hashes/dims stripped)
//   5.  Nearest preceding <h2-h5> heading (loose walk — fallback only)
//   6.  '' (falls back to img-N filename in caller)
// Uses a detached document so we can mutate the tree, then serialize back.
// Captions we never want as a JPG filename — they're section/UI labels, not
// descriptions of the image. Caller treats a matching candidate as "not found"
// and falls through to the next strategy (and ultimately to a URL-basename
// derivation).
const _BAD_CAPTION_RE = /^(image\s+\d+|highly\s+commended|view\s+fullsize|view\s+fullscreen|documentary\s+series|video\s+award|category\s+winner|runner[\s-]?up|advertisement|share|tags?:|related|©|order\s+now|collection\s+\d+)\s*$/i;

// Last-resort caption: derive from the image URL's basename.
// Decodes %xx, swaps + and _ for spaces, drops trailing hex hashes, and
// strips a few site-specific prefixes (e.g. "LowRes-WINNER-BWPA-2026-").
function _captionFromUrl(src) {
  try {
    const u = new URL(src);
    let base = decodeURIComponent(u.pathname.split('/').pop() || '');
    base = base.replace(/\.[^.]+$/, '');                              // drop extension
    base = base.replace(/<[^>]+>/g, '-');                             // <em> etc used as word separators → hyphen
    base = base.replace(/[_-][a-f0-9]{32}(?=[_\-.]|$)/ig, '');       // strip 32-char wp-uploads hash
    base = base.replace(/-\d+x\d+$/i, '');                            // strip trailing -WxH dimensions
    base = base.replace(/^LowRes[\s-]+(WINNER|RU)[\s-]+BWPA[\s-]+\d{4}[\s-]+/i, '');
    base = base.replace(/[+_-]+/g, ' ');                              // + _ - → space
    base = base.replace(/\s+/g, ' ').trim();
    if (base.length >= 3 && !/^\d+$/.test(base)) return base;
  } catch (_) {}
  return '';
}

// Pre-pass over a row's <img> alts:
//   1) strip auto-generated "Image N:" / "Photo 3 -" / "Fig. 12." prefixes
//   2) detect a common trailing suffix shared by every alt in the row
//      (e.g. " - 35 Photography Awards Macro Winners" appended by the CMS to
//      every image alt) and strip that too — it's article-level boilerplate,
//      not per-image content.
// Returns an array of cleaned alt strings, one per imgs[i] (may be '').
function _cleanRowAlts(imgs) {
  const ALT_PREFIX_RE = /^(image|photo|picture|img|fig(?:ure)?)\s*#?\s*\d+\s*[:\-.–—]\s*/i;
  const raw = imgs.map(img => (img.getAttribute('alt') || '').trim());
  const stripped = raw.map(a => a.replace(ALT_PREFIX_RE, '').trim());
  const nonEmpty = stripped.filter(Boolean);
  let commonSuffix = '';
  if (nonEmpty.length >= 2) {
    let s = nonEmpty[0];
    for (let i = 1; i < nonEmpty.length && s; i++) {
      const t = nonEmpty[i];
      const max = Math.min(s.length, t.length);
      let k = 0;
      while (k < max && s.charAt(s.length - 1 - k) === t.charAt(t.length - 1 - k)) k++;
      s = s.slice(s.length - k);
    }
    // Snap to a separator boundary so we don't chop mid-word.
    const m = s.match(/(\s+[\-–—|·:]\s+.+)$/);
    if (m && m[0].length >= 5) commonSuffix = m[0];
  }
  return stripped.map(a => {
    if (commonSuffix && a.endsWith(commonSuffix)) {
      a = a.slice(0, a.length - commonSuffix.length).trim();
    }
    return a.replace(/[\s\-–—|:·]+$/, '').trim();
  });
}

// Pre-pass: for each <img>, find the heading (h2-h5) that is STRICTLY its
// immediately-preceding DOM sibling (no <p>, <br>, or other non-heading
// element between). Return the array of heading-text-per-img, plus a flag
// that's true only when the row has many unique such headings — the
// "one heading per image" pattern (e.g. <h4>#1. ...</h4><img>...<h4>#2. ...</h4><img>).
// The flag prevents the "one article <h2> above many anonymous imgs" trap,
// which would otherwise tag every image with the same heading and collide.
function _perImgPrecedingHeadings(imgs) {
  const headings = imgs.map(img => {
    let sib = img.previousElementSibling;
    while (sib) {
      if (/^H[2-5]$/.test(sib.tagName)) {
        const t = sib.textContent.trim();
        if (t) return t;
        sib = sib.previousElementSibling;
        continue;
      }
      return '';
    }
    return '';
  });
  const nonEmpty = headings.filter(Boolean);
  const unique = new Set(nonEmpty);
  const useAsPrimary = unique.size >= 2 && nonEmpty.length >= imgs.length * 0.5;
  return { headings, useAsPrimary };
}

function _ftextExtractImages(ftext) {
  const doc = document.implementation.createHTMLDocument('');
  doc.body.innerHTML = ftext || '';
  const imgs = Array.from(doc.body.querySelectorAll('img'));
  const cleanedAlts = _cleanRowAlts(imgs);
  const { headings: precedingHeadings, useAsPrimary: useHeadingsFirst } = _perImgPrecedingHeadings(imgs);
  const items = [];
  imgs.forEach((img, i) => {
    const src = img.getAttribute('src') || '';
    if (!src || !/^https?:\/\//i.test(src)) return; // skip data: / relative / empty

    // Helper: only accept a candidate caption if it isn't a generic label
    // or a URL fragment. Empty / bad → return '' so the caller falls through.
    const cleanCap = (c) => {
      if (!c) return '';
      c = c.trim();
      if (!c) return '';
      if (_BAD_CAPTION_RE.test(c)) return '';
      if (/^https?[:\-_]/i.test(c)) return '';        // "https-anything"
      if (/^\[\]\(/.test(c)) return '';                // markdown link artifact
      return c;
    };

    let caption = '';

    // 1. <figcaption> — check parent <figure> or next sibling
    const fig = img.closest('figure');
    if (fig) {
      const fc = fig.querySelector('figcaption');
      if (fc) caption = cleanCap(fc.textContent);
    }
    if (!caption) {
      const ns = img.nextElementSibling;
      if (ns && ns.tagName === 'FIGCAPTION') caption = cleanCap(ns.textContent);
    }

    // 1b. Per-image preceding heading (only when the whole row exhibits the
    //     "one heading per image" pattern — see _perImgPrecedingHeadings).
    //     This is the strongest signal when present: an <h4> sitting as the
    //     immediate sibling above an <img> is the per-image label.
    if (!caption && useHeadingsFirst && precedingHeadings[i]) {
      caption = cleanCap(precedingHeadings[i]);
    }

    // 2. Decide BELOW vs ABOVE for the caption.
    //    Rule (zip0219): if the image is followed by 2+ consecutive <p>s,
    //    that's a description block, not a caption — the caption lives ABOVE
    //    instead (e.g., naturettl: <p>title</p><img><p>desc</p><p>desc</p>…).
    //    Otherwise (0 or 1 <p> after), use the next-sibling <p> as before.
    if (!caption) {
      let pAfterCount = 0;
      {
        let cur = img.nextElementSibling;
        while (cur && cur.tagName === 'P') { pAfterCount++; cur = cur.nextElementSibling; }
      }
      const lookAbove = pAfterCount >= 2;

      const tryP = (p) => {
        if (!p || p.tagName !== 'P') return '';
        const txt = p.textContent.trim();
        if (!txt || txt.length < 4 || txt.length >= 250) return '';
        if (/^(become|subscribe|sign up)/i.test(txt)) return '';
        const candidate = txt.length > 120 ? txt.slice(0, 120).trim() : txt;
        return cleanCap(candidate);
      };

      if (lookAbove) {
        const c = tryP(img.previousElementSibling);
        if (c) caption = c;
      } else {
        // Original BELOW walk: img or its block container's next <p>
        let container = img;
        for (let depth = 0; depth < 5 && container && container !== doc.body; depth++) {
          const c = tryP(container.nextElementSibling);
          if (c) { caption = c; break; }
          const par = container.parentElement;
          if (!par || par === doc.body) break;
          if (/^(ARTICLE|SECTION|MAIN|DIV)$/.test(par.tagName)) break;
          container = par;
        }
      }
    }

    // 3. alt attribute. Use the row-cleaned alt (prefix like "Image 1:" stripped,
    //    common per-row trailing suffix like " - Site Title" stripped). The alt
    //    is usually the most per-image-specific label authors/CMSes write.
    if (!caption) {
      const alt = cleanedAlts[i] || '';
      if (alt && !/^(image|photo|picture|img|\d+|\.{1,3})$/i.test(alt) && alt.length >= 4) {
        caption = cleanCap(alt);
      }
    }

    // 4. URL-derived slug — often more specific than a shared group heading
    //    (e.g., naturettl 2024/2025 embed the photo title in the filename).
    if (!caption) caption = _captionFromUrl(src);

    // 5. Nearest preceding <h2-h5>. Fallback when URL gives nothing useful.
    if (!caption) {
      let cur = img;
      while (cur && !caption) {
        let sib = cur.previousElementSibling;
        while (sib) {
          if (/^H[2-5]$/.test(sib.tagName)) {
            const c = cleanCap(sib.textContent);
            if (c) { caption = c; break; }
          } else {
            const h = sib.querySelector && sib.querySelector('h2,h3,h4,h5');
            if (h) {
              const c = cleanCap(h.textContent);
              if (c) { caption = c; break; }
            }
          }
          sib = sib.previousElementSibling;
        }
        if (caption) break;
        cur = cur.parentElement;
        if (!cur || cur === doc.body) break;
      }
    }

    items.push({ imgEl: img, src, caption, index: i + 1 });
  });
  return { doc, items };
}

// Try to fetch one image as a Blob. Returns Blob on success, or { error: msg }.
// Falls back to local cors-anywhere proxy (http://localhost:8080/) if direct fetch
// is blocked by CORS. Start proxy with: npx cors-anywhere
async function _fetchImageBlob(url) {
  async function _tryFetch(fetchUrl, opts) {
    const r = await fetch(fetchUrl, opts);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const b = await r.blob();
    if (!b || b.size === 0) throw new Error('empty body');
    return b;
  }
  // 1. Direct fetch
  try {
    return await _tryFetch(url, { mode: 'cors', credentials: 'omit' });
  } catch(e) {
    // 2. Local cors-anywhere proxy fallback
    try {
      return await _tryFetch('http://localhost:8081/' + url, { credentials: 'omit' });
    } catch(e2) {
      const direct = (e && e.message) ? e.message : 'CORS blocked';
      const proxy  = (e2 && e2.message) ? e2.message : 'proxy failed';
      return { error: direct + ' | proxy: ' + proxy };
    }
  }
}

// Get or create jpgs/<domain>/<path...>/ directory handle under the project folder.
async function _getJpgSubdir(pathParts) {
  const dir = await _getDir();
  if (!dir) throw new Error('No project folder set — click 📂 and pick M:\\jjj first');
  let cur = await dir.getDirectoryHandle('jpgs', { create: true });
  for (const part of pathParts) cur = await cur.getDirectoryHandle(part, { create: true });
  return cur;
}

// Return { w, h } from a Blob, or null on failure.
async function _blobDimensions(blob) {
  return new Promise(res => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    const t = setTimeout(() => { URL.revokeObjectURL(url); res(null); }, 5000);
    img.onload  = () => { clearTimeout(t); URL.revokeObjectURL(url); res({ w: img.naturalWidth, h: img.naturalHeight }); };
    img.onerror = () => { clearTimeout(t); URL.revokeObjectURL(url); res(null); };
    img.src = url;
  });
}

// Write a Blob to <subDir>/<filename>. Overwrites if exists.
async function _writeBlobToDir(subDir, filename, blob) {
  const fh = await subDir.getFileHandle(filename, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
}

// Main entry point — bound to the Save Imgs button.
async function saveFtextImages() {
  if (!window.showDirectoryPicker) {
    alert('Save Imgs: File System Access API not available in this browser.\nUse Chrome or Edge.');
    return;
  }
  const dir = await _getDir();
  if (!dir) {
    alert('Save Imgs: project folder not set.\nClick the 📂 button and pick M:\\jjj first.');
    return;
  }

  // Collect filtered/visible rows with ftext and FTLsaved !== '1'
  const targets = [];
  const total = data.length;
  for (let vi = 0; vi < total; vi++) {
    const di = vr(vi);
    const row = data[di];
    if (!row || !row.ftext) continue;
    if (sortedIdx && sortedIdx.indexOf(di) === -1) continue;
    if (!rowMatchesFilter(row)) continue;
    if (String(row.FTLsaved || '') === '1') continue;
    targets.push({ di, row });
  }
  if (!targets.length) { alert('Save Imgs: no eligible rows.\n(Need visible rows with ftext and FTLsaved ≠ 1.)'); return; }

  if (!confirm('Save Imgs: process ' + targets.length + ' row(s)?\n\nFor each row:\n• Parse <img> tags in ftext\n• fetch() and save under jpgs/<domain>/<path>/\n• Fill MPix (d-prefix) and P/S from first saved image\n• Rewrite img tags with disk-fallback onerror\n• Set FTLsaved (1=all, 0=partial, -1=none)\n\nCross-origin images without CORS will fail — start proxy.js on 8081 first.')) return;

  // Ensure required columns exist
  for (const c of ['FTLsaved', 'MPix']) {
    if (!cols.includes(c)) { cols.push(c); data.forEach(r => { if (r[c] === undefined) r[c] = ''; }); }
  }
  const PS_COL = getPSCol();

  const nameErrors = [];  // { rowUID, src, why }
  const fetchErrors = []; // { rowUID, src, why }
  let rowsAllOk = 0, rowsPartial = 0, rowsNone = 0;
  let imgsSaved = 0, imgsFailed = 0, imgsSkippedName = 0;

  toast('📥 Save Imgs: 0/' + targets.length + ' rows…', 60000);

  for (let ti = 0; ti < targets.length; ti++) {
    const { row } = targets[ti];
    try {
      const pathParts = _pathPartsFromLink(row.link);
      if (!pathParts.length) {
        nameErrors.push({ rowUID: row.UID, src: row.link, why: 'cannot derive folder path from link' });
        row.FTLsaved = '-1'; rowsNone++;
      } else {
        const { doc, items } = _ftextExtractImages(row.ftext);
        if (!items.length) {
          row.FTLsaved = '1'; rowsAllOk++;
        } else {
          let subDir;
          try { subDir = await _getJpgSubdir(pathParts); }
          catch(e) {
            nameErrors.push({ rowUID: row.UID, src: pathParts.join('/'), why: 'create folder failed: ' + e.message });
            row.FTLsaved = '-1'; rowsNone++;
            subDir = null;
          }

          if (subDir) {
            let okThisRow = 0, failThisRow = 0;
            let rowDims = null;
            const usedNames = new Set();
            for (const it of items) {
              let base = _sanitiseFsName(it.caption);
              if (!base) base = 'img-' + it.index;
              const ext = _imgExtFromUrl(it.src);
              let filename = base + '.' + ext;
              let n = 2;
              while (usedNames.has(filename.toLowerCase())) { filename = base + ' (' + n + ').' + ext; n++; }
              if (!base || /^[\s.]*$/.test(base)) {
                nameErrors.push({ rowUID: row.UID, src: it.src, why: 'caption sanitised to empty' });
                imgsSkippedName++; failThisRow++;
                continue;
              }
              usedNames.add(filename.toLowerCase());

              const blob = await _fetchImageBlob(it.src);
              if (blob && !blob.error) {
                try {
                  await _writeBlobToDir(subDir, filename, blob);
                  const localPath = 'jpgs/' + pathParts.join('/') + '/' + filename;
                  it.imgEl.setAttribute('data-localsrc', localPath);
                  if (!(it.imgEl.getAttribute('onerror') || '').includes('data-localsrc'))
                    it.imgEl.setAttribute('onerror', "this.onerror=null;this.src=this.getAttribute('data-localsrc');");
                  try {
                    const d = await _blobDimensions(blob);
                    if (d && d.w > 0) {
                      // Keep the largest image (by MPix) for the row's MPix/P/S values
                      if (!rowDims || (d.w * d.h) > (rowDims.w * rowDims.h)) rowDims = d;
                    }
                  } catch(_) {}
                  imgsSaved++; okThisRow++;
                } catch(e) {
                  nameErrors.push({ rowUID: row.UID, src: it.src, why: 'write failed: ' + e.message });
                  imgsFailed++; failThisRow++;
                }
              } else {
                fetchErrors.push({ rowUID: row.UID, src: it.src, why: (blob && blob.error) || 'fetch failed' });
                imgsFailed++; failThisRow++;
              }
            }

            if (okThisRow > 0) row.ftext = doc.body.innerHTML;
            if (rowDims && rowDims.w > 0) {
              const mp = (rowDims.w * rowDims.h) / 1_000_000;
              row.MPix = 'd' + (mp >= 0.1 ? mp.toFixed(1) : mp.toFixed(2));
              row[PS_COL] = rowDims.h > rowDims.w ? '1' : '0';
            }
            if (okThisRow > 0 && failThisRow === 0) { row.FTLsaved = '1'; rowsAllOk++; }
            else if (okThisRow > 0) { row.FTLsaved = '0'; rowsPartial++; }
            else { row.FTLsaved = '-1'; rowsNone++; }
          }
        }
        row.DateModified = isoNow();
      }
    } catch(e) {
      // Catch-all: log and continue so one bad row never stops the loop
      const why = 'unexpected error: ' + (e && e.message ? e.message : String(e));
      fetchErrors.push({ rowUID: row.UID, src: row.link || '', why });
      row.FTLsaved = '-1'; rowsNone++;
      console.error('Save Imgs row UID', row.UID, e);
    }

    toast('📥 Save Imgs: ' + (ti + 1) + '/' + targets.length + ' rows, ' + imgsSaved + ' saved, ' + imgsFailed + ' failed', 60000);
    render();
  }
  // Single save at the end — avoids concurrent FSA writes inside the loop
  // (which can fail and fire an error toast that clobbers the done toast).
  // localStorage is updated synchronously by save() so no data is at risk.
  save(); render();

  const _errLines = (arr, label) => arr.length
    ? label + ' (' + arr.length + '):\n' + arr.slice(0, 20).map(e => '  UID ' + e.rowUID + ': ' + e.why + (e.src ? '\n    ' + e.src.slice(0, 80) : '')).join('\n') + (arr.length > 20 ? '\n  …and ' + (arr.length - 20) + ' more' : '')
    : '';
  const fullLog = '📥 Save Imgs done.\nRows: ' + rowsAllOk + ' ok, ' + rowsPartial + ' partial, ' + rowsNone + ' none\nImgs: ' + imgsSaved + ' saved, ' + imgsFailed + ' failed, ' + imgsSkippedName + ' name-skipped\n' + (_errLines(fetchErrors, 'Fetch failures') || 'No fetch failures.') + (nameErrors.length ? '\n' + _errLines(nameErrors, 'Naming issues') : '');
  console.log(fullLog);
  toast('📥 Save Imgs done — ' + rowsAllOk + ' rows ok, ' + rowsNone + ' failed | ' + imgsSaved + ' imgs saved, ' + imgsFailed + ' failed' + (fetchErrors.length + nameErrors.length ? ' | see console for errors' : ''), 2000);
}

document.getElementById('saveFtextImgsBtn')?.addEventListener('click', saveFtextImages);

// Delete Checked Rows button
document.getElementById('deleteCheckedBtn').addEventListener('click', () => {
  if (checkedRows.size === 0) { toast('No rows checked — use checkboxes to select rows', 1800); return; }
  deleteChecked();
});

// (dev0242) Duplicate the focused row. Deep-copies all fields, assigns a fresh
// UID (max+1), refreshes DateAdded/DateModified, inserts directly below source,
// and moves T's focus to the new row.
document.getElementById('dupRowBtn')?.addEventListener('click', () => {
  if (!focus || focus.r == null) { toast('No active row — click a row first', 1600); return; }
  const di = vr(focus.r);
  const src = data[di];
  if (!src) { toast('Active row not found', 1600); return; }
  const now = isoNow();
  const base = String(src.UID || '');
  // Track existing UIDs so generated suffixes never collide.
  const used = new Set(data.map(rr => String(rr.UID)));
  const uniqueUID = want => {
    let u = want, k = 2;
    while (used.has(u)) { u = want + '_' + (k++); }
    used.add(u);
    return u;
  };
  const mkCopy = uid => {
    const c = JSON.parse(JSON.stringify(src));
    c.UID = uid;
    c.cell = '';            // duplicates start unassigned — never fight the
                            // original (or each other) for a grid slot
    c.DateAdded = now;
    c.DateModified = now;
    return c;
  };

  // (dev0334) Segmented-video split: a video row with N>1 VidRange segments
  // duplicates into N single-segment rows UID_1..UID_N, so each segment can be
  // assigned to its own grid cell straight from T (no per-cell segment syntax
  // needed). Every other row duplicates once as UID_d.
  const segs = (window.parseVideoAsset && isVideoRow(src))
    ? window.parseVideoAsset(src.VidRange) : null;
  let newRows;
  if (segs && segs.length >= 2) {
    newRows = segs.map((seg, i) => {
      const c = mkCopy(uniqueUID(base + '_' + (i + 1)));
      c.VidRange = window.serializeSegments([seg]);
      return c;
    });
  } else {
    newRows = [mkCopy(uniqueUID(base + '_d'))];
  }

  data.splice(di + 1, 0, ...newRows);
  save(); buildSort(); render();
  const newDi = data.indexOf(newRows[0]);
  if (newDi >= 0) {
    const newVi = sortedIdx ? sortedIdx.indexOf(newDi) : newDi;
    focus = { r: newVi, c: focus.c || 0 };
    render();
  }
  if (newRows.length > 1) {
    toast('✓ Split ' + base + ' into ' + newRows.length + ' segment rows: '
      + newRows[0].UID + ' … ' + newRows[newRows.length - 1].UID, 2400);
  } else {
    toast('✓ Duplicated row — UID ' + newRows[0].UID, 1400);
  }
});

// (dev0353) Delete UID range action removed — button gone, action retired.

// Mark for Grid
let _markGridMode = 'top'; // 'top' | 'focused' | 'random'
let _markGridSize = 25;    // (dev0331) 25 | 16 | 9 | 4 — chosen in the dropdown; default 25 (5×5)

function markGridMenuOpen() {
  const menu = document.getElementById('markGridMenu');
  const isOpen = menu.style.display !== 'none';
  menu.style.display = isOpen ? 'none' : 'block';
}
function markGridMenuClose() {
  document.getElementById('markGridMenu').style.display = 'none';
}
function markGridSetMode(mode) {
  _markGridMode = mode;
  document.querySelectorAll('.mgitem').forEach(el => {
    el.classList.toggle('active', el.dataset.mode === mode);
  });
  markGridMenuClose();
}
// (dev0331) Pick the grid size in the dropdown (does NOT close it — you pick a
// size, then a mode). Selecting a mode is what runs the assignment.
function markGridSetSize(size) {
  _markGridSize = size;
  document.querySelectorAll('.mgsize').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.size, 10) === size);
  });
}

// (dev0331) The whole button now opens the dropdown (was: instant-run with the
// last mode). Pick a SIZE (25/16/9/4) then a MODE (top/focused/random) — the
// mode click runs the assignment.
document.getElementById('markGridArrow').addEventListener('click', e => { e.stopPropagation(); markGridMenuOpen(); });
document.getElementById('markGridBtn').addEventListener('click', e => { e.stopPropagation(); markGridMenuOpen(); });
document.querySelectorAll('.mgsize').forEach(el => {
  el.addEventListener('click', e => { e.stopPropagation(); markGridSetSize(parseInt(el.dataset.size, 10)); });
});
document.querySelectorAll('.mgitem').forEach(el => {
  el.addEventListener('click', e => { e.stopPropagation(); markGridSetMode(el.dataset.mode); runMarkGrid(); });
});
document.addEventListener('pointerdown', e => {
  const wrap = document.getElementById('markGridWrap');
  if (wrap && !wrap.contains(e.target)) markGridMenuClose();
}, true);

// ── (zip0151) Housekeeping dropdown wiring ─────────────────────────────────
// The 4 legacy buttons (Fill P/S, Fill Mpix, Fix vRange, Calc Lengths) are
// hidden in the toolbar but still present in the DOM. Their .click() handlers
// are bound elsewhere in this file (search for fillPSBtn/fillMpixBtn/etc.
// addEventListener). Each menu item just dispatches that click — keeps the
// handler logic in one place.
function housekeepingMenuOpen() {
  const menu = document.getElementById('housekeepingMenu');
  menu.style.display = (menu.style.display === 'none' ? 'block' : 'none');
}
function housekeepingMenuClose() {
  const menu = document.getElementById('housekeepingMenu');
  if (menu) menu.style.display = 'none';
}
document.getElementById('housekeepingBtn').addEventListener('click', e => {
  e.stopPropagation(); housekeepingMenuOpen();
});
document.addEventListener('pointerdown', e => {
  const wrap = document.getElementById('housekeepingWrap');
  if (wrap && !wrap.contains(e.target)) housekeepingMenuClose();
}, true);
document.querySelectorAll('.hkitem').forEach(el => {
  // Hover highlight (since these aren't <button>s)
  el.addEventListener('mouseenter', () => { el.style.background = 'rgba(80,80,180,0.4)'; });
  el.addEventListener('mouseleave', () => { el.style.background = ''; });
  el.addEventListener('click', e => {
    e.stopPropagation();
    const act = el.dataset.act;
    housekeepingMenuClose();
    // (zip0151) toast() shows balloon — most legacy handlers already toast
    // their own results. We add a "starting" balloon here for the heavier
    // operations so the user knows the click registered.
    if (act === 'fillps') {
      toast('🧹 Fill P/S — scanning rows for orientation…', 1800);
      document.getElementById('fillPSBtn').click();
    } else if (act === 'fillmpix') {
      toast('🧹 Fill Mpix — measuring images…', 1800);
      document.getElementById('fillMpixBtn').click();
    } else if (act === 'fixvrange') {
      toast('🧹 Fix vRange — sorting segments…', 1500);
      document.getElementById('fixVRangeBtn').click();
    } else if (act === 'calclengths') {
      toast('🧹 Calc Lengths — computing durations…', 1500);
      document.getElementById('calcLengthsBtn').click();
    } else if (act === 'cleanmute') {
      housekeepingCleanMute();
    } else if (act === 'fillytmeta') {
      housekeepingFillYTMeta();
    } else if (act === 'resetftlsaved') {
      const n = data.filter(r => r.FTLsaved !== undefined && r.FTLsaved !== '').length;
      if (!confirm('Clear FTLsaved on all ' + n + ' rows that have it set?\n(Rows will be re-processed next time Save Imgs runs.)')) return;
      data.forEach(r => { if (r.FTLsaved !== undefined) r.FTLsaved = ''; });
      save(); render();
      toast('✓ FTLsaved cleared on ' + n + ' rows', 3000);
    }
  });
});

// (zip0151) Clean Mute Column: for each row, if it's NOT a video link,
// blank the Mute field; if it IS a video, leave Mute unchanged. This
// keeps the column as a video-only attribute and removes spurious
// values that may have been set by past auto-fills or imports.
function housekeepingCleanMute() {
  let blanked = 0, videos = 0, alreadyBlank = 0;
  data.forEach(r => {
    if (!r) return;
    const link = r.link || '';
    const isVid =
      (window.isYouTubeLink    && window.isYouTubeLink(link)) ||
      (window.isVimeoLink      && window.isVimeoLink(link)) ||
      (window.isDirectVideoLink && window.isDirectVideoLink(link));
    if (isVid) {
      videos++;
    } else {
      if (r.Mute === undefined || r.Mute === null || r.Mute === '') {
        alreadyBlank++;
      } else {
        r.Mute = '';
        blanked++;
      }
    }
  });
  if (blanked) save();
  // Refresh the table so users see the column update
  if (window._salTab) {
    try { window._salTab.replaceData(data); } catch (_) {}
  }
  toast(
    '✓ Clean Mute Column complete\n'
    + '   ' + blanked + ' non-video row(s) blanked\n'
    + '   ' + videos + ' video row(s) preserved\n'
    + '   ' + alreadyBlank + ' already blank',
    4500
  );
}

function _extractYTVideoId(url) {
  // Matches ?v= or &v= — handles any parameter order (fixes watch?v= as first param)
  let m = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];
  m = url.match(/(?:shorts|embed)\/([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];
  m = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];
  return null;
}

async function housekeepingFillYTMeta() {
  // Only rows that are YouTube links AND have at least one of title/author missing
  const rows = data.filter(r => {
    if (!r || !r.link) return false;
    if (!_extractYTVideoId(r.link)) return false;
    return !r.VidTitle || !r.VidAuthor;
  });
  if (!rows.length) { toast('No YouTube rows with missing title/author', 2500); return; }
  toast('📺 Fetching YouTube metadata for ' + rows.length + ' row(s)…', 3000);
  let done = 0, skipped = 0;
  const failed = [];
  for (const row of rows) {
    try {
      const vid = _extractYTVideoId(row.link);
      // Always use canonical watch URL for oEmbed — avoids Shorts/embed quirks
      const canonUrl = 'https://www.youtube.com/watch?v=' + vid;
      const res = await fetch('https://www.youtube.com/oembed?url=' + encodeURIComponent(canonUrl) + '&format=json');
      if (!res.ok) {
        // 401 = age-restricted/private, 404 = deleted/unavailable
        failed.push(vid + ' (HTTP ' + res.status + ')');
        continue;
      }
      const meta = await res.json();
      let changed = false;
      if (meta.title && !row.VidTitle) { row.VidTitle = meta.title; changed = true; }
      if (meta.author_name && !row.VidAuthor) {
        // Prefer @handle from author_url if YouTube exposes /@handle path
        let author = '@' + meta.author_name;
        if (meta.author_url) {
          const m = meta.author_url.match(/\/@([^/?#]+)/);
          if (m) author = '@' + m[1];
        }
        row.VidAuthor = author; changed = true;
      }
      if (changed) {
        row.DateModified = (typeof isoNow === 'function') ? isoNow() : new Date().toISOString();
        done++;
      } else { skipped++; }
    } catch(e) { failed.push(row.link.slice(0, 60) + ' (network err)'); }
  }
  if (done) { save(); render(); }
  let msg = '📺 YT Meta: ' + done + ' updated';
  if (skipped) msg += ', ' + skipped + ' already complete';
  if (failed.length) {
    msg += '\n⚠ ' + failed.length + ' unavailable (age-restricted / private / deleted):\n';
    msg += failed.slice(0, 5).join('\n');
    if (failed.length > 5) msg += '\n…and ' + (failed.length - 5) + ' more';
  }
  toast(msg, failed.length ? 7000 : 4000);
}

function runMarkGrid() {
  // (dev0331) Size comes from the mark-grid dropdown (_markGridSize: 25/16/9/4),
  // NOT the ambient _gridGsize (which mirrored G's last-used size — the old
  // "label reads 25 but it filled 9" bug). Apply the chosen size to the grid too
  // so G opens at the matching dimension; runMarkGrid's own save() persists it.
  // Cell labels still use the 1a/1b/2a... scheme, constrained to the top-left
  // gsize × gsize square (so a 2×2 fills 1a/1b/2a/2b).
  const gsize = Math.max(2, Math.min(5, Math.round(Math.sqrt(_markGridSize))));  // 25→5, 16→4, 9→3, 4→2
  if (gsize !== _gridGsize) {
    _gridGsize = gsize;
    if (typeof _gridApplyContainerCSS === 'function') _gridApplyContainerCSS();
  }
  if (!metaRow) metaRow = { _salMeta: true };
  metaRow._salGsize = gsize;
  const cap = gsize * gsize;
  const ALL = [];
  for (let r=1; r<=gsize; r++) for (let ci=0; ci<gsize; ci++) ALL.push(r+'abcde'.charAt(ci));

  // Collect visible rows (respecting sort + filter)
  const visibleDI = [];
  for (let vi = 0; vi < data.length; vi++) {
    const di = vr(vi);
    if (rowMatchesFilter(data[di]))
      visibleDI.push(di);
  }
  if (!visibleDI.length) { toast('No visible rows to assign.', 1500); return; }

  // Clear ALL cell assignments first
  data.forEach(r => { r.cell = ''; });

  let toAssign = [];
  if (_markGridMode === 'top') {
    toAssign = visibleDI.slice(0, cap);
  } else if (_markGridMode === 'focused') {
    if (focus === null) { toast('No row focused — click a row first', 1800); data.forEach(r=>{r.cell='';}); save(); render(); return; }
    const focusDI = vr(focus.r);
    const startIdx = visibleDI.indexOf(focusDI);
    if (startIdx < 0) { toast('Focused row not in visible set', 1500); save(); render(); return; }
    toAssign = visibleDI.slice(startIdx, startIdx + cap);
  } else if (_markGridMode === 'random') {
    // Fisher-Yates shuffle, take up to `cap`
    const pool = visibleDI.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    toAssign = pool.slice(0, cap);
    // Sort assigned by original visible order for grid display
    toAssign.sort((a, b) => visibleDI.indexOf(a) - visibleDI.indexOf(b));
  }

  toAssign.forEach((di, i) => { data[di].cell = ALL[i]; });
  save(); render();
  toast('✓ Assigned ' + toAssign.length + ' rows to '+gsize+'×'+gsize+' grid cells'
    + (visibleDI.length > cap ? '\n(' + (visibleDI.length - cap) + ' rows beyond ' + cap + '-cell grid)' : ''),
    2000);
}

// Fix vRange/vComment — sort segments earliest to latest, keep VidComment mapped
document.getElementById('fixVRangeBtn').addEventListener('click', () => {
  let fixedCount = 0;
  const now = isoNow();
  
  data.forEach(row => {
    if (!row.VidRange || row.VidRange === 'i') return;
    
    // Parse segments from VidRange
    const segs = window.parseVideoAsset ? window.parseVideoAsset(row.VidRange) : null;
    if (!segs || segs.length < 2) return; // Nothing to sort if < 2 segments
    
    // Parse VidComment (pipe-separated, same count as segments)
    const comments = (row.VidComment || '').split('|').map(s => s.trim());
    
    // Create paired array for sorting
    const paired = segs.map((seg, i) => ({
      start: seg.start,
      dur: seg.dur,
      comment: comments[i] || ''
    }));
    
    // Check if already sorted
    let needsSort = false;
    for (let i = 1; i < paired.length; i++) {
      if (paired[i].start < paired[i-1].start) { needsSort = true; break; }
    }
    if (!needsSort) return;
    
    // Sort by start time
    paired.sort((a, b) => a.start - b.start);
    
    // Reconstruct VidRange and VidComment
    row.VidRange = window.serializeSegments
      ? window.serializeSegments(paired)
      : paired.map(p => p.start + ' ' + p.dur).join(', ');
    row.VidComment = paired.map(p => p.comment).join('|');
    row.DateModified = now;
    fixedCount++;
  });
  
  if (fixedCount > 0) {
    save(); render();
    toast('✓ Fixed ' + fixedCount + ' rows (sorted segments)');
  } else {
    toast('All VidRange values already sorted');
  }
});

// Calc Lengths — calculate segLength (selected clips) for video rows with segments.
// vidLength (total video duration) cannot be computed from segments alone —
// it is auto-saved by the Video Editor when the player reports getDuration().
document.getElementById('calcLengthsBtn').addEventListener('click', () => {
  let updatedCount = 0;
  const now = isoNow();

  // mm:ss formatter
  const fmtTime = (secs) => {
    if (!secs || isNaN(secs) || secs <= 0) return '';
    const m = Math.floor(secs / 60);
    const s = Math.round(secs % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  };

  data.forEach(row => {
    const link = row.link || '';
    const isVid = isVideoRow(row);
    if (!isVid) return;

    const segs = window.parseVideoAsset ? window.parseVideoAsset(row.VidRange) : null;

    // segLength = total selected clip duration (sum of segment durs)
    // Only meaningful when segments are defined
    const segTotal = segs ? segs.reduce((sum, seg) => sum + (seg.dur || 0), 0) : 0;
    const segLengthStr = segs && segTotal > 0 ? fmtTime(segTotal) : (row.segLength || '');

    // vidLength: total video duration — only the player knows this.
    // Do NOT overwrite an existing value; leave blank if unknown.
    // (VE auto-saves vidLength when it loads the video.)
    const vidLengthStr = row.vidLength || '';

    if (row.segLength !== segLengthStr) {
      row.segLength = segLengthStr;
      row.DateModified = now;
      updatedCount++;
    }
  });

  if (updatedCount > 0) {
    save(); render();
    toast('✓ Updated segLength for ' + updatedCount + ' rows\n(vidLength auto-fills when you open a video in E)', 3000);
  } else {
    toast('segLength already up to date\n(Open videos in E to fill vidLength)', 2500);
  }
});

// (dev0353) Reassign UIDs action removed — button gone, action retired.

document.getElementById('clearFilterBtn').addEventListener('click', () => {
  rowFilter = null;
  render();
});

// ── Filter bar (F hotkey in T) ────────────────────────────────────────────
// Thin horizontal strip in DOM flow (no overlay). Composite filter: tags
// AND'd + text-field substring matches (VidAuthor, VidTitle, link, ftext).
// Updates live as you type. Initialized once on load; F shows/hides it.
(function () {
  const bar      = document.getElementById('filterBar');
  const tagInp   = document.getElementById('fbTagInput');
  const chipsEl  = document.getElementById('fbChips');
  const countEl  = document.getElementById('fbCount');
  const clearBtn = document.getElementById('fbClear');
  const closeBtn = document.getElementById('fbClose');
  if (!bar || !tagInp) return;

  let chips = [];   // tag IDs currently selected (AND'd)
  const text = { VidAuthor:'', VidTitle:'', link:'', ftext:'', anywhere:'' };
  let media  = [];  // (dev0343) media-type toggles: 'image'|'video'|'other' (OR)
  let orient = [];  // (dev0343) orientation toggles: 'landscape'|'portrait' (OR)
  let dd = null, ddIdx = -1, ddMatches = [];

  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  let _flTimer = null;
  function applyLive() {
    const hasAny = chips.length || media.length || orient.length
                || Object.values(text).some(v => v && v.trim());
    rowFilter = hasAny ? { composite: true, tags: chips.slice(), text: Object.assign({}, text),
                           media: media.slice(), orient: orient.slice() } : null;
    if (rowFilter) _lastRowFilter = rowFilter;
    // (dev0326) Debounce the expensive render + count scan: typing in the filter
    // otherwise rebuilds the whole tbody (O(rows)) on EVERY keystroke. rowFilter
    // state is set synchronously above; only the paint waits 120ms. This survives
    // virtualization — render() gets cheap then, but this still throttles the
    // O(rows) rowMatchesFilter count scan that runs regardless of windowing.
    clearTimeout(_flTimer);
    _flTimer = setTimeout(() => {
      render();
      const cnt = rowFilter ? data.filter(r => rowMatchesFilter(r)).length : data.length;
      countEl.textContent = cnt + '/' + data.length;
    }, 120);
  }

  function renderChips() {
    if (!chips.length) { chipsEl.innerHTML = ''; return; }
    chipsEl.innerHTML = chips.map(id => {
      const t = window.tagsLib && window.tagsLib.get(id);
      const lbl = t ? t.label + (t.common ? ' ('+t.common+')' : '') : id;
      return '<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 6px;'
        + 'background:rgba(200,100,140,0.2);border:1px solid #c78;border-radius:10px;'
        + 'color:#fdf;font-size:11px;font-family:monospace;">'
        + esc(lbl)
        + ' <span data-chip-x="'+esc(id)+'" style="cursor:pointer;color:#f99;font-weight:bold;line-height:1;">×</span>'
        + '</span>';
    }).join('');
  }

  // Delegated chip removal
  chipsEl.addEventListener('click', e => {
    const id = e.target.dataset && e.target.dataset.chipX;
    if (!id) return;
    chips = chips.filter(x => x !== id);
    renderChips();
    applyLive();
  });

  // ── (dev0343) Media-type + orientation toggle pills ──
  // Multi-select: clicking toggles membership; several may be active (OR within
  // each bar). Media is live-computed from the link; orientation reads P/S.
  const mediaBtns  = Array.from(document.querySelectorAll('#fbMediaBar  [data-media]'));
  const orientBtns = Array.from(document.querySelectorAll('#fbOrientBar [data-orient]'));
  function paintToggles() {
    mediaBtns.forEach(b  => b.classList.toggle('on', media.includes(b.dataset.media)));
    orientBtns.forEach(b => b.classList.toggle('on', orient.includes(b.dataset.orient)));
  }
  function wireToggle(btn, arr, key) {
    btn.addEventListener('click', () => {
      const i = arr.indexOf(key);
      if (i >= 0) arr.splice(i, 1); else arr.push(key);
      paintToggles(); applyLive();
    });
  }
  mediaBtns.forEach(b  => wireToggle(b, media,  b.dataset.media));
  orientBtns.forEach(b => wireToggle(b, orient, b.dataset.orient));

  // ── Tag dropdown ──
  function closeDd() { if (dd) { dd.remove(); dd = null; } ddIdx = -1; ddMatches = []; }

  function showDd() {
    closeDd();
    const q = tagInp.value.trim();
    if (!q) return;
    const lib = window.tagsLib;
    if (!lib) return;
    ddMatches = lib.search(q, 25).filter(t => !chips.includes(t.id));
    if (!ddMatches.length) return;
    const rect = tagInp.getBoundingClientRect();
    dd = document.createElement('div');
    dd.style.cssText = 'position:fixed;z-index:32000;background:#0d0d1e;border:1px solid #c78;'
      + 'border-top:none;border-radius:0 0 5px 5px;max-height:280px;overflow-y:auto;'
      + 'font-family:monospace;font-size:12px;min-width:220px;'
      + 'box-shadow:0 6px 20px rgba(0,0,0,0.9);left:'+rect.left+'px;top:'+rect.bottom+'px;';
    ddMatches.forEach((t, i) => {
      const r = document.createElement('div');
      r.style.cssText = 'padding:5px 10px;cursor:pointer;border-bottom:1px solid #1a1a2e;color:#ddf;';
      r.innerHTML = '<span style="color:#f8a;">'+esc(t.label)+'</span>'
        + (t.common ? ' <span style="color:#999;font-size:11px;">'+esc(t.common)+'</span>' : '')
        + (t.rank  ? ' <span style="color:#556;font-size:10px;">'+esc(t.rank)+'</span>' : '');
      r.addEventListener('mouseenter', () => { ddIdx = i; hilite(); });
      r.addEventListener('mousedown',  e => { e.preventDefault(); pick(i); });
      dd.appendChild(r);
    });
    document.body.appendChild(dd);
    ddIdx = 0; hilite();
  }

  function hilite() {
    if (!dd) return;
    [...dd.children].forEach((c, i) => { c.style.background = i === ddIdx ? 'rgba(200,100,140,0.28)' : ''; });
    if (dd.children[ddIdx]) dd.children[ddIdx].scrollIntoView({block:'nearest'});
  }

  function pick(idx) {
    const t = ddMatches[idx];
    if (!t) return;
    if (!chips.includes(t.id)) chips.push(t.id);
    tagInp.value = ''; closeDd();
    renderChips(); applyLive();
    tagInp.focus();
  }

  tagInp.addEventListener('input', showDd);
  tagInp.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!dd) { showDd(); return; }
      ddIdx = Math.min(ddIdx + 1, ddMatches.length - 1); hilite();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!dd) return;
      ddIdx = Math.max(ddIdx - 1, 0); hilite();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (dd && ddMatches.length) {
        pick(ddMatches.length === 1 ? 0 : Math.max(0, ddIdx));
      } else if (tagInp.value.trim() && window.tagsLib) {
        const id = window.tagsLib.resolve(tagInp.value.trim());
        if (id && !chips.includes(id)) { chips.push(id); tagInp.value = ''; renderChips(); applyLive(); }
      }
    } else if (e.key === 'Escape') {
      if (dd) { closeDd(); e.stopPropagation(); }
      else    { window.closeFilterBar(); e.stopPropagation(); }
    }
  });

  // ── Text inputs with typeahead (VidAuthor, link) ──
  function uniqueValuesFor(field) {
    const seen = new Set(), out = [];
    for (const r of data) {
      const v = r[field];
      if (v && typeof v === 'string' && !seen.has(v)) { seen.add(v); out.push(v); if (out.length > 800) break; }
    }
    return out;
  }

  function attachTypeahead(input, field) {
    let tdd = null, tIdx = -1, tMatches = [];
    function tc() { if (tdd) { tdd.remove(); tdd = null; } tIdx = -1; tMatches = []; }
    function ts() {
      tc();
      const q = input.value.trim().toLowerCase();
      if (!q || q.length < 2) return;
      tMatches = uniqueValuesFor(field).filter(v => v.toLowerCase().includes(q)).slice(0, 12);
      if (!tMatches.length) return;
      const rect = input.getBoundingClientRect();
      tdd = document.createElement('div');
      tdd.style.cssText = 'position:fixed;z-index:32000;background:#0d0d1e;border:1px solid #345;'
        + 'border-top:none;max-height:200px;overflow-y:auto;font-family:monospace;font-size:11px;'
        + 'min-width:220px;box-shadow:0 6px 20px rgba(0,0,0,0.9);'
        + 'left:'+rect.left+'px;top:'+rect.bottom+'px;';
      tMatches.forEach((v, i) => {
        const r = document.createElement('div');
        r.style.cssText = 'padding:4px 8px;cursor:pointer;border-bottom:1px solid #1a1a2e;color:#ccf;'
          + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        r.title = v; r.textContent = v;
        r.addEventListener('mouseenter', () => { tIdx = i; th(); });
        r.addEventListener('mousedown', e => { e.preventDefault(); input.value = v; text[field] = v; tc(); applyLive(); });
        tdd.appendChild(r);
      });
      document.body.appendChild(tdd); tIdx = -1;
    }
    function th() {
      if (!tdd) return;
      [...tdd.children].forEach((c, i) => c.style.background = i === tIdx ? 'rgba(100,140,200,0.28)' : '');
      if (tdd.children[tIdx]) tdd.children[tIdx].scrollIntoView({block:'nearest'});
    }
    input.addEventListener('input', () => { text[field] = input.value; applyLive(); ts(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (!tdd) { ts(); return; } tIdx = Math.min(tIdx+1, tMatches.length-1); th(); }
      else if (e.key === 'ArrowUp')  { e.preventDefault(); if (!tdd) return; tIdx = Math.max(tIdx-1,0); th(); }
      else if (e.key === 'Enter')    { if (tdd && tIdx >= 0) { e.preventDefault(); input.value = tMatches[tIdx]; text[field] = tMatches[tIdx]; tc(); applyLive(); } }
      else if (e.key === 'Escape')   { if (tdd) { tc(); e.stopPropagation(); } else { window.closeFilterBar(); e.stopPropagation(); } }
    });
    input.addEventListener('blur', () => setTimeout(tc, 150));
  }

  attachTypeahead(document.getElementById('fbAuthor'), 'VidAuthor');
  attachTypeahead(document.getElementById('fbLink'),   'link');

  // Plain text fields
  ['fbTitle','fbFtext'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => { text[el.dataset.field] = el.value; applyLive(); });
    el.addEventListener('keydown', e => {
      if (e.key === 'Escape') { if (document.getElementById('filterBar').style.display !== 'none') { window.closeFilterBar(); e.stopPropagation(); } }
    });
  });

  // Anywhere field (OR search across all text fields + tag labels)
  const anywhereInp = document.getElementById('fbAnywhere');
  if (anywhereInp) {
    anywhereInp.addEventListener('input', () => { text.anywhere = anywhereInp.value; applyLive(); });
    anywhereInp.addEventListener('keydown', e => {
      if (e.key === 'Escape') { window.closeFilterBar(); e.stopPropagation(); }
    });
  }

  // Buttons
  clearBtn.addEventListener('click', () => {
    chips = []; Object.keys(text).forEach(k => text[k] = '');
    media.length = 0; orient.length = 0;   // mutate in place — toggle handlers hold these refs
    ['fbTagInput','fbAuthor','fbTitle','fbLink','fbFtext','fbAnywhere'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    closeDd(); renderChips(); paintToggles(); applyLive();
    tagInp.focus();
  });
  closeBtn.addEventListener('click', () => window.closeFilterBar());

  // (dev0344) Esc closes the filter bar from anywhere — the per-input handlers
  // only fire when a text field is focused, so clicking a toggle pill (or the
  // table) used to leave Esc dead. Bubble phase + a visibility guard so an open
  // typeahead/tag dropdown (which stops propagation on its own Esc) still gets
  // first crack, and so this never interferes when the bar is hidden.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (bar.style.display === 'none') return;
    window.closeFilterBar();
  });

  // Public API — called by F hotkey (vp.js) and Shift-F
  window.openFilterBar = function () {
    media.length = 0; orient.length = 0;   // reset toggles (refilled below if composite)
    if (rowFilter && rowFilter.composite) {
      // Restore full composite filter state
      chips = (rowFilter.tags || []).slice();
      Object.assign(text, rowFilter.text || {});
      (rowFilter.media  || []).forEach(v => media.push(v));
      (rowFilter.orient || []).forEach(v => orient.push(v));
      document.getElementById('fbAuthor').value  = text.VidAuthor || '';
      document.getElementById('fbTitle').value   = text.VidTitle  || '';
      document.getElementById('fbLink').value    = text.link      || '';
      document.getElementById('fbFtext').value   = text.ftext     || '';
      const aw = document.getElementById('fbAnywhere');
      if (aw) aw.value = text.anywhere || '';
    } else if (rowFilter && rowFilter.col === 'tags' && rowFilter.hierarchical) {
      chips = [rowFilter.val];
    } else {
      // No active filter (e.g. after Shift-F) — start completely fresh
      chips = [];
      Object.keys(text).forEach(k => text[k] = '');
      ['fbTagInput','fbAuthor','fbTitle','fbLink','fbFtext','fbAnywhere'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
      });
      closeDd();
    }
    renderChips(); paintToggles();
    bar.style.display = 'flex';
    setTimeout(() => anywhereInp.focus(), 30);
    applyLive();
  };

  window.closeFilterBar = function () {
    closeDd(); bar.style.display = 'none';
  };

  // Legacy alias kept for vp.js references
  window.openFilterModal  = window.openFilterBar;
  window.closeFilterModal = window.closeFilterBar;
})();

// (old modal fully removed)

// Reusable autocomplete
// getChoices(): returns array of strings
// container: the element to append the dropdown to (defaults to document.body)
function addAutocomplete(inp, getChoices, container) {
  if (!inp) return;
  let dd = null;
  let ddIdx = -1;

  function removeDd() {
    if (dd) { dd.remove(); dd = null; ddIdx = -1; }
  }

  function showDd() {
    removeDd();
    const q = inp.value.trim().toLowerCase();
    const choices = getChoices();
    const matches = q
      ? choices.filter(c => { const lc=c.toLowerCase(); return (_dictMatchMode==='start'?lc.startsWith(q):lc.includes(q)) && lc!==q; })
      : choices.filter(c => c);
    if (!matches.length) return;

    dd = document.createElement('div');
    dd.style.cssText = 'position:fixed;z-index:999999;background:#14142a;border:1px solid #4af;'
      + 'border-radius:0 0 6px 6px;max-height:200px;overflow-y:auto;'
      + 'font-family:monospace;font-size:12px;box-shadow:0 4px 18px rgba(0,0,0,0.9);min-width:180px;';

    matches.slice(0, 30).forEach((val, i) => {
      const item = document.createElement('div');
      item.textContent = val;
      item.style.cssText = 'padding:6px 10px;cursor:pointer;color:#ccc;border-bottom:1px solid #1a1a2e;white-space:nowrap;';
      item.addEventListener('mouseenter', () => setDdIdx(i));
      item.addEventListener('mouseleave', () => { item.style.background=''; item.style.color='#ccc'; });
      item.addEventListener('mousedown', e => { e.preventDefault(); selectDd(val); });
      dd.appendChild(item);
    });

    // Position below the input
    const r = inp.getBoundingClientRect();
    dd.style.left  = r.left + 'px';
    dd.style.top   = r.bottom + 'px';
    dd.style.width = Math.max(r.width, 180) + 'px';
    document.body.appendChild(dd);
    ddIdx = -1;
  }

  function setDdIdx(i) {
    ddIdx = i;
    if (!dd) return;
    [...dd.children].forEach((item, j) => {
      item.style.background = j === i ? '#1a3a6a' : '';
      item.style.color      = j === i ? '#fff'    : '#ccc';
    });
  }

  function selectDd(val) {
    inp.value = val;
    inp.dispatchEvent(new Event('input'));
    removeDd();
    inp.focus();
  }

  inp.addEventListener('input',   showDd);
  inp.addEventListener('focus',   showDd);
  inp.addEventListener('blur',    () => setTimeout(removeDd, 150));
  inp.addEventListener('keydown', e => {
    if (!dd) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault(); setDdIdx(Math.min(ddIdx+1, dd.children.length-1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); setDdIdx(Math.max(ddIdx-1, 0));
    } else if (e.key === 'Enter' && ddIdx >= 0) {
      e.preventDefault(); e.stopPropagation();
      selectDd(dd.children[ddIdx].textContent);
    } else if (e.key === 'Escape') {
      removeDd();
    }
  });
}

// Wire autocomplete to Browse fields (after DOM ready)
function updateDictBtn() {
  const btn = document.getElementById('dictModeBtn');
  if (!btn) return;
  btn.textContent = 'Lookup: ' + _dictMatchMode;
  btn.style.borderColor = _dictMatchMode === 'start' ? '#fa8' : '#4af';
  btn.style.color       = _dictMatchMode === 'start' ? '#fa8' : '#8ef';
}

function setupBrowseAutocomplete() {
  const getCol = col => [...new Set(data.map(r => String(r[col]||'').trim()).filter(Boolean))].sort();
  const getT2  = () => {
    const t1 = (document.getElementById('brt1') || {}).value || '';
    const seed = T2_BY_T1[t1] || [];
    const fromData = getCol('t2');
    return [...new Set([...seed, ...fromData.filter(v => !seed.includes(v))])];
  };
  // Direct key handler on t1 select: H/A/L/O sets value immediately + advances to t2
  const _brt1 = document.getElementById('brt1');
  if (_brt1) {
    _brt1.addEventListener('keydown', e => {
      const k = e.key.toUpperCase();
      if (k==='H'||k==='A'||k==='L'||k==='O') {
        e.preventDefault();
        _brt1.value = k;
        _brt1.dispatchEvent(new Event('change'));
        document.getElementById('brt2').dispatchEvent(new Event('input'));
        setTimeout(() => brFocusField('brt2'), 20);
      }
    });
  }

  addAutocomplete(document.getElementById('brn1'),     () => getCol('n1'));
  addAutocomplete(document.getElementById('brn2'),     () => getCol('n2'));
  addAutocomplete(document.getElementById('brn3'),     () => getCol('n3'));
  addAutocomplete(document.getElementById('brt2'),     getT2);
  addAutocomplete(document.getElementById('brComment'),() => getCol('comment'));
}
// video.js references global `linksData` and `window.saveData`
Object.defineProperty(window, 'linksData', {
  get: () => data, set: v => { data = v; }, configurable: true
});
window.saveData = () => save();

// Navigation helpers needed by video.js for E up/down arrows (visible-row nav)
// (zip0162) sortedIdx is now declared with var at top of file, so window.sortedIdx
// is automatically live. The previous Object.defineProperty getter is no longer
// needed (and would throw on a var-created non-configurable window property).
window.vr = vr;
window.isVideoRow = isVideoRow;
window.toast = toast;

// (zip0183) Update T's focused row to match the given data row object.
// Called by textEditorClose() so that returning to T always highlights the
// row that was last open in Xe, regardless of how many rows were walked
// with ArrowUp/Down while Xe was open.
window._setFocusToRow = function(row) {
  if (!row || !Array.isArray(data)) return;
  const di = data.indexOf(row);
  if (di < 0) return;
  for (let vi = 0; vi < data.length; vi++) {
    if (vr(vi) === di) {
      focus = { r: vi, c: focus !== null ? focus.c : 0 };
      return;
    }
  }
};

// Browse Filtered (Annotate panel)
let _brRows   = [];
let _brIdx    = 0;
let _dictMatchMode = 'anywhere'; // 'anywhere' | 'start'

// (zip0178) _brRows / _brIdx are `let` so NOT auto-promoted to window.
// Expose them as live window properties so xe.js and vp.js can participate
// in cross-editor row navigation (Xe ↑/↓ and Ie ↑/↓, like Ev already has).
Object.defineProperty(window, '_brRows', {
  get() { return _brRows; }, set(v) { _brRows = v; }, configurable: true
});
Object.defineProperty(window, '_brIdx', {
  get() { return _brIdx; }, set(v) { _brIdx = v; }, configurable: true
});

function brGetVisibleRows() {
  const result = [];
  for (let vi = 0; vi < data.length; vi++) {
    const di = vr(vi);
    if (rowMatchesFilter(data[di]))
      result.push(di);
  }
  return result;
}

function brOpen(startDi) {
  _brRows = brGetVisibleRows();
  if (!_brRows.length) { toast('No visible rows to annotate.\nApply a filter or ensure data is loaded.'); return; }
  _brIdx = 0;
  // Start from focused row or passed di
  if (startDi !== undefined) {
    const fi = _brRows.indexOf(startDi);
    if (fi >= 0) _brIdx = fi;
  } else if (focus !== null) {
    const di = vr(focus.r);
    const fi = _brRows.indexOf(di);
    if (fi >= 0) _brIdx = fi;
  }
  document.getElementById('browseOverlay').style.display = 'flex';
  document.getElementById('wrap').style.marginRight = '340px'; // shrink table area
  brShow(_brIdx);
  requestAnimationFrame(() => {
    const chipInput = document.querySelector('#brTagChips input');
    if (chipInput) chipInput.focus();
    else {
      const el = document.getElementById('brt1');
      if (el) el.focus();
    }
  });
}

// Open Annotate for a specific row (used from Grid and tag-cell dblclick)
function openBrowseForRow(row) {
  const di = data.indexOf(row);
  if (di < 0) { toast('Row not found'); return; }
  _brRows = [di];
  _brIdx = 0;
  document.getElementById('browseOverlay').style.display = 'flex';
  brShow(0);
  requestAnimationFrame(() => {
    // Focus the tag chip input's inner <input>, falling back to legacy brt1
    const chipInput = document.querySelector('#brTagChips input');
    if (chipInput) chipInput.focus();
    else {
      const el = document.getElementById('brt1');
      if (el) el.focus();
    }
  });
}
window.openBrowseForRow = openBrowseForRow;

function brClose() {
  document.getElementById('browseOverlay').style.display = 'none';
  document.getElementById('wrap').style.marginRight = ''; // restore full width
  brClearThumb();
  render(); // ensure table reflects saves
  if (_cameFromGrid) {
    _cameFromGrid = false;
    gridShow();
  }
}

function brClearThumb() {
  const inner = document.getElementById('brThumbInner');
  if (inner) inner.innerHTML = '';
  const area = document.getElementById('brThumbArea');
  if (area) area.style.display = 'none';
}

// Legacy alias used by video editor close path
function brClearMedia() { brClearThumb(); }

function brBuildThumb(row) {
  const area  = document.getElementById('brThumbArea');
  const inner = document.getElementById('brThumbInner');
  if (!area || !inner) return;
  inner.innerHTML = '';
  const isVid = isVideoRow(row);
  const link = row.link || '';

  if (isVid && link) {
    area.style.display = 'block';
    const ytId = window.getYouTubeId ? window.getYouTubeId(link)
      : (link.match(/(?:youtu\.be\/|shorts\/|[?&]v=)([A-Za-z0-9_-]{11})/)?.[1] || '');
    if (ytId) {
      // YouTube / Shorts — instant thumbnail
      const img = document.createElement('img');
      img.src = 'https://img.youtube.com/vi/' + ytId + '/mqdefault.jpg';
      img.style.cssText = 'width:100%;height:100%;object-fit:contain;';
      const badge = document.createElement('div');
      badge.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;';
      badge.innerHTML = '<div style="background:rgba(0,0,0,0.55);border-radius:50%;width:44px;height:44px;display:flex;align-items:center;justify-content:center;font-size:22px;">▶</div>';
      inner.style.position = 'relative';
      inner.appendChild(img);
      inner.appendChild(badge);
    } else if (/vimeo\.com/i.test(link)) {
      // Vimeo — check cache, fetch if needed
      const cached = _vimeoThumbCache[link];
      if (cached && cached.state === 'ok') {
        const img = document.createElement('img');
        img.src = cached.src;
        img.style.cssText = 'width:100%;height:100%;object-fit:contain;';
        const badge = document.createElement('div');
        badge.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;';
        badge.innerHTML = '<div style="background:rgba(0,0,0,0.55);border-radius:50%;width:44px;height:44px;display:flex;align-items:center;justify-content:center;font-size:22px;">▶</div>';
        inner.style.position = 'relative';
        inner.appendChild(img); inner.appendChild(badge);
      } else {
        inner.innerHTML = '<div style="color:#6af;font-size:11px;padding:10px;text-align:center;">⏳ Loading Vimeo thumb…<br><span style="color:#445;font-size:10px;">' + escH(link.slice(0,50)) + '</span></div>';
        fetchVimeoThumb(link, src => {
          // Re-run when ready
          brBuildThumb(row);
        });
      }
    } else {
      // Other video
      inner.innerHTML = '<div style="color:#8ef;font-size:11px;padding:10px;text-align:center;">▶ Video<br><span style="color:#556;font-size:10px;word-break:break-all;">'+escH(link.slice(0,60))+'</span></div>';
    }
  } else if (!isVid && link) {
    area.style.display = 'block';
    const img = document.createElement('img');
    img.src = link;
    img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;display:block;margin:auto;';
    img.onerror = () => { inner.innerHTML = '<div style="color:#f88;font-size:10px;padding:8px;word-break:break-all;">Image failed:<br>'+escH(link)+'</div>'; };
    inner.appendChild(img);
  } else {
    area.style.display = 'none';
  }
}

function brShow(idx) {
  if (idx < 0 || idx >= _brRows.length) return;
  _brIdx = idx;
  const di  = _brRows[idx];
  const row = data[di];

  // (zip0122) Update last-record memory
  if (row && row.UID && typeof window.setLastUID === 'function') {
    window.setLastUID(row.UID);
  }

  // Highlight this row in the table
  focus = { r: sortedIdx ? sortedIdx.indexOf(di) : di, c: 0 };
  render();
  // (dev0329) Windowed table: scroll the focus row into the window (mounts it)
  // rather than an nth-child lookup, which the spacer rows would throw off.
  if (typeof _tScrollRowIntoView === 'function') _tScrollRowIntoView(focus.r);

  // Counter
  document.getElementById('brCounter').textContent = (idx+1) + ' / ' + _brRows.length;

  // Row info
  const cell  = row.cell || '—';
  const isVid = isVideoRow(row);
  document.getElementById('brRowInfo').textContent =
    'Row '+(di+1)+'  ·  cell: '+cell+'  ·  '+(isVid ? '▶ vid' : '🖼 img');

  // VidRange info (hidden if not video)
  const vri = document.getElementById('brVidRangeInfo');
  if (isVid && row.VidRange) {
    vri.textContent = 'VidRange: ' + row.VidRange;
    vri.style.display = 'block';
  } else {
    vri.style.display = 'none';
  }

  // Load field values
  document.getElementById('brt1').value      = row.t1      || '';
  document.getElementById('brt2').value      = row.t2      || '';
  document.getElementById('brn1').value      = row.n1      || row.cname || '';
  document.getElementById('brn2').value      = row.n2      || row.sname || '';
  document.getElementById('brn3').value      = row.n3      || '';
  document.getElementById('brComment').value = row.comment || '';
  document.getElementById('brVal').value     = row.Val     || '';

  // Mount / remount the tag chip input for this row
  if (window.mountTagChipInput && window.tagsLib) {
    const chipHost = document.getElementById('brTagChips');
    if (chipHost) {
      if (!Array.isArray(row.tags)) row.tags = [];
      window.mountTagChipInput({
        container: chipHost,
        getIds: () => row.tags,
        setIds: (next) => {
          row.tags = next;
          row.DateModified = isoNow();
          save();
          if (typeof render === 'function') render();
          brUpdateAncestors(di);
        },
        placeholder: 'add tag… (type species, common name, topic, technique)'
      });
      brUpdateAncestors(di);
    }
  }

  // Thumbnail
  brBuildThumb(row);

  // Wire up LIVE update on every field change for this row
  brWireLiveUpdate(di);
}

// Show derived ancestor chain below the tag input as a hint of what's implied
function brUpdateAncestors(di) {
  const el = document.getElementById('brTagAncestors');
  if (!el || !window.tagsLib) return;
  const row = data[di];
  const ids = Array.isArray(row && row.tags) ? row.tags : [];
  if (!ids.length) { el.innerHTML = ''; return; }

  // 1) Ancestor chain from explicit tags
  const eff = window.tagsLib.expand(ids);
  ids.forEach(id => eff.delete(id));
  const ancestorLabels = [...eff].map(id => window.tagsLib.labelFor(id));

  // 2) Orphan tags on this record (no parent → no ancestor chain)
  // Show inline "set parent" affordance so hierarchy can be created at
  // annotation time, when the concept is fresh in the user's mind.
  const orphans = ids.filter(id => {
    const t = window.tagsLib.get(id);
    if (!t) return false;
    if (t.kind === 'root') return false;            // roots are intentionally rootless
    return !t.parents || !t.parents.length;
  });

  let html = '';
  if (ancestorLabels.length) {
    html += '↑ implies: <span style="color:#7a8;">' + ancestorLabels.join(' · ') + '</span>';
  }
  if (orphans.length) {
    if (html) html += '<br>';
    const tagsLib = window.tagsLib;
    const labels = orphans.map(id => '<a href="#" data-orphan-id="' + id + '" class="br-set-parent" style="color:#fc8;text-decoration:none;border-bottom:1px dotted #fc8;">' + tagsLib.labelFor(id) + '</a>').join(', ');
    html += '<span style="color:#996;">⚠ no parent yet:</span> ' + labels
      + ' <span style="color:#666;font-size:9px;">(click to set — gives this tag an ancestor so search/filter implies it)</span>';
  }
  el.innerHTML = html;

  // Wire orphan click → tiny inline parent-picker
  [...el.querySelectorAll('.br-set-parent')].forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      brOpenParentPicker(a.dataset.orphanId, di);
    });
  });
}

// Inline parent picker: floats below the orphan-link line and lets you pick
// (or create) a single parent without leaving the Annotate panel.
function brOpenParentPicker(tagId, di) {
  // Close any existing picker
  const existing = document.getElementById('brParentPicker');
  if (existing) existing.remove();

  const anchor = document.querySelector('.br-set-parent[data-orphan-id="' + tagId + '"]');
  if (!anchor) return;

  const t = window.tagsLib.get(tagId);
  if (!t) return;

  const wrap = document.createElement('div');
  wrap.id = 'brParentPicker';
  wrap.style.cssText = 'margin:6px 0;padding:8px 10px;background:rgba(255,200,100,0.06);'
    + 'border:1px solid #764;border-radius:5px;font-size:11px;';
  wrap.innerHTML = '<div style="color:#fc8;margin-bottom:4px;">Set parent for <b>' + window.tagsLib.labelFor(tagId) + '</b>:</div>'
    + '<div id="brpp-input"></div>'
    + '<div style="color:#666;font-size:10px;margin-top:5px;">Type to search; Enter accepts. Pick a parent that makes sense — taxa and topic hierarchies both work. Esc cancels.</div>';

  anchor.parentNode.insertBefore(wrap, anchor.nextSibling);

  // Mount a single-select chip input
  let pickedParent = null;
  window.mountTagChipInput({
    container: wrap.querySelector('#brpp-input'),
    getIds: () => pickedParent ? [pickedParent] : [],
    setIds: (next) => {
      pickedParent = next.length ? next[next.length - 1] : null;
      if (pickedParent) commitParent();
    },
    placeholder: 'parent tag…',
    // Filter out the tag itself and its descendants (no cycles)
    filter: (id) => {
      if (id === tagId) return false;
      const desc = window.tagsLib.descendants(tagId);
      return !desc.has(id);
    }
  });

  function commitParent() {
    if (!pickedParent) return;
    const r = window.tagsLib.updateTag(tagId, { parents: [pickedParent] });
    if (r.ok) {
      if (typeof toast === 'function') {
        toast('✓ ' + window.tagsLib.labelFor(tagId) + ' → child of ' + window.tagsLib.labelFor(pickedParent), 1400);
      }
      wrap.remove();
      brUpdateAncestors(di);
      if (typeof render === 'function') render();
    }
  }

  // Focus the input
  setTimeout(() => {
    const inp = wrap.querySelector('input');
    if (inp) inp.focus();
    const escHandler = (e) => {
      if (e.key === 'Escape' && !document.querySelector('.tag-dd')) {
        e.stopPropagation();
        document.removeEventListener('keydown', escHandler, true);
        wrap.remove();
      }
    };
    document.addEventListener('keydown', escHandler, true);
  }, 30);
}

// Wire live field updates → data[] → render() on every keystroke
let _brLiveHandlers = []; // cleanup previous row's handlers
function brWireLiveUpdate(di) {
  // Remove previous handlers
  _brLiveHandlers.forEach(({el, fn, evt}) => el.removeEventListener(evt, fn));
  _brLiveHandlers = [];
  const row = data[di];
  if (!row) return;

  function wire(id, col, trim) {
    const el = document.getElementById(id);
    if (!el) return;
    const fn = () => {
      const v = trim ? el.value.trim() : el.value;
      if (String(row[col]||'') !== v) {
        row[col] = v;
        row.DateModified = isoNow();
        // Live render: update just the affected cells without losing focus
        brLiveRenderRow(di);
      }
    };
    el.addEventListener('input', fn);
    el.addEventListener('change', fn);
    _brLiveHandlers.push({el, fn, evt:'input'});
    _brLiveHandlers.push({el, fn, evt:'change'});
  }

  wire('brt1', 't1', true);
  wire('brt2', 't2', true);
  wire('brn1', 'n1', true);
  wire('brn2', 'n2', true);
  wire('brn3', 'n3', true);
  wire('brComment', 'comment', false);
  wire('brVal', 'Val', true);
}

// Re-render only the cells for a specific data row without destroying focus
function brLiveRenderRow(di) {
  const vc = visCols();
  const vi = sortedIdx ? sortedIdx.indexOf(di) : di;
  const trs = document.querySelectorAll('#tbody tr');
  // Find the tr that corresponds to this vi
  let tr = null;
  trs.forEach(r => {
    const firstTd = r.querySelector('td[data-vi]');
    if (firstTd && parseInt(firstTd.getAttribute('data-vi')) === vi) tr = r;
  });
  if (!tr) return;
  const row = data[di];
  // Update each data td
  tr.querySelectorAll('td[data-ci]').forEach(td => {
    const ci = parseInt(td.getAttribute('data-ci'));
    const col = vc[ci];
    if (col === undefined) return;
    if (td.classList.contains('editing')) return; // don't clobber inline edit
    const val = row[col] !== undefined ? String(row[col]) : '';
    td.textContent = val;
    td.title = val;
  });
}

function brSave() {
  if (_brRows.length === 0) return;
  const di  = _brRows[_brIdx];
  const row = data[di];
  const now = isoNow();
  const t1  = document.getElementById('brt1').value.trim();
  const t2  = document.getElementById('brt2').value.trim();
  const n1  = document.getElementById('brn1').value.trim();
  const n2  = document.getElementById('brn2').value.trim();
  const n3  = document.getElementById('brn3').value.trim();
  const com = document.getElementById('brComment').value;
  const val = document.getElementById('brVal').value.trim();
  let changed = false;
  function setf(col, v) { if (String(row[col]||'') !== String(v)) { row[col] = v; changed = true; } }
  setf('t1', t1); setf('t2', t2);
  setf('n1', n1); setf('n2', n2); setf('n3', n3); setf('comment', com); setf('Val', val);
  if (changed) {
    row.DateModified = now;
    save();
    render();
    toast('✓ Saved row '+(di+1), 1200);
  }
}

// Wire Annotate buttons
document.getElementById('browseBtn')?.addEventListener('click', brOpen);

// ── LinkAdd: paste clipboard → one new row per non-empty line (zip0101) ──────
// ── LinkAdd dropdown menu (zip0106) ──────────────────────────────────────────
//
// Pressing L (or clicking the toolbar button) opens a dropdown anchored to
// the LinkAdd button. Two items:
//   1. LinksBare in clipboard      — each line → one row, link only
//   2. LinksSpecial (stub)         — placeholder for clipboard with
//                                    additional info (titles etc.) to be
//                                    parsed before adding to ml.json
// First-letter shortcuts (B, S) work while the menu is open.
// On successful add: first new row is selected, table re-sorted by DateAdded
// desc so it's at top, then Annotate (A) is auto-triggered on it.

// (zip0128) Smart clipboard import for W (and L, which is now an alias).
// Detects the clipboard format and dispatches:
//   Rule 1 (BARE LINKS): every non-empty line is a video or image URL,
//                        no other text → add each as a new row.
//   Rule 2 (CHANNEL CSV): first line starts with @ → treat as channel
//                         export from a YouTube downloader. CSV lines that
//                         follow get parsed; rows are added or updated.
//   Otherwise: toast "Need rule or new clipboard".
//
// W is the canonical entry point; the L button calls the same function.

// Read clipboard text once (shared by all paths). Falls back to prompt() if
// the browser denies clipboard access.
async function readClipboardOrPrompt(promptMsg) {
  let txt = '';
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      txt = await navigator.clipboard.readText();
    }
  } catch (e) { /* fall through */ }
  if (!txt) txt = prompt(promptMsg || 'Paste content:') || '';
  return txt;
}

// Detect whether a single line looks like a media URL (video or image).
// Used by Rule 1 to decide if the clipboard is "all-links, no text".
function _looksLikeMediaUrl(s) {
  if (!s) return false;
  const t = s.trim();
  if (!/^https?:\/\//i.test(t)) return false;
  if (/youtu\.be|youtube\.com|vimeo\.com/i.test(t)) return true;
  const path = t.split(/[?#]/)[0];
  if (/\.(mp4|mov|webm|ogg|avi|mkv|m4v)$/i.test(path)) return true;
  if (/\.(jpg|jpeg|png|gif|webp|svg|bmp|avif)$/i.test(path)) return true;
  return false;
}

// (zip0166) Bare URL test — any http(s) URL, including non-media (article pages).
function _looksLikeAnyUrl(s) {
  if (!s) return false;
  return /^https?:\/\/\S+$/i.test(s.trim());
}

// (zip0166) Classify a URL → 'video' | 'image' | 'web' | null
// Used by W to route each line to the right importer.
function _classifyUrl(s) {
  if (!s) return null;
  const t = s.trim();
  if (!/^https?:\/\/\S+$/i.test(t)) return null;
  if (/youtu\.be|youtube\.com|vimeo\.com/i.test(t)) return 'video';
  const path = t.split(/[?#]/)[0];
  if (/\.(mp4|mov|webm|ogg|avi|mkv|m4v)$/i.test(path)) return 'video';
  if (/\.(jpg|jpeg|png|gif|webp|svg|bmp|avif)$/i.test(path)) return 'image';
  return 'web';
}

// Normalize a pasted link before storing. YouTube URLs → canonical youtu.be/<id>
// (strips playlist params, timestamps, embed variants, Shorts paths, etc.)
function _normalizeLink(link) {
  if (/youtu\.be|youtube\.com/i.test(link)) {
    const ytId = _extractYTVideoId(link)
      || (window.getYouTubeId && window.getYouTubeId(link));
    if (ytId) return 'https://youtu.be/' + ytId;
  }
  // (dev0424) Strip Cloudflare `?turnstile=...` (and other tracking junk) that
  // Vimeo appends when copying a URL after its bot check — keep only the clean
  // path plus the privacy `h` param for unlisted clips.
  if (/vimeo\.com\/\d+/i.test(link) && window.sanitizeVimeoUrl) {
    return window.sanitizeVimeoUrl(link);
  }
  return link;
}

// Fetch metadata (title, author, P/S, Mpix) for rows just added via W.
// Runs async after save/render so the import isn't blocked.
async function _fetchMetaForNewRows(rows) {
  const PS_COL = getPSCol();
  const now = (typeof isoNow === 'function') ? isoNow : () => new Date().toISOString();
  for (const row of rows) {
    const link = row.link || '';
    const path = link.split(/[?#]/)[0];
    const isYT    = /youtu\.be|youtube\.com/i.test(link);
    const isVimeo = /vimeo\.com/i.test(link);
    const isImg   = row.VidRange === 'i';
    const isDirVid = /\.(mp4|mov|webm|ogg|avi|mkv|m4v)$/i.test(path);
    try {
      if (isYT) {
        const ytId = _extractYTVideoId(link) || (window.getYouTubeId && window.getYouTubeId(link));
        if (!ytId) continue;
        const res = await fetchWithTimeout(
          'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + ytId), 8000);
        if (!res || !res.ok) continue;
        const meta = await res.json();
        let changed = false;
        if (meta.title      && !row.VidTitle)  { row.VidTitle  = meta.title; changed = true; }
        if (meta.author_name && !row.VidAuthor) {
          let author = '@' + meta.author_name;
          if (meta.author_url) { const m = meta.author_url.match(/\/@([^/?#]+)/); if (m) author = '@' + m[1]; }
          row.VidAuthor = author; changed = true;
        }
        if (!row[PS_COL]) {
          const ps = /youtube\.com\/shorts\//i.test(link) ? '1'
            : (meta.thumbnail_height > meta.thumbnail_width ? '1' : '0');
          row[PS_COL] = ps; changed = true;
        }
        if (changed) { row.DateModified = now(); save(); render(); }
      } else if (isVimeo) {
        const res = await fetchWithTimeout(
          'https://vimeo.com/api/oembed.json?url=' + encodeURIComponent(link), 8000);
        if (!res || !res.ok) continue;
        const meta = await res.json();
        let changed = false;
        if (meta.title       && !row.VidTitle)  { row.VidTitle  = meta.title; changed = true; }
        if (meta.author_name && !row.VidAuthor)  { row.VidAuthor = meta.author_name; changed = true; }
        if (!row[PS_COL] && meta.thumbnail_width && meta.thumbnail_height) {
          row[PS_COL] = meta.thumbnail_height > meta.thumbnail_width ? '1' : '0'; changed = true;
        }
        if (changed) { row.DateModified = now(); save(); render(); }
      } else if (isImg) {
        const dims = await getImageDims(link);
        if (dims && dims.w > 0 && dims.h > 0) {
          let changed = false;
          if (!row.MPix) {
            const mp = (dims.w * dims.h) / 1_000_000;
            row.MPix = mp >= 0.1 ? mp.toFixed(1) : mp.toFixed(2);
            changed = true;
          }
          if (!row[PS_COL]) { row[PS_COL] = dims.h > dims.w ? '1' : '0'; changed = true; }
          if (changed) { row.DateModified = now(); save(); render(); }
        }
      } else if (isDirVid) {
        if (!row.MPix) { row.MPix = 'V'; row.DateModified = now(); save(); render(); }
      }
    } catch(_) {}
  }
}

// Single CSV row parser used by the channel-import path. Handles
// "double-quoted" fields containing commas. No escaped quotes (YouTube
// channel exports don't use them).
function _parseCsvRow(line) {
  const fields = [];
  let i = 0, n = line.length;
  while (i < n) {
    while (i < n && (line[i] === ' ' || line[i] === ',')) i++;
    if (i >= n) break;
    if (line[i] === '"') {
      i++;
      let val = '';
      while (i < n && line[i] !== '"') { val += line[i]; i++; }
      if (i < n) i++; // skip closing quote
      fields.push(val);
    } else {
      let val = '';
      while (i < n && line[i] !== ',') { val += line[i]; i++; }
      fields.push(val.trim());
    }
  }
  return fields;
}

// Smart import: looks at clipboard, picks rule, runs it. This is what W and
// L are wired to.
async function wantLinks() {
  try {
  return await _wantLinksInner();
  } catch(e) {
    console.error('wantLinks error:', e);
    alert('W — unexpected error:\n' + (e && e.message ? e.message : String(e)));
  }
}
async function _wantLinksInner() {
  const txt = await readClipboardOrPrompt(
    'Paste either:\n' +
    '  • One or more URLs (newline-separated) — videos, images, or web articles, OR\n' +
    '  • A channel export with @channelname on line 1 and CSV rows below.'
  );
  if (!txt.trim()) { toast('Clipboard empty.', 1400); return; }

  const lines = txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) { toast('No content found.', 1400); return; }

  // Rule 0 (dev0427): Firefox "Save Page As → Text" of an Instagram page →
  // enrich the matching reel row's VidTitle/ftext/ttxt (caption + others'
  // comments + the author's other reel URLs). Checked first because a saved
  // page's line 1 is "Instagram" (neither a URL nor @channel).
  if (_looksLikeIgSavedText(txt)) {
    return _importIgSavedText(txt);
  }

  // Rule 2: first line is @channelname → channel CSV import
  if (lines[0].startsWith('@')) {
    return _importChannelCSV(lines);
  }

  // Rule 1: every line is a URL (any kind) → bare-links import.
  // The bare-links importer now classifies each line as video/image/web
  // and writes ltype + ftext for web URLs (zip0166).
  if (lines.every(_looksLikeAnyUrl)) {
    return await _importBareLinks(lines);
  }

  // (dev0341) Rule 3: no URL on line 1 -> new row, ltype=0, clean formatted ftext.
  // Prefer text/html (sanitized to a small semantic subset: headings, bullets,
  // links, bold — no inline-style/class/framework junk). Fall back to plain
  // text with every line break preserved.
  if (!_looksLikeAnyUrl(lines[0])) {
    let ftext = '';
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          if (item.types.includes('text/html')) {
            const blob = await item.getType('text/html');
            ftext = _sanitizePastedHtml(await blob.text());
            break;
          }
        }
      }
    } catch (e) { /* fall through to plain text */ }
    if (!ftext) ftext = _textToLineHtml(txt);
    const now = isoNow();
    const row = { UID: nextUID(), link: '', show: '1', DateAdded: now, DateModified: now, ltype: 0, ftext, tags: [] };
    data.push(row);
    save();
    if (typeof buildSort === 'function') { sortCol = 'DateAdded'; sortDir = 'desc'; buildSort(); }
    if (typeof render === 'function') render();
    toast('✓ New ftext row (ltype=0) · ' + ftext.length.toLocaleString() + ' chars', 2000);
    return;
  }

  // Neither rule matches — show a blocking popup so it isn't missed
  const preview = lines.slice(0, 3).map(s => s.length > 70 ? s.slice(0, 67) + '…' : s).join('\n  ');
  alert(
    'W — clipboard format not recognised.\n\n'
    + 'Expected:\n'
    + '  • One or more URLs (videos, images, articles)\n'
    + '  • @channel on line 1 then CSV rows\n'
    + '  • Plain article text (no URL on line 1)\n\n'
    + 'Got:\n  ' + preview
  );
}

// Append duplicate-link records to duplicateTries.txt in the project folder,
// then focus T on the first duplicate's existing row (scrolled to top).
// Returns the first duplicate's link string (used in toast messages).
async function _writeDuplicateLinksReport(dupRecords, source) {
  if (!dupRecords || !dupRecords.length) return null;
  const ts = new Date().toISOString();
  const lines = dupRecords.map(d =>
    ts + '\t' + (source || '') + '\t' + (d.UID === undefined ? '' : d.UID) + '\t' + d.link + '\t' + (d.title || '')
  ).join('\n') + '\n';
  _appendTextFileToDisk('duplicateTries.txt', lines); // async, fire-and-forget
  // Focus T on the first duplicate and scroll it to top
  const firstLink = dupRecords[0] && dupRecords[0].link;
  if (firstLink) {
    const existingRow = data.find(r => r && r.link === firstLink);
    if (existingRow) {
      const di = data.indexOf(existingRow);
      let targetVi = -1;
      for (let vi = 0; vi < data.length; vi++) { if (vr(vi) === di) { targetVi = vi; break; } }
      if (targetVi >= 0) {
        focus = { r: targetVi, c: focus !== null ? focus.c : 0 };
        render();
        // (dev0329) Windowed table: scroll the row into the window (mounts it).
        if (typeof _tScrollRowIntoView === 'function') _tScrollRowIntoView(targetVi);
      }
    }
  }
  return firstLink;
}

// ══════════════════════════════════════════════════════════════════════════════
// PASTE-AS-ARTICLE PICKER (zip0167)
// ══════════════════════════════════════════════════════════════════════════════
// When W is pressed and the clipboard's first line is not a URL, the user is
// pasting article text directly (e.g. they copy-selected the body of a
// paywalled NYT article, since jina/r.jina.ai can't bypass paywalls). Show
// a 3-option picker:
//   [W] No stripping       — paste verbatim, just wrap in <p> tags
//   [S] Some stripping     — remove obvious chrome (ads, nav, share buttons,
//                            inline link annotations, footer)
//   [A] Aggressive strip   — newspaper-tuned: also remove captions, byline,
//                            date stamps, "Editors' Picks" mid-block, and
//                            related-article tails
// The user picks by pressing w/s/a (or clicking) — Esc cancels.

function _showStripPicker(rawText) {
  // (zip0169) Pre-process: unwrap soft-wrapped URLs so detection finds the
  // article URL whole, not truncated at a line-break hyphen. Also prefer
  // a standalone-line URL (the article URL is typically on its own line)
  // over the first URL anywhere (which is usually a nav/section link).
  const prepped = _unwrapWrappedUrls(rawText);
  const detectedUrl = _detectArticleUrl(prepped);
  const lineCount = rawText.split(/\r?\n/).filter(s => s.trim()).length;

  // Remove any existing picker (defensive)
  const existing = document.getElementById('stripPickerOverlay');
  if (existing) existing.remove();

  const ov = document.createElement('div');
  ov.id = 'stripPickerOverlay';
  ov.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;'
    + 'background:rgba(0,0,0,0.85);z-index:10000;display:flex;'
    + 'align-items:center;justify-content:center;font-family:sans-serif;';

  const safeUrl = detectedUrl ? escH(detectedUrl) : '';
  const urlLine = detectedUrl
    ? '<span style="color:#8ef;">URL detected:</span> <span style="color:#ddd;font-size:12px;word-break:break-all;">' + safeUrl + '</span>'
    : '<span style="color:#fa6;">No URL detected — you\'ll be prompted</span>';

  ov.innerHTML =
    '<div style="background:#1a1a2e;border:2px solid #6af;border-radius:10px;'
    + 'padding:24px 28px;max-width:640px;width:92%;color:#ddd;'
    + 'box-shadow:0 8px 32px rgba(0,0,0,0.6);">'
    + '<h2 style="margin:0 0 6px;color:#8ef;font-weight:600;">Paste as Article</h2>'
    + '<div style="font-size:13px;color:#aaa;margin-bottom:6px;">'
    + rawText.length.toLocaleString() + ' chars · ' + lineCount + ' non-blank lines'
    + '</div>'
    + '<div style="font-size:13px;margin-bottom:18px;">' + urlLine + '</div>'
    + '<div style="display:flex;flex-direction:column;gap:10px;">'
    +   '<button data-mode="w" style="text-align:left;padding:14px 16px;'
    +     'background:#27293d;color:#ddd;border:1px solid #444;border-radius:6px;'
    +     'cursor:pointer;font-size:14px;">'
    +     '<span style="display:inline-block;min-width:36px;color:#8ef;font-weight:bold;">[W]</span>'
    +     '<span style="font-weight:600;">Strip + photos</span>'
    +     '<span style="color:#888;"> — strip chrome but keep image URLs as inline centered images</span>'
    +   '</button>'
    +   '<button data-mode="s" style="text-align:left;padding:14px 16px;'
    +     'background:#27293d;color:#ddd;border:1px solid #444;border-radius:6px;'
    +     'cursor:pointer;font-size:14px;">'
    +     '<span style="display:inline-block;min-width:36px;color:#8ef;font-weight:bold;">[S]</span>'
    +     '<span style="font-weight:600;">Strip, no photos</span>'
    +     '<span style="color:#888;"> — text only: ads, nav, captions, byline, related, photos</span>'
    +   '</button>'
    +   '<button data-mode="esc" style="text-align:left;padding:10px 16px;'
    +     'background:transparent;color:#888;border:1px solid #333;border-radius:6px;'
    +     'cursor:pointer;font-size:13px;margin-top:6px;">'
    +     '<span style="display:inline-block;min-width:36px;">[Esc]</span>'
    +     'Cancel'
    +   '</button>'
    + '</div>'
    + '</div>';

  document.body.appendChild(ov);

  // Hover effect via JS (avoid injecting <style>)
  ov.querySelectorAll('button[data-mode]').forEach(b => {
    if (b.dataset.mode === 'esc') return;
    b.addEventListener('mouseenter', () => { b.style.background = '#34374f'; b.style.borderColor = '#6af'; });
    b.addEventListener('mouseleave', () => { b.style.background = '#27293d'; b.style.borderColor = '#444'; });
  });

  function close(mode) {
    document.removeEventListener('keydown', keyHandler, true);
    ov.remove();
    if (mode === 'esc' || !mode) { toast('Paste cancelled', 1200); return; }
    _doPasteArticle(rawText, mode, detectedUrl);
  }

  function keyHandler(e) {
    const k = (e.key || '').toLowerCase();
    if (k === 'w' || k === 's') {
      e.preventDefault(); e.stopPropagation();
      close(k);
    } else if (k === 'escape') {
      e.preventDefault(); e.stopPropagation();
      close('esc');
    }
    // Note: 'a' is intentionally NOT handled here — it would conflict
    // with the Annotate-screen hotkey. To pick aggressive strip, use S.
  }
  document.addEventListener('keydown', keyHandler, true);

  ov.querySelectorAll('button[data-mode]').forEach(b => {
    b.addEventListener('click', () => close(b.dataset.mode));
  });

  // Click outside box to cancel
  ov.addEventListener('click', e => { if (e.target === ov) close('esc'); });
}

function _doPasteArticle(rawText, mode, detectedUrl) {
  let url = detectedUrl;
  if (!url) {
    url = (prompt('Enter the article URL (or leave blank):') || '').trim();
  }

  // (zip0171) Picker now offers W (strip + keep photos) or S (strip
  // without photos). Both apply the same aggressive newspaper-tuned
  // cleanup; W additionally preserves standalone image-URL lines and
  // renders them as inline centered <img> tags.
  let cleaned;
  if (mode === 'w')      cleaned = _articleAggressiveStrip(rawText, { keepImages: true });
  else if (mode === 's') cleaned = _articleAggressiveStrip(rawText, { keepImages: false });
  else if (mode === 'a') cleaned = _articleAggressiveStrip(rawText, { keepImages: false }); // legacy
  else                   cleaned = _articleAggressiveStrip(rawText, { keepImages: true });

  // (zip0168) Prepend the article URL as a clickable link at top of ftext.
  // The URL is stored in row.link too; having it visible as a link in the
  // slide gives the reader a way to click through to the original article.
  if (url) {
    const linkAttrs = ' target="_blank" rel="noopener" style="color:#5bf;word-break:break-all;"';
    cleaned = '<p><a href="' + url + '"' + linkAttrs + '>' + url + '</a></p>\n' + cleaned;
  }

  const now = isoNow();
  const row = {
    UID: nextUID(),
    link: url || '',
    show: '1',
    DateAdded: now,
    DateModified: now,
    ltype: 'w',
    ftext: cleaned,
    tags: []
  };
  data.push(row);
  save();
  if (typeof buildSort === 'function') { sortCol = 'DateAdded'; sortDir = 'desc'; buildSort(); }
  if (typeof render === 'function') render();
  const modeName = mode === 'w' ? 'with photos' : 'no photos';
  toast('✓ Added pasted article (' + modeName + ') · ' + cleaned.length.toLocaleString() + ' chars', 2400);
}

// ── Stripping processors ─────────────────────────────────────────────────────

// (zip0169) Pre-processor: fix soft-wrapped URLs in pasted text. Two
// patterns are common from email/text exports:
//   1. Bare URL wraps mid-path at a hyphen:
//        https://example.com/foo-bar-
//        baz.html
//      → https://example.com/foo-bar-baz.html
//   2. Angle-bracketed URL gains an internal space at the wrap point:
//        <https://example.com/foo- bar.html>
//      → <https://example.com/foo-bar.html>
// Both forms break URL detection and linkification. Apply this universally
// before any other processing or detection.
function _unwrapWrappedUrls(text) {
  if (!text) return text;
  // Pattern 2 first: collapse all whitespace inside <URL> annotations
  text = text.replace(/<(https?:\/\/[^>]+)>/g, (m, url) => {
    return '<' + url.replace(/\s+/g, '') + '>';
  });
  // Pattern 1: rejoin bare URLs split at a trailing hyphen
  // Allow optional trailing whitespace before the newline
  text = text.replace(/(https?:\/\/[^\s<>"]+-)\s*\n([^\s<>"]+)/g, '$1$2');
  return text;
}

// (zip0170) Find the article's own URL. Multi-strategy approach:
//
//   Strategy 1 (most reliable): if "Share full article" or "reporter
//   headshot" appears in the text, take the LAST URL before that marker.
//   These chrome lines bracket the article header in NYT-style pastes,
//   and the article URL is reliably the last URL above them.
//
//   Strategy 2 (newspaper-generic): prefer URLs with a date path like
//   /YYYY/MM/DD/ or /YYYY-MM-DD/. Article URLs at almost every newspaper
//   include a publication date in the path (NYT, WaPo, Guardian, BBC
//   feature, Bloomberg, Atlantic, etc.). Take the longest such URL.
//
//   Strategy 3 (fallback): skip obvious nav URLs (/section/, /by/,
//   homepage, /subscription/, etc.), take the longest remaining URL.
//
//   Strategy 4 (last resort): first URL anywhere.
//
// Each strategy is per-newspaper-pattern conservative — works for sites
// where the chrome marker is absent (BBC News, evergreen articles, etc.)
// without false-positive on nav URLs.
function _detectArticleUrl(text) {
  // Collect all URLs with positions, in document order
  const allUrls = [];
  const urlRe = /https?:\/\/[^\s<>"]+/g;
  let mm;
  while ((mm = urlRe.exec(text)) !== null) {
    // Trim trailing punctuation that's likely sentence/paragraph end
    let url = mm[0].replace(/[.,;:!?)]+$/, '');
    allUrls.push({ url: url, pos: mm.index });
  }
  if (!allUrls.length) return '';

  // Strategy 1: chrome-marker bracketing. "Share full article" is a NYT
  // share-button label, "reporter headshot" is the alt-text of the
  // author photo block. Either appears RIGHT AFTER the article URL line
  // in NYT-style pastes.
  const markers = [
    /Share full article/i,
    /reporter headshot/i
  ];
  let cutAt = Infinity;
  for (const re of markers) {
    const m = text.match(re);
    if (m && m.index !== undefined && m.index < cutAt) cutAt = m.index;
  }
  if (cutAt !== Infinity) {
    const before = allUrls.filter(u => u.pos < cutAt);
    if (before.length) return before[before.length - 1].url;
  }

  // Strategy 2: URLs with date in path. /2025/10/29/ (NYT/WaPo/etc) or
  // /2025-10-29/ (Bloomberg) or /2025/oct/29/ (Guardian — text month).
  const dateRe = /\/(19|20)\d{2}[\/\-]/;
  const dated = allUrls.filter(u => dateRe.test(u.url));
  if (dated.length) {
    return dated.sort((a, b) => b.url.length - a.url.length)[0].url;
  }

  // Strategy 3: skip obvious nav URLs, take longest non-nav URL with
  // meaningful path content.
  const navRe = /\/(section|topic|spotlight|category|categories|by|author|authors|people|profile|contributors?|subscription|subscribe|account|gift|todayspaper|todays?-paper|search|login|signin|signup|register|home|tag|tags|tagged|crosswords|games|jobs|wirecutter|store|help|sitemap|trending|video|audio|podcasts|newsletters|cooking|athletic|wirecutter)\b/i;
  const nonNav = allUrls.filter(u => !navRe.test(u.url));
  const longNonNav = nonNav.filter(u =>
    u.url.replace(/^https?:\/\/[^\/]+/, '').length > 5
  );
  if (longNonNav.length) {
    return longNonNav.sort((a, b) => b.url.length - a.url.length)[0].url;
  }
  if (nonNav.length) {
    return nonNav.sort((a, b) => b.url.length - a.url.length)[0].url;
  }

  // Strategy 4: anything
  return allUrls[0].url;
}

// (zip0168) Render-time linkifier. Converts plain-text URL patterns inside
// ftext to clickable <a> tags. Used in both:
//   • Storage time — _textToParagraphs runs this on freshly-pasted articles
//     so the saved ftext has anchors baked in.
//   • Render time — Xs slide views (grid.js, vp.js, xe.js) call renderFtext()
//     before injecting ftext into the DOM, so existing ftext content also
//     gets URLs linkified at display.
//
// Patterns handled:
//   • <https://...>  (markdown angle-bracket form, common from email/text exports)
//   • &lt;https://...&gt;  (the same after HTML escaping)
//   • Bare URLs in text (with whitespace/punctuation boundaries)
//
// Skips:
//   • URLs already inside <a>...</a>
//   • URLs inside other tags' attributes (e.g. <img src="...">)
//
// Implementation: tokenize the HTML into anchors / tags / text, only
// touch text segments. This avoids the classic "linkifier ate my image
// src" bug.
function renderFtext(ftext) {
  if (!ftext) return '';
  return _linkifyHtml(ftext);
}

// (dev0278) ftext size / junk readout. "Junk" = bytes a cleanup would strip
// (inline style/class, data-*/js*/aria-* attrs, framework custom elements,
// empty div/span wrappers). Image src/href URLs are NOT counted as junk —
// they're real content/data — so galleries and link lists aren't false-flagged.
// Pure regex (no DOM) so it's cheap enough to run over every row on save.
function ftextStats(html) {
  html = html || '';
  const bytes = html.length;
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ').trim().length;
  // Exclude <img …> so image sizing-styles + src URLs don't count as junk.
  const scan = html.replace(/<img\b[^>]*>/gi, '');
  let junk = 0;
  for (const m of scan.matchAll(/\sstyle="[^"]*"/gi)) junk += m[0].length;
  for (const m of scan.matchAll(/\sclass="([^"]*)"/gi)) {
    const c = (m[1] || '').trim();
    if (c !== 'te-cut' && c !== 'te-slide') junk += m[0].length;
  }
  for (const m of scan.matchAll(/\s(?:data-[\w-]+|js[a-z]+|aria-[\w-]+)="[^"]*"/gi)) junk += m[0].length;
  for (const m of scan.matchAll(/<(div|span)>\s*<\/\1>/gi)) junk += m[0].length;
  for (const m of scan.matchAll(/<\/?[a-z][a-z0-9]*-[a-z0-9-]+[^>]*>/gi)) junk += m[0].length;
  if (junk > bytes) junk = bytes;
  return {
    bytes,
    text,
    textPct: bytes ? Math.round(100 * text / bytes) : 0,
    junkBytes: junk,
    junkPct: bytes ? Math.round(100 * junk / bytes) : 0
  };
}
window.ftextStats = ftextStats;

// (dev0341) Clean rich clipboard HTML down to the small semantic subset used by
// ftext slides. Mirrors the junk model in ftextStats(): drops <style>/<script>,
// inline style=/class=/data-*/aria-* attrs, span/div soup, and custom
// (hyphenated framework) tags — keeping only headings, paragraphs, lists, links,
// emphasis, images, and <details>. DOM-based (DOMParser) so nested-quote tricks
// can't fool it the way a regex would. Used by W-paste and the Xe paste handler.
function _sanitizePastedHtml(html) {
  if (!html) return '';
  let doc;
  try { doc = new DOMParser().parseFromString(html, 'text/html'); }
  catch (e) { return ''; }
  const body = doc && doc.body;
  if (!body) return '';

  // Remove whole-subtree noise and comment nodes.
  body.querySelectorAll('style,script,meta,link,title,noscript').forEach(n => n.remove());
  const tw = doc.createTreeWalker(body, NodeFilter.SHOW_COMMENT, null);
  const comments = [];
  while (tw.nextNode()) comments.push(tw.currentNode);
  comments.forEach(c => c.remove());

  const KEEP = new Set(['H1','H2','H3','H4','H5','H6','P','UL','OL','LI','A',
    'STRONG','B','EM','I','U','BR','IMG','BLOCKQUOTE','DIV','SMALL',
    'DETAILS','SUMMARY']);

  // Depth-first: unwrap disallowed tags (keep their children); strip attrs on
  // kept tags. Static list because we mutate the tree as we go.
  const all = Array.from(body.querySelectorAll('*'));
  for (const el of all) {
    const tag = el.tagName;
    if (!KEEP.has(tag)) {
      const parent = el.parentNode;
      if (!parent) continue;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const keep = (tag === 'A' && name === 'href') ||
                   (tag === 'IMG' && (name === 'src' || name === 'alt'));
      if (!keep) el.removeAttribute(attr.name);
    }
    if (tag === 'A' && el.getAttribute('href')) {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener');
    }
  }

  // Drop now-empty wrappers (no text, no media). Repeat until stable so
  // <div><div></div></div> fully collapses.
  let changed = true;
  while (changed) {
    changed = false;
    body.querySelectorAll('div,span,p').forEach(el => {
      if (el.querySelector('img,br,details,a,ul,ol')) return;
      if (el.textContent.trim()) return;
      el.remove(); changed = true;
    });
  }

  const out = body.innerHTML.trim();
  return typeof _linkifyHtml === 'function' ? _linkifyHtml(out) : out;
}

// (dev0341) Plain-text -> minimal HTML preserving every line break as its own
// line (one <div> per line, <div><br></div> for blanks — the contenteditable
// line model). W-paste fallback when the clipboard carries no text/html.
function _textToLineHtml(txt) {
  if (!txt) return '';
  return txt.split(/\r?\n/).map(line => {
    const t = line.trim();
    return t ? '<div>' + escH(t) + '</div>' : '<div><br></div>';
  }).join('');
}


function _linkifyHtml(html) {
  if (!html) return '';
  return html.replace(/(<a\b[^>]*>[\s\S]*?<\/a>)|(<[^>]+>)|([^<]+)/gi,
    (match, anchor, tag, text) => {
      if (anchor !== undefined) return anchor;
      if (tag !== undefined) return tag;
      if (text !== undefined) return _linkifyTextSegment(text);
      return match;
    });
}

function _linkifyTextSegment(text) {
  if (!text || !/https?:\/\//.test(text)) return text;
  const linkAttrs = ' target="_blank" rel="noopener" style="color:#5bf;word-break:break-all;"';
  // 1. Already-escaped <URL> (from HTML-escaped paste content)
  let s = text.replace(/&lt;(https?:\/\/[^&\s<>]+?)&gt;/g, (m, url) => {
    return '<a href="' + url + '"' + linkAttrs + '>' + url + '</a>';
  });
  // 2. Raw <URL> in text (defensive — shouldn't normally hit a text segment)
  s = s.replace(/<(https?:\/\/[^\s<>]+?)>/g, (m, url) => {
    return '<a href="' + url + '"' + linkAttrs + '>' + url + '</a>';
  });
  // 3. Bare URLs — boundary at start-of-string or after whitespace/punctuation
  s = s.replace(/(^|[\s(\[{])(https?:\/\/[^\s<>"()\[\]{}]+[^\s<>"()\[\]{}.,;!?])/g,
    (m, pre, url) => {
      return pre + '<a href="' + url + '"' + linkAttrs + '>' + url + '</a>';
    });
  return s;
}

// Common: convert paragraph-broken plain text to HTML <p> blocks.
// (zip0168) Also linkifies URL patterns after HTML-escaping so anchors
// are baked into the saved ftext.
// (zip0171) Paragraphs containing only an image URL are rendered as a
// centered medium-size <img> instead of a <p>. The strip pipeline must
// be run with keepImages=true for image URLs to survive to this point.
function _textToParagraphs(text) {
  const paras = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  return paras.map(p => {
    // Collapse single newlines within a paragraph to spaces
    const flat = p.replace(/\s*\n\s*/g, ' ').trim();
    // Image-URL-only paragraph → centered inline img
    if (_isStandaloneImageUrl(flat)) {
      const url = _extractImageUrl(flat);
      return '<p style="text-align:center;margin:14px 0;">'
        + '<img src="' + url + '" alt="" '
        + 'style="max-width:60%;max-height:70vh;height:auto;border-radius:4px;'
        + 'box-shadow:0 2px 8px rgba(0,0,0,0.3);">'
        + '</p>';
    }
    return '<p>' + _linkifyTextSegment(escH(flat)) + '</p>';
  }).join('\n');
}

// (W) No stripping — wrap verbatim in <p> tags. Preserves all junk.
// (zip0169) But still unwraps soft-wrapped URLs so they become clickable.
// "No stripping" means no content removal, not "leave URLs broken."
function _articleNoStrip(text) {
  return _textToParagraphs(_unwrapWrappedUrls(text));
}

// (S) Some stripping — remove obvious chrome that almost nobody wants:
//   • Browser/site nav: "Skip to ...", "Section Navigation", "Search", "Account"
//   • Ad markers: "Advertisement", "SKIP ADVERTISEMENT", "Supported by"
//   • Share UI: "Share full article", "reporter headshot"
//   • Standalone digit lines (comment counts)
//   • Standalone "Image" markers
//   • Inline <https://...> markdown link annotations within paragraphs
//   • Standalone <https://...> URL lines (except the article URL on its own line)
//   • Horizontal-rule lines (----)
//   • "GIVE THE TIMES" lines
//   • Date-only header lines (e.g. "Tuesday, May 5, 2026")
//   • Cut from end markers: "A version of this article appears in print",
//     "Site Index", "Site Information"
function _articleSomeStrip(text, opts) {
  opts = opts || {};
  let s = _unwrapWrappedUrls(text);
  // (zip0168) Don't strip inline <URL> annotations anymore — they're
  // converted to clickable <a> tags during _textToParagraphs / render.

  // Cut at end markers (first match wins)
  s = _cutAtEndMarkers(s, [
    /^A version of this article appears in print/im,
    /^Site Index\s*$/im,
    /^Site Information Navigation\s*$/im,
    /^©\s*\d{4}\s+The New York Times Company/im
  ]);

  // Per-line filtering. Strip leading markdown bullet markers first so
  // chrome lines like "* reporter headshot" can match the junk patterns.
  const lines = s.split(/\r?\n/);
  const out = [];
  for (let raw of lines) {
    let ln = raw.trim();
    if (!ln) { out.push(''); continue; } // preserve paragraph breaks
    // Strip leading "* " / "- " / "• " bullet markers (one or more)
    ln = ln.replace(/^([\*\-\u2022]+\s*)+/, '');
    if (!ln) continue; // line was JUST bullets
    if (_isJunkLineSome(ln, opts)) continue;
    out.push(ln);
  }
  // Collapse 3+ blank lines to 2
  let cleaned = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return _textToParagraphs(cleaned);
}

function _isJunkLineSome(ln, opts) {
  opts = opts || {};
  // (zip0171) When keepImages is set, standalone image-URL lines pass
  // through unfiltered so _textToParagraphs can render them as <img>.
  if (opts.keepImages && _isStandaloneImageUrl(ln)) return false;
  // Markdown bullet residue (lines that are just *, **, * *, etc.)
  if (/^[\*\-\u2022]+\s*$/.test(ln)) return true;
  // After leading-bullet strip below, common chrome lines
  // Site chrome / nav
  if (/^Skip to\b/i.test(ln)) return true;
  if (/^Section Navigation\s*$/i.test(ln)) return true;
  if (/^Search\s*$/i.test(ln)) return true;
  if (/^Search\s*&\s*Section Navigation\s*$/i.test(ln)) return true;
  if (/^Account\s*$/i.test(ln)) return true;
  // (zip0171) Both apostrophe variants: ASCII ' (U+0027) and curly ' (U+2019)
  if (/^Today['\u2019\u2018]s Paper\b/i.test(ln)) return true;
  if (/^GIVE THE TIMES\b/i.test(ln)) return true;
  // Ads — broaden to allow trailing anchor refs like "<#after-top>"
  if (/^Advertisement\b/i.test(ln)) return true;
  if (/^SKIP ADVERTISEMENT\b/i.test(ln)) return true;
  if (/^Supported by\s*$/i.test(ln)) return true;
  // Share UI
  if (/^Share full article\s*$/i.test(ln)) return true;
  if (/^reporter headshot\s*$/i.test(ln)) return true;
  // Image markers
  if (/^Image\s*$/i.test(ln)) return true;
  // Standalone digit lines (comment counts)
  if (/^\d{1,5}\s*$/.test(ln)) return true;
  // Horizontal rules
  if (/^[-*_]{3,}\s*$/.test(ln)) return true;
  // Standalone URL line (residual after annotation strip)
  if (/^<?https?:\/\/\S+>?\s*$/i.test(ln)) return true;
  // Bare day-date headers like "Tuesday, May 5, 2026"
  if (/^(Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day,\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2},\s*\d{4}\s*$/i.test(ln)) return true;
  return false;
}

// (zip0171) Recognize a line that's nothing but an image URL (with optional
// surrounding angle brackets). Used by W mode to preserve image URLs as
// inline <img> tags rather than filtering them out as junk.
function _isStandaloneImageUrl(ln) {
  if (!ln) return false;
  const t = ln.trim().replace(/^<+|>+$/g, '');
  if (!/^https?:\/\/\S+$/.test(t)) return false;
  return /\.(jpg|jpeg|png|gif|webp|svg|avif|bmp)(\?|#|$)/i.test(t);
}

// (zip0171) Extract the URL from a standalone image-URL line.
function _extractImageUrl(ln) {
  return ln.trim().replace(/^<+|>+$/g, '');
}

// (A) Aggressive — Some + newspaper-tuned removals:
//   • Photo captions (lines/paragraphs containing "Credit..." or "Credit:")
//   • Author byline ("By Name")
//   • Publication date stamps ("Published ...Updated ...")
//   • Bilingual coverage notices
//   • Mid-article "Editors' Picks" promo block (cut from heading to next ad)
//   • Author bio paragraph (typically near end: "Author covers... for The Times")
//   • Read-more / related-content footers: cut from FIRST occurrence of
//     "Discover More in", "Related Content", "More in [Section]",
//     "Trending in", "Read NN comments"
function _articleAggressiveStrip(text, opts) {
  opts = opts || {};
  let s = _unwrapWrappedUrls(text);

  // (zip0168) Don't strip inline <URL> annotations anymore — they're
  // converted to clickable <a> tags during _textToParagraphs / render.

  // Cut at end markers (try each, take earliest hit)
  s = _cutAtEndMarkers(s, [
    /^A version of this article appears in print/im,
    /^Discover More in\b/im,
    /^Related Content\s*$/im,
    /^More in\s+\S/im,
    /^Trending in\b/im,
    /^Editors[''\u2018\u2019]?\s*Picks\s*$/im, // footer one — but mid-article one removed below first
    /^Read\s+\d[\d,]*\s+comments?\s*$/im,
    /^Site Index\s*$/im,
    /^Site Information/im,
    /^©\s*\d{4}\s+The New York Times/im
  ]);

  // Remove mid-article "Editors' Picks" block: from heading to next
  // "Advertisement" or "SKIP ADVERTISEMENT" within ~30 lines.
  s = _cutMidArticleEditorsPicks(s);

  // Per-line and per-paragraph filtering. Strip leading markdown bullet
  // markers first so chrome lines like "* reporter headshot" can match.
  // (zip0171) When keepImages is set, standalone image-URL lines pass
  // through to _textToParagraphs for rendering as inline <img> tags.
  const lines = s.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let ln = lines[i].trim();
    if (!ln) { out.push(''); continue; }
    ln = ln.replace(/^([\*\-\u2022]+\s*)+/, '');
    if (!ln) continue;
    if (_isJunkLineSome(ln, opts)) continue;
    if (_isJunkLineAggressive(ln)) continue;
    out.push(ln);
  }

  // Strip caption paragraphs (any paragraph containing "Credit..."/"Credit:")
  // and author-bio paragraphs (zip0172): the paragraph that says
  // "Author covers X for The Times and writes the Y column." It typically:
  //   • contains "for The (New York) Times"
  //   • contains "covers" or "writes" in a biographical context
  //   • links to a /column/ or /by/ URL
  // We catch either of two conditions independently (OR logic) to be robust
  // even if the paragraph is soft-wrapped and the URL lands on a different line.
  let body = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  body = body.split(/\n{2,}/)
    .filter(p => {
      if (/Credit\s*[.:]{1,3}\s*\S/i.test(p)) return false;
      // Author bio: "covers ... for The Times"
      if (/covers\b[^.]{0,120}for The (New York )?Times\b/i.test(p)) return false;
      // Author bio: paragraph mentioning "for The Times" AND a /column/ or /by/ URL
      if (/for The (New York )?Times\b/i.test(p) && /\/(column|by|author)\//i.test(p)) return false;
      return true;
    })
    .join('\n\n');

  return _textToParagraphs(body);
}

function _isJunkLineAggressive(ln) {
  // Byline "By <Author>" — match even if a trailing URL annotation or
  // date follows on the same line (e.g. "By Carl Zimmer <https://...>")
  if (/^By\s+[A-Z][\w'-]+(\s+[A-Z][\w'-]+){1,3}\b/.test(ln)) return true;
  // Author-headshot pattern: "<Name> <URL containing /by/ or /author/>"
  // The URL path differs per site but these are common conventions.
  if (/^[A-Z][\w'-]+(\s+[A-Z][\w'-]+){1,3}\s+<https?:\/\/[^>]*\/(by|author|authors|people|profile|contributors?)\b/i.test(ln)) return true;
  // Section/topic header: "<Section> <URL containing /section/ or /topic/>"
  if (/^[A-Z][\w'-]+(\s+[A-Z][\w'-]+){0,2}\s+<https?:\/\/[^>]*\/(section|topic|spotlight|category|categories)\b/i.test(ln)) return true;
  // Date stamps: "Published Oct. 29, 2025Updated Nov. 17, 2025"
  if (/^Published\s+\w+\.?\s+\d{1,2},?\s*\d{4}/i.test(ln)) return true;
  if (/^Updated\s+\w+\.?\s+\d{1,2},?\s*\d{4}/i.test(ln)) return true;
  // NYT bilingual coverage notice — match anywhere in line (not anchored).
  // The notice is one long run-on line that soft-wraps at ~80 chars, so
  // we need patterns for EACH fragment that could land on its own line:
  //   Frag 1: "See more of our coverage in your search results.Encuentra..."
  //   Frag 2: "cobertura en los resultados de búsqueda. Add The New York Times on"
  //   Frag 3: "GoogleAgrega The New York Times en Google<URL>"
  if (/See more of our coverage in your search results/i.test(ln)) return true;
  if (/Encuentra m[aá]s de nuestra cobertura/i.test(ln)) return true;   // frag 1 w/ Spanish
  if (/cobertura en los resultados/i.test(ln)) return true;              // frag 2 start
  if (/Add The New York Times on Google/i.test(ln)) return true;         // frag 2 end / frag 3
  if (/GoogleAgrega\b/.test(ln)) return true;                            // frag 3 (smushed)
  if (/Agrega\s+The\s+New\s+York\s+Times/i.test(ln)) return true;       // frag 3 variant
  // Section name pipe-prefix (e.g. "Science|Life Lessons From...")
  if (/^[A-Z][a-z]+\|/.test(ln)) return true;
  return false;
}

function _cutAtEndMarkers(text, regexList) {
  let earliest = -1;
  for (const re of regexList) {
    const m = text.match(re);
    if (m && m.index !== undefined) {
      if (earliest === -1 || m.index < earliest) earliest = m.index;
    }
  }
  if (earliest >= 0) return text.slice(0, earliest).trim();
  return text;
}

function _cutMidArticleEditorsPicks(text) {
  const lines = text.split(/\r?\n/);
  // Find FIRST "Editors' Picks" line. Then look ahead up to 40 lines for
  // "Advertisement" / "SKIP ADVERTISEMENT". If found, splice out.
  const epRe = /^Editors[''’]?\s*Picks\s*$/i;
  const adRe = /^(Advertisement|SKIP ADVERTISEMENT)\s*$/i;
  for (let i = 0; i < lines.length; i++) {
    if (epRe.test(lines[i].trim())) {
      // Look forward
      for (let j = i + 1; j < Math.min(i + 40, lines.length); j++) {
        if (adRe.test(lines[j].trim())) {
          // Splice out [i..j], keep i (before) and j+1+ (after). But also drop
          // the SKIP ADVERTISEMENT/Advertisement run that follows.
          let endCut = j + 1;
          while (endCut < lines.length && /^(Advertisement|SKIP ADVERTISEMENT|Supported by|\s*)$/i.test(lines[endCut].trim())) {
            endCut++;
          }
          lines.splice(i, endCut - i);
          break;
        }
      }
      break;
    }
  }
  return lines.join('\n');
}

// Rule 1 implementation. `lines` is the already-split, trimmed, non-empty
// array — every entry must be a media URL.
async function _importBareLinks(lines) {
  // Normalize (YouTube → youtu.be/<id>) then de-dup within paste
  const seen = new Set();
  const links = [];
  for (const line of lines) {
    const norm = _normalizeLink(line);
    if (!seen.has(norm)) { seen.add(norm); links.push(norm); }
  }

  const now = isoNow();
  let added = 0;
  const dupRecords = [];
  const newRows = [];

  // (zip0129) Build O(1) lookup of existing rows by link. With Set this is
  // ~constant per check; the build itself is O(N) where N = data.length.
  // For 100K rows × 100 import lines: build ~5–15ms, total check ~5–15ms.
  // See chat: scaling discussion.
  const linkToDi = new Map();
  data.forEach((r, di) => {
    if (r && r.link) linkToDi.set(String(r.link).trim(), di);
  });

  // Build a fresh row from a media link. Used for genuinely new links and,
  // when the user opts to "add anyway", for links that duplicate an existing
  // row.
  // (zip0151) Default Mute='0' for video links added via W clipboard import.
  // Rationale: most YouTube/Vimeo videos have useful audio (the user's main
  // reason for collecting them); the user is opt-in to Mute='1' for obnoxious
  // or low-value soundtracks via the E-screen mute-toggle button. Non-video
  // rows leave Mute unset so the field stays empty (Clean Mute Column
  // maintains this).
  const makeRow = (link) => {
    const row = {
      UID: nextUID(),
      link: link,
      show: '1',
      DateAdded: now,
      DateModified: now,
      tags: []
    };
    const cls = _classifyUrl(link);
    if (cls === 'video') {
      row.Mute = '0';
    } else if (cls === 'image') {
      row.VidRange = 'i';
    } else if (cls === 'web') {
      // (zip0166) Web (article) URL — mark with ltype='w' so the row is
      // recognizable as a web-text row. ftext is fetched asynchronously
      // below (after the row is added) so the import doesn't block.
      row.ltype = 'w';
    }
    return row;
  };

  const dupLinks = []; // links already present in data (pending user choice)

  for (const link of links) {
    if (linkToDi.has(link)) {
      const di = linkToDi.get(link);
      const r = data[di];
      dupRecords.push({
        UID: r ? r.UID : '',
        link: link,
        title: r ? (r.VidTitle || '') : ''
      });
      dupLinks.push(link);
      continue;
    }
    const row = makeRow(link);
    data.push(row);
    newRows.push(row);
    linkToDi.set(link, data.length - 1);
    added++;
  }

  // Duplicate handling: rather than silently rejecting links that already
  // exist, warn the user and let them choose. OK = add them as new rows
  // anyway; Cancel = send them to the duplicates pile (duplicateTries.txt)
  // and focus the first existing match — the previous always-reject behavior.
  let dupsAdded = 0;
  if (dupRecords.length) {
    const preview = dupRecords.slice(0, 12).map(dRec =>
      '• ' + dRec.link + (dRec.title ? '  (' + dRec.title + ')' : '')
    ).join('\n');
    const more = dupRecords.length > 12
      ? '\n…and ' + (dupRecords.length - 12) + ' more' : '';
    const addAnyway = confirm(
      dupRecords.length + ' link(s) already exist in your data:\n\n'
      + preview + more
      + '\n\nOK = add them as new rows anyway'
      + '\nCancel = send to duplicates pile (duplicateTries.txt)'
    );
    if (addAnyway) {
      for (const link of dupLinks) {
        const row = makeRow(link);
        data.push(row);
        newRows.push(row);
        linkToDi.set(link, data.length - 1);
        added++;
        dupsAdded++;
      }
      dupRecords.length = 0; // resolved — these became real rows
    } else {
      await _writeDuplicateLinksReport(dupRecords, 'bare-links paste');
    }
  }

  if (!added) {
    toast('All ' + links.length + ' link(s) already in data — sent to duplicates pile (duplicateTries.txt)', 2500);
    return;
  }

  save();
  sortCol = 'DateAdded';
  sortDir = 'desc';
  buildSort();
  render();

  // Kick off async metadata fetch for new rows (title/author/Mpix/P/S).
  // Also kick off web-text fetch for article rows.
  _fetchMetaForNewRows(newRows);
  // (dev0425) Route yt-dlp-supported providers (IG/YouTube/Vimeo/TikTok) through
  // the proxy yt-dlp bridge for caption (ftext) + @author; the rest still use the
  // r.jina.ai reader path. (Instagram now login-walls jina, so yt-dlp owns it.)
  const ytRows = newRows.filter(r => r && r.link && _ytdlpSupports(r.link));
  if (ytRows.length) _fetchYtdlpMetaForNewRows(ytRows);
  const webRows = data.filter(r => r && r.ltype === 'w' && !r.ftext && r.DateAdded === now && !_ytdlpSupports(r.link));
  if (webRows.length) _fetchWebTextForRows(webRows);

  const dupNote    = dupRecords.length ? '\n   ' + dupRecords.length + ' duplicate(s) → duplicateTries.txt' : '';
  const dupAddedNote = dupsAdded ? '\n   ' + dupsAdded + ' duplicate(s) added anyway' : '';
  const dupInPaste = links.length - added - dupRecords.length;
  const pasteDupNote = dupInPaste > 0 ? '\n   ' + dupInPaste + ' duplicates within paste removed' : '';
  const ytNote   = ytRows.length ? '\n   ' + ytRows.length + ' video link(s) — yt-dlp caption/author…' : '';
  const webNote  = webRows.length ? '\n   ' + webRows.length + ' web URL(s) — fetching text…' : '';
  const metaNote = newRows.some(r => !r.ltype) ? '\n   fetching metadata…' : '';
  toast(
    '✓ Added ' + added + ' bare link' + (added === 1 ? '' : 's')
    + dupNote + dupAddedNote + pasteDupNote + ytNote + webNote + metaNote,
    3500
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// WEB-ARTICLE FETCH + EXTRACT (zip0166)
// ══════════════════════════════════════════════════════════════════════════════
// For ltype='w' rows, fetch the page and extract the main article text into
// ftext. Strategy:
//   1. Try r.jina.ai (free reader service): server-side fetch, returns clean
//      markdown of main content with sidebars/nav/captions/related-links
//      stripped. Avoids browser CORS issues. No API key needed for moderate
//      use. Output is markdown — we convert to simple HTML for the editor.
//   2. If that fails (offline, blocked, rate-limited), try direct fetch with
//      a basic article-extraction heuristic (longest concentration of <p>
//      tags). This will fail on most sites due to CORS — that's expected,
//      jina is the primary path.
// Each row is processed independently so one failure doesn't block others.
// Save is called once per successful fetch (so the user sees progress).

// ══════════════════════════════════════════════════════════════════════════════
// yt-dlp METADATA FETCH (dev0425)
// ══════════════════════════════════════════════════════════════════════════════
// r.jina.ai now hits Instagram (and other) login walls, so DownloadRules._instagram
// bails out to a bare-link stub (the "UID 770 has text / 1150 doesn't" report).
// yt-dlp reads caption + author straight from the provider with no login, so for
// every provider yt-dlp supports (IG/YouTube/Vimeo/TikTok…) we fetch metadata via
// the origin-locked proxy bridge (POST /exec/ytdlp) and populate ftext + VidAuthor.
// Local-dev only: the proxy is 127.0.0.1:8081, unreachable from the live site
// (fine — imports happen on the dev T screen). Falls back to r.jina.ai per-row.

const _YTDLP_PROXY = 'http://127.0.0.1:8081';

// Which links yt-dlp should own on import. Mirrors the embed-provider helpers in
// video.js, with a regex fallback in case they haven't loaded yet.
function _ytdlpSupports(url) {
  if (!url) return false;
  if (window.isInstagramLink && window.isInstagramLink(url)) return true;
  if (window.isYouTubeLink   && window.isYouTubeLink(url))   return true;
  if (window.isVimeoLink     && window.isVimeoLink(url))     return true;
  if (window.isTikTokLink    && window.isTikTokLink(url))    return true;
  return /instagram\.com|youtu\.be|youtube\.com|vimeo\.com|tiktok\.com/i.test(url);
}

// POST the URL to the proxy's yt-dlp bridge; resolve the parsed metadata object
// ({id,title,description,uploader,uploader_id,channel,…}) or throw.
async function _ytdlpFetchMeta(url) {
  const res = await fetchWithTimeout(_YTDLP_PROXY + '/exec/ytdlp', 45000, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  });
  if (!res || !res.ok) throw new Error('proxy HTTP ' + (res && res.status));
  const j = await res.json();
  if (!j || !j.ok || !j.result) {
    throw new Error((j && (j.stderr || j.error)) || ('yt-dlp exit ' + (j && j.exitCode)));
  }
  // (dev0442) Surface whether the proxy needed Firefox cookies (login wall) so the
  // caller can report cookie usage. Non-enumerable → doesn't leak into row fields.
  try { Object.defineProperty(j.result, '_usedCookies', { value: !!j.usedCookies, enumerable: false }); }
  catch (_) {}
  return j.result;
}

// Derive a "@handle" from yt-dlp metadata. YouTube's uploader_id is already
// "@handle"; Instagram's channel is the bare handle slug (uploader_id is numeric);
// fall back to a display name when no slug is available.
function _ytdlpAuthorHandle(meta) {
  for (const c of [meta.uploader_id, meta.channel, meta.uploader]) {
    const s = (c || '').trim();
    if (/^@[\w.]+$/.test(s)) return s;
  }
  for (const c of [meta.channel, meta.uploader_id]) {
    const s = (c || '').trim();
    if (s && /^[\w.]+$/.test(s) && !/^\d+$/.test(s)) return '@' + s;
  }
  return (meta.uploader || meta.channel || '').trim();
}

// ── IG/video title cleaning (dev0426) ──────────────────────────────────────
// Ports AHK NormalizeText (M:\jjj\AHK\ytdl_v26.ahk:868) to JS, "better": NFKD
// de-accent (é→e) BEFORE stripping the remaining non-ASCII (emoji/CJK), so Latin
// names survive. Fixes captions whose first line carries trailing emoji (UID 1148
// = "Microscopic landscapes vol. 8 🦠🔬🌄"). Keeps newlines (first-line logic needs them).
function _normalizeText(s) {
  if (s == null) return '';
  s = String(s)
    .replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/\u2013/g, '-').replace(/[\u2014\u2015]/g, '--')
    .replace(/\u2026/g, '...')
    .replace(/[\u00A0\u202F\u2009]/g, ' ').replace(/\u200B/g, '');
  s = s.normalize('NFKD').replace(/[\u0300-\u036F]/g, '');     // strip combining accents
  s = s.replace(/[^\x00-\x7E]/g, '');                          // drop emoji / non-ASCII
  s = s.replace(/[ \t\f\v]+/g, ' ')
       .replace(/ +([,.;:!?)])/g, '$1')                        // close gap left by stripped emoji
       .replace(/ *\n */g, '\n');                              // tidy ws, keep newlines
  return s.trim();
}

// Word-frequency list (commonwords.txt, ~10k words ordered by rank) — lazy-loaded
// ONCE on first title derivation (a dev import action), so normal page loads pay
// nothing. Map word→rank; absent = rarest. Used to find the low-frequency word
// (likely an organism / Latin / scientific name) a title should reach.
let _commonRankMap = null, _commonWordsPromise = null;
function _ensureCommonWords() {
  if (_commonRankMap) return Promise.resolve(_commonRankMap);
  if (_commonWordsPromise) return _commonWordsPromise;
  const ver = (window.HELP_VERSION_STR || '').replace(/^(dev|user)/, '');
  _commonWordsPromise = fetch('commonwords.txt?v=' + ver)
    .then(r => r.ok ? r.text() : '')
    .then(txt => {
      const m = new Map();
      txt.split(/\r?\n/).forEach((w, i) => { w = w.trim(); if (w && !m.has(w)) m.set(w, i); });
      _commonRankMap = m;
      return m;
    })
    .catch(() => { _commonRankMap = new Map(); return _commonRankMap; });
  return _commonWordsPromise;
}
function _commonRank(word) {
  if (!_commonRankMap) return -1;
  const r = _commonRankMap.get(String(word).toLowerCase());
  return (r == null) ? -1 : r;
}

// Derive a short clean VidTitle from a caption:
//   1. normalize (de-accent + strip emoji), take the first non-empty line, drop a
//      trailing #hashtag run — IG authors usually lead with a title line.
//   2. if that's already short (≤ SOFT), use it.
//   3. else scan words within HARD chars for the LAST low-frequency word
//      (rank ≥ RARE or absent — likely the organism/scientific name) and end the
//      title a couple words past it; trailing stop-words/punct trimmed.
//   4. graceful: no rare word → word-boundary cut at SOFT; empty caption → ''
//      (and a generic caption like "Microscopic landscapes vol. 8" is kept as-is).
function _smartIgTitle(caption) {
  const SOFT = 70, HARD = 120, EXTRA = 2, RARE = 2500;
  const s = _normalizeText(caption);
  if (!s) return '';
  let firstLine = '';
  for (const ln of s.split('\n')) { if (ln.trim()) { firstLine = ln.trim(); break; } }
  const stripTags = x => x.replace(/(?:\s*#[A-Za-z0-9_]+)+\s*$/, '').trim();
  const clean = x => x.replace(/[\s\-:;,.]+$/, '').trim();
  const stripTailStop = x => x.replace(/\s+(the|a|an|of|and|to|in|for|with|its|their|on|by|as|is|are|was|this|that|my|so|but|or|at)$/i, '').trim();
  let base = stripTags(firstLine);
  if (!base) base = stripTags(s.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim());
  if (!base) return '';
  if (base.length <= SOFT) return clean(base);

  const words = base.split(/\s+/);
  const ends = []; let cum = 0;
  for (let i = 0; i < words.length; i++) { cum += (i ? 1 : 0) + words[i].length; ends[i] = cum; }
  let lastRare = -1;
  for (let i = 0; i < words.length; i++) {
    if (ends[i] > HARD) break;
    const w = words[i].replace(/[^A-Za-z]/g, '');
    if (w.length < 4) continue;
    const rank = _commonRank(w);
    if (_commonRankMap && (rank < 0 || rank >= RARE)) lastRare = i;   // low-frequency word
  }
  let cut;
  if (lastRare >= 0) {
    cut = lastRare; let extra = 0;
    while (cut + 1 < words.length && extra < EXTRA && ends[cut + 1] <= HARD) { cut++; extra++; }
  } else {
    cut = 0;
    for (let i = 0; i < words.length; i++) { if (ends[i] <= SOFT) cut = i; else break; }
  }
  const title = stripTailStop(clean(words.slice(0, cut + 1).join(' ')));
  return title || clean(words.slice(0, cut + 1).join(' '));
}

// Build clean ftext HTML from yt-dlp metadata: caption headline as <h2>, caption
// body as <p>s (IG "." separator lines dropped), a small grey meta line, and the
// source link. No related-reel tail / counts junk (unlike the manual 770 paste).
function _ytdlpBuildFtext(meta, url) {
  const esc = s => String(s == null ? '' : s).replace(/[<>&"]/g,
    c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;' }[c]));
  const desc = (meta.description || '').trim();
  // <h2> = short CLEANED title (emoji-stripped, organism-aware). Body keeps the
  // FULL original caption (emoji included) so ftext = the whole author comment.
  const cleanTitle = _smartIgTitle(desc);
  let html = '';
  if (cleanTitle) html += '<h2>' + esc(cleanTitle) + '</h2>\n';
  const body = desc.split(/\r?\n/).map(l => l.trim())
    .filter(l => l && l !== '.')                       // drop IG "." spacer lines
    .map(l => '<p>' + esc(l) + '</p>').join('\n');
  if (body) html += body + '\n';
  const handle = _ytdlpAuthorHandle(meta);
  const bits = [];
  if (handle) bits.push('By ' + esc(handle));
  if (/^\d{8}$/.test(meta.upload_date || '')) {
    const d = meta.upload_date;
    bits.push(d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8));
  }
  if (Number.isFinite(meta.like_count)) bits.push(Number(meta.like_count).toLocaleString() + ' likes');
  if (bits.length) html += '<p style="color:#888;font-size:.9em;">' + bits.join(' · ') + '</p>\n';
  html += '<p>Source: <a href="' + esc(url) + '" target="_blank" rel="noopener" '
        + 'style="color:#5bf;word-break:break-all;">' + esc(url) + '</a></p>';
  return html;
}

// Import pass: for each yt-dlp-supported new row, fetch metadata and fill ftext +
// VidAuthor (+ VidTitle when oEmbed didn't). Guarded assignments so it complements
// the oEmbed pass (_fetchMetaForNewRows) instead of clobbering it. Sequential (one
// yt-dlp process at a time) with a save()+render() per row so progress shows. If
// yt-dlp is unreachable/fails for an ltype='w' (Instagram) row, fall back to the
// old r.jina.ai path so the row still gets *something*.
async function _fetchYtdlpMetaForNewRows(rows) {
  let done = 0;
  await _ensureCommonWords();   // (dev0426) load freq list once for smart titles
  for (const row of rows) {
    if (!row || !row.link) continue;
    if (row.ftext && row.VidAuthor) continue;          // already complete
    try {
      const meta = await _ytdlpFetchMeta(row.link);
      const desc = (meta.description || '').trim();
      const handle = _ytdlpAuthorHandle(meta);
      if (!desc && !handle) throw new Error('empty metadata');
      let changed = false;
      if (!row.ftext) { row.ftext = _ytdlpBuildFtext(meta, row.link); changed = true; }
      if (!row.VidAuthor && handle) { row.VidAuthor = handle; changed = true; }
      if (!row.VidTitle) {
        // IG/TikTok yt-dlp title is a generic "Video by handle" → derive a clean
        // organism-aware title from the caption; YT/Vimeo have a real title → just
        // normalize it (strip emoji/accents, flatten), no caption windowing.
        const t = (meta.title || '').trim();
        const vt = (!t || /^video by /i.test(t))
          ? _smartIgTitle(desc)
          : _normalizeText(t).replace(/\s+/g, ' ').trim();
        if (vt) { row.VidTitle = vt; changed = true; }
      }
      if (changed) { row.DateModified = isoNow(); done++; save(); if (typeof render === 'function') render(); }
      toast('✓ yt-dlp: ' + (handle || row.link.slice(0, 40)), 1400);
    } catch (e) {
      console.warn('[ytdlp] meta failed for', row.link, e && e.message);
      // Fallback: Instagram-style web rows can still try the r.jina.ai reader.
      if (row.ltype === 'w' && !row.ftext) {
        try {
          const html = await _fetchAndExtractArticle(row.link);
          if (html) {
            row.ftext = (window.DownloadRules ? window.DownloadRules.apply(html, row.link) : html);
            row.DateModified = isoNow(); save(); if (typeof render === 'function') render();
          }
        } catch (_) { /* jina also failed — leave ftext empty */ }
      }
    }
  }
  if (done) toast('✓ yt-dlp metadata: ' + done + ' row(s) populated', 2500);
}

// (dev0425) STUB — per-row max-resolution video download to <project>/video/*.mp4
// via yt-dlp. The proxy builder reserves /exec/ytdlp {download:true}; this client
// trigger + the proxy download branch are intentionally unbuilt for now (dev0425
// scope). Wire to a T hotkey / V "goto" bar when the feature lands.
async function _ytdlpDownloadVideo(row) {
  toast('yt-dlp video download — not built yet (dev0425 stub).\n'
      + 'Planned: save max-res mp4 to <project>/video/.', 3500);
}
window._ytdlpDownloadVideo = _ytdlpDownloadVideo;

// ══════════════════════════════════════════════════════════════════════════════
// Firefox "Save Page As → Text" of an Instagram page → ttxt enrichment (dev0427)
// ══════════════════════════════════════════════════════════════════════════════
// The user saves an IG reel page from their already-open, logged-in Firefox (just
// reading the rendered DOM — no API/cookie replay that IG could flag) and pastes
// the text into W. It carries far more than yt-dlp: the current reel's caption,
// OTHERS' comments, the author bio, AND a batch of the author's other reel URLs
// (the profile grid that had loaded). We parse all of it and fill VidTitle (clean
// caption) + ftext (full caption, if the row has none yet) + ttxt (everything).

function _igPostId(url) {
  const m = (url || '').match(/instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : '';
}

// True for a saved IG PAGE (vs a bare IG URL paste or a normal article).
function _looksLikeIgSavedText(txt) {
  if (!txt || !/instagram\.com/i.test(txt)) return false;
  const hasPost = /instagram\.com\/[A-Za-z0-9_.]+\/(?:reel|reels|p|tv)\/[A-Za-z0-9_-]+/i.test(txt);
  const sig = /Instagram from Meta|Liked by|comments? from Facebook/i.test(txt);
  return hasPost && sig && txt.length > 500;
}

// Parse the saved text → { handle, name, bio, currentId, caption, reels[], comments[] }.
function _parseIgSavedText(txt) {
  const flat = String(txt).replace(/\r/g, '');
  const stripU = s => s.replace(/<https?:\/\/[^>]*>/g, '').replace(/<#>/g, '');
  const flatten = s => stripU(s).replace(/\s+/g, ' ').trim();
  const keepLines = s => stripU(s).split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');

  // reels (author post/reel URLs) + most-frequent owner = author handle
  const postRe = /instagram\.com\/([A-Za-z0-9_.]+)\/(reel|reels|p|tv)\/([A-Za-z0-9_-]+)/g;
  const ownerCount = {}; const reels = []; const seen = new Set(); let m;
  while ((m = postRe.exec(flat))) {
    const owner = m[1].toLowerCase();
    if (/^(explore|reels|stories|direct|accounts|p|tv|reel)$/.test(owner)) continue;
    ownerCount[owner] = (ownerCount[owner] || 0) + 1;
    if (!seen.has(m[3])) {
      seen.add(m[3]);
      const kind = m[2].toLowerCase().startsWith('reel') ? 'reel' : m[2].toLowerCase();
      reels.push({ id: m[3], url: 'https://www.instagram.com/' + m[1] + '/' + kind + '/' + m[3] + '/' });
    }
  }
  let handle = '', best = 0;
  for (const k in ownerCount) if (ownerCount[k] > best) { best = ownerCount[k]; handle = k; }

  // display name + bio (profile block)
  let name = '', bio = '';
  const nameM = flat.match(/\n([^\n]{1,60})\n[\d.,]+\s*[KMB]?\s*posts\b/i);
  if (nameM) name = nameM[1].trim();
  const bioM = flat.match(/following[^\n]*\n([\s\S]{0,400}?)\n(?:Link icon|\.\.\. more|Followed by)/i);
  if (bioM) bio = bioM[1].split('\n').map(s => s.trim()).filter(Boolean).join(' / ');

  // current reel id (the modal that was open): liked_by link, else first post id in modal
  let currentId = '';
  const lb = flat.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)\/liked_by/i);
  if (lb) currentId = lb[1];

  // modal region (like/comment UI to end)
  let mi = flat.search(/Liked by/i);
  if (mi < 0) mi = flat.search(/Audio is muted/i);
  const modal = mi >= 0 ? flat.slice(mi) : '';
  if (!currentId) currentId = _igPostId(modal);

  // current caption: after the author handle line, up to the first "Nw" timestamp
  let caption = '';
  if (handle) {
    const hRe = new RegExp('\\n\\s*' + handle.replace(/\./g, '\\.') + '\\s*<[^>]*>\\s*\\n([\\s\\S]*?)\\n\\s*\\d+\\s*[wdhmy]\\b', 'i');
    const cm = modal.match(hRe);
    if (cm) caption = keepLines(cm[1]);
  }

  // comments: split modal by comment terminators "<.../c/ID/>"; LAST handle per block
  const comments = [];
  const cTermRe = /<https?:\/\/[^>]*\/c\/\d+\/>/g;
  let prev = 0, ct;
  while ((ct = cTermRe.exec(modal))) {
    const block = modal.slice(prev, ct.index);
    prev = cTermRe.lastIndex;
    const hms = [...block.matchAll(/\n\s*([A-Za-z0-9_.]+)\s*<https?:\/\/www\.instagram\.com\/\1\/>\s*\n/g)];
    if (!hms.length) continue;
    const last = hms[hms.length - 1];
    const who = last[1];
    if (who.toLowerCase() === handle.toLowerCase()) continue;        // skip author's own caption
    const body = flatten(block.slice(last.index + last[0].length))
      .replace(/\s*\d+\s*[wdhmy]\s*$/i, '').replace(/\bVerified\b/g, '').trim();
    if (body) comments.push({ who, body });
  }

  return { handle, name, bio, currentId, caption, reels, comments };
}

// Build ttxt HTML (rich column, edited in Xe): author + bio + caption + comments
// + the author's other reel URLs (clickable; the seed for the future URL→rows idea).
function _igTtxtHtml(p) {
  const esc = s => String(s == null ? '' : s).replace(/[<>&"]/g,
    c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;' }[c]));
  const who = p.handle ? '@' + p.handle : '';
  let h = '';
  if (p.name || who) h += '<h3>' + esc(p.name || who) + (p.name && who ? ' (' + esc(who) + ')' : '') + '</h3>\n';
  if (p.bio) h += '<p><em>' + esc(p.bio) + '</em></p>\n';
  if (p.caption) {
    h += '<h4>Caption</h4>\n<p>' + esc(p.caption.replace(/\n+/g, ' ')) + '</p>\n';
  }
  if (p.comments.length) {
    h += '<h4>Comments (' + p.comments.length + ')</h4>\n';
    h += p.comments.map(c => '<p><strong>@' + esc(c.who) + ':</strong> ' + esc(c.body) + '</p>').join('\n') + '\n';
  }
  const sib = p.reels.filter(r => r.id !== p.currentId);
  if (sib.length) {
    h += '<h4>Other reels by ' + esc(who || p.handle) + ' (' + sib.length + ')</h4>\n';
    h += sib.map(r => '<p><a href="' + esc(r.url) + '" target="_blank" rel="noopener" '
      + 'style="color:#5bf;word-break:break-all;">' + esc(r.url) + '</a></p>').join('\n');
  }
  return h;
}

// ftext from the saved-text caption (only used when the row has no real ftext yet).
function _igCaptionFtext(caption) {
  const esc = s => String(s == null ? '' : s).replace(/[<>&"]/g,
    c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;' }[c]));
  const lines = caption.split('\n');
  const title = _smartIgTitle(caption);
  const body = (lines.slice(1).join(' ').trim()) || lines.join(' ').trim();
  let h = '';
  if (title) h += '<h2>' + esc(title) + '</h2>\n';
  if (body) h += '<p>' + esc(body) + '</p>';
  return h;
}

// W Rule 0 handler: parse pasted IG saved-text, match the row by current reel id,
// fill VidTitle/ftext/ttxt. Does NOT create rows (per the "decide new entries first"
// hold) — if no row matches, it reports what it parsed so the user can add it.
async function _importIgSavedText(txt) {
  await _ensureCommonWords();
  const p = _parseIgSavedText(txt);
  const sib = p.reels.filter(r => r.id !== p.currentId).length;
  if (!p.currentId) {
    toast('IG text parsed but no current reel id found.\n@' + (p.handle || '?')
      + ' · ' + p.comments.length + ' comments · ' + p.reels.length + ' reel URLs.', 5000);
    return;
  }
  const row = data.find(r => r && r.link && _igPostId(r.link) === p.currentId);
  if (!row) {
    toast('No row matches reel ' + p.currentId + '.\nParsed @' + (p.handle || '?')
      + ' · ' + p.comments.length + ' comments · ' + sib + ' other reels.\n'
      + 'Add the reel as a row, then re-paste.', 6000);
    return;
  }
  const parts = [];
  if (!row.VidTitle && p.caption) { row.VidTitle = _smartIgTitle(p.caption); parts.push('VidTitle'); }
  if (!row.VidAuthor && p.handle) { row.VidAuthor = '@' + p.handle; parts.push('VidAuthor'); }
  // ftext only if empty or the jina bail-out stub — never clobber a real caption
  // (yt-dlp or manual). The rich ttxt is the real prize of this import.
  const isStub = /^<p><a [^>]*>https?:\/\/[^<]+<\/a><\/p>$/.test((row.ftext || '').trim());
  if ((!row.ftext || isStub) && p.caption) { row.ftext = _igCaptionFtext(p.caption); parts.push('ftext'); }
  row.ttxt = _igTtxtHtml(p); parts.push('ttxt');           // always set the rich dump
  row.DateModified = isoNow();
  save();
  if (typeof render === 'function') render();
  toast('✓ IG text → UID ' + row.UID + ' [' + parts.join(', ') + ']\n'
    + '@' + (p.handle || '?') + ' · ' + p.comments.length + ' comments · ' + sib + ' other reels in ttxt', 5000);
}
window._parseIgSavedText = _parseIgSavedText;

async function _fetchWebTextForRows(rows) {
  for (const row of rows) {
    if (!row || row.ftext || !row.link) continue;
    try {
      const html = await _fetchAndExtractArticle(row.link);
      if (html) {
        row.ftext = (window.DownloadRules ? window.DownloadRules.apply(html, row.link) : html);
        row.DateModified = isoNow();
        save();
        // If T table is the active screen, refresh so the cell appears
        if (typeof render === 'function') render();
        // (zip0166) Brief per-fetch toast so the user sees progress.
        // Avoid spamming when many fetches complete in quick succession by
        // only toasting every 2nd one if 3+ pending. Simpler: just toast.
        toast('✓ Fetched: ' + (row.link.length > 50 ? row.link.slice(0, 47) + '…' : row.link), 1200);
      } else {
        // Fetch returned nothing — leave ftext empty, mark with a hint
        row.ftext = '<p style="color:#a66;font-style:italic;">[Fetch failed — paste text manually]</p>';
        row.DateModified = isoNow();
        save();
        if (typeof render === 'function') render();
        toast('⚠ Could not fetch: ' + (row.link.length > 50 ? row.link.slice(0, 47) + '…' : row.link), 2200);
      }
    } catch (e) {
      console.warn('Fetch error for', row.link, e);
      row.ftext = '<p style="color:#a66;font-style:italic;">[Fetch error: '
        + (e && e.message ? e.message.replace(/[<>&]/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;' }[c])) : 'unknown')
        + ']</p>';
      row.DateModified = isoNow();
      save();
      if (typeof render === 'function') render();
      toast('⚠ Fetch error: ' + (row.link.length > 50 ? row.link.slice(0, 47) + '…' : row.link), 3000);
    }
  }
}

// Fetch one article. Returns HTML string or null.
async function _fetchAndExtractArticle(url) {
  // Strategy 1: r.jina.ai reader (server-side fetch + extraction).
  try {
    const readerUrl = 'https://r.jina.ai/' + url;
    const r = await fetchWithTimeout(readerUrl, 20000, { headers: { 'Accept': 'text/plain' } });
    if (r && r.ok) {
      const md = await r.text();
      if (md && md.length > 100) {
        return _markdownToHtml(_trimReaderArticle(md));
      }
    }
  } catch (e) { /* fall through to strategy 2 */ }

  // Strategy 2: direct fetch + heuristic extraction. Will fail on most
  // sites due to CORS, but works on CORS-friendly ones (e.g. some blogs,
  // Wikipedia via API, etc.).
  try {
    const r = await fetchWithTimeout(url, 10000);
    if (r && r.ok) {
      const html = await r.text();
      const extracted = _extractArticleFromHtml(html);
      if (extracted && extracted.length > 100) return extracted;
    }
  } catch (e) { /* CORS or network */ }

  return null;
}

// Trim reader output. r.jina.ai prepends a header block (Title: ..., URL: ...,
// Markdown:) and may include a "Related" / "More from" trailing block of
// links. We keep the Title as <h2>, drop the URL/header lines, and cut
// trailing link-dense sections.
function _trimReaderArticle(md) {
  if (!md) return '';
  const lines = md.split('\n');
  let title = '';
  let bodyStart = 0;

  // Detect and consume the header block (case-insensitive)
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    const ln = lines[i].trim();
    if (/^title:/i.test(ln))      title = ln.replace(/^title:\s*/i, '').trim();
    else if (/^url source:/i.test(ln) || /^url:/i.test(ln) || /^published time:/i.test(ln)) { /* skip */ }
    else if (/^markdown content:?$/i.test(ln) || /^content:?$/i.test(ln)) { bodyStart = i + 1; break; }
    else if (ln === '' && title) { bodyStart = i + 1; /* keep going to find Markdown: marker */ }
    else if (ln && !title) break; // first non-header line
  }

  let body = lines.slice(bodyStart).join('\n').trim();

  // Cut at a "Related articles" / "More from" / "Read more" / "Sponsored" etc.
  // section if present. These are the trailing link-list patterns the user
  // mentioned. Match common headings (markdown ##, ###) and stop there.
  const cutPatterns = [
    /\n#{1,4}\s*(related|more from|read more|read next|recommended|sponsored|advertisement|ads by|you might( also)? like|popular|trending|sign up|subscribe|comments?|share this|follow us|newsletter|in this article)\b/i,
    /\n\*{3,}\s*\n/, // markdown horizontal rule (often separates article from footer)
    /\n_{3,}\s*\n/,
  ];
  for (const pat of cutPatterns) {
    const m = body.match(pat);
    if (m && m.index > 200) { body = body.slice(0, m.index).trim(); break; }
  }

  // Also: if the last 30% of lines are predominantly bare links, cut them.
  // Heuristic: scan from end backward; if 5+ consecutive lines are
  // markdown links with little surrounding prose, cut from there.
  const bodyLines = body.split('\n');
  let linkRunStart = -1;
  let linkRunCount = 0;
  for (let i = bodyLines.length - 1; i >= Math.floor(bodyLines.length * 0.5); i--) {
    const ln = bodyLines[i].trim();
    if (!ln) continue;
    // Bare markdown link or list item with link
    if (/^[-*]?\s*\[[^\]]+\]\(https?:\/\/[^)]+\)\s*$/i.test(ln)) {
      linkRunCount++;
      linkRunStart = i;
    } else if (linkRunCount >= 5) {
      break;
    } else {
      linkRunCount = 0;
      linkRunStart = -1;
    }
  }
  if (linkRunCount >= 5 && linkRunStart > 0) {
    body = bodyLines.slice(0, linkRunStart).join('\n').trim();
  }

  // Prepend title as h2 if we found one
  return (title ? '## ' + title + '\n\n' : '') + body;
}

// Minimal markdown → HTML. Handles headings, paragraphs, bold, italic,
// links, lists, blockquotes. Not a full markdown engine — just enough for
// what r.jina.ai produces. The rich-text editor (Xe) can edit the result.
function _markdownToHtml(md) {
  if (!md) return '';

  // ───────── Pre-extract image and link markdown into placeholders ─────────
  // Why: later regex passes (bold __x__, italic _x_) will otherwise scan
  // inside generated <img src="..."> / <a href="..."> tags and mangle URLs
  // that contain underscore-bounded segments — e.g.
  //   58425_Joanna_Steidle_The-Gateway-copy.jpg → 58425<em>Joanna</em>Steidle_...
  // (discoverwildlife.com / purpledshub CDN hit this).
  // The placeholder uses   sentinels which can never appear in real
  // text and which no other regex pass touches.
  const _attrEsc = s => String(s).replace(/[<>&"]/g, c =>
    ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;' }[c]));
  // Inline-only markdown for link text: link <a>...</a> tags live inside
  // placeholders, so the document-level bold/italic passes never see their
  // contents. Apply bold/italic here on the visible text only, so labels
  // like **Breathtaking footage…** still render as <strong>.
  const _inlineMd = txt => {
    let t = String(txt).replace(/[<>&]/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;' }[c]));
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
    return t;
  };
  // <img> only renders raster/vector — a video URL in src produces a broken
  // icon. Convert those markdown "images" to active <a> links instead.
  const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|ogv|avi|mkv)(\?|#|$)/i;
  const placeholders = [];
  const stash = html => {
    placeholders.push(html);
    return ' PLACE' + (placeholders.length - 1) + ' ';
  };
  // Images ![alt](url) — must run before links since !\[ shares [.
  // Video URLs become active <a> links (rather than broken <img>s);
  // real image URLs become <img>.
  md = md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
    if (VIDEO_EXT_RE.test(url)) {
      const linkText = (alt && alt.trim()) ? alt : url;
      return stash('<a href="' + _attrEsc(url) + '" target="_blank" rel="noopener">' +
            _inlineMd(linkText) + '</a>');
    }
    return stash('<img src="' + _attrEsc(url) + '" alt="' + _attrEsc(alt) +
          '" style="max-width:100%;height:auto;">');
  });
  // Links [text](url) — run inline markdown on the visible text so that
  // **bold** / _italic_ inside the label still convert (the placeholder
  // would otherwise shield them from the document-level passes).
  md = md.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt, url) =>
    stash('<a href="' + _attrEsc(url) + '" target="_blank" rel="noopener">' +
          _inlineMd(txt) + '</a>'));

  // Escape HTML in remaining text. Placeholders only contain  PLACE\d+ 
  // and are not touched by this step.
  let s = md.replace(/[<>&]/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;' }[c]));
  // Headings (## , ### , etc.) — process longest first
  s = s.replace(/^#{6}\s+(.+)$/gm, '<h6>$1</h6>');
  s = s.replace(/^#{5}\s+(.+)$/gm, '<h5>$1</h5>');
  s = s.replace(/^#{4}\s+(.+)$/gm, '<h4>$1</h4>');
  s = s.replace(/^#{3}\s+(.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^#{2}\s+(.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/^#{1}\s+(.+)$/gm, '<h1>$1</h1>');
  // Bold **x** and __x__
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  // Italic *x* and _x_  (URLs are safe inside placeholders — see top of fn)
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  // Blockquotes (single-line; multi-line gets concatenated)
  s = s.replace(/^>\s?(.+)$/gm, '<blockquote>$1</blockquote>');
  // Unordered list items
  s = s.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
  // Wrap consecutive <li> in <ul>
  s = s.replace(/(<li>.*?<\/li>(\s*<li>.*?<\/li>)*)/gs, '<ul>$1</ul>');
  // Restore image / link placeholders. Doing this BEFORE paragraph wrapping
  // means the block-element check below correctly sees <img> and leaves it
  // unwrapped (a bare image on its own line stays bare, not wrapped in <p>).
  s = s.replace(/ PLACE(\d+) /g, (_, n) => placeholders[+n]);
  // Paragraphs: split on blank lines, wrap non-block lines in <p>
  const blocks = s.split(/\n{2,}/);
  const wrapped = blocks.map(b => {
    const t = b.trim();
    if (!t) return '';
    // Already a block element? leave alone
    if (/^<(h[1-6]|ul|ol|li|blockquote|img|p|div|pre|table)/i.test(t)) return t;
    // Otherwise wrap as paragraph (collapse single newlines to spaces)
    return '<p>' + t.replace(/\n/g, ' ') + '</p>';
  });
  return wrapped.filter(Boolean).join('\n');
}

// Fallback: extract article from raw HTML using a simple "longest <p>
// concentration" heuristic. This is a poor man's Readability — only used
// when r.jina.ai is unreachable. Strips <script>/<style>/<nav>/<header>/
// <footer>/<aside>/<form> first.
function _extractArticleFromHtml(html) {
  if (!html) return '';
  // Quick strip of obvious non-article elements
  let s = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, '')
    .replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');

  // Try <article> first — it's semantic and usually right
  const artMatch = s.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  if (artMatch) return _sanitizeExtractedHtml(artMatch[1]);

  // Try <main>
  const mainMatch = s.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch) return _sanitizeExtractedHtml(mainMatch[1]);

  // Last resort: collect all <p> tags. If there are 3+, return them.
  const ps = s.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi);
  if (ps && ps.length >= 3) return _sanitizeExtractedHtml(ps.join('\n'));

  return '';
}

// Strip <img>/<figure> captions, classes, and inline styles from extracted
// HTML so it lands in ftext as clean editable content. Not a full sanitizer
// (the source is web HTML — could contain anything) but the rich-text
// editor uses contenteditable, which itself filters most dangerous markup.
function _sanitizeExtractedHtml(html) {
  if (!html) return '';
  let s = html;
  // Drop figure captions (the user wanted captions omitted)
  s = s.replace(/<figcaption\b[^>]*>[\s\S]*?<\/figcaption>/gi, '');
  // Drop class= and id= attributes (they reference styles we don't have)
  s = s.replace(/\s(class|id|onclick|onload|onerror|style)\s*=\s*("[^"]*"|'[^']*')/gi, '');
  // Convert <h1> to <h2> (the editor puts the page title at h2 and we
  // don't want competing top-level headings)
  s = s.replace(/<h1\b([^>]*)>/gi, '<h2$1>').replace(/<\/h1>/gi, '</h2>');
  // Trim leading/trailing whitespace
  return s.trim();
}

// Rule 2 implementation. `lines` is the split, trimmed, non-empty array.
// Line 0 is `@channelname`, lines 1+ are CSV rows.
//
// New rows get BA = '1' (BatchAdd marker — distinguishes channel-imported
// rows from manually-curated ones). Existing rows with matching links are
// updated in place (VidTitle, VidAuthor, vidLength); BA on existing rows is
// not changed since the row was already curated by hand.
//
// (zip0129) Existing-link matches are also written to a duplicate-links
// report so the user has a record of what was overwritten.
function _importChannelCSV(lines) {
  const author = lines[0]; // keep the @ — that's the identifier

  // (zip0129) O(1) lookup of existing rows by link.
  const linkIndex = new Map();
  data.forEach((r, di) => {
    if (r && r.link) linkIndex.set(String(r.link).trim(), di);
  });

  const now = isoNow();
  let added = 0, updated = 0, skipped = 0;
  const dupRecords = [];

  for (let li = 1; li < lines.length; li++) {
    const fields = _parseCsvRow(lines[li]);
    if (fields.length < 2) { skipped++; continue; }
    const link     = (fields[0] || '').trim();
    const title    = (fields[1] || '').trim();
    const duration = (fields[2] || '').trim();
    if (!link) { skipped++; continue; }

    if (linkIndex.has(link)) {
      // Update existing row
      const di = linkIndex.get(link);
      const r = data[di];
      // Capture existing title BEFORE update, for the dup report
      dupRecords.push({
        UID: r ? r.UID : '',
        link: link,
        title: r ? (r.VidTitle || '') : ''
      });
      let touched = false;
      if (title    && r.VidTitle  !== title)    { r.VidTitle  = title;    touched = true; }
      if (author   && r.VidAuthor !== author)   { r.VidAuthor = author;   touched = true; }
      if (duration && r.vidLength !== duration) { r.vidLength = duration; touched = true; }
      if (touched) { r.DateModified = now; updated++; }
    } else {
      // Add new row — mark as batch-added (BA = '1')
      const row = {
        UID: nextUID(),
        link: link,
        VidTitle: title,
        VidAuthor: author,
        vidLength: duration,  // may be '' for Shorts
        BA: '1',
        show: '1',
        DateAdded: now,
        DateModified: now,
        tags: []
      };
      data.push(row);
      linkIndex.set(link, data.length - 1);
      added++;
    }
  }

  if (!added && !updated) {
    toast('No valid CSV rows found.\n(' + skipped + ' lines could not be parsed.)', 3000);
    return;
  }

  if (dupRecords.length) {
    _writeDuplicateLinksReport(dupRecords, 'channel CSV: ' + author); // async, fire-and-forget
  }

  save();
  if (added) {
    sortCol = 'DateAdded';
    sortDir = 'desc';
    buildSort();
  }
  render();

  toast(
    '✓ Channel: ' + author + '\n'
    + '   added ' + added + ' new (BA=1), updated ' + updated + ' existing'
    + (skipped ? ', skipped ' + skipped : '')
    + (dupRecords.length ? '\n   ' + dupRecords.length + ' duplicate(s) → duplicateTries.txt' : ''),
    3500
  );
}


// (zip0129) Both buttons used to call wantLinks. The redundant L button was
// removed; W is the sole entry point. The L hotkey still works as an alias.

document.getElementById('wantLinkBtn')?.addEventListener('click', wantLinks);
document.getElementById('brClose').addEventListener('click', brClose);
document.getElementById('dictModeBtn').addEventListener('click', () => { _dictMatchMode=_dictMatchMode==='anywhere'?'start':'anywhere'; updateDictBtn(); });
document.getElementById('brPrev').addEventListener('click', () => { brSave(); if (_brIdx > 0) brShow(_brIdx - 1); });
document.getElementById('brNext').addEventListener('click', () => { brSave(); if (_brIdx < _brRows.length-1) brShow(_brIdx + 1); });

document.getElementById('brSave').addEventListener('click', () => {
  brSave();
  if (_brIdx < _brRows.length - 1) brShow(_brIdx + 1); // auto-advance
});

// ── Open VideoEditor with Browse fields injected into its right panel ────
function brOpenVideoEditorWithFields(di) {
  if (!window.openVideoEditor) {
    toast('video.js not loaded — place video.js in the same folder.'); return;
  }
  const row = data[di];

  // Hide Browse overlay while VideoEditor is open (VideoEditor is on top)
  document.getElementById('browseOverlay').style.display = 'none';
  document.getElementById('wrap').style.marginRight = '';

  // Open VideoEditor — the wrapper installed at the bottom of this file
  // routes through runVEPostOpenSetup automatically.
  window.openVideoEditor(row);
}

// Runs after E is mounted regardless of entry path (E hotkey from T, grid
// double-click, Annotate→E, etc.). Registers the keyboard handler that owns
// E's own letter shortcuts (T, G, A, N, J, S, M, C, ←, →, Esc).
//
// IMPORTANT: this function is called from the openVideoEditor wrapper AFTER
// origOpen(). The keydown registration inside happens inside a setTimeout(80)
// because the post-open setup also injects fields into the right panel and
// needs the DOM settled. To make sure my handler sees keys BEFORE video.js's
// handleKey (which registers synchronously inside origOpen and would otherwise
// win the capture phase race), the wrapper itself pre-installs a "claim"
// handler that runs first; that claim simply forwards to veKeyHandler once
// it's ready.
function runVEPostOpenSetup(di) {
  setTimeout(() => {
    try {
    const overlay = document.getElementById('video-editor-overlay');
    if (!overlay) return;

    // (zip0119 fix) `row` was referenced throughout this function but never
    // defined here — it was only defined in the old brOpenVideoEditorWithFields
    // wrapper. When the body was lifted into runVEPostOpenSetup, the binding
    // got lost. Result: ReferenceError on line 2930 / 2959, which silently
    // aborted the function BEFORE the keydown handler at the end was
    // registered. That's why T worked (video.js handles it independently)
    // but A/N/J/S/M/C/← /→ didn't (their handler never installed).
    const row = data[di];
    if (!row) return;

    // (zip0185) Layout = video+segments on the left, A panel on the right 340px.
    // Don't blow this away with width:100%; leave room for browseOverlay.
    overlay.style.left         = '0';
    overlay.style.top          = '0';
    overlay.style.right        = '340px';
    overlay.style.bottom       = '0';
    overlay.style.width        = 'auto';
    overlay.style.height       = 'auto';
    overlay.style.borderRadius = '0';
    overlay.style.border       = 'none';

    // (zip0118: removed obsolete title-bar manipulation — there's no title
    // bar in E since zip0116. The first child of the overlay is now <style>,
    // followed by the hidden mute <input>, then the main flex container.
    // Trying to manipulate `overlay.children[1]` as a title bar was a bug
    // that broke the post-open code path silently — including the keydown
    // handler registration, which is why A/N/J/S/M/C didn't work.)

    // Compact right panel — reduce padding/gaps
    const rightPanel = overlay.querySelector('div[style*="width:270px"]');
    if (rightPanel) {
      rightPanel.style.padding    = '7px 10px';
      rightPanel.style.gap        = '5px';
      rightPanel.style.overflowY  = 'auto';
      // Shrink all v2btn buttons
      overlay.querySelectorAll('.v2btn').forEach(b => {
        b.style.minWidth = '30px'; b.style.height = '27px'; b.style.fontSize = '11px';
      });
      // Shrink number inputs
      overlay.querySelectorAll('.v2num').forEach(inp => {
        inp.style.fontSize = '13px'; inp.style.padding = '3px';
      });
      // Shrink segment op buttons
      ['v2-ls','v2addseg','v2delseg'].forEach(id => {
        const b = overlay.querySelector('#'+id); if (b) b.style.padding = '5px';
      });
    }

    // (zip0126) The CLASSIFICATION block (Tags chip input, legacy
    // t1/t2/n1/n2/n3, Comment, Val) was removed from E. E is now strictly
    // a video-editing screen — segment selection and labeling only. Tag
    // and metadata work happens in A (Annotate); pressing A from E
    // navigates there with the current row preserved.
    //
    // Note: row.tags, row.comment, row.Val etc. are NOT cleared by this
    // change — they remain on the row and continue to be edited via A.
    // The timeline-area Seg N: <label> buttons in the bottom toolbar
    // (defined in video.js) are the only text entry remaining in E.
    //
    // The right panel (defined in video.js) still hosts Segment tabs and
    // Fine Adjustments controls — those are the actual video-editing UI
    // and remain in place.

    // saveVEFields is a no-op now (kept so video.js's Ctrl+S handler still
    // finds it). All metadata edits happen in A and save themselves there.
    function saveVEFields() { /* no-op */ }

    // (zip0126) E hotkey handler. Owns: T/G/A (navigation), N/J (row step),
    // S/M/C (Sel/Mute/CC toggles), arrows (speed), Space (play/pause), Esc.
    let _veCloseToTable    = false; // Escape → return to table
    let _veTargetAfterClose = null; // Alt+N/J override target row
    // (zip0127) When true, after E closes the next-row handling reopens E
    // (not Annotate) on the row at _veTargetAfterClose. Used by N/J so the
    // user can step through video rows while staying in the editor.
    let _veGoToNextE       = false;
    // (zip0130) When true, the close-handler reopens Annotate on _brIdx.
    // Set ONLY by the A hotkey — every other close path (T, G, Esc, swipe,
    // N/J that hops to next E, video.js's ArrowUp/Down internal hop, swipe
    // gesture) leaves this false and routes to the no-op "stay where the
    // close took us" branch. This replaces the old default-to-Annotate
    // behavior that made unrelated close paths surprise the user with an
    // Annotate panel popping up.
    let _veOpenAnnotateAfterClose = false;
    function veKeyHandler(e) {
      const tag = document.activeElement && document.activeElement.tagName;
      const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.ctrlKey && e.key.toLowerCase() === 's') { saveVEFields(); }

      // (zip0186) Esc no longer closes Ev — use T (return to table), G (go to
      // grid), the swipe gesture, or navigate with ArrowUp/Down.
      // Small modal popups (v2comment-popup) still close on Esc since they're
      // transient and have no other dismiss mechanism.
      if (e.key === 'Escape' && !e.ctrlKey) {
        const commentPop = document.getElementById('v2comment-popup');
        if (commentPop) { e.preventDefault(); e.stopImmediatePropagation(); commentPop.remove(); return; }
        // (dev0356→0357) The "Esc closes just the Annotate dock" case is now
        // handled universally for every editor by the load-time capture handler
        // (_dockEscDismiss, search "dev0357") — it fires before this one. So by
        // the time we get here the dock is already gone and Esc closes Ev → Table.
        // (dev0344) Esc closes Ev → Table (re-enabled; was a no-op since zip0186).
        // Mirrors the T key's path exactly (set close-to-table intent, click the
        // ✕ so all the existing teardown/save-on-close logic runs).
        e.preventDefault(); e.stopImmediatePropagation();
        _veCloseToTable = true;
        _veTargetAfterClose = _brIdx;
        const cb = overlay.querySelector('#v2close'); if (cb) cb.click();
        return;
      }

      // Alt+N/J = legacy bindings, equivalent to plain N/J — stay in E.
      if (e.altKey && !e.ctrlKey) {
        if (e.key==='n'||e.key==='N') {
          e.preventDefault();
          let t = _brIdx + 1;
          while (t < _brRows.length) { const r = data[_brRows[t]]; if (r && isVideoRow(r)) break; t++; }
          if (t >= _brRows.length) { toast('No more video rows below.', 1500); return; }
          _veGoToNextE = true; _veTargetAfterClose = t;
          const cb=overlay.querySelector('#v2close'); if(cb) cb.click();
          return;
        }
        if (e.key==='j'||e.key==='J') {
          e.preventDefault();
          let t = _brIdx - 1;
          while (t >= 0) { const r = data[_brRows[t]]; if (r && isVideoRow(r)) break; t--; }
          if (t < 0) { toast('No more video rows above.', 1500); return; }
          _veGoToNextE = true; _veTargetAfterClose = t;
          const cb=overlay.querySelector('#v2close'); if(cb) cb.click();
          return;
        }
      }

      // (zip0132) Space = play/pause toggle.
      // Sets BOTH _salPaused (the runtime pause flag video.js loops check)
      // AND _salUserPaused (a sticky flag that video.js's timeline-scrub
      // code respects so a click-to-scrub doesn't override the user's
      // explicit pause). See video.js timeline pointerup logic.
      if ((e.key === ' ' || e.key === 'Spacebar') && !inInput
          && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault(); e.stopImmediatePropagation();
        const p = window.seeLearnVideoPlayers && window.seeLearnVideoPlayers['v2host'];
        if (p) {
          if (p._salPaused) {
            p._salPaused = false;
            p._salUserPaused = false;
            if (typeof p.playVideo === 'function') { try { p.playVideo(); } catch(_) {} }
            else if (p.play) p.play().catch(()=>{});
          } else {
            p._salPaused = true;
            p._salUserPaused = true;
            if (typeof p.pauseVideo === 'function') { try { p.pauseVideo(); } catch(_) {} }
            else if (p.pause) p.pause().catch(()=>{});
          }
        }
        return;
      }

      if (inInput) return;

      // Plain letter shortcuts (no modifiers, not in a text field)
      if (!e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        // T = close E, return to Table
        if (e.key === 't' || e.key === 'T') {
          e.preventDefault(); e.stopPropagation();
          _veCloseToTable = true;
          _veTargetAfterClose = _brIdx;
          const cb = overlay.querySelector('#v2close'); if (cb) cb.click();
          return;
        }
        // G = close E, return to Grid (handled by post-close logic via _cameFromGrid)
        if (e.key === 'g' || e.key === 'G') {
          e.preventDefault(); e.stopPropagation();
          // After E closes, we want Grid. Mark intent and close.
          _veCloseToTable = true;     // tell onVEClose to close Browse too
          _veTargetAfterClose = _brIdx;
          window._veGoToGridAfterClose = true;
          const cb = overlay.querySelector('#v2close'); if (cb) cb.click();
          return;
        }
        // N or ArrowDown = advance to next visible row, stay in E.
        // (zip0185) Walk ALL filtered rows, not just video. The close handler
        // uses openEditorForRow to open the right E for whatever row type is
        // landed on (video → Ev, text → Xe, image → Ie). Always reseed _brRows
        // from current filter so a freshly-applied filter doesn't get walked
        // against a stale snapshot.
        if (e.key === 'n' || e.key === 'N' || e.key === 'ArrowDown') {
          e.preventDefault(); e.stopPropagation();
          // Identify current row by data-index, then reseed _brRows from
          // current filter and re-find the row's position before stepping.
          const _curDi = (_brRows && _brIdx >= 0 && _brIdx < _brRows.length) ? _brRows[_brIdx] : -1;
          _brRows = brGetVisibleRows();
          let _curFi = _curDi >= 0 ? _brRows.indexOf(_curDi) : -1;
          if (_curFi < 0) _curFi = _brIdx;
          let target = _curFi + 1;
          if (target >= _brRows.length) { toast('No more rows below.', 1500); return; }
          _veGoToNextE = true;
          _veTargetAfterClose = target;
          const cb = overlay.querySelector('#v2close'); if (cb) cb.click();
          return;
        }
        // J or ArrowUp = previous row, stay in E
        if (e.key === 'j' || e.key === 'J' || e.key === 'ArrowUp') {
          e.preventDefault(); e.stopPropagation();
          const _curDi = (_brRows && _brIdx >= 0 && _brIdx < _brRows.length) ? _brRows[_brIdx] : -1;
          _brRows = brGetVisibleRows();
          let _curFi = _curDi >= 0 ? _brRows.indexOf(_curDi) : -1;
          if (_curFi < 0) _curFi = _brIdx;
          let target = _curFi - 1;
          if (target < 0) { toast('No more rows above.', 1500); return; }
          _veGoToNextE = true;
          _veTargetAfterClose = target;
          const cb = overlay.querySelector('#v2close'); if (cb) cb.click();
          return;
        }
        // (dev0355) A = toggle the Annotate dock BESIDE E — it no longer closes
        // E. The E overlay already reserves right:340px for exactly this panel
        // (video.js: video-editor-overlay has right:340px), so the dock slides
        // in alongside the editor. Press A again to save + hide the dock.
        // (dev0358) Do NOT focus the dock on open — focus stays on E so the video
        // keeps responding to Space/arrows; press Tab (video.js handleKey) to move
        // into the A fields, matching the row-hop behavior the user expects.
        if (e.key === 'a' || e.key === 'A') {
          e.preventDefault(); e.stopPropagation();
          const ov = document.getElementById('browseOverlay');
          if (ov && ov.style.display === 'flex') {
            if (typeof brSave === 'function') brSave();
            ov.style.display = 'none';
          } else if (ov) {
            ov.style.display = 'flex';
            brShow(_brIdx);
          }
          return;
        }
        // (zip0130) Delete = remove current row, advance to next video row in E.
        // Confirmation dialog so an accidental Delete keystroke can be aborted.
        // After delete: the row at the same _brIdx is now the next row (since
        // the deleted entry was removed from _brRows). If no next row exists,
        // step back; if nothing remains, return to T.
        if (e.key === 'Delete' && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault(); e.stopPropagation();
          const di = _brRows[_brIdx];
          const r  = data[di];
          if (!r) return;
          const label = (r.VidTitle || r.link || '(no title)').slice(0, 80);
          if (!confirm('Delete this row?\n\n' + label + '\n\nThis cannot be undone.')) return;

          // Remove from data
          data.splice(di, 1);
          // Adjust checkedRows
          const nc = new Set();
          checkedRows.forEach(i => { if (i < di) nc.add(i); else if (i > di) nc.add(i - 1); });
          checkedRows = nc;
          if (typeof save === 'function') save();
          if (typeof buildSort === 'function') buildSort();

          // Rebuild _brRows so it reflects current visible rows minus the deleted one
          _brRows = brGetVisibleRows();

          // Find next video row at-or-after current _brIdx (which now points
          // at what was the row AFTER the deleted one, if any).
          let target = Math.min(_brIdx, _brRows.length - 1);
          // Walk forward to find a video row
          while (target < _brRows.length) {
            const rr = data[_brRows[target]];
            if (rr && isVideoRow(rr)) break;
            target++;
          }
          // If nothing forward, walk backward
          if (target >= _brRows.length) {
            target = _brRows.length - 1;
            while (target >= 0) {
              const rr = data[_brRows[target]];
              if (rr && isVideoRow(rr)) break;
              target--;
            }
          }

          if (target < 0 || target >= _brRows.length) {
            // Nothing left to edit — return to T.
            _veCloseToTable = true;
            const cb = overlay.querySelector('#v2close'); if (cb) cb.click();
            toast('Row deleted. No more video rows.', 2000);
            return;
          }
          // Otherwise: hop to target via the same goToNextE path used by N/J.
          _veGoToNextE = true;
          _veTargetAfterClose = target;
          const cb = overlay.querySelector('#v2close'); if (cb) cb.click();
          toast('✓ Deleted row\n   ' + label, 2000);
          return;
        }
        // S = toggle Selected/Full playback
        if (e.key === 's' || e.key === 'S') {
          e.preventDefault(); e.stopPropagation();
          const tog = document.getElementById('v2toggle');
          if (tog) tog.click();
          return;
        }
        // M = toggle Mute
        if (e.key === 'm' || e.key === 'M') {
          e.preventDefault(); e.stopPropagation();
          const mb = document.getElementById('v2b-mute');
          if (mb) mb.click();
          return;
        }
        // C = toggle Closed Captions
        if (e.key === 'c' || e.key === 'C') {
          e.preventDefault(); e.stopPropagation();
          const cc = document.getElementById('v2b-cc');
          if (cc) cc.click();
          return;
        }
        // ← / → = step one frame back/forward and pause.
        // (zip0132) Was speed adjust; user wanted these freed up for the more
        // valuable frame-step action. Speed is now slider-only.
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault(); e.stopPropagation();
          const dir = e.key === 'ArrowRight' ? 1 : -1;
          const FRAME_SEC = 0.1; // matches video.js convention
          const p = window.seeLearnVideoPlayers && window.seeLearnVideoPlayers['v2host'];
          if (!p) return;
          // Read current time (YT is sync, Vimeo returns a Promise)
          const handleT = (t) => {
            const newT = Math.max(0, t + dir * FRAME_SEC);
            // Pause + seek (one-frame step semantics)
            try {
              p._salPaused = true;
              p._salUserPaused = true;  // sticky so timeline scrub doesn't unpause
              if (typeof p.pauseVideo === 'function') p.pauseVideo();
              else if (p.pause) p.pause().catch(()=>{});
              if (typeof p.seekTo === 'function') p.seekTo(newT, true);
              else if (typeof p.setCurrentTime === 'function') p.setCurrentTime(newT);
            } catch(_) {}
          };
          try {
            const t = (typeof p.getCurrentTime === 'function') ? p.getCurrentTime() : 0;
            if (t && typeof t.then === 'function') t.then(handleT);
            else handleT(typeof t === 'number' ? t : 0);
          } catch(_) { handleT(0); }
          return;
        }
      }

      // (zip0126) Legacy H/L/O → t1 setter removed. The ve-t1 element was
      // deleted along with the rest of the CLASSIFICATION block, so this
      // handler became dead. Tag-related work now happens via A → Annotate.
    }
    document.addEventListener('keydown', veKeyHandler, true);
    _veActiveKeyHandler = veKeyHandler;

    // (zip0133) Hide the brief T-flash during N/J row-hop.
    // Between closeEditor() removing the current overlay and the new
    // openVideoEditor() building the next one, T peeks through for ~100ms.
    // Drop a solid cover at the same z-index as the editor overlay just
    // before the close, remove it after the new overlay is mounted (or
    // after a safety timeout in case mount fails).
    if (!document.getElementById('ve-hop-cover-style')) {
      const st = document.createElement('style');
      st.id = 've-hop-cover-style';
      st.textContent = '#ve-hop-cover{position:fixed;inset:0;z-index:99998;'
        + 'background:#1a1a1a;pointer-events:none;}';
      document.head.appendChild(st);
    }
    window._veShowHopCover = function() {
      let c = document.getElementById('ve-hop-cover');
      if (!c) {
        c = document.createElement('div');
        c.id = 've-hop-cover';
        document.body.appendChild(c);
      }
      // Safety: auto-remove after 600ms even if next E never mounts.
      clearTimeout(window._veHopCoverTimer);
      window._veHopCoverTimer = setTimeout(() => {
        const el = document.getElementById('ve-hop-cover');
        if (el) el.remove();
      }, 600);
    };
    // Remove the cover once *this* E overlay is in place. We're already
    // inside runVEPostOpenSetup, so the new E exists.
    const existingCover = document.getElementById('ve-hop-cover');
    if (existingCover) {
      // Give the iframe a tick to start painting before lifting the cover
      setTimeout(() => existingCover.remove(), 60);
      clearTimeout(window._veHopCoverTimer);
    }

    // (zip0123) Right-to-left swipe gesture to close E (mirrors V).
    //
    // PREVIOUS BUG (zip0122): catcher was a child of v2host, but video.js
    // calls `host.innerHTML = ''` every time the player re-mounts (segment
    // switch, start/dur change, etc.). That wiped the catcher.
    //
    // FIX: catcher is a child of the overlay, position:absolute, with
    // geometry tracked from v2host via ResizeObserver. This way it survives
    // any v2host content rebuild.
    const v2host = overlay.querySelector('#v2host');
    if (v2host && !overlay.querySelector('#ve-swipe-catcher')) {
      const catcher = document.createElement('div');
      catcher.id = 've-swipe-catcher';
      catcher.style.cssText =
        'position:absolute;z-index:50;background:transparent;'
        + 'pointer-events:auto;touch-action:pan-y;';
      overlay.appendChild(catcher);

      function syncCatcherGeometry() {
        if (!document.body.contains(v2host)) return;
        const r = v2host.getBoundingClientRect();
        // overlay is position:fixed inset:0, so position:absolute inside it
        // uses overlay top-left (= viewport 0,0) as origin.
        catcher.style.left   = r.left + 'px';
        catcher.style.top    = r.top + 'px';
        catcher.style.width  = r.width + 'px';
        catcher.style.height = r.height + 'px';
      }
      syncCatcherGeometry();
      const ro = new ResizeObserver(syncCatcherGeometry);
      ro.observe(v2host);
      window.addEventListener('resize', syncCatcherGeometry);
      overlay._veSwipeCleanup = () => {
        try { ro.disconnect(); } catch(_) {}
        window.removeEventListener('resize', syncCatcherGeometry);
      };

      let sStart = null;
      catcher.addEventListener('pointerdown', e => {
        sStart = { x: e.clientX, y: e.clientY, t: Date.now() };
      }, true);
      catcher.addEventListener('pointerup', e => {
        if (!sStart) return;
        const dx = e.clientX - sStart.x;
        const dy = e.clientY - sStart.y;
        const ms = Date.now() - sStart.t;
        sStart = null;
        // Right→left swipe: close E and return to G or T (existing close
        // path via v2close → onVEClose handles destination via _cameFromGrid).
        if (dx < -40 && Math.abs(dy) < Math.abs(dx) && ms < 800) {
          _veCloseToTable = !_cameFromGrid;
          window._veGoToGridAfterClose = _cameFromGrid;
          _veTargetAfterClose = _brIdx;
          const cb = overlay.querySelector('#v2close');
          if (cb) cb.click();
          return;
        }
        // Plain tap / non-swipe: re-issue click on v2host so existing
        // Ctrl+click-to-add-segment still works (the catcher is a sibling
        // of v2host now, not a child, so events don't bubble through).
        if (e.ctrlKey && Math.abs(dx) < 10 && Math.abs(dy) < 10 && ms < 400) {
          // Compute click coords inside v2host
          const r = v2host.getBoundingClientRect();
          const inX = e.clientX - r.left;
          const inY = e.clientY - r.top;
          // Find element at that point inside v2host (the iframe usually)
          // and dispatch a synthetic Ctrl+click on v2host so video.js's
          // host.click handler fires.
          const evt = new MouseEvent('click', {
            bubbles: true, cancelable: true, view: window,
            clientX: e.clientX, clientY: e.clientY,
            ctrlKey: true, button: 0
          });
          v2host.dispatchEvent(evt);
        }
      }, true);
      catcher.addEventListener('pointercancel', () => { sStart = null; }, true);

      // (zip0131) Forward dblclick from catcher to v2host so the new
      // double-click-to-mark-segment workflow works. Without this, the
      // catcher swallows dblclick events because it sits on top of v2host.
      catcher.addEventListener('dblclick', e => {
        e.preventDefault(); e.stopPropagation();
        const evt = new MouseEvent('dblclick', {
          bubbles: true, cancelable: true, view: window,
          clientX: e.clientX, clientY: e.clientY,
          ctrlKey: e.ctrlKey, button: 0
        });
        v2host.dispatchEvent(evt);
      }, true);
    }

    // Get VideoEditor's own save/close buttons
    const v2save  = overlay.querySelector('#v2save');
    const v2close = overlay.querySelector('#v2close');

    // When VideoEditor closes (save or close), save VE fields then reopen Browse
    function onVEClose() {
      saveVEFields();
      save();
      document.removeEventListener('keydown', veKeyHandler, true);
      document.removeEventListener('keydown', _veEarlyClaimKeyHandler, true);
      _veActiveKeyHandler = null;
      // (zip0123) Clean up swipe-catcher's resize observer + window listener
      if (overlay && typeof overlay._veSwipeCleanup === 'function') {
        try { overlay._veSwipeCleanup(); } catch(_) {}
        overlay._veSwipeCleanup = null;
      }
      const closeToTable = _veCloseToTable;
      const goToGrid = window._veGoToGridAfterClose;
      const goToNextE = _veGoToNextE;
      const openAnnotate = _veOpenAnnotateAfterClose;
      window._veGoToGridAfterClose = false;
      _veCloseToTable = false;
      _veGoToNextE = false;
      _veOpenAnnotateAfterClose = false;
      // (dev0355) If the Annotate dock is open beside E (opened via A), persist
      // its edits before E tears down or hops — Esc/T/G claim the key before the
      // Annotate handler can save, so do it here for every close path.
      const _dockOpen = document.getElementById('browseOverlay').style.display === 'flex';
      if (_dockOpen && typeof brSave === 'function') brSave();
      setTimeout(() => {
        // (zip0127) N/J in E: stay in E, hop to the next/prev row.
        // (zip0185) Now routes via openEditorForRow so non-video rows land
        // in Xe (text) or Ie (image) instead of being skipped.
        if (goToNextE && _veTargetAfterClose !== null) {
          const target = _veTargetAfterClose;
          _veTargetAfterClose = null;
          if (target >= 0 && target < _brRows.length) {
            _brIdx = target;
            // (dev0355) Keep the Annotate dock pinned to the hopped-to row.
            if (_dockOpen) brShow(target);
            const di = _brRows[target];
            const row = data[di];
            if (row) {
              // (zip0133) Cover the screen so T doesn't flash through.
              if (typeof window._veShowHopCover === 'function') window._veShowHopCover();
              if (typeof window.openEditorForRow === 'function') {
                window.openEditorForRow(row);
                return;
              }
              if (window.openVideoEditor && isVideoRow(row)) {
                window.openVideoEditor(row);
                return;
              }
            }
          }
          // Fallthrough: row missing/invalid, return to T as a safe default.
        }
        if (goToGrid) {
          // G pressed in E — return to Grid (same as how G hotkey works at top level)
          document.getElementById('browseOverlay').style.display = 'none';
          document.getElementById('wrap').style.marginRight = '';
          brClearMedia();
          if (typeof gridShow === 'function') gridShow();
          return;
        }
        if (closeToTable) {
          // Esc or T pressed — close E and Annotate, return to T view with row focused.
          document.getElementById('browseOverlay').style.display = 'none';
          document.getElementById('wrap').style.marginRight = '';
          brClearMedia();
          // Restore table focus at the same row.
          if (_brRows.length > 0) {
            const di = _brRows[_brIdx];
            const vi = sortedIdx ? sortedIdx.indexOf(di) : di;
            if (vi >= 0) {
              focus = { r: vi, c: 0 };
              pending = null;
            }
          }
          render();
          // Scroll the focused row into view (otherwise focus is set in DOM
          // but invisible if the row was previously off-screen).
          // (dev0329) Windowed table: scroll the focus row into the window.
          if (focus !== null && typeof _tScrollRowIntoView === 'function') {
            _tScrollRowIntoView(focus.r);
          }
        } else if (openAnnotate) {
          // A was pressed in E — explicit request to open Annotate on _brIdx.
          // (zip0130) This branch now requires the explicit flag. Other close
          // paths (video.js's ArrowUp/Down hop, swipe, X button click without
          // intent, save button) fall to the safe-default T-return below.
          const target = _veTargetAfterClose !== null ? _veTargetAfterClose : _brIdx;
          _veTargetAfterClose = null;
          _brIdx = target;
          document.getElementById('browseOverlay').style.display = 'flex';
          brShow(_brIdx);
          setTimeout(() => {
            const chipInput = document.querySelector('#brTagChips input');
            if (chipInput) chipInput.focus();
            else { const el = document.getElementById('brt1'); if (el) el.focus(); }
          }, 60);
        } else {
          // (zip0130) Default: close Annotate (if open) and return to T.
          // Reached when video.js internally closes E via ArrowUp/ArrowDown,
          // when E's own X button is clicked, or any other close that didn't
          // explicitly opt in to Annotate or Grid. Treats this as a clean
          // "return to source" — no surprise overlays.
          document.getElementById('browseOverlay').style.display = 'none';
          document.getElementById('wrap').style.marginRight = '';
          brClearMedia();
          if (_brRows.length > 0) {
            const idx = _veTargetAfterClose !== null && _veTargetAfterClose >= 0
              ? Math.min(_veTargetAfterClose, _brRows.length - 1) : _brIdx;
            const di = _brRows[idx];
            const vi = sortedIdx ? sortedIdx.indexOf(di) : di;
            if (vi >= 0) { focus = { r: vi, c: 0 }; pending = null; }
          }
          _veTargetAfterClose = null;
          render();
          // (dev0329) Windowed table: scroll the focus row into the window.
          if (focus !== null && typeof _tScrollRowIntoView === 'function') {
            _tScrollRowIntoView(focus.r);
          }
        }
      }, 80);
    }

    // Watch for VideoEditor overlay being removed (handles Escape key path)
    let _veCloseFired = false;
    function fireOnVEClose() {
      if (_veCloseFired) return; _veCloseFired = true;
      onVEClose();
    }
    if (v2save)  v2save.addEventListener('click',  () => setTimeout(fireOnVEClose, 120));
    if (v2close) v2close.addEventListener('click', () => setTimeout(fireOnVEClose, 120));

    const observer = new MutationObserver(() => {
      if (!document.getElementById('video-editor-overlay')) {
        observer.disconnect();
        setTimeout(fireOnVEClose, 30);
      }
    });
    observer.observe(document.body, { childList: true });
    } catch (err) {
      // (zip0119) Surface failures instead of silently aborting. If the post-
      // open setup throws, the keydown handler never installs and hotkeys
      // appear broken. Show the error so it's noticed and fixed.
      console.error('[runVEPostOpenSetup] failed:', err);
      if (typeof toast === 'function') toast('E setup error: ' + err.message, 3000);
    }
  }, 80);
}

// ── Ensure brOpenVideoEditorWithFields runs whenever E is opened, regardless
//    of entry path (E hotkey from T, double-click in grid, dblclick in T tags
//    cell, etc.). Without this, my veKeyHandler isn't registered and ANJSMC
//    don't work. T worked previously only because video.js has its own T
//    handler in handleKey().
//
//    We monkey-patch window.openVideoEditor: the original is called as before,
//    then we run the post-open setup that brOpenVideoEditorWithFields used to
//    duplicate. Cleanest centralization without changing every call site.
//
//    KEY ORDERING: video.js's handleKey is registered synchronously inside
//    origOpen(), so it would naturally win the capture-phase race. To make
//    OUR handler win for the keys we care about (Esc, A, N, J, S, M, C, ←/→
//    arrows for speed), we install an "early claim" handler BEFORE calling
//    origOpen(). The claim handler runs first; for keys we own, it
//    stopImmediatePropagation()s so video.js's handler never sees them.
//    For keys we don't own (Tab/Ctrl+S), it returns without interfering,
//    and video.js's handler continues working.

// Module-level "active veKeyHandler" pointer — the early claim handler
// forwards to whatever the latest veKeyHandler is (assigned after the
// post-open setup runs).
// (zip0131) Exposed on window so video.js can detect that index.html will
// handle ArrowUp/ArrowDown and bow out of its own legacy handler.
let _veActiveKeyHandler = null;
Object.defineProperty(window, '_veActiveKeyHandler', { get: () => _veActiveKeyHandler });

function _veEarlyClaimKeyHandler(e) {
  if (!_veActiveKeyHandler) return;
  // Only intercept keys that veKeyHandler genuinely owns. video.js's
  // handleKey owns Tab/Ctrl+S — leave those alone.
  // (zip0123: added Space; zip0130: added Delete; zip0131: added ArrowUp/Down
  //  for filter-aware row navigation as N/J aliases.)
  const k = e.key;
  const isOurEsc   = k === 'Escape' && !e.ctrlKey;
  const isOurArrow = (k === 'ArrowLeft' || k === 'ArrowRight'
                   || k === 'ArrowUp'   || k === 'ArrowDown');
  const isOurSpace = (k === ' ' || k === 'Spacebar') && !e.ctrlKey && !e.altKey && !e.metaKey;
  const isOurDel   = (k === 'Delete') && !e.ctrlKey && !e.altKey && !e.metaKey;
  const isOurLetter = !e.ctrlKey && !e.metaKey && !e.altKey
    && (k === 't' || k === 'T' || k === 'g' || k === 'G' ||
        k === 'a' || k === 'A' || k === 'n' || k === 'N' ||
        k === 'j' || k === 'J' || k === 's' || k === 'S' ||
        k === 'm' || k === 'M' || k === 'c' || k === 'C');
  if (!isOurEsc && !isOurArrow && !isOurSpace && !isOurDel && !isOurLetter) return;

  // Don't claim when focus is in an input — let normal text-edit keys work,
  // including Esc inside a comment popup (which video.js handles separately).
  const ae = document.activeElement;
  const inInput = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT');
  // Esc still goes through veKeyHandler regardless — it explicitly checks for
  // the comment popup itself.
  if (inInput && !isOurEsc) return;

  // Hand off to veKeyHandler and block other capture-phase listeners.
  e.stopImmediatePropagation();
  _veActiveKeyHandler(e);
}

(function wrapOpenVideoEditor() {
  function tryWrap() {
    if (typeof window.openVideoEditor !== 'function') {
      setTimeout(tryWrap, 50);
      return;
    }
    if (window._openVEWrapped) return;
    window._openVEWrapped = true;
    const origOpen = window.openVideoEditor;
    window.openVideoEditor = function (row) {
      // (zip0122) Update last-record memory
      if (row && row.UID && typeof window.setLastUID === 'function') {
        window.setLastUID(row.UID);
      }
      // Install the early claim BEFORE origOpen so it captures keys ahead
      // of video.js's handleKey registration.
      document.addEventListener('keydown', _veEarlyClaimKeyHandler, true);
      origOpen(row);
      // Find the row's data-index so the post-open setup can populate _brIdx etc.
      const di = data.indexOf(row);
      if (di < 0) return;
      // If _brRows is empty (entered E directly from T without going through
      // Annotate first), seed it with the visible-rows window so N/J navigation
      // works against the current sort/filter.
      if (!_brRows.length || _brRows.indexOf(di) < 0) {
        _brRows = brGetVisibleRows();
        const fi = _brRows.indexOf(di);
        _brIdx = fi >= 0 ? fi : 0;
      } else {
        _brIdx = _brRows.indexOf(di);
      }
      // Now run the standard E post-open setup (registers veKeyHandler,
      // injects classification fields, attaches close handlers, etc.).
      runVEPostOpenSetup(di);
    };
  }
  tryWrap();
})();

// (zip0122) Wrap closeDictionary so returning from D restores focus to the
// row whose UID is in _lastUID. The wrapping is deferred until tags.js has
// installed window.closeDictionary.
(function wrapCloseDictionary() {
  function tryWrap() {
    if (typeof window.closeDictionary !== 'function') {
      setTimeout(tryWrap, 80);
      return;
    }
    if (window._closeDictWrapped) return;
    window._closeDictWrapped = true;
    const origClose = window.closeDictionary;
    window.closeDictionary = function () {
      origClose.apply(this, arguments);
      // After dict is gone, restore focus to last UID
      setTimeout(() => {
        if (typeof window._restoreFocusToLastUID === 'function') {
          window._restoreFocusToLastUID();
        }
      }, 30);
    };
  }
  tryWrap();
})();

// Browse field order for Tab cycling
const BR_FIELDS = ['brt1','brt2','brn1','brn2','brn3','brComment','brVal','brSave','brPrev','brNext','brClose'];

function brFocusField(id) {
  const el = document.getElementById(id);
  if (el && !el.disabled && el.style.display !== 'none') { el.focus(); return true; }
  return false;
}

// (dev0357) Universal "Esc dismisses just the Annotate dock" — for EVERY editor
// (Ev video, Xe text/weblink, Ie image). When the Annotate dock is open beside
// an editor, the first Esc saves + hides ONLY the dock and leaves the editor
// open (a second Esc then closes the editor). Registered at load (capture) so it
// runs before the editors' own open-time Esc handlers and before the Annotate-
// mode handler below. When NO editor is open (plain Annotate panel reached from
// T), it bails so that screen keeps its own Esc=close behavior.
function _dockEscDismiss(e) {
  if (e.key !== 'Escape' || e.ctrlKey || e.altKey || e.metaKey) return;
  const dock = document.getElementById('browseOverlay');
  if (!dock || dock.style.display !== 'flex') return;
  const editorOpen = !!document.getElementById('video-editor-overlay')
    || !!document.getElementById('textEditorOverlay')
    || document.getElementById('gridFullscreen')?.style.display === 'flex';
  if (!editorOpen) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (typeof brSave === 'function') brSave();
  dock.style.display = 'none';
  const wrap = document.getElementById('wrap');
  if (wrap) wrap.style.marginRight = '';   // dock gone → table can use full width on return
}
document.addEventListener('keydown', _dockEscDismiss, true);

// Keyboard in Annotate mode
document.addEventListener('keydown', e => {
  if (document.getElementById('browseOverlay').style.display !== 'flex') return;

  const tag = document.activeElement && document.activeElement.tagName;
  const inField = (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT');

  // Alt+L = toggle dict match mode
  if (e.altKey && !e.ctrlKey && (e.key==='l'||e.key==='L')) {
    e.preventDefault();
    _dictMatchMode = _dictMatchMode==='anywhere' ? 'start' : 'anywhere';
    updateDictBtn();
    toast('Lookup: '+_dictMatchMode, 1000);
    return;
  }
  
  // Alt+N = next row, Alt+J = previous row
  if (e.altKey && !e.ctrlKey) {
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); brSave(); if (_brIdx < _brRows.length-1) brShow(_brIdx+1); return; }
    if (e.key === 'j' || e.key === 'J') { e.preventDefault(); brSave(); if (_brIdx > 0) brShow(_brIdx-1); return; }
  }

  // Ctrl+S always saves
  if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); brSave(); return; }

  // Escape — save and close
  if (e.key === 'Escape') {
    brSave(); brClose(); return;
  }

  if (inField) {
    // Tab / Shift+Tab cycles through fields
    if (e.key === 'Tab') {
      e.preventDefault();
      const ids = BR_FIELDS.filter(id => {
        const el = document.getElementById(id);
        return el && el.offsetParent !== null;
      });
      const cur = document.activeElement && document.activeElement.id;
      const ci = ids.indexOf(cur);
      const next = e.shiftKey
        ? ids[(ci - 1 + ids.length) % ids.length]
        : ids[(ci + 1) % ids.length];
      brFocusField(next);
    }
    return;
  }

  // When NOT in a field:
  if (!e.ctrlKey && !e.altKey) {
    const k = e.key.toUpperCase();
    // H A L O → set t1 quickly (A won't conflict — inField=false means no input focused)
    if (k === 'H' || k === 'L' || k === 'O') {
      e.preventDefault();
      document.getElementById('brt1').value = k;
      document.getElementById('brt1').dispatchEvent(new Event('change'));
      document.getElementById('brt2').dispatchEvent(new Event('input'));
      toast('t1 = '+k, 700);
      setTimeout(() => brFocusField('brt2'), 30);
      return;
    }
    // T → focus t1
    if (k === 'T') { e.preventDefault(); brFocusField('brt1'); return; }
    // C → focus comment
    if (k === 'C') { e.preventDefault(); brFocusField('brComment'); return; }
    // Space or Enter → save + advance
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault(); brSave();
      if (_brIdx < _brRows.length - 1) brShow(_brIdx + 1);
      return;
    }
    // Arrow keys ← → also navigate (Up/Down handled by table-level handler which syncs annotate)
    if (e.key === 'ArrowLeft')  { e.preventDefault(); brSave(); if (_brIdx > 0) brShow(_brIdx-1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); brSave(); if (_brIdx < _brRows.length-1) brShow(_brIdx+1); return; }
    // Tab when no field focused → jump to t1
    if (e.key === 'Tab') { e.preventDefault(); brFocusField('brt1'); return; }
  }
});
function toast(msg, ms, opts) {
  const t=document.getElementById('toast'); if(!t) return;
  t.textContent=msg;
  // (dev0351) Optional positioning. Default = the screen-centered CSS. With
  // opts.aboveEl, sit ~30px above that element's TOP edge, horizontally centered
  // on it (the G size/zoom toasts use this so they don't cover the grid middle).
  if (opts && opts.atXY) {
    // (dev0373) Position the toast at a specific point (e.g. under the mouse / on the
    // grid cell just clicked), centered just above it and clamped into the viewport.
    t.style.left = Math.max(70, Math.min(window.innerWidth - 70, opts.atXY.x)) + 'px';
    t.style.top  = Math.max(8, opts.atXY.y - 38) + 'px';
    t.style.bottom = 'auto';
    t.style.transform = 'translate(-50%,0)';
  } else if (opts && opts.aboveEl) {
    const r = opts.aboveEl.getBoundingClientRect();
    t.style.left = (r.left + r.width/2) + 'px';
    t.style.top  = Math.max(8, r.top - 30) + 'px';
    t.style.bottom = 'auto';
    t.style.transform = 'translate(-50%,0)';
  } else {
    t.style.left=''; t.style.top=''; t.style.bottom=''; t.style.transform='';
  }
  t.style.display='block'; clearTimeout(t._tid); t._tid=setTimeout(()=>{t.style.display='none';},ms||3000);
}
function escH(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// Help modal — two-page system
const PHYLA_DATA = [
  // [phylum, meaning, common, features, count, extinct?]
  ['Agmata','Fragmented','—','Calcareous conical shells','5 species',true],
  ['Annelida','Little ring','Segmented worms','Multiple circular segments','22,000+',false],
  ['Arthropoda','Jointed foot','Arthropods','Segmented bodies, jointed limbs, chitin exoskeleton','1,250,000+',false],
  ['Brachiopoda','Arm foot','Lampshells','Lophophore and pedicle','300–500 extant; 12,000+ extinct',false],
  ['Bryozoa','Moss animals','Moss animals, sea mats','Lophophore, no pedicle, ciliated tentacles','6,000',false],
  ['Chaetognatha','Longhair jaw','Arrow worms','Chitinous spines either side of head, fins','~100',false],
  ['Chordata','With a cord','Chordates','Hollow dorsal nerve cord, notochord, pharyngeal slits','~55,000+',false],
  ['Cnidaria','Stinging nettle','Cnidarians','Nematocysts (stinging cells)','~16,000',false],
  ['Ctenophora','Comb bearer','Comb jellies','Eight comb rows of fused cilia','~100–150',false],
  ['Cycliophora','Wheel carrying','—','Circular mouth surrounded by small cilia, sac-like bodies','3+',false],
  ['Dicyemida','Lozenge animal','—','Single axial celled endoparasites, surrounded by ciliated cells','100+',false],
  ['Echinodermata','Spiny skin','Echinoderms','Fivefold radial symmetry, mesodermal calcified spines','~7,500',false],
  ['Entoprocta','Inside anus','Goblet worms','Anus inside ring of cilia','~150',false],
  ['Gastrotricha','Hairy stomach','Hairybellies','Two terminal adhesive tubes','~690',false],
  ['Gnathostomulida','Jaw orifice','Jaw worms','Tiny worms related to rotifers, no body cavity','~100',false],
  ['Hemichordata','Half cord','Acorn worms','Stomochord in collar, pharyngeal slits','~130',false],
  ['Kinorhyncha','Motion snout','Mud dragons','Eleven segments, each with a dorsal plate','~150',false],
  ['Loricifera','Armour bearer','Brush heads','Umbrella-like scales at each end','~122',false],
  ['Micrognathozoa','Tiny jaw animals','—','Accordion-like extensible thorax','2',false],
  ['Mollusca','Soft','Mollusks','Muscular foot and mantle round shell','85,000+',false],
  ['Monoblastozoa','One sprout animals','—','Dense ciliated, distinct anterior/posterior','1',false],
  ['Nematoda','Thread like','Roundworms','Round cross section, keratin cuticle','25,000',false],
  ['Nematomorpha','Thread form','Horsehair worms','Long, thin parasitic worms related to nematodes','~320',false],
  ['Nemertea','A sea nymph','Ribbon worms','Unsegmented worms with proboscis in rhynchocoel','~1,200',false],
  ['Onychophora','Claw bearer','Velvet worms','Worm-like with legs tipped by chitinous claws','~200',false],
  ['Orthonectida','Straight swimmer','—','Parasitic, microscopic, simple, wormlike','20',false],
  ['Petalonamae','Shaped like leaves','—','Extinct Ediacaran frondomorphs','3 classes',true],
  ['Phoronida','Zeus\'s mistress','Horseshoe worms','U-shaped gut','11',false],
  ['Placozoa','Plate animals','Trichoplaxes','Two ciliated cell layers, amoeboid fiber cells between','4+',false],
  ['Platyhelminthes','Flat worm','Flatworms','Flattened worms, no body cavity, many parasitic','~29,500',false],
  ['Porifera','Pore bearer','Sponges','Perforated interior wall, simplest known animals','10,800',false],
  ['Priapulida','Little Priapus','Penis worms','Penis-shaped worms','~20',false],
  ['Proarticulata','Before articulates','—','Extinct Ediacaran, display glide symmetry','3 classes',true],
  ['Rotifera','Wheel bearer','Rotifers','Anterior crown of cilia','~3,500',false],
  ['Saccorhytida','Pocket + wrinkle','—','Spherical body, prominent mouth, 8 openings around body','2 species',true],
  ['Tardigrada','Slow step','Water bears, moss piglets','Microscopic arthropod relatives, four segmented body','1,000',false],
  ['Trilobozoa','Three-lobed animal','Trilobozoans','Tricentric symmetry, all Ediacaran','18 genera',true],
  ['Vetulicolia','Ancient dweller','Vetulicolians','Two-part body, possible chordate subphylum','15 species',true],
  ['Xenacoelomorpha','Strange hollow form','Xenacoelomorphs','Small simple bilateral animals, lacking gut cavity or anus','400+',false],
];

let _helpPage = 0;
// HELP_PAGES is declared further down (zip0154 rewrite) along with HELP_DATA.

function buildPhylaTable() {
  const tbody = document.getElementById('phylaTableBody');
  if (!tbody || tbody.children.length > 0) return; // already built
  PHYLA_DATA.forEach((row, i) => {
    const [phylum, meaning, common, features, count, extinct] = row;
    const tr = document.createElement('tr');
    tr.style.cssText = 'border-bottom:1px solid #1a1a2e;'+(extinct?'font-style:italic;opacity:0.75;':'');
    tr.innerHTML =
      '<td style="padding:4px 10px;color:'+(extinct?'#888':'#8ef')+';white-space:nowrap;font-weight:bold;">'+escH(phylum)+(extinct?' †':'')+'</td>'
      +'<td style="padding:4px 10px;color:#aaa;">'+escH(meaning)+'</td>'
      +'<td style="padding:4px 10px;color:#ccc;white-space:nowrap;">'+escH(common)+'</td>'
      +'<td style="padding:4px 10px;color:#999;max-width:300px;">'+escH(features)+'</td>'
      +'<td style="padding:4px 10px;color:#8a8;text-align:right;white-space:nowrap;">'+escH(count)+'</td>';
    tbody.appendChild(tr);
    tr.style.background = i % 2 === 0 ? '#0a0a1a' : '#0d0d1e';
  });
}

// ── (zip0154) Help system rewrite ────────────────────────────────────────────
// Two help screens — Hd (developer, page 0 + taxonomy on page 1) and Hu
// (user, page 2). Both render from the same HELP_DATA structure, which is
// also the source for the "⬇ Download" button (rich-text export with
// dev-only commands bolded). User mode opens directly to Hu and hides the
// other pages from navigation.
// Version string is set in index.html (single source of truth — see zip0217).
// Fallback 'dev0000' only fires if index.html's version script failed to run,
// which would itself be a bug worth surfacing in the badge/filename.
var HELP_VERSION_STR = (typeof window !== 'undefined' && window.HELP_VERSION_STR) ? window.HELP_VERSION_STR : 'dev0000';

const HELP_DATA = [
  // ─── MOBILE BASICS (Hum only) ───────────────────────────────────────
  // (dev0264) Mobile-only orientation. Hidden from Hd and Hu via
  // mobileOnly:true. Shown at the top of Hum so a phone user can find
  // their way around without ever needing a keyboard.
  { id: 'MOBILE', title: 'Getting started on your phone', devOnly: false, mobileOnly: true,
    desc: 'SeeAndLearn on a phone is touch-first. You will mostly use the Grid (G) plus the fullscreen viewers (V / Xs / Q). Everything below is reachable without a keyboard.',
    sections: [
      { name: 'Top-of-screen controls', items: [
        { key: 'Tap ☰ (top-left)',     desc: 'Opens the menu — Help, Settings, Slideshow.',          dev: false },
        { key: 'Tap C button',         desc: 'Switch to a different saved grid layout (Collection).', dev: false },
        { key: 'Tap ? Help button',    desc: 'Reopen this help at any time.',                        dev: false },
      ]},
      { name: 'Inside the Grid', items: [
        { key: 'Tap a cell',           desc: 'Play / pause the video in that cell.',                 dev: false },
        { key: 'Swipe → on a cell',    desc: 'Open that cell fullscreen (video, image, text, quiz).', dev: false },
        { key: 'Swipe ← on a cell',    desc: 'Toggle the video in that cell play/pause.',            dev: false },
      ]},
      { name: 'Inside fullscreen view', items: [
        { key: 'Swipe ← (from edge)',  desc: 'Close the viewer and return to the Grid.',             dev: false },
        { key: 'Tap ✕ button',         desc: 'Close the viewer and return to the Grid.',             dev: false },
        { key: 'Pinch / pan (images)', desc: 'Zoom and pan around an image.',                        dev: false },
        { key: 'Tap bottom-bar icons', desc: 'Play, pause, set loop points in the video player (V).', dev: false },
        { key: 'Tap an answer (quiz)', desc: 'Submit your answer in a quiz cell (Q).',               dev: false },
      ]}
    ]
  },

  // ─── GLOBAL ─────────────────────────────────────────────────────────
  { id: 'GLOBAL', title: 'Global — works from any screen', devOnly: false,
    desc: 'Single-letter hotkeys fire when no input/editable has focus. Esc universally defocuses (blurs text fields; deselects focused row in T) — it no longer closes any screen.',
    sections: [
      { name: 'Hotkeys', items: [
        { key: 'H',       desc: 'Toggle Help (works everywhere)',               dev: false },
        { key: 'G',       desc: 'Open Grid (G)',                                dev: false },
        { key: 'C',       desc: 'Open Collection picker (C)',                   dev: false },
        { key: 'V',       desc: 'View focused row fullscreen — video/image/quiz/text', dev: false },
        { key: 'T',       desc: 'Return to Table (saves open E screen first)', dev: true  },
        { key: 'E',       desc: 'Open Editor (Ev/Xe/Ie) for focused T row; selects row 1 if none focused', dev: true },
        { key: 'A',       desc: 'Open Annotate panel (A)',                     dev: true  },
        { key: 'D',       desc: 'Open Dictionary on focused row\'s first tag', dev: true  },
        { key: 'M',       desc: 'Hamburger menu (→ Settings, Dictionary, Folder…)', dev: true },
        { key: 'F',       desc: 'Toggle row filter (T view)',                  dev: true  },
        { key: 'W / L',   desc: 'Smart clipboard import — add rows from pasted URLs', dev: true },
        { key: 'Esc',     desc: 'Defocus text / deselect row. Does NOT close any screen.', dev: false },
      ]}
    ]
  },

  // ─── T — TABLE ──────────────────────────────────────────────────────
  { id: 'T', title: 'T — Table (Master Data Editor)', devOnly: true,
    desc: 'Every row = one content item (video, image, text slide, or quiz). Tags drive the Annotate (A) lookup. Open Ev, Xe, or Ie from here with the E key.',
    sections: [
      { name: 'Hotkeys', items: [
        { key: 'E',                desc: 'Open Editor for focused row (Ev/Xe/Ie by type); row 1 if none focused', dev: true },
        { key: 'A',                desc: 'Open Annotate panel',              dev: true },
        { key: 'G',                desc: 'Open Grid',                        dev: true },
        { key: 'V',                desc: 'View focused row fullscreen',       dev: true },
        { key: 'F',                desc: 'Toggle filter',                    dev: true },
        { key: '↑ ↓',              desc: 'Move focus between rows',          dev: true },
        { key: 'Enter',            desc: 'Commit cell edit, move down',       dev: true },
        { key: 'Tab / Shift+Tab',  desc: 'Commit and move right / left',      dev: true },
        { key: 'Del / Backspace',  desc: 'Clear focused cell',               dev: true },
        { key: 'Ctrl+I',           desc: 'Preview focused row (video/image/slide) — Space=play/pause, Esc=close', dev: true },
        { key: 'Esc',              desc: 'Deselect focused row',             dev: true },
      ]},
      { name: 'Mouse', items: [
        { key: 'Click cell',            desc: 'Focus cell',                             dev: true },
        { key: 'Double-click cell',     desc: 'Edit cell (text, link, etc.)',           dev: true },
        { key: 'Shift+click (col)',     desc: 'Range select → bulk-set value',          dev: true },
        { key: 'R-click tag chip',      desc: 'Menu: Copy tag / Dictionary / Filter',  dev: true },
        { key: 'R-click tag cell',      desc: 'Paste clipboard tag to this row (if one copied)', dev: true },
        { key: 'Double-click tag cell', desc: 'Open Annotate panel on this row',       dev: true },
      ]}
    ]
  },

  // ─── G / Gu — GRID ──────────────────────────────────────────────────
  { id: 'G', title: 'G / Gu — Grid', devOnly: false,
    desc: 'N×N grid (N = 2–5). Cell slots come from row.cell (dev) or the active Collection config (user). Videos play muted in G; row Mute flag applies in fullscreen V.',
    sections: [
      { name: 'Hotkeys', items: [
        { key: '2 / 3 / 4 / 5', desc: 'Resize grid to 2×2 / 3×3 / 4×4 / 5×5', dev: false },
        { key: 'G',             desc: 'Open hovered cell\'s video link in a new tab', dev: false },
        { key: 'C',             desc: 'Toggle closed captions on all video cells', dev: false },
        { key: 'V',             desc: 'View cell fullscreen',                    dev: false },
        { key: 'E',             desc: 'Open Editor for current cell (dev)',       dev: true  },
        { key: 'T',             desc: 'Return to Table',                         dev: true  },
        { key: 'Ctrl+Alt+G',    desc: 'Save current layout to c.json',           dev: true  },
      ]},
      { name: 'Mouse / Touch', items: [
        { key: 'Click cell',          desc: 'Play / pause video',                       dev: false },
        { key: 'Swipe → on cell',     desc: 'Open fullscreen viewer (V / Ie / Xs / Q)', dev: false },
        { key: 'Swipe ← on cell',     desc: 'Toggle play/pause video',                  dev: false },
        { key: 'Hold cell',           desc: 'Cut cell for swap (dev)',                   dev: true  },
        { key: 'Click another cell',  desc: 'Swap with cut cell (dev)',                  dev: true  },
        { key: 'Ctrl+click cell',     desc: 'Open Editor (Ev / Ie) (dev)',               dev: true  },
        { key: 'R-click cell',        desc: 'Context menu: T / V / E / D (dev)',         dev: true  },
        { key: 'Double-click text',   desc: 'Edit text slide (Xe) (dev)',                dev: true  },
      ]}
    ]
  },

  // ─── C / Cu — COLLECTION ────────────────────────────────────────────
  { id: 'C', title: 'C / Cu — Collection (c.json)', devOnly: false,
    desc: 'Saved grid layouts. Each entry maps cell positions to UIDs. Loading one sets which content appears in each grid slot.',
    sections: [
      { name: 'Hotkeys', items: [
        { key: 'G',      desc: 'Return to Grid',    dev: false },
        { key: 'T',      desc: 'Return to Table',   dev: true  },
        { key: 'Enter',  desc: 'Load selected config and go to Grid', dev: false },
        { key: 'Delete', desc: 'Delete selected config (dev)', dev: true },
      ]},
      { name: 'Mouse / Touch', items: [
        { key: 'Click row',   desc: 'Select config',                      dev: false },
        { key: 'Double-click', desc: 'Load config and go to Grid',         dev: false },
        { key: 'Swipe ← on row', desc: 'Delete config (dev)',             dev: true  },
      ]}
    ]
  },

  // ─── A — ANNOTATE ───────────────────────────────────────────────────
  { id: 'A', title: 'A — Annotate Panel', devOnly: true,
    desc: 'Right-side panel (340px) that shows and edits the metadata of the current T row. Auto-opens alongside Xe, Ev, and Ie. Navigation follows E screen arrow keys.',
    sections: [
      { name: 'Hotkeys', items: [
        { key: '↑ ↓ (in E screen)', desc: 'Navigate rows — A follows automatically', dev: true },
        { key: 'Tab (in Ev)',        desc: 'Jump focus to A\'s first field; Tab again cycles A fields', dev: true },
        { key: 'Ctrl+S (in A field)', desc: 'Save Annotate row',                     dev: true },
      ]},
      { name: 'Mouse', items: [
        { key: 'Type in tag field',       desc: 'Add tags by name or species',      dev: true },
        { key: 'R-click tag chip (in A)', desc: 'Menu: Copy tag / Dictionary / Filter / Remove from row', dev: true },
        { key: '✕ close button',          desc: 'Close A panel',                    dev: true },
        { key: '← / → buttons',           desc: 'Previous / Next row in A',         dev: true },
      ]}
    ]
  },

  // ─── Ev — VIDEO EDITOR ──────────────────────────────────────────────
  { id: 'Ev', title: 'Ev — Video Editor', devOnly: true,
    desc: 'Trim videos into start+duration segments with optional labels. Layout: video + timeline on left, Segment Selection panel in middle, Annotate (A) on the right. Saves to row.VidRange + VidComment.',
    sections: [
      { name: 'Hotkeys', items: [
        { key: 'Space',    desc: 'Play / Pause video',                      dev: true },
        { key: '← →',      desc: 'Step start time ±0.1s',                   dev: true },
        { key: '↑ ↓',      desc: 'Navigate to previous / next T row',       dev: true },
        { key: 'Tab',      desc: 'Focus first A field (or cycle in A)',      dev: true },
        { key: 'N / J',    desc: 'Next / Previous row (alias for ↑ ↓)',     dev: true },
        { key: 'M',        desc: 'Toggle mute (live session)',               dev: true },
        { key: 'S',        desc: 'Toggle Selected / Full playback',         dev: true },
        { key: 'C',        desc: 'Toggle closed captions',                  dev: true },
        { key: 'T',        desc: 'Save + return to Table',                  dev: true },
        { key: 'G',        desc: 'Save + go to Grid',                       dev: true },
        { key: 'Ctrl+S',   desc: 'Save current row',                        dev: true },
      ]},
      { name: 'Mouse', items: [
        { key: 'Click timeline',          desc: 'Scrub to position',                       dev: true },
        { key: 'Ctrl+click video',        desc: 'Add segment at current time',             dev: true },
        { key: 'Ctrl+click timeline band', desc: 'Delete segment',                         dev: true },
        { key: 'R-click segment tab',     desc: 'Rename / label segment',                 dev: true },
        { key: 'Swipe ← (Ev area)',       desc: 'Save + return to Table',                 dev: true },
      ]}
    ]
  },

  // ─── Xe — TEXT EDITOR ───────────────────────────────────────────────
  { id: 'Xe', title: 'Xe — HTML Text Editor', devOnly: true,
    desc: 'Rich-text editor for row.ftext. Auto-opens Annotate (A) on the right (340px). Arrows navigate rows. Close: X button or swipe-left on title bar.',
    sections: [
      { name: 'Hotkeys', items: [
        { key: '↑ ↓',           desc: 'Navigate to previous / next T row (saves current first)', dev: true },
        { key: 'S',              desc: 'Slide preview (auto-saves first) — only when text not focused', dev: true },
        { key: 'Ctrl+B / I / U', desc: 'Bold / Italic / Underline',              dev: true },
        { key: 'Ctrl+S',         desc: 'Save + close',                           dev: true },
        { key: 'Shift+Enter',    desc: 'Insert collapsible section (▶…). Inside summary: line-break. Enter alone in summary: jump to body.', dev: true },
        { key: 'Esc',            desc: 'Defocus text editor (arrows then navigate rows)', dev: true },
      ]},
      { name: 'Mouse / Touch', items: [
        { key: 'Swipe → title bar',  desc: 'Auto-save + preview slide (Xs)',     dev: true },
        { key: 'Swipe ← title bar',  desc: 'Auto-save + close Xe (back to T)',   dev: true },
        { key: '▶ Slide button',     desc: 'Auto-save + preview as Xs',          dev: true },
        { key: '✓ Save button',      desc: 'Save + close editor',                dev: true },
        { key: '✕ Close button',     desc: 'Close editor (unsaved changes lost)', dev: true },
        { key: 'Toolbar ▶… button',  desc: 'Insert empty collapsible section',   dev: true },
        { key: 'Toolbar 🖼 button',   desc: 'Insert image (UID or URL, size, alignment)', dev: true },
        { key: 'Dbl-click image',    desc: 'Edit image: size, alignment, source', dev: true },
      ]}
    ]
  },

  // ─── Ie — IMAGE EDITOR ──────────────────────────────────────────────
  { id: 'Ie', title: 'Ie — Image Editor (Ie)', devOnly: true,
    desc: 'Full-screen image view + Annotate panel. Reached via E key on an image row, or via arrow navigation in another E screen. Swipe-left to return to T.',
    sections: [
      { name: 'Hotkeys', items: [
        { key: '↑ ↓',  desc: 'Navigate to previous / next T row',        dev: true },
        { key: 'T',    desc: 'Return to Table (closes image + A)',        dev: true },
      ]},
      { name: 'Mouse / Touch', items: [
        { key: 'Swipe ← on image', desc: 'Return to T (closes A too)',   dev: true },
        { key: 'Pinch / pan',      desc: 'Zoom and pan image',           dev: false },
        { key: '✕ Close button',   desc: 'Return to T',                  dev: true },
      ]}
    ]
  },

  // ─── V — VIDEO PLAYER (FULLSCREEN) ──────────────────────────────────
  { id: 'V', title: 'V — Video Player (Fullscreen)', devOnly: false,
    desc: 'Full-screen playback of row.VidRange segments in sequence. Mute controlled by row Mute flag; M toggles live for this session.',
    sections: [
      { name: 'Hotkeys', items: [
        { key: 'Space', desc: 'Play / Pause',                  dev: false },
        { key: '← →',   desc: 'Frame-step ±0.1s',              dev: false },
        { key: 'M',     desc: 'Mute toggle (live)',            dev: false },
        { key: 'A / B', desc: 'Set loop points',               dev: false },
        { key: 'V',     desc: 'Close (toggle with same key that opened)', dev: false },
        { key: 'T',     desc: 'Return to Table (dev)',         dev: true  },
      ]},
      { name: 'Mouse / Touch', items: [
        { key: 'Swipe ← on image', desc: 'Close → back to grid', dev: false },
        { key: 'Bottom bar buttons', desc: 'Play / Pause / loop controls', dev: false },
      ]}
    ]
  },

  // ─── Xs — TEXT SLIDE VIEWER ─────────────────────────────────────────
  { id: 'Xs', title: 'Xs — Text Slide (Fullscreen View)', devOnly: false,
    desc: 'Read-only fullscreen view of an HTML/text slide. Reached by swipe-right on a text cell in G/Gu, or by the Slide button / swipe in Xe.',
    sections: [
      { name: 'Navigation', items: [
        { key: 'Swipe ← (top bar)', desc: 'Close Xs → back to Xe (if from editor)', dev: false },
        { key: '✕ Close button',    desc: 'Close Xs',                                dev: false },
      ]}
    ]
  },

  // ─── Q — QUIZ (FULLSCREEN) ──────────────────────────────────────────
  { id: 'Q', title: 'Q — Quiz (Fullscreen)', devOnly: false,
    desc: 'Interactive quiz cell. Reached by swipe-right or tap on a quiz cell in G/Gu.',
    sections: [
      { name: 'Mouse / Touch', items: [
        { key: 'Tap answer',  desc: 'Submit answer',         dev: false },
        { key: 'Swipe ←',     desc: 'Close → back to grid',  dev: false },
        { key: '✕ button',    desc: 'Close → back to grid',  dev: false },
      ]}
    ]
  },

  // ─── D — DICTIONARY ─────────────────────────────────────────────────
  { id: 'D', title: 'D — Dictionary', devOnly: true,
    desc: 'Tag hierarchy editor. Reach by pressing D (opens on focused row\'s first tag), or from a chip right-click menu.',
    sections: [
      { name: 'Hotkeys (in Dictionary)', items: [
        { key: 'T / G',    desc: 'Return to Table / Grid (closes Dictionary)', dev: true },
        { key: '↑ ↓',      desc: 'Move selection in tree',                     dev: true },
        { key: 'Enter',    desc: 'Expand / collapse selected node',             dev: true },
        { key: 'C / A',    desc: 'Cut / Paste node (C=cut, A=paste-as-child)', dev: true },
        { key: 'S',        desc: 'Paste as sibling',                           dev: true },
        { key: 'Delete',   desc: 'Delete selected node (with confirmation)',    dev: true },
      ]},
      { name: 'Mouse', items: [
        { key: 'Click node',    desc: 'Select',             dev: true },
        { key: 'Dbl-click',     desc: 'Rename node',        dev: true },
        { key: 'R-click node',  desc: 'Context menu (Cut / Paste / Delete / GBIF)', dev: true },
      ]}
    ]
  },
];

// HELP_PAGES order: 0=Hd, 1=Taxonomy, 2=Hu (desktop user), 3=Hum (mobile
// user). _isUserMode() + _isMobileDevice() pick which one opens by default.
// In dev mode all four pages are reachable via ◀ ▶ so the developer can
// audit what each audience actually sees.
const HELP_PAGES = [
  'Hd — Developer Reference',
  'Taxonomy (HALO + Phyla)',
  'Hu — Desktop User Reference',
  'Hum — Mobile User Reference'
];

// (dev0264) Heuristic: does this hotkey/gesture row apply on a phone?
// Hum drops keyboard-only items so the phone reader is not confused by
// shortcuts they have no way to trigger. The classification is structural,
// not per-item, so new HELP_DATA rows inherit the right behavior for free.
function _itemMobileOk(it, sectionName) {
  // Every item in a "Hotkeys" section is keyboard-only by definition.
  if (/hotkey/i.test(sectionName || '')) return false;
  const k = String(it.key || '').toLowerCase();
  // Touch idioms — always keep.
  if (/swipe|pinch|pan|tap|hold/.test(k)) return true;
  // Button presses translate one-to-one to taps on touch.
  if (/button/.test(k)) return true;
  // Right-click has no touch equivalent.
  if (/r-click|right.click/.test(k)) return false;
  // Modifier+click is a desktop pattern (no Ctrl/Shift on a phone).
  if (/ctrl|shift|alt|meta/.test(k)) return false;
  // Plain click / double-click → tap / double-tap.
  if (/click/.test(k)) return true;
  // Typing into a field works (mobile keyboard pops up).
  if (/^type /.test(k)) return true;
  // Anything else (Space, Tab, ↑↓, letter keys) — keyboard, skip.
  return false;
}

// Render Hd page 0 from HELP_DATA. Two-column responsive layout; each
// section gets a panel with its hotkeys and mouse rows.
function _renderHd() {
  const root = document.getElementById('helpPage0');
  if (!root) return;
  const escH = (s) => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const panel = (s) => {
    let html = '<div style="background:#0d0d1e;border:1px solid #2a2a4a;border-radius:8px;padding:11px 13px;margin-bottom:10px;">';
    html += '<h3 style="color:#fa8;font-size:12px;margin:0 0 4px;letter-spacing:0.05em;">' + escH(s.title) + '</h3>';
    if (s.desc) html += '<p style="color:#778;font-size:10px;margin:0 0 8px;line-height:1.45;">' + escH(s.desc) + '</p>';
    s.sections.forEach(sec => {
      html += '<div style="margin-top:6px;color:#556;font-size:10px;letter-spacing:0.05em;">' + escH(sec.name.toUpperCase()) + '</div>';
      html += '<table style="border-collapse:collapse;width:100%;font-size:11px;margin-bottom:4px;">';
      sec.items.forEach(it => {
        html += '<tr><td style="padding:2px 8px 2px 0;color:#8ef;white-space:nowrap;vertical-align:top;">' + escH(it.key) + '</td>'
              + '<td style="padding:2px 0;color:#ccc;">' + escH(it.desc) + '</td></tr>';
      });
      html += '</table>';
    });
    html += '</div>';
    return html;
  };
  let html = '<p style="color:#667;font-size:11px;margin-bottom:14px;line-height:1.55;">'
           + '<strong style="color:#8ef;">' + escH(HELP_VERSION_STR) + '</strong> · '
           + 'Developer reference: every screen, every shortcut. '
           + 'Use ◀ ▶ to switch to taxonomy or to preview the user help (Hu). '
           + 'Click <strong style="color:#5fa;">⬇ Download</strong> above to save a merged Hd+Hu reference as an HTML file (dev-only commands shown <strong>bold</strong>).</p>';
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:10px;">';
  // (dev0264) Hd skips mobileOnly intro screens — devs work from desktop.
  HELP_DATA.forEach(s => { if (!s.mobileOnly) html += panel(s); });
  html += '</div>';
  root.innerHTML = html;
}

// Render Hu page 2: user-relevant items only (skip devOnly screens entirely;
// inside the rest, drop items where dev:true).
function _renderHu() {
  const root = document.getElementById('helpPage2');
  if (!root) return;
  const escH = (s) => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const panel = (s) => {
    // Filter sections to user-only items
    const filteredSections = s.sections.map(sec => ({
      name: sec.name,
      items: sec.items.filter(it => it.dev === false)
    })).filter(sec => sec.items.length > 0);
    if (filteredSections.length === 0) return ''; // nothing left for the user
    let html = '<div style="background:#0d0d1e;border:1px solid #2a2a4a;border-radius:8px;padding:11px 13px;margin-bottom:10px;">';
    html += '<h3 style="color:#fa8;font-size:12px;margin:0 0 4px;letter-spacing:0.05em;">' + escH(s.title) + '</h3>';
    if (s.desc) html += '<p style="color:#778;font-size:10px;margin:0 0 8px;line-height:1.45;">' + escH(s.desc) + '</p>';
    filteredSections.forEach(sec => {
      html += '<div style="margin-top:6px;color:#556;font-size:10px;letter-spacing:0.05em;">' + escH(sec.name.toUpperCase()) + '</div>';
      html += '<table style="border-collapse:collapse;width:100%;font-size:11px;margin-bottom:4px;">';
      sec.items.forEach(it => {
        html += '<tr><td style="padding:2px 8px 2px 0;color:#8ef;white-space:nowrap;vertical-align:top;">' + escH(it.key) + '</td>'
              + '<td style="padding:2px 0;color:#ccc;">' + escH(it.desc) + '</td></tr>';
      });
      html += '</table>';
    });
    html += '</div>';
    return html;
  };
  let html = '<p style="color:#667;font-size:11px;margin-bottom:14px;line-height:1.55;">'
           + '<strong style="color:#8ef;">' + escH(HELP_VERSION_STR.replace('dev','user')) + '</strong> · '
           + 'Quick reference for using SeeAndLearn. '
           + 'Tap a cell to play/pause, swipe right to view full-screen, swipe left to return.</p>';
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:10px;">';
  HELP_DATA.forEach(s => {
    if (s.devOnly) return;     // skip dev-only screens entirely in user help
    if (s.mobileOnly) return;  // (dev0264) skip phone-only intro on desktop
    const block = panel(s);
    if (block) html += block;
  });
  html += '</div>';
  root.innerHTML = html;
}

// (dev0264) Render Hum page 3: phone-user view. Same shape as Hu but also
// strips items where _itemMobileOk() says it doesn't apply on touch — so
// keyboard hotkeys and right-click rows disappear, leaving only taps,
// swipes, pinches, and buttons.
function _renderHum() {
  const root = document.getElementById('helpPage3');
  if (!root) return;
  const escH = (s) => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const panel = (s) => {
    const filteredSections = s.sections.map(sec => ({
      name: sec.name,
      items: sec.items.filter(it => it.dev === false && _itemMobileOk(it, sec.name))
    })).filter(sec => sec.items.length > 0);
    if (filteredSections.length === 0) return '';
    let html = '<div style="background:#0d0d1e;border:1px solid #2a2a4a;border-radius:8px;padding:11px 13px;margin-bottom:10px;">';
    html += '<h3 style="color:#fa8;font-size:13px;margin:0 0 4px;letter-spacing:0.05em;">' + escH(s.title) + '</h3>';
    if (s.desc) html += '<p style="color:#778;font-size:11px;margin:0 0 8px;line-height:1.5;">' + escH(s.desc) + '</p>';
    filteredSections.forEach(sec => {
      html += '<div style="margin-top:6px;color:#556;font-size:11px;letter-spacing:0.05em;">' + escH(sec.name.toUpperCase()) + '</div>';
      html += '<table style="border-collapse:collapse;width:100%;font-size:12px;margin-bottom:4px;">';
      sec.items.forEach(it => {
        html += '<tr><td style="padding:4px 8px 4px 0;color:#8ef;white-space:nowrap;vertical-align:top;">' + escH(it.key) + '</td>'
              + '<td style="padding:4px 0;color:#ddd;line-height:1.4;">' + escH(it.desc) + '</td></tr>';
      });
      html += '</table>';
    });
    html += '</div>';
    return html;
  };
  let html = '<p style="color:#667;font-size:12px;margin-bottom:14px;line-height:1.55;">'
           + '<strong style="color:#8ef;">' + escH(HELP_VERSION_STR.replace('dev','user')) + '</strong> · '
           + 'Phone quick reference. Everything here works with taps and swipes — no keyboard required.</p>';
  // Single column on phones; auto-fit will widen on tablets.
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px;">';
  HELP_DATA.forEach(s => {
    if (s.devOnly) return;
    const block = panel(s);
    if (block) html += block;
  });
  html += '</div>';
  root.innerHTML = html;
}

// Build a standalone HTML file (Hd + Hu merged, dev rows bolded) and trigger
// a browser download. No external CSS — everything inline so it prints
// cleanly anywhere. Filename embeds the version (HELP_VERSION_STR).
function _downloadHelp() {
  const escH = (s) => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let body = '';
  body += '<h1 style="color:#234;border-bottom:2px solid #69c;padding-bottom:6px;">SeeAndLearn — Help Reference</h1>';
  body += '<p style="color:#666;font-style:italic;">Version ' + escH(HELP_VERSION_STR)
        + ' · merged developer + user reference.<br>'
        + '<strong>Developer-only commands shown in bold</strong>; commands available to everyone are in normal type.</p>';
  HELP_DATA.forEach(s => {
    body += '<h2 style="color:#345;margin-top:22px;border-bottom:1px solid #ccd;padding-bottom:3px;">'
          + escH(s.title)
          + (s.devOnly ? ' <span style="font-size:11px;color:#a44;font-weight:normal;">[developer-only screen]</span>' : '')
          + '</h2>';
    if (s.desc) body += '<p style="color:#555;">' + escH(s.desc) + '</p>';
    s.sections.forEach(sec => {
      body += '<h3 style="color:#456;margin-top:10px;">' + escH(sec.name) + '</h3>';
      body += '<table style="border-collapse:collapse;width:100%;margin-bottom:6px;">';
      sec.items.forEach(it => {
        const style = it.dev
          ? 'font-weight:bold;color:#234;'
          : 'color:#345;';
        body += '<tr>'
              + '<td style="padding:3px 12px 3px 0;white-space:nowrap;vertical-align:top;width:170px;border-bottom:1px solid #eef;' + style + '">'
              + escH(it.key) + (s.devOnly || it.dev ? '' : '') + '</td>'
              + '<td style="padding:3px 0;border-bottom:1px solid #eef;' + style + '">'
              + escH(it.desc) + '</td>'
              + '</tr>';
      });
      body += '</table>';
    });
  });
  const html = '<!DOCTYPE html><html><head><meta charset="UTF-8">'
             + '<title>SeeAndLearn Help — ' + escH(HELP_VERSION_STR) + '</title>'
             + '</head><body style="font-family:Georgia,serif;max-width:900px;margin:24px auto;padding:0 20px;color:#222;background:#fff;">'
             + body
             + '<hr style="margin-top:32px;border:none;border-top:1px solid #ccd;">'
             + '<p style="color:#888;font-size:11px;text-align:center;">Generated from in-app help · ' + new Date().toLocaleString() + '</p>'
             + '</body></html>';
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'SeeAndLearn_Help_' + HELP_VERSION_STR + '.html';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  if (typeof toast === 'function') toast('⬇ Help downloaded as HTML', 1500);
}

function showHelpPage(p) {
  // (zip0154/dev0264) User mode → pin to Hu (page 2) on desktop or Hum
  // (page 3) on phones. Dev mode walks all four pages freely.
  const userMode = (typeof _isUserMode === 'function') ? _isUserMode() : false;
  const onPhone  = (typeof _isMobileDevice === 'function') ? _isMobileDevice() : false;
  if (userMode) {
    p = onPhone ? 3 : 2;
  } else {
    p = Math.max(0, Math.min(HELP_PAGES.length - 1, p));
  }
  _helpPage = p;
  document.getElementById('helpTitle').textContent = HELP_PAGES[_helpPage];
  document.getElementById('helpPageIndicator').textContent =
    userMode
      ? (onPhone ? 'Mobile user reference' : 'Desktop user reference')
      : 'Page '+(_helpPage+1)+' of '+HELP_PAGES.length+' — use ◀ ▶ or ← → to navigate';
  document.getElementById('helpPage0').style.display = _helpPage === 0 ? 'block' : 'none';
  document.getElementById('helpPage1').style.display = _helpPage === 1 ? 'block' : 'none';
  document.getElementById('helpPage2').style.display = _helpPage === 2 ? 'block' : 'none';
  const p3 = document.getElementById('helpPage3');
  if (p3) p3.style.display = _helpPage === 3 ? 'block' : 'none';
  // Nav arrows: hide entirely in user mode (no navigation), dim at edges in dev.
  const prev = document.getElementById('helpPrev');
  const next = document.getElementById('helpNext');
  if (userMode) {
    prev.style.display = 'none'; next.style.display = 'none';
  } else {
    prev.style.display = ''; next.style.display = '';
    prev.style.opacity = _helpPage === 0 ? '0.3' : '1';
    next.style.opacity = _helpPage === HELP_PAGES.length - 1 ? '0.3' : '1';
  }
  // Download button: visible only on Hd (page 0). Hidden on taxonomy + Hu + Hum.
  document.getElementById('helpDownload').style.display = (!userMode && _helpPage === 0) ? '' : 'none';
  // Lazy-render panels on first show (and on every show — cheap).
  if (_helpPage === 0) _renderHd();
  if (_helpPage === 1) buildPhylaTable();
  if (_helpPage === 2) _renderHu();
  if (_helpPage === 3) _renderHum();
}

function closeHelp() { document.getElementById('helpModal').style.display = 'none'; }
function openHelp()  {
  // (zip0154/dev0264) User mode opens directly to Hu on desktop or Hum
  // on a phone. Dev mode opens to whatever page was last viewed (default 0 = Hd).
  const userMode = (typeof _isUserMode === 'function') ? _isUserMode() : false;
  const onPhone  = (typeof _isMobileDevice === 'function') ? _isMobileDevice() : false;
  if (userMode) _helpPage = onPhone ? 3 : 2;
  document.getElementById('helpModal').style.display = 'flex';
  showHelpPage(_helpPage);
}
function isHelpOpen(){ return document.getElementById('helpModal').style.display === 'flex'; }

// ══════════════════════════════════════════════════════════════════════════════
// (dev0353) T HOTKEY HELP — the Table toolbar's ? Help button now opens a
// dedicated reference of every hotkey active while the Table screen is up,
// instead of the species/HALO taxonomy pages (still reachable via the H key).
// ══════════════════════════════════════════════════════════════════════════════
const T_HOTKEY_HELP = [
  { group: 'Switch screen', keys: [
    ['G', 'Grid'],
    ['E', 'Edit the focused row (video / text / image editor)'],
    ['A', 'Annotate — tag panel for the focused row'],
    ['V', 'View the focused row fullscreen'],
    ['C', 'Collections — c.json grid configs'],
    ['D', 'Dictionary — tag tree (jumps to the focused row’s first tag)'],
    ['M', 'Main menu (hamburger)'],
    ['H', 'Help — species / HALO taxonomy pages'],
    ['Q', 'Local-media table (q.html, opens in a new tab)'],
    ['R', 'Slideshow — Review mode'],
  ]},
  { group: 'Rows & cells', keys: [
    ['↑ / ↓', 'Move the row focus (respects the active filter + sort)'],
    ['Double-click', 'Edit a cell inline (the tags column opens Annotate instead)'],
    ['Shift+click', 'Select a range down one column, then type to bulk-set'],
    ['Delete', 'Delete the focused row → archived to deleted.json'],
    ['Ctrl+D', 'Duplicate the focused row'],
    ['Alt+R', 'Re-sort by DateModified — newest rows to the top'],
    ['Ctrl+I', 'Toggle a floating preview of the focused row (Space = play/pause)'],
    ['Esc', 'Clear focus / selection (inside a field: just unfocus it)'],
  ]},
  { group: 'Filter & import', keys: [
    ['F', 'Filter modal — tags ∧ text search (VidAuthor / VidTitle / link / ftext)'],
    ['Shift+F', 'Clear all filters instantly'],
    ['W  or  L', 'Smart clipboard import — bare media links, or @channel + CSV'],
  ]},
];

function closeTHelp() {
  const el = document.getElementById('tHelpOverlay');
  if (el) el.remove();
  document.removeEventListener('keydown', _tHelpKey, true);
}
function _tHelpKey(e) {
  // (dev0355) Any keystroke dismisses the T-hotkey help. Ignore bare modifier
  // taps (Shift/Ctrl/Alt/Meta) so holding a modifier to read doesn't close it;
  // the actual key that follows will. Swallow the dismissing key so it doesn't
  // also trigger its T-screen action.
  if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
  e.preventDefault(); e.stopPropagation();
  closeTHelp();
}
function openTHelp() {
  closeTHelp(); // never stack two
  const ov = document.createElement('div');
  ov.id = 'tHelpOverlay';
  ov.style.cssText = 'position:fixed;inset:0;z-index:19999;background:rgba(0,0,0,0.82);'
    + 'display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:16px;';
  let inner = '<div style="background:#12121e;border:2px solid #4af;border-radius:10px;'
    + 'width:min(98vw,760px);padding:20px 24px;font-family:monospace;position:relative;">'
    + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">'
    + '<h2 style="color:#8ef;font-size:15px;flex:1;margin:0;letter-spacing:0.04em;">Table (T) — Hotkeys</h2>'
    + '<button id="tHelpClose" style="background:none;border:1px solid #f66;color:#f66;'
    + 'border-radius:4px;cursor:pointer;font-size:13px;padding:2px 10px;">✕ Esc</button></div>';
  T_HOTKEY_HELP.forEach(sec => {
    inner += '<div style="color:#fc9;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;'
      + 'margin:14px 0 6px;opacity:0.85;">' + escH(sec.group) + '</div>'
      + '<table style="border-collapse:collapse;width:100%;">';
    sec.keys.forEach(([k, d]) => {
      inner += '<tr>'
        + '<td style="padding:3px 14px 3px 0;white-space:nowrap;vertical-align:top;width:140px;">'
        + '<span style="display:inline-block;background:#1d2740;border:1px solid #3a4a6a;'
        + 'border-radius:4px;color:#8ef;padding:1px 8px;font-weight:bold;">' + escH(k) + '</span></td>'
        + '<td style="padding:3px 0;color:#cdd;line-height:1.4;">' + escH(d) + '</td></tr>';
    });
    inner += '</table>';
  });
  inner += '</div>';
  ov.innerHTML = inner;
  ov.addEventListener('click', e => { if (e.target === ov) closeTHelp(); });
  document.body.appendChild(ov);
  document.getElementById('tHelpClose').addEventListener('click', closeTHelp);
  document.addEventListener('keydown', _tHelpKey, true);
}
function isTHelpOpen() { return !!document.getElementById('tHelpOverlay'); }

document.getElementById('helpBtn').addEventListener('click', () => { isTHelpOpen() ? closeTHelp() : openTHelp(); });
document.getElementById('helpClose').addEventListener('click', closeHelp);
document.getElementById('helpPrev').addEventListener('click', () => showHelpPage(_helpPage - 1));
document.getElementById('helpNext').addEventListener('click', () => showHelpPage(_helpPage + 1));
// (zip0154) Download button — exports merged Hd+Hu reference as HTML
document.getElementById('helpDownload').addEventListener('click', _downloadHelp);
document.getElementById('helpModal').addEventListener('click', e => {
  if (e.target === document.getElementById('helpModal')) closeHelp();
});
document.getElementById('helpModal').addEventListener('dblclick', e => {
  if (!e.target.closest('#helpBox')) closeHelp();
});
document.getElementById('helpModal').addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft')  { e.stopPropagation(); showHelpPage(_helpPage - 1); }
  if (e.key === 'ArrowRight') { e.stopPropagation(); showHelpPage(_helpPage + 1); }
  if (e.key === 'Escape')     { e.stopPropagation(); closeHelp(); }
});
// tabindex so helpModal can receive key events
document.getElementById('helpModal').setAttribute('tabindex', '-1');
// Focus helpModal on open so arrow keys work
const _origOpenHelp = openHelp;
// already defined above, patch to focus after open
document.getElementById('helpBtn').addEventListener('click', () => {
  setTimeout(() => { if (isHelpOpen()) document.getElementById('helpModal').focus(); }, 30);
}, true);

// Double-click on VE overlay closes it (video.js adds it dynamically so use delegation)
// (zip0131) Removed: double-click anywhere in E used to close it. That was
// surprising and conflicted with the new dblclick-to-mark-segment workflow.
// E now closes only via T/G/A/Esc hotkeys, the X button, or right-to-left
// swipe (added in zip0123).
document.body.addEventListener('dblclick', e => {
  // Double-click on Browse overlay background closes it
  const br = document.getElementById('browseOverlay');
  if (br && e.target === br) { brSave(); brClose(); }
});

// Table-level shortcut keys: b=browse, h=help
// (fires only when table is visible and no modal is open)
document.addEventListener('keydown', e => {
  const tableVisible = !isHelpOpen()
    && !document.getElementById('video-editor-overlay')
    && !document.getElementById('textEditorOverlay')   // (zip0134) gate H when text editor open
    && !document.getElementById('teSlideOverlay')      // (zip0134) gate when slide preview open
    && document.getElementById('gridOverlay')?.style.display !== 'flex';
  const tag = document.activeElement && document.activeElement.tagName;
  const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    || (document.activeElement && document.activeElement.isContentEditable);  // (zip0134)

  // (zip0186) Global Escape: defocus only — no window close from Esc anywhere.
  // The per-editable blur is handled earlier (line ~124). Nothing extra needed.

  if (!tableVisible || inField || e.ctrlKey || e.metaKey || e.altKey) return;

  // h → toggle Help
  if (e.key === 'h' || e.key === 'H') {
    e.preventDefault(); isHelpOpen() ? closeHelp() : openHelp();
    return;
  }
  // r → open ssmenu in Review mode (local-media triage; see localmedia-design.md)
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    if (typeof slideshowOpenSourceFolder === 'function') {
      slideshowOpenSourceFolder(true, 'review');
    } else if (typeof toast === 'function') {
      toast('Slideshow not loaded yet', 1500);
    }
    return;
  }
  // (dev0305/0306) q → open Q-screen (local-media table; see
  // localmedia-design.md). Opens in a new tab so T state isn't lost.
  // Left-hand mnemonic mirror of T (far-right).
  if (e.key === 'q' || e.key === 'Q') {
    e.preventDefault();
    // (dev0315) q.html is the dev local-media table — never expose it on
    // the public site.
    if (typeof _isUserMode === 'function' && _isUserMode()) return;
    window.open('q.html', '_blank', 'noopener');
    return;
  }
}, true); // capture phase so it runs before other handlers
