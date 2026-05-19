
// ══════════════════════════════════════════════════════════════════════════════
// GRID FULLSCREEN VIDEO PLAYER (VP)
// ══════════════════════════════════════════════════════════════════════════════

let _vpState = null; // { row, player, segs, segIdx, isSelected, speed, muted, ccOn, aPoint, bPoint }

// Quiz HTML builder
// Handles two JSON formats:
// Format A (simple): array of {question, options:string[], correct:int, explanation, hint}
// Format B (rich):   object {title, questions:[{question, options:[{label,text,isCorrect,rationale}],
//                            hint, correctAnswer}]}  OR array of same rich question objects
function buildQuizHtml(parsed, titleFallback) {
  // Normalise to {title, questions:[]}
  let title = titleFallback || 'Quiz';
  let questions = [];
  if (Array.isArray(parsed)) {
    questions = parsed;
  } else if (parsed && typeof parsed === 'object') {
    if (parsed.title) title = parsed.title;
    if (Array.isArray(parsed.questions)) questions = parsed.questions;
    else if (Array.isArray(parsed.items)) questions = parsed.items;
  }
  if (!questions.length) return '<body style="font:14px monospace;padding:20px;color:#f44;">No questions found in JSON</body>';

  // Normalise each question: { qtext, opts:[{letter,text,rationale}], correctIdx, hint }
  const qs = questions.map((q) => {
    const qtext = q.question || q.q || '';
    let opts = [], correctIdx = -1;
    if (Array.isArray(q.options) && q.options.length) {
      if (typeof q.options[0] === 'string') {
        opts = q.options.map((o, j) => ({ letter: String.fromCharCode(65+j), text: o, rationale: '' }));
        correctIdx = (typeof q.correct === 'number') ? q.correct : -1;
      } else {
        opts = q.options.map((o, j) => ({
          letter: o.label || String.fromCharCode(65+j),
          text:   o.text || o.label || '',
          rationale: o.rationale || ''
        }));
        const ca = q.correctAnswer || q.correct_answer || '';
        correctIdx = opts.findIndex((o, j) =>
          q.options[j].isCorrect === true || (ca && o.letter === ca));
      }
    }
    return { qtext, opts, correctIdx, hint: q.hint || '' };
  });

  const safeTitle = escH(title);
  const rawTitle  = title; // for JS use (JSON-safe via JSON.stringify below)

  // Build question HTML
  let qHtml = '';
  qs.forEach((q, i) => {
    const optsHtml = q.opts.map((o, j) =>
      `<li class="opt" id="opt-${i}-${j}" onclick="var inp=this.querySelector('input:not([disabled])');if(inp){inp.checked=true;}">` +
      `<label style="pointer-events:none;"><input type="radio" name="q${i}" value="${j}" style="pointer-events:none;"> ` +
      `<strong>${escH(o.letter)}.</strong> ${escH(o.text)}</label>` +
      `<div class="rat" id="rat-${i}-${j}"></div></li>`
    ).join('');
    const hintHtml = q.hint
      ? `<button class="btn-hint" onclick="th(${i})">Hint</button>` +
        `<div class="hint-box" id="h${i}">${escH(q.hint)}</div>`
      : '';
    qHtml += `<div class="q">
      <h3>${i+1}. ${escH(q.qtext)}</h3>
      <ul class="opts">${optsHtml}</ul>
      ${hintHtml}
      <div class="fb" id="fb${i}"></div>
    </div>`;
  });

  const jsData = JSON.stringify(qs.map(q => ({
    correctIdx: q.correctIdx,
    opts: q.opts
  })));

  const js = `
var D=${jsData};
var TITLE=${JSON.stringify(rawTitle)};
var sc=0,ah=false,startTime=Date.now(),endTime=null,checked=false;

// Timer
var _timerEl=null;
function _tick(){
  if(!_timerEl)return;
  var s=Math.floor((Date.now()-startTime)/1000);
  var m=Math.floor(s/60); s=s%60;
  _timerEl.textContent='\u23f1 '+m+':'+(s<10?'0':'')+s+(checked?' (done)':'');
}
window.addEventListener('load',function(){
  _timerEl=document.getElementById('timer');
  setInterval(_tick,1000); _tick();
  // Download blank quiz silently at start (no browser multiple-download prompt later)
  setTimeout(buildBlankSilent, 800);
});

// Hint toggles
function th(i){var b=document.getElementById('h'+i);
  var on=b.classList.contains('vis');b.classList.toggle('vis',!on);
  b.previousElementSibling.textContent=on?'Hint':'Hide Hint';}
function tah(){ah=!ah;
  document.querySelectorAll('.hint-box').forEach(function(b){b.classList.toggle('vis',ah);});
  document.querySelectorAll('.btn-hint').forEach(function(b){b.textContent=ah?'Hide Hint':'Hint';});
  document.getElementById('hbtn').textContent=ah?'Hide All Hints':'Show All Hints';}

// Score bar
function upd(n,tot){
  var p=tot?Math.round(n/tot*100):0;
  var el=document.getElementById('score-bar');
  el.textContent='Score: '+n+' / '+tot+' ('+p+'%)';
  el.style.background=p>=80?'linear-gradient(135deg,#27ae60,#2ecc71)':
    p>=60?'linear-gradient(135deg,#f39c12,#e67e22)':'linear-gradient(135deg,#e74c3c,#c0392b)';}

// Toast notification
function toast(msg,ms){
  var t=document.getElementById('qtoast');
  if(!t){t=document.createElement('div');t.id='qtoast';
    t.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);'+
      'background:#222;color:#fff;padding:12px 22px;border-radius:8px;font-size:14px;'+
      'z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,0.4);pointer-events:none;transition:opacity .4s;';
    document.body.appendChild(t);}
  t.textContent=msg;t.style.opacity='1';
  clearTimeout(t._tid);
  t._tid=setTimeout(function(){t.style.opacity='0';},ms||3000);}

// Exit: notify + signal parent to close
function exitQuiz(){
  // Save answered quiz
  var taker=(document.getElementById('qname')||{value:''}).value.trim()||'anon';
  var mins=endTime?Math.round((endTime-startTime)/60000):0;
  var fn=_slug(TITLE)+'_'+_slug(taker)+'_'+_tsMin(new Date(endTime||Date.now()))+'_'+mins+'min_'+sc+'of'+D.length+'.html';
  var ahtml='<!DOCTYPE html>'+document.documentElement.outerHTML;
  var a1=document.createElement('a');
  a1.href=URL.createObjectURL(new Blob([ahtml],{type:'text/html'}));
  a1.download=fn;document.body.appendChild(a1);a1.click();
  document.body.removeChild(a1);URL.revokeObjectURL(a1.href);
  toast('\u2713 Answered quiz saved',3000);
  setTimeout(function(){
    try{ window.parent.postMessage({type:'quizExit'},'\u002a'); }catch(e){}
  },1200);
}

function buildBlankSilent(){
  var clone=document.documentElement.cloneNode(true);
  clone.querySelectorAll('.fb').forEach(function(el){el.style.display='none';el.textContent='';});
  clone.querySelectorAll('.rat').forEach(function(el){el.style.cssText='';el.className='rat';el.innerHTML='';});
  clone.querySelectorAll('input[type=radio]').forEach(function(inp){inp.checked=false;inp.disabled=false;});
  clone.querySelectorAll('.opt').forEach(function(li){li.classList.remove('opt-correct','opt-wrong','opt-neutral');});
  clone.querySelectorAll('.hint-box').forEach(function(b){b.classList.remove('vis');});
  var sb=clone.querySelector('#score-bar');
  if(sb){sb.textContent='Score: 0 / '+D.length+' (0%)';sb.style.background='linear-gradient(135deg,#667eea,#764ba2)';}
  clone.querySelectorAll('.btn-exit').forEach(function(b){
    b.textContent='\u2713 Check Answers';b.className='btn-check';});
  clone.querySelectorAll('.btn-blank-wrap').forEach(function(w){w.style.display='none';});
  var ti=clone.querySelector('#timer');if(ti)ti.textContent='\u23f1 0:00';
  var qn=clone.querySelector('#qname');if(qn)qn.value='';
  var now=new Date();
  var bfn=_slug(TITLE)+'_blank_'+_tsMin(now)+'.html';
  var a2=document.createElement('a');
  a2.href=URL.createObjectURL(new Blob(['<!DOCTYPE html>'+clone.outerHTML],{type:'text/html'}));
  a2.download=bfn;document.body.appendChild(a2);a2.click();
  document.body.removeChild(a2);URL.revokeObjectURL(a2.href);
}

// Switch buttons after submission
function _showExitBtns(){
  document.querySelectorAll('.btn-check').forEach(function(b){
    b.textContent='\u2715 Exit Quiz';
    b.className='btn-exit';
    b.onclick=exitQuiz;
  });
  document.querySelectorAll('.btn-blank-wrap').forEach(function(w){w.style.display='inline-flex';});}

// Check Answers
function chk(){
  if(checked)return;
  endTime=Date.now();checked=true;_tick();
  sc=0;
  D.forEach(function(q,i){
    var s=document.querySelector('input[name="q'+i+'"]:checked');
    var chosen=s?parseInt(s.value):-1;
    var f=document.getElementById('fb'+i);
    q.opts.forEach(function(o,j){
      var li=document.getElementById('opt-'+i+'-'+j);
      var rat=document.getElementById('rat-'+i+'-'+j);
      var isCorrect=(j===q.correctIdx);
      var isChosen=(j===chosen);
      if(li){
        li.classList.remove('opt-correct','opt-wrong','opt-neutral');
        if(isCorrect) li.classList.add('opt-correct');
        else if(isChosen) li.classList.add('opt-wrong');
        else li.classList.add('opt-neutral');
        var inp=li.querySelector('input');if(inp)inp.disabled=true;
      }
      if(rat){
        rat.className='rat';
        if(isCorrect) rat.classList.add('rat-correct');
        else if(isChosen) rat.classList.add('rat-wrong');
        else rat.classList.add('rat-neutral');
        var icon=isCorrect?'\u2713 ':isChosen?'\u2717 ':'\u2022 ';
        rat.innerHTML='<em>'+icon+(o.rationale||'')+'</em>';
      }
    });
    if(f){
      f.style.display='block';
      if(chosen===-1){
        f.className='fb skipped';f.textContent='\u2014 Not answered';
      } else if(chosen===q.correctIdx){
        sc++;f.className='fb correct';f.textContent='\u2713 Correct!';
      } else {
        var cOpt=q.opts[q.correctIdx]||{};
        f.className='fb incorrect';
        f.textContent='\u2717 Correct: '+cOpt.letter+'. '+cOpt.text;
      }
    }
  });
  document.querySelectorAll('.hint-box').forEach(function(b){b.classList.add('vis');});
  document.querySelectorAll('.btn-hint').forEach(function(b){b.textContent='Hide Hint';});
  ah=true;document.getElementById('hbtn').textContent='Hide All Hints';
  upd(sc,D.length);
  _showExitBtns();
  window.scrollTo({top:0,behavior:'smooth'});
}

// Reset
function rst(){
  sc=0;checked=false;endTime=null;startTime=Date.now();ah=false;
  document.querySelectorAll('.fb').forEach(function(f){f.style.display='none';});
  D.forEach(function(q,i){
    q.opts.forEach(function(o,j){
      var li=document.getElementById('opt-'+i+'-'+j);
      if(li){li.classList.remove('opt-correct','opt-wrong','opt-neutral');
        var inp=li.querySelector('input');if(inp){inp.disabled=false;inp.checked=false;}}
      var rat=document.getElementById('rat-'+i+'-'+j);
      if(rat){rat.style.cssText='';rat.className='rat';rat.innerHTML='';}
    });
  });
  document.querySelectorAll('.hint-box').forEach(function(b){b.classList.remove('vis');});
  document.querySelectorAll('.btn-hint').forEach(function(b){b.textContent='Hint';});
  document.getElementById('hbtn').textContent='Show All Hints';
  document.querySelectorAll('.btn-exit').forEach(function(b){
    b.textContent='\u2713 Check Answers';b.className='btn-check';b.onclick=chk;});
  document.querySelectorAll('.btn-blank-wrap').forEach(function(w){w.style.display='none';});
  upd(0,D.length);}

// Filename helpers
function _slug(s){return (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');}
function _tsMin(d){
  return d.getFullYear()+'-'
    +String(d.getMonth()+1).padStart(2,'0')+'-'
    +String(d.getDate()).padStart(2,'0')+'_'
    +String(d.getHours()).padStart(2,'0')
    +String(d.getMinutes()).padStart(2,'0');}


`;

  const css = `
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:Arial,sans-serif;max-width:860px;margin:0 auto;padding:20px;
     background:#f5f5f5;line-height:1.5;color:#111;}
h1{text-align:center;color:#111;margin-bottom:10px;}
#meta-bar{display:flex;align-items:center;justify-content:center;gap:16px;flex-wrap:wrap;margin-bottom:12px;}
#name-wrap{display:flex;align-items:center;gap:6px;font-size:14px;color:#111;}
#qname{border:1px solid #bbb;border-radius:5px;padding:5px 9px;font-size:14px;
       font-family:inherit;width:200px;outline:none;color:#111;}
#qname:focus{border-color:#3498db;box-shadow:0 0 0 2px rgba(52,152,219,0.25);}
#timer{font-size:14px;color:#111;font-family:monospace;background:#ddd;
       padding:4px 10px;border-radius:5px;min-width:90px;text-align:center;}
#score-bar{font-size:1.15em;font-weight:bold;padding:12px;color:#fff;border-radius:8px;
           text-align:center;margin-bottom:14px;background:linear-gradient(135deg,#667eea,#764ba2);}
.controls{margin-bottom:14px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap;align-items:center;}
.q{margin-bottom:22px;padding:18px;border:2px solid #ccc;border-radius:10px;background:#fff;}
.q h3{color:#111;margin-bottom:12px;font-size:1em;font-weight:bold;}
.opts{list-style:none;padding:0;display:flex;flex-direction:column;gap:0;}
.opt{margin:0;padding:11px 13px;background:#f9f9f9;border-radius:0;
     border-left:4px solid #3498db;border-bottom:1px solid #e0e0e0;
     transition:border-color .15s,background .15s;cursor:pointer;}
.opts .opt:first-child{border-radius:6px 6px 0 0;}
.opts .opt:last-child{border-radius:0 0 6px 6px;border-bottom:none;}
.opts .opt:only-child{border-radius:6px;border-bottom:none;}
.opt:hover{background:#eef4ff !important;cursor:pointer;}
.opt-correct:hover,.opt-wrong:hover,.opt-neutral:hover{cursor:default;}
.opt label{cursor:pointer;display:block;color:#111;font-size:14px;}
.opt input[type=radio]{margin-right:8px;cursor:pointer;
  appearance:none;-webkit-appearance:none;
  width:15px;height:15px;border:2px solid #888;border-radius:50%;
  vertical-align:middle;position:relative;top:-1px;flex-shrink:0;
  background:#fff;transition:border-color .1s,background .1s;}
.opt input[type=radio]:checked{border-color:#111;background:#111;
  box-shadow:inset 0 0 0 3px #fff;}
.opt input[type=radio][disabled]{cursor:default;}
.opt input[type=radio][disabled]:checked{border-color:#111;background:#111;
  box-shadow:inset 0 0 0 3px #fff;}
.opt-correct input[type=radio][disabled]:checked{border-color:#1a6630;background:#1a6630;
  box-shadow:inset 0 0 0 3px #fff;}
.opt-wrong input[type=radio][disabled]:checked{border-color:#8b1a1a;background:#8b1a1a;
  box-shadow:inset 0 0 0 3px #fff;}
.opt-correct{background:#c8f5d8 !important;border-left-color:#27ae60 !important;}
.opt-wrong  {background:#fcd6d0 !important;border-left-color:#e74c3c !important;}
.opt-neutral{background:#fff !important;border-left-color:#3498db !important;}
/* Rationale: italic, same font-size as answers, colored backgrounds */
.rat{display:none;font-size:14px;font-style:italic;margin-top:7px;
     padding:8px 12px;border-radius:4px;line-height:1.55;border-left:3px solid transparent;color:#111;}
.rat-correct{display:block;background:#d4f5e2;border-left-color:#27ae60;}
.rat-wrong  {display:block;background:#fce4e1;border-left-color:#e74c3c;}
.rat-neutral{display:block;background:#fff;border-left-color:#bbb;}
.fb{padding:10px;border-radius:6px;margin-top:12px;font-weight:bold;
    display:none;font-size:14px;color:#111;}
.correct {background:#c8f5d8;border:1px solid #27ae60;}
.incorrect{background:#fcd6d0;border:1px solid #e74c3c;}
.skipped  {background:#e8e8e8;border:1px solid #aaa;}
.hint-box{display:none;background:#fff8d6;padding:10px;border-radius:6px;
          margin-top:9px;border-left:4px solid #f0c020;font-style:italic;
          font-size:14px;color:#111;}
.hint-box.vis{display:block;}
button{padding:8px 16px;border:none;border-radius:6px;cursor:pointer;
       font-size:13px;color:#fff;font-family:inherit;}
.btn-check{background:#27ae60;} .btn-check:hover{background:#219a52;}
.btn-exit {background:#c0392b;} .btn-exit:hover{background:#a93226;}
.btn-blank{background:#2471a3;} .btn-blank:hover{background:#1a5276;}
.btn-reset{background:#7f8c8d;} .btn-reset:hover{background:#707b7c;}
.btn-hints{background:#e67e22;} .btn-hints:hover{background:#ca6f1e;}
.btn-hint{background:#e0a800;font-size:12px;padding:4px 10px;margin-top:7px;display:inline-block;}
.btn-blank-wrap{display:none;}`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${safeTitle}</title>
<style>${css}</style></head><body>
<h1>${safeTitle}</h1>
<div id="meta-bar">
  <div id="name-wrap">
    <label for="qname">Name:</label>
    <input id="qname" type="text" placeholder="Your name (optional)" maxlength="60" autocomplete="off">
  </div>
  <div id="timer">\u23f1 0:00</div>
</div>
<div id="score-bar">Score: 0 / ${qs.length} (0%)</div>
<div class="controls">
  <button class="btn-check" onclick="chk()">\u2713 Check Answers</button>
  <button class="btn-reset" onclick="rst()">\u21ba Reset</button>
  <button class="btn-hints" id="hbtn" onclick="tah()">Show All Hints</button>
</div>
${qHtml}
<div class="controls">
  <button class="btn-check" onclick="chk()">\u2713 Check Answers</button>
  <button class="btn-reset" onclick="rst()">\u21ba Reset</button>
</div>
<script>${js}<\/script></body></html>`;
}


function gridOpenFullscreen(row, contained) {
  // (zip0122) Update last-record memory
  if (row && row.UID && typeof window.setLastUID === 'function') {
    window.setLastUID(row.UID);
  }

  const fs = document.getElementById('gridFullscreen');
  const content = document.getElementById('gridFsContent');
  const info = document.getElementById('gridFsInfo');
  
  content.innerHTML = '';
  // (zip0144) Reset content's inline style. The image-fullscreen branch
  // (below) mutates content.style with display:flex centering; without
  // this reset, that style would leak into the next call (e.g. opening
  // a video right after closing an image). Restore the original
  // absolute-positioning that <div id="gridFsContent"> ships with in
  // the HTML.
  content.style.cssText = 'position:absolute;inset:0;';
  info.innerHTML = '';
  info.style.cssText = '';
  _vpState = null;
  
  // (zip0178) Track current row so vpKeyHandler can navigate from Iu/Ie.
  window._vpCurrentRow = row;
  
  const isVid = isVideoRow(row);
  
  if (isVid && row.link) {
    // VIDEO PLAYER
    // Default to playing from start if no VidRange defined
    const segs = window.parseVideoAsset(row.VidRange) || [{ start: 0, dur: 99999 }];
    if (!segs || segs.length === 0) return;
    
    _vpState = {
      row: row,
      player: null,
      segs: segs,
      segIdx: 0,
      isSelected: true, // Start in "Selected" mode (segment only)
      speed: 1.0,
      muted: row.Mute !== '0',
      ccOn: false,
      aPoint: null,
      bPoint: null,
      duration: 0,
      currentTime: 0
    };
    
    // Video host
    // (zip0144) Extends to the top edge — the old 50px info bar
    // ("cell · title") was removed in 0144 to recover screen height on
    // phones. Bottom 80px is the controls toolbar.
    // (zip0177) overflow:hidden clips the scaled iframe to the video area
    // when the user hold-zooms on desktop. transform-origin:center locks
    // scale to the visual center of the video frame.
    const host = document.createElement('div');
    host.id = 'grid-fs-video';
    host.style.cssText = 'position:absolute;inset:0 0 80px 0;background:#000;'
      + 'overflow:hidden;transform-origin:center center;';
    content.appendChild(host);
    _gridPlayers[host.id] = true;
    
    // Transparent swipe-catcher: sits above the video iframe, below any overlay
    // UI elements we add later. Blocks native YT hover/click UI and captures
    // right-to-left swipe to close V. Matches host geometry exactly so the
    // bottom toolbar still receives its own clicks.
    // (zip0175) touch-action:none (was pan-y). In CSS-rotated portrait mode a
    // visual R→L swipe is a PHYSICAL upward swipe — a vertical gesture. With
    // pan-y the browser claims vertical gestures and fires pointercancel
    // instead of pointerup, silently dropping the swipe. touch-action:none
    // prevents browser gesture-claim entirely; our pointer handlers get
    // everything. Video fullscreen has no scrollable content, so this is safe.
    const swipeCatcher = document.createElement('div');
    swipeCatcher.id = 'vp-swipe-catcher';
    swipeCatcher.style.cssText = 'position:absolute;inset:0 0 80px 0;z-index:50;background:transparent;cursor:pointer;touch-action:none;';
    content.appendChild(swipeCatcher);
    
    // ── V interaction: touch + mouse ──────────────────────────────────────────
    // Touch path (zip0174–0175): R→L swipe to close; tap = play/pause toggle.
    // Mouse path (zip0177 — Vud/Vdd desktop):
    //   • Hold LMB → zoom in (slow→fast, up to 8×). Same acceleration curve as
    //     Iu. 180 ms settle so quick clicks don't trigger zoom.
    //   • Drag while holding → cancels zoom and enters pan (at >1×) or swipe
    //     tracking (at 1×).
    //   • R→L drag release at 1× → close.
    //   • Double-click → reset zoom to 1×.
    //   • Click-to-play-pause removed on mouse; Space bar handles it.
    // The swipeCatcher sits above the host (iframe) and receives all events.
    // Zoom is applied as transform on host so the iframe is visually magnified
    // and clipped by host's overflow:hidden. No coordinate translation of
    // iframe content needed — CSS transform handles everything.

    // Shared zoom / pan state for host transform
    let _vScale = 1, _vTx = 0, _vTy = 0;
    function _vApply() {
      host.style.transform = `translate(${_vTx}px,${_vTy}px) scale(${_vScale})`;
      swipeCatcher.style.cursor = _vScale > 1.05 ? 'grab' : 'zoom-in';
    }
    function _vpxy(e) {
      return window.rotateXY ? window.rotateXY(e) : { x: e.clientX, y: e.clientY };
    }

    // ── TOUCH: R→L swipe to close + tap to play/pause ─────────────────────
    (function wireTouchV() {
      let sStart = null;
      swipeCatcher.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse') return;
        const p = _vpxy(e);
        sStart = { x: p.x, y: p.y, t: Date.now() };
      }, true);
      swipeCatcher.addEventListener('pointerup', e => {
        if (e.pointerType === 'mouse' || !sStart) return;
        const p = _vpxy(e);
        const dx = p.x - sStart.x, dy = p.y - sStart.y;
        const ms = Date.now() - sStart.t;
        sStart = null;
        if (dx < -40 && Math.abs(dy) < Math.abs(dx) && ms < 800) {
          vpClose(); return;
        }
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && ms < 300) {
          if (typeof vpTogglePlay === 'function') vpTogglePlay();
        }
      }, true);
      swipeCatcher.addEventListener('pointercancel', e => {
        if (e.pointerType !== 'mouse') sStart = null;
      }, true);
    })();

    // ── MOUSE: hold-LMB zoom + drag-pan + R→L swipe close + dblclick reset ─
    (function wireMouseV() {
      let mDown = false, mDragging = false;
      let mStart = null, mPanBase = null;
      let vzDelay = null, vzTimer = null, vzStep = 0;

      function vzStop() {
        if (vzDelay) { clearTimeout(vzDelay);  vzDelay = null; }
        if (vzTimer) { clearInterval(vzTimer); vzTimer = null; }
      }

      swipeCatcher.addEventListener('pointerdown', e => {
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        e.preventDefault();
        swipeCatcher.setPointerCapture(e.pointerId);
        const p = _vpxy(e);
        mDown = true; mDragging = false;
        mStart = { x: p.x, y: p.y, t: Date.now() };
        mPanBase = null;
        // 180 ms settle — quick clicks don't zoom
        vzStep = 0.015;
        vzDelay = setTimeout(() => {
          vzDelay = null;
          vzTimer = setInterval(() => {
            if (_vScale >= 8) { vzStop(); return; }
            _vScale   = Math.min(8, _vScale + vzStep);
            vzStep    = Math.min(0.12, vzStep + 0.003);
            _vApply();
          }, 50);
        }, 180);
      }, true);

      swipeCatcher.addEventListener('pointermove', e => {
        if (e.pointerType !== 'mouse' || !mDown) return;
        const p = _vpxy(e);
        if (!mDragging && Math.hypot(p.x - mStart.x, p.y - mStart.y) > 8) {
          mDragging = true;
          vzStop();
          mPanBase = { tx: _vTx, ty: _vTy, px: p.x, py: p.y };
        }
        if (mDragging && _vScale > 1.05) {
          _vTx = mPanBase.tx + (p.x - mPanBase.px);
          _vTy = mPanBase.ty + (p.y - mPanBase.py);
          _vApply();
          swipeCatcher.style.cursor = 'grabbing';
        }
      }, true);

      swipeCatcher.addEventListener('pointerup', e => {
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        vzStop();
        const p = _vpxy(e);
        const wasDragging = mDragging;
        mDown = false; mDragging = false;
        if (wasDragging && _vScale < 1.1 && mStart) {
          const dx = p.x - mStart.x, dy = p.y - mStart.y;
          if (dx < -60 && Math.abs(dy) < Math.abs(dx) &&
              Date.now() - mStart.t < 1500) { vpClose(); return; }
        }
        mStart = null; mPanBase = null;
        _vApply(); // restore cursor
      }, true);

      swipeCatcher.addEventListener('pointercancel', e => {
        if (e.pointerType !== 'mouse') return;
        vzStop(); mDown = false; mDragging = false;
        mStart = null; mPanBase = null;
      }, true);

      swipeCatcher.addEventListener('dblclick', () => {
        vzStop();
        _vScale = 1; _vTx = 0; _vTy = 0; _vApply();
      });
    })();

    // Reset zoom state when V closes (vpClose calls this implicitly via
    // content.innerHTML = '' on next open, but reset here too for safety).
    const _vResetZoom = () => { _vScale = 1; _vTx = 0; _vTy = 0; };
    // Expose on host so vpClose can call it if needed
    host._resetZoom = _vResetZoom;
    
    // Build controls toolbar
    const toolbar = document.createElement('div');
    toolbar.id = 'vp-toolbar';
    toolbar.style.cssText = 'position:absolute;bottom:0;left:0;right:0;height:70px;background:#000;border-top:2px solid #06f;display:flex;flex-direction:column;padding:4px 12px;box-sizing:border-box;';
    
    // Timeline row
    const timelineRow = document.createElement('div');
    timelineRow.style.cssText = 'display:flex;align-items:center;gap:8px;height:24px;';
    
    // Timeline bar
    const timeline = document.createElement('div');
    timeline.id = 'vp-timeline';
    timeline.style.cssText = 'flex:1;height:16px;background:#113;border:1px solid #06f;border-radius:3px;position:relative;cursor:pointer;';
    
    // Segment markers on timeline (drawn first, under progress)
    const markers = document.createElement('div');
    markers.id = 'vp-markers';
    markers.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:1;';
    timeline.appendChild(markers);
    
    // Progress bar (semi-transparent so segments show through)
    const progress = document.createElement('div');
    progress.id = 'vp-progress';
    progress.style.cssText = 'position:absolute;left:0;top:0;bottom:0;background:rgba(0,102,255,0.5);border-radius:2px;pointer-events:none;z-index:2;';
    timeline.appendChild(progress);
    
    // Playhead
    const playhead = document.createElement('div');
    playhead.id = 'vp-playhead';
    playhead.style.cssText = 'position:absolute;top:-2px;bottom:-2px;width:3px;background:#ff0;border-radius:2px;pointer-events:none;z-index:3;';
    timeline.appendChild(playhead);
    
    timelineRow.appendChild(timeline);
    toolbar.appendChild(timelineRow);
    
    // Controls row
    const ctrlRow = document.createElement('div');
    ctrlRow.style.cssText = 'display:flex;align-items:center;gap:6px;height:36px;margin-top:4px;';
    
    // Prev/Next buttons
    const btnPrev = document.createElement('button');
    btnPrev.id = 'vp-prev';
    btnPrev.className = 'vp-btn';
    btnPrev.innerHTML = '◀';
    btnPrev.title = 'Frame back (←)';
    
    const btnPlay = document.createElement('button');
    btnPlay.id = 'vp-play';
    btnPlay.className = 'vp-btn';
    btnPlay.innerHTML = '▶';
    btnPlay.title = 'Play/Pause (Space)';
    
    const btnNext = document.createElement('button');
    btnNext.id = 'vp-next';
    btnNext.className = 'vp-btn';
    btnNext.innerHTML = '▶';
    btnNext.title = 'Frame forward (→)';
    
    // (zip0148) Mute button moved here, into what used to be the time
    // display slot. The "0.0s / 99999.0s" text was eliminated — the
    // segment markers and progress bar already show position visually,
    // and the numeric readout took toolbar space without earning it.
    // Putting mute here also tests a hypothesis about Opera Mini Android:
    // when mute lived next to the AB caret cluster, tapping it sometimes
    // appeared to pause the video. Moving it well away from any other
    // tap target lets us isolate whether the symptom follows the button
    // or stays anchored to that physical screen location.
    const muteBtn = document.createElement('button');
    muteBtn.id = 'vp-mute';
    muteBtn.className = 'vp-btn';
    // (zip0143) SVG icon (helper defined late in the script). Defaults
    // to unmuted; toggle code below replaces with the muted variant
    // once the player has been mounted with its initial mute state.
    muteBtn.innerHTML = (window.muteIconHTML ? window.muteIconHTML(false) : '🔊');
    muteBtn.title = 'Mute (M)';
    // (zip0148) Slightly wider/taller to occupy the freed time-display
    // real estate and give Opera Mini a generous tap target.
    muteBtn.style.cssText += 'min-width:80px;padding:4px 12px;';
    
    // Speed control
    const speedWrap = document.createElement('div');
    speedWrap.style.cssText = 'display:flex;align-items:center;gap:4px;';
    const speedLbl = document.createElement('span');
    speedLbl.style.cssText = 'color:#888;font-size:11px;';
    speedLbl.textContent = 'Spd';
    const speedSlider = document.createElement('input');
    speedSlider.id = 'vp-speed';
    speedSlider.type = 'range';
    speedSlider.min = '0.5';
    speedSlider.max = '2';
    speedSlider.step = '0.25';
    speedSlider.value = '1';
    speedSlider.style.cssText = 'width:60px;accent-color:#06f;';
    const speedVal = document.createElement('span');
    speedVal.id = 'vp-speed-val';
    speedVal.style.cssText = 'color:#8cf;font-size:11px;min-width:24px;';
    speedVal.textContent = '1x';
    speedWrap.appendChild(speedLbl);
    speedWrap.appendChild(speedSlider);
    speedWrap.appendChild(speedVal);
    
    // Selected/Full toggle
    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'vp-toggle';
    toggleBtn.className = 'vp-btn';
    toggleBtn.style.cssText += 'font-size:10px;padding:4px 8px;min-width:60px;';
    toggleBtn.innerHTML = '● Selected<br><span style="font-size:9px;color:#666;">Full</span>';
    toggleBtn.title = 'Toggle Selected/Full';
    
    // CC button
    const ccBtn = document.createElement('button');
    ccBtn.id = 'vp-cc';
    ccBtn.className = 'vp-btn';
    ccBtn.textContent = 'CC';
    ccBtn.title = 'Closed Captions';
    
    // (zip0148) Mute button used to be defined here; moved earlier in
    // the toolbar where the time display used to live. See comment by
    // its new definition for the reasoning.
    
    // A-B buttons with carets
    const abWrap = document.createElement('div');
    abWrap.style.cssText = 'display:flex;align-items:center;gap:2px;';
    
    // A- caret
    const aMinusBtn = document.createElement('button');
    aMinusBtn.id = 'vp-a-minus';
    aMinusBtn.className = 'vp-btn';
    aMinusBtn.textContent = '◀';
    aMinusBtn.title = 'A -0.1s';
    aMinusBtn.style.cssText += 'background:#530;border-color:#f80;color:#f80;padding:4px 6px;font-size:10px;min-width:20px;';
    
    const aBtn = document.createElement('button');
    aBtn.id = 'vp-a';
    aBtn.className = 'vp-btn';
    aBtn.textContent = 'A';
    aBtn.title = 'Set A point (click again to clear)';
    aBtn.style.cssText += 'background:#530;border-color:#f80;color:#f80;';
    
    // A+ caret
    const aPlusBtn = document.createElement('button');
    aPlusBtn.id = 'vp-a-plus';
    aPlusBtn.className = 'vp-btn';
    aPlusBtn.textContent = '▶';
    aPlusBtn.title = 'A +0.1s';
    aPlusBtn.style.cssText += 'background:#530;border-color:#f80;color:#f80;padding:4px 6px;font-size:10px;min-width:20px;';
    
    // ABsave button
    const abSaveBtn = document.createElement('button');
    abSaveBtn.id = 'vp-ab-save';
    abSaveBtn.className = 'vp-btn';
    abSaveBtn.textContent = 'AB💾';
    abSaveBtn.title = 'Save A-B range to AB field';
    abSaveBtn.style.cssText += 'background:#350;border-color:#8f0;color:#8f0;font-size:10px;';
    
    // B- caret
    const bMinusBtn = document.createElement('button');
    bMinusBtn.id = 'vp-b-minus';
    bMinusBtn.className = 'vp-btn';
    bMinusBtn.textContent = '◀';
    bMinusBtn.title = 'B -0.1s';
    bMinusBtn.style.cssText += 'background:#530;border-color:#f80;color:#f80;padding:4px 6px;font-size:10px;min-width:20px;';
    
    const bBtn = document.createElement('button');
    bBtn.id = 'vp-b';
    bBtn.className = 'vp-btn';
    bBtn.textContent = 'B';
    bBtn.title = 'Set B point (click again to clear)';
    bBtn.style.cssText += 'background:#530;border-color:#f80;color:#f80;';
    
    // B+ caret
    const bPlusBtn = document.createElement('button');
    bPlusBtn.id = 'vp-b-plus';
    bPlusBtn.className = 'vp-btn';
    bPlusBtn.textContent = '▶';
    bPlusBtn.title = 'B +0.1s';
    bPlusBtn.style.cssText += 'background:#530;border-color:#f80;color:#f80;padding:4px 6px;font-size:10px;min-width:20px;';
    
    abWrap.appendChild(aMinusBtn);
    abWrap.appendChild(aBtn);
    abWrap.appendChild(aPlusBtn);
    abWrap.appendChild(abSaveBtn);
    abWrap.appendChild(bMinusBtn);
    abWrap.appendChild(bBtn);
    abWrap.appendChild(bPlusBtn);
    
    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.id = 'vp-close';
    closeBtn.className = 'vp-btn';
    closeBtn.innerHTML = '✕';
    closeBtn.title = 'Close (Esc)';
    closeBtn.style.cssText += 'background:#500;border-color:#f00;color:#f44;margin-left:auto;';
    
    ctrlRow.appendChild(btnPrev);
    ctrlRow.appendChild(btnPlay);
    ctrlRow.appendChild(btnNext);
    // (zip0148) muteBtn now occupies the slot that used to hold the
    // numeric time display.
    ctrlRow.appendChild(muteBtn);
    ctrlRow.appendChild(speedWrap);
    ctrlRow.appendChild(toggleBtn);
    ctrlRow.appendChild(ccBtn);
    ctrlRow.appendChild(abWrap);
    ctrlRow.appendChild(closeBtn);
    
    toolbar.appendChild(ctrlRow);
    content.appendChild(toolbar);
    
    // (zip0144) No info bar for video — video extends to the top edge.
    // The cell label / title was removed because it took meaningful
    // screen height on phones and added little value (the user knows
    // what they tapped). Image and quiz cases below still set their
    // info bars since they're useful there.
    info.style.cssText = 'display:none;';
    info.innerHTML = '';
    
    // Mount video
    setTimeout(() => {
      const seg = segs[0];
      const muted = _vpState.muted;
      
      // For "Selected" mode, we loop the segment
      // For "Full" mode, we play from start to end of video
      if (window.isYouTubeLink && window.isYouTubeLink(row.link)) {
        vpMountYouTube(host, row.link, seg, muted);
      } else if (window.isVimeoLink && window.isVimeoLink(row.link)) {
        vpMountVimeo(host, row.link, seg, muted);
      } else if (/\.(mp4|mov|webm|ogg|avi|mkv|m4v)(\?|#|$)/i.test(row.link)) {
        vpMountDirectVideo(host, row.link, seg, muted);
      }
    }, 50);
    
    // Wire up controls
    vpWireControls();
    
  } else if (row.ftext || row.qfile) {
    // QUIZ / HTML FULLSCREEN via srcdoc iframe
    //
    // (zip0174) Iframes capture keyboard focus, so once the user
    // interacts with the HTML content, Esc and hotkeys no longer reach
    // the document — vpKeyHandler stops responding. Swipe-to-close
    // wasn't wired here either (only on the video branch), so on
    // mobile there was no escape route at all. Fix: add a fixed top
    // bar over the iframe with (1) visible "swipe to return" hint,
    // (2) explicit ✕ close button, (3) R→L swipe handler that uses
    // the rotated-coord helper so it works in CSS-rotated portrait.
    const topBar = document.createElement('div');
    topBar.id = 'vp-html-topbar';
    topBar.style.cssText = 'position:absolute;top:0;left:0;right:0;height:48px;'
      + 'display:flex;align-items:center;justify-content:space-between;'
      + 'padding:0 14px;background:#3a4d75;border-bottom:2px solid #6af;z-index:60;'
      + 'touch-action:none;user-select:none;';
    topBar.innerHTML = '<span style="font-family:monospace;font-size:13px;color:#cde;'
      + 'pointer-events:none;">← Swipe right-to-left on this bar to return · Esc</span>'
      + '<button id="vp-html-close" style="background:#1a1a2e;border:1px solid #888;'
      + 'color:#ccc;padding:4px 12px;border-radius:4px;cursor:pointer;'
      + 'font-family:monospace;font-size:13px;">✕ Close</button>';
    content.appendChild(topBar);

    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:absolute;top:48px;left:0;right:0;bottom:0;'
      + 'width:100%;height:calc(100% - 48px);border:none;background:#fff;';
    iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin allow-modals allow-downloads');
    content.appendChild(iframe);

    // Wire close button
    topBar.querySelector('#vp-html-close').addEventListener('click', vpClose);

    // R→L swipe on top bar closes (mirrors the video branch's
    // swipeCatcher behavior). Uses rotateXY for portrait rotation.
    (function wireHtmlSwipeClose() {
      let sStart = null;
      topBar.addEventListener('pointerdown', e => {
        const _p = window.rotateXY ? window.rotateXY(e) : { x: e.clientX, y: e.clientY };
        sStart = { x: _p.x, y: _p.y, t: Date.now() };
      });
      topBar.addEventListener('pointerup', e => {
        if (!sStart) return;
        const _p = window.rotateXY ? window.rotateXY(e) : { x: e.clientX, y: e.clientY };
        const dx = _p.x - sStart.x;
        const dy = _p.y - sStart.y;
        const ms = Date.now() - sStart.t;
        sStart = null;
        if (dx < -40 && Math.abs(dy) < Math.abs(dx) && ms < 800) vpClose();
      });
      topBar.addEventListener('pointercancel', () => { sStart = null; });
    })();

    // Listen for exitQuiz postMessage from inside the iframe
    const quizMsgHandler = (e) => {
      if (e.data && e.data.type === 'quizExit') {
        window.removeEventListener('message', quizMsgHandler);
        vpClose();
        // Re-focus document body so single-letter hotkeys work immediately
        setTimeout(() => { document.body.focus(); }, 50);
      }
    };
    window.addEventListener('message', quizMsgHandler);

    const loadIframe = (html) => { iframe.srcdoc = html; };

    if (row.qfile) {
      (async () => {
        const dir = await _getDir();
        if (!dir) { iframe.srcdoc = '<body style="font:14px monospace;padding:20px;color:#f44;">No project folder set — cannot load ' + escH(row.qfile) + '</body>'; return; }
        try {
          const fh   = await dir.getFileHandle(row.qfile);
          const file = await fh.getFile();
          loadIframe(await file.text());
        } catch(e) {
          iframe.srcdoc = '<body style="font:14px monospace;padding:20px;color:#f44;">Could not load "' + escH(row.qfile) + '": ' + escH(e.message) + '</body>';
        }
      })();
    } else {
      const ft = (row.ftext || '').trim();
      if (ft.startsWith('[') || ft.startsWith('{')) {
        try {
          const parsed = JSON.parse(ft);
          loadIframe(buildQuizHtml(parsed, row.n1 || row.title || 'Quiz'));
        } catch(e) {
          loadIframe('<body style="font:14px monospace;padding:20px;">'
            + '<div style="color:#f44">JSON parse error: ' + escH(e.message) + '</div>'
            + '<pre style="font-size:11px;color:#888;white-space:pre-wrap;">' + escH(ft.slice(0,200)) + '</pre></body>');
        }
      } else {
        // (zip0168) Linkify URL patterns at render time so old ftext also
        // gets clickable links, not just freshly-pasted articles.
        const ftLink = (typeof renderFtext === 'function') ? renderFtext(ft) : ft;
        // (dev0248) Iframe gets its own document — global CSS from index.html
        // does NOT reach it. Inject the cross-context rules explicitly:
        //   • .te-cut → hidden (matches the AHK-style "/*" cut behavior)
        //   • <summary> text + anchor children → inherit surrounding text
        //     color so a summary whose only child is an <a> doesn't render
        //     in the browser-default link color (which can be dark/invisible
        //     against dark slide backgrounds or visited-link purple/black).
        //     `inherit` adapts to both light (default) and dark slide bgs.
        const _ftStyles =
            'a{color:#5bf!important;}'
          + '.te-cut{display:none!important;}'
          + 'summary{color:inherit!important;background:transparent!important;font-weight:bold;}'
          + 'summary a,summary a:visited{color:inherit!important;text-decoration:underline;}';
        const _aStyle = '<style>' + _ftStyles + '</style>';
        const html = ftLink.includes('<html')
          ? ftLink.replace(/<\/head>/i, _aStyle + '</head>')
          : '<!DOCTYPE html><html><head><meta charset="UTF-8">'
            + '<style>body{font-family:Arial,sans-serif;padding:20px;line-height:1.5;}'
            + _ftStyles
            + '</style></head>'
            + '<body>' + ftLink + '</body></html>';
        loadIframe(html);
      }
    }

    // (zip0174) info bar hidden — top bar provides the close affordance
    info.textContent = '';
    info.style.cssText = 'display:none;';
    fs.onclick = null;

  } else if (row.link) {
    // ── Iu — IMAGE FULLSCREEN ────────────────────────────────────────────────
    // zip0175: touch pinch-zoom, drag-pan, R→L swipe close, double-tap reset.
    // zip0176: desktop mouse (Iud/Idd) — hold-LMB zooms in (slow→fast, up to
    //   8×); drag pans when zoomed; R→L drag at 1× closes; double-click resets.
    //   Click-to-close removed on desktop too. Both paths share one transform
    //   state and one _iApply(). Pointer events are branched by e.pointerType
    //   so touch and mouse never interfere.

    content.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:#000;';

    const ivWrap = document.createElement('div');
    ivWrap.style.cssText = 'position:absolute;inset:0;touch-action:none;overflow:hidden;'
      + 'display:flex;align-items:center;justify-content:center;';
    content.appendChild(ivWrap);

    const img = document.createElement('img');
    img.src = row.link;
    img.setAttribute('draggable', 'false');
    img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;'
      + 'transform-origin:center center;will-change:transform;'
      + 'user-select:none;-webkit-user-drag:none;pointer-events:none;';
    ivWrap.appendChild(img);

    // ✕ always accessible at top-right regardless of zoom
    const closeBtn = document.createElement('button');
    closeBtn.className = 'vp-btn';
    closeBtn.innerHTML = '✕';
    closeBtn.style.cssText = 'position:absolute;top:12px;right:14px;z-index:60;'
      + 'background:rgba(60,0,0,0.75);border-color:#f44;color:#f88;'
      + 'padding:6px 14px;font-size:16px;touch-action:manipulation;';
    closeBtn.addEventListener('click', vpClose);
    content.appendChild(closeBtn);

    info.style.cssText = 'display:none;'; info.innerHTML = '';
    fs.onclick = null; // no tap/click-to-close — interferes with pan

    // ── Shared transform state ───────────────────────────────────────────────
    let _iScale = 1, _iTx = 0, _iTy = 0;
    const MAX_SCALE = 8, MIN_SCALE = 0.9;

    function _iApply() {
      img.style.transform = `translate(${_iTx}px,${_iTy}px) scale(${_iScale})`;
      // Cursor hints: zoom-in at 1×, grab when zoomed (no button held)
      ivWrap.style.cursor = _iScale > 1.05 ? 'grab' : 'zoom-in';
    }
    function _pxy(e) {
      return window.rotateXY ? window.rotateXY(e) : { x: e.clientX, y: e.clientY };
    }

    // ════════════════════════════════════════════════════════════════════════
    // TOUCH PATH — pinch-zoom + one-finger pan + R→L swipe + double-tap reset
    // ════════════════════════════════════════════════════════════════════════
    const _ptrs = new Map(); // active touch pointers (pointerId → {x,y})
    let _tDrag = null, _tPinch = null, _tSwipe = null;

    ivWrap.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse') return;
      e.preventDefault();
      ivWrap.setPointerCapture(e.pointerId);
      _ptrs.set(e.pointerId, _pxy(e));

      if (_ptrs.size >= 2) {
        _tSwipe = null; _tDrag = null;
        const [a, b] = [..._ptrs.values()];
        _tPinch = {
          scale: _iScale, tx: _iTx, ty: _iTy,
          dist: Math.hypot(b.x - a.x, b.y - a.y),
          mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2
        };
      } else {
        _tPinch = null;
        const p = _pxy(e);
        _tDrag  = { tx: _iTx, ty: _iTy, px: p.x, py: p.y };
        _tSwipe = { x: p.x, y: p.y, t: Date.now() };
      }
    }, true);

    ivWrap.addEventListener('pointermove', e => {
      if (e.pointerType === 'mouse' || !_ptrs.has(e.pointerId)) return;
      e.preventDefault();
      _ptrs.set(e.pointerId, _pxy(e));
      const p = _pxy(e);

      if (_ptrs.size >= 2 && _tPinch) {
        const [a, b] = [..._ptrs.values()];
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        _iScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE,
                    _tPinch.scale * dist / _tPinch.dist));
        _iTx = _tPinch.tx + (mx - _tPinch.mx);
        _iTy = _tPinch.ty + (my - _tPinch.my);
        _iApply();
      } else if (_ptrs.size === 1 && _tDrag && _iScale > 1.05) {
        _iTx = _tDrag.tx + (p.x - _tDrag.px);
        _iTy = _tDrag.ty + (p.y - _tDrag.py);
        _iApply();
        _tSwipe = null; // moved: no longer a swipe candidate
      }
    }, true);

    ivWrap.addEventListener('pointerup', e => {
      if (e.pointerType === 'mouse' || !_ptrs.has(e.pointerId)) return;
      e.preventDefault();
      const p = _pxy(e);
      _ptrs.delete(e.pointerId);

      if (_ptrs.size === 0) {
        if (_tSwipe && _iScale < 1.1) {
          const dx = p.x - _tSwipe.x, dy = p.y - _tSwipe.y;
          if (dx < -50 && Math.abs(dy) < Math.abs(dx) &&
              Date.now() - _tSwipe.t < 800) { vpClose(); return; }
        }
        _tSwipe = null; _tDrag = null; _tPinch = null;
      } else if (_ptrs.size === 1 && _tPinch) {
        _tPinch = null; _tSwipe = null;
        const rem = [..._ptrs.values()][0];
        _tDrag = { tx: _iTx, ty: _iTy, px: rem.x, py: rem.y };
      }
    }, true);

    ivWrap.addEventListener('pointercancel', e => {
      if (e.pointerType === 'mouse') return;
      _ptrs.delete(e.pointerId);
      if (_ptrs.size === 0) { _tDrag = null; _tPinch = null; _tSwipe = null; }
    }, true);

    // Touch double-tap → reset zoom
    let _tLastTap = 0, _tLastTapP = null;
    ivWrap.addEventListener('pointerup', e => {
      if (e.pointerType === 'mouse' || _ptrs.size > 0) return;
      const now = Date.now(), p = _pxy(e);
      if (now - _tLastTap < 350 && _tLastTapP &&
          Math.abs(p.x - _tLastTapP.x) < 24 && Math.abs(p.y - _tLastTapP.y) < 24) {
        _iScale = 1; _iTx = 0; _iTy = 0; _iApply();
        _tLastTap = 0; _tLastTapP = null; return;
      }
      _tLastTap = now; _tLastTapP = p;
    }, true);

    // ════════════════════════════════════════════════════════════════════════
    // MOUSE PATH (Iud / Idd) — hold LMB zooms in, drag pans/swipes
    //
    // Zoom behaviour: press-and-hold LMB. After a 180ms settle delay (to
    // avoid accidental zooms on quick clicks), scale ramps up from slow
    // (~0.3×/s) to fast (~2.4×/s) over ~2 seconds of holding, stopping
    // at 8×. Moving the mouse > 8 px cancels the zoom and enters drag
    // mode: pan at >1× scale, or track for R→L swipe-to-close at 1×.
    // Double-click resets to 1×.  No click-to-close.
    // ════════════════════════════════════════════════════════════════════════
    let _mDown = false, _mDragging = false;
    let _mStart = null;    // { x,y,t } at pointerdown
    let _mPanBase = null;  // { tx,ty,px,py } when drag starts
    let _zoomDelay = null, _zoomTimer = null, _zoomStep = 0;

    function _mStopZoom() {
      if (_zoomDelay) { clearTimeout(_zoomDelay);  _zoomDelay = null; }
      if (_zoomTimer) { clearInterval(_zoomTimer); _zoomTimer = null; }
    }
    function _mStartZoom() {
      _zoomStep = 0.015;  // initial: 0.015 × 20 Hz ≈ 0.3 scale/sec (slow)
      _zoomTimer = setInterval(() => {
        if (_iScale >= MAX_SCALE) { _mStopZoom(); return; }
        _iScale    = Math.min(MAX_SCALE, _iScale + _zoomStep);
        _zoomStep  = Math.min(0.12, _zoomStep + 0.003); // accelerates → 2.4/sec
        _iApply();
        ivWrap.style.cursor = 'zoom-in'; // keep cursor during zoom
      }, 50);
    }

    ivWrap.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      e.preventDefault();
      ivWrap.setPointerCapture(e.pointerId);
      const p = _pxy(e);
      _mDown = true; _mDragging = false;
      _mStart   = { x: p.x, y: p.y, t: Date.now() };
      _mPanBase = null;
      // 180 ms settle delay — quick clicks don't trigger zoom
      _zoomDelay = setTimeout(_mStartZoom, 180);
    }, true);

    ivWrap.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse' || !_mDown) return;
      const p = _pxy(e);
      if (!_mDragging && Math.hypot(p.x - _mStart.x, p.y - _mStart.y) > 8) {
        // User started dragging — cancel zoom, enter drag mode
        _mDragging = true;
        _mStopZoom();
        _mPanBase = { tx: _iTx, ty: _iTy, px: p.x, py: p.y };
      }
      if (_mDragging) {
        if (_iScale > 1.05) {
          // Pan
          _iTx = _mPanBase.tx + (p.x - _mPanBase.px);
          _iTy = _mPanBase.ty + (p.y - _mPanBase.py);
          _iApply();
          ivWrap.style.cursor = 'grabbing';
        }
        // At 1× scale we just track movement for swipe detection at release
      }
    }, true);

    ivWrap.addEventListener('pointerup', e => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      e.preventDefault();
      _mStopZoom();
      const p   = _pxy(e);
      const wasDragging = _mDragging;
      _mDown = false; _mDragging = false;

      if (wasDragging && _iScale < 1.1 && _mStart) {
        // R→L swipe-to-close (at 1× scale)
        const dx = p.x - _mStart.x, dy = p.y - _mStart.y;
        const ms = Date.now() - _mStart.t;
        if (dx < -60 && Math.abs(dy) < Math.abs(dx) && ms < 1500) {
          vpClose(); return;
        }
      }
      _mStart = null; _mPanBase = null;
      _iApply(); // restore correct grab/zoom-in cursor
    }, true);

    ivWrap.addEventListener('pointercancel', e => {
      if (e.pointerType !== 'mouse') return;
      _mStopZoom(); _mDown = false; _mDragging = false;
      _mStart = null; _mPanBase = null;
    }, true);

    // Double-click → reset zoom (works for both LMB dblclick and fast taps)
    ivWrap.addEventListener('dblclick', e => {
      if (e.pointerType === 'touch') return; // touch uses double-tap handler above
      _mStopZoom();
      _iScale = 1; _iTx = 0; _iTy = 0; _iApply();
    });
  }
  
  fs.style.display = 'flex';
  
  // Keyboard handler
  document.addEventListener('keydown', vpKeyHandler, true);
}

function vpClose() {
  // (zip0186) Close Annotate panel alongside Ie/V — it auto-opened with them,
  // so it should close too when returning to T. Arrow-hop navigation will
  // reopen A immediately in the next editor, so no visible gap.
  const _vpAnEl = document.getElementById('browseOverlay');
  if (_vpAnEl && _vpAnEl.style.display === 'flex') {
    if (typeof brSave === 'function') brSave();
    _vpAnEl.style.display = 'none';
    const _wrapEl = document.getElementById('wrap');
    if (_wrapEl) _wrapEl.style.marginRight = '';
    if (typeof brClearThumb === 'function') brClearThumb();
  }

  // Stop interval
  if (_vpState && _vpState.interval) clearInterval(_vpState.interval);

  window._vpCurrentRow = null; // (zip0178) clear tracked row
  
  // Stop/destroy YouTube or Vimeo player
  if (_vpState && _vpState.player) {
    try {
      if (_vpState.isYT) {
        _vpState.player.stopVideo();
        _vpState.player.destroy();
      } else if (typeof _vpState.player.destroy === 'function') {
        _vpState.player.destroy();
      }
    } catch(e) {}
  }
  
  // Also use stopCellVideoLoop as backup
  if (window.stopCellVideoLoop) window.stopCellVideoLoop('grid-fs-video');
  
  _vpState = null;
  const fs = document.getElementById('gridFullscreen');
  fs.style.display = 'none';
  fs.onclick = null;
  document.removeEventListener('keydown', vpKeyHandler, true);
  // Restore focus to main document so hotkeys work immediately
  document.body.setAttribute('tabindex', '-1');
  document.body.focus();
  // Note: we stay on grid (don't close it)
}

function vpKeyHandler(e) {
  if (document.getElementById('gridFullscreen').style.display !== 'flex') return;
  
  // (zip0186) Esc no longer closes Ie/V — use swipe-left, the ✕ button, or T.
  // The global handler blurs any focused input; nothing else to do here.

  // (zip0178) ArrowUp / ArrowDown — navigate filtered rows while in image
  // fullscreen (Iu / Ie).  Skipped when a video player is active (video
  // Left/Right frame-step is the relevant key there, and the video editor
  // handles its own ArrowUp/Down navigation separately).
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    if (_vpState && _vpState.player) return; // video — not our job here
    e.preventDefault(); e.stopPropagation();
    // (zip0185) Always reseed _brRows from the current filter so navigation
    // walks the live filtered T (not a stale snapshot).
    window._brRows = (typeof brGetVisibleRows === 'function')
      ? brGetVisibleRows() : (window._brRows || []);
    const rows = window._brRows;
    const curRow = window._vpCurrentRow;
    const di = (curRow && typeof data !== 'undefined') ? data.indexOf(curRow) : -1;
    const curFi = di >= 0 ? rows.indexOf(di) : -1;
    const step = e.key === 'ArrowDown' ? 1 : -1;
    const target = curFi + step;
    if (target < 0 || target >= rows.length) {
      if (typeof toast === 'function')
        toast('No more rows ' + (step > 0 ? 'below' : 'above') + '.', 1400);
      return;
    }
    window._brIdx = target;
    const nextRow = (typeof data !== 'undefined') ? data[rows[target]] : null;
    if (!nextRow) return;
    // (zip0185) Cover so T doesn't flash through during the close→open swap.
    if (typeof window._veShowHopCover === 'function') window._veShowHopCover();
    vpClose();
    openEditorForRow(nextRow);
    return;
  }
  
  if (!_vpState || !_vpState.player) return;
  
  // Space = play/pause
  if (e.key === ' ') {
    e.preventDefault();
    vpTogglePlay();
    return;
  }
  
  // Left/Right = frame step
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    vpSeekRelative(-0.1);
    return;
  }
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    vpSeekRelative(0.1);
    return;
  }
  
  // M = mute toggle
  if (e.key === 'm' || e.key === 'M') {
    e.preventDefault();
    vpToggleMute();
    return;
  }
}

function vpTogglePlay() {
  if (!_vpState || !_vpState.player) return;
  const p = _vpState.player;
  if (_vpState.isYT) {
    const state = p.getPlayerState();
    if (state === 1) p.pauseVideo(); else p.playVideo();
  } else {
    p.getPaused().then(paused => { if (paused) p.play(); else p.pause(); });
  }
  vpUpdatePlayBtn();
}

function vpSeekRelative(delta) {
  if (!_vpState || !_vpState.player) return;
  const p = _vpState.player;
  if (_vpState.isYT) {
    const t = p.getCurrentTime() + delta;
    p.seekTo(t, true);
  } else {
    p.getCurrentTime().then(ct => p.setCurrentTime(ct + delta));
  }
}

function vpToggleMute() {
  if (!_vpState || !_vpState.player) return;
  _vpState.muted = !_vpState.muted;
  const p = _vpState.player;
  // (zip0151) Simple API call. The 0150 in-gesture remount-on-unmute
  // approach was an attempt to make Opera Mini Android play sound on
  // unmute, since its autoplay policy refuses to permit unmute via
  // postMessage on a player that started muted. The remount worked on
  // some Opera Mini configurations but caused a screen flash on every
  // unmute everywhere. User abandoned Opera Mini after finding Firefox
  // Android's fullscreen extension working, so we no longer need the
  // remount workaround. Back to clean API toggle — no flash, no
  // playback position drift, instant response.
  try {
    if (_vpState.isYT) {
      if (_vpState.muted) p.mute(); else p.unMute();
    } else {
      p.setMuted(_vpState.muted);
    }
  } catch (_) {}
  // (zip0143) Use the SVG icon helper for a high-contrast slash.
  document.getElementById('vp-mute').innerHTML =
    (window.muteIconHTML ? window.muteIconHTML(_vpState.muted)
                         : (_vpState.muted ? '🔇' : '🔊'));
}

function vpUpdatePlayBtn() {
  if (!_vpState || !_vpState.player) return;
  const btn = document.getElementById('vp-play');
  if (!btn) return;
  if (_vpState.isYT) {
    const state = _vpState.player.getPlayerState();
    btn.innerHTML = (state === 1) ? '⏸' : '▶';
  } else {
    _vpState.player.getPaused().then(paused => { btn.innerHTML = paused ? '▶' : '⏸'; });
  }
}

function vpSetSpeed(spd) {
  if (!_vpState || !_vpState.player) return;
  _vpState.speed = spd;
  if (_vpState.isYT) {
    _vpState.player.setPlaybackRate(spd);
  } else {
    _vpState.player.setPlaybackRate(spd);
  }
  document.getElementById('vp-speed-val').textContent = spd + 'x';
}

function vpToggleSelectedFull() {
  if (!_vpState) return;
  _vpState.isSelected = !_vpState.isSelected;
  const btn = document.getElementById('vp-toggle');
  if (_vpState.isSelected) {
    btn.innerHTML = '● Selected<br><span style="font-size:9px;color:#666;">Full</span>';
  } else {
    btn.innerHTML = '<span style="font-size:9px;color:#666;">Selected</span><br>● Full';
  }
  // Restart in new mode
  vpRestartInMode();
}

function vpRestartInMode() {
  // For now, just seek to start of segment or start of video
  if (!_vpState || !_vpState.player) return;
  const p = _vpState.player;
  if (_vpState.isSelected) {
    const seg = _vpState.segs[_vpState.segIdx];
    if (_vpState.isYT) p.seekTo(seg.start, true);
    else p.setCurrentTime(seg.start);
  } else {
    if (_vpState.isYT) p.seekTo(0, true);
    else p.setCurrentTime(0);
  }
}

function vpSetAPoint() {
  if (!_vpState || !_vpState.player) return;
  if (_vpState.isYT) {
    _vpState.aPoint = _vpState.player.getCurrentTime();
  } else {
    _vpState.player.getCurrentTime().then(t => { _vpState.aPoint = t; vpUpdateABStyle(); });
    return;
  }
  vpUpdateABStyle();
}

function vpSetBPoint() {
  if (!_vpState || !_vpState.player) return;
  if (_vpState.isYT) {
    _vpState.bPoint = _vpState.player.getCurrentTime();
  } else {
    _vpState.player.getCurrentTime().then(t => { _vpState.bPoint = t; vpUpdateABStyle(); });
    return;
  }
  vpUpdateABStyle();
}

function vpUpdateABStyle() {
  const aBtn = document.getElementById('vp-a');
  const bBtn = document.getElementById('vp-b');
  if (_vpState.aPoint !== null) {
    aBtn.style.background = '#080';
    aBtn.style.borderColor = '#0f0';
    aBtn.textContent = 'A:' + _vpState.aPoint.toFixed(1);
  } else {
    aBtn.style.background = '#530';
    aBtn.style.borderColor = '#f80';
    aBtn.textContent = 'A';
  }
  if (_vpState.bPoint !== null) {
    bBtn.style.background = '#080';
    bBtn.style.borderColor = '#0f0';
    bBtn.textContent = 'B:' + _vpState.bPoint.toFixed(1);
  } else {
    bBtn.style.background = '#530';
    bBtn.style.borderColor = '#f80';
    bBtn.textContent = 'B';
  }
}

function vpWireControls() {
  document.getElementById('vp-prev').onclick = () => vpSeekRelative(-0.1);
  document.getElementById('vp-play').onclick = vpTogglePlay;
  document.getElementById('vp-next').onclick = () => vpSeekRelative(0.1);
  document.getElementById('vp-speed').oninput = e => vpSetSpeed(parseFloat(e.target.value));
  document.getElementById('vp-toggle').onclick = vpToggleSelectedFull;
  document.getElementById('vp-cc').onclick = vpToggleCC;
  document.getElementById('vp-mute').onclick = vpToggleMute;
  // (zip0143) Reflect the player's actual starting mute state in the
  // icon. _vpState.muted is set by setupVP earlier in the open flow,
  // before the buttons are wired up here.
  if (window.muteIconHTML && _vpState) {
    document.getElementById('vp-mute').innerHTML = window.muteIconHTML(!!_vpState.muted);
  }
  document.getElementById('vp-a').onclick = vpToggleA;
  document.getElementById('vp-b').onclick = vpToggleB;
  document.getElementById('vp-a-minus').onclick = () => vpAdjustAB('a', -0.1);
  document.getElementById('vp-a-plus').onclick = () => vpAdjustAB('a', 0.1);
  document.getElementById('vp-b-minus').onclick = () => vpAdjustAB('b', -0.1);
  document.getElementById('vp-b-plus').onclick = () => vpAdjustAB('b', 0.1);
  document.getElementById('vp-ab-save').onclick = vpSaveAB;
  document.getElementById('vp-close').onclick = vpClose;
  
  // Timeline scrubbing
  const timeline = document.getElementById('vp-timeline');
  timeline.onclick = e => {
    if (!_vpState || !_vpState.duration) return;
    const rect = timeline.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const t = pct * _vpState.duration;
    if (_vpState.isYT) _vpState.player.seekTo(t, true);
    else _vpState.player.setCurrentTime(t);
  };
}

// Toggle A point - set or clear
function vpToggleA() {
  if (!_vpState || !_vpState.player) return;
  if (_vpState.aPoint !== null) {
    // Clear A point
    _vpState.aPoint = null;
    vpUpdateABStyle();
    toast('A point cleared', 800);
    return;
  }
  vpSetAPoint();
}

// Toggle B point - set or clear
function vpToggleB() {
  if (!_vpState || !_vpState.player) return;
  if (_vpState.bPoint !== null) {
    // Clear B point
    _vpState.bPoint = null;
    vpUpdateABStyle();
    toast('B point cleared', 800);
    return;
  }
  vpSetBPoint();
}

// Adjust A or B by delta
function vpAdjustAB(which, delta) {
  if (!_vpState) return;
  if (which === 'a' && _vpState.aPoint !== null) {
    _vpState.aPoint = Math.max(0, _vpState.aPoint + delta);
    vpUpdateABStyle();
  } else if (which === 'b' && _vpState.bPoint !== null) {
    _vpState.bPoint = Math.max(0, _vpState.bPoint + delta);
    vpUpdateABStyle();
  }
}

// Save A-B range — runtime only as of zip0128.
// User renamed the AB column in ml.json to BA (BatchAdd marker for
// channel-imported rows). The V screen still has Set A / Set B / Show A:B
// as a runtime convenience for jumping between two timestamps within a
// video, but it no longer writes anything to the row. Toast still shows
// the computed range so the user can copy it manually if needed.
function vpSaveAB() {
  if (!_vpState || _vpState.aPoint === null || _vpState.bPoint === null) {
    toast('Set both A and B points first', 1500);
    return;
  }
  const a = Math.min(_vpState.aPoint, _vpState.bPoint);
  const b = Math.max(_vpState.aPoint, _vpState.bPoint);
  const abStr = a.toFixed(2) + ':' + (b - a).toFixed(2);

  // (zip0128) Removed: row.AB = abStr; save(); buildTable();
  // The AB column was renamed BA in ml.json and is now used to mark
  // batch-imported rows. AB is runtime-only.
  toast('A:B range = ' + abStr + '\n(not saved — display only)', 2500);
}

function vpToggleCC() {
  if (!_vpState || !_vpState.player) return;
  _vpState.ccOn = !_vpState.ccOn;
  const btn = document.getElementById('vp-cc');
  if (_vpState.isYT) {
    // YouTube CC module
    if (_vpState.ccOn) {
      _vpState.player.loadModule('captions');
      _vpState.player.setOption('captions', 'track', { languageCode: 'en' });
    } else {
      _vpState.player.unloadModule('captions');
    }
  }
  btn.style.background = _vpState.ccOn ? '#050' : '';
  btn.style.borderColor = _vpState.ccOn ? '#0f0' : '';
}

function vpUpdateTimeline() {
  if (!_vpState || !_vpState.player) return;
  
  const updateUI = (ct, dur) => {
    _vpState.currentTime = ct;
    _vpState.duration = dur;
    
    const progress = document.getElementById('vp-progress');
    const playhead = document.getElementById('vp-playhead');
    // (zip0148) vp-time element removed from the toolbar; no longer
    // queried or updated here. Position info is still conveyed visually
    // by the progress bar and segment markers.
    const markers = document.getElementById('vp-markers');
    
    if (dur > 0) {
      const pct = (ct / dur) * 100;
      progress.style.width = pct + '%';
      playhead.style.left = 'calc(' + pct + '% - 1px)';
      
      // Draw segment markers once when duration is known
      if (!_vpState.markersDrawn) {
        _vpState.markersDrawn = true;
        markers.innerHTML = '';
        _vpState.segs.forEach((seg, i) => {
          const startPct = (seg.start / dur) * 100;
          const widthPct = (seg.dur / dur) * 100;
          const marker = document.createElement('div');
          marker.style.cssText = `position:absolute;top:2px;bottom:2px;left:${startPct}%;width:${widthPct}%;background:rgba(0,255,128,0.6);border-radius:2px;border:1px solid #0f8;`;
          marker.title = 'Seg ' + (i+1) + ': ' + seg.start.toFixed(1) + 's - ' + (seg.start + seg.dur).toFixed(1) + 's';
          markers.appendChild(marker);
        });
      }
    }
    // (zip0148) timeDisp.textContent assignment removed (element gone).
    
    // A-B looping
    if (_vpState.aPoint !== null && _vpState.bPoint !== null && _vpState.bPoint > _vpState.aPoint) {
      if (ct >= _vpState.bPoint) {
        if (_vpState.isYT) _vpState.player.seekTo(_vpState.aPoint, true);
        else _vpState.player.setCurrentTime(_vpState.aPoint);
      }
    }
    // Segment looping in Selected mode
    else if (_vpState.isSelected) {
      const seg = _vpState.segs[_vpState.segIdx];
      if (ct >= seg.start + seg.dur) {
        if (_vpState.isYT) _vpState.player.seekTo(seg.start, true);
        else _vpState.player.setCurrentTime(seg.start);
      }
    }
    
    vpUpdatePlayBtn();
  };
  
  if (_vpState.isYT) {
    const ct = _vpState.player.getCurrentTime();
    const dur = _vpState.player.getDuration();
    updateUI(ct, dur);
  } else {
    Promise.all([
      _vpState.player.getCurrentTime(),
      _vpState.player.getDuration()
    ]).then(([ct, dur]) => updateUI(ct, dur));
  }
}

