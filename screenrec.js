// ══════════════════════════════════════════════════════════════════════════════
// screenrec.js — Ctrl+.  FULL-SCREEN RECORDER  (dev0723)
//
// One key, from any screen: Ctrl+. starts recording the whole screen (mouse
// pointer included, no sound) and Ctrl+. again stops it and saves
//   Downloads/ScreenRecording_<YYYYMMDD-HHMMSS>.mp4
// Before it starts it puts the app in full-window (browser fullscreen) if it
// isn't already, so what gets recorded is the app and nothing else.
//
// TWO CAPTURE PATHS, in this order:
//
//  1. THE PROXY (preferred).  proxy.js POST /rec/start spawns ffmpeg's Windows
//     gdigrab on the desktop — no picker dialog, a real H.264 .mp4, the OS
//     cursor drawn in, and the file written straight into ~/Downloads. This is
//     the same single-recording bridge V's step recorder uses, so if that one is
//     running the proxy answers 409 and we say so rather than fighting it.
//     Needs the 'screenrec2' feature → RESTART the proxy after pulling dev0723.
//
//  2. THE BROWSER (fallback, only when the proxy is not answering).
//     getDisplayMedia + MediaRecorder. Costs a "choose what to share" dialog,
//     and mp4 depends on the browser (Chrome records video/mp4;codecs=avc1;
//     anything else falls back to .webm and the toast says so).
//     ORDER MATTERS HERE: getDisplayMedia REQUIRES the keypress's transient
//     activation and requestFullscreen CONSUMES it, so the capture is asked for
//     first and fullscreen second. Doing it the other way round throws
//     InvalidStateError. Which path we're on is decided from a probe cached at
//     load — an await before getDisplayMedia would spend the activation too.
//
// Resolution is deliberately modest: the desktop is downscaled to at most
// SR_MAX_W px wide (1920 screen → 1280×720) at SR_FPS, which keeps a few
// minutes of demo down to a few MB.
//
// Dev-mode only (see _isUserMode). A viewer on the public site pressing Ctrl+.
// and being asked to share their screen would be alarming, and the proxy path
// is origin-locked to localhost anyway.
// ══════════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const SR_PROXY = 'http://127.0.0.1:8081';
  const SR_STEM  = 'ScreenRecording';   // → ScreenRecording_20260804-153012.mp4
  const SR_MAX_W = 1280;                // "low to moderate" — 1080p desktop → 720p file
  const SR_FPS   = 20;
  const SR_CRF   = 26;                  // x264 quality knob (higher = smaller)
  const SR_BPS    = 2500000;            // browser-path bitrate, ≈ the same ballpark

  let srOn      = false;                // recording right now
  let srMode    = null;                 // 'proxy' | 'browser'
  let srName    = '';                   // filename, stamped when the recording starts
  let srProxyOk = null;                 // null = not probed yet, true/false = last answer
  let srDot     = null;
  let srStream = null, srRec = null, srChunks = null, srMime = '', srExt = 'mp4';

  function srToast(msg, ms) {
    if (typeof toast === 'function') toast(msg, ms || 2400);
    else console.log('[screenrec] ' + msg);
  }

  // Same shape the proxy stamps its own files with (LOCAL time, not UTC).
  function srStamp() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
           '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  // ── The recording dot ────────────────────────────────────────────────────────
  // Everything on screen is in the video, so this is as small as it can be while
  // still answering "am I recording?" — a 9px pulsing dot in the top-right
  // corner. Click it to stop, same as Ctrl+.
  function srShowDot() {
    if (srDot) return;
    if (!document.getElementById('srDotCss')) {
      const st = document.createElement('style');
      st.id = 'srDotCss';
      st.textContent = '@keyframes srPulse{0%,100%{opacity:.95}50%{opacity:.3}}';
      document.head.appendChild(st);
    }
    const d = document.createElement('div');
    d.id = 'salRecDot';
    d.title = 'Recording the screen — click (or Ctrl+.) to stop and save';
    d.style.cssText = 'position:fixed;top:6px;right:6px;width:9px;height:9px;' +
      'border-radius:50%;background:#f22;box-shadow:0 0 4px rgba(0,0,0,.6);' +
      'cursor:pointer;z-index:2147483647;animation:srPulse 1.4s ease-in-out infinite;';
    d.onclick = () => srToggle();
    document.body.appendChild(d);
    srDot = d;
  }
  function srHideDot() {
    if (srDot && srDot.parentNode) srDot.parentNode.removeChild(srDot);
    srDot = null;
  }

  // Already full-window? Two ways to be, and only one of them is visible to the
  // Fullscreen API: F11 (the browser's own fullscreen) reports NO
  // fullscreenElement, so measuring the viewport against the screen is the only
  // way to see it. Getting this right matters because of the dev0708 lesson in
  // boot.js — API fullscreen hands Esc to the browser, and Esc is this app's
  // main navigation key. If the user already pressed F11 we must NOT stack API
  // fullscreen on top and re-introduce that fight. Browser zoom skews the
  // comparison; either way it errs toward leaving the user's window alone.
  function srIsFullWindow() {
    if (document.fullscreenElement) return true;
    try {
      return !!window.screen
          && window.innerHeight >= window.screen.height - 4
          && window.innerWidth  >= window.screen.width  - 4;
    } catch (_) { return false; }
  }

  // Enter fullscreen if we aren't already; never exits (stopping a recording
  // should not also throw away the window state the user was working in).
  // Fails soft — a browser that refuses just records the window as it is.
  function srGoFullscreen() {
    if (srIsFullWindow()) return;
    try {
      const el = document.documentElement;
      if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    } catch (_) {}
  }

  // ── Path 1: the proxy ────────────────────────────────────────────────────────
  function srProbeProxy() {
    return fetch(SR_PROXY + '/version', { method: 'GET', cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        srProxyOk = !!(j && Array.isArray(j.features) && j.features.includes('screenrec2'));
        return srProxyOk;
      })
      .catch(() => { srProxyOk = false; return false; });
  }

  async function srProxyStart() {
    const r = await fetch(SR_PROXY + '/rec/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fps: SR_FPS, maxWidth: SR_MAX_W, crf: SR_CRF,
                             drawMouse: true, dest: 'downloads', stem: SR_STEM })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) { const e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
    return j;
  }

  async function srProxyStop() {
    const r = await fetch(SR_PROXY + '/rec/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    return await r.json().catch(() => ({}));
  }

  // ── Path 2: the browser ──────────────────────────────────────────────────────
  function srPickMime() {
    const want = ['video/mp4;codecs=avc1.42E01E', 'video/mp4',
                  'video/webm;codecs=vp9', 'video/webm'];
    for (const m of want) {
      try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m; } catch (_) {}
    }
    return '';
  }

  // MUST be reached synchronously from the keydown — see the header note on
  // transient activation.
  function srBrowserStart() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      srToast('This browser cannot capture the screen — and the proxy (8081) isn’t answering.', 4000);
      return;
    }
    let p;
    try {
      p = navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'monitor', cursor: 'always',
                 width:  { ideal: SR_MAX_W },
                 height: { ideal: Math.round(SR_MAX_W * 9 / 16) },
                 frameRate: { ideal: SR_FPS } },
        audio: false
      });
    } catch (e) {
      srToast('Record failed: ' + (e && e.message ? e.message : e), 3000);
      return;
    }
    srGoFullscreen();
    srOn = true; srMode = 'browser'; srName = SR_STEM + '_' + srStamp();
    srShowDot();

    p.then(stream => {
      if (!srOn) { stream.getTracks().forEach(t => t.stop()); return; }  // stopped while picking
      srStream = stream;
      srChunks = [];
      srMime = srPickMime();
      srExt  = srMime.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
      try {
        srRec = new MediaRecorder(stream, srMime
          ? { mimeType: srMime, videoBitsPerSecond: SR_BPS }
          : { videoBitsPerSecond: SR_BPS });
      } catch (_) {
        srRec = new MediaRecorder(stream); srMime = srRec.mimeType || 'video/webm';
        srExt = srMime.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
      }
      srRec.ondataavailable = ev => { if (ev.data && ev.data.size) srChunks.push(ev.data); };
      srRec.onstop = srBrowserFinish;
      // Chrome's own "Stop sharing" bar ends the track behind our back.
      const vt = stream.getVideoTracks()[0];
      if (vt) vt.addEventListener('ended', () => { if (srOn) srToggle(); });
      srRec.start(1000);                       // 1s chunks — nothing is lost on a crash-stop
      srToast('● Recording the screen — Ctrl+. to stop', 1300);
    }).catch(err => {
      srOn = false; srMode = null; srHideDot();
      srToast(err && err.name === 'NotAllowedError'
        ? 'Screen recording cancelled.'
        : 'Record failed: ' + (err && err.message ? err.message : err), 2600);
    });
  }

  function srBrowserFinish() {
    const blob = new Blob(srChunks || [], { type: srMime || 'video/webm' });
    srChunks = null; srRec = null;
    if (srStream) { srStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} }); srStream = null; }
    if (!blob.size) { srToast('Recording produced no data.', 2600); return; }
    const name = srName + '.' + srExt;
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { try { URL.revokeObjectURL(url); a.remove(); } catch (_) {} }, 5000);
    srToast('✓ ' + name + ' → Downloads' + (srExt === 'webm'
      ? ' — .webm, this browser can’t record mp4' : ''), 3600);
  }

  // ── The toggle ───────────────────────────────────────────────────────────────
  async function srToggle() {
    if (srOn) {
      // ── STOP ──
      if (srMode === 'browser') {
        srOn = false; srMode = null; srHideDot();
        try { if (srRec && srRec.state !== 'inactive') srRec.stop(); else srBrowserFinish(); }
        catch (e) { srToast('Stop failed: ' + (e && e.message ? e.message : e), 3000); }
        return;
      }
      srOn = false; srMode = null; srHideDot();
      try {
        const j = await srProxyStop();
        if (j && j.output) {
          const nm  = String(j.output).split(/[\\/]/).pop();
          const dur = j.durationMs ? ' · ' + (j.durationMs / 1000).toFixed(1) + 's' : '';
          srToast('✓ Saved ' + nm + dur + ' → Downloads', 3400);
        } else {
          srToast('Recording stopped' + (j && j.error ? ': ' + j.error : '') + '.', 2600);
        }
      } catch (e) {
        srToast('Stop failed: ' + (e && e.message ? e.message : e), 3000);
      }
      return;
    }

    // ── START ──
    // Known-dead proxy → straight to the browser capture, while the keypress's
    // user activation is still live (no await may happen before that call).
    if (srProxyOk === false) { srBrowserStart(); return; }

    srGoFullscreen();
    srOn = true; srMode = 'proxy'; srName = SR_STEM + '_' + srStamp();
    srShowDot();
    try {
      const j = await srProxyStart();
      srProxyOk = true;
      if (j && j.output) srName = String(j.output).split(/[\\/]/).pop().replace(/\.mp4$/i, '');
      srToast('● Recording the screen — Ctrl+. to stop', 1300);
    } catch (e) {
      srOn = false; srMode = null; srHideDot();
      const msg = (e && e.message) ? e.message : String(e);
      if (e && e.status === 409) {       // V's step recorder owns the single slot
        srProxyOk = true;
        srToast('Already recording (V’s step recorder) — stop that one first.', 3400);
        return;
      }
      srProxyOk = false;
      srToast('Screen recorder: proxy 8081 didn’t answer (' + msg + ') — '
        + 'press Ctrl+. again to record through the browser instead.', 5000);
    }
  }

  // ── Hotkey: Ctrl+. ───────────────────────────────────────────────────────────
  // Its own window-capture listener rather than a line in core.js's dispatcher,
  // because this one has to fire from EVERY screen — including the ones core.js
  // bails out of (Xe, Ev, the slideshow, the menu) and while a text field has
  // focus, where stopping a recording still has to work.
  window.addEventListener('keydown', function (e) {
    if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (e.key !== '.' && e.code !== 'Period' && e.code !== 'NumpadDecimal') return;
    if (typeof _isUserMode === 'function' && _isUserMode()) return;   // dev only
    e.preventDefault();
    e.stopPropagation();
    srToggle();
    return false;
  }, true);

  // Leaving the page mid-record: tell the proxy to finalize (keepalive survives
  // the unload) so the mp4 still gets its moov atom and stays playable.
  window.addEventListener('beforeunload', function () {
    if (!srOn) return;
    if (srMode === 'proxy') {
      try {
        fetch(SR_PROXY + '/rec/stop', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: '{}', keepalive: true
        });
      } catch (_) {}
    } else {
      try { if (srRec && srRec.state !== 'inactive') srRec.stop(); } catch (_) {}
    }
  });

  // Probe once at load so the keypress knows which path to take without an await.
  setTimeout(() => { if (!(typeof _isUserMode === 'function' && _isUserMode())) srProbeProxy(); }, 1200);

  window.salScreenRec = {
    toggle: srToggle,
    isRecording: () => srOn,
    probe: srProbeProxy
  };
})();
