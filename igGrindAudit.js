// ══════════════════════════════════════════════════════════════════════════════
// igGrindAudit.js — (dev0683) READ-ONLY diagnosis of why a Download+rotate grind
// stops. Writes NOTHING: no ig.json edit, no backup, no network, no proxy.
// ══════════════════════════════════════════════════════════════════════════════
//
// Two things can end a long grind, and the on-screen report cannot tell them apart:
//   1. the proxy stops answering  → see proxy.log + 🛠 Fix ▸ 🩺 Diagnostics
//   2. rows in ig.json are marked so they can never download → THIS SCRIPT
//
// For (2) the mechanism is in ig.js, and it is worth stating plainly because the
// numbers below only make sense against it:
//
//   • `isReady(r)`  = no localFiles AND status is 'new' or 'enriched' AND not
//     promoted AND not walled-this-session. Download+rotate re-derives the ready
//     list from the VIEW on every round and takes the first 18 — so the head of
//     the view is handed to every round, in the same order, forever.
//   • a download that fails leaves NO mark on the row. status stays 'new', so the
//     row is still ready next round, next run, next week. The only "it failed"
//     memory is `enrichFailed`, a Set in the page that dies on reload.
//   • runBatch stops a download batch after DOWNLOAD_WALL_CAP (2) failures IN A
//     ROW, and batchDownloadRotating stops the WHOLE grind when a batch downloads
//     0. So two unreadable rows at the head of the view end a 2,574-row backlog in
//     under a minute — and end it the same way on every retry.
//
// So: any row that is ready but can never succeed is a permanent trap, and this
// script finds them and shows where they sit in the queue.
//
// Usage (from M:\jjj):
//   node igGrindAudit.js                 → full report, view order = DateAdded desc
//   node igGrindAudit.js --author mimmofotosub     → as if the author filter were set
//   node igGrindAudit.js --status new    → as if the status filter were set
//   node igGrindAudit.js --files         → also stat every downloaded row's files
//   node igGrindAudit.js --diag ig-diag-20260727T2015.txt
//                                        → cross-reference a saved 🩺 Diagnostics
//                                          file: which rows actually failed, how
//                                          often, and whether they are still ready
//
const fs = require('fs');
const path = require('path');

const IG_STORE = path.join(__dirname, 'ig.json');
const IG_MEDIA = path.join(__dirname, 'ig_media');
const ROTATE_CHUNK = 18;          // must match ig.js
const DOWNLOAD_WALL_CAP = 2;      // must match ig.js

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = name => { const i = argv.indexOf('--' + name); return i >= 0 ? (argv[i + 1] || '') : null; };
const has = name => argv.includes('--' + name);
const OPT = {
  author: arg('author'), status: arg('status'), kind: arg('kind'),
  files: has('files'), diag: arg('diag'), limit: +(arg('limit') || 24)
};

// ── load (read-only) ─────────────────────────────────────────────────────────
let rows;
try { rows = JSON.parse(fs.readFileSync(IG_STORE, 'utf8')); }
catch (e) { console.error('cannot read ig.json: ' + e.message); process.exit(1); }
if (!Array.isArray(rows)) { console.error('ig.json is not an array'); process.exit(1); }

const kindOf = r => /\/reel\//i.test(r.url || '') ? 'reel'
                 : /\/p\//i.test(r.url || '') ? 'p'
                 : /\/tv\//i.test(r.url || '') ? 'tv' : '?';
const isDownloaded = r => !!(r.localFiles && r.localFiles.length);
const isReady = r => !!r && !isDownloaded(r) && r.status !== 'promoted'
  && (r.status === 'enriched' || r.status === 'new');
const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : '—';
const H = s => '\n' + s + '\n' + '─'.repeat(s.length);

console.log('igGrindAudit (dev0683) — READ-ONLY. ig.json: ' + rows.length + ' rows, '
  + (fs.statSync(IG_STORE).size / 1048576).toFixed(1) + ' MB');

// ── 1. status + marks ────────────────────────────────────────────────────────
console.log(H('1 · How the rows are marked'));
const st = {};
rows.forEach(r => { st[r.status || '(none)'] = (st[r.status || '(none)'] || 0) + 1; });
Object.entries(st).sort((a, b) => b[1] - a[1])
  .forEach(([k, n]) => console.log(`  ${k.padEnd(12)} ${String(n).padStart(6)}  ${pct(n, rows.length)}`));
