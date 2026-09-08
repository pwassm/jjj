// ══════════════════════════════════════════════════════════════════════════════
// ytt.js — YouTube transcript + local-Ollama summary, from a T row (dev0961)
//
// The engines are NOT here and are not new: M:\jjj\YTT holds get_yt_transcript.py
// (YouTube's own caption track — ~2s, no audio, no whisper, no LLM) and Tsum*.py
// (chunked local Ollama). This file is the SLAM end of them: it asks the proxy to
// run the pair for one row, shows progress while it does, and puts the result
// behind the `z` key. See proxy.js /ytt/* for the runner itself.
//
// WHY NO ysumm COLUMN: the state a row is in is two things that already exist —
// a file in ytsummaries/ named <uid>~… (the proxy's manifest, /ytt/list) and the
// row's own tags. `transcribe` is the queue marker, `transcribed` is added here on
// success. Nothing is backfilled into ml.json, so none of this can be lost by the
// load→save path that has blanked columns before (see dev0853).
//
// ytsummaries/ is GITIGNORED and dev-only; its backup is backup-root.ps1, not git.
// ══════════════════════════════════════════════════════════════════════════════

const YTT_PROXY = 'http://127.0.0.1:8081';
// Which Tsum*.py to use. The proxy scans YTT\ for the real list (/ytt/list →
// summarizers); this is only the default when the row says nothing else.
const YTT_DEFAULT_TSUM = 'Health';

// Last /ytt/list result — which UIDs have files on disk. Advisory: the runner and
// the z window both re-ask the proxy, so a stale cache costs a menu label, never
// a wrong file.
window._yttHave = null;

