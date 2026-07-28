#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// igMeasure.js — (dev0690b) measure what is ALREADY on disk, and arm the guard.
// Entirely offline: no network, no proxy, no VPN, no Instagram. Reads files.
// ══════════════════════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS. dev0690 added two things that both depend on knowing the real
// pixel size of the files a row holds:
//
//   • the DOWNGRADE GUARD (ig.js:2387 → proxy.js publish()). The client sends
//     keepPixels = r.dlW * r.dlH so the proxy can throw away a re-download that
//     came back smaller than what we already have. On every row downloaded before
//     dev0690, dlW/dlH are absent — keepPixels is 0 — so the guard is DISARMED on
//     the entire back catalogue, which is precisely the set being re-fetched.
//     Measuring is what arms it.
//   • the ⚠ / Res filters (low / ok / unmeasured / best). They read dlMinW, which
//     nothing has ever written for those rows, so "low" is currently blind and
//     "unmeasured" holds nearly everything.
//
// dlW/dlH/dlMinW are stamped here with EXACTLY the definition proxy.js publish()
// uses, so a measured row and a freshly-downloaded one are indistinguishable:
//   dlW/dlH = the LARGEST item's width/height        (pubStats.maxW / maxH)
//   dlMinW  = the NARROWEST item's width             (pubStats.minW)
// Unreadable items are excluded from both, as they are in the proxy. Comparison is
// always PIXELS, never bytes: IG's 720p progressive h264 is routinely a bigger file
// than the 1080p VP9 that supersedes it.
//
// ── what --mark does, and the one inference in it ─────────────────────────────
//
// Below target (dlMinW < 1080) splits by post kind, because the two kinds reached
// disk down different code paths:
//
//   /p  → MARK for re-fetch. dev0648 put the cookieless walker first for every /p
//         post, and the logged-out page caps carousel video at 720 wide. dev0690
//         fixed that (walker for the inventory, yt-dlp for the video bytes), so
//         these rows can genuinely improve. They get needsFullRes = true and their
//         current localFiles copied to prevFiles, so the superseded 720s can be
//         swept precisely afterwards (--sweep) instead of being hunted as orphans:
//         a 720→1080 re-fetch lands under a NEW name, since the filename encodes
//         its own W×H, and would otherwise be left behind.
//
//         NOTE — unlike igMarkLowRes.js, this does NOT clear localFiles. That
//         script had to, because pre-dev0690 nothing else re-offered a downloaded
//         row; since dev0690 `needsFullRes` alone makes isReady() true (ig.js
//         isReady / isDownloadDone). Clearing localFiles here would zero keepPixels
//         at ig.js:2387 and disarm the guard on the very rows most likely to come
//         back worse — the opposite of the point of this script.
//
//   reel/tv → STAMP resBest (an INFERENCE — this is the judgement call in here).
//         Reels download through yt-dlp with no -f, so yt-dlp already picked the
//         best format IG offers; 720x1280 is IG's stored ceiling for those posts,
//         not a cap we imposed. Stamping resBest clears them out of the ⚠ "low"
//         filter permanently instead of spending ~1,200 fetches to have the proxy
//         refuse each one and mark it itself. It is an inference from the download
//         path, NOT a per-post measurement, so it is recorded as
//         resBestVia:'infer' — distinguishable from the proxy's proven verdict
//         (which sets resBest with no such field) and reversible with --unmark.
//         Pass --no-reels-best to skip it and let the grind prove each one.
//
// A row at or above 1080 needs nothing: it is already outside the "low" filter.
// Any stale resBest on such a row is dropped, mirroring ig.js:2461.
//
// Rows below 1080 that IG simply never held bigger (2012-era 640px photos) cannot
// be told apart from fixable ones without asking IG, so they are marked too. They
// cost one fetch each and then settle themselves: the proxy refuses the equal-or-
// worse result, or fullResTries hits REFETCH_TRIES and sets refetchStuck.
//
// ── usage ─────────────────────────────────────────────────────────────────────
//   node igMeasure.js                    measure + report. Writes NOTHING.
//   node igMeasure.js --apply            stamp dlW/dlH/dlMinW into ig.json
//   node igMeasure.js --apply --mark     …and queue the /p rows + stamp the reels
//   node igMeasure.js --apply --mark --no-reels-best      skip the inference
//   node igMeasure.js --unmark [--apply] undo --mark (both halves of it)
//   node igMeasure.js --sweep [--apply]  AFTER the re-fetch grind: delete each
//                                        superseded file, with a receipt
//   node igMeasure.js --apply --mark --video-only         queue only the /p rows
//                                        holding VIDEO — the dev0690 720-cap cases,
//                                        ~a quarter of the backlog and nearly all of
//                                        its yield. Run those first, then re-run
//                                        without the flag for the stills.
//   options: --jobs N (ffprobe concurrency, default 8) · --limit N (test run)
//            --include-stuck (also re-queue rows that already gave up)
//
// Measurements are cached in ig.json.measure-cache.json (gitignored, keyed on
// path+size+mtime), so the dry run is paid for once and every later pass is
// instant. Delete it to force a full re-measure.
//
// DO NOT run with the I screen open: it persists whole rows and would clobber the
// ig.json edits (the same hazard igFolderByAuthor.js and igOrphans.js carry).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DIR = __dirname;
const IG_STORE = path.join(DIR, 'ig.json');
const MEDIA = path.join(DIR, 'ig_media');
const CACHE = path.join(DIR, 'ig.json.measure-cache.json');

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const APPLY = has('--apply');
const MARK = has('--mark');
const UNMARK = has('--unmark');
const SWEEP = has('--sweep');
const NO_REELS_BEST = has('--no-reels-best');
const INCLUDE_STUCK = has('--include-stuck');
// Queue only the /p rows that HOLD VIDEO. Those are the dev0690 720-cap cases and
// the highest-yield third of the backlog; the stills are mostly old posts IG never
// held bigger. Lets a long grind be run best-first instead of all-or-nothing.
const VIDEO_ONLY = has('--video-only');
const JOBS = Math.max(1, Math.min(32, +val('--jobs', 8) || 8));
const LIMIT = Math.max(0, +val('--limit', 0) || 0);

