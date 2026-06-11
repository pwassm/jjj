
// ══════════════════════════════════════════════════════════════════════════════
// CTRL+ALT+G = SAVE GRID CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════
document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.altKey && (e.key === 'g' || e.key === 'G')) {
    e.preventDefault();
    e.stopPropagation();
    gridSavePrompt();
  }
}, true);

function gridSavePrompt() {
  // Create modal for grid name input
  const modal = document.createElement('div');
  modal.id = 'gridSaveModal';
  modal.style.cssText = `
    position:fixed; inset:0; z-index:35000;
    background:rgba(0,0,0,0.7); display:flex;
    align-items:center; justify-content:center;
  `;
  
  const box = document.createElement('div');
  box.style.cssText = `
    background:#1a1a2e; border:1px solid #444; border-radius:10px;
    padding:24px; min-width:320px; box-shadow:0 8px 24px rgba(0,0,0,0.5);
  `;
  
  box.innerHTML = `
    <h3 style="margin:0 0 16px; color:#8ef; font-size:16px;">Save Grid Configuration</h3>
    <label style="color:#aaa; font-size:12px;">Grid Name:</label>
    <input type="text" id="gridSaveName" value="${_gridName || ''}" style="
      width:100%; margin:8px 0 16px; padding:10px;
      background:#0a0a1a; border:1px solid #333; border-radius:6px;
      color:#fff; font-size:14px;
    " placeholder="Enter grid name..." autofocus>
    <div style="display:flex; gap:12px; justify-content:flex-end;">
      <button id="gridSaveCancel" class="tbtn" style="padding:8px 16px;">Cancel</button>
      <button id="gridSaveConfirm" class="tbtn" style="padding:8px 16px; border-color:#0f0; color:#0f0;">Save</button>
    </div>
  `;
  
  modal.appendChild(box);
  document.body.appendChild(modal);
  
  const input = document.getElementById('gridSaveName');
  input.focus();
  input.select();
  
  const close = () => modal.remove();
  
  const doSave = () => {
    const name = input.value.trim();
    if (!name) {
      toast('Please enter a grid name', 1500);
      return;
    }
    _gridName = name; // Store globally
    gridSaveToFile(name);
    // Update grid info display
    // (zip0153) Show total = _gridGsize²
    const gsize = _gridGsize;
    // (dev0371) Mirror gridShow's layout-aware label/count for 17/19.
    const layout = (typeof _gridCurrentLayout === 'function') ? _gridCurrentLayout() : 'square';
    const total = layout === '17' ? 17 : layout === '19' ? 19 : gsize * gsize;
    const sizeLabel = layout === 'square' ? (gsize + '×' + gsize) : ('layout ' + layout);
    const occupied = (typeof _gridCellList === 'function')
      ? _gridCellList(gsize, layout).filter(s => {
          const row = (typeof getRowByCellForGrid === 'function') ? getRowByCellForGrid(s.cs) : getRowByCell(s.cs);
          return row && (row.show === undefined || row.show === '1');
        }).length
      : data.filter(r => r.cell && parseGridCell(r.cell) && (r.show === undefined || r.show === '1')).length;
    document.getElementById('gridInfo').textContent =
      'gname: ' + name + ' · ' + sizeLabel
      + ' · ' + occupied + '/' + total
      + ' cells · HOLD=cut · Click=swap · Rclick=menu · Ctrl-click=Edit · ^!G=name';
    close();
  };
  
  document.getElementById('gridSaveCancel').onclick = close;
  document.getElementById('gridSaveConfirm').onclick = doSave;
  
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); doSave(); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  
  modal.addEventListener('click', e => {
    if (e.target === modal) close();
  });
}

