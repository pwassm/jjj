#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// igResAudit.js — (dev0696) ASK IG what a post's originals are, instead of
// re-downloading every item to find out. Metadata only: no media is fetched.
// ══════════════════════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS. The ⚠ "below 1080" filter (ig.js belowTarget → dlMinW < 1080)
// was built on the dev0690 finding that the logged-out /p page caps carousel VIDEO
// at 720. That is true for video. It is NOT true for photos, and the filter does
// not distinguish them — so a photo post whose uploader exported at 933px has sat
// in the re-fetch queue being re-downloaded forever, because IG's original is
// 933px and 933 < 1080 will never stop being true.
//
// Verified on mimmofotosub/p/CotWRZFqxQT (10 photo items, all on disk exactly
// equal to IG's declared originals: 933, 853×4, 640, 933, 999×2, 1364):
//   • each item's `original_width`/`original_height` in the page's inline JSON
//     matched the file on disk pixel for pixel;
//   • candidate[0] (uncropped, no s<W>x<H> token) re-downloaded byte-identical;
//   • the candidate ladder steps DOWN from the original — 720, 640, 480, 320,
//     240 — with no 1080 rung, because IG never generated one;
//   • stripping or forging `stp=` for a bigger tier is HTTP 403 (the URL
//     signature covers it), so a tier IG did not generate cannot be requested;
//   • one item is 1364px WIDE — above the old 1080 feed ceiling — which proves
//     IG is serving the upload as-is here rather than capping it.
//
// So for a PHOTO post the page's declared original is the ceiling, and it is
// knowable for the price of one page fetch instead of re-pulling every item.
//
// ── the one asymmetry, and why it is the safe direction ───────────────────────
//
// This script trusts `original_width` only as an UPPER BOUND on what we can get:
//
//   declared <= what we hold   →  AT MAX. Conclude: stamp resBest, drop the
//                                 needsFullRes mark, stop re-queueing the row.
//   declared >  what we hold   →  UPGRADEABLE. Change nothing except leave the
//                                 row queued — exactly what happens today.
//
// A false "upgradeable" therefore costs one re-fetch, which is the status quo. A
// false "at max" would lose resolution, so it is only ever concluded when we
// ALREADY hold at least what IG declares — which cannot lose anything.
//
// VIDEO is excluded from the conclusion entirely. dev0690 established that a
// video item's declared size on the logged-out surface is the CAPPED one (720
// where the source is 1080), so a declared-vs-held comparison is meaningless
// there. Any row holding a video file, or whose page shows a `video_versions`
// item, is reported and left queued — those are the genuine dev0690 upgrades.
//
// ── usage ─────────────────────────────────────────────────────────────────────
//   node igResAudit.js                     audit + report. Writes NOTHING.
//   node igResAudit.js --apply             conclude the at-max rows
//   node igResAudit.js --queued-only       only rows already marked needsFullRes
//   node igResAudit.js --author NAME       one account
//   node igResAudit.js --limit 50          test run
//   node igResAudit.js --unmark [--apply]  drop every resBest this script wrote
//   options: --jobs N (default 4, max 8) · --sleep MS (default 250, per fetch)
//            --wall-cap N (consecutive walled pages before aborting, default 8)
//
// Verdicts are cached in ig.json.resaudit-cache.json (gitignored, keyed on row
// id) so a dry run is paid for once and --apply is instant. Walled and errored
// rows are NOT cached — they are meant to be retried. Delete the file to force a
// full re-audit.
//
// Fetches are the same lenient cookieless surface enrich uses: plain Node first,
// the curl_cffi impersonator (ig_impersonate_fetch.py) only when the Node read
// comes back walled. Your IG login is never touched. On a VPN exit that IG has
// walled, every page comes back thin — the --wall-cap abort stops the run rather
// than burning through the backlog recording "walled" for all of it.
//
// DO NOT run with the I screen open: it persists whole rows and would clobber the
// ig.json edits (the same hazard igMeasure.js and igFolderByAuthor.js carry).
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const DIR = __dirname;
const IG_STORE = path.join(DIR, 'ig.json');
const MEDIA = path.join(DIR, 'ig_media');
const CACHE = path.join(DIR, 'ig.json.resaudit-cache.json');
const IMPERSONATE_PY = path.join(DIR, 'ig_impersonate_fetch.py');
const IG_PYTHON = process.env.IG_PYTHON || 'python';

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const APPLY = has('--apply');
const UNMARK = has('--unmark');
const QUEUED_ONLY = has('--queued-only');
const AUTHOR = val('--author', '');
const LIMIT = Math.max(0, +val('--limit', 0) || 0);
const JOBS = Math.max(1, Math.min(8, +val('--jobs', 4) || 4));
const SLEEP = Math.max(0, +val('--sleep', 250) || 0);
const WALL_CAP = Math.max(1, +val('--wall-cap', 8) || 8);

