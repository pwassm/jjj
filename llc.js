// ══════════════════════════════════════════════════════════════════════════
// llc.js — LLC, the lossless cutter.  (dev0926)
//
//   http://localhost:8080/?llc=<url-encoded absolute path>
//
// A home-brew LosslessCut. Its whole job is: watch a disk video, mark A and F,
// and write the A→F stretch out as a NEW mp4 without re-encoding a single
// frame. No crop, no zoom, no colour, no captions — the V crop tool already
// does all of that and does it by re-encoding. This one never does.
//
// Why a separate file rather than a mode inside vp.js: everything vp.js knows
// how to do is about changing pixels. Here there are no pixels to change, so
// none of that machinery has anything to say — carrying it along would only be
// a list of buttons that must be kept switched off. What DID carry over is the
// part that is genuinely the same job: the black full-window screen, the
// timeline bar under it, and a s d f under the left hand. t does the trim.
//
// The cut itself needs NO new proxy code: buildFfmpegArgs already takes the
// lossless stream-copy path when a payload has `trim` and no `crop`. The one
// new route is /llc/nlc, which reads and appends the .nlc cut log.
//
// Dev-only by construction — it needs `node proxy.js`, and it refuses to run
// anywhere but localhost so a shared link can never carry someone's disk
// layout. Same contract as ?vect= (see vp.js, dev0746).
// ══════════════════════════════════════════════════════════════════════════
(function () {
'use strict';

// vp.js declares a top-level `const PROXY_BASE`, and a classic script's
// top-level const lands in the SHARED global lexical scope — a second one here
// would be a redeclaration SyntaxError that takes this whole file out. Hence
// the IIFE, and hence the different name.
var LLC_PROXY = 'http://127.0.0.1:8081';
var LLC_VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;

// The label the user types is remembered PER SOURCE, so a second cut of the
// same file is not a second prompt. A different file opens the prompt again.
// (Same shape as vp.js's slam-vp-lastcropname.)
var LLC_LABEL_KEY = 'slam-llc-label';

var S = null;   // the open cutter's state; null when closed

function toastMsg(t, ms) {
  if (typeof toast === 'function') toast(t, ms || 2200);
  else console.log('[llc]', t);
}

function isLocalHost() {
  var h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

function fileUrl(abs) { return LLC_PROXY + '/localfile?p=' + encodeURIComponent(abs); }

function baseName(abs) { return String(abs).split(/[\\/]/).pop() || String(abs); }
function dirName(abs) {
  var s = String(abs);
  var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i < 0 ? '' : s.slice(0, i);
}
function stemOf(name) { return String(name).replace(/\.[^.\\/]+$/, ''); }

// mm:ss.t — short enough for a button, precise enough to trust a mark by.
function fmtTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  var m = Math.floor(t / 60), s = t - m * 60;
  var h = Math.floor(m / 60); m -= h * 60;
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var tail = pad(m) + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  return h > 0 ? (h + ':' + tail) : tail;
}

// ── The name a cut is saved under ─────────────────────────────────────────
//   <original stem>_ncrop_<label>_<start>_<duration>.mp4
// Both numbers are WHOLE SECONDS of the source, which is what makes two cuts
// of the same clip under the same label different files rather than a
// collision — the label identifies the subject, the numbers identify the cut.
function sanitizeLabel(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]/g, '')   // illegal in a Windows filename
    .replace(/[\s_]+/g, '-')        // underscores are the template's separator
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function cutFileName(stem, label, startSec, durSec) {
  return stem + '_ncrop_' + label + '_' +
         Math.round(startSec) + '_' + Math.max(1, Math.round(durSec)) + '.mp4';
}

// ══════════════════════════════════════════════════════════════════════════
// The screen
// ══════════════════════════════════════════════════════════════════════════
var LLC_CSS =
  '#llc-overlay{position:fixed;inset:0;z-index:41500;background:#000;' +
    'font:13px ui-monospace,Consolas,monospace;color:#cde;overflow:hidden;touch-action:none;}' +
  '#llc-stage{position:absolute;left:0;right:0;top:0;bottom:96px;background:#000;}' +
  '#llc-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;}' +
  '#llc-title{position:absolute;left:10px;top:8px;right:10px;color:#8ea;font-size:12px;' +
    'text-shadow:0 1px 4px #000;pointer-events:none;white-space:nowrap;overflow:hidden;' +
    'text-overflow:ellipsis;}' +
  '#llc-toolbar{position:absolute;left:0;right:0;bottom:0;min-height:96px;background:#000;' +
    'border-top:2px solid #06f;display:flex;flex-direction:column;padding:4px 12px;' +
    'box-sizing:border-box;gap:4px;}' +
  '#llc-tlrow{display:flex;align-items:center;gap:8px;height:26px;}' +
  '#llc-timeline{flex:1;height:18px;background:#113;border:1px solid #06f;border-radius:3px;' +
    'position:relative;cursor:pointer;touch-action:none;}' +
  '#llc-bands{position:absolute;inset:0;pointer-events:none;z-index:1;overflow:hidden;border-radius:2px;}' +
  '#llc-sel{position:absolute;top:0;bottom:0;background:rgba(0,200,90,0.32);' +
    'border-left:2px solid #0f0;border-right:2px solid #0f0;pointer-events:none;z-index:2;display:none;}' +
  '#llc-head{position:absolute;top:-2px;bottom:-2px;width:3px;background:#ff0;border-radius:2px;' +
    'pointer-events:none;z-index:4;}' +
  '#llc-clock{min-width:150px;text-align:right;color:#9cf;font-size:12px;}' +
  '#llc-ctrlrow{display:flex;align-items:center;flex-wrap:wrap;gap:6px;row-gap:4px;min-height:32px;}' +
  '.llc-btn{background:#123;color:#cde;border:1px solid #06f;border-radius:4px;padding:4px 10px;' +
    'font:12px ui-monospace,Consolas,monospace;cursor:pointer;min-height:28px;}' +
  '.llc-btn:hover{background:#1a3a5a;}' +
  '.llc-btn:disabled{opacity:0.45;cursor:default;}' +
  '#llc-save{background:#062;border-color:#0c6;color:#dfd;font-weight:bold;}' +
  '#llc-save:hover{background:#084;}' +
  '#llc-label{background:#210;border:1px solid #f80;color:#fc9;border-radius:4px;padding:4px 10px;' +
    'min-height:28px;cursor:pointer;max-width:280px;overflow:hidden;text-overflow:ellipsis;' +
    'white-space:nowrap;font:12px ui-monospace,Consolas,monospace;}' +
  '#llc-status{flex:1;color:#8a9;font-size:11px;white-space:nowrap;overflow:hidden;' +
    'text-overflow:ellipsis;min-width:80px;}' +
  '#llc-help{position:absolute;right:12px;bottom:104px;width:430px;max-width:calc(100% - 24px);' +
    'background:#001428;border:1px solid #06f;border-radius:6px;padding:10px 12px;z-index:5;' +
    'box-shadow:0 6px 24px rgba(0,0,0,0.7);display:none;}' +
  '#llc-help h4{margin:0 0 6px;color:#9cf;font-size:13px;}' +
  '#llc-help table{width:100%;border-collapse:collapse;font-size:12px;}' +
  '#llc-help td{padding:2px 4px;vertical-align:top;}' +
  '#llc-help td:first-child{color:#fc9;white-space:nowrap;width:78px;}' +
  '#llc-help .llc-note{margin-top:8px;color:#8a9;font-size:11px;line-height:1.45;}';

function injectCss() {
  if (document.getElementById('llc-css')) return;
  var st = document.createElement('style');
  st.id = 'llc-css';
  st.textContent = LLC_CSS;
  document.head.appendChild(st);
}

function el(tag, id, cls, html) {
  var e = document.createElement(tag);
  if (id) e.id = id;
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function buildScreen(absPath) {
  injectCss();
  var ov = el('div', 'llc-overlay');

  var stage = el('div', 'llc-stage');
  var vid = document.createElement('video');
  vid.id = 'llc-video';
  vid.playsInline = true;
  vid.preload = 'auto';
  // No `controls`: the native bar would sit on top of our timeline and its own
  // keyboard handling would fight ours for Space.
  stage.appendChild(vid);
  var title = el('div', 'llc-title');
  title.textContent = absPath;
  stage.appendChild(title);
  ov.appendChild(stage);

  var bar = el('div', 'llc-toolbar');

  var tlrow = el('div', 'llc-tlrow');
  var tl = el('div', 'llc-timeline');
  tl.appendChild(el('div', 'llc-bands'));
  tl.appendChild(el('div', 'llc-sel'));
  tl.appendChild(el('div', 'llc-head'));
  tlrow.appendChild(tl);
  var clock = el('div', 'llc-clock', null, '0:00.0');
  tlrow.appendChild(clock);
  bar.appendChild(tlrow);

  var row = el('div', 'llc-ctrlrow');
  var mk = function (id, txt, tip) {
    var b = el('button', id, 'llc-btn', txt);
    if (tip) b.title = tip;
    return b;
  };
  row.appendChild(mk('llc-back',  '◀',  'Frame back (s or ←)'));
  row.appendChild(mk('llc-play',  '▶',  'Play / pause (Space)'));
  row.appendChild(mk('llc-fwd',   '▶|', 'Frame forward (d or →)'));
  row.appendChild(mk('llc-a',     'A',  'Mark the start here (a)'));
  row.appendChild(mk('llc-b',     'F',  'Mark the end here (f)'));
  row.appendChild(mk('llc-clear', '⌫',  'Drop both marks (z)'));
  row.appendChild(mk('llc-zoom',  '↔',  'eXpand the bar onto the cut (x)'));
  var lab = el('div', 'llc-label', null, '');
  lab.title = 'What this clip is about — it goes in the filename (c to change)';
  row.appendChild(lab);
  row.appendChild(mk('llc-save', '✂ Save cut', 'Trim — write the A→F stretch out losslessly (t)'));
  row.appendChild(el('div', 'llc-status'));
  row.appendChild(mk('llc-qm', '?', 'Keys'));
  row.appendChild(mk('llc-close', '✕', 'Close (Esc)'));
  bar.appendChild(row);

  ov.appendChild(bar);
  ov.appendChild(buildHelp());
  document.body.appendChild(ov);
  return ov;
}

function buildHelp() {
  var h = el('div', 'llc-help');
  var r = function (k, t) { return '<tr><td>' + k + '</td><td>' + t + '</td></tr>'; };
  h.innerHTML =
    '<h4>LLC — lossless cut</h4><table>' +
    r('Space',   'play / pause') +
    r('a',       'mark the START of the cut, here') +
    r('f',       'mark the END of the cut, here') +
    r('s / d',   'one frame back / forward (← / → do the same)') +
    r('S / D',   'one second back / forward') +
    r('<b>t</b>', '<b>Trim</b> — write the cut out  (w and g do the same)') +
    r('q',       'pull A back onto its keyframe, so the cut starts exactly there') +
    r('z',       'drop both marks') +
    r('x',       'eXpand — blow the bar up onto the cut') +
    r('c',       'change the word that goes in the filename') +
    r('Esc',     'close') +
    '</table>' +
    '<div class="llc-note">Saved as <b>&lt;original&gt;_ncrop_&lt;word&gt;_&lt;start&gt;_&lt;length&gt;.mp4</b> ' +
    'beside the original, keeping its dates, its camera tags and every audio track. ' +
    'Two cuts of one video share the word — the seconds tell them apart, so the word ' +
    'is only asked for once per file.<br>' +
    'A copy cannot start mid-GOP, so the cut falls back to the keyframe before A: ' +
    'the <span style="color:#0cf">cyan line and hatching</span> are the footage that ' +
    'comes with it, and <b>q</b> moves A there so what you see is what you get. ' +
    'The end is exact either way.</div>';
  return h;
}

// ══════════════════════════════════════════════════════════════════════════
// Painting
// ══════════════════════════════════════════════════════════════════════════

// The window the bar spans. Normally the whole video; after `x` with both
// marks set, just the cut (with a tenth of its length as breathing room each
// side) so a nudge of a tenth of a second is a visible distance.
function win() {
  if (!S) return { t0: 0, t1: 1 };
  if (S.expand && S.a != null && S.b != null && S.dur > 0) {
    var pad = Math.max(0.25, (S.b - S.a) * 0.1);
    var t0 = Math.max(0, S.a - pad), t1 = Math.min(S.dur, S.b + pad);
    if (t1 - t0 > 0.05) return { t0: t0, t1: t1 };
  }
  return { t0: 0, t1: Math.max(0.05, S.dur || 0.05) };
}

function pctOf(t) {
  var w = win();
  return ((t - w.t0) / (w.t1 - w.t0)) * 100;
}
function timeAt(frac) {
  var w = win();
  return w.t0 + frac * (w.t1 - w.t0);
}

function paint() {
  if (!S) return;
  var head = document.getElementById('llc-head');
  var sel  = document.getElementById('llc-sel');
  var clock = document.getElementById('llc-clock');
  var t = S.vid ? (S.vid.currentTime || 0) : 0;
  if (head) head.style.left = Math.max(0, Math.min(100, pctOf(t))) + '%';
  if (clock) {
    clock.textContent = fmtTime(t) + ' / ' + fmtTime(S.dur) +
      (S.expand ? '  ↔' : '');
  }
  if (sel) {
    if (S.a != null && S.b != null && S.b > S.a) {
      var l = pctOf(S.a), r = pctOf(S.b);
      sel.style.display = '';
      sel.style.left = Math.max(0, Math.min(100, l)) + '%';
      sel.style.width = Math.max(0, Math.min(100, r) - Math.max(0, l)) + '%';
    } else {
      sel.style.display = 'none';
    }
  }
  paintMarks();
  paintButtons();
}

// A and F as lines, plus a faint band for every cut already taken from this
// file — read out of the .nlc, so a video reopened tomorrow still shows what
// has been lifted from it.
function paintMarks() {
  var bands = document.getElementById('llc-bands');
  if (!bands) return;
  var html = '';
  var i, c, l, r;
  for (i = 0; i < S.cuts.length; i++) {
    c = S.cuts[i];
    if (!(c && isFinite(c.startSec) && isFinite(c.endSec))) continue;
    l = pctOf(c.startSec); r = pctOf(c.endSec);
    if (r < 0 || l > 100) continue;
    l = Math.max(0, Math.min(100, l)); r = Math.max(0, Math.min(100, r));
    html += '<div style="position:absolute;top:0;bottom:0;left:' + l + '%;width:' +
            Math.max(0.4, r - l) + '%;background:rgba(255,160,0,0.22);' +
            'border-left:1px solid rgba(255,160,0,0.7);"></div>';
  }
  // Keyframe ticks — faint, low, and only across the stretch actually probed,
  // so an empty patch of bar reads as "not looked at" rather than "none here".
  if (S.kf && S.kf.length) {
    for (i = 0; i < S.kf.length; i++) {
      l = pctOf(S.kf[i]);
      if (l < 0 || l > 100) continue;
      html += '<div style="position:absolute;bottom:0;height:5px;width:1px;left:' + l +
              '%;background:rgba(120,220,255,0.55);"></div>';
    }
  }
  // The one the cut will snap back to — solid cyan, and the stretch between it
  // and A shaded, because that shading IS the footage you did not ask for.
  var sp = snapPoint();
  if (sp != null && S.a != null && S.a - sp > 0.004) {
    l = pctOf(sp); r = pctOf(S.a);
    html += '<div style="position:absolute;top:0;bottom:0;left:' + Math.max(0, Math.min(100, l)) +
            '%;width:' + Math.max(0.3, Math.min(100, r) - Math.max(0, l)) +
            '%;background:repeating-linear-gradient(45deg,rgba(0,200,255,0.25) 0 4px,' +
            'transparent 4px 8px);"></div>';
    html += '<div style="position:absolute;top:-2px;bottom:-2px;width:2px;background:#0cf;left:' +
            Math.max(0, Math.min(100, l)) + '%;"></div>';
  }
  if (S.a != null) {
    html += '<div style="position:absolute;top:-2px;bottom:-2px;width:2px;background:#0f0;left:' +
            Math.max(0, Math.min(100, pctOf(S.a))) + '%;"></div>';
  }
  if (S.b != null) {
    html += '<div style="position:absolute;top:-2px;bottom:-2px;width:2px;background:#0f0;left:' +
            Math.max(0, Math.min(100, pctOf(S.b))) + '%;"></div>';
  }
  bands.innerHTML = html;
}

function paintButtons() {
  var a = document.getElementById('llc-a');
  var b = document.getElementById('llc-b');
  var save = document.getElementById('llc-save');
  var lab = document.getElementById('llc-label');
  var play = document.getElementById('llc-play');
  if (a) {
    // The A button says where the cut will BEGIN, not only where the mark is:
    // "A 12.4 ⟵0.9s" means nine tenths of the previous shot come with it, and
    // q takes that away. On a mark that already sits on a keyframe it says ✓.
    var sp = snapPoint();
    var tail = '';
    if (S.a != null && sp != null) {
      tail = (S.a - sp > 0.04) ? ('  ⟵' + (S.a - sp).toFixed(1) + 's') : '  ✓';
    }
    a.textContent = (S.a != null) ? ('A ' + fmtTime(S.a) + tail) : 'A';
    a.style.background = (S.a != null) ? '#062' : '#123';
    a.style.borderColor = (S.a != null) ? '#0c6' : '#06f';
    a.title = (S.a != null && sp != null && S.a - sp > 0.04)
      ? ('The copy has to start on a keyframe, so it will begin at ' + fmtTime(sp) +
         ' — press q to move A there.')
      : 'Mark the start here (a)';
  }
  if (b) {
    b.textContent = (S.b != null) ? ('F ' + fmtTime(S.b)) : 'F';
    b.style.background = (S.b != null) ? '#062' : '#123';
    b.style.borderColor = (S.b != null) ? '#0c6' : '#06f';
  }
  var ready = (S.a != null && S.b != null && S.b > S.a);
  if (save && !S.busy) {
    save.disabled = !ready;
    save.textContent = ready
      ? ('✂ Save ' + Math.max(1, Math.round(S.b - S.a)) + 's')
      : '✂ Save cut';
  }
  if (lab) {
    lab.textContent = S.label ? ('“' + S.label + '”') : '(name this clip)';
    lab.style.opacity = S.label ? '1' : '0.7';
  }
  if (play) play.textContent = (S.vid && !S.vid.paused) ? '❚❚' : '▶';
}

function status(t) {
  var s = document.getElementById('llc-status');
  if (s) s.textContent = t || '';
}

// ══════════════════════════════════════════════════════════════════════════
// Transport
// ══════════════════════════════════════════════════════════════════════════
function togglePlay() {
  if (!S || !S.vid) return;
  if (S.vid.paused) { S.vid.play().catch(function () {}); }
  else S.vid.pause();
  paintButtons();
}

function seekTo(t) {
  if (!S || !S.vid) return;
  S.vid.currentTime = Math.max(0, Math.min(S.dur - 0.001, t));
  paint();
}

function step(frames) {
  if (!S || !S.vid) return;
  if (!S.vid.paused) S.vid.pause();          // a step you cannot see is not a step
  seekTo((S.vid.currentTime || 0) + frames / (S.fps || 30));
}

// An end before its start is not an end, so setting one mark past the other
// drops that other one rather than quietly making a backwards cut. Said out
// loud: a mark that vanished without a word reads as a key that did nothing.
function markA() {
  if (!S || !S.vid) return;
  S.a = S.vid.currentTime || 0;
  if (S.b != null && S.b <= S.a) { S.b = null; toastMsg('F was before A — dropped it', 1800); }
  paint();
  // Where this cut can really start. Only A needs it: the END of a stream copy
  // is packet-accurate, it is only the beginning that has to land on a keyframe.
  probeKeyframes(S.a);
}

function markB() {
  if (!S || !S.vid) return;
  S.b = S.vid.currentTime || 0;
  if (S.a != null && S.a >= S.b) { S.a = null; toastMsg('A was after F — dropped it', 1800); }
  paint();
}

function clearMarks() {
  if (!S) return;
  S.a = S.b = null;
  S.expand = false;   // nothing left for a zoomed bar to span
  paint();
}

function toggleExpand() {
  if (!S) return;
  if (S.a == null || S.b == null) { toastMsg('Mark A and F first (a and f)', 1800); return; }
  S.expand = !S.expand;
  paint();
  toastMsg(S.expand ? ('↔ bar zoomed to the cut — ' + (S.b - S.a).toFixed(1) + 's across')
                    : '↔ bar back to the whole video', 1500);
}

// ══════════════════════════════════════════════════════════════════════════
// Keyframes — where a lossless cut is actually allowed to start
//
// A stream copy cannot begin in the middle of a GOP, so ffmpeg moves the start
// back to the keyframe before the mark. It does this silently, which is how a
// "12.4s" cut comes out 14 frames longer than asked for with a second of the
// previous shot on the front. The honest thing is to show where the cut will
// really land BEFORE it is taken, so LLC probes the keyframes around A and
// draws the one it will snap to.
//
// Probed around the mark rather than for the whole file: a two-hour clip has
// thousands, ffprobe would read all of it, and only the ones next to the mark
// are the answer. -show_packets means nothing is decoded.
// ══════════════════════════════════════════════════════════════════════════
var LLC_KF_BACK = 20;   // seconds of history to look through for the snap
var LLC_KF_FWD  = 6;    // …and a little ahead, so the ticks around A are drawn

function probeKeyframes(around) {
  if (!S) return;
  var from = Math.max(0, around - LLC_KF_BACK);
  var span = Math.min(600, (around - from) + LLC_KF_FWD);
  var src = S.src;
  fetch(LLC_PROXY + '/exec/ffprobe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: src, keyframes: { fromSec: from, spanSec: span } })
  }).then(function (r) { return r.json(); }).then(function (j) {
    if (!S || S.src !== src) return;              // closed, or a different file
    var pk = j && j.result && j.result.packets;
    if (!Array.isArray(pk)) return;
    var ks = [];
    for (var i = 0; i < pk.length; i++) {
      // 'K' is the keyframe flag; ffprobe writes it as "K_" or "K__".
      if (pk[i] && /K/.test(String(pk[i].flags || ''))) {
        var t = parseFloat(pk[i].pts_time);
        if (isFinite(t)) ks.push(t);
      }
    }
    ks.sort(function (a, b) { return a - b; });
    S.kf = ks;
    S.kfFrom = from;
    S.kfTo = from + span;
    paint();
  }).catch(function () { /* no keyframes read = no snap line, and that is honest */ });
}

// The keyframe the cut will actually start on: the last one at or before A.
// null when it is not known — no probe yet, or A sits outside the probed
// stretch, and guessing there would be worse than saying nothing.
function snapPoint() {
  if (!S || S.a == null || !S.kf || !S.kf.length) return null;
  if (S.a < S.kfFrom || S.a > S.kfTo) return null;
  var best = null;
  for (var i = 0; i < S.kf.length; i++) {
    if (S.kf[i] <= S.a + 0.001) best = S.kf[i]; else break;
  }
  return best;
}

function snapAToKeyframe() {
  var k = snapPoint();
  if (k == null) {
    toastMsg(S && S.a == null ? 'Mark A first (a)' : 'Keyframes not read yet — a moment', 2000);
    return;
  }
  S.a = k;
  seekTo(k);
  toastMsg('A snapped back to its keyframe — the cut starts exactly here now', 2600);
}

// ══════════════════════════════════════════════════════════════════════════
// The label — asked for once per source file
// ══════════════════════════════════════════════════════════════════════════
function rememberedLabel(abs) {
  try {
    var j = JSON.parse(localStorage.getItem(LLC_LABEL_KEY) || 'null');
    if (j && j.src === abs && j.label) return j.label;
  } catch (_) {}
  return '';
}

function storeLabel(abs, label) {
  try { localStorage.setItem(LLC_LABEL_KEY, JSON.stringify({ src: abs, label: label })); }
  catch (_) {}
}

// Returns the label, or '' if the user backed out. `force` opens the prompt
// even when one is already remembered (the `c` key / clicking the chip).
function askLabel(force) {
  if (!S) return '';
  if (S.label && !force) return S.label;
  var seed = S.label || '';
  var got = window.prompt(
    'One word or two for what this clip shows.\n\n' +
    'It goes in the filename, and it is remembered for this video — ' +
    'later cuts of the same file will not ask again.\n\n' +
    S.stem + '_ncrop_[  ]_<start>_<length>.mp4', seed);
  if (got == null) return '';
  var clean = sanitizeLabel(got);
  if (!clean) { toastMsg('That leaves nothing usable for a filename', 2200); return ''; }
  S.label = clean;
  storeLabel(S.src, clean);
  paintButtons();
  return clean;
}

// ══════════════════════════════════════════════════════════════════════════
// The .nlc cut log
// ══════════════════════════════════════════════════════════════════════════
function nlcLoad() {
  if (!S) return Promise.resolve();
  return fetch(LLC_PROXY + '/llc/nlc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video: S.src, read: true })
  }).then(function (r) { return r.json(); }).then(function (j) {
    if (!j || !j.ok || !j.nlc) return;
    var cuts = j.nlc.cuts;
    if (Array.isArray(cuts)) S.cuts = cuts;
    // A .nlc that already names a label is a better answer than localStorage:
    // it travels with the file, and localStorage holds one source at a time.
    if (!S.label && cuts && cuts.length) {
      var last = cuts[cuts.length - 1];
      if (last && last.label) { S.label = last.label; storeLabel(S.src, last.label); }
    }
    paint();
  }).catch(function () { /* no log yet is the normal case */ });
}

