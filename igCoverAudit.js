#!/usr/bin/env node
// igCoverAudit.js — (dev0678) sample a set of already-downloaded photo rows and ask IG,
// cookielessly, whether a BIGGER rendition of the same media is still on offer.
//
// Why: the dev0677 picker fix corrected new downloads, but the 1,377 covers the user
// reviewed and accepted (coverOk) were fetched by the OLD code. They look fine — mostly
// 1080² / 1079x883 — yet IG may still hold a larger uncropped original for them. This
// measures the gap on a sample instead of re-downloading 1,377 rows to find out.
//
// Method (no media is downloaded):
//   • local size  = the file's own header bytes
//   • available   = run the SHIPPED pickIgFullCover from proxy.js against the live /p/
//                   page, then read the winner's header with a ranged GET
// The picker is extracted from proxy.js at runtime, so this audits the real code path.
//
// Usage:
//   node igCoverAudit.js --field coverOk --n 30            sample + report (no writes)
//   node igCoverAudit.js --field coverOk --n 30 --apply    also stamp the rows
//   node igCoverAudit.js --ids ABC,DEF --apply             audit specific shortcodes
//
// Stamps (--apply):
//   every row in the population → coverGrade:'interim'   (accepted, never verified)
//   each sampled row            → coverGrade:'max' | 'upgradable'
//                                 coverProbe:{local,avail,gain,at}
// DO NOT run with the I screen open: it persists whole rows and would clobber this.
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const DIR = __dirname;
const IG_STORE = path.join(DIR, 'ig.json');
const MEDIA = path.join(DIR, 'ig_media');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const APPLY = has('--apply');
const FIELD = val('--field', 'coverOk');
const N = +val('--n', 30);
const IDS = val('--ids', '');
const GAP = +val('--gap', 1500);

// ── the shipped picker, lifted out of proxy.js ────────────────────────────────
const src = fs.readFileSync(path.join(DIR, 'proxy.js'), 'utf8');
const fi = src.indexOf('function pickIgFullCover');
const fj = src.indexOf('\n}', fi);
if (fi < 0 || fj < 0) { console.error('could not find pickIgFullCover in proxy.js'); process.exit(1); }
const pickIgFullCover = new Function('return (' + src.slice(fi, fj + 2) + ')')();

