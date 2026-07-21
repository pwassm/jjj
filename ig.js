// ══════════════════════════════════════════════════════════════════════════════
// I / Ig SCREEN — staging table for ig.json (dev0429, revised dev0430)
// ══════════════════════════════════════════════════════════════════════════════
// A standalone, dev-only screen that views the IG-harvest staging store (ig.json)
// the way T views ml.json — but deliberately SEPARATE from ml.json/T/G so the
// 1000s of harvested reels never clutter the working table. From here a row can be
//   • Enriched  → yt-dlp → VidTitle + ftext + ttxt + VidAuthor + DatePosted +
//                 duration + W×H (reuses the core.js IG pipeline verbatim).
//   • Downloaded→ proxy /ig/download → yt-dlp saves the media (max res) to
//                 <project>/ig_media/ named per the user's AHK convention:
//                 hh.mm.ss~WxH~Title~@author~[[i[id]]].mp4  (one — max — W×H).
//   • Promoted  → a real ml.json row is minted (data.push + save()) so it joins T/G.
// All edits persist back to ig.json via the proxy /ig/save endpoint.
//
// Hotkey: I (dev-only, blocked in user mode like T). Esc closes the detail drawer,
// then the screen. The file is isolated (like movingcells.js/flycells.js).
//
// Globals borrowed from core.js (same realm — classic <script> tags share scope):
//   toast, isoNow, nextUID, data, save, _isUserMode, _ensureCommonWords,
//   _ytdlpFetchMeta, _ytdlpAuthorHandle, _ytdlpBuildFtext, _smartIgTitle, _normalizeText
(function () {
  'use strict';

  const PROXY = 'http://127.0.0.1:8081';
  const STORE_URL = () => 'ig.json?t=' + Date.now();

  // ── State ────────────────────────────────────────────────────────────────
  let rows = [];                       // the live ig.json array (mutated in place)
  // (dev0601) Every id this session has EVER SEEN — stamped at load, never pruned on
  // delete. Sent with each persist() so the proxy can tell "the client deleted this"
  // (id is here) from "the client never knew about this" (id is not) and carry the
  // latter over instead of letting our stale rows[] wipe a mid-session harvest.
  let knownIds = new Set();
  let rescueNoted = false;             // only toast the "rows were rescued" hint once
  let view = [];                       // filtered + sorted slice of `rows`
  let sortCol = 'DateAdded', sortDir = -1;
  let query = '', kindFilter = 'all', statusFilter = 'all', authorFilter = 'all';
  let stagedFilter = 'all';            // (dev0472) all | non (NonFullReels/ffdown) | full (harvested)
  let hideCompleted = false;           // (dev0438) hotkey 'c' → hide downloaded ("completed") rows
  let coverOnly = false;               // (dev0512) download toggle: cookieless index-1 cover only (no carousel, no cookies)
  let sel = new Set();                 // selected ids (batch ops)
  let lastCheckedId = null;            // anchor for shift-click range selection
  let focusId = null;                  // row open in the detail drawer
  let processingId = null;             // (dev0445) row currently being enriched/downloaded (live highlight)
  let dirty = false;                   // unsaved enrich/promote/status edits
  let busy = false;                    // a batch op is running
  let batchAbort = false;              // user pressed Stop during a batch
  let lastOpError = '';                // last enrich/download error (for throttle detection)
  let lastOpInfo = '';                 // (dev0437) cookie posture of the last op ('cookieless'/'Firefox cookies')
  let lastDlName = '';                 // (dev0649) title/id of the most recent successful download (rotate toasts)
  // (dev0441) Posts that FAILED cookieless enrich this session because they're
  // login-walled (yt-dlp can't read them without cookies). They keep status 'new'
  // — so without this they'd be re-hit on EVERY bulk Enrich, never succeeding and
  // showing no change. Bulk Enrich skips them after one attempt; ↻ Reload (or a
  // single ✨) retries. Session-only (not persisted) so a reload always re-tries.
  const enrichFailed = new Set();

  // (dev0517) Auto-enrich driver — semi-auto batched enrich with per-Proton-location
  // wall tracking. Browser JS can't switch the VPN, so YOU click the city you're on;
  // the driver enriches N at a time, and when an exit walls it pauses, tallies a wall
  // against that city (sinking it to the bottom of the list), and resumes when you
  // click the next city. Enrich rides the proxy's current exit IP; the browser↔proxy
  // link is loopback so it's unaffected by the VPN switch. State persists in localStorage.
  const AUTO_KEY = 'slam-ig-autoenrich';
  const AUTO_DEFAULT_CITIES = ['Reykjavik', 'Tallinn', 'Riga', 'Vilnius', 'Ljubljana',
    'Bratislava', 'Zagreb', 'Luxembourg', 'Valletta', 'Nicosia', 'Sofia', 'Bucharest',
    'Chisinau', 'Tbilisi', 'Skopje'];
  let autoLocs = [];            // [{name, walled}] — the Proton exits + their enrich-wall tally
  let autoActive = null;        // name of the city the user marked as currently in use
  let autoLoaded = false;       // localStorage read once
  let autoRunning = false;      // loop active (may be paused)
  let autoPaused = false;       // paused: walled / no-progress / by user
  let autoBatchSize = 18;       // rows per enrich batch
  let autoGapMs = 4000;         // breather between clean batches
  const autoDead = new Set();   // rows that walled while the exit was otherwise fine → skip

  // STRONG, unambiguous IG throttle signatures. If a batch item fails with one of
  // these we stop the whole batch so we don't keep hammering a real throttle.
  // (dev0440) Deliberately NO bare "rate-limit" match: yt-dlp's cookieless wall
  // error is "…rate-limit reached or login required…" — that's a LOGIN WALL (enrich
  // is cookieless, so walled posts always fail that way), NOT an IP throttle. The
  // bare match was firing on every walled post and aborting the whole enrich batch
  // even though downloads (which fall back to cookies) were fine. isThrottle() also
  // excludes anything that mentions "login required".
  const RATE_LIMIT_RE = /\b429\b|too many requests|please wait a few|temporarily (locked|blocked|unavailable)|checkpoint_required|challenge_required|try again later/i;
  const isThrottle = err => !!err && RATE_LIMIT_RE.test(err) && !/login\s*required/i.test(err);
  // (dev0458) A LOGIN-WALL signature (post needs auth — both cookieless and the
  // Firefox-cookie retry came back empty). Distinct from isThrottle (an IP-level
  // 429). Covers enrich ("login required / content is not available / empty
  // metadata") and download ("…rate-limit reached or login required…").
  // (dev0470) Also match yt-dlp's "There is no video in this post" — a /p IMAGE post
  // whose embed fallback ALSO failed surfaces THAT (now the proxy normalizes it to a
  // "login required" wall message, but match both in case the proxy isn't restarted).
  // This string is wall-class ONLY because the proxy always tries the embed page
  // first, so it never reaches the client on a post we could actually read.
  // (dev0496) yt-dlp CHANGED its IG login-wall wording → "Instagram sent an empty media
  // response … use --cookies-from-browser … for the authentication". None of the old
  // phrases were in it, so isWall() returned false → WALL_CAP=1 never tripped and a
  // walled reel batch ran past the first wall until the user hit Stop (the reported
  // bug). Added the new signatures. isThrottle is still checked first (429s win), and
  // this message carries no 429 text, so a wall is classified as a wall.
  const WALL_RE = /login\s*required|login[-\s]?wall|content is not available|empty metadata|empty media response|rate-limit reached|no video in this post|walled this post|cookies-from-browser|for the authentication/i;
  const isWall = err => WALL_RE.test(err || '');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const ENRICH_GAP = [1200, 3000];     // ms between batch enrich items (cookieless)
  const DOWNLOAD_GAP = [2500, 6000];   // ms between batch downloads (heavier, may use cookies)
  const ROTATE_CHUNK = 18;             // (dev0649) downloads per Proton exit before auto-switching
  // (dev0444) Account-safety guard: auto-stop a batch once this many items have had
  // to fall back to Firefox cookies (i.e. login-walled posts fetched AS your logged-in
  // account). Cookieless work is unlimited and account-safe; only the authenticated
  // path is capped. Per-batch — a fresh run resets the count, so also keep total
  // daily cookie use modest. Bump this one number to loosen/tighten the guard.
  // (dev0455) Tightened 5→1 per request: stop enrich/download the moment a single
  // Firefox-cookie fallback happens (the one cookie item finishes, then the batch halts).
  const COOKIE_CAP = 1;
  // (dev0458) Companion guard, per request: also stop the batch at the first
  // LOGIN-WALLED result (cookieless AND the cookie retry both failed). Combined with
  // COOKIE_CAP=1 this means the run halts the instant it leaves cookieless territory —
  // one authenticated request at most per run. Re-run to step past a wall.
  const WALL_CAP = 1;
  // (dev0645) DOWNLOADS get a looser, CONSECUTIVE-failure stop instead of the first-
  // failure abort. The cookieless photo-carousel walker is easily (and transiently) IG-
  // throttled, so one blocked item shouldn't kill the whole run. A single in-item retry
  // (see runBatch) heals most transient throttles; if downloads fail this many times IN
  // A ROW (no success between), it's a real block → stop. A success resets the streak.
  const DOWNLOAD_WALL_CAP = 2;
  const DOWNLOAD_RETRY_MS = [8000, 15000];   // pause before the single per-item retry

  // ── Helpers ────────────────────────────────────────────────────────────────
  const esc = s => String(s == null ? '' : s).replace(/[<>&"]/g,
    c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  // (dev0474) ftext/ttxt are HTML — flatten to readable plain text for a hover
  // tooltip (the native title= attribute). Strips tags, decodes entities,
  // collapses whitespace; capped so the OS tooltip stays usable.
  function htmlToText(html) {
    if (!html) return '';
    const d = document.createElement('div');
    d.innerHTML = String(html);
    const t = (d.textContent || '').replace(/\s+/g, ' ').trim();
    return t.length > 1500 ? t.slice(0, 1500) + '…' : t;
  }
  const kindOf = r => /\/reel\//i.test(r.url || '') ? 'reel'
                   : /\/p\//i.test(r.url || '') ? 'p'
                   : /\/tv\//i.test(r.url || '') ? 'tv' : '?';
  // (dev0472) Always link the BARE /p/<id>/ permalink, NOT r.url (which may be the
  // username-scoped /author/reel/<id>/ form). The bare /p/ permalink is the one that
  // opens IG's grid modal WITH the ◀▶ arrows so the user can keep arrowing the feed;
  // /author/reel/ opens the arrow-less reels player. r.url is still used for
  // enrich/download. (kindOf still reads r.url, so the kind filter is unaffected.)
  const igLink = r => 'https://www.instagram.com/p/' + r.id + '/';
  // (dev0635) Instagram URL → shortcode / author, for the 'w' clipboard-add path.
  // Mirrors ig-harvest.user.js shortcode(): handles the bare /p/<id>/ and the
  // username-scoped /<author>/reel/<id>/ forms, ignores any ?query (e.g. ?img_index=1).
  function _igShortcodeFromUrl(u) {
    const m = String(u || '').match(/instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/i);
    return m ? m[1] : '';
  }
  function _igAuthorFromUrl(u) {
    // Only the author-scoped form (.../<author>/reel/<id>/) carries the handle in the
    // URL; the bare /p/<id>/ form has none (Enrich fills VidAuthor+author from yt-dlp).
    const m = String(u || '').match(/instagram\.com\/([A-Za-z0-9_.]+)\/(?:reels?|p|tv)\//i);
    return m ? m[1] : '';
  }
  const pad2 = n => String(n).padStart(2, '0');

  // hh.mm.ss (AHK FormatHMS — used in the download filename).
  function fmtHMS(sec) {
    sec = Math.round(+sec || 0);
    return pad2(Math.floor(sec / 3600)) + '.' + pad2(Math.floor((sec % 3600) / 60)) + '.' + pad2(sec % 60);
  }
  // m:ss / h:mm:ss for the on-screen Duration column.
  function fmtDur(sec) {
    sec = Math.round(+sec || 0);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? (h + ':' + pad2(m) + ':' + pad2(s)) : (m + ':' + pad2(s));
  }
  // yt-dlp upload_date "YYYYMMDD" (or unix timestamp) → "YYYY-MM-DD".
  function datePosted(meta) {
    const ud = (meta.upload_date || '').trim();
    if (/^\d{8}$/.test(ud)) return ud.slice(0, 4) + '-' + ud.slice(4, 6) + '-' + ud.slice(6, 8);
    if (Number.isFinite(meta.timestamp)) return new Date(meta.timestamp * 1000).toISOString().slice(0, 10);
    return '';
  }
  // Mirror of AHK SanitizeFilePart (keeps ~ [ ] @ — all legal on Windows).
  function sanitizePart(s) {
    s = String(s || '').replace(/[<>":\/\\|?*\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '');
    return s || 'unknown';
  }
  // hh.mm.ss~WxH~Title~@author~[[i[id]]]  (one W×H = max; the redundant [M[…]] of
  // the old convention dropped per "only need one w×h").
  function downloadName(r) {
    const dur = fmtHMS(r.durSecs);
    const res = (r.width && r.height) ? (r.width + 'x' + r.height) : '0x0';
    const title = sanitizePart((typeof _normalizeText === 'function'
      ? _normalizeText(r.VidTitle || '') : (r.VidTitle || '')).replace(/\s+/g, ' ')).slice(0, 80);
    const chan = (r.VidAuthor || ('@' + r.author)).replace(/^@+/, '');
    return dur + '~' + res + '~' + sanitizePart(title) + '~@' + sanitizePart(chan) + '~[[i[' + r.id + ']]]';
  }

  // (dev0437) Centered toast that renders ABOVE the I overlay. The global `toast`
  // sits at z-index 9999 — BEHIND #igOverlay (29500) — so it was invisible here;
  // this one lives inside the overlay's stacking context, screen-centered, and
  // never touches document flow (no header shift). Multi-line via \n.
  function igToast(msg, ms) {
    let t = document.getElementById('igToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'igToast';
      (document.getElementById('igOverlay') || document.body).appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._tid);
    t._tid = setTimeout(() => t.classList.remove('show'), ms || 2200);
    if (typeof console !== 'undefined') console.log('[ig]', msg);
  }

  // (dev0437) Sticky centered status panel for batch ops — live progress + its
  // OWN Stop button, so harvesting/downloading no longer writes into the top bar
  // (which shifted the column headers down). Shown for the duration of a batch.
  function igBatchShow(msg) {
    let t = document.getElementById('igBatch');
    if (!t) {
      t = document.createElement('div');
      t.id = 'igBatch';
      t.innerHTML = '<div class="msg"></div><button class="stop">⏹ Stop</button>';
      (document.getElementById('igOverlay') || document.body).appendChild(t);
      t.querySelector('.stop').addEventListener('click', () => {
        batchAbort = true;
        t.querySelector('.stop').textContent = '⏹ Stopping…';
      });
    }
    t.querySelector('.msg').textContent = msg;
    t.querySelector('.stop').textContent = '⏹ Stop';
    t.classList.add('show');
    // (dev0496) Focus Stop so Space/Enter halt the batch without aiming the mouse.
    try { t.querySelector('.stop').focus(); } catch (_) {}
  }
  function igBatchUpdate(msg) {
    const t = document.getElementById('igBatch');
    if (t) t.querySelector('.msg').textContent = msg;
  }
  function igBatchHide() {
    const t = document.getElementById('igBatch');
    if (t) t.classList.remove('show');
  }

  // (dev0444) Persistent end-of-run summary panel. Unlike igToast (auto-dismiss on a
  // timer) and igBatch (hidden the moment a batch ends), this STAYS until the user
  // dismisses it via its Close button or Esc — so the final cookie / done counts
  // don't vanish before they're read.
  function igStickyShow(msg) {
    let t = document.getElementById('igSticky');
    if (!t) {
      t = document.createElement('div');
      t.id = 'igSticky';
      t.innerHTML = '<div class="msg"></div><button class="ok">Close (Esc)</button>';
      (document.getElementById('igOverlay') || document.body).appendChild(t);
      t.querySelector('.ok').addEventListener('click', igStickyHide);
    }
    t.querySelector('.msg').textContent = msg;
    t.classList.add('show');
    // (dev0496) Focus Close so Space/Enter dismiss the summary.
    try { t.querySelector('.ok').focus(); } catch (_) {}
  }
  function igStickyHide() {
    document.getElementById('igSticky')?.classList.remove('show');
  }
  function igStickyOpen() {
    return document.getElementById('igSticky')?.classList.contains('show') || false;
  }

  // ══ Proton VPN exit pill + rotation (dev0649) ═══════════════════════════════
  // The pill (bottom-left of the bar) is the "am I actually on a VPN?" answer the
  // user wanted: it polls the proxy's /vpn/status (which reads what vpn-rotate.ps1
  // wrote) while the screen is open. batchDownloadRotating() then downloads in
  // chunks of ROTATE_CHUNK and calls /vpn/switch between chunks, updating the pill.
  let vpnStatus = null;          // last { tunnelUp, server, ip, city, country, at }
  let vpnPollTimer = null;
  let vpnBusy = false;           // a switch is in flight → pill shows a pulse

  function vpnRenderPill() {
    const el = document.getElementById('igVpn');
    if (!el) return;
    const dot = el.querySelector('.dot'), txt = el.querySelector('.txt');
    el.classList.toggle('busy', vpnBusy);
    if (vpnBusy) { el.classList.remove('up', 'down'); txt.textContent = 'VPN switching…'; return; }
    if (!vpnStatus) { el.classList.remove('up', 'down'); txt.textContent = 'VPN ?'; el.title = 'VPN status unavailable — is the proxy (127.0.0.1:8081) running the dev0649 build?'; return; }
    const s = vpnStatus;
    el.classList.toggle('up', !!s.tunnelUp);
    el.classList.toggle('down', !s.tunnelUp);
    const place = [s.city, s.country].filter(Boolean).join(', ');
    const label = s.server ? s.server.replace(/^US-?/i, 'US ') : (s.ip || 'unknown');
    txt.textContent = (s.tunnelUp ? 'VPN ' : 'VPN OFF ') + label + (s.ip ? '  ' + s.ip : '');
    el.title = (s.tunnelUp ? 'Proton VPN tunnel UP' : '⚠ No Proton tunnel detected — traffic is going out your real IP!')
      + (s.server ? '\nServer: ' + s.server : '')
      + (s.ip ? '\nExit IP: ' + s.ip : '')
      + (place ? '\nLocation: ' + place : '')
      + (s.at ? '\nSwitched: ' + new Date(s.at).toLocaleString() : '')
      + '\n(click to refresh)';
  }

  async function vpnRefresh(toast) {
    try {
      const r = await fetch(PROXY + '/vpn/status', { cache: 'no-store' });
      const j = await r.json();
      if (j && j.ok) vpnStatus = j;
    } catch (_) { vpnStatus = null; }
    vpnRenderPill();
    if (toast) {
      const s = vpnStatus;
      igToast(s
        ? (s.tunnelUp
            ? '🟢 Proton VPN UP\nServer: ' + (s.server || '?') + '\nExit IP: ' + (s.ip || '?')
              + ([s.city, s.country].filter(Boolean).length ? '\n' + [s.city, s.country].filter(Boolean).join(', ') : '')
            : '🔴 No Proton tunnel detected — your real IP is exposed.\nSwitch on the VPN, then click the pill again.')
        : '⚠ Could not read VPN status.\nIs the proxy running the dev0649 build?', 4200);
    }
  }

  function vpnStartPoll() { if (!vpnPollTimer) vpnPollTimer = setInterval(() => { if (isIgScreenOpen()) vpnRefresh(false); }, 12000); }
  function vpnStopPoll()  { if (vpnPollTimer) { clearInterval(vpnPollTimer); vpnPollTimer = null; } }

  // Fire a switch and wait for the proxy to confirm the new exit. Returns the new
  // status (or null on failure). Shows progress in the shared batch panel.
  async function vpnSwitchNow(note) {
    vpnBusy = true; vpnRenderPill();
    igBatchUpdate((note ? note + '\n' : '') + '🔀 switching Proton VPN to a fresh US exit…');
    let out = null;
    try {
      const r = await fetch(PROXY + '/vpn/switch', { method: 'POST' });
      const j = await r.json();
      if (j && j.ok) { out = j; vpnStatus = j; }
    } catch (_) {}
    vpnBusy = false; vpnRenderPill();
    return out;
  }

  // (dev0651) Switch until we land on a WORKING exit (proxy confirms tunnelUp).
  // Each attempt stages a fresh server, and the .ps1 only reports success once the
  // public IP has actually changed off the home baseline — so a dead server is
  // skipped, never silently accepted. Returns the working status, or null.
  async function vpnEnsureUp(note, tries) {
    tries = tries || 3;
    let sw = await vpnSwitchNow(note);
    let n = 1;
    while ((!sw || !sw.tunnelUp) && n < tries && !batchAbort) {
      igToast(`⚠ that exit didn't route — trying another Proton server (${n + 1}/${tries})…`, 2800);
      sw = await vpnSwitchNow(note + ' (retry ' + (n + 1) + ')');
      n++;
    }
    return (sw && sw.tunnelUp) ? sw : null;
  }

  // ── CSS (scoped under #igOverlay, injected once) ────────────────────────────
  function injectCss() {
    if (document.getElementById('ig-css')) return;
    const s = document.createElement('style');
    s.id = 'ig-css';
    s.textContent = `
#igOverlay{position:fixed;inset:0;z-index:29500;display:none;flex-direction:column;
  background:#11151c;color:#dfe6ee;font:13px/1.4 system-ui,Segoe UI,sans-serif}
#igOverlay.open{display:flex}
#igBar{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#0c0f14;
  border-bottom:1px solid #232b36;flex:0 0 auto;flex-wrap:wrap}
#igBar h2{margin:0;font-size:15px;font-weight:700;color:#9ad}
/* (dev0455) Record-count readout: as bold/visible as the title. The leading
   "N shown" is the prominent white number; the breakdown after the · is dimmer. */
#igBar .ct{color:#fff;font-size:15px;font-weight:700;white-space:nowrap}
#igBar .ct .sub{color:#9aa7b4;font-size:12px;font-weight:600}
#igBar input[type=text]{background:#1a212b;border:1px solid #2c3645;color:#dfe6ee;
  border-radius:6px;padding:5px 8px;width:200px;font:13px system-ui}
#igBar select{background:#1a212b;border:1px solid #2c3645;color:#dfe6ee;border-radius:6px;padding:4px 6px}
#igBar button{background:#1f2733;border:1px solid #34404f;color:#cfe;border-radius:6px;
  padding:5px 10px;cursor:pointer;font:600 12px system-ui}
#igBar button:hover{background:#27313f}
#igBar button.primary{background:#0a84ff;border-color:#0a84ff;color:#fff}
#igBar button:disabled{opacity:.5;cursor:default}
#igBar .spacer{flex:1}
/* (dev0496) Action buttons live in their own right-anchored group so a changing
   record-count / selection width never reflows them. margin-left:auto pins the
   whole group to the right; it wraps as a unit on narrow windows. */
#igBar .igActs{display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  justify-content:flex-end;margin-left:auto}
#igBar #igClose{font-size:18px;padding:2px 10px;line-height:1}
#igWrap{flex:1;overflow:auto;position:relative}
#igTable{border-collapse:collapse;width:100%;table-layout:fixed}
#igTable th{position:sticky;top:0;background:#171d26;border-bottom:1px solid #2c3645;
  padding:6px 8px;text-align:left;font-weight:600;color:#9fb0c2;user-select:none;z-index:2}
#igTable th.sortable{cursor:pointer}
#igTable th.sortable:hover{color:#cfe}
#igTable th .arrow{color:#0a84ff;font-size:11px}
#igTable td{padding:5px 8px;border-bottom:1px solid #1d242e;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}
#igTable tr:hover td{background:#161d27}
#igTable tr.focus td{background:#1d2a3a}
#igTable tr.st-enriched td{box-shadow:inset 3px 0 0 #4caf50}
#igTable tr.st-downloaded td{box-shadow:inset 3px 0 0 #ffb300}
#igTable tr.st-promoted td{box-shadow:inset 3px 0 0 #0a84ff;opacity:.72}
#igTable tr.proc td{background:#13314e;box-shadow:inset 3px 0 0 #0a84ff;opacity:1}
#igTable .badge{display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:700}
.k-reel{background:#3a2a52;color:#caa6ff}.k-p{background:#1e3a4a;color:#7fd0ee}.k-tv{background:#4a2a2a;color:#eeae7f}.k-q{background:#333;color:#aaa}
.s-new{color:#7d8794}.s-enriched{color:#7fd47f}.s-downloaded{color:#ffc04d}.s-promoted{color:#6fb6ff}
#igTable a.idlink{color:#7fb8ff;text-decoration:none}
#igTable a.idlink:hover{text-decoration:underline}
#igTable .yes{color:#7fd47f;font-weight:700}.no{color:#4a5563}
#igTable .walled{color:#d59a3a;cursor:help}
img.igcover{max-width:100%;max-height:240px;border-radius:6px;display:block;background:#0c1118}
#igCoverOnly.on{background:#2e7d32;color:#eaffea;border-color:#43a047;font-weight:700}
/* (dev0649) Proton VPN exit pill + rotating-download button. The pill is always
   visible in the bar so the current exit (and that a VPN is even ON) is never a
   mystery; green = tunnel up, red = no tunnel, grey = unknown/proxy down. */
#igVpn{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;
  padding:3px 9px;border-radius:999px;font:600 12px system-ui;cursor:pointer;
  border:1px solid #34404f;background:#161d27;color:#9aa7b4}
#igVpn .dot{width:8px;height:8px;border-radius:50%;background:#4a5563;flex:0 0 auto}
#igVpn.up{background:#0f2a17;border-color:#2e7d32;color:#c6f0cd}
#igVpn.up .dot{background:#43d16a;box-shadow:0 0 6px #43d16a}
#igVpn.down{background:#2a1010;border-color:#7d322e;color:#f0c4c4}
#igVpn.down .dot{background:#ff5a4d}
#igVpn.busy{opacity:.7}
#igVpn.busy .dot{animation:igVpnPulse 1s ease-in-out infinite}
@keyframes igVpnPulse{0%,100%{opacity:.35}50%{opacity:1}}
#igRotate.on{background:#0a84ff;border-color:#0a84ff;color:#fff}
#igToast{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) scale(.96);
  background:#10151d;color:#eaf1f8;border:1px solid #34404f;border-radius:12px;
  padding:16px 26px;font:14px/1.5 system-ui,Segoe UI,sans-serif;text-align:center;
  white-space:pre-line;max-width:560px;box-shadow:0 14px 50px rgba(0,0,0,.65);
  z-index:40000;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s}
#igToast.show{opacity:1;transform:translate(-50%,-50%) scale(1)}
#igBatch{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
  background:#10151d;color:#eaf1f8;border:1px solid #34404f;border-radius:14px;
  padding:20px 28px;min-width:320px;max-width:560px;text-align:center;
  box-shadow:0 16px 56px rgba(0,0,0,.7);z-index:40001;display:none;pointer-events:none}
#igBatch.show{display:block}
#igBatch .msg{font:14px/1.55 system-ui,Segoe UI,sans-serif;white-space:pre-line;margin-bottom:14px}
#igBatch .stop{pointer-events:auto;background:#7a2230;border:1px solid #b3344a;color:#fff;
  border-radius:8px;padding:8px 20px;cursor:pointer;font:600 13px system-ui}
#igBatch .stop:hover{background:#933049}
#igSticky{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
  background:#10151d;color:#eaf1f8;border:1px solid #34404f;border-radius:14px;
  padding:22px 30px;min-width:340px;max-width:560px;text-align:center;
  box-shadow:0 16px 56px rgba(0,0,0,.72);z-index:40002;display:none}
#igSticky.show{display:block}
#igSticky .msg{font:14px/1.7 system-ui,Segoe UI,sans-serif;white-space:pre-line;margin-bottom:16px}
#igSticky .ok{background:#1f5130;border:1px solid #2e7d46;color:#eafff0;
  border-radius:8px;padding:8px 22px;cursor:pointer;font:600 13px system-ui}
#igSticky .ok:hover{background:#27663c}
#igTable .mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#9fb0c2}
#igTable td.c-act{white-space:nowrap}
#igTable td.c-act button{background:#1f2733;border:1px solid #34404f;color:#cfe;
  border-radius:5px;padding:3px 7px;margin-right:3px;cursor:pointer;font:600 11px system-ui}
#igTable td.c-act button:hover{background:#2b3543}
#igTable td.c-act button:disabled{opacity:.4;cursor:default}
/* (dev0498) position:fixed (was absolute, which scrolled WITH the table content so
   the info panel slid out of view for lower rows). Fixed pins it to the viewport;
   its top is set in openDrawer to the table's top edge so it sits under the bar. */
#igDrawer{position:fixed;top:0;right:0;bottom:0;width:400px;background:#0e1219;
  border-left:1px solid #2c3645;box-shadow:-6px 0 18px rgba(0,0,0,.4);overflow:auto;
  padding:14px;display:none;z-index:5}
#igDrawer.open{display:block}
#igDrawer h3{margin:0 26px 8px 0;font-size:14px;color:#9ad;white-space:normal}
#igDrawer .meta{color:#8aa;font-size:12px;margin-bottom:8px;word-break:break-all}
#igDrawer .kv{display:grid;grid-template-columns:84px 1fr;gap:2px 8px;margin:8px 0;font-size:12px}
#igDrawer .kv b{color:#7d8794;font-weight:600}
#igDrawer .sect{margin:10px 0;border-top:1px solid #1d242e;padding-top:8px}
#igDrawer .sect b{color:#9fb0c2;display:block;margin-bottom:4px;font-size:12px}
#igDrawer .fname{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#bfe;
  background:#11161e;border:1px solid #2c3645;border-radius:6px;padding:7px;word-break:break-all;user-select:all}
#igDrawer .ftext{background:#11161e;border:1px solid #1d242e;border-radius:6px;padding:8px;
  max-height:220px;overflow:auto;font-size:12px;white-space:normal}
#igDrawer .ttxt{background:#11161e;border:1px solid #1d242e;border-radius:6px;padding:8px;
  max-height:200px;overflow:auto;font-size:11px;white-space:normal;color:#9aa}
#igDrawer .acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
#igDrawer .acts button{flex:1 1 auto;background:#1f2733;border:1px solid #34404f;color:#cfe;
  border-radius:6px;padding:7px;cursor:pointer;font:600 12px system-ui;min-width:90px}
#igDrawer .acts button.primary{background:#0a84ff;border-color:#0a84ff;color:#fff}
#igDrawer #igDrawerClose{position:absolute;top:8px;right:10px;background:none;border:0;
  color:#9aa;font-size:20px;cursor:pointer}
#igEmpty{padding:40px;text-align:center;color:#7d8794}
#igModalBack{position:absolute;inset:0;background:rgba(0,0,0,.55);display:none;z-index:10;
  align-items:center;justify-content:center}
#igModalBack.open{display:flex}
#igModal{width:min(680px,90%);max-height:80%;display:flex;flex-direction:column;
  background:#141a22;border:1px solid #2c3645;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.6);padding:14px}
#igModal h3{margin:0 0 4px;font-size:14px;color:#9ad}
#igModal .hint{color:#7d8794;font-size:12px;margin-bottom:8px}
#igModal textarea{flex:1;min-height:220px;background:#0c1016;border:1px solid #2c3645;color:#dfe6ee;
  border-radius:6px;padding:8px;font:12px ui-monospace,Consolas,monospace;resize:vertical}
#igModal .row{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
#igModal button{background:#1f2733;border:1px solid #34404f;color:#cfe;border-radius:6px;
  padding:7px 14px;cursor:pointer;font:600 12px system-ui}
#igModal button.primary{background:#0a84ff;border-color:#0a84ff;color:#fff}
/* (dev0500) Moveable PORTRAIT media-preview window — plays the focused row's
   downloaded ig_media asset. Same idea/size as the T-screen row-preview pane
   (core.js) but portrait (IG = 9:16). Drag it by its title bar. z above the
   table/drawer, below the toasts (40000+). */
#igPreview{position:fixed;width:320px;z-index:100;background:#000;border:1px solid #4df;
  border-radius:8px;box-shadow:0 10px 40px rgba(0,0,0,.78);overflow:hidden;
  display:flex;flex-direction:column}
#igPvBar{display:flex;align-items:center;gap:6px;padding:4px 6px;background:#0a1426;
  border-bottom:1px solid #1a2a4a;cursor:move;user-select:none;flex:0 0 auto;touch-action:none}
#igPvNav{display:flex;align-items:center;gap:2px}
#igPvNav button{background:#1f2733;border:1px solid #34404f;color:#cfe;border-radius:4px;
  padding:0 7px;font-size:14px;line-height:1.7;cursor:pointer}
#igPvNav button:hover{background:#2b3543}
#igPvNav .ct{font:11px ui-monospace,Consolas,monospace;color:#9fb0c2;padding:0 2px}
#igPvTitle{flex:1;font:12px system-ui;color:#bcd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#igPvClose{background:none;border:0;color:#9aa;font-size:18px;line-height:1;cursor:pointer;padding:0 4px}
#igPvClose:hover{color:#fff}
#igPvBody{position:relative;width:320px;height:470px;background:#000;flex:0 0 auto;
  display:flex;align-items:center;justify-content:center;overflow:hidden}
#igPvBody video,#igPvBody img{display:block;width:100%;height:100%;object-fit:contain;background:#000}
#igPvBody .igPvPlace{color:#8a96a3;font:13px/1.5 system-ui;text-align:center;padding:24px}
#igPvBody .igPvPlace span{color:#5a6573;font-size:11px}
/* (dev0517) Auto-enrich panel — floating, top-right under the toolbar. */
#igAuto{position:fixed;top:64px;right:14px;width:300px;max-height:calc(100vh - 90px);z-index:120;
  background:#0e1219;border:1px solid #2c3645;border-radius:9px;box-shadow:0 12px 44px rgba(0,0,0,.7);
  display:none;flex-direction:column;overflow:hidden;font:13px system-ui;color:#dfe6ee}
#igAuto.open{display:flex}
#igAutoBar{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#0a1426;border-bottom:1px solid #1a2a4a}
#igAutoBar b{font-size:14px}
#igAutoState{margin-left:auto;font:11px ui-monospace,Consolas,monospace;padding:2px 7px;border-radius:10px;background:#1f2733;color:#9fb0c2}
#igAutoState.st-running{background:#12351f;color:#7fe0a0}
#igAutoState.st-paused{background:#3a2f12;color:#e6c268}
#igAutoHide{background:none;border:0;color:#9aa;font-size:18px;line-height:1;cursor:pointer;padding:0 2px}
#igAutoHide:hover{color:#fff}
#igAutoCtl{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid #1a2333}
#igAutoCtl button{background:#1f2733;border:1px solid #34404f;color:#cfe;border-radius:5px;padding:4px 8px;cursor:pointer;font:600 12px system-ui}
#igAutoCtl button:hover:not(:disabled){background:#2b3543}
#igAutoCtl button:disabled{opacity:.45;cursor:default}
#igAutoCtl label{font-size:12px;color:#9fb0c2;display:flex;align-items:center;gap:4px}
#igAutoCtl input{width:44px;background:#0c1016;border:1px solid #2c3645;color:#dfe6ee;border-radius:4px;padding:2px 4px}
#igAutoInfo{padding:7px 10px;font-size:12px;color:#b9c4d0;border-bottom:1px solid #1a2333}
#igAutoInfo .warn{color:#e6a24a}
#igAuto .hd{padding:7px 10px 3px;font-size:11px;color:#8a96a3;text-transform:uppercase;letter-spacing:.03em}
#igAuto .hd span{text-transform:none;letter-spacing:0;color:#5a6573}
#igAutoLocs{overflow:auto;padding:2px 8px 6px;flex:1 1 auto}
#igAutoLocs .loc{display:flex;align-items:center;gap:6px;padding:5px 7px;margin:2px 0;border-radius:6px;
  background:#141b26;border:1px solid #1e2836;cursor:pointer}
#igAutoLocs .loc:hover{background:#1a2432}
#igAutoLocs .loc.active{border-color:#4a7fe0;background:#16233b}
#igAutoLocs .loc.walled{opacity:.72}
#igAutoLocs .loc .nm{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#igAutoLocs .loc .w{font:11px ui-monospace,Consolas,monospace;color:#8a96a3}
#igAutoLocs .loc.walled .w{color:#d98a6a}
#igAutoLocs .loc .rm{background:none;border:0;color:#5a6573;font-size:15px;line-height:1;cursor:pointer;padding:0 2px}
#igAutoLocs .loc .rm:hover{color:#e06a6a}
#igAutoAdd{display:flex;gap:6px;padding:8px 10px;border-top:1px solid #1a2333}
#igAutoAdd input{flex:1;min-width:0;background:#0c1016;border:1px solid #2c3645;color:#dfe6ee;border-radius:5px;padding:4px 7px}
#igAutoAdd button{background:#1f2733;border:1px solid #34404f;color:#cfe;border-radius:5px;padding:4px 8px;cursor:pointer;font:600 12px system-ui;white-space:nowrap}
#igAutoAdd button:hover{background:#2b3543}
`;
    document.head.appendChild(s);
  }

  // ── DOM scaffold ────────────────────────────────────────────────────────────
  function build() {
    injectCss();
    if (!autoLoaded) { loadAuto(); autoLoaded = true; }   // (dev0517) restore exits + wall counts
    if (document.getElementById('igOverlay')) return;
    const o = document.createElement('div');
    o.id = 'igOverlay';
    o.innerHTML = `
      <div id="igBar">
        <h2>I · Ig staging</h2>
        <span class="ct" id="igCount"></span>
        <span id="igVpn" title="Current Proton VPN exit — click to refresh"><span class="dot"></span><span class="txt">VPN …</span></span>
        <input type="text" id="igSearch" placeholder="search author / id / title / caption…">
        <select id="igAuthor" title="Filter by author"><option value="all">all authors</option></select>
        <select id="igKind"><option value="all">all kinds</option><option value="reel">reels</option><option value="p">posts /p</option><option value="tv">tv</option></select>
        <select id="igStatus"><option value="all">all status (A)</option><option value="new">new (N)</option><option value="enriched">enriched (E)</option><option value="downloaded">downloaded (D)</option><option value="promoted">promoted</option></select>
        <select id="igStaged" title="Harvested (full reels) vs Unharvested (single posts — 'w'-added clipboard links or ffdown imports)"><option value="all">all sources</option><option value="non">Unharvested (singles)</option><option value="full">Harvested (full reels)</option></select>
        <div class="igActs">
        <button id="igPaste" title="Paste a Firefox 'Save Page As Text' of a reel → fills that row's ttxt/caption">📋 Paste saved-text</button>
        <button id="igAddSingle" title="Add the single Instagram post/reel URL on the clipboard as a new Unharvested row (hotkey w) — status 'new', ready to Enrich/Download. For grabbing individual posts from authors you don't want to fully harvest.">➕ Add single (w)</button>
        <button id="igFfdown" title="Bulk-import every ffdown/*.txt saved IG page → ig.json (author caption only, marked Unharvested, DevComment from the filename)">📁 Import ffdown</button>
        <button id="igEnrichSel" title="Enrich selected (hotkey E)">✨ Enrich sel</button>
        <button id="igAutoEnrich" title="Auto-enrich driver (hotkey A) — enriches N at a time and tracks per-Proton-location walls so you can grind the whole backlog by switching exits">🤖 Auto-enrich</button>
        <button id="igDownloadSel" title="Download selected (hotkey D)">⬇ Download sel</button>
        <button id="igCoverOnly" title="Toggle download mode. ON = grab only the index-1 cover (no carousel) — for authors whose page-1 is the keeper. OFF = normal full download. Both are cookieless — your IG login is never used either way.">📸 Cover-only: off</button>
        <button id="igRotate" title="Grind the ENRICHED backlog in this view: downloads the top 18 enriched-but-not-downloaded rows (no checkboxes needed), then switches the Proton VPN to a fresh US exit and repeats with the next 18. Cookieless. Success toasts report the running total + most recent; stops when no enriched rows remain, a batch downloads nothing, or you press Stop. Filter the view first (e.g. Status → enriched) to control what it grinds.">⬇⟳ Download + rotate VPN</button>
        <button id="igPromoteSel">➕ Promote sel</button>
        <button id="igCreateGrid" title="Build one 12-cell portrait grid (P12) in c.json from the 12 rows starting at the focused row — or from the top of the list if nothing is focused. The cells hold the IG links themselves, so the rows do NOT need promoting to ml.json first.">🔲 Create 12P grid</button>
        <button id="igDeleteSel" title="Permanently remove the selected rows from ig.json (after confirm)">🗑 Delete sel</button>
        <button id="igClearSel" title="Unselect everything, including rows hidden by the current filter (hotkey C)">✕ Clear sel</button>
        <button id="igResetSel" title="Reset selected rows to 'new' (hotkey R) so a fresh Enrich + Download rebuilds them — clears the derived title, W×H, duration, cover and downloaded-file record (caption ftext/ttxt is kept). Use this to re-try after a fix.">↺ Reset sel</button>
        <button id="igReload" title="Reload ig.json from disk">↻ Reload</button>
        <button id="igSave" class="primary" title="Write edits back to ig.json">💾 Save</button>
        <button id="igClose" title="Close (Esc)">×</button>
        </div>
      </div>
      <div id="igWrap">
        <table id="igTable"><thead></thead><tbody></tbody></table>
        <div id="igEmpty" style="display:none"></div>
        <div id="igDrawer"><button id="igDrawerClose">×</button><div id="igDrawerBody"></div></div>
        <div id="igModalBack"><div id="igModal">
          <h3>Paste Instagram saved-text</h3>
          <div class="hint" id="igModalHint">In Firefox: open the reel → File ▸ Save Page As ▸ Text Files → open that .txt → paste it here. Routes to the row by reel id; comments + sibling URLs land in ttxt.</div>
          <textarea id="igModalText" placeholder="Paste the saved page text…"></textarea>
          <div class="row"><button id="igModalCancel">Cancel</button><button id="igModalApply" class="primary">Apply</button></div>
        </div></div>
      </div>`;
    document.body.appendChild(o);

    const $ = id => o.querySelector('#' + id);
    $('igSearch').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); applyAndRender(); });
    $('igAuthor').addEventListener('change', e => { authorFilter = e.target.value; applyAndRender(); });
    $('igKind').addEventListener('change', e => { kindFilter = e.target.value; applyAndRender(); });
    $('igStatus').addEventListener('change', e => { statusFilter = e.target.value; applyAndRender(); });
    $('igStaged').addEventListener('change', e => { stagedFilter = e.target.value; applyAndRender(); });
    $('igEnrichSel').addEventListener('click', () => batchEnrich());
    $('igAutoEnrich').addEventListener('click', () => toggleAutoPanel());
    $('igDownloadSel').addEventListener('click', () => batchDownload());
    $('igRotate').addEventListener('click', () => batchDownloadRotating());
    $('igVpn').addEventListener('click', () => vpnRefresh(true));
    $('igCoverOnly').addEventListener('click', () => {
      coverOnly = !coverOnly;
      const b = $('igCoverOnly');
      b.textContent = '📸 Cover-only: ' + (coverOnly ? 'ON' : 'off');
      b.classList.toggle('on', coverOnly);
      igToast(coverOnly
        ? '📸 Cover-only ON — downloads grab just the index-1 cover, cookielessly\n(no carousel). For authors whose page-1 is the keeper.'
        : '📸 Cover-only off — normal full download, cookieless (your IG login is never used)', 3400);
    });
    $('igPromoteSel').addEventListener('click', () => batchPromote());
    $('igCreateGrid').addEventListener('click', () => createGridFromView());
    $('igDeleteSel').addEventListener('click', () => deleteSelected());
    $('igClearSel').addEventListener('click', () => { sel.clear(); lastCheckedId = null; applyAndRender(); igToast('Selection cleared (all rows, incl. any hidden by the filter)', 1600); });
    $('igResetSel').addEventListener('click', () => resetSelected());
    $('igReload').addEventListener('click', () => loadData());
    $('igSave').addEventListener('click', () => persist(true));
    $('igClose').addEventListener('click', () => closeIgScreen());
    $('igDrawerClose').addEventListener('click', () => closeDrawer());
    $('igPaste').addEventListener('click', () => openPasteModal(null));
    $('igAddSingle').addEventListener('click', () => addUnharvestedFromClipboard());
    $('igFfdown').addEventListener('click', () => importFfdown());
    $('igModalCancel').addEventListener('click', () => closePasteModal());
    $('igModalApply').addEventListener('click', () => applyPaste());
    o.querySelector('#igTable thead').addEventListener('click', onHeadClick);
    o.querySelector('#igTable tbody').addEventListener('click', onBodyClick);
  }

  // ── Columns ─────────────────────────────────────────────────────────────────
  const COLS = [
    { key: '_sel', label: '<input type="checkbox" id="igSelAll">', w: 30, sort: false },
    { key: 'kind', label: 'Kind', w: 50, sort: true },
    { key: 'author', label: 'Author', w: 120, sort: true },
    { key: 'id', label: 'ID', w: 110, sort: true },
    { key: 'VidTitle', label: 'Title', w: 250, sort: true },
    { key: 'durSecs', label: 'Dur', w: 60, sort: true },
    { key: '_wxh', label: 'W×H', w: 80, sort: true },
    { key: 'DatePosted', label: 'Posted', w: 96, sort: true },
    { key: '_cap', label: 'ftext', w: 46, sort: false },
    { key: '_ttxt', label: 'ttxt', w: 46, sort: false },
    { key: 'status', label: 'Status', w: 86, sort: true },
    { key: 'DateAdded', label: 'Harvested', w: 130, sort: true },
    { key: '_act', label: 'Actions', w: 160, sort: false }
  ];

  function renderHead() {
    const thead = document.querySelector('#igTable thead');
    thead.innerHTML = '<tr>' + COLS.map(c => {
      const arrow = (c.sort && c.key === sortCol) ? ` <span class="arrow">${sortDir > 0 ? '▲' : '▼'}</span>` : '';
      return `<th data-col="${c.key}" class="${c.sort ? 'sortable' : ''}" style="width:${c.w}px">${c.label}${arrow}</th>`;
    }).join('') + '</tr>';
    const selAll = thead.querySelector('#igSelAll');
    if (selAll) {
      selAll.checked = view.length > 0 && view.every(r => sel.has(r.id));
      selAll.addEventListener('click', e => {
        e.stopPropagation();
        if (e.target.checked) view.forEach(r => sel.add(r.id));
        else view.forEach(r => sel.delete(r.id));
        renderBody();
      });
    }
  }

  function onHeadClick(e) {
    const th = e.target.closest('th');
    if (!th || !th.classList.contains('sortable')) return;
    const col = th.dataset.col;
    if (sortCol === col) sortDir = -sortDir; else { sortCol = col; sortDir = 1; }
    applyAndRender();
  }

  // ── Filter + sort ───────────────────────────────────────────────────────────
  function applyAndRender() {
    // (dev0635) Class-level author filters. An author is "Unharvested" only while ALL
    // their rows are staged:false (the same rule refreshAuthorOptions groups by), so
    // choosing "Unharvested authors — all" shows every row under that dropdown group
    // (and "Harvested authors — all" the rest). Computed once per render.
    const unharvestedAuthors = (authorFilter === '__unharvested__' || authorFilter === '__harvested__')
      ? unharvestedAuthorSet() : null;
    view = rows.filter(r => {
      if (authorFilter === '__unharvested__') { if (!unharvestedAuthors.has(r.author || '')) return false; }
      else if (authorFilter === '__harvested__') { if (unharvestedAuthors.has(r.author || '')) return false; }
      else if (authorFilter !== 'all' && r.author !== authorFilter) return false;
      if (kindFilter !== 'all' && kindOf(r) !== kindFilter) return false;
      if (statusFilter !== 'all' && (r.status || 'new') !== statusFilter) return false;
      // (dev0472) NonFullReels = ffdown imports (staged===false); Full reels = harvested (everything else)
      if (stagedFilter === 'non' && r.staged !== false) return false;
      if (stagedFilter === 'full' && r.staged === false) return false;
      if (hideCompleted && isDownloaded(r)) return false;   // (dev0438) 'c' = hide completed
      if (query) {
        const hay = (r.author + ' ' + r.id + ' ' + (r.VidTitle || '') + ' ' + (r.ftext || '') + ' ' + (r.status || '')).toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
    const val = (r) => {
      if (sortCol === 'kind') return kindOf(r);
      if (sortCol === 'status') return r.status || 'new';
      if (sortCol === 'durSecs') return +r.durSecs || 0;
      if (sortCol === '_wxh') return (+r.height || 0) * 100000 + (+r.width || 0);
      return (r[sortCol] != null ? r[sortCol] : '');
    };
    view.sort((a, b) => {
      const A = val(a), B = val(b);
      if (A < B) return -sortDir;
      if (A > B) return sortDir;
      return 0;
    });
    // (dev0446) Keep the selection equal to what's actually on screen: drop any
    // checked rows the current filter/search hides. Invisible selections can no
    // longer pile up and get batch-processed — that was the "3 checked but 3547/48
    // marked to do" and wrong-author confusion. Skipped mid-batch so an in-flight
    // run (which already captured its id list) isn't disturbed.
    if (!busy) { const vis = new Set(view.map(r => r.id)); for (const id of [...sel]) if (!vis.has(id)) sel.delete(id); }
    renderHead();
    renderBody();
    updateCount();
  }

  function updateCount() {
    // (dev0455) Every number now describes the CURRENT filtered view, so the readout
    // is always internally consistent with what's on screen — that was the "not always
    // accurate" complaint (the old breakdown counted across ALL rows while "shown"
    // counted the filtered view, so they disagreed whenever a filter was active).
    const st = r => r.status || 'new';
    const vNew       = view.reduce((n, r) => n + (st(r) === 'new' ? 1 : 0), 0);
    const vEnriched  = view.reduce((n, r) => n + (st(r) === 'enriched' ? 1 : 0), 0);
    const vDownload  = view.reduce((n, r) => n + (st(r) === 'downloaded' ? 1 : 0), 0);
    const vPromoted  = view.reduce((n, r) => n + (st(r) === 'promoted' ? 1 : 0), 0);
    // (dev0445) Selected-AND-visible vs total selected, so a selection hidden by the
    // filter can't masquerade (it used to silently get batch-processed).
    const selHere = view.reduce((n, r) => n + (sel.has(r.id) ? 1 : 0), 0);
    const selTxt = sel.size === selHere
      ? `${sel.size} selected`
      : `${selHere} selected here · ${sel.size - selHere} more hidden by filter`;
    const filtered = view.length !== rows.length;
    const el = document.getElementById('igCount');
    if (el) {
      // Prominent white "N shown" (the records-in-filter count); dim breakdown after.
      const sub = [
        filtered ? `of ${rows.length}` : null,
        `new ${vNew}`, `enriched ${vEnriched}`, `downloaded ${vDownload}`, `promoted ${vPromoted}`,
        selTxt,
        dirty ? '⚠ unsaved' : null,
      ].filter(Boolean).join(' · ');
      el.innerHTML = `${view.length} shown <span class="sub">· ${esc(sub)}</span>`;
    }
    const sv = document.getElementById('igSave');
    if (sv) sv.classList.toggle('primary', dirty);
  }

  // ── Body render ─────────────────────────────────────────────────────────────
  function renderBody() {
    const tb = document.querySelector('#igTable tbody');
    const empty = document.getElementById('igEmpty');
    if (!view.length) {
      tb.innerHTML = '';
      empty.style.display = 'block';
      empty.textContent = rows.length ? 'No rows match the filter.' : 'ig.json is empty — harvest some reels first.';
      updateCount();
      return;
    }
    empty.style.display = 'none';
    tb.innerHTML = view.map(r => {
      const k = kindOf(r);
      const st = r.status || 'new';
      const cap = r.ftext ? '<span class="yes">✓</span>' : '<span class="no">—</span>';
      const tt = r.ttxt ? '<span class="yes">✓</span>' : '<span class="no">—</span>';
      // (dev0474) hover the cell → see the actual ftext/ttxt content as a tooltip
      const capTip = r.ftext ? ` title="${esc(htmlToText(r.ftext))}"` : '';
      const ttTip = r.ttxt ? ` title="${esc(htmlToText(r.ttxt))}"` : '';
      const wxh = (r.width && r.height) ? (r.width + '×' + r.height) : '<span class="no">—</span>';
      const dur = r.durSecs ? fmtDur(r.durSecs) : '<span class="no">—</span>';
      return `<tr data-id="${esc(r.id)}" class="st-${st} ${r.id === focusId ? 'focus' : ''} ${r.id === processingId ? 'proc' : ''}">
        <td class="c-sel"><input type="checkbox" class="igchk" ${sel.has(r.id) ? 'checked' : ''}></td>
        <td><span class="badge k-${k}">${k}</span></td>
        <td title="${esc(r.author)}">${esc(r.author)}</td>
        <td><a class="idlink" href="${esc(igLink(r))}" target="_blank" rel="noopener" title="Open on Instagram">${esc(r.id)}</a></td>
        <td title="${esc(r.VidTitle || '')}">${esc(r.VidTitle || '')}</td>
        <td class="mono">${dur}</td>
        <td class="mono">${wxh}</td>
        <td class="mono">${esc(r.DatePosted || '') || '<span class="no">—</span>'}</td>
        <td style="text-align:center;cursor:help"${capTip}>${cap}</td>
        <td style="text-align:center;cursor:help"${ttTip}>${tt}</td>
        <td><span class="s-${st}">${st}</span>${(st === 'new' && enrichFailed.has(r.id)) ? '<span class="walled" title="Cookieless enrich failed this session — login-walled. Try 📋 Saved-text, or grab it from a logged-in Firefox; ↻ Reload to retry bulk enrich."> ⚠</span>' : ''}</td>
        <td class="mono">${esc(r.DateAdded || '')}</td>
        <td class="c-act">
          <button data-act="enrich" title="yt-dlp → title/caption/ttxt/author/date/res">✨</button>
          <button data-act="download" title="Download max-res → ig_media/">⬇</button>
          <button data-act="promote" title="Add to ml.json" ${st === 'promoted' ? 'disabled' : ''}>➕</button>
          <button data-act="detail" title="Details">⋯</button>
        </td>
      </tr>`;
    }).join('');
    renderHead();
    updateCount();
  }

  // ── Body interactions ───────────────────────────────────────────────────────
  function rowById(id) { return rows.find(r => r.id === id); }

  // (dev0445) THE scope rule for every batch op: act only on rows that are BOTH
  // checkbox-selected AND visible in the current filtered view, in view order. A
  // selection made under one filter (or a "select-all" with no filter) must NOT
  // act on rows you can't see — that bug downloaded other authors and made the
  // toast read "3547 marked to do" when only a few were checked on screen.
  const selectedInView = () => view.filter(r => sel.has(r.id)).map(r => r.id);

  function onBodyClick(e) {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const r = rowById(tr.dataset.id);
    if (!r) return;
    if (e.target.classList.contains('igchk')) {
      // Shift-click = select the contiguous range (in current view order) from the
      // last-clicked checkbox to this one — the easy way to grab many rows at once.
      if (e.shiftKey && lastCheckedId) {
        const ids = view.map(x => x.id);
        let i = ids.indexOf(lastCheckedId), j = ids.indexOf(r.id);
        if (i >= 0 && j >= 0) {
          if (i > j) { const t = i; i = j; j = t; }
          const on = e.target.checked;
          for (let k = i; k <= j; k++) { if (on) sel.add(ids[k]); else sel.delete(ids[k]); }
          renderBody();
          lastCheckedId = r.id;
          return;
        }
      }
      if (e.target.checked) sel.add(r.id); else sel.delete(r.id);
      lastCheckedId = r.id;
      updateCount();
      return;
    }
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'enrich') { enrichRow(r, true); return; }
    if (act === 'download') { downloadRow(r, true); return; }
    if (act === 'promote') { promoteRow(r, true); return; }
    openDrawer(r);   // ⋯ or plain row click
  }

  // ── Detail drawer ───────────────────────────────────────────────────────────
  function openDrawer(r) {
    focusId = r.id;
    const k = kindOf(r);
    document.getElementById('igDrawerBody').innerHTML = `
      <h3>${esc(r.VidTitle || r.id)}</h3>
      <div class="meta">
        <span class="badge k-${k}">${k}</span> · <span class="s-${r.status || 'new'}">${r.status || 'new'}</span> ·
        ${esc(r.author)} · <a class="idlink" href="${esc(igLink(r))}" target="_blank" rel="noopener">${esc(r.id)}</a>
      </div>
      <div class="kv">
        <b>VidAuthor</b><span>${esc(r.VidAuthor || '—')}</span>
        <b>Posted</b><span>${esc(r.DatePosted || '—')}</span>
        <b>Duration</b><span>${r.durSecs ? esc(fmtDur(r.durSecs)) : '—'}</span>
        <b>W×H (max)</b><span>${(r.width && r.height) ? (r.width + ' × ' + r.height) : '—'}</span>
        <b>Harvested</b><span>${esc(r.DateAdded || '—')}</span>
        ${r.source ? `<b>Source</b><span>${esc(r.source)}${r.staged === false ? ' · Unharvested' : ''}</span>` : ''}
        ${r.imgIndex ? `<b>img_index</b><span>${esc(r.imgIndex)}${r.imgIndex === 1 ? ' · 📸 Cover-only grabs just it' : ''}</span>` : ''}
        ${r.DevComment ? `<b>DevComment</b><span>${esc(r.DevComment)}</span>` : ''}
        ${r.mlUID ? `<b>ml UID</b><span>${esc(r.mlUID)}</span>` : ''}
        ${r.localFiles && r.localFiles.length ? `<b>File</b><span>📁 ${esc(r.localFiles.join(', '))}</span>` : ''}
      </div>
      <div class="sect"><b>Download filename ${(r.durSecs == null || r.width == null) ? '<span style="color:#d59a3a;font-weight:400">— finalizes after Enrich</span>' : ''}</b>
        <div class="fname">${esc(downloadName(r))}${coverOnly ? '.jpg' : '.mp4'}</div></div>
      <div class="acts">
        <button data-d="enrich" class="primary">✨ Enrich</button>
        <button data-d="download">⬇ Download</button>
        <button data-d="reset" title="Reset this row to 'new' (clears title/W×H/duration/cover/file record, keeps caption) so a fresh Enrich + Download rebuilds it">↺ Reset</button>
        <button data-d="paste">📋 Saved-text</button>
        <button data-d="promote" ${r.status === 'promoted' ? 'disabled' : ''}>➕ Promote</button>
        <button data-d="open">↗ Instagram</button>
      </div>
      ${r.igImage ? `<div class="sect"><b>Cover (index 1 — cookieless)</b>
        <a href="${esc(r.igImage)}" target="_blank" rel="noopener"><img class="igcover" src="${esc(r.igImage)}" alt="cover"
          onerror="this.style.display='none';this.insertAdjacentHTML('afterend','<span class=&quot;no&quot;>— cover URL expired; re-enrich to refresh —</span>')"></a></div>` : ''}
      <div class="sect"><b>ftext (clean caption)</b><div class="ftext">${r.ftext || '<span class="no">— not enriched —</span>'}</div></div>
      <div class="sect"><b>ttxt (full info)</b><div class="ttxt">${r.ttxt || '<span class="no">— none —</span>'}</div></div>
    `;
    const body = document.getElementById('igDrawerBody');
    body.querySelectorAll('.acts button').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.d;
      if (a === 'enrich') enrichRow(r, true).then(() => openDrawer(r));
      else if (a === 'download') downloadRow(r, true).then(() => openDrawer(r));
      else if (a === 'reset') {                 // (dev0513) re-try this row from scratch
        resetRow(r); dirty = true; persist(false); applyAndRender(); openDrawer(r);
        igToast('↺ reset ' + r.id + ' to "new" — ✨ Enrich then ⬇ Download to apply the new filename + jpg cover', 4000);
      }
      else if (a === 'paste') openPasteModal(r);
      else if (a === 'promote') { promoteRow(r, true); openDrawer(r); }
      else if (a === 'open') window.open(igLink(r), '_blank', 'noopener');
    }));
    const dr = document.getElementById('igDrawer');
    // (dev0498) Anchor the fixed drawer just under the toolbar so it stays put while
    // the table scrolls (and re-measure each open in case the bar wrapped a line).
    const wrap = document.getElementById('igWrap');
    if (wrap) dr.style.top = Math.round(wrap.getBoundingClientRect().top) + 'px';
    dr.classList.add('open');
    document.querySelectorAll('#igTable tr.focus').forEach(t => t.classList.remove('focus'));
    document.querySelector(`#igTable tr[data-id="${CSS.escape(r.id)}"]`)?.classList.add('focus');
    igPreviewSyncToFocus();   // (dev0500) clicking a row also steps the open preview
  }
  function closeDrawer() {
    document.getElementById('igDrawer').classList.remove('open');
    // (dev0474) Keep the row's .focus highlight after the drawer closes so ↑/↓
    // keyboard navigation continues from where you were (focusId stays set).
  }
  function drawerOpen() { return document.getElementById('igDrawer')?.classList.contains('open'); }

  // (dev0474) Row focus + keyboard navigation. A focused row carries the .focus
  // highlight (same one the drawer uses); ↑/↓ step to the prev/next VISIBLE row,
  // scrolling it into view. focusId persists across re-renders (renderBody re-adds
  // the class from the template), so the highlight survives filter/sort changes.
  function applyFocusHighlight(id) {
    document.querySelectorAll('#igTable tr.focus').forEach(t => t.classList.remove('focus'));
    if (id == null) return null;
    const tr = document.querySelector(`#igTable tr[data-id="${CSS.escape(id)}"]`);
    if (tr) { tr.classList.add('focus'); tr.scrollIntoView({ block: 'nearest' }); }
    return tr;
  }
  function moveFocus(delta) {
    if (!view.length) return;
    const i = focusId != null ? view.findIndex(r => r.id === focusId) : -1;
    const ni = i < 0 ? 0 : Math.max(0, Math.min(view.length - 1, i + delta));
    const row = view[ni];
    if (drawerOpen()) openDrawer(row);     // browsing also steps the open drawer
    else focusId = row.id;
    applyFocusHighlight(row.id);
    igPreviewSyncToFocus();                // (dev0500) follow focus in the media preview
  }
  function toggleFocusedSel() {
    if (focusId == null) return;
    if (sel.has(focusId)) sel.delete(focusId); else sel.add(focusId);
    lastCheckedId = focusId;
    renderBody();                          // focusId persists → highlight stays
  }
  // (dev0496) Hotkey 'm': clear the whole selection, then check the first N visible
  // rows from the top — a one-key way to grab a batch-sized chunk.
  function selectTopN(n) {
    sel.clear();
    const picked = view.slice(0, n);
    picked.forEach(r => sel.add(r.id));
    lastCheckedId = picked.length ? picked[picked.length - 1].id : null;
    renderBody();
    igToast(`☑ selected ${picked.length} from the top`, 1500);
  }
  // (dev0496) Set the status dropdown + filter from a hotkey (mirrors the dropdown).
  function setStatusFilter(val) {
    statusFilter = val;
    const s = document.getElementById('igStatus'); if (s) s.value = val;
    applyAndRender();
    const label = { all: 'all status', new: 'new', enriched: 'enriched', downloaded: 'downloaded' }[val] || val;
    igToast('⛃ status filter: ' + label, 1400);
  }

  // (dev0635) Hotkey 'w' — add the single Instagram post/reel URL on the clipboard as a
  // NEW "Unharvested" row (staged:false), for grabbing individual posts/images from
  // authors whose whole reels you don't want to harvest. The row lands as status 'new'
  // so the usual Enrich (E) / Download (D) / Promote work on it right away. A carousel's
  // ?img_index=N is remembered (r.imgIndex) and surfaced; for index-1 the 📸 Cover-only
  // download mode grabs just that image. A URL already in ig.json isn't duplicated —
  // its existing row is selected instead.
  async function addUnharvestedFromClipboard() {
    let text = '';
    try { text = ((await navigator.clipboard.readText()) || '').trim(); }
    catch (e) {
      igToast('✗ couldn\'t read the clipboard (' + ((e && e.message) || '?') + ')\nCopy an Instagram post/reel URL first, then press w', 4200);
      return;
    }
    if (!text) { igToast('Clipboard is empty — copy an Instagram post/reel URL, then press w', 3200); return; }
    const url = text.split(/\s+/)[0];                 // first token = the URL
    const id = _igShortcodeFromUrl(url);
    if (!id) {
      igToast('✗ no Instagram post id in the clipboard:\n' + url.slice(0, 120)
        + '\n(want a .../p/<id>/ or .../reel/<id>/ link)', 4800);
      return;
    }
    // Clear the filters that would hide a brand-new staged:false 'new' row, so it's
    // always visible after adding (whether it's new or an already-tracked dup).
    authorFilter = 'all'; query = '';
    setStatusFilterSilent('all'); setStagedFilterSilent('all');
    const sBox = document.getElementById('igSearch'); if (sBox) sBox.value = '';

    const existing = rows.find(r => r.id === id);
    if (existing) {
      refreshAuthorOptions(); applyAndRender();
      focusId = existing.id; sel.clear(); sel.add(existing.id);
      applyAndRender(); applyFocusHighlight(existing.id);
      igToast('• ' + id + ' is already in ig.json (@' + (existing.author || '?')
        + ' · ' + (existing.status || 'new') + ') — selected it, not duplicated', 4600);
      return;
    }
    const author = _igAuthorFromUrl(url);
    const im = url.match(/[?&]img_index=(\d+)/i);
    const imgIndex = im ? +im[1] : 0;
    const kindSeg = /\/reels?\//i.test(url) ? 'reel' : /\/tv\//i.test(url) ? 'tv' : 'p';
    const cleanUrl = 'https://www.instagram.com/' + kindSeg + '/' + id + '/';
    const now = (typeof isoNow === 'function') ? isoNow() : new Date().toISOString().slice(0, 19).replace('T', ' ');
    const r = { id, url: cleanUrl, author: author || '', status: 'new', staged: false, source: 'manual', DateAdded: now };
    if (imgIndex) r.imgIndex = imgIndex;
    rows.push(r); knownIds.add(id);
    dirty = true;
    refreshAuthorOptions(); applyAndRender();
    focusId = id; sel.clear(); sel.add(id);
    applyAndRender(); applyFocusHighlight(id);
    await persist(false);
    igToast('➕ Unharvested single added → ' + id
      + (author ? ' · @' + author : ' · author fills on Enrich')
      + (imgIndex ? ' · img_index ' + imgIndex + (imgIndex === 1 ? ' (📸 Cover-only grabs just it)' : '') : '')
      + '\nstatus new — press E to enrich, D to download', 6000);
  }
  // Silent variants of the status/source filters (no toast) for the 'w' add path.
  function setStatusFilterSilent(val) {
    statusFilter = val;
    const s = document.getElementById('igStatus'); if (s) s.value = val;
  }
  function setStagedFilterSilent(val) {
    stagedFilter = val;
    const s = document.getElementById('igStaged'); if (s) s.value = val;
  }

  // ── ttxt builder (yt-dlp "everything" bucket — only when ttxt is empty so the
  //    richer Firefox-saved-page ttxt, with comments + sibling URLs, never clobbered)
  function buildTtxt(meta, url) {
    const desc = (meta.description || '').trim();
    const handle = (typeof _ytdlpAuthorHandle === 'function') ? _ytdlpAuthorHandle(meta) : '';
    const head = [];
    if (handle) head.push(handle);
    const dp = datePosted(meta); if (dp) head.push(dp);
    if (Number.isFinite(meta.duration)) head.push(fmtDur(meta.duration));
    if (meta.width && meta.height) head.push(meta.width + '×' + meta.height);
    if (Number.isFinite(meta.like_count)) head.push(meta.like_count.toLocaleString() + ' likes');
    if (Number.isFinite(meta.view_count)) head.push(meta.view_count.toLocaleString() + ' views');
    const tags = desc.match(/#[A-Za-z0-9_]+/g) || [];
    let html = '';
    if (head.length) html += '<p style="color:#888">' + esc(head.join(' · ')) + '</p>\n';
    const body = desc.split(/\r?\n/).map(l => l.trim()).filter(l => l && l !== '.')
      .map(l => '<p>' + esc(l) + '</p>').join('\n');
    if (body) html += body + '\n';
    if (tags.length) html += '<p style="color:#69c">' + esc([...new Set(tags)].join(' ')) + '</p>\n';
    html += '<p>Source: <a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(url) + '</a></p>';
    return html;
  }

  // ── Enrich (yt-dlp → title/ftext/ttxt/author/date/duration/res) ─────────────
  async function enrichRow(r, single) {
    if (typeof _ytdlpFetchMeta !== 'function') { igToast('yt-dlp pipeline not loaded', 2500); return false; }
    try {
      if (single) igToast('⏳ Enriching ' + r.id + '…\n🍪 cookieless only — your IG login is never used', 6000);
      if (typeof _ensureCommonWords === 'function') await _ensureCommonWords();
      const meta = await _ytdlpFetchMeta(r.url);
      const desc = (meta.description || '').trim();
      const handle = (typeof _ytdlpAuthorHandle === 'function') ? _ytdlpAuthorHandle(meta) : '';
      if (!desc && !handle && !Number.isFinite(meta.duration)) throw new Error('empty metadata (IG may be login-walled)');
      if (!r.ftext && typeof _ytdlpBuildFtext === 'function') r.ftext = _ytdlpBuildFtext(meta, r.url);
      if (!r.ttxt) r.ttxt = buildTtxt(meta, r.url);
      if (!r.VidAuthor && handle) r.VidAuthor = handle;
      // (dev0635) A 'w'-added single from a bare /p/<id>/ URL has no author until now;
      // fill it from yt-dlp's handle so it groups under the right Unharvested author
      // (harvested/ffdown rows already carry an author, so this only touches blanks).
      if (!r.author && handle) r.author = handle.replace(/^@/, '').trim();
      if (!r.VidTitle) {
        const t = (meta.title || '').trim();
        // yt-dlp's generic titles: single reel = "Video by <h>", carousel = "Post by
        // <h>" (and "Reel by"). All three → derive a real title from the caption.
        r.VidTitle = (!t || /^(video|post|reel) by /i.test(t))
          ? (typeof _smartIgTitle === 'function' ? _smartIgTitle(desc) : desc.slice(0, 70))
          : (typeof _normalizeText === 'function' ? _normalizeText(t).replace(/\s+/g, ' ').trim() : t);
      }
      const dp = datePosted(meta); if (dp) r.DatePosted = dp;
      if (Number.isFinite(meta.duration)) r.durSecs = Math.round(meta.duration);
      // (dev0439) Image posts/carousels have no duration → mark 0 so the download
      // guard doesn't keep re-enriching them on every attempt.
      else if (r.durSecs == null) r.durSecs = 0;
      if (meta.width) r.width = +meta.width;
      if (meta.height) r.height = +meta.height;
      // (dev0510) Cookieless index-1 cover for photo /p/ posts (the keeper image).
      // The URL is a signed CDN link that expires (~a day), so it's a preview aid —
      // re-enrich refreshes it; permanence still comes from ⬇ Download. Reels never
      // set meta.thumbnail (the proxy skips covers on video posts), so this is a no-op
      // for them and never overwrites with a stale value.
      if (meta.thumbnail) r.igImage = meta.thumbnail;
      if (r.status === 'new' || !r.status) r.status = 'enriched';
      // (dev0442) honest cookie report — the proxy now falls back to Firefox cookies
      // when a post is login-walled (same as Download), and tells us which path won.
      lastOpInfo = meta._usedCookies ? 'Firefox cookies used' : 'No firefox cookies used';
      enrichFailed.delete(r.id);     // succeeded → clear any prior wall mark
      dirty = true;
      if (single) { applyAndRender(); persist(false); igToast('✓ enriched ' + r.id + '\n🍪 ' + lastOpInfo, 2000); }
      return true;
    } catch (e) {
      lastOpError = (e && e.message) || '';
      // (dev0441) Mark login-walled posts so bulk Enrich stops re-hitting them this
      // session (they can't succeed cookielessly). Transient/proxy errors are NOT
      // marked — those should still retry. Reload clears the whole set.
      // (dev0470) Use the shared WALL_RE so an unreadable /p image post (yt-dlp "no
      // video" + embed failed) is marked too — otherwise it kept status 'new' and,
      // with stop-at-first-wall, every re-run halted on the SAME row, never advancing.
      if (WALL_RE.test(lastOpError)) enrichFailed.add(r.id);
      if (single) {
        // (dev0442) Enrich now tries cookieless THEN Firefox cookies — reaching here
        // means BOTH failed. A login-wall message means even cookies didn't read it
        // (Firefox not logged into Instagram?), not an IP rate-limit.
        const walled = isWall(lastOpError);
        igToast(walled
          ? '✗ enrich ' + r.id + ' — couldn\'t read post (not a rate-limit)\nCookieless + Firefox cookies both failed. Is Firefox logged into Instagram? Or use 📋 Paste saved-text.'
          : '✗ enrich ' + r.id + ': ' + lastOpError, 4000);
      }
      return false;
    }
  }

  // Shared paced batch runner. Sequential (one at a time), randomized gap BETWEEN
  // processed items (no leading/trailing wait), Stop button + auto-abort on a
  // rate-limit signature. `skipIf(r)` → already-done rows are skipped instantly
  // (no network, no delay), so re-running with everything still selected only
  // touches the rows that still need work.
  async function runBatch(label, ids, gap, doOne, skipIf, posture) {
    busy = true; batchAbort = false; setBatchUi(true);
    igStickyHide();                    // clear any prior run's summary so it can't cover the live panel
    let ok = 0, fail = 0, done = 0, throttled = false, cookieStopped = false, cookieUsed = 0;
    let walled = 0, walledStopped = false;   // (dev0458) login-walled results + first-wall stop
    let consecFail = 0;                      // (dev0645) run of back-to-back download failures
    const isDl = /download/i.test(label);    // (dev0569) downloads stop at the FIRST failure
    const t0 = Date.now();
    // Rows that still need work. Already-done rows are passed over silently — no
    // "skipped" line anywhere (per request: that count was ambiguous noise).
    const total = ids.reduce((n, id) => { const r = rowById(id); return n + (r && !(skipIf && skipIf(r)) ? 1 : 0); }, 0);
    // (dev0437) Live status in a centered panel (no top-bar shift). Each line:
    // action + N/total, cookie tally + cap, running speed, and the pacing countdown.
    const fmtSpeed = () => (done ? `~${((Date.now() - t0) / 1000 / done).toFixed(1)}s/item` : '');
    const fmtClock = ms => { const s = Math.round(ms / 1000); return Math.floor(s / 60) + ':' + pad2(s % 60); };
    // (dev0495) Live-accurate cookie line: enrich + video downloads stay cookieless
    // (cookieUsed never moves), but a gallery-dl image carousel uses Firefox cookies,
    // so reflect the running tally instead of a blanket "cookies off".
    const cookieSoFar = () => cookieUsed
      ? `🍪 Firefox cookies used on ${cookieUsed} so far`
      : `🍪 cookieless so far — your IG login is not used`;
    igBatchShow(`${label}…\n${posture}\n0/${total}\n${cookieSoFar()}`);
    for (const id of ids) {
      if (batchAbort) break;
      const r = rowById(id); if (!r) continue;
      if (skipIf && skipIf(r)) continue;             // already done → pass over silently
      if (done > 0) {
        const g = rnd(gap[0], gap[1]);
        igBatchUpdate(`${label} ${done}/${total} · ✓${ok}${fail ? ` ✗${fail}` : ''}\n${cookieSoFar()}\n${fmtSpeed()}\n⏳ pacing ${(g / 1000).toFixed(1)}s before next…`);
        await sleep(g); if (batchAbort) break;
      }
      done++;
      lastOpError = ''; lastOpInfo = '';
      processingId = r.id; renderBody();   // (dev0445) highlight the row being worked on
      igBatchUpdate(`${label} ${r.id}\n${done}/${total} · ✓${ok}${fail ? ` ✗${fail}` : ''}\n${cookieSoFar()}${done > 1 ? '\n' + fmtSpeed() : ''}`);
      let good = await doOne(r);
      // (dev0645) Single in-item retry for DOWNLOADS. The cookieless photo-carousel walker
      // is easily but usually transiently IG-throttled; a short pause + one retry clears
      // most first-attempt blocks so a lone throttled item never aborts the run. Skipped
      // if the failure is a hard rate-limit (429) — retrying that just hammers IG.
      if (!good && isDl && !batchAbort && !isThrottle(lastOpError)) {
        const rg = rnd(DOWNLOAD_RETRY_MS[0], DOWNLOAD_RETRY_MS[1]);
        igBatchUpdate(`${label} ${r.id} — retrying in ${(rg / 1000).toFixed(0)}s (transient block?)\n${done}/${total} · ✓${ok}${fail ? ` ✗${fail}` : ''}\n${cookieSoFar()}`);
        await sleep(rg);
        if (!batchAbort) { lastOpError = ''; lastOpInfo = ''; good = await doOne(r); }
      }
      if (good) {
        ok++;
        consecFail = 0;                       // (dev0645) success breaks the failure streak
        if (lastOpInfo === 'Firefox cookies used') cookieUsed++;
        igBatchUpdate(`${label} ${r.id} ✓${lastOpInfo === 'Firefox cookies used' ? ' (🍪)' : ''}\n${done}/${total} · ✓${ok}${fail ? ` ✗${fail}` : ''}\n${cookieSoFar()}\n${fmtSpeed()}`);
        if (cookieUsed >= COOKIE_CAP) cookieStopped = true;   // (dev0444) account-safety cap hit
      } else {
        // (dev0457) Attempted but couldn't be read — count it so the end report's
        // numbers close (marked = cookieless + cookie + couldn't-read + not-reached).
        // These are login-walled posts that failed BOTH cookieless and the Firefox-
        // cookie retry; order/pacing can't change that (see igStickyShow report).
        fail++;
        if (isThrottle(lastOpError)) throttled = true;
        // (dev0458) Stop at the first login-walled result (cookie-conservative).
        // (dev0645) DOWNLOADS now stop only after DOWNLOAD_WALL_CAP failures IN A ROW (a
        // success resets the streak) — replacing dev0569's first-failure abort, which let
        // one transiently-throttled photo kill the run. Combined with the single in-item
        // retry above, a real block still halts fast while transient blips are ridden out.
        // Deliberately NOT gated on isWall(): yt-dlp's wall wording drifts and has silently
        // broken the wall stop 3× (dev0442/0470/0501); downloads are cookieless-or-fail
        // (dev0568) so a failure always counts. Enrich keeps the cumulative isWall() test
        // (its auto-enrich driver tells a walled VPN exit from a dead post to grind on).
        else if (isDl) { if (++consecFail >= DOWNLOAD_WALL_CAP) walledStopped = true; }
        else if (isWall(lastOpError) && ++walled >= WALL_CAP) walledStopped = true;
      }
      applyAndRender();
      if (throttled || cookieStopped || walledStopped) break;
    }
    processingId = null; busy = false; setBatchUi(false); igBatchHide();
    if (ok) { dirty = true; await persist(false); }
    applyAndRender();

    // (dev0444) Persistent end-of-run report — exactly the fields requested: how many
    // were marked to do, the task, how many finished WITHOUT Firefox cookies
    // (cookieless · account-safe) vs WITH them, and the total elapsed time. No
    // "skipped" line. Stays on screen until Close button / Esc.
    // (dev0457) Every marked row lands in exactly ONE bucket so the report's numbers
    // add up (this was the "26 marked but only 19 shown" puzzle — the couldn't-read
    // rows had no line). cookieless + cookie + couldn'tRead + notReached === total.
    const cookieless  = ok - cookieUsed;       // read with no Firefox cookies
    const couldntRead = fail;                  // attempted, failed (all cookieless paths)
    const notReached  = total - done;          // never attempted (stopped early)
    const head = throttled     ? `⏸ ${label} stopped — IG rate-limit detected`
               : cookieStopped ? `⏹ ${label} auto-stopped — 🍪 cookie used (cap ${COOKIE_CAP})`
               // (dev0568) A cookieless download that can't be fetched now just fails —
               // no cookie fallback. Say so plainly (the user's ask) instead of the
               // enrich-flavoured "login-walled post" line.
               : walledStopped ? (isDl ? `⏹ Download failed — downloads stopped`
                                       : `⏹ ${label} auto-stopped — first login-walled post`)
               : batchAbort    ? `⏹ ${label} stopped by you`
               : couldntRead   ? `✓ ${label} done — ${ok}/${total} ${isDl ? 'downloaded' : 'read'}`
               :                 `✓ ${label} complete`;
    const lines = [
      head,
      ``,
      `${total} marked to do`,
      `${cookieless} ${isDl ? 'downloaded' : 'read'} cookielessly  (account-safe)`,
      // (dev0568) HONEST cookie line — only promise "never used" when it's actually true.
      // The old UNCONDITIONAL "cookies off — never used" printed even under a "🍪 cookie
      // used" head → the exact contradiction the user saw. Downloads are pure-cookieless
      // now (gallery-dl off), so this stays true; kept conditional so it can never lie.
      cookieUsed ? `🍪 Firefox cookies used on ${cookieUsed}  (the rest were cookieless)`
                 : `🍪 no Firefox cookies used — your IG account was never touched`,
    ];
    if (couldntRead) lines.push(`${couldntRead} ${isDl ? "couldn't be downloaded" : "couldn't be read"}  (needs a login)`);
    if (notReached)  lines.push(`${notReached} not reached  (run stopped early)`);
    lines.push(`⏱ total time ${fmtClock(Date.now() - t0)}${ok ? '   ·   ' + fmtSpeed() : ''}`);
    if (throttled)          lines.push('', 'Wait a few minutes, then re-run — only un-done rows are retried.');
    else if (cookieStopped) lines.push('', 'Stopped after 1 Firefox-cookie use (your account-safety setting).',
                                           'Re-run to continue — the cap resets each run.');
    else if (walledStopped) lines.push('', isDl
                                           ? `Stopped after ${DOWNLOAD_WALL_CAP} downloads failed in a row (each retried once) — likely a real IP block. No Firefox cookies were used.`
                                           : 'Stopped at the first login-walled post (your account-safety setting).',
                                           isDl
                                           ? 'Often a temporary IP block — wait a bit and re-run, or grab it from a logged-in Firefox.'
                                           : 'Re-run to step past it, or use 📋 Saved-text. Cookieless rows before it are done.');
    else if (couldntRead)   lines.push('', isDl
                                           ? `These ${couldntRead} need a login to download — no cookies were used.`
                                           : `These ${couldntRead} are login-walled — spacing or order won't read them.`,
                                           isDl
                                           ? `Re-run later, or download from a logged-in Firefox.`
                                           : `Use 📋 Saved-text, or check Firefox is logged into Instagram.`);
    if (throttled && lastOpError) lines.push((lastOpError || '').slice(0, 80));
    igStickyShow(lines.join('\n'));
    return ok;
  }

  // A row counts as already enriched once a successful enrich stamped its status
  // off 'new' (downloaded/promoted rows were enriched first, so they're covered too).
  const isEnriched = r => !!r.status && r.status !== 'new';
  // (dev0441) Bulk-enrich "done" = already enriched OR a login-wall this session.
  // The latter keeps it out of the re-hit loop that produced no visible change.
  const igEnrichDone = r => isEnriched(r) || enrichFailed.has(r.id);
  // A row counts as already downloaded once it has media files on disk.
  const isDownloaded = r => !!(r.localFiles && r.localFiles.length);

  async function batchEnrich() {
    const ids = selectedInView();
    if (!ids.length) { igToast('Nothing checked in this view.\nBatches act only on filtered rows that are checked (checkbox; Shift-click for a range).', 3400); return; }
    if (busy) return;
    if (ids.every(id => { const r = rowById(id); return r && igEnrichDone(r); })) {
      const walled = ids.filter(id => { const r = rowById(id); return r && !isEnriched(r) && enrichFailed.has(id); }).length;
      igToast(walled
        ? `Nothing to do — ${walled} selected are login-walled (tried this session).\n↻ Reload to retry, or use Download / 📋 Saved-text.`
        : 'All selected rows are already enriched — nothing to do', 3200);
      return;
    }
    await runBatch('Enriching', ids, ENRICH_GAP, r => enrichRow(r, false), igEnrichDone,
      '🍪 cookieless only — never uses your Firefox/IG login');
  }

  // ══ Auto-enrich driver (dev0517) ═══════════════════════════════════════════════
  // Semi-auto: enriches `autoBatchSize` rows, and when the current Proton exit walls
  // it pauses, tallies the wall against the marked city, and waits for you to switch
  // Proton + click the next city (that click resumes). Downloads are deliberately NOT
  // driven here — IG's media CDN blocks datacenter/VPN exits, so downloads need your
  // home IP; this tool is only for the tolerant metadata (enrich) surface.
  function loadAuto() {
    try {
      const j = JSON.parse(localStorage.getItem(AUTO_KEY) || '{}');
      autoLocs = (Array.isArray(j.locs) && j.locs.length)
        ? j.locs.map(l => ({ name: String(l.name || '').trim(), walled: +l.walled || 0 })).filter(l => l.name)
        : AUTO_DEFAULT_CITIES.map(n => ({ name: n, walled: 0 }));
      autoActive = j.active || null;
      autoBatchSize = Math.max(1, Math.min(50, +j.batchSize || 18));
    } catch (_) {
      autoLocs = AUTO_DEFAULT_CITIES.map(n => ({ name: n, walled: 0 }));
      autoActive = null; autoBatchSize = 18;
    }
  }
  function saveAuto() {
    try { localStorage.setItem(AUTO_KEY, JSON.stringify({ locs: autoLocs, active: autoActive, batchSize: autoBatchSize })); } catch (_) {}
  }
  // clean (walled 0) first, then fewest walls; stable within a tier (insertion order).
  function sortedLocs() {
    return autoLocs.map((l, i) => ({ l, i })).sort((a, b) => (a.l.walled - b.l.walled) || (a.i - b.i)).map(x => x.l);
  }
  function activeLoc() { return autoLocs.find(l => l.name === autoActive) || null; }
  function topCleanCity() { const s = sortedLocs().find(l => l.name !== autoActive); return s ? s.name : ((sortedLocs()[0] || {}).name || '—'); }

  // A row still wants enriching if it isn't enriched, hasn't walled this exit, and
  // isn't a known-dead post (walled while the exit was otherwise fine).
  function needsEnrich(r) { return r && !isEnriched(r) && !enrichFailed.has(r.id) && !autoDead.has(r.id); }
  function autoRemaining() { return view.reduce((n, r) => n + (needsEnrich(r) ? 1 : 0), 0); }
  function pickNextBatchIds(n) {
    const out = [];
    for (const r of view) { if (needsEnrich(r)) { out.push(r.id); if (out.length >= n) break; } }
    return out;
  }

  // Tell a dead POST from a walled EXIT: after a batch walls, enrich ONE more row on
  // the same exit. 'ok' → the walled row was just unreadable (exit fine); 'wall' → the
  // exit itself is walling; 'error' → transient/proxy; 'nomore' → nothing left to test.
  async function probeExit(excludeId) {
    const cand = view.find(r => needsEnrich(r) && r.id !== excludeId);
    if (!cand) return 'nomore';
    busy = true; setBatchUi(true);
    igBatchShow('🤖 probing exit…\none more post — is it a dead post or a walled exit?');
    const good = await enrichRow(cand, false);
    busy = false; setBatchUi(false); igBatchHide();
    applyAndRender();
    if (good) { dirty = true; await persist(false); return 'ok'; }
    return isWall(lastOpError) ? 'wall' : 'error';
  }

  async function autoLoop() {
    while (autoRunning && !autoPaused) {
      if (busy) { await sleep(400); continue; }              // wait out any manual batch
      const ids = pickNextBatchIds(autoBatchSize);
      if (!ids.length) { autoFinish(); return; }
      const before = new Set(enrichFailed);
      const ok = await runBatch('Auto-enrich', ids, ENRICH_GAP, r => enrichRow(r, false), igEnrichDone,
        '🤖 auto · 🍪 cookieless — click your Proton city so walls are tracked');
      if (!autoRunning) return;                               // Stop pressed mid-batch
      const newWalls = [...enrichFailed].filter(id => !before.has(id));
      renderAuto();
      if (newWalls.length) {
        const probe = await probeExit(newWalls[0]);
        if (!autoRunning) return;
        if (probe === 'ok') { autoDead.add(newWalls[0]); continue; }   // one dead post, exit fine
        if (probe === 'nomore') { autoFinish(); return; }
        if (probe === 'wall') { bumpWall(); autoPauseWalled(); return; }
        autoPause('⚠ Enrich errored (not a wall) — likely a transient/proxy hiccup.\nCheck the proxy, then click your city (or ▶) to resume.');
        return;
      }
      if (ok > 0) { await sleep(autoGapMs); continue; }       // clean progress → breather → next
      autoPause('⚠ No progress and no wall — is the proxy (127.0.0.1:8081) running?\nFix it, then click your city (or ▶) to resume.');
      return;
    }
  }

  function bumpWall() {
    const l = activeLoc();
    if (l) { l.walled = (l.walled || 0) + 1; saveAuto(); }
    renderAuto();
  }
  function autoPauseWalled() {
    autoPaused = true;
    const l = activeLoc();
    igStickyShow('⏸ Walled' + (l ? ' on ' + l.name + ' (now walled ' + l.walled + ')' : ' (no city marked)') + '.\n\n'
      + 'Switch Proton to a cleaner exit — try: ' + topCleanCity() + '\n'
      + 'Then CLICK that city in the 🤖 Auto-enrich list to resume.\n\n'
      + autoRemaining() + ' rows still to enrich.');
    renderAuto();
  }
  function autoPause(msg) { autoPaused = true; igStickyShow(msg); renderAuto(); }
  function autoStart() {
    if (autoRunning && !autoPaused) return;
    if (busy) { igToast('A batch is already running — wait for it to finish.', 2400); return; }
    if (!autoRemaining()) { igToast('Nothing to enrich in the current view.\n(Clear filters / set status to new if needed.)', 3000); return; }
    if (!autoActive) igToast('Tip: click the Proton city you\'re currently on so walls get tracked.', 3000);
    autoRunning = true; autoPaused = false; igStickyHide(); renderAuto();
    autoLoop();
  }
  function autoResume() {
    if (!autoRunning) { autoStart(); return; }
    if (!autoPaused) return;
    autoPaused = false; igStickyHide(); renderAuto(); autoLoop();
  }
  function autoStopRun() {
    autoRunning = false; autoPaused = false; batchAbort = true;   // break any in-flight batch
    renderAuto();
    igToast('🤖 auto-enrich stopped', 1500);
  }
  function autoFinish() {
    autoRunning = false; autoPaused = false; renderAuto();
    igStickyShow('✓ Auto-enrich complete — no rows left to enrich in this view.\n'
      + (autoDead.size ? autoDead.size + ' post(s) were unreadable and skipped.\n' : '')
      + 'For downloads use your HOME IP — IG\'s media CDN blocks datacenter/VPN exits.');
  }
  // User marks the exit they just switched Proton to. If a run is paused, this resumes it.
  function activateLoc(name) {
    const changed = name !== autoActive;
    autoActive = name;
    if (changed) enrichFailed.clear();     // fresh exit → retry rows that walled on the old one
    saveAuto(); renderAuto();
    if (autoRunning && autoPaused) { autoPaused = false; igStickyHide(); autoLoop(); }
    else if (!autoRunning) igToast('📍 active exit: ' + name + ' — press ▶ Start to begin', 1800);
    else igToast('📍 active exit: ' + name, 1400);
  }
  function addLoc(name) {
    name = String(name || '').trim(); if (!name) return;
    if (autoLocs.some(l => l.name.toLowerCase() === name.toLowerCase())) { igToast('Already in the list', 1400); return; }
    autoLocs.push({ name, walled: 0 }); saveAuto(); renderAuto();
  }
  function removeLoc(name) {
    autoLocs = autoLocs.filter(l => l.name !== name);
    if (autoActive === name) autoActive = null;
    saveAuto(); renderAuto();
  }
  function resetWalls() {
    autoLocs.forEach(l => l.walled = 0); saveAuto(); renderAuto();
    igToast('Wall counts reset to 0', 1400);
  }

  function toggleAutoPanel() {
    const existing = document.getElementById('igAuto');
    if (existing && existing.classList.contains('open')) { existing.classList.remove('open'); return; }
    buildAutoPanel(); renderAuto();
    document.getElementById('igAuto').classList.add('open');
  }
  function buildAutoPanel() {
    if (document.getElementById('igAuto')) return;
    const p = document.createElement('div');
    p.id = 'igAuto';
    p.innerHTML =
      '<div id="igAutoBar"><b>🤖 Auto-enrich</b><span id="igAutoState"></span><button id="igAutoHide" title="Hide (A)">×</button></div>'
      + '<div id="igAutoCtl">'
        + '<button id="igAutoStartBtn">▶ Start</button>'
        + '<button id="igAutoPauseBtn">⏸ Pause</button>'
        + '<button id="igAutoStopBtn">⏹ Stop</button>'
        + '<label>batch <input id="igAutoSize" type="number" min="1" max="50" value="18"></label>'
      + '</div>'
      + '<div id="igAutoInfo"></div>'
      + '<div class="hd">Proton exits — click the one you\'re on <span>(walls sink to the bottom)</span></div>'
      + '<div id="igAutoLocs"></div>'
      + '<div id="igAutoAdd"><input id="igAutoNew" type="text" placeholder="add a city…"><button id="igAutoAddBtn">+ add</button>'
        + '<button id="igAutoResetBtn" title="Zero all wall counts (e.g. a new day / the IP cooled down)">reset walls</button></div>';
    (document.getElementById('igOverlay') || document.body).appendChild(p);
    p.querySelector('#igAutoHide').addEventListener('click', () => p.classList.remove('open'));
    p.querySelector('#igAutoStartBtn').addEventListener('click', autoStart);
    p.querySelector('#igAutoPauseBtn').addEventListener('click', () => {
      if (autoRunning && !autoPaused) autoPause('⏸ Paused by you.\nClick a city or ▶ Start to resume.');
      else autoResume();
    });
    p.querySelector('#igAutoStopBtn').addEventListener('click', autoStopRun);
    p.querySelector('#igAutoSize').addEventListener('change', e => { autoBatchSize = Math.max(1, Math.min(50, +e.target.value || 18)); saveAuto(); renderAuto(); });
    p.querySelector('#igAutoAddBtn').addEventListener('click', () => { const i = p.querySelector('#igAutoNew'); addLoc(i.value); i.value = ''; });
    p.querySelector('#igAutoNew').addEventListener('keydown', e => { if (e.key === 'Enter') { e.stopPropagation(); addLoc(e.target.value); e.target.value = ''; } });
    p.querySelector('#igAutoResetBtn').addEventListener('click', resetWalls);
  }
  function renderAuto() {
    const p = document.getElementById('igAuto'); if (!p) return;
    const st = p.querySelector('#igAutoState');
    const state = !autoRunning ? 'idle' : (autoPaused ? 'paused' : 'running');
    if (st) { st.textContent = state; st.className = 'st-' + state; }
    const info = p.querySelector('#igAutoInfo');
    if (info) info.innerHTML = '<b>' + autoRemaining() + '</b> to enrich in view'
      + (autoActive ? ' · on <b>' + esc(autoActive) + '</b>' : ' · <span class="warn">no city marked</span>')
      + (autoDead.size ? ' · ' + autoDead.size + ' skipped' : '');
    const size = p.querySelector('#igAutoSize'); if (size && document.activeElement !== size) size.value = autoBatchSize;
    const startB = p.querySelector('#igAutoStartBtn'); if (startB) startB.disabled = autoRunning && !autoPaused;
    renderLocs();
  }
  function renderLocs() {
    const box = document.getElementById('igAutoLocs'); if (!box) return;
    box.innerHTML = sortedLocs().map(l => {
      const active = l.name === autoActive;
      return '<div class="loc' + (active ? ' active' : '') + (l.walled ? ' walled' : '') + '" data-name="' + esc(l.name) + '">'
        + '<span class="nm">' + (active ? '📍 ' : '') + esc(l.name) + '</span>'
        + '<span class="w">walled ' + l.walled + '</span>'
        + '<button class="rm" title="remove">×</button></div>';
    }).join('');
    box.querySelectorAll('.loc').forEach(el => el.addEventListener('click', ev => {
      if (ev.target.classList.contains('rm')) { ev.stopPropagation(); removeLoc(el.dataset.name); return; }
      activateLoc(el.dataset.name);
    }));
  }

  // ── Download (max res → ig_media/ named per AHK convention) ─────────────────
  async function downloadRow(r, single) {
    // Need title/duration/res for the filename → enrich first if missing.
    if (!r.VidTitle || r.durSecs == null || r.width == null) {
      const ok = await enrichRow(r, false);
      if (!ok && !r.VidTitle) { if (single) igToast('✗ ' + r.id + ': enrich failed, cannot name file', 3200); return false; }
      applyAndRender();
    }
    try {
      if (single) igToast('⏳ Downloading ' + r.id + '…\n' + (coverOnly
        ? '📸 cover only (index 1) — cookieless'
        : '🍪 cookieless — your IG login is never used\nmax res — can take a bit'), 12000);
      const res = await fetch(PROXY + '/ig/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: r.id, url: r.url, name: downloadName(r), coverOnly })
      });
      const j = await res.json();
      if (!j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + res.status));
      r.localFiles = j.files || [];
      if (r.status !== 'promoted') r.status = 'downloaded';
      lastDlName = r.VidTitle || r.id;   // (dev0649) "most recent download" for the rotate toasts
      // (dev0492) Cookie use is now an EXPLICIT proxy flag — NOT "any note present".
      // The dev0491 embed-image rescue is cookieless but carries a `note`; the old
      // `j.note ? cookies` test misread it as a Firefox-cookie use → false "cookie
      // used" toast + COOKIE_CAP auto-stop on the first /p post.
      lastOpInfo = j.usedCookies ? 'Firefox cookies used' : 'No firefox cookies used';
      sel.delete(r.id);            // (dev0438) uncheck on every successful download
      dirty = true;
      if (single) {
        applyAndRender(); persist(false);
        const n = r.localFiles.length;
        const fileLine = n > 1 ? n + ' files (carousel)\n' + (r.localFiles[0] || '') + ' …'
                               : (r.localFiles[0] || '');
        // (dev0495) Honest cookie line: gallery-dl image carousels DO use Firefox
        // cookies (IG login-walls them cookieless); video/yt-dlp + embed stay cookieless.
        const cookieLine = j.usedCookies
          ? ('\n🍪 Firefox cookies used' + (j.viaGalleryDl ? ' — full image carousel via gallery-dl' : ''))
          : '\n🍪 cookieless — your IG login was not used';
        igToast('✓ downloaded ' + r.id + cookieLine
          + (j.viaEmbed ? '\n📐 via embed page — first image only' : '')
          + (j.viaMainVideo ? '\n🎞 reel via cookieless /p/ page (yt-dlp was walled)' : '')
          + (j.viaMainCarousel ? '\n🖼 full carousel via cookieless /p/ page (no cookies)' : '')
          + '\n' + fileLine, 3800);
      }
      return true;
    } catch (e) {
      lastOpError = (e && e.message) || '';
      if (single) igToast('✗ download ' + r.id + ': ' + lastOpError, 3500);
      return false;
    }
  }

  async function batchDownload() {
    const ids = selectedInView();
    if (!ids.length) { igToast('Nothing checked in this view.\nBatches act only on filtered rows that are checked (checkbox; Shift-click for a range).', 3400); return; }
    if (busy) return;
    const todo = ids.filter(id => { const r = rowById(id); return r && !isDownloaded(r); });
    if (!todo.length) { igToast('All selected rows are already downloaded — nothing to do', 2600); return; }
    const already = ids.length - todo.length;
    // (dev0446) Name the author(s) in the prompt so a stray selection can't slip
    // through unnoticed — if it isn't the author you filtered to, you'll see it here.
    const auths = [...new Set(todo.map(id => rowById(id)?.author).filter(Boolean))];
    const authLine = auths.length <= 4 ? auths.map(a => '@' + a).join(', ') : (auths.length + ' authors');
    if (!confirm(`Download ${todo.length} item(s) from ${authLine}\nat max resolution into ig_media/ ?`
      + (already ? `\n(${already} already-downloaded selected rows will be skipped.)` : '') + `\n\n`
      + `• Paced (a few seconds between each) and auto-stops if IG rate-limits.\n`
      + (coverOnly
          ? `• 📸 COVER-ONLY: just the index-1 image per post, cookieless (no carousel, no Firefox cookies).\n`
          : `• Every download is COOKIELESS — your IG login is never used. A post that can't be fetched without a login is skipped and the run stops (no cookie is ever sent).\n`)
      + `• Press ⏹ Stop any time.`)) return;
    // (dev0646) REEL-FIRST ordering. On a VPN/IP where IG walls cookieless PHOTO fetches
    // (a node HTTPS scrape of the /p/ inline JSON — Node's TLS fingerprint gets flagged)
    // but still serves REELS (yt-dlp's bundled curl_cffi mimics a real Chrome TLS
    // handshake, so it slips the IP-reputation wall), a run of walled photos must never
    // starve the reels. Download every video post first, photos last, so the 2-in-a-row
    // wall-stop can only ever cut into the already-hopeless photo tail — every reel is
    // attempted regardless of how the selection was ordered. Sort is stable, so within
    // each group the original selection order is preserved. (kindOf reads r.url.)
    const dlRank = r => (kindOf(r) === 'p' ? 1 : 0);   // reels/tv → 0 (first), photos → 1 (last)
    const ordered = [...ids].sort((a, b) => dlRank(rowById(a) || {}) - dlRank(rowById(b) || {}));
    await runBatch('Downloading', ordered, DOWNLOAD_GAP, r => downloadRow(r, false), isDownloaded,
      '🍪 cookieless — your IG login is never used');
  }

  // (dev0649) Auto-grind the ENRICHED backlog in the current view: grab the top
  // ROTATE_CHUNK enriched-but-not-yet-downloaded rows (view order — no checkboxes
  // needed), download them, and on success switch the Proton VPN to a fresh US
  // exit and repeat with the next 18. Because downloaded rows drop out of `isReady`,
  // each round re-derives the top of the remaining backlog automatically.
  //   • per-batch success → auto-dismissing toast (cumulative total + most recent)
  //   • terminates (persistent final report) on: no enriched rows left · a whole
  //     batch downloads 0 (a wall/login — a new IP won't help) · you press Stop.
  const isReady = r => !!r && r.status === 'enriched' && !isDownloaded(r);
  async function batchDownloadRotating() {
    if (busy) return;
    const readyIds = () => view.filter(isReady).map(r => r.id);   // top-of-view first
    let todo = readyIds();
    if (!todo.length) {
      igToast('No enriched rows to download in this view.\nEnrich rows first (E), or set the Status filter to "enriched", then run this.', 4600);
      return;
    }

    await vpnRefresh(false);
    const exitNow = vpnStatus && vpnStatus.tunnelUp
      ? 'current exit: ' + (vpnStatus.server || vpnStatus.ip || '?')
      : '⚠ no Proton tunnel up yet — it will bring one up BEFORE batch 1';
    const auths = [...new Set(todo.map(id => rowById(id)?.author).filter(Boolean))];
    const authLine = auths.length <= 4 ? auths.map(a => '@' + a).join(', ') : (auths.length + ' authors');
    if (!confirm(
        `Download ${todo.length} enriched item(s) from ${authLine}\n`
      + `in batches of ${ROTATE_CHUNK}, switching the Proton VPN to a fresh US exit between batches.\n\n`
      + `• ${exitNow}\n`
      + `• Cookieless — your IG login is never used.\n`
      + `• Stops on the first batch that downloads nothing, or when no enriched rows remain.\n`
      + `• Press ⏹ Stop any time.`)) return;

    let totalOk = 0, batches = 0, switches = 0, endMsg = '';
    busy = true; setBatchUi(true);
    // (dev0650) Bring a tunnel up BEFORE batch 1 if none is live, so no batch ever
    // downloads on the home IP (user request).
    if (!(vpnStatus && vpnStatus.tunnelUp)) {
      igBatchShow('🔀 bringing up a Proton VPN exit before batch 1…');
      const sw0 = await vpnEnsureUp('bringing up the first exit');
      if (sw0) { switches++; igToast(`🟢 VPN → ${sw0.server || sw0.ip || '?'}${sw0.ip ? '  ' + sw0.ip : ''}`, 3000); }
      else {
        busy = false; setBatchUi(false); igBatchHide();
        igStickyShow('⏹ Stopped before downloading — no VPN exit would come up (tried a few).\nNothing was downloaded on your home IP. Check the VPN, then retry.');
        return;
      }
    }
    while (!batchAbort) {
      todo = readyIds();
      if (!todo.length) { endMsg = `✓ Done — no more enriched rows to download in this view.`; break; }
      const chunk = todo.slice(0, ROTATE_CHUNK);
      batches++; lastDlName = '';
      // runBatch owns its own busy/UI/abort + per-item live panel; it resets
      // batchAbort at its start, so we re-check batchAbort AFTER it returns.
      const okThis = await runBatch(`Downloading (batch ${batches})`, chunk, DOWNLOAD_GAP,
        r => downloadRow(r, false), isDownloaded, '🍪 cookieless — your IG login is never used');
      totalOk += okThis;
      igStickyHide();                 // suppress runBatch's per-chunk report — we toast instead
      if (batchAbort) { endMsg = `⏹ Stopped by you — ${totalOk} downloaded across ${batches} batch${batches === 1 ? '' : 'es'}.`; break; }
      if (okThis === 0) {             // a whole batch got nothing → a wall/login, not an IP block
        endMsg = `⏹ Batch ${batches} downloaded 0 — stopped.\n${totalOk} downloaded before this. Likely a login wall or a blocked exit — try again later or check the VPN.`;
        break;
      }
      const remain = readyIds().length;
      // auto-dismissing success toast: cumulative + most recent (the user's ask)
      igToast(`✓ Batch ${batches}: ${okThis} downloaded  ·  ${totalOk} total`
        + (lastDlName ? `\nlast: ${lastDlName}` : '')
        + (remain ? `\n${remain} enriched still to go — 🔀 switching VPN…` : ''), 4200);
      if (!remain) { endMsg = `✓ Done — ${totalOk} downloaded across ${batches} batch${batches === 1 ? '' : 'es'}; no enriched rows left.`; break; }
      // switch exits before the next batch
      busy = true; setBatchUi(true);
      igBatchShow(`🔀 switching Proton VPN before batch ${batches + 1}…\n${totalOk} downloaded so far`);
      const sw = await vpnEnsureUp(`switching after batch ${batches}`);
      if (sw) { switches++; igToast(`🟢 VPN → ${sw.server || sw.ip || '?'}${sw.ip ? '  ' + sw.ip : ''}`, 3000); }
      else {
        // Never download on the home IP — the user wants everything through a VPN.
        endMsg = `⏹ Stopped — couldn't get a working VPN exit after batch ${batches} (tried a few).\n${totalOk} downloaded, all through a VPN. NOT continuing on your home IP.`;
        break;
      }
      await sleep(1500);
    }
    busy = false; setBatchUi(false); igBatchHide();
    await vpnRefresh(false);
    const exit = vpnStatus && vpnStatus.tunnelUp ? (vpnStatus.server || vpnStatus.ip || '?') : 'no tunnel';
    igStickyShow((endMsg || `Finished — ${totalOk} downloaded.`)
      + `\n\n${switches} VPN switch${switches === 1 ? '' : 'es'}  ·  current exit: ${exit}`);
  }

  // ── Promote → ml.json ───────────────────────────────────────────────────────
  function promoteRow(r, single) {
    if (r.status === 'promoted') { igToast(r.id + ' already promoted (UID ' + r.mlUID + ')', 2200); return null; }
    if (typeof data === 'undefined' || typeof nextUID !== 'function' || typeof save !== 'function') {
      igToast('ml.json not loaded — open the T screen first', 3000); return null;
    }
    const now = (typeof isoNow === 'function') ? isoNow() : new Date().toISOString().slice(0, 19).replace('T', ' ');
    const mlRow = {
      UID: nextUID(),
      link: r.url,
      VidTitle: r.VidTitle || '',
      VidAuthor: r.VidAuthor || ('@' + r.author),
      ftext: r.ftext || '',
      ttxt: r.ttxt || '',
      vidLength: r.durSecs ? fmtDur(r.durSecs) : '',
      DatePosted: r.DatePosted || '',
      show: '1',
      DateAdded: now,
      DateModified: now,
      DevComment: r.DevComment || '',   // (dev0471) curated filename note from ffdown import
      tags: [],
      igSource: r.id            // provenance: which ig.json row this came from
    };
    data.push(mlRow);
    save();
    r.status = 'promoted';
    r.mlUID = mlRow.UID;
    dirty = true;
    if (single) { applyAndRender(); persist(false); igToast('➕ promoted ' + r.id + ' → ml.json UID ' + mlRow.UID, 2400); }
    return mlRow;
  }

  function batchPromote() {
    const ids = selectedInView().filter(id => { const r = rowById(id); return r && r.status !== 'promoted'; });
    if (!ids.length) { igToast('Select un-promoted rows first', 2000); return; }
    if (!confirm(`Promote ${ids.length} row(s) into ml.json?\nThey'll become real rows in T/G.`)) return;
    let ok = 0;
    for (const id of ids) { const r = rowById(id); if (r && promoteRow(r, false)) ok++; }
    dirty = true;
    persist(false);
    applyAndRender();
    igToast(`➕ promoted ${ok} row(s) → ml.json`, 2600);
  }

  // ── (dev0609) Create → one P12 grid in c.json ────────────────────────────────
  // Takes the 12 rows starting at the focused row (or the top of the current
  // view when nothing is focused) and writes them as a single c.json config with
  // cells:12 — the 2×6 portrait layout, which suits IG reels' 9:16 shape.
  //
  // The cells hold each row's IG LINK rather than an ml.json UID, so a grid can
  // be thrown together straight from the harvest with no Promote step. G reads
  // that shape via _gridLinkCellRow (grid.js); if a link later gains an ml.json
  // row, the cell adopts it automatically and picks up its ftext/tags.
  const IG_GRID_CELLS = 12;

  function createGridFromView() {
    if (!view.length) { igToast('Nothing in view to build a grid from', 2000); return; }
    if (typeof _cEnsureLoaded !== 'function' || typeof cSaveToFile !== 'function') {
      igToast('c.json not available — open the C screen once first', 3000); return;
    }
    const start = focusId != null ? Math.max(0, view.findIndex(r => r.id === focusId)) : 0;
    const picked = view.slice(start, start + IG_GRID_CELLS).filter(r => r && r.url);
    if (!picked.length) { igToast('No rows with a URL from here down', 2200); return; }

    const first = picked[0];
    const dflt = 'IG ' + (first.author || 'mixed') + ' ' + new Date().toISOString().slice(0, 10);
    const gname = (prompt('Grid name for these ' + picked.length + ' row(s):', dflt) || '').trim();
    if (!gname) return;

    const now = (typeof isoNow === 'function') ? isoNow()
      : new Date().toISOString().slice(0, 19).replace('T', ' ');
    const cfg = { gname: gname, cells: IG_GRID_CELLS, Zoom: 1, DateAdded: now, DateModified: now };
    // Fill 1a..1f then 2a..2f — the same cell list G renders P12 from. Short
    // picks leave the tail cells blank rather than shrinking the layout.
    const cellList = (typeof _gridCellList === 'function' && typeof _gridPortraitDims === 'function')
      ? _gridCellList(5, 'P' + IG_GRID_CELLS).map(s => s.cs)
      : ['1a','1b','1c','1d','1e','1f','2a','2b','2c','2d','2e','2f'];
    cellList.forEach((cs, i) => { cfg[cs] = picked[i] ? picked[i].url : ''; });

    _cEnsureLoaded().then(async () => {
      const arr = (typeof _cData !== 'undefined' && Array.isArray(_cData)) ? _cData : null;
      if (!arr) { igToast('c.json did not load — cannot save the grid', 3000); return; }
      const at = arr.findIndex(c => c && String(c.gname || '').trim() === gname);
      if (at >= 0) {
        if (!confirm('A grid named "' + gname + '" already exists.\nOverwrite it?')) return;
        cfg.DateAdded = arr[at].DateAdded || now;
        arr[at] = cfg;
      } else {
        arr.push(cfg);
      }
      if (typeof _gridConfigs !== 'undefined') _gridConfigs = arr;
      const ok = await cSaveToFile();
      igToast(ok
        ? '🔲 "' + gname + '" → c.json (' + picked.length + ' of 12 cells, P12)\nOpen it from the C screen.'
        : '⚠ "' + gname + '" saved to localStorage only — re-grant the project folder', 3400);
    });
  }

  // (dev0498) Permanently remove the selected rows from ig.json. For pruning the
  // occasional bad harvest entry. No archive — a confirm guards it; downloaded
  // media files in ig_media/ are left on disk untouched.
  function deleteSelected() {
    if (busy) return;
    const ids = selectedInView();
    if (!ids.length) { igToast('Nothing checked in this view.\nCheck the rows to delete first.', 3000); return; }
    if (!confirm(`Delete ${ids.length} row(s) from ig.json?\nThis removes the entries permanently (no archive).\nAny already-downloaded files in ig_media/ are left on disk.`)) return;
    const idset = new Set(ids);
    rows = rows.filter(r => !idset.has(r.id));
    ids.forEach(id => { sel.delete(id); if (focusId === id) focusId = null; });
    if (focusId == null && drawerOpen()) closeDrawer();
    lastCheckedId = null;
    dirty = true;
    persist(false);
    applyAndRender();
    igToast(`🗑 deleted ${ids.length} row(s) from ig.json`, 2600);
  }

  // (dev0513) Reset a row to "new" so a fresh Enrich + Download rebuilds it with the
  // current code (new filename W×H + species-name title, jpg cover). Clears only the
  // AUTO-derived fields — VidTitle, W×H, duration, the stale cover URL and the
  // downloaded-file record — and KEEPS the caption (ftext/ttxt), which may be curated.
  // Clearing VidTitle is what lets re-Enrich re-derive the title (it's guarded by
  // `if (!r.VidTitle)`); nulling localFiles is what lets a batch re-Download it (the
  // batch skips rows isDownloaded() reports true for). "✕ Clear sel" only unchecks —
  // it never touched status — so this is the dedicated re-try.
  function resetRow(r) {
    if (!r) return;
    r.status = 'new';
    delete r.VidTitle; delete r.width; delete r.height; delete r.localFiles; delete r.igImage;
    r.durSecs = null;
    enrichFailed.delete(r.id);
  }
  function resetSelected() {
    if (busy) return;
    const ids = selectedInView();
    if (!ids.length) { igToast('Nothing checked in this view.\nCheck the rows to reset, then ↺ Reset.', 3000); return; }
    if (!confirm(`Reset ${ids.length} row(s) to "new"?\n\n`
      + `Clears the derived title, W×H, duration, cover preview and the downloaded-file `
      + `record so a fresh Enrich + Download rebuilds them (new filename + jpg cover).\n`
      + `The caption (ftext / ttxt) is kept.\n\n`
      + `Then: ✨ Enrich the selection, then ⬇ Download.`)) return;
    let n = 0;
    ids.forEach(id => { const r = rowById(id); if (r) { resetRow(r); n++; } });
    dirty = true; persist(false); applyAndRender();
    if (drawerOpen() && focusId != null) { const fr = rowById(focusId); if (fr) openDrawer(fr); }
    igToast(`↺ reset ${n} row(s) to "new"\nNow ✨ Enrich, then ⬇ Download to apply the new filename + jpg cover`, 4200);
  }

  function setBatchUi(on) {
    ['igEnrichSel', 'igDownloadSel', 'igPromoteSel', 'igCreateGrid', 'igDeleteSel', 'igClearSel', 'igResetSel', 'igReload', 'igPaste', 'igFfdown'].forEach(id => {
      const b = document.getElementById(id); if (b) b.disabled = on;
    });
    // (dev0437) Stop now lives in the centered batch panel (igBatchShow), so the
    // top bar no longer toggles a button — that toggle reflowed the header row.
  }

  // ── Firefox "Save Page As Text" → ttxt (the manual, unflaggable rich path) ──
  // The literal save happens in the user's Firefox (the I screen, a localhost page,
  // can't read instagram.com's logged-in DOM). Here we just take that saved text and
  // apply it to the matching ig.json row — reusing the SAME core.js parser the W
  // screen uses (_parseIgSavedText / _igTtxtHtml / _igCaptionFtext), so the ttxt is
  // identical, just targeted at ig.json instead of ml.json.
  let _pasteTarget = null;     // row pre-targeted by the drawer button (else route by id)
  function openPasteModal(targetRow) {
    _pasteTarget = targetRow || null;
    const hint = document.getElementById('igModalHint');
    if (hint) hint.textContent = targetRow
      ? 'Pasting for row ' + targetRow.id + '. In Firefox: open the reel → Save Page As ▸ Text → paste it here.'
      : 'In Firefox: open the reel → Save Page As ▸ Text Files → open that .txt → paste it here. Routes to the row by reel id; comments + sibling URLs land in ttxt.';
    document.getElementById('igModalText').value = '';
    document.getElementById('igModalBack').classList.add('open');
    setTimeout(() => document.getElementById('igModalText').focus(), 30);
  }
  function closePasteModal() {
    document.getElementById('igModalBack').classList.remove('open');
    _pasteTarget = null;
  }
  function modalOpen() { return document.getElementById('igModalBack')?.classList.contains('open'); }

  async function applyPaste() {
    const txt = document.getElementById('igModalText').value || '';
    if (typeof _parseIgSavedText !== 'function') { igToast('IG parser not loaded', 2500); return; }
    if (typeof _looksLikeIgSavedText === 'function' && !_looksLikeIgSavedText(txt)) {
      if (!confirm("That doesn't look like an Instagram saved page. Try parsing it anyway?")) return;
    }
    if (typeof _ensureCommonWords === 'function') await _ensureCommonWords();
    let p;
    try { p = _parseIgSavedText(txt); } catch (e) { igToast('Parse failed: ' + e.message, 3000); return; }

    // Resolve the target row: the drawer pre-target wins; else match by parsed reel id.
    let row = _pasteTarget || (p.currentId ? rowById(p.currentId) : null);
    if (row && p.currentId && row.id !== p.currentId) {
      if (!confirm('Saved text is for reel ' + p.currentId + ', but this row is ' + row.id + '.\nApply to this row anyway?')) return;
    }
    if (!row && p.currentId) {
      igToast('No ig.json row for reel ' + p.currentId + ' (harvest it first).\nParsed @' + (p.handle || '?') + ' · ' + p.comments.length + ' comments.', 5000);
      return;
    }
    if (!row) { igToast('No current reel id found in the text, and no row was pre-selected.', 4000); return; }

    const parts = [];
    if (!row.VidTitle && p.caption) { row.VidTitle = _smartIgTitle(p.caption); parts.push('VidTitle'); }
    if (!row.VidAuthor && p.handle) { row.VidAuthor = '@' + p.handle; parts.push('VidAuthor'); }
    const isStub = /^<p><a [^>]*>https?:\/\/[^<]+<\/a><\/p>$/.test((row.ftext || '').trim());
    if ((!row.ftext || isStub) && p.caption && typeof _igCaptionFtext === 'function') { row.ftext = _igCaptionFtext(p.caption); parts.push('ftext'); }
    row.ttxt = _igTtxtHtml(p); parts.push('ttxt');           // rich dump always wins (it's the prize)
    if (row.status === 'new' || !row.status) row.status = 'enriched';
    dirty = true;
    const sib = p.reels.filter(x => x.id !== p.currentId).length;
    const hadTarget = !!_pasteTarget;
    closePasteModal();
    applyAndRender();
    persist(false);
    if (focusId === row.id || hadTarget) openDrawer(row);
    igToast('✓ saved-text → ' + row.id + ' [' + parts.join(', ') + ']\n@' + (p.handle || '?') + ' · ' + p.comments.length + ' comments · ' + sib + ' sibling reels in ttxt', 5000);
  }

  // ── Bulk import: ffdown/*.txt → ig.json (dev0471) ───────────────────────────
  // Reuses the SAME core.js parser as the paste path (so ttxt is identical), but:
  //   • author CAPTION only — others' comments dropped (user folds useful ones into
  //     the .txt filename label by hand, e.g. a scientific name);
  //   • filename "Instagram <label>.txt" → <label> → DevComment;
  //   • rows marked staged:false / source:'ffdown' → group under "NonStaged" in the
  //     author facet, kept out of the harvested full-reel authors;
  //   • status:'enriched' (text already has title/author/caption) so bulk Enrich
  //     skips them → zero yt-dlp call → zero IG wall/throttle exposure.
  function ffdownLabel(name) {
    return String(name || '').replace(/\.txt$/i, '').replace(/^Instagram\d*\s*/i, '').trim();
  }
  async function importFfdown() {
    if (typeof _parseIgSavedText !== 'function') { igToast('IG parser not loaded — open the T screen once first', 3500); return; }
    let files;
    try {
      const res = await fetch(PROXY + '/ig/ffdown', { method: 'POST' });
      const j = await res.json();
      if (!j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + res.status));
      files = j.files || [];
    } catch (e) { igToast('✗ couldn\'t read ffdown/: ' + (e && e.message) + '\n(Is proxy.js running & dev0462+?)', 4500); return; }
    if (!files.length) { igToast('No .txt files found in ffdown/', 2800); return; }
    if (typeof _ensureCommonWords === 'function') await _ensureCommonWords();

    const byId = new Map(rows.map(r => [r.id, r]));
    const now = (typeof isoNow === 'function') ? isoNow() : new Date().toISOString().slice(0, 19).replace('T', ' ');
    let created = 0, updated = 0, dup = 0, skipped = 0, redated = 0;
    for (const f of files) {
      let p;
      try { p = _parseIgSavedText(f.text || ''); } catch (_) { skipped++; continue; }
      if (!p.currentId) { skipped++; continue; }
      const label = ffdownLabel(f.name);
      // (dev0474) The .txt file's CREATION time becomes the row's Harvested date so a
      // Harvested sort surfaces the most-recently-saved text. Falls back to now if the
      // proxy is pre-dev0474 (no ctime field).
      const fileDate = f.ctime || now;
      // (dev0473) Ignore duplicates: a re-added .txt whose post is ALREADY imported
      // from ffdown with the SAME filename label (and has ttxt) is skipped untouched.
      // A changed label (or a still-bare harvested row) falls through and re-applies.
      const existing = byId.get(p.currentId);
      if (existing && existing.source === 'ffdown' && (existing.DevComment || '') === label && existing.ttxt) {
        // (dev0474) Retrospective: even an unchanged dup gets its Harvested date
        // re-stamped to the .txt creation time (so old imports sort correctly too).
        if (fileDate && existing.DateAdded !== fileDate) { existing.DateAdded = fileDate; redated++; }
        dup++; continue;
      }
      const noComments = Object.assign({}, p, { comments: [] });   // author only, per request
      const ttxt = (typeof _igTtxtHtml === 'function') ? _igTtxtHtml(noComments) : '';
      let r = existing;
      if (!r) {
        const reel = p.reels.find(x => x.id === p.currentId);
        const url = (reel && reel.url) || ('https://www.instagram.com/' + (p.handle || 'p') + '/p/' + p.currentId + '/');
        r = { id: p.currentId, url, author: p.handle || '', status: 'enriched', DateAdded: fileDate, source: 'ffdown' };
        rows.push(r); byId.set(r.id, r);
        created++;
      } else { r.DateAdded = fileDate; updated++; }   // (dev0474) re-stamp Harvested from .txt creation time
      if (!r.author && p.handle) r.author = p.handle;
      // (dev0476) Title = the curated filename label ("Instagram Sweetlips fish.txt"
      // → "Sweetlips fish"), NOT _smartIgTitle(caption). The saved-text caption starts
      // with IG UI chrome ("Verified", "More options"…), so smart-title produced the
      // bogus "Verified" for almost every ffdown row. Smart-title is the no-label fallback.
      if (label) r.VidTitle = label;
      else if (!r.VidTitle && p.caption && typeof _smartIgTitle === 'function') r.VidTitle = _smartIgTitle(p.caption);
      if (!r.VidAuthor && p.handle) r.VidAuthor = '@' + p.handle;
      const isStub = /^<p><a [^>]*>https?:\/\/[^<]+<\/a><\/p>$/.test((r.ftext || '').trim());
      if ((!r.ftext || isStub) && p.caption && typeof _igCaptionFtext === 'function') r.ftext = _igCaptionFtext(p.caption);
      if (ttxt) r.ttxt = ttxt;                 // author caption + bio + sibling reel URLs (no comments)
      if (label) r.DevComment = label;         // the curated filename note
      r.staged = false;                        // → "NonStaged" author group
      if (!r.source) r.source = 'ffdown';
      if (r.status === 'new' || !r.status) r.status = 'enriched';
    }
    dirty = true;
    refreshAuthorOptions();
    applyAndRender();
    await persist(false);
    igToast('📁 ffdown → ig.json: ' + created + ' new, ' + updated + ' updated'
      + (dup ? ', ' + dup + ' already-imported (skipped)' : '')
      + (redated ? ', ' + redated + ' re-dated' : '')
      + (skipped ? ', ' + skipped + ' skipped (no reel id)' : '')
      + '\nUnharvested · author caption only · DevComment from filename · Harvested = .txt creation time', 6500);
  }

  // ── Persist back to ig.json (proxy /ig/save) ────────────────────────────────
  async function persist(announce) {
    try {
      const res = await fetch(PROXY + '/ig/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows, knownIds: [...knownIds] })
      });
      const j = await res.json();
      if (!j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + res.status));
      dirty = false;
      updateCount();
      if (announce) igToast('💾 saved ig.json (' + j.total + ' rows)', 1800);
      // (dev0601) The proxy kept rows that were harvested while this screen sat open
      // — they're on disk but not in our rows[], so say so instead of leaving the
      // count looking wrong. Once per session, and never mid-batch auto-reload: a
      // reload here would reset a running enrich/download batch.
      if (j.rescued && !rescueNoted) {
        rescueNoted = true;
        igToast('↻ ' + j.rescued + ' row(s) harvested while this screen was open were'
          + ' kept (not shown here yet) — click ↻ Reload to see them.', 5000);
      }
      return true;
    } catch (e) {
      // (dev0529) A save failure is potential DATA LOSS, so NEVER swallow it — even in
      // batch/auto-enrich, which call persist(false). This is exactly what hid the
      // proxy's 16 MB body-cap rejection: enrich looked done on screen but nothing was
      // written, and edits vanished on the next reload. dirty stays true (only set
      // false on success) so the header keeps its ⚠ unsaved flag.
      igToast('✗ ig.json SAVE FAILED — edits NOT written to disk!\n' + (e && e.message)
        + '\nRestart proxy.js (dev0529+) & click 💾 Save. Do not reload/leave first.', 6500);
      return false;
    }
  }

  // Rebuild the author dropdown from the loaded rows (count per author), preserving
  // the current selection if it still exists.
  // (dev0471/0635) An author is "Unharvested" only while ALL their rows are singles
  // (staged===false — ffdown imports or 'w'-added clipboard posts); a single harvested
  // full-reel row promotes them to "Harvested" (the user's "unless already imported"
  // rule). Shared by the dropdown grouping and the class-level author filter so the two
  // never disagree.
  function unharvestedAuthorSet() {
    const only = {};
    rows.forEach(r => {
      const a = r.author || '';
      if (only[a] === undefined) only[a] = true;
      if (r.staged !== false) only[a] = false;
    });
    return new Set(Object.keys(only).filter(a => only[a]));
  }
  function refreshAuthorOptions() {
    const sel2 = document.getElementById('igAuthor');
    if (!sel2) return;
    const counts = {};
    rows.forEach(r => { const a = r.author || ''; counts[a] = (counts[a] || 0) + 1; });
    // Keep a valid selection: 'all' / the two class sentinels / a still-present author.
    if (authorFilter !== 'all' && authorFilter !== '__harvested__'
        && authorFilter !== '__unharvested__' && !counts[authorFilter]) authorFilter = 'all';
    const unh = unharvestedAuthorSet();
    const all = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const harvested = all.filter(a => !unh.has(a));
    const unharvested = all.filter(a => unh.has(a));
    const nH = harvested.reduce((n, a) => n + counts[a], 0);
    const nU = unharvested.reduce((n, a) => n + counts[a], 0);
    const opt = a => `<option value="${esc(a)}">${esc(a || '(none)')} (${counts[a]})</option>`;
    let html = '<option value="all">all authors (' + rows.length + ')</option>';
    // (dev0635) Optgroup labels aren't selectable, so these two options let you pick a
    // whole CLASS and see every row in it (the user's "click Unharvested → show all").
    if (nH) html += `<option value="__harvested__">▸ Harvested authors — all (${nH})</option>`;
    if (nU) html += `<option value="__unharvested__">▸ Unharvested authors — all (${nU})</option>`;
    if (harvested.length) html += '<optgroup label="Harvested authors (full reels)">' + harvested.map(opt).join('') + '</optgroup>';
    if (unharvested.length) html += '<optgroup label="Unharvested authors (singles)">' + unharvested.map(opt).join('') + '</optgroup>';
    sel2.innerHTML = html;
    sel2.value = authorFilter;
  }

  // ── Load ────────────────────────────────────────────────────────────────────
  async function loadData() {
    try {
      const r = await fetch(STORE_URL());
      rows = r.ok ? (await r.json()) : [];
      if (!Array.isArray(rows)) rows = [];
    } catch (e) { rows = []; igToast('Could not load ig.json: ' + e.message, 3000); }
    // (dev0601) Re-stamp the "ever seen" set from what we just loaded. A reload is
    // exactly the point where a mid-session harvest becomes visible to us, so rows
    // rescued by the proxy up to now are folded in here and become deletable again.
    knownIds = new Set(rows.map(r => r && r.id).filter(Boolean));
    rescueNoted = false;
    igPreviewClose();   // (dev0500) old previewed row is gone after a reload
    sel.clear(); dirty = false; lastCheckedId = null; focusId = null; enrichFailed.clear();   // (dev0441) fresh retry after reload; (dev0474) clear row focus
    refreshAuthorOptions();
    applyAndRender();
  }

  // ── Moveable media preview (dev0500) ────────────────────────────────────────
  // Ctrl+I pops a DRAGGABLE PORTRAIT window that plays the focused row's already-
  // DOWNLOADED ig_media asset (video or image; multi-file carousels get ‹ › nav).
  // Same idea/size as the T-screen row-preview pane (core.js) but portrait, since
  // IG reels/posts are 9:16. Files live in ig_media/ and are served by the same
  // :8080 origin as ig.json, so a relative URL works.
  //   • Ctrl+I on a DOWNLOADED row → open/refresh the window (re-press = close).
  //   • Ctrl+I on a NOT-downloaded row → open that post on Instagram in the
  //     browser (identical to clicking its address) — no window.
  //   • While open it follows ↑/↓ row focus; a non-downloaded focused row shows a
  //     placeholder (only the explicit Ctrl+I press ever opens the browser).
  const PV_VIDEO_RE = /\.(mp4|webm|mov|m4v|mkv)$/i;
  const PV_IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp|avif|tiff?)$/i;
  const mediaUrl = name => 'ig_media/' + encodeURIComponent(name);
  let pvOpen = false;        // preview window mounted
  let pvRowId = null;        // row id currently shown
  let pvIdx = 0;             // carousel index into the row's localFiles
  let pvPos = null;          // {left,top} remembered across toggles + moves
  let pvDrag = null;         // active drag offset

  function igPreviewBuild() {
    if (document.getElementById('igPreview')) return;
    const el = document.createElement('div');
    el.id = 'igPreview';
    el.innerHTML =
      '<div id="igPvBar">'
      + '<span id="igPvNav"></span>'
      + '<span id="igPvTitle"></span>'
      + '<button id="igPvClose" title="Close (Ctrl+I or Esc)">×</button>'
      + '</div>'
      + '<div id="igPvBody"></div>';
    const pos = pvPos || { left: 24, top: 84 };
    el.style.left = pos.left + 'px';
    el.style.top = pos.top + 'px';
    (document.getElementById('igOverlay') || document.body).appendChild(el);
    el.querySelector('#igPvClose').addEventListener('click', igPreviewClose);
    el.querySelector('#igPvNav').addEventListener('click', e => {
      const d = e.target.closest('button')?.dataset.d;
      if (d === 'prev') igPreviewStep(-1);
      else if (d === 'next') igPreviewStep(1);
    });
    el.querySelector('#igPvBar').addEventListener('pointerdown', pvDragStart);
  }

  function igPreviewToggle() {
    const r = focusId != null ? rowById(focusId) : null;
    if (!r) { igToast('👁 Focus a row first (↑/↓ or click), then Ctrl+I', 2400); return; }
    // Not downloaded → open the post on Instagram (same as clicking its address).
    if (!isDownloaded(r)) {
      window.open(igLink(r), '_blank', 'noopener');
      igToast('↗ ' + r.id + ' not downloaded — opened on Instagram', 2600);
      return;
    }
    if (pvOpen && pvRowId === r.id) { igPreviewClose(); return; }   // re-press = close
    pvOpen = true; pvRowId = r.id; pvIdx = 0;
    igPreviewBuild();
    igPreviewFill();
  }

  // (dev0500) Follow ↑/↓ row focus while the window is open. A non-downloaded row
  // shows a placeholder rather than auto-opening the browser (that's Ctrl+I only).
  function igPreviewSyncToFocus() {
    if (!pvOpen || focusId == null || focusId === pvRowId) return;
    if (!rowById(focusId)) return;
    pvRowId = focusId; pvIdx = 0;
    igPreviewFill();
  }

  function igPreviewStep(delta) {
    const r = rowById(pvRowId); if (!r) return;
    const n = (r.localFiles || []).length; if (n <= 1) return;
    pvIdx = (pvIdx + delta + n) % n;
    igPreviewFill();
  }

  function igPreviewFill() {
    const el = document.getElementById('igPreview'); if (!el) return;
    const r = rowById(pvRowId);
    const body = el.querySelector('#igPvBody');
    const oldV = body.querySelector('video'); if (oldV) { try { oldV.pause(); } catch (_) {} }
    if (!r) { igPreviewClose(); return; }
    const files = r.localFiles || [];
    const n = files.length;
    if (pvIdx >= n) pvIdx = 0;

    const title = el.querySelector('#igPvTitle');
    title.textContent = r.VidTitle || r.id;
    title.title = (r.VidTitle ? r.VidTitle + '  ·  ' : '') + r.id;

    const nav = el.querySelector('#igPvNav');
    nav.innerHTML = n > 1
      ? '<button data-d="prev" title="Previous">‹</button>'
        + '<span class="ct">' + (pvIdx + 1) + '/' + n + '</span>'
        + '<button data-d="next" title="Next">›</button>'
      : '';

    body.innerHTML = '';
    if (!n) {
      const ph = document.createElement('div');
      ph.className = 'igPvPlace';
      ph.innerHTML = isDownloaded(r)
        ? '⚠ no media files listed for ' + esc(r.id)
        : esc(r.id) + ' is not downloaded yet<br><span>⬇ Download it, or press Ctrl+I to open it on Instagram</span>';
      body.appendChild(ph);
      return;
    }
    const f = files[pvIdx];
    if (PV_VIDEO_RE.test(f)) {
      const v = document.createElement('video');
      v.src = mediaUrl(f);
      v.controls = true; v.loop = true; v.autoplay = true; v.playsInline = true;
      v.addEventListener('click', () => { if (v.paused) v.play().catch(() => {}); else v.pause(); });
      body.appendChild(v);
      // Best-effort autoplay with sound; if the browser blocks it, retry muted
      // (the native controls let the user unmute).
      v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
    } else if (PV_IMAGE_RE.test(f)) {
      const img = document.createElement('img');
      img.src = mediaUrl(f);
      img.alt = r.id;
      body.appendChild(img);
    } else {
      const d = document.createElement('div');
      d.className = 'igPvPlace';
      d.innerHTML = 'Unsupported file<br><span>' + esc(f) + '</span>';
      body.appendChild(d);
    }
  }

  function igPreviewClose() {
    const el = document.getElementById('igPreview');
    if (el) {
      const v = el.querySelector('video');
      if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) {} }
      el.remove();
    }
    pvOpen = false; pvRowId = null; pvIdx = 0;
  }

  // Drag by the title bar (pointer events → preview-verifiable, mirrors the rest
  // of the app). Position is clamped on-screen and remembered in pvPos so a
  // re-opened window stays where you left it.
  function pvDragStart(e) {
    if (e.target.closest('button')) return;       // don't drag when hitting ×/‹/›
    const el = document.getElementById('igPreview'); if (!el) return;
    const rect = el.getBoundingClientRect();
    pvDrag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    el.addEventListener('pointermove', pvDragMove);
    el.addEventListener('pointerup', pvDragEnd);
    e.preventDefault();
  }
  function pvDragMove(e) {
    if (!pvDrag) return;
    const el = document.getElementById('igPreview'); if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = Math.max(2, Math.min(window.innerWidth - w - 2, e.clientX - pvDrag.dx));
    let top = Math.max(2, Math.min(window.innerHeight - h - 2, e.clientY - pvDrag.dy));
    el.style.left = left + 'px'; el.style.top = top + 'px';
    pvPos = { left, top };
  }
  function pvDragEnd(e) {
    pvDrag = null;
    const el = document.getElementById('igPreview'); if (!el) return;
    try { el.releasePointerCapture(e.pointerId); } catch (_) {}
    el.removeEventListener('pointermove', pvDragMove);
    el.removeEventListener('pointerup', pvDragEnd);
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  function openIgScreen() {
    if (typeof _isUserMode === 'function' && _isUserMode()) return;   // dev-only
    build();
    document.getElementById('igOverlay').classList.add('open');
    loadData();
    vpnRefresh(false); vpnStartPoll();   // (dev0649) show the current Proton exit + keep it live
    // (dev0438) Come up UNFOCUSED so bare-letter hotkeys (f/F/c/…) work right
    // away; press f to jump into the filter box, Shift+F to clear it.
  }
  function closeIgScreen() {
    if (autoRunning && !autoPaused) autoPause('⏸ Auto-enrich paused — I screen closed. Reopen (I) and click a city or ▶ to resume.');  // (dev0517)
    if (dirty) persist(false);     // best-effort flush on close
    igPreviewClose();              // (dev0500) tear down the media preview
    closeDrawer();
    vpnStopPoll();                 // (dev0649) stop polling the VPN status
    document.getElementById('igOverlay')?.classList.remove('open');
  }
  function isIgScreenOpen() {
    return document.getElementById('igOverlay')?.classList.contains('open') || false;
  }

  // (dev0438) In-window key handling. Capture-phase; core.js's dispatcher (added
  // earlier) bails on f/c while Ig is open so they reach us here.
  //   Esc  → close modal / drawer / blur the filter (filter STAYS in force). Esc
  //          no longer closes the screen — press T to leave (T owns that).
  //   f    → focus the filter box.   Shift+F → clear the text filter.
  //   c    → toggle the "hide completed (downloaded) rows" filter.
  window.addEventListener('keydown', e => {
    if (!isIgScreenOpen()) return;
    const ae = document.activeElement;
    const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');
    // (dev0496) When a button (e.g. a toast's focused Stop / Close) has focus, let
    // Space / Enter activate it natively instead of stealing them for row selection.
    if (ae && ae.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;

    if (e.key === 'Escape') {
      if (igStickyOpen()) { e.stopPropagation(); e.preventDefault(); igStickyHide(); return; }  // (dev0444) dismiss summary first
      if (modalOpen()) { e.stopPropagation(); e.preventDefault(); closePasteModal(); return; }
      if (typing) { ae.blur(); e.stopPropagation(); e.preventDefault(); return; }  // blur, filter stays
      if (pvOpen) { e.stopPropagation(); e.preventDefault(); igPreviewClose(); return; }  // (dev0500) close media preview
      if (drawerOpen()) { e.stopPropagation(); e.preventDefault(); closeDrawer(); return; }
      e.stopPropagation(); e.preventDefault();   // swallow — do NOT return to T
      return;
    }
    // (dev0500) Ctrl+I → moveable media preview of the focused row's downloaded
    // asset (or open the post on Instagram if it isn't downloaded). Handled here on
    // window-capture, BEFORE core.js's document-capture Ctrl+I, and stopped hard so
    // core.js doesn't ALSO mount its T-screen row-preview behind this overlay.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'i' || e.key === 'I')) {
      if (typing) return;   // leave Ctrl+I (italic) alone inside the paste textarea
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      igPreviewToggle();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey || modalOpen()) return;

    // (dev0474) Row focus navigation. ↑/↓ move the focused (highlighted) row to the
    // prev/next visible row; Enter opens its detail drawer; Space toggles its
    // checkbox (handy for building a batch selection from the keyboard).
    if (e.key === 'ArrowDown') { e.stopPropagation(); e.preventDefault(); moveFocus(1); return; }
    if (e.key === 'ArrowUp')   { e.stopPropagation(); e.preventDefault(); moveFocus(-1); return; }
    if (e.key === 'Enter') {
      if (focusId != null) { e.stopPropagation(); e.preventDefault(); const r = rowById(focusId); if (r) openDrawer(r); }
      return;
    }
    if (e.key === ' ') {
      if (focusId != null) { e.stopPropagation(); e.preventDefault(); toggleFocusedSel(); }
      return;
    }

    if (e.key === 'f') {                          // focus the filter box
      e.stopPropagation(); e.preventDefault();
      document.getElementById('igSearch')?.focus();
      return;
    }
    if (e.key === 'F') {                          // Shift+F → clear text filter
      e.stopPropagation(); e.preventDefault();
      query = '';
      const s = document.getElementById('igSearch'); if (s) s.value = '';
      applyAndRender();
      igToast('🔎 text filter cleared', 1400);
      return;
    }
    // (dev0496) I-specific batch hotkeys (lowercase). These fire only while the I
    // screen is on top (the early isIgScreenOpen bail above), so D/E/C revert to the
    // normal Dictionary/Edit/Config screen hotkeys whenever I isn't frontmost.
    if (e.key === 'd') {                           // download selected
      e.stopPropagation(); e.preventDefault(); batchDownload(); return;
    }
    if (e.key === 'e') {                           // enrich selected
      e.stopPropagation(); e.preventDefault(); batchEnrich(); return;
    }
    if (e.key === 'c') {                           // clear selection
      e.stopPropagation(); e.preventDefault();
      sel.clear(); lastCheckedId = null; applyAndRender();
      igToast('Selection cleared (all rows, incl. any hidden by the filter)', 1600);
      return;
    }
    if (e.key === 'r') {                           // (dev0513) reset selected → new (re-try)
      e.stopPropagation(); e.preventDefault(); resetSelected(); return;
    }
    if (e.key === 'a') {                           // (dev0517) toggle the auto-enrich panel
      e.stopPropagation(); e.preventDefault(); toggleAutoPanel(); return;
    }
    if (e.key === 'm') {                           // clear, then select 18 from top
      e.stopPropagation(); e.preventDefault(); selectTopN(18); return;
    }
    if (e.key === 'w') {                           // (dev0635) clipboard IG URL → new Unharvested single
      e.stopPropagation(); e.preventDefault(); addUnharvestedFromClipboard(); return;
    }
    // (dev0496) Capital N/D/E/A → status filter new/downloaded/enriched/all
    // (identical to choosing from the dropdown, which now shows the hotkey letter).
    if (e.key === 'N') { e.stopPropagation(); e.preventDefault(); setStatusFilter('new'); return; }
    if (e.key === 'D') { e.stopPropagation(); e.preventDefault(); setStatusFilter('downloaded'); return; }
    if (e.key === 'E') { e.stopPropagation(); e.preventDefault(); setStatusFilter('enriched'); return; }
    if (e.key === 'A') { e.stopPropagation(); e.preventDefault(); setStatusFilter('all'); return; }
  }, true);

  window.openIgScreen = openIgScreen;
  window.closeIgScreen = closeIgScreen;
  window.isIgScreenOpen = isIgScreenOpen;
})();
