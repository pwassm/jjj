// ==UserScript==
// @name         SLAM IG Reel Harvester
// @namespace    sealifeandmore
// @version      2.8
// @downloadURL  http://localhost:8080/ig-harvest.user.js
// @updateURL    http://localhost:8080/ig-harvest.user.js
// @description  Keeps your list of favourite Instagram contributors up to date. Adds a small button bar to the bottom-right of any profile page. 🆕 New only — collect just the posts you don't already have (a few seconds; the everyday button). ⬇ All — collect every post on the profile, newest to oldest (slow; for a first-time author). 🔁 Sweep — do "New only" on one author after another, unattended, from a list you tick. ▶ Resume — go back to reading where you left off: paste a post's link and it opens that post with the ◀ ▶ arrows working. Reads only the page your browser has already drawn in your normal logged-in session. Install or update: open http://localhost:8080/ig-harvest.user.js
// @author       SLAM
// @match        https://www.instagram.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';
  const VER = '2.8';
  const PROXY = 'http://127.0.0.1:8081';
  // First path segment that is NOT one of these = an author profile.
  const RESERVED = new Set(['explore', 'reels', 'reel', 'p', 'tv', 'stories', 'direct',
    'accounts', 'about', 'legal', 'web', 'popular', 'your_activity', 'lite', 'directory', '']);

  // ── Early-stop tuning (dev0794) ────────────────────────────────────────────
  // An IG profile grid is strictly newest-first, so everything below a run of
  // posts we already have is older and already harvested. STOP_RUN is that run:
  // 15 tiles = 5 grid rows at 3 across, comfortably more than one lazy-load batch.
  const STOP_RUN  = 15;
  // IG pins up to 3 OLD posts to the top of the grid. Those read as "already
  // known" the instant the page renders, so without this a new-only pass would
  // quit on step one having seen nothing. Tiles carrying the pin icon — and the
  // first 3 positions regardless, in case IG renames that aria-label — can
  // neither extend nor end a run. They are still collected and still sent.
  const PIN_SKIP  = 3;
  const MIN_STEPS = 2;      // never stop on a half-rendered grid
  const NEW_MAX_ITER = 80;  // new-only walks gently; this bounds a profile that never matches
  const MAX_ITER  = 500, STALE_STOP = 6;
  const GAP_MIN = 25000, GAP_MAX = 55000;   // pause between authors in a sweep
  const SWEEP_KEY = 'slamIgSweep';
  const SWEEP_TTL = 6 * 3600 * 1000;        // an abandoned sweep expires rather than ambushing you

  // ── (dev0807) "already harvested?" status on the ⬇ All button ──────────────
  // /ig/authors already hands back per-author row counts, so a profile ig.json
  // ALREADY holds can grey its full-harvest button and point at 🆕 New only.
  // Deliberately NOT `disabled`: a periodic deep re-check of a known author is a
  // real thing to want, so grey means "are you sure", not "no".
  const STATUS_TTL = 60000;   // re-ask the proxy at most once a minute
  // (dev0915) Every one of these balloons used to describe the MACHINERY — shortcodes,
  // staging, tunnels, grid modals. Read cold, none of them told you what the button
  // does for you or when to press it. They now say that, in the order you need it:
  // what it collects, how long it takes, when to reach for it instead of its neighbour.
  const ALL_TITLE  = 'Collect EVERY post on this profile, from the newest all the way'
    + ' back to the oldest.\n\nSlow — a big author can take several minutes. Use it the'
    + ' first time you add someone, or now and then to be sure nothing was missed.'
    + '\n\nDay to day, use 🆕 New only instead.';

  function authorFromPath() {
    const seg = (location.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
    return RESERVED.has(seg) ? '' : seg;
  }
  const onProfile = () => !!authorFromPath();

  function shortcode(href) {
    const m = href.match(/instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/i);
    return m ? m[1] : '';
  }
  const TILE_SEL = 'a[href*="/reel/"],a[href*="/reels/"],a[href*="/p/"],a[href*="/tv/"]';
  // A pinned tile carries IG's pin badge inside the anchor. Checked on the anchor
  // subtree ONLY — the parent can be a whole grid row, and marking all three of a
  // row as pinned would blind the stop rule.
  function isPinned(a) {
    try { return !!a.querySelector('svg[aria-label*="Pinned" i]'); } catch (_) { return false; }
  }
  // Collect every reel/post link currently in the DOM into `into` (Map id→url).
  // Done on EVERY scroll step because IG virtualizes the grid (old thumbs unmount).
  // Map insertion order = first-seen order = grid order, top to bottom, which is
  // what the trailing-run rule below depends on.
  function collect(into, pinned) {
    document.querySelectorAll(TILE_SEL).forEach(a => {
      const id = shortcode(a.href);
      if (!id) return;
      if (pinned && isPinned(a)) pinned.add(id);
      if (!into.has(id)) into.set(id, a.href.split('?')[0]);
    });
  }
  // How many tiles at the BOTTOM of what we've seen are already in ig.json.
  // Walk backwards, skipping pinned/top-3 tiles, and stop at the first unknown.
  function trailingKnownRun(order, known, pinned) {
    let run = 0;
    for (let k = order.length - 1; k >= 0; k--) {
      const id = order[k];
      if (k < PIN_SKIP || pinned.has(id)) continue;
      if (known.has(id)) run++;
      else break;
    }
    return run;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rnd = (a, b) => a + Math.random() * (b - a);

  // ── proxy plumbing (GM_xhr is privileged → bypasses browser CORS) ───────────
  // (dev0914) GM_xhr hands every transport failure to one `onerror` with nothing in
  // it, and this used to answer all of them with the same sentence: "proxy down (is
  // proxy.js running on 8081?)". That sentence is a lie in the case that matters —
  // a socket killed UNDER a live request, which is what a VPN switch does to every
  // connection in the browser, loopback included. The two are easy to tell apart by
  // the clock: nothing listening on a port refuses in milliseconds, while a request
  // that got as far as the wire and then lost it dies seconds in. Say which one
  // happened, and mark the second `dropped` so a caller can go and look at the real
  // outcome instead of taking the lost answer as a verdict.
  const DEAD_PORT_MS = 1500;
  function post(pathname, body) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const fail = (msg, dropped) => { const e = new Error(msg); e.dropped = !!dropped; reject(e); };
      GM_xmlhttpRequest({
        method: 'POST', url: PROXY + pathname,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(body || {}),
        timeout: 90000,
        onload: r => {
          let j = null; try { j = JSON.parse(r.responseText); } catch (_) {}
          if (j && j.ok) resolve(j);
          else reject(new Error((j && j.error) || ('HTTP ' + r.status)));
        },
        onerror: () => {
          const ms = Date.now() - t0;
          if (ms < DEAD_PORT_MS) fail('proxy did not answer (is proxy.js running on 8081?)');
          else fail('the connection was cut ' + (ms / 1000).toFixed(1) + 's in — the proxy may still be'
                    + ' working on it (a VPN switch drops every open socket)', true);
        },
        ontimeout: () => fail('proxy timeout')
      });
    });
  }

  // ── UI ─────────────────────────────────────────────────────────────────────
  let abortFlag = false;
  function setMsg(t) { const m = document.getElementById('slam-ig-msg'); if (m) { m.style.display = t ? 'block' : 'none'; m.textContent = t || ''; } }
  function setBusy(on) {
    ['slam-ig-harvest', 'slam-ig-new', 'slam-ig-sweep', 'slam-ig-resume'].forEach(id => {
      const b = document.getElementById(id); if (b) b.disabled = on;
    });
    const s = document.getElementById('slam-ig-stop'); if (s) s.style.display = on ? 'inline-block' : 'none';
  }
  function mkBtn(id, label, title, bg) {
    const b = document.createElement('button');
    b.id = id; b.textContent = label; b.title = title;
    b.style.cssText = 'padding:10px 14px;border-radius:8px;border:0;background:' + bg + ';' +
      'color:#fff;font:600 13px system-ui;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4)';
    return b;
  }
  function addButton() {
    if (document.getElementById('slam-ig-bar')) return;
    const wrap = document.createElement('div');
    wrap.id = 'slam-ig-bar';
    wrap.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;display:flex;' +
      'flex-direction:column;align-items:flex-end;gap:8px';
    const msg = document.createElement('div');
    msg.id = 'slam-ig-msg';
    msg.style.cssText = 'display:none;max-width:380px;padding:10px 12px;border-radius:8px;' +
      'background:#111c;color:#fff;font:500 12px/1.45 system-ui;white-space:pre-wrap;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.5);backdrop-filter:blur(4px)';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px';
    const h = mkBtn('slam-ig-harvest', '⬇ All', ALL_TITLE, '#0a84ff');
    h.onclick = () => {
      if (h.dataset.known && !confirm('@' + authorFromPath() + ' already has ' + h.dataset.known +
          ' rows in ig.json.\n\n"🆕 New only" is normally what you want here.\n\nRun the FULL bottom-of-profile walk anyway?')) return;
      run(() => harvestProfile(h, false));
    };
    const n = mkBtn('slam-ig-new', '🆕 New only', 'Collect just the posts you do not already have.'
      + '\n\nStarts at the top and stops as soon as it recognises ' + STOP_RUN + ' posts in a row it'
      + ' already holds — usually 2-4 scrolls, a few seconds.'
      + '\n\nThis is the everyday button: it is what to press to catch up with an author.', '#5e5ce6');
    n.onclick = () => run(() => harvestProfile(n, true));
    const s = mkBtn('slam-ig-sweep', '🔁 Sweep…', 'Catch up with ALL your authors in one go.'
      + '\n\nDoes the same job as 🆕 New only, on one author after another, without you'
      + ' watching. Opens a list first so you can tick who to include.'
      + '\n\nLeave it running — it waits half a minute or so between authors on purpose,'
      + ' so a full list takes a while.', '#ff9f0a');
    s.onclick = () => openSweepPanel();
    const r = mkBtn('slam-ig-resume', '▶ Resume…', 'Go back to reading where you left off.'
      + '\n\nPaste the link of a post and it finds that post on this profile and opens it'
      + ' for you — with the ◀ ▶ arrows working, so you can carry on through the author'
      + ' post by post. (Opening a link straight from the address bar gives you no arrows,'
      + ' and there is no other way to get them back.)'
      + '\n\nNothing is collected or saved — this one is purely for looking.', '#34c759');
    r.onclick = () => { r.disabled = true; resumeAt(r).catch(e => r.textContent = '⚠ ' + e.message)
      .finally(() => setTimeout(() => { r.disabled = false; }, 1500)); };
    const stop = mkBtn('slam-ig-stop', '■ Stop', 'Stop whatever is running now.'
      + '\n\nAnything already collected is kept. A sweep forgets its place, so the next'
      + ' one starts at the top of the list again — which is cheap, because authors that'
      + ' are already up to date are recognised and skipped in a few seconds each.', '#ff453a');
    stop.style.display = 'none';
    stop.onclick = () => { abortFlag = true; sweepStop('stopped by you'); setMsg('■ stopping…'); };
    // (dev0916) The version used to live ONLY in a title on the bar — which nobody can
    // reach, because the buttons cover the bar and each carries a tooltip of its own
    // that wins the hover. It is the one thing you want to know right after updating
    // ("did the new one actually load?"), so it belongs on screen: small, quiet, and
    // directly above the buttons where the eye already is.
    const ver = document.createElement('div');
    ver.id = 'slam-ig-ver';
    ver.textContent = 'SLAM harvester v' + VER;
    ver.title = 'Which version of the harvester this tab is running.'
      + '\n\nAfter updating in Tampermonkey, reload the page and check this number changed.';
    ver.style.cssText = 'padding:2px 8px;border-radius:6px;background:#111c;color:#cfd3da;' +
      'font:600 10px/1.5 system-ui;box-shadow:0 1px 4px rgba(0,0,0,.35);backdrop-filter:blur(3px)';
    row.appendChild(h); row.appendChild(n); row.appendChild(s); row.appendChild(r); row.appendChild(stop);
    wrap.appendChild(msg); wrap.appendChild(ver); wrap.appendChild(row);
    wrap.title = 'SLAM IG Harvester v' + VER;
    document.body.appendChild(wrap);
    refreshAuthorStatus(true);
  }
  // One-at-a-time guard around the manual buttons.
  let running = false;
  async function run(fn) {
    if (running) return;
    running = true; abortFlag = false; setBusy(true);
    try { await fn(); }
    catch (e) { setMsg('⚠ ' + (e && e.message ? e.message : e)); }
    finally { running = false; setBusy(false); }
  }

  // ── already-harvested status ───────────────────────────────────────────────
  let _statusAuthor = null;                     // author the current button state describes
  let _authorsCache = { at: 0, map: null };

  async function authorsMap() {
    if (_authorsCache.map && Date.now() - _authorsCache.at < STATUS_TTL) return _authorsCache.map;
    const j = await post('/ig/authors', {});
    const m = new Map();
    (j.authors || []).forEach(a => m.set(String(a.author || '').trim().toLowerCase(), a));
    _authorsCache = { at: Date.now(), map: m };
    return m;
  }

  // (dev0850) Grey follows `harvested` ONLY - never `rows`. /ig/authors counts a
  // 'w'-added single (staged:false) in `rows` but deliberately NOT in `harvested`,
  // so the old `harvested || rows` fallback greyed a profile that had never been
  // walked at all, purely because one post from it had been grabbed by hand. That
  // is exactly the author most worth a full harvest, and grey said "done". A
  // singles-only author now paints blue with an amber outline that says why it is known.
  function paintAll(hit) {
    const h = document.getElementById('slam-ig-harvest');
    if (!h) return;
    const done    = hit ? (hit.harvested || 0) : 0;      // rows a PROFILE walk staged
    const singles = hit ? Math.max(0, (hit.rows || 0) - done) : 0;   // 'w' hand-adds
    h.dataset.known = done ? String(done) : '';          // only a REAL harvest asks "are you sure"
    h.style.background = done ? '#3a3f4a' : '#0a84ff';
    h.style.color      = done ? '#9aa0aa' : '#fff';
    h.style.outline    = (!done && singles) ? '2px solid #ffd60a' : '';
    h.style.outlineOffset = '1px';
    h.title = done
      ? 'Already harvested — ' + done + ' rows in ig.json, last ' +
        ((hit.last || '').slice(0, 10) || '—') + '.\nUse 🆕 New only. Click anyway for a full deep re-check.'
      : singles
        ? 'NEVER profile-harvested — ig.json holds only ' + singles + ' hand-added single'
          + (singles === 1 ? '' : 's') + ' from this author.' + '\n' + ALL_TITLE
        : ALL_TITLE;
  }

  // Repaint when the PROFILE changes, not just when the bar is built: Instagram
  // is an SPA, the bar survives a navigation, and a stale grey would otherwise
  // follow you from a harvested author onto a brand-new one.
  async function refreshAuthorStatus(force) {
    const a = authorFromPath();
    if (!a) { _statusAuthor = null; return; }
    if (!force && _statusAuthor === a) return;
    _statusAuthor = a;
    paintAll(null);                                   // blue until the proxy says otherwise
    try {
      const m = await authorsMap();
      if (authorFromPath() !== a) return;             // navigated away mid-flight
      const hit = m.get(a);
      paintAll(hit || null);   // paintAll decides: harvested / singles-only / unknown
    } catch (_) { /* proxy down → leave it blue; never block a harvest over this */ }
  }

  // ── the harvest ────────────────────────────────────────────────────────────
  // Wait for the grid to actually render. A profile that comes back with no tiles
  // is a login wall / rate limit / private account — never something to scroll at.
  async function waitForTiles(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (document.querySelector(TILE_SEL)) return true;
      await sleep(400);
    }
    return false;
  }

  // A profile with no tiles is one of several very different things, and an
  // unattended sweep must not treat them alike: a handle that was deleted or
  // renamed since the last harvest is ONE author to skip, while a rate limit is a
  // reason to stop touching Instagram entirely. Read the page and say which.
  function classifyBlock() {
    const t = ((document.body && document.body.innerText) || '').slice(0, 4000);
    if (/wait a few minutes|try again later/i.test(t))
      return { kind: 'wall', msg: 'Instagram is rate-limiting ("please wait a few minutes")' };
    if (/isn'?t available|page not found|removed this content/i.test(t))
      return { kind: 'gone', msg: 'profile not available — deleted, renamed, or blocked' };
    if (/account is private/i.test(t))
      return { kind: 'private', msg: 'account is private' };
    if (/log in to instagram|sign up|create new account/i.test(t))
      return { kind: 'login', msg: 'logged out — Instagram is showing a login wall' };
    return { kind: 'empty', msg: 'no posts rendered' };
  }

  // newOnly=false → the original walk to the bottom (jump-scroll, fastest).
  // newOnly=true  → gentle scroll from the top, stopping at a run of known posts.
  // Returns { author, found, added, dup, stop } or throws.
  async function harvestProfile(btn, newOnly) {
    const author = authorFromPath();
    if (!author) throw new Error('not on a profile page');

    let known = new Set(), authorCount = 0;
    if (newOnly) {
      setMsg('… asking the proxy what ig.json already has');
      const j = await post('/ig/known', { author });
      known = new Set(j.ids || []);
      authorCount = j.authorCount || 0;
      // Nothing on record for this author = a FIRST harvest. There is no known run
      // to find, so gentle scrolling would just crawl the whole profile: fall back
      // to the full walk, which is what a first harvest wants anyway.
      if (!authorCount) {
        setMsg('@' + author + ' has no rows in ig.json yet — running a FULL harvest instead.');
        await sleep(1800);
        newOnly = false;
      }
    }

    if (!await waitForTiles(20000)) {
      const b = classifyBlock();
      const err = new Error('@' + author + ': ' + b.msg);
      err.kind = b.kind;      // the sweep skips 'gone'/'private'/'empty', stops on 'wall'/'login'
      throw err;
    }

    const found = new Map(), pinned = new Set();
    let iter = 0, stale = 0, lastCount = -1, lastH = -1, stop = 'bottom';
    const cap = newOnly ? NEW_MAX_ITER : MAX_ITER;

    if (newOnly) { window.scrollTo(0, 0); await sleep(700); }   // first-seen order must be grid order

    while (iter++ < cap && stale < STALE_STOP) {
      if (abortFlag) { stop = 'abort'; break; }
      collect(found, pinned);
      if (newOnly) {
        const runLen = trailingKnownRun([...found.keys()], known, pinned);
        if (iter >= MIN_STEPS && runLen >= STOP_RUN) { stop = 'known-run'; break; }
        window.scrollBy(0, Math.round(window.innerHeight * 0.85));   // gentle: never skip a row
      } else {
        window.scrollTo(0, document.documentElement.scrollHeight);
      }
      await sleep(rnd(700, 1500));                 // human-ish pacing
      // occasional small jiggle to re-trigger lazy-load if it stalled
      if (iter % 7 === 0) { window.scrollBy(0, -400); await sleep(rnd(200, 400)); }
      collect(found, pinned);
      const h = document.documentElement.scrollHeight;
      if (found.size === lastCount && h === lastH) stale++; else stale = 0;
      lastCount = found.size; lastH = h;
      const seen = newOnly ? (found.size + ' seen, ' + [...found.keys()].filter(id => !known.has(id)).length + ' new')
                           : (found.size + ' reels');
      setMsg((newOnly ? '🆕 ' : '⬇ ') + '@' + author + ' — ' + seen + ' · scroll ' + iter);
      if (btn) btn.textContent = newOnly ? ('🆕 ' + found.size) : ('⏳ ' + found.size);
    }
    collect(found, pinned);
    if (iter > cap) stop = 'cap';

    const urls = [...found.values()];
    if (!urls.length) throw new Error('no posts found on @' + author);
    setMsg('⬆ sending ' + urls.length + ' to ig.json…');
    const j = await post('/ig/add', { author, urls, source: location.href });
    // A first harvest just made this author "known" — drop the cache so the
    // button greys immediately instead of a minute from now.
    _authorsCache = { at: 0, map: null };
    setTimeout(() => refreshAuthorStatus(true), 0);
    const res = { author, found: urls.length, added: j.added || 0, dup: j.dup || 0, stop };
    const why = stop === 'known-run' ? 'stopped at ' + STOP_RUN + ' known in a row'
              : stop === 'abort' ? 'stopped by you'
              : stop === 'cap' ? '⚠ hit the scroll cap — run ⬇ All to be sure'
              : 'reached the bottom';
    setMsg((res.added ? '✓ +' + res.added + ' NEW' : '✓ nothing new') + ' from @' + author +
           '\n' + res.found + ' seen · ' + res.dup + ' already had · ' + why +
           '\nig.json now ' + (j.total || '?') + ' rows');
    if (btn) btn.textContent = btn.id === 'slam-ig-new' ? '🆕 New only' : '⬇ All';
    return res;
  }

  // ── sweep: every author, unattended ────────────────────────────────────────
  // State lives in localStorage because each author is a REAL page load (the only
  // reliable way to land on a profile with its grid freshly rendered), which tears
  // this script down and re-injects it.
  function sweepRead() {
    try {
      const s = JSON.parse(localStorage.getItem(SWEEP_KEY) || 'null');
      if (!s || !s.queue || !s.queue.length) return null;
      if (Date.now() - (s.startedAt || 0) > SWEEP_TTL) { localStorage.removeItem(SWEEP_KEY); return null; }
      return s;
    } catch (_) { return null; }
  }
  function sweepWrite(s) { try { localStorage.setItem(SWEEP_KEY, JSON.stringify(s)); } catch (_) {} }
  function sweepStop(why) {
    const s = sweepRead();
    localStorage.removeItem(SWEEP_KEY);
    abortFlag = true;
    if (s) setMsg('■ sweep stopped — ' + why + '\n' + sweepSummary(s));
  }
  function sweepSummary(s) {
    const done = s.done || [];
    const added = done.reduce((a, d) => a + (d.added || 0), 0);
    const hits = done.filter(d => d.added).map(d => '@' + d.author + ' +' + d.added);
    const failed = done.filter(d => d.error).map(d => '@' + d.author + ' ⚠');
    return done.length + '/' + s.queue.length + ' authors · +' + added + ' new post(s)'
      + (hits.length ? '\n' + hits.join(', ') : '')
      + (failed.length ? '\n' + failed.join(', ') : '');
  }

  async function vpnState() {
    try { return await post('/ig/vpn-status', {}); } catch (_) { return null; }
  }
  // (dev0914) Watch the TUNNEL for a rotation to land, for when the POST that asked
  // for it never came back. Landed = up, and on a different exit than `before`. The
  // first few polls can fail too — they are being made across the same adapter flip
  // that killed the switch — so a null is only fatal after DEAD_POLLS of them in a
  // row, which is well past the flip and means the proxy really is gone. Returns the
  // new state, or null if it never arrived (caller stops the sweep on that).
  const DEAD_POLLS = 8;
  async function vpnAwaitSwitch(before, budgetMs) {
    const until = Date.now() + (budgetMs || 60000);
    let dead = 0;
    while (Date.now() < until) {
      if (abortFlag) return null;
      setMsg('🔀 the switch request was cut off — watching the tunnel instead'
             + '\n⏳ ' + Math.ceil((until - Date.now()) / 1000) + 's');
      await sleep(2000);
      const st = await vpnState();
      if (!st) { if (++dead >= DEAD_POLLS) return null; continue; }
      dead = 0;
      if (st.tunnelUp && st.server && st.server !== before) return st;
    }
    return null;
  }
  // Pause with a live countdown that the Stop button can interrupt.
  async function pause(ms, label) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (abortFlag) return false;
      setMsg(label + '\n⏳ ' + Math.ceil((until - Date.now()) / 1000) + 's');
      await sleep(500);
    }
    return true;
  }

  async function openSweepPanel() {
    if (running || document.getElementById('slam-ig-panel')) return;
    let j;
    setMsg('… reading the author list from ig.json');
    try { j = await post('/ig/authors', {}); }
    catch (e) { setMsg('⚠ ' + e.message); return; }
    setMsg('');
    const authors = (j.authors || []).filter(a => a.author);
    const vs = await vpnState();
    const tunnelUp = !!(vs && vs.tunnelUp);

    const p = document.createElement('div');
    p.id = 'slam-ig-panel';
    p.style.cssText = 'position:fixed;right:16px;bottom:74px;z-index:100000;width:420px;max-height:70vh;' +
      'display:flex;flex-direction:column;background:#15171c;color:#eee;border:1px solid #333;' +
      'border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.6);font:13px/1.4 system-ui';
    const head = document.createElement('div');
    head.style.cssText = 'padding:12px 14px;border-bottom:1px solid #2a2d34;font-weight:700';
    head.textContent = '🔁 Sweep — new posts since last harvest';
    const sub = document.createElement('div');
    sub.style.cssText = 'padding:8px 14px;color:#9aa0aa;border-bottom:1px solid #2a2d34;font-size:12px';
    // (dev0917) Changing VPN exit between authors is now OFF unless you ask for it. It
    // used to switch itself on whenever a tunnel happened to be up, and it costs about
    // 40 seconds per author — 38 minutes across a 57-author list — to do the very thing
    // the no-tunnel line below says is worse: keep moving the IP of an account
    // Instagram associates with one stable home connection. It stays one tick away for
    // the case it was built for, an exit that has started refusing pages.
    let rotCb = null;
    if (tunnelUp) {
      const lab = document.createElement('label');
      lab.style.cssText = 'display:flex;gap:8px;align-items:flex-start;cursor:pointer';
      rotCb = document.createElement('input');
      rotCb.type = 'checkbox'; rotCb.checked = false; rotCb.style.cssText = 'margin-top:2px';
      const t = document.createElement('span');
      t.innerHTML = '🔒 VPN is up (' + (vs.server || vs.ip || '?') + '). Change to a different '
        + 'exit between each author — about <b>40 seconds slower per author</b>, and rarely '
        + 'worth it while you are logged in. Leave this unticked unless Instagram starts '
        + 'refusing to show you pages.';
      lab.appendChild(rotCb); lab.appendChild(t);
      sub.appendChild(lab);
    } else {
      sub.textContent = '🏠 No VPN tunnel — the sweep runs on your home connection, which is'
        + ' what a logged-in session works best on.';
    }
    const list = document.createElement('div');
    // The opaque background is NOT decoration. A scrollable div gets promoted to
    // its own compositing layer, and text drawn on a layer with no opaque backdrop
    // falls back from subpixel to greyscale antialiasing — which is why some author
    // names rendered thin and washed out while others looked normal. Painting the
    // panel colour onto this element too keeps every row on an opaque surface.
    list.style.cssText = 'overflow:auto;padding:6px 8px;flex:1;background:#15171c';
    authors.forEach(a => {
      const id = 'slam-sw-' + a.author.replace(/[^A-Za-z0-9_.]/g, '');
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:5px 6px;border-radius:6px;cursor:pointer';
      row.onmouseenter = () => row.style.background = '#20242c';
      row.onmouseleave = () => row.style.background = '';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.id = id; cb.dataset.author = a.author;
      // Pre-check only real harvested profiles. An author with only staged:false
      // rows is a one-off single someone grabbed from the clipboard — sweeping
      // their whole profile is exactly what the "Add single" button exists to avoid.
      cb.checked = (a.harvested || 0) > 0;
      const txt = document.createElement('span');
      txt.style.cssText = 'flex:1;display:flex;justify-content:space-between;gap:10px';
      // Colour stated on the name itself rather than inherited: this panel lives
      // inside Instagram's document, so nothing here relies on what IG's own CSS
      // does or doesn't do to an unstyled <span>.
      txt.innerHTML = '<span style="color:#f2f4f8;font-weight:600">@' + a.author +
        (a.harvested ? '' : ' <span style="color:#9ac06a;font-weight:400">(singles only)</span>') + '</span>' +
        '<span style="color:#8b919b;font-size:11px">' + (a.harvested || 0) + ' rows · ' + ((a.last || '').slice(0, 10) || '—') + '</span>';
      row.appendChild(cb); row.appendChild(txt);
      list.appendChild(row);
    });
    const foot = document.createElement('div');
    foot.style.cssText = 'padding:10px 14px;border-top:1px solid #2a2d34;display:flex;gap:8px;align-items:center';
    const est = document.createElement('span');
    est.style.cssText = 'flex:1;color:#9aa0aa;font-size:12px';
    const start = mkBtn('slam-sw-start', 'Start sweep', 'Begin — each author loads in this tab', '#0a84ff');
    const cancel = mkBtn('slam-sw-cancel', 'Cancel', 'Close', '#3a3f4a');
    foot.appendChild(est); foot.appendChild(cancel); foot.appendChild(start);
    p.appendChild(head); p.appendChild(sub); p.appendChild(list); p.appendChild(foot);
    document.body.appendChild(p);

    const picked = () => [...list.querySelectorAll('input[data-author]:checked')].map(c => c.dataset.author);
    const rotating = () => !!(rotCb && rotCb.checked);
    const perAuthor = () => rotating() ? 105 : 65;    // harvest + (rotate) + gap, seconds
    const refresh = () => {
      const n = picked().length;
      est.textContent = n + ' selected · ~' + Math.max(1, Math.round(n * perAuthor() / 60)) + ' min';
      start.disabled = !n;
    };
    list.addEventListener('change', refresh);
    if (rotCb) rotCb.addEventListener('change', refresh);
    refresh();
    cancel.onclick = () => p.remove();
    start.onclick = () => {
      const queue = picked();
      p.remove();
      sweepWrite({ v: 1, startedAt: Date.now(), rotate: rotating(), queue, i: 0, done: [] });
      abortFlag = false;
      // (dev0917) Start used to hand straight to resumeSweep() from whatever page you
      // opened the panel on. resumeSweep only acts on the profile the sweep points at,
      // so starting from Messages, a reel, or any author other than the first produced
      // an immediate "sweep paused — click ▶ to continue" before a single author had
      // been looked at. An unattended run must not open by asking for a click: go to
      // the first author ourselves, and the sweep picks itself up when that page loads.
      if (authorFromPath() === queue[0]) resumeSweep();
      else location.href = 'https://www.instagram.com/' + queue[0] + '/';
    };
  }

  // Drive the sweep from wherever we currently are. Called on every page load.
  async function resumeSweep() {
    let s = sweepRead();
    if (!s) return;
    if (s.i >= s.queue.length) { localStorage.removeItem(SWEEP_KEY); setMsg('✓ sweep finished\n' + sweepSummary(s)); return; }
    const want = s.queue[s.i];

    // We only ever act on the profile the sweep is pointed at. Landing anywhere
    // else (an IG redirect, or you browsing away) leaves the sweep PAUSED and
    // visible rather than yanking the tab out from under you.
    if (authorFromPath() !== want) {
      setBusy(false);
      // (dev0917) "Click ▶ below" named no button, and there are two of them down there
      // starting with ▶ — Resume…, which does something else entirely, and the orange
      // Continue sweep. Name the one you mean.
      setMsg('⏸ sweep paused at @' + want + ' (' + (s.i + 1) + '/' + s.queue.length + ')\n' +
             'Click the orange "▶ Continue sweep" to carry on, or "■ Stop" to end it.');
      showResumeControls(want);
      return;
    }

    running = true; setBusy(true);
    try {
      let res, fatal = null;
      try {
        res = await harvestProfile(null, true);
      } catch (e) {
        const kind = (e && e.kind) || 'error';
        res = { author: want, found: 0, added: 0, dup: 0, stop: kind, error: (e && e.message) || String(e) };
        // A rate limit or a login wall is SYSTEMIC — every remaining author would
        // hit the same thing, and grinding through 26 more only deepens it.
        // Everything else (deleted/renamed handle, gone private, a network blip)
        // is about this one author: skip it and carry on.
        if (kind === 'wall' || kind === 'login') fatal = res.error;
      }
      if (abortFlag) { sweepStop('stopped by you'); return; }
      s = sweepRead(); if (!s) return;                 // Stop pressed mid-harvest
      s.fails = res.error ? (s.fails || 0) + 1 : 0;
      s.done.push(res); s.i++; sweepWrite(s);
      if (fatal) { sweepStop(fatal); return; }
      // Three misses in a row is systemic after all, whatever each one claimed.
      if (s.fails >= 3) { sweepStop('3 authors in a row failed — last was ' + res.error); return; }

      if (s.i >= s.queue.length) { localStorage.removeItem(SWEEP_KEY); setMsg('✓ sweep finished\n' + sweepSummary(s)); return; }
      const next = s.queue[s.i];

      if (s.rotate) {
        const st = await vpnState();
        // Standing rule: a dropped tunnel STOPS IG activity. Nothing here restarts it.
        if (!st || !st.tunnelUp) { sweepStop('VPN tunnel is down — nothing was auto-restarted'); return; }
        const before = st.server || '';
        setMsg('🔀 rotating VPN before @' + next + ' (' + (s.i + 1) + '/' + s.queue.length + ')…');
        let sw = null, cut = '';
        try { sw = await post('/ig/vpn-switch', {}); } catch (e) { cut = e.message; }
        // (dev0914) The switch is the thing that kills the request asking for it: ~10s
        // in, the WireGuard adapter flips and the browser tears down every open socket,
        // this loopback POST included. On 2026-09-04 that ended two sweeps at author 1
        // of 57 — both reported as "proxy down" — while the proxy log shows BOTH
        // rotations landing seconds later (wg-US-CA-31, then wg-US-NC-6). So a lost
        // answer is a question, not a verdict: watch the tunnel, and stop only if the
        // rotation genuinely never arrives.
        let landed = null;
        if (cut) {
          landed = await vpnAwaitSwitch(before, 60000);
          if (abortFlag) { sweepStop('stopped by you'); return; }
          if (!landed) { sweepStop('VPN switch failed: ' + cut); return; }
          sw = { switched: true };
        }
        // Reuse what the watcher already proved. Re-asking would only add one more
        // chance for a transient null to end a sweep that is in fact fine.
        const st2 = landed || await vpnState();
        if (!st2 || !st2.tunnelUp) { sweepStop('VPN did not come back up after the switch'); return; }
        // switched:false = the rotation didn't land inside the proxy's 40s window.
        // The tunnel is still up, so carry on rather than abandon the sweep — but
        // say so, because it means this author reuses the previous exit.
        setMsg((sw && sw.switched ? '🔒 exit now ' : '⚠ rotation timed out — still on ') + (st2.server || st2.ip || '?'));
      }
      if (!await pause(rnd(GAP_MIN, GAP_MAX), 'next: @' + next + ' (' + (s.i + 1) + '/' + s.queue.length + ')\n' + sweepSummary(s))) {
        sweepStop('stopped by you'); return;
      }
      location.href = 'https://www.instagram.com/' + next + '/';
    } finally {
      running = false;
      if (!sweepRead()) setBusy(false);
    }
  }
  function showResumeControls(want) {
    if (document.getElementById('slam-ig-cont')) return;
    const row = document.getElementById('slam-ig-bar');
    if (!row) return;
    const b = mkBtn('slam-ig-cont', '▶ Continue sweep', 'Go to @' + want + ' and carry on', '#ff9f0a');
    b.onclick = () => { b.remove(); location.href = 'https://www.instagram.com/' + want + '/'; };
    const stop = document.getElementById('slam-ig-stop');
    if (stop) stop.style.display = 'inline-block';
    row.querySelector('div:last-child').insertBefore(b, stop || null);
  }

  // ── ▶ Resume: scroll-hunt to a post and CLICK its grid thumbnail ─────────────
  // Getting the ◀▶ arrows back is impossible from the address bar — they're SPA
  // state IG attaches only when you open a post by clicking it in the profile grid
  // (it then loads the surrounding post list = the arrows). So we replicate exactly
  // that: scroll the virtualized grid until the target shortcode's <a> mounts, then
  // dispatch a real bubbling click on it → IG opens the grid modal WITH arrows.
  function parseTarget(s) {
    s = (s || '').trim();
    const sc = shortcode(s);                       // full IG URL → shortcode
    if (sc) return sc;
    return /^[A-Za-z0-9_-]{5,}$/.test(s) ? s : ''; // bare shortcode pasted
  }
  function findThumb(target) {
    const as = document.querySelectorAll(TILE_SEL);
    for (const a of as) if (shortcode(a.href) === target) return a;
    return null;
  }
  // Dispatch one event, NEVER passing `view` — in the Tampermonkey sandbox `window`
  // is a wrapped proxy, not a real Window, so `view:window` makes the constructor
  // throw "'view' member of UIEventInit does not implement interface Window".
  // try/catch falls back to a plain Event if any constructor is unhappy.
  function fire(el, type, Ctor, extra) {
    let ev;
    try { ev = new Ctor(type, Object.assign({ bubbles: true, cancelable: true, composed: true }, extra)); }
    catch (_) { ev = new Event(type, { bubbles: true, cancelable: true }); }
    el.dispatchEvent(ev);
  }
  function clickThumb(a) {
    // Replicate a real click as a full pointer+mouse sequence on the thumbnail so
    // IG's React handler runs → it preventDefaults the <a> and opens the SPA grid
    // modal WITH arrows (a bare location change / href-follow would NOT).
    const t = a.querySelector('img') || a;
    const PE = window.PointerEvent;
    fire(t, 'pointerover', PE || MouseEvent);
    fire(t, 'mouseover', MouseEvent);
    if (PE) fire(t, 'pointerdown', PE, { button: 0, isPrimary: true });
    fire(t, 'mousedown', MouseEvent, { button: 0 });
    if (PE) fire(t, 'pointerup', PE, { button: 0, isPrimary: true });
    fire(t, 'mouseup', MouseEvent, { button: 0 });
    fire(t, 'click', MouseEvent, { button: 0 });
  }
  async function findAndClick(target, btn) {
    const ITER = 800, STOP = 8;
    let iter = 0, stale = 0, lastH = -1;
    window.scrollTo(0, 0);                          // start from the newest post
    await sleep(400);
    while (iter++ < ITER && stale < STOP) {
      const a = findThumb(target);                  // check BEFORE scrolling past it
      if (a) {
        a.scrollIntoView({ block: 'center' });
        await sleep(300);
        clickThumb(a);
        btn.textContent = '✓ opened ' + target + ' — arrow away ◀▶';
        return true;
      }
      window.scrollBy(0, Math.round(window.innerHeight * 0.85));
      await sleep(rnd(500, 1100));                  // human-ish pacing
      const h = document.documentElement.scrollHeight;
      const atBottom = (window.innerHeight + window.scrollY) >= h - 60;
      if (atBottom && h === lastH) stale++; else stale = 0;
      lastH = h;
      btn.textContent = '⏳ seeking ' + target + '… (' + iter + ')';
    }
    btn.textContent = '⚠ not found: ' + target;
    return false;
  }
  async function resumeAt(btn) {
    let def = '';
    try { def = (await navigator.clipboard.readText()) || ''; } catch (_) {}  // prefill from clipboard if it's an IG link
    if (!parseTarget(def)) def = '';
    const input = prompt('Resume at which post?\nPaste the Instagram URL or shortcode where you want to continue arrowing:', def.trim());
    if (input == null) return;
    const target = parseTarget(input);
    if (!target) { btn.textContent = '⚠ no shortcode in that input'; return; }
    await findAndClick(target, btn);
    btn.textContent = '▶ Resume…';
  }

  // Show the bar on profile pages — and ALSO wherever a sweep is live, so a sweep
  // that got redirected somewhere unexpected (a login wall, /accounts/…) still has
  // its ▶ Continue and ■ Stop within reach instead of silently sitting paused.
  setInterval(() => {
    const sw = sweepRead();
    if (onProfile() || sw) {
      addButton();
      refreshAuthorStatus(false);
      if (sw && !running && authorFromPath() !== sw.queue[sw.i]) showResumeControls(sw.queue[sw.i]);
    } else { _statusAuthor = null; const bar = document.getElementById('slam-ig-bar'); if (bar) bar.remove(); }
  }, 1500);

  // A sweep in progress owns this tab: pick it up as soon as the page settles.
  if (sweepRead()) setTimeout(() => { addButton(); resumeSweep(); }, 2500);
})();
