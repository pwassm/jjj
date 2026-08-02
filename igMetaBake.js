#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// igMetaBake.js — (dev0707) bake the PUBLIC site's IG aspect/duration lookup.
// Entirely offline: no network, no proxy, no VPN, no Instagram. Reads files.
// ══════════════════════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS. dev0699 made the G grid fit an IG embed to the post's REAL
// aspect instead of assuming 4:5, and got that aspect from ig.json — via POST
// /ig/meta on the 127.0.0.1:8081 proxy. That is a LOCAL-ONLY route, and ig.json
// is 77 MB and gitignored, so on sealifeandmore.com the lookup could never work.
// Two separate symptoms came out of that one fact:
//
//   1. THE BROWSER PROMPT. video.js igMetaFetch fired the POST regardless of
//      host, so the public page asked a loopback address for data — and Firefox
//      (and Chrome 138+) now gate exactly that behind a Local Network Access
//      permission: "sealifeandmore.com wants to access other apps and services
//      on this device." Every viewer opening any IG grid got it, forever, on a
//      request that could not have succeeded anyway.
//   2. THE CAPTION LEAK. The blocked request left _igMetaCache empty, so
//      _igMediaNatH fell back to its 4:5 guess. For "IG tardigrades 2026-08-01"
//      ten of the twelve posts are square (640×640 / 720×720) and two are 16:9,
//      so the fallback over-estimated the media box on ALL TWELVE, cover-fit
//      under-scaled, and IG's like/caption/footer strip showed inside the cell.
//      Identical on localhost, where the proxy answers — hence "works local,
//      not on slam.com".
//
// THE FIX is to ship the handful of numbers the public site actually needs as a
// same-origin static file. Only shortcodes REFERENCED by c.json (grid configs)
// or ml.json (rows) are baked — 198 of ig.json's 22,971 — so this is ~10 KB, not
// 77 MB, and it carries nothing ig.json wouldn't already have made public the
// moment the post appeared in a grid.
//
// The payload matches proxy.js igMeta()'s reply EXACTLY ({ok, meta:{id:{dur,
// embed,w,h}}}) so video.js can consume either source with no branching beyond
// where it fetched from.
//
// ── running it ────────────────────────────────────────────────────────────────
//
//   node igMetaBake.js            → writes igmeta.json, prints a coverage report
//   node igMetaBake.js --check    → reports only, writes nothing (CI / pre-commit)
//
// RE-RUN IT whenever a new IG post lands in a c.json config or an ml.json row —
// i.e. after building an IG collection — then commit igmeta.json with c.json. An
// unbaked post is not an error: it degrades to exactly the dev0699 fallback.
//
// One 77 MB JSON.parse, in a process that exits immediately after. Deliberately
// a one-shot CLI and not a proxy route: the proxy's repeated parses of this same
// store are what exhausted system commit in dev0697, and a script that writes a
// TRACKED file must be run on purpose, never as a side effect of viewing a grid.
// ══════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const ROOT     = __dirname;
const IG_STORE = path.join(ROOT, 'ig.json');
const C_STORE  = path.join(ROOT, 'c.json');
const ML_STORE = path.join(ROOT, 'ml.json');
const OUT      = path.join(ROOT, 'igmeta.json');

const CHECK_ONLY = process.argv.includes('--check');

