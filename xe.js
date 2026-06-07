
// ══════════════════════════════════════════════════════════════════════════════
// TEXT SLIDE EDITOR (contentEditable rich text for ftext column)
// ══════════════════════════════════════════════════════════════════════════════
let _textEditorOverlay = null;
let _textEditorCell = null;
let _textEditorRow = null;

function gridOpenTextEditor(cellStr, row, opts) {
  opts = opts || {};
  // (zip0155) Defensive: if a previous text-editor overlay was left in the
  // DOM (e.g. early-failed call, double-open from rapid double-click),
  // remove it first. Otherwise document.getElementById('teSave') below
  // would resolve to the STALE overlay's button — clicking the new
  // visible Save button would dispatch onto an orphan node and silently
  // do nothing. Also clean any lingering helper elements.
  const stale = document.getElementById('textEditorOverlay');
  if (stale) stale.remove();
  const staleStyle = document.getElementById('teStyles');
  if (staleStyle) staleStyle.remove();
  _textEditorOverlay = null;

  _textEditorCell = cellStr;
  
  // If no row exists for this cell, create one
  if (!row) {
    row = {
      UID: nextUID(),
      cell: cellStr,
      show: '1',
      VidRange: 'text',
      ftext: '',
      DateAdded: isoNow(),
      DateModified: isoNow()
    };
    data.push(row);
  }
  _textEditorRow = row;
  
  // (zip0168) Linkify URL patterns in existing ftext so the editor shows
  // clickable links. On save, the linkified HTML persists — old plain-text
  // URLs become anchor tags after the first edit-save cycle.
  const rawExisting = row.ftext || '';
  const existingText = (typeof renderFtext === 'function')
    ? renderFtext(rawExisting)
    : rawExisting;
  const hasMedia = !!(row.link);
  
  _textEditorOverlay = document.createElement('div');
  _textEditorOverlay.id = 'textEditorOverlay';
  _textEditorOverlay.style.cssText = `
    position:fixed; inset:0; z-index:35000;
    background:rgba(0,0,0,0.95); display:flex;
    align-items:stretch; justify-content:stretch;
    padding:20px; outline:none;
    right:340px;
  `;
  // (zip0179) Make overlay focusable so ArrowUp/Down navigation works
  // even when the editor itself is NOT focused (e.g. when arriving here
  // via openEditorForRow row-to-row navigation). Without this, focus
  // falls back to <body> and the overlay's keydown listener never fires.
  _textEditorOverlay.tabIndex = -1;
  
  const mediaNote = hasMedia ? `<span style="color:#8f8; font-size:11px; margin-left:12px;">(has ${isVideoRow(row)?'video':'image'})</span>` : '';
  
  _textEditorOverlay.innerHTML = `
    <div id="teBox" style="background:#1a1a2e; border:1px solid #444; border-radius:12px;
                flex:1; display:flex; flex-direction:column; box-shadow:0 8px 32px rgba(0,0,0,0.5);">
      <div style="display:flex; justify-content:space-between; align-items:center;
                  padding:22px 16px; min-height:64px;
                  border-bottom:2px solid #6af; background:#3a4d75;">
        <span style="color:#ff8; font-weight:bold;">Text Slide · ${cellStr}${mediaNote}</span>
        <span id="teStats" style="color:#9ab; font-weight:normal; font-size:11px; font-family:monospace;" title="ftext size · % real text · % strippable junk (inline styles/classes/empty wrappers; image & link URLs are NOT junk)"></span>
        <div style="display:flex; gap:8px;">
          <button id="teSlide" class="tbtn" style="padding:6px 12px; border-color:#8ef; color:#8ef;" title="Preview as slide — auto-saves first. Key: S (when not typing). Esc closes preview.">▶ <u>S</u>lide</button>
          <button id="teSlideshow" class="tbtn" style="padding:6px 12px; border-color:#fc8; color:#fc8;" title="Play embedded images as a full-window slideshow (5s/slide, click or Esc to exit).">▶▶ Slideshow</button>
          <button id="teClose" class="tbtn" style="padding:6px 12px;">✕ Close</button>
          <button id="teSave" class="tbtn" style="padding:6px 12px; border-color:#0f0; color:#0f0;">✓ Save</button>
        </div>
      </div>
      
      <!-- Formatting toolbar -->
      <div id="teToolbar" style="display:flex; flex-wrap:wrap; gap:4px; padding:8px 16px; background:#0d0d1e; border-bottom:1px solid #333;">
        <button class="te-btn" data-cmd="bold" title="Bold (Ctrl+B)"><b>B</b></button>
        <button class="te-btn" data-cmd="italic" title="Italic (Ctrl+I)"><i>I</i></button>
        <button class="te-btn" data-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>
        <span style="width:1px; background:#444; margin:0 6px;"></span>
        <button class="te-btn" data-cmd="formatBlock" data-val="h1" title="Heading 1">H1</button>
        <button class="te-btn" data-cmd="formatBlock" data-val="h2" title="Heading 2">H2</button>
        <button class="te-btn" data-cmd="formatBlock" data-val="h3" title="Heading 3">H3</button>
        <button class="te-btn" data-cmd="formatBlock" data-val="h4" title="Heading 4">H4</button>
        <button class="te-btn" data-cmd="formatBlock" data-val="h5" title="Heading 5">H5</button>
        <button class="te-btn" data-cmd="formatBlock" data-val="h6" title="Heading 6">H6</button>
        <button class="te-btn" data-cmd="formatBlock" data-val="p" title="Paragraph">P</button>
        <button class="te-btn" id="teSmall" title="Small text — wrap selection in <small> (toggle off if already small)"><small>sm</small></button>
        <span style="width:1px; background:#444; margin:0 6px;"></span>
        <button class="te-btn" data-cmd="justifyLeft" title="Left align">◀</button>
        <button class="te-btn" data-cmd="justifyCenter" title="Center">◆</button>
        <span style="width:1px; background:#444; margin:0 6px;"></span>
        <button class="te-btn" data-cmd="insertUnorderedList" title="Bullet list">•</button>
        <button class="te-btn" id="teCollapse" title="Insert empty collapsible section (opens; type a summary, then add anything inside — including images/tables)">▶…</button>
        <button class="te-btn" id="teWrap" title="Wrap current selection in a collapsible section — turns multi-line content, pictures, or tables into a hideable block">[▶…]</button>
        <button class="te-btn" id="teUndetail" title="Undetail — turn the collapsible block at the cursor back into a heading (H3) with a bullet list of its lines underneath (inverse of [▶…])">Un[▶]</button>
        <button class="te-btn" id="teExpandAll" title="Expand all collapsible blocks in this slide">▼ All</button>
        <button class="te-btn" id="teCollapseAll" title="Collapse all collapsible blocks in this slide">▶ All</button>
        <button class="te-btn" id="teCut" title="Park everything from the cursor down — wrapped in a hidden div that's invisible when rendered (slide, grid, exports) but still editable here in Xe. Click on the red banner above the parked block to unpark it.">✂ Cut</button>
        <button class="te-btn" id="teImage" title="Insert image — accepts UID number or https:// URL, with size and alignment">🖼</button>
        <span style="width:1px; background:#444; margin:0 6px;"></span>
        <button class="te-btn" id="teTextColor"  title="Slide-wide text color — choose one for the whole slide">A▾</button>
        <button class="te-btn" id="teBgColor"    title="Slide-wide background color">▣▾</button>
      </div>
      
      <!-- Editor area - FULLSCREEN -->
      <div id="teEditor" style="
        flex:1; overflow-y:auto;
        padding:24px 32px; color:#fff; font-family:sans-serif; font-size:18px; line-height:1.7;
        background:#0a0a1a; outline:none; cursor:text;
        -webkit-user-modify:read-write; -moz-user-modify:read-write;
      ">${existingText || '<h2>Title</h2><p>Your content here...</p>'}</div>

      <div id="teLinkBar" style="display:flex;align-items:center;gap:8px;padding:5px 16px;
           background:#0d0d1e;border-top:1px solid #333;">
        <span style="color:#67a;font-size:11px;white-space:nowrap;">Video URL:</span>
        <input id="teLinkInput" type="text" placeholder="paste video or image URL (sets row.link)"
          style="flex:1;padding:3px 8px;background:#0a0a1a;border:1px solid #444;color:#ccc;
                 border-radius:4px;font-family:monospace;font-size:11px;outline:none;">
        <button id="teLinkPaste" title="Paste from clipboard"
          style="background:#222;border:1px solid #555;color:#aaa;padding:3px 8px;
                 border-radius:4px;cursor:pointer;">📋</button>
      </div>

      <div style="padding:8px 16px; color:#556; font-size:11px; border-top:1px solid #333;">
        Ctrl+B/I/U · Ctrl+S save+close · Esc close · S = slide · Swipe ← title bar = save+close · Shift+Enter new collapsible · Ctrl+Enter exit current collapsible (blank line after) · ⋮⋮ handle = select block for cut
      </div>
    </div>
  `;
  
  document.body.appendChild(_textEditorOverlay);

  // (zip0185) Lift the hop cover (if any) once the new Xe overlay is in DOM.
  // Tiny delay so the browser paints Xe before the cover comes off.
  {
    const _hopCover = document.getElementById('ve-hop-cover');
    if (_hopCover) {
      setTimeout(() => { const c = document.getElementById('ve-hop-cover'); if (c) c.remove(); }, 60);
      clearTimeout(window._veHopCoverTimer);
    }
  }

  // If A is already open, navigate it to this row. Do NOT auto-open A.
  // User presses A hotkey inside E to open Annotate panel.
  {
    const _xeDi = (typeof data !== 'undefined') ? data.indexOf(row) : -1;
    const _anEl = document.getElementById('browseOverlay');
    const _anOpen = _anEl && _anEl.style.display === 'flex';
    if (_anOpen && _xeDi >= 0 && typeof brShow === 'function') {
      const _fi = (window._brRows || []).indexOf(_xeDi);
      if (_fi >= 0) { window._brIdx = _fi; brShow(_fi); }
    }
  }

  // CRITICAL: Set contenteditable AFTER adding to DOM
  const editor = document.getElementById('teEditor');
  editor.setAttribute('contenteditable', 'true');
  editor.contentEditable = 'true';
  
  // Add toolbar button styles
  let style = document.getElementById('teStyles');
  if (!style) {
    style = document.createElement('style');
    style.id = 'teStyles';
    document.head.appendChild(style);
  }
  style.textContent = `
    .te-btn {
      padding:6px 10px; background:#1a1a2e; border:1px solid #444;
      color:#ccc; cursor:pointer; border-radius:4px; font-size:13px;
      user-select:none;
    }
    .te-btn:hover { background:#2a2a4e; color:#fff; }
    .te-btn:active { background:#3a3a5e; }
    #teEditor { user-select:text !important; -webkit-user-select:text !important; }
    #teEditor * { user-select:text !important; -webkit-user-select:text !important; }
    #teEditor a, #teSlideContent a { color:#5bf !important; }
    /* (dev0246) Summary text/links — explicit color so anchors-only summaries
       don't render as black-on-dark in any preview context. */
    #teEditor summary, #teEditor summary a,
    #teSlideContent summary, #teSlideContent summary a { color:#8ef !important; }
    #teEditor h1 { font-size:28px; color:#ff8; margin:0 0 12px; }
    #teEditor h2 { font-size:22px; color:#8ef; margin:0 0 10px; }
    /* (dev0341) Smaller heading levels + <small> for fine size control. */
    #teEditor h3 { font-size:19px; color:#9ef; margin:0 0 8px; }
    #teEditor h4 { font-size:17px; color:#adf; margin:0 0 6px; }
    #teEditor h5 { font-size:15px; color:#bdf; margin:0 0 6px; }
    #teEditor h6 { font-size:13px; color:#cdf; margin:0 0 6px; }
    #teEditor small, #teSlideContent small { font-size:0.8em; opacity:0.85; }
    #teEditor p { margin:0 0 8px; }
    #teEditor ul { margin:8px 0; padding-left:24px; }
    #teEditor details { margin:8px 0; padding:8px 8px 8px 28px; background:#111; border-left:3px solid #06f;
      clear:both; overflow:hidden; position:relative; }
    /* (dev0243) Drag/select handle on the left edge of every details. Click
       it to select the whole <details> block — then Ctrl+X to cut, Ctrl+V
       to paste anywhere (the paste handler preserves <details> markup).
       contenteditable=false so the caret can never land inside the handle. */
    .te-dh { position:absolute; left:4px; top:6px; width:18px; height:22px;
      display:flex; align-items:center; justify-content:center;
      cursor:grab; color:#6af; font-size:14px; user-select:none;
      background:rgba(0,0,0,0.0); border-radius:3px; line-height:1; }
    .te-dh:hover { background:rgba(0,80,160,0.4); color:#cdf; }
    .te-dh:active { cursor:grabbing; }
    #teEditor details.te-selected { outline:2px solid #4af; outline-offset:2px; }
    /* (dev0247) Parked / hidden-from-render content. Default rule below
       hides it everywhere; the Xe-editor override re-shows it (faded with
       a banner) so the user can still see and edit it. */
    #teEditor .te-cut {
      display:block; opacity:0.55;
      border-top:2px dashed #f88; margin-top:14px; padding:22px 0 0;
      position:relative;
    }
    #teEditor .te-cut::before {
      content:'✂ Parked — hidden from render. Click here to unpark.';
      position:absolute; top:-12px; left:8px;
      background:#3a0a0a; color:#fcc; border:1px solid #f88;
      padding:2px 8px; border-radius:4px; font-size:10px;
      font-family:monospace; cursor:pointer; user-select:none;
    }
    #teEditor summary { cursor:pointer; color:#8ef; font-weight:bold; padding:4px 0;
      min-height:1.2em; white-space:pre-wrap; }
    #teEditor summary:empty::before { content:'Click to expand — type summary here'; color:#558; font-weight:normal; font-style:italic; }
    #teEditor summary::-webkit-details-marker { color:#06f; }
    #teEditor details[open] summary { margin-bottom:8px; }
    #teEditor details > div { min-height:1.4em; padding:4px 0; }
    #teSlideContent details { clear:both; overflow:hidden; margin:8px 0; padding:8px; }
  `;
  
  // Wire toolbar buttons - use mousedown to prevent focus loss
  document.querySelectorAll('.te-btn[data-cmd]').forEach(btn => {
    btn.onmousedown = (e) => {
      e.preventDefault(); // Prevent focus loss from editor
      const cmd = btn.dataset.cmd;
      const val = btn.dataset.val || null;
      // (dev0359) Route heading/paragraph (formatBlock) through a guarded
      // helper. The native execCommand('formatBlock') DESTROYS a <details>
      // block when the caret sits in its <summary> (or the block is selected
      // via its ⋮⋮ handle) — it wraps the <details> in the heading and rips
      // the body out into a second, summary-less <details>. It also lossily
      // merges a multi-paragraph selection into one block of <br>s.
      // _teFormatBlock keeps the <details> intact in every case.
      if (cmd === 'formatBlock') { _teFormatBlock(val); return; }
      document.execCommand(cmd, false, val);
    };
  });
  
  // Wire collapse button separately (inserts HTML, not execCommand).
  // (zip0135) Insert empty <details>/<summary>/<div> so user gets just the
  // caret. Sample text was paternalistic — user knows what to type.
  document.getElementById('teCollapse').onmousedown = (e) => {
    e.preventDefault();
    // (dev0242) Insert OPEN so the body div is visible — user can drop images,
    // tables, or paragraphs inside immediately. A trailing <p> sibling gives
    // them somewhere to click out to. Summary stays empty; CSS placeholder
    // ("Click to expand — type summary here") shows until user types.
    const html = '<details open><summary></summary><div><br></div></details><p><br></p>';
    document.execCommand('insertHTML', false, html);
    // Move caret into the new summary so user starts typing the title
    setTimeout(() => {
      const ed = document.getElementById('teEditor');
      if (!ed) return;
      const summaries = ed.querySelectorAll('details > summary');
      const last = summaries[summaries.length - 1];
      if (last) {
        const r = document.createRange();
        r.setStart(last, 0); r.collapse(true);
        const s = window.getSelection();
        s.removeAllRanges(); s.addRange(r);
      }
    }, 0);
  };

  // (dev0247) ✂ Cut — park everything from the caret to the end of the
  // editor in a <div class="te-cut">. Hidden in every render context
  // (CSS sets display:none for .te-cut globally); shown faded with a
  // banner inside #teEditor so the user can still see/edit/recover it.
  document.getElementById('teCut').onmousedown = (e) => {
    e.preventDefault();
    const ed = document.getElementById('teEditor');
    if (!ed) return;
    const sel = window.getSelection();
    if (!sel.rangeCount) { ed.focus(); return; }
    const range = sel.getRangeAt(0);
    // If already inside a .te-cut, no-op
    let n = range.startContainer;
    while (n && n !== ed) {
      if (n.nodeType === 1 && n.classList && n.classList.contains('te-cut')) {
        if (typeof toast === 'function') toast('Already inside a parked block', 1200);
        return;
      }
      n = n.parentNode;
    }
    // Build a range from the caret to the end of the editor
    const cut = document.createRange();
    cut.setStart(range.startContainer, range.startOffset);
    cut.setEnd(ed, ed.childNodes.length);
    const frag = cut.extractContents();
    const wrap = document.createElement('div');
    wrap.className = 'te-cut';
    wrap.appendChild(frag);
    // If wrap is effectively empty, drop in a placeholder so the user
    // sees the parked-area banner.
    if (!wrap.textContent.trim() && !wrap.querySelector('img,video,details,table')) {
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      wrap.appendChild(p);
    }
    cut.insertNode(wrap);
    // Place caret just BEFORE the parked block so the user can keep writing
    // above it. Create a fresh <p> if there's nothing above.
    if (!wrap.previousSibling) {
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      ed.insertBefore(p, wrap);
    }
    const before = wrap.previousSibling;
    const r = document.createRange();
    r.selectNodeContents(before);
    r.collapse(false);
    sel.removeAllRanges(); sel.addRange(r);
    ed.focus();
  };

  // Click the red "Parked" banner to unpark — unwrap the .te-cut div in
  // place, restoring its children as direct children of the editor.
  document.getElementById('teEditor').addEventListener('click', e => {
    const cut = e.target && e.target.classList && e.target.classList.contains('te-cut')
      ? e.target : null;
    if (!cut) return;
    // Only the banner area (the ::before pseudo) is clickable for unpark —
    // detect by checking the click Y is within the banner band (top 24px).
    const rect = cut.getBoundingClientRect();
    if (e.clientY - rect.top > 24) return;
    e.preventDefault(); e.stopPropagation();
    while (cut.firstChild) cut.parentNode.insertBefore(cut.firstChild, cut);
    cut.remove();
    if (typeof toast === 'function') toast('Unparked', 900);
  });

  // (dev0242) Wrap current selection in a collapsible. Lets the user take
  // any existing content (multi-line top section, an image, a table) and
  // turn it into a hideable block. If the selection is empty, falls back to
  // inserting an empty collapsible (same as the ▶… button).
  document.getElementById('teWrap').onmousedown = (e) => {
    e.preventDefault();
    const ed = document.getElementById('teEditor');
    if (!ed) return;
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) {
      document.getElementById('teCollapse').onmousedown(e);
      return;
    }
    const range = sel.getRangeAt(0);
    // Guard: selection must be inside the editor
    let container = range.commonAncestorContainer;
    if (container.nodeType === 3) container = container.parentNode;
    if (!ed.contains(container)) return;
    const frag = range.extractContents();
    const details = document.createElement('details');
    details.setAttribute('open', '');
    const summary = document.createElement('summary');
    const body = document.createElement('div');
    body.appendChild(frag);
    details.appendChild(summary);
    details.appendChild(body);
    range.insertNode(details);
    // Place caret in the summary so user types the title
    const r = document.createRange();
    r.setStart(summary, 0); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
    ed.focus();
  };

  // (dev0341) Small text — wrap the selection in <small> (execCommand has no
  // 'small'). Toggles off if the selection already sits inside a <small>.
  document.getElementById('teSmall').onmousedown = (e) => {
    e.preventDefault();
    const ed = document.getElementById('teEditor');
    if (!ed) return;
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) {
      if (typeof toast === 'function') toast('Select some text first', 1000);
      return;
    }
    const range = sel.getRangeAt(0);
    let anc = range.commonAncestorContainer;
    if (anc.nodeType === 3) anc = anc.parentNode;
    if (!ed.contains(anc)) return;
    const enclosing = anc.closest && anc.closest('small');
    if (enclosing && ed.contains(enclosing)) {
      // Unwrap: move children up, drop the <small>.
      const parent = enclosing.parentNode;
      while (enclosing.firstChild) parent.insertBefore(enclosing.firstChild, enclosing);
      parent.removeChild(enclosing);
      ed.focus();
      return;
    }
    const frag = range.extractContents();
    const small = document.createElement('small');
    small.appendChild(frag);
    range.insertNode(small);
    const r = document.createRange();
    r.selectNodeContents(small);
    sel.removeAllRanges(); sel.addRange(r);
    ed.focus();
  };

  // (dev0341) Expand-all / Collapse-all every <details> block in the slide.
  document.getElementById('teExpandAll').onmousedown = (e) => {
    e.preventDefault();
    const ed = document.getElementById('teEditor');
    if (ed) ed.querySelectorAll('details').forEach(d => d.setAttribute('open', ''));
  };
  document.getElementById('teCollapseAll').onmousedown = (e) => {
    e.preventDefault();
    const ed = document.getElementById('teEditor');
    if (ed) ed.querySelectorAll('details').forEach(d => d.removeAttribute('open'));
  };

  // (dev0341) Undetail — inverse of [▶…] Wrap. Turn the <details> block at the
  // caret into an <h3> (from its summary) followed by a <ul> whose <li>s are the
  // block's lines. Handles the contenteditable nesting (905_d_d-style
  // <div><div>line</div>…</div>) by descending one wrapper level when present.
  document.getElementById('teUndetail').onmousedown = (e) => {
    e.preventDefault();
    const ed = document.getElementById('teEditor');
    if (!ed) return;
    const sel = window.getSelection();
    if (!sel.rangeCount) { ed.focus(); return; }
    let n = sel.getRangeAt(0).startContainer;
    if (n.nodeType === 3) n = n.parentNode;
    const details = n.closest ? n.closest('details') : null;
    if (!details || !ed.contains(details)) {
      if (typeof toast === 'function') toast('Put the cursor inside a collapsible block first', 1800);
      return;
    }
    // Summary → heading (keep inner HTML so anchors survive).
    // Strip inline-style/class junk while keeping anchors, so undetailing a
    // legacy block (e.g. a summary with leftover <span style> wrappers) emits
    // clean markup rather than carrying the bloat into the heading/bullets.
    const clean = (frag) => (typeof _sanitizePastedHtml === 'function')
      ? _sanitizePastedHtml(frag || '') : (frag || '');
    const summary = details.querySelector(':scope > summary');
    const h = document.createElement('h3');
    h.innerHTML = clean(summary && summary.innerHTML.trim());
    // Body = first non-summary, non-handle child.
    const body = Array.from(details.children).find(c =>
      c.tagName !== 'SUMMARY' && !(c.classList && c.classList.contains('te-dh')));
    const ul = document.createElement('ul');
    if (body) {
      // Descend one level if the body is a single wrapper holding the real lines.
      let container = body;
      const elKids = Array.from(body.children);
      if (elKids.length === 1 && /^(DIV|P)$/.test(elKids[0].tagName) &&
          Array.from(elKids[0].children).some(c => /^(DIV|P|LI)$/.test(c.tagName))) {
        container = elKids[0];
      }
      const lineEls = Array.from(container.children).filter(c => /^(DIV|P|LI)$/.test(c.tagName));
      if (lineEls.length) {
        lineEls.forEach(le => {
          const txt = (le.textContent || '').replace(/​/g, '').trim();
          if (!txt && !le.querySelector('img,a')) return; // skip blank lines
          const li = document.createElement('li');
          li.innerHTML = clean(le.innerHTML);
          ul.appendChild(li);
        });
      } else {
        // No line children — whole body becomes one bullet.
        const li = document.createElement('li');
        li.innerHTML = clean(container.innerHTML);
        if (li.textContent.trim() || li.querySelector('img,a')) ul.appendChild(li);
      }
    }
    const parent = details.parentNode;
    const frag = document.createDocumentFragment();
    frag.appendChild(h);
    if (ul.children.length) frag.appendChild(ul);
    parent.replaceChild(frag, details);
    // Caret into the new heading.
    const r = document.createRange();
    r.selectNodeContents(h); r.collapse(false);
    sel.removeAllRanges(); sel.addRange(r);
    ed.focus();
  };

  // (zip0135) Image insertion. Opens a small modal asking for source
  // (UID lookup or https:// URL), size, and alignment. Inserts a centered
  // <figure> wrapping an <img>, OR a left-floated <img>, depending on
  // chosen alignment. Sizes set width via inline style so the slide layout
  // remains predictable across viewport widths.
  document.getElementById('teImage').onmousedown = (e) => {
    e.preventDefault();
    // Save the current selection so we can restore it after the modal dismisses
    const sel = window.getSelection();
    const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    teShowImageModal((html) => {
      const editor = document.getElementById('teEditor');

      // (zip0138) If the cursor is inside a <details>, insert the image
      // INSIDE that details (right after its <summary>) instead of as a
      // sibling. This keeps the image visually associated with its Q&A
      // card and confines float behavior to that card.
      let insideDetails = null;
      if (range) {
        let n = range.startContainer;
        while (n && n !== editor) {
          if (n.nodeType === 1 && n.tagName === 'DETAILS') { insideDetails = n; break; }
          n = n.parentNode;
        }
      }

      if (insideDetails) {
        const summary = insideDetails.querySelector(':scope > summary');
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        // Insert each child after the summary in order
        const refNode = summary ? summary.nextSibling : insideDetails.firstChild;
        while (tmp.firstChild) {
          insideDetails.insertBefore(tmp.firstChild, refNode);
        }
        editor.focus();
        return;
      }

      // No enclosing details — fall back to inserting at the saved cursor.
      if (range) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      editor.focus();
      document.execCommand('insertHTML', false, html);
    });
  };

  // (zip0137) Slide-wide color pickers. Apply color to the editor element
  // itself (and persist via a wrapping <div class="te-slide" style="color:X;
  // background:Y;"> on save) so the chosen colors travel with the saved
  // ftext content into the slide preview and the Grid fullscreen view.
  document.getElementById('teTextColor').onmousedown = e => {
    e.preventDefault();
    teShowColorPicker(e.currentTarget, 'text');
  };
  document.getElementById('teBgColor').onmousedown = e => {
    e.preventDefault();
    teShowColorPicker(e.currentTarget, 'bg');
  };
  
  // Wire save/close buttons
  // (zip0155) Scope the queries to the freshly-created _textEditorOverlay
  // rather than document. If any stale teSave/teClose nodes remained in
  // the DOM (from a botched previous open), getElementById would return
  // the OLD one and the buttons the user clicks wouldn't fire. The
  // gridOpenTextEditor cleanup at the top of the function should make
  // this redundant in normal flow, but the scoped query is cheap insurance.
  const _ov = _textEditorOverlay;
  _ov.querySelector('#teSave').onclick  = () => textEditorSave();
  _ov.querySelector('#teClose').onclick = () => textEditorClose();
  // (zip0160) Slide button auto-saves before previewing. The S key (when
  // the editor's contenteditable is not focused) also triggers slide.
  _ov.querySelector('#teSlide').onclick = () => {
    _textEditorDoSave(); // save silently (no close, no grid refresh toast)
    textEditorPreviewSlide();
  };
  // (zip0228) Slideshow button — play embedded images as a full-window
  // slideshow. Save first so we play the saved state, not in-progress edits.
  _ov.querySelector('#teSlideshow').onclick = () => {
    _textEditorDoSave();
    if (typeof slideshowOpen === 'function') {
      const editor = document.getElementById('teEditor');
      const html = editor ? editor.innerHTML : (_textEditorRow && _textEditorRow.ftext) || '';
      // (dev0241) Close Xe before opening the slideshow so it doesn't sit
      // behind the slideshow overlay.
      textEditorClose();
      slideshowOpen(html);
    }
  };

  // (zip0160) S key = Slide when the contenteditable editor is NOT focused.
  // When the user clicks outside the editor area (on the toolbar, or on
  // empty space inside the Xe overlay), activeElement reverts to <body> or
  // the overlay — the editor loses focus. At that point, pressing S should
  // trigger the slide preview rather than inserting a letter.
  // (dev0246) Guard Backspace/Delete against merging across a <details>
  // boundary. Without this, hitting Backspace on the empty <p>/<li> below
  // a closed (visually collapsed) <details> silently destroys the details
  // and all its hidden inner content — the worst kind of data loss because
  // the details was invisible at the moment of deletion.
  //
  // New behavior: if you Backspace at the start of an empty block whose
  // previous sibling is a <details>, the empty block is removed (your
  // intent) and the caret is placed at the END of the details body. If
  // the block is NOT empty, we block the merge entirely — the caret moves
  // into the details body so you can continue editing there.
  // Symmetric handling for Delete at end of a block whose next sibling
  // is a <details>.
  _ov.addEventListener('keydown', function(e) {
    if (e.key !== 'Backspace' && e.key !== 'Delete') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const ed = document.getElementById('teEditor');
    if (!ed) return;
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return;
    const range = sel.getRangeAt(0);

    // Find the immediate-child-of-editor block containing the caret
    let block = range.startContainer;
    if (block.nodeType === 3) block = block.parentNode;
    while (block && block.parentNode !== ed && block !== ed) block = block.parentNode;
    if (!block || block === ed) return;

    // Caret at start of block?
    const atStart = (() => {
      if (range.startOffset !== 0) return false;
      let n = range.startContainer;
      while (n && n !== block) {
        if (n.previousSibling) return false;
        n = n.parentNode;
      }
      return true;
    })();
    // Caret at end of block?
    const atEnd = (() => {
      let n = range.startContainer;
      if (n.nodeType === 3 && range.startOffset !== n.length) return false;
      if (n.nodeType === 1 && range.startOffset !== n.childNodes.length) return false;
      while (n && n !== block) {
        if (n.nextSibling) return false;
        n = n.parentNode;
      }
      return true;
    })();

    function placeInDetails(d, end) {
      if (!d.hasAttribute('open')) d.setAttribute('open', '');
      const body = Array.from(d.children).find(c =>
        c.tagName !== 'SUMMARY' && !(c.classList && c.classList.contains('te-dh')));
      if (!body) return;
      const r = document.createRange();
      if (end) { r.selectNodeContents(body); r.collapse(false); }
      else { r.setStart(body, 0); r.collapse(true); }
      sel.removeAllRanges(); sel.addRange(r);
    }
    function blockIsEmpty(b) {
      const txt = (b.textContent || '').replace(/​/g, '').trim();
      if (txt) return false;
      // No images / other media either
      if (b.querySelector && b.querySelector('img,video,table,details')) return false;
      return true;
    }

    if (e.key === 'Backspace' && atStart) {
      const prev = block.previousElementSibling;
      if (prev && prev.tagName === 'DETAILS') {
        e.preventDefault(); e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        const wasEmpty = blockIsEmpty(block);
        if (wasEmpty) block.remove();
        placeInDetails(prev, true /* end */);
      }
    } else if (e.key === 'Delete' && atEnd) {
      const next = block.nextElementSibling;
      if (next && next.tagName === 'DETAILS') {
        e.preventDefault(); e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        const wasEmpty = blockIsEmpty(block);
        if (wasEmpty) block.remove();
        placeInDetails(next, false /* start */);
      }
    }
  }, true);

  // (dev0245) Guard typing/Backspace/Delete/Cut against accidentally erasing
  // a <details> block that's currently selected via its ⋮⋮ handle.
  // Cut is allowed (the cut handler runs separately and is intentional).
  // For other destructive keys, drop the selection and continue with a
  // collapsed caret, so the next character lands at the end of the block
  // instead of replacing it.
  _ov.addEventListener('keydown', function(e) {
    // Allow navigation, selection, copy/cut/paste, formatting, save, undo/redo
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length !== 1 && e.key !== 'Backspace' && e.key !== 'Delete') return;
    const ed = document.getElementById('teEditor');
    if (!ed) return;
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const frag = range.cloneContents();
    if (!(frag.querySelector && frag.querySelector('details'))) return;
    // Selection includes a <details>. Confirm before replacing.
    const ok = window.confirm(
      'Your selection includes a collapsible block. Replace it with the typed key?\n\n' +
      'OK = replace (you can Ctrl+Z to undo)\n' +
      'Cancel = keep the block; caret will move to after it.'
    );
    if (!ok) {
      e.preventDefault(); e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      sel.collapseToEnd();
      ed.querySelectorAll('details.te-selected').forEach(d => d.classList.remove('te-selected'));
    }
    // If user confirmed, let the browser proceed with default behavior.
  }, true);

  // (dev0244/0245) Capture-phase Enter handler — runs BEFORE the browser's
  // native behavior so we can:
  //   (a) Stop a SELECTION-REPLACE delete when the selection includes a
  //       <details> block (e.g. user clicked the ⋮⋮ handle to select it
  //       and then hit Enter — without this guard, contenteditable would
  //       delete the whole block).
  //   (b) Move the caret out of <summary> on Enter (Chrome's native handler
  //       otherwise toggles parent details and discards our caret-move).
  //   (c) Ctrl+Enter / Alt+Enter: exit the current <details> by inserting
  //       a fresh empty <p> AFTER the enclosing details and placing the
  //       caret there. This is the supported way to put a blank row
  //       between detail blocks.
  _ov.addEventListener('keydown', function(e) {
    if (e.key !== 'Enter' || e.metaKey) return;
    const ed = document.getElementById('teEditor');
    if (!ed) return;
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);

    // (a) Selection contains a <details>? Don't let Enter replace-delete it.
    if (!sel.isCollapsed) {
      // Build a list of <details> elements inside the range
      const frag = range.cloneContents();
      if (frag.querySelector && frag.querySelector('details')) {
        e.preventDefault(); e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        // Collapse to AFTER the end of the selection and insert a paragraph
        // so the user gets the new line they intended, without losing data.
        const endContainer = range.endContainer;
        // Find the nearest top-level <details> ancestor of the end of the
        // selection, then place the caret just after it.
        let anchor = endContainer;
        while (anchor && anchor !== ed) {
          if (anchor.nodeType === 1 && anchor.tagName === 'DETAILS' && anchor.parentNode === ed) break;
          anchor = anchor.parentNode;
        }
        if (anchor && anchor.parentNode === ed) {
          const p = document.createElement('p');
          p.appendChild(document.createElement('br'));
          ed.insertBefore(p, anchor.nextSibling);
          const r = document.createRange();
          r.setStart(p, 0); r.collapse(true);
          sel.removeAllRanges(); sel.addRange(r);
          ed.querySelectorAll('details.te-selected').forEach(d => d.classList.remove('te-selected'));
        } else {
          // Fallback: just collapse the selection without deleting
          sel.collapseToEnd();
        }
        return;
      }
    }

    // (c) Ctrl+Enter / Alt+Enter — exit the enclosing <details>
    if ((e.ctrlKey || e.altKey) && !e.shiftKey) {
      let n = range.startContainer;
      let details = null;
      while (n && n !== ed) {
        if (n.nodeType === 1 && n.tagName === 'DETAILS') { details = n; break; }
        n = n.parentNode;
      }
      if (details && details.parentNode === ed) {
        e.preventDefault(); e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        const p = document.createElement('p');
        p.appendChild(document.createElement('br'));
        ed.insertBefore(p, details.nextSibling);
        const r = document.createRange();
        r.setStart(p, 0); r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
        return;
      }
    }

    // (b) Enter inside <summary> → into body
    if (!e.ctrlKey && !e.altKey) {
      let n = range.startContainer;
      let summary = null, details = null;
      while (n && n !== ed && n !== document.body) {
        if (n.nodeType === 1) {
          if (n.tagName === 'SUMMARY' && !summary) summary = n;
          if (n.tagName === 'DETAILS' && !details) details = n;
        }
        n = n.parentNode;
      }
      if (summary && details && ed.contains(summary)) {
        _teHandleEnterInSummary(e, summary, details, ed);
      }
    }
  }, true);

  _ov.addEventListener('keydown', function(e) {
    // (dev0350) Two-stage Esc. If the contenteditable editor is FOCUSED (user is
    // typing), the first Esc just blurs it (focus → the overlay) and stays in Xe;
    // a SECOND Esc (editor no longer focused) leaves Xe. When NOT focused, Esc
    // auto-saves and returns to the previous screen — G if we arrived via a grid
    // ctrl-click (_cameFromGrid), else the revealed screen beneath (T). Xs (slide
    // preview) sits on top with its own Esc, so from Xs the first Esc returns here.
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      const ae = document.activeElement;
      const editorFocused = !!ae && (ae.id === 'teEditor' || (ae.closest && ae.closest('#teEditor')));
      if (editorFocused) {
        ae.blur();
        if (_textEditorOverlay) { try { _textEditorOverlay.focus(); } catch (_) {} }
        return;   // first Esc only unfocuses; stay in Xe
      }
      if (typeof _textEditorDoSave === 'function') _textEditorDoSave();
      const backToGrid = !!window._cameFromGrid;
      textEditorClose();
      if (backToGrid) { window._cameFromGrid = false; if (typeof gridShow === 'function') gridShow(); }
      return;
    }
    if (e.key === 's' || e.key === 'S') {
      // Only fire if the contenteditable editor itself is NOT focused.
      const ae = document.activeElement;
      const editorFocused = ae && (ae.id === 'teEditor' || ae.closest('#teEditor'));
      if (!editorFocused && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        _textEditorDoSave();
        textEditorPreviewSlide();
      }
    }

    // (zip0184) ArrowUp / ArrowDown — navigate filtered rows while Xe is open.
    // (dev0358) BUT only when the contenteditable editor is NOT focused. When the
    // user is typing in #teEditor, arrows must move the TEXT CURSOR (browser
    // default) — not hop to another row. Row navigation happens when focus is
    // outside the editor (after the first Esc blur, or focus on overlay chrome).
    // _brRows is refreshed from the live filter so a filtered T isn't walked into
    // invisible rows. openEditorForRow routes to Xe (text), Ie (image), or Ev.
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const _ae = document.activeElement;
      const _edFocused = !!_ae && (_ae.id === 'teEditor' || (_ae.closest && _ae.closest('#teEditor')));
      if (_edFocused) return;   // typing in the editor → let the arrow move the caret
      e.preventDefault(); e.stopPropagation();

      // Always rebuild from current filter so filtered T navigation stays correct
      window._brRows = (typeof brGetVisibleRows === 'function')
        ? brGetVisibleRows() : (window._brRows || []);
      const rows = window._brRows;
      if (!rows.length) { if (typeof toast === 'function') toast('No visible rows.', 1400); return; }

      // Find current row position
      const di = (typeof data !== 'undefined' && _textEditorRow)
        ? data.indexOf(_textEditorRow) : -1;
      const curFi = di >= 0 ? rows.indexOf(di) : (window._brIdx || 0);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const target = curFi + step;
      if (target < 0 || target >= rows.length) {
        if (typeof toast === 'function')
          toast('No more rows ' + (step > 0 ? 'below' : 'above') + '.', 1400);
        return;
      }
      window._brIdx = target;
      const nextRow = (typeof data !== 'undefined') ? data[rows[target]] : null;
      if (!nextRow) return;

      // (zip0185) Cover the screen so T doesn't flash through the brief
      // window between closing Xe and the next E mounting.
      if (typeof window._veShowHopCover === 'function') window._veShowHopCover();

      // Save current, close Xe, open appropriate editor for next row
      _textEditorDoSave();
      textEditorClose();
      if (typeof window.openEditorForRow === 'function') {
        window.openEditorForRow(nextRow);
      }
    }
  }, true);

  // (zip0161) Swipes on the title bar:
  //   L→R  = auto-save + show slide (Xs preview)
  //   R→L  = auto-save + close Xe (back to T)
  // Attached to title bar only so drags inside the editor don't trigger.
  const titleBar = _textEditorOverlay.querySelector('#teBox > div');
  if (titleBar) {
    let sStart = null;
    titleBar.addEventListener('pointerdown', e => {
      // (dev0243) Strict scope: only treat as a swipe start if the pointerdown
      // landed on the title bar itself or a non-interactive span inside it.
      // Buttons (Save/Close/Slide/etc.) handle their own clicks and must not
      // double-fire as a swipe. The editor/toolbar/footer never get here
      // because the listener is attached to the title bar only — but this
      // check defends against rare bubbling-from-popup edge cases too.
      const t = e.target;
      if (!t || (t.tagName === 'BUTTON' || (t.closest && t.closest('button')))) {
        sStart = null;
        return;
      }
      sStart = { x: e.clientX, y: e.clientY, t: Date.now(), tgt: t };
    });
    titleBar.addEventListener('pointerup', e => {
      if (!sStart) return;
      const dx = e.clientX - sStart.x;
      const dy = e.clientY - sStart.y;
      const ms = Date.now() - sStart.t;
      sStart = null;
      if (Math.abs(dx) < 40 || Math.abs(dy) >= Math.abs(dx) || ms > 800) return;
      if (dx > 0) {
        // L→R: save + preview slide
        _textEditorDoSave();
        textEditorPreviewSlide();
      } else {
        // R→L: save + close Xe
        _textEditorDoSave();
        textEditorClose();
      }
    });
    titleBar.addEventListener('pointercancel', () => { sStart = null; });
  }
  
  // Keyboard handling on editor
  editor.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      textEditorSave();
    }
    // (zip0182) Esc no longer closes Xe — the global handler in core.js blurs
    // the contenteditable instead. Xe edits are auto-saved on row change /
    // explicit close, so there's no "cancel" path; Esc is now purely a defocus.
    // (zip0161) Enter/Shift+Enter collapsible section handling:
    //
    //  Inside <summary>:
    //    Enter alone    → move cursor into the body <div> (natural navigation)
    //    Shift+Enter    → insert <br> for a multi-line summary header
    //
    //  Outside any <details>:
    //    Shift+Enter    → insert a new empty collapsible block
    //                     (same as clicking the ▶… toolbar button)
    //
    //  Inside <details> body (not <summary>):
    //    Shift+Enter    → normal line break (browser default)
    if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const sel = window.getSelection();
      if (!sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      // Walk up to find enclosing <summary> or <details>
      let summary = null, details = null;
      let n = range.startContainer;
      while (n && n !== editor) {
        if (n.nodeType === 1) {
          if (n.tagName === 'SUMMARY' && !summary) summary = n;
          if (n.tagName === 'DETAILS' && !details) details = n;
        }
        n = n.parentNode;
      }

      if (summary) {
        // (dev0244) Delegate to the shared handler; the early capture-phase
        // listener on the overlay also calls into this path. Kept here as
        // a defense for browsers where the capture listener might be bypassed.
        if (_teHandleEnterInSummary(e, summary, details, editor)) return;
      }

      if (!details && e.shiftKey) {
        // Shift+Enter outside any details → insert new collapsible block
        e.preventDefault();
        const colHtml = '<details><summary></summary><div><br></div></details><p></p>';
        document.execCommand('insertHTML', false, colHtml);
        // Move cursor into the newly inserted <summary>
        setTimeout(() => {
          const summaries = editor.querySelectorAll('details > summary');
          const last = summaries[summaries.length - 1];
          if (last) {
            const r = document.createRange();
            r.setStart(last, 0);
            r.collapse(true);
            const s = window.getSelection();
            s.removeAllRanges();
            s.addRange(r);
          }
        }, 0);
        return;
      }
      // All other cases: let browser handle normally
    }
    // Allow Ctrl+B, Ctrl+I, Ctrl+U to work naturally
  });

  // (dev0242) Paste handler that preserves <details> / hidden content.
  // When the user cuts content containing collapsed <details> from inside
  // the editor, the clipboard's text/html holds the full markup — but
  // contenteditable's default paste sometimes drops uncommon tags. Bypass
  // the default by inserting clipboard HTML verbatim. Also: when cutting,
  // make sure the selection's serialized HTML includes the inner DOM of
  // any closed <details> in range (browsers already do this for the
  // Selection API, but we force a clean serialization on cut to be safe).
  editor.addEventListener('paste', e => {
    const cd = e.clipboardData || window.clipboardData;
    if (!cd) return;
    const html = cd.getData('text/html');
    if (html && /<details[\s>]/i.test(html)) {
      // Deliberate <details> paste (e.g. an internal block copy via the cut
      // handler) — preserve the exact structure, don't sanitize it away.
      e.preventDefault();
      // Strip <html>/<body>/<meta> wrappers some browsers add
      let frag = html.replace(/^[\s\S]*?<body[^>]*>|<\/body>[\s\S]*$/gi, '');
      // Strip Office/Google clipboard junk classes but keep the structure
      frag = frag.replace(/<!--[\s\S]*?-->/g, '');
      document.execCommand('insertHTML', false, frag);
      return;
    }
    // (dev0341) Rich web paste — run it through the shared sanitizer so editor
    // pastes don't bloat ftext with <style> blocks, inline styles, class= and
    // framework junk (the 904_d_d <style>-tail problem). Plain-text pastes have
    // no text/html and fall through to the browser default.
    if (html && html.trim() && typeof _sanitizePastedHtml === 'function') {
      const clean = _sanitizePastedHtml(html);
      if (clean) {
        e.preventDefault();
        document.execCommand('insertHTML', false, clean);
        return;
      }
    }
    // Otherwise: let the browser handle normally (plain text or simple html)
  });
  // On cut, force-serialize the full selection (including closed <details>
  // contents) into text/html. The Selection API includes hidden DOM in the
  // range so this is generally already correct, but we set it explicitly so
  // a later paste anywhere gets the full structure.
  editor.addEventListener('cut', e => {
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const container = document.createElement('div');
    container.appendChild(range.cloneContents());
    if (!/<details[\s>]/i.test(container.innerHTML)) return; // no hidden content involved
    e.preventDefault();
    const cd = e.clipboardData || window.clipboardData;
    cd.setData('text/html', container.innerHTML);
    cd.setData('text/plain', container.textContent);
    range.deleteContents();
  });

  // (zip0136) Double-click on an inserted image opens the image modal
  // pre-filled with the image's current src and size, so the user can
  // resize, re-align, or replace it. The original <img> is removed and
  // a new one inserted at the same position with the chosen settings.
  editor.addEventListener('dblclick', e => {
    if (!e.target || e.target.tagName !== 'IMG') return;
    e.preventDefault(); e.stopPropagation();
    teEditImage(e.target);
  });
  
  // (dev0243) Click outside box to close — but only on a clean click,
  // not a drag-release that started inside the editor. Without this guard,
  // a R→L mouse drag inside the text area that releases on the overlay
  // strip beyond the box (right:340px gap) used to fire as an outside
  // click and close Xe.
  let _ovDownTarget = null;
  _textEditorOverlay.addEventListener('pointerdown', e => { _ovDownTarget = e.target; });
  _textEditorOverlay.addEventListener('click', e => {
    if (e.target === _textEditorOverlay && _ovDownTarget === _textEditorOverlay) {
      textEditorClose();
    }
    _ovDownTarget = null;
  });
  
  // Focus editor after a short delay
  setTimeout(() => {
    if (opts.skipEditorFocus) {
      // (zip0179) Arrived here via row-to-row arrow navigation — keep focus
      // on the overlay so ArrowUp/Down keep walking rows instead of moving
      // the caret inside the text. User can click into the editor to type.
      _textEditorOverlay.focus();
    } else {
      editor.focus();
      // If default text, select it
      if (editor.innerHTML.includes('Your content here')) {
        document.execCommand('selectAll', false, null);
      }
    }
    // (zip0134) Clean stray empty <details> on open so the user doesn't see
    // the residual caret/dropdown UI from previously saved malformed content.
    _sanitizeTextEditorHtml(editor);
    // (dev0243) Add a left-edge selection handle to every <details> so
    // users can click ⋮⋮ to select the entire block, then Ctrl+X / Ctrl+V.
    _teEnsureDetailsHandles(editor);
    // Click on a handle selects its <details> for cut/paste.
    editor.addEventListener('click', e => {
      const h = e.target && e.target.closest && e.target.closest('.te-dh');
      if (!h) return;
      e.preventDefault(); e.stopPropagation();
      const d = h.closest('details');
      if (d) _teSelectDetails(d);
    });
    // Re-run handle injection after any DOM change (typing creates new
    // <details> via the toolbar, paste injects more, etc.).
    const mo = new MutationObserver(() => _teEnsureDetailsHandles(editor));
    mo.observe(editor, { childList: true, subtree: true });
    editor._teHandleObserver = mo;
    // (zip0137) If saved content has a .te-slide wrapper with a background,
    // paint the editor surface so the user sees the slide colors while editing.
    teSyncEditorBgFromWrapper();
    // (dev0278) Live size/junk readout, refreshed as the user edits.
    editor.addEventListener('input', teUpdateStats);
    teUpdateStats();
    // Pre-fill and wire the video URL bar
    const _li = document.getElementById('teLinkInput');
    if (_li) {
      _li.value = _textEditorRow.link || '';
      const _lpBtn = document.getElementById('teLinkPaste');
      if (_lpBtn) _lpBtn.onclick = async () => {
        try { const t = (await navigator.clipboard.readText()).trim(); if (t) _li.value = t; } catch (_e) {}
      };
    }
  }, 100);
}

