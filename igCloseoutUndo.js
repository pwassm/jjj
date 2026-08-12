#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// igCloseoutUndo.js — (dev0803) UNDO a ✅ Finish queue closeout. Puts every row
// the closeout retired back into the ⤓ re-fetch queue. Touches no media.
// ══════════════════════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS. ig.js's ✅ Finish queue ends the re-fetch backlog by stamping
// every row still queued `resBest` + `resBestVia:'closeout'`. That stamp is the
// one resBest provenance that is NOT a measurement — it records a decision, not
// evidence — so unlike 'probe' / 'audit' / a proven re-download it must be
// reversible. dev0802 shipped without a way back, and the first run needed one:
// the user pressed ⏹ Stop ten downloads in, meaning "pause", and step 2 read it
// as "so be it" and retired the other 157 rows. dev0803 makes an interrupted run
// ASK; this script is the repair for a closeout that has already happened.
//
// It is exact, not approximate. `resBestVia === 'closeout'` names precisely the
// rows that button retired — no other code path writes that value — so nothing
// concluded by 🔬 Probe video res ('probe'), 🔎 Probe re-fetch / igResAudit
// ('audit'), igMeasure ('infer') or a refused re-download (no via) is disturbed.
//
// WHAT IT RESTORES, per row:
//   resBest / resBestVia / resBestAt / resBestDecl   deleted
//   needsFullRes                                     set → back in the ⤓ queue
//   refetchedAt / fullResTries                       deleted (it was never
//                                                    re-fetched; start the
//                                                    3-try allowance clean)
//   auditUp                                          restored where the page
//                                                    audit had run and was not
//                                                    blind to the row
//
// That last one is a reconstruction, and this is why it is sound: 🔎 Probe
// re-fetch CONCLUDES the at-max rows (they leave as resBestVia:'audit'), so a
// row that was still queued when the closeout found it and carries an `auditAt`
// was, by that audit's own verdict, upgradeable-or-partial — which is exactly
// what auditUp means. Rows the audit could not answer for (`auditVideo` — IG's
// logged-out page caps video at 720) never carried the marker and do not get one.
// probeUp is NOT reconstructed: the video probe writes probeGain/probeGainW
// alongside it, so a genuine ⬆ is still visible in the drawer, and inventing the
// flag from a stale comparison would outrank a fresher verdict.
//
// A row whose closeout stamp was already cleared by a later ≥1080 download (see
// ig.js downloadRow: dlMinW >= RES_TARGET_W → delete resBest) is not in the set
// and is correctly left alone.
//
//   node igCloseoutUndo.js                 report only — writes nothing
//   node igCloseoutUndo.js --apply         write (backs ig.json up first)
//   node igCloseoutUndo.js --apply <path>  a different store
//
// The store is written in the proxy's canonical on-disk shape (one row per
// JSON.stringify(row, null, 2) block, nested two spaces, atomic tmp+rename —
// see igStoreWriteRows in proxy.js), so the file the proxy next reads is
// byte-shaped exactly as it writes them. RELOAD the I screen afterwards (↻, or
// reload the page) — a browser holding the old rows would save them back.
// ══════════════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FILE = path.resolve(args.find(a => !a.startsWith('--')) || path.join(__dirname, 'ig.json'));

let raw;
try { raw = fs.readFileSync(FILE, 'utf8'); }
catch (e) { console.error(`✗ cannot read ${FILE}\n  ${e.message}`); process.exit(1); }

const rows = JSON.parse(raw);
if (!Array.isArray(rows)) { console.error('✗ not a row array — is that ig.json?'); process.exit(1); }

const hit = rows.filter(r => r && r.resBestVia === 'closeout');
const stamps = [...new Set(hit.map(r => r.resBestAt).filter(Boolean))].sort();
const byAuthor = Object.entries(hit.reduce((m, r) => (m[r.author || '?'] = (m[r.author || '?'] || 0) + 1, m), {}))
  .sort((a, b) => b[1] - a[1]);

console.log(`${FILE}`);
console.log(`  rows                ${rows.length.toLocaleString()}`);
console.log(`  ⤓ queued now        ${rows.filter(r => r && r.needsFullRes).length}`);
console.log(`  closeout stamps     ${hit.length}${stamps.length ? `   (${stamps[0]}${stamps.length > 1 ? ` … ${stamps[stamps.length - 1]}` : ''})` : ''}`);
if (!hit.length) { console.log('\nNothing to undo — no row carries resBestVia:"closeout".'); process.exit(0); }
console.log(`  authors             ${byAuthor.slice(0, 8).map(e => '@' + e[0] + '=' + e[1]).join('  ')}`
  + (byAuthor.length > 8 ? `  +${byAuthor.length - 8} more` : ''));

let auditRestored = 0;
for (const r of hit) {
  delete r.resBest; delete r.resBestVia; delete r.resBestAt; delete r.resBestDecl;
  r.needsFullRes = true;
  delete r.refetchedAt; delete r.fullResTries; delete r.refetchStuck;
  if (r.auditAt && !r.auditVideo) { r.auditUp = 1; auditRestored++; }
}
console.log(`\n  → ${hit.length} row(s) back in the ⤓ queue  ·  ⬆ ${auditRestored} audit marker(s) restored`);

if (!APPLY) { console.log('\n(report only — re-run with --apply to write)'); process.exit(0); }

const bak = FILE.replace(/\.json$/i, '') + '.bak-closeout-' + Date.now() + '.json';
fs.writeFileSync(bak, raw);
// Canonical shape, streamed a row at a time (peak allocation is one row, not the
// whole 80MB file) and swapped in atomically — same contract as proxy.js.
const tmp = FILE + '.tmp-undo';
let fd = null;
try {
  fd = fs.openSync(tmp, 'w');
  fs.writeSync(fd, '[\n');
  for (let i = 0; i < rows.length; i++) {
    const body = JSON.stringify(rows[i], null, 2).split('\n').map(l => '  ' + l).join('\n');
    fs.writeSync(fd, i ? ',\n' + body : body);
  }
  fs.writeSync(fd, '\n]');
  fs.closeSync(fd); fd = null;
  fs.renameSync(tmp, FILE);
} catch (e) {
  if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  try { fs.unlinkSync(tmp); } catch (_) {}
  console.error(`✗ write failed — ${FILE} is UNCHANGED\n  ${e.message}\n  (a browser or the proxy may be holding it open)`);
  process.exit(1);
}
console.log(`✓ written  ·  backup: ${bak}`);
console.log('  Now RELOAD the I screen (↻ Reload, or reload the page) before touching anything —');
console.log('  a browser still holding the old rows would save them straight back.');
