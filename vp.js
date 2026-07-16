
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
    // (dev0258) Pull VidComment labels (comma-separated, one per seg —
    // matches video.js writer) so timeline bands can render their labels.
    const _vpComments = (row.VidComment || '').split(',').map(s => s.trim());
    segs.forEach((s, i) => { s.comment = _vpComments[i] || ''; });
    
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

    // ── TOUCH (dev0262): two-finger spread/pinch = zoom, two-finger pan,
    //     double-tap = return to G. Single tap = play/pause toggle.
    //     R→L one-finger swipe still closes (legacy escape hatch).
    (function wireTouchV() {
      const _ptrs = new Map();
      let _pinch = null, _drag = null, _swipe = null;
      let _lastTap = 0, _lastTapP = null;

      swipeCatcher.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse') return;
        try { swipeCatcher.setPointerCapture(e.pointerId); } catch(_) {}
        const p = _vpxy(e);
        _ptrs.set(e.pointerId, p);

        if (_ptrs.size >= 2) {
          // Begin pinch / two-finger pan
          _swipe = null;
          const [a, b] = [..._ptrs.values()];
          _pinch = {
            scale: _vScale, tx: _vTx, ty: _vTy,
            dist: Math.hypot(b.x - a.x, b.y - a.y),
            mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2
          };
          _drag = null;
        } else {
          _pinch = null;
          _drag  = null;
          _swipe = { x: p.x, y: p.y, t: Date.now() };
        }
      }, true);

      swipeCatcher.addEventListener('pointermove', e => {
        if (e.pointerType === 'mouse' || !_ptrs.has(e.pointerId)) return;
        const p = _vpxy(e);
        _ptrs.set(e.pointerId, p);

        if (_ptrs.size >= 2 && _pinch) {
          const [a, b] = [..._ptrs.values()];
          const dist = Math.hypot(b.x - a.x, b.y - a.y);
          const mx   = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          // Spread → scale up; pinch → scale down. Clamp [0.9, 8].
          _vScale = Math.min(8, Math.max(0.9, _pinch.scale * dist / _pinch.dist));
          // Two-finger pan: track centroid movement.
          _vTx    = _pinch.tx + (mx - _pinch.mx);
          _vTy    = _pinch.ty + (my - _pinch.my);
          _vApply();
          _swipe = null;
        }
      }, true);

      swipeCatcher.addEventListener('pointerup', e => {
        if (e.pointerType === 'mouse' || !_ptrs.has(e.pointerId)) return;
        const p = _vpxy(e);
        _ptrs.delete(e.pointerId);

        if (_ptrs.size === 0) {
          // All fingers lifted
          if (_swipe) {
            const dx = p.x - _swipe.x, dy = p.y - _swipe.y;
            const ms = Date.now() - _swipe.t;
            const horiz = Math.abs(dx) > 40 && Math.abs(dy) < Math.abs(dx) && ms < 800 && _vScale < 1.1;
            // R→L swipe (legacy close). In a slideshow this advances to the
            // NEXT slide (the signal is a no-op outside a slideshow video).
            if (horiz && dx < 0) {
              if (window._slideshowVideoSwipe) window._slideshowVideoSwipe(1);
              _swipe = null; vpClose(); return;
            }
            // (dev0281) L→R swipe — only meaningful in a slideshow: close and
            // go to the PREVIOUS slide. Standalone V keeps its old behavior.
            if (horiz && dx > 0 && _vpState && _vpState.slideshowNoLoop) {
              if (window._slideshowVideoSwipe) window._slideshowVideoSwipe(-1);
              _swipe = null; vpClose(); return;
            }
            // Quick stationary tap
            if (Math.abs(dx) < 14 && Math.abs(dy) < 14 && ms < 300) {
              const now = Date.now();
              if (now - _lastTap < 350 && _lastTapP &&
                  Math.abs(p.x - _lastTapP.x) < 30 &&
                  Math.abs(p.y - _lastTapP.y) < 30) {
                // Double-tap → return to G
                _lastTap = 0; _lastTapP = null;
                _swipe = null; vpClose(); return;
              }
              _lastTap = now; _lastTapP = p;
              _swipe = null;
              if (typeof vpTogglePlay === 'function') vpTogglePlay();
              return;
            }
          }
          _swipe = null; _pinch = null; _drag = null;
        } else if (_ptrs.size === 1 && _pinch) {
          // One finger left after pinch — drop pinch state
          _pinch = null;
        }
      }, true);

      swipeCatcher.addEventListener('pointercancel', e => {
        if (e.pointerType === 'mouse') return;
        _ptrs.delete(e.pointerId);
        if (_ptrs.size === 0) { _swipe = null; _pinch = null; _drag = null; }
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
          const horiz = Math.abs(dx) > 60 && Math.abs(dy) < Math.abs(dx) &&
                        Date.now() - mStart.t < 1500;
          // R→L drag → close (slideshow: next slide).
          if (horiz && dx < 0) {
            if (window._slideshowVideoSwipe) window._slideshowVideoSwipe(1);
            vpClose(); return;
          }
          // (dev0281) L→R drag in a slideshow → previous slide.
          if (horiz && dx > 0 && _vpState && _vpState.slideshowNoLoop) {
            if (window._slideshowVideoSwipe) window._slideshowVideoSwipe(-1);
            vpClose(); return;
          }
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

    // ── (dev0410) FLOATING STEP BUTTON (fsb) ─────────────────────────────
    // Right-click the V video area pops ONE small floating panel AT THE CURSOR
    // (it never centers and never moves itself). It has NOTHING to do with the
    // A-B select feature — Row 3 carries its OWN start/duration. Rows:
    //   Row 1 PLAY-IN-STEPS:  ◀ [secs] ▶  ◀ free-runs backward / ▶ forward,
    //         one frame every `secs` s (wheel secs ±0.05, range 0–10;
    //         (dev0555) wheeling down to 0 FREEZES on the current frame,
    //         wheel back up to resume).
    //   Row 2 SINGLE STEP:    ◀ [▶/⏸] ▶  ◀/▶ nudge one frame; center = normal
    //         play / pause toggle.
    //   Row 3 FRAME WINDOW:   ⇄ [s] [d] ▶  two boxes define the window in
    //         frames — s (start, seeded to the frame under the playhead at
    //         right-click, wheel ±1) and d (duration in frames, init 10,
    //         wheel ±1). ⇄ plays the window then reverses (ping-pong loop);
    //         ▶ plays the window then restarts from s (forward loop). Both
    //         step one frame every Row-1 `secs`.
    //   Row 4: Choose / Save (still stubs).
    // Changing `secs` re-rates a running loop IMMEDIATELY; changing s or d
    // takes effect at the END of the current cycle (the box is tinted amber
    // while a change is pending).
    // Right-click while a loop runs → stop it (panel stays, two-stage); a
    // further right-click closes the panel and resumes play.
    // Wired ONCE on #gridFsContent (it persists across opens); handlers read
    // live globals so they keep working for every later V.
    (function wireFloatingStepButton() {
      if (content._fsbWired) return;
      content._fsbWired = true;

      const FRAME = 1 / 30;     // ~1 video frame (matches the arrow-key step)
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

      // ── shared, stateless UI + player helpers ──────────────────────────
      function hl(btn, on) {
        btn.style.background  = on ? '#07c' : '#113';
        btn.style.borderColor = on ? '#0cf' : '#06f';
      }
      function mkBtn(html, title, minW) {
        const b = document.createElement('button');
        b.className = 'vp-btn';
        b.innerHTML = html;
        if (title) b.title = title;
        b.style.cssText += 'height:30px;font-size:15px;min-width:' + (minW || 34) + 'px;';
        b.addEventListener('pointerdown', e => e.stopPropagation());
        return b;
      }
      function mkBox(text, title) {
        const d = document.createElement('div');
        d.textContent = text;
        if (title) d.title = title;
        d.style.cssText = 'min-width:50px;height:30px;display:flex;align-items:center;'
          + 'justify-content:center;background:#001;color:#fd6;border:1px solid #08a;'
          + 'border-radius:4px;font:bold 15px monospace;';
        return d;
      }
      function mkRow() {
        const r = document.createElement('div');
        r.style.cssText = 'display:flex;align-items:center;gap:6px;justify-content:center;';
        return r;
      }
      function mkPanel() {
        const p = document.createElement('div');
        p.id = 'vp-fsb';
        p.style.cssText = 'position:absolute;z-index:200;background:#000;border:2px solid #06f;'
          + 'border-radius:9px;padding:8px;display:flex;flex-direction:column;gap:6px;'
          + 'box-shadow:0 4px 18px rgba(0,0,0,0.7);user-select:none;touch-action:none;';
        p.addEventListener('pointerdown', e => e.stopPropagation());
        return p;
      }
      function placePanel(panel, clientX, clientY) {
        // Pin the panel's top-left to the cursor, clamped inside the content
        // rect so it stays fully on screen. Never centers; never moves later.
        // Desktop/mouse oriented (V isn't CSS-rotated when a mouse is in play).
        const cr = content.getBoundingClientRect();
        const pw = panel.offsetWidth || 180, ph = panel.offsetHeight || 200;
        let lx = (clientX == null) ? 12 : clientX - cr.left;
        let ly = (clientY == null) ? 12 : clientY - cr.top;
        lx = clamp(lx, 4, Math.max(4, cr.width  - pw - 4));
        ly = clamp(ly, 4, Math.max(4, cr.height - ph - 4));
        panel.style.left = lx + 'px';
        panel.style.top  = ly + 'px';
        return { x: cr.left + lx, y: cr.top + ly };
      }
      function seekAbs(t) {
        const p = _vpState && _vpState.player; if (!p) return;
        try { if (_vpState.isYT) p.seekTo(t, true); else p.setCurrentTime(t); } catch (_) {}
      }
      function curT() {
        // Real current time. Disk/direct videos expose a synchronous <video>
        // via `.el`; YT/Vimeo fall back to the poller-maintained value.
        const p = _vpState && _vpState.player;
        if (p && p.el && Number.isFinite(p.el.currentTime)) return p.el.currentTime;
        return _vpState ? (_vpState.currentTime || 0) : 0;
      }
      function seekBusy() {
        // Disk/direct video exposes a real <video> via `.el`. While it is still
        // seeking, assigning currentTime again ABORTS the in-flight seek before
        // it renders — so at fast rates the frame never lands and the window
        // loop looks frozen. Callers skip a tick when this is true, letting the
        // prior seek complete first; the effective rate then honestly tracks how
        // fast the decoder can seek. YT/Vimeo have no `.el` → never busy here.
        const p = _vpState && _vpState.player;
        return !!(p && p.el && p.el.seeking);
      }

      // (dev0564/0565) After Save, pre-build the saved steps as a LOCAL clip via
      // the proxy (/frame/grab → yt-dlp -g + ffmpeg → steps/<VidTitle>.<x_s_d>.mp4,
      // stepped playback baked in; freeze = 5s still clip). G's step-frame mode
      // (hotkey A on the grid) loops it in a plain muted <video> — the only
      // chrome-free way to display YT frames in a cell. steps/ is gitignored
      // (grabbed material stays on this machine, never the public site). Web-video
      // rows only — disk/FSA rows have no URL the proxy can fetch. Fire-and-forget:
      // the steps themselves are already saved; G can also re-grab on demand.
      async function grabStepFrames(row, secs, startFrame, numFrames) {
        const name = (typeof window.stepClipName === 'function') ? window.stepClipName(row) : '';
        if (!name) return;
        if (!/^https?:\/\//i.test(row.link || '')) {
          if (typeof toast === 'function') toast('Step clip not grabbed — web videos only.', 2200);
          return;
        }
        if (typeof toast === 'function') toast('⏳ Building step clip for G…', 2600);
        try {
          const r = await fetch(PROXY_BASE + '/frame/grab', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: row.link, name, x: secs, s: startFrame, d: numFrames })
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
          if (typeof toast === 'function')
            toast('✓ steps/' + j.file + ' (' + j.frames + ' frame' + (j.frames === 1 ? '' : 's')
              + (j.client ? ' · ' + j.client + ' — YT throttles this video\'s full-res streams' : '')
              + ') — press A on the grid to show it.', j.client ? 4600 : 3200);
        } catch (e) {
          if (typeof toast === 'function')
            toast('Step clip failed: ' + (e && e.message ? e.message : e)
              + ' — proxy restarted on 8081? Off VPN?', 4200);
        }
      }

      // ── the floating step button: one A-B-free frame-window panel ──────
      function buildFSB(clientX, clientY, init) {
        init = init || {};
        // (dev0415) Optional seed: saved x/s/d replayed from G "Play steps".
        let secs = isFinite(init.secs) ? clamp(+(+init.secs).toFixed(2), 0, 10) : 0.50;  // Row-1 rate: 1 frame / secs (0 = frozen)
        let startFrame = isFinite(init.startFrame) ? Math.max(0, init.startFrame | 0)
                                                   : Math.max(0, Math.round(curT() / FRAME));  // box "s"
        let numFrames  = isFinite(init.numFrames) ? Math.max(0, init.numFrames | 0) : 10;      // box "d" (0 = hold start frame)
        let activeStart = startFrame, activeDur = numFrames;       // what a running loop uses
        let autoTimer = null, autoDir = 0;            // Row-1 free-run step
        let playTimer = null, playMode = null;        // Row-3: 'fwd' | 'boom'
        let playPos = 0, playDir = 1;                 // frame offset + direction
        let lastTickFrame = -1;                       // (dev0555) last frame tickPlay seeked — lets d=0 hold without re-seeking
        let recording = false;                        // (dev0418) Row-4 "Choose" screen-record toggle

        const intervalMs = () => Math.max(16, Math.round(secs * 1000));

        function syncBtns() {
          hl(r1back, autoDir === -1); hl(r1fwd, autoDir === 1);
          hl(r3boom, playMode === 'boom'); hl(r3fwd, playMode === 'fwd');
          r2play.innerHTML = _vpIsPlaying() ? '⏸' : '▶';
        }
        function refreshPendingMarks() {              // amber box = change waiting for cycle end
          r3sBox.style.borderColor = (startFrame !== activeStart) ? '#fa0' : '#08a';
          r3dBox.style.borderColor = (numFrames  !== activeDur)   ? '#fa0' : '#08a';
        }

        // ── Row 1: free-running frame step (◀ back / ▶ fwd) ──
        function armAuto() {
          if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
          if (!autoDir) return;
          if (secs === 0) return;                    // (dev0555) rate 0 = freeze on the current frame; wheel up re-arms
          autoTimer = setInterval(() => {
            if (seekBusy()) return;                    // let the prior seek land first
            try { vpSeekRelative(autoDir * FRAME); } catch (_) {}
          }, intervalMs());
        }
        function startAuto(dir) {
          if (autoDir === dir) { autoDir = 0; armAuto(); syncBtns(); return; }
          stopPlay();
          if (_vpIsPlaying()) _vpPauseNow();
          autoDir = dir; armAuto(); syncBtns();
        }

        // ── Row 3: window loop over [activeStart .. activeStart+activeDur] ──
        function stopPlay() {
          if (playTimer) { clearInterval(playTimer); playTimer = null; }
          playMode = null;
        }
        function applyPending() {                     // commit s/d at a cycle boundary
          activeStart = startFrame; activeDur = numFrames; refreshPendingMarks();
        }
        function tickPlay() {
          if (seekBusy()) return;                      // honest rate: wait for the frame to render
          const span = Math.max(0, activeDur);
          playPos += playDir;
          if (playMode === 'boom') {                  // ⇄ play to end, reverse, repeat
            if (playPos >= span) { playPos = span; playDir = -1; }
            else if (playPos <= 0) { playPos = 0; playDir = 1; applyPending(); }  // full cycle
          } else if (playPos > span) {                // ▶ play to end, restart from s
            playPos = 0; applyPending();
          }
          const f = activeStart + playPos;
          if (span === 0 && f === lastTickFrame) return;   // (dev0555) d=0 → hold the start frame, don't re-seek every tick
          lastTickFrame = f;
          seekAbs(f * FRAME);
        }
        function armPlay() {                           // (re)start ticking at the current rate
          if (playTimer) { clearInterval(playTimer); playTimer = null; }
          if (!playMode) return;
          if (secs === 0) return;                      // (dev0555) rate 0 = freeze in place; wheel up re-arms
          playTimer = setInterval(tickPlay, intervalMs());
        }
        function startPlay(mode) {
          if (playMode === mode) { stopPlay(); syncBtns(); return; }   // toggle off
          if (autoDir) { autoDir = 0; armAuto(); }
          if (_vpIsPlaying()) _vpPauseNow();
          applyPending();                              // begin from the shown s/d
          playMode = mode; playDir = 1; playPos = 0;
          seekAbs(activeStart * FRAME);
          armPlay(); syncBtns();
        }

        const panel = mkPanel();

        // Row 1 — play in steps (free-running)
        const r1 = mkRow();
        const r1back = mkBtn('◀', 'Play backward in steps');
        const r1box  = mkBox(secs.toFixed(2), 'Seconds per step (wheel; down to 0 = freeze frame)');
        const r1fwd  = mkBtn('▶', 'Play forward in steps');
        r1back.onclick = e => { e.stopPropagation(); startAuto(-1); };
        r1fwd.onclick  = e => { e.stopPropagation(); startAuto(1); };
        r1.append(r1back, r1box, r1fwd);
        r1.addEventListener('wheel', e => {
          e.preventDefault(); e.stopPropagation();
          // Fine 0.01 steps at/below 0.10, coarse 0.05 steps above; floor 0.00.
          // (At exactly 0.10: scrolling up coarsens to 0.15, down refines to 0.09.)
          // (dev0555) Wheeling down THROUGH 0.01 lands on 0.00 = FREEZE FRAME
          // (armAuto/armPlay skip the timer at 0); wheel up resumes at 0.01.
          const up = e.deltaY < 0;
          const step = (up ? secs < 0.10 : secs <= 0.10) ? 0.01 : 0.05;
          secs = clamp(+(secs + (up ? step : -step)).toFixed(2), 0, 10);
          r1box.textContent = secs.toFixed(2);
          if (autoDir) armAuto();                      // x value re-rates the loop IMMEDIATELY
          if (playMode) armPlay();
        }, { passive: false });

        // Row 2 — single frame step + play/pause
        const r2 = mkRow();
        const r2back = mkBtn('◀', 'Step back one frame');
        const r2play = mkBtn('▶', 'Play / pause');
        const r2fwd  = mkBtn('▶', 'Step forward one frame');
        r2back.onclick = e => { e.stopPropagation(); if (_vpIsPlaying()) _vpPauseNow(); vpSeekRelative(-FRAME); syncBtns(); };
        r2fwd.onclick  = e => { e.stopPropagation(); if (_vpIsPlaying()) _vpPauseNow(); vpSeekRelative(FRAME); syncBtns(); };
        r2play.onclick = e => { e.stopPropagation(); vpTogglePlay(); setTimeout(syncBtns, 60); };
        r2.append(r2back, r2play, r2fwd);

        // Row 3 — frame window: ⇄ [s] [d] ▶  (its own self-defined range)
        const r3 = mkRow();
        const r3boom = mkBtn('⇄', 'Loop the window back-and-forth (ping-pong)');
        const r3sBox = mkBox(String(startFrame), 'Start frame (wheel ±1)');
        const r3dBox = mkBox(String(numFrames),  'Frames to play (wheel ±1; 0 = hold the start frame)');
        const r3fwd  = mkBtn('▶', 'Loop the window forward (restart from start)');
        r3boom.onclick = e => { e.stopPropagation(); startPlay('boom'); };
        r3fwd.onclick  = e => { e.stopPropagation(); startPlay('fwd'); };
        r3.append(r3boom, r3sBox, r3dBox, r3fwd);
        r3sBox.addEventListener('wheel', e => {        // s = start frame, ±1
          e.preventDefault(); e.stopPropagation();
          startFrame = clamp(startFrame + (e.deltaY < 0 ? 1 : -1), 0, 1e9);
          r3sBox.textContent = String(startFrame);
          if (!playMode) activeStart = startFrame;     // idle → now; running → end of cycle
          refreshPendingMarks();
        }, { passive: false });
        r3dBox.addEventListener('wheel', e => {        // d = # frames, ±1; (dev0555) floor 0 = hold the start frame
          e.preventDefault(); e.stopPropagation();
          numFrames = clamp(numFrames + (e.deltaY < 0 ? 1 : -1), 0, 100000);
          r3dBox.textContent = String(numFrames);
          if (!playMode) activeDur = numFrames;
          refreshPendingMarks();
        }, { passive: false });

        // ── (dev0419) "Choose" = record JUST the V video region to an .mp4 ──
        // gdigrab can crop to a screen rect, so instead of the whole desktop we
        // capture only #grid-fs-video (the video area, above the 80px toolbar).
        // To keep the capture clean: on record we HIDE this fsc panel and show a
        // small ⏹ stop button down in the toolbar strip — BELOW the captured
        // region, so neither the panel nor the button ever lands in the frame.
        // The step loop is timer-driven, so it keeps playing while the panel is
        // hidden; if nothing is looping yet we auto-start the forward window loop
        // so "Choose" always yields a stepped clip. Click ⏹ to stop & save.
        let recStopBtn = null;

        // Crop to the ACTUAL video pixels and map them to desktop DEVICE pixels
        // (what gdigrab's -offset_x/-offset_y/-video_size want). screenX/Y +
        // getBoundingClientRect are CSS px, so scale by devicePixelRatio. Assumes
        // a single primary, unzoomed monitor (true for the step-record workflow);
        // the viewport's screen-top is approximated as window.screenY + the top
        // chrome height. Clamped to the viewport + >=0 so the crop stays on the
        // primary desktop.
        //
        // (dev0421) dev0419 cropped to #grid-fs-video, but that host is
        // `inset:0 0 80px 0` — the WHOLE viewport minus the toolbar — so the clip
        // came out ~full-screen. The disk <video> is object-fit:contain, i.e.
        // letterboxed, so the real frame is a centered sub-rect; reuse
        // _vpCropRenderRect to find it.
        //
        // (dev0422) YT/Vimeo are cross-origin iframes — can't read the inner
        // <video>, and oEmbed only reports thumbnail dims (≈4:3/16:9, never the
        // true aspect). So assume 16:9 (landscape) / 9:16 (portrait — from a
        // /shorts/ URL or the row's P/S field), which is what virtually all
        // YT/Vimeo content is, and contain-fit that aspect inside the host.
        // Anything else (no video, no iframe) → host rect.
        function vRegionDevicePx() {
          const host = document.getElementById('grid-fs-video');
          if (!host) return null;
          const hr = host.getBoundingClientRect();
          const dpr = window.devicePixelRatio || 1;
          const chromeTop = Math.max(0, (window.outerHeight || 0) - (window.innerHeight || 0));

          // Default = whole host; shrink to the real video frame per media type.
          let left = hr.left, top = hr.top, right = hr.right, bottom = hr.bottom;
          const vid = host.querySelector('video');
          if (vid && vid.videoWidth > 0 && vid.videoHeight > 0) {
            // Disk <video> (object-fit:contain) — exact letterbox from intrinsic dims.
            const rr = _vpCropRenderRect(host, vid);   // host-local contain rect
            left  = hr.left + rr.rx;   top    = hr.top + rr.ry;
            right = left    + rr.rw;   bottom = top    + rr.rh;
          } else if (host.querySelector('iframe')) {
            // YT/Vimeo — contain-fit an assumed 16:9 / 9:16 inside the host.
            const row  = window._vpCurrentRow;
            const link = String((row && row.link) || '');
            const portrait =
                 /youtube\.com\/shorts\//i.test(link)
              || (window.isInstagramLink && window.isInstagramLink(link) && /\/reel\//i.test(link))
              || (window.rowMode && window.rowMode(row) === 'P')
              || (window.rowPSValue && window.rowPSValue(row) === 'P');
            const ar = portrait ? (9 / 16) : (16 / 9);   // width / height
            let rw = hr.width, rh = rw / ar;
            if (rh > hr.height) { rh = hr.height; rw = rh * ar; }
            left  = hr.left + (hr.width  - rw) / 2;   top    = hr.top + (hr.height - rh) / 2;
            right = left    + rw;                     bottom = top    + rh;
            // (dev0423) Landscape YT/Vimeo still paint a bottom control bar (seek
            // bar + icons + the gradient/spacing above it) while paused/stepped,
            // even with controls off — it sits at the bottom of the iframe (=host).
            // When the video fills the host height that bar overlays the video
            // bottom and lands in the crop, so pull the crop's bottom edge up out
            // of the chrome zone — but only where it WOULD overlap (a letterboxed
            // video that already ends above the bar is untouched). Portrait
            // (Shorts) shows no such bar, so leave it alone.
            if (!portrait) {
              const CHROME = 0.12;   // fraction of host height the bottom chrome spans
              bottom = Math.min(bottom, hr.bottom - hr.height * CHROME);
            }
          }

          // Clamp to the on-screen viewport so the crop stays on the desktop.
          left   = Math.max(0, left);
          top    = Math.max(0, top);
          right  = Math.min(window.innerWidth,  right);
          bottom = Math.min(window.innerHeight, bottom);
          if (right - left < 2 || bottom - top < 2) return null;
          return {
            x: Math.max(0, Math.round((window.screenX + left) * dpr)),
            y: Math.max(0, Math.round((window.screenY + chromeTop + top) * dpr)),
            w: Math.max(2, Math.round((right - left) * dpr)),
            h: Math.max(2, Math.round((bottom - top) * dpr))
          };
        }

        function showStopButton() {
          if (recStopBtn) return;
          const b = document.createElement('button');
          b.id = 'vp-rec-stop';
          // Far bottom-right corner, over the toolbar strip (below the captured
          // video region) so it never appears in the recording. z-index tops all.
          b.style.cssText = 'position:absolute;right:12px;bottom:20px;z-index:100000;'
            + 'height:40px;min-width:104px;padding:0 16px;border-radius:8px;'
            + 'border:2px solid #f44;background:#a00;color:#fff;font:bold 15px sans-serif;'
            + 'cursor:pointer;box-shadow:0 3px 14px rgba(0,0,0,0.7);';
          b.innerHTML = '⏹ Stop';
          b.title = 'Stop & save the recording';
          b.addEventListener('pointerdown', e => e.stopPropagation());
          b.onclick = e => { e.stopPropagation(); stopRecording(); };
          content.appendChild(b);
          recStopBtn = b;
        }
        function hideStopButton() {
          if (recStopBtn && recStopBtn.parentNode) recStopBtn.parentNode.removeChild(recStopBtn);
          recStopBtn = null;
        }

        async function startRecording() {
          if (recording) return;
          const region = vRegionDevicePx();
          panel.style.display = 'none';                 // out of frame before capture
          showStopButton();
          if (!playMode && !autoDir) startPlay('fwd');  // ensure the steps are running
          try {
            const r = await fetch(PROXY_BASE + '/rec/start', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(region ? { fps: 30, region } : { fps: 30 })
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
            recording = true;
            if (typeof toast === 'function')
              toast('● Recording the V video — click ⏹ Stop (bottom-right) to save.', 2600);
          } catch (e) {
            // Most likely the proxy isn't running — restore the panel + clean up.
            recording = false;
            hideStopButton();
            panel.style.display = '';
            if (typeof toast === 'function')
              toast('Record failed: ' + (e && e.message ? e.message : e)
                + ' — is proxy.js running on 8081?', 3600);
          }
        }

        async function stopRecording() {
          hideStopButton();
          panel.style.display = '';                     // bring the fsc panel back
          if (!recording) return;
          recording = false;
          try {
            const r = await fetch(PROXY_BASE + '/rec/stop', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
            });
            const j = await r.json().catch(() => ({}));
            if (j && j.output) {
              const name = String(j.output).split(/[\\/]/).pop();
              const dur = j.durationMs ? ' · ' + (j.durationMs / 1000).toFixed(1) + 's' : '';
              if (typeof toast === 'function') toast('✓ Saved ' + name + dur, 3000);
            } else if (typeof toast === 'function') {
              toast('Recording stopped' + (j && j.error ? ': ' + j.error : '') + '.', 2400);
            }
          } catch (e) {
            if (typeof toast === 'function')
              toast('Stop failed: ' + (e && e.message ? e.message : e), 3000);
          }
        }

        // Row 4 — Choose (screen-record toggle) / Save
        const r4 = mkRow();
        const chooseBtn = mkBtn('Choose', 'Record just the V video region to an .mp4 (panel hides; ⏹ Stop bottom-right)', 64);
        const saveBtn   = mkBtn('Save', 'Save these steps to the current row', 64);
        chooseBtn.onclick = e => { e.stopPropagation(); if (!recording) startRecording(); else stopRecording(); };
        // (dev0413) Save x/s/d to the current row's `steps` field in ml.json as a
        // compact "x,s,d" string (x = secs/frame rate, s = start frame, d = frames).
        // G's "Play steps" reads it back. String keeps the auto-discovered T column
        // readable (an object would render as [object Object]).
        saveBtn.onclick = e => { e.stopPropagation();
          const row = window._vpCurrentRow;
          if (!row) { if (typeof toast === 'function') toast('Save — no current row.', 1500); return; }
          row.steps = secs.toFixed(2) + ',' + startFrame + ',' + numFrames;
          if (typeof isoNow === 'function') row.DateModified = isoNow();
          if (typeof save === 'function') save();
          if (typeof toast === 'function')
            toast('✓ Steps saved: start ' + startFrame + ' · ' + numFrames
              + 'f @ ' + secs.toFixed(2) + 's', 1800);
          grabStepFrames(row, secs, startFrame, numFrames); };  // (dev0564) pre-grab jpgs for G's A toggle
        r4.append(chooseBtn, saveBtn);

        panel.append(r1, r2, r3, r4);
        content.appendChild(panel);
        const pos = placePanel(panel, clientX, clientY);
        syncBtns();
        if (init.autoPlay) startPlay('fwd');         // (dev0415) replay saved steps on open

        return {
          el: panel, pos,
          cleanup() {
            // (dev0418) Dismissed mid-record → tell the proxy to finalize the
            // mp4 (fire-and-forget; the file is still saved even as V closes).
            if (recording) {
              recording = false;
              try { fetch(PROXY_BASE + '/rec/stop', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
              }); } catch (_) {}
            }
            hideStopButton();
            if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
            if (playTimer) { clearInterval(playTimer); playTimer = null; }
            if (panel.parentNode) panel.parentNode.removeChild(panel);
          }
        };
      }

      function removeFSB(resumePlay) {
        const f = window._vpFSB;
        if (!f) return;
        try { f.cleanup(); } catch (_) {}
        window._vpFSB = null;
        if (resumePlay && _vpState && _vpState.player && !_vpIsPlaying()) {
          try { vpTogglePlay(); } catch (_) {}
        }
      }

      // (dev0415) Open the panel programmatically (not from a right-click),
      // seeded with saved x/s/d and optionally auto-running the forward loop.
      // Pinned to the lower-right corner above the 80px V toolbar. Used by G's
      // "Play steps" YouTube path so YT replays in V — the V path seeks it
      // cleanly (no in-cell paused-frame giant play button). Persists across V
      // opens (this IIFE wires once; handlers read live globals).
      window._vpOpenStepsPanel = function(secs0, startFrame0, numFrames0, autoPlay) {
        if (window._vpFSB) { try { window._vpFSB.cleanup(); } catch (_) {} window._vpFSB = null; }
        const f = buildFSB(null, null, { secs: secs0, startFrame: startFrame0,
                                         numFrames: numFrames0, autoPlay: !!autoPlay });
        window._vpFSB = f;
        try {
          const cr = content.getBoundingClientRect();
          const pw = f.el.offsetWidth || 180, ph = f.el.offsetHeight || 200;
          f.el.style.left = Math.max(4, cr.width  - pw - 8) + 'px';
          f.el.style.top  = Math.max(4, cr.height - 80 - ph - 8) + 'px';
        } catch (_) {}
        return f;
      };

      content.addEventListener('contextmenu', e => {
        // Only over an active video player; leave images/quiz/etc. alone.
        if (!_vpState || !_vpState.player) return;
        e.preventDefault(); e.stopPropagation();
        if (window._vpFSB) {
          removeFSB(true);                                       // right-click anywhere → dismiss + resume
          return;
        }
        window._vpFSB = buildFSB(e.clientX, e.clientY);          // open AT the cursor
        if (_vpIsPlaying()) _vpPauseNow();                       // pause so stepping shows
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
    // (dev0262) touch-action:none — without this the rotated portrait page
    // treats a visual horizontal drag as a physical vertical gesture and the
    // browser fires pointercancel before our scrub handler can run.
    timeline.style.cssText = 'flex:1;height:16px;background:#113;border:1px solid #06f;border-radius:3px;position:relative;cursor:pointer;touch-action:none;';
    
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
      } else if (row._directVideoFile || /\.(mp4|mov|webm|ogg|avi|mkv|m4v)(\?|#|$)/i.test(row.link)) {
        // (dev0285) `_directVideoFile` = slideshow disk video (blob: URL, no ext).
        vpMountDirectVideo(host, row.link, seg, muted);
      } else if (window.isInstagramLink && window.isInstagramLink(row.link)) {
        vpMountInstagram(host, row.link);
      } else if (window.isTikTokLink && window.isTikTokLink(row.link)) {
        vpMountTikTok(host, row.link);
      }
    }, 50);
    
    // Wire up controls
    vpWireControls();
    
  } else if ((row.ftext && !row.link) || row.qfile) {
    // (dev0530) ftext must NEVER win over a media link: a row that carries
    // BOTH ftext and an image/video link should show the MEDIA, not the text.
    // The video branch above already claimed real video rows (isVideoRow), and
    // the image branch below claims any remaining `row.link`; so ftext only
    // renders when there is no link at all. (qfile quizzes have no link.)
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
    // (dev0350) The srcdoc HTML grabs keyboard focus, so a top-level Esc never
    // reaches vpKeyHandler and Xs (the slide an X-cell swipe opens from G) felt
    // stuck. Forward Esc from inside the same-origin iframe to vpClose so Escape
    // returns to G (or wherever V opened from), matching video/image fullscreen.
    iframe.addEventListener('load', function () {
      try {
        var idoc = iframe.contentDocument;
        if (idoc) idoc.addEventListener('keydown', function (ev) {
          if (ev.key === 'Escape') { ev.preventDefault(); vpClose(); }
        }, true);
      } catch (_) {}
    });

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
        // (dev0249) Iframe gets its own document — global CSS from index.html
        // does NOT reach it. Inject the cross-context rules explicitly:
        //   • .te-cut → hidden (matches the AHK-style "/*" cut behavior)
        //   • <summary> + anchor children → a STRONG explicit color (not
        //     inherit) so a summary whose only child is an <a> stays
        //     readable even when the slide's .te-slide wrapper paints a
        //     dark background (inherit would pick up the body's default
        //     black, which is invisible on dark slides). Royal blue
        //     contrasts well on both light and dark backgrounds.
        const _ftStyles =
            'a{color:#5bf!important;}'
          + '.te-cut{display:none!important;}'
          + 'table{border-collapse:collapse;margin:12px 0;max-width:100%;}'
          + 'th,td{border:1px solid #999;padding:6px 10px;text-align:left;vertical-align:top;}'
          + 'th{font-weight:bold;}'
          // (dev0592) Working, consistent heading ladder (same em values as the
          // editor + Xs). This iframe has its OWN document; global index.html rules
          // don't reach it, so re-declare sizes + summary>heading inline.
          + 'h1{font-size:2em;}h2{font-size:1.5em;}h3{font-size:1.25em;}h4{font-size:1.1em;}h5{font-size:1em;}h6{font-size:0.9em;}'
          + 'h1,h2,h3,h4,h5,h6{font-weight:bold;margin:0 0 8px;}'
          + 'summary>h1,summary>h2,summary>h3,summary>h4,summary>h5,summary>h6{display:inline;}'
          // (dev0591) Details under a centered summary: shrink+center the block so
          // the body left-aligns under the ▼ arrow instead of running full width.
          + 'details:has(> summary[style*="center"]){width:fit-content;max-width:100%;margin:8px auto;text-align:left;}'
          + 'summary{color:#2563eb!important;background:transparent!important;font-weight:bold;}'
          + 'summary a,summary a:visited{color:#2563eb!important;text-decoration:underline;}';
        const _aStyle = '<style>' + _ftStyles + '</style>';
        // (dev0249) Body scaffold for fragment-style ftext: cap content at
        // ~880px and auto-center so desktop has reasonable side margins
        // (~25% of a 1920px screen) without forcing tight margins on mobile.
        const _bodyCss = 'body{font-family:Arial,sans-serif;line-height:1.5;'
          + 'max-width:880px;margin:0 auto;padding:24px;'
          + 'box-sizing:border-box;}';
        const html = ftLink.includes('<html')
          ? ftLink.replace(/<\/head>/i, _aStyle + '</head>')
          : '<!DOCTYPE html><html><head><meta charset="UTF-8">'
            + '<style>' + _bodyCss + _ftStyles + '</style></head>'
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
  // (dev0249) Locked-link mode: V was opened via ?i=NNN without /unlock.
  // Refuse to close — viewer can only see the one shared item; no path to
  // T/G/C.
  // (dev0315) Silently refuse. The old toast hinted "add /unlock to the
  // URL" — that's private dev info that gives away the unlock mechanism,
  // so it must not be shown to the public.
  if (window._lockedUid) {
    return;
  }
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

  // (dev0406) Tear down the floating step button + its live intervals.
  if (window._vpFSB && typeof window._vpFSB.cleanup === 'function') {
    try { window._vpFSB.cleanup(); } catch (_) {}
    window._vpFSB = null;
  }

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

  // (dev0281) If this V was driven by the slideshow, hand its final mute/speed/
  // A-B state back so the choices persist to the next video this session.
  if (_vpState && _vpState.slideshowNoLoop && typeof window._slideshowCaptureVp === 'function') {
    try { window._slideshowCaptureVp(_vpState); } catch (_) {}
  }

  // (dev0288) Tear down crop overlay listeners (ResizeObserver + document
  // pointermove/up) before dropping _vpState — otherwise they leak per V open.
  if (_vpState && _vpState.crop && typeof _vpState.crop.dispose === 'function') {
    try { _vpState.crop.dispose(); } catch (_) {}
  }

  _vpState = null;
  const fs = document.getElementById('gridFullscreen');
  fs.style.display = 'none';
  fs.onclick = null;
  // If V forced gridOverlay open from T (no real grid underneath), hide it
  // again so we land back on T instead of a blank dark overlay.
  if (window._vpForcedGridFromT) {
    const _gOvl = document.getElementById('gridOverlay');
    if (_gOvl) _gOvl.style.display = 'none';
    window._vpForcedGridFromT = false;
  }
  document.removeEventListener('keydown', vpKeyHandler, true);
  // Restore focus to main document so hotkeys work immediately
  document.body.setAttribute('tabindex', '-1');
  document.body.focus();
  // (dev0316) Return-to-menu hook. When V was launched from the user-
  // mode shareable menu ("I"), there's no real G underneath — vpClose's
  // _vpForcedGridFromT branch already hid the empty gridOverlay above.
  // Re-mount the menu so the viewer lands back on home instead of a
  // black screen. Direct /tshare links never set this flag (they run
  // in locked-mode and refuse to close).
  if (window._fromShareableMenu) {
    window._fromShareableMenu = false;
    if (typeof window._showShareableMenu === 'function') {
      setTimeout(() => window._showShareableMenu(), 50);
    }
  }
  // Note: we stay on grid (don't close it)
}

function vpKeyHandler(e) {
  if (document.getElementById('gridFullscreen').style.display !== 'flex') return;

  // (dev0344) Esc closes V / Ie back to T (re-enabled — was removed in zip0186).
  // vpClose() handles teardown and silently refuses in locked-share mode, so no
  // separate guard is needed here.
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopImmediatePropagation();
    vpClose();
    return;
  }

  // (zip0178) ArrowUp / ArrowDown — navigate filtered rows while in image
  // fullscreen (Iu / Ie).  Skipped when a video player is active (video
  // Left/Right frame-step is the relevant key there, and the video editor
  // handles its own ArrowUp/Down navigation separately).
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    if (_vpState && _vpState.player) {
      // (dev0286) During a slideshow video, ↑ / ↓ mark / un-mark the current
      // slide for deletion — same as image slides. The slideshow's own key
      // handler stands down while a video plays, so route it here. Standalone
      // V (no slideshowNoLoop) keeps ignoring vertical arrows.
      if (_vpState.slideshowNoLoop && typeof window._slideshowMarkCurrent === 'function') {
        e.preventDefault(); e.stopPropagation();
        window._slideshowMarkCurrent(e.key === 'ArrowUp');
      }
      return; // video — image-row nav doesn't apply
    }
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
  
  // (dev0286) Left / Right:
  //   • Playing slideshow video → close and move to prev / next slide
  //     (mirrors the L↔R swipe gesture).
  //   • Otherwise → step one frame (~1/30 s). If the video is playing, pause
  //     it first so the single-frame step is actually visible.
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    if (_vpState.slideshowNoLoop && _vpIsPlaying()) {
      if (window._slideshowVideoSwipe) window._slideshowVideoSwipe(dir);
      if (typeof vpClose === 'function') vpClose();
      return;
    }
    if (_vpIsPlaying()) _vpPauseNow();   // pause so the frame-step shows
    vpSeekRelative(dir / 30);
    return;
  }
  
  // M = mute toggle
  if (e.key === 'm' || e.key === 'M') {
    e.preventDefault();
    vpToggleMute();
    return;
  }

  // (dev0287) R = toggle disk-video info overlay (resolution+duration+filename).
  // No-op when no overlay exists (web videos, YouTube, Vimeo, images, quiz).
  if (e.key === 'r' || e.key === 'R') {
    const ov = _vpState && _vpState.diskInfoOverlay;
    if (!ov) return;
    e.preventDefault();
    ov.style.display = (ov.style.display === 'none') ? '' : 'none';
    return;
  }

  // (dev0288) C = toggle crop overlay. T = swap landscape↔portrait aspect
  // (only while overlay is visible). Both no-op when no crop state exists.
  if (e.key === 'c' || e.key === 'C') {
    if (!_vpState || !_vpState.crop) return;
    e.preventDefault(); e.stopPropagation();
    _vpCropToggle();
    return;
  }
  if (e.key === 't' || e.key === 'T') {
    if (!_vpState || !_vpState.crop) return;
    if (_vpState.crop.el.container.style.display === 'none') return;
    e.preventDefault(); e.stopPropagation();
    _vpCropSwapAspect();
    return;
  }

  // (dev0318) Z / X = rotate the crop frame −/+ 0.5° (straighten). Gated to a
  // visible crop overlay like T, so they pass through in any other context.
  if (e.key === 'z' || e.key === 'Z' || e.key === 'x' || e.key === 'X') {
    if (!_vpState || !_vpState.crop) return;
    if (_vpState.crop.el.container.style.display === 'none') return;
    e.preventDefault(); e.stopPropagation();
    const s = _vpState.crop;
    if (s.setAngle) s.setAngle(s.angle + ((e.key === 'z' || e.key === 'Z') ? -0.5 : 0.5));
    return;
  }

  // (dev0293 / dev0296) ASDF — symmetric 1-frame nudges. ONLY active when
  // BOTH A and B are set; otherwise these keys pass through untouched so
  // they stay free for other features outside the crop/trim context.
  //   a → A -1/30s (≈ 1 frame earlier)
  //   s → A +1/30s (≈ 1 frame later)
  //   d → B -1/30s (≈ 1 frame earlier)
  //   f → B +1/30s (≈ 1 frame later)
  // Clamped to [0, duration]. For 1-second jumps, use the existing per-0.1s
  // toolbar buttons or Ctrl+click on the timeline.
  if (e.key === 'a' || e.key === 's' || e.key === 'd' || e.key === 'f' ||
      e.key === 'A' || e.key === 'S' || e.key === 'D' || e.key === 'F') {
    if (!_vpState || _vpState.aPoint == null || _vpState.bPoint == null) return;
    const dur = _vpState.duration || 0;
    const FRAME = 1 / 30;
    const k = e.key.toLowerCase();
    if      (k === 'a') _vpState.aPoint = Math.max(0,   _vpState.aPoint - FRAME);
    else if (k === 's') _vpState.aPoint = Math.min(dur, _vpState.aPoint + FRAME);
    else if (k === 'd') _vpState.bPoint = Math.max(0,   _vpState.bPoint - FRAME);
    else                _vpState.bPoint = Math.min(dur, _vpState.bPoint + FRAME);
    e.preventDefault(); e.stopPropagation();
    vpUpdateABStyle();
    return;
  }

  // (dev0293) G — Go: save the A→B segment of the current disk video.
  // No crop overlay visible → lossless stream copy. Crop overlay visible →
  // crop+scale re-encode (current crop path). Prompts for an ID; filename
  // template `Base~id~YYYYMMDD-HHMMSS~{full | size~aspect~crop}~.mp4`.
  // No-op (passes through) when AB not set OR not a disk video.
  if (e.key === 'g' || e.key === 'G') {
    if (!_vpState || _vpState.aPoint == null || _vpState.bPoint == null) return;
    const row = window._vpCurrentRow;
    if (!row || !row._directVideoFile) return;
    e.preventDefault(); e.stopPropagation();
    _vpGoSave();
    return;
  }
}

