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

  // (dev0620) Slide SECTION wrapper — <div class="te-slide" style="color:..;
  // background:..">. In v1 ONE wrapper spanned the whole ftext; here it is a
  // first-class block node, so each ══(hr)-delimited section can carry its OWN
  // colors. grid.js _salSplitSections + _gridThumbApplySlideColors and the
  // dev0619 [style*="color:"] CSS already tolerate per-section wrappers.
  var SlideSection = Node.create({
    name: 'slideSection',
    group: 'block',
    content: 'block+',
    defining: true,
    addAttributes: function () {
      return {
        color: {
          default: '',
          parseHTML: function (el) { return el.style.color || ''; },
          renderHTML: function () { return {}; }, // composed in node renderHTML
        },
        background: {
          default: '',
          parseHTML: function (el) { return el.style.background || el.style.backgroundColor || ''; },
          renderHTML: function () { return {}; },
        },
      };
    },
    parseHTML: function () { return [{ tag: 'div.te-slide' }]; },
    renderHTML: function (p) {
      var a = p.node.attrs, css = '';
      if (a.color) css += 'color: ' + a.color + '; ';
      if (a.background) css += 'background: ' + a.background + ';';
      var attrs = { 'class': 'te-slide' };
      if (css) attrs.style = css.trim();
      return ['div', mergeAttributes(p.HTMLAttributes, attrs), 0];
    },
  });

  function buildExtensions() {
    return [
      StarterKit,
      DetailsSummary, Details, Small, SlideSection,
      Underline,
      StyledImage.configure({ inline: false }),
      Link.configure({ openOnClick: false, autolink: false }),
      Table.configure({ resizable: false }), TableRow, TableHeader, TableCell,
    ];
  }

  // (dev0620) The .te-slide wrapper is now a schema node (SlideSection above),
  // so ftext goes into TipTap verbatim — a legacy whole-doc wrapper parses as
  // one section and serializes back byte-identically. parseFtext/serialize kept
  // as exported names for the headless round-trip tests.
  function parseFtext(raw) { return { inner: raw || '', slide: null }; }

  function serialize(editor) { return editor.getHTML(); }

  function createEditor(element, raw, opts) {
    opts = opts || {};
    var editor = new Editor({
      element: element,
      extensions: buildExtensions(),
      content: raw || '',
      editable: opts.editable !== false,
      editorProps: opts.editorProps || {},
    });
    if (opts.onUpdate) editor.on('update', opts.onUpdate);
    return {
      editor: editor,
      slide: null,
      getFtext: function () { return serialize(editor); },
    };
  }

  // ══ FLAG ════════════════════════════════════════════════════════════════════
  // (dev0620) v2 is now the DEFAULT editor. Opt OUT via localStorage 'xe2'='0'
  // (the header "v1" button / XE2.disable()) or ?xe2=0; ?xe2=1 forces on.
  function isEnabled() {
    try {
      if (/[?&]xe2=1(&|$)/.test(location.search)) return true;
      if (/[?&]xe2=0(&|$)/.test(location.search)) return false;
      return localStorage.getItem('xe2') !== '0';
    } catch (e) { return true; }
  }
  function enable() { try { localStorage.setItem('xe2', '1'); } catch (e) {} console.log('[xe2] enabled — reopen a text cell'); }
  function disable() { try { localStorage.setItem('xe2', '0'); } catch (e) {} console.log('[xe2] disabled — v1 editor active'); }

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

  // ── (dev0621) details family — v1 parity: [▶…] wrap, [[2]] title+body split,
  //    Un[▶] undetail, ¶↑/¶↓ blank line OUTSIDE the block ─────────────────────
  // Wrap the selected top-level lines in a <details>. splitTitle=false ([▶…]):
  // empty summary, caret placed in it, block left open. splitTitle=true ([[2]]):
  // first selected line becomes the summary, the rest becomes the (collapsed) body.
  function wrapSelectionInDetails(editor, splitTitle) {
    var state = editor.state;
    if (_findAncestor(state, 'details')) { _toast('Already inside a collapsible — Un[▶] first'); return; }
    var sel = state.selection;
    var range = sel.$from.blockRange(sel.$to);
    if (!range) return;
    var parent = range.parent;
    if (parent.type.name !== 'doc' && parent.type.name !== 'slideSection') {
      _toast('Select whole lines (not list items / table cells) to wrap');
      return;
    }
    var nodes = [];
    for (var i = range.startIndex; i < range.endIndex; i++) nodes.push(parent.child(i));
    if (!nodes.length) return;
    var detType = editor.schema.nodes.details;
    var sumType = editor.schema.nodes.detailsSummary;
    var paraType = editor.schema.nodes.paragraph;
    var summaryNode, body;
    if (splitTitle && nodes[0].isTextblock) {
      summaryNode = sumType.create(null, nodes[0].content);
      body = nodes.slice(1);
    } else {
      summaryNode = sumType.create();
      body = nodes;
    }
    if (!body.length) body = [paraType.create()];
    var det;
    try { det = detType.create({ open: !splitTitle }, [summaryNode].concat(body)); }
    catch (e) { _toast('That selection can’t go inside a collapsible'); return; }
    try {
      editor.view.dispatch(state.tr.replaceWith(range.start, range.end, det));
      if (!splitTitle) editor.commands.setTextSelection(range.start + 2); // caret into the empty summary
    } catch (e) { console.warn('[xe2] wrap-in-details failed', e); }
    editor.commands.focus();
  }

  // Un[▶]: dissolve the collapsible at the cursor — summary text becomes an H3
  // line, the body blocks stay as-is. (v1 made a bullet list, but bullets are
  // suppressed in every render context since dev0379, so plain blocks it is.)
  function undetail(editor) {
    var state = editor.state;
    var det = _findAncestor(state, 'details');
    if (!det) { _toast('Cursor is not inside a collapsible'); return; }
    var hType = editor.schema.nodes.heading;
    var out = [];
    det.node.forEach(function (ch) {
      if (ch.type.name === 'detailsSummary') {
        if (ch.content.size) out.push(hType.create({ level: 3 }, ch.content));
      } else out.push(ch);
    });
    if (!out.length) out = [editor.schema.nodes.paragraph.create()];
    try {
      editor.view.dispatch(state.tr.replaceWith(det.pos, det.pos + det.node.nodeSize, _frag(state, out)));
    } catch (e) { console.warn('[xe2] undetail failed', e); }
    editor.commands.focus();
  }

  // ¶↑ / ¶↓: blank paragraph OUTSIDE the collapsible at the cursor, so text
  // typed there is not absorbed into the block. where: -1 above, +1 below.
  function lineOutsideDetails(editor, where) {
    var state = editor.state;
    var det = _findAncestor(state, 'details');
    if (!det) { _toast('Cursor is not inside a collapsible'); return; }
    var pos = (where < 0) ? det.pos : det.pos + det.node.nodeSize;
    try {
      editor.view.dispatch(state.tr.insert(pos, editor.schema.nodes.paragraph.create()));
      editor.commands.setTextSelection(pos + 1);
    } catch (e) { console.warn('[xe2] line-outside failed', e); }
    editor.commands.focus();
  }

  // ── (dev0620) section commands ──────────────────────────────────────────────
  function _frag(state, nodes) { return state.doc.content.constructor.fromArray(nodes); }

  // Nearest ancestor node of the given type containing the selection, or null.
  function _findAncestor(state, name) {
    var $from = state.selection.$from;
    for (var d = $from.depth; d >= 1; d--) {
      if ($from.node(d).type.name === name) {
        return { node: $from.node(d), pos: $from.before(d), depth: d };
      }
    }
    return null;
  }
  function _findSection(state) { return _findAncestor(state, 'slideSection'); }

  function _toast(msg) { if (typeof window.toast === 'function') window.toast(msg, 1500); }

  // Set text/bg color on the SECTION containing the cursor. mode 'text'|'bg';
  // empty value clears. A legacy whole-doc wrapper still holding ══(hr)
  // dividers is first split into per-section wrappers so each slide can be
  // colored independently. Cursor outside any wrapper → the hr-delimited
  // top-level segment around it gets wrapped in a fresh colored section.
  function applySectionColor(editor, mode, value) {
    var state = editor.state;
    var secType = editor.schema.nodes.slideSection;
    if (!secType) return;
    var key = (mode === 'bg') ? 'background' : 'color';
    var sec = _findSection(state);

    if (sec) {
      var hasHr = false;
      sec.node.forEach(function (ch) { if (ch.type.name === 'horizontalRule') hasHr = true; });
      if (hasHr) {
        // migrate: one wrapper spanning dividers → one wrapper per section,
        // recoloring ONLY the cursor's segment, all in ONE transaction (after a
        // replaceWith the mapped selection lands past the replacement, so a
        // re-find would pick the wrong section).
        var childIdx = state.selection.$from.index(sec.depth);
        var targetSeg = 0, segScan = 0, scanI = 0;
        sec.node.forEach(function (ch) {
          if (scanI === childIdx) targetSeg = segScan;
          if (ch.type.name === 'horizontalRule') segScan++;
          scanI++;
        });
        var pieces = [], cur = [], segN = 0;
        var flushPiece = function () {
          if (!cur.length) return;
          var a = Object.assign({}, sec.node.attrs);
          if (segN === targetSeg) a[key] = value || '';
          if (!a.color && !a.background) cur.forEach(function (n) { pieces.push(n); }); // fully cleared → no wrapper
          else pieces.push(secType.create(a, cur));
          cur = [];
        };
        sec.node.forEach(function (ch) {
          if (ch.type.name === 'horizontalRule') { flushPiece(); segN++; pieces.push(ch); }
          else cur.push(ch);
        });
        flushPiece();
        try {
          editor.view.dispatch(state.tr.replaceWith(sec.pos, sec.pos + sec.node.nodeSize, _frag(state, pieces)));
        } catch (e) { console.warn('[xe2] section migrate failed', e); }
        editor.commands.focus();
        return;
      }
      var attrs = Object.assign({}, sec.node.attrs);
      attrs[key] = value || '';
      try {
        if (!attrs.color && !attrs.background) {
          // both cleared → drop the wrapper so saved HTML stays clean
          editor.view.dispatch(state.tr.replaceWith(sec.pos, sec.pos + sec.node.nodeSize, sec.node.content));
        } else {
          editor.view.dispatch(state.tr.setNodeMarkup(sec.pos, undefined, attrs));
        }
      } catch (e) { console.warn('[xe2] section color failed', e); }
      editor.commands.focus();
      return;
    }

    if (!value) { editor.commands.focus(); return; } // nothing to clear
    // wrap the top-level blocks between the surrounding dividers
    var doc = state.doc, idx = state.selection.$from.index(0);
    var startIdx = 0, endIdx = doc.childCount, i;
    for (i = 0; i < doc.childCount; i++) {
      if (doc.child(i).type.name !== 'horizontalRule') continue;
      if (i < idx) startIdx = i + 1;
      else { endIdx = i; break; }
    }
    var nodes = [], from = 0, to = 0, pos = 0;
    for (i = 0; i < doc.childCount; i++) {
      var c = doc.child(i);
      if (i === startIdx) from = pos;
      if (i >= startIdx && i < endIdx) {
        if (c.type.name === 'slideSection') { nodes = null; break; } // mixed segment — bail
        nodes.push(c);
      }
      pos += c.nodeSize;
      if (i === endIdx - 1) to = pos;
    }
    if (!nodes || !nodes.length) return;
    var a2 = { color: '', background: '' };
    a2[key] = value;
    try {
      editor.view.dispatch(state.tr.replaceWith(from, to, secType.create(a2, nodes)));
    } catch (e) { console.warn('[xe2] section wrap failed', e); }
    editor.commands.focus();
  }

  // ══ button: inside a colored section, SPLIT the section at the cursor and
  // put the divider between the halves (each keeps the color) — a plain hr
  // dropped inside the wrapper would get the wrapper unwrapped by grid.js's
  // dev0593 hoist, losing the color. Outside a section: plain hr.
  function insertSectionBreak(editor) {
    var state = editor.state, sec = _findSection(state);
    if (!sec) { editor.chain().focus().setHorizontalRule().run(); return; }
    var $from = state.selection.$from;
    if ($from.depth !== 2 || $from.node(1).type.name !== 'slideSection') {
      if (typeof window.toast === 'function') window.toast('Move the cursor out of the collapsible first, then insert the divider', 1600);
      return;
    }
    try {
      var tr = state.tr.split($from.pos, 2);
      tr.insert($from.pos + 2, editor.schema.nodes.horizontalRule.create());
      editor.view.dispatch(tr);
      editor.commands.focus();
    } catch (e) {
      editor.chain().focus().setHorizontalRule().run();
    }
  }

  // A+/A− text size stepper: walks the current block along the em ladder
  // (h6 0.9 → p 1 → h4 1.1 → h3 1.25 → h2 1.5 → h1 2). Stays schema-clean —
  // no inline font-size spans (the v1 corruption vector).
  var SIZE_LADDER = [['heading', 6], ['paragraph', 0], ['heading', 4], ['heading', 3], ['heading', 2], ['heading', 1]];
  function stepBlockSize(editor, dir) {
    var cur = 1; // default slot: paragraph (h5 is the same size — treated as p)
    for (var i = 0; i < SIZE_LADDER.length; i++) {
      var t = SIZE_LADDER[i];
      var hit = (t[0] === 'paragraph') ? editor.isActive('paragraph')
                                       : editor.isActive('heading', { level: t[1] });
      if (hit) { cur = i; break; }
    }
    var ni = cur + dir;
    if (ni < 0 || ni >= SIZE_LADDER.length) return;
    var n = SIZE_LADDER[ni];
    if (n[0] === 'paragraph') editor.chain().focus().setParagraph().run();
    else editor.chain().focus().setHeading({ level: n[1] }).run();
  }

  // Color swatch popup (same palette as v1's teShowColorPicker).
  function showColorPicker(anchorBtn, mode) {
    var old = document.getElementById('xe2ColorPicker');
    if (old) { old.remove(); return; } // re-click toggles
    var COLORS = [
      { v: '',        label: 'default — clear/reset' },
      { v: '#ffffff', label: 'white' }, { v: '#000000', label: 'black' },
      { v: '#ff4444', label: 'red' },   { v: '#ff8c00', label: 'orange' },
      { v: '#ffd700', label: 'yellow' }, { v: '#44cc44', label: 'green' },
      { v: '#4488ff', label: 'blue' },  { v: '#aa66ff', label: 'purple' },
      { v: '#aaaaaa', label: 'gray' },  { v: '#0a0a1a', label: 'editor-bg' },
    ];
    var r = anchorBtn.getBoundingClientRect();
    var pop = document.createElement('div');
    pop.id = 'xe2ColorPicker';
    pop.style.cssText = 'position:fixed;z-index:36800;background:#0d0d1e;border:1px solid #4af;' +
      'border-radius:8px;padding:8px;box-shadow:0 6px 24px rgba(0,0,0,0.7);' +
      'left:' + r.left + 'px;top:' + (r.bottom + 4) + 'px;' +
      'display:grid;grid-template-columns:repeat(6,1fr);gap:6px;';
    COLORS.forEach(function (c) {
      var sw = document.createElement('button');
      sw.style.cssText = 'width:28px;height:28px;border:1px solid #555;border-radius:4px;cursor:pointer;' +
        'background:' + (c.v || 'repeating-linear-gradient(45deg,#444,#444 4px,#222 4px,#222 8px)') + ';' +
        (c.v === '#ffffff' ? 'border-color:#888;' : '');
      sw.title = c.label + (c.v ? ' (' + c.v + ')' : '');
      sw.onmousedown = function (ev) { ev.preventDefault(); }; // keep editor selection
      sw.onclick = function () {
        pop.remove();
        if (_api) applySectionColor(_api.editor, mode, c.v);
      };
      pop.appendChild(sw);
    });
    function onDoc(e) {
      if (!pop.contains(e.target) && e.target !== anchorBtn) {
        pop.remove();
        document.removeEventListener('mousedown', onDoc, true);
      }
    }
    document.addEventListener('mousedown', onDoc, true);
    document.body.appendChild(pop);
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
      ['A&#8722;', 'Smaller text — step the current line down the size ladder', function (e) { stepBlockSize(e, -1); }],
      ['A+', 'Larger text — step the current line up the size ladder', function (e) { stepBlockSize(e, 1); }],
      ['&bull;', 'Bullet list', function (e) { e.chain().focus().toggleBulletList().run(); }],
      ['1.', 'Numbered list', function (e) { e.chain().focus().toggleOrderedList().run(); }],
      ['|'],
      ['&#9654;&hellip;', 'Insert collapsible section', function (e) { insertCollapsible(e); }],
      ['[&#9654;&hellip;]', 'Wrap the selected lines in a collapsible — type the summary title after', function (e) { wrapSelectionInDetails(e, false); }],
      ['[[2]]', 'Wrap selection as collapsible, split into title + detail — FIRST line becomes the summary, the rest the hidden body', function (e) { wrapSelectionInDetails(e, true); }],
      ['Un[&#9654;]', 'Undetail — dissolve the collapsible at the cursor: summary becomes an H3 line, body stays', function (e) { undetail(e); }],
      ['&para;&#8593;', 'Blank line ABOVE the collapsible at the cursor, outside it (Ctrl+Shift+Enter)', function (e) { lineOutsideDetails(e, -1); }],
      ['&para;&#8595;', 'Blank line BELOW the collapsible at the cursor, outside it (Ctrl+Enter)', function (e) { lineOutsideDetails(e, 1); }],
      ['&#9660; All', 'Expand all collapsibles', function (e) { setAllDetails(e, true); }],
      ['&#9654; All', 'Collapse all collapsibles', function (e) { setAllDetails(e, false); }],
      ['|'],
      ['&#9552;&#9552;', 'Divider line — separates sections/slides; inside a colored section it splits the section so both halves keep the color', function (e) { insertSectionBreak(e); }],
      ['&#128444;', 'Insert image', function (e) { insertImage(e); }],
      ['&#128279;', 'Link selection', function (e) { setLink(e); }],
      ['|'],
      ['A&#9662;', 'Text color for the SECTION the cursor is in (whole slide when there are no ══ dividers)', function (e, btn) { showColorPicker(btn, 'text'); }],
      ['&#9635;&#9662;', 'Background color for the section the cursor is in', function (e, btn) { showColorPicker(btn, 'bg'); }],
      ['|'],
      ['S', 'Preview slide (Xs) — pages at each ══ divider, exactly as G/fullscreen will show it', function () {
        if (_api && typeof window.textEditorPreviewSlide === 'function') window.textEditorPreviewSlide(_api.getFtext());
      }],
      ['&#9654;&#9654;', 'Slideshow — play this slide\'s embedded images full-window (5s each)', function () {
        if (_api && typeof window.slideshowOpen === 'function') window.slideshowOpen(_api.getFtext());
      }],
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
      // (dev0620) section wrapper: faint outline so the colored-section extent is
      // visible while editing; an explicit section color must WIN over the
      // element defaults above (same inherit trick as dev0619 in v1/render).
      '#xe2Editor .te-slide{border:1px dashed rgba(120,160,255,0.22);border-radius:6px;padding:4px 10px;margin:6px 0;}',
      '#xe2Editor .te-slide[style*="color:"] :is(p,div,summary,li,span,h1,h2,h3,h4,h5,h6){color:inherit;}',
      // (dev0621) ══ divider — same 2px line as v1/Xs/grid; without this the
      // browser-default thin inset hr made new dividers look like a stray line.
      '#xe2Editor hr{border:none;border-top:2px solid #4a5a7a;margin:16px 0;height:0;}',
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
      // (dev0621) Re-entry (e.g. E-scroll to another row) must not stack overlays.
      if (document.getElementById('xe2Overlay')) close();
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
        '</div>' +
        // (dev0621) HOTKEY GUARD: every global-hotkey gate in core.js/boot.js/
        // collection.js/slideshow.js/hotkeys.js tests presence of the v1 id
        // #textEditorOverlay (pure existence checks, verified). Without it, bare
        // letters typed in v2 fired G hotkeys (r = conveyor, ] = ring). This
        // hidden marker makes v2 look like Xe to all of them; v1 and v2 are
        // never open at once (delegation/switchToV1), so the id can't collide.
        '<span id="textEditorOverlay" style="display:none;"></span>';
      document.body.appendChild(ov);

      // Build the TipTap editor (prevent native <details> toggle fighting PM).
      var mount = ov.querySelector('#xe2Editor');
      _api = createEditor(mount, row[_field] || '', {
        editorProps: {
          // (dev0621) Ctrl+Enter / Ctrl+Shift+Enter = blank line below/above the
          // collapsible at the cursor (v1 parity; same as the ¶↓/¶↑ buttons).
          handleKeyDown: function (view, event) {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault();
              if (_api) lineOutsideDetails(_api.editor, event.shiftKey ? -1 : 1);
              return true;
            }
            return false;
          },
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
        b.onclick = function () { if (_api) item[2](_api.editor, b); };
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
    _nodes: { Details: Details, DetailsSummary: DetailsSummary, Small: Small, StyledImage: StyledImage, SlideSection: SlideSection },
    _applySectionColor: applySectionColor,
    _insertSectionBreak: insertSectionBreak,
    _wrapSelectionInDetails: wrapSelectionInDetails,
    _undetail: undetail,
    _lineOutsideDetails: lineOutsideDetails,
    version: 'xe2-m5',
  };
  console.log('[xe2] ready (' + window.XE2.version + ') — flag ' + (isEnabled() ? 'ON' : 'off'));
})();
