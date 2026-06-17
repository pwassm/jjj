// ══════════════════════════════════════════════════════════════════════════════
// I / Ig SCREEN — staging table for ig.json (dev0429)
// ══════════════════════════════════════════════════════════════════════════════
// A standalone, dev-only screen that views the IG-harvest staging store (ig.json)
// the way T views ml.json — but deliberately SEPARATE from ml.json/T/G so the
// 1000s of harvested reels never clutter the working table. From here a row can be
//   • Enriched  → yt-dlp caption/author → VidTitle + ftext + VidAuthor (reuses the
//                 exact core.js IG pipeline: _ytdlpFetchMeta / _smartIgTitle / …)
//   • Downloaded→ proxy /ig/download → yt-dlp saves the media to <project>/ig_media/
//   • Promoted  → a real ml.json row is minted (data.push + save()) so it joins T/G.
// All edits persist back to ig.json via the proxy /ig/save endpoint.
//
// Hotkey: I (dev-only, blocked in user mode like T). Esc closes the detail drawer,
// then the screen. The file is isolated (like movingcells.js/flycells.js) — delete
// the <script> tag + the `i` wiring in core.js/vp.js to excise the whole feature.
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
  let showThumbs = true;
  let thumbObserver = null;
  let busy = false;                    // a batch op is running

  // ── Helpers ────────────────────────────────────────────────────────────────
  const esc = s => String(s == null ? '' : s).replace(/[<>&"]/g,
    c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const kindOf = r => /\/reel\//i.test(r.url || '') ? 'reel'
                   : /\/p\//i.test(r.url || '') ? 'p'
                   : /\/tv\//i.test(r.url || '') ? 'tv' : '?';
  // Public IG thumbnail endpoint (best-effort; IG may login-wall). Routed through
  // the local CORS proxy so it carries a spoofed Referer/UA. /p/ works for reels too.
  const thumbUrl = r => PROXY + '/https://www.instagram.com/p/' + encodeURIComponent(r.id) + '/media/?size=m';
  const igLink = r => r.url || ('https://www.instagram.com/p/' + r.id + '/');

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
#igBar button.primary:disabled{opacity:.5;cursor:default}
#igBar .spacer{flex:1}
#igBar #igClose{font-size:18px;padding:2px 10px;line-height:1}
#igWrap{flex:1;overflow:auto;position:relative}
#igTable{border-collapse:collapse;width:100%;table-layout:fixed}
#igTable th{position:sticky;top:0;background:#171d26;border-bottom:1px solid #2c3645;
  padding:6px 8px;text-align:left;font-weight:600;color:#9fb0c2;user-select:none;z-index:2}
#igTable th.sortable{cursor:pointer}
#igTable th.sortable:hover{color:#cfe}
#igTable th .arrow{color:#0a84ff;font-size:11px}
#igTable td{padding:4px 8px;border-bottom:1px solid #1d242e;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}
#igTable tr:hover td{background:#161d27}
#igTable tr.focus td{background:#1d2a3a}
#igTable tr.st-enriched td{box-shadow:inset 3px 0 0 #4caf50}
#igTable tr.st-downloaded td{box-shadow:inset 3px 0 0 #ffb300}
#igTable tr.st-promoted td{box-shadow:inset 3px 0 0 #0a84ff;opacity:.7}
#igTable td.c-thumb{padding:2px}
#igTable img.thumb{width:44px;height:44px;object-fit:cover;border-radius:5px;
  background:#222;display:block}
#igTable .badge{display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:700}
.k-reel{background:#3a2a52;color:#caa6ff}.k-p{background:#1e3a4a;color:#7fd0ee}.k-tv{background:#4a2a2a;color:#eeae7f}.k-q{background:#333;color:#aaa}
.s-new{color:#7d8794}.s-enriched{color:#7fd47f}.s-downloaded{color:#ffc04d}.s-promoted{color:#6fb6ff}
#igTable a.idlink{color:#7fb8ff;text-decoration:none}
#igTable a.idlink:hover{text-decoration:underline}
#igTable .yes{color:#7fd47f;font-weight:700}.no{color:#4a5563}
#igTable td.c-act{white-space:nowrap}
#igTable td.c-act button{background:#1f2733;border:1px solid #34404f;color:#cfe;
  border-radius:5px;padding:3px 7px;margin-right:3px;cursor:pointer;font:600 11px system-ui}
#igTable td.c-act button:hover{background:#2b3543}
#igTable td.c-act button:disabled{opacity:.4;cursor:default}
#igDrawer{position:absolute;top:0;right:0;bottom:0;width:380px;background:#0e1219;
  border-left:1px solid #2c3645;box-shadow:-6px 0 18px rgba(0,0,0,.4);overflow:auto;
  padding:14px;display:none}
#igDrawer.open{display:block}
#igDrawer h3{margin:0 0 8px;font-size:14px;color:#9ad}
#igDrawer .dthumb{width:100%;max-height:300px;object-fit:contain;background:#000;border-radius:6px;margin-bottom:10px}
#igDrawer .meta{color:#8aa;font-size:12px;margin-bottom:8px;word-break:break-all}
#igDrawer .sect{margin:10px 0;border-top:1px solid #1d242e;padding-top:8px}
#igDrawer .sect b{color:#9fb0c2;display:block;margin-bottom:4px;font-size:12px}
#igDrawer .ftext{background:#11161e;border:1px solid #1d242e;border-radius:6px;padding:8px;
  max-height:200px;overflow:auto;font-size:12px;white-space:normal}
#igDrawer .ttxt{background:#11161e;border:1px solid #1d242e;border-radius:6px;padding:8px;
  max-height:160px;overflow:auto;font-size:11px;white-space:pre-wrap;color:#9aa}
#igDrawer .acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
#igDrawer .acts button{flex:1 1 auto;background:#1f2733;border:1px solid #34404f;color:#cfe;
  border-radius:6px;padding:7px;cursor:pointer;font:600 12px system-ui;min-width:90px}
