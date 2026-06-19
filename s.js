// ══════════════════════════════════════════════════════════════════════════════
// S / St SCREEN — bulk staging table for s.json (dev0447)
// ══════════════════════════════════════════════════════════════════════════════
// A standalone, dev-only screen that holds BULK-harvested links (Flickr jpgs, YT
// videos/shorts, Vimeo, and the link-downloader's output) in s.json — a store
// PARALLEL to ml.json, deliberately separate so tens of thousands of bulk rows
// never bloat / slow the curated working table (T). It mirrors T's field names so
// "Promote" is a near-identity copy into ml.json (stamped BA="1" = bulk-added, the
// existing marker the user filters on).
//
// Unlike the IG store (ig.json / ig.js), these media types (jpg/png, YouTube,
// Vimeo, direct video) DO render in the grid and play in V, so they legitimately
// co-live in ONE store with a `type` marker; IG stays in its own store because it
// neither grids nor plays in V.
//
// The table BODY is Tabulator (lazy-loaded on first open — it's 442 KB and dev-only,
// no reason to ship it to the public site on every page load). Tabulator gives
// virtual-DOM rows (the real fix for "tens of thousands"), sort, header-filters and
// inline editing for free.
//
// Hotkey: S (dev-only, blocked in user mode like T/I). While St is on top:
//   w → import links from the clipboard   ·   f → focus the search box
//   Esc → close the detail drawer, else leave (handled like Ig: T also leaves)
//
// Globals borrowed from core.js (same realm — classic <script> tags share scope):
//   toast, isoNow, nextUID, data, save, _isUserMode, HELP_VERSION_STR
(function () {
  'use strict';

  const PROXY = 'http://127.0.0.1:8081';
  const STORE_URL = () => 's.json?t=' + Date.now();

  // ── State ────────────────────────────────────────────────────────────────
  let rows = [];                 // the live s.json array (mutated in place)
  let table = null;              // the Tabulator instance
  let query = '';                // free-text search
  let typeFilter = 'all';        // type dropdown (all/jpg/yt/vimeo/video/other)
  let statusFilter = 'all';      // status dropdown (all/new/promoted)
  let dirty = false;             // unsaved edits (edit/import/promote/delete)
  let saveTimer = null;          // debounce for autosave after inline edits

  // ── Helpers ────────────────────────────────────────────────────────────────
  const esc = s => String(s == null ? '' : s).replace(/[<>&"]/g,
    c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const now = () => (typeof isoNow === 'function') ? isoNow()
    : new Date().toISOString().slice(0, 19).replace('T', ' ');

  // Stable unique id for the Tabulator index + dedup. Bulk links have no natural
  // key (a Flickr CDN url isn't one), so we mint one per row.
  let _idSeq = 0;
  const mkId = () => 's' + Date.now().toString(36) + (_idSeq++).toString(36);

  // Media type from the URL — same buckets the grid/V dispatcher understands.
  function urlType(u) {
    u = String(u || '');
    if (/youtube\.com|youtu\.be/i.test(u)) return 'yt';
    if (/vimeo\.com/i.test(u)) return 'vimeo';
    if (/\.(jpe?g|png|gif|webp|avif|bmp|svg)(\?|#|$)/i.test(u)) return 'jpg';
    if (/\.(mp4|webm|mov|m4v|mkv)(\?|#|$)/i.test(u)) return 'video';
    return 'other';
  }
  // Bare seconds ("53") → "0:53"; "1:43" passes through; junk → ''.
  function normDur(d) {
    d = String(d || '').trim();
    if (!d) return '';
    if (d.includes(':')) return d;
    const n = parseInt(d, 10);
    if (!Number.isFinite(n) || n <= 0) return '';
    const m = Math.floor(n / 60), s = n % 60;
    return m + ':' + String(s).padStart(2, '0');
  }
  // Normalize a link for dedup (trim, drop trailing slash). Kept conservative so
  // we never merge genuinely different urls.
  const normLink = u => String(u || '').trim().replace(/\/+$/, '');

  // ── Centered toast ABOVE the overlay (global toast z9999 hides behind us) ────
  function stToast(msg, ms) {
    let t = document.getElementById('stToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'stToast';
      (document.getElementById('stOverlay') || document.body).appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._tid);
    t._tid = setTimeout(() => t.classList.remove('show'), ms || 2400);
    if (typeof console !== 'undefined') console.log('[st]', msg);
  }

  // ── Clipboard parser ────────────────────────────────────────────────────────
  // Handles the four sample formats found in /ahk, plus plain bare-URL lists:
  //   1. YT tilde:   https://youtu.be/ID~Title~1:43~0        (one line)
  //   2. TSV log:    ts \t "bare-links paste" \t id \t url \t title   (duplicateTries)
  //   3. URL + meta: url line, then a non-url meta line
  //        · Flickr:  "aa 2012-03-31_145840"  → date → comment
  //        · jpglinks: "australian.museum"     → source → attribution
  //   4. Bare url alone.
  // Returns an array of partial rows {type,link,VidTitle,VidAuthor,attribution,
  // vidLength,comment} — id/status/dates are stamped by importRows().
  const isUrl = s => /^https?:\/\/\S+$/i.test(String(s || '').trim());

  function parseClipboard(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // 2. TSV log line (tab-separated, a url somewhere in the fields).
      if (line.includes('\t')) {
        const f = line.split('\t');
        const url = f.find(isUrl);
        if (url) {
          const title = f[f.length - 1] !== url ? f[f.length - 1].trim() : '';
          out.push({ type: urlType(url), link: url, VidTitle: title });
          continue;
        }
      }

      // 1. YT tilde line: url~title~dur~flag
      if (line.includes('~') && isUrl(line.split('~')[0].trim())) {
        const p = line.split('~');
        const url = p[0].trim();
        out.push({
          type: urlType(url), link: url,
          VidTitle: (p[1] || '').trim(),
          vidLength: normDur(p[2] || '')
        });
        continue;
      }

      // 3 / 4. A bare URL — peek at the next line for paired metadata.
      if (isUrl(line)) {
        const url = line;
        const r = { type: urlType(url), link: url };
        const next = (lines[i + 1] || '').trim();
        if (next && !isUrl(next) && !next.includes('\t')) {
          // Flickr "aa YYYY-MM-DD_hhmmss" → comment(date); else → attribution(source)
          const fm = next.match(/(\d{4}-\d{2}-\d{2})/);
          if (/^aa\s+\d{4}-\d{2}-\d{2}/.test(next) && fm) r.comment = fm[1];
          else r.attribution = next;
          i++;                       // consume the meta line
        }
        out.push(r);
        continue;
      }
      // Anything else (stray non-url, non-meta line) is ignored.
    }
    return out;
  }

  // Add parsed rows to the store, deduped by normalized link against BOTH s.json
  // and ml.json (so already-curated links aren't re-staged).
  function importRows(parsed) {
    const haveS = new Set(rows.map(r => normLink(r.link)));
    const haveMl = new Set((typeof data !== 'undefined' && Array.isArray(data)
      ? data.map(r => normLink(r && r.link)) : []));
    let added = 0, dupS = 0, dupMl = 0;
    const stamp = now();
    const fresh = [];
    for (const p of parsed) {
      const key = normLink(p.link);
      if (!key) continue;
      if (haveS.has(key)) { dupS++; continue; }
      if (haveMl.has(key)) { dupMl++; continue; }
      haveS.add(key);
      const row = Object.assign({
        id: mkId(), type: 'other', link: '', VidTitle: '', VidAuthor: '',
        attribution: '', vidLength: '', comment: '', tags: [],
        status: 'new', DateAdded: stamp
      }, p);
      rows.push(row);
      fresh.push(row);
      added++;
    }
    if (added) {
      if (table) table.addData(fresh, false);   // append to bottom (virtual-DOM safe)
      markDirty();
      persist(false);
    }
    updateCount();
    return { added, dupS, dupMl, total: parsed.length };
  }

  async function importFromClipboard() {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch (e) {
      stToast('✗ Clipboard read blocked.\nClick inside the page first, or allow clipboard permission.', 3800);
      return;
    }
    if (!text.trim()) { stToast('Clipboard is empty.', 1800); return; }
    const parsed = parseClipboard(text);
    if (!parsed.length) { stToast('No links found in the clipboard text.', 2400); return; }
    const r = importRows(parsed);
    const byType = {};
    rows.slice(-r.added).forEach(x => { byType[x.type] = (byType[x.type] || 0) + 1; });
    const typeLine = Object.keys(byType).sort().map(k => r.added && byType[k] ? `${byType[k]} ${k}` : '').filter(Boolean).join(' · ');
    stToast(`📋 Imported ${r.added} new link(s)`
      + (r.added ? '\n' + typeLine : '')
      + ((r.dupS || r.dupMl) ? `\n(skipped ${r.dupS} already-staged · ${r.dupMl} already in ml.json)` : ''), 4200);
  }

  // ── Tabulator lazy loader ────────────────────────────────────────────────────
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
      sc.onerror = () => reject(new Error('tabulator.min.js failed to load (is it vendored in the project root?)'));
      document.head.appendChild(sc);
    });
  }

  // ── CSS (scoped under #stOverlay, injected once) ─────────────────────────────
  function injectCss() {
    if (document.getElementById('st-css')) return;
    const s = document.createElement('style');
    s.id = 'st-css';
    s.textContent = `
#stOverlay{position:fixed;inset:0;z-index:29500;display:none;flex-direction:column;
  background:#11151c;color:#dfe6ee;font:13px/1.4 system-ui,Segoe UI,sans-serif}
#stOverlay.open{display:flex}
#stBar{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#0c0f14;
  border-bottom:1px solid #232b36;flex:0 0 auto;flex-wrap:wrap}
#stBar h2{margin:0;font-size:15px;font-weight:700;color:#9ad}
#stBar .ct{color:#7d8794;font-size:12px}
#stBar input[type=text]{background:#1a212b;border:1px solid #2c3645;color:#dfe6ee;
  border-radius:6px;padding:5px 8px;width:220px;font:13px system-ui}
#stBar select{background:#1a212b;border:1px solid #2c3645;color:#dfe6ee;border-radius:6px;padding:4px 6px}
#stBar button{background:#1f2733;border:1px solid #34404f;color:#cfe;border-radius:6px;
  padding:5px 10px;cursor:pointer;font:600 12px system-ui}
#stBar button:hover{background:#27313f}
#stBar button.primary{background:#0a84ff;border-color:#0a84ff;color:#fff}
#stBar button.danger{background:#7a2230;border-color:#b3344a;color:#fff}
#stBar button:disabled{opacity:.5;cursor:default}
#stBar .spacer{flex:1}
#stBar #stClose{font-size:18px;padding:2px 10px;line-height:1}
#stWrap{flex:1;overflow:hidden;position:relative}
#stTable{height:100%}
#stEmpty{position:absolute;inset:0;display:none;align-items:center;justify-content:center;
  text-align:center;color:#7d8794;padding:40px;pointer-events:none}
#stToast{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) scale(.96);
  background:#10151d;color:#eaf1f8;border:1px solid #34404f;border-radius:12px;
  padding:16px 26px;font:14px/1.5 system-ui,Segoe UI,sans-serif;text-align:center;
  white-space:pre-line;max-width:560px;box-shadow:0 14px 50px rgba(0,0,0,.65);
  z-index:40000;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s}
#stToast.show{opacity:1;transform:translate(-50%,-50%) scale(1)}
.st-badge{display:inline-block;padding:1px 7px;border-radius:4px;font-size:11px;font-weight:700}
.t-jpg{background:#1e3a4a;color:#7fd0ee}.t-yt{background:#4a2330;color:#ff9bb0}
.t-vimeo{background:#23414a;color:#7fe0d0}.t-video{background:#2a3a52;color:#9ab6ff}.t-other{background:#333;color:#aaa}
.st-stat-new{color:#7d8794}.st-stat-promoted{color:#6fb6ff;font-weight:700}
#stTable .tabulator-cell a{color:#7fb8ff;text-decoration:none}
#stTable .tabulator-cell a:hover{text-decoration:underline}
`;
    document.head.appendChild(s);
  }

  // ── DOM scaffold ─────────────────────────────────────────────────────────────
  function build() {
    injectCss();
    if (document.getElementById('stOverlay')) return;
    const o = document.createElement('div');
    o.id = 'stOverlay';
    o.innerHTML = `
      <div id="stBar">
        <h2>St · bulk staging</h2>
        <span class="ct" id="stCount"></span>
        <input type="text" id="stSearch" placeholder="search link / title / author / attribution…  (press f)">
        <select id="stType">
          <option value="all">all types</option>
          <option value="jpg">jpg / image</option>
          <option value="yt">YouTube</option>
          <option value="vimeo">Vimeo</option>
          <option value="video">direct video</option>
          <option value="other">other</option>
        </select>
        <select id="stStatus">
          <option value="all">all status</option>
          <option value="new">new</option>
          <option value="promoted">promoted</option>
        </select>
        <div class="spacer"></div>
        <button id="stImport" class="primary" title="Import links from the clipboard (hotkey w)">📋 Import clipboard</button>
        <button id="stPromote" title="Copy selected rows into ml.json (stamped BA=1)">➕ Promote sel</button>
        <button id="stDelete" class="danger" title="Remove selected rows from the staging store">🗑 Delete sel</button>
        <button id="stReload" title="Reload s.json from disk">↻ Reload</button>
        <button id="stSave" title="Write edits back to s.json">💾 Save</button>
        <button id="stClose" title="Close (Esc / T)">×</button>
      </div>
      <div id="stWrap">
        <div id="stTable"></div>
        <div id="stEmpty"></div>
      </div>`;
    document.body.appendChild(o);

    const $ = id => o.querySelector('#' + id);
    $('stSearch').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); applyFilters(); });
    $('stType').addEventListener('change', e => { typeFilter = e.target.value; applyFilters(); });
    $('stStatus').addEventListener('change', e => { statusFilter = e.target.value; applyFilters(); });
    $('stImport').addEventListener('click', () => importFromClipboard());
    $('stPromote').addEventListener('click', () => promoteSelected());
    $('stDelete').addEventListener('click', () => deleteSelected());
    $('stReload').addEventListener('click', () => loadData());
    $('stSave').addEventListener('click', () => persist(true));
    $('stClose').addEventListener('click', () => closeStScreen());
  }

  // ── Tabulator columns ────────────────────────────────────────────────────────
  function columns() {
    const typeBadge = c => {
      const t = c.getValue() || 'other';
      return `<span class="st-badge t-${esc(t)}">${esc(t)}</span>`;
    };
    const linkCell = c => {
      const u = c.getValue() || '';
      return u ? `<a href="${esc(u)}" target="_blank" rel="noopener" title="${esc(u)}">${esc(u)}</a>` : '';
    };
    const statusCell = c => {
      const s = c.getValue() || 'new';
      return `<span class="st-stat-${esc(s)}">${esc(s)}</span>`;
    };
    const tagsCell = c => {
      const v = c.getValue();
      return Array.isArray(v) ? v.join(', ') : (v || '');
    };
    return [
      { formatter: 'rowSelection', titleFormatter: 'rowSelection', hozAlign: 'center', headerSort: false, width: 40, frozen: true },
      { title: 'Type', field: 'type', width: 80, formatter: typeBadge, headerFilter: false },
      { title: 'Link', field: 'link', widthGrow: 3, formatter: linkCell, headerFilter: 'input' },
      { title: 'Title', field: 'VidTitle', widthGrow: 2, editor: 'input', headerFilter: 'input' },
      { title: 'Author', field: 'VidAuthor', width: 130, editor: 'input', headerFilter: 'input' },
      { title: 'Attribution', field: 'attribution', width: 150, editor: 'input', headerFilter: 'input' },
      { title: 'Len', field: 'vidLength', width: 70, editor: 'input', hozAlign: 'right' },
      { title: 'Comment', field: 'comment', width: 130, editor: 'input' },
      { title: 'Tags', field: 'tags', width: 130, formatter: tagsCell, editor: 'input',
        mutatorEdit: v => String(v || '').split(',').map(s => s.trim()).filter(Boolean) },
      { title: 'Status', field: 'status', width: 90, formatter: statusCell },
      { title: 'Added', field: 'DateAdded', width: 150, hozAlign: 'right' }
    ];
  }

  function buildTable() {
    table = new window.Tabulator('#stTable', {
      data: rows,
      index: 'id',
      columns: columns(),
      layout: 'fitColumns',
      height: '100%',
      selectableRows: true,
      placeholder: '',
      reactiveData: false,
      movableColumns: true,
      headerSortClickElement: 'icon'
    });
    table.on('cellEdited', () => { markDirty(); scheduleSave(); });
    table.on('rowSelectionChanged', () => updateCount());
    table.on('tableBuilt', () => { applyFilters(); updateCount(); });
  }

  // Combined free-text + type + status filter (Tabulator function filter).
  function applyFilters() {
    if (!table) return;
    table.setFilter(row => {
      if (typeFilter !== 'all' && (row.type || 'other') !== typeFilter) return false;
      if (statusFilter !== 'all' && (row.status || 'new') !== statusFilter) return false;
      if (query) {
        const hay = (row.link + ' ' + (row.VidTitle || '') + ' ' + (row.VidAuthor || '')
          + ' ' + (row.attribution || '') + ' ' + (row.comment || '')
          + ' ' + ((row.tags || []).join(' '))).toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
    updateCount();
  }

  function updateCount() {
    const el = document.getElementById('stCount');
    const empty = document.getElementById('stEmpty');
    const shown = table ? table.getDataCount('active') : rows.length;
    const selN = table ? table.getSelectedRows().length : 0;
    const promoted = rows.filter(r => r.status === 'promoted').length;
    if (el) el.textContent = `${shown}/${rows.length} shown · ${promoted} promoted`
      + (selN ? ` · ${selN} selected` : '')
      + (dirty ? ' · ⚠ unsaved' : '');
    const sv = document.getElementById('stSave');
    if (sv) sv.classList.toggle('primary', dirty);
    if (empty) {
      if (!rows.length) { empty.style.display = 'flex'; empty.textContent = 's.json is empty — copy some links and press w (or 📋 Import clipboard).'; }
      else if (!shown) { empty.style.display = 'flex'; empty.textContent = 'No rows match the filter.'; }
      else empty.style.display = 'none';
    }
  }

  function markDirty() { dirty = true; updateCount(); }
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => persist(false), 1200); }

  // ── Promote → ml.json (BA="1" bulk marker) ───────────────────────────────────
  function promoteSelected() {
    if (!table) return;
    const sel = table.getSelectedRows().map(r => r.getData()).filter(r => r.status !== 'promoted');
    if (!sel.length) { stToast('Select un-promoted rows first (checkbox column).', 2400); return; }
    if (typeof data === 'undefined' || typeof nextUID !== 'function' || typeof save !== 'function') {
      stToast('ml.json not loaded — open the T screen once first, then promote.', 3200); return;
    }
    if (!confirm(`Promote ${sel.length} row(s) into ml.json?\nThey become real T/G rows, stamped BA="1" (bulk-added).`)) return;
    const stamp = now();
    let ok = 0;
    for (const r of sel) {
      const mlRow = {
        UID: nextUID(),
        link: r.link,
        VidTitle: r.VidTitle || '',
        VidAuthor: r.VidAuthor || '',
        attribution: r.attribution || '',
        vidLength: r.vidLength || '',
        comment: r.comment || '',
        tags: Array.isArray(r.tags) ? r.tags : [],
        ltype: r.type || '',
        BA: '1',                 // bulk-added marker (the existing ml.json convention)
        show: '1',
        DateAdded: stamp,
        DateModified: stamp,
        sSource: r.id            // provenance: which s.json row this came from
      };
      data.push(mlRow);
      r.status = 'promoted';
      r.mlUID = mlRow.UID;
      const live = rows.find(x => x.id === r.id);
      if (live) { live.status = 'promoted'; live.mlUID = mlRow.UID; }
      table.updateData([{ id: r.id, status: 'promoted', mlUID: mlRow.UID }]);
      ok++;
    }
    save();                      // write ml.json
    markDirty(); persist(false); // write s.json (promoted status)
    applyFilters();
    stToast(`➕ Promoted ${ok} row(s) → ml.json (BA="1")`, 2800);
  }

  function deleteSelected() {
    if (!table) return;
    const sel = table.getSelectedRows();
    if (!sel.length) { stToast('Select rows to delete first.', 2200); return; }
    if (!confirm(`Delete ${sel.length} row(s) from the staging store?\n(ml.json is NOT affected — only s.json.)`)) return;
    const ids = new Set(sel.map(r => r.getData().id));
    rows = rows.filter(r => !ids.has(r.id));
    sel.forEach(r => table.deleteRow(r.getData().id));
    markDirty(); persist(false);
    applyFilters();
    stToast(`🗑 Deleted ${ids.size} row(s) from s.json`, 2200);
  }

  // ── Persist back to s.json (proxy /s/save) ───────────────────────────────────
  async function persist(announce) {
    try {
      const res = await fetch(PROXY + '/s/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows })
      });
      const j = await res.json();
      if (!j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + res.status));
      dirty = false;
      updateCount();
      if (announce) stToast('💾 saved s.json (' + j.total + ' rows)', 1800);
      return true;
    } catch (e) {
      if (announce) stToast('✗ save failed: ' + (e && e.message) + '\n(Is proxy.js running & dev0447+?)', 4200);
      return false;
    }
  }

  // ── Load ──────────────────────────────────────────────────────────────────────
  async function loadData() {
    try {
      const r = await fetch(STORE_URL());
      rows = r.ok ? (await r.json()) : [];
      if (!Array.isArray(rows)) rows = [];
    } catch (e) { rows = []; }
    // Backfill ids / types for any hand-edited or legacy rows.
    rows.forEach(r => {
      if (!r.id) r.id = mkId();
      if (!r.type) r.type = urlType(r.link);
      if (!r.status) r.status = 'new';
    });
    dirty = false;
    if (table) { table.setData(rows); applyFilters(); }
    updateCount();
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  async function openStScreen() {
    if (typeof _isUserMode === 'function' && _isUserMode()) return;   // dev-only
    build();
    document.getElementById('stOverlay').classList.add('open');
    try {
      await loadTabulator();
    } catch (e) {
      stToast('✗ ' + e.message, 5000);
      return;
    }
    await loadData();           // fetch s.json into `rows` first (table still null)
    if (!table) buildTable();   // build Tabulator with the loaded data (no setData race)
    // Come up UNFOCUSED so bare-letter hotkeys (w/f) work immediately.
  }
  function closeStScreen() {
    if (dirty) persist(false);     // best-effort flush on close
    document.getElementById('stOverlay')?.classList.remove('open');
  }
  function isStScreenOpen() {
    return document.getElementById('stOverlay')?.classList.contains('open') || false;
  }

  // In-window key handling. Capture-phase; core.js's dispatcher bails on w/f while
  // St is open so they reach us here (mirrors the Ig f/c arrangement).
  //   w   → import from clipboard.
  //   f   → focus the search box.   Shift+F → clear the text search.
  //   Esc → leave the search box (filter stays); else leave the screen.
  window.addEventListener('keydown', e => {
    if (!isStScreenOpen()) return;
    const ae = document.activeElement;
    const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);

    if (e.key === 'Escape') {
      if (typing) { ae.blur(); e.stopPropagation(); e.preventDefault(); return; }
      e.stopPropagation(); e.preventDefault();
      closeStScreen();
      if (typeof window._executeHotkey === 'function') window._executeHotkey('t');   // leave → T
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'w') {
      e.stopPropagation(); e.preventDefault();
      importFromClipboard();
      return;
    }
    if (e.key === 'f') {
      e.stopPropagation(); e.preventDefault();
      document.getElementById('stSearch')?.focus();
      return;
    }
    if (e.key === 'F') {
      e.stopPropagation(); e.preventDefault();
      query = '';
      const s = document.getElementById('stSearch'); if (s) s.value = '';
      applyFilters();
      stToast('🔎 search cleared', 1400);
      return;
    }
  }, true);

  window.openStScreen = openStScreen;
  window.closeStScreen = closeStScreen;
  window.isStScreenOpen = isStScreenOpen;
})();
