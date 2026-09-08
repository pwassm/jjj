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
document.getElementById('cDuplicateBtn').addEventListener('click', cDuplicateSelected);
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
// (dev0707) The hostname half of the test above, on its own and WITHOUT the
// mode overrides. Two different questions were being conflated:
//
//   _isUserMode()      "which UI should this viewer get?"   — honours ?mode= and
//                      the localStorage toggle, so it is TRUE on localhost when
//                      a dev is previewing the user build.
//   _salIsLocalHost()  "is the 127.0.0.1:8081 proxy even reachable?" — a pure
//                      fact about the origin that no override can change.
//
// Anything that talks to the proxy must ask THIS one. Asking _isUserMode()
// instead would silently kill the proxy during a ?mode=user preview; asking
// neither is what shipped a POST to 127.0.0.1:8081 from sealifeandmore.com and
// earned every viewer of an IG grid a browser permission prompt ("… wants to
// access other apps and services on this device"). See video.js igMetaFetch.
function _salIsLocalHost() {
  const h = (window.location.hostname || '').toLowerCase();
  return (
    h === '' || h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0'
    || /^192\.168\./.test(h) || /^10\./.test(h)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}
window._salIsLocalHost = _salIsLocalHost;

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
  if (!_salIsLocalHost()) {
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
  // (dev0641) Mark phones so CSS can drop chrome that's only wanted on
  // desktop Gu (the UID badge + the ⚙ Configs button).
  document.documentElement.classList.toggle('is-mobile', _isMobileDevice());
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
        // (dev0944) Mark the link KIND, not just the lock state. A bare ?c= is
        // locked-mode like a bare ?i=, but its whole purpose is to show G — so
        // the locked-mode rule that hides #gridOverlay has to spare this case.
        document.documentElement.classList.add('deep-config');
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
    // (dev0638) Stash utility params BEFORE the rewrite below erases the query
    // — grid.js reads ?buf= lazily at mount time, long after this runs, so on
    // the public site the param silently vanished (the dev0637 phone POC's
    // "no evidence of pre-roll" report). Dev mode keeps the query; stashing
    // unconditionally is harmless there.
    try {
      var _bufQ = new URLSearchParams(window.location.search).get('buf');
      if (_bufQ !== null) window._salBufParam = _bufQ;
    } catch (e) {}
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
  // (dev0570) AUTO-FULLSCREEN REMOVED per user ("get rid of auto-F11, it is a
  // nuisance"). The dev0557/0558 behaviour silently entered browser fullscreen on
  // the FIRST click/keypress after load — surprising and unwanted. Fullscreen is
  // now MANUAL ONLY: press 0 from any screen to toggle it (window._toggleFullscreen,
  // wired into core.js's window-capture keydown). Kept as a no-op so the existing
  // call site (load().then) still resolves without error.
}

// (dev0570) Toggle browser fullscreen — the F11 equivalent, driven by the bare-0
// hotkey (core.js window-capture). MUST be called from a user gesture (a keydown
// qualifies) or the browser rejects requestFullscreen. Enters if not currently
// fullscreen, otherwise exits. Fails soft on any browser that lacks the API.
// (dev0708) THE SITE NO LONGER REQUESTS FULLSCREEN ANYWHERE BY ITSELF. dev0707
// put a requestFullscreen() on the "Choose a view →" button, and it was wrong for
// a reason that is worth recording so it is not tried a third time:
//
//   The Fullscreen API REQUIRES the browser to offer an escape hatch, and in
//   every browser that hatch is the Esc key. A page cannot preventDefault() it.
//   SLAM uses Esc as its main navigation key (Xs→Xe→T, closing V / the filter /
//   a slideshow), so API fullscreen and this app's navigation are fighting over
//   the same key and the API always wins — every navigational Esc also dumped
//   the viewer out of fullscreen.
//
//   The browser's OWN fullscreen (F11 on Windows/Linux, ⌃⌘F on macOS) is a
//   DIFFERENT mode and ignores Esc entirely, so it is the one that actually
//   stays. It cannot be triggered from script — F11 is browser chrome, not a web
//   API — so the only honest thing the site can do is TELL the viewer the key.
//   That is now a row in the grid's help panel (helpfloat.js HP_ADD.G).
//
// Bare 0 below is kept: it is the in-page toggle, useful on a phone or kiosk
// where there is no F11 and no Esc key to collide with in the first place.
function _toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen();
    } else {
      const el = document.documentElement;
      if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    }
  } catch (_) {}
}
window._toggleFullscreen = _toggleFullscreen;

// (dev0551) Render + wire the optional sign-in strip on Page 1 of the
// shareable menu. Anonymous browsing never touches this — it only reacts once
// the viewer chooses to sign in. All API work goes through window.salAuth
// (auth.js), which itself fails soft, so any failure here degrades to "signed
// out" rather than breaking the menu.
function _wireSignIn(ov) {
  const box = ov.querySelector('#smAuth');
  const A = window.salAuth;
  if (!box || !A) return;   // auth.js absent → strip stays empty, browsing unaffected

  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // (dev0934) The sign-in strip is the whole visible body of the Contact tab
  // below the author's prose, and it was the last block of hard-coded English
  // left on a Spanish page. Every string here goes through T(). The one that
  // interpolates a value is a WHOLE-SENTENCE key with a {who} placeholder
  // rather than two concatenated fragments, so the translator controls the word
  // order instead of inheriting English's.
  const _T = window.T || (x => x);
  const _fill = (str, map) => String(str).replace(/\{(\w+)\}/g, (m, k) => (k in map ? map[k] : m));

  // Signed-in view: who you are + a sign-out link. Experts/admins get a hint
  // that they can contribute comments on items.
  function renderIn(u) {
    const who = esc(u.name || u.email);
    const canComment = (u.role === 'expert' || u.role === 'admin');
    box.innerHTML = '<div id="smWho">'
      + _fill(_T('Signed in as {who}'), { who: '<b>' + who + '</b>' })
      + (canComment ? ' <span style="color:#8fe8b0;">· ' + _T('you can comment on items') + '</span>' : '')
      + ' · <a class="sm-link" id="smSignOut">' + _T('Sign out') + '</a>'
      + '</div>'
      // (dev0955) The whole point of signing in on the Contact page is to be
      // able to say something, and until now the signed-in state was a dead
      // end: a name and a sign-out link, no composer. /messages and
      // salAuth.postMessage already existed — only the box was missing.
      + '<div id="smCompose"></div>';
    box.querySelector('#smSignOut').addEventListener('click', () => {
      A.logout().then(() => renderOut());
    });
    renderCompose(box.querySelector('#smCompose'));
  }

  // The message composer shown to any signed-in viewer. Sends kind 'general'
  // through /messages, which Phil reads on /admin/messages. Failures are
  // reported in place and leave the typed text intact so nothing is lost.
  function renderCompose(host) {
    if (!host) return;
    host.innerHTML =
        '<div class="sm-composelabel">' + _T('Send me a message') + '</div>'
      + '<textarea id="smMsgBody" class="sm-composebox" rows="5" placeholder="'
      +   esc(_T('Type your message…')) + '"></textarea>'
      + '<div class="sm-authrow"><button id="smMsgSend">' + _T('Send') + '</button></div>'
      + '<div class="sm-authmsg" id="smMsgMsg" style="display:none;"></div>';
    const ta  = host.querySelector('#smMsgBody');
    const btn = host.querySelector('#smMsgSend');
    const msg = host.querySelector('#smMsgMsg');
    const setMsg = (text, isErr) => {
      msg.style.display = 'block';
      msg.className = 'sm-authmsg' + (isErr ? ' err' : '');
      msg.textContent = text;
    };
    btn.addEventListener('click', () => {
      const text = ta.value.trim();
      if (!text) { setMsg(_T('Please write a message first.'), true); return; }
      btn.disabled = true; setMsg(_T('Sending…'), false);
      A.postMessage(text).then(d => {
        btn.disabled = false;
        if (d && d.ok) {
          ta.value = '';
          setMsg(_T('Thank you — your message has been sent.'), false);
        } else {
          const e = d && d.error;
          setMsg(e === 'network' ? _T('Could not reach the server. Please try again.')
                                 : String(e || _T('Could not send. Please try again.')), true);
        }
      });
    });
    // Ctrl/Cmd+Enter sends, the convention for a textarea where Enter is a
    // newline.
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); btn.click(); }
    });
  }

  // Signed-out view: a quiet link that expands into an email field. Submitting
  // asks the API to email a one-time sign-in link (or, in the worker's dev
  // mode, hands the link straight back so it can be tested without email).
  function renderOut() {
    box.innerHTML = '<a class="sm-link" id="smSignInLink">' + _T('Sign in') + '</a>'
      + ' <span style="color:#66788f;">' + _T('(optional — to comment or send a note)') + '</span>';
    box.querySelector('#smSignInLink').addEventListener('click', showForm);
  }

  function showForm() {
    box.innerHTML =
        '<div class="sm-authrow">'
      +   '<input id="smEmail" type="email" placeholder="you@example.com" autocomplete="email">'
      +   '<button id="smSend">' + _T('Send me a sign-in link') + '</button>'
      + '</div>'
      + '<div class="sm-authmsg" id="smAuthMsg" style="display:none;"></div>';
    const inp = box.querySelector('#smEmail');
    const btn = box.querySelector('#smSend');
    const msg = box.querySelector('#smAuthMsg');
    inp.focus();
    const setMsg = (html, isErr) => {
      msg.style.display = 'block';
      msg.className = 'sm-authmsg' + (isErr ? ' err' : '');
      msg.innerHTML = html;
    };
    const submit = () => {
      const email = inp.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setMsg(_T('Please enter a valid email address.'), true); return; }
      btn.disabled = true; setMsg(_T('Sending…'), false);
      A.requestLink(email).then(d => {
        btn.disabled = false;
        if (d && d.devLink) {
          // Worker in dev mode: no email is sent, the link comes back inline.
          setMsg('Dev mode — <a href="' + esc(d.devLink) + '">open your sign-in link</a>.', false);   // dev-only, never seen by a viewer
        } else if (d && d.sent) {
          setMsg(_T('Check your email ✉ — the sign-in link works once and expires in 15 minutes.'), false);
        } else if (d && d.error) {
          setMsg(esc(d.error === 'network' ? _T('Could not reach the server. Please try again.') : d.error), true);
        } else {
          setMsg(_T('Check your email ✉'), false);
        }
      });
    };
    btn.addEventListener('click', submit);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  }

  // Decide initial state. me() short-circuits to null when there's no token,
  // so anonymous visitors make no network call.
  A.me().then(u => { u ? renderIn(u) : renderOut(); }).catch(() => renderOut());
}

