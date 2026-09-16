#!/usr/bin/env node
// igNameDims.js — (dev0993) rename ig_media files so the ~WxH~ in each name is that
// FILE's own pixel size, and repoint ig.json at the new names.
//
// WHY: until dev0993 proxy.js publish() stamped item 1's size on every file of a
// carousel. Checked 2026-09-16: 8,992 image files across 3,318 posts carried the
// wrong W×H (e.g. 19 files named ~3277x4096~ that are really 1200x1500), while
// single-item posts were right (33 wrong out of 33,447). New downloads now name
// each file with its own size; this brings the back catalogue in line.
//
// WHAT CHANGES: only the W×H field of the basename — hh.mm.ss~WxH~Title~@author~[[i[id]]]
//   [N of M].ext. Folder, duration, title, id and item suffix are untouched, so the
//   file stays beside its siblings and every [[i[id]]] match still works. The row's
//   localFiles entry follows the file; a prevFiles entry naming the same file follows
//   too (so a later igMeasure.js --sweep still recognises it as the row's live file).
//   ig.json.measure-cache.json keys are carried over (a rename keeps size + mtime).
//   r.width/r.height/dlW/dlH are NOT touched — they were measured, not read off names.
//
// MEASURED LIKE THE PROXY: header bytes for stills (parseImageDims, copied from
//   proxy.js), ffprobe v:0 width/height for video. Unreadable files keep their name.
//
// SAFE TO RE-RUN: an entry already right is skipped. Files are renamed BEFORE ig.json
//   is saved, so an interrupted run leaves rows on old names whose file now carries a
//   new W×H — a re-run finds that sibling (same name except W×H, claimed by no row)
//   and just repoints. A destination that already exists, or one file claimed by two
//   rows, is left on its old name and listed — still a valid pointer, never a loss.
//
// Usage:
//   node igNameDims.js                  report only — nothing is written (default)
//   node igNameDims.js --apply          back up ig.json, rename, rewrite ig.json
//   options: --jobs N (ffprobe concurrency, default 8) · --limit N (rows, test run)
//
// DO NOT run --apply with the I screen open: it saves whole rows and would put the old
// names back. The run checks ig.json's mtime and refuses to rename or save if the app
// wrote it meanwhile. Undo: ig.json.bak-namedims-<stamp>.tsv lists every rename
// (row id, old, new); the matching ig.json.bak-namedims-<stamp> is the pre-run ig.json.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DIR = __dirname;
const IG_STORE = path.join(DIR, 'ig.json');
const MEDIA = path.join(DIR, 'ig_media');
const CACHE = path.join(DIR, 'ig.json.measure-cache.json');

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const APPLY = argv.includes('--apply');
const JOBS = Math.max(1, Math.min(32, +val('--jobs', 8) || 8));
const LIMIT = Math.max(0, +val('--limit', 0) || 0);

const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v)$/i;
const NAME_RE = /^(\d{2}\.\d{2}\.\d{2}~)(\d+)x(\d+)(~.*)$/;

// ── real pixel size (same two paths as proxy.js _probeMediaDimsUncached) ─────
// parseImageDims: verbatim from proxy.js (dev0513).
function parseImageDims(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47)
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8 ' && buf.length >= 30) {
      const w = buf.readUInt16LE(26) & 0x3FFF, hgt = buf.readUInt16LE(28) & 0x3FFF;
      if (w && hgt) return { width: w, height: hgt };
    } else if (fmt === 'VP8L' && buf.length >= 25 && buf[20] === 0x2F) {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3FFF) + 1, height: ((b >> 14) & 0x3FFF) + 1 };
    } else if (fmt === 'VP8X' && buf.length >= 30) {
      return { width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1,
               height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1 };
    }
    return null;
  }
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xFF) { off++; continue; }
      let marker = buf[off + 1];
      while (marker === 0xFF && off + 2 < buf.length) { off++; marker = buf[off + 1]; }
      if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { off += 2; continue; }
      const len = buf.readUInt16BE(off + 2);
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC)
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      off += 2 + len;
    }
  }
  return null;
}
function imageDims(file) {
  try {
    const buf = Buffer.alloc(65536);
    const fd = fs.openSync(file, 'r');
    const n = fs.readSync(fd, buf, 0, 65536, 0);
    fs.closeSync(fd);
    const d = parseImageDims(buf.slice(0, n));
    return d && d.width && d.height ? { w: d.width, h: d.height } : null;
  } catch (_) { return null; }
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
async function runPool(items, n, worker) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await worker(items[i++]);
  }));
}