const marks = {
  lowResDl: r => r.lowResDl, needsFullRes: r => r.needsFullRes, metaPartial: r => r.metaPartial,
  refetchedAt: r => r.refetchedAt, coverOk: r => r.coverOk !== undefined,
  'embed=1': r => r.embed === 1, 'embed=0': r => r.embed === 0,
  'embed unset': r => r.embed !== 0 && r.embed !== 1,
  'staged=false (single)': r => r.staged === false
};
console.log('  flags:');
Object.entries(marks).forEach(([k, f]) => {
  const n = rows.filter(f).length;
  if (n) console.log(`    ${k.padEnd(22)} ${String(n).padStart(6)}`);
});

// ── 2. marks that contradict each other ──────────────────────────────────────
// Each of these has bitten this project before; they are what "the row is marked
// so it can't download" looks like on disk.
console.log(H('2 · Contradictory marks (a row in a state the grind mishandles)'));
const checks = [
  ['downloaded but NO localFiles (dev0660 false-success)',
    r => r.status === 'downloaded' && !isDownloaded(r)],
  ['promoted but NO localFiles', r => r.status === 'promoted' && !isDownloaded(r)],
  ['has localFiles but status is new/enriched (invisible to Status filters)',
    r => isDownloaded(r) && (r.status === 'new' || r.status === 'enriched')],
  ['enriched but no VidTitle (download will re-enrich, then fail to name the file)',
    r => r.status === 'enriched' && !r.VidTitle],
  ['ready but durSecs null AND width null (never successfully enriched)',
    r => isReady(r) && r.durSecs == null && r.width == null],
  ['metaPartial (downloaded with no DatePosted)', r => r.metaPartial],
  ['needsFullRes still queued (dev0677 re-fetch backlog)', r => r.needsFullRes]
];
let anyIssue = false;
checks.forEach(([label, f]) => {
  const hits = rows.filter(f);
  if (!hits.length) { console.log(`  ok    · ${label}: 0`); return; }
  anyIssue = true;
  console.log(`  ⚠ ${String(hits.length).padStart(5)} · ${label}`);
  console.log('          e.g. ' + hits.slice(0, 6).map(r => r.id).join(', '));
});
if (!anyIssue) console.log('  (nothing contradictory)');

// ── 3. the grind queue, in the order Download+rotate will see it ─────────────
// The I screen sorts by DateAdded desc by default and Download+rotate takes
// `view.filter(isReady)` — so this is the actual firing order. Filters can be
// simulated with --author/--status/--kind.
console.log(H('3 · The grind queue (what Download+rotate will pick, in order)'));
let view = rows.slice();
if (OPT.author) view = view.filter(r => r.author === OPT.author);
if (OPT.status) view = view.filter(r => (r.status || '') === OPT.status);
if (OPT.kind)   view = view.filter(r => kindOf(r) === OPT.kind);
console.log(`  filters: author=${OPT.author || 'all'} status=${OPT.status || 'all'} kind=${OPT.kind || 'all'}`
  + `  → view ${view.length} rows`);
console.log('  NOTE: the sort direction lives in the browser (localStorage slam-ig-filters),');
console.log('  not on disk, so both directions are evaluated. It matters enormously: the');
console.log('  never-enriched rows are the OLDEST ones, so oldest-first hands them to');
console.log('  batch 1 while newest-first buries them behind thousands of fresh rows.');

// "Suspect" = ready, never enriched (no title), and old enough that earlier runs
// must already have tried it. No failure is recorded on the row, so age against
// the newest row in the store is the only evidence available on disk.
const newest = rows.reduce((m, r) => (r.DateAdded > m ? r.DateAdded : m), '');
const daysOld = r => {
  const t = Date.parse((r.DateAdded || '').replace(' ', 'T'));
  const n = Date.parse((newest || '').replace(' ', 'T'));
  return (Number.isFinite(t) && Number.isFinite(n)) ? Math.round((n - t) / 86400000) : 0;
};
const suspect = r => isReady(r) && !r.VidTitle && r.status === 'new' && daysOld(r) > 7;
const readyAll = view.filter(isReady);
const nSuspect = readyAll.filter(suspect).length;
console.log(`\n  ready: ${readyAll.length} rows.  ${nSuspect} of them have survived every past run without`);
console.log(`  ever being enriched (status 'new', no title, added ≥7d before the newest row) —`);
console.log(`  nothing on the row records that they failed, so they are handed back every time.`);

