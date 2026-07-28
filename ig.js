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
  let embedFilter = 'all';             // (dev0665) all | 1 (embeddable) | 0 (not) | un (unprobed)
  let refetchFilter = 'all';           // (dev0677) all | need (needsFullRes) | done (was marked, now re-fetched)
  const lowResIds = new Set();         // (dev0666) rows this run that came via the low-res embed fallback
  const fallbackIds = new Set();       // (dev0666) rows this run that used a non-yt-dlp but full-res path
  let embedStamped = 0, embedNoVerdict = 0;   // (dev0675) download-time embed verdicts this run
  let hideCompleted = false;           // (dev0438) hotkey 'c' → hide downloaded ("completed") rows
  // (dev0655) Windowed rendering — the tbody paints only the rows in (and just around)
  // the #igWrap viewport, with top/bottom spacer <tr>s reserving the off-screen height,
  // so an 11k-row ig.json no longer builds 11k DOM rows on every filter/grind re-render.
  let rowH = 29;                       // measured row height (px), refined after first paint
  let _rowHMeasured = false;
  let _winStart = -1, _winEnd = -1;    // last painted slice [start,end)
  let _scrollRaf = false;              // rAF throttle for the scroll handler
  const ROW_BUFFER = 12;               // rows rendered above/below the viewport
  // (dev0655) Persisted filter/sort state — resumed on reopen (survives reboot).
  const IG_FILTER_KEY = 'slam-ig-filters';
  let _lastFilterSig = null;           // detects a real filter/sort change vs a data re-render
  let coverOnly = false;               // (dev0512) download toggle: cookieless index-1 cover only (no carousel, no cookies)
  let sel = new Set();                 // selected ids (batch ops)
  let lastCheckedId = null;            // anchor for shift-click range selection
  let focusId = null;                  // row open in the detail drawer
  let processingId = null;             // (dev0445) row currently being enriched/downloaded (live highlight)
  let dirty = false;                   // unsaved enrich/promote/status edits
  let busy = false;                    // a batch op is running
  let batchAbort = false;              // user pressed Stop during a batch
  let vpnDropAbort = false;            // (dev0658) VPN kill-switch tripped (tunnel dropped mid-grind)
  let rotatingActive = false;          // (dev0658) a VPN-committed Download+rotate grind is running
  let vpnDownStreak = 0;               // (dev0661) consecutive tunnel-down poll reads (kill-switch debounce)
  let proxyDown = false;               // (dev0688) the proxy stopped answering mid-run → pause, don't abandon
  let lastBatchDead = 0;               // (dev0688) rows runBatch retired as permanently dead (grind reads it)
  let lastOpError = '';                // last enrich/download error (for throttle detection)
  let lastOpInfo = '';                 // (dev0437) cookie posture of the last op ('cookieless'/'Firefox cookies')
  let lastDlName = '';                 // (dev0649) title/id of the most recent successful download (rotate toasts)
  // (dev0441) Posts that FAILED cookieless enrich this session because they're
  // login-walled (yt-dlp can't read them without cookies). They keep status 'new'
  // — so without this they'd be re-hit on EVERY bulk Enrich, never succeeding and
  // showing no change. Bulk Enrich skips them after one attempt; ↻ Reload (or a
  // single ✨) retries. Session-only (not persisted) so a reload always re-tries.
  const enrichFailed = new Set();

  // (dev0517, reworked dev0654) Auto-enrich driver — grinds the not-yet-enriched
  // backlog `autoBatchSize` at a time and AUTO-ROTATES the Proton VPN to a fresh US
  // exit the moment an exit actually walls (via the same vpnEnsureUp switcher the
  // Download+rotate button uses). Enrich rides the proxy's current exit IP (yt-dlp is
  // spawned by the proxy and routes through the WireGuard tunnel; the browser↔proxy
  // link is loopback, so a switch never drops this UI). No manual city picking anymore
  // — the old per-Proton-city menu (European exits) is gone. State: only batch size.
  const AUTO_KEY = 'slam-ig-autoenrich';
  let autoLoaded = false;       // localStorage read once
  let autoRunning = false;      // loop active (may be paused)
  let autoPaused = false;       // paused: no-progress / errored / by user
  let autoBatchSize = 38;       // (dev0654) rows per enrich batch (was 18)
  let autoGapMs = 4000;         // breather between clean batches
  let autoTotalOk = 0;          // (dev0654) enriched this run (readout + final report)
  let autoSwitches = 0;         // (dev0654) VPN exits rotated through this run
  let autoDry = 0;              // (dev0654) consecutive walled rotations with 0 progress
  const AUTO_DRY_LIMIT = 3;     // (dev0654) that many dry rotations → stop (backlog is walled/dead)
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
  // (dev0688) PERMANENTLY DEAD POSTS — a third failure class, distinct from a wall
  // (needs auth) and a throttle (needs pacing). The post is gone, or is restricted to
  // an audience we will never be in. No new VPN exit, no wait and no cookie can change
  // that answer, so the only correct response is to retire the row and carry on.
  // Treating these as ordinary failures is what killed the 2026-07-27 grinds: two
  // audience-restricted reels sat at the head of the view, each burned its retry, the
  // pair tripped DOWNLOAD_WALL_CAP, and a 1103-row run ended in 37 seconds under a
  // "check the VPN" message — with the proxy alive and the VPN healthy. Then, because
  // nothing was ever written to the rows, they came back at the head of the NEXT run
  // and did it again (CpDuwjPJB7L alone burned ~10 attempts across runs).
  // Ordering note: isThrottle() is still tested FIRST (a 429 wins), so a rate-limit
  // that happens to mention a missing post can't be mistaken for a dead one.
  const PERMANENT_RE = /available to everyone|certain audiences|no longer available|has been deleted|been removed|HTTP Error 404|Page not found/i;
  const isPermanent = err => !!err && PERMANENT_RE.test(err);
  // (dev0688) Rows retired this run (for the end report) and rows that were in flight
  // when the proxy died (quarantined for the rest of the run — see awaitProxyReturn).
  const deadThisRun = new Set();
  const proxyKillIds = new Set();

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

  // ══ (dev0683) CLIENT BLACK BOX — DIAGNOSTICS ONLY ═══════════════════════════
  // Download+rotate keeps dying part-way through a long grind, and the two suspects
  // — the proxy stopping, and rows in ig.json marked so they can never download —
  // both leave the same useless evidence: a toast that says "VPN dropped" and a
  // report that says "batch downloaded 0". Nothing here changes what the grind
  // DOES. It only records what happened, in two places:
  //   • localStorage (this ring buffer) — survives a proxy death, a proxy restart,
  //     and closing the tab. This is the primary copy, precisely because the prime
  //     suspect is the proxy: anything mirrored to it dies with it.
  //   • proxy.log via POST /diag/log — fire-and-forget, so the client's story and
  //     the proxy's requests interleave on one clock while the proxy is alive.
  // Read it from 🛠 Fix ▸ 🩺 Diagnostics (Copy / Save .txt / Clear).
  const DIAG_KEY = 'slam-ig-diag';
  const DIAG_MAX = 1500;               // events kept (oldest dropped) — ~1MB worst case
  let diagBuf = null;                  // lazily loaded from localStorage
  let diagFlushT = null;
  let diagMirror = [];                 // pending lines for /diag/log
  let diagMirrorT = null;
  const diagRunId = Math.random().toString(36).slice(2, 7);   // groups one page-load's events

  function diagLoad() {
    if (diagBuf) return diagBuf;
    try { diagBuf = JSON.parse(localStorage.getItem(DIAG_KEY) || '[]'); } catch (_) { diagBuf = []; }
    if (!Array.isArray(diagBuf)) diagBuf = [];
    return diagBuf;
  }
  function diagFlush() {
    diagFlushT = null;
    try { localStorage.setItem(DIAG_KEY, JSON.stringify(diagBuf || [])); }
    catch (_) {
      // Quota — halve the buffer and try once. Losing old events beats losing new ones.
      try { diagBuf = (diagBuf || []).slice(-Math.floor(DIAG_MAX / 2)); localStorage.setItem(DIAG_KEY, JSON.stringify(diagBuf)); } catch (_) {}
    }
  }
  // One event. `ev` is a short tag; `o` any small object of fields. Never throws,
  // never awaits, never blocks the caller — a diagnostic that can change the run's
  // timing would be diagnosing itself.
  function diag(ev, o) {
    try {
      const buf = diagLoad();
      const e = Object.assign({ t: new Date().toISOString().slice(11, 23), run: diagRunId, ev }, o || {});
      buf.push(e);
      if (buf.length > DIAG_MAX) buf.splice(0, buf.length - DIAG_MAX);
      // Batched write: a 1500-entry stringify on every row would itself be a stall.
      // Serious events flush immediately — those are the ones a crash must not lose.
      if (/FAIL|END|STOP|DROP|NOPROXY|ERROR|START/.test(ev)) diagFlush();
      else if (!diagFlushT) diagFlushT = setTimeout(diagFlush, 2000);
      console.log('[ig-diag]', diagLine(e));
      diagMirror.push(diagLine(e));
      if (!diagMirrorT) diagMirrorT = setTimeout(diagMirrorSend, 1500);
    } catch (_) {}
  }
  function diagLine(e) {
    const skip = { t: 1, ev: 1, run: 1 };
    const rest = Object.keys(e).filter(k => !skip[k] && e[k] !== undefined && e[k] !== '')
      .map(k => k + '=' + (typeof e[k] === 'object' ? JSON.stringify(e[k]) : String(e[k])))
      .join(' ');
    return `${e.t} ${e.ev}${rest ? ' · ' + rest : ''}`;
  }
  function diagMirrorSend() {
    diagMirrorT = null;
    const lines = diagMirror.splice(0, diagMirror.length);
    if (!lines.length) return;
    // Fire-and-forget: if the proxy is the thing that died, this fails silently and
    // the localStorage copy (already written) is the record.
    try {
      fetch(PROXY + '/diag/log', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines })
      }).catch(() => {});
    } catch (_) {}
  }
  // Is the proxy answering AT ALL? Used only to LABEL a failure (proxy-down vs
  // IG-wall vs tunnel-down) — nothing branches on it, the run continues exactly as
  // before. 4s cap so a hung proxy can't hold a row open.
  async function diagProxyAlive() {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(PROXY + '/version', { cache: 'no-store', signal: ctl.signal });
      clearTimeout(to);
      const j = await r.json();
      return j && j.build ? ('alive ' + j.build) : 'answered-but-odd';
    } catch (e) { return 'NOPROXY (' + ((e && e.name) || 'fetch failed') + ')'; }
  }
  // The marks that decide whether a row is grindable — snapshotted around every
  // attempt so "the row was marked so it could never download" becomes visible.
  function diagMarks(r) {
    return {
      status: r.status || '(none)',
      files: (r.localFiles || []).length,
      enrichWalled: enrichFailed.has(r.id) ? 1 : 0,
      autoDead: autoDead.has(r.id) ? 1 : 0,
      dead: r.dead ? 1 : 0,                       // (dev0688) retired: permanently undownloadable
      proxyKills: r.proxyKills || 0,              // (dev0688) times this row was in flight when the proxy died
      hasTitle: r.VidTitle ? 1 : 0,
      dur: r.durSecs == null ? 'null' : r.durSecs,
      wh: (r.width || 0) + 'x' + (r.height || 0),
      embed: r.embed === 0 || r.embed === 1 ? r.embed : 'un',
      lowRes: r.lowResDl ? 1 : 0,
      needsFullRes: r.needsFullRes ? 1 : 0,
      partial: r.metaPartial ? 1 : 0
    };
  }
  function diagDump() {
    return (diagLoad() || []).map(diagLine).join('\n');
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
  let _pollSig = '', _pollSame = 0;   // (dev0683) last poll verdict + how long it has held

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
    // (dev0683) The 5s poll is the client's own pulse — and the ONLY place that can
    // tell "the tunnel went down" apart from "the proxy stopped answering", because
    // a thrown fetch (proxy unreachable) and a tunnelUp:false answer both ended up
    // as `vpnStatus = null`-ish silence before. Log only TRANSITIONS so a 3-hour
    // grind leaves a readable trail, not 2,000 identical lines.
    const _t0 = Date.now();
    let _reach = 'ok', _err = '';
    try {
      const r = await fetch(PROXY + '/vpn/status', { cache: 'no-store' });
      const j = await r.json();
      if (j && j.ok) vpnStatus = j; else { _reach = 'bad-json'; }
    } catch (e) { vpnStatus = null; _reach = 'NOPROXY'; _err = (e && e.message) || 'fetch failed'; }
    const _sig = _reach + '/' + (vpnStatus ? (vpnStatus.tunnelUp ? 'up' : 'down') : 'null')
               + '/' + ((vpnStatus && (vpnStatus.server || vpnStatus.ip)) || '');
    const _slow = Date.now() - _t0 > 2000;
    if (_sig !== _pollSig || _slow) {
      diag(_reach === 'NOPROXY' ? 'POLL-NOPROXY' : 'poll', {
        was: _pollSig || '(first)', now: _sig, ms: Date.now() - _t0,
        sameFor: _pollSame, grind: rotatingActive ? 1 : 0, auto: autoRunning ? 1 : 0,
        err: _err || undefined
      });
      _pollSig = _sig; _pollSame = 0;
    } else _pollSame++;
    vpnRenderPill();
    vpnKillSwitchCheck();               // (dev0658) tunnel dropped mid-grind → stop everything
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

  // (dev0652) Tear down the rotating WireGuard tunnel → back to the Proton tray app.
  async function vpnStopTunnel() {
    if (busy) { igToast('A batch is running — press ⏹ Stop first.', 2600); return; }
    if (!confirm('Stop the rotating WireGuard tunnel (proton_active)?\n\nThis removes it and hands VPN control back to the Proton tray app,\nwhere you can pick a server manually or turn the VPN off.')) return;
    vpnBusy = true; vpnRenderPill();
    igToast('⏏ stopping WireGuard tunnel…', 2000);
    try {
      const r = await fetch(PROXY + '/vpn/stop', { method: 'POST' });
      const j = await r.json();
      if (j && j.ok) vpnStatus = j;
    } catch (_) {}
    vpnBusy = false;
    await vpnRefresh(false);
    igToast(vpnStatus && !vpnStatus.tunnelUp
      ? '⏏ WireGuard tunnel stopped.\nThe Proton tray app now controls the VPN — pick a server there, or leave it off.'
      : '⚠ The tunnel may still be up — check the Proton app / WireGuard.', 4600);
  }

  // ── (dev0657) Recovery "Fix" panel ────────────────────────────────────────
  // One-click versions of the CLI recovery steps, so nothing has to be
  // remembered. Every action POSTs to the proxy's /fix/* routes. NOTE: these only
  // work while the proxy is answering — if it's fully dead the status line says to
  // run startproxy.bat (no background auto-restart: see the VPN kill-switch, which
  // STOPS activity on a tunnel drop rather than keeping anything alive).
  let fixPanelEl = null, fixStatusCache = null;

  function fixEnsureCss() {
    if (document.getElementById('igFixCss')) return;
    const s = document.createElement('style');
    s.id = 'igFixCss';
    s.textContent =
      // (dev0684) z-index 70 → 40010, and the panel now mounts INSIDE #igOverlay.
      // #igOverlay is a full-screen opaque stacking context at z-index 29500, so a
      // body-level panel at 70 was painted BEHIND it: clicking 🛠 Fix built the
      // panel, appended it, wired it up — and nothing appeared. That has been true
      // since dev0657, and it hid the recovery tools exactly when the proxy dies
      // and they are needed. igToast/igSticky already mount inside the overlay
      // (40000-40002); these sit just above them.
      '#igFixPanel{position:fixed;top:46px;left:12px;z-index:40010;width:326px;background:#0c0f14;' +
      'border:1px solid #34404f;border-radius:10px;box-shadow:0 14px 38px rgba(0,0,0,.6);padding:10px;font-size:13px;color:#cfe}' +
      '#igFixPanel .fhdr{display:flex;align-items:center;justify-content:space-between;font-weight:700;color:#9ad;margin-bottom:8px}' +
      '#igFixPanel .fhdr .fx{background:none;border:none;color:#9aa7b4;font-size:18px;cursor:pointer;padding:0 4px;line-height:1}' +
      '#igFixPanel .fstat{background:#141b24;border:1px solid #22303c;border-radius:6px;padding:6px 8px;margin-bottom:6px;line-height:1.4}' +
      '#igFixPanel .fstat.ok{color:#bfe} #igFixPanel .fstat.bad{color:#ffd7d7;border-color:#5a2b2b;background:#241416}' +
      '#igFixPanel .fstat code{background:#000;padding:1px 4px;border-radius:3px}' +
      '#igFixPanel .frow{display:block;width:100%;text-align:left;background:#1f2733;border:1px solid #34404f;' +
      'color:#e8f0f7;border-radius:8px;padding:7px 10px;margin:6px 0;cursor:pointer;font-weight:600}' +
      '#igFixPanel .frow:hover{background:#27313f} #igFixPanel .frow:disabled{opacity:.5;cursor:default}' +
      '#igFixPanel .frow small{display:block;font-weight:400;color:#9aa7b4;margin-top:2px}' +
      '#igFixPanel .frow em{color:#ffcf7a;font-style:normal}';
    document.head.appendChild(s);
  }

  function toggleFixPanel() {
    if (fixPanelEl) { fixPanelEl.remove(); fixPanelEl = null; return; }
    fixEnsureCss();
    const p = document.createElement('div');
    p.id = 'igFixPanel';
    p.innerHTML =
      '<div class="fhdr">🛠 Recovery tools<button class="fx" id="fixClose" title="Close">×</button></div>' +
      '<div class="fstat" id="fixStat">checking the proxy…</div>' +
      '<button id="fixRestart" class="frow">↻ Restart proxy<small>reloads proxy.js — use if downloads / VPN calls stop responding</small></button>' +
      '<button id="fixHarden" class="frow">🛡 Harden VPN tasks <em>(1 UAC)</em><small>the permanent fix for "no exit comes up" — run once</small></button>' +
      '<button id="fixUnstick" class="frow">🔓 Unstick VPN task<small>clears a jammed rotation so switching works again</small></button>' +
      '<button id="fixBringUp" class="frow">🔀 Bring VPN up<small>switch until a US exit actually routes</small></button>'
      + '<button id="fixDiag" class="frow">🩺 Diagnostics<small>(dev0683) what the last grind actually did — every row, batch, VPN check and save, kept in this browser so it survives the proxy dying</small></button>';
    (document.getElementById('igOverlay') || document.body).appendChild(p);   // (dev0684) see the CSS note
    fixPanelEl = p;
    const q = id => p.querySelector('#' + id);
    q('fixClose').onclick   = () => { p.remove(); fixPanelEl = null; };
    q('fixRestart').onclick = () => fixRestartProxy();
    q('fixHarden').onclick  = () => fixHardenVpn();
    q('fixUnstick').onclick = () => fixUnstickVpn();
    q('fixBringUp').onclick = () => fixBringVpnUp();
    q('fixDiag').onclick    = () => showDiagPanel();
    fixRefreshStatus();
  }

  // ── (dev0683) Diagnostics viewer ──────────────────────────────────────────
  // Reads the client black box back out: a short summary (built from the events,
  // not from anything remembered) then the raw trail, newest last. Save .txt hands
  // the whole thing over in one file. Nothing here writes to ig.json.
  function diagSummary() {
    const b = diagLoad();
    const cnt = {};
    b.forEach(e => { cnt[e.ev] = (cnt[e.ev] || 0) + 1; });
    const last = k => { for (let i = b.length - 1; i >= 0; i--) if (b[i].ev === k) return b[i]; return null; };
    const gs = last('GRIND-START'), ge = last('GRIND-END'), be = last('BATCH-END'), sv = last('save');
    const fails = b.filter(e => e.ev === 'ROW-FAIL');
    const failIds = {};
    fails.forEach(e => { failIds[e.id] = (failIds[e.id] || 0) + 1; });
    const repeat = Object.entries(failIds).filter(([, n]) => n > 1).sort((a, b2) => b2[1] - a[1]).slice(0, 8);
    const L = [];
    L.push(`${b.length} events recorded` + (b.length ? ` · ${b[0].t} → ${b[b.length - 1].t}` : ''));
    if (gs) L.push(`last grind START: ${gs.ready} ready · chunk ${gs.chunk} · exit ${gs.exit}`);
    if (ge) L.push(`last grind END:   ${ge.totalOk} downloaded in ${ge.elapsed} · ${ge.batches} batches · proxy at that moment: ${ge.proxy}`);
    if (ge) L.push(`   reason: ${ge.msg}`);
    if (be) L.push(`last batch stop:  ${be.stop} (ok ${be.ok}, fail ${be.fail} of ${be.total})`);
    if (sv) L.push(`last ig.json save: ${sv.MB}MB in ${sv.totalMs}ms (stringify ${sv.stringifyMs}ms)`);
    L.push(`row failures: ${fails.length} · enrich failures: ${cnt['ENRICH-FAIL'] || 0}`
      + ` · proxy-unreachable events: ${(cnt['POLL-NOPROXY'] || 0) + (cnt['vpnStillUp-FALSE-NOPROXY'] || 0) + (cnt['DL-NETWORK-ERROR'] || 0)}`
      + ` · real tunnel drops: ${cnt['KILLSWITCH-TRIP-vpn-down'] || 0}`);
    if (repeat.length) L.push('rows that failed more than once (they come back every round):\n   '
      + repeat.map(([id, n]) => `${id} ×${n}`).join(', '));
    return L.join('\n');
  }

  function showDiagPanel() {
    document.getElementById('igDiagPanel')?.remove();
    const d = document.createElement('div');
    d.id = 'igDiagPanel';
    // (dev0684) Same mount + z-index rule as #igFixPanel — this panel was born with
    // the same defect (body-level, z-index 80, invisible behind #igOverlay).
    d.style.cssText = 'position:fixed;inset:5% 6%;z-index:40011;background:#0c0f14;border:1px solid #34404f;'
      + 'border-radius:10px;box-shadow:0 18px 46px rgba(0,0,0,.7);padding:12px;display:flex;flex-direction:column;color:#cfe;font-size:13px';
    d.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">'
      + '<b style="color:#9ad">🩺 IG grind diagnostics</b>'
      + '<span style="color:#7a8794">client black box · localStorage · survives a proxy death</span>'
      + '<span style="flex:1"></span>'
      + '<button id="dgCopy">Copy all</button><button id="dgSave">Save .txt</button>'
      + '<button id="dgClear">Clear</button><button id="dgClose">×</button></div>'
      + '<pre id="dgSum" style="white-space:pre-wrap;background:#141b24;border:1px solid #22303c;border-radius:6px;padding:8px;margin:0 0 8px;color:#bfe"></pre>'
      + '<pre id="dgBody" style="flex:1;overflow:auto;white-space:pre-wrap;background:#0a0d12;border:1px solid #22303c;border-radius:6px;padding:8px;margin:0;font-size:11.5px;line-height:1.45"></pre>';
    (document.getElementById('igOverlay') || document.body).appendChild(d);   // (dev0684)
    d.querySelectorAll('button').forEach(b => { b.style.cssText = 'background:#1f2733;border:1px solid #34404f;color:#e8f0f7;border-radius:6px;padding:4px 9px;cursor:pointer'; });
    const text = () => diagSummary() + '\n\n' + diagDump();
    d.querySelector('#dgSum').textContent = diagSummary();
    const body = d.querySelector('#dgBody');
    body.textContent = diagDump();
    body.scrollTop = body.scrollHeight;
    d.querySelector('#dgClose').onclick = () => d.remove();
    d.querySelector('#dgCopy').onclick = () => {
      navigator.clipboard.writeText(text()).then(() => igToast('📋 diagnostics copied', 1800),
        () => igToast('✗ clipboard blocked — use Save .txt', 2600));
    };
    d.querySelector('#dgSave').onclick = () => {
      const blob = new Blob([text()], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'ig-diag-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + '.txt';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    };
    d.querySelector('#dgClear').onclick = () => {
      if (!confirm('Clear the recorded diagnostics?\n\nOnly do this AFTER a failure has been read/saved — this is the only copy that survives a proxy restart.')) return;
      diagBuf = []; diagFlush();
      d.querySelector('#dgSum').textContent = diagSummary(); body.textContent = '';
      igToast('🩺 diagnostics cleared', 1600);
    };
  }

  async function fixRefreshStatus() {
    if (!fixPanelEl) return;
    const stat = fixPanelEl.querySelector('#fixStat');
    let j = null;
    try { const r = await fetch(PROXY + '/fix/status', { cache: 'no-store' }); j = await r.json(); } catch (_) {}
    fixStatusCache = j;
    if (!fixPanelEl) return;
    if (!j || !j.ok) {
      stat.className = 'fstat bad';
      stat.innerHTML = '⚠ <b>Proxy isn\'t answering.</b> A button can\'t restart a dead proxy — double-click <code>startproxy.bat</code>.';
      return;
    }
    stat.className = 'fstat ok';
    stat.innerHTML = 'Proxy <b>' + j.build + '</b> ✓ · ' + (j.tunnelUp ? '🟢 VPN up' : '🔴 VPN off');
  }

  async function fixRestartProxy() {
    igToast('↻ restarting the proxy…', 2000);
    const stat = fixPanelEl && fixPanelEl.querySelector('#fixStat');
    if (stat) { stat.className = 'fstat'; stat.textContent = 'restarting proxy — waiting for it to come back…'; }
    try { await fetch(PROXY + '/fix/restart-proxy', { method: 'POST' }); } catch (_) {}
    const t0 = Date.now(); let back = null;
    while (Date.now() - t0 < 30000) {
      await new Promise(r => setTimeout(r, 1200));
      try { const r = await fetch(PROXY + '/version', { cache: 'no-store' }); const v = await r.json(); if (v && v.build) { back = v.build; break; } } catch (_) {}
    }
    if (back) { igToast('✅ proxy back up (' + back + ')', 3200); vpnRefresh(false); }
    else igToast('⚠ proxy didn\'t answer in 30s — check the "SLAM proxy :8081" window, or run startproxy.bat.', 6500);
    fixRefreshStatus();
  }

  async function fixHardenVpn() {
    if (!confirm('Harden the VPN scheduled tasks?\n\nA Windows UAC prompt will appear — click Yes.\nA small setup window opens; close it when it says "Done".\n\nThis permanently stops a stuck rotation from blocking VPN switches (the recurring "no exit" cause).')) return;
    try {
      const r = await fetch(PROXY + '/fix/harden-vpn', { method: 'POST' });
      const j = await r.json();
      igToast(j && j.ok
        ? '🛡 setup launched — approve the UAC prompt, then close its window when it says Done.'
        : '⚠ could not launch setup: ' + ((j && j.error) || '?'), 6500);
    } catch (_) { igToast('⚠ proxy not responding — can\'t launch setup. Run startproxy.bat first.', 4500); }
  }

  async function fixUnstickVpn() {
    igToast('🔓 ending any stuck rotation…', 1800);
    try { await fetch(PROXY + '/fix/unstick-vpn', { method: 'POST' }); } catch (_) {}
    await vpnRefresh(false);
    igToast('🔓 stuck task cleared. Try 🔀 Bring VPN up, or Download + rotate again.', 4200);
    fixRefreshStatus();
  }

  async function fixBringVpnUp() {
    if (busy) { igToast('A batch is running — press ⏹ Stop first.', 2600); return; }
    batchAbort = false;
    igToast('🔀 bringing a US exit up…', 2000);
    const sw = await vpnEnsureUp('Fix ▸ Bring VPN up');
    await vpnRefresh(false);
    igToast(sw && sw.tunnelUp
      ? '🟢 VPN up: ' + (sw.server || '?') + (sw.ip ? '  ' + sw.ip : '')
      : '⚠ no exit routed — try 🔓 Unstick, or check the Proton app.', 5000);
    fixRefreshStatus();
  }

  // ── (dev0658) VPN kill-switch ─────────────────────────────────────────────
  // IG activity must NEVER run on the home IP. Two guards stop a grind the moment
  // the WireGuard tunnel drops (a deliberate Drop VPN, a Proton-app disconnect, or
  // a dead exit): (1) the pill poll below, sped to 5s, trips the abort + kills any
  // in-flight downloader; (2) runBatch re-checks the tunnel before each row so no
  // NEW download/enrich starts on a dead tunnel. Both set vpnDropAbort so the end
  // report + auto-enrich driver stop cleanly. Skipped while vpnBusy (a legit switch
  // is briefly down by design). Replaces the rejected auto-restart watchdog.
  async function igKillDownloads() {
    try { await fetch(PROXY + '/fix/kill-downloads', { method: 'POST' }); } catch (_) {}
  }

  // Fresh confirm the tunnel is up. Fast path returns on the first UP; only pays a
  // ~600ms re-check when it looks down, so a single localhost blip can't false-stop
  // a healthy grind. Returns false on confirmed-down OR proxy-unreachable (either
  // way IG can't safely run). Updates the pill as a side effect.
  async function vpnStillUp() {
    // (dev0661) Ride out a WireGuard rekey blip: a datacenter exit can drop its
    // handshake for a few seconds and self-heal. Re-check a few times over ~2.4s
    // before declaring down, so one transient miss can't false-kill a healthy
    // grind. First UP short-circuits, so a healthy tunnel still pays ~0ms.
    // (dev0683) DIAGNOSTIC ONLY: record WHY each attempt failed. This function
    // returns a bare `false` for two completely different worlds — "the tunnel is
    // down" and "the proxy never answered" — and the caller then reports the first
    // one. `throws` counts the second. The return value is unchanged.
    const attempts = [];
    for (let i = 0; i < 4; i++) {
      try {
        const r = await fetch(PROXY + '/vpn/status', { cache: 'no-store' });
        const j = await r.json();
        if (j && j.ok) {
          vpnStatus = j; vpnRenderPill();
          attempts.push(j.tunnelUp ? 'up' : 'down');
          if (j.tunnelUp) { if (i) diag('vpnStillUp-recovered', { attempts: attempts.join(','), tries: i + 1 }); return true; }
        } else attempts.push('bad-json');
      } catch (e) { attempts.push('THREW:' + ((e && e.message) || 'fetch failed')); }
      if (i < 3) await sleep(800);
    }
    const threw = attempts.filter(a => /^THREW/.test(a)).length;
    diag(threw ? 'vpnStillUp-FALSE-NOPROXY' : 'vpnStillUp-FALSE-tunnelDown', {
      attempts: attempts.join(','), threw,
      verdict: threw === 4 ? 'proxy never answered — the VPN was NOT the cause'
             : threw ? 'mixed: proxy flaky' : 'proxy answered, tunnel really down'
    });
    // (dev0688) dev0683 recorded this distinction; now it ACTS on it. Every probe
    // throwing means the proxy is gone and the tunnel's state is simply unknown —
    // calling that "VPN tunnel dropped" is the misreading that sent three sessions
    // chasing a VPN that was healthy all along. The return value stays false either
    // way (the run must still stop here); the flag tells the caller WHICH stop it is.
    if (threw === 4) proxyDown = true;
    return false;
  }

  // Called from vpnRefresh (the poll) — if a grind is live and the tunnel just
  // dropped, stop EVERYTHING now: abort the loop + kill the in-flight downloader.
  // (dev0661) Debounce: the 5s poll must see the tunnel down on TWO consecutive
  // reads (~5-10s of confirmed-down) before killing the grind. A single blip from
  // a WireGuard rekey on a flaky datacenter exit self-heals in seconds and used to
  // false-stop a perfectly healthy 300+ item grind. Any UP read resets the streak.
  function vpnKillSwitchCheck() {
    if (!(rotatingActive || autoRunning) || vpnBusy || !vpnStatus || !vpnStatus.ok || vpnDropAbort) return;
    if (vpnStatus.tunnelUp === false) {
      if (++vpnDownStreak < 2) { diag('killswitch-armed', { streak: vpnDownStreak, exit: vpnStatus.server || vpnStatus.ip || '?' }); return; }   // first miss is tolerated (rekey blip)
      vpnDownStreak = 0;
      vpnDropAbort = true; batchAbort = true;
      // (dev0683) This is the toast the user has been shown for a failure that was
      // usually NOT the VPN. Record that the proxy DID answer here (it must have —
      // vpnStatus came from it), so a later "VPN dropped" report can be checked.
      diag('KILLSWITCH-TRIP-vpn-down', { exit: vpnStatus.server || vpnStatus.ip || '?', at: vpnStatus.at || '', note: 'proxy answered with tunnelUp:false — a real tunnel drop' });
      igKillDownloads();
      igToast('🛑 VPN tunnel dropped — stopping the IG grind.\nNothing runs on your home IP.', 6000);
    } else {
      vpnDownStreak = 0;                        // healthy read clears the streak
    }
  }

  function vpnStartPoll() { if (!vpnPollTimer) vpnPollTimer = setInterval(() => { if (isIgScreenOpen()) vpnRefresh(false); }, 5000); }
  function vpnStopPoll()  { if (vpnPollTimer) { clearInterval(vpnPollTimer); vpnPollTimer = null; } }

  // Fire a switch and wait for the proxy to confirm the new exit. Returns the new
  // status (or null on failure). Shows progress in the shared batch panel.
  async function vpnSwitchNow(note) {
    vpnBusy = true; vpnRenderPill();
    igBatchUpdate((note ? note + '\n' : '') + '🔀 switching Proton VPN to a fresh US exit…');
    let out = null;
    // (dev0683) Time every switch and record how it ended. "Couldn't get a working
    // VPN exit (tried a few)" is one of the two ways a long grind dies, and a switch
    // that THREW (proxy gone) looks identical to one that came back tunnelUp:false.
    const _t0 = Date.now(); let _how = '';
    try {
      const r = await fetch(PROXY + '/vpn/switch', { method: 'POST' });
      const j = await r.json();
      if (j && j.ok) { out = j; vpnStatus = j; _how = j.tunnelUp ? 'up' : 'answered-but-down'; }
      else _how = 'not-ok';
    } catch (e) { _how = 'THREW:' + ((e && e.message) || 'fetch failed'); }
    diag(out && out.tunnelUp ? 'vpn-switch-ok' : 'VPN-SWITCH-FAIL', {
      how: _how, ms: Date.now() - _t0,
      exit: (out && (out.server || out.ip)) || '', note: (note || '').slice(0, 60)
    });
    vpnBusy = false; vpnRenderPill();
    return out;
  }

  // (dev0651) Switch until we land on a WORKING exit (proxy confirms tunnelUp).
  // Each attempt stages a fresh server, and the .ps1 only reports success once the
  // public IP has actually changed off the home baseline — so a dead server is
  // skipped, never silently accepted. Returns the working status, or null.
  // (dev0686) 3 → 5 tries, per request. The dev0683 black box caught two switches
  // that answered "answered-but-down" after 13.6s and 40.2s (batches 8 and 23 of a
  // 29-batch grind): /vpn/switch's own wait capped out while vpn-rotate.ps1 was
  // still working, so the switch looked failed when it wasn't. Both recovered on a
  // retry — but with only 3 tries a run of those ends the grind ("couldn't get a
  // working VPN exit"). Two more attempts costs nothing when exits come up first
  // try, which is the normal case. It does not FIX the timeout race, it just
  // outlasts it.
  async function vpnEnsureUp(note, tries) {
    tries = tries || 5;
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
#igTable tr.igspacer td,#igTable tr.igspacer:hover td{background:transparent;padding:0;border:0}
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
#igVpnStop{font:600 12px system-ui;padding:3px 9px}
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
#igAutoNote{padding:9px 11px;font-size:11.5px;line-height:1.5;color:#8fa0b0}
#igAutoNote b{color:#b9c4d0}
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
        <button id="igVpnStop" title="Stop the rotating WireGuard tunnel (proton_active) and hand VPN control back to the Proton tray app — where you can pick a server or turn the VPN off entirely.">⏏ Drop VPN</button>
        <button id="igFix" title="Recovery tools — one click each: restart the proxy, permanently harden the VPN tasks, unstick a jammed rotation, or force a working VPN exit up. Use this whenever downloads/VPN stop working.">🛠 Fix</button>
        <input type="text" id="igSearch" placeholder="search author / id / title / caption…">
        <select id="igAuthor" title="Filter by author"><option value="all">all authors</option></select>
        <select id="igKind"><option value="all">all kinds</option><option value="reel">reels</option><option value="p">posts /p</option><option value="tv">tv</option></select>
        <select id="igStatus"><option value="all">all status (A)</option><option value="new">new (N)</option><option value="enriched">enriched (E)</option><option value="downloaded">downloaded (D)</option><option value="promoted">promoted</option><option value="__retired__">🪦 retired (dead posts)</option></select>
        <select id="igStaged" title="Harvested (full reels) vs Unharvested (single posts — 'w'-added clipboard links or ffdown imports)"><option value="all">all sources</option><option value="non">Unharvested (singles)</option><option value="full">Harvested (full reels)</option></select>
        <select id="igEmbed" title="Official-embed playability (igEmbedProbe.js verdict): ✓ = IG's /embed/ page serves the video, so a public iframe single-plays it · ✗ = embed shows caption/poster only (photos always; some accounts refuse) · unprobed = no verdict yet"><option value="all">all embed</option><option value="1">embeddable ✓</option><option value="0">not embeddable ✗</option><option value="un">unprobed</option></select>
        <select id="igRefetch" title="(dev0677) Re-fetch queue: rows whose photo was downloaded through the broken cover picker — a CROPPED 640² thumbnail instead of IG's uncropped original. They have been reset to 'enriched' with their file record cleared, so Download sel / Download+rotate will fetch them again at full resolution. The flag clears itself as each row succeeds."><option value="all">all rows</option><option value="need">⤓ needs full-res re-fetch</option><option value="done">re-fetched already</option></select>
        <div class="igActs">
        <button id="igPaste" title="Paste a Firefox 'Save Page As Text' of a reel → fills that row's ttxt/caption">📋 Paste saved-text</button>
        <button id="igAddSingle" title="Add the single Instagram post/reel URL on the clipboard as a new Unharvested row (hotkey w) — status 'new', ready to Enrich/Download. For grabbing individual posts from authors you don't want to fully harvest.">➕ Add single (w)</button>
        <button id="igFfdown" title="Bulk-import every ffdown/*.txt saved IG page → ig.json (author caption only, marked Unharvested, DevComment from the filename)">📁 Import ffdown</button>
        <button id="igEnrichSel" title="Enrich selected (hotkey E)">✨ Enrich sel</button>
        <button id="igAutoEnrich" title="Auto-enrich (hotkey A) — grinds the not-yet-enriched backlog 38 at a time, cookielessly, and AUTO-ROTATES the Proton VPN to a fresh US exit whenever an exit walls (same switcher as Download+rotate). No manual city picking.">🤖 Auto-enrich</button>
        <button id="igDownloadSel" title="Download selected (hotkey D)">⬇ Download sel</button>
        <button id="igCoverOnly" title="Toggle download mode. ON = grab only the index-1 cover (no carousel) — for authors whose page-1 is the keeper. OFF = normal full download. Both are cookieless — your IG login is never used either way.">📸 Cover-only: off</button>
        <button id="igRotate" title="Grind the downloadable backlog in this view: downloads the top 18 not-yet-downloaded rows (new OR enriched — 'new' rows enrich inline first, no quality lost), then switches the Proton VPN to a fresh US exit and repeats with the next 18. Cookieless. Success toasts report the running total + most recent; stops when none remain, a batch downloads nothing, or you press Stop. Filter the view first (e.g. Status → new/enriched) to control what it grinds.">⬇⟳ Download + rotate VPN</button>
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
    $('igEmbed').addEventListener('change', e => { embedFilter = e.target.value; applyAndRender(); });
    $('igRefetch').addEventListener('change', e => { refetchFilter = e.target.value; applyAndRender(); });
    $('igEnrichSel').addEventListener('click', () => batchEnrich());
    $('igAutoEnrich').addEventListener('click', () => toggleAutoPanel());
    $('igDownloadSel').addEventListener('click', () => batchDownload());
    $('igRotate').addEventListener('click', () => batchDownloadRotating());
    $('igVpn').addEventListener('click', () => vpnRefresh(true));
    $('igVpnStop').addEventListener('click', () => vpnStopTunnel());
    $('igFix').addEventListener('click', () => toggleFixPanel());
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
    o.querySelector('#igWrap').addEventListener('scroll', onWrapScroll, { passive: true });   // (dev0655) windowed render
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
    { key: 'embed', label: 'Embed', w: 52, sort: true },
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
  // (dev0655) Filter/sort persistence. A "signature" of the current filter+sort lets
  // applyAndRender tell a real filter change (jump to top + persist) from a data
  // re-render during a grind (keep scroll position, no write).
  function _filterSig() {
    return [query, kindFilter, statusFilter, authorFilter, stagedFilter, embedFilter, refetchFilter,
      hideCompleted ? 1 : 0, sortCol, sortDir].join('');
  }
  function saveFilters() {
    try {
      localStorage.setItem(IG_FILTER_KEY, JSON.stringify({
        query, kindFilter, statusFilter, authorFilter, stagedFilter, embedFilter, refetchFilter,
        hideCompleted, sortCol, sortDir
      }));
    } catch (_) {}
  }
  function loadFilters() {
    try {
      const j = JSON.parse(localStorage.getItem(IG_FILTER_KEY) || '{}');
      if (typeof j.query === 'string') query = j.query;
      if (typeof j.kindFilter === 'string') kindFilter = j.kindFilter;
      if (typeof j.statusFilter === 'string') statusFilter = j.statusFilter;
      if (typeof j.authorFilter === 'string') authorFilter = j.authorFilter;
      if (typeof j.stagedFilter === 'string') stagedFilter = j.stagedFilter;
      if (typeof j.embedFilter === 'string') embedFilter = j.embedFilter;
      if (typeof j.refetchFilter === 'string') refetchFilter = j.refetchFilter;
      if (typeof j.hideCompleted === 'boolean') hideCompleted = j.hideCompleted;
      if (typeof j.sortCol === 'string') sortCol = j.sortCol;
      if (j.sortDir === 1 || j.sortDir === -1) sortDir = j.sortDir;
    } catch (_) {}
  }
  // Push restored values into the toolbar controls (author select is set later by
  // refreshAuthorOptions, once its option list exists).
  function syncFilterControls() {
    const g = id => document.getElementById(id);
    if (g('igSearch')) g('igSearch').value = query;
    if (g('igKind')) g('igKind').value = kindFilter;
    if (g('igStatus')) g('igStatus').value = statusFilter;
    if (g('igStaged')) g('igStaged').value = stagedFilter;
    if (g('igEmbed')) g('igEmbed').value = embedFilter;
    if (g('igRefetch')) g('igRefetch').value = refetchFilter;
  }

  function applyAndRender() {
    // (dev0655) A real filter/sort/search change (not a data re-render mid-grind) →
    // jump back to the top of the list and persist the new filter for next time.
    const sig = _filterSig();
    if (sig !== _lastFilterSig) {
      _lastFilterSig = sig;
      const wrap = document.getElementById('igWrap');
      if (wrap) wrap.scrollTop = 0;
      _winStart = _winEnd = -1;
      saveFilters();
    }
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
      // (dev0688) `__retired__` is a cross-cutting mark, not a status value — it's the
      // only way to SEE the rows the grind has permanently stopped offering (and to
      // check one and force a retry if a retirement was wrong).
      if (statusFilter === '__retired__') { if (!r.dead) return false; }
      else if (statusFilter !== 'all' && (r.status || 'new') !== statusFilter) return false;
      // (dev0472) NonFullReels = ffdown imports (staged===false); Full reels = harvested (everything else)
      if (stagedFilter === 'non' && r.staged !== false) return false;
      if (stagedFilter === 'full' && r.staged === false) return false;
      // (dev0665) Official-embed verdict from igEmbedProbe.js: 1 / 0 / absent (unprobed)
      if (embedFilter === '1' && r.embed !== 1) return false;
      if (embedFilter === '0' && r.embed !== 0) return false;
      if (embedFilter === 'un' && (r.embed === 0 || r.embed === 1)) return false;
      // (dev0677) Re-fetch queue: rows marked for a full-res re-download of a cropped cover.
      if (refetchFilter === 'need' && !r.needsFullRes) return false;
      if (refetchFilter === 'done' && !(r.refetchedAt && !r.needsFullRes)) return false;
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
      if (sortCol === 'embed') return r.embed === 1 ? 2 : (r.embed === 0 ? 1 : 0);   // ✓ > ✗ > unprobed
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
    const vEmbed     = view.reduce((n, r) => n + (r.embed === 1 ? 1 : 0), 0);   // (dev0665)
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
        `new ${vNew}`, `enriched ${vEnriched}`, `downloaded ${vDownload}`, `promoted ${vPromoted}`, `embed ✓ ${vEmbed}`,
        selTxt,
        dirty ? '⚠ unsaved' : null,
      ].filter(Boolean).join(' · ');
      el.innerHTML = `${view.length} shown <span class="sub">· ${esc(sub)}</span>`;
    }
    const sv = document.getElementById('igSave');
    if (sv) sv.classList.toggle('primary', dirty);
  }

  // ── Body render (windowed) ──────────────────────────────────────────────────
  // (dev0655) rowHtml builds ONE row; renderWindow paints only the slice around the
  // viewport (see the state block up top). renderBody is the full entry point callers
  // use — it repaints the window + header + count.
  function rowHtml(r) {
    const k = kindOf(r);
    const st = r.status || 'new';
    const cap = r.ftext ? '<span class="yes">✓</span>' : '<span class="no">—</span>';
    const tt = r.ttxt ? '<span class="yes">✓</span>' : '<span class="no">—</span>';
    // (dev0474) hover the cell → see the actual ftext/ttxt content as a tooltip
    const capTip = r.ftext ? ` title="${esc(htmlToText(r.ftext))}"` : '';
    const ttTip = r.ttxt ? ` title="${esc(htmlToText(r.ttxt))}"` : '';
    // (dev0666) A download that landed only the low-res embed image stays visible here,
    // long after its toast is gone — same "flag it so it can't pile up unseen" rule as
    // the ⚠ partial Posted cell.
    const wxh = r.lowResDl
      ? '<span class="walled" title="Downloaded via the low-res EMBED fallback (first image only) — re-download later for full res">⚠ low-res</span>'
      : ((r.width && r.height) ? (r.width + '×' + r.height) : '<span class="no">—</span>');
    const dur = r.durSecs ? fmtDur(r.durSecs) : '<span class="no">—</span>';
    return `<tr data-id="${esc(r.id)}" class="st-${st} ${r.id === focusId ? 'focus' : ''} ${r.id === processingId ? 'proc' : ''}">
        <td class="c-sel"><input type="checkbox" class="igchk" ${sel.has(r.id) ? 'checked' : ''}></td>
        <td><span class="badge k-${k}">${k}</span></td>
        <td title="${esc(r.author)}">${esc(r.author)}</td>
        <td><a class="idlink" href="${esc(igLink(r))}" target="_blank" rel="noopener" title="Open on Instagram">${esc(r.id)}</a></td>
        <td title="${esc(r.VidTitle || '')}">${esc(r.VidTitle || '')}</td>
        <td class="mono">${dur}</td>
        <td class="mono">${wxh}</td>
        <td class="mono">${r.DatePosted ? esc(r.DatePosted)
          : (r.metaPartial
              ? '<span class="walled" title="caption-only embed fallback — no date/dims were available; re-download on a healthy VPN to fill it">⚠ partial</span>'
              : '<span class="no">—</span>')}</td>
        <td style="text-align:center" title="${r.embed === 1
          ? 'Embeddable — IG’s official /embed/ page serves the video; a public iframe single-plays it'
          : (r.embed === 0
              ? 'Not embeddable — the embed page shows caption/poster only (photos always; some accounts refuse)'
              : 'Unprobed — downloads stamp this automatically (dev0675); older rows: node igEmbedProbe.js')}">${r.embed === 1
          ? '<span class="yes">✓</span>' : (r.embed === 0 ? '<span class="no">✗</span>' : '<span class="no">—</span>')}</td>
        <td style="text-align:center;cursor:help"${capTip}>${cap}</td>
        <td style="text-align:center;cursor:help"${ttTip}>${tt}</td>
        <td><span class="s-${st}">${st}</span>${(st === 'new' && enrichFailed.has(r.id)) ? '<span class="walled" title="Cookieless enrich failed this session — login-walled. Try 📋 Saved-text, or grab it from a logged-in Firefox; ↻ Reload to retry bulk enrich."> ⚠</span>' : ''}${
          // (dev0688) A retired row keeps its old status ('enriched'), so without this
          // marker it looks identical to a row still waiting its turn — and the reason
          // it is silently never picked would be invisible. Status → 🪦 retired lists them.
          r.dead ? `<span class="walled" title="🪦 RETIRED — permanently undownloadable, so Download+rotate skips it.\n${esc(r.deadReason || 'no reason recorded')}\n${esc(r.deadAt || '')}\nCheck the box and press Download to force a retry anyway."> 🪦</span>` : ''
        }${
          r.proxyKills ? `<span class="walled" title="This row was in flight when the proxy died ${r.proxyKills}× — at 2 it is dropped from Download+rotate for good."> ⛔${r.proxyKills}</span>` : ''
        }</td>
        <td class="mono">${esc(r.DateAdded || '')}</td>
        <td class="c-act">
          <button data-act="enrich" title="yt-dlp → title/caption/ttxt/author/date/res">✨</button>
          <button data-act="download" title="Download max-res → ig_media/">⬇</button>
          <button data-act="promote" title="Add to ml.json" ${st === 'promoted' ? 'disabled' : ''}>➕</button>
          <button data-act="detail" title="Details">⋯</button>
        </td>
      </tr>`;
  }
  const _spacerRow = h => h > 0
    ? `<tr class="igspacer"><td colspan="${COLS.length}" style="height:${h}px;padding:0;border:0"></td></tr>`
    : '';
  // Paint the rows in [start,end) around the current scroll, bracketed by spacers that
  // reserve the off-screen height so the scrollbar still spans the whole list. force=true
  // always repaints (content changed); the scroll handler passes false to skip when the
  // visible slice hasn't moved.
  function renderWindow(force) {
    const tb = document.querySelector('#igTable tbody');
    const wrap = document.getElementById('igWrap');
    if (!tb || !wrap) return;
    const n = view.length;
    if (!n) { tb.innerHTML = ''; _winStart = _winEnd = -1; return; }
    const vh = wrap.clientHeight || 600;
    const visCount = Math.ceil(vh / rowH);
    let start = Math.floor((wrap.scrollTop || 0) / rowH) - ROW_BUFFER;
    if (start < 0) start = 0;
    let end = start + visCount + ROW_BUFFER * 2;
    if (end > n) end = n;
    if (start > end) start = end;
    if (!force && start === _winStart && end === _winEnd) return;
    let html = _spacerRow(start * rowH);
    for (let i = start; i < end; i++) html += rowHtml(view[i]);
    html += _spacerRow((n - end) * rowH);
    tb.innerHTML = html;
    _winStart = start; _winEnd = end;
    // Refine the assumed row height once from a real rendered row, then repaint.
    if (!_rowHMeasured) {
      const real = tb.querySelector('tr[data-id]');
      if (real) {
        _rowHMeasured = true;
        const h = real.getBoundingClientRect().height;
        if (h > 8 && Math.abs(h - rowH) > 1) { rowH = h; _winStart = _winEnd = -1; renderWindow(true); }
      }
    }
  }
  function onWrapScroll() {
    if (_scrollRaf) return;
    _scrollRaf = true;
    requestAnimationFrame(() => { _scrollRaf = false; if (view.length) renderWindow(false); });
  }
  function renderBody() {
    const empty = document.getElementById('igEmpty');
    if (!view.length) {
      const tb = document.querySelector('#igTable tbody');
      if (tb) tb.innerHTML = '';
      _winStart = _winEnd = -1;
      if (empty) {
        empty.style.display = 'block';
        empty.textContent = rows.length ? 'No rows match the filter.' : 'ig.json is empty — harvest some reels first.';
      }
      renderHead(); updateCount();
      return;
    }
    if (empty) empty.style.display = 'none';
    renderWindow(true);
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
        <b>Embed</b><span>${r.embed === 1 ? '✓ embeddable (official iframe single-plays)'
          : (r.embed === 0 ? '✗ not embeddable (embed page has no video)' : '— unprobed')}</span>
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
  // (dev0655) With windowed rendering the target row may be outside the painted slice,
  // so scroll by index first (that brings it into the window), repaint, then highlight.
  function scrollIndexIntoView(i) {
    const wrap = document.getElementById('igWrap');
    if (!wrap || i < 0) return;
    const top = i * rowH, bot = top + rowH;
    if (top < wrap.scrollTop) wrap.scrollTop = top;
    else if (bot > wrap.scrollTop + wrap.clientHeight) wrap.scrollTop = bot - wrap.clientHeight;
  }
  function applyFocusHighlight(id) {
    if (id == null) {
      document.querySelectorAll('#igTable tr.focus').forEach(t => t.classList.remove('focus'));
      return null;
    }
    const i = view.findIndex(r => r.id === id);
    if (i >= 0) scrollIndexIntoView(i);
    renderWindow(true);   // focusId is baked into rowHtml, so the row paints already-focused
    return document.querySelector(`#igTable tr[data-id="${CSS.escape(id)}"]`);
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
      // (dev0662) The old date-loss bug: when yt-dlp AND the cookieless /p/ page both
      // fail, enrich drops to the embed page, which returns caption+handle ONLY — no
      // upload_date, no dims, no duration (parseIgEmbed). Those rows were stamped a
      // clean 'enriched'/'downloaded' with a blank Posted date and quietly piled up
      // (the jam_and_germs / undersea_gameqmi / pedrovalenciam mid-June backlog). Flag
      // an embed-only enrich as partial so it's visibly incomplete and gets re-fetched;
      // any real source (yt-dlp or the /p/ page — both carry the date) clears it. This
      // never fabricates a date, it only marks the gap so it can't accumulate unseen.
      if (meta._viaEmbed && !(r.DatePosted && String(r.DatePosted).trim())) r.metaPartial = true;
      else if (r.metaPartial) delete r.metaPartial;
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
      // (dev0683) Enrich failures matter to DOWNLOADS too: downloadRow enriches a
      // 'new' row inline for the filename, and gives up before it ever asks for the
      // media if that fails. So a "download failure" is often this. Record which.
      diag('ENRICH-FAIL', { id: r.id, single: single ? 1 : 0, status: r.status || '(none)',
        marked: WALL_RE.test(lastOpError) ? 'enrichFailed(session)' : 'not marked',
        err: (lastOpError || '').replace(/\s+/g, ' ').slice(0, 240) });
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
  // (dev0688) Retire a row that can never download. The mark is written to the ROW —
  // the whole trap was that nothing persisted, so a dead post returned to the head of
  // the view on every later run. Reversible on purpose: isReady() (the automatic
  // grind) honours it, but a manually-checked Download still retries the row, so a
  // wrongly-retired post is one checkbox away from another attempt.
  function markDead(r, err) {
    if (!r.dead) deadThisRun.add(r.id);
    r.dead = 1;
    r.deadReason = (err || '').replace(/\s+/g, ' ').slice(0, 200);
    r.deadAt = (typeof isoNow === 'function') ? isoNow()
             : new Date().toISOString().slice(0, 19).replace('T', ' ');
    dirty = true;
    diag('ROW-RETIRED', { id: r.id, kind: kindOf(r), reason: r.deadReason });
  }

  async function runBatch(label, ids, gap, doOne, skipIf, posture) {
    // (dev0688) proxyDown is cleared HERE, for every caller. It's a per-batch verdict,
    // and a stale true left over from an earlier run would make the next enrich or
    // download batch break on its very first row for no visible reason.
    busy = true; batchAbort = false; vpnDropAbort = false; proxyDown = false; setBatchUi(true);
    igStickyHide();                    // clear any prior run's summary so it can't cover the live panel
    let ok = 0, fail = 0, done = 0, throttled = false, cookieStopped = false, cookieUsed = 0;
    let walled = 0, walledStopped = false;   // (dev0458) login-walled results + first-wall stop
    let consecFail = 0;                      // (dev0645) run of back-to-back download failures
    let deadMarked = 0;                      // (dev0688) rows retired as permanently dead this batch
    const deadIdsThisBatch = [];             // …and which ones, for THIS batch's report
    lowResIds.clear(); fallbackIds.clear();  // (dev0666) per-run download-path tallies
    embedStamped = 0; embedNoVerdict = 0;    // (dev0675) per-run embed-verdict tallies
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
    // (dev0683) What this batch was handed, and what state those rows were in. If a
    // grind stops at "batch downloaded 0", this line says whether the batch was 18
    // fresh rows or the same 2 unreadable ones it choked on last time.
    diag('BATCH-START', {
      label, ids: ids.length, todo: total, wallCap: isDl ? DOWNLOAD_WALL_CAP : WALL_CAP,
      first: ids.slice(0, 6).map(id => { const r = rowById(id); return r ? r.id + ':' + (r.status || '?') + ':' + kindOf(r) : id + ':gone'; })
    });
    for (const id of ids) {
      if (batchAbort) break;
      // (dev0658) VPN kill-switch: in a VPN-committed grind (Download+rotate /
      // Auto-enrich), never start a row on a dead tunnel. A deliberate switch
      // (vpnBusy) is briefly down by design, so it's exempt. Manual Download/Enrich
      // sel are NOT gated — those are deliberate single actions (fbcdn photos may
      // legitimately need the home IP).
      if ((rotatingActive || autoRunning) && !vpnBusy && !(await vpnStillUp())) {
        // (dev0688) A dead proxy also fails this probe. Don't call that a VPN drop and
        // don't fire igKillDownloads() at a proxy that isn't there — break out and let
        // the grind pause on it instead (proxyDown was set by vpnStillUp).
        if (proxyDown) break;
        vpnDropAbort = true; batchAbort = true; igKillDownloads(); break;
      }
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
      // (dev0683) marks BEFORE the attempt — half of the "was this row marked so it
      // could never download?" answer; the other half is logged right after.
      const _marks0 = diagMarks(r);
      const _rowT0 = Date.now();
      let good = await doOne(r);
      // (dev0645) Single in-item retry for DOWNLOADS. The cookieless photo-carousel walker
      // is easily but usually transiently IG-throttled; a short pause + one retry clears
      // most first-attempt blocks so a lone throttled item never aborts the run. Skipped
      // if the failure is a hard rate-limit (429) — retrying that just hammers IG.
      // (dev0688) …and skipped when the post is permanently dead: retrying an
      // audience-restricted or deleted post just spends 19s to get the same sentence.
      if (!good && isDl && !batchAbort && !isThrottle(lastOpError) && !isPermanent(lastOpError) && !proxyDown) {
        diag('row-retry', { id: r.id, after: (lastOpError || '').replace(/\s+/g, ' ').slice(0, 140) });
        const rg = rnd(DOWNLOAD_RETRY_MS[0], DOWNLOAD_RETRY_MS[1]);
        igBatchUpdate(`${label} ${r.id} — retrying in ${(rg / 1000).toFixed(0)}s (transient block?)\n${done}/${total} · ✓${ok}${fail ? ` ✗${fail}` : ''}\n${cookieSoFar()}`);
        await sleep(rg);
        if (!batchAbort) { lastOpError = ''; lastOpInfo = ''; good = await doOne(r); }
      }
      if (good) {
        // (dev0683) verdict + the row's marks before/after the attempt.
        diag('row-ok', { id: r.id, n: `${done}/${total}`, ms: Date.now() - _rowT0,
          was: _marks0, now: diagMarks(r), cookies: lastOpInfo === 'Firefox cookies used' ? 1 : 0 });
        ok++;
        consecFail = 0;                       // (dev0645) success breaks the failure streak
        if (lastOpInfo === 'Firefox cookies used') cookieUsed++;
        igBatchUpdate(`${label} ${r.id} ✓${lastOpInfo === 'Firefox cookies used' ? ' (🍪)' : ''}\n${done}/${total} · ✓${ok}${fail ? ` ✗${fail}` : ''}\n${cookieSoFar()}\n${fmtSpeed()}`);
        if (cookieUsed >= COOKIE_CAP) cookieStopped = true;   // (dev0444) account-safety cap hit
      } else {
        // (dev0683) The failing verdict, with the raw error text the wall/throttle
        // tests actually saw — those tests have silently drifted out of date three
        // times (dev0442/0470/0501), so record their input, not just their answer.
        diag('ROW-FAIL', { id: r.id, n: `${done}/${total}`, ms: Date.now() - _rowT0,
          kind: kindOf(r), was: _marks0, now: diagMarks(r),
          wall: isWall(lastOpError) ? 1 : 0, throttle: isThrottle(lastOpError) ? 1 : 0,
          net: /failed to fetch|networkerror|load failed/i.test(lastOpError || '') ? 1 : 0,
          consecFailWillBe: isDl ? consecFail + 1 : undefined,
          err: (lastOpError || '').replace(/\s+/g, ' ').slice(0, 300) });
        // (dev0457) Attempted but couldn't be read — count it so the end report's
        // numbers close (marked = cookieless + cookie + couldn't-read + not-reached).
        // These are login-walled posts that failed BOTH cookieless and the Firefox-
        // cookie retry; order/pacing can't change that (see igStickyShow report).
        fail++;
        // (dev0688) The proxy vanishing is not Instagram's verdict on this row. Don't
        // let it count toward the consecutive-failure stop and don't let it retire the
        // row — end the batch so the grind can pause and resume (awaitProxyReturn).
        if (proxyDown) { /* no verdict from IG at all — see the break below */ }
        else if (isThrottle(lastOpError)) throttled = true;
        // (dev0688) Permanently dead → retire it and DON'T touch consecFail. Note this
        // sits ahead of the isDl branch below deliberately: that branch counts every
        // download failure regardless of wording, which is right for walls but is
        // exactly what let two dead posts end a 1103-row run.
        else if (isDl && isPermanent(lastOpError)) { markDead(r, lastOpError); deadMarked++; deadIdsThisBatch.push(r.id); }
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
      if (throttled || cookieStopped || walledStopped || proxyDown) break;
    }
    lastBatchDead = deadMarked;          // (dev0688) the grind reads this to tell "0 downloaded
                                         // because everything's blocked" from "0 downloaded
                                         // because the batch was all dead posts" (real progress).
    processingId = null; busy = false; setBatchUi(false); igBatchHide();
    // (dev0683) Exactly which guard ended this batch. "batch downloaded 0" has five
    // different causes and the end report collapses them; this does not.
    diag('BATCH-END', {
      label, ok, fail, done, total, secs: Math.round((Date.now() - t0) / 1000),
      stop: proxyDown ? 'PROXY-DIED' : throttled ? 'THROTTLE' : cookieStopped ? 'COOKIE-CAP'
          : walledStopped ? (isDl ? `WALL-${DOWNLOAD_WALL_CAP}-IN-A-ROW` : 'FIRST-WALL')
          : vpnDropAbort ? 'VPN-DROP' : batchAbort ? 'USER-STOP'
          : done < total ? 'INCOMPLETE' : 'ran-out',
      consecFail, dead: deadMarked, lastErr: (lastOpError || '').replace(/\s+/g, ' ').slice(0, 200)
    });
    // (dev0688) Save when rows were RETIRED too, not only when some downloaded. A batch
    // that downloads 0 and retires 2 has changed real state; under the old `if (ok)` it
    // was thrown away, which is why the same dead posts greeted the next run. Skipped
    // while the proxy is down — there's nothing to save to; awaitProxyReturn flushes it.
    if ((ok || deadMarked) && !proxyDown) { dirty = true; await persist(false); }
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
               : vpnDropAbort  ? `🛑 ${label} stopped — VPN tunnel dropped (nothing ran on your home IP)`
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
    // (dev0688) Retired rows are a SUBSET of couldntRead, but they're the opposite of a
    // problem — they're the backlog getting permanently smaller. Name them separately so
    // "3 couldn't be downloaded" doesn't read as three things still to do.
    if (deadMarked) {
      const ids = deadIdsThisBatch;
      lines.push(`🪦 ${deadMarked} retired — the post is gone or restricted to an audience you can't be in`,
        `   ${ids.slice(0, 6).join(', ')}${ids.length > 6 ? ` +${ids.length - 6} more` : ''}`,
        `   These will not be offered again. Check one and press Download to force a retry.`);
    }
    if (couldntRead) lines.push(`${couldntRead} ${isDl ? "couldn't be downloaded" : "couldn't be read"}  (needs a login)${deadMarked ? ` — ${deadMarked} of them retired, above` : ''}`);
    if (notReached)  lines.push(`${notReached} not reached  (run stopped early)`);
    // (dev0666) Download-path quality, reported once at the end instead of per-row toasts
    // the live panel used to cover. Low-res rows also carry a ⚠ marker in their W×H cell.
    if (isDl && lowResIds.size) {
      const ids = [...lowResIds];
      lines.push(`⚠ ${ids.length} came via the low-res EMBED fallback (first image only) — marked ⚠ in W×H`,
        `   ${ids.slice(0, 6).join(', ')}${ids.length > 6 ? ` +${ids.length - 6} more` : ''}`);
    }
    if (isDl && fallbackIds.size) lines.push(`ℹ ${fallbackIds.size} used a cookieless fallback path (still full res)`);
    // (dev0675) Embed verdicts stamped as part of this run. A "no verdict" row is not a
    // failure — it stays unstamped for igEmbedProbe.js to resolve later.
    if (isDl && (embedStamped || embedNoVerdict)) {
      lines.push(`▶ embed verdict stamped on ${embedStamped}${embedNoVerdict ? ` · ${embedNoVerdict} inconclusive (still unprobed, backfill later)` : ''}`);
    }
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
      autoBatchSize = Math.max(1, Math.min(50, +j.batchSize || 38));
    } catch (_) { autoBatchSize = 38; }
  }
  function saveAuto() {
    try { localStorage.setItem(AUTO_KEY, JSON.stringify({ batchSize: autoBatchSize })); } catch (_) {}
  }

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
        '🤖 auto · 🍪 cookieless · auto-rotating US VPN exits');
      if (!autoRunning) return;                               // Stop pressed mid-batch
      if (vpnDropAbort) {                                     // (dev0658) tunnel dropped → stop, do NOT rotate back up
        autoRunning = false; autoPaused = false;
        igStickyShow('🛑 VPN tunnel dropped — auto-enrich stopped.\nNothing ran on your home IP. Bring the VPN up (🛠 Fix ▸ Bring VPN up), then ▶ Start.');
        renderAuto(); return;
      }
      autoTotalOk += ok;
      if (ok > 0) autoDry = 0;                                // real progress resets the dry-rotation guard
      const newWalls = [...enrichFailed].filter(id => !before.has(id));
      renderAuto();
      if (newWalls.length) {
        // Tell a dead POST from a walled EXIT (one extra enrich on the SAME exit).
        const probe = await probeExit(newWalls[0]);
        if (!autoRunning) return;
        if (probe === 'ok') { autoDead.add(newWalls[0]); autoDry = 0; continue; }   // dead post, exit fine → carry on
        if (probe === 'nomore') { autoFinish(); return; }
        if (probe === 'error') {                             // transient/proxy — a fresh IP won't help
          autoPause('⚠ Enrich errored (not a wall) — likely a transient/proxy hiccup.\nCheck the proxy, then ▶ Start to resume.');
          return;
        }
        // probe === 'wall' → the EXIT itself is walling → rotate to a fresh US exit.
        if (ok === 0 && ++autoDry >= AUTO_DRY_LIMIT) { autoFinishDry(); return; }
        const rotated = await autoRotateExit('⚠ exit walled — rotating to a fresh US exit');
        if (!autoRunning) return;
        if (!rotated) { autoPause('⏸ Couldn\'t bring up a fresh VPN exit (tried a few).\nCheck the VPN, then ▶ Start to resume.'); return; }
        continue;
      }
      if (ok > 0) { await sleep(autoGapMs); continue; }       // clean progress → breather → next
      autoPause('⚠ No progress and no wall — is the proxy (127.0.0.1:8081) running?\nFix it, then ▶ Start to resume.');
      return;
    }
  }

  // (dev0654) Auto-rotation — swap the Proton VPN to a fresh US exit (the same
  // vpnEnsureUp switcher the Download+rotate button uses), then clear this session's
  // per-exit wall marks so rows that walled on the OLD exit retry on the new one.
  // Genuinely-dead posts stay in autoDead and never come back. Returns true once a
  // working exit is confirmed up.
  async function autoRotateExit(note) {
    busy = true; setBatchUi(true);
    igBatchShow((note || '🔀 rotating VPN') + '\nswitching Proton VPN to a fresh US exit…');
    const sw = await vpnEnsureUp('auto-enrich rotate');
    busy = false; setBatchUi(false); igBatchHide();
    if (!sw) return false;
    autoSwitches++;
    enrichFailed.clear();
    await vpnRefresh(false);
    igToast(`🟢 VPN → ${sw.server || sw.ip || '?'}${sw.ip ? '  ' + sw.ip : ''}`, 3000);
    renderAuto();
    return true;
  }

  function autoPause(msg) { autoPaused = true; igStickyShow(msg); renderAuto(); }
  async function autoStart() {
    if (autoRunning && !autoPaused) return;
    if (busy) { igToast('A batch is already running — wait for it to finish.', 2400); return; }
    if (!autoRemaining()) { igToast('Nothing to enrich in the current view.\n(Clear filters / set status to new if needed.)', 3000); return; }
    autoRunning = true; autoPaused = false; batchAbort = false;   // (dev0653-style) clear a prior Stop
    autoTotalOk = 0; autoSwitches = 0; autoDry = 0;
    igStickyHide(); renderAuto();
    // Bring a US Proton exit up BEFORE batch 1 so enrich never rides the home IP.
    await vpnRefresh(false);
    if (autoRunning && !(vpnStatus && vpnStatus.tunnelUp)) {
      const up = await autoRotateExit('🔀 bringing up a US VPN exit before batch 1');
      if (!autoRunning) { renderAuto(); return; }
      if (!up) {
        autoRunning = false; renderAuto();
        igStickyShow('⏹ Couldn\'t bring up a VPN exit — nothing enriched on your home IP.\nCheck the VPN, then ▶ Start.');
        return;
      }
    }
    if (!autoRunning) return;
    autoLoop();
  }
  function autoResume() {
    if (!autoRunning) { autoStart(); return; }
    if (!autoPaused) return;
    autoPaused = false; batchAbort = false; igStickyHide(); renderAuto(); autoLoop();
  }
  function autoStopRun() {
    autoRunning = false; autoPaused = false; batchAbort = true;   // break any in-flight batch
    renderAuto();
    igToast('🤖 auto-enrich stopped', 1500);
  }
  function autoFinish() {
    autoRunning = false; autoPaused = false; renderAuto();
    igStickyShow('✓ Auto-enrich complete — no rows left to enrich in this view.\n'
      + `${autoTotalOk} enriched · ${autoSwitches} VPN switch${autoSwitches === 1 ? '' : 'es'}`
      + (autoDead.size ? ` · ${autoDead.size} unreadable post(s) skipped` : '') + '.\n'
      + 'Downloads now also rotate US VPN exits — use ⬇⟳ Download + rotate.');
  }
  function autoFinishDry() {
    autoRunning = false; autoPaused = false; renderAuto();
    igStickyShow(`⏹ Stopped — rotated ${autoSwitches} VPN exit${autoSwitches === 1 ? '' : 'es'} with no new enriches.\n`
      + `${autoTotalOk} enriched this run. The remaining rows are almost certainly login-walled / private\n`
      + '(a fresh IP won\'t help). Re-run later, or leave them.');
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
        + '<label>batch <input id="igAutoSize" type="number" min="1" max="50" value="38"></label>'
      + '</div>'
      + '<div id="igAutoInfo"></div>'
      + '<div id="igAutoNote">Grinds the not-yet-enriched backlog in this view, cookielessly, and <b>auto-rotates the Proton VPN to a fresh US exit</b> whenever an exit walls — no manual switching. Filter the view (e.g. Status → new) to control what it grinds.</div>';
    (document.getElementById('igOverlay') || document.body).appendChild(p);
    p.querySelector('#igAutoHide').addEventListener('click', () => p.classList.remove('open'));
    p.querySelector('#igAutoStartBtn').addEventListener('click', () => autoStart());
    p.querySelector('#igAutoPauseBtn').addEventListener('click', () => {
      if (autoRunning && !autoPaused) autoPause('⏸ Paused by you.\nPress ▶ Start to resume.');
      else autoResume();
    });
    p.querySelector('#igAutoStopBtn').addEventListener('click', autoStopRun);
    p.querySelector('#igAutoSize').addEventListener('change', e => { autoBatchSize = Math.max(1, Math.min(50, +e.target.value || 38)); saveAuto(); renderAuto(); });
  }
  function renderAuto() {
    const p = document.getElementById('igAuto'); if (!p) return;
    const st = p.querySelector('#igAutoState');
    const state = !autoRunning ? 'idle' : (autoPaused ? 'paused' : 'running');
    if (st) { st.textContent = state; st.className = 'st-' + state; }
    const exit = (vpnStatus && vpnStatus.tunnelUp)
      ? esc(vpnStatus.server || vpnStatus.ip || '?')
      : '<span class="warn">no VPN tunnel</span>';
    const info = p.querySelector('#igAutoInfo');
    if (info) info.innerHTML = '<b>' + autoRemaining() + '</b> to enrich in view · exit <b>' + exit + '</b>'
      + ((autoRunning || autoTotalOk) ? ' · ' + autoTotalOk + ' done · ' + autoSwitches + ' switch' + (autoSwitches === 1 ? '' : 'es') : '')
      + (autoDead.size ? ' · ' + autoDead.size + ' skipped' : '');
    const size = p.querySelector('#igAutoSize'); if (size && document.activeElement !== size) size.value = autoBatchSize;
    const startB = p.querySelector('#igAutoStartBtn'); if (startB) startB.disabled = autoRunning && !autoPaused;
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
      // (dev0675) Ask the proxy to stamp the official-embed verdict on the way back —
      // but ONLY for a row that has none yet, so a re-download never re-probes IG.
      const _dlT0 = Date.now();
      const res = await fetch(PROXY + '/ig/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: r.id, url: r.url, name: downloadName(r), coverOnly,
          probeEmbed: r.embed !== 0 && r.embed !== 1 })
      });
      const j = await res.json();
      // (dev0683) The proxy's own verdict for this row, timed. A download that takes
      // minutes and then fails is a different disease from one that fails in 2s.
      diag('dl-reply', { id: r.id, http: res.status, ms: Date.now() - _dlT0,
        ok: j && j.ok ? 1 : 0, files: (j && j.files || []).length,
        via: j ? ['viaEmbed', 'viaCover', 'viaMainVideo', 'viaMainCarousel', 'viaGalleryDl'].filter(k => j[k]).join('+') : '',
        embed: j && (j.embed === 0 || j.embed === 1) ? j.embed : (j && j.embedProbe) || '',
        err: (j && j.error || '').replace(/\s+/g, ' ').slice(0, 200) });
      if (!j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + res.status));
      // (dev0660) A success carrying ZERO files is a FALSE success — never mark the row
      // downloaded on it. The old code stamped status='downloaded' with an empty localFiles
      // whenever the proxy returned {ok:true, files:[]}, leaving 18 photo /p rows flagged
      // downloaded with nothing on disk. Treat it as a failure so status stays put.
      if (!j.files || !j.files.length) throw new Error('download returned no files (nothing landed on disk)');
      r.localFiles = j.files || [];
      // (dev0659) The proxy stamps the real ffprobe'd length into the filename; adopt it so
      // the row's durSecs matches the file — fixes the 00.00.00 that missing enrich metadata
      // left behind, and makes a later Promote carry the right length. Images stay 0.
      const _nm0 = r.localFiles[0] || '';
      const _hm = _nm0.match(/^(\d{2})\.(\d{2})\.(\d{2})~/);
      if (_hm) { const _s = (+_hm[1]) * 3600 + (+_hm[2]) * 60 + (+_hm[3]); if (_s > 0) r.durSecs = _s; }
      // (dev0677) Same for W×H, which the proxy now ground-truths from the landed file.
      // A re-fetched photo comes back BIGGER than the row's stored dims (the old cropped
      // 640² cover), so adopt the file's real size — otherwise the row keeps advertising
      // a resolution it no longer has, and a later Promote would carry the wrong one.
      const _wh = _nm0.match(/^\d{2}\.\d{2}\.\d{2}~(\d+)x(\d+)~/);
      if (_wh) { const _w = +_wh[1], _h = +_wh[2]; if (_w > 0 && _h > 0) { r.width = _w; r.height = _h; } }
      // (dev0659) Surface a resolution-lossy fallback even in batch/rotate (single=false
      // suppresses the normal per-row toast). The embed rescue is first-image-only — clearly
      // not top-res — so always warn. The /p video_versions + carousel + gallery-dl paths are
      // max-res-equivalent to yt-dlp, so they get a quieter "used a fallback" note.
      // (dev0666) In a BATCH these used to fire a transient igToast per row, which the
      // live progress panel immediately covered — the user saw only a flash of "…download
      // later" and could never read which row it was. Tally them on the run instead: the
      // low-res rows also get a PERSISTENT ⚠ marker in the W×H cell (so they stay findable
      // after the toast is long gone) and both counts land in the end-of-run report.
      if (j.viaEmbed) {
        r.lowResDl = true;
        lowResIds.add(r.id);
        if (single) igToast('⚠ ' + r.id + ': low-res EMBED fallback (first image only) — re-download later for full res', 4200);
      } else {
        if (r.lowResDl) delete r.lowResDl;          // a later full-res download clears the flag
        // (dev0678) viaCover = the main /p/ page's index-1 cover. Since dev0677 that is
        // the FULL-RES original, so it counts as a fallback PATH, not a loss of quality.
        if (j.viaMainVideo || j.viaMainCarousel || j.viaGalleryDl || j.viaCover) fallbackIds.add(r.id);
      }
      // (dev0677) The re-fetch queue drains itself: a row marked needsFullRes clears the
      // mark as soon as a download lands, and keeps `prevFiles` (the superseded low-res
      // filename) + a timestamp so the old file can be swept afterwards and the "done"
      // filter can show what was rebuilt. A row that fails stays queued for the next run.
      if (r.needsFullRes) {
        delete r.needsFullRes;
        r.refetchedAt = (typeof isoNow === 'function') ? isoNow()
          : new Date().toISOString().slice(0, 19).replace('T', ' ');
      }
      // (dev0675) Adopt the download-time embed verdict. Only a CONCLUSIVE probe writes
      // the field; a walled/inconclusive one leaves the row unstamped so igEmbedProbe.js
      // can still resolve it later — the flag must never be a guess, the grids gate
      // official-iframe playback on it.
      if (j.embed === 0 || j.embed === 1) { r.embed = j.embed; embedStamped++; }
      else if (j.embedProbe) embedNoVerdict++;
      if (r.status !== 'promoted') r.status = 'downloaded';
      // (dev0663) Close the last date-loss hole: if the inline enrich failed (or came
      // via the caption-only embed) the download still succeeds, but the row would be
      // stamped 'downloaded' with a blank Posted date — invisibly, which is how 73
      // such rows piled up. Flag it partial so it stays visible; a later re-fetch that
      // does land a date clears it.
      if (!(r.DatePosted && String(r.DatePosted).trim())) r.metaPartial = true;
      else if (r.metaPartial) delete r.metaPartial;
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
          + (j.embed === 1 ? '\n▶ embeddable ✓ — IG’s official iframe will play it'
             : (j.embed === 0 ? '\n▶ not embeddable ✗ — official iframe shows poster only'
                : (j.embedProbe ? '\n▶ embed verdict: none (' + j.embedProbe + ') — left unstamped' : '')))
          + (j.viaEmbed ? '\n📐 via embed page — first image only (thumbnail)' : '')
          + (j.viaCover ? '\n🖼 index-1 cover at full resolution (main /p/ page)' : '')
          + (j.viaMainVideo ? '\n🎞 reel via cookieless /p/ page (yt-dlp was walled)' : '')
          + (j.viaMainCarousel ? '\n🖼 full carousel via cookieless /p/ page (no cookies)' : '')
          + '\n' + fileLine, 3800);
      }
      return true;
    } catch (e) {
      lastOpError = (e && e.message) || '';
      // (dev0683) A bare "Failed to fetch" here means the PROXY didn't answer — the
      // run then counts it as an Instagram failure and can stop the whole grind on
      // it. Confirm which world we're in, for the record only; nothing branches.
      if (/failed to fetch|networkerror|load failed|refused/i.test(lastOpError)) {
        const _alive = await diagProxyAlive();
        diag('DL-NETWORK-ERROR', { id: r.id, err: lastOpError, proxy: _alive });
        // (dev0688) This used to be pure commentary ("nothing branches on it"). It now
        // branches: a network-class failure whose proxy check says NOPROXY is the proxy
        // death we've chased since dev0683, and it is NOT a verdict on this row or on
        // Instagram. Flag it so runBatch ends the batch cleanly and the grind PAUSES
        // instead of reporting a fake login-wall and losing its final save.
        if (/^NOPROXY/.test(_alive)) {
          proxyDown = true;
          proxyKillIds.add(r.id);
          r.proxyKills = (r.proxyKills || 0) + 1;
          dirty = true;
          diag('PROXY-DIED', { id: r.id, kind: kindOf(r), kills: r.proxyKills,
            url: r.url || '', retiredNow: r.proxyKills >= 2 ? 1 : 0 });
        }
      }
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
    // (dev0688) A manual, checked Download is the deliberate override: it does NOT
    // filter out retired rows, so re-checking a wrongly-retired post retries it. Reset
    // the run tallies so this batch's report counts only itself.
    deadThisRun.clear(); proxyKillIds.clear(); proxyDown = false;
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
  // (dev0654) Grindable by Download+rotate = not-yet-downloaded AND (already enriched OR
  // still 'new'): downloadRow enriches a 'new' row inline (it needs title/duration/res for
  // the filename + best quality anyway), so one grind now enriches+downloads in a pass —
  // nothing lost vs enriching separately first. Skip rows that login-walled enrich this
  // session (a retry would just wall again) and already-promoted rows.
  // (dev0688) …and skip rows retired as permanently dead, plus any row that was in
  // flight when the proxy died. The latter is the reason dev0679's resume felt WORSE
  // than abandoning the run: on resume the killer row was still top-of-view, so the
  // grind fed it straight back in, died again, and ping-ponged. A row gets one strike
  // per run (proxyKillIds) and is retired for good at two (r.proxyKills) — so a resume
  // always makes forward progress instead of re-running the thing that just killed it.
  const isReady = r => !!r && !isDownloaded(r) && r.status !== 'promoted'
    && (r.status === 'enriched' || r.status === 'new') && !enrichFailed.has(r.id)
    && !r.dead && !proxyKillIds.has(r.id) && !(r.proxyKills >= 2);
  // (dev0688) THE PROXY DIED MID-GRIND → PAUSE, don't abandon.
  // Every death so far cost more than the run: the final persist() never happened, so
  // files that were already on disk kept rows marked un-downloaded (22 had to be
  // reconciled by hand on 2026-07-27). Waiting costs nothing and saves both.
  // Deliberately does NOT restart anything. No daemon, no spawned window, no scheduled
  // task — all previously rejected, and a flashing window every minute is worse than
  // the bug. This only WATCHES /version and picks up the instant you restart it by
  // hand; while it waits, ⏹ Stop still ends the run.
  // Returns true if the proxy came back and the grind should continue.
  async function awaitProxyReturn(totalOk) {
    const t0 = Date.now();
    const LIMIT_MS = 30 * 60 * 1000;      // give up after 30 min of silence
    const killer = [...proxyKillIds].pop() || '?';
    diag('PROXY-PAUSE', { totalOk, killer, unsaved: dirty ? 1 : 0 });
    while (!batchAbort && Date.now() - t0 < LIMIT_MS) {
      const w = Math.round((Date.now() - t0) / 1000);
      igBatchShow(`⛔ The proxy stopped answering — this run is PAUSED, not lost.\n`
        + `${totalOk} downloaded so far${dirty ? ' (not yet written to ig.json)' : ''}.\n\n`
        + `▶ Double-click startproxy.bat to bring it back.\n`
        + `It saves and resumes by itself the moment the proxy answers.\n\n`
        + `waiting ${Math.floor(w / 60)}:${pad2(w % 60)}  ·  ⏹ Stop to give up`);
      await sleep(5000);
      if (batchAbort) break;
      const alive = await diagProxyAlive();
      if (/^NOPROXY/.test(alive)) continue;
      // Back. FIRST thing: flush the save the death would have swallowed.
      proxyDown = false;
      igBatchShow('✓ proxy is back — saving what the run already had…');
      const saved = await persist(false);
      diag('PROXY-BACK', { downSecs: Math.round((Date.now() - t0) / 1000), build: alive,
        saved: saved ? 1 : 0, skipping: killer });
      igToast(`🟢 Proxy back after ${fmtDur((Date.now() - t0) / 1000)} — resuming.\n`
        + (saved ? `${totalOk} downloaded so far are saved.` : `⚠ save STILL failing — check the proxy window.`)
        + `\nSkipping ${killer} (it was in flight when the proxy died).`, 5200);
      return true;
    }
    diag('PROXY-GONE', { waitedSecs: Math.round((Date.now() - t0) / 1000),
      stoppedByUser: batchAbort ? 1 : 0, unsaved: dirty ? 1 : 0 });
    return false;
  }

  async function batchDownloadRotating() {
    if (busy) return;
    const readyIds = () => view.filter(isReady).map(r => r.id);   // top-of-view first
    let todo = readyIds();
    if (!todo.length) {
      igToast('No downloadable rows in this view.\nNeed rows that are new or enriched (not yet downloaded).\nClear filters, or set Status → new / enriched, then run this.', 4600);
      return;
    }

    await vpnRefresh(false);
    const exitNow = vpnStatus && vpnStatus.tunnelUp
      ? 'current exit: ' + (vpnStatus.server || vpnStatus.ip || '?')
      : '⚠ no Proton tunnel up yet — it will bring one up BEFORE batch 1';
    const nNew = todo.filter(id => (rowById(id) || {}).status === 'new').length;
    const auths = [...new Set(todo.map(id => rowById(id)?.author).filter(Boolean))];
    const authLine = auths.length <= 4 ? auths.map(a => '@' + a).join(', ') : (auths.length + ' authors');
    if (!confirm(
        `Download ${todo.length} item(s) from ${authLine}`
      + (nNew ? `  (${nNew} not-yet-enriched — they enrich inline first)` : '') + `\n`
      + `in batches of ${ROTATE_CHUNK}, switching the Proton VPN to a fresh US exit between batches.\n\n`
      + `• ${exitNow}\n`
      + `• Cookieless — your IG login is never used.\n`
      + `• Stops on the first batch that downloads nothing, or when none remain.\n`
      + `• Press ⏹ Stop any time.`)) return;

    let totalOk = 0, batches = 0, switches = 0, endMsg = '';
    // (dev0688) Per-RUN tallies. Cleared here (not in runBatch) so a grind's report
    // covers every batch it ran, and so a fresh grind forgives rows the last one
    // quarantined for killing the proxy — one strike is per-run, two is permanent.
    let _proxyPauses = 0;
    deadThisRun.clear(); proxyKillIds.clear(); proxyDown = false;
    // (dev0664) elapsed clock for the grind — every toast reports time since start.
    const t0 = Date.now();
    const elapsed = () => fmtDur((Date.now() - t0) / 1000);
    // (dev0653) A prior Stop left batchAbort=true; clear it here or the outer
    // `while (!batchAbort)` loop (and vpnEnsureUp's own !batchAbort guard) would
    // be skipped on the very first check → an instant "0 downloaded, 0 switches".
    batchAbort = false; vpnDropAbort = false; vpnDownStreak = 0;
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
    rotatingActive = true;             // (dev0658) arm the VPN kill-switch for this grind
    // (dev0683) The grind's opening state: how many rows it believes are grindable,
    // under which filters, and what the first rows in view order are. `readyIds()`
    // re-derives from `view` EVERY round, so if the head of the view is a row that
    // can never download, every round hands it back — that is visible from here on.
    diag('GRIND-START', {
      ready: todo.length, chunk: ROTATE_CHUNK, exit: (vpnStatus && (vpnStatus.server || vpnStatus.ip)) || 'none',
      filters: { author: authorFilter, status: statusFilter, kind: kindFilter, staged: stagedFilter, embed: embedFilter, refetch: refetchFilter, hideCompleted: hideCompleted ? 1 : 0, q: query || '' },
      sort: sortCol + (sortDir < 0 ? '↓' : '↑'), view: view.length, coverOnly: coverOnly ? 1 : 0,
      head: todo.slice(0, 8).map(id => { const r = rowById(id); return r.id + ':' + r.status + ':' + kindOf(r) + ':' + (r.VidTitle ? 'T' : '-'); })
    });
    while (!batchAbort) {
      todo = readyIds();
      if (!todo.length) { endMsg = `✓ Done — no more downloadable rows in this view.`; break; }
      const chunk = todo.slice(0, ROTATE_CHUNK);
      batches++; lastDlName = '';
      // runBatch owns its own busy/UI/abort + per-item live panel; it resets
      // batchAbort at its start, so we re-check batchAbort AFTER it returns.
      const okThis = await runBatch(`Downloading (batch ${batches})`, chunk, DOWNLOAD_GAP,
        r => downloadRow(r, false), isDownloaded, '🍪 cookieless — your IG login is never used');
      totalOk += okThis;
      // (dev0683) Round-level view: did the backlog actually shrink? A round that
      // downloads nothing while `remaining` stays put is the same rows coming back.
      diag('grind-round', { batch: batches, ok: okThis, totalOk,
        remaining: readyIds().length, elapsed: elapsed(),
        abort: batchAbort ? 1 : 0, vpnDrop: vpnDropAbort ? 1 : 0 });
      igStickyHide();                 // suppress runBatch's per-chunk report — we toast instead
      // (dev0688) Proxy death is the ONE stop reason that isn't a verdict on the work,
      // so it gets a pause instead of an ending. Checked before the abort/zero-batch
      // tests below, both of which would otherwise mis-report it (a dead proxy makes
      // every row fail, which reads exactly like a login wall — that misreading is what
      // sent three sessions chasing the VPN).
      if (proxyDown) {
        _proxyPauses++;
        if (await awaitProxyReturn(totalOk)) continue;
        endMsg = batchAbort
          ? `⏹ Stopped by you while waiting for the proxy.\n${totalOk} downloaded before it died.`
          : `⛔ The proxy never came back (waited 30 min).\n${totalOk} downloaded before it died — ⚠ the last few may not be written to ig.json.\nRestart it with startproxy.bat, then press 💾 Save.`;
        break;
      }
      if (batchAbort) { endMsg = vpnDropAbort
        ? `🛑 VPN tunnel dropped — stopped. ${totalOk} downloaded, all through a VPN. Nothing ran on your home IP.`
        : `⏹ Stopped by you — ${totalOk} downloaded across ${batches} batch${batches === 1 ? '' : 'es'}.`; break; }
      // (dev0688) …unless the batch's zero came from RETIRING dead posts. That is real
      // forward progress — the backlog just shrank permanently — so the grind carries on
      // to rows that can actually download, instead of stopping and blaming the VPN.
      if (okThis === 0 && !lastBatchDead) {   // a whole batch got nothing → a wall/login, not an IP block
        endMsg = `⏹ Batch ${batches} downloaded 0 — stopped.\n${totalOk} downloaded before this. Likely a login wall or a blocked exit — try again later or check the VPN.`;
        break;
      }
      const remain = readyIds().length;
      // auto-dismissing success toast: cumulative + most recent (the user's ask)
      igToast(`✓ Batch ${batches}: ${okThis} downloaded  ·  ${totalOk} total  ·  ${elapsed()} elapsed`
        // (dev0688) Retirements are progress, so they belong in the running readout —
        // otherwise a batch that retired 3 dead posts and downloaded 2 just looks slow.
        + (lastBatchDead ? `\n🪦 ${lastBatchDead} retired (gone / restricted) — won't be offered again` : '')
        + (lastDlName ? `\nlast: ${lastDlName}` : '')
        + (remain ? `\n${remain} still to go — 🔀 switching VPN…` : ''), 4200);
      if (!remain) { endMsg = `✓ Done — ${totalOk} downloaded across ${batches} batch${batches === 1 ? '' : 'es'}; nothing left to download.`; break; }
      // switch exits before the next batch
      busy = true; setBatchUi(true);
      igBatchShow(`🔀 switching Proton VPN before batch ${batches + 1}…\n${totalOk} downloaded so far  ·  ${elapsed()} elapsed`);
      const sw = await vpnEnsureUp(`switching after batch ${batches}`);
      if (sw) { switches++; igToast(`🟢 VPN → ${sw.server || sw.ip || '?'}${sw.ip ? '  ' + sw.ip : ''}\n${totalOk} downloaded  ·  ${elapsed()} elapsed`, 3000); }
      else {
        // Never download on the home IP — the user wants everything through a VPN.
        endMsg = `⏹ Stopped — couldn't get a working VPN exit after batch ${batches} (tried a few).\n${totalOk} downloaded, all through a VPN. NOT continuing on your home IP.`;
        break;
      }
      await sleep(1500);
    }
    rotatingActive = false;
    busy = false; setBatchUi(false); igBatchHide();
    await vpnRefresh(false);
    const exit = vpnStatus && vpnStatus.tunnelUp ? (vpnStatus.server || vpnStatus.ip || '?') : 'no tunnel';
    // (dev0683) The end of the story, next to the proxy's verdict at the same moment.
    // Whatever the report says, `proxy` here is the ground truth about the proxy.
    diag('GRIND-END', {
      totalOk, batches, switches, elapsed: elapsed(), exit,
      leftInView: view.filter(isReady).length,
      dead: deadThisRun.size, proxyPauses: _proxyPauses, unsaved: dirty ? 1 : 0,
      proxy: await diagProxyAlive(),
      msg: (endMsg || '').replace(/\s+/g, ' ').slice(0, 200)
    });
    igStickyShow((endMsg || `Finished — ${totalOk} downloaded.`)
      // (dev0664) final report always states the run total + wall-clock time since start.
      + `\n\nTOTAL: ${totalOk} downloaded in ${elapsed()}`
      + (totalOk ? `  (${fmtDur(((Date.now() - t0) / 1000) / totalOk)} each)` : '')
      + `\n${batches} batch${batches === 1 ? '' : 'es'}  ·  ${switches} VPN switch${switches === 1 ? '' : 'es'}  ·  current exit: ${exit}`
      // (dev0688) Two new facts the old report couldn't state, both of which used to
      // masquerade as "batch downloaded 0 — check the VPN".
      + (deadThisRun.size ? `\n🪦 ${deadThisRun.size} retired as permanently unavailable (gone / audience-restricted) — never offered again  ·  Status ▸ 🪦 retired to see them` : '')
      + (_proxyPauses ? `\n⛔ the proxy died ${_proxyPauses}× — the run paused and resumed; nothing was lost` : '')
      + (dirty ? `\n⚠ ig.json has UNSAVED changes — press 💾 Save` : '')
      // (dev0683) Point at the evidence while the run is still fresh.
      + `\n\n🩺 Every step of this run was recorded — 🛠 Fix ▸ 🩺 Diagnostics (and proxy.log).`);
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
    // (dev0665) Carry the official-embed verdict so grid/public code can gate on it.
    if (r.embed === 0 || r.embed === 1) mlRow.embed = r.embed;
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
    // (dev0683) MEASURE THE SAVE — diagnostics only, same request as before. Every
    // batch of 18 downloads ends here, and ig.json is ~49MB: this stringify blocks
    // the browser, the POST ships 49MB over loopback, and the proxy then reads +
    // copies + rewrites the same 49MB (see its /ig/save line). If a long grind is
    // dying of memory or I/O rather than of Instagram, the trend lives in these
    // numbers — they are the reason a grind gets slower the longer it runs.
    const _t0 = Date.now();
    let _body = '', _strMs = 0;
    try {
      _body = JSON.stringify({ rows, knownIds: [...knownIds] });
      _strMs = Date.now() - _t0;
      const res = await fetch(PROXY + '/ig/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: _body
      });
      const j = await res.json();
      diag('save', {
        MB: (_body.length / 1048576).toFixed(1), rows: rows.length,
        stringifyMs: _strMs, totalMs: Date.now() - _t0,
        ok: j && j.ok ? 1 : 0, rescued: (j && j.rescued) || 0,
        mem: (performance && performance.memory)
          ? Math.round(performance.memory.usedJSHeapSize / 1048576) + 'MB' : ''
      });
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
      // (dev0683) A save that fails mid-grind is one of the ways the run "dies" —
      // and if the cause is the proxy, this is often the FIRST place it shows.
      diag('SAVE-FAILED', {
        MB: (_body.length / 1048576).toFixed(1), rows: rows.length,
        stringifyMs: _strMs, totalMs: Date.now() - _t0, err: (e && e.message) || '',
        proxy: await diagProxyAlive()
      });
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
    // (dev0655) Alphabetical (case-insensitive) — was count-descending. Both the
    // Harvested and Unharvested groups derive from this list, so both end up A→Z.
    const all = Object.keys(counts).sort((a, b) =>
      (a || '').toLowerCase().localeCompare((b || '').toLowerCase()));
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
    loadFilters(); syncFilterControls();   // (dev0655) resume the last filter/sort
    document.getElementById('igOverlay').classList.add('open');
    loadData();
    vpnRefresh(false); vpnStartPoll();   // (dev0649) show the current Proton exit + keep it live
    // (dev0683) Mark the session boundary in the black box, and make sure the last
    // few buffered events survive a tab close / reload / crash. `pagehide` fires in
    // cases `beforeunload` does not, so both are wired, once.
    diag('screen-open', { ua: navigator.userAgent.slice(0, 60), href: location.host + location.pathname });
    if (!window._igDiagUnload) {
      window._igDiagUnload = true;
      const bye = () => { try { diagFlush(); diagMirrorSend(); } catch (_) {} };
      window.addEventListener('pagehide', bye);
      window.addEventListener('beforeunload', bye);
    }
    // (dev0438) Come up UNFOCUSED so bare-letter hotkeys (f/F/c/…) work right
    // away; press f to jump into the filter box, Shift+F to clear it.
  }
  function closeIgScreen() {
    if (autoRunning && !autoPaused) autoPause('⏸ Auto-enrich paused — I screen closed. Reopen (I) and press ▶ Start to resume.');  // (dev0517)
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
