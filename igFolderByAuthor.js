#!/usr/bin/env node
// igFolderByAuthor.js — reshape ig_media/ from one flat 25k-file directory into
// one subdirectory per harvested author, and repoint ig.json at the new paths.
//
// WHY: 25,717 files in a single folder makes Explorer crawl and manual use painful.
// There are only 25 distinct authors, so this yields ~25 tidy folders (19 of them
// hold 100+ files) rather than a long tail of near-empty ones.
//
// WHAT MOVES: ig_media/<name>  →  ig_media/<author>/<name>
//   and the row's localFiles entry becomes the RELATIVE SUBPATH "<author>/<name>".
//   Storing the subpath (rather than re-deriving the folder from row.author at read
//   time) keeps every entry self-describing: it survives an author rename, and it
//   stays correct for a collab post whose files were harvested under one account.
//   Every Node consumer already does path.join(MEDIA, name), which handles a
//   subpath unchanged — see igCoverAudit.js, igGrindAudit.js, igMarkLowRes.js.
//
// WHAT STAYS PUT: files on disk with no ig.json row (286 orphans). They are left in
//   the base directory deliberately — unreferenced files are exactly what a human
//   should look at, and hiding them inside an author folder would bury them.
//   Rows with NO localFiles (3,767, nearly all status 'new') have nothing on disk
//   at all, so there is nothing to move for them.
//
// IDEMPOTENT: an entry that already contains "/" is treated as migrated and skipped,
//   so an interrupted run can simply be re-run.
//
// Usage:
//   node igFolderByAuthor.js              report only — nothing is written (default)
//   node igFolderByAuthor.js --apply      back up ig.json, move files, rewrite ig.json
//   node igFolderByAuthor.js --apply --tmp    also delete leftover .tmp_* crash debris
//
// DO NOT run with the I screen open: it persists whole rows and would clobber this
// (same hazard igMarkLowRes.js carries).
//
// NOTE: igMarkLowRes.js's review-folder mechanic assumes the FLAT layout — it moves
// files to ig_media/<folder> while rows keep bare names, and its --finish moves them
// back. Do not run that dev0677 one-shot after this migration.
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const IG_STORE = path.join(DIR, 'ig.json');
const MEDIA = path.join(DIR, 'ig_media');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const DO_TMP = argv.includes('--tmp');

