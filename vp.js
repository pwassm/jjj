
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


// (dev0741) Keep the video host's bottom inset equal to the toolbar's REAL
// height. It used to be the literal `inset:0 0 80px 0` — the toolbar's fixed 70
// plus a 10px breather — which stopped being true the moment the bar was allowed
// to grow: a wrapped control row on a narrow phone, or the extra "↗ Open on …"
// row the Instagram / TikTok / Pinterest mounts insert into it.
//
// A ResizeObserver rather than a one-shot measure, because most of the causes
// land AFTER this runs: those mounts fire on a 50ms timeout, wrapping changes on
// an orientation flip, and the rotated wrap's width itself moves whenever the
// phone's URL bar hides or returns. Falls back to a couple of delayed measures
// where ResizeObserver is missing. The observer dies with the element.
function _vpSyncToolbarHeight(host, toolbar) {
  if (!host || !toolbar) return;
  const apply = () => {
    if (!host.isConnected || !toolbar.isConnected) return;
    const h = toolbar.offsetHeight || 70;
    host.style.bottom = (h + 10) + 'px';
  };
  apply();
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(apply);
    ro.observe(toolbar);
    // vpClose blows away content.innerHTML; disconnect then so the observer
    // isn't left holding a detached node for the rest of the session.
    if (_vpState) _vpState.toolbarRO = ro;
  } else {
    setTimeout(apply, 120);
    setTimeout(apply, 400);
  }
}

