#!/usr/bin/env node
// igMarkLowRes.js — (dev0677) one-time triage of the cropped-cover downloads.
//
// dev0677 fixed pickIgFullCover, which had degraded to handing back og:image — IG's
// CENTRE-CROPPED 640² thumbnail — for every single-item photo /p post. This script
// sorts the damage already on disk into two piles, by reading each file's REAL pixel
// dimensions (header bytes, no network):
//
//   SMALL  (long edge <= --cut, default 640)  → MARKED for a full-res re-fetch:
//        status → 'enriched', localFiles stashed to prevFiles and cleared (that is what
//        makes the I screen offer the row to Download sel / Download+rotate again),
//        needsFullRes = true (the I screen's re-fetch filter). The file stays on disk
//        until the replacement lands, so a stalled grind loses nothing.
//   BIGGER (long edge > --cut)               → MOVED to ig_media/<--folder> for review,
//        untouched otherwise. Their rows keep localFiles pointing at the old name, so
//        moving files back restores the status quo exactly.
//
// Usage:
//   node igMarkLowRes.js --dry                 report only (default: nothing is written)
//   node igMarkLowRes.js --apply               do it
//   node igMarkLowRes.js --apply --cut 640 --folder lowResDi
//   node igMarkLowRes.js --unmark              undo the marking (restores localFiles/status)
//   node igMarkLowRes.js --finish [--apply]    close the job out, once the re-fetch grind
//                                              has run and the review folder is approved:
//        (a) DELETE each superseded low-res file whose full-res replacement is verified on
//            disk under a DIFFERENT name — a row that came back under the SAME name was
//            overwritten in place, so there is nothing to delete and deleting would hit
//            the live file; those are skipped and only their bookkeeping is cleared.
//        (b) move ig_media/<folder> back into ig_media/ and mark those rows reviewed-OK
//            (clears lowResDl → the ⚠ in the W×H cell, sets coverOk).
//
// DO NOT run with the I screen open: it persists whole rows and would clobber this.
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const IG_STORE = path.join(DIR, 'ig.json');
const MEDIA = path.join(DIR, 'ig_media');

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const APPLY = has('--apply'), UNMARK = has('--unmark'), FINISH = has('--finish');
const CUT = +val('--cut', 640);
const FOLDER = val('--folder', 'lowResDi');

