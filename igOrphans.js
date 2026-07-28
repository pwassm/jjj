#!/usr/bin/env node
// igOrphans.js — (dev0690) triage the files sitting loose in ig_media/ that no ig.json
// row points at.
//
// WHERE THEY CAME FROM: dev0689 moved every REFERENCED file into ig_media/<author>/ and
// deliberately left the unreferenced ones in the base directory, on the grounds that
// unreferenced files are exactly what a human should look at rather than have buried.
// 286 of them stayed behind. They are not junk in general — most are earlier copies of
// files that were later re-downloaded under a slightly different name (the filename
// encodes duration and W×H, so any change to either mints a new name and orphans the
// old one), and a handful are carousel items that never made it into their row.
//
// WHAT THIS DOES: for each orphan, find its TWIN — the file an ig.json row does point at
// for the same post — and compare them by REAL PIXELS (ffprobe for video, header bytes
// for stills), never by file size. A 720p progressive h264 is routinely a bigger file
// than the 1080p VP9 that supersedes it, so a byte comparison keeps the worse copy.
//
//   IDENTICAL  twin exists, same bytes            → DELETE the orphan (pure duplicate)
//   WORSE      twin exists, orphan has fewer px   → DELETE the orphan
//   BETTER     twin exists, orphan has more px    → REPLACE: the orphan takes the twin's
//                                                   name and place; the row is untouched
//                                                   because the name doesn't change
//   SAME-SIZE  twin exists, equal px, different   → left alone and listed (a re-encode;
//              bytes                                nothing here can say which is better)
//   NO TWIN    the row holds nothing comparable    → left alone (--file moves it in and
//              for this item                         records it — see the warning below)
//   AMBIGUOUS  the row holds a carousel of a       → left alone. "[2 of 5]" and "[2 of 6]"
//              DIFFERENT length                      are not the same picture.
//   NO ROW     no ig.json row for the shortcode   → left alone and listed
//
// Every orphan's post is identified by the `[[i[SHORTCODE]]]` field its filename carries,
// and its position within that post by the " [i of N]" suffix — both from the AHK naming
// convention — so matching never depends on the rest of the name.
//
// ON --file: the dev0689 hand-off called the no-twin strays "carousel items missing from
// their row". Measured, they are not: every one is an item-1 file from an OLDER download
// generation whose row later re-downloaded under a different name (bare vs "[1 of 2]").
// Recording those would give a two-item post two copies of item 1 and still no item 2.
// So filing is OFF by default. The real repair for those rows is a re-download: dev0690
// records the post's item count, notices that fewer files landed than the post has, and
// re-queues the row automatically.
//
// Usage:
//   node igOrphans.js                 report only — nothing is written (default)
//   node igOrphans.js --apply         back up ig.json, then delete the duplicates and
//                                     lower-res copies, and promote the higher-res ones
//   node igOrphans.js --apply --file  …and ALSO move the no-twin strays into their author
//                                     folder and append them to the row (read the warning)
//
// DO NOT run with the I screen open: it persists whole rows and would clobber the
// ig.json edits (the same hazard igFolderByAuthor.js and igMarkLowRes.js carry).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const IG_STORE = path.join(DIR, 'ig.json');
const MEDIA = path.join(DIR, 'ig_media');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const DO_FILE = argv.includes('--file');   // off by default — see the header