// (dev0286) Synchronous play-state probe. Both player shapes expose a sync
// getPlayerState() (YT native; the direct-video wrapper at vpMountDirectVideo).
// State 1 = playing for both. Used by the keyboard handler to decide between
// frame-step (paused) and slide-navigate (playing slideshow video).
function _vpIsPlaying() {
  if (!_vpState || !_vpState.player) return false;
  try { return _vpState.player.getPlayerState() === 1; } catch (_) { return false; }
}

function _vpPauseNow() {
  if (!_vpState || !_vpState.player) return;
  const p = _vpState.player;
  try { if (_vpState.isYT) p.pauseVideo(); else p.pause(); } catch (_) {}
  vpUpdatePlayBtn();
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

// (dev0416) G "Play steps" — YouTube path. Opens this row in V and plays at
// NORMAL speed starting LEAD_IN seconds before the saved start frame `s`, with
// NO floating step control visible. When playback reaches `s`, it drops the fsc
// seeded with the saved x/s/d and auto-runs the forward loop — exactly as if the
// user had right-clicked V to open the fsc, only with the saved values. (Vimeo
// and direct-link cells step in place via gridPlaySteps; YT can't, because a
// paused in-cell YT iframe shows YouTube's own centre play button.) row.steps is
// "x,s,d". Silent no-op if it doesn't parse. Routed here by _gridPlayStepsRoute.
function _vpPlayStepsInV(row) {
  if (!row || !row.steps) return;
  const parts = String(row.steps).split(',');
  const x = parseFloat(parts[0]), s = parseInt(parts[1], 10), d = parseInt(parts[2], 10);
  if (!isFinite(x) || !isFinite(s) || !isFinite(d) || d < 0 || x < 0) return;  // (dev0555) d=0 / x=0 = saved freeze-frame
  const FRAME = 1 / 30;
  const LEAD_IN = 5;                              // seconds of normal-speed run-up to `s` (floored at video start)
  const sT = s * FRAME, leadInT = Math.max(0, sT - LEAD_IN);
  try { gridOpenFullscreen(row); } catch (_) { return; }

  // Wait for the player to be live (YT/Vimeo set _vpState.player on their ready
  // callback; disk sets it synchronously but needs metadata to seek).
  let tries = 0;
  (function whenReady() {
    const p = _vpState && _vpState.player;
    const ready = p && (!p.el || (p.el.readyState >= 1 && isFinite(p.el.duration)));
    if (!ready) { if (tries++ > 80) return; setTimeout(whenReady, 100); return; }

    // Non-YT fallback (shouldn't arrive here via the router): open the fsc at once.
    if (!_vpState.isYT) {
      if (typeof window._vpOpenStepsPanel === 'function') window._vpOpenStepsPanel(x, s, d, true);
      return;
    }

    // YT lead-in: normal-speed playback from LEAD_IN secs before `s`, no fsc yet.
    try { if (typeof p.setPlaybackRate === 'function') p.setPlaybackRate(1); } catch (_) {}
    try { p.seekTo(leadInT, true); } catch (_) {}
    try { p.playVideo(); } catch (_) {}

    // Poll playback; at `s`, hand off to the fsc (auto forward loop from `s`).
    let handed = false, ticks = 0;
    const poll = setInterval(function() {
      if (!_vpState || _vpState.player !== p) { clearInterval(poll); return; }  // V closed / changed
      let ct = NaN;
      try { ct = p.getCurrentTime(); } catch (_) {}
      if (typeof ct !== 'number' || !isFinite(ct)) ct = (_vpState.currentTime || 0);
      if (!handed && (ct >= sT || ticks++ > 300)) {        // reached s (or ~18s safety)
        handed = true; clearInterval(poll);
        if (typeof window._vpOpenStepsPanel === 'function')
          window._vpOpenStepsPanel(x, s, d, true);
      }
    }, 60);
  })();
}
window._vpPlayStepsInV = _vpPlayStepsInV;

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
  _vpState.markersToken = null;            // force marker redraw for new layout
  const btn = document.getElementById('vp-toggle');
  if (_vpState.isSelected) {
    btn.innerHTML = '● Selected<br><span style="font-size:9px;color:#666;">Full</span>';
  } else {
    btn.innerHTML = '<span style="font-size:9px;color:#666;">Selected</span><br>● Full';
  }
  vpRestartInMode();
}