// MUST match ig.js. IG encodes at a width of 1080 or 720 — a landscape clip is
// 1080 wide too — so WIDTH is the ceiling to measure against, not the long edge.
const RES_TARGET_W = 1080;
// Mirrors ig.js kindOf(): reads r.url, not the localFiles.
const kindOf = r => /\/reel\//i.test(r.url || '') ? 'reel'
                 : /\/p\//i.test(r.url || '') ? 'p'
                 : /\/tv\//i.test(r.url || '') ? 'tv' : '?';
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v)$/i;
const stampNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

// ── real pixel size ───────────────────────────────────────────────────────────
// Header bytes for stills, ffprobe for video — the same two paths, and the same
// format handling, as proxy.js _probeMediaDimsUncached().
function imageDims(file) {
  let buf, n;
  try {
    buf = Buffer.alloc(65536);
    const fd = fs.openSync(file, 'r');
    n = fs.readSync(fd, buf, 0, 65536, 0);
    fs.closeSync(fd);
  } catch (_) { return null; }
  const b = buf.slice(0, n);
  if (b.length < 24) return null;
  if (b[0] === 0xff && b[1] === 0xd8) {                                  // JPEG
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
  if (b[0] === 0x47 && b[1] === 0x49) return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  return null;
}
function ffprobeDims(file) {
  return new Promise(resolve => {
    execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file],
      { encoding: 'utf8', timeout: 20000, windowsHide: true }, (err, out) => {
        if (err) return resolve(null);
        const m = String(out).match(/(\d+)x(\d+)/);
        resolve(m ? { w: +m[1], h: +m[2] } : null);
      });
  });
}

// ── ig.json I/O ───────────────────────────────────────────────────────────────
const rows = JSON.parse(fs.readFileSync(IG_STORE, 'utf8'));
if (!Array.isArray(rows)) { console.error('ig.json is not an array — aborting.'); process.exit(1); }
const filesOf = r => (Array.isArray(r.localFiles) ? r.localFiles : []).filter(Boolean);