// Author → folder name. MUST stay byte-identical to igFolderByAuthor.js's folderFor()
// and proxy.js's igAuthorFolder(), or a filed stray lands beside its siblings instead
// of among them. (The one difference is deliberate and matches igFolderByAuthor.js: an
// empty author becomes '_noauthor' here rather than the base directory.)
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
function folderFor(author) {
  let s = String(author || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  if (!s) s = '_noauthor';
  if (RESERVED.test(s)) s = '_' + s;
  return s.slice(0, 100);
}

// ── real pixel size ───────────────────────────────────────────────────────────
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v)$/i;
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
const _dimCache = new Map();
function dimsOf(file) {
  if (_dimCache.has(file)) return _dimCache.get(file);
  let d = null;
  if (VIDEO_EXT.test(file)) {
    try {
      const raw = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file],
        { encoding: 'utf8', timeout: 20000 }).trim();
      const m = raw.match(/(\d+)x(\d+)/);
      if (m) d = { w: +m[1], h: +m[2] };
    } catch (_) {}
  } else d = imageDims(file);
  _dimCache.set(file, d);
  return d;
}
const _hashCache = new Map();
function hashOf(file) {
  if (_hashCache.has(file)) return _hashCache.get(file);
  let h = null;
  try { h = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'); } catch (_) {}
  _hashCache.set(file, h);
  return h;
}
const sizeOf = f => { try { return fs.statSync(f).size; } catch (_) { return -1; } };

// ── load ──────────────────────────────────────────────────────────────────────
const rows = JSON.parse(fs.readFileSync(IG_STORE, 'utf8'));
if (!Array.isArray(rows)) { console.error('ig.json is not an array — aborting.'); process.exit(1); }

const rootFiles = fs.readdirSync(MEDIA, { withFileTypes: true }).filter(d => d.isFile()).map(d => d.name);
const referenced = new Set();
const rowById = new Map();
for (const r of rows) {
  if (!r) continue;
  if (r.id) rowById.set(r.id, r);
  for (const f of (Array.isArray(r.localFiles) ? r.localFiles : [])) if (f) referenced.add(f);
}
const orphans = rootFiles.filter(n => !referenced.has(n));

// The post a file belongs to, from the `[[i[SHORTCODE]]]` field of the AHK name.
const scOf = n => { const m = String(n).match(/\[\[i\[([A-Za-z0-9_-]+)\]\]\]/); return m ? m[1] : ''; };
// …and WHICH ITEM of that post, from the " [i of N]" suffix a carousel download gets.
// This is what makes the twin match per-SLOT. Without it, all six orphans of a six-item
// carousel resolve to the row's single best file and a replace pass would rename them
// onto one path, one after another, destroying five of them.
const slotOf = n => { const m = String(n).match(/\[(\d+) of (\d+)\]\s*\.[^.]+$/); return m ? { i: +m[1], n: +m[2] } : null; };

// ── classify ──────────────────────────────────────────────────────────────────
const identical = [], worse = [], better = [], sameSize = [], noTwin = [], noRow = [], unreadable = [], ambiguous = [];
for (const name of orphans) {
  const src = path.join(MEDIA, name);
  const sc = scOf(name);
  const row = sc ? rowById.get(sc) : null;
  if (!row) { noRow.push({ name, sc }); continue; }

  const files = (Array.isArray(row.localFiles) ? row.localFiles : []).filter(Boolean);
  const onDisk = files.filter(f => fs.existsSync(path.join(MEDIA, f)));

  // Byte-identical to ANY file this row already holds → a pure duplicate, wherever it
  // sits in the carousel. Safe to delete without resolving which slot it is.
  const sSize = sizeOf(src), sHash = hashOf(src);
  const dup = onDisk.find(f => sizeOf(path.join(MEDIA, f)) === sSize && hashOf(path.join(MEDIA, f)) === sHash);
  if (dup) { identical.push({ name, sc, row, twin: dup }); continue; }

  // Not a duplicate → find THIS item's twin, and only this item's.
  const ext = path.extname(name).toLowerCase();
  const slot = slotOf(name);
  const sameExt = onDisk.filter(f => path.extname(f).toLowerCase() === ext);
  let present;
  if (slot) {
    // Same position AND same carousel length. A "[2 of 6]" orphan against a row holding
    // "[2 of 4]" files is a different download of a different length — index 2 is not
    // the same picture, so refuse to guess.
    present = sameExt.filter(f => { const s = slotOf(f.split('/').pop()); return s && s.i === slot.i && s.n === slot.n; });
    if (!present.length && sameExt.some(f => { const s = slotOf(f.split('/').pop()); return s && s.n !== slot.n; })) {
      ambiguous.push({ name, sc, row, slot }); continue;
    }
  } else {
    present = sameExt.filter(f => !slotOf(f.split('/').pop()));
  }
  if (!present.length) { noTwin.push({ name, sc, row }); continue; }

  const sd = dimsOf(src);
  if (!sd) { unreadable.push({ name, sc, row }); continue; }
  // Compare against the best of the (usually single) matching twins.
  let best = null, bestPx = -1;
  for (const f of present) {
    const d = dimsOf(path.join(MEDIA, f));
    const px = d ? d.w * d.h : 0;
    if (px > bestPx) { bestPx = px; best = { f, d }; }
  }
  if (!best || !best.d) { unreadable.push({ name, sc, row }); continue; }
  const srcPx = sd.w * sd.h;
  if (srcPx > bestPx) better.push({ name, sc, row, twin: best.f, sd, td: best.d });
  else if (srcPx < bestPx) worse.push({ name, sc, row, twin: best.f, sd, td: best.d });
  else sameSize.push({ name, sc, row, twin: best.f, sd });
}
// Belt and braces: two orphans must never target the same twin path. If the slot match
// ever lets that through, drop BOTH rather than let one silently destroy the other.
const twinCount = new Map();
for (const x of better) twinCount.set(x.twin, (twinCount.get(x.twin) || 0) + 1);
for (let i = better.length - 1; i >= 0; i--) {
  if (twinCount.get(better[i].twin) > 1) ambiguous.push(Object.assign({ collide: true }, better.splice(i, 1)[0]));
}

// ── report ────────────────────────────────────────────────────────────────────
const byAuthor = list => {
  const m = {};
  list.forEach(x => { const a = (x.row && x.row.author) || '?'; m[a] = (m[a] || 0) + 1; });
  return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 6).map(e => e[0] + '=' + e[1]).join(' ');
};
console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN (nothing written — pass --apply to do it)'}\n`);
console.log(`files loose in ig_media/ : ${rootFiles.length}`);
console.log(`of those, unreferenced   : ${orphans.length}\n`);
console.log(`  IDENTICAL to a twin → DELETE   : ${identical.length}   ${byAuthor(identical)}`);
console.log(`  LOWER res than twin → DELETE   : ${worse.length}   ${byAuthor(worse)}`);
console.log(`  HIGHER res than twin → REPLACE : ${better.length}   ${byAuthor(better)}`);
console.log(`  same res, different bytes      : ${sameSize.length}   (left alone)`);
console.log(`  no comparable twin${DO_FILE ? ' → FILE into author folder' : '             '} : ${noTwin.length}   ${byAuthor(noTwin)}${DO_FILE ? '' : '   (left alone — --file to move them in)'}`);
console.log(`  ambiguous slot match           : ${ambiguous.length}   (left alone — see below)`);
console.log(`  no ig.json row at all          : ${noRow.length}   (left alone)`);
console.log(`  unreadable headers             : ${unreadable.length}   (left alone)`);

