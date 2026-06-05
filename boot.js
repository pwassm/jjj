// Patch save() — in C mode writes c.json, skips ml.json localStorage
const _realSave = save;
save = function() {
  if (!_cMode) { _realSave(); return; }
  _cCols=cols.slice(); _cHidden=new Set(hidden); _cColWidths=Object.assign({},colWidths);
  _cMeta._salColOrder=_cCols; _cMeta._salHidden=[..._cHidden]; _cMeta._salColWidths=_cColWidths;
  if (_cMeta._salViews) metaRow._salViews=_cMeta._salViews;
  cSaveToFile(); cUpdateStatus();
};

// Patch updateShowAllBtn for C-mode filter buttons
const _origUSAB = updateShowAllBtn;
updateShowAllBtn = function() {
  _origUSAB();
  if (_cMode) {
    const cf=document.getElementById('cFilterBtn'), ccf=document.getElementById('cClearFilterBtn');
    if (cf&&ccf) {
      if (focus!==null) {
        const vc=visCols(),col=vc[focus.c];
        const val=col!==undefined?String(data[vr(focus.r)]?.[col]??''):'';
        cf.style.display='inline-block'; cf.title='Filter: "'+col+'"="'+val+'"';
      } else { cf.style.display='none'; }
      ccf.style.display=rowFilter?'inline-block':'none';
    }
    document.getElementById('filterBtn').style.display='none';
    document.getElementById('clearFilterBtn').style.display='none';
  }
};

// Wire C-toolbar buttons
document.getElementById('cCloseBtn').addEventListener('click', closeCScreen);
document.getElementById('cGridBtn').addEventListener('click', ()=>{ closeCScreen(); gridShow(); });
document.getElementById('cMakeActiveBtn').addEventListener('click', cMakeActive);
document.getElementById('cDeleteBtn').addEventListener('click', cDeleteSelected);
document.getElementById('cShowAllBtn').addEventListener('click', ()=>{
  hidden.clear(); _cHidden.clear(); _cMeta._salHidden=[];
  cSaveToFile(); render(); cUpdateStatus();
});
document.getElementById('cViewsBtn').addEventListener('click', openViewsPanel);
document.getElementById('cFilterBtn').addEventListener('click', ()=>{
  if (focus!==null) {
    const vc=visCols(),col=vc[focus.c];
    const val=col!==undefined?String(data[vr(focus.r)]?.[col]??''):'';
    if (col) { rowFilter={col,val}; _cRowFilter=rowFilter; }
  }
  render(); cUpdateStatus();
  document.getElementById('cFilterBtn').style.display='none';
  document.getElementById('cClearFilterBtn').style.display='inline-block';
});
document.getElementById('cClearFilterBtn').addEventListener('click', ()=>{
  rowFilter=null; _cRowFilter=null;
  render(); cUpdateStatus();
  document.getElementById('cClearFilterBtn').style.display='none';
});

// C-screen keyboard handler
document.addEventListener('keydown', e => {
  if (!_cMode) return;
  const tag=document.activeElement?.tagName;
  if (tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT') return;
  // (zip0186) Esc no longer closes C — use T or G hotkeys.
  if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase()==='t') { e.preventDefault(); closeCScreen(); return; }
  if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase()==='g') { e.preventDefault(); closeCScreen(); gridShow(); return; }
  if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase()==='m') { e.preventDefault(); cMakeActive(); return; }
  if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key==='Enter') { e.preventDefault(); cMakeActive(); return; }
  if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key==='Delete') { e.preventDefault(); cDeleteSelected(); return; }
}, true);

// C-screen Ctrl+click on table row → MakeActive→G for that row
document.addEventListener('click', e => {
  if (!_cMode || !e.ctrlKey) return;
  // Find the clicked cell's vi from the closest <td> with data-vi
  const td = e.target.closest('td[data-vi]');
  if (!td) return;
  const vi = parseInt(td.getAttribute('data-vi'), 10);
  if (isNaN(vi)) return;
  e.preventDefault(); e.stopPropagation();
  // Focus+check the row, then activate
  focus = { r: vi, c: 0 };
  checkedRows.clear();
  checkedRows.add(vr(vi));
  cMakeActive();
}, true);

// Compatibility shims for grid code that still calls old TG names.
// (Kept: showGridList & closeGridList — referenced by C-screen open paths.
// Removed in zip0124: renderGridList, saveTgMeta, saveTgToFile,
// activateGridConfig — none had any callers in the current codebase.)
async function showGridList()   { openCScreen(); }
function closeGridList()        { closeCScreen(); }

// (zip0140) Mobile / web-deploy entry point.
//
// URL params:
//   ?screen=g  → open directly to G (Grid) on load
//   ?screen=c  → open directly to C (mobile config picker) on load
//   ?screen=t  → open to T (Table) — explicit dev mode override
// Auto-detection: on touch devices with no ?screen= param, default to G.
function _isMobileDevice() {
  const uaMobile = /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(navigator.userAgent);
  const coarse   = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  return uaMobile || (coarse && window.innerWidth < 1100);
}