function nlcAppend(cut) {
  if (!S) return Promise.resolve();
  return fetch(LLC_PROXY + '/llc/nlc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video: S.src, durationSec: S.dur, cut: cut })
  }).then(function (r) { return r.json(); }).then(function (j) {
    if (j && j.ok && j.nlc && Array.isArray(j.nlc.cuts)) S.cuts = j.nlc.cuts;
    paint();
    return j;
  }).catch(function (e) {
    // The mp4 is already on disk — a log that did not get written is worth
    // saying out loud, but it is not a failed cut.
    console.warn('[llc] .nlc write failed', e);
    return null;
  });
}

// ══════════════════════════════════════════════════════════════════════════
// The cut
// ══════════════════════════════════════════════════════════════════════════

// One request/response cycle to /exec/ffmpeg, NDJSON progress into the button.
// Same shape as vp.js's _vpCropRun; kept here so this file stands alone.
function runFfmpeg(payload, btn, totalMs) {
  var setLabel = function (s) { if (btn) btn.textContent = s; };
  setLabel('0%');
  return fetch(LLC_PROXY + '/exec/ffmpeg', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(function (res) {
    if (!res.ok) {
      return res.text().catch(function () { return ''; }).then(function (txt) {
        throw new Error('HTTP ' + res.status + (txt ? ': ' + txt.slice(0, 200) : ''));
      });
    }
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = '', stderr = [], exitCode = -1;
    var pump = function () {
      return reader.read().then(function (r) {
        if (r.done) return { exitCode: exitCode, stderr: stderr };
        buf += dec.decode(r.value, { stream: true });
        var nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          var line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line) continue;
          var ev;
          try { ev = JSON.parse(line); } catch (_) { continue; }
          if (ev.type === 'progress') {
            var pct = (totalMs > 0 && ev.timeMs != null)
              ? Math.min(100, Math.max(0, Math.round(ev.timeMs / totalMs * 100))) : null;
            setLabel((pct === 100 ? 'finalizing' : (pct != null ? pct + '%' : '…')) +
                     (ev.speed ? ' · ' + ev.speed : ''));
          } else if (ev.type === 'stderr') {
            stderr.push(ev.line);
          } else if (ev.type === 'done') {
            exitCode = (typeof ev.exitCode === 'number') ? ev.exitCode : -1;
            if (ev.error) stderr.push(ev.error);
          }
        }
        return pump();
      });
    };
    return pump();
  });
}