// YouTube mount for VP
// (zip0149) Helper: as soon as YT or Vimeo SDK injects an <iframe> into
// our host div, stamp it with an `allow` attribute that grants autoplay,
// encrypted-media, and fullscreen permissions. This is the documented
// fix (per caniuse / MDN Permissions Policy) for Opera Mini Android,
// which otherwise blocks media — including muted autoplay — inside
// cross-origin iframes that lack an explicit allow grant.
//
// We also set `playsinline` as a property (boolean) since some Webkit
// derivatives still consult it to decide whether to escape to a native
// fullscreen player on tap.
//
// MutationObserver fires synchronously-ish (microtask) after the iframe
// is appended but before its document load completes, so the permission
// policy is applied in time. Falls back to setting the attribute on any
// pre-existing iframe (defensive — should be a no-op).
function vpAllowAutoplayOnIframe(host) {
  if (!host) return;
  const stamp = (ifr) => {
    try {
      ifr.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
      ifr.setAttribute('allowfullscreen', 'true');
      ifr.setAttribute('playsinline', '');
      ifr.setAttribute('webkit-playsinline', '');
    } catch (_) {}
  };
  // Existing iframe (defensive)
  const existing = host.querySelector('iframe');
  if (existing) stamp(existing);
  // Future iframe
  try {
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node && node.tagName === 'IFRAME') stamp(node);
          else if (node && node.querySelector) {
            const nested = node.querySelector('iframe');
            if (nested) stamp(nested);
          }
        }
      }
    });
    obs.observe(host, { childList: true, subtree: true });
    // Auto-disconnect after 5s — by then the iframe is mounted and stamped.
    setTimeout(() => { try { obs.disconnect(); } catch (_) {} }, 5000);
  } catch (_) {}
}