function gridOpenFullscreen(row, contained) {
  // (dev0709) V gets the speakers to itself. The grid is still mounted behind
  // this overlay, and a cross-origin IG embed on it keeps playing (and talking)
  // there is no way to mute — grid.js stops them the only way the wall allows,
  // by swapping in fresh iframes. They come back primed, so nothing is lost.
  if (typeof window._gridStopEmbedAudio === 'function') window._gridStopEmbedAudio();

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
  // (dev0636) Drop a leftover "G page" transparency (see the sectioned text
  // branch) so the next open — possibly a different row — gets its normal
  // opaque backdrop back. NB: #gridFullscreen's #000 ships as an INLINE style
  // (index.html), so restore the value — '' would strip it for good.
  fs.style.background = '#000';
  // (dev0637) Stale section-page arrows from a previous sectioned open — every
  // open starts clean; the sectioned branch re-adds them when it needs them.
  const _staleArr = fs.querySelector('#vpSectArrows');
  if (_staleArr) _staleArr.remove();
  info.innerHTML = '';
  info.style.cssText = '';
  _vpState = null;
  window._vpSectNav = null;   // (dev0617) reset section pager from a previous text open
  window._vpTextReader = false; // (dev0644) reset; the text branch re-sets it

  // (zip0178) Track current row so vpKeyHandler can navigate from Iu/Ie.
  window._vpCurrentRow = row;

  // (dev0667) USER LOOP arming. The menu's "My Loops" tab sets
  // window._vpPendingLoop = {uid, link, a, b, name} immediately before opening
  // V, because the loop's A→B lives in the viewer's own storage (loops.js) and
  // must never be written into the ml.json row. Read-and-CLEAR on EVERY open —
  // matching row or not — so an arming that misses can't leak into the next V.
  const _pendLoop = window._vpPendingLoop || null;
  window._vpPendingLoop = null;
  const _armLoop = (_pendLoop && window.salLoops
                    && window.salLoops.matchRow(_pendLoop, row)) ? _pendLoop : null;

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
      // (dev0667) A user loop opens in FULL mode: its A→B is in real video
      // time, and Selected mode's timeline maps to the concatenated VidRange
      // segments instead — the playhead would sit at 0 the whole way round.
      // (The A-B branch in vpUpdateTimeline already outranks the seg walk.)
      isSelected: !_armLoop, // Start in "Selected" mode (segment only)
      speed: 1.0,
      muted: row.Mute !== '0',
      ccOn: false,
      aPoint: _armLoop ? _armLoop.a : null,
      bPoint: _armLoop ? _armLoop.b : null,
      abSuspended: false,   // (dev0701) set by a manual scrub outside A→B

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
    // (dev0765) Latch for the zoom-stops-playback rule — see _vpZoomStopPlayback.
    // Every zoom and pan write goes through _vApply, so this is the one place
    // both gestures (desktop hold-LMB, phone pinch-out) can be caught at once.
    let _vZoomStopped = false;
    function _vApply() {
      host.style.transform = `translate(${_vTx}px,${_vTy}px) scale(${_vScale})`;
      swipeCatcher.style.cursor = _vScale > 1.05 ? 'grab' : 'zoom-in';
      if (_vScale > 1.05) {
        if (!_vZoomStopped) { _vZoomStopped = true; _vpZoomStopPlayback(); }
      } else _vZoomStopped = false;
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
            // (dev0703) One shared rule — see _vpHorizSwipe. Touch has no Shift,
            // so a phone gets plain ← = leave, plain → = next slide.
            if (horiz && _vpHorizSwipe(dx, e.shiftKey)) { _swipe = null; return; }
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
          // (dev0703) One shared rule — see _vpHorizSwipe. ⇧+drag pages the deck
          // / the show; a plain R→L drag leaves the page, as it does everywhere.
          if (horiz && _vpHorizSwipe(dx, e.shiftKey)) {
            mStart = null; mPanBase = null; _vApply(); return;
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

        // (dev0725) Close ✕, top right. Right-clicking anywhere already dismissed
        // the panel, but that is not something the panel says about itself —
        // and on a touchpad it isn't much of an offer either. Its own row rather
        // than an absolutely-placed corner, so it can never sit over Row 1.
        const r0 = mkRow();
        r0.style.justifyContent = 'flex-end';
        r0.style.margin = '-4px -2px -4px 0';
        const closeX = document.createElement('span');
        closeX.textContent = '✕';
        closeX.title = 'Close the step panel (right-click anywhere does it too)';
        closeX.style.cssText = 'cursor:pointer;color:#9ab;padding:0 3px;font:13px ui-monospace,Consolas,monospace;';
        closeX.onmouseenter = () => { closeX.style.color = '#fff'; };
        closeX.onmouseleave = () => { closeX.style.color = '#9ab'; };
        closeX.onclick = ev => { ev.stopPropagation(); removeFSB(false); };
        r0.append(closeX);

        panel.append(r0, r1, r2, r3, r4);
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
        // (dev0725) Inside a crop text box the right-click is about the TEXT, so
        // that case never reaches here: (dev0750) the box carries its own
        // contextmenu listener and stops the event there, which is what makes
        // the same menu work on a still, where there is no V around this at all.
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
    //
    // (dev0741) height:70px was a FIXED height, and the control row inside it a
    // single non-wrapping flex line. Measured, that line needs 725px: three
    // transport buttons + mute (80px) + the speed slider + Selected/Full + CC +
    // the seven-button A-B cluster + close. A phone's landscape frame is often
    // narrower than that — and its width MOVES, because in portrait the rotated
    // wrap's width is window.innerHeight, which grows and shrinks as the URL bar
    // hides and returns. So the same row would fit on one open and overflow on
    // the next, which is exactly the "some cells, not all" symptom: A-B sits
    // second from the right, so it is the first thing pushed off the edge.
    //
    // min-height, not height: the bar is anchored at bottom:0 and now grows
    // UPWARD as its rows wrap, so nothing it contains can leave the screen.
    // _vpSyncToolbarHeight (below) keeps the video host clear of it.
    const toolbar = document.createElement('div');
    toolbar.id = 'vp-toolbar';
    toolbar.style.cssText = 'position:absolute;bottom:0;left:0;right:0;min-height:70px;background:#000;border-top:2px solid #06f;display:flex;flex-direction:column;padding:4px 12px;box-sizing:border-box;';
    
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
    // (dev0741) Wraps. On a frame wide enough for all 725px this is the single
    // line it has always been; on a narrower one the A-B cluster drops to a
    // second line instead of running off the right edge. height→min-height so
    // the row can actually be two lines tall, and row-gap keeps them apart.
    const ctrlRow = document.createElement('div');
    ctrlRow.id = 'vp-ctrlrow';
    ctrlRow.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;'
      + 'gap:6px;row-gap:4px;min-height:36px;margin-top:4px;';
    
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
    // (dev0741) flex:0 0 auto — in a wrapping row a shrinkable group squeezes
    // to an unusable width rather than moving to the next line. Whole or moved.
    speedWrap.style.cssText = 'display:flex;align-items:center;gap:4px;flex:0 0 auto;';
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
    // (dev0667) Opened from a user loop → the state above starts in Full, so
    // the button must say so or the first click toggles the wrong way.
    if (_armLoop) toggleBtn.innerHTML = '<span style="font-size:9px;color:#666;">Selected</span><br>● Full';
    
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
    // (dev0741) flex:0 0 auto for the same reason as speedWrap — these seven are
    // the whole point of the bar on a phone and must never be shaved.
    const abWrap = document.createElement('div');
    abWrap.id = 'vp-abwrap';
    abWrap.style.cssText = 'display:flex;align-items:center;gap:2px;flex:0 0 auto;';
    
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
    // (dev0667) Now saves a user loop (loops.js → menu "My Loops"), not a field.
    abSaveBtn.title = 'Save A→B as a loop in My Loops (L)';
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

    // (dev0741) The host's bottom inset was the literal 80px that matched the
    // toolbar's old fixed 70. Now that the bar grows — a wrapped control row, or
    // the extra "↗ Open on Instagram / TikTok / Pinterest" row those three mounts
    // insert into it — the gap has to be measured rather than assumed, or a
    // two-line bar covers the bottom of the video. A ResizeObserver catches every
    // cause at once: wrap, orientation flip, URL bar, late-inserted rows.
    _vpSyncToolbarHeight(host, toolbar);

    // (zip0144) No info bar for video — video extends to the top edge.
    // The cell label / title was removed because it took meaningful
    // screen height on phones and added little value (the user knows
    // what they tapped). Image and quiz cases below still set their
    // info bars since they're useful there.
    info.style.cssText = 'display:none;';
    info.innerHTML = '';
    
    // Mount video
    setTimeout(() => {
      // (dev0667) A user loop mounts at its own A point (every mount path seeks
      // to seg.start), so the loop is already running on the first frame rather
      // than after one full lap from the row's first VidRange segment.
      const seg = _armLoop ? { start: _armLoop.a, dur: _armLoop.b - _armLoop.a } : segs[0];
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
      } else if (window.isPinterestLink && window.isPinterestLink(row.link)) {
        // (dev0693) Only HLS-only / unresolved pins get here — a resolved pin's
        // link is a .mp4 and the direct-video branch above already took it.
        vpMountPinterest(host, row.link);
      }
    }, 50);
    
    // Wire up controls
    vpWireControls();
    // (dev0667) Paint the armed loop onto the A/B buttons + timeline markers.
    // The YT and Vimeo mounts don't call this themselves (only the direct-video
    // one does), and either way it has to run after the buttons exist.
    if (_armLoop) {
      try { vpUpdateABStyle(); } catch (_) {}
      if (typeof toast === 'function') {
        toast('🔁 ' + _armLoop.name + '  ('
          + (window.salLoops ? window.salLoops.fmt(_armLoop.a) + ' → ' + window.salLoops.fmt(_armLoop.b)
                             : _armLoop.a.toFixed(1) + 's → ' + _armLoop.b.toFixed(1) + 's') + ')', 2400);
      }
    }

  } else if ((row.ftext && !row.link) || row.qfile) {
    // (dev0530) ftext must NEVER win over a media link: a row that carries
    // BOTH ftext and an image/video link should show the MEDIA, not the text.
    // The video branch above already claimed real video rows (isVideoRow), and
    // the image branch below claims any remaining `row.link`; so ftext only
    // renders when there is no link at all. (qfile quizzes have no link.)
    // (dev0644) Mark this open as the TEXT READER: ↓ closes it back to the
    // grid (vpKeyHandler), pairing with the grid's ↑ = expand-t-cell. The
    // designation-page re-entries re-arm this flag after gridOpenFullscreen
    // resets it, so ↓ returns to the grid from a media page too.
    window._vpTextReader = true;
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
    topBar.innerHTML = '<span id="vp-html-hint" style="font-family:monospace;font-size:13px;color:#cde;'
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
          // (dev0617) The srcdoc document owns keyboard focus once clicked, so
          // section paging must also be forwarded from inside the iframe.
          else if ((ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') && window._vpSectNav) {
            ev.preventDefault();
            window._vpSectNav(ev.key === 'ArrowRight' ? 1 : -1);
          }
        }, true);
        // (dev0643) Swipe left / right inside the reader pages sections too —
        // swipe left = next, swipe right = previous. A small drag (a tap on the
        // triangle or a link) stays under the threshold, so those still work.
        if (idoc && window._vpSectNav) {
          let _ss = null;
          idoc.addEventListener('pointerdown', function (ev) {
            _ss = { x: ev.clientX, y: ev.clientY, t: Date.now() };
          }, true);
          idoc.addEventListener('pointerup', function (ev) {
            if (!_ss) return;
            var dx = ev.clientX - _ss.x, dy = ev.clientY - _ss.y, ms = Date.now() - _ss.t;
            _ss = null;
            if (Math.abs(dx) > 55 && Math.abs(dy) < Math.abs(dx) && ms < 800 && window._vpSectNav) {
              ev.preventDefault();
              window._vpSectNav(dx < 0 ? 1 : -1);
            }
          }, true);
        }
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

    // (dev0763) srcdoc is same-origin, so the ▼▼/▶▶ icons get their click
    // handler wired from here rather than by injecting a script into every
    // slide we build. onload (assignment, not addEventListener) so paging
    // through sections re-wires the new document without stacking listeners.
    const loadIframe = (html) => {
      iframe.onload = function () {
        try {
          if (typeof window._salWireXAll === 'function') window._salWireXAll(iframe.contentDocument);
        } catch (_) {}
      };
      iframe.srcdoc = html;
    };

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
          // (dev0763) ▼▼/▶▶ expand-all icons — this iframe has its own document,
          // so the index.html rule doesn't reach it. Clicks are wired from the
          // parent in loadIframe (srcdoc is same-origin).
          + '.te-xall{display:inline-block;letter-spacing:-0.40em;padding-right:0.40em;'
          + 'font-size:1.15em;line-height:1;vertical-align:-0.06em;color:#2563eb;'
          + 'cursor:pointer;user-select:none;-webkit-user-select:none;}'
          + '.te-slide[style*="color:"] .te-xall{color:inherit;}'
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
          + 'summary a,summary a:visited{color:#2563eb!important;text-decoration:underline;}'
          // (dev0619) Slide-wide text color (inline on the .te-slide wrapper)
          // wins over the forced summary blue — matches Xe/Xs/G behavior.
          + '.te-slide[style*="color:"] summary{color:inherit!important;}'
          // (dev0643) Large rotating blue triangle — the same prominent
          // disclosure control the grid uses (index.html), re-declared here
          // because this iframe has its own document.
          + 'summary{list-style:none;cursor:pointer;}'
          + 'summary::-webkit-details-marker{display:none;}'
          + 'summary::before{content:"\\25B6";display:inline-block;font-size:1.6em;'
          + 'line-height:0;vertical-align:-0.16em;margin-right:0.32em;color:#2563eb;'
          + 'text-shadow:0 0 3px rgba(255,255,255,0.95);transition:transform 0.15s ease;}'
          + 'details[open]>summary::before{transform:rotate(90deg);}';
        const _aStyle = '<style>' + _ftStyles + '</style>';
        // (dev0249) Body scaffold for fragment-style ftext: cap content at
        // ~880px and auto-center so desktop has reasonable side margins
        // (~25% of a 1920px screen) without forcing tight margins on mobile.
        const _bodyCss = 'body{font-family:Arial,sans-serif;line-height:1.5;'
          + 'max-width:880px;margin:0 auto;padding:24px;'
          + 'box-sizing:border-box;}';
        if (ftLink.includes('<html')) {
          // Full-document ftext can't be sectioned (splitting would strip its
          // head/body scaffold) — show it whole, as before.
          loadIframe(ftLink.replace(/<\/head>/i, _aStyle + '</head>'));
        } else {
          // (dev0617) SECTIONED text slide — split at each top-level <hr>
          // (same splitter as the 1a grid cell / Xs) and show ONE section per
          // "page". →/← page through sections (forwarded from inside the
          // iframe too); the top-bar hint doubles as the page counter.
          const sects = (typeof window._salSplitSections === 'function')
            ? window._salSplitSections(ftLink) : [ftLink];
          let sIdx = 0;
          if (sects.length > 1 && typeof window._vpSectStart === 'number') {
            sIdx = Math.max(0, Math.min(window._vpSectStart, sects.length - 1));
          }
          window._vpSectStart = null;
          const hintEl = topBar.querySelector('#vp-html-hint');
          // (dev0636) Cell-designation sections — the dev0624 Xs rule, now in V
          // (the fullscreen viewer Gu/slam.com actually uses; until now it
          // rendered "1b"/"g" pages as literal letters, which is why the
          // feature "worked on localhost" — the dev previews via Xs — "but
          // never on slam.com"). A section whose entire content is a bare cell
          // designation shows that cell's row as REAL fullscreen media, by
          // re-entering gridOpenFullscreen with the designated row and
          // re-arming _vpSectNav after (the re-entry nulls it; vpKeyHandler
          // consults _vpSectNav before any video keys, so ←/→ stay slide
          // paging — same precedence Xs settled on in dev0626). Paging from a
          // media page to a text/G page re-enters with the ORIGINAL row at the
          // target index (_vpSectStart), rebuilding this viewer. "G" pages go
          // transparent so the live grid behind shows through, view-only (the
          // overlay still swallows pointer events); Esc/✕ close back to it for
          // real. A designation pointing at a text-only row (no link, not a
          // video) falls through and renders as text, as before.
          const _desigCleanup = () => {
            // Mini vpClose: stop the CURRENT media player/timers before a
            // re-entry wipes its DOM (gridOpenFullscreen never cleans up the
            // previous open — vpClose normally does that).
            if (_vpState && _vpState.interval) clearInterval(_vpState.interval);
            if (_vpState && _vpState.player) {
              try {
                if (_vpState.isYT) { _vpState.player.stopVideo(); _vpState.player.destroy(); }
                else if (typeof _vpState.player.destroy === 'function') _vpState.player.destroy();
              } catch (_) {}
            }
            if (window.stopCellVideoLoop) window.stopCellVideoLoop('grid-fs-video');
            fs.style.background = '#000';   // drop a G-page transparency (inline style — restore, don't clear)
          };
          // (dev0637) Floating ‹ › page arrows — touch users had NO way to page
          // sections (paging was arrow-key only). Appended to fs, NOT content,
          // so they sit above a designation page's media viewer too; the
          // top-of-open reset removes them on every gridOpenFullscreen, so the
          // media path re-adds them after its re-entry returns.
          const _addSectArrows = () => {
            if (fs.querySelector('#vpSectArrows')) return;
            const holder = document.createElement('div');
            holder.id = 'vpSectArrows';
            holder.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:70;';
            const _mkBtn = (txt, side, topCss, extra) => {
              const b = document.createElement('button');
              b.textContent = txt;
              b.style.cssText = 'position:absolute;top:' + topCss + ';' + side + ':10px;'
                + 'transform:translateY(-50%);pointer-events:auto;width:46px;height:46px;'
                + 'border-radius:50%;border:1px solid rgba(255,255,255,0.35);'
                + 'background:rgba(0,0,0,0.45);color:#fff;font-size:26px;line-height:1;'
                + 'cursor:pointer;touch-action:manipulation;user-select:none;-webkit-user-select:none;'
                + (extra || '');
              // Swallow the gesture start so the image/video swipe catchers
              // underneath never treat a button tap as a swipe.
              b.addEventListener('pointerdown', e => e.stopPropagation());
              holder.appendChild(b);
              return b;
            };
            if (sects.length > 1) {
              _mkBtn('‹', 'left',  '50%').addEventListener('click', e => {
                e.stopPropagation();
                if (typeof window._vpSectNav === 'function') window._vpSectNav(-1);
              });
              _mkBtn('›', 'right', '50%').addEventListener('click', e => {
                e.stopPropagation();
                if (typeof window._vpSectNav === 'function') window._vpSectNav(1);
              });
            }
            // (dev0638) Red ✕ just below the › — one thumb-reachable exit from
            // fullscreen text, on every page kind (text / media / G), shown
            // even on single-page slides.
            _mkBtn('✕', 'right', 'calc(50% + 58px)',
              'background:rgba(60,0,0,0.65);border-color:#f44;color:#f88;font-size:20px;')
              .addEventListener('click', e => { e.stopPropagation(); vpClose(); });
            fs.appendChild(holder);
          };
          const showSect = () => {
            const spec = (typeof window._salSectCellSpec === 'function')
              ? window._salSectCellSpec(sects[sIdx]) : null;
            const dRow = (spec && spec !== 'G' && typeof getRowByCellForGrid === 'function')
              ? getRowByCellForGrid(spec) : null;
            if (dRow && (dRow.link || (typeof isVideoRow === 'function' && isVideoRow(dRow)))) {
              const nav = window._vpSectNav;   // survive the re-entry's reset
              _desigCleanup();
              gridOpenFullscreen(dRow);
              window._vpSectNav = nav;
              window._vpTextReader = true;  // (dev0644) still the reader — ↓ closes
              _addSectArrows();   // (dev0637) re-entry's top reset removed them
              return;
            }
            if (!iframe.isConnected) {
              // Returning from a media page — this viewer's DOM is gone.
              // Re-enter with the original row at the target page.
              _desigCleanup();
              window._vpSectStart = sIdx;
              gridOpenFullscreen(row);
              return;
            }
            if (spec === 'G') {
              // Grid page: viewer goes transparent; the live grid shows
              // through. Top bar stays for the counter / swipe-back.
              fs.style.background = 'transparent';
              iframe.style.visibility = 'hidden';
            } else {
              fs.style.background = '#000';
              iframe.style.visibility = '';
              loadIframe('<!DOCTYPE html><html><head><meta charset="UTF-8">'
                + '<style>' + _bodyCss + _ftStyles + '</style></head>'
                + '<body>' + sects[sIdx] + '</body></html>');
            }
            if (hintEl && sects.length > 1) {
              hintEl.textContent = 'Page ' + (sIdx + 1) + '/' + sects.length
                + ' · → next · ← prev · Esc / swipe ← on this bar to return';
            }
          };
          if (sects.length > 1) {
            window._vpSectNav = (dir) => {
              const ni = sIdx + dir;
              if (ni < 0 || ni >= sects.length) {
                if (typeof toast === 'function') toast(dir > 0 ? 'Last page' : 'First page', 900);
                return;
              }
              sIdx = ni;
              // (dev0643) Remember where the reader is so returning to the grid
              // resumes on the same section (see grid.js _salSectIdxByUid).
              if (row && row.UID != null) {
                window._salSectIdxByUid = window._salSectIdxByUid || {};
                window._salSectIdxByUid[row.UID] = sIdx;
              }
              showSect();
            };
          }
          showSect();
          _addSectArrows();   // (dev0637/38) ‹ › when multi-page; red ✕ always
        }
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

    // (dev0765) Same latch as the video branch. There is no player to pause
    // here, but a slideshow that is showing this picture full-window still has
    // a clock running, and magnifying should stop it.
    let _iZoomStopped = false;
    function _iApply() {
      img.style.transform = `translate(${_iTx}px,${_iTy}px) scale(${_iScale})`;
      // Cursor hints: zoom-in at 1×, grab when zoomed (no button held)
      ivWrap.style.cursor = _iScale > 1.05 ? 'grab' : 'zoom-in';
      if (_iScale > 1.05) {
        if (!_iZoomStopped) { _iZoomStopped = true; _vpZoomStopPlayback(); }
      } else _iZoomStopped = false;
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

  // (dev0741) Drop the toolbar-height observer with the toolbar it watched.
  if (_vpState && _vpState.toolbarRO) {
    try { _vpState.toolbarRO.disconnect(); } catch (_) {}
    _vpState.toolbarRO = null;
  }

  // (dev0406) Tear down the floating step button + its live intervals.
  if (window._vpFSB && typeof window._vpFSB.cleanup === 'function') {
    try { window._vpFSB.cleanup(); } catch (_) {}
    window._vpFSB = null;
  }

  window._vpCurrentRow = null; // (zip0178) clear tracked row
  window._vpSectNav = null;    // (dev0617) drop the text-slide section pager
  window._vpTextReader = false; // (dev0644) leaving the reader (if we were in it)
  
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
  // (dev0637) Tear down the floating section-page arrows (they live on fs,
  // outside content, so the content wipe never reaches them).
  const _sectArr = fs.querySelector('#vpSectArrows');
  if (_sectArr) _sectArr.remove();
  // If V forced gridOverlay open from T (no real grid underneath), hide it
  // again so we land back on T instead of a blank dark overlay.
  if (window._vpForcedGridFromT) {
    const _gOvl = document.getElementById('gridOverlay');
    if (_gOvl) _gOvl.style.display = 'none';
    window._vpForcedGridFromT = false;
  }
  document.removeEventListener('keydown', vpKeyHandler, true);
  // (dev0644) Re-sync sectioned grid cells to the reader's last page
  // (_salSectIdxByUid) so ↓/Esc lands with the t cell "back in frame".
  if (typeof window._gridSectionSyncAll === 'function') window._gridSectionSyncAll();
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

  // (dev0724) A crop text box being typed into owns the keyboard: ↑ / ↓ resize
  // the text, Esc ends the entry, everything else is a character. The test is
  // e.target and NOT an "am I editing" flag on purpose — core.js's "Esc blurs
  // the focused field" rule runs first (window-capture beats this document one)
  // and would clear such a flag before we ever saw the key, letting Escape fall
  // through to vpClose and take the whole video down mid-sentence.
  if (e.target && e.target.classList
      && e.target.classList.contains('vp-crop-text-input')) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault(); e.stopImmediatePropagation();
      _vpTextNudgeSize(e.key === 'ArrowUp' ? 1 : -1);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      _vpTextEndEdit();
      return;
    }
    return;
  }

  // (dev0749) A text box's own menu, or the saved-text list, owns the keyboard
  // while it is up: its letters are answers to the question on screen. Both
  // register their handlers AFTER this one, so without standing down here the
  // key would be acted on twice — picking "1 second" for a pause would also
  // stamp a clip mark, and Escape would close the whole video rather than the
  // menu in front of it.
  if (document.getElementById(VP_TEXT_MENU_ID) ||
      document.getElementById(VP_TEXT_PICK_ID)) return;

  // (dev0344) Esc closes V / Ie back to T (re-enabled — was removed in zip0186).
  // vpClose() handles teardown and silently refuses in locked-share mode, so no
  // separate guard is needed here.
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopImmediatePropagation();
    vpClose();
    return;
  }

  // (dev0617) ←/→ page through a sectioned fullscreen text slide. Only set for
  // multi-section text opens.
  // (dev0644) Slide paging WINS everywhere — including a designation page with
  // a live video (dev0643 frame-stepped there; user verdict: moving the slide
  // takes priority). Frame-stepping a video page is Shift+←/→ — shifted arrows
  // skip this block and fall through to the frame-step block below, which
  // doesn't care about modifiers.
  // (dev0701) …with one exception: a video page whose video is PAUSED. Pausing
  // is the deliberate "I want to look at this frame" act, so there the plain
  // arrows frame-step (falling through to the block below). Playing video, or
  // no video at all (text / image / G page) → the arrows page the slide.
  if (window._vpSectNav && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      && !e.shiftKey && !_vpIsPausedNow()) {
    e.preventDefault(); e.stopPropagation();
    window._vpSectNav(e.key === 'ArrowRight' ? 1 : -1);
    return;
  }

  // (dev0644) In the text reader (a t cell expanded via ↑ / swipe-right), ↓
  // returns to the grid — vpClose re-syncs the sectioned cell so it lands
  // "back in frame" on the reader's last page. Applies on designation media
  // pages too (the flag is re-armed there). ↑ is consumed but inert, so it
  // can't fall through to the Iu/Ie row-navigation below (which would hop to
  // an unrelated row from inside a lesson).
  if (window._vpTextReader && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'ArrowDown') vpClose();
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
    // (dev0668) A link the viewer added themselves ("Add your own") is NOT in
    // `data`, so data.indexOf below returns -1 and ↑/↓ would hop to an
    // unrelated collection row. There is no row list to walk here — stand down.
    if (window._vpCurrentRow && window._vpCurrentRow._userLink) return;
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
    // (dev0725) ⇧← / ⇧→ jump to the START / END of the clip — the A and B marks,
    // or the ends of the video when they aren't set yet. Crop-overlay-only, so
    // shifted arrows keep their frame-step meaning on a PM lesson page (dev0644).
    if (e.shiftKey && _vpCropHolding()) {
      e.stopPropagation();
      if (_vpIsPlaying()) _vpPauseNow();
      const el  = _vpState.player && _vpState.player.el;
      const dur = (el && Number.isFinite(el.duration)) ? el.duration : 0;
      const at  = (e.key === 'ArrowLeft')
        ? ((_vpState.aPoint != null) ? _vpState.aPoint : 0)
        : ((_vpState.bPoint != null) ? _vpState.bPoint : dur);
      _vpSeekAbsolute(at);
      if (typeof toast === 'function') {
        toast((e.key === 'ArrowLeft' ? '⏮ start' : '⏭ end') + ' of clip · ' +
              at.toFixed(2) + 's' +
              ((e.key === 'ArrowLeft' ? _vpState.aPoint : _vpState.bPoint) == null
                 ? ' (no mark — the video’s own end)' : ''), 1600);
      }
      return;
    }
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    // (dev0718) A crop in progress pins the show to this video, so the arrows
    // keep their frame-step meaning — which is what you want when nudging a
    // crop's in/out points anyway.
    if (_vpState.slideshowNoLoop && _vpIsPlaying() && !_vpCropHolding()) {
      if (window._slideshowVideoSwipe) window._slideshowVideoSwipe(dir);
      if (typeof vpClose === 'function') vpClose();
      return;
    }
    if (_vpIsPlaying()) _vpPauseNow();   // pause so the frame-step shows
    vpSeekRelative(dir / 30);
    return;
  }
  
  // M = mute toggle
  // (dev0719) …except while the crop overlay is open, where M belongs to the
  // OUTPUT: it decides whether the rendered clip carries a soundtrack (the bar
  // says which). Muting the PLAYER during a crop is still one click away on the
  // V toolbar's 🔇, so nothing is lost by handing the key over.
  if (e.key === 'm' || e.key === 'M') {
    e.preventDefault();
    if (_vpCropHolding()) { _vpCropToggleAudio(); return; }
    vpToggleMute();
    return;
  }

  // (dev0287→0749) R used to toggle the disk-info caption. It is now simply
  // always on — it is the answer to "what am I looking at", which is not a
  // question that comes and goes — so the key is gone and R is free again.

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

  // (dev0724) W = widen/narrow the cheat-sheet · E = drop a text box on the
  // frame. Both gated to a visible crop overlay, like T above, so the letters
  // stay free elsewhere. (The zoom box moved off K onto Z — see below.)
  //
  // E also needs a bail in core.js's window-capture dispatcher, which runs
  // FIRST and would otherwise open the row editor: `e` is a registry hotkey and
  // — unlike `w` — its fn doesn't stand down while V is up.
  if (e.key === 'w' || e.key === 'W') {
    if (!_vpCropHolding()) return;
    e.preventDefault(); e.stopPropagation();
    _vpCropHelpToggleWidth();
    return;
  }

  // (dev0724/dev0727) E does one of two things, and which one is never in
  // doubt: with the crop overlay OPEN it drops a text box on the frame; with it
  // CLOSED, on a disk video, it opens a saved .edit — the counterpart of K.
  // (Loading one opens the overlay, so the two never compete for the key.)
  if (e.key === 'e' || e.key === 'E') {
    if (_vpCropHolding()) {
      e.preventDefault(); e.stopPropagation();
      _vpTextAdd();
      return;
    }
    if (!_vpState || !_vpState.crop) return;      // not a disk video — leave E alone
    e.preventDefault(); e.stopPropagation();
    _vpCropLoadEditPick();
    return;
  }

  // (dev0727) K = keep: write the whole session next to the source as an .edit.
  if (e.key === 'k' || e.key === 'K') {
    if (!_vpCropHolding()) return;
    e.preventDefault(); e.stopPropagation();
    _vpCropSaveEdit();
    return;
  }

  // (dev0725) ⇧F = the whole frame, no crop. Capital only — bare f still walks
  // the playhead +5 frames below. Like `e`/`w` it needs a core.js bail, which
  // otherwise spends ⇧F on "clear all filters".
  if (e.key === 'F') {
    if (!_vpCropHolding()) return;
    e.preventDefault(); e.stopPropagation();
    _vpCropFullFrame();
    return;
  }

  // (dev0672) z toggles the ⤢ embed-zoom arm — the keyboard twin of the toolbar
  // button. Gated on that button existing, so it only ever fires on a
  // cross-origin embed (IG/TikTok) and leaves z free everywhere else — including
  // the crop-rotate below, which is why this sits ABOVE it: that block returns
  // outright when there is no crop overlay, so anything after it never runs.
  //
  // dev0612 ruled out a key gate here because the play click moves focus into
  // the frame and the parent stops seeing keydown. That is no longer true: the
  // IG mount recaptures focus (dev0671), so the key survives a play.
  if ((e.key === 'z' || e.key === 'Z') && document.getElementById('vp-embed-zoom')) {
    e.preventDefault(); e.stopPropagation();
    _vpEmbedZoomArm(!window._vpEmbedZoomArmed);
    if (typeof toast === 'function') {
      toast(window._vpEmbedZoomArmed
        ? '⤢ zoom armed — hold to enlarge · drag to pan · double-click = usual size · z to hand it back'
        : '⤢ zoom off — the picture is the player’s again', 1800);
    }
    return;
  }

  // (dev0724) Z = arm / disarm the zoom box (was K in dev0720). It sits BELOW
  // the embed-zoom block above, which returns outright when its toolbar button
  // exists — and it never does here, since the crop overlay only mounts on disk
  // videos while ⤢ only exists on a cross-origin embed. Nothing is shadowed.
  if (e.key === 'z' || e.key === 'Z') {
    if (!_vpCropHolding()) return;
    e.preventDefault(); e.stopPropagation();
    _vpKenToggle();
    return;
  }

  // (dev0318/dev0724) 1 / 2 = rotate the crop frame −/+ 0.5° (straighten) —
  // they took this over from Z / X so Z could become the zoom. Gated to a
  // visible crop overlay like T, so they pass through in any other context
  // (core.js only claims digits for the grid when V is NOT on top of it).
  if (e.key === '1' || e.key === '2') {
    if (!_vpCropHolding()) return;
    e.preventDefault(); e.stopPropagation();
    const s = _vpState.crop;
    if (s.setAngle) s.setAngle(s.angle + (e.key === '1' ? -0.5 : 0.5));
    return;
  }

  // (dev0749) a / f — the clip's start / end at the frame you are on (again to
  // clear), the keyboard twins of the A and B buttons. They took this over from
  // ⇧A / ⇧B, which no longer mark anything: one row of left-hand keys now does
  // the whole job, with the two marks on the outside and the frame-step between
  // them.
  //
  // s / d — one frame back / forward, the ← / → twins. (dev0719's ±5 jumps are
  // gone with a and f; the ±0.1s toolbar buttons still nudge a mark in place.)
  //
  // All four are gated to an OPEN crop overlay, which is exactly when the
  // cheat-sheet listing them is on screen. Outside it the letters stay free,
  // and they must: review mode rates with a/s/d/f and a plain slideshow uses d
  // for the folder picker.
  if (e.key === 'a' || e.key === 'f') {
    if (!_vpCropHolding()) return;
    // The buttons themselves must be mounted — vpUpdateABStyle writes straight
    // into them, and an embed-only toolbar (IG/TikTok) has no A/B pair.
    if (!document.getElementById('vp-a') || !document.getElementById('vp-b')) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'a') vpToggleA(); else vpToggleB();
    return;
  }
  if (e.key === 's' || e.key === 'd') {
    if (!_vpCropHolding()) return;
    e.preventDefault(); e.stopPropagation();
    if (_vpIsPlaying()) _vpPauseNow();   // pause so the step is actually visible
    vpSeekRelative((e.key === 's' ? -1 : 1) / 30);
    return;
  }

  // (dev0667) L — save the current A→B as a user loop (same as the AB💾 button).
  // Follows the ASDF/G convention: inert unless BOTH points are set, so the key
  // stays free everywhere else.
  if (e.key === 'l' || e.key === 'L') {
    if (!_vpState || _vpState.aPoint == null || _vpState.bPoint == null) return;
    e.preventDefault(); e.stopPropagation();
    vpSaveAB();
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
// (dev0703) ── THE horizontal-swipe rule, V/PM side ──────────────────────────
// Twin of slideshow.js _slideshowHorizSwipe, so one sentence covers the whole
// app: plain ← = PREVIOUS VIEW, plain → = next slide, ⇧← / ⇧→ = previous / next
// slide. "Slide" means whatever this page is paging: a PM lesson deck section
// (window._vpSectNav) or, for a video opened from the slideshow, a show slide.
//
// Before dev0703 a plain horizontal swipe on a PM page paged the deck and never
// closed V, which is exactly the inconsistency this rule removes — plain ← now
// leaves, the same as on every other fullscreen page.
//
// Callers have already established a real horizontal swipe at ~1× zoom.
// Returns true when it acted (the caller then stops).
function _vpHorizSwipe(dx, shift) {
  const right = dx > 0;
  const inSS  = !!(_vpState && _vpState.slideshowNoLoop);

  if (window._vpSectNav) {                       // PM — a paged lesson deck
    if (shift || right) { window._vpSectNav(right ? 1 : -1); return true; }
    // plain ← falls through to the exit below
  } else if (inSS) {                             // a slideshow video
    if (shift || right) {
      if (window._slideshowVideoSwipe) window._slideshowVideoSwipe(right ? 1 : -1);
      vpClose();
      return true;
    }
  } else if (right) {
    return false;                                // ordinary V: nothing "forward"
  }

  // plain ← — leave for the previous view. Inside a slideshow that means the
  // whole show, not just this video (slideshowClose tears V down with it).
  if (inSS && typeof slideshowClose === 'function') { slideshowClose(); return true; }
  vpClose();
  return true;
}

function _vpIsPlaying() {
  if (!_vpState || !_vpState.player) return false;
  try { return _vpState.player.getPlayerState() === 1; } catch (_) { return false; }
}

// (dev0701) The strict counterpart: TRUE only when a video is genuinely paused
// — not merely "not playing". YT's unstarted (-1), ended (0) and buffering (3)
// states must NOT read as paused, or a PM page would frame-step the arrows
// before the viewer ever pressed play. Vimeo has no sync state getter (its
// getPaused() is a promise), so it answers false and keeps paging the slides;
// Shift+←/→ still frame-steps there.
// (dev0701) Best duration available RIGHT NOW, in seconds, or 0. The poller's
// cached _vpState.duration first (one tick old at worst), then the media
// element for a direct/disk video, then YT's sync getDuration(). Vimeo's is a
// promise, so it only ever answers through the cache.
function _vpDurNow() {
  if (!_vpState || !_vpState.player) return 0;
  if (_vpState.duration > 0) return _vpState.duration;
  const p = _vpState.player;
  try {
    if (p.el && isFinite(p.el.duration) && p.el.duration > 0) return p.el.duration;
    if (_vpState.isYT) { const d = p.getDuration(); if (d > 0) return d; }
  } catch (_) {}
  return 0;
}

function _vpIsPausedNow() {
  if (!_vpState || !_vpState.player) return false;
  try { return _vpState.player.getPlayerState() === 2; } catch (_) { return false; }
}

function _vpPauseNow() {
  if (!_vpState || !_vpState.player) return;
  const p = _vpState.player;
  try { if (_vpState.isYT) p.pauseVideo(); else p.pause(); } catch (_) {}
  vpUpdatePlayBtn();
}

// (dev0765) ── ZOOM MEANS "HOLD IT THERE" ──────────────────────────────────
// Magnifying is a request to STUDY one frame, and everything that was moving
// under it fights that: the video plays on past the very thing being looked at,
// and if a slideshow put the video on screen its clock keeps ticking toward the
// next slide. So the first push past the zoom threshold stops both — which is
// the rule the show already applies to its own images (slideshow.js dev0268),
// now extended to V, the one place a zoom did not stop anything.
//
// Callers own the "only once" latch (see _vApply / _iApply): after this fires
// the reader is free to press play again and pan around a running video, and
// each pan re-enters _vApply — re-pausing there would make a zoomed video
// impossible to watch. Dropping back to 1× re-arms the latch.
function _vpZoomStopPlayback() {
  try { if (_vpIsPlaying()) _vpPauseNow(); } catch (_) {}
  try {
    if (typeof window._slideshowZoomPause === 'function') window._slideshowZoomPause();
  } catch (_) {}
}

function vpTogglePlay() {
  if (!_vpState || !_vpState.player) return;
  const p = _vpState.player;
  if (_vpState.isYT) {
    const state = p.getPlayerState();
    if (state === 1) p.pauseVideo(); else _vpYtNudgePlay(p);   // (dev0642)
  } else {
    p.getPaused().then(paused => { if (paused) p.play(); else p.pause(); });
  }
  vpUpdatePlayBtn();
}

// (dev0725) Seek to an ABSOLUTE time, both player shapes. The FSB has had its
// own copy of this since dev0410; ⇧←/⇧→ needed one outside that closure.
function _vpSeekAbsolute(t) {
  if (!_vpState || !_vpState.player) return;
  const p = _vpState.player;
  const at = Math.max(0, +t || 0);
  try {
    if (_vpState.isYT) p.seekTo(at, true);
    else p.setCurrentTime(at);
  } catch (_) {}
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
  // (dev0701) Setting/clearing/nudging A or B is a fresh arming — drop any
  // scrub-suspension so the new window loops immediately.
  if (_vpState) _vpState.abSuspended = false;
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
  // (dev0667) YT/Vimeo have no `el` to read a duration off, so the A/B lines
  // used to be permanently hidden there. vpUpdateTimeline has been stashing the
  // real duration on _vpState every tick — use it, and the markers show for
  // embedded players too (which is where user loops mostly live).
  if (!(dur > 0) && _vpState && Number.isFinite(_vpState.duration)) dur = _vpState.duration;
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
    // (dev0701) Duration read LIVE, not off the poller's last tick. It used to
    // bail on `!_vpState.duration`, which is 0 until vpUpdateTimeline has run
    // with a player that answers — so an early click on the bar (and every
    // click on a player whose duration the poller never managed to read) was a
    // silent no-op instead of a seek.
    const dur = _vpDurNow();
    if (!_vpState || !dur) return;
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
      const t = pct * dur;
      // (dev0701) A manual scrub OUTSIDE an armed A→B window used to be undone
      // within one poller tick: the A-B branch in vpUpdateTimeline sees ct past
      // B and yanks the playhead back to A, so on any row with a loop armed
      // (every "My Loops" open — those start in FULL mode) clicking the far end
      // of the bar looked like the timeline was dead. The click wins now; the
      // loop re-arms by itself when playback re-enters A→B.
      if (_vpState.aPoint !== null && _vpState.bPoint !== null) {
        _vpState.abSuspended = (t < _vpState.aPoint || t >= _vpState.bPoint);
      }
      if (_vpState.isYT) _vpState.player.seekTo(t, true);
      else _vpState.player.setCurrentTime(t);
    }
  };
  timeline.addEventListener('pointerdown', e => {
    // (dev0293) Ctrl+click on timeline sets A/B alternating: first Ctrl-click
    // sets A, second sets B, third resets both and starts a new pair. Plain
    // click still scrubs. Computes time from click position (not playhead).
    if (e.ctrlKey && _vpState && _vpDurNow()) {
      e.preventDefault(); e.stopPropagation();
      const p = (typeof window.rotateXY === 'function')
        ? window.rotateXY(e) : { x: e.clientX, y: e.clientY };
      const r = _vpWrapLocalRect(timeline);
      const pct = Math.max(0, Math.min(1, (p.x - r.left) / r.width));
      const t = pct * _vpDurNow();
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

// Save A-B range.
//
// (zip0128) It stopped writing to the row: the AB column in ml.json was renamed
// BA (BatchAdd marker for channel-imported rows), so A/B became a runtime-only
// convenience and this button did nothing but toast the numbers.
//
// (dev0667) It now saves the range as a USER LOOP — the viewer's own named A→B
// bookmark, stored in their browser via loops.js and listed on the menu's "My
// Loops" tab. Still nothing is written to ml.json: that file is dev-owned and
// FSA-clobbered on every save, so a viewer's marks could not survive there (and
// would leak into everyone else's data if they did).
function vpSaveAB() {
  if (!_vpState || _vpState.aPoint === null || _vpState.bPoint === null) {
    toast('Set both A and B points first', 1500);
    return;
  }
  const a = Math.min(_vpState.aPoint, _vpState.bPoint);
  const b = Math.max(_vpState.aPoint, _vpState.bPoint);
  const abStr = a.toFixed(2) + ':' + (b - a).toFixed(2);
  const row = (_vpState && _vpState.row) || window._vpCurrentRow;

  // No store, or a row with no identity to key the loop by (a slideshow disk
  // video has no UID) — fall back to the old display-only toast so the numbers
  // are still there to copy.
  if (!window.salLoops || !row || row.UID == null) {
    toast('A:B range = ' + abStr + '\n(not saved — display only)', 2500);
    return;
  }
  // A loop with no width would mount and instantly re-seek to itself.
  if (b - a < 0.05) {
    toast('A and B are at the same point — move one of them first', 2200);
    return;
  }
  const name = prompt('Save this A→B loop as:', _vpLoopDefaultName(row, a, b));
  if (name === null) return;                       // cancelled — nothing saved
  window.salLoops.add({
    uid: String(row.UID), link: String(row.link || ''),
    name: name.trim() || _vpLoopDefaultName(row, a, b), a: a, b: b
  }).then(res => {
    toast((res.created ? '★ Loop saved — see "My Loops"' : '★ Loop updated')
      + '\n' + window.salLoops.fmt(a) + ' → ' + window.salLoops.fmt(b), 2400);
  }).catch(() => {
    toast('Could not save the loop — browser storage may be full', 3000);
  });
}

// (dev0667) Default name offered when saving a loop: what the viewer would call
// this bit of this video. Title first (that's what the search results show),
// then the comment, then a bare UID, with the range appended so several loops
// on one video are told apart at a glance.
function _vpLoopDefaultName(row, a, b) {
  let base = String(row.VidTitle || row.VidComment || '').trim();
  if (!base) base = 'UID ' + row.UID;
  if (base.length > 44) base = base.slice(0, 44).trim() + '…';
  const f = window.salLoops ? window.salLoops.fmt : (s => Number(s).toFixed(1) + 's');
  return base + '  ' + f(a) + '–' + f(b);
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
    // (dev0701) …and stands down while a manual scrub has parked the playhead
    // outside the window (see _vpScrubTo); it re-arms the moment playback is
    // back inside A→B.
    if (_vpState.abSuspended && _vpState.aPoint !== null && _vpState.bPoint !== null
        && ct >= _vpState.aPoint && ct < _vpState.bPoint) {
      _vpState.abSuspended = false;
    }
    if (!window._vpFSB && !_vpState.abSuspended
        && _vpState.aPoint !== null && _vpState.bPoint !== null
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
        // (dev0718) …unless a crop holds this video, in which case fall through
        // and loop back to the first segment rather than closing.
        if (_vpState.slideshowNoLoop && !_vpCropHolding() &&
            _vpState.segIdx >= _vpState.segs.length - 1) {
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

// (dev0642) Play with a mute-fallback. Mobile browsers refuse UNMUTED
// play for rows with Mute='0': autoplay at mount is gestureless, and even
// V's ▶ button doesn't help because the tap gesture never crosses into the
// cross-origin iframe (playVideo is just a postMessage). The player then
// sits "unstarted" showing YT's big red button — which is itself dead,
// since V stamps pointer-events:none on the iframe (dev0335). So: try to
// play, and if the player hasn't reached playing/buffering shortly after,
// mute and retry (muted play is always permitted), syncing _vpState.muted
// + the 🔇 icon so one tap on the mute button restores sound (that tap IS
// a real gesture on an already-playing video, which browsers allow).
function _vpYtNudgePlay(p) {
  try { p.playVideo(); } catch (_) {}
  setTimeout(() => {
    if (!_vpState || _vpState.player !== p || _vpState.muted) return;
    try {
      const st = p.getPlayerState();
      if (st === 1 || st === 3) return;   // playing / buffering — all good
      _vpState.muted = true;
      p.mute();
      p.playVideo();
      const mb = document.getElementById('vp-mute');
      if (mb) mb.innerHTML = window.muteIconHTML ? window.muteIconHTML(true) : '🔇';
      if (typeof toast === 'function') toast('started muted — tap 🔇 for sound', 1800);
    } catch (_) {}
  }, 1200);
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
  // (dev0749) Twice the type, and no longer toggleable — see the note where R
  // used to live. At 24px it reads from across the room, which is the point of
  // a caption that says which file is on screen.
  ov.style.cssText =
    'position:absolute;top:8px;left:8px;z-index:50;pointer-events:none;' +
    'background:rgba(0,0,0,0.55);color:#dfe6f0;padding:6px 9px;border-radius:4px;' +
    'font:24px/1.35 ui-monospace,Consolas,monospace;white-space:pre;' +
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

// (dev0717) How much the chosen output resolution would ENLARGE the crop rect.
// resHeight is the SHORT side either way — the proxy scales height for L
// (`scale=-2:H`) and width for P (`scale=H:-2`) — so it is compared against
// whichever source dimension that is. >1 means ffmpeg upscales: no new detail,
// only a bigger file. Returns 1 for 'Same', which emits no scale filter at all.
// Drives both the live amber dim-label and the save-time confirm.
// (dev0718) True while the crop overlay is open. A crop session HOLDS the
// current video: the slideshow must not advance out from under a half-finished
// crop when the clip ends, and ←/→ frame-step instead of changing slides.
// Consulted by the 'ended' listener, the segment walk, and the arrow keys.
function _vpCropHolding() {
  return !!(_vpState && _vpState.crop &&
            _vpState.crop.el.container.style.display !== 'none');
}

function _vpCropUpscaleFactor(state, sw, sh) {
  const resH = state.resHeight;
  if (!Number.isFinite(resH) || resH <= 0) return 1;
  let srcShort = (state.aspect === 'P') ? sw : sh;
  // (dev0720) A Ken Burns move ENDS on the inner box, so that — not the whole
  // crop — is the framing that has to carry the output resolution. Judge the
  // enlargement by the tightest moment of the shot.
  if (state.ken && state.ken.on && state.ken.frac.w > 0) srcShort *= state.ken.frac.w;
  if (!srcShort) return 1;
  return resH / srcShort;
}

// (dev0720) Playhead now, in seconds, for a disk video. The crop overlay only
// mounts on those, so the media element is always the source of truth here.
function _vpNowSec() {
  const p = _vpState && _vpState.player;
  if (p && p.el && Number.isFinite(p.el.currentTime)) return p.el.currentTime;
  return 0;
}

// (dev0720/dev0724) Z (was K) — arm / disarm the zoom box. Arming stamps the
// current playhead as the frame the zoom lands on; moving the box re-stamps it.
function _vpKenToggle() {
  if (!_vpState || !_vpState.crop) return;
  const s = _vpState.crop;
  if (!s.ken) return;
  s.ken.on = !s.ken.on;
  if (s.ken.on) s.ken.atSec = _vpNowSec();
  // (dev0745) On a still, arming the zoom is ASKING for a clip — a picture with
  // a move on it and no format to move in is a box that does nothing at save.
  let armed = false;
  if (s.imageMode && s.ken.on && s.motion && s.motion.format === 'still') {
    s.motion.format = 'mp4';
    armed = true;
  }
  if (s.paintKen) s.paintKen();
  if (s.paint) s.paint();   // ⚠ enlargement label depends on the zoom
  if (typeof toast === 'function') {
    if (s.imageMode) {
      toast(s.ken.on
        ? '🎬 zoom armed — drag the amber box to where the move should END' +
          (armed ? ' · output is now an mp4 clip (M for gif)' : '')
        : '🎬 zoom off — the picture is held still', s.ken.on ? 3600 : 1600);
    } else {
      toast(s.ken.on
        ? '🎬 Ken Burns armed — drag the amber box to where the zoom should end, ' +
          'parked on the frame it should get there (' + s.ken.atSec.toFixed(1) + 's)'
        : '🎬 Ken Burns off — the crop renders static', s.ken.on ? 3400 : 1600);
    }
  }
}

// (dev0724) ── Text boxes ────────────────────────────────────────────────────
// E drops a resizable box on the frame; click inside it and every key is a
// character until you click out again (↑ / ↓ resize the type). What you see
// wrapped in the box is what ffmpeg burns in at G, because drawtext CANNOT
// wrap — the client hands it lines, not a paragraph, and _vpTextWrapLines is
// where the paragraph becomes those lines.
//
// (dev0725) Right-clicking a box opens its own menu instead of V's step panel:
// ⬇ / ⬆ arrows to drop at the caret, and s / e to mark when the caption comes
// and goes (absolute seconds here, enable= times at render).
//
// Geometry is in fractions of the CROP window on every axis, size included, so
// a box means the same thing after a resize, an aspect swap or a change of
// output resolution — and the proxy can turn it into output pixels without
// knowing anything about this screen.
// (dev0725) Segoe UI Symbol, not Arial: it is the one stock Windows text font
// that carries the HEAVY arrows (U+2B07 ⬇ / U+2B06 ⬆) the right-click menu
// inserts — Arial draws them as tofu — and its Latin is Segoe UI, so ordinary
// captions look right. Must stay in step with the proxy's DT_FONT_CANDIDATES,
// or the wrap measured here won't be the wrap ffmpeg draws.
const VP_TEXT_FONT     = '"Segoe UI Symbol","Segoe UI",Arial,sans-serif';
const VP_TEXT_ARROW_DN = '⬇';
const VP_TEXT_ARROW_UP = '⬆';
const VP_TEXT_MIN_SIZE = 0.02;    // of the crop height
const VP_TEXT_MAX_SIZE = 0.40;
const VP_TEXT_STEP     = 0.005;
const VP_TEXT_MIN_W    = 0.06;
// ffmpeg's freetype lays a line out a shade wider than the browser does, so the
// wrap is measured against a slightly narrower box than the one on screen.
const VP_TEXT_WRAP_SAFETY = 0.98;

// (dev0750) ── The font list ─────────────────────────────────────────────────
// One typeface per box, picked off the right-click menu, where every row is
// drawn IN the font it offers — a font list without samples is a list of names.
//
// Each entry carries both halves of the same face: the CSS family the textarea
// and the wrap mirror use, and the .ttf the proxy hands drawtext (its twin is
// DT_FONTS there, and the two lists must stay in step — a mismatch means the
// wrap measured on screen is not the wrap that gets burned in).
//
// FAMILIES, never weights: "Segoe UI Semibold" and "Arial Black" are separate
// families on Windows, so no CSS font-weight is involved and the browser can't
// faux-bold a face ffmpeg would draw plain. All ten are stock Windows fonts.
//
// `arrows` — only Segoe UI Symbol carries U+2B07 ⬇ / U+2B06 ⬆. The others fall
// back to some system font for those glyphs HERE and draw tofu THERE, so
// picking one with an arrow already in the box says so out loud.
const VP_TEXT_FONT_DEF = 'sym';
const VP_TEXT_FONT_KEY = 'salCropFont';
const VP_TEXT_FONTS = [
  { id: 'sym',   key: '1', name: 'Segoe UI Symbol', arrows: true,
    css: VP_TEXT_FONT, note: 'the ⬇ ⬆ arrows live here' },
  { id: 'segoe', key: '2', name: 'Segoe UI',
    css: '"Segoe UI",Arial,sans-serif' },
  { id: 'segoesb', key: '3', name: 'Segoe UI Semibold',
    css: '"Segoe UI Semibold","Segoe UI",sans-serif' },
  { id: 'segoebl', key: '4', name: 'Segoe UI Black',
    css: '"Segoe UI Black","Segoe UI",sans-serif' },
  { id: 'arial', key: '5', name: 'Arial',
    css: 'Arial,Helvetica,sans-serif' },
  { id: 'arialbl', key: '6', name: 'Arial Black',
    css: '"Arial Black",Arial,sans-serif' },
  { id: 'impact', key: '7', name: 'Impact',
    css: 'Impact,"Arial Black",sans-serif', note: 'condensed — poster headlines' },
  { id: 'verdana', key: '8', name: 'Verdana',
    css: 'Verdana,Geneva,sans-serif', note: 'wide — legible when small' },
  { id: 'georgia', key: '9', name: 'Georgia',
    css: 'Georgia,"Times New Roman",serif', note: 'serif' },
  { id: 'times', key: '0', name: 'Times New Roman',
    css: '"Times New Roman",Times,serif', note: 'serif' }
];

function _vpTextFont(id) {
  return VP_TEXT_FONTS.find(f => f.id === id) || VP_TEXT_FONTS[0];
}

// (dev0753) ── The fill colour ────────────────────────────────────────────────
// dev0752 took the outline off a faded box, which is what made it one tone —
// and left white text at 35% almost invisible on a light picture, because a
// white fill can only ever lighten what it covers. So the colour becomes a
// choice: white for a dark picture, black for line art on white, grey for a
// photograph that wants neither. Its twin is DT_COLORS in proxy.js.
//
// `shadow` is the preview's stand-in for the outline an OPAQUE caption gets, and
// it has to oppose the fill or a black caption would be black-on-black in the
// box and ringed in black in the file. `border` is the same decision for the
// render; the two lists must say the same thing.
const VP_TEXT_COLOR_DEF = 'white';
const VP_TEXT_COLOR_KEY = 'salCropColor';
const VP_TEXT_COLORS = [
  { id: 'white', key: '1', name: 'white', css: '#ffffff', shadow: '#000',
    note: 'over a dark picture' },
  { id: 'black', key: '2', name: 'black', css: '#000000', shadow: '#fff',
    note: 'over a light one — line art, paper' },
  { id: 'grey',  key: '3', name: 'grey',  css: '#808080', shadow: '#000',
    note: 'quieter than either' }
];

function _vpTextColor(id) {
  return VP_TEXT_COLORS.find(c => c.id === id) || VP_TEXT_COLORS[0];
}

// The preview's outline. Built from a colour rather than fixed, so it can oppose
// whichever fill the box is set in.
function _vpTextShadow(c) {
  return '0 0 2px ' + c + ',0 0 3px ' + c + ',1px 1px 0 ' + c + ',-1px -1px 0 ' + c;
}

// Same reasoning as the font: a credit line you stamp on every picture should
// not need re-choosing every picture.
function _vpTextColorDefault() {
  try {
    const v = localStorage.getItem(VP_TEXT_COLOR_KEY);
    if (v && VP_TEXT_COLORS.some(c => c.id === v)) return v;
  } catch (_) {}
  return VP_TEXT_COLOR_DEF;
}

function _vpTextSetColor(t, id) {
  const s = _vpState && _vpState.crop;
  if (!s || !t) return;
  const c = _vpTextColor(id);
  t.color = c.id;
  try { localStorage.setItem(VP_TEXT_COLOR_KEY, c.id); } catch (_) {}
  if (s.paintTexts) s.paintTexts();
  if (typeof toast === 'function') {
    // The one thing worth saying out loud: a faded box has no outline to fall
    // back on, so the fill is the whole of what will be visible.
    toast('🎨 ' + c.name + (t.alpha != null && t.alpha < 1
      ? ' — at ' + Math.round(t.alpha * 100) + '% this is the only tone there is'
      : ''), 2000);
  }
}

// Fourth level of the text menu, same in-place trick as the others. Each row is
// its own swatch, for the same reason the font rows are set in their own face.
function _vpTextColorAsk(el, t) {
  el._vpAsking = 'color';
  el.innerHTML = '';
  const head = document.createElement('div');
  head.textContent = 'Which colour?  (1-3)';
  head.style.cssText = 'padding:4px 8px 6px;color:#8ef;font-weight:bold;white-space:nowrap;';
  el.appendChild(head);
  const cur = _vpTextColor(t.color).id;
  VP_TEXT_COLORS.forEach(c => {
    const d = document.createElement('div');
    d.innerHTML =
      '<u>' + c.key + '</u> &nbsp;<span style="display:inline-block;width:13px;height:13px;' +
      'vertical-align:-2px;border:1px solid #789;background:' + c.css + ';"></span>&nbsp; ' +
      _vpEscHtml(c.name) +
      (c.id === cur ? ' <span style="color:#8ef;">·  now</span>' : '') +
      (c.note ? ' <span style="opacity:0.55;">· ' + _vpEscHtml(c.note) + '</span>' : '');
    d.style.cssText = 'padding:4px 8px;border-radius:5px;cursor:pointer;white-space:nowrap;';
    d.onmouseenter = () => { d.style.background = '#12325c'; };
    d.onmouseleave = () => { d.style.background = ''; };
    d.onclick = () => { _vpTextMenuClose(); _vpTextSetColor(t, c.id); };
    el.appendChild(d);
  });
  _vpTextMenuPlace(el);
}

// The same family list, safe to drop into a double-quoted style="" attribute.
// Every family here is spelled with "double quotes", and an innerHTML sample row
// carrying them raw would close the attribute on the first one and lose the rest
// of the row. CSS takes 'single quotes' around a family name just as happily.
function _vpTextFontAttr(f) { return f.css.replace(/"/g, "'"); }

// The last font picked becomes the one a NEW box starts in — the same reasoning
// as the saved-text list: a credit line you stamp on every picture should not
// need re-choosing every picture.
function _vpTextFontDefault() {
  try {
    const v = localStorage.getItem(VP_TEXT_FONT_KEY);
    if (v && VP_TEXT_FONTS.some(f => f.id === v)) return v;
  } catch (_) {}
  return VP_TEXT_FONT_DEF;
}

function _vpTextSetFont(t, id) {
  const s = _vpState && _vpState.crop;
  if (!s || !t) return;
  const f = _vpTextFont(id);
  t.font = f.id;
  try { localStorage.setItem(VP_TEXT_FONT_KEY, f.id); } catch (_) {}
  if (s.paintTexts) s.paintTexts();
  const raw = (t.ta ? t.ta.value : t.text) || '';
  const lost = !f.arrows &&
               (raw.indexOf(VP_TEXT_ARROW_DN) >= 0 || raw.indexOf(VP_TEXT_ARROW_UP) >= 0);
  if (typeof toast === 'function') {
    toast(lost
      ? ('🅰 ' + f.name + ' — but it has no ⬇ ⬆ glyph. The arrow in this box looks ' +
         'right here and renders as an empty box; Segoe UI Symbol is the one that has them.')
      : ('🅰 ' + f.name), lost ? 5600 : 1600);
  }
}

// Third level of the text menu, same in-place trick the pause and strength
// questions use. Each row is a live sample: the name of the font, set in it.
function _vpTextFontAsk(el, t) {
  el._vpAsking = 'font';
  el.innerHTML = '';
  const head = document.createElement('div');
  head.textContent = 'Which font?  (1-9, 0)';
  head.style.cssText = 'padding:4px 8px 6px;color:#8ef;font-weight:bold;white-space:nowrap;';
  el.appendChild(head);
  const cur = _vpTextFont(t.font).id;
  VP_TEXT_FONTS.forEach(f => {
    const d = document.createElement('div');
    d.innerHTML =
      '<u>' + f.key + '</u> &nbsp;' +
      '<span style="font-family:' + _vpTextFontAttr(f) + ';font-size:17px;">' +
        _vpEscHtml(f.name) + '</span>' +
      (f.id === cur ? ' <span style="color:#8ef;">·  now</span>' : '') +
      (f.note ? ' <span style="opacity:0.55;">· ' + f.note + '</span>' : '') +
      (f.arrows ? '' : ' <span style="opacity:0.4;">· no ⬇ ⬆</span>');
    d.style.cssText = 'padding:4px 8px;border-radius:5px;cursor:pointer;white-space:nowrap;';
    d.onmouseenter = () => { d.style.background = '#12325c'; };
    d.onmouseleave = () => { d.style.background = ''; };
    d.onclick = () => { _vpTextMenuClose(); _vpTextSetFont(t, f.id); };
    el.appendChild(d);
  });
  _vpTextMenuPlace(el);
}

function _vpTextAdd()            { const s = _vpState && _vpState.crop; if (s && s.addText)        s.addText(); }
function _vpTextEndEdit()        { _vpTextMenuClose();
                                  const s = _vpState && _vpState.crop; if (s && s.endTextEdit) s.endTextEdit(); }
function _vpTextNudgeSize(dir)   { const s = _vpState && _vpState.crop; if (s && s.nudgeTextSize)  s.nudgeTextSize(dir); }

// (dev0725) ── The text box's own right-click menu ──────────────────────────
// Right-click INSIDE a box is about the text, not about stepping frames, so the
// V step panel stands down (see the contextmenu handler) and this comes up:
// two arrows to drop at the caret, and the two ends of the window this caption
// is on screen for — taken from wherever the playhead is sitting. s / e work as
// keys as well as clicks, which is what the underlines mean.
const VP_TEXT_MENU_ID = 'vp-text-menu';

function _vpTextMenuClose() {
  const el = document.getElementById(VP_TEXT_MENU_ID);
  if (el) el.remove();
  document.removeEventListener('keydown', _vpTextMenuKey, true);
}

function _vpTextMenuKey(e) {
  const el = document.getElementById(VP_TEXT_MENU_ID);
  if (!el) { document.removeEventListener('keydown', _vpTextMenuKey, true); return; }
  const k = (e.key || '').toLowerCase();
  const t = el._vpBox;
  // Second level: the menu is asking a follow-up question, so the letters mean
  // what THAT question needs — s no longer means "starts here". (dev0745) There
  // are two such questions now, and they must not answer each other's keys.
  if (el._vpAsking) {
    if (k === 'escape') { e.preventDefault(); e.stopImmediatePropagation(); _vpTextMenuClose(); return; }
    if (el._vpAsking === 'alpha') {
      const i = '123456'.indexOf(k);
      if (i >= 0 && VP_TEXT_ALPHAS[i] != null) {
        e.preventDefault(); e.stopImmediatePropagation();
        _vpTextMenuClose();
        _vpTextSetAlpha(t, VP_TEXT_ALPHAS[i]);
      }
      return;
    }
    if (el._vpAsking === 'font') {
      const f = VP_TEXT_FONTS.find(x => x.key === k);
      if (f) {
        e.preventDefault(); e.stopImmediatePropagation();
        _vpTextMenuClose();
        _vpTextSetFont(t, f.id);
      }
      return;
    }
    if (el._vpAsking === 'color') {
      const c = VP_TEXT_COLORS.find(x => x.key === k);
      if (c) {
        e.preventDefault(); e.stopImmediatePropagation();
        _vpTextMenuClose();
        _vpTextSetColor(t, c.id);
      }
      return;
    }
    if (VP_TEXT_PAUSE_KEYS[k]) {
      e.preventDefault(); e.stopImmediatePropagation();
      _vpTextMenuClose();
      _vpTextSetPause(t, VP_TEXT_PAUSE_KEYS[k]);
    }
    return;
  }
  // (dev0745) On a still, s / e / a have no meaning — those rows aren't on the
  // menu — so the keys stay free rather than silently marking an invisible clip.
  const imgMode = !!(_vpState && _vpState.crop && _vpState.crop.imageMode);
  if (k === 'escape' || (!imgMode && (k === 's' || k === 'e' || k === 'a'))) {
    e.preventDefault(); e.stopImmediatePropagation();
    if (k === 'a') { _vpTextPauseAsk(el, t); return; }   // stays open, asks seconds
    _vpTextMenuClose();
    if (k === 's' || k === 'e') _vpTextSetMark(t, k === 's' ? 'start' : 'end');
  }
}

// Stamp the playhead as this caption's in- or out-point. Stored ABSOLUTE (like
// the zoom box's atSec) and turned into clip-relative seconds only at render,
// so moving A or B afterwards doesn't silently shift every caption.
function _vpTextSetMark(t, which) {
  const s = _vpState && _vpState.crop;
  if (!s || !t) return;
  const now = _vpNowSec();
  if (which === 'start') t.atStart = now; else t.atEnd = now;
  if (s.paintTextMarks) s.paintTextMarks(t);
  if (typeof toast === 'function') {
    toast('⏱ text ' + (which === 'start' ? 'starts' : 'ends') + ' at ' + now.toFixed(2) + 's', 1600);
  }
}

function _vpTextClearMarks(t) {
  const s = _vpState && _vpState.crop;
  if (!s || !t) return;
  t.atStart = null; t.atEnd = null; t.pauseSec = null;
  if (s.paintTextMarks) s.paintTextMarks(t);
  if (typeof toast === 'function') toast('⏱ cleared — this text is on for the whole clip', 1600);
}

// (dev0727) ── Pause: hold the picture while the caption is up ──────────────
// The render freezes the last frame before this caption's start, sits there for
// N seconds with the text on it, then holds the SAME frame VP_TEXT_PAUSE_TAIL
// longer with the text already gone, and only then plays on. That half second
// is the point: cutting straight from the last word back to motion reads as a
// glitch, and a beat of still picture after the words land does not.
//
// So a pause REPLACES the caption's end mark — the text ends when the pause
// does. Seconds are picked on the left hand, a s d f g = 1..5, the same row of
// keys the playhead walks on.
const VP_TEXT_PAUSE_TAIL = 0.5;
const VP_TEXT_PAUSE_KEYS = { a: 1, s: 2, d: 3, f: 4, g: 5 };

// (dev0745) ── Saved text ───────────────────────────────────────────────────
// Every caption that gets finished is banked here, most recent first, so the
// next picture can have it back off the bar's ▾ list. This is what makes the
// tool a watermarker: type your credit line once, pick it forever after.
// Kept deliberately dumb — a flat list of strings in localStorage, no naming,
// no editing. The box on the frame is still the editor.
const VP_TEXT_STORE_KEY = 'salCropTexts';
const VP_TEXT_STORE_MAX = 30;
// (dev0749) KEPT entries — the ones right-click starred. They show a `*`, they
// sort to the top, and "forget them all" leaves them alone: a credit line you
// use on every picture should not be a casualty of clearing out the clutter.
// A separate key, so the plain list stays the plain list it has always been.
const VP_TEXT_KEEP_KEY = 'salCropTextsKept';

function _vpTextReadList(key) {
  try {
    const a = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(a) ? a.filter(s => typeof s === 'string' && s.trim()) : [];
  } catch (_) { return []; }
}
function _vpTextWriteList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list.slice(0, VP_TEXT_STORE_MAX))); } catch (_) {}
}

function _vpTextKept() { return _vpTextReadList(VP_TEXT_KEEP_KEY); }
function _vpTextIsKept(s) { return _vpTextKept().indexOf(s) >= 0; }

// Kept first, then the rest in most-recent order.
function _vpTextSaved() {
  const kept = _vpTextKept();
  const rest = _vpTextReadList(VP_TEXT_STORE_KEY).filter(s => kept.indexOf(s) < 0);
  return kept.concat(rest);
}

function _vpTextRemember(str) {
  const s = String(str == null ? '' : str).trim();
  if (!s || s.length > 400) return;
  if (_vpTextIsKept(s)) return;                        // already held, and held first
  const list = _vpTextReadList(VP_TEXT_STORE_KEY).filter(x => x !== s);  // re-used floats up
  list.unshift(s);
  _vpTextWriteList(VP_TEXT_STORE_KEY, list);
}

function _vpTextToggleKeep(str) {
  const s = String(str == null ? '' : str).trim();
  if (!s) return false;
  const kept = _vpTextKept();
  const i = kept.indexOf(s);
  if (i >= 0) kept.splice(i, 1); else kept.unshift(s);
  _vpTextWriteList(VP_TEXT_KEEP_KEY, kept);
  // A kept entry lives in the keep list only, so it can't be lost to a clear-out
  // of the ordinary one; un-keeping puts it back among the ordinary ones.
  const plain = _vpTextReadList(VP_TEXT_STORE_KEY).filter(x => x !== s);
  if (i >= 0) plain.unshift(s);
  _vpTextWriteList(VP_TEXT_STORE_KEY, plain);
  return i < 0;
}

// Clears the ordinary list. Kept entries survive by construction — they are in
// the other one.
function _vpTextForgetAll() {
  try { localStorage.removeItem(VP_TEXT_STORE_KEY); } catch (_) {}
}

// ── The saved-text list ─────────────────────────────────────────────────────
// A real menu rather than a <select>, because an <option> cannot carry a
// right-click and right-click is how an entry gets kept.
const VP_TEXT_PICK_ID = 'vp-text-pick';

function _vpTextPickClose() {
  const el = document.getElementById(VP_TEXT_PICK_ID);
  if (el) el.remove();
}

function _vpTextPickMenu(x, y, onPick, onChanged) {
  _vpTextPickClose();
  const saved = _vpTextSaved();
  const el = document.createElement('div');
  el.id = VP_TEXT_PICK_ID;
  el.style.cssText =
    'position:fixed;z-index:42600;min-width:230px;max-width:min(620px,92vw);' +
    'max-height:60vh;overflow:auto;background:#000;border:2px solid #06f;' +
    'border-radius:9px;padding:5px;box-shadow:0 4px 18px rgba(0,0,0,0.75);' +
    'font:13px ui-monospace,Consolas,monospace;color:#dfe6f0;user-select:none;';

  const head = document.createElement('div');
  head.innerHTML = saved.length
    ? 'click = put it on the frame &nbsp;·&nbsp; right-click = <span style="color:#ffd24a;">keep</span>'
    : 'Nothing saved yet — finish a text box and it lands here.';
  head.style.cssText = 'padding:4px 8px 6px;color:#8ef;white-space:nowrap;';
  el.appendChild(head);

  saved.forEach(s => {
    const kept = _vpTextIsKept(s);
    const d = document.createElement('div');
    d.textContent = (kept ? '* ' : '') + s.replace(/\n/g, ' ⏎ ');
    d.title = kept ? 'Kept — right-click to release it' : 'Right-click to keep this one';
    d.style.cssText =
      'padding:5px 8px;border-radius:5px;cursor:pointer;white-space:nowrap;' +
      'overflow:hidden;text-overflow:ellipsis;' + (kept ? 'color:#ffd24a;' : '');
    d.onmouseenter = () => { d.style.background = '#12325c'; };
    d.onmouseleave = () => { d.style.background = ''; };
    d.onclick = e => { e.stopPropagation(); _vpTextPickClose(); if (onPick) onPick(s); };
    d.oncontextmenu = e => {
      e.preventDefault(); e.stopPropagation();
      const nowKept = _vpTextToggleKeep(s);
      if (onChanged) onChanged();
      if (typeof toast === 'function') {
        toast(nowKept ? '* kept — "forget them all" will leave this one alone'
                      : '· released — this one goes with the next clear-out', 2200);
      }
      _vpTextPickMenu(x, y, onPick, onChanged);   // redraw where it stood
    };
    el.appendChild(d);
  });

  if (saved.length) {
    const hr = document.createElement('div');
    hr.style.cssText = 'height:1px;margin:4px 2px;background:rgba(102,170,255,0.35);';
    el.appendChild(hr);
    const clear = document.createElement('div');
    const nPlain = saved.filter(s => !_vpTextIsKept(s)).length;
    clear.innerHTML = '<span style="opacity:0.75;">— forget them all' +
      (nPlain === saved.length ? '' : ' (the ' + (saved.length - nPlain) + ' kept stay)') + ' —</span>';
    clear.style.cssText = 'padding:5px 8px;border-radius:5px;cursor:pointer;white-space:nowrap;';
    clear.onmouseenter = () => { clear.style.background = '#12325c'; };
    clear.onmouseleave = () => { clear.style.background = ''; };
    clear.onclick = e => {
      e.stopPropagation();
      if (!nPlain) { _vpTextPickClose(); return; }
      if (!confirm('Forget ' + nPlain + ' saved text' + (nPlain === 1 ? '' : 's') + '?')) return;
      _vpTextForgetAll();
      if (onChanged) onChanged();
      _vpTextPickMenu(x, y, onPick, onChanged);
    };
    el.appendChild(clear);
  }

  document.body.appendChild(el);
  const w = el.offsetWidth || 230, h = el.offsetHeight || 120;
  el.style.left = Math.max(4, Math.min(window.innerWidth  - w - 4, x)) + 'px';
  el.style.top  = Math.max(4, Math.min(window.innerHeight - h - 4, y)) + 'px';

  const away = e2 => {
    if (el.contains(e2.target)) return;
    document.removeEventListener('pointerdown', away, true);
    _vpTextPickClose();
  };
  setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
}

function _vpEscHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// (dev0745) ── Opacity ───────────────────────────────────────────────────────
// One number per box, 0..1, dimming the letters AND their outline together
// (drawtext's `alpha`, which is why it reads as a faded stamp rather than
// ghost text in a hard black frame). Null = fully opaque = a plain caption.
const VP_TEXT_ALPHAS = [1, 0.7, 0.5, 0.35, 0.2, 0.1];

function _vpTextSetAlpha(t, a) {
  const s = _vpState && _vpState.crop;
  if (!s || !t) return;
  t.alpha = (a >= 1) ? null : a;
  if (s.paintTexts) s.paintTexts();
  if (typeof toast === 'function') {
    toast(t.alpha == null ? '◼ caption at full strength'
                          : ('◻ watermark at ' + Math.round(a * 100) + '%'), 1600);
  }
}

// Second level of the text menu, same trick the pause question uses: replace
// the rows in place so the click-away and key handlers already live keep working.
function _vpTextAlphaAsk(el, t) {
  el._vpAsking = 'alpha';
  el.innerHTML = '';
  const head = document.createElement('div');
  head.textContent = 'How strong?  (1-6)';
  head.style.cssText = 'padding:4px 8px 6px;color:#8ef;font-weight:bold;white-space:nowrap;';
  el.appendChild(head);
  VP_TEXT_ALPHAS.forEach((a, i) => {
    const pct = Math.round(a * 100);
    const cur = (t.alpha == null ? 1 : t.alpha);
    const d = document.createElement('div');
    d.innerHTML = '<u>' + (i + 1) + '</u> &nbsp;' + pct + '%' +
                  (a === 1 ? ' <span style="opacity:0.55;">(a plain caption)</span>' : '') +
                  (Math.abs(cur - a) < 0.001 ? ' <span style="color:#8ef;">·  now</span>' : '');
    d.style.cssText = 'padding:5px 8px;border-radius:5px;cursor:pointer;white-space:nowrap;';
    d.onmouseenter = () => { d.style.background = '#12325c'; };
    d.onmouseleave = () => { d.style.background = ''; };
    d.onclick = () => { _vpTextMenuClose(); _vpTextSetAlpha(t, a); };
    el.appendChild(d);
  });
  _vpTextMenuPlace(el);
}

// (dev0745) ── Motion (image mode) ───────────────────────────────────────────
// still → mp4 → gif → still. On a still the M key has nothing else to do (the
// audio switch it drives on video isn't there), so it takes this.
function _vpMotionCycle() {
  const s = _vpState && _vpState.crop;
  if (!s || !s.motion) return;
  const order = ['still', 'mp4', 'gif'];
  s.motion.format = order[(order.indexOf(s.motion.format) + 1) % order.length];
  if (s.paint) s.paint();
  if (typeof toast === 'function') {
    const msg = {
      still: '🖼 a still picture',
      mp4:   '🎬 an mp4 clip of ' + s.motion.durSec + 's — Z puts the zoom box where the move ENDS',
      gif:   '🎞 a gif of ' + s.motion.durSec + 's — smaller sizes and shorter runs keep it sane'
    }[s.motion.format];
    toast(msg, 3000);
  }
}

function _vpTextSetPause(t, secs) {
  const s = _vpState && _vpState.crop;
  if (!s || !t) return;
  if (t.atStart == null) t.atStart = _vpNowSec();   // no start yet → here
  t.pauseSec = secs;
  t.atEnd = t.atStart + secs;                       // the pause IS the end
  if (s.paintTextMarks) s.paintTextMarks(t);
  if (typeof toast === 'function') {
    toast('⏸ hold ' + secs + 's on this frame with the text, then ' +
          VP_TEXT_PAUSE_TAIL + 's more without it, then play on', 3400);
  }
}

// Keep the menu on screen wherever it was raised (and after it re-fills with
// the seconds question, which is a different height).
function _vpTextMenuPlace(el, x, y) {
  el._vpX = (x == null) ? el._vpX : x;
  el._vpY = (y == null) ? el._vpY : y;
  const w = el.offsetWidth || 210, h = el.offsetHeight || 120;
  el.style.left = Math.max(4, Math.min(window.innerWidth  - w - 4, el._vpX)) + 'px';
  el.style.top  = Math.max(4, Math.min(window.innerHeight - h - 4, el._vpY)) + 'px';
}

// Second level of the same menu: how long to hold. Replaces the rows in place
// rather than opening a second panel, so the click-away and key handlers that
// are already live keep working.
function _vpTextPauseAsk(el, t) {
  el._vpAsking = 'pause';
  el.innerHTML = '';
  const head = document.createElement('div');
  head.textContent = 'How many seconds?';
  head.style.cssText = 'padding:4px 8px 6px;color:#8ef;font-weight:bold;white-space:nowrap;';
  el.appendChild(head);
  Object.keys(VP_TEXT_PAUSE_KEYS).forEach(k => {
    const secs = VP_TEXT_PAUSE_KEYS[k];
    const d = document.createElement('div');
    d.innerHTML = '<u>' + k + '</u> &nbsp;' + secs + ' second' + (secs === 1 ? '' : 's') +
                  ' <span style="opacity:0.55;">(+ ' + VP_TEXT_PAUSE_TAIL + 's still, no text)</span>';
    d.style.cssText = 'padding:5px 8px;border-radius:5px;cursor:pointer;white-space:nowrap;';
    d.onmouseenter = () => { d.style.background = '#12325c'; };
    d.onmouseleave = () => { d.style.background = ''; };
    d.onclick = () => { _vpTextMenuClose(); _vpTextSetPause(t, secs); };
    el.appendChild(d);
  });
  _vpTextMenuPlace(el);
}

function _vpTextCtxMenu(ev) {
  const s = _vpState && _vpState.crop;
  if (!s || !s.textBoxFor) return;
  const boxEl = ev.target.closest('.vp-crop-text');
  const t = s.textBoxFor(boxEl);
  if (!t) return;
  _vpTextMenuClose();
  // Right-clicking a box that isn't being typed in has no caret to insert at,
  // so open it for editing first — the arrows then land at the end of the text.
  if (s.textBeginEdit) s.textBeginEdit(t);

  const el = document.createElement('div');
  el.id = VP_TEXT_MENU_ID;
  el._vpBox = t;
  el.style.cssText =
    'position:fixed;z-index:42600;min-width:210px;background:#000;border:2px solid #06f;' +
    'border-radius:9px;padding:5px;box-shadow:0 4px 18px rgba(0,0,0,0.75);' +
    'font:13px ui-monospace,Consolas,monospace;color:#dfe6f0;user-select:none;';
  const mk = (html, title) => {
    const d = document.createElement('div');
    d.innerHTML = html;
    if (title) d.title = title;
    d.style.cssText = 'padding:5px 8px;border-radius:5px;cursor:pointer;white-space:nowrap;';
    d.onmouseenter = () => { d.style.background = '#12325c'; };
    d.onmouseleave = () => { d.style.background = ''; };
    el.appendChild(d);
    return d;
  };
  const sep = () => {
    const h = document.createElement('div');
    h.style.cssText = 'height:1px;margin:4px 2px;background:rgba(102,170,255,0.35);';
    el.appendChild(h);
  };
  const now = _vpNowSec();

  mk('<span style="font-size:17px;">' + VP_TEXT_ARROW_DN + '</span>&nbsp; arrow down at the cursor',
     'Inserted as a character — it grows and shrinks with the type size')
    .onclick = () => { _vpTextMenuClose(); if (s.textInsertAt) s.textInsertAt(t, VP_TEXT_ARROW_DN); };
  mk('<span style="font-size:17px;">' + VP_TEXT_ARROW_UP + '</span>&nbsp; arrow up at the cursor',
     'Inserted as a character — it grows and shrinks with the type size')
    .onclick = () => { _vpTextMenuClose(); if (s.textInsertAt) s.textInsertAt(t, VP_TEXT_ARROW_UP); };
  sep();
  // (dev0745) Opacity — the row that turns a caption into a watermark. On both
  // bars: a faded credit line belongs on video as much as on a photograph.
  mk('◻ strength' + (t.alpha == null ? '' :
       ' <span style="opacity:0.6;">· now ' + Math.round(t.alpha * 100) + '%</span>'),
     'Fade the letters and their outline together — a watermark instead of a caption')
    .onclick = () => _vpTextAlphaAsk(el, t);
  // (dev0750) The typeface, on both bars for the same reason strength is: the
  // face a credit line is set in is as much a part of it as how faint it is.
  mk('<span style="font-family:' + _vpTextFontAttr(_vpTextFont(t.font)) + ';font-size:15px;">Aa</span>' +
     ' &nbsp;font <span style="opacity:0.6;">· ' + _vpEscHtml(_vpTextFont(t.font).name) + '</span>',
     'Pick the typeface — every row on that list is drawn in the font it offers')
    .onclick = () => _vpTextFontAsk(el, t);
  // (dev0753) …and the fill. It matters most on exactly the box where the
  // outline is gone: at 35% the colour is the whole of what will be visible.
  mk('<span style="display:inline-block;width:13px;height:13px;vertical-align:-2px;' +
     'border:1px solid #789;background:' + _vpTextColor(t.color).css + ';"></span>' +
     ' &nbsp;colour <span style="opacity:0.6;">· ' + _vpEscHtml(_vpTextColor(t.color).name) + '</span>',
     'White over a dark picture, black over a light one')
    .onclick = () => _vpTextColorAsk(el, t);
  // The rest of this menu is about WHEN the text is on screen, which a still
  // has no answer to. Nothing here is hidden to be tidy — every one of these
  // rows would be a lie on a photograph.
  if (!s.imageMode) {
    sep();
    mk('<u>s</u>tarts here <span style="opacity:0.6;">· ' + now.toFixed(2) + 's</span>',
       'This text appears from the playhead onward')
      .onclick = () => { _vpTextMenuClose(); _vpTextSetMark(t, 'start'); };
    mk('<u>e</u>nds here <span style="opacity:0.6;">· ' + now.toFixed(2) + 's</span>',
       'This text is gone after the playhead')
      .onclick = () => { _vpTextMenuClose(); _vpTextSetMark(t, 'end'); };
    mk('p<u>a</u>use here' + (t.pauseSec ? ' <span style="opacity:0.6;">· now ' + t.pauseSec + 's</span>' : ''),
       'Freeze the picture while this text is up, then play on without it')
      .onclick = () => _vpTextPauseAsk(el, t);
    if (t.atStart != null || t.atEnd != null || t.pauseSec) {
      mk('<span style="opacity:0.75;">✕ clear — on for the whole clip</span>')
        .onclick = () => { _vpTextMenuClose(); _vpTextClearMarks(t); };
    }
  }

  document.body.appendChild(el);
  _vpTextMenuPlace(el, ev.clientX, ev.clientY);

  // Any press outside closes it. Capture, so it beats the crop overlay's own
  // pointer handling; the box's edit session survives (see onDocDown).
  const away = e2 => {
    if (el.contains(e2.target)) return;
    document.removeEventListener('pointerdown', away, true);
    _vpTextMenuClose();
  };
  setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
  document.addEventListener('keydown', _vpTextMenuKey, true);
}

// The OUTPUT frame, in pixels, for a crop of sw × sh source pixels. Twin of the
// hoisted ow/oh in the proxy's buildFfmpegArgs — text px are derived from this,
// so the two must agree.
function _vpOutputDims(state, sw, sh) {
  const even = n => Math.max(2, Math.round(n / 2) * 2);
  const resH = +state.resHeight;
  if (!Number.isFinite(resH) || resH <= 0) return { ow: sw, oh: sh };
  return (state.aspect === 'P')
    ? { ow: resH, oh: even(sh * resH / sw) }
    : { oh: resH, ow: even(sw * resH / sh) };
}

// (dev0751) ── Making the preview and the burned-in text agree vertically ─────
//
// Two separate disagreements, both measured against ffmpeg before this changed.
//
// LINE SPACING. The boxes used a fixed line-height of 1.15. drawtext advances by
// the FONT'S OWN line height, read from its hhea table — 1.33em for every Segoe
// face, 1.41 for Arial Black, 1.22 for Impact and Verdana. Only Arial, Times and
// Georgia happen to sit near 1.15, which is why this hid for so long. CSS
// `normal` is that same hhea figure (Chrome takes ascent/descent/lineGap from
// DirectWrite, which reports the hhea values), so the two now advance together
// with no number for either side to get wrong.
const VP_TEXT_LINE_H = 'normal';

// ANCHOR. The textarea puts the top of the first LINE BOX at the top of the box,
// leaving the glyph sitting some way below it — half the line gap, plus the gap
// between the font's ascender and the actual top of the letter. drawtext has no
// such notion: it shrink-wraps, putting the top of the INK exactly at `y`.
// Verified across all ten faces and several strings — 'P', 'x' and 'Hg' at y=200
// every one of them starts its ink at row 200 — so the render always rode high
// by that gap, and at watermark sizes (a letter 30% of the frame tall) it was a
// tenth of the picture out.
//
// So: measure where the ink actually starts inside the box, and hand the proxy a
// `y` already shifted down by it. Nothing on the proxy side has to know — its
// shrink-wrap then lands the ink exactly where the overlay drew it.
//
//   baseline  — straight out of layout: an empty inline-block sits ON the
//               baseline, so its top edge IS the baseline. Measured rather than
//               derived from half-leading, so Chrome's own metric choices are
//               already in the answer.
//   ink       — canvas actualBoundingBoxAscent: baseline to the top of the ink,
//               for THIS string. Same outlines FreeType rasterises, so the two
//               engines agree about where a 'P' begins.
//
// The lowest ink on the block wins, because that is what drawtext wraps to; a
// blank first line has no ink and must not be allowed to claim the anchor.
// Returns 0 (= the old behaviour) on anything it cannot measure.
function _vpTextInkTop(lines, fontPx, cssFont) {
  const css = cssFont || VP_TEXT_FONT;
  const size = Math.max(4, fontPx);
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;left:-99999px;top:0;visibility:hidden;pointer-events:none;' +
    'margin:0;padding:0;border:0;white-space:pre-wrap;' +
    'line-height:' + VP_TEXT_LINE_H + ';font-family:' + css + ';font-size:' + size + 'px;';
  probe.textContent = 'Hg';
  const anchor = document.createElement('span');
  anchor.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;';
  probe.appendChild(anchor);
  document.body.appendChild(probe);
  let baseline, lineH;
  try {
    const r = probe.getBoundingClientRect();
    baseline = anchor.getBoundingClientRect().top - r.top;
    lineH = r.height;
  } finally { probe.remove(); }
  if (!(lineH > 0)) return 0;

  const cv = _vpTextInkTop._cv || (_vpTextInkTop._cv = document.createElement('canvas'));
  const ctx = cv.getContext('2d');
  if (!ctx) return 0;
  ctx.font = size + 'px ' + css;
  let best = null;
  (lines || []).forEach((ln, i) => {
    if (!ln || !ln.trim()) return;
    let asc;
    try { asc = ctx.measureText(ln).actualBoundingBoxAscent; } catch (_) { return; }
    if (!Number.isFinite(asc)) return;            // pre-Chrome-77 → leave it alone
    const top = i * lineH + baseline - asc;
    if (best === null || top < best) best = top;
  });
  return (best === null || !Number.isFinite(best)) ? 0 : best;
}

// Wrap `text` the way the browser would in a box `widthPx` wide at `fontPx`,
// and return the visual lines. Done with a real hidden element and per-character
// rects rather than a canvas measureText loop, so it reproduces the browser's
// own line breaking exactly — including hard newlines, which are kept by
// splitting into paragraphs first (an empty paragraph is an empty line, and a
// character loop alone would silently drop it).
// (dev0750) cssFont — the box's own face. Measuring every box in the default
// one would hand ffmpeg the wrong line breaks for any box that isn't in it.
function _vpTextWrapLines(text, widthPx, fontPx, cssFont) {
  const mirror = document.createElement('div');
  mirror.style.cssText =
    'position:fixed;left:-99999px;top:0;visibility:hidden;pointer-events:none;' +
    'margin:0;padding:0;border:0;white-space:pre-wrap;overflow-wrap:break-word;' +
    'line-height:' + VP_TEXT_LINE_H + ';font-family:' + (cssFont || VP_TEXT_FONT) + ';' +
    'width:' + Math.max(8, widthPx) + 'px;font-size:' + Math.max(4, fontPx) + 'px;';
  document.body.appendChild(mirror);
  const out = [];
  try {
    const rng = document.createRange();
    String(text == null ? '' : text).split('\n').forEach(para => {
      if (!para.length) { out.push(''); return; }
      mirror.textContent = para;
      const node = mirror.firstChild;
      let cur = '', top = null;
      for (let i = 0; i < para.length; i++) {
        rng.setStart(node, i); rng.setEnd(node, i + 1);
        const t = Math.round(rng.getBoundingClientRect().top);
        if (top === null) top = t;
        if (t - top > 1) { out.push(cur.replace(/\s+$/, '')); cur = ''; top = t; }
        cur += para[i];
      }
      out.push(cur.replace(/\s+$/, ''));
    });
  } finally { mirror.remove(); }
  return out;
}

// The `texts` payload for a render: every non-empty box, wrapped at the size it
// will actually be drawn (so a line that fits here fits there), in crop
// fractions. Empty boxes are dropped rather than sent as blank drawtexts.
//
// (dev0725) startSec/endSec are the clip's own A→B bounds. Per-box marks are
// stored ABSOLUTE and become clip-relative here, because the output starts at 0
// — verified: with `-ss` before `-i`, drawtext's `t` counts from the trim, not
// from the source. Marks outside the clip clamp to its ends; a backwards pair
// is read as the window the user meant and swapped.
function _vpTextRenderList(state, ow, oh, startSec, endSec) {
  if (!state || !Array.isArray(state.texts) || !state.texts.length) {
    return { texts: [], pauses: [] };
  }
  const dur = Math.max(0, (+endSec || 0) - (+startSec || 0));
  const rel = v => Math.max(0, Math.min(dur, v - startSec));

  // (dev0727) The freezes come first, because they bend the timeline everything
  // else is measured against. A pause at `at` makes the output `hold` seconds
  // longer from that point on, so any later time slides by that much — map()
  // is that shift, and every from/to below is expressed in OUTPUT seconds
  // because that is the clock ffmpeg's enable= is read against.
  //
  // The freeze point is nudged off the very ends of the clip: trim=end=0 is an
  // empty segment, and concat refuses to take one.
  const EDGE = 0.05;
  const pauses = [];
  state.texts.forEach(t => {
    if (!t.pauseSec) return;
    const raw = (t.ta ? t.ta.value : t.text) || '';
    if (!raw.trim()) return;                       // an empty box renders nothing to hold for
    const at = Math.max(EDGE, Math.min(Math.max(EDGE, dur - EDGE),
                        rel(t.atStart == null ? startSec : t.atStart)));
    const hold = t.pauseSec + VP_TEXT_PAUSE_TAIL;
    pauses.push({ at: +at.toFixed(3), hold: +hold.toFixed(3), _t: t });
  });
  pauses.sort((p, q) => p.at - q.at);
  const map = x => {
    let out = x;
    pauses.forEach(p => { if (p.at < x) out += p.hold; });
    return out;
  };

  const out = [];
  state.texts.forEach(t => {
    const raw = (t.ta ? t.ta.value : t.text) || '';
    if (!raw.trim()) return;
    const face = _vpTextFont(t.font);
    // The size ffmpeg will actually draw at — buildDrawtextChain rounds the same
    // way, so the wrap, the ink measurement and the burned-in glyphs are all one
    // number rather than three that nearly agree.
    const fontPx = Math.max(6, Math.round(t.size * oh));
    const lines = _vpTextWrapLines(raw, t.w * ow * VP_TEXT_WRAP_SAFETY, fontPx, face.css);
    if (!lines.some(l => l.trim())) return;
    // (dev0751) drawtext anchors the top of the ink; the overlay anchors the top
    // of the line box. Send the y where the ink IS, not where the box starts.
    const inkY = t.y + _vpTextInkTop(lines, fontPx, face.css) / oh;
    const box = { x: t.x, y: Math.max(0, Math.min(1, inkY)),
                  w: t.w, size: t.size, lines: lines.slice(0, 40) };
    // (dev0745) Only sent when it isn't 1 — an older proxy then behaves exactly
    // as it always did for every ordinary caption.
    if (t.alpha != null && t.alpha < 1) box.alpha = +(+t.alpha).toFixed(3);
    // (dev0750) …and the same for the face: absent means the default one, which
    // is what every box was before this existed.
    if (face.id !== VP_TEXT_FONT_DEF) box.font = face.id;
    // (dev0753) …and the fill. Same rule: white is what every caption was, so it
    // travels as an absence.
    const col = _vpTextColor(t.color);
    if (col.id !== VP_TEXT_COLOR_DEF) box.color = col.id;
    const mine = pauses.find(p => p._t === t);
    if (mine) {
      // On for the freeze, off for its tail. map(at) is where the freeze STARTS
      // in the output (its own hold isn't counted — `p.at < x` is strict).
      box.from = +map(mine.at).toFixed(3);
      box.to   = +(map(mine.at) + t.pauseSec).toFixed(3);
    } else {
      let from = (t.atStart == null) ? null : map(rel(t.atStart));
      let to   = (t.atEnd   == null) ? null : map(rel(t.atEnd));
      if (from != null && to != null && to < from) { const s0 = from; from = to; to = s0; }
      const outDur = map(dur);
      if (from != null && from > 0)      box.from = +from.toFixed(3);
      if (to   != null && to   < outDur) box.to   = +to.toFixed(3);
    }
    out.push(box);
  });
  return { texts: out, pauses: pauses.map(p => ({ at: p.at, hold: p.hold })) };
}

// (dev0744) `opts.image` mounts the SAME overlay over a slideshow still. Only
// three things differ, and none of them are geometry: the source of the pixel
// dimensions (an adapter over the <img> — see _vpImgAdapter), the controls that
// have nothing to say about a still (CRF, Slow, audio, zoom, text), and what
// the Crop button spawns. Everything else — the rect, the aspect lock, the
// tilt, the thirds grid, the enlargement warning — is shared code, because a
// crop rect over a picture is a crop rect over a picture.
function _vpMountCropOverlay(host, vid, row, opts) {
  const imageMode = !!(opts && opts.image);
  if (!row || !(imageMode ? row._directImageFile : row._directVideoFile)) return;

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
  // (dev0719) min-height + wrap, not a fixed 30px: the audio chip pushed the
  // row past a narrow window's 96% cap, and a clipped Crop button is worse than
  // a two-line bar. paint() reads the real height back when placing it.
  bar.style.cssText =
    'position:absolute;transform:translateX(-50%);min-height:30px;' +
    'display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:2px 8px;max-width:96%;white-space:nowrap;' +
    'background:rgba(0,0,0,0.7);color:#dfe6f0;font:12px ui-monospace,Consolas,monospace;' +
    'border-radius:4px;pointer-events:auto;z-index:2;';
  bar.innerHTML =
    '<span id="vp-crop-aspect" style="cursor:pointer;user-select:none;padding:2px 6px;background:#234;border-radius:3px;">16:9</span>' +
    '<span id="vp-crop-crf-lbl" style="opacity:0.7;">CRF</span>' +
    '<input id="vp-crop-crf" type="range" min="0" max="28" value="18" style="width:90px;vertical-align:middle;">' +
    '<span id="vp-crop-crf-val" style="min-width:18px;text-align:right;">18</span>' +
    '<select id="vp-crop-res" title="Output short side. The W×H label turns amber when the crop rect is smaller than this — ffmpeg would enlarge pixels rather than add detail." ' +
      'style="background:#1a1a2e;color:#dfe6f0;border:1px solid #456;border-radius:3px;padding:2px 4px;font:12px ui-monospace,Consolas,monospace;">' +
      '<option value="2160">2160p (4K)</option>' +
      '<option value="1440">1440p (2K)</option>' +
      '<option value="1080">1080p</option>' +
      '<option value="720">720p</option>' +
      '<option value="source">Same</option>' +
    '</select>' +
    // (dev0719) Output-audio switch. This is about the RENDERED clip, not the
    // player: the crop path re-encodes video and stream-copies audio, and most
    // of these clips are wanted silent, so the default is OFF. M toggles it
    // while the overlay is open (the player's own mute stays on the V toolbar).
    '<span id="vp-crop-audio" title="Does the saved clip keep its soundtrack? (M) — the player&#39;s own mute is the toolbar 🔇" ' +
      'style="cursor:pointer;user-select:none;padding:2px 6px;background:#234;border-radius:3px;">🔇 no audio</span>' +
    '<span id="vp-crop-rot" title="Drag ↕ to straighten · wheel ±0.1° · double-click reset" ' +
      'style="cursor:ns-resize;user-select:none;padding:2px 6px;background:#234;border-radius:3px;">⟲ 0.0°</span>' +
    '<label id="vp-crop-slow-lbl" style="display:flex;align-items:center;gap:3px;cursor:pointer;user-select:none;opacity:0.85;">' +
      '<input id="vp-crop-slow" type="checkbox" style="margin:0;vertical-align:middle;">Slow</label>' +
    // (dev0745) Saved text — every caption you finish typing is remembered, and
    // this puts it back on the next picture. Lives on both bars: a watermark is
    // exactly the text you want to type once and never again.
    // (dev0749) A chip, not a <select>: an <option> cannot be right-clicked,
    // and right-click is what keeps an entry (see _vpTextPickMenu).
    '<span id="vp-crop-textpick" title="Text you have used before — click to pick one · right-click an entry to keep it (E types a fresh one)" ' +
      'style="cursor:pointer;user-select:none;padding:2px 6px;background:#234;border-radius:3px;">▾ saved text</span>' +
    // (dev0745) Image mode only: still, or a Ken Burns clip out as mp4 / gif.
    '<span id="vp-crop-motion" title="Still picture · or a moving clip from the zoom box (M)" ' +
      'style="display:none;cursor:pointer;user-select:none;padding:2px 6px;background:#234;border-radius:3px;">🖼 still</span>' +
    '<select id="vp-crop-dur" title="How long the clip runs" ' +
      'style="display:none;background:#1a1a2e;color:#dfe6f0;border:1px solid #456;border-radius:3px;padding:2px 4px;font:12px ui-monospace,Consolas,monospace;">' +
      '<option value="2">2s</option><option value="3" selected>3s</option><option value="4">4s</option>' +
      '<option value="5">5s</option><option value="8">8s</option><option value="10">10s</option></select>' +
    // (dev0744) Image mode only: which of the two engines this save will use.
    // Hidden for video, where there is only ever one.
    '<span id="vp-crop-engine" title="Lossless = jpegtran copies the JPEG blocks across untouched. ' +
      'A tilt, a caption, a resolution change or a clip cannot be done that way — those switch it to a re-encode." ' +
      'style="display:none;padding:2px 6px;border-radius:3px;background:#234;">–</span>' +
    '<button id="vp-crop-do" style="margin-left:auto;background:#2a5d9a;border:1px solid #6af;color:#fff;' +
      'padding:3px 10px;border-radius:3px;cursor:pointer;font:12px ui-monospace,Consolas,monospace;min-width:80px;">Crop</button>' +
    '<button id="vp-crop-close" style="background:#1a1a2e;border:1px solid #888;color:#ccc;' +
      'padding:3px 8px;border-radius:3px;cursor:pointer;font:12px ui-monospace,Consolas,monospace;">✕</button>';
  c.appendChild(bar);   // (dev0318) bar lives on the container, not the (tiltable) rect

  // (dev0744) A still has no bitrate, no encoder preset and no soundtrack, so
  // those controls come off the bar rather than sit there meaning nothing. The
  // engine chip takes their place.
  if (imageMode) {
    ['vp-crop-crf-lbl', 'vp-crop-crf', 'vp-crop-crf-val',
     'vp-crop-audio', 'vp-crop-slow-lbl'].forEach(id => {
      const el = bar.querySelector('#' + id);
      if (el) el.style.display = 'none';
    });
    const eng = bar.querySelector('#vp-crop-engine');
    if (eng) eng.style.display = '';
    const mo = bar.querySelector('#vp-crop-motion');
    if (mo) mo.style.display = '';
    // The container is click-through for video so the native <video> controls
    // underneath stay reachable. A still has no controls to protect, and it
    // does have a slideshow underneath whose swipe / pinch / wheel / hold-zoom
    // handlers would otherwise move the picture out from under the rect. So
    // here the container takes the pointer and keeps it: its own children
    // (rect, handles, bar) still work, and nothing reaches the show.
    c.style.pointerEvents = 'auto';
    ['pointerdown', 'pointermove', 'pointerup', 'pointercancel',
     'wheel', 'click', 'dblclick'].forEach(ev => {
      c.addEventListener(ev, e => e.stopPropagation());
    });
    // (dev0750) contextmenu is the one that also needs preventDefault. Stopping
    // it only kept it from the slideshow — nothing above was cancelling it, so
    // the browser's own menu opened over the tool. Text boxes swallow it first
    // and show their menu (see addText); this covers the rect, the handles and
    // the bar, where a native menu is never what was meant.
    c.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); });
  }

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

  // (dev0720) ── Ken Burns box ──────────────────────────────────────────────
  // The END of the zoom, drawn INSIDE the crop window: the render starts on the
  // full crop at A, glides in until this box fills the frame, and holds there
  // to B. A child of `rect`, so it inherits the tilt for free and its geometry
  // stays in fractions OF THE CROP — resize or re-aspect the crop and the move
  // still means the same thing. Sized in %, so paint() never has to touch it.
  const kenBox = document.createElement('div');
  kenBox.style.cssText =
    'position:absolute;box-sizing:border-box;border:2px dashed #ffd24a;' +
    'background:rgba(255,210,74,0.05);cursor:move;pointer-events:auto;display:none;';
  rect.appendChild(kenBox);
  const kenLbl = document.createElement('div');
  kenLbl.style.cssText =
    'position:absolute;left:50%;bottom:3px;transform:translateX(-50%);' +
    'background:rgba(0,0,0,0.62);color:#ffd24a;padding:1px 6px;border-radius:3px;' +
    'font:11px ui-monospace,Consolas,monospace;pointer-events:none;white-space:nowrap;';
  kenBox.appendChild(kenLbl);
  const kenHandles = {};
  const KHSZ = 12;
  ['nw','ne','sw','se'].forEach(pos => {
    const h = document.createElement('div');
    h.style.cssText =
      'position:absolute;width:' + KHSZ + 'px;height:' + KHSZ + 'px;' +
      'background:#ffd24a;border:1px solid #402;pointer-events:auto;' +
      'cursor:' + pos + '-resize;';
    if (pos.includes('n')) h.style.top    = (-KHSZ/2) + 'px';
    if (pos.includes('s')) h.style.bottom = (-KHSZ/2) + 'px';
    if (pos.includes('w')) h.style.left   = (-KHSZ/2) + 'px';
    if (pos.includes('e')) h.style.right  = (-KHSZ/2) + 'px';
    kenBox.appendChild(h);
    kenHandles[pos] = h;
  });

  // (dev0724) ── Text layer ────────────────────────────────────────────────
  // A child of `rect` like the zoom box, so the boxes tilt with the crop —
  // which is right, because the render straightens the picture and leaves the
  // caption level, and a tilted preview is the only honest way to show that.
  const textLayer = document.createElement('div');
  textLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
  rect.appendChild(textLayer);

  const state = {
    imageMode,                        // (dev0744) still, not clip
    // (dev0745) Image mode only: 'still' | 'mp4' | 'gif'. Anything but 'still'
    // turns the picture into a clip of durSec seconds — the zoom box (Z) is
    // what makes it move, and without one it is simply held.
    motion: { format: 'still', durSec: 3 },
    aspect: 'L', crf: 18, slow: false, resHeight: 1080, angle: 0,
    audio: false,                     // (dev0719) rendered clip is silent unless asked
    texts: [],                        // (dev0724) burned-in captions, see addText
    // (dev0720) `on` = armed; frac is inside the CROP rect (fw === fh, since a
    // same-aspect box inside a box has equal fractions on both axes); atSec is
    // the playhead when the box was last placed — where the zoom finishes.
    ken: { on: false, frac: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }, atSec: 0 },
    frac: _vpCropFracForAspect('L', vid),
    el: { container: c, rect, bar, handles, knob, grid, kenBox, textLayer }
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
    // (dev0719) Measured height, so a wrapped two-line bar clears the rect's top
    // edge instead of sitting on it.
    const bh = bar.offsetHeight || 30;
    bar.style.top  = (rt < bh + 10 ? (rt + 4) : (rt - bh - 4)) + 'px';
    // (dev0293/dev0318) W×H label in source px (what ffmpeg crops) plus the tilt
    // angle. Counter-rotate so the text stays upright; turn amber when a tilted
    // corner leaves the source frame (ffmpeg will black-fill that wedge on save).
    if (r.VW > 0 && r.VH > 0) {
      const even = n => Math.max(2, Math.floor(n / 2) * 2);
      const sw = even(state.frac.w * r.VW);
      const sh = even(state.frac.h * r.VH);
      // (dev0717) Second amber trigger: the rect is smaller than the chosen
      // output resolution, so the proxy's scale filter would ENLARGE it — no
      // new detail, just bigger pixels and a fatter file. Live while dragging
      // so the rect can be grown before committing to an encode.
      const up = _vpCropUpscaleFactor(state, sw, sh);
      const upTxt = (up > 1.005) ? ('  ·  ⚠ ' + up.toFixed(2) + '× enlarged') : '';
      dimLbl.textContent = sw + ' × ' + sh +
        (state.angle ? ('  ·  ' + state.angle.toFixed(1) + '°') : '') + upTxt;
      dimLbl.style.transform = 'translateX(-50%) rotate(' + (-state.angle) + 'deg)';
      dimLbl.style.color =
        (upTxt || (state.angle && _vpCropTiltOOB(state, r.VW, r.VH))) ? '#fb3' : '#dfe6f0';
    }
    updateAngleUI();
    paintEngine();     // (dev0744) tilt or res may have just cost us lossless
    paintKen();
    paintTexts();
  }

  // (dev0744) Say which engine the next save will use, and why. Repainted from
  // paint(), so tilting the rect or changing the resolution flips it live —
  // the point being that the cost of losing lossless is visible BEFORE the
  // render, not discovered in the filename afterwards.
  function paintEngine() {
    if (!imageMode) return;
    const chip = bar.querySelector('#vp-crop-engine');
    if (chip) {
      const v = _vpImgLossless(state, row);
      chip.textContent = v.ok ? '⧉ lossless' : ('↻ re-encode · ' + v.why);
      chip.style.background = v.ok ? '#1d5c3a' : '#5c4a1d';
      chip.style.color = '#eaf3ea';
    }
    // (dev0745) The motion chip and its duration, which only exists once the
    // picture is going to move.
    const mo = bar.querySelector('#vp-crop-motion');
    const du = bar.querySelector('#vp-crop-dur');
    const isStill = state.motion.format === 'still';
    if (mo) {
      mo.textContent = isStill ? '🖼 still'
                     : (state.motion.format === 'gif' ? '🎞 gif' : '🎬 mp4');
      mo.style.background = isStill ? '#234' : '#2a5d9a';
      mo.style.color      = isStill ? '#dfe6f0' : '#fff';
    }
    if (du) du.style.display = isStill ? 'none' : '';
  }

  // (dev0720) Place + label the Ken Burns box. Geometry is in % of `rect`, so
  // this only has to run when the box itself changes — or when the tilt does,
  // since the label counter-rotates to stay upright (same trick as dimLbl).
  function paintKen() {
    const k = state.ken;
    kenBox.style.display = k.on ? '' : 'none';
    if (!k.on) return;
    kenBox.style.left   = (k.frac.x * 100) + '%';
    kenBox.style.top    = (k.frac.y * 100) + '%';
    kenBox.style.width  = (k.frac.w * 100) + '%';
    kenBox.style.height = (k.frac.h * 100) + '%';
    // (dev0745) A still has no playhead for the move to land on — it lands at
    // the end of the clip, so the label says the zoom and leaves time out of it.
    kenLbl.textContent = imageMode
      ? ('🎬 ' + (1 / k.frac.w).toFixed(2) + '× · the move ends here')
      : ('🎬 ' + (1 / k.frac.w).toFixed(2) + '× · lands ' + k.atSec.toFixed(1) + 's');
    kenLbl.style.transform = 'translateX(-50%) rotate(' + (-state.angle) + 'deg)';
  }

  // (dev0724) ── Text boxes ──────────────────────────────────────────────────
  // One box = one drawtext at render. The <textarea> is the preview AND the
  // editor: it wraps exactly as the burned-in text will, and it makes core.js's
  // "is a field focused?" test true, so every global letter hotkey stands down
  // while it has focus without a single extra guard.
  let editing = null;              // the box currently taking keystrokes

  function paintTexts() {
    const r = _vpCropRenderRect(host, vid);
    const rectH = Math.max(1, state.frac.h * r.rh);
    state.texts.forEach(t => {
      t.el.style.left  = (t.x * 100) + '%';
      t.el.style.top   = (t.y * 100) + '%';
      t.el.style.width = (t.w * 100) + '%';
      t.ta.style.fontSize = Math.max(5, t.size * rectH) + 'px';
      // (dev0745) Show the opacity, don't just record it — a watermark you
      // cannot see here is a watermark you cannot place.
      t.ta.style.opacity = (t.alpha == null) ? '' : String(t.alpha);
      // (dev0752) …and show that a faded box loses its outline, since that is
      // what the render does. Set to the literal shadow rather than '' — the
      // original came in through cssText, so clearing the property would drop it
      // for good and an opaque caption would never get it back.
      // (dev0753) The fill, and an outline that opposes it.
      const col = _vpTextColor(t.color);
      t.ta.style.color = col.css;
      t.ta.style.textShadow =
        (t.alpha != null && t.alpha < 1) ? 'none' : _vpTextShadow(col.shadow);
      // (dev0750) Same for the face — it is what the box wraps at, so it has to
      // be on screen before the render, not discovered in the file afterwards.
      t.ta.style.fontFamily = _vpTextFont(t.font).css;
      growText(t);
    });
    syncTextWindow();
  }

  // The box hugs its text, so the dashed outline shows the real footprint.
  function growText(t) {
    t.ta.style.height = 'auto';
    t.ta.style.height = Math.max(8, t.ta.scrollHeight) + 'px';
  }

  function updateChip(t) {
    t.chip.textContent = '↑↓ type size · ' + (t.size * 100).toFixed(1) + '% of frame';
  }

  // (dev0725) The amber ⏱ badge under a box that isn't on for the whole clip.
  // Absolute seconds, the same units the timeline shows, so it reads against
  // the playhead; the render turns them into clip-relative enable= times.
  function paintTextMarks(t) {
    const a = t.atStart, b = t.atEnd;
    if (a == null && b == null) { t.tlbl.style.display = 'none'; }
    else {
      t.tlbl.style.display = '';
      t.tlbl.textContent = t.pauseSec
        ? ('⏸ ' + a.toFixed(2) + 's · hold ' + t.pauseSec + 's + ' + VP_TEXT_PAUSE_TAIL + 's')
        : ('⏱ ' + (a == null ? 'clip start' : a.toFixed(2) + 's') +
           ' → ' + (b == null ? 'clip end' : b.toFixed(2) + 's'));
    }
    syncTextWindow();
  }

  // (dev0726) A windowed caption is on screen ONLY between its marks — here as
  // well as in the file. Without this the overlay showed every box at every
  // moment and the window was invisible until the render was already written.
  //
  // `visibility`, not `display`: the box keeps its layout, so growText's
  // scrollHeight still measures, and hidden children can't be clicked either
  // (visibility is inherited, pointer-events:none on the wrapper is not — the
  // grips and ✕ set their own). The box being TYPED IN is always shown; you
  // can't edit what isn't on screen, and the playhead doesn't move while typing.
  function syncTextWindow(now) {
    const t0 = (now == null) ? _vpNowSec() : now;
    state.texts.forEach(t => {
      const on = (editing === t)
              || ((t.atStart == null || t0 >= t.atStart - 0.001)
               && (t.atEnd   == null || t0 <= t.atEnd   + 0.001));
      t.el.style.visibility = on ? '' : 'hidden';
    });
  }

  function textBoxFor(el) {
    return state.texts.find(t => t.el === el) || null;
  }

  // Drop a character at the caret (right-click menu arrows). The box is always
  // in edit mode by the time this runs, so selectionStart is real.
  function textInsertAt(t, str) {
    const ta = t.ta;
    const i = (typeof ta.selectionStart === 'number') ? ta.selectionStart : ta.value.length;
    const j = (typeof ta.selectionEnd   === 'number') ? ta.selectionEnd   : i;
    ta.value = ta.value.slice(0, i) + str + ta.value.slice(j);
    t.text = ta.value;
    growText(t);
    try { ta.focus({ preventScroll: true }); } catch (_) {}
    const caret = i + str.length;
    try { ta.setSelectionRange(caret, caret); } catch (_) {}
  }

  // opts.silent — build the box but don't open it for typing (the .edit loader
  // restores several at once and opens none of them).
  function addText(opts) {
    opts = opts || {};
    if (state.texts.length >= 12) {
      if (typeof toast === 'function') toast('12 text boxes is the limit', 1800);
      return null;
    }
    const n = state.texts.length;
    // (dev0725) atStart / atEnd — absolute seconds this caption comes and goes,
    // set from the right-click menu. Null = on for the whole clip.
    // (dev0750) `font` — the face this box is set in, id from VP_TEXT_FONTS. A
    // new box opens in whichever one was picked last.
    // (dev0753) `color` — id from VP_TEXT_COLORS, and like the font it opens in
    // whichever one was picked last.
    const t = { x: Math.min(0.60, 0.06 + 0.03 * n), y: Math.min(0.76, 0.06 + 0.11 * n),
                w: 0.55, size: 0.07, text: '', atStart: null, atEnd: null, pauseSec: null,
                font: _vpTextFontDefault(), color: _vpTextColorDefault() };

    const box = document.createElement('div');
    box.className = 'vp-crop-text';
    box.style.cssText =
      'position:absolute;box-sizing:border-box;pointer-events:auto;cursor:move;' +
      'border:1px dashed rgba(120,230,170,0.85);background:rgba(0,0,0,0.10);';

    const ta = document.createElement('textarea');
    ta.className = 'vp-crop-text-input';       // vpKeyHandler's gate — keep in sync
    ta.spellcheck = false;
    ta.readOnly = true;
    ta.rows = 1;
    ta.placeholder = 'type…';
    ta.style.cssText =
      'display:block;box-sizing:border-box;width:100%;margin:0;padding:0;border:0;outline:0;' +
      'background:transparent;resize:none;overflow:hidden;pointer-events:none;' +
      'color:' + _vpTextColor(t.color).css + ';caret-color:#9f9;' +
      'font-family:' + _vpTextFont(t.font).css + ';line-height:' + VP_TEXT_LINE_H + ';' +
      'white-space:pre-wrap;overflow-wrap:break-word;' +
      'text-shadow:' + _vpTextShadow(_vpTextColor(t.color).shadow) + ';';
    ta.addEventListener('input', () => { t.text = ta.value; growText(t); });
    box.appendChild(ta);

    // Side grips set the WRAP width — the one thing the arrows can't do.
    ['l', 'r'].forEach(side => {
      const h = document.createElement('div');
      h.style.cssText =
        'position:absolute;top:0;bottom:0;width:9px;cursor:ew-resize;pointer-events:auto;' +
        'background:rgba(120,230,170,0.28);' + (side === 'l' ? 'left:-5px;' : 'right:-5px;');
      h.addEventListener('pointerdown', e => textStart('tw', side, e, h, t));
      box.appendChild(h);
    });

    const del = document.createElement('div');
    del.textContent = '✕';
    del.title = 'Remove this text box';
    del.style.cssText =
      'position:absolute;top:-10px;right:-10px;width:18px;height:18px;border-radius:50%;' +
      'background:#1a1a2e;color:#f9c;border:1px solid #a67;text-align:center;' +
      'font:11px/16px ui-monospace,Consolas,monospace;cursor:pointer;pointer-events:auto;';
    del.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); });
    del.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); removeText(t); });
    box.appendChild(del);

    const chip = document.createElement('div');
    chip.style.cssText =
      'position:absolute;left:0;top:-17px;background:rgba(0,0,0,0.62);color:#9fb;' +
      'padding:0 5px;border-radius:3px;font:10px ui-monospace,Consolas,monospace;' +
      'pointer-events:none;white-space:nowrap;display:none;';
    box.appendChild(chip);

    // (dev0725) The ⏱ window badge — only there when the caption isn't on for
    // the whole clip. Sits under the box so it can't be mistaken for the text.
    const tlbl = document.createElement('div');
    tlbl.style.cssText =
      'position:absolute;left:0;bottom:-17px;background:rgba(0,0,0,0.62);color:#ffd24a;' +
      'padding:0 5px;border-radius:3px;font:10px ui-monospace,Consolas,monospace;' +
      'pointer-events:none;white-space:nowrap;display:none;';
    box.appendChild(tlbl);

    // A press that doesn't travel is a click = start typing; one that does is a
    // move. Same gesture the zoom box uses, one meaning further.
    box.addEventListener('pointerdown', e => {
      if (editing === t) return;                          // typing — the field owns it
      if (e.target !== box && e.target !== ta) return;     // grips and ✕ have their own
      textStart('tmove', null, e, box, t);
    });

    // (dev0750) The box's own right-click menu, wired HERE rather than on the V
    // screen's content element, where dev0725 put it. A STILL's crop overlay is
    // mounted over the slideshow's <img> — nowhere inside V — so that listener
    // never saw the event, nothing called preventDefault, and right-clicking a
    // caption on a picture raised the browser's native menu instead of ours.
    // On the box it works in both modes; stopping the event is what keeps V's
    // step panel out of the way, since inside a box the click is about the text.
    box.addEventListener('contextmenu', e => {
      e.preventDefault(); e.stopPropagation();
      if (window._vpFSB) {                                // V's step panel stands down
        try { window._vpFSB.cleanup(); } catch (_) {}
        window._vpFSB = null;
      }
      _vpTextCtxMenu(e);
    });

    t.el = box; t.ta = ta; t.chip = chip; t.tlbl = tlbl;
    textLayer.appendChild(box);
    state.texts.push(t);
    paintTexts();
    if (!opts.silent) beginEdit(t);
    return t;
  }

  function removeText(t) {
    if (editing === t) {
      editing = null;
      document.removeEventListener('pointerdown', onDocDown, true);
    }
    const i = state.texts.indexOf(t);
    if (i >= 0) state.texts.splice(i, 1);
    if (t.el && t.el.parentNode) t.el.parentNode.removeChild(t.el);
    paintEngine();   // (dev0745) the last caption leaving can restore lossless
  }

  function beginEdit(t) {
    if (editing === t) return;      // (dev0725) right-click re-entry — already live
    if (editing) endEdit();
    editing = t;
    t.el.style.borderColor = 'rgba(150,255,200,1)';
    t.el.style.background  = 'rgba(0,0,0,0.30)';
    t.ta.readOnly = false;
    t.ta.style.pointerEvents = 'auto';
    t.chip.style.display = '';
    updateChip(t);
    try { t.ta.focus({ preventScroll: true }); } catch (_) { try { t.ta.focus(); } catch (__) {} }
    const n = t.ta.value.length;
    try { t.ta.setSelectionRange(n, n); } catch (_) {}
    document.addEventListener('pointerdown', onDocDown, true);
    syncTextWindow();               // (dev0726) the box being typed in is always shown
    if (typeof toast === 'function') {
      toast('✎ typing — ↑ ↓ resize the type · click outside when done', 2200);
    }
  }

  function endEdit() {
    const t = editing;
    if (!t) return;
    editing = null;
    document.removeEventListener('pointerdown', onDocDown, true);
    t.ta.readOnly = true;
    t.ta.style.pointerEvents = 'none';
    t.el.style.borderColor = 'rgba(120,230,170,0.85)';
    t.el.style.background  = 'rgba(0,0,0,0.10)';
    t.chip.style.display = 'none';
    try { t.ta.blur(); } catch (_) {}
    t.text = t.ta.value;
    if (!t.text.trim()) removeText(t);   // an empty box is an abandoned one
    else {
      syncTextWindow();                  // (dev0726) …and it hides again if off-window
      // (dev0745) Finishing a caption is what banks it. Typing is the only way
      // text gets here, so the list can only ever hold things the user wrote.
      _vpTextRemember(t.text);
      paintTextPick();
    }
    paintEngine();   // text present ⇒ no longer a lossless save
  }

  // The first click OUTSIDE the box ends the entry and is swallowed, so it can't
  // also start a crop drag — or land on the backdrop, where V's own click
  // handler would close the player.
  function onDocDown(e) {
    if (!editing) return;
    if (editing.el.contains(e.target)) return;
    // (dev0725) …but the box's own right-click menu is body-mounted, so it is
    // "outside" the box while being entirely about it. Clicking it must not end
    // the entry, or the arrow would land in a box that just lost its caret.
    if (e.target && e.target.closest && e.target.closest('#' + VP_TEXT_MENU_ID)) return;
    e.preventDefault(); e.stopPropagation();
    endEdit();
  }

  function nudgeSize(dir) {
    const t = editing || state.texts[state.texts.length - 1];
    if (!t) return;
    t.size = Math.max(VP_TEXT_MIN_SIZE,
             Math.min(VP_TEXT_MAX_SIZE, +(t.size + dir * VP_TEXT_STEP).toFixed(4)));
    updateChip(t);
    paintTexts();
  }

  function textStart(kind, pos, e, capEl, t) {
    e.preventDefault(); e.stopPropagation();
    if (editing && editing !== t) endEdit();
    const r = _vpCropRenderRect(host, vid);
    drag = { kind, pos, el: capEl, t, moved: false,
             sx: e.clientX, sy: e.clientY, of: { x: t.x, y: t.y, w: t.w },
             kw: Math.max(1, state.frac.w * r.rw),
             kh: Math.max(1, state.frac.h * r.rh), r };
    try { capEl.setPointerCapture(e.pointerId); } catch (_) {}
  }

  const ensureMeta = () => { state.frac = _vpCropFracForAspect(state.aspect, vid); paint(); };
  if (vid.videoWidth) ensureMeta();
  else vid.addEventListener('loadedmetadata', ensureMeta, { once: true });

  const ro = new ResizeObserver(paint);
  ro.observe(host);

  // (dev0726) Keep the windowed captions honest as the playhead moves — during
  // playback (timeupdate, ~4/s) and after every scrub or frame-step (seeked).
  const onTimeTick = () => syncTextWindow();
  vid.addEventListener('timeupdate', onTimeTick);
  vid.addEventListener('seeked',     onTimeTick);

  // ── Drag-to-move (rect body) and corner resize (handles) ────────────────
  let drag = null;
  rect.addEventListener('pointerdown', e => {
    if (e.target !== rect) return;
    e.preventDefault(); e.stopPropagation();
    drag = { kind: 'move', el: rect, sx: e.clientX, sy: e.clientY,
             ox: state.frac.x, oy: state.frac.y, r: _vpCropRenderRect(host, vid) };
    rect.setPointerCapture(e.pointerId);
  });
  Object.entries(handles).forEach(([pos, h]) => {
    h.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      drag = { kind: 'resize', pos, el: h, sx: e.clientX, sy: e.clientY,
               of: { ...state.frac }, r: _vpCropRenderRect(host, vid) };
      h.setPointerCapture(e.pointerId);
    });
  });

  // (dev0720) Ken Burns box — same gestures, one frame down. Its fractions are
  // relative to the crop window, so the pointer delta is measured against the
  // crop's on-screen size and un-rotated into the crop's own axes first
  // (dragging a tilted box by screen-x must slide it along the box's x).
  function kenStart(kind, pos, e, capEl) {
    e.preventDefault(); e.stopPropagation();
    const r = _vpCropRenderRect(host, vid);
    drag = { kind, pos, el: capEl, sx: e.clientX, sy: e.clientY,
             of: { ...state.ken.frac },
             kw: Math.max(1, state.frac.w * r.rw),
             kh: Math.max(1, state.frac.h * r.rh), r };
    try { capEl.setPointerCapture(e.pointerId); } catch (_) {}
  }
  kenBox.addEventListener('pointerdown', e => {
    if (e.target !== kenBox) return;      // corner handles have their own
    kenStart('kmove', null, e, kenBox);
  });
  Object.entries(kenHandles).forEach(([pos, h]) => {
    h.addEventListener('pointerdown', e => kenStart('kresize', pos, e, h));
  });
  // Un-rotate a screen-space delta into the crop rect's own axes.
  function kenLocal(e) {
    const dxs = e.clientX - drag.sx, dys = e.clientY - drag.sy;
    const th = (state.angle || 0) * Math.PI / 180;
    const ct = Math.cos(th), st = Math.sin(th);
    return { dxF: ( dxs * ct + dys * st) / drag.kw,
             dyF: (-dxs * st + dys * ct) / drag.kh };
  }
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
    } else if (drag.kind === 'kmove') {
      // (dev0720) Move the Ken Burns box inside the crop window.
      const d = kenLocal(e), k = state.ken.frac, of = drag.of;
      k.x = Math.max(0, Math.min(1 - k.w, of.x + d.dxF));
      k.y = Math.max(0, Math.min(1 - k.h, of.y + d.dyF));
      paintKen();
    } else if (drag.kind === 'kresize') {
      // Square in FRACTION space (a same-aspect box inside a box has equal
      // fractions both ways), so one number drives width and height. The
      // opposite corner is the anchor; the box may not leave the crop window.
      const d = kenLocal(e), of = drag.of;
      let ax, ay, px, py;
      if (drag.pos === 'se') { ax = of.x;      ay = of.y;      px = of.x+of.w+d.dxF; py = of.y+of.h+d.dyF; }
      if (drag.pos === 'sw') { ax = of.x+of.w; ay = of.y;      px = of.x     +d.dxF; py = of.y+of.h+d.dyF; }
      if (drag.pos === 'ne') { ax = of.x;      ay = of.y+of.h; px = of.x+of.w+d.dxF; py = of.y     +d.dyF; }
      if (drag.pos === 'nw') { ax = of.x+of.w; ay = of.y+of.h; px = of.x     +d.dxF; py = of.y     +d.dyF; }
      let n = Math.max(Math.abs(px - ax), Math.abs(py - ay));
      n = Math.min(n, (px >= ax) ? (1 - ax) : ax, (py >= ay) ? (1 - ay) : ay);
      n = Math.max(0.08, Math.min(1, n));   // 0.08 → a 12.5× zoom ceiling
      const k = state.ken.frac;
      k.w = k.h = n;
      k.x = Math.max(0, Math.min(1 - n, (px >= ax) ? ax : ax - n));
      k.y = Math.max(0, Math.min(1 - n, (py >= ay) ? ay : ay - n));
      paintKen();
      paint();   // the ⚠ enlargement label now depends on the zoom depth
    } else if (drag.kind === 'tmove') {
      // (dev0724) Slide a text box inside the crop window. Same un-rotation as
      // the zoom box — a tilted crop must still move by what the pointer did on
      // screen. The travel test decides click-vs-drag when the press is let go.
      const d = kenLocal(e), t = drag.t, of = drag.of;
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 4) drag.moved = true;
      t.x = Math.max(0, Math.min(1 - t.w, of.x + d.dxF));
      t.y = Math.max(0, Math.min(0.995, of.y + d.dyF));
      paintTexts();
    } else if (drag.kind === 'tw') {
      // Wrap width. The right grip grows the box; the left one moves the edge
      // and keeps the other side pinned.
      const d = kenLocal(e), t = drag.t, of = drag.of;
      drag.moved = true;
      if (drag.pos === 'r') {
        t.w = Math.max(VP_TEXT_MIN_W, Math.min(1 - t.x, of.w + d.dxF));
      } else {
        const nx = Math.max(0, Math.min(of.x + of.w - VP_TEXT_MIN_W, of.x + d.dxF));
        t.x = nx;
        t.w = of.x + of.w - nx;
      }
      paintTexts();
    }
  }
  function onUp(e) {
    if (drag) {
      try { if (drag.el) drag.el.releasePointerCapture(e.pointerId); } catch (_) {}
      // (dev0720) Placing the box also stamps WHEN it lands: the zoom finishes
      // on the frame you were parked on while positioning it, then holds to B.
      if (drag.kind === 'kmove' || drag.kind === 'kresize') {
        state.ken.atSec = _vpNowSec();
        paintKen();
      }
      // (dev0724) A press on a text box that never travelled is a click: start
      // typing in it.
      if (drag.kind === 'tmove' && !drag.moved) beginEdit(drag.t);
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
    paint();   // (dev0717) re-evaluate the enlargement warning for the new target
  });

  // (dev0719) Output-audio chip — click or M. Lit blue when the clip will carry
  // sound, so the bar always answers "will this render silent?" at a glance.
  const audioChip = bar.querySelector('#vp-crop-audio');
  function paintAudio() {
    if (!audioChip) return;
    audioChip.textContent    = state.audio ? '🔊 audio' : '🔇 no audio';
    audioChip.style.background = state.audio ? '#2a5d9a' : '#234';
    audioChip.style.color      = state.audio ? '#fff' : '#dfe6f0';
  }
  paintAudio();
  if (audioChip) audioChip.addEventListener('click', _vpCropToggleAudio);

  // (dev0745) ── Saved text ─────────────────────────────────────────────────
  // The chip counts what is banked; the list itself is built fresh each time it
  // opens, so it is never behind what has just been typed. Picking an entry
  // drops a NEW box carrying that text — the empty box an aborted E left behind
  // removes itself on endEdit, so the two never pile up.
  const textPick = bar.querySelector('#vp-crop-textpick');
  function paintTextPick() {
    if (!textPick) return;
    const n = _vpTextSaved().length;
    textPick.textContent = '▾ saved text' + (n ? ' (' + n + ')' : '');
  }
  function dropSavedText(s) {
    const t = addText({ silent: true });
    if (!t) return;
    t.text = s; t.ta.value = s;
    growText(t); paintTexts();
    beginEdit(t);
  }
  paintTextPick();
  if (textPick) {
    textPick.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      _vpTextPickMenu(e.clientX, e.clientY, dropSavedText, paintTextPick);
    });
  }

  // (dev0745) ── Motion (image mode) ────────────────────────────────────────
  const motionChip = bar.querySelector('#vp-crop-motion');
  if (motionChip) motionChip.addEventListener('click', _vpMotionCycle);
  const durSel = bar.querySelector('#vp-crop-dur');
  if (durSel) {
    durSel.value = String(state.motion.durSec);
    durSel.addEventListener('change', () => {
      state.motion.durSec = +durSel.value || 3;
      paint();
    });
  }

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
    // (dev0718) Closing V mid-crop must hand the slideshow back its chrome and
    // its autopilot, and take the cheat-sheet down with the player.
    endEdit();   // (dev0724) …and drop the text box's document listener
    _vpCropHelpHide();
    if (typeof window._slideshowCropHold === 'function') {
      try { window._slideshowCropHold(false); } catch (_) {}
    }
    try { ro.disconnect(); } catch (_) {}
    try {
      vid.removeEventListener('timeupdate', onTimeTick);
      vid.removeEventListener('seeked',     onTimeTick);
    } catch (_) {}
    if (_gridTimer) clearTimeout(_gridTimer);
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup',   onUp,   true);
  };
  // (dev0318) Exposed for the Z/X keyboard nudges and aspect-swap repaint.
  state.paint = paint;
  state.setAngle = setAngle;
  state.paintAudio = paintAudio;   // (dev0719) M repaints the audio chip
  state.paintKen = paintKen;       // (dev0720) Z arms/disarms the zoom box
  // (dev0724) E adds a text box; the key handler resizes and ends the entry.
  state.addText = addText;
  state.paintTexts = paintTexts;
  state.endTextEdit = endEdit;
  state.nudgeTextSize = nudgeSize;
  // (dev0725) …and the right-click menu needs to find a box, type into it and
  // repaint its ⏱ badge.
  state.textBoxFor = textBoxFor;
  state.textInsertAt = textInsertAt;
  state.textBeginEdit = beginEdit;
  state.paintTextMarks = paintTextMarks;

  // (dev0727) Restore a whole session from a saved .edit document. Everything
  // the bar owns has to be pushed back into the WIDGETS as well as the state,
  // or the next click on a control snaps the value back to what it shows.
  state.applyEdit = function (doc) {
    endEdit();
    state.texts.slice().forEach(removeText);
    const c0 = doc.crop || {};
    if (c0.aspect === 'L' || c0.aspect === 'P') state.aspect = c0.aspect;
    if (c0.frac && Number.isFinite(+c0.frac.w)) {
      state.frac = { x: +c0.frac.x || 0, y: +c0.frac.y || 0,
                     w: +c0.frac.w, h: +c0.frac.h,
                     ratio: +c0.frac.ratio || (+c0.frac.w / (+c0.frac.h || 1)) };
    }
    if (Number.isFinite(+c0.crf)) { state.crf = +c0.crf; crfSlider.value = state.crf; crfVal.textContent = state.crf; }
    if (c0.resHeight != null) { state.resHeight = c0.resHeight; resSel.value = String(c0.resHeight); }
    state.slow  = !!c0.slow;  slowBox.checked = state.slow;
    state.audio = !!c0.audio; paintAudio();
    const lbl = bar.querySelector('#vp-crop-aspect');
    if (lbl) lbl.textContent = (state.frac.w >= 0.999 && state.frac.h >= 0.999)
      ? 'full' : (state.aspect === 'L' ? '16:9' : '9:16');
    const k0 = doc.ken || {};
    state.ken.on = !!k0.on;
    if (k0.frac && Number.isFinite(+k0.frac.w)) {
      state.ken.frac = { x: +k0.frac.x || 0, y: +k0.frac.y || 0, w: +k0.frac.w, h: +k0.frac.h };
    }
    state.ken.atSec = +k0.atSec || 0;
    (Array.isArray(doc.texts) ? doc.texts : []).forEach(td => {
      const t = addText({ silent: true });
      if (!t) return;
      if (Number.isFinite(+td.x))    t.x = +td.x;
      if (Number.isFinite(+td.y))    t.y = +td.y;
      if (Number.isFinite(+td.w))    t.w = +td.w;
      if (Number.isFinite(+td.size)) t.size = +td.size;
      t.text = String(td.text == null ? '' : td.text);
      t.ta.value = t.text;
      t.atStart = Number.isFinite(+td.atStart) ? +td.atStart : null;
      t.atEnd   = Number.isFinite(+td.atEnd)   ? +td.atEnd   : null;
      t.pauseSec = Number.isFinite(+td.pauseSec) ? +td.pauseSec : null;
      // (dev0750) The look of the caption, not just its geometry and its clock.
      // alpha was written out by dev0745 and never read back, so a reloaded
      // watermark came back at full strength; font joins it here.
      t.alpha = (Number.isFinite(+td.alpha) && +td.alpha > 0 && +td.alpha < 1) ? +td.alpha : null;
      t.font  = _vpTextFont(td.font).id;
      t.color = _vpTextColor(td.color).id;   // (dev0753) absent → white, as it was
      paintTextMarks(t);
    });
    endEdit();                       // addText opens each box for typing; close it
    setAngle(Number.isFinite(+c0.angle) ? +c0.angle : 0);   // setAngle repaints everything
  };

  // A snapshot of everything K writes out.
  state.snapshot = function () {
    return {
      crop: { aspect: state.aspect, frac: { ...state.frac }, angle: state.angle,
              resHeight: state.resHeight, crf: state.crf, slow: !!state.slow,
              audio: !!state.audio },
      ken: { on: !!state.ken.on, frac: { ...state.ken.frac }, atSec: state.ken.atSec },
      texts: state.texts.map(t => ({
        x: t.x, y: t.y, w: t.w, size: t.size,
        text: (t.ta ? t.ta.value : t.text) || '',
        atStart: t.atStart, atEnd: t.atEnd, pauseSec: t.pauseSec,
        // (dev0750/53) how it looks, not just where
        alpha: t.alpha, font: t.font, color: t.color
      }))
    };
  };
  if (_vpState) _vpState.crop = state;
}