// A stream copy prints things a successful run also prints — see the dev0919
// note in vp.js. Take the last line that ISN'T one of those.
var LLC_BENIGN = /(index entry|edit list|unhandled|poorly interleaved|deprecated|non-monotonous|timestamps)/i;
function failLine(stderr) {
  for (var i = stderr.length - 1; i >= 0; i--) {
    if (!LLC_BENIGN.test(stderr[i])) return stderr[i];
  }
  return stderr.length ? stderr[stderr.length - 1] : '';
}

function saveCut() {
  if (!S || S.busy) return;
  if (S.a == null || S.b == null || S.b <= S.a) {
    toastMsg('Mark the start with a and the end with f first', 2400);
    return;
  }
  var label = askLabel(false);
  if (!label) return;                       // backed out of the prompt

  var a = S.a, b = S.b, dur = b - a;
  var want = dirName(S.src) + '\\' + cutFileName(S.stem, label, a, dur);
  var btn = document.getElementById('llc-save');
  S.busy = true;
  if (btn) btn.disabled = true;
  if (S.vid && !S.vid.paused) S.vid.pause();
  status('cutting…');

  // Ask for a name that is free rather than overwriting: two cuts CAN land on
  // the same name when their starts round to the same second.
  fetch(LLC_PROXY + '/edit/freename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: want })
  }).then(function (r) { return r.json(); }).then(function (j) {
    var out = (j && j.ok && j.path) ? j.path : want;
    var base = { input: S.src, output: out, trim: { startSec: a, endSec: b }, overwrite: false };
    // allStreams keeps every audio/subtitle track. It can be refused by the mp4
    // muxer on a file carrying a stream it will not take, so a failure retries
    // once without it: a clip with one audio track beats no clip at all.
    return runFfmpeg(Object.assign({ allStreams: true }, base), btn, dur * 1000)
      .then(function (res) {
        if (res.exitCode === 0) return out;
        console.warn('[llc] -map 0 failed, retrying with ffmpeg\'s own stream pick',
                     failLine(res.stderr));
        status('retrying without extra tracks…');
        return runFfmpeg(base, btn, dur * 1000).then(function (res2) {
          if (res2.exitCode !== 0) {
            throw new Error(failLine(res2.stderr) || ('ffmpeg exited ' + res2.exitCode));
          }
          return out;
        });
      });
  }).then(function (out) {
    // (dev0927) The camera block. ffmpeg's own flags carry the dates, the GPS
    // and the Android keys; what they never surface is the QuickTime Author
    // field and the Samsung model atom, because its mov demuxer does not read
    // them — this is precisely what LosslessCut drops. exiftool patches them
    // into the udta box without rewriting the file. Best-effort: a clip on disk
    // is not a failed clip because a tag did not take.
    status('camera tags…');
    return fetch(LLC_PROXY + '/exec/exiftool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: S.src, output: out, carry: { kind: 'video' } })
    }).catch(function () {}).then(function () { return out; });
  }).then(function (out) {
    // A cut is a piece of an old moment, not a new one — it files beside its
    // original rather than at "now". Best-effort: a clip with the wrong date
    // is still a good clip.
    // AFTER the carry, never before: exiftool rewrites FileModifyDate as a
    // side effect of writing anything, so the dates have to be the last word.
    status('stamping dates…');
    return fetch(LLC_PROXY + '/vp/copytimes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: S.src, target: out })
    }).catch(function () {}).then(function () { return out; });
  }).then(function (out) {
    var cut = {
      label: label,
      startSec: +a.toFixed(3),
      endSec: +b.toFixed(3),
      durSec: +dur.toFixed(3),
      start: fmtTime(a),
      end: fmtTime(b),
      output: baseName(out),
      at: new Date().toISOString()
    };
    return nlcAppend(cut).then(function () { return out; });
  }).then(function (out) {
    S.busy = false;
    status('');
    if (btn) { btn.disabled = false; }
    paint();
    toastMsg('✂ ' + baseName(out) + '  (' + Math.round(dur) + 's, no re-encode)', 4200);
  }).catch(function (e) {
    S.busy = false;
    if (btn) btn.disabled = false;
    status('');
    paint();
    var m = String((e && e.message) || e);
    console.error('[llc] cut failed', e);
    toastMsg('Cut failed: ' + m.slice(0, 180), 6000);
  });
}