// MUST match ig.js RES_TARGET_W / belowTarget().
const RES_TARGET_W = 1080;
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v)$/i;
const stampNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const rows = JSON.parse(fs.readFileSync(IG_STORE, 'utf8'));
if (!Array.isArray(rows)) { console.error('ig.json is not an array — aborting.'); process.exit(1); }
const filesOf = r => (Array.isArray(r.localFiles) ? r.localFiles : []).filter(Boolean);

function backup(tag) {
  const bak = IG_STORE + '.bak-resaudit' + (tag ? '-' + tag : '') + '-'
    + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  fs.copyFileSync(IG_STORE, bak);
  console.log('backup → ' + path.basename(bak));
}
function save() {
  const tmp = IG_STORE + '.tmp-resaudit';
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
  fs.renameSync(tmp, IG_STORE);
  console.log('ig.json written (' + rows.length + ' rows)');
}

// ══════════════════════════════════════════════════════════════════════════════
// --unmark — drop every conclusion this script made
// ══════════════════════════════════════════════════════════════════════════════
if (UNMARK) {
  let n = 0;
  for (const r of rows) {
    if (!r || r.resBestVia !== 'audit') continue;   // never touch the proxy's proven verdict
    delete r.resBest; delete r.resBestVia; delete r.resBestAt; delete r.resBestDecl;
    n++;
  }
  console.log('cleared ' + n + ' audited resBest stamp(s)');
  console.log('(the rows return to the ⚠ below-' + RES_TARGET_W + ' filter; needsFullRes is NOT restored —');
  console.log(' re-queue with igMeasure.js --apply --mark if that is what you want)');
  if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --unmark --apply.'); process.exit(0); }
  if (n) { backup('unmark'); save(); } else console.log('nothing to undo.');
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════════════════════
// page fetch — Node first, impersonate only when walled (mirrors proxy.js
// igGetPageHtml / igPageHasMedia)
// ══════════════════════════════════════════════════════════════════════════════
const pageHasMedia = h => /"image_versions2"|"video_versions"|"carousel_media"/.test(h);

function nodeHtml(permalink) {
  return new Promise(resolve => {
    const opts = { agent: false, headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9', 'Referer': permalink, 'Connection': 'close' } };
    let h = '';
    const req = https.get(permalink, opts, r => {
      if (r.statusCode !== 200) { r.resume(); resolve({ status: r.statusCode, html: '' }); return; }
      r.setEncoding('utf8');
      r.on('data', c => { h += c; if (h.length > 12e6) req.destroy(); });
      r.on('end', () => resolve({ status: 200, html: h }));
    });
    req.on('error', () => resolve({ status: 0, html: '' }));
    req.setTimeout(25000, () => { req.destroy(); resolve({ status: 0, html: '' }); });
  });
}
let impersonateOk = null;   // null=untried, false=curl_cffi missing → stop spawning
function impersonateHtml(permalink) {
  return new Promise(resolve => {
    if (impersonateOk === false) { resolve(''); return; }
    const tmp = path.join(MEDIA, '.resaudit_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
    let proc;
    try {
      proc = spawn(IG_PYTHON, [IMPERSONATE_PY, permalink, tmp, permalink,
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ''], { windowsHide: true });
    } catch (_) { impersonateOk = false; resolve(''); return; }
    let out = '', done = false;
    const finish = h => {
      if (done) return; done = true; clearTimeout(killT);
      try { fs.unlinkSync(tmp); } catch (_) {}
      resolve(h);
    };
    const killT = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} finish(''); }, 40000);
    proc.stdout.on('data', d => { out += d.toString('utf8'); if (out.length > 2000) out = out.slice(-2000); });
    proc.on('error', () => { impersonateOk = false; finish(''); });
    proc.on('close', () => {
      if (/^ERR curl_cffi import/i.test(out.trim())) impersonateOk = false;
      else if (/^\d/.test(out.trim())) impersonateOk = true;
      let h = ''; try { h = fs.readFileSync(tmp, 'utf8'); } catch (_) {}
      finish(h);
    });
  });
}
// → { html, status } — status 404 means the post is gone, and is reported as such
// rather than retried, since no fetch surface will bring it back.
async function getPage(permalink) {
  const a = await nodeHtml(permalink);
  if (a.status === 200 && pageHasMedia(a.html)) return { html: a.html, status: 200 };
  if (a.status === 404) return { html: '', status: 404 };
  const b = await impersonateHtml(permalink);
  if (b && pageHasMedia(b)) return { html: b, status: 200 };
  return { html: a.html || b || '', status: a.status || 0 };
}

