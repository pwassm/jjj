
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
    const total = gsize * gsize;
    const occupied = data.filter(r => r.cell && parseGridCell(r.cell) && (r.show === undefined || r.show === '1')).length;
    document.getElementById('gridInfo').textContent =
      'gname: ' + name + ' · ' + gsize + '×' + gsize
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
  const gridData = {
    gname: gname,
    cells: gsize * gsize,
    DateModified: now
  };
  
  // Add each cell — only the current Gsize subset (1a..NN). Cells outside
  // this square are NOT written, so a 3×3 save produces a 9-key entry.
  for (let r = 1; r <= gsize; r++) {
    for (let c = 1; c <= gsize; c++) {
      const cellStr = mkGridCell(r, c);
      const row = getRowByCell(cellStr);
      gridData[cellStr] = row ? (row.UID || '') : '';
    }
  }
  
  // Get fresh directory handle (fixes FSA stale state error)
  const dir = await _getDir();
  
  if (dir) {
    // Load existing c.json with fresh handle
    let allConfigs = [];
    let tgMeta = { _salMeta: true, _salColWidths: {}, _salColOrder: ['gname', 'cells', 'DateModified'], _salHidden: [] };
    
    try {
      const readHandle = await dir.getFileHandle('c.json');
      const file = await readHandle.getFile();
      const txt = await file.text();
      const parsed = JSON.parse(txt);
      if (Array.isArray(parsed)) {
        // First element might be _salMeta
        if (parsed[0] && parsed[0]._salMeta) {
          tgMeta = parsed[0];
          allConfigs = parsed.slice(1);
        } else {
          allConfigs = parsed;
        }
      } else {
        allConfigs = [parsed];
      }
    } catch(e) {
      // No existing file or parse error - start fresh
      allConfigs = [];
    }
    
    // Find existing config with same gname and update, or add new
    const existingIdx = allConfigs.findIndex(c => c.gname === gname);
    if (existingIdx >= 0) {
      // Preserve DateAdded from existing record
      gridData.DateAdded = allConfigs[existingIdx].DateAdded || now;
      allConfigs[existingIdx] = gridData;
    } else {
      gridData.DateAdded = now;  // set on creation only
      allConfigs.push(gridData);
    }
    
    // Build final array with _salMeta first
    const finalData = [tgMeta].concat(allConfigs);
    
    // Save back to c.json with FRESH write handle
    try {
      const writeHandle = await dir.getFileHandle('c.json', { create: true });
      const w = await writeHandle.createWritable();
      await w.write(JSON.stringify(finalData, null, 2));
      await w.close();
      toast('✓ Saved "' + gname + '" to c.json (' + allConfigs.length + ' grids)', 2000);
      
      // Update grid name display
      _gridName = gname;
      const label = document.getElementById('gridNameLabel');
      if (label) {
        label.textContent = gname;
        label.style.color = '#ff8';
      }
    } catch(e) {
      toast('✗ Error saving c.json: ' + e.message, 3000);
    }
  } else {
    // No FSA directory set - download
    const finalData = [
      { _salMeta: true, _salColWidths: {}, _salColOrder: ['gname', 'cells', 'DateAdded', 'DateModified'], _salHidden: [] },
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
  const base = ['gname','cells','DateAdded','DateModified'];
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

async function cSaveToFile() {
  _cMeta._salColOrder  = _cCols.slice();
  _cMeta._salHidden    = [..._cHidden];
  _cMeta._salColWidths = Object.assign({}, _cColWidths);
  _gridConfigs = _cData;
  const payload = [_cMeta].concat(_cData);
  // Always mirror to localStorage so an FSA failure doesn't lose the edit.
  try { localStorage.setItem(_C_LS_KEY, JSON.stringify(payload)); } catch(_) {}
  const ok = await writeFileToDisk('c.json', payload);
  if (ok) setFsaStatus('📂 ' + (_fsaDir?_fsaDir.name:'') + ' — c.json saved ' + new Date().toTimeString().slice(0,8));
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
  const cfg = _cData[idx]; if (!cfg) return;
  _gridActiveConfig = cfg; _gridSource = 'C'; _gridName = cfg.gname||'';
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
    if (cfg[cs]) { const row=tdata.find(d=>d.UID===cfg[cs]); if(row) row.cell=cs; }
  }
  closeCScreen(); save();
  toast('✓ Active: '+(cfg.gname||'(unnamed)')+' ('+gsize+'×'+gsize+')',1500);
  gridShow();
}

function cDeleteSelected() {
  const sel = [...checkedRows]; let idx = null;
  if (sel.length===1) idx=sel[0];
  else if (focus!==null) idx=vr(focus.r);
  if (idx===null) { toast('Select a row first',1500); return; }
  const cfg = _cData[idx];
  if (!confirm('Delete collection "'+(cfg.gname||'unnamed')+'"?')) return;
  _cData.splice(idx,1); data=_cData;
  checkedRows.clear(); focus=null;
  buildSort(); render(); cUpdateStatus();
  cSaveToFile();
}