// (dev0727) ── K / E: keep an edit, and pick one up again ────────────────────
// An .edit is the whole crop session as JSON — framing, tilt, output settings,
// the zoom, the clip's A→B, and every text box with its window and pause. It
// sits next to the source as `<base>.<YYYYMMDD-HHMMSS>.edit`, so the edits of
// one video sort together and nothing is ever overwritten.
//
// It is a RECIPE, not a render: nothing in it touches the source file, and
// loading one costs nothing until G. That's the point — the expensive thing
// about this tool was that a session died with the page.
const VP_EDIT_EXT = '.edit';

function _vpEditStamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
         '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

async function _vpCropSaveEdit() {
  if (!_vpState || !_vpState.crop || !_vpState.crop.snapshot) return;
  const row = window._vpCurrentRow;
  const relPath = (row && (row.comment || row.VidTitle)) || '';
  if (!relPath) { if (typeof toast === 'function') toast('K: no source file path on this row', 2400); return; }
  const absInput = _vpCropResolveAbsPath(relPath);
  if (!absInput) { if (typeof toast === 'function') toast('K cancelled (need the folder path)', 2200); return; }
  const parts = _vpSplitPath(absInput);
  if (!parts) { if (typeof toast === 'function') toast('K: cannot parse that path', 2400); return; }

  const vid = _vpState.player && _vpState.player.el;
  const snap = _vpState.crop.snapshot();
  const doc = Object.assign({
    format: 'slam.edit/1',
    savedAt: (typeof isoNow === 'function') ? isoNow() : new Date().toISOString(),
    app: window.HELP_VERSION_STR || '',
    source: { path: absInput, base: parts.base, ext: parts.ext,
              width: (vid && vid.videoWidth) || 0, height: (vid && vid.videoHeight) || 0 },
    clip: { startSec: _vpState.aPoint, endSec: _vpState.bPoint },
    pauseTail: VP_TEXT_PAUSE_TAIL
  }, snap);

  const outPath = parts.dir + parts.sep + parts.base + '.' + _vpEditStamp() + VP_EDIT_EXT;
  try {
    const r = await fetch(PROXY_BASE + '/edit/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: outPath, doc })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
    if (typeof toast === 'function') {
      toast('✓ kept ' + outPath.split(/[\\/]/).pop() + ' · ' +
            snap.texts.length + ' text box' + (snap.texts.length === 1 ? '' : 'es'), 3200);
    }
  } catch (err) {
    if (typeof toast === 'function') {
      toast('K failed: ' + ((err && err.message) || err) + ' — proxy restarted on 8081?', 4200);
    }
  }
}

// E (crop overlay CLOSED) — pick a folder, then one of the .edit files in it.
// The folder picker is the "disk info/permission" step: the browser hands out a
// directory handle, we read the names ourselves, and only .edit is offered.
async function _vpCropLoadEditPick() {
  if (!_vpState || !_vpState.crop) { if (typeof toast === 'function') toast('E: open a disk video first', 2200); return; }
  if (!window.showDirectoryPicker) {
    if (typeof toast === 'function') toast('E: this browser has no folder picker (needs Chrome)', 3000);
    return;
  }
  let dir;
  try { dir = await window.showDirectoryPicker({ id: 'salEditDir', mode: 'read' }); }
  catch (_) { return; }                                   // user cancelled
  const files = [];
  try {
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== 'file' || !/\.edit$/i.test(name)) continue;
      files.push({ name, handle: h });
      if (files.length >= 200) break;
    }
  } catch (err) {
    if (typeof toast === 'function') toast('E: could not read that folder — ' + ((err && err.message) || err), 3600);
    return;
  }
  if (!files.length) {
    if (typeof toast === 'function') toast('No .edit files in “' + dir.name + '” — K keeps one next to the video', 3600);
    return;
  }
  files.sort((a, b) => b.name.localeCompare(a.name));      // newest stamp first
  _vpEditChooser(files);
}