// (dev0278) Live size/junk readout in the Xe header. Junk = strippable
// markup (inline styles/classes, framework attrs, empty wrappers); image/link
// URLs are treated as content, not junk. Turns red at ≥15% junk to flag a
// bloated paste that's worth re-cleaning.
function teUpdateStats() {
  const ed = document.getElementById('teEditor');
  const out = document.getElementById('teStats');
  if (!ed || !out || typeof ftextStats !== 'function') return;
  const s = ftextStats(ed.innerHTML);
  const kb = s.bytes >= 1024 ? (s.bytes / 1024).toFixed(1) + ' KB' : s.bytes + ' B';
  out.textContent = '· ' + kb + ' · ' + s.textPct + '% text'
    + (s.junkPct > 0 ? ' · ⚠ ' + s.junkPct + '% junk' : '');
  out.style.color = s.junkPct >= 15 ? '#f88' : '#9ab';
}

// (zip0160) Save-without-close helper. Writes the current editor HTML back
// to the row and calls save(), but does NOT close the overlay or update the
// grid cell. Used by the Slide button (auto-save before preview) and could
// be called from Ctrl+S if we want a non-destructive save in the future.
function _textEditorDoSave() {
  const editor = document.getElementById('teEditor');
  if (!editor || !_textEditorRow) return false;
  _sanitizeTextEditorHtml(editor);
  const html = editor.innerHTML.trim();
  _textEditorRow.ftext = html;
  _textEditorRow.DateModified = isoNow();
  const _liD = document.getElementById('teLinkInput');
  if (_liD !== null) _textEditorRow.link = _liD.value.trim();
  if (!_textEditorRow.link) _textEditorRow.VidRange = 'text';
  save();
  return true;
}

