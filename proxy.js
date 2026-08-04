// Custom CORS proxy that spoofs Referer + User-Agent per request.
// Bypasses hotlink protection on CDNs like cdn.oceanographicmagazine.com.
//
// (dev0289) Also hosts /exec/* — a tightly-scoped local bridge that runs
// allowlisted binaries (ffmpeg today, ffprobe + exiftool scaffolded) on
// behalf of the SeaLifeAndMore page. NDJSON streaming response so the UI
// can show live progress. Bound to 127.0.0.1 only; origin-locked to the
// static dev server. No npm install required — Node built-ins only.
//
// Usage:  node proxy.js
// Stop:   Ctrl+C  (or close the CMD window)
// Listens: http://127.0.0.1:8081

const http  = require('http');
const https = require('https');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const { spawn, execFileSync } = require('child_process');
const { probeEmbed } = require('./igEmbedProbeCore');   // (dev0675) download-time embed verdict

// (dev0658) Every in-flight IG media downloader (yt-dlp / gallery-dl / the
// curl_cffi impersonate fetch) registers here so the VPN kill-switch can stop
// them the instant the tunnel drops — IG must never touch the home IP. Killing
// is precise (tracked child handles), so unrelated yt-dlp/ffmpeg are untouched.
const ACTIVE_DL = new Set();
function killActiveDownloads() {
  let n = 0;
  for (const p of ACTIVE_DL) { try { p.kill('SIGKILL'); n++; } catch (_) {} }
  ACTIVE_DL.clear();
  return n;
}