// Simulate the head of the queue in BOTH sort directions and report where the
// documented stop conditions fire: DOWNLOAD_WALL_CAP failures in a row ends the
// batch, and a batch with zero successes ends the whole grind.
function simulate(label, list) {
  console.log(`\n  ── ${label} ──`);
  const shown = Math.min(OPT.limit, list.length);
  list.slice(0, shown).forEach((r, i) => {
    const chunk = Math.floor(i / ROTATE_CHUNK) + 1;
    console.log(`   b${chunk} ${String(i + 1).padStart(3)}. ${suspect(r) ? '⚠' : ' '} ${r.id.padEnd(13)}`
      + ` ${(r.status || '').padEnd(9)} ${kindOf(r).padEnd(4)} @${(r.author || '').padEnd(22)}`
      + ` ${r.VidTitle ? 'title✓' : 'title✗'} ${r.DateAdded || ''}`);
  });
  const firstChunk = list.slice(0, ROTATE_CHUNK);
  let run = 0, stopAt = -1;
  firstChunk.forEach((r, i) => {
    if (suspect(r)) { run++; if (run >= DOWNLOAD_WALL_CAP && stopAt < 0) stopAt = i; } else run = 0;
  });
  if (stopAt >= 0) {
    const okBefore = firstChunk.slice(0, stopAt + 1).filter(r => !suspect(r)).length;
    console.log(`   ⚠ PREDICTION: ${DOWNLOAD_WALL_CAP} suspect rows in a row at position ${stopAt + 1}`
      + ` → batch 1 stops there, after ${okBefore} success(es).`);
    if (okBefore === 0) console.log(`     A batch of 0 ENDS THE WHOLE GRIND — this is the reported failure,`
      + `\n     and it is reproducible: the same two rows lead the queue on every retry.`);
  } else {
    console.log(`   batch 1 has no ${DOWNLOAD_WALL_CAP}-in-a-row suspect pair — it should complete.`);
  }
  // Known-dead rows are not the only exposure. An UNTRIED row (ready, still 'new',
  // never enriched) has to enrich inline before it can download, and a login-walled
  // post fails that step — so any 2 unlucky neighbours end the batch, and a batch
  // that got nothing ends the grind. A long unbroken run of untried rows at the head
  // is therefore how much of the grind is riding on Instagram behaving.
  const untried = r => isReady(r) && r.status === 'new' && !r.VidTitle;
  let head = 0;
  while (head < firstChunk.length && untried(firstChunk[head])) head++;
  const nUntried = firstChunk.filter(untried).length;
  console.log(`   batch 1 composition: ${nUntried}/${firstChunk.length} untried (must enrich inline first)`
    + (head ? `, ${head} of them consecutively from position 1` : ''));
  if (nUntried >= DOWNLOAD_WALL_CAP) {
    console.log(`   → any ${DOWNLOAD_WALL_CAP} consecutive walls among those end batch 1;`
      + ` if none succeed first, the grind ends too.`);
  }
}
const byDate = (a, b) => String(a.DateAdded || '').localeCompare(String(b.DateAdded || ''));
const byAuthor = (a, b) => String(a.author || '').localeCompare(String(b.author || '')) || byDate(b, a);
const ORDERS = {
  'DateAdded ↓ (newest first — the default)': readyAll.slice().sort((a, b) => byDate(b, a)),
  'DateAdded ↑ (oldest first)': readyAll.slice().sort(byDate),
  'Author A→Z': readyAll.slice().sort(byAuthor)
};
Object.entries(ORDERS).forEach(([label, list]) => simulate(label, list));

// The decisive question: under which ordering do the never-enriched rows lead?
// (The last failed run's proxy.log shows @moana_ryukyu leading the queue, so the
// live view was sorted some way that floats them — the new GRIND-START diagnostic
// records the actual sortCol/sortDir, which settles it for the next run.)
const suspects = readyAll.filter(suspect);
if (suspects.length) {
  console.log(`\n  ── where the ${suspects.length} suspect row(s) sit in each order ──`);
  suspects.slice(0, 10).forEach(r => {
    const pos = Object.entries(ORDERS)
      .map(([label, list]) => `${label.split(' ')[0]}${label.includes('↑') ? '↑' : label.includes('↓') ? '↓' : ''}=${list.indexOf(r) + 1}`)
      .join('  ');
    console.log(`   ${r.id.padEnd(13)} @${(r.author || '').padEnd(20)} ${pos}`);
  });
  console.log('   (position 1-2 in the live order = the grind dies in batch 1, every time)');
}
const ready = readyAll;