async function gridSaveToFile(gname) {
  // Build grid configuration object
  const now = isoNow();
  // (zip0153) cells now reflects the live grid size: 25/16/9/4 for
  // 5×5/4×4/3×3/2×2. C reload reads this back to restore Gsize.
  const gsize = _gridGsize;
  // (dev0371) Honour the active layout: 17/19 save with their real cell count
  // and their merged 1L / 1P-3P cells, not as a 25-key square. Read each cell via
  // getRowByCellForGrid so the live (possibly rearranged) arrangement and the
  // special cells are both captured — getRowByCell only saw row.cell.
  const layout = (typeof _gridCurrentLayout === 'function') ? _gridCurrentLayout() : 'square';
  const cellsVal = layout === '17' ? 17 : layout === '19' ? 19 : gsize * gsize;
  const gridData = {
    gname: gname,
    cells: cellsVal,
    // (dev0346) Persist the whole-grid zoom so reload restores it.
    Zoom: (typeof _gridFillZoom === 'function') ? _gridFillZoom() : 1,
    DateModified: now
  };

  // Add each cell from the layout's cell list. Square layouts write the 1a..NN
  // subset (a 3×3 save → 9 keys); 17/19 write the 16-cell ring + merged center.
  const resolve = (typeof getRowByCellForGrid === 'function') ? getRowByCellForGrid : getRowByCell;
  const list = (typeof _gridCellList === 'function')
    ? _gridCellList(gsize, layout)
    : (() => { const a = []; for (let r = 1; r <= gsize; r++) for (let c = 1; c <= gsize; c++) a.push({ cs: mkGridCell(r, c) }); return a; })();
  for (const spec of list) {
    const cellStr = spec.cs;
    const row = resolve(cellStr);
    if (row && row.UID) {
      // (dev0346) Encode any per-cell zoom as "UID/zoom"; a bare UID = full size.
      const z = (typeof _gridCellZoom !== 'undefined') ? _gridCellZoom[row.UID] : 0;
      gridData[cellStr] = (z && Math.abs(z - 1) > 1e-9) ? (row.UID + '/' + z) : row.UID;
    } else {
      gridData[cellStr] = '';
    }
  }
  
  const dir = await _getDir();

  if (dir) {
    // (zip0251) Operate on the in-memory _cData rather than re-reading c.json
    // from disk. The old fresh-disk-read path resurrected rows that had been
    // deleted from the C-screen in-session — those deletes only made it to
    // localStorage when writeFileToDisk silently failed (no FSA grant). Now
    // we route through _cData + cSaveToFile so C-screen and grid-save share
    // a single source of truth.
    await _cEnsureLoaded();
    const existingIdx = _cData.findIndex(c => c.gname === gname);
    if (existingIdx >= 0) {
      gridData.DateAdded = _cData[existingIdx].DateAdded || now;
      _cData[existingIdx] = gridData;
    } else {
      gridData.DateAdded = now;
      _cData.push(gridData);
    }
    _gridConfigs = _cData;

    const ok = await cSaveToFile();
    if (ok) {
      toast('✓ Saved "' + gname + '" to c.json (' + _cData.length + ' grids)', 2000);
    } else {
      // Disk write failed but LS was updated by cSaveToFile.
      toast('⚠ "' + gname + '" saved to localStorage only — re-grant project folder', 3000);
    }

    _gridName = gname;
    const label = document.getElementById('gridNameLabel');
    if (label) {
      label.textContent = gname;
      label.style.color = '#ff8';
    }
  } else {
    const finalData = [
      { _salMeta: true, _salColWidths: {}, _salColOrder: ['gname', 'cells', 'Zoom', 'DateAdded', 'DateModified'], _salHidden: [] },
      Object.assign({DateAdded: now}, gridData)
    ];
    const jsonStr = JSON.stringify(finalData, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'c.json';
    a.click();
    URL.revokeObjectURL(url);
    toast('✓ Downloaded "' + gname + '" as c.json (set folder for auto-save)', 2500);
  }
}

// Grid keyboard handler - only Escape (Alt keys handled globally)
document.addEventListener('keydown', e => {
  if (document.getElementById('gridOverlay').style.display !== 'flex') return;
  if (document.getElementById('gridFullscreen').style.display === 'flex') return;
  // (dev0360) While the slideshow is up it owns the keyboard — don't let grid
  // keys fire underneath it. Critically, Esc must NOT close the grid here: the
  // slideshow's own handler closes the show, which reveals G again (so Esc now
  // matches the Close button, which returned to G). Also stops Space / [ ] from
  // leaking to the grid behind the show.
  if (document.getElementById('slideshowOverlay')) return;

  // (dev0373) While the Ctrl+Alt+G "Save Grid Configuration" name dialog is open it
  // owns the keyboard: Enter → Save, Escape → Cancel (dismiss). This handler fires in
  // capture before the dialog's own input listener, and previously its Escape branch
  // (below) closed the GRID instead of the dialog. Route to the dialog buttons and
  // swallow every other grid key so nothing leaks to the grid underneath.
  if (document.getElementById('gridSaveModal')) {
    if (e.key === 'Enter')  { e.preventDefault(); e.stopPropagation(); document.getElementById('gridSaveConfirm')?.click(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); document.getElementById('gridSaveCancel')?.click(); }
    return;
  }

  // (dev0374) MovingCells "ring conveyor" screensaver — see movingcells.js.
  //   r        → toggle the rotation on/off
  //   {  /  }  → slower / faster move (Shift+[ / Shift+]); pause is fixed at 2s
  // Bare/Shift keys only; checked before the [ ] zoom keys so the Shift variants
  // don't fall through to them. Whole feature is removable with movingcells.js.
  if (!e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'r' || e.key === 'R')) {
    e.preventDefault(); e.stopPropagation();
    if (window.MovingCells) window.MovingCells.toggle();
    return;
  }
  if (!e.ctrlKey && !e.altKey && !e.metaKey && (e.key === '{' || (e.shiftKey && e.code === 'BracketLeft'))) {
    e.preventDefault(); e.stopPropagation();
    if (window.MovingCells) window.MovingCells.slower();
    return;
  }
  if (!e.ctrlKey && !e.altKey && !e.metaKey && (e.key === '}' || (e.shiftKey && e.code === 'BracketRight'))) {
    e.preventDefault(); e.stopPropagation();
    if (window.MovingCells) window.MovingCells.faster();
    return;
  }

  // (dev0336) Ctrl+B → cycle clean-playback buffering for YouTube cells:
  // off → cut (instant double-buffer) → fade (crossfade). Left-hand chord so it
  // doesn't collide with the bare-letter grid navigation; Ctrl+I is left alone
  // as the T-screen row preview.
  if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'b' || e.key === 'B')) {
    e.preventDefault(); e.stopPropagation();
    if (typeof gridCycleBufferMode === 'function') gridCycleBufferMode();
    return;
  }

  // (dev0336) −/+ tune the buffer pre-roll (hidden warm-up seconds). Bare keys —
  // easy to tap while dialling in how much of YT's startup chrome to hide.
  if (!e.ctrlKey && !e.altKey && !e.metaKey && (e.key === '-' || e.key === '_')) {
    e.preventDefault(); e.stopPropagation();
    if (typeof gridAdjustPreroll === 'function') gridAdjustPreroll(-0.5);
    return;
  }
  if (!e.ctrlKey && !e.altKey && !e.metaKey && (e.key === '=' || e.key === '+')) {
    e.preventDefault(); e.stopPropagation();
    if (typeof gridAdjustPreroll === 'function') gridAdjustPreroll(0.5);
    return;
  }

  // (dev0347) Ctrl+[ / Ctrl+] zoom just the cell under the mouse pointer (the
  // last one hovered — see _gridHoverCell). Checked before the bare [ ] below.
  if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === '[' || e.code === 'BracketLeft')) {
    e.preventDefault(); e.stopPropagation();
    if (typeof gridAdjustCellZoom === 'function') gridAdjustCellZoom(_gridHoverCell, -0.1);
    return;
  }
  if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === ']' || e.code === 'BracketRight')) {
    e.preventDefault(); e.stopPropagation();
    if (typeof gridAdjustCellZoom === 'function') gridAdjustCellZoom(_gridHoverCell, 0.1);
    return;
  }

  // (dev0346) [ / ] tune the whole-grid zoom by ±0.2 (keyboard). Bare keys;
  // floor 0.2, no upper limit. Applies whether or not buffering is on.
  // 1× = plain cover/contain; <1 shrinks, >1 crops in.
  if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key === '[') {
    e.preventDefault(); e.stopPropagation();
    if (typeof gridAdjustFillZoom === 'function') gridAdjustFillZoom(-0.1);
    return;
  }
  if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key === ']') {
    e.preventDefault(); e.stopPropagation();
    if (typeof gridAdjustFillZoom === 'function') gridAdjustFillZoom(0.1);
    return;
  }

  // (dev0368) Shift+Z restores every cell's relative zoom to the values saved in
  // the active c.json config — reverting unsaved per-cell tweaks, window zoom kept.
  if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'Z') {
    e.preventDefault(); e.stopPropagation();
    if (typeof gridRestoreCellZoomFromConfig === 'function') gridRestoreCellZoomFromConfig();
    return;
  }
  // (dev0350) Bare z resets zoom. First press: whole-grid (window) zoom → 1.0
  // while each cell keeps its relative per-cell zoom. A SECOND consecutive z
  // (no [ ] / Ctrl+[ ] nudge between) also clears every per-cell zoom. See gridResetZoom.
  if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'z') {
    e.preventDefault(); e.stopPropagation();
    if (typeof gridResetZoom === 'function') gridResetZoom();
    return;
  }

  // (dev0335) Space → pause/unpause ALL grid videos. No in-frame interaction is
  // needed in G, so Space is free as a global play/pause toggle.
  if (e.key === ' ' || e.code === 'Space') {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    e.preventDefault(); e.stopPropagation();
    if (typeof gridToggleAllPause === 'function') gridToggleAllPause();
    return;
  }

  // Escape → clear cut or close grid → go to table
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    if (_gridCutCell) {
      gridClearCut();
      toast('Cut cancelled', 800);
    } else {
      gridClose();
    }
    return;
  }
}, true);

