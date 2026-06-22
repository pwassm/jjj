// ══════════════════════════════════════════════════════════════════════════════
// O / ORG-REVIEW SCREEN — browse o.json (parsed from Orgzly .org files) (dev0466)
// ══════════════════════════════════════════════════════════════════════════════
// A standalone, dev-only screen that lists the entries the user accumulated in the
// Orgzly (Android) app and exported as org-mode files. orgToO.js parses one .org file
// (currently orgzly/_org2/AqNew.org) into o.json — a store PARALLEL to ml.json, kept
// LOCAL (gitignored) like s.json / ig.json. Unlike ml.json these rows are NOT image/
// video-oriented: each is a saved article/link with a primitive org :tag: set and,
// usually, a big block of pasted article text the user wants to keep and re-read.
//
// The org tags here are DELIBERATELY independent of the T dictionary (tags.json):
// they live only as a plain string array on each o.json row. This screen never reads
// or writes tags.json.
//
// The table BODY is Tabulator (lazy-loaded on first open, same as the St screen) so
// the 8 000-row set virtualizes and stays responsive. A docked reading pane on the
// right shows the FULL pasted text of the focused row.
//
// Hotkey: O (dev-only, blocked in user mode like T/S/I). While O is on top:
//   ↑/↓ → move the focused (read) row   ·   f → focus search   ·   Shift+F → clear it
//   r   → toggle the reading pane        ·   Delete → delete the focused record
//   Esc → leave to T
// Inline edits to Title / Tags / Keyword persist to o.json via writeFileToDisk.
//
// (dev0469) Each row also carries: notebook (source .org, AqNew→main), dateAdded (org
// :CREATED: when present), dateModified (auto-stamped here on any edit). The reading
// pane is a PLAIN-TEXT <textarea> editor (native cut/copy/paste/undo) with a 👁 view
// toggle to the linkified read-only render; deletes are archived to odeleted.json.
// Legacy rows are backfilled in memory on load — o.json is never re-parsed, so the
// cleanO.js cleanup is preserved. orgToO.js emits the same fields for new imports.
//
// Globals borrowed from core.js (same realm — classic <script> tags share scope):
//   toast, writeFileToDisk, _isUserMode, _executeHotkey, HELP_VERSION_STR
(function () {
  'use strict';

  const STORE_URL = () => 'o.json?t=' + Date.now();

  // ── State ────────────────────────────────────────────────────────────────────
  let rows = [];            // the live o.json array (mutated in place by inline edits)
  let table = null;         // the Tabulator instance
  let query = '';           // free-text search (already lowercased)
  let searchText = false;   // include the full pasted body in the search (checkbox)
  let tagFilter = 'all';    // org-tag facet (all / <tag> / __none__)
  let kwFilter = 'all';     // keyword facet (all / TODO / NEXT / DONE / none)
  let nbFilter = 'all';     // notebook facet (all / <notebook>) — the source .org file
  let focusId = null;       // id of the single focused row (drives the reading pane + arrows)
  let dirty = false;        // unsaved inline edits
  let saveTimer = null;     // debounce for autosave
  let filterTimer = null;   // debounce for the search box
  let bodyTimer = null;     // debounce for live text-edit commits (table cell + save)
  let oDeleted = null;      // lazy odeleted.json archive buffer (loaded on first delete)

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[<>&"]/g,
    c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  let _idSeq = 0;
  const mkId = () => 'o' + Date.now().toString(36) + (_idSeq++).toString(36);
  // Notebook name = the source .org file (minus extension), with the user's rename of
  // the working notebook AqNew → "main". Mirrors the mapping in orgToO.js.
  const notebookName = src => {
    const b = String(src || '').replace(/\.org$/i, '').trim();
    return /^aqnew$/i.test(b) ? 'main' : (b || 'main');
  };
  const stampModified = row => {
    row.dateModified = (typeof isoNow === 'function')
      ? isoNow() : new Date().toISOString().slice(0, 19).replace('T', ' ');
  };
  function oToast(msg, ms) {
    if (typeof toast === 'function') { try { toast(msg, ms); return; } catch (_) {} }
    console.log('[O] ' + msg);
  }
  // Escape, then turn bare URLs into links. Run on the ALREADY-escaped string so the
  // surrounding text stays safe; the URL char-class tolerates the &amp; that escaping
  // produces (browser decodes the href back to &).
  function linkify(t) {
    return esc(t).replace(/https?:\/\/[^\s)>\]"'`]+/g,
      u => '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>');
  }

  // ── Lazy Tabulator load (mirrors s.js) ───────────────────────────────────────
  function loadTabulator() {
    if (window.Tabulator) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const v = (window.HELP_VERSION_STR || '').replace(/^(dev|user)/, '');
      if (!document.getElementById('tabulator-css')) {
        const l = document.createElement('link');
        l.id = 'tabulator-css'; l.rel = 'stylesheet';
        l.href = 'tabulator_midnight.min.css?v=' + v;
        document.head.appendChild(l);
      }
      const sc = document.createElement('script');
      sc.src = 'tabulator.min.js?v=' + v;
      sc.onload = () => resolve();
      sc.onerror = () => reject(new Error('tabulator.min.js failed to load'));
      document.head.appendChild(sc);
    });
  }

  // ── CSS (scoped under #oOverlay, injected once) ──────────────────────────────
  function injectCss() {
    if ($('o-css')) return;
    const s = document.createElement('style');
    s.id = 'o-css';
    s.textContent = `
#oOverlay{position:fixed;inset:0;z-index:29400;display:none;flex-direction:column;
  background:#11151c;color:#dfe6ee;font:13px/1.4 system-ui,Segoe UI,sans-serif}
#oOverlay.open{display:flex}
#oBar{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#0c0f14;
  border-bottom:1px solid #232b36;flex:0 0 auto;flex-wrap:wrap}
#oBar h2{margin:0;font-size:15px;font-weight:700;color:#9ad}
#oBar .ct{color:#fff;font-size:16px;font-weight:700;min-width:78px}
#oBar input[type=text]{background:#1a212b;border:1px solid #2c3645;color:#dfe6ee;
  border-radius:6px;padding:5px 8px;width:240px;font:14px system-ui}
#oBar select{background:#1a212b;border:1px solid #2c3645;color:#dfe6ee;border-radius:6px;padding:5px 7px;font:14px system-ui}
#oBar label.ck{display:flex;align-items:center;gap:5px;font-size:12px;color:#9fb0c2}
#oBar label.ck input{margin:0}
#oBar button{background:#1f2733;border:1px solid #34404f;color:#cfe;border-radius:6px;
  padding:5px 10px;cursor:pointer;font:600 12px system-ui}
#oBar button:hover{background:#27313f}
#oBar button.primary{background:#0a84ff;border-color:#0a84ff;color:#fff}
#oBar .spacer{flex:1}
#oBar #oClose{font-size:18px;padding:2px 10px;line-height:1}
#oWrap{flex:1;display:flex;overflow:hidden;position:relative}
#oTableWrap{flex:1 1 auto;min-width:0;position:relative}
#oTable{height:100%}
#oWrap.noread #oRead{display:none}
/* (dev0468) empty-state: when filters hide every row, name WHAT is filtering + offer a
   one-click clear. pointer-events:none lets the user still click the header boxes through it. */
#oEmpty{position:absolute;inset:0;display:none;align-items:center;justify-content:center;
  text-align:center;color:#9fb0c2;padding:30px;background:rgba(17,21,28,.55);pointer-events:none}
#oEmpty.show{display:flex}
#oEmpty .box{pointer-events:auto;background:#141a23;border:1px solid #34404f;border-radius:12px;
  padding:18px 24px;max-width:560px;font:13.5px/1.6 system-ui}
#oEmpty .box b{color:#fff;font-size:15px}
#oEmpty .box .fl{display:inline-block;background:#22303f;color:#cfe;border-radius:4px;padding:1px 8px;margin:4px 4px 0 0;font-size:12px}
#oEmpty .box button{margin-top:15px;background:#0a84ff;border:1px solid #0a84ff;color:#fff;border-radius:6px;
  padding:7px 16px;cursor:pointer;font:600 13px system-ui}
#oEmpty .box button:hover{filter:brightness(1.1)}
#oBar .ct .hf{color:#ffd479;font-weight:700;font-size:12px;margin-left:6px;cursor:help}
#oBar button#oClear{background:#3a2230;border-color:#7a3a4a;color:#ffd0d8}
#oRead{flex:0 0 46%;max-width:760px;display:flex;flex-direction:column;
  background:#0e131a;border-left:1px solid #232b36}
#oReadHead{flex:0 0 auto;padding:9px 13px;background:#0a1426;border-bottom:1px solid #1a2a4a;
  font:14px/1.45 system-ui;color:#eaf1f8;max-height:30vh;overflow:auto}
#oReadHead .o-kw{margin-right:6px}
#oReadTools{display:flex;align-items:center;gap:7px;margin-top:7px;flex-wrap:wrap}
#oReadTools button{background:#1f2733;border:1px solid #34404f;color:#cfe;border-radius:6px;
  padding:3px 9px;cursor:pointer;font:600 11.5px system-ui}
#oReadTools button:hover{background:#27313f}
#oReadTools #oDelRow{background:#3a2230;border-color:#7a3a4a;color:#ffd0d8}
#oReadMeta{color:#7f8ea2;font-size:11px;margin-left:auto}
#oReadMeta b{color:#9fc6ff;font-weight:600}
/* editable body (plain-text textarea) + rendered view share the pane; class toggles which shows */
#oEditBody{flex:1 1 auto;min-height:0;width:100%;box-sizing:border-box;resize:none;border:0;outline:0;
  background:#0e131a;color:#dbe3ee;padding:13px 16px;
  font:13.5px/1.62 ui-monospace,'Cascadia Code',Consolas,monospace;white-space:pre-wrap;word-break:break-word}
#oEditBody:focus{box-shadow:inset 3px 0 0 #2b6cff}
#oReadBody{flex:1 1 auto;overflow:auto;padding:13px 16px;white-space:pre-wrap;
  word-break:break-word;font:13.5px/1.62 Georgia,'Times New Roman',serif;color:#cdd6e0}
#oReadBody a{color:#7fb8ff}
#oReadBody .o-empty{color:#5b6b86;font-style:italic;font-family:system-ui}
#oRead.viewmode #oEditBody{display:none}
#oRead:not(.viewmode) #oReadBody{display:none}
.o-nb{display:inline-block;background:#13202c;color:#86c7ff;border:1px solid #244056;
  border-radius:4px;padding:0 6px;font-size:11px;font-weight:600}
#oTable .tabulator-cell .o-date{color:#9aa7b8;font-size:11.5px}
#oTable .tabulator-cell .o-date.none{color:#566377}
/* badges + chips */
.o-badge{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:700}
.o-kw-TODO{background:#4a3a14;color:#ffcf7a}.o-kw-NEXT{background:#14324a;color:#7fd0ee}
.o-kw-DONE{background:#1e3a24;color:#86e0a0}
.o-tagchip{display:inline-block;background:#222c3a;color:#9fc6ff;border-radius:4px;
  padding:0 6px;margin:0 2px 0 0;font-size:11px}
#oTable .tabulator-cell a{color:#7fb8ff;text-decoration:none}
#oTable .tabulator-cell a:hover{text-decoration:underline}
#oTable .tabulator-cell .o-snip{color:#8c98a8}
/* focused row — the one the arrows move and the reading pane shows */
#oTable .tabulator-row.o-focus{background:#16324e !important;box-shadow:inset 4px 0 0 #4df}
#oTable .tabulator-row.o-focus .tabulator-cell{background:transparent !important}
#oTable .tabulator-row.tabulator-selectable:hover{background-color:#1a222e;cursor:pointer}
`;
    document.head.appendChild(s);
  }

  // ── DOM scaffold ─────────────────────────────────────────────────────────────
  function build() {
    injectCss();
    if ($('oOverlay')) return;
    const o = document.createElement('div');
    o.id = 'oOverlay';
    o.innerHTML = `
      <div id="oBar">
        <h2>O · org review</h2>
        <span class="ct" id="oCount"></span>
        <input type="text" id="oSearch" placeholder="search title / tags / link…  (press f)">
        <label class="ck"><input type="checkbox" id="oSearchText"> + text</label>
        <select id="oNotebook"><option value="all">all notebooks</option></select>
        <select id="oTag"><option value="all">all tags</option></select>
        <select id="oKw">
          <option value="all">all keywords</option>
          <option value="TODO">TODO</option>
          <option value="NEXT">NEXT</option>
          <option value="DONE">DONE</option>
          <option value="none">— no keyword —</option>
        </select>
        <button id="oClear" title="clear ALL filters, including the per-column header boxes (Shift+F)">✕ Clear filters</button>
        <button id="oReadToggle">📖 pane (r)</button>
        <span class="spacer"></span>
        <button id="oReload">↻ Reload</button>
        <button id="oSave" class="primary">💾 Save</button>
        <button id="oClose" title="close → T (Esc)">✕</button>
      </div>
      <div id="oWrap">
        <div id="oTableWrap"><div id="oTable"></div><div id="oEmpty"></div></div>
        <div id="oRead">
          <div id="oReadHead">
            <span id="oReadTitle"></span>
            <div id="oReadTools">
              <button id="oEditToggle" title="toggle plain-text edit ⇄ rendered view (links clickable)">👁 view</button>
              <button id="oDelRow" title="delete this record (archived to odeleted.json) — Delete key">🗑 delete</button>
              <span id="oReadMeta"></span>
            </div>
          </div>
          <textarea id="oEditBody" spellcheck="false" placeholder="— select a row —"></textarea>
          <div id="oReadBody"><div class="o-empty">— select a row —</div></div>
        </div>
      </div>`;
    document.body.appendChild(o);

    $('oSearch').addEventListener('input', e => {
      query = e.target.value.trim().toLowerCase();
      clearTimeout(filterTimer);
      filterTimer = setTimeout(applyFilters, 220);
    });
    $('oSearchText').addEventListener('change', e => { searchText = e.target.checked; applyFilters(); });
    $('oNotebook').addEventListener('change', e => { nbFilter = e.target.value; applyFilters(); });
    $('oTag').addEventListener('change', e => { tagFilter = e.target.value; applyFilters(); });
    $('oKw').addEventListener('change', e => { kwFilter = e.target.value; applyFilters(); });
    $('oClear').addEventListener('click', clearAllFilters);
    $('oReadToggle').addEventListener('click', toggleRead);
    $('oReload').addEventListener('click', () => loadData());
    $('oSave').addEventListener('click', () => persist(true));
    $('oClose').addEventListener('click', () => closeOScreen());
    // Reading-pane: plain-text edit, view/edit toggle, per-row delete.
    $('oEditBody').addEventListener('input', onBodyInput);
    $('oEditToggle').addEventListener('click', () => setViewMode(!$('oRead').classList.contains('viewmode')));
    $('oDelRow').addEventListener('click', () => deleteFocused());
  }

  // Plain-text body edits ⇄ rendered (linkified) view. Default = edit (textarea).
  function setViewMode(on) {
    const rd = $('oRead'); if (!rd) return;
    if (on && focusId != null) commitBody(focusId);   // flush pending edit before rendering
    rd.classList.toggle('viewmode', !!on);
    const b = $('oEditToggle'); if (b) b.textContent = on ? '✎ edit' : '👁 view';
    if (on) renderRead();                              // refresh rendered HTML
    else { const ta = $('oEditBody'); if (ta) ta.focus(); }
  }

  function toggleRead() {
    const w = $('oWrap'); if (!w) return;
    w.classList.toggle('noread');
    if (table) setTimeout(() => { try { table.redraw(true); } catch (_) {} }, 30);
  }

  // ── Tabulator columns ────────────────────────────────────────────────────────
  function columns() {
    const kwBadge = c => { const k = c.getValue(); return k ? `<span class="o-badge o-kw-${esc(k)}">${esc(k)}</span>` : ''; };
    const tagsCell = c => (Array.isArray(c.getValue()) ? c.getValue() : []).map(t => `<span class="o-tagchip">${esc(t)}</span>`).join('');
    const linkCell = c => {
      const u = c.getValue() || ''; if (!u) return '';
      let host = u; try { host = new URL(u).hostname.replace(/^www\./, ''); } catch (_) {}
      return `<a href="${esc(u)}" target="_blank" rel="noopener" title="${esc(u)}">${esc(host)}</a>`;
    };
    const snip = c => {
      const t = (c.getValue() || '').replace(/\s+/g, ' ').trim();
      return `<span class="o-snip">${esc(t.slice(0, 200))}</span>`;
    };
    const nbCell = c => { const v = c.getValue() || ''; return v ? `<span class="o-nb">${esc(v)}</span>` : ''; };
    const dateCell = c => {
      const v = c.getValue() || '';
      return v ? `<span class="o-date" title="${esc(v)}">${esc(v.slice(0, 16))}</span>`
               : '<span class="o-date none">—</span>';
    };
    return [
      { title: 'Kw', field: 'keyword', width: 60, formatter: kwBadge, editor: 'input', headerFilter: false,
        headerTooltip: 'org TODO state (TODO / NEXT / DONE) — edit free-text' },
      { title: 'Notebook', field: 'notebook', width: 96, formatter: nbCell,
        headerTooltip: 'Source .org notebook (AqNew → main). Filter with the “all notebooks” dropdown.' },
      { title: 'Title', field: 'title', widthGrow: 3, minWidth: 200, editor: 'input', headerFilter: 'input' },
      { title: 'Tags', field: 'tags', width: 150, formatter: tagsCell, editor: 'input',
        mutatorEdit: v => String(v || '').split(',').map(s => s.trim()).filter(Boolean),
        headerTooltip: 'org :tags: (comma-separated when editing). Independent of the T dictionary.' },
      { title: 'Link', field: 'link', width: 130, formatter: linkCell, headerFilter: 'input' },
      { title: 'Added', field: 'dateAdded', width: 118, formatter: dateCell, sorter: 'string',
        headerTooltip: 'Date added — from the org :CREATED: drawer when present (AqNew/main has none)' },
      { title: 'Modified', field: 'dateModified', width: 118, formatter: dateCell, sorter: 'string',
        headerTooltip: 'Date last edited in this O screen (auto-stamped on any change)' },
      { title: 'Chars', field: 'chars', width: 70, hozAlign: 'right', sorter: 'number',
        headerTooltip: 'Length of the pasted text — sort ↓ to find the meaty entries' },
      { title: 'Text', field: 'text', widthGrow: 2, minWidth: 160, formatter: snip, headerSort: false,
        headerTooltip: 'First 200 chars of the pasted body — full text shows in the reading pane' }
    ];
  }

  function buildTable() {
    table = new window.Tabulator('#oTable', {
      data: rows,
      index: 'id',
      columns: columns(),
      layout: 'fitColumns',
      height: '100%',
      placeholder: '(no rows — run  node orgToO.js  to generate o.json)',
      reactiveData: false,
      movableColumns: true,
      rowFormatter: row => { row.getElement().classList.toggle('o-focus', row.getData().id === focusId); }
    });
    table.on('cellEdited', cell => {
      const data = cell.getRow().getData();
      stampModified(data);
      try { cell.getRow().update({ dateModified: data.dateModified }); } catch (_) {}
      markDirty(); scheduleSave();
      const f = cell.getField && cell.getField();
      if (f === 'tags') buildTagFacet();
      if (data.id === focusId) renderRead();
    });
    // Clicking a row focuses it (drives the reading pane). Link cells still open.
    table.on('rowClick', (e, row) => setFocus(row.getData().id, { scroll: false }));
    table.on('tableBuilt', () => { applyFilters(); updateCount(); reconcileFocus(); });
    // (dev0468) Keep the count + empty-state in sync when a per-column HEADER filter
    // changes too (those bypass applyFilters). This is what surfaces a stale column
    // filter that was silently ANDing rows away (e.g. Link="nytimes" → 0 NEXT rows).
    table.on('dataFiltered', () => { updateCount(); reconcileFocus(); });
  }

  // ── Org-tag facet (built from the data; independent of tags.json) ────────────
  function buildTagFacet() {
    const sel = $('oTag'); if (!sel) return;
    const counts = {};
    rows.forEach(r => (r.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
    const sorted = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
    const cur = tagFilter;
    sel.innerHTML = '<option value="all">all tags</option>'
      + '<option value="__none__">— untagged —</option>'
      + sorted.map(t => `<option value="${esc(t)}">${esc(t)} (${counts[t]})</option>`).join('');
    sel.value = cur;                      // restore selection if it still exists
    if (sel.value !== cur) { tagFilter = 'all'; sel.value = 'all'; }
  }

  // ── Notebook facet (the source .org file each row came from) ─────────────────
  function buildNotebookFacet() {
    const sel = $('oNotebook'); if (!sel) return;
    const counts = {};
    rows.forEach(r => { const n = r.notebook || notebookName(r.src); counts[n] = (counts[n] || 0) + 1; });
    const sorted = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
    const cur = nbFilter;
    sel.innerHTML = '<option value="all">all notebooks</option>'
      + sorted.map(n => `<option value="${esc(n)}">${esc(n)} (${counts[n]})</option>`).join('');
    sel.value = cur;
    if (sel.value !== cur) { nbFilter = 'all'; sel.value = 'all'; }
  }

  // ── Filtering ────────────────────────────────────────────────────────────────
  function rowMatch(data) {
    if (nbFilter !== 'all') {
      if ((data.notebook || notebookName(data.src)) !== nbFilter) return false;
    }
    if (kwFilter !== 'all') {
      if (kwFilter === 'none') { if (data.keyword) return false; }
      else if (data.keyword !== kwFilter) return false;
    }
    if (tagFilter !== 'all') {
      if (tagFilter === '__none__') { if ((data.tags || []).length) return false; }
      else if (!(data.tags || []).includes(tagFilter)) return false;
    }
    if (query) {
      const meta = (data.title + ' ' + (data.tags || []).join(' ') + ' ' + data.link
        + ' ' + (data.notebook || '')).toLowerCase();
      if (meta.indexOf(query) === -1) {
        if (!searchText) return false;
        if ((data.text || '').toLowerCase().indexOf(query) === -1) return false;
      }
    }
    return true;
  }
  function applyFilters() {
    if (!table) return;
    table.setFilter(rowMatch);
    updateCount();
    reconcileFocus();
  }

  // ── Focus model (single focused row → reading pane + arrow nav) ──────────────
  function paintFocus(prevId) {
    if (!table) return;
    [prevId, focusId].forEach(id => {
      if (!id) return;
      const row = table.getRow(id);
      if (row && row.getElement) row.getElement().classList.toggle('o-focus', id === focusId);
    });
  }
  function setFocus(id, opts) {
    if (focusId != null && focusId !== id) commitBody(focusId);   // flush prev row's edits
    const prev = focusId; focusId = id;
    paintFocus(prev); renderRead();
    if (opts && opts.scroll) { const row = table && table.getRow(id); if (row) row.scrollTo().catch(() => {}); }
  }
  function moveFocus(dir) {
    if (!table) return;
    const vis = table.getRows('active');      // current filtered + sorted order
    if (!vis.length) return;
    let idx = vis.findIndex(r => r.getData().id === focusId);
    idx = idx === -1 ? (dir > 0 ? 0 : vis.length - 1)
                     : Math.max(0, Math.min(vis.length - 1, idx + dir));
    if (focusId != null) commitBody(focusId);                     // flush prev row's edits
    const prev = focusId; focusId = vis[idx].getData().id;
    paintFocus(prev); renderRead();
    vis[idx].scrollTo().catch(() => {});
  }
  function reconcileFocus() {
    const vis = table ? table.getRows('active') : [];
    if (!vis.length) { focusId = null; renderRead(); return; }
    if (!focusId || !vis.some(r => r.getData().id === focusId)) {
      const prev = focusId; focusId = vis[0].getData().id; paintFocus(prev); renderRead();
    }
  }

  // ── Reading pane ─────────────────────────────────────────────────────────────
  function updateReadMeta(row) {
    const m = $('oReadMeta'); if (!m) return;
    if (!row) { m.innerHTML = ''; return; }
    const nb = row.notebook || notebookName(row.src);
    const parts = ['<b>' + esc(nb) + '</b>'];
    if (row.dateAdded) parts.push('added ' + esc(row.dateAdded.slice(0, 16)));
    if (row.dateModified) parts.push('mod ' + esc(row.dateModified.slice(0, 16)));
    parts.push((row.chars || 0).toLocaleString() + ' ch');
    m.innerHTML = parts.join(' · ');
  }
  function renderRead() {
    const head = $('oReadTitle'), bodyEl = $('oReadBody'), ta = $('oEditBody');
    if (!head || !bodyEl) return;
    const row = rows.find(r => r.id === focusId);
    if (!row) {
      head.textContent = '';
      if (ta) ta.value = '';
      bodyEl.innerHTML = '<div class="o-empty">— select a row —</div>';
      updateReadMeta(null);
      return;
    }
    const kw = row.keyword ? `<span class="o-badge o-kw-${esc(row.keyword)} o-kw">${esc(row.keyword)}</span>` : '';
    const tags = (row.tags || []).map(t => `<span class="o-tagchip">${esc(t)}</span>`).join(' ');
    const link = row.link ? `<div style="margin-top:6px;font:11px system-ui"><a href="${esc(row.link)}" target="_blank" rel="noopener">${esc(row.link)}</a></div>` : '';
    head.innerHTML = kw + '<b>' + esc(row.title) + '</b> ' + tags + link;
    if (ta) ta.value = row.text || '';
    // rendered view is only built when it's actually showing (view mode)
    if ($('oRead') && $('oRead').classList.contains('viewmode'))
      bodyEl.innerHTML = row.text ? linkify(row.text) : '<div class="o-empty">— no pasted text —</div>';
    bodyEl.scrollTop = 0;
    updateReadMeta(row);
  }

  // Plain-text editing: keep row.text live on every keystroke, stamp Modified, then
  // debounce the heavier table-cell update + autosave.
  function onBodyInput() {
    const ta = $('oEditBody'); if (!ta) return;
    const row = rows.find(r => r.id === focusId); if (!row) return;
    row.text = ta.value;
    row.chars = row.text.length;
    stampModified(row);
    updateReadMeta(row);
    markDirty();
    clearTimeout(bodyTimer);
    bodyTimer = setTimeout(() => commitBody(row.id), 600);
  }
  function commitBody(id) {
    clearTimeout(bodyTimer);
    const row = rows.find(r => r.id === id); if (!row || !table) return;
    try { const tr = table.getRow(id); if (tr) tr.update({ text: row.text, chars: row.chars, dateModified: row.dateModified }); } catch (_) {}
    scheduleSave();
  }

  // ── Delete a single record (archived to odeleted.json — like deleted.json) ────
  async function archiveDeleted(row) {
    try {
      if (oDeleted === null) {
        try { const r = await fetch('odeleted.json?t=' + Date.now()); oDeleted = r.ok ? await r.json() : []; }
        catch (_) { oDeleted = []; }
        if (!Array.isArray(oDeleted)) oDeleted = [];
      }
      oDeleted.push(Object.assign({}, row, { deletedAt: (typeof isoNow === 'function') ? isoNow() : '' }));
      if (typeof writeFileToDisk === 'function') await writeFileToDisk('odeleted.json', oDeleted);
    } catch (_) { /* archive is best-effort; deletion still proceeds */ }
  }
  async function deleteFocused() {
    const row = rows.find(r => r.id === focusId); if (!row) return;
    // choose the next row to focus BEFORE removing this one
    let nextId = null;
    if (table) {
      const vis = table.getRows('active');
      const idx = vis.findIndex(r => r.getData().id === focusId);
      const nxt = vis[idx + 1] || vis[idx - 1];
      if (nxt) nextId = nxt.getData().id;
    }
    await archiveDeleted(row);
    rows = rows.filter(r => r.id !== row.id);
    try { if (table) table.deleteRow(row.id); } catch (_) {}
    focusId = nextId;
    paintFocus(null); renderRead();
    buildTagFacet(); buildNotebookFacet();
    updateCount();
    markDirty(); scheduleSave();
    oToast('🗑 deleted “' + String(row.title || '').slice(0, 44) + '” (archived)', 1800);
  }

  function updateCount() {
    const el = $('oCount'); if (!el || !table) return;
    const shown = table.getRows('active').length;
    const hf = (table.getHeaderFilters && table.getHeaderFilters()) || [];
    const txt = shown === rows.length ? rows.length + ' rows' : shown + ' / ' + rows.length;
    // (dev0468) Flag active per-column header filters right in the count, so a stale
    // column box can never silently swallow rows again without the user seeing why.
    el.innerHTML = esc(txt) + (hf.length
      ? ' <span class="hf" title="' + esc(hf.map(h => h.field + ': &quot;' + h.value + '&quot;').join(', '))
        + ' — Shift+F or ✕ Clear filters to reset">⚠ ' + hf.length + ' column filter' + (hf.length > 1 ? 's' : '') + '</span>'
      : '');
    updateEmpty(hf, shown);
  }

  // (dev0468) When filters hide EVERY row, spell out exactly what is filtering (incl.
  // the per-column header boxes) and give a one-click reset — the fix for "I selected
  // NEXT and saw nothing" being an invisible leftover Link="nytimes" filter.
  function updateEmpty(hf, shown) {
    const box = $('oEmpty'); if (!box) return;
    if (shown > 0 || !rows.length) { box.classList.remove('show'); box.innerHTML = ''; return; }
    const parts = [];
    if (nbFilter !== 'all') parts.push('notebook = ' + nbFilter);
    if (kwFilter !== 'all') parts.push('keyword = ' + (kwFilter === 'none' ? '(no keyword)' : kwFilter));
    if (tagFilter !== 'all') parts.push('tag = ' + (tagFilter === '__none__' ? '(untagged)' : tagFilter));
    if (query) parts.push('search = "' + query + '"' + (searchText ? ' (incl. text)' : ''));
    (hf || []).forEach(h => parts.push('column “' + h.field + '” contains "' + h.value + '"'));
    box.innerHTML = '<div class="box"><b>0 of ' + rows.length + ' rows</b> match the active filters:<br>'
      + (parts.length ? parts.map(p => '<span class="fl">' + esc(p) + '</span>').join('') : '<i>(no filters — empty data?)</i>')
      + '<br><button id="oEmptyClear">✕ Clear all filters</button></div>';
    box.classList.add('show');
    const b = $('oEmptyClear'); if (b) b.onclick = clearAllFilters;
  }

  // Reset EVERY filter: search box, both dropdowns, AND the per-column header boxes.
  function clearAllFilters() {
    query = ''; const s = $('oSearch'); if (s) s.value = '';
    searchText = false; const st = $('oSearchText'); if (st) st.checked = false;
    nbFilter = 'all'; const nb = $('oNotebook'); if (nb) nb.value = 'all';
    tagFilter = 'all'; const tg = $('oTag'); if (tg) tg.value = 'all';
    kwFilter = 'all'; const kw = $('oKw'); if (kw) kw.value = 'all';
    if (table && table.clearHeaderFilter) table.clearHeaderFilter();   // the column boxes (the silent trap)
    applyFilters();
    oToast('🔎 all filters cleared', 1200);
  }

  // ── Save (generic FSA writer — no proxy endpoint, no restart) ────────────────
  function markDirty() { dirty = true; }
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => persist(false), 1500); }
  async function persist(announce) {
    // keep chars in sync if text was ever edited (it isn't, yet, but be safe)
    rows.forEach(r => { if (typeof r.chars !== 'number') r.chars = (r.text || '').length; });
    try {
      if (typeof writeFileToDisk !== 'function') { if (announce) oToast('✗ writeFileToDisk unavailable'); return false; }
      const ok = await writeFileToDisk('o.json', rows);
      if (ok) { dirty = false; if (announce) oToast('💾 saved o.json (' + rows.length + ' rows)', 1600); }
      else if (announce) oToast('⚠ o.json not saved — re-pick the project folder (📂)', 4000);
      return ok;
    } catch (e) { if (announce) oToast('✗ save failed: ' + (e && e.message), 4000); return false; }
  }

  // ── Load ─────────────────────────────────────────────────────────────────────
  async function loadData() {
    try {
      const r = await fetch(STORE_URL());
      rows = r.ok ? await r.json() : [];
      if (!Array.isArray(rows)) rows = [];
    } catch (e) { rows = []; oToast('✗ could not load o.json — run  node orgToO.js', 4000); }
    rows.forEach(r => {
      if (!r.id) r.id = mkId();
      if (!Array.isArray(r.tags)) r.tags = r.tags ? [String(r.tags)] : [];
      if (typeof r.chars !== 'number') r.chars = (r.text || '').length;
      // (dev0469) backfill the new structural fields on legacy rows, in memory. The
      // notebook derives deterministically from src (AqNew → main); dates default blank
      // (AqNew carries no org :CREATED:). These persist on the next save — no reparse,
      // so the cleanO.js cleanup of o.json is never clobbered.
      if (!r.notebook) r.notebook = notebookName(r.src);
      if (typeof r.dateAdded !== 'string') r.dateAdded = '';
      if (typeof r.dateModified !== 'string') r.dateModified = '';
    });
    dirty = false; focusId = null;
    if (table) { try { await table.setData(rows); } catch (_) {} }
    buildNotebookFacet();
    buildTagFacet();
    applyFilters();
    updateCount();
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  async function openOScreen() {
    if (typeof _isUserMode === 'function' && _isUserMode()) return;   // dev-only
    build();
    $('oOverlay').classList.add('open');
    try { await loadTabulator(); }
    catch (e) { oToast('✗ ' + e.message, 5000); return; }
    await loadData();            // fetch o.json into `rows` first (table still null)
    if (!table) buildTable();    // build with loaded data (no setData race)
  }
  function closeOScreen() {
    if (dirty) persist(false);   // best-effort flush on close
    $('oOverlay')?.classList.remove('open');
  }
  function isOScreenOpen() {
    return $('oOverlay')?.classList.contains('open') || false;
  }

  // ── In-window key handling (capture-phase; core.js bails on the keys O owns) ──
  window.addEventListener('keydown', e => {
    if (!isOScreenOpen()) return;
    const ae = document.activeElement;
    const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);

    if (e.key === 'Escape') {
      if (typing) { ae.blur(); e.stopPropagation(); e.preventDefault(); return; }
      e.stopPropagation(); e.preventDefault();
      closeOScreen();
      if (typeof window._executeHotkey === 'function') window._executeHotkey('t');   // leave → T
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.stopPropagation(); e.preventDefault();
      moveFocus(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Delete') {                 // delete the focused record (archived)
      e.stopPropagation(); e.preventDefault();
      deleteFocused();
      return;
    }
    if (e.key === 'f') { e.stopPropagation(); e.preventDefault(); $('oSearch')?.focus(); return; }
    if (e.key === 'F') {                 // Shift+F — clear ALL filters (incl. column boxes)
      e.stopPropagation(); e.preventDefault();
      clearAllFilters();
      return;
    }
    if (e.key === 'r') { e.stopPropagation(); e.preventDefault(); toggleRead(); return; }
  }, true);

  window.openOScreen = openOScreen;
  window.closeOScreen = closeOScreen;
  window.isOScreenOpen = isOScreenOpen;
})();