// ── load ──────────────────────────────────────────────────────────────────────
const storeMtime = () => fs.statSync(IG_STORE).mtimeMs;
const loadedMtime = storeMtime();
const rows = JSON.parse(fs.readFileSync(IG_STORE, 'utf8'));
if (!Array.isArray(rows)) { console.error('ig.json is not an array — aborting.'); process.exit(1); }
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')) || {}; } catch (_) { cache = {}; }

// Every referenced subpath (lower-cased — NTFS is case-insensitive) → the row ids
// holding it, over ALL rows, so --limit can't hide a second claimant.
const claims = new Map();
for (const r of rows) for (const f of (Array.isArray(r && r.localFiles) ? r.localFiles : [])) {
  if (!f) continue;
  const k = f.toLowerCase();
  if (!claims.has(k)) claims.set(k, []);
  claims.get(k).push(r.id);
}

let targets = rows.filter(r => r && Array.isArray(r.localFiles) && r.localFiles.length);
if (LIMIT) targets = targets.slice(0, LIMIT);

const entries = [];       // { row, idx, sub, dir, base, m, carousel }
let noField = 0;
for (const r of targets) {
  r.localFiles.forEach((sub, idx) => {
    if (!sub) return;
    const base = sub.split('/').pop();
    const m = base.match(NAME_RE);
    if (!m) { noField++; return; }
    entries.push({ row: r, idx, sub, dir: sub.slice(0, sub.length - base.length), base, m,
                   carousel: r.localFiles.length > 1 });
  });
}

// ── measure ───────────────────────────────────────────────────────────────────
const folderListing = new Map();
const listFolder = dir => {
  if (!folderListing.has(dir)) {
    let names = [];
    try { names = fs.readdirSync(path.join(MEDIA, dir)); } catch (_) {}
    folderListing.set(dir, names);
  }
  return folderListing.get(dir);
};

let ok = 0, unreadable = 0, cacheHits = 0, probed = 0, done = 0;
const plan = [], rescued = [], missing = [], collisions = [], dupSources = [];
const destSeen = new Map();
const t0 = Date.now();

async function check(e) {
  const full = path.join(MEDIA, e.sub);
  let st = null;
  try { st = fs.statSync(full); } catch (_) {}
  if (!st) {
    // Rescue: an interrupted --apply renamed the file but never saved ig.json.
    const cands = listFolder(e.dir).filter(nm => {
      if (nm === e.base) return false;
      const m2 = nm.match(NAME_RE);
      return m2 && m2[1] === e.m[1] && m2[4] === e.m[4] && !claims.has((e.dir + nm).toLowerCase());
    });
    if (cands.length === 1) rescued.push({ e, to: e.dir + cands[0] });
    else missing.push(`${e.row.id}  ${e.sub}${cands.length > 1 ? `  (${cands.length} candidates — left alone)` : ''}`);
    return;
  }
  const key = e.sub + '|' + st.size + '|' + Math.round(st.mtimeMs);
  let d;
  const c = cache[key];
  if (c !== undefined) { cacheHits++; d = c ? { w: c[0], h: c[1] } : null; }
  else {
    probed++; d = VIDEO_EXT.test(e.sub) ? await ffprobeDims(full) : imageDims(full);
    cache[key] = d && d.w && d.h ? [d.w, d.h] : 0;   // same format igMeasure.js writes
  }
  if (++done % 5000 === 0) process.stdout.write(`  measured ${done}/${entries.length}\r`);
  if (!d || !d.w || !d.h) { unreadable++; return; }
  if (d.w === +e.m[2] && d.h === +e.m[3]) { ok++; return; }
  const to = e.dir + e.m[1] + d.w + 'x' + d.h + e.m[4];
  const toKey = to.toLowerCase();
  const holders = claims.get(e.sub.toLowerCase()) || [];
  if (holders.length > 1) { dupSources.push(`${e.sub}  claimed by ${holders.join(' AND ')}`); return; }
  if (fs.existsSync(path.join(MEDIA, to)) || claims.has(toKey)) { collisions.push(`${e.sub}  →  ${to}  (already exists)`); return; }
  if (destSeen.has(toKey)) { collisions.push(`${e.sub}  →  ${to}  (same dest as ${destSeen.get(toKey)})`); return; }
  destSeen.set(toKey, e.sub);
  plan.push({ e, to, cacheKey: key, cacheVal: c !== undefined ? c : [d.w, d.h], size: st.size, mtime: Math.round(st.mtimeMs) });
}