// Wire up Grid buttons
document.getElementById('gridBtn')?.addEventListener('click', gridShow);
// Collection screen is opened via C key (hotkey) or C-toolbar
document.getElementById('gridBackBtn').addEventListener('click', gridClose);
document.getElementById('gridNameBtn').addEventListener('click', () => gridSavePrompt());

// T source button — switch to Table mode and redraw
document.getElementById('gridSrcT').addEventListener('click', () => {
  _gridSource = 'T';
  gridShow();
});

// C source button — open the Collection picker. The button's title is
// "Show grid from Collection (C — choose from c.json)", so a click should
// always take the user to C regardless of whether a config is already
// active.
//
// (zip0232) Previously: if _gridActiveConfig was set, the click just stayed
// in G; if it was null, openCScreen() ran but the grid overlay stayed on
// top of the C screen (the hotkey path in vp.js _executeHotkey('c') closes
// the grid overlay first — the button skipped that step). Both branches
// felt broken. Now we always close the grid overlay, switch source, and
// open the picker. Mirrors the C hotkey path.
document.getElementById('gridSrcC').addEventListener('click', () => {
  _gridSource = 'C';
  gridUpdateSourceBtns();
  if (document.getElementById('gridOverlay')?.style.display === 'flex') {
    if (typeof gridCleanupPlayers === 'function')  gridCleanupPlayers();
    if (typeof gridClearCut === 'function')        gridClearCut();
    if (typeof gridHideContextMenu === 'function') gridHideContextMenu();
    document.getElementById('gridOverlay').style.display = 'none';
  }
  showGridList();
  if (!_gridActiveConfig) toast('Choose a collection to display in Grid', 2000);
});