function yttVideoId(link) {
  const m = /(?:v=|youtu\.be\/|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/.exec(String(link || ''));
  return m ? m[1] : null;
}
window.yttVideoId = yttVideoId;

async function yttRefreshHave() {
  try {
    const r = await fetch(YTT_PROXY + '/ytt/list');
    const j = await r.json();
    if (j && j.ok) { window._yttHave = j.have || {}; return j; }
  } catch (_) { /* proxy down — the menu just won't say "(done)" */ }
  return null;
}
window.yttRefreshHave = yttRefreshHave;

// ── the run ──────────────────────────────────────────────────────────────────
let _yttBusy = false;

// One line of toast from a /ytt/progress record. Step 2 is ~22 sequential Ollama
// calls, so this has to say WHICH chunk as well as that it is still moving — a
// frozen percentage with no chunk number is what a stall looks like.
function _yttProgressLine(title, j) {
  const head = '📝 ' + title;
  if (!j) return head + ' · starting…';
  if (j.stage === 'transcript') return head + ' · transcript: ' + (j.note || 'fetching…');
  if (j.stage === 'ollama')     return head + ' · ' + (j.note || 'starting Ollama…');
  if (j.stage === 'summary') {
    if (!j.total) return head + ' · ' + (j.note || 'chunking…');
    return head + ' · summarising chunk ' + j.chunk + '/' + j.total + '  (' + (j.pct || 0) + '%)';
  }
  if (j.stage === 'synthesis') return head + ' · final synthesis…';
  if (j.stage === 'error')     return head + ' · failed';
  return head + ' · working…';
}

// Add `transcribed` to the row's tags. tags is a JSON ARRAY of tag ids in ml.json
// (not a comma string), and `transcribe` — the queue marker — is deliberately left
// in place: it is the record of what was asked for, and the pair reads as a state.
function _yttMarkTagged(row) {
  if (!row) return false;
  if (!Array.isArray(row.tags)) row.tags = row.tags ? [String(row.tags)] : [];
  if (row.tags.indexOf('transcribed') !== -1) return false;
  row.tags.push('transcribed');
  return true;
}

async function yttRunRow(di, force) {
  const row = (typeof data !== 'undefined' && data[di]) || null;
  if (!row) return;
  const vid = yttVideoId(row.link);
  if (!vid) { toast('📝 Not a YouTube link — no caption track to fetch (whisper on the audio is the next step of this feature)', 4000); return; }
  if (_yttBusy) { toast('📝 A transcript/summary is already running — one at a time', 2500); return; }
  _yttBusy = true;

  const title = String(row.VidTitle || row.link).slice(0, 46);
  const job = 'ytt' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // Re-issuing the toast every 2s is what keeps a multi-minute run continuously
  // visible: toast() auto-hides after its ms (same idiom as tDownloadRowMedia).
  toast(_yttProgressLine(title, null), 3000);
  const poll = setInterval(async () => {
    try {
      const pr = await fetch(YTT_PROXY + '/ytt/progress?job=' + job);
      const pj = await pr.json();
      if (pj && pj.ok && pj.job && pj.job.stage !== 'done' && pj.job.stage !== 'error') {
        toast(_yttProgressLine(title, pj.job), 3000);
      }
    } catch (_) { /* a missed poll is cosmetic — the POST below is the real result */ }
  }, 2000);

  try {
    const r = await fetch(YTT_PROXY + '/ytt/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uid: String(row.UID || ''), url: row.link, title: row.VidTitle || '',
        tsum: YTT_DEFAULT_TSUM, job: job, force: !!force
      })
    });
    const j = await r.json();
    clearInterval(poll);
    if (j && j.ok && j.skipped) {
      toast('📝 Already summarised — press z to read it (' + j.summary + ')', 6000);
    } else if (j && j.ok) {
      // Only touch ml.json from the Table screen. In C mode the `data` global is
      // c.json while save() still writes ML.JSON — flipping a tag there would
      // write the wrong file's row (see the dev0350 C-screen note in core.js).
      let saved = false;
      if (!window._cMode && _yttMarkTagged(row)) {
        try { save(); if (typeof render === 'function') render(); saved = true; } catch (_) {}
      }
      toast('✅ ' + j.summary + '  ·  ' + j.words + ' words in, ' + j.model
            + (saved ? '  ·  tagged “transcribed”' : '') + '  —  press z to read', 10000);
    } else {
      toast('⚠ ' + ((j && j.error) || ('HTTP ' + r.status)), 11000);
    }
  } catch (_) {
    clearInterval(poll);
    toast('⚠ Proxy not reachable on 8081 — start proxy.js (needs the dev0961 build: RESTART it)', 5000);
  } finally { clearInterval(poll); _yttBusy = false; yttRefreshHave(); }
}
window.yttRunRow = yttRunRow;

// ── the z window ─────────────────────────────────────────────────────────────
let _yttOvKind = 'summary';   // remembered across opens within a session

function yttCloseWindow() {
  const ov = document.getElementById('yttWindow');
  if (ov) ov.remove();
  document.removeEventListener('keydown', _yttOvKey, true);
}
window.yttCloseWindow = yttCloseWindow;

function _yttOvKey(e) {
  if (!document.getElementById('yttWindow')) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); yttCloseWindow(); return; }
  // Swallow bare letters so the global dispatcher can't switch screens out from
  // under a window the user is reading — z included, which would re-enter here.
  if (!e.ctrlKey && !e.altKey && !e.metaKey && /^[a-zA-Z]$/.test(e.key)) {
    e.stopPropagation();
    if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); yttCloseWindow(); }
  }
}