function vpMountDirectVideo(host, link, seg, muted) {
  host.innerHTML = '';
  const vid = document.createElement('video');
  vid.src = link;
  vid.controls = true;
  vid.autoplay = true;
  vid.playsInline = true;
  vid.muted = !!muted;
  vid.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;';
  if (seg && seg.start) vid.currentTime = seg.start;
  host.appendChild(vid);
  // Wrap in a minimal player-like object so vpClose/stop can call destroy()
  _vpState.player = {
    isDirectVideo: true,
    el: vid,
    destroy: () => { vid.pause(); vid.src = ''; },
    getCurrentTime: () => Promise.resolve(vid.currentTime),
    getPlayerState: () => (vid.paused ? 2 : 1),
    getPaused: () => Promise.resolve(vid.paused),
    seekTo: (t) => { vid.currentTime = t; },
    playVideo: () => vid.play(),
    stopVideo: () => { vid.pause(); vid.currentTime = 0; },
    setPlaybackRate: (r) => { vid.playbackRate = r; },
    mute: () => { vid.muted = true; },
    unMute: () => { vid.muted = false; },
    isMuted: () => Promise.resolve(vid.muted)
  };
  _vpState.isYT = false;
  _vpState.interval = setInterval(vpUpdateTimeline, 250);
}