// ══════════════════════════════════════════════════════════════════════════════
// C SCREEN — Collection (c.json) using shared table engine
// ══════════════════════════════════════════════════════════════════════════════
var _gridConfigs = []; // stays in sync with _cData

var _cMode      = false;
var _tSave      = null;
var _cData      = [];
var _cCols      = [];
var _cHidden    = new Set();
var _cColWidths = {};
var _cLoaded    = false; // true after first successful disk read
var _cSortCol   = null;
var _cSortDir   = 'asc';
var _cSortedIdx = null;
var _cRowFilter = null;
var _cFocus     = null;
var _cPending   = null;
var _cChecked   = new Set();
var _cGnameFilter = '';  // live substring filter on gname column in C-screen
var _cMeta      = { _salMeta:true, _salColWidths:{}, _salColOrder:null, _salHidden:[],
                    _salViews:{}, _salActiveView:null };

function getTgAllCols() {
  const base = ['gname','cells','Zoom','DateAdded','DateModified'];
  for (let r=1;r<=5;r++) for (let ci=0;ci<5;ci++) base.push(r+String.fromCharCode(97+ci));
  return base;
}

function cBuildCols() {
  const seen = new Set();
  _cData.forEach(r => Object.keys(r).forEach(k => seen.add(k)));
  const preferred = getTgAllCols();
  const kept = (_cMeta._salColOrder||[]).filter(c => seen.has(c));
  if (kept.length) {
    _cCols = [...kept, ...[...seen].filter(c => !kept.includes(c))];
  } else {
    _cCols = [...preferred.filter(c=>seen.has(c)), ...[...seen].filter(c=>!preferred.includes(c))];
  }
}

