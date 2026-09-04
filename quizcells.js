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
// (dev0900) EVERY CARD IS A QUESTION, AND THE SCIENTIFIC NAME IS NOT ITS
// IDENTITY. The first build asked one question per scientific name, which was
// wrong twice over on a real grid:
//
//   1b Decorator crab  and  1c Spider crab   are BOTH Majoidea — the cards stop
//      at superfamily on purpose, because that is as far as the pictures carry.
//      So clicking the spider crab scored as a correct answer for the decorator
//      crab, and only one of the two was ever asked about.
//   4b and 3b are both Bodianus pulcher, deliberately: a California sheephead
//      part way through turning male, and a finished male. Two cards, one name,
//      and the second was never asked.
//
// So the QUEUE IS ONE QUESTION PER CELL — every flash card on the grid gets
// asked — and the answer is matched on the whole question as the player sees
// it: the scientific name AND the common name off the card's <h1>. That tells
// the two Majoidea apart (Spider crab / Decorator crab), which is exactly what
// the player was asked to do.
//
// Cards that show the SAME question (the two sheephead) are indistinguishable
// by construction — nothing on screen could tell the player which of them is
// meant — so either one answers either question. They are still asked twice, so
// both cards get turned over and read.
//
// A CARD WITH NO NAME IS NOT A QUESTION. f0 cards (swept in, never identified)
// have a picture and an empty back, so they are skipped when the queue is built.
// They still sit on the grid and can still be clicked — clicking one is simply
// wrong, like any other miss.
//
// (dev0898) A CORRECT CARD IS READ AT THE PLAYERS OWN PACE. It turns over and
// stays turned until the next click, anywhere. The first two corrects get a
// small "click to continue" balloon beside the mouse; after that the gesture is
// known, and a nudge that never stops appearing is a nudge you stop reading.
//
// THE THREE-SECOND HINT OFFER. A wrong click asks whether they want a hint, and
// that offer counts itself down from 3 and disappears. Not answering is a real
// answer here — it means "no, I'm still looking" — so the offer must not sit
// there waiting and must not need to be dismissed before play continues. It can
// be dismissed early, which is the same outcome arriving sooner.
//
// (dev0899) THE SUMMARY ON THE WAY OUT. Exit, Esc and running out of questions
// all end the quiz the same way and put up one panel: every wrong answer as
// "chose X for Y", then the names that were got right, then the time, then the
// congratulations. Dismissed by a click anywhere. The poll ending a quiz because
// the grid was closed is NOT one of those endings and stays silent.
//
// (dev0913) A BIGGER LOOK, AND A HINT THAT STAYS. Four changes, all of them the
// same complaint from a phone -- the board is small and the quiz was hurrying:
//
//   SWIPE RIGHT on any cell opens it FULL WINDOW, and a swipe left in there
//     comes back to the board with the question still in the middle. Not an
//     answer, not scored. A card opens as its PICTURE ALONE (see openBig) --
//     opening the row itself would print the answer. Because a press on a cell
//     can now be either a swipe or a choice, the choice is read on POINTER-UP.
//   THE HINT OFFER waits 5 seconds instead of 3: three is about how long it
//     takes to read the offer and reach the button, so wanting a hint was a race.
//   A HINT TAKEN STAYS UP, under the name in the same panel, until a cell is
//     picked -- it used to flash for three seconds and remove itself, so the two
//     things needed together were never on screen together.
//   THE NAME IS SIZED AS A SHARE OF THE SCREEN (panelFont) and the "click to
//     continue" balloon is pinned to the CORNER OF THE CARD rather than to the
//     pointer -- on a phone there is no pointer to put it beside, and the
//     coordinates it used were in the unrotated frame, so it landed nowhere near
//     the card it was about.
//
// (dev0901) q IS THE KEY, on any grid holding flash cards. core.js's bare-q in
// G (reset an embed) asks QuizCells.available() first and yields to it; Shift+Q
// still resets every embed, so nothing is lost on a grid that has both.
//
// ── CUT-OUT INSTRUCTIONS — to remove the feature entirely, zero grid impact:
//   1. delete this file
//   2. delete 'quizcells.js' from the files[] array in index.html
//   2b. in core.js, drop the QuizCells.available() branch from the bare-q
//       grid block, which hands q back to gridNewEmbed
//   3. in grid.js, the dev0896 window._gridCardParts / window._gridCardTurn
//      exports become unused (harmless — leave them, other callers may want them)
// Nothing else references it.
// ══════════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var BALLOON_N = 2;      // corrects that still get the "click to continue" nudge
  var ASK_MS    = 5000;   // how long the "want a hint?" offer waits
  var SWIPE_PX  = 45;     // (dev0913) a drag this far across is a swipe, not an answer

  var active    = false;
  var queue     = [];     // questions still to ask, already shuffled
  var cur       = null;   // { sci, common }
  var right     = 0, wrong = 0;
  var hits      = [];     // (dev0899) names answered correctly, in the order asked
  var askedIds  = null;   // (dev0901) Set of card ids already put as a question
  var total     = 0;      // (dev0901) questions in this run, top-ups included
  var misses    = [];     // (dev0899) { chose, want } -- one entry per wrong click
  var startedAt = 0;
  var hintHtml  = null;   // (dev0913) the hint for THIS question, once asked for
  var gStart    = null;   // (dev0913) where the current press started, for swipe vs tap
  var awaiting  = false;  // a click on a cell is meaningful right now
  var reading   = false;  // (dev0898) a card is turned over, waiting to be clicked past
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

  // (dev0913) The VISUAL frame, not the device one: on a portrait phone the whole
  // UI is drawn inside #rotateWrap under a rotate(90deg), so window.innerWidth is
  // the short side of a screen the player is reading long-ways. salViewport() is
  // the app's own answer to that (grid.js's _gridClampContextMenu uses it for the
  // same reason) and this falls back to the raw window where it is missing.
  function vpFrame() {
    try {
      if (typeof window.salViewport === 'function') {
        var v = window.salViewport();
        if (v && v.w) return v;
      }
    } catch (_) {}
    return { w: window.innerWidth, h: window.innerHeight };
  }

  function isPhone() {
    try { return !!(typeof _isMobileDevice === 'function' && _isMobileDevice()); }
    catch (_) { return false; }
  }

  // (dev0913) THE PANEL IS SIZED AS A SHARE OF THE SCREEN, NOT IN PIXELS. 15px on
  // a 1140px desktop window is a caption; the same 15px on a phone whose visual
  // frame is 700px across is a headline, and the name in the middle of the board
  // was covering the cells it was asking about. So the type is the SAME FRACTION
  // of the frame it is drawn on -- w/76, which is exactly 15 at 1140 -- floored at
  // 9px, below which a scientific name stops being readable at all.
  //
  // Desktop keeps the flat 15: a big monitor would otherwise scale the name UP,
  // and it was never too small there.
  function panelFont() {
    if (!isPhone()) return 15;
    var w = Math.max(240, vpFrame().w || 320);
    return Math.max(9, Math.min(15, Math.round(w / 76)));
  }

  // V (the full-window view) sits on #gridFullscreen at z 28500, ABOVE the grid
  // and every panel of ours. While it is up the quiz is a spectator: its Esc
  // belongs to V's close, and its overlay hears no clicks anyway.
  function fsOpen() {
    var f = document.getElementById('gridFullscreen');
    return !!(f && f.style.display && f.style.display !== 'none');
  }

  // Wrap-local coordinates -- the same mapping grid.js's own swipe handlers use,
  // so "right" means right as the player sees it on a rotated portrait phone.
  function xy(e) {
    try { if (window.rotateXY) return window.rotateXY(e); } catch (_) {}
    return { x: e.clientX, y: e.clientY };
  }

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

  // (dev0900) The row's own identity, and the question as the player sees it.
  // uid distinguishes two cards that read alike; key is what a click is judged
  // against, because the key IS the question — matching on anything the player
  // was not shown would be scoring them on information they never had.
  function uidOf(row) {
    var u = row && (row.UID != null ? row.UID : row.uid);
    return u == null ? '' : String(u);
  }
  function keyOf(sp) {
    if (!sp || !sp.sci) return '';
    return (sp.sci + '|' + (sp.common || '')).toLowerCase();
  }
  // What to call a card in the summary. The common name off the <h1> is the
  // half that tells two Majoidea apart, so it leads.
  function labelOf(sp) {
    if (!sp || !sp.sci) return 'an unidentified card';
    return sp.common ? (sp.common + ' (' + sp.sci + ')') : sp.sci;
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

  // (dev0901) SPREAD THE REPEATS. Two cards of one animal are two questions
  // (there really are two Blacksmiths on the grid), but drawn back to back the
  // second one reads as the quiz stuttering rather than as a second picture.
  // Each member of a group of m gets a slot at (i + a random fraction) / m, so a
  // pair lands around a quarter and three quarters of the way through and a lone
  // card lands anywhere; sorting on that slot gives an order that is random but
  // never clumps a name. Cheaper and steadier than shuffling and re-shuffling
  // until no two neighbours match, which can fail to terminate.
  function spread(items, keyFn) {
    var groups = {};
    items.forEach(function (it) {
      var k = keyFn(it);
      (groups[k] || (groups[k] = [])).push(it);
    });
    var out = [];
    Object.keys(groups).forEach(function (k) {
      var g = shuffle(groups[k].slice());
      g.forEach(function (it, i) {
        out.push({ slot: (i + Math.random()) / g.length, it: it });
      });
    });
    out.sort(function (a, b) { return a.slot - b.slot; });
    var seq = out.map(function (x) { return x.it; });
    // The slots BIAS a pair apart, they do not guarantee it -- over twenty
    // thousand replays of the real 13-question grid the two Blacksmiths still
    // came out back to back one run in forty. So walk the order once and, where
    // two neighbours share a key, swap the second one with the nearest later
    // entry that does not. One pass, no retries, and it can only fail when the
    // repeats genuinely outnumber the gaps between them.
    for (var i = 1; i < seq.length; i++) {
      if (keyFn(seq[i]) !== keyFn(seq[i - 1])) continue;
      for (var j = i + 1; j < seq.length; j++) {
        if (keyFn(seq[j]) === keyFn(seq[i - 1])) continue;
        if (j + 1 < seq.length && keyFn(seq[j + 1]) === keyFn(seq[i])) continue;
        var t = seq[i]; seq[i] = seq[j]; seq[j] = t;
        break;
      }
    }
    return seq;
  }

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
      // (dev0901) The card count is in here on purpose: how many questions this
      // run actually built is the one number that says whether the quiz is
      // covering the grid, and it was invisible when a run ended short.
      var n = total ? (Math.min(total, total - queue.length) + '/' + total) : '';
      tal.innerHTML = '<span style="color:#7e7;">&#10003; ' + right + '</span>'
        + '<span style="opacity:.35;padding:0 6px;">|</span>'
        + '<span style="color:#f88;">&#10007; ' + wrong + '</span>'
        + '<span style="opacity:.35;padding:0 6px;">|</span>'
        + '<span style="opacity:.75;">' + elapsed() + '</span>'
        + (n ? '<span style="opacity:.35;padding:0 6px;">|</span>'
             + '<span style="opacity:.6;">' + n + '</span>' : '');
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
  //
  // (dev0913) Everything about the box is derived from panelFont() -- the padding
  // and the corner radius as well as the type -- so a phone gets a SMALLER PANEL
  // rather than desktop chrome wrapped around smaller words.
  function centrePanel(id, html, opacity) {
    drop(id);
    var ov = overlay(); if (!ov) return null;
    var fs  = panelFont();
    var padY = Math.round(fs * 1.05), padX = Math.round(fs * 1.6);
    var el = document.createElement('div');
    el.id = id;
    el.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);'
      + 'z-index:28040;pointer-events:none;max-width:min(560px,86vw);max-height:70vh;'
      + 'overflow:hidden;opacity:' + (opacity == null ? 1 : opacity) + ';'
      + 'background:#0c0e14;color:#eef;'
      + 'border:1px solid rgba(255,255,255,0.22);border-radius:' + Math.round(fs * 0.8) + 'px;'
      + 'padding:' + padY + 'px ' + padX + 'px;text-align:center;'
      + 'box-shadow:0 10px 40px rgba(0,0,0,0.7);'
      + 'font:' + fs + 'px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;';
    el.innerHTML = html;
    ov.appendChild(el);
    return el;
  }

  // (dev0897) THE NAME STAYS UP UNTIL A CELL IS PICKED. The first draft flashed
  // it for a second, which made the quiz a memory test on top of an
  // identification test -- two things at once, and the wrong one was the hard
  // one. Now it hangs there while the player looks, takes no clicks
  // (pointer-events:none, see centrePanel), and is dropped the moment a cell is
  // chosen, by onCorrect / onWrong.
  //
  // (dev0898) OPAQUE. It was tried at half transparency so the cell underneath
  // stayed visible, and the name became the hard thing on screen to read --
  // which is the one thing that must stay easy. The panel is small and the grid
  // has two dozen other cells; covering one costs less than a dim question.
  //
  // (dev0913) THE HINT IS PART OF THE QUESTION, not a panel of its own. It used to
  // be a second centred box that replaced the name for three seconds and then took
  // itself away -- so the two things you need at once, WHAT you are looking for and
  // WHAT NARROWS IT DOWN, were never on screen together, and the hint was gone by
  // the time it had been read. Now it hangs under the name in the same box and
  // lives exactly as long: until a cell is picked.
  function showQuestion() {
    if (!cur) return;
    var common = cur.common
      ? '<div style="font-size:0.95em;opacity:0.8;">' + esc(cur.common) + '</div>'
      : '<div style="font-size:0.8em;opacity:0.4;font-style:italic;">no common name</div>';
    var hint = hintHtml
      ? '<div style="margin-top:11px;padding-top:9px;'
        + 'border-top:1px solid rgba(255,255,255,0.16);">'
        + '<div style="font-size:0.72em;letter-spacing:0.08em;opacity:0.5;'
        + 'text-transform:uppercase;margin-bottom:6px;">hint</div>'
        + '<div style="text-align:left;font-size:0.92em;">' + hintHtml + '</div></div>'
      : '';
    centrePanel('quizPrompt',
      '<div style="font-size:1.35em;font-style:italic;letter-spacing:0.01em;">'
      + esc(cur.sci) + '</div>' + common + hint);
  }

  // ── the hint offer: a button that counts itself down and leaves ───────────
  // NOT answering is an answer here — it means "no, I'm still looking" — so
  // this never blocks and never has to be dismissed before play continues. The
  // countdown sits on the button so the player can see how long they have
  // rather than being surprised by it vanishing.
  //
  // (dev0913) FIVE seconds, not three. Three is about as long as it takes to
  // read the offer and find the button, which made taking a hint a race; the
  // player who wanted one and was still moving their hand got a refusal they
  // never gave. The starting number on the button is read off ASK_MS so the
  // two cannot drift.
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
      + 'Hint <span id="quizHintCount" style="opacity:.65;font-weight:400;">'
      + Math.ceil(ASK_MS / 1000) + '</span></button>'
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
  //
  // (dev0913) It is STORED, not shown: showQuestion draws it under the name, and
  // it stays there for the rest of this question. There is no timer -- how long a
  // hint is worth looking at is the same judgement as how long a card back is
  // (see dev0898 at onCorrect), and it belongs to the player.
  function showHint() {
    var target = targetCell(cur);
    var parts  = target ? cardParts(target) : null;
    var body   = (parts && parts.sections && parts.sections[0]) || '';
    hintHtml = body
      ? (typeof renderFtext === 'function' ? renderFtext(body) : body)
      : '<em style="opacity:.6;">this card has nothing written on its back</em>';
    resume();
  }

  // Back to the grid with the question still open, and the name back on screen
  // to stay -- it was dropped by the wrong click that got us here.
  function resume() {
    if (!active) return;
    awaiting = true;
    showQuestion();
  }

  // ── the questions ─────────────────────────────────────────────────────────
  // (dev0900) ONE QUESTION PER CELL — see the header. Nothing is deduped: two
  // cards of one species are two questions, because they are two cards, and
  // going through all of them is the point. Cards with no name yet (f0) are not
  // questions.
  // (dev0901) A card's identity for "have I asked about this one yet". uid when
  // the row has one, the cell it is sitting in when it does not, so a row with
  // no UID still counts as one card rather than colliding with every other.
  function idOf(cell) {
    return uidOf(cell._rowData) || ('cell:' + (cell.dataset ? cell.dataset.cell : ''));
  }

  function questionFor(cell) {
    var sp = speciesOf(cell._rowData);
    if (!sp || !sp.sci) return null;
    return {
      id:     idOf(cell),
      uid:    uidOf(cell._rowData),
      sci:    sp.sci,
      common: sp.common || '',
      key:    keyOf(sp)
    };
  }

  function buildQueue() {
    var out = [];
    cardCells().forEach(function (c) {
      var q = questionFor(c);
      if (q) out.push(q);
    });
    return spread(out, function (q) { return q.key; });
  }

  // (dev0901) EVERY CARD GETS ASKED, and that is now checked rather than assumed.
  // The queue is a snapshot taken when the quiz started; if it ever runs dry the
  // grid is read again, and any named card that has not been asked about is
  // added. Only when a fresh look at the grid finds nothing left does the run
  // end. A quiz that stopped early used to be invisible -- the button simply
  // went back to saying Quiz -- and this makes finishing a fact about the grid
  // instead of a fact about a list built minutes ago.
  function topUp() {
    var add = [];
    cardCells().forEach(function (c) {
      var q = questionFor(c);
      if (!q || askedIds[q.id]) return;
      add.push(q);
    });
    if (!add.length) return 0;
    queue = queue.concat(spread(add, function (q) { return q.key; }));
    total += add.length;
    return add.length;
  }

  // The cell a question is about: its own row first, then any card showing the
  // same question (the sheephead case). Used by the hint, which needs a card to
  // read the back of.
  function targetCell(q) {
    if (!q) return null;
    var cells = cardCells();
    var byUid = cells.filter(function (c) { return uidOf(c._rowData) === q.uid; });
    if (byUid.length) return byUid[0];
    var byKey = cells.filter(function (c) { return keyOf(speciesOf(c._rowData)) === q.key; });
    return byKey[0] || null;
  }

  function nextQuestion() {
    if (!active) return;
    drop('quizPrompt'); drop('quizAsk'); drop('quizBalloon');
    hintHtml = null;                    // (dev0913) the hint belongs to one question
    if (!queue.length && !topUp()) { report(); return; }
    cur = queue.shift();
    askedIds[cur.id] = 1;
    awaiting = true;
    paintHud();
    showQuestion();
  }

  // (dev0898) THE READ LASTS AS LONG AS THEY WANT. A correct card turns over and
  // STAYS turned; the next click anywhere moves on. A three-second timer was
  // either too short to read the card back or too long to sit through, and it
  // could never be both -- how long an answer is worth looking at is a
  // judgement the player makes, not a constant.
  function onCorrect(cell) {
    awaiting = false;
    right++;
    if (cur) hits.push(cur);
    paintHud();
    drop('quizPrompt');
    // The card's own turn IS the result: it shows the answer it was holding,
    // in the layout it was written for.
    if (typeof window._gridCardTurn === 'function') {
      try { window._gridCardTurn(cell, 0); } catch (_) {}
    }
    reading = true;
    // The nudge, for the first two only: by the third correct answer the
    // gesture has been learned, and a balloon that never stops appearing is a
    // balloon you stop reading. It comes up where the hand already is -- beside
    // the click that earned it -- rather than somewhere they would have to find.
    if (right <= BALLOON_N) showBalloon(cell);
  }

  // (dev0898) "click to continue", for the first two corrects only.
  //
  // (dev0913) IN THE CORNER OF THE CARD, NOT AT THE POINTER. The first build put
  // it beside the mouse and clamped it into the viewport, which has no meaning on
  // a phone: a tap leaves no pointer behind, the coordinates it was placed from
  // are the PHYSICAL ones while the balloon is drawn inside the rotated wrap, and
  // it landed nowhere near the card it was talking about. A corner of the cell
  // that was just turned over is a place that exists on every device.
  //
  // Appended to the CELL, so it needs no coordinates at all and cannot land in
  // the wrong frame. z-index clears the card back's own panel (140).
  // pointer-events:none so the very tap it is asking for passes through it.
  function showBalloon(cell) {
    drop('quizBalloon');
    if (!cell) return;
    var fs = Math.max(9, Math.round(panelFont() * 0.8));
    var b = document.createElement('div');
    b.id = 'quizBalloon';
    b.textContent = (isPhone() ? 'tap' : 'click') + ' to continue';
    b.style.cssText = 'position:absolute;right:6px;bottom:6px;z-index:200;'
      + 'pointer-events:none;max-width:92%;overflow:hidden;'
      + 'background:rgba(250,250,255,0.95);color:#14161c;'
      + 'border-radius:9px;padding:4px 9px;white-space:nowrap;'
      + 'box-shadow:0 4px 16px rgba(0,0,0,0.6);'
      + 'font:' + fs + 'px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;';
    cell.appendChild(b);
  }

  // The click that ends a read: card home, next question.
  function continueOn() {
    reading = false;
    drop('quizBalloon');
    if (typeof window._gridCardFrontAll === 'function') {
      try { window._gridCardFrontAll(); } catch (_) {}   // back to the picture
    }
    nextQuestion();
  }

  // (dev0899) `cell` is what they actually clicked, and it is recorded by NAME:
  // "chose X for Y" is the only line of a quiz summary anyone learns from, and
  // it cannot be reconstructed afterwards -- the cell will have been re-rendered
  // and the question moved on. A card with no identification yet (f0) has no
  // name to give, so it is recorded as the picture it is.
  function onWrong(cell) {
    awaiting = false;
    wrong++;
    var sp = cell ? speciesOf(cell._rowData) : null;
    misses.push({
      chose: labelOf(sp),
      want:  labelOf(cur)
    });
    paintHud();
    drop('quizPrompt');
    // (dev0913) A hint already on this question is not offered a second time --
    // it never went away, so there is nothing to accept. The tally and a one-line
    // toast carry the "no" instead, and the board comes straight back.
    if (hintHtml) {
      if (typeof toast === 'function') toast('Not correct', 900);
      resume();
    } else offerHint();
  }

  // ── clicks ────────────────────────────────────────────────────────────────
  // Capture phase on the container, ahead of .grid-interactor's own pointerdown
  // (play/pause, hold-to-cut, swipe, tap-to-turn) — the same claim turncells.js
  // makes while fun mode is on, and for the same reason: while the quiz is
  // asking, a click on a cell means one thing only.
  //
  // Plain left button / touch only, so Shift-zoom, Alt-COI, Ctrl+click and the
  // right-click menu still work on a grid that happens to be in a quiz.
  //
  // (dev0913) THE ANSWER IS DECIDED ON POINTER-UP, NOT POINTER-DOWN, because a
  // press on a cell is now two different things and only its END says which: let
  // go where you started and it is an answer; drag right and it is a request for
  // a bigger look at that cell (openBig). The press is still swallowed here in
  // capture phase -- the grid's own tap/hold/swipe must not also run -- so
  // nothing else can claim the gesture in between.
  function onPointerDown(e) {
    gStart = null;
    if (!active || fsOpen()) return;
    if (e.button !== undefined && e.button !== 0) return;
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    // The HUD and the hint offer are real buttons and keep their own clicks --
    // Exit has to work while a card is being read.
    if (e.target && e.target.closest
        && e.target.closest('#quizHud, #quizAsk')) return;

    // (dev0898) Reading a turned-over card: ANY click moves on, not only one on
    // a cell, so there is nothing to aim at.
    if (reading) { e.preventDefault(); e.stopPropagation(); continueOn(); return; }

    if (!awaiting) return;
    var cont = container();
    var cell = e.target && e.target.closest ? e.target.closest('.grid-cell') : null;
    if (!cell || !cont || !cont.contains(cell)) return;
    e.preventDefault();
    e.stopPropagation();
    var p = xy(e);
    gStart = { x: p.x, y: p.y, cell: cell };
  }

  function onPointerUp(e) {
    var s = gStart; gStart = null;
    if (!active || !s || !awaiting || fsOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    var p  = xy(e);
    var dx = p.x - s.x, dy = p.y - s.y;

    // SWIPE RIGHT -- a bigger look at this cell. Not an answer, and not scored.
    // The way back is a swipe LEFT inside the full-window view, which is V's own
    // close gesture on both the picture and the video branch and needs nothing
    // from us.
    if (dx > SWIPE_PX && Math.abs(dy) < Math.abs(dx)) { openBig(s.cell); return; }
    // SWIPE LEFT on the board itself: the gesture that means "back", and back
    // from the grid is where we already are. Deliberately inert -- G's own
    // left-swipe pauses the cell or leaves for the menu, and neither of those
    // belongs in the middle of a question.
    if (dx < -SWIPE_PX && Math.abs(dy) < Math.abs(dx)) return;
    // A drag that went somewhere without becoming a swipe answers nothing: an
    // aimed tap does not travel 20px, and scoring a wandering one as a choice
    // would record a miss the player never made.
    if (Math.abs(dx) > 20 || Math.abs(dy) > 20) return;

    judge(s.cell);
  }

  function onPointerCancel() { gStart = null; }

  function judge(cell) {
    if (!cell || !cell._rowData) return;
    // (dev0900) The card itself, or one the player could not have told apart
    // from it. NOT a bare scientific-name match: two different cards can share
    // one — see the Majoidea note in the header.
    var sp = speciesOf(cell._rowData);
    // A row with no UID must never match another row with no UID, so the uid
    // arm only counts when there is one; the key arm still judges those.
    var u  = uidOf(cell._rowData);
    var ok = !!(cur && ((u && u === cur.uid) || keyOf(sp) === cur.key));
    if (ok) onCorrect(cell); else onWrong(cell);
  }

  // ── a bigger look (dev0913) ───────────────────────
  // A grid cell is a fifth of a phone screen, and plenty of these questions turn
  // on a detail -- a spine, a fin ray, the shape of an eye -- that is simply not
  // resolvable at that size. Swipe right and the cell opens full window; swipe
  // left in there and you are back on the board with the question still up,
  // because the quiz's panels live on #gridOverlay and V is a separate overlay
  // laid over the top of it. Nothing is scored either way.
  //
  // A FLASH CARD OPENS AS ITS PICTURE ALONE. The real row is link-less ftext, so
  // gridOpenFullscreen would send it down the TEXT branch and render the card --
  // the picture and every section under it, i.e. the answer to the question that
  // is still on screen (the same trap dev0860 avoided on the grid's own forward
  // swipe). So a card is handed a synthetic picture-only row instead, which
  // falls to the image branch: the same photograph, bigger, and nothing else.
  // Any other cell sharing the board opens as itself -- there is no answer
  // written on a plain photo to give away.
  function openBig(cell) {
    if (!cell || !cell._rowData) return;
    if (typeof gridOpenFullscreen !== 'function') return;
    var row   = cell._rowData;
    var parts = cardParts(cell);
    var open  = row;
    if (parts && parts.imgUrl) {
      open = { UID: row.UID, cell: row.cell, link: parts.imgUrl,
               VidTitle: '', VidRange: '', _quizPeek: true };
    }
    // (dev0913) One-shot: open with V's control bar already collapsed. What the
    // quiz wants is a picture, not a transport -- see vp.js's vpCollapseControls.
    window._vpHideControls = true;
    try { gridOpenFullscreen(open); } catch (_) { window._vpHideControls = false; }
  }

  // Esc leaves the QUIZ before it reaches G's own Esc, which would otherwise
  // close the grid out from under a quiz that is still running.
  //
  // (dev0913) Not while the full-window view is up: there Esc is V's close and
  // the way back to the board. Taking it would end the quiz from inside a peek.
  function onKeyDown(e) {
    if (!active || e.key !== 'Escape' || fsOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    stop(true);
  }

  // (dev0898) Listened for on the OVERLAY rather than on #gridContainer: the
  // click that ends a read may land anywhere, including the gap around the
  // grid, where the container hears nothing. Cell answers still check
  // containment themselves, so nothing outside the grid can answer a question.
  function wire() {
    if (wired) return;
    var ov = overlay(); if (!ov) return;
    ov.addEventListener('pointerdown', onPointerDown, true);
    // (dev0913) The up half of the gesture is heard on the WINDOW rather than on
    // the overlay: a swipe that starts on a cell and finishes past the edge of
    // the grid is exactly the swipe most likely to be a deliberate one, and the
    // overlay would never hear its end.
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerCancel, true);
    window.addEventListener('keydown', onKeyDown, true);
    wired = true;
  }
  function unwire() {
    var ov = overlay();
    if (ov) ov.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('pointercancel', onPointerCancel, true);
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
    active = true; right = 0; wrong = 0; cur = null; reading = false;
    hits = []; misses = []; askedIds = {}; total = queue.length;
    hintHtml = null; gStart = null;     // (dev0913) per-question scraps
    drop('quizSummary'); drop('quizSummaryCatch');
    startedAt = Date.now();
    if (typeof window._gridCardFrontAll === 'function') {
      try { window._gridCardFrontAll(); } catch (_) {}   // start from pictures
    }
    wire();
    paintHud();
    nextQuestion();
  }

  // (dev0899) `summarise` separates the two reasons a quiz ends. Exit, Esc and
  // running out of questions are all the player FINISHING, and they get the
  // summary. The poll calling stop() because the grid was closed or re-rendered
  // out from under the quiz is not an ending anyone asked for, and putting a
  // congratulations panel on top of whatever they navigated to instead would be
  // the app talking over them.
  function stop(summarise) {
    if (!active) return;
    var final = summarise ? { right: right, wrong: wrong, time: elapsed(),
                              hits: hits.slice(), misses: misses.slice() } : null;
    active = false; awaiting = false; reading = false; cur = null; queue = [];
    clearTimers();
    unwire();
    drop('quizPrompt'); drop('quizAsk'); drop('quizBalloon');
    hintHtml = null;                    // (dev0913) the hint belongs to one question
    if (typeof window._gridCardFrontAll === 'function') {
      try { window._gridCardFrontAll(); } catch (_) {}
    }
    paintHud();
    // Built AFTER the teardown, which clears every other panel -- and only when
    // something was actually answered. A quiz opened and shut again has nothing
    // to report, and a congratulations for it would be hollow.
    if (final && (final.right || final.wrong)) showSummary(final);
  }

  // Queue exhausted -- the same ending as pressing Exit, so it takes the same
  // route out and gets the same summary.
  function report() { stop(true); }

  // (dev0899) THE SUMMARY. Read in the order it is useful: what went wrong
  // first (that is the part worth reading, and the part that disappears if it
  // is not written down), then what went right, then the time, then the
  // congratulations. The dismissal line is last and small because it is
  // housekeeping, not content.
  //
  // Dismissed by a click ANYWHERE: a full-screen catcher sits under the panel
  // and takes the click, so there is no button to find and no way to be stuck
  // with it. The panel itself takes clicks too (it must, so a long list can be
  // scrolled with the wheel without the first stray click closing it) and
  // dismisses on the same gesture.
  function showSummary(f) {
    drop('quizSummary'); drop('quizSummaryCatch');
    var ov = overlay(); if (!ov) return;

    var body = '';
    if (f.misses.length) {
      body += '<div style="font-size:0.72em;letter-spacing:0.08em;opacity:0.5;'
        + 'text-transform:uppercase;margin:0 0 6px;">'
        + f.misses.length + (f.misses.length === 1 ? ' wrong answer' : ' wrong answers')
        + '</div><div style="text-align:left;margin-bottom:14px;">'
        + f.misses.map(function (m) {
            return '<div style="margin:3px 0;color:#f9a;">chose <em>' + esc(m.chose)
              + '</em> for <em>' + esc(m.want) + '</em></div>';
          }).join('')
        + '</div>';
    }
    body += '<div style="font-size:0.72em;letter-spacing:0.08em;opacity:0.5;'
      + 'text-transform:uppercase;margin:0 0 6px;">'
      + f.hits.length + (f.hits.length === 1 ? ' correct answer' : ' correct answers')
      + '</div>';
    body += f.hits.length
      ? '<div style="text-align:left;margin-bottom:14px;">'
        + f.hits.map(function (h) {
            return '<div style="margin:3px 0;color:#9e9;"><em>' + esc(h.sci) + '</em>'
              + (h.common ? '<span style="opacity:0.6;"> - ' + esc(h.common) + '</span>' : '')
              + '</div>';
          }).join('')
        + '</div>'
      : '<div style="opacity:0.45;font-style:italic;margin-bottom:14px;">none this time</div>';

    body += '<div style="opacity:0.75;margin-bottom:16px;">Time on quiz '
      + esc(f.time) + '</div>';
    body += '<div style="font-size:1.15em;color:#cfe;">'
      + 'Congratulations on completing this quiz!</div>';
    body += '<div style="font-size:0.78em;opacity:0.45;margin-top:10px;">'
      + 'click anywhere on screen to dismiss</div>';

    var catcher = document.createElement('div');
    catcher.id = 'quizSummaryCatch';
    catcher.style.cssText = 'position:fixed;inset:0;z-index:28060;background:rgba(0,0,0,0.35);';

    var box = document.createElement('div');
    box.id = 'quizSummary';
    box.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);'
      + 'z-index:28061;max-width:min(560px,88vw);max-height:76vh;overflow-y:auto;'
      + 'background:#0c0e14;color:#eef;border:1px solid rgba(255,255,255,0.22);'
      + 'border-radius:12px;padding:20px 26px;text-align:center;cursor:pointer;'
      + 'box-shadow:0 12px 48px rgba(0,0,0,0.75);'
      + 'font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;';
    box.innerHTML = body;

    function dismiss(e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      drop('quizSummary'); drop('quizSummaryCatch');
    }
    catcher.addEventListener('pointerdown', dismiss, true);
    box.addEventListener('pointerdown', dismiss, true);

    ov.appendChild(catcher);
    ov.appendChild(box);
  }

  function toggle() { if (active) stop(true); else start(); }

  // ── presence ──────────────────────────────────────────────────────────────
  // Slow poll — see the header note on why this is not a call from gridShow.
  // It doubles as the clock the tally shows, and as the safety net that ends a
  // quiz when the grid is closed by any of the several paths that write
  // gridOverlay.style.display directly.
  setInterval(function () {
    // (dev0901) THE GRID BEING CLOSED IS THE ONLY THING THAT ENDS A RUNNING QUIZ
    // from out here. It used to also stop on an empty card scan, which is a
    // transient any time the grid re-renders (a buffer-mode change, a paste, a
    // size key all rebuild every cell): for the tick where #gridContainer is
    // empty the quiz would be torn down silently, mid-run, with no summary and
    // no explanation. Questions are held as DATA -- uid, name, key -- and cells
    // are looked up again on every click, so a re-render costs a running quiz
    // nothing and there is no reason to end it.
    if (!gridOpen()) {
      if (active) stop(false);            // not an ending they chose -- no summary
      drop('quizHud'); drop('quizSummary'); drop('quizSummaryCatch');
      return;
    }
    if (!active && !hasCards()) { drop('quizHud'); return; }
    paintHud();
  }, 500);

  window.QuizCells = {
    start: start,
    stop: stop,
    toggle: toggle,
    // (dev0901) core.js's bare-q handler asks this before spending the key.
    // A RUNNING quiz always answers yes, so q can always leave one -- otherwise
    // a re-render emptying the cell scan for a tick would hand q back to the
    // embed reset while the quiz was still on screen.
    available: function () { return active || (gridOpen() && hasCards()); },
    get active() { return active; },
    get score() { return { right: right, wrong: wrong, left: queue.length }; }
  };
})();