function _vpEditChooser(files) {
  const old = document.getElementById('vp-edit-pick');
  if (old) old.remove();
  const el = document.createElement('div');
  el.id = 'vp-edit-pick';
  el.style.cssText =
    'position:fixed;left:50%;top:12vh;transform:translateX(-50%);z-index:42700;' +
    'max-height:74vh;overflow-y:auto;min-width:340px;max-width:92vw;background:rgba(10,10,22,0.97);' +
    'border:2px solid #4af;border-radius:9px;padding:8px;color:#dfe6f0;' +
    'font:12px ui-monospace,Consolas,monospace;box-shadow:0 8px 32px rgba(0,0,0,0.9);';
  const hd = document.createElement('div');
  hd.innerHTML = '<b style="color:#8ef;">Load an edit</b> ' +
                 '<span style="opacity:0.6;">· newest first · Esc to cancel</span>';
  hd.style.cssText = 'padding:4px 6px 8px;border-bottom:1px solid rgba(102,170,255,0.3);margin-bottom:5px;';
  el.appendChild(hd);
  const close = () => { el.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
  };
  files.forEach(f => {
    const d = document.createElement('div');
    d.textContent = f.name;
    d.style.cssText = 'padding:5px 7px;border-radius:5px;cursor:pointer;white-space:nowrap;';
    d.onmouseenter = () => { d.style.background = '#12325c'; };
    d.onmouseleave = () => { d.style.background = ''; };
    d.onclick = async () => {
      close();
      try {
        const file = await f.handle.getFile();
        _vpCropApplyEdit(JSON.parse(await file.text()), f.name);
      } catch (err) {
        if (typeof toast === 'function') toast('Could not read ' + f.name + ' — ' + ((err && err.message) || err), 3600);
      }
    };
    el.appendChild(d);
  });
  document.body.appendChild(el);
  el.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('keydown', onKey, true);
}