// (zip0236) localStorage backup key for c.json. Written on every save so
// changes (especially deletions) survive a page reload even when the user
// has no project folder set (writeFileToDisk silently fails in that case).
// openCScreen reads this first; disk is a fallback for first-ever load.
const _C_LS_KEY = 'sal-c-json';

// A config is "empty" when it has no populated grid cell (1a..5e). A name and a
// cells-count alone don't make a displayable grid — a cell-less config (e.g. a
// leftover "...Dup") is junk. These linger in the localStorage backup and
// reappear in C after every delete because the LS copy outlives the disk write.
// Prune on every read and before every write so they can't survive a reload no
// matter which store they came from. A nameless config with real cells is kept
// (it's a usable, just-unnamed grid).
function _cIsEmptyConfig(r) {
  if (!r || r._salMeta) return false;
  for (const k in r) {
    // (dev0370) A filled special-layout cell (1L / 1P-3P) counts as real content
    // too, so a 17/19 grid built only on its big/portrait cells isn't pruned.
    const isCellKey = (typeof _isGridConfigCellKey === 'function')
      ? _isGridConfigCellKey(k)
      : (/^[1-9][a-e]$/.test(k) || k === '1L' || /^[123]P$/.test(k));
    if (isCellKey && r[k] && String(r[k]).trim()) return false;
  }
  return true;
}
function _cPruneEmpty(arr) {
  return Array.isArray(arr) ? arr.filter(r => !_cIsEmptyConfig(r)) : arr;
}

async function cSaveToFile() {
  // (zip0251) Only update _salColOrder if _cCols actually has columns. When
  // cSaveToFile is called from outside C-mode (gridSaveToFile / reassign
  // UIDs), _cCols may be empty; we don't want to wipe the column order in
  // _salMeta in that case.
  if (_cCols && _cCols.length) _cMeta._salColOrder = _cCols.slice();
  _cMeta._salHidden    = [..._cHidden];
  _cMeta._salColWidths = Object.assign({}, _cColWidths);
  _cData = _cPruneEmpty(_cData);
  _gridConfigs = _cData;
  const payload = [_cMeta].concat(_cData);
  // Always mirror to localStorage so an FSA failure doesn't lose the edit.
  try { localStorage.setItem(_C_LS_KEY, JSON.stringify(payload)); } catch(_) {}
  const ok = await writeFileToDisk('c.json', payload);
  if (ok) setFsaStatus('📂 ' + (_fsaDir?_fsaDir.name:'') + ' — c.json saved ' + new Date().toTimeString().slice(0,8));
  return ok;
}