function vpMountYouTube(host, link, seg, muted) {
  const vidId = window.getYouTubeId ? window.getYouTubeId(link) : link.match(/(?:v=|\/embed\/|\/shorts\/|\/live\/|youtu\.be\/)([A-Za-z0-9_-]{11})/)?.[1];
  if (!vidId) return;
  
  host.innerHTML = '';
  const iframe = document.createElement('div');
  iframe.id = 'vp-yt-player';
  host.appendChild(iframe);
  
  // (zip0149) Arm the iframe-allow stamper BEFORE YT.Player creates the
  // iframe. The observer is now watching `host` and will fire the
  // moment the YT SDK appends its iframe child.
  vpAllowAutoplayOnIframe(host);
  
  const onReady = () => {
    const player = new YT.Player('vp-yt-player', {
      videoId: vidId,
      width: '100%',
      height: '100%',
      // (zip0149) Match the playerVars that the grid-cell mount uses
      // (see video.js mountYouTubeClip). The critical additions for
      // Opera Mini Android are:
      //   playsinline: 1   — forbids native fullscreen escape on tap;
      //                      without it, mobile browsers can refuse to
      //                      autoplay inline at all
      //   origin:          — YouTube increasingly requires this for
      //                      cross-origin embeds and silently fails
      //                      certain operations (notably autoplay)
      //                      when absent
      //   disablekb: 1     — keeps native YT keyboard hooks out of our
      //                      way (matches grid)
      //   iv_load_policy:3 — hides annotations
      playerVars: {
        autoplay: 1,
        start: Math.floor(seg.start),
        controls: 0,
        modestbranding: 1,
        rel: 0,
        fs: 0,
        playsinline: 1,
        disablekb: 1,
        iv_load_policy: 3,
        cc_load_policy: 0,
        endscreen: 0,
        origin: window.location.origin || window.location.hostname || 'localhost'
      },
      events: {
        onReady: e => {
          _vpState.player = e.target;
          _vpState.isYT = true;
          if (muted) e.target.mute();
          e.target.seekTo(seg.start, true);
          e.target.playVideo();
          // (zip0149) Belt-and-braces: re-stamp `allow` on the live iframe
          // once we have a guaranteed reference to it, in case the
          // observer missed it (some browsers fire mutations late).
          try {
            const ifr = e.target.getIframe && e.target.getIframe();
            if (ifr) {
              ifr.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
              ifr.setAttribute('allowfullscreen', 'true');
              ifr.setAttribute('playsinline', '');
              ifr.setAttribute('webkit-playsinline', '');
            }
          } catch (_) {}
          // Start timeline updater
          _vpState.interval = setInterval(vpUpdateTimeline, 100);
        }
      }
    });
  };
  
  if (window.YT && window.YT.Player) onReady();
  else {
    window.onYouTubeIframeAPIReady = onReady;
    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    }
  }
}

