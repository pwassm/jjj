// ══════════════════════════════════════════════════════════════════════════════
// X SCREEN — image + video SEARCH-RESULTS staging table for x.json (dev0521)
// ══════════════════════════════════════════════════════════════════════════════
// A standalone, dev-only screen that holds raw SEARCH RESULTS harvested by the two
// desktop finders (linkfinders/imagefinder.py, linkfinders/videofinder.py) in
// x.json — a store PARALLEL to ml.json and to the S/St bulk store, kept SEPARATE
// because search hits arrive from a very wide range of sources (Flickr / Wikimedia /
// DuckDuckGo / YouTube / Vimeo / the user's own o.json …) and want their own
// provenance columns (which search Query produced them, from which Source).
//
// Image and video results co-live in ONE store with a `kind` marker (image|video)
// so the table can be sorted / faceted by kind; a finer `type` (jpg/yt/vimeo/video)
// rides along for the grid/V dispatcher and the Promote → ml.json copy.
//
// Data flow: each finder AUTO-POSTs its results to the proxy (POST /x/import) after a
// search; this screen reads x.json (GET) and writes edits back (POST /x/save). The
// finders keep their own Download button as a secondary action. Clipboard import (w)
// stays as a manual fallback.
//
// The table BODY is Tabulator (lazy-loaded on first open — dev-only, 442 KB). It's a
// close sibling of s.js (St); shared idioms (floating preview, promote, delete-archive,
// facet dropdowns, shift-range select) are adapted rather than reinvented.
//
// Hotkey: X (dev-only, blocked in user mode like T/S/I/O). While X is on top:
//   w → import links from the clipboard   ·   f → focus the search box
//   ↑/↓ → move the focused (previewed) row · Delete/d → delete focused · a → add→ml.json
//   e → fill Res/Size/Len · c → set Source/Query on checked rows · Ctrl+I → toggle preview
//   Esc → leave the search box (filter stays), else leave the screen (→ T)
//
// Globals borrowed from core.js (same realm — classic <script> tags share scope):
//   toast, isoNow, nextUID, data, save, _isUserMode, HELP_VERSION_STR
(function () {
  'use strict';

  const PROXY = 'http://127.0.0.1:8081';
  const STORE_URL = () => 'x.json?t=' + Date.now();

  // ── State ────────────────────────────────────────────────────────────────
  let rows = [];                 // the live x.json array (mutated in place)
  let table = null;              // the Tabulator instance
  let searchText = '';           // free-text search box
  let kindFilter = 'all';        // kind dropdown (all/image/video/other)
  let statusFilter = 'all';      // status dropdown (all/new/promoted)
  let sourceFilter = 'all';      // Source facet (all / Flickr / Wikimedia / … / __blank__)
  let queryFilter = 'all';       // Query facet (all / <keyword> / … / __blank__)
  let previewEnabled = true;     // Ctrl+I toggles the floating preview window on/off
  // Most-recently-used Query values (most-recent first), persisted, so the Query
  // facet + datalist list the searches you ran most recently at the top.
  let queryMru = (() => { try { const a = JSON.parse(localStorage.getItem('x-query-mru') || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; } })();
  function pushQueryMru(v) {
    v = String(v || '').trim();
    if (!v) return;
    queryMru = [v, ...queryMru.filter(x => x !== v)].slice(0, 60);
    try { localStorage.setItem('x-query-mru', JSON.stringify(queryMru)); } catch (_) {}
  }
  let dirty = false;             // unsaved edits (edit/import/promote/delete)
  let saveTimer = null;          // debounce for autosave after inline edits
  let focusId = null;            // id of the single FOCUSED row (drives the preview + arrow nav)
  const PV_HOST = 'x-pv-host';   // preview media host id — videos register under this key in seeLearnVideoPlayers
  const undoStack = [];          // in-session trash for Delete/a — reversible via Ctrl+Z
  // Normalized links of rows previously deleted from x.json (archived to xdeleted.json
  // by the proxy). Import dedups against this too, so a link the user already threw away
  // isn't re-staged from a re-run search or a re-pasted clipboard list.
  let deletedLinks = new Set();
  let _pvPlayer = null;          // handle to the preview video player (for ←/→ seek + duration)
  let _pvDurationSecs = 0;       // last-known duration of the previewed video (seconds)
  const SEEK_STEP = 5;           // ←/→ seek amount (seconds)

  // ── Helpers ────────────────────────────────────────────────────────────────
  const esc = s => String(s == null ? '' : s).replace(/[<>&"]/g,
    c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const now = () => (typeof isoNow === 'function') ? isoNow()
    : new Date().toISOString().slice(0, 19).replace('T', ' ');

  let _idSeq = 0;
  const mkId = () => 'x' + Date.now().toString(36) + (_idSeq++).toString(36);

  const IMG_RE = /\.(jpe?g|png|gif|webp|avif|bmp|svg|tiff?)(\?|#|$)/i;
  // Media type from the URL — same buckets the grid/V dispatcher understands.
  function urlType(u) {
    u = String(u || '');
    if (/youtube\.com|youtu\.be/i.test(u)) return 'yt';
    if (/vimeo\.com/i.test(u)) return 'vimeo';
    if (IMG_RE.test(u)) return 'jpg';
    if (/\.(mp4|webm|mov|m4v|mkv)(\?|#|$)/i.test(u)) return 'video';
    return 'other';
  }
  // The image/video split the user faceted on. Derived from type (and the URL as a
  // fallback for `other`). Anything not clearly image or video is 'other'.
  function kindOf(type, link) {
    if (type === 'jpg' || IMG_RE.test(String(link || ''))) return 'image';
    if (type === 'yt' || type === 'vimeo' || type === 'video') return 'video';
    return 'other';
  }
  // Landscape / Portrait from a "W×H" resolution string ('' if unknown).
  function aspectOf(res) {
    const m = String(res || '').match(/(\d+)\s*[×x*]\s*(\d+)/);
    if (!m) return '';
    return (+m[1] >= +m[2]) ? 'L' : 'P';
  }
  // (dev0535) Canonical URL form for storage in ml.json — collapse the many YouTube
  // spellings to youtu.be/ID and strip Vimeo's ?turnstile= junk. Mirrors core.js
  // _normalizeLink so a promoted row's link matches the app's canonical spelling.
  function canonUrl(link) {
    const s = String(link || '').trim();
    if (!s) return s;
    if (window.getYouTubeId) { const id = window.getYouTubeId(s); if (id) return 'https://youtu.be/' + id; }
    if (/vimeo\.com\/\d+/i.test(s) && window.sanitizeVimeoUrl) return window.sanitizeVimeoUrl(s);
    return s;
  }
  // (dev0535) Best Mode letter (L/P/S) from what we already know: /shorts/ → P, a known
  // resolution → orientFromDims, else the aspect column, else blank (the yt-dlp Fill meta
  // 'e' pass or the T-screen orientation batch fills the rest).
  function modeForRow(r) {
    const link = String((r && r.link) || '');
    if (/youtube\.com\/shorts\//i.test(link)) return 'P';
    const m = String((r && r.resolution) || '').match(/(\d+)\s*[×x*]\s*(\d+)/);
    if (m && window.orientFromDims) { const o = window.orientFromDims(+m[1], +m[2]); if (o) return o; }
    if (r && (r.aspect === 'L' || r.aspect === 'P')) return r.aspect;
    return '';
  }
  // (dev0535) yt-dlp upload_date "YYYYMMDD" (or unix timestamp) → "YYYY-MM-DD" (mirrors ig.js).
  function datePosted(meta) {
    if (!meta) return '';
    const ud = String(meta.upload_date || '').trim();
    if (/^\d{8}$/.test(ud)) return ud.slice(0, 4) + '-' + ud.slice(4, 6) + '-' + ud.slice(6, 8);
    if (Number.isFinite(meta.timestamp)) return new Date(meta.timestamp * 1000).toISOString().slice(0, 10);
    return '';
  }
  // Source category (which search engine / site the hit came from). Derived from the
  // URL only where unambiguous — the finders send the real source_name on import; this
  // just backfills obvious cases for hand-edited / clipboard rows.
  function deriveSource(u) {
    u = String(u || '');
    if (/youtube\.com|youtu\.be/i.test(u)) return 'YouTube';
    if (/vimeo\.com/i.test(u)) return 'Vimeo';
    if (/flickr\.com|staticflickr\.com/i.test(u)) return 'Flickr';
    if (/wikimedia\.org|wikipedia\.org/i.test(u)) return 'Wikimedia';
    return '';
  }
  const SOURCE_PRESETS = ['Flickr', 'Wikimedia', 'YouTube', 'Vimeo', 'o.json'];

  // The page where the media is actually SHOWN (for the clickable Attribution cell).
  // The finders put the source page in `attribution` (image page_url / video channel);
  // otherwise we reconstruct it for the two big image hosts whose `link` is a raw file:
  //   Flickr static → the photo page via Flickr's id-redirect
  //   Wikimedia upload → the File: description page on Commons
  function sourcePageUrl(r) {
    const a = String((r && r.attribution) || '').trim();
    if (/^https?:\/\//i.test(a)) return a;
    for (const f of ['page_url', 'pageUrl', 'sourceUrl', 'srcPage', 'page']) {
      const v = r && r[f];
      if (v && /^https?:\/\//i.test(String(v))) return String(v);
    }
    const link = String((r && r.link) || '');
    let m = link.match(/staticflickr\.com\/\d+\/(\d+)_/i);
    if (m) return 'https://www.flickr.com/photo.gne?id=' + m[1];
    m = link.match(/upload\.wikimedia\.org\/wikipedia\/[^/]+\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/?#]+\.(?:jpe?g|png|gif|webp|svg|tiff?))/i);
    if (m) return 'https://commons.wikimedia.org/wiki/File:' + m[1];
    return '';
  }
  const prettyUrl = u => String(u || '').replace(/^https?:\/\/(www\.)?/i, '').replace(/\/+$/, '');
  // Display text for the Attribution cell: the raw value, or the derived page if blank.
  function attrLabel(r) {
    const v = String((r && r.attribution) || '').trim();
    if (v) return /^https?:\/\//i.test(v) ? prettyUrl(v) : v;
    const p = sourcePageUrl(r);
    return p ? prettyUrl(p) : '';
  }

  // ── Finder search (dev0523) — run imagefinder.py / videofinder.py headless via the
  // proxy /x/search route (source toggles live HERE, sent per-search). The finder
  // POSTs all hits at the end via /x/import; we poll x.json and reload once. These two
  // source lists MUST mirror ALL_IMAGE_SOURCES / ALL_VIDEO_SOURCES in the finders. ──
  // Dropped from the offered sources because they return curated hits that ignore the
  // search keyword: 'photomacro' (Photomacrography forum), 'featured' (prizewinning
  // slice of o.json), and 'ojson' (whole-page scrape of the user's saved o.json pages).
  // Paste a photomacrography.net URL to still harvest that forum on demand.
  const X_IMG_SOURCES = ['bing', 'google', 'ddgs', 'flickr', 'wikimedia', 'openverse'];
  const X_VID_SOURCES = ['youtube', 'vimeo', 'ddgs'];
  const X_IMG_DEFAULT = ['bing', 'google', 'ddgs', 'wikimedia', 'openverse'];  // the finder's own default web set
  const X_VID_DEFAULT = ['youtube', 'vimeo', 'ddgs'];
  const FINDER_CFG_KEY = 'x-finder-cfg';
  function loadFinderCfg() {
    let c = {};
    try { c = JSON.parse(localStorage.getItem(FINDER_CFG_KEY) || '{}') || {}; } catch (_) { c = {}; }
    const m = parseInt(c.max, 10);
    return {
      img: Array.isArray(c.img) ? c.img.filter(s => X_IMG_SOURCES.includes(s)) : X_IMG_DEFAULT.slice(),
      vid: Array.isArray(c.vid) ? c.vid.filter(s => X_VID_SOURCES.includes(s)) : X_VID_DEFAULT.slice(),
      safe: c.safe !== false,
      max: (Number.isFinite(m) && m > 0) ? Math.min(200, m) : 40,
      allowStock: !!c.allowStock, allowTikTok: !!c.allowTikTok, deep: !!c.deep,
      showBrowser: !!c.showBrowser,
      lastKind: c.lastKind === 'video' ? 'video' : 'image'
    };
  }
  let finderCfg = loadFinderCfg();
  function saveFinderCfg() { try { localStorage.setItem(FINDER_CFG_KEY, JSON.stringify(finderCfg)); } catch (_) {} }
  let _searching = false, _pollTimer = null;

  function normDur(d) {
    d = String(d || '').trim();
    if (!d) return '';
    if (d.includes(':')) return d;
    const n = parseInt(d, 10);
    if (!Number.isFinite(n) || n <= 0) return '';
    const m = Math.floor(n / 60), s = n % 60;
    return m + ':' + String(s).padStart(2, '0');
  }
  const normLink = u => String(u || '').trim().replace(/\/+$/, '');
  // A dedup key that collapses the many URL spellings of the SAME video to one key —
  // youtu.be/ID · youtube.com/watch?v=ID · /shorts/ID · /embed/ID all map to yt:ID, and
  // every vimeo.com/ID form to vimeo:ID. Non-video links keep their (query-preserving)
  // normLink so signed image-CDN URLs aren't wrongly merged. Used everywhere we dedup,
  // so DuckDuckGo's re-finds of a YouTube hit collapse into the direct hit.
  function canonLink(u) {
    const s = String(u || '').trim();
    if (!s) return '';
    if (window.getYouTubeId) { const id = window.getYouTubeId(s); if (id) return 'yt:' + id; }
    const vm = s.match(/vimeo\.com\/(?:video\/)?(\d+)/i);
    if (vm) return 'vimeo:' + vm[1];
    return normLink(s);
  }
  // Bare hostname (no scheme / www) for labelling a source when nothing better is known.
  function hostLabel(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return ''; } }

  // Numeric sort keys for the Res / Size / Len columns (their cell values are display
  // strings). Parse to a comparable number; unparseable / blank → 0.
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

  // ── Centered toast ABOVE the overlay ─────────────────────────────────────────
  function xToast(msg, ms) {
    let t = document.getElementById('xToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'xToast';
      (document.getElementById('xOverlay') || document.body).appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._tid);
    t._tid = setTimeout(() => t.classList.remove('show'), ms || 2400);
    if (typeof console !== 'undefined') console.log('[x]', msg);
  }

  // ── Clipboard parser (manual fallback — the finders auto-POST via /x/import) ──
  // Handles the finders' "=====NNN block" export plus plain bare-URL lists. Returns
  // partial rows {type,link,VidTitle,VidAuthor,attribution,vidLength,resolution} —
  // id/kind/source/query/status/dates are stamped by importRows().
  const isUrl = s => /^https?:\/\/\S+$/i.test(String(s || '').trim());
  const RES_RE = /^(?:res(?:olution)?\s*[:=]\s*)?(\d+)\s*[x×*]\s*(\d+)$/i;
  const AUTH_RE = /^(?:by|author|channel|uploader|creator|credit)\s*[:=]\s*(.+)$/i;
  const DUR_RE = /^(?:len(?:gth)?|dur(?:ation)?)\s*[:=]\s*(.+)$/i;
  const BARE_DUR_RE = /^\d{1,2}:\d{2}(?::\d{2})?$/;

  function parseSeparatedBlocks(text) {
    const blocks = String(text || '').replace(/\r/g, '').split(/^={3,}.*$/m);
    const out = [];
    for (const block of blocks) {
      const lines = block.split('\n').map(s => s.trim()).filter(Boolean);
      const urls = lines.filter(isUrl);
      if (!urls.length) continue;
      const r = { type: urlType(urls[0]), link: urls[0] };
      if (urls.length > 1) r.attribution = urls[1];
      for (const l of lines) {
        if (isUrl(l)) continue;
        let m;
        if ((m = l.match(RES_RE)))  { if (!r.resolution) r.resolution = m[1] + '×' + m[2]; continue; }
        if ((m = l.match(AUTH_RE))) { if (!r.VidAuthor)  r.VidAuthor  = m[1].trim();       continue; }
        if ((m = l.match(DUR_RE)))  { if (!r.vidLength)  r.vidLength  = normDur(m[1]);     continue; }
        if (BARE_DUR_RE.test(l))    { if (!r.vidLength)  r.vidLength  = normDur(l);        continue; }
        if (!r.VidTitle) r.VidTitle = l;
      }
      out.push(r);
    }
    return out;
  }

  function parseClipboard(text) {
    if (/^={3,}/m.test(String(text || ''))) return parseSeparatedBlocks(text);
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line.includes('\t')) {
        const f = line.split('\t');
        const url = f.find(isUrl);
        if (url) {
          const title = f[f.length - 1] !== url ? f[f.length - 1].trim() : '';
          out.push({ type: urlType(url), link: url, VidTitle: title });
          continue;
        }
      }
      if (line.includes('~') && isUrl(line.split('~')[0].trim())) {
        const p = line.split('~');
        const url = p[0].trim();
        out.push({ type: urlType(url), link: url, VidTitle: (p[1] || '').trim(), vidLength: normDur(p[2] || '') });
        continue;
      }
      if (isUrl(line)) {
        const url = line;
        const r = { type: urlType(url), link: url };
        const next = (lines[i + 1] || '').trim();
        if (next && !isUrl(next) && !next.includes('\t')) { r.attribution = next; i++; }
        out.push(r);
        continue;
      }
    }
    return out;
  }

  // Add parsed rows to the store, deduped by normalized link against x.json, ml.json,
  // and the deleted-links archive.
  function importRows(parsed) {
    const haveX = new Set(rows.map(r => canonLink(r.link)));
    const haveMl = new Set((typeof data !== 'undefined' && Array.isArray(data)
      ? data.map(r => canonLink(r && r.link)) : []));
    let added = 0, dupX = 0, dupMl = 0, dupDel = 0;
    const stamp = now();
    const fresh = [];
    for (const p of parsed) {
      const key = canonLink(p.link);
      if (!key) continue;
      if (haveX.has(key)) { dupX++; continue; }
      if (haveMl.has(key)) { dupMl++; continue; }
      if (deletedLinks.has(key)) { dupDel++; continue; }
      haveX.add(key);
      const type = p.type || urlType(p.link);
      const row = Object.assign({
        id: mkId(), kind: kindOf(type, p.link), type, link: '',
        source: deriveSource(p.link), query: '',
        VidTitle: '', VidAuthor: '', attribution: '', vidLength: '', resolution: '',
        size: '', comment: '', tags: [], status: 'new', VidDate: '', DateAdded: stamp
      }, p);
      row.type = type;
      row.kind = kindOf(type, row.link);
      if (!row.source) row.source = deriveSource(row.link);
      rows.push(row);
      fresh.push(row);
      added++;
    }
    if (added) {
      if (table) {
        table.addData(fresh, false);
        try { table.selectRow(fresh.map(r => r.id)); } catch (_) {}
      }
      markDirty();
      persist(false);
      refreshFacetOptions();
    }
    updateCount();
    return { added, dupX, dupMl, dupDel, total: parsed.length };
  }

  async function importFromClipboard() {
    let text = '';
    try { text = await navigator.clipboard.readText(); }
    catch (e) { xToast('✗ Clipboard read blocked.\nClick inside the page first, or allow clipboard permission.', 3800); return; }
    if (!text.trim()) { xToast('Clipboard is empty.', 1800); return; }
    const parsed = parseClipboard(text);
    if (!parsed.length) { xToast('No links found in the clipboard text.', 2400); return; }
    const r = importRows(parsed);
    xToast(`📋 Imported ${r.added} new link(s)`
      + (r.added ? '\n✓ checked the new rows — press c to set Source/Query' : '')
      + ((r.dupX || r.dupMl || r.dupDel)
        ? `\n(skipped ${r.dupX} already-staged · ${r.dupMl} already in ml.json · ${r.dupDel} previously deleted)` : ''), 4200);
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

  // ── CSS (scoped under #xOverlay, injected once) ──────────────────────────────
  function injectCss() {
    if (document.getElementById('x-css')) return;
    const s = document.createElement('style');
    s.id = 'x-css';
    s.textContent = `
#xOverlay{position:fixed;inset:0;z-index:29500;display:none;flex-direction:column;
  background:#11151c;color:#dfe6ee;font:13px/1.4 system-ui,Segoe UI,sans-serif}
#xOverlay.open{display:flex}
#xBar{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#0c0f14;
  border-bottom:1px solid #232b36;flex:0 0 auto;flex-wrap:wrap}
#xBar h2{margin:0;font-size:15px;font-weight:700;color:#9ad}
#xBar .ct{color:#fff;font-size:16px;font-weight:700}
#xBar input[type=text]{background:#1a212b;border:1px solid #2c3645;color:#dfe6ee;
  border-radius:6px;padding:5px 8px;width:220px;font:14px system-ui}
#xBar select{background:#1a212b;border:1px solid #2c3645;color:#dfe6ee;border-radius:6px;padding:5px 7px;font:14px system-ui}
#xBar button{background:#1f2733;border:1px solid #34404f;color:#cfe;border-radius:6px;
  padding:5px 10px;cursor:pointer;font:600 12px system-ui}
#xBar button:hover{background:#27313f}
#xBar button.primary{background:#0a84ff;border-color:#0a84ff;color:#fff}
#xBar button.danger{background:#7a2230;border-color:#b3344a;color:#fff}
#xBar button:disabled{opacity:.5;cursor:default}
#xBar .spacer{flex:1}
#xBar #xClose{font-size:18px;padding:2px 10px;line-height:1}
#xWrap{flex:1;overflow:hidden;position:relative}
#xTable{height:100%}
#xEmpty{position:absolute;inset:0;display:none;align-items:center;justify-content:center;
  text-align:center;color:#7d8794;padding:40px;pointer-events:none}
#xToast{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) scale(.96);
  background:#10151d;color:#eaf1f8;border:1px solid #34404f;border-radius:12px;
  padding:16px 26px;font:14px/1.5 system-ui,Segoe UI,sans-serif;text-align:center;
  white-space:pre-line;max-width:560px;box-shadow:0 14px 50px rgba(0,0,0,.65);
  z-index:40000;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s}
#xToast.show{opacity:1;transform:translate(-50%,-50%) scale(1)}
.x-badge{display:inline-block;padding:1px 7px;border-radius:4px;font-size:11px;font-weight:700}
.t-jpg{background:#1e3a4a;color:#7fd0ee}.t-yt{background:#4a2330;color:#ff9bb0}
.t-vimeo{background:#23414a;color:#7fe0d0}.t-video{background:#2a3a52;color:#9ab6ff}.t-other{background:#333;color:#aaa}
.k-image{background:#1e4a2e;color:#8fe6a6}.k-video{background:#3a2a52;color:#c6a6ff}.k-other{background:#333;color:#aaa}
.x-asp{font-weight:700}.x-asp-L{color:#8fd0ee}.x-asp-P{color:#f2b48a}
.x-stat-new{color:#7d8794}.x-stat-promoted{color:#6fb6ff;font-weight:700}
#xTable .x-thumb{width:100%;height:38px;object-fit:cover;border-radius:3px;background:#0a1018;display:block}
#xTable .x-thumb-none{display:flex;align-items:center;justify-content:center;height:38px;color:#4a90d0;font-size:16px}
#xTable .tabulator-cell a{color:#7fb8ff;text-decoration:none}
#xTable .tabulator-cell a:hover{text-decoration:underline}
/* Homogenize the UNFOCUSED rows (kill the odd/even grey stripe) so the FOCUSED row
   clearly stands out — one flat backdrop, a bright band + cyan bar for the focus. */
#xTable .tabulator-row{background:#141a22 !important}
#xTable .tabulator-row.tabulator-selected{background:#1a3149 !important}
#xTable .tabulator-row.tabulator-selectable:hover{background-color:#1b2532 !important;cursor:pointer}
#xTable .tabulator-row.x-focus,
#xTable .tabulator-row.x-focus.tabulator-selected,
#xTable .tabulator-row.x-focus:hover{background:#28598a !important;box-shadow:inset 4px 0 0 #6cf;color:#f2f7ff}
#xTable .tabulator-row.x-focus .tabulator-cell{background:transparent !important}
#xTable .x-attr-go{color:#7fd0ee;text-decoration:none;font-weight:700;margin-right:3px}
#xTable .x-attr-go:hover{text-decoration:underline}
#xPreview{position:fixed;width:640px;height:460px;z-index:30200;
  background:#000;border:1px solid #4df;border-radius:8px;overflow:hidden;display:none;
  flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.72);
  resize:both;min-width:320px;min-height:230px;max-width:96vw;max-height:92vh}
#xPreview.show{display:flex}
#xPreview:focus{outline:none}
#xPvDrag{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:10px;
  cursor:move;user-select:none;padding:4px 9px;background:#0a1426;border-bottom:1px solid #1a2a4a;
  font:11px/1.3 system-ui;color:#9ad;touch-action:none}
#xPvDrag .h{font-weight:700}
#xPvDrag .hint{color:#5b6b86;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#x-pv-host{position:relative;flex:1 1 auto;background:#000;overflow:hidden}
#xPvCap{flex:0 0 auto;max-height:62px;overflow:hidden;padding:5px 9px;background:#0a1426;
  border-top:1px solid #1a2a4a;font:11px/1.4 monospace;color:#bcd}
#xCatModal{position:fixed;inset:0;z-index:40500;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.55)}
#xCatModal .xcat-box{background:#141a23;border:1px solid #34404f;border-radius:12px;padding:18px 22px;
  width:min(440px,92vw);box-shadow:0 20px 70px rgba(0,0,0,.7)}
#xCatModal h3{margin:0 0 12px;font-size:15px;color:#9ad;font-weight:700}
#xCatModal h3 .n{color:#fff}
#xCatModal label{display:block;margin:13px 0 4px;font-size:12px;color:#bcd}
#xCatModal .hint{color:#6b7a8d;font-weight:400}
#xCatModal select,#xCatModal input[type=text]{width:100%;box-sizing:border-box;background:#1a212b;
  border:1px solid #2c3645;color:#dfe6ee;border-radius:6px;padding:7px 9px;font:13px system-ui;margin-top:2px}
#xCatModal .xcat-btns{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
#xCatModal button{background:#1f2733;border:1px solid #34404f;color:#cfe;border-radius:6px;
  padding:7px 14px;cursor:pointer;font:600 12px system-ui}
#xCatModal button.primary{background:#0a84ff;border-color:#0a84ff;color:#fff}
#xCatModal button:hover{filter:brightness(1.15)}
#xSearchBar{display:flex;align-items:center;gap:6px 10px;flex-wrap:wrap;padding:6px 12px;
  background:#0e1620;border-bottom:1px solid #232b36;flex:0 0 auto}
#xSearchBar .lbl{font-weight:700;color:#7fd0ee}
#xSearchBar input[type=text]{background:#1a212b;border:1px solid #2c3645;color:#dfe6ee;
  border-radius:6px;padding:5px 8px;width:240px;font:14px system-ui}
#xSearchBar .grp{display:flex;align-items:center;gap:4px;flex-wrap:wrap;
  padding:2px 6px;border:1px solid #202a36;border-radius:8px;background:#0c131c}
#xSearchBar .gl{font-size:11px;color:#8aa6c2;font-weight:700;margin-right:2px}
#xSearchBar .opts{display:flex;align-items:center;gap:10px}
#xSearchBar .mx{font-size:12px;color:#bcd;display:flex;align-items:center;gap:4px}
#xSearchBar .mx input{width:56px;background:#1a212b;border:1px solid #2c3645;color:#dfe6ee;
  border-radius:6px;padding:4px 6px;font:13px system-ui}
#xSearchBar button{background:#1f2733;border:1px solid #34404f;color:#cfe;border-radius:6px;
  padding:5px 11px;cursor:pointer;font:600 12px system-ui}
#xSearchBar button.primary{background:#0a84ff;border-color:#0a84ff;color:#fff}
#xSearchBar button:hover{filter:brightness(1.12)}
#xSearchBar button:disabled{opacity:.5;cursor:default}
.xchip{display:inline-flex;align-items:center;gap:3px;font-size:12px;color:#cdd8e4;
  padding:2px 6px;border-radius:5px;cursor:pointer;user-select:none}
.xchip:hover{background:#182231}
.xchip input{margin:0;cursor:pointer}
.xchip.adv{color:#c6a06a}
#xSearchStatus{font-size:12px;color:#9ad;display:none;align-items:center;gap:6px}
#xSearchStatus.on{display:inline-flex}
.xspin{width:13px;height:13px;border:2px solid #2b3a4d;border-top-color:#4df;border-radius:50%;
  display:inline-block;animation:xspin .8s linear infinite}
@keyframes xspin{to{transform:rotate(360deg)}}
`;
    document.head.appendChild(s);
  }

  // ── DOM scaffold ─────────────────────────────────────────────────────────────
  function build() {
    injectCss();
    if (document.getElementById('xOverlay')) return;
    const o = document.createElement('div');
    o.id = 'xOverlay';
    o.innerHTML = `
      <div id="xBar">
        <h2>X · search results</h2>
        <span class="ct" id="xCount"></span>
        <input type="text" id="xSearch" placeholder="search link / title / author / query…  (press f)">
        <select id="xKind">
          <option value="all">all kinds</option>
          <option value="image">🖼 image</option>
          <option value="video">🎬 video</option>
          <option value="other">other</option>
        </select>
        <select id="xStatus">
          <option value="all">all status</option>
          <option value="new">new</option>
          <option value="promoted">promoted</option>
        </select>
        <select id="xSource" title="Filter by Source (which search engine / site)"><option value="all">all sources</option></select>
        <select id="xQuery" title="Filter by the search Query that produced the row"><option value="all">all queries</option></select>
        <div class="spacer"></div>
        <button id="xImport" class="primary" title="Import links from the clipboard (hotkey w) — finders also auto-send via /x/import">📋 Import clipboard</button>
        <button id="xCat" title="Set Source / Query on the CHECKED rows in bulk.&#10;Hotkey c.">🏷 Source/Query</button>
        <button id="xFillMeta" title="Fill Res / Size / Len / Date on the CHECKED rows (or the focused row if none checked).&#10;Images &amp; direct videos are probed in-browser; YouTube/Vimeo use yt-dlp (dims + upload Date) via the proxy.&#10;Hotkey e.">📐 Fill meta</button>
        <button id="xPromote" title="Copy CHECKED rows into ml.json, keep them here as 'promoted' (stamped BA=1).&#10;Hotkey a = add the FOCUSED row to ml.json AND remove it from staging (Ctrl+Z undo).">➕ Promote sel</button>
        <button id="xDelete" class="danger" title="Remove CHECKED rows from the search store → xdeleted.json (won't re-import).&#10;Hotkey Delete or d = remove the FOCUSED row (Ctrl+Z undo).">🗑 Delete sel</button>
        <button id="xDeleteNoArc" class="danger" title="Remove CHECKED rows WITHOUT archiving to xdeleted.json — they are NOT remembered, so a re-run search CAN re-stage them.">🗑 Delete ¬xDel</button>
        <button id="xDelInMl" class="danger" title="Delete every staged row whose media is ALREADY in ml.json — matched by CANONICAL link, so a non-canonical x.json link still matches ml.json's youtu.be form.&#10;ml.json is NOT touched; the removed rows move to xdeleted.json so they won't re-import.">🗑 Del in ml</button>
        <button id="xReload" title="Reload x.json from disk (do this after running a finder search)">↻ Reload</button>
        <button id="xSave" title="Write edits back to x.json">💾 Save</button>
        <button id="xClose" title="Close (Esc / T)">×</button>
      </div>
      <div id="xSearchBar">
        <span class="lbl">🔎 Finder</span>
        <input type="text" id="xQ" list="xQList" autocomplete="off"
          placeholder="query, or a page URL to scrape…  (Enter = repeat last)"
          title="Run a live finder search. Ticked sources are sent per-search; results auto-stage to x.json and the table reloads when they land.">
        <datalist id="xQList"></datalist>
        <span class="grp">
          <span class="gl">🖼 image</span>
          ${srcChips('img', X_IMG_SOURCES, finderCfg.img)}
          <label class="xchip adv" title="Don't block stock/watermark domains (alamy/pixabay etc.)"><input type="checkbox" id="xAllowStock"${finderCfg.allowStock ? ' checked' : ''}>+stock</label>
          <button id="xRunImg" class="primary" title="Run imagefinder.py --search over the ticked image sources (hotkey: Enter in the query box repeats the last kind).">Search images</button>
        </span>
        <span class="grp">
          <span class="gl">🎬 video</span>
          ${srcChips('vid', X_VID_SOURCES, finderCfg.vid)}
          <label class="xchip adv" title="Deeper (slower) Vimeo harvest"><input type="checkbox" id="xDeep"${finderCfg.deep ? ' checked' : ''}>deep</label>
          <label class="xchip adv" title="Don't block TikTok links"><input type="checkbox" id="xAllowTikTok"${finderCfg.allowTikTok ? ' checked' : ''}>+tiktok</label>
          <button id="xRunVid" class="primary" title="Run videofinder.py --search over the ticked video sources.">Search videos</button>
        </span>
        <span class="opts">
          <label class="xchip" title="SafeSearch on the finders that support it"><input type="checkbox" id="xSafe"${finderCfg.safe ? ' checked' : ''}>safe</label>
          <label class="xchip adv" title="Run a VISIBLE browser so you can solve Google's captcha once — the persistent profile then unblocks later headless Google/Bing runs. Also used for the Vimeo harvest."><input type="checkbox" id="xShowBrowser"${finderCfg.showBrowser ? ' checked' : ''}>show browser</label>
          <label class="mx" title="Max results PER SOURCE (the total scales with how many sources you tick)">max <input type="number" id="xMax" min="1" max="200" value="${esc(String(finderCfg.max))}"></label>
        </span>
        <span id="xSearchStatus"></span>
      </div>
      <div id="xWrap">
        <div id="xTable"></div>
        <div id="xEmpty"></div>
      </div>
      <div id="xPreview" tabindex="-1" title="Preview of the focused row (↑/↓ move focus · ←/→ seek video · Ctrl+I hide · Ctrl+↓ delete · a add to T)">
        <div id="xPvDrag"><span class="h">▣ Preview</span><span class="hint">↑↓ rows · ←→ seek · drag to move · drag corner to resize · dbl-click = recentre</span></div>
        <div id="${PV_HOST}"></div>
        <div id="xPvCap"></div>
      </div>`;
    document.body.appendChild(o);

    const $ = id => o.querySelector('#' + id);
    $('xSearch').addEventListener('input', e => { searchText = e.target.value.trim().toLowerCase(); applyFilters(); });
    $('xKind').addEventListener('change', e => { kindFilter = e.target.value; applyFilters(); });
    $('xStatus').addEventListener('change', e => { statusFilter = e.target.value; applyFilters(); });
    $('xSource').addEventListener('change', e => {
      sourceFilter = e.target.value;
      queryFilter = 'all';          // choosing a Source resets Query → All and rescopes the Query list
      refreshFacetOptions();
      applyFilters();
    });
    $('xQuery').addEventListener('change', e => { queryFilter = e.target.value; applyFilters(); });
    $('xImport').addEventListener('click', () => importFromClipboard());
    $('xCat').addEventListener('click', () => openCatModal());
    $('xFillMeta').addEventListener('click', () => fillMetaSelected());
    $('xPromote').addEventListener('click', () => promoteSelected());
    $('xDelete').addEventListener('click', () => deleteSelected(true));
    $('xDeleteNoArc').addEventListener('click', () => deleteSelected(false));
    $('xDelInMl').addEventListener('click', () => deleteAlreadyInMl());
    $('xReload').addEventListener('click', () => loadData());
    $('xSave').addEventListener('click', () => persist(true));
    $('xClose').addEventListener('click', () => closeXScreen());

    // ── Finder search bar (dev0523) — persist the source/opt picks, run on click ──
    const persistPicks = () => {
      finderCfg.img = collectGroup('img');
      finderCfg.vid = collectGroup('vid');
      finderCfg.safe = !!$('xSafe').checked;
      finderCfg.allowStock = !!$('xAllowStock').checked;
      finderCfg.allowTikTok = !!$('xAllowTikTok').checked;
      finderCfg.deep = !!$('xDeep').checked;
      finderCfg.showBrowser = !!$('xShowBrowser').checked;
      const m = parseInt($('xMax').value, 10);
      if (Number.isFinite(m) && m > 0) finderCfg.max = Math.min(200, m);
      saveFinderCfg();
    };
    o.querySelectorAll('#xSearchBar input').forEach(el => el.addEventListener('change', persistPicks));
    $('xRunImg').addEventListener('click', () => runFinderSearch('image'));
    $('xRunVid').addEventListener('click', () => runFinderSearch('video'));
    $('xQ').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); runFinderSearch(finderCfg.lastKind || 'image'); }
    });
    refreshQDatalist();

    applyPvBox();
    wirePreviewDrag();
    wireFocusGuard();
  }

  // When you click into the (cross-origin) YouTube/Vimeo preview iframe it steals
  // keyboard focus, so our window keydown handler stops seeing ↑/↓ · ←/→ · Ctrl+I ·
  // Ctrl+↓. Bounce focus back to the preview panel a beat after the iframe grabs it —
  // the click (play / seek-bar) still lands, then the keyboard keeps working without
  // having to click a row first. (Own ←/→ replaces the player's native key-seek.)
  let _pvGuardWired = false;
  function wireFocusGuard() {
    if (_pvGuardWired) return;
    _pvGuardWired = true;
    window.addEventListener('blur', () => {
      if (!isXScreenOpen() || !previewEnabled) return;
      const host = document.getElementById(PV_HOST);
      const ae = document.activeElement;
      if (!host || !ae || ae.tagName !== 'IFRAME' || !host.contains(ae)) return;
      setTimeout(() => {
        if (!isXScreenOpen()) return;
        const a2 = document.activeElement, h2 = document.getElementById(PV_HOST);
        if (h2 && a2 && a2.tagName === 'IFRAME' && h2.contains(a2)) {
          try { document.getElementById('xPreview')?.focus({ preventScroll: true }); } catch (_) {}
        }
      }, 300);
    }, true);
  }

  // Render the per-kind source checkboxes for the finder search bar.
  function srcChips(grp, all, checked) {
    return all.map(s =>
      `<label class="xchip"><input type="checkbox" data-grp="${grp}" data-src="${esc(s)}"${checked.includes(s) ? ' checked' : ''}>${esc(s)}</label>`
    ).join('');
  }
  function collectGroup(grp) {
    const o = document.getElementById('xOverlay');
    if (!o) return [];
    return [...o.querySelectorAll(`#xSearchBar input[data-grp="${grp}"]:checked`)].map(el => el.getAttribute('data-src'));
  }
  function refreshQDatalist() {
    const dl = document.getElementById('xQList');
    if (dl) dl.innerHTML = queryMru.slice(0, 40).map(v => `<option value="${esc(v)}"></option>`).join('');
  }

  window.addEventListener('resize', () => { if (isXScreenOpen()) applyPvBox(); });

  // ── Tabulator columns ────────────────────────────────────────────────────────
  function columns() {
    const kindBadge = c => {
      const k = c.getValue() || 'other';
      return `<span class="x-badge k-${esc(k)}">${esc(k)}</span>`;
    };
    const typeBadge = c => {
      const t = c.getValue() || 'other';
      return `<span class="x-badge t-${esc(t)}">${esc(t)}</span>`;
    };
    const thumbCell = c => {
      const r = c.getData();
      const link = r.link || '';
      if (r.kind === 'image' || IMG_RE.test(link))
        return `<img class="x-thumb" loading="lazy" src="${esc(link)}" onerror="this.style.opacity=.2">`;
      return `<div class="x-thumb-none">${r.kind === 'video' ? '▶' : '·'}</div>`;
    };
    const linkCell = c => {
      const u = c.getValue() || '';
      return u ? `<a href="${esc(u)}" target="_blank" rel="noopener" title="${esc(u)}">${esc(u)}</a>` : '';
    };
    const aspCell = c => {
      const a = aspectOf(c.getData().resolution);
      return a ? `<span class="x-asp x-asp-${a}">${a}</span>` : '';
    };
    const attrCell = c => {
      const r = c.getData();
      const page = sourcePageUrl(r);
      const label = attrLabel(r);
      // (dev0535) Compact: the cell is just a ↗ link (full page in the tooltip) so the
      // column can be a few characters wide — the freed width went to the new Date column.
      // Click still opens the source page in a new tab AND focuses the row.
      if (page) return `<a class="x-attr-go" href="${esc(page)}" target="_blank" rel="noopener" title="Open where it's shown → ${esc(page)}">↗</a>`;
      return `<span title="${esc(label)}">${esc(label.slice(0, 6))}</span>`;
    };
    const statusCell = c => {
      const s = c.getValue() || 'new';
      return `<span class="x-stat-${esc(s)}">${esc(s)}</span>`;
    };
    const tagsCell = c => {
      const v = c.getValue();
      return Array.isArray(v) ? v.join(', ') : (v || '');
    };
    // Column order: the media (thumb/Link/Title/Author/Attribution) + measurements
    // on the LEFT; the provenance facets (Kind/Type/Query/Source) pushed to the FAR
    // RIGHT per request (they're also faceted from the toolbar dropdowns).
    return [
      { formatter: 'rowSelection', titleFormatter: 'rowSelection', hozAlign: 'center', headerSort: false, width: 40, frozen: true },
      { title: '▣', field: 'thumb', width: 56, formatter: thumbCell, headerSort: false, headerTooltip: 'Thumbnail (image rows) — full preview is the floating window (Ctrl+I)' },
      { title: 'Link', field: 'link', widthGrow: 3, formatter: linkCell, headerFilter: 'input' },
      { title: 'Title', field: 'VidTitle', widthGrow: 2, editor: 'input', headerFilter: 'input' },
      { title: 'Author', field: 'VidAuthor', width: 120, editor: 'input', headerFilter: 'input' },
      { title: '↗', field: 'attribution', width: 44, formatter: attrCell, headerSort: false,
        headerTooltip: 'Attribution — click ↗ to open where the media is shown (Flickr photo page / Wikimedia file page / channel). Compacted (dev0535) to make room for Date.' },
      { title: 'Date', field: 'VidDate', width: 100, editor: 'input', hozAlign: 'right',
        headerTooltip: 'Video upload/publish date (YYYY-MM-DD) — filled by 📐 Fill meta (yt-dlp) for YouTube/Vimeo · carried into ml.json on promote.' },
      { title: 'Len', field: 'vidLength', width: 58, editor: 'input', hozAlign: 'right',
        sorter: (a, b) => lenSecs(a) - lenSecs(b),
        headerTooltip: 'Length (m:ss) — auto-filled for video by 📐 Fill meta' },
      { title: 'Res', field: 'resolution', width: 92, editor: 'input', hozAlign: 'right',
        sorter: (a, b) => resPixels(a) - resPixels(b),
        headerTooltip: 'Resolution (W×H) — auto-filled by 📐 Fill meta · sorts by pixel count' },
      { title: 'A', field: 'aspect', width: 44, formatter: aspCell, hozAlign: 'center', headerSort: false,
        headerTooltip: 'Aspect — L (landscape) / P (portrait), from the resolution' },
      { title: 'Size', field: 'size', width: 72, editor: 'input', hozAlign: 'right',
        sorter: (a, b) => sizeBytes(a) - sizeBytes(b),
        headerTooltip: 'File size — auto-filled for images & direct video by 📐 Fill meta · sorts by bytes' },
      { title: 'Tags', field: 'tags', width: 120, formatter: tagsCell, editor: 'input',
        mutatorEdit: v => String(v || '').split(',').map(s => s.trim()).filter(Boolean) },
      { title: 'Status', field: 'status', width: 86, formatter: statusCell },
      { title: 'Added', field: 'DateAdded', width: 148, hozAlign: 'right' },
      { title: 'Kind', field: 'kind', width: 76, formatter: kindBadge, headerFilter: false,
        headerTooltip: 'image / video — the primary split (facet in the toolbar)' },
      { title: 'Type', field: 'type', width: 74, formatter: typeBadge, headerFilter: false },
      { title: 'Query', field: 'query', width: 130, editor: 'input', headerFilter: 'input',
        headerTooltip: 'The search keyword that produced this hit (set by the finder; editable).' },
      { title: 'Source', field: 'source', width: 110, editor: 'input', headerFilter: 'input',
        headerTooltip: 'Which search source/site the hit came from (Flickr / Wikimedia / YouTube / Vimeo / o.json …).' }
    ];
  }

  function buildTable() {
    table = new window.Tabulator('#xTable', {
      data: rows,
      index: 'id',
      columns: columns(),
      layout: 'fitColumns',
      height: '100%',
      selectableRows: true,
      placeholder: '',
      reactiveData: false,
      movableColumns: true,
      rowFormatter: row => {
        row.getElement().classList.toggle('x-focus', row.getData().id === focusId);
      }
    });
    table.on('cellEdited', cell => {
      markDirty(); scheduleSave();
      const f = cell && cell.getField && cell.getField();
      if (f === 'query') pushQueryMru(cell.getValue());
      if (f === 'source' || f === 'query') refreshFacetOptions();
    });
    table.on('rowSelectionChanged', () => updateCount());
    table.on('rowClick', (e, row) => setFocus(row.getData().id, { scroll: false }));
    table.on('tableBuilt', () => { applyFilters(); updateCount(); reconcileFocus(); wireRangeSelect(); });
  }

  // ── Shift-click range selection over the checkboxes ──────────────────────────
  let _selAnchorId = null;
  function wireRangeSelect() {
    const wrap = document.getElementById('xTable');
    if (!wrap || wrap._rangeWired) return;
    wrap._rangeWired = true;
    wrap.addEventListener('click', e => {
      const cb = e.target;
      if (!table || !cb || cb.tagName !== 'INPUT' || cb.type !== 'checkbox') return;
      const rowEl = cb.closest('.tabulator-row');
      if (!rowEl) { _selAnchorId = null; return; }
      const act = table.getRows('active');
      const comp = act.find(r => r.getElement() === rowEl);
      if (!comp) return;
      const id = comp.getData().id;
      const i1 = e.shiftKey && _selAnchorId ? act.findIndex(r => r.getData().id === _selAnchorId) : -1;
      const i2 = i1 >= 0 ? act.findIndex(r => r.getData().id === id) : -1;
      if (i1 >= 0 && i2 >= 0) {
        e.preventDefault();
        const lo = Math.min(i1, i2), hi = Math.max(i1, i2);
        try { table.selectRow(act.slice(lo, hi + 1)); } catch (_) {}
      } else {
        _selAnchorId = id;
      }
    }, true);
  }

  // ── Focus + floating preview ─────────────────────────────────────────────────
  const activeRowComps = () => (table ? table.getRows('active') : []);

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
        // 'top' + scrollIfVisible=false: an already-visible focused row doesn't scroll
        // (smooth intra-page ↑/↓); when it goes off the edge, snap it as high as
        // possible (near the list end Tabulator clamps → highest it can reach).
        if (r) { try { const p = r.scrollTo('top', false); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
      }
    }
    refreshPreview();
    scheduleAutoProbe(focusId);
  }

  function reconcileFocus() {
    const act = activeRowComps();
    if (!act.length) { setFocus(null); return; }
    if (!focusId || !act.some(r => r.getData().id === focusId)) setFocus(act[0].getData().id);
  }

  function moveFocus(delta) {
    const act = activeRowComps();
    if (!act.length) return;
    const n = act.length;
    let idx = act.findIndex(r => r.getData().id === focusId);
    if (idx < 0) idx = delta > 0 ? -1 : 0;
    // Wrap around: past the bottom row comes back to the top (and vice-versa).
    const ni = ((idx + delta) % n + n) % n;
    setFocus(act[ni].getData().id);
  }

  function focusNeighborId() {
    const act = activeRowComps();
    const i = act.findIndex(r => r.getData().id === focusId);
    if (i < 0) return act.length ? act[0].getData().id : null;
    const n = act[i + 1] || act[i - 1];
    return n ? n.getData().id : null;
  }

  function togglePreviewEnabled() {
    previewEnabled = !previewEnabled;
    if (previewEnabled) { refreshPreview(); xToast('👁 Preview ON (Ctrl+I)', 1200); }
    else { previewTeardown(); xToast('🚫 Preview OFF (Ctrl+I)', 1200); }
  }

  function refreshPreview() {
    const pv = document.getElementById('xPreview');
    const host = document.getElementById(PV_HOST);
    if (!pv || !host) return;
    if (!previewEnabled) { previewTeardown(); return; }
    _pvDestroyPlayer();
    if (window.stopCellVideoLoop) { try { window.stopCellVideoLoop(PV_HOST); } catch (_) {} }
    host.innerHTML = '';
    const row = focusId ? rows.find(r => r.id === focusId) : null;
    if (!row || !row.link) { pv.classList.remove('show'); return; }
    pv.classList.add('show');
    applyPvBox();
    fillPreviewHost(host, row);
    fillPreviewCaption(row);
  }

  function fillPreviewHost(host, row) {
    const link = row.link || '';
    const isVid = window.isVideoRow ? window.isVideoRow(row) : false;
    const isImg = IMG_RE.test(link);
    const id = row.id;
    if (isVid) {
      // Full scrubbable player WITH a seek bar AND a real player handle, so ←/→ can
      // seek and we can read the duration for the caption. Falls back to TikTok/IG.
      if (mountPreviewVideo(host, row)) return;
      setTimeout(() => {
        if (focusId !== id || !document.getElementById('xPreview')) return;
        if (window.isTikTokLink && window.isTikTokLink(link) && window.mountTikTokEmbed)
          window.mountTikTokEmbed(host, link);
        else if (window.isInstagramLink && window.isInstagramLink(link) && window.mountInstagramEmbed)
          window.mountInstagramEmbed(host, link);
      }, 60);
      return;
    }
    if (isImg) { _pvImg(host, link); return; }
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

  // ── Preview video players (real handles → ←/→ seek + duration readout) ────────
  // Reuses the app's own YT/Vimeo API loaders (video.js). Muted so autoplay is
  // allowed; controls:1 keeps the visible seek bar. The handle is kept in _pvPlayer
  // (NOT the seeLearnVideoPlayers registry) and torn down on focus change / close.
  function _pvDestroyPlayer() {
    const p = _pvPlayer; _pvPlayer = null; _pvDurationSecs = 0;
    if (p && p.destroy) { try { p.destroy(); } catch (_) {} }
  }
  function mountPreviewVideo(host, row) {
    const link = row.link || '';
    if (window.isYouTubeLink && window.isYouTubeLink(link) && window.getYouTubeId && window.getYouTubeId(link)) {
      _pvMountYT(host, row, window.getYouTubeId(link)); return true;
    }
    if (window.isVimeoLink && window.isVimeoLink(link)) { _pvMountVimeo(host, row); return true; }
    if (window.isDirectVideoLink && window.isDirectVideoLink(link)) { _pvMountDirect(host, row); return true; }
    return false;
  }
  async function _pvMountYT(host, row, vid) {
    const id = row.id;
    if (typeof window.loadYouTubeApiOnce !== 'function') return;
    try { await window.loadYouTubeApiOnce(); } catch (_) { return; }
    if (focusId !== id || !document.getElementById('xPreview')) return;
    host.innerHTML = '';
    const div = document.createElement('div');
    div.style.cssText = 'position:absolute;inset:0;';
    host.appendChild(div);
    let p;
    try {
      p = new window.YT.Player(div, {
        videoId: vid, width: '100%', height: '100%',
        playerVars: { autoplay: 1, mute: 1, controls: 1, rel: 0, playsinline: 1, modestbranding: 1 },
        events: {
          onReady: e => {
            try { const f = e.target.getIframe(); if (f) f.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;'; } catch (_) {}
            try { e.target.playVideo(); } catch (_) {}
            try { _pvOnDuration(id, e.target.getDuration()); } catch (_) {}
          }
        }
      });
    } catch (_) { return; }
    _pvPlayer = {
      kind: 'yt', obj: p,
      seek: d => { try { const t = p.getCurrentTime() || 0; p.seekTo(Math.max(0, t + d), true); } catch (_) {} },
      destroy: () => { try { p.destroy(); } catch (_) {} }
    };
  }
  async function _pvMountVimeo(host, row) {
    const id = row.id, link = row.link || '';
    if (typeof window.loadVimeoApiOnce !== 'function') return;
    try { await window.loadVimeoApiOnce(); } catch (_) { return; }
    if (focusId !== id || !document.getElementById('xPreview')) return;
    const norm = window.sanitizeVimeoUrl ? window.sanitizeVimeoUrl(link) : link;
    const m = String(norm).match(/vimeo\.com\/(\d+)/);
    if (!m) return;
    host.innerHTML = '';
    const div = document.createElement('div');
    div.style.cssText = 'position:absolute;inset:0;';
    host.appendChild(div);
    const hm = String(norm).match(/[?&]h=([A-Za-z0-9]+)/);
    const opts = { id: +m[1], autoplay: true, muted: true, controls: true, responsive: false, width: host.clientWidth || 640 };
    if (hm) opts.h = hm[1];
    let p;
    try { p = new window.Vimeo.Player(div, opts); } catch (_) { return; }
    try { if (p.element) p.element.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;'; } catch (_) {}
    try { p.getDuration().then(d => _pvOnDuration(id, d)).catch(() => {}); } catch (_) {}
    _pvPlayer = {
      kind: 'vimeo', obj: p,
      seek: d => { try { p.getCurrentTime().then(t => p.setCurrentTime(Math.max(0, (t || 0) + d))).catch(() => {}); } catch (_) {} },
      destroy: () => { try { p.destroy(); } catch (_) {} }
    };
  }
  function _pvMountDirect(host, row) {
    const id = row.id, link = row.link || '';
    host.innerHTML = '';
    const v = document.createElement('video');
    v.src = link; v.controls = true; v.autoplay = true; v.muted = true; v.playsInline = true;
    v.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;';
    v.addEventListener('loadedmetadata', () => { if (Number.isFinite(v.duration)) _pvOnDuration(id, v.duration); });
    host.appendChild(v);
    _pvPlayer = {
      kind: 'video', obj: v,
      seek: d => { try { v.currentTime = Math.max(0, (v.currentTime || 0) + d); } catch (_) {} },
      destroy: () => { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) {} }
    };
  }
  // Player reported a duration → cache it, backfill the row's Len if empty, refresh caption.
  function _pvOnDuration(id, secs) {
    if (id !== focusId) return;
    secs = Math.round(+secs);
    if (!Number.isFinite(secs) || secs <= 0) return;
    _pvDurationSecs = secs;
    const row = rows.find(r => r.id === id);
    if (row && !String(row.vidLength || '').trim()) {
      row.vidLength = fmtSecs(secs);
      if (table) { try { table.updateData([{ id, vidLength: row.vidLength }]); } catch (_) {} }
      markDirty(); scheduleSave();
    }
    if (row) fillPreviewCaption(row);
  }
  // ←/→ seek the previewed video (no-op for images / TikTok / IG).
  function seekPreview(delta) {
    if (!previewEnabled || !_pvPlayer || !_pvPlayer.seek) return false;
    _pvPlayer.seek(delta);
    return true;
  }
  function fillPreviewCaption(row) {
    const cap = document.getElementById('xPvCap');
    if (!cap) return;
    const k = row.kind || 'other';
    const title = (row.VidTitle || '').trim();
    const author = (row.VidAuthor || '').trim();
    const prov = [row.query, row.source].filter(Boolean).join(' · ');
    // Dimensions (images) + length (videos), from the row or a just-loaded player.
    const dims = String(row.resolution || '').trim();
    const len = String(row.vidLength || '').trim()
      || (_pvDurationSecs ? fmtSecs(_pvDurationSecs) : '');
    const date = String(row.VidDate || '').trim();
    const meta = [];
    if (dims) meta.push('📐 ' + dims);
    if (len) meta.push('⏱ ' + len);
    if (date) meta.push('📅 ' + date);
    cap.innerHTML = `<span class="x-badge k-${esc(k)}">${esc(k)}</span> `
      + (title ? `<span style="color:#cfe;">${esc(title)}</span>` : '')
      + (author ? ` <span style="color:#d8c69a;">· ${esc(author)}</span>` : '')
      + (meta.length ? ` <span style="color:#9fe0b6;">· ${esc(meta.join('  '))}</span>` : '')
      + (prov ? ` <span style="color:#8aa6c2;">· ${esc(prov)}</span>` : '')
      + `<div style="color:#7fb8ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;">${esc(row.link || '')}</div>`;
  }
  function previewTeardown() {
    _pvDestroyPlayer();
    if (window.stopCellVideoLoop) { try { window.stopCellVideoLoop(PV_HOST); } catch (_) {} }
    const host = document.getElementById(PV_HOST);
    if (host) host.innerHTML = '';
    document.getElementById('xPreview')?.classList.remove('show');
  }

  // ── Preview window geometry (draggable + remembered) ─────────────────────────
  const PV_BOX_KEY = 'x-preview-box';
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
    const pv = document.getElementById('xPreview');
    if (!pv) return;
    pvBox = clampBox(pvBox || loadPvBox() || defaultPvBox());
    pv.style.left = pvBox.left + 'px'; pv.style.top = pvBox.top + 'px';
    pv.style.right = 'auto'; pv.style.bottom = 'auto';
    pv.style.width = pvBox.width + 'px'; pv.style.height = pvBox.height + 'px';
  }
  function savePvBox() { try { localStorage.setItem(PV_BOX_KEY, JSON.stringify(pvBox)); } catch (_) {} }

  function wirePreviewDrag() {
    const pv = document.getElementById('xPreview');
    const bar = document.getElementById('xPvDrag');
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
    bar.addEventListener('dblclick', () => { pvBox = defaultPvBox(); applyPvBox(); savePvBox(); });
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
  function applyMetaPatch(row, patch) {
    const keys = Object.keys(patch).filter(k => patch[k] && patch[k] !== row[k]);
    if (!keys.length) return false;
    keys.forEach(k => { row[k] = patch[k]; });
    if (patch.resolution) { const a = aspectOf(patch.resolution); if (a) row.aspect = a; }
    if (table) { try { table.updateData([Object.assign({ id: row.id }, patch)]); table.getRow(row.id)?.reformat(); } catch (_) {} }
    markDirty(); scheduleSave();
    return true;
  }
  async function probeRowMeta(row, opts) {
    opts = opts || {};
    const link = row && row.link;
    if (!link) return false;
    const isImg = IMG_RE.test(link) || row.type === 'jpg';
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
          if (opts.force || !row.VidDate) { const d = datePosted(meta); if (d) patch.VidDate = d; }
        }
      } else { return false; }
    } catch (_) { /* leave existing values */ }
    return applyMetaPatch(row, patch);
  }

  let _autoProbeTimer = null;
  function scheduleAutoProbe(id) {
    clearTimeout(_autoProbeTimer);
    _autoProbeTimer = setTimeout(() => {
      if (id !== focusId) return;
      const row = rows.find(r => r.id === id);
      if (!row || !row.link) return;
      const isImg = IMG_RE.test(row.link) || row.type === 'jpg';
      const isDirect = window.isDirectVideoLink && window.isDirectVideoLink(row.link);
      if ((isImg && !row.resolution) || (isDirect && (!row.resolution || !row.vidLength)) ||
          ((isImg || isDirect) && !row.size))
        probeRowMeta(row, {});
    }, 320);
  }

  let _fillingMeta = false;
  async function fillMetaSelected() {
    if (!table || _fillingMeta) return;
    let targets = selectedRowData();
    if (!targets.length && focusId) { const r = rows.find(x => x.id === focusId); if (r) targets = [r]; }
    if (!targets.length) { xToast('Check some rows (or focus one) first — then 📐 Fill meta.', 2600); return; }
    const ytN = targets.filter(r => {
      const l = r.link || '';
      return (window.isYouTubeLink && window.isYouTubeLink(l)) || (window.isVimeoLink && window.isVimeoLink(l));
    }).length;
    if (ytN > 6 && !confirm(`Fill meta on ${targets.length} row(s)?\n${ytN} are YouTube/Vimeo and use yt-dlp (one at a time — can be slow).`)) return;
    _fillingMeta = true;
    let done = 0, filled = 0;
    for (const t of targets) {
      xToast(`📐 Filling meta…  ${++done}/${targets.length}`, 60000);
      const live = rows.find(x => x.id === t.id) || t;
      try { if (await probeRowMeta(live, { force: true, useYtdlp: true })) filled++; } catch (_) {}
    }
    _fillingMeta = false;
    persist(false);
    xToast(`📐 Filled meta on ${filled} of ${targets.length} row(s).`, 3000);
  }

  // ── Focused-row actions (Delete / Add), reversible via Ctrl+Z ─────────────────
  // Build the ml.json row a search row promotes to (shared by `a` and Promote sel).
  // Source → L1 and Query → L2 (ml.json already carries L1/L2 from the St pipeline),
  // so the search provenance survives the promote.
  function toMlRow(r, stamp) {
    return {
      UID: nextUID(),
      link: canonUrl(r.link), VidTitle: r.VidTitle || '', VidAuthor: r.VidAuthor || '',
      attribution: r.attribution || '', vidLength: r.vidLength || '',
      comment: r.comment || '', resolution: r.resolution || '',
      Mode: modeForRow(r), VidDate: r.VidDate || '',
      tags: Array.isArray(r.tags) ? r.tags : [], ltype: r.type || '',
      L1: r.source || '', L2: r.query || '',
      BA: '1', show: '1', DateAdded: stamp, DateModified: stamp, xSource: r.id
    };
  }

  function archiveDeleted(removed) {
    const arr = (Array.isArray(removed) ? removed : [removed]).filter(Boolean);
    if (!arr.length) return;
    arr.forEach(r => { const k = canonLink(r.link); if (k) deletedLinks.add(k); });
    fetch(PROXY + '/x/deleted', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: arr })
    }).catch(() => xToast('⚠ couldn’t archive to xdeleted.json (proxy dev0521+?)', 2600));
  }
  function unarchiveDeleted(rowsArr) {
    const arr = (Array.isArray(rowsArr) ? rowsArr : [rowsArr]).filter(Boolean);
    if (!arr.length) return;
    arr.forEach(r => { const k = canonLink(r.link); if (k) deletedLinks.delete(k); });
    fetch(PROXY + '/x/undelete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: arr.map(r => r.id) })
    }).catch(() => {});
  }

  function deleteFocused() {
    if (!focusId) { xToast('No focused row — click a row or use ↑/↓ first.', 1800); return; }
    const id = focusId;
    const idx = rows.findIndex(r => r.id === id);
    if (idx < 0) return;
    const removed = rows[idx];
    const nextId = focusNeighborId();
    rows.splice(idx, 1);
    if (table) { try { table.deleteRow(id); } catch (_) {} }
    undoStack.push({ kind: 'delete', row: removed, pos: idx });
    archiveDeleted(removed);
    markDirty(); persist(false, { force: true });   // deliberate delete — bypass the mass-drop guard
    setFocus(nextId);
    updateCount();
    xToast('🗑 Deleted “' + (removed.VidTitle || removed.link || '').slice(0, 44) + '” — Ctrl+Z to undo', 2600);
  }

  function addFocusedToT() {
    if (!focusId) { xToast('No focused row — click a row or use ↑/↓ first.', 1800); return; }
    if (typeof data === 'undefined' || typeof nextUID !== 'function' || typeof save !== 'function') {
      xToast('ml.json not loaded — open the T screen once first, then press a.', 3200); return;
    }
    const id = focusId;
    const idx = rows.findIndex(r => r.id === id);
    if (idx < 0) return;
    const r = rows[idx];
    const mlRow = toMlRow(r, now());
    data.push(mlRow);
    save();
    const nextId = focusNeighborId();
    rows.splice(idx, 1);
    if (table) { try { table.deleteRow(id); } catch (_) {} }
    undoStack.push({ kind: 'add', row: r, pos: idx, mlUID: mlRow.UID });
    markDirty(); persist(false);
    setFocus(nextId);
    updateCount();
    xToast('➕ Added to ml.json (BA="1") + removed from staging — Ctrl+Z to undo', 2800);
  }

  function undo() {
    const a = undoStack.pop();
    if (!a) { xToast('Nothing to undo.', 1500); return; }
    if (a.kind === 'add') {
      if (typeof data !== 'undefined' && Array.isArray(data) && a.mlUID != null) {
        const di = data.findIndex(x => x && x.UID === a.mlUID);
        if (di >= 0) { data.splice(di, 1); if (typeof save === 'function') save(); }
      }
    } else if (a.kind === 'delete') {
      unarchiveDeleted(a.row);
    }
    const pos = Math.min(a.pos, rows.length);
    rows.splice(pos, 0, a.row);
    if (table) { try { table.addData([a.row]); } catch (_) {} }
    markDirty(); persist(false);
    applyFilters();
    setFocus(a.row.id);
    xToast((a.kind === 'add'
      ? '↩ Undid Add — removed from ml.json, restored to staging'
      : '↩ Restored “' + (a.row.VidTitle || a.row.link || '').slice(0, 44) + '”'), 2400);
  }

  // Combined free-text + kind + status + source + query filter.
  function applyFilters() {
    if (!table) return;
    table.setFilter(row => {
      if (kindFilter !== 'all' && (row.kind || 'other') !== kindFilter) return false;
      if (statusFilter !== 'all' && (row.status || 'new') !== statusFilter) return false;
      if (sourceFilter !== 'all') {
        const v = (row.source || '').trim();
        if (sourceFilter === '__blank__' ? v !== '' : v !== sourceFilter) return false;
      }
      if (queryFilter !== 'all') {
        const v = (row.query || '').trim();
        if (queryFilter === '__blank__' ? v !== '' : v !== queryFilter) return false;
      }
      if (searchText) {
        const hay = (row.link + ' ' + (row.VidTitle || '') + ' ' + (row.VidAuthor || '')
          + ' ' + (row.attribution || '') + ' ' + (row.query || '') + ' ' + (row.source || '')
          + ' ' + ((row.tags || []).join(' '))).toLowerCase();
        if (!hay.includes(searchText)) return false;
      }
      return true;
    });
    try {
      const activeIds = new Set(activeRowComps().map(r => r.getData().id));
      table.getSelectedRows().forEach(r => { if (!activeIds.has(r.getData().id)) r.deselect(); });
    } catch (_) {}
    updateCount();
    reconcileFocus();
  }

  // ── Source / Query facet dropdowns (distinct values + counts) ────────────────
  function refreshFacet(selId, field, getCur, setCur, opts) {
    opts = opts || {};
    const selEl = document.getElementById(selId);
    if (!selEl) return;
    const counts = {};
    let blank = 0, total = 0;
    rows.forEach(r => {
      if (opts.scope && !opts.scope(r)) return;
      total++;
      const v = (r[field] || '').trim();
      if (v) counts[v] = (counts[v] || 0) + 1; else blank++;
    });
    let vals = Object.keys(counts);
    if (opts.mru) {
      const rank = v => { const i = opts.mru.indexOf(v); return i < 0 ? 1e9 : i; };
      vals.sort((a, b) => (rank(a) - rank(b)) || (counts[b] - counts[a]) || a.localeCompare(b));
    } else {
      vals.sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
    }
    let cur = getCur();
    if (cur !== 'all' && cur !== '__blank__' && !counts[cur]) { cur = 'all'; setCur('all'); }
    if (cur === '__blank__' && !blank) { cur = 'all'; setCur('all'); }
    const blankLabel = opts.blankLabel || '— (blank) —';
    const allLabel = opts.allLabel || ('all ' + field);
    selEl.innerHTML = `<option value="all">${allLabel} (${total})</option>`
      + (blank ? `<option value="__blank__">${blankLabel} (${blank})</option>` : '')
      + vals.map(v => `<option value="${esc(v)}">${esc(v)} (${counts[v]})</option>`).join('');
    selEl.value = cur;
  }
  // Query is SCOPED to the active Source filter (recently-run searches first).
  function refreshFacetOptions() {
    refreshFacet('xSource', 'source', () => sourceFilter, v => sourceFilter = v, { allLabel: 'all sources', blankLabel: 'No source' });
    const scope = (sourceFilter === 'all') ? null : (r => {
      const v = (r.source || '').trim();
      return sourceFilter === '__blank__' ? v === '' : v === sourceFilter;
    });
    refreshFacet('xQuery', 'query', () => queryFilter, v => queryFilter = v, { scope, mru: queryMru, allLabel: 'all queries', blankLabel: 'No query' });
  }

  // ── "Set Source / Query" bulk dialog (button 🏷 · hotkey c) ───────────────────
  function selectedVisible() {
    if (!table) return [];
    const activeIds = new Set(activeRowComps().map(r => r.getData().id));
    return table.getSelectedRows().filter(r => activeIds.has(r.getData().id));
  }
  const selectedRowData = () => selectedVisible().map(r => r.getData());

  function openCatModal() {
    if (document.getElementById('xCatModal')) return;
    const sel = selectedRowData();
    if (!sel.length) { xToast('Check some rows first (checkbox column), then 🏷 Source/Query / press c.', 2800); return; }
    const used = Array.from(new Set(rows.map(r => (r.source || '').trim()).filter(Boolean)));
    const customSrc = used.filter(v => !SOURCE_PRESETS.includes(v)).sort();
    const qset = new Set(rows.map(r => (r.query || '').trim()).filter(Boolean));
    const qvals = [...queryMru.filter(v => qset.has(v)),
                   ...[...qset].filter(v => !queryMru.includes(v)).sort()];
    const m = document.createElement('div');
    m.id = 'xCatModal';
    m.innerHTML = `
      <div class="xcat-box">
        <h3>Set Source / Query — <span class="n">${sel.length}</span> checked row(s)</h3>
        <label>Source
          <select id="xCatSrc">
            <option value="__keep__">— leave unchanged —</option>
            ${SOURCE_PRESETS.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('')}
            ${customSrc.length ? `<optgroup label="already in use">${customSrc.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('')}</optgroup>` : ''}
            <option value="__new__">other… (type a new source)</option>
          </select>
        </label>
        <input type="text" id="xCatSrcNew" placeholder="new source name" style="display:none">
        <label>Query <span class="hint">(blank = leave unchanged · the search keyword)</span>
          <input type="text" id="xCatQuery" list="xCatQueryList" placeholder="search keyword" autocomplete="off">
          <datalist id="xCatQueryList">${qvals.map(v => `<option value="${esc(v)}"></option>`).join('')}</datalist>
        </label>
        <div class="xcat-btns">
          <button id="xCatCancel">Cancel</button>
          <button id="xCatApply" class="primary">Apply to ${sel.length} row(s)</button>
        </div>
      </div>`;
    document.getElementById('xOverlay').appendChild(m);
    const q = id => m.querySelector('#' + id);
    q('xCatSrc').addEventListener('change', e => {
      const isNew = e.target.value === '__new__';
      q('xCatSrcNew').style.display = isNew ? 'block' : 'none';
      if (isNew) q('xCatSrcNew').focus();
    });
    q('xCatCancel').addEventListener('click', () => m.remove());
    m.addEventListener('mousedown', e => { if (e.target === m) m.remove(); });
    q('xCatApply').addEventListener('click', () => {
      let src = q('xCatSrc').value;
      if (src === '__new__') src = q('xCatSrcNew').value.trim();
      const srcSet = !!src && src !== '__keep__';
      const qraw = q('xCatQuery').value.trim();
      const qSet = qraw !== '';
      if (!srcSet && !qSet) { xToast('Nothing to set — pick a Source or type a Query.', 2200); return; }
      applyCat(sel.map(r => r.id), srcSet ? src : null, qSet ? qraw : null);
      m.remove();
    });
    q('xCatSrc').focus();
  }

  function applyCat(ids, src, qy) {
    const idSet = new Set(ids);
    const patches = [];
    rows.forEach(r => {
      if (!idSet.has(r.id)) return;
      const patch = { id: r.id };
      if (src != null) { r.source = src; patch.source = src; }
      if (qy != null) { r.query = qy; patch.query = qy; }
      patches.push(patch);
    });
    if (table && patches.length) { try { table.updateData(patches); } catch (_) {} }
    if (qy) pushQueryMru(qy);
    markDirty(); persist(false);
    refreshFacetOptions();
    if (sourceFilter !== 'all' || queryFilter !== 'all') applyFilters();
    xToast(`🏷 Set ${src != null ? ('Source=“' + src + '” ') : ''}${qy != null ? ('Query=“' + qy + '” ') : ''}on ${patches.length} row(s).`, 2800);
  }

  function updateCount() {
    const el = document.getElementById('xCount');
    const empty = document.getElementById('xEmpty');
    const shown = table ? table.getDataCount('active') : rows.length;
    const selN = selectedVisible().length;
    const promoted = rows.filter(r => r.status === 'promoted').length;
    if (el) el.textContent = `${shown}/${rows.length} shown · ${promoted} promoted`
      + (selN ? ` · ${selN} selected` : '')
      + (dirty ? ' · ⚠ unsaved' : '');
    const sv = document.getElementById('xSave');
    if (sv) sv.classList.toggle('primary', dirty);
    if (empty) {
      if (!rows.length) { empty.style.display = 'flex'; empty.textContent = 'x.json is empty — run a search in imagefinder.py / videofinder.py (results auto-send here), then press ↻ Reload. Or copy links and press w.'; }
      else if (!shown) { empty.style.display = 'flex'; empty.textContent = 'No rows match the filter.'; }
      else empty.style.display = 'none';
    }
  }

  function markDirty() { dirty = true; updateCount(); }
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => persist(false), 1200); }

  // ── Promote → ml.json (BA="1" bulk marker) ───────────────────────────────────
  function promoteSelected() {
    if (!table) return;
    const sel = selectedRowData().filter(r => r.status !== 'promoted');
    if (!sel.length) { xToast('Select un-promoted rows first (checkbox column).', 2400); return; }
    if (typeof data === 'undefined' || typeof nextUID !== 'function' || typeof save !== 'function') {
      xToast('ml.json not loaded — open the T screen once first, then promote.', 3200); return;
    }
    if (!confirm(`Promote ${sel.length} row(s) into ml.json?\nThey become real T/G rows, stamped BA="1" (bulk-added).`)) return;
    const stamp = now();
    let ok = 0;
    for (const r of sel) {
      const mlRow = toMlRow(r, stamp);
      data.push(mlRow);
      r.status = 'promoted';
      r.mlUID = mlRow.UID;
      const live = rows.find(x => x.id === r.id);
      if (live) { live.status = 'promoted'; live.mlUID = mlRow.UID; }
      table.updateData([{ id: r.id, status: 'promoted', mlUID: mlRow.UID }]);
      ok++;
    }
    save();
    markDirty(); persist(false);
    applyFilters();
    xToast(`➕ Promoted ${ok} row(s) → ml.json (BA="1")`, 2800);
  }

  function deleteSelected(archive) {
    if (!table) return;
    archive = archive !== false;
    const sel = selectedVisible();
    if (!sel.length) { xToast('Select rows to delete first.', 2200); return; }
    const msg = archive
      ? `Delete ${sel.length} row(s) from the search store?\n(ml.json is NOT affected — they move to xdeleted.json so they won’t re-import.)`
      : `Delete ${sel.length} row(s) WITHOUT archiving?\n(ml.json is NOT affected — they are NOT remembered, so a re-run search will re-stage them.)`;
    if (!confirm(msg)) return;
    const removed = sel.map(r => r.getData());
    const ids = new Set(removed.map(r => r.id));
    rows = rows.filter(r => !ids.has(r.id));
    sel.forEach(r => table.deleteRow(r.getData().id));
    if (archive) archiveDeleted(removed);
    markDirty(); persist(false, { force: true });   // deliberate bulk delete — bypass the mass-drop guard
    refreshFacetOptions();
    applyFilters();
    xToast(`🗑 Deleted ${ids.size} row(s)` + (archive ? ' → xdeleted.json' : ' (not archived — can re-import)'), 2400);
  }

  // (dev0536) Purge staged rows whose media is ALREADY in ml.json. Matched by
  // canonLink() so a non-canonical x.json link (youtube.com/watch?v=ID) still collapses
  // to ml.json's canonical youtu.be/ID. ml.json is NOT touched — these are pure dupes;
  // they archive to xdeleted.json (like Delete sel) so a re-run search won't re-stage them.
  function deleteAlreadyInMl() {
    if (!table) return;
    if (typeof data === 'undefined' || !Array.isArray(data)) {
      xToast('ml.json not loaded — open the T screen once first, then retry.', 3200); return;
    }
    const inMl = new Set(data.map(r => canonLink(r && r.link)).filter(Boolean));
    const dupes = rows.filter(r => { const k = canonLink(r.link); return k && inMl.has(k); });
    if (!dupes.length) { xToast('✓ No staged rows are already in ml.json — nothing to purge.', 2800); return; }
    const vids = dupes.filter(r => (r.kind || '') === 'video').length;
    if (!confirm(
      `Delete ${dupes.length} staged row(s) already in ml.json`
      + (vids ? ` (${vids} video)` : '') + `?\n\n`
      + `Matched by CANONICAL link (non-canonical x.json links still match).\n`
      + `ml.json is NOT affected — they move to xdeleted.json so they won't re-import.`
    )) return;
    const ids = new Set(dupes.map(r => r.id));
    rows = rows.filter(r => !ids.has(r.id));
    dupes.forEach(r => { try { table.deleteRow(r.id); } catch (_) {} });
    // (dev0537) stamp InML=1 on the archived copy — flags "duplicate of something already
    // in ml.json (has some value)" vs a plain manual delete (junk, never reconsider), which
    // archives with no InML. ml.json/x.json rows are untouched; the flag lives in xdeleted.json.
    archiveDeleted(dupes.map(r => Object.assign({}, r, { InML: 1 })));
    markDirty(); persist(false, { force: true });   // deliberate bulk delete — bypass the mass-drop guard
    refreshFacetOptions();
    applyFilters();
    xToast(`🗑 Purged ${ids.size} row(s) already in ml.json → xdeleted.json (InML=1)`, 3000);
  }

  // ── Run a finder search (proxy /x/search → finder POSTs /x/import → poll+reload) ─
  function setSearching(on, kind, q) {
    _searching = !!on;
    const stat = document.getElementById('xSearchStatus');
    const bi = document.getElementById('xRunImg'), bv = document.getElementById('xRunVid');
    if (bi) bi.disabled = _searching;
    if (bv) bv.disabled = _searching;
    if (stat) {
      if (_searching) { stat.innerHTML = `<span class="xspin"></span> searching ${esc(kind)} for “${esc(q)}”…`; stat.classList.add('on'); }
      else { stat.textContent = ''; stat.classList.remove('on'); }
    }
  }

  async function runFinderSearch(kind) {
    if (kind !== 'image' && kind !== 'video') return;
    if (_searching) { xToast('A finder search is already running — let it finish.', 2400); return; }
    const qEl = document.getElementById('xQ');
    const q = (qEl && qEl.value || '').trim();
    if (!q) { xToast('Type a query in the 🔎 Finder box first.', 2400); if (qEl) qEl.focus(); return; }
    const grp = kind === 'image' ? 'img' : 'vid';
    const sources = collectGroup(grp);
    if (!sources.length) { xToast(`Tick at least one ${kind} source to search.`, 2600); return; }
    let max = parseInt((document.getElementById('xMax') || {}).value, 10);
    if (!Number.isFinite(max) || max < 1) max = 40;
    const safe = document.getElementById('xSafe') && document.getElementById('xSafe').checked ? 'on' : 'off';
    const showBrowser = !!(document.getElementById('xShowBrowser') || {}).checked;
    const body = { kind, query: q, sources, max, safe, showBrowser };
    if (kind === 'image') body.allowStock = !!(document.getElementById('xAllowStock') || {}).checked;
    else { body.allowTikTok = !!(document.getElementById('xAllowTikTok') || {}).checked; body.deep = !!(document.getElementById('xDeep') || {}).checked; }

    finderCfg.lastKind = kind; saveFinderCfg();
    pushQueryMru(q); refreshQDatalist();
    const baseline = rows.length;
    setSearching(true, kind, q);
    try {
      const res = await fetch(PROXY + '/x/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => null);
      if (!j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + res.status));
    } catch (e) {
      setSearching(false);
      xToast('✗ couldn’t start the search: ' + (e && e.message)
        + '\n(Restart proxy.js for dev0524; make sure python + the finders are installed and on PATH.)', 5600);
      return;
    }
    // A visible browser may pause on Google's captcha for up to ~3 min — poll longer.
    waitForResults(baseline, kind, q, showBrowser ? 190000 : 105000);
  }

  // The proxy returns as soon as the finder is spawned; the finder POSTs all its hits
  // to /x/import at the END (10–60s later). Poll x.json for a size bump, then reload once.
  function waitForResults(baseline, kind, q, capMs) {
    clearTimeout(_pollTimer);
    const deadline = Date.now() + (capMs || 105000);   // ~105s cap (search is 10–60s; allow slack)
    const tick = async () => {
      if (!_searching) return;               // cancelled (screen closed / new search)
      let n = baseline;
      try { const r = await fetch(STORE_URL()); if (r.ok) { const a = await r.json(); if (Array.isArray(a)) n = a.length; } } catch (_) {}
      if (n > baseline) { finishSearch(n - baseline, kind, q); return; }
      if (Date.now() > deadline) { finishSearch(0, kind, q); return; }
      _pollTimer = setTimeout(tick, 2500);
    };
    _pollTimer = setTimeout(tick, 3000);
  }

  async function finishSearch(added, kind, q) {
    clearTimeout(_pollTimer);
    setSearching(false);
    await loadData();
    if (added > 0) {
      // Scope the Query facet to the search just run so the fresh hits are front-and-centre.
      sourceFilter = 'all'; queryFilter = q;
      refreshFacetOptions();
      const qf = document.getElementById('xQuery'); if (qf) qf.value = q;
      applyFilters();
      xToast(`🔎 ${added} new ${kind} result(s) for “${q}” → staged in x.json`, 3800);
    } else {
      xToast(`🔎 Search finished — no NEW ${kind} results for “${q}”.\n`
        + '(Hits already in x.json or previously deleted are skipped. See the proxy console for finder notes.)', 5400);
    }
  }

  // ── Persist back to x.json (proxy /x/save) ───────────────────────────────────
  async function persist(announce, opts) {
    opts = opts || {};
    try {
      const res = await fetch(PROXY + '/x/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows, force: !!opts.force })
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j || !j.ok) {
        const msg = (j && j.error) || ('HTTP ' + res.status);
        // A refused mass-drop must NEVER be silent — otherwise the UI looks saved but
        // x.json on disk still has the "deleted" rows (they reappear on the next reload).
        if (res.status === 409 || /refus/i.test(msg))
          xToast('⚠ x.json NOT saved — ' + msg
            + '\nRestart proxy.js (dev0527+) so intentional deletes are allowed.', 6500);
        else if (announce)
          xToast('✗ save failed: ' + msg + '\n(Is proxy.js running & dev0521+?)', 4200);
        return false;
      }
      dirty = false;
      updateCount();
      if (announce) xToast('💾 saved x.json (' + j.total + ' rows)', 1800);
      return true;
    } catch (e) {
      if (announce) xToast('✗ save failed: ' + (e && e.message) + '\n(Is proxy.js running & dev0521+?)', 4200);
      return false;
    }
  }

  async function loadDeletedLinks() {
    try {
      const r = await fetch('xdeleted.json?t=' + Date.now());
      const arc = r.ok ? await r.json() : [];
      deletedLinks = new Set((Array.isArray(arc) ? arc : []).map(x => canonLink(x && x.link)).filter(Boolean));
    } catch (_) { deletedLinks = new Set(); }
  }

  // DuckDuckGo isn't the SOURCE of anything — it just re-finds YouTube/Vimeo videos
  // the direct finders also return (source arrives as "DuckDuckGo/YouTube"). Relabel
  // those rows to their real platform so the Source facet is honest.
  function relabelDdgSources() {
    let n = 0;
    rows.forEach(r => {
      if (!/duckduckgo/i.test(String(r.source || ''))) return;
      const real = deriveSource(r.link)
        || String(r.source).split('/').map(s => s.trim()).filter(s => s && !/duckduckgo/i.test(s))[0]
        || hostLabel(r.link);
      if (real && real !== r.source) { r.source = real; n++; }
    });
    return n;
  }
  // Collapse rows that are the SAME video (same YT/Vimeo id) into the first copy,
  // filling any gaps in its metadata from the duplicates. Only videos are collapsed
  // (image canonicalization keeps query params, so images are never merged here).
  function collapseVideoDupes() {
    const seen = new Map();
    const keep = [];
    let dropped = 0;
    for (const r of rows) {
      const key = canonLink(r.link);
      if (key.indexOf('yt:') === 0 || key.indexOf('vimeo:') === 0) {
        const k = seen.get(key);
        if (k) {
          ['VidTitle', 'VidAuthor', 'attribution', 'vidLength', 'resolution', 'size', 'query'].forEach(f => {
            if (!String(k[f] || '').trim() && String(r[f] || '').trim()) k[f] = r[f];
          });
          dropped++;
          continue;
        }
        seen.set(key, r);
      }
      keep.push(r);
    }
    if (dropped) rows = keep;
    return dropped;
  }

  // ── Load ──────────────────────────────────────────────────────────────────────
  async function loadData() {
    try {
      const r = await fetch(STORE_URL());
      rows = r.ok ? (await r.json()) : [];
      if (!Array.isArray(rows)) rows = [];
    } catch (e) { rows = []; }
    await loadDeletedLinks();
    // Backfill derived fields for hand-edited / finder-imported / legacy rows.
    rows.forEach(r => {
      if (!r.id) r.id = mkId();
      if (!r.type) r.type = urlType(r.link);
      if (!r.kind) r.kind = kindOf(r.type, r.link);
      if (!r.status) r.status = 'new';
      if (r.source == null || r.source === '') r.source = deriveSource(r.link);
      if (r.query == null) r.query = '';
      // Compose a resolution string from width/height if the finder sent dims but no string.
      if (!r.resolution && r.width && r.height) r.resolution = r.width + '×' + r.height;
      r.aspect = aspectOf(r.resolution);
    });
    const relabeled = relabelDdgSources();
    const merged = collapseVideoDupes();
    dirty = false;
    focusId = null;
    if (table) {
      try { await table.setData(rows); } catch (_) {}
      applyFilters();
    }
    refreshFacetOptions();
    updateCount();
    // The relabel/merge changed x.json in memory — write it back once.
    if (relabeled || merged) {
      persist(false);
      if (merged) xToast(`🧹 merged ${merged} duplicate video(s) — DuckDuckGo re-finds of YouTube/Vimeo`, 3200);
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  async function openXScreen() {
    if (typeof _isUserMode === 'function' && _isUserMode()) return;   // dev-only
    build();
    document.getElementById('xOverlay').classList.add('open');
    try { await loadTabulator(); }
    catch (e) { xToast('✗ ' + e.message, 5000); return; }
    await loadData();
    if (!table) buildTable();
  }
  function closeXScreen() {
    if (dirty) persist(false);
    if (_searching) setSearching(false);   // stop the poll spinner (the finder keeps running; reopen+↻ to see hits)
    clearTimeout(_pollTimer);
    previewTeardown();
    document.getElementById('xOverlay')?.classList.remove('open');
  }
  function isXScreenOpen() {
    return document.getElementById('xOverlay')?.classList.contains('open') || false;
  }

  // In-window key handling. Capture-phase; core.js's dispatcher bails on w/f/a/d/e/c
  // while X is open so they reach us here, and its T-table arrow/Delete handler bails
  // entirely while X is open.
  window.addEventListener('keydown', e => {
    if (!isXScreenOpen()) return;
    const ae = document.activeElement;
    const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);

    const catModal = document.getElementById('xCatModal');
    if (catModal) {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); catModal.remove(); }
      else if (e.key === 'Enter' && !typing) { e.stopPropagation(); e.preventDefault(); catModal.querySelector('#xCatApply')?.click(); }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
        && (e.key === 'z' || e.key === 'Z') && !typing) {
      e.stopPropagation(); e.preventDefault();
      undo();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
        && (e.key === 'i' || e.key === 'I') && !typing) {
      e.stopPropagation(); e.preventDefault();
      togglePreviewEnabled();
      return;
    }

    // Ctrl+↓ — permanent delete of the focused row → xdeleted.json (won't re-import;
    // that video is not allowed back into X via a re-run search). Ctrl+Z still undoes.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
        && e.key === 'ArrowDown' && !typing) {
      e.stopPropagation(); e.preventDefault();
      deleteFocused();
      return;
    }

    if (e.key === 'Escape') {
      if (typing) { ae.blur(); e.stopPropagation(); e.preventDefault(); return; }
      e.stopPropagation(); e.preventDefault();
      closeXScreen();
      if (typeof window._executeHotkey === 'function') window._executeHotkey('t');   // leave → T
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.stopPropagation(); e.preventDefault();
      moveFocus(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    // ←/→ scrub the previewed video earlier / later (no-op for images).
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.stopPropagation(); e.preventDefault();
      seekPreview(e.key === 'ArrowRight' ? SEEK_STEP : -SEEK_STEP);
      return;
    }
    if (e.key === 'Delete' || e.key === 'd') {
      e.stopPropagation(); e.preventDefault();
      deleteFocused();
      return;
    }
    if (e.key === 'a') {
      e.stopPropagation(); e.preventDefault();
      addFocusedToT();
      return;
    }
    if (e.key === 'e') {
      e.stopPropagation(); e.preventDefault();
      fillMetaSelected();
      return;
    }
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
      document.getElementById('xSearch')?.focus();
      return;
    }
    if (e.key === 'F') {
      e.stopPropagation(); e.preventDefault();
      searchText = '';
      const s = document.getElementById('xSearch'); if (s) s.value = '';
      applyFilters();
      xToast('🔎 search cleared', 1400);
      return;
    }
  }, true);

  window.openXScreen = openXScreen;
  window.closeXScreen = closeXScreen;
  window.isXScreenOpen = isXScreenOpen;
})();