// (zip0251) Load c.json into _cData/_cMeta from the same source openCScreen
// uses. Idempotent — subsequent calls are no-ops once _cLoaded is true.
// Extracted so gridSaveToFile and reassign-UIDs can operate on the same
// in-memory state as the C-screen, instead of doing their own fresh disk
// read (which resurrected rows that had been deleted in-session but whose
// disk write silently failed).
async function _cEnsureLoaded() {
  if (_cLoaded) return;
  let parsed = null;
  try {
    const raw = localStorage.getItem(_C_LS_KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch (e) {}
  if (!parsed) {
    const dir = await _getDir();
    if (dir) {
      try {
        const fh = await dir.getFileHandle('c.json');
        parsed = JSON.parse(await (await fh.getFile()).text());
      } catch (e) {}
    }
  }
  if (!parsed) {
    try {
      const r = await fetch('c.json?t=' + Date.now());
      if (r.ok) parsed = await r.json();
    } catch (e) {}
  }
  if (!parsed) parsed = [];
  try {
    if (Array.isArray(parsed) && parsed[0]?._salMeta) {
      _cMeta = parsed[0]; _cData = parsed.slice(1);
    } else if (Array.isArray(parsed)) {
      _cData = parsed;
    } else { _cData = [parsed]; }
    _cData = _cPruneEmpty(_cData);
    _gridConfigs = _cData;
  } catch (e) { _cData = []; _gridConfigs = []; }
  cBuildCols();
  if (_cMeta._salHidden) _cHidden = new Set(_cMeta._salHidden);
  if (_cMeta._salColWidths) _cColWidths = Object.assign({}, _cMeta._salColWidths);
  _cLoaded = true;
}

async function openCScreen() {
  if (_cMode) return;

  // (zip0233) Only read from disk on the very first open. Subsequent opens
  // reuse the in-memory _cData so that in-session edits (deletes, saves)
  // are never clobbered by a fresh disk read that races with the async
  // cSaveToFile() or that reflects a stale file when FSA isn't available.
  // cSaveToFile() remains the authoritative write path — if it fails the
  // existing toast warns the user.
  if (!_cLoaded) {
    // (zip0236) Read order: localStorage backup first, then FSA folder, then
    // HTTP fetch. The localStorage backup is written on every cSaveToFile so
    // it holds the most recent in-app state — including deletions that
    // didn't make it to disk because no project folder was set. If LS is
    // absent (first-ever load on this device), fall back to disk.
    let parsed = null;
    try {
      const raw = localStorage.getItem(_C_LS_KEY);
      if (raw) parsed = JSON.parse(raw);
    } catch (e) { /* corrupt LS — fall through */ }
    if (!parsed) {
      // (zip0139) Try the project folder (FSA) first; fall back to HTTP fetch.
      const dir = await _getDir();
      if (dir) {
        try {
          const fh = await dir.getFileHandle('c.json');
          parsed = JSON.parse(await (await fh.getFile()).text());
        } catch (e) { /* fall through to HTTP */ }
      }
    }
    if (!parsed) {
      try {
        const r = await fetch('c.json?t=' + Date.now());
        if (r.ok) parsed = await r.json();
      } catch (e) { /* fall through to empty */ }
    }
    if (!parsed) {
      toast('No c.json available\n(set project folder, or place c.json next to index.html)', 2500);
      parsed = [];
    }
    try {
      if (Array.isArray(parsed) && parsed[0]?._salMeta) {
        _cMeta = parsed[0]; _cData = parsed.slice(1);
      } else if (Array.isArray(parsed)) {
        _cData = parsed;
      } else { _cData = [parsed]; }
      _cData = _cPruneEmpty(_cData);
      _gridConfigs = _cData;
    } catch (e) { _cData = []; _gridConfigs = []; }
    _cLoaded = true;
  }

  _cMode = true;
  _tSave = { data, cols, hidden, colWidths, sortCol, sortDir, sortedIdx,
             rowFilter, focus, pending, checkedRows, metaRow };

  data       = _cData;
  cols       = _cCols;
  hidden     = _cHidden;
  colWidths  = _cColWidths;
  sortCol    = _cSortCol;
  sortDir    = _cSortDir;
  sortedIdx  = _cSortedIdx;
  rowFilter  = _cRowFilter;
  focus      = _cFocus;
  pending    = _cPending;
  checkedRows= _cChecked;
  metaRow    = _cMeta;

  cBuildCols(); cols = _cCols;
  if (_cMeta._salHidden)    hidden    = new Set(_cMeta._salHidden);
  if (_cMeta._salColWidths) colWidths = Object.assign({}, _cMeta._salColWidths);

  buildSort();
  document.getElementById('toolbar').style.display  = 'none';
  document.getElementById('ctoolbar').style.display = 'flex';
  render();
  cUpdateStatus();
}

function closeCScreen() {
  if (!_cMode) return;
  // Capture C state
  _cData      = data; _cCols = cols.slice(); _cHidden = new Set(hidden);
  _cColWidths = Object.assign({}, colWidths); _cSortCol = sortCol; _cSortDir = sortDir;
  _cSortedIdx = sortedIdx; _cRowFilter = rowFilter; _cFocus = focus;
  _cPending   = pending; _cChecked = new Set(checkedRows);
  _cMeta._salColOrder  = _cCols;
  _cMeta._salHidden    = [..._cHidden];
  _cMeta._salColWidths = Object.assign({}, _cColWidths);
  _gridConfigs = _cData;
  _cMode = false;
  _cGnameFilter = '';  // clear gname filter on exit
  if (_tSave) {
    data=_tSave.data; cols=_tSave.cols; hidden=_tSave.hidden; colWidths=_tSave.colWidths;
    sortCol=_tSave.sortCol; sortDir=_tSave.sortDir; sortedIdx=_tSave.sortedIdx;
    rowFilter=_tSave.rowFilter; focus=_tSave.focus; pending=_tSave.pending;
    checkedRows=_tSave.checkedRows; metaRow=_tSave.metaRow; _tSave=null;
  }
  document.getElementById('ctoolbar').style.display = 'none';
  document.getElementById('toolbar').style.display  = 'flex';
  render();
}

function cUpdateStatus() {
  const el = document.getElementById('cstatus'); if (!el) return;
  const total = _cData.length;
  const vis   = rowFilter ? _cData.filter(r=>rowMatchesFilter(r)).length : total;
  el.textContent = total+' collections · '+visCols().length+' cols'
    +(hidden.size?' ('+hidden.size+' hidden)':'')
    +(rowFilter?' 🔍 '+vis+'/'+total:'')
    +(_cGnameFilter?' 🔍 gname:"'+_cGnameFilter+'"':'')
    +(checkedRows.size?' · '+checkedRows.size+' ✓':'');
}

// Filter Gname — live substring filter on gname column
(function wireCFilterGname() {
  const btn   = document.getElementById('cFilterGnameBtn');
  const input = document.getElementById('cFilterGnameInput');
  if (!btn || !input) return;

  function applyGnameFilter(val) {
    _cGnameFilter = val.trim().toLowerCase();
    buildSort(); render(); cUpdateStatus();
  }

  function setFilterActive(active) {
    if (active) {
      btn.textContent = '✕ Gname Filter';
      btn.style.borderColor = '#f44'; btn.style.color = '#f88';
      input.style.display = 'inline-block';
      input.focus();
    } else {
      btn.textContent = '🔍 Filter Gname';
      btn.style.borderColor = '#adf'; btn.style.color = '#adf';
      input.style.display = 'none';
      input.value = '';
      _cGnameFilter = '';
      buildSort(); render(); cUpdateStatus();
    }
  }

  btn.addEventListener('click', () => {
    if (input.style.display !== 'none' || _cGnameFilter) setFilterActive(false);
    else setFilterActive(true);
  });

  input.addEventListener('input', () => applyGnameFilter(input.value));
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { setFilterActive(false); e.stopPropagation(); }
    if (e.key === 'Enter')  { input.blur(); }
  });
})();