// Vimeo mount for VP
function vpMountVimeo(host, link, seg, muted) {
  const vidId = link.match(/vimeo\.com\/(\d+)/)?.[1];
  if (!vidId) return;
  
  host.innerHTML = '';
  
  // (zip0149) Same iframe-allow treatment as the YT mount above.
  // Vimeo's SDK creates its iframe inside `host` so the observer
  // will catch it.
  vpAllowAutoplayOnIframe(host);
  
  const loadPlayer = () => {
    const player = new Vimeo.Player(host, {
      id: vidId,
      autoplay: true,
      muted: muted,
      controls: false,
      // (zip0149) playsinline tells Vimeo to render inside the iframe
      // rather than launching a native fullscreen player on mobile.
      playsinline: true,
      width: host.clientWidth,
      height: host.clientHeight
    });
    
    player.ready().then(() => {
      _vpState.player = player;
      _vpState.isYT = false;
      player.setCurrentTime(seg.start);
      player.play();
      // (zip0149) Re-stamp allow attribute on the now-mounted iframe.
      try {
        const ifr = host.querySelector('iframe');
        if (ifr) {
          ifr.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
          ifr.setAttribute('allowfullscreen', 'true');
          ifr.setAttribute('playsinline', '');
          ifr.setAttribute('webkit-playsinline', '');
        }
      } catch (_) {}
      _vpState.interval = setInterval(vpUpdateTimeline, 100);
    });
  };
  
  if (window.Vimeo && window.Vimeo.Player) loadPlayer();
  else {
    const tag = document.createElement('script');
    tag.src = 'https://player.vimeo.com/api/player.js';
    tag.onload = loadPlayer;
    document.head.appendChild(tag);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// GLOBAL HOTKEY HANDLER
// T = Table, E = Edit, G = Grid (single letters, no Alt needed)
// ══════════════════════════════════════════════════════════════════════════════
window._executeHotkey = function(key) {
  // Check what's currently open
  const veOpen = !!document.getElementById('video-editor-overlay');
  const ebOpen = document.getElementById('browseOverlay')?.style.display === 'flex';
  const gridOpen = document.getElementById('gridOverlay')?.style.display === 'flex';
  const vpOpen = document.getElementById('gridFullscreen')?.style.display === 'flex';
  let teOpen = !!document.getElementById('textEditorOverlay');
  const tgOpen = _cMode;

  // (zip0183) TGAD hotkeys work from Xe (text editor) even when the overlay
  // is focused (editor blurred). Auto-save and close Xe first, then let the
  // normal hotkey path run. Keys that Xe owns exclusively (S, ArrowUp/Down,
  // Esc) never reach _executeHotkey because xe.js's capture-phase listener
  // intercepts them first.
  if (teOpen && (key === 't' || key === 'g' || key === 'a' || key === 'd' || key === 'm')) {
    if (typeof _textEditorDoSave === 'function') _textEditorDoSave();
    if (typeof textEditorClose === 'function') textEditorClose();
    teOpen = false; // fall through to the hotkey handler below
  }

  // (zip0141) In user mode (Gu/Cu only), block hotkeys that lead to
  // dev-only screens (T, E, A). G stays accessible — that's the user's
  // home screen.
  const userMode = (typeof _isUserMode === 'function') ? _isUserMode() : false;
  if (userMode && (key === 't' || key === 'e' || key === 'a')) return;
  
  // T = Save and go to Table
  if (key === 't') {
    if (tgOpen) { closeGridList(); return; }
    if (vpOpen) vpClose();
    if (veOpen) {
      const cb = document.getElementById('v2close');
      if (cb) cb.click();
      window._cameFromGrid = false;
      setTimeout(() => buildTable(), 50);
      return;
    }
    if (ebOpen) {
      brSave();
      document.getElementById('browseOverlay').style.display = 'none';
      document.getElementById('wrap').style.marginRight = '';
      brClearMedia();
    }
    if (gridOpen) {
      gridCleanupPlayers();
      gridClearCut();
      gridHideContextMenu();
      document.getElementById('gridOverlay').style.display = 'none';
    }
    _cameFromGrid = false;
    buildTable();
    return;
  }
  
  // G = Save and go to Grid
  if (key === 'g') {
    if (tgOpen) { closeGridList(); gridShow(); return; }
    
    // If in VP (Video/Image View), close it and stay in grid
    if (vpOpen) {
      vpClose();
      return; // Grid is already showing behind VP
    }
    
    // If already in grid (and not in VP), do nothing
    if (gridOpen) return;
    
    // Close VE and go to grid
    if (veOpen) {
      const cb = document.getElementById('v2close');
      if (cb) cb.click();
      setTimeout(() => { buildTable(); gridShow(); }, 50);
      return;
    }
    
    // Close EB and go to grid
    if (ebOpen) {
      brSave();
      document.getElementById('browseOverlay').style.display = 'none';
      document.getElementById('wrap').style.marginRight = '';
      brClearMedia();
    }
    buildTable();
    gridShow();
    return;
  }
  
  // E = Editor — Video Editor for video rows, Text/HTML editor for ftext rows
  // (zip0133) Was video-only; now also routes ftext (HTML slides + JSON
  // quizzes) rows into gridOpenTextEditor. Routing is row-content based:
  //   - isVideoRow(row)  → openVideoEditor (the existing E screen)
  //   - row.ftext or VidRange='text' → gridOpenTextEditor
  //   - otherwise → "no editor for this row type" toast.
  if (key === 'e') {
    if (teOpen) return;
    if (veOpen) return; // already in VE
    if (vpOpen) vpClose();

    let rowToEdit = null;
    if (!gridOpen && focus !== null) {
      const di = vr(focus.r);
      if (di >= 0 && di < data.length) rowToEdit = data[di];
    }
    if (!rowToEdit && _lastGridRow) rowToEdit = _lastGridRow;

    if (!rowToEdit) {
      // (zip0184) No focused row — select the first visible filtered row
      // (same set that arrow-key navigation uses) and open its editor.
      const _visList = (typeof brGetVisibleRows === 'function')
        ? brGetVisibleRows()
        : (typeof data !== 'undefined' ? data.map((_, i) => i) : []);
      if (!_visList.length) { toast('No rows available', 1500); return; }
      const _firstDi = _visList[0];
      rowToEdit = (typeof data !== 'undefined') ? data[_firstDi] : null;
      if (!rowToEdit) { toast('No rows available', 1500); return; }
      // Also update T's focused row so it's highlighted when returning to T
      if (typeof window._setFocusToRow === 'function') window._setFocusToRow(rowToEdit);
    }

    // (zip0178) Seed _brRows / _brIdx so arrow-key navigation in Xe / Ie
    // knows where to start without reinitialising the filter context.
    _ensureBrRows();
    {
      const _di = (typeof data !== 'undefined') ? data.indexOf(rowToEdit) : -1;
      if (_di >= 0) {
        const _fi = window._brRows.indexOf(_di);
        if (_fi >= 0) window._brIdx = _fi;
      }
    }

    const isText = rowToEdit.VidRange === 'text'
      || rowToEdit.ltype === 'w'
      || (typeof rowToEdit.ftext === 'string' && rowToEdit.ftext.length > 0);

    if (isText) {
      // Route to the HTML/text editor (handles both rich-text slides and
      // JSON quiz definitions — the editor itself detects which).
      if (typeof gridOpenTextEditor === 'function') {
        gridOpenTextEditor(rowToEdit.cell || '', rowToEdit);
      } else {
        toast('Text editor not available', 1800);
      }
      return;
    }

    // (zip0178) Image rows → Ie: image fullscreen + Annotate panel side by side.
    // Previously showed a "use A" toast; now opens a proper editor-like view.
    if (rowToEdit.link && !isVideoRow(rowToEdit)) {
      _cameFromGrid = gridOpen;
      if (gridOpen) {
        gridCleanupPlayers();
        gridHideContextMenu();
        document.getElementById('gridOverlay').style.display = 'none';
      }
      openIe(rowToEdit);
      return;
    }

    if (!isVideoRow(rowToEdit)) {
      toast('E = Editor (videos, ftext, or image rows)\nUse A to annotate', 1800);
      return;
    }

    _cameFromGrid = gridOpen;
    if (gridOpen) {
      gridCleanupPlayers();
      gridHideContextMenu();
      document.getElementById('gridOverlay').style.display = 'none';
    }
    // Close Annotate if open
    if (ebOpen) {
      brSave();
      document.getElementById('browseOverlay').style.display = 'none';
      document.getElementById('wrap').style.marginRight = '';
      brClearThumb();
    }
    if (window.openVideoEditor) window.openVideoEditor(rowToEdit);
    return;
  }

  // A = Annotate panel (images and videos)
  // Accessible from T (table), G (grid), or V (fullscreen viewer).
  if (key === 'a') {
    if (veOpen) return; // VE takes priority
    if (tgOpen) closeCScreen(); // close C-screen before opening annotate
    if (vpOpen) vpClose();

    // Toggle: if already open, close it
    if (ebOpen) { brSave(); brClose(); return; }

    let startDi = undefined;
    if (!gridOpen && focus !== null) {
      startDi = vr(focus.r);
    } else if (_lastGridRow) {
      startDi = data.indexOf(_lastGridRow);
    }

    _cameFromGrid = gridOpen;
    brOpen(startDi);
    return;
  }
  
  // M = Open Main Menu (hamburger)
  if (key === 'm') {
    toggleHM();
    return;
  }

  // (zip0155) H = Toggle Help. Works from any screen and in any mode.
  // Was previously only wired through the table-only handler at line ~4886
  // (gated on `tableVisible`), which made it unreachable from G/Gu/Cu and
  // any user-mode screen. _executeHotkey is the right place for it — it
  // runs ahead of the table handler and isn't gated on overlay state.
  if (key === 'h') {
    if (teOpen || veOpen) return; // text editor and video editor own their own keys
    if (typeof isHelpOpen === 'function' && typeof openHelp === 'function') {
      isHelpOpen() ? closeHelp() : openHelp();
    }
    return;
  }
  
  // (zip0159) V = Open fullscreen viewer (V / I / Q / X) for the focused
  // T row or the last grid row. Works from T and from G (mirrors swipe-
  // right behaviour). If a V/I/Q/X screen is already showing, close it.
  if (key === 'v') {
    if (teOpen) return;
    if (veOpen) return;
    // Toggle: if fullscreen viewer is already open, close it.
    if (vpOpen) { vpClose(); return; }

    let row = null;
    // From T: use focused row
    if (!gridOpen && focus !== null) {
      const di = vr(focus.r);
      if (di >= 0 && di < data.length) row = data[di];
    }
    // From G: use last interacted grid row
    if (!row && typeof _lastGridRow !== 'undefined' && _lastGridRow) row = _lastGridRow;
    // Fallback: last UID
    if (!row && window._lastUID) {
      row = data.find(r => String(r.UID) === String(window._lastUID));
    }
    if (!row) { toast('Select a row first', 1500); return; }
    // Ensure grid overlay is visible if it isn't (V sits on top of it
    // visually but needs its DOM siblings to be present).
    const gOvl = document.getElementById('gridOverlay');
    if (gOvl && gOvl.style.display !== 'flex') {
      gOvl.style.display = 'flex';
    }
    gridOpenFullscreen(row);
    return;
  }

  // C = Collection screen (c.json)
  if (key === 'c') {
    if (teOpen) return;
    if (tgOpen) { closeCScreen(); return; } // toggle off
    // Close any open overlays first
    if (vpOpen) vpClose();
    if (veOpen) {
      const cb = document.getElementById('v2close');
      if (cb) cb.click();
    }
    if (ebOpen) {
      brSave();
      document.getElementById('browseOverlay').style.display = 'none';
      document.getElementById('wrap').style.marginRight = '';
      brClearMedia();
    }
    if (gridOpen) {
      gridCleanupPlayers();
      gridClearCut();
      gridHideContextMenu();
      document.getElementById('gridOverlay').style.display = 'none';
    }
    openCScreen();
    return;
  }

  // D = Dictionary overlay (tag dictionary)
  // (zip0158) If T is the active screen and the focused row has any tag,
  // open the dictionary FOR that tag (tree view, ancestors expanded,
  // tag selected). With no focused row or no tags on it, open the
  // dictionary normally to its last state.
  if (key === 'd') {
    if (veOpen) return;
    let opened = false;
    if (!gridOpen && !vpOpen && !ebOpen && !tgOpen
        && typeof focus !== 'undefined' && focus !== null
        && typeof vr === 'function'
        && Array.isArray(data)) {
      const di = vr(focus.r);
      const row = data[di];
      const ids = row && Array.isArray(row.tags) ? row.tags : [];
      if (ids.length > 0 && typeof window.openDictForTag === 'function') {
        window.openDictForTag(ids[0]);
        opened = true;
      }
    }
    if (!opened && window.openDictionary) window.openDictionary();
    return;
  }

  // L = same as W (smart clipboard import — bare links or @channel CSV)
  if (key === 'l') {
    if (teOpen || veOpen || ebOpen || gridOpen || vpOpen || tgOpen) return;
    if (document.getElementById('dictOverlay'))    return;  // Dictionary open
    if (document.getElementById('mergeModal'))     return;  // Merge modal open
    if (typeof wantLinks === 'function') wantLinks();
    return;
  }

  // W = smart clipboard import (Rule 1 bare links or Rule 2 channel CSV)
  if (key === 'w') {
    if (teOpen || veOpen || ebOpen || gridOpen || vpOpen || tgOpen) return;
    if (document.getElementById('dictOverlay'))    return;
    if (document.getElementById('mergeModal'))     return;
    if (typeof wantLinks === 'function') wantLinks();
    return;
  }

  // F = open filter modal (T-view only). Modal is composite: tags ∧ text-field
  // substring matches across VidAuthor / VidTitle / link / ftext. Pressing F
  // again toggles it closed. Modal updates the table live as you type. Inside
  // the modal's inputs F is a literal letter — use Esc to close from there.
  if (key === 'f') {
    if (teOpen || veOpen || ebOpen || gridOpen || vpOpen || tgOpen) return;
    if (document.getElementById('dictOverlay'))    return;
    if (document.getElementById('mergeModal'))     return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    if (typeof window.openFilterModal === 'function') window.openFilterModal();
    return;
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// Ie — IMAGE EDITOR: fullscreen image + Annotate panel side by side (zip0178)
//
// openIe(row)           Show the image in V-style fullscreen (Iu) while
//                       keeping / opening the Annotate panel on the right.
//                       browseOverlay (z-index 30000) sits above gridFullscreen
//                       (z-index 28500), so the annotate panel is always
//                       accessible. The image fills the ~2/3 of the screen not
//                       covered by the 340px panel.
//
// openEditorForRow(row) Route-and-open the right E screen for any row type.
//                       Used by Xe ↑/↓ and Ie ↑/↓ so navigating between row
//                       types opens the correct editor (Xe→text, Ie→image,
//                       Ev→video) without special-casing in each E screen.
//                       Exposed as window.openEditorForRow for xe.js to call.
// ══════════════════════════════════════════════════════════════════════════════

function _ensureBrRows() {
  if (!window._brRows || !window._brRows.length) {
    window._brRows = (typeof brGetVisibleRows === 'function')
      ? brGetVisibleRows() : [];
  }
}

function openIe(row) {
  if (!row) return;
  _ensureBrRows();
  const di = (typeof data !== 'undefined') ? data.indexOf(row) : -1;
  if (di >= 0) {
    const fi = window._brRows.indexOf(di);
    if (fi >= 0) window._brIdx = fi;
  }

  // (zip0185) Lift hop cover (if present) once Ie is starting to paint.
  {
    const _hopCover = document.getElementById('ve-hop-cover');
    if (_hopCover) {
      setTimeout(() => { const c = document.getElementById('ve-hop-cover'); if (c) c.remove(); }, 60);
      clearTimeout(window._veHopCoverTimer);
    }
  }

  // Show image fullscreen (Iu view)
  gridOpenFullscreen(row);

  // If A is already open, navigate it to this row. Do NOT auto-open A.
  const annotateEl = document.getElementById('browseOverlay');
  const annotateOpen = annotateEl && annotateEl.style.display !== 'none';
  if (annotateOpen && di >= 0 && typeof brShow === 'function') {
    const fi = window._brRows.indexOf(di);
    if (fi >= 0) { window._brIdx = fi; brShow(fi); }
  }
}

function openEditorForRow(row) {
  // (zip0178) Shared E-screen router used by Xe/Ie arrow navigation.
  if (!row) return;
  const isText = row.VidRange === 'text' || row.ltype === 'w'
              || (typeof row.ftext === 'string' && row.ftext.length > 0);

  if (isText) {
    if (typeof gridOpenTextEditor === 'function')
      gridOpenTextEditor(row.cell || '', row);
    return;
  }
  if (typeof isVideoRow === 'function' && isVideoRow(row)) {
    _cameFromGrid = false;
    if (window.openVideoEditor) window.openVideoEditor(row);
    return;
  }
  if (row.link) {
    openIe(row);
    return;
  }
  if (typeof toast === 'function') toast('No editor available for this row type', 1500);
}
window.openEditorForRow = openEditorForRow;