#igDrawer .acts button.primary{background:#0a84ff;border-color:#0a84ff;color:#fff}
#igDrawer #igDrawerClose{position:absolute;top:8px;right:10px;background:none;border:0;
  color:#9aa;font-size:20px;cursor:pointer}
#igEmpty{padding:40px;text-align:center;color:#7d8794}
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
        <button id="igThumbToggle" title="Toggle thumbnails">🖼 thumbs</button>
        <div class="spacer"></div>
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
      </div>`;
    document.body.appendChild(o);

    // toolbar wiring
    const $ = id => o.querySelector('#' + id);
    $('igSearch').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); applyAndRender(); });
    $('igKind').addEventListener('change', e => { kindFilter = e.target.value; applyAndRender(); });
    $('igStatus').addEventListener('change', e => { statusFilter = e.target.value; applyAndRender(); });
    $('igThumbToggle').addEventListener('click', () => { showThumbs = !showThumbs; renderBody(); });
    $('igEnrichSel').addEventListener('click', () => batchEnrich());
    $('igDownloadSel').addEventListener('click', () => batchDownload());
    $('igPromoteSel').addEventListener('click', () => batchPromote());
    $('igReload').addEventListener('click', () => loadData());
    $('igSave').addEventListener('click', () => persist(true));
    $('igClose').addEventListener('click', () => closeIgScreen());
    $('igDrawerClose').addEventListener('click', () => closeDrawer());

    // delegated table click (selection, sorting, row actions)
    o.querySelector('#igTable thead').addEventListener('click', onHeadClick);
    o.querySelector('#igTable tbody').addEventListener('click', onBodyClick);
  }

  // ── Header (sortable) ───────────────────────────────────────────────────────
  const COLS = [
    { key: '_sel', label: '<input type="checkbox" id="igSelAll">', w: 30, sort: false },
    { key: '_thumb', label: '', w: 52, sort: false },
    { key: 'kind', label: 'Kind', w: 56, sort: true },
    { key: 'author', label: 'Author', w: 130, sort: true },
    { key: 'id', label: 'ID', w: 120, sort: true },
    { key: 'VidTitle', label: 'Title', w: 280, sort: true },
    { key: '_cap', label: 'Cap', w: 46, sort: false },
    { key: '_ttxt', label: 'ttxt', w: 46, sort: false },
    { key: 'status', label: 'Status', w: 90, sort: true },
    { key: 'DateAdded', label: 'Added', w: 140, sort: true },
    { key: '_act', label: 'Actions', w: 210, sort: false }
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
    const enriched = rows.filter(r => r.status === 'enriched').length;
    document.getElementById('igCount').textContent =
      `${view.length}/${rows.length} shown · ${enriched} enriched · ${promoted} promoted · ${sel.size} selected` +
      (dirty ? ' · ⚠ unsaved' : '');
    const sv = document.getElementById('igSave');
    if (sv) sv.classList.toggle('primary', dirty);
  }

  // ── Body render (lazy thumbnails via IntersectionObserver) ──────────────────
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
    const html = view.map(r => {
      const k = kindOf(r);
      const st = r.status || 'new';
      const thumb = showThumbs
        ? `<img class="thumb" data-src="${esc(thumbUrl(r))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
        : '';
      const cap = r.ftext ? '<span class="yes">✓</span>' : '<span class="no">—</span>';
      const tt = r.ttxt ? '<span class="yes">✓</span>' : '<span class="no">—</span>';
      const promoted = st === 'promoted';
      return `<tr data-id="${esc(r.id)}" class="st-${st} ${r.id === focusId ? 'focus' : ''}">
        <td class="c-sel"><input type="checkbox" class="igchk" ${sel.has(r.id) ? 'checked' : ''}></td>
        <td class="c-thumb">${thumb}</td>
        <td><span class="badge k-${k}">${k}</span></td>
        <td title="${esc(r.author)}">${esc(r.author)}</td>
        <td><a class="idlink" href="${esc(igLink(r))}" target="_blank" rel="noopener" title="Open on Instagram">${esc(r.id)}</a></td>
        <td title="${esc(r.VidTitle || '')}">${esc(r.VidTitle || '')}</td>
        <td style="text-align:center">${cap}</td>
        <td style="text-align:center">${tt}</td>
        <td><span class="s-${st}">${st}</span></td>
        <td>${esc(r.DateAdded || '')}</td>
        <td class="c-act">
          <button data-act="enrich" title="yt-dlp → title/caption/author">✨</button>
          <button data-act="download" title="yt-dlp → ig_media/">⬇</button>
          <button data-act="promote" title="Add to ml.json" ${promoted ? 'disabled' : ''}>➕</button>
          <button data-act="detail" title="Details">⋯</button>
        </td>
      </tr>`;
    }).join('');
    tb.innerHTML = html;
    renderHead();      // refresh the select-all checkbox state
    updateCount();
    if (showThumbs) wireThumbs();
  }

  function wireThumbs() {
    if (thumbObserver) thumbObserver.disconnect();
    thumbObserver = new IntersectionObserver((entries, obs) => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        const img = en.target;
        if (img.dataset.src) { img.src = img.dataset.src; img.removeAttribute('data-src'); }
        obs.unobserve(img);
      });
    }, { root: document.getElementById('igWrap'), rootMargin: '200px' });
    document.querySelectorAll('#igTable img.thumb[data-src]').forEach(img => thumbObserver.observe(img));
  }

  // ── Body interactions ───────────────────────────────────────────────────────
  function rowById(id) { return rows.find(r => r.id === id); }

  function onBodyClick(e) {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const id = tr.dataset.id;
    const r = rowById(id);
    if (!r) return;
    if (e.target.classList.contains('igchk')) {
      if (e.target.checked) sel.add(id); else sel.delete(id);
      updateCount();
      return;
    }
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'enrich') { enrichRow(r, true); return; }
    if (act === 'download') { downloadRow(r, true); return; }
    if (act === 'promote') { promoteRow(r, true); return; }
    if (act === 'detail') { openDrawer(r); return; }
    // plain row click → drawer
    openDrawer(r);
  }

  // ── Detail drawer ───────────────────────────────────────────────────────────
  function openDrawer(r) {
    focusId = r.id;
    const d = document.getElementById('igDrawer');
    const k = kindOf(r);
    document.getElementById('igDrawerBody').innerHTML = `
      <h3>${esc(r.VidTitle || r.id)}</h3>
      <img class="dthumb" src="${esc(thumbUrl(r))}" onerror="this.style.display='none'" alt="">
      <div class="meta">
        <span class="badge k-${k}">${k}</span> · <span class="s-${r.status || 'new'}">${r.status || 'new'}</span><br>
        ${esc(r.author)} · <a class="idlink" href="${esc(igLink(r))}" target="_blank" rel="noopener">${esc(r.id)}</a><br>
        added ${esc(r.DateAdded || '')}${r.mlUID ? ' · ml UID ' + esc(r.mlUID) : ''}
        ${r.localFiles && r.localFiles.length ? '<br>📁 ' + esc(r.localFiles.join(', ')) : ''}
      </div>
      <div class="acts">
        <button data-d="enrich" class="primary">✨ Enrich</button>
        <button data-d="download">⬇ Download</button>
        <button data-d="promote" ${r.status === 'promoted' ? 'disabled' : ''}>➕ Promote</button>
        <button data-d="open">↗ Instagram</button>
      </div>
      <div class="sect"><b>VidAuthor</b>${esc(r.VidAuthor || '—')}</div>
      <div class="sect"><b>ftext (caption)</b><div class="ftext">${r.ftext || '<span class="no">— not enriched —</span>'}</div></div>
      ${r.ttxt ? `<div class="sect"><b>ttxt (saved-page text)</b><div class="ttxt">${esc(r.ttxt)}</div></div>` : ''}
    `;
    const body = document.getElementById('igDrawerBody');
    body.querySelectorAll('.acts button').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.d;
      if (a === 'enrich') enrichRow(r, true).then(() => openDrawer(r));
      else if (a === 'download') downloadRow(r, true).then(() => openDrawer(r));
      else if (a === 'promote') { promoteRow(r, true); openDrawer(r); }
      else if (a === 'open') window.open(igLink(r), '_blank', 'noopener');
    }));
    d.classList.add('open');
    // reflect focus highlight in the table
    document.querySelectorAll('#igTable tr.focus').forEach(t => t.classList.remove('focus'));
    document.querySelector(`#igTable tr[data-id="${CSS.escape(r.id)}"]`)?.classList.add('focus');
  }
  function closeDrawer() {
    focusId = null;
    document.getElementById('igDrawer').classList.remove('open');
    document.querySelectorAll('#igTable tr.focus').forEach(t => t.classList.remove('focus'));
  }
  function drawerOpen() { return document.getElementById('igDrawer')?.classList.contains('open'); }

  // ── Enrich (yt-dlp metadata → VidTitle/ftext/VidAuthor) ─────────────────────
  async function enrichRow(r, single) {
    if (typeof _ytdlpFetchMeta !== 'function') { igToast('yt-dlp pipeline not loaded', 2500); return; }
    try {
      if (typeof _ensureCommonWords === 'function') await _ensureCommonWords();
      const meta = await _ytdlpFetchMeta(r.url);
      const desc = (meta.description || '').trim();
      const handle = (typeof _ytdlpAuthorHandle === 'function') ? _ytdlpAuthorHandle(meta) : '';
      if (!desc && !handle) throw new Error('empty metadata (IG may be login-walled)');
      if (!r.ftext && typeof _ytdlpBuildFtext === 'function') r.ftext = _ytdlpBuildFtext(meta, r.url);
      if (!r.VidAuthor && handle) r.VidAuthor = handle;
      if (!r.VidTitle) {
        const t = (meta.title || '').trim();
        r.VidTitle = (!t || /^video by /i.test(t))
          ? (typeof _smartIgTitle === 'function' ? _smartIgTitle(desc) : desc.slice(0, 70))
          : (typeof _normalizeText === 'function' ? _normalizeText(t).replace(/\s+/g, ' ').trim() : t);
      }
      if (r.status === 'new' || !r.status) r.status = 'enriched';
      dirty = true;
      if (single) { applyAndRender(); persist(false); igToast('✓ enriched ' + r.id, 1600); }
      return true;
    } catch (e) {
      igToast('✗ enrich ' + r.id + ': ' + (e && e.message), 3200);
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

  // ── Download (proxy → yt-dlp → ig_media/) ───────────────────────────────────
  async function downloadRow(r, single) {
    try {
      const res = await fetch(PROXY + '/ig/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: r.id, url: r.url })
      });
      const j = await res.json();
      if (!j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + res.status));
      r.localFiles = j.files || [];
      if (r.status !== 'promoted') r.status = 'downloaded';
      dirty = true;
      if (single) { applyAndRender(); persist(false); igToast('✓ downloaded ' + r.id + ' (' + (r.localFiles.length) + ' file)', 2200); }
      return true;
    } catch (e) {
      igToast('✗ download ' + r.id + ': ' + (e && e.message), 3500);
      return false;
    }
  }

  async function batchDownload() {
    const ids = [...sel];
    if (!ids.length) { igToast('Select rows first (checkboxes)', 1800); return; }
    if (busy) return;
    if (!confirm(`Download ${ids.length} item(s) via yt-dlp to ig_media/ ?\n(May be slow; IG may require Firefox cookies.)`)) return;
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
    if (r.status === 'promoted') { igToast(r.id + ' already promoted (UID ' + r.mlUID + ')', 2200); return; }
    if (typeof data === 'undefined' || typeof nextUID !== 'function' || typeof save !== 'function') {
      igToast('ml.json not loaded — open the T screen first', 3000); return;
    }
    const now = (typeof isoNow === 'function') ? isoNow() : new Date().toISOString().slice(0, 19).replace('T', ' ');
    const mlRow = {
      UID: nextUID(),
      link: r.url,
      VidTitle: r.VidTitle || '',
      VidAuthor: r.VidAuthor || ('@' + r.author),
      ftext: r.ftext || '',
      ttxt: r.ttxt || '',
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
    if (thumbObserver) thumbObserver.disconnect();
  }
  function isIgScreenOpen() {
    return document.getElementById('igOverlay')?.classList.contains('open') || false;
  }

  // Esc: close drawer first, then the screen. Capture-phase so it beats other
  // global Esc handlers while Ig owns the screen.
  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !isIgScreenOpen()) return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) { ae.blur(); e.stopPropagation(); e.preventDefault(); return; }
    e.stopPropagation(); e.preventDefault();
    if (drawerOpen()) closeDrawer(); else closeIgScreen();
  }, true);

  window.openIgScreen = openIgScreen;
  window.closeIgScreen = closeIgScreen;
  window.isIgScreenOpen = isIgScreenOpen;
})();