function textEditorSave() {
  const editor = document.getElementById('teEditor');
  if (!editor || !_textEditorRow) return;

  // (zip0134) Sanitize stray empty <details> elements that contenteditable
  // sometimes leaves behind (e.g. when the user adds a collapsible block,
  // edits the contents, and the wrapper ends up with only a stray <p></p>
  // and no <summary>). Removing them prevents the empty caret-with-text
  // dropdown that the user reported.
  _sanitizeTextEditorHtml(editor);

  const html = editor.innerHTML.trim();

  // Check if we need a title (first h1 or h2)
  if (!html.match(/<h[12][^>]*>.*?\S.*?<\/h[12]>/i)) {
    const title = prompt('Enter a title for this slide:', '');
    if (title) {
      editor.innerHTML = '<h2>' + title + '</h2>' + html;
    }
  }

  // Save ftext to the row (keeps existing video/image data)
  _textEditorRow.ftext = editor.innerHTML.trim();
  _textEditorRow.DateModified = isoNow();
  const _liS = document.getElementById('teLinkInput');
  if (_liS !== null) _textEditorRow.link = _liS.value.trim();

  // Only set VidRange to 'text' if there's no media link
  if (!_textEditorRow.link) {
    _textEditorRow.VidRange = 'text';
  }

  save();
  textEditorClose();

  // Refresh grid cell
  gridUpdateCell(_textEditorCell, _textEditorRow);
  toast('✓ Saved text slide', 1000);
}

