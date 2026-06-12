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
  greetTop = _balanceHtml(greetTop);
  greetIntro = _balanceHtml(greetIntro);

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
                 date: _smDateShort(r.DateModified), type: _smType(r) }));
  const gItems = cRows
    .filter(g => g && !g._salMeta && String(g.ctxt || '').trim() && g.gname && !_isGreeting(g.gname))
    .map(g => ({ kind: 'ss', gname: String(g.gname).trim(), html: String(g.ctxt),
                 summary: _smSummaryText(g.ctxt) || String(g.gname).trim(),
                 date: _smDateShort(g.DateModified), cells: Number(g.cells) || 0 }));
  const items = vItems.concat(gItems);

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
    const ico = it.kind === 'v' ? (_smBadge[it.type] || '🔗') : '▦';
    const tag = it.kind === 'v'
      ? '<span class="sm-tag">' + it.type + '</span>'
      : '<span class="sm-tag">' + (it.cells ? it.cells + ' cells' : 'grid') + '</span>';
    const dateTxt = it.date ? '<span class="sm-date">' + _smEsc(it.date) + '</span>' : '';
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
  // (dev0362) Two columns on desktop (Singles | Grids), stacked on phone.
  const _smNoItems = '<div style="padding:24px;color:#aa8;">No shareable items yet.</div>';
  const vCardsHtml = vItems.map((it, i) => _smDetCard(it, i)).join('');
  const gCardsHtml = gItems.map((it, i) => _smDetCard(it, vItems.length + i)).join('');

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
    + '.sm-detsum{display:flex;align-items:center;gap:12px;padding:15px 22px;cursor:pointer;color:#ddd;list-style:none;}'
    + '.sm-detsum::-webkit-details-marker{display:none;}'
    + '.sm-detsum::marker{content:"";}'
    + '.sm-detsum:hover{background:#15152a;}'
    + '.sm-detcard[open]>.sm-detsum{background:#15152a;}'
    + '.sm-date{flex:none;font-size:11px;color:#9fb0c8;font-family:sans-serif;white-space:nowrap;}'
    + '.sm-open{flex:none;font-family:sans-serif;font-size:12px;color:#cfe8ff;background:rgba(0,60,120,0.5);border:1px solid #4af;border-radius:6px;padding:5px 11px;cursor:pointer;white-space:nowrap;}'
    + '.sm-open:hover{background:rgba(0,80,150,0.7);}'
    + '.sm-detbody{padding:2px 22px 16px;}'
    + '.sm-ico{font-size:24px;line-height:1;flex:none;width:30px;text-align:center;}'
    + '.sm-name{flex:1;font-size:18px;}'
    + '.sm-tag{flex:none;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#fff;border:1px solid #3a4a6a;border-radius:10px;padding:2px 9px;white-space:nowrap;}'
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
    + '</style>';

  ov.innerHTML = menuStyle
    + '<div style="display:flex;align-items:center;padding:14px 16px;flex:none;'
      + 'background:#1a1a2e;border-bottom:2px solid #4af;">'
      // (dev0368) The Welcome page is now a one-time splash shown only on first
      // entry — nothing navigates back to it — so the old "‹ Welcome" back
      // button was removed. All returns land on the Main Page (Choose a view).
      + '<span style="color:#8ef;font-weight:bold;flex:1;font-size:15px;">SeaLifeAndMore</span>'
    + '</div>'
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
        + (items.length
            ? '<div class="sm-cols">'
                + '<div class="sm-col">' + (vItems.length ? '<div class="sm-colhdr">Singles</div>' : '') + vCardsHtml + '</div>'
                + '<div class="sm-col">' + (gItems.length ? '<div class="sm-colhdr">Grids</div>' : '') + gCardsHtml + '</div>'
              + '</div>'
            : _smNoItems)
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
    + '</div>'
    // (dev0366) Two-tab bar — Welcome is now a standalone page reached via the
    // header "‹ Welcome" button, so it's no longer a tab.
    + '<div class="sm-tabs">'
      + '<button class="sm-tab on" data-pg="2">Choose a view</button>'
      + '<button class="sm-tab" data-pg="3">Search</button>'
    + '</div>';

  document.body.appendChild(ov);

  // (dev0361/0362/0366/0368) Nav. Welcome (page 1) is a one-time splash shown
  // only on first entry; its tab bar is hidden. The 2-tab bar (Choose a view /
  // Search) — the "Main Page" — is shown on pages 2–3 and is where all returns land.
  const _smTabBar = ov.querySelector('.sm-tabs');
  const _smShow = n => {
    window._smCurPage = n; // (dev0367) remembered so a return from V re-opens here, not Welcome
    [1, 2, 3].forEach(k => { const p = ov.querySelector('#smPage' + k); if (p) p.style.display = (k === n) ? '' : 'none'; });
    ov.querySelectorAll('.sm-tab').forEach(t =>
      t.classList.toggle('on', parseInt(t.dataset.pg, 10) === n));
    if (_smTabBar) _smTabBar.style.display = (n === 1) ? 'none' : 'flex';
    if (n === 3) { const sb = ov.querySelector('#smSearchBox'); if (sb) setTimeout(() => sb.focus(), 30); }
  };
  ov.querySelectorAll('.sm-tab').forEach(t =>
    t.addEventListener('click', () => _smShow(parseInt(t.dataset.pg, 10) || 2)));
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
  // (dev0368) Pick the landing page:
  //  • _smReturnPage (2|3) — a one-shot set when returning from a V selection;
  //    reopens the exact tab the viewer left (Choose a view / Search).
  //  • else if Welcome was already shown once this session — go straight to the
  //    Main Page (2). Welcome is a splash; HMenu-from-G / returns never re-show it.
  //  • else (very first entry) — show the Welcome splash and mark it seen.
  let _smStartPg;
  if (window._smReturnPage === 2 || window._smReturnPage === 3) {
    _smStartPg = window._smReturnPage;
  } else if (window._smWelcomeSeen) {
    _smStartPg = 2;
  } else {
    _smStartPg = 1;
  }
  window._smReturnPage = undefined;
  if (_smStartPg === 1) window._smWelcomeSeen = true;
  _smShow(_smStartPg);

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
  ov.querySelectorAll('#smPage2 .sm-open').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const it = items[parseInt(el.dataset.i, 10)];
      if (!it) return;
      if (it.kind === 'v') {
        _smOpenV(it.uid);
      } else if (it.kind === 'ss') {
        // (dev0360) A grid choice from W opens G ONLY — the user starts the
        // slideshow from the hamburger when they want it. (dev0378) Now sourced
        // by ctxt + gname, so open the config directly by name.
        ov.remove();
        window._fromShareableMenu = false;
        _openConfigByName(it.gname);
      }
    });
  });

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