// (zip0141) User-mode detection. The user version (Gu/Cu) ships to GitHub
// Pages and other public hosts; the dev version runs from localhost or the
// local filesystem. Detection is hostname-based so the same files work in
// both contexts with no build step:
//   - localhost / 127.x / 0.0.0.0       → DEV
//   - file:// (empty hostname)           → DEV   (running off m:\jjj etc.)
//   - private LAN IPs (192.168.*, 10.*)  → DEV
//   - everything else (github.io, …)     → USER
//
// Two URL overrides exist for testing:
//   ?mode=user  → force user mode (works on localhost)
//   ?mode=dev   → force dev   mode (works on github.io)
//
// In user mode, a `user-mode` class is added to <html> so CSS can hide
// dev-only chrome (T/C/Name buttons in G, etc.), and runtime hooks skip
// dev-only interactions (right-click cut/paste, hold-to-cut, dblclick to
// open the text editor). See _applyUserModeChromeOnGrid() and the
// gridWireInteractor() guards.
function _isUserMode() {
  if (window._userModeCached !== undefined) return window._userModeCached;
  const params = new URLSearchParams(window.location.search);
  const force = params.get('mode');
  if (force === 'user') { window._userModeCached = true;  return true;  }
  if (force === 'dev')  { window._userModeCached = false; return false; }

  // (dev0316) Hostname-first: production hosts (sealifeandmore.com,
  // github.io, etc.) ALWAYS force user mode and IGNORE any stale
  // 'sal-mode-override' in localStorage. Without this, a developer who
  // previously hit the dev/user toggle badge on the public site would
  // be stuck in dev mode there forever — which is exactly the symptom
  // observed on slam.com booting "dev0315". The override is also
  // purged so it can't follow back into a future dev test.
  const h = (window.location.hostname || '').toLowerCase();
  const isLocalHost = (
    h === '' || h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0'
    || /^192\.168\./.test(h) || /^10\./.test(h)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
  if (!isLocalHost) {
    try { localStorage.removeItem('sal-mode-override'); } catch (e) {}
    window._userModeCached = true;
    return true;
  }

  // Local host: honour the localStorage toggle, then fall back to
  // mobile-UA heuristic (phones on the dev LAN default to user mode),
  // then default to dev.
  try {
    const ls = localStorage.getItem('sal-mode-override');
    if (ls === 'user') { window._userModeCached = true;  return true;  }
    if (ls === 'dev')  { window._userModeCached = false; return false; }
  } catch (e) { /* localStorage unavailable */ }
  if (_isMobileDevice()) { window._userModeCached = true; return true; }
  window._userModeCached = false;
  return false;
}

// (zip0141) Mark <html> with the mode class as early as possible so any
// CSS gates (e.g. .user-mode #gridSrcT { display:none }) take effect on
// first paint. Called immediately on script load below.
function _markUserModeClass() {
  document.documentElement.classList.toggle('user-mode', _isUserMode());
  document.documentElement.classList.toggle('dev-mode', !_isUserMode());
}
_markUserModeClass();

// (dev0249) Deep-link mode classes — set BEFORE first paint so the
// table/toolbar chrome never flashes into view while we wait for data.
// CSS rules tied to these classes hide the relevant surfaces:
//   html.deep-uid   — any ?i=NNN link (hides T chrome during routing)
//   html.locked-mode — ?i=NNN without /unlock (hides nav permanently;
//                      viewer can only see the one item)
(function _markDeepLinkClass() {
  try {
    const p = new URLSearchParams(window.location.search);
    function strip(raw) {
      const hasUnlock = raw.toLowerCase().endsWith('/unlock');
      const val = hasUnlock ? raw.slice(0, raw.lastIndexOf('/')).trim() : raw;
      return { val, hasUnlock };
    }
    const iRaw = (p.get('i') || '').trim();
    if (iRaw) {
      const { val: uid, hasUnlock } = strip(iRaw);
      if (uid) {
        document.documentElement.classList.add('deep-uid');
        if (!hasUnlock) {
          document.documentElement.classList.add('locked-mode');
          window._lockedUid = uid;
        }
        window._deepUid = uid;
        window._deepUnlocked = hasUnlock;
      }
    }
    // (dev0253) Config deep-link: `?c=NAME` opens G with that c.json
    // config activated. `?c=NAME/unlock` leaves the Configs picker
    // visible; bare form hides nav (same locked-mode CSS as ?i=).
    const cRaw = (p.get('c') || '').trim();
    if (cRaw) {
      const { val: name, hasUnlock } = strip(cRaw);
      if (name) {
        if (!hasUnlock) {
          document.documentElement.classList.add('locked-mode');
          window._lockedConfig = name;
        }
        window._deepConfig = name;
        window._deepConfigUnlocked = hasUnlock;
      }
    }
    // (dev0267) Slideshow deep-link: `?ss=ID` finds the c.json row whose
    // `ss` field equals ID, activates that grid, then auto-launches the
    // slideshow over it. /unlock suffix leaves G visible after the user
    // closes the slideshow; bare form keeps locked-mode.
    const ssRaw = (p.get('ss') || '').trim();
    if (ssRaw) {
      const { val: ssId, hasUnlock } = strip(ssRaw);
      if (ssId) {
        if (!hasUnlock) {
          document.documentElement.classList.add('locked-mode');
        }
        window._deepSs = ssId;
        window._deepSsUnlocked = hasUnlock;
      }
    }
  } catch (e) { /* URL parse error — fall through to normal boot */ }
})();

// (dev0315) Hide the routing query from the address bar on the public site.
// After _markDeepLinkClass has captured the deep-link target into
// window._deepUid / _deepConfig / _deepSs, rewrite the URL back to the
// pretty slug (e.g. /share) that 404.html stashed — or, for a bare typed
// ?i= link, just drop the query. This keeps ?i=NNN / ?ss= / ?c= out of the
// bar so visitors can't see (and guess at) how to reach other items.
// User mode only — dev keeps the query for debugging. Runs before
// _routeInitialScreen, which reads the window._deep* vars (not the query),
// so routing is unaffected.
(function _restorePrettyUrl() {
  try {
    if (typeof _isUserMode === 'function' && !_isUserMode()) return;
    if (!(window._deepUid || window._deepConfig || window._deepSs)) return;
    if (!(window.history && history.replaceState)) return;
    var pretty = null;
    try {
      pretty = sessionStorage.getItem('sal-pretty');
      sessionStorage.removeItem('sal-pretty');
    } catch (e) {}
    history.replaceState(null, '', pretty || window.location.pathname);
  } catch (e) { /* replaceState unavailable — leave URL as-is */ }
})();

// ── (zip0154) Dev/User mode toggle badge ─────────────────────────────────────
// The bottom-right badge used to be a non-interactive version label. It's
// now a button that:
//   • shows the current mode + version  ("dev0154" or "user0154")
//   • on click, writes the OPPOSITE mode to localStorage and reloads
//     the page so all init paths (CSS gates, function caches, chrome
//     hide/show) re-run cleanly. Reload is the simplest way to ensure
//     every "is this user mode?" check sees the new value.
(function _wireModeBadge() {
  const badge = document.getElementById('ver-badge');
  if (!badge) return;
  const isUser = _isUserMode();
  // (dev0316) Hide the badge entirely in user mode — it leaked the dev
  // mechanism (a single click reloaded into dev0XXX with all dev tooling
  // exposed). Users have no need for a version chip; devs still see and
  // can click it on localhost.
  if (isUser) {
    badge.style.display = 'none';
    return;
  }
  const ver = (typeof HELP_VERSION_STR === 'string')
    ? HELP_VERSION_STR.replace(/^(dev|user)/, '')
    : '0154';
  badge.textContent = 'dev' + ver;
  badge.title = 'Dev mode (' + badge.textContent + ') — click to switch to user mode (reloads)';
  badge.addEventListener('click', function() {
    try { localStorage.setItem('sal-mode-override', 'user'); } catch(e) {}
    if (typeof toast === 'function') toast('Switching to user mode…', 600);
    setTimeout(() => window.location.reload(), 250);
  });
})();

// (zip0141) Hide the dev-only floating buttons on G when in user mode,
// and force the Configs button to be visible whenever G is open (not just
// on mobile). Idempotent — safe to call multiple times.
function _applyUserModeChromeOnGrid() {
  if (!_isUserMode()) return;
  // Hide dev-only G-screen floating buttons. Per spec, the only floating
  // buttons on Gu should be the zip badge (bottom-right) and Configs
  // (bottom-left).
  ['gridNameBtn', 'gridSrcT', 'gridSrcC', 'gridBackBtn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  // The whole gridControls cluster is now empty in user mode → hide it
  // so it doesn't take up layout space / catch stray taps.
  const ctrls = document.getElementById('gridControls');
  if (ctrls) ctrls.style.display = 'none';
}

// (zip0143) Inline-SVG mute/unmute icon. Used to replace the 🔊 / 🔇
// emoji which has a slash too thin to read at small sizes. The muted
// icon draws a bold red diagonal stroke over the speaker, plus a thin
// dark outline so it stays visible against any button colour.
//   muteIconHTML(true)  → speaker with thick red slash
//   muteIconHTML(false) → speaker only
// 18px square fits the existing 14px-font-size button slots.
//
// (zip0144) `pointer-events:none` on the <svg> is required for Opera
// Mini and a few older mobile browsers — without it, taps on the SVG
// child paths/lines don't bubble to the parent <button>, so the mute
// click silently fails AND the underlying video iframe sometimes gets
// the tap instead (which is why the video appeared to "stop and not
// restart" on Opera Mini in 0143). With pointer-events:none on the
// SVG, the entire button surface is clickable as a unit.
window.muteIconHTML = function(isMuted) {
  const speaker = '<path d="M3 7v6h3l5 4V3L6 7H3z" fill="currentColor"/>';
  const svgOpen = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" '
    + 'viewBox="0 0 20 20" style="vertical-align:middle;display:inline-block;'
    + 'pointer-events:none;">';
  if (!isMuted) {
    return svgOpen
      + speaker
      + '<path d="M14 6.5c1.4 1 1.4 6 0 7" stroke="currentColor" stroke-width="1.5" '
      + 'fill="none" stroke-linecap="round"/>'
      + '<path d="M16 4.5c2.6 1.8 2.6 9.2 0 11" stroke="currentColor" stroke-width="1.5" '
      + 'fill="none" stroke-linecap="round"/>'
      + '</svg>';
  }
  // Muted: speaker with a thick, high-contrast red slash. The dark
  // backing stroke (#000) sits under the red so the slash is readable
  // against red/orange/grey button backgrounds alike.
  return svgOpen
    + speaker
    + '<line x1="2" y1="2" x2="18" y2="18" stroke="#000" stroke-width="5" stroke-linecap="round"/>'
    + '<line x1="2" y1="2" x2="18" y2="18" stroke="#ff2020" stroke-width="3" stroke-linecap="round"/>'
    + '</svg>';
};

// (zip0140) Programmatic fullscreen + landscape lock. Both require a user
// gesture to fire (browser policy), so we wire them to the first tap on
// the page. iOS Safari doesn't support either reliably — the CSS portrait
// warning is the safety net there.
// (zip0143) Programmatic fullscreen + landscape lock. Both require a
// user gesture per browser policy, so we wire them to the first tap on
// the page. iOS Safari supports neither reliably; for browsers that
// refuse the lock, the page just renders in whatever orientation the
// user is holding (the old portrait warning was removed in 0143).
//
// (zip0173) DISABLED — replaced by the CSS rotate-wrap approach
// implemented in index.html. The new approach keeps the URL bar and
// Android navigation buttons visible (in their physical screen
// position) while CSS-rotating the app UI 90° to show in landscape on
// portrait-held phones. Avoids the fullscreen-API quirks (taps on
// chrome dismissing fullscreen, iOS refusing the lock, requiring a
// user gesture every page load).
//
// Function kept as a no-op so any existing call sites still resolve
// without error.
async function _enterFullscreenLandscape() {
  return;
}

function _wireFullscreenOnFirstTap() {
  // (zip0173) DISABLED — see _enterFullscreenLandscape comment above.
  // The CSS rotate-wrap in index.html handles portrait-on-phone display
  // without needing fullscreen or an orientation lock. Function kept
  // for backward compatibility with the call site in load().then().
  return;
}

// (dev0316) Shareable-menu (the "I" / Initial screen). On the public site
// (slam.com, github.io), bare-URL boot lands here instead of on G. The menu
// lists every shareable item:
//   - ml.json rows with non-empty `Direct`      → opens V on that UID
//   - c.json rows with non-empty `ss` field      → opens slideshow over that grid
// Labels are the Direct value (V items) and the gname (G items). Tapping
// an item opens it WITHOUT triggering locked-mode, so V close / Configs
// returns to this menu (see vpClose return-to-menu hook). Direct URLs
// (/tshare, /ss4) still bypass the menu and run locked, one-shot.
async function _showShareableMenu() {
  // Clear any prior locked-mode state — re-entering the menu means the
  // viewer is back at "home" and free to pick another item.
  window._lockedUid = undefined;
  window._lockedConfig = undefined;
  document.documentElement.classList.remove('locked-mode');
  document.documentElement.classList.remove('deep-uid');

  // Tear down any open V / G / picker overlays so the menu paints clean.
  ['gridFullscreen', 'gridOverlay', 'mobileCPicker'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const prev = document.getElementById('shareableMenu');
  if (prev) prev.remove();

  // Load ml.json and c.json — FSA folder first, HTTP fallback.
  let ml = null, cj = null;
  try {
    const dir = (typeof _getDir === 'function') ? await _getDir() : null;
    if (dir) {
      try { const fh = await dir.getFileHandle('ml.json'); ml = JSON.parse(await (await fh.getFile()).text()); } catch (e) {}
      try { const fh = await dir.getFileHandle('c.json');  cj = JSON.parse(await (await fh.getFile()).text()); } catch (e) {}
    }
    if (!ml) { try { const r = await fetch('ml.json?t=' + Date.now()); if (r.ok) ml = await r.json(); } catch (e) {} }
    if (!cj) { try { const r = await fetch('c.json?t='  + Date.now()); if (r.ok) cj = await r.json(); } catch (e) {} }
  } catch (e) {}

  const mlRows = Array.isArray(ml) ? ml : [];
  const cRows = Array.isArray(cj)
    ? (cj[0] && cj[0]._salMeta ? cj.slice(1) : cj)
    : [];

  const vItems = mlRows
    .filter(r => r && !r._salMeta && String(r.Direct || '').trim() && r.UID != null)
    .map(r => ({ kind: 'v', label: String(r.Direct).trim(), uid: String(r.UID) }));
  const gItems = cRows
    .filter(g => g && !g._salMeta && String(g.ss || '').trim() && g.gname)
    .map(g => ({ kind: 'ss', label: String(g.gname).trim(), ss: String(g.ss).trim() }));
  const items = vItems.concat(gItems);

  const ov = document.createElement('div');
  ov.id = 'shareableMenu';
  ov.style.cssText = 'position:fixed;inset:0;z-index:999990;background:#0a0a1a;'
    + 'display:flex;flex-direction:column;font-family:monospace;color:#eee;';

  let listHtml;
  if (!items.length) {
    listHtml = '<div style="padding:24px;color:#aa8;">No shareable items yet.</div>';
  } else {
    listHtml = items.map((it, i) =>
      '<div class="sm-item" data-i="' + i + '" style="padding:18px 22px;'
      + 'border-bottom:1px solid #222;cursor:pointer;font-size:18px;color:#ddd;">'
      + (it.label.replace(/[<>&]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;' }[c])))
      + '</div>'
    ).join('');
  }

  ov.innerHTML =
    '<div style="display:flex;align-items:center;padding:14px 16px;'
      + 'background:#1a1a2e;border-bottom:2px solid #4af;">'
      + '<span style="color:#8ef;font-weight:bold;flex:1;font-size:15px;">SeeAndLearn</span>'
    + '</div>'
    + '<div id="smList" style="flex:1;overflow-y:auto;">' + listHtml + '</div>';

  document.body.appendChild(ov);

  ov.querySelectorAll('.sm-item').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.i, 10);
      const it = items[idx];
      if (!it) return;
      ov.remove();
      if (it.kind === 'v') {
        // V from menu: route vpClose back to the menu via the
        // _fromShareableMenu hook, since there's no real G underneath
        // (we only forced gridOverlay open as a V backdrop). Direct
        // /tshare links never set this flag — they run locked.
        window._fromShareableMenu = true;
        const gOvl = document.getElementById('gridOverlay');
        if (gOvl) {
          gOvl.style.display = 'flex';
          window._vpForcedGridFromT = true;
        }
        _openItemByUid(it.uid);
      } else if (it.kind === 'ss') {
        // ss from menu: G is the genuine destination — slideshow plays
        // over it, and when the slideshow stops the user stays on G
        // (per dev0317 explicit ask). Do NOT set _fromShareableMenu:
        // slideshow.js calls vpClose() during navigation, and we don't
        // want every slide transition to pop the menu back. Configs
        // button is still the explicit "back to menu" gesture.
        window._fromShareableMenu = false;
        _openSlideshowBySsId(it.ss);
      }
    });
  });
}
window._showShareableMenu = _showShareableMenu;