// (zip0134/0135) Walk the editor DOM and remove malformed <details>
// elements that contenteditable can produce. Only removes ones with NO
// <summary> child at all — that's the "stray <details><p></p></details>"
// pattern the user reported. Empty <summary> is allowed because the user
// may have just inserted a fresh collapsible and not yet typed in it.
function _sanitizeTextEditorHtml(rootEl) {
  if (!rootEl) return;
  const allDetails = rootEl.querySelectorAll('details');
  allDetails.forEach(d => {
    const summaries = d.querySelectorAll(':scope > summary');
    if (summaries.length === 0) d.remove();
  });
  // (dev0243) Strip transient drag-handles before content is read for save —
  // handles are UI chrome, not part of the saved ftext.
  rootEl.querySelectorAll('.te-dh').forEach(h => h.remove());
  rootEl.querySelectorAll('details.te-selected').forEach(d => d.classList.remove('te-selected'));
}

// (dev0243) Ensure every <details> in the editor has a small left-edge
// handle the user can click to select the whole block (for cut/paste).
// Idempotent — safe to call after insertions, pastes, or sanitize calls.
function _teEnsureDetailsHandles(rootEl) {
  if (!rootEl) return;
  rootEl.querySelectorAll('details').forEach(d => {
    if (d.querySelector(':scope > .te-dh')) return;
    const h = document.createElement('span');
    h.className = 'te-dh';
    h.setAttribute('contenteditable', 'false');
    h.setAttribute('title', 'Click to select this block — then Ctrl+X to cut, Ctrl+V to paste');
    h.textContent = '⋮⋮';
    d.insertBefore(h, d.firstChild);
  });
}