function backup(tag) {
  const bak = IG_STORE + '.bak-measure' + (tag ? '-' + tag : '') + '-'
    + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  fs.copyFileSync(IG_STORE, bak);
  console.log('backup → ' + path.basename(bak));
}
function save() {
  const tmp = IG_STORE + '.tmp-measure';
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
  fs.renameSync(tmp, IG_STORE);
  console.log('ig.json written (' + rows.length + ' rows)');
}

// ══════════════════════════════════════════════════════════════════════════════
// --unmark — undo both halves of a --mark run
// ══════════════════════════════════════════════════════════════════════════════
if (UNMARK) {
  let unq = 0, unbest = 0;
  for (const r of rows) {
    if (!r) continue;
    // Only rows this script queued: it always stashes prevFiles alongside, and it
    // never clears localFiles, so a row marked by the DOWNLOAD path (which stashes
    // no prevFiles) is left alone.
    if (r.needsFullRes && r.measureMarked) {
      delete r.needsFullRes; delete r.measureMarked; delete r.prevFiles;
      unq++;
    }
    // Only the INFERRED bests. A resBest the proxy proved by refusing a downgrade
    // carries no resBestVia and must survive.
    if (r.resBest && r.resBestVia === 'infer') {
      delete r.resBest; delete r.resBestVia; delete r.resBestAt;
      unbest++;
    }
  }
  console.log('un-queued ' + unq + ' row(s) marked for re-fetch');
  console.log('cleared   ' + unbest + ' inferred resBest stamp(s)');
  console.log('(dlW/dlH/dlMinW are measurements, not marks — they are left in place)');
  if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --unmark --apply.'); process.exit(0); }
  if (unq || unbest) { backup('unmark'); save(); } else console.log('nothing to undo.');
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════════════════════
// --sweep — after the grind: delete the files a re-fetch superseded
// ══════════════════════════════════════════════════════════════════════════════
if (SWEEP) {
  const toDelete = [], inPlace = [], stillQueued = [], noReplacement = [];
  for (const r of rows) {
    if (!r || !Array.isArray(r.prevFiles) || !r.prevFiles.length) continue;
    if (r.needsFullRes) { stillQueued.push(r); continue; }        // grind not done with it
    const now = filesOf(r);
    // Never delete anything unless the CURRENT files are all verifiably on disk.
    // A row whose re-fetch failed and left nothing must keep what it had.
    if (!now.length || !now.every(f => fs.existsSync(path.join(MEDIA, f)))) { noReplacement.push(r); continue; }
    // A re-fetch that came back at the same W×H and duration lands under the SAME
    // name and overwrote in place — those entries ARE the live files. Deleting by
    // prevFiles alone would delete the row's own media.
    const olds = r.prevFiles.filter(f => f && !now.includes(f) && fs.existsSync(path.join(MEDIA, f)));
    if (!olds.length) { inPlace.push(r); continue; }
    toDelete.push({ r, olds });
  }
  const nFiles = toDelete.reduce((n, x) => n + x.olds.length, 0);
  let bytes = 0;
  for (const x of toDelete) for (const f of x.olds) { try { bytes += fs.statSync(path.join(MEDIA, f)).size; } catch (_) {} }
  console.log('\n' + (APPLY ? 'SWEEPING' : 'DRY RUN (nothing deleted — pass --apply)') + '\n');
  console.log('rows carrying prevFiles          : ' + (toDelete.length + inPlace.length + stillQueued.length + noReplacement.length));
  console.log('  superseded files to DELETE     : ' + nFiles + ' from ' + toDelete.length + ' row(s)  ·  '
    + (bytes / 1048576).toFixed(1) + ' MB');
  console.log('  overwritten in place / refused : ' + inPlace.length + '  (nothing to delete — bookkeeping cleared)');
  console.log('  still queued for re-fetch      : ' + stillQueued.length + '  (left completely alone)');
  console.log('  no verified replacement        : ' + noReplacement.length + '  (left completely alone)');
  if (toDelete.length) {
    console.log('\nexamples:');
    toDelete.slice(0, 8).forEach(x => console.log('  ' + (x.r.author || '?') + '  ' + x.r.id
      + '  →  ' + x.olds[0].slice(0, 80) + (x.olds.length > 1 ? '  (+' + (x.olds.length - 1) + ')' : '')));
  }
  if (!APPLY) { console.log('\nNothing was changed. Re-run with --sweep --apply.\n'); process.exit(0); }

  backup('sweep');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const manifest = ['igMeasure.js --sweep --apply   ' + new Date().toISOString(),
    'deleting ' + nFiles + ' file(s) superseded by a completed re-fetch', ''];
  let del = 0, delFail = 0, freed = 0;
  for (const { r, olds } of toDelete) {
    for (const f of olds) {
      const p = path.join(MEDIA, f);
      let sz = 0; try { sz = fs.statSync(p).size; } catch (_) {}
      try {
        fs.unlinkSync(p); del++; freed += sz;
        manifest.push('DELETED  ' + r.id + '\n  file: ' + f + '\n  now:  ' + filesOf(r).join(' | '));
      } catch (e) {
        delFail++; manifest.push('FAILED   ' + r.id + ' — ' + e.message + '\n  file: ' + f);
        if (delFail <= 5) console.warn('  delete failed: ' + f + ' — ' + e.message);
      }
    }
    delete r.prevFiles; delete r.measureMarked;
  }
  for (const r of inPlace) { delete r.prevFiles; delete r.measureMarked; }
  const mPath = path.join(DIR, 'ig.json.measure-swept-' + stamp + '.txt');
  try { fs.writeFileSync(mPath, manifest.join('\n') + '\n'); } catch (_) {}
  console.log('\ndeleted ' + del + ' superseded file(s)' + (delFail ? ' (' + delFail + ' failed)' : '')
    + '  ·  ' + (freed / 1048576).toFixed(1) + ' MB freed');
  console.log('receipt → ' + path.basename(mPath));
  save();
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════════════════════
// measure
// ══════════════════════════════════════════════════════════════════════════════
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')) || {}; } catch (_) { cache = {}; }
let cacheDirty = 0;
const saveCache = () => {
  if (!cacheDirty) return;
  try { fs.writeFileSync(CACHE, JSON.stringify(cache)); cacheDirty = 0; } catch (_) {}
};
process.on('SIGINT', () => { saveCache(); console.log('\ninterrupted — measurements so far are cached.'); process.exit(130); });

// Every distinct file an ig.json row points at, measured ONCE even if two rows
// share it (they should not, but a mis-filed stray can make it so).
let targets = rows.filter(r => r && filesOf(r).length);
if (LIMIT) targets = targets.slice(0, LIMIT);
const wanted = [];
const seen = new Set();
for (const r of targets) for (const f of filesOf(r)) if (!seen.has(f)) { seen.add(f); wanted.push(f); }

const dims = new Map();           // subpath → {w,h} | null (unreadable) | undefined (missing)
const missing = [];
let hits = 0, probed = 0, unreadable = 0, done = 0;
const t0 = Date.now();

async function measureOne(sub) {
  const full = path.join(MEDIA, sub);
  let st;
  try { st = fs.statSync(full); } catch (_) { missing.push(sub); return; }
  const key = sub + '|' + st.size + '|' + Math.round(st.mtimeMs);
  const c = cache[key];
  if (c !== undefined) {
    hits++;
    dims.set(sub, c ? { w: c[0], h: c[1] } : null);
    if (!c) unreadable++;
    return;
  }
  const d = VIDEO_EXT.test(sub) ? await ffprobeDims(full) : imageDims(full);
  probed++;
  if (!d || !d.w || !d.h) unreadable++;
  dims.set(sub, d && d.w && d.h ? d : null);
  cache[key] = d && d.w && d.h ? [d.w, d.h] : 0;
  if (++cacheDirty >= 2000) saveCache();
}

async function runPool(items, n, worker) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      await worker(items[k]);
      if (++done % 1000 === 0) {
        const pct = (done / items.length * 100).toFixed(0);
        process.stdout.write('  measured ' + done + '/' + items.length + '  (' + pct + '%, '
          + ((Date.now() - t0) / 1000).toFixed(0) + 's)\r');
      }
    }
  }));
}

