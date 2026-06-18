// ══════════════════════════════════════════════════════════════════════════════
// I / Ig SCREEN — staging table for ig.json (dev0429, revised dev0430)
// ══════════════════════════════════════════════════════════════════════════════
// A standalone, dev-only screen that views the IG-harvest staging store (ig.json)
// the way T views ml.json — but deliberately SEPARATE from ml.json/T/G so the
// 1000s of harvested reels never clutter the working table. From here a row can be
//   • Enriched  → yt-dlp → VidTitle + ftext + ttxt + VidAuthor + DatePosted +
//                 duration + W×H (reuses the core.js IG pipeline verbatim).
//   • Downloaded→ proxy /ig/download → yt-dlp saves the media (max res) to
//                 <project>/ig_media/ named per the user's AHK convention:
//                 hh.mm.ss~WxH~Title~@author~[[i[id]]].mp4  (one — max — W×H).
//   • Promoted  → a real ml.json row is minted (data.push + save()) so it joins T/G.
// All edits persist back to ig.json via the proxy /ig/save endpoint.
//
// Hotkey: I (dev-only, blocked in user mode like T). Esc closes the detail drawer,
// then the screen. The file is isolated (like movingcells.js/flycells.js).
//
// Globals borrowed from core.js (same realm — classic <script> tags share scope):
//   toast, isoNow, nextUID, data, save, _isUserMode, _ensureCommonWords,
//   _ytdlpFetchMeta, _ytdlpAuthorHandle, _ytdlpBuildFtext, _smartIgTitle, _normalizeText
(function () {
  'use strict';

  const PROXY = 'http://127.0.0.1:8081';
  const STORE_URL = () => 'ig.json?t=' + Date.now();

  // ── State ────────────────────────────────────────────────────────────────
  let rows = [];                       // the live ig.json array (mutated in place)
  let view = [];                       // filtered + sorted slice of `rows`
  let sortCol = 'DateAdded', sortDir = -1;
  let query = '', kindFilter = 'all', statusFilter = 'all';
  let sel = new Set();                 // selected ids (batch ops)
  let focusId = null;                  // row open in the detail drawer
  let dirty = false;                   // unsaved enrich/promote/status edits
  let busy = false;                    // a batch op is running

  // ── Helpers ────────────────────────────────────────────────────────────────
  const esc = s => String(s == null ? '' : s).replace(/[<>&"]/g,
    c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const kindOf = r => /\/reel\//i.test(r.url || '') ? 'reel'
                   : /\/p\//i.test(r.url || '') ? 'p'
                   : /\/tv\//i.test(r.url || '') ? 'tv' : '?';
  const igLink = r => r.url || ('https://www.instagram.com/p/' + r.id + '/');
  const pad2 = n => String(n).padStart(2, '0');

  // hh.mm.ss (AHK FormatHMS — used in the download filename).
  function fmtHMS(sec) {
    sec = Math.round(+sec || 0);
    return pad2(Math.floor(sec / 3600)) + '.' + pad2(Math.floor((sec % 3600) / 60)) + '.' + pad2(sec % 60);
  }
  // m:ss / h:mm:ss for the on-screen Duration column.
  function fmtDur(sec) {
    sec = Math.round(+sec || 0);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? (h + ':' + pad2(m) + ':' + pad2(s)) : (m + ':' + pad2(s));
  }
  // yt-dlp upload_date "YYYYMMDD" (or unix timestamp) → "YYYY-MM-DD".
  function datePosted(meta) {
    const ud = (meta.upload_date || '').trim();
    if (/^\d{8}$/.test(ud)) return ud.slice(0, 4) + '-' + ud.slice(4, 6) + '-' + ud.slice(6, 8);
    if (Number.isFinite(meta.timestamp)) return new Date(meta.timestamp * 1000).toISOString().slice(0, 10);
    return '';
  }
  // Mirror of AHK SanitizeFilePart (keeps ~ [ ] @ — all legal on Windows).
  function sanitizePart(s) {
    s = String(s || '').replace(/[<>":\/\\|?*\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '');
    return s || 'unknown';
  }
  // hh.mm.ss~WxH~Title~@author~[[i[id]]]  (one W×H = max; the redundant [M[…]] of
  // the old convention dropped per "only need one w×h").
  function downloadName(r) {
    const dur = fmtHMS(r.durSecs);
    const res = (r.width && r.height) ? (r.width + 'x' + r.height) : '0x0';
    const title = sanitizePart((typeof _normalizeText === 'function'
      ? _normalizeText(r.VidTitle || '') : (r.VidTitle || '')).replace(/\s+/g, ' ')).slice(0, 80);
    const chan = (r.VidAuthor || ('@' + r.author)).replace(/^@+/, '');
    return dur + '~' + res + '~' + sanitizePart(title) + '~@' + sanitizePart(chan) + '~[[i[' + r.id + ']]]';
  }

  function igToast(msg, ms) {
    if (typeof toast === 'function') toast(msg, ms || 2200);
    else console.log('[ig]', msg);
  }

  // ── CSS (scoped under #igOverlay, injected once) ────────────────────────────
  function injectCss() {
    if (document.getElementById('ig-css')) return;
    const s = document.createElement('style');
    s.id = 'ig-css';
    s.textContent = `
#igOverlay{position:fixed;inset:0;z-index:29500;display:none;flex-direction:column;
  background:#11151c;color:#dfe6ee;font:13px/1.4 system-ui,Segoe UI,sans-serif}
#igOverlay.open{display:flex}
#igBar{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#0c0f14;
  border-bottom:1px solid #232b36;flex:0 0 auto;flex-wrap:wrap}
#igBar h2{margin:0;font-size:15px;font-weight:700;color:#9ad}
#igBar .ct{color:#7d8794;font-size:12px}
#igBar input[type=text]{background:#1a212b;border:1px solid #2c3645;color:#dfe6ee;
  border-radius:6px;padding:5px 8px;width:200px;font:13px system-ui}
#igBar select{background:#1a212b;border:1px solid #2c3645;color:#dfe6ee;border-radius:6px;padding:4px 6px}
#igBar button{background:#1f2733;border:1px solid #34404f;color:#cfe;border-radius:6px;
  padding:5px 10px;cursor:pointer;font:600 12px system-ui}
#igBar button:hover{background:#27313f}
#igBar button.primary{background:#0a84ff;border-color:#0a84ff;color:#fff}
#igBar button:disabled{opacity:.5;cursor:default}
#igBar .spacer{flex:1}
#igBar #igClose{font-size:18px;padding:2px 10px;line-height:1}
#igWrap{flex:1;overflow:auto;position:relative}
#igTable{border-collapse:collapse;width:100%;table-layout:fixed}
#igTable th{position:sticky;top:0;background:#171d26;border-bottom:1px solid #2c3645;
  padding:6px 8px;text-align:left;font-weight:600;color:#9fb0c2;user-select:none;z-index:2}
#igTable th.sortable{cursor:pointer}
#igTable th.sortable:hover{color:#cfe}
#igTable th .arrow{color:#0a84ff;font-size:11px}
#igTable td{padding:5px 8px;border-bottom:1px solid #1d242e;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}
#igTable tr:hover td{background:#161d27}
#igTable tr.focus td{background:#1d2a3a}
#igTable tr.st-enriched td{box-shadow:inset 3px 0 0 #4caf50}
#igTable tr.st-downloaded td{box-shadow:inset 3px 0 0 #ffb300}
#igTable tr.st-promoted td{box-shadow:inset 3px 0 0 #0a84ff;opacity:.72}
#igTable .badge{display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:700}
.k-reel{background:#3a2a52;color:#caa6ff}.k-p{background:#1e3a4a;color:#7fd0ee}.k-tv{background:#4a2a2a;color:#eeae7f}.k-q{background:#333;color:#aaa}
.s-new{color:#7d8794}.s-enriched{color:#7fd47f}.s-downloaded{color:#ffc04d}.s-promoted{color:#6fb6ff}
#igTable a.idlink{color:#7fb8ff;text-decoration:none}
#igTable a.idlink:hover{text-decoration:underline}
#igTable .yes{color:#7fd47f;font-weight:700}.no{color:#4a5563}
#igTable .mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#9fb0c2}
#igTable td.c-act{white-space:nowrap}
#igTable td.c-act button{background:#1f2733;border:1px solid #34404f;color:#cfe;
  border-radius:5px;padding:3px 7px;margin-right:3px;cursor:pointer;font:600 11px system-ui}
#igTable td.c-act button:hover{background:#2b3543}
#igTable td.c-act button:disabled{opacity:.4;cursor:default}
#igDrawer{position:absolute;top:0;right:0;bottom:0;width:400px;background:#0e1219;
  border-left:1px solid #2c3645;box-shadow:-6px 0 18px rgba(0,0,0,.4);overflow:auto;
  padding:14px;display:none}
#igDrawer.open{display:block}
#igDrawer h3{margin:0 26px 8px 0;font-size:14px;color:#9ad;white-space:normal}
#igDrawer .meta{color:#8aa;font-size:12px;margin-bottom:8px;word-break:break-all}
#igDrawer .kv{display:grid;grid-template-columns:84px 1fr;gap:2px 8px;margin:8px 0;font-size:12px}
#igDrawer .kv b{color:#7d8794;font-weight:600}
#igDrawer .sect{margin:10px 0;border-top:1px solid #1d242e;padding-top:8px}
#igDrawer .sect b{color:#9fb0c2;display:block;margin-bottom:4px;font-size:12px}
#igDrawer .fname{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#bfe;
  background:#11161e;border:1px solid #2c3645;border-radius:6px;padding:7px;word-break:break-all;user-select:all}
#igDrawer .ftext{background:#11161e;border:1px solid #1d242e;border-radius:6px;padding:8px;
  max-height:220px;overflow:auto;font-size:12px;white-space:normal}
#igDrawer .ttxt{background:#11161e;border:1px solid #1d242e;border-radius:6px;padding:8px;
  max-height:200px;overflow:auto;font-size:11px;white-space:normal;color:#9aa}
#igDrawer .acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
#igDrawer .acts button{flex:1 1 auto;background:#1f2733;border:1px solid #34404f;color:#cfe;
  border-radius:6px;padding:7px;cursor:pointer;font:600 12px system-ui;min-width:90px}
#igDrawer .acts button.primary{background:#0a84ff;border-color:#0a84ff;color:#fff}
#igDrawer #igDrawerClose{position:absolute;top:8px;right:10px;background:none;border:0;
  color:#9aa;font-size:20px;cursor:pointer}
#igEmpty{padding:40px;text-align:center;color:#7d8794}
#igModalBack{position:absolute;inset:0;background:rgba(0,0,0,.55);display:none;z-index:10;
  align-items:center;justify-content:center}
#igModalBack.open{display:flex}
#igModal{width:min(680px,90%);max-height:80%;display:flex;flex-direction:column;
  background:#141a22;border:1px solid #2c3645;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.6);padding:14px}
#igModal h3{margin:0 0 4px;font-size:14px;color:#9ad}
#igModal .hint{color:#7d8794;font-size:12px;margin-bottom:8px}
#igModal textarea{flex:1;min-height:220px;background:#0c1016;border:1px solid #2c3645;color:#dfe6ee;
  border-radius:6px;padding:8px;font:12px ui-monospace,Consolas,monospace;resize:vertical}
#igModal .row{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
#igModal button{background:#1f2733;border:1px solid #34404f;color:#cfe;border-radius:6px;
  padding:7px 14px;cursor:pointer;font:600 12px system-ui}
#igModal button.primary{background:#0a84ff;border-color:#0a84ff;color:#fff}
`;
    document.head.appendChild(s);
  }

  // ── DOM scaffold ────────────────────────────────────────────────────────────
  function build() {
    injectCss();
    if (document.getElementById('igOverlay')) return;
    const o = document.createElement('div');
    o.id = 'igOverlay';
    o.innerHTML = `
      <div id="igBar">
        <h2>I · Ig staging</h2>
        <span class="ct" id="igCount"></span>
        <input type="text" id="igSearch" placeholder="search author / id / title / caption…">
        <select id="igKind"><option value="all">all kinds</option><option value="reel">reels</option><option value="p">posts /p</option><option value="tv">tv</option></select>
        <select id="igStatus"><option value="all">all status</option><option value="new">new</option><option value="enriched">enriched</option><option value="downloaded">downloaded</option><option value="promoted">promoted</option></select>
        <div class="spacer"></div>
        <button id="igPaste" title="Paste a Firefox 'Save Page As Text' of a reel → fills that row's ttxt/caption">📋 Paste saved-text</button>
        <button id="igEnrichSel">✨ Enrich sel</button>
        <button id="igDownloadSel">⬇ Download sel</button>
        <button id="igPromoteSel">➕ Promote sel</button>
        <button id="igReload" title="Reload ig.json from disk">↻ Reload</button>
        <button id="igSave" class="primary" title="Write edits back to ig.json">💾 Save</button>
        <button id="igClose" title="Close (Esc)">×</button>
      </div>
      <div id="igWrap">
        <table id="igTable"><thead></thead><tbody></tbody></table>
        <div id="igEmpty" style="display:none"></div>
        <div id="igDrawer"><button id="igDrawerClose">×</button><div id="igDrawerBody"></div></div>
        <div id="igModalBack"><div id="igModal">
          <h3>Paste Instagram saved-text</h3>
          <div class="hint" id="igModalHint">In Firefox: open the reel → File ▸ Save Page As ▸ Text Files → open that .txt → paste it here. Routes to the row by reel id; comments + sibling URLs land in ttxt.</div>
          <textarea id="igModalText" placeholder="Paste the saved page text…"></textarea>
          <div class="row"><button id="igModalCancel">Cancel</button><button id="igModalApply" class="primary">Apply</button></div>
        </div></div>
      </div>`;
    document.body.appendChild(o);

    const $ = id => o.querySelector('#' + id);
    $('igSearch').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); applyAndRender(); });
    $('igKind').addEventListener('change', e => { kindFilter = e.target.value; applyAndRender(); });
    $('igStatus').addEventListener('change', e => { statusFilter = e.target.value; applyAndRender(); });
    $('igEnrichSel').addEventListener('click', () => batchEnrich());
    $('igDownloadSel').addEventListener('click', () => batchDownload());
    $('igPromoteSel').addEventListener('click', () => batchPromote());
    $('igReload').addEventListener('click', () => loadData());
    $('igSave').addEventListener('click', () => persist(true));
    $('igClose').addEventListener('click', () => closeIgScreen());
    $('igDrawerClose').addEventListener('click', () => closeDrawer());
    $('igPaste').addEventListener('click', () => openPasteModal(null));
    $('igModalCancel').addEventListener('click', () => closePasteModal());
    $('igModalApply').addEventListener('click', () => applyPaste());
    o.querySelector('#igTable thead').addEventListener('click', onHeadClick);
    o.querySelector('#igTable tbody').addEventListener('click', onBodyClick);
  }

  // ── Columns ─────────────────────────────────────────────────────────────────
  const COLS = [
    { key: '_sel', label: '<input type="checkbox" id="igSelAll">', w: 30, sort: false },
    { key: 'kind', label: 'Kind', w: 50, sort: true },
    { key: 'author', label: 'Author', w: 120, sort: true },
    { key: 'id', label: 'ID', w: 110, sort: true },
    { key: 'VidTitle', label: 'Title', w: 250, sort: true },
    { key: 'durSecs', label: 'Dur', w: 60, sort: true },
    { key: '_wxh', label: 'W×H', w: 80, sort: true },
    { key: 'DatePosted', label: 'Posted', w: 96, sort: true },
    { key: '_cap', label: 'ftext', w: 46, sort: false },
    { key: '_ttxt', label: 'ttxt', w: 46, sort: false },
    { key: 'status', label: 'Status', w: 86, sort: true },
    { key: 'DateAdded', label: 'Harvested', w: 130, sort: true },
    { key: '_act', label: 'Actions', w: 160, sort: false }
  ];

  function renderHead() {
    const thead = document.querySelector('#igTable thead');
    thead.innerHTML = '<tr>' + COLS.map(c => {
      const arrow = (c.sort && c.key === sortCol) ? ` <span class="arrow">${sortDir > 0 ? '▲' : '▼'}</span>` : '';
      return `<th data-col="${c.key}" class="${c.sort ? 'sortable' : ''}" style="width:${c.w}px">${c.label}${arrow}</th>`;
    }).join('') + '</tr>';
    const selAll = thead.querySelector('#igSelAll');
    if (selAll) {
      selAll.checked = view.length > 0 && view.every(r => sel.has(r.id));
      selAll.addEventListener('click', e => {
        e.stopPropagation();
        if (e.target.checked) view.forEach(r => sel.add(r.id));
        else view.forEach(r => sel.delete(r.id));
        renderBody();
      });
    }
  }

  function onHeadClick(e) {
    const th = e.target.closest('th');
    if (!th || !th.classList.contains('sortable')) return;
    const col = th.dataset.col;
    if (sortCol === col) sortDir = -sortDir; else { sortCol = col; sortDir = 1; }
    applyAndRender();
  }

  // ── Filter + sort ───────────────────────────────────────────────────────────
  function applyAndRender() {
    view = rows.filter(r => {
      if (kindFilter !== 'all' && kindOf(r) !== kindFilter) return false;
      if (statusFilter !== 'all' && (r.status || 'new') !== statusFilter) return false;
      if (query) {
        const hay = (r.author + ' ' + r.id + ' ' + (r.VidTitle || '') + ' ' + (r.ftext || '') + ' ' + (r.status || '')).toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
    const val = (r) => {
      if (sortCol === 'kind') return kindOf(r);
      if (sortCol === 'status') return r.status || 'new';
      if (sortCol === 'durSecs') return +r.durSecs || 0;
      if (sortCol === '_wxh') return (+r.height || 0) * 100000 + (+r.width || 0);
      return (r[sortCol] != null ? r[sortCol] : '');
    };
    view.sort((a, b) => {
      const A = val(a), B = val(b);
      if (A < B) return -sortDir;
      if (A > B) return sortDir;
      return 0;
    });
    renderHead();
    renderBody();
    updateCount();
  }

  function updateCount() {
    const promoted = rows.filter(r => r.status === 'promoted').length;
    const enriched = rows.filter(r => r.status === 'enriched' || r.status === 'downloaded').length;
    const el = document.getElementById('igCount');
    if (el) el.textContent =
      `${view.length}/${rows.length} shown · ${enriched} enriched · ${promoted} promoted · ${sel.size} selected` +
      (dirty ? ' · ⚠ unsaved' : '');
    const sv = document.getElementById('igSave');
    if (sv) sv.classList.toggle('primary', dirty);
  }

  // ── Body render ─────────────────────────────────────────────────────────────
  function renderBody() {
    const tb = document.querySelector('#igTable tbody');
    const empty = document.getElementById('igEmpty');
    if (!view.length) {
      tb.innerHTML = '';
      empty.style.display = 'block';
      empty.textContent = rows.length ? 'No rows match the filter.' : 'ig.json is empty — harvest some reels first.';
      updateCount();
      return;
    }
    empty.style.display = 'none';
    tb.innerHTML = view.map(r => {
      const k = kindOf(r);
      const st = r.status || 'new';
      const cap = r.ftext ? '<span class="yes">✓</span>' : '<span class="no">—</span>';
      const tt = r.ttxt ? '<span class="yes">✓</span>' : '<span class="no">—</span>';
      const wxh = (r.width && r.height) ? (r.width + '×' + r.height) : '<span class="no">—</span>';
      const dur = r.durSecs ? fmtDur(r.durSecs) : '<span class="no">—</span>';
      return `<tr data-id="${esc(r.id)}" class="st-${st} ${r.id === focusId ? 'focus' : ''}">
        <td class="c-sel"><input type="checkbox" class="igchk" ${sel.has(r.id) ? 'checked' : ''}></td>
        <td><span class="badge k-${k}">${k}</span></td>
        <td title="${esc(r.author)}">${esc(r.author)}</td>
        <td><a class="idlink" href="${esc(igLink(r))}" target="_blank" rel="noopener" title="Open on Instagram">${esc(r.id)}</a></td>
        <td title="${esc(r.VidTitle || '')}">${esc(r.VidTitle || '')}</td>
        <td class="mono">${dur}</td>
        <td class="mono">${wxh}</td>
        <td class="mono">${esc(r.DatePosted || '') || '<span class="no">—</span>'}</td>
        <td style="text-align:center">${cap}</td>
        <td style="text-align:center">${tt}</td>
        <td><span class="s-${st}">${st}</span></td>
        <td class="mono">${esc(r.DateAdded || '')}</td>
        <td class="c-act">
          <button data-act="enrich" title="yt-dlp → title/caption/ttxt/author/date/res">✨</button>
          <button data-act="download" title="Download max-res → ig_media/">⬇</button>
          <button data-act="promote" title="Add to ml.json" ${st === 'promoted' ? 'disabled' : ''}>➕</button>
          <button data-act="detail" title="Details">⋯</button>
        </td>
      </tr>`;
    }).join('');
    renderHead();
    updateCount();
  }

  // ── Body interactions ───────────────────────────────────────────────────────
  function rowById(id) { return rows.find(r => r.id === id); }

  function onBodyClick(e) {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const r = rowById(tr.dataset.id);
    if (!r) return;
    if (e.target.classList.contains('igchk')) {
      if (e.target.checked) sel.add(r.id); else sel.delete(r.id);
      updateCount();
      return;
    }
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'enrich') { enrichRow(r, true); return; }
    if (act === 'download') { downloadRow(r, true); return; }
    if (act === 'promote') { promoteRow(r, true); return; }
    openDrawer(r);   // ⋯ or plain row click
  }

  // ── Detail drawer ───────────────────────────────────────────────────────────
  function openDrawer(r) {
    focusId = r.id;
    const k = kindOf(r);
    document.getElementById('igDrawerBody').innerHTML = `
      <h3>${esc(r.VidTitle || r.id)}</h3>
      <div class="meta">
        <span class="badge k-${k}">${k}</span> · <span class="s-${r.status || 'new'}">${r.status || 'new'}</span> ·
        ${esc(r.author)} · <a class="idlink" href="${esc(igLink(r))}" target="_blank" rel="noopener">${esc(r.id)}</a>
      </div>
      <div class="kv">
        <b>VidAuthor</b><span>${esc(r.VidAuthor || '—')}</span>
        <b>Posted</b><span>${esc(r.DatePosted || '—')}</span>
        <b>Duration</b><span>${r.durSecs ? esc(fmtDur(r.durSecs)) : '—'}</span>
        <b>W×H (max)</b><span>${(r.width && r.height) ? (r.width + ' × ' + r.height) : '—'}</span>
        <b>Harvested</b><span>${esc(r.DateAdded || '—')}</span>
        ${r.mlUID ? `<b>ml UID</b><span>${esc(r.mlUID)}</span>` : ''}
        ${r.localFiles && r.localFiles.length ? `<b>File</b><span>📁 ${esc(r.localFiles.join(', '))}</span>` : ''}
      </div>
      <div class="sect"><b>Download filename ${(r.durSecs == null || r.width == null) ? '<span style="color:#d59a3a;font-weight:400">— finalizes after Enrich</span>' : ''}</b>
        <div class="fname">${esc(downloadName(r))}.mp4</div></div>
      <div class="acts">
        <button data-d="enrich" class="primary">✨ Enrich</button>
        <button data-d="download">⬇ Download</button>
        <button data-d="paste">📋 Saved-text</button>
        <button data-d="promote" ${r.status === 'promoted' ? 'disabled' : ''}>➕ Promote</button>
        <button data-d="open">↗ Instagram</button>
      </div>
      <div class="sect"><b>ftext (clean caption)</b><div class="ftext">${r.ftext || '<span class="no">— not enriched —</span>'}</div></div>
      <div class="sect"><b>ttxt (full info)</b><div class="ttxt">${r.ttxt || '<span class="no">— none —</span>'}</div></div>
    `;
    const body = document.getElementById('igDrawerBody');
    body.querySelectorAll('.acts button').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.d;
      if (a === 'enrich') enrichRow(r, true).then(() => openDrawer(r));
      else if (a === 'download') downloadRow(r, true).then(() => openDrawer(r));
      else if (a === 'paste') openPasteModal(r);
      else if (a === 'promote') { promoteRow(r, true); openDrawer(r); }
      else if (a === 'open') window.open(igLink(r), '_blank', 'noopener');
    }));
    document.getElementById('igDrawer').classList.add('open');
    document.querySelectorAll('#igTable tr.focus').forEach(t => t.classList.remove('focus'));
    document.querySelector(`#igTable tr[data-id="${CSS.escape(r.id)}"]`)?.classList.add('focus');
  }
  function closeDrawer() {
    focusId = null;
    document.getElementById('igDrawer').classList.remove('open');
    document.querySelectorAll('#igTable tr.focus').forEach(t => t.classList.remove('focus'));
  }
  function drawerOpen() { return document.getElementById('igDrawer')?.classList.contains('open'); }

  // ── ttxt builder (yt-dlp "everything" bucket — only when ttxt is empty so the
  //    richer Firefox-saved-page ttxt, with comments + sibling URLs, never clobbered)
  function buildTtxt(meta, url) {
    const desc = (meta.description || '').trim();
    const handle = (typeof _ytdlpAuthorHandle === 'function') ? _ytdlpAuthorHandle(meta) : '';
    const head = [];
    if (handle) head.push(handle);
    const dp = datePosted(meta); if (dp) head.push(dp);
    if (Number.isFinite(meta.duration)) head.push(fmtDur(meta.duration));
    if (meta.width && meta.height) head.push(meta.width + '×' + meta.height);
    if (Number.isFinite(meta.like_count)) head.push(meta.like_count.toLocaleString() + ' likes');
    if (Number.isFinite(meta.view_count)) head.push(meta.view_count.toLocaleString() + ' views');
    const tags = desc.match(/#[A-Za-z0-9_]+/g) || [];
    let html = '';
    if (head.length) html += '<p style="color:#888">' + esc(head.join(' · ')) + '</p>\n';
    const body = desc.split(/\r?\n/).map(l => l.trim()).filter(l => l && l !== '.')
      .map(l => '<p>' + esc(l) + '</p>').join('\n');
    if (body) html += body + '\n';
    if (tags.length) html += '<p style="color:#69c">' + esc([...new Set(tags)].join(' ')) + '</p>\n';
    html += '<p>Source: <a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(url) + '</a></p>';
    return html;
  }

  // ── Enrich (yt-dlp → title/ftext/ttxt/author/date/duration/res) ─────────────
  async function enrichRow(r, single) {
    if (typeof _ytdlpFetchMeta !== 'function') { igToast('yt-dlp pipeline not loaded', 2500); return false; }
    try {
      if (typeof _ensureCommonWords === 'function') await _ensureCommonWords();
      const meta = await _ytdlpFetchMeta(r.url);
      const desc = (meta.description || '').trim();
      const handle = (typeof _ytdlpAuthorHandle === 'function') ? _ytdlpAuthorHandle(meta) : '';
      if (!desc && !handle && !Number.isFinite(meta.duration)) throw new Error('empty metadata (IG may be login-walled)');
      if (!r.ftext && typeof _ytdlpBuildFtext === 'function') r.ftext = _ytdlpBuildFtext(meta, r.url);
      if (!r.ttxt) r.ttxt = buildTtxt(meta, r.url);
      if (!r.VidAuthor && handle) r.VidAuthor = handle;
      if (!r.VidTitle) {
        const t = (meta.title || '').trim();
        r.VidTitle = (!t || /^video by /i.test(t))
          ? (typeof _smartIgTitle === 'function' ? _smartIgTitle(desc) : desc.slice(0, 70))
          : (typeof _normalizeText === 'function' ? _normalizeText(t).replace(/\s+/g, ' ').trim() : t);
      }
      const dp = datePosted(meta); if (dp) r.DatePosted = dp;
      if (Number.isFinite(meta.duration)) r.durSecs = Math.round(meta.duration);
      if (meta.width) r.width = +meta.width;
      if (meta.height) r.height = +meta.height;
      if (r.status === 'new' || !r.status) r.status = 'enriched';
      dirty = true;
      if (single) { applyAndRender(); persist(false); igToast('✓ enriched ' + r.id, 1500); }
      return true;
    } catch (e) {
      if (single) igToast('✗ enrich ' + r.id + ': ' + (e && e.message), 3200);
      return false;
    }
  }

  async function batchEnrich() {
    const ids = [...sel];
    if (!ids.length) { igToast('Select rows first (checkboxes)', 1800); return; }
    if (busy) return;
    busy = true; setBatchUi(true);
    let ok = 0, n = 0;
    for (const id of ids) {
      const r = rowById(id); if (!r) continue;
      n++;
      document.getElementById('igCount').textContent = `Enriching ${n}/${ids.length}…`;
      if (await enrichRow(r, false)) ok++;
      applyAndRender();
    }
    busy = false; setBatchUi(false);
    if (ok) { dirty = true; await persist(false); }
    igToast(`✓ enriched ${ok}/${ids.length}`, 2600);
    applyAndRender();
  }

  // ── Download (max res → ig_media/ named per AHK convention) ─────────────────
  async function downloadRow(r, single) {
    // Need title/duration/res for the filename → enrich first if missing.
    if (!r.VidTitle || r.durSecs == null || r.width == null) {
      const ok = await enrichRow(r, false);
      if (!ok && !r.VidTitle) { if (single) igToast('✗ ' + r.id + ': enrich failed, cannot name file', 3200); return false; }
      applyAndRender();
    }
    try {
      const res = await fetch(PROXY + '/ig/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: r.id, url: r.url, name: downloadName(r) })
      });
      const j = await res.json();
      if (!j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + res.status));
      r.localFiles = j.files || [];
      if (r.status !== 'promoted') r.status = 'downloaded';
      dirty = true;
      if (single) { applyAndRender(); persist(false); igToast('✓ downloaded ' + r.id + '\n' + (r.localFiles[0] || ''), 2800); }
      return true;
    } catch (e) {
      if (single) igToast('✗ download ' + r.id + ': ' + (e && e.message), 3500);
      return false;
    }
  }

  async function batchDownload() {
    const ids = [...sel];
    if (!ids.length) { igToast('Select rows first (checkboxes)', 1800); return; }
    if (busy) return;
    if (!confirm(`Download ${ids.length} item(s) at max resolution into ig_media/ ?\n(Enriches first for the filename; IG may need Firefox cookies; can be slow.)`)) return;
    busy = true; setBatchUi(true);
    let ok = 0, n = 0;
    for (const id of ids) {
      const r = rowById(id); if (!r) continue;
      n++;
      document.getElementById('igCount').textContent = `Downloading ${n}/${ids.length}…`;
      if (await downloadRow(r, false)) ok++;
      applyAndRender();
    }
    busy = false; setBatchUi(false);
    if (ok) { dirty = true; await persist(false); }
    igToast(`✓ downloaded ${ok}/${ids.length}`, 2600);
    applyAndRender();
  }

  // ── Promote → ml.json ───────────────────────────────────────────────────────
  function promoteRow(r, single) {
    if (r.status === 'promoted') { igToast(r.id + ' already promoted (UID ' + r.mlUID + ')', 2200); return null; }
    if (typeof data === 'undefined' || typeof nextUID !== 'function' || typeof save !== 'function') {
      igToast('ml.json not loaded — open the T screen first', 3000); return null;
    }
    const now = (typeof isoNow === 'function') ? isoNow() : new Date().toISOString().slice(0, 19).replace('T', ' ');
    const mlRow = {
      UID: nextUID(),
      link: r.url,
      VidTitle: r.VidTitle || '',
      VidAuthor: r.VidAuthor || ('@' + r.author),
      ftext: r.ftext || '',
      ttxt: r.ttxt || '',
      vidLength: r.durSecs ? fmtDur(r.durSecs) : '',
      DatePosted: r.DatePosted || '',
      show: '1',
      DateAdded: now,
      DateModified: now,
      tags: [],
      igSource: r.id            // provenance: which ig.json row this came from
    };
    data.push(mlRow);
    save();
    r.status = 'promoted';
    r.mlUID = mlRow.UID;
    dirty = true;
    if (single) { applyAndRender(); persist(false); igToast('➕ promoted ' + r.id + ' → ml.json UID ' + mlRow.UID, 2400); }
    return mlRow;
  }

  function batchPromote() {
    const ids = [...sel].filter(id => { const r = rowById(id); return r && r.status !== 'promoted'; });
    if (!ids.length) { igToast('Select un-promoted rows first', 2000); return; }
    if (!confirm(`Promote ${ids.length} row(s) into ml.json?\nThey'll become real rows in T/G.`)) return;
    let ok = 0;
    for (const id of ids) { const r = rowById(id); if (r && promoteRow(r, false)) ok++; }
    dirty = true;
    persist(false);
    applyAndRender();
    igToast(`➕ promoted ${ok} row(s) → ml.json`, 2600);
  }

  function setBatchUi(on) {
    ['igEnrichSel', 'igDownloadSel', 'igPromoteSel', 'igReload'].forEach(id => {
      const b = document.getElementById(id); if (b) b.disabled = on;
    });
  }

  // ── Firefox "Save Page As Text" → ttxt (the manual, unflaggable rich path) ──
  // The literal save happens in the user's Firefox (the I screen, a localhost page,
  // can't read instagram.com's logged-in DOM). Here we just take that saved text and
  // apply it to the matching ig.json row — reusing the SAME core.js parser the W
  // screen uses (_parseIgSavedText / _igTtxtHtml / _igCaptionFtext), so the ttxt is
  // identical, just targeted at ig.json instead of ml.json.
  let _pasteTarget = null;     // row pre-targeted by the drawer button (else route by id)
  function openPasteModal(targetRow) {
    _pasteTarget = targetRow || null;
    const hint = document.getElementById('igModalHint');
    if (hint) hint.textContent = targetRow
      ? 'Pasting for row ' + targetRow.id + '. In Firefox: open the reel → Save Page As ▸ Text → paste it here.'
      : 'In Firefox: open the reel → Save Page As ▸ Text Files → open that .txt → paste it here. Routes to the row by reel id; comments + sibling URLs land in ttxt.';
    document.getElementById('igModalText').value = '';
    document.getElementById('igModalBack').classList.add('open');
    setTimeout(() => document.getElementById('igModalText').focus(), 30);
  }
  function closePasteModal() {
    document.getElementById('igModalBack').classList.remove('open');
    _pasteTarget = null;
  }
  function modalOpen() { return document.getElementById('igModalBack')?.classList.contains('open'); }

  async function applyPaste() {
    const txt = document.getElementById('igModalText').value || '';
    if (typeof _parseIgSavedText !== 'function') { igToast('IG parser not loaded', 2500); return; }
    if (typeof _looksLikeIgSavedText === 'function' && !_looksLikeIgSavedText(txt)) {
      if (!confirm("That doesn't look like an Instagram saved page. Try parsing it anyway?")) return;
    }
    if (typeof _ensureCommonWords === 'function') await _ensureCommonWords();
    let p;
    try { p = _parseIgSavedText(txt); } catch (e) { igToast('Parse failed: ' + e.message, 3000); return; }

    // Resolve the target row: the drawer pre-target wins; else match by parsed reel id.
    let row = _pasteTarget || (p.currentId ? rowById(p.currentId) : null);
    if (row && p.currentId && row.id !== p.currentId) {
      if (!confirm('Saved text is for reel ' + p.currentId + ', but this row is ' + row.id + '.\nApply to this row anyway?')) return;
    }
    if (!row && p.currentId) {
      igToast('No ig.json row for reel ' + p.currentId + ' (harvest it first).\nParsed @' + (p.handle || '?') + ' · ' + p.comments.length + ' comments.', 5000);
      return;
    }
    if (!row) { igToast('No current reel id found in the text, and no row was pre-selected.', 4000); return; }

    const parts = [];
    if (!row.VidTitle && p.caption) { row.VidTitle = _smartIgTitle(p.caption); parts.push('VidTitle'); }
    if (!row.VidAuthor && p.handle) { row.VidAuthor = '@' + p.handle; parts.push('VidAuthor'); }
    const isStub = /^<p><a [^>]*>https?:\/\/[^<]+<\/a><\/p>$/.test((row.ftext || '').trim());
    if ((!row.ftext || isStub) && p.caption && typeof _igCaptionFtext === 'function') { row.ftext = _igCaptionFtext(p.caption); parts.push('ftext'); }
    row.ttxt = _igTtxtHtml(p); parts.push('ttxt');           // rich dump always wins (it's the prize)
    if (row.status === 'new' || !row.status) row.status = 'enriched';
    dirty = true;
    const sib = p.reels.filter(x => x.id !== p.currentId).length;
    const hadTarget = !!_pasteTarget;
    closePasteModal();
    applyAndRender();
    persist(false);
    if (focusId === row.id || hadTarget) openDrawer(row);
    igToast('✓ saved-text → ' + row.id + ' [' + parts.join(', ') + ']\n@' + (p.handle || '?') + ' · ' + p.comments.length + ' comments · ' + sib + ' sibling reels in ttxt', 5000);
  }

  // ── Persist back to ig.json (proxy /ig/save) ────────────────────────────────
  async function persist(announce) {
    try {
      const res = await fetch(PROXY + '/ig/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows })
      });
      const j = await res.json();
      if (!j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + res.status));
      dirty = false;
      updateCount();
      if (announce) igToast('💾 saved ig.json (' + j.total + ' rows)', 1800);
      return true;
    } catch (e) {
      if (announce) igToast('✗ save failed: ' + (e && e.message) + '\n(Is proxy.js running & dev0429+?)', 4000);
      return false;
    }
  }

  // ── Load ────────────────────────────────────────────────────────────────────
  async function loadData() {
    try {
      const r = await fetch(STORE_URL());
      rows = r.ok ? (await r.json()) : [];
      if (!Array.isArray(rows)) rows = [];
    } catch (e) { rows = []; igToast('Could not load ig.json: ' + e.message, 3000); }
    sel.clear(); dirty = false;
    applyAndRender();
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  function openIgScreen() {
    if (typeof _isUserMode === 'function' && _isUserMode()) return;   // dev-only
    build();
    document.getElementById('igOverlay').classList.add('open');
    loadData();
    setTimeout(() => document.getElementById('igSearch')?.focus(), 30);
  }
  function closeIgScreen() {
    if (dirty) persist(false);     // best-effort flush on close
    closeDrawer();
    document.getElementById('igOverlay')?.classList.remove('open');
  }
  function isIgScreenOpen() {
    return document.getElementById('igOverlay')?.classList.contains('open') || false;
  }

  // Esc: close drawer first, then the screen. Capture-phase so it beats other
  // global Esc handlers while Ig owns the screen.
  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !isIgScreenOpen()) return;
    if (modalOpen()) { e.stopPropagation(); e.preventDefault(); closePasteModal(); return; }
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) { ae.blur(); e.stopPropagation(); e.preventDefault(); return; }
    e.stopPropagation(); e.preventDefault();
    if (drawerOpen()) closeDrawer(); else closeIgScreen();
  }, true);

  window.openIgScreen = openIgScreen;
  window.closeIgScreen = closeIgScreen;
  window.isIgScreenOpen = isIgScreenOpen;
})();