// (dev0244) Move the caret out of a <summary> and into its parent <details>
// body on Enter. Returns true if handled. Uses requestAnimationFrame so the
// selection survives the browser's native summary/Enter handling (which on
// Chrome can otherwise toggle the details open/closed and discard our move).
function _teHandleEnterInSummary(e, summary, details, editor) {
  if (!summary || !details) return false;
  e.preventDefault();
  e.stopPropagation();
  if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();

  if (e.shiftKey) {
    document.execCommand('insertLineBreak', false, null);
    return true;
  }

  // Force the details open so the body is layout-visible and can receive caret
  if (!details.hasAttribute('open')) details.setAttribute('open', '');

  // Ensure a body <div> exists with at least a <br> so the caret has a target
  let bodyEl = Array.from(details.children).find(c => c.tagName !== 'SUMMARY'
    && !(c.classList && c.classList.contains('te-dh')));
  if (!bodyEl) {
    bodyEl = document.createElement('div');
    bodyEl.appendChild(document.createElement('br'));
    details.appendChild(bodyEl);
  }
  if (!bodyEl.firstChild) bodyEl.appendChild(document.createElement('br'));

  // Defer the caret move to the next frame so any native Enter-in-summary
  // behavior (toggle, focus shuffle) completes first, then we win.
  const place = () => {
    try {
      // Make body explicitly editable (defense — should already inherit)
      if (editor && editor.isContentEditable) {
        const sel = window.getSelection();
        const r = document.createRange();
        // Prefer placing inside the first text node if present, else before <br>
        const first = bodyEl.firstChild;
        if (first && first.nodeType === 3) {
          r.setStart(first, 0);
        } else {
          r.setStart(bodyEl, 0);
        }
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
        // Belt and braces: also use Selection.collapse
        if (typeof sel.collapse === 'function') sel.collapse(bodyEl, 0);
        editor.focus();
      }
    } catch (_) {}
  };
  requestAnimationFrame(place);
  // Also try immediately in case rAF is starved
  place();
  return true;
}

