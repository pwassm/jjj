// ══════════════════════════════════════════════════════════════════════════════
// TURN CELLS  (dev0836 / rewired dev0837)  —  Grid fun mode: T for TURNAROUND
// ══════════════════════════════════════════════════════════════════════════════
//
// REACHED AS A FUN-MODE CHOICE, NOT ON ITS OWN KEY: f opens fun mode, then t.
// dev0836 gave it bare t over the grid, which cost the constantly-used t→Table;
// dev0837 hands that back and claims t only while fun mode is on.
//
// Filed under "fun" with the waterfall / ring / fly family, but it is really
// the INSTRUCTIVE one: a cell you click turns over on its long midline and shows
// what the picture is ABOUT — the row's tag chips in the top half, the first five
// lines of its ftext below. Click again and it turns back to the front, resuming
// the video from exactly where it stopped.
//
// THE AXIS IS THE LONG MIDLINE, so the turn always looks like a card being flipped
// the natural way round: a LANDSCAPE cell (w >= h) spins about its HORIZONTAL
// midline (rotateX — top goes away from you), a PORTRAIT cell about its VERTICAL
// one (rotateY). Measured per cell at click time, so mixed layouts (17 / 19, the
// portrait grids) each get the right axis.
//
// HOW IT TURNS WITHOUT preserve-3d (and therefore without touching the media):
//   A .grid-cell is  overflow:hidden , which per spec forces transform-style back
//   to FLAT — so the usual two-faces-in-one-box trick (front + back, backface-
//   visibility:hidden) cannot work here, and making it work would mean re-wrapping
//   the cell's children. Re-parenting an iframe RELOADS it, which would throw the
//   video back to zero — the one thing this mode must not do.
//   So the turn is done in two halves on the CELL ITSELF:
//       0deg -> 90deg    the front rotates away and goes edge-on (invisible)
//       -90deg -> 0deg   ...continuing the same way round, back panel now shown
//   The jump from +90 to -90 happens while the cell is edge-on, so it is not
//   visible, and finishing at 0 means the back panel is never mirrored. Nothing
//   is ever re-parented: the front children are only  visibility:hidden , and the
//   back panel is a sibling appended to the same cell.
//
// SPEED: the box that floats under cell 5c holds a number 1-20 (default 5) and the
// turn takes  2 / n  seconds — so 1 is the slowest at two full seconds, the default
// 5 gives 0.4s, and 20 whips round in 100ms. (dev0838 doubled this from 1/n: at
// 1/n the default was a 200ms turn, too quick to read as a rotation at all.)
// Remembered in localStorage for the next visit.
//
// ──────────────────────────────────────────────────────────────────────────────
// CUT-OUT INSTRUCTIONS — to remove the feature entirely, with zero grid impact:
//   1. delete this file
//   2. delete  'turncells.js'  from the files[] array in index.html
//   3. in collection.js, drop the TurnCells line from _gmStopAll, the T row from
//      _gmFunPanelHtml, the 't' branch of _gmChoiceKey, and _gmTurnOn
//   4. in core.js, drop 't' from the  k === 'w' || k === 't'  grid block in the
//      window-capture keydown handler (leaving w = waterfall)
// Nothing else references it.
// ──────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── Tunables ────────────────────────────────────────────────────────────────
  var SPEED_KEY = 'salTurnSpeed';
  var SPEED_MIN = 1, SPEED_MAX = 20, SPEED_DEF = 5;
  var FTEXT_LINES = 5;                            // "first 5 lines of ftext"
  // (dev0837) Gentler than the first cut. The turn should read as ONE continuous
  // rotation over its whole duration — more and more edge-on — so each half only
  // mildly accelerates / decelerates instead of sitting still and then whipping.
  var EASE_OUT = 'cubic-bezier(.35,0,.75,.4)';    // front leaving  — mild accelerate
  var EASE_IN  = 'cubic-bezier(.25,.6,.65,1)';    // back arriving  — mild decelerate
  var PANEL_BG    = '#14161c';   // the back face
  var BACKDROP_BG = '#0e0f12';   // the black-grey the turn happens against
  // (dev0838) THE VEIL IS SHADING, NOT A FADE-OUT. dev0837 ran it at 0.9 over the
  // whole outgoing half with the same curve as the rotation, and the result read as
  // "the picture fades out" — not "the picture turns": opacity is far more
  // noticeable than a shallow foreshortening, so by the time the cell had visibly
  // rotated at all the photo was already half gone.
  // So it now behaves like a face turning away from a light — nothing for the first
  // third, then shading in steeply as the card actually goes edge-on, and never all
  // the way to black. VEIL_HOLD is the fraction of the half it waits.
  var VEIL_MAX  = 0.72;
  var VEIL_HOLD = 0.38;
  var VEIL_EASE = 'cubic-bezier(.65,0,.9,.45)';   // flat, then steep

  // ── State ───────────────────────────────────────────────────────────────────
  var active = false;
  var wired  = false;              // capture pointerdown listener attached once
  var speed  = SPEED_DEF;          // 1-20; a turn lasts 1/speed seconds
  var turned = new Map();          // cell el -> { axis, back, hidden[], timer, busy }

  // ── Small helpers ───────────────────────────────────────────────────────────
  function container() { return document.getElementById('gridContainer'); }
  function gridOpen() {
    var o = document.getElementById('gridOverlay');
    var f = document.getElementById('gridFullscreen');
    return !!o && o.style.display === 'flex' && !(f && f.style.display === 'flex');
  }
  function say(m, d) { if (typeof window.toast === 'function') window.toast(m, d || 1500); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function clampSpeed(v) {
    v = parseInt(v, 10);
    if (!isFinite(v)) v = SPEED_DEF;
    return Math.max(SPEED_MIN, Math.min(SPEED_MAX, v));
  }
  function loadSpeed() {
    var v = SPEED_DEF;
    try { v = parseInt(localStorage.getItem(SPEED_KEY), 10); } catch (_) {}
    return clampSpeed(v);
  }
  function saveSpeed(v) {
    speed = clampSpeed(v);
    try { localStorage.setItem(SPEED_KEY, String(speed)); } catch (_) {}
    return speed;
  }
  // (dev0838) A WHOLE TURN IS 2/speed SECONDS, not 1/speed. At the default 5 the
  // old rule gave a 200ms turn — 100ms per half — which is below the threshold at
  // which a rotation reads as a rotation at all, and was the other half of the
  // "it just fades" complaint. Doubled: 5 → 0.4s, 1 → a full 2s, 20 → 0.1s.
  function turnDur() { return 2 / speed; }
  function halfDur() { return turnDur() / 2; }

  // ── The back face ───────────────────────────────────────────────────────────
  // First N "lines" of ftext = the text of its first N leaf block elements, which
  // is what a reader would call a line of a slide. Parsed with DOMParser so the
  // document is inert — no <img> in the ftext ever hits the network for this.
  var BLOCK_SEL = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,dd,dt,figcaption,td,div,section';

  function ftextLines(html, n) {
    var out = [];
    if (!html) return out;
    try {
      var doc = new DOMParser().parseFromString(String(html), 'text/html');
      var blocks = doc.body ? doc.body.querySelectorAll(BLOCK_SEL) : [];
      for (var i = 0; i < blocks.length && out.length < n; i++) {
        var el = blocks[i];
        if (el.querySelector(BLOCK_SEL)) continue;        // wrapper — take the leaf
        var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) out.push(t);
      }
      if (!out.length && doc.body) {
        var whole = (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
        if (whole) out.push(whole);
      }
    } catch (_) {
      var plain = String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (plain) out.push(plain);
    }
    return out.slice(0, n);
  }

  function chipsFor(row) {
    try {
      if (row && window.tagsLib && typeof window.tagsLib.renderChipsForRecord === 'function')
        return window.tagsLib.renderChipsForRecord(row) || '';
    } catch (_) {}
    return '';
  }

  // ── Chip sizing ─────────────────────────────────────────────────────────────
  // (dev0838) ONE CHIP PER LINE, AND THE LONGEST ONE SPANS THE CARD. tagsLib's
  // chipHtml bakes a fixed 11px and pixel padding into every chip's inline style,
  // which on a grid cell is either lost or comical depending on the layout — and it
  // wraps chips inline, so a long binomial and a three-letter tag shared a row.
  //
  // So each chip is re-dressed as its own line whose metrics are all in em, and the
  // ONE font size for the whole card is solved from two constraints:
  //   width   the widest chip should just reach both edges of the card
  //   height  all of them have to fit, stacked, inside the top half
  // and the smaller of the two wins. Same size on every chip of a card, by
  // construction — it is set once, on their parent, and they inherit it.
  //
  // Called AFTER the panel is in the DOM. Measurement uses scrollWidth /
  // clientWidth, which are layout values: the cell is edge-on under a rotate at
  // that moment, and a getBoundingClientRect would come back foreshortened to
  // nothing, but layout metrics do not care about transforms.
  var CHIP_BASE = 11;                  // the size chipHtml bakes in — our yardstick
  var CHIP_MIN = 6, CHIP_MAX = 46;

  function fitTagChips(top) {
    if (!top) return;
    var chips = top.querySelectorAll('.tag-chip');
    if (!chips.length) return;
    // Re-dress first: em metrics, own line, and no inline size to fight the parent.
    top.style.fontSize = CHIP_BASE + 'px';
    chips.forEach(function (c) {
      c.style.fontSize = '';                    // inherit the one size from `top`
      c.style.display = 'flex';                 // a flex-column item = its own line
      c.style.padding = '0.1em 0.5em';
      c.style.borderRadius = '1em';
      c.style.margin = '0.09em 0';
      c.style.maxWidth = '100%';
      c.style.borderWidth = '1px';
    });
    var avail = top.clientWidth;
    if (!avail) return;                         // not laid out — leave the base size
    var widest = 0;
    chips.forEach(function (c) { if (c.scrollWidth > widest) widest = c.scrollWidth; });
    if (!widest) return;
    // Chip width is very nearly linear in font size (text + em padding), so one
    // pass gets there; no need to iterate.
    var byWidth  = CHIP_BASE * (avail / widest);
    // 1.45 line-height + 0.2em padding + 0.18em margin ≈ 1.83em per stacked line.
    var byHeight = top.clientHeight / (chips.length * 1.83);
    var size = Math.max(CHIP_MIN, Math.min(CHIP_MAX, Math.min(byWidth, byHeight)));
    top.style.fontSize = size.toFixed(2) + 'px';
  }

  function buildBack(cell, row) {
    var r = cell.getBoundingClientRect();
    // Scale the type to the cell — a 27-cell portrait grid is a third the height
    // of a 2x2 tile, and a fixed 13px would fill it with two words.
    var fs = Math.max(9, Math.min(16, Math.round(r.height / 26)));
    var pad = Math.max(5, Math.round(fs * 0.6));

    var chips = chipsFor(row);
    var lines = ftextLines(row && row.ftext, FTEXT_LINES);
    var title = row ? [row.t1, row.n1].filter(Boolean).join(' · ') : '';

    var back = document.createElement('div');
    back.className = 'turn-back';
    back.style.cssText = 'position:absolute;inset:0;z-index:140;overflow:hidden;'
      + 'background:' + PANEL_BG + ';color:#e9e9f0;box-sizing:border-box;padding:' + pad + 'px;'
      + 'display:flex;flex-direction:column;'
      + 'font:' + fs + 'px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;';

    // Nothing to teach with — say so rather than showing an empty card.
    if (!chips && !lines.length) {
      back.style.alignItems = 'center';
      back.style.justifyContent = 'center';
      back.style.textAlign = 'center';
      back.innerHTML = '<div style="opacity:.75;">' + esc(title || 'Untagged') + '</div>'
        + '<div style="opacity:.4;font-size:' + Math.max(8, fs - 2) + 'px;margin-top:4px;">'
        + 'nothing tagged or written for this one yet</div>';
      return back;
    }

    // TOP HALF — the tag chips, ONE PER LINE. Sized by fitTagChips() once the panel
    // is in the DOM and can be measured; see the note there.
    var top = document.createElement('div');
    top.className = 'turn-back-tags';
    top.style.cssText = 'flex:0 0 50%;min-height:0;overflow:hidden;'
      + 'display:flex;flex-direction:column;align-items:flex-start;'
      + 'border-bottom:1px solid rgba(255,255,255,.14);'
      + 'padding-bottom:' + Math.round(pad / 2) + 'px;margin-bottom:' + Math.round(pad / 2) + 'px;';
    top.innerHTML = chips || '<span style="opacity:.35;font-style:italic;">no tags yet</span>';
    back.appendChild(top);

    // BOTTOM — the first 5 lines of ftext, clamped to 5 RENDERED lines as well so
    // one long paragraph can't run past the fold either.
    var bot = document.createElement('div');
    bot.className = 'turn-back-text';
    bot.style.cssText = 'flex:1 1 auto;min-height:0;overflow:hidden;'
      + 'display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:' + FTEXT_LINES + ';';
    bot.innerHTML = lines.length
      ? lines.map(function (l) { return esc(l); }).join('<br>')
      : '<span style="opacity:.35;font-style:italic;">' + esc(title || 'no text yet') + '</span>';
    back.appendChild(bot);

    return back;
  }

  // ── Media: hold the frame, then carry on from it ────────────────────────────
  // Same flags gridToggleAllPause / gridTogglePauseCell use, so the segment-loop
  // timers (which check _gridPaused / _salPaused every tick) simply idle rather
  // than being torn down — that is what makes "resume where it left off" work for
  // a looping YT/Vimeo cell as well as for a plain <video>.
  function setPlaying(cell, play) {
    var cs = cell.dataset ? cell.dataset.cell : '';
    var p = (window.seeLearnVideoPlayers || {})['grid-vid-' + cs];
    if (p) {
      try {
        p._gridPaused = !play;
        p._salPaused  = !play;
        if (play) {
          if (typeof p.playVideo === 'function') p.playVideo();
          else if (typeof p.play === 'function') p.play();
        } else {
          if (typeof p.pauseVideo === 'function') p.pauseVideo();
          else if (typeof p.pause === 'function') p.pause();
        }
      } catch (_) {}
    }
    // Raw <video> children (disk clips, step frames) have no registered player.
    cell.querySelectorAll('video').forEach(function (v) {
      try {
        if (play) { if (v._turnWasPlaying) v.play && v.play().catch(function () {}); }
        else { v._turnWasPlaying = !v.paused; v.pause(); }
      } catch (_) {}
    });
  }

  // ── The turn itself ─────────────────────────────────────────────────────────
  function axisFor(cell) {
    var r = cell.getBoundingClientRect();
    // Long midline: landscape -> horizontal axis (X); portrait -> vertical (Y).
    return (r.width >= r.height) ? 'X' : 'Y';
  }
  function persp(cell) {
    var r = cell.getBoundingClientRect();
    return Math.max(600, Math.round(Math.max(r.width, r.height) * 2));
  }
  function tf(cell, axis, deg) {
    return 'perspective(' + persp(cell) + 'px) rotate' + axis + '(' + deg + 'deg)';
  }

  // ── The black-grey the turn is seen against ─────────────────────────────────
  // (dev0837) A cell rotating about its midline foreshortens INSIDE its own slot,
  // uncovering whatever sits behind it — which is #gridContainer's own colour
  // (#1a1a2e, a blue-grey) and, at the moment it goes edge-on, effectively the
  // page. Laying a dark panel over exactly that footprint for the duration of the
  // turn means the card is always seen going edge-on against black-grey instead.
  //
  // Absolutely positioned INSIDE the container, not on <body>: the container is
  // position:absolute, so an out-of-flow child is not a grid item and is placed
  // against its padding box — and it stays in the container's stacking context,
  // where the z-index it shares with the turning cell actually means something.
  function addBackdrop(cell, box) {
    var cont = container(); if (!cont || !box) return null;
    var bd = document.createElement('div');
    bd.className = 'turn-backdrop';
    bd.style.cssText = 'position:absolute;pointer-events:none;z-index:299;'
      + 'background:' + BACKDROP_BG + ';'
      + 'left:' + box.x + 'px;top:' + box.y + 'px;'
      + 'width:' + box.w + 'px;height:' + box.h + 'px;';
    cont.appendChild(bd);
    return bd;
  }
  // The cell's resting box, in container coordinates. Measured while the cell has
  // no transform — a rotated rect is the foreshortened one, which is useless here.
  function homeBox(cell) {
    var cont = container(); if (!cont) return null;
    var cr = cont.getBoundingClientRect();
    var br = cell.getBoundingClientRect();
    return { x: br.left - cr.left, y: br.top - cr.top, w: br.width, h: br.height };
  }
  function dropEl(el) { if (el && el.parentNode) el.remove(); }

  // ── The veil that takes the picture down to black-grey as it turns away ──────
  // (dev0837) THE ASYMMETRY THE VEIL FIXES: turning text→picture, the face that
  // rotates away is ALREADY a dark grey panel, so it reads as a card turning in
  // dark space and the picture then arrives out of that dark. Turning
  // picture→text, the face that rotates away is a bright photo or a playing
  // video, so it did not read as the same movement at all — it stayed bright to
  // the last degree and the text simply appeared.
  //
  // So on the outgoing half only, a panel of exactly the back face's colour fades
  // in over the media in step with the rotation: the picture is seen more and more
  // edge-on AND darker, and by the time it is edge-on it already IS the colour the
  // text arrives on. The incoming half is deliberately left alone — a picture
  // coming back to full brightness as it flattens is the half that already worked.
  function addVeil(cell) {
    var v = document.createElement('div');
    v.className = 'turn-veil';
    // Above the media (z:1) and above .grid-interactor (z:100) so the cell label
    // and info line dim with the picture; below the back face (z:140).
    v.style.cssText = 'position:absolute;inset:0;z-index:130;pointer-events:none;'
      + 'background:' + PANEL_BG + ';opacity:0;';
    cell.appendChild(v);
    return v;
  }

  function hideFront(cell, back) {
    var hidden = [];
    Array.prototype.slice.call(cell.children).forEach(function (ch) {
      if (ch === back) return;
      hidden.push([ch, ch.style.visibility]);
      ch.style.visibility = 'hidden';
    });
    return hidden;
  }
  function showFront(hidden) {
    (hidden || []).forEach(function (pair) {
      if (pair[0]) pair[0].style.visibility = pair[1] || '';
    });
  }

  function settle(cell, st) {
    cell.style.transition = '';
    cell.style.zIndex     = '';
    if (st && st.flipped) {
      cell.style.transform = tf(cell, st.axis, 0);
    } else {
      cell.style.transform = '';
      cell.style.willChange = '';
    }
  }

  // Front -> back. Half one takes the picture edge-on; half two brings the card in.
  function turnToBack(cell) {
    var row = cell._rowData;
    var axis = axisFor(cell);
    var half = halfDur();
    var box = homeBox(cell);                                // measure BEFORE rotating
    var st = { axis: axis, box: box, back: null, veil: null, backdrop: null,
               hidden: null, timer: null, busy: true, flipped: false };
    turned.set(cell, st);

    st.backdrop = addBackdrop(cell, box);
    st.veil = addVeil(cell);

    cell.style.willChange = 'transform';
    cell.style.zIndex = '300';
    cell.style.transition = 'none';
    cell.style.transform = tf(cell, axis, 0);
    void cell.offsetWidth;                                  // commit the start pose
    cell.style.transition = 'transform ' + half + 's ' + EASE_OUT;
    cell.style.transform = tf(cell, axis, 90);
    // Held flat for the first VEIL_HOLD of the half — the stretch where the turn
    // itself has to be legible — then shaded in over what is left of it.
    st.veil.style.transition = 'opacity ' + (half * (1 - VEIL_HOLD)).toFixed(3) + 's '
      + VEIL_EASE + ' ' + (half * VEIL_HOLD).toFixed(3) + 's';
    st.veil.style.opacity = String(VEIL_MAX);

    st.timer = setTimeout(function () {
      if (!cell.isConnected) { restore(cell, st); turned.delete(cell); return; }
      setPlaying(cell, false);                              // hold the frame
      // The veil has done its job — the media is about to be hidden anyway, and
      // leaving it would only sit under the back face costing a composite.
      dropEl(st.veil); st.veil = null;
      var back = buildBack(cell, row);
      cell.appendChild(back);
      fitTagChips(back.querySelector('.turn-back-tags'));   // needs to be in the DOM
      st.back = back;
      st.hidden = hideFront(cell, back);
      st.flipped = true;
      // Edge-on at +90 and at -90 look identical, so this jump is invisible — and
      // landing on 0 (rather than 180) means the back is never mirrored.
      cell.style.transition = 'none';
      cell.style.transform = tf(cell, axis, -90);
      void cell.offsetWidth;
      cell.style.transition = 'transform ' + half + 's ' + EASE_IN;
      cell.style.transform = tf(cell, axis, 0);
      st.timer = setTimeout(function () {
        st.busy = false; st.timer = null;
        dropEl(st.backdrop); st.backdrop = null;   // resting flat — nothing to hide
        if (cell.isConnected) settle(cell, st);
      }, half * 1000 + 30);
    }, half * 1000 + 10);
  }

  // Back -> front, the same way round in reverse, so it visibly unwinds.
  function turnToFront(cell) {
    var st = turned.get(cell);
    if (!st) return;
    var axis = st.axis, half = halfDur();
    st.busy = true;

    // The box was measured on the way out; re-measure only if the grid has since
    // been resized under us.
    if (!st.box) st.box = homeBox(cell);
    st.backdrop = addBackdrop(cell, st.box);

    cell.style.willChange = 'transform';
    cell.style.zIndex = '300';
    cell.style.transition = 'none';
    cell.style.transform = tf(cell, axis, 0);
    void cell.offsetWidth;
    cell.style.transition = 'transform ' + half + 's ' + EASE_OUT;
    cell.style.transform = tf(cell, axis, -90);

    st.timer = setTimeout(function () {
      if (!cell.isConnected) { restore(cell, st); turned.delete(cell); return; }
      dropEl(st.back);
      showFront(st.hidden);
      st.back = null; st.hidden = null; st.flipped = false;
      setPlaying(cell, true);                               // carry on from the held frame
      // No veil on this half, deliberately: the picture coming back to full
      // brightness as it flattens is the half that already read correctly.
      cell.style.transition = 'none';
      cell.style.transform = tf(cell, axis, 90);
      void cell.offsetWidth;
      cell.style.transition = 'transform ' + half + 's ' + EASE_IN;
      cell.style.transform = tf(cell, axis, 0);
      st.timer = setTimeout(function () {
        dropEl(st.backdrop); st.backdrop = null;
        turned.delete(cell);
        if (cell.isConnected) settle(cell, null);
      }, half * 1000 + 30);
    }, half * 1000 + 10);
  }

  function toggleCell(cell) {
    var st = turned.get(cell);
    if (st && st.busy) return;                              // mid-turn — let it land
    if (st && st.flipped) turnToFront(cell);
    else if (!st) turnToBack(cell);
  }

  // Snap a cell back to its front with no animation (mode off / grid closing).
  function restore(cell, st) {
    if (st && st.timer) clearTimeout(st.timer);
    if (st) {
      dropEl(st.back);     st.back = null;
      dropEl(st.veil);     st.veil = null;
      dropEl(st.backdrop); st.backdrop = null;
      showFront(st.hidden);
      if (st.flipped) setPlaying(cell, true);
      st.flipped = false;
    }
    cell.style.transition = 'none';
    cell.style.transform = '';
    cell.style.zIndex = '';
    cell.style.willChange = '';
    requestAnimationFrame(function () { if (cell.isConnected) cell.style.transition = ''; });
  }
  function restoreAll() {
    turned.forEach(function (st, cell) { restore(cell, st); });
    turned.clear();
  }

  // ── Clicks ──────────────────────────────────────────────────────────────────
  // Capture phase on the container — eats the tap before .grid-interactor's own
  // pointerdown (play/pause, hold-to-cut, swipe). Plain left button / touch only,
  // so Shift-zoom, Alt-COI, Ctrl+click and the right-click menu are untouched.
  function onPointerDown(e) {
    if (!active) return;
    if (e.button !== undefined && e.button !== 0) return;
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target && e.target.closest && e.target.closest('#turnSpeedBox')) return;
    var cont = container();
    var cell = e.target && e.target.closest ? e.target.closest('.grid-cell') : null;
    if (!cell || !cont || !cont.contains(cell)) return;
    e.preventDefault();
    e.stopPropagation();
    toggleCell(cell);
  }
  function ensureWired() {
    if (wired) return;
    var cont = container(); if (!cont) return;
    cont.addEventListener('pointerdown', onPointerDown, true);
    wired = true;
  }

  // ── The speed box, floating under cell 5c ───────────────────────────────────
  // Fixed-positioned on <body> rather than appended to #gridContainer: the
  // container IS the CSS grid, so a child of it would be auto-placed as a cell.
  // (dev0837) BOX_LIFT clears the fun-mode ✕ button, which is centred on the same
  // spot (collection.js _gmExitBtnPosition). Stacked rather than side by side: on a
  // narrow window a 5x5 cell is barely wider than this box, so there is no room
  // beside it — but always room above.
  var BOX_LIFT = 38;

  function positionBox(box) {
    var cont = container(); if (!cont || !box) return;
    var anchor = cont.querySelector('.grid-cell[data-cell="5c"]') || cont;
    var r = anchor.getBoundingClientRect();
    box.style.left = Math.round(r.left + r.width / 2) + 'px';
    box.style.top  = Math.round(r.bottom - 8 - BOX_LIFT) + 'px';
  }
  function boxReposition() { positionBox(document.getElementById('turnSpeedBox')); }

  function boxRead() {
    var el = document.getElementById('turnSpeedRead');
    if (el) el.textContent = '= ' + turnDur().toFixed(2) + 's per turn';
  }

  function boxShow() {
    var box = document.getElementById('turnSpeedBox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'turnSpeedBox';
      box.style.cssText = 'position:fixed;z-index:100002;transform:translate(-50%,-100%);'
        + 'background:rgba(16,16,18,0.94);color:#eee;border:1px solid rgba(255,255,255,0.18);'
        + 'border-radius:10px;padding:6px 10px;display:flex;align-items:center;gap:8px;'
        + 'font:12px/1.3 system-ui,-apple-system,Segoe UI,sans-serif;'
        + 'box-shadow:0 6px 22px rgba(0,0,0,0.6);';
      box.innerHTML = '<span style="opacity:.7;">&#8635; spin</span>'
        + '<input id="turnSpeedInput" type="number" min="' + SPEED_MIN + '" max="' + SPEED_MAX + '" step="1" '
        + 'style="width:52px;padding:3px 5px;background:#0e0e11;color:#fff;border:1px solid #444;'
        + 'border-radius:6px;font:13px/1.2 monospace;text-align:center;">'
        + '<span id="turnSpeedRead" style="opacity:.5;white-space:nowrap;"></span>';
      document.body.appendChild(box);
      var inp = box.querySelector('#turnSpeedInput');
      // Commit on every keystroke; the next turn uses the new value.
      inp.addEventListener('input', function () {
        var v = parseInt(inp.value, 10);
        if (!isFinite(v)) return;                            // mid-typing — leave it
        saveSpeed(v);
        boxRead();
      });
      inp.addEventListener('change', function () {
        inp.value = String(saveSpeed(inp.value));
        boxRead();
      });
      // Enter / Esc hand the keyboard back to the grid.
      inp.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === 'Escape') { ev.stopPropagation(); inp.blur(); }
      });
      window.addEventListener('resize', boxReposition);
    }
    box.querySelector('#turnSpeedInput').value = String(speed);
    boxRead();
    positionBox(box);
    return box;
  }

  function boxClose() {
    var box = document.getElementById('turnSpeedBox');
    if (box) box.remove();
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  function start() {
    if (!gridOpen()) return false;
    // The 16F fold grid drives cell.style.transform / transformOrigin itself to
    // fold the paper — two owners of one transform, and it already has its own
    // idea of a back face. Refuse rather than fight it.
    try {
      if (typeof _gridCurrentLayout === 'function' && _gridCurrentLayout() === '16F') {
        say('Turnaround does not run on the 16F fold grid — that one folds instead', 2600);
        return false;
      }
    } catch (_) {}
    // A turning cell and a travelling cell fight over the same inline transform —
    // one fun mode at a time. (_gmStopAll also calls stop() here, but `active` is
    // still false at this point, so it cannot cancel the start that follows.)
    if (typeof window._gmStopAll === 'function') window._gmStopAll();
    speed = loadSpeed();
    ensureWired();
    active = true;
    boxShow();
    say('↻ Turnaround ON — click a cell to turn it over (tags + text on the back); '
      + 'click again to turn it back. ( t stops it · f leaves fun mode )', 4200);
    return true;
  }

  function stop() {
    restoreAll();
    // Belt and braces: a grid re-render mid-turn (a caption toggle, a resize) can
    // leave a backdrop or veil behind whose cell is no longer the one we tracked.
    var cont = container();
    if (cont) cont.querySelectorAll('.turn-backdrop,.turn-veil,.turn-back').forEach(dropEl);
    boxClose();
    active = false;
  }

  function toggle() {
    if (active) { stop(); say('■ Turnaround OFF', 1200); return false; }
    return start();
  }

  window.TurnCells = {
    start: start,
    stop: stop,
    toggle: toggle,
    get active() { return active; },
    get speed() { return speed; },
    setSpeed: function (v) { saveSpeed(v); if (active) boxShow(); return speed; }
  };
})();