// DateFill — fill blank DateAdded and DateModified in C-screen
document.getElementById('cDateFillBtn').addEventListener('click', () => {
  if (!_cMode) return;
  const now = isoNow();
  let filled = 0;
  _cData.forEach(r => {
    let changed = false;
    if (!r.DateAdded)    { r.DateAdded    = now; changed = true; }
    if (!r.DateModified) { r.DateModified = now; changed = true; }
    if (changed) filled++;
  });
  if (filled) {
    cSaveToFile(); render();
    toast('✓ DateFill: ' + filled + ' record' + (filled>1?'s':'') + ' updated', 2000);
  } else {
    toast('All records already have dates', 1500);
  }
});

function cMakeActive() {
  const sel = [...checkedRows]; let idx = null;
  if (sel.length===1) idx=sel[0];
  else if (focus!==null) idx=vr(focus.r);
  if (idx===null) { toast('Select a row first (click or check)',1500); return; }
  const stored = _cData[idx]; if (!stored) return;
  // (dev0373) Activate a CLONE so live cut/swap (and per-cell zoom) edits a working
  // copy — NOT the stored config. Before this, _gridActiveConfig === _cData[idx], so
  // rearranging cells mutated the saved config in place; a later "save as <new name>"
  // (Ctrl+Alt+G) then wrote BOTH the now-corrupted original and the new copy, so the
  // two rows came out identical (the "19 does it hold → 19 swaps is identical" bug —
  // the swaps WERE captured, they just also overwrote the source). The stored config
  // now stays pristine until an explicit SAME-name save overwrites it.
  const cfg = JSON.parse(JSON.stringify(stored));
  _gridActiveConfig = cfg; _gridSource = 'C'; _gridName = cfg.gname||'';
  if (typeof _gridApplyConfigZoom === 'function') _gridApplyConfigZoom(cfg); // (dev0346) global + per-cell zoom
  // (zip0153) Derive grid size from cfg.cells (25/16/9/4 → 5/4/3/2). Older
  // entries without cells default to 5. Persist via _setGridGsize so the
  // size sticks on reload.
  const cellsN = parseInt(cfg.cells, 10);
  let gsize = 5;
  if (cellsN === 4) gsize = 2;
  else if (cellsN === 9) gsize = 3;
  else if (cellsN === 16) gsize = 4;
  else if (cellsN === 25) gsize = 5;
  _setGridGsize(gsize, { skipSave: true }); // skipSave: about to save() below
  metaRow = metaRow || { _salMeta: true };
  metaRow._salGsize = gsize;
  const tdata = _tSave ? _tSave.data : data;
  tdata.forEach(r=>{if(r.cell)r.cell='';});
  for (let r=1; r<=gsize; r++) for (let c=1; c<=gsize; c++) {
    const cs=mkGridCell(r,c);
    const uid = _gridParseCellVal(cfg[cs]).uid; // (dev0346) strip any /zoom suffix
    if (uid) { const row=tdata.find(d=>String(d.UID)===uid); if(row) row.cell=cs; }
  }
  closeCScreen(); save();
  toast('✓ Active: '+(cfg.gname||'(unnamed)')+' ('+gsize+'×'+gsize+')',1500);
  gridShow();
}

