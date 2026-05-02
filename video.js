'use strict';

window.seeLearnVideoPlayers = {};
window.seeLearnVideoTimers  = {};
window.seeLearnYTReady      = false;
window.seeLearnYTLoading    = false;
window.seeLearnVimeoReady   = false;
window.seeLearnVimeoLoading = false;

window.getYouTubeId = function(url) {
  if (!url) return '';
  // Shorts:  youtube.com/shorts/ID
  // Watch:   youtube.com/watch?v=ID
  // Short:   youtu.be/ID
  // Embed:   youtube.com/embed/ID
  // Live:    youtube.com/live/ID
  var m = url.match(
    /(?:youtu\.be\/|youtube\.com\/(?:shorts\/|live\/|embed\/|v\/|watch\?(?:.*&)?v=|(?:.*\?)?v=))([A-Za-z0-9_-]{11})/
  );
  return (m && m[1]) ? m[1] : '';
};

// ─── VidRange parsing ─────────────────────────────────────────────────────────
// Format:  "986 20"          → [{start:986, dur:20}]
// Format:  "986 20, 1200 15" → [{start:986,dur:20},{start:1200,dur:15}]
// "i" or non-numeric         → null (image, not video)
window.parseVideoAsset = function(v) {
  var str = String(v || '').trim();
  if (!str || str === 'i') return null;
  var segments = str.split(',');
  var result = [];
  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i].trim();
    if (!seg) continue;
    var parts = seg.split(/\s+/);
    if (!parts.length || isNaN(Number(parts[0]))) return null;
    result.push({
      start: Number(parts[0]),
      dur:   (parts.length > 1 && !isNaN(Number(parts[1]))) ? Number(parts[1]) : 1
    });
  }
  return result.length ? result : null;
};

// Serialize array of segments back to VidRange string
window.serializeSegments = function(segs) {
  return segs.map(function(s) {
    var st = parseFloat(Number(s.start).toFixed(1));
    var d  = parseFloat(Number(s.dur).toFixed(1));
    return d === 1 ? String(st) : st + ' ' + d;
  }).join(', ');
};

window.isNumericAsset = function(v) { return window.parseVideoAsset(v) !== null; };
window.isYouTubeLink  = function(url) { return /youtu\.be|youtube\.com/i.test(url || ''); };
window.isVimeoLink    = function(url) { return /vimeo\.com/i.test(url || ''); };

// ─── API loaders ──────────────────────────────────────────────────────────────
window.loadYouTubeApiOnce = function() {
  if (window.YT && window.YT.Player) { window.seeLearnYTReady = true; return Promise.resolve(); }
  if (window.seeLearnYTLoading) {
    return new Promise(function(res) {
      var t = setInterval(function() { if (window.seeLearnYTReady) { clearInterval(t); res(); } }, 100);
    });
  }
  window.seeLearnYTLoading = true;
  return new Promise(function(res) {
    var tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    var first = document.getElementsByTagName('script')[0];
    if (first && first.parentNode) first.parentNode.insertBefore(tag, first);
    else document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady = function() { window.seeLearnYTReady = true; res(); };
  });
};

window.loadVimeoApiOnce = function() {
  if (window.Vimeo && window.Vimeo.Player) { window.seeLearnVimeoReady = true; return Promise.resolve(); }
  if (window.seeLearnVimeoLoading) {
    return new Promise(function(res) {
      var t = setInterval(function() { if (window.seeLearnVimeoReady) { clearInterval(t); res(); } }, 100);
    });
  }
  window.seeLearnVimeoLoading = true;
  return new Promise(function(res) {
    var tag = document.createElement('script');
    tag.src = 'https://player.vimeo.com/api/player.js';
    tag.onload = function() { window.seeLearnVimeoReady = true; res(); };
    document.head.appendChild(tag);
  });
};

window.stopCellVideoLoop = function(cellId) {
  if (window.seeLearnVideoTimers[cellId]) {
    clearInterval(window.seeLearnVideoTimers[cellId]);
    delete window.seeLearnVideoTimers[cellId];
  }
  if (window.seeLearnVideoPlayers[cellId] &&
      typeof window.seeLearnVideoPlayers[cellId].destroy === 'function') {
    try { window.seeLearnVideoPlayers[cellId].destroy(); } catch(e) {}
  }
  delete window.seeLearnVideoPlayers[cellId];
};

// Pause video without destroying (keeps player intact)
window.pauseCellVideo = function(cellId) {
  if (window.seeLearnVideoTimers[cellId]) {
    clearInterval(window.seeLearnVideoTimers[cellId]);
    delete window.seeLearnVideoTimers[cellId];
  }
  var player = window.seeLearnVideoPlayers[cellId];
  if (player) {
    // YouTube player
    if (typeof player.pauseVideo === 'function') {
      try { player.pauseVideo(); } catch(e) {}
    }
    // Vimeo player
    else if (typeof player.pause === 'function') {
      try { player.pause(); } catch(e) {}
    }
  }
};

// ─── Multi-segment playback ───────────────────────────────────────────────────
// segsArg: optional array of {start,dur}. If omitted, uses legacy startSec+dur.
// Plays each segment in order then loops back to first.

window.mountYouTubeClip = async function(hostEl, url, startSec, dur, isMuted, customSeekTo, segsArg) {
  var vid = getYouTubeId(url);
  if (!vid || !hostEl) return;

  // YouTube blocks embedding on file:/// origins (Error 153).
  // Show a simple click-to-open card instead.
  if (location.protocol === 'file:') {
    hostEl.innerHTML = '';
    var card = document.createElement('div');
    card.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column;'
      + 'align-items:center;justify-content:center;background:#111;cursor:pointer;';
    card.innerHTML = '<div style="font-size:28px;margin-bottom:6px;">▶</div>'
      + '<div style="color:#f00;font-size:11px;font-weight:bold;">YouTube</div>'
      + '<div style="color:#aaa;font-size:10px;margin-top:4px;text-align:center;padding:0 8px;">'
      + 'Tap to open<br>(local file)</div>';
    card.addEventListener('click', function() { window.open(url, '_blank'); });
    hostEl.appendChild(card);
    return;
  }

  await loadYouTubeApiOnce();
  var cellId = hostEl.id;
  stopCellVideoLoop(cellId);
  hostEl.innerHTML = '';

  var segs = Array.isArray(segsArg) ? segsArg
    : [{ start: Number(startSec), dur: Number(dur) }];
  var segIdx = 0;

  var innerId = 'yt_' + cellId.replace(/[^a-zA-Z0-9_-]/g, '_');
  var div = document.createElement('div');
  div.id = innerId;
  // pointer-events:auto allows clicking the YouTube "More videos" X button if it appears
  div.style.cssText = 'width:100%;height:100%;pointer-events:auto;';
  hostEl.appendChild(div);

  var initSeek = customSeekTo !== undefined ? Number(customSeekTo) : segs[0].start;

  // (zip0124) Host respects window.getSetting('ytPrivacy') if available.
  // 'nocookie' uses youtube-nocookie.com (privacy-enhanced, no session
  // sharing — best for production deploys to GitHub Pages etc.). Default
  // 'normal' uses youtube.com so signed-in sessions reach the iframe and
  // bot-detection rarely fires (best for local dev).
  var _ytPrivacy = (typeof window.getSetting === 'function')
    ? window.getSetting('ytPrivacy') : null;
  var _ytHost = _ytPrivacy === 'nocookie'
    ? 'https://www.youtube-nocookie.com'
    : 'https://www.youtube.com';

  var player = new YT.Player(innerId, {
    videoId: vid,
    host: _ytHost,
    playerVars: {
      autoplay: 1, controls: 0, disablekb: 1, fs: 0, rel: 0,
      modestbranding: 1, playsinline: 1,
      start: Math.floor(initSeek),
      iv_load_policy: 3,
      endscreen: 0,
      cc_load_policy: 0,
      origin: window.location.origin || window.location.hostname || 'localhost'
    },
    events: {
      onReady: function(e) {
        if (isMuted) e.target.mute(); else e.target.unMute();
        var allowSeek = !window.keyframeOnly;
        e.target.seekTo(initSeek, allowSeek);

        // Get actual video duration so VidRange "0 99999" loops at real end
        // (critical for Shorts whose duration is 15-60s, not 99999s)
        try {
          var realDur = e.target.getDuration();
          if (realDur > 0 && realDur < 99990) {
            segs.forEach(function(s) {
              if (s.dur > realDur) s.dur = Math.max(1, realDur - s.start);
            });
          }
        } catch(_de) {}

        function makeLoopInterval() {
          return setInterval(function() {
            if (e.target._salPaused) return;
            try {
              var t   = e.target.getCurrentTime();
              var seg = segs[segIdx];
              if (t >= seg.start + seg.dur - 0.2) {
                segIdx = (segIdx + 1) % segs.length;
                e.target.seekTo(segs[segIdx].start, allowSeek);
                e.target.playVideo();
              }
            } catch(err) {}
          }, 100);
        }

        if (window.autoPauseGrid) {
          e.target._salPaused = true;
          e.target.playVideo();
          setTimeout(function() {
            try { e.target.pauseVideo(); } catch(ex) {}
          }, 300);
          window.seeLearnVideoTimers[cellId] = setInterval(function() {
            if (e.target._salPaused) return;
            try {
              var t   = e.target.getCurrentTime();
              var seg = segs[segIdx];
              if (t >= seg.start + seg.dur - 0.2) {
                segIdx = (segIdx + 1) % segs.length;
                e.target.seekTo(segs[segIdx].start, allowSeek);
                e.target.playVideo();
              }
            } catch(err) {}
          }, 100);
        } else {
          e.target._salPaused = false;
          e.target.playVideo();
          window.seeLearnVideoTimers[cellId] = makeLoopInterval();
        }
      },
      onStateChange: function(e) {
        // No ENDED handler — interval handles looping at -0.2s
      }
    }
  });
  window.seeLearnVideoPlayers[cellId] = player;
};

window.mountVimeoClip = async function(hostEl, url, startSec, dur, isMuted, customSeekTo, segsArg) {
  if (!hostEl) return;
  await loadVimeoApiOnce();
  var cellId = hostEl.id;
  stopCellVideoLoop(cellId);
  hostEl.innerHTML = '';

  var segs = Array.isArray(segsArg) ? segsArg
    : [{ start: Number(startSec), dur: Number(dur) }];
  var segIdx = 0;

  var div = document.createElement('div');
  div.style.cssText = 'width:100%;height:100%;position:absolute;top:0;left:0;pointer-events:none;';
  hostEl.appendChild(div);

  var player = new Vimeo.Player(div, {
    url: url, autoplay: true, muted: isMuted, controls: false,
    loop: false, autopause: false, transparent: false, background: false
  });

  player.ready().then(function() {
    var iframe = div.querySelector('iframe');
    if (iframe) { iframe.style.width = '100%'; iframe.style.height = '100%'; }
    if (isMuted) player.setVolume(0); else player.setVolume(1);
    var seekTo = customSeekTo !== undefined ? Number(customSeekTo) : segs[0].start;
    player.setCurrentTime(seekTo);
    player.play();
    // Autopause: pause after 100ms so a frame is visible
    if (window.autoPauseGrid !== false) {
      setTimeout(function() { player.pause().catch(function(){}); }, 100);
    }
    window.seeLearnVideoTimers[cellId] = setInterval(function() {
      player.getCurrentTime().then(function(t) {
        var seg = segs[segIdx];
        // UPPER-BOUND ONLY — no lower-bound snap (prevents "goes to beginning" on scrub)
        if (t >= seg.start + seg.dur - 0.2) {
          segIdx = (segIdx + 1) % segs.length;
          player.setCurrentTime(segs[segIdx].start);
          player.play();
        }
      }).catch(function() {});
    }, 100);
  });

  player.on('ended', function() {
    segIdx = (segIdx + 1) % segs.length;
    player.setCurrentTime(segs[segIdx].start);
    player.play();
  });

  window.seeLearnVideoPlayers[cellId] = player;
};

