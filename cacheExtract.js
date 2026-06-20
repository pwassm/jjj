#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// cacheExtract.js — Firefox cache2 entry → clean image / video extractor (dev0451)
// ══════════════════════════════════════════════════════════════════════════════
// Firefox stores each cached HTTP response as ONE extension-less file (named by a
// SHA-1 of the cache key) under  <profile>\cache2\entries\ . The on-disk layout is:
//
//   [ response body ............ ]   <- offset 0 .. metaOffset
//   [ per-chunk hashes (2B each) ]   ┐
//   [ CacheFileMetadataHeader     ]   │ "metadata", starts at metaOffset
//   [ cache key (the URL)         ]   │
//   [ elements (response-head …)  ]   ┘
//   [ metaOffset : uint32 BE      ]   <- the LAST 4 bytes of the file
//
// So a naive copy/rename to .jpg is GARBAGE: it appends the metadata block to the
// image. The fix is to read the last 4 bytes (big-endian) = metaOffset = the true
// body size, and keep ONLY bytes [0, metaOffset). We then magic-sniff that clean
// body to decide image vs video vs junk, and recover the original URL + content-type
// from the metadata (so a saved jpg can be matched back to a web link later).
//
// What it does, per file in the source folder:
//   • body = file[0 .. metaOffset)         (clean, no metadata tail)
//   • sniff magic bytes → jpg/png/gif/webp/bmp/avif/heic  OR  mp4/webm  OR  nothing
//   • image/video  → write  FromCacheOut/<hash>.<ext>  + record url in manifest.json
//   • anything else (gzip'd HTML/JS/JSON, fonts, …) → DELETED  (this is the point:
//     "delete everything not picture or video")
//
// SAFETY: dry-run by DEFAULT — it only PRINTS the breakdown and writes/deletes
// nothing until you pass --apply. So you can eyeball the counts first.
//
// ── Usage ─────────────────────────────────────────────────────────────────────
//   node cacheExtract.js                       # dry-run on ./FromCacheOld
//   node cacheExtract.js --apply               # extract media → FromCacheOut/, keep sources
//   node cacheExtract.js --apply --purge       # …and DELETE the non-media sources
//   node cacheExtract.js --apply --purge --clean-source
//                                              # …and delete the source media too
//                                              #   (FromCacheOld ends up empty)
//   node cacheExtract.js "C:\path\to\some\folder" --apply   # process a different folder
//
// ── Future use: live Firefox-cache monitor ────────────────────────────────────
// Point the source at the LIVE cache and run WITHOUT --purge / --clean-source to
// COPY out every image/mp4 your browsing loaded, never touching the cache itself:
//   node cacheExtract.js "%LOCALAPPDATA%\Mozilla\Firefox\Profiles\<id>\cache2\entries" --apply
// The manifest's url→file map lets SLAM pair a local jpg with the same web link the
// program already stores (so you can keep BOTH the jpg and the web link). Run it on
// a timer/hotkey for a rolling "everything I viewed" jpg/mp4 capture.
// (NOTE: the live cache holds files Firefox is actively writing — read-only/no-purge
// here is deliberate; let Firefox own deletion of its own cache.)
// ══════════════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const path = require('path');

// ── args ──────────────────────────────────────────────────────────────────────
// Drop anything from a "#" token onward so a pasted "# comment" (cmd.exe doesn't
// strip these) can't be mistaken for the source folder.
let argv = process.argv.slice(2);
const hashAt = argv.findIndex(a => a.startsWith('#'));
if (hashAt >= 0) argv = argv.slice(0, hashAt);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const SRC = (argv.find(a => !a.startsWith('--')) || 'FromCacheOld');
const OUT = 'FromCacheOut';
const APPLY = flags.has('--apply');             // actually write/delete (default = dry run)
const PURGE = flags.has('--purge');             // delete the non-media source files
const CLEAN_SOURCE = flags.has('--clean-source'); // delete source files that WERE extracted

// ── magic-byte sniffer → { ext, kind } | null ─────────────────────────────────
// Looks only at the clean body's first bytes. gzip'd responses (1F 8B …) — almost
// all of Firefox's cached text/HTML/JS/JSON — return null and get treated as junk;
// images are never served gzip'd, so we don't bother gunzipping.
function sniff(b) {
  if (b.length < 4) return null;
  const a0 = b[0], a1 = b[1], a2 = b[2], a3 = b[3];
  // ── images ──
  if (a0 === 0xFF && a1 === 0xD8 && a2 === 0xFF) return { ext: 'jpg', kind: 'image' };                 // JPEG
  if (a0 === 0x89 && a1 === 0x50 && a2 === 0x4E && a3 === 0x47) return { ext: 'png', kind: 'image' };  // PNG
  if (a0 === 0x47 && a1 === 0x49 && a2 === 0x46 && a3 === 0x38) return { ext: 'gif', kind: 'image' };  // GIF8
  if (a0 === 0x42 && a1 === 0x4D) return { ext: 'bmp', kind: 'image' };                                // BMP
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP')
    return { ext: 'webp', kind: 'image' };                                                             // WEBP
  // ── ISO-BMFF (…ftyp…): the brand decides image (AVIF/HEIC) vs video (mp4/mov) ──
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') {
    const brand = b.toString('ascii', 8, 12).replace(/[^a-z0-9]/gi, '').toLowerCase();
    const imgBrands = ['avif', 'avis', 'heic', 'heix', 'heif', 'hevc', 'mif1', 'msf1'];
    if (imgBrands.includes(brand)) return { ext: brand.startsWith('av') ? 'avif' : 'heic', kind: 'image' };
    return { ext: 'mp4', kind: 'video' };   // isom / iso2 / mp41 / mp42 / M4V / qt / …
  }
  // ── other video containers ──
  if (a0 === 0x1A && a1 === 0x45 && a2 === 0xDF && a3 === 0xA3) return { ext: 'webm', kind: 'video' };  // Matroska/WebM
  return null;
}