// ══════════════════════════════════════════════════════════════════════════════
// parse — every item's DECLARED original size, and whether it is a video
// ══════════════════════════════════════════════════════════════════════════════
// Same brace walker pickIgCarouselMedia uses, so the item array parsed here is
// byte-for-byte the one the downloader walks.
function matchBracketedJson(html, openIdx) {
  const open = html[openIdx], close = open === '[' ? ']' : '}';
  let d = 0, inStr = false, esc = false;
  for (let i = openIdx; i < html.length; i++) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (inStr) { if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === open) d++;
    else if (c === close) { d--; if (!d) return html.slice(openIdx, i + 1); }
  }
  return null;
}
// Returns { items: [{w,h,video}], via } or null when the page declares nothing.
function declaredItems(html) {
  // ── carousel: anchor on `"carousel_media":[`, keep the longest array (the key
  // name also appears as a bare field reference elsewhere on the page).
  const re = /"carousel_media"\s*:\s*\[/g; let m, best = [];
  while ((m = re.exec(html))) {
    const s = matchBracketedJson(html, m.index + m[0].length - 1);
    if (!s) continue;
    let items; try { items = JSON.parse(s); } catch (_) { continue; }
    if (Array.isArray(items) && items.length > best.length) best = items;
  }
  if (best.length) {
    const items = [];
    for (const it of best) {
      if (!it || typeof it !== 'object') continue;
      items.push({
        w: +it.original_width || 0,
        h: +it.original_height || 0,
        video: !!(Array.isArray(it.video_versions) && it.video_versions.length)
      });
    }
    if (items.length) return { items, via: 'carousel' };
  }
  // ── single item: no carousel_media at all. The page carries one
  // original_width/original_height pair — and emits them in EITHER order
  // (`…"original_height":921,"original_width":911…` is what a single photo /p
  // actually serves), so both are matched.
  const a = html.match(/"original_width"\s*:\s*(\d+)\s*,\s*"original_height"\s*:\s*(\d+)/);
  const b = html.match(/"original_height"\s*:\s*(\d+)\s*,\s*"original_width"\s*:\s*(\d+)/);
  const w = a ? +a[1] : (b ? +b[2] : 0);
  const h = a ? +a[2] : (b ? +b[1] : 0);
  if (w > 0 && h > 0) return { items: [{ w, h, video: /"video_versions"\s*:\s*\[\s*\{/.test(html) }], via: 'single' };
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// audit
// ══════════════════════════════════════════════════════════════════════════════
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')) || {}; } catch (_) { cache = {}; }
let cacheDirty = 0;
const saveCache = () => {
  if (!cacheDirty) return;
  try { fs.writeFileSync(CACHE, JSON.stringify(cache)); cacheDirty = 0; } catch (_) {}
};

// The ⚠ below-target population: measured, under target, not already concluded.
// `--queued-only` narrows to the rows actually marked for re-fetch.
const eligible = rows.filter(r => r && (r.dlMinW || 0) > 0 && r.dlMinW < RES_TARGET_W
  && !r.resBest && r.status !== 'promoted' && !r.dead && filesOf(r).length
  && /\/(p|reel|tv)\//i.test(r.url || '')
  && (!QUEUED_ONLY || r.needsFullRes)
  && (!AUTHOR || (r.author || '').toLowerCase() === AUTHOR.toLowerCase()));
let targets = LIMIT ? eligible.slice(0, LIMIT) : eligible;

const V = { atMax: [], upgradeable: [], partial: [], video: [], walled: [], gone: [], nodecl: [] };
let walledStreak = 0, aborted = false, fetched = 0, cacheHits = 0;
const t0 = Date.now();

// One row → a verdict. Pure classification; nothing is written here.
function classify(r, decl) {
  const held = filesOf(r);
  const nHeld = held.length;
  const heldHasVideo = held.some(f => VIDEO_EXT.test(f));
  const items = decl.items.filter(it => it.w > 0 && it.h > 0);
  if (!items.length) return { v: 'nodecl' };
  // A video anywhere means the declared numbers are the capped ones (dev0690) —
  // no conclusion is possible, and these are the real upgrades anyway.
  if (heldHasVideo || items.some(it => it.video)) return { v: 'video', nDecl: decl.items.length };
  const declMinW = Math.min(...items.map(it => it.w));
  const declPixels = Math.max(...items.map(it => it.w * it.h));
  const heldPixels = (r.dlW || 0) * (r.dlH || 0);
  const info = { nDecl: decl.items.length, declMinW, declPixels, heldPixels, via: decl.via };
  // Missing items outright — the walk was throttled. Genuine re-fetch, and the
  // resolution comparison below would be against an incomplete set anyway.
  if (decl.items.length > nHeld) return Object.assign({ v: 'partial' }, info);
  // Something to gain on either axis → leave it queued, change nothing.
  if (declMinW > (r.dlMinW || 0) || declPixels > heldPixels) return Object.assign({ v: 'upgradeable' }, info);
  return Object.assign({ v: 'atMax' }, info);
}

async function auditOne(r) {
  if (aborted) return;
  const c = cache[r.id];
  if (c && c.items) {
    cacheHits++;
    r._verdict = classify(r, { items: c.items, via: c.via });
    r._verdict.cached = 1;
    return;
  }
  const { html, status } = await getPage(r.url);
  fetched++;
  if (SLEEP) await sleep(SLEEP + Math.floor(Math.random() * SLEEP));
  if (status === 404) { r._verdict = { v: 'gone' }; walledStreak = 0; return; }
  if (!html || !pageHasMedia(html)) {
    r._verdict = { v: 'walled' };
    if (++walledStreak >= WALL_CAP) {
      aborted = true;
      console.warn('\n⚠ ' + walledStreak + ' walled pages in a row — ABORTING the run.'
        + '\n  This exit is almost certainly blocked. Rotate the VPN exit and re-run;'
        + '\n  nothing walled was cached, so the retry costs nothing extra.');
    }
    return;
  }
  walledStreak = 0;
  const decl = declaredItems(html);
  if (!decl) { r._verdict = { v: 'nodecl' }; return; }
  cache[r.id] = { items: decl.items, via: decl.via, at: stampNow() };
  if (++cacheDirty >= 200) saveCache();
  r._verdict = classify(r, decl);
}

async function runPool(items, n, worker) {
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const k = i++;
      if (k >= items.length || aborted) return;
      await worker(items[k]);
      if (++done % 25 === 0) {
        process.stdout.write('  audited ' + done + '/' + items.length + '  ('
          + (done / items.length * 100).toFixed(0) + '%, ' + ((Date.now() - t0) / 1000).toFixed(0) + 's, '
          + V.atMax.length + ' concluded so far)\r');
      }
    }
  }));
}

