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
const PROXY_BUILD = 'dev0430';

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
const YTDLP_META_FIELDS =
  'id,title,description,uploader,uploader_id,channel,channel_url,uploader_url,' +
  'webpage_url,timestamp,upload_date,like_count,view_count,duration,width,height';
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
    '--print', '%(.{' + YTDLP_META_FIELDS + '})j',
    p.url
  ];
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

// (dev0429) /ig/download — yt-dlp downloads a reel/post's media into <project>/
// ig_media/<id>.<ext>. Pulls Firefox cookies (the user's logged-in session — the
// same one the harvester reads) so IG doesn't login-wall the media; falls back to
// a cookieless attempt if the cookie DB is locked/unavailable. Returns the basenames
// of every file produced (a carousel /p post yields several). All argv tokens are
// literal under spawn(shell:false); the only caller value is the validated URL.
const IG_MEDIA_DIR = path.join(__dirname, 'ig_media');
// Mirror of the AHK SanitizeFilePart (ytdl_v26.ahk:843): strip the chars Windows
// forbids in a filename, collapse whitespace, trim leading/trailing dots. Keeps
// the convention's structural chars ~ [ ] @ (all legal on Windows).
function igSanitizeName(s) {
  s = String(s || '').replace(/[<>":\/\\|?*\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '');
  return s || 'unknown';
}
function igDownload(req, res, origin) {
  readJson(req, 64 * 1024).then(payload => {
    const url = String(payload.url || '');
    const id = String(payload.id || '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!/^https?:\/\//i.test(url) || url.length > 2048) { sendJson(res, 400, { ok: false, error: 'valid http(s) url required' }, origin); return; }
    if (!id) { sendJson(res, 400, { ok: false, error: 'id required' }, origin); return; }
    try { fs.mkdirSync(IG_MEDIA_DIR, { recursive: true }); } catch (_) {}
    // Filename stem: the client passes the AHK-convention `name` (already built from
    // the enriched row); fall back to the bare id. Sanitized + length-capped here as
    // the safety boundary — the client value never reaches the shell (spawn literal).
    const stem = igSanitizeName(payload.name || id).slice(0, 180);
    const outTmpl = path.join(IG_MEDIA_DIR, stem + '.%(ext)s');
    const baseArgs = ['--no-warnings', '--ignore-config', '--socket-timeout', '20', '-o', outTmpl];

    function listFiles() {
      try { return fs.readdirSync(IG_MEDIA_DIR).filter(f => f === stem || f.startsWith(stem + '.') || f.startsWith(stem + '_')); }
      catch (_) { return []; }
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
    // Try with Firefox cookies first; if that fails (locked DB / not logged in),
    // retry cookieless before giving up.
    run(true, (ok1, err1) => {
      if (ok1) { sendJson(res, 200, { ok: true, files: listFiles() }, origin); return; }
      run(false, (ok2, err2) => {
        if (ok2) { sendJson(res, 200, { ok: true, files: listFiles(), note: 'downloaded without cookies' }, origin); return; }
        console.warn('[ig/download] ' + id + ' failed: ' + (err1 || err2));
        sendJson(res, 502, { ok: false, error: (err2 || err1 || 'yt-dlp failed').split('\n').slice(-3).join(' ') }, origin);
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
    res.end(JSON.stringify({ build: PROXY_BUILD, features: ['crop', 'trim', 'rotate', 'metadata', 'exiftool', 'screenrec', 'ytdlp', 'igharvest', 'igstore'] }));
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
    if (action === 'download') { igDownload(req, res, origin); return; }
    sendJson(res, 404, { ok: false, error: 'unknown ig action: ' + action }, origin);
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
      const wantsCollect = bin === 'ffprobe' || bin === 'ytdlp'
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
  console.log(`  build ${PROXY_BUILD} — GET /version → features: crop, trim, rotate, metadata, exiftool, screenrec, ytdlp, igharvest, igstore`);
});