// metaOffset (= clean body size) from the trailing big-endian uint32. Returns null
// when it isn't a plausible cache2 file (then we just sniff the whole file).
function metaOffset(buf) {
  if (buf.length < 8) return null;
  const off = buf.readUInt32BE(buf.length - 4);
  return (off > 0 && off < buf.length) ? off : null;
}

// Recover the request URL from the metadata tail. Version-proof: the cache key always
// contains ":<scheme>://…<NUL>", so we scan for it rather than parsing the binary
// header (whose layout shifts between Firefox versions).
function extractUrl(meta) {
  const s = meta.toString('latin1');
  const m = s.match(/:(https?:\/\/[^\x00]+)/);
  return m ? m[1] : '';
}
function extractContentType(meta) {
  const m = meta.toString('latin1').match(/content-type:\s*([^\r\n\x00]+)/i);
  return m ? m[1].trim() : '';
}

function human(bytes) {
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
}

function main() {
  if (!fs.existsSync(SRC) || !fs.statSync(SRC).isDirectory()) {
    console.error('✗ Source folder not found: ' + path.resolve(SRC));
    process.exit(1);
  }
  const names = fs.readdirSync(SRC).filter(f => {
    try { return fs.statSync(path.join(SRC, f)).isFile(); } catch (_) { return false; }
  });

  if (APPLY && !fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  const stat = { image: 0, video: 0, junk: 0, err: 0, bytesOut: 0, purged: 0, cleaned: 0 };
  const byExt = {};
  const manifest = [];

  for (const name of names) {
    const fp = path.join(SRC, name);
    let buf;
    try { buf = fs.readFileSync(fp); } catch (_) { stat.err++; continue; }

    const off = metaOffset(buf);
    const body = off == null ? buf : buf.subarray(0, off);
    const meta = off == null ? Buffer.alloc(0) : buf.subarray(off);
    const hit = sniff(body);

    if (!hit) {                                   // not picture or video → delete
      stat.junk++;
      if (APPLY && PURGE) { try { fs.unlinkSync(fp); stat.purged++; } catch (_) {} }
      continue;
    }

    const outName = name + '.' + hit.ext;          // hash + ext = stable, collision-free
    stat[hit.kind]++;
    stat.bytesOut += body.length;
    byExt[hit.ext] = (byExt[hit.ext] || 0) + 1;
    manifest.push({
      file: outName, src: name, kind: hit.kind, ext: hit.ext, bytes: body.length,
      url: extractUrl(meta), contentType: extractContentType(meta)
    });

    if (APPLY) {
      try { fs.writeFileSync(path.join(OUT, outName), body); } catch (e) { stat.err++; continue; }
      if (CLEAN_SOURCE) { try { fs.unlinkSync(fp); stat.cleaned++; } catch (_) {} }
    }
  }

  if (APPLY) {
    try { fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2)); } catch (_) {}
  }

  // ── report ──
  const extLine = Object.keys(byExt).sort().map(k => `${byExt[k]} ${k}`).join(' · ') || '—';
  console.log('');
  console.log(`  cacheExtract — ${APPLY ? 'APPLY' : 'DRY-RUN (nothing written/deleted)'}`);
  console.log(`  source:   ${path.resolve(SRC)}   (${names.length} files)`);
  console.log(`  output:   ${path.resolve(OUT)}`);
  console.log('  ' + '─'.repeat(56));
  console.log(`  images:   ${stat.image}`);
  console.log(`  videos:   ${stat.video}`);
  console.log(`  by ext:   ${extLine}`);
  console.log(`  extracted bytes: ${human(stat.bytesOut)}`);
  console.log(`  junk (not media):${stat.junk}${APPLY && PURGE ? `  → ${stat.purged} deleted` : (stat.junk ? '  (use --purge to delete)' : '')}`);
  if (stat.err) console.log(`  read/write errors: ${stat.err}`);
  if (APPLY && CLEAN_SOURCE) console.log(`  source media deleted: ${stat.cleaned}`);
  console.log('  ' + '─'.repeat(56));
  if (!APPLY) {
    console.log(`  Re-run with --apply to extract ${stat.image + stat.video} media file(s) → ${OUT}/`);
    console.log(`  Add --purge to delete the ${stat.junk} non-media source file(s).`);
  } else {
    console.log(`  ✓ Wrote ${stat.image + stat.video} media file(s) + manifest.json → ${OUT}/`);
  }
  console.log('');
}

main();