// ══════════════════════════════════════════════════════════════════════════
// Keyboard — capture phase, and it owns everything while it is up
// ══════════════════════════════════════════════════════════════════════════
function onKey(e) {
  if (!S) return;
  // Ctrl / Alt / ⌘ are the browser's and the machine's — Ctrl+R to reload and
  // Ctrl+Shift+I for devtools have to keep working, and the blanket swallow at
  // the bottom of this function would otherwise eat both.
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  var t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  var k = e.key;
  var eat = function () { e.preventDefault(); e.stopPropagation(); };

  if (k === 'Escape')            { eat(); close(); return; }
  if (k === ' ' || k === 'Spacebar') { eat(); togglePlay(); return; }
  if (k === 'a' || k === 'A')    { eat(); markA(); return; }
  if (k === 'f' || k === 'F')    { eat(); markB(); return; }
  if (k === 's')                 { eat(); step(-1); return; }
  if (k === 'd')                 { eat(); step(1);  return; }
  if (k === 'S')                 { eat(); step(-(S.fps || 30)); return; }
  if (k === 'D')                 { eat(); step(S.fps || 30);   return; }
  if (k === 'ArrowLeft')         { eat(); step(e.shiftKey ? -(S.fps || 30) : -1); return; }
  if (k === 'ArrowRight')        { eat(); step(e.shiftKey ?  (S.fps || 30) :  1); return; }
  // t = Trim, the key that does the thing this screen exists for. w and g are
  // kept as aliases — w for the left hand, g because that is V's save key.
  if (k === 't' || k === 'T' || k === 'w' || k === 'W' || k === 'g' || k === 'G') {
    eat(); saveCut(); return;
  }
  if (k === 'q' || k === 'Q')    { eat(); snapAToKeyframe(); return; }
  if (k === 'z' || k === 'Z')    { eat(); clearMarks(); return; }
  if (k === 'x' || k === 'X')    { eat(); toggleExpand(); return; }
  if (k === 'c' || k === 'C')    { eat(); askLabel(true); return; }
  // `h` never reaches here — helpfloat.js claims it on WINDOW capture, which
  // fires ahead of this document-capture handler. It asks _llcHelpToggle below
  // and gets the same panel, so both keys land in the same place.
  if (k === '?') { eat(); toggleHelp(); return; }
  // Everything else is swallowed too: nearly every letter is a screen in this
  // app, and opening the Table behind a cutter that is still up helps nobody.
  if (k.length === 1) eat();
}

