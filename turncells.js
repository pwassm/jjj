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
//   (dev0841) Both halves run the SAME easing on their own progress - commit to
//   the turn at once, ease into the end - and the handoff between them is driven
//   by the Web Animations API so there is no hole at the midpoint. Nothing is ever
//   painted over the picture. See the EASE_OUT and spin() notes: making the two
//   halves time-reverses of each other, and arming the swap with a setTimeout, are
//   what made the turn look like a fade across four reports.
//   The jump from +90 to -90 happens while the cell is edge-on, so it is not
//   visible, and finishing at 0 means the back panel is never mirrored. Nothing
//   is ever re-parented: the front children are only  visibility:hidden , and the
//   back panel is a sibling appended to the same cell.
//
// SPEED: the box that floats under cell 5c holds a number 1-20 (default 8) and the
// turn takes  2 / n  seconds — so 1 is the slowest at two full seconds, the default
// 8 gives 0.25s, and 20 whips round in 100ms. (dev0838 doubled this from 1/n: at
// 1/n the default was a 200ms turn, too quick to read as a rotation at all.)
// Remembered in localStorage for the next visit, so a stored value wins over the
// default — type 8 in the box to pick up a changed default.
//
// ──────────────────────────────────────────────────────────────────────────────
// CUT-OUT INSTRUCTIONS — to remove the feature entirely, with zero grid impact:
//   1. delete this file
//   2. delete  'turncells.js'  from the files[] array in index.html
//   3. in collection.js, drop the TurnCells line from _gmStopAll, the T row from
//      _gmModesHtml, the 't' branch of _gmChoiceKey, and _gmTurnOn
//   4. in core.js, drop 't' from the  k === 'w' || k === 't'  grid block in the
//      window-capture keydown handler (leaving w = waterfall)
//   5. (dev0860) in grid.js, _gridCardTurn calls TurnCells.turnPanel — it already
//      returns false when the API is absent, so a flash card would simply stop
//      turning. THAT IS A FEATURE LOSS, not just a fun mode going away: read the
//      FLASH CARDS IN G note there before deleting this file.
// Nothing else references it.
// ──────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── Tunables ────────────────────────────────────────────────────────────────
  var SPEED_KEY = 'salTurnSpeed';
  var SPEED_MIN = 1, SPEED_MAX = 20, SPEED_DEF = 8;   // 2/8 = 0.25s per turn
  var FTEXT_LINES = 5;                            // "first 5 lines of ftext"
  // (dev0841) ONE CURVE, BOTH HALVES — and NOT a time-reverse of each other.
  //
  // Measured, at last, instead of reasoned about. Frame-by-frame cell heights
  // through a whole turn at the default speed (a 278x158 landscape cell):
  //   outgoing  158 133 106  79  53  27   0            <- even steps, dev0840
  //   incoming    0  45  80 106 125 138 147 152 155 157 158
  // The incoming half spends MOST of its frames near full height: it opens
  // decisively and then settles, which is why it has been called flawless every
  // time. The outgoing half spent its frames evenly across every height, so half
  // of them were unreadable slivers — brief squash, then gone.
  //
  // The trap I fell into three times: making the outgoing half the exact time-
  // reverse of the incoming one. dev0837/0838 did precisely that (reverse
  // (.25,.6,.65,1) and you get (.35,0,.75,.4)), and it is the WORST option, because
  // reversing a decisive-then-settling motion gives a dormant-then-vanishing one —
  // "a very low amplitude attempt at rotation, then it fades out", verbatim.
  //
  // What was asked for was the same EFFECT, not the same motion backwards. So both
  // halves now run the same curve on their own progress: commit to the turn at
  // once, ease into the end. Out of flat, or out of edge-on, it reads the same way.
  var EASE_OUT = 'cubic-bezier(.25,.6,.65,1)';
  var EASE_IN  = 'cubic-bezier(.25,.6,.65,1)';
  var PANEL_BG    = '#14161c';   // the back face
  var BACKDROP_BG = '#0e0f12';   // the black-grey the turn happens against
  // ── State ───────────────────────────────────────────────────────────────────
  var active = false;
  var wired  = false;              // capture pointerdown listener attached once
  var speed  = SPEED_DEF;          // 1-20; a turn lasts 2/speed seconds
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
  // So each chip is re-dressed as its own line whose metrics are all in em, and they
  // all share ONE size, set once on their parent and inherited.
  //
  // (dev0843) THAT SIZE IS A FIXED MEDIUM, AND IT ONLY EVER SHRINKS. dev0838 solved
  // it from the card width — "make the longest chip span the card" — which is what
  // was asked for and looked wrong in practice: a card carrying one short tag blew
  // that tag up to fill the width, so chip size swung wildly from card to card and
  // some came out huge. Type size is not the place to express how long a tag is.
  // So CHIP_MED is the size every chip wants, and the fitting is one-directional —
  // reduce just enough that the longest chip fits the width and the whole stack
  // fits the top half, never enlarge to fill space that happens to be free.
  //
  // Called AFTER the panel is in the DOM. Measurement uses scrollWidth /
  // clientWidth, which are layout values: the cell is edge-on under a rotate at
  // that moment, and a getBoundingClientRect would come back foreshortened to
  // nothing, but layout metrics do not care about transforms.
  var CHIP_MED = 13;                   // the one medium size chips are drawn at
  var CHIP_MIN = 6;                    // …unless they must shrink to fit

  function fitTagChips(box) {
    if (!box) return;
    var chips = box.querySelectorAll('.tag-chip');
    if (!chips.length) return;
    // Re-dress first: em metrics, own line, and no inline size to fight the parent.
    box.style.fontSize = CHIP_MED + 'px';
    chips.forEach(function (c) {
      c.style.fontSize = '';                    // inherit the one size from `box`
      c.style.display = 'flex';                 // a flex-column item = its own line
      c.style.padding = '0.1em 0.5em';
      c.style.borderRadius = '1em';
      c.style.margin = '0.09em 0';
      c.style.maxWidth = '100%';
      c.style.borderWidth = '1px';
    });
    var avail = box.clientWidth;
    if (!avail) return;                         // not laid out — leave the medium
    var widest = 0;
    chips.forEach(function (c) { if (c.scrollWidth > widest) widest = c.scrollWidth; });
    if (!widest) return;
    // Chip width is very nearly linear in font size (text + em padding), so one
    // pass gets there; no need to iterate.
    var byWidth  = CHIP_MED * (avail / widest);
    // 1.45 line-height + 0.2em padding + 0.18em margin ≈ 1.83em per stacked line.
    var byHeight = box.clientHeight / (chips.length * 1.83);
    // Math.min against CHIP_MED is the whole rule: shrink to fit, never grow.
    var size = Math.max(CHIP_MIN, Math.min(CHIP_MED, byWidth, byHeight));
    box.style.fontSize = size.toFixed(2) + 'px';
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

    // (dev0848) When the row has no ftext, fall back to the DICTIONARY: the note
    // taxoninfo.js holds for this row's primary taxon tag, or for the nearest
    // ancestor that has one (species -> genus -> family -> order). ftext still wins
    // when it exists — this fills blank backs, it does not overrule what has been
    // written by hand. Roughly two thirds of tagged rows had nothing here before.
    var tinfo = (!lines.length && window.taxonInfo && window.taxonInfo.noteForRow)
      ? window.taxonInfo.noteForRow(row) : null;

    var back = document.createElement('div');
    back.className = 'turn-back';
    back.style.cssText = 'position:absolute;inset:0;z-index:140;overflow:hidden;'
      + 'background:' + PANEL_BG + ';color:#e9e9f0;box-sizing:border-box;padding:' + pad + 'px;'
      + 'display:flex;flex-direction:column;'
      + 'font:' + fs + 'px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;';

    // Nothing to teach with — say so rather than showing an empty card.
    if (!chips && !lines.length && !tinfo) {
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
      : (tinfo ? dictHtml(tinfo, fs)
               : '<span style="opacity:.35;font-style:italic;">' + esc(title || 'no text yet') + '</span>');
    back.appendChild(bot);

    // The store loads lazily, so the very first card flipped in a session can be
    // built before taxoninfo.json has arrived. Rather than block the flip, patch
    // the text in once it lands — the panel is already on screen and this only
    // touches the bottom half.
    if (!lines.length && !tinfo && window.taxonInfo && !window.taxonInfo.loaded()) {
      window.taxonInfo.load().then(function () {
        if (!bot.isConnected) return;
        var late = window.taxonInfo.noteForRow(row);
        if (late) bot.innerHTML = dictHtml(late, fs);
      }).catch(function () {});
    }

    return back;
  }

  // A dictionary note, dressed so it never reads as the row's own writing. The
  // heading names the taxon the text is ABOUT, which matters when the note came
  // from an ancestor: a Careproctus rastrinus card says "Liparidae · family", so
  // nobody mistakes a family description for a species one. Wikipedia's one-line
  // description ("Order of flying mammals") is used as that heading when the note
  // is for the tag itself, since it is tighter than the rank alone.
  function dictHtml(t, fs) {
    var small = Math.max(8, fs - 3);
    var head;
    if (t.up > 0) {
      head = esc(t.label) + (t.rank ? ' \u00b7 ' + esc(t.rank) : '');
    } else {
      head = esc(t.descr || t.label);
    }
    if (t.viaGenus)   head += ' \u00b7 genus';
    if (t.viaSpecies) head += ' \u00b7 ' + esc(t.viaSpecies);
    return '<div style="opacity:.55;font-size:' + small + 'px;margin-bottom:.25em;">'
         + head + (t.iucn ? ' \u00b7 ' + esc(t.iucn) : '') + '</div>'
         + '<div>' + esc(t.note) + '</div>';
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
  // (dev0841) The perspective is fixed for a whole turn, taken from the cell's
  // RESTING size. It used to be recomputed inside every tf() call from a live
  // getBoundingClientRect — which, once the cell is part-rotated, reports the
  // foreshortened box, so the depth could shift under the animation mid-turn.
  function tf(cell, axis, deg, p) {
    return 'perspective(' + (p || persp(cell)) + 'px) rotate' + axis + '(' + deg + 'deg)';
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

  // `keep` is the one child that stays visible behind the panel — the grid
  // interactor on a flash card, which has to go on receiving the taps. See the
  // FLASH CARD TURNS note at the bottom of the file.
  function hideFront(cell, back, keep) {
    var hidden = [];
    Array.prototype.slice.call(cell.children).forEach(function (ch) {
      if (ch === back || ch === keep) return;
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
      cell.style.transform = tf(cell, st.axis, 0, st.p);
    } else {
      cell.style.transform = '';
    }
    // will-change is NOT cleared here: the mode is still on, and dropping the
    // promotion between turns is exactly the bug promoteAll() exists to prevent.
    // stop() clears it for every cell when the mode ends.
    // (dev0860) A flash card cell keeps its layer whether the mode is on or not —
    // it can be turned again at any time, with no mode to promote it first.
    cell.style.willChange = (active || cell._turnCard) ? 'transform' : '';
  }

  // ── Compositing: promote every cell ONCE, when the mode starts ──────────────
  // (dev0841) THIS IS THE FIX for four rounds of "a partial move, then it fades
  // out" — and the answer was sitting in the symptom all along: the return trip
  // was flawless while the outward one was not, which no timing curve could
  // explain, because both use the same durations and mirrored easings.
  //
  // The difference was never the animation. It was the LAYER.
  //   • settle() leaves a flipped cell holding both  will-change: transform  and
  //     a real  perspective(...) rotateX(0deg) . It is already on its own
  //     compositing layer, so the turn BACK animates cleanly from frame one.
  //   • A cell on the front has neither. Its very first 3D transform is what
  //     promotes it, so the promotion happens WHILE the transition is already
  //     running: the compositor rasterises a new layer mid-animation, drops the
  //     opening frames, and the cell twitches and then is simply gone. That is a
  //     dropped-frame artefact, not a fade — which is why it never cared whether
  //     the cell held a YouTube iframe or a plain <img>, and why softer curves, a
  //     removed veil, a doubled duration and an acos() ease all changed nothing.
  //
  // So every cell is promoted up front, when the mode starts, and stays promoted
  // until it ends. spin() below adds the second half of the guarantee: the start
  // pose gets a committed frame of its own before the rotation begins.
  function promoteAll() {
    var cont = container(); if (!cont) return;
    cont.querySelectorAll('.grid-cell').forEach(function (c) {
      c.style.willChange = 'transform';
    });
  }
  function unpromoteAll() {
    var cont = container(); if (!cont) return;
    cont.querySelectorAll('.grid-cell').forEach(function (c) {
      if (c._turnCard) return;      // (dev0860) still turnable with the mode off
      c.style.willChange = '';
    });
  }

  // One half-turn, driven by the Web Animations API rather than a CSS transition
  // plus a setTimeout guess at when it lands.
  //
  // (dev0841) THE 50ms HOLE. Measured across the midpoint at the default speed:
  //     199ms height 0 · 234ms height 0 · 249ms height 45
  // The cell sat at nothing for 50ms — an eighth of the whole 400ms turn — exactly
  // at the moment the picture vanished. The old scheme earned that hole twice over:
  // a setTimeout armed for  duration + 20ms  (so the swap always ran late), and a
  // requestAnimationFrame before each half started (so the next one always began
  // late too). A picture that disappears and leaves a hole before anything replaces
  // it does not read as turning into the text. It reads as the picture going away.
  //
  // animate() removes both guesses: the animation starts on its own next frame with
  // no help, and `onfinish` fires exactly when it lands, so the swap and the second
  // half happen in that same task. The hole shrinks to a single frame.
  function spin(cell, st, axis, from, to, dur, ease, done) {
    cell.style.willChange = 'transform';
    cell.style.transition = 'none';
    cell.style.transform  = tf(cell, axis, to, st.p);     // rest here when it ends
    var anim;
    try {
      anim = cell.animate(
        [{ transform: tf(cell, axis, from, st.p) },
         { transform: tf(cell, axis, to,   st.p) }],
        { duration: Math.max(1, dur * 1000), easing: ease, fill: 'backwards' }
      );
    } catch (_) {                                        // no WAAPI — old behaviour
      cell.style.transform = tf(cell, axis, from, st.p);
      void cell.offsetWidth;
      cell.style.transition = 'transform ' + dur + 's ' + ease;
      cell.style.transform  = tf(cell, axis, to, st.p);
      st.timer = setTimeout(done, dur * 1000 + 16);
      return;
    }
    st.anim = anim;
    anim.onfinish = function () {
      st.anim = null;
      if (!cell.isConnected) { restore(cell, st); turned.delete(cell); return; }
      done();
    };
  }

  // Front -> back. Half one takes the picture edge-on; half two brings the card in.
  // (dev0860) `opts` is how a flash card turns: { card:true, tag, make } supplies
  // the panel instead of buildBack and leaves the interactor live. Fun mode calls
  // this with no opts and behaves exactly as before.
  function turnToBack(cell, opts) {
    var row = cell._rowData;
    var axis = axisFor(cell);
    var half = halfDur();
    var box = homeBox(cell);                                // measure BEFORE rotating
    var st = { axis: axis, box: box, back: null, backdrop: null, anim: null,
               p: persp(cell),                          // fixed for the whole turn
               card: !!(opts && opts.card), tag: (opts && opts.tag) || '',
               make: (opts && opts.make) || null,
               hidden: null, timer: null, busy: true, flipped: false };
    turned.set(cell, st);

    st.backdrop = addBackdrop(cell, box);
    cell.style.zIndex = '300';

    spin(cell, st, axis, 0, 90, half, EASE_OUT, function () {
      setPlaying(cell, false);                              // hold the frame
      var back = st.make ? dressPanel(st.make(cell, row)) : buildBack(cell, row);
      cell.appendChild(back);
      fitTagChips(back.querySelector('.turn-back-tags'));   // needs to be in the DOM
      // A caller-built panel measures itself the same way and at the same moment:
      // in the DOM, still edge-on, before the second half starts. Layout metrics
      // do not care about the rotation — see the fitTagChips note.
      if (typeof back._salFit === 'function') { try { back._salFit(); } catch (_) {} }
      st.back = back;
      st.hidden = hideFront(cell, back, st.card ? cell.querySelector('.grid-interactor') : null);
      st.flipped = true;
      // Edge-on at +90 and at -90 look identical, so this jump is invisible — and
      // landing on 0 (rather than 180) means the back is never mirrored.
      spin(cell, st, axis, -90, 0, half, EASE_IN, function () {
        st.busy = false; st.timer = null;
        dropEl(st.backdrop); st.backdrop = null;   // resting flat — nothing to hide
        if (cell.isConnected) settle(cell, st);
      });
    });
  }

  // Back -> front. (dev0842) THE SAME WAY ROUND AS THE OUTWARD TURN, not its
  // mirror. It used to unwind — 0 -> -90 -> ... -> 0 — which sounds tidier and is
  // wrong to watch: on a landscape cell the top went BACK on the way out and then
  // came FORWARD on the way home, and on a portrait cell the right edge did the
  // same. A card you keep turning the same way is one object being turned over and
  // back over; a card that unwinds is the film running backwards. So this half now
  // uses exactly the angles turnToBack uses, and the top (or the right edge) goes
  // away from you every time, in both directions.
  function turnToFront(cell) {
    var st = turned.get(cell);
    if (!st) return;
    var axis = st.axis, half = halfDur();
    st.busy = true;

    // The box was measured on the way out; re-measure only if the grid has since
    // been resized under us.
    if (!st.box) st.box = homeBox(cell);
    if (!st.p) st.p = persp(cell);
    st.backdrop = addBackdrop(cell, st.box);
    cell.style.zIndex = '300';

    spin(cell, st, axis, 0, 90, half, EASE_OUT, function () {
      dropEl(st.back);
      showFront(st.hidden);
      st.back = null; st.hidden = null; st.flipped = false;
      setPlaying(cell, true);                               // carry on from the held frame
      spin(cell, st, axis, -90, 0, half, EASE_IN, function () {
        dropEl(st.backdrop); st.backdrop = null;
        turned.delete(cell);
        if (cell.isConnected) settle(cell, null);
      });
    });
  }

  function toggleCell(cell) {
    var st = turned.get(cell);
    if (st && st.busy) return;                              // mid-turn — let it land
    if (st && st.flipped) turnToFront(cell);
    else if (!st) turnToBack(cell);
  }

  // ── (dev0860) FLASH CARD TURNS ──────────────────────────────────────────────
  // The same machinery, driven from the GRID rather than from fun mode: an
  // ltype 'f' cell turns on a plain click and shows the card's own text (see
  // grid.js _gridCardBackPanel) instead of the tag/ftext back this mode builds.
  // Axis, backdrop, the two halves, the held frame, the speed setting — all
  // shared, so a card turns exactly the way a turnaround cell does.
  //
  // TWO THINGS DIFFER, both because a card must stay clickable while it is
  // turned over. Fun mode owns the whole container in capture phase, so it can
  // hide the interactor along with the rest of the front; a card is driven BY
  // the interactor's own gestures (tap = turn, swipe right = the original text),
  // and a  visibility:hidden  element is not hit-testable. So the interactor is
  // left visible — the panel covers it, so no part of the front shows through —
  // and the panel is  pointer-events:none  so the tap reaches the interactor
  // underneath it.
  //
  // `tag` names the face that is showing. The same tag again turns the card back
  // to the front; a different one swaps the panel where it stands, so a swipe on
  // a card that is already turned reads as turning a page rather than as a
  // second flip.
  function dressPanel(el) {
    if (!el) return el;
    el.classList.add('turn-back');        // stop()'s sweep finds it by this class
    el.style.pointerEvents = 'none';
    return el;
  }
  // A grid re-render (gridUpdateCell, a paste, a swap) empties the cell without
  // telling us, which would leave this Map insisting the cell is still turned.
  // Cheaper than a callback from G: notice it here, and let the cell start again.
  function healed(cell) {
    var st = turned.get(cell);
    if (!st || st.busy) return st;
    if (st.flipped && (!st.back || st.back.parentNode !== cell)) {
      turned.delete(cell);
      cell.style.transform = ''; cell.style.zIndex = '';
      return null;
    }
    return st;
  }
  function turnPanel(cell, tag, make) {
    if (!cell || !cell.isConnected || typeof make !== 'function') return false;
    turned.forEach(function (s2, c2) { if (!c2.isConnected) turned.delete(c2); });
    var st = healed(cell);
    if (st && st.busy) return true;             // mid-turn — the tap is spent
    cell._turnCard = true;
    if (!st || !st.flipped) { turnToBack(cell, { card: true, tag: tag, make: make }); return true; }
    if (st.tag === tag) { turnToFront(cell); return true; }
    var back = dressPanel(make(cell, cell._rowData));
    if (!back) return true;
    cell.replaceChild(back, st.back);
    if (typeof back._salFit === 'function') { try { back._salFit(); } catch (_) {} }
    st.back = back; st.tag = tag; st.make = make;
    return true;
  }
  function faceOn(cell) {
    var st = cell ? healed(cell) : null;
    return (st && st.flipped) ? (st.tag || 'back') : '';
  }

  // Snap a cell back to its front with no animation (mode off / grid closing).
  function restore(cell, st) {
    if (st && st.timer) clearTimeout(st.timer);
    if (st && st.anim) { try { st.anim.cancel(); } catch (_) {} st.anim = null; }
    if (st) {
      dropEl(st.back);     st.back = null;
      dropEl(st.backdrop); st.backdrop = null;
      showFront(st.hidden);
      if (st.flipped) setPlaying(cell, true);
      st.flipped = false;
    }
    cell.style.transition = 'none';
    cell.style.transform = '';
    cell.style.zIndex = '';
    cell.style.willChange = cell._turnCard ? 'transform' : '';   // (dev0860)
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
      // (dev0844) RENDER layout, so this also refuses while FOLD MODE has a plain
      // square dressed as a fold — same two owners of one transform, same answer.
      if (typeof _gridRenderLayout === 'function' && _gridRenderLayout() === '16F') {
        say('Turn does not run on a fold grid — that one folds instead', 2600);
        return false;
      }
    } catch (_) {}
    // A turning cell and a travelling cell fight over the same inline transform —
    // one fun mode at a time. (_gmStopAll also calls stop() here, but `active` is
    // still false at this point, so it cannot cancel the start that follows.)
    if (typeof window._gmStopAll === 'function') window._gmStopAll();
    speed = loadSpeed();
    // (dev0848) Warm the dictionary now, while the "Turnaround ON" toast is still
    // being read, so the first card flipped already has its note. The back builder
    // patches itself if this has not landed yet, so this is a head start, not a
    // dependency.
    if (window.taxonInfo && !window.taxonInfo.loaded()) {
      try { window.taxonInfo.load(); } catch (_) {}
    }
    ensureWired();
    active = true;
    promoteAll();          // (dev0841) layers ready BEFORE the first click, not during it
    boxShow();
    say('↻ Turnaround ON — click a cell to turn it over (tags + text on the back); '
      + 'click again to turn it back. ( t stops it · f leaves fun mode )', 4200);
    return true;
  }

  function stop() {
    restoreAll();
    unpromoteAll();
    // Belt and braces: a grid re-render mid-turn (a caption toggle, a resize) can
    // leave a backdrop behind whose cell is no longer the one we tracked.
    var cont = container();
    if (cont) cont.querySelectorAll('.turn-backdrop,.turn-back').forEach(dropEl);
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
    turnPanel: turnPanel,          // (dev0860) flash cards — see the note above
    faceOn: faceOn,
    get active() { return active; },
    get speed() { return speed; },
    setSpeed: function (v) { saveSpeed(v); if (active) boxShow(); return speed; }
  };
})();