if (better.length) {
  console.log('\nHIGHER-RES orphans (these REPLACE the file the row points at):');
  better.slice(0, 15).forEach(x => console.log(
    `  ${x.sd.w}x${x.sd.h} over ${x.td.w}x${x.td.h}   ${x.name.slice(0, 78)}`));
  if (better.length > 15) console.log(`  … and ${better.length - 15} more`);
}
if (ambiguous.length) {
  console.log('\nAMBIGUOUS (the row holds a DIFFERENT-length carousel, or two orphans claim one');
  console.log('twin — index 2 of 6 is not index 2 of 4, so nothing is touched):');
  ambiguous.slice(0, 12).forEach(x => console.log(
    `  ${x.row.author}  ${x.sc}  row has ${(x.row.localFiles || []).length} file(s)${x.collide ? '  [twin collision]' : ''}   ${x.name.slice(0, 58)}`));
  if (ambiguous.length > 12) console.log(`  … and ${ambiguous.length - 12} more`);
}
if (noTwin.length) {
  console.log('\nNO COMPARABLE TWIN — the row has files, but none for this item. Usually an');
  console.log('item-1 file from an older download generation, NOT a missing item (see header):');
  noTwin.slice(0, 15).forEach(x => console.log(
    `  ${x.row.author}  ${x.sc}  row has ${(x.row.localFiles || []).length} file(s)   ${x.name.slice(0, 58)}`));
  if (noTwin.length > 15) console.log(`  … and ${noTwin.length - 15} more`);
}
if (sameSize.length) {
  console.log('\nSAME RESOLUTION, different bytes (a re-encode — decide by eye):');
  sameSize.slice(0, 10).forEach(x => console.log(`  ${x.sd.w}x${x.sd.h}   ${x.name.slice(0, 78)}`));
  if (sameSize.length > 10) console.log(`  … and ${sameSize.length - 10} more`);
}
if (noRow.length) {
  console.log('\nNO ROW (nothing in ig.json claims this shortcode):');
  noRow.slice(0, 10).forEach(x => console.log(`  ${x.sc || '(no shortcode in name)'}   ${x.name.slice(0, 70)}`));
  if (noRow.length > 10) console.log(`  … and ${noRow.length - 10} more`);
}

