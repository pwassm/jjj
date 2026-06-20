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
  let l1Filter = 'all';          // (dev0451) L1 category facet (all / Flickr / Youtube / … / __blank__)
  let l2Filter = 'all';          // (dev0451) L2 sub-category facet (all / MyPhotos1 / … / __blank__)
  let dirty = false;             // unsaved edits (edit/import/promote/delete)
  let saveTimer = null;          // debounce for autosave after inline edits
  let focusId = null;            // id of the single FOCUSED row (drives the preview + arrow nav)
  const PV_HOST = 'st-pv-host';  // preview media host id — videos register under this key in seeLearnVideoPlayers
  // In-memory trash so Delete/d and Add(a) are reversible with Ctrl+Z within the
  // session. Each entry: {kind:'delete'|'add', row, pos, mlUID?}.
  const undoStack = [];
  // (dev0450) Normalized links of rows previously deleted from s.json (archived to
  // sdeleted.json by the proxy). Import dedups against this too, so a link the user
  // already threw away isn't re-staged from a re-pasted clipboard list.
  let deletedLinks = new Set();

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
  // (dev0451) L1 "source" category — a higher-level bucket than `type`. Derived from
  // the URL only where unambiguous (Flickr jpgs are type='jpg' but L1='Flickr', so L1
  // is independent of type). Everything else is left blank for the user to set via the
  // "🏷 L1/L2" bulk dialog (Promote/FromDown/MyPhotos… live there, not in the URL).
  function deriveL1(u) {
    u = String(u || '');
    if (/youtube\.com|youtu\.be/i.test(u)) return 'Youtube';
    if (/vimeo\.com/i.test(u)) return 'Vimeo';
    if (/flickr\.com|staticflickr\.com/i.test(u)) return 'Flickr';
    return '';
  }
  // The limited L1 set the bulk dialog offers (plus any custom values already in use,
  // plus an "other…" sentinel that reveals a free-text box for a brand-new category).
  const L1_PRESETS = ['Flickr', 'Youtube', 'Vimeo', 'FromDown'];
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

  // (dev0450) Numeric sort keys for the Res / Size / Len columns — their cell values
  // are display strings ("1920×1080", "2.4 MB", "1:43"), so the default STRING sort
  // ordered them wrong ("9 MB" after "10 MB", "640×480" after "1024×768"). Parse to a
  // comparable number; unparseable / blank → 0 so empties sink to one end.
  function resPixels(s) {
    const m = String(s || '').match(/(\d+)\s*[×x*]\s*(\d+)/i);
    return m ? (+m[1]) * (+m[2]) : 0;
  }
  function sizeBytes(s) {
    const m = String(s || '').match(/([\d.]+)\s*(t|g|m|k)?b?\b/i);
    if (!m) return 0;
    const mult = { t: 1099511627776, g: 1073741824, m: 1048576, k: 1024 }[(m[2] || '').toLowerCase()] || 1;
    return (parseFloat(m[1]) || 0) * mult;
  }
  function lenSecs(s) {
    s = String(s || '').trim();
    if (!s) return 0;
    const p = s.split(':').map(n => parseInt(n, 10));
    if (p.some(n => !Number.isFinite(n))) return 0;
    return p.reduce((a, n) => a * 60 + n, 0);
  }

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
    let added = 0, dupS = 0, dupMl = 0, dupDel = 0;
    const stamp = now();
    const fresh = [];
    for (const p of parsed) {
      const key = normLink(p.link);
      if (!key) continue;
      if (haveS.has(key)) { dupS++; continue; }
      if (haveMl.has(key)) { dupMl++; continue; }
      if (deletedLinks.has(key)) { dupDel++; continue; }   // (dev0450) previously deleted
      haveS.add(key);
      const row = Object.assign({
        id: mkId(), type: 'other', link: '', L1: deriveL1(p.link), L2: '',
        VidTitle: '', VidAuthor: '',
        attribution: '', vidLength: '', resolution: '', size: '', comment: '', tags: [],
        status: 'new', DateAdded: stamp
      }, p);
      rows.push(row);
      fresh.push(row);
      added++;
    }
    if (added) {
      if (table) {
        table.addData(fresh, false);             // append to bottom (virtual-DOM safe)
        // (dev0451) Auto-CHECK the freshly imported rows so the very next action —
        // "🏷 L1/L2" (press c) — categorises exactly what was just pasted, matching the
        // "after bulk import → Enter L1/L2" workflow.
        try { table.selectRow(fresh.map(r => r.id)); } catch (_) {}
      }
      markDirty();
      persist(false);
      refreshL1L2Options();
    }
    updateCount();
    return { added, dupS, dupMl, dupDel, total: parsed.length };
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
      + (r.added ? '\n✓ checked the new rows — press c to set L1/L2' : '')
      + ((r.dupS || r.dupMl || r.dupDel)
        ? `\n(skipped ${r.dupS} already-staged · ${r.dupMl} already in ml.json · ${r.dupDel} previously deleted)` : ''), 4600);
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
/* Focused (previewed) row — the one arrows move and Delete/d/a act on. */
#stTable .tabulator-row.st-focus{background:#16324e !important;box-shadow:inset 4px 0 0 #4df}
#stTable .tabulator-row.st-focus .tabulator-cell{background:transparent !important}
/* Floating preview window — shows whatever the focused link renders as.
   Draggable by its title bar, resizable (resize:both), position+size remembered
   in localStorage. Default position is centred (set in JS). */
#stPreview{position:fixed;width:640px;height:460px;z-index:30200;
  background:#000;border:1px solid #4df;border-radius:8px;overflow:hidden;display:none;
  flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.72);
  resize:both;min-width:320px;min-height:230px;max-width:96vw;max-height:92vh}
#stPreview.show{display:flex}
#stPvDrag{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:10px;
  cursor:move;user-select:none;padding:4px 9px;background:#0a1426;border-bottom:1px solid #1a2a4a;
  font:11px/1.3 system-ui;color:#9ad;touch-action:none}
#stPvDrag .h{font-weight:700}
#stPvDrag .hint{color:#5b6b86;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#st-pv-host{position:relative;flex:1 1 auto;background:#000;overflow:hidden}
#stPvCap{flex:0 0 auto;max-height:62px;overflow:hidden;padding:5px 9px;background:#0a1426;
  border-top:1px solid #1a2a4a;font:11px/1.4 monospace;color:#bcd}