function _routeInitialScreen() {
  const params = new URLSearchParams(window.location.search);
  let target = params.get('screen');
  // (zip0142) UID deep-link: `?i=NNN` opens item NNN in fullscreen view
  // (V screen). Restored from a past github version. Works in both dev
  // and user mode. We open G first so the V overlay has a sensible
  // background to fall back to when the user closes it.
  // (dev0249) Deep-link state — captured earlier in _markDeepLinkClass.
  // `_deepUid` is the bare UID (slash-suffix stripped); `_lockedUid` is
  // set iff the link did NOT end in /unlock.
  const deepUid = window._deepUid || params.get('i') || null;
  const deepConfig = window._deepConfig || null;
  const deepSs = window._deepSs || null;
  const isLocked = !!window._lockedUid;
  // (zip0141) In user mode, default to G regardless of device — the user
  // version doesn't have a meaningful T view.
  if (!target && (_isMobileDevice() || _isUserMode() || deepUid || deepConfig || deepSs)) target = 'g';
  if (!target) return;
  setTimeout(() => {
    // (dev0249) In LOCKED deep-link mode, skip opening G — V will render
    // over a plain black backdrop and the viewer can't navigate away.
    // In UNLOCKED deep-link mode, still skip G initially — V opens
    // directly, eliminating the brief "flash of G" before V mounts.
    // The user can still get to G by closing V (vpClose's no-op return-
    // to-grid behavior).
    if (deepUid) {
      // skip gridShow / openCScreen — go straight to V
    } else if (deepSs) {
      // (dev0267) ?ss=ID — find c.json row with matching ss field, activate
      // its grid, then auto-launch the slideshow.
      _openSlideshowBySsId(deepSs);
    } else if (deepConfig) {
      // (dev0253) ?c=NAME — activate config then open G. _openConfigByName
      // calls gridShow() once the config is loaded.
      _openConfigByName(deepConfig);
    } else if (target === 'g') {
      // (dev0316) User-mode bare boot lands on the shareable menu ("I"),
      // not on G. Dev mode and any explicit deep-link path keep the old
      // G behaviour (deep-link cases are handled in the branches above).
      if (_isUserMode() && typeof _showShareableMenu === 'function') {
        _showShareableMenu();
      } else if (typeof gridShow === 'function') {
        gridShow();
      }
    } else if (target === 'c') {
      // On mobile or in user mode, "C" means the friendly config picker.
      if (_isMobileDevice() || _isUserMode()) _showMobileCPicker();
      else if (typeof openCScreen === 'function') openCScreen();
    }
    if (deepUid) _openItemByUid(deepUid);
  }, 200);
}