function cDeleteSelected() {
  // (dev0372) Delete ALL checked rows, not just one. The old code only handled a
  // single selection: when 2+ rows were checked, `sel.length===1` was false so it
  // skipped the checked set entirely and fell back to the focused row (or bailed
  // with "Select a row first"). Marking several unwanted configs and pressing
  // Delete therefore appeared to do nothing. checkedRows holds DATA indices into
  // _cData (see core.js checkbox handler + cMakeActive).
  let idxs = [...checkedRows];
  if (!idxs.length && focus !== null) idxs = [vr(focus.r)];     // fall back to focus when nothing checked
  idxs = idxs.filter(i => i != null && _cData[i]);
  if (!idxs.length) { toast('Select a row first (check a box or click a row)', 1500); return; }
  const names = idxs.map(i => _cData[i].gname || 'unnamed');
  const msg = idxs.length === 1
    ? 'Delete collection "' + names[0] + '"?'
    : 'Delete ' + idxs.length + ' collections?\n\n' + names.slice(0, 12).join(', ') + (names.length > 12 ? ', …' : '');
  if (!confirm(msg)) return;
  // Splice high→low so each removal doesn't shift the indices still to delete.
  idxs.sort((a, b) => b - a).forEach(i => _cData.splice(i, 1));
  data = _cData;
  checkedRows.clear(); focus = null;
  buildSort(); render(); cUpdateStatus();
  cSaveToFile();
}