// Author → folder name. Windows forbids <>:"/\|?* and chokes on trailing dot/space;
// the reserved device names (CON, PRN, ...) are illegal even with an extension.
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
function folderFor(author) {
  let s = String(author || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  if (!s) s = '_noauthor';
  if (RESERVED.test(s)) s = '_' + s;
  return s.slice(0, 100);
}

const rows = JSON.parse(fs.readFileSync(IG_STORE, 'utf8'));
if (!Array.isArray(rows)) { console.error('ig.json is not an array — aborting.'); process.exit(1); }

const onDisk = new Set(fs.readdirSync(MEDIA, { withFileTypes: true }).filter(d => d.isFile()).map(d => d.name));

const plan = [];            // { row, idx, from, to, folder }  — needs a move
const rescued = [];         // { row, idx, to }                — already moved, just repoint
const destSeen = new Map(); // dest subpath -> source name (two sources → one dest)
const srcSeen = new Map();  // source name  -> row id      (one file claimed by two rows)
let alreadyMigrated = 0, missingOnDisk = 0, rowsTouched = 0;
const byFolder = new Map();
const collisions = [], dupSources = [], missing = [];

for (const r of rows) {
  if (!r || !Array.isArray(r.localFiles) || !r.localFiles.length) continue;
  let touched = false;
  r.localFiles.forEach((name, idx) => {
    if (!name) return;
    if (name.includes('/') || name.includes('\\')) { alreadyMigrated++; return; }
    const folder = folderFor(r.author);
    const dest = folder + '/' + name;
    if (!onDisk.has(name)) {
      // Not in base. This run moves every file BEFORE saving ig.json, so an interrupted
      // run leaves files at <folder>/<name> with their rows still on bare names. Treat
      // that as ours and repoint without moving. Without this branch a crash between the
      // move loop and the save would strand those rows on dead bare names permanently —
      // a re-run would just call them "missing" and skip them forever.
      if (fs.existsSync(path.join(MEDIA, folder, name))) {
        rescued.push({ row: r, idx, to: dest });
        touched = true;
        return;
      }
      missingOnDisk++; missing.push(`${r.id}  ${name}`); return;
    }
    // One file referenced by two rows: dests differ if the authors differ, so the dest
    // check below would not catch it, yet the second rename would fail on a vanished
    // source and silently leave that row on a bare name. Catch it up front instead.
    if (srcSeen.has(name)) dupSources.push(`${name}  claimed by ${srcSeen.get(name)} AND ${r.id}`);
    srcSeen.set(name, r.id);
    if (destSeen.has(dest)) collisions.push(`${dest}  <=  ${destSeen.get(dest)} AND ${name}`);
    destSeen.set(dest, name);
    plan.push({ row: r, idx, from: name, to: dest, folder });
    byFolder.set(folder, (byFolder.get(folder) || 0) + 1);
    touched = true;
  });
  if (touched) rowsTouched++;
}

const referenced = new Set();
for (const r of rows) for (const f of (Array.isArray(r.localFiles) ? r.localFiles : [])) if (f) referenced.add(f);
const orphans = [...onDisk].filter(n => !referenced.has(n));
const tmpDirs = fs.readdirSync(MEDIA, { withFileTypes: true }).filter(d => d.isDirectory() && d.name.startsWith('.tmp_')).map(d => d.name);

console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN (nothing written — pass --apply to do it)'}\n`);
console.log(`rows with files      : ${rowsTouched}`);
console.log(`files to move        : ${plan.length}`);
console.log(`folders to create    : ${byFolder.size}`);
console.log(`already migrated     : ${alreadyMigrated}`);
console.log(`repoint-only (rescue): ${rescued.length}`);
console.log(`referenced but ABSENT: ${missingOnDisk}`);
console.log(`orphans left in base : ${orphans.length}`);
console.log(`.tmp_* debris dirs   : ${tmpDirs.length}${DO_TMP ? ' (will delete)' : ' (use --tmp to delete)'}`);
console.log(`dest collisions      : ${collisions.length}`);
console.log(`duplicate sources    : ${dupSources.length}`);

console.log('\nper-folder file counts:');
[...byFolder.entries()].sort((a, b) => b[1] - a[1]).forEach(([f, n]) => console.log(`  ${String(n).padStart(6)}  ${f}`));
if (collisions.length) { console.log('\nCOLLISIONS (two sources → one dest):'); collisions.slice(0, 20).forEach(c => console.log('  ' + c)); }
if (dupSources.length) { console.log('\nDUPLICATE SOURCES (one file, two rows):'); dupSources.slice(0, 20).forEach(d => console.log('  ' + d)); }
if (missing.length)    { console.log('\nREFERENCED BUT ABSENT (left alone):');   missing.slice(0, 20).forEach(m => console.log('  ' + m)); }

if (!APPLY) { console.log('\nNothing was changed.\n'); process.exit(0); }
if (collisions.length || dupSources.length) {
  console.error('\nRefusing to apply: resolve the collisions / duplicate sources above first.\n');
  process.exit(1);
}

// Back up ig.json beside itself before the first write.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.join(DIR, `ig.json.bak-${stamp}`);
fs.copyFileSync(IG_STORE, backup);
console.log(`\nig.json backed up → ${path.basename(backup)}`);

for (const f of byFolder.keys()) fs.mkdirSync(path.join(MEDIA, f), { recursive: true });

// Rows whose file a previous interrupted run already moved: no file op, just repoint.
for (const p of rescued) p.row.localFiles[p.idx] = p.to;

let moved = 0, failed = 0;
for (const p of plan) {
  const src = path.join(MEDIA, p.from);
  const dst = path.join(MEDIA, p.folder, p.from);
  try {
    fs.renameSync(src, dst);
    p.row.localFiles[p.idx] = p.to;      // only repoint what actually moved
    moved++;
  } catch (e) {
    failed++;
    if (failed <= 10) console.warn(`  MOVE FAILED ${p.from}: ${e.message}`);
  }
}

// Atomic-ish save (matches igMarkLowRes.js): a crash mid-write must not shred a
// multi-MB ig.json, and this file is the only pointer to 25k files on disk.
const tmpStore = IG_STORE + '.tmp-folderbyauthor';
fs.writeFileSync(tmpStore, JSON.stringify(rows, null, 2));
fs.renameSync(tmpStore, IG_STORE);
console.log(`moved ${moved} file(s)${failed ? `, ${failed} FAILED (their rows left pointing at the old name)` : ''}`);
if (rescued.length) console.log(`repointed ${rescued.length} row entry/entries already moved by an earlier run`);
console.log(`ig.json rewritten (${rows.length} rows)`);

if (DO_TMP) {
  let rm = 0;
  for (const d of tmpDirs) { try { fs.rmSync(path.join(MEDIA, d), { recursive: true, force: true }); rm++; } catch (_) {} }
  console.log(`removed ${rm} .tmp_* debris dir(s)`);
}
console.log('');