// (dev0253) Resolve a c.json grid name and activate it, then open G.
// Mirrors the activation block in _showMobileCPicker (tap-handler) but
// without any UI. Polls until `data` is ready (ml.json fetch can outlive
// boot.js evaluation on slow links).
async function _openConfigByName(name) {
  const want = String(name || '').trim();
  if (!want) return;
  const startedAt = Date.now();
  function ready() {
    return typeof data !== 'undefined' && Array.isArray(data) && data.length > 0;
  }
  while (!ready()) {
    if (Date.now() - startedAt > 5000) {
      if (typeof toast === 'function') toast('Could not load data — check your connection', 3000);
      return;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  // Load c.json the same way _showMobileCPicker does.
  let parsed = null;
  try {
    const dir = await _getDir();
    if (dir) {
      try {
        const fh = await dir.getFileHandle('c.json');
        parsed = JSON.parse(await (await fh.getFile()).text());
      } catch (e) {}
    }
    if (!parsed) {
      try {
        const r = await fetch('c.json?t=' + Date.now());
        if (r.ok) parsed = await r.json();
      } catch (e) {}
    }
  } catch (e) {}
  if (!parsed) {
    if (typeof toast === 'function') toast('Could not load c.json', 2500);
    return;
  }
  let rows = Array.isArray(parsed)
    ? (parsed[0] && parsed[0]._salMeta ? parsed.slice(1) : parsed)
    : [parsed];
  const cfg = rows.find(r => r && !r._salMeta && String(r.gname || '').trim() === want);
  if (!cfg) {
    if (typeof toast === 'function') toast('No grid named "' + want + '"', 2500);
    return;
  }
  // Activation — identical to _showMobileCPicker's tap handler.
  window._gridActiveConfig = cfg;
  window._gridSource = 'C';
  window._gridName = cfg.gname || '';
  if (typeof _gridApplyConfigZoom === 'function') _gridApplyConfigZoom(cfg); // (dev0346) global + per-cell zoom
  const cellsN = parseInt(cfg.cells, 10);
  let gsize = 5;
  if (cellsN === 4) gsize = 2;
  else if (cellsN === 9) gsize = 3;
  else if (cellsN === 16) gsize = 4;
  else if (cellsN === 25) gsize = 5;
  if (typeof _setGridGsize === 'function') _setGridGsize(gsize, { skipSave: true });
  if (typeof metaRow !== 'undefined') {
    if (!metaRow) metaRow = { _salMeta: true };
    metaRow._salGsize = gsize;
  }
  if (Array.isArray(data)) {
    data.forEach(r => { if (r && r.cell) r.cell = ''; });
    for (let r = 1; r <= gsize; r++) {
      for (let c = 1; c <= gsize; c++) {
        const cs = r + 'abcde'.charAt(c - 1);
        const uid = (typeof _gridParseCellVal === 'function') ? _gridParseCellVal(cfg[cs]).uid : (cfg[cs] ? String(cfg[cs]) : '');
        if (uid) {
          const row = data.find(d => String(d.UID) === uid);
          if (row) row.cell = cs;
        }
      }
    }
  }
  if (typeof save === 'function') save();
  if (typeof gridShow === 'function') gridShow();
}

// (dev0267) Resolve a slideshow shortcut id (matched against c.json `ss`
// field) to a grid config, activate it, then auto-launch slideshowOpenGrid
// once the grid is up. Mirrors _openConfigByName's c.json loading & data
// polling so it works on first paint even when ml.json is still loading.
async function _openSlideshowBySsId(ssVal) {
  const want = String(ssVal || '').trim().toLowerCase();
  if (!want) return;
  const startedAt = Date.now();
  function ready() {
    return typeof data !== 'undefined' && Array.isArray(data) && data.length > 0;
  }
  while (!ready()) {
    if (Date.now() - startedAt > 5000) {
      if (typeof toast === 'function') toast('Could not load data — check your connection', 3000);
      return;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  let parsed = null;
  try {
    const dir = await _getDir();
    if (dir) {
      try {
        const fh = await dir.getFileHandle('c.json');
        parsed = JSON.parse(await (await fh.getFile()).text());
      } catch (e) {}
    }
    if (!parsed) {
      try {
        const r = await fetch('c.json?t=' + Date.now());
        if (r.ok) parsed = await r.json();
      } catch (e) {}
    }
  } catch (e) {}
  if (!parsed) {
    if (typeof toast === 'function') toast('Could not load c.json', 2500);
    return;
  }
  const rows = Array.isArray(parsed)
    ? (parsed[0] && parsed[0]._salMeta ? parsed.slice(1) : parsed)
    : [parsed];
  const cfg = rows.find(r => r && !r._salMeta && r.ss != null
    && String(r.ss).trim().toLowerCase() === want);
  if (!cfg || !cfg.gname) {
    if (typeof toast === 'function') toast('No grid with ss="' + ssVal + '"', 2500);
    return;
  }
  await _openConfigByName(cfg.gname);
  // Wait a beat for gridShow() to paint, then launch the slideshow over it.
  setTimeout(() => {
    if (typeof slideshowOpenGrid === 'function') slideshowOpenGrid();
  }, 350);
}

// (zip0142) Resolve a UID (string or number) to a row in `data` and open
// it in V (fullscreen). Tolerant of leading/trailing whitespace and of
// either string or numeric storage in ml.json. Toasts on miss so the
// user knows the link was bad.
function _openItemByUid(uid) {
  const want = String(uid).trim();
  if (!want) return;
  // (dev0249) Poll for data: on fresh page loads, `data` may still be
  // loading when this runs. Retry every 100ms up to 5 seconds before
  // giving up. Without this, the first call sees no data and silently
  // returns — leaving a blank screen on slow connections.
  const startedAt = Date.now();
  function tryOpen() {
    if (typeof data === 'undefined' || !Array.isArray(data) || data.length === 0) {
      if (Date.now() - startedAt > 5000) {
        if (typeof toast === 'function') toast('Could not load data — check your connection', 3000);
        return;
      }
      setTimeout(tryOpen, 100);
      return;
    }
    const row = data.find(r => String(r.UID) === want);
    if (!row) {
      if (typeof toast === 'function') toast('No item with UID ' + want, 2000);
      return;
    }
    // (dev0315) Anti-enumeration on the public site: a LOCKED link (?i=NNN
    // with no /unlock) may only open items that were explicitly shared —
    // i.e. rows carrying a non-empty `Direct` slug. This stops a curious
    // visitor from guessing ?i=6, ?i=7, … to browse the whole library.
    // Dev /unlock links (window._lockedUid unset) bypass the check, and
    // dev mode (localhost) is unaffected.
    const _um = (typeof _isUserMode === 'function') ? _isUserMode() : false;
    if (_um && window._lockedUid && !String(row.Direct || '').trim()) {
      if (typeof toast === 'function') toast('Not found', 1500);
      return;
    }
    _lastGridRow = row;
    // Tick for any in-flight paint before stacking V on top.
    setTimeout(() => {
      if (typeof gridOpenFullscreen === 'function') gridOpenFullscreen(row);
    }, 60);
  }
  tryOpen();
}

// (zip0140) Mobile-friendly config picker — replaces the full C table view
// for users on phones. Reads c.json (via FSA folder if set, otherwise
// HTTP), renders each grid as a tappable row showing its name. Tap = load
// that grid into G and close the picker. R-to-L swipe closes without
// changing anything. Esc / X also close.
async function _showMobileCPicker() {
  // Make sure c.json data is loaded (openCScreen does this side-effect),
  // but we don't actually want to show the C table — so we capture the
  // configs and immediately close C if it opened.
  const wasGridOpen = document.getElementById('gridOverlay')?.style.display === 'flex';

  // Use the same load logic as openCScreen, but without entering _cMode.
  let configs = [];
  let loadOk = false;
  try {
    const dir = await _getDir();
    let parsed = null;
    if (dir) {
      try {
        const fh = await dir.getFileHandle('c.json');
        parsed = JSON.parse(await (await fh.getFile()).text());
      } catch (e) {}
    }
    if (!parsed) {
      try {
        const r = await fetch('c.json?t=' + Date.now());
        if (r.ok) parsed = await r.json();
      } catch (e) {}
    }
    if (parsed) {
      let rows = [];
      if (Array.isArray(parsed) && parsed[0]?._salMeta) rows = parsed.slice(1);
      else if (Array.isArray(parsed))                   rows = parsed;
      else                                              rows = [parsed];
      configs = rows.filter(r => r && !r._salMeta && r.gname);
      loadOk = true;
    }
  } catch (e) {}

  // Build the picker overlay
  const old = document.getElementById('mobileCPicker');
  if (old) old.remove();
  const ov = document.createElement('div');
  ov.id = 'mobileCPicker';
  ov.style.cssText = 'position:fixed;inset:0;z-index:999991;background:#0a0a1a;'
    + 'display:flex;flex-direction:column;font-family:monospace;color:#eee;';

  let listHtml = '';
  if (!loadOk) {
    listHtml = '<div style="padding:24px;color:#f88;">Could not load c.json.<br>'
      + 'Place c.json next to index.html on the server.</div>';
  } else if (!configs.length) {
    listHtml = '<div style="padding:24px;color:#aa8;">No grid configs in c.json.</div>';
  } else {
    listHtml = configs.map((cfg, i) =>
      '<div class="mcp-item" data-i="' + i + '" style="padding:14px 18px;'
      + 'border-bottom:1px solid #222;cursor:pointer;font-size:15px;'
      + (cfg === _gridActiveConfig ? 'background:#1a3050;color:#8ef;' : 'color:#ddd;')
      + '">' + (cfg.gname || '(unnamed)') + '</div>'
    ).join('');
  }

  ov.innerHTML = `
    <div style="display:flex;align-items:center;padding:10px 14px;
                background:#1a1a2e;border-bottom:2px solid #4af;">
      <span style="color:#8ef;font-weight:bold;flex:1;">Choose a grid</span>
      <button id="mcpClose" style="background:#222;border:1px solid #555;color:#aaa;
              padding:5px 11px;border-radius:5px;cursor:pointer;
              font-family:monospace;">✕</button>
    </div>
    <div id="mcpList" style="flex:1;overflow-y:auto;">${listHtml}</div>
    <div style="padding:8px 14px;background:#0d0d1e;border-top:1px solid #222;
                color:#556;font-size:11px;text-align:center;">
      Tap a grid · or swipe right-to-left to cancel
    </div>
  `;
  document.body.appendChild(ov);

  function close() { ov.remove(); }

  ov.querySelector('#mcpClose').onclick = close;

  // Tap-to-activate
  ov.querySelectorAll('.mcp-item').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.i, 10);
      const cfg = configs[idx];
      if (!cfg) return;
      // Activate this grid: set as active config, switch grid source to C, render.
      _gridActiveConfig = cfg;
      _gridSource = 'C';
      _gridName = cfg.gname || '';
      if (typeof _gridApplyConfigZoom === 'function') _gridApplyConfigZoom(cfg); // (dev0346) global + per-cell zoom
      // (zip0153) Derive grid size from cfg.cells (25/16/9/4 → 5/4/3/2).
      const cellsN = parseInt(cfg.cells, 10);
      let gsize = 5;
      if (cellsN === 4) gsize = 2;
      else if (cellsN === 9) gsize = 3;
      else if (cellsN === 16) gsize = 4;
      else if (cellsN === 25) gsize = 5;
      _setGridGsize(gsize, { skipSave: true });
      metaRow = metaRow || { _salMeta: true };
      metaRow._salGsize = gsize;
      // Mirror cell mapping into row.cell (matches activateGridConfig logic).
      if (typeof data !== 'undefined' && Array.isArray(data)) {
        data.forEach(r => { if (r && r.cell) r.cell = ''; });
        for (let r = 1; r <= gsize; r++) {
          for (let c = 1; c <= gsize; c++) {
            const cs = r + 'abcde'.charAt(c - 1);
            const uid = (typeof _gridParseCellVal === 'function') ? _gridParseCellVal(cfg[cs]).uid : (cfg[cs] ? String(cfg[cs]) : '');
            if (uid) {
              const row = data.find(d => String(d.UID) === uid);
              if (row) row.cell = cs;
            }
          }
        }
      }
      if (typeof save === 'function') save();
      close();
      if (typeof gridShow === 'function') gridShow();
      if (typeof toast === 'function') toast('✓ ' + (cfg.gname || '(unnamed)') + ' (' + gsize + '×' + gsize + ')', 1500);
    });
  });

  // R-to-L swipe to close
  let sStart = null;
  ov.addEventListener('pointerdown', e => {
    // (zip0174) Use wrap-local coords for rotated portrait support.
    const _p = window.rotateXY ? window.rotateXY(e) : { x: e.clientX, y: e.clientY };
    sStart = { x: _p.x, y: _p.y, t: Date.now() };
  });
  ov.addEventListener('pointerup', e => {
    if (!sStart) return;
    const _p = window.rotateXY ? window.rotateXY(e) : { x: e.clientX, y: e.clientY };
    const dx = _p.x - sStart.x;
    const dy = _p.y - sStart.y;
    const ms = Date.now() - sStart.t;
    sStart = null;
    if (dx < -40 && Math.abs(dy) < Math.abs(dx) && ms < 800) close();
  });
  ov.addEventListener('pointercancel', () => { sStart = null; });

  // Esc closes
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      document.removeEventListener('keydown', onKey, true);
      close();
    }
  }
  document.addEventListener('keydown', onKey, true);
}

