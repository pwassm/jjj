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
    // (dev0379) Null-guard: `filterBtn` was removed (F now opens a modal), so
    // an unconditional deref threw here and crashed the C-screen render.
    const _fb=document.getElementById('filterBtn'); if(_fb) _fb.style.display='none';
    const _cfb=document.getElementById('clearFilterBtn'); if(_cfb) _cfb.style.display='none';
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
  const ae=document.activeElement;
  const tag=ae?.tagName;
  // (dev0379) Also bail in a contentEditable host (the Xe editor for ctxt is a
  // contentEditable DIV, not an INPUT) and whenever the Xe overlay owns the
  // keyboard — otherwise typing 't'/'g'/'m' there leaked through to the
  // C-screen shortcuts (e.g. 't' closed C and popped the table mid-edit).
  if (tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||ae?.isContentEditable) return;
  if (document.getElementById('textEditorOverlay')) return;
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

// (dev0353) C-screen plain right-click on a row → immediately MakeActive→G for
// the row under the cursor, whether or not it was focused/checked first.
document.addEventListener('contextmenu', e => {
  if (!_cMode) return;
  const td = e.target.closest('td[data-vi]');
  if (!td) return;
  const vi = parseInt(td.getAttribute('data-vi'), 10);
  if (isNaN(vi)) return;
  e.preventDefault(); e.stopPropagation();
  focus = { r: vi, c: 0 };
  checkedRows.clear();
  checkedRows.add(vr(vi));
  // (dev0355) cMakeActive() builds & shows G synchronously inside this same
  // right-click. The grid's own contextmenu listener (grid.js) would otherwise
  // fire for the very next right-click landing on the freshly-mounted cell —
  // mark a short-lived guard the grid handler honors so the menu never pops.
  window._cRclickNavGuard = Date.now();
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

  // (dev0359) Greeting block. One ml.json row carries Direct === "Greeting";
  // its `ftext` (rich HTML, editable right here in Xe) is rendered at the top
  // of the menu and is NOT itself a clickable choice. If no such row exists,
  // fall back to an optional greeting.html file so the text can also live on
  // disk. Re-read every time the menu opens (the whole function re-fetches),
  // so editing the Greeting row updates the menu on the next visit.
  const _isGreeting = v => /^greet/.test(String(v || '').trim().toLowerCase()); // "greet" or "greeting"
  // (dev0378) `Direct` was renamed to `ttxt`. The greeting row is still matched
  // by its label value (now read from ttxt); its MPix/COI still drive the search
  // threshold + filters below.
  const greetRow = mlRows.find(r => r && !r._salMeta && _isGreeting(r.ttxt));
  // (dev0378) Greeting prose now lives in c.json: the config row whose gname is
  // "Greeting", in its `ctxt` field. Fall back to the legacy ml.json ttxt-row
  // ftext, then to a greeting.html file on disk.
  const greetCfg = cRows.find(r => r && !r._salMeta && _isGreeting(r.gname));
  let greetingHtml = greetCfg ? String(greetCfg.ctxt || '') : '';
  if (!greetingHtml && greetRow) greetingHtml = String(greetRow.ftext || '');
  if (!greetingHtml) {
    try { const r = await fetch('greeting.html?t=' + Date.now()); if (r.ok) greetingHtml = await r.text(); } catch (e) {}
  }
  // (dev0361) Split the greeting at its FIRST <hr> (the Xe ══ divider): prose
  // BEFORE the rule is page 1 (welcome / landing), prose AFTER is the lead text
  // shown atop page 2 ("Choose a view"). No <hr> → it all stays on page 1.
  let greetTop = greetingHtml, greetIntro = '';
  {
    const _hr = greetingHtml.match(/<hr\b[^>]*>/i);
    if (_hr) { greetTop = greetingHtml.slice(0, _hr.index); greetIntro = greetingHtml.slice(_hr.index + _hr[0].length); }
  }
  // The <hr> usually sits INSIDE a <div>, so a raw string split orphans tags:
  // greetTop loses a closing </div>, greetIntro gains a stray one. Left as-is,
  // that stray </div> closes the page container early and leaks the list out.
  // Round-trip each half through a temp element so the browser re-balances it.
  const _balanceHtml = h => { const d = document.createElement('div'); d.innerHTML = h; return d.innerHTML; };
  // (dev0382) Linkify scheme'd URLs at render time, exactly as the Xe editor and
  // the V/grid slide views do (renderFtext). Without this, a raw https:// URL in
  // the greeting/Other ctxt rendered as plain, non-blue, non-clickable text on
  // the live menu — even though it showed as a link inside Xe.
  const _linkify = h => (typeof _linkifyHtml === 'function' ? _linkifyHtml(h) : h);
  greetTop = _linkify(_balanceHtml(greetTop));
  greetIntro = _linkify(_balanceHtml(greetIntro));

  // (dev0379) "Other" page — free-form HTML from the c.json config row whose
  // gname is "other", in its `ctxt` field. Re-read every open (whole function
  // re-fetches c.json), so editing that ctxt in C updates the page next visit.
  const otherCfg = cRows.find(r => r && !r._salMeta && String(r.gname || '').trim().toLowerCase() === 'other');
  const otherHtml = _linkify(_balanceHtml(otherCfg ? String(otherCfg.ctxt || '') : ''));

  // (dev0361) Classify an ml.json row so page 2 can badge it image / video /
  // slide / quiz. Order mirrors the V & grid fill branches (quiz → slide →
  // video → image). `slide` = HTML ftext with no link; `quiz` = JSON-ish
  // ftext or a qfile.
  const _smType = r => {
    const ft = String(r.ftext || '').trim();
    if (r.qfile || (ft && !r.link && /^[\[{]/.test(ft))) return 'quiz';
    if (ft && !r.link) return 'slide';
    if (window.isVideoRow && window.isVideoRow(r)) return 'video';
    if (window.isImageLink && window.isImageLink(r.link)) return 'image';
    return 'other';
  };
  const _smBadge = { image: '🖼', video: '🎬', slide: '📄', quiz: '📋', other: '🔗' };
  const _smEsc = s => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

  // (dev0378) Singles (ml.json `ttxt`) and Grids (c.json `ctxt`) are now
  // details-HTML blocks. Pull the visible card label from the block's first
  // <summary> text (fallback: first non-empty rendered line); the card body is
  // that <details>' content minus the summary (or the whole block if it isn't
  // wrapped in <details>). DateModified shows as a short YYYY-MM-DD.
  const _smSummaryText = html => {
    const d = document.createElement('div'); d.innerHTML = String(html || '');
    const s = d.querySelector('summary');
    let t = s ? s.textContent.trim() : '';
    if (!t) t = (d.textContent || '').trim().split('\n').map(x => x.trim()).filter(Boolean)[0] || '';
    return t;
  };
  const _smDetailBody = html => {
    const d = document.createElement('div'); d.innerHTML = String(html || '');
    const det = d.querySelector('details');
    if (det) { const s = det.querySelector(':scope > summary'); if (s) s.remove(); return det.innerHTML; }
    return d.innerHTML;
  };
  const _smDateShort = v => String(v || '').trim().slice(0, 10);

  // (dev0362) Search page. `n` = the Greeting row's MPix, repurposed as the
  // "show results" threshold (it isn't a real megapixel value on that row).
  // Below n matches, result cards appear; default 12 if unset/invalid.
  let _smN = parseInt(greetRow && greetRow.MPix, 10);
  if (!_smN || _smN < 1) _smN = 12;
  // (dev0366) Search filters are declared in the Greeting row's COI cell and
  // stay operative as long as that text is present (no in-UI toggle):
  //   • "taxon" → limit results to rows carrying at least one taxon-kind tag.
  //   • "media" → limit results to rows whose link is an image or video
  //               (omits ftext-only slides/quizzes).
  // Editing the COI cell in Xe turns each filter on/off on the next visit.
  const _smCoi = String((greetRow && greetRow.COI) || '').toLowerCase();
  const _filtTaxon = /\btaxon\b/.test(_smCoi);
  // "media" is the canonical keyword; also accept the natural phrasing
  // "image … video" (in either order) so a hand-edited COI still works.
  const _filtMedia = /\bmedia\b/.test(_smCoi)
    || (/\bimage\b/.test(_smCoi) && /\bvideo\b/.test(_smCoi));
  // All searchable T rows (content rows with a UID, minus the greeting). For
  // each, precompute one lowercased "blob" of every searchable field so each
  // keystroke is just a substring scan (mirrors core.js 'anywhere' fields:
  // VidAuthor/VidTitle/link/VidComment + de-tagged ftext + tag label/common).
  // Also precompute `hasTaxon` and the link-derived media `kind` so the COI
  // filters above are a cheap boolean check per row.
  const _tBlobs = mlRows
    .filter(r => r && !r._salMeta && r.UID != null && !_isGreeting(r.ttxt))
    .map(r => {
      let blob = ['VidAuthor', 'VidTitle', 'link', 'VidComment'].map(f => String(r[f] || '')).join(' ')
        + ' ' + String(r.ftext || '').replace(/<[^>]*>/g, ' ');
      let hasTaxon = false;
      if (window.tagsLib && Array.isArray(r.tags)) {
        r.tags.forEach(tid => {
          const t = window.tagsLib.get(tid);
          if (t) { blob += ' ' + (t.label || '') + ' ' + (t.common || ''); if (t.kind === 'taxon') hasTaxon = true; }
        });
      }
      const kind = window.rowMediaKind ? window.rowMediaKind(r) : 'other';
      return { r, blob: blob.toLowerCase(), hasTaxon, kind };
    });
  // Result label per the user's rule: ftext-bearing rows (Xe — incl. quiz, and
  // with OR without a link) → first non-formatting HTML line; else video →
  // VidTitle, image → first of VidComment.
  const _smResultLabel = r => {
    if (r.ftext && String(r.ftext).trim() && typeof _ftextFirstLine === 'function') {
      const fl = _ftextFirstLine(r.ftext);
      if (fl) return fl;
    }
    const kind = window.rowMediaKind ? window.rowMediaKind(r) : 'other';
    if (kind === 'video') return r.VidTitle || r.VidComment || '(video)';
    if (kind === 'image') return r.VidComment || r.VidTitle || '(image)';
    return r.VidTitle || r.VidComment || ('UID ' + r.UID);
  };
  const _smResultBadge = r => (r.ftext && String(r.ftext).trim())
    ? (_smType(r) === 'quiz' ? 'quiz' : 'slide')
    : (window.rowMediaKind ? window.rowMediaKind(r) : 'other');

  // Choices, re-read fresh on every open. V items (from T / ml.json `Direct`)
  // first, then SS grids (from C / c.json), so the combined `items` index used
  // by the tap handler stays stable.
  // (dev0378) Singles now come from ml.json `ttxt` (was `Direct`): every content
  // row whose ttxt details-block is non-empty. Grids now come from c.json `ctxt`
  // (was the `ss` field / gname label): every config row whose ctxt is occupied
  // and that has a gname to open by. Both carry the raw HTML + DateModified so
  // each card can show a summary line, a date, and an expandable details body.
  const vItems = mlRows
    .filter(r => r && !r._salMeta && String(r.ttxt || '').trim() && !_isGreeting(r.ttxt) && r.UID != null)
    .map(r => ({ kind: 'v', uid: String(r.UID), html: String(r.ttxt),
                 summary: _smSummaryText(r.ttxt) || ('UID ' + r.UID),
                 date: _smDateShort(r.DateModified), dmRaw: String(r.DateModified || ''),
                 type: _smType(r) }));
  const gItems = cRows
    .filter(g => g && !g._salMeta && String(g.ctxt || '').trim() && g.gname && !_isGreeting(g.gname)
                 && String(g.gname).trim().toLowerCase() !== 'other')
    .map(g => ({ kind: 'ss', gname: String(g.gname).trim(), html: String(g.ctxt),
                 summary: _smSummaryText(g.ctxt) || String(g.gname).trim(),
                 date: _smDateShort(g.DateModified), dmRaw: String(g.DateModified || ''),
                 cells: Number(g.cells) || 0 }));
  const items = vItems.concat(gItems);

  // (dev0383) Navigation-Training choices — a SECOND choice table, identical in
  // shape to "Choose a view" but sourced from each config row's `ss` field
  // (editable in C exactly like ctxt). Each ss block supplies the card label
  // (its <summary>) and body, and opens its grid by gname — same as a grid item.
  const navItems = cRows
    .filter(g => g && !g._salMeta && String(g.ss || '').trim() && g.gname && !_isGreeting(g.gname)
                 && String(g.gname).trim().toLowerCase() !== 'other')
    .map(g => ({ kind: 'ss', gname: String(g.gname).trim(), html: String(g.ss),
                 summary: _smSummaryText(g.ss) || String(g.gname).trim(),
                 date: _smDateShort(g.DateModified), dmRaw: String(g.DateModified || ''),
                 cells: Number(g.cells) || 0 }));

  const ov = document.createElement('div');
  ov.id = 'shareableMenu';
  ov.style.cssText = 'position:fixed;inset:0;z-index:999990;background:#0a0a1a;'
    + 'display:flex;flex-direction:column;font-family:monospace;color:#eee;';

  // (dev0378) Each choice is now a native <details> card: the <summary> row is
  // the clickable summary line (icon · summary text · date · type/cells tag),
  // with an "▶ Open" launch button immediately to its right. Expanding the card
  // reveals the full ttxt/ctxt details body inline. The Open button carries
  // data-i so the handler maps it back to items[i]; opening it must NOT toggle
  // the <details> (the handler preventDefaults).
  const _smDetCard = (it, i) => {
    // (dev0379) Every card now leads with a solid right-pointing triangle to
    // signal "this is a details block" (replaces the per-type media icons).
    const ico = '&#9654;';
    const tag = it.kind === 'v'
      ? '<span class="sm-tag">' + it.type + '</span>'
      : '<span class="sm-tag">' + (it.cells ? it.cells + ' cells' : 'grid') + '</span>';
    // (dev0380) Always emit the date cell (even when empty) so the grid column
    // rules stay aligned between every card and the header.
    const dateTxt = '<span class="sm-date">' + (it.date ? _smEsc(it.date) : '') + '</span>';
    return '<details class="sm-detcard">'
        + '<summary class="sm-detsum">'
          + '<span class="sm-ico">' + ico + '</span>'
          + '<span class="sm-name">' + _smEsc(it.summary) + '</span>'
          + dateTxt + tag
          + '<button class="sm-open" data-i="' + i + '" title="Open">&#9658; Open</button>'
        + '</summary>'
        + '<div class="sm-detbody smGreeting">' + _smDetailBody(it.html) + '</div>'
      + '</details>';
  };
  // (dev0379) Cards are rendered (and sorted) into #smChooseBody by
  // _smRenderChoose after mount, so no pre-joined column HTML is needed here.
  const _smNoItems = '<div style="padding:24px;color:#aa8;">No shareable items yet.</div>';

  // (dev0359/0361) Readable sans-serif greeting prose (now a CLASS so both
  // pages can use it), page-2 cards, and the bottom tab bar. `summary` headings
  // render inline so an Xe-resized collapsible title sits on the marker line.
  const menuStyle =
    '<style>'
    + '.smGreeting{font-family:sans-serif;color:#dfe3ea;line-height:1.6;padding:22px 24px 12px;max-width:760px;margin:0 auto;}'
    + '.smGreeting h1,.smGreeting h2{color:#8ef;margin:0 0 10px;}'
    + '.smGreeting h2{font-size:22px;}.smGreeting h1{font-size:26px;}'
    + '.smGreeting h3{color:#9ef;font-size:18px;margin:6px 0;}'
    + '.smGreeting p{margin:6px 0;}.smGreeting a{color:#5bf;}'
    + '.smGreeting details{margin:8px 0;padding:8px 12px;background:#11131f;border-left:3px solid #06f;border-radius:4px;}'
    + '.smGreeting summary{cursor:pointer;color:#8ef;}'
    + '.smGreeting summary h1,.smGreeting summary h2,.smGreeting summary h3,.smGreeting summary h4,.smGreeting summary h5,.smGreeting summary h6{display:inline;color:#8ef;margin:0;}'
    + '.smGreeting hr{border:none;border-top:2px solid #4a5a7a;margin:16px 0;}'
    + '.te-cut{display:none;}'
    + '.sm-card{display:flex;align-items:center;gap:12px;padding:15px 22px;border-bottom:1px solid #1c1c30;cursor:pointer;color:#ddd;}'
    + '.sm-card:hover{background:#15152a;}'
    // (dev0378) <details> choice cards: clickable summary row + Open button.
    + '.sm-detcard{border-bottom:1px solid #1c1c30;}'
    + '.sm-detsum{display:grid;grid-template-columns:30px minmax(0,1fr) 120px 92px 84px;align-items:stretch;gap:12px;padding:15px 22px;cursor:pointer;color:#ddd;list-style:none;}'
    + '.sm-detsum::-webkit-details-marker{display:none;}'
    + '.sm-detsum::marker{content:"";}'
    + '.sm-detsum:hover{background:#15152a;}'
    + '.sm-detcard[open]>.sm-detsum{background:#15152a;}'
    + '.sm-date{display:flex;align-items:center;font-size:12px;color:#9fb0c8;font-family:sans-serif;white-space:nowrap;border-left:1px solid #22304d;padding-left:12px;}'
    + '.sm-open{align-self:center;justify-self:start;flex:none;font-family:sans-serif;font-size:12px;color:#cfe8ff;background:rgba(0,60,120,0.5);border:1px solid #4af;border-radius:6px;padding:5px 11px;cursor:pointer;white-space:nowrap;}'
    + '.sm-open:hover{background:rgba(0,80,150,0.7);}'
    + '.sm-detbody{padding:2px 22px 16px;}'
    // (dev0379) Sortable, table-like header for the choice list.
    + '.sm-chhead{display:grid;grid-template-columns:30px minmax(0,1fr) 120px 92px 84px;align-items:stretch;gap:12px;padding:9px 22px;background:#0d0d1e;border-bottom:2px solid #2a3550;position:sticky;top:0;z-index:2;}'
    + '.sm-chh-spacer{}'
    + '.sm-chh{display:flex;align-items:center;font-family:sans-serif;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#9fb0c8;background:none;border:none;cursor:pointer;padding:0;}'
    + '.sm-chh:hover{color:#cfe8ff;}'
    + '.sm-chh.on{color:#cfe8ff;}'
    + '.sm-chh-name{justify-content:flex-start;text-align:left;border-left:1px solid #22304d;padding-left:12px;}'
    + '.sm-chh-date{justify-content:flex-start;text-align:left;border-left:1px solid #22304d;padding-left:12px;}'
    + '.sm-chmax{max-width:760px;margin:0 auto;}'
    // (dev0381) Choices toolbar: filter box + expand/collapse-all buttons.
    + '.sm-chtools{display:flex;gap:8px;align-items:center;padding:10px 22px 8px;}'
    + '.sm-chfwrap{flex:1;min-width:0;display:flex;gap:6px;}'
    + '.sm-chfilter{flex:4;min-width:0;padding:8px 12px;border-radius:7px;border:1px solid #2a3550;background:#11132a;color:#fff;font-family:sans-serif;font-size:14px;outline:none;}'
    + '.sm-chfilter:focus{border-color:#4af;}'
    + '.sm-chclear{flex:1;min-width:0;padding:8px 6px;border-radius:7px;border:1px solid #2a3550;background:#15152a;color:#cfe8ff;font-family:sans-serif;font-size:12px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
    + '.sm-chclear:hover,.sm-chclear:focus{background:#1d2440;border-color:#4af;outline:none;}'
    + '.sm-chbtn{flex:none;padding:8px 12px;border-radius:7px;border:1px solid #2a3550;background:#15152a;color:#cfe8ff;font-family:sans-serif;font-size:12px;cursor:pointer;white-space:nowrap;}'
    + '.sm-chbtn:hover{background:#1d2440;}'
    + '.sm-chnone{padding:22px;color:#aa8;font-family:sans-serif;}'
    + '.sm-ico{font-size:13px;line-height:1;flex:none;width:30px;text-align:center;color:#6aa6ff;}'
    + '.sm-name{flex:1;font-size:18px;}'
    // (dev0380) Choose-list cells: full-height cells with fine vertical column
    // rules, content vertically centered + left-justified within each column.
    + '.sm-detsum .sm-ico{display:flex;align-items:center;justify-content:center;width:auto;}'
    + '.sm-detsum .sm-name{display:flex;align-items:center;min-width:0;border-left:1px solid #22304d;padding-left:12px;}'
    + '.sm-tag{align-self:center;justify-self:start;flex:none;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#fff;border:1px solid #3a4a6a;border-radius:10px;padding:2px 9px;white-space:nowrap;}'
    + '.sm-sub{padding:9px 24px 5px;color:#cfe8ff;font-size:11px;letter-spacing:.12em;text-transform:uppercase;background:#0d0d1e;}'
    + '.sm-grpdiv{height:1px;background:#223;margin:6px 0;}'
    + '.sm-colhdr{padding:12px 22px 4px;color:#9fb0c8;font-size:12px;letter-spacing:.14em;text-transform:uppercase;}'
    + '.sm-cols{display:flex;gap:28px;align-items:flex-start;justify-content:center;padding:8px 0 30px;}'
    + '.sm-col{flex:1 1 0;min-width:0;max-width:520px;}'
    + '@media(min-width:760px){.sm-cols{padding:8px 120px 30px;}}'
    + '@media(max-width:759px){.sm-cols{flex-direction:column;gap:4px;padding:0 0 24px;}.sm-col{max-width:none;}}'
    + '.sm-search{display:block;width:calc(100% - 48px);max-width:620px;margin:20px auto 10px;padding:13px 16px;border-radius:9px;border:1px solid #4af;background:#11132a;color:#fff;font-family:sans-serif;font-size:17px;outline:none;}'
    + '.sm-sugg{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;max-width:620px;margin:0 auto 6px;padding:0 24px;}'
    + '.sm-chip{padding:5px 12px;border-radius:14px;border:1px solid #2a3550;background:#15152a;color:#cfe8ff;font-family:sans-serif;font-size:13px;cursor:pointer;}'
    + '.sm-chip:hover{background:#1d2440;}'
    + '.sm-count{text-align:center;color:#9fb0c8;font-family:sans-serif;font-size:13px;margin:8px 0 4px;}'
    + '.sm-results{max-width:620px;margin:0 auto;}'
    + '.sm-cta{display:block;margin:18px auto 26px;padding:13px 26px;border-radius:9px;border:1px solid #4af;background:rgba(0,60,120,0.5);color:#cfe8ff;font-family:sans-serif;font-size:17px;font-weight:bold;cursor:pointer;max-width:320px;width:calc(100% - 48px);}'
    + '.sm-cta:hover{background:rgba(0,80,150,0.65);}'
    + '.sm-tabs{display:flex;flex:none;border-top:2px solid #223;background:#0d0d1e;}'
    + '.sm-tab{flex:1;padding:13px 4px;text-align:center;cursor:pointer;font-family:sans-serif;font-size:14px;color:#8a93a8;background:transparent;border:none;border-top:3px solid transparent;}'
    + '.sm-tab.on{color:#cfe8ff;border-top-color:#4af;background:#11132a;}'
    + '.sm-tab:focus{outline:none;color:#fff;background:#172142;}'
    // (dev0384) The tab bar now also rides at the TOP of every menu page (the
    // old "SeaLifeAndMore" header is gone). Flip the accent rule to the bottom
    // edge so the active indicator sits against the page on the top bar.
    + '.sm-tabs-top{border-top:none;border-bottom:2px solid #223;}'
    + '</style>';

  // (dev0384) One set of tab buttons, rendered both above and below the pages.
  // _smShow syncs the `.on` class across every `.sm-tab`, so the two bars stay
  // in lockstep automatically.
  const _tabBtns =
      '<button class="sm-tab" data-pg="2">Choices</button>'
    + '<button class="sm-tab" data-pg="3">Search</button>'
    + '<button class="sm-tab" data-pg="4">Other</button>'
    + '<button class="sm-tab" data-pg="5">Navigation Training</button>';

  ov.innerHTML = menuStyle
    // (dev0384) Top tab bar — replaces the former header (there is no header now).
    + '<div class="sm-tabs sm-tabs-top">' + _tabBtns + '</div>'
    + '<div style="flex:1;position:relative;overflow:hidden;">'
      // PAGE 1 — welcome / landing (greeting prose before the first <hr>).
      // (dev0366) Standalone page with a "Choose a view" button at BOTH the
      // top and the bottom so the viewer never has to scroll past the greeting
      // to advance into the tabbed view.
      + '<div id="smPage1" class="sm-pg" style="position:absolute;inset:0;overflow-y:auto;">'
        + '<button id="smGoViewTop" class="sm-cta">Choose a view&nbsp;&rarr;</button>'
        + (greetTop.trim() ? '<div class="smGreeting">' + greetTop + '</div>'
                           : '<div class="smGreeting"><p>Welcome.</p></div>')
        + '<button id="smGoView" class="sm-cta">Choose a view&nbsp;&rarr;</button>'
        // (dev0361) FUTURE sign-in field mounts here — let signed-in viewers
        // submit prospective links. Deliberately absent for now (needs a
        // backend: auth + a stored submission/moderation queue).
      + '</div>'
      // PAGE 2 — choose a view (greeting prose after the <hr>, then 2 columns:
      // Singles | Grids on desktop, stacked on phone)
      + '<div id="smPage2" class="sm-pg" style="position:absolute;inset:0;overflow-y:auto;display:none;">'
        + (greetIntro.trim() ? '<div class="smGreeting">' + greetIntro + '</div>'
                             : '<div class="sm-sub">Choose a view</div>')
        // (dev0379) Table-like, sortable list. Header columns Name / Modified
        // sort on click (arrow shows direction); body re-renders via
        // _smRenderChoose after mount. Defaults to Modified, newest at top.
        + (items.length
            ? '<div class="sm-chmax">'
                // (dev0381) Expand/Collapse-all + a live text filter (matches
                // the summary AND the raw ttxt/ctxt body of each choice).
                + '<div class="sm-chtools">'
                  // (dev0382) Filter + an inline "Clear filter" button sitting in
                  // the right ~1/5 of the box. Tab cycles filter ↔ Clear; the
                  // button clears on click/Enter/Space then refocuses the (now
                  // blank) filter.
                  + '<div class="sm-chfwrap">'
                    + '<input id="smChFilter" class="sm-chfilter" type="text" placeholder="Filter choices…" autocomplete="off">'
                    + '<button id="smChClear" class="sm-chclear" type="button">Clear filter</button>'
                  + '</div>'
                  + '<button id="smExpandAll" class="sm-chbtn">▼ Expand all</button>'
                  + '<button id="smCollapseAll" class="sm-chbtn">▶ Collapse all</button>'
                + '</div>'
                + '<div class="sm-chhead">'
                  + '<span class="sm-chh-spacer"></span>'
                  + '<button class="sm-chh sm-chh-name" data-sort="name">Name<span class="sm-arrow"></span></button>'
                  + '<button class="sm-chh sm-chh-date" data-sort="date">Modified<span class="sm-arrow"></span></button>'
                + '</div>'
                + '<div id="smChooseBody"></div>'
              + '</div>'
            : _smNoItems)
      + '</div>'
      // PAGE 4 — "Other": free-form HTML from the c.json "other" config's ctxt.
      + '<div id="smPage4" class="sm-pg" style="position:absolute;inset:0;overflow-y:auto;display:none;">'
        + (otherHtml.trim() ? '<div class="smGreeting">' + otherHtml + '</div>'
                            : '<div class="sm-sub">Nothing here yet</div>')
      + '</div>'
      // PAGE 3 — search anywhere across all of T; result cards appear once the
      // match count drops below n (the Greeting row's MPix).
      + '<div id="smPage3" class="sm-pg" style="position:absolute;inset:0;overflow-y:auto;display:none;">'
        + '<input id="smSearchBox" class="sm-search" type="text" placeholder="Search everything…" autocomplete="off">'
        // (dev0366) Active COI filters, shown so a narrowed result set doesn't
        // look broken. Populated from _filtTaxon / _filtMedia after mount.
        + '<div id="smFilterNote" class="sm-count" style="color:#7fd8a0;margin-top:0;"></div>'
        + '<div id="smSugg" class="sm-sugg"></div>'
        + '<div id="smCount" class="sm-count"></div>'
        + '<div id="smResults" class="sm-results"></div>'
      + '</div>'
      // PAGE 5 — "Navigation Training": same sortable choice table as page 2,
      // but built from the config rows' `ss` field instead of `ctxt`.
      + '<div id="smPage5" class="sm-pg" style="position:absolute;inset:0;overflow-y:auto;display:none;">'
        + (navItems.length
            ? '<div class="sm-chmax">'
                + '<div class="sm-chtools">'
                  + '<div class="sm-chfwrap">'
                    + '<input id="smNavFilter" class="sm-chfilter" type="text" placeholder="Filter choices…" autocomplete="off">'
                    + '<button id="smNavClear" class="sm-chclear" type="button">Clear filter</button>'
                  + '</div>'
                  + '<button id="smNavExpandAll" class="sm-chbtn">▼ Expand all</button>'
                  + '<button id="smNavCollapseAll" class="sm-chbtn">▶ Collapse all</button>'
                + '</div>'
                + '<div class="sm-chhead">'
                  + '<span class="sm-chh-spacer"></span>'
                  + '<button class="sm-chh sm-chh-name" data-sort="name">Name<span class="sm-arrow"></span></button>'
                  + '<button class="sm-chh sm-chh-date" data-sort="date">Modified<span class="sm-arrow"></span></button>'
                + '</div>'
                + '<div id="smNavBody"></div>'
              + '</div>'
            : _smNoItems)
      + '</div>'
    + '</div>'
    // (dev0384) Bottom tab bar — same buttons as the top one.
    + '<div class="sm-tabs sm-tabs-bottom">' + _tabBtns + '</div>';

  document.body.appendChild(ov);

  // (dev0361/0362/0366/0368) Nav. Welcome (page 1) is a one-time splash shown
  // only on first entry; both tab bars are hidden there. Pages 2–5 each carry
  // the tab bar at top AND bottom and are where all returns land.
  // (dev0384) `.on` is synced across BOTH bars; the last tab the viewer used is
  // remembered in window._smLastTab so a reopen lands back on it.
  const _smTabOrder = [2, 3, 4, 5];
  const _smShow = n => {
    window._smCurPage = n; // (dev0367) remembered so a return from V re-opens here, not Welcome
    if (n >= 2) window._smLastTab = n; // (dev0384) remember the last tab used
    [1, 2, 3, 4, 5].forEach(k => { const p = ov.querySelector('#smPage' + k); if (p) p.style.display = (k === n) ? '' : 'none'; });
    ov.querySelectorAll('.sm-tab').forEach(t =>
      t.classList.toggle('on', parseInt(t.dataset.pg, 10) === n));
    ov.querySelectorAll('.sm-tabs').forEach(tb => tb.style.display = (n === 1) ? 'none' : 'flex');
  };
  // (dev0384) Focus the active tab button on the TOP bar — used on open and on
  // every Tab-key hop so keyboard cycling stays anchored to the tab row.
  const _smFocusTab = n => { const b = ov.querySelector('.sm-tabs-top .sm-tab[data-pg="' + n + '"]'); if (b) b.focus(); };
  // Tab click → show that page. Search focuses its box (mouse users type
  // immediately); every other tab keeps focus on the tab for keyboard cycling.
  ov.querySelectorAll('.sm-tab').forEach(t =>
    t.addEventListener('click', () => {
      const pg = parseInt(t.dataset.pg, 10) || 2;
      _smShow(pg);
      if (pg === 3) { const sb = ov.querySelector('#smSearchBox'); if (sb) setTimeout(() => sb.focus(), 30); }
      else t.focus();
    }));
  // (dev0384) Keyboard: Tab hops to the next tab (Shift+Tab the previous),
  // wrapping after the last, and opens that page immediately. `f` jumps focus to
  // the live filter on Choices (and, by the same token, on Navigation Training).
  // Skipped while focus is inside a field or the filter toolbar, which own Tab
  // for their own filter↔Clear cycle.
  ov.addEventListener('keydown', e => {
    const ae = document.activeElement;
    const inField = !!(ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable));
    if (!inField && (e.key === 'f' || e.key === 'F')) {
      const fid = window._smCurPage === 2 ? '#smChFilter' : (window._smCurPage === 5 ? '#smNavFilter' : null);
      if (fid) { const fi = ov.querySelector(fid); if (fi) { e.preventDefault(); e.stopPropagation(); fi.focus(); return; } }
    }
    if (e.key === 'Tab') {
      if (inField) return;
      if (ae && ae.closest && ae.closest('.sm-chtools')) return; // filter/Clear own Tab here
      const idx = _smTabOrder.indexOf(window._smCurPage);
      if (idx < 0) return; // Welcome / unknown — leave default tabbing
      e.preventDefault(); e.stopPropagation();
      const next = e.shiftKey
        ? _smTabOrder[(idx - 1 + _smTabOrder.length) % _smTabOrder.length]
        : _smTabOrder[(idx + 1) % _smTabOrder.length];
      _smShow(next);
      _smFocusTab(next);
    }
  });
  // Welcome → Main Page (both the top and bottom "Choose a view" buttons).
  const _smGo = ov.querySelector('#smGoView');
  if (_smGo) _smGo.addEventListener('click', () => _smShow(2));
  const _smGoTop = ov.querySelector('#smGoViewTop');
  if (_smGoTop) _smGoTop.addEventListener('click', () => _smShow(2));
  // (dev0369) On the Search page, a right-to-left swipe returns to the Main
  // "Choose a view" page (the main menu) — the same swipe-back feel as the grid.
  // Pointer-based so it works with both touch and a mouse-drag (and is therefore
  // verifiable on desktop, unlike the old touch-only version). The shareable menu
  // lives OUTSIDE the rotate-wrap, so its coords are already in the user's visual
  // frame — no rotateXY needed.
  let _smSwX = null, _smSwY = null;
  ov.addEventListener('pointerdown', e => {
    _smSwX = e.clientX; _smSwY = e.clientY;
  }, true);
  ov.addEventListener('pointerup', e => {
    const x0 = _smSwX, y0 = _smSwY; _smSwX = _smSwY = null;
    if (x0 == null || window._smCurPage !== 3) return;
    const dx = e.clientX - x0, dy = e.clientY - y0;
    if (dx < -60 && Math.abs(dx) > Math.abs(dy)) _smShow(2);
  }, true);
  // Populate the search-filter note from the COI-declared filters.
  const _smFiltNote = ov.querySelector('#smFilterNote');
  if (_smFiltNote) {
    const _lbls = [];
    if (_filtTaxon) _lbls.push('species / taxon only');
    if (_filtMedia) _lbls.push('image & video only');
    _smFiltNote.textContent = _lbls.length ? 'Filtered: ' + _lbls.join(' · ') : '';
  }
  // (dev0368/0384) Pick the landing page:
  //  • _smReturnPage (2–5) — a one-shot set when returning from a V item or a
  //    grid (Esc / swipe). Reopens the exact tab the viewer left.
  //  • else if Welcome was already shown once this session — open on the LAST tab
  //    the viewer used (window._smLastTab), defaulting to Choices (2). Coming
  //    straight from Welcome sets _smLastTab=2 via its "Choose a view" button, so
  //    the first hop after Welcome always lands on Choices.
  //  • else (very first entry) — show the Welcome splash and mark it seen.
  let _smStartPg;
  if (window._smReturnPage >= 2 && window._smReturnPage <= 5) {
    _smStartPg = window._smReturnPage;
  } else if (window._smWelcomeSeen) {
    _smStartPg = (window._smLastTab >= 2 && window._smLastTab <= 5) ? window._smLastTab : 2;
  } else {
    _smStartPg = 1;
  }
  window._smReturnPage = undefined;
  if (_smStartPg === 1) window._smWelcomeSeen = true;
  _smShow(_smStartPg);
  // (dev0384) Open focused on the tab so Tab-cycling works immediately.
  if (_smStartPg >= 2) setTimeout(() => _smFocusTab(_smStartPg), 40);

  // Open a single T item as V over a forced G backdrop, routing vpClose back to
  // this menu via _fromShareableMenu. Shared by the choice cards AND search
  // results. (Direct /tshare links never set this flag — they run locked.)
  const _smOpenV = uid => {
    window._smReturnPage = window._smCurPage; // (dev0367) come back to this page, not Welcome
    ov.remove();
    window._fromShareableMenu = true;
    const gOvl = document.getElementById('gridOverlay');
    if (gOvl) { gOvl.style.display = 'flex'; window._vpForcedGridFromT = true; }
    _openItemByUid(uid);
  };

  // (dev0378) Launch happens via the "▶ Open" button on each <details> card.
  // preventDefault keeps the click from also toggling the card open/closed.
  // (dev0379) Single shared launcher; rebound on every sort re-render.
  const _smLaunch = it => {
    if (!it) return;
    if (it.kind === 'v') {
      _smOpenV(it.uid);
    } else if (it.kind === 'ss') {
      // (dev0360) A grid choice from W opens G ONLY — the user starts the
      // slideshow from the hamburger when they want it. (dev0378) Now sourced
      // by ctxt + gname, so open the config directly by name.
      // (dev0384) Remember the tab we launched from so Esc / swipe on the grid
      // returns to THIS menu page (see _returnToMenuFromGrid + collection.js Esc).
      window._smReturnPage = window._smCurPage;
      ov.remove();
      window._fromShareableMenu = false;
      _openConfigByName(it.gname);
    }
  };

  // (dev0379) Sortable, table-like choice list. Header clicks toggle the sort
  // key/direction; the body is re-rendered (and its Open buttons re-bound) each
  // time. Default: Modified, newest at top.
  let _smSortKey = 'date', _smSortDir = -1, _smFilter = '';
  const _smRenderChoose = () => {
    const body = ov.querySelector('#smChooseBody');
    if (!body) return;
    let arr = items.slice().sort((a, b) => {
      let av, bv;
      if (_smSortKey === 'name') { av = (a.summary || '').toLowerCase(); bv = (b.summary || '').toLowerCase(); }
      else { av = a.dmRaw || ''; bv = b.dmRaw || ''; }
      if (av < bv) return -1 * _smSortDir;
      if (av > bv) return  1 * _smSortDir;
      return 0;
    });
    // (dev0381) Live filter — matches the visible summary AND the raw ttxt/ctxt
    // body so a search hits text that's hidden inside a collapsed card.
    if (_smFilter) arr = arr.filter(it =>
      ((it.summary || '') + ' ' + (it.html || '')).toLowerCase().includes(_smFilter));
    if (!arr.length) { body.innerHTML = '<div class="sm-chnone">No matches.</div>'; return; }
    body.innerHTML = arr.map(it => _smDetCard(it, items.indexOf(it))).join('');
    ov.querySelectorAll('#smPage2 .sm-chh').forEach(h => {
      const on = h.dataset.sort === _smSortKey;
      h.classList.toggle('on', on);
      const ar = h.querySelector('.sm-arrow');
      if (ar) ar.textContent = on ? (_smSortDir < 0 ? ' ▾' : ' ▴') : '';
    });
    body.querySelectorAll('.sm-open').forEach(el => {
      el.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        _smLaunch(items[parseInt(el.dataset.i, 10)]);
      });
    });
  };
  ov.querySelectorAll('#smPage2 .sm-chh').forEach(h => {
    h.addEventListener('click', () => {
      const k = h.dataset.sort;
      if (_smSortKey === k) { _smSortDir *= -1; }
      else { _smSortKey = k; _smSortDir = (k === 'date') ? -1 : 1; }
      _smRenderChoose();
    });
  });
  if (items.length) _smRenderChoose();
  // (dev0381) Choices toolbar wiring: live filter + expand/collapse-all. The
  // expand/collapse buttons act on whatever cards are currently rendered (i.e.
  // they respect the active filter).
  const _smChFilt = ov.querySelector('#smChFilter');
  const _smChClear = ov.querySelector('#smChClear');
  if (_smChFilt) _smChFilt.addEventListener('input', () => {
    _smFilter = _smChFilt.value.trim().toLowerCase();
    _smRenderChoose();
  });
  // (dev0382) Tab cycles filter ↔ Clear so the button is one Tab away and a
  // second Tab returns to the filter. Clear (click / Enter / Space — native on a
  // <button>) blanks the filter and refocuses the now-empty box.
  if (_smChFilt && _smChClear) {
    _smChFilt.addEventListener('keydown', e => {
      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); _smChClear.focus(); }
    });
    _smChClear.addEventListener('keydown', e => {
      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); _smChFilt.focus(); }
    });
    _smChClear.addEventListener('click', () => {
      _smChFilt.value = ''; _smFilter = ''; _smRenderChoose(); _smChFilt.focus();
    });
  }
  const _smSetAllOpen = open => ov.querySelectorAll('#smChooseBody details.sm-detcard')
    .forEach(d => { d.open = open; });
  const _smExpA = ov.querySelector('#smExpandAll');
  if (_smExpA) _smExpA.addEventListener('click', () => _smSetAllOpen(true));
  const _smColA = ov.querySelector('#smCollapseAll');
  if (_smColA) _smColA.addEventListener('click', () => _smSetAllOpen(false));

  // (dev0383) Navigation-Training choice table — a self-contained mirror of the
  // page-2 list, with its own sort/filter state, over `navItems` (the `ss`
  // source). Reuses _smDetCard / _smLaunch (kind 'ss' opens the grid by gname).
  let _smNavSortKey = 'date', _smNavSortDir = -1, _smNavFilter = '';
  const _smRenderNav = () => {
    const body = ov.querySelector('#smNavBody');
    if (!body) return;
    let arr = navItems.slice().sort((a, b) => {
      let av, bv;
      if (_smNavSortKey === 'name') { av = (a.summary || '').toLowerCase(); bv = (b.summary || '').toLowerCase(); }
      else { av = a.dmRaw || ''; bv = b.dmRaw || ''; }
      if (av < bv) return -1 * _smNavSortDir;
      if (av > bv) return  1 * _smNavSortDir;
      return 0;
    });
    if (_smNavFilter) arr = arr.filter(it =>
      ((it.summary || '') + ' ' + (it.html || '')).toLowerCase().includes(_smNavFilter));
    if (!arr.length) { body.innerHTML = '<div class="sm-chnone">No matches.</div>'; return; }
    body.innerHTML = arr.map(it => _smDetCard(it, navItems.indexOf(it))).join('');
    ov.querySelectorAll('#smPage5 .sm-chh').forEach(h => {
      const on = h.dataset.sort === _smNavSortKey;
      h.classList.toggle('on', on);
      const ar = h.querySelector('.sm-arrow');
      if (ar) ar.textContent = on ? (_smNavSortDir < 0 ? ' ▾' : ' ▴') : '';
    });
    body.querySelectorAll('.sm-open').forEach(el => {
      el.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        _smLaunch(navItems[parseInt(el.dataset.i, 10)]);
      });
    });
  };
  ov.querySelectorAll('#smPage5 .sm-chh').forEach(h => {
    h.addEventListener('click', () => {
      const k = h.dataset.sort;
      if (_smNavSortKey === k) { _smNavSortDir *= -1; }
      else { _smNavSortKey = k; _smNavSortDir = (k === 'date') ? -1 : 1; }
      _smRenderNav();
    });
  });
  if (navItems.length) _smRenderNav();
  const _smNavFilt = ov.querySelector('#smNavFilter');
  const _smNavClear = ov.querySelector('#smNavClear');
  if (_smNavFilt) _smNavFilt.addEventListener('input', () => {
    _smNavFilter = _smNavFilt.value.trim().toLowerCase();
    _smRenderNav();
  });
  if (_smNavFilt && _smNavClear) {
    _smNavFilt.addEventListener('keydown', e => {
      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); _smNavClear.focus(); }
    });
    _smNavClear.addEventListener('keydown', e => {
      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); _smNavFilt.focus(); }
    });
    _smNavClear.addEventListener('click', () => {
      _smNavFilt.value = ''; _smNavFilter = ''; _smRenderNav(); _smNavFilt.focus();
    });
  }
  const _smNavSetAllOpen = open => ov.querySelectorAll('#smNavBody details.sm-detcard')
    .forEach(d => { d.open = open; });
  const _smNavExpA = ov.querySelector('#smNavExpandAll');
  if (_smNavExpA) _smNavExpA.addEventListener('click', () => _smNavSetAllOpen(true));
  const _smNavColA = ov.querySelector('#smNavCollapseAll');
  if (_smNavColA) _smNavColA.addEventListener('click', () => _smNavSetAllOpen(false));

  // (dev0362) Search page — live anywhere-filter over all of T (precomputed
  // blobs), dictionary suggestions from tagsLib, a match count, and result
  // cards once matches < n.
  const _smBox = ov.querySelector('#smSearchBox');
  const _smSuggEl = ov.querySelector('#smSugg');
  const _smCountEl = ov.querySelector('#smCount');
  const _smResEl = ov.querySelector('#smResults');
  const _smRunSearch = () => {
    const q = (_smBox.value || '').trim();
    const lq = q.toLowerCase();
    if (_smSuggEl) {
      const sug = (q && window.tagsLib && window.tagsLib.search) ? window.tagsLib.search(q, 8) : [];
      _smSuggEl.innerHTML = sug.map(t => '<span class="sm-chip" data-q="' + _smEsc(t.common || t.label) + '">' + _smEsc(t.label) + '</span>').join('');
      _smSuggEl.querySelectorAll('.sm-chip').forEach(c =>
        c.addEventListener('click', () => { _smBox.value = c.dataset.q; _smRunSearch(); }));
    }
    if (!q) { _smCountEl.textContent = ''; _smResEl.innerHTML = ''; return; }
    // (dev0366) Apply the COI-declared filters before the threshold/render.
    let _hits = _tBlobs.filter(x => x.blob.includes(lq));
    if (_filtTaxon) _hits = _hits.filter(x => x.hasTaxon);
    if (_filtMedia) _hits = _hits.filter(x => x.kind === 'video' || x.kind === 'image');
    const matches = _hits.map(x => x.r);
    _smCountEl.textContent = matches.length + ' match' + (matches.length === 1 ? '' : 'es')
      + (matches.length >= _smN ? ' — keep typing to narrow below ' + _smN : '');
    if (matches.length && matches.length < _smN) {
      _smResEl.innerHTML = matches.map(r =>
        '<div class="sm-item sm-card" data-uid="' + _smEsc(String(r.UID)) + '">'
          + '<span class="sm-ico">' + (_smBadge[_smResultBadge(r)] || '🔗') + '</span>'
          + '<span class="sm-name">' + _smEsc(_smResultLabel(r)) + '</span>'
        + '</div>').join('');
      _smResEl.querySelectorAll('.sm-item').forEach(el =>
        el.addEventListener('click', () => _smOpenV(el.dataset.uid)));
    } else {
      _smResEl.innerHTML = '';
    }
  };
  if (_smBox) _smBox.addEventListener('input', _smRunSearch);
}
window._showShareableMenu = _showShareableMenu;

