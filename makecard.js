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
  // [label](url) → anchor. NOT a regex: a naive /\(([^\s)]+)\)/ ends the URL at
  // the FIRST ")", and real citation URLs contain parentheses —
  //   …/DIET-AND-FEEDING-IN-THE-SEA-STAR-ASTROPECTEN-(1888)-Loh-Todd/be9a…
  // truncated to "…-ASTROPECTEN-(1888" with "-Loh-Todd/be9a…)" stranded as text
  // beside a dead link (observed on UID 2160, dev0851).
  // A URL cannot contain whitespace, so the token is unambiguous: take
  // everything up to the next space, and treat the LAST ")" in it as markdown's
  // closing delimiter. Anything after that ")" is real trailing text and is
  // re-emitted — which also fixes "[a](url)." losing its full stop.
  function _mcMdLinks(t) {
    var out = '', i = 0;
    while (true) {
      var open = t.indexOf('](', i);
      if (open < 0) { out += t.slice(i); return out; }
      // Walk back to the matching '[' — labels never contain '[' or a newline.
      var lb = t.lastIndexOf('[', open);
      if (lb < 0 || /[\n\]]/.test(t.slice(lb + 1, open))) { out += t.slice(i, open + 2); i = open + 2; continue; }

      var urlStart = open + 2;
      var sp = t.slice(urlStart).search(/\s/);
      var tok = sp < 0 ? t.slice(urlStart) : t.slice(urlStart, urlStart + sp);
      var close = tok.lastIndexOf(')');
      var url = close < 0 ? '' : tok.slice(0, close);

      if (!/^https?:\/\//i.test(url)) { out += t.slice(i, open + 2); i = open + 2; continue; }

      out += t.slice(i, lb)
           + '<a href="' + url.replace(/"/g, '&quot;') + '" target="_blank" rel="noopener">'
           + t.slice(lb + 1, open) + '</a>'
           + tok.slice(close + 1);          // trailing text that followed the ")"
      i = urlStart + tok.length;
    }
  }

  function _mcInline(s) {
    // Links first: emphasis must never get a chance to chew a URL holding * or _.
    var t = _mcMdLinks(_mcEsc(s));
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
  // (dev0858) THREE sections, two breaks:
  //
  //   1  the image          the card FRONT
  //   2  the text           Phil hand-edits this one; it is what TurnCard shows
  //   3  the same text      left as generated; swipe right on the cell shows it
  //
  // Both text sections start out identical. The second is meant to be cut down
  // in Xe until it reads well on a turned card, while the third keeps the full
  // original so nothing is lost by editing.
  //
  // The separator is a plain <hr>, the same break every render context in the
  // app splits a slide on. That means a break added INSIDE section 2 starts a
  // new section, so keep the edit break-free.
  function _mcBuildFtext(imgUrl, bodyHtml) {
    return '<p style="text-align:center;margin:0 0 10px 0;">'
         + '<img src="' + _mcAttr(imgUrl) + '" alt="" '
         + 'style="max-width:100%;max-height:82vh;height:auto;border-radius:8px;">'
         + '</p>\n<hr>\n' + bodyHtml + '\n<hr>\n' + bodyHtml;
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

  // (dev0858) Returns { imgUrl, body, orig }:
  //   body  section 2 -- the display copy, what the card back shows
  //   orig  section 3 -- the untouched original, '' on a pre-dev0858 card
  // A card written before dev0858 has only ONE break and therefore no section 3;
  // it keeps working, it just has nothing to swipe to.
  function _mcSplitCard(ftext) {
    var s = String(ftext || '');
    var m = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/i.exec(s);
    var imgUrl = m ? m[1] : '';
    var parts = s.split(/<hr\b[^>]*>/i);
    if (parts.length < 2) {
      // No break at all: drop the leading image paragraph so body is just text.
      var only = m ? s.replace(m[0], '') : s;
      return { imgUrl: imgUrl, body: only.trim(), orig: '' };
    }
    // Anything past section 3 belongs to the original -- rejoining keeps a break
    // the user added down there from silently eating the rest of it.
    return { imgUrl: imgUrl,
             body: parts[1].trim(),
             orig: parts.slice(2).join('<hr>').trim() };
  }
  window.makeCardSplit = _mcSplitCard;   // (dev0858) G needs the same fold

  function _mcFileStamp() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_'
         + p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds());
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

  // Build the standalone document for ANY ftext row, with every http(s) image
  // pulled in as base64 so the file opens with no network and no app.
  // Card-shaped ftext (image, then a top-level <hr>) keeps the two-page
  // image/text layout; anything else renders as one text page.
  async function makeCardBuildHtml(row) {
    var ftext = String((row && row.ftext) || '');
    if (!ftext.trim()) throw new Error('this slide has no ftext');
    var parts = _mcSplitCard(ftext);
    var isCard = !!parts.imgUrl && /<hr\b/i.test(ftext);

    // Inline every remote image (a card has one; a general slide may have more).
    var body = isCard ? parts.body : ftext;
    var head = isCard ? parts.imgUrl : '';
    var urls = [];
    body.replace(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi, function (m, u) { urls.push(u); return m; });
    if (head) urls.unshift(head);

    var map = {};
    for (var i = 0; i < urls.length; i++) {
      if (map[urls[i]] || /^data:/i.test(urls[i])) continue;
      map[urls[i]] = await _mcFetchAsDataUri(urls[i]);
    }
    var swap = function (s) {
      return s.replace(/(<img\b[^>]*\bsrc\s*=\s*["'])([^"']+)(["'])/gi,
                       function (m, a, u, b) { return a + (map[u] || u) + b; });
    };
    body = swap(body);
    var headUri = head ? (map[head] || head) : '';

    var title = String((row && row.VidTitle) || (row && row.UID ? 'Card ' + row.UID : 'Card'));
    return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n'
      + '<title>' + _mcEsc(title) + '</title>\n<style>\n' + CARD_CSS + '\n</style>\n</head>\n<body>\n'
      + (headUri
          ? '  <div class="image-page">\n    <img class="specimen" src="' + headUri + '" alt="Specimen Image">\n  </div>\n'
          : '')
      + '  <div class="text-page">\n    <div class="card">\n      <div class="content">\n'
      + body + '\n      </div>\n    </div>\n  </div>\n</body>\n</html>\n';
  }

  function _mcDownload(html, filename) {
    var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    _mcToast('✓ ' + filename + '  (' + Math.round(html.length / 1024) + ' KB)', 5000);
  }

  // The Xs / row-menu entry point. Offers a datestamped name the user can edit
  // — the .ahk named its files by timestamp and that ordering is worth keeping,
  // but a deck of "2026-08-30_16-38-14.html" is unreadable a week later.
  async function makeCardExport(row, label) {
    if (!row || !row.ftext) { _mcToast((label || 'This row') + ' has no ftext to export.', 3000); return; }
    _mcToast('Inlining image…', 4000);
    var html;
    try { html = await makeCardBuildHtml(row); }
    catch (e) { _mcToast('⚠ ' + ((e && e.message) || e), 6000); return; }

    var stamp = _mcFileStamp();
    var name = window.prompt('Save flash card as:', stamp + '.html');
    if (name === null) return;                       // cancelled
    name = String(name).trim().replace(/[\\/:*?"<>|]+/g, '-') || (stamp + '.html');
    if (!/\.html?$/i.test(name)) name += '.html';
    _mcDownload(html, name);
  }

  function makeCardExportRow(di) {
    var row = (typeof data !== 'undefined' && data) ? data[di] : null;
    return makeCardExport(row, 'Row ' + (di + 1));
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
      '#mcCardBox input.mc-path{width:100%;box-sizing:border-box;margin-top:8px;background:#0b0d14;color:#cde;border:1px solid #445;border-radius:5px;padding:7px;font-family:monospace;font-size:11px;}',
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
    // (dev0859) innerHTML below throws the path box away, and the focus poll
    // re-renders every time the window comes back — so a half-typed path would
    // vanish at exactly the moment you alt-tabbed to go and copy it.
    var hadPathFocus = !!(document.activeElement && document.activeElement.id === 'mcCardPath');
    box.innerHTML =
      '<h2>🃏 MakeCard</h2>' +
      '<p class="mc-sub">image → R2, then text → a new ml.json slide. Copy each, then click back on this window.</p>' +

      '<div class="mc-step ' + (imgDone ? 'done' : 'on') + '">' +
        '<div class="mc-h">' + (imgDone ? '✓ 1 · Image' : '1 · Image') + '</div>' +
        '<div class="mc-t">' + (imgDone
          ? (s.imgReused ? 'Reusing <b>' + _mcEsc(s.imgName || '') + '</b> — already on R2, nothing uploaded'
                         : 'Uploaded → <b>' + _mcEsc(s.imgName || '') + '</b>')
            + '<br>' + _mcEsc(s.imgUrl)
          : s.busy === 'image'
            ? 'Working…'
            : 'Copy the picture (right-click ▸ <b>Copy image</b>), then return here. Ctrl+V also works.'
              + '<br>Or name one that is <b>already on R2</b> — paste or type its path, e.g. '
              + '<b>M:\\wm\\flashimages\\card-….jpg</b>. A file from that folder is reused as it '
              + 'stands; a file from anywhere else is uploaded.') +
        '</div>' +
        (!imgDone && s.busy !== 'image'
          ? '<input id="mcCardPath" class="mc-path" spellcheck="false"'
            + ' value="' + _mcAttr(s.pathDraft || '') + '"'
            + ' placeholder="…or the path / URL of an image already on R2 (Enter)">'
          : '') +
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
        (s.pendingPath ? '<button id="mcCardUpload">Upload this file instead</button>' : '') +
        (imgDone ? '<button class="mc-go" id="mcCardMake">Make card</button>' : '') +
      '</div>';

    box.querySelector('#mcCardCancel').onclick = makeCardClose;
    box.querySelector('#mcCardRead').onclick = function () { _mcPoll(true); };
    // (dev0859) Enter in the path box is the whole gesture — no second button to hit.
    var pathInp = box.querySelector('#mcCardPath');
    if (pathInp) {
      pathInp.oninput = function () { if (_mcState) _mcState.pathDraft = pathInp.value; };
      pathInp.onkeydown = function (ev) {
        if (ev.key !== 'Enter') return;
        ev.preventDefault(); ev.stopPropagation();
        _mcUsePath(pathInp.value);
      };
      if (hadPathFocus) {
        pathInp.focus();
        pathInp.selectionStart = pathInp.selectionEnd = pathInp.value.length;
      }
    }
    var upBtn = box.querySelector('#mcCardUpload');
    if (upBtn) upBtn.onclick = function () {
      var q = _mcState && _mcState.pendingPath;
      if (!q) return;
      _mcAcceptImageRef({ kind: 'disk', path: q, name: q.split(/[\\/]+/).pop() });
    };
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
        if (got) { _mcRender(); await _mcAcceptImage(got.blob); return; }
        // (dev0859) No bitmap. The clipboard may instead NAME a picture — a
        // path copied out of Explorer, or a URL — and if that name is one the
        // bucket already holds, the card can point straight at it.
        var ref = null;
        try { ref = _mcParseImageRef((await _mcReadClipboardText()).plain); } catch (_) {}
        if (ref) { _mcRender(); await _mcAcceptImageRef(ref); return; }
        s.busy = null;
        if (manual) _mcSetErr('No image on the clipboard, and no image path either.');
        else _mcRender();
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

  // (dev0859) REUSING A PICTURE THAT IS ALREADY IN THE BUCKET
  //
  // The first build only took a bitmap off the clipboard, so every card meant a
  // fresh object in R2 even when the picture wanted was one already sitting in
  // M:\wm\flashimages\ from an earlier card. That folder IS the local mirror of
  // the bucket's flashimages/ prefix, so a file in it is already published under
  // its own name -- the URL can simply be spelled out, with nothing uploaded.
  //
  // A path from anywhere else cannot already be in the bucket, so that one is
  // handed to the proxy's /card/save {path} route, which reads the file and
  // uploads it. The proxy has taken that shape since dev0851; nothing called it.
  var CARD_DIR_NAME = 'flashimages';
  var CARD_URL_BASE = 'https://media.sealifeandmore.com/flashimages/';
  var IMG_EXT_RE    = /\.(jpe?g|png|webp)$/i;

  // A string that NAMES an image -> { kind:'link', url } (use it as it stands)
  // or { kind:'disk', path } (upload it). null for anything else, which is what
  // keeps the pasted answer text from being mistaken for a filename.
  function _mcParseImageRef(text) {
    var t = String(text || '').trim().replace(/^["']+|["']+$/g, '').trim();
    if (!t || t.length > 400 || /[\r\n]/.test(t)) return null;   // an answer, not a path
    if (/^file:\/\//i.test(t)) {
      try { t = decodeURIComponent(t.replace(/^file:\/{2,}/i, '')); } catch (_) {}
    }
    if (/^https?:\/\//i.test(t)) {
      var bare = t.split(/[?#]/)[0];
      if (!IMG_EXT_RE.test(bare)) return null;
      return { kind: 'link', url: t, name: decodeURIComponent(bare.split('/').pop()) };
    }
    if (!/[\\/]/.test(t) || !IMG_EXT_RE.test(t)) return null;
    var parts = t.split(/[\\/]+/);
    var name  = parts.pop();
    var dir   = parts.pop() || '';
    if (dir.toLowerCase() === CARD_DIR_NAME) {
      return { kind: 'link', url: CARD_URL_BASE + encodeURIComponent(name), name: name, path: t };
    }
    return { kind: 'disk', path: t, name: name };
  }

  // Does that URL actually answer? R2's custom domain sends no CORS header, so
  // fetch() cannot check it -- but an <img> load is not CORS-gated, and it
  // doubles as the preview. Without this a typo would make a card whose picture
  // is a broken box, and nothing would say so until it was looked at.
  function _mcImageLoads(url) {
    return new Promise(function (resolve) {
      var im = new Image();
      im.onload  = function () { resolve(true); };
      im.onerror = function () { resolve(false); };
      im.src = url;
    });
  }

  async function _mcAcceptImageRef(ref) {
    var s = _mcState;
    if (!s || !ref) return;
    s.busy = 'image'; s.err = ''; s.pendingPath = ''; _mcRender();
    try {
      if (ref.kind === 'disk') {
        var res = await _mcUpload({ path: ref.path, stem: 'card-' + _mcStamp() });
        s.imgUrl = res.url; s.imgName = res.name; s.imgBytes = res.bytes;
        s.imgPreview = res.url; s.imgReused = false;
        s.busy = null; _mcRender();
        _mcToast('✓ Uploaded ' + ref.name + ' (' + Math.round((res.bytes || 0) / 1024)
                 + ' KB) — now copy the text', 5000);
        return;
      }
      var ok = await _mcImageLoads(ref.url);
      if (!ok) {
        s.busy = null;
        s.pendingPath = ref.path || '';
        _mcSetErr('Nothing answers at ' + ref.url
                  + (ref.path ? ' — that name is not in the bucket yet.' : ''));
        return;
      }
      s.imgUrl = ref.url; s.imgName = ref.name; s.imgBytes = 0;
      s.imgPreview = ref.url; s.imgReused = true;
      s.busy = null; _mcRender();
      _mcToast('✓ Reusing ' + ref.name + ' — already on R2, nothing uploaded. Now copy the text', 5000);
    } catch (e) {
      s.busy = null;
      _mcSetErr(String((e && e.message) || e));
    }
  }

  function _mcUsePath(txt) {
    var ref = _mcParseImageRef(txt);
    if (!ref) {
      _mcSetErr('Not an image path or URL — expected one line ending .jpg, .png or .webp.');
      return;
    }
    _mcAcceptImageRef(ref);
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
      // (dev0856) 'f' = flashcard. Was the NUMBER 0, which is falsy, so
      // String(row.ltype || '') collapsed it to '' — every card was
      // indistinguishable from a row with no ltype at all and fell into the
      // filter's 'none' bucket (core.js ~3242). A string value is filterable.
      ltype: 'f', ftext: ftext, tags: []
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
      // (dev0859) A paste INTO the path box is just a paste — leave it alone.
      if (e.target && e.target.id === 'mcCardPath') return;
      for (var i = 0; i < dt.items.length; i++) {
        if (dt.items[i].kind === 'file' && /^image\//.test(dt.items[i].type)) {
          e.preventDefault();
          _mcAcceptImage(dt.items[i].getAsFile());
          return;
        }
      }
      // (dev0859) …otherwise the text may name a picture already in the bucket.
      var ref = _mcParseImageRef(dt.getData('text/plain') || '');
      if (ref) { e.preventDefault(); _mcAcceptImageRef(ref); return; }
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
    _mcState = { imgUrl: '', imgName: '', imgPreview: '', busy: null, err: '',
                 imgReused: false, pendingPath: '', pathDraft: '' };   // (dev0859)

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
  window.makeCardExport     = makeCardExport;      // (dev0852) Xs ⬇ Download
  window.makeCardBuildHtml  = makeCardBuildHtml;
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