// ── real pixel size from header bytes (JPEG / WebP / PNG / GIF) ────────────────
function dimsOf(file) {
  let buf, n;
  try {
    buf = Buffer.alloc(65536);
    const fd = fs.openSync(file, 'r');
    n = fs.readSync(fd, buf, 0, 65536, 0);
    fs.closeSync(fd);
  } catch (_) { return null; }
  const b = buf.slice(0, n);
  if (b.length < 24) return null;
  if (b[0] === 0xff && b[1] === 0xd8) {                      // JPEG
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

const rows = JSON.parse(fs.readFileSync(IG_STORE, 'utf8'));
const backup = () => {
  const bak = IG_STORE + '.bak-marklowres-' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  fs.copyFileSync(IG_STORE, bak);
  console.log('backup → ' + path.basename(bak));
};
const save = () => {
  const tmp = IG_STORE + '.tmp-marklowres';
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
  fs.renameSync(tmp, IG_STORE);
};

// ── undo ──────────────────────────────────────────────────────────────────────
if (UNMARK) {
  let n = 0;
  for (const r of rows) {
    if (!r || !r.needsFullRes) continue;
    if (r.prevFiles && r.prevFiles.length) { r.localFiles = r.prevFiles; delete r.prevFiles; }
    if (r.prevStatus) { r.status = r.prevStatus; delete r.prevStatus; }
    delete r.needsFullRes;
    n++;
  }
  console.log('unmarked ' + n + ' row(s)' + (APPLY ? '' : ' (DRY RUN — add --apply)'));
  if (APPLY && n) { backup(); save(); }
  return;
}

// ── finish: delete superseded files + restore the review folder ───────────────
if (FINISH) {
  const dir = path.join(MEDIA, FOLDER);
  const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');

  // (a) superseded low-res originals
  const done = rows.filter(r => r && r.prevFiles && r.prevFiles.length && !r.needsFullRes);
  const toDelete = [], sameName = [], unsafe = [];
  for (const r of done) {
    const nf = (r.localFiles || [])[0];
    if (!nf || !fs.existsSync(path.join(MEDIA, nf))) { unsafe.push(r); continue; }   // no verified replacement
    const olds = r.prevFiles.filter(n => n !== nf && fs.existsSync(path.join(MEDIA, n)));
    if (r.prevFiles.includes(nf)) { sameName.push(r); continue; }                    // overwritten in place
    if (!olds.length) { sameName.push(r); continue; }                                // nothing left to remove
    toDelete.push({ r, olds });
  }
  const nFiles = toDelete.reduce((n, x) => n + x.olds.length, 0);
  console.log('SUPERSEDED low-res originals');
  console.log('  rows re-fetched with prevFiles : ' + done.length);
  console.log('  files to DELETE                : ' + nFiles + ' (from ' + toDelete.length + ' rows)');
  console.log('  same filename → overwritten already, nothing to delete: ' + sameName.length);
  if (unsafe.length) console.log('  NO verified replacement → left completely alone: ' + unsafe.length);

  // (b) the review folder
  let inFolder = [];
  try { inFolder = fs.readdirSync(dir).filter(n => !n.startsWith('.')); } catch (_) {}
  const byName = new Map();
  for (const r of rows) for (const n of (r.localFiles || [])) if (!byName.has(n)) byName.set(n, r);
  const collide = inFolder.filter(n => fs.existsSync(path.join(MEDIA, n)));
  // Only files an ig.json row actually points at go back. Anything else in there is the
  // user's own doing (e.g. a hand-made "… - Copy.jpg" from reviewing) — never move or
  // delete those; leave them where they are and say so.
  const unref = inFolder.filter(n => !byName.has(n));
  const movable = inFolder.filter(n => byName.has(n) && !fs.existsSync(path.join(MEDIA, n)));
  console.log('\nREVIEW FOLDER ig_media/' + FOLDER);
  console.log('  files to move back : ' + movable.length + (collide.length ? '  (' + collide.length + ' name collisions LEFT in place)' : ''));
  if (unref.length) console.log('  unreferenced (yours — left in the folder): ' + unref.length + '  e.g. ' + unref[0].slice(0, 70));
  const rowsOk = [...new Set(inFolder.map(n => byName.get(n)).filter(Boolean))];
  console.log('  rows to mark reviewed-OK : ' + rowsOk.length);

  if (!APPLY) { console.log('\nDRY RUN — nothing deleted, moved or written. Re-run with --finish --apply.'); return; }
  backup();

  let del = 0, delFail = 0;
  for (const { r, olds } of toDelete) {
    for (const n of olds) {
      try { fs.unlinkSync(path.join(MEDIA, n)); del++; }
      catch (e) { delFail++; if (delFail < 5) console.warn('  delete failed: ' + n + ' — ' + e.message); }
    }
    delete r.prevFiles; delete r.prevStatus;
  }
  for (const r of sameName) { delete r.prevFiles; delete r.prevStatus; }
  console.log('deleted ' + del + ' superseded file(s)' + (delFail ? ' (' + delFail + ' failed)' : ''));

  let mv = 0, mvFail = 0;
  for (const n of movable) {
    const from = path.join(dir, n), to = path.join(MEDIA, n);
    if (fs.existsSync(to)) continue;
    try { fs.renameSync(from, to); mv++; }
    catch (e) { mvFail++; if (mvFail < 5) console.warn('  move failed: ' + n + ' — ' + e.message); }
  }
  for (const r of rowsOk) { delete r.lowResDl; r.coverOk = 1; r.coverOkAt = nowStr; }
  save();
  console.log('moved ' + mv + ' file(s) back into ig_media/' + (mvFail ? ' (' + mvFail + ' failed)' : ''));
  console.log('marked ' + rowsOk.length + ' row(s) reviewed-OK (lowResDl cleared, coverOk set)');
  try { if (!fs.readdirSync(dir).length) { fs.rmdirSync(dir); console.log('removed the now-empty ' + FOLDER + '/'); } } catch (_) {}
  return;
}

// ── triage ────────────────────────────────────────────────────────────────────
const targets = rows.filter(r => r && r.lowResDl && (r.localFiles || []).length);
const small = [], big = [], unreadable = [], gone = [];
for (const r of targets) {
  const f = path.join(MEDIA, r.localFiles[0]);
  if (!fs.existsSync(f)) { gone.push(r); continue; }
  const d = dimsOf(f);
  if (!d || !d.w) { unreadable.push(r); continue; }
  (Math.max(d.w, d.h) <= CUT ? small : big).push({ r, d });
}
const byAuthor = list => {
  const m = {};
  list.forEach(x => { const a = (x.r || x).author || '?'; m[a] = (m[a] || 0) + 1; });
  return Object.entries(m).sort((a, b) => b[1] - a[1]).map(e => e[0] + '=' + e[1]).join(' ');
};
console.log('lowResDl rows with a file: ' + targets.length + '  (cut = long edge <= ' + CUT + 'px)');
console.log('  SMALL  → mark for re-fetch : ' + small.length + '   ' + byAuthor(small));
console.log('  BIGGER → move to ' + FOLDER.padEnd(12) + ': ' + big.length + '   ' + byAuthor(big));
if (unreadable.length) console.log('  unreadable headers (left alone): ' + unreadable.length);
if (gone.length) console.log('  file already missing (left alone): ' + gone.length);
if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); return; }

backup();

// 1. mark the small ones
let marked = 0;
for (const { r } of small) {
  r.prevFiles = r.localFiles.slice();
  r.prevStatus = r.status;
  delete r.localFiles;                 // isDownloaded() is localFiles-based → re-offers the row
  r.status = 'enriched';               // enriched = has title/dims, ready to download
  r.needsFullRes = true;
  marked++;
}
save();
console.log('marked ' + marked + ' row(s) for full-res re-fetch (ig.json written)');

// 2. move the bigger ones out for review
const dest = path.join(MEDIA, FOLDER);
try { fs.mkdirSync(dest, { recursive: true }); } catch (_) {}
let moved = 0, failed = 0;
for (const { r } of big) {
  for (const name of r.localFiles) {
    const from = path.join(MEDIA, name), to = path.join(dest, name);
    try { if (fs.existsSync(from)) { fs.renameSync(from, to); moved++; } }
    catch (e) { failed++; if (failed < 5) console.warn('  move failed: ' + name + ' — ' + e.message); }
  }
}
console.log('moved ' + moved + ' file(s) → ig_media/' + FOLDER + (failed ? ' (' + failed + ' failed)' : ''));
console.log('\nThose rows still point at their files by name, so moving them back into ig_media/ restores everything.');