function _vpCropApplyEdit(doc, name) {
  if (!doc || typeof doc !== 'object' || !/^slam\.edit\//.test(String(doc.format || ''))) {
    if (typeof toast === 'function') toast(name + ' is not a SLAM edit file', 3000);
    return;
  }
  const s = _vpState && _vpState.crop;
  if (!s || !s.applyEdit) return;
  if (!_vpCropHolding()) _vpCropToggle();          // an edit is a crop session

  // Made for a different video? Load it anyway — the geometry is in fractions,
  // so it transfers — but say so, because the clip times are in SECONDS and a
  // shorter video will clamp them.
  const row = window._vpCurrentRow;
  const here = String((row && (row.comment || row.VidTitle)) || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  const there = String((doc.source && doc.source.base) || '');
  s.applyEdit(doc);

  const clip = doc.clip || {};
  if (Number.isFinite(+clip.startSec)) _vpState.aPoint = +clip.startSec;
  if (Number.isFinite(+clip.endSec))   _vpState.bPoint = +clip.endSec;
  if (typeof vpUpdateABStyle === 'function') vpUpdateABStyle();
  if (Number.isFinite(+clip.startSec)) _vpSeekAbsolute(+clip.startSec);

  const n = (doc.texts || []).length;
  if (typeof toast === 'function') {
    toast('✓ loaded ' + name + ' — ' + n + ' text box' + (n === 1 ? '' : 'es') +
          (doc.ken && doc.ken.on ? ' · zoom' : '') +
          (there && here && there !== here ? '  ⚠ saved from “' + there + '”, not this video' : ''),
          (there && here && there !== here) ? 5200 : 3200);
  }
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
// (dev0718) Floating crop cheat-sheet. It stands in for the slideshow chrome
// that the crop hold hides, so the keys are on screen exactly when they apply.
// Dragged by its title bar; the position persists across videos and sessions.
// Body-mounted `position:fixed` at z 42500 — above the slideshow menu layer
// (42000) and the V player (41000) — so no host stacking context clips it.
const VP_CROP_HELP_Z = 42500;
const VP_CROP_HELP_POS_KEY = 'vpCropHelpPos';
// (dev0720) Two widths, toggled by W (or the ⇔ button). Narrow is the original
// 290px — small enough to leave the frame alone. (dev0724) Wide is now the FULL
// window rather than 720px: at 720 the descriptions still wrapped, and a panel
// you flip to for a moment to read may as well use the whole width while it's up.
// (dev0725) …and it is no longer remembered. Full width covers the picture, so
// every crop session STARTS narrow and W is a look-something-up gesture within
// it, not a setting that follows you into the next video.
const VP_CROP_HELP_W_NARROW = '290px';
const VP_CROP_HELP_W_WIDE   = 'calc(100vw - 8px)';
let _vpCropHelpWide = false;

function _vpCropHelpIsWide() { return _vpCropHelpWide; }

// (dev0749) How wide the key column is pinned at full width. Comfortably past
// the widest thing in it ("drag inside / a corner"), so nothing is clipped.
const VP_CROP_HELP_KEYCOL = '186px';

function _vpCropHelpApplyWidth(el) {
  const wide = _vpCropHelpIsWide();
  el.style.width = wide ? VP_CROP_HELP_W_WIDE : VP_CROP_HELP_W_NARROW;
  // (dev0749) The key column, and ONLY at full width.
  //
  //   wide   — table-layout:fixed makes the <col> width an instruction rather
  //            than the hint auto layout is free to ignore (dev0727's
  //            width:1%/99% was exactly such a hint, and at full width the
  //            browser handed the keys half the panel: ~900px of black beside
  //            descriptions still wrapping in what was left).
  //   narrow — nothing set at all, so auto layout behaves as it always has:
  //            the sheet may run past the panel edge, which is what keeps
  //            every hint on one line and the whole thing visible at a glance.
  const tbl = el.querySelector('#vp-crop-help-table');
  const c1  = el.querySelector('#vp-crop-help-c1');
  if (tbl) tbl.style.tableLayout = wide ? 'fixed' : '';
  if (c1)  c1.style.width        = wide ? VP_CROP_HELP_KEYCOL : '';
  // (dev0724) Full width leaves the clamp below nowhere to put the panel but
  // the left edge — so coming back to narrow restores the spot the user
  // actually parked it in, instead of abandoning it there.
  if (!wide) {
    let pos = null;
    try { pos = JSON.parse(localStorage.getItem(VP_CROP_HELP_POS_KEY) || 'null'); } catch (_) {}
    el.style.left = ((pos && Number.isFinite(pos.x)) ? pos.x : (window.innerWidth - 306)) + 'px';
  }
  const btn = el.querySelector('#vp-crop-help-wide');
  if (btn) btn.title = wide ? 'Narrow the panel (W)' : 'Full width (W)';
  _vpCropHelpClamp(el);
}

// W — flip the panel between the two widths. No-op when the sheet isn't up,
// which is the same gate the rest of the crop keys use.
function _vpCropHelpToggleWidth() {
  const el = document.getElementById('vp-crop-help');
  if (!el) return;
  _vpCropHelpWide = !_vpCropHelpWide;
  _vpCropHelpApplyWidth(el);
}

function _vpCropHelpShow() {
  _vpCropHelpWide = false;               // (dev0725) every session starts narrow
  let el = document.getElementById('vp-crop-help');
  if (el) { el.style.display = ''; _vpCropHelpApplyWidth(el); return; }

  const K = k =>
    '<kbd style="display:inline-block;min-width:13px;padding:1px 5px;margin:0 1px;' +
    'background:#1d3149;border:1px solid #6af;border-radius:3px;color:#cfe;' +
    'font:11px ui-monospace,Consolas,monospace;text-align:center;">' + k + '</kbd>';
  // (dev0749) Back to the table, because NARROW has to stay as it was: auto
  // layout lets the sheet run wider than the 290px panel rather than squeezing
  // every description into a column three words across, and that is what keeps
  // the whole cheat-sheet on screen at a glance instead of behind a scrollbar.
  // dev0748's grid forced the wrap and cost exactly that.
  //
  // The full-width gully is fixed where it actually happens — see the
  // table-layout switch in _vpCropHelpApplyWidth, which pins the key column
  // only when the panel is wide enough for pinning to mean anything.
  const row = (keys, txt) =>
    '<tr><td style="padding:2px 9px 2px 0;white-space:nowrap;vertical-align:top;">' + keys +
    '</td><td style="padding:2px 0;color:#b9c6d6;">' + txt + '</td></tr>';
  const head = t =>
    '<tr><td colspan="2" style="padding:9px 0 3px;color:#6af;font-weight:bold;' +
    'border-bottom:1px solid rgba(102,170,255,0.28);">' + t + '</td></tr>';

  // (dev0744) A still gets its own sheet. Half the video one is about time —
  // A/B, frame-stepping, pauses, the zoom's landing frame — and listing keys
  // that do nothing here would be worse than listing nothing.
  const imageMode = !!(_vpState && _vpState.imageMode);

  el = document.createElement('div');
  el.id = 'vp-crop-help';
  // (dev0720) Width comes from _vpCropHelpApplyWidth below (narrow by default,
  // W widens); everything else is fixed.
  el.style.cssText = [
    'position:fixed', 'max-height:86vh', 'overflow-y:auto',
    'background:rgba(14,14,28,0.95)', 'border:1px solid #4af', 'border-radius:9px',
    'color:#dfe6f0', 'font:12px ui-monospace,Consolas,monospace',
    'box-shadow:0 8px 32px rgba(0,0,0,0.9)', 'z-index:' + VP_CROP_HELP_Z,
    'user-select:none'
  ].join(';') + ';';
  el.innerHTML =
    '<div id="vp-crop-help-bar" style="display:flex;align-items:center;gap:6px;cursor:move;' +
      'padding:6px 8px;background:rgba(40,70,110,0.55);border-radius:8px 8px 0 0;' +
      'border-bottom:1px solid rgba(102,170,255,0.35);">' +
      '<span style="flex:1;font-weight:bold;color:#8ef;">' +
        (imageMode ? '✂ Crop this picture' : '✂ Crop &amp; trim') + '</span>' +
      '<span id="vp-crop-help-wide" title="Full width / narrow (W)" ' +
        'style="cursor:pointer;padding:0 4px;color:#ccc;">⇔</span>' +
      '<span id="vp-crop-help-close" title="Close crop (same as C)" ' +
        'style="cursor:pointer;padding:0 4px;color:#ccc;">✕</span>' +
    '</div>' +
    '<div style="padding:8px 10px 11px;">' +
      '<div style="color:#8ef;opacity:0.85;margin-bottom:2px;">' +
        'Slideshow is held — it will not advance off this ' +
        (imageMode ? 'picture' : 'video') + ' until ' + K('C') + ' closes crop.' +
      '</div>' +
      '<table id="vp-crop-help-table" style="border-collapse:collapse;width:100%;">' +
        '<colgroup><col id="vp-crop-help-c1"><col></colgroup>' +
        (imageMode ? _vpCropHelpImageRows(K, row, head) : '') +
        (imageMode ? '' :
        head('The frame') +
        // (dev0724) One line each for the two mouse gestures, and 1/2 took the
        // tilt over from Z/X so Z could become the zoom below.
        row('drag inside / a corner', 'move the crop box / resize it (aspect stays locked)') +
        row(K('T'),          'swap 16:9 ↔ 9:16') +
        row(K('⇧F'),         'the WHOLE frame — no crop, the source’s own shape ' +
                             '(' + K('T') + ' goes back to a locked rect)') +
        row(K('1') + K('2'), 'tilt ∓0.5° to straighten a horizon') +
        row('knob / ⟲',      'drag to tilt · wheel ±0.1° · double-click = level') +
        head('Zoom into') +
        row(K('Z'),          'amber box on / off — where the zoom ENDS') +
        row('drag it',       'move / resize it inside the crop box (always the same ' +
                             'shape, so the shot keeps its aspect) — and it lands on ' +
                             'the frame you are parked on when you place it: the ' +
                             'render glides from the full crop at the start mark ' +
                             'to the box by then, and holds it to the end mark.') +
        head('Text on the picture') +
        row(K('E'),          'new text box — burned in at render, for the whole clip') +
        row('click inside',  'type. No hotkeys while you do — ' + K('↑') + K('↓') +
                             ' size the type, click outside to finish') +
        row('drag it / ↔',   'move the box / drag a side grip to set the wrap width — ' +
                             'the wrap you see is the wrap you get. ✕ removes it.') +
        row('◻ strength',    '(right-click menu) fade the letters and their outline ' +
                             'together — 100% is a caption, 35% or 20% is a watermark ' +
                             'the picture shows through') +
        row('Aa font',       '(same menu) ten stock faces, each row set in the font it ' +
                             'offers. Per box, and the last one picked is what the next ' +
                             'box opens in. Only Segoe UI Symbol draws the ⬇ ⬆ arrows.') +
        row('▾ saved text',  'every caption you finish is remembered; pick one off the ' +
                             'bar to drop it on this clip') +
        row('right-click it', 'drop a ⬇ or ⬆ arrow at the cursor (it sizes with the ' +
                             'type), or set when this text comes and goes: ' +
                             '<u>s</u>tarts / <u>e</u>nds at the playhead — click, or ' +
                             'press ' + K('s') + ' / ' + K('e') + '. An amber ⏱ under ' +
                             'the box means it is windowed; no badge = the whole clip.') +
        row('p<u>a</u>use',  'also on that menu (or ' + K('a') + '): hold the picture ' +
                             'where this text starts — ' + K('a') + K('s') + K('d') +
                             K('f') + K('g') + ' = 1…5 seconds with the text, then ' +
                             VP_TEXT_PAUSE_TAIL + 's more of still picture without it, ' +
                             'then play on. A pause SETS the end. The clip gets that ' +
                             'much longer, so it renders silent.') +
        row('⏱ windowed',    'a windowed box VANISHES here whenever the playhead is ' +
                             'outside its window — same as in the file. It is not ' +
                             'deleted: scrub back inside the window to see or edit it.') +
        head('The clip') +
        // (dev0749) One row of left-hand keys: the two marks on the outside,
        // the frame-step between them. ⇧A / ⇧B no longer mark anything.
        row(K('a') + ' / ' + K('f'),
                             'set start / end of clip at the position of the current ' +
                             'frame (again to clear) — same as the A and B buttons') +
        row(K('s') + ' or ' + K('←') + ' / ' + K('d') + ' or ' + K('→'),
                             'step one frame back or forward (pauses first)') +
        row(K('⇧←') + K('⇧→'), 'jump to the start / end of the clip') +
        row('Ctrl+click',    'set start / end straight off the timeline') +
        row(K('Space'),      'play / pause') +
        head('The output') +
        row(K('M'),  'audio on / off in the SAVED clip — the bar says which, ' +
                     'and it starts off. (Muting the player is the toolbar 🔇.)') +
        row('res',   '2160p (4K) · 1440p (2K) · 1080p · 720p · Same') +
        row('CRF',   'lower = better + bigger · Slow = smaller, slower') +
        row('⚠',     'amber size label = output is BIGGER than the crop — or ' +
                     'than the zoom box, once armed, since that is the ' +
                     'tightest the shot gets. Pixels would be enlarged: grow ' +
                     'the box or drop the res.') +
        head('Finish') +
        row(K('G'),   'render (or the Crop button) — writes next to the source') +
        row(K('K'),   'keep this whole session — framing, tilt, zoom, clip, every ' +
                      'text box — next to the source as <i>name</i>.<i>stamp</i>.edit. ' +
                      'Nothing is rendered; it is a recipe.') +
        row(K('E') + '<span style="opacity:0.6;"> (crop closed)</span>',
                      'load one back: pick the folder, then the .edit') +
        row(K('W'),   'this panel: full width / narrow') +
        row(K('C'),   'close crop, hand the show back to the slideshow') +
        row(K('Esc'), 'close the video entirely')) +
      '</table>' +
    '</div>';
  document.body.appendChild(el);

  // Restore the last position; default to the upper right, clear of the
  // crop toolbar which centers itself over the rect.
  let pos = null;
  try { pos = JSON.parse(localStorage.getItem(VP_CROP_HELP_POS_KEY) || 'null'); } catch (_) {}
  el.style.left = ((pos && Number.isFinite(pos.x)) ? pos.x : (window.innerWidth - 306)) + 'px';
  el.style.top  = ((pos && Number.isFinite(pos.y)) ? pos.y : 64) + 'px';
  _vpCropHelpApplyWidth(el);   // (dev0720) also clamps

  // Clicks must not reach #gridFullscreen's handler (which would close V).
  el.addEventListener('click', e => e.stopPropagation());
  el.querySelector('#vp-crop-help-close').addEventListener('click', e => {
    e.stopPropagation();
    _vpCropToggle();
  });
  el.querySelector('#vp-crop-help-wide').addEventListener('click', e => {
    e.stopPropagation();
    _vpCropHelpToggleWidth();
  });

  const bar = el.querySelector('#vp-crop-help-bar');
  let drag = null;
  bar.addEventListener('pointerdown', e => {
    if (e.target.id === 'vp-crop-help-close' || e.target.id === 'vp-crop-help-wide') return;
    e.preventDefault(); e.stopPropagation();
    const b = el.getBoundingClientRect();
    drag = { dx: e.clientX - b.left, dy: e.clientY - b.top };
    try { bar.setPointerCapture(e.pointerId); } catch (_) {}
  });
  bar.addEventListener('pointermove', e => {
    if (!drag) return;
    el.style.left = (e.clientX - drag.dx) + 'px';
    el.style.top  = (e.clientY - drag.dy) + 'px';
  });
  bar.addEventListener('pointerup', e => {
    if (!drag) return;
    try { bar.releasePointerCapture(e.pointerId); } catch (_) {}
    drag = null;
    _vpCropHelpClamp(el);
    try {
      localStorage.setItem(VP_CROP_HELP_POS_KEY, JSON.stringify({
        x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0
      }));
    } catch (_) {}
  });
}

// (dev0744) The cheat-sheet for a still. Same table helpers the video sheet
// uses (passed in rather than re-derived), so the two panels stay one look.
function _vpCropHelpImageRows(K, row, head) {
  return head('The frame') +
    row('drag inside / a corner', 'move the crop box / resize it (aspect stays locked)') +
    row(K('T'),          'swap 16:9 ↔ 9:16') +
    row(K('⇧F'),         'the WHOLE picture — no crop, its own shape ' +
                         '(' + K('T') + ' goes back to a locked rect)') +
    row(K('1') + K('2'), 'tilt ∓0.5° to straighten a horizon') +
    row('knob / ⟲',      'drag to tilt · wheel ±0.1° · double-click = level') +
    head('Text on the picture') +
    row(K('E'),          'new text box — burned into the saved file') +
    row('click inside',  'type. No hotkeys while you do — ' + K('↑') + K('↓') +
                         ' size the type, click outside to finish') +
    row('drag it / ↔',   'move the box / drag a side grip to set the wrap width — ' +
                         'the wrap you see is the wrap you get. ✕ removes it.') +
    row('right-click it', 'drop a ⬇ or ⬆ arrow at the cursor, or <b>◻ strength</b>: ' +
                         'fade the letters AND their outline together. 100% is a ' +
                         'caption; 35% or 20% is a watermark you can see through.') +
    row('Aa font',       'on that same menu — ten stock faces, each row set in the ' +
                         'font it offers, so you pick by eye. It is per box, and the ' +
                         'last one picked is what the next box opens in. Only Segoe UI ' +
                         'Symbol has the ⬇ ⬆ arrows; the others render them blank.') +
    row('▾ saved text',  'every caption you finish is remembered. Pick one off the ' +
                         'bar to drop it on this picture — type your credit line ' +
                         'once and it is there for every photograph after.') +
    head('Or make it move') +
    row(K('M'),          'still → 🎬 mp4 → 🎞 gif → still (the bar chip says which)') +
    row(K('Z'),          'the amber box = where the zoom ENDS. The clip glides from ' +
                         'the whole crop into it and holds there.') +
    row('duration',      'next to the chip: 2–10s. Without a zoom box the picture ' +
                         'is simply held for that long.') +
    row('gif vs mp4',    'gif is 15fps and carries its own palette — keep it short ' +
                         'and small. mp4 is 30fps, h264, silent.') +
    head('The output') +
    row('⧉ lossless',    'jpegtran copies the JPEG’s blocks straight across — the ' +
                         'pixels that survive the crop are the ORIGINAL pixels, not ' +
                         're-compressed ones. The box is snapped to the 16px block ' +
                         'grid so the cut lands exactly where you drew it.') +
    row('↻ re-encode',   'a tilt, a caption, a clip, a resolution other than ' +
                         '<i>Same</i>, a non-JPEG, or an EXIF-rotated original — none ' +
                         'can be done by copying blocks, so ffmpeg redraws the picture ' +
                         'at high quality. The chip on the bar says which one is armed ' +
                         'before you commit.') +
    row('res',           '2160p (4K) · 1440p (2K) · 1080p · 720p · Same ' +
                         '(<i>Same</i> is what keeps it lossless)') +
    row('⚠',             'amber size label = the output is BIGGER than the box: pixels ' +
                         'would be enlarged for nothing. Grow the box or drop the res.') +
    head('Finish') +
    row(K('G'),          'save (or the Crop button) — writes into a ' +
                         '<i>YYYYMMDD_edited</i> folder beside the picture') +
    row(K('W'),          'this panel: full width / narrow') +
    row(K('C') + K('Esc'), 'close crop, hand the show back to the slideshow');
}

// Keep the panel on screen — a saved position can outlive the window size that
// produced it, and a drag can park the title bar past an edge (unreachable).
function _vpCropHelpClamp(el) {
  const w = el.offsetWidth || 290, h = el.offsetHeight || 200;
  const x = Math.max(4, Math.min(window.innerWidth  - w - 4, parseFloat(el.style.left) || 0));
  const y = Math.max(4, Math.min(window.innerHeight - h - 4, parseFloat(el.style.top)  || 0));
  el.style.left = x + 'px';
  el.style.top  = y + 'px';
}

function _vpCropHelpHide() {
  const el = document.getElementById('vp-crop-help');
  if (el) el.remove();
}

function _vpCropToggle() {
  if (!_vpState || !_vpState.crop) return;
  const s = _vpState.crop;
  const isOpening = (s.el.container.style.display === 'none');
  // (dev0724) Closing on top of a half-typed caption must hand the keyboard
  // back, or the next bare letter goes into an invisible field.
  if (!isOpening && s.endTextEdit) s.endTextEdit();
  s.el.container.style.display = isOpening ? '' : 'none';
  // (dev0718) Trade the slideshow's chrome for the crop cheat-sheet, and take
  // the show off autopilot so it can't advance mid-edit. Both directions are
  // driven from here, so C is the single switch between the two modes.
  if (typeof window._slideshowCropHold === 'function') {
    try { window._slideshowCropHold(isOpening); } catch (_) {}
  }
  if (isOpening) _vpCropHelpShow(); else _vpCropHelpHide();
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
    // (dev0744) On a still there is nothing left underneath to keep the state
    // alive for — closing the crop IS ending the session, whether it came from
    // C, the bar's ✕ or the cheat-sheet's. _vpImageCropClose guards re-entry.
    if (_vpState.imageMode) window._vpImageCropClose();
  }
}

// (dev0719) Toggle whether the RENDERED clip keeps its soundtrack (chip + M).
// Default off: these crops are mostly silent b-roll, and a wrong default that
// costs an audio track is easier to notice than one that smuggles it in.
// Only the crop path honors it — the lossless trim (crop closed) always
// stream-copies audio, and its switch isn't on screen to say otherwise.
function _vpCropToggleAudio() {
  if (!_vpState || !_vpState.crop) return;
  const s = _vpState.crop;
  s.audio = !s.audio;
  if (s.paintAudio) s.paintAudio();
  if (typeof toast === 'function') {
    toast(s.audio ? '🔊 saved clip keeps its audio' : '🔇 saved clip will be silent', 1400);
  }
}

// (dev0725) ⇧F — the whole frame, no crop. Drops the 16:9 / 9:16 lock and takes
// the source's own shape, so the render is a straight trim (plus whatever zoom,
// tilt and text are armed) at the full picture. The aspect flag still has to be
// right either way: it decides which side `resHeight` scales, and it is the
// SHORT one. T afterwards goes back to a locked 16:9 / 9:16 rect.
function _vpCropFullFrame() {
  if (!_vpState || !_vpState.crop) return;
  const s = _vpState.crop;
  const vid = _vpState.player && _vpState.player.el;
  if (!vid) return;
  const VW = vid.videoWidth || 16, VH = vid.videoHeight || 9;
  s.aspect = (VW >= VH) ? 'L' : 'P';
  s.frac = { x: 0, y: 0, w: 1, h: 1, ratio: 1 };   // ratio 1 in FRACTION space = the source aspect
  const label = s.el.bar.querySelector('#vp-crop-aspect');
  if (label) label.textContent = 'full';
  if (s.paint) s.paint();
  if (typeof toast === 'function') {
    toast('⛶ whole frame — ' + VW + ' × ' + VH + ', no crop (T returns to 16:9 / 9:16)', 2400);
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
// (dev0718) The prompt asks for a FOLDER, but the natural gesture is Explorer's
// "Copy as path" on the video itself. Accept either. `rest` is the file's path
// under the slideshow root, so if the answer ends with that, lopping it off
// gives the root exactly — right even when the file sits in a subfolder. If it
// doesn't match (a different file was copied), fall back to dropping a trailing
// segment that carries a media extension. That fallback is deliberately keyed
// to media extensions rather than "any dot", so a real folder like
// "M:\clips.new" is never mistaken for a filename.
//   M:\Candidates\20260803_…use.mp4  →  M:\Candidates
// Explorer wraps its copied path in quotes; those and trailing separators go too.
const _VP_MEDIA_EXT_RE = /\.(mp4|mov|webm|ogg|avi|mkv|m4v|jpe?g|png|gif|webp|avif|bmp)$/i;
function _vpCropAnswerToRoot(answer, rest) {
  const s = String(answer || '').trim().replace(/^"+|"+$/g, '').trim();
  if (!s) return '';
  const sep  = s.includes('\\') ? '\\' : '/';
  const segs = s.split(/[\\/]+/);
  while (segs.length > 1 && segs[segs.length - 1] === '') segs.pop();  // trailing sep
  const restSegs = String(rest || '').split(/[\\/]+/).filter(Boolean);
  const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  let drop = 0;
  if (restSegs.length && segs.length > restSegs.length &&
      restSegs.every((r, i) => eq(segs[segs.length - restSegs.length + i], r))) {
    drop = restSegs.length;
  } else if (segs.length > 1 && _VP_MEDIA_EXT_RE.test(segs[segs.length - 1])) {
    drop = 1;
  }
  segs.length -= drop;
  let out = segs.join(sep);
  if (/^[A-Za-z]:$/.test(out)) out += sep;   // "M:" alone is CWD-relative — "M:\"
  return out;
}

// (dev0744) The same resolution WITHOUT the prompt — returns null instead of
// asking. For work that is nice to have (the engine chip's EXIF check) rather
// than work the user asked for.
function _vpCropResolveAbsPathCached(relPath) {
  if (!relPath) return null;
  if (/^[A-Za-z]:[\\/]/.test(relPath) || /^\//.test(relPath)) return relPath;
  const slashIdx = relPath.indexOf('/');
  const rootName = (slashIdx >= 0) ? relPath.slice(0, slashIdx) : relPath;
  if (!localStorage.getItem('vpDiskRoot:' + rootName)) return null;
  return _vpCropResolveAbsPath(relPath);
}

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
    const answer = prompt(
      'Crop needs the absolute disk path of the folder "' + rootName + '"\n' +
      'you picked in the slideshow.\n\nExample: M:\\videos\\' + rootName + '\n\n' +
      "Pasting the VIDEO's full path works too — the file part is trimmed off.",
      ''
    );
    if (!answer) return null;
    absRoot = _vpCropAnswerToRoot(answer, rest);
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
// (dev0742) Renders land in a dated subfolder of the source folder —
// YYYYMMDD_edited — so a day's crops/trims stay together instead of silting up
// the video folder, and the `_edited` suffix makes them one Everything search.
// The proxy creates the folder before spawning ffmpeg (it won't make it itself).
// (dev0743) `.edit` recipe files stay BESIDE the original — they belong to the
// source clip, not to a day's output.
function _vpOutDirStamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_edited';
}

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

// ══════════════════════════════════════════════════════════════════════════
// (dev0744) IMAGE CROP — the crop overlay, over a slideshow still
//
// `c` on an image slide opens the same tool the video crop uses. That was the
// whole point of doing it this way: the rect, the 16:9 / 9:16 lock, the tilt
// knob, the thirds grid and the enlargement warning are one implementation,
// and a still is just a source with no clock. What is NOT shared is the
// render, because a JPEG has a lossless answer a video never has.
//
// TWO ENGINES, and the bar always says which one is armed:
//   ⧉ lossless — jpegtran. Copies whole DCT blocks; the surviving pixels are
//     bit-for-bit the original. Available only when nothing else is asked for:
//     a JPEG source, no tilt, resolution "Same", and no EXIF rotation to bake
//     in. The rect is snapped to 16px first (see _vpImgSnapMcu).
//   ↻ re-encode — ffmpeg at -q:v 2. Handles tilt, rescaling and EXIF-rotated
//     originals. Visually indistinguishable, but it is a re-encode and the
//     filename says so.
// ══════════════════════════════════════════════════════════════════════════

// The largest iMCU any JPEG subsampling produces. Snapping the rect to this
// makes the lossless crop EXACT — otherwise jpegtran silently grows the region
// out to the next boundary and hands back something bigger than the box drawn.
const VP_IMG_MCU = 16;

// A duck-typed stand-in for the <video> the overlay was written against. Only
// two properties are ever read (the source pixel dimensions), and an <img>
// spells them differently; the event methods are no-ops because a still never
// fires timeupdate or seeked. Getters, not a snapshot: an <img> that swaps
// src under us reports the new size on the next paint.
function _vpImgAdapter(img) {
  return {
    _img: img,
    get videoWidth()  { return img.naturalWidth  || 0; },
    get videoHeight() { return img.naturalHeight || 0; },
    addEventListener()    {},
    removeEventListener() {}
  };
}

// Is the next save lossless, and if not, what cost it? Drives the bar chip and
// the save itself, so the two can never disagree. `_exif` / `_hasJpegtran` are
// filled in by the async probes at open; until they land the answer leans
// optimistic, and the chip corrects itself a moment later.
function _vpImgLossless(state, row) {
  const name = String((row && (row.comment || row.VidTitle)) || '');
  const ext  = name.split('.').pop().toLowerCase();
  // (dev0745) A clip and burned-in text are both new pixels by definition —
  // there is nothing to copy across. Checked first, since they are the choices
  // the user just made and the likeliest reason the chip changed.
  if (state.motion && state.motion.format !== 'still')
                                       return { ok: false, why: 'a clip' };
  if (state.texts && state.texts.some(t => ((t.ta ? t.ta.value : t.text) || '').trim()))
                                       return { ok: false, why: 'text on it' };
  if (ext !== 'jpg' && ext !== 'jpeg') return { ok: false, why: 'not a JPEG' };
  if (state._hasJpegtran === false)    return { ok: false, why: 'no jpegtran' };
  if (state.angle)                     return { ok: false, why: 'tilted' };
  if (state.resHeight !== 'source')    return { ok: false, why: 'resized' };
  if (state._exif > 1)                 return { ok: false, why: 'EXIF rotation' };
  return { ok: true };
}

// Snap a source-pixel rect onto the iMCU grid, keeping it inside the frame.
// Origin rounds DOWN and size rounds down to a multiple too — except at the
// right/bottom edge, where the last MCU is partial anyway and the crop is
// allowed to run right to it.
function _vpImgSnapMcu(x, y, w, h, VW, VH) {
  const sx = Math.max(0, Math.floor(x / VP_IMG_MCU) * VP_IMG_MCU);
  const sy = Math.max(0, Math.floor(y / VP_IMG_MCU) * VP_IMG_MCU);
  let sw = Math.floor((x + w - sx) / VP_IMG_MCU) * VP_IMG_MCU;
  let sh = Math.floor((y + h - sy) / VP_IMG_MCU) * VP_IMG_MCU;
  if (sx + sw + VP_IMG_MCU > VW) sw = VW - sx;   // runs to the right edge
  if (sy + sh + VP_IMG_MCU > VH) sh = VH - sy;   // …or the bottom one
  return { x: sx, y: sy, w: Math.max(VP_IMG_MCU, sw), h: Math.max(VP_IMG_MCU, sh) };
}

// EXIF orientation of a disk image, as the 1-8 tag value (1 = as stored).
// This matters more than it looks: an <img> applies the tag and ffmpeg and
// jpegtran do not, so on a rotated phone photo the rect the user dragged and
// the rect the encoder would cut are two different rectangles. Returns 1 when
// the probe fails — the overwhelmingly common case is an image with no tag at
// all, and a failed probe should not block a crop the user can see is upright.
async function _vpProbeExifOrientation(absPath) {
  try {
    const r = await fetch(PROXY_BASE + '/exec/exiftool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: absPath, probe: 'image' })
    });
    if (!r.ok) return 1;
    const j = await r.json();
    const rec = j && j.result && (Array.isArray(j.result) ? j.result[0] : j.result);
    const o = rec && +rec.Orientation;
    return (Number.isInteger(o) && o >= 1 && o <= 8) ? o : 1;
  } catch (_) { return 1; }
}

// Open the crop overlay on a slideshow still. Called from slideshow.js's `c`,
// which owns the decision that this slide IS an image and has already frozen
// the picture (the show's own zoom/pan is a CSS transform on the <img>, and
// the overlay's screen→source mapping assumes an untransformed contain-fit).
// (dev0746) `onClose` — what to tear down when the session ends, for callers
// that built their own host (the ?vect= standalone opener). The slideshow
// needs none: its picture was already on screen and stays there.
window._vpImageCropOpen = function (host, img, row, onClose) {
  if (_vpState) return false;                 // V is up — its own crop owns C
  if (!host || !img || !img.naturalWidth) return false;
  const vidLike = _vpImgAdapter(img);
  _vpState = { imageMode: true, row, player: { el: vidLike }, crop: null,
               _img: img, _onClose: (typeof onClose === 'function') ? onClose : null };
  window._vpCurrentRow = row;
  _vpMountCropOverlay(host, vidLike, row, { image: true });
  const s = _vpState.crop;
  if (!s) { _vpState = null; window._vpCurrentRow = null; return false; }
  _vpCropToggle();                            // mounts hidden; this reveals it
  document.addEventListener('keydown', _vpImgKey, true);
  // The two facts the engine chip needs, neither of which is knowable
  // synchronously. Both repaint it when they land.
  _vpProxyHasFeature('jpegtran').then(has => {
    if (_vpState && _vpState.crop === s) { s._hasJpegtran = has; s.paint(); }
  });
  // The orientation probe needs an ABSOLUTE path, and asking for one is a
  // prompt — too rude to fire just for opening the tool. So it runs now only
  // when the folder's disk root is already cached (the usual case after one
  // crop from that folder); otherwise the save does it, before it matters.
  const abs = _vpCropResolveAbsPathCached(row.comment || row.VidTitle || '');
  if (abs) {
    _vpProbeExifOrientation(abs).then(o => {
      if (_vpState && _vpState.crop === s) { s._exif = o; s.paint(); }
    });
  }
  if (typeof toast === 'function') {
    toast('✂ crop this picture — drag the box · ' +
          'T 16:9↔9:16 · ⇧F whole frame · 1/2 tilt · G save · C close', 4200);
  }
  return true;
};

window._vpImageCropClose = function () {
  if (!_vpState || !_vpState.imageMode || _vpState._closing) return;
  _vpState._closing = true;   // _vpCropToggle calls back here — see below
  document.removeEventListener('keydown', _vpImgKey, true);
  const s = _vpState.crop;
  if (s) {
    // Toggling it shut is what hands the slideshow back its chrome and its
    // autopilot (_slideshowCropHold), so it has to happen before disposal.
    if (s.el.container.style.display !== 'none') _vpCropToggle();
    if (typeof s.dispose === 'function') { try { s.dispose(); } catch (_) {} }
    try { s.el.container.remove(); } catch (_) {}
  }
  const onClose = _vpState._onClose;
  _vpState = null;
  window._vpCurrentRow = null;
  // Hand the picture and the clock back to the show.
  if (typeof window._slideshowImageCropDone === 'function') {
    try { window._slideshowImageCropDone(); } catch (_) {}
  }
  // (dev0746) …and take down a host the caller built for us.
  if (onClose) { try { onClose(); } catch (_) {} }
};

// True while a still is being cropped. The slideshow asks before acting on any
// key, since its own handler is registered first and would otherwise advance
// the show out from under the session.
window._vpImageCropActive = function () {
  return !!(_vpState && _vpState.imageMode && _vpState.crop);
};

// Image-mode keys. A deliberate subset of the video crop's: everything about
// the FRAME is here, everything about time is not. Capture phase + stop, so
// the slideshow underneath doesn't also act on them.
function _vpImgKey(e) {
  if (!_vpState || !_vpState.imageMode || !_vpState.crop) return;
  const take = () => { e.preventDefault(); e.stopImmediatePropagation(); };
  // (dev0745) A caption being typed into owns the keyboard, exactly as it does
  // in the video player: ↑ / ↓ size the type, Esc ends the entry, everything
  // else is a character. Tested on e.target rather than an "am I editing" flag
  // for the same reason vpKeyHandler does — core.js's "Esc blurs the field"
  // rule runs first and would clear such a flag before we saw the key.
  if (e.target && e.target.classList &&
      e.target.classList.contains('vp-crop-text-input')) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      take(); _vpTextNudgeSize(e.key === 'ArrowUp' ? 1 : -1); return;
    }
    if (e.key === 'Escape') { take(); _vpTextEndEdit(); return; }
    return;
  }
  const ae = document.activeElement, tag = ae && ae.tagName;
  if (ae && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ae.isContentEditable)) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  // (dev0749) …and stand down for the two menus, same as vpKeyHandler does —
  // both register after this handler, so their letters would be acted on here
  // first. Escape especially: it should shut the menu, not the whole session.
  if (document.getElementById(VP_TEXT_MENU_ID) ||
      document.getElementById(VP_TEXT_PICK_ID)) return;
  if (e.key === 'Escape' || e.key === 'c' || e.key === 'C') { take(); window._vpImageCropClose(); return; }
  if (e.key === 't' || e.key === 'T') { take(); _vpCropSwapAspect(); return; }
  if (e.key === 'F')                  { take(); _vpCropFullFrame();  return; }
  if (e.key === '1' || e.key === '2') {
    take();
    const s = _vpState.crop;
    if (s.setAngle) s.setAngle(s.angle + (e.key === '1' ? -0.5 : 0.5));
    return;
  }
  // (dev0745) E text · Z zoom box · M still/mp4/gif — the three the still half
  // of this tool gained. M is free here because the audio switch it drives on
  // video has nothing to say about a photograph.
  if (e.key === 'e' || e.key === 'E') { take(); _vpTextAdd();   return; }
  if (e.key === 'z' || e.key === 'Z') { take(); _vpKenToggle(); return; }
  if (e.key === 'm' || e.key === 'M') { take(); _vpMotionCycle(); return; }
  if (e.key === 'w' || e.key === 'W') { take(); _vpCropHelpToggleWidth(); return; }
  if (e.key === 'g' || e.key === 'G') { take(); _vpGoSave({ fromButton: true }); return; }
}

