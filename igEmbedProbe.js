#!/usr/bin/env node
// igEmbedProbe.js — stamp every ig.json row with `embed: 1|0`:
//   1 → instagram.com's public embed page for the post carries a playable video
//       (an <iframe src=".../embed/captioned/"> on a public site will single-play it)
//   0 → the embed page is served WITHOUT video (photo post, or the account/post
//       disallows embed playback → the iframe shows poster + "Watch on Instagram")
// Rows the probe can't answer (rate-wall, timeout) are left WITHOUT the field, so
// re-running the script resumes exactly where it left off.
//
// Usage:
//   node igEmbedProbe.js --calib <id1,id2,...>   probe ids, print markers, save HTML
//                                                to the scratch dir — NO ig.json writes
//   node igEmbedProbe.js --limit 30              probe the first 30 unstamped rows
//   node igEmbedProbe.js                         full run (checkpoints every 100 rows)
//
// Fetch strategy mirrors proxy.js: lightweight embed HTML via the SHORT UA (a full
// Chrome UA makes IG serve the React app shell), fresh socket per request, and a
// curl_cffi TLS-impersonated retry (ig_impersonate_fetch.py) when the Node fetch
// comes back walled/thin — same cookieless posture as enrich, IG login never used.
// Pacing ~1.5s/row + backoff on consecutive walls, so a full 15k pass is an
// overnight grind by design. DO NOT open the I screen (localhost:8080) while this
// runs: its /ig/save persists whole rows and would clobber fields written here.

'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const DIR = __dirname;
const IG_STORE = path.join(DIR, 'ig.json');
const IG_PYTHON = process.env.IG_PYTHON || 'python';
const IG_IMPERSONATE_PY = path.join(DIR, 'ig_impersonate_fetch.py');
const SCRATCH = process.env.PROBE_SCRATCH || DIR;   // calib HTML + tmp files land here
const SHORT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';   // do NOT modernize (dev0460)
const LOG = path.join(SCRATCH, 'igEmbedProbe.log');

const argv = process.argv.slice(2);
function argVal(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }
const CALIB = argVal('--calib');
const LIMIT = +(argVal('--limit') || 0);

function log(msg) {
  const line = new Date().toISOString().slice(11, 19) + ' ' + msg;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {}
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── fetchers (ported from proxy.js fetchIgEmbedMeta / igImpersonatedHtml) ──────
function fetchNode(url) {
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
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: -1, html: '' }); });
  });
}

