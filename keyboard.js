// ─────────────────────────────────────────────────────────────────────────────
// keyboard.js — (dev0739) An on-screen QWERTY for text boxes on phones.
//
// WHY IT EXISTS
//   On a portrait phone the whole UI is CSS-rotated 90° inside #rotateWrap
//   (see index.html). The DEVICE keyboard is drawn by the operating system in
//   the phone's PHYSICAL orientation, and no web API can turn it — so tapping
//   the search box raised a keyboard lying sideways across our landscape UI.
//   Drawing our own inside the wrap is the only way a keyboard can share the
//   frame everything else is in.
//
//   That is the whole reason for this file. It is not a better keyboard than
//   the system one — it has no autocorrect, no accents, no dictation — so it is
//   deliberately limited to the boxes where those things do not matter: short
//   search and filter terms. Anything that wants a URL or real prose keeps the
//   system keyboard, sideways and all, because losing paste and autocorrect
//   there would cost more than the rotation does.
//
// LAYOUT
//   Letters, backspace, space, Go, and ONE key that swaps the letter rows for
//   digits and a small punctuation set. No accents, no symbol pages.
//
//   It sits against the RIGHT edge and is sized to about half the visual width,
//   so the box being typed into and the results underneath stay visible on the
//   left rather than being buried under a full-width keyboard.
//
// HOW IT TALKS TO THE PAGE
//   It never reaches into anyone's search logic. It writes input.value and
//   fires a bubbling `input` event; Go fires an Enter `keydown`. Both are what
//   a real keyboard produces, so every box already wired for typing works
//   unchanged and there is nothing for a caller to keep in step.
//
// NOTE
//   slideshow.js has its own numeric keypad (dev0738) built on the same idea.
//   The two are not shared: that one clamps to a min/max, steps by decimals and
//   shows the current setting, none of which a text box wants. Worth merging if
//   a third one ever appears.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  var KB_ID = 'salKeyboard';

  var ROWS_ABC = [
    ['q','w','e','r','t','y','u','i','o','p'],
    ['a','s','d','f','g','h','j','k','l'],
    ['z','x','c','v','b','n','m']
  ];
  // One page of digits and the punctuation that actually turns up in a title or
  // a species name. Deliberately short — this is the "toggle to numbers" key's
  // entire job, not a symbol browser.
  var ROWS_123 = [
    ['1','2','3','4','5','6','7','8','9','0'],
    ['-','\'','.',',','&','/','(',')'],
    ['!','?',':','+','@','#','%']
  ];

  function _vp() {
    return (typeof window.salViewport === 'function')
      ? window.salViewport()
      : { w: window.innerWidth, h: window.innerHeight };
  }

  function _root() {
    return (typeof window.salOverlayRoot === 'function')
      ? window.salOverlayRoot() : document.body;
  }

  window.salKeyboardClose = function () {
    var el = document.getElementById(KB_ID);
    if (el) el.remove();
  };

  window.salKeyboardIsOpen = function () {
    return !!document.getElementById(KB_ID);
  };

  // opts: { input, onGo }  — onGo defaults to firing Enter on the input.
  window.salKeyboard = function (opts) {
    var input = opts && opts.input;
    if (!input) return;
    window.salKeyboardClose();

    var mode = 'abc';
    var vp = _vp();

    // Half the visual width, bounded so it neither swamps a small phone nor
    // stretches into a comically wide key on a tablet.
    var panelW = Math.min(460, Math.max(260, Math.round(vp.w * 0.52)));
    // Four rows (three of keys plus the action row) inside ~26px of padding.
    var keyH = Math.max(26, Math.min(44, Math.floor((vp.h - 40) / 5)));
    var gap = 4;
    // Widest row is 10 keys; every key gets that width so the rows stay in
    // column with each other instead of each row centring on its own count.
    var keyW = Math.floor((panelW - 20 - gap * 9) / 10);

    var wrap = document.createElement('div');
    wrap.id = KB_ID;
    wrap.style.cssText = 'position:fixed;right:6px;bottom:6px;z-index:43500;'
      + 'width:' + panelW + 'px;padding:8px 10px;border-radius:10px;'
      + 'background:rgba(14,14,28,0.97);border:1px solid #4af;'
      + 'box-shadow:0 6px 28px rgba(0,0,0,0.85);font-family:monospace;'
      + 'touch-action:manipulation;user-select:none;-webkit-user-select:none;';

    var keyCSS = 'height:' + keyH + 'px;min-width:' + keyW + 'px;padding:0;'
      + 'border-radius:5px;border:1px solid #3a5a80;background:#1b2540;'
      + 'color:#dbe9ff;font-family:monospace;font-size:' + Math.round(keyH * 0.46) + 'px;'
      + 'cursor:pointer;touch-action:manipulation;';
    var actCSS = 'height:' + keyH + 'px;padding:0 10px;border-radius:5px;'
      + 'font-family:monospace;font-size:' + Math.round(keyH * 0.40) + 'px;'
      + 'font-weight:bold;cursor:pointer;touch-action:manipulation;';

    function rowsHtml() {
      var rows = (mode === 'abc') ? ROWS_ABC : ROWS_123;
      return rows.map(function (r) {
        return '<div style="display:flex;gap:' + gap + 'px;margin-bottom:' + gap
             + 'px;justify-content:center;">'
             + r.map(function (k) {
                 return '<button class="sal-kb-key" data-k="' + k + '" style="' + keyCSS + '">'
                      + k + '</button>';
               }).join('')
             + '</div>';
      }).join('');
    }

    function actionsHtml() {
      return '<div style="display:flex;gap:' + gap + 'px;justify-content:center;">'
        + '<button class="sal-kb-act" data-a="mode" style="' + actCSS
        +   'border:1px solid #4af;background:rgba(0,50,100,0.7);color:#8ef;">'
        +   (mode === 'abc' ? '123' : 'ABC') + '</button>'
        + '<button class="sal-kb-act" data-a="space" style="' + actCSS
        +   'flex:1;border:1px solid #3a5a80;background:#1b2540;color:#dbe9ff;">space</button>'
        + '<button class="sal-kb-act" data-a="back" style="' + actCSS
        +   'border:1px solid #3a5a80;background:#1b2540;color:#dbe9ff;">&#9003;</button>'
        + '<button class="sal-kb-act" data-a="go" style="' + actCSS
        +   'border:1px solid #6c8;background:rgba(0,80,30,0.6);color:#cfd;">Go</button>'
        + '<button class="sal-kb-act" data-a="close" style="' + actCSS
        +   'border:1px solid #f88;background:rgba(80,0,0,0.45);color:#fbb;">&#10005;</button>'
        + '</div>';
    }

    function draw() {
      wrap.innerHTML = rowsHtml() + actionsHtml();
    }
    draw();

    // Type INTO the box the way a real keyboard would, so whatever is already
    // listening for `input` re-runs with no knowledge of this keyboard.
    function emit() {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function type(ch) { input.value += ch; emit(); }
    function back()   { input.value = input.value.slice(0, -1); emit(); }
    function go() {
      if (opts.onGo) { opts.onGo(input.value); return; }
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true
      }));
    }

    // pointerdown, not click: preventDefault here stops the tap ever moving
    // focus off the input, which on some Android browsers is what re-raises the
    // system keyboard behind ours.
    wrap.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var k = e.target.closest ? e.target.closest('.sal-kb-key') : null;
      if (k) { type(k.dataset.k); return; }
      var a = e.target.closest ? e.target.closest('.sal-kb-act') : null;
      if (!a) return;
      switch (a.dataset.a) {
        case 'mode':  mode = (mode === 'abc') ? '123' : 'abc'; draw(); break;
        case 'space': type(' '); break;
        case 'back':  back(); break;
        case 'go':    go(); break;
        case 'close': window.salKeyboardClose(); break;
      }
    }, true);
    // Swallow the click that follows so it never lands on the page underneath.
    wrap.addEventListener('click', function (e) { e.stopPropagation(); }, true);

    _root().appendChild(wrap);
  };

  // Attach to a text input: on touch the box stops raising the system keyboard
  // (readOnly is what suppresses it) and taps open ours instead. On anything
  // with a real keyboard this does nothing at all.
  window.salKeyboardAttach = function (input, opts) {
    if (!input) return;
    var touch = false;
    try { touch = !!(typeof _isMobileDevice === 'function' && _isMobileDevice()); }
    catch (_) { touch = false; }
    if (!touch) return;
    input.readOnly = true;
    input.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      window.salKeyboard({
        input: input,
        onGo: opts && opts.onGo
      });
    });
  };
})();