/* (dev0451) "Enter L1/L2" bulk dialog */
#stCatModal{position:fixed;inset:0;z-index:40500;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.55)}
#stCatModal .stcat-box{background:#141a23;border:1px solid #34404f;border-radius:12px;padding:18px 22px;
  width:min(440px,92vw);box-shadow:0 20px 70px rgba(0,0,0,.7)}
#stCatModal h3{margin:0 0 12px;font-size:15px;color:#9ad;font-weight:700}
#stCatModal h3 .n{color:#fff}
#stCatModal label{display:block;margin:13px 0 4px;font-size:12px;color:#bcd}
#stCatModal label.ckrow{display:flex;align-items:center;gap:7px;font-size:12px;color:#9fb0c2;margin:10px 0 0}
#stCatModal label.ckrow input{width:auto;margin:0}
#stCatModal .hint{color:#6b7a8d;font-weight:400}
#stCatModal select,#stCatModal input[type=text]{width:100%;box-sizing:border-box;background:#1a212b;
  border:1px solid #2c3645;color:#dfe6ee;border-radius:6px;padding:7px 9px;font:13px system-ui;margin-top:2px}
#stCatModal .stcat-btns{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
#stCatModal button{background:#1f2733;border:1px solid #34404f;color:#cfe;border-radius:6px;
  padding:7px 14px;cursor:pointer;font:600 12px system-ui}