// ─────────────────────────────────────────────────────────────────────────────
// (dev0668) PUBLIC-MENU FEATURE SWITCHES — one line each, nothing else to edit.
//
//   SM_FEAT_SEARCH  false → the Search AND SavedSearches tabs vanish completely
//                           (no tab buttons, no pages, dropped from the Tab-key
//                           order, and a remembered "last tab" of 3/6 falls back
//                           to Grids). true → both are live. ONE switch, BOTH
//                           tabs — they are one feature: a saved search is just
//                           a query the Search tab produced.
//   SM_FEAT_ADDOWN  false → the "Add your own" tab vanishes the same way.
//                           Existing user links/loops are untouched in storage,
//                           just unreachable until it's switched back on.
//   SM_FEAT_LANG    false → the Español / English toggle on the Intro page is
//                           not rendered. (dev0951) Parked, not removed: lang.js
//                           still loads, the Spanish files are still there, and
//                           a viewer already switched to Spanish stays in it —
//                           only the way IN from the menu is withheld while the
//                           translation work is on the shelf. Flip to true and
//                           the button, its wiring and its CSS come back
//                           untouched.
//
// Flipping either one needs a HELP_VERSION_STR bump like any other JS edit, or
// browsers will keep serving the cached boot.js.
const SM_FEAT_SEARCH = true;
const SM_FEAT_ADDOWN = true;
const SM_FEAT_LANG   = false;   // (dev0951) parked — see above

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
  // (dev0930) The menu is the one surface that must not paint English and then
  // correct itself, so it waits for lang.es.json here. Everywhere else T() is
  // synchronous with an English fallback and the dictionary has long since
  // landed by the time a grid or a viewer mounts. Fails soft: a missing or
  // broken lang file resolves to an empty dictionary, and every T() call
  // returns its English argument.
  if (window.salLang) { try { await window.salLang.ready(); } catch (e) {} }

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
  // (dev0739) The on-screen keyboard is a sibling of the menu, not a child, so
  // removing the menu leaves it floating over whatever comes next.
  if (window.salKeyboardClose) window.salKeyboardClose();

  // Load ml.json and c.json — FSA folder first, HTTP fallback.
  let ml = null, cj = null;
  try {
    const dir = (typeof _getDir === 'function') ? await _getDir() : null;
    if (dir) {
      try { const fh = await dir.getFileHandle('ml.json'); ml = JSON.parse(await (await fh.getFile()).text()); } catch (e) {}
      try { const fh = await dir.getFileHandle('c.json');  cj = JSON.parse(await (await fh.getFile()).text()); } catch (e) {}
    }
    // (dev0853) HTTP fallback tries ml.json then the published copy. On this
  // machine ml.json is on disk (and gitignored); on GitHub Pages only
  // ml.public.json is committed, so that is what the site gets. See the
  // ML_PUBLIC block in core.js for why the file is split at all.
  if (!ml) {
    for (const _mlF of ['ml.json', 'ml.public.json']) {
      try { const r = await fetch(_mlF + '?t=' + Date.now()); if (r.ok) { ml = await r.json(); break; } } catch (e) {}
    }
  }
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
  // (dev0934) THE ONE READ PATH for a menu page's prose. In Spanish it returns
  // the ctxt.es.json copy for that config row; in every other case — English,
  // no translation, no lang.js at all — the row's own ctxt, which is what this
  // was before. READS go through here; the C screen and Xe keep writing
  // cfg.ctxt directly, so a translation can never reach c.json.
  const _ctxtOf = cfg => (typeof window.salCtxt === 'function'
    ? window.salCtxt(cfg) : String((cfg && cfg.ctxt) || ''));
  // (dev0378) Greeting prose now lives in c.json: the config row whose gname is
  // "Greeting", in its `ctxt` field. Fall back to the legacy ml.json ttxt-row
  // ftext, then to a greeting.html file on disk.
  const greetCfg = cRows.find(r => r && !r._salMeta && _isGreeting(r.gname));
  let greetingHtml = greetCfg ? String(_ctxtOf(greetCfg) || '') : '';
  if (!greetingHtml && greetRow) greetingHtml = String(greetRow.ftext || '');
  if (!greetingHtml) {
    try { const r = await fetch('greeting.html?t=' + Date.now()); if (r.ok) greetingHtml = await r.text(); } catch (e) {}
  }
  // (dev0700) A ⊘ Hide block (div.te-cut) in the GREETING acts as a cut-to-the-
  // end marker, not just an in-place hide: everything from the marker down is
  // dropped. The greeting isn't a slide, but the author expects it to behave
  // like one — park work-in-progress prose below the marker and it disappears
  // from the public landing page (and from the page-2 lead text after the <hr>).
  // (dev0712) Same rule, now from the one shared helper in core.js, so the
  // landing page and the Xs slide preview of this very ctxt agree. The helper
  // also re-balances the tags the old string slice left orphaned.
  // (dev0763) …and it is not only the greeting. Xe's ⊘ HideFromHere marker is
  // honoured by every SLIDE view (renderFtext) and by the greeting, but the menu
  // read ttxt/ctxt raw — so a cut line hid nothing on the "Other" page or in the
  // Singles/Grids cards, while the same text obeyed it on the slide. One helper,
  // every menu surface. (A ⊘ HideSection block was always hidden here by the
  // global .te-cut CSS rule; only the cut LINE needed this.)
  const _cutBelow = h => (typeof _salApplyCutBelow === 'function'
    ? _salApplyCutBelow(String(h || '')) : String(h || ''));
  greetingHtml = _cutBelow(greetingHtml);
  // (dev0361) Split the greeting at its FIRST <hr> (the Xe ══ divider): prose
  // BEFORE the rule is page 1 (welcome / landing), prose AFTER is the lead text
  // shown atop page 2 ("Choose a view"). No <hr> → it all stays on page 1.
  // (dev0767) The AFTER half is unchanged — it still leads the Grids tab. The
  // BEFORE half is now only the FALLBACK for page 1: the Intro tab prefers the
  // c.json "Introduction" config (introHtml, below) and reaches back here only
  // when that row doesn't exist yet.
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

  // (dev0939) THE TWO-SECTION RULE, in one place. A HYBRID tab is prose, a
  // divider, more prose — and the page composes between the halves an element
  // that is NOT in the text: the image of the day on Introduction, the sign-in
  // strip on Contact. Both of those are hard-coded here; what the author
  // controls from Xe is where they sit, by where the first <hr> falls.
  //
  //     section 1  →  above the injected element
  //     section 2  →  below it
  //     section 3+ →  DROPPED
  //
  // There are only two slots, so anything under a SECOND <hr> is parking space,
  // not page content — it neither renders nor drags its divider onto the page.
  // (Before this, everything after the first <hr> was section 2, so a third
  // section leaked out below the fold, rule and all.)
  //
  // The rule is keyed to the ROW, by gname — "Introduction" and "Contact" —
  // never to a tab number. `active` (the tab's position in the bar) and data-pg
  // (its identity in the DOM) can both be renumbered and this still follows the
  // right two rows.
  const _twoSections = html => {
    const src = String(html || '');
    const hrs = Array.from(src.matchAll(/<hr\b[^>]*>/gi));
    if (!hrs.length) return { top: src, bottom: '' };
    return {
      top: src.slice(0, hrs[0].index),
      // Stop at the second <hr> if there is one; run to the end if there isn't.
      bottom: src.slice(hrs[0].index + hrs[0][0].length,
                        hrs[1] ? hrs[1].index : undefined)
    };
  };

  // (dev0940) The Introduction / other / contact / "starting out" lookups that
  // stood here are GONE. Each one found its row by matching a magic gname, which
  // is what made renaming a tab a code-breaking act (SlamTabs.md trap T2). Every
  // tab's prose now arrives through the tab registry below, selected by `Kind`.
  // greetTop / greetIntro survive as the two compatibility fallbacks it uses.

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

  // ── (dev0779) THE IMAGE OF THE DAY ──────────────────────────────────────────
  // A property of the INTRO PAGE, not of the author's prose. The page composes
  // it between the ctxt's two sections; nothing about it appears in the HTML the
  // author edits, so Xe stays an HTML editor and the ctxt stays plain HTML.
  //
  // WHICH row: the ml.json row whose `UOD` column holds today's day of the
  // month, 1–31. (dev0780) dev0779 shipped reading `DateUse` — a column that
  // does not exist on any row — so the match never fired and the fallback UID
  // it fell through to, 3009, is not in ml.json either: the block rendered
  // nothing, every day. `UOD` is the column the author actually added.
  //
  // The row supplies BOTH parts: `link` is the media, `ftext` is the caption.
  //
  // NOT every day is assigned yet (two rows carry a UOD today), so an exact
  // miss walks BACKWARDS to the nearest assigned day and wraps past the 1st to
  // the highest one. That way the front door always shows something once any
  // row is stamped, and stamping a new day still takes it over with no code
  // change. Nothing is picked at all when no row carries a UOD.
  const _smDayNum = () => {
    // ?introday=N previews another day without touching the clock. LOCAL date,
    // so the day turns over at the viewer's midnight, not UTC's.
    let d = 0;
    try { d = parseInt(new URLSearchParams(location.search).get('introday'), 10) || 0; } catch (e) {}
    return (d >= 1 && d <= 31) ? d : new Date().getDate();
  };
  // Every row with a usable UOD (1–31), as {n, row}. A blank cell is not a 0.
  const _smDayPool = () => mlRows.reduce((out, r) => {
    if (!r || r._salMeta) return out;
    const n = parseInt(String(r.UOD == null ? '' : r.UOD).trim(), 10);
    if (n >= 1 && n <= 31) out.push({ n: n, row: r });
    return out;
  }, []);
  // (dev0787) The pool is kept SORTED by day, because the page's ‹ › arrows now
  // step through it: "the previous day's picture" is the previous ASSIGNED day,
  // not yesterday's date, so that every arrow press lands on something. One
  // list, built once per menu open; _smDayIdx below is an index into it.
  const _smDayList = _smDayPool().sort((a, b) => a.n - b.n);
  // Where the page opens: today if today is assigned, else the nearest assigned
  // day below it, else (nothing below) the highest — so the front door always
  // shows something once any row is stamped. -1 = no row carries a UOD at all.
  const _smDayStart = () => {
    if (!_smDayList.length) return -1;
    const want = _smDayNum();
    const exact = _smDayList.findIndex(p => p.n === want);
    if (exact >= 0) return exact;
    let below = -1;
    for (let k = 0; k < _smDayList.length; k++) if (_smDayList[k].n < want) below = k;
    return below >= 0 ? below : _smDayList.length - 1;
  };
  // The day on show. The arrows move it; nothing else does.
  let _smDayIdx = _smDayStart();
  // Direct media files only — the author is starting with the self-hosted mp4s.
  // A YouTube/Vimeo watch page is not something a <video> can play, and a raw
  // URL printed on the public front door is worse than an empty space, so
  // anything else renders nothing and says why in the console.
  const _SM_DAY_VID = /\.(mp4|webm|ogv|ogg|mov|m4v)$/i;
  const _SM_DAY_IMG = /\.(jpg|jpeg|png|gif|webp|svg|bmp|avif)$/i;
  // (dev0787) The date line that sits above the picture. UOD is a day of the
  // MONTH, so the month and the year come from the viewer's own clock. A day
  // that does not exist in this month (31 in a 30-day one) gets a plain "Day N"
  // label rather than silently rolling over into the next month, which is what
  // `new Date(y, m, 31)` would otherwise print.
  const _smDayLabel = n => {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), n);
    if (d.getDate() !== n) return 'Day ' + n;
    try { return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }); }
    catch (e) { return 'Day ' + n; }
  };
  // (dev0787) The item itself: the date between two arrows, the picture sized to
  // what is left of the screen, the caption under it. dev0781/0782 had it folded
  // shut behind a one-line summary with a tenth-size thumbnail; the front page
  // shows the picture outright now, so there is nothing left to unfold.
  //
  // Returns the INNER html only — the .sm-dayitem box is in the page markup and
  // stays put, so an arrow press re-fills it instead of rebuilding the menu.
  const _smDayInnerHtml = () => {
    const e = (_smDayIdx >= 0) ? _smDayList[_smDayIdx] : null;
    if (!e) {
      try { console.warn('[image of the day] no ml.json row carries a UOD (1-31); nothing to show for day ' + _smDayNum()); } catch (x) {}
      return '';
    }
    const row = e.row;
    const link = String(row.link || '').trim();
    const path = link.split(/[?#]/)[0];
    // Direct media files only, as before — a YouTube watch page is not something
    // a <video> can play, and a raw URL printed on the public front door is
    // worse than an empty space. (dev0787) But such a day keeps its date line
    // and its arrows: dropping the whole block would strand the viewer on a day
    // they could only leave by reloading. Only the picture is missing.
    const bad = !link ? 'UID ' + row.UID + ' has no link'
              : (!_SM_DAY_VID.test(path) && !_SM_DAY_IMG.test(path))
                ? 'UID ' + row.UID + ' is not a direct media file: ' + link
              : '';
    if (bad) { try { console.warn('[image of the day] ' + bad); } catch (x) {} }
    const src = _smEsc(link).replace(/"/g, '&quot;');
    const isVid = _SM_DAY_VID.test(path);
    // On screen from the moment the page opens, so a video autoplays — muted,
    // like every video on this page — instead of waiting to be unfolded.
    const media = bad ? ''
      : (isVid
          ? '<video src="' + src + '" controls autoplay loop muted playsinline preload="metadata"></video>'
          : '<img src="' + src + '" alt="">');
    // The caption is the row's ftext WHOLE (dev0781 showed only its first line,
    // as the summary of the fold that is now gone), through the same renderer
    // every other slide uses — so a ⊘ cut, a collapsible and a v.NNN link all
    // behave here exactly as they do on a slide.
    const capRaw = String(row.ftext || '').trim();
    const capHtml = capRaw
      ? ((typeof renderFtext === 'function') ? renderFtext(capRaw) : capRaw)
      : '';
    // One assigned day means the arrows have nowhere to go; they stay visible
    // (so the line doesn't reflow once a second day is stamped) but disabled.
    const many = _smDayList.length > 1;
    return '<div class="sm-daynav">'
        + '<button type="button" class="sm-dayarrow" data-dir="-1" aria-label="Previous day"' + (many ? '' : ' disabled') + '>&#8249;</button>'
        + '<span class="sm-daydate">' + _smEsc(_smDayLabel(e.n)) + '</span>'
        + '<button type="button" class="sm-dayarrow" data-dir="1" aria-label="Next day"' + (many ? '' : ' disabled') + '>&#8250;</button>'
      + '</div>'
      + (media ? '<div class="sm-daymedia">' + media + '</div>' : '')
      + (capHtml.trim() ? '<div class="sm-daycap">' + capHtml + '</div>' : '');
  };
  // Console handle: which row is on show, and why nothing showed if nothing did.
  window._smDayItem = () => {
    const e = (_smDayIdx >= 0) ? _smDayList[_smDayIdx] : null;
    const r = e ? e.row : null;
    return { day: _smDayNum(), uid: r ? r.UID : null, uod: e ? e.n : null,
             pickedBy: !e ? 'nothing — no row carries a UOD'
                          : (e.n === _smDayNum() ? 'UOD == today' : 'nearest earlier UOD (' + e.n + ')'),
             assigned: _smDayList.map(x => x.n + '→' + x.row.UID),
             link: r ? String(r.link || '') : '', ftext: r ? String(r.ftext || '').slice(0, 80) : '' };
  };

  // (dev0400) Search page show-threshold. Result cards appear once the match
  // count is _smN OR FEWER (was "below n"). Fixed at 25 in code now — the old
  // Greeting-row MPix knob ("20") confused more than it helped, and 25 is the
  // largest grid we build from results (see _smBuildGridFromRows).
  const _smN = 25;
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
  // (dev0668) THE ml.json SEARCH LIMITATION, applied here in one place.
  // A viewer-facing search only offers what a viewer can actually WATCH and
  // LOOP: YouTube, Vimeo, a direct video file, or a direct image. Everything
  // else in ml.json is filtered out of the counts, the result cards and the
  // "Make + Show grid" set alike, so the number the viewer sees always matches
  // what they get.
  //   • Instagram / TikTok rows — their embeds are sandboxed cross-origin
  //     iframes with no seek API, so A→B loops on them are impossible.
  //   • Slides / quizzes / bare web links — no media to play.
  // Same rule as salLinks.classify (loops.js), so a row found by Search and a
  // URL the viewer pastes on "Add your own" behave identically.
  const _smPlayable = r => {
    const link = String((r && r.link) || '').trim();
    if (!link) return false;
    if (window.isYouTubeLink && window.isYouTubeLink(link)) return true;
    if (window.isVimeoLink && window.isVimeoLink(link)) return true;
    if (window.isDirectVideoLink && window.isDirectVideoLink(link)) return true;
    if (window.isImageLink && window.isImageLink(link)) return true;
    return false;
  };
  const _tBlobs = mlRows
    .filter(r => r && !r._salMeta && r.UID != null && !_isGreeting(r.ttxt))
    .map(r => {
      // (dev0854) 'link' is NOT in the blob. A YouTube/Vimeo id is a random
      // alphanumeric string, so short queries hit it by accident: 'oxy' matched
      // youtu.be/pIHcatOXyf4 (a gumboot chiton) and youtu.be/CKoXY1Y0kGk (table
      // tennis) alongside the eight real Oxyjulis rows. No viewer searches by
      // URL, so the field is pure noise here.
      // (dev0855) salFold, not toLowerCase: the blob and the query are folded
      // with the SAME function so a viewer can type 'senorita' for 'señorita'.
      const staticBlob = window.salFold(['VidAuthor', 'VidTitle', 'VidComment'].map(f => String(r[f] || '')).join(' ')
        + ' ' + String(r.ftext || '').replace(/<[^>]*>/g, ' '));
      const kind = window.rowMediaKind ? window.rowMediaKind(r) : 'other';
      const playable = _smPlayable(r);
      // (dev0400) Tag text is resolved LAZILY (see _smResolveTags) rather than
      // here at build time. The menu can open before tags.js finishes loading,
      // and a build-time miss left dictionary terms (a species' common name,
      // scientific name, or alias) permanently unsearchable for that menu
      // instance — the cause of "search 'cocka' misses the Snowball/cockatoo
      // rows". Resolving at search time means it works as soon as tags load.
      return { r, staticBlob, kind, playable,
               tagIds: Array.isArray(r.tags) ? r.tags : [],
               tagBlob: null, hasTaxon: false };
    });
  // (dev0740) The "Searches N playable items" line this counted for is gone —
  // the count is dropped, not merely hidden. Kept as a one-liner rather than
  // deleted because `playable` is the filter _smRunSearch applies (see the
  // x.playable check there), and the total is the first thing anyone will want
  // back if a result set ever looks short.
  const _smPlayableN = _tBlobs.filter(x => x.playable).length;
  void _smPlayableN;
  // (dev0400) Resolve a blob entry's dictionary-tag text once tagsLib exists.
  // Caches on first success; retries (leaves tagBlob null) while tags are still
  // loading. Includes label + common + aliases + def so every facet of a tag is
  // searchable (was only label + common).
  // (dev0420) tagsLib (the API object) is assigned synchronously at script load,
  // but its DATA only fills in after the async tags.json fetch resolves. The
  // public greeting menu opens BEFORE that fetch lands, so "the object exists"
  // (!window.tagsLib) is the wrong readiness test — it let _smResolveTags cache
  // empty tag blobs and made the SavedSearches retry below never fire, so every
  // tag/taxon-gated query showed a permanent "0 matches now" on slam.com.
  const _tagsReady = () => !!(window.tagsLib && typeof window.tagsLib.all === 'function'
                              && window.tagsLib.all().length > 0);
  const _smResolveTags = e => {
    if (e.tagBlob !== null || !_tagsReady()) return;
    let tb = '', taxon = false;
    e.tagIds.forEach(tid => {
      const t = window.tagsLib.get(tid);
      if (!t) return;
      tb += ' ' + (t.label || '') + ' ' + (t.common || '')
          + ' ' + (Array.isArray(t.aliases) ? t.aliases.join(' ') : '')
          + ' ' + (t.def || '');
      if (t.kind === 'taxon') taxon = true;
    });
    e.tagBlob = window.salFold(tb);   // (dev0855) same fold as the query
    e.hasTaxon = taxon;
  };
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
  // (dev0401) Secondary line for a search result: the row's dictionary tags
  // (common name preferred) followed by its comment — so a result is identified
  // by more than just the video title. Skips a comment that just repeats the
  // name (image rows label by VidComment).
  const _smResultMeta = r => {
    const parts = [];
    if (window.tagsLib && Array.isArray(r.tags)) {
      const labels = r.tags
        .map(tid => { const t = window.tagsLib.get(tid); return t ? (t.common || t.label) : null; })
        .filter(Boolean);
      if (labels.length) parts.push('🏷 ' + labels.join(', '));
    }
    const cmt = String(r.VidComment || '').trim();
    if (cmt && cmt !== _smResultLabel(r)) parts.push(cmt);
    return parts.join('  ·  ');
  };

  // Choices, re-read fresh on every open. V items (from T / ml.json `Direct`)
  // first, then SS grids (from C / c.json), so the combined `items` index used
  // by the tap handler stays stable.
  // (dev0378) Singles now come from ml.json `ttxt` (was `Direct`): every content
  // row whose ttxt details-block is non-empty. Grids now come from c.json `ctxt`
  // (was the `ss` field / gname label): every config row whose ctxt is occupied
  // and that has a gname to open by. Both carry the raw HTML + DateModified so
  // each card can show a summary line, a date, and an expandable details body.
  // (dev0763) _cutBelow FIRST, then read the summary out of what's left, so a
  // card's title and its body agree about where the author cut.
  const vItems = mlRows
    .filter(r => r && !r._salMeta && String(r.ttxt || '').trim() && !_isGreeting(r.ttxt) && r.UID != null)
    .map(r => { const h = _cutBelow(r.ttxt); return { kind: 'v', uid: String(r.UID), html: h,
                 summary: _smSummaryText(h) || ('UID ' + r.UID),
                 date: _smDateShort(r.DateModified), dmRaw: String(r.DateModified || ''),
                 type: _smType(r) }; })
    .filter(it => it.html.trim());
  // (dev0596) A collection is only shown on the public "Grids" tab when its
  // config row carries a number in the c.json `active` column. Draft/unlisted
  // grids stay hidden from viewers until curated in.
  // (dev0700) `active` is now an ORDER, not a flag: any positive number lists
  // the grid, and the list is presented in ascending `active` order (1 first).
  // Equal numbers fall back to whatever order c.json holds them in.
  const _smOrd = v => { const n = parseFloat(String(v == null ? '' : v).trim()); return n > 0 ? n : 0; };
  // (dev0763) Unlike a single, a grid card is also the way IN to the collection,
  // so a fully-cut ctxt does not delist it — `active` stays the curation gate.
  // Its title falls back to the gname.
  // (dev0940) ONE card-builder, TWO lists. A collection row and a flashcard deck
  // differ only by ctype, so they are mapped identically and split at the end —
  // the Flashcards tab is a filter over these rows, not a second implementation.
  //
  // The name exclusions that used to sit in this filter (Greeting, Introduction,
  // "other") are gone: all of those rows carry ctype "t" now, so the ctype gate
  // alone catches them. Two gates that could disagree was trap T1, and this was
  // the half that had to go.
  const _cCard = g => { const h = _cutBelow(g.ctxt); return { kind: 'ss', gname: String(g.gname).trim(), html: h,
                 summary: _smSummaryText(h) || String(g.gname).trim(),
                 date: _smDateShort(g.DateModified), dmRaw: String(g.DateModified || ''),
                 ord: _smOrd(g.active),
                 cells: Number(g.cells) || 0 }; };
  // `active` is the curation gate for a collection exactly as it is the order
  // for a tab — a grid with no number stays unlisted (dev0596/dev0700). A fully
  // cut ctxt does NOT delist a grid: unlike a single, the card is also the way
  // in to the collection.
  const _cListed = g => g && !g._salMeta && String(g.ctxt || '').trim() && g.gname
                     && _smOrd(g.active) > 0;
  const _cType = g => String(g.ctype || '').trim().toLowerCase();
  // t = a menu tab, o = the author's own parked material, f = a flashcard deck
  // (which has a tab of its own now). None of the three belongs in Grids.
  const gItems = cRows.filter(g => _cListed(g) && !/^[tof]$/.test(_cType(g))).map(_cCard);
  const fItems = cRows.filter(g => _cListed(g) && _cType(g) === 'f').map(_cCard);
  // The Grids tab's list, the Flashcards tab's list, and the index space the two
  // share — a card's Open button carries its position in `items` (_smDetCard's
  // data-i), so the arrays must be concatenated in this order and not re-sorted.
  const gridItems = vItems.concat(gItems);
  const flashItems = fItems;
  const items = gridItems.concat(flashItems);

  // (dev0596) Navigation-Training choices removed with the tab (was sourced from
  // each config row's `ss` field).

  const ov = document.createElement('div');
  ov.id = 'shareableMenu';
  // (dev0767) Redesign. The landing page was near-black navy in a monospace
  // face — a developer console that happened to be the public front door. It is
  // now the Shutter-Encoder shape the author asked for: a charcoal tab bar over
  // a medium-blue body, in a system sans stack.
  //
  // The blue is a gradient rather than a flat fill because SE's hero has that
  // same top-lit depth. It lives on the OVERLAY, not on the pages: every .sm-pg
  // is absolutely positioned and transparent, so the gradient stays put while a
  // page scrolls over it (background-attachment can't do that here — the
  // scroller is the page, not this element).
  ov.style.cssText = 'position:fixed;inset:0;z-index:999990;'
    + 'background:linear-gradient(180deg,#17629d 0%,#13527f 55%,#0f4570 100%);'
    + 'display:flex;flex-direction:column;color:#eef4fa;'
    + "font-family:'Segoe UI',system-ui,-apple-system,'Helvetica Neue',Arial,sans-serif;";

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
  // (dev0379) Cards are rendered (and sorted) into the list body after mount by
  // _smMakeList, so no pre-joined column HTML is needed here.
  const _smNoItems = '<div style="padding:24px;color:#aa8;">No shareable items yet.</div>';

  // (dev0359/0361) Readable sans-serif greeting prose (now a CLASS so both
  // pages can use it), page-2 cards, and the bottom tab bar. `summary` headings
  // render inline so an Xe-resized collapsible title sits on the marker line.
  const menuStyle =
    '<style>'
    // (dev0767) PALETTE — Shutter-Encoder's, as the author asked for:
    //   charcoal  #26292e / #32363c   tab bars
    //   blue      #17629d → #0f4570   page body (the gradient on `ov` above)
    //   text      #eef4fa / #cfe0f0   near-white / muted
    //   accent    #7cc0ff #bfe3ff     rules, focus rings, links
    //   green     #4caf50             the primary action (▶ Open)
    //   red       #e8413f             the destructive one (Delete)
    // Everything below that used to be a near-black panel colour (#11131f,
    // #15152a, #0d0d1e) is now a translucent black or white over the blue —
    // one gradient shows through the whole menu instead of a dozen flat navies
    // that have to be kept in step by hand.
    //
    // Links are #bfe3ff, not the #4aa8ff of the swatch: over #15588f that blue
    // sits at roughly 2.5:1 against its own background and reads as grey-blue.
    // #4aa8ff survives as the active-tab indicator, where it is a bright line on
    // charcoal rather than text on blue.
    //
    // (dev0734) 760px is no longer a literal here — it's --sal-prose-w, declared
    // once in index.html and shared with the Xs slide overlay. The left/right
    // gap on the landing page is NOT a margin anyone set: it's this max-width
    // being centred by `margin:0 auto`, so the leftover splits evenly.
    // (dev0767) font-family:inherit, not sans-serif — the overlay now sets a
    // real UI stack and this rule was overriding it with the browser default.
    + '.smGreeting{font-family:inherit;color:#eef4fa;line-height:1.65;font-size:16px;padding:24px 24px 18px;max-width:var(--sal-prose-w,760px);margin:0 auto;}'
    + '.smGreeting h1,.smGreeting h2{color:#fff;margin:0 0 12px;font-weight:600;letter-spacing:-.01em;}'
    + '.smGreeting h2{font-size:24px;}.smGreeting h1{font-size:30px;}'
    + '.smGreeting h3{color:#d9ebff;font-size:19px;margin:10px 0 6px;font-weight:600;}'
    + '.smGreeting h4{color:#cfe0f0;font-size:16px;margin:6px 0;font-weight:500;}'
    + '.smGreeting p{margin:8px 0;}'
    + '.smGreeting a{color:#bfe3ff;text-decoration:underline;text-underline-offset:2px;}'
    + '.smGreeting a:hover{color:#fff;}'
    // (dev0733) clear:both;overflow:hidden — the SAME float containment every
    // other render context has had since zip0138 (#teSlideContent details in
    // index.html) and that Xe itself got in dev0732. Without it a collapsible
    // full of floated media didn't contain them here: the tinted block collapsed
    // to the height of its title and the pictures hung out below it, so the
    // landing page never matched what the editor showed.
    + '.smGreeting details{margin:10px 0;padding:10px 14px;background:rgba(0,0,0,0.22);border-left:4px solid #7cc0ff;border-radius:6px;clear:both;overflow:hidden;}'
    + '.smGreeting summary{cursor:pointer;color:#d9ebff;}'
    // (dev0733) A float wider than this 760px column can only wrap. Percentage
    // widths (the 🖼 "% of line" size) are the fix; this is the safety net for
    // media still carrying an authored pixel width — it shrinks to the column
    // instead of shoving its neighbours onto the next line.
    + '.smGreeting div[style*="float"]{max-width:100%;box-sizing:border-box;}'
    + '.smGreeting img,.smGreeting video{max-width:100%;}'
    // (dev0788) The Welcome page's forward arrow. TRANSPARENT, as asked: no
    // circle, no fill, no border — just the glyph, so it lies over the picture
    // instead of punching a hole in it. It carries a drop shadow rather than a
    // background because the thing behind it is whatever photo the day supplies,
    // and a shadow is what keeps a white glyph legible over a bright one (the
    // lesson backarrow.js learned at dev0765). Brightens on hover/focus.
    // A wide hit area around a 40px glyph, for a thumb.
    + '.sm-fwd{position:absolute;right:4px;top:50%;transform:translateY(-50%);z-index:6;'
      + 'display:none;align-items:center;justify-content:center;width:56px;height:76px;padding:0;'
      + 'background:transparent;border:none;color:rgba(255,255,255,0.55);'
      + 'font-family:inherit;font-size:40px;line-height:1;cursor:pointer;'
      + 'text-shadow:0 1px 5px rgba(0,0,0,0.75);touch-action:manipulation;'
      + 'user-select:none;-webkit-user-select:none;transition:color .12s;}'
    + '.sm-fwd:hover,.sm-fwd:focus{color:rgba(255,255,255,0.95);outline:none;}'
    + '@media(max-width:900px){.sm-fwd{font-size:34px;width:46px;}}'
    // (dev0787) Section 1 of the Introduction ctxt is the Welcome page's first
    // LINE, with the day's picture immediately under it — so it gives back the
    // deep top/bottom padding the prose pages want. Section 2, below the
    // caption, keeps the normal spacing.
    + '.sm-introtop{padding:14px 24px 4px;}'
    // (dev0779/0787) THE IMAGE OF THE DAY — the Welcome page's centrepiece now,
    // not a note between two blocks of prose. It sits OUTSIDE the 760px prose
    // column: a picture asked to "fit the screen" cannot be capped at the width
    // of a paragraph. The date line is above it, the caption — still at prose
    // width, so it stays readable — below.
    + '.sm-dayitem{max-width:none;margin:2px auto 10px;padding:0 18px;text-align:center;}'
    // The date, between its two arrows. "Not too large" — a notch under the
    // prose, so it labels the picture instead of competing with the line above.
    + '.sm-daynav{display:flex;align-items:center;justify-content:center;gap:14px;margin:2px 0 8px;}'
    + '.sm-daydate{font-family:inherit;font-size:15px;letter-spacing:.02em;color:#dce9f7;white-space:nowrap;}'
    + '.sm-dayarrow{font-family:inherit;font-size:18px;line-height:1;width:34px;height:30px;padding:0;cursor:pointer;'
      + 'color:#eef4fa;background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.22);border-radius:6px;}'
    + '.sm-dayarrow:hover:not(:disabled){background:rgba(255,255,255,0.20);}'
    + '.sm-dayarrow:disabled{opacity:.35;cursor:default;}'
    // The media FITS the page rather than filling its width: the height is
    // capped so the whole picture is on screen with its date and its caption.
    // The real cap is a px value set from the page box after mount (_smDayFit) —
    // vh is wrong inside the rotated wrap on a portrait phone — and this vh is
    // only the fallback until that first measurement lands.
    + '.sm-daymedia{line-height:0;}'
    + '.sm-daymedia img,.sm-daymedia video{display:inline-block;width:auto;height:auto;'
      + 'max-width:100%;max-height:62vh;border-radius:6px;}'
    // The caption is the row's ftext, so it gets the prose colours at a quieter
    // size — same relationship a modal caption has to its picture.
    + '.sm-dayitem .sm-daycap{font-family:inherit;color:#cfe0f0;font-size:0.85em;line-height:1.5;text-align:center;'
      + 'max-width:var(--sal-prose-w,760px);margin:8px auto 0;}'
    + '.sm-dayitem .sm-daycap p{margin:4px 0;}'
    // Media INSIDE the caption (an ftext can carry its own) is prose-column
    // furniture, not the picture of the day — hold it to the column width.
    + '.sm-dayitem .sm-daycap img,.sm-dayitem .sm-daycap video{max-width:100%;height:auto;}'
    + '.sm-dayitem .sm-daycap details{margin:8px 0;padding:8px 12px;background:rgba(0,0,0,0.22);'
      + 'border-left:4px solid #7cc0ff;border-radius:6px;text-align:left;overflow:hidden;}'
    + '.sm-dayitem .sm-daycap summary{cursor:pointer;color:#d9ebff;}'
    + '.sm-dayitem .sm-daycap a{color:#bfe3ff;text-decoration:underline;text-underline-offset:2px;}'
    + '.sm-dayitem .sm-daycap a:hover{color:#fff;}'
    + '.smGreeting summary h1,.smGreeting summary h2,.smGreeting summary h3,.smGreeting summary h4,.smGreeting summary h5,.smGreeting summary h6{display:inline;color:#d9ebff;margin:0;}'
    + '.smGreeting hr{border:none;border-top:1px solid rgba(255,255,255,0.28);margin:20px 0;}'
    + '.te-cut{display:none;}'
    + '.sm-card{display:flex;align-items:center;gap:12px;padding:15px 22px;border-bottom:1px solid rgba(255,255,255,0.12);cursor:pointer;color:#eef4fa;}'
    + '.sm-card:hover{background:rgba(255,255,255,0.07);}'
    // (dev0378) <details> choice cards: clickable summary row + Open button.
    + '.sm-detcard{border-bottom:1px solid rgba(255,255,255,0.12);}'
    + '.sm-detsum{display:grid;grid-template-columns:30px minmax(0,1fr) 120px 92px 84px;align-items:stretch;gap:12px;padding:15px 22px;cursor:pointer;color:#eef4fa;list-style:none;}'
    + '.sm-detsum::-webkit-details-marker{display:none;}'
    + '.sm-detsum::marker{content:"";}'
    + '.sm-detsum:hover{background:rgba(255,255,255,0.07);}'
    + '.sm-detcard[open]>.sm-detsum{background:rgba(0,0,0,0.20);}'
    + '.sm-date{display:flex;align-items:center;font-size:12px;color:#cfe0f0;white-space:nowrap;border-left:1px solid rgba(255,255,255,0.16);padding-left:12px;}'
    // (dev0767) ▶ Open is SE's green — the one primary action on a card, and the
    // thing a first-time viewer is looking for. Delete (below) takes SE's red.
    + '.sm-open{align-self:center;justify-self:start;flex:none;font-size:12px;font-weight:600;color:#fff;background:#3f9e46;border:1px solid #4caf50;border-radius:6px;padding:6px 13px;cursor:pointer;white-space:nowrap;}'
    + '.sm-open:hover{background:#57b85e;}'
    + '.sm-detbody{padding:2px 22px 16px;}'
    // (dev0379) Sortable, table-like header for the choice list.
    + '.sm-chhead{display:grid;grid-template-columns:30px minmax(0,1fr) 120px 92px 84px;align-items:stretch;gap:12px;padding:10px 22px;background:rgba(0,0,0,0.30);border-bottom:2px solid rgba(255,255,255,0.20);position:sticky;top:0;z-index:2;}'
    + '.sm-chh-spacer{}'
    + '.sm-chh{display:flex;align-items:center;font-size:12px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#cfe0f0;background:none;border:none;cursor:pointer;padding:0;}'
    + '.sm-chh:hover{color:#fff;}'
    + '.sm-chh.on{color:#fff;}'
    + '.sm-chh-name{justify-content:flex-start;text-align:left;border-left:1px solid rgba(255,255,255,0.16);padding-left:12px;}'
    + '.sm-chh-date{justify-content:flex-start;text-align:left;border-left:1px solid rgba(255,255,255,0.16);padding-left:12px;}'
    + '.sm-chmax{max-width:var(--sal-prose-w,760px);margin:0 auto;}'
    // (dev0381) Choices toolbar: filter box + expand/collapse-all buttons.
    + '.sm-chtools{display:flex;gap:8px;align-items:center;padding:10px 22px 8px;}'
    + '.sm-chfwrap{flex:1;min-width:0;display:flex;gap:6px;}'
    + '.sm-chfilter{flex:4;min-width:0;padding:9px 12px;border-radius:7px;border:1px solid rgba(255,255,255,0.28);background:rgba(0,0,0,0.25);color:#fff;font-family:inherit;font-size:14px;outline:none;}'
    + '.sm-chfilter::placeholder{color:#a9c3da;}'
    + '.sm-chfilter:focus{border-color:#7cc0ff;box-shadow:0 0 0 2px rgba(124,192,255,0.25);}'
    + '.sm-chclear{flex:1;min-width:0;padding:9px 6px;border-radius:7px;border:1px solid rgba(255,255,255,0.28);background:rgba(255,255,255,0.10);color:#eef4fa;font-family:inherit;font-size:12px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
    + '.sm-chclear:hover,.sm-chclear:focus{background:rgba(255,255,255,0.20);border-color:#7cc0ff;outline:none;}'
    + '.sm-chbtn{flex:none;padding:9px 13px;border-radius:7px;border:1px solid rgba(255,255,255,0.28);background:rgba(255,255,255,0.10);color:#eef4fa;font-family:inherit;font-size:12px;cursor:pointer;white-space:nowrap;}'
    + '.sm-chbtn:hover{background:rgba(255,255,255,0.20);}'
    + '.sm-chnone{padding:22px;color:#d9e6f2;}'
    + '.sm-ico{font-size:13px;line-height:1;flex:none;width:30px;text-align:center;color:#bfe3ff;}'
    + '.sm-name{flex:1;font-size:17px;}'
    // (dev0401) Search result rows: name on top, a muted meta line beneath it
    // carrying the dictionary tags + the row's comment.
    + '.sm-rcol{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;}'
    + '.sm-rname{font-size:17px;color:#eef4fa;}'
    // (dev0854) Clamped to 3 lines. VidComment is unbounded — one row carried an
    // 1188-char comment that filled the whole results list with a single card.
    + '.sm-rmeta{font-size:12px;color:#cfe0f0;line-height:1.35;'
      + 'display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;line-clamp:3;overflow:hidden;}'
    // (dev0401) SavedSearches row buttons (Open / Delete) on the right of a card.
    + '.sm-svbtns{flex:none;display:flex;gap:8px;align-items:center;}'
    + '.sm-svbtn{padding:8px 14px;border-radius:7px;border:1px solid rgba(255,255,255,0.28);background:rgba(255,255,255,0.10);color:#eef4fa;font-family:inherit;font-size:13px;cursor:pointer;white-space:nowrap;}'
    + '.sm-svbtn:hover{background:rgba(255,255,255,0.20);}'
    + '.sm-svbtn.del{color:#ffd7d4;border-color:#e8413f;background:rgba(232,65,63,0.22);}'
    + '.sm-svbtn.del:hover{background:#e8413f;color:#fff;}'
    // (dev0380) Choose-list cells: full-height cells with fine vertical column
    // rules, content vertically centered + left-justified within each column.
    + '.sm-detsum .sm-ico{display:flex;align-items:center;justify-content:center;width:auto;}'
    + '.sm-detsum .sm-name{display:flex;align-items:center;min-width:0;border-left:1px solid rgba(255,255,255,0.16);padding-left:12px;}'
    + '.sm-tag{align-self:center;justify-self:start;flex:none;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#fff;border:1px solid rgba(255,255,255,0.40);border-radius:10px;padding:2px 9px;white-space:nowrap;}'
    + '.sm-sub{padding:10px 24px 6px;color:#d9ebff;font-size:11px;letter-spacing:.12em;text-transform:uppercase;background:rgba(0,0,0,0.25);}'
    + '.sm-grpdiv{height:1px;background:rgba(255,255,255,0.14);margin:6px 0;}'
    + '.sm-colhdr{padding:12px 22px 4px;color:#cfe0f0;font-size:12px;letter-spacing:.14em;text-transform:uppercase;}'
    + '.sm-cols{display:flex;gap:28px;align-items:flex-start;justify-content:center;padding:8px 0 30px;}'
    + '.sm-col{flex:1 1 0;min-width:0;max-width:520px;}'
    + '@media(min-width:760px){.sm-cols{padding:8px 120px 30px;}}'
    + '@media(max-width:759px){.sm-cols{flex-direction:column;gap:4px;padding:0 0 24px;}.sm-col{max-width:none;}}'
    + '.sm-search{display:block;width:calc(100% - 48px);max-width:620px;margin:20px auto 10px;padding:13px 16px;border-radius:9px;border:1px solid #7cc0ff;background:rgba(0,0,0,0.25);color:#fff;font-family:inherit;font-size:17px;outline:none;}'
    + '.sm-sugg{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;max-width:620px;margin:0 auto 6px;padding:0 24px;}'
    + '.sm-chip{padding:6px 13px;border-radius:14px;border:1px solid rgba(255,255,255,0.28);background:rgba(255,255,255,0.10);color:#eef4fa;font-family:inherit;font-size:13px;cursor:pointer;}'
    + '.sm-chip:hover{background:rgba(255,255,255,0.20);}'
    + '.sm-count{text-align:center;color:#cfe0f0;font-size:13px;margin:8px 0 4px;}'
    + '.sm-results{max-width:620px;margin:0 auto;}'
    // (dev0767) .sm-cta / .sm-cta-sub are GONE with the two "Go to home screen"
    // buttons they styled. Intro is a tab now: the tab bar is on the page, so a
    // button whose whole job was to escape a tab-less splash has nothing to do,
    // and its sub-line ("But check out Introduction first") was telling the
    // reader to go and find the page they were already standing on.
    //
    // (dev0763) Build stamp in the Intro's top-left corner. pointer-events:none
    // so it can never sit between a thumb and the sign-in strip beneath it.
    + '.sm-ver{position:absolute;top:3px;left:7px;z-index:2;font:10px/1 monospace;color:rgba(255,255,255,0.45);pointer-events:none;}'
    // (dev0930) LANGUAGE TOGGLE — the mirror of the build stamp, top-RIGHT of
    // the Welcome page. It belongs here rather than in the tab bar or a settings
    // panel because a viewer who needs Spanish needs it on arrival, before they
    // have learned anything about the site's furniture; the first screen is the
    // only place that is guaranteed to be seen. Quiet, like the version stamp,
    // but a real button — it has a job to do, so it takes a hit area and a hover.
    // It names the language it SWITCHES TO ("Español" while you are reading
    // English), which is the convention every multilingual site uses and the one
    // that stays legible to someone who cannot read the current language.
    + '.sm-lang{position:absolute;top:5px;right:9px;z-index:6;padding:4px 11px;'
      + 'font-family:inherit;font-size:12px;line-height:1.4;cursor:pointer;'
      + 'color:#cfe0f0;background:rgba(0,0,0,0.28);border:1px solid rgba(255,255,255,0.22);'
      + 'border-radius:999px;white-space:nowrap;touch-action:manipulation;'
      + 'transition:background .12s,color .12s,border-color .12s;}'
    + '.sm-lang:hover,.sm-lang:focus{color:#fff;background:rgba(74,168,255,0.30);border-color:#7cc0ff;outline:none;}'
    // Spanish runs 15-25% longer than English and the tab bar is the tightest
    // row on the site — eight tabs sharing one flex line. Half a point smaller
    // buys back roughly that much without touching the English layout at all.
    + 'html.lang-es .sm-tab{font-size:13px;letter-spacing:0;}'
    + '@media(max-width:900px){html.lang-es .sm-tab{font-size:11px;}}'
    // (dev0767) Charcoal bars, SE-style: a flat dark strip that reads as chrome
    // rather than as more page. The active tab lifts to #32363c and takes a
    // bright #4aa8ff edge — top bar on its bottom edge, bottom bar on its top,
    // so in both cases the indicator sits against the content.
    + '.sm-tabs{display:flex;flex:none;background:#26292e;box-shadow:0 -1px 0 rgba(0,0,0,0.5);}'
    // min-width:0 + ellipsis: seven tabs now share the bar instead of six, and
    // "SavedSearches" is the widest label. Without this a flex item refuses to
    // shrink below its text and the row overflows the bar on a narrow frame.
    + '.sm-tab{flex:1;min-width:0;padding:14px 6px;text-align:center;cursor:pointer;font-family:inherit;font-size:14px;font-weight:500;letter-spacing:.01em;color:#c6ccd4;background:transparent;border:none;border-top:3px solid transparent;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background .12s,color .12s;}'
    + '@media(max-width:900px){.sm-tab{font-size:12px;padding:12px 3px;}}'
    + '.sm-tab:hover{color:#fff;background:#2f333a;}'
    + '.sm-tab.on{color:#fff;font-weight:600;border-top-color:#4aa8ff;background:#32363c;}'
    + '.sm-tab:focus{outline:none;color:#fff;background:#3a3f47;}'
    // (dev0384) The tab bar now also rides at the TOP of every menu page (the
    // old "SeaLifeAndMore" header is gone). Flip the accent rule to the bottom
    // edge so the active indicator sits against the page on the top bar.
    // (dev0767) …which it never actually did: dev0384 flipped the CONTAINER's
    // border but left `.sm-tab.on` painting its indicator on the top edge, hard
    // against the window edge. The two rules below are that flip, on the tab.
    + '.sm-tabs-top{box-shadow:0 1px 0 rgba(0,0,0,0.5);}'
    + '.sm-tabs-top .sm-tab{border-top:none;border-bottom:3px solid transparent;}'
    + '.sm-tabs-top .sm-tab.on{border-bottom-color:#4aa8ff;}'
    // (dev0739) Phones get the BOTTOM bar only. Two identical tab rows cost
    // ~90px of a 375px-tall rotated frame to say the same thing twice, and the
    // bottom one is the reachable one. Desktop keeps both — there the height is
    // free and the top bar is what Tab-key focus anchors to. !important because
    // _smShow writes display inline on every .sm-tabs.
    + 'html.is-mobile .sm-tabs-top{display:none !important;}'
    // (dev0551) Sign-in strip on Page 1. Low-key by design — a quiet link when
    // signed out, a status line when signed in. Never blocks browsing.
    // (dev0767) Now a slim right-aligned row tucked under the top tab bar, where
    // a site's account link lives, instead of a centred band above the prose.
    // It keeps the same #smAuth element and the same three states, so
    // _wireSignIn is untouched.
    + '.sm-auth{max-width:var(--sal-prose-w,760px);margin:10px auto 0;padding:0 24px;color:#cfe0f0;font-size:13px;text-align:right;}'
    + '.sm-auth a.sm-link{color:#bfe3ff;cursor:pointer;text-decoration:underline;}'
    + '.sm-auth a.sm-link:hover{color:#fff;}'
    + '.sm-authrow{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:8px;}'
    + '.sm-authrow input{flex:1;min-width:0;max-width:320px;padding:10px 13px;border-radius:8px;border:1px solid rgba(255,255,255,0.28);background:rgba(0,0,0,0.25);color:#fff;font-family:inherit;font-size:15px;outline:none;}'
    + '.sm-authrow input:focus{border-color:#7cc0ff;}'
    + '.sm-authrow button{flex:none;padding:10px 16px;border-radius:8px;border:1px solid rgba(255,255,255,0.28);background:rgba(255,255,255,0.10);color:#eef4fa;font-family:inherit;font-size:14px;cursor:pointer;white-space:nowrap;}'
    + '.sm-authrow button:hover{background:rgba(255,255,255,0.20);}'
    + '.sm-authrow button:disabled{opacity:.5;cursor:default;}'
    // (dev0782) On its own Contact page the strip is the page's content, not a
    // corner note — so it reads left-to-right like everything else in the prose
    // column instead of hugging the right edge the way it did on the Intro.
    + '.sm-contact .sm-auth{text-align:left;font-size:15px;margin-top:18px;}'
    + '.sm-contact .sm-authrow{justify-content:flex-start;}'
    // (dev0955) The signed-in message composer. Full prose width on Contact,
    // where the strip IS the page; still usable in the narrow right-aligned
    // strip on the Intro because the row rules above already wrap.
    + '.sm-composelabel{margin-top:16px;color:#cfe0f0;text-align:left;}'
    + '.sm-composebox{display:block;width:100%;box-sizing:border-box;margin-top:8px;padding:10px 13px;border-radius:8px;border:1px solid rgba(255,255,255,0.28);background:rgba(0,0,0,0.25);color:#fff;font-family:inherit;font-size:15px;line-height:1.5;outline:none;resize:vertical;}'
    + '.sm-composebox:focus{border-color:#7cc0ff;}'
    + '.sm-authmsg{margin-top:10px;color:#b6f0cd;line-height:1.5;}'
    + '.sm-authmsg.err{color:#ffc9c5;}'
    + '.sm-authmsg a{color:#bfe3ff;}'
    + '</style>';

  // (dev0384) One set of tab buttons, rendered both above and below the pages.
  // _smShow syncs the `.on` class across every `.sm-tab`, so the two bars stay
  // in lockstep automatically.
  // (dev0668) The Search pair and "Add your own" are each gated by their switch
  // at the top of this file — an off feature contributes no tab button at all.
  // (dev0767) INTRO is now the FIRST TAB, not a splash the viewer had to escape
  // from. It is where the site opens, and it stays one click away from every
  // other tab instead of being reachable only via the back arrow.
  // (dev0787) …and it is called WELCOME, not Intro. The page is a greeting line
  // and the day's picture now; "Intro" named a wall of introductory prose that
  // moved off it. Page 5, the number the removed "Navigation Training" tab used
  // to hold, is reused for "Starting out" — the empty tab that follows it.
  // (dev0930) T() wraps the label text only — never the data-pg value, which is
  // the page's identity and is matched on elsewhere. Translating an attribute
  // that doubles as a key is the classic i18n regression; keep it in mind for
  // every future tab added here.
  const _T = window.T || (s => s);
  // (dev0934) THE LABEL COMES FROM c.json, THE BAR STILL COMES FROM HERE.
  // dev0931 gave every tab a config row carrying ctype "t" and a `Label`; this
  // reads that Label as the tab's English text, falling back to the literal
  // below when the row is missing. What is deliberately NOT taken from c.json
  // is the bar itself — which tabs exist, their order, their data-pg, and the
  // SM_FEAT_* gating — because those are code, and a mis-typed row must not be
  // able to take a page off the site.
  //
  // The Label is matched by gname, not by `active` (which is the tab's POSITION
  // in the bar, and is a different number from its data-pg for six of the nine).
  //
  // Renaming a tab in c.json therefore renames it on the site — and the Spanish
  // follows the rename by itself, because T() keys on the ENGLISH STRING: the
  // new Label is looked up in lang.es.json, and until an entry is written for it
  // the tab degrades to its new English name rather than to the old Spanish one.
  // That is the whole reason the label is translated here rather than carried as
  // a second column on the row: a stale translation cannot outlive its source.
  const _tabRow = gname => cRows.find(r => r && !r._salMeta
    && String(r.ctype || '').trim().toLowerCase() === 't'
    && String(r.gname || '').trim().toLowerCase() === String(gname).toLowerCase());
  const _tabLabel = (gname, fallback) => {
    const row = _tabRow(gname);
    const lab = row ? String(row.Label || '').trim() : '';
    return _smEsc(_T(lab || fallback));
  };
  // ── THE TAB BAR IS DATA ───────────────────────────────────────────────────
  // (dev0940) Which tabs exist, what they are called, what order they sit in,
  // and whether they appear at all now come from c.json: every row with
  // ctype "t" and a positive `active` is a tab, ordered by `active`. Adding,
  // renaming, reordering and retiring a tab are edits in the C screen — no code
  // change and no version bump.
  //
  // Three different facts about a tab used to wear one name, which is exactly
  // what made renaming Introduction dangerous:
  //
  //   IDENTITY — what the code hooks onto → the `Kind` column, never the name
  //   LABEL    — what the viewer reads    → the `Label` column
  //   POSITION — where it sits in the bar → the `active` column
  //
  // `gname` is now only a name. Rename it freely; nothing matches on it. That
  // retires the four magic-gname lookups (Introduction / other / contact /
  // starting out) and SlamTabs.md trap T2 along with them.
  //
  // `Kind` says what a tab's BODY is, and the body is the ONLY thing that
  // differs between tabs. Every tab renders:
  //
  //     section 1  ·  THE BODY  ·  section 2
  //
  // — the author's ctxt either side of its first <hr> (dev0939), with the body
  // composed between the halves. A `prose` tab has no body, so its two sections
  // simply meet. Sections 3+ are dropped. This generalises what dev0779 and
  // dev0931 built as special cases for Introduction and Contact: every
  // behaviour tab now takes optional prose above and below it for free.
  //
  // WHAT REMAINS CODE, deliberately: the behaviours below. Data can place, name,
  // order and hide a tab; it cannot invent one. A new prose tab is free — a new
  // BEHAVIOUR is a new entry in this table.
  const TAB_KINDS = {
    prose:  { def: 'Page' },
    intro:  { def: 'Welcome', topCls: ' sm-introtop' },
    signin: { def: 'Contact', cls: ' sm-contact' },
    grids:  { def: 'Grids' },
    flash:  { def: 'Flashcards' },
    search: { def: 'Search',        off: !SM_FEAT_SEARCH },
    saved:  { def: 'SavedSearches', off: !SM_FEAT_SEARCH },
    loops:  { def: 'Saved Loops' }
  };
  // (dev0941) A TAB'S IDENTITY IS ITS `Kind` CELL, AND NOTHING ELSE. dev0940's
  // _KIND_BY_GNAME shim — which classified a Kind-less row by its name so the
  // site worked before the c.json carrying the column landed — is gone now that
  // every ctype-t row has one. It was the last thing making a gname load-bearing:
  // while it stood, renaming "Grids" to anything off its list would have quietly
  // turned that tab into an empty prose page. Renaming is a Label edit again.
  //
  // An unrecognised or missing Kind falls to `prose`, which is the right failure:
  // a new tab row typed into C shows up as a writable page rather than as nothing.
  const _kindOf = row => {
    const k = String(row.Kind || '').trim().toLowerCase();
    return TAB_KINDS[k] ? k : 'prose';
  };
  // One tab per behaviour: a second `grids` row — or the retired "Add your own"
  // sitting beside "Saved Loops" in a c.json that predates the merge — is
  // skipped rather than rendered twice. `prose` is the exception, being the kind
  // you are meant to have many of.
  const _smTabs = [];
  {
    const seen = {};
    cRows.filter(r => r && !r._salMeta
          && String(r.ctype || '').trim().toLowerCase() === 't'
          && _smOrd(r.active) > 0)
      .sort((a, b) => _smOrd(a.active) - _smOrd(b.active))
      .forEach(row => {
        const kind = _kindOf(row);
        const spec = TAB_KINDS[kind];
        if (!spec || spec.off) return;            // feature switch off → no tab
        if (kind !== 'prose') { if (seen[kind]) return; seen[kind] = 1; }
        const sec = _twoSections(_cutBelow(_ctxtOf(row)));
        _smTabs.push({
          kind: kind, spec: spec,
          label: _smEsc(_T(String(row.Label || '').trim()
                        || String(row.gname || '').trim() || spec.def)),
          top:    _linkify(_balanceHtml(sec.top)),
          bottom: _linkify(_balanceHtml(sec.bottom))
        });
      });
    // THE FLOOR. A data-driven bar can be emptied by one bad cell, so it is not
    // the only thing standing between the site and a blank front door: with no
    // usable rows at all we fall back to the built-in bar, and a bar that has
    // somehow lost its Introduction gets one prepended. Everything milder — a
    // missing Grids tab, a mistyped label — is the author's to see and fix.
    if (!_smTabs.length) {
      ['intro', 'grids', 'flash', 'search', 'saved', 'loops', 'signin'].forEach(kind => {
        const spec = TAB_KINDS[kind];
        if (spec && !spec.off) _smTabs.push({ kind: kind, spec: spec, label: _smEsc(_T(spec.def)), top: '', bottom: '' });
      });
    } else if (!_smTabs.some(t => t.kind === 'intro')) {
      _smTabs.unshift({ kind: 'intro', spec: TAB_KINDS.intro, label: _smEsc(_T(TAB_KINDS.intro.def)), top: '', bottom: '' });
    }
  }
  // data-pg is a POSITION now, assigned here, and it lives only in memory —
  // nothing persists a page number across sessions (see _smStartPg). That
  // retires trap T4's recycled slot 5: the numbers mean what they look like.
  _smTabs.forEach((t, i) => { t.pg = i + 1; });
  const _smPages = _smTabs.map(t => t.pg);
  // Code that needs to reach a particular tab asks for it BY KIND, never by
  // number. That is the whole point of the exercise: renumbering the bar in
  // c.json must not be able to send the keyboard, the swipe or a return-from-V
  // to the wrong page. Returns 0 for a tab that isn't in the bar, which every
  // caller reads as "no such page" because pages are numbered from 1.
  const _pgOf = kind => { const t = _smTabs.filter(x => x.kind === kind)[0]; return t ? t.pg : 0; };
  // Two content fallbacks, both for compatibility rather than for their own
  // sake:
  //  • an Introduction with an empty ctxt still shows the Greeting's pre-<hr>
  //    half, as it has since dev0767;
  //  • a Grids tab with no section 1 still takes the Greeting's post-<hr> half
  //    as its header (SlamTabs.md trap T2b). Write the Grids row's own ctxt and
  //    it takes over — at which point the parked Greeting row finally stops
  //    being load-bearing for a live page.
  _smTabs.forEach(t => {
    if (t.kind === 'intro' && !t.top.trim() && !t.bottom.trim()) t.top = _linkify(_balanceHtml(greetTop));
    if (t.kind === 'grids' && !t.top.trim()) t.top = greetIntro;
  });
  // (dev0930) _T() wraps the label text only — never data-pg, which is a key.
  const _tabBtns = _smTabs.map(t =>
    '<button class="sm-tab" data-pg="' + t.pg + '">' + t.label + '</button>').join('');

  // ── TAB BODIES ────────────────────────────────────────────────────────────
  // One per Kind: the parts data cannot supply. Two of them are a single
  // injected element (the day's picture, the sign-in strip); the rest are lists.
  //
  // Grids and Flashcards are the SAME list, over different rows, so they share
  // one toolbar shape and one renderer keyed by prefix — dev0940's Flashcards
  // tab is a filter, not a second implementation.
  const _listHtml = pfx =>
      '<div class="sm-chmax">'
        + '<div class="sm-chtools">'
          + '<div class="sm-chfwrap">'
            + '<input id="' + pfx + 'Filter" class="sm-chfilter" type="text" placeholder="' + _T('Filter choices…') + '" autocomplete="off">'
            + '<button id="' + pfx + 'Clear" class="sm-chclear" type="button">' + _T('Clear filter') + '</button>'
          + '</div>'
          + '<button id="' + pfx + 'ExpA" class="sm-chbtn">▼ ' + _T('Expand all') + '</button>'
          + '<button id="' + pfx + 'ColA" class="sm-chbtn">▶ ' + _T('Collapse all') + '</button>'
        + '</div>'
        + '<div class="sm-chhead" id="' + pfx + 'Head">'
          + '<span class="sm-chh-spacer"></span>'
          // data-sort is a key, not text — see the note on data-pg above.
          + '<button class="sm-chh sm-chh-name" data-sort="name">' + _T('Name') + '<span class="sm-arrow"></span></button>'
          + '<button class="sm-chh sm-chh-date" data-sort="date">' + _T('Modified') + '<span class="sm-arrow"></span></button>'
        + '</div>'
        + '<div id="' + pfx + 'Body"></div>'
      + '</div>';
  const _tabBody = t => {
    switch (t.kind) {
      // Filled by _smDayRender after mount, and re-filled in place by the ‹ ›
      // arrows — the box itself never moves.
      case 'intro':  return '<div class="sm-dayitem" id="smDayItem"></div>';
      // (dev0782) #smAuth just moved house from the Intro: _wireSignIn queries
      // the whole overlay, so it finds it wherever the Contact tab renders it.
      case 'signin': return '<div id="smAuth" class="sm-auth"></div>';
      case 'grids':  return gridItems.length ? _listHtml('smG') : _smNoItems;
      // (dev0940) Flashcard decks (c.json ctype "f") get their own tab and leave
      // the Grids list, which is what "separate them into a separate tab" means.
      case 'flash':  return flashItems.length ? _listHtml('smF')
        : '<div class="sm-chmax"><div class="sm-chnone">No flashcard decks yet.</div></div>';
      // (dev0400) Search uses the same toolbar shape as the Grids filter: text
      // box + Clear to its right, plus Make grid. Enter in the box (or Make
      // grid) turns the current ≤25 results into a grid.
      // (dev0596) Was stubbed to "Pending"; (dev0668) restored, now behind
      // SM_FEAT_SEARCH — though with the switch off this tab no longer exists at
      // all, so the wiring below simply finds nothing.
      case 'search': return '<div class="sm-chmax">'
          + '<div class="sm-chtools">'
            + '<div class="sm-chfwrap">'
              + '<input id="smSearchBox" class="sm-chfilter" type="text" placeholder="Search everything…" autocomplete="off">'
              + '<button id="smSearchClear" class="sm-chclear" type="button">Clear</button>'
            + '</div>'
            + '<button id="smMakeGrid" class="sm-chbtn" type="button">▦ Make + Show grid</button>'
            + '<button id="smSaveSearch" class="sm-chbtn" type="button">★ Save</button>'
          + '</div>'
          // (dev0739/0740) Condensed from three-plus lines to one. The old copy
          // spent a paragraph naming the playable formats — reference material
          // parked permanently above the results, which on a phone pushed them
          // off-screen.
          + '<div id="smSearchHint" class="sm-count" style="margin:2px 0 4px;">Type to search. When ' + _smN + ' or fewer match, press <b>Enter</b> in the box (or click <b>▦ Make + Show grid</b>) to view them all as a grid. <b>★ Save</b> keeps a search on the SavedSearches tab.</div>'
          // (dev0366) Active COI filters, shown so a narrowed result set doesn't
          // look broken. Populated from _filtTaxon / _filtMedia after mount.
          + '<div id="smFilterNote" class="sm-count" style="color:#7fd8a0;margin-top:0;"></div>'
          + '<div id="smSugg" class="sm-sugg"></div>'
          + '<div id="smCount" class="sm-count"></div>'
          + '<div id="smResults" class="sm-results"></div>'
        + '</div>';
      // (dev0401) Searches the viewer kept via the Search tab's ★ Save button,
      // persisted in localStorage. Empty notice until the first save.
      case 'saved':  return '<div class="sm-chmax"><div id="smSavedBody"></div></div>';
      // (dev0940) SAVED LOOPS — the merge of "My Loops" and "Add your own".
      // Both lists did the same job: an A→B stretch of a video the viewer wants
      // to come back to. The only difference was where the video came from, and
      // that is now a tag on the card (FromThisSite / FromPastedURL) rather than
      // a second tab. The paste controls move in here because pasting a URL is
      // no longer an end in itself — it is how you get a video to loop.
      //
      // The manual box below the button is the fallback for every browser that
      // won't hand a page the clipboard (Safari, Firefox, any denied prompt) —
      // it is revealed, not hidden, when the read fails.
      case 'loops':  return '<div class="sm-chmax">'
          + (SM_FEAT_ADDOWN
            ? '<div class="sm-chtools">'
                + '<button id="smPasteUrl" class="sm-chbtn" type="button" style="font-size:14px;padding:10px 16px;">📋 Paste a video URL</button>'
                + '<button id="smTypeUrl" class="sm-chbtn" type="button">⌨ Type / paste it myself</button>'
              + '</div>'
              + '<div id="smAddManual" style="display:none;padding:0 22px 4px;">'
                + '<div class="sm-chfwrap" style="margin:0;">'
                  + '<input id="smAddBox" class="sm-chfilter" type="text" placeholder="Paste a video link here (Ctrl+V), then press Enter" autocomplete="off" spellcheck="false">'
                  + '<button id="smAddGo" class="sm-chclear" type="button">Add</button>'
                + '</div>'
              + '</div>'
              // (dev0940) Video only. Images used to be accepted here as plain
              // bookmarks; this tab is for A→B on a video, and an image has no
              // time dimension to loop — see loops.js WHAT IS ACCEPTED.
              + '<div class="sm-count" style="color:#8a93a8;margin:6px 0 2px;">'
                + 'Works with <b>YouTube</b>, <b>Vimeo</b> or a <b>video file</b> link (.mp4 / .webm / .mov). '
                + 'Instagram and TikTok can\'t be looped — their players don\'t allow it.'
              + '</div>'
              + '<div class="sm-count" style="color:#8a93a8;margin:0 0 6px;">'
                + 'Your loops and links stay in this browser only — they aren\'t uploaded, shared, or added to the collection.'
              + '</div>'
            : '')
          + '<div id="smLoopsBody"></div>'
        + '</div>';
      default:       return '';
    }
  };
  // The Intro carries two pieces of furniture no other tab has: the build stamp
  // (dev0763 — so a phone showing a stale cached app says so without being
  // asked) and the language toggle (dev0930 — rendered only when lang.js is
  // present, so the menu is unchanged if the feature is cut out).
  const _introChrome =
      '<div class="sm-ver">' + _smEsc(window.HELP_VERSION_STR || '') + '</div>'
    + (SM_FEAT_LANG && window.salLang
        ? '<button id="smLangBtn" class="sm-lang" type="button" title="'
          + _smEsc(window.salLang.is('es') ? 'Read this site in English' : 'Leer este sitio en español')
          + '">' + _smEsc(window.salLang.is('es') ? 'English' : 'Español') + '</button>'
        : '');
  // (dev0787) On the Intro, section 1 is the page's FIRST LINE and the day's
  // picture sits right under it, so its prose block loses the deep top padding
  // the other pages inherit (.sm-introtop) and the picture is sized to the
  // screen rather than to the prose column.
  const _pageHtml = t =>
      '<div id="smPage' + t.pg + '" class="sm-pg' + (t.spec.cls || '') + '"'
        + ' style="position:absolute;inset:0;overflow-y:auto;' + (t.pg === 1 ? '' : 'display:none;') + '">'
      + (t.kind === 'intro' ? _introChrome : '')
      + (t.top.trim()
          ? '<div class="smGreeting' + (t.spec.topCls || '') + '">' + t.top + '</div>'
          : (t.kind === 'intro' && !t.bottom.trim()
              ? '<div class="smGreeting sm-introtop"><p>Welcome.</p></div>' : ''))
      + _tabBody(t)
      + (t.bottom.trim() ? '<div class="smGreeting">' + t.bottom + '</div>' : '')
      // A prose tab with nothing in it says so rather than rendering a blank
      // page — the state "this tab exists but hasn't been written yet".
      + (t.kind === 'prose' && !t.top.trim() && !t.bottom.trim()
          ? '<div class="sm-sub">' + _T('Nothing here yet') + '</div>' : '')
    + '</div>';

  ov.innerHTML = menuStyle
    // (dev0384) Top tab bar — replaces the former header (there is no header now).
    + '<div class="sm-tabs sm-tabs-top">' + _tabBtns + '</div>'
    + '<div style="flex:1;position:relative;overflow:hidden;">'
      + _smTabs.map(_pageHtml).join('')
    + '</div>'
    // (dev0384) Bottom tab bar — same buttons as the top one.
    + '<div class="sm-tabs sm-tabs-bottom">' + _tabBtns + '</div>'
    // (dev0788) The Welcome page's FORWARD arrow. A see-through glyph on the
    // right edge, vertically centred — the mirror of backarrow.js's ← , and the
    // same idea: draw the navigation that already exists so a phone viewer can
    // see it. It goes exactly where the next tab button goes.
    //
    // A child of the overlay, not of #smPage1: page 1 is the scroller, so an
    // absolutely positioned child of it would slide away up the page. Here it
    // is pinned to the overlay box, which is inset:0 inside #rotateWrap and so
    // means the VISUAL right edge in both orientations (backarrow.js dev0738).
    // _smShow shows it on page 1 and hides it everywhere else.
    + '<button type="button" id="smFwdArrow" class="sm-fwd" aria-label="Next page">&#8594;</button>';

  // (dev0737) Mount INSIDE #rotateWrap, not on <body>. The menu used to be a
  // body-level sibling of the wrap, so on a portrait phone it painted in the
  // PHYSICAL frame (upright, narrow) while everything it launches — the grid,
  // the viewer, the slideshow — lives inside the wrap and is CSS-rotated 90°.
  // Opening a view therefore flipped the whole UI portrait→landscape, and the
  // flip landed on the same frame as the grid mount + first media load, which
  // is what read as a delay. Inside the wrap the landing page is already in the
  // rotated (landscape) frame on first paint, so nothing switches afterwards.
  // Because the wrap is transformed in portrait it is the containing block for
  // this position:fixed overlay, so inset:0 fills the rotated box — the same
  // mechanism #gridOverlay already relies on. Out-of-flow, so it is not a flex
  // item and does not disturb the wrap's column layout. In landscape the wrap
  // has no transform and inset:0 resolves against the viewport, as before.
  (document.getElementById('rotateWrap') || document.body).appendChild(ov);

  // (dev0741) The Intro/greeting videos. Their markup is authored in Xe and
  // stored in c.json's ctxt, then dropped in here as innerHTML — so they never
  // go through vpMountDirectVideo and never picked up dev0740's lockdown. A
  // long-press on one still offered to save it. Sweep the whole overlay: the
  // greeting appears on page 1 (Welcome), again on page 2, and inside the
  // per-view detail bodies.
  //
  // Unconditional, not user-mode-only. dev0740 spared the DEV SCREENS on the
  // grounds that saving a file off one is something the developer does; the
  // landing page is not one of those — it is the public front door in either
  // mode, and the developer reaches the same file from T or the disk.
  //
  // Removes the offer, not the ability: the URL is in the page and the file is
  // public. This is UI tidying, not protection.
  if (window.salLockDownVideosIn) window.salLockDownVideosIn(ov);

  // (dev0384) `.on` is synced across BOTH bars; the last tab the viewer used is
  // remembered in window._smLastTab so a reopen lands back on it.
  // (dev0940) The Tab-key order IS the bar order, because both are the same
  // c.json rows in the same `active` sequence. It used to be a hand-kept literal
  // that had to be re-edited in step with the bar by eye — SlamTabs.md trap T3,
  // one of the three edits every new tab needed. There is one edit now, and it
  // is a row in c.json.
  const _smTabOrder = _smPages.slice();
  const _smShow = n => {
    // (dev0739) A page change means the box our keyboard was typing into is
    // gone — take it with us rather than leaving it floating over the new page.
    if (window.salKeyboardClose) window.salKeyboardClose();
    window._smCurPage = n; // (dev0367) remembered so a return from V re-opens here, not Welcome
    // (dev0767) …from 1, not 2: Intro is a tab, so "the last tab the viewer
    // used" can now BE Intro and a return should land back on it.
    if (n >= 1) window._smLastTab = n; // (dev0384) remember the last tab used
    _smPages.forEach(k => { const p = ov.querySelector('#smPage' + k); if (p) p.style.display = (k === n) ? '' : 'none'; });
    ov.querySelectorAll('.sm-tab').forEach(t =>
      t.classList.toggle('on', parseInt(t.dataset.pg, 10) === n));
    // (dev0767) The bars used to be hidden on page 1 (it was a tab-less splash).
    // Page 1 is the Intro TAB now, so they stay up on every page.
    ov.querySelectorAll('.sm-tabs').forEach(tb => tb.style.display = 'flex');
    // (dev0788) The forward arrow belongs to Welcome alone. On every other tab
    // the way on is the tab bar and the way back is backarrow.js's ←; a third
    // control there would just be one more thing over the content.
    const _fwdBtn = ov.querySelector('#smFwdArrow');
    if (_fwdBtn) _fwdBtn.style.display = (n === _pgOf('intro')) ? 'flex' : 'none';
    // (dev0741) Re-sweep on every page change — Search results and SavedSearches
    // build their bodies after the overlay was first stamped. Idempotent.
    if (window.salLockDownVideosIn) window.salLockDownVideosIn(ov);
    // (dev0787) Re-fit the day's picture on arrival at Welcome: it measures 0
    // while the page is display:none, so a fit taken on another tab is junk.
    if (n === _pgOf('intro') && window._smDayFitNow) requestAnimationFrame(window._smDayFitNow);
    // (dev0739) Let the floating back arrow re-evaluate now rather than on its
    // next 300ms poll — leaving Welcome should light it immediately.
    if (window._salBackArrowSync) window._salBackArrowSync();
  };
  // (dev0739) The floating back arrow's route home on the menu — it takes the
  // viewer to the Intro (Welcome) page without a reload. Re-exported on every
  // menu build so it always points at the live overlay's pager.
  window._smShowPage = _smShow;
  // (dev0384) Focus the active tab button — used on open and on every Tab-key
  // hop so keyboard cycling stays anchored to the tab row. (dev0739) Falls back
  // to the bottom bar: the top bar is hidden on phones, and focusing a
  // display:none button silently moves focus nowhere.
  const _smFocusTab = n => {
    const b = ov.querySelector('.sm-tabs-top .sm-tab[data-pg="' + n + '"]')
           || ov.querySelector('.sm-tabs-bottom .sm-tab[data-pg="' + n + '"]');
    if (b) b.focus();
  };
  // (dev0403) Focus the first SavedSearches "Open" button — Tab then cycles the
  // Open buttons (see _smRenderSaved). Returns false when there are none yet.
  const _smFocusFirstSaved = () => {
    const b = ov.querySelector('#smSavedBody .sm-svbtn[data-act="open"]');
    if (b) { b.focus(); return true; }
    return false;
  };
  // (dev0667) Same for My Loops. Returns false while the list is empty (or
  // still rendering — the list load is async), so the caller falls back to the
  // tab button and keyboard cycling never dead-ends.
  const _smFocusFirstLoop = () => {
    // :not([disabled]) — a loop whose row has left the collection renders its
    // Open disabled, and focusing that would report success while focus never
    // moved (leaving the viewer with no visible focus at all).
    const b = ov.querySelector('#smLoopsBody .sm-svbtn[data-act="open"]:not([disabled])');
    if (b) { b.focus(); return true; }
    return false;
  };
  // (dev0668) Saved Loops lands on its Paste button when there are no loops to
  // land on. Falls back to the tab button if the feature is switched off.
  // (dev0940) The button moved onto the Saved Loops page with the merge; the
  // query is by id, so it found it there with no change.
  const _smFocusAdd = () => {
    const b = ov.querySelector('#smPasteUrl');
    if (b) { b.focus(); return true; }
    return false;
  };
  // Tab click → show that page. Search focuses its box (mouse users type
  // immediately); SavedSearches focuses its first Open button; every other tab
  // keeps focus on the tab for keyboard cycling.
  ov.querySelectorAll('.sm-tab').forEach(t =>
    t.addEventListener('click', () => {
      const pg = parseInt(t.dataset.pg, 10) || _pgOf('grids') || 1;
      _smShow(pg);
      // (dev0940) BY KIND, not by number — the numbers are positions now and
      // move whenever the author reorders the bar in c.json.
      if (pg === _pgOf('search')) { const sb = ov.querySelector('#smSearchBox'); if (sb) setTimeout(() => sb.focus(), 30); }
      else if (pg === _pgOf('saved')) { setTimeout(() => { if (!_smFocusFirstSaved()) t.focus(); }, 30); }
      else if (pg === _pgOf('loops')) { setTimeout(() => { if (!_smFocusFirstLoop() && !_smFocusAdd()) t.focus(); }, 30); }
      else t.focus();
    }));
  // (dev0788) The Welcome page's → arrow goes wherever the NEXT TAB goes — the
  // order's next entry, not a hard-coded 5, so re-ordering the tab bar re-points
  // the arrow with it. Same landing and same focus as clicking that tab.
  const _smFwd = ov.querySelector('#smFwdArrow');
  if (_smFwd) {
    // Swallow the gesture start so the overlay's swipe catcher never reads a tap
    // on the arrow as a swipe (the guard backarrow.js and PM's arrows both use).
    _smFwd.addEventListener('pointerdown', e => e.stopPropagation());
    _smFwd.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      const idx = _smTabOrder.indexOf(window._smCurPage);
      const next = _smTabOrder[((idx < 0 ? 0 : idx) + 1) % _smTabOrder.length];
      _smShow(next);
      _smFocusTab(next);
    });
  }
  // (dev0384) Keyboard: Tab hops to the next tab (Shift+Tab the previous),
  // wrapping after the last, and opens that page immediately. `f` jumps focus to
  // the live filter on Choices.
  // Skipped while focus is inside a field or the filter toolbar, which own Tab
  // for their own filter↔Clear cycle.
  ov.addEventListener('keydown', e => {
    const ae = document.activeElement;
    const inField = !!(ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable));
    if (!inField && (e.key === 'f' || e.key === 'F')) {
      const fi = _smListFilterFor(window._smCurPage);
      if (fi) { e.preventDefault(); e.stopPropagation(); fi.focus(); return; }
    }
    if (e.key === 'Tab') {
      if (inField) return;
      if (ae && ae.closest && ae.closest('.sm-chtools')) return; // filter/Clear own Tab here
      const idx = _smTabOrder.indexOf(window._smCurPage);
      if (idx < 0) return; // unknown page — leave default tabbing
      e.preventDefault(); e.stopPropagation();
      const next = e.shiftKey
        ? _smTabOrder[(idx - 1 + _smTabOrder.length) % _smTabOrder.length]
        : _smTabOrder[(idx + 1) % _smTabOrder.length];
      _smShow(next);
      if (next === _pgOf('saved') && _smFocusFirstSaved()) return; // (dev0403) land on first Open
      if (next === _pgOf('loops') && (_smFocusFirstLoop() || _smFocusAdd())) return;
      _smFocusTab(next);
    }
  });
  // (dev0767) The #smGoView / #smGoViewTop wiring is gone with the buttons —
  // the Grids tab is the way on from the Intro now.
  // (dev0708) dev0707's fullscreen request is GONE from here again — Esc is this
  // app's navigation key and API fullscreen is defined to exit on it. See the
  // note above _toggleFullscreen; the F11 row in helpfloat.js HP_ADD.G replaces it.

  // (dev0551) Wire the optional sign-in strip (#smAuth). Fails soft: if
  // window.salAuth is missing (auth.js failed to load) or the API is down, the
  // strip stays empty and browsing is entirely unaffected.
  _wireSignIn(ov);

  // (dev0930) Language toggle. Switching reloads the page — see the note at the
  // top of lang.js for why that is the right answer rather than a re-render:
  // the menu, the grid and the viewers each build their text once at mount from
  // dozens of call sites, and re-running all of them in place would buy a whole
  // class of half-translated bugs for no benefit a repaint does not already give.
  const _smLangBtn = ov.querySelector('#smLangBtn');
  if (_smLangBtn && window.salLang) {
    _smLangBtn.addEventListener('click', () => {
      window.salLang.set(window.salLang.is('es') ? 'en' : 'es');
    });
  }
  // ── (dev0787) THE IMAGE OF THE DAY: arrows + fit-to-screen ─────────────────
  // dev0781's fold-open/close wiring is gone with the fold. Two jobs now: the
  // ‹ › arrows step _smDayIdx through the assigned days and re-fill the box in
  // place, and the picture is sized to what is left of the page.
  const _smDayBox = ov.querySelector('#smDayItem');
  // WHY a measurement and not `max-height:62vh`: on a portrait phone this menu
  // lives inside the CSS-rotated #rotateWrap, where 100vh is the PHYSICAL
  // height while the visual frame is 90° to it — so vh would size the picture
  // against the wrong axis. #smPage1's own box is inset:0 in the rotated frame,
  // which makes its clientHeight the honest "height of the screen" in both
  // orientations. The CSS vh stands as the fallback until this first runs.
  const _smDayFit = () => {
    if (!ov.isConnected) { window.removeEventListener('resize', _smDayFit); return; }
    const pg = ov.querySelector('#smPage1');
    if (!pg || !_smDayBox || pg.style.display === 'none') return;
    const med = _smDayBox.querySelector('.sm-daymedia');
    const el = med && med.querySelector('img,video');
    if (!el) return;
    el.style.maxHeight = 'none';                       // measure everything else uncapped
    // Only what shares the FOLD with the picture counts: where the box starts
    // (greeting line above it) plus the box's own non-media height (date line +
    // caption). Section 2 of the ctxt is below all this and must not shrink it.
    const boxTop = _smDayBox.getBoundingClientRect().top - pg.getBoundingClientRect().top + pg.scrollTop;
    const extra  = _smDayBox.offsetHeight - med.offsetHeight;
    el.style.maxHeight = Math.max(200, pg.clientHeight - boxTop - extra - 10) + 'px';
  };
  // _smShow calls this when it lands on page 1 (the box measures 0 while the
  // page is display:none, so the mount-time pass has to be repeatable).
  window._smDayFitNow = _smDayFit;
  const _smDayWireMedia = () => {
    const el = _smDayBox && _smDayBox.querySelector('.sm-daymedia img,.sm-daymedia video');
    if (!el) return;
    // Nothing is measurable until the file has its dimensions.
    el.addEventListener('load', _smDayFit);
    el.addEventListener('loadedmetadata', _smDayFit);
  };
  const _smDayRender = () => {
    if (!_smDayBox) return;
    _smDayBox.innerHTML = _smDayInnerHtml();
    // (dev0741) Same long-press lockdown the rest of the overlay gets — this
    // markup is built after the sweep above ran.
    if (window.salLockDownVideosIn) window.salLockDownVideosIn(_smDayBox);
    _smDayWireMedia();
    requestAnimationFrame(_smDayFit);
  };
  if (_smDayBox) {
    _smDayBox.addEventListener('click', e => {
      const b = e.target && e.target.closest && e.target.closest('.sm-dayarrow');
      if (!b || b.disabled || !_smDayList.length) return;
      e.preventDefault(); e.stopPropagation();
      const dir = parseInt(b.dataset.dir, 10) || 1;
      // Wraps both ways: past the last assigned day is the first one again.
      _smDayIdx = (_smDayIdx + dir + _smDayList.length) % _smDayList.length;
      const which = b.dataset.dir;
      _smDayRender();
      // The button the viewer just pressed was replaced by the re-render — put
      // focus back on its successor so a run of clicks (or Enter) keeps working.
      const nb = _smDayBox.querySelector('.sm-dayarrow[data-dir="' + which + '"]');
      if (nb) nb.focus();
    });
    _smDayRender();
    window.addEventListener('resize', _smDayFit);
  }
  // (dev0369) On the Search page, a right-to-left swipe returns to the Main
  // "Choose a view" page (the main menu) — the same swipe-back feel as the grid.
  // Pointer-based so it works with both touch and a mouse-drag (and is therefore
  // verifiable on desktop, unlike the old touch-only version).
  // (dev0737) The menu now lives INSIDE the rotate-wrap, so pointer coords arrive
  // in the PHYSICAL frame and must be mapped through rotateXY to get the visual
  // frame this direction test is written in. Without the mapping a portrait
  // phone reads a right-to-left swipe as vertical and the swipe-back dies —
  // exactly the failure dev0368 hit on the grid.
  let _smSwX = null, _smSwY = null;
  const _smXY = e => window.rotateXY ? window.rotateXY(e) : { x: e.clientX, y: e.clientY };
  ov.addEventListener('pointerdown', e => {
    const p = _smXY(e); _smSwX = p.x; _smSwY = p.y;
  }, true);
  ov.addEventListener('pointerup', e => {
    const x0 = _smSwX, y0 = _smSwY; _smSwX = _smSwY = null;
    if (x0 == null || window._smCurPage !== 3) return;
    const p = _smXY(e);
    const dx = p.x - x0, dy = p.y - y0;
    if (dx < -60 && Math.abs(dx) > Math.abs(dy)) _smShow(_pgOf('grids') || 1);
  }, true);
  // (dev0935) THE RIGHT SWIPE ON THE PICTURE OF THE DAY IS GONE. dev0932 made a
  // right swipe on the Welcome page's day picture open it in V with the
  // transport collapsed — a hand-built full-window view of one image. The
  // browser already has a full-screen control that does the same thing better,
  // so this was a second, undiscoverable way to do something the viewer can do
  // already, sitting on a gesture that Welcome may want for the tab bar.
  //
  // The vp.js side of it — _vpNoExpand / _vpLoopWhole / _vpBottomCaption — is
  // deliberately LEFT IN PLACE. It is a general "open V as a peek" staging that
  // nothing else sets today but that is not specific to this gesture; ripping it
  // out would be a second, unasked-for change to the viewer.
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
  // (dev0940) The valid range is the pages that ACTUALLY EXIST in this build of
  // the bar, not a literal 1–9. A remembered tab whose row has since been
  // retired (or whose feature switch flipped) is no longer in _smPages, so it
  // falls through to the Introduction instead of leaving every tab looking
  // inactive over blank space.
  if (_smPages.indexOf(window._smReturnPage) >= 0) {
    _smStartPg = window._smReturnPage;
  } else if (window._smWelcomeSeen && _smPages.indexOf(window._smLastTab) >= 0) {
    _smStartPg = window._smLastTab;
  } else {
    _smStartPg = 1;
  }
  if (_smTabOrder.indexOf(_smStartPg) < 0) _smStartPg = 1;
  window._smReturnPage = undefined;
  if (_smStartPg === _pgOf('intro')) window._smWelcomeSeen = true;
  // (dev0403) Capture-then-clear the "returned from a Search-tab grid" flag so
  // the focus callback (which fires after the whole body runs) can still see it.
  const _smRestore = window._smRestoreSearchOnReturn;
  window._smRestoreSearchOnReturn = false;
  _smShow(_smStartPg);
  // (dev0384) Open focused on the tab so Tab-cycling works immediately.
  // (dev0403) Special cases: returning to Search from a grid re-fills the box,
  // re-runs the search, and focuses ★ Save; SavedSearches focuses its first Open.
  // (dev0767) >= 1: opening on the Intro tab now focuses its tab button too, so
  // Tab-cycling works from the very first screen instead of only after the
  // viewer had clicked something.
  if (_smStartPg >= 1) setTimeout(() => {
    if (_smStartPg === 3 && _smRestore && _smBox && window._smLastQuery) {
      _smBox.value = window._smLastQuery;
      _smRunSearch();
      if (_smSaveBtn) { _smSaveBtn.focus(); return; }
    }
    if (_smStartPg === 6 && _smFocusFirstSaved()) return;
    if (_smStartPg === 7 && _smFocusFirstLoop()) return;   // (dev0667)
    if (_smStartPg === 8 && _smFocusAdd()) return;         // (dev0668)
    _smFocusTab(_smStartPg);
  }, 40);

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

  // (dev0668) Open a row that is NOT in ml.json — a link the viewer added on
  // "Add your own". Same staging as _smOpenV (return page, forced grid backdrop,
  // _fromShareableMenu so vpClose comes home), but it hands the synthetic row
  // straight to gridOpenFullscreen: _openItemByUid resolves against `data`, and
  // a ul_… UID is deliberately not in there.
  //
  // `pend` optionally arms a loop, exactly as the My Loops tab does.
  const _smOpenUserRow = (row, pend) => {
    if (!row || !row.link) return;
    window._smReturnPage = window._smCurPage;
    ov.remove();
    window._fromShareableMenu = true;
    const gOvl = document.getElementById('gridOverlay');
    if (gOvl) { gOvl.style.display = 'flex'; window._vpForcedGridFromT = true; }
    if (pend) window._vpPendingLoop = pend;
    if (typeof _lastGridRow !== 'undefined') _lastGridRow = row;
    setTimeout(() => {
      if (typeof gridOpenFullscreen === 'function') gridOpenFullscreen(row);
      // Same safety net as _openItemByUid: a dead link (or a kind V won't
      // mount) must not strand the viewer on a blank forced grid backdrop.
      setTimeout(() => {
        const fsEl = document.getElementById('gridFullscreen');
        if (fsEl && fsEl.style.display === 'flex') return;
        window._fromShareableMenu = false;
        if (window._vpForcedGridFromT) {
          const g = document.getElementById('gridOverlay');
          if (g) g.style.display = 'none';
          window._vpForcedGridFromT = false;
        }
        if (typeof toast === 'function') toast('That link could not be opened', 2400);
        if (typeof window._showShareableMenu === 'function') setTimeout(() => window._showShareableMenu(), 50);
      }, 200);
    }, 60);
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
  // (dev0700) Default order is the curated one: c.json `active` ascending, with
  // un-numbered entries (the ml.json singles) after them. Clicking a header
  // still switches to Name/Modified. sort() is stable, so ties keep c.json order.
  // (dev0940) ONE list implementation, instantiated once per list tab. Grids and
  // Flashcards are the same list over different rows, so the sort state, the
  // live filter, expand/collapse-all and the header arrows are built here by id
  // PREFIX rather than existing twice. Each instance keeps its own sort and
  // filter — narrowing the decks should not disturb where you were among the
  // collections.
  const _smMakeList = (pfx, arr) => {
    const body = ov.querySelector('#' + pfx + 'Body');
    if (!body) return null;                  // that tab isn't in the bar
    const st = { key: 'ord', dir: 1, filt: '' };
    const head = ov.querySelector('#' + pfx + 'Head');
    const render = () => {
      let a2 = arr.slice().sort((x, y) => {
        let av, bv;
        if (st.key === 'ord') { av = x.ord || Infinity; bv = y.ord || Infinity; }
        else if (st.key === 'name') { av = (x.summary || '').toLowerCase(); bv = (y.summary || '').toLowerCase(); }
        else { av = x.dmRaw || ''; bv = y.dmRaw || ''; }
        if (av < bv) return -1 * st.dir;
        if (av > bv) return  1 * st.dir;
        return 0;
      });
      // (dev0381) Live filter — matches the visible summary AND the raw
      // ttxt/ctxt body, so a search hits text hidden inside a collapsed card.
      if (st.filt) a2 = a2.filter(it =>
        ((it.summary || '') + ' ' + (it.html || '')).toLowerCase().includes(st.filt));
      if (!a2.length) { body.innerHTML = '<div class="sm-chnone">No matches.</div>'; return; }
      // data-i is the card's index in the SHARED `items` array — both lists
      // launch through it, which is why they are concatenated and not re-sorted.
      body.innerHTML = a2.map(it => _smDetCard(it, items.indexOf(it))).join('');
      if (head) head.querySelectorAll('.sm-chh').forEach(h => {
        const on = h.dataset.sort === st.key;
        h.classList.toggle('on', on);
        const ar = h.querySelector('.sm-arrow');
        if (ar) ar.textContent = on ? (st.dir < 0 ? ' ▾' : ' ▴') : '';
      });
      body.querySelectorAll('.sm-open').forEach(el => {
        el.addEventListener('click', e => {
          e.preventDefault();
          e.stopPropagation();
          _smLaunch(items[parseInt(el.dataset.i, 10)]);
        });
      });
    };
    if (head) head.querySelectorAll('.sm-chh').forEach(h => {
      h.addEventListener('click', () => {
        const k = h.dataset.sort;
        if (st.key === k) { st.dir *= -1; }
        else { st.key = k; st.dir = (k === 'date') ? -1 : 1; }
        render();
      });
    });
    // (dev0381) Toolbar: live filter + expand/collapse-all. The expand/collapse
    // buttons act on whatever cards are currently rendered, so they respect the
    // active filter.
    const filt = ov.querySelector('#' + pfx + 'Filter');
    const clr  = ov.querySelector('#' + pfx + 'Clear');
    if (filt) filt.addEventListener('input', () => { st.filt = filt.value.trim().toLowerCase(); render(); });
    // (dev0739) Our own keyboard here too — same reason as the Search box. This
    // one filters live, so Go has nothing left to do but put the keyboard away.
    if (filt && window.salKeyboardAttach) {
      window.salKeyboardAttach(filt, { onGo: () => window.salKeyboardClose() });
    }
    // (dev0382) Tab cycles filter ↔ Clear so the button is one Tab away and a
    // second Tab returns to the filter. Clear (click / Enter / Space — native on
    // a <button>) blanks the filter and refocuses the now-empty box.
    if (filt && clr) {
      filt.addEventListener('keydown', e => {
        if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); clr.focus(); }
      });
      clr.addEventListener('keydown', e => {
        if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); filt.focus(); }
      });
      clr.addEventListener('click', () => { filt.value = ''; st.filt = ''; render(); filt.focus(); });
    }
    const setAll = open => body.querySelectorAll('details.sm-detcard').forEach(d => { d.open = open; });
    const expA = ov.querySelector('#' + pfx + 'ExpA');
    if (expA) expA.addEventListener('click', () => setAll(true));
    const colA = ov.querySelector('#' + pfx + 'ColA');
    if (colA) colA.addEventListener('click', () => setAll(false));
    render();
    return { filter: filt, render: render };
  };
  const _smGridList  = _smMakeList('smG', gridItems);
  const _smFlashList = _smMakeList('smF', flashItems);
  // The `f` hotkey wants the filter box of whichever list tab is showing.
  const _smListFilterFor = pg =>
      (pg === _pgOf('grids') ? (_smGridList  && _smGridList.filter)
     : pg === _pgOf('flash') ? (_smFlashList && _smFlashList.filter) : null);

  // (dev0596) Navigation-Training choice table + wiring removed with its tab.

  // (dev0362/0400) Search page — live anywhere-filter over all of T (static
  // blobs + lazily-resolved dictionary-tag text), dictionary suggestions from
  // tagsLib, a match count, and result cards once matches ≤ _smN. Enter in the
  // box (or the ▦ Make grid button) turns the current results into a grid.
  const _smBox = ov.querySelector('#smSearchBox');
  const _smSuggEl = ov.querySelector('#smSugg');
  const _smCountEl = ov.querySelector('#smCount');
  const _smResEl = ov.querySelector('#smResults');
  const _smClearBtn = ov.querySelector('#smSearchClear');
  const _smMakeBtn = ov.querySelector('#smMakeGrid');
  // Rows currently eligible to become a grid (the ≤_smN result set). Empty when
  // nothing is typed or the count is still above the threshold.
  let _smGridable = [];
  const _smRunSearch = () => {
    const q = (_smBox.value || '').trim();
    const lq = window.salFold(q);   // (dev0855) matches the folded blobs
    if (_smSuggEl) {
      const sug = (q && window.tagsLib && window.tagsLib.search) ? window.tagsLib.search(q, 8) : [];
      // (dev0854) data-q is the LABEL, i.e. the text on the chip. It used to be
      // (common || label): clicking a chip reading 'Oxyjulis californica' silently
      // typed 'senorita' and returned 9 rows where the label returns 8 — the extra
      // one a rock wrasse (Halichoeres semicinctus) that merely shares the common
      // name in its title. A tagged row's tagBlob holds label+common+aliases+def,
      // so the label still finds every row carrying the tag, and only that.
      _smSuggEl.innerHTML = sug.map(t => '<span class="sm-chip" data-q="' + _smEsc(t.label) + '">' + _smEsc(t.label) + '</span>').join('');
      _smSuggEl.querySelectorAll('.sm-chip').forEach(c =>
        c.addEventListener('click', () => { _smBox.value = c.dataset.q; _smRunSearch(); }));
    }
    if (!q) { _smCountEl.textContent = ''; _smResEl.innerHTML = ''; _smGridable = []; return; }
    // (dev0366/0400) Apply the COI-declared filters before the threshold/render.
    // The tag text is resolved here (lazily) so dictionary terms match.
    let _hits = _tBlobs.filter(x => {
      if (!x.playable) return false;   // (dev0668) see _smPlayable
      _smResolveTags(x);
      return x.staticBlob.includes(lq) || (x.tagBlob && x.tagBlob.includes(lq));
    });
    if (_filtTaxon) _hits = _hits.filter(x => x.hasTaxon);
    if (_filtMedia) _hits = _hits.filter(x => x.kind === 'video' || x.kind === 'image');
    const matches = _hits.map(x => x.r);
    _smCountEl.textContent = matches.length + ' match' + (matches.length === 1 ? '' : 'es')
      + (matches.length > _smN ? ' — keep typing to narrow to ' + _smN + ' or fewer' : '');
    if (matches.length && matches.length <= _smN) {
      _smGridable = matches;
      _smResEl.innerHTML = matches.map(r => {
        const meta = _smResultMeta(r);
        return '<div class="sm-item sm-card" data-uid="' + _smEsc(String(r.UID)) + '">'
          + '<span class="sm-ico">' + (_smBadge[_smResultBadge(r)] || '🔗') + '</span>'
          + '<span class="sm-rcol">'
            + '<span class="sm-rname">' + _smEsc(_smResultLabel(r)) + '</span>'
            + (meta ? '<span class="sm-rmeta">' + _smEsc(meta) + '</span>' : '')
          + '</span>'
        + '</div>';
      }).join('');
      _smResEl.querySelectorAll('.sm-item').forEach(el =>
        el.addEventListener('click', () => _smOpenV(el.dataset.uid)));
    } else {
      _smGridable = [];
      _smResEl.innerHTML = '';
    }
  };
  // Build a grid from the current result set and leave the menu for it.
  const _smMakeGridNow = () => {
    if (!_smGridable.length) {
      if (typeof toast === 'function')
        toast('Narrow to ' + _smN + ' or fewer results first', 1800);
      return;
    }
    if (window.salKeyboardClose) window.salKeyboardClose();   // (dev0739)
    const rows = _smGridable.slice();
    window._smReturnPage = _pgOf('search');   // Esc / swipe-back returns here, to Search
    // (dev0403) Remember the query so the return-to-Search restores the box and
    // focuses ★ Save (see the landing focus block).
    window._smLastQuery = (_smBox.value || '').trim();
    window._smRestoreSearchOnReturn = true;
    ov.remove();
    window._fromShareableMenu = false;
    _smBuildGridFromRows(rows);
  };
  const _smSaveBtn = ov.querySelector('#smSaveSearch');
  // Save the current query to the SavedSearches list, then refresh that tab.
  const _smSaveCurrent = () => {
    const q = (_smBox.value || '').trim();
    if (!q) { if (typeof toast === 'function') toast('Type a search first', 1500); return; }
    if (_smSavedAdd(q)) { if (typeof toast === 'function') toast('★ Saved "' + q + '"', 1500); }
    else { if (typeof toast === 'function') toast('Already saved', 1200); }
    _smRenderSaved();
  };
  const _smDoClear = () => { _smBox.value = ''; _smRunSearch(); _smBox.focus(); };
  // (dev0401) Tab cycles a closed loop: text box → Clear → Make grid → Save →
  // text box (Shift+Tab reverses). Each control handles Tab itself so focus
  // never escapes the search toolbar (the menu's Tab handler defers in .sm-chtools).
  if (_smBox) {
    _smBox.addEventListener('input', _smRunSearch);
    _smBox.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); _smMakeGridNow(); return; }
      if (e.key === 'Tab') { e.preventDefault(); (e.shiftKey ? _smSaveBtn : _smClearBtn).focus(); }
    });
    // (dev0739) On a phone this box raised the SYSTEM keyboard, which the OS
    // draws in the device's physical orientation — sideways across our rotated
    // UI, and unturnable. Use our own instead. Go builds the grid, the same as
    // Enter. Desktop is untouched: salKeyboardAttach returns on non-touch.
    if (window.salKeyboardAttach) {
      window.salKeyboardAttach(_smBox, { onGo: () => _smMakeGridNow() });
    }
  }
  if (_smClearBtn) {
    _smClearBtn.addEventListener('click', _smDoClear);
    _smClearBtn.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _smDoClear(); return; }
      if (e.key === 'Tab') { e.preventDefault(); (e.shiftKey ? _smBox : _smMakeBtn).focus(); }
    });
  }
  if (_smMakeBtn) {
    _smMakeBtn.addEventListener('click', _smMakeGridNow);
    _smMakeBtn.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _smMakeGridNow(); return; }
      if (e.key === 'Tab') { e.preventDefault(); (e.shiftKey ? _smClearBtn : _smSaveBtn).focus(); }
    });
  }
  if (_smSaveBtn) {
    _smSaveBtn.addEventListener('click', _smSaveCurrent);
    _smSaveBtn.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _smSaveCurrent(); return; }
      if (e.key === 'Tab') { e.preventDefault(); (e.shiftKey ? _smMakeBtn : _smBox).focus(); }
    });
  }

  // Rows a query resolves to right now (same blob + COI filtering the Search tab
  // uses). Shared by the SavedSearches live count and its Open-the-grid action.
  const _smRowsForQuery = q => {
    const lq = window.salFold(q);   // (dev0855) same fold as _smRunSearch
    let hits = _tBlobs.filter(x => {
      if (!x.playable) return false;   // (dev0668) same rule as _smRunSearch
      _smResolveTags(x);
      return x.staticBlob.includes(lq) || (x.tagBlob && x.tagBlob.includes(lq));
    });
    if (_filtTaxon) hits = hits.filter(x => x.hasTaxon);
    if (_filtMedia) hits = hits.filter(x => x.kind === 'video' || x.kind === 'image');
    return hits.map(x => x.r);
  };
  // (dev0401) SavedSearches tab — render from localStorage (persists across
  // browser restarts / reboots). Each row shows the query + a live "now matches"
  // count, with Open (opens the grid for that search) and Delete buttons.
  const _smSavedBody = ov.querySelector('#smSavedBody');
  // (dev0405) Bounded retry counter for the count re-render below.
  let _smSavedRetries = 0;
  const _smRenderSaved = () => {
    if (!_smSavedBody) return;
    const list = _smSavedLoad();
    if (!list.length) {
      _smSavedBody.innerHTML = '<div class="sm-chnone">No saved searches yet. '
        + 'On the Search tab, run a search and click <b>★ Save</b> to keep it here.</div>';
      return;
    }
    _smSavedBody.innerHTML = list.map(it => {
      const n = _smRowsForQuery(it.q).length;
      return '<div class="sm-item sm-card">'
        + '<span class="sm-ico">🔎</span>'
        + '<span class="sm-rcol">'
          + '<span class="sm-rname">' + _smEsc(it.q) + '</span>'
          + '<span class="sm-rmeta">' + n + ' match' + (n === 1 ? '' : 'es') + ' now'
            + (it.ts ? '  ·  saved ' + _smDateShort(new Date(it.ts).toISOString()) : '') + '</span>'
        + '</span>'
        + '<span class="sm-svbtns">'
          + '<button class="sm-svbtn" data-act="open" data-q="' + _smEsc(it.q) + '">Open</button>'
          + '<button class="sm-svbtn" data-act="ren" data-q="' + _smEsc(it.q) + '">Rename</button>'
          + '<button class="sm-svbtn del" data-act="del" data-q="' + _smEsc(it.q) + '">Delete</button>'
        + '</span>'
      + '</div>';
    }).join('');
    // (dev0403) Open builds + shows the grid for that saved search directly
    // (rather than hopping to the Search tab). Delete removes it and re-renders.
    const _smOpenSaved = q => {
      const rows = _smRowsForQuery(q);
      if (!rows.length) { if (typeof toast === 'function') toast('No matches for "' + q + '" now', 1800); return; }
      if (rows.length > _smN && typeof toast === 'function') toast(rows.length + ' matches — showing first 25', 1600);
      window._smReturnPage = _pgOf('saved');  // Esc / swipe-back returns to SavedSearches
      window._smLastQuery = q;
      ov.remove();
      window._fromShareableMenu = false;
      _smBuildGridFromRows(rows);
    };
    _smSavedBody.querySelectorAll('.sm-svbtn').forEach(b => {
      b.addEventListener('click', e => {
        e.stopPropagation();
        const q = b.dataset.q;
        if (b.dataset.act === 'del') { _smSavedRemove(q); _smRenderSaved(); _smFocusFirstSaved(); }
        else if (b.dataset.act === 'ren') {
          const nq = prompt('Rename saved search:', q);
          if (nq === null || nq.trim() === '' || nq.trim() === q) return;
          const result = _smSavedRename(q, nq.trim());
          if (!result) { if (typeof toast === 'function') toast('A search with that name already exists', 2000); return; }
          _smRenderSaved(); _smFocusFirstSaved();
        }
        else _smOpenSaved(q);
      });
    });
    // (dev0403) Tab (and Shift+Tab) cycles focus down the Open buttons and wraps
    // back to the top — staying within the saved list instead of switching tabs.
    // stopPropagation keeps the menu's tab-cycling Tab handler from firing.
    const _openBtns = [..._smSavedBody.querySelectorAll('.sm-svbtn[data-act="open"]')];
    _openBtns.forEach((btn, i) => {
      btn.addEventListener('keydown', e => {
        if (e.key !== 'Tab') return;
        e.preventDefault(); e.stopPropagation();
        const dir = e.shiftKey ? -1 : 1;
        const nxt = _openBtns[(i + dir + _openBtns.length) % _openBtns.length];
        if (nxt) nxt.focus();
      });
    });
    // (dev0405) The "N matches now" counts run through _smResolveTags, which can
    // only resolve dictionary/taxon tags once tags.js has populated window.tagsLib.
    // On a cold open the viewer can reach SavedSearches before that finishes, so
    // every tag-based query — and (with the Greeting COI taxon/media filters on)
    // EVERY query — counts 0 and never updates. Re-render once tags arrive (a
    // short bounded poll, self-stopping the moment tagsLib exists).
    if (!_tagsReady() && _smSavedRetries < 40) {
      _smSavedRetries++;
      setTimeout(_smRenderSaved, 250);
    }
  };
  _smRenderSaved();

  // (dev0940) ── SAVED LOOPS ─────────────────────────────────────────────────
  // The merge of "My Loops" and "Add your own". A loop is an A→B stretch of a
  // video the viewer wants to come back to; the only thing that differed
  // between the two lists was where the video came from, and that is a TAG on
  // the card now rather than a second tab:
  //
  //   FromThisSite   — a collection row      (numeric ml.json UID)
  //   FromPastedURL  — the viewer's own link (synthetic ul_… UID, loops.js)
  //
  // The discriminator is the loop's own uid, so the merge stores nothing new.
  //
  // A pasted link carrying NO loop is not listed. Pasting is how you get a
  // video in front of you to mark up, not a thing to curate in its own right.
  // The link stays in salLinks — a loop resolves its URL through it, and
  // nothing a viewer saved is deleted behind their back — it simply isn't a
  // card, and re-pasting the same URL finds it again with its uid, and
  // therefore any loops already on it, intact.
  //
  // All of it lives in the viewer's own browser (localStorage), never in
  // ml.json, which is dev-owned and FSA-clobbered on every save.
  const _smLoopsBody = ov.querySelector('#smLoopsBody');
  const _smRenderLoops = () => {
    if (!_smLoopsBody) return;
    if (!window.salLoops) {
      _smLoopsBody.innerHTML = '<div class="sm-chnone">Loops aren\'t available in this browser.</div>';
      return;
    }
    window.salLoops.list().then(list => {
      if (!list.length) {
        _smLoopsBody.innerHTML = '<div class="sm-chnone">No loops yet. '
          + 'Open a video, set <b>A</b> and <b>B</b> on the player toolbar, then press '
          + '<b>AB&#128190;</b> (or the <b>L</b> key) to keep that stretch here.'
          + (SM_FEAT_ADDOWN
              ? '<br><br>That works on a YouTube or Vimeo link of your own just as well — '
                + 'paste one with <b>📋 Paste a video URL</b> above, then mark A→B on it the same way.'
              : '')
          + '<br><br>'
          + '<span style="color:#8a93a8;font-size:12px;">Loops are saved in this browser only — '
          + 'they aren\'t shared to another device or to the site.</span></div>';
        return;
      }
      // Resolve every loop to a live row up front so a card can show what it
      // points at (and grey out the ones whose row has gone).
      const rowById = {};
      // Which of those rows is one of the viewer's own pasted links rather than
      // a collection row — Open has to take a different route, and it is what
      // the FromPastedURL tag reports.
      const ownById = {};
      list.forEach(e => {
        const res = window.salLoops.resolve(e, mlRows);
        rowById[e.id] = res.row || null;
        // Link rescued a stale UID — repair it for next time. Fire-and-forget:
        // the card in front of the viewer is already correct either way.
        if (res.byLink && res.row && res.row.UID != null) {
          window.salLoops.update(e.id, { uid: String(res.row.UID) });
        }
        // Not in ml.json — try the viewer's own links (uid first, then the URL,
        // matching salLoops' own keying rule). A loop marked on a pasted URL
        // lands here every time; one whose link was since deleted stays null and
        // the card greys out like any other missing row.
        if (!rowById[e.id] && window.salLinks) {
          const own = window.salLinks.getSync(e.uid)
                   || (e.link ? window.salLinks.byLinkSync(e.link) : null);
          if (own) {
            rowById[e.id] = window.salLinks.rowFor(own);
            ownById[e.id] = true;
            if (String(own.uid) !== String(e.uid)) window.salLoops.update(e.id, { uid: own.uid });
          }
        }
      });
      const fmt = window.salLoops.fmt;
      _smLoopsBody.innerHTML = list.map(e => {
        const row = rowById[e.id];
        const span = fmt(e.a) + ' → ' + fmt(e.b)
          + '  (' + (e.b - e.a).toFixed(1) + 's)';
        // Badge by MEDIA kind (always 🎬 here) rather than _smResultBadge, which
        // would call a video row carrying ftext a "slide" — true for a search
        // result, misleading for something you're about to watch on a loop.
        const src = row
          ? (_smBadge[window.rowMediaKind ? window.rowMediaKind(row) : 'other'] || '🔗')
            + ' ' + _smResultLabel(row)
          : '⚠ this item is no longer available';
        // (dev0940) The tag the merge is built on. A FromPastedURL loop lives or
        // dies with the viewer's own link, not with the collection — which is
        // the one thing about it they need to be able to see.
        const tag = ownById[e.id] ? 'FromPastedURL' : 'FromThisSite';
        const meta = _smEsc(src) + '  ·  ' + tag + '  ·  ' + span
          + (e.ts ? '  ·  saved ' + _smDateShort(new Date(e.ts).toISOString()) : '');
        return '<div class="sm-item sm-card"' + (row ? '' : ' style="opacity:.55;"') + '>'
          + '<span class="sm-ico">&#128257;</span>'
          + '<span class="sm-rcol">'
            + '<span class="sm-rname">' + _smEsc(e.name) + '</span>'
            + '<span class="sm-rmeta">' + meta + '</span>'
          + '</span>'
          + '<span class="sm-svbtns">'
            + '<button class="sm-svbtn" data-act="open" data-id="' + _smEsc(e.id) + '"' + (row ? '' : ' disabled') + '>Open</button>'
            + '<button class="sm-svbtn" data-act="ren" data-id="' + _smEsc(e.id) + '">Rename</button>'
            + '<button class="sm-svbtn del" data-act="del" data-id="' + _smEsc(e.id) + '">Delete</button>'
          + '</span>'
        + '</div>';
      }).join('');
      const byId = {};
      list.forEach(e => { byId[e.id] = e; });
      // Open = arm the loop, then launch V exactly as a search result does. The
      // A→B rides on window._vpPendingLoop (read and cleared by
      // gridOpenFullscreen) so nothing about the loop touches the ml.json row.
      const _smOpenLoop = e => {
        const row = rowById[e.id];
        if (!row) { if (typeof toast === 'function') toast('That item is no longer available', 2200); return; }
        const pend = {
          uid: String(row.UID), link: String(row.link || ''),
          a: e.a, b: e.b, name: e.name
        };
        // A loop on one of the viewer's own links can't go through _smOpenV —
        // that resolves the UID against ml.json, where a ul_… UID will never be.
        // _smOpenUserRow mounts the synthetic row directly.
        if (ownById[e.id]) { _smOpenUserRow(row, pend); return; }
        window._vpPendingLoop = pend;
        _smOpenV(String(row.UID));           // sets _smReturnPage to this page
      };
      _smLoopsBody.querySelectorAll('.sm-svbtn').forEach(b => {
        b.addEventListener('click', ev => {
          ev.stopPropagation();
          const e = byId[b.dataset.id];
          if (!e) return;
          if (b.dataset.act === 'del') {
            window.salLoops.remove(e.id).then(() => { _smRenderLoops(); });
          } else if (b.dataset.act === 'ren') {
            const nn = prompt('Rename loop:', e.name);
            if (nn === null || !nn.trim() || nn.trim() === e.name) return;
            window.salLoops.update(e.id, { name: nn.trim() }).then(() => { _smRenderLoops(); });
          } else {
            _smOpenLoop(e);
          }
        });
      });
      // (dev0403 pattern) Tab cycles the Open buttons within the list and wraps,
      // instead of escaping to the menu's tab-switcher.
      const _openBtns = [..._smLoopsBody.querySelectorAll('.sm-svbtn[data-act="open"]:not([disabled])')];
      _openBtns.forEach((btn, i) => {
        btn.addEventListener('keydown', ev => {
          if (ev.key !== 'Tab') return;
          ev.preventDefault(); ev.stopPropagation();
          const dir = ev.shiftKey ? -1 : 1;
          const nxt = _openBtns[(i + dir + _openBtns.length) % _openBtns.length];
          if (nxt) nxt.focus();
        });
      });
      // The list load is async, so a viewer who landed on this tab before it
      // painted still has focus on the tab button — pull it onto the first Open.
      if (window._smCurPage === _pgOf('loops') && document.activeElement
          && document.activeElement.classList
          && document.activeElement.classList.contains('sm-tab')) {
        _smFocusFirstLoop();
      }
    }).catch(() => {
      _smLoopsBody.innerHTML = '<div class="sm-chnone">Could not read your saved loops.</div>';
    });
  };
  _smRenderLoops();

  // ── Paste a video URL of your own ─────────────────────────────────────────
  // Paste → it opens in V → mark A and B → AB💾 keeps the loop, exactly as on a
  // collection row. The link itself is stored by loops.js (salLinks) in the
  // viewer's browser; nothing here ever touches ml.json.
  const _smPasteBtn  = ov.querySelector('#smPasteUrl');
  const _smTypeBtn   = ov.querySelector('#smTypeUrl');
  const _smAddManual = ov.querySelector('#smAddManual');
  const _smAddBox    = ov.querySelector('#smAddBox');
  const _smAddGo     = ov.querySelector('#smAddGo');

  if (_smPasteBtn || _smAddBox) {
    // Reveal (and focus) the manual box. Called both by the ⌨ button and
    // whenever a clipboard read is refused or comes back with nothing usable.
    const _smShowManual = (msg, prefill) => {
      if (!_smAddManual || !_smAddBox) return;
      _smAddManual.style.display = '';
      if (prefill) _smAddBox.value = prefill;
      _smAddBox.focus();
      _smAddBox.select();
      if (msg && typeof toast === 'function') toast(msg, 2600);
    };

    // What a rejected paste gets told. Naming the accepted kinds is the whole
    // message — "invalid URL" would leave the viewer guessing.
    // (dev0940) Three kinds, not four: an image has no time dimension to loop.
    const _smAddReject = raw => {
      const short = String(raw || '').slice(0, 60);
      if (typeof toast === 'function') {
        toast('Can\'t use that link' + (short ? ':\n' + short : '')
          + '\nUse a YouTube, Vimeo or video-file link.', 3600);
      }
    };

    // Add + immediately open. Re-adding a URL already in the list re-uses that
    // entry (keeping its UID, and therefore any loops already marked on it).
    const _smAddUrl = raw => {
      if (!window.salLinks) { if (typeof toast === 'function') toast('Saved links aren\'t available in this browser', 2600); return; }
      const url = window.salLinks.normalize(raw);
      if (!url || !window.salLinks.classify(url)) { _smAddReject(raw); return; }
      window.salLinks.add({ link: url }).then(res => {
        if (_smAddBox) _smAddBox.value = '';
        if (typeof toast === 'function') {
          toast(res.created ? '➕ Added — opening it now. Set A and B, then press AB💾'
                            : 'Already one of yours — opening it', 2400);
        }
        const row = window.salLinks.rowFor(res.entry);
        setTimeout(() => _smOpenUserRow(row), 120);
      }).catch(err => {
        if (err && err.message === 'unsupported') { _smAddReject(raw); return; }
        if (typeof toast === 'function') toast('Could not save that link — browser storage may be full', 3000);
      });
    };

    // 📋 Paste. navigator.clipboard.readText() is the direct route, but it is
    // unavailable or permission-gated in plenty of browsers (and on any
    // non-secure origin), so EVERY failure path lands on the manual box rather
    // than on an error — the viewer can always finish the job with Ctrl+V.
    const _smPasteFlow = () => {
      const nav = navigator.clipboard;
      if (!nav || typeof nav.readText !== 'function') {
        _smShowManual('Your browser won\'t share the clipboard — paste it here with Ctrl+V');
        return;
      }
      nav.readText().then(txt => {
        const raw = String(txt || '').trim();
        if (!raw) { _smShowManual('Clipboard is empty — copy a link first, or paste it here'); return; }
        if (!window.salLinks || !window.salLinks.classify(raw)) {
          // Something IS on the clipboard but we can't play it — show it in the
          // box so the viewer can see what was read and fix it, rather than
          // wondering what the toast was about.
          _smShowManual('');
          _smAddReject(raw);
          if (_smAddBox) { _smAddBox.value = raw; _smAddBox.select(); }
          return;
        }
        _smAddUrl(raw);
      }).catch(() => {
        _smShowManual('Couldn\'t read the clipboard — paste it here with Ctrl+V');
      });
    };

    if (_smPasteBtn) _smPasteBtn.addEventListener('click', _smPasteFlow);
    if (_smTypeBtn)  _smTypeBtn.addEventListener('click', () => _smShowManual(''));
    if (_smAddGo)    _smAddGo.addEventListener('click', () => _smAddUrl(_smAddBox ? _smAddBox.value : ''));
    if (_smAddBox) {
      _smAddBox.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); _smAddUrl(_smAddBox.value); }
      });
      // A real paste INTO the box is the happy path on browsers that refuse a
      // programmatic read — take it straight through without a second click.
      _smAddBox.addEventListener('paste', e => {
        const txt = e.clipboardData && e.clipboardData.getData('text');
        if (!txt) return;
        e.preventDefault();
        _smAddBox.value = txt.trim();
        _smAddUrl(_smAddBox.value);
      });
    }

    // Tab keeps focus inside this page and wraps — the same rule SavedSearches
    // follows, rather than escaping to the menu's tab-switcher. One delegated
    // listener; the control list is rebuilt on each press so it picks up the
    // manual box the moment it's revealed and every card the list re-renders.
    // Unhandled presses fall through to the menu's own handler.
    const _smLoopsPageEl = ov.querySelector('#smPage' + _pgOf('loops'));
    if (_smLoopsPageEl) _smLoopsPageEl.addEventListener('keydown', e => {
      if (e.key !== 'Tab') return;
      const els = [_smPasteBtn, _smTypeBtn];
      if (_smAddManual && _smAddManual.style.display !== 'none') els.push(_smAddBox, _smAddGo);
      if (_smLoopsBody) _smLoopsBody.querySelectorAll('.sm-svbtn[data-act="open"]').forEach(b => els.push(b));
      const ring = els.filter(Boolean);
      const i = ring.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault(); e.stopPropagation();
      const nxt = ring[(i + (e.shiftKey ? -1 : 1) + ring.length) % ring.length];
      if (nxt) nxt.focus();
    });
  }
}

