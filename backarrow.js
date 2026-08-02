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
//   players and the fun modes, so the arrow calls that directly.
//
// WHERE IT SHOWS
//   USER MODE ONLY, on every screen EXCEPT:
//     • Menu — the shareable menu is home; there is nothing behind it.
//     • PM (the full-window presentation reader) — it already carries its own
//       ‹ › page arrows and a red ✕, and a second control in the same corner
//       would just be in the way.
//     • H — the help panel closes on a tap anywhere; an arrow there points at
//       nothing useful.
//   The grid's `l` (cLean) toggle hides it along with the rest of the chrome.
//
// LOOK
//   Copied from PM's ‹ › buttons (vp.js _addSectArrows): a 46px translucent dark
//   circle with a hairline white border, left edge, vertically centred. Same
//   size, same colours, same position — one back control, one appearance.
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

  function _shouldShow() {
    if (!_userMode()) return false;
    var c = _screen();
    if (c === 'Menu' || c === 'H') return false;
    if (_inPM()) return false;
    // (dev0711) The grid's clean view hides every overlaid control, this one
    // included — grid.js owns that flag and the display it forces.
    if (c === 'G' && window._gridCleanOn && window._gridCleanOn()) return false;
    return true;
  }

  function _goBack() {
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
    b.title = 'Back (Esc)';
    b.setAttribute('aria-label', 'Back');
    // z-index clears the grid overlay's chrome (28010) and the fullscreen
    // viewer's own arrows, so it is reachable on top of any of them.
    b.style.cssText = 'position:fixed;left:10px;top:50%;transform:translateY(-50%);'
      + 'width:46px;height:46px;border-radius:50%;'
      + 'border:1px solid rgba(255,255,255,0.35);background:rgba(0,0,0,0.45);'
      + 'color:#fff;font-size:26px;line-height:1;padding:0;'
      + 'cursor:pointer;touch-action:manipulation;user-select:none;'
      + '-webkit-user-select:none;z-index:29500;display:none;';
    // Swallow the gesture start so the swipe catchers underneath never read a
    // tap on this button as a swipe (same guard PM's arrows use).
    b.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    b.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      _goBack();
    });
    document.body.appendChild(b);
    return b;
  }

  function _sync() {
    if (!document.body) return;
    var b = _ensure();
    var want = _shouldShow() ? 'block' : 'none';
    if (b.style.display !== want) b.style.display = want;
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