function vpRestartInMode() {
  if (!_vpState || !_vpState.player) return;
  const p = _vpState.player;
  if (_vpState.isSelected && _vpState.segs && _vpState.segs.length) {
    // (dev0258) Selected mode now walks ALL segments from beginning to end
    // (vpUpdateTimeline advances segIdx on each seg's end and loops back to
    // 0 after the last). Restart at seg 0 so a fresh toggle replays the
    // full selection sequence rather than restarting whichever seg was last.
    _vpState.segIdx = 0;
    const seg = _vpState.segs[0];
    if (_vpState.isYT) p.seekTo(seg.start, true);
    else p.setCurrentTime(seg.start);
  }
  // Full mode: no snap — keep playing wherever the user is; they can click
  // anywhere on the timeline to seek.
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
  // (dev0292) Vertical line markers on the timeline at A and B positions.
  // Lazily created — added inside #vp-timeline above the playhead (z:4) so
  // they stay visible no matter what's painted underneath. Sync duration
  // is available for direct/disk videos via player.el; for YT/Vimeo, fall
  // back to hiding the markers (AB still works, just no line).
  _vpUpdateABLines();
}

function _vpUpdateABLines() {
  const tl = document.getElementById('vp-timeline');
  if (!tl) return;
  let dur = 0;
  const p = _vpState && _vpState.player;
  if (p && p.el && Number.isFinite(p.el.duration)) dur = p.el.duration;
  function ensureLine(id, color) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.style.cssText = 'position:absolute;top:-3px;bottom:-3px;width:2px;background:' +
        color + ';pointer-events:none;z-index:4;box-shadow:0 0 3px ' + color + ';';
      tl.appendChild(el);
    }
    return el;
  }
  const aEl = ensureLine('vp-ab-line-a', '#0f0');
  const bEl = ensureLine('vp-ab-line-b', '#f44');
  function place(el, point) {
    if (point == null || dur <= 0) { el.style.display = 'none'; return; }
    const pct = Math.max(0, Math.min(100, (point / dur) * 100));
    el.style.left = 'calc(' + pct + '% - 1px)';
    el.style.display = '';
  }
  place(aEl, _vpState.aPoint);
  place(bEl, _vpState.bPoint);
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
  
  // Timeline scrubbing — click + drag in both modes.
  // (dev0258) Selected mode: pct → position in concatenated selections →
  //   seek into the corresponding segment. segIdx updates so seg-walk
  //   resumes from the new spot.
  // Full mode: pct → position in full video time. segIdx is irrelevant.
  const timeline = document.getElementById('vp-timeline');
  let _vpScrubActive = false;
  // (dev0262) Wrap-local rect: in portrait phone mode the page is CSS-rotated
  // 90° CW inside #rotateWrap. getBoundingClientRect() returns physical screen
  // coords (timeline appears vertical), but pointer math wants wrap-local space
  // (timeline appears horizontal). Transform the rect's corners through the
  // same rotateXY mapping used for the event.
  const _vpWrapLocalRect = (el) => {
    const r = el.getBoundingClientRect();
    if (!window._salRotated) return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    const vw = window.innerWidth;
    // 90°CW: physical (cx,cy) → wrap-local (cy, vw-cx)
    const p1x = r.top,    p1y = vw - r.left;
    const p2x = r.bottom, p2y = vw - r.right;
    const left = Math.min(p1x, p2x), right  = Math.max(p1x, p2x);
    const top  = Math.min(p1y, p2y), bottom = Math.max(p1y, p2y);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  };
  const _vpScrubTo = (e) => {
    if (!_vpState || !_vpState.duration) return;
    const p = (typeof window.rotateXY === 'function')
      ? window.rotateXY(e)
      : { x: e.clientX, y: e.clientY };
    const rect = _vpWrapLocalRect(timeline);
    const pct  = Math.max(0, Math.min(1, (p.x - rect.left) / rect.width));
    if (_vpState.isSelected && _vpState.segs && _vpState.segs.length) {
      const total = _vpSelectedTotal();
      const pos   = pct * total;
      const segs  = _vpState.segs;
      let cumul = 0;
      for (let i = 0; i < segs.length; i++) {
        if (pos < cumul + segs[i].dur || i === segs.length - 1) {
          _vpState.segIdx = i;
          const t = segs[i].start + Math.max(0, Math.min(segs[i].dur - 0.05, pos - cumul));
          if (_vpState.isYT) _vpState.player.seekTo(t, true);
          else _vpState.player.setCurrentTime(t);
          return;
        }
        cumul += segs[i].dur;
      }
    } else {
      const t = pct * _vpState.duration;
      if (_vpState.isYT) _vpState.player.seekTo(t, true);
      else _vpState.player.setCurrentTime(t);
    }
  };
  timeline.addEventListener('pointerdown', e => {
    // (dev0293) Ctrl+click on timeline sets A/B alternating: first Ctrl-click
    // sets A, second sets B, third resets both and starts a new pair. Plain
    // click still scrubs. Computes time from click position (not playhead).
    if (e.ctrlKey && _vpState && _vpState.duration) {
      e.preventDefault(); e.stopPropagation();
      const p = (typeof window.rotateXY === 'function')
        ? window.rotateXY(e) : { x: e.clientX, y: e.clientY };
      const r = _vpWrapLocalRect(timeline);
      const pct = Math.max(0, Math.min(1, (p.x - r.left) / r.width));
      const t = pct * _vpState.duration;
      if (_vpState.aPoint == null) {
        _vpState.aPoint = t;
      } else if (_vpState.bPoint == null) {
        _vpState.bPoint = t;
      } else {
        // Both set — start a new pair.
        _vpState.aPoint = t;
        _vpState.bPoint = null;
      }
      vpUpdateABStyle();
      return;
    }
    _vpScrubActive = true;
    try { timeline.setPointerCapture(e.pointerId); } catch (_) {}
    _vpScrubTo(e);
  });
  timeline.addEventListener('pointermove', e => {
    if (_vpScrubActive) _vpScrubTo(e);
  });
  const _endScrub = e => {
    _vpScrubActive = false;
    try { timeline.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  timeline.addEventListener('pointerup', _endScrub);
  timeline.addEventListener('pointercancel', _endScrub);
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

// (dev0258) Selected-mode helpers — the timeline in Selected mode represents
// the concatenated selected dur, not the full video. Position within that
// virtual timeline = (cumulative dur of finished segs) + (ct - currentSeg.start).
function _vpSelectedTotal() {
  return (_vpState && _vpState.segs)
    ? _vpState.segs.reduce((a, s) => a + s.dur, 0) : 0;
}
function _vpSelectedPos(ct) {
  const segs = _vpState.segs;
  let cumul = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (ct >= s.start - 0.05 && ct <= s.start + s.dur + 0.05) {
      return cumul + Math.max(0, ct - s.start);
    }
    cumul += s.dur;
  }
  return null; // ct lies in unselected territory
}

function vpUpdateTimeline() {
  if (!_vpState || !_vpState.player) return;

  const updateUI = (ct, dur) => {
    _vpState.currentTime = ct;
    _vpState.duration = dur;
    if (!(dur > 0)) { vpUpdatePlayBtn(); return; }

    // (dev0263) Cap open-ended segments — when a row has no VidRange,
    // segs default to [{start:0, dur:99999}] (see line ~382). Without
    // capping:
    //   • Selected-mode loop never fires (ct never reaches 99998.95),
    //     so single-segment videos play once and stop;
    //   • Timeline scrub computes pct * sum(seg.dur) ≈ pct * 99999,
    //     so a click halfway through tries to seek to 50000 s — the
    //     player clamps to end and looks frozen.
    // Cap once dur is known. seg.dur is mutable so we just lower it
    // in place; the markers redraw via _vpState.markersToken when the
    // (dur.toFixed(1) + segs.length) key changes on first knowledge.
    if (_vpState.segs && _vpState.segs.length) {
      _vpState.segs.forEach(s => {
        if (s.start + s.dur > dur + 0.5) {
          s.dur = Math.max(1, dur - s.start);
        }
      });
    }

    const progress = document.getElementById('vp-progress');
    const playhead = document.getElementById('vp-playhead');
    const markers  = document.getElementById('vp-markers');

    const isSel   = _vpState.isSelected;
    const hasSegs = _vpState.segs && _vpState.segs.length > 0;

    // ── Progress %: Selected = position within concatenated selections;
    //               Full     = position within full video.
    let pct;
    if (isSel && hasSegs) {
      const total = _vpSelectedTotal();
      const pos   = _vpSelectedPos(ct);
      pct = (pos !== null && total > 0) ? (pos / total) * 100 : 0;
    } else {
      pct = (ct / dur) * 100;
    }
    pct = Math.max(0, Math.min(100, pct));
    progress.style.width = pct + '%';
    playhead.style.left  = 'calc(' + pct + '% - 1px)';

    // ── Markers: redraw whenever mode/seg-count/duration changes ──
    const renderToken = (isSel ? 'sel:' : 'full:') + dur.toFixed(1)
      + ':' + (hasSegs ? _vpState.segs.length : 0);
    if (_vpState.markersToken !== renderToken) {
      _vpState.markersToken = renderToken;
      markers.innerHTML = '';
      // (dev0258) Per-segment color palette — matches video.js (E timeline)
      // so a given segment looks the same in V and E.
      const VP_COLOURS = ['#2a6ef5','#e5732a','#2aa87a','#c03ec0','#c0c03e','#e53a3a'];
      const _labelFor = (seg, i) => seg.comment || ('Seg ' + (i + 1));
      const _bandTextCss = 'display:flex;align-items:center;justify-content:center;'
        + 'font-size:10px;color:#fff;font-weight:bold;line-height:1;'
        + 'white-space:nowrap;text-overflow:ellipsis;padding:0 3px;'
        + 'text-shadow:0 1px 1px rgba(0,0,0,0.6);';
      if (hasSegs && isSel) {
        // Concatenated layout — segments laid out contiguously, each in
        // its own color so the divisions are obvious. Label shown on each.
        const total = _vpSelectedTotal();
        let cumul = 0;
        _vpState.segs.forEach((seg, i) => {
          const startPct = (cumul / total) * 100;
          const widthPct = (seg.dur / total) * 100;
          const colour   = VP_COLOURS[i % VP_COLOURS.length];
          const m = document.createElement('div');
          m.style.cssText = 'position:absolute;top:2px;bottom:2px;'
            + 'left:' + startPct + '%;width:' + widthPct + '%;'
            + 'background:' + colour + ';opacity:0.85;overflow:hidden;'
            + (i < _vpState.segs.length - 1 ? 'border-right:2px solid #fff;' : '')
            + _bandTextCss;
          m.textContent = _labelFor(seg, i);
          m.title = 'Seg ' + (i+1) + (seg.comment ? ' — ' + seg.comment : '')
            + ': ' + seg.start.toFixed(1) + 's - '
            + (seg.start + seg.dur).toFixed(1) + 's';
          markers.appendChild(m);
          cumul += seg.dur;
        });
      } else if (hasSegs) {
        // Full layout — segments at their actual video-time positions,
        // overlaid on the full-video timeline. Same color scheme + labels.
        _vpState.segs.forEach((seg, i) => {
          const startPct = (seg.start / dur) * 100;
          const widthPct = (seg.dur / dur) * 100;
          const colour   = VP_COLOURS[i % VP_COLOURS.length];
          const m = document.createElement('div');
          m.style.cssText = 'position:absolute;top:2px;bottom:2px;'
            + 'left:' + startPct + '%;width:' + widthPct + '%;'
            + 'background:' + colour + ';opacity:0.85;'
            + 'border-radius:2px;border:1px solid #fff;overflow:hidden;'
            + _bandTextCss;
          m.textContent = _labelFor(seg, i);
          m.title = 'Seg ' + (i+1) + (seg.comment ? ' — ' + seg.comment : '')
            + ': ' + seg.start.toFixed(1) + 's - '
            + (seg.start + seg.dur).toFixed(1) + 's';
          markers.appendChild(m);
        });
      }
    }

    // ── A-B looping overrides segment walk ──
    // (dev0263) Follow seek with play(): if ct reached bPoint right at
    // real-video end, YT/direct may already be in ENDED state and a
    // bare seek alone won't resume.
    // (dev0410) Pause this background A-B auto-loop while the manual step panel
    // is open so the two don't fight over seeks. The fsb itself is independent
    // of A-B; this is only a "don't fight the open panel" guard.
    if (!window._vpFSB && _vpState.aPoint !== null && _vpState.bPoint !== null
        && _vpState.bPoint > _vpState.aPoint) {
      if (ct >= _vpState.bPoint) {
        if (_vpState.isYT) {
          _vpState.player.seekTo(_vpState.aPoint, true);
          if (_vpState.player.playVideo) _vpState.player.playVideo();
        } else {
          _vpState.player.setCurrentTime(_vpState.aPoint);
          if (_vpState.player.play) _vpState.player.play();
        }
      }
    }
    // ── Selected mode: walk through all segments, loop to first after last ──
    // (dev0410) Likewise paused while the manual step panel is open so the
    // segment walk doesn't fight its seeks.
    else if (!window._vpFSB && isSel && hasSegs) {
      const seg = _vpState.segs[_vpState.segIdx];
      if (ct >= seg.start + seg.dur - 0.05) {
        // (dev0280) Slideshow: when the LAST segment finishes, don't loop —
        // close V so the slideshow advances to the next slide.
        if (_vpState.slideshowNoLoop && _vpState.segIdx >= _vpState.segs.length - 1) {
          if (typeof vpClose === 'function') vpClose();
          return;
        }
        const nextIdx = (_vpState.segIdx + 1) % _vpState.segs.length;
        _vpState.segIdx = nextIdx;
        const next = _vpState.segs[nextIdx];
        // (dev0263) See A-B note — play() after seek so the loop
        // restarts even when the segment ran to the very end of the
        // underlying video and the player has parked in ENDED.
        if (_vpState.isYT) {
          _vpState.player.seekTo(next.start, true);
          if (_vpState.player.playVideo) _vpState.player.playVideo();
        } else {
          _vpState.player.setCurrentTime(next.start);
          if (_vpState.player.play) _vpState.player.play();
        }
      } else if (ct < seg.start - 0.5) {
        // ct landed before this seg's window (e.g. after a Full-mode seek
        // followed by toggle back to Selected) — snap forward into seg.
        if (_vpState.isYT) _vpState.player.seekTo(seg.start, true);
        else _vpState.player.setCurrentTime(seg.start);
      }
    }
    // ── Full mode: no auto-seek; user drives playback freely ──

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

// (dev0287) Format a duration in seconds as H:MM:SS or M:SS.
function _vpFmtDur(s) {
  if (!isFinite(s) || s < 0) return '–:––';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  if (h > 0) return h + ':' + m.toString().padStart(2, '0') + ':' + sec;
  return m + ':' + sec;
}

// (dev0287) Disk-video info overlay — resolution + duration + filename.
// Mounted only when the current row was synthesized from a disk file
// (row._directVideoFile === true, set by slideshow.js). Hotkey R toggles.
// Default ON: this V doubles as a management view for local files, so the
// metadata is the point. Hidden cleanly on next vpClose (host is wiped).
function _vpMountDiskInfoOverlay(host, vid, row) {
  if (!row || !row._directVideoFile) return;
  // (dev0303) Slideshow's review mode owns its own bottom filename + resolution
  // overlay (much bigger fonts) — suppress V's upper-left disk-info overlay
  // when called from there so the two don't compete.
  if (_vpState && _vpState.suppressDiskInfoOverlay) return;
  const ov = document.createElement('div');
  ov.id = 'vp-disk-info';
  ov.style.cssText =
    'position:absolute;top:8px;left:8px;z-index:50;pointer-events:none;' +
    'background:rgba(0,0,0,0.55);color:#dfe6f0;padding:6px 9px;border-radius:4px;' +
    'font:12px/1.35 ui-monospace,Consolas,monospace;white-space:pre;' +
    'max-width:60%;overflow:hidden;text-overflow:ellipsis;';
  host.appendChild(ov);
  const fname = row.VidTitle || (row.comment || '').split(/[\\/]/).pop() || '(unnamed)';
  const render = () => {
    const w = vid.videoWidth, h = vid.videoHeight;
    const res = (w && h) ? (w + '×' + h) : '…';
    const dur = _vpFmtDur(vid.duration);
    ov.textContent = fname + '\n' + res + '   ' + dur;
  };
  render();
  vid.addEventListener('loadedmetadata', render);
  vid.addEventListener('durationchange', render);
  if (_vpState) _vpState.diskInfoOverlay = ov;
}

// (dev0288) ── CROP OVERLAY (disk videos only) ─────────────────────────────
// Lets the user draw an aspect-locked rectangle over a playing disk video
// and click "Crop" to slice that region with ffmpeg → <name>_crop.<ext>
// in the original file's directory. Aspect: 16:9 (L) or 9:16 (P), swapped
// with T while overlay is up. C toggles the overlay. Default: centered,
// 30% of frame, landscape.
//
// Coord systems:
//   screen  — pointerevent client coords inside the host
//   render  — the visible video rect inside host (after object-fit:contain
//             letterboxing). screen→render = subtract letterbox offset
//   frac    — render coords divided by render size; range [0,1]. The rect's
//             persisted form — survives host resize and orientation flips
//   source  — frac × videoWidth/videoHeight, snapped to even pixels because
//             libx264 requires even dimensions. This is what ffmpeg eats.

function _vpCropRenderRect(host, vid) {
  const HW = host.clientWidth, HH = host.clientHeight;
  const VW = vid.videoWidth || 16, VH = vid.videoHeight || 9;
  const scale = Math.min(HW / VW, HH / VH);
  const rw = VW * scale, rh = VH * scale;
  const rx = (HW - rw) / 2, ry = (HH - rh) / 2;
  return { rx, ry, rw, rh, VW, VH };
}

// Default-size rect (30% of frame) at given aspect, centered. fracRatio is
// frac_w / frac_h — depends on the video's aspect, since the locked ratio
// is 16:9 (or 9:16) in SOURCE pixels, not screen pixels.
function _vpCropFracForAspect(aspect, vid) {
  const VW = vid.videoWidth || 16, VH = vid.videoHeight || 9;
  const srcAR = aspect === 'L' ? 16 / 9 : 9 / 16;
  const fracRatio = srcAR * (VH / VW);
  let fw, fh;
  if (fracRatio >= 1) { fw = 0.3; fh = fw / fracRatio; }
  else                { fh = 0.3; fw = fh * fracRatio; }
  if (fw > 1) { fh /= fw; fw = 1; }
  if (fh > 1) { fw /= fh; fh = 1; }
  return { x: (1 - fw) / 2, y: (1 - fh) / 2, w: fw, h: fh, ratio: fracRatio };
}

// (dev0318) True when the tilted crop rect has any corner outside the source
// frame → ffmpeg black-fills that wedge on save. Drives the amber dim-label.
// Corners = center ± half-extents rotated by the screen tilt (CW for +angle).
function _vpCropTiltOOB(state, VW, VH) {
  if (!state.angle) return false;
  const cx = (state.frac.x + state.frac.w / 2) * VW;
  const cy = (state.frac.y + state.frac.h / 2) * VH;
  const hw = state.frac.w * VW / 2, hh = state.frac.h * VH / 2;
  const t = state.angle * Math.PI / 180, ct = Math.cos(t), st = Math.sin(t);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const dx = sx * hw, dy = sy * hh;
    const x = cx + dx * ct - dy * st;
    const y = cy + dx * st + dy * ct;
    if (x < 0 || x > VW || y < 0 || y > VH) return true;
  }
  return false;
}

function _vpMountCropOverlay(host, vid, row) {
  if (!row || !row._directVideoFile) return;

  // Container — pointer-events:none so the native <video controls> at the
  // bottom stay clickable in any area NOT covered by the rect or its bar.
  const c = document.createElement('div');
  c.id = 'vp-crop-overlay';
  c.style.cssText = 'position:absolute;inset:0;z-index:55;pointer-events:none;display:none;';
  host.appendChild(c);

  const rect = document.createElement('div');
  rect.style.cssText =
    'position:absolute;box-sizing:border-box;border:2px solid #6af;' +
    'box-shadow:0 0 0 9999px rgba(0,0,0,0.35);pointer-events:auto;cursor:move;';
  c.appendChild(rect);

  // (dev0293) Source-pixel W×H label inside the rect. Always visible so
  // user can see exact crop dims at rest as well as during drag/resize.
  const dimLbl = document.createElement('div');
  dimLbl.style.cssText =
    'position:absolute;top:4px;left:50%;transform:translateX(-50%);' +
    'background:rgba(0,0,0,0.6);color:#dfe6f0;padding:1px 6px;border-radius:3px;' +
    'font:11px ui-monospace,Consolas,monospace;pointer-events:none;white-space:nowrap;';
  rect.appendChild(dimLbl);

  // Header bar above the rect: aspect toggle + CRF slider + Crop + close.
  const bar = document.createElement('div');
  // (dev0320) Hugs the top of the crop window (left/top set in paint), flipping
  // to just inside the top edge when the window nears the host top. Kept a
  // container child (not the rect) so it stays LEVEL while the rect tilts.
  bar.style.cssText =
    'position:absolute;transform:translateX(-50%);height:30px;' +
    'display:flex;align-items:center;gap:8px;padding:0 8px;max-width:96%;white-space:nowrap;' +
    'background:rgba(0,0,0,0.7);color:#dfe6f0;font:12px ui-monospace,Consolas,monospace;' +
    'border-radius:4px;pointer-events:auto;z-index:2;';
  bar.innerHTML =
    '<span id="vp-crop-aspect" style="cursor:pointer;user-select:none;padding:2px 6px;background:#234;border-radius:3px;">16:9</span>' +
    '<span style="opacity:0.7;">CRF</span>' +
    '<input id="vp-crop-crf" type="range" min="0" max="28" value="18" style="width:90px;vertical-align:middle;">' +
    '<span id="vp-crop-crf-val" style="min-width:18px;text-align:right;">18</span>' +
    '<select id="vp-crop-res" style="background:#1a1a2e;color:#dfe6f0;border:1px solid #456;border-radius:3px;padding:2px 4px;font:12px ui-monospace,Consolas,monospace;">' +
      '<option value="1080">1080p</option>' +
      '<option value="720">720p</option>' +
      '<option value="source">Same</option>' +
    '</select>' +
    '<span id="vp-crop-rot" title="Drag ↕ to straighten · wheel ±0.1° · double-click reset" ' +
      'style="cursor:ns-resize;user-select:none;padding:2px 6px;background:#234;border-radius:3px;">⟲ 0.0°</span>' +
    '<label style="display:flex;align-items:center;gap:3px;cursor:pointer;user-select:none;opacity:0.85;">' +
      '<input id="vp-crop-slow" type="checkbox" style="margin:0;vertical-align:middle;">Slow</label>' +
    '<button id="vp-crop-do" style="margin-left:auto;background:#2a5d9a;border:1px solid #6af;color:#fff;' +
      'padding:3px 10px;border-radius:3px;cursor:pointer;font:12px ui-monospace,Consolas,monospace;min-width:80px;">Crop</button>' +
    '<button id="vp-crop-close" style="background:#1a1a2e;border:1px solid #888;color:#ccc;' +
      'padding:3px 8px;border-radius:3px;cursor:pointer;font:12px ui-monospace,Consolas,monospace;">✕</button>';
  c.appendChild(bar);   // (dev0318) bar lives on the container, not the (tiltable) rect

  const handles = {};
  const HSZ = 14;
  ['nw','ne','sw','se'].forEach(pos => {
    const h = document.createElement('div');
    h.style.cssText =
      'position:absolute;width:' + HSZ + 'px;height:' + HSZ + 'px;' +
      'background:#6af;border:1px solid #fff;pointer-events:auto;' +
      'cursor:' + pos + '-resize;';
    if (pos.includes('n')) h.style.top    = (-HSZ/2) + 'px';
    if (pos.includes('s')) h.style.bottom = (-HSZ/2) + 'px';
    if (pos.includes('w')) h.style.left   = (-HSZ/2) + 'px';
    if (pos.includes('e')) h.style.right  = (-HSZ/2) + 'px';
    rect.appendChild(h);
    handles[pos] = h;
  });

  // (dev0318) Rule-of-thirds grid (child of rect → rotates with it). Hidden at
  // rest; faded in during any drag/rotate to help eyeball a level horizon.
  const grid = document.createElement('div');
  grid.style.cssText = 'position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .2s;';
  grid.innerHTML =
    '<div style="position:absolute;top:0;bottom:0;left:33.33%;width:1px;background:rgba(255,255,255,0.5);"></div>' +
    '<div style="position:absolute;top:0;bottom:0;left:66.66%;width:1px;background:rgba(255,255,255,0.5);"></div>' +
    '<div style="position:absolute;left:0;right:0;top:33.33%;height:1px;background:rgba(255,255,255,0.5);"></div>' +
    '<div style="position:absolute;left:0;right:0;top:66.66%;height:1px;background:rgba(255,255,255,0.5);"></div>';
  rect.appendChild(grid);

  // (dev0320) Rotate knob on a stem off the RIGHT edge, vertically centered.
  // Child of rect so it tracks the tilt; drag it up/down (an arc about the rect
  // center) to tilt that side, double-click resets. Right-side placement leaves
  // the top edge free for the control bar.
  const stem = document.createElement('div');
  stem.style.cssText = 'position:absolute;right:-20px;top:50%;width:20px;height:2px;margin-top:-1px;background:#6af;pointer-events:none;';
  rect.appendChild(stem);
  const knob = document.createElement('div');
  knob.title = 'Drag up/down to straighten · double-click to reset';
  knob.style.cssText =
    'position:absolute;right:-32px;top:50%;width:16px;height:16px;margin-top:-8px;' +
    'background:#6af;border:2px solid #fff;border-radius:50%;cursor:grab;' +
    'pointer-events:auto;box-shadow:0 1px 3px rgba(0,0,0,0.6);';
  rect.appendChild(knob);

  const state = {
    aspect: 'L', crf: 18, slow: false, resHeight: 1080, angle: 0,
    frac: _vpCropFracForAspect('L', vid),
    el: { container: c, rect, bar, handles, knob, grid }
  };

  // (dev0318) Rotation helpers. Declared before paint() (which calls
  // updateAngleUI) and before the drag handlers below. setAngle is the single
  // entry point (knob, toolbar grip, wheel, Z/X) — clamps, snaps a 0° detent,
  // quantizes to 0.1°, repaints.
  const rotGrip = bar.querySelector('#vp-crop-rot');
  let _gridTimer = null;
  function showGrid() { if (_gridTimer) { clearTimeout(_gridTimer); _gridTimer = null; } grid.style.opacity = '0.55'; }
  function hideGridSoon() { if (_gridTimer) clearTimeout(_gridTimer); _gridTimer = setTimeout(function () { grid.style.opacity = '0'; _gridTimer = null; }, 600); }
  function updateAngleUI() { if (rotGrip) rotGrip.textContent = '⟲ ' + state.angle.toFixed(1) + '°'; }
  function setAngle(deg) {
    let a = Math.max(-15, Math.min(15, deg));
    if (Math.abs(a) < 0.25) a = 0;          // detent at level
    state.angle = Math.round(a * 10) / 10;  // 0.1° resolution
    paint();
  }

  function paint() {
    const r = _vpCropRenderRect(host, vid);
    const rl = r.rx + state.frac.x * r.rw;
    const rt = r.ry + state.frac.y * r.rh;
    const rw = state.frac.w * r.rw;
    rect.style.left   = rl + 'px';
    rect.style.top    = rt + 'px';
    rect.style.width  = rw + 'px';
    rect.style.height = (state.frac.h * r.rh) + 'px';
    // (dev0318) Tilt the rect; its mask, handles, knob and grid rotate with it.
    rect.style.transform = state.angle ? ('rotate(' + state.angle + 'deg)') : '';
    // (dev0320) Control bar hugs the top of the crop window, centered on it, and
    // flips to just inside the top edge when the window nears the host top. It's
    // a container child so it stays LEVEL under tilt; clamp horizontally so the
    // Crop button can't run off-screen.
    const bwHalf = (bar.offsetWidth || 0) / 2;
    const bx = Math.max(bwHalf + 4, Math.min(host.clientWidth - bwHalf - 4, rl + rw / 2));
    bar.style.left = bx + 'px';
    bar.style.top  = (rt < 40 ? (rt + 4) : (rt - 34)) + 'px';
    // (dev0293/dev0318) W×H label in source px (what ffmpeg crops) plus the tilt
    // angle. Counter-rotate so the text stays upright; turn amber when a tilted
    // corner leaves the source frame (ffmpeg will black-fill that wedge on save).
    if (r.VW > 0 && r.VH > 0) {
      const even = n => Math.max(2, Math.floor(n / 2) * 2);
      const sw = even(state.frac.w * r.VW);
      const sh = even(state.frac.h * r.VH);
      dimLbl.textContent = sw + ' × ' + sh + (state.angle ? ('  ·  ' + state.angle.toFixed(1) + '°') : '');
      dimLbl.style.transform = 'translateX(-50%) rotate(' + (-state.angle) + 'deg)';
      dimLbl.style.color = (state.angle && _vpCropTiltOOB(state, r.VW, r.VH)) ? '#fb3' : '#dfe6f0';
    }
    updateAngleUI();
  }
  const ensureMeta = () => { state.frac = _vpCropFracForAspect(state.aspect, vid); paint(); };
  if (vid.videoWidth) ensureMeta();
  else vid.addEventListener('loadedmetadata', ensureMeta, { once: true });

  const ro = new ResizeObserver(paint);
  ro.observe(host);

  // ── Drag-to-move (rect body) and corner resize (handles) ────────────────
  let drag = null;
  rect.addEventListener('pointerdown', e => {
    if (e.target !== rect) return;
    e.preventDefault(); e.stopPropagation();
    drag = { kind: 'move', sx: e.clientX, sy: e.clientY,
             ox: state.frac.x, oy: state.frac.y, r: _vpCropRenderRect(host, vid) };
    rect.setPointerCapture(e.pointerId);
  });
  Object.entries(handles).forEach(([pos, h]) => {
    h.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      drag = { kind: 'resize', pos, sx: e.clientX, sy: e.clientY,
               of: { ...state.frac }, r: _vpCropRenderRect(host, vid) };
      h.setPointerCapture(e.pointerId);
    });
  });
  function onMove(e) {
    if (!drag) return;
    showGrid();   // (dev0318) thirds grid visible while moving/resizing
    const dxF = (e.clientX - drag.sx) / drag.r.rw;
    const dyF = (e.clientY - drag.sy) / drag.r.rh;
    if (drag.kind === 'move') {
      let nx = drag.ox + dxF, ny = drag.oy + dyF;
      nx = Math.max(0, Math.min(1 - state.frac.w, nx));
      ny = Math.max(0, Math.min(1 - state.frac.h, ny));
      state.frac.x = nx; state.frac.y = ny;
      paint();
    } else if (drag.kind === 'resize') {
      const of = drag.of, ratio = state.frac.ratio;
      let ax, ay, px, py;
      if (drag.pos === 'se') { ax = of.x;      ay = of.y;      px = of.x+of.w+dxF; py = of.y+of.h+dyF; }
      if (drag.pos === 'sw') { ax = of.x+of.w; ay = of.y;      px = of.x       +dxF; py = of.y+of.h+dyF; }
      if (drag.pos === 'ne') { ax = of.x;      ay = of.y+of.h; px = of.x+of.w+dxF; py = of.y       +dyF; }
      if (drag.pos === 'nw') { ax = of.x+of.w; ay = of.y+of.h; px = of.x       +dxF; py = of.y       +dyF; }
      const adx = Math.abs(px - ax), ady = Math.abs(py - ay);
      // Aspect lock: pick whichever axis wants the rect larger, derive the other.
      let nw, nh;
      if (adx >= ady * ratio) { nw = adx; nh = nw / ratio; }
      else                    { nh = ady; nw = nh * ratio; }
      nw = Math.max(0.05, nw); nh = Math.max(0.05, nh);
      let nx = (px >= ax) ? ax : ax - nw;
      let ny = (py >= ay) ? ay : ay - nh;
      if (nx < 0)        { nw += nx; nh = nw / ratio; nx = 0; }
      if (ny < 0)        { nh += ny; nw = nh * ratio; ny = 0; }
      if (nx + nw > 1)   { nw = 1 - nx; nh = nw / ratio; }
      if (ny + nh > 1)   { nh = 1 - ny; nw = nh * ratio; }
      state.frac.x = nx; state.frac.y = ny; state.frac.w = nw; state.frac.h = nh;
      paint();
    }
  }
  function onUp(e) {
    if (drag) {
      try { (drag.kind === 'move' ? rect : handles[drag.pos]).releasePointerCapture(e.pointerId); } catch (_) {}
      hideGridSoon();
    }
    drag = null;
  }
  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('pointerup',   onUp,   true);

  // ── Bar controls ────────────────────────────────────────────────────────
  bar.querySelector('#vp-crop-aspect').addEventListener('click', _vpCropSwapAspect);
  const crfSlider = bar.querySelector('#vp-crop-crf');
  const crfVal    = bar.querySelector('#vp-crop-crf-val');
  crfSlider.addEventListener('input', () => {
    state.crf = +crfSlider.value;
    crfVal.textContent = state.crf;
  });
  const slowBox = bar.querySelector('#vp-crop-slow');
  slowBox.addEventListener('change', () => { state.slow = !!slowBox.checked; });
  const resSel = bar.querySelector('#vp-crop-res');
  resSel.value = String(state.resHeight); // default 1080p
  resSel.addEventListener('change', () => {
    const v = resSel.value;
    state.resHeight = (v === 'source') ? 'source' : (+v || 1080);
  });

  // (dev0318) ── Rotation controls ───────────────────────────────────────────
  // Knob: arc-drag about the rect center (getBoundingClientRect's box center
  // equals the true center even when rotated, since we rotate about center).
  let rotDrag = null;
  knob.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    const b = rect.getBoundingClientRect();
    const ctr = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    const startPtr = Math.atan2(e.clientY - ctr.y, e.clientX - ctr.x) * 180 / Math.PI;
    rotDrag = { ctr, startPtr, startAngle: state.angle };
    try { knob.setPointerCapture(e.pointerId); } catch (_) {}
    knob.style.cursor = 'grabbing';
    showGrid();
  });
  knob.addEventListener('pointermove', e => {
    if (!rotDrag) return;
    const cur = Math.atan2(e.clientY - rotDrag.ctr.y, e.clientX - rotDrag.ctr.x) * 180 / Math.PI;
    let d = cur - rotDrag.startPtr;
    while (d > 180) d -= 360; while (d < -180) d += 360;
    setAngle(rotDrag.startAngle + d);
    showGrid();
  });
  knob.addEventListener('pointerup', e => {
    if (!rotDrag) return;
    try { knob.releasePointerCapture(e.pointerId); } catch (_) {}
    rotDrag = null; knob.style.cursor = 'grab'; hideGridSoon();
  });
  knob.addEventListener('dblclick', e => { e.preventDefault(); e.stopPropagation(); setAngle(0); });

  // Toolbar grip: vertical drag (up = +), wheel ±0.1°, double-click reset.
  let gripDrag = null;
  if (rotGrip) {
    rotGrip.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      gripDrag = { startY: e.clientY, startAngle: state.angle };
      try { rotGrip.setPointerCapture(e.pointerId); } catch (_) {}
      showGrid();
    });
    rotGrip.addEventListener('pointermove', e => {
      if (!gripDrag) return;
      setAngle(gripDrag.startAngle + (gripDrag.startY - e.clientY) * 0.1);
      showGrid();
    });
    rotGrip.addEventListener('pointerup', e => {
      if (!gripDrag) return;
      try { rotGrip.releasePointerCapture(e.pointerId); } catch (_) {}
      gripDrag = null; hideGridSoon();
    });
    rotGrip.addEventListener('wheel', e => {
      e.preventDefault();
      setAngle(state.angle + (e.deltaY < 0 ? 0.1 : -0.1));
      showGrid(); hideGridSoon();
    }, { passive: false });
    rotGrip.addEventListener('dblclick', e => { e.preventDefault(); e.stopPropagation(); setAngle(0); });
  }

  // (dev0296) Crop button now mirrors the G hotkey — prompts for an ID and
  // uses the unified filename template. fromButton=true so missing AB shows
  // a toast instead of the silent no-op G uses (which would be mysterious
  // from a button click).
  bar.querySelector('#vp-crop-do').addEventListener('click',
    () => _vpGoSave({ fromButton: true }));
  bar.querySelector('#vp-crop-close').addEventListener('click', _vpCropToggle);

  // Disposal — called from vpClose to drop document listeners + ResizeObserver.
  state.dispose = () => {
    try { ro.disconnect(); } catch (_) {}
    if (_gridTimer) clearTimeout(_gridTimer);
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup',   onUp,   true);
  };
  // (dev0318) Exposed for the Z/X keyboard nudges and aspect-swap repaint.
  state.paint = paint;
  state.setAngle = setAngle;
  if (_vpState) _vpState.crop = state;
}