(async () => {
  console.log('\nmeasuring ' + wanted.length + ' file(s) across ' + targets.length + ' downloaded row(s)'
    + '  ·  ' + JOBS + ' parallel ffprobe' + (Object.keys(cache).length ? '  ·  cache warm' : ''));
  await runPool(wanted, JOBS, measureOne);
  saveCache();
  process.stdout.write(' '.repeat(70) + '\r');
  console.log('  cached ' + hits + '  ·  probed ' + probed + '  ·  unreadable ' + unreadable
    + '  ·  file missing ' + missing.length + '  ·  ' + ((Date.now() - t0) / 1000).toFixed(0) + 's\n');

  // ── stamp ───────────────────────────────────────────────────────────────────
  // Same aggregation as proxy.js publish(): max W, max H, min W over the READABLE
  // items only. A row with nothing readable is left exactly as it is.
  const stat = { stamped: 0, changed: 0, same: 0, noneReadable: 0, allMissing: 0 };
  const below = { p: [], reel: [], tv: [], '?': [] };
  const atOrAbove = [];
  const widthHist = new Map();
  for (const r of targets) {
    const fs_ = filesOf(r);
    const good = fs_.map(f => dims.get(f)).filter(d => d && d.w > 0 && d.h > 0);
    if (!good.length) {
      if (fs_.every(f => !dims.has(f))) stat.allMissing++; else stat.noneReadable++;
      continue;
    }
    const maxW = Math.max(...good.map(d => d.w));
    const maxH = Math.max(...good.map(d => d.h));
    const minW = Math.min(...good.map(d => d.w));
    if (r.dlW === maxW && r.dlH === maxH && r.dlMinW === minW) stat.same++;
    else { if (r.dlW > 0) stat.changed++; stat.stamped++; }
    r._newDims = { maxW, maxH, minW, nGood: good.length, nFiles: fs_.length };
    widthHist.set(minW, (widthHist.get(minW) || 0) + 1);
    (minW < RES_TARGET_W ? below[kindOf(r)] : atOrAbove).push(r);
  }

  // ── mark plan ───────────────────────────────────────────────────────────────
  const hasVideo = r => filesOf(r).some(f => VIDEO_EXT.test(f));
  const skip = r => r.status === 'promoted' || r.dead || (!INCLUDE_STUCK && r.refetchStuck)
                 || (VIDEO_ONLY && !hasVideo(r));
  const queue = below.p.filter(r => !skip(r) && !r.needsFullRes);
  const queueSkipped = below.p.filter(skip);
  const alreadyQueued = below.p.filter(r => !skip(r) && r.needsFullRes);
  const bestable = NO_REELS_BEST ? [] : below.reel.concat(below.tv)
    .filter(r => !r.resBest && !(r.status === 'promoted' || r.dead));   // --video-only never gates the reels: they are all video
  const staleBest = atOrAbove.filter(r => r.resBest);

  const byAuthor = list => {
    const m = {};
    list.forEach(r => { const a = r.author || '?'; m[a] = (m[a] || 0) + 1; });
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0] + '=' + e[1]).join(' ');
  };

  console.log((APPLY ? 'APPLYING' : 'DRY RUN (nothing written — pass --apply)') + '\n');
  console.log('MEASURED');
  console.log('  rows stamped with dlW/dlH/dlMinW : ' + stat.stamped
    + '   (' + stat.changed + ' had different values before, ' + stat.same + ' already correct)');
  if (stat.noneReadable) console.log('  no readable item → left alone    : ' + stat.noneReadable);
  if (stat.allMissing) console.log('  every file MISSING from disk     : ' + stat.allMissing + '   (a dev0660 case — left alone)');

  console.log('\nRESOLUTION (by narrowest item, target ' + RES_TARGET_W + 'px wide)');
  console.log('  at or above target : ' + atOrAbove.length);
  console.log('  below target /p    : ' + below.p.length + '   ' + byAuthor(below.p));
  console.log('  below target reel  : ' + below.reel.length + '   ' + byAuthor(below.reel));
  if (below.tv.length) console.log('  below target tv    : ' + below.tv.length);
  if (below['?'].length) console.log('  below target, unknown kind : ' + below['?'].length + '   (left alone — no /p or /reel url)');
  const hist = [...widthHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log('  commonest widths   : ' + hist.map(e => e[0] + 'px×' + e[1]).join('  '));

  console.log('\nMARK PLAN' + (MARK ? '' : '   (--mark not passed — reported only)'));
  console.log('  /p → queue for re-fetch (needsFullRes + prevFiles) : ' + queue.length
    + '   [' + queue.filter(hasVideo).length + ' with video, ' + queue.filter(r => !hasVideo(r)).length + ' stills only]');
  if (alreadyQueued.length) console.log('  /p already queued, prevFiles stashed now          : ' + alreadyQueued.length);
  if (queueSkipped.length) console.log('  /p skipped ('
    + (VIDEO_ONLY ? 'stills-only — --video-only' : 'promoted / dead' + (INCLUDE_STUCK ? '' : ' / refetchStuck')) + ') : ' + queueSkipped.length);
  console.log('  reel+tv → stamp resBest (INFERRED, see header)     : ' + bestable.length
    + (NO_REELS_BEST ? '   [--no-reels-best: skipping]' : ''));
  if (staleBest.length) console.log('  resBest dropped — row is at target after all      : ' + staleBest.length);

  if (!APPLY) {
    console.log('\nNothing was written. Re-run with --apply' + (MARK ? ' --mark' : '') + ' to do it.');
    console.log('(measurements are cached, so the next run skips straight to the stamping)\n');
    process.exit(0);
  }

  // ── write ───────────────────────────────────────────────────────────────────
  backup(MARK ? 'mark' : '');
  const now = stampNow();
  let stamped = 0;
  for (const r of targets) {
    if (!r._newDims) continue;
    const d = r._newDims; delete r._newDims;
    r.dlW = d.maxW; r.dlH = d.maxH; r.dlMinW = d.minW;
    r.measuredAt = now;
    // Mirrors ig.js:2461 — a row proven to be at target cannot also be "as good as
    // IG gets, which is worse than target".
    if (r.dlMinW >= RES_TARGET_W && r.resBest) { delete r.resBest; delete r.resBestVia; delete r.resBestAt; }
    stamped++;
  }
  console.log('stamped ' + stamped + ' row(s) with measured dlW/dlH/dlMinW — the dev0690 downgrade guard is now armed for them');

  if (MARK) {
    let q = 0;
    for (const r of queue.concat(alreadyQueued)) {
      // prevFiles is the sweep list, not a restore point: localFiles is deliberately
      // left in place so keepPixels (ig.js:2387) is non-zero for these rows.
      r.prevFiles = filesOf(r).slice();
      r.needsFullRes = true;
      r.measureMarked = now;          // so --unmark can tell ours from the grind's
      delete r.refetchedAt;
      q++;
    }
    let b = 0;
    for (const r of bestable) { r.resBest = 1; r.resBestVia = 'infer'; r.resBestAt = now; b++; }
    console.log('queued  ' + q + ' /p row(s) for full-res re-fetch (localFiles kept, prevFiles stashed for --sweep)');
    console.log('stamped ' + b + ' reel/tv row(s) resBest (inferred — undo with --unmark)');
  }
  save();

  console.log('\nNEXT: ' + (MARK
    ? 'I screen ▸ Re-fetch ▸ needs full-res ▸ Download+rotate, then `node igMeasure.js --sweep` to\n'
      + '      see what the re-fetch superseded, and --sweep --apply to remove it.'
    : 'add --mark to queue the /p rows and clear the reels out of the ⚠ low filter.') + '\n');
})();