// (dev0683) ══ BLACK BOX — DIAGNOSTICS ONLY, no behaviour change ═══════════════
// A long Download+rotate grind keeps failing, and the two candidate causes (the
// proxy stopping / rows in ig.json being marked so they can never download) leave
// NO evidence behind: the console window is this process's only record and it dies
// with the window. proxy.log is a durable, append-only trace of start / every
// request with status+duration / a 60s heartbeat with memory + handles / how this
// process ended. NOTHING here changes what the proxy does — it only writes lines.
//
// Reading it after the next failure:
//   • last line is a heartbeat, nothing after      → froze, or was killed hard
//   • "signal SIGINT|SIGHUP|SIGBREAK" then "exit"  → something stopped it
//     (window closed, Stop-Process, restart-proxy.ps1)
//   • rss climbing run-over-run                    → memory exhaustion; watch the
//     `/ig/save` lines, each one buffers a ~49MB body + parses + rewrites the file
//   • a request line with no matching ← line       → it died INSIDE that handler
//   • "node exited EXITCODE=-1073740791"           → SOLVED, dev0697: the system ran
//     out of COMMIT, not node out of heap. Read the "system memory" line at the top
//     of each run; a JS-heap OOM would instead exit 134 and print pages of GC detail.
//   • uncaughtException right before the gap       → a real bug, with its stack
//   • "client:" lines                              → what the I screen was doing
//     (mirrored from ig.js so both stories share one clock)
const LOG_FILE = path.join(__dirname, 'proxy.log');
let LOG_REQS = 0;                      // requests served since the last heartbeat
const POLL_LOG = { last: '', at: 0, n: 0 };   // /vpn/status poll de-duplication
function plog(line) {
  try {
    // Roll at 8MB so a long-lived proxy can't grow it without bound (one .1 kept).
    try {
      if (fs.statSync(LOG_FILE).size > 8 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    } catch (_) {}
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
    fs.appendFileSync(LOG_FILE, `${ts}  pid${process.pid}  ${line}\n`);
  } catch (_) {}
}
function memLine() {
  const m = process.memoryUsage();
  const mb = b => Math.round(b / 1048576);
  let handles = -1;
  try { handles = process._getActiveHandles().length; } catch (_) {}
  return `rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB ext=${mb(m.external)}MB `
       + `handles=${handles} activeDl=${ACTIVE_DL.size}`;
}

// (dev0697) COMMIT HEADROOM — the number that was missing from every previous
// investigation, and the one that actually explains the deaths.
//   Windows refuses an allocation when the system COMMIT CHARGE would exceed the
// commit limit (RAM + pagefile), regardless of how much physical RAM is free. On
// this machine, idle: limit 32.8GB, charged 30.9GB, free 1.85GB — with ~10GB of
// RAM free, and a pagefile pinned MANUAL at 1000-5000MB so the limit can barely
// grow. When a burst crossed that line V8 could not reserve, called abort(), and
// Windows killed node with 0xC0000409 and no message. rss/heap in every heartbeat
// looked healthy the whole time, which is exactly why this hid for so long.
//   So log it: at boot and every 15 minutes. If a future night dies, the log now
// shows whether headroom was gone at that moment instead of leaving us to guess.
// windowsHide so the probe never flashes a console (dev0657: a window that pops
// up on a timer is not acceptable, and rightly so).
function logCommitHeadroom() {
  const ps = "$o=Get-CimInstance Win32_OperatingSystem;"
    + "$p=@(Get-CimInstance Win32_PageFileSetting);$pf='system-managed';"
    + "if($p.Count -gt 0){$pf='manual '+$p[0].InitialSize+'-'+$p[0].MaximumSize+'MB'};"
    + "Write-Output ([string][int]($o.TotalVisibleMemorySize/1024)+'|'+[int]($o.FreePhysicalMemory/1024)"
    + "+'|'+[int]($o.TotalVirtualMemorySize/1024)+'|'+[int]($o.FreeVirtualMemory/1024)+'|'+$pf)";
  let out = '';
  try {
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    p.stdout.on('data', d => { out += d.toString('utf8'); });
    p.on('error', () => {});
    p.on('close', () => {
      const f = out.trim().split('|');
      if (f.length < 5) return;
      const gb = mb => (Number(mb) / 1024).toFixed(1);
      const commitFreeMB = Number(f[3]);
      plog(`system memory: RAM ${gb(f[0])}GB (free ${gb(f[1])}GB) · COMMIT limit ${gb(f[2])}GB`
        + ` free ${gb(f[3])}GB · pagefile ${f[4]}`);
      if (commitFreeMB < 3072) {
        plog(`⚠ COMMIT HEADROOM IS LOW (${gb(f[3])}GB). This — not the VPN and not Instagram —`
          + ` is what has been aborting node (0xC0000409) mid-grind. Raise the pagefile`
          + ` (System ▸ Advanced ▸ Performance ▸ Virtual memory: system-managed, or 16384-32768MB)`
          + ` and/or close the biggest commit consumers (each Everything instance held 1.3GB).`);
      }
    });
  } catch (_) {}
}

// (dev0656) STAY ALIVE. A WireGuard rotation tears the tunnel down, which RSTs any
// in-flight download socket; a socket/stream 'error' event with no listener at that
// instant would otherwise crash the whole node process — killing /vpn AND every
// download at once. That was the "no VPN exit would come up / current exit: no tunnel"
// failure: the proxy had silently died mid-batch, so the client's /vpn/status and
// /vpn/switch calls got ECONNREFUSED. Log and keep serving instead of exiting.
process.on('uncaughtException', (err) => {
  try { console.error(`[${new Date().toISOString()}] uncaughtException (proxy stays up):`, err && err.stack || err); } catch (_) {}
  plog('uncaughtException (proxy stays up): ' + ((err && err.stack) || err));
});
process.on('unhandledRejection', (reason) => {
  try { console.error(`[${new Date().toISOString()}] unhandledRejection (proxy stays up):`, reason && reason.stack || reason); } catch (_) {}
  plog('unhandledRejection (proxy stays up): ' + ((reason && reason.stack) || reason));
});

// (dev0683) How this process ended — the line that was missing every time. A closed
// console window arrives as SIGHUP/SIGBREAK, Ctrl+C as SIGINT, Stop-Process/taskkill
// as no line at all (which is itself the answer: killed, not crashed).
['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'].forEach(sig => {
  try {
    process.on(sig, () => {
      plog(`signal ${sig} — shutting down · ${memLine()}`);
      process.exit(0);
    });
  } catch (_) {}
});
process.on('exit', code => plog(`exit code=${code} · uptime=${Math.round(process.uptime())}s · ${memLine()}`));

const PORT = 8081;
// (dev0319) Build/capability tag — surfaced at GET /version so the client can
// detect a stale proxy before sending a deskew (rotate) job that an old build
// would silently mis-crop (rotate ignored → canvas crop coords on raw frame).
// (dev0418) Bumped + added 'screenrec' feature for the /rec/* screen recorder.
// (dev0425) Bumped + added 'ytdlp' feature: /exec/ytdlp pulls caption/author
// metadata via yt-dlp (r.jina.ai now login-walls Instagram et al.).
// (dev0428) Bumped + added 'igharvest' feature: /ig/add stages harvested IG reel
// URLs (from the Tampermonkey harvester) into ig.json, deduped by shortcode id.
// (dev0698) /ig/probe-res — the CHEAP answer to "is there a better video than the one
//   on disk?". `yt-dlp -J --skip-download` returns the format ladder without fetching a
//   byte; the top rung is exactly what a re-download would land, so a whole view can be
//   audited for the price of one metadata call per post instead of 3,454 re-downloads.
//   The held side is ffprobe'd from the real files (video only — dlW/dlH is the max
//   across ALL items, so on a mixed carousel it compares a photo against a video). This
//   is the VIDEO counterpart of igResAudit.js, which settles photos from the /p page:
//   that page cannot answer for video because dev0690 proved its video_versions are the
//   720-capped logged-out entries.
// (dev0696) THE DOWNGRADE GUARD NOW COMPARES minW TOO, and can say 'no gain'. dev0690's
//   guard tested one number — the LARGEST item's pixels — which on a mixed carousel is
//   both too weak and too strong. Too weak: a re-fetch whose max item was unchanged
//   republished silently, so a row could be re-downloaded in full, land identical files,
//   and stay ⚠ below-1080 — re-offered on every grind for good. Too strong: a re-fetch
//   that lifted the NARROWEST item but shrank the largest was thrown away as a downgrade.
//   The client now sends keepMinW (r.dlMinW) and publish() refuses with 'no gain' when
//   nothing improved on any axis, which is the signal the client concludes the row on.
//   'fewer items' also now outranks 'fewer pixels': a throttled walk is a throttle, and
//   must not be mistaken for IG's final word. See igResAudit.js for the cheap way to
//   settle the rest of the ⚠ backlog without re-downloading anything at all.
// (dev0690) VIDEO RESOLUTION FIX — the carousel counterpart of dev0677's photo fix.
//   dev0648 routed every /p post through the cookieless carousel walker (right, for
//   completeness: yt-dlp is a video tool and returned partial mixed carousels). But the
//   logged-out page's video surface is hard-capped — video_versions is three entries all
//   pointing at ONE 720-wide progressive MP4, carrying no width/height to choose between,
//   and its DASH manifest offers only 720p/360p. Collection-wide that took videos at
//   ≥1080 from 65.5% to 47.2% (3,381 of one author's 4,259 clips capped). Now the walker
//   supplies the INVENTORY and one yt-dlp spawn supplies the video BYTES, joined on each
//   carousel item's `code` (verified identical to yt-dlp's per-entry %(id)s) so a photo
//   sitting mid-carousel cannot shift clips into the wrong slots. Measured on
//   DY-r79ADcUC: 5 items 720x960 → 1080x1440, photo still 3024x4032.
//   Also: publish() measures every landed file and returns real dims (`media`), and
//   refuses a re-download that has fewer pixels or fewer items than the row already
//   holds (`kept`) — pixels, never bytes, because the 720p h264 is often the LARGER file.
// (dev0677) PHOTO RESOLUTION FIX: pickIgFullCover had silently degraded to returning
//   og:image — a CENTRE-CROPPED 640² thumbnail — so every single-item photo /p landed
//   cropped and small while the page advertised the uncropped original (verified live:
//   640² → 1440x1800). Two causes, both era-shifts in IG's page: escaped inline URLs
//   (the old scan excluded backslashes → matched nothing) and a "full = no stp= param"
//   test that modern IG always fails. publish() now also ground-truths the filename's
//   W×H from the file that actually landed, since the row's metadata was the thumbnail's.
// (dev0675) /ig/download now answers with the dev0665 official-embed verdict
//   (`embed: 1|0` + `embedProbe: ok|dead|shell|wall`) for rows the client says are
//   unstamped — one cookieless GET of /p/<id>/embed/captioned/ on the success path
//   only. Classification lives in igEmbedProbeCore.js, shared with igEmbedProbe.js.
// (dev0601) /ig/save no longer blind-overwrites: it keeps any ig.json row the client
//   never saw (id in neither its rows[] nor its new `knownIds`) so a harvest landing
//   via /ig/add while the I screen is open survives that screen's next persist().
// (dev0429) Bumped + added 'igstore' feature for the I/Ig screen (ig.js):
//   /ig/save     overwrites ig.json with the client's edited array (enrich/promote
//                state) — keeps a one-deep ig.json.bak first.
//   /ig/download yt-dlp downloads a reel/post's media into <project>/ig_media/.
// (dev0697) /ig/save-delta — the endpoint a GRIND uses: upsert just the rows a batch
//   changed (18 of 22,452) instead of shipping the whole 59MB store after every batch.
//   That whole-store round trip is what aborted node six times in one night: this
//   machine has ~1.85GB of free system COMMIT, and browser + proxy each allocated a
//   copy of the same 59MB at the same instant. Upsert-only, so it can never shrink the
//   store; deletes and bulk imports still take /ig/save. Both writers now stream the
//   file out row by row and rename it into place, so no save holds a 62MB string and a
//   crash mid-write can no longer truncate ig.json.
// (dev0430) ytdlp meta now also returns width,height (for the I-screen W×H column +
//   filename); /ig/download accepts a client-built `name` → files land in ig_media/
//   under the user's AHK naming convention (hh.mm.ss~WxH~title~@author~[[i[id]]]).
// (dev0433) ytdlp meta switched from compact `--print` to `-J` + ytdlpCompact():
//   fixes Instagram CAROUSEL posts (caption lives on the playlist top, dims on the
//   entries) that previously returned result:null → client "yt-dlp exit 0" → Enrich
//   silently did nothing. Now flattens both levels, taking MAX W×H across entries.
// (dev0461) IG embed fallback hardening: (a) embed fetch now uses agent:false (fresh
//   socket per request) — Node 19+ keepAlive pooled sockets to IG and a soft-block
//   stuck until node restart ("restarting node sometimes helps"); (b) when the embed
//   ALSO fails, surface a wall-class error ("login required …") instead of yt-dlp's
//   raw "no video in this post" so the client's stop-at-first-wall actually fires
//   (it was missing that string → batches kept hammering /p posts).
// (dev0495) /ig/download adds a gallery-dl IMAGE-carousel net: yt-dlp fetches NO IG
//   still images (video tool → 0 entries on a photo post), so an image-only /p only
//   ever returned the embed's first picture. gallery-dl (new C:\Special\gallery-dl\
//   gallery-dl.exe, +feature 'gallerydl') pulls the WHOLE carousel at full res, tried
//   after yt-dlp and before the embed last resort. IG login-walls gallery-dl
//   cookielessly, so it uses Firefox cookies (usedCookies:true, honest to the client).
// (dev0494) /ig/download REVERTS dev0493's embed-first for /p — it was a regression:
//   cookieless yt-dlp DOES pull the full carousel as MP4 at max res (verified live:
//   DL9ttujtjT4→2 mp4s, DXBzATkDVQh→7 mp4s), so embed-first wrongly handed back a
//   single static JPG and never tried yt-dlp. Now yt-dlp FIRST (full MP4 carousel),
//   optional Firefox-cookie yt-dlp via the new IG_DOWNLOAD_USE_COOKIES net, and the
//   cookieless embed static image only as a clearly-labelled LAST resort. The dev0493
//   "P won't download" was transient IP-throttle, not a wall.
// (dev0493) /ig/download PHOTO /p posts now go EMBED-FIRST (was: cookieless yt-dlp
//   first, embed only as fallback). yt-dlp's cookieless image path is reliably login-
//   walled, so trying it first per item wasted ~5s on a known wall AND doubled IG
//   request volume (walled yt-dlp + embed) → in a batch that accelerated IG's IP-
//   throttle until the embed call (fine in isolation) also failed = the "P won't
//   download" batch failures. Now: embed first (~1440px, ~2s, 1 request), yt-dlp only
//   if the embed misses; + one retry on a throttled embed fetch. Reels unchanged
//   (yt-dlp first — embed has no video). Verified end-to-end against the real posts.
// (dev0492) /ig/download now returns EXPLICIT usedCookies/viaEmbed flags so the
//   client stops misreading the dev0491 embed rescue's human `note` as a Firefox-
//   cookie use (which falsely tripped "cookie used" + the COOKIE_CAP batch auto-stop
//   on the very first /p photo post). Embed downloads are cookieless — flagged so.
// (dev0491) /ig/download IMAGE-POST FIX: yt-dlp extracts reels cookielessly (the
//   video URL is in the page's ld+json) but falls through to Instagram's login-
//   walled media API for photo /p/ posts → cookieless download fails on images
//   while reels succeed ("P posts hit the login wall more than reels"). New
//   igEmbedImageFallback: when cookieless yt-dlp yields no files for a /p/ (or /tv/)
//   post, scrape the image URL(s) from the SAME cookieless embed page dev0460 uses
//   for captions and download them directly — dodging the API wall. Photo posts
//   only (skips reels/video posts so it never grabs a video's poster frame).
//   Safe no-op: embed yields nothing → unchanged wall error. Embed serves a
//   display-size image (often ~640–1080px) so it can be below yt-dlp's max res;
//   it's a fallback for posts that would otherwise fail entirely.
// (dev0460) yt-dlp META: when the Instagram extractor raises "There is no video in
//   this post" (image-only /p/ posts) it discards the caption it fetched → enrich
//   failed. streamYtdlpMeta now falls back to the cookieless /p/{id}/embed/captioned/
//   page (parseIgEmbed) for ANY non-good instagram.com URL → recovers caption+author
//   (no W×H/date for images). Pure-cookieless, no Firefox login used.
// (dev0442) yt-dlp META (enrich) now also falls back cookieless→Firefox-cookies,
// same as /ig/download — IG login-walls most cookieless metadata now, so enrich was
// failing on nearly every post while downloads worked. Response carries usedCookies.
// (dev0439) /ig/download now handles MULTI-FILE carousels (incl. image-only /p
// posts): downloads to a temp dir with autonumbered names, then renames into
// ig_media/ as "<stem> [i of N].<ext>" (bare stem when a single file).
// (dev0434) /ig/download cookie order REVERSED → cookieless first, Firefox cookies
//   only as fallback (lowers account linkage for bulk downloads — user concern).
// (dev0450) /s/deleted + /s/undelete — archive rows deleted from s.json into
//   sdeleted.json (append, dedup by id) so St imports can skip previously-deleted
//   links; undelete pulls them back out (Ctrl+Z undo in St).
// (dev0683) DIAGNOSTICS ONLY: proxy.log black box (start / every /ig|/vpn|/fix|/exec
//   request with status+duration / 60s heartbeat with rss+handles / signals + exit),
//   per-phase timing on /ig/save (the ~49MB write that follows every batch), the
//   winning path + error tail on /ig/download, tunnelUp on /vpn/status, and
//   POST /diag/log so the I screen's own events land in the same file. No behaviour
//   changed — every route answers exactly as it did in dev0682.
// (dev0684) START now reports the V8 heap cap and flags a previous run that ended
//   without an exit line (killed hard / aborted). restart-proxy.ps1 appends stderr
//   to proxy.err.log so a fatal message outlives the console window.
const PROXY_BUILD = 'dev0720';

// (dev0459) PURE COOKIELESS, per user choice: never send `--cookies-from-browser
// firefox` to Instagram for enrich (streamYtdlpMeta) OR download (/ig/download).
// A login-walled post just fails cookielessly — the I-screen stops the batch at the
// first wall (WALL_CAP). Flip to true only to re-enable the Firefox-cookie fallback.
const IG_USE_COOKIES = false;

// (dev0494) DOWNLOAD-only cookie net, separate from enrich's IG_USE_COOKIES. The user
// is willing to use cookies to get the best /p downloads (full MP4 carousels). When
// cookieless yt-dlp comes back empty for a download, flip this to true to retry the
// download with `--cookies-from-browser firefox` (still the full carousel + MP4, far
// better than the static embed image) BEFORE the embed last-resort. Kept FALSE for now
// because cookieless yt-dlp already pulls the full MP4 carousel for the tested posts —
// turn it on only if specific posts genuinely wall cookielessly. Enrich stays cookieless.
const IG_DOWNLOAD_USE_COOKIES = false;

// (dev0495) gallery-dl image-carousel net for image-only /p posts (yt-dlp is a video
// tool and fetches NO IG still images, so a photo carousel only yielded the embed's
// first picture). gallery-dl grabs the whole carousel at full res, but IG login-walls
// it cookielessly, so it ALWAYS uses Firefox cookies. Standalone exe, no Python needed —
// download with: Invoke-WebRequest <release>/gallery-dl.exe -OutFile the path below.
// (dev0568) DISABLED — this was the LAST remaining Firefox-cookie path in the whole IG
// pipeline (enrich + the two yt-dlp download nets are already cookieless). It ran BEFORE
// the cookieless embed rescue, so a single-image /p (walker returns <2 items) fell to
// gallery-dl WITH COOKIES even though the cookieless embed index-1 could have fetched it
// — that's the surprise "🍪 cookie used (cap 1)" the user hit after a long download run.
// Per the user's account-safety choice, downloads are now PURE COOKIELESS: the cookieless
// carousel walker (dev0520) + video_versions reel rescue (dev0519) + embed index-1 cover
// handle the common cases; a post that genuinely needs a login now just FAILS cleanly
// (502 → I-screen stops the batch, no cookie sent). Flip back to true only to re-enable
// the Firefox-cookie full-carousel fallback for image posts the cookieless paths miss.
const IG_GALLERYDL = false;
const GALLERY_DL = 'C:\\Special\\gallery-dl\\gallery-dl.exe';

// (dev0518) yt-dlp browser IMPERSONATION for the cookieless DOWNLOAD path. Finding
// (2026-07-01): photo /p COVERS download fine cookieless (18 at home, no wall) but
// REELS now wall cookieless at the first one — IG moved its login gate onto video.
// `--impersonate` makes yt-dlp use a real browser's TLS/HTTP fingerprint (curl_cffi,
// bundled in the yt-dlp.exe — verified via --list-impersonate-targets), which can slip
// past fingerprint-based blocks. HONEST caveat: it will NOT beat a genuine "must log in"
// requirement — it only helps if the wall is (partly) heuristic on the client fingerprint.
// Values: '' disables; 'chrome' (yt-dlp picks the best Chrome); or pin one from
// --list-impersonate-targets, e.g. 'safari-18.4:ios-18.4' / 'chrome-131:android-14'
// (mobile targets sometimes fare better on IG). Applies to yt-dlp downloads only —
// enrich (which already works cookieless) and gallery-dl are untouched.
const IG_IMPERSONATE = 'chrome';

// (dev0675) Stamp the dev0665 official-embed verdict at DOWNLOAD time. Until now the
// flag came ONLY from the overnight igEmbedProbe.js grind, so every freshly harvested
// + downloaded row sat unstamped until someone remembered to re-run it — the verdict
// gap grows with every harvest, and it's the flag the grids gate their official-iframe
// playback on. Downloading is the right moment: IG is already answering us about this
// exact post, and embeddability is a live per-post permission best read when fresh.
// Deliberately conservative about request volume (the dev0494 lesson — extra calls in
// a batch accelerate IG's IP throttle):
//   • ONE extra cookieless GET of /p/<id>/embed/captioned/, and only on a SUCCESSFUL
//     download. A walled/failed download adds nothing.
//   • Only when the client says the row has no verdict yet (`probeEmbed:true`) —
//     already-stamped rows are never re-probed.
//   • No verdict (wall/timeout/shell) → the field is left ABSENT, exactly like the
//     script, so a later backfill resumes it. A wall never writes a wrong 0.
//   • Best-effort: any probe failure still returns the download result unchanged.
// Set false to go back to script-only stamping.
const IG_EMBED_PROBE_ON_DOWNLOAD = true;

// (dev0289/0304) Origins allowed to call /exec/*. The user's main dev server
// runs on :8080; Claude Code's preview server (see .claude/launch.json) is on
// :8082 — both 127.0.0.1 and localhost spellings allowed since the browser
// distinguishes them as separate origins. Anything else → 403 (preflight
// fails, browser surfaces "Failed to fetch").
const LOCAL_ORIGINS = new Set([
  'http://127.0.0.1:8080',
  'http://localhost:8080',
  'http://127.0.0.1:8082',
  'http://localhost:8082'
]);

// Extract the apex domain to use as Referer.
//   cdn.oceanographicmagazine.com  → oceanographicmagazine.com
//   www.example.co.uk              → example.co.uk
//   121clicks.com                  → 121clicks.com
function apexDomain(hostname) {
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  // .co.uk / .com.au / .co.jp style multi-part TLDs
  if (last.length === 2 && secondLast.length <= 3) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'content-length, content-type'
};

// (dev0289) Tighter CORS for /exec/* — the wildcard '*' on the public CORS
// proxy would let any site POST exec calls. We echo the request Origin only
// when it's in LOCAL_ORIGINS, otherwise we return no Allow-Origin and the
// browser blocks the response.
function corsForExec(origin) {
  const h = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '600'
  };
  if (LOCAL_ORIGINS.has(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

// (dev0289) ── /exec builders ────────────────────────────────────────────
// Each builder takes the JSON payload from the client and returns an argv
// array for the spawned binary. Throwing → 400 to the client. The client
// can NEVER pass raw args; the builder is the only path to argv. This is
// the safety boundary that makes the bridge non-injectable: spawn() is
// called with shell:false, so each argv string is a literal arg to the
// binary, not a shell token.

function must(cond, msg) { if (!cond) throw new Error(msg); }

// (dev0292) Builder accepts:
//   crop      {w,h,x,y}      — OPTIONAL (dev0293); even-pixel ints when set
//   crf       0..51           — default 18 (re-encode only)
//   preset    'slow'|'medium' — default 'medium' (re-encode only)
//   overwrite bool            — default false (-n: fail if output exists)
//   trim      {startSec,endSec} — optional; both ≥ 0 and end > start. When
//                                 present, -ss/-to are prepended before -i
//                                 (absolute input-time seeking). REQUIRED if
//                                 crop is absent (otherwise the call is a
//                                 no-op).
//   aspect    'L'|'P'         — used with resHeight to derive the scale filter
//   resHeight 2160|1440|1080|720|'source' (dev0717) — when numeric, append ',scale=-2:H' (L) or
//                                 ',scale=H:-2' (P) to the filter chain.
//                                 'source' or undefined → no scale.
//   ken       {x,y,w,h,holdSec,fps}
//                              — OPTIONAL (dev0720); CROP path only. Ken Burns:
//                                 zoom from the full crop into the box at
//                                 x/y/w/h (fractions OF THE CROP), arriving at
//                                 holdSec (seconds from the clip's own start)
//                                 and holding to the end. Replaces the scale
//                                 filter — zoompan emits the final size itself.
//                                 fps must be the SOURCE rate ("30000/1001" or
//                                 a number): zoompan sets the output frame rate.
//   audio     true|false       — OPTIONAL (dev0719); CROP path only. false → '-an'
//                                 (silent output), true/absent → '-c:a copy' as
//                                 before. Absent defaults to KEEPING audio so an
//                                 older client's payload behaves unchanged.
//   rotate    {rad,ow,oh}      — OPTIONAL (dev0318); horizon-straighten. Prepends
//                                 'rotate=rad:ow:oh:c=black,' before crop. rad is
//                                 radians (ffmpeg +=clockwise); the caller has
//                                 already expressed crop.x/y in this rotated
//                                 ow×oh canvas. Absent → chain unchanged.
//
// (dev0293) Two code paths now:
//   CROP path (re-encode):  crop present → libx264 + filter chain
//   TRIM-ONLY path (lossless): no crop, trim present → -c copy stream copy.
//     True lossless. Cuts snap to nearest keyframe for video; audio is
//     packet-accurate. For AB clips this is usually fine; if frame-exact
//     start is critical, the user can crop instead.
function buildFfmpegArgs(p) {
  must(p.input  && typeof p.input  === 'string', 'input (string) required');
  must(p.output && typeof p.output === 'string', 'output (string) required');
  const overwrite = !!p.overwrite;

  // ── Optional trim: -ss/-to BEFORE -i (absolute input-time seek) ────────
  const pre = [];
  if (p.trim) {
    must(typeof p.trim === 'object', 'trim must be an object');
    const s = +p.trim.startSec, e = +p.trim.endSec;
    must(Number.isFinite(s) && s >= 0, 'trim.startSec must be a number ≥ 0');
    must(Number.isFinite(e) && e > s,  'trim.endSec must be > startSec');
    pre.push('-ss', s.toFixed(3), '-to', e.toFixed(3));
  }

  const common = ['-hide_banner', '-loglevel', 'warning',
                  '-progress', 'pipe:1', '-stats_period', '0.5'];

  // (dev0391) ── METADATA path (lossless tag rewrite) ─────────────────────
  // No crop/trim — rewrite container tags only via stream-copy. ffmpeg can't
  // edit in place, so the caller passes a sibling temp output and swaps it
  // over the original afterward (FSA move on the client). Keys are allowlisted
  // to the five MP4 fields the Q screen edits; each value is a single literal
  // `key=value` argv token under shell:false (non-injectable), and the key
  // allowlist also blocks passing an option-looking key like "-y".
  if (p.metadata && !p.crop && !p.trim) {
    must(typeof p.metadata === 'object', 'metadata must be an object');
    const ALLOWED = ['title', 'artist', 'album', 'genre', 'comment'];
    const metaArgs = [];
    for (const k of Object.keys(p.metadata)) {
      must(ALLOWED.includes(k), 'metadata key not allowed: ' + k);
      let v = p.metadata[k];
      v = (v == null) ? '' : String(v);
      must(v.length <= 512, 'metadata.' + k + ' too long (max 512 chars)');
      v = v.replace(/[\x00-\x1f\x7f]/g, ' ');  // strip control chars/newlines
      metaArgs.push('-metadata', k + '=' + v);
    }
    must(metaArgs.length > 0, 'metadata object has no allowed keys');
    return [
      ...common,
      '-i', p.input,
      '-map_metadata', '0',
      '-c', 'copy',
      ...metaArgs,
      '-movflags', '+faststart',  // keep moov up front after rewrite
      overwrite ? '-y' : '-n',
      p.output
    ];
  }

  if (p.crop) {
    // ── CROP path (re-encode) ────────────────────────────────────────────
    must(typeof p.crop === 'object', 'crop must be an object');
    for (const k of ['w','h','x','y']) {
      must(Number.isInteger(p.crop[k]) && p.crop[k] >= 0,
           `crop.${k} must be a non-negative integer`);
    }
    const crf = (Number.isFinite(p.crf) && p.crf >= 0 && p.crf <= 51) ? p.crf : 18;
    const preset = (p.preset === 'slow' || p.preset === 'fast') ? p.preset : 'medium';
    // (dev0318) Optional horizon-straighten: rotate the whole frame onto an
    // expanded ow×oh square (black fill) so the user's tilted rect becomes
    // axis-aligned, then crop it. crop.x/y already live in the rotated canvas.
    // All values validated as numbers here → argv stays literal/non-injectable.
    let prefix = '';
    if (p.rotate) {
      must(typeof p.rotate === 'object', 'rotate must be an object');
      const rad = +p.rotate.rad;
      must(Number.isFinite(rad) && Math.abs(rad) <= 0.35,
           'rotate.rad must be a finite number with |rad| ≤ 0.35');
      for (const k of ['ow','oh']) {
        must(Number.isInteger(p.rotate[k]) && p.rotate[k] > 0,
             `rotate.${k} must be a positive integer`);
      }
      must(p.crop.x + p.crop.w <= p.rotate.ow && p.crop.y + p.crop.h <= p.rotate.oh,
           'crop exceeds rotated canvas');
      prefix = `rotate=${rad}:ow=${p.rotate.ow}:oh=${p.rotate.oh}:c=black,`;
    }
    let vf = prefix + `crop=${p.crop.w}:${p.crop.h}:${p.crop.x}:${p.crop.y}`;
    const resH = p.resHeight;
    const scaling = Number.isFinite(resH) && resH > 0;
    const aspect = (p.aspect === 'P') ? 'P' : 'L';
    if (p.ken) {
      // (dev0720) ── Ken Burns ────────────────────────────────────────────────
      // Glide from the whole crop into an inner box, arriving at holdSec and
      // sitting there to the end. zoompan is the only stock filter that can
      // move the visible region per frame at a fixed output size — crop's w/h
      // are configure-time constants, and scale takes no time expression.
      //
      // Geometry: interpolate the WINDOW, then derive the zoom from it. At eased
      // progress s the window is iw*(1-s*(1-KW)) wide with its left edge at
      // s*KX*iw, so z = 1/(1-s*(1-KW)). That keeps the window inside the frame
      // for every s (KX+KW ≤ 1 ⇒ s*KX + 1-s*(1-KW) ≤ 1), so zoompan never
      // clamps and the pan stays linear on screen. s is smoothstepped, which is
      // what stops the move looking like a machine.
      //
      // zoompan re-times the stream (its fps option IS the output rate), so the
      // caller sends the source's real rate and the ramp is counted in frames.
      const k = p.ken;
      must(typeof k === 'object', 'ken must be an object');
      for (const key of ['x','y','w','h']) {
        const v = +k[key];
        must(Number.isFinite(v) && v >= 0 && v <= 1, `ken.${key} must be within 0..1`);
      }
      must(+k.w >= 0.02 && +k.h >= 0.02, 'ken.w/h must be ≥ 0.02 (sane zoom ceiling)');
      must(+k.x + +k.w <= 1.001 && +k.y + +k.h <= 1.001, 'ken box must sit inside the crop');
      const hold = +k.holdSec;
      must(Number.isFinite(hold) && hold >= 0, 'ken.holdSec must be a number ≥ 0');
      // fps: "num/den" or a plain number. Kept verbatim for zoompan (exact
      // 30000/1001), and evaluated here only to count the ramp's frames.
      const fpsStr = String(k.fps == null ? '' : k.fps).trim();
      const mRat = /^(\d+)\/(\d+)$/.exec(fpsStr);
      const fpsNum = mRat ? (+mRat[1] / +mRat[2]) : parseFloat(fpsStr);
      must(Number.isFinite(fpsNum) && fpsNum > 0 && fpsNum <= 1000,
           'ken.fps must be a positive rate ("30000/1001" or a number)');
      const KW = (+k.w).toFixed(6), KX = (+k.x).toFixed(6), KY = (+k.y).toFixed(6);
      const N = Math.max(1, Math.round(fpsNum * hold));   // ramp length in frames
      const P = `min(on/${N},1)`;
      const S = `(${P})*(${P})*(3-2*(${P}))`;             // smoothstep ease
      // Output size. zoompan scales the window straight to this, so when a
      // resolution is chosen we render it here and skip the trailing scale —
      // one resample instead of two.
      const even = n => Math.max(2, Math.round(n / 2) * 2);
      let ow = p.crop.w, oh = p.crop.h;
      if (scaling) {
        if (aspect === 'P') { ow = resH; oh = even(p.crop.h * resH / p.crop.w); }
        else                { oh = resH; ow = even(p.crop.w * resH / p.crop.h); }
      }
      // Single-quoted expressions: commas inside them would otherwise read as
      // filter separators in the graph string.
      vf += `,zoompan=z='1/(1-(${S})*(1-${KW}))'` +
            `:x='(${S})*${KX}*iw':y='(${S})*${KY}*ih'` +
            `:d=1:s=${ow}x${oh}:fps=${fpsStr}`;
    } else if (scaling) {
      vf += (aspect === 'P') ? `,scale=${resH}:-2` : `,scale=-2:${resH}`;
    }
    // (dev0719) Output audio, driven by the crop bar's 🔇/🔊 switch. Absent →
    // true, so a pre-dev0719 payload still gets its soundtrack.
    const audio = (p.audio === undefined || p.audio === null) ? true : !!p.audio;
    return [
      ...common,
      ...pre,
      '-i', p.input,
      '-filter:v', vf,
      '-c:v', 'libx264', '-crf', String(crf), '-preset', preset,
      ...(audio ? ['-c:a', 'copy'] : ['-an']),
      // (dev0297) Same flag the lossless path already uses. Video is re-encoded
      // from PTS 0, but audio is stream-copied — its first packets can carry a
      // small leading offset that downstream editors (e.g. LosslessCut) render
      // as a blank video frame at the start. `make_zero` rebases the muxer's
      // timestamps so both streams begin at 0. Harmless with -an.
      '-avoid_negative_ts', 'make_zero',
      overwrite ? '-y' : '-n',
      p.output
    ];
  }

  // ── TRIM-ONLY path (lossless stream copy) ──────────────────────────────
  must(p.trim, 'either crop or trim is required (both absent → no-op)');
  // (dev0294) Two defensive flags for mp4 stream-copy with -ss/-to:
  //   -avoid_negative_ts make_zero — when -ss seeks into the middle of a GOP,
  //     the first kept packets may have negative PTS relative to the new
  //     output start. Some players (and ffmpeg's own mp4 muxer) refuse those;
  //     'make_zero' shifts timestamps so they begin at 0. Almost always what
  //     you want for trimmed clips.
  //   -fflags +genpts — generate presentation timestamps when the input is
  //     missing or has unreliable ones. Harmless when input is well-formed.
  return [
    ...common,
    ...pre,
    '-fflags', '+genpts',
    '-i', p.input,
    '-c', 'copy',
    '-avoid_negative_ts', 'make_zero',
    overwrite ? '-y' : '-n',
    p.output
  ];
}

// Scaffold — fill in when the feature lands. Throwing here returns a clean
// 400 to the client with the message below.
// (dev0391) Read the five container tags the Q screen edits. JSON to stdout;
// routed through streamExecCollect (NOT streamExec) so the progress parser
// doesn't shred the JSON.
function buildFfprobeArgs(p) {
  must(p.input && typeof p.input === 'string', 'input (string) required');
  // (dev0720) streams mode — first video stream's geometry + frame rate. The V
  // crop overlay needs the real rate before a Ken Burns render, because zoompan
  // sets the OUTPUT frame rate and would otherwise resample the clip to 25.
  if (p.streams) {
    return [
      '-v', 'error',
      '-print_format', 'json',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate,avg_frame_rate',
      p.input
    ];
  }
  // (dev0396) -v error (was -v quiet): on a bad/stale path ffprobe must emit
  // "No such file or directory" to stderr so streamExecCollect can surface it
  // and the Q client can detect ENOENT and offer to re-enter the disk path.
  // JSON still goes to stdout (unaffected by stderr verbosity).
  return [
    '-v', 'error',
    '-print_format', 'json',
    '-show_entries', 'format_tags=title,artist,album,genre,comment',
    p.input
  ];
}
// (dev0394) exiftool bridge — the fast, TigoTago-style tag engine.
//
// Why exiftool instead of the ffmpeg metadata path: ffmpeg cannot edit in
// place, so every tag write `-c copy`'s the WHOLE file to a temp and the
// client FSA-swaps it over the original — O(filesize) per edit (a 2 GB clip
// copies 2 GB to change one string). exiftool patches the moov atom in place
// (`-overwrite_original`), so a tag write is KB-sized and the client needs no
// temp/swap dance and no FSA readwrite permission at all.
//
// Round-trip note (verified empirically dev0394): we write the iTunes-style
// ItemList group (©nam/©ART/©alb/©gen/©cmt) explicitly so the values land in
// the exact atoms ffprobe's `format_tags=title,artist,…` reads back — keeping
// exiftool-write / ffprobe-read consistent with the old ffmpeg-write path.
//
// Two modes, dispatched on payload shape:
//   • write: p.metadata present → in-place tag rewrite (empty value clears).
//   • read : no p.metadata      → `-json` dump of the five tags (routed
//             through streamExecCollect like ffprobe, since stdout is JSON).
const EXIF_TAG_MAP = {
  title:   'ItemList:Title',
  artist:  'ItemList:Artist',
  album:   'ItemList:Album',
  genre:   'ItemList:Genre',
  comment: 'ItemList:Comment'
};
function buildExiftoolArgs(p) {
  must(p.input && typeof p.input === 'string', 'input (string) required');
  // ── WRITE mode (in-place) ───────────────────────────────────────────────
  if (p.metadata && typeof p.metadata === 'object') {
    // `-charset filename=UTF8` so non-ASCII paths resolve; `-charset UTF8` so
    // tag values are interpreted as UTF-8. `-overwrite_original` = no _original
    // backup. `-q` quiets the "1 files updated" chatter; exit code carries the
    // verdict. shell:false (spawn default) keeps every token literal — and the
    // key allowlist below blocks an option-looking key (e.g. "-delete_all").
    const args = ['-charset', 'filename=UTF8', '-charset', 'UTF8',
                  '-overwrite_original', '-q'];
    let n = 0;
    for (const k of Object.keys(p.metadata)) {
      must(EXIF_TAG_MAP[k], 'metadata key not allowed: ' + k);
      let v = p.metadata[k];
      v = (v == null) ? '' : String(v);
      must(v.length <= 512, 'metadata.' + k + ' too long (max 512 chars)');
      v = v.replace(/[\x00-\x1f\x7f]/g, ' ');   // strip control chars/newlines
      args.push('-' + EXIF_TAG_MAP[k] + '=' + v);  // empty value clears the tag
      n++;
    }
    must(n > 0, 'metadata object has no allowed keys');
    args.push(p.input);
    return args;
  }
  // ── READ mode (JSON to stdout) ──────────────────────────────────────────
  return ['-json', '-charset', 'UTF8',
          ...Object.values(EXIF_TAG_MAP).map(t => '-' + t),
          p.input];
}

// (dev0425) yt-dlp bridge — pulls caption/description + author metadata for a
// video URL (Instagram/YouTube/Vimeo/TikTok/…) so the client can populate
// ftext + VidAuthor where the r.jina.ai reader now hits provider login walls
// (Instagram especially). Route is /exec/ytdlp; the spawned binary is 'yt-dlp'
// (see EXEC_BIN — bare name resolves on PATH like ffmpeg). Output is one JSON
// line on stdout, so the dispatcher routes it through streamExecCollect.
//
//   • META (default): `--print` a compact JSON object of the handful of fields
//     we use, via yt-dlp's `%(.{…})j` sub-dict selector — NOT the multi-hundred-
//     KB full --dump-json.
//   • DOWNLOAD (p.download): SCAFFOLD ONLY — the per-row "save max-res mp4 to
//     <project>/video/" feature is stubbed on the client, so this throws a clean
//     400 until that lands. Left here to mark the security boundary.
//
// All args are literal under spawn(shell:false); the only caller-supplied token
// is the validated http(s) URL.
// (dev0433) Metadata now uses `-J` (a single JSON document) instead of the compact
// `--print %(.{…})j` per-entry selector. Reason: an Instagram CAROUSEL post is a
// yt-dlp *playlist* — the caption/author/date live on the top-level object while
// width/height/duration live on the ENTRIES, and `--print` runs per entry so it
// returned an empty caption + emitted one JSON line per item (which also broke the
// single-JSON.parse collector → result:null → client "yt-dlp exit 0"). `-J` is one
// document (parses cleanly) and carries both levels; ytdlpCompact() flattens it.
function buildYtdlpArgs(p) {
  must(p && typeof p.url === 'string', 'url (string) required');
  must(/^https?:\/\//i.test(p.url), 'url must be http(s)');
  must(p.url.length <= 2048, 'url too long (max 2048)');
  if (p.download) {
    throw new Error('ytdlp download mode not implemented yet (dev0425 stub)');
  }
  return [
    '--no-warnings', '--no-playlist', '--ignore-config',
    '--socket-timeout', '20',
    '-J', p.url
  ];
}

// (dev0433) Flatten a yt-dlp `-J` dump into the small metadata object the client
// uses. Single video → fields are on the top object. Carousel → caption/author/date
// on the playlist top, media dims on entries[]; we take the MAX W×H across entries
// (the user wants max res) and the longest entry duration.
function ytdlpCompact(j) {
  if (!j || typeof j !== 'object') return null;
  const entries = Array.isArray(j.entries) ? j.entries : [];
  const e0 = entries[0] || {};
  // caption/author/date: prefer the post/top level, fall back to the first entry.
  const top = k => (j[k] != null && j[k] !== '') ? j[k] : (e0[k] != null ? e0[k] : undefined);
  let mw = 0, mh = 0, dur = 0;
  const scan = o => {
    // (dev0648c) yt-dlp puts a bare `null` in entries[] for a carousel item it
    // couldn't extract — scan(null) then threw on `.width` INSIDE a ChildProcess
    // close handler, an uncaught throw that CRASHED the whole proxy on one bad post.
    if (!o || typeof o !== 'object') return;
    const w = +o.width || 0, h = +o.height || 0;
    if (h > mh || (h === mh && w > mw)) { mh = h; mw = w; }
    if ((+o.duration || 0) > dur) dur = +o.duration || 0;
  };
  if (entries.length) entries.forEach(scan); else scan(j);
  return {
    id: j.id, title: j.title,
    description: top('description') || '',
    uploader: top('uploader'), uploader_id: top('uploader_id'),
    channel: top('channel'), channel_url: top('channel_url'), uploader_url: top('uploader_url'),
    webpage_url: j.webpage_url || e0.webpage_url,
    timestamp: top('timestamp'), upload_date: top('upload_date'),
    like_count: top('like_count'), view_count: top('view_count'),
    thumbnail: top('thumbnail'),   // (dev0510) cover URL, when yt-dlp itself supplies one
    duration: dur || undefined, width: mw || undefined, height: mh || undefined
  };
}

// (dev0460) IG image-post fallback. yt-dlp's Instagram extractor HARD-RAISES
// "There is no video in this post" on photo-only posts (exit 1) and discards the
// caption it already fetched — so reels enrich fine but image /p/ posts fail. The
// lightweight, COOKIELESS embed page (/p/{id}/embed/captioned/) still carries the
// caption + author; scrape it and return an object shaped like ytdlpCompact() (no
// W×H/duration/date for images — matches dev0430's image handling). Last resort,
// only when cookieless yt-dlp returns nothing for an instagram.com URL.
const IG_SHORTCODE_RE = /instagram\.com\/(?:[^/]+\/)?(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/i;

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (_) { return ''; } })
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Parse caption + owner from an IG embed/captioned page (plain HTML, no JSON blob).
function parseIgEmbed(h, id) {
  if (!h) return null;
  let caption = '', owner = '';
  const capM = h.match(/<div class="Caption">([\s\S]*?)<\/div>/);
  if (capM) {
    let inner = capM[1];
    const cu = inner.match(/<a class="CaptionUsername"[^>]*instagram\.com\/([^/?"]+)/i);
    if (cu) owner = cu[1];
    inner = inner.replace(/^\s*<a class="CaptionUsername"[\s\S]*?<\/a>/i, '');  // drop leading author link
    caption = inner
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?[a-z][^>]*>/gi, '')   // strip remaining tags (mention <a> kept its @text)
      .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
    caption = decodeEntities(caption).trim();
  }
  if (!owner) {
    const ow = h.match(/class="(?:Username|CollabUsername)"[^>]*instagram\.com\/([^/?"]+)/i);
    if (ow) owner = ow[1];
  }
  if (!caption && !owner) return null;
  // (dev0510) Also lift the index-1 cover (og:image equivalent) off the same
  // cookieless embed page, so enriching a photo /p/ post surfaces its first image
  // (the keeper) without ever touching yt-dlp's login-walled carousel JSON. Reels
  // return [] here (parseIgEmbedImages skips is_video), so only photos get a cover.
  const cover = parseIgEmbedImages(h)[0];
  return {
    id, title: owner ? 'Post by ' + owner : 'Instagram post',
    description: caption || '',
    uploader: owner || undefined, uploader_id: owner || undefined,
    uploader_url: owner ? 'https://www.instagram.com/' + owner + '/' : undefined,
    webpage_url: 'https://www.instagram.com/p/' + id + '/',
    thumbnail: cover || undefined,
    duration: undefined, width: undefined, height: undefined, _viaEmbed: true
  };
}

function fetchIgEmbedMeta(url) {
  return new Promise(resolve => {
    const m = IG_SHORTCODE_RE.exec(url || '');
    if (!m) { resolve(null); return; }
    const id = m[1];
    const embedUrl = 'https://www.instagram.com/p/' + id + '/embed/captioned/';
    // NB: a FULL Chrome UA makes IG serve the heavy React app (no .Caption div); the
    // short UA gets the lightweight embed HTML we parse. Do not "modernize" this UA.
    // (dev0461) `agent: false` → a FRESH socket per request, like yt-dlp's per-spawn
    // connection. Node 19+ defaults https.globalAgent to keepAlive:true, so the
    // long-running proxy was reusing pooled sockets to instagram.com; once IG soft-
    // blocked that connection the embed page kept failing until node was restarted
    // (the user's "restarting node sometimes helps" — reels never hit this because
    // each runs in a fresh yt-dlp process). Fresh socket sidesteps the sticky block.
    const opts = { agent: false, headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.instagram.com/p/' + id + '/',
      'Connection': 'close'
    } };
    let h = '';
    const req = https.get(embedUrl, opts, r => {
      if (r.statusCode !== 200) { r.resume(); resolve(null); return; }
      r.setEncoding('utf8');
      r.on('data', c => { h += c; if (h.length > 4e6) req.destroy(); });
      r.on('end', () => { try { resolve(parseIgEmbed(h, id)); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

// (dev0511) ── MAIN /p/ page cookieless scrape ───────────────────────────────────
// The embed/captioned page (dev0460) now returns IG's heavy JS app shell — no
// `.Caption` div, no image — for many posts, so enrich + cover capture were failing on
// photo /p posts (the short-UA trick stopped forcing the lightweight embed). The
// LOGGED-OUT main post page still carries the public Open-Graph metadata IG serves for
// social/SEO previews: og:title/og:description (caption + @handle + date) and og:image
// (the index-1 cover), with the FULL-res cover variant also embedded inline. This is a
// far more stable cookieless surface than the embed trick.
//
// Given og:image (a 640 crop), find the uncropped full-res variant of the SAME media
// file elsewhere on the page (same filename, no `stp=…sNNNxNNN`); fall back to og:image.
// (dev0677) REWRITTEN — this function had silently degraded to "return og:image", and
// og:image is a CENTRE-CROPPED 640² thumbnail (`stp=c288.0.864.864a_…_s640x640`). Every
// single-item photo /p download therefore landed a cropped 640 square while the page was
// openly advertising the uncropped original (e.g. 1440x1800). Two era-shifts broke it:
//   1. IG's inline JSON escapes every URL — "https:\/\/scontent…" with \u0026 for & — and
//      the old scan's character class EXCLUDED backslashes, so it could never match a
//      single inline rendition. Only og:image (a plain HTML attribute) ever matched.
//   2. `full()` demanded a URL with NO `stp=` param, but modern IG puts every transform
//      in stp=, so the true original (`stp=dst-jpg_e35_tt6`) was rejected as "not full".
// Now: unescape first, collect every rendition of THIS post's media stem, and rank by
// what the stp transform actually does to the pixels. Verified live 2026-07-26 against
// DJ1jPioN60P (640² crop → 1440x1800), DYlgQhSoFhU, BMq7AAjDawt, 7YBuEznLRZ.
function pickIgFullCover(html, ogImage) {
  if (!ogImage) return '';
  const og = ogImage.replace(/&amp;/g, '&');
  // (dev0513) Match the media's numeric STEM (no extension) so we can collect every
  // rendition the page lists for it — JPEG and WebP alike — and prefer a real .jpg.
  const stemM = og.match(/\/(\d+_\d+_\d+_n)\.(?:webp|jpe?g|heic)/i);
  if (!stemM) return og;
  const stem = stemM[1];
  // Flatten the page's JSON escaping so inline URLs become matchable plain URLs. The
  // stem anchor keeps us on THIS post's media — a /p/ page also lists sibling posts.
  // ALL \uXXXX escapes must go, not just &: IG writes '%' as % inside the
  // signed query (…ig_cache_key=…%3D%3D…), and since a URL can't contain a
  // backslash the match would otherwise stop dead there — handing back a TRUNCATED,
  // signature-invalid URL that the CDN rejects. (Cost me one test run; keep this.)
  const flat = String(html || '').replace(/\\\//g, '/')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hx) => String.fromCharCode(parseInt(hx, 16)));
  const re = new RegExp('https?://[^"\'\\s\\\\]*?' + stem + '\\.(?:webp|jpe?g|heic)[^"\'\\s\\\\]*', 'gi');
  const vars = [...new Set([...flat.matchAll(re)].map(m => m[0].replace(/&amp;/g, '&')))];
  if (!vars.length) return og;
  // What IG's `stp=` says it did to the pixels:
  //   no size directive at all → the uncropped original (what we want)
  //   sNNNxNNN / pNNNxNNN      → scaled into that box (take the smallest = final size)
  //   cA.B.W.Ha                → a CROP: content is lost, not just resolution
  const info = u => {
    const stp = (u.match(/[?&]stp=([^&]*)/) || [, ''])[1];
    const boxes = [...stp.matchAll(/(?:^|_)[sp](\d+)x(\d+)/g)].map(m => Math.min(+m[1], +m[2]));
    return {
      cropped: /(?:^|_)c[\d.]+\.[\d.]+\.[\d.]+\.[\d.]+a/.test(stp) ? 1 : 0,
      box: boxes.length ? Math.min(...boxes) : 1e9,          // 1e9 = "no cap" (original)
      jpg: /\.jpe?g(?:[?&]|$)/i.test(u) ? 1 : 0
    };
  };
  // Uncropped first, then the largest box, then a real JPEG over WebP (dev0513: saves
  // the transcode). og:image remains the last resort for a page that lists nothing else.
  const best = vars.map(u => ({ u, i: info(u) }))
    .sort((a, b) => (a.i.cropped - b.i.cropped) || (b.i.box - a.i.box) || (b.i.jpg - a.i.jpg))[0];
  return best ? best.u : og;
}
// Parse the main page's Open-Graph metadata into a ytdlpCompact()-shaped object.
function parseIgMainMeta(html, id) {
  if (!html) return null;
  const prop = p => {
    const m = html.match(new RegExp('<meta[^>]+property="' + p + '"[^>]+content="([^"]*)"', 'i'))
           || html.match(new RegExp('<meta[^>]+content="([^"]*)"[^>]+property="' + p + '"', 'i'));
    return m ? decodeEntities(m[1]) : '';
  };
  const nameMeta = n => { const m = html.match(new RegExp('<meta[^>]+name="' + n + '"[^>]+content="([^"]*)"', 'i')); return m ? decodeEntities(m[1]) : ''; };
  const ogDesc = prop('og:description') || nameMeta('description');
  const ogTitle = prop('og:title');
  const ogImage = prop('og:image');
  const twTitle = nameMeta('twitter:title');
  // Video posts: don't hand back a poster frame as a "cover" (mirrors the embed path's
  // is_video skip) — yt-dlp owns video; the cover is photo-only.
  // (dev0520) IG's logged-out reel page dropped ALL the old video signals — og:type is
  // now "article", there's no og:video tag, and no `"is_video":true` in the shell — so a
  // walled reel falling back here was mis-read as a PHOTO (it took the poster's small
  // dims + no duration → filenames like `00.00.00~361x640~…`). The reliable signal now is
  // the inline `"video_versions":[…]` MP4 array (same one dev0519's download path uses).
  const isVideo = /"video_versions"\s*:/i.test(html)
               || /<meta[^>]+property="og:video"/i.test(html)
               || /"is_video"\s*:\s*true/i.test(html)
               || /<meta[^>]+property="og:type"[^>]+content="video/i.test(html);
  // @handle: twitter:title "(@handle)" first, else the og:description "handle on …" prefix.
  let owner = ''; const hm = twTitle.match(/\(@([\w.]+)\)/); if (hm) owner = hm[1];
  if (!owner) { const dm = ogDesc.match(/^([\w.]+)\s+on\b/); if (dm) owner = dm[1]; }
  // Date: og:description "… on June 27, 2026: …" → YYYYMMDD (client datePosted reads upload_date).
  let upload_date; const dt = ogDesc.match(/\bon\s+([A-Z][a-z]+\.? \d{1,2},? \d{4})/);
  if (dt) { const d = new Date(dt[1]); if (!isNaN(d)) upload_date = d.toISOString().slice(0, 10).replace(/-/g, ''); }
  // Caption: the quoted text after the "handle on date:" prefix.
  let caption = ''; const capSrc = ogDesc || ogTitle;
  const cm = capSrc.match(/:\s*"([\s\S]*)"\s*\.?\s*$/); if (cm) caption = cm[1].trim();
  if (!caption && !owner && !ogImage) return null;
  const cover = isVideo ? undefined : pickIgFullCover(html, ogImage);
  // (dev0513) Native pixel dims of the index-1 media, so a photo /p cover gets a real
  // W×H in its filename (IG's logged-out page used to leave these blank → 0x0). The
  // page's `"dimensions":{"height":H,"width":W}` JSON is the native size and matches the
  // full-res cover; fetchIgMainMeta() probes the image header when this isn't present.
  let width, height, duration;
  if (isVideo) {
    // (dev0520) Reel source dims + duration off the logged-out page, so a walled reel
    // enriches with the REAL video W×H + duration instead of the poster's. The
    // video_versions objects carry no W×H — the native size is in
    // "original_width"/"original_height"; the duration is the embedded DASH manifest's
    // mediaPresentationDuration="PT<seconds>S" (there's no plain "duration" key). Take
    // the max across a video carousel's manifests (mirrors ytdlpCompact's "longest").
    const ow = html.match(/"original_width"\s*:\s*(\d+)/);
    const oh = html.match(/"original_height"\s*:\s*(\d+)/);
    if (ow && oh) { width = +ow[1]; height = +oh[1]; }
    let maxDur = 0;
    const dre = /mediaPresentationDuration=\\?"?PT([\d.]+)S/gi; let dm;
    while ((dm = dre.exec(html))) { const s = parseFloat(dm[1]); if (s > maxDur) maxDur = s; }
    if (maxDur) duration = Math.round(maxDur * 1000) / 1000;
  } else {
    const dj = html.match(/"dimensions"\s*:\s*\{\s*"height"\s*:\s*(\d+)\s*,\s*"width"\s*:\s*(\d+)/);
    if (dj) { height = +dj[1]; width = +dj[2]; }
  }
  // (dev0690) How many items the post carries — the ONE fact nothing in ig.json recorded,
  // so nothing on the I screen could say "this is a 6-item carousel" without downloading
  // it first. This page already contains the answer; walk it while we have the HTML.
  // >=2 → a real carousel; no carousel_media key at all → a genuine single-item post;
  // anything else (key present but unparsable) stays undefined rather than guessing.
  let nItems;
  const cItems = pickIgCarouselMedia(html);
  if (cItems.length >= 2) nItems = cItems.length;
  else if (!/"carousel_media"\s*:\s*\[\s*\{/.test(html)) nItems = 1;
  return {
    id, title: owner ? 'Post by ' + owner : 'Instagram post',
    description: caption || '',
    uploader: owner || undefined, uploader_id: owner || undefined,
    uploader_url: owner ? 'https://www.instagram.com/' + owner + '/' : undefined,
    webpage_url: 'https://www.instagram.com/p/' + id + '/',
    upload_date, thumbnail: cover || undefined,
    duration: duration || undefined, width: width || undefined, height: height || undefined,
    nItems, _viaMain: true
  };
}
// GET the logged-out main /p/ page (cookieless: fresh socket + short UA + IG Referer)
// and parse its Open-Graph metadata. Resolves null on any non-200/parse failure so the
// caller can fall back to the embed page.
function fetchIgMainMeta(url) {
  return new Promise(resolve => {
    const m = IG_SHORTCODE_RE.exec(url || '');
    if (!m) { resolve(null); return; }
    const id = m[1];
    const permalink = 'https://www.instagram.com/p/' + id + '/';
    // (dev0647) Node-first, curl_cffi-impersonate-if-walled — so a photo cover (single-item
    // /p) resolves on VPN IPs too, not just the multi-item carousel path. Enrich shares
    // this fetch, so it gets the same VPN resilience; home IPs never spawn the helper.
    igGetPageHtml(permalink, 6e6, null, igPageHasMedia).then(h => {
      if (!h) { resolve(null); return; }
      let meta = null;
      try { meta = parseIgMainMeta(h, id); } catch (_) {}
      // (dev0513) Page carried no dims → read them straight from the cover's header
      // bytes so the download filename gets a real W×H instead of 0x0.
      if (meta && meta.thumbnail && (!meta.width || !meta.height)) {
        probeImageDims(meta.thumbnail, permalink).then(d => {
          if (d) { meta.width = d.width; meta.height = d.height; }
          resolve(meta);
        });
      } else resolve(meta);
    });
  });
}
// (dev0513) Parse pixel dimensions out of an image's leading bytes — JPEG / PNG / WebP /
// GIF. Header-only, so a small ranged read is plenty. Returns {width,height} or null.
function parseImageDims(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG: 8-byte sig, then IHDR width@16 height@20 (big-endian).
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47)
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  // GIF: width@6 height@8 (little-endian).
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  // WebP: 'RIFF'....'WEBP' then a VP8/VP8L/VP8X chunk.
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8 ' && buf.length >= 30) {           // lossy: dims after the 9d 01 2a start code
      const w = buf.readUInt16LE(26) & 0x3FFF, hgt = buf.readUInt16LE(28) & 0x3FFF;
      if (w && hgt) return { width: w, height: hgt };
    } else if (fmt === 'VP8L' && buf.length >= 25 && buf[20] === 0x2F) {   // lossless: 14-bit (w-1),(h-1)
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3FFF) + 1, height: ((b >> 14) & 0x3FFF) + 1 };
    } else if (fmt === 'VP8X' && buf.length >= 30) {    // extended: 24-bit (w-1),(h-1)
      return { width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1,
               height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1 };
    }
    return null;
  }
  // JPEG: walk the marker segments to the SOF that carries height/width.
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xFF) { off++; continue; }
      let marker = buf[off + 1];
      while (marker === 0xFF && off + 2 < buf.length) { off++; marker = buf[off + 1]; }   // skip fill
      if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { off += 2; continue; }
      const len = buf.readUInt16BE(off + 2);
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC)
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      off += 2 + len;
    }
  }
  return null;
}
// (dev0513) Fetch just an image's header (cookieless: short UA + IG Referer) and parse
// its dimensions. Reads at most 256 KB then aborts; follows redirects. Resolves
// {width,height} or null. Used to fill a photo /p cover's W×H for the download filename.
function probeImageDims(fileUrl, referer, hops) {
  return new Promise(resolve => {
    if (hops == null) hops = 0;
    let u; try { u = new URL(fileUrl); } catch (_) { resolve(null); return; }
    if (u.protocol !== 'https:') { resolve(null); return; }
    const opts = { agent: false, headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8',
      'Referer': referer || 'https://www.instagram.com/', 'Connection': 'close'
    } };
    const chunks = []; let got = 0, done = false;
    const finish = () => { if (done) return; done = true; try { resolve(parseImageDims(Buffer.concat(chunks))); } catch (_) { resolve(null); } };
    const req = https.get(fileUrl, opts, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 3) {
        r.resume(); if (!done) { done = true; probeImageDims(new URL(r.headers.location, fileUrl).href, referer, hops + 1).then(resolve); } return;
      }
      if (r.statusCode !== 200) { r.resume(); finish(); return; }
      r.on('data', c => { chunks.push(c); got += c.length; if (got >= 262144) { req.destroy(); finish(); } });
      r.on('end', finish);
      r.on('error', finish);
    });
    req.on('error', () => { if (!done) { done = true; resolve(null); } });
    req.setTimeout(15000, () => { req.destroy(); finish(); });
  });
}
// Best cookieless cover URL for a photo /p post (download path): main-page full-res
// cover. '' when the page yields none (caller falls back to the embed-image parse).
function igMainCoverUrl(sc) {
  return fetchIgMainMeta('https://www.instagram.com/p/' + sc + '/')
    .then(meta => (meta && meta.thumbnail) || '')
    .catch(() => '');
}

// (dev0491) Pull the post image URL(s) out of an IG embed/captioned page so a photo
// /p/ post can be downloaded cookielessly when yt-dlp's login-walled image path
// fails. Picks the highest-resolution candidate IG advertises on that page
// (display_resources / display_url / the EmbeddedMediaImage srcset/src). Returns []
// for video posts (so we never substitute a reel's poster frame) and when nothing
// matches. The embed renders only the first item of a carousel, so this yields a
// single URL in practice.
function parseIgEmbedImages(html) {
  if (!html) return [];
  if (/"is_video"\s*:\s*true/i.test(html) || /<video[\s>]/i.test(html)) return [];   // video post → skip
  const cand = [];   // { url, w }
  const add = (u, w) => { if (u) cand.push({ url: decodeEntities(String(u).replace(/\\\//g, '/')), w: +w || 0 }); };
  // Highest-res candidates: IG's display_resources [{src,config_width},…] (escaped).
  const drM = html.match(/"display_resources"\s*:\s*\[([\s\S]*?)\]/);
  if (drM) {
    const re = /"src"\s*:\s*"([^"]+)"[^}]*?"config_width"\s*:\s*(\d+)/g;
    let m; while ((m = re.exec(drM[1]))) add(m[1], m[2]);
  }
  const duM = html.match(/"display_url"\s*:\s*"([^"]+)"/);
  if (duM) add(duM[1], 1080);
  // The embedded media <img>: a srcset ("url 640w, url 1080w") then a plain src.
  const ssM = html.match(/class="EmbeddedMediaImage"[^>]*\ssrcset="([^"]*)"/i);
  if (ssM) ssM[1].split(',').forEach(part => { const mm = part.trim().match(/(\S+)\s+(\d+)w/); if (mm) add(mm[1], mm[2]); });
  const imgM = html.match(/class="EmbeddedMediaImage"[^>]*\ssrc="([^"]+)"/i);
  if (imgM) add(imgM[1], 0);
  if (!cand.length) return [];
  // Dedup by URL keeping the widest, then take the single widest URL overall.
  const byUrl = new Map();
  for (const c of cand) { const p = byUrl.get(c.url); if (!p || c.w > p.w) byUrl.set(c.url, c); }
  const best = [...byUrl.values()].sort((a, b) => b.w - a.w)[0];
  return best ? [best.url] : [];
}

// (dev0647) ── TLS-impersonated fetch bridge (PHOTO path) ─────────────────────────────
// Reels download on VPN/datacenter IPs because yt-dlp's bundled curl_cffi gives them a
// real-Chrome TLS handshake (JA3) IG's IP-reputation wall trusts. PHOTOS have NO yt-dlp
// path (yt-dlp fetches zero IG still images), so the proxy scrapes the /p/ inline JSON
// and pulls fbcdn media with Node's https.get — whose TLS fingerprint IG flags on those
// IPs, walling photos cookielessly. These helpers reuse the SAME impersonation (via
// ig_impersonate_fetch.py — curl_cffi, cookieless, the IG account is never touched) so the
// photo page scrape + CDN fetch slip the wall too. If curl_cffi isn't installed the first
// probe flips _igImpersonateOk=false and every call no-ops (proxy keeps using Node paths).
const IG_PYTHON = process.env.IG_PYTHON || 'python';
const IG_IMPERSONATE_PY = path.join(__dirname, 'ig_impersonate_fetch.py');
let _igImpersonateOk = null;   // null=untried, true=works, false=curl_cffi missing (stop spawning)
function igImpersonatedGet(fileUrl, destPath, referer, accept, ua) {
  return new Promise(resolve => {
    if (_igImpersonateOk === false) { resolve(false); return; }
    let u; try { u = new URL(fileUrl); } catch (_) { resolve(false); return; }
    if (u.protocol !== 'https:') { resolve(false); return; }
    let proc;
    try { proc = spawn(IG_PYTHON, [IG_IMPERSONATE_PY, fileUrl, destPath, referer || '', accept || '', ua || ''], { windowsHide: true }); }
    catch (_) { resolve(false); return; }
    ACTIVE_DL.add(proc);   // (dev0658) killable by the VPN kill-switch
    let out = '', done = false;
    const finish = ok => { if (done) return; done = true; ACTIVE_DL.delete(proc); clearTimeout(killT); resolve(ok); };
    const killT = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} finish(false); }, 40000);
    proc.stdout.on('data', d => { out += d.toString('utf8'); if (out.length > 2000) out = out.slice(-2000); });
    proc.on('error', () => finish(false));
    proc.on('close', code => {
      const s = out.trim();
      if (/^ERR curl_cffi import/i.test(s)) _igImpersonateOk = false;   // not installed → stop trying
      else if (/^\d/.test(s)) _igImpersonateOk = true;
      let sz = 0; try { sz = fs.statSync(destPath).size; } catch (_) {}
      finish(code === 0 && sz > 0);
    });
  });
}
// Impersonated fetch of an IG PAGE → HTML string ('' on failure). Throwaway temp file.
function igImpersonatedHtml(permalink, referer, ua) {
  const tmp = path.join(IG_MEDIA_DIR, '.html_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
  return igImpersonatedGet(permalink, tmp, referer || permalink,
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ua).then(ok => {
    let html = '';
    if (ok) { try { html = fs.readFileSync(tmp, 'utf8'); } catch (_) {} }
    try { fs.unlinkSync(tmp); } catch (_) {}
    return html;
  });
}
// Plain Node https GET of an IG page → HTML ('' on any failure). Cookieless: fresh socket.
function igFetchNodeHtml(permalink, maxBytes, ua) {
  return new Promise(resolve => {
    const opts = { agent: false, headers: {
      'User-Agent': ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9', 'Referer': permalink, 'Connection': 'close'
    } };
    let h = '';
    const req = https.get(permalink, opts, r => {
      if (r.statusCode !== 200) { r.resume(); resolve(''); return; }
      r.setEncoding('utf8');
      r.on('data', c => { h += c; if (h.length > (maxBytes || 8e6)) req.destroy(); });
      r.on('end', () => resolve(h));
    });
    req.on('error', () => resolve(''));
    req.setTimeout(20000, () => { req.destroy(); resolve(''); });
  });
}
// Node-first, impersonate-if-walled page fetch. `isGood(html)` returns true once the Node
// HTML already carries what the caller needs, so home-IP fetches never spawn the Python
// helper — only a walled/thin page (typical on VPN) triggers the impersonated retry.
function igGetPageHtml(permalink, maxBytes, ua, isGood) {
  return igFetchNodeHtml(permalink, maxBytes, ua).then(h => {
    if (h && isGood(h)) return h;
    return igImpersonatedHtml(permalink, permalink, ua).then(h2 => (h2 && isGood(h2)) ? h2 : (h || h2 || ''));
  });
}
// A logged-out /p/ page is "good" once it carries the inline media JSON (walled pages don't).
const igPageHasMedia = h => /"image_versions2"|"video_versions"|"carousel_media"/.test(h);

// (dev0491) GET an image URL → write to destPath. Cookieless, fresh socket + short UA
// + IG Referer (same recipe that beats the wall on the embed page); follows up to a
// couple of redirect hops. Resolves true only on a 200 with a non-empty body.
// (dev0647) On any Node failure, retry ONCE via curl_cffi TLS impersonation — the fbcdn
// CDN 403s Node on VPN IPs the same way the page does, so a walled photo's media now
// downloads with the reel-grade handshake. Pure cookieless.
function igDownloadImage(fileUrl, destPath, referer, hops, accept) {
  return igDownloadImageNode(fileUrl, destPath, referer, hops, accept).then(ok => {
    if (ok) return true;
    return igImpersonatedGet(fileUrl, destPath, referer, accept || 'image/avif,image/webp,image/*,*/*;q=0.8');
  });
}
function igDownloadImageNode(fileUrl, destPath, referer, hops, accept) {
  return new Promise(resolve => {
    if (hops == null) hops = 0;
    let u; try { u = new URL(fileUrl); } catch (_) { resolve(false); return; }
    if (u.protocol !== 'https:') { resolve(false); return; }
    const opts = { agent: false, headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      // (dev0519) Accept defaults to images; a video/mp4 CDN GET passes '*/*' so the
      // header isn't semantically wrong for reels (the signed CDN URL ignores it, but
      // keep it honest). Image callers omit the arg → identical header as before.
      'Accept': accept || 'image/avif,image/webp,image/*,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': referer || 'https://www.instagram.com/',
      'Connection': 'close'
    } };
    const req = https.get(fileUrl, opts, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 3) {
        r.resume();
        igDownloadImageNode(new URL(r.headers.location, fileUrl).href, destPath, referer, hops + 1, accept).then(resolve);
        return;
      }
      if (r.statusCode !== 200) { r.resume(); resolve(false); return; }
      let bytes = 0;
      const ws = fs.createWriteStream(destPath);
      r.on('data', c => { bytes += c.length; });
      r.pipe(ws);
      ws.on('finish', () => ws.close(() => resolve(bytes > 0)));
      ws.on('error', () => resolve(false));
      r.on('error', () => { try { ws.destroy(); } catch (_) {} resolve(false); });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(20000, () => { req.destroy(); resolve(false); });
  });
}

// (dev0491) Cookieless image-download fallback for photo /p/ (and /tv/) posts. Fetches
// the embed page, parses the image URL(s), and writes each into tmpDir with the same
// NNN.<ext> autonumber scheme igDownload()'s publish() expects. Resolves the list of
// files written (empty → caller proceeds to its normal wall/cookie handling). Skips
// reels entirely (no extra IG request) so a walled reel never yields a poster image.
// (dev0678) The resolved array is TAGGED with `.source`: 'main' = the logged-out /p/
// page's cover, which since the dev0677 picker fix is the FULL-RES original, versus
// 'embed' = the embed page's picture, which really is a first-image-only thumbnail.
// The two used to be reported identically as `viaEmbed`, so every full-res cover was
// labelled a "low-res fallback" and got the ⚠ marker (1,818 rows wore a false ⚠ after
// the dev0677 re-fetch, all of them ≥1080). Callers must keep the distinction.
function igEmbedImageFallback(url, id, tmpDir) {
  return new Promise(resolve => {
    const m = IG_SHORTCODE_RE.exec(url || '');
    if (!m || /\/reels?\//i.test(url)) { resolve([]); return; }   // photo posts only
    const sc = m[1];
    const permalink = 'https://www.instagram.com/p/' + sc + '/';
    // (dev0511) MAIN page cover FIRST — the embed/captioned page (embedImages below) now
    // serves IG's JS shell with no image for many posts; the logged-out /p/ page still
    // carries the full-res index-1 cover. Embed-image parse stays as the secondary path.
    igMainCoverUrl(sc).then(coverUrl => {
      if (!coverUrl) { embedImages(); return; }
      let ext = '.jpg';
      try { const e = path.extname(new URL(coverUrl).pathname); if (/^\.(jpe?g|png|webp)$/i.test(e)) ext = e; } catch (_) {}
      const dest = path.join(tmpDir, '001' + ext);
      igDownloadImage(coverUrl, dest, permalink).then(ok => {
        if (ok) { const out = [dest]; out.source = 'main'; resolve(out); return; }   // (dev0678) full-res
        try { fs.unlinkSync(dest); } catch (_) {}
        embedImages();
      });
    });
    function embedImages() {
    const opts = { agent: false, headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': permalink,
      'Connection': 'close'
    } };
    // (dev0493) ONE retry on a non-200/error/timeout embed fetch. IG transiently
    // throttles the embed endpoint during a batch (a fresh request a beat later
    // usually returns 200); without this a single throttled GET failed the whole
    // download. `settled` makes each attempt fire its callback exactly once.
    function getHtml(triesLeft, cb) {
      let settled = false, h = '';
      const fail = () => { if (settled) return; settled = true; if (triesLeft > 0) setTimeout(() => getHtml(triesLeft - 1, cb), 1300); else cb(''); };
      const ok = v => { if (settled) return; settled = true; cb(v); };
      const req = https.get(permalink + 'embed/captioned/', opts, r => {
        if (r.statusCode !== 200) { r.resume(); fail(); return; }
        r.setEncoding('utf8');
        r.on('data', c => { h += c; if (h.length > 4e6) req.destroy(); });
        r.on('end', () => ok(h));
      });
      req.on('error', fail);
      req.setTimeout(15000, () => { req.destroy(); fail(); });
    }
    getHtml(1, h => {
      const imgs = parseIgEmbedImages(h);
      if (!imgs.length) { resolve([]); return; }
      const written = [];
      let i = 0;
      const next = () => {
        if (i >= imgs.length) { written.source = 'embed'; resolve(written); return; }   // (dev0678)
        const idx = i++, iu = imgs[idx];
        let ext = '.jpg';
        try { const e = path.extname(new URL(iu).pathname); if (/^\.(jpe?g|png|webp)$/i.test(e)) ext = e; } catch (_) {}
        const dest = path.join(tmpDir, String(idx + 1).padStart(3, '0') + ext);
        igDownloadImage(iu, dest, permalink).then(ok => {
          if (ok) written.push(dest); else { try { fs.unlinkSync(dest); } catch (_) {} }
          next();
        });
      };
      next();
    });
    }
  });
}

// (dev0519) Pull the reel/video MP4 URL(s) out of the LOGGED-OUT main /p/ page.
// The intent was an og:video:secure_url scrape (parallel to how pickIgFullCover reads
// og:image), BUT a live probe showed IG serves og:type="article" and NO og:video tag
// for reels now — the playable MP4 is instead embedded in the page's inline JSON as
// `"video_versions":[{ "type":101, "url":"…mp4?…", … }]`. That signed CDN URL fetches
// cookielessly (verified 206 video/mp4). Take the FIRST url of each video_versions group
// (IG lists the highest quality first; the probe's first url returned full video/mp4);
// dedup across groups so a video carousel yields one URL per clip. Returns [] when the
// page carries none (a photo post → no video_versions).
function pickIgVideoUrls(html) {
  if (!html) return [];
  const out = [], seen = new Set();
  const re = /"video_versions"\s*:\s*\[([^\]]*)\]/g;   // objects are flat → no nested ']'
  let g;
  while ((g = re.exec(html))) {
    const um = g[1].match(/"url"\s*:\s*"([^"]+)"/);
    if (!um) continue;
    const u = um[1].replace(/\\u0026/gi, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
    if (!seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}
// (dev0519) Cookieless video-download fallback for REEL / video /p posts — the mirror of
// igEmbedImageFallback (which rescues photo posts). yt-dlp now login-walls reels
// cookielessly (dev0518), but the logged-out /p/ page still embeds the signed MP4 CDN
// URL in its video_versions JSON, and that URL downloads cookieless (short UA + IG
// Referer + fresh socket — the same recipe that beats the photo wall). Writes each clip
// into tmpDir with the NNN.mp4 autonumber scheme igDownload()'s publish() expects.
// Resolves the files written ([] → caller falls through to its 502). Photo posts return
// [] (no video_versions) so this never mis-fires on them.
function igMainVideoFallback(url, id, tmpDir) {
  return new Promise(resolve => {
    const m = IG_SHORTCODE_RE.exec(url || '');
    if (!m) { resolve([]); return; }
    const sc = m[1];
    const permalink = 'https://www.instagram.com/p/' + sc + '/';
    const opts = { agent: false, headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9', 'Referer': permalink, 'Connection': 'close'
    } };
    let h = '';
    const req = https.get(permalink, opts, r => {
      if (r.statusCode !== 200) { r.resume(); resolve([]); return; }
      r.setEncoding('utf8');
      r.on('data', c => { h += c; if (h.length > 6e6) req.destroy(); });
      r.on('end', () => {
        const vids = pickIgVideoUrls(h);
        if (!vids.length) { resolve([]); return; }
        const written = [];
        let i = 0;
        const next = () => {
          if (i >= vids.length) { resolve(written); return; }
          const idx = i++;
          const dest = path.join(tmpDir, String(idx + 1).padStart(3, '0') + '.mp4');
          igDownloadImage(vids[idx], dest, permalink, 0, '*/*').then(ok => {
            if (ok) written.push(dest); else { try { fs.unlinkSync(dest); } catch (_) {} }
            next();
          });
        };
        next();
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(20000, () => { req.destroy(); resolve([]); });
  });
}

// (dev0520) Bracket-match a JSON array/object embedded in HTML, starting at the '[' or
// '{' at openIdx. String-aware (skips brackets inside quoted strings, honours \escapes)
// so a URL/text value containing a bracket can't miscount depth. Returns the exact
// substring (a valid JSON doc) or null. The logged-out /p/ page carries RAW JSON blobs
// (quotes unescaped, `\/` and `\uXXXX` are standard JSON escapes JSON.parse resolves).
function matchBracketedJson(html, openIdx) {
  const open = html[openIdx];
  if (open !== '[' && open !== '{') return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = openIdx; i < html.length; i++) {
    const ch = html[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
    else if (ch === '"') inStr = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') { if (--depth === 0) return html.slice(openIdx, i + 1); }
  }
  return null;
}
// (dev0520) The VALIDATED full-carousel walker (the on-hold idea from the IG memo). The
// logged-out /p/ page embeds the WHOLE carousel in its inline `"carousel_media":[…]`
// JSON — each item is either a photo (image_versions2.candidates, largest-first, full
// 1440px = gallery-dl parity) or a clip (video_versions). Returns [{kind,url}] in post
// order (mixed photo+video carousels handled per item). All URLs download COOKIELESSLY
// off the same lenient OG/metadata surface as enrich + cover-only + the reel path — so a
// multi-item photo/mixed /p no longer needs gallery-dl + Firefox cookies. `"carousel_media"`
// can also appear as a bare field-name reference elsewhere on the page, so anchor on
// `"carousel_media":[`, scan every match, and keep the one with the most items.
// (dev0690) A cdninstagram URL's `stp=` parameter describes the transform IG applied.
// A leading `c<top>.<left>.<w>.<h>a_` token means the image was CROPPED (usually to a
// square), and a `s|p<W>x<H>` token means it was resized. The full-res original is the
// candidate with NEITHER. Mirrors pickIgFullCover's reasoning — that function exists
// because dev0677 shipped a cropped 640² og:image as "the cover" for months.
function igCandCropped(u) { return /[?&]stp=c\d+\.\d+\.\d+\.\d+/i.test(String(u || '')); }
function pickIgCarouselMedia(html) {
  if (!html) return [];
  const re = /"carousel_media"\s*:\s*\[/g; let m, best = [];
  while ((m = re.exec(html))) {
    const arrStr = matchBracketedJson(html, m.index + m[0].length - 1);   // -1 → the '['
    if (!arrStr) continue;
    let items; try { items = JSON.parse(arrStr); } catch (_) { continue; }
    if (Array.isArray(items) && items.length > best.length) best = items;
  }
  const out = [];
  for (const it of best) {
    if (!it || typeof it !== 'object') continue;
    // (dev0690) `code` is the ITEM's own shortcode, and it is the exact value yt-dlp
    // reports as each carousel entry's %(id)s — VERIFIED live on DY-r79ADcUC, whose
    // five video items are DY-r1qPjRvd … DY-r3C_jUL1 on both sides. That makes it a
    // join key, so the yt-dlp upgrade below never has to guess at slot POSITIONS
    // (which would silently shuffle clips whenever a photo sits mid-carousel).
    const code = String(it.code || '');
    // Video item → its MP4 (prefer over the poster the item ALSO carries in
    // image_versions2). Photo item → the largest UNCROPPED candidate.
    // `w`/`h` are the page's DECLARED native size for the item. On the logged-out
    // surface a video's declared size is the capped one (720x960 where the real source
    // is 1080x1440), so treat it as a FLOOR — "whatever we fetch should be at least
    // this" — never as the truth about the source.
    const w = +it.original_width || 0, h = +it.original_height || 0;
    if (Array.isArray(it.video_versions) && it.video_versions.length && it.video_versions[0] && it.video_versions[0].url) {
      out.push({ kind: 'video', url: it.video_versions[0].url, code, w, h });
    } else if (it.image_versions2 && Array.isArray(it.image_versions2.candidates) && it.image_versions2.candidates.length) {
      // (dev0690) The old rule was "widest declared width, else candidates[0]". On a
      // photo item IG omits width/height from EVERY candidate (verified: 14 candidates,
      // all `width:undefined`), so it fell through to candidates[0] — which happens to
      // be the uncropped original, so photos were fine by luck. Where it could bite is a
      // page that DOES declare widths: the square crops (`c0.504.3024.3024a_…s1080x1080`)
      // can out-declare the real original. Rank uncropped first, then by declared width,
      // then by list order (IG lists largest-first), so both cases land on the original.
      const cands = it.image_versions2.candidates
        .map((x, i) => ({ x, i }))
        .filter(e => e.x && e.x.url)
        .sort((a, b) => (igCandCropped(a.x.url) - igCandCropped(b.x.url))
                     || ((+b.x.width || 0) - (+a.x.width || 0))
                     || (a.i - b.i));
      if (cands.length) out.push({ kind: 'image', url: cands[0].x.url, code, w, h });
    }
  }
  return out;
}
// (dev0520) Cookieless FULL-carousel download for a multi-item /p post (photos, videos,
// or mixed) — the generalisation of dev0519's single-video igMainVideoFallback. Fetches
// the logged-out /p/ page, walks carousel_media, and writes EVERY item into tmpDir with
// the NNN.<ext> autonumber scheme igDownload()'s publish() expects. No Firefox cookies.
// (dev0690) Now resolves an OBJECT, not a bare file list, because two callers need to
// know things a file list cannot express:
//   files  — the paths written (as before; empty → the caller's single-item rescue)
//   items  — the carousel INVENTORY [{kind,url,code}] (drives the yt-dlp video upgrade
//            and the row's new Carousel count)
//   slots  — items-indexed, slots[i] = the file written for item i, or null if that one
//            item failed. `files` cannot say WHICH item is missing; the upgrade must
//            know, or it would fill a gap with the wrong clip.
//   single — the page loaded AND carries no carousel_media at all → a genuinely
//            single-item post. Distinguishes that from "the walk was throttled", which
//            also yields no items but says nothing about the post.
//   upgraded / videoItems — how many video items came from yt-dlp, of how many.
//
// (dev0690) …and the SOURCE per item changed. dev0648 fetched every item — photos and
// videos alike — from the logged-out page. That page's video surface is hard-capped at
// 720p (see igCarouselYtdlpVideos), which quietly took the collection from 65.5% to
// 47.2% of videos at ≥1080. Now: photos still come from the page (they are the full
// uncropped originals there), while video items come from ONE yt-dlp spawn that fetches
// the whole post at max res. The page's video_versions URL survives as the per-item
// RESCUE, used only when yt-dlp didn't produce that item or produced a smaller one — so
// a walled/failed yt-dlp degrades exactly to dev0648's behaviour, never below it.
// Deliberately not "download both and pick": that would double every carousel's IG
// requests, and IG throttling is the single biggest cost in a long grind.
function igMainCarouselFallback(url, id, tmpDir) {
  const none = { files: [], items: [], slots: [], single: false, upgraded: 0, videoItems: 0 };
  return new Promise(resolve => {
    const m = IG_SHORTCODE_RE.exec(url || '');
    if (!m) { resolve(none); return; }
    const sc = m[1];
    const permalink = 'https://www.instagram.com/p/' + sc + '/';
    // (dev0647) Node-first, curl_cffi-impersonate-if-walled — beats IG's VPN photo wall.
    igGetPageHtml(permalink, 8e6, null, igPageHasMedia).then(h => {
      const items = h ? pickIgCarouselMedia(h) : [];
      // igPageHasMedia gates the fetch, so a non-empty `h` IS a real media page: no
      // carousel_media key there means one item, not a failed read.
      const single = !!h && !/"carousel_media"\s*:\s*\[\s*\{/.test(h);
      if (items.length < 2) { resolve({ files: [], items: [], slots: [], single, upgraded: 0, videoItems: 0 }); return; }
      const vidCount = items.filter(it => it.kind === 'video' && it.code).length;
      const upDir = path.join(tmpDir, '.up');   // dot-prefixed → invisible to tmpFiles()
      // A photo-only carousel never spawns yt-dlp: it is a video tool and has nothing
      // to add, and the page already carries those photos at full resolution.
      // RETURNED, so a rejection anywhere below reaches the .catch at the bottom. Without
      // the return this inner chain is detached: a throw would leave the outer promise
      // pending forever and hang /ig/download — and with it the whole grind round.
      return (vidCount ? igCarouselYtdlpVideos(url, upDir, vidCount) : Promise.resolve({})).then(byCode => {
        const slots = new Array(items.length).fill(null);
        const slotPath = (idx, ext) => path.join(tmpDir, String(idx + 1).padStart(3, '0') + ext);
        let adopted = 0, i = 0;
        const next = () => {
          if (i >= items.length) {
            try { (fs.rmSync || fs.rmdirSync)(upDir, { recursive: true, force: true }); } catch (_) {}
            resolve({ files: slots.filter(Boolean), items, slots, single: false,
                      upgraded: adopted, videoItems: vidCount });
            return;
          }
          const idx = i++, it = items[idx];
          // 1 — yt-dlp's copy, joined on the item's `code` (never on position, so a photo
          //     sitting mid-carousel cannot shift clips into the wrong slots). Accepted
          //     outright when it is at least as wide as the page declares the item to be.
          const src = (it.kind === 'video' && it.code) ? byCode[it.code] : null;
          const dNew = src ? probeMediaDims(src) : null;
          if (dNew && (!it.w || dNew.w >= it.w)) {
            const dest = slotPath(idx, path.extname(src) || '.mp4');
            try { fs.renameSync(src, dest); slots[idx] = dest; adopted++; next(); return; } catch (_) {}
          }
          // 2 — otherwise fetch the item from the page, as dev0648 always did.
          const dest = slotPath(idx, it.kind === 'video' ? '.mp4' : '.jpg');
          igDownloadImage(it.url, dest, permalink, 0, it.kind === 'video' ? '*/*' : undefined).then(ok => {
            if (!ok) { try { fs.unlinkSync(dest); } catch (_) {} }
            // 3 — and if yt-dlp DID have this item after all (it just looked small, or
            //     the page fetch failed), keep whichever file actually has more pixels.
            //     Pixels, not bytes: the 720p progressive h264 is often the bigger file.
            if (dNew) {
              const dOld = ok ? probeMediaDims(dest) : null;
              if (!dOld || dNew.w * dNew.h > dOld.w * dOld.h) {
                // Secure the replacement BEFORE discarding what we have. rename overwrites
                // an existing target on every platform Node supports, so when d2 and dest
                // are the same path (both .mp4, the usual case) this is a single atomic
                // swap; only a differing extension leaves a stale file to clean up after.
                const d2 = slotPath(idx, path.extname(src) || '.mp4');
                let took = false;
                try { fs.renameSync(src, d2); took = true; }
                catch (_) { try { fs.copyFileSync(src, d2); took = true; } catch (_) {} }
                if (took) {
                  if (ok && d2 !== dest) { try { fs.unlinkSync(dest); } catch (_) {} }
                  slots[idx] = d2; adopted++; next(); return;
                }
              }
            }
            if (ok) slots[idx] = dest;
            next();
          });
        };
        next();
      });
    // A rejection here used to leave the promise pending forever, hanging /ig/download
    // (and with it a whole grind round) on a single bad page read.
    }).catch(() => resolve(none));
  });
}

// (dev0690) Real pixel dimensions of a file already on disk: ffprobe for video, header
// bytes for stills. Synchronous by design — every caller is deciding, right then, which
// of two files to keep, and both are local. Returns null when the file can't be read,
// and every caller treats null as "no opinion" rather than "zero pixels".
//
// Memoized on path+size+mtime, because a carousel's video files get measured twice: once
// by the walker choosing between yt-dlp's copy and the page's, and again by publish().
// ffprobe is a process spawn and the proxy is single-threaded, so on a 15-item post that
// is 15 spawns of avoidable event-loop blocking. The size+mtime key means a file that was
// REPLACED at the same path (exactly what the walker does) re-measures rather than
// returning the previous occupant's dimensions.
const _dimMemo = new Map();
function probeMediaDims(file) {
  let key = '';
  try { const st = fs.statSync(file); key = file + '|' + st.size + '|' + st.mtimeMs; } catch (_) { return null; }
  if (_dimMemo.has(key)) return _dimMemo.get(key);
  const d = _probeMediaDimsUncached(file);
  if (_dimMemo.size > 500) _dimMemo.clear();   // bounded — this is a long-running process
  _dimMemo.set(key, d);
  return d;
}
function _probeMediaDimsUncached(file) {
  try {
    if (/\.(mp4|mov|webm|mkv|m4v)$/i.test(file)) {
      const raw = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file],
        { encoding: 'utf8', timeout: 15000 }).trim();
      const mm = raw.match(/(\d+)x(\d+)/);
      return mm ? { w: +mm[1], h: +mm[2] } : null;
    }
    const buf = Buffer.alloc(65536);
    const fd = fs.openSync(file, 'r');
    const n = fs.readSync(fd, buf, 0, 65536, 0);
    fs.closeSync(fd);
    const d = parseImageDims(buf.slice(0, n));
    return d && d.width && d.height ? { w: d.width, h: d.height } : null;
  } catch (_) { return null; }
}

// (dev0690) Download a carousel's VIDEO items with yt-dlp, into their own directory,
// named by each entry's %(id)s — which is the carousel item's `code`. Resolves a
// { code: filepath } map (empty on any failure: the caller then simply keeps what the
// walker already fetched, so this can only ever improve a result, never damage one).
//
// WHY THIS EXISTS: dev0648 put the cookieless walker FIRST for every /p post, to fix
// mixed photo+video carousels that yt-dlp returned half of. That was right about
// completeness and wrong about resolution — the logged-out page's video_versions are
// three entries all pointing at ONE 720-wide progressive MP4 (…CAROUSEL_ITEM.C3.720…)
// with no width/height to choose between, and its DASH manifest offers only 720p/360p.
// yt-dlp bootstraps a session and reaches the full ladder: 1080x1440 where the walker
// gets 720x960 (measured, same post, same minute). Collection-wide that cost 65.5% →
// 47.2% of videos at ≥1080. So: walker for the inventory, yt-dlp for the video bytes.
//
// A photo item makes yt-dlp raise "No video formats found" for that entry; --ignore-errors
// keeps the rest of the playlist going, and the exit code is ignored entirely — what
// landed in the directory is the only thing that counts.
function igCarouselYtdlpVideos(url, outDir, nVideos) {
  return new Promise(resolve => {
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}
    const impersonate = IG_IMPERSONATE ? ['--impersonate', IG_IMPERSONATE] : [];
    const args = ['--no-warnings', '--ignore-config', '--socket-timeout', '20', '--no-part',
                  '--ignore-errors']
      .concat(impersonate, ['-o', path.join(outDir, '%(id)s.%(ext)s'), url]);
    let proc, done = false;
    const finish = () => {
      if (done) return; done = true;
      ACTIVE_DL.delete(proc); clearTimeout(killT);
      const out = {};
      try {
        for (const f of fs.readdirSync(outDir)) {
          if (f.startsWith('.') || /\.part$/i.test(f)) continue;
          // Key on the stem. Intermediate per-format files (`<id>.f303.webm`) would key
          // as "<id>.f303", which matches no item code, so they can never be adopted.
          out[f.replace(/\.[^.]+$/, '')] = path.join(outDir, f);
        }
      } catch (_) {}
      resolve(out);
    };
    try { proc = spawn('yt-dlp', args, { windowsHide: true }); }
    catch (_) { resolve({}); return; }
    ACTIVE_DL.add(proc);   // (dev0658) killable by the VPN kill-switch
    // dev0645's flat 90s wall-clock is a SINGLE-item budget; this one spawn fetches the
    // whole carousel, so scale with the work and still cap it.
    const killT = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} finish(); },
      Math.min(240000, 60000 + 30000 * Math.max(1, nVideos)));
    proc.stderr.on('data', () => {});    // drain (a photo item always writes one error)
    proc.on('error', finish);
    proc.on('close', finish);
  });
}


// (dev0495) Download EVERY image of an IG photo carousel with gallery-dl, straight into
// tmpDir as ordered 001.jpg, 002.jpg … (the same autonumber scheme igDownload's
// publish() expects). Always uses Firefox cookies because IG redirects gallery-dl to
// the login page cookielessly. Resolves the basenames written (empty → caller falls
// through to the embed last resort). A watchdog kills a hung process.
function galleryDlImages(url, tmpDir) {
  return new Promise(resolve => {
    if (!IG_GALLERYDL) { resolve([]); return; }
    const args = ['-D', tmpDir, '--no-part', '-f', '{num:>03}.{extension}',
                  '--cookies-from-browser', 'firefox', '--', url];
    let proc;
    try { proc = spawn(GALLERY_DL, args, { windowsHide: true }); }
    catch (_) { resolve([]); return; }
    ACTIVE_DL.add(proc);   // (dev0658) killable by the VPN kill-switch
    let done = false;
    const finish = () => {
      if (done) return; done = true; ACTIVE_DL.delete(proc);
      let files = [];
      try { files = fs.readdirSync(tmpDir).filter(f => !f.startsWith('.') && !f.endsWith('.part')).sort(); } catch (_) {}
      resolve(files);
    };
    const watchdog = setTimeout(() => { try { proc.kill(); } catch (_) {} }, 180000);
    proc.on('error', () => { clearTimeout(watchdog); finish(); });
    proc.on('close', () => { clearTimeout(watchdog); finish(); });
  });
}

// (dev0433) ytdlp -J collector: buffer the (possibly large) JSON document, parse it,
// and send the COMPACT flattened object to the client (keeps the response small).
// (dev0442) Cookieless FIRST, then Firefox cookies if that fails/returns nothing —
// SAME fallback /ig/download already had. Instagram now login-walls most cookieless
// metadata, so enrich was failing on nearly every post ("login-walled") while
// downloads (which had the cookie fallback) worked. `usedCookies` tells the client
// which path won, so it can report cookie usage honestly. The cookie variant is the
// base args with `--cookies-from-browser firefox` inserted before the URL (last arg).
function streamYtdlpMeta(req, res, bin, args) {
  const origin = req.headers.origin || '';
  const headers = Object.assign({}, corsForExec(origin), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  let ended = false;
  const finish = obj => { if (ended) return; ended = true; res.writeHead(200, headers); res.end(JSON.stringify(obj)); };
  const t0 = Date.now();
  const lastUrl = args[args.length - 1];   // (dev0460) the validated http(s) URL

  function attempt(useCookies, prevErr) {
    const a = useCookies
      ? args.slice(0, -1).concat(['--cookies-from-browser', 'firefox', args[args.length - 1]])
      : args;
    let proc;
    try { proc = spawn(bin, a, { windowsHide: true }); }
    catch (err) { finish({ ok: false, error: err.message, exitCode: -1, durationMs: Date.now() - t0 }); return; }
    let out = '', errOut = '';
    proc.stdout.on('data', c => { out += c.toString('utf8'); });
    proc.stderr.on('data', c => { errOut += c.toString('utf8'); });
    proc.on('error', err => finish({ ok: false, error: err.message, exitCode: -1, durationMs: Date.now() - t0 }));
    proc.on('close', code => {
      let raw = null; try { raw = JSON.parse(out || '{}'); } catch (_) {}
      const result = ytdlpCompact(raw);
      const good = code === 0 && !!result;
      // Cookieless failed/empty → retry once with Firefox cookies (login walls).
      // (dev0459) …unless cookies are disabled — then a wall just fails cookielessly.
      if (!good && !useCookies && IG_USE_COOKIES) { attempt(true, errOut.trim()); return; }
      // (dev0460) Image-only IG posts: yt-dlp raises "There is no video in this post"
      // and drops the caption. Recover caption+author from the cookieless embed page.
      // Tried for ANY non-good instagram.com URL (embed is one cheap, cookieless GET;
      // also rescues a walled reel's caption). null embed → fall through to the error.
      if (!good && IG_SHORTCODE_RE.test(lastUrl || '')) {
        // (dev0511) Main /p/ page FIRST — it carries caption+author+date+cover even when
        // the embed/captioned page has degraded to IG's JS shell; embed page as a fallback.
        fetchIgMainMeta(lastUrl).then(meta => meta || fetchIgEmbedMeta(lastUrl)).then(embed => {
          if (embed) {
            finish({ ok: true, exitCode: 0, durationMs: Date.now() - t0, result: embed, viaEmbed: true });
          } else {
            // (dev0461) Embed couldn't read it either → unreadable cookielessly (IG is
            // rate-limiting/walling us right now, or the post is private/deleted).
            // Surface a WALL-CLASS message (contains "login required") so the client's
            // stop-at-first-wall fires. Previously the raw yt-dlp "There is no video in
            // this post" string surfaced here, which isWall() did NOT match → batches
            // kept hammering /p posts (accelerating the very rate-limit causing this).
            // _ytdlpFetchMeta throws (stderr || error), so the wall message goes in
            // stderr; the raw yt-dlp line is appended for debugging.
            const ytErr = (errOut.trim() || prevErr || '').split('\n').filter(Boolean).slice(-1)[0] || '';
            finish({
              ok: false, wall: true, exitCode: code, durationMs: Date.now() - t0,
              result: null, usedCookies: useCookies || undefined,
              stdout: String(out).slice(0, 500),
              stderr: 'login required — IG walled this post (cookieless yt-dlp + embed both failed)'
                    + (ytErr ? ' · ' + ytErr.slice(0, 120) : ''),
              error: ytErr || undefined
            });
          }
        });
        return;
      }
      finish({
        ok: good, exitCode: code, durationMs: Date.now() - t0,
        result, usedCookies: useCookies || undefined,
        stdout: result ? undefined : String(out).slice(0, 500),
        stderr: (errOut.trim() || prevErr) || undefined
      });
    });
    req.on('close', () => { try { proc.kill(); } catch (_) {} });
  }
  attempt(false, '');
}

const EXEC_ALLOW = {
  ffmpeg:   buildFfmpegArgs,
  ffprobe:  buildFfprobeArgs,
  exiftool: buildExiftoolArgs,
  ytdlp:    buildYtdlpArgs
};
// (dev0425) Route name → actual binary, when they differ. /exec/ytdlp spawns
// 'yt-dlp' (hyphenated binary; JS-friendly route key). Anything not listed here
// spawns under its own route name (ffmpeg/ffprobe/exiftool).
const EXEC_BIN = { ytdlp: 'yt-dlp' };

// (dev0289) Read a JSON body with a hard size cap. Refuses bodies > maxBytes
// (returns reject) so a misbehaving caller can't OOM the proxy.
function readJson(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let len = 0;
    const chunks = [];
    req.on('data', c => {
      len += c.length;
      if (len > maxBytes) { req.destroy(); reject(new Error(`body > ${maxBytes} bytes`)); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('invalid JSON: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

// (dev0289) ffmpeg's -progress pipe:1 emits key=value lines, terminated by
// 'progress=continue' or 'progress=end'. Accumulate until terminator, then
// emit one {type:'progress', ...} event with the parsed fields we care about.
function makeProgressParser(emit) {
  let buf = '';
  let cur = {};
  return chunk => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (k === 'progress') {
        // Emit accumulated frame.
        const ev = { type: 'progress' };
        if (cur.frame != null)    ev.frame  = +cur.frame || 0;
        if (cur.fps != null)      ev.fps    = +cur.fps || 0;
        if (cur.out_time_ms)      ev.timeMs = Math.round(+cur.out_time_ms / 1000);
        if (cur.out_time_us)      ev.timeMs = Math.round(+cur.out_time_us / 1000);
        if (cur.speed)            ev.speed  = cur.speed; // e.g. "1.2x"
        if (cur.total_size)       ev.bytes  = +cur.total_size || 0;
        ev.done = (v === 'end');
        emit(ev);
        cur = {};
      } else {
        cur[k] = v;
      }
    }
  };
}

// Split a stderr chunk into lines, buffering partials across chunk boundaries.
function makeLineSplitter(emit) {
  let buf = '';
  return chunk => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line) emit(line);
    }
  };
}

// (dev0289) Spawn the binary, NDJSON-stream stdout(progress)/stderr/done to
// the response. Uses shell:false (the default) so argv strings are literal.
function streamExec(req, res, bin, args) {
  const origin = req.headers.origin || '';
  const headers = Object.assign({}, corsForExec(origin), {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-store'
  });
  res.writeHead(200, headers);
  const emit = obj => { try { res.write(JSON.stringify(obj) + '\n'); } catch (_) {} };
  emit({ type: 'start', cmd: [bin, ...args] });

  let proc;
  try {
    proc = spawn(bin, args, { windowsHide: true });
  } catch (err) {
    emit({ type: 'done', error: err.message, exitCode: -1 });
    res.end();
    return;
  }
  const t0 = Date.now();
  const onProgress = makeProgressParser(emit);
  const onStderr   = makeLineSplitter(line => emit({ type: 'stderr', line }));
  proc.stdout.on('data', onProgress);
  proc.stderr.on('data', onStderr);
  proc.on('error', err => {
    emit({ type: 'done', error: err.message, exitCode: -1, durationMs: Date.now() - t0 });
    res.end();
  });
  proc.on('close', code => {
    emit({ type: 'done', exitCode: code, durationMs: Date.now() - t0 });
    res.end();
  });
  // If the client disconnects mid-job, kill the child to avoid orphans.
  req.on('close', () => { try { proc.kill(); } catch (_) {} });
}

// (dev0391) Non-streaming exec for ffprobe: buffer stdout fully and return one
// JSON response. streamExec pipes stdout through the ffmpeg progress parser,
// which would mangle ffprobe's JSON — so probe-style binaries use this instead.
function streamExecCollect(req, res, bin, args) {
  const origin = req.headers.origin || '';
  const headers = Object.assign({}, corsForExec(origin), {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  });
  let ended = false;
  const finish = obj => {
    if (ended) return; ended = true;
    res.writeHead(200, headers);
    res.end(JSON.stringify(obj));
  };
  let proc;
  try {
    proc = spawn(bin, args, { windowsHide: true });
  } catch (err) {
    finish({ ok: false, error: err.message, exitCode: -1 });
    return;
  }
  const t0 = Date.now();
  let out = '', errOut = '';
  proc.stdout.on('data', c => { out += c.toString('utf8'); });
  proc.stderr.on('data', c => { errOut += c.toString('utf8'); });
  proc.on('error', err => finish({ ok: false, error: err.message, exitCode: -1, durationMs: Date.now() - t0 }));
  proc.on('close', code => {
    let parsed = null;
    try { parsed = JSON.parse(out || '{}'); } catch (_) {}
    finish({
      ok: code === 0,
      exitCode: code,
      durationMs: Date.now() - t0,
      result: parsed,
      stdout: parsed == null ? out : undefined,
      stderr: errOut.trim() || undefined
    });
  });
  req.on('close', () => { try { proc.kill(); } catch (_) {} });
}

function send(res, code, msg, extraHeaders) {
  const h = Object.assign({ 'Content-Type': 'text/plain' }, extraHeaders || {});
  res.writeHead(code, h);
  res.end(msg);
}

function sendJson(res, code, obj, origin) {
  const h = Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                          corsForExec(origin || ''));
  res.writeHead(code, h);
  res.end(JSON.stringify(obj));
}

// (dev0418) ── /rec/* screen recorder ─────────────────────────────────────
// A POC screen-capture bridge for the V "floating step control" (fsc). The
// browser can neither grab the screen silently nor write to the project
// folder, but this proxy (running as the user's own desktop process) can —
// so the fsc "Choose" button just toggles ffmpeg's Windows gdigrab capture:
//   POST /rec/start  → spawn ffmpeg gdigrab → vsteps-<ts>.mp4 in the project
//                      folder (this proxy's dir). Optional {fps, region}.
//   POST /rec/stop   → 'q' on ffmpeg's stdin = graceful finalize (writes the
//                      moov atom so the mp4 is playable), then return the path.
// Single-recording model (one user, one screen). Origin-locked like /exec/.
//
// Graceful stop matters on Windows: Node's proc.kill() maps to TerminateProcess
// (hard kill) which would leave the mp4 without its moov atom → unplayable.
// ffmpeg quits cleanly when it reads 'q' from stdin, so we spawn with a piped
// stdin and write 'q' to stop; a hard-kill timer is only a last-resort fallback.
let currentRec = null;   // { proc, output, t0, exited, exitCode, stderrTail() }

function recTimestamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
         '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

// Build the gdigrab argv. Full primary desktop by default; an optional
// {region:{x,y,w,h}} crops to a screen rect (device pixels). Re-encoded
// ultrafast/yuv420p for real-time capture + broad playability. All numeric
// fields are validated here, so argv stays literal under spawn(shell:false).
function buildGdigrabArgs(p, outPath) {
  const fps = (Number.isFinite(+p.fps) && +p.fps >= 1 && +p.fps <= 60)
              ? Math.round(+p.fps) : 30;
  const args = ['-hide_banner', '-loglevel', 'warning',
                '-f', 'gdigrab', '-framerate', String(fps)];
  if (p.region) {
    const r = p.region;
    for (const k of ['x', 'y', 'w', 'h'])
      must(Number.isInteger(r[k]) && r[k] >= 0, `region.${k} must be a non-negative integer`);
    must(r.w > 0 && r.h > 0, 'region.w/h must be > 0');
    const w = r.w - (r.w % 2), h = r.h - (r.h % 2);   // even dims for yuv420p
    args.push('-offset_x', String(r.x), '-offset_y', String(r.y),
              '-video_size', w + 'x' + h);
  }
  args.push('-i', 'desktop',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            '-y', outPath);
  return args;
}

function recStart(req, res, origin) {
  if (currentRec) {
    sendJson(res, 409, { ok: false, error: 'already recording', output: currentRec.output }, origin);
    return;
  }
  readJson(req, 16 * 1024).then(payload => {
    const output = path.join(__dirname, 'vsteps-' + recTimestamp() + '.mp4');
    let args;
    try { args = buildGdigrabArgs(payload, output); }
    catch (e) { sendJson(res, 400, { ok: false, error: e.message }, origin); return; }

    let proc;
    try { proc = spawn('ffmpeg', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { sendJson(res, 500, { ok: false, error: e.message }, origin); return; }

    let tail = '';
    proc.stderr.on('data', c => { tail = (tail + c.toString('utf8')).slice(-2000); });
    const rec = { proc, output, t0: Date.now(), exited: false, exitCode: null,
                  stderrTail: () => tail.trim() };
    proc.on('error', err => { rec.exited = true; rec.spawnError = err.message;
                              if (currentRec === rec) currentRec = null; });
    proc.on('close', code => { rec.exited = true; rec.exitCode = code;
                               if (currentRec === rec) currentRec = null; });
    currentRec = rec;
    console.log('[rec start] ffmpeg →', output);
    sendJson(res, 200, { ok: true, output, pid: proc.pid }, origin);
  }).catch(err => sendJson(res, 400, { ok: false, error: err.message }, origin));
}

function recStop(req, res, origin) {
  const rec = currentRec;
  if (!rec) { sendJson(res, 409, { ok: false, error: 'not recording' }, origin); return; }
  currentRec = null;
  const finish = () => {
    const durationMs = Date.now() - rec.t0;
    const ok = rec.exitCode === 0 || rec.exitCode == null;
    console.log('[rec stop ]', rec.output, '· exit', rec.exitCode, '·', durationMs + 'ms');
    sendJson(res, 200, { ok, output: rec.output, durationMs,
                         exitCode: rec.exitCode, stderr: rec.stderrTail() || undefined }, origin);
  };
  if (rec.exited) { finish(); return; }
  let done = false;
  const killT = setTimeout(() => {                 // last resort: hard kill
    if (done) return;
    console.warn('[rec stop ] graceful quit timed out — killing ffmpeg');
    try { rec.proc.kill(); } catch (_) {}
  }, 7000);
  rec.proc.on('close', () => { if (done) return; done = true; clearTimeout(killT); finish(); });
  try { rec.proc.stdin.write('q'); } catch (_) {}  // ffmpeg: 'q' = graceful finalize
  try { rec.proc.stdin.end(); } catch (_) {}
}

// (dev0564/0565) ── /frame/grab — step-clip builder for G's step-frame mode ───
// V's step panel Save (and G's on-demand fallback) POSTs {url, name, x, s, d}
// so the grid (hotkey A) can show saved steps as a plain looping <video> — the
// only way to display YT frames with ZERO player chrome (no centre play
// button; see video.js _gridPlayStepsRoute). yt-dlp -g resolves the direct
// googlevideo/CDN stream URL (skipped when the row link is already a direct
// media file), then a two-pass ffmpeg: (1) input-seek to s/30 and extract the
// d+1 window frames on the app's 30fps clock; (2) assemble them into
// steps/<name> = "<VidTitle>.<x_s_d>.mp4" with each frame HELD x seconds
// (input -framerate 1/x, output 30fps) — the stepped playback baked into the
// file. Freeze steps (x=0 or d=0) become a 5s single-frame still clip. The
// grid computes the same name client-side (video.js stepClipName) and loops
// the mp4 muted. LOCAL ONLY: steps/ is gitignored — grabbed YT material must
// never be committed or served publicly (YT TOS). Grabs need the HOME IP:
// yt-dlp/googlevideo 403 behind a VPN ([frame 403]s in this log = VPN on).
const STEPS_DIR    = path.join(__dirname, 'steps');
const STEP_MAX     = 301;   // most frames per clip (caps d at 300)
const STEP_FMT     = 'bv*[height<=1080][ext=mp4]/bv*[height<=1080]/bv*/b';
const FREEZE_SECS  = 5;     // still-clip length for freeze frames (loops seamlessly)
let   _stepTmpSeq  = 0;     // unique temp-dir suffix per request

// Run a binary to completion, collecting stdout + a stderr tail (no streaming).
function frameRunCollect(bin, args, timeoutMs) {
  return new Promise(resolve => {
    let proc;
    try { proc = spawn(bin, args, { windowsHide: true }); }
    catch (e) { resolve({ code: -1, out: '', err: e.message }); return; }
    let out = '', err = '';
    proc.stdout.on('data', c => { out += c.toString('utf8'); });
    proc.stderr.on('data', c => { err = (err + c.toString('utf8')).slice(-4000); });
    const killT = setTimeout(() => { try { proc.kill(); } catch (_) {} }, timeoutMs);
    proc.on('error', e => { clearTimeout(killT); resolve({ code: -1, out, err: err || e.message }); });
    proc.on('close', code => { clearTimeout(killT); resolve({ code, out, err }); });
  });
}

async function frameGrab(req, res, origin) {
  let p;
  try { p = await readJson(req, 64 * 1024); }
  catch (e) { sendJson(res, 400, { ok: false, error: e.message }, origin); return; }
  let tmpDir = null;
  try {
    must(typeof p.url === 'string' && /^https?:\/\//i.test(p.url), 'url must be http(s)');
    must(p.url.length <= 2048, 'url too long (max 2048)');
    // name is computed client-side by stepClipName (video.js) — VALIDATE, never
    // transform, so the grid's computed src always matches the file on disk.
    const name = String(p.name == null ? '' : p.name);
    must(/^[\x20-\x7E]{5,140}$/.test(name) && name.endsWith('.mp4')
         && !/[\\/:*?"<>|]/.test(name) && !name.includes('..') && !name.startsWith('.'),
         'name must be a plain printable-ASCII *.mp4 filename (no path chars)');
    const x = +p.x, s = Math.round(+p.s), d = Math.round(+p.d);
    must(Number.isFinite(x) && x >= 0 && x <= 10, 'x must be a number 0-10');
    must(Number.isInteger(s) && s >= 0, 's must be an integer >= 0');
    must(Number.isInteger(d) && d >= 0, 'd must be an integer >= 0');
    const freeze = (x === 0 || d === 0);
    const n = freeze ? 1 : Math.min(d + 1, STEP_MAX);
    const t0 = Date.now();

    // Resolve a stream URL via yt-dlp, optionally as a specific YT player
    // client. --js-runtimes node lets the nightly solve YT's n-challenge
    // (same fix as the AHK downloader's 360p bug).
    async function resolveStream(client) {
      const args = ['--no-warnings', '--no-playlist', '--ignore-config',
                    '--socket-timeout', '20', '--js-runtimes', 'node'];
      if (client) args.push('--extractor-args', 'youtube:player_client=' + client);
      args.push('-f', STEP_FMT, '-g', p.url);
      const r = await frameRunCollect('yt-dlp', args, 45000);
      return { url: String(r.out).split(/\r?\n/).find(l => /^https?:\/\//i.test(l)) || '',
               err: r.err, code: r.code };
    }

    // Direct media links go straight to ffmpeg; everything else through yt-dlp.
    const isDirect = /\.(mp4|webm|m4v|mov|avi|mkv|ogv)([?#]|$)/i.test(p.url);
    let streamUrl = p.url, client = '';
    if (!isDirect) {
      const r = await resolveStream('');
      streamUrl = r.url;
      if (r.code !== 0 || !streamUrl) {
        sendJson(res, 502, { ok: false, error: 'yt-dlp could not resolve a stream URL'
          + (r.err ? ': ' + r.err.slice(-300) : '') }, origin);
        return;
      }
    }

    fs.mkdirSync(STEPS_DIR, { recursive: true });
    // Drop stale clips for the same title so a re-save with new times can't
    // leave the grid finding yesterday's window ("<base>.<x_s_d>.mp4").
    const base = name.replace(/\.[^.]*_[^.]*_[^.]*\.mp4$/, '');
    if (base && base !== name) {
      for (const f of fs.readdirSync(STEPS_DIR)) {
        if (f.startsWith(base + '.') && f.endsWith('.mp4')) {
          try { fs.unlinkSync(path.join(STEPS_DIR, f)); } catch (_) {}
        }
      }
    }

    // Pass 1 — extract the window frames. Input-seek to s/30, sample at fps=30
    // so frame indexes line up with the app's seekAbs(f/30) stepping regardless
    // of the source's real fps.
    tmpDir = path.join(STEPS_DIR, '.tmp-' + Date.now() + '-' + (++_stepTmpSeq));
    fs.mkdirSync(tmpDir, { recursive: true });
    const extract = async (url, timeoutMs) => {
      for (const f of fs.readdirSync(tmpDir)) {       // clean a failed prior attempt
        try { fs.unlinkSync(path.join(tmpDir, f)); } catch (_) {}
      }
      const r = await frameRunCollect('ffmpeg',
        ['-hide_banner', '-loglevel', 'warning', '-y',
         '-ss', (s / 30).toFixed(3), '-i', url,
         '-vf', 'fps=30', '-frames:v', String(n), '-q:v', '2',
         '-start_number', '0', path.join(tmpDir, 'f_%d.jpg')], timeoutMs);
      let k = 0;
      while (fs.existsSync(path.join(tmpDir, 'f_' + k + '.jpg'))) k++;
      return { got: k, err: r.err, code: r.code };
    };

    // (dev0566) Tiered attempt. Some YT videos are in the "PO-token-bound
    // streaming" experiment: without a PO token every decent https format is
    // withheld or TRICKLED to ~8KiB/s no matter the client (yt-dlp#12482), so
    // the full-res grab starves and hits the kill-timer. For those, retry via
    // the android player client — unthrottled but 360p-only cookieless. A
    // clean ffmpeg exit with fewer frames than asked = window ran past the end
    // of the video (legitimate), NOT a starve.
    let e1 = await extract(streamUrl, isDirect ? 300000 : 90000);
    let got = e1.got;
    const starved = !isDirect && !(got > 0 && (got === n || e1.code === 0));
    if (starved && /youtube\.com|youtu\.be/i.test(p.url)) {
      console.warn('[frame grab] full-res starved (' + got + '/' + n
        + ' frames) — retrying via android client at 360p:', name);
      const r2 = await resolveStream('android');
      if (r2.url) {
        const e2 = await extract(r2.url, 60000);
        if (e2.got > got) { got = e2.got; e1 = e2; client = 'android-360p'; }
      }
    }
    if (!got) throw new Error('ffmpeg extracted no frames'
      + (e1.err ? ': ' + e1.err.slice(-300) : ''));

    // Pass 2 — assemble the clip. Sequences: each frame lasts x seconds
    // (-framerate 1/x), re-timed to a standard 30fps stream. Freeze: one frame
    // looped for FREEZE_SECS. Even dims for yuv420p.
    const outPath = path.join(STEPS_DIR, name);
    const p2args = ['-hide_banner', '-loglevel', 'warning', '-y'];
    if (freeze || got === 1) {
      p2args.push('-loop', '1', '-framerate', '30', '-t', String(FREEZE_SECS),
                  '-i', path.join(tmpDir, 'f_0.jpg'));
    } else {
      p2args.push('-framerate', (1 / x).toFixed(4), '-start_number', '0',
                  '-i', path.join(tmpDir, 'f_%d.jpg'));
    }
    p2args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-r', '30',
                '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
                '-movflags', '+faststart', outPath);
    const p2 = await frameRunCollect('ffmpeg', p2args, 120000);
    if (!fs.existsSync(outPath)) throw new Error('ffmpeg wrote no clip'
      + (p2.err ? ': ' + p2.err.slice(-300) : ''));

    console.log('[frame grab]', name, '·', got + '/' + n, 'frames ·',
      (Date.now() - t0) + 'ms' + (client ? ' · ' + client : ''));
    sendJson(res, 200, { ok: true, file: name, frames: got, want: n, freeze,
                         client: client || undefined }, origin);
  } catch (e) {
    sendJson(res, e.message && /must|required|too long/.test(e.message) ? 400 : 502,
             { ok: false, error: e.message }, origin);
  } finally {
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} }
  }
}

// (dev0428) ── /ig/add — IG reel-URL staging store ────────────────────────────
// The Tampermonkey harvester (ig-harvest.user.js) auto-scrolls an author's profile
// in the user's own logged-in Firefox (reading rendered DOM only — no API/cookie
// replay IG could flag) and POSTs the collected URLs here via GM_xmlhttpRequest
// (privileged → bypasses browser CORS). We append the NEW ones — deduped by
// shortcode id — to ig.json, a store parallel to ml.json that deliberately stays
// OUT of the grid/table (IG doesn't fit the G scheme; could grow to 1000s of rows).
const IG_STORE = path.join(__dirname, 'ig.json');
function igShortcode(url) {
  const m = String(url || '').match(/instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : '';
}
function igIsoNow() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
       + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

// (dev0697) ── ONE ig.json store layer: parse once, write atomically ───────────
// WHY THIS EXISTS — the six-crash night of 2026-07-29/30, and every "the proxy
// died mid-grind" before it. Measured on this machine while IDLE:
//     commit limit 32.78 GB · committed 30.93 GB · FREE 1.85 GB
//     pagefile is MANUAL, capped at 1000-5000 MB (so the limit can't grow much)
// Windows had ~10 GB of free physical RAM but almost no COMMIT left, and commit
// is what an allocation actually needs. Every batch of 18 downloads then made two
// processes burst at the same instant:
//     browser: JSON.stringify(whole store) → a 59MB string beside the live rows
//     proxy:   buffer a 59MB body → 59MB string → JSON.parse (heap 429MB,
//              rss 688MB) → read + parse the 62MB FILE again → 62MB stringify
// ~1 GB of simultaneous demand against 1.85 GB of headroom. When VirtualAlloc
// fails V8 cannot reserve, calls abort(), and Windows reports 0xC0000409
// (-1073740791) — silently, which is why proxy.err.log stayed empty and six
// crashes left no fatal message. 3 of the 6 landed exactly on POST /ig/save,
// 2 on the spawn that opens /ig/download (a new yt-dlp process needs commit
// too), 1 on the embed probe while rss still sat at its post-save 688MB peak.
// It was never the VPN, never Instagram, and never a bug in the download path.
//
// So: hold the parsed store ONCE (flat ~430MB instead of allocating and freeing
// that much on every save), and write by STREAMING row by row — no 62MB string,
// no 62MB buffer beside it. Peak demand per save drops from ~500MB to ~1 row.
//   Cache key is (mtimeMs, size): any other writer — a harvest via /ig/add, a
// backfill script, an editor — changes one or both, so the next read re-parses.
// Never trust the cache across a foreign write.
let _igStore = { mtimeMs: 0, size: -1, rows: null };
function igStoreLoad() {
  let st = null;
  try { st = fs.statSync(IG_STORE); } catch (_) { return []; }
  if (_igStore.rows && _igStore.mtimeMs === st.mtimeMs && _igStore.size === st.size) return _igStore.rows;
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(IG_STORE, 'utf8')) || []; } catch (_) { rows = []; }
  if (!Array.isArray(rows)) rows = [];
  _igStore = { mtimeMs: st.mtimeMs, size: st.size, rows };
  return rows;
}
// Write the store to disk and re-stamp the cache. Two deliberate properties:
//   1) STREAMED — one row is serialised at a time into a 1MB pipe, so the peak
//      allocation is a row, not the file. Byte-identical to the old
//      JSON.stringify(rows, null, 2): each row is stringified at indent 2 and
//      every one of its lines shifted 2 more spaces, exactly as nesting would.
//   2) ATOMIC — tmp file + rename. Until now a crash DURING the write left a
//      truncated ig.json, which is the one way a proxy death could actually cost
//      data. rename() on NTFS is MoveFileEx(REPLACE_EXISTING): the store is
//      either wholly old or wholly new, never half-written.
// The tmp name matches the ig.json.tmp-* .gitignore rule on purpose.
function igStoreWriteRows(rows) {
  const tmp = IG_STORE + '.tmp-save';
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    if (!rows.length) { fs.writeSync(fd, '[]'); }
    else {
      fs.writeSync(fd, '[\n');
      for (let i = 0; i < rows.length; i++) {
        const body = JSON.stringify(rows[i], null, 2).split('\n').map(l => '  ' + l).join('\n');
        fs.writeSync(fd, i ? ',\n' + body : body);
      }
      fs.writeSync(fd, '\n]');
    }
    fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, IG_STORE);
  } catch (e) {
    // A reader holding ig.json open can make rename fail on Windows (EPERM/EBUSY).
    // Leave the store untouched rather than half-written, and let the caller 500 —
    // the client treats a failed save as unsaved and keeps its ⚠ flag.
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
  try { const st = fs.statSync(IG_STORE); _igStore = { mtimeMs: st.mtimeMs, size: st.size, rows }; }
  catch (_) { _igStore = { mtimeMs: 0, size: -1, rows: null }; }
}

function igAdd(req, res, origin) {
  readJson(req, 4 * 1024 * 1024).then(payload => {
    const urls = Array.isArray(payload.urls) ? payload.urls : [];
    const author = (payload.author || '').toString().slice(0, 80);
    const source = (payload.source || '').toString().slice(0, 300);
    // (dev0697) via the shared store layer: same read, but it reuses the parse a
    // running grind already paid for instead of adding a second 62MB one.
    const store = igStoreLoad().slice();
    const have = new Set(store.map(r => r && r.id).filter(Boolean));
    let added = 0, dup = 0, bad = 0;
    const now = igIsoNow();
    for (const u of urls) {
      const id = igShortcode(u);
      if (!id) { bad++; continue; }
      if (have.has(id)) { dup++; continue; }
      have.add(id);
      // canonical url: keep the form harvested, but normalize /reels/→/reel/
      const url = String(u).replace(/\/reels\//i, '/reel/').split('?')[0];
      store.push({ id, url, author, status: 'new', DateAdded: now, source });
      added++;
    }
    if (added) igStoreWriteRows(store);
    console.log('[ig/add] +' + added + ' new, ' + dup + ' dup, ' + bad + ' bad · total ' + store.length + ' · @' + (author || '?'));
    sendJson(res, 200, { ok: true, added, dup, bad, total: store.length }, origin);
  }).catch(err => sendJson(res, 400, { ok: false, error: err.message }, origin));
}

// (dev0462) /ig/ffdown — read the project-local ffdown/*.txt saved IG pages so the
// I-screen can BULK-import them (parse → ig.json) instead of pasting one by one.
// Each file is a Firefox "Save Page As ▸ Text" dump named "Instagram <label>.txt",
// where <label> is the user's curated note (e.g. a scientific name). We only LIST +
// READ here; the client reuses the same core.js parser as the manual paste path.
const FFDOWN_DIR = path.join(__dirname, 'ffdown');
function igFfdown(req, res, origin) {
  try {
    if (!fs.existsSync(FFDOWN_DIR)) { sendJson(res, 200, { ok: true, files: [] }, origin); return; }
    const names = fs.readdirSync(FFDOWN_DIR).filter(n => /\.txt$/i.test(n));
    const files = names.map(name => {
      let text = '', ctime = '';
      try {
        const fp = path.join(FFDOWN_DIR, name);
        text = fs.readFileSync(fp, 'utf8');
        // (dev0474) Surface the .txt file's CREATION time so the I-screen can stamp
        // it as the row's Harvested date (sort to the most-recently-saved text).
        // birthtime = NTFS creation time on Windows; fall back to ctime/mtime.
        const st = fs.statSync(fp);
        const ms = st.birthtimeMs || st.ctimeMs || st.mtimeMs || Date.now();
        // (dev0476) Emit LOCAL wall-clock time, not UTC. toISOString() returned UTC,
        // so a .txt saved at 07:23 local surfaced as "13:23" in the Harvested column
        // (the user's "I don't see where those times come from"). Format the local
        // YYYY-MM-DD HH:MM:SS by hand so it matches what the file explorer shows.
        const d = new Date(ms), pad = n => String(n).padStart(2, '0');
        ctime = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' '
              + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
      } catch (_) {}
      return { name, text, ctime };
    });
    console.log('[ig/ffdown] read ' + files.length + ' .txt file(s) from ffdown/');
    sendJson(res, 200, { ok: true, files }, origin);
  } catch (err) { sendJson(res, 500, { ok: false, error: err.message }, origin); }
}

// (dev0671) /ig/meta — clip duration (+ the dev0665 embed verdict, and the true
// pixel W×H) for a list of shortcodes, read from ig.json HERE. G and V need the
// duration to know when a played embed has finished so they can re-prime it, and
// ig.json is 42 MB — far too big to hand the browser for twelve numbers.
//
// STRICTLY a local file read: no Instagram traffic, nothing downloaded, nothing
// written. Unknown ids are simply absent from the reply; callers fall back to a
// default dwell, so a stopped proxy (or the public site) degrades quietly.
let _igMetaCache = { mtime: 0, byId: null };
function igMeta(req, res, origin) {
  readJson(req, 1024 * 1024).then(payload => {
    const ids = Array.isArray(payload.ids) ? payload.ids.filter(x => typeof x === 'string' && x) : [];
    if (!ids.length) { sendJson(res, 400, { ok: false, error: 'ids[] required' }, origin); return; }
    let st = null;
    try { st = fs.statSync(IG_STORE); } catch (_) { sendJson(res, 200, { ok: true, meta: {} }, origin); return; }
    // Re-parse only when the store has actually changed — a harvest or an
    // I-screen save bumps mtime; otherwise this is a map lookup.
    if (!_igMetaCache.byId || _igMetaCache.mtime !== st.mtimeMs) {
      // (dev0697) share the store layer's parse. This used to be a THIRD 62MB
      // JSON.parse — and it re-fired after every save during a grind (each save
      // bumps mtime), i.e. another ~430MB commit spike at the worst moment, if a
      // G/V screen happened to be asking for durations.
      const rows = igStoreLoad();
      const byId = Object.create(null);
      for (const r of rows) {
        if (!r || !r.id) continue;
        byId[r.id] = {
          dur: Number(r.durSecs) || 0,
          embed: (r.embed === 0 || r.embed === 1) ? r.embed : null,
          w: Number(r.width) || 0,
          h: Number(r.height) || 0
        };
      }
      _igMetaCache = { mtime: st.mtimeMs, byId };
      console.log('[ig/meta] indexed ' + Object.keys(byId).length + ' rows from ig.json');
    }
    const meta = {};
    for (const id of ids) if (_igMetaCache.byId[id]) meta[id] = _igMetaCache.byId[id];
    sendJson(res, 200, { ok: true, meta }, origin);
  }).catch(err => sendJson(res, 400, { ok: false, error: err.message }, origin));
}

// (dev0429) /ig/save — overwrite ig.json with the I-screen's edited array (enrich/
// promote/download state). Each row must still carry a shortcode `id`. A one-deep
// ig.json.bak is written first so a bad client payload can't silently nuke the
// store. Guard: refuse a write that drops > 50% of rows (likely a client bug) so a
// mis-send can't wipe a 700-row harvest — the caller gets a clear 409 to surface.
function igSave(req, res, origin) {
  // (dev0529) DATA-LOSS FIX: the body cap was 16 MB, but ig.json's compact POST body
  // crossed 16 MB as the store grew (10.9k rows w/ enriched ftext). readJson then
  // req.destroy()+rejected EVERY save → 400 → the client's batch persist(false)
  // swallowed it silently → enrich/download edits were never written (files still
  // landed in ig_media via the separate /ig/download route, masking the loss).
  // 256 MB gives the biggest, fastest-growing store years of headroom.
  // (dev0683) DIAGNOSTIC TIMING ONLY — no logic change. Every batch of 18 downloads
  // ends with one of these, and ig.json is ~49MB: the body is buffered and parsed
  // (~49MB), the previous file is read and parsed again (~49MB), copied to .bak
  // (~49MB of I/O), then re-serialised and written (~49MB). ~200MB of churn per
  // save, ~100 saves in a 3.5h grind. If the proxy is dying of memory or stalling
  // on disk, it will show here first — so time each phase and print the rss.
  const _sv = { t0: Date.now(), read: 0, bak: 0, write: 0 };
  readJson(req, 256 * 1024 * 1024).then(payload => {
    _sv.body = Date.now() - _sv.t0;
    const incoming = Array.isArray(payload.rows) ? payload.rows : null;
    if (!incoming) { sendJson(res, 400, { ok: false, error: 'rows[] required' }, origin); return; }
    const clean = incoming.filter(r => r && typeof r.id === 'string' && r.id);
    const _tRead = Date.now();
    const prev = igStoreLoad();                      // (dev0697) shared parse
    _sv.read = Date.now() - _tRead;
    // (dev0601) DATA-LOSS FIX: this used to blind-overwrite ig.json with the client's
    // whole in-memory array, so a HARVEST landing via /ig/add while the I screen was
    // open was silently wiped by the screen's next persist() — its rows[] predated
    // the harvest. That killed a full mbari_news harvest. The >50% guard never fired
    // (a few hundred lost out of 11k is nowhere near half), so it was invisible.
    //   The client now sends `knownIds` = every id it EVER SAW (stamped at load; NOT
    // pruned on delete). Any disk row absent from BOTH the incoming rows and knownIds
    // is one the client never knew about — i.e. harvested mid-session — so we carry
    // it over instead of dropping it. A row the client deleted on purpose IS in
    // knownIds, so intentional deletes still work. The incoming-ids check keeps a
    // client-created row from being re-added as a duplicate.
    //   Clock-free by design: the client's isoNow() is UTC while igAdd stamps LOCAL
    // wall-clock (dev0476), so a DateAdded>loadedAt watermark would compare skewed
    // strings and rescue nothing (or everything). Ids can't drift.
    //   Safe no-op: no knownIds in the payload (older client) → previous behaviour.
    const knownIds = Array.isArray(payload.knownIds) ? new Set(payload.knownIds) : null;
    let rescued = [];
    if (knownIds) {
      const incomingIds = new Set(clean.map(r => r.id));
      rescued = prev.filter(r => r && typeof r.id === 'string' && r.id
        && !incomingIds.has(r.id) && !knownIds.has(r.id));
    }
    const final = rescued.length ? clean.concat(rescued) : clean;
    if (prev.length > 10 && final.length < prev.length * 0.5) {
      console.warn('[ig/save] REFUSED — ' + final.length + ' rows would replace ' + prev.length + ' (>50% drop)');
      sendJson(res, 409, { ok: false, error: 'refused: ' + final.length + ' rows would replace ' + prev.length + ' (>50% drop)' }, origin);
      return;
    }
    const _tBak = Date.now();
    try { if (fs.existsSync(IG_STORE)) fs.copyFileSync(IG_STORE, IG_STORE + '.bak'); } catch (_) {}
    _sv.bak = Date.now() - _tBak;
    const _tWrite = Date.now();
    igStoreWriteRows(final);                         // (dev0697) streamed + atomic
    _sv.write = Date.now() - _tWrite;
    console.log('[ig/save] wrote ' + final.length + ' rows (was ' + prev.length + ')'
      + (rescued.length ? ' · RESCUED ' + rescued.length + ' row(s) harvested mid-session' : ''));
    // (dev0683) black-box note: size + where the time went + memory after.
    try {
      let bytes = 0; try { bytes = fs.statSync(IG_STORE).size; } catch (_) {}
      res._diagNote = `rows=${final.length} file=${(bytes / 1048576).toFixed(1)}MB`
        + ` body=${_sv.body}ms readPrev=${_sv.read}ms bak=${_sv.bak}ms write=${_sv.write}ms`
        + (rescued.length ? ` rescued=${rescued.length}` : '') + ` · ${memLine()}`;
    } catch (_) {}
    sendJson(res, 200, { ok: true, total: final.length, rescued: rescued.length }, origin);
  }).catch(err => sendJson(res, 400, { ok: false, error: err.message }, origin));
}

// (dev0697) /ig/save-delta — persist only the rows a batch actually changed.
// This is the endpoint a grind uses. A batch of 18 downloads changes 18 rows out
// of 22,452, and the old /ig/save shipped all of them: the client stringified
// 59MB, the body carried 59MB, the proxy parsed 59MB, then read and re-parsed the
// 62MB file. That ~1GB of paired demand against 1.85GB of free system commit is
// what aborted node six times in one night (see the store-layer note above).
// Here the body is ~50KB, the store is already parsed, and the write streams.
//
// UPSERT ONLY — by design, this can never shrink the store:
//   · a row whose id is on disk is REPLACED by the incoming one
//   · a row whose id is new is APPENDED
//   · a row on disk that isn't mentioned is left exactly as it is
// So the dev0601 knownIds rescue is structurally unnecessary here (nothing can be
// dropped, so nothing needs rescuing), and the >50% drop guard cannot trigger.
// Deletions and any bulk reshuffle still go through the full /ig/save — the
// client keeps sending that whenever it can't name the rows it touched.
//   No .bak: the full save still writes one, and an upsert of 18 known rows is
// not the operation a one-deep backup protects against — a bad whole-store
// payload is, and that path is unchanged.
function igSaveDelta(req, res, origin) {
  const t0 = Date.now();
  readJson(req, 64 * 1024 * 1024).then(payload => {
    const incoming = Array.isArray(payload.rows) ? payload.rows : null;
    if (!incoming) { sendJson(res, 400, { ok: false, error: 'rows[] required' }, origin); return; }
    const clean = incoming.filter(r => r && typeof r.id === 'string' && r.id);
    if (!clean.length) { sendJson(res, 400, { ok: false, error: 'no rows with a string id' }, origin); return; }
    const body = Date.now() - t0;
    const _tRead = Date.now();
    const rows = igStoreLoad().slice();               // copy: never mutate the cached array in place
    const read = Date.now() - _tRead;
    const at = new Map();
    for (let i = 0; i < rows.length; i++) if (rows[i] && rows[i].id) at.set(rows[i].id, i);
    let patched = 0, appended = 0;
    for (const r of clean) {
      const i = at.get(r.id);
      if (i === undefined) { at.set(r.id, rows.length); rows.push(r); appended++; }
      else { rows[i] = r; patched++; }
    }
    const _tWrite = Date.now();
    igStoreWriteRows(rows);
    const write = Date.now() - _tWrite;
    try {
      let bytes = 0; try { bytes = fs.statSync(IG_STORE).size; } catch (_) {}
      res._diagNote = `delta patched=${patched} appended=${appended} rows=${rows.length}`
        + ` file=${(bytes / 1048576).toFixed(1)}MB body=${body}ms readPrev=${read}ms write=${write}ms`
        + ` · ${memLine()}`;
    } catch (_) {}
    sendJson(res, 200, { ok: true, total: rows.length, patched, appended }, origin);
  }).catch(err => sendJson(res, 400, { ok: false, error: err.message }, origin));
}

// (dev0447) /s/save — overwrite s.json with the St-screen's edited array. s.json is
// the BULK staging store (Flickr jpgs / YT / Vimeo / direct video), parallel to
// ml.json and deliberately kept out of the curated table until rows are Promoted.
// Mirrors igSave: each row must carry a string `id`, a one-deep s.json.bak is written
// first, and a write that drops > 50% of rows is refused (409) so a client bug can't
// wipe a large staging set.
const S_STORE = path.join(__dirname, 's.json');
function sSave(req, res, origin) {
  readJson(req, 32 * 1024 * 1024).then(payload => {
    const incoming = Array.isArray(payload.rows) ? payload.rows : null;
    if (!incoming) { sendJson(res, 400, { ok: false, error: 'rows[] required' }, origin); return; }
    const clean = incoming.filter(r => r && typeof r.id === 'string' && r.id);
    let prev = [];
    try { if (fs.existsSync(S_STORE)) prev = JSON.parse(fs.readFileSync(S_STORE, 'utf8')) || []; } catch (_) {}
    if (Array.isArray(prev) && prev.length > 10 && clean.length < prev.length * 0.5) {
      console.warn('[s/save] REFUSED — ' + clean.length + ' rows would replace ' + prev.length + ' (>50% drop)');
      sendJson(res, 409, { ok: false, error: 'refused: ' + clean.length + ' rows would replace ' + prev.length + ' (>50% drop)' }, origin);
      return;
    }
    try { if (fs.existsSync(S_STORE)) fs.copyFileSync(S_STORE, S_STORE + '.bak'); } catch (_) {}
    fs.writeFileSync(S_STORE, JSON.stringify(clean, null, 2));
    console.log('[s/save] wrote ' + clean.length + ' rows (was ' + (Array.isArray(prev) ? prev.length : 0) + ')');
    sendJson(res, 200, { ok: true, total: clean.length }, origin);
  }).catch(err => sendJson(res, 400, { ok: false, error: err.message }, origin));
}

// (dev0450) /s/deleted — APPEND rows deleted in St to sdeleted.json (an archive
// parallel to s.json). Append-only + dedup by `id` so a client never has to send
// (or risk wiping) the whole archive; St only needs the archived LINKS to keep a
// re-imported clipboard from re-staging something the user already threw away. Each
// archived row is stamped DateDeleted. A one-deep .bak guards a bad write.
const SDEL_STORE = path.join(__dirname, 'sdeleted.json');
function readSdel() {
  try { if (fs.existsSync(SDEL_STORE)) { const a = JSON.parse(fs.readFileSync(SDEL_STORE, 'utf8')); return Array.isArray(a) ? a : []; } } catch (_) {}
  return [];
}
function sArchiveDeleted(req, res, origin) {
  readJson(req, 32 * 1024 * 1024).then(payload => {
    const incoming = Array.isArray(payload.rows) ? payload.rows : null;
    if (!incoming) { sendJson(res, 400, { ok: false, error: 'rows[] required' }, origin); return; }
    const arc = readSdel();
    const haveId = new Set(arc.map(r => r && r.id).filter(Boolean));
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    let added = 0;
    for (const r of incoming) {
      if (!r || typeof r !== 'object') continue;
      if (r.id && haveId.has(r.id)) continue;
      if (r.id) haveId.add(r.id);
      arc.push(Object.assign({}, r, { DateDeleted: r.DateDeleted || stamp }));
      added++;
    }
    try { if (fs.existsSync(SDEL_STORE)) fs.copyFileSync(SDEL_STORE, SDEL_STORE + '.bak'); } catch (_) {}
    fs.writeFileSync(SDEL_STORE, JSON.stringify(arc, null, 2));
    console.log('[s/deleted] archived ' + added + ' row(s); sdeleted.json now ' + arc.length);
    sendJson(res, 200, { ok: true, added, total: arc.length }, origin);
  }).catch(err => sendJson(res, 400, { ok: false, error: err.message }, origin));
}
// (dev0450) /s/undelete — remove rows (by id) from sdeleted.json, for St's Ctrl+Z
// "restore a deleted row" (the row goes back into s.json, so it must leave the
// archive or it'd wrongly block a future re-import).
function sUnarchive(req, res, origin) {
  readJson(req, 1 * 1024 * 1024).then(payload => {
    const ids = Array.isArray(payload.ids) ? payload.ids.filter(x => typeof x === 'string' && x) : null;
    if (!ids) { sendJson(res, 400, { ok: false, error: 'ids[] required' }, origin); return; }
    const arc = readSdel();
    const drop = new Set(ids);
    const kept = arc.filter(r => !(r && drop.has(r.id)));
    const removed = arc.length - kept.length;
    try { if (fs.existsSync(SDEL_STORE)) fs.copyFileSync(SDEL_STORE, SDEL_STORE + '.bak'); } catch (_) {}
    fs.writeFileSync(SDEL_STORE, JSON.stringify(kept, null, 2));
    console.log('[s/undelete] removed ' + removed + ' from sdeleted.json; now ' + kept.length);
    sendJson(res, 200, { ok: true, removed, total: kept.length }, origin);
  }).catch(err => sendJson(res, 400, { ok: false, error: err.message }, origin));
}

// (dev0521) ── Search-results store (x.json) ─────────────────────────────────────
// The X screen (x.js) reads x.json directly (GET) and writes it back via /x/save;
// deletes archive to xdeleted.json via /x/deleted (+ /x/undelete for Ctrl+Z). NEW:
// the two desktop finders (imagefinder.py / videofinder.py) AUTO-POST their search
// results to /x/import, which appends+dedups them into x.json (server-side). Mirrors
// the /s/* handlers above; kept a separate store because search hits come from a much
// wider range of sources than the S bulk store.
const X_STORE = path.join(__dirname, 'x.json');
const XDEL_STORE = path.join(__dirname, 'xdeleted.json');
function xNormLink(u) { return String(u || '').trim().replace(/\/+$/, ''); }
// Dedup key that collapses every URL spelling of the SAME video to one key — so a
// DuckDuckGo re-find (youtu.be/ID) of a direct YouTube hit (watch?v=ID) is caught as a
// duplicate. Non-video links keep their query-preserving normLink (image CDN URLs).
function xCanonLink(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  let m = s.match(/(?:youtu\.be\/|youtube\.com\/(?:shorts\/|live\/|embed\/|v\/|watch\?(?:.*&)?v=|(?:.*\?)?v=))([A-Za-z0-9_-]{11})/i);
  if (m) return 'yt:' + m[1];
  m = s.match(/vimeo\.com\/(?:video\/)?(\d+)/i);
  if (m) return 'vimeo:' + m[1];
  return xNormLink(s);
}
function xUrlType(u) {
  u = String(u || '');
  if (/youtube\.com|youtu\.be/i.test(u)) return 'yt';
  if (/vimeo\.com/i.test(u)) return 'vimeo';
  if (/\.(jpe?g|png|gif|webp|avif|bmp|svg|tiff?)(\?|#|$)/i.test(u)) return 'jpg';
  if (/\.(mp4|webm|mov|m4v|mkv)(\?|#|$)/i.test(u)) return 'video';
  return 'other';
}
function xKindOf(type, link) {
  if (type === 'jpg' || /\.(jpe?g|png|gif|webp|avif|bmp|svg|tiff?)(\?|#|$)/i.test(String(link || ''))) return 'image';
  if (type === 'yt' || type === 'vimeo' || type === 'video') return 'video';
  return 'other';
}
function xNormDur(d) {
  if (d == null || d === '') return '';
  if (typeof d === 'number' && Number.isFinite(d)) {
    if (d <= 0) return '';
    const m = Math.floor(d / 60), s = Math.round(d % 60);
    return m + ':' + String(s).padStart(2, '0');
  }
  d = String(d).trim();
  if (d.includes(':')) return d;
  const n = parseInt(d, 10);
  if (!Number.isFinite(n) || n <= 0) return '';
  const m = Math.floor(n / 60), s = n % 60;
  return m + ':' + String(s).padStart(2, '0');
}
let _xIdSeq = 0;
function xMkId() { return 'x' + Date.now().toString(36) + (_xIdSeq++).toString(36); }
function xReadStore() {
  try { if (fs.existsSync(X_STORE)) { const a = JSON.parse(fs.readFileSync(X_STORE, 'utf8')); return Array.isArray(a) ? a : []; } } catch (_) {}
  return [];
}
function xReadDel() {
  try { if (fs.existsSync(XDEL_STORE)) { const a = JSON.parse(fs.readFileSync(XDEL_STORE, 'utf8')); return Array.isArray(a) ? a : []; } } catch (_) {}
  return [];
}
// /x/save — overwrite x.json with the X-screen's edited array (>50%-drop guard + .bak).
function xSave(req, res, origin) {
  readJson(req, 32 * 1024 * 1024).then(payload => {
    const incoming = Array.isArray(payload.rows) ? payload.rows : null;
    if (!incoming) { sendJson(res, 400, { ok: false, error: 'rows[] required' }, origin); return; }
    const clean = incoming.filter(r => r && typeof r.id === 'string' && r.id);
    let prev = xReadStore();
    // The >50%-drop guard protects against a corrupted-load overwriting x.json. A
    // deliberate X-screen delete sends force:true (the rows are also archived to
    // xdeleted.json first), so intentional bulk deletes — including "delete all" — pass.
    if (!payload.force && prev.length > 10 && clean.length < prev.length * 0.5) {
      console.warn('[x/save] REFUSED — ' + clean.length + ' rows would replace ' + prev.length + ' (>50% drop; send force:true to override)');
      sendJson(res, 409, { ok: false, error: 'refused: ' + clean.length + ' rows would replace ' + prev.length + ' (>50% drop)' }, origin);
      return;
    }
    try { if (fs.existsSync(X_STORE)) fs.copyFileSync(X_STORE, X_STORE + '.bak'); } catch (_) {}
    fs.writeFileSync(X_STORE, JSON.stringify(clean, null, 2));
    console.log('[x/save] wrote ' + clean.length + ' rows (was ' + prev.length + ')');
    sendJson(res, 200, { ok: true, total: clean.length }, origin);
  }).catch(err => sendJson(res, 400, { ok: false, error: err.message }, origin));
}
// /x/deleted — APPEND rows deleted in X to xdeleted.json (append-only, dedup by id).
function xArchiveDeleted(req, res, origin) {
  readJson(req, 32 * 1024 * 1024).then(payload => {
    const incoming = Array.isArray(payload.rows) ? payload.rows : null;
    if (!incoming) { sendJson(res, 400, { ok: false, error: 'rows[] required' }, origin); return; }
    const arc = xReadDel();
    const haveId = new Set(arc.map(r => r && r.id).filter(Boolean));
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    let added = 0;
    for (const r of incoming) {
      if (!r || typeof r !== 'object') continue;
      if (r.id && haveId.has(r.id)) continue;
      if (r.id) haveId.add(r.id);
      arc.push(Object.assign({}, r, { DateDeleted: r.DateDeleted || stamp }));
      added++;
    }
    try { if (fs.existsSync(XDEL_STORE)) fs.copyFileSync(XDEL_STORE, XDEL_STORE + '.bak'); } catch (_) {}
    fs.writeFileSync(XDEL_STORE, JSON.stringify(arc, null, 2));
    console.log('[x/deleted] archived ' + added + ' row(s); xdeleted.json now ' + arc.length);
    sendJson(res, 200, { ok: true, added, total: arc.length }, origin);
  }).catch(err => sendJson(res, 400, { ok: false, error: err.message }, origin));
}
// /x/undelete — remove rows (by id) from xdeleted.json (X's Ctrl+Z restore).
function xUnarchive(req, res, origin) {
  readJson(req, 1 * 1024 * 1024).then(payload => {
    const ids = Array.isArray(payload.ids) ? payload.ids.filter(x => typeof x === 'string' && x) : null;
    if (!ids) { sendJson(res, 400, { ok: false, error: 'ids[] required' }, origin); return; }
    const arc = xReadDel();
    const drop = new Set(ids);
    const kept = arc.filter(r => !(r && drop.has(r.id)));
    const removed = arc.length - kept.length;
    try { if (fs.existsSync(XDEL_STORE)) fs.copyFileSync(XDEL_STORE, XDEL_STORE + '.bak'); } catch (_) {}
    fs.writeFileSync(XDEL_STORE, JSON.stringify(kept, null, 2));
    console.log('[x/undelete] removed ' + removed + ' from xdeleted.json; now ' + kept.length);
    sendJson(res, 200, { ok: true, removed, total: kept.length }, origin);
  }).catch(err => sendJson(res, 400, { ok: false, error: err.message }, origin));
}
// /x/import — the finders' auto-send target. Body: { items:[{link,title,author,
// page_url,width,height,duration,source,kind}], query, source, kind }. Each item is
// normalized to an x.json row and APPENDED, deduped by normalized link against BOTH
// x.json and xdeleted.json (so a re-run search / previously-deleted hit won't re-stage).
function xImport(req, res, origin) {
  readJson(req, 32 * 1024 * 1024).then(payload => {
    const items = Array.isArray(payload.items) ? payload.items : null;
    if (!items) { sendJson(res, 400, { ok: false, error: 'items[] required' }, origin); return; }
    const store = xReadStore();
    const have = new Set(store.map(r => xCanonLink(r && r.link)));
    const del = new Set(xReadDel().map(r => xCanonLink(r && r.link)));
    const defQuery = String(payload.query || '').trim();
    const defSource = String(payload.source || '').trim();
    const defKind = String(payload.kind || '').trim();
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    let added = 0, dup = 0, dropped = 0;
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      const link = String(it.link || it.url || it.image_url || it.video_url || '').trim();
      const key = xCanonLink(link);
      if (!key) continue;
      if (have.has(key)) { dup++; continue; }
      if (del.has(key)) { dropped++; continue; }
      have.add(key);
      const type = xUrlType(link);
      const w = parseInt(it.width, 10), h = parseInt(it.height, 10);
      const resolution = (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) ? (w + '×' + h) : '';
      store.push({
        id: xMkId(),
        kind: String(it.kind || defKind || xKindOf(type, link)),
        type,
        link,
        source: String(it.source || it.source_name || defSource || ''),
        query: String(it.query || defQuery || ''),
        VidTitle: String(it.title || it.VidTitle || ''),
        VidAuthor: String(it.author || it.VidAuthor || it.creator || ''),
        attribution: String(it.page_url || it.attribution || ''),
        resolution,
        width: Number.isFinite(w) ? w : undefined,
        height: Number.isFinite(h) ? h : undefined,
        vidLength: xNormDur(it.duration != null ? it.duration : it.vidLength),
        size: '',
        comment: '',
        tags: [],
        status: 'new',
        DateAdded: stamp
      });
      added++;
    }
    if (added) {
      try { if (fs.existsSync(X_STORE)) fs.copyFileSync(X_STORE, X_STORE + '.bak'); } catch (_) {}
      fs.writeFileSync(X_STORE, JSON.stringify(store, null, 2));
    }
    console.log('[x/import] +' + added + ' new (dup ' + dup + ', prev-deleted ' + dropped + '); x.json now ' + store.length);
    sendJson(res, 200, { ok: true, added, dup, dropped, total: store.length }, origin);
  }).catch(err => sendJson(res, 400, { ok: false, error: err.message }, origin));
}

// (dev0523) /x/search — the X screen triggers a headless finder search here (replaces
// the clumsy launch-the-GUI-then-clipboard path). Async-spawns the desktop finder in
// --search mode; it runs aggregate_search (10–60s with a real browser) and POSTs its
// hits back via /x/import — so THIS route returns immediately, and the X screen polls
// x.json / reloads once the results land. Origin-locked like /exec/* (it spawns a
// subprocess) — enforced in the router before we get here. All argv tokens are literal
// under spawn(shell:false); the caller can pick the query/sources/max/safe but never
// raw args. The .py finders live under gitignored linkfinders/ (local-only tools).
const X_PYTHON = process.env.X_PYTHON || 'python';   // override if python isn't the PATH name
const X_FINDER_DIR = path.join(__dirname, 'linkfinders');
const X_FINDERS = {
  // Must mirror ALL_IMAGE_SOURCES / ALL_VIDEO_SOURCES in the two finders.
  image: { script: 'imagefinder.py',
           sources: ['bing', 'google', 'ddgs', 'flickr', 'wikimedia', 'openverse'] },
  video: { script: 'videofinder.py',
           sources: ['youtube', 'vimeo', 'ddgs'] }
};
function xSearch(req, res, origin) {
  readJson(req, 64 * 1024).then(payload => {
    const kind = String(payload.kind || '').trim().toLowerCase();
    const spec = X_FINDERS[kind];
    if (!spec) { sendJson(res, 400, { ok: false, error: 'kind must be "image" or "video"' }, origin); return; }
    const query = String(payload.query || '').trim();
    if (!query) { sendJson(res, 400, { ok: false, error: 'query required' }, origin); return; }
    if (query.length > 400) { sendJson(res, 400, { ok: false, error: 'query too long (max 400 chars)' }, origin); return; }

    // sources: accept an array or a comma string; keep only ones valid for this kind.
    let picked = [];
    if (Array.isArray(payload.sources)) picked = payload.sources;
    else if (typeof payload.sources === 'string') picked = payload.sources.split(',');
    picked = [...new Set(picked.map(s => String(s || '').trim().toLowerCase()).filter(s => spec.sources.includes(s)))];

    let max = parseInt(payload.max, 10);
    if (!Number.isFinite(max) || max < 1) max = 40;
    if (max > 200) max = 200;
    const safe = (String(payload.safe || '').toLowerCase() === 'off') ? 'off' : 'on';

    const scriptPath = path.join(X_FINDER_DIR, spec.script);
    if (!fs.existsSync(scriptPath)) {
      sendJson(res, 404, { ok: false, error: spec.script + ' not found under linkfinders/ (local-only finder tool)' }, origin);
      return;
    }

    const args = [scriptPath, '--search', query, '--max', String(max), '--safe', safe];
    if (picked.length) args.push('--sources', picked.join(','));            // else the finder uses its default set
    if (kind === 'image' && payload.allowStock)  args.push('--allow-stock');
    if (kind === 'video' && payload.allowTikTok) args.push('--allow-tiktok');
    if (kind === 'video' && payload.deep)        args.push('--deep');
    if (payload.showBrowser)                     args.push('--show-browser');   // visible browser → beat Google's captcha wall

    let proc;
    // cwd = linkfinders/ so the finder's relative resources (_browser_profile, etc.)
    // resolve exactly as they do when the user launches it by hand.
    try { proc = spawn(X_PYTHON, args, { cwd: X_FINDER_DIR, windowsHide: true }); }
    catch (e) { sendJson(res, 500, { ok: false, error: 'spawn failed: ' + e.message + ' (is python on PATH? set X_PYTHON=)' }, origin); return; }

    const tag = '[x/search ' + kind + ']';
    console.log(tag + ' ' + X_PYTHON + ' ' + args.map(a => /\s/.test(a) ? JSON.stringify(a) : a).join(' '));
    proc.on('error', err => console.warn(tag + ' spawn error: ' + err.message + ' — is "' + X_PYTHON + '" on PATH?'));
    if (proc.stdout) proc.stdout.on('data', d => process.stdout.write(tag + ' ' + d));
    if (proc.stderr) proc.stderr.on('data', d => process.stderr.write(tag + ' ' + d));
    proc.on('close', code => console.log(tag + ' finished (exit ' + code + ') — results POST to /x/import; X reloads on poll'));

    // Return immediately — hits land later via the finder's own POST /x/import.
    sendJson(res, 200, { ok: true, spawned: true, kind, query, sources: picked, max, safe, showBrowser: !!payload.showBrowser }, origin);
  }).catch(err => sendJson(res, 400, { ok: false, error: err.message }, origin));
}

// (dev0429) /ig/download — yt-dlp downloads a reel/post's media into <project>/
// ig_media/<stem>.<ext>. Returns the basenames of every file produced (a carousel
// /p post yields several). All argv tokens are literal under spawn(shell:false);
// the only caller value is the validated URL.
// (dev0434) Cookie order REVERSED → COOKIELESS FIRST, Firefox-cookies only as a
// fallback. Rationale (user's account-awareness concern for bulk downloads): a
// cookieless request carries no account session, so IG can't link it to the user;
// only content that's genuinely login-walled falls through to the cookie attempt.
// Trade-off: a walled item costs one failed cookieless try first (a few seconds).
const IG_MEDIA_DIR = path.join(__dirname, 'ig_media');
// Mirror of the AHK SanitizeFilePart (ytdl_v26.ahk:843): strip the chars Windows
// forbids in a filename, collapse whitespace, trim leading/trailing dots. Keeps
// the convention's structural chars ~ [ ] @ (all legal on Windows).
function igSanitizeName(s) {
  s = String(s || '').replace(/[<>":\/\\|?*\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '');
  return s || 'unknown';
}
// (dev0689) Author → ig_media subfolder name. 25k files in one directory made
// Explorer crawl; there are only ~25 harvested authors, so one folder each.
// MUST stay byte-identical to folderFor() in igFolderByAuthor.js — the migration
// script and this live path have to agree on the folder for a given author, or a
// re-download would land beside its siblings instead of among them.
// Empty author → '' → files land in ig_media/ exactly as before (fail-safe: an old
// cached ig.js sends no author, and igFolderByAuthor.js re-files whatever lands).
const IG_RESERVED_DIR = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
function igAuthorFolder(author) {
  let s = String(author || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  if (!s) return '';
  if (IG_RESERVED_DIR.test(s)) s = '_' + s;
  return s.slice(0, 100);
}
// (dev0439) Multi-file carousels now download. yt-dlp is pointed at a PRIVATE
// temp dir with autonumbered output; the results are then renamed into ig_media/
// — a single item keeps the bare AHK-convention stem, a carousel (e.g. a 6-image
// /p post) becomes "<stem> [1 of 6].jpg" … "<stem> [6 of 6].jpg". This fixes two
// things at once: (1) the old "<stem>.%(ext)s" template gave every carousel item
// the SAME name → 5 of 6 collided/were skipped; (2) image-only posts (no video)
// now come through because we no longer assume one output file. yt-dlp's default
// "best" format IS the image for an image entry, so they download like any other.
// (dev0513) Cover-only must deliver a genuine .jpg. IG sometimes serves the cover only
// as .webp; when the cover-only fetch lands a .webp we transcode it to .jpg at top
// quality (-q:v 2, visually lossless) so the saved file is a real JPEG rather than webp
// bytes wearing a .jpg name. JPEG covers are left untouched (no re-encode). Sequential;
// resolves once every webp in tmpDir is converted (best-effort — a failed convert keeps
// the original so publish() still has a file).
function coverWebpToJpg(tmpDir) {
  return new Promise(resolve => {
    let files; try { files = fs.readdirSync(tmpDir).filter(f => /\.webp$/i.test(f)); } catch (_) { files = []; }
    if (!files.length) { resolve(); return; }
    let i = 0;
    const next = () => {
      if (i >= files.length) { resolve(); return; }
      const src = path.join(tmpDir, files[i++]);
      const dst = src.replace(/\.webp$/i, '.jpg');
      let proc;
      try { proc = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-q:v', '2', dst], { windowsHide: true }); }
      catch (_) { next(); return; }
      proc.on('error', () => next());
      proc.on('close', () => { try { if (fs.existsSync(dst) && fs.statSync(dst).size > 0) fs.unlinkSync(src); else { try { fs.unlinkSync(dst); } catch (_) {} } } catch (_) {} next(); });
    };
    next();
  });
}
function igDownload(req, res, origin) {
  readJson(req, 64 * 1024).then(payload => {
    const url = String(payload.url || '');
    const id = String(payload.id || '').replace(/[^A-Za-z0-9_-]/g, '');
    const coverOnly = !!payload.coverOnly;   // (dev0512) cookieless index-1 cover only
    // (dev0690) What the row ALREADY has on disk, so a re-download can be refused when it
    // would be a downgrade. Both are 0/absent for a first download, and both are ignored
    // in coverOnly mode (which deliberately fetches one image and would always "lose").
    const keepPixels = coverOnly ? 0 : Math.max(0, +payload.keepPixels || 0);
    const keepCount  = coverOnly ? 0 : Math.max(0, +payload.keepCount  || 0);
    // (dev0696) The NARROWEST item the row already holds (r.dlMinW). dev0690 compared only
    // the largest item, so a mixed carousel could not be reasoned about at all — see the
    // guard in publish() below. Absent on a stale client, which keeps the dev0690 behaviour.
    const keepMinW   = coverOnly ? 0 : Math.max(0, +payload.keepMinW   || 0);
    if (!/^https?:\/\//i.test(url) || url.length > 2048) { sendJson(res, 400, { ok: false, error: 'valid http(s) url required' }, origin); return; }
    if (!id) { sendJson(res, 400, { ok: false, error: 'id required' }, origin); return; }
    try { fs.mkdirSync(IG_MEDIA_DIR, { recursive: true }); } catch (_) {}
    // Filename stem: the client passes the AHK-convention `name` (already built from
    // the enriched row); fall back to the bare id. Sanitized + length-capped here as
    // the safety boundary — the client value never reaches the shell (spawn literal).
    const stem = igSanitizeName(payload.name || id).slice(0, 180);
    const tmpDir = path.join(IG_MEDIA_DIR, '.tmp_' + id + '_' + Date.now().toString(36));
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}
    const outTmpl = path.join(tmpDir, '%(autonumber)03d.%(ext)s');
    // (dev0518) --impersonate on the yt-dlp download path (reels wall cookieless now).
    const impersonate = IG_IMPERSONATE ? ['--impersonate', IG_IMPERSONATE] : [];
    const baseArgs = ['--no-warnings', '--ignore-config', '--socket-timeout', '20', '--no-part'].concat(impersonate, ['-o', outTmpl]);

    const tmpFiles = () => { try { return fs.readdirSync(tmpDir).filter(f => !f.startsWith('.') && !f.endsWith('.part')).sort(); } catch (_) { return []; } };
    const wipeTmp  = () => { try { fs.readdirSync(tmpDir).forEach(f => { try { fs.unlinkSync(path.join(tmpDir, f)); } catch (_) {} }); } catch (_) {} };
    const rmTmp    = () => { try { (fs.rmSync || fs.rmdirSync)(tmpDir, { recursive: true, force: true }); } catch (_) {} };
    // (dev0690) Filled by publish() and read by sendDl() on the way out. The ordering is
    // guaranteed by construction: every success path is written `sendDl({… files: publish() …})`,
    // and JS evaluates the argument object — and therefore publish() — before sendDl runs.
    let pubStats = null;   // { n, maxW, maxH, minW, pixels, dims:[[w,h],…] } — real, measured
    let pubKept  = null;   // set instead when the download was REFUSED as a downgrade
    // Rename tmp files → ig_media/<stem>[ [i of N]].<ext>; return the basenames.
    function publish() {
      const files = tmpFiles(), n = files.length, out = [];
      pubStats = null; pubKept = null;
      // (dev0690) Measure everything ONCE, up front: the same numbers answer three
      // questions — is this download a downgrade (below), what goes in the filename, and
      // what resolution does the row actually have on disk (`media`, new this build).
      // Nothing on disk previously distinguished a 720-capped file from a 1080 one
      // without re-probing it, which is why the collection-wide cap went unnoticed for
      // five weeks. A null entry means unreadable, and is excluded from every min/max.
      const dims = files.map(f => probeMediaDims(path.join(tmpDir, f)));
      const good = dims.filter(Boolean);
      if (good.length) {
        pubStats = {
          n,
          maxW: Math.max(...good.map(d => d.w)), maxH: Math.max(...good.map(d => d.h)),
          minW: Math.min(...good.map(d => d.w)),
          pixels: Math.max(...good.map(d => d.w * d.h)),
          dims: dims.map(d => d ? [d.w, d.h] : null)
        };
      }
      // (dev0690) The overwrite guard. A re-download must never replace a better file
      // with a worse one, and "better" is PIXELS, never bytes — IG's 720p progressive
      // h264 is high-bitrate and is frequently a LARGER file than the 1080p VP9 that
      // supersedes it, so a size heuristic would keep the worse copy every time. The
      // count test catches the other loss: a throttled walk that returns 1 item of 6
      // would otherwise publish as a "successful" download over a complete carousel.
      // Refusing is a SUCCESS (ok:true, kept:…) — nothing failed, we just kept what we had.
      // (dev0696) THREE axes, not one. dev0690 tested only max pixels, and that single
      // test was wrong in two directions on a mixed carousel:
      //   • a re-fetch that lifts a 640px item to 1080 while the LARGEST item stays put
      //     has equal max pixels, so it fell through and republished — an in-place
      //     overwrite of identical-looking files that taught the row nothing. It kept
      //     dlMinW < 1080, stayed ⚠ below target, and was re-offered on every grind
      //     forever (verified on CotWRZFqxQT: 10 items re-pulled to no effect).
      //   • conversely a re-fetch that raises the narrowest item but lowers the largest
      //     was refused as a downgrade, discarding a real win.
      // minW is what the ⚠ filter actually reads (ig.js belowTarget), so it belongs in
      // the comparison. keepMinW absent → every test below behaves exactly as dev0690.
      const haveMinW = keepMinW > 0;
      const gainMinW = haveMinW && pubStats && pubStats.minW > keepMinW;
      const worse =
        // A short walk is a THROTTLE, not a verdict about the post — so it has to win over
        // 'fewer pixels', which the client treats as final and would conclude the row on.
        (keepCount > 0 && n > 0 && n < keepCount) ? 'fewer items'
        // A genuine downgrade — unless the narrowest item improved, which is a real gain
        // even when the largest one shrank.
        : (keepPixels > 0 && pubStats && pubStats.pixels < keepPixels && !gainMinW) ? 'fewer pixels'
        // Nothing moved on ANY axis: IG has nothing better than what is already on disk.
        // Refusing is what lets the client CONCLUDE the row (resBest) instead of writing
        // identical bytes over identical bytes and leaving it queued for the next grind.
        : (haveMinW && pubStats && n === keepCount
           && pubStats.pixels <= keepPixels && pubStats.minW <= keepMinW) ? 'no gain'
        : '';
      if (worse) {
        pubKept = { reason: worse, newPixels: (pubStats && pubStats.pixels) || 0, keepPixels,
                    newCount: n, keepCount,
                    newMinW: (pubStats && pubStats.minW) || 0, keepMinW };
        wipeTmp(); rmTmp();
        return out;
      }
      // (dev0659) Ground-truth the filename's leading hh.mm.ss from the ACTUAL downloaded
      // video(s). The client builds `name` from enrich metadata, whose duration is often
      // missing on the cookieless OG/reel path → durSecs 0 → a "00.00.00~…" name even
      // though a full-length clip just landed. ffprobe the real file(s), take the max
      // duration (mirrors the client's per-row "one duration" convention) and stamp the
      // true length in. Best-effort: any probe hiccup leaves the client's stem untouched,
      // and image-only posts (no video ext) keep their legitimate 00.00.00.
      let outStem = stem;
      try {
        let maxDur = 0;
        for (const f of files) {
          if (!/\.(mp4|mov|webm|mkv|m4v)$/i.test(f)) continue;
          const raw = execFileSync('ffprobe', ['-v', 'quiet', '-show_entries',
            'format=duration', '-of', 'default=nw=1:nk=1', path.join(tmpDir, f)],
            { encoding: 'utf8', timeout: 15000 }).trim();
          const d = parseFloat(raw);
          if (Number.isFinite(d) && d > maxDur) maxDur = d;
        }
        if (maxDur > 0) {
          const s = Math.round(maxDur), p2 = x => String(x).padStart(2, '0');
          const hms = p2(Math.floor(s / 3600)) + '.' + p2(Math.floor((s % 3600) / 60)) + '.' + p2(s % 60);
          outStem = stem.replace(/^\d{2}\.\d{2}\.\d{2}/, hms);   // only the duration field
        }
      } catch (_) {}
      // (dev0677) Same treatment for the W×H field — for the same reason, one field over.
      // The client builds it from the ROW's enrich metadata, which for every photo /p was
      // the cropped 640² thumbnail's size (the dev0677 pickIgFullCover bug), so a corrected
      // full-res download would still have landed under a "640x640" name. Read the real
      // pixels off the file that actually landed (index-1, mirroring the row's one-W×H
      // convention). Best-effort: an unreadable header leaves the client's stem alone.
      // (dev0690) Reuses the `dims` measured above rather than re-probing index-1.
      const d0 = dims[0];
      if (d0 && d0.w > 0 && d0.h > 0) {
        outStem = outStem.replace(/^(\d{2}\.\d{2}\.\d{2}~)\d+x\d+~/, '$1' + d0.w + 'x' + d0.h + '~');
      }
      // (dev0689) Land the files in the author's subfolder and record the RELATIVE
      // subpath in localFiles, so every consumer resolves correctly without having to
      // re-derive the folder from the row (which would break on an author rename, and
      // on a collab post harvested under one account — see reference_ig_author_vs_vidauthor).
      const folder = igAuthorFolder(payload.author);
      if (folder) { try { fs.mkdirSync(path.join(IG_MEDIA_DIR, folder), { recursive: true }); } catch (_) {} }
      files.forEach((f, i) => {
        const ext = path.extname(f);
        const base = outStem + (n > 1 ? ' [' + (i + 1) + ' of ' + n + ']' : '') + ext;
        const rel  = folder ? folder + '/' + base : base;
        const dest = path.join(IG_MEDIA_DIR, folder, base);   // folder '' → base dir
        try { fs.renameSync(path.join(tmpDir, f), dest); out.push(rel); }
        catch (_) { try { fs.copyFileSync(path.join(tmpDir, f), dest); out.push(rel); } catch (_) {} }
      });
      rmTmp();
      return out;
    }
    // (dev0675) Every 200-OK download answer goes through here so the official-embed
    // verdict is stamped on the way out — one cookieless GET of the post's embed page,
    // piggybacked on the moment IG is already serving us this exact post. The client
    // sets probeEmbed:false for a row that already has a verdict, so nothing is ever
    // re-probed. Adds `embed` (1|0) only when the probe is CONCLUSIVE; `embedProbe`
    // always carries the kind (ok|dead|shell|wall) so the client can report a miss.
    // Failures are swallowed — a download result must never be lost to a probe hiccup.
    // (dev0676) EXPLICIT opt-in, not "unless disabled": a browser still running a cached
    // pre-dev0675 ig.js sends no flag at all, and a default-on read would then re-probe
    // rows that already carry a verdict — the one thing this feature must never do.
    // Absent flag → no probe (fail-safe toward fewer IG requests).
    const wantProbe = IG_EMBED_PROBE_ON_DOWNLOAD && payload.probeEmbed === true;
    // (dev0690) How many items the POST has, when we know it — set by the carousel walker
    // (its inventory length, or 1 when the page carries no carousel_media at all) and by
    // the reel path (a /reel/ or /tv/ URL is single-item by definition — set below, where
    // photoPost is declared). Left null when the walk was throttled, because "we couldn't
    // read it" must not be recorded as "this post has one item".
    let postItemsHint = null;
    function sendDl(body) {
      // (dev0690) Attach the measured facts publish() just produced. Doing it here rather
      // than at each of the seven call sites means no success path can forget to.
      if (body.postItems == null && postItemsHint != null) body.postItems = postItemsHint;
      if (pubStats) body.media = pubStats;
      if (pubKept)  body.kept  = pubKept;
      // (dev0683) black-box note: which path actually served this row, and what
      // landed. A run of "files=0" or one repeating path is the marking story.
      try {
        const via = ['viaEmbed', 'viaCover', 'viaMainVideo', 'viaMainCarousel', 'viaGalleryDl']
          .filter(k => body[k]).join('+') || 'ytdlp';
        res._diagNote = `${id} ok via=${via} files=${(body.files || []).length}`
          + (body.media ? ` ${body.media.maxW}x${body.media.maxH}` : '')
          + (body.upgraded ? ` +${body.upgraded}up` : '')
          + (body.kept ? ` KEPT-EXISTING (${body.kept.reason})` : '')
          + (body.usedCookies ? ' COOKIES' : '');
      } catch (_) {}
      if (!wantProbe) { sendJson(res, 200, body, origin); return; }
      // (dev0685) Phase markers. The 22:47:29 death happened INSIDE this request:
      // the media file landed at 22:47:35, and the process was gone by 22:47:37 —
      // between the file landing and this probe's result. proxy.log could only say
      // "somewhere inside /ig/download". These two lines make the next one exact:
      // a "probe start" with no "probe done" means it died in the probe (a network
      // fetch + a python spawn); the reverse means it died on the way out.
      plog(`ig/download ${id} · embed probe start`);
      probeEmbed(id, { track: ACTIVE_DL, cffiTimeoutMs: 25000 }).then(p => {
        if (p.v === 0 || p.v === 1) body.embed = p.v;
        body.embedProbe = p.kind;
        plog(`ig/download ${id} · embed probe done → ${p.v === null ? 'no verdict' : p.v} (${p.kind}, via ${p.via})`);
        console.log('[ig/download] ' + id + ' embed probe → ' + (p.v === null ? 'no verdict' : p.v) + ' (' + p.kind + ', via ' + p.via + ')');
        sendJson(res, 200, body, origin);
      }).catch(e => { plog(`ig/download ${id} · embed probe threw: ${(e && e.message) || e}`); sendJson(res, 200, body, origin); });
    }
    function run(withCookies, onDone) {
      const args = baseArgs.concat(withCookies ? ['--cookies-from-browser', 'firefox', url] : [url]);
      let proc, stderr = '', done = false;
      try { proc = spawn('yt-dlp', args, { windowsHide: true }); }
      catch (e) { onDone(false, 'spawn failed: ' + e.message); return; }
      ACTIVE_DL.add(proc);   // (dev0658) killable by the VPN kill-switch
      // (dev0645) HARD wall-clock kill. --socket-timeout only bounds yt-dlp's own sockets;
      // a child that hangs otherwise lingers as a node-owned zombie, and over a long
      // session these pile up and contend for IG connections — the "restart node to fix
      // reel downloads" symptom. Kill any child that outruns this so none can accumulate.
      const finish = (ok, err) => { if (done) return; done = true; ACTIVE_DL.delete(proc); clearTimeout(killT); onDone(ok, err); };
      const killT = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} finish(false, 'yt-dlp timed out (killed after 90s)'); }, 90000);
      proc.stderr.on('data', d => { stderr += d.toString('utf8'); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
      proc.on('error', e => finish(false, e.message));
      proc.on('close', code => finish(code === 0, stderr.trim()));
    }
    // (dev0434) Cookieless FIRST (keeps the account out of it); only fall back to
    // Firefox cookies if the content is login-walled. A nonzero exit that STILL
    // produced files (a carousel where one entry 404s) counts as success.
    // (dev0494) yt-dlp FIRST for everything — VERIFIED that cookieless yt-dlp pulls the
    // FULL carousel as MP4 at max res for these /p posts (e.g. DL9ttujtjT4 → 2 mp4s,
    // DXBzATkDVQh → 7 mp4s). dev0493's "embed-first for /p" was WRONG: it handed back a
    // single static embed JPG and never let yt-dlp fetch the MP4 carousel the user
    // wants. The earlier batch "couldn't read" was TRANSIENT IP-throttle, not a wall.
    // So: cookieless yt-dlp → (Firefox-cookie yt-dlp, only if IG_DOWNLOAD_USE_COOKIES —
    // also full carousel + MP4) → cookieless embed STATIC image as the LAST resort
    // (photo posts only; first frame, no video — clearly labelled so a throttled item
    // can be re-run for the real MP4). Embed is strictly inferior, hence dead last.
    const photoPost = IG_SHORTCODE_RE.test(url) && !/\/reels?\//i.test(url);
    if (!photoPost) postItemsHint = 1;   // (dev0690) a /reel/ or /tv/ post is one item
    function fail502(err) {
      rmTmp();
      console.warn('[ig/download] ' + id + ' failed: ' + (err || 'yt-dlp failed'));
      // (dev0683) black-box note — every path this row tried is already in the
      // error text; keep the tail of it so proxy.log alone shows WHY it failed.
      try { res._diagNote = `${id} FAIL ${String(err || 'yt-dlp failed').replace(/\s+/g, ' ').slice(-220)}`; } catch (_) {}
      sendJson(res, 502, { ok: false, error: (err || 'yt-dlp failed').split('\n').slice(-3).join(' ') }, origin);
    }
    // Final cookieless rescue: the embed page's single static image, only after every
    // yt-dlp attempt came back empty. Skipped for reels (no image) and non-IG URLs.
    // (dev0519) Reel/video rescue: yt-dlp is now login-walled for reels cookielessly,
    // but the logged-out /p/ page still embeds the signed MP4 in its video_versions
    // JSON, which downloads cookieless. Mirror of the photo embed rescue below.
    function mainVideoRescueOr502(err) {
      wipeTmp();
      igMainVideoFallback(url, id, tmpDir).then(files => {
        if (files.length && tmpFiles().length) {
          console.log('[ig/download] ' + id + ' reel via cookieless main /p/ video_versions (yt-dlp walled)');
          sendDl({ ok: true, files: publish(), viaMainVideo: true, usedCookies: false,
            note: 'reel via cookieless main /p/ page (video_versions) — yt-dlp was login-walled' });
        } else { fail502(err); }
      });
    }
    function embedRescueOr502(err) {
      if (!photoPost) { mainVideoRescueOr502(err); return; }
      wipeTmp();
      igEmbedImageFallback(url, id, tmpDir).then(emImgs => {
        if (emImgs.length && tmpFiles().length) {
          // (dev0678) Only the genuine embed-page picture is the low-res "first image
          // only" case; the main /p/ cover is the full-res original (dev0677).
          const viaMainCover = emImgs.source === 'main';
          console.log('[ig/download] ' + id + (viaMainCover
            ? ' cookieless full-res cover off the main /p/ page'
            : ' last-resort cookieless EMBED image (thumbnail)'));
          sendDl({ ok: true, files: publish(), viaEmbed: !viaMainCover, viaCover: viaMainCover, usedCookies: false,
            note: viaMainCover
              ? 'index-1 cover at full resolution, cookieless (main /p/ page)'
              : 'via embed — first image only (re-run later for the full carousel)' });
        } else { fail502(err); }
      });
    }
    // (dev0495) gallery-dl IMAGE-carousel net for photo posts. yt-dlp doesn't fetch IG
    // still images (video tool → 0 entries), so an image-only /p only ever yielded the
    // embed's first picture. gallery-dl pulls the WHOLE carousel at full res — but IG
    // login-walls it cookielessly (redirects to /accounts/login/), so it MUST use the
    // user's Firefox cookies (opted in; Firefox is logged into IG). Tried after yt-dlp,
    // before the embed last resort. usedCookies:true is HONEST so the client reports it.
    function galleryDlOrEmbed(err) {
      if (!photoPost || !IG_GALLERYDL) { embedRescueOr502(err); return; }
      wipeTmp();
      galleryDlImages(url, tmpDir).then(files => {
        if (files.length && tmpFiles().length) {
          console.log('[ig/download] ' + id + ' got ' + tmpFiles().length + ' image(s) via gallery-dl (Firefox cookies)');
          sendDl({ ok: true, files: publish(), viaGalleryDl: true, usedCookies: true,
            note: 'full image carousel via gallery-dl (Firefox cookies — image posts are login-walled cookieless)' });
        } else { embedRescueOr502(err); }
      });
    }
    // (dev0512) COVER-ONLY mode (client toggle): skip the whole yt-dlp/gallery-dl chain
    // and grab JUST the cookieless index-1 cover off the main /p/ page. For authors whose
    // page-1 is the keeper and page-2 is camera/EXIF junk — pure cookieless, no carousel.
    if (coverOnly) {
      igEmbedImageFallback(url, id, tmpDir).then(imgs => {
        if (imgs.length && tmpFiles().length) {
          coverWebpToJpg(tmpDir).then(() => {     // (dev0513) webp cover → real .jpg
            const viaMainCover = imgs.source === 'main';   // (dev0678) full-res vs embed thumb
            console.log('[ig/download] ' + id + ' cover-only (cookieless index-1, ' + (viaMainCover ? 'full-res main page' : 'embed thumbnail') + ')');
            sendDl({ ok: true, files: publish(), viaEmbed: !viaMainCover, viaCover: viaMainCover,
              usedCookies: false, coverOnly: true,
              note: 'cover only — index-1 image, cookieless (' + (viaMainCover ? 'main /p/ page, full res' : 'embed page thumbnail') + ')' });
          });
        } else { fail502('cover-only: no cookieless image found (is this a photo /p post?)'); }
      });
      return;
    }
    // (dev0648) FULL-CAROUSEL-FIRST for /p posts. yt-dlp is a video tool, so on a MIXED
    // photo+video carousel its cookieless run fetches ONLY the video items and returns a
    // PARTIAL — which the old yt-dlp-first flow accepted (tmpFiles().length>0 → publish)
    // and never completed to the full set. The cookieless walker assembles the WHOLE
    // carousel (photos+videos) from the /p/ page's inline carousel_media, and dev0647's
    // igGetPageHtml rides out the VPN photo wall, so try it FIRST for any /p post: a real
    // carousel (≥2 items) wins outright; only a single-item post (<2 → []) falls through
    // to the yt-dlp-first chain below (single reel/video, or single-photo cover). Reels
    // (/reel/) aren't photoPosts (single-item by nature) and skip straight to yt-dlp.
    // Cover-only mode above is untouched — the page-1-only path for its author survives.

    // The yt-dlp-first chain: single-item /p posts and all reels. The terminal fallback
    // splits by kind — a /p that already missed the carousel walker goes to gallery-dl/
    // embed cover (no point re-walking), a reel goes to the video_versions rescue.
    const ytdlpChain = () => {
      const terminal = photoPost ? galleryDlOrEmbed : mainVideoRescueOr502;
      run(false, (ok1, err1) => {
        // (dev0660) Require actual FILES on disk, not just a yt-dlp exit-0. A pure-photo /p
        // post makes yt-dlp (a video tool) exit 0 having written NOTHING; the old `ok1 ||`
        // then returned {ok:true, files:[]}, and the client stamped status='downloaded' on a
        // download that landed no media (found 18 such rows). A nonzero exit that still wrote
        // files (partial carousel) is unaffected — tmpFiles().length already covers it.
        if (tmpFiles().length) { sendDl({ ok: true, files: publish() }); return; }
        // (dev0494) Download-only cookie net (separate from enrich's IG_USE_COOKIES):
        // cookieless yt-dlp came back empty → try Firefox cookies if the user opted in.
        if (!IG_DOWNLOAD_USE_COOKIES) { terminal(err1); return; }
        wipeTmp();   // clear any partial cookieless output before the cookie retry
        run(true, (ok2, err2) => {
          if (tmpFiles().length) { sendDl({ ok: true, files: publish(), usedCookies: true, note: 'needed Firefox cookies' }); return; }  // (dev0660) files-not-exit-code, see above
          terminal(err2 || err1);
        });
      });
    };
    // A /p post may be a carousel — assemble the whole thing cookielessly first. <2 items
    // (single photo/video, or a throttled walk) falls through to the yt-dlp-first chain.
    if (photoPost) {
      igMainCarouselFallback(url, id, tmpDir).then(walk => {
        // (dev0690) The walk answers "how many items does this post have?" even when it
        // decides not to handle the post — record that before branching either way.
        if (walk.items.length >= 2) postItemsHint = walk.items.length;
        else if (walk.single) postItemsHint = 1;
        if (walk.files.length && tmpFiles().length) {
          console.log('[ig/download] ' + id + ' got ' + tmpFiles().length + ' item(s) via cookieless main /p/ carousel_media (carousel-first)'
            + (walk.videoItems ? ' · ' + walk.upgraded + '/' + walk.videoItems + ' video item(s) from yt-dlp at max res' : ''));
          sendDl({ ok: true, files: publish(), viaMainCarousel: true, usedCookies: false,
            upgraded: walk.upgraded, videoItems: walk.videoItems,
            note: 'full carousel via cookieless main /p/ page (carousel_media) — no Firefox cookies'
                + (walk.videoItems ? '; ' + walk.upgraded + ' of ' + walk.videoItems + ' video item(s) via yt-dlp at max res' : '') });
        } else { wipeTmp(); ytdlpChain(); }
      });
      return;
    }
    ytdlpChain();
  }).catch(err => sendJson(res, 400, { ok: false, error: err.message }, origin));
}

// ══════════════════════════════════════════════════════════════════════════════
// (dev0698) /ig/probe-res — DOES INSTAGRAM STILL HAVE A BIGGER VIDEO THAN THE
// FILE ON DISK?  Metadata only: nothing is downloaded, nothing is overwritten.
// ══════════════════════════════════════════════════════════════════════════════
//
// WHY THIS AND NOT A RE-DOWNLOAD. The only way this collection could previously
// answer "is there a better copy?" was to fetch the whole post again and let
// publish()'s overwrite guard measure the result — 3,454 files' worth of traffic
// to learn a fact yt-dlp will state for free. `yt-dlp -J --skip-download` returns
// the FORMAT LADDER (every rung IG will serve), which is the same ladder the
// downloader picks from, so its top rung is exactly what a re-download would land.
//
// WHY yt-dlp AND NOT THE PAGE. igResAudit.js settles the PHOTO side from the /p
// page's declared `original_width`. That page cannot answer for video: dev0690
// established that its `video_versions` are the 720-capped logged-out entries, so
// a declared-vs-held comparison there is meaningless. yt-dlp bootstraps a session
// and reaches the real ladder (1080x1440 where the page offers 720x960, measured
// same post, same minute). So: page for photos, yt-dlp for video.
//
// The two sides of the comparison:
//   HELD  — ffprobe'd from the actual video files in ig_media (via probeMediaDims,
//           which memoizes on size+mtime, so a re-probe of an unchanged file is
//           free). NOT the row's dlW/dlH: those are the max across ALL items, so a
//           carousel whose biggest item is a photo would compare a photo against a
//           video and conclude nonsense.
//   AVAIL — the biggest rung per VIDEO entry of the post. --ignore-errors makes a
//           photo carousel item come back as a bare null in entries[] (the same
//           behaviour ytdlpCompact relies on), so what survives IS the video set.
//
// Both lists are sorted by pixels and compared pairwise, so item ORDER never
// matters — only how many rungs are bigger than what we hold, and by how much.
// A shortfall in COUNT (IG has 3 video items, disk has 2) is reported separately
// as `missing`: that is a throttled walk, not a resolution verdict.
//
// Refusing to guess: if the row claims video files and none of them can be read
// off disk, this answers with an error instead of "IG has more", because an
// empty held-side would otherwise look identical to a genuine gap.
const IG_PROBE_VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v)$/i;

// A client-supplied localFiles entry ("<author>/<name>", dev0689) → an absolute
// path that is provably INSIDE ig_media, or null. The client is local and trusted,
// but this is the one place it names a filesystem path, so it is validated as if
// it weren't: no traversal, no absolute path, no drive letter escapes.
function igResolveMediaFile(rel) {
  const s = String(rel == null ? '' : rel);
  if (!s || s.length > 400 || s.includes('\0')) return null;
  const base = path.resolve(IG_MEDIA_DIR);
  const abs = path.resolve(base, s.replace(/\\/g, '/'));
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

// yt-dlp -J, no media. Resolves { ok:true, doc } or { ok:false, error } — the error
// being yt-dlp's own last stderr line, so the client's WALL_RE recognises a login
// wall / rate-limit in it exactly as it does for enrich and download.
function igYtdlpProbe(url) {
  return new Promise(resolve => {
    const impersonate = IG_IMPERSONATE ? ['--impersonate', IG_IMPERSONATE] : [];
    const args = ['--no-warnings', '--ignore-config', '--socket-timeout', '20',
                  '--skip-download', '--ignore-errors', '-J']
      .concat(impersonate, [url]);
    let proc;
    try { proc = spawn(EXEC_BIN.ytdlp, args, { windowsHide: true }); }
    catch (e) { resolve({ ok: false, error: 'spawn yt-dlp: ' + e.message }); return; }
    ACTIVE_DL.add(proc);   // (dev0658) a dropped tunnel kills probes too
    let out = '', err = '', done = false;
    const finish = o => {
      if (done) return; done = true;
      ACTIVE_DL.delete(proc); clearTimeout(killT);
      resolve(o);
    };
    const killT = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      finish({ ok: false, error: 'yt-dlp timed out (60s)' });
    }, 60000);
    proc.stdout.on('data', c => {
      out += c.toString('utf8');
      // A -J document for one post is tens of KB. Anything past this is a runaway.
      if (out.length > 24e6) { try { proc.kill('SIGKILL'); } catch (_) {} }
    });
    proc.stderr.on('data', c => { if (err.length < 4000) err += c.toString('utf8'); });
    proc.on('error', e => finish({ ok: false, error: e.message }));
    proc.on('close', () => {
      let doc = null; try { doc = JSON.parse(out || 'null'); } catch (_) {}
      if (!doc || typeof doc !== 'object') {
        finish({ ok: false, error: (err.trim().split(/\r?\n/).filter(Boolean).pop() || 'yt-dlp returned no JSON').slice(0, 300) });
        return;
      }
      finish({ ok: true, doc });
    });
  });
}

// A -J document → one {w,h} per VIDEO item: the biggest rung yt-dlp lists for it.
// A single reel is the document itself; a carousel is entries[] (photo items are
// null there, and are simply not video).
function igProbeRungs(doc) {
  const entries = Array.isArray(doc.entries) ? doc.entries : [doc];
  const out = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    let best = null;
    const fmts = Array.isArray(e.formats) ? e.formats : [];
    for (const f of fmts) {
      if (!f || f.vcodec === 'none') continue;      // audio-only rung
      const w = +f.width || 0, h = +f.height || 0;
      if (w <= 0 || h <= 0) continue;
      if (!best || w * h > best.w * best.h) best = { w, h };
    }
    // No formats[] at all (an older extractor shape) — adopt the entry's own
    // dimensions, but only when it actually claims to be video, so a photo item
    // can never be counted as a video rung we're missing.
    if (!best && (+e.width > 0 && +e.height > 0) && e.vcodec && e.vcodec !== 'none') {
      best = { w: +e.width, h: +e.height };
    }
    if (best) out.push(best);
  }
  return out;
}

// held[] vs avail[] → the verdict the I screen stamps on the row.
function igProbeVerdict(held, avail) {
  const px = d => d.w * d.h;
  const desc = l => l.slice().sort((a, b) => px(b) - px(a));
  const stat = l => l.length
    ? { n: l.length, maxW: Math.max(...l.map(d => d.w)), maxH: Math.max(...l.map(d => d.h)),
        minW: Math.min(...l.map(d => d.w)), dims: l.map(d => [d.w, d.h]) }
    : { n: 0, maxW: 0, maxH: 0, minW: 0, dims: [] };
  const H = desc(held), A = desc(avail);
  let gain = 0, gainW = 0, pair = null, bestDelta = 0;
  for (let i = 0; i < Math.min(H.length, A.length); i++) {
    const delta = px(A[i]) - px(H[i]);
    if (delta <= 0) continue;
    gain++;
    if (A[i].w - H[i].w > gainW) gainW = A[i].w - H[i].w;
    if (!pair || delta > bestDelta) { pair = { held: [H[i].w, H[i].h], avail: [A[i].w, A[i].h] }; bestDelta = delta; }
  }
  const missing = Math.max(0, A.length - H.length);
  return { held: stat(H), avail: stat(A), gain, gainW, missing,
           upgrade: (gain > 0 || missing > 0) ? 1 : 0, pair };
}

async function igProbeOne(it) {
  const id = String((it && it.id) || '').replace(/[^A-Za-z0-9_-]/g, '');
  const url = String((it && it.url) || '');
  if (!id) return { id: '', ok: false, error: 'id required' };
  if (!/^https?:\/\//i.test(url) || url.length > 2048) return { id, ok: false, error: 'valid http(s) url required' };
  // ── held side, before spending a fetch: an unreadable disk side can't be
  // compared with anything, and finding that out is free.
  const files = Array.isArray(it.files) ? it.files : [];
  const held = [];
  let claimed = 0;
  for (const f of files) {
    if (!IG_PROBE_VIDEO_EXT.test(String(f || ''))) continue;
    claimed++;
    const abs = igResolveMediaFile(f);
    const d = abs ? probeMediaDims(abs) : null;
    if (d && d.w > 0 && d.h > 0) held.push(d);
  }
  if (claimed > 0 && !held.length) {
    return { id, ok: false, error: 'held video file(s) unreadable on disk (' + claimed + ' claimed)' };
  }
  const p = await igYtdlpProbe(url);
  if (!p.ok) return { id, ok: false, error: String(p.error || '').slice(0, 300) };
  const avail = igProbeRungs(p.doc);
  // yt-dlp read the post and it has no video at all. That is a real answer for a
  // photo-only /p (nothing here to upgrade), so it is ok:true with n=0 — the client
  // records it and stops asking. Only IG failing to answer is an error.
  return Object.assign({ id, ok: true, unreadable: claimed - held.length }, igProbeVerdict(held, avail));
}

// POST /ig/probe-res  { items:[{id,url,files:[…]}], jobs? } → { ok, results:[…] }
// The CLIENT chunks and paces; this runs one chunk with a small parallel pool
// (same shape as igResAudit.js --jobs) and a jitter between spawns.
function igProbeRes(req, res, origin) {
  readJson(req, 2 * 1024 * 1024).then(async payload => {
    const items = Array.isArray(payload.items) ? payload.items.slice(0, 24) : [];
    if (!items.length) { sendJson(res, 400, { ok: false, error: 'items[] required' }, origin); return; }
    const jobs = Math.max(1, Math.min(4, +payload.jobs || 3));
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => {
      for (;;) {
        const k = next++;
        if (k >= items.length) return;
        try { results[k] = await igProbeOne(items[k]); }
        catch (e) { results[k] = { id: String((items[k] && items[k].id) || ''), ok: false, error: (e && e.message) || 'probe failed' }; }
        await new Promise(r => setTimeout(r, 150 + Math.floor(Math.random() * 350)));
      }
    }));
    const up = results.filter(r => r && r.ok && r.upgrade).length;
    console.log('[ig/probe-res] ' + items.length + ' post(s) · ' + up + ' with a bigger video available'
      + ' · ' + results.filter(r => r && !r.ok).length + ' unreadable');
    sendJson(res, 200, { ok: true, results }, origin);
  }).catch(err => sendJson(res, 400, { ok: false, error: err.message }, origin));
}

// (dev0599) ── Flickr single-photo resolver ────────────────────────────────────
// GET /flickr/resolve?url=<flickr photo-page OR staticflickr CDN url> (or ?id=<n>).
// Two light, unsigned read calls — flickr.photos.getSizes (best-res URL) and
// flickr.photos.getInfo (title / author / date-taken / caption) — assembled into
// the exact field split ml.json uses for image rows:
//     link=best-res · linkpage=photo page · VidTitle · VidAuthor · VidDate · comment
// Powers the T-screen `w` import's Flickr enrichment + the manual housekeeping
// pass. The api_key is the one the linkfinders share (linkfinders/flickr_api.json,
// gitignored) and stays SERVER-SIDE — never shipped to the browser. Best-res logic
// mirrors linkfinders/imagefinder.py's flickr_choose_best so `w` ≡ imagefinder4.
const FLICKR_API_JSON = path.join(X_FINDER_DIR, 'flickr_api.json');
let _flickrKey = null, _flickrKeyTried = false;
function flickrApiKey() {
  if (_flickrKeyTried) return _flickrKey;
  _flickrKeyTried = true;
  try { _flickrKey = JSON.parse(fs.readFileSync(FLICKR_API_JSON, 'utf8')).api_key || null; }
  catch (_) { _flickrKey = null; }
  return _flickrKey;
}
function flickrPhotoId(url) {
  if (!url) return null;
  const s = String(url);
  let m = s.match(/flickr\.com\/photos\/[^/]+\/(\d+)/i);  if (m) return m[1];
  m = s.match(/staticflickr\.com\/\d+\/(\d+)_/i);          if (m) return m[1];
  m = s.match(/flickr\.com\/photo\.gne\?id=(\d+)/i);       if (m) return m[1];
  m = s.match(/^\s*(\d{6,})\s*$/);                         if (m) return m[1];
  return null;
}
function flickrApi(method, params) {
  return new Promise((resolve, reject) => {
    const key = flickrApiKey();
    if (!key) { reject(new Error('no flickr api key (linkfinders/flickr_api.json)')); return; }
    const qs = new URLSearchParams(Object.assign(
      { method, api_key: key, format: 'json', nojsoncallback: 1 }, params)).toString();
    const r = https.get('https://api.flickr.com/services/rest/?' + qs, resp => {
      let buf = '';
      resp.on('data', c => buf += c);
      resp.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (j.stat !== 'ok') { reject(new Error(j.message || ('flickr ' + method + ' error'))); return; }
          resolve(j);
        } catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    r.setTimeout(20000, () => r.destroy(new Error('flickr api timeout')));
  });
}
function flickrStripHtml(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function flickrPickBest(sizes) {
  if (!sizes || !sizes.length) return null;
  const rank = s => {
    const w = +s.width || 0, h = +s.height || 0;
    const u = s.source || '';
    let bonus = /original/i.test(s.label || '') ? 6 : 0;
    if (!bonus) for (const [suf, b] of [['_o.', 6], ['_k.', 5], ['_h.', 4], ['_b.', 3], ['_c.', 2], ['_z.', 1]]) {
      if (u.includes(suf)) { bonus = b; break; }
    }
    return w * h * 10 + bonus;
  };
  return sizes.reduce((a, b) => (rank(b) > rank(a) ? b : a));
}
async function flickrResolve(req, res, origin) {
  let q;
  try { q = new URL(req.url, 'http://x').searchParams; } catch (_) { q = new URLSearchParams(); }
  const raw = q.get('url') || q.get('id') || '';
  const pid = flickrPhotoId(raw);
  if (!pid) { sendJson(res, 400, { ok: false, error: 'no flickr photo id in: ' + raw }, origin); return; }
  try {
    const [info, sizesResp] = await Promise.all([
      flickrApi('flickr.photos.getInfo',  { photo_id: pid }).catch(() => null),
      flickrApi('flickr.photos.getSizes', { photo_id: pid }).catch(() => null),
    ]);
    const out = { ok: true, photo_id: pid };
    const sizes = (sizesResp && sizesResp.sizes && sizesResp.sizes.size) || [];
    const best = flickrPickBest(sizes.filter(s => !s.media || s.media === 'photo'));
    if (best) {
      out.link = best.source;
      out.width = +best.width || 0;
      out.height = +best.height || 0;
      if (out.width && out.height) out.MPix = (out.width * out.height / 1e6).toFixed(1);
      out.Mode = out.width > out.height ? 'L' : (out.width < out.height ? 'P' : 'S');
    }
    if (info && info.photo) {
      const p = info.photo;
      const title = (p.title && p.title._content || '').trim();
      if (title) out.VidTitle = title;
      const author = (p.owner && (p.owner.realname || p.owner.username) || '').trim();
      if (author) out.VidAuthor = author;
      const taken = (p.dates && p.dates.taken) || '';
      if (taken) out.VidDate = String(taken).slice(0, 10);
      const desc = flickrStripHtml(p.description && p.description._content || '');
      if (desc) out.comment = desc;
      let page = '';
      if (p.urls && p.urls.url) for (const u of p.urls.url) { if (u.type === 'photopage') { page = u._content; break; } }
      if (!page) {
        const owner = (p.owner && (p.owner.path_alias || p.owner.nsid)) || '';
        if (owner) page = 'https://www.flickr.com/photos/' + owner + '/' + pid + '/';
      }
      if (page) out.linkpage = page;
    }
    if (!out.link && !out.VidTitle) { sendJson(res, 502, { ok: false, error: 'flickr returned nothing for ' + pid }, origin); return; }
    sendJson(res, 200, out, origin);
  } catch (e) {
    sendJson(res, 502, { ok: false, error: String((e && e.message) || e) }, origin);
  }
}

// (dev0693) ── Pinterest resolver + downloader ───────────────────────────────
// Pinterest pin pages read fine COOKIELESS (measured 2026-07-28: HTTP 200 with the
// full OG tag set AND the video manifest URLs — no login wall, no bot check), and
// yt-dlp ships a native Pinterest extractor, so this needs no credentials and no
// new scraping stack. Rides the existing yt-dlp binary (see EXEC_BIN).
//
// The resolver's job is to turn `pinterest.com/pin/<id>/` — which carries no file
// extension and therefore imports as an ltype='w' article, the same trap as IG
// (dev0581), TikTok (dev0605) and Macaulay (dev0600) — into something SLAM can
// actually play:
//
//   image pin       → i.pinimg.com/originals/….jpg          (normal image row)
//   video + mp4     → v1.pinimg.com/videos/mc/720p/….mp4     (direct <video>: seek,
//                     VidRange segments, steps — everything an embed can't do)
//   video, HLS only → no progressive mp4 exists; the row KEEPS the pin URL and the
//                     client falls back to the official iframe (`hls:true` says so)
//
// The HLS split is real and roughly even in sampling: pins served from `videos/mc/`
// usually expose a progressive `mc/720p/<hash>.mp4`, pins from `videos/iht/` are
// often HLS-only. The progressive path can SOMETIMES be guessed from an HLS hash
// (worked for 1 of 2 tried), so it's probed as a last resort — never assumed.
const PIN_MEDIA_DIR = path.join(__dirname, 'pin_media');
// Full desktop-Chrome UA. A short UA still gets HTML but Pinterest drops some of the
// OG tags for it; this is the string the resolve/download paths were verified with.
const PIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
             + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Pin id from any public pin address. Pinterest addresses one pin several ways:
//   /pin/<id>/ · /pin/<slug>--<id>/ · country hosts (pinterest.co.uk, .de, …)
// plus the `pin.it/<code>` shortener, which has no id at all and is resolved by
// following its redirect (pinResolveShort). One regex, one place — the dev0611
// rule: never let a provider predicate exist in two files with two answers.
const PIN_PATH_RE = /(?:^|\/\/|\.)pinterest\.[a-z.]{2,6}\/pin\/(?:[^/?#]*?--)?(\d{6,25})/i;
function pinterestPinId(url) {
  const m = PIN_PATH_RE.exec(String(url || ''));
  return m ? m[1] : '';
}
function pinIsShortLink(url) { return /(?:^|\/\/|\.)pin\.it\//i.test(String(url || '')); }
function pinPageUrl(id) { return 'https://www.pinterest.com/pin/' + id + '/'; }
// Official widget iframe — what Pinterest's own embed.js resolves a pin to. Verified
// 2026-07-28: HTTP 200, and NO X-Frame-Options / frame-ancestors, so it frames from
// any origin cookielessly. Must stay in step with pinterestEmbedUrl() in video.js.
function pinEmbedUrl(id) { return 'https://assets.pinterest.com/ext/embed.html?id=' + id; }

// GET a page cookieless, following redirects, resolving { status, html, finalUrl }.
// finalUrl is what makes pin.it work: the shortener 301s to the real /pin/<id>/.
function pinFetchHtml(url, hops) {
  return new Promise(resolve => {
    if (hops == null) hops = 0;
    let u; try { u = new URL(url); } catch (_) { resolve({ status: 0, html: '', finalUrl: url }); return; }
    if (u.protocol !== 'https:') { resolve({ status: 0, html: '', finalUrl: url }); return; }
    const opts = { agent: false, headers: {
      'User-Agent': PIN_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9', 'Connection': 'close'
    } };
    const req = https.get(url, opts, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 4) {
        r.resume();
        pinFetchHtml(new URL(r.headers.location, url).href, hops + 1).then(resolve);
        return;
      }
      if (r.statusCode !== 200) { r.resume(); resolve({ status: r.statusCode, html: '', finalUrl: url }); return; }
      let h = '';
      r.setEncoding('utf8');
      // Pin pages are ~1MB of app JSON; 8MB is headroom, not a target.
      r.on('data', c => { h += c; if (h.length > 8e6) req.destroy(); });
      r.on('end', () => resolve({ status: 200, html: h, finalUrl: url }));
    });
    req.on('error', () => resolve({ status: 0, html: '', finalUrl: url }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ status: 0, html: '', finalUrl: url }); });
  });
}

// Pinterest emits <meta content="…" name="og:image" property="og:image"/> — content
// FIRST — so an attribute-order-sensitive regex silently returns nothing (it did,
// during this build). Parse each tag whole and read its attributes in any order.
function pinMetaTags(html) {
  const out = {};
  const tags = String(html || '').match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const key = (/\b(?:property|name)\s*=\s*"([^"]+)"/i.exec(tag) || [])[1];
    const val = (/\bcontent\s*=\s*"([^"]*)"/i.exec(tag) || [])[1];
    if (key && val != null && !(key in out)) out[key] = pinDecodeEntities(val);
  }
  return out;
}
function pinDecodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&#x27;/gi, "'").replace(/&#39;/g, "'").replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

function pinHeadOk(url) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (_) { resolve(0); return; }
    const opts = { method: 'HEAD', agent: false, headers: { 'User-Agent': PIN_UA, 'Connection': 'close' } };
    const req = https.request(u, opts, r => {
      r.resume();
      resolve(r.statusCode === 200 ? (+r.headers['content-length'] || 1) : 0);
    });
    req.on('error', () => resolve(0));
    req.setTimeout(12000, () => { req.destroy(); resolve(0); });
    req.end();
  });
}

// og:image arrives as a SIZED derivative (i.pinimg.com/736x/ab/cd/ef/<hash>.jpg).
// Swap the size segment for /originals/ and keep it only if it really serves; some
// pins have no original, so /1200x/ then the untouched og:image are the fallbacks.
// Returns { url, bytes }.
async function pinBestImage(ogImage) {
  const src = String(ogImage || '');
  if (!/i\.pinimg\.com\//i.test(src)) return { url: src, bytes: 0 };
  const cands = [];
  for (const size of ['originals', '1200x']) {
    const alt = src.replace(/\/(originals|\d+x(?:\d+)?(?:_RS)?)\//i, '/' + size + '/');
    if (alt !== src || /\/originals\//i.test(src)) cands.push(alt);
  }
  cands.push(src);
  for (const c of cands) {
    const bytes = await pinHeadOk(c);
    if (bytes) return { url: c, bytes };
  }
  return { url: src, bytes: 0 };
}

// yt-dlp -J on a pin. Resolves the parsed document or null (a static image pin has
// no video and yt-dlp exits non-zero — that is a normal outcome here, not an error).
function pinYtdlpMeta(url) {
  return new Promise(resolve => {
    let out = '', done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    let proc;
    try {
      proc = spawn(EXEC_BIN.ytdlp, ['--no-warnings', '--ignore-config', '--socket-timeout', '20',
                                    '-J', '--skip-download', url], { windowsHide: true });
    } catch (_) { finish(null); return; }
    proc.stdout.on('data', c => { out += c; if (out.length > 12e6) proc.kill(); });
    proc.stderr.on('data', () => {});
    proc.on('error', () => finish(null));
    proc.on('close', () => { try { finish(JSON.parse(out)); } catch (_) { finish(null); } });
    setTimeout(() => { try { proc.kill(); } catch (_) {} finish(null); }, 60000);
  });
}

// Best PROGRESSIVE (plain-mp4) video format. Manifest protocols are rejected outright
// — an m3u8 in a <video src> is a dead player in Chrome/Firefox, which is the entire
// reason the embed fallback exists. HEVC is rejected too: it downloads fine and then
// won't decode in most browsers, which is a worse failure than falling back honestly.
function pinPickProgressive(meta) {
  const fmts = (meta && meta.formats) || [];
  let best = null;
  for (const f of fmts) {
    if (!f || f.protocol !== 'https' || !f.url) continue;
    if (f.vcodec === 'none') continue;                       // audio-only
    if (/hev1|hvc1|h265/i.test(String(f.vcodec || ''))) continue;
    if (!/\.mp4(\?|#|$)/i.test(f.url)) continue;
    const px = (+f.width || 0) * (+f.height || 0);
    if (!best || px > best._px) { best = Object.assign({}, f, { _px: px }); }
  }
  return best;
}

// Media duration in seconds via ffprobe, or 0. Images (and anything unreadable)
// return 0, which the filename stamps as 00.00.00.
function pinProbeDuration(file) {
  try {
    const raw = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'csv=p=0', file], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    return Math.max(0, Math.round(parseFloat(String(raw).trim()) || 0));
  } catch (_) { return 0; }
}
// Replace the client's `00.00.00~0x0~` placeholders with values measured off the
// finished file. The client cannot know either number (ml.json stores neither a
// per-row W×H nor a duration at import time), so the filename is built from what is
// actually on disk rather than from a guess — same principle as the dev0690 guard.
function pinStampName(base, file) {
  const d = probeMediaDims(file);
  const secs = pinProbeDuration(file);
  const hms = [Math.floor(secs / 3600), Math.floor(secs / 60) % 60, secs % 60]
    .map(x => String(x).padStart(2, '0')).join('.');
  const wh = (d && d.w && d.h) ? (d.w + 'x' + d.h) : '0x0';
  return base.replace(/^00\.00\.00~0x0~/, hms + '~' + wh + '~');
}

// Last resort for an HLS-only pin: Pinterest sometimes ALSO stores a progressive mp4
// at the mirrored `mc/720p/<aa>/<bb>/<cc>/<hash>.mp4` path even when it isn't in the
// manifest. Probed, never assumed — it existed for 1 of 2 HLS-only pins tested.
async function pinProbeProgressive(meta) {
  const fmts = (meta && meta.formats) || [];
  let hash = '';
  for (const f of fmts) {
    const m = /\/videos\/(?:mc|iht)\/[^/]+\/(?:[0-9a-f]{2}\/){3}([0-9a-f]{32})/i.exec(String((f && (f.url || f.manifest_url)) || ''));
    if (m) { hash = m[1]; break; }
  }
  if (!hash) return null;
  const seg = hash.slice(0, 2) + '/' + hash.slice(2, 4) + '/' + hash.slice(4, 6) + '/' + hash;
  for (const variant of ['mc/720p', 'iht/720p']) {
    const url = 'https://v1.pinimg.com/videos/' + variant + '/' + seg + '.mp4';
    if (await pinHeadOk(url)) return url;
  }
  return null;
}

// GET /pinterest/resolve?url=…  — read-only, mirrors /flickr/resolve (including its
// open-origin stance: harmless public reads, and sendJson echoes the local origin).
async function pinterestResolve(req, res, origin) {
  let q;
  try { q = new URL(req.url, 'http://x').searchParams; } catch (_) { q = new URLSearchParams(); }
  const raw = (q.get('url') || q.get('id') || '').trim();
  if (!raw) { sendJson(res, 400, { ok: false, error: 'url required' }, origin); return; }
  try {
    // pin.it has no id in the URL — one fetch both resolves the redirect and gives
    // us the page, so the shortener costs nothing extra.
    let pageUrl = /^https?:\/\//i.test(raw) ? raw : pinPageUrl(raw.replace(/\D/g, ''));
    let page = await pinFetchHtml(pageUrl);
    let id = pinterestPinId(page.finalUrl) || pinterestPinId(pageUrl);
    if (!id && pinIsShortLink(pageUrl)) {
      sendJson(res, 502, { ok: false, error: 'pin.it did not resolve to a pin: ' + pageUrl }, origin); return;
    }
    if (!id) { sendJson(res, 400, { ok: false, error: 'no pinterest pin id in: ' + raw }, origin); return; }
    const canonical = pinPageUrl(id);
    if (page.status !== 200) page = await pinFetchHtml(canonical);

    const meta = pinMetaTags(page.html);
    const yt   = await pinYtdlpMeta(canonical);

    const out = { ok: true, pin_id: id, linkpage: canonical, embedUrl: pinEmbedUrl(id) };

    // ── title / author / date / description / categories ──────────────────
    // yt-dlp's title for a video pin is the useless placeholder "Pinterest video
    // #<id>", so og:title wins. og:title is "<real title> | <kw>, <kw>, <kw>" —
    // split once on the first '|': left = title, right = Pinterest's own keyword
    // cluster, which is decent tag fodder and joins yt-dlp's `categories`.
    const ogTitle = (meta['og:title'] || '').trim();
    const pipe = ogTitle.indexOf('|');
    let title = pipe > 0 ? ogTitle.slice(0, pipe).trim() : ogTitle;
    const kws = [];
    if (pipe > 0) ogTitle.slice(pipe + 1).split(',').forEach(s => { s = s.trim(); if (s) kws.push(s); });
    for (const c of (yt && yt.categories) || []) { const s = String(c || '').trim(); if (s) kws.push(s); }
    if (!title && yt && !/^Pinterest video #/i.test(yt.title || '')) title = (yt.title || '').trim();
    if (title) out.VidTitle = title;
    out.categories = Array.from(new Set(kws.map(s => s.replace(/\s+/g, ' ')))).slice(0, 24);

    const pinner = (meta['pinterestapp:pinner'] || '').replace(/\/+$/, '').split('/').pop();
    const uploader = (yt && (yt.uploader || yt.channel)) || pinner || '';
    if (uploader) { out.VidAuthor = '@' + uploader; out.authorUrl = 'https://www.pinterest.com/' + uploader + '/'; }
    if (yt && /^\d{8}$/.test(yt.upload_date || '')) {
      out.VidDate = yt.upload_date.slice(0, 4) + '-' + yt.upload_date.slice(4, 6) + '-' + yt.upload_date.slice(6, 8);
    } else if (meta['og:updated_time']) {
      out.VidDate = String(meta['og:updated_time']).slice(0, 10);
    }
    const desc = (meta['og:description'] || (yt && yt.description) || '').trim();
    if (desc) out.comment = desc;
    const board = (meta['pinterestapp:pinboard'] || '').replace(/\/+$/, '');
    if (board) { out.boardUrl = board; out.board = board.split('/').pop().replace(/-/g, ' '); }
    if (meta['pinterestapp:repins']) out.repins = +meta['pinterestapp:repins'] || 0;
    // The pin's OUTBOUND link — where the pinner sourced it. Often the real origin of
    // the media and far more reviewable than the pin itself. Empty for user uploads.
    const srcLink = (/"link"\s*:\s*"(https?:[^"\\]{4,400})"/i.exec(page.html) || [])[1];
    if (srcLink) { try { out.sourceLink = JSON.parse('"' + srcLink + '"'); } catch (_) { out.sourceLink = srcLink; } }

    // ── the media itself ──────────────────────────────────────────────────
    const poster = (meta['og:image'] || (yt && yt.thumbnail) || '').trim();
    const prog = pinPickProgressive(yt);
    if (yt && (yt.formats || []).length) {
      out.kind = 'video';
      if (yt.duration) out.duration = Math.round(+yt.duration);
      let vurl = prog && prog.url, vw = prog && +prog.width, vh = prog && +prog.height;
      if (!vurl) {
        const probed = await pinProbeProgressive(yt);
        if (probed) { vurl = probed; vw = +yt.width || 0; vh = +yt.height || 0; }
      }
      if (vurl) {
        out.direct = true;
        out.hls = false;
        out.link = vurl;
        out.width = vw || +yt.width || 0;
        out.height = vh || +yt.height || 0;
      } else {
        // HLS-only. Keep the PIN page as the link so the client mounts the official
        // iframe; report the manifest + best manifest size for the record.
        out.direct = false;
        out.hls = true;
        out.link = canonical;
        out.width = +yt.width || 0;
        out.height = +yt.height || 0;
        const man = (yt.formats || []).filter(f => f && f.manifest_url).pop();
        if (man) out.hlsUrl = man.manifest_url;
      }
      if (poster) out.poster = (await pinBestImage(poster)).url;
    } else {
      // No video formats at all → a static image pin.
      out.kind = 'image';
      out.direct = true;
      out.hls = false;
      const best = await pinBestImage(poster);
      out.link = best.url;
      out.width = +meta['og:image:width'] || 0;
      out.height = +meta['og:image:height'] || 0;
      out.poster = best.url;
    }

    if (out.width && out.height) {
      out.MPix = (out.width * out.height / 1e6).toFixed(1);
      out.Mode = out.width > out.height ? 'L' : (out.width < out.height ? 'P' : 'S');
    }
    if (!out.link) { sendJson(res, 502, { ok: false, error: 'pinterest returned no media for ' + id }, origin); return; }
    sendJson(res, 200, out, origin);
  } catch (e) {
    sendJson(res, 502, { ok: false, error: String((e && e.message) || e) }, origin);
  }
}

// POST /pinterest/download { url, id, name, author } — saves the pin's media into
// pin_media/<author>/<stem>.<ext>. Deliberately a SIBLING of igDownload rather than a
// reuse of it: IG's version carries the impersonate/cookie/wall-retry ladder that
// Pinterest simply doesn't need (everything here is public and cookieless), and the
// shared naming/measuring helpers (igSanitizeName / igAuthorFolder / probeMediaDims)
// are already generic. Video pins go through yt-dlp; image pins are a plain GET.
function pinterestDownload(req, res, origin) {
  readJson(req, 64 * 1024).then(async payload => {
    const url = String(payload.url || '');
    if (!/^https?:\/\//i.test(url) || url.length > 2048) { sendJson(res, 400, { ok: false, error: 'valid http(s) url required' }, origin); return; }
    const id = String(payload.id || pinterestPinId(url) || '').replace(/[^0-9]/g, '');
    if (!id) { sendJson(res, 400, { ok: false, error: 'pin id required' }, origin); return; }
    const folder = igAuthorFolder(String(payload.author || '').replace(/^@/, ''));
    const stem = igSanitizeName(payload.name || id).slice(0, 180);
    const destDir = path.join(PIN_MEDIA_DIR, folder);
    try { fs.mkdirSync(destDir, { recursive: true }); } catch (_) {}

    const finish = files => {
      const dims = files.map(f => probeMediaDims(path.join(destDir, f))).filter(Boolean);
      const px = dims.length ? Math.max(...dims.map(d => d.w * d.h)) : 0;
      sendJson(res, 200, {
        ok: files.length > 0,
        pin_id: id,
        folder,
        files,
        localFiles: files.map(f => (folder ? folder + '/' + f : f)),
        pixels: px,
        dims: dims.map(d => [d.w, d.h]),
        error: files.length ? undefined : 'nothing downloaded'
      }, origin);
    };

    // A direct media URL (mp4/jpg the resolver already found) is just a GET — no
    // reason to re-run yt-dlp and re-resolve the pin.
    const isDirectMedia = /(?:i|v\d*)\.pinimg\.com\//i.test(url);
    if (isDirectMedia) {
      const ext = (/\.([a-z0-9]{2,4})(?:\?|#|$)/i.exec(url) || [])[1] || 'jpg';
      // Land it under a temp name first: the duration/W×H stamp can only be measured
      // once the bytes are on disk.
      const tmpName = '.dl_' + id + '_' + Date.now().toString(36) + '.' + ext.toLowerCase();
      const tmpPath = path.join(destDir, tmpName);
      const got = await igDownloadImage(url, tmpPath, 'https://www.pinterest.com/', 0, '*/*');
      if (!got) { try { fs.unlinkSync(tmpPath); } catch (_) {} finish([]); return; }
      const base = pinStampName(stem, tmpPath) + '.' + ext.toLowerCase();
      try { fs.renameSync(tmpPath, path.join(destDir, base)); }
      catch (_) { try { fs.unlinkSync(tmpPath); } catch (_) {} finish([]); return; }
      finish([base]);
      return;
    }

    const tmpDir = path.join(destDir, '.tmp_' + id + '_' + Date.now().toString(36));
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}
    const rmTmp = () => { try { (fs.rmSync || fs.rmdirSync)(tmpDir, { recursive: true, force: true }); } catch (_) {} };
    // No --impersonate and no cookie ladder: Pinterest serves this cookieless.
    // -f picks the best NON-manifest mp4 so an HLS-only pin fails loudly here rather
    // than silently producing a remuxed file the rest of SLAM can't seek.
    const args = ['--no-warnings', '--ignore-config', '--socket-timeout', '20', '--no-part',
                  '-f', 'best[protocol=https][ext=mp4]/best[protocol=https]',
                  '-o', path.join(tmpDir, '%(autonumber)03d.%(ext)s'), url];
    let proc;
    try { proc = spawn(EXEC_BIN.ytdlp, args, { windowsHide: true }); }
    catch (e) { rmTmp(); sendJson(res, 500, { ok: false, error: 'spawn yt-dlp: ' + e.message }, origin); return; }
    let stderr = '';
    proc.stderr.on('data', c => { stderr += c; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    proc.stdout.on('data', () => {});
    proc.on('error', () => { rmTmp(); sendJson(res, 500, { ok: false, error: 'yt-dlp not runnable' }, origin); });
    proc.on('close', () => {
      let tmp = [];
      try { tmp = fs.readdirSync(tmpDir).filter(f => !f.startsWith('.') && !f.endsWith('.part')).sort(); } catch (_) {}
      const out = [];
      tmp.forEach((f, i) => {
        const src = path.join(tmpDir, f);
        const ext = (/\.([^.]+)$/.exec(f) || [])[1] || 'mp4';
        const base = pinStampName(stem, src)
          + (tmp.length > 1 ? ' [' + (i + 1) + ' of ' + tmp.length + ']' : '') + '.' + ext;
        try { fs.renameSync(src, path.join(destDir, base)); out.push(base); } catch (_) {}
      });
      rmTmp();
      if (!out.length) {
        sendJson(res, 502, { ok: false, pin_id: id, error: (stderr.trim().split(/\r?\n/).pop() || 'yt-dlp produced no file') }, origin);
        return;
      }
      finish(out);
    });
  }).catch(err => sendJson(res, 400, { ok: false, error: String((err && err.message) || err) }, origin));
}

// (dev0649) ── Proton VPN rotation state/bridge ───────────────────────────
// vpn-rotate.ps1 writes the chosen server + confirmed public IP into state.json
// under %LOCALAPPDATA%\ProtonVpnRotate; this reads it (no network call of its
// own) so /vpn/status is instant. A switch is fired via the no-UAC scheduled
// task, falling back to running the script directly (self-elevates → one UAC).
const VPN_STATE = path.join(process.env.LOCALAPPDATA || os.homedir(), 'ProtonVpnRotate', 'state.json');
const VPN_PS1   = path.join(__dirname, 'vpn-rotate.ps1');
const VPN_TASK  = 'ProtonVpnRotate';
const VPN_STOP_TASK = 'ProtonVpnStop';
// (dev0657) Recovery-tool targets for the I screen's "Fix" panel.
const SETUP_BAT   = path.join(__dirname, 'vpn-rotate-setup.bat');
const RESTART_PS1 = path.join(__dirname, 'restart-proxy.ps1');
const PS_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function vpnReadState() {
  try { return JSON.parse(fs.readFileSync(VPN_STATE, 'utf8')); }
  catch (_) { return null; }
}

// Tunnel-up test that doesn't depend on the adapter's friendly name: Proton's
// WireGuard configs hand the client a 10.2.x.x address, so any local IPv4 in
// 10.2.0.0/16 means a Proton tunnel is live. The 'proton_active' adapter name
// (our fixed staging tunnel) is accepted too as a fallback signal.
function vpnTunnelUp() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if ((a.family === 'IPv4' || a.family === 4) && /^10\.2\./.test(a.address)) return true;
    }
  }
  return !!ifs['proton_active'];
}

function vpnStateOut(st) {
  return {
    tunnelUp: vpnTunnelUp(),
    server:  st && st.lastFile ? String(st.lastFile).replace(/\.conf$/i, '') : null,
    ip:      st ? (st.ip || null) : null,
    city:    st ? (st.city || null) : null,
    country: st ? (st.country || null) : null,
    at:      st ? (st.at || null) : null
  };
}

function vpnStatus(res, origin) {
  const out = Object.assign({ ok: true }, vpnStateOut(vpnReadState()));
  // (dev0683) black-box note only — the answer itself is unchanged. This is the
  // line that settles "VPN dropped" vs "proxy stopped answering": if these keep
  // saying tunnelUp=true right up to the gap, the tunnel was never the problem.
  try { res._diagNote = `tunnelUp=${out.tunnelUp} ${out.server || out.ip || '?'}`; } catch (_) {}
  sendJson(res, 200, out, origin);
}

function vpnSwitch(res, origin) {
  const before = vpnReadState();
  const beforeAt = (before && before.at) || '';

  // Fire the rotation. Prefer the no-UAC scheduled task; if it isn't registered
  // (schtasks /run exits non-zero), fall back to launching the script, which
  // self-elevates with one UAC prompt.
  const runScript = () => {
    try {
      const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', VPN_PS1],
                      { detached: true, stdio: 'ignore' });
      p.on('error', () => {});
      p.unref();
    } catch (_) {}
  };
  let via = 'task';
  const t = spawn('schtasks', ['/run', '/tn', VPN_TASK], { windowsHide: true });
  t.on('error', () => { via = 'script'; runScript(); });
  t.on('close', code => { if (code !== 0) { via = 'script'; runScript(); } });

  // Wait (up to ~40s) for vpn-rotate.ps1 to write a NEW state.json — its `at`
  // only changes once the new tunnel is up and the fresh public IP was read.
  const t0 = Date.now();
  const poll = () => {
    const cur = vpnReadState();
    const changed = cur && cur.at && cur.at !== beforeAt;
    if (changed || Date.now() - t0 > 40000) {
      sendJson(res, 200, Object.assign(
        { ok: true, via, switched: !!changed }, vpnStateOut(cur || before)), origin);
      return;
    }
    setTimeout(poll, 1200);
  };
  setTimeout(poll, 1500);
}

// (dev0652) Tear down the proton_active tunnel so the Proton tray app takes over.
// Same trigger pattern as vpnSwitch (no-UAC task, script fallback with -Stop), then
// wait for the tunnel to actually go down (vpnTunnelUp() false).
function vpnStop(res, origin) {
  const runScript = () => {
    try {
      const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', VPN_PS1, '-Stop'],
                      { detached: true, stdio: 'ignore' });
      p.on('error', () => {});
      p.unref();
    } catch (_) {}
  };
  const t = spawn('schtasks', ['/run', '/tn', VPN_STOP_TASK], { windowsHide: true });
  t.on('error', () => runScript());
  t.on('close', code => { if (code !== 0) runScript(); });

  const t0 = Date.now();
  const poll = () => {
    if (!vpnTunnelUp() || Date.now() - t0 > 20000) {
      sendJson(res, 200, Object.assign(
        { ok: true, stopped: !vpnTunnelUp() }, vpnStateOut(vpnReadState())), origin);
      return;
    }
    setTimeout(poll, 1000);
  };
  setTimeout(poll, 1200);
}

// (dev0657) ── Recovery tools for the I screen's "Fix" panel ────────────────
// One-click equivalents of the CLI steps that un-stick the VPN/proxy, so the
// user never has to remember schtasks/PowerShell incantations.

// End any zombie 'Running' rotation/stop task. A rotation that hung (e.g. the PC
// slept mid-switch) sits Running under MultipleInstancesPolicy=IgnoreNew and
// REFUSES every later /vpn/switch with 0x800710E0 for up to 72h. schtasks /end
// clears it with NO elevation. Errors (not running / not registered) are benign.
function fixUnstickVpn(res, origin) {
  const tasks = [VPN_TASK, VPN_STOP_TASK];
  let done = 0;
  tasks.forEach(tn => {
    const p = spawn('schtasks', ['/end', '/tn', tn], { windowsHide: true });
    p.on('error', () => { if (++done === tasks.length) sendJson(res, 200, { ok: true, ended: tasks }, origin); });
    p.on('close', () => { if (++done === tasks.length) sendJson(res, 200, { ok: true, ended: tasks }, origin); });
  });
}

// Re-run vpn-rotate-setup.bat (self-elevates → one UAC) to (re)register both VPN
// tasks HARDENED to StopExisting + PT5M — the durable fix so a hung rotation can
// never block switching again. We can't wait on the UAC, so return immediately.
function fixHardenVpn(res, origin) {
  try {
    const p = spawn(process.env.COMSPEC || 'cmd.exe', ['/c', SETUP_BAT],
                    { cwd: __dirname, detached: true, stdio: 'ignore', windowsHide: false });
    p.on('error', () => {});
    p.unref();
    sendJson(res, 200, { ok: true, spawned: true, note: 'Approve the Windows UAC prompt, then close the setup window when it says Done.' }, origin);
  } catch (e) { sendJson(res, 500, { ok: false, error: e.message }, origin); }
}

// Restart the proxy itself (loads new code / clears a wedged state). We respond
// FIRST because restart-proxy.ps1 is about to kill THIS node, then spawn it
// detached so it outlives us. The client then polls /version until it's back.
function fixRestartProxy(res, origin) {
  sendJson(res, 200, { ok: true, restarting: true, build: PROXY_BUILD }, origin);
  setTimeout(() => {
    try {
      const p = spawn(PS_EXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RESTART_PS1],
                      { cwd: __dirname, detached: true, stdio: 'ignore', windowsHide: false });
      p.on('error', () => {});
      p.unref();
    } catch (_) {}
  }, 400);
}

// Snapshot for the Fix panel: proxy build + whether the VPN tasks are registered.
// schtasks /query exit 0 = registered. Non-sensitive, but origin-locked anyway.
function fixStatus(res, origin) {
  const has = tn => new Promise(resolve => {
    const p = spawn('schtasks', ['/query', '/tn', tn], { windowsHide: true });
    p.on('error', () => resolve(false));
    p.on('close', code => resolve(code === 0));
  });
  Promise.all([has(VPN_TASK), has(VPN_STOP_TASK)]).then(([rot, stop]) => {
    sendJson(res, 200, { ok: true, build: PROXY_BUILD, rotateTask: rot, stopTask: stop, tunnelUp: vpnTunnelUp() }, origin);
  });
}

http.createServer((req, res) => {
  // (dev0683) ── black-box request trace (diagnostics only) ──────────────────
  // One line in, one line out, for the routes a grind uses. A "→" with no "←"
  // pins the death to that handler; the duration column shows a stall building
  // before it. GET /vpn/status is the 5s pill poll — logged only when its verdict
  // changes, once a minute otherwise, or whenever it takes >1s (a slow status
  // read IS the early symptom of a proxy stall), so the poll can't drown the log.
  const _lp = req.url.split('?')[0];
  if (/^\/(ig|vpn|fix|exec|rec|frame|x|s|diag|pinterest)\//.test(_lp) || _lp === '/version') {
    LOG_REQS++;
    const _t0 = Date.now();
    const _isPoll = (req.method === 'GET' && _lp === '/vpn/status');
    const _clen = +(req.headers['content-length'] || 0);
    if (!_isPoll) plog(`→ ${req.method} ${_lp}${_clen ? ` body=${(_clen / 1048576).toFixed(1)}MB` : ''}`);
    let _logged = false;
    const _done = () => {
      if (_logged) return; _logged = true;
      const ms = Date.now() - _t0;
      const extra = res._diagNote ? '  · ' + res._diagNote : '';
      if (_isPoll) {
        // Poll: log on verdict change / once a minute / slow answer only.
        const verdict = (res._diagNote || '') + ' ' + res.statusCode;
        const stale = Date.now() - (POLL_LOG.at || 0) > 60000;
        if (verdict !== POLL_LOG.last || stale || ms > 1000) {
          POLL_LOG.last = verdict; POLL_LOG.at = Date.now();
          plog(`← GET /vpn/status ${res.statusCode} ${ms}ms${extra}${POLL_LOG.n ? `  (+${POLL_LOG.n} like it)` : ''}`);
          POLL_LOG.n = 0;
        } else POLL_LOG.n++;
        return;
      }
      plog(`← ${req.method} ${_lp} ${res.statusCode} ${ms}ms${extra}`
        + (ms > 5000 ? '  · ' + memLine() : ''));
    };
    res.on('finish', _done);
    res.on('close', () => { if (!_logged) { _logged = true; plog(`✗ ${req.method} ${_lp} client closed after ${Date.now() - _t0}ms`); } });
  }

  // (dev0683) /diag/log — the I screen mirrors its own events here so the client's
  // story and the proxy's share one clock and one file. Diagnostics only: it just
  // appends text. The client ALSO keeps its own copy in localStorage, because if
  // the proxy is the thing that dies, everything it was told dies with it.
  if (req.method === 'POST' && _lp === '/diag/log') {
    readJson(req, 256 * 1024).then(p => {
      const lines = Array.isArray(p.lines) ? p.lines : [String(p.line || '')];
      lines.forEach(l => plog('client: ' + String(l).slice(0, 1200)));
      sendJson(res, 200, { ok: true }, req.headers.origin || '');
    }).catch(err => sendJson(res, 400, { ok: false, error: err.message }, req.headers.origin || ''));
    return;
  }

  // (dev0289) Preflight: route by URL prefix so /exec/* gets the tighter
  // origin-locked headers; the rest keeps the public-wildcard CORS proxy.
  if (req.method === 'OPTIONS') {
    if (req.url.startsWith('/exec/') || req.url.startsWith('/rec/') || req.url.startsWith('/ig/') || req.url.startsWith('/frame/') || req.url.startsWith('/vpn/') || req.url.startsWith('/fix/') || req.url.startsWith('/diag/')) {
      res.writeHead(204, corsForExec(req.headers.origin || ''));
      res.end();
      return;
    }
    res.writeHead(200, CORS);
    res.end();
    return;
  }

  // (dev0319) Version/capability handshake — lets the client detect a stale
  // proxy before a deskew job. Non-sensitive, so the public CORS is fine.
  if (req.method === 'GET' && req.url.split('?')[0] === '/version') {
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, CORS));
    res.end(JSON.stringify({ build: PROXY_BUILD, features: ['crop', 'trim', 'rotate', 'noaudio', 'kenburns', 'metadata', 'exiftool', 'screenrec', 'ytdlp', 'igharvest', 'igstore', 'igsavedelta', 'igffdown', 'igproberes', 'sstore', 'gallerydl', 'xsearch', 'framegrab', 'flickrresolve', 'vpn', 'fix'] }));
    return;
  }

  // (dev0418) ── Screen recorder (origin-locked, like /exec/) ──────────────
  if (req.url.startsWith('/rec/')) {
    const origin = req.headers.origin || '';
    if (!LOCAL_ORIGINS.has(origin)) {
      console.warn(`[rec 403] ${req.method} ${req.url} origin="${origin || '(none)'}" not in allowlist`);
      send(res, 403, 'rec: origin not allowed: ' + (origin || '(none)'));
      return;
    }
    if (req.method !== 'POST') { send(res, 405, 'rec: POST required', corsForExec(origin)); return; }
    const action = req.url.slice('/rec/'.length).split('?')[0];
    if (action === 'start') { recStart(req, res, origin); return; }
    if (action === 'stop')  { recStop(req, res, origin);  return; }
    sendJson(res, 404, { ok: false, error: 'unknown rec action: ' + action }, origin);
    return;
  }

  // (dev0564) ── Step-frame grabber (origin-locked, like /rec/) ─────────────
  if (req.url.startsWith('/frame/')) {
    const origin = req.headers.origin || '';
    if (!LOCAL_ORIGINS.has(origin)) {
      console.warn(`[frame 403] ${req.method} ${req.url} origin="${origin || '(none)'}" not in allowlist`);
      send(res, 403, 'frame: origin not allowed: ' + (origin || '(none)'));
      return;
    }
    if (req.method !== 'POST') { send(res, 405, 'frame: POST required', corsForExec(origin)); return; }
    const action = req.url.slice('/frame/'.length).split('?')[0];
    if (action === 'grab') { frameGrab(req, res, origin); return; }
    sendJson(res, 404, { ok: false, error: 'unknown frame action: ' + action }, origin);
    return;
  }

  // (dev0649) ── Proton VPN rotation bridge ─────────────────────────────────
  // Lets the I screen show the current WireGuard exit (server/city/IP) and
  // trigger a switch between download batches. All the real work is in
  // vpn-rotate.ps1 (+ the ProtonVpnRotate scheduled task); this just reports
  // the state vpn-rotate.ps1 writes and kicks a switch.
  //   GET  /vpn/status → { tunnelUp, server, ip, city, country, at }
  //   POST /vpn/switch → runs the rotation, waits for the new exit, returns it
  if (req.url.startsWith('/vpn/')) {
    const origin = req.headers.origin || '';
    const action = req.url.slice('/vpn/'.length).split('?')[0];
    if (action === 'status') { vpnStatus(res, origin); return; }
    if (action === 'switch' || action === 'stop') {
      if (!LOCAL_ORIGINS.has(origin)) {
        console.warn(`[vpn 403] origin="${origin || '(none)'}" not in allowlist`);
        send(res, 403, 'vpn: origin not allowed: ' + (origin || '(none)'));
        return;
      }
      if (req.method !== 'POST') { send(res, 405, 'vpn: POST required', corsForExec(origin)); return; }
      if (action === 'switch') vpnSwitch(res, origin);
      else                     vpnStop(res, origin);
      return;
    }
    sendJson(res, 404, { ok: false, error: 'unknown vpn action: ' + action }, origin);
    return;
  }

  // (dev0657) ── Recovery / "Fix" tools (origin-locked, like /vpn/) ──────────
  //   GET  /fix/status         → { build, rotateTask, stopTask, tunnelUp }
  //   POST /fix/restart-proxy   → relaunch node proxy.js (loads new code)
  //   POST /fix/harden-vpn      → run vpn-rotate-setup.bat (1 UAC) — durable fix
  //   POST /fix/unstick-vpn     → schtasks /end both VPN tasks (clears a zombie)
  //   POST /fix/kill-downloads  → (dev0658) SIGKILL every in-flight IG downloader
  //                               (the VPN kill-switch — nothing runs on home IP)
  if (req.url.startsWith('/fix/')) {
    const origin = req.headers.origin || '';
    if (!LOCAL_ORIGINS.has(origin)) {
      console.warn(`[fix 403] origin="${origin || '(none)'}" not in allowlist`);
      send(res, 403, 'fix: origin not allowed: ' + (origin || '(none)'));
      return;
    }
    const action = req.url.slice('/fix/'.length).split('?')[0];
    if (req.method === 'GET' && action === 'status') { fixStatus(res, origin); return; }
    if (req.method !== 'POST') { send(res, 405, 'fix: POST required', corsForExec(origin)); return; }
    if (action === 'restart-proxy') { fixRestartProxy(res, origin); return; }
    if (action === 'harden-vpn')    { fixHardenVpn(res, origin);    return; }
    if (action === 'unstick-vpn')   { fixUnstickVpn(res, origin);   return; }
    if (action === 'kill-downloads') { sendJson(res, 200, { ok: true, killed: killActiveDownloads() }, origin); return; }
    sendJson(res, 404, { ok: false, error: 'unknown fix action: ' + action }, origin);
    return;
  }

  // (dev0428) ── IG harvest store (origin-locked like /exec; the Tampermonkey
  // harvester reaches it via GM_xmlhttpRequest, which bypasses browser CORS) ──
  if (req.url.startsWith('/ig/')) {
    const origin = req.headers.origin || '';
    if (req.method !== 'POST') { send(res, 405, 'ig: POST required', corsForExec(origin)); return; }
    const action = req.url.slice('/ig/'.length).split('?')[0];
    if (action === 'add')      { igAdd(req, res, origin);      return; }
    if (action === 'save')     { igSave(req, res, origin);     return; }
    if (action === 'save-delta') { igSaveDelta(req, res, origin); return; }  // (dev0697) per-batch upsert
    if (action === 'ffdown')   { igFfdown(req, res, origin);   return; }
    if (action === 'download') { igDownload(req, res, origin); return; }
    if (action === 'probe-res') { igProbeRes(req, res, origin); return; }  // (dev0698) metadata-only res probe
    if (action === 'meta')     { igMeta(req, res, origin);     return; }   // (dev0671) local ig.json read
    sendJson(res, 404, { ok: false, error: 'unknown ig action: ' + action }, origin);
    return;
  }

  // (dev0447) ── Bulk staging store (origin-locked like /ig) ──────────────────
  // The St screen (s.js) reads s.json directly (GET, via the static file server)
  // and writes it back here.
  if (req.url.startsWith('/s/')) {
    const origin = req.headers.origin || '';
    if (req.method !== 'POST') { send(res, 405, 's: POST required', corsForExec(origin)); return; }
    const action = req.url.slice('/s/'.length).split('?')[0];
    if (action === 'save')     { sSave(req, res, origin);           return; }
    if (action === 'deleted')  { sArchiveDeleted(req, res, origin); return; }
    if (action === 'undelete') { sUnarchive(req, res, origin);      return; }
    sendJson(res, 404, { ok: false, error: 'unknown s action: ' + action }, origin);
    return;
  }

  // (dev0521) ── Search-results store (x.json) ──────────────────────────────
  // The X screen (x.js) reads x.json (GET, static file server) and writes it back
  // here; the desktop finders auto-POST results to /x/import (no browser Origin).
  if (req.url.startsWith('/x/')) {
    const origin = req.headers.origin || '';
    if (req.method !== 'POST') { send(res, 405, 'x: POST required', corsForExec(origin)); return; }
    const action = req.url.slice('/x/'.length).split('?')[0];
    if (action === 'save')     { xSave(req, res, origin);           return; }
    if (action === 'deleted')  { xArchiveDeleted(req, res, origin); return; }
    if (action === 'undelete') { xUnarchive(req, res, origin);      return; }
    if (action === 'import')   { xImport(req, res, origin);         return; }
    if (action === 'search')   {
      // (dev0523) Spawns a finder subprocess → lock to local dev origins like /exec/*.
      if (!LOCAL_ORIGINS.has(origin)) {
        console.warn(`[x/search 403] origin="${origin || '(none)'}" not in allowlist`);
        send(res, 403, 'x/search: origin not allowed: ' + (origin || '(none)'));
        return;
      }
      xSearch(req, res, origin);
      return;
    }
    sendJson(res, 404, { ok: false, error: 'unknown x action: ' + action }, origin);
    return;
  }

  // (dev0289) ── Local exec bridge ─────────────────────────────────────
  if (req.url.startsWith('/exec/')) {
    const origin = req.headers.origin || '';
    if (!LOCAL_ORIGINS.has(origin)) {
      // (dev0290) Log rejections — the browser swallows them as "Failed to
      // fetch" with no detail, which is hard to debug otherwise.
      console.warn(`[exec 403] ${req.method} ${req.url} origin="${origin || '(none)'}" not in allowlist`);
      send(res, 403, 'exec: origin not allowed: ' + (origin || '(none)'));
      return;
    }
    if (req.method !== 'POST') {
      send(res, 405, 'exec: POST required', corsForExec(origin));
      return;
    }
    const bin = req.url.slice('/exec/'.length).split('?')[0];
    const builder = EXEC_ALLOW[bin];
    if (!builder) {
      send(res, 404, 'exec: unknown binary: ' + bin, corsForExec(origin));
      return;
    }
    readJson(req, 64 * 1024).then(payload => {
      let args;
      try { args = builder(payload); }
      catch (e) { send(res, 400, 'exec: ' + e.message, corsForExec(origin)); return; }
      // (dev0391) ffprobe returns JSON on stdout — collect it whole rather than
      // streaming it through the ffmpeg progress parser. (dev0394) exiftool in
      // READ mode (no payload.metadata) also emits JSON, so collect it too;
      // exiftool WRITE mode streams (exit code carries the verdict). (dev0425)
      // ytdlp --print emits one JSON line → collect.
      const realBin = EXEC_BIN[bin] || bin;   // (dev0425) ytdlp → yt-dlp
      // (dev0433) ytdlp now returns a `-J` document → its own collector flattens
      // playlist (carousel) + entries into the compact metadata object.
      if (bin === 'ytdlp') { streamYtdlpMeta(req, res, realBin, args); return; }
      const wantsCollect = bin === 'ffprobe'
                        || (bin === 'exiftool' && !payload.metadata);
      if (wantsCollect) streamExecCollect(req, res, realBin, args);
      else              streamExec(req, res, realBin, args);
    }).catch(err => send(res, 400, 'exec: ' + err.message, corsForExec(origin)));
    return;
  }

  // (dev0599) ── Flickr single-photo resolver (best-res + metadata) ─────────
  // GET only, read-only. Origin-lock isn't required (harmless reads, key stays
  // server-side) but sendJson still echoes the local origin so the browser can
  // read the response. Must sit BEFORE the CORS proxy or "/flickr/…" would be
  // treated as a bad passthrough URL.
  if (req.url.startsWith('/flickr/')) {
    const origin = req.headers.origin || '';
    const action = req.url.slice('/flickr/'.length).split('?')[0];
    if (action !== 'resolve') { sendJson(res, 404, { ok: false, error: 'unknown flickr action: ' + action }, origin); return; }
    flickrResolve(req, res, origin);
    return;
  }

  // (dev0693) ── Pinterest resolver + downloader ──────────────────────────
  // Same placement rule as Flickr: must sit BEFORE the CORS proxy or "/pinterest/…"
  // would be read as a malformed passthrough URL. `resolve` is an open read (public
  // pages, no key); `download` writes to disk, so it is origin-locked like /ig/.
  if (req.url.startsWith('/pinterest/')) {
    const origin = req.headers.origin || '';
    const action = req.url.slice('/pinterest/'.length).split('?')[0];
    if (action === 'resolve') { pinterestResolve(req, res, origin); return; }
    if (action === 'download') {
      if (!LOCAL_ORIGINS.has(origin)) { sendJson(res, 403, { ok: false, error: 'origin not allowed: ' + (origin || '(none)') }, origin); return; }
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST required' }, origin); return; }
      pinterestDownload(req, res, origin);
      return;
    }
    sendJson(res, 404, { ok: false, error: 'unknown pinterest action: ' + action }, origin);
    return;
  }

  // ── CORS proxy (unchanged) ────────────────────────────────────────────
  const target = req.url.slice(1); // strip leading '/'
  if (!/^https?:\/\//i.test(target)) {
    res.writeHead(400, CORS);
    res.end('Bad request — URL must start with http:// or https://');
    return;
  }

  let parsed;
  try { parsed = new URL(target); }
  catch (e) { res.writeHead(400, CORS); res.end('Bad URL: ' + e.message); return; }

  const isHttps = parsed.protocol === 'https:';
  const lib = isHttps ? https : http;
  const referer = `https://${apexDomain(parsed.hostname)}/`;

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: req.method,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': referer,
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  };

  const proxyReq = lib.request(options, (proxyRes) => {
    const headers = Object.assign({}, proxyRes.headers, CORS);
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (err) => {
    console.error('[proxy error]', target, '→', err.message);
    res.writeHead(502, CORS);
    res.end('Proxy error: ' + err.message);
  });

  req.pipe(proxyReq);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Custom proxy on http://127.0.0.1:${PORT} — Ctrl+C to stop`);
  console.log('Spoofs Referer (target apex domain) + Chrome User-Agent');
  console.log(`Local exec bridge: POST /exec/{${Object.keys(EXEC_ALLOW).join(',')}}`);
  console.log(`Screen recorder:   POST /rec/{start,stop}  → vsteps-<ts>.mp4 in ${__dirname}`);
  console.log(`  origin-locked to: ${[...LOCAL_ORIGINS].join(', ')}`);
  console.log(`Harvest store:     POST /ig/{add,save,download}  → ig.json + ig_media/ in ${__dirname}`);
  console.log(`Bulk staging:      POST /s/{save,deleted,undelete} → s.json / sdeleted.json in ${__dirname}`);
  console.log(`Search store:      POST /x/{save,deleted,undelete,import,search} → x.json in ${__dirname}`);
  console.log(`  /x/search spawns ${X_PYTHON} linkfinders/{image,video}finder.py --search … (origin-locked)`);
  console.log(`Flickr resolver:   GET  /flickr/resolve?url=<flickr photo/CDN url> → best-res + author/date/title/caption`);
  console.log(`  build ${PROXY_BUILD} — GET /version → features: crop, trim, rotate, metadata, exiftool, screenrec, ytdlp, igharvest, igstore`);
  // (dev0683) black box: first line of this process's life, plus a 60s pulse. The
  // pulse is what dates a silent death (last heartbeat = last moment it was alive)
  // and what shows memory climbing across a long grind. In-process only — it spawns
  // nothing, opens no window, and touches nothing but proxy.log.
  // (dev0684) Did the LAST run end properly? Every clean shutdown writes an "exit
  // code=" line, so if the previous tail is anything else, the process was killed
  // hard (TerminateProcess / End task) or aborted — no signal handler, no exit
  // handler, no Windows crash report. That is exactly what happened at 15:47:29 on
  // 2026-07-27, mid-/ig/download, 2h07 into a 510-item grind. Say so at the top of
  // the next run so the pattern is impossible to miss.
  // (dev0697) …and NAME the killer instead of only flagging it. Two problems with the
  // dev0684 version: it looked at the last line only, and the launcher appends its own
  // "node exited EXITCODE=n" line AFTER the process's "exit code=n" — so the tail never
  // matched /exit code=/ and every start, clean or not, warned "DID NOT EXIT CLEANLY".
  // A warning that always fires is a warning nobody reads. Now: read the last few
  // lines, prefer the launcher's captured code (it is the only witness to an abort),
  // and translate it. The table is calibrated, not guessed — -1 was measured coming
  // from this repo's own Stop-Process (dev0688), and 0xC0000409 was traced to system
  // commit exhaustion (dev0697, see logCommitHeadroom).
  try {
    const prev = fs.readFileSync(LOG_FILE, 'utf8').trimEnd().split('\n');
    const tail = prev.slice(-4);
    const hit = tail.map(l => l.match(/node exited EXITCODE=(-?\d+)/)).filter(Boolean).pop();
    const clean = tail.some(l => /exit code=/.test(l));
    const code = hit ? Number(hit[1]) : null;
    const WHY = {
      0: 'clean shutdown',
      '-1': 'FORCE-KILLED (TerminateProcess) — a restart script, End task, or an AHK misfire. NOT a crash.',
      '-1073740791': 'ABORTED (0xC0000409) — and NOT a JS-heap OOM: that exits 134 after printing pages'
        + ' of GC detail. A silent 0xC0000409 is Windows __fastfail, i.e. a NATIVE allocation failed and the'
        + ' process was torn down before it could write a word. On this machine that means the SYSTEM ran out'
        + ' of COMMIT — see the "system memory" line below.',
      '-1073741819': 'ACCESS VIOLATION (0xC0000005) — a genuine native crash in node.',
      '-1073741510': 'Ctrl+C or the console window was closed (0xC000013A).',
      '-1073741571': 'STACK OVERFLOW (0xC00000FD) — runaway recursion in native code.'
    };
    if (code !== null && code !== 0) {
      plog(`⚠ PREVIOUS RUN ENDED BADLY — EXITCODE=${code}: ${WHY[String(code)] || 'unrecognised code.'}`);
      if (!clean) plog('⚠   No "exit code=" line either, so it died without unwinding —'
        + ' check proxy.err.log and any report.*.json (--report-on-fatalerror) next to proxy.js.');
    } else if (code === null && !clean) {
      plog('⚠ PREVIOUS RUN LEFT NO EXIT LINE AT ALL — killed hard with nothing recording it.');
      plog('⚠   Last line was: ' + (tail[tail.length - 1] || '').slice(0, 300));
    }
  } catch (_) {}
  let heapCap = '?';
  try { heapCap = Math.round(require('v8').getHeapStatistics().heap_size_limit / 1048576) + 'MB'; } catch (_) {}
  plog(`START build=${PROXY_BUILD} node=${process.version} heapCap=${heapCap} cwd=${__dirname} · ${memLine()}`);
  console.log(`  black box:       ${LOG_FILE} (dev0683 — start/requests/60s heartbeat/exit)`);
  logCommitHeadroom();
  setInterval(logCommitHeadroom, 15 * 60000).unref();   // (dev0697) headroom trend across a night
  setInterval(() => {
    plog(`heartbeat uptime=${Math.round(process.uptime())}s reqs+${LOG_REQS} · ${memLine()}`);
    LOG_REQS = 0;
  }, 60000);
});