// Render the crop. Filename mirrors the video template so a folder of output
// reads the same way, with `img` where the clip's duration goes and the engine
// spelled out: `Base~id~SIZE~L|P~crop~[rNdeg~]img~lossless|q2~.jpg`.
async function _vpImageSave(opts) {
  opts = opts || {};
  const s = _vpState && _vpState.crop;
  const img = _vpState && _vpState._img;
  const row = _vpState && _vpState.row;
  if (!s || !img || !row) return;
  const relPath = row.comment || row.VidTitle || '';
  if (!relPath) { if (typeof toast === 'function') toast('save: no file path on this slide', 2400); return; }
  const absInput = _vpCropResolveAbsPath(relPath);
  if (!absInput) { if (typeof toast === 'function') toast('save cancelled (need folder path)', 2200); return; }
  const parts = _vpSplitPath(absInput);
  if (!parts) { if (typeof toast === 'function') toast('save: cannot parse path', 2400); return; }

  // The orientation probe may have been skipped at open (relative path, so the
  // absolute one wasn't known yet without prompting). Do it now — a wrong
  // answer here means cutting the wrong part of the picture.
  if (s._exif == null) { s._exif = await _vpProbeExifOrientation(absInput); s.paint(); }
  if (s._hasJpegtran == null) { s._hasJpegtran = await _vpProxyHasFeature('jpegtran'); s.paint(); }
  if (!(await _vpProxyHasFeature('imagecrop'))) {
    if (typeof toast === 'function') {
      toast('Image crop needs an updated proxy — restart "node proxy.js" and retry', 4200);
    }
    return;
  }
  // (dev0745) The same rule the video path follows for every new payload key:
  // a proxy that doesn't know about it drops it silently and writes a file
  // that LOOKS like a success. Refuse loudly instead.
  const wantsText   = (s.texts || []).some(t => ((t.ta ? t.ta.value : t.text) || '').trim());
  const wantsMotion = !!(s.motion && s.motion.format !== 'still');
  if (wantsText && !(await _vpProxyHasFeature('imagetext'))) {
    if (typeof toast === 'function') {
      toast('Text on a picture needs an updated proxy — restart "node proxy.js" and retry', 4400);
    }
    return;
  }
  // (dev0750) A face other than the default one is a separate ask of the proxy:
  // an old one draws every caption in Segoe UI Symbol, silently.
  if (wantsText && (s.texts || []).some(t => _vpTextFont(t.font).id !== VP_TEXT_FONT_DEF) &&
      !(await _vpProxyHasFeature('textfont'))) {
    if (typeof toast === 'function') {
      toast('Choosing the font needs an updated proxy — restart "node proxy.js" and retry', 4400);
    }
    return;
  }
  // (dev0751) A caption on a picture whose format can hold an alpha channel: an
  // old proxy lets drawtext punch letter-shaped holes in it, and what comes back
  // is a dark smudge where a faint stamp should be. The file is written and the
  // exit code is 0, so nothing else would tell them.
  if (wantsText && !wantsMotion && /^(png|webp)$/i.test(parts.ext) &&
      !(await _vpProxyHasFeature('textalphakeep'))) {
    if (typeof toast === 'function') {
      toast('Text on a ' + parts.ext.toLowerCase() +
            ' needs an updated proxy — restart "node proxy.js" and retry', 4600);
    }
    return;
  }
  // (dev0752) A faded box is a watermark, and a watermark is drawn without the
  // outline an opaque caption gets — the overlay has already dropped its shadow
  // to say so. An old proxy still rings it in black, at 7% of the type size.
  if (wantsText && (s.texts || []).some(t => t.alpha != null && t.alpha < 1) &&
      !(await _vpProxyHasFeature('textalpha') && await _vpProxyHasFeature('textnoborder'))) {
    if (typeof toast === 'function') {
      toast('Faded text needs an updated proxy — restart "node proxy.js" and retry', 4400);
    }
    return;
  }
  // (dev0753) …and a colour it doesn't know about comes back white, which on a
  // light picture is the difference between a watermark and a blank.
  if (wantsText && (s.texts || []).some(t => _vpTextColor(t.color).id !== VP_TEXT_COLOR_DEF) &&
      !(await _vpProxyHasFeature('textcolor'))) {
    if (typeof toast === 'function') {
      toast('Coloured text needs an updated proxy — restart "node proxy.js" and retry', 4400);
    }
    return;
  }
  if (wantsMotion && !(await _vpProxyHasFeature('imagemotion'))) {
    if (typeof toast === 'function') {
      toast('Clips from a picture need an updated proxy — restart "node proxy.js" and retry', 4400);
    }
    return;
  }

  const VW = img.naturalWidth, VH = img.naturalHeight;
  if (!VW || !VH) { if (typeof toast === 'function') toast('save: image not measured yet', 2200); return; }
  const even = n => Math.max(2, Math.floor(n / 2) * 2);
  // (dev0745) A gif is uncompressed-ish frames with a 256-colour palette: a
  // full-resolution one runs to hundreds of megabytes and takes minutes. Say
  // so BEFORE the encode rather than after it, with the number that matters.
  if (wantsMotion && s.motion.format === 'gif') {
    const gw = even(s.frac.w * VW), gh = even(s.frac.h * VH);
    const short = (s.resHeight === 'source') ? Math.min(gw, gh) : +s.resHeight;
    if (short > 720) {
      const ok = confirm('⚠ Big gif\n\nThis one is ' + short + 'p for ' + s.motion.durSec +
        's at 15fps — gifs that size run to hundreds of MB and take minutes.\n\n' +
        'Dropping the resolution to 720p or lower is the usual answer.\n\nEncode anyway?');
      if (!ok) { if (typeof toast === 'function') toast('save cancelled', 1600); return; }
    }
  }
  const id = prompt('Save name/ID for this crop:', '');
  if (!id) { if (typeof toast === 'function') toast('save cancelled', 1600); return; }
  const safeId = id.replace(/[<>:"/\\|?*~]/g, '_').trim() || 'unnamed';

  const verdict = _vpImgLossless(s, row);
  const moving  = !!(s.motion && s.motion.format !== 'still');
  // A clip names its own container; a still keeps the source's format where
  // ffmpeg can write it (png/webp stay lossless), else lands as JPEG.
  const outExt = moving ? s.motion.format
               : (verdict.ok ? parts.ext
                             : (/^(png|webp)$/i.test(parts.ext) ? parts.ext : 'jpg'));
  const outDir = parts.dir + parts.sep + _vpOutDirStamp();
  let payload, route, sizeStr, engTok;

  if (verdict.ok) {
    // Lossless: no tilt and no scale by definition, so the rect maps straight
    // onto the stored pixels — snapped to the block grid so jpegtran cuts
    // exactly here rather than rounding outward on its own.
    const box = _vpImgSnapMcu(
      Math.round(s.frac.x * VW), Math.round(s.frac.y * VH),
      Math.round(s.frac.w * VW), Math.round(s.frac.h * VH), VW, VH);
    sizeStr = Math.min(box.w, box.h) + 'p';
    engTok  = 'lossless';
    route   = 'jpegtran';
    payload = { input: absInput, crop: box, overwrite: false };
  } else {
    // Re-encode. Tilt is handled exactly as the video path handles it: rotate
    // the whole frame onto an expanded square so the tilted rect is
    // axis-aligned, and express the crop in THAT canvas.
    const sw = even(s.frac.w * VW), sh = even(s.frac.h * VH);
    sizeStr = (s.resHeight === 'source') ? (Math.min(sw, sh) + 'p') : (s.resHeight + 'p');
    engTok  = 'q2';
    route   = 'ffmpeg';
    const angle = s.angle || 0;
    let cropBox, rotate = null;
    if (!angle) {
      cropBox = { w: sw, h: sh, x: even(s.frac.x * VW), y: even(s.frac.y * VH) };
    } else {
      const a = -angle * Math.PI / 180;
      const D = even(Math.ceil(Math.hypot(VW, VH)));
      const cx = (s.frac.x + s.frac.w / 2) * VW, cy = (s.frac.y + s.frac.h / 2) * VH;
      const u = cx - VW / 2, v = cy - VH / 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const ccx = D / 2 + (ca * u - sa * v), ccy = D / 2 + (sa * u + ca * v);
      cropBox = {
        w: sw, h: sh,
        x: Math.max(0, Math.min(D - sw, even(Math.round(ccx - sw / 2)))),
        y: Math.max(0, Math.min(D - sh, even(Math.round(ccy - sh / 2))))
      };
      rotate = { rad: a, ow: D, oh: D };
    }
    payload = {
      image: true, input: absInput, crop: cropBox,
      aspect: s.aspect, resHeight: s.resHeight, quality: 2, overwrite: false
    };
    if (rotate) payload.rotate = rotate;
    // An EXIF-rotated original is baked upright first, so the rect means what
    // it looked like it meant on screen.
    if (s._exif > 1) payload.exif = s._exif;
    // (dev0745) Captions. Wrapped here at the size ffmpeg will draw them, in
    // the OUTPUT frame's pixels — and always for the whole picture, since a
    // still has no clock to window them against.
    const dims = _vpOutputDims(s, sw, sh);
    const tr = _vpTextRenderList(s, dims.ow, dims.oh, 0, 0);
    const toks = [];
    if (tr.texts.length) {
      payload.texts = tr.texts;
      toks.push('txt' + tr.texts.length);
      // A faded caption is a watermark, and the filename should say so — that
      // is the difference between a file you can publish and one you can't.
      if (tr.texts.some(t => t.alpha != null)) toks.push('wm');
    }
    // (dev0745) …and the clip, if one was asked for. The zoom box comes along
    // when it is armed; without it the picture is simply held for the duration.
    if (s.motion && s.motion.format !== 'still') {
      const fmt = s.motion.format;
      payload.motion = { durSec: s.motion.durSec, format: fmt,
                         fps: (fmt === 'gif') ? 15 : 30 };
      if (s.ken && s.ken.on) {
        payload.ken = { x: s.ken.frac.x, y: s.ken.frac.y, w: s.ken.frac.w, h: s.ken.frac.h };
        toks.push('kb');
      }
      toks.push(fmt + s.motion.durSec + 'sec');
    }
    if (toks.length) engTok = toks.join('~');
  }

  const angTok = s.angle ? ('r' + s.angle.toFixed(1).replace('.', '_') + 'deg') : '';
  const nameParts = [parts.base, safeId, sizeStr, s.aspect, 'crop'];
  if (angTok) nameParts.push(angTok);
  nameParts.push('img', engTok);
  const outName = nameParts.join('~') + '~.' + outExt;
  payload.output = outDir + parts.sep + outName;

  const btn = s.el.bar.querySelector('#vp-crop-do');
  const origLabel = btn ? btn.textContent : null;
  const restore = () => { if (btn) { btn.disabled = false; btn.textContent = origLabel; } };
  const run = async () => {
    try {
      // A clip has a real duration to count progress against; a still is done
      // before the label can say anything useful.
      return await _vpCropRun(payload, btn, moving ? s.motion.durSec * 1000 : 0, route);
    } catch (err) {
      // jpegtran has no -n, so the proxy refuses an existing output with a 400
      // rather than a non-zero exit. Same situation, different shape — fold it
      // back into one so the overwrite prompt below covers both engines.
      const msg = (err && err.message) || String(err);
      if (/already exists/i.test(msg)) return { exitCode: 1, stderr: [msg], lastProgress: null };
      throw err;
    }
  };
  try {
    let result = await run();
    // Exit code plays no part — see the note on the video path: an ffmpeg that
    // refuses -n still exits 0. (jpegtran's refusal arrives as a 400, folded
    // into the same shape by run() above.)
    if (_vpCropStderrSaysExists(result.stderr)) {
      restore();
      if (!confirm('"' + outName + '" already exists. Overwrite?')) {
        if (typeof toast === 'function') toast('save cancelled', 1600);
        return;
      }
      payload.overwrite = true;
      result = await run();
    }
    if (result.exitCode !== 0 && _vpCropStderrSaysNotFound(result.stderr)) {
      restore();
      const slashIdx = relPath.indexOf('/');
      const rootName = (slashIdx >= 0) ? relPath.slice(0, slashIdx) : relPath;
      if (confirm('Could not find:\n  ' + absInput +
                  '\n\nClear cached disk path for folder "' + rootName + '" and retry?')) {
        localStorage.removeItem('vpDiskRoot:' + rootName);
        return _vpImageSave(opts);
      }
      if (typeof toast === 'function') toast('save failed: file not found', 2600);
      return;
    }
    restore();
    if (result.exitCode === 0) {
      if (typeof toast === 'function') {
        toast((verdict.ok ? '⧉ saved lossless → ' : '↻ saved → ') + outName, 3400);
      }
    } else {
      const tail = result.stderr.slice(-1)[0] || ('exit ' + result.exitCode);
      if (typeof toast === 'function') toast('save failed: ' + tail, 4200);
      console.error('[image save failed]', { route, exitCode: result.exitCode, payload, stderr: result.stderr });
    }
  } catch (err) {
    restore();
    const msg = (err && err.message) || String(err);
    if (typeof toast === 'function') toast('save error: ' + msg, 3600);
    console.error('[image save error]', err);
  }
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
  // (dev0744) The same button, one screen over: on a still there is no A→B to
  // check and no ffmpeg clip to build, so the image path takes it from here.
  if (_vpState && _vpState.imageMode) return _vpImageSave(opts);
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
  // (dev0742) Both paths below write into <source folder>/YYYYMMDD/.
  const outDir = parts.dir + parts.sep + _vpOutDirStamp();
  // Crop overlay visible → crop+scale. Else → lossless trim.
  const cropOn = !!(_vpState.crop && _vpState.crop.el.container.style.display !== 'none');
  const vid = _vpState.player && _vpState.player.el;
  // (dev0717) Enlargement preflight, deliberately BEFORE the name prompt — the
  // fix is to resize the rect or drop the output res, not to rename. Only the
  // crop path scales; the lossless trim is exempt.
  if (cropOn && vid) {
    const s0 = _vpState.crop;
    const even0 = n => Math.max(2, Math.floor(n / 2) * 2);
    const sw0 = even0(s0.frac.w * (vid.videoWidth  || 0));
    const sh0 = even0(s0.frac.h * (vid.videoHeight || 0));
    const up  = _vpCropUpscaleFactor(s0, sw0, sh0);
    if (up > 1.005) {
      // (dev0720) With a Ken Burns move the tightest framing is the amber box,
      // not the crop — say so, and quote the size the zoom actually ends on.
      const kenOn = !!(s0.ken && s0.ken.on);
      const kf = kenOn ? s0.ken.frac.w : 1;
      const srcShort = Math.round(((s0.aspect === 'P') ? sw0 : sh0) * kf);
      const what = kenOn
        ? ('Ken Burns ends on ' + Math.round(sw0 * kf) + ' × ' + Math.round(sh0 * kf) +
           ' source pixels\n(inside a ' + sw0 + ' × ' + sh0 + ' crop).')
        : ('Crop rect is ' + sw0 + ' × ' + sh0 + ' source pixels.');
      const ok = confirm(
        '⚠ Pixel enlargement\n\n' +
        what + ' Its short side (' +
        srcShort + 'px)\nis under the ' + s0.resHeight + 'p output, so ffmpeg would upscale it ' +
        up.toFixed(2) + '×.\n\nThat adds no detail — only encode time and file size.\n\n' +
        'Enlarge the ' + (kenOn ? 'Ken Burns box' : 'crop rect') +
        ', or pick a lower output resolution.\n\nEncode anyway?');
      if (!ok) {
        if (typeof toast === 'function') toast('save cancelled — would enlarge pixels', 2400);
        return;
      }
    }
  }
  const id = prompt('Save name/ID for this clip:', '');
  if (!id) { if (typeof toast === 'function') toast('save cancelled', 1600); return; }
  const safeId = id.replace(/[<>:"/\\|?*~]/g, '_').trim() || 'unnamed';
  const startSec = Math.min(_vpState.aPoint, _vpState.bPoint);
  const endSec   = Math.max(_vpState.aPoint, _vpState.bPoint);
  const durStr = _vpDurStr(endSec - startSec);
  let outName, payload, kenPayload = null;   // (dev0720) kenPayload: zoom ramp
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
    // (dev0720) Ken Burns: the amber box is where the zoom ENDS, reached at the
    // frame it was placed on and held from there to B. Sent as fractions of the
    // crop window plus that landing time relative to A; the proxy turns them
    // into a zoompan ramp. Needs the source frame rate, since zoompan re-times
    // the stream — probe it, and stand down rather than guess if that fails.
    let kenTok = '';
    if (s.ken && s.ken.on) {
      const fps = await _vpProbeFps(absInput);
      if (!fps) {
        if (typeof toast === 'function') {
          toast('Ken Burns needs the source frame rate and ffprobe could not read it — ' +
                'press Z to turn the zoom off, or fix the proxy', 4600);
        }
        return;
      }
      const k = s.ken;
      kenPayload = {
        x: k.frac.x, y: k.frac.y, w: k.frac.w, h: k.frac.h,
        holdSec: Math.max(0, Math.min(endSec - startSec, k.atSec - startSec)),
        fps: fps
      };
      kenTok = 'kb' + (1 / k.frac.w).toFixed(1).replace('.', '_') + 'x';
      nameParts.push(kenTok);
    }
    // (dev0724) Burned-in captions. Wrapped HERE, at the size ffmpeg will draw
    // them (drawtext can't wrap), and dropped entirely when every box is empty.
    const dims  = _vpOutputDims(s, sw, sh);
    const tr    = _vpTextRenderList(s, dims.ow, dims.oh, startSec, endSec);
    const texts = tr.texts, pauses = tr.pauses;
    if (texts.length)  nameParts.push('tx' + texts.length);
    if (pauses.length) nameParts.push('pz' + pauses.length);
    nameParts.push(durStr);
    outName = nameParts.join('~') + '~.mp4';
    payload = {
      input: absInput,
      output: outDir + parts.sep + outName,
      crop: cropBox,
      crf: s.crf,
      preset: s.slow ? 'slow' : 'medium',
      aspect: s.aspect, resHeight: s.resHeight,
      audio: !!s.audio,               // (dev0719) bar's 🔇/🔊 switch → -an / -c:a copy
      trim: { startSec, endSec },
      overwrite: false
    };
    if (rotate) payload.rotate = rotate;
    if (kenPayload) payload.ken = kenPayload;   // (dev0720)
    if (texts.length) payload.texts = texts;    // (dev0724)
    // (dev0727) Freeze frames. They make the video longer than its soundtrack,
    // so the render goes silent whatever the M switch says — say so rather than
    // hand back a clip that drifts further out of sync the longer it runs.
    if (pauses.length) {
      payload.pauses = pauses;
      if (payload.audio) {
        payload.audio = false;
        if (typeof toast === 'function') {
          toast('⏸ a pause makes the picture longer than the sound — this render is silent', 3600);
        }
      }
    }
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
      output: outDir + parts.sep + outName,
      trim: { startSec, endSec },
      overwrite: false
      // No `crop` → builder takes the lossless -c copy path.
    };
  }
  // (dev0319) Deskew preflight — a stale proxy silently ignores payload.rotate
  // and applies the rotated-canvas crop coords to the raw frame (grabs the wrong
  // region, no deskew). Refuse loudly instead of writing a mis-cropped file.
  if (payload.rotate && !(await _vpProxyHasFeature('rotate'))) {
    if (typeof toast === 'function') toast('Deskew needs an updated proxy — restart "node proxy.js" and retry', 4000);
    return;
  }
  // (dev0719) Same for the silent-output switch: a stale proxy ignores
  // payload.audio and stream-copies the soundtrack in anyway. That's a quiet
  // wrong answer on a long encode, so refuse it the same way.
  if (payload.audio === false && !(await _vpProxyHasFeature('noaudio'))) {
    if (typeof toast === 'function') {
      toast('Silent output needs an updated proxy — restart "node proxy.js", ' +
            'or press M for 🔊 audio and retry', 4600);
    }
    return;
  }
  // (dev0720) …and the zoom: an old proxy drops payload.ken and renders a static
  // crop, which looks like a success until you play it back.
  if (payload.ken && !(await _vpProxyHasFeature('kenburns'))) {
    if (typeof toast === 'function') {
      toast('Ken Burns needs an updated proxy — restart "node proxy.js" and retry', 4200);
    }
    return;
  }
  // (dev0724) …and the captions: an old proxy ignores payload.texts and writes a
  // clean clip with no text in it, which reads as success until you play it.
  if (payload.texts && !(await _vpProxyHasFeature('drawtext'))) {
    if (typeof toast === 'function') {
      toast('Burned-in text needs an updated proxy — restart "node proxy.js" and retry', 4400);
    }
    return;
  }
  // (dev0745) …and a faded caption on a stale proxy comes out at full strength,
  // which is a watermark that ruins the picture it was meant to sit quietly on.
  // (dev0752) Same trigger, second ask: a faded box is drawn with no outline and
  // the overlay has already stopped showing one, so an old proxy rings it in
  // black anyway and the preview turns out to have been a promise it can't keep.
  if ((payload.texts || []).some(t => t.alpha != null) &&
      !(await _vpProxyHasFeature('textalpha') && await _vpProxyHasFeature('textnoborder'))) {
    if (typeof toast === 'function') {
      toast('Faded text needs an updated proxy — restart "node proxy.js" and retry', 4400);
    }
    return;
  }
  // (dev0750) …and the same for the face. A stale proxy draws every caption in
  // Segoe UI Symbol whatever was picked, which on a headline font is the wrong
  // wrap as well as the wrong letters.
  // (dev0753) …and the same for the fill, which an old proxy draws white.
  if ((payload.texts || []).some(t => t.color) && !(await _vpProxyHasFeature('textcolor'))) {
    if (typeof toast === 'function') {
      toast('Coloured text needs an updated proxy — restart "node proxy.js" and retry', 4400);
    }
    return;
  }
  if ((payload.texts || []).some(t => t.font) && !(await _vpProxyHasFeature('textfont'))) {
    if (typeof toast === 'function') {
      toast('Choosing the font needs an updated proxy — restart "node proxy.js" and retry', 4400);
    }
    return;
  }
  // (dev0727) …and the freeze frames, which an old proxy would drop — leaving a
  // clip that plays straight through with the captions at the wrong moments.
  if (payload.pauses && !(await _vpProxyHasFeature('vpause'))) {
    if (typeof toast === 'function') {
      toast('Pauses need an updated proxy — restart "node proxy.js" and retry', 4400);
    }
    return;
  }
  // (dev0727) Freezes lengthen the output, so the progress bar has to count them
  // too or it reads 100% while ffmpeg is still writing.
  const holdMs = (payload.pauses || []).reduce((n, p) => n + p.hold * 1000, 0);
  const totalMs = Math.max(0, (endSec - startSec) * 1000 + holdMs);
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
    // (dev0744) NOT gated on a non-zero exit: ffmpeg refuses -n by printing
    // "already exists" and then exiting 0 (verified on the current build), so
    // requiring a failure code here meant the overwrite prompt never appeared
    // and the toast said "saved" for a render that never happened.
    if (_vpCropStderrSaysExists(result.stderr)) {
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

// (dev0319) Capability check — true only if the proxy advertises the named
// feature at GET /version. A stale proxy (or any without /version) returns
// false, letting the caller refuse the job instead of writing a wrong file.
// (dev0719) Generalized from _vpProxySupportsRotate; 'noaudio' joined 'rotate'.
async function _vpProxyHasFeature(name) {
  try {
    const r = await fetch(PROXY_BASE + '/version', { method: 'GET' });
    if (!r.ok) return false;
    const j = await r.json();
    return !!(j && Array.isArray(j.features) && j.features.includes(name));
  } catch (_) { return false; }
}

// (dev0720) Source frame rate, as ffprobe's exact rational string ("30000/1001",
// "25/1") — handed to zoompan verbatim so the Ken Burns pass re-times the stream
// to exactly what came in. HTMLVideoElement exposes no frame rate, hence the
// round trip. Returns null when the probe fails or answers something unusable;
// the caller refuses the render rather than inventing 30fps and juddering it.
async function _vpProbeFps(absPath) {
  try {
    const r = await fetch(PROXY_BASE + '/exec/ffprobe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: absPath, streams: true })
    });
    if (!r.ok) return null;
    const j = await r.json();
    const st = j && j.result && Array.isArray(j.result.streams) && j.result.streams[0];
    if (!st) return null;
    // r_frame_rate is the container's nominal rate; avg_frame_rate can read 0/0
    // on some captures, so prefer r_ and fall back.
    for (const cand of [st.r_frame_rate, st.avg_frame_rate]) {
      const m = /^(\d+)\/(\d+)$/.exec(String(cand || ''));
      if (m && +m[1] > 0 && +m[2] > 0) return m[1] + '/' + m[2];
      const n = parseFloat(cand);
      if (Number.isFinite(n) && n > 0) return String(n);
    }
    return null;
  } catch (_) { return null; }
}

// (dev0289) One request/response cycle to /exec/ffmpeg. Resolves with
// {exitCode, stderr[], lastProgress}. Throws only on network/fetch error.
//
// (dev0293) `btn` is now duck-typed: may be a real <button>, a plain <div>,
// or any object with a writable `textContent`. The `disabled` property is
// set only if present — divs don't have it, so they're spared the noise.
// (dev0744) `route` names the /exec binary — 'ffmpeg' unless the image crop
// sends this down the lossless 'jpegtran' path, which streams the same NDJSON
// (no progress lines; the exit code carries the verdict).
async function _vpCropRun(payload, btn, totalMs, route) {
  const setLabel = s => { if (btn) btn.textContent = s; };
  const setDisabled = b => { if (btn && 'disabled' in btn) btn.disabled = b; };
  setDisabled(true);
  setLabel('0%');
  const res = await fetch(PROXY_BASE + '/exec/' + (route || 'ffmpeg'), {
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
  // (dev0740) No ⤓ and no native "Save video as…" here — this is the viewer's
  // player. See salLockDownVideo: it removes the offer, not the ability.
  if (window.salLockDownVideo) window.salLockDownVideo(vid);
  if (seg && seg.start) vid.currentTime = seg.start;
  host.appendChild(vid);
  _vpMountDiskInfoOverlay(host, vid, window._vpCurrentRow);
  _vpMountCropOverlay(host, vid, window._vpCurrentRow);
  // (dev0747) Opened from the file manager → start cropping straight away. The
  // rect is sized from the video's dimensions, which are not known until
  // metadata arrives, so wait for it (or fire now if it already has).
  // Consumed here, not by the caller: this mount runs on a timeout, so by the
  // time it happens the caller's own line has long since executed.
  const autoCrop = window._vectAutoCrop;
  window._vectAutoCrop = false;
  if (autoCrop && _vpState && _vpState.crop) {
    const open = () => {
      if (_vpState && _vpState.crop &&
          _vpState.crop.el.container.style.display === 'none') _vpCropToggle();
    };
    if (vid.videoWidth) open();
    else vid.addEventListener('loadedmetadata', open, { once: true });
  }
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
  // (dev0718) …and not while a crop is open — the clip parks on its last frame
  // instead of the show marching on to the next file mid-edit.
  vid.addEventListener('ended', () => {
    if (_vpCropHolding()) return;
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
          _vpYtNudgePlay(e.target);   // (dev0642) mute-fallback if unmuted play is refused
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
// (dev0606) ── Cross-origin embed gestures in V — shared by IG and TikTok ─────
// Both are sandboxed cross-origin players: the ONLY way to start one is a real
// click landing on its own play button, and over its pixels the parent gets NO
// pointer events — so "gesture anywhere" and "click-to-play" can never share
// those pixels. This is the settled split (dev0602/0603): the frame is left
// alone so it stays clickable, and swipe-back lives everywhere the frame isn't.
//
// GENERAL RULE: every new cross-origin view-only embed in V must call this, or
// #vp-swipe-catcher (z:50, covers the whole host, cursor:zoom-in) eats the play
// click and the embed looks dead — the exact dev0292 crop-UI failure, which the
// comment at ~3175 names symptom-for-symptom.
//
//   wrap     black letterbox filling the host (must set touch-action:none)
//   clipBox  the embed's own box — gets a 44px swipe lane down its right edge
//   stripId  element id for that lane
// (dev0612) ── Zoom as a MODE for cross-origin embeds ────────────────────────
// V's hold-to-enlarge / drag-to-pan / dblclick-to-reset lives entirely on
// #vp-swipe-catcher (wireMouseV, ~line 562) and works by transforming `host` —
// it never reaches into the iframe, which is why it magnifies a cross-origin
// embed just as happily as it does YouTube. The obstacle was never the zoom: the
// catcher must stay inert for an embed (see below) or the play click never
// lands, and one set of pixels cannot both start IG and capture a hold-gesture.
//
// So arming is explicit. `on` hands the pixels to the catcher for as long as the
// user is reframing; `off` gives them back so pause/replay reach the player. The
// zoom SURVIVES a disarm on purpose — reframe, disarm, then poke the player.
// That leaves a transform on host, which makes host a stacking context and
// paints the z:60 swipe strip under the z:50 catcher (the dev0292 shape); it is
// harmless here because an inert catcher does not hit-test at all, so the strip
// still receives the swipe.
//
// The toggle lives in the toolbar, which is OUTSIDE host and so stays clickable
// whatever the iframe is doing. A modifier-key gate (what G uses) would die the
// moment the play click moves focus into the cross-origin frame and the parent
// stops seeing keydown — i.e. exactly once the video is playing.
function _vpEmbedZoomArm(on) {
  var sc = document.getElementById('vp-swipe-catcher');
  if (sc) {
    sc.style.pointerEvents = on ? 'auto' : 'none';
    sc.style.cursor        = on ? 'zoom-in' : 'default';
  }
  var btn = document.getElementById('vp-embed-zoom');
  if (btn) {
    btn.style.background = on ? '#06f' : '#222';
    btn.style.color      = on ? '#fff' : '#888';
    btn.title = on
      ? 'Zoom armed (z) — hold to enlarge, drag to pan, double-click for usual size. Click to hand the picture back to the player.'
      : 'Arm zoom (z) — hold to enlarge, drag to pan, double-click for usual size.';
  }
  window._vpEmbedZoomArmed = !!on;
}

// The ⤢ toggle itself. Sized to sit left of an "↗ Open on …" button in a flex
// row. Any cross-origin embed mount can drop this in; only IG uses it so far.
function _vpBuildEmbedZoomToggle() {
  var btn = document.createElement('button');
  btn.id = 'vp-embed-zoom';
  btn.textContent = '⤢';
  btn.style.cssText = 'flex:0 0 34px;height:24px;background:#222;color:#888;'
    + 'border:0;border-radius:4px;font-size:13px;font-weight:bold;line-height:1;'
    + 'cursor:pointer;';
  btn.addEventListener('click', function(e) {
    e.stopPropagation();
    _vpEmbedZoomArm(!window._vpEmbedZoomArmed);
  });
  return btn;
}

function _vpWireEmbedGestures(wrap, clipBox, stripId) {
  // Neutralize the catcher outright. Shrinking it (what direct video does — it
  // only needs the native control strip) can't help: an embed needs its CENTRE.
  // The catcher is rebuilt on every V open, so there's nothing to restore.
  // (dev0612) Inert is now the DEFAULT rather than the permanent state — the
  // toolbar ⤢ toggle can hand these pixels back for a reframe. This call also
  // clears _vpEmbedZoomArmed for the new mount.
  _vpEmbedZoomArm(false);

  // Swipe-back lane down the embed's right edge (z:60 inside clipBox). The
  // letterbox alone can't carry the gesture — on a phone it shrinks to ~10px.
  // Costs the embed its rightmost 44px; play buttons are centred, so nothing
  // playable is lost. Bubbles into wrap's handler — no separate wiring.
  var strip = document.createElement('div');
  strip.id = stripId;
  strip.style.cssText = 'position:absolute;top:0;right:0;width:44px;height:100%;'
    + 'z-index:60;background:transparent;touch-action:none;cursor:w-resize;';
  clipBox.appendChild(strip);

  // Swipe-close on `wrap` (letterbox + strip above). Pointer capture lets a
  // swipe that STARTS there keep tracking across the embed. Deliberately
  // swipe-close only — no zoom/pan (see the stacking note above), no
  // tap-to-play (vpTogglePlay can't drive these players), no double-tap.
  var sw = null;
  var xy = function(e) {
    return window.rotateXY ? window.rotateXY(e) : { x: e.clientX, y: e.clientY };
  };
  wrap.addEventListener('pointerdown', function(e) {
    var p = xy(e);
    sw = { x: p.x, y: p.y, t: Date.now() };
    try { wrap.setPointerCapture(e.pointerId); } catch (_) {}
  });
  wrap.addEventListener('pointerup', function(e) {
    if (!sw) return;
    var p = xy(e);
    var dx = p.x - sw.x, dy = p.y - sw.y;
    var ms = Date.now() - sw.t;
    sw = null;
    // Mirrors the catcher's R→L rule (vp.js ~518): >40px, mostly horizontal,
    // under 1.5s. The slideshow signal is a no-op outside a slideshow.
    if (dx < -40 && Math.abs(dy) < Math.abs(dx) && ms < 1500) {
      if (window._slideshowVideoSwipe) window._slideshowVideoSwipe(1);
      vpClose();
    }
  });
  wrap.addEventListener('pointercancel', function() { sw = null; });
}

function vpMountInstagram(host, link) {
  host.innerHTML = '';
  // (dev0611) Was a private copy of the shortcode regex, which is exactly how it
  // rotted: dev0610 taught video.js that the author-prefixed "/<author>/reel/
  // <id>/" form is an IG link, but this copy still demanded "/reel/<id>/" and
  // bailed. host was already cleared, so V painted BLACK — toolbar, no frame —
  // for every harvested row, while G (which calls instagramEmbedUrl) showed it
  // fine. One source of truth now; do NOT re-inline this.
  var src = window.instagramEmbedUrl ? window.instagramEmbedUrl(link) : '';
  if (!src) return;

  // Clip chrome via an overflow:hidden box that's shorter than the iframe.
  // Iframe is sized W×(W*2.5) and offset top:-(W*0.16) so the header sits
  // above the visible region and the footer sits below it. Numbers tuned
  // for IG's reel embed layout at common widths (~400-440 wide).
  var wrap = document.createElement('div');
  wrap.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;'
    + 'justify-content:center;background:#000;touch-action:none;';
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

  // (dev0602/0603, shared since dev0606) Free the swipe-catcher so IG's play
  // caret is clickable, and rebuild swipe-close on the letterbox + right-edge
  // strip. See _vpWireEmbedGestures for the whole rationale.
  _vpWireEmbedGestures(wrap, clipBox, 'vp-ig-swipe-strip');

  // Replace the seek-bar (timelineRow — first child of #vp-toolbar) with an
  // "Open on Instagram" gradient button. The bar's playback markers / scrub
  // are useless without a JS API; reusing that real estate keeps the visible
  // chrome consistent. Prev/Play/Next/Close stay in the row below.
  var toolbar = document.getElementById('vp-toolbar');
  if (toolbar && toolbar.firstElementChild) {
    var tlRow = toolbar.firstElementChild;
    tlRow.style.display = 'none';
    // (dev0612) The reclaimed seek-bar row now carries two buttons: the ⤢
    // zoom-arm toggle and the open-on-IG link.
    var igRow = document.createElement('div');
    igRow.style.cssText = 'display:flex;gap:4px;height:24px;margin:0 0 4px 0;';
    var openBtn = document.createElement('button');
    openBtn.id = 'vp-ig-open';
    openBtn.textContent = '↗ Open on Instagram';
    openBtn.style.cssText = 'flex:1;height:24px;'
      + 'background:linear-gradient(135deg,#833ab4 0%,#fd1d1d 50%,#fcb045 100%);'
      + 'color:#fff;border:0;border-radius:4px;font-family:monospace;font-weight:bold;'
      + 'font-size:12px;letter-spacing:0.04em;cursor:pointer;'
      + 'text-shadow:0 1px 2px rgba(0,0,0,0.4);';
    openBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      window.open(link, '_blank', 'noopener');
    });
    igRow.appendChild(_vpBuildEmbedZoomToggle());
    igRow.appendChild(openBtn);
    toolbar.insertBefore(igRow, tlRow);
  }

  // (dev0671) ── Auto-prime + focus recapture ────────────────────────────────
  // Same two problems G has, same two answers. IG hands the embed ONE inline
  // play and there is no way to hear it end from out here, so the clip is timed
  // (ig.json durSecs via the proxy — a local read, no IG traffic, nothing
  // downloaded) and a fresh iframe is swapped in when it must have finished.
  // V then sits ready to replay on a single click instead of offering to open
  // the post on instagram.com.
  //
  // The blur is doing double duty. It is the only signal that a click actually
  // reached the embed — i.e. that the play has started and the clock should run
  // — and it is also the moment V's keyboard is lost: focus moves into a
  // cross-origin document and Esc/←/→ are delivered there, where we can neither
  // read them nor ask for them back. Taking focus straight back costs the embed
  // nothing (the click has already landed; there is no JS API whose keyboard we
  // would want) and keeps V's keys alive after a play. Ported from dev0607,
  // which fixed exactly this in G.
  if (window.igMetaFetch) window.igMetaFetch([link]);
  var primeTmr = 0;
  var onBlur = function() {
    setTimeout(function() {
      if (document.activeElement !== iframe) return;   // focus went elsewhere — not ours
      try { iframe.blur(); } catch (e) {}
      if (document.hasFocus()) { try { window.focus(); } catch (e) {} }
      clearTimeout(primeTmr);
      primeTmr = setTimeout(function() {
        if (!iframe.isConnected) return;
        iframe.src = src;                              // fresh instance = a new play
        if (typeof toast === 'function') toast('↻ primed — click ▶ to play it again', 1600);
      }, window.igClipDwellMs ? window.igClipDwellMs(link) : 41200);
    }, 0);
  };
  window.addEventListener('blur', onBlur);

  // Stub player so generic toolbar code that pokes _vpState.player doesn't
  // throw. No interval — the timeline stays at zero.
  if (typeof _vpState === 'object' && _vpState) {
    _vpState.player = { isInstagram: true,
      pauseVideo: function(){}, playVideo: function(){},
      destroy: function(){
        clearTimeout(primeTmr);
        window.removeEventListener('blur', onBlur);    // (dev0671) don't outlive the mount
        try { iframe.src = 'about:blank'; } catch(e) {}
      } };
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
    + 'justify-content:center;background:#000;touch-action:none;';
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

  // (dev0606) TikTok hits the identical wall as IG — dev0602/0603 predicted this
  // ("the same code shape and almost certainly the same bug") and it was: the
  // swipe-catcher ate the play click, leaving the zoom-in cursor and a dead
  // embed. Same fix, same helper: catcher inert + swipe-back on letterbox/strip.
  _vpWireEmbedGestures(wrap, clipBox, 'vp-tt-swipe-strip');

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

// (dev0693) Pinterest mount — the FALLBACK renderer, not the normal one. A pin
// imported through W is resolved to its direct i./v1.pinimg.com file and plays via
// vpMountDirectVideo (or renders as an image) with full seek and segments; only a
// video pin Pinterest serves solely as HLS — which no browser but Safari can put in
// a <video> — keeps its pin URL and lands here, in a view-only cross-origin iframe.
//
// The widget is a CARD (picture + title + "Save" chrome), not a bare player, and it
// sizes itself to its container, so this uses a 3:4-ish box rather than TikTok's
// hard 9:16. Same catcher rule as IG/TikTok: _vpWireEmbedGestures frees
// #vp-swipe-catcher (which would otherwise eat the play click — dev0602) and puts
// swipe-close back on the letterbox plus a right-edge strip.
function vpMountPinterest(host, link) {
  host.innerHTML = '';
  var src = window.pinterestEmbedUrl ? window.pinterestEmbedUrl(link) : '';
  if (!src) return;

  var wrap = document.createElement('div');
  wrap.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;'
    + 'justify-content:center;background:#000;touch-action:none;';
  var clipBox = document.createElement('div');
  clipBox.style.cssText = 'position:relative;width:min(560px,95vw);'
    + 'height:min(860px,95%);aspect-ratio:3/4;overflow:hidden;background:#fff;';
  var iframe = document.createElement('iframe');
  iframe.src = src;
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('scrolling', 'no');
  iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
  iframe.setAttribute('allowfullscreen', '');
  iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff;';
  clipBox.appendChild(iframe);
  wrap.appendChild(clipBox);
  host.appendChild(wrap);

  _vpWireEmbedGestures(wrap, clipBox, 'vp-pin-swipe-strip');

  // Inert seek-bar → "Open on Pinterest" (same pattern as IG/TikTok). Prev/Play/
  // Next/Close in the row below stay functional.
  var toolbar = document.getElementById('vp-toolbar');
  if (toolbar && toolbar.firstElementChild) {
    var tlRow = toolbar.firstElementChild;
    tlRow.style.display = 'none';
    var openBtn = document.createElement('button');
    openBtn.id = 'vp-pin-open';
    openBtn.textContent = '↗ Open on Pinterest';
    openBtn.style.cssText = 'display:block;width:100%;height:24px;margin:0 0 4px 0;'
      + 'background:linear-gradient(135deg,#e60023 0%,#bd081c 100%);'
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
    _vpState.player = { isPinterest: true,
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

// ══════════════════════════════════════════════════════════════════════════
// (dev0746) OPEN A DISK FILE STRAIGHT IN THE CROP TOOL
//
//   http://localhost:8080/?vect=<url-encoded absolute path>
//
// A file manager copies a path; a hotkey (AHK\vectOpen.ahk) or the Send-to
// entry turns it into that URL; the page lands with the picture or the clip
// already open and the crop overlay up. No folder picker, no slideshow, and —
// because the absolute path is where this starts rather than something we have
// to reconstruct — no "which folder is this?" prompt at save time either.
//
// Media comes off the proxy's /localfile route: a page cannot read file:// and
// the File System Access API will not hand back a real path, so the one thing
// that CAN turn a path into pixels here is the local proxy.
//
// Dev-only by construction: it needs the proxy, and it refuses to run anywhere
// but localhost so a shared link can never carry someone's disk layout.
// ══════════════════════════════════════════════════════════════════════════
const VECT_VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;
const VECT_IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;

function _vectIsLocalHost() {
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

function _vectFileUrl(absPath) {
  return PROXY_BASE + '/localfile?p=' + encodeURIComponent(absPath);
}

// The row every disk-media path in this app already understands. `comment`
// carries the ABSOLUTE path, which is exactly what _vpCropResolveAbsPath
// passes straight through — the drive letter is the short-circuit.
function _vectRowFor(absPath, isVideo) {
  const name = absPath.split(/[\\/]/).pop() || absPath;
  const row = { link: _vectFileUrl(absPath), VidTitle: name, comment: absPath, Mute: '' };
  if (isVideo) row._directVideoFile = true; else row._directImageFile = true;
  return row;
}

window.vectOpenLocalFile = function (absPath) {
  if (!absPath) return false;
  if (!_vectIsLocalHost()) {
    if (typeof toast === 'function') toast('Opening disk files works on the local dev server only', 3000);
    return false;
  }
  const isVideo = VECT_VIDEO_RE.test(absPath);
  const isImage = VECT_IMAGE_RE.test(absPath);
  if (!isVideo && !isImage) {
    if (typeof toast === 'function') toast('Not a picture or a video: ' + absPath, 3600);
    return false;
  }
  if (isVideo) return _vectOpenVideo(absPath);
  return _vectOpenImage(absPath);
};

// Video → the ordinary V player on a synthesized disk-video row, which brings
// its crop overlay (C) with it. Same preconditions T's own V hotkey sets up.
function _vectOpenVideo(absPath) {
  if (typeof gridOpenFullscreen !== 'function') return false;
  const gOvl = document.getElementById('gridOverlay');
  if (gOvl && gOvl.style.display !== 'flex') {
    gOvl.style.display = 'flex';
    window._vpForcedGridFromT = true;
  }
  // (dev0747) Opening a file in VECT IS asking to crop it — the overlay comes
  // up with the video rather than waiting to be asked. The mount happens inside
  // gridOpenFullscreen, so the flag is read there; it is one-shot, so V opened
  // any other way still starts clean with the picture unobstructed.
  window._vectAutoCrop = true;
  gridOpenFullscreen(_vectRowFor(absPath, true));
  // The mount is on a 50ms timeout inside there, so the flag can't be cleared
  // here — vpMountDirectVideo consumes it. This is the safety net for a row
  // that somehow never reaches that mount, so the next V open isn't surprised.
  setTimeout(() => { window._vectAutoCrop = false; }, 3000);
  return true;
}

// Picture → a bare full-window host with the file in it, then the same crop
// overlay the slideshow mounts. The host is ours, so closing the crop takes it
// down with it (the onClose below) and the app is where it was.
function _vectOpenImage(absPath) {
  const old = document.getElementById('vect-standalone');
  if (old) old.remove();
  const host = document.createElement('div');
  host.id = 'vect-standalone';
  host.style.cssText =
    'position:fixed;inset:0;z-index:41000;background:#000;overflow:hidden;touch-action:none;';
  const img = document.createElement('img');
  img.alt = '';
  img.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;' +
    'user-select:none;-webkit-user-drag:none;';
  host.appendChild(img);
  const note = document.createElement('div');
  note.style.cssText =
    'position:absolute;left:0;right:0;bottom:10px;text-align:center;color:#8ea;' +
    'font:12px ui-monospace,Consolas,monospace;text-shadow:0 1px 4px #000;pointer-events:none;';
  note.textContent = absPath;
  host.appendChild(note);
  document.body.appendChild(host);

  img.onerror = () => {
    host.remove();
    if (typeof toast === 'function') {
      toast('Could not read that file — is "node proxy.js" running?  ' + absPath, 5000);
    }
  };
  img.onload = () => {
    // The path caption would be burned into a screenshot of the crop, and it
    // sits exactly where the bar can end up. It has done its job by now.
    note.remove();
    const ok = window._vpImageCropOpen(host, img, _vectRowFor(absPath, false),
                                       () => { try { host.remove(); } catch (_) {} });
    if (!ok) { host.remove(); if (typeof toast === 'function') toast('Could not open the crop tool', 2600); }
  };
  img.src = _vectFileUrl(absPath);
  return true;
}

// Read the parameter once the page has finished its own start-up, so opening V
// doesn't race the landing screen that would paint over it.
(function _vectBoot() {
  let p = '';
  try { p = new URLSearchParams(location.search).get('vect') || ''; } catch (_) {}
  if (!p) return;
  const go = () => setTimeout(() => { try { window.vectOpenLocalFile(p); } catch (e) { console.error('[vect]', e); } }, 400);
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
})();