let impersonateOk = null;   // null=untried  false=curl_cffi missing (stop spawning)
function fetchImpersonated(url) {
  return new Promise(resolve => {
    if (impersonateOk === false) { resolve({ status: 0, html: '' }); return; }
    const tmp = path.join(SCRATCH, '.probe_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
    let proc;
    try {
      proc = spawn(IG_PYTHON, [IG_IMPERSONATE_PY, url, tmp,
        url.replace(/embed\/captioned\/?$/, ''),
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', SHORT_UA],
        { windowsHide: true });
    } catch (_) { resolve({ status: 0, html: '' }); return; }
    let out = '', done = false;
    const finish = res => {
      if (done) return; done = true; clearTimeout(killT);
      let html = '';
      try { html = fs.readFileSync(tmp, 'utf8'); } catch (_) {}
      try { fs.unlinkSync(tmp); } catch (_) {}
      resolve({ status: res, html });
    };
    const killT = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} finish(-1); }, 40000);
    proc.stdout.on('data', d => { out += d.toString('utf8'); });
    proc.on('error', () => finish(0));
    proc.on('close', () => {
      const s = out.trim();
      if (/^ERR curl_cffi import/i.test(s)) { impersonateOk = false; log('⚠ curl_cffi missing — node-only from here'); }
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

async function probeOne(id, saveHtmlTo) {
  const url = 'https://www.instagram.com/p/' + id + '/embed/captioned/';
  let r = await fetchNode(url);
  let m = markers(r.html), via = 'node';
  let d = verdict(m, r.status);
  if (d.kind === 'wall') {                 // walled/thin → impersonated retry
    const r2 = await fetchImpersonated(url);
    const m2 = markers(r2.html);
    const d2 = verdict(m2, r2.status);
    if (d2.kind !== 'wall' || (r2.html && r2.html.length > (r.html || '').length)) { r = r2; m = m2; d = d2; via = 'cffi'; }
  }
  if (saveHtmlTo) {
    try { fs.writeFileSync(path.join(saveHtmlTo, 'calib_' + id + '_' + via + '.html'), r.html || ''); } catch (_) {}
  }
  return { id, status: r.status, via, m, v: d.v, kind: d.kind };
}

// ── main ──────────────────────────────────────────────────────────────────────
(async () => {
  if (CALIB) {
    for (const id of CALIB.split(',').map(s => s.trim()).filter(Boolean)) {
      const p = await probeOne(id, SCRATCH);
      log(`calib ${id} → verdict=${p.v} kind=${p.kind} via=${p.via} status=${p.status} ` + JSON.stringify(p.m));
      await sleep(1200);
    }
    return;
  }

  const rows = JSON.parse(fs.readFileSync(IG_STORE, 'utf8'));
  if (!Array.isArray(rows) || !rows.length) { log('ig.json empty/unreadable — abort'); process.exit(1); }
  const statusRank = { downloaded: 0, enriched: 1, new: 2 };
  const targets = rows.filter(r => r && r.id && r.embed === undefined)
    .sort((a, b) => (statusRank[a.status] ?? 3) - (statusRank[b.status] ?? 3));
  const todo = LIMIT ? targets.slice(0, LIMIT) : targets;
  log(`ig.json rows=${rows.length} · unstamped=${targets.length} · this run=${todo.length}`);
  if (!todo.length) { log('nothing to do'); return; }

  const bak = IG_STORE + '.bak-embedprobe-' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  fs.copyFileSync(IG_STORE, bak);
  log('backup → ' + path.basename(bak));

  const save = () => {
    const tmp = IG_STORE + '.tmp-embedprobe';
    fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
    fs.renameSync(tmp, IG_STORE);
  };

  const CANARY = 'DSrgc-DjBTT';   // known embed-playable reel (sealifeandmore.org homepage)
  let n = 0, c1 = 0, c0 = 0, dead = 0, shells = 0, walls = 0, consecWalls = 0, sleeps = 0;
  const t0 = Date.now();
  for (const row of todo) {
    const p = await probeOne(row.id, null);
    n++;
    if (p.v === 1) { row.embed = 1; c1++; consecWalls = 0; sleeps = 0; }
    else if (p.v === 0) { row.embed = 0; c0++; if (p.kind === 'dead') dead++; consecWalls = 0; sleeps = 0; }
    else if (p.kind === 'shell') { shells++; consecWalls = 0; }   // per-post, IP is fine
    else { walls++; consecWalls++; }
    if (n % 100 === 0) save();
    if (n % 25 === 0 || n === todo.length) {
      const el = (Date.now() - t0) / 1000, rate = n / el;
      const eta = Math.round((todo.length - n) / rate / 60);
      log(`${n}/${todo.length} · embed1=${c1} embed0=${c0} (dead=${dead}) shell=${shells} wall=${walls} · ${rate.toFixed(2)}/s · eta ${eta}m`);
    }
    if (consecWalls >= 8) {
      // Canary: a wall streak can be a cluster of broken posts, not a burned IP.
      const can = await probeOne(CANARY, null);
      if (can.v !== null) {
        log(`⚠ ${consecWalls} consecutive walls but canary ${CANARY} probes fine — bad-post cluster, continuing`);
        consecWalls = 0;
      } else {
        sleeps++;
        if (sleeps > 3) { log('✋ 3 backoffs and canary still walled — IP is burned. Saving + exiting (re-run resumes).'); break; }
        log(`⏸ ${consecWalls} consecutive walls + canary walled — backing off 5 min (backoff ${sleeps}/3)`);
        save();
        await sleep(300000);
        consecWalls = 0;
      }
    }
    await sleep(900 + Math.random() * 600);
  }
  save();
  const stamped = rows.filter(r => r.embed !== undefined).length;
  log(`DONE this run: probed=${n} → embed1=${c1} embed0=${c0} (dead=${dead}) shell=${shells} wall=${walls} · total stamped=${stamped}/${rows.length}`);
})();