// (dev0288) Toggle crop overlay visibility (C hotkey + ✕ button).
//
// (dev0292) While the overlay is open, neutralize the video's swipe/zoom/pan
// layer (#vp-swipe-catcher) and clear any host transform. Both are needed:
//
//   • swipeCatcher (z:50, sibling of host) would otherwise compete for clicks
//     with the crop rect/handles (z:55, children of host). For most cases the
//     rect wins on stacking order — but the moment host.style.transform is
//     non-empty (even an identity transform left over from a zoom reset),
//     host becomes its own stacking context and z:55 inside it is sandwiched
//     UNDER swipeCatcher z:50. Clicks then hit swipeCatcher; the cursor stays
//     "zoom-in" and the crop UI appears dead. Suppressing swipeCatcher while
//     crop is open removes the ambiguity entirely.
//
//   • Clearing host.style.transform unwinds any lingering stacking context
//     so things look normal again on close, and so multiple open/close
//     cycles don't accumulate state.
function _vpCropToggle() {
  if (!_vpState || !_vpState.crop) return;
  const s = _vpState.crop;
  const isOpening = (s.el.container.style.display === 'none');
  s.el.container.style.display = isOpening ? '' : 'none';
  const sc = document.getElementById('vp-swipe-catcher');
  const host = s.el.container.parentElement;
  if (isOpening) {
    if (sc) {
      s._savedSCPE = sc.style.pointerEvents;
      s._savedSCCursor = sc.style.cursor;
      sc.style.pointerEvents = 'none';
      sc.style.cursor = 'default';
    }
    if (host) host.style.transform = '';
    if (s.paint) s.paint();   // (dev0320) reposition bar now it's visible (offsetWidth valid)
  } else {
    if (sc) {
      sc.style.pointerEvents = s._savedSCPE || '';
      sc.style.cursor = s._savedSCCursor || '';
    }
  }
}

