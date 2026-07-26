// igEmbedProbeCore.js — (dev0675) the ONE definition of the official-embed verdict.
//
//   1 → instagram.com's public embed page for the post carries a playable video
//       (an <iframe src=".../embed/captioned/"> on a public site will single-play it)
//   0 → the embed page is served WITHOUT video (photo post, or the account/post
//       disallows embed playback → the iframe shows poster + "Watch on Instagram")
//   null → no verdict (rate-wall / timeout / dataless shell). Callers must leave the
//       row's `embed` field ABSENT so a later pass can resume it — never write a 0.
//
// Extracted verbatim from igEmbedProbe.js (dev0665) so BOTH callers share it:
//   • igEmbedProbe.js  — the overnight backfill grind over unstamped ig.json rows
//   • proxy.js /ig/download — stamps the verdict at download time (dev0675), so a
//     freshly downloaded row already knows whether a public iframe can play it.
// Keep the classification here and nowhere else: a copy in proxy.js would silently
// drift from the script and the 14,943 rows already stamped by it.
//
// Fetch strategy (unchanged): lightweight embed HTML via the SHORT UA (a full Chrome
// UA makes IG serve the React app shell), fresh socket per request, and a curl_cffi
// TLS-impersonated retry (ig_impersonate_fetch.py) when the Node fetch comes back
// walled/thin — Node's own TLS fingerprint is what IG flags on a VPN exit. Cookieless
// throughout; the IG login is never used.

'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const DIR = __dirname;
const SHORT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';   // do NOT modernize (dev0460)

const DEFAULTS = {
  python: process.env.IG_PYTHON || 'python',
  impersonatePy: path.join(DIR, 'ig_impersonate_fetch.py'),
  scratch: DIR,             // tmp files for the curl_cffi retry land here
  cffi: true,               // allow the impersonated retry when Node comes back walled
  nodeTimeoutMs: 15000,
  cffiTimeoutMs: 40000,
  track: null,              // Set-like (proxy's ACTIVE_DL) so the VPN kill-switch can SIGKILL
  saveHtmlTo: null,         // dir → dump the fetched HTML (calibration only)
  log: null
};

let impersonateOk = null;   // null=untried  false=curl_cffi missing (stop spawning)

function fetchNode(url, o) {
  return new Promise(resolve => {
    const opts = { agent: false, headers: {
      'User-Agent': SHORT_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': url.replace(/embed\/captioned\/?$/, ''),
      'Connection': 'close'
    } };
    let h = '';
    const req = https.get(url, opts, r => {
      if (r.statusCode !== 200) { r.resume(); resolve({ status: r.statusCode, html: '' }); return; }
      r.setEncoding('utf8');
      r.on('data', c => { h += c; if (h.length > 4e6) req.destroy(); });
      r.on('end', () => resolve({ status: 200, html: h }));
    });
    req.on('error', () => resolve({ status: 0, html: '' }));
    req.setTimeout(o.nodeTimeoutMs, () => { req.destroy(); resolve({ status: -1, html: '' }); });
  });
}

function fetchImpersonated(url, o) {
  return new Promise(resolve => {
    if (impersonateOk === false) { resolve({ status: 0, html: '' }); return; }
    const tmp = path.join(o.scratch, '.probe_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
    let proc;
    try {
      proc = spawn(o.python, [o.impersonatePy, url, tmp,
        url.replace(/embed\/captioned\/?$/, ''),
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', SHORT_UA],
        { windowsHide: true });
    } catch (_) { resolve({ status: 0, html: '' }); return; }
    if (o.track) o.track.add(proc);
    let out = '', done = false;
    const finish = res => {
      if (done) return; done = true; clearTimeout(killT);
      if (o.track) o.track.delete(proc);
      let html = '';
      try { html = fs.readFileSync(tmp, 'utf8'); } catch (_) {}
      try { fs.unlinkSync(tmp); } catch (_) {}
      resolve({ status: res, html });
    };
    const killT = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} finish(-1); }, o.cffiTimeoutMs);
    proc.stdout.on('data', d => { out += d.toString('utf8'); });
    proc.on('error', () => finish(0));
    proc.on('close', () => {
      const s = out.trim();
      if (/^ERR curl_cffi import/i.test(s)) { impersonateOk = false; if (o.log) o.log('⚠ curl_cffi missing — node-only from here'); }
      else if (/^\d+$/.test(s)) impersonateOk = true;
      finish(/^\d+$/.test(s) ? +s : 0);
    });
  });
}

// ── classification ────────────────────────────────────────────────────────────
function markers(html) {
  const h = html || '';
  return {
    len: h.length,
    vurl: /video_url\\?["']\s*:\s*\\?["']http/i.test(h),   // plain or \"-escaped JSON
    vtag: /<video[\s>]/i.test(h),
    isv: /is_video\\?["']\s*:\s*true/i.test(h),
    cap: /class="Caption"/.test(h),
    emi: /EmbeddedMediaImage/i.test(h),
    scm: /shortcode_media/.test(h),
    woi: /WatchOnInstagram/i.test(h),
    dres: /display_resources/.test(h),
    login: /accounts\/login/.test(h),
    shell: /PolarisEmbedSimple/.test(h) && /contextJSON\\?["']\s*:\s*null/.test(h)
  };
}
// verdict: 1 = playable video in embed · 0 = embed page valid but video-less
// kind:   ok   → stamped 1/0
//         dead → 404/410, post gone → stamped 0 (nothing to embed)
//         shell→ dataless React shell (per-post, IP is fine) → skip, no breaker
//         wall → anything else (timeout/429/403/302/thin) → breaker counts
function verdict(m, status) {
  if (status === 404 || status === 410) return { v: 0, kind: 'dead' };
  if (status !== 200 || m.len < 2000) return { v: null, kind: 'wall' };
  if (m.vurl || m.vtag) return { v: 1, kind: 'ok' };
  if (m.cap || m.emi || m.scm || m.isv || m.woi || m.dres) return { v: 0, kind: 'ok' };
  if (m.shell) return { v: null, kind: 'shell' };
  return { v: null, kind: 'wall' };
}

// Probe ONE shortcode. Resolves { id, status, via, m, v, kind } — never rejects.
// The /p/ embed URL is correct for reels too (IG serves the same embed page).
async function probeEmbed(id, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const url = 'https://www.instagram.com/p/' + id + '/embed/captioned/';
  let r = await fetchNode(url, o);
  let m = markers(r.html), via = 'node';
  let d = verdict(m, r.status);
  if (d.kind === 'wall' && o.cffi) {       // walled/thin → impersonated retry
    const r2 = await fetchImpersonated(url, o);
    const m2 = markers(r2.html);
    const d2 = verdict(m2, r2.status);
    if (d2.kind !== 'wall' || (r2.html && r2.html.length > (r.html || '').length)) { r = r2; m = m2; d = d2; via = 'cffi'; }
  }
  if (o.saveHtmlTo) {
    try { fs.writeFileSync(path.join(o.saveHtmlTo, 'calib_' + id + '_' + via + '.html'), r.html || ''); } catch (_) {}
  }
  return { id, status: r.status, via, m, v: d.v, kind: d.kind };
}

module.exports = { probeEmbed, markers, verdict, SHORT_UA };