// Select the entire <details> element so Ctrl+X / Ctrl+C captures it
// (including all hidden inner content).
function _teSelectDetails(detailsEl) {
  if (!detailsEl) return;
  const editor = document.getElementById('teEditor');
  if (editor) {
    editor.querySelectorAll('details.te-selected').forEach(d => d.classList.remove('te-selected'));
  }
  detailsEl.classList.add('te-selected');
  const range = document.createRange();
  range.selectNode(detailsEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  if (editor) editor.focus();
}

// (dev0359) ── Safe formatBlock for the H1–H6 / P toolbar buttons ───────────
// Background: document.execCommand('formatBlock') is destructive inside a
// <details>. With the caret in a <summary> it wraps the whole <details> in the
// heading and orphans the body into a second, summary-less <details>; with a
// multi-paragraph selection it merges the paragraphs into one block of <br>s.
// This helper keeps the native command (and its undo history) for the common
// safe case — a single block that is NOT a summary and NOT inside a <details>
// — and falls back to a manual, structure-preserving re-tag otherwise.
const _TE_BLOCK_RE = /^(P|H[1-6]|DIV|SUMMARY|LI|BLOCKQUOTE)$/;

// Innermost block-level ancestor of `node` within the editor (or null).
function _teNearestBlock(ed, node) {
  let n = (node && node.nodeType === 3) ? node.parentNode : node;
  while (n && n !== ed) {
    if (n.tagName && _TE_BLOCK_RE.test(n.tagName)) return n;
    n = n.parentNode;
  }
  return null;
}

// A heading inside a <summary> still belongs to the summary — never re-tag it
// directly (that yields invalid <summary><p>…). Snap such a block up to its
// enclosing <summary> so the summary path handles it.
function _teSnapToSummary(ed, b) {
  if (b && b.closest) {
    const sm = b.closest('summary');
    if (sm && ed.contains(sm)) return sm;
  }
  return b;
}

// Resize a <summary> WITHOUT breaking the <details>: a summary legally holds a
// single heading element, so H1–H6 wrap its content in that heading (margin:0
// keeps it on the marker line); P/DIV unwrap any existing heading back to a
// plain summary.
function _teSetSummaryHeading(summary, tag) {
  if (!summary) return;
  const inner = summary.querySelector(
    ':scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6');
  if (/^H[1-6]$/i.test(tag)) {
    const h = document.createElement(tag);
    h.setAttribute('style', 'margin:0');
    if (inner) { while (inner.firstChild) h.appendChild(inner.firstChild); summary.replaceChild(h, inner); }
    else { while (summary.firstChild) h.appendChild(summary.firstChild); summary.appendChild(h); }
  } else if (inner) {
    while (inner.firstChild) summary.insertBefore(inner.firstChild, inner);
    summary.removeChild(inner);
  }
}

// Re-tag one block in place, preserving its children. Summaries and list items
// get special handling so the surrounding structure survives.
function _teRetagBlock(b, tag) {
  if (!b) return;
  if (b.tagName === 'SUMMARY') { _teSetSummaryHeading(b, tag); return; }
  if (b.tagName === 'LI') return; // don't turn list items into headings
  if (b.tagName.toLowerCase() === String(tag).toLowerCase()) return;
  const el = document.createElement(tag);
  while (b.firstChild) el.appendChild(b.firstChild);
  b.parentNode.replaceChild(el, b);
}

function _teFormatBlock(tag) {
  const ed = document.getElementById('teEditor');
  if (!ed) return;
  const sel = window.getSelection();
  if (!sel.rangeCount) { ed.focus(); return; }

  // Block selected via its ⋮⋮ handle → resize its summary (the title).
  const selDetails = ed.querySelector('details.te-selected');
  if (selDetails) {
    _teRetagBlock(selDetails.querySelector(':scope > summary'), tag);
    ed.focus();
    return;
  }

  const range = sel.getRangeAt(0);
  const startEl = range.startContainer.nodeType === 3 ? range.startContainer.parentNode : range.startContainer;
  const endEl   = range.endContainer.nodeType === 3   ? range.endContainer.parentNode   : range.endContainer;
  const b1 = _teSnapToSummary(ed, _teNearestBlock(ed, startEl));
  const b2 = _teSnapToSummary(ed, _teNearestBlock(ed, endEl));
  const inDetails = !!((startEl.closest && startEl.closest('details')) ||
                       (endEl.closest && endEl.closest('details')));
  const summaryTouched = (b1 && b1.tagName === 'SUMMARY') || (b2 && b2.tagName === 'SUMMARY');

  // Safe case: leave it to the native command (keeps undo history + list logic).
  if (!inDetails && !summaryTouched) { document.execCommand('formatBlock', false, tag); return; }
  if (!b1 || !b2) { document.execCommand('formatBlock', false, tag); return; }

  // Manual path — collect the block siblings spanned and re-tag each in place.
  let blocks;
  if (b1 === b2) {
    blocks = [b1];
  } else if (b1.parentNode === b2.parentNode) {
    blocks = [];
    let n = b1;
    while (n) {
      if (n.tagName && _TE_BLOCK_RE.test(n.tagName)) blocks.push(n);
      if (n === b2) break;
      n = n.nextElementSibling;
    }
    if (!blocks.length || blocks[blocks.length - 1] !== b2) blocks = [b1, b2];
  } else {
    blocks = [b1, b2];
  }
  blocks.forEach(b => _teRetagBlock(b, tag));
  ed.focus();
}

// (zip0137) Slide-wide color picker. Two modes: 'text' sets the slide's
// text color, 'bg' sets the background color. Applied to a wrapping
// <div class="te-slide" style="..."> around the editor content so the
// colors travel with the saved HTML into the slide preview and the Grid
// fullscreen view. If no wrapper exists, one is created on first use.
function teShowColorPicker(anchorBtn, mode) {
  // Remove any existing picker so re-clicking the same button toggles
  const old = document.getElementById('teColorPicker');
  if (old) { old.remove(); return; }

  const COLORS = [
    { v: '',         label: 'default' },                      // unset → reset
    { v: '#ffffff',  label: 'white' },
    { v: '#000000',  label: 'black' },
    { v: '#ff4444',  label: 'red' },
    { v: '#ff8c00',  label: 'orange' },
    { v: '#ffd700',  label: 'yellow' },
    { v: '#44cc44',  label: 'green' },
    { v: '#4488ff',  label: 'blue' },
    { v: '#aa66ff',  label: 'purple' },
    { v: '#aaaaaa',  label: 'gray' },
    { v: '#0a0a1a',  label: 'editor-bg' },                    // matches default editor bg
  ];

  const r = anchorBtn.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.id = 'teColorPicker';
  pop.style.cssText = 'position:fixed;z-index:36800;background:#0d0d1e;'
    + 'border:1px solid #4af;border-radius:8px;padding:8px;'
    + 'box-shadow:0 6px 24px rgba(0,0,0,0.7);'
    + 'left:' + r.left + 'px;top:' + (r.bottom + 4) + 'px;'
    + 'display:grid;grid-template-columns:repeat(6,1fr);gap:6px;';

  COLORS.forEach(c => {
    const sw = document.createElement('button');
    sw.style.cssText = 'width:28px;height:28px;border:1px solid #555;'
      + 'border-radius:4px;cursor:pointer;'
      + 'background:' + (c.v || 'repeating-linear-gradient(45deg,#444,#444 4px,#222 4px,#222 8px)')
      + ';' + (c.v === '#ffffff' ? 'border-color:#888;' : '');
    sw.title = c.label + (c.v ? ' (' + c.v + ')' : ' — clear/reset');
    sw.onclick = () => {
      teApplySlideColor(mode, c.v);
      pop.remove();
    };
    pop.appendChild(sw);
  });

  // Click outside to dismiss
  function onDoc(e) {
    if (!pop.contains(e.target) && e.target !== anchorBtn) {
      pop.remove();
      document.removeEventListener('mousedown', onDoc, true);
    }
  }
  document.addEventListener('mousedown', onDoc, true);

  document.body.appendChild(pop);
}

// Ensure the editor body content is wrapped in a single .te-slide div, then
// set or clear color/background on that wrapper. Mode is 'text' or 'bg'.
// Empty value clears the property.
function teApplySlideColor(mode, value) {
  const editor = document.getElementById('teEditor');
  if (!editor) return;
  let wrap = editor.querySelector(':scope > div.te-slide');
  if (!wrap) {
    // Wrap all current content in a fresh .te-slide div
    wrap = document.createElement('div');
    wrap.className = 'te-slide';
    while (editor.firstChild) wrap.appendChild(editor.firstChild);
    editor.appendChild(wrap);
  }
  if (mode === 'text') {
    if (value) wrap.style.color = value;
    else wrap.style.removeProperty('color');
  } else if (mode === 'bg') {
    if (value) {
      wrap.style.background = value;
      // Also paint the editor surface so the user sees the result while editing
      editor.style.background = value;
    } else {
      wrap.style.removeProperty('background');
      editor.style.background = '';
    }
  }
  // If wrapper has no remaining inline styles, unwrap it again so the
  // saved HTML stays clean.
  if (!wrap.getAttribute('style')) {
    while (wrap.firstChild) editor.insertBefore(wrap.firstChild, wrap);
    wrap.remove();
    // Restore default editor background when text-mode wrapper goes away
    if (mode !== 'bg') editor.style.background = '';
  }
}

// On editor open, sync the editor surface to the saved wrapper's
// background so the user sees what they saved. (Text color comes through
// naturally because of CSS inheritance from the wrapper.)
function teSyncEditorBgFromWrapper() {
  const editor = document.getElementById('teEditor');
  if (!editor) return;
  const wrap = editor.querySelector(':scope > div.te-slide');
  if (wrap && wrap.style.background) {
    editor.style.background = wrap.style.background;
  }
}


// (zip0135) Image insertion modal for the text/HTML slide editor.
// Asks for source (UID number → looked up in data; or full URL) plus size
// and alignment, then calls the supplied callback with the HTML to insert
// at the user's cursor position.
//
// Size choices use inline width style so the slide layout is predictable
// regardless of viewport. "Small / Medium / Large / Full" map to fixed
// widths that work on the slide preview overlay (≤ 1200px wide).
//
// (zip0136) Optional `defaults` arg pre-fills the form so dblclick-to-edit
// can show the existing image's current settings: { src, size, align }.
function teShowImageModal(onInsert, defaults) {
  defaults = defaults || {};
  // Remove any existing modal so re-clicking the button doesn't stack
  const old = document.getElementById('teImageModal');
  if (old) old.remove();

  const dSrc   = defaults.src   || '';
  const dSize  = defaults.size  || 'medium';
  const dAlign = defaults.align || 'center';
  const isEdit = !!defaults.src;

  const modal = document.createElement('div');
  modal.id = 'teImageModal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:36500;'
    + 'background:rgba(0,0,0,0.7);display:flex;align-items:center;'
    + 'justify-content:center;font-family:monospace;';
  modal.innerHTML = `
    <div style="background:#0d0d1e;border:2px solid #4af;border-radius:10px;
                padding:18px 22px;min-width:420px;max-width:560px;color:#eee;
                box-shadow:0 12px 40px rgba(0,0,0,0.9);">
      <div style="display:flex;align-items:center;margin-bottom:14px;">
        <h2 style="margin:0;font-size:14px;color:#8ef;flex:1;">🖼 ${isEdit ? 'Edit image' : 'Insert image'}</h2>
        <button id="teImgClose" style="background:none;border:1px solid #555;color:#aaa;
                padding:3px 9px;border-radius:5px;cursor:pointer;font-family:monospace;">✕</button>
      </div>

      <label style="display:block;font-size:11px;color:#8ef;margin-bottom:4px;">
        Source — UID number (looks up row.link) or full https:// URL
      </label>
      <input id="teImgSrc" type="text" autocomplete="off" placeholder="e.g. 27   or   https://example.com/foo.jpg"
        value="${dSrc.replace(/"/g, '&quot;')}"
        style="width:100%;box-sizing:border-box;padding:6px 8px;background:#0a0a1a;
               border:1px solid #555;color:#fff;border-radius:4px;font-family:monospace;
               font-size:13px;outline:none;margin-bottom:12px;">

      <fieldset style="border:1px solid #333;border-radius:6px;padding:8px 12px;
                       margin-bottom:10px;">
        <legend style="color:#8ef;font-size:11px;padding:0 6px;">Size</legend>
        <label style="margin-right:14px;cursor:pointer;"><input type="radio" name="teImgSize" value="small"${dSize==='small'?' checked':''}>  Small (200px)</label>
        <label style="margin-right:14px;cursor:pointer;"><input type="radio" name="teImgSize" value="medium"${dSize==='medium'?' checked':''}>  Medium (400px)</label>
        <label style="margin-right:14px;cursor:pointer;"><input type="radio" name="teImgSize" value="large"${dSize==='large'?' checked':''}>  Large (700px)</label>
        <label style="cursor:pointer;"><input type="radio" name="teImgSize" value="full"${dSize==='full'?' checked':''}>  Full width</label>
      </fieldset>

      <fieldset style="border:1px solid #333;border-radius:6px;padding:8px 12px;
                       margin-bottom:14px;">
        <legend style="color:#8ef;font-size:11px;padding:0 6px;">Alignment</legend>
        <label style="margin-right:14px;cursor:pointer;"><input type="radio" name="teImgAlign" value="left"${dAlign==='left'?' checked':''}>  Left (text wraps right)</label>
        <label style="margin-right:14px;cursor:pointer;"><input type="radio" name="teImgAlign" value="center"${dAlign==='center'?' checked':''}>  Centered</label>
        <label style="cursor:pointer;"><input type="radio" name="teImgAlign" value="right"${dAlign==='right'?' checked':''}>  Right (text wraps left)</label>
      </fieldset>

      <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;">
        <label style="color:#8ef;font-size:11px;white-space:nowrap;flex-shrink:0;">Caption</label>
        <input id="teImgCaption" type="text" placeholder="optional — shows below image in small font"
          style="flex:1;padding:5px 8px;background:#0a0a1a;border:1px solid #555;color:#fff;
                 border-radius:4px;font-family:monospace;font-size:12px;outline:none;">
        <button id="teImgCaptionPaste" title="Paste from clipboard"
          style="background:#222;border:1px solid #555;color:#aaa;padding:5px 8px;
                 border-radius:4px;cursor:pointer;flex-shrink:0;">📋</button>
      </div>

      <div style="text-align:right;">
        <button id="teImgCancel" style="background:#222;border:1px solid #555;color:#aaa;
                padding:6px 14px;border-radius:5px;cursor:pointer;font-family:monospace;
                font-size:13px;margin-right:6px;">Cancel</button>
        <button id="teImgInsert" style="background:#0a3052;border:1px solid #4af;color:#8ef;
                padding:6px 18px;border-radius:5px;cursor:pointer;font-family:monospace;
                font-size:13px;">${isEdit ? 'Replace' : 'Insert'}</button>
      </div>
      <div id="teImgErr" style="color:#f88;font-size:11px;margin-top:8px;min-height:14px;"></div>
    </div>`;
  document.body.appendChild(modal);

  // Resolve a "source" (UID or URL) into an actual image URL.
  // Returns { url } on success, { error } on failure.
  function resolveSrc(raw) {
    const v = (raw || '').trim();
    if (!v) return { error: 'Source is empty.' };
    if (/^https?:\/\//i.test(v)) {
      // Full URL — accept as-is
      return { url: v };
    }
    // Treat as UID lookup. Accept numeric or alphanumeric.
    const row = (typeof data !== 'undefined' && Array.isArray(data))
      ? data.find(r => r && String(r.UID) === v) : null;
    if (!row) return { error: 'No row with UID "' + v + '"' };
    if (!row.link) return { error: 'Row UID "' + v + '" has no link.' };
    if (!/\.(jpg|jpeg|png|gif|webp|svg|bmp|avif)(\?|#|$)/i.test(row.link)) {
      return { error: 'Row UID "' + v + '" link is not an image file.\n' + row.link.slice(0, 60) };
    }
    return { url: row.link };
  }

  // Build the HTML for a given URL + size + alignment + optional caption.
  function buildHtml(url, size, align, caption) {
    const widthMap  = { small: '200px', medium: '400px', large: '700px', full: '100%' };
    const w = widthMap[size] || '400px';
    const cap = caption ? caption.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : '';
    const capHtml = cap
      ? '<div style="font-size:0.78em;color:#aaa;text-align:center;margin-top:3px;">' + cap + '</div>'
      : '';
    if (align === 'left') {
      if (cap) return '<div style="float:left;margin:6px 14px 6px 0;width:' + w + ';">'
        + '<img src="' + url + '" style="width:100%;border-radius:4px;" alt="">' + capHtml + '</div>';
      return '<img src="' + url + '" style="float:left;width:' + w + ';margin:6px 14px 6px 0;'
        + 'border-radius:4px;" alt="">';
    }
    if (align === 'right') {
      if (cap) return '<div style="float:right;margin:6px 0 6px 14px;width:' + w + ';">'
        + '<img src="' + url + '" style="width:100%;border-radius:4px;" alt="">' + capHtml + '</div>';
      return '<img src="' + url + '" style="float:right;width:' + w + ';margin:6px 0 6px 14px;'
        + 'border-radius:4px;" alt="">';
    }
    // Centered: wrap in figure/div with margin auto for predictable centering.
    return '<div style="text-align:center;margin:12px 0;">'
      + '<img src="' + url + '" style="max-width:100%;width:' + w + ';display:inline-block;'
      + 'border-radius:4px;" alt="">'
      + capHtml + '</div>';
  }

  function close() { modal.remove(); }
  modal.querySelector('#teImgClose').onclick = close;
  modal.querySelector('#teImgCancel').onclick = close;
  modal.addEventListener('click', e => { if (e.target === modal) close(); });

  function doInsert() {
    const srcRaw = modal.querySelector('#teImgSrc').value;
    const size  = (modal.querySelector('input[name="teImgSize"]:checked')  || {}).value || 'medium';
    const align = (modal.querySelector('input[name="teImgAlign"]:checked') || {}).value || 'center';
    const caption = (modal.querySelector('#teImgCaption').value || '').trim();
    const r = resolveSrc(srcRaw);
    if (r.error) {
      modal.querySelector('#teImgErr').textContent = r.error;
      return;
    }
    const html = buildHtml(r.url, size, align, caption);
    close();
    if (typeof onInsert === 'function') onInsert(html);
  }
  modal.querySelector('#teImgInsert').onclick = doInsert;
  modal.querySelector('#teImgSrc').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); doInsert(); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  // Esc anywhere on the modal closes
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      document.removeEventListener('keydown', onKey, true);
      close();
    }
  }
  document.addEventListener('keydown', onKey, true);

  // Wire caption paste button
  modal.querySelector('#teImgCaptionPaste').onclick = async () => {
    try {
      const t = (await navigator.clipboard.readText()).trim();
      if (t) modal.querySelector('#teImgCaption').value = t;
    } catch (_e) {}
  };

  // Auto-focus source; if empty and clipboard holds a URL, pre-fill it
  setTimeout(async () => {
    const srcInput = modal.querySelector('#teImgSrc');
    if (!srcInput.value) {
      try {
        const t = (await navigator.clipboard.readText()).trim();
        if (/^https?:\/\//i.test(t)) srcInput.value = t;
      } catch (_e) {}
    }
    srcInput.focus();
  }, 30);
}