// (dev0401) Saved-search persistence — a small list in localStorage. It lives
// in the browser's local storage, so it survives closing the tab, quitting the
// browser, and rebooting (it is NOT per-session). It is per-browser + per-site:
// not shared to another browser, another computer, or the server, and it is
// cleared if the user wipes site data. Each entry: { q, ts }.
const _SM_SAVED_KEY = 'slam-saved-searches';
function _smSavedLoad() {
  try { const v = JSON.parse(localStorage.getItem(_SM_SAVED_KEY) || '[]'); return Array.isArray(v) ? v : []; }
  catch (e) { return []; }
}
function _smSavedSave(list) {
  try { localStorage.setItem(_SM_SAVED_KEY, JSON.stringify(list)); } catch (e) {}
}
function _smSavedAdd(q) {
  q = String(q || '').trim(); if (!q) return false;
  const list = _smSavedLoad();
  if (list.some(it => String(it.q).toLowerCase() === q.toLowerCase())) return false;
  list.unshift({ q, ts: Date.now() });
  _smSavedSave(list);
  return true;
}
function _smSavedRemove(q) {
  const lq = String(q || '').toLowerCase();
  _smSavedSave(_smSavedLoad().filter(it => String(it.q).toLowerCase() !== lq));
}
function _smSavedRename(oldQ, newQ) {
  const lo = String(oldQ || '').toLowerCase(), ln = String(newQ || '').toLowerCase();
  const list = _smSavedLoad();
  if (list.some(it => String(it.q).toLowerCase() === ln && String(it.q).toLowerCase() !== lo)) return false;
  const updated = list.map(it => String(it.q).toLowerCase() === lo ? { ...it, q: newQ } : it);
  _smSavedSave(updated);
  return true;
}

