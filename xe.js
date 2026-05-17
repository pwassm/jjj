
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
        <button class="te-btn" data-cmd="formatBlock" data-val="p" title="Paragraph">P</button>
        <span style="width:1px; background:#444; margin:0 6px;"></span>
        <button class="te-btn" data-cmd="justifyLeft" title="Left align">◀</button>
        <button class="te-btn" data-cmd="justifyCenter" title="Center">◆</button>
        <span style="width:1px; background:#444; margin:0 6px;"></span>
        <button class="te-btn" data-cmd="insertUnorderedList" title="Bullet list">•</button>
        <button class="te-btn" id="teCollapse" title="Insert collapsible section (▶ click to expand)">▶…</button>
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
      
      <div style="padding:8px 16px; color:#556; font-size:11px; border-top:1px solid #333;">
        Ctrl+B/I/U · Ctrl+S to save+close · Esc to close (no save) · S = slide (when defocused) · Swipe → title bar = slide · Swipe ← title bar = save+close · Shift+Enter = new collapsible
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
    #teEditor h1 { font-size:28px; color:#ff8; margin:0 0 12px; }
    #teEditor h2 { font-size:22px; color:#8ef; margin:0 0 10px; }
    #teEditor p { margin:0 0 8px; }
    #teEditor ul { margin:8px 0; padding-left:24px; }
    #teEditor details { margin:8px 0; padding:8px; background:#111; border-left:3px solid #06f;
      clear:both; overflow:hidden; }
    #teEditor summary { cursor:pointer; color:#8ef; font-weight:bold; padding:4px 0; }
    #teEditor summary::-webkit-details-marker { color:#06f; }
    #teEditor details[open] summary { margin-bottom:8px; }
    #teSlideContent details { clear:both; overflow:hidden; margin:8px 0; padding:8px; }
  `;
  
  // Wire toolbar buttons - use mousedown to prevent focus loss
  document.querySelectorAll('.te-btn[data-cmd]').forEach(btn => {
    btn.onmousedown = (e) => {
      e.preventDefault(); // Prevent focus loss from editor
      const cmd = btn.dataset.cmd;
      const val = btn.dataset.val || null;
      document.execCommand(cmd, false, val);
    };
  });
  
  // Wire collapse button separately (inserts HTML, not execCommand).
  // (zip0135) Insert empty <details>/<summary>/<div> so user gets just the
  // caret. Sample text was paternalistic — user knows what to type.
  document.getElementById('teCollapse').onmousedown = (e) => {
    e.preventDefault();
    const html = '<details><summary></summary><div></div></details>';
    document.execCommand('insertHTML', false, html);
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
  _ov.addEventListener('keydown', function(e) {
    // (zip0182) Esc on Xe = blur whatever is focused (editor or overlay).
    // Does NOT close Xe — Xe is closed by the X button, the slide-preview
    // L→R swipe, or by navigating to another row via ArrowUp/Down.
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      const ae = document.activeElement;
      if (ae && typeof ae.blur === 'function') ae.blur();
      // Move focus to the overlay so subsequent ArrowUp/Down still hit this
      // listener (otherwise focus falls back to <body> outside the overlay
      // tree and our keydown bindings stop firing).
      _textEditorOverlay.focus();
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
    // Always navigates, even when the contenteditable editor is focused (matches
    // the Ie + Annotate-panel combo). _brRows is always refreshed from the live
    // filter so navigating a filtered T doesn't walk invisible rows.
    // openEditorForRow routes to Xe (text), Ie (image), or Ev (video).
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
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
      sStart = { x: e.clientX, y: e.clientY, t: Date.now() };
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
        // Cursor is inside <summary>
        e.preventDefault();
        if (e.shiftKey) {
          // Shift+Enter → multi-line summary (insert BR)
          document.execCommand('insertLineBreak', false, null);
        } else {
          // Enter → move into the body div (first child of details that isn't summary)
          const bodyEl = details && Array.from(details.children).find(c => c.tagName !== 'SUMMARY');
          if (bodyEl) {
            const r = document.createRange();
            r.setStart(bodyEl, 0);
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
            // Ensure body div is not empty so caret is visible
            if (!bodyEl.firstChild) {
              bodyEl.appendChild(document.createElement('br'));
              r.setStart(bodyEl, 0);
              r.collapse(true);
              sel.removeAllRanges();
              sel.addRange(r);
            }
          }
        }
        return;
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

  // (zip0136) Double-click on an inserted image opens the image modal
  // pre-filled with the image's current src and size, so the user can
  // resize, re-align, or replace it. The original <img> is removed and
  // a new one inserted at the same position with the chosen settings.
  editor.addEventListener('dblclick', e => {
    if (!e.target || e.target.tagName !== 'IMG') return;
    e.preventDefault(); e.stopPropagation();
    teEditImage(e.target);
  });
  
  // Click outside box to close
  _textEditorOverlay.addEventListener('click', e => {
    if (e.target === _textEditorOverlay) textEditorClose();
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
    // (zip0137) If saved content has a .te-slide wrapper with a background,
    // paint the editor surface so the user sees the slide colors while editing.
    teSyncEditorBgFromWrapper();
  }, 100);
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

  // Build the HTML for a given URL + size + alignment.
  function buildHtml(url, size, align) {
    const widthMap  = { small: '200px', medium: '400px', large: '700px', full: '100%' };
    const w = widthMap[size] || '400px';
    if (align === 'left') {
      return '<img src="' + url + '" style="float:left;width:' + w + ';margin:6px 14px 6px 0;'
        + 'border-radius:4px;" alt="">';
    }
    if (align === 'right') {
      return '<img src="' + url + '" style="float:right;width:' + w + ';margin:6px 0 6px 14px;'
        + 'border-radius:4px;" alt="">';
    }
    // Centered: wrap in figure/div with margin auto for predictable centering.
    return '<div style="text-align:center;margin:12px 0;">'
      + '<img src="' + url + '" style="max-width:100%;width:' + w + ';display:inline-block;'
      + 'border-radius:4px;" alt="">'
      + '</div>';
  }

  function close() { modal.remove(); }
  modal.querySelector('#teImgClose').onclick = close;
  modal.querySelector('#teImgCancel').onclick = close;
  modal.addEventListener('click', e => { if (e.target === modal) close(); });

  function doInsert() {
    const srcRaw = modal.querySelector('#teImgSrc').value;
    const size  = (modal.querySelector('input[name="teImgSize"]:checked')  || {}).value || 'medium';
    const align = (modal.querySelector('input[name="teImgAlign"]:checked') || {}).value || 'center';
    const r = resolveSrc(srcRaw);
    if (r.error) {
      modal.querySelector('#teImgErr').textContent = r.error;
      return;
    }
    const html = buildHtml(r.url, size, align);
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

  // Auto-focus the source input
  setTimeout(() => modal.querySelector('#teImgSrc').focus(), 30);
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
    <style>#teSlideContent a { color: #5bf; }</style>
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