// ── 4. per author ────────────────────────────────────────────────────────────
console.log(H('4 · Ready backlog per author (and how much of it is suspect)'));
const byA = {};
ready.forEach(r => {
  const a = r.author || '(none)';
  byA[a] = byA[a] || { n: 0, sus: 0, reel: 0, p: 0 };
  byA[a].n++; if (suspect(r)) byA[a].sus++;
  byA[a][kindOf(r) === 'p' ? 'p' : 'reel']++;
});
Object.entries(byA).sort((a, b) => b[1].n - a[1].n).forEach(([a, v]) => {
  console.log(`  @${a.padEnd(24)} ready ${String(v.n).padStart(5)}  suspect ${String(v.sus).padStart(5)}`
    + `  (${pct(v.sus, v.n)})  reels ${v.reel} · photos ${v.p}`);
});

// ── 5. files on disk (opt-in: --files) ───────────────────────────────────────
if (OPT.files) {
  console.log(H('5 · Do the recorded files exist on disk?'));
  let missRows = [], missFiles = 0, checked = 0;
  rows.forEach(r => {
    if (!isDownloaded(r)) return;
    let anyMissing = false;
    r.localFiles.forEach(f => {
      checked++;
      if (!fs.existsSync(path.join(IG_MEDIA, f))) { missFiles++; anyMissing = true; }
    });
    if (anyMissing) missRows.push(r.id);
  });
  console.log(`  checked ${checked} recorded files across ${rows.filter(isDownloaded).length} rows`);
  console.log(`  missing: ${missFiles} file(s) on ${missRows.length} row(s)`
    + (missRows.length ? ' → ' + missRows.slice(0, 12).join(', ') : ''));
  console.log('  (a row marked downloaded whose file is gone will never be retried — it is not ready)');
} else {
  console.log(H('5 · Files on disk — skipped (pass --files to check ~20k paths)'));
}

// ── 6. cross-reference a saved 🩺 Diagnostics file ───────────────────────────
if (OPT.diag) {
  console.log(H('6 · Cross-reference with ' + OPT.diag));
  let txt = '';
  try { txt = fs.readFileSync(OPT.diag, 'utf8'); }
  catch (e) { console.log('  cannot read: ' + e.message); txt = ''; }
  if (txt) {
    const fails = {};
    txt.split(/\r?\n/).forEach(line => {
      const m = line.match(/\b(ROW-FAIL|ENRICH-FAIL)\b.*?\bid=(\w+)/);
      if (m) { fails[m[2]] = fails[m[2]] || { row: 0, enrich: 0 }; fails[m[2]][m[1] === 'ROW-FAIL' ? 'row' : 'enrich']++; }
    });
    const ids = Object.keys(fails);
    console.log(`  ${ids.length} distinct rows failed in that recording`);
    const byId = new Map(rows.map(r => [r.id, r]));
    const stillReady = ids.filter(id => { const r = byId.get(id); return r && isReady(r); });
    console.log(`  ${stillReady.length} of them are STILL ready → they will be picked again, first, next run.`);
    ids.sort((a, b) => (fails[b].row + fails[b].enrich) - (fails[a].row + fails[a].enrich))
      .slice(0, 20).forEach(id => {
        const r = byId.get(id);
        console.log(`    ${id.padEnd(13)} rowFail×${fails[id].row} enrichFail×${fails[id].enrich}`
          + (r ? `  status=${r.status} files=${(r.localFiles || []).length} ready=${isReady(r) ? 'YES' : 'no'} @${r.author}`
               : '  (no such row in ig.json)'));
      });
  }
}

console.log(H('Reading this'));
console.log('  • A batch-1 PREDICTION above that says "a batch of 0 ENDS THE WHOLE GRIND" is');
console.log('    the row-marking cause, on its own, with no proxy involvement.');
console.log('  • If instead batch 1 looks healthy, the failure came later — take it to');
console.log('    proxy.log (heartbeat gap / signal / rss climb / a → with no ←) and to');
console.log('    🛠 Fix ▸ 🩺 Diagnostics (POLL-NOPROXY, vpnStillUp-FALSE-NOPROXY, SAVE-FAILED).');
console.log('  • Nothing was changed by this script.\n');