// ── pixel dims from header bytes ──────────────────────────────────────────────
function dimsFromBuf(b) {
  if (!b || b.length < 24) return null;
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const mk = b[o + 1];
      if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc)
        return { w: b.readUInt16BE(o + 7), h: b.readUInt16BE(o + 5) };
      o += 2 + b.readUInt16BE(o + 2);
    }
    return null;
  }
  if (b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') {
    const f = b.slice(12, 16).toString('ascii');
    if (f === 'VP8X') return { w: (b.readUIntLE(24, 3) & 0xffffff) + 1, h: (b.readUIntLE(27, 3) & 0xffffff) + 1 };
    if (f === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (f === 'VP8L') { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
    return null;
  }
  if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  return null;
}
function localDims(file) {
  try {
    const buf = Buffer.alloc(65536);
    const fd = fs.openSync(file, 'r');
    const n = fs.readSync(fd, buf, 0, 65536, 0);
    fs.closeSync(fd);
    return dimsFromBuf(buf.slice(0, n));
  } catch (_) { return null; }
}
function fetchHtml(url) {
  return new Promise(resolve => {
    const opts = { agent: false, headers: { 'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9', 'Referer': url, 'Connection': 'close' } };
    let h = '';
    const req = https.get(url, opts, r => {
      if (r.statusCode !== 200) { r.resume(); resolve(''); return; }
      r.setEncoding('utf8');
      r.on('data', c => { h += c; if (h.length > 8e6) req.destroy(); });
      r.on('end', () => resolve(h));
    });
    req.on('error', () => resolve(''));
    req.setTimeout(20000, () => { req.destroy(); resolve(''); });
  });
}
function remoteDims(url, referer, hops) {
  hops = hops || 0;
  return new Promise(resolve => {
    const opts = { agent: false, headers: { 'User-Agent': UA,
      'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8', 'Referer': referer,
      'Range': 'bytes=0-131071', 'Connection': 'close' } };
    const ch = []; let done = false;
    const fin = () => { if (done) return; done = true; resolve(dimsFromBuf(Buffer.concat(ch))); };
    const req = https.get(url, opts, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 3) {
        r.resume(); if (!done) { done = true; remoteDims(new URL(r.headers.location, url).href, referer, hops + 1).then(resolve); } return;
      }
      if (r.statusCode !== 200 && r.statusCode !== 206) { r.resume(); if (!done) { done = true; resolve(null); } return; }
      r.on('data', c => ch.push(c));
      r.on('end', fin);
    });
    req.on('error', () => { if (!done) { done = true; resolve(null); } });
    req.setTimeout(15000, () => { req.destroy(); fin(); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const rows = JSON.parse(fs.readFileSync(IG_STORE, 'utf8'));
  const pop = IDS
    ? rows.filter(r => r && IDS.split(',').map(s => s.trim()).includes(r.id))
    : rows.filter(r => r && r[FIELD] && (r.localFiles || []).length);
  if (!pop.length) { console.log('no rows match'); return; }
  // Rows already measured are still part of the population (they get counted and keep
  // their verdict) but are not re-probed — so a second run ADDS evidence instead of
  // re-asking IG about the same posts.
  const fresh = IDS ? pop : pop.filter(r => !r.coverProbe);

  // Stratified sample: spread across authors and current size, so one big author or one
  // size band can't dominate a small sample.
  const key = r => {
    const d = localDims(path.join(MEDIA, r.localFiles[0]));
    const m = d ? Math.max(d.w, d.h) : 0;
    return (r.author || '?') + '|' + (m >= 1440 ? 'a' : m >= 1080 ? 'b' : m >= 641 ? 'c' : 'd');
  };
  const groups = new Map();
  for (const r of fresh) { const k = key(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  for (const list of groups.values()) list.sort(() => Math.random() - 0.5);
  const sample = [];
  const keys = [...groups.keys()];
  const want = Math.min(N, fresh.length);
  while (sample.length < want) {
    let added = false;
    for (const k of keys) {
      const list = groups.get(k);
      if (list.length) { sample.push(list.pop()); added = true; }
      if (sample.length >= want) break;
    }
    if (!added) break;
  }
  const already = pop.length - fresh.length;
  console.log('population (' + (IDS ? 'ids' : FIELD) + '): ' + pop.length + '  ·  sampling ' + sample.length
    + (already ? '  ·  ' + already + ' already measured (kept, not re-probed)' : '')
    + '  ·  groups ' + groups.size + '\n');

  const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');
  let max = 0, up = 0, failed = 0;
  const gains = [];
  for (const r of sample) {
    const lf = r.localFiles[0];
    const ld = localDims(path.join(MEDIA, lf));
    const url = 'https://www.instagram.com/p/' + r.id + '/';
    const html = await fetchHtml(url);
    let rd = null, picked = '';
    if (html) {
      const og = (html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]*)"/i) || [])[1] || '';
      picked = og ? pickIgFullCover(html, og) : '';
      if (picked) rd = await remoteDims(picked, url);
    }
    const lm = ld ? Math.max(ld.w, ld.h) : 0;
    const rm = rd ? Math.max(rd.w, rd.h) : 0;
    let verdict;
    if (!rm) { verdict = 'probe-failed'; failed++; }
    else if (rm > lm) { verdict = 'upgradable'; up++; gains.push(rm / (lm || 1)); }
    else { verdict = 'max'; max++; }
    const px = (ld && rd) ? ((rd.w * rd.h) / (ld.w * ld.h)) : 0;
    console.log(
      (verdict === 'upgradable' ? '↑ ' : verdict === 'max' ? '= ' : '? ') +
      (r.id + '').padEnd(13) +
      'local ' + (ld ? (ld.w + 'x' + ld.h) : '?').padEnd(11) +
      'available ' + (rd ? (rd.w + 'x' + rd.h) : 'n/a').padEnd(11) +
      (px > 1 ? (px.toFixed(1) + '× pixels') : '') +
      '  @' + (r.author || '?'));
    if (APPLY && rm) {
      r.coverGrade = verdict;
      r.coverProbe = { local: ld ? ld.w + 'x' + ld.h : '', avail: rd.w + 'x' + rd.h,
        gain: +(px.toFixed(2)), at: nowStr };
    }
    await sleep(GAP);
  }

  const med = gains.length ? gains.slice().sort((a, b) => a - b)[Math.floor(gains.length / 2)] : 0;
  console.log('\nSAMPLE: ' + max + ' already maximal · ' + up + ' upgradable'
    + (med ? ' (median ' + med.toFixed(2) + '× on the long edge)' : '')
    + (failed ? ' · ' + failed + ' probe failed' : ''));
  const rate = (max + up) ? up / (max + up) : 0;
  console.log('→ extrapolated over ' + pop.length + ' rows: ~' + Math.round(rate * pop.length) + ' would come back bigger');

  if (!APPLY) { console.log('\nDRY RUN — no rows stamped. Re-run with --apply.'); return; }
  // Everything in the population that was NOT sampled is explicitly "interim": accepted
  // by eye, never checked against IG. Sampled rows already carry their measured verdict.
  let interim = 0;
  for (const r of pop) if (!r.coverGrade) { r.coverGrade = 'interim'; interim++; }
  const bak = IG_STORE + '.bak-coveraudit-' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  fs.copyFileSync(IG_STORE, bak);
  const tmp = IG_STORE + '.tmp-coveraudit';
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
  fs.renameSync(tmp, IG_STORE);
  console.log('backup → ' + path.basename(bak));
  console.log('stamped: ' + (max + up) + ' sampled (max/upgradable) + ' + interim + ' interim');
})();
