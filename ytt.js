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

function _yttClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// One line of toast from a /ytt/progress record.
//
// (dev0961) Elapsed is appended to EVERY line and is computed client-side, not from
// the job record, because the phases that report nothing are exactly the ones that
// take longest: loading an 8B model into the iGPU says nothing until it is done, and
// a transcript short enough to be a single chunk emits one `chunk=1` and then goes
// quiet for minutes. `tok` (from the python's streamed PROGRESS:tok=) is what makes
// that quiet stretch legible — a moving token count is the difference between "slow"
// and "hung", which is the whole reason the first run looked stuck.
function _yttProgressLine(title, j, startedAt) {
  const head = '📝 ' + title;
  const el = startedAt ? '  ·  ' + _yttClock(Date.now() - startedAt) : '';
  const tok = j && j.tok ? '  ·  ' + j.tok.toLocaleString() + ' tokens' : '';
  if (!j) return head + ' · starting…' + el;
  if (j.stage === 'transcript') return head + ' · transcript: ' + (j.note || 'fetching…') + el;
  if (j.stage === 'ollama')     return head + ' · ' + (j.note || 'starting Ollama…') + el;
  if (j.stage === 'summary') {
    if (!j.total) return head + ' · ' + (j.note || 'chunking…') + el;
    const which = j.total > 1 ? ' chunk ' + Math.max(1, j.chunk) + '/' + j.total : '';
    return head + ' · summarising' + which + tok + el;
  }
  if (j.stage === 'synthesis') return head + ' · final synthesis' + tok + el;
  if (j.stage === 'error')     return head + ' · failed' + el;
  return head + ' · working…' + el;
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

// Returns { ok, skipped, error } so the queue below can drive it and keep a
// tally. `qLabel` ("3/17") rides on the front of every toast this run makes.
async function yttRunRow(di, force, qLabel) {
  const row = (typeof data !== 'undefined' && data[di]) || null;
  if (!row) return { ok: false, error: 'no such row' };
  const vid = yttVideoId(row.link);
  if (!vid) {
    const e = 'not a YouTube link — no caption track to fetch (whisper on the audio is the next step of this feature)';
    if (!qLabel) toast('📝 ' + e, 4000);
    return { ok: false, error: e };
  }
  if (_yttBusy) {
    const e = 'a transcript/summary is already running — one at a time';
    if (!qLabel) toast('📝 ' + e, 2500);
    return { ok: false, error: e };
  }
  _yttBusy = true;

  const title = (qLabel ? qLabel + '  ' : '') + String(row.VidTitle || row.link).slice(0, 46);
  const job = 'ytt' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // Re-issuing the toast is what keeps a multi-minute run continuously visible:
  // toast() auto-hides after its ms (same idiom as tDownloadRowMedia). Every 1s,
  // not 2s, so the elapsed clock actually ticks rather than jumping in twos —
  // a clock that moves is the cheapest possible proof it has not hung.
  const startedAt = Date.now();
  let lastJob = null;
  toast(_yttProgressLine(title, null, startedAt), 2000);
  const poll = setInterval(async () => {
    try {
      const pr = await fetch(YTT_PROXY + '/ytt/progress?job=' + job);
      const pj = await pr.json();
      if (pj && pj.ok && pj.job) lastJob = pj.job;
    } catch (_) { /* a missed poll is cosmetic — the POST below is the real result */ }
    // Re-toast even on a failed poll: the elapsed clock is client-side, so the
    // line still moves when the proxy is momentarily busy serving the run itself.
    if (!lastJob || (lastJob.stage !== 'done' && lastJob.stage !== 'error')) {
      toast(_yttProgressLine(title, lastJob, startedAt), 2000);
    }
  }, 1000);

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
      // A skip still means the summary exists, so the tag should reflect that —
      // otherwise a row summarised before the tag existed stays in the queue for
      // ever and the queue never drains.
      if (!window._cMode && _yttMarkTagged(row)) {
        try { save(); if (typeof render === 'function') render(); } catch (_) {}
      }
      if (!qLabel) toast('📝 Already summarised — press z to read it (' + j.summary + ')', 6000);
      return { ok: true, skipped: true };
    }
    if (j && j.ok) {
      // Only touch ml.json from the Table screen. In C mode the `data` global is
      // c.json while save() still writes ML.JSON — flipping a tag there would
      // write the wrong file's row (see the dev0350 C-screen note in core.js).
      let saved = false;
      if (!window._cMode && _yttMarkTagged(row)) {
        try { save(); if (typeof render === 'function') render(); saved = true; } catch (_) {}
      }
      toast('✅ ' + (qLabel ? qLabel + '  ' : '') + j.summary + '  ·  ' + j.words + ' words in, ' + j.model
            + '  ·  ' + _yttClock(Date.now() - startedAt)
            + (saved ? '  ·  tagged “transcribed”' : '') + '  —  press z to read', qLabel ? 4000 : 10000);
      return { ok: true };
    }
    const err = (j && j.error) || ('HTTP ' + r.status);
    if (!qLabel) toast('⚠ ' + err, 11000);
    return { ok: false, error: err };
  } catch (e) {
    clearInterval(poll);
    const err = 'proxy not reachable on 8081 — restart it (LButton & t)';
    if (!qLabel) toast('⚠ ' + err, 5000);
    return { ok: false, error: err, fatal: true };
  } finally { clearInterval(poll); _yttBusy = false; yttRefreshHave(); }
}
window.yttRunRow = yttRunRow;