// (dev0288) Swap L↔P aspect, re-center on previous center, redraw.
function _vpCropSwapAspect() {
  if (!_vpState || !_vpState.crop) return;
  const s = _vpState.crop;
  const vid = _vpState.player && _vpState.player.el;
  if (!vid) return;
  s.aspect = (s.aspect === 'L') ? 'P' : 'L';
  const prevCx = s.frac.x + s.frac.w / 2;
  const prevCy = s.frac.y + s.frac.h / 2;
  s.frac = _vpCropFracForAspect(s.aspect, vid);
  let nx = prevCx - s.frac.w / 2, ny = prevCy - s.frac.h / 2;
  nx = Math.max(0, Math.min(1 - s.frac.w, nx));
  ny = Math.max(0, Math.min(1 - s.frac.h, ny));
  s.frac.x = nx; s.frac.y = ny;
  const label = s.el.bar.querySelector('#vp-crop-aspect');
  if (label) label.textContent = s.aspect === 'L' ? '16:9' : '9:16';
  // (dev0318) Angle is preserved across L↔P; repaint re-applies position + tilt.
  if (s.paint) s.paint();
}

// (dev0289) Crop button — wired to proxy.js /exec/ffmpeg. Computes the
// source-pixel rect + output path, POSTs it, and streams NDJSON progress
// back into the Crop button label ("45% · 1.2×"). Double-crop stacks the
// suffix (foo_crop_crop.mp4) per user preference — no strip.
//
// Overwrite policy: send overwrite:false; if ffmpeg refuses because the
// output exists (-n + "already exists" stderr), confirm() with the user
// and retry with overwrite:true. No file-exists pre-probe — one request
// path covers both new-file and re-crop.
const PROXY_BASE = 'http://127.0.0.1:8081';