function toggleHelp() {
  var h = document.getElementById('llc-help');
  if (h) h.style.display = (h.style.display === 'none' || !h.style.display) ? 'block' : 'none';
}

// ══════════════════════════════════════════════════════════════════════════
// Open / close
// ══════════════════════════════════════════════════════════════════════════
function wire(ov) {
  var byId = function (id) { return document.getElementById(id); };
  byId('llc-play').onclick  = togglePlay;
  byId('llc-back').onclick  = function () { step(-1); };
  byId('llc-fwd').onclick   = function () { step(1); };
  byId('llc-a').onclick     = markA;
  byId('llc-b').onclick     = markB;
  byId('llc-clear').onclick = clearMarks;
  byId('llc-zoom').onclick  = toggleExpand;
  byId('llc-save').onclick  = saveCut;
  byId('llc-label').onclick = function () { askLabel(true); };
  byId('llc-qm').onclick    = toggleHelp;
  byId('llc-close').onclick = close;

  // Click or drag the bar to seek. Pointer events, not mouse — see the note in
  // vp.js about a rotated page cancelling a mouse drag.
  var tl = byId('llc-timeline');
  var scrub = function (e) {
    var r = tl.getBoundingClientRect();
    if (!r.width) return;
    var frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    seekTo(timeAt(frac));
  };
  tl.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    S.scrubbing = true;
    try { tl.setPointerCapture(e.pointerId); } catch (_) {}
    scrub(e);
  });
  tl.addEventListener('pointermove', function (e) { if (S && S.scrubbing) scrub(e); });
  var end = function (e) {
    if (!S) return;
    S.scrubbing = false;
    try { tl.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  tl.addEventListener('pointerup', end);
  tl.addEventListener('pointercancel', end);

  // Clicking the picture is play/pause, the way it is in every player.
  byId('llc-stage').addEventListener('click', function (e) {
    if (e.target && e.target.id === 'llc-video') togglePlay();
  });
}

// The real frame rate, so a frame step is a frame rather than a thirtieth of a
// second. Best-effort — 30 is a reasonable wrong answer and nothing breaks.
function probeFps() {
  if (!S) return;
  fetch(LLC_PROXY + '/exec/ffprobe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: S.src, streams: true })
  }).then(function (r) { return r.json(); }).then(function (j) {
    // ffprobe goes through streamExecCollect, so the answer is
    // {ok, result:{streams:[…]}} — with `stdout` instead when it would not parse.
    var st = j && j.result && j.result.streams && j.result.streams[0];
    var rate = st && (st.r_frame_rate || st.avg_frame_rate);
    if (!rate && j && typeof j.stdout === 'string') {
      var mm = /"r_frame_rate"\s*:\s*"([^"]+)"/.exec(j.stdout);
      rate = mm ? mm[1] : '';
    }
    var m = /^(\d+)\/(\d+)$/.exec(String(rate || ''));
    var f = m ? (+m[1] / +m[2]) : parseFloat(rate);
    if (isFinite(f) && f > 0 && f <= 1000) S.fps = f;
  }).catch(function () {});
}