// Same shapes getInstagramKind() accepts on the client: /p/, /reel/, /reels/ and
// /tv/, with or without the author segment in front. Kept deliberately loose —
// over-collecting a shortcode costs ~40 bytes, missing one costs a leaked caption.
const IG_LINK = /instagram\.com\/(?:[^/\s"'\\]+\/)?(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/g;

function scrapeIds(text, into) {
  IG_LINK.lastIndex = 0;
  let m;
  while ((m = IG_LINK.exec(text)) !== null) into.add(m[1]);
  return into;
}

function main() {
  // c.json and ml.json are scraped as RAW TEXT, not walked as objects. The link
  // fields differ per store (c.json cells are bare strings keyed 1a..3i, ml.json
  // rows carry `link` plus URLs inside ftext) and a regex over the file catches
  // every one of them without either schema having to be known here.
  const bySource = {};
  const wanted = new Set();
  for (const [file, label] of [[C_STORE, 'c.json'], [ML_STORE, 'ml.json']]) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) { console.error('  ! cannot read ' + label + ': ' + e.message); continue; }
    const mine = scrapeIds(raw, new Set());
    bySource[label] = mine;
    mine.forEach(id => wanted.add(id));
    console.log('  ' + label.padEnd(8) + ' → ' + mine.size + ' shortcode(s)');
  }
  if (!wanted.size) {
    console.log('No Instagram links in c.json or ml.json — nothing to bake.');
    return;
  }

  let rows;
  try { rows = JSON.parse(fs.readFileSync(IG_STORE, 'utf8')); }
  catch (e) {
    console.error('! cannot read ig.json (' + e.message + ') — is this the dev box?');
    process.exit(1);
  }
  if (!Array.isArray(rows)) { console.error('! ig.json is not an array'); process.exit(1); }

  // Only the four fields proxy.js igMeta() publishes. Nothing else from the row
  // travels to the public site — no local paths, no download state, no ttxt.
  const meta = Object.create(null);
  for (const r of rows) {
    if (!r || !r.id || !wanted.has(r.id)) continue;
    meta[r.id] = {
      dur:   Number(r.durSecs) || 0,
      embed: (r.embed === 0 || r.embed === 1) ? r.embed : null,
      w:     Number(r.width)  || 0,
      h:     Number(r.height) || 0
    };
  }

  const have  = Object.keys(meta);
  const sized = have.filter(id => meta[id].w > 0 && meta[id].h > 0);

  // Coverage is reported PER SOURCE because only one of them is a real target.
  // c.json is where IG lives (grid LINK cells) and must read 100%. ml.json's IG
  // links are mostly rows the harvester never saw — they were falling back to
  // 4:5 before this script existed and still do, so a low number there is the
  // status quo, not a regression. The loose IG_LINK regex also scrapes a few
  // truncated URLs out of ml.json ftext ("…/p/C"), which land here as permanent
  // misses; that is the intended trade (see the regex comment).
  console.log('');
  for (const label of Object.keys(bySource)) {
    const ids = [...bySource[label]];
    const hit = ids.filter(id => meta[id]);
    const flag = (label === 'c.json' && hit.length === ids.length) ? '  ✓ grids fully covered' : '';
    console.log('  ' + label.padEnd(8) + ' ' + hit.length + '/' + ids.length + ' in ig.json' + flag);
  }
  console.log('  baked      ' + have.length + ' posts, ' + sized.length + ' with real W×H  ← the ones that fix the fit');
  if (bySource['c.json']) {
    const miss = [...bySource['c.json']].filter(id => !meta[id]);
    if (miss.length) {
      console.log('  ! GRID posts absent from ig.json — these will still leak IG caption:');
      console.log('    ' + miss.join(', '));
    }
  }

  if (CHECK_ONLY) { console.log('\n--check: nothing written.'); return; }

  // Sorted keys so re-baking an unchanged set produces a byte-identical file and
  // git sees no diff — this lands next to c.json in the same commits.
  const sortedMeta = {};
  for (const id of have.sort()) sortedMeta[id] = meta[id];
  const payload = {
    ok: true,
    note: 'Generated by igMetaBake.js — do not hand-edit. Source: ig.json (local only).',
    built: new Date().toISOString().replace('T', ' ').slice(0, 19),
    count: have.length,
    meta: sortedMeta
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1), 'utf8');
  const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
  console.log('\n✓ wrote igmeta.json — ' + have.length + ' posts, ' + kb + ' KB. Commit it with c.json.');
}

main();
