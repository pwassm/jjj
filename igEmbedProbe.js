#!/usr/bin/env node
// igEmbedProbe.js — stamp every ig.json row with `embed: 1|0`:
//   1 → instagram.com's public embed page for the post carries a playable video
//       (an <iframe src=".../embed/captioned/"> on a public site will single-play it)
//   0 → the embed page is served WITHOUT video (photo post, or the account/post
//       disallows embed playback → the iframe shows poster + "Watch on Instagram")
// Rows the probe can't answer (rate-wall, timeout) are left WITHOUT the field, so
// re-running the script resumes exactly where it left off.
//
// Usage:
//   node igEmbedProbe.js --calib <id1,id2,...>   probe ids, print markers, save HTML
//                                                to the scratch dir — NO ig.json writes
//   node igEmbedProbe.js --limit 30              probe the first 30 unstamped rows
//   node igEmbedProbe.js --status downloaded,promoted   only rows in those states
//   node igEmbedProbe.js                         full run (checkpoints every 100 rows)
//
// Since dev0675 /ig/download stamps the verdict as each row is downloaded, so this
// script is now a BACKFILL for pre-dev0675 rows (and for the never-downloaded tail),
// not the only source of the flag.
//
// Fetch strategy mirrors proxy.js: lightweight embed HTML via the SHORT UA (a full
// Chrome UA makes IG serve the React app shell), fresh socket per request, and a
// curl_cffi TLS-impersonated retry (ig_impersonate_fetch.py) when the Node fetch
// comes back walled/thin — same cookieless posture as enrich, IG login never used.
// Pacing ~1.5s/row + backoff on consecutive walls, so a full 15k pass is an
// overnight grind by design. DO NOT open the I screen (localhost:8080) while this
// runs: its /ig/save persists whole rows and would clobber fields written here.
//
// (dev0675) The fetchers + classification now live in igEmbedProbeCore.js, shared
// with proxy.js's download-time stamp — this file keeps the ig.json grind (target
// selection, checkpointing, canary backoff) and nothing else.

'use strict';
const fs = require('fs');
const path = require('path');
const { probeEmbed } = require('./igEmbedProbeCore');

const DIR = __dirname;
const IG_STORE = path.join(DIR, 'ig.json');
const SCRATCH = process.env.PROBE_SCRATCH || DIR;   // calib HTML + tmp files land here
const LOG = path.join(SCRATCH, 'igEmbedProbe.log');

const argv = process.argv.slice(2);
function argVal(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }
const CALIB = argVal('--calib');
const LIMIT = +(argVal('--limit') || 0);
const ONLY_STATUS = argVal('--status');   // (dev0675) e.g. --status downloaded,promoted

function log(msg) {
  const line = new Date().toISOString().slice(11, 19) + ' ' + msg;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {}
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── probe (igEmbedProbeCore.js) ───────────────────────────────────────────────
const probeOne = (id, saveHtmlTo) => probeEmbed(id, { scratch: SCRATCH, saveHtmlTo, log });

// ── main ──────────────────────────────────────────────────────────────────────
(async () => {
  if (CALIB) {
    for (const id of CALIB.split(',').map(s => s.trim()).filter(Boolean)) {
      const p = await probeOne(id, SCRATCH);
      log(`calib ${id} → verdict=${p.v} kind=${p.kind} via=${p.via} status=${p.status} ` + JSON.stringify(p.m));
      await sleep(1200);
    }
    return;
  }

  const rows = JSON.parse(fs.readFileSync(IG_STORE, 'utf8'));
  if (!Array.isArray(rows) || !rows.length) { log('ig.json empty/unreadable — abort'); process.exit(1); }
  const statusRank = { downloaded: 0, enriched: 1, new: 2 };
  // (dev0675) --status narrows the run to one/some row states. The catch-up case is
  // `--status downloaded,promoted`: rows whose media is already on disk but that
  // predate the download-time stamp, so the keepers get a verdict without grinding
  // the whole unstamped tail (which the harvester keeps refilling).
  const wantStatus = ONLY_STATUS ? new Set(ONLY_STATUS.split(',').map(s => s.trim()).filter(Boolean)) : null;
  const targets = rows.filter(r => r && r.id && r.embed === undefined && (!wantStatus || wantStatus.has(r.status)))
    .sort((a, b) => (statusRank[a.status] ?? 3) - (statusRank[b.status] ?? 3));
  const todo = LIMIT ? targets.slice(0, LIMIT) : targets;
  if (wantStatus) log('status filter: ' + [...wantStatus].join(','));
  log(`ig.json rows=${rows.length} · unstamped=${targets.length} · this run=${todo.length}`);
  if (!todo.length) { log('nothing to do'); return; }

  const bak = IG_STORE + '.bak-embedprobe-' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  fs.copyFileSync(IG_STORE, bak);
  log('backup → ' + path.basename(bak));

  const save = () => {
    const tmp = IG_STORE + '.tmp-embedprobe';
    fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
    fs.renameSync(tmp, IG_STORE);
  };

  const CANARY = 'DSrgc-DjBTT';   // known embed-playable reel (sealifeandmore.org homepage)
  let n = 0, c1 = 0, c0 = 0, dead = 0, shells = 0, walls = 0, consecWalls = 0, sleeps = 0;
  const t0 = Date.now();
  for (const row of todo) {
    const p = await probeOne(row.id, null);
    n++;
    if (p.v === 1) { row.embed = 1; c1++; consecWalls = 0; sleeps = 0; }
    else if (p.v === 0) { row.embed = 0; c0++; if (p.kind === 'dead') dead++; consecWalls = 0; sleeps = 0; }
    else if (p.kind === 'shell') { shells++; consecWalls = 0; }   // per-post, IP is fine
    else { walls++; consecWalls++; }
    if (n % 100 === 0) save();
    if (n % 25 === 0 || n === todo.length) {
      const el = (Date.now() - t0) / 1000, rate = n / el;
      const eta = Math.round((todo.length - n) / rate / 60);
      log(`${n}/${todo.length} · embed1=${c1} embed0=${c0} (dead=${dead}) shell=${shells} wall=${walls} · ${rate.toFixed(2)}/s · eta ${eta}m`);
    }
    if (consecWalls >= 8) {
      // Canary: a wall streak can be a cluster of broken posts, not a burned IP.
      const can = await probeOne(CANARY, null);
      if (can.v !== null) {
        log(`⚠ ${consecWalls} consecutive walls but canary ${CANARY} probes fine — bad-post cluster, continuing`);
        consecWalls = 0;
      } else {
        sleeps++;
        if (sleeps > 3) { log('✋ 3 backoffs and canary still walled — IP is burned. Saving + exiting (re-run resumes).'); break; }
        log(`⏸ ${consecWalls} consecutive walls + canary walled — backing off 5 min (backoff ${sleeps}/3)`);
        save();
        await sleep(300000);
        consecWalls = 0;
      }
    }
    await sleep(900 + Math.random() * 600);
  }
  save();
  const stamped = rows.filter(r => r.embed !== undefined).length;
  log(`DONE this run: probed=${n} → embed1=${c1} embed0=${c0} (dead=${dead}) shell=${shells} wall=${walls} · total stamped=${stamped}/${rows.length}`);
})();