// (dev0291) Resolve a slideshow-style folder-relative path
// (e.g. "MyVideos/sub/clip.mp4") to an absolute disk path.
//
// The File System Access API never hands web JS the absolute path of a
// picked folder (security feature). Slideshow stores `rootName + '/' +
// relPath` in row.comment, where rootName is the picker's display name —
// useful as a label, useless to ffmpeg. To bridge that gap we prompt the
// user once per root folder for its real disk location and cache it in
// localStorage. Subsequent crops from the same folder are silent.
//
// Returns null if the user cancels the prompt — caller aborts the crop.
function _vpCropResolveAbsPath(relPath) {
  if (!relPath) return null;
  // Already absolute (Windows drive letter or POSIX root) → pass through.
  if (/^[A-Za-z]:[\\/]/.test(relPath) || /^\//.test(relPath)) return relPath;
  const slashIdx = relPath.indexOf('/');
  const rootName = (slashIdx >= 0) ? relPath.slice(0, slashIdx) : relPath;
  const rest     = (slashIdx >= 0) ? relPath.slice(slashIdx + 1) : '';
  const key = 'vpDiskRoot:' + rootName;
  let absRoot = localStorage.getItem(key) || '';
  if (!absRoot) {
    absRoot = prompt(
      'Crop needs the absolute disk path of the folder "' + rootName + '"\n' +
      'you picked in the slideshow.\n\nExample: M:\\videos\\' + rootName,
      ''
    );
    if (!absRoot) return null;
    localStorage.setItem(key, absRoot);
  }
  const sep = absRoot.includes('\\') ? '\\' : '/';
  const restSep = rest.replace(/[\\/]/g, sep);
  const joiner  = /[\\/]$/.test(absRoot) ? '' : sep;
  return rest ? (absRoot + joiner + restSep) : absRoot;
}

// (dev0291) Match ffmpeg's "no such file" / ENOENT family on stderr. Used
// to detect the case where the user cached a wrong absRoot for a folder —
// we offer to clear the cache and re-prompt.
function _vpCropStderrSaysNotFound(lines) {
  return lines.some(l => /no such file|cannot find|enoent|failed to open/i.test(l));
}

// (dev0293) Local-time YYYYMMDD-HHMMSS for filename timestamps.
function _vpTimestamp(d) {
  d = d || new Date();
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
         '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

// (dev0295) Duration in seconds → "NNminNNsec" (e.g. 225 → "03min45sec").
// Minutes can exceed 99 for long clips (no hour rollover, by spec).
function _vpDurStr(sec) {
  const total = Math.max(0, Math.round(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return String(m).padStart(2, '0') + 'min' + String(s).padStart(2, '0') + 'sec';
}

// (dev0293) Split an absolute path into {dir, base, ext}. Handles both
// Windows and POSIX separators. Returns null if it doesn't look like a
// path with an extension.
function _vpSplitPath(p) {
  const m = p.match(/^(.*)([\\/])([^\\/]+)\.([^.\\/]+)$/);
  if (!m) return null;
  return { dir: m[1], sep: m[2], base: m[3], ext: m[4] };
}

// (dev0293) A floating progress pill at the top of the V fullscreen.
// Used by G save (no crop) where there's no Crop button to label with %.
function _vpMakeProgressPill(prefix) {
  const fs = document.getElementById('gridFullscreen');
  if (!fs) return null;
  const pill = document.createElement('div');
  pill.id = 'vp-progress-pill';
  pill.style.cssText =
    'position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:60;' +
    'background:#2a5d9a;color:#fff;border:1px solid #6af;padding:4px 12px;border-radius:4px;' +
    'font:13px ui-monospace,Consolas,monospace;box-shadow:0 2px 8px rgba(0,0,0,0.6);';
  pill.textContent = (prefix || '') + '...';
  fs.appendChild(pill);
  // Setter writes to textContent prefixed with the action label.
  return {
    get textContent() { return pill.textContent; },
    set textContent(v) { pill.textContent = (prefix || '') + v; },
    dispose() { try { pill.remove(); } catch (_) {} }
  };
}

// (dev0293) G hotkey handler — save the A→B segment of the current disk
// video. Crop overlay visible → crop+scale re-encode. Hidden/absent →
// lossless stream copy (-c copy).
//
// (dev0296) Also wired to the Crop button (was _vpCropDoCrop). Both paths
// now prompt for an ID and use the same filename template. _vpCropDoCrop
// retired — its features (overwrite-confirm, not-found→clear-cache→retry,
// progress UI) all live here now.
//
// Filename template (no timestamp — order: base, id, size, aspect, kind, dur):
//   Base~id~SHORTp~L|P~full~NNminNNsec~.mp4    (lossless;    SHORTp from source)
//   Base~id~SIZE~L|P~crop~NNminNNsec~.mp4      (crop+scale;  SIZE from dropdown)
//
// opts.fromButton — when true (Crop-button click), missing AB shows a toast
// rather than silent return. Keeps the G hotkey's passthrough behavior so
// asdf/etc. stay free outside the AB context.
async function _vpGoSave(opts) {
  opts = opts || {};
  if (!_vpState || _vpState.aPoint == null || _vpState.bPoint == null) {
    if (opts.fromButton && typeof toast === 'function') toast('Set A and B first', 1800);
    return;
  }
  const row = window._vpCurrentRow;
  if (!row || !row._directVideoFile) {
    if (opts.fromButton && typeof toast === 'function') toast('Save only works for disk videos', 2200);
    return;
  }
  const relPath = row.comment || row.VidTitle || '';
  if (!relPath) {
    if (typeof toast === 'function') toast('save: no source file path on row', 2400);
    return;
  }
  const absInput = _vpCropResolveAbsPath(relPath);
  if (!absInput) {
    if (typeof toast === 'function') toast('save cancelled (need folder path)', 2200);
    return;
  }
  const parts = _vpSplitPath(absInput);
  if (!parts) {
    if (typeof toast === 'function') toast('save: cannot parse path', 2400);
    return;
  }
  const id = prompt('Save name/ID for this clip:', '');
  if (!id) { if (typeof toast === 'function') toast('save cancelled', 1600); return; }
  const safeId = id.replace(/[<>:"/\\|?*~]/g, '_').trim() || 'unnamed';
  // Crop overlay visible → crop+scale. Else → lossless trim.
  const cropOn = !!(_vpState.crop && _vpState.crop.el.container.style.display !== 'none');
  const startSec = Math.min(_vpState.aPoint, _vpState.bPoint);
  const endSec   = Math.max(_vpState.aPoint, _vpState.bPoint);
  const durStr = _vpDurStr(endSec - startSec);
  const vid = _vpState.player && _vpState.player.el;
  let outName, payload;
  if (cropOn) {
    const s = _vpState.crop;
    const VW = vid.videoWidth, VH = vid.videoHeight;
    const even = n => Math.max(2, Math.floor(n / 2) * 2);
    const sw = even(s.frac.w * VW), sh = even(s.frac.h * VH);
    // (dev0297) When the resolution dropdown is "Same" (no scale), the actual
    // output dims are the crop dims, so report THAT in the filename rather
    // than the literal word 'source' (which was uninformative).
    const sizeStr = (s.resHeight === 'source')
      ? (Math.min(sw, sh) + 'p')
      : (s.resHeight + 'p');
    // (dev0318) Crop position. No tilt → axis-aligned crop (unchanged path).
    // Tilt → rotate the whole frame by -angle onto an expanded D×D canvas so the
    // tilted rect becomes axis-aligned, then crop there. Geometry verified:
    // ffmpeg +rad = clockwise (matches CSS), so a = -angle; the crop center is
    // the source-px center remapped by R(a) about the frame center.
    const angle = s.angle || 0;
    let cropBox, rotate = null, angTok = '';
    if (!angle) {
      cropBox = { w: sw, h: sh, x: even(s.frac.x * VW), y: even(s.frac.y * VH) };
    } else {
      const a = -angle * Math.PI / 180;
      const D = even(Math.ceil(Math.hypot(VW, VH)));
      const cx = (s.frac.x + s.frac.w / 2) * VW, cy = (s.frac.y + s.frac.h / 2) * VH;
      const u = cx - VW / 2, v = cy - VH / 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const ccx = D / 2 + (ca * u - sa * v), ccy = D / 2 + (sa * u + ca * v);
      // Clamp into the canvas so a heavily off-frame tilt black-fills instead of
      // failing the proxy's bounds check (the amber label already warned).
      const cx0 = Math.max(0, Math.min(D - sw, even(Math.round(ccx - sw / 2))));
      const cy0 = Math.max(0, Math.min(D - sh, even(Math.round(ccy - sh / 2))));
      cropBox = { w: sw, h: sh, x: cx0, y: cy0 };
      rotate = { rad: a, ow: D, oh: D };
      angTok = 'r' + angle.toFixed(1).replace('.', '_') + 'deg';
    }
    const nameParts = [parts.base, safeId, sizeStr, s.aspect, 'crop'];
    if (angTok) nameParts.push(angTok);
    nameParts.push(durStr);
    outName = nameParts.join('~') + '~.mp4';
    payload = {
      input: absInput,
      output: parts.dir + parts.sep + outName,
      crop: cropBox,
      crf: s.crf,
      preset: s.slow ? 'slow' : 'medium',
      aspect: s.aspect, resHeight: s.resHeight,
      trim: { startSec, endSec },
      overwrite: false
    };
    if (rotate) payload.rotate = rotate;
  } else {
    // (dev0296) Source dims drive size+aspect for lossless filenames so the
    // resulting name still tells you the resolution at a glance.
    const VW = (vid && vid.videoWidth)  || 0;
    const VH = (vid && vid.videoHeight) || 0;
    const sourceShort = (VW && VH) ? Math.min(VW, VH) : 0;
    const sourceSizeStr = sourceShort ? (sourceShort + 'p') : 'source';
    const sourceAspect  = (VW && VH) ? ((VW >= VH) ? 'L' : 'P') : 'L';
    outName = [parts.base, safeId, sourceSizeStr, sourceAspect, 'full', durStr].join('~') + '~.mp4';
    payload = {
      input: absInput,
      output: parts.dir + parts.sep + outName,
      trim: { startSec, endSec },
      overwrite: false
      // No `crop` → builder takes the lossless -c copy path.
    };
  }
  // (dev0319) Deskew preflight — a stale proxy silently ignores payload.rotate
  // and applies the rotated-canvas crop coords to the raw frame (grabs the wrong
  // region, no deskew). Refuse loudly instead of writing a mis-cropped file.
  if (payload.rotate && !(await _vpProxySupportsRotate())) {
    if (typeof toast === 'function') toast('Deskew needs an updated proxy — restart "node proxy.js" and retry', 4000);
    return;
  }
  const totalMs = Math.max(0, (endSec - startSec) * 1000);
  const useBtn = cropOn ? _vpState.crop.el.bar.querySelector('#vp-crop-do') : null;
  const origLabel = useBtn ? useBtn.textContent : null;
  const pill = useBtn ? null : _vpMakeProgressPill(cropOn ? '' : 'Saving ');
  const target = useBtn || pill;
  function restoreUI() {
    if (useBtn) { useBtn.disabled = false; useBtn.textContent = origLabel; }
    if (pill) pill.dispose();
  }
  try {
    let result = await _vpCropRun(payload, target, totalMs);
    if (result.exitCode !== 0 && _vpCropStderrSaysExists(result.stderr)) {
      restoreUI();
      if (confirm('"' + outName + '" already exists. Overwrite?')) {
        // Re-mount pill if we tore it down above (overwrite path re-runs).
        const pill2 = useBtn ? null : _vpMakeProgressPill('Saving ');
        const target2 = useBtn || pill2;
        payload.overwrite = true;
        result = await _vpCropRun(payload, target2, totalMs);
        if (pill2) pill2.dispose();
        if (useBtn) { useBtn.disabled = false; useBtn.textContent = origLabel; }
      } else {
        if (typeof toast === 'function') toast('save cancelled', 1600);
        return;
      }
    }
    // (dev0291 / dev0296) "no such file" usually means cached absRoot is wrong.
    // Offer to clear it so the next attempt re-prompts the user.
    if (result.exitCode !== 0 && _vpCropStderrSaysNotFound(result.stderr)) {
      restoreUI();
      const slashIdx = relPath.indexOf('/');
      const rootName = (slashIdx >= 0) ? relPath.slice(0, slashIdx) : relPath;
      if (confirm('ffmpeg could not find:\n  ' + absInput +
                  '\n\nClear cached disk path for folder "' + rootName + '" and retry?')) {
        localStorage.removeItem('vpDiskRoot:' + rootName);
        return _vpGoSave(opts);
      }
      if (typeof toast === 'function') toast('save failed: file not found', 2600);
      console.error('[save not found]', { exitCode: result.exitCode, payload,
        stderr: result.stderr, lastProgress: result.lastProgress });
      return;
    }
    restoreUI();
    if (result.exitCode === 0) {
      if (typeof toast === 'function') toast('saved → ' + outName, 3200);
    } else {
      const tail = result.stderr.slice(-1)[0] || ('exit ' + result.exitCode);
      if (typeof toast === 'function') toast('save failed: ' + tail, 4200);
      console.error('[save failed]', { exitCode: result.exitCode, payload,
        stderr: result.stderr, lastProgress: result.lastProgress });
    }
  } catch (err) {
    restoreUI();
    const msg = (err && err.message) || String(err);
    if (typeof toast === 'function') toast('save error: ' + msg, 3600);
    console.error('[save error]', err);
  }
}

// (dev0289) Match the ffmpeg "-n refused to overwrite" stderr line. ffmpeg's
// wording varies slightly across versions ("File '...' already exists. Exiting."
// or "Not overwriting - exiting"), so case-insensitive substring is robust.
function _vpCropStderrSaysExists(lines) {
  return lines.some(l => /already exists/i.test(l) || /not overwriting/i.test(l));
}

// (dev0319) Capability check — true only if the proxy advertises rotate support
// at GET /version. A stale proxy (pre-dev0318, or any without /version) returns
// false, letting the caller refuse a deskew job instead of mis-cropping silently.
async function _vpProxySupportsRotate() {
  try {
    const r = await fetch(PROXY_BASE + '/version', { method: 'GET' });
    if (!r.ok) return false;
    const j = await r.json();
    return !!(j && Array.isArray(j.features) && j.features.includes('rotate'));
  } catch (_) { return false; }
}

// (dev0289) One request/response cycle to /exec/ffmpeg. Resolves with
// {exitCode, stderr[], lastProgress}. Throws only on network/fetch error.
//
// (dev0293) `btn` is now duck-typed: may be a real <button>, a plain <div>,
// or any object with a writable `textContent`. The `disabled` property is
// set only if present — divs don't have it, so they're spared the noise.
async function _vpCropRun(payload, btn, totalMs) {
  const setLabel = s => { if (btn) btn.textContent = s; };
  const setDisabled = b => { if (btn && 'disabled' in btn) btn.disabled = b; };
  setDisabled(true);
  setLabel('0%');
  const res = await fetch(PROXY_BASE + '/exec/ffmpeg', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error('HTTP ' + res.status + (txt ? ': ' + txt.slice(0, 200) : ''));
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const stderr = [];
  let exitCode = -1;
  let lastProgress = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch (_) { continue; }
      if (ev.type === 'progress') {
        lastProgress = ev;
        const pct = (totalMs > 0 && ev.timeMs != null)
          ? Math.min(100, Math.max(0, Math.round(ev.timeMs / totalMs * 100)))
          : null;
        const spd = ev.speed ? (' · ' + ev.speed) : '';
        // (dev0294) Once we hit 100% but `done` hasn't arrived yet, ffmpeg
        // is doing its tail work (finalizing the container, writing moov
        // atom for mp4, flushing buffers). Label it so 100% + still-moving
        // speed doesn't look stuck.
        const label = (pct === 100) ? ('finalizing' + spd)
                                    : ((pct != null ? pct + '%' : '...') + spd);
        setLabel(label);
      } else if (ev.type === 'stderr') {
        stderr.push(ev.line);
      } else if (ev.type === 'done') {
        exitCode = (typeof ev.exitCode === 'number') ? ev.exitCode : -1;
        if (ev.error) stderr.push(ev.error);
      }
    }
  }
  return { exitCode, stderr, lastProgress };
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
  _vpMountDiskInfoOverlay(host, vid, window._vpCurrentRow);
  _vpMountCropOverlay(host, vid, window._vpCurrentRow);
  // (dev0253 / fix) Native <video controls> need pointer events on the
  // bottom strip of the video. Instead of disabling the swipeCatcher
  // entirely (which killed R→L swipe-close AND hold-zoom), shrink it so
  // it leaves the bottom ~56px clear for native controls while still
  // covering the rest of the video for gestures. The toolbar already
  // occupies the bottom 80px of #gridFullscreen; catcher was inset
  // 0 0 80px 0 — bump that to 0 0 136px 0 so native controls (which
  // float at host's bottom edge, i.e. just above the toolbar) get clicks.
  const catcher = document.getElementById('vp-swipe-catcher');
  if (catcher) catcher.style.inset = '0 0 136px 0';
  // (dev0253) Wrapper exposes BOTH Vimeo-shape (play/pause/setCurrentTime,
  // promise-returning) AND YT-shape (playVideo/seekTo, sync) methods. The
  // VP toolbar branches on `_vpState.isYT` — when false it calls the
  // Vimeo-style API, so direct video must answer those calls too.
  // Caption module hooks are no-ops; native <track> handles captions.
  _vpState.player = {
    isDirectVideo: true,
    el: vid,
    destroy: () => { vid.pause(); vid.src = ''; },
    // Vimeo-shape
    play:    () => vid.play().catch(() => {}),
    pause:   () => { vid.pause(); return Promise.resolve(); },
    getPaused:      () => Promise.resolve(vid.paused),
    getCurrentTime: () => Promise.resolve(vid.currentTime),
    getDuration:    () => Promise.resolve(vid.duration || 0),
    setCurrentTime: (t) => { vid.currentTime = t; return Promise.resolve(t); },
    setVolume: (v) => { vid.volume = v; if (v === 0) vid.muted = true; },
    // (dev0280) vpToggleMute() calls setMuted() on the non-YouTube path. The
    // direct-video wrapper was missing it, so the call threw (swallowed by the
    // caller's try/catch) and the Mute button silently did nothing.
    setMuted: (m) => { vid.muted = !!m; },
    loadModule: () => {}, unloadModule: () => {}, setOption: () => {},
    // YT-shape (kept for any code paths that branch on isYT)
    seekTo:         (t) => { vid.currentTime = t; },
    playVideo:      () => vid.play().catch(() => {}),
    stopVideo:      () => { vid.pause(); vid.currentTime = 0; },
    getPlayerState: () => (vid.paused ? 2 : 1),
    setPlaybackRate: (r) => { vid.playbackRate = r; },
    mute:   () => { vid.muted = true; },
    unMute: () => { vid.muted = false; },
    isMuted: () => Promise.resolve(vid.muted)
  };
  _vpState.isYT = false;
  // (dev0280) Slideshow plays each video once then advances. Native 'ended'
  // fires only when nothing is looping the clip (e.g. Full mode) — the
  // Selected-mode end is handled in vpUpdateTimeline. Gated on the slideshow
  // flag so standalone V playback is unaffected.
  vid.addEventListener('ended', () => {
    if (_vpState && _vpState.slideshowNoLoop && typeof vpClose === 'function') vpClose();
  });
  // (dev0281) Apply a carried-over playback speed (e.g. a slideshow session
  // pref set on a previous video) and reflect it in the speed control.
  if (_vpState.speed && _vpState.speed !== 1) {
    vid.playbackRate = _vpState.speed;
    const _sv  = document.getElementById('vp-speed');
    const _svv = document.getElementById('vp-speed-val');
    if (_sv)  _sv.value = _vpState.speed;
    if (_svv) _svv.textContent = _vpState.speed + 'x';
  }
  // (dev0281) Reflect carried-over A-B points in the toolbar styling.
  if ((_vpState.aPoint != null || _vpState.bPoint != null) && typeof vpUpdateABStyle === 'function') {
    try { vpUpdateABStyle(); } catch (_) {}
  }
  _vpState.interval = setInterval(vpUpdateTimeline, 250);
}

function vpMountYouTube(host, link, seg, muted) {
  const vidId = window.getYouTubeId ? window.getYouTubeId(link) : link.match(/(?:v=|\/embed\/|\/shorts\/|\/live\/|youtu\.be\/)([A-Za-z0-9_-]{11})/)?.[1];
  if (!vidId) return;
  
  host.innerHTML = '';
  const iframe = document.createElement('div');
  iframe.id = 'vp-yt-player';
  // (dev0335) Shield YT's hover/title overlay — V drives playback through its own
  // toolbar (vp-play, scrub timeline, A/B), never through the iframe itself.
  iframe.style.pointerEvents = 'none';
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
              ifr.style.pointerEvents = 'none';   // (dev0335) re-stamp on the live iframe
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
  // Unlisted-video hash (form `vimeo.com/ID/HASH`) — required for player API
  const vidHash = link.match(/vimeo\.com\/\d+\/([A-Za-z0-9]+)/)?.[1];
  const playerUrl = vidHash
    ? `https://vimeo.com/${vidId}?h=${vidHash}`
    : `https://vimeo.com/${vidId}`;
  
  host.innerHTML = '';
  
  // (zip0149) Same iframe-allow treatment as the YT mount above.
  // Vimeo's SDK creates its iframe inside `host` so the observer
  // will catch it.
  vpAllowAutoplayOnIframe(host);
  
  const loadPlayer = () => {
    const player = new Vimeo.Player(host, {
      url: playerUrl,
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

// Instagram mount — sandboxed IG embed in a portrait clipping box centered in
// the host. The clip wrapper hides IG's header (handle/avatar strip) and
// footer (caption + "View on Instagram" link) by sizing the iframe taller
// than the visible box and offsetting it upward; only the central poster /
// video region remains visible. The center play caret IG paints on reel
// posters cannot be removed (it's inside the cross-origin iframe).
//
// Replaces the toolbar's inert seek-bar row with an "Open on Instagram"
// gradient button — none of the playback controls work for IG (no JS API),
// but Prev/Next/Close in the bottom row remain functional.
function vpMountInstagram(host, link) {
  host.innerHTML = '';
  var m = String(link || '').match(/instagram\.com\/(reels?|p)\/([A-Za-z0-9_-]+)/i);
  if (!m) return;
  var kind = m[1].toLowerCase() === 'p' ? 'p' : 'reel';
  var src = 'https://www.instagram.com/' + kind + '/' + m[2] + '/embed/';

  // Clip chrome via an overflow:hidden box that's shorter than the iframe.
  // Iframe is sized W×(W*2.5) and offset top:-(W*0.16) so the header sits
  // above the visible region and the footer sits below it. Numbers tuned
  // for IG's reel embed layout at common widths (~400-440 wide).
  var wrap = document.createElement('div');
  wrap.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;'
    + 'justify-content:center;background:#000;';
  var clipBox = document.createElement('div');
  // Sized for desktop viewing of vertical reels (≈3:5 portrait). The caps
  // collapse to 95vw / 95% on phones so the embed still fits.
  clipBox.style.cssText = 'position:relative;width:min(634px,95vw);'
    + 'height:min(893px,95%);overflow:hidden;background:#000;';
  var iframe = document.createElement('iframe');
  iframe.src = src;
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('scrolling', 'no');
  iframe.setAttribute('allowtransparency', 'true');
  iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; web-share');
  iframe.setAttribute('allowfullscreen', '');
  iframe.style.cssText = 'position:absolute;left:0;right:0;width:100%;'
    + 'height:calc(100% + 200px);top:-60px;border:0;background:#000;';
  clipBox.appendChild(iframe);
  wrap.appendChild(clipBox);
  host.appendChild(wrap);

  // (dev0602) IG's player lives inside the cross-origin iframe, so the ONLY way
  // to start it is a real click landing on IG's own play button. #vp-swipe-
  // catcher (z:50) covers the whole host and ate that click — the exact failure
  // dev0292 hit with the crop UI: cursor stays "zoom-in" and the embed looks
  // dead. Direct video shrinks the catcher (bottom 136px) because it only needs
  // the native control strip; IG needs the CENTRE, so shrinking can't help —
  // neutralize the catcher entirely for IG rows. Cost: no swipe-close / hold-
  // zoom / pinch here, which is cheap because none of it worked on this embed
  // anyway (zoom scales a fixed-size cross-origin iframe; a tap can't play it).
  // Both escape routes survive: Esc, and the toolbar's Close — the toolbar is
  // the bottom 80px, outside host/catcher, so touch keeps a way out.
  // The catcher is rebuilt on every V open, so there's nothing to restore.
  var _sc = document.getElementById('vp-swipe-catcher');
  if (_sc) {
    _sc.style.pointerEvents = 'none';
    _sc.style.cursor = 'default';
  }

  // Replace the seek-bar (timelineRow — first child of #vp-toolbar) with an
  // "Open on Instagram" gradient button. The bar's playback markers / scrub
  // are useless without a JS API; reusing that real estate keeps the visible
  // chrome consistent. Prev/Play/Next/Close stay in the row below.
  var toolbar = document.getElementById('vp-toolbar');
  if (toolbar && toolbar.firstElementChild) {
    var tlRow = toolbar.firstElementChild;
    tlRow.style.display = 'none';
    var openBtn = document.createElement('button');
    openBtn.id = 'vp-ig-open';
    openBtn.textContent = '↗ Open on Instagram';
    openBtn.style.cssText = 'display:block;width:100%;height:24px;margin:0 0 4px 0;'
      + 'background:linear-gradient(135deg,#833ab4 0%,#fd1d1d 50%,#fcb045 100%);'
      + 'color:#fff;border:0;border-radius:4px;font-family:monospace;font-weight:bold;'
      + 'font-size:12px;letter-spacing:0.04em;cursor:pointer;'
      + 'text-shadow:0 1px 2px rgba(0,0,0,0.4);';
    openBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      window.open(link, '_blank', 'noopener');
    });
    toolbar.insertBefore(openBtn, tlRow);
  }

  // Stub player so generic toolbar code that pokes _vpState.player doesn't
  // throw. No interval — the timeline stays at zero.
  if (typeof _vpState === 'object' && _vpState) {
    _vpState.player = { isInstagram: true,
      pauseVideo: function(){}, playVideo: function(){},
      destroy: function(){ try { iframe.src = 'about:blank'; } catch(e) {} } };
    _vpState.isYT = false;
  }
}

// TikTok mount — official /player/v1/{id} iframe, 9:16 portrait, centered in a
// black host. Like Instagram it's a sandboxed cross-origin embed: no JS seek
// API, so the seek-bar row is replaced with an "Open on TikTok" button and the
// playback controls (Prev/Play/Next/Close in the row below) stay functional
// while the timeline scrub does not.
function vpMountTikTok(host, link) {
  host.innerHTML = '';
  var src = window.tiktokEmbedUrl ? window.tiktokEmbedUrl(link) : '';
  if (!src) return;

  var wrap = document.createElement('div');
  wrap.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;'
    + 'justify-content:center;background:#000;';
  var clipBox = document.createElement('div');
  // 9:16 portrait box, capped to fit desktop and phones alike.
  clipBox.style.cssText = 'position:relative;width:min(450px,95vw);'
    + 'height:min(800px,95%);aspect-ratio:9/16;overflow:hidden;background:#000;';
  var iframe = document.createElement('iframe');
  iframe.src = src;
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('scrolling', 'no');
  iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
  iframe.setAttribute('allowfullscreen', '');
  iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#000;';
  clipBox.appendChild(iframe);
  wrap.appendChild(clipBox);
  host.appendChild(wrap);

  // Replace the inert seek-bar with an "Open on TikTok" button (same pattern as
  // Instagram). Prev/Play/Next/Close in the row below stay functional.
  var toolbar = document.getElementById('vp-toolbar');
  if (toolbar && toolbar.firstElementChild) {
    var tlRow = toolbar.firstElementChild;
    tlRow.style.display = 'none';
    var openBtn = document.createElement('button');
    openBtn.id = 'vp-tt-open';
    openBtn.textContent = '↗ Open on TikTok';
    openBtn.style.cssText = 'display:block;width:100%;height:24px;margin:0 0 4px 0;'
      + 'background:linear-gradient(135deg,#25F4EE 0%,#000 50%,#FE2C55 100%);'
      + 'color:#fff;border:0;border-radius:4px;font-family:monospace;font-weight:bold;'
      + 'font-size:12px;letter-spacing:0.04em;cursor:pointer;'
      + 'text-shadow:0 1px 2px rgba(0,0,0,0.6);';
    openBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      window.open(link, '_blank', 'noopener');
    });
    toolbar.insertBefore(openBtn, tlRow);
  }

  if (typeof _vpState === 'object' && _vpState) {
    _vpState.player = { isTikTok: true,
      pauseVideo: function(){}, playVideo: function(){},
      destroy: function(){ try { iframe.src = 'about:blank'; } catch(e) {} } };
    _vpState.isYT = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// GLOBAL HOTKEY HANDLER — MOVED (dev0542)
// window._executeHotkey and every per-key handler now live in hotkeys.js, the
// declarative hotkey registry (single source of truth — it also renders the H
// screen's Global panel live). This file keeps only the helpers those handlers
// call (vpClose, openIe, openEditorForRow, _ensureBrRows, …).
// ══════════════════════════════════════════════════════════════════════════════

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
  // (dev0503) A VIDEO row wins first — before the text test. yt-dlp import auto-fills
  // ftext (the caption) on YouTube/Vimeo videos, and IG video rows carry ltype 'w';
  // the old text-first test mistook BOTH for slides and opened Xe, which is why
  // E-screen down-arrow landed in the text editor instead of the next row's video.
  if (typeof isVideoRow === 'function' && isVideoRow(row)) {
    _cameFromGrid = false;
    if (window.openVideoEditor) window.openVideoEditor(row);
    return;
  }
  // A row is "text" via an explicit marker (VidRange/ltype) or ftext WITHOUT a media
  // link. Requiring !link (mirrors gridShow) keeps captioned image rows out of Xe.
  const isText = row.VidRange === 'text' || row.ltype === 'w'
              || (typeof row.ftext === 'string' && row.ftext.length > 0 && !row.link);
  if (isText) {
    if (typeof gridOpenTextEditor === 'function')
      gridOpenTextEditor(row.cell || '', row);
    return;
  }
  if (row.link) {
    openIe(row);
    return;
  }
  if (typeof toast === 'function') toast('No editor available for this row type', 1500);
}
window.openEditorForRow = openEditorForRow;
