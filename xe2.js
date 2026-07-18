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
  // (dev0630) INLINE (see buildExtensions .configure) so it lives INSIDE a
  // paragraph exactly as ftext stores it (<p><img …></p>). As a block node it
  // couldn't sit in a paragraph, so on load ProseMirror hoisted/mangled every
  // inserted image — the editor diverged from Xs (which renders the raw HTML).
  // Inline also makes a single click select the image (NodeSelection → blue
  // outline) and lets text be typed before/after it and wrap around a float.
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
        // (dev0632) side-margin "fit" level — stored as inline padding-left/right
        // (%) so Xs/G/fullscreen render it with zero extra code.
        pad: {
          default: '',
          parseHTML: function (el) { return el.style.paddingLeft || ''; },
          renderHTML: function () { return {}; },
        },
      };
    },
    parseHTML: function () { return [{ tag: 'div.te-slide' }]; },
    renderHTML: function (p) {
      var a = p.node.attrs, css = '';
      if (a.color) css += 'color: ' + a.color + '; ';
      if (a.background) css += 'background: ' + a.background + '; ';
      if (a.pad) css += 'padding-left: ' + a.pad + '; padding-right: ' + a.pad + ';';
      var attrs = { 'class': 'te-slide' };
      if (css) attrs.style = css.trim();
      return ['div', mergeAttributes(p.HTMLAttributes, attrs), 0];
    },
  });

  // (dev0622) Generic styled <div> block — v1's image modal emits centered /
  // captioned images as <div style="text-align:center..."><img>..<div>caption
  // </div></div>, and many saved rows contain them. Without a node for it the
  // schema UNWRAPPED those divs on save (centering + caption style lost).
  // .te-slide divs are excluded (SlideSection owns those).
  var StyledDiv = Node.create({
    name: 'styledDiv',
    group: 'block',
    content: 'block+',
    defining: true,
    addAttributes: function () {
      return {
        style: {
          default: null,
          parseHTML: function (el) { return el.getAttribute('style'); },
          renderHTML: function (attrs) { return attrs.style ? { style: attrs.style } : {}; },
        },
      };
    },
    parseHTML: function () {
      return [{
        tag: 'div[style]',
        getAttrs: function (el) {
          if (el.classList && (el.classList.contains('te-slide') || el.classList.contains('te-cut'))) return false;
          return { style: el.getAttribute('style') };
        },
      }];
    },
    renderHTML: function (p) { return ['div', mergeAttributes(p.HTMLAttributes), 0]; },
  });

  // (dev0623) v1 ⊘ Hide markup — <div class="te-cut"> is hidden in every render
  // context (.te-cut{display:none!important} in index.html + the vp iframe) but
  // kept as notes. Without this node the schema UNWRAPPED it on save, i.e. a
  // v2 save would have UN-hidden old parked text.
  var TeCut = Node.create({
    name: 'teCut',
    group: 'block',
    content: 'block+',
    defining: true,
    parseHTML: function () { return [{ tag: 'div.te-cut' }]; },
    renderHTML: function (p) { return ['div', mergeAttributes(p.HTMLAttributes, { 'class': 'te-cut' }), 0]; },
  });

  // (dev0632) text-align as a first-class attribute on paragraphs/headings —
  // the vendored bundle has no TextAlign extension, so a minimal global attr
  // serializes to style="text-align:…" (what Xs/G already render).
  var TextAlignAttr = L.Extension.create({
    name: 'xe2TextAlign',
    addGlobalAttributes: function () {
      return [{
        types: ['paragraph', 'heading'],
        attributes: {
          textAlign: {
            default: null,
            parseHTML: function (el) { return el.style.textAlign || null; },
            renderHTML: function (attrs) { return attrs.textAlign ? { style: 'text-align: ' + attrs.textAlign } : {}; },
          },
        },
      }];
    },
  });

  function buildExtensions() {
    return [
      StarterKit,
      TextAlignAttr,
      DetailsSummary, Details, Small, SlideSection, StyledDiv, TeCut,
      Underline,
      StyledImage.configure({ inline: true }),
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

  // (dev0628) PASTE SANITIZER — v1 parity (xe.js paste listener → core.js
  // _sanitizePastedHtml). v2 had NO paste handling, so a rich web paste went
  // into ProseMirror RAW: every framework <div style="--ricos-…"> matched the
  // StyledDiv rule and the whole styled-div soup became the document (UID1778's
  // Wix article pasted as junk that displayed as one un-deletable image).
  // <details> pastes (internal block copies) bypass the sanitizer — the schema
  // owns that structure — losing only HTML comments, same as v1.
  function _transformPastedHTML(html) {
    if (!html) return html;
    // (dev0630) INTERNAL copy — a block cut/copied out of THIS editor. PM's own
    // clipboard serializer tags it data-pm-slice; the schema round-trips those
    // nodes verbatim (details / te-slide colors preserved, already clean), so
    // pass it through untouched. This is the ONLY case that skips the sanitizer.
    if (/data-pm-slice/i.test(html)) return html;
    // Everything else is a FOREIGN paste (web page, v1 copy). ALWAYS sanitize.
    // The old rule bypassed sanitizing for ANY paste containing a <details>
    // anywhere — but PMC/NCBI pages carry <details> sections, so a whole article
    // paste went in raw and its inline styles leaked (UID1782's reddish italic
    // "Introduction" = a surviving <p style="color:#a66;font-style:italic;">).
    // The sanitizer KEEPS <details>/<summary> tags, it only strips junk
    // styles/attrs, so pasted collapsibles still come in as structure.
    if (typeof window._sanitizePastedHtml === 'function') {
      var clean = window._sanitizePastedHtml(html);
      if (clean && clean.trim()) return clean;
    }
    return html;
  }

  function createEditor(element, raw, opts) {
    opts = opts || {};
    var editor = new Editor({
      element: element,
      extensions: buildExtensions(),
      content: raw || '',
      editable: opts.editable !== false,
      editorProps: Object.assign({ transformPastedHTML: _transformPastedHTML }, opts.editorProps),
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
    // (dev0625) Re-sort BEFORE refocus/render: doSave() stamped _row.DateModified,
    // but render() alone reuses the stale sortedIdx, so in a DateModified-sorted
    // view ("LastModOnTop") the edited row kept its old position while showing a
    // newer timestamp — reading as "the modification date isn't updating." Match
    // v1 textEditorClose (which does the same). _setFocusToRow runs after the sort
    // so the row is highlighted at its new position.
    if (typeof window.buildSort === 'function') { try { window.buildSort(); } catch (e) {} }
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
    var key = (mode === 'bg') ? 'background' : (mode === 'pad') ? 'pad' : 'color';
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
          if (!a.color && !a.background && !a.pad) cur.forEach(function (n) { pieces.push(n); }); // fully cleared → no wrapper
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
        if (!attrs.color && !attrs.background && !attrs.pad) {
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
    var a2 = { color: '', background: '', pad: '' };
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

  // ── (dev0632) alignment ─────────────────────────────────────────────────────
  // One button set covers BOTH cases: an image selected (blue outline) gets its
  // float/margin restyled; otherwise the paragraphs/headings in the selection
  // get text-align. Images wrapped by the 🖼 modal (centered/captioned divs)
  // are re-aligned via the modal (double-click the image).
  function alignImage(editor, align) {
    var sel = editor.state.selection, node = sel.node;
    var st = _styleProbe(node.attrs.style);
    var css = 'max-width:100%;border-radius:4px;';
    if (st.width) css += 'width:' + st.width + ';';
    if (align === 'left') css += 'float:left;margin:4px 14px 10px 0;';
    else if (align === 'right') css += 'float:right;margin:4px 0 10px 14px;';
    else css += 'float:none;display:block;margin:10px auto;';
    try {
      editor.view.dispatch(editor.state.tr.setNodeMarkup(sel.from, undefined,
        Object.assign({}, node.attrs, { style: css })));
      editor.commands.setNodeSelection(sel.from);
    } catch (e) { console.warn('[xe2] image align failed', e); }
    editor.commands.focus();
  }
  function applyAlign(editor, align) {
    var sel = editor.state.selection;
    if (sel.node && sel.node.type && sel.node.type.name === 'image') { alignImage(editor, align); return; }
    var state = editor.state, tr = state.tr;
    state.doc.nodesBetween(sel.from, sel.to, function (node, pos) {
      if (node.type.name === 'paragraph' || node.type.name === 'heading') {
        tr.setNodeMarkup(pos, undefined, Object.assign({}, node.attrs,
          { textAlign: (align === 'left') ? null : align }));
      }
    });
    if (tr.steps.length) editor.view.dispatch(tr);
    editor.commands.focus();
  }

  // (dev0632) section side-margin picker — 4 fit levels, applied to the
  // .te-slide wrapper of the section under the cursor (wrapper created on
  // demand, same machinery as the section colors).
  function showMarginPicker(anchorBtn) {
    var old = document.getElementById('xe2MarginPicker');
    if (old) { old.remove(); return; }
    var LEVELS = [
      { v: '',    label: 'Full width — no side margin' },
      { v: '6%',  label: 'Slim margin (6% each side)' },
      { v: '12%', label: 'Medium margin (12% each side)' },
      { v: '20%', label: 'Wide margin (20% each side)' },
    ];
    var r = anchorBtn.getBoundingClientRect();
    var pop = document.createElement('div');
    pop.id = 'xe2MarginPicker';
    pop.style.cssText = 'position:fixed;z-index:36800;background:#0d0d1e;border:1px solid #4af;' +
      'border-radius:8px;padding:6px;box-shadow:0 6px 24px rgba(0,0,0,0.7);' +
      'left:' + r.left + 'px;top:' + (r.bottom + 4) + 'px;display:flex;flex-direction:column;gap:4px;';
    LEVELS.forEach(function (lv) {
      var b = document.createElement('button');
      b.className = 'xe2-btn';
      b.style.textAlign = 'left';
      // little "fit" preview bar + label
      var inset = lv.v ? parseFloat(lv.v) : 0;
      b.innerHTML = '<span style="display:inline-block;width:64px;height:10px;background:#223;border:1px solid #456;' +
        'border-radius:2px;vertical-align:middle;margin-right:8px;position:relative;overflow:hidden;">' +
        '<span style="position:absolute;top:1px;bottom:1px;left:' + inset + '%;right:' + inset + '%;background:#6af;border-radius:1px;"></span>' +
        '</span>' + lv.label;
      b.onmousedown = function (ev) { ev.preventDefault(); };
      b.onclick = function () {
        pop.remove();
        if (_api) applySectionColor(_api.editor, 'pad', lv.v);
      };
      pop.appendChild(b);
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

  // ── (dev0623) image editing ─────────────────────────────────────────────────
  function _styleProbe(css) {
    var el = document.createElement('span');
    el.style.cssText = css || '';
    return el.style;
  }
  function _sizeBucket(width) {
    if (width === '100%') return 'full';
    var n = parseFloat(width);
    if (!n) return 'medium';
    if (n <= 280) return 'small';
    if (n <= 540) return 'medium';
    return 'large';
  }

  // If the selection is an image (NodeSelection) or sits inside a styledDiv
  // image wrapper (centered / captioned / floated form from the modal), return
  // { from, to, defaults:{src,size,align,caption} } for edit-in-place.
  function _findImageEditContext(editor) {
    var state = editor.state, sel = state.selection;
    // outermost styledDiv ancestor that contains an image = modal wrapper
    var $from = sel.$from;
    for (var d = 1; d <= $from.depth; d++) {
      if ($from.node(d).type.name !== 'styledDiv') continue;
      var wrapNode = $from.node(d), found = null;
      wrapNode.descendants(function (n) { if (n.type.name === 'image' && !found) found = n; });
      if (!found) continue;
      var ws = _styleProbe(wrapNode.attrs.style), is = _styleProbe(found.attrs.style);
      var align = (ws.float === 'left' || ws.cssFloat === 'left') ? 'left'
                : (ws.float === 'right' || ws.cssFloat === 'right') ? 'right' : 'center';
      var width = ws.width || is.width || '';
      var caption = '';
      wrapNode.descendants(function (n) {
        if (n.type.name === 'styledDiv') n.descendants(function (t) { if (t.isText) caption += t.text; });
        return n.type.name !== 'styledDiv';
      });
      return {
        from: $from.before(d), to: $from.before(d) + wrapNode.nodeSize,
        defaults: { src: found.attrs.src, size: _sizeBucket(width), align: align, caption: caption.trim() },
      };
    }
    // bare selected image node
    var selNode = sel.node && sel.node.type && sel.node.type.name === 'image' ? sel.node : null;
    if (selNode) {
      var st = _styleProbe(selNode.attrs.style);
      var al = (st.float === 'left' || st.cssFloat === 'left') ? 'left'
             : (st.float === 'right' || st.cssFloat === 'right') ? 'right' : 'center';
      return {
        from: sel.from, to: sel.to,
        defaults: { src: selNode.attrs.src, size: _sizeBucket(st.width), align: al, caption: '' },
      };
    }
    return null;
  }

  function insertImage(editor) {
    // (dev0622) Reuse v1's full image modal (UID-or-URL source, size, alignment,
    // caption) — it just hands back HTML; StyledDiv/StyledImage preserve it.
    // (dev0623) If an image is selected (click it, or double-click), the modal
    // opens pre-filled and REPLACES that image instead of inserting a new one.
    var editCtx = _findImageEditContext(editor);
    if (typeof window.teShowImageModal === 'function') {
      window.teShowImageModal(function (html) {
        if (editCtx) {
          editor.chain().focus()
            .deleteRange({ from: editCtx.from, to: editCtx.to })
            .insertContentAt(editCtx.from, html).run();
        } else {
          editor.chain().focus().insertContent(html).run();
        }
      }, editCtx ? editCtx.defaults : undefined);
      return;
    }
    var url = prompt('Image URL (https://…):', '');
    if (!url) return;
    url = url.trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    editor.chain().focus().insertContent(
      '<img src="' + url.replace(/"/g, '&quot;') + '" style="max-width:100%;width:400px;display:inline-block;border-radius:4px;">'
    ).run();
  }

  // (dev0623) Row of up to 3 images side by side (flex; 3 = left/center/right,
  // 2 = left/right). Each cell is a styledDiv, so you can click into a cell and
  // type a caption line under its image.
  function _resolveImgSrc(v) {
    v = (v || '').trim();
    if (!v) return null;
    if (/^https?:\/\//i.test(v)) return v;
    var rows = Array.isArray(window.data) ? window.data : [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && String(rows[i].UID) === v) return rows[i].link || null;
    }
    return null;
  }
  function insertImageRow(editor) {
    var raw = prompt('Image row — up to 3 sources (UID number or https:// URL), separated by spaces or commas:', '');
    if (!raw) return;
    var parts = raw.split(/[,\s]+/).filter(Boolean).slice(0, 3);
    var urls = [], bad = [];
    parts.forEach(function (p) {
      var u = _resolveImgSrc(p);
      if (u) urls.push(u); else bad.push(p);
    });
    if (bad.length) _toast('No image link for: ' + bad.join(', '));
    if (!urls.length) return;
    var cells = urls.map(function (u) {
      return '<div style="flex:1 1 0;min-width:0;text-align:center;">' +
        '<img src="' + u.replace(/"/g, '&quot;') + '" style="max-width:100%;border-radius:4px;" alt=""></div>';
    }).join('');
    editor.chain().focus().insertContent(
      '<div style="display:flex;gap:12px;justify-content:space-between;align-items:flex-start;margin:12px 0;">' + cells + '</div>'
    ).run();
  }

  // ── (dev0623) ⊘ Hide — v1 parity: wrap the selected lines in div.te-cut
  // (hidden in every render, kept as notes in Xe). Cursor inside a hidden
  // block → the same button SHOWS it again (unwraps).
  function toggleHide(editor) {
    var state = editor.state;
    var cut = _findAncestor(state, 'teCut');
    if (cut) {
      try {
        editor.view.dispatch(state.tr.replaceWith(cut.pos, cut.pos + cut.node.nodeSize, cut.node.content));
        _toast('Shown again — renders in the slide now');
      } catch (e) { console.warn('[xe2] unhide failed', e); }
      editor.commands.focus();
      return;
    }
    var sel = state.selection;
    var range = sel.$from.blockRange(sel.$to);
    if (!range) return;
    var parent = range.parent;
    var nodes = [];
    for (var i = range.startIndex; i < range.endIndex; i++) nodes.push(parent.child(i));
    if (!nodes.length) return;
    try {
      var cutNode = editor.schema.nodes.teCut.create(null, nodes);
      editor.view.dispatch(state.tr.replaceWith(range.start, range.end, cutNode));
    } catch (e) { _toast('That selection can’t be hidden as a block — select whole lines'); }
    editor.commands.focus();
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
      ['&#8676;', 'Align LEFT — selected text lines, or a selected (clicked) image floats left with text wrapping', function (e) { applyAlign(e, 'left'); }],
      ['&#8596;', 'Align CENTER — selected text lines, or a selected image on its own centered line', function (e) { applyAlign(e, 'center'); }],
      ['&#8677;', 'Align RIGHT — selected text lines, or a selected image floats right with text wrapping', function (e) { applyAlign(e, 'right'); }],
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
      ['&#128444;', 'Insert image — or EDIT the selected image (click/double-click an image first to change its size, alignment or caption)', function (e) { insertImage(e); }],
      ['&#128444;&#215;3', 'Row of up to 3 images side by side (3 = left / center / right) — click into a cell to add text under an image', function (e) { insertImageRow(e); }],
      ['&#128279;', 'Link selection', function (e) { setLink(e); }],
      ['&#8856; Hide', 'Hide the SELECTED lines from the rendered slide (kept here, faded, as notes). Cursor inside a hidden block = show it again.', function (e) { toggleHide(e); }],
      ['|'],
      ['A&#9662;', 'Text color for the SECTION the cursor is in (whole slide when there are no ══ dividers)', function (e, btn) { showColorPicker(btn, 'text'); }],
      ['&#9635;&#9662;', 'Background color for the section the cursor is in', function (e, btn) { showColorPicker(btn, 'bg'); }],
      ['&#8677;&#8676;&#9662;', 'Side margins for the SECTION the cursor is in — 4 fit levels from full width to wide margins', function (e, btn) { showMarginPicker(btn); }],
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
      // (dev0622) Real triangle + real collapse in the editor: ▶/▼ drawn in a
      // left gutter (click IT to toggle — clicking the text still edits), and
      // closed details hide their body natively (the old always-show-dimmed
      // rule made [[2]] blocks look uneditable and confusing).
      // (dev0623) bigger triangle; whole summary line is click-to-toggle now,
      // so pointer cursor on the whole line.
      '#xe2Editor summary{cursor:pointer;font-weight:bold;color:#9cf;list-style:none;position:relative;padding-left:28px;}',
      '#xe2Editor summary::-webkit-details-marker{display:none;}',
      '#xe2Editor summary::before{content:"\\25B6";position:absolute;left:2px;top:1px;font-size:16px;color:#6af;cursor:pointer;}',
      '#xe2Editor details[open] > summary::before{content:"\\25BC";}',
      // (dev0620) section wrapper: faint outline so the colored-section extent is
      // visible while editing; an explicit section color must WIN over the
      // element defaults above (same inherit trick as dev0619 in v1/render).
      '#xe2Editor .te-slide{border:1px dashed rgba(120,160,255,0.22);border-radius:6px;padding:4px 10px;margin:6px 0;}',
      '#xe2Editor .te-slide[style*="color:"] :is(p,div,summary,li,span,h1,h2,h3,h4,h5,h6){color:inherit;}',
      // (dev0621) ══ divider — same 2px line as v1/Xs/grid; without this the
      // browser-default thin inset hr made new dividers look like a stray line.
      // (dev0631) clear:both so a floated image before a divider can't spill
      // across the ══ bar into the next section (the "section bars covered by
      // the image" report) — Xs never shows this because it pages at each hr,
      // but the editor is one continuous document so the float must be cleared
      // at the section boundary.
      '#xe2Editor hr{border:none;border-top:2px solid #4a5a7a;margin:16px 0;height:0;clear:both;}',
      // (dev0631) A floated image needs a line-box tall enough to sit in, else a
      // short section lets it overhang; give images a small bottom margin and
      // let the ProseMirror root contain trailing floats.
      '#xe2Editor img{max-width:100%;}',
      '#xe2Editor .ProseMirror::after{content:"";display:block;clear:both;}',
      // (dev0623) selected image/wrapper highlight — click an image, then 🖼 edits it
      '#xe2Editor img.ProseMirror-selectednode,#xe2Editor .ProseMirror-selectednode{outline:3px solid #4af;outline-offset:2px;border-radius:4px;}',
      // (dev0623) hidden-from-render (te-cut) blocks: global CSS hides them
      // everywhere (display:none!important in index.html); higher-specificity
      // override re-shows them faded here, with a banner (matches v1 #teEditor).
      '#xe2Editor .te-cut{display:block!important;opacity:0.45;border:1px dashed #a66;border-radius:6px;padding:4px 10px;margin:6px 0;}',
      '#xe2Editor .te-cut::before{content:"\\2298 hidden in slide \\2014 cursor here + \\2298 Hide shows it again";display:block;font-size:10px;color:#f99;font-weight:bold;}',
      '#xe2Editor table{border-collapse:collapse;} #xe2Editor td,#xe2Editor th{border:1px solid #557;padding:4px 8px;}',
      '#xe2Editor a{color:#7cf;}',
    ].join('\n');
    document.head.appendChild(s);
  }

  function _onKeydown(e) {
    var ov = document.getElementById('xe2Overlay');
    if (!ov) return;
    // (dev0626) Xs on top owns the keys (Esc must close Xs, not this editor;
    // Alt+S must not re-open a second preview). This handler registered before
    // Xs's, so without the guard Esc closed BOTH layers at once.
    if (document.getElementById('teSlideOverlay')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    // (dev0626) Alt+S = Slide preview (Xs), same as the S toolbar button —
    // works while typing. e.code so Alt-composition layouts can't hide the S.
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyS') {
      e.preventDefault(); e.stopPropagation();
      if (_api && typeof window.textEditorPreviewSlide === 'function') window.textEditorPreviewSlide(_api.getFtext());
      return;
    }
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
          // (dev0622) Plain Enter in a SUMMARY = open the block and jump the
          // caret to the first body line — before this, Enter in a summary did
          // nothing (the schema allows only one summary), so a collapsed [[2]]
          // block had no way in.
          handleKeyDown: function (view, event) {
            // (dev0630) Enter while an IMAGE node is selected (single-click it →
            // blue outline) drops a fresh empty line just below it, image kept —
            // the "highlight image, press Enter, get a new line" request. Without
            // this, Enter on a NodeSelection either did nothing or replaced the
            // image.
            if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
              var nsel = view.state.selection;
              if (nsel.node && nsel.node.type && nsel.node.type.name === 'image') {
                event.preventDefault();
                if (_api) {
                  _api.editor.chain()
                    .insertContentAt(nsel.to, { type: 'paragraph' })
                    .setTextSelection(nsel.to + 1)
                    .scrollIntoView()
                    .focus()
                    .run();
                }
                return true;
              }
            }
            // (dev0627) Backspace/Delete inside an EMPTY .te-slide section
            // removes the whole section — plus ONE adjacent ══ divider so no
            // double-hr is left behind. A divider inserted at a section edge
            // splits off an empty half (insertSectionBreak), and that empty
            // white box was otherwise un-erasable: slideSection is a defining
            // block+ node, so backspace in its empty paragraph just sat there.
            if ((event.key === 'Backspace' || event.key === 'Delete')
                && !event.ctrlKey && !event.metaKey && !event.altKey
                && view.state.selection.empty) {
              var st = view.state, $f2 = st.selection.$from;
              for (var sd = $f2.depth; sd >= 1; sd--) {
                if ($f2.node(sd).type.name !== 'slideSection') continue;
                var secNode = $f2.node(sd);
                var hasContent = secNode.textContent.trim() !== '';
                if (!hasContent) {
                  secNode.descendants(function (n) {
                    if (n.type.name === 'image' || n.type.name === 'table' || n.isAtom) hasContent = true;
                  });
                }
                if (hasContent) break;
                var delFrom = $f2.before(sd), delTo = $f2.after(sd);
                var parent = $f2.node(sd - 1), idx = $f2.index(sd - 1);
                var prevSib = idx > 0 ? parent.child(idx - 1) : null;
                var nextSib = idx + 1 < parent.childCount ? parent.child(idx + 1) : null;
                if (prevSib && prevSib.type.name === 'horizontalRule') delFrom -= prevSib.nodeSize;
                else if (nextSib && nextSib.type.name === 'horizontalRule') delTo += nextSib.nodeSize;
                try {
                  view.dispatch(st.tr.delete(delFrom, delTo).scrollIntoView());
                  event.preventDefault();
                  return true;
                } catch (err) { /* schema refused — fall through to default */ }
                break;
              }
            }
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault();
              if (_api) lineOutsideDetails(_api.editor, event.shiftKey ? -1 : 1);
              return true;
            }
            // (dev0623) Enter anywhere on a summary TOGGLES the block: closed →
            // open with the caret dropped on the first body line; open → close.
            if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
              var state = view.state, $from = state.selection.$from;
              for (var d = $from.depth; d >= 2; d--) {
                if ($from.node(d).type.name !== 'detailsSummary') continue;
                var det = $from.node(d - 1);
                if (det.type.name !== 'details') break;
                var detPos = $from.before(d - 1);
                var opening = !det.attrs.open;
                view.dispatch(state.tr.setNodeMarkup(detPos, undefined, Object.assign({}, det.attrs, { open: opening })));
                if (opening && _api) {
                  var bodyStart = detPos + 1 + $from.node(d).nodeSize + 1;
                  _api.editor.commands.setTextSelection(bodyStart);
                }
                event.preventDefault();
                return true;
              }
            }
            return false;
          },
          handleDOMEvents: {
            // (dev0623) Click ANYWHERE on a summary line toggles the block via a
            // schema transaction (DOM can never drift from the open attr; native
            // toggle stays suppressed). The caret still lands where clicked
            // (ProseMirror places it on mousedown), so the title stays editable.
            click: function (view, event) {
              // (dev0631) Single click on an IMAGE selects the image node so the
              // blue outline shows (the "click doesn't highlight it" report).
              // Inline images don't auto-select on click — PM drops a text caret
              // beside them — so force a NodeSelection at the image's position.
              var cimg = (event.target && event.target.tagName === 'IMG') ? event.target : null;
              if (cimg) {
                try {
                  var ipos = view.posAtDOM(cimg, 0);
                  var inode = view.state.doc.nodeAt(ipos);
                  if (inode && inode.type.name === 'image' && _api) {
                    event.preventDefault();
                    _api.editor.commands.setNodeSelection(ipos);
                    return true;
                  }
                } catch (e2) { /* odd geometry — ignore */ }
              }
              var sum = (event.target && event.target.closest) ? event.target.closest('summary') : null;
              if (!sum) return false;
              event.preventDefault();
              try {
                var $pos = view.state.doc.resolve(view.posAtDOM(sum, 0));
                for (var d = $pos.depth; d >= 1; d--) {
                  if ($pos.node(d).type.name === 'details') {
                    var node = $pos.node(d), pos = $pos.before(d);
                    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined,
                      Object.assign({}, node.attrs, { open: !node.attrs.open })));
                    return true;
                  }
                }
              } catch (err) { /* odd geometry — ignore */ }
              return false;
            },
            // (dev0623) Double-click an image = edit it (size/alignment/caption)
            // in the modal, replacing in place.
            dblclick: function (view, event) {
              var img = (event.target && event.target.tagName === 'IMG') ? event.target : null;
              if (!img) return false;
              event.preventDefault();
              try {
                var pos = view.posAtDOM(img, 0);
                if (_api) {
                  _api.editor.commands.setNodeSelection(pos);
                  insertImage(_api.editor);
                }
                return true;
              } catch (err) { return false; }
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
    _toggleHide: toggleHide,
    _findImageEditContext: _findImageEditContext,
    version: 'xe2-m8',
  };
  console.log('[xe2] ready (' + window.XE2.version + ') — flag ' + (isEnabled() ? 'ON' : 'off'));
})();