window.cleanupAllVideos = function() {
  for (var cid in window.seeLearnVideoTimers) clearInterval(window.seeLearnVideoTimers[cid]);
  window.seeLearnVideoTimers  = {};
  window.seeLearnVideoPlayers = {};
};

// ─── VIDEO EDITOR (multi-segment) ────────────────────────────────────────────
window.openVideoEditor = function(it) {
  window._lastVideoShown = it;  // remember for EE/VV/floating buttons
  var rawSegs = window.parseVideoAsset(it.VidRange);
  // Load VidComment labels (comma-delimited, one per segment)
  var rawComments = (it.VidComment || '').split(',').map(function(s) { return s.trim(); });
  // No VidRange → start with no segments; Ctrl+click on video or timeline to define first segment
  var hasSegments = !!rawSegs;
  var segs = rawSegs ? rawSegs.map(function(s, i) {
    return { start: s.start, dur: s.dur, comment: rawComments[i] || '' };
  }) : [];
  var activeSegIdx = 0;
  var currentMute  = it.Mute !== '0';
  var totalVideoDur = null;   // filled once player reports duration

  function onTotalDurKnown(d) {
    if (!d || totalVideoDur === d) return;
    totalVideoDur = d;
    renderTimeline(); updateStats();
    // Persist vidLength to the row immediately (don't wait for Save)
    var m = Math.floor(d / 60), s = Math.round(d % 60);
    var durStr = m + ':' + (s < 10 ? '0' : '') + s;
    it.vidLength = durStr;
    if (linksData) {
      var idx2 = linksData.indexOf(it);
      if (idx2 === -1) idx2 = linksData.findIndex(function(r) { return r.link === it.link && r.cell === it.cell; });
      if (idx2 !== -1) linksData[idx2].vidLength = durStr;
    }
    if (window.saveData) window.saveData(true);
  }

  var overlay = document.createElement('div');
  overlay.id  = 'video-editor-overlay';
  if (window.menuWrap) window.menuWrap.style.display = 'none';  // hide HM in editor
  overlay.setAttribute('tabindex', '-1');
  overlay.style.cssText = 'position:fixed;z-index:99999;left:5%;top:5%;width:90%;height:90%;'
    + 'background:#1a1a1a;border:2px solid #8ef;display:flex;flex-direction:column;'
    + 'box-shadow:0 10px 40px rgba(0,0,0,0.9);font-family:sans-serif;color:#fff;'
    + 'border-radius:10px;overflow:hidden;outline:none;';

  overlay.innerHTML = '<style>'
    + '.v2btn{min-width:38px;height:34px;font-size:12px;font-weight:bold;'
    + 'background:#2a2a2a;border:1px solid #555;color:#ddd;cursor:pointer;'
    + 'border-radius:4px;display:inline-flex;align-items:center;justify-content:center;'
    + 'user-select:none;padding:0 6px;}'
    + '.v2btn:hover{background:#3a3a3a;border-color:#8ef;color:#fff;}'
    + '.v2btn:active{background:#8ef;color:#000;}'
    + '.v2num{width:72px;text-align:center;font-size:15px;font-weight:bold;'
    + 'background:#111;color:#fff;border:1px solid #555;border-radius:4px;padding:5px;}'
    + '.v2num::-webkit-inner-spin-button,.v2num::-webkit-outer-spin-button{-webkit-appearance:none;}'
    + '.v2num{-moz-appearance:textfield;}'
    + '.v2segbtn{padding:5px 12px;border-radius:4px;border:1px solid #555;'
    + 'background:#2a2a2a;color:#ccc;cursor:pointer;font-size:13px;}'
    + '.v2segbtn.active{border-color:#8ef;background:#0a1a2a;color:#8ef;font-weight:bold;}'
    + '</style>'
    // Hidden Muted state input (preserved for save logic; not shown)
    + '<input type="checkbox" id="v2mute" style="display:none;"' + (currentMute?' checked':'') + '>'
    + '<div style="display:flex;flex:1;overflow:hidden;">'
    // ── Video + timeline column ──
    + '<div style="flex:1;display:flex;flex-direction:column;background:#000;min-width:0;">'
    + '<div id="v2host" style="flex:1;position:relative;pointer-events:auto;overflow:hidden;cursor:pointer;"></div>'
    + '<div style="flex-shrink:0;padding:10px 14px;background:#111;border-top:1px solid #333;">'
    + '<div style="font-size:12px;color:#666;margin-bottom:5px;">'
    + '<span id="v2segcount" style="color:#aef;"></span>'
    + '&nbsp; <span id="v2clipstotal" style="color:#aef;"></span>'
    + '&nbsp; <span id="v2videototal" style="color:#8a8;"></span>'
    + '&nbsp; &nbsp; <span style="color:#555;">Ctrl+click video = add segment &nbsp;|&nbsp; '
    + 'Click timeline = scrub &nbsp;|&nbsp; '
    + 'Ctrl+click timeline band = delete</span></div>'
    + '<div id="v2timeline" style="position:relative;height:38px;background:#222;'
    + 'border-radius:4px;cursor:crosshair;border:1px solid #444;overflow:hidden;user-select:none;"></div>'
    + '<div style="display:flex;align-items:center;margin-top:8px;gap:12px;flex-wrap:wrap;">'
    // Time readouts (left)
    + '<span id="v2tcur" style="font-size:14px;color:#8ef;font-weight:bold;white-space:nowrap;font-family:monospace;">—</span>'
    + '<span id="v2tend" style="font-size:13px;color:#777;white-space:nowrap;font-family:monospace;"></span>'
    // ffmpeg / LLC export (left side — historic export tools)
    + '<button id="v2ffmpeg" title="Download Windows .bat + concat list for frame-accurate ffmpeg merge" '
    + 'style="padding:6px 11px;background:rgba(60,40,0,0.3);color:#fa8;border:1px solid #fa8;'
    + 'border-radius:5px;cursor:pointer;font-size:13px;">📥 ffmpeg</button>'
    + '<button id="v2llc" title="Download LosslessCut .llc project file" '
    + 'style="padding:6px 11px;background:rgba(0,40,80,0.3);color:#6af;border:1px solid #6af;'
    + 'border-radius:5px;cursor:pointer;font-size:13px;">📥 LLC</button>'
    // Hidden Save button — kept so legacy code paths (Ctrl+S handler, MutationObserver hook)
    // can still find it. Visually invisible; auto-save fires on every field change anyway.
    + '<button id="v2save" style="display:none;">Save</button>'
    // Hidden Close button — same reasoning. Esc/T/G/A/N/J all close E by clicking it.
    + '<button id="v2close" style="display:none;">Close</button>'
    // Spacer pushes the playback controls to the right edge
    + '<div style="flex:1;"></div>'
    // Sel/Full toggle (S key)
    + '<button id="v2toggle" title="Toggle Selected/Full playback (S)" '
    + 'style="padding:6px 11px;background:rgba(80,0,80,0.3);color:#f8f;border:1px solid #f8f;'
    + 'border-radius:5px;cursor:pointer;font-size:13px;">● Sel</button>'
    // Mute (M key)
    + '<button id="v2b-mute" title="Mute/Unmute (M)" '
    + 'style="padding:6px 11px;border-radius:5px;border:1px solid #888;background:rgba(40,40,60,0.6);'
    + 'color:#ccc;cursor:pointer;font-size:14px;font-family:monospace;">'
    // (zip0143) Initial icon set inline; refreshMuteButtonStyle()
    // (further down) updates it on every state change with the SVG
    // helper so the muted state has a thick red slash.
    + (window.muteIconHTML ? window.muteIconHTML(!!currentMute) : (currentMute ? '🔇' : '🔊'))
    + '</button>'
    // (zip0151) Row Mute preference toggle. This is DIFFERENT from the
    // M button to its left: M toggles current playback audio (a session
    // thing); this button toggles the row's permanent Mute field, which
    // controls whether the cell auto-mutes when shown in the grid. The
    // label always reflects the row's current persisted state.
    + '<button id="v2b-rowmute" title="Toggle this row\'s saved Mute preference (column value 0 ↔ 1). 1 = always-mute on grid display." '
    + 'style="padding:6px 11px;border-radius:5px;border:1px solid #fa8;background:rgba(80,40,0,0.35);'
    + 'color:#fa8;cursor:pointer;font-size:11px;font-family:monospace;white-space:nowrap;">'
    + (currentMute ? 'Currently Muted' : 'Currently Unmuted')
    + '</button>'
    // CC (C key)
    + '<button id="v2b-cc" title="Toggle Closed Captions (C)" '
    + 'style="padding:6px 11px;border-radius:5px;border:1px solid #8a8;background:rgba(0,50,0,0.4);'
    + 'color:#8a8;cursor:pointer;font-size:13px;font-family:monospace;">CC</button>'
    // Speed control (rightmost)
    + '<div style="display:flex;align-items:center;gap:6px;">'
    + '<span style="font-size:12px;color:#888;">Spd</span>'
    + '<input id="v2b-speed" type="range" min="0.25" max="2" step="0.25" value="1" '
    + 'style="width:80px;accent-color:#06f;cursor:pointer;" title="Playback speed">'
    + '<span id="v2b-speed-val" style="font-size:13px;color:#8cf;min-width:32px;font-family:monospace;">1x</span>'
    + '</div>'
    + '</div>'
    + '</div></div>'
    // ── Right panel ──
    + '<div style="width:270px;flex-shrink:0;padding:14px;background:#1e1e1e;'
    + 'border-left:1px solid #333;display:flex;flex-direction:column;gap:12px;overflow-y:auto;">'
    // Segment tabs
    + '<div><div style="font-size:11px;color:#888;margin-bottom:5px;">Segment (Tab key to cycle)</div>'
    + '<div id="v2segtabs" style="display:flex;gap:5px;flex-wrap:wrap;"></div></div>'
    // Fine Adjustments title
    + '<div style="font-size:13px;font-weight:bold;color:#ccc;border-bottom:1px solid #444;'
    + 'padding-bottom:5px;">Fine Adjustments</div>'
    // ── Start ──
    + '<div style="margin-bottom:6px;">'
    + '<div style="font-size:11px;color:#888;margin-bottom:2px;">Start (sec)</div>'
    // 5-col grid: col3 holds number, carets, and 0 button
    + '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:3px;align-items:center;">'
    // Row 1: number in col 3 (cols 1-2 empty, col 3 = number, cols 4-5 empty)
    + '<div></div><div></div>'
    + '<input type="number" id="v2start" class="v2num" min="0" step="0.1" style="width:100%;text-align:center;grid-column:3;">'
    + '<div></div><div></div>'
    // Row 2: carets in col 3
    + '<div></div><div></div>'
    + '<div style="display:flex;gap:2px;justify-content:center;">'
    + '<button class="v2btn" id="vs-frame" title="Start -1 frame, pause">&#9664;</button>'
    + '<button class="v2btn" id="vs+frame" title="Start +1 frame, pause">&#9654;</button>'
    + '</div>'
    + '<div></div><div></div>'
    // Row 3: -5 -1 0 +1 +5
    + '<button class="v2btn" id="vs---">-5</button>'
    + '<button class="v2btn" id="vs--">-1</button>'
    + '<button class="v2btn" id="vs-0" style="border-color:#666;color:#aaa;">0</button>'
    + '<button class="v2btn" id="vs++">+1</button>'
    + '<button class="v2btn" id="vs+++">+5</button>'
    + '</div>'
    + '</div>'
    // ── Duration ──
    + '<div style="margin-bottom:6px;">'
    + '<div style="font-size:11px;color:#888;margin-bottom:2px;">Duration (sec)</div>'
    + '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:3px;align-items:center;">'
    // Row 1: number in col 3
    + '<div></div><div></div>'
    + '<input type="number" id="v2dur" class="v2num" min="0.1" step="0.1" style="width:100%;text-align:center;">'
    + '<div></div><div></div>'
    // Row 2: carets in col 3
    + '<div></div><div></div>'
    + '<div style="display:flex;gap:2px;justify-content:center;">'
    + '<button class="v2btn" id="vd-frame" title="Dur -1 frame, pause">&#9664;</button>'
    + '<button class="v2btn" id="vd+frame" title="Dur +1 frame, pause">&#9654;</button>'
    + '</div>'
    + '<div></div><div></div>'
    // Row 3: -5 -1 0 +1 +5
    + '<button class="v2btn" id="vd---">-5</button>'
    + '<button class="v2btn" id="vd--">-1</button>'
    + '<button class="v2btn" id="vd-0" style="border-color:#666;color:#aaa;">0</button>'
    + '<button class="v2btn" id="vd++">+1</button>'
    + '<button class="v2btn" id="vd+++">+5</button>'
    + '</div>'
    + '</div>'
    // Segment ops — Loop Segment just above Add/Delete
    + '<button id="v2-ls" style="width:100%;padding:7px;border-radius:4px;border:1px solid #4af;'
    + 'background:rgba(0,80,180,0.2);color:#8ef;cursor:pointer;font-size:13px;">&#9654; Loop Segment</button>'
    + '<button id="v2addseg" style="padding:7px;border-radius:4px;border:1px solid #4af;'
    + 'background:rgba(0,80,180,0.2);color:#8ef;cursor:pointer;font-size:13px;">+ Add segment</button>'
    + '<button id="v2delseg" style="padding:7px;border-radius:4px;border:1px solid #f66;'
    + 'background:rgba(180,0,0,0.2);color:#f88;cursor:pointer;font-size:13px;">'
    + '&#10005; Delete this segment</button>'
    // VidRange
    + '<div>'
    + '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">'
    + '<span style="font-size:11px;color:#888;">VidRange value</span>'
    + '<button id="v2reorder" style="padding:2px 7px;font-size:10px;border-radius:3px;'
    + 'border:1px solid #8a8;background:rgba(0,60,0,0.2);color:#8a8;cursor:pointer;" '
    + 'title="Re-order segments by start time (earliest first), also reorders VidComment labels">Re-order</button>'
    + '</div>'
    + '<div id="v2vrprev" style="font-size:12px;color:#8ef;word-break:break-all;'
    + 'background:#111;padding:5px;border-radius:4px;border:1px solid #333;'
    + 'font-family:monospace;min-height:20px;"></div></div>'
    + '</div></div>';

  document.body.appendChild(overlay);
  // Focus overlay immediately; refocus when right panel clicked (YouTube steals focus)
  setTimeout(function() { overlay.focus(); }, 100);
  overlay.addEventListener('pointerup', function(e) {
    if (!e.target.closest('#v2host')) overlay.focus();
  });

  // ── Element refs ────────────────────────────────────────────────────────
  var host        = document.getElementById('v2host');
  var iStart      = document.getElementById('v2start');
  var iDur        = document.getElementById('v2dur');
  var iMute       = document.getElementById('v2mute');
  var iSpeed      = document.getElementById('v2b-speed');
  var iSpeedVal   = document.getElementById('v2b-speed-val');
  var iToggle     = document.getElementById('v2toggle');
  var timeline    = document.getElementById('v2timeline');
  var tCur        = document.getElementById('v2tcur');
  var tEnd        = document.getElementById('v2tend');
  var segTabs     = document.getElementById('v2segtabs');
  var vrPrev      = document.getElementById('v2vrprev');
  var segCount    = document.getElementById('v2segcount');
  var clipsTotal  = document.getElementById('v2clipstotal');
  var videoTotal  = document.getElementById('v2videototal');
  
  var veSelectedMode = true; // true = loop segment, false = play full video

  var fmt = function(v) { return parseFloat(Number(v).toFixed(1)); };

  // mm:ss formatter for total video duration
  function toMMSS(sec) {
    var s = Math.floor(sec);
    var m = Math.floor(s / 60);
    return m + ':' + ('0' + (s % 60)).slice(-2);
  }

  // Visible timeline window
  function calcEnd() {
    var maxEnd = Math.max.apply(null, segs.map(function(s) { return s.start + s.dur; }));
    return totalVideoDur ? Math.max(maxEnd + 5, totalVideoDur) : maxEnd + 30;
  }

  // Update header stats
  function updateStats() {
    var total = segs.reduce(function(sum, s) { return sum + s.dur; }, 0);
    clipsTotal.textContent = 'Clips: ' + total.toFixed(1) + 's';
    videoTotal.textContent = totalVideoDur ? ('Video: ' + toMMSS(totalVideoDur)) : '';
  }

  // ── Timeline ──────────────────────────────────────────────────────────────
  var COLOURS = ['#2a6ef5','#e5732a','#2aa87a','#c03ec0','#c0c03e','#e53a3a'];

  function renderTimeline(curT) {
    timeline.innerHTML = '';
    var W   = timeline.offsetWidth || 600;
    var end = calcEnd();
    var sc  = W / end;
    tEnd.textContent = end.toFixed(0) + 's';

    segs.forEach(function(seg, i) {
      var x    = seg.start * sc;
      var w    = Math.max(seg.dur * sc, 4);
      var isAct = i === activeSegIdx;
      var band = document.createElement('div');
      band.style.cssText = 'position:absolute;top:3px;height:30px;'
        + 'left:' + x + 'px;width:' + w + 'px;'
        + 'background:' + COLOURS[i % COLOURS.length] + ';'
        + 'opacity:' + (isAct ? 0.9 : 0.4) + ';border-radius:3px;'
        + 'border:' + (isAct ? '2px solid #fff' : '1px solid rgba(255,255,255,0.25)') + ';'
        + 'display:flex;align-items:center;justify-content:center;'
        + 'font-size:10px;color:#fff;font-weight:bold;cursor:pointer;overflow:hidden;';
      band.textContent = (segs[i].comment ? segs[i].comment.slice(0, 8) : (i + 1));
      // Use pointerdown so it fires before the timeline's own pointerdown handler
      band.addEventListener('pointerdown', function(ev) {
        ev.stopPropagation();
        if (ev.ctrlKey && ev.shiftKey) {
          // Ctrl+Shift+click band = delete segment
          // Empty-segments is a valid state (editor opens this way for videos
          // with no VidRange; ctrl+click re-adds a segment).
          ev.preventDefault();
          segs.splice(i, 1);
          setActiveSeg(Math.min(activeSegIdx, segs.length - 1));
        } else if (!ev.ctrlKey) {
          // Plain click band = switch to that segment and loop it
          ev.preventDefault();
          scrubClickedBand = true;
          setActiveSeg(i);
        }
      });

      // Ctrl+right-click band = open VidComment mini-editor
      band.addEventListener('contextmenu', function(ev) {
        ev.preventDefault(); ev.stopPropagation();
        openCommentEditor(i);
      });
      timeline.appendChild(band);
    });

    if (curT !== undefined) {
      var sx = curT * sc;
      var line = document.createElement('div');
      line.style.cssText = 'position:absolute;top:0;bottom:0;left:' + sx + 'px;'
        + 'width:2px;background:#fff;opacity:0.85;pointer-events:none;';
      timeline.appendChild(line);
      tCur.textContent = curT.toFixed(1) + 's';
    }
  }

  // ── Segment tabs ─────────────────────────────────────────────────────────
  function renderSegTabs() {
    segTabs.innerHTML = '';
    segs.forEach(function(seg, i) {
      var btn = document.createElement('button');
      btn.className = 'v2segbtn' + (i === activeSegIdx ? ' active' : '');
      btn.textContent = segs[i].comment ? ('Seg ' + (i+1) + ': ' + segs[i].comment.slice(0,12)) : 'Seg ' + (i + 1);
      btn.title = segs[i].comment || (seg.start + 's + ' + seg.dur + 's');
      btn.addEventListener('click', function() { setActiveSeg(i); });
      // Right-click on segment tab also opens VidComment mini-editor
      btn.addEventListener('contextmenu', function(ev) {
        ev.preventDefault(); ev.stopPropagation();
        setActiveSeg(i);
        openCommentEditor(i);
      });
      segTabs.appendChild(btn);
    });
    segCount.textContent = '(' + segs.length + ' seg' + (segs.length > 1 ? 's' : '') + ')';
    vrPrev.textContent   = window.serializeSegments(segs);
    updateStats();
  }

  function setActiveSeg(i) {
    if (!segs.length) { activeSegIdx = 0; renderSegTabs(); renderTimeline(); return; }
    activeSegIdx = ((i % segs.length) + segs.length) % segs.length;
    iStart.value = segs[activeSegIdx].start;
    iDur.value   = segs[activeSegIdx].dur;
    renderSegTabs();
    renderTimeline();
    mountLoop();    // switch loop to new active segment
  }

  // ── Shared: persist VidComment to linksData + Tabulator + localStorage ──────
  function persistComment() {
    var newVidComment = segs.map(function(s) { return s.comment || ''; }).join(', ');
    it.VidComment = newVidComment;
    var idx = linksData ? linksData.indexOf(it) : -1;
    if (idx === -1 && linksData) {
      idx = linksData.findIndex(function(r) {
        return r.link === it.link && r.cell === it.cell;
      });
    }
    if (idx !== -1 && linksData) linksData[idx].VidComment = newVidComment;
    if (window._salTab) {
      try {
        var rows = window._salTab.getRows();
        for (var ri = 0; ri < rows.length; ri++) {
          var rd = rows[ri].getData();
          if (rd.link === it.link && rd.cell === it.cell) {
            rows[ri].update({ VidComment: newVidComment }); break;
          }
        }
      } catch(ex) {}
    }
    if (window.saveData) window.saveData(true);
    else {
      localStorage.setItem('seeandlearn-links', JSON.stringify(linksData));
      localStorage.setItem('sal-edited', Date.now().toString());
    }
  }

  // ── VidComment mini-editor: all segments in one screen ──────────────────
  // Triggered by right-click on any segment band.
  // Shows one input per segment; Tab/Shift-Tab cycle; ^S saves all + closes.
  function openCommentEditor(focusSegIdx) {
    var existing = document.getElementById('v2comment-popup');
    if (existing) existing.remove();

    var popup = document.createElement('div');
    popup.id = 'v2comment-popup';
    popup.style.cssText = 'position:fixed;z-index:999999;'
      + 'left:50%;top:50%;transform:translate(-50%,-50%);'
      + 'min-width:320px;max-width:480px;width:90vw;'
      + 'background:#1a2a3a;border:1px solid #4af;border-radius:8px;'
      + 'padding:14px;box-shadow:0 8px 32px rgba(0,0,0,0.9);font-family:sans-serif;color:#fff;';

    var html = '<div style="font-size:13px;font-weight:bold;margin-bottom:10px;color:#8ef;">'
      + 'Segment Labels — VidComment &nbsp;<span style="font-weight:normal;font-size:11px;color:#666;">'
      + 'Tab / Shift-Tab to move &nbsp;·&nbsp; ^S saves &nbsp;·&nbsp; Esc cancels</span></div>';

    segs.forEach(function(seg, i) {
      html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">'
        + '<span style="font-size:11px;color:#8ef;min-width:48px;flex-shrink:0;">Seg ' + (i+1) + '</span>'
        + '<input id="v2ci-' + i + '" type="text" value="' + (seg.comment || '').replace(/"/g,'&quot;') + '" '
        + 'style="flex:1;background:#0d1a2a;color:#fff;border:1px solid #4af;border-radius:4px;'
        + 'padding:5px 7px;font-size:13px;outline:none;" '
        + 'placeholder="Label for segment ' + (i+1) + '" />'
        + '</div>';
    });

    html += '<div style="display:flex;gap:8px;margin-top:10px;">'
      + '<button id="v2cs-save" style="flex:1;padding:7px;border-radius:4px;border:1px solid #4af;'
      + 'background:rgba(0,80,180,0.3);color:#8ef;cursor:pointer;font-size:13px;font-weight:bold;">Save (^S)</button>'
      + '<button id="v2cs-cancel" style="padding:7px 14px;border-radius:4px;border:1px solid #555;'
      + 'background:#222;color:#aaa;cursor:pointer;font-size:13px;">Cancel</button>'
      + '</div>';

    popup.innerHTML = html;
    document.body.appendChild(popup);

    // Focus the segment that was right-clicked
    var firstInp = document.getElementById('v2ci-' + focusSegIdx);
    if (firstInp) setTimeout(function() { firstInp.focus(); firstInp.select(); }, 50);

    function saveComments() {
      segs.forEach(function(seg, i) {
        var inp = document.getElementById('v2ci-' + i);
        if (inp) seg.comment = inp.value.trim();
      });
      popup.remove();
      renderTimeline();
      renderSegTabs();
      persistComment();
    }

    // Live-update: persist to linksData + Tabulator + localStorage as user types
    segs.forEach(function(seg, i) {
      var inp = document.getElementById('v2ci-' + i);
      if (!inp) return;
      inp.addEventListener('input', function() {
        seg.comment = inp.value;
        renderTimeline(); renderSegTabs();
        persistEditorState();  // live-push VidComment to T and localStorage
      });
    });

    document.getElementById('v2cs-save').addEventListener('click', saveComments);
    document.getElementById('v2cs-cancel').addEventListener('click', function() { popup.remove(); });

    // Tab / Shift-Tab cycle between inputs and buttons; ^S saves; Escape cancels
    popup.addEventListener('keydown', function(e) {
      e.stopPropagation();
      if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); saveComments(); return; }
      if (e.key === 'Escape') { popup.remove(); return; }
      // Space or Enter activates a focused button
      if ((e.key === ' ' || e.key === 'Enter') && document.activeElement &&
          document.activeElement.tagName === 'BUTTON') {
        e.preventDefault(); document.activeElement.click(); return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        var focusables = Array.from(popup.querySelectorAll('input, button'));
        var cur = document.activeElement;
        var idx = focusables.indexOf(cur);
        if (e.shiftKey) idx = (idx - 1 + focusables.length) % focusables.length;
        else            idx = (idx + 1) % focusables.length;
        focusables[idx].focus();
        if (focusables[idx].tagName === 'INPUT') focusables[idx].select();
      }
    });
  }

  // ── Input / delta helpers ─────────────────────────────────────────────────
  function readInputs() {
    if (!segs.length) return;
    segs[activeSegIdx].start = fmt(Math.max(0,   parseFloat(iStart.value) || 0));
    segs[activeSegIdx].dur   = fmt(Math.max(0.1, parseFloat(iDur.value)   || 0.1));
    vrPrev.textContent = window.serializeSegments(segs);
    updateStats();
    renderTimeline();
    renderSegTabs();
  }

  // applyDelta: full remount (used by +/- buttons in panel)
  // applyDelta: type='start' restarts from beginning of segment
  //             type='dur'   seeks to 2s before new end
  function applyDelta(type, delta) {
    if (!segs.length) return;
    if (type === 'start') {
      segs[activeSegIdx].start = fmt(Math.max(0, segs[activeSegIdx].start + delta));
      iStart.value = segs[activeSegIdx].start;
      vrPrev.textContent = window.serializeSegments(segs);
      updateStats(); renderTimeline(); renderSegTabs();
      scheduleMount('start');
    } else {
      segs[activeSegIdx].dur = fmt(Math.max(0.1, segs[activeSegIdx].dur + delta));
      iDur.value = segs[activeSegIdx].dur;
      vrPrev.textContent = window.serializeSegments(segs);
      updateStats(); renderTimeline(); renderSegTabs();
      scheduleMount('end');
    }
  }

  function applyDeltaNoRemount(type, delta) {
    if (!segs.length) return;
    if (type === 'start') {
      segs[activeSegIdx].start = fmt(Math.max(0, segs[activeSegIdx].start + delta));
      iStart.value = segs[activeSegIdx].start;
    } else {
      segs[activeSegIdx].dur = fmt(Math.max(0.1, segs[activeSegIdx].dur + delta));
      iDur.value = segs[activeSegIdx].dur;
    }
    vrPrev.textContent = window.serializeSegments(segs);
    updateStats(); renderTimeline(); renderSegTabs();
  }

  // Frame step = 0.1s — one visible "click" step when paused
  // (1/30 ≈ 0.033 rounds to 0.0 with toFixed(1), so we use 0.1 as the step unit)
  var FRAME_SEC = 0.1;
  // Use higher precision for frame arithmetic
  var fmt2 = function(v) { return parseFloat(Number(v).toFixed(2)); };

  // ── Helpers ───────────────────────────────────────────────────────────────

  // ── Live persist: push current segs state to linksData + Tabulator + localStorage ──
  // Called any time segs change (comment edits, caret adjustments, etc.)
  // Does NOT close the editor. linksData now works since linksData is var.
  function persistEditorState() {
    var newVidRange   = window.serializeSegments(segs);
    var newVidComment = segs.map(function(s) { return s.comment || ''; }).join(', ');
    it.VidRange   = newVidRange;
    it.VidComment = newVidComment;
    // Update linksData by index
    var idx = linksData.indexOf(it);
    if (idx === -1) idx = linksData.findIndex(function(r) {
      return r.link === it.link && r.cell === it.cell;
    });
    if (idx !== -1) {
      linksData[idx].VidRange   = newVidRange;
      linksData[idx].VidComment = newVidComment;
    }
    // Update Tabulator row
    if (window._salTab) {
      try {
        var rows = window._salTab.getRows();
        for (var ri = 0; ri < rows.length; ri++) {
          var rd = rows[ri].getData();
          if (rd.link === it.link && rd.cell === it.cell) {
            rows[ri].update({ VidRange: newVidRange, VidComment: newVidComment });
            break;
          }
        }
      } catch(ex) {}
    }
    // Write to localStorage without going through syncTab (skipSync=true)
    if (window.saveData) window.saveData(true);
    else {
      var s = JSON.stringify(linksData);
      localStorage.setItem('seeandlearn-links', s);
      localStorage.setItem('sal-edited', Date.now().toString());
    }
  }

  function updateSegData() {
    vrPrev.textContent = window.serializeSegments(segs);
    updateStats(); renderTimeline(); renderSegTabs();
    persistEditorState();  // live-push to T and localStorage
  }

  // Freeze at a specific frame: suspend interval, shield the iframe, pause, seek.
  function editorSeekFreeze(t) {
    suspendLoop();
    scrubShield.style.display = 'block';
    var p = getEditorPlayer();
    if (!p) return;
    p._salPaused = true;
    if (typeof p.pauseVideo === 'function') {
      try { p.pauseVideo(); p.seekTo(Math.max(0, t), true); } catch(ex) {}
    } else if (p.setCurrentTime) {
      p.pause().catch(function(){});
      p.setCurrentTime(Math.max(0, t)).catch(function(){});
    }
  }

  function editorSeek(t) {
    var p = getEditorPlayer();
    if (!p) return;
    if (typeof p.seekTo === 'function') { try { p.seekTo(Math.max(0, t), true); } catch(ex) {} }
    else if (p.setCurrentTime) p.setCurrentTime(Math.max(0, t)).catch(function(){});
  }

  // playStartLoop: loop from seg.start for min(3, seg.dur) seconds on existing player
  function playStartLoop() {
    scrubShield.style.display = 'none';
    readInputs();
    var seg = segs[activeSegIdx];
    var loopDur = Math.min(3, seg.dur);
    var p = getEditorPlayer();
    // (zip0131) If user paused with Space, respect that — just seek to the
    // new start without restarting playback. Lets fine-adjustment arrows
    // tweak position while staying paused.
    if (p && p._salPaused) {
      try {
        if (typeof p.seekTo === 'function') p.seekTo(seg.start, true);
        else if (typeof p.setCurrentTime === 'function') p.setCurrentTime(seg.start);
      } catch (_) {}
      return;
    }
    if (p) {
      // Use existing player — no remount, no "More Videos" flash
      resumeLoop(p, seg.start, loopDur);
    } else {
      _mountEditorPlayer(seg.start, loopDur, seg.start, true, onTotalDurKnown);
    }
  }

  // playEndLoop: loop 3s before end of segment on existing player
  function playEndLoop() {
    scrubShield.style.display = 'none';
    readInputs();
    var seg = segs[activeSegIdx];
    var previewStart = Math.max(seg.start, seg.start + seg.dur - 3);
    var previewDur   = seg.start + seg.dur - previewStart;
    var p = getEditorPlayer();
    // (zip0131) Respect paused state — see playStartLoop comment.
    if (p && p._salPaused) {
      try {
        if (typeof p.seekTo === 'function') p.seekTo(previewStart, true);
        else if (typeof p.setCurrentTime === 'function') p.setCurrentTime(previewStart);
      } catch (_) {}
      return;
    }
    if (p) {
      resumeLoop(p, previewStart, previewDur);
    } else {
      _mountEditorPlayer(previewStart, previewDur, previewStart, true, onTotalDurKnown);
    }
  }

  // ── Single Loop Segment button ────────────────────────────────────────────
  document.getElementById('v2-ls').addEventListener('pointerdown', function(e) {
    e.preventDefault();
    readInputs();
    mountLoop();  // loops entire active segment
  });

  // ── Start carets: pause, seek ±0.1s, update number ──────────────────────
  document.getElementById('vs-frame').addEventListener('pointerdown', function(e) {
    e.preventDefault();
    suspendLoop();
    segs[activeSegIdx].start = fmt2(Math.max(0, segs[activeSegIdx].start - FRAME_SEC));
    iStart.value = segs[activeSegIdx].start;
    updateSegData();
    editorSeekFreeze(segs[activeSegIdx].start);
  });
  document.getElementById('vs+frame').addEventListener('pointerdown', function(e) {
    e.preventDefault();
    suspendLoop();
    segs[activeSegIdx].start = fmt2(segs[activeSegIdx].start + FRAME_SEC);
    iStart.value = segs[activeSegIdx].start;
    updateSegData();
    editorSeekFreeze(segs[activeSegIdx].start);
  });

  // -5 -1 0 +1 +5: adjust start, play from new start for min(3, dur) then loop
  var startDeltas = { 'vs---': -5, 'vs--': -1, 'vs-0': 0, 'vs++': 1, 'vs+++': 5 };
  Object.keys(startDeltas).forEach(function(id) {
    document.getElementById(id).addEventListener('pointerdown', function(e) {
      e.preventDefault();
      var delta = startDeltas[id];
      if (delta !== 0) {
        segs[activeSegIdx].start = fmt(Math.max(0, segs[activeSegIdx].start + delta));
        iStart.value = segs[activeSegIdx].start;
        updateSegData();
      }
      playStartLoop();
    });
  });

  // ── Duration carets: pause, adjust ±0.1s, seek near new end ─────────────
  document.getElementById('vd-frame').addEventListener('pointerdown', function(e) {
    e.preventDefault();
    suspendLoop();
    segs[activeSegIdx].dur = fmt2(Math.max(0.1, segs[activeSegIdx].dur - FRAME_SEC));
    iDur.value = segs[activeSegIdx].dur;
    updateSegData();
    editorSeekFreeze(Math.max(segs[activeSegIdx].start,
      segs[activeSegIdx].start + segs[activeSegIdx].dur - 0.1));
  });
  document.getElementById('vd+frame').addEventListener('pointerdown', function(e) {
    e.preventDefault();
    suspendLoop();
    segs[activeSegIdx].dur = fmt2(segs[activeSegIdx].dur + FRAME_SEC);
    iDur.value = segs[activeSegIdx].dur;
    updateSegData();
    editorSeekFreeze(Math.max(segs[activeSegIdx].start,
      segs[activeSegIdx].start + segs[activeSegIdx].dur - 0.1));
  });

  // -5 -1 0 +1 +5: adjust duration, play from 3s before new end, loop
  var durDeltas = { 'vd---': -5, 'vd--': -1, 'vd-0': 0, 'vd++': 1, 'vd+++': 5 };
  Object.keys(durDeltas).forEach(function(id) {
    document.getElementById(id).addEventListener('pointerdown', function(e) {
      e.preventDefault();
      var delta = durDeltas[id];
      if (delta !== 0) {
        segs[activeSegIdx].dur = fmt(Math.max(0.1, segs[activeSegIdx].dur + delta));
        iDur.value = segs[activeSegIdx].dur;
        updateSegData();
      }
      playEndLoop();
    });
  });

  // Input field changes
  iStart.addEventListener('change', function() { readInputs(); scheduleMount('start'); });
  iDur.addEventListener('change',   function() { readInputs(); scheduleMount('end');   });
  // Speed slider — wired below alongside bottom bar sync
  
  // Selected/Full toggle
  iToggle.addEventListener('click', function() {
    veSelectedMode = !veSelectedMode;
    iToggle.textContent = veSelectedMode ? '● Sel' : '● Full';
    iToggle.style.background = veSelectedMode ? 'rgba(80,0,80,0.3)' : 'rgba(0,80,80,0.3)';
    if (veSelectedMode) {
      // Resume segment looping
      mountLoop();
    } else {
      // Stop segment looping, let video play freely
      suspendLoop();
      var p = getEditorPlayer();
      if (p && typeof p.playVideo === 'function') p.playVideo();
    }
  });

  // ── Add / delete segment ──────────────────────────────────────────────────
  document.getElementById('v2addseg').addEventListener('click', function() {
    var last = segs.length ? segs[segs.length - 1] : { start: 0, dur: 0 };
    var newStart = fmt(last.start + last.dur + 2);
    var remaining3 = totalVideoDur ? Math.max(0, totalVideoDur - newStart) : 9999;
    var newDur3 = remaining3 >= 5 ? 5 : remaining3 >= 1 ? 1 : 5;
    segs.push({ start: newStart, dur: newDur3 });
    setActiveSeg(segs.length - 1);
  });
  document.getElementById('v2delseg').addEventListener('click', function() {
    if (!segs.length) return;
    segs.splice(activeSegIdx, 1);
    setActiveSeg(Math.min(activeSegIdx, segs.length - 1));
  });

  // ── Timeline click + drag scrubbing ──────────────────────────────────────
  // Plain drag: scrub through video, stay paused on release
  // Band click (no ctrl): switch active segment and start looping it
  // Ctrl+click empty area: add segment
  // Ctrl+click band: delete segment
  var isDraggingScrub = false;
  var scrubClickedBand = false; // true if pointerdown landed on a band

  function getEditorPlayer() {
    return window.seeLearnVideoPlayers['v2host'] || null;
  }

  // Suspend the loop interval (don't destroy player)
  function suspendLoop() {
    if (window.seeLearnVideoTimers['v2host']) {
      clearInterval(window.seeLearnVideoTimers['v2host']);
      delete window.seeLearnVideoTimers['v2host'];
    }
  }

  // Resume loop for the active segment on the existing player
  function resumeLoop(p, segStart, segDur) {
    suspendLoop();
    var endT = segStart + segDur;
    if (!p) return;
    if (typeof p.playVideo === 'function') {
      try { p._salPaused = false; p.seekTo(segStart, true); p.playVideo(); } catch(ex) {}
      window.seeLearnVideoTimers['v2host'] = setInterval(function() {
        try {
          if (p._salPaused) return;
          var t = p.getCurrentTime();
          // UPPER-BOUND ONLY — no lower-bound snap
          if (t >= endT - 0.2) {
            p.seekTo(segStart, true); p.playVideo();
          }
        } catch(ex) {}
      }, 100);
    } else if (typeof p.play === 'function') {
      p._salPaused = false;
      p.setCurrentTime(segStart).catch(function(){});
      p.play().catch(function(){});
      window.seeLearnVideoTimers['v2host'] = setInterval(function() {
        p.getCurrentTime().then(function(t) {
          if (p._salPaused) return;
          // UPPER-BOUND ONLY — no lower-bound snap
          if (t >= endT - 0.2) {
            p.setCurrentTime(segStart); p.play();
          }
        }).catch(function(){});
      }, 100);
    }
  }

  // Resume playing from current position — no seek to start.
  // Only checks upper bound so it loops when the segment ends.
  // No lower-bound check — if paused before segStart (e.g. after caret adjustment),
  // just play from there without snapping back to segment start.
  function resumeFromCurrent(p, segStart, segDur) {
    suspendLoop();
    var endT = segStart + segDur;
    if (!p) return;
    if (typeof p.playVideo === 'function') {
      try { p._salPaused = false; p.playVideo(); } catch(ex) {}
      window.seeLearnVideoTimers['v2host'] = setInterval(function() {
        try {
          if (p._salPaused) return;
          var t = p.getCurrentTime();
          if (t >= endT - 0.2) {
            p.seekTo(segStart, true); p.playVideo();
          }
        } catch(ex) {}
      }, 100);
    } else if (typeof p.play === 'function') {
      p._salPaused = false;
      p.play().catch(function(){});
      window.seeLearnVideoTimers['v2host'] = setInterval(function() {
        p.getCurrentTime().then(function(t) {
          if (p._salPaused) return;
          if (t >= endT - 0.2) {
            p.setCurrentTime(segStart); p.play();
          }
        }).catch(function(){});
      }, 100);
    }
  }


  function timelineSecFromEvent(e) {
    var rect = timeline.getBoundingClientRect();
    var x    = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    return (x / rect.width) * calcEnd();
  }

  // ── Scrub shield: covers only the VIDEO HOST area, not the right panel ──────
  // This blocks YouTube iframe pointer events (hover triggers "More videos" UI)
  // without blocking the right-panel buttons.
  var scrubShield = document.createElement('div');
  scrubShield.style.cssText = 'position:absolute;inset:0;z-index:200000;display:none;'
    + 'background:transparent;cursor:crosshair;pointer-events:auto;';
  // Append to host div (not overlay) so it only covers the video, not the panel
  host.appendChild(scrubShield);

  // scrubToSec: mirrors VideoShow's fsSeek exactly.
  // Just seek — no pause, no suspendLoop, no player state changes.
  // Pausing is what triggers YouTube's "More videos" UI.
  function scrubToSec(sec) {
    var maxSec = totalVideoDur > 2 ? totalVideoDur - 1 : calcEnd();
    var clamped = Math.max(0, Math.min(sec, Math.min(calcEnd(), maxSec)));
    renderTimeline(clamped);
    tCur.textContent = clamped.toFixed(1) + 's';
    var p = getEditorPlayer();
    if (!p) return;
    if (typeof p.seekTo === 'function') {
      try { p.seekTo(clamped, !window.keyframeOnly); } catch(ex) {}
    } else if (p.setCurrentTime) {
      p.setCurrentTime(clamped).catch(function(){});
    }
  }

  var scrubResumeTimerV2 = null;

  timeline.addEventListener('pointerdown', function(e) {
    if (e.ctrlKey) return;
    if (scrubClickedBand) { scrubClickedBand = false; return; }
    e.preventDefault();
    isDraggingScrub = true;
    scrubShield.style.display = 'block';
    if (scrubResumeTimerV2) { clearTimeout(scrubResumeTimerV2); scrubResumeTimerV2 = null; }
    timeline.setPointerCapture(e.pointerId);
    suspendLoop();
    // Pause the player so the seeked frame shows (not just a moving blur)
    var _ep = getEditorPlayer();
    if (_ep) {
      _ep._salPaused = true;
      if (typeof _ep.pauseVideo === 'function') { try { _ep.pauseVideo(); } catch(_ex) {} }
      else if (_ep.pause) { _ep.pause().catch(function(){}); }
    }
    scrubToSec(timelineSecFromEvent(e));
  });

  timeline.addEventListener('pointermove', function(e) {
    if (!isDraggingScrub) return;
    scrubToSec(timelineSecFromEvent(e));
  });

  timeline.addEventListener('pointerup', function(e) {
    if (!isDraggingScrub) return;
    isDraggingScrub = false;
    scrubShield.style.display = 'none';
    var releaseSec = timelineSecFromEvent(e);
    scrubToSec(releaseSec);

    // Check if release point is inside any segment band
    var insideSeg = -1;
    segs.forEach(function(s, i) {
      if (releaseSec >= s.start && releaseSec < s.start + s.dur) insideSeg = i;
    });

    var p = getEditorPlayer();
    if (!p) return;

    // (zip0132) If user explicitly Space-paused, just seek to the release
    // point and stay paused. Don't auto-resume play. _salUserPaused is set
    // by index.html's Space handler and cleared only by the next Space
    // (or by an explicit play action). Without this guard, every click on
    // the timeline would override the user's pause and resume play.
    if (p._salUserPaused) {
      try {
        if (typeof p.seekTo === 'function') p.seekTo(releaseSec, true);
        else if (typeof p.setCurrentTime === 'function') p.setCurrentTime(releaseSec);
      } catch(_) {}
      // Update active segment pointer (without auto-playing it) if click
      // landed in one — keeps the rest of the UI consistent.
      if (insideSeg >= 0) setActiveSeg(insideSeg);
      return;
    }

    if (insideSeg >= 0) {
      // Released inside a segment → loop that segment from release point
      setActiveSeg(insideSeg);
      // resumeFromCurrent: plays from current position, loops at seg end
      var seg = segs[insideSeg];
      resumeFromCurrent(p, seg.start, seg.dur);
    } else {
      // Released outside all segments → free-play from this position, no loop
      suspendLoop();
      p._salPaused = false;
      if (typeof p.playVideo === 'function') {
        try { p.seekTo(releaseSec, true); p.playVideo(); } catch(ex) {}
      } else if (p.play) {
        p.setCurrentTime(releaseSec).catch(function(){});
        p.play().catch(function(){});
      }
    }
  });

  timeline.addEventListener('pointercancel', function() {
    isDraggingScrub = false;
    scrubShield.style.display = 'none';
  });

  timeline.addEventListener('click', function(e) {
    if (!e.ctrlKey) return;
    var W = timeline.offsetWidth || 600;
    var clickSec = (e.offsetX / W) * calcEnd();
    var hitIdx = -1;
    segs.forEach(function(s, i) {
      if (clickSec >= s.start && clickSec <= s.start + s.dur) hitIdx = i;
    });
    if (hitIdx < 0) {
      var remaining2 = totalVideoDur ? Math.max(0, totalVideoDur - fmt(clickSec)) : 9999;
      var newDur2 = remaining2 >= 5 ? 5 : remaining2 >= 1 ? 1 : 5;
      segs.push({ start: fmt(clickSec), dur: newDur2 });
      setActiveSeg(segs.length - 1);
    }
  });

  // ── Editor playback: always loops ONLY the active segment ─────────────────
  // mountLoop: mount player looping just the active segment (start change)
  function mountLoop() {
    if (!segs.length) return; // nothing to loop until first segment is defined
    clearTimeout(mountDebounce);
    currentMute = iMute.checked;
    readInputs();
    var seg  = segs[activeSegIdx];
    _mountEditorPlayer(seg.start, seg.dur, seg.start, true, onTotalDurKnown);
  }

  // mountEndPreview: seek to 2s before end of active segment and loop
  function mountEndPreview() {
    clearTimeout(mountDebounce);
    currentMute = iMute.checked;
    readInputs();
    var seg     = segs[activeSegIdx];
    var preview = Math.max(seg.start, seg.start + seg.dur - 2);
    _mountEditorPlayer(seg.start, seg.dur, preview, true, onTotalDurKnown);
  }

  // seekAndPause: seek to specific time but don't loop — show that frame only
  function seekAndPause(seekSec) {
    clearTimeout(mountDebounce);
    currentMute = iMute.checked;
    readInputs();
    var seg = segs[activeSegIdx];
    _mountEditorPlayer(seg.start, seg.dur, seekSec, false, null);
  }

  // Low-level: mount the editor player.
  // loopSeg=true → normal looped segment playback (start..start+dur then repeat)
  // loopSeg=false → seek to seekSec, play briefly then pause
  function _mountEditorPlayer(segStart, segDur, seekSec, loopSeg, onDurationReady) {
    window.stopCellVideoLoop('v2host');
    host.innerHTML = '';

    if (window.isYouTubeLink(it.link)) {
      _mountYTEditor(segStart, segDur, seekSec, loopSeg, onDurationReady);
    } else if (window.isVimeoLink(it.link)) {
      _mountVimeoEditor(segStart, segDur, seekSec, loopSeg, onDurationReady);
    }
  }

  async function _mountYTEditor(segStart, segDur, seekSec, loopSeg, onDurationReady) {
    var vid = getYouTubeId(it.link);
    if (!vid) return;
    await loadYouTubeApiOnce();
    host.innerHTML = '';
    var div = document.createElement('div');
    div.id = 'v2host_yt';
    // Allow pointer-events so YouTube overlay X button is clickable
    div.style.cssText = 'width:100%;height:100%;pointer-events:auto;';
    host.appendChild(div);
    var endT  = segStart + segDur;
    var paused = false;

    // (zip0124) Respect ytPrivacy setting; see _ytHost computation in
    // mountYouTubeClip (top of this file). Recomputed here so live setting
    // changes take effect for editor sessions opened later.
    var _ytPrivacy2 = (typeof window.getSetting === 'function')
      ? window.getSetting('ytPrivacy') : null;
    var _ytHost2 = _ytPrivacy2 === 'nocookie'
      ? 'https://www.youtube-nocookie.com'
      : 'https://www.youtube.com';

    var player = new YT.Player('v2host_yt', {
      videoId: vid,
      host: _ytHost2,
      playerVars: {
        autoplay: 1, controls: 0, disablekb: 1, fs: 0, rel: 0,
        modestbranding: 1, playsinline: 1, start: Math.floor(seekSec),
        iv_load_policy: 3, endscreen: 0, cc_load_policy: 0,
        origin: window.location.origin || window.location.hostname || 'localhost'
      },
      events: {
        onReady: function(ev) {
          if (currentMute) ev.target.mute(); else ev.target.unMute();
          ev.target.seekTo(seekSec, true);
          ev.target.playVideo();
          ev.target._salPaused = false;
          if (onDurationReady) {
            try {
              var d = ev.target.getDuration();
              if (d > 0) onDurationReady(d);
            } catch(ex) {}
          }
          if (!loopSeg) {
            setTimeout(function() {
              try { ev.target.pauseVideo(); ev.target._salPaused = true; paused = true; } catch(ex) {}
            }, 1500);
          }
        },
        onStateChange: function(ev) {
          if (paused || ev.target._salPaused) return;
          if (loopSeg && ev.data === YT.PlayerState.ENDED) {
            ev.target.seekTo(segStart, true); ev.target.playVideo();
          }
        }
      }
    });

    if (loopSeg) {
      window.seeLearnVideoTimers['v2host'] = setInterval(function() {
        try {
          if (paused || player._salPaused) return;
          var t = player.getCurrentTime();
          var seg = segs[activeSegIdx];
          var endT2 = seg.start + seg.dur;
          // UPPER-BOUND ONLY — removing lower-bound prevents snap-to-start on spacebar resume
          if (t >= endT2 - 0.2) {
            player.seekTo(seg.start, true); player.playVideo();
          }
        } catch(ex) {}
      }, 100);
    }
    window.seeLearnVideoPlayers['v2host'] = player;
  }

  async function _mountVimeoEditor(segStart, segDur, seekSec, loopSeg, onDurationReady) {
    await loadVimeoApiOnce();
    host.innerHTML = '';
    var div = document.createElement('div');
    div.style.cssText = 'width:100%;height:100%;position:absolute;top:0;left:0;pointer-events:none;';
    host.appendChild(div);
    var endT   = segStart + segDur;
    var paused = false;

    var player = new Vimeo.Player(div, {
      url: it.link, autoplay: true, muted: currentMute,
      controls: false, loop: false, autopause: false, transparent: false, background: false
    });

    player.ready().then(function() {
      var iframe = div.querySelector('iframe');
      if (iframe) { iframe.style.width = '100%'; iframe.style.height = '100%'; }
      if (currentMute) player.setVolume(0); else player.setVolume(1);
      player.setCurrentTime(seekSec);
      player.play();
      if (onDurationReady) {
        player.getDuration().then(function(d) { if (d > 0) onDurationReady(d); }).catch(function(){});
      }
      if (!loopSeg) {
        setTimeout(function() { player.pause().catch(function(){}); paused = true; }, 1500);
      }
      if (loopSeg) {
        window.seeLearnVideoTimers['v2host'] = setInterval(function() {
          if (paused) return;
          player.getCurrentTime().then(function(t) {
            var seg = segs[activeSegIdx];
            var endT2 = seg.start + seg.dur;
            // UPPER-BOUND ONLY
            if (t >= endT2 - 0.2) {
              player.setCurrentTime(seg.start); player.play();
            }
          }).catch(function(){});
        }, 100);
      }
    });

    player.on('ended', function() {
      if (!paused && loopSeg) { player.setCurrentTime(segStart); player.play(); }
    });

    window.seeLearnVideoPlayers['v2host'] = player;
  }

  // ── Debounced mount ───────────────────────────────────────────────────────
  var mountDebounce;
  var pendingMountType = 'start';
  function scheduleMount(type) {
    pendingMountType = type || 'start';
    clearTimeout(mountDebounce);
    mountDebounce = setTimeout(function() {
      if (pendingMountType === 'end') mountEndPreview();
      else mountLoop();
    }, 500);
  }

  // ── Scrubber position polling ─────────────────────────────────────────────
  var scrubTimer = setInterval(function() {
    var p = window.seeLearnVideoPlayers['v2host'];
    if (!p) return;
    if (typeof p.getCurrentTime === 'function') {
      var t = p.getCurrentTime();
      if (t && typeof t.then === 'function') t.then(function(v) { if (v !== null) renderTimeline(v); });
      else if (typeof t === 'number' && t > 0) renderTimeline(t);
    }
  }, 300);

  // ── Save / Close ──────────────────────────────────────────────────────────
  function closeEditor() {
    clearInterval(scrubTimer);
    clearTimeout(mountDebounce);
    window.stopCellVideoLoop('v2host');
    if (window.menuWrap) window.menuWrap.style.display = '';  // restore HM
    overlay.remove();
    document.removeEventListener('keydown', handleKey, true);
  }

  function saveEditor() {
    readInputs();
    var newVidRange   = window.serializeSegments(segs);
    var newVidComment = segs.map(function(s) { return s.comment || ''; }).join(', ');
    var newMute       = iMute.checked ? '1' : '0';

    // Update it (the linksData object reference) directly
    it.VidRange   = newVidRange;
    it.VidComment = newVidComment;
    it.Mute       = newMute;

    // CRITICAL: scrubUnderscores() in saveData() reassigns linksData to a NEW array,
    // orphaning the 'it' reference. So we must find the entry by index in linksData
    // and update it there BEFORE anything reassigns linksData.
    var idx = linksData ? linksData.indexOf(it) : -1;
    if (idx === -1 && linksData) {
      // Fallback: find by link+cell identity
      idx = linksData.findIndex(function(r) {
        return r.link === it.link && r.cell === it.cell;
      });
    }
    if (idx !== -1 && linksData) {
      linksData[idx].VidRange   = newVidRange;
      linksData[idx].VidComment = newVidComment;
      linksData[idx].Mute       = newMute;
    }

    // Also update Tabulator row so syncTab() doesn't overwrite
    if (window._salTab) {
      try {
        var rows = window._salTab.getRows();
        for (var ri = 0; ri < rows.length; ri++) {
          var rd = rows[ri].getData();
          if (rd.link === it.link && rd.cell === it.cell) {
            rows[ri].update({ VidRange: newVidRange, VidComment: newVidComment, Mute: newMute });
            break;
          }
        }
      } catch(ex) {}
    }

    // Write directly to localStorage (skipSync=true avoids syncTab overwriting,
    // and we've already updated linksData[idx] above before any reassignment)
    if (window.saveData) {
      window.saveData(true);
    } else {
      var s = JSON.stringify(linksData);
      localStorage.setItem('seeandlearn-links', s);
      localStorage.setItem('sal-edited', Date.now().toString());
    }
    closeEditor();
    if (window.renderTableEditor && document.getElementById('tableEditor'))
      window.renderTableEditor();
    if (window.renderGrid) window.renderGrid();
  }

  document.getElementById('v2save').addEventListener('click',  saveEditor);
  document.getElementById('v2close').addEventListener('click', closeEditor);

  // ── Re-order segments by start time, preserving comment alignment ─────────
  document.getElementById('v2reorder').addEventListener('click', function() {
    if (segs.length < 2) return;  // nothing to reorder
    // Sort by start time
    var sorted = segs.slice().sort(function(a, b) { return a.start - b.start; });
    // Check if already ordered
    var changed = sorted.some(function(s, i) { return s !== segs[i]; });
    if (!changed) { return; }  // already in order, nothing to do
    segs.splice(0, segs.length);
    sorted.forEach(function(s) { segs.push(s); });
    activeSegIdx = 0;
    iStart.value = segs[0].start;
    iDur.value   = segs[0].dur;
    updateSegData();
    renderSegTabs();
    mountLoop();
  });

  // Shared download helper — appends to overlay (not body) to avoid z-index issues
  function downloadText(filename, content) {
    var blob = new Blob([content], {type:'text/plain'});
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.style.display = 'none';
    overlay.appendChild(a);
    a.click();
    setTimeout(function() { overlay.removeChild(a); URL.revokeObjectURL(a.href); }, 1000);
  }

  // Sanitize cname for use in filenames
  function safeFilename(s) {
    return (s || 'video').replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_').slice(0, 40);
  }

  // ── ffmpeg Windows .bat — frame-accurate (re-encode) + concat, all in one file ──
  document.getElementById('v2ffmpeg').addEventListener('click', function() {
    if (!segs.length) return;
    var cname = safeFilename(it.cname || it.cell || 'video');
    var ytMatch = it.link.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    var inputFile = ytMatch ? (ytMatch[1] + '.mp4') : 'input.mp4';
    var outputFile = cname + '_merged.mp4';
    var concatFile = 'concat_' + cname + '.txt';

    var bat = [];
    bat.push('@echo off');
    bat.push('setlocal');
    bat.push('rem ─── ffmpeg frame-accurate segment merge ───');
    bat.push('rem cname:  ' + (it.cname || ''));
    bat.push('rem source: ' + inputFile + '   (place in same folder as this .bat)');
    bat.push('rem output: ' + outputFile);
    bat.push('rem Uses -c:v libx264 -crf 18 for frame-accurate cuts (re-encode, high quality)');
    bat.push('');
    bat.push('set INPUT=' + inputFile);
    bat.push('set OUTPUT=' + outputFile);
    bat.push('');

    // Step 1: extract each segment (frame-accurate via re-encode)
    var tempFiles = [];
    segs.forEach(function(seg, i) {
      var end = parseFloat((seg.start + seg.dur).toFixed(3));
      var tmp = cname + '_seg' + String(i+1).padStart(2,'0') + '.mp4';
      var label = seg.comment ? '  rem ' + seg.comment : '';
      tempFiles.push(tmp);
      bat.push('echo Extracting segment ' + (i+1) + ' of ' + segs.length +
        (seg.comment ? ' (' + seg.comment + ')' : '') + '...');
      bat.push('ffmpeg -y -ss ' + seg.start + ' -to ' + end +
        ' -i "%INPUT%" -c:v libx264 -crf 18 -c:a aac "' + tmp + '"' + label);
    });

    bat.push('');
    bat.push('echo Writing concat list...');
    bat.push('(');
    tempFiles.forEach(function(f) { bat.push("  echo file '" + f + "'"); });
    bat.push(') > "' + concatFile + '"');

    bat.push('');
    bat.push('echo Joining segments...');
    bat.push('ffmpeg -y -f concat -safe 0 -i "' + concatFile + '" -c copy "%OUTPUT%"');

    bat.push('');
    bat.push('echo Cleaning up...');
    bat.push('del "' + concatFile + '"');
    tempFiles.forEach(function(f) { bat.push('del "' + f + '"'); });

    bat.push('');
    bat.push('echo.');
    bat.push('echo Done: %OUTPUT%');
    bat.push('pause');
    bat.push('endlocal');

    downloadText(cname + '.bat', bat.join('\r\n'));
  });

  // ── LosslessCut .llc project file ─────────────────────────────────────────
  document.getElementById('v2llc').addEventListener('click', function() {
    if (!segs.length) return;
    var cname = safeFilename(it.cname || it.cell || 'video');
    var ytMatch = it.link.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    var mediaFile = ytMatch ? (ytMatch[1] + '.mp4') : (cname + '.mp4');

    // JSON5 format that LosslessCut expects
    var lines = [];
    lines.push('{');
    lines.push('  version: 1,');
    lines.push('  mediaFileName: "' + mediaFile + '",');
    lines.push('  cutSegments: [');
    segs.forEach(function(seg, i) {
      var end = parseFloat((seg.start + seg.dur).toFixed(6));
      var name = (seg.comment || '').replace(/"/g, '\\"');
      var comma = (i < segs.length - 1) ? ',' : '';
      lines.push('    {');
      lines.push('      start: ' + seg.start + ',');
      lines.push('      end: ' + end + ',');
      lines.push('      name: "' + name + '",');
      lines.push('    }' + comma);
    });
    lines.push('  ],');
    lines.push('}');

    downloadText(cname + '.llc', lines.join('\n'));
  });

  // Caption toggle for VideoEdit
  var ccOnEdit = false;
  function applyCCState() {
    var on = ccOnEdit;
    var btn = document.getElementById('v2b-cc');
    if (btn) {
      btn.style.background = on ? 'rgba(0,100,0,0.5)' : 'rgba(0,60,0,0.3)';
      btn.style.color = on ? '#4f8' : '#8a8';
      btn.style.borderColor = on ? '#4f8' : '#8a8';
    }
    var p = getEditorPlayer();
    if (!p) return;
    if (typeof p.loadModule === 'function') {
      try {
        if (on) { p.loadModule('captions'); p.setOption('captions','track',{languageCode:'en'}); }
        else p.unloadModule('captions');
      } catch(ex) {}
    } else if (p.enableTextTrack) {
      try {
        if (on) p.enableTextTrack('en').catch(function(){});
        else p.disableTextTrack().catch(function(){});
      } catch(ex) {}
    }
  }
  var bcc = document.getElementById('v2b-cc');
  if (bcc) bcc.addEventListener('click', function() { ccOnEdit = !ccOnEdit; applyCCState(); });

  // Bottom mute button — mirrors the top checkbox.
  // (zip0132) Apply mute directly to the live player via mute()/unMute()
  // (YT) or setMuted()/setVolume() (Vimeo). The previous implementation
  // remounted the player on every M press, which caused a flash and didn't
  // always actually change audio (because the new player's onReady handler
  // ran asynchronously and could be racing with browser autoplay policies).
  // Direct calls take effect immediately.
  var bMute = document.getElementById('v2b-mute');
  var bRowMute = document.getElementById('v2b-rowmute');  // (zip0151)
  function applyMuteToLivePlayer() {
    var p = getEditorPlayer();
    if (!p) return false;
    try {
      if (currentMute) {
        if (typeof p.mute === 'function') p.mute();
        else if (typeof p.setMuted === 'function') p.setMuted(true);
        else if (typeof p.setVolume === 'function') p.setVolume(0);
      } else {
        if (typeof p.unMute === 'function') p.unMute();
        else if (typeof p.setMuted === 'function') p.setMuted(false);
        else if (typeof p.setVolume === 'function') p.setVolume(1);
      }
      return true;
    } catch (_) { return false; }
  }
  function refreshMuteButtonStyle() {
    if (!bMute) return;
    // (zip0143) SVG icon (helper defined in index.html). Falls back to
    // emoji on the unlikely chance the helper is missing.
    bMute.innerHTML = window.muteIconHTML
      ? window.muteIconHTML(!!currentMute)
      : (currentMute ? '🔇' : '🔊');
    bMute.style.borderColor = currentMute ? '#f88' : '#888';
    bMute.style.color = currentMute ? '#f88' : '#ccc';
  }
  // (zip0151) Refresh the row-mute preference button's text + styling
  // from iMute.checked (the source of truth for the saved Mute field).
  function refreshRowMuteButton() {
    if (!bRowMute) return;
    var muted = iMute.checked;
    bRowMute.textContent = muted ? 'Currently Muted' : 'Currently Unmuted';
    bRowMute.style.borderColor = muted ? '#f88' : '#fa8';
    bRowMute.style.color       = muted ? '#f88' : '#fa8';
    bRowMute.style.background  = muted ? 'rgba(80,0,0,0.3)' : 'rgba(80,40,0,0.35)';
  }
  if (bMute) {
    refreshMuteButtonStyle();
    bMute.addEventListener('click', function() {
      // (zip0151) M button is now PLAYBACK-only. It used to also write
      // to iMute.checked which got saved as row.Mute — that conflated
      // two distinct concepts (current playback audio vs the row's
      // saved auto-mute preference). The new "Currently Unmuted/Muted"
      // button (bRowMute) is the row-preference toggle. M only flips
      // the live audio for this editing session.
      currentMute = !currentMute;
      refreshMuteButtonStyle();
      // Try direct call first; fall back to remount only if no live player.
      if (!applyMuteToLivePlayer()) mountLoop();
    });
  }
  // (zip0151) Currently Unmuted/Muted button — toggles the row's
  // permanent Mute preference. iMute is the hidden checkbox that
  // saveEditor() reads, so we flip it and dispatch 'change' so the
  // existing change listener handles persistence + auto-save.
  if (bRowMute) {
    refreshRowMuteButton();
    bRowMute.addEventListener('click', function() {
      iMute.checked = !iMute.checked;
      refreshRowMuteButton();
      // Fire iMute's change handler so the editor's save pipeline runs.
      try {
        var ev = new Event('change', { bubbles: true });
        iMute.dispatchEvent(ev);
      } catch (_) {}
    });
  }
  // (zip0151) iMute change still drives playback (legacy callers may
  // still toggle the hidden checkbox). It also refreshes both buttons
  // to stay in sync. NOTE: change to iMute now ONLY affects current
  // playback if the user wants — to update saved row.Mute they go
  // through saveEditor as before.
  iMute.addEventListener('change', function() {
    currentMute = iMute.checked;
    refreshMuteButtonStyle();
    refreshRowMuteButton();
    if (!applyMuteToLivePlayer()) mountLoop();
  });

  // Speed slider (single binding — top slider was removed in zip0116)
  if (iSpeed) {
    iSpeed.addEventListener('input', function() {
      var spd = parseFloat(iSpeed.value);
      if (iSpeedVal) iSpeedVal.textContent = spd + 'x';
      var p = getEditorPlayer();
      if (p && typeof p.setPlaybackRate === 'function') p.setPlaybackRate(spd);
    });
  }
  host.addEventListener('click', function(e) {
    if (!e.ctrlKey) return;
    e.preventDefault(); e.stopPropagation();
    var p = getEditorPlayer();
    function insertAtTime(t) {
      var insertSec = fmt(Math.max(0, t));
      // Smart duration: 5s if ≥5s of video remains, else 1s, else use remaining
      var remaining = totalVideoDur ? Math.max(0, totalVideoDur - insertSec) : 9999;
      var insertDur = remaining >= 5 ? 5 : remaining >= 1 ? 1 : 5;
      segs.push({ start: insertSec, dur: insertDur });
      setActiveSeg(segs.length - 1);
      vrPrev.textContent = 'New seg at ' + insertSec + 's — ' + window.serializeSegments(segs);
    }
    if (p && typeof p.getCurrentTime === 'function') {
      var t = p.getCurrentTime();
      if (t && typeof t.then === 'function') t.then(function(v) { insertAtTime(v || 0); });
      else insertAtTime(typeof t === 'number' ? t : 0);
    } else if (p && p.getCurrentTime) {
      p.getCurrentTime().then(function(v) { insertAtTime(v || 0); }).catch(function() { insertAtTime(0); });
    } else {
      // No player ready — insert after last segment
      var last = segs[segs.length - 1];
      insertAtTime(last.start + last.dur + 2);
    }
  });

  // (zip0131/0132) Double-click = two-press segment creation.
  //
  // Workflow: pause with Space, scrub or click to find rough start, double-
  // click; scrub or click to find rough end, double-click again. The new
  // segment is added and becomes active.
  //
  // Where you double-click determines what time is captured:
  //   - On the TIMELINE (bottom strip): the X position at the click
  //   - On the VIDEO HOST: the player's current playback time
  //
  // State (_pendingSegStart) is per-E-session; closing E discards an
  // incomplete pending start. A toast after the first press tells the
  // user the system is waiting.
  var _pendingSegStart = null;

  function recordDblclickTime(t) {
    var sec = fmt(Math.max(0, t));
    if (_pendingSegStart === null) {
      _pendingSegStart = sec;
      if (window.toast) window.toast(
        'Segment start: ' + sec + 's\n'
        + 'Position to end, double-click again.',
        3500
      );
    } else {
      var startSec = _pendingSegStart;
      var endSec   = sec;
      _pendingSegStart = null;
      if (endSec === startSec) {
        if (window.toast) window.toast('Start and end are the same — segment cancelled.', 2000);
        return;
      }
      var segStart = Math.min(startSec, endSec);
      var segDur   = Math.abs(endSec - startSec);
      segs.push({ start: fmt(segStart), dur: fmt(segDur) });
      setActiveSeg(segs.length - 1);
      vrPrev.textContent = 'New seg ' + segStart + 's + ' + segDur + 's — ' + window.serializeSegments(segs);
      if (window.toast) window.toast(
        '✓ Segment created: ' + fmt(segStart) + 's + ' + fmt(segDur) + 's',
        2000
      );
    }
  }

  // Host dblclick: use current playback time.
  host.addEventListener('dblclick', function(e) {
    if (e.target.closest && e.target.closest('button, input, select, textarea')) return;
    e.preventDefault(); e.stopPropagation();
    var p = getEditorPlayer();
    if (p && typeof p.getCurrentTime === 'function') {
      var t = p.getCurrentTime();
      if (t && typeof t.then === 'function') t.then(function(v) { recordDblclickTime(v || 0); });
      else recordDblclickTime(typeof t === 'number' ? t : 0);
    } else if (p && p.getCurrentTime) {
      p.getCurrentTime().then(function(v) { recordDblclickTime(v || 0); }).catch(function() { recordDblclickTime(0); });
    } else {
      recordDblclickTime(0);
    }
  });

  // Timeline dblclick: use the time at the X position.
  timeline.addEventListener('dblclick', function(e) {
    e.preventDefault(); e.stopPropagation();
    recordDblclickTime(timelineSecFromEvent(e));
  });

  // ── Keyboard ──────────────────────────────────────────────────────────────
  function handleKey(e) {
    // Never intercept keys when focus is in an input or textarea
    var isInp = document.activeElement &&
      (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');

    if (e.ctrlKey && e.key.toLowerCase() === 's') {
      // If mini comment editor is open, let it handle ^S (its listener saves+closes the popup)
      if (document.getElementById('v2comment-popup')) return;
      e.preventDefault(); e.stopPropagation(); saveEditor(); return;
    }
    
    // T = save and return to Table (with or without Alt)
    if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.metaKey && !isInp) {
      e.preventDefault(); e.stopPropagation();
      saveEditor();
      closeEditor();
      window._cameFromGrid = false;
      if (window.buildTable) window.buildTable();
      return;
    }
    
    // G = save and return to Grid (with or without Alt)
    if ((e.key === 'g' || e.key === 'G') && !e.ctrlKey && !e.metaKey && !isInp) {
      e.preventDefault(); e.stopPropagation();
      saveEditor();
      closeEditor();
      if (window.buildTable) window.buildTable();
      if (window.gridShow) window.gridShow();
      return;
    }
    
    if (e.key === 'Escape') {
      // If mini comment editor is open, close just that
      var commentPop = document.getElementById('v2comment-popup');
      if (commentPop) { commentPop.remove(); return; }
      closeEditor();
      // Return to grid if came from grid
      if (window._cameFromGrid) {
        window._cameFromGrid = false;
        if (window.buildTable) window.buildTable();
        if (window.gridShow) window.gridShow();
      }
      return;
    }
    if ((e.key === ' ' || e.key === 'Spacebar') && !isInp) {
      e.preventDefault(); e.stopPropagation();
      var p = getEditorPlayer();
      if (!p) return;
      if (p._salPaused) {
        // Resume — loop interval is still running (just skipping due to _salPaused flag)
        scrubShield.style.display = 'none';
        p._salPaused = false;
        if (typeof p.playVideo === 'function') { try { p.playVideo(); } catch(ex) {} }
        else if (p.play) p.play().catch(function(){});
      } else {
        // Pause: mark paused flag (interval already checks this and skips),
        // do NOT call suspendLoop() so the loop timer is preserved for resume
        p._salPaused = true;
        scrubShield.style.display = 'block';
        if (typeof p.pauseVideo === 'function') {
          try { p.pauseVideo(); } catch(ex) {}
        } else if (p.pause) {
          p.pause().catch(function(){});
        }
      }
      return;
    }
    if (e.key === 'Tab' && !isInp) {
      e.preventDefault(); e.stopPropagation();
      setActiveSeg((activeSegIdx + 1) % segs.length); return;
    }

    // ── ArrowUp / ArrowDown: navigate visible T-table rows ─────────────────
    // (zip0131) When index.html's veKeyHandler is active, ArrowUp/ArrowDown
    // are now handled there as N/J aliases (so they share the same
    // filter-aware _brRows walking logic). This handler short-circuits in
    // that case to avoid double-handling. Falls back to the legacy
    // sortedIdx-only walk when there's no veKeyHandler (shouldn't happen in
    // current builds but kept for safety).
    var k = e.key;
    if ((k === 'ArrowUp' || k === 'ArrowDown') && !isInp) {
      // Defer to index.html's handler if present — it's filter-aware.
      if (window._veActiveKeyHandler) return;

      e.preventDefault(); e.stopPropagation();
      var dir = (k === 'ArrowDown') ? 1 : -1;
      var ld  = window.linksData || [];
      if (!ld.length) return;

      // Resolve current row's data-index by identity, fallback to link+cell
      var curDi = ld.indexOf(it);
      if (curDi === -1) {
        curDi = ld.findIndex(function(r) {
          return r && r.link === it.link && r.cell === it.cell;
        });
      }
      if (curDi === -1) return;

      // Map data-index → visible index
      var si = window.sortedIdx;
      var visLen = si ? si.length : ld.length;
      function diToVi(di) {
        if (!si) return di;
        return si.indexOf(di);
      }
      function viToDi(vi) {
        return window.vr ? window.vr(vi) : vi;
      }

      // Use stashed walk-position if we've been stepping past non-video rows
      // in the same direction on the same source row; else start from current.
      var startVi;
      if (window._eArrowWalk &&
          window._eArrowWalk.sourceDi === curDi &&
          window._eArrowWalk.dir === dir) {
        startVi = window._eArrowWalk.lastVi;
      } else {
        startVi = diToVi(curDi);
        if (startVi === -1) return;
        window._eArrowWalk = { sourceDi: curDi, dir: dir, lastVi: startVi };
      }

      var nextVi = startVi + dir;
      while (nextVi >= 0 && nextVi < visLen) {
        var nextDi = viToDi(nextVi);
        var nextRow = ld[nextDi];
        if (!nextRow) { nextVi += dir; continue; }
        if (window.isVideoRow && window.isVideoRow(nextRow)) {
          // Found next video row → hop into E on it
          window._eArrowWalk = null;
          saveEditor();
          closeEditor();
          setTimeout(function() {
            window.openVideoEditor(nextRow);
          }, 30);
          return;
        }
        // Non-video: toast link (truncated) and advance walk position
        window._eArrowWalk.lastVi = nextVi;
        var link = String(nextRow.link || '').trim();
        var shown = link ? (link.length > 60 ? link.slice(0, 57) + '...' : link) : '(no link)';
        if (window.toast) window.toast('Not video: ' + shown, 1800);
        return;
      }

      // Reached top/bottom
      window._eArrowWalk = null;
      if (window.toast) window.toast(dir > 0 ? 'No more rows below' : 'No more rows above', 1500);
      return;
    }
  }
  document.addEventListener('keydown', handleKey, true);

  // ── Initial render ────────────────────────────────────────────────────────
  if (segs.length === 0) {
    // No segments yet — mount video in free-play from start, show guidance
    iStart.value = '';
    iDur.value   = '';
    renderSegTabs();
    renderTimeline();
    vrPrev.textContent = 'No segments — Ctrl+click video or timeline to define first segment';
    // Mount and free-play (no loop, no pause — use resumeLoop with huge bound)
    _mountEditorPlayer(0, 0, 0, false, onTotalDurKnown);
    // After player is ready, play freely (override the 1.5s pause that loopSeg=false triggers)
    setTimeout(function() {
      var p = getEditorPlayer();
      if (p) {
        p._salPaused = false;
        if (typeof p.playVideo === 'function') { try { p.playVideo(); } catch(ex) {} }
        else if (p.play) p.play().catch(function(){});
        // No loop interval — video just plays until end or spacebar
      }
    }, 2000);
  } else {
    iStart.value = segs[0].start;
    iDur.value   = segs[0].dur;
    renderSegTabs();
    renderTimeline();
    mountLoop();   // start looping the first segment
  }
};