// (dev0400) Build an ad-hoc grid from a set of ml rows (used by the menu's
// Search tab). Grid size scales with the count — 1-4→2×2, 5-9→3×3, 10-16→4×4,
// 17-25→5×5 (never the 17/19 special layouts). Mirrors _openConfigByName's
// activation but with a synthetic in-memory config instead of a c.json row, and
// without persisting (no save()) since this arrangement is ephemeral.
function _smBuildGridFromRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return;
  let gsize = 2;                  // 1-4 → 4
  if (rows.length >= 17) gsize = 5;       // 17-25 → 25
  else if (rows.length >= 10) gsize = 4;  // 10-16 → 16
  else if (rows.length >= 5) gsize = 3;   // 5-9 → 9
  const cellsN = gsize * gsize;
  const cfg = { gname: 'Search results', cells: cellsN };
  const cellList = (typeof _gridCellList === 'function')
    ? _gridCellList(gsize, 'square')
    : (() => { const a = []; for (let r = 1; r <= gsize; r++) for (let c = 1; c <= gsize; c++) a.push({ cs: r + 'abcde'.charAt(c - 1) }); return a; })();
  rows.slice(0, cellsN).forEach((r, i) => {
    if (cellList[i] && r && r.UID != null) cfg[cellList[i].cs] = String(r.UID);
  });
  window._gridActiveConfig = cfg;
  window._gridSource = 'C';
  window._gridName = 'Search results';
  if (typeof _gridApplyConfigZoom === 'function') _gridApplyConfigZoom(cfg);
  if (typeof _setGridGsize === 'function') _setGridGsize(gsize, { skipSave: true });
  const gOvl = document.getElementById('gridOverlay');
  if (gOvl) gOvl.style.display = 'flex';
  if (typeof gridShow === 'function') gridShow();
}
window._showShareableMenu = _showShareableMenu;

