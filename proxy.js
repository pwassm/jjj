// Custom CORS proxy that spoofs Referer + User-Agent per request.
// Bypasses hotlink protection on CDNs like cdn.oceanographicmagazine.com.
//
// (dev0289) Also hosts /exec/* — a tightly-scoped local bridge that runs
// allowlisted binaries (ffmpeg today, ffprobe + exiftool scaffolded) on
// behalf of the SeeAndLearn page. NDJSON streaming response so the UI
// can show live progress. Bound to 127.0.0.1 only; origin-locked to the
// static dev server. No npm install required — Node built-ins only.
//
// Usage:  node proxy.js
// Stop:   Ctrl+C  (or close the CMD window)
// Listens: http://127.0.0.1:8081

const http  = require('http');
const https = require('https');
const { spawn } = require('child_process');

const PORT = 8081;

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

  if (p.crop) {
    // ── CROP path (re-encode) ────────────────────────────────────────────
    must(typeof p.crop === 'object', 'crop must be an object');
    for (const k of ['w','h','x','y']) {
      must(Number.isInteger(p.crop[k]) && p.crop[k] >= 0,
           `crop.${k} must be a non-negative integer`);
    }
    const crf = (Number.isFinite(p.crf) && p.crf >= 0 && p.crf <= 51) ? p.crf : 18;
    const preset = (p.preset === 'slow' || p.preset === 'fast') ? p.preset : 'medium';
    let vf = `crop=${p.crop.w}:${p.crop.h}:${p.crop.x}:${p.crop.y}`;
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
function buildFfprobeArgs(_p) {
  throw new Error('ffprobe builder not yet implemented (scaffold)');
}
function buildExiftoolArgs(_p) {
  throw new Error('exiftool builder not yet implemented (scaffold)');
}

const EXEC_ALLOW = {
  ffmpeg:   buildFfmpegArgs,
  ffprobe:  buildFfprobeArgs,
  exiftool: buildExiftoolArgs
};

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

function send(res, code, msg, extraHeaders) {
  const h = Object.assign({ 'Content-Type': 'text/plain' }, extraHeaders || {});
  res.writeHead(code, h);
  res.end(msg);
}

http.createServer((req, res) => {
  // (dev0289) Preflight: route by URL prefix so /exec/* gets the tighter
  // origin-locked headers; the rest keeps the public-wildcard CORS proxy.
  if (req.method === 'OPTIONS') {
    if (req.url.startsWith('/exec/')) {
      res.writeHead(204, corsForExec(req.headers.origin || ''));
      res.end();
      return;
    }
    res.writeHead(200, CORS);
    res.end();
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
      streamExec(req, res, bin, args);
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
  console.log(`  origin-locked to: ${[...LOCAL_ORIGINS].join(', ')}`);
});
