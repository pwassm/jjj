// ══════════════════════════════════════════════════════════════════════════════
// XE v2 — schema-based text-slide editor (TipTap / ProseMirror)
// ──────────────────────────────────────────────────────────────────────────────
// Replaces Xe's contenteditable+execCommand base (xe.js) with a schema editor
// where <details> is a first-class node and structure cannot be corrupted
// (the dev0243/0341/0587/0589 whack-a-mole class becomes non-representable).
//
// LOAD ORDER: xe2-bundle.js (vendored TipTap IIFE → window.XE2Lib) must load
// BEFORE this file. This module is inert unless window.XE2Lib is present AND
// the opt-in flag is on (localStorage 'xe2'==='1' or ?xe2=1).
//
// ftext stays HTML. Serialization keeps the exact current shape
// (<details><summary>..</summary>..blocks..</details>, <hr>, .te-slide wrapper)
// so G (grid.js _gridSectionSetup) and Xs (innerHTML consumers) are unaffected.
// It hooks the SAME globals v1 uses to persist: save(), gridUpdateCell(),
// toast(), isoNow(), render(), _setFocusToRow(). See memory:
// project_xe_editor_rebuild.
// ══════════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  var L = window.XE2Lib;
  if (!L) { console.warn('[xe2] window.XE2Lib missing — xe2-bundle.js not loaded; Xe v2 disabled.'); return; }

  var Editor = L.Editor, Node = L.Node, Mark = L.Mark, mergeAttributes = L.mergeAttributes;
  var StarterKit = L.StarterKit, Image = L.Image, Underline = L.Underline, Link = L.Link;
  var Table = L.Table, TableRow = L.TableRow, TableCell = L.TableCell, TableHeader = L.TableHeader;

  // ══ SCHEMA ══════════════════════════════════════════════════════════════════
  // <details> as summary + block+ DIRECTLY (no wrapper div) so output HTML is
  // byte-compatible with the current ftext format.
  var DetailsSummary = Node.create({
    name: 'detailsSummary',
    content: 'inline*',
    defining: true,
    isolating: true,
    parseHTML: function () { return [{ tag: 'summary' }]; },
    renderHTML: function (p) { return ['summary', mergeAttributes(p.HTMLAttributes), 0]; },
  });

  var Details = Node.create({
    name: 'details',
    group: 'block',
    content: 'detailsSummary block+',
    defining: true,
    isolating: true,
    addAttributes: function () {
      return {
        open: {
          default: false,
          parseHTML: function (el) { return el.hasAttribute('open'); },
          renderHTML: function (attrs) { return attrs.open ? { open: '' } : {}; },
        },
      };
    },
    parseHTML: function () { return [{ tag: 'details' }]; },
    renderHTML: function (p) { return ['details', mergeAttributes(p.HTMLAttributes), 0]; },
  });

  // <small> as a mark (StarterKit has no small).
  var Small = Mark.create({
    name: 'small',
    parseHTML: function () { return [{ tag: 'small' }]; },
    renderHTML: function (p) { return ['small', mergeAttributes(p.HTMLAttributes), 0]; },
  });

  // Image that PRESERVES the inline style (float/width/margin) ftext uses for
  // sizing + alignment. Default extension-image drops all of it.
  var StyledImage = Image.extend({
    addAttributes: function () {
      var parent = this.parent ? this.parent() : {};
      return Object.assign({}, parent, {
        style: {
          default: null,
          parseHTML: function (el) { return el.getAttribute('style'); },
          renderHTML: function (attrs) { return attrs.style ? { style: attrs.style } : {}; },
        },
      });
    },
  });

  function buildExtensions() {
    return [
      StarterKit,
      DetailsSummary, Details, Small,
      Underline,
      StyledImage.configure({ inline: false }),
      Link.configure({ openOnClick: false, autolink: false }),
      Table.configure({ resizable: false }), TableRow, TableHeader, TableCell,
    ];
  }

  // ── Slide-wide color: current ftext wraps the whole slide in
  //    <div class="te-slide" style="color:..;background:..">. TipTap has no div
  //    node so the wrapper would be lost. Strip on the way in, re-wrap on out.
  function parseFtext(raw) {
    raw = raw || '';
    try {
      var doc = new DOMParser().parseFromString(raw, 'text/html');
      var wrap = doc.body && doc.body.firstElementChild;
      if (wrap && wrap.classList && wrap.classList.contains('te-slide') &&
          doc.body.children.length === 1) {
        return {
          inner: wrap.innerHTML,
          slide: {
            color: wrap.style.color || '',
            background: wrap.style.background || wrap.style.backgroundColor || '',
          },
        };
      }
    } catch (e) { /* fall through */ }
    return { inner: raw, slide: null };
  }

  function serialize(editor, slide) {
    var html = editor.getHTML();
    if (slide && (slide.color || slide.background)) {
      var css = '';
      if (slide.color) css += 'color: ' + slide.color + '; ';
      if (slide.background) css += 'background: ' + slide.background + ';';
      return '<div class="te-slide" style="' + css.trim() + '">' + html + '</div>';
    }
    return html;
  }

  function createEditor(element, raw, opts) {
    opts = opts || {};
    var parsed = parseFtext(raw);
    var editor = new Editor({
      element: element,
      extensions: buildExtensions(),
      content: parsed.inner,
      editable: opts.editable !== false,
      editorProps: opts.editorProps || {},
    });
    if (opts.onUpdate) editor.on('update', opts.onUpdate);
    return {
      editor: editor,
      slide: parsed.slide,
      getFtext: function () { return serialize(editor, parsed.slide); },
    };
  }

  // ══ FLAG ════════════════════════════════════════════════════════════════════
  function isEnabled() {
    try {
      if (/[?&]xe2=1(&|$)/.test(location.search)) return true;
      if (/[?&]xe2=0(&|$)/.test(location.search)) return false;
      return localStorage.getItem('xe2') === '1';
    } catch (e) { return false; }
  }
  function enable() { try { localStorage.setItem('xe2', '1'); } catch (e) {} console.log('[xe2] enabled — reopen a text cell'); }
  function disable() { try { localStorage.removeItem('xe2'); } catch (e) {} console.log('[xe2] disabled — v1 editor active'); }

  // ══ EDITOR OVERLAY ══════════════════════════════════════════════════════════
  var _api = null;      // { editor, slide, getFtext }
  var _row = null, _cell = null, _field = 'ftext';
  var _saveTimer = null;

  function nowIso() { return (typeof window.isoNow === 'function') ? window.isoNow() : new Date().toISOString(); }

  function stampSaved() {
    var el = document.getElementById('xe2Saved');
    if (el) el.textContent = '✓ autosaved ' + new Date().toTimeString().slice(0, 8);
  }

  // Write current editor HTML to the row + persist to disk (no close).
  function doSave() {
    if (!_api || !_row) return false;
    _row[_field] = _api.getFtext();
    _row.DateModified = nowIso();
    if (_field === 'ftext' && !_row.link) _row.VidRange = 'text';
    if (typeof window.save === 'function') { try { window.save(); } catch (e) { console.warn('[xe2] save() failed', e); } }
    stampSaved();
    return true;
  }

  function commitAndClose() {
    doSave();
    var cell = _cell, row = _row, field = _field;
    close();
    if (field === 'ftext' && typeof window.gridUpdateCell === 'function') {
      try { window.gridUpdateCell(cell, row); } catch (e) {}
    }
    if (typeof window.toast === 'function') window.toast('✓ Saved ' + (field === 'ftext' ? 'text slide' : field) + ' (v2)', 1100);
  }

  function close() {
    clearTimeout(_saveTimer);
    if (_api) { try { _api.editor.destroy(); } catch (e) {} _api = null; }
    var ov = document.getElementById('xe2Overlay'); if (ov) ov.remove();
    var st = document.getElementById('xe2Styles'); if (st) st.remove();
    document.removeEventListener('keydown', _onKeydown, true);
    if (_row && typeof window._setFocusToRow === 'function') { try { window._setFocusToRow(_row); } catch (e) {} }
    _row = null; _cell = null;
    if (typeof window.render === 'function') { try { window.render(); } catch (e) {} }
  }

  // Switch back to the v1 editor for the same cell/row (A/B testing).
  function switchToV1() {
    disable();
    var cell = _cell, row = _row, field = _field;
    close();
    if (typeof window.gridOpenTextEditor === 'function') {
      window.gridOpenTextEditor(cell, row, { field: field });
    }
  }

  // ── details commands ────────────────────────────────────────────────────────
  function insertCollapsible(editor) {
    editor.chain().focus().insertContent({
      type: 'details',
      attrs: { open: true },
      content: [
        { type: 'detailsSummary' },
        { type: 'paragraph' },
      ],
    }).run();
  }
  function setAllDetails(editor, open) {
    var state = editor.state, tr = state.tr, changed = false;
    state.doc.descendants(function (node, pos) {
      if (node.type.name === 'details' && node.attrs.open !== open) {
        tr.setNodeMarkup(pos, undefined, Object.assign({}, node.attrs, { open: open }));
        changed = true;
      }
    });
    if (changed) editor.view.dispatch(tr);
  }

  function insertImage(editor) {
    var url = prompt('Image URL (https://…):', '');
    if (!url) return;
    url = url.trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    editor.chain().focus().insertContent(
      '<img src="' + url.replace(/"/g, '&quot;') + '" style="max-width:100%;width:400px;display:inline-block;border-radius:4px;">'
    ).run();
  }
  function setLink(editor) {
    var prev = editor.getAttributes('link').href || '';
    var url = prompt('Link URL (blank to remove):', prev);
    if (url === null) return;
    url = url.trim();
    if (!url) { editor.chain().focus().extendMarkRange('link').unsetLink().run(); return; }
    if (!/^[a-z]+:\/\//i.test(url) && !/^(mailto:|#)/i.test(url)) url = 'https://' + url;
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }

  // ── toolbar spec: [label, title, handler(editor)] ; '|' = divider ────────────
  function toolbarSpec() {
    return [
      ['<b>B</b>', 'Bold (Ctrl+B)', function (e) { e.chain().focus().toggleBold().run(); }],
      ['<i>I</i>', 'Italic (Ctrl+I)', function (e) { e.chain().focus().toggleItalic().run(); }],
      ['<u>U</u>', 'Underline (Ctrl+U)', function (e) { e.chain().focus().toggleUnderline().run(); }],
      ['<small>sm</small>', 'Small text', function (e) { e.chain().focus().toggleMark('small').run(); }],
      ['|'],
      ['H1', 'Heading 1', function (e) { e.chain().focus().toggleHeading({ level: 1 }).run(); }],
      ['H2', 'Heading 2', function (e) { e.chain().focus().toggleHeading({ level: 2 }).run(); }],
      ['H3', 'Heading 3', function (e) { e.chain().focus().toggleHeading({ level: 3 }).run(); }],
      ['P', 'Paragraph', function (e) { e.chain().focus().setParagraph().run(); }],
      ['&bull;', 'Bullet list', function (e) { e.chain().focus().toggleBulletList().run(); }],
      ['1.', 'Numbered list', function (e) { e.chain().focus().toggleOrderedList().run(); }],
      ['|'],
      ['&#9654;&hellip;', 'Insert collapsible section', function (e) { insertCollapsible(e); }],
      ['&#9660; All', 'Expand all collapsibles', function (e) { setAllDetails(e, true); }],
      ['&#9654; All', 'Collapse all collapsibles', function (e) { setAllDetails(e, false); }],
      ['|'],
      ['&equiv;', 'Divider line (hr)', function (e) { e.chain().focus().setHorizontalRule().run(); }],
      ['&#128444;', 'Insert image', function (e) { insertImage(e); }],
      ['&#128279;', 'Link selection', function (e) { setLink(e); }],
      ['|'],
      ['&#8630;', 'Undo (Ctrl+Z)', function (e) { e.chain().focus().undo().run(); }],
      ['&#8631;', 'Redo (Ctrl+Shift+Z)', function (e) { e.chain().focus().redo().run(); }],
    ];
  }

  function injectStyles() {
    if (document.getElementById('xe2Styles')) return;
    var s = document.createElement('style');
    s.id = 'xe2Styles';
    s.textContent = [
      '#xe2Overlay .xe2-btn{background:#242447;color:#cde;border:1px solid #456;border-radius:5px;padding:5px 9px;font-size:13px;cursor:pointer;line-height:1;}',
      '#xe2Overlay .xe2-btn:hover{background:#33335f;border-color:#6af;}',
      '#xe2Editor{flex:1;overflow:auto;padding:22px 26px;color:#eee;font-size:18px;line-height:1.5;outline:none;}',
      '#xe2Editor .ProseMirror{outline:none;min-height:100%;}',
      // (dev0592) Working, consistent heading ladder so H1/H2/H3 visibly change
      // size (dev0591's flatten made the buttons look like no-ops). Same em values
      // as the Xs/iframe/grid render → an H-level is the same size everywhere.
      '#xe2Editor h1{font-size:2em;} #xe2Editor h2{font-size:1.5em;} #xe2Editor h3{font-size:1.25em;} #xe2Editor h4{font-size:1.1em;} #xe2Editor h5{font-size:1em;} #xe2Editor h6{font-size:0.9em;}',
      '#xe2Editor h1,#xe2Editor h2,#xe2Editor h3,#xe2Editor h4,#xe2Editor h5,#xe2Editor h6{font-weight:bold;}',
      '#xe2Editor details{border-left:3px solid #6af;padding:2px 0 2px 12px;margin:8px 0;background:rgba(90,140,220,0.06);}',
      '#xe2Editor summary{cursor:text;font-weight:bold;color:#9cf;list-style:none;}',
      '#xe2Editor summary::-webkit-details-marker{display:none;}',
      // keep collapsed-details CONTENT visible+editable inside the editor (dimmed)
      '#xe2Editor details:not([open]) > *:not(summary){display:block;opacity:0.5;}',
      '#xe2Editor img{max-width:100%;}',
      '#xe2Editor table{border-collapse:collapse;} #xe2Editor td,#xe2Editor th{border:1px solid #557;padding:4px 8px;}',
      '#xe2Editor a{color:#7cf;}',
    ].join('\n');
    document.head.appendChild(s);
  }

  function _onKeydown(e) {
    var ov = document.getElementById('xe2Overlay');
    if (!ov) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault(); e.stopPropagation(); commitAndClose(); return;
    }
  }

  // Entry point — called from xe.js gridOpenTextEditor when the flag is on.
  // Returns true on success (v1 should not run), false to fall back to v1.
  function open(cellStr, row, opts) {
    opts = opts || {};
    try {
      _cell = cellStr;
      _field = opts.field || 'ftext';
      if (!row) return false; // v1 handles row creation before delegating
      _row = row;

      injectStyles();

      var ov = document.createElement('div');
      ov.id = 'xe2Overlay';
      ov.style.cssText = 'position:fixed; inset:0; right:340px; z-index:35000;' +
        'background:rgba(0,0,0,0.95); display:flex; padding:20px;';
      var hasMedia = !!(row.link);
      var mediaNote = hasMedia ? '<span style="color:#8f8;font-size:11px;margin-left:10px;">(has ' +
        ((typeof window.isVideoRow === 'function' && window.isVideoRow(row)) ? 'video' : 'image') + ')</span>' : '';

      ov.innerHTML =
        '<div style="background:#161628;border:1px solid #445;border-radius:12px;flex:1;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.5);overflow:hidden;">' +
          '<div id="xe2HeaderBar" title="Swipe ← (drag right-to-left) to save and go back" style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:2px solid #6af;background:#2b3a5c;touch-action:none;">' +
            '<span style="color:#ff8;font-weight:bold;">Text Slide <span style="color:#8ef;">v2</span> · ' + cellStr + mediaNote + ' <span style="color:#89a;font-weight:normal;font-size:11px;">· swipe ← to go back</span></span>' +
            '<span id="xe2Saved" style="color:#6d8;font-size:11px;font-family:monospace;"></span>' +
            '<div style="display:flex;gap:8px;">' +
              '<button id="xe2V1" class="xe2-btn" title="Switch this cell back to the classic v1 editor">v1</button>' +
              '<button id="xe2Close" class="xe2-btn" title="Close without saving (Esc)">✕ Close</button>' +
              '<button id="xe2Save" class="xe2-btn" style="border-color:#0f0;color:#0f0;" title="Save + close (Ctrl+S)">✓ Save</button>' +
            '</div>' +
          '</div>' +
          '<div id="xe2Toolbar" style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:8px 14px;background:#0d0d1e;border-bottom:1px solid #333;"></div>' +
          '<div id="xe2Editor"></div>' +
        '</div>';
      document.body.appendChild(ov);

      // Build the TipTap editor (prevent native <details> toggle fighting PM).
      var mount = ov.querySelector('#xe2Editor');
      _api = createEditor(mount, row[_field] || '', {
        editorProps: {
          handleDOMEvents: {
            click: function (view, event) {
              if (event.target && event.target.closest && event.target.closest('summary')) {
                event.preventDefault(); // don't let the browser toggle open/closed
              }
              return false;
            },
          },
        },
        onUpdate: function () {
          clearTimeout(_saveTimer);
          _saveTimer = setTimeout(function () { doSave(); }, 1000);
        },
      });

      // Toolbar
      var tb = ov.querySelector('#xe2Toolbar');
      toolbarSpec().forEach(function (item) {
        if (item[0] === '|') {
          var sep = document.createElement('span');
          sep.style.cssText = 'width:1px;height:20px;background:#445;margin:0 5px;';
          tb.appendChild(sep);
          return;
        }
        var b = document.createElement('button');
        b.className = 'xe2-btn';
        b.innerHTML = item[0];
        b.title = item[1];
        b.onmousedown = function (ev) { ev.preventDefault(); }; // keep editor selection
        b.onclick = function () { if (_api) item[2](_api.editor); };
        tb.appendChild(b);
      });

      ov.querySelector('#xe2Save').onclick = commitAndClose;
      ov.querySelector('#xe2Close').onclick = close;
      ov.querySelector('#xe2V1').onclick = switchToV1;
      document.addEventListener('keydown', _onKeydown, true);

      // (dev0592) R→L drag on the header bar = save + return to G/T. A drag on the
      // editor body would just select text, so the header is the swipe zone (same
      // pattern as the Xs top bar). Pointer events cover both mouse and touch.
      (function wireHeaderSwipeBack() {
        var bar = ov.querySelector('#xe2HeaderBar');
        if (!bar) return;
        var s = null;
        var xy = function (e) { return window.rotateXY ? window.rotateXY(e) : { x: e.clientX, y: e.clientY }; };
        bar.addEventListener('pointerdown', function (e) {
          if (e.target && e.target.closest && e.target.closest('button')) return; // let buttons work
          var p = xy(e); s = { x: p.x, y: p.y, t: Date.now() };
          try { bar.setPointerCapture(e.pointerId); } catch (_) {}
        });
        bar.addEventListener('pointerup', function (e) {
          if (!s) return;
          var p = xy(e), dx = p.x - s.x, dy = p.y - s.y, ms = Date.now() - s.t;
          s = null;
          if (dx < -60 && Math.abs(dy) < Math.abs(dx) && ms < 900) commitAndClose();
        });
        bar.addEventListener('pointercancel', function () { s = null; });
      })();

      setTimeout(function () { if (_api) _api.editor.commands.focus('start'); }, 30);
      console.log('[xe2] opened cell', cellStr, 'field', _field);
      return true;
    } catch (e) {
      console.error('[xe2] open() failed — falling back to v1', e);
      try { close(); } catch (_) {}
      return false;
    }
  }

  window.XE2 = {
    // schema/serialize
    buildExtensions: buildExtensions,
    parseFtext: parseFtext,
    serialize: serialize,
    createEditor: createEditor,
    // lifecycle
    isEnabled: isEnabled,
    enable: enable,
    disable: disable,
    open: open,
    close: close,
    _nodes: { Details: Details, DetailsSummary: DetailsSummary, Small: Small, StyledImage: StyledImage },
    version: 'xe2-m3',
  };
  console.log('[xe2] ready (' + window.XE2.version + ') — flag ' + (isEnabled() ? 'ON' : 'off'));
})();