// (dev0384) Leave a grid that was opened from the shareable menu and re-mount
// the menu on the page it was launched from (window._smReturnPage, set by the
// ss launcher). Used by both the grid's Esc key (collection.js) and its R→L
// swipe-back (grid.js). Tears the grid players down first so nothing keeps
// playing behind the menu.
window._returnToMenuFromGrid = function () {
  // (dev0706) Halt the moving-cells family FIRST. This path only HIDES the grid,
  // so a mode left running kept animating cells nobody could see — and it is
  // the one viewers actually use (Esc, or the swipe across a cell border). Shared
  // with gridClose() via collection.js's _gmStopAll so the two can't drift.
  if (typeof window._gmStopAll === 'function') window._gmStopAll();
  if (typeof gridCleanupPlayers === 'function') gridCleanupPlayers();
  if (typeof gridClearCut === 'function') gridClearCut();
  if (typeof gridHideContextMenu === 'function') gridHideContextMenu();
  // (dev0705) Both grid cards are position:fixed on <body>, so hiding the overlay
  // alone leaves them floating over the menu. gridClose() already drops them; this
  // path is the user-mode way out and has to as well.
  if (typeof window._gridBufPanelClose === 'function') window._gridBufPanelClose();
  if (typeof window._gmModesClose === 'function') window._gmModesClose();
  if (typeof window._gmHeavyCardClose === 'function') window._gmHeavyCardClose();  // (dev0800)
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
  // (dev0793) `?addwm=1` — WmUploadNew.bat opens this after it uploads, so the
  // last manual step (T ▸ Housekeeping ▸ Add Watermarked Media) happens on its
  // own. Routed through the SAME in-app function, not a disk write: rows have to
  // come from nextUID()/save() or they collide with whatever the running tab
  // holds. Dev-mode only, and idempotent — a second run adds nothing.
  if (params.get('addwm') === '1' && !_isUserMode()) {
    // (dev0872) Consume the parameter first. It used to survive in the address
    // bar, so every later reload of that tab re-ran the check and announced its
    // own no-op — which is what made this look like a T-load toast rather than
    // an upload one. The run is silent when there is nothing to add, too.
    try {
      params.delete('addwm');
      const q = params.toString();
      history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
    } catch (_) {}
    setTimeout(() => {
      if (typeof window.housekeepingAddWatermarked === 'function') {
        window.housekeepingAddWatermarked({ auto: true });
      }
    }, 800);
  }
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
  // (dev0634) 30s (was 5s): ml.json is ~5MB and cache-busted, and GitHub Pages
  // hiccups (observed 503 first-byte timeouts) — the 5s cap made ?c=/?ss=
  // deep-links on the public site die SILENTLY whenever the data fetch ran
  // long, which reproduced intermittently on sealifeandmore.com.
  while (!ready()) {
    if (Date.now() - startedAt > 30000) {
      if (typeof toast === 'function') toast('Could not load data — check your connection and reload', 5000);
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
    // (dev0634) One retry after 1.5s — a single Pages 503 killed the deep link.
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      try {
        const r = await fetch('c.json?t=' + Date.now());
        if (r.ok) parsed = await r.json();
      } catch (e) {}
      if (!parsed) await new Promise(r2 => setTimeout(r2, 1500));
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
  // (dev0609) Derive the footprint through the shared helper cMakeActive uses,
  // instead of the old square-only 4/9/16/25 ladder that this path had of its
  // own. That ladder defaulted every other `cells` value to gsize 5, so a grid
  // opened BY NAME (menu pick / ?grid= deep link) rendered the 17/19 specials
  // and the portrait layouts (cells 3/12/27) as a 5×5 — only C's Make-Active
  // got them right. One helper now means every activation route agrees.
  let gsize = 5, layout = 'square';
  if (typeof _gridApplyConfigToRows === 'function' && Array.isArray(data)) {
    const info = _gridApplyConfigToRows(cfg, data);
    gsize = info.gsize; layout = info.layout;
  } else if (typeof _gridConfigLayout === 'function') {
    const info = _gridConfigLayout(cfg);
    gsize = info.gsize; layout = info.layout;
  }
  if (typeof _setGridGsize === 'function') _setGridGsize(gsize, { skipSave: true });
  if (typeof metaRow !== 'undefined') {
    if (!metaRow) metaRow = { _salMeta: true };
    metaRow._salGsize = gsize;
    // (dev0629) Persist the layout token so a reload (which resets _gridSource
    // to 'T') still renders 17/19/portrait instead of a square 5×5 that drops
    // the 1L/1P-3P cell. Stamped AFTER _setGridGsize (it clears non-square).
    metaRow._salLayout = layout;
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
  // (dev0634) 30s cap + c.json retry — same silent-death fix as
  // _openConfigByName (see comment there).
  while (!ready()) {
    if (Date.now() - startedAt > 30000) {
      if (typeof toast === 'function') toast('Could not load data — check your connection and reload', 5000);
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
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      try {
        const r = await fetch('c.json?t=' + Date.now());
        if (r.ok) parsed = await r.json();
      } catch (e) {}
      if (!parsed) await new Promise(r2 => setTimeout(r2, 1500));
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

// ─────────────────────────────────────────────────────────────────────────────
// (dev0770) IN-COLLECTION LINKS. Xe's link button can now aim at the collection
// itself — `V.709` and `C.<gname>` (xe2.js setLink), which it writes as this
// app's own deep-link hrefs, `?i=709` and `?c=<gname>`.
//
// Following one as a plain URL would work, but it costs a full reload AND lands
// the reader in locked-mode (that is what a bare ?i= means to a stranger with a
// shared link). Inside the app neither is wanted: the author asked for the item
// to open "in window, with usual controls and return arrow". So intercept the
// click and stage it exactly as a menu card does — remember the page to come
// back to, force the grid backdrop, let vpClose/Esc/the back arrow come home.
//
// Capture phase, and only for these two shapes: every other <a> on every screen
// is left completely alone.
function _salOpenUid(uid) {
  const ov = document.getElementById('shareableMenu');
  if (ov) { window._smReturnPage = window._smCurPage; ov.remove(); window._fromShareableMenu = true; }
  const g = document.getElementById('gridOverlay');
  if (g) { g.style.display = 'flex'; window._vpForcedGridFromT = true; }
  _openItemByUid(uid);
}
function _salOpenConfig(name) {
  const ov = document.getElementById('shareableMenu');
  if (ov) { window._smReturnPage = window._smCurPage; ov.remove(); }
  window._fromShareableMenu = false;
  _openConfigByName(name);
}
window._salOpenUid = _salOpenUid;
window._salOpenConfig = _salOpenConfig;
// (dev0771) The click handler that calls these moved to core.js _salWireLinks —
// it has to be wired per DOCUMENT, because the V reader's slide lives in a
// srcdoc iframe that a listener on this document can never see.

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
  // (dev0774) The ML rows, which are NOT always `data`: while the C screen is
  // open, collection.js has swapped the global to c.json's 60 collections (no
  // UID column at all) and parked the T rows in _tSave.data. A `v.709` link
  // clicked from a slide while C was up therefore reported "No item with UID
  // 709" — the row was never missing, this was reading the wrong table. Third
  // caller caught by that swap; teMlRows (xe.js) is the one place that knows.
  const _mlRows = () => (typeof window.teMlRows === 'function')
    ? window.teMlRows()
    : ((typeof data !== 'undefined' && Array.isArray(data)) ? data : []);
  function tryOpen() {
    const rows = _mlRows();
    if (!rows.length) {
      if (Date.now() - startedAt > 5000) {
        if (typeof toast === 'function') toast('Could not load data — check your connection', 3000);
        _recoverMenu();
        return;
      }
      setTimeout(tryOpen, 100);
      return;
    }
    const row = rows.find(r => String(r.UID) === want);
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
      // (zip0153/0502) Derive layout + footprint from cfg.cells and mirror the
      // cell→UID map onto row.cell via the shared helper (handles square 25/16/9/4,
      // the 17/19 ring layouts, and the 3/12/27 portrait grids identically).
      let gsize = 5, info = { layout: 'square', gsize: 5 };
      if (typeof data !== 'undefined' && Array.isArray(data) && typeof _gridApplyConfigToRows === 'function') {
        info = _gridApplyConfigToRows(cfg, data);
        gsize = info.gsize;
      }
      _setGridGsize(gsize, { skipSave: true });
      metaRow = metaRow || { _salMeta: true };
      metaRow._salGsize = gsize;
      // (dev0629) Persist the layout token (see cMakeActive) — after _setGridGsize,
      // which clears any non-square _salLayout.
      metaRow._salLayout = info.layout;
      if (typeof save === 'function') save();
      close();
      if (typeof gridShow === 'function') gridShow();
      const _lbl = (typeof _gridLayoutLabel === 'function') ? _gridLayoutLabel(info.layout, gsize) : (gsize + '×' + gsize);
      if (typeof toast === 'function') toast('✓ ' + (cfg.gname || '(unnamed)') + ' (' + _lbl + ')', 1500);
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
    // (dev0703) The button does two different things (see its click handler
    // below) and the static index.html title only described the dev one. Keep
    // the label honest per mode — helpfloat.js's balloons read this title, so a
    // wrong one here becomes a wrong balloon.
    // (dev0930) Only the user-mode half is translated — the dev wording is for
    // an audience of one and stays English.
    btn.title = _isUserMode()
      ? (window.T || (s => s))('Back to the Main Page — pick another grid, a saved view or a search')
      : 'Switch to Configurations (choose a different grid)';
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

// ─────────────────────────────────────────────────────────────────────────────
// (dev0763) STALE-BUILD SELF-HEAL.
//
// ml.json and c.json are fetched with ?t=Date.now(), so DATA is never stale.
// index.html is not — and it is the file that pins the build: every script tag
// carries ?v=<HELP_VERSION_STR>, so a cached index.html serves cached scripts
// with it, and the phone keeps running an old app long after a push. That is
// invisible (nothing on screen disagrees with itself) and, on Android, there is
// no hard-reload gesture to clear it — which is what this is for.
//
// Re-fetch index.html with cache:'no-store', read the version out of it, and if
// the published build is not the one running, reload through a URL the HTTP
// cache has never seen (?v=<build>), preserving every existing param. Once per
// session per version, so a browser that refuses to let go can't loop.
//
// (dev0792) IT NOW RUNS ON LOCALHOST TOO, which is where it was needed most.
// dev0763 excluded local dev on the grounds that a developer can hard-refresh —
// but the two caches are not comparable:
//
//   GitHub Pages sends `Cache-Control: max-age=600`. Bounded: ten minutes and it
//   heals itself whether anything checks or not.
//   Python's http.server (the :8080 dev server) sends NO Cache-Control at all,
//   only Last-Modified — so the browser falls back to HEURISTIC freshness, ~10%
//   of the file's age. On a file last touched a week ago that is most of a day,
//   and it never expires on its own.
//
// And hard-refresh does not reach the place it hurts: /?vect=<path> is its own
// cache entry, one per file opened, so refreshing the app's main tab leaves
// every one of them stale. That is how dev0790 came to be live on the server
// and invisible in VECT.
//
// Two things it will not do, both deliberate:
//   • Never reload after the viewer has touched the page. A reload is only safe
//     while nothing is half-done — an open crop box, a half-typed caption or an
//     unsaved table edit is worth more than being one build behind. Past that
//     point it says so and leaves the decision alone.
//   • Never reload a ?qaction= handoff. Q hands its selection over in
//     sessionStorage and the receiving code CONSUMES it on DOMContentLoaded, so
//     a reload two seconds later would land on a page with nothing to open.
// ─────────────────────────────────────────────────────────────────────────────
(function _salBuildFreshness() {
  // Set the moment the viewer does anything at all. Registered now rather than
  // inside the timeout so it is already watching during the two seconds before
  // the check runs — that window is short, but it is exactly when a ?vect= crop
  // box has just opened under the cursor.
  let touched = false;
  const mark = () => { touched = true; };
  ['pointerdown', 'keydown', 'wheel'].forEach(ev =>
    window.addEventListener(ev, mark, { capture: true, once: true, passive: true }));

  setTimeout(async function () {
    try {
      const here = String(window.HELP_VERSION_STR || '');
      if (!here) return;
      // Once per tab: this costs a second index.html over mobile data, and a
      // reload inside the same tab can't have changed what the server holds.
      try {
        if (sessionStorage.getItem('sal-fresh-checked') === here) return;
        sessionStorage.setItem('sal-fresh-checked', here);
      } catch (_) {}
      const r = await fetch('index.html?fresh=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const m = (await r.text()).match(/HELP_VERSION_STR\s*=\s*'([^']+)'/);
      if (!m) return;
      const live = m[1];
      if (live === here) return;
      let seen = null;
      try { seen = sessionStorage.getItem('sal-reload-for'); } catch (_) {}
      // (dev0792) Already tried and still on the old build — the cache is
      // winning. Looping would only cost bandwidth, so hand the key over
      // instead of pretending it healed.
      if (seen === live) {
        if (typeof toast === 'function') {
          toast('⟳ ' + live + ' is on the server but this tab keeps loading ' + here +
                ' — press Ctrl+Shift+R', 9000);
        }
        return;
      }
      // (dev0792) A reload here would take real work with it, or strand a Q
      // handoff whose selection has already been consumed. Say what happened
      // and let it be picked up on the next load.
      const qHandoff = new URLSearchParams(window.location.search).has('qaction');
      if (touched || qHandoff) {
        if (typeof toast === 'function') {
          toast('⟳ build ' + live + ' is out — reload when you are at a good point ' +
                '(this tab is running ' + here + ')', 8000);
        }
        return;
      }
      try { sessionStorage.setItem('sal-reload-for', live); } catch (_) {}
      const p = new URLSearchParams(window.location.search);
      p.set('v', live);
      location.replace(window.location.pathname + '?' + p.toString() + window.location.hash);
    } catch (_) { /* offline, blocked, whatever — never break the app over this */ }
  }, 2000);
})();