process.on('SIGINT', () => { saveCache(); console.log('\ninterrupted — verdicts so far are cached.'); process.exit(130); });

(async () => {
  console.log('\nigResAudit — ' + eligible.length + ' row(s) below ' + RES_TARGET_W + 'px and not yet concluded'
    + (LIMIT ? '  ·  limited to ' + targets.length : '')
    + (QUEUED_ONLY ? '  ·  --queued-only' : '') + (AUTHOR ? '  ·  @' + AUTHOR : ''));
  console.log('  ' + JOBS + ' parallel page fetch' + (SLEEP ? ', ' + SLEEP + '–' + SLEEP * 2 + 'ms apart' : '')
    + '  ·  METADATA ONLY, no media is downloaded'
    + (Object.keys(cache).length ? '  ·  cache warm (' + Object.keys(cache).length + ')' : '') + '\n');

  await runPool(targets, JOBS, auditOne);
  saveCache();
  process.stdout.write(' '.repeat(78) + '\r');

  for (const r of targets) {
    const v = r._verdict;
    if (!v) continue;                       // never reached (aborted run)
    (V[v.v] || V.nodecl).push(r);
  }

  const byAuthor = list => {
    const m = {};
    list.forEach(r => { const a = r.author || '?'; m[a] = (m[a] || 0) + 1; });
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 4).map(e => '@' + e[0] + '=' + e[1]).join(' ');
  };

  console.log((APPLY ? 'APPLYING' : 'DRY RUN (nothing written — pass --apply)') + '\n');
  console.log('audited ' + (V.atMax.length + V.upgradeable.length + V.partial.length + V.video.length
    + V.walled.length + V.gone.length + V.nodecl.length) + ' of ' + targets.length
    + '   ·  ' + fetched + ' page fetch' + (fetched === 1 ? '' : 'es') + ', ' + cacheHits + ' from cache'
    + '  ·  ' + ((Date.now() - t0) / 1000).toFixed(0) + 's\n');

  console.log('CONCLUDED — already at IG\'s maximum, will stop being re-queued');
  console.log('  at max                    : ' + V.atMax.length + '   ' + byAuthor(V.atMax));
  console.log('\nSTILL WORTH RE-FETCHING — left queued, nothing changed');
  console.log('  IG declares BIGGER        : ' + V.upgradeable.length + '   ' + byAuthor(V.upgradeable));
  console.log('  fewer items than the post : ' + V.partial.length + '   ' + byAuthor(V.partial));
  console.log('  holds/declares video      : ' + V.video.length + '   (dev0690 720-cap cases — the real upgrades)');
  console.log('\nNO VERDICT — left completely alone');
  console.log('  walled (thin page)        : ' + V.walled.length);
  console.log('  post gone (404)           : ' + V.gone.length);
  console.log('  page declared no size     : ' + V.nodecl.length);

  if (V.upgradeable.length) {
    console.log('\nbiggest gains available (declared vs held, narrowest item):');
    V.upgradeable
      .map(r => ({ r, gain: (r._verdict.declMinW || 0) - (r.dlMinW || 0) }))
      .sort((a, b) => b.gain - a.gain).slice(0, 10)
      .forEach(x => console.log('  @' + (x.r.author || '?') + '  ' + x.r.id
        + '   held ' + x.r.dlMinW + 'px → IG has ' + x.r._verdict.declMinW + 'px   (+' + x.gain + ')'));
  }
  if (V.atMax.length) {
    console.log('\nexamples concluded:');
    V.atMax.slice(0, 8).forEach(r => console.log('  @' + (r.author || '?') + '  ' + r.id
      + '   ' + r.dlW + 'x' + r.dlH + ' min' + r.dlMinW + '  =  IG declares min' + r._verdict.declMinW
      + ' over ' + r._verdict.nDecl + ' item(s)'));
  }

  if (aborted) {
    console.log('\nRUN ABORTED on a walled exit — the numbers above are partial.');
    if (!APPLY) console.log('Nothing was written.\n');
  }
  if (!APPLY) {
    console.log('\nNothing was written. Re-run with --apply to conclude the ' + V.atMax.length + ' at-max row(s).');
    console.log('(verdicts are cached, so --apply skips straight to the writing)\n');
    process.exit(0);
  }

  // ── write ───────────────────────────────────────────────────────────────────
  if (!V.atMax.length) { console.log('\nnothing to conclude.\n'); process.exit(0); }
  backup('');
  const now = stampNow();
  const receipt = ['igResAudit.js --apply   ' + new Date().toISOString(),
    'concluded ' + V.atMax.length + ' row(s) as already at IG\'s maximum resolution',
    '(declared original <= what is on disk, photo-only, complete item count)', ''];
  let n = 0, nItemsFixed = 0;
  for (const r of V.atMax) {
    const v = r._verdict;
    r.resBest = 1;
    r.resBestVia = 'audit';                 // distinguishable from the proxy's proven verdict
    r.resBestAt = now;
    // What IG actually declared, so a later reader can see WHY this was concluded
    // without re-fetching the page: "min<W> over <N> item(s)".
    r.resBestDecl = v.declMinW + 'w/' + v.nDecl + 'i';
    delete r.needsFullRes;                  // out of the re-fetch queue for good
    delete r.fullResTries;
    delete r.refetchStuck;
    if (v.nDecl > 0 && r.nItems !== v.nDecl) { r.nItems = v.nDecl; nItemsFixed++; }
    receipt.push(r.id + '  @' + (r.author || '?') + '  held ' + r.dlW + 'x' + r.dlH + ' min' + r.dlMinW
      + '  IG declares min' + v.declMinW + ' over ' + v.nDecl + ' item(s)  [' + v.via + ']');
    n++;
  }
  for (const r of rows) delete r._verdict;
  const rPath = path.join(DIR, 'ig.json.resaudit-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt');
  try { fs.writeFileSync(rPath, receipt.join('\n') + '\n'); } catch (_) {}
  console.log('\nconcluded ' + n + ' row(s): resBest + resBestVia:\'audit\', needsFullRes dropped'
    + (nItemsFixed ? '\ncorrected nItems on ' + nItemsFixed + ' row(s) from the page\'s real item count' : ''));
  console.log('receipt → ' + path.basename(rPath));
  save();
  console.log('\nNEXT: the ⚠ below-' + RES_TARGET_W + ' filter drops by ' + n + '. What remains under it is'
    + '\n      genuinely upgradeable — grind it with I ▸ Re-fetch ▸ needs full-res.'
    + '\n      Undo any of this with `node igResAudit.js --unmark --apply`.\n');
})();
