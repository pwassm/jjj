
// ══════════════════════════════════════════════════════════════════════════════
// TEXT SLIDE EDITOR (contentEditable rich text for ftext column)
// ══════════════════════════════════════════════════════════════════════════════
let _textEditorOverlay = null;
let _textEditorCell = null;
let _textEditorRow = null;
// (dev0378) Which row field the editor reads/writes. Default 'ftext' (slides /
// quizzes). T's `ttxt` column and C's `ctxt` column open the SAME editor with
// opts.field set, so the rich-text/Save plumbing is shared. Non-ftext fields
// skip the slide-only side effects (title prompt, link binding, VidRange).
let _textEditorField = 'ftext';

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
  _textEditorField = (opts && opts.field) || 'ftext';

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

  // (dev0590) Xe v2 (TipTap schema editor) — (dev0620) now the DEFAULT; opt out
  // via the header "v1" button / localStorage 'xe2'='0' / ?xe2=0. Delegates to
  // the schema editor where <details> can't be corrupted; the v1 contenteditable
  // path below is untouched and is the fallback if v2 is off or open() fails.
  // See xe2.js / memory project_xe_editor_rebuild.
  if (window.XE2 && window.XE2.isEnabled() && window.XE2.open(cellStr, row, opts)) {
    return;
  }

  // (zip0168) Linkify URL patterns in existing ftext so the editor shows
  // clickable links. On save, the linkified HTML persists — old plain-text
  // URLs become anchor tags after the first edit-save cycle.
  const rawExisting = row[_textEditorField] || '';
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
      <div id="teHeaderBar" title="Swipe ← (drag right-to-left) to save and go back" style="display:flex; justify-content:space-between; align-items:center;
                  padding:22px 16px; min-height:64px; touch-action:none;
                  border-bottom:2px solid #6af; background:#3a4d75;">
        <span style="color:#ff8; font-weight:bold;">Text Slide · ${cellStr}${mediaNote} <span style="color:#89a;font-weight:normal;font-size:11px;">· swipe ← to go back</span></span>
        <span id="teStats" style="color:#9ab; font-weight:normal; font-size:11px; font-family:monospace;" title="ftext size · % real text · % strippable junk (inline styles/classes/empty wrappers; image & link URLs are NOT junk)"></span>
        <span id="teSaved" style="color:#6d8; font-weight:normal; font-size:11px; font-family:monospace; white-space:nowrap;" title="Last autosave — ftext is written to the row ~1s after you stop typing"></span>
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
        <button class="te-btn" id="teCollapse" title="Insert empty collapsible section (opens; type a summary, then add anything inside — including images/tables)">▶…</button>
        <button class="te-btn" id="teWrap" title="Wrap current selection in a collapsible section — turns multi-line content, pictures, or tables into a hideable block">[▶…]</button>
        <button class="te-btn" id="teWrap2" title="Wrap selection as a collapsible, split into title + detail — the FIRST line becomes the click-to-expand summary, the remaining lines become the hidden body">[[2]]</button>
        <button class="te-btn" id="teUndetail" title="Undetail — turn the collapsible block at the cursor back into a heading (H3) with a bullet list of its lines underneath (inverse of [▶…])">Un[▶]</button>
        <button class="te-btn" id="teLineBefore" title="Blank line ABOVE the detail block at the cursor — inserted OUTSIDE the block, so new text there is not absorbed into it (same as Ctrl+Shift+Enter)">¶↑</button>
        <button class="te-btn" id="teLineAfter" title="Blank line BELOW the detail block at the cursor — inserted OUTSIDE the block, so new text there is not absorbed into it (same as Ctrl+Enter)">¶↓</button>
        <button class="te-btn" id="teExpandAll" title="Expand all collapsible blocks in this slide">▼ All</button>
        <button class="te-btn" id="teCollapseAll" title="Collapse all collapsible blocks in this slide">▶ All</button>
        <button class="te-btn" id="teCut" title="Hide the SELECTED text/lines from the rendered slide (grid, Xs, exports) while keeping it here in Xe as reference notes. Select a region first — everything AFTER it still renders. Click the banner above a hidden block to show it again.">⊘ Hide</button>
        <button class="te-btn" id="teHr" title="Insert a divider line across the page — separates sections (renders as a horizontal rule in the slide)">══</button>
        <button class="te-btn" id="teImage" title="Insert image — accepts UID number or https:// URL, with size and alignment">🖼</button>
        <button class="te-btn" id="teLink" title="Link the selected text — enter any URL (a bare domain like pwassm.github.io/braintrain is auto-prefixed with https://). Select link text first; blank URL removes the link.">🔗</button>
        <span style="width:1px; background:#444; margin:0 6px;"></span>
        <button class="te-btn" id="teTextColor"  title="Slide-wide text color — choose one for the whole slide">A▾</button>
        <button class="te-btn" id="teBgColor"    title="Slide-wide background color">▣▾</button>
        <span style="width:1px; background:#444; margin:0 6px;"></span>
        <button class="te-btn" id="teErase" style="border-color:#a44; color:#f99;" title="Erase ALL text in this slide — the reliable equivalent of Ctrl+A then Backspace (which can leave a stray block behind). The slide's colors are kept.">🗑 Erase all</button>
      </div>
      
      <!-- Editor area - FULLSCREEN -->
      <div id="teEditor" style="
        flex:1; overflow-y:auto;
        padding:24px 32px; color:#fff; font-family:sans-serif; font-size:18px; line-height:1.7;
        background:#0a0a1a; outline:none; cursor:text;
        -webkit-user-modify:read-write; -moz-user-modify:read-write;
      ">${existingText || ''}</div>

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
        Ctrl+B/I/U · Ctrl+S save+close · Esc close · S = slide · brisk drag ← anywhere = save+back to T/G (slow drag still selects text) · Shift+Enter new collapsible · ¶↑/¶↓ or Ctrl(+Shift)+Enter = blank line outside block · ⋮⋮ handle = select block to hide/move
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
    /* (dev0592) Working, CONSISTENT heading ladder. dev0591 flattened every
       heading to the body size, which made H1–H6 look like no-ops (changing size
       is their whole job). Restored here as ONE em ladder used verbatim in every
       render context (editor + Xs + iframe + grid), so an H-level is the SAME size
       everywhere — a summary H1 == a body H1. That cross-context mismatch (same
       tag, different size) was the ORIGINAL "hard to make text the same size"
       complaint; identical em values fix it while keeping the buttons useful. */
    #teSlideContent summary, #teSlideContent summary a { color:#8ef !important; }
    #teEditor p, #teEditor div, #teEditor summary, #teEditor li, #teEditor span {
      font-size:18px; font-weight:normal; color:#fff;
    }
    #teEditor h1, #teEditor h2, #teEditor h3, #teEditor h4, #teEditor h5, #teEditor h6 {
      color:#fff; font-weight:bold; margin:0 0 8px; line-height:1.25;
    }
    #teEditor h1 { font-size:2em; }
    #teEditor h2 { font-size:1.5em; }
    #teEditor h3 { font-size:1.25em; }
    #teEditor h4 { font-size:1.1em; }
    #teEditor h5 { font-size:1em; }
    #teEditor h6 { font-size:0.9em; }
    #teEditor small { font-size:0.8em; opacity:0.85; }
    /* (dev0619) A slide-wide text color (A▾ → inline color on the .te-slide
       wrapper) must WIN over the editor's default white element rules above —
       inheritance loses to any direct element rule, so the chosen color never
       showed in Xe (all-white) and only partially in Xs (headings/summaries
       kept their own colors → mixed lines). Scope: only slides whose wrapper
       carries an explicit color. Links stay #5bf for readability. */
    #teEditor .te-slide[style*="color:"] :is(p,div,summary,li,span,h1,h2,h3,h4,h5,h6) { color:inherit; }
    #teSlideContent .te-slide[style*="color:"] summary { color:inherit !important; }
    #teEditor a, #teEditor summary a { color:#5bf !important; }
    #teSlideContent small { font-size:0.8em; opacity:0.85; }
    #teEditor p { margin:0 0 8px; }
    /* (dev0379) No bullets — not needed and they disrupt formatting. */
    #teEditor ul, #teEditor ol { list-style:none !important; margin:8px 0; padding-left:0 !important; }
    #teEditor li { list-style:none !important; margin:0 0 4px; }
    /* (dev0360) ══ divider line */
    #teEditor hr, #teSlideContent hr { border:none; border-top:2px solid #4a5a7a; margin:16px 0; height:0; }
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
      content:'⊘ Hidden from the rendered slide — click here to show it again.';
      position:absolute; top:-12px; left:8px;
      background:#3a0a0a; color:#fcc; border:1px solid #f88;
      padding:2px 8px; border-radius:4px; font-size:10px;
      font-family:monospace; cursor:pointer; user-select:none;
    }
    /* (dev0379) Summary now matches detail lines (white, normal weight, same
       size — set in the uniform rule above). Keep it clickable + a hit area. */
    #teEditor summary { cursor:pointer; padding:4px 0;
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

  // (dev0247, redesigned dev0594) ⊘ Hide — wrap the SELECTED region in a
  // <div class="te-cut">. Hidden in every render context (CSS sets display:none
  // for .te-cut globally); shown faded with a banner inside #teEditor so the
  // user can still see/edit/recover it. Unlike the old "Cut" (which parked
  // everything from the caret to the END of the slide — burying content the
  // user still wanted rendered), this hides ONLY the selection, so anything
  // after it keeps rendering. Class name stays 'te-cut' for backward
  // compatibility with content already hidden in saved rows.
  document.getElementById('teCut').onmousedown = (e) => {
    e.preventDefault();
    const ed = document.getElementById('teEditor');
    if (!ed) return;
    const sel = window.getSelection();
    if (!sel.rangeCount) { ed.focus(); return; }
    const range = sel.getRangeAt(0);
    // Hide operates on a REGION. With no selection there's nothing to bound, so
    // prompt for one rather than silently hiding everything below (the old bug).
    if (sel.isCollapsed) {
      if (typeof toast === 'function') toast('Select the text or lines to hide first, then click Hide', 1800);
      return;
    }
    // If the selection is already inside a .te-cut, no-op.
    let n = range.commonAncestorContainer;
    while (n && n !== ed) {
      if (n.nodeType === 1 && n.classList && n.classList.contains('te-cut')) {
        if (typeof toast === 'function') toast('That is already hidden', 1200);
        return;
      }
      n = n.parentNode;
    }
    const frag = range.extractContents();
    const wrap = document.createElement('div');
    wrap.className = 'te-cut';
    wrap.appendChild(frag);
    if (!wrap.textContent.trim() && !wrap.querySelector('img,video,details,table')) {
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      wrap.appendChild(p);
    }
    range.insertNode(wrap);
    // Place caret just AFTER the hidden block so writing continues in the
    // still-visible content below it. Create a fresh <p> if nothing follows.
    let after = wrap.nextSibling;
    if (!after) {
      after = document.createElement('p');
      after.appendChild(document.createElement('br'));
      ed.appendChild(after);
    }
    const r = document.createRange();
    r.selectNodeContents(after);
    r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
    ed.focus();
    if (typeof toast === 'function') toast('Hidden — click the banner to show it again', 1500);
  };

  // (dev0594) 🗑 Erase all — the reliable equivalent of Ctrl+A + Backspace.
  // Native select-all-delete can leave a stray block (the dev0593 corruption
  // that swallows new content); this hard-resets to one clean empty paragraph.
  // The .te-slide colour wrapper is preserved (empty) so an erase keeps the
  // slide's text/background theme.
  document.getElementById('teErase').onmousedown = (e) => {
    e.preventDefault();
    const ed = document.getElementById('teEditor');
    if (!ed) return;
    const only = ed.children.length === 1 ? ed.children[0] : null;
    const slideWrap = (only && only.classList && only.classList.contains('te-slide')) ? only : null;
    const host = slideWrap || ed;
    host.innerHTML = '<p><br></p>';
    const target = host.querySelector('p') || host;
    const r = document.createRange();
    r.selectNodeContents(target);
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(r);
    ed.focus();
    if (typeof toast === 'function') toast('Erased all text', 1000);
  };

  // Click the faded banner to SHOW hidden content again — unwrap the .te-cut
  // div in place, restoring its children as direct children of the editor.
  document.getElementById('teEditor').addEventListener('click', e => {
    const cut = e.target && e.target.classList && e.target.classList.contains('te-cut')
      ? e.target : null;
    if (!cut) return;
    // Only the banner area (the ::before pseudo) is clickable for unhide —
    // detect by checking the click Y is within the banner band (top 24px).
    const rect = cut.getBoundingClientRect();
    if (e.clientY - rect.top > 24) return;
    e.preventDefault(); e.stopPropagation();
    while (cut.firstChild) cut.parentNode.insertBefore(cut.firstChild, cut);
    cut.remove();
    if (typeof toast === 'function') toast('Shown again', 900);
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

  // (dev0360) [[2]] — wrap selection as a collapsible, SPLIT: the first line
  // becomes the summary (click-to-expand title), the rest becomes the hidden
  // body. Empty selection → empty collapsible (same fallback as [▶…]).
  document.getElementById('teWrap2').onmousedown = (e) => {
    e.preventDefault();
    const ed = document.getElementById('teEditor');
    if (!ed) return;
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) {
      document.getElementById('teCollapse').onmousedown(e);
      return;
    }
    const range = sel.getRangeAt(0);
    let container = range.commonAncestorContainer;
    if (container.nodeType === 3) container = container.parentNode;
    if (!ed.contains(container)) return;
    const frag = range.extractContents();
    const parts = _teSplitFirstLine(frag);
    const details = document.createElement('details');
    details.setAttribute('open', '');
    const summary = document.createElement('summary');
    summary.appendChild(parts.first);
    const body = document.createElement('div');
    body.appendChild(parts.rest);
    if (!body.childNodes.length) {
      const p = document.createElement('p'); p.appendChild(document.createElement('br')); body.appendChild(p);
    }
    details.appendChild(summary);
    details.appendChild(body);
    range.insertNode(details);
    const r = document.createRange();
    r.selectNodeContents(summary); r.collapse(false);
    sel.removeAllRanges(); sel.addRange(r);
    ed.focus();
  };

  // (dev0360) ══ Draw line — insert a full-width divider (horizontal rule) at
  // the caret to separate sections. Trailing <p> gives a spot to keep typing.
  document.getElementById('teHr').onmousedown = (e) => {
    e.preventDefault();
    const ed = document.getElementById('teEditor');
    if (!ed) return;
    ed.focus();
    document.execCommand('insertHTML', false, '<hr class="te-hr"><p><br></p>');
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
    // (dev0587) extractContents() across a collapsible boundary splits the
    // <details>, leaving a summary-less fragment the save-time sanitizer then
    // deletes — the hidden body vanishes. Refuse when the selection only
    // partly overlaps a details (fully-inside is safe).
    if (_teRangePartlyCrossesDetails(ed, range)) {
      if (typeof toast === 'function') toast('Selection crosses a collapsible block — select inside it', 2400);
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

  // (dev0381) Link — wrap the selected text in an <a> so any text (not just a
  // bare https:// URL) becomes a clickable link in the Xs slide. A bare domain
  // (e.g. pwassm.github.io/braintrain) is auto-prefixed with https://. With the
  // caret inside an existing link, this edits its href; a blank URL removes it.
  document.getElementById('teLink').onmousedown = (e) => {
    e.preventDefault();
    const ed = document.getElementById('teEditor');
    if (!ed) return;
    const sel = window.getSelection();
    if (!sel.rangeCount) { if (typeof toast === 'function') toast('Select the text to link first', 1400); return; }
    const range = sel.getRangeAt(0).cloneRange();
    let anc = range.commonAncestorContainer;
    if (anc.nodeType === 3) anc = anc.parentNode;
    if (!ed.contains(anc)) return;
    const existingA = anc.closest ? anc.closest('a') : null;
    if (sel.isCollapsed && !existingA) { if (typeof toast === 'function') toast('Select the text to link first', 1400); return; }
    const selText = range.toString().trim();
    const promptLbl = selText ? ('"' + (selText.length > 40 ? selText.slice(0, 40) + '…' : selText) + '"') : 'this link';
    // (dev0382) Default the prompt to the SELECTED text when it already looks
    // like a domain/URL, so selecting "pwassm.github.io/braintrain" and clicking
    // 🔗 yields the right link in one step. Previously the prompt defaulted to a
    // bare "https://"; accepting that (thinking the selection was the URL) made
    // href="https://" — a broken link. Else fall back to "https://".
    const _looksUrl = s => /^(https?:\/\/)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(\/\S*)?$/i.test(s);
    const _defUrl = existingA ? (existingA.getAttribute('href') || '')
      : (_looksUrl(selText) ? selText : 'https://');
    let url = prompt('Link URL for ' + promptLbl
      + '\n\nMy sites:\n  sealifeandmore.org  (WordPress — Instagram videos)\n  pwassm.github.io/braintrain\n\n(leave blank to remove the link)',
      _defUrl);
    if (url === null) return;            // cancelled
    url = url.trim();
    // Blank URL → unwrap an existing link (no-op otherwise).
    if (!url) {
      if (existingA && ed.contains(existingA)) {
        const parent = existingA.parentNode;
        while (existingA.firstChild) parent.insertBefore(existingA.firstChild, existingA);
        parent.removeChild(existingA);
      }
      ed.focus();
      return;
    }
    // Add a scheme for bare domains so the link actually resolves.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
    // Reject a scheme-only / hostless URL (e.g. just "https://") so we never
    // create a broken link that errors when clicked.
    const _hostOk = /^https?:\/\/[^\s\/]+\.[^\s\/]+/i.test(url) || /^(mailto:|tel:)/i.test(url);
    if (!_hostOk) {
      if (typeof toast === 'function') toast('That isn’t a full web address — no link made', 2000);
      ed.focus();
      return;
    }
    // Editing an existing anchor → just update it.
    if (existingA && ed.contains(existingA)) {
      existingA.setAttribute('href', url);
      existingA.setAttribute('target', '_blank');
      existingA.setAttribute('rel', 'noopener');
      ed.focus();
      return;
    }
    // Wrap the selection in a fresh anchor.
    const frag = range.extractContents();
    const a = document.createElement('a');
    a.setAttribute('href', url);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener');
    a.style.color = '#5bf';
    a.appendChild(frag);
    range.insertNode(a);
    const r = document.createRange();
    r.selectNodeContents(a);
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

  // (dev0573) ¶↑ / ¶↓ — blank line ABOVE / BELOW the detail block at the caret,
  // inserted OUTSIDE the block. Button twins of Ctrl+Shift+Enter / Ctrl+Enter:
  // the WYSIWYG problem was that new lines typed next to a <details> get
  // absorbed INTO it; these guarantee an independent paragraph. Work on the
  // block whether it's collapsed or expanded (caret in summary or body).
  document.getElementById('teLineBefore').onmousedown = (e) => {
    e.preventDefault();
    _teInsertLineAroundDetails('before');
  };
  document.getElementById('teLineAfter').onmousedown = (e) => {
    e.preventDefault();
    _teInsertLineAroundDetails('after');
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
  // (dev0592) R→L drag on the header bar = save + return to G/T (mirrors the Xs
  // top-bar swipe). The editor body can't host the gesture — a drag there selects
  // text — so the header is the swipe zone. Pointer events cover mouse + touch.
  (function wireXeHeaderSwipeBack() {
    const bar = _ov.querySelector('#teHeaderBar');
    if (!bar) return;
    let s = null;
    const xy = (e) => window.rotateXY ? window.rotateXY(e) : { x: e.clientX, y: e.clientY };
    bar.addEventListener('pointerdown', (e) => {
      if (e.target && e.target.closest && e.target.closest('button')) return; // let buttons work
      const p = xy(e); s = { x: p.x, y: p.y, t: Date.now() };
      try { bar.setPointerCapture(e.pointerId); } catch (_) {}
    });
    bar.addEventListener('pointerup', (e) => {
      if (!s) return;
      const p = xy(e), dx = p.x - s.x, dy = p.y - s.y, ms = Date.now() - s.t;
      s = null;
      if (dx < -60 && Math.abs(dy) < Math.abs(dx) && ms < 900) textEditorSave();
    });
    bar.addEventListener('pointercancel', () => { s = null; });
  })();
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

  // (dev0245, removed dev0594) The confirm() dialog that popped up when a
  // selection including a <details> was about to be replaced by a keystroke is
  // gone — the user found the warning unwanted and wants detail blocks to
  // delete like any other selected content. Native selection-replace now
  // proceeds silently (Ctrl+Z still undoes it). The dev0246 Backspace/Delete
  // boundary guard above (which silently protects an INVISIBLE collapsed
  // details from being merged away) is intentionally kept — it isn't a warning.

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
        let anchor = endContainer, aDetails = null;
        while (anchor && anchor !== ed) {
          if (anchor.nodeType === 1 && anchor.tagName === 'DETAILS') aDetails = anchor;  // (dev0589) outermost
          anchor = anchor.parentNode;
        }
        if (aDetails) {
          const p = document.createElement('p');
          p.appendChild(document.createElement('br'));
          // (dev0589) Sibling of the details in its own parent (may be a
          // .te-slide color wrapper), not forced to be a direct child of ed.
          aDetails.parentNode.insertBefore(p, aDetails.nextSibling);
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

    // (c0) Ctrl/Alt+Shift+Enter — insert an empty line ABOVE the enclosing
    // <details>. (dev0379) Solves the "can't type above a details block sitting
    // at the very top of the editor" problem: there's no preceding node to click
    // into, and Enter is reserved for collapse/navigation. Mirror of (c) below.
    if ((e.ctrlKey || e.altKey) && e.shiftKey) {
      let n = range.startContainer, details = null;
      while (n && n !== ed) {
        if (n.nodeType === 1 && n.tagName === 'DETAILS') details = n;
        n = n.parentNode;
      }
      // (dev0589) Insert the blank line as a sibling of the outermost <details>
      // in ITS OWN parent (which may be a .te-slide color wrapper, not the
      // editor). The old "must be a direct child of ed" guard failed inside a
      // wrapper and dropped the line at the very top of the whole slide.
      if (details) {
        e.preventDefault(); e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        const p = document.createElement('p');
        p.appendChild(document.createElement('br'));
        details.parentNode.insertBefore(p, details);
        const r = document.createRange();
        r.setStart(p, 0); r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
        return;
      }
    }

    // (c) Ctrl+Enter / Alt+Enter — exit the enclosing <details> (line BELOW it)
    if ((e.ctrlKey || e.altKey) && !e.shiftKey) {
      let n = range.startContainer;
      let details = null;
      while (n && n !== ed) {
        if (n.nodeType === 1 && n.tagName === 'DETAILS') details = n;  // (dev0589) outermost
        n = n.parentNode;
      }
      // (dev0589) Sibling of the outermost <details> in its own parent — works
      // whether that parent is the editor or a .te-slide color wrapper.
      if (details) {
        e.preventDefault(); e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        const p = document.createElement('p');
        p.appendChild(document.createElement('br'));
        details.parentNode.insertBefore(p, details.nextSibling);
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
    // (dev0626) Alt+S = Slide preview from ANYWHERE in Xe — including while
    // typing in the editor (bare S below only fires unfocused). e.code so a
    // keyboard-layout Alt-composition can't hide the S.
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyS') {
      e.preventDefault();
      e.stopPropagation();
      _textEditorDoSave();
      textEditorPreviewSlide();
      return;
    }
    if (e.key === 's' || e.key === 'S') {
      // Only fire if the contenteditable editor itself is NOT focused.
      const ae = document.activeElement;
      const editorFocused = ae && (ae.id === 'teEditor' || ae.closest('#teEditor'));
      if (!editorFocused && !e.ctrlKey && !e.metaKey && !e.altKey) {
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

  // (zip0161) Swipe on the title bar:
  //   L→R  = auto-save + show slide (Xs preview)
  // (dev0573) The R→L branch moved OFF the title bar: it's now the overlay-wide
  // FAST flick below (the title-bar-only zone was too easy to miss).
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
      if (dx < 40 || Math.abs(dy) >= dx || ms > 800) return;
      // L→R: save + preview slide
      _textEditorDoSave();
      textEditorPreviewSlide();
    });
    titleBar.addEventListener('pointercancel', () => { sStart = null; });
  }

  // (dev0573) FAST R→L flick ANYWHERE on Xe = auto-save + leave (back to G if we
  // arrived from the grid, else reveal T underneath) — mirrors the Esc exit.
  // (dev0579) Rework: the old gate (≥120px within 250ms measured over the WHOLE
  // gesture) only caught lightning flicks — a natural brisk drag takes 350-600ms
  // and never fired. Now we sample pointermove into a short trail and gate on
  // RELEASE VELOCITY (the last ~160ms of travel): a brisk right-to-left drag
  // triggers no matter how long the whole gesture took, while a slow selection
  // drag — or a fast drag that STOPS before release (careful text selection) —
  // never does. Gestures that start on a button or input are ignored (those own
  // their own pointer UX). Capture phase so child handlers can't hide the
  // gesture; no preventDefault, so clicks/selection are never interfered with.
  {
    let _flick = null;          // { trail: [{x,y,t}, …] } while the pointer is down
    const TAIL_MS = 160;        // velocity window: movement just before release
    _textEditorOverlay.addEventListener('pointerdown', e => {
      const t = e.target;
      if (t && t.closest && t.closest('button, input')) { _flick = null; return; }
      _flick = { trail: [{ x: e.clientX, y: e.clientY, t: Date.now() }] };
    }, true);
    _textEditorOverlay.addEventListener('pointermove', e => {
      if (!_flick) return;
      const now = Date.now();
      _flick.trail.push({ x: e.clientX, y: e.clientY, t: now });
      // Prune so trail[0] stays the newest sample ≥ TAIL_MS old — the anchor
      // the release velocity is measured against.
      while (_flick.trail.length > 2 && _flick.trail[1].t < now - TAIL_MS) _flick.trail.shift();
    }, true);
    _textEditorOverlay.addEventListener('pointerup', e => {
      if (!_flick) return;
      const anchor = _flick.trail[0];
      _flick = null;
      const dx = e.clientX - anchor.x;
      const dy = e.clientY - anchor.y;
      const ms = Math.max(1, Date.now() - anchor.t);
      if (dx > -80) return;                          // real leftward travel at release
      if (Math.abs(dy) > Math.abs(dx) * 0.6) return; // mostly horizontal
      if (Math.abs(dx) / ms < 0.45) return;          // px/ms — brisk, not a slow select
      _textEditorDoSave();
      const backToGrid = !!window._cameFromGrid;
      textEditorClose();
      if (backToGrid) { window._cameFromGrid = false; if (typeof gridShow === 'function') gridShow(); }
    }, true);
    _textEditorOverlay.addEventListener('pointercancel', () => { _flick = null; }, true);
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
      // (dev0572) The editor now opens BLANK (or with the row's existing text) —
      // no "Title / Your content here" placeholder to select-all over.
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
    // (dev0572) Autosave as you type. Xe already saves on Esc / Slide / swipe;
    // this makes in-progress typing durable too (esp. the reserved HTML
    // instruction cell), writing ftext back to the row + ml.json ~0.9s after the
    // last keystroke. Debounced so a long paragraph isn't a save per character.
    // The timeout re-checks that the editor is still mounted before saving, so a
    // late tick after Close is a silent no-op; textEditorClose also clears it.
    // (dev0573) The save WAS happening but was invisible — save() doesn't repaint
    // the T table, so its ftext column looked stale ("autosave isn't working").
    // Now: the #teSaved header stamp confirms each autosave live (cleared the
    // moment you type again), and textEditorClose re-renders T on the way out.
    editor.addEventListener('input', () => {
      const _sv = document.getElementById('teSaved');
      if (_sv) _sv.textContent = '';
      clearTimeout(window._teAutosaveTimer);
      window._teAutosaveTimer = setTimeout(() => {
        if (document.getElementById('teEditor') && typeof _textEditorDoSave === 'function') {
          if (_textEditorDoSave()) {
            const _sv2 = document.getElementById('teSaved');
            if (_sv2) _sv2.textContent = '✓ autosaved ' + new Date().toTimeString().slice(0, 8);
          }
        }
      }, 900);
    });
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
  _textEditorRow[_textEditorField] = html;
  _textEditorRow.DateModified = isoNow();
  // (dev0378) link binding + VidRange='text' are slide-only (ftext). Editing
  // ttxt/ctxt must not touch the row's media link or range.
  if (_textEditorField === 'ftext') {
    const _liD = document.getElementById('teLinkInput');
    if (_liD !== null) _textEditorRow.link = _liD.value.trim();
    if (!_textEditorRow.link) _textEditorRow.VidRange = 'text';
  }
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

  // (dev0378) link/VidRange are slide-only (ftext). ttxt/ctxt are free-form
  // details blocks — save them verbatim without those rituals.
  // (dev0573) The "Enter a title for this slide" prompt is GONE: the first line
  // of the slide IS its title — no separate stored copy, so it auto-updates
  // whenever the first line is edited. (H2-style it via the toolbar if wanted.)
  const _slideField = (_textEditorField === 'ftext');

  // Save to the bound field (keeps existing video/image data)
  _textEditorRow[_textEditorField] = editor.innerHTML.trim();
  _textEditorRow.DateModified = isoNow();
  if (_slideField) {
    const _liS = document.getElementById('teLinkInput');
    if (_liS !== null) _textEditorRow.link = _liS.value.trim();
    // Only set VidRange to 'text' if there's no media link
    if (!_textEditorRow.link) {
      _textEditorRow.VidRange = 'text';
    }
  }

  save();
  textEditorClose();

  // Refresh grid cell (ftext slides only — ttxt/ctxt don't drive a grid cell)
  if (_slideField) gridUpdateCell(_textEditorCell, _textEditorRow);
  toast('✓ Saved ' + (_slideField ? 'text slide' : _textEditorField), 1000);
}

// (dev0593) Repair the structural corruption contenteditable produces when a
// select-all + Backspace leaves a stray empty block (typically an <h1>) that
// then swallows everything the user types or pastes after it. Three idempotent
// fixes, run on every save so the damage self-heals and can't reach the render:
//   1. Unwrap headings that (illegally) contain block content. A heading is
//      phrasing-only, so <h1><ul>…</h1> or <h1><div><hr></h1> is always damage;
//      unwrapping frees the trapped content AND surfaces any buried <hr>.
//   2. Hoist section-divider <hr>s (outside <details>) up to a direct child of
//      the slide root, so the grid section-splitter — which only breaks at a
//      top-level <hr> — sees dividers a wrapper had swallowed.
//   3. Drop empty leftovers (list spacers, empty headings/wrappers) with no
//      text or media. Intentional blank lines carry a <br> and are preserved.
function _teNormalizeSlideDom(rootEl) {
  if (!rootEl) return;
  const BLOCK = new Set(['UL','OL','LI','DIV','DETAILS','HR','TABLE','BLOCKQUOTE',
    'P','H1','H2','H3','H4','H5','H6']);
  const unwrap = (el) => {
    const p = el.parentNode; if (!p) return;
    while (el.firstChild) p.insertBefore(el.firstChild, el);
    p.removeChild(el);
  };
  // 1. Unwrap block-holding headings (repeat for nested cases, guarded).
  let pass = 0;
  while (pass++ < 8) {
    const bad = Array.from(rootEl.querySelectorAll('h1,h2,h3,h4,h5,h6'))
      .filter(h => Array.from(h.children).some(c => BLOCK.has(c.tagName)));
    if (!bad.length) break;
    bad.forEach(unwrap);
  }
  // Slide root = the .te-slide colour wrapper when it's the sole element child.
  const kids = Array.from(rootEl.children);
  const root = (kids.length === 1 && kids[0].classList &&
                kids[0].classList.contains('te-slide')) ? kids[0] : rootEl;
  // 2. Hoist buried section dividers to top level (unwrap preserves order).
  root.querySelectorAll('hr').forEach(hr => {
    if (hr.closest('details')) return;
    let guard = 0;
    while (hr.parentNode && hr.parentNode !== root && guard++ < 30) unwrap(hr.parentNode);
  });
  // 3. Remove empty leftovers — no text, no media, no <br> line-break.
  const isEmpty = (el) => !el.textContent.trim() &&
    !el.querySelector('img,video,br,hr,details,table,a');
  let changed = true, guard = 0;
  while (changed && guard++ < 20) {
    changed = false;
    root.querySelectorAll('li,ul,ol,p,div,span,h1,h2,h3,h4,h5,h6').forEach(el => {
      if (el === root) return;
      if (isEmpty(el)) { el.remove(); changed = true; }
    });
  }
}

// (zip0134/0135) Walk the editor DOM and remove malformed <details>
// elements that contenteditable can produce. Only removes ones with NO
// <summary> child at all — that's the "stray <details><p></p></details>"
// pattern the user reported. Empty <summary> is allowed because the user
// may have just inserted a fresh collapsible and not yet typed in it.
function _sanitizeTextEditorHtml(rootEl) {
  if (!rootEl) return;
  _teNormalizeSlideDom(rootEl);   // (dev0593) repair select-all-delete corruption first
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

// (dev0573) Insert an empty paragraph immediately BEFORE or AFTER the detail
// block at the caret — always OUTSIDE the block (top-level sibling), so the new
// line can't be absorbed into the <details>. Shared by the ¶↑/¶↓ toolbar
// buttons; same insertion the Ctrl+Shift+Enter / Ctrl+Enter keydown paths do.
// Falls back to a ⋮⋮-selected block when the caret isn't inside one.
function _teInsertLineAroundDetails(where) {
  const ed = document.getElementById('teEditor');
  if (!ed) return;
  const sel = window.getSelection();
  let details = null;
  if (sel && sel.rangeCount) {
    let n = sel.getRangeAt(0).startContainer;
    while (n && n !== ed) {
      if (n.nodeType === 1 && n.tagName === 'DETAILS') details = n;  // keep climbing → outermost
      n = n.parentNode;
    }
  }
  if (!details) details = ed.querySelector('details.te-selected');
  if (!details) {
    if (typeof toast === 'function') toast('Put the cursor inside a detail block first', 1800);
    return;
  }
  // (dev0589) Insert as a sibling of the <details> in ITS OWN parent — not as
  // a child of the editor. When the slide carries a .te-slide color/background
  // wrapper, every block (incl. this <details>) lives INSIDE that single
  // wrapper; climbing to the editor's direct child then dropped the blank line
  // before the whole wrapper (top of everything) or after it (END of the text)
  // instead of immediately above/below the detail block.
  const parent = details.parentNode;
  const p = document.createElement('p');
  p.appendChild(document.createElement('br'));
  parent.insertBefore(p, where === 'before' ? details : details.nextSibling);
  const r = document.createRange();
  r.setStart(p, 0); r.collapse(true);
  sel.removeAllRanges(); sel.addRange(r);
  ed.focus();
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

// (dev0587) True when the range enters or exits a <details> — i.e. it overlaps
// one without fully containing both endpoints. Such a selection can't be
// extractContents()'d or native-formatBlock'd without splitting the collapsible
// (which the save sanitizer then deletes, losing the hidden body). A selection
// wholly inside one details is safe and returns false.
function _teRangePartlyCrossesDetails(ed, range) {
  const ds = ed.querySelectorAll('details');
  for (const d of ds) {
    if (!range.intersectsNode(d)) continue;
    if (!d.contains(range.startContainer) || !d.contains(range.endContainer)) return true;
  }
  return false;
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
    // (dev0588) display:inline keeps the title on the marker's line — a block
    // heading wraps below the inside-positioned ▶/▼ marker (see index.html rule).
    // Carried inline so saved ftext renders right outside this stylesheet too.
    h.setAttribute('style', 'margin:0;display:inline');
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
  // (dev0587) A <details> ANYWHERE in the range — not just under an endpoint —
  // must block the native path. Selecting across a whole collapsible (e.g. an
  // intro line + a details below it, then H1) left both endpoints OUTSIDE any
  // details, so the old endpoint-only check took the native branch;
  // execCommand('formatBlock') then mangled the details into a summary-less
  // block and the save-time sanitizer DELETED it — the hidden body was lost.
  let rangeHitsDetails = false;
  ed.querySelectorAll('details').forEach(d => { if (range.intersectsNode(d)) rangeHitsDetails = true; });
  const inDetails = rangeHitsDetails
                 || !!((startEl.closest && startEl.closest('details')) ||
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

// (dev0360) Split an extracted fragment into its first "line" and the rest, for
// the [[2]] split-wrap. If the fragment leads with a block (p/div/h*/li), that
// block's contents are the line and the remaining siblings are the rest.
// Otherwise the content is inline — split at the first <br>. With neither, the
// whole fragment is the line (empty rest). Returns { first, rest } fragments.
function _teSplitFirstLine(frag) {
  const BLOCK = /^(P|DIV|H[1-6]|LI|BLOCKQUOTE)$/;
  const first = document.createDocumentFragment();
  // Skip leading whitespace-only text nodes when sniffing the lead element.
  let lead = frag.firstChild;
  while (lead && lead.nodeType === 3 && !lead.textContent.trim()) lead = lead.nextSibling;
  if (lead && lead.nodeType === 1 && BLOCK.test(lead.tagName)) {
    while (lead.firstChild) first.appendChild(lead.firstChild);
    // Drop everything up to and including the (now-empty) lead block.
    let n = frag.firstChild;
    while (n && n !== lead) { const nx = n.nextSibling; frag.removeChild(n); n = nx; }
    frag.removeChild(lead);
    return { first, rest: frag };
  }
  // (dev0586) Inline lead content: the first line ends at the first <br> OR at
  // the first block-level sibling, whichever comes first. Chrome contenteditable
  // commonly leaves the first line as a bare text node followed by <div> line-
  // blocks — the old code only split on <br>, hit the block, and (with br still
  // null) dumped EVERY line into the summary. Splitting at the block boundary
  // too keeps line 1 as the title and the rest as the hidden body. A <br> split
  // is consumed; a block split stays in the body.
  let splitNode = null, dropSplit = false;
  for (let n = frag.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && n.tagName === 'BR') { splitNode = n; dropSplit = true; break; }
    if (n.nodeType === 1 && BLOCK.test(n.tagName)) { splitNode = n; dropSplit = false; break; }
  }
  if (splitNode) {
    while (frag.firstChild && frag.firstChild !== splitNode) first.appendChild(frag.firstChild);
    if (dropSplit) frag.removeChild(splitNode);
    return { first, rest: frag };
  }
  while (frag.firstChild) first.appendChild(frag.firstChild);
  return { first, rest: document.createDocumentFragment() };
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
          value="${(defaults.caption || '').replace(/"/g, '&quot;')}"
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
      // (dev0634) no color — caption inherits the slide/section text color
      // (was #aaa gray, which stuck out and infected lines typed near it).
      ? '<div style="font-size:0.78em;text-align:center;margin-top:3px;">' + cap + '</div>'
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
function textEditorPreviewSlide(htmlOverride) {
  // (dev0620) Optional htmlOverride so the v2 editor (xe2.js) can reuse this
  // Xs preview — v2 has no #teEditor, it passes its live serialized ftext.
  let rawHtml;
  if (typeof htmlOverride === 'string') {
    rawHtml = htmlOverride.trim();
  } else {
    const editor = document.getElementById('teEditor');
    if (!editor) return;
    // Use the live editor content (not the saved row) so user can preview
    // unsaved changes.
    rawHtml = editor.innerHTML.trim();
  }
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
      #teSlideContent h1,#teSlideContent h2,#teSlideContent h3,#teSlideContent h4,#teSlideContent h5,#teSlideContent h6{font-weight:bold;margin:0 0 8px;}
      #teSlideContent h1{font-size:2em;} #teSlideContent h2{font-size:1.5em;} #teSlideContent h3{font-size:1.25em;color:#9ef;} #teSlideContent h4{font-size:1.1em;color:#adf;} #teSlideContent h5{font-size:1em;color:#bdf;} #teSlideContent h6{font-size:0.9em;color:#cdf;}
      #teSlideContent hr{border:none;border-top:2px solid #4a5a7a;margin:16px 0;height:0;}
      #teSlideContent small{font-size:0.8em;opacity:0.85;}
      /* (dev0591) Details under a centered summary: shrink the block to its
         content width and center it so the body left-aligns under the ▼ arrow
         (the summary keeps its inline text-align:center). */
      #teSlideContent details:has(> summary[style*="center"]){width:fit-content;max-width:100%;margin:8px auto;text-align:left;}
      /* (dev0619) Slide-wide text color wins over the h3–h6 tint ladder above,
         matching Xe/G — only when the .te-slide wrapper has an explicit color. */
      #teSlideContent .te-slide[style*="color:"] :is(h1,h2,h3,h4,h5,h6){color:inherit;}</style>
    <div id="teSlideTopBar" style="position:absolute;top:0;left:0;right:0;height:64px;
         display:flex;align-items:center;justify-content:space-between;
         padding:0 16px;background:#3a4d75;border-bottom:2px solid #6af;">
      <span id="teSlideHint" style="font-family:monospace;font-size:13px;color:#cde;">
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
                max-height:90vh;overflow-y:auto;margin-top:64px;"></div>
  `;
  document.body.appendChild(ov);

  // (dev0617) Xs shows ONE section per page — split at each top-level <hr>
  // (same splitter as the 1a grid cell and the fullscreen viewer) instead of
  // the whole document with separator lines. →/← page through sections.
  const _sects = (typeof window._salSplitSections === 'function')
    ? window._salSplitSections(html) : [html];
  let _sIdx = 0;
  const _content = ov.querySelector('#teSlideContent');
  const _hint = ov.querySelector('#teSlideHint');

  // (dev0624) A section whose ENTIRE content is a cell designation ("1a"…"5e",
  // "1L", "1P"…"3P") or "G" doesn't render as text — it opens that cell's row
  // in the V fullscreen viewer (or the whole grid for "G") while Xs stays the
  // key owner: ←/→ still page sections (this overlay's capture handler was
  // registered before vpKeyHandler, so its stopImmediatePropagation wins), Esc
  // closes everything back to Xe. Returns 'G', a canonical cell string, or null.
  function _sectCellSpec(sectHtml) {
    const tmp = document.createElement('div');
    tmp.innerHTML = sectHtml || '';
    if (tmp.querySelector('img,video,iframe,hr,table')) return null; // media = not a bare designation
    const t = (tmp.textContent || '').replace(/[ ​]/g, ' ').trim();
    if (/^g$/i.test(t)) return 'G';
    if (t.length === 2 && /[1-9]/.test(t[0]) && /[a-iPL]/i.test(t[1])) {
      const c2 = t[1];
      return t[0] + (/[pl]/i.test(c2) ? c2.toUpperCase() : c2.toLowerCase());
    }
    return null;
  }
  let _cellMode = null;      // null | 'cell' | 'grid'
  let _cellObserver = null;  // watches for the viewer being closed by its own UI
  // (dev0627) The viewer/grid live INSIDE #rotateWrap, which is position:fixed
  // and therefore its own stacking context — no z-index in there can ever beat
  // the body-level Xe overlays (35000). The dev0626 z-boost was trapped; the
  // editor overlay itself must vanish while the designation cell is up.
  let _cellHiddenEditor = null;
  function _hideEditorOverlay() {
    const eo = document.getElementById('xe2Overlay') || _textEditorOverlay;
    if (eo) { _cellHiddenEditor = eo; eo.style.visibility = 'hidden'; }
  }
  function _unhideEditorOverlay() {
    if (_cellHiddenEditor) { _cellHiddenEditor.style.visibility = ''; _cellHiddenEditor = null; }
  }
  function _leaveCellMode() {
    if (_cellObserver) { _cellObserver.disconnect(); _cellObserver = null; }
    if (_cellMode === 'cell') {
      if (typeof vpClose === 'function') { try { vpClose(); } catch (_) {} }
      const fs = document.getElementById('gridFullscreen');
      if (fs) fs.style.zIndex = '';   // (dev0626) drop the above-Xe boost
    } else if (_cellMode === 'grid') {
      // NOT gridClose() — that calls textEditorClose() and would kill Xe under us.
      if (typeof gridCleanupPlayers === 'function') { try { gridCleanupPlayers(); } catch (_) {} }
      const go = document.getElementById('gridOverlay');
      if (go) { go.style.display = 'none'; go.style.zIndex = ''; }
    }
    _cellMode = null;
    _unhideEditorOverlay();
    ov.style.display = 'flex';
  }
  // If the viewer/grid is dismissed by its own UI (swipe-close, ✕), un-hide Xs
  // so the user isn't left staring at a blank screen with no overlay.
  function _watchExternalClose(el, expectShown) {
    if (!el || typeof MutationObserver !== 'function') return;
    _cellObserver = new MutationObserver(() => {
      if (_cellMode && el.style.display !== expectShown) _leaveCellMode();
    });
    _cellObserver.observe(el, { attributes: true, attributeFilter: ['style'] });
  }
  function _enterCellMode(spec) {
    if (spec === 'G') {
      if (typeof gridShow !== 'function') return false;
      ov.style.display = 'none';
      _hideEditorOverlay();
      _cellMode = 'grid';
      gridShow();
      // (dev0626) G ships at z-index 28000 — UNDER the Xe overlay (35000), so
      // hiding Xs just exposed Xe. Boost above Xe/Xs while the slide owns it.
      const go = document.getElementById('gridOverlay');
      if (go) go.style.zIndex = '36200';
      _watchExternalClose(go, 'grid');
      return true;
    }
    const row = (typeof getRowByCellForGrid === 'function') ? getRowByCellForGrid(spec) : null;
    if (!row) {
      if (typeof toast === 'function') toast('No row in cell ' + spec, 1400);
      return false;
    }
    if (typeof gridOpenFullscreen !== 'function') return false;
    ov.style.display = 'none';
    _hideEditorOverlay();
    _cellMode = 'cell';
    gridOpenFullscreen(row);
    // (dev0626) Same stacking fix as G: the V viewer ships at 28500, below the
    // Xe overlay (35000) — without the boost the "fullscreen cell" was Xe.
    const fs = document.getElementById('gridFullscreen');
    if (fs) fs.style.zIndex = '36200';
    _watchExternalClose(fs, 'flex');
    return true;
  }
  function _showSect() {
    _leaveCellMode();
    // (dev0636) Canonical matcher now lives in grid.js (window._salSectCellSpec)
    // so vp.js applies the identical rule in Gu; local fn kept as fallback.
    const spec = (typeof window._salSectCellSpec === 'function')
      ? window._salSectCellSpec(_sects[_sIdx]) : _sectCellSpec(_sects[_sIdx]);
    if (spec && _enterCellMode(spec)) return;
    _content.innerHTML = _sects[_sIdx] || '';
    _content.scrollTop = 0;
    if (_hint && _sects.length > 1) {
      _hint.textContent = 'Page ' + (_sIdx + 1) + '/' + _sects.length
        + ' · → next · ← prev · Esc / swipe ← on this bar to go back';
    }
  }

  function close() {
    _leaveCellMode();   // (dev0624) tear down a designation-cell viewer / grid too
    document.removeEventListener('keydown', onKey, true);
    // (dev0638) drop the floating page/exit buttons (body-level, not in ov)
    const _nb = document.getElementById('teSlideNavBtns');
    if (_nb) _nb.remove();
    ov.remove();
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      close();
      return;
    }
    // (dev0626) Space = next slide (like →). Intercepted even over a
    // designation-cell viewer — Xs paging wins over V's play/pause there,
    // matching the arrow rule.
    if (_sects.length > 1 && (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === ' ')) {
      e.preventDefault(); e.stopImmediatePropagation();
      _page(e.key === 'ArrowLeft' ? -1 : 1);
    }
  }
  // (dev0638) Shared pager — used by onKey above and the floating ‹ › buttons.
  function _page(dir) {
    if (_sects.length < 2) return;
    const ni = _sIdx + dir;
    if (ni < 0 || ni >= _sects.length) {
      if (typeof toast === 'function') toast(dir > 0 ? 'Last page' : 'First page', 900);
      return;
    }
    _sIdx = ni;
    _showSect();
  }
  // (dev0624) Register BEFORE the first _showSect: if the opening section is a
  // cell designation, gridOpenFullscreen registers vpKeyHandler at document
  // capture, and same-phase order is registration order — ours must be first
  // so ←/→/Esc stay slide navigation while a designation cell is fullscreen.
  document.addEventListener('keydown', onKey, true);
  _showSect();
  // (dev0638) Floating ‹ › page buttons + red ✕ — the same affordance V's
  // sectioned viewer got in dev0637/38, so Xs (the desktop/dev path) pages by
  // mouse too. Body-level, NOT inside ov, at z 36400: above ov AND above a
  // designation cell's boosted V viewer (36200), so paging/exit stay clickable
  // while a media page is up. close() removes the holder.
  const _navHolder = document.createElement('div');
  _navHolder.id = 'teSlideNavBtns';
  _navHolder.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:36400;';
  (function _buildNavBtns() {
    const mk = (txt, side, topCss, extra) => {
      const b = document.createElement('button');
      b.textContent = txt;
      b.style.cssText = 'position:absolute;top:' + topCss + ';' + side + ':10px;'
        + 'transform:translateY(-50%);pointer-events:auto;width:46px;height:46px;'
        + 'border-radius:50%;border:1px solid rgba(255,255,255,0.35);'
        + 'background:rgba(0,0,0,0.45);color:#fff;font-size:26px;line-height:1;'
        + 'cursor:pointer;touch-action:manipulation;user-select:none;-webkit-user-select:none;'
        + (extra || '');
      b.addEventListener('pointerdown', e => e.stopPropagation());
      _navHolder.appendChild(b);
      return b;
    };
    if (_sects.length > 1) {
      mk('‹', 'left',  '50%').addEventListener('click', e => { e.stopPropagation(); _page(-1); });
      mk('›', 'right', '50%').addEventListener('click', e => { e.stopPropagation(); _page(1); });
    }
    mk('✕', 'right', 'calc(50% + 58px)',
      'background:rgba(60,0,0,0.65);border-color:#f44;color:#f88;font-size:20px;')
      .addEventListener('click', e => { e.stopPropagation(); close(); });
    document.body.appendChild(_navHolder);
  })();
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
  // (dev0590) If the Xe v2 overlay is open, tear it down too — external closers
  // (gridClose, Escape-nav) call textEditorClose and must close either editor.
  if (window.XE2 && document.getElementById('xe2Overlay')) { try { window.XE2.close(); } catch (_) {} }
  // (dev0572) Cancel any pending type-autosave so it can't fire against a
  // torn-down editor / the next row opened after this one.
  clearTimeout(window._teAutosaveTimer);
  // (zip0183) Remember the last Xe row so, after teardown, T's focus lands on
  // the row that was open (even after it re-sorts, below).
  const _closedRow = _textEditorRow;
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
  // (dev0573) Repaint T so its ftext/DateModified columns show this session's
  // edits — save() writes data+disk but never re-renders the table, which made
  // Xe's autosave look broken from T. One render per close is cheap; when the
  // grid is on top the repaint is invisible but harmless.
  // (dev0625) Also re-run buildSort() FIRST: an Xe edit stamps row.DateModified,
  // but render() alone reuses the stale sortedIdx, so in a DateModified-sorted
  // view ("LastModOnTop") the just-edited row kept its old position while showing
  // a newer timestamp — which read as "the modification date isn't updating."
  // Every other data mutation (insertRow/deleteRow/inline cell edits) already
  // does buildSort()+render(); Xe's close was the odd one out. Re-focus AFTER the
  // re-sort so the edited row is highlighted at its new spot (e.g. jumped to top).
  if (typeof buildSort === 'function') { try { buildSort(); } catch (_) {} }
  if (_closedRow && typeof window._setFocusToRow === 'function') {
    try { window._setFocusToRow(_closedRow); } catch (_) {}
  }
  if (typeof render === 'function') { try { render(); } catch (_) {} }
}

function gridClose() {
  window.MovingCells?.stop(true);   // (dev0374) halt the ring conveyor if running
  window.FlyCells?.stop();          // (dev0385) clear any flung cells / fly mode
  window.FlyCells2?.stop();         // (dev0387) clear the swap-engine variant
  window.FallCells?.stop(true);     // (dev0460) halt the perimeter waterfall
  gridCleanupPlayers();
  gridClearCut();
  gridHideContextMenu();
  textEditorClose();
  document.getElementById('gridOverlay').style.display = 'none';
  document.getElementById('gridFullscreen').style.display = 'none';
  buildTable(); // Refresh table to show any cell swaps
}