// ── the queue ────────────────────────────────────────────────────────────────
// (dev0964) Serial, client-side, and deliberately NOT a proxy-side daemon: the
// browser owns ml.json (save() writes it through the File System Access API), so
// the tag flips have to happen here, and a queue that outlived the page would be
// writing rows nobody is holding. It is also the reason a reload stops it — which
// is honest, and matches the standing "no background daemons" rule.
let _yttQ = { running: false, stop: false, done: 0, failed: [], total: 0 };

// Rows still wanting a run: tagged `transcribe`, not yet `transcribed`, YouTube.
// Order is the table's current order, so sorting T sorts the queue.
function yttQueueRows() {
  if (typeof data === 'undefined' || !Array.isArray(data)) return [];
  const out = [];
  for (let i = 0; i < data.length; i++) {
    const r = data[i];
    if (!r) continue;
    const t = Array.isArray(r.tags) ? r.tags : (r.tags ? [String(r.tags)] : []);
    if (t.indexOf('transcribe') === -1 || t.indexOf('transcribed') !== -1) continue;
    if (!yttVideoId(r.link)) continue;   // whisper's job, once that exists
    out.push(i);
  }
  return out;
}
window.yttQueueRows = yttQueueRows;

function yttQueueStop() {
  if (!_yttQ.running) return;
  _yttQ.stop = true;
  toast('🛑 Queue will stop after the current row finishes', 4000);
}
window.yttQueueStop = yttQueueStop;

// Escape while a queue runs means "stop the queue", so swallow it: letting it
// through would ALSO fire the app's Esc navigation and change screens under you,
// which reads as the key having done something wrong.
function _yttQKey(e) {
  if (e.key !== 'Escape' || !_yttQ.running) return;
  e.preventDefault();
  e.stopPropagation();
  yttQueueStop();
}

async function yttRunQueue() {
  if (_yttQ.running) { toast('📝 Queue already running — Esc stops it after the current row', 3000); return; }
  const rows = yttQueueRows();
  if (!rows.length) {
    toast('📝 Nothing queued — tag rows “To transcribe” (and they must be YouTube links)', 5000);
    return;
  }
  // A real confirm, not a reflex one: this is rows × minutes, it holds the iGPU
  // the whole time, and a reload part-way through abandons it.
  if (!window.confirm(
        rows.length + ' row(s) tagged “To transcribe” and not yet done.\n\n'
        + 'These run ONE AT A TIME and each takes a few minutes, so this is roughly '
        + rows.length + '–' + (rows.length * 5) + ' minutes of local GPU.\n\n'
        + 'Esc stops it after the row in flight. Reloading the page abandons it.\n\n'
        + 'Start?')) return;

  _yttQ = { running: true, stop: false, done: 0, failed: [], total: rows.length };
  document.addEventListener('keydown', _yttQKey, true);
  const t0 = Date.now();

  // Re-resolve each row by UID rather than trusting the index: a save() + render()
  // between rows can reorder `data` under us, and running the wrong row would be
  // silent and wrong rather than merely annoying.
  const uids = rows.map(i => String(data[i].UID || ''));
  for (let n = 0; n < uids.length; n++) {
    if (_yttQ.stop) break;
    const di = data.findIndex(r => r && String(r.UID || '') === uids[n]);
    if (di < 0) { _yttQ.failed.push(uids[n] + ' (row vanished)'); continue; }
    const res = await yttRunRow(di, false, (n + 1) + '/' + uids.length);
    if (res && res.ok) _yttQ.done++;
    else {
      _yttQ.failed.push(uids[n] + ': ' + ((res && res.error) || 'unknown'));
      // A dead proxy fails every remaining row identically — stop rather than
      // grind out N copies of the same error.
      if (res && res.fatal) { _yttQ.stop = true; break; }
    }
  }

  document.removeEventListener('keydown', _yttQKey, true);
  _yttQ.running = false;
  const mins = _yttClock(Date.now() - t0);
  let msg = (_yttQ.stop ? '🛑 Queue stopped' : '✅ Queue finished') + '  ·  '
          + _yttQ.done + '/' + _yttQ.total + ' done in ' + mins;
  if (_yttQ.failed.length) msg += '  ·  ' + _yttQ.failed.length + ' failed (see ytsummaries/_runs.log)';
  toast(msg, 15000);
  if (_yttQ.failed.length) console.warn('[ytt] queue failures:\n' + _yttQ.failed.join('\n'));
  yttRefreshHave();
}
window.yttRunQueue = yttRunQueue;

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