// (zip0136) Inspect an existing <img> in the editor and open the image
// modal pre-filled with its current settings, so the user can resize,
// re-align, or replace the source. On Replace, the original <img> (or its
// wrapping centered-figure <div>) is removed and the new HTML inserted at
// that position.
function teEditImage(img) {
  if (!img || img.tagName !== 'IMG') return;

  // Recover settings from the inline style we wrote in buildHtml.
  // src: try the data-source-uid attribute first (TODO if added later);
  //      fall back to img.src.
  const src = img.getAttribute('src') || '';

  // Try to map current width back to one of our named sizes. If the width
  // doesn't match exactly (user resized via DevTools or pasted from
  // elsewhere), default to medium.
  const w = (img.style.width || '').trim();
  let size = 'medium';
  if (w === '200px')      size = 'small';
  else if (w === '400px') size = 'medium';
  else if (w === '700px') size = 'large';
  else if (w === '100%')  size = 'full';

  // Alignment: left-floated images have float:left; right-floated have
  // float:right; centered ones live inside a wrapping <div style="text-align:center">.
  let align = 'center';
  const float = (img.style.float || '').trim();
  if (float === 'left')  align = 'left';
  if (float === 'right') align = 'right';

  // Identify the node we'll replace. For centered images that's the
  // wrapping div; for floated images it's the img itself.
  const wrapper = img.parentElement;
  const isCenteredWrap = wrapper && wrapper.tagName === 'DIV'
    && /text-align\s*:\s*center/i.test(wrapper.getAttribute('style') || '');
  const replaceTarget = isCenteredWrap ? wrapper : img;

  // If the source is a UID-resolved URL (i.e. matches some row.link),
  // pre-fill the source field with the UID rather than the raw URL.
  let displaySrc = src;
  if (typeof data !== 'undefined' && Array.isArray(data)) {
    const row = data.find(r => r && r.link === src);
    if (row && row.UID !== undefined) displaySrc = String(row.UID);
  }

  teShowImageModal((html) => {
    // Replace the old node with a temp marker, then insert HTML at the
    // marker position via execCommand to preserve undo history.
    const marker = document.createElement('span');
    marker.id = 'te-img-replace-marker';
    replaceTarget.parentNode.replaceChild(marker, replaceTarget);

    // Place caret at the marker so insertHTML lands here
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNode(marker);
    sel.removeAllRanges();
    sel.addRange(range);

    document.getElementById('teEditor').focus();
    document.execCommand('insertHTML', false, html);

    // Marker should be replaced by insertHTML, but tidy up if not
    const stale = document.getElementById('te-img-replace-marker');
    if (stale) stale.remove();
  }, { src: displaySrc, size: size, align: align });
}

