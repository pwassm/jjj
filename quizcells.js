// ══════════════════════════════════════════════════════════════════════════════
// quizcells.js  (dev0896)  —  Name the animal: a quiz over the flash cards in G
// ══════════════════════════════════════════════════════════════════════════════
//
// WHAT IT IS. A grid holding flash cards already knows every answer on it: each
// f-ltype row carries a scientific name and a common name (see cardtypes.js's
// id1 schema, and core.js's _tCardSpecies which reads it). Turn that round and
// you have a quiz for free — show the NAME, ask which picture it belongs to.
// The player clicks a cell; the right one turns over and shows its own card back
// as the confirmation, which is the same gesture G has always had, driven by the
// quiz instead of by the tap.
//
// THE BUTTON ONLY EXISTS WHEN IT WOULD WORK. A grid with no flash cards has no
// Quiz button at all, so the chrome never advertises something that would open
// on an empty queue. Presence is decided by a slow poll rather than by a call
// from gridShow: the grid is rebuilt and torn down from a dozen places across
// five files (see the same reasoning at grid.js's _gridSyncCleanClass and
// backarrow.js's poll), and a ninth or tenth new path would silently miss a
// hand-placed call.
//
// WHAT COUNTS AS THE RIGHT CELL: the SCIENTIFIC NAME, not the cell. Two cells
// holding the same species — a common enough thing on a themed grid — are both
// correct answers to that name, because the question asked was "which animal is
// this", and both pictures are that animal.
//
// A CARD WITH NO NAME IS NOT A QUESTION. f0 cards (swept in, never identified)
// have a picture and an empty back, so they are skipped when the queue is built.
// They still sit on the grid and can still be clicked — clicking one is simply
// wrong, like any other miss.
//
// THE THREE-SECOND HINT OFFER. A wrong click asks whether they want a hint, and
// that offer counts itself down from 3 and disappears. Not answering is a real
// answer here — it means "no, I'm still looking" — so the offer must not sit
// there waiting and must not need to be dismissed before play continues. It can
// be dismissed early, which is the same outcome arriving sooner.
//
// ── CUT-OUT INSTRUCTIONS — to remove the feature entirely, zero grid impact:
//   1. delete this file
//   2. delete 'quizcells.js' from the files[] array in index.html
//   3. in grid.js, the dev0896 window._gridCardParts / window._gridCardTurn
//      exports become unused (harmless — leave them, other callers may want them)
// Nothing else references it.
// ══════════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var RESULT_MS = 3000;   // how long a correct card stays turned over
  var HINT_MS   = 3000;   // how long the hint itself shows
  var ASK_MS    = 3000;   // how long the "want a hint?" offer waits

  var active    = false;
  var queue     = [];     // questions still to ask, already shuffled
  var cur       = null;   // { sci, common }
  var right     = 0, wrong = 0;
  var startedAt = 0;
  var awaiting  = false;  // a click on a cell is meaningful right now
  var timers    = [];     // every pending timer, cleared as one on stop()
  var wired     = false;

  // ── plumbing ──────────────────────────────────────────────────────────────
  function overlay()   { return document.getElementById('gridOverlay'); }
  function container() { return document.getElementById('gridContainer'); }
  function gridOpen()  { var o = overlay(); return !!(o && o.style.display === 'flex'); }

  function later(fn, ms) { var t = setTimeout(fn, ms);  timers.push(t); return t; }
  function every(fn, ms) { var t = setInterval(fn, ms); timers.push(t); return t; }
  function clearTimers() {
    timers.forEach(function (t) { clearTimeout(t); clearInterval(t); });
    timers = [];
  }
  function drop(id) { var el = document.getElementById(id); if (el) el.remove(); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // grid.js owns what a flash card is (dev0896 exports). No second definition
  // here: a card the grid does not render as a card must not be quizzed on.
  function cardParts(cell) {
    if (!cell || !cell._rowData) return null;
    if (typeof window._gridCardParts !== 'function') return null;
    try { return window._gridCardParts(cell._rowData); } catch (_) { return null; }
  }

  // core.js's reader: cardData.scientificName first, then section 2's <em>.
  // The same source the D-screen promotion tags on, so the quiz can never
  // disagree with the name the card itself put on a tag.
  function speciesOf(row) {
    try { if (typeof _tCardSpecies === 'function') return _tCardSpecies(row); } catch (_) {}
    return null;
  }

  // Every visible flash-card cell on the grid right now. Read fresh each time
  // rather than cached: a paste, a swap or a re-render replaces the elements.
  function cardCells() {
    var cont = container();
    if (!cont) return [];
    return Array.prototype.filter.call(cont.querySelectorAll('.grid-cell'), function (c) {
      return c.style.display !== 'none' && !!cardParts(c);
    });
  }

  function hasCards() { return cardCells().length > 0; }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function elapsed() {
    var s = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // ── the HUD: Quiz/Exit, and the tally underneath it ───────────────────────
  // Parented to #gridOverlay, not to <body>, so it lives and dies with the grid
  // and inherits whatever the overlay does (rotation, hiding) for nothing —
  // the same choice #gridControls makes.
  function hudEl() {
    var ov = overlay();
    if (!ov) return null;
    var hud = document.getElementById('quizHud');
    if (hud && hud.parentNode !== ov) { hud.remove(); hud = null; }
    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'quizHud';
      hud.style.cssText = 'position:fixed;top:8px;right:12px;z-index:28030;'
        + 'display:flex;flex-direction:column;align-items:flex-end;gap:6px;'
        + 'font:12px/1.3 system-ui,-apple-system,Segoe UI,sans-serif;';
      var btn = document.createElement('button');
      btn.id = 'quizBtn';
      btn.style.cssText = 'cursor:pointer;padding:7px 15px;border-radius:8px;'
        + 'font:600 13px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;';
      btn.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        toggle();
      });
      var tally = document.createElement('div');
      tally.id = 'quizTally';
      tally.style.cssText = 'display:none;padding:5px 10px;border-radius:7px;'
        + 'background:rgba(10,12,18,0.9);border:1px solid rgba(255,255,255,0.18);'
        + 'color:#dde;white-space:nowrap;letter-spacing:0.02em;';
      hud.appendChild(btn);
      hud.appendChild(tally);
      ov.appendChild(hud);
    }
    return hud;
  }

  function paintHud() {
    var hud = hudEl(); if (!hud) return;
    var btn = hud.querySelector('#quizBtn');
    var tal = hud.querySelector('#quizTally');
    btn.textContent = active ? 'Exit' : 'Quiz';
    btn.title = active ? 'Leave the quiz (Esc)'
                       : 'Name the animal — click the card it belongs to';
    btn.style.borderColor = active ? '#fa8' : '#9cf';
    btn.style.color       = active ? '#fa8' : '#9cf';
    btn.style.background  = active ? 'rgba(90,40,0,0.75)' : 'rgba(0,40,90,0.75)';
    btn.style.border      = '2px solid ' + (active ? '#fa8' : '#9cf');
    tal.style.display = active ? 'block' : 'none';
    if (active) {
      tal.innerHTML = '<span style="color:#7e7;">&#10003; ' + right + '</span>'
        + '<span style="opacity:.35;padding:0 6px;">|</span>'
        + '<span style="color:#f88;">&#10007; ' + wrong + '</span>'
        + '<span style="opacity:.35;padding:0 6px;">|</span>'
        + '<span style="opacity:.75;">' + elapsed() + '</span>';
    }
  }

  // ── the question, centred ─────────────────────────────────────────────────
  // pointer-events:none throughout: the name is shown OVER the grid the player
  // is about to click into, and a panel that ate the first click would make the
  // middle of every question board unanswerable.
  //
  // (dev0897) `opacity` is the panel's own, applied to the whole box rather than
  // to its background colour. Half-transparent means the PICTURE UNDER IT stays
  // readable -- the name sits on a 5x5 grid whose middle cell is one of the
  // answers, so a solid panel would hide a card the question might be about.
  function centrePanel(id, html, opacity) {
    drop(id);
    var ov = overlay(); if (!ov) return null;
    var el = document.createElement('div');
    el.id = id;
    el.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);'
      + 'z-index:28040;pointer-events:none;max-width:min(560px,86vw);max-height:70vh;'
      + 'overflow:hidden;opacity:' + (opacity == null ? 0.95 : opacity) + ';'
      + 'background:#0c0e14;color:#eef;'
      + 'border:1px solid rgba(255,255,255,0.22);border-radius:12px;'
      + 'padding:16px 24px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,0.7);'
      + 'font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;';
    el.innerHTML = html;
    ov.appendChild(el);
    return el;
  }

  // (dev0897) THE NAME STAYS UP UNTIL A CELL IS PICKED. The first draft flashed
  // it for a second, which made the quiz a memory test on top of an
  // identification test -- two things at once, and the wrong one was the hard
  // one. Now it is a half-transparent window that hangs there while the player
  // looks, takes no clicks (pointer-events:none, see centrePanel), and is
  // dropped the moment a cell is chosen, by onCorrect / onWrong.
  function showQuestion() {
    if (!cur) return;
    var common = cur.common
      ? '<div style="font-size:0.95em;opacity:0.8;">' + esc(cur.common) + '</div>'
      : '<div style="font-size:0.8em;opacity:0.4;font-style:italic;">no common name</div>';
    centrePanel('quizPrompt',
      '<div style="font-size:1.35em;font-style:italic;letter-spacing:0.01em;">'
      + esc(cur.sci) + '</div>' + common, 0.5);
  }

  // ── the hint offer: a button that counts itself down and leaves ───────────
  // NOT answering is an answer here — it means "no, I'm still looking" — so
  // this never blocks and never has to be dismissed before play continues. The
  // countdown sits on the button so the player can see how long they have
  // rather than being surprised by it vanishing.
  function offerHint() {
    drop('quizAsk');
    var ov = overlay(); if (!ov) return;
    var box = document.createElement('div');
    box.id = 'quizAsk';
    box.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);'
      + 'z-index:28050;background:rgba(18,12,12,0.97);color:#fee;'
      + 'border:2px solid #f88;border-radius:12px;padding:16px 20px 14px;'
      + 'text-align:center;box-shadow:0 10px 40px rgba(0,0,0,0.75);'
      + 'font:14px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;';
    box.innerHTML =
      '<div style="font-size:1.05em;margin-bottom:12px;">Not correct. Want a hint?</div>'
      + '<div style="display:flex;gap:10px;justify-content:center;">'
      + '<button id="quizHintYes" style="cursor:pointer;padding:7px 16px;border-radius:8px;'
      + 'border:2px solid #9cf;color:#9cf;background:rgba(0,40,90,0.8);'
      + 'font:600 13px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;">'
      + 'Hint <span id="quizHintCount" style="opacity:.65;font-weight:400;">3</span></button>'
      + '<button id="quizHintNo" style="cursor:pointer;padding:7px 16px;border-radius:8px;'
      + 'border:2px solid #777;color:#bbb;background:rgba(30,30,34,0.8);'
      + 'font:600 13px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;">No thanks</button>'
      + '</div>';
    ov.appendChild(box);

    // ONE end for all three ways out — taking the hint, refusing it, and letting
    // it run out — so there is exactly one place that resumes play, and a click
    // landing in the same tick as the timeout cannot resume it twice.
    var done  = false;
    var endAt = Date.now() + ASK_MS;
    var tick  = every(function () {
      var left = Math.ceil((endAt - Date.now()) / 1000);
      var c = document.getElementById('quizHintCount');
      if (c) c.textContent = String(Math.max(0, left));
      if (left <= 0) finish(false);
    }, 200);

    function finish(withHint) {
      if (done) return;
      done = true;
      clearInterval(tick);
      drop('quizAsk');
      if (withHint) showHint();
      else resume();
    }
    box.querySelector('#quizHintYes').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation(); finish(true);
    });
    box.querySelector('#quizHintNo').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation(); finish(false);
    });
  }

  // The card's OWN section 2 — the identification and what it rests on. That is
  // already written, already sized for a small panel, and is exactly the
  // information that narrows a grid down to one picture. Rendered through
  // renderFtext when it is there, so links and lists come out the way they do
  // on the card back itself.
  function showHint() {
    var target = cur ? findCellsFor(cur.sci)[0] : null;
    var parts  = target ? cardParts(target) : null;
    var body   = (parts && parts.sections && parts.sections[0]) || '';
    var html   = body
      ? (typeof renderFtext === 'function' ? renderFtext(body) : body)
      : '<em style="opacity:.6;">this card has nothing written on its back</em>';
    centrePanel('quizHint',
      '<div style="font-size:0.72em;letter-spacing:0.08em;opacity:0.5;'
      + 'text-transform:uppercase;margin-bottom:8px;">hint</div>'
      + '<div style="text-align:left;font-size:0.92em;">' + html + '</div>');
    later(function () { drop('quizHint'); resume(); }, HINT_MS);
  }

  // Back to the grid with the question still open, and the name back on screen
  // to stay -- it was dropped by the wrong click that got us here.
  function resume() {
    if (!active) return;
    awaiting = true;
    showQuestion();
  }

  // ── the questions ─────────────────────────────────────────────────────────
  // One question per NAME, not per cell: two cells of one species ask once and
  // accept either. Cards with no name yet (f0) are not questions.
  function buildQueue() {
    var seen = {}, out = [];
    cardCells().forEach(function (c) {
      var sp = speciesOf(c._rowData);
      if (!sp || !sp.sci) return;
      var k = sp.sci.toLowerCase();
      if (seen[k]) return;
      seen[k] = 1;
      out.push({ sci: sp.sci, common: sp.common || '' });
    });
    return shuffle(out);
  }

  function findCellsFor(sci) {
    var want = String(sci || '').toLowerCase();
    return cardCells().filter(function (c) {
      var sp = speciesOf(c._rowData);
      return !!(sp && sp.sci && sp.sci.toLowerCase() === want);
    });
  }

  function nextQuestion() {
    if (!active) return;
    drop('quizPrompt'); drop('quizHint'); drop('quizAsk');
    if (!queue.length) { report(); return; }
    cur = queue.shift();
    awaiting = true;
    showQuestion();
  }

  function onCorrect(cell) {
    awaiting = false;
    right++;
    paintHud();
    drop('quizPrompt');
    // The card's own turn IS the result: it shows the answer it was holding,
    // in the layout it was written for.
    if (typeof window._gridCardTurn === 'function') {
      try { window._gridCardTurn(cell, 0); } catch (_) {}
    }
    later(function () {
      if (typeof window._gridCardFrontAll === 'function') {
        try { window._gridCardFrontAll(); } catch (_) {}   // back to the picture
      }
      nextQuestion();
    }, RESULT_MS);
  }

  function onWrong() {
    awaiting = false;
    wrong++;
    paintHud();
    drop('quizPrompt');
    offerHint();
  }

  // ── clicks ────────────────────────────────────────────────────────────────
  // Capture phase on the container, ahead of .grid-interactor's own pointerdown
  // (play/pause, hold-to-cut, swipe, tap-to-turn) — the same claim turncells.js
  // makes while fun mode is on, and for the same reason: while the quiz is
  // asking, a click on a cell means one thing only.
  //
  // Plain left button / touch only, so Shift-zoom, Alt-COI, Ctrl+click and the
  // right-click menu still work on a grid that happens to be in a quiz.
  function onPointerDown(e) {
    if (!active || !awaiting) return;
    if (e.button !== undefined && e.button !== 0) return;
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    var cont = container();
    var cell = e.target && e.target.closest ? e.target.closest('.grid-cell') : null;
    if (!cell || !cont || !cont.contains(cell)) return;
    e.preventDefault();
    e.stopPropagation();
    var sp = speciesOf(cell._rowData);
    var ok = !!(cur && sp && sp.sci && sp.sci.toLowerCase() === cur.sci.toLowerCase());
    if (ok) onCorrect(cell); else onWrong();
  }

  // Esc leaves the QUIZ before it reaches G's own Esc, which would otherwise
  // close the grid out from under a quiz that is still running.
  function onKeyDown(e) {
    if (!active || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    stop();
  }

  function wire() {
    if (wired) return;
    var cont = container(); if (!cont) return;
    cont.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    wired = true;
  }
  function unwire() {
    var cont = container();
    if (cont) cont.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('keydown', onKeyDown, true);
    wired = false;
  }

  // ── start / stop ──────────────────────────────────────────────────────────
  function start() {
    if (active) return;
    queue = buildQueue();
    if (!queue.length) {
      if (typeof toast === 'function')
        toast('No named flash cards on this grid to quiz on', 2200);
      return;
    }
    active = true; right = 0; wrong = 0; cur = null;
    startedAt = Date.now();
    if (typeof window._gridCardFrontAll === 'function') {
      try { window._gridCardFrontAll(); } catch (_) {}   // start from pictures
    }
    wire();
    paintHud();
    nextQuestion();
  }

  function stop() {
    if (!active) return;
    active = false; awaiting = false; cur = null; queue = [];
    clearTimers();
    unwire();
    drop('quizPrompt'); drop('quizHint'); drop('quizAsk');
    if (typeof window._gridCardFrontAll === 'function') {
      try { window._gridCardFrontAll(); } catch (_) {}
    }
    paintHud();
  }

  // Queue exhausted. The score is worth a moment on screen before the button
  // goes back to saying Quiz, so a run ends with a result rather than with the
  // HUD quietly resetting. Built AFTER stop(), which clears the panels.
  function report() {
    var line = right + ' right, ' + wrong + ' wrong, in ' + elapsed();
    stop();
    centrePanel('quizHint',
      '<div style="font-size:1.15em;margin-bottom:6px;">Quiz complete</div>'
      + '<div style="opacity:0.8;">' + esc(line) + '</div>');
    setTimeout(function () { drop('quizHint'); }, 3200);
  }

  function toggle() { if (active) stop(); else start(); }

  // ── presence ──────────────────────────────────────────────────────────────
  // Slow poll — see the header note on why this is not a call from gridShow.
  // It doubles as the clock the tally shows, and as the safety net that ends a
  // quiz when the grid is closed by any of the several paths that write
  // gridOverlay.style.display directly.
  setInterval(function () {
    if (!gridOpen() || !hasCards()) {
      if (active) stop();
      drop('quizHud');
      return;
    }
    paintHud();
  }, 500);

  window.QuizCells = {
    start: start,
    stop: stop,
    toggle: toggle,
    get active() { return active; },
    get score() { return { right: right, wrong: wrong, left: queue.length }; }
  };
})();
