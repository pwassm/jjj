// ─────────────────────────────────────────────────────────────────────────────
// backarrow.js — (dev0711) ONE floating BACK arrow for the whole user site.
//
// WHY IT EXISTS
//   Every screen already goes back on Esc, and most of them also go back on a
//   right-to-left swipe. Neither is discoverable: a phone has no Esc key, and a
//   swipe is invisible until someone tells you about it. Viewers on
//   sealifeandmore.com were reaching a video or a slide and having no visible
//   way out. This is that way out, and nothing more — it does not introduce a
//   new navigation idea, it just draws the one that was already there.
//
// WHAT IT DOES
//   Sends an Escape keydown. Deliberately: Esc IS this app's back key (see the
//   escape-nav rules in core.js / vp.js / slideshow.js), so routing the button
//   through it means the button can never drift away from the keyboard — a
//   screen that changes what Esc does changes what the arrow does, for free.
//   The grid is the one exception: it has a dedicated helper that also stops the
//   players and the grid modes, so the arrow calls that directly.
//
// WHERE IT SHOWS
//   USER MODE ONLY, on every screen EXCEPT:
//     • Menu page 1 (Welcome/Intro) — that IS home; nothing is behind it. On the
//       other menu tabs it DOES show (dev0739) and goes back to the Intro in
//       place. That is the one screen where it does not send Esc, because Esc on
//       the menu leaves the menu; here it calls the menu's own pager instead.
//     • PM (the full-window presentation reader) — it already carries its own
//       ‹ › page arrows and a red ✕, and a second control in the same corner
//       would just be in the way.
//     • H — the help panel closes on a tap anywhere; an arrow there points at
//       nothing useful.
//   The grid's `l` (cLean) toggle hides it along with the rest of the chrome.
//
// LOOK
//   A 46px dark circle with a white ring, left edge, vertically centred —
//   the size and position PM's ‹ › buttons use (vp.js _addSectArrows).
//   (dev0765) The COLOURS are no longer PM's. PM's arrows sit over a text
//   reader with a known dark background; this one sits over whatever picture
//   the grid happens to be showing. At PM's rgba(0,0,0,0.45) fill behind a
//   0.35-alpha hairline it vanished into a dark cell — reported as "the back
//   arrow isn't there on Gu". So: an opaque-enough fill, a near-solid ring,
//   and a dark drop shadow that gives the white ring something to read
//   against when the picture underneath is bright. Same 46px, same corner.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  var BTN_ID = 'salBackArrow';

  function _userMode() {
    try { return !!(typeof _isUserMode === 'function' && _isUserMode()); }
    catch (_) { return false; }
  }

  // The screen code, from helpfloat's prober — the single place in the app that
  // knows which of the stacked overlays is actually on top.
  function _screen() {
    try { return (typeof window.hpScreen === 'function') ? window.hpScreen() : ''; }
    catch (_) { return ''; }
  }

  // PM = the full-window text reader (↑ from a grid t cell). vp.js flags it.
  function _inPM() { return !!window._vpTextReader; }

  // (dev0739) On the menu the arrow means "back to the Intro page". It is the
  // one screen where Esc is NOT the right answer — Esc on the menu leaves for
  // the grid — so this is the single case that routes somewhere of its own.
  function _onMenuTab() {
    return _screen() === 'Menu'
        && !!document.getElementById('shareableMenu')
        && window._smCurPage !== 1
        && typeof window._smShowPage === 'function';
  }

  function _shouldShow() {
    if (!_userMode()) return false;
    var c = _screen();
    // Welcome (page 1) is home — nothing behind it. Every other menu tab has
    // the Intro to go back to.
    if (c === 'Menu') return _onMenuTab();
    if (c === 'H') return false;
    if (_inPM()) return false;
    // (dev0711) The grid's clean view hides every overlaid control, this one
    // included — grid.js owns that flag and the display it forces.
    if (c === 'G' && window._gridCleanOn && window._gridCleanOn()) return false;
    return true;
  }

  function _goBack() {
    // (dev0739) On a menu tab, go to the Intro page in place — no reload, and
    // no Esc, which would leave the menu entirely.
    if (_onMenuTab()) {
      try { window._smShowPage(1); } catch (_) {}
      return;
    }
    // The grid has a purpose-built exit that also stops the players, the fun
    // modes and the floating cards, and lands on the menu PAGE it came from.
    var gridUp = false;
    try {
      var g  = document.getElementById('gridOverlay');
      var fs = document.getElementById('gridFullscreen');
      gridUp = !!(g && g.style.display === 'flex')
               && !(fs && fs.style.display === 'flex');
    } catch (_) {}
    if (gridUp && typeof window._returnToMenuFromGrid === 'function') {
      window._returnToMenuFromGrid();
      return;
    }
    // Everywhere else: press Esc for them. Dispatched on document so it travels
    // window-capture → document — both places this app's Esc handlers live.
    var ev = new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
      bubbles: true, cancelable: true
    });
    document.dispatchEvent(ev);
  }

  function _ensure() {
    var b = document.getElementById(BTN_ID);
    if (b) return b;
    b = document.createElement('button');
    b.id = BTN_ID;
    b.type = 'button';
    b.textContent = '←';
    // (dev0930) The glyph itself is language-neutral; only its labels translate.
    var _t = window.T || function (s) { return s; };
    b.title = _t('Back (Esc)');
    b.setAttribute('aria-label', _t('Back'));
    // z-index clears the grid overlay's chrome (28010) and the fullscreen
    // viewer's own arrows, so it is reachable on top of any of them.
    b.style.cssText = 'position:fixed;left:10px;top:50%;transform:translateY(-50%);'
      + 'width:46px;height:46px;border-radius:50%;'
      + 'border:2px solid rgba(255,255,255,0.9);background:rgba(0,0,0,0.72);'
      + 'box-shadow:0 0 0 1px rgba(0,0,0,0.6),0 2px 10px rgba(0,0,0,0.7);'
      + 'color:#fff;font-size:28px;font-weight:bold;line-height:1;padding:0;'
      + 'text-shadow:0 1px 3px rgba(0,0,0,0.9);'
      + 'cursor:pointer;touch-action:manipulation;user-select:none;'
      + '-webkit-user-select:none;z-index:29500;display:none;';
    // Swallow the gesture start so the swipe catchers underneath never read a
    // tap on this button as a swipe (same guard PM's arrows use).
    b.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    b.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      _goBack();
    });
    // (dev0738) Mount inside #rotateWrap. On <body> it was a sibling of the wrap,
    // so left:10px/top:50% were read in the DEVICE frame: on a portrait phone the
    // UI is rotated 90° CW, which put this "left edge" button along the visual
    // BOTTOM. Inside the wrap the same two numbers mean the visual left edge, in
    // both orientations. Landscape is unaffected — the wrap has no transform
    // there, so fixed still resolves against the viewport at the same z-index.
    (window.salOverlayRoot ? window.salOverlayRoot() : document.body).appendChild(b);
    return b;
  }

  function _sync() {
    if (!document.body) return;
    var b = _ensure();
    var onMenu = _onMenuTab();
    var want = _shouldShow() ? 'block' : 'none';
    if (b.style.display !== want) b.style.display = want;
    // (dev0739) #shareableMenu sits at z-index 999990 and, since dev0737, in the
    // same stacking context as this button — at the standing 29500 the arrow
    // would be behind the menu it is meant to sit on. Lift it only while the
    // menu is up: raising it everywhere would also float it over the slideshow
    // and V, whose own stacking was settled long before this button existed.
    var z = onMenu ? '999995' : '29500';
    if (b.style.zIndex !== z) b.style.zIndex = z;
  }
  window._salBackArrowSync = _sync;

  // Screens here are overlays shown and hidden by direct style writes all over
  // the codebase — there is no one navigation event to hook. A slow poll is the
  // honest way to track that, and at 300 ms it costs a handful of DOM reads.
  function _start() {
    _sync();
    setInterval(_sync, 300);
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', _start);
  else _start();
})();