function close() {
  if (!S) return;
  document.removeEventListener('keydown', onKey, true);
  if (S.raf) cancelAnimationFrame(S.raf);
  try { if (S.vid) { S.vid.pause(); S.vid.removeAttribute('src'); S.vid.load(); } } catch (_) {}
  var ov = document.getElementById('llc-overlay');
  if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
  S = null;
}

window.llcOpenLocalFile = function (absPath) {
  if (!absPath) return false;
  if (!isLocalHost()) {
    toastMsg('Cutting disk files works on the local dev server only', 3000);
    return false;
  }
  if (!LLC_VIDEO_RE.test(absPath)) {
    toastMsg('LLC cuts videos. This is: ' + absPath, 4000);
    return false;
  }
  if (S) close();

  var ov = buildScreen(absPath);
  var vid = ov.querySelector('#llc-video');
  S = {
    src: absPath,
    stem: stemOf(baseName(absPath)),
    vid: vid,
    dur: 0,
    fps: 30,
    a: null, b: null,
    label: rememberedLabel(absPath),
    cuts: [],
    kf: null, kfFrom: 0, kfTo: 0,
    expand: false,
    busy: false,
    scrubbing: false,
    raf: 0
  };
  wire(ov);
  document.addEventListener('keydown', onKey, true);

  vid.onerror = function () {
    toastMsg('Could not read that file — is "node proxy.js" running?  ' + absPath, 6000);
    status('cannot read the file');
  };
  vid.onloadedmetadata = function () {
    S.dur = vid.duration || 0;
    paint();
    probeFps();
    nlcLoad();
  };
  vid.onplay = paintButtons;
  vid.onpause = paintButtons;
  vid.src = fileUrl(absPath);

  // One repaint loop for the playhead — cheaper and smoother than timeupdate,
  // which only fires about four times a second.
  var tick = function () {
    if (!S) return;
    if (S.vid && !S.vid.paused) paint();
    S.raf = requestAnimationFrame(tick);
  };
  S.raf = requestAnimationFrame(tick);

  // The path caption would be burned into any screenshot, and it has done its
  // job by the time the picture is up.
  setTimeout(function () {
    var t = document.getElementById('llc-title');
    if (t) t.style.display = 'none';
  }, 4000);
  return true;
};

// core.js's window-capture hotkey dispatcher asks this before forwarding a
// letter anywhere — same contract as _vpCropHolding. Without it, `a` opens the
// Annotate screen behind a cutter that is still on top of it.
window._llcHolding = function () { return !!document.getElementById('llc-overlay'); };

// helpfloat.js's `h` asks this before falling back to the app's own panel, the
// same way it asks the crop tool. Returns false when no cutter is open, and
// then `h` means what it always meant.
window._llcHelpToggle = function () {
  if (!document.getElementById('llc-help')) return false;
  toggleHelp();
  return true;
};

// Read ?llc= once the page has finished starting up, so the cutter doesn't
// race the landing screen that would paint over it.
(function boot() {
  var p = '';
  try { p = new URLSearchParams(location.search).get('llc') || ''; } catch (_) {}
  if (!p) return;
  var go = function () {
    setTimeout(function () {
      try { window.llcOpenLocalFile(p); } catch (e) { console.error('[llc]', e); }
    }, 400);
  };
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
})();

})();
