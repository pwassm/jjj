// ==UserScript==
// @name         SLAM IG Reel Harvester
// @namespace    sealifeandmore
// @version      1.0
// @description  Auto-scroll an Instagram profile, harvest reel/post URLs (deduped by shortcode), and POST them to the local SLAM proxy → ig.json. Reads only the rendered page from your normal logged-in session — no API/cookie replay IG could flag. Install: Tampermonkey → create new script → paste. Or open http://localhost:8080/ig-harvest.user.js to install.
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

  function addButton() {
    if (document.getElementById('slam-ig-harvest')) return;
    const b = document.createElement('button');
    b.id = 'slam-ig-harvest';
    b.textContent = '⬇ Harvest reels';
    b.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;padding:10px 14px;' +
      'border-radius:8px;border:0;background:#0a84ff;color:#fff;font:600 13px system-ui;' +
      'cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4)';
    b.title = 'Auto-scroll this profile and stage reel URLs to ig.json';
    b.onclick = () => { b.disabled = true; harvest(b).catch(e => b.textContent = '⚠ ' + e.message)
      .finally(() => setTimeout(() => { b.disabled = false; }, 1200)); };
    document.body.appendChild(b);
  }

  // Show the button only on profile pages; re-check on IG's SPA navigation.
  setInterval(() => {
    if (onProfile()) addButton();
    else { const b = document.getElementById('slam-ig-harvest'); if (b) b.remove(); }
  }, 1500);
})();