// (dev0384) Leave a grid that was opened from the shareable menu and re-mount
// the menu on the page it was launched from (window._smReturnPage, set by the
// ss launcher). Used by both the grid's Esc key (collection.js) and its R→L
// swipe-back (grid.js). Tears the grid players down first so nothing keeps
// playing behind the menu.
window._returnToMenuFromGrid = function () {
  if (typeof gridCleanupPlayers === 'function') gridCleanupPlayers();
  if (typeof gridClearCut === 'function') gridClearCut();
  if (typeof gridHideContextMenu === 'function') gridHideContextMenu();
  const g = document.getElementById('gridOverlay');
  if (g) g.style.display = 'none';
  const fs = document.getElementById('gridFullscreen');
  if (fs) fs.style.display = 'none';
  if (typeof window._showShareableMenu === 'function') window._showShareableMenu();
};

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
async function _openSlideshowBySsId(ssVal, launch) {
  // (dev0360) launch defaults true (?ss= deep-links auto-play). Pass false to
  // just activate the grid + show G (the W menu's grid choices do this).
  if (launch === undefined) launch = true;
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
  if (!launch) return;            // (dev0360) grid-only: G is now showing, stop here
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
  // (dev0366) When V was launched from the shareable menu, `_smOpenV` forces a
  // grid backdrop open and sets `_fromShareableMenu`. If V then fails to mount
  // (no data, bad UID, locked, or gridOpenFullscreen early-returns on an empty
  // row), the viewer is left staring at a blank dark grid with no escape. This
  // tears down that forced backdrop and re-mounts the Welcome menu so every V
  // type fails back to home instead of getting stuck.
  function _recoverMenu() {
    if (!window._fromShareableMenu) return;
    window._fromShareableMenu = false;
    if (window._vpForcedGridFromT) {
      const g = document.getElementById('gridOverlay');
      if (g) g.style.display = 'none';
      window._vpForcedGridFromT = false;
    }
    if (typeof window._showShareableMenu === 'function') setTimeout(() => window._showShareableMenu(), 50);
  }
  // (dev0249) Poll for data: on fresh page loads, `data` may still be
  // loading when this runs. Retry every 100ms up to 5 seconds before
  // giving up. Without this, the first call sees no data and silently
  // returns — leaving a blank screen on slow connections.
  const startedAt = Date.now();
  function tryOpen() {
    if (typeof data === 'undefined' || !Array.isArray(data) || data.length === 0) {
      if (Date.now() - startedAt > 5000) {
        if (typeof toast === 'function') toast('Could not load data — check your connection', 3000);
        _recoverMenu();
        return;
      }
      setTimeout(tryOpen, 100);
      return;
    }
    const row = data.find(r => String(r.UID) === want);
    if (!row) {
      if (typeof toast === 'function') toast('No item with UID ' + want, 2000);
      _recoverMenu();
      return;
    }
    // (dev0315) Anti-enumeration on the public site: a LOCKED link (?i=NNN
    // with no /unlock) may only open items that were explicitly shared —
    // i.e. rows carrying a non-empty `ttxt` block (dev0378: was `Direct`).
    // This stops a curious visitor from guessing ?i=6, ?i=7, … to browse the
    // whole library. Dev /unlock links (window._lockedUid unset) bypass the
    // check, and dev mode (localhost) is unaffected.
    const _um = (typeof _isUserMode === 'function') ? _isUserMode() : false;
    if (_um && window._lockedUid && !String(row.ttxt || '').trim()) {
      if (typeof toast === 'function') toast('Not found', 1500);
      _recoverMenu();
      return;
    }
    _lastGridRow = row;
    // Tick for any in-flight paint before stacking V on top.
    setTimeout(() => {
      if (typeof gridOpenFullscreen === 'function') gridOpenFullscreen(row);
      // (dev0366) Safety net: if V didn't actually mount (gridOpenFullscreen
      // early-returns on a row with no playable segment / no link / no ftext),
      // recover to the menu rather than leaving a blank forced grid backdrop.
      setTimeout(() => {
        const fsUp = document.getElementById('gridFullscreen') &&
                     document.getElementById('gridFullscreen').style.display === 'flex';
        if (!fsUp) _recoverMenu();
      }, 150);
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
