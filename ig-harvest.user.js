// ==UserScript==
// @name         SLAM IG Reel Harvester
// @namespace    sealifeandmore
// @version      1.1
// @description  Auto-scroll an Instagram profile, harvest reel/post URLs (deduped by shortcode), and POST them to the local SLAM proxy → ig.json. Also "▶ Resume…": scroll-hunt to a post by URL/shortcode and click its grid thumbnail → reopens the post in IG's grid modal WITH the ◀▶ arrows (the only way to get them back — they're SPA state from clicking the grid, not the URL). Reads only the rendered page from your normal logged-in session — no API/cookie replay IG could flag. Install: Tampermonkey → create new script → paste. Or open http://localhost:8080/ig-harvest.user.js to install/update.
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
  const PROXY = 'http://127.0.0.1:8081/ig/add';
  // First path segment that is NOT one of these = an author profile.
  const RESERVED = new Set(['explore', 'reels', 'reel', 'p', 'tv', 'stories', 'direct',
    'accounts', 'about', 'legal', 'web', 'popular', 'your_activity', 'lite', 'directory', '']);

  function authorFromPath() {
    const seg = (location.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
    return RESERVED.has(seg) ? '' : seg;
  }
  const onProfile = () => !!authorFromPath();

  function shortcode(href) {
    const m = href.match(/instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/i);
    return m ? m[1] : '';
  }
  // Collect every reel/post link currently in the DOM into `into` (Map id→url).
  // Done on EVERY scroll step because IG virtualizes the grid (old thumbs unmount).
  function collect(into) {
    document.querySelectorAll('a[href*="/reel/"],a[href*="/reels/"],a[href*="/p/"],a[href*="/tv/"]').forEach(a => {
      const id = shortcode(a.href);
      if (id && !into.has(id)) into.set(id, a.href.split('?')[0]);
    });
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rnd = (a, b) => a + Math.random() * (b - a);

  async function harvest(btn) {
    const author = authorFromPath();
    const found = new Map();
    let stale = 0, iter = 0, lastCount = -1, lastH = -1;
    const MAX_ITER = 500, STALE_STOP = 6;
    while (iter++ < MAX_ITER && stale < STALE_STOP) {
      collect(found);
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(rnd(700, 1500));                 // human-ish pacing
      // occasional small jiggle to re-trigger lazy-load if it stalled
      if (iter % 7 === 0) { window.scrollBy(0, -400); await sleep(rnd(200, 400)); }
      collect(found);
      const h = document.documentElement.scrollHeight;
      if (found.size === lastCount && h === lastH) stale++; else stale = 0;
      lastCount = found.size; lastH = h;
      btn.textContent = '⏳ ' + found.size + ' reels… (scroll ' + iter + ')';
    }
    collect(found);
    const urls = [...found.values()];
    if (!urls.length) { btn.textContent = '⚠ none found'; return; }
    btn.textContent = '⬆ sending ' + urls.length + '…';
    send(author, urls, btn);
  }

  function send(author, urls, btn) {
    GM_xmlhttpRequest({
      method: 'POST', url: PROXY,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ author, urls, source: location.href }),
      timeout: 15000,
      onload: r => {
        let j = {}; try { j = JSON.parse(r.responseText); } catch (_) {}
        if (j && j.ok) btn.textContent = '✓ +' + j.added + ' new (' + j.dup + ' dup) · ig.json ' + j.total;
        else clip(urls, btn, 'proxy error');
      },
      onerror: () => clip(urls, btn, 'proxy down'),
      ontimeout: () => clip(urls, btn, 'timeout')
    });
  }
  function clip(urls, btn, why) {
    try { GM_setClipboard(urls.join('\n')); } catch (_) {}
    btn.textContent = '📋 ' + urls.length + ' copied (' + why + ')';
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
    const as = document.querySelectorAll('a[href*="/reel/"],a[href*="/reels/"],a[href*="/p/"],a[href*="/tv/"]');
    for (const a of as) if (shortcode(a.href) === target) return a;
    return null;
  }
  function clickThumb(a) {
    // A real bubbling MouseEvent on the thumbnail drives IG's delegated click
    // handler → SPA modal with arrows (a plain location change would NOT).
    const t = a.querySelector('img') || a;
    ['mousedown', 'mouseup', 'click'].forEach(type =>
      t.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })));
  }
  async function findAndClick(target, btn) {
    const MAX_ITER = 800, STALE_STOP = 8;
    let iter = 0, stale = 0, lastH = -1;
    window.scrollTo(0, 0);                          // start from the newest post
    await sleep(400);
    while (iter++ < MAX_ITER && stale < STALE_STOP) {
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
    const bar = document.createElement('div');
    bar.id = 'slam-ig-bar';
    bar.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;display:flex;gap:8px';
    const h = mkBtn('slam-ig-harvest', '⬇ Harvest reels', 'Auto-scroll this profile and stage reel URLs to ig.json', '#0a84ff');
    h.onclick = () => { h.disabled = true; harvest(h).catch(e => h.textContent = '⚠ ' + e.message)
      .finally(() => setTimeout(() => { h.disabled = false; }, 1200)); };
    const r = mkBtn('slam-ig-resume', '▶ Resume…', 'Scroll to a post by URL/shortcode and click it → reopens the grid modal WITH the ◀▶ arrows', '#34c759');
    r.onclick = () => { r.disabled = true; resumeAt(r).catch(e => r.textContent = '⚠ ' + e.message)
      .finally(() => setTimeout(() => { r.disabled = false; }, 1500)); };
    bar.appendChild(h); bar.appendChild(r);
    document.body.appendChild(bar);
  }

  // Show the bar only on profile pages; re-check on IG's SPA navigation.
  setInterval(() => {
    if (onProfile()) addButton();
    else { const bar = document.getElementById('slam-ig-bar'); if (bar) bar.remove(); }
  }, 1500);
})();
