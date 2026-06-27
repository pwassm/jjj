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
  let view = [];                       // filtered + sorted slice of `rows`
  let sortCol = 'DateAdded', sortDir = -1;
  let query = '', kindFilter = 'all', statusFilter = 'all', authorFilter = 'all';
  let stagedFilter = 'all';            // (dev0472) all | non (NonFullReels/ffdown) | full (harvested)
  let hideCompleted = false;           // (dev0438) hotkey 'c' → hide downloaded ("completed") rows
  let sel = new Set();                 // selected ids (batch ops)
  let lastCheckedId = null;            // anchor for shift-click range selection
  let focusId = null;                  // row open in the detail drawer
  let processingId = null;             // (dev0445) row currently being enriched/downloaded (live highlight)
  let dirty = false;                   // unsaved enrich/promote/status edits
  let busy = false;                    // a batch op is running
  let batchAbort = false;              // user pressed Stop during a batch
  let lastOpError = '';                // last enrich/download error (for throttle detection)
  let lastOpInfo = '';                 // (dev0437) cookie posture of the last op ('cookieless'/'Firefox cookies')
  // (dev0441) Posts that FAILED cookieless enrich this session because they're
  // login-walled (yt-dlp can't read them without cookies). They keep status 'new'
  // — so without this they'd be re-hit on EVERY bulk Enrich, never succeeding and
  // showing no change. Bulk Enrich skips them after one attempt; ↻ Reload (or a
  // single ✨) retries. Session-only (not persisted) so a reload always re-tries.
  const enrichFailed = new Set();

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
`;
    document.head.appendChild(s);
  }

  // ── DOM scaffold ────────────────────────────────────────────────────────────
  function build() {
    injectCss();
    if (document.getElementById('igOverlay')) return;
    const o = document.createElement('div');
    o.id = 'igOverlay';
    o.innerHTML = `
      <div id="igBar">
        <h2>I · Ig staging</h2>
        <span class="ct" id="igCount"></span>
        <input type="text" id="igSearch" placeholder="search author / id / title / caption…">
        <select id="igAuthor" title="Filter by author"><option value="all">all authors</option></select>
        <select id="igKind"><option value="all">all kinds</option><option value="reel">reels</option><option value="p">posts /p</option><option value="tv">tv</option></select>
        <select id="igStatus"><option value="all">all status (A)</option><option value="new">new (N)</option><option value="enriched">enriched (E)</option><option value="downloaded">downloaded (D)</option><option value="promoted">promoted</option></select>
        <select id="igStaged" title="Full reels (harvested) vs NonFullReels (ffdown imports)"><option value="all">all sources</option><option value="non">NonFullReels</option><option value="full">Full reels</option></select>
        <div class="igActs">
        <button id="igPaste" title="Paste a Firefox 'Save Page As Text' of a reel → fills that row's ttxt/caption">📋 Paste saved-text</button>
        <button id="igFfdown" title="Bulk-import every ffdown/*.txt saved IG page → ig.json (author caption only, marked NonStaged, DevComment from the filename)">📁 Import ffdown</button>
        <button id="igEnrichSel" title="Enrich selected (hotkey E)">✨ Enrich sel</button>
        <button id="igDownloadSel" title="Download selected (hotkey D)">⬇ Download sel</button>
        <button id="igPromoteSel">➕ Promote sel</button>
        <button id="igDeleteSel" title="Permanently remove the selected rows from ig.json (after confirm)">🗑 Delete sel</button>
        <button id="igClearSel" title="Unselect everything, including rows hidden by the current filter (hotkey C)">✕ Clear sel</button>
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
    $('igDownloadSel').addEventListener('click', () => batchDownload());
    $('igPromoteSel').addEventListener('click', () => batchPromote());
    $('igDeleteSel').addEventListener('click', () => deleteSelected());
    $('igClearSel').addEventListener('click', () => { sel.clear(); lastCheckedId = null; applyAndRender(); igToast('Selection cleared (all rows, incl. any hidden by the filter)', 1600); });
    $('igReload').addEventListener('click', () => loadData());
    $('igSave').addEventListener('click', () => persist(true));
    $('igClose').addEventListener('click', () => closeIgScreen());
    $('igDrawerClose').addEventListener('click', () => closeDrawer());
    $('igPaste').addEventListener('click', () => openPasteModal(null));
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
    view = rows.filter(r => {
      if (authorFilter !== 'all' && r.author !== authorFilter) return false;
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
        <td><span class="s-${st}">${st}</span>${(st === 'new' && enrichFailed.has(r.id)) ? '<span class="walled" title="Cookieless enrich failed this session — login-walled. Download uses Firefox cookies, or 📋 Saved-text; ↻ Reload to retry bulk enrich."> ⚠</span>' : ''}</td>
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
        ${r.source ? `<b>Source</b><span>${esc(r.source)}${r.staged === false ? ' · NonStaged' : ''}</span>` : ''}
        ${r.DevComment ? `<b>DevComment</b><span>${esc(r.DevComment)}</span>` : ''}
        ${r.mlUID ? `<b>ml UID</b><span>${esc(r.mlUID)}</span>` : ''}
        ${r.localFiles && r.localFiles.length ? `<b>File</b><span>📁 ${esc(r.localFiles.join(', '))}</span>` : ''}
      </div>
      <div class="sect"><b>Download filename ${(r.durSecs == null || r.width == null) ? '<span style="color:#d59a3a;font-weight:400">— finalizes after Enrich</span>' : ''}</b>
        <div class="fname">${esc(downloadName(r))}.mp4</div></div>
      <div class="acts">
        <button data-d="enrich" class="primary">✨ Enrich</button>
        <button data-d="download">⬇ Download</button>
        <button data-d="paste">📋 Saved-text</button>
        <button data-d="promote" ${r.status === 'promoted' ? 'disabled' : ''}>➕ Promote</button>
        <button data-d="open">↗ Instagram</button>
      </div>
      <div class="sect"><b>ftext (clean caption)</b><div class="ftext">${r.ftext || '<span class="no">— not enriched —</span>'}</div></div>
      <div class="sect"><b>ttxt (full info)</b><div class="ttxt">${r.ttxt || '<span class="no">— none —</span>'}</div></div>
    `;
    const body = document.getElementById('igDrawerBody');
    body.querySelectorAll('.acts button').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.d;
      if (a === 'enrich') enrichRow(r, true).then(() => openDrawer(r));
      else if (a === 'download') downloadRow(r, true).then(() => openDrawer(r));
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
      const good = await doOne(r);
      if (good) {
        ok++;
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
    const couldntRead = fail;                  // attempted, failed cookieless AND cookie
    const notReached  = total - done;          // never attempted (stopped early)
    const head = throttled     ? `⏸ ${label} stopped — IG rate-limit detected`
               : cookieStopped ? `⏹ ${label} auto-stopped — 🍪 cookie used (cap ${COOKIE_CAP})`
               : walledStopped ? `⏹ ${label} auto-stopped — first login-walled post`
               : batchAbort    ? `⏹ ${label} stopped by you`
               : couldntRead   ? `✓ ${label} done — ${ok}/${total} read`
               :                 `✓ ${label} complete`;
    const lines = [
      head,
      ``,
      `${total} marked to do`,
      `${cookieless} read cookielessly  (account-safe)`,
      `🍪 cookies off — your IG account was never used`,
    ];
    if (couldntRead) lines.push(`${couldntRead} couldn't be read  (login-walled)`);
    if (notReached)  lines.push(`${notReached} not reached  (run stopped early)`);
    lines.push(`⏱ total time ${fmtClock(Date.now() - t0)}${ok ? '   ·   ' + fmtSpeed() : ''}`);
    if (throttled)          lines.push('', 'Wait a few minutes, then re-run — only un-done rows are retried.');
    else if (cookieStopped) lines.push('', 'Stopped after 1 Firefox-cookie use (your account-safety setting).',
                                           'Re-run to continue — the cap resets each run.');
    else if (walledStopped) lines.push('', 'Stopped at the first login-walled post (your account-safety setting).',
                                           'Re-run to step past it, or use 📋 Saved-text. Cookieless rows before it are done.');
    else if (couldntRead)   lines.push('', `These ${couldntRead} are login-walled — spacing or order won't read them.`,
                                           `Use 📋 Saved-text, or check Firefox is logged into Instagram.`);
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

  // ── Download (max res → ig_media/ named per AHK convention) ─────────────────
  async function downloadRow(r, single) {
    // Need title/duration/res for the filename → enrich first if missing.
    if (!r.VidTitle || r.durSecs == null || r.width == null) {
      const ok = await enrichRow(r, false);
      if (!ok && !r.VidTitle) { if (single) igToast('✗ ' + r.id + ': enrich failed, cannot name file', 3200); return false; }
      applyAndRender();
    }
    try {
      if (single) igToast('⏳ Downloading ' + r.id + '…\n🍪 cookieless for video; image carousels use Firefox cookies (gallery-dl)\nmax res — can take a bit', 12000);
      const res = await fetch(PROXY + '/ig/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: r.id, url: r.url, name: downloadName(r) })
      });
      const j = await res.json();
      if (!j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + res.status));
      r.localFiles = j.files || [];
      if (r.status !== 'promoted') r.status = 'downloaded';
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
      + `• Video carousels download cookieless. IMAGE carousels use your Firefox cookies (gallery-dl) — IG login-walls those cookieless. Auto-stops at the first cookie use (re-run to continue).\n`
      + `• Press ⏹ Stop any time.`)) return;
    await runBatch('Downloading', ids, DOWNLOAD_GAP, r => downloadRow(r, false), isDownloaded,
      '🍪 cookieless for video — image carousels use Firefox cookies (gallery-dl)');
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

  function setBatchUi(on) {
    ['igEnrichSel', 'igDownloadSel', 'igPromoteSel', 'igDeleteSel', 'igClearSel', 'igReload', 'igPaste', 'igFfdown'].forEach(id => {
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
      + '\nNonStaged · author caption only · DevComment from filename · Harvested = .txt creation time', 6500);
  }

  // ── Persist back to ig.json (proxy /ig/save) ────────────────────────────────
  async function persist(announce) {
    try {
      const res = await fetch(PROXY + '/ig/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows })
      });
      const j = await res.json();
      if (!j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + res.status));
      dirty = false;
      updateCount();
      if (announce) igToast('💾 saved ig.json (' + j.total + ' rows)', 1800);
      return true;
    } catch (e) {
      if (announce) igToast('✗ save failed: ' + (e && e.message) + '\n(Is proxy.js running & dev0429+?)', 4000);
      return false;
    }
  }

  // Rebuild the author dropdown from the loaded rows (count per author), preserving
  // the current selection if it still exists.
  function refreshAuthorOptions() {
    const sel2 = document.getElementById('igAuthor');
    if (!sel2) return;
    // (dev0471) An author is "NonStaged" only while ALL their rows are ffdown
    // (staged===false); a single harvested row promotes them back to "Harvested"
    // (the user's "unless already imported" rule). Pure visual grouping — the
    // filter value is still just the author string.
    const counts = {}, nonStagedOnly = {};
    rows.forEach(r => {
      const a = r.author || '';
      counts[a] = (counts[a] || 0) + 1;
      if (nonStagedOnly[a] === undefined) nonStagedOnly[a] = true;
      if (r.staged !== false) nonStagedOnly[a] = false;
    });
    if (!counts[authorFilter]) authorFilter = 'all';
    const all = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const harvested = all.filter(a => !nonStagedOnly[a]);
    const nonStaged = all.filter(a => nonStagedOnly[a]);
    const opt = a => `<option value="${esc(a)}">${esc(a || '(none)')} (${counts[a]})</option>`;
    let html = '<option value="all">all authors (' + rows.length + ')</option>';
    if (harvested.length) html += '<optgroup label="Harvested (full reels)">' + harvested.map(opt).join('') + '</optgroup>';
    if (nonStaged.length) html += '<optgroup label="NonStaged (ffdown)">' + nonStaged.map(opt).join('') + '</optgroup>';
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
    // (dev0438) Come up UNFOCUSED so bare-letter hotkeys (f/F/c/…) work right
    // away; press f to jump into the filter box, Shift+F to clear it.
  }
  function closeIgScreen() {
    if (dirty) persist(false);     // best-effort flush on close
    igPreviewClose();              // (dev0500) tear down the media preview
    closeDrawer();
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
    if (e.key === 'm') {                           // clear, then select 18 from top
      e.stopPropagation(); e.preventDefault(); selectTopN(18); return;
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