if (!APPLY) {
  console.log('\nNothing was changed. Re-run with --apply to delete/replace/file.\n');
  process.exit(0);
}

// ── apply ─────────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.join(DIR, `ig.json.bak-orphans-${stamp}`);
fs.copyFileSync(IG_STORE, backup);
console.log(`\nig.json backed up → ${path.basename(backup)}`);

let del = 0, delFail = 0;
for (const x of identical.concat(worse)) {
  try { fs.unlinkSync(path.join(MEDIA, x.name)); del++; }
  catch (e) { delFail++; if (delFail <= 5) console.warn(`  delete failed: ${x.name} — ${e.message}`); }
}
console.log(`deleted ${del} duplicate/lower-res orphan(s)${delFail ? ` (${delFail} failed)` : ''}`);

// REPLACE: the orphan moves onto the twin's exact path, so no row changes. Rename over
// the target rather than unlink-then-rename — nothing is destroyed until the better copy
// is in place, and rename overwrites on every platform Node supports.
let rep = 0, repFail = 0;
for (const x of better) {
  const from = path.join(MEDIA, x.name), to = path.join(MEDIA, x.twin);
  try { fs.renameSync(from, to); rep++; }
  catch (e) { repFail++; if (repFail <= 5) console.warn(`  replace failed: ${x.name} — ${e.message}`); }
}
console.log(`replaced ${rep} row file(s) with a higher-res orphan${repFail ? ` (${repFail} failed)` : ''}`);

// FILE: a carousel item its row never recorded. Move it into the author's folder and
// append the relative subpath, matching the layout every other entry uses.
let filed = 0, fileFail = 0;
if (DO_FILE) {
  for (const x of noTwin) {
    const folder = folderFor(x.row.author);
    const to = path.join(MEDIA, folder, x.name);
    try {
      fs.mkdirSync(path.join(MEDIA, folder), { recursive: true });
      if (fs.existsSync(to)) { fileFail++; console.warn(`  name already taken in ${folder}/: ${x.name.slice(0, 60)}`); continue; }
      fs.renameSync(path.join(MEDIA, x.name), to);
      if (!Array.isArray(x.row.localFiles)) x.row.localFiles = [];
      x.row.localFiles.push(folder + '/' + x.name);
      filed++;
    } catch (e) { fileFail++; if (fileFail <= 5) console.warn(`  file failed: ${x.name} — ${e.message}`); }
  }
  console.log(`filed ${filed} stray item(s) into their author folder and into ig.json${fileFail ? ` (${fileFail} skipped)` : ''}`);
}

if (filed) {
  const tmpStore = IG_STORE + '.tmp-orphans';
  fs.writeFileSync(tmpStore, JSON.stringify(rows, null, 2));
  fs.renameSync(tmpStore, IG_STORE);
  console.log(`ig.json rewritten (${rows.length} rows)`);
} else {
  console.log('ig.json unchanged (no rows needed a new file reference)');
}
console.log('');
