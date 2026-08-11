// ==UserScript==
// @name         SLAM IG Reel Harvester
// @namespace    sealifeandmore
// @version      2.0
// @downloadURL  http://localhost:8080/ig-harvest.user.js
// @updateURL    http://localhost:8080/ig-harvest.user.js
// @description  Harvest an Instagram profile's reel/post URLs into ig.json via the local SLAM proxy. "🆕 New only" asks the proxy which shortcodes ig.json already holds and stops scrolling as soon as it recognises the grid — a re-harvest costs ~3 scroll steps instead of 500. "🔁 Sweep all" runs that across every harvested author unattended, rotating the Proton VPN between authors the way Download+rotate does. Also "▶ Resume…": scroll-hunt to a post by URL/shortcode and click its grid thumbnail → reopens the post in IG's grid modal WITH the ◀▶ arrows (the only way to get them back — they're SPA state from clicking the grid, not the URL). Reads only the rendered page from your normal logged-in session — no API/cookie replay IG could flag. Install: Tampermonkey → create new script → paste. Or open http://localhost:8080/ig-harvest.user.js to install/update.
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
  const VER = '2.0';
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
  function post(pathname, body) {
    return new Promise((resolve, reject) => {
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
        onerror: () => reject(new Error('proxy down (is proxy.js running on 8081?)')),
        ontimeout: () => reject(new Error('proxy timeout'))
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
    const h = mkBtn('slam-ig-harvest', '⬇ All', 'FULL harvest: scroll this profile to the very bottom and stage every reel URL to ig.json. Use for a first-time author or a periodic deep re-check.', '#0a84ff');
    h.onclick = () => run(() => harvestProfile(h, false));
    const n = mkBtn('slam-ig-new', '🆕 New only', 'Harvest just what is NEW: asks the proxy which shortcodes ig.json already holds and stops as soon as ' + STOP_RUN + ' known posts in a row appear. Normally 2-4 scroll steps.', '#5e5ce6');
    n.onclick = () => run(() => harvestProfile(n, true));
    const s = mkBtn('slam-ig-sweep', '🔁 Sweep…', 'Run "New only" across every harvested author unattended, rotating the Proton VPN between authors (when a tunnel is up). Pick the authors in the panel.', '#ff9f0a');
    s.onclick = () => openSweepPanel();
    const r = mkBtn('slam-ig-resume', '▶ Resume…', 'Scroll to a post by URL/shortcode and click it → reopens the grid modal WITH the ◀▶ arrows', '#34c759');
    r.onclick = () => { r.disabled = true; resumeAt(r).catch(e => r.textContent = '⚠ ' + e.message)
      .finally(() => setTimeout(() => { r.disabled = false; }, 1500)); };
    const stop = mkBtn('slam-ig-stop', '■ Stop', 'Stop the current harvest/sweep', '#ff453a');
    stop.style.display = 'none';
    stop.onclick = () => { abortFlag = true; sweepStop('stopped by you'); setMsg('■ stopping…'); };
    row.appendChild(h); row.appendChild(n); row.appendChild(s); row.appendChild(r); row.appendChild(stop);
    wrap.appendChild(msg); wrap.appendChild(row);
    wrap.title = 'SLAM IG Harvester v' + VER;
    document.body.appendChild(wrap);
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

    if (!await waitForTiles(20000)) throw new Error('no posts rendered on @' + author + ' — login wall, rate limit, or a private/empty profile');

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
    sub.innerHTML = tunnelUp
      ? '🔒 VPN up (' + ((vs.server || vs.ip || '?') + '') + ') — the sweep will rotate to a fresh exit between authors, and will STOP if the tunnel drops.'
      : '🏠 No VPN tunnel — the sweep runs on your home IP and does not rotate. (Best for a logged-in session: IG trusts a stable residential IP more than a rotating datacenter one.)';
    const list = document.createElement('div');
    list.style.cssText = 'overflow:auto;padding:6px 8px;flex:1';
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
      txt.innerHTML = '<span>@' + a.author + (a.harvested ? '' : ' <span style="color:#8a6">(singles only)</span>') + '</span>' +
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

    const picked = () => [...list.querySelectorAll('input:checked')].map(c => c.dataset.author);
    const perAuthor = tunnelUp ? 105 : 65;    // harvest + (rotate) + gap, seconds
    const refresh = () => {
      const n = picked().length;
      est.textContent = n + ' selected · ~' + Math.max(1, Math.round(n * perAuthor / 60)) + ' min';
      start.disabled = !n;
    };
    list.addEventListener('change', refresh); refresh();
    cancel.onclick = () => p.remove();
    start.onclick = () => {
      const queue = picked();
      p.remove();
      sweepWrite({ v: 1, startedAt: Date.now(), rotate: tunnelUp, queue, i: 0, done: [] });
      abortFlag = false;
      resumeSweep();
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
      setMsg('⏸ sweep paused at @' + want + ' (' + (s.i + 1) + '/' + s.queue.length + ')\n' +
             'Click ▶ below to continue, or ■ Stop to end it.');
      showResumeControls(want);
      return;
    }

    running = true; setBusy(true);
    try {
      let res;
      try {
        res = await harvestProfile(null, true);
      } catch (e) {
        res = { author: want, found: 0, added: 0, dup: 0, stop: 'error', error: (e && e.message) || String(e) };
        // A profile that renders nothing is the signature of a wall — pressing on
        // through 20 more authors would only deepen it.
        if (/no posts|login wall|rate limit/i.test(res.error)) {
          s.done.push(res); s.i++; sweepWrite(s);
          sweepStop('@' + want + ': ' + res.error);
          return;
        }
      }
      if (abortFlag) { sweepStop('stopped by you'); return; }
      s = sweepRead(); if (!s) return;                 // Stop pressed mid-harvest
      s.done.push(res); s.i++; sweepWrite(s);

      if (s.i >= s.queue.length) { localStorage.removeItem(SWEEP_KEY); setMsg('✓ sweep finished\n' + sweepSummary(s)); return; }
      const next = s.queue[s.i];

      if (s.rotate) {
        const st = await vpnState();
        // Standing rule: a dropped tunnel STOPS IG activity. Nothing here restarts it.
        if (!st || !st.tunnelUp) { sweepStop('VPN tunnel is down — nothing was auto-restarted'); return; }
        setMsg('🔀 rotating VPN before @' + next + ' (' + (s.i + 1) + '/' + s.queue.length + ')…');
        let sw;
        try { sw = await post('/ig/vpn-switch', {}); } catch (e) { sweepStop('VPN switch failed: ' + e.message); return; }
        const st2 = await vpnState();
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
      if (sw && !running && authorFromPath() !== sw.queue[sw.i]) showResumeControls(sw.queue[sw.i]);
    } else { const bar = document.getElementById('slam-ig-bar'); if (bar) bar.remove(); }
  }, 1500);

  // A sweep in progress owns this tab: pick it up as soon as the page settles.
  if (sweepRead()) setTimeout(() => { addButton(); resumeSweep(); }, 2500);
})();