function _wireMobileToCBtn() {
  const btn = document.getElementById('mobileToCBtn');
  const grid = document.getElementById('gridOverlay');
  const fs   = document.getElementById('gridFullscreen');
  if (!btn || !grid) return;
  function refresh() {
    // (zip0141) Show the Configs button whenever G is open AND we're in
    // user mode OR on a mobile device. Dev users on desktop don't need
    // the floating shortcut — they have the gridSrcC button.
    // (zip0144) Also hide whenever V/P (gridFullscreen) is showing on
    // top of G — the button visually overlapped the V controls and was
    // a distraction on the picture/video view. The user only needs
    // Configs from G itself.
    const showWhenOpen = _isUserMode() || _isMobileDevice();
    const gridUp = grid.style.display === 'flex';
    const fsUp   = fs && fs.style.display === 'flex';
    btn.style.display = (gridUp && showWhenOpen && !fsUp) ? 'block' : 'none';
    // (dev0316) The user-mode top-left hamburger follows the same gate so
    // the slideshow launcher is only available while a grid is mounted.
    // On the shareable menu / V / locked-mode it stays hidden.
    const userBtn = document.getElementById('userHmBtn');
    if (userBtn) {
      userBtn.style.display = (gridUp && _isUserMode() && !fsUp) ? 'flex' : 'none';
    }
    // Whenever G becomes visible, re-apply user-mode chrome (hides
    // dev-only buttons that gridShow may have re-styled).
    if (gridUp) _applyUserModeChromeOnGrid();
  }
  refresh();
  new MutationObserver(refresh).observe(grid, {
    attributes: true, attributeFilter: ['style']
  });
  // (zip0144) Re-evaluate visibility when V/P opens or closes too.
  if (fs) new MutationObserver(refresh).observe(fs, {
    attributes: true, attributeFilter: ['style']
  });
  btn.addEventListener('click', () => {
    // (dev0316) In user mode the Configs button is the explicit "back to
    // the shareable menu (I)" gesture — it does NOT show the full c.json
    // picker any more (that listed dev-only grids without `ss` values).
    // Mobile devs (LAN, dev mode) keep the friendly picker; desktop
    // devs fall through to the full C table.
    if (_isUserMode() && typeof _showShareableMenu === 'function') {
      _showShareableMenu();
    } else if (_isMobileDevice()) {
      _showMobileCPicker();
    } else {
      if (typeof gridClose === 'function') gridClose();
      if (typeof openCScreen === 'function') setTimeout(openCScreen, 80);
    }
  });
}

load().then(() => {
  setupBrowseAutocomplete();
  _wireMobileToCBtn();
  _wireFullscreenOnFirstTap();
  _routeInitialScreen();
});