// (zip0134) Slide preview: render the saved-or-current ftext at full screen
// the way it appears when clicked from the Grid. Closes via R-to-L swipe,
// Esc, or click outside.
function textEditorPreviewSlide() {
  const editor = document.getElementById('teEditor');
  if (!editor) return;
  // Use the live editor content (not the saved row) so user can preview
  // unsaved changes.
  const rawHtml = editor.innerHTML.trim();
  // (zip0168) Linkify URLs at render time so old ftext also displays
  // clickable links, even if the editor's HTML was plain text URLs.
  const html = (typeof renderFtext === 'function') ? renderFtext(rawHtml) : rawHtml;
  // Reuse the slide rendering style from gridOpenFullscreen.
  const old = document.getElementById('teSlideOverlay');
  if (old) old.remove();
  const ov = document.createElement('div');
  ov.id = 'teSlideOverlay';
  ov.style.cssText = 'position:fixed;inset:0;z-index:36000;background:#0a0a1a;'
    + 'display:flex;align-items:center;justify-content:center;padding:40px;';
  ov.innerHTML = `
    <style>#teSlideContent a { color: #5bf; }
      #teSlideContent table{border-collapse:collapse;margin:12px 0;max-width:100%;}
      #teSlideContent th,#teSlideContent td{border:1px solid #999;padding:6px 10px;text-align:left;vertical-align:top;}
      #teSlideContent th{font-weight:bold;}
      #teSlideContent h3{font-size:1.25em;color:#9ef;}
      #teSlideContent h4{font-size:1.1em;color:#adf;}
      #teSlideContent h5{font-size:1em;color:#bdf;}
      #teSlideContent h6{font-size:0.9em;color:#cdf;}
      #teSlideContent small{font-size:0.8em;opacity:0.85;}</style>
    <div id="teSlideTopBar" style="position:absolute;top:0;left:0;right:0;height:64px;
         display:flex;align-items:center;justify-content:space-between;
         padding:0 16px;background:#3a4d75;border-bottom:2px solid #6af;">
      <span style="font-family:monospace;font-size:13px;color:#cde;">
        ← Swipe on this bar to go back · Esc to go back
      </span>
      <div style="display:flex;gap:8px;align-items:center;">
        <button id="teSlideshowFromSlide" style="background:rgba(80,40,0,0.45);border:1px solid #fc8;color:#fc8;
                padding:4px 12px;border-radius:4px;cursor:pointer;font-family:monospace;font-size:12px;"
                title="Play embedded images as a full-window slideshow (5s/slide, click or Esc to exit).">
          ▶▶ Slideshow
        </button>
        <button id="teSlideClose" style="background:#1a1a2e;border:1px solid #555;color:#aaa;
                padding:4px 10px;border-radius:4px;cursor:pointer;font-family:monospace;">
          ✕ Close
        </button>
      </div>
    </div>
    <div id="teSlideContent" style="max-width:1200px;width:100%;color:#fff;
                font-family:sans-serif;font-size:24px;line-height:1.6;
                background:#0a0a1a;padding:40px 60px;border-radius:8px;
                max-height:90vh;overflow-y:auto;margin-top:64px;">${html}</div>
  `;
  document.body.appendChild(ov);

  function close() {
    document.removeEventListener('keydown', onKey, true);
    ov.remove();
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      close();
    }
  }
  document.addEventListener('keydown', onKey, true);
  ov.querySelector('#teSlideClose').onclick = close;
  // (zip0228) Slideshow button on the Xs top bar — plays images from the
  // ftext currently being previewed. stopPropagation so the overlay's
  // outside-click handler doesn't fire and close Xs underneath.
  const ssBtn = ov.querySelector('#teSlideshowFromSlide');
  if (ssBtn) {
    ssBtn.onclick = (e) => {
      e.stopPropagation();
      // (dev0241) Close Xs before opening the slideshow so it doesn't sit
      // behind the slideshow overlay.
      if (typeof close === 'function') close();
      if (typeof slideshowOpen === 'function') slideshowOpen(rawHtml);
    };
  }
  // Click outside content closes
  ov.addEventListener('click', e => { if (e.target === ov) close(); });

  // (zip0161) R→L swipe on the top bar (only) closes Xs, returning to Xe.
  // Using the top bar instead of the whole overlay avoids accidental dismissal
  // while scrolling the slide content.
  // (zip0174) Updated to use rotateXY so swipe direction is correct in
  // CSS-rotated portrait mode on phones.
  const topBar = ov.querySelector('#teSlideTopBar');
  let sStart = null;
  topBar.addEventListener('pointerdown', e => {
    const _p = window.rotateXY ? window.rotateXY(e) : { x: e.clientX, y: e.clientY };
    sStart = { x: _p.x, y: _p.y, t: Date.now() };
  });
  topBar.addEventListener('pointerup', e => {
    if (!sStart) return;
    const _p = window.rotateXY ? window.rotateXY(e) : { x: e.clientX, y: e.clientY };
    const dx = _p.x - sStart.x;
    const dy = _p.y - sStart.y;
    const ms = Date.now() - sStart.t;
    sStart = null;
    if (dx < -40 && Math.abs(dy) < Math.abs(dx) && ms < 800) close();
  });
  topBar.addEventListener('pointercancel', () => { sStart = null; });
}

function textEditorClose() {
  // (zip0183) Sync T's focus to the last Xe row before clearing state, so
  // pressing T/G/A from Xe leaves the selection on the row that was open.
  if (_textEditorRow && typeof window._setFocusToRow === 'function') {
    window._setFocusToRow(_textEditorRow);
  }
  if (_textEditorOverlay) {
    const ed = _textEditorOverlay.querySelector('#teEditor');
    if (ed && ed._teHandleObserver) { ed._teHandleObserver.disconnect(); ed._teHandleObserver = null; }
    _textEditorOverlay.remove();
    _textEditorOverlay = null;
  }
  const style = document.getElementById('teStyles');
  if (style) style.remove();
  _textEditorCell = null;
  _textEditorRow = null;
}

function gridClose() {
  gridCleanupPlayers();
  gridClearCut();
  gridHideContextMenu();
  textEditorClose();
  document.getElementById('gridOverlay').style.display = 'none';
  document.getElementById('gridFullscreen').style.display = 'none';
  buildTable(); // Refresh table to show any cell swaps
}