#stCatModal button.primary{background:#0a84ff;border-color:#0a84ff;color:#fff}
#stCatModal button:hover{filter:brightness(1.15)}
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
        <select id="stL1" title="Filter by L1 category"><option value="all">all L1</option></select>
        <select id="stL2" title="Filter by L2 sub-category"><option value="all">all L2</option></select>
        <div class="spacer"></div>
        <button id="stImport" class="primary" title="Import links from the clipboard (hotkey w)">📋 Import clipboard</button>
        <button id="stCat" title="Set L1 / L2 on the CHECKED rows in bulk.&#10;L1 = limited category (Flickr / Youtube / Vimeo / FromDown / new) · L2 = album/author (e.g. MyPhotos1).&#10;Hotkey c.">🏷 L1/L2</button>
        <button id="stFillMeta" title="Fill Res / Size / Len on the CHECKED rows (or the focused row if none checked).&#10;Images &amp; direct videos are probed in-browser; YouTube/Vimeo use yt-dlp via the proxy.&#10;Hotkey e.">📐 Fill meta</button>
        <button id="stPromote" title="Copy CHECKED rows into ml.json, keep them here as 'promoted' (stamped BA=1).&#10;Hotkey a = add the FOCUSED row to ml.json AND remove it from staging (Ctrl+Z undo).">➕ Promote sel</button>
        <button id="stDelete" class="danger" title="Remove CHECKED rows from the staging store.&#10;Hotkey Delete or d = remove the FOCUSED row (Ctrl+Z undo).">🗑 Delete sel</button>
        <button id="stReload" title="Reload s.json from disk">↻ Reload</button>
        <button id="stSave" title="Write edits back to s.json">💾 Save</button>
        <button id="stClose" title="Close (Esc / T)">×</button>
      </div>
      <div id="stWrap">
        <div id="stTable"></div>
        <div id="stEmpty"></div>
      </div>
      <div id="stPreview" title="Preview of the focused row (arrows move focus · Delete/d remove · a add to T)">
        <div id="stPvDrag"><span class="h">▣ Preview</span><span class="hint">drag to move · drag corner to resize · double-click = recentre</span></div>
        <div id="${PV_HOST}"></div>
        <div id="stPvCap"></div>
      </div>`;
    document.body.appendChild(o);

    const $ = id => o.querySelector('#' + id);
    $('stSearch').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); applyFilters(); });
    $('stType').addEventListener('change', e => { typeFilter = e.target.value; applyFilters(); });
    $('stStatus').addEventListener('change', e => { statusFilter = e.target.value; applyFilters(); });
    $('stL1').addEventListener('change', e => { l1Filter = e.target.value; applyFilters(); });
    $('stL2').addEventListener('change', e => { l2Filter = e.target.value; applyFilters(); });
    $('stImport').addEventListener('click', () => importFromClipboard());
    $('stCat').addEventListener('click', () => openCatModal());
    $('stFillMeta').addEventListener('click', () => fillMetaSelected());
    $('stPromote').addEventListener('click', () => promoteSelected());
    $('stDelete').addEventListener('click', () => deleteSelected());
    $('stReload').addEventListener('click', () => loadData());
    $('stSave').addEventListener('click', () => persist(true));
    $('stClose').addEventListener('click', () => closeStScreen());

    applyPvBox();        // position the preview (centred default, or last saved spot)
    wirePreviewDrag();   // make the title bar draggable + remember resize
  }

  // Keep the preview on-screen when the viewport changes (it's fixed-positioned).
  window.addEventListener('resize', () => { if (isStScreenOpen()) applyPvBox(); });

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
      { title: 'L1', field: 'L1', width: 92, editor: 'input',
        headerTooltip: 'L1 primary category (Flickr / Youtube / Vimeo / FromDown / custom). Set in bulk with the “🏷 L1/L2” button or hotkey c · auto-derived from the URL on import.' },
      { title: 'L2', field: 'L2', width: 112, editor: 'input',
        headerTooltip: 'L2 sub-category / album (e.g. MyPhotos1). For YouTube this is usually the channel/author.' },
      { title: 'Link', field: 'link', widthGrow: 3, formatter: linkCell, headerFilter: 'input' },
      { title: 'Title', field: 'VidTitle', widthGrow: 2, editor: 'input', headerFilter: 'input' },
      { title: 'Author', field: 'VidAuthor', width: 130, editor: 'input', headerFilter: 'input' },
      { title: 'Attribution', field: 'attribution', width: 150, editor: 'input', headerFilter: 'input' },
      { title: 'Len', field: 'vidLength', width: 62, editor: 'input', hozAlign: 'right',
        sorter: (a, b) => lenSecs(a) - lenSecs(b),
        headerTooltip: 'Length (m:ss) — auto-filled for video by 📐 Fill meta' },
      { title: 'Res', field: 'resolution', width: 96, editor: 'input', hozAlign: 'right',
        sorter: (a, b) => resPixels(a) - resPixels(b),
        headerTooltip: 'Resolution (W×H) — auto-filled for images & video by 📐 Fill meta · sorts by pixel count' },
      { title: 'Size', field: 'size', width: 78, editor: 'input', hozAlign: 'right',
        sorter: (a, b) => sizeBytes(a) - sizeBytes(b),
        headerTooltip: 'File size — auto-filled for images & direct video by 📐 Fill meta · sorts by bytes' },
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
      // (dev0449) Plain checkbox clicks still toggle independently (accumulate, as
      // the Promote/Delete-sel buttons expect); Shift-click selects a contiguous
      // range — wired manually in wireRangeSelect() (Tabulator's built-in 'click'
      // range mode would hijack plain clicks into single-select). The header
      // checkbox (titleFormatter:'rowSelection') is the select-all.
      placeholder: '',
      reactiveData: false,
      movableColumns: true,
      // (dev0449) Click anywhere on a column header to sort (was icon-only).
      // Virtual-DOM safe focus highlight: re-applied every time Tabulator (re)renders
      // a row, so it survives scroll recycling, sort and filter.
      rowFormatter: row => {
        row.getElement().classList.toggle('st-focus', row.getData().id === focusId);
      }
    });
    table.on('cellEdited', cell => {
      markDirty(); scheduleSave();
      const f = cell && cell.getField && cell.getField();
      if (f === 'L1' || f === 'L2') refreshL1L2Options();   // keep the facet dropdowns in sync
    });
    table.on('rowSelectionChanged', () => updateCount());
    // Clicking anywhere on a row focuses it (drives the preview). The checkbox /
    // link cells still do their own thing — this only sets which row is previewed.
    table.on('rowClick', (e, row) => setFocus(row.getData().id, { scroll: false }));
    table.on('tableBuilt', () => { applyFilters(); updateCount(); reconcileFocus(); wireRangeSelect(); });
  }

  // ── Shift-click range selection over the checkboxes ──────────────────────────
  // Capture-phase so we run BEFORE the checkbox's own toggle and can suppress it on
  // a Shift-click. Plain clicks fall through to Tabulator's independent toggle and
  // just move the range anchor; Shift-click selects every row between the anchor
  // and the clicked row (in current filtered+sorted display order).
  let _selAnchorId = null;
  function wireRangeSelect() {
    const wrap = document.getElementById('stTable');
    if (!wrap || wrap._rangeWired) return;
    wrap._rangeWired = true;
    wrap.addEventListener('click', e => {
      const cb = e.target;
      if (!table || !cb || cb.tagName !== 'INPUT' || cb.type !== 'checkbox') return;
      const rowEl = cb.closest('.tabulator-row');
      if (!rowEl) { _selAnchorId = null; return; }   // header select-all → reset anchor
      const act = table.getRows('active');
      const comp = act.find(r => r.getElement() === rowEl);
      if (!comp) return;
      const id = comp.getData().id;
      const i1 = e.shiftKey && _selAnchorId ? act.findIndex(r => r.getData().id === _selAnchorId) : -1;
      const i2 = i1 >= 0 ? act.findIndex(r => r.getData().id === id) : -1;
      if (i1 >= 0 && i2 >= 0) {
        e.preventDefault();                           // valid range → suppress the single toggle
        const lo = Math.min(i1, i2), hi = Math.max(i1, i2);
        try { table.selectRow(act.slice(lo, hi + 1)); } catch (_) {}
      } else {
        _selAnchorId = id;                            // plain click → anchor for the next Shift-click
      }
    }, true);
  }

  // ── Focus + lower-left preview ───────────────────────────────────────────────
  // The FOCUSED row is the single row shown in the preview window and acted on by
  // the arrow keys, Delete/d and a. Distinct from the checkbox selection (which
  // still drives the bulk "Promote sel" / "Delete sel" buttons).
  const activeRowComps = () => (table ? table.getRows('active') : []);  // filtered+sorted, display order

  function setFocus(id, opts) {
    opts = opts || {};
    const prev = focusId;
    focusId = id || null;
    if (table) {
      [prev, focusId].forEach(fid => {
        if (!fid) return;
        const r = table.getRow(fid);
        if (r) { try { r.reformat(); } catch (_) {} }
      });
      if (focusId && opts.scroll !== false) {
        const r = table.getRow(focusId);
        // 'nearest' + ifVisible:false → only scrolls when the row is off-screen,
        // so arrowing through visible rows doesn't yank the viewport around.
        if (r) { try { const p = r.scrollTo('nearest', false); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
      }
    }
    refreshPreview();
    scheduleAutoProbe(focusId);   // auto-fill Res/Size/Len for the focused image/video
  }

  // After a filter/search change (or a delete), keep focus on a still-visible row:
  // keep the current one if it survived, else snap to the first visible row.
  function reconcileFocus() {
    const act = activeRowComps();
    if (!act.length) { setFocus(null); return; }
    // Snap to the first visible row only when the focused row vanished (or none yet).
    // If the same row is still visible, leave it — the preview already shows it, so
    // we don't remount its video on every search keystroke.
    if (!focusId || !act.some(r => r.getData().id === focusId)) setFocus(act[0].getData().id);
  }

  // Arrow nav: step the focus one row up/down through the visible (filtered+sorted) set.
  function moveFocus(delta) {
    const act = activeRowComps();
    if (!act.length) return;
    let idx = act.findIndex(r => r.getData().id === focusId);
    if (idx < 0) idx = delta > 0 ? -1 : act.length;   // first ↓ → top, first ↑ → bottom
    const ni = Math.max(0, Math.min(act.length - 1, idx + delta));
    setFocus(act[ni].getData().id);
  }

  // The neighbour to focus AFTER the current focused row is removed (next, else prev).
  function focusNeighborId() {
    const act = activeRowComps();
    const i = act.findIndex(r => r.getData().id === focusId);
    if (i < 0) return act.length ? act[0].getData().id : null;
    const n = act[i + 1] || act[i - 1];
    return n ? n.getData().id : null;
  }

  // (Re)build the preview window for the focused row. Tears down any prior video.
  function refreshPreview() {
    const pv = document.getElementById('stPreview');
    const host = document.getElementById(PV_HOST);
    if (!pv || !host) return;
    if (window.stopCellVideoLoop) { try { window.stopCellVideoLoop(PV_HOST); } catch (_) {} }
    host.innerHTML = '';
    const row = focusId ? rows.find(r => r.id === focusId) : null;
    if (!row || !row.link) { pv.classList.remove('show'); return; }
    pv.classList.add('show');
    applyPvBox();   // re-clamp to the current viewport (handles a resize while St was closed)
    fillPreviewHost(host, row);
    fillPreviewCaption(row);
  }

  // Render the media for one row — reuses the shared window.mount* / isVideoRow
  // helpers (same machinery the grid and the T Ctrl+I preview use). Muted autoplay
  // so the preview reliably plays while bulk-reviewing (click the Link cell for sound).
  function fillPreviewHost(host, row) {
    const link = row.link || '';
    const isVid = window.isVideoRow ? window.isVideoRow(row) : false;
    const isImg = /\.(jpe?g|png|gif|webp|svg|bmp|avif|tiff?)(\?.*)?$/i.test(link);
    const id = row.id;   // guard against stale mounts when the user arrows quickly
    if (isVid) {
      const segs = [{ start: 0, dur: 99999 }];
      setTimeout(() => {
        if (focusId !== id || !document.getElementById('stPreview')) return;
        if (window.isYouTubeLink && window.isYouTubeLink(link) && window.mountYouTubeClip)
          window.mountYouTubeClip(host, link, 0, 99999, true, undefined, segs);
        else if (window.isVimeoLink && window.isVimeoLink(link) && window.mountVimeoClip)
          window.mountVimeoClip(host, link, 0, 99999, true, undefined, segs);
        else if (window.isDirectVideoLink && window.isDirectVideoLink(link) && window.mountDirectVideoClip)
          window.mountDirectVideoClip(host, link, 0, 99999, true, undefined, segs);
        else if (window.isTikTokLink && window.isTikTokLink(link) && window.mountTikTokEmbed)
          window.mountTikTokEmbed(host, link);
        else if (window.isInstagramLink && window.isInstagramLink(link) && window.mountInstagramEmbed)
          window.mountInstagramEmbed(host, link);
      }, 60);
      return;
    }
    if (isImg) { _pvImg(host, link); return; }
    // "other" — try it as an image; if it won't load, show a click-to-open note.
    _pvImg(host, link, () => {
      host.innerHTML = '';
      const d = document.createElement('div');
      d.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;'
        + 'justify-content:center;text-align:center;color:#789;font:12px monospace;padding:14px;';
      d.textContent = '(no inline preview — click the Link cell to open)';
      host.appendChild(d);
    });
  }
  function _pvImg(host, src, onFail) {
    const img = document.createElement('img');
    img.src = src;
    img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;';
    img.onerror = onFail || (() => { img.style.opacity = '.25'; });
    host.appendChild(img);
  }
  function fillPreviewCaption(row) {
    const cap = document.getElementById('stPvCap');
    if (!cap) return;
    const t = row.type || 'other';
    const title = (row.VidTitle || '').trim();
    const author = (row.VidAuthor || '').trim();
    cap.innerHTML = `<span class="st-badge t-${esc(t)}">${esc(t)}</span> `
      + (title ? `<span style="color:#cfe;">${esc(title)}</span>` : '')
      + (author ? ` <span style="color:#d8c69a;">· ${esc(author)}</span>` : '')
      + `<div style="color:#7fb8ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;">${esc(row.link || '')}</div>`;
  }
  function previewTeardown() {
    if (window.stopCellVideoLoop) { try { window.stopCellVideoLoop(PV_HOST); } catch (_) {} }
    const host = document.getElementById(PV_HOST);
    if (host) host.innerHTML = '';
    document.getElementById('stPreview')?.classList.remove('show');
  }

  // ── Preview window geometry (draggable + remembered) ─────────────────────────
  // Single source of truth for the preview's box; persisted to localStorage so the
  // last position/size is restored next session.
  const PV_BOX_KEY = 'st-preview-box';
  let pvBox = null, _pvRoT = null;

  function defaultPvBox() {
    const w = Math.min(640, window.innerWidth - 40);
    const h = Math.min(460, window.innerHeight - 60);
    return { left: Math.round((window.innerWidth - w) / 2),
             top: Math.round((window.innerHeight - h) / 2), width: w, height: h };
  }
  function loadPvBox() {
    try {
      const j = JSON.parse(localStorage.getItem(PV_BOX_KEY) || 'null');
      if (j && Number.isFinite(j.left) && Number.isFinite(j.width)) return j;
    } catch (_) {}
    return null;
  }
  function clampBox(b) {
    const W = window.innerWidth, H = window.innerHeight;
    const width = Math.max(320, Math.min(b.width || 640, W - 16));
    const height = Math.max(230, Math.min(b.height || 460, H - 16));
    const left = Math.max(6, Math.min(b.left, W - width - 6));
    const top = Math.max(6, Math.min(b.top, H - height - 6));
    return { left, top, width, height };
  }
  function applyPvBox() {
    const pv = document.getElementById('stPreview');
    if (!pv) return;
    pvBox = clampBox(pvBox || loadPvBox() || defaultPvBox());
    pv.style.left = pvBox.left + 'px'; pv.style.top = pvBox.top + 'px';
    pv.style.right = 'auto'; pv.style.bottom = 'auto';
    pv.style.width = pvBox.width + 'px'; pv.style.height = pvBox.height + 'px';
  }
  function savePvBox() { try { localStorage.setItem(PV_BOX_KEY, JSON.stringify(pvBox)); } catch (_) {} }

  function wirePreviewDrag() {
    const pv = document.getElementById('stPreview');
    const bar = document.getElementById('stPvDrag');
    if (!pv || !bar || bar._wired) return;
    bar._wired = true;
    let drag = false, sx = 0, sy = 0, ox = 0, oy = 0;
    bar.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      drag = true; sx = e.clientX; sy = e.clientY; ox = pv.offsetLeft; oy = pv.offsetTop;
      try { bar.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    bar.addEventListener('pointermove', e => {
      if (!drag) return;
      pvBox = { left: ox + (e.clientX - sx), top: oy + (e.clientY - sy),
                width: pv.offsetWidth, height: pv.offsetHeight };
      applyPvBox();
    });
    const end = e => { if (!drag) return; drag = false;
      try { bar.releasePointerCapture(e.pointerId); } catch (_) {} savePvBox(); };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
    // Double-click the bar → recentre at the default size.
    bar.addEventListener('dblclick', () => { pvBox = defaultPvBox(); applyPvBox(); savePvBox(); });
    // Capture a manual resize (CSS resize:both changes width/height directly).
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        if (!pv.classList.contains('show')) return;
        const r = pv.getBoundingClientRect();
        if (r.width < 80 || r.height < 80) return;
        pvBox = { left: Math.round(r.left), top: Math.round(r.top),
                  width: Math.round(r.width), height: Math.round(r.height) };
        clearTimeout(_pvRoT); _pvRoT = setTimeout(savePvBox, 400);
      }).observe(pv);
    }
  }

  // ── Metadata probing (Res / Size / Len) ──────────────────────────────────────
  // Fills the new Res (W×H), Size and Len columns. Images & direct videos are
  // probed in-browser (cheap, no network round-trip beyond the media itself);
  // YouTube / Vimeo go through the proxy's yt-dlp bridge (slower, opt-in).
  function fmtBytes(bytes) {
    bytes = +bytes;
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    const u = ['B', 'KB', 'MB', 'GB']; let i = 0, n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
  }
  function fmtSecs(secs) {
    secs = Math.round(+secs);
    if (!Number.isFinite(secs) || secs <= 0) return '';
    const m = Math.floor(secs / 60), s = secs % 60;
    return m + ':' + String(s).padStart(2, '0');
  }
  function isImageLink(u) {
    return /\.(jpe?g|png|gif|webp|svg|bmp|avif|tiff?)(\?|#|$)/i.test(String(u || ''));
  }
  // HEAD request for Content-Length — best-effort (CORS often blocks it → '').
  async function headSize(url) {
    try {
      const r = await fetch(url, { method: 'HEAD', mode: 'cors' });
      if (!r.ok) return '';
      return fmtBytes(r.headers.get('content-length'));
    } catch (_) { return ''; }
  }
  function probeImage(url) {
    return new Promise(resolve => {
      const img = new Image();
      let done = false;
      const fin = () => { if (done) return; done = true;
        resolve(img.naturalWidth && img.naturalHeight ? img.naturalWidth + '×' + img.naturalHeight : ''); };
      img.onload = fin; img.onerror = () => { done = true; resolve(''); };
      img.src = url;
      setTimeout(fin, 12000);
    });
  }
  function probeVideo(url) {
    return new Promise(resolve => {
      const v = document.createElement('video');
      v.preload = 'metadata'; v.muted = true;
      let done = false;
      const fin = () => { if (done) return; done = true;
        const res = (v.videoWidth && v.videoHeight) ? v.videoWidth + '×' + v.videoHeight : '';
        const len = fmtSecs(v.duration);
        try { v.removeAttribute('src'); v.load(); } catch (_) {}
        resolve({ resolution: res, vidLength: len }); };
      v.onloadedmetadata = fin; v.onerror = () => { done = true; resolve({ resolution: '', vidLength: '' }); };
      v.src = url;
      setTimeout(fin, 15000);
    });
  }
  // Write any non-empty, changed fields back to the row + the table cell.
  function applyMetaPatch(row, patch) {
    const keys = Object.keys(patch).filter(k => patch[k] && patch[k] !== row[k]);
    if (!keys.length) return false;
    keys.forEach(k => { row[k] = patch[k]; });
    if (table) { try { table.updateData([Object.assign({ id: row.id }, patch)]); } catch (_) {} }
    markDirty(); scheduleSave();
    return true;
  }
  // Probe ONE row. opts.force re-probes filled fields; opts.useYtdlp allows the
  // (slower) yt-dlp path for YouTube/Vimeo.
  async function probeRowMeta(row, opts) {
    opts = opts || {};
    const link = row && row.link;
    if (!link) return false;
    const isImg = isImageLink(link) || row.type === 'jpg';
    const isDirect = window.isDirectVideoLink && window.isDirectVideoLink(link);
    const isYT = window.isYouTubeLink && window.isYouTubeLink(link);
    const isVim = window.isVimeoLink && window.isVimeoLink(link);
    const patch = {};
    try {
      if (isDirect) {
        if (opts.force || !row.resolution || !row.vidLength) {
          const m = await probeVideo(link);
          if (m.resolution) patch.resolution = m.resolution;
          if (m.vidLength) patch.vidLength = m.vidLength;
        }
        if (opts.force || !row.size) { const s = await headSize(link); if (s) patch.size = s; }
      } else if (isImg) {
        if (opts.force || !row.resolution) { const r = await probeImage(link); if (r) patch.resolution = r; }
        if (opts.force || !row.size) { const s = await headSize(link); if (s) patch.size = s; }
      } else if ((isYT || isVim) && opts.useYtdlp && typeof _ytdlpFetchMeta === 'function') {
        const meta = await _ytdlpFetchMeta(link);
        if (meta) {
          if ((opts.force || !row.resolution) && meta.width && meta.height)
            patch.resolution = meta.width + '×' + meta.height;
          if ((opts.force || !row.vidLength) && Number.isFinite(meta.duration))
            patch.vidLength = fmtSecs(meta.duration);
        }
      } else { return false; }
    } catch (_) { /* leave the row's existing values untouched */ }
    return applyMetaPatch(row, patch);
  }

  // Auto-probe the focused row (images & direct video only — cheap & account-safe;
  // YT/Vimeo are left for the explicit 📐 Fill meta so we never auto-hit yt-dlp).
  let _autoProbeTimer = null;
  function scheduleAutoProbe(id) {
    clearTimeout(_autoProbeTimer);
    _autoProbeTimer = setTimeout(() => {
      if (id !== focusId) return;
      const row = rows.find(r => r.id === id);
      if (!row || !row.link) return;
      const isImg = isImageLink(row.link) || row.type === 'jpg';
      const isDirect = window.isDirectVideoLink && window.isDirectVideoLink(row.link);
      if ((isImg && !row.resolution) || (isDirect && (!row.resolution || !row.vidLength)) ||
          ((isImg || isDirect) && !row.size))
        probeRowMeta(row, {});
    }, 320);
  }

  // 📐 Fill meta (button / hotkey e) — probe the CHECKED rows (or the focused one
  // if none are checked). Sequential so a long yt-dlp run can't stampede the proxy.
  let _fillingMeta = false;
  async function fillMetaSelected() {
    if (!table || _fillingMeta) return;
    let targets = table.getSelectedRows().map(r => r.getData());
    if (!targets.length && focusId) { const r = rows.find(x => x.id === focusId); if (r) targets = [r]; }
    if (!targets.length) { stToast('Check some rows (or focus one) first — then 📐 Fill meta.', 2600); return; }
    const ytN = targets.filter(r => {
      const l = r.link || '';
      return (window.isYouTubeLink && window.isYouTubeLink(l)) || (window.isVimeoLink && window.isVimeoLink(l));
    }).length;
    if (ytN > 6 && !confirm(`Fill meta on ${targets.length} row(s)?\n${ytN} are YouTube/Vimeo and use yt-dlp (one at a time — can be slow).`)) return;
    _fillingMeta = true;
    let done = 0, filled = 0;
    for (const t of targets) {
      stToast(`📐 Filling meta…  ${++done}/${targets.length}`, 60000);
      const live = rows.find(x => x.id === t.id) || t;
      try { if (await probeRowMeta(live, { force: true, useYtdlp: true })) filled++; } catch (_) {}
    }
    _fillingMeta = false;
    persist(false);
    stToast(`📐 Filled meta on ${filled} of ${targets.length} row(s).`, 3000);
  }

  // ── Focused-row actions (Delete / Add), reversible via Ctrl+Z ─────────────────
  // Build the ml.json row a staging row promotes to (shared by `a` and Promote sel).
  function toMlRow(r, stamp) {
    return {
      UID: nextUID(),
      link: r.link, VidTitle: r.VidTitle || '', VidAuthor: r.VidAuthor || '',
      attribution: r.attribution || '', vidLength: r.vidLength || '', comment: r.comment || '',
      tags: Array.isArray(r.tags) ? r.tags : [], ltype: r.type || '',
      L1: r.L1 || '', L2: r.L2 || '',
      BA: '1', show: '1', DateAdded: stamp, DateModified: stamp, sSource: r.id
    };
  }

  // (dev0450) Archive deleted rows → sdeleted.json (proxy appends, dedups by id) and
  // add their links to the in-memory dedup set so a re-paste won't re-stage them.
  // Best-effort: a proxy hiccup must never block the delete the user just did.
  function archiveDeleted(removed) {
    const arr = (Array.isArray(removed) ? removed : [removed]).filter(Boolean);
    if (!arr.length) return;
    arr.forEach(r => { const k = normLink(r.link); if (k) deletedLinks.add(k); });
    fetch(PROXY + '/s/deleted', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: arr })
    }).catch(() => stToast('⚠ couldn’t archive to sdeleted.json (proxy dev0450+?)', 2600));
  }
  // Ctrl+Z restore: pull a row back OUT of the archive (it returns to s.json).
  function unarchiveDeleted(rowsArr) {
    const arr = (Array.isArray(rowsArr) ? rowsArr : [rowsArr]).filter(Boolean);
    if (!arr.length) return;
    arr.forEach(r => { const k = normLink(r.link); if (k) deletedLinks.delete(k); });
    fetch(PROXY + '/s/undelete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: arr.map(r => r.id) })
    }).catch(() => {});
  }

  // Delete/d — remove the focused row to the in-session trash (Ctrl+Z restores).
  function deleteFocused() {
    if (!focusId) { stToast('No focused row — click a row or use ↑/↓ first.', 1800); return; }
    const id = focusId;
    const idx = rows.findIndex(r => r.id === id);
    if (idx < 0) return;
    const removed = rows[idx];
    const nextId = focusNeighborId();
    rows.splice(idx, 1);
    if (table) { try { table.deleteRow(id); } catch (_) {} }
    undoStack.push({ kind: 'delete', row: removed, pos: idx });
    archiveDeleted(removed);                   // → sdeleted.json
    markDirty(); persist(false);
    setFocus(nextId);
    updateCount();
    stToast('🗑 Deleted “' + (removed.VidTitle || removed.link || '').slice(0, 44) + '” — Ctrl+Z to undo', 2600);
  }

  // a — Add the focused link to ml.json (BA="1") AND remove it from staging.
  // Both halves are reversible together via Ctrl+Z.
  function addFocusedToT() {
    if (!focusId) { stToast('No focused row — click a row or use ↑/↓ first.', 1800); return; }
    if (typeof data === 'undefined' || typeof nextUID !== 'function' || typeof save !== 'function') {
      stToast('ml.json not loaded — open the T screen once first, then press a.', 3200); return;
    }
    const id = focusId;
    const idx = rows.findIndex(r => r.id === id);
    if (idx < 0) return;
    const r = rows[idx];
    const mlRow = toMlRow(r, now());
    data.push(mlRow);
    save();                                   // write ml.json
    const nextId = focusNeighborId();
    rows.splice(idx, 1);
    if (table) { try { table.deleteRow(id); } catch (_) {} }
    undoStack.push({ kind: 'add', row: r, pos: idx, mlUID: mlRow.UID });
    markDirty(); persist(false);              // write s.json (row removed)
    setFocus(nextId);
    updateCount();
    stToast('➕ Added to ml.json (BA="1") + removed from staging — Ctrl+Z to undo', 2800);
  }

  // Ctrl+Z — reverse the last Delete (re-insert) or Add (pull the ml.json row back
  // out AND re-insert the staging row).
  function undo() {
    const a = undoStack.pop();
    if (!a) { stToast('Nothing to undo.', 1500); return; }
    if (a.kind === 'add') {
      if (typeof data !== 'undefined' && Array.isArray(data) && a.mlUID != null) {
        const di = data.findIndex(x => x && x.UID === a.mlUID);
        if (di >= 0) { data.splice(di, 1); if (typeof save === 'function') save(); }
      }
    } else if (a.kind === 'delete') {
      unarchiveDeleted(a.row);                 // (dev0450) row returns to s.json → leave the archive
    }
    const pos = Math.min(a.pos, rows.length);
    rows.splice(pos, 0, a.row);
    if (table) { try { table.addData([a.row]); } catch (_) {} }
    markDirty(); persist(false);
    applyFilters();
    setFocus(a.row.id);
    stToast((a.kind === 'add'
      ? '↩ Undid Add — removed from ml.json, restored to staging'
      : '↩ Restored “' + (a.row.VidTitle || a.row.link || '').slice(0, 44) + '”'), 2400);
  }

  // Combined free-text + type + status filter (Tabulator function filter).
  function applyFilters() {
    if (!table) return;
    table.setFilter(row => {
      if (typeFilter !== 'all' && (row.type || 'other') !== typeFilter) return false;
      if (statusFilter !== 'all' && (row.status || 'new') !== statusFilter) return false;
      if (l1Filter !== 'all') {
        const v = (row.L1 || '').trim();
        if (l1Filter === '__blank__' ? v !== '' : v !== l1Filter) return false;
      }
      if (l2Filter !== 'all') {
        const v = (row.L2 || '').trim();
        if (l2Filter === '__blank__' ? v !== '' : v !== l2Filter) return false;
      }
      if (query) {
        const hay = (row.link + ' ' + (row.VidTitle || '') + ' ' + (row.VidAuthor || '')
          + ' ' + (row.attribution || '') + ' ' + (row.comment || '')
          + ' ' + ((row.tags || []).join(' '))).toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
    updateCount();
    reconcileFocus();   // keep the preview on a still-visible row after a filter change
  }

  // ── L1 / L2 facet dropdowns (Ig-style: distinct values + counts) ─────────────
  // Rebuilds one bar <select> from the distinct values of `field` across all rows,
  // preserving the current selection if it still exists, plus a "(blank)" bucket so
  // the user can isolate not-yet-categorised rows.
  function refreshFacet(selId, field, getCur, setCur) {
    const selEl = document.getElementById(selId);
    if (!selEl) return;
    const counts = {};
    let blank = 0;
    rows.forEach(r => { const v = (r[field] || '').trim(); if (v) counts[v] = (counts[v] || 0) + 1; else blank++; });
    const vals = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
    let cur = getCur();
    if (cur !== 'all' && cur !== '__blank__' && !counts[cur]) { cur = 'all'; setCur('all'); }
    if (cur === '__blank__' && !blank) { cur = 'all'; setCur('all'); }
    selEl.innerHTML = `<option value="all">all ${field} (${rows.length})</option>`
      + vals.map(v => `<option value="${esc(v)}">${esc(v)} (${counts[v]})</option>`).join('')
      + (blank ? `<option value="__blank__">— (blank) — (${blank})</option>` : '');
    selEl.value = cur;
  }
  function refreshL1L2Options() {
    refreshFacet('stL1', 'L1', () => l1Filter, v => l1Filter = v);
    refreshFacet('stL2', 'L2', () => l2Filter, v => l2Filter = v);
  }

  // ── "Enter L1 / L2" bulk dialog (button 🏷 L1/L2 · hotkey c) ───────────────────
  // Operates on the CHECKED rows (after a bulk import those are auto-checked). L1 is a
  // constrained dropdown (the presets + any custom values already in use + an "other…"
  // sentinel that reveals a free-text box). L2 is free text with a datalist of values
  // already in use. Either field can be left unchanged.
  const selectedRowData = () => (table ? table.getSelectedRows().map(r => r.getData()) : []);

  function openCatModal() {
    if (document.getElementById('stCatModal')) return;
    const sel = selectedRowData();
    if (!sel.length) { stToast('Check some rows first (checkbox column), then 🏷 L1/L2 / press c.', 2800); return; }
    const used = Array.from(new Set(rows.map(r => (r.L1 || '').trim()).filter(Boolean)));
    const customL1 = used.filter(v => !L1_PRESETS.includes(v)).sort();
    const l2vals = Array.from(new Set(rows.map(r => (r.L2 || '').trim()).filter(Boolean))).sort();
    const m = document.createElement('div');
    m.id = 'stCatModal';
    m.innerHTML = `
      <div class="stcat-box">
        <h3>Enter L1 / L2 — <span class="n">${sel.length}</span> checked row(s)</h3>
        <label>L1 category
          <select id="stCatL1">
            <option value="__keep__">— leave unchanged —</option>
            ${L1_PRESETS.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('')}
            ${customL1.length ? `<optgroup label="already in use">${customL1.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('')}</optgroup>` : ''}
            <option value="__new__">other… (type a new category)</option>
          </select>
        </label>
        <input type="text" id="stCatL1New" placeholder="new L1 category name" style="display:none">
        <label>L2 sub-category <span class="hint">(blank = leave unchanged · e.g. MyPhotos1 · YouTube → channel/author)</span>
          <input type="text" id="stCatL2" list="stCatL2List" placeholder="L2 value" autocomplete="off">
          <datalist id="stCatL2List">${l2vals.map(v => `<option value="${esc(v)}"></option>`).join('')}</datalist>
        </label>
        <label class="ckrow"><input type="checkbox" id="stCatClearL2"> clear L2 (set blank) instead of leaving it unchanged</label>
        <label class="ckrow"><input type="checkbox" id="stCatAuthor"> also set Author = L2 (handy for YouTube channels)</label>
        <div class="stcat-btns">
          <button id="stCatCancel">Cancel</button>
          <button id="stCatApply" class="primary">Apply to ${sel.length} row(s)</button>
        </div>
      </div>`;
    document.getElementById('stOverlay').appendChild(m);
    const q = id => m.querySelector('#' + id);
    q('stCatL1').addEventListener('change', e => {
      const isNew = e.target.value === '__new__';
      q('stCatL1New').style.display = isNew ? 'block' : 'none';
      if (isNew) q('stCatL1New').focus();
    });
    q('stCatCancel').addEventListener('click', () => m.remove());
    m.addEventListener('mousedown', e => { if (e.target === m) m.remove(); });   // click backdrop = cancel
    q('stCatApply').addEventListener('click', () => {
      let l1 = q('stCatL1').value;
      if (l1 === '__new__') l1 = q('stCatL1New').value.trim();
      const l1set = !!l1 && l1 !== '__keep__';
      const clearL2 = q('stCatClearL2').checked;
      const l2raw = q('stCatL2').value.trim();
      const l2set = clearL2 || l2raw !== '';
      const alsoAuthor = q('stCatAuthor').checked;
      if (!l1set && !l2set) { stToast('Nothing to set — pick an L1 or type an L2.', 2200); return; }
      applyCat(sel.map(r => r.id), l1set ? l1 : null, l2set ? (clearL2 ? '' : l2raw) : null, alsoAuthor);
      m.remove();
    });
    q('stCatL1').focus();
  }

  // Write L1 (and/or L2, and/or Author) onto the given rows, then refresh facets + filter.
  function applyCat(ids, l1, l2, alsoAuthor) {
    const idSet = new Set(ids);
    let n = 0;
    rows.forEach(r => {
      if (!idSet.has(r.id)) return;
      const patch = { id: r.id };
      if (l1 != null) { r.L1 = l1; patch.L1 = l1; }
      if (l2 != null) { r.L2 = l2; patch.L2 = l2; if (alsoAuthor) { r.VidAuthor = l2; patch.VidAuthor = l2; } }
      if (table) { try { table.updateData([patch]); } catch (_) {} }
      n++;
    });
    markDirty(); persist(false);
    refreshL1L2Options();
    applyFilters();
    stToast(`🏷 Set ${l1 != null ? ('L1=“' + l1 + '” ') : ''}${l2 != null ? ('L2=“' + (l2 || '(blank)') + '” ') : ''}on ${n} row(s).`, 2800);
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
      const mlRow = toMlRow(r, stamp);   // shared shape (also used by the `a` hotkey)
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
    if (!confirm(`Delete ${sel.length} row(s) from the staging store?\n(ml.json is NOT affected — they move to sdeleted.json so they won’t re-import.)`)) return;
    const removed = sel.map(r => r.getData());
    const ids = new Set(removed.map(r => r.id));
    rows = rows.filter(r => !ids.has(r.id));
    sel.forEach(r => table.deleteRow(r.getData().id));
    archiveDeleted(removed);          // → sdeleted.json (bulk archive, no per-row undo)
    markDirty(); persist(false);
    refreshL1L2Options();
    applyFilters();
    stToast(`🗑 Deleted ${ids.size} row(s) → sdeleted.json`, 2200);
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

  // (dev0450) Load the deleted-links archive (sdeleted.json) into the dedup set so
  // imports skip anything the user already threw away. Best-effort: a missing file
  // (nothing deleted yet) just means an empty set.
  async function loadDeletedLinks() {
    try {
      const r = await fetch('sdeleted.json?t=' + Date.now());
      const arc = r.ok ? await r.json() : [];
      deletedLinks = new Set((Array.isArray(arc) ? arc : []).map(x => normLink(x && x.link)).filter(Boolean));
    } catch (_) { deletedLinks = new Set(); }
  }

  // ── Load ──────────────────────────────────────────────────────────────────────
  async function loadData() {
    try {
      const r = await fetch(STORE_URL());
      rows = r.ok ? (await r.json()) : [];
      if (!Array.isArray(rows)) rows = [];
    } catch (e) { rows = []; }
    await loadDeletedLinks();   // refresh the deleted-links dedup set alongside s.json
    // Backfill ids / types for any hand-edited or legacy rows.
    rows.forEach(r => {
      if (!r.id) r.id = mkId();
      if (!r.type) r.type = urlType(r.link);
      if (!r.status) r.status = 'new';
      if (r.L2 == null) r.L2 = '';                                   // (dev0451)
      if (r.L1 == null || r.L1 === '') r.L1 = deriveL1(r.link);      // (dev0451) backfill obvious sources
    });
    dirty = false;
    focusId = null;             // stale ids from the old data set are gone; reconcile re-picks
    if (table) {
      try { await table.setData(rows); } catch (_) {}
      applyFilters();           // applyFilters → reconcileFocus picks the first visible row
    }
    refreshL1L2Options();       // (dev0451) rebuild the L1/L2 facet dropdowns from the fresh data
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
    previewTeardown();             // stop any playing preview video (no bg buffering)
    document.getElementById('stOverlay')?.classList.remove('open');
  }
  function isStScreenOpen() {
    return document.getElementById('stOverlay')?.classList.contains('open') || false;
  }

  // In-window key handling. Capture-phase; core.js's dispatcher bails on w/f/a/d
  // while St is open so they reach us here (mirrors the Ig f/c arrangement), and
  // its T-table arrow/Delete handler bails entirely while St is open.
  //   ↑/↓ → move the focused (previewed) row.
  //   Delete / d → delete the focused row (→ in-session trash).
  //   a   → add the focused link to ml.json (T) + remove it from staging.
  //   e   → fill Res / Size / Len on the checked rows (or the focused row).
  //   Ctrl+Z → undo the last Delete / Add.
  //   w   → import from clipboard.
  //   f   → focus the search box.   Shift+F → clear the text search.
  //   Esc → leave the search box (filter stays); else leave the screen.
  window.addEventListener('keydown', e => {
    if (!isStScreenOpen()) return;
    const ae = document.activeElement;
    const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);

    // (dev0451) While the L1/L2 bulk dialog is open it OWNS the keyboard (its own
    // inputs/selects handle typing); Esc closes just the dialog, not the screen.
    const catModal = document.getElementById('stCatModal');
    if (catModal) {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); catModal.remove(); }
      else if (e.key === 'Enter' && !typing) { e.stopPropagation(); e.preventDefault(); catModal.querySelector('#stCatApply')?.click(); }
      return;
    }

    // Ctrl/⌘+Z — undo the last Delete/Add (only when not typing, so native
    // text-undo still works inside the search box / a cell editor).
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
        && (e.key === 'z' || e.key === 'Z') && !typing) {
      e.stopPropagation(); e.preventDefault();
      undo();
      return;
    }

    if (e.key === 'Escape') {
      if (typing) { ae.blur(); e.stopPropagation(); e.preventDefault(); return; }
      e.stopPropagation(); e.preventDefault();
      closeStScreen();
      if (typeof window._executeHotkey === 'function') window._executeHotkey('t');   // leave → T
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;

    // ↑/↓ — move the focused (previewed) row instead of scrolling the page.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.stopPropagation(); e.preventDefault();
      moveFocus(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    // Delete or d — remove the focused row (reversible with Ctrl+Z).
    if (e.key === 'Delete' || e.key === 'd') {
      e.stopPropagation(); e.preventDefault();
      deleteFocused();
      return;
    }
    // a — add the focused link to ml.json (T) and remove it from staging.
    if (e.key === 'a') {
      e.stopPropagation(); e.preventDefault();
      addFocusedToT();
      return;
    }
    // e — fill Res / Size / Len on the checked rows (or the focused row).
    if (e.key === 'e') {
      e.stopPropagation(); e.preventDefault();
      fillMetaSelected();
      return;
    }
    // c — open the L1/L2 bulk dialog for the checked rows.
    if (e.key === 'c') {
      e.stopPropagation(); e.preventDefault();
      openCatModal();
      return;
    }

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
