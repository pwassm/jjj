// ═══════════════════════════════════════════════════════════════════════════
// makecard.js  (dev0851) — "MakeCard": clipboard image + clipboard text → one
// ml.json flash-card row, with the image hosted on R2.
//
// Replaces  M:\ScreenCaps\Make fish image quiz2.ahk , which built standalone
// .html files with the JPEG inlined as base64. Same two-step capture, same
// two-part card (image page → page break → text page), but:
//   • the image goes to  M:\wm\flashimages\  and up to the R2 bucket `media`
//     under a  flashimages/  prefix (proxy POST /card/save), so ftext carries
//     a ~70-byte URL instead of a ~200 KB data: URI. One base64 image would
//     have been the single largest ftext row in the whole file.
//   • the text becomes real ftext, so the card is editable in Xe and renders
//     in Xs / G like every other slide.
// The old standalone-file format is still reachable — "🃏 Card .html" on the
// T row menu re-inlines the image as base64 and downloads exactly that shape.
//
// WHY THERE IS NO CLIPBOARD-CHANGE EVENT: a web page cannot be notified when
// the OS clipboard changes (only a desktop process can, and background pollers
// are not wanted here). So the modal re-reads the clipboard every time the
// window REGAINS FOCUS — which is precisely the moment you come back from
// Perplexity — and a plain Ctrl+V into the modal works as the fallback.
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var PROXY = 'http://127.0.0.1:8081';
  var JPEG_QUALITY = 0.92;

  var _mcState = null;   // null when closed; otherwise the live card session

  // ── small helpers ────────────────────────────────────────────────────────
  function _mcToast(msg, ms) {
    if (typeof toast === 'function') toast(msg, ms || 2600);
    else console.log('[makecard] ' + msg);
  }
  function _mcEsc(s) {
    return typeof escH === 'function'
      ? escH(s)
      : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  // escH does NOT escape quotes, and these strings go into href="…" / src="…".
  function _mcAttr(s) { return _mcEsc(s).replace(/"/g, '&quot;'); }

  function _mcStamp() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-'
         + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  // ── markdown → ftext HTML ────────────────────────────────────────────────
  // A port of the .ahk's RegExReplace pipeline, restricted to tags that are
  // BOTH in _sanitizePastedHtml's KEEP set and in the xe2.js schema — so the
  // card survives an Xe open + autosave round trip untouched.
  function _mcInline(s) {
    var t = _mcEsc(s);
    // [label](url) first: emphasis must never get a chance to chew a URL that
    // contains * or _ .
    t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, function (m, label, url) {
      return '<a href="' + url.replace(/"/g, '&quot;') + '" target="_blank" rel="noopener">' + label + '</a>';
    });
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return t;
  }

  function _mcMarkdownToHtml(md) {
    var lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    var out = [], para = [], listOpen = false;
    function flushPara() { if (para.length) { out.push('<p>' + para.join('<br>') + '</p>'); para = []; } }
    function closeList() { if (listOpen) { out.push('</ul>'); listOpen = false; } }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\s+$/, '');
      if (!line.trim()) { flushPara(); closeList(); continue; }

      // A markdown thematic break (---, ***) is DROPPED, not turned into <hr>.
      // A top-level <hr> is what every render context splits a slide on, and
      // this card already spends its one <hr> on the image/text fold.
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushPara(); closeList(); continue; }

      var h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        flushPara(); closeList();
        var lv = h[1].length;
        out.push('<h' + lv + '>' + _mcInline(h[2].trim()) + '</h' + lv + '>');
        continue;
      }

      if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
        flushPara();
        if (!listOpen) { out.push('<ul>'); listOpen = true; }
        out.push('<li>' + _mcInline(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')) + '</li>');
        continue;
      }

      closeList();
      para.push(_mcInline(line.trim()));
    }
    flushPara(); closeList();
    var html = out.join('\n');
    // Bare (non-markdown) URLs → anchors. _linkifyHtml walks tags properly, so
    // it cannot double-wrap the anchors built above.
    return typeof _linkifyHtml === 'function' ? _linkifyHtml(html) : html;
  }

  // Perplexity's Copy gives markdown in text/plain. Anything else pasted in is
  // more likely to be real HTML, which the app already knows how to clean.
  function _mcLooksLikeMarkdown(txt) {
    return /(^|\n)#{1,6}\s/.test(txt) || /\*\*[^*]+\*\*/.test(txt)
        || /(^|\n)\s*[-*+]\s+\S/.test(txt) || /\[[^\]]+\]\(https?:\/\//.test(txt);
  }

  function _mcTextToHtml(plain, html) {
    if (plain && _mcLooksLikeMarkdown(plain)) return _mcMarkdownToHtml(plain);
    if (html && html.trim() && typeof _sanitizePastedHtml === 'function') {
      var clean = _sanitizePastedHtml(html);
      if (clean && clean.trim()) return clean;
    }
    if (plain && plain.trim()) return _mcMarkdownToHtml(plain);
    return '';
  }

  // First meaningful line, minus markdown furniture — becomes the row's VidTitle.
  function _mcTitleFrom(plain) {
    var lines = String(plain || '').replace(/\r\n?/g, '\n').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].replace(/^[#*\s>-]+/, '').replace(/[#*\s]+$/, '').trim();
      if (!t) continue;
      // Drop a trailing markdown citation so the title is a sentence, not a link.
      t = t.replace(/\s*\[[^\]]+\]\(https?:\/\/[^\s)]+\)\s*$/, '').trim();
      if (t) return t.slice(0, 160);
    }
    return '';
  }

  // ── the card's ftext ─────────────────────────────────────────────────────
  function _mcBuildFtext(imgUrl, bodyHtml) {
    return '<p style="text-align:center;margin:0 0 10px 0;">'
         + '<img src="' + _mcAttr(imgUrl) + '" alt="" '
         + 'style="max-width:100%;max-height:82vh;height:auto;border-radius:8px;">'
         + '</p>\n<hr>\n' + bodyHtml;
  }

  // ── clipboard ────────────────────────────────────────────────────────────
  var IMG_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

  async function _mcReadClipboardImage() {
    if (!navigator.clipboard || !navigator.clipboard.read) return null;
    var items = await navigator.clipboard.read();
    for (var i = 0; i < items.length; i++) {
      for (var t = 0; t < IMG_TYPES.length; t++) {
        if (items[i].types.indexOf(IMG_TYPES[t]) >= 0) {
          return { blob: await items[i].getType(IMG_TYPES[t]), type: IMG_TYPES[t] };
        }
      }
    }
    return null;
  }

  async function _mcReadClipboardText() {
    var plain = '', html = '';
    if (navigator.clipboard && navigator.clipboard.read) {
      try {
        var items = await navigator.clipboard.read();
        for (var i = 0; i < items.length; i++) {
          if (!html && items[i].types.indexOf('text/html') >= 0) html = await (await items[i].getType('text/html')).text();
          if (!plain && items[i].types.indexOf('text/plain') >= 0) plain = await (await items[i].getType('text/plain')).text();
        }
      } catch (_) { /* fall through to readText */ }
    }
    if (!plain && navigator.clipboard && navigator.clipboard.readText) {
      try { plain = await navigator.clipboard.readText(); } catch (_) {}
    }
    return { plain: plain, html: html };
  }

  // ── image → JPEG → proxy → R2 ────────────────────────────────────────────
  // JPEG at q0.92 mirrors what the .ahk did (GDI+ quality 90). A clipboard
  // "Copy image" in Chrome is always a PNG, and a PNG of a photograph is
  // several times the size for no visible gain — and this one is going to be
  // fetched by every visitor, not just by us.
  async function _mcToJpeg(blob) {
    if (/jpe?g/i.test(blob.type)) return { blob: blob, mime: 'image/jpeg' };
    var bmp = await createImageBitmap(blob);
    var cv = document.createElement('canvas');
    cv.width = bmp.width; cv.height = bmp.height;
    var cx = cv.getContext('2d');
    cx.fillStyle = '#ffffff';                 // JPEG has no alpha channel
    cx.fillRect(0, 0, cv.width, cv.height);
    cx.drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    var out = await new Promise(function (r) { cv.toBlob(r, 'image/jpeg', JPEG_QUALITY); });
    return out ? { blob: out, mime: 'image/jpeg', w: cv.width, h: cv.height }
               : { blob: blob, mime: blob.type, w: cv.width, h: cv.height };
  }

  function _mcBlobToB64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result).replace(/^data:[^,]*,/, '')); };
      fr.onerror = function () { reject(new Error('could not read the image bytes')); };
      fr.readAsDataURL(blob);
    });
  }

  async function _mcUpload(payload) {
    var r;
    try {
      r = await fetch(PROXY + '/card/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (_) {
      throw new Error('Proxy not reachable on 8081 — start proxy.js (needs the dev0851 build: RESTART it)');
    }
    var j = null;
    try { j = await r.json(); } catch (_) {}
    if (!j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
    return j;
  }

  // ── standalone .html export (base64 inlined) ─────────────────────────────
  // The .ahk's output format, rebuilt from a row. Keeps the file portable —
  // it opens with no network, no R2, no app.
  var CARD_CSS =
    '* { box-sizing: border-box; }\n' +
    'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; line-height: 1.6; margin: 0; padding: 0; color: #1e293b; background: #f8fafc; }\n' +
    '.image-page { min-height: 96vh; display: flex; align-items: center; justify-content: center; padding: 20px; page-break-after: always; break-after: page; }\n' +
    'img.specimen { max-width: 95vw; max-height: 90vh; object-fit: contain; border-radius: 8px; box-shadow: 0 4px 14px rgba(0,0,0,0.15); display: block; }\n' +
    '.text-page { max-width: 820px; margin: 0 auto; padding: 40px 24px 60px 24px; }\n' +
    '.card { background: #ffffff; border-radius: 12px; padding: 32px; box-shadow: 0 4px 10px rgba(0,0,0,0.06); }\n' +
    'h1, h2, h3 { color: #0f172a; margin-top: 18px; }\n' +
    'li { margin-bottom: 6px; }\n' +
    'a { color: #2563eb; text-decoration: none; word-break: break-all; }\n' +
    'a:hover { text-decoration: underline; color: #1d4ed8; }';

  // ftext → { imgUrl, bodyHtml }. The fold is the first TOP-LEVEL <hr>, which
  // is the same rule G and Xs use to split a slide into pages.
  function _mcSplitCard(ftext) {
    var s = String(ftext || '');
    var m = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/i.exec(s);
    var imgUrl = m ? m[1] : '';
    var cut = s.search(/<hr\b[^>]*>/i);
    var body = cut >= 0 ? s.slice(cut).replace(/^<hr\b[^>]*>/i, '') : s;
    // Drop the leading image paragraph when there was no <hr> to cut at.
    if (cut < 0 && m) body = s.replace(m[0], '');
    return { imgUrl: imgUrl, body: body.trim() };
  }

  async function _mcFetchAsDataUri(url) {
    // R2's custom domain sends no CORS header, so the local proxy is the normal
    // path; a direct fetch is the fallback for same-origin / already-CORS URLs.
    var blob = null;
    try {
      var r = await fetch(PROXY + '/' + url);
      if (r.ok) blob = await r.blob();
    } catch (_) {}
    if (!blob) {
      var r2 = await fetch(url);
      if (!r2.ok) throw new Error('could not fetch the image (HTTP ' + r2.status + ')');
      blob = await r2.blob();
    }
    var mime = blob.type || 'image/jpeg';
    return 'data:' + mime + ';base64,' + await _mcBlobToB64(blob);
  }

  async function makeCardExportRow(di) {
    var row = (typeof data !== 'undefined' && data) ? data[di] : null;
    if (!row || !row.ftext) { _mcToast('Row ' + (di + 1) + ' has no ftext to export.', 3000); return; }
    var parts = _mcSplitCard(row.ftext);
    if (!parts.imgUrl) { _mcToast('Row ' + (di + 1) + ': no <img> found in ftext.', 3000); return; }

    _mcToast('Inlining image…', 4000);
    var dataUri;
    try { dataUri = await _mcFetchAsDataUri(parts.imgUrl); }
    catch (e) { _mcToast('⚠ ' + e.message, 6000); return; }

    var title = String(row.VidTitle || ('Card ' + (row.UID || di + 1)));
    var html =
      '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n' +
      '<title>' + _mcEsc(title) + '</title>\n<style>\n' + CARD_CSS + '\n</style>\n</head>\n<body>\n' +
      '  <div class="image-page">\n    <img class="specimen" src="' + dataUri + '" alt="Specimen Image">\n  </div>\n' +
      '  <div class="text-page">\n    <div class="card">\n      <div class="content">\n' +
      parts.body + '\n      </div>\n    </div>\n  </div>\n</body>\n</html>\n';

    var stem = (title.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60)) || ('card-' + (row.UID || di));
    var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = stem + '.html';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    _mcToast('✓ ' + a.download + '  (' + Math.round(html.length / 1024) + ' KB)', 5000);
  }

  // Offered on the T row menu only for rows that actually are cards.
  function makeCardRowIsCard(row) {
    return !!(row && row.ftext && /<hr\b/i.test(row.ftext) && /<img\b[^>]*\bsrc=/i.test(row.ftext));
  }

  // ── modal ────────────────────────────────────────────────────────────────
  function _mcStyle() {
    if (document.getElementById('mcCardStyle')) return;
    var st = document.createElement('style');
    st.id = 'mcCardStyle';
    st.textContent = [
      '#mcCardOverlay{position:fixed;inset:0;z-index:100000;background:rgba(4,6,14,0.82);display:flex;align-items:center;justify-content:center;}',
      '#mcCardBox{width:min(620px,94vw);max-height:92vh;overflow:auto;background:#151824;border:1px solid #68a;border-radius:10px;padding:18px 20px 16px;color:#cde;font-family:monospace;box-shadow:0 18px 60px rgba(0,0,0,0.6);}',
      '#mcCardBox h2{margin:0 0 4px;font-size:16px;color:#9cf;letter-spacing:0.5px;}',
      '#mcCardBox .mc-sub{font-size:11px;color:#89a;margin:0 0 14px;}',
      '#mcCardBox .mc-step{border:1px solid #33405c;border-radius:8px;padding:10px 12px;margin-bottom:10px;background:#10131d;}',
      '#mcCardBox .mc-step.on{border-color:#5bf;background:#121a2a;}',
      '#mcCardBox .mc-step.done{border-color:#3a7;background:#0f1a16;}',
      '#mcCardBox .mc-h{font-size:12px;font-weight:bold;color:#cde;margin-bottom:4px;}',
      '#mcCardBox .mc-t{font-size:11px;color:#9ab;line-height:1.55;}',
      '#mcCardBox .mc-t b{color:#dfe;}',
      '#mcCardBox img.mc-prev{max-width:100%;max-height:170px;border-radius:6px;margin-top:8px;display:block;}',
      '#mcCardBox textarea{width:100%;box-sizing:border-box;height:96px;margin-top:8px;background:#0b0d14;color:#cde;border:1px solid #445;border-radius:5px;padding:7px;font-family:monospace;font-size:11px;resize:vertical;}',
      '#mcCardBox .mc-row{display:flex;gap:8px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap;}',
      '#mcCardBox button{background:#1a1a24;color:#cde;border:1px solid #68a;border-radius:5px;padding:6px 13px;font-family:monospace;font-size:12px;cursor:pointer;}',
      '#mcCardBox button:hover{background:#243049;}',
      '#mcCardBox button.mc-go{border-color:#5bf;color:#9cf;}',
      '#mcCardBox button.mc-x{border-color:#f66;color:#f88;}',
      '#mcCardBox .mc-err{color:#f99;font-size:11px;margin-top:8px;white-space:pre-wrap;}'
    ].join('\n');
    document.head.appendChild(st);
  }

  function _mcRender() {
    var s = _mcState;
    if (!s) return;
    var box = document.getElementById('mcCardBox');
    if (!box) return;
    var imgDone = !!s.imgUrl;
    box.innerHTML =
      '<h2>🃏 MakeCard</h2>' +
      '<p class="mc-sub">image → R2, then text → a new ml.json slide. Copy each, then click back on this window.</p>' +

      '<div class="mc-step ' + (imgDone ? 'done' : 'on') + '">' +
        '<div class="mc-h">' + (imgDone ? '✓ 1 · Image' : '1 · Image') + '</div>' +
        '<div class="mc-t">' + (imgDone
          ? 'Uploaded → <b>' + _mcEsc(s.imgName || '') + '</b><br>' + _mcEsc(s.imgUrl)
          : s.busy === 'image'
            ? 'Uploading…'
            : 'Copy the picture (right-click ▸ <b>Copy image</b>), then return here. Ctrl+V also works.') +
        '</div>' +
        (s.imgPreview ? '<img class="mc-prev" src="' + _mcAttr(s.imgPreview) + '" alt="">' : '') +
      '</div>' +

      '<div class="mc-step ' + (imgDone ? 'on' : '') + '">' +
        '<div class="mc-h">2 · Text</div>' +
        '<div class="mc-t">' + (imgDone
          ? 'Now copy the Perplexity answer, then return here — or paste it below.'
          : 'Waiting for the image first.') + '</div>' +
        (imgDone ? '<textarea id="mcCardText" placeholder="…or paste the text here and press Make card"></textarea>' : '') +
      '</div>' +

      (s.err ? '<div class="mc-err">⚠ ' + _mcEsc(s.err) + '</div>' : '') +

      '<div class="mc-row">' +
        '<button class="mc-x" id="mcCardCancel">Cancel</button>' +
        '<button id="mcCardRead">Read clipboard now</button>' +
        (imgDone ? '<button class="mc-go" id="mcCardMake">Make card</button>' : '') +
      '</div>';

    box.querySelector('#mcCardCancel').onclick = makeCardClose;
    box.querySelector('#mcCardRead').onclick = function () { _mcPoll(true); };
    var mk = box.querySelector('#mcCardMake');
    if (mk) mk.onclick = function () {
      var ta = document.getElementById('mcCardText');
      var txt = ta ? ta.value : '';
      if (txt && txt.trim()) _mcFinish(txt, '');
      else _mcPoll(true);
    };
  }

  function _mcSetErr(msg) { if (_mcState) { _mcState.err = msg || ''; _mcRender(); } }

  // One clipboard look. `manual` = the user asked, so say something either way;
  // the focus-driven calls stay quiet when there is nothing new.
  async function _mcPoll(manual) {
    var s = _mcState;
    if (!s || s.busy) return;

    if (!s.imgUrl) {
      s.busy = 'image'; _mcSetErr('');
      try {
        var got = await _mcReadClipboardImage();
        if (!got) {
          s.busy = null;
          if (manual) _mcSetErr('No image on the clipboard yet.');
          else _mcRender();
          return;
        }
        _mcRender();
        await _mcAcceptImage(got.blob);
      } catch (e) {
        s.busy = null;
        _mcSetErr(_mcClipErr(e));
      }
      return;
    }

    s.busy = 'text';
    try {
      var t = await _mcReadClipboardText();
      s.busy = null;
      // The image copy is usually still the newest thing on the clipboard the
      // first time round; an empty read is not an error.
      if (!t.plain.trim() && !t.html.trim()) { if (manual) _mcSetErr('No text on the clipboard yet.'); return; }
      await _mcFinish(t.plain, t.html);
    } catch (e) {
      s.busy = null;
      _mcSetErr(_mcClipErr(e));
    }
  }

  function _mcClipErr(e) {
    var m = String((e && e.message) || e);
    if (/not allowed|denied|permission/i.test(m)) {
      return 'Chrome blocked the clipboard read. Click inside this box and press Ctrl+V instead.';
    }
    return m;
  }

  async function _mcAcceptImage(blob) {
    var s = _mcState;
    if (!s) return;
    s.busy = 'image'; s.err = ''; _mcRender();
    try {
      var jpg = await _mcToJpeg(blob);
      var b64 = await _mcBlobToB64(jpg.blob);
      var res = await _mcUpload({ b64: b64, mime: jpg.mime, stem: 'card-' + _mcStamp() });
      s.imgUrl = res.url;
      s.imgName = res.name;
      s.imgBytes = res.bytes;
      // Preview off the blob — no point re-inflating the base64 into the DOM.
      s.imgPreview = URL.createObjectURL(jpg.blob);
      s.busy = null;
      _mcRender();
      _mcToast('✓ Image on R2 (' + Math.round((res.bytes || 0) / 1024) + ' KB) — now copy the text', 5000);
    } catch (e) {
      s.busy = null;
      _mcSetErr(String((e && e.message) || e));
    }
  }

  async function _mcFinish(plain, html) {
    var s = _mcState;
    if (!s || !s.imgUrl) return;
    var body = _mcTextToHtml(plain, html);
    if (!body || !body.trim()) { _mcSetErr('That clipboard content produced no text.'); return; }

    if (typeof data === 'undefined' || !Array.isArray(data)) { _mcSetErr('ml.json is not loaded.'); return; }
    // Belt and braces: on the C screen `data` IS c.json, and save() writes
    // ml.json — pushing a row here would put a card into the grid config.
    if (typeof _cMode !== 'undefined' && _cMode) { _mcSetErr('Not on the C screen — go back to T first.'); return; }

    var ftext = _mcBuildFtext(s.imgUrl, body);
    var title = _mcTitleFrom(plain);
    var now = (typeof isoNow === 'function') ? isoNow() : new Date().toISOString().slice(0, 19).replace('T', ' ');
    var row = {
      UID: (typeof nextUID === 'function') ? nextUID() : String(Date.now()),
      link: '', show: '1', DateAdded: now, DateModified: now,
      ltype: 0, ftext: ftext, tags: []
    };
    if (title) row.VidTitle = title;
    data.push(row);

    if (typeof save === 'function') save();
    if (typeof buildSort === 'function') {
      try { sortCol = 'DateAdded'; sortDir = 'desc'; buildSort(); } catch (_) {}
    }
    if (typeof render === 'function') render();

    makeCardClose();
    _mcToast('✓ Card row UID ' + row.UID + ' · ' + ftext.length.toLocaleString() + ' chars'
             + (title ? ' · ' + title.slice(0, 48) : ''), 6000);
  }

  // Ctrl+V straight into the modal — no clipboard permission needed, and the
  // reliable path when Chrome refuses navigator.clipboard.read().
  function _mcOnPaste(e) {
    if (!_mcState || !e.clipboardData) return;
    var dt = e.clipboardData;
    if (_mcState.busy) return;
    if (!_mcState.imgUrl) {
      for (var i = 0; i < dt.items.length; i++) {
        if (dt.items[i].kind === 'file' && /^image\//.test(dt.items[i].type)) {
          e.preventDefault();
          _mcAcceptImage(dt.items[i].getAsFile());
          return;
        }
      }
      return;   // no image yet — let a stray text paste fall through harmlessly
    }
    // Stage 2: let the textarea take a plain paste; anything else we handle.
    if (e.target && e.target.id === 'mcCardText') return;
    e.preventDefault();
    _mcFinish(dt.getData('text/plain') || '', dt.getData('text/html') || '');
  }

  function _mcOnFocus() { if (_mcState) setTimeout(function () { _mcPoll(false); }, 120); }

  function _mcOnKey(e) {
    if (!_mcState) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); makeCardClose(); }
  }

  function makeCardOpen() {
    if (_mcState) return;
    if (typeof _tScreenActive === 'function' && !_tScreenActive()) {
      _mcToast('MakeCard works on the T table.', 2500);
      return;
    }
    _mcStyle();
    _mcState = { imgUrl: '', imgName: '', imgPreview: '', busy: null, err: '' };

    var ov = document.createElement('div');
    ov.id = 'mcCardOverlay';
    ov.innerHTML = '<div id="mcCardBox"></div>';
    ov.addEventListener('pointerdown', function (e) { if (e.target === ov) makeCardClose(); });
    document.body.appendChild(ov);
    _mcRender();

    window.addEventListener('focus', _mcOnFocus);
    document.addEventListener('paste', _mcOnPaste, true);
    document.addEventListener('keydown', _mcOnKey, true);

    // If an image is already sitting on the clipboard (the usual case — you
    // copy the picture, then press the button) this picks it up immediately.
    _mcPoll(false);
  }

  function makeCardClose() {
    if (!_mcState) return;
    if (_mcState.imgPreview && /^blob:/.test(_mcState.imgPreview)) {
      try { URL.revokeObjectURL(_mcState.imgPreview); } catch (_) {}
    }
    _mcState = null;
    window.removeEventListener('focus', _mcOnFocus);
    document.removeEventListener('paste', _mcOnPaste, true);
    document.removeEventListener('keydown', _mcOnKey, true);
    var ov = document.getElementById('mcCardOverlay');
    if (ov) ov.remove();
  }

  // ── wiring ───────────────────────────────────────────────────────────────
  window.makeCardOpen       = makeCardOpen;
  window.makeCardClose      = makeCardClose;
  window.makeCardExportRow  = makeCardExportRow;
  window.makeCardRowIsCard  = makeCardRowIsCard;
  window.makeCardIsOpen     = function () { return !!_mcState; };
  // Exposed for a console round-trip check without touching the clipboard.
  window._mcMarkdownToHtml  = _mcMarkdownToHtml;

  function _mcBind() {
    var btn = document.getElementById('makeCardBtn');
    if (btn && !btn._mcBound) { btn._mcBound = true; btn.addEventListener('click', makeCardOpen); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _mcBind);
  else _mcBind();
})();
