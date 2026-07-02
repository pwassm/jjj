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
const { spawn } = require('child_process');

const PORT = 8081;
// (dev0319) Build/capability tag — surfaced at GET /version so the client can
// detect a stale proxy before sending a deskew (rotate) job that an old build
// would silently mis-crop (rotate ignored → canvas crop coords on raw frame).
// (dev0418) Bumped + added 'screenrec' feature for the /rec/* screen recorder.
// (dev0425) Bumped + added 'ytdlp' feature: /exec/ytdlp pulls caption/author
// metadata via yt-dlp (r.jina.ai now login-walls Instagram et al.).
// (dev0428) Bumped + added 'igharvest' feature: /ig/add stages harvested IG reel
// URLs (from the Tampermonkey harvester) into ig.json, deduped by shortcode id.
// (dev0429) Bumped + added 'igstore' feature for the I/Ig screen (ig.js):
//   /ig/save     overwrites ig.json with the client's edited array (enrich/promote
//                state) — keeps a one-deep ig.json.bak first.
//   /ig/download yt-dlp downloads a reel/post's media into <project>/ig_media/.
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
const PROXY_BUILD = 'dev0524';

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
// it cookielessly, so it always uses Firefox cookies (the user opted in for best /p
// downloads). Set IG_GALLERYDL=false to disable. Standalone exe, no Python needed —
// download with: Invoke-WebRequest <release>/gallery-dl.exe -OutFile the path below.
const IG_GALLERYDL = true;
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
//   resHeight 1080|720|'source' — when numeric, append ',scale=-2:H' (L) or
//                                 ',scale=H:-2' (P) to the filter chain.
//                                 'source' or undefined → no scale.
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
    if (Number.isFinite(resH) && resH > 0) {
      const aspect = (p.aspect === 'P') ? 'P' : 'L';
      vf += (aspect === 'P') ? `,scale=${resH}:-2` : `,scale=-2:${resH}`;
    }
    return [
      ...common,
      ...pre,
      '-i', p.input,
      '-filter:v', vf,
      '-c:v', 'libx264', '-crf', String(crf), '-preset', preset,
      '-c:a', 'copy',
      // (dev0297) Same flag the lossless path already uses. Video is re-encoded
      // from PTS 0, but audio is stream-copied — its first packets can carry a
      // small leading offset that downstream editors (e.g. LosslessCut) render
      // as a blank video frame at the start. `make_zero` rebases the muxer's
      // timestamps so both streams begin at 0.
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
function pickIgFullCover(html, ogImage) {
  if (!ogImage) return '';
  const og = ogImage.replace(/&amp;/g, '&');
  // (dev0513) Match the media's numeric STEM (no extension) so we can collect every
  // rendition the page lists for it — JPEG and WebP alike — and prefer a real .jpg.
  const stemM = ogImage.match(/\/(\d+_\d+_\d+_n)\.(?:webp|jpe?g|heic)/i);
  if (!stemM) return og;
  const stem = stemM[1];
  const re = new RegExp('https?:[^"\'\\\\\\s]*?' + stem + '\\.(?:webp|jpe?g|heic)[^"\'\\\\\\s]*', 'gi');
  const vars = [...new Set([...html.matchAll(re)].map(m =>
    m[0].replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&')))];
  if (!vars.length) return og;
  const full = u => !/[?&]stp=/.test(u) && !/s\d+x\d+/.test(u);   // no size crop = full res
  const jpg  = u => /\.jpe?g(?:[?&]|$)/i.test(u);
  // (dev0513) Prefer a full-res JPEG (saves a real .jpg, no transcode); then any full-
  // res rendition; then any JPEG; finally og:image. A webp-only post still resolves here
  // (the cover-only download then transcodes it to jpg at top quality).
  return vars.find(u => full(u) && jpg(u))
      || vars.find(full)
      || vars.find(jpg)
      || og;
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
  return {
    id, title: owner ? 'Post by ' + owner : 'Instagram post',
    description: caption || '',
    uploader: owner || undefined, uploader_id: owner || undefined,
    uploader_url: owner ? 'https://www.instagram.com/' + owner + '/' : undefined,
    webpage_url: 'https://www.instagram.com/p/' + id + '/',
    upload_date, thumbnail: cover || undefined,
    duration: duration || undefined, width: width || undefined, height: height || undefined, _viaMain: true
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
    const opts = { agent: false, headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9', 'Referer': permalink, 'Connection': 'close'
    } };
    let h = '';
    const req = https.get(permalink, opts, r => {
      if (r.statusCode !== 200) { r.resume(); resolve(null); return; }
      r.setEncoding('utf8');
      r.on('data', c => { h += c; if (h.length > 6e6) req.destroy(); });
      r.on('end', () => {
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
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
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

// (dev0491) GET an image URL → write to destPath. Cookieless, fresh socket + short UA
// + IG Referer (same recipe that beats the wall on the embed page); follows up to a
// couple of redirect hops. Resolves true only on a 200 with a non-empty body.
function igDownloadImage(fileUrl, destPath, referer, hops, accept) {
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
        igDownloadImage(new URL(r.headers.location, fileUrl).href, destPath, referer, hops + 1, accept).then(resolve);
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
        if (ok) { resolve([dest]); return; }
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
        if (i >= imgs.length) { resolve(written); return; }
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
    // Video item → its MP4 (prefer over the poster the item ALSO carries in
    // image_versions2). Photo item → the widest candidate (candidates are listed
    // largest-first, but pick by width when present to be safe).
    if (Array.isArray(it.video_versions) && it.video_versions.length && it.video_versions[0] && it.video_versions[0].url) {
      out.push({ kind: 'video', url: it.video_versions[0].url });
    } else if (it.image_versions2 && Array.isArray(it.image_versions2.candidates) && it.image_versions2.candidates.length) {
      const c = it.image_versions2.candidates;
      let b = c[0]; for (const x of c) if ((+x.width || 0) > (+b.width || 0)) b = x;
      if (b && b.url) out.push({ kind: 'image', url: b.url });
    }
  }
  return out;
}
// (dev0520) Cookieless FULL-carousel download for a multi-item /p post (photos, videos,
// or mixed) — the generalisation of dev0519's single-video igMainVideoFallback. Fetches
// the logged-out /p/ page, walks carousel_media, and writes EVERY item into tmpDir with
// the NNN.<ext> autonumber scheme igDownload()'s publish() expects. Resolves the files
// written; resolves [] for a non-carousel post (single photo/reel → <2 items) so the
// caller falls through to its single-item cover/video rescue. No Firefox cookies.
function igMainCarouselFallback(url, id, tmpDir) {
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
      r.on('data', c => { h += c; if (h.length > 8e6) req.destroy(); });
      r.on('end', () => {
        const items = pickIgCarouselMedia(h);
        if (items.length < 2) { resolve([]); return; }   // not a carousel → single-item path handles it
        const written = [];
        let i = 0;
        const next = () => {
          if (i >= items.length) { resolve(written); return; }
          const idx = i++, it = items[idx];
          const ext = it.kind === 'video' ? '.mp4' : '.jpg';
          const dest = path.join(tmpDir, String(idx + 1).padStart(3, '0') + ext);
          igDownloadImage(it.url, dest, permalink, 0, it.kind === 'video' ? '*/*' : undefined).then(ok => {
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
    let done = false;
    const finish = () => {
      if (done) return; done = true;
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
function igAdd(req, res, origin) {
  readJson(req, 4 * 1024 * 1024).then(payload => {
    const urls = Array.isArray(payload.urls) ? payload.urls : [];
    const author = (payload.author || '').toString().slice(0, 80);
    const source = (payload.source || '').toString().slice(0, 300);
    let store = [];
    try { if (fs.existsSync(IG_STORE)) store = JSON.parse(fs.readFileSync(IG_STORE, 'utf8')) || []; } catch (_) {}
    if (!Array.isArray(store)) store = [];
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
    if (added) fs.writeFileSync(IG_STORE, JSON.stringify(store, null, 2));
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

// (dev0429) /ig/save — overwrite ig.json with the I-screen's edited array (enrich/
// promote/download state). Each row must still carry a shortcode `id`. A one-deep
// ig.json.bak is written first so a bad client payload can't silently nuke the
// store. Guard: refuse a write that drops > 50% of rows (likely a client bug) so a
// mis-send can't wipe a 700-row harvest — the caller gets a clear 409 to surface.
function igSave(req, res, origin) {
  readJson(req, 16 * 1024 * 1024).then(payload => {
    const incoming = Array.isArray(payload.rows) ? payload.rows : null;
    if (!incoming) { sendJson(res, 400, { ok: false, error: 'rows[] required' }, origin); return; }
    const clean = incoming.filter(r => r && typeof r.id === 'string' && r.id);
    let prev = [];
    try { if (fs.existsSync(IG_STORE)) prev = JSON.parse(fs.readFileSync(IG_STORE, 'utf8')) || []; } catch (_) {}
    if (Array.isArray(prev) && prev.length > 10 && clean.length < prev.length * 0.5) {
      console.warn('[ig/save] REFUSED — ' + clean.length + ' rows would replace ' + prev.length + ' (>50% drop)');
      sendJson(res, 409, { ok: false, error: 'refused: ' + clean.length + ' rows would replace ' + prev.length + ' (>50% drop)' }, origin);
      return;
    }
    try { if (fs.existsSync(IG_STORE)) fs.copyFileSync(IG_STORE, IG_STORE + '.bak'); } catch (_) {}
    fs.writeFileSync(IG_STORE, JSON.stringify(clean, null, 2));
    console.log('[ig/save] wrote ' + clean.length + ' rows (was ' + (Array.isArray(prev) ? prev.length : 0) + ')');
    sendJson(res, 200, { ok: true, total: clean.length }, origin);
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
    if (prev.length > 10 && clean.length < prev.length * 0.5) {
      console.warn('[x/save] REFUSED — ' + clean.length + ' rows would replace ' + prev.length + ' (>50% drop)');
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
    const have = new Set(store.map(r => xNormLink(r && r.link)));
    const del = new Set(xReadDel().map(r => xNormLink(r && r.link)));
    const defQuery = String(payload.query || '').trim();
    const defSource = String(payload.source || '').trim();
    const defKind = String(payload.kind || '').trim();
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    let added = 0, dup = 0, dropped = 0;
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      const link = String(it.link || it.url || it.image_url || it.video_url || '').trim();
      const key = xNormLink(link);
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
           sources: ['bing', 'google', 'ddgs', 'flickr', 'wikimedia', 'openverse', 'photomacro', 'ojson', 'featured'] },
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
    // Rename tmp files → ig_media/<stem>[ [i of N]].<ext>; return the basenames.
    function publish() {
      const files = tmpFiles(), n = files.length, out = [];
      files.forEach((f, i) => {
        const ext = path.extname(f);
        const base = stem + (n > 1 ? ' [' + (i + 1) + ' of ' + n + ']' : '') + ext;
        const dest = path.join(IG_MEDIA_DIR, base);
        try { fs.renameSync(path.join(tmpDir, f), dest); out.push(base); }
        catch (_) { try { fs.copyFileSync(path.join(tmpDir, f), dest); out.push(base); } catch (_) {} }
      });
      rmTmp();
      return out;
    }
    function run(withCookies, onDone) {
      const args = baseArgs.concat(withCookies ? ['--cookies-from-browser', 'firefox', url] : [url]);
      let proc, stderr = '';
      try { proc = spawn('yt-dlp', args, { windowsHide: true }); }
      catch (e) { onDone(false, 'spawn failed: ' + e.message); return; }
      proc.stderr.on('data', d => { stderr += d.toString('utf8'); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
      proc.on('error', e => onDone(false, e.message));
      proc.on('close', code => onDone(code === 0, stderr.trim()));
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
    function fail502(err) {
      rmTmp();
      console.warn('[ig/download] ' + id + ' failed: ' + (err || 'yt-dlp failed'));
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
          sendJson(res, 200, { ok: true, files: publish(), viaMainVideo: true, usedCookies: false,
            note: 'reel via cookieless main /p/ page (video_versions) — yt-dlp was login-walled' }, origin);
        } else { fail502(err); }
      });
    }
    function embedRescueOr502(err) {
      if (!photoPost) { mainVideoRescueOr502(err); return; }
      wipeTmp();
      igEmbedImageFallback(url, id, tmpDir).then(emImgs => {
        if (emImgs.length && tmpFiles().length) {
          console.log('[ig/download] ' + id + ' last-resort cookieless embed image (gallery-dl got nothing too)');
          sendJson(res, 200, { ok: true, files: publish(), viaEmbed: true, usedCookies: false,
            note: 'via embed — first image only (gallery-dl got nothing; re-run later for the full carousel)' }, origin);
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
          sendJson(res, 200, { ok: true, files: publish(), viaGalleryDl: true, usedCookies: true,
            note: 'full image carousel via gallery-dl (Firefox cookies — image posts are login-walled cookieless)' }, origin);
        } else { embedRescueOr502(err); }
      });
    }
    // (dev0520) COOKIELESS full-carousel walker — the validated fix for full /p photo
    // (and mixed) carousels. The logged-out /p/ page already carries every item in its
    // inline carousel_media JSON at full res (photos 1440px = gallery-dl parity), so this
    // gets the WHOLE carousel with NO Firefox cookies — dropping the gallery-dl+cookie
    // dependency for the common case (and the COOKIE_CAP=1 batch stop it caused). Tried
    // before gallery-dl; gallery-dl stays as an opt-in fallback only if this yields
    // nothing. Non-carousel posts (<2 items) resolve [] → fall through to gallery-dl/embed
    // (single photo → index-1 cover) or the reel video_versions rescue (non-photo).
    function mainCarouselOrGalleryDl(err) {
      if (!photoPost) { galleryDlOrEmbed(err); return; }
      wipeTmp();
      igMainCarouselFallback(url, id, tmpDir).then(files => {
        if (files.length && tmpFiles().length) {
          console.log('[ig/download] ' + id + ' got ' + tmpFiles().length + ' item(s) via cookieless main /p/ carousel_media');
          sendJson(res, 200, { ok: true, files: publish(), viaMainCarousel: true, usedCookies: false,
            note: 'full carousel via cookieless main /p/ page (carousel_media) — no Firefox cookies' }, origin);
        } else { galleryDlOrEmbed(err); }
      });
    }
    // (dev0512) COVER-ONLY mode (client toggle): skip the whole yt-dlp/gallery-dl chain
    // and grab JUST the cookieless index-1 cover off the main /p/ page. For authors whose
    // page-1 is the keeper and page-2 is camera/EXIF junk — pure cookieless, no carousel.
    if (coverOnly) {
      igEmbedImageFallback(url, id, tmpDir).then(imgs => {
        if (imgs.length && tmpFiles().length) {
          coverWebpToJpg(tmpDir).then(() => {     // (dev0513) webp cover → real .jpg
            console.log('[ig/download] ' + id + ' cover-only (cookieless index-1)');
            sendJson(res, 200, { ok: true, files: publish(), viaEmbed: true, usedCookies: false, coverOnly: true,
              note: 'cover only — index-1 image, cookieless (main /p/ page)' }, origin);
          });
        } else { fail502('cover-only: no cookieless image found (is this a photo /p post?)'); }
      });
      return;
    }
    run(false, (ok1, err1) => {
      if (ok1 || tmpFiles().length) { sendJson(res, 200, { ok: true, files: publish() }, origin); return; }
      // (dev0494) Download-only cookie net (separate from enrich's IG_USE_COOKIES):
      // cookieless yt-dlp came back empty → try Firefox cookies if the user opted in.
      if (!IG_DOWNLOAD_USE_COOKIES) { mainCarouselOrGalleryDl(err1); return; }
      wipeTmp();   // clear any partial cookieless output before the cookie retry
      run(true, (ok2, err2) => {
        if (ok2 || tmpFiles().length) { sendJson(res, 200, { ok: true, files: publish(), usedCookies: true, note: 'needed Firefox cookies' }, origin); return; }
        mainCarouselOrGalleryDl(err2 || err1);
      });
    });
  }).catch(err => sendJson(res, 400, { ok: false, error: err.message }, origin));
}

http.createServer((req, res) => {
  // (dev0289) Preflight: route by URL prefix so /exec/* gets the tighter
  // origin-locked headers; the rest keeps the public-wildcard CORS proxy.
  if (req.method === 'OPTIONS') {
    if (req.url.startsWith('/exec/') || req.url.startsWith('/rec/') || req.url.startsWith('/ig/')) {
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
    res.end(JSON.stringify({ build: PROXY_BUILD, features: ['crop', 'trim', 'rotate', 'metadata', 'exiftool', 'screenrec', 'ytdlp', 'igharvest', 'igstore', 'igffdown', 'sstore', 'gallerydl', 'xsearch'] }));
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

  // (dev0428) ── IG harvest store (origin-locked like /exec; the Tampermonkey
  // harvester reaches it via GM_xmlhttpRequest, which bypasses browser CORS) ──
  if (req.url.startsWith('/ig/')) {
    const origin = req.headers.origin || '';
    if (req.method !== 'POST') { send(res, 405, 'ig: POST required', corsForExec(origin)); return; }
    const action = req.url.slice('/ig/'.length).split('?')[0];
    if (action === 'add')      { igAdd(req, res, origin);      return; }
    if (action === 'save')     { igSave(req, res, origin);     return; }
    if (action === 'ffdown')   { igFfdown(req, res, origin);   return; }
    if (action === 'download') { igDownload(req, res, origin); return; }
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
  console.log(`  build ${PROXY_BUILD} — GET /version → features: crop, trim, rotate, metadata, exiftool, screenrec, ytdlp, igharvest, igstore`);
});