async function yttShowText(uid, kind) {
  const want = kind || _yttOvKind;
  let j = null;
  try {
    const r = await fetch(YTT_PROXY + '/ytt/text?uid=' + encodeURIComponent(uid) + '&kind=' + want);
    j = await r.json();
  } catch (_) {
    toast('⚠ Proxy not reachable on 8081 — the summaries live on disk, so start proxy.js', 5000);
    return;
  }
  if (!j || !j.ok) {
    toast('📝 No ' + want + ' for UID ' + uid + ' yet — right-click the row ▸ “Transcribe & summarise”', 6000);
    return;
  }
  _yttOvKind = want;
  yttCloseWindow();

  const ov = document.createElement('div');
  ov.id = 'yttWindow';
  ov.style.cssText = 'position:fixed;inset:4vh 6vw;z-index:6000;background:#14171a;'
    + 'border:1px solid #4df;border-radius:8px;box-shadow:0 10px 50px rgba(0,0,0,.8);'
    + 'display:flex;flex-direction:column;overflow:hidden;';

  const bar = document.createElement('div');
  bar.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:8px 12px;'
    + 'background:#1d2126;border-bottom:1px solid #2c3238;color:#cfe;font:13px/1.3 system-ui,sans-serif;';
  const name = document.createElement('div');
  name.style.cssText = 'flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  name.textContent = 'UID ' + j.uid + ' · ' + (j.title || '') + '  (' + j.file + ')';
  bar.appendChild(name);

  const mkBtn = (label, on) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'flex:0 0 auto;background:#2a3038;color:#cfe;border:1px solid #3d444c;'
      + 'border-radius:4px;padding:3px 10px;cursor:pointer;font:12px system-ui,sans-serif;';
    b.addEventListener('click', on);
    return b;
  };
  const other = want === 'summary' ? 'transcript' : 'summary';
  bar.appendChild(mkBtn(other === 'transcript' ? 'Transcript' : 'Summary', () => yttShowText(uid, other)));
  bar.appendChild(mkBtn('Copy', () => {
    navigator.clipboard.writeText(j.text).then(
      () => toast('📋 ' + want + ' copied', 1800),
      () => toast('⚠ Clipboard refused', 2000));
  }));
  bar.appendChild(mkBtn('✕', yttCloseWindow));
  ov.appendChild(bar);

  const body = document.createElement('pre');
  // pre-wrap, not a <div>: the transcript's [M:SS] line breaks ARE the citation
  // structure the prompts hang timestamps on, and reflowing them loses it.
  body.style.cssText = 'flex:1 1 auto;margin:0;padding:16px 20px;overflow:auto;'
    + 'white-space:pre-wrap;word-wrap:break-word;color:#dfe6ec;background:#14171a;'
    + 'font:14px/1.55 ui-monospace,Consolas,monospace;';
  body.textContent = j.text;
  ov.appendChild(body);

  document.body.appendChild(ov);
  body.focus();
  document.addEventListener('keydown', _yttOvKey, true);
}
window.yttShowText = yttShowText;

// The `z` hotkey. Resolves the row the same way rowPreviewOpen does — the T cell
// focus, mapped through vr() — and falls back to whatever row was last shown
// elsewhere (V/G set window._lastUID) so z also works away from the Table.
function yttHotkeyZ() {
  const ov = document.getElementById('yttWindow');
  if (ov) { yttCloseWindow(); return; }
  let uid = null;
  try {
    // `focus` must be tested as an OBJECT with an r, not just non-null: core.js's
    // `var focus` lives on window, where the name is already taken by the native
    // window.focus() — so before core.js assigns, the bare name is a FUNCTION and
    // every truthiness test on it passes.
    const f = window.focus;
    if (f && typeof f === 'object' && typeof f.r === 'number' && typeof vr === 'function') {
      const di = vr(f.r);
      if (di >= 0 && di < data.length && data[di]) uid = String(data[di].UID || '');
    }
  } catch (_) {}
  if (!uid && window._lastUID) uid = String(window._lastUID);
  if (!uid) { toast('📝 Click a row to focus it, then z', 2000); return; }
  yttShowText(uid, _yttOvKind);
}
window.yttHotkeyZ = yttHotkeyZ;

// Warm the manifest once so the T row menu can label its item "(done)" without a
// round trip. Failure is silent — the proxy being down is normal on a fresh boot.
setTimeout(yttRefreshHave, 1500);