(async () => {
  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN (nothing written — pass --apply to do it)'}`
    + `${LIMIT ? `  ·  --limit ${LIMIT}` : ''}  ·  ${JOBS} parallel ffprobe\n`);
  await runPool(entries, JOBS, check);
  // Plan in row order, so the journal reads post by post.
  const order = new Map(rows.map((r, i) => [r, i]));
  plan.sort((a, b) => (order.get(a.e.row) - order.get(b.e.row)) || (a.e.idx - b.e.idx));

  const vids = plan.filter(p => VIDEO_EXT.test(p.e.sub)).length;
  const posts = new Set(plan.map(p => p.e.row.id)).size;
  const singles = plan.filter(p => !p.e.carousel).length;
  console.log(`rows with files         : ${targets.length}`);
  console.log(`files checked           : ${entries.length}   (${cacheHits} from measure cache, ${probed} read now, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  console.log(`already right           : ${ok}`);
  console.log(`to rename               : ${plan.length}   in ${posts} posts  (${plan.length - vids} images, ${vids} videos; ${singles} single-item)`);
  console.log(`repoint-only (rescue)   : ${rescued.length}`);
  console.log(`unreadable (left alone) : ${unreadable}`);
  console.log(`no W×H field in name    : ${noField}`);
  console.log(`referenced but ABSENT   : ${missing.length}`);
  console.log(`dest already exists     : ${collisions.length}   (left on old name)`);
  console.log(`one file, two rows      : ${dupSources.length}   (left on old name)`);
  if (plan.length) {
    console.log('\nexamples:');
    plan.slice(0, 8).forEach(p => console.log(`  ${p.e.row.id}  ${p.e.m[2]}x${p.e.m[3]} → ${p.to.split('/').pop().match(NAME_RE).slice(2, 4).join('x')}   ${p.e.base.slice(0, 70)}`));
  }
  if (collisions.length) { console.log('\nDEST EXISTS:'); collisions.slice(0, 15).forEach(x => console.log('  ' + x)); }
  if (dupSources.length) { console.log('\nONE FILE, TWO ROWS:'); dupSources.slice(0, 15).forEach(x => console.log('  ' + x)); }
  if (missing.length) { console.log('\nREFERENCED BUT ABSENT:'); missing.slice(0, 15).forEach(x => console.log('  ' + x)); }

  if (!APPLY) {
    // Measurements only (keyed path|size|mtime, the igMeasure.js cache) — makes --apply fast.
    if (probed) { try { fs.writeFileSync(CACHE, JSON.stringify(cache)); } catch (_) {} }
    console.log('\nNo file or ig.json was changed. Close the I screen, then: node igNameDims.js --apply\n');
    return;
  }
  if (!plan.length && !rescued.length) { console.log('\nNothing to do.\n'); return; }
  if (storeMtime() !== loadedMtime) {
    console.error('\nig.json was written while this ran (the app is open?). Nothing renamed — close the I screen and re-run.\n');
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${IG_STORE}.bak-namedims-${stamp}`;
  fs.copyFileSync(IG_STORE, backup);
  const journal = backup + '.tsv';
  fs.writeFileSync(journal, 'id\told\tnew\n' + plan.map(p => `${p.e.row.id}\t${p.e.sub}\t${p.to}`).join('\n') + '\n');
  console.log(`\nig.json backed up → ${path.basename(backup)}`);
  console.log(`rename journal    → ${path.basename(journal)}`);

  const repoint = (r, idx, from, to) => {
    r.localFiles[idx] = to;
    if (Array.isArray(r.prevFiles)) r.prevFiles = r.prevFiles.map(f => f === from ? to : f);
  };
  for (const x of rescued) repoint(x.e.row, x.e.idx, x.e.sub, x.to);

  let renamed = 0, failed = 0;
  for (const p of plan) {
    try {
      fs.renameSync(path.join(MEDIA, p.e.sub), path.join(MEDIA, p.to));
      repoint(p.e.row, p.e.idx, p.e.sub, p.to);
      delete cache[p.cacheKey];
      cache[p.to + '|' + p.size + '|' + p.mtime] = p.cacheVal;
      renamed++;
    } catch (err) {
      failed++;
      if (failed <= 10) console.warn(`  RENAME FAILED ${p.e.sub}: ${err.message}`);
    }
  }

  if (storeMtime() !== loadedMtime) {
    console.error(`\nig.json was written by something else during the renames — NOT saving over it.`
      + `\n${renamed} file(s) were renamed. Close the I screen and re-run: it repoints them without renaming again.\n`);
    process.exit(1);
  }
  const tmpStore = IG_STORE + '.tmp-namedims';
  fs.writeFileSync(tmpStore, JSON.stringify(rows, null, 2));
  fs.renameSync(tmpStore, IG_STORE);
  try { fs.writeFileSync(CACHE, JSON.stringify(cache)); } catch (_) {}
  console.log(`renamed ${renamed} file(s)${failed ? `, ${failed} FAILED (their rows keep the old name)` : ''}`);
  if (rescued.length) console.log(`repointed ${rescued.length} entry/entries renamed by an earlier run`);
  console.log(`ig.json rewritten (${rows.length} rows)\n`);
})();
