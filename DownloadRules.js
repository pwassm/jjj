'use strict';

// DownloadRules.js
// Cleans fetched article HTML before storing in ftext.
// Usage: DownloadRules.apply(htmlString, sourceUrl) → cleanedHtmlString

window.DownloadRules = {

  apply(html, sourceUrl) {
    if (!html) return html;
    const host = (sourceUrl || '').toLowerCase();
    if (host.includes('thisiscolossal.com') || host.includes('colossal.com')) {
      return this._colossal(html);
    }
    if (host.includes('bwpawards.org')) {
      return this._bwpawards(html);
    }
    if (host.includes('naturettl.com')) {
      return this._naturettl(html);
    }
    if (host.includes('instagram.com')) {
      return this._instagram(html, sourceUrl);
    }
    // Generic fallback: only triggers when the structural hint fires
    // ("no caption below last picture; earlier images have one"). Safe for
    // unknown sites because it returns the HTML unchanged when uncertain.
    return this._labelAbove(html, { gated: true });
  },

  // Returns true if any sibling AFTER node contains an article jpg/png/webp image.
  // Used as a safety net: skip a truncation step if article images still follow.
  _hasArticleImgAfter(node) {
    let sib = node.nextSibling;
    while (sib) {
      if (sib.nodeType === 1 && this._hasArticleImg(sib)) return true;
      sib = sib.nextSibling;
    }
    return false;
  },

  // Returns true if el (or any descendant) is a wp-content jpg/png/webp image.
  // Excludes SVGs — those are nav chrome, not article content.
  _hasArticleImg(el) {
    if (!el || el.nodeType !== 1) return false;
    const articleImgRe = /wp-content\/uploads.+\.(jpg|jpeg|png|webp)/i;
    if (el.tagName === 'IMG') return articleImgRe.test(el.getAttribute('src') || '');
    const imgs = el.querySelectorAll('img');
    return Array.from(imgs).some(img => articleImgRe.test(img.getAttribute('src') || ''));
  },

  // ── Colossal (thisiscolossal.com) ──────────────────────────────────────────
  _colossal(html) {
    const d = document.createElement('div');
    d.innerHTML = html;
    const _n = (label) => console.log(`[DR] ${label}:`, d.querySelectorAll('img[src*="wp-content/uploads"]').length, 'imgs');
    _n('start');

    // 0. Un-mangle underscores eaten by jina.ai's markdown pass ──────────────
    // jina returns markdown→HTML. Markdown sees "_iceland_" inside a URL slug
    // as italic emphasis and rewrites it to "<em>iceland</em>"; "_blank" in a
    // target attribute becomes "<em>blank". Restore underscores in src/href/
    // target attribute values so the URLs are fetchable again.
    d.querySelectorAll('[src], [href], [target]').forEach(el => {
      ['src', 'href', 'target'].forEach(attr => {
        const v = el.getAttribute(attr);
        if (v && /<\/?em>/i.test(v)) {
          el.setAttribute(attr, v.replace(/<\/?em>/gi, '_'));
        }
      });
    });
    _n('after-0-em-fix');

    // 1. Remove nav block ─────────────────────────────────────────────────────
    // Delete every top-level sibling between the "Skip to content" anchor and
    // the first element that IS or CONTAINS a wp-content jpg/png/webp image.
    // SVG images (nav-panel-bg, surprise-static) are NOT article images.
    const skipAnchor = d.querySelector('a[href*="#content"]');
    if (skipAnchor) {
      const skipEl = skipAnchor.closest('p') || skipAnchor;
      let node = skipEl.nextSibling;
      while (node) {
        const next = node.nextSibling;
        if (node.nodeType === 1) {
          if (this._hasArticleImg(node)) break;  // first real article image — stop
          node.remove();
        } else if (node.nodeType === 3 && node.textContent.trim()) {
          node.remove();
        }
        node = next;
      }
    }

    _n('after-1-nav');
    // 2. Remove junk paragraphs ───────────────────────────────────────────────
    d.querySelectorAll('p').forEach(p => {
      const txt = p.textContent.trim();

      // Standalone noise words
      if (txt === 'Advertisement' || txt === 'Bookmark' || txt === 'Close') {
        p.remove(); return;
      }

      const links = Array.from(p.querySelectorAll('a'));

      // Author paragraph — single link to /author/
      if (links.length === 1 && (links[0].href || '').includes('/author/') &&
          txt === links[0].textContent.trim()) {
        p.remove(); return;
      }

      // Category paragraph — all links go to /category/
      if (links.length > 0 && links.every(a => (a.href || '').includes('/category/'))) {
        p.remove(); return;
      }

      // Previous / Next article
      if (links.length === 1 && /^(Previous|Next) article$/.test(links[0].textContent.trim())) {
        p.remove(); return;
      }

      // Commerce paragraph — bookshop.org or instagram.com links
      if (links.some(a => {
        const h = a.href || '';
        return h.includes('bookshop.org') || h.includes('instagram.com');
      })) {
        p.remove(); return;
      }
    });

    _n('after-2-junk-p');
    // 3. Remove social share <ul> ─────────────────────────────────────────────
    d.querySelectorAll('ul').forEach(ul => {
      const links = Array.from(ul.querySelectorAll('a'));
      if (links.length && links.every(a => {
        const h = a.href || '';
        return h.includes('facebook.com/sharer') ||
               h.startsWith('mailto:') ||
               h.includes('twitter.com/intent') ||
               h.includes('x.com/intent');
      })) ul.remove();
    });

    _n('after-3-social');
    // 4. Remove nav/UI SVG images (non-article images) ────────────────────────
    const NAV_SVGS = ['nav-panel-bg', 'surprise-static', 'arrow-left.svg'];
    d.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src') || '';
      if (NAV_SVGS.some(k => src.includes(k))) {
        (img.closest('p, a') || img).remove();
      }
    });

    _n('after-4-svgs');
    // 5. Remove "Related articles" <ul> ───────────────────────────────────────
    // Identified by: every <li> contains an image AND all links go to
    // datestamped colossal article URLs (/2020/, /2021/, … /2030/).
    d.querySelectorAll('ul').forEach(ul => {
      const items = Array.from(ul.querySelectorAll(':scope > li'));
      if (items.length < 1) return;
      const allRelated = items.every(li => {
        const hasImg = !!li.querySelector('img');
        const links = Array.from(li.querySelectorAll('a'));
        const allColossal = links.length > 0 &&
          links.every(a => /thisiscolossal\.com\/20\d\d\//.test(a.href || ''));
        return hasImg && allColossal;
      });
      if (allRelated) ul.remove();
    });

    _n('after-5-related');
    // 5b. Remove mid-article "Become a Colossal Member" upsell (h3 format) ───
    // Colossal inserts ### Become a Colossal Member + benefits list + pricing
    // between article images. Remove the h3 and all following siblings until
    // the next element that contains an article image.
    // Safety net: only strip if no article image follows the entire block.
    d.querySelectorAll('h3').forEach(h3 => {
      if (!/become a colossal member/i.test(h3.textContent.trim())) return;
      const toRemove = [h3];
      let sib = h3.nextSibling;
      while (sib) {
        if (sib.nodeType === 1 && this._hasArticleImg(sib)) break;
        toRemove.push(sib);
        sib = sib.nextSibling;
      }
      // If the loop stopped AT an image, safe to remove. If it ran off the end,
      // only remove if no article images remain after h3 (i.e. truly a footer block).
      if (sib || !this._hasArticleImgAfter(h3)) {
        toRemove.forEach(n => n.parentNode && n.parentNode.removeChild(n));
      }
    });

    _n('after-5b-h3upsell');
    // 6. Strip footer from "Art in your inbox" or "Become a Colossal Member" ─
    // The footer uses h2 for these headings (mid-article upsell uses h3, handled
    // above). Only match h1/h2 so the mid-article h3 block doesn't trigger this.
    // Safety net: skip if article images follow the heading.
    const footerRe = /art in your inbox|become a colossal member/i;
    let footerFound = false;
    Array.from(d.childNodes).forEach(node => {
      if (footerFound) { node.remove(); return; }
      if (node.nodeType === 1 && /^H[12]$/.test(node.tagName) &&
          footerRe.test(node.textContent)) {
        if (this._hasArticleImgAfter(node)) return; // safety net — images follow, don't cut
        footerFound = true;
        node.remove();
      }
    });

    _n('after-6-footer');
    // 7. Membership upsell — strip from "Do stories" to end ──────────────────
    // jina.ai sometimes returns the upsell wrapped in a container that ALSO
    // holds many of the article images. Naively dropping the matched top-level
    // node would nuke those images. Instead: descend to the smallest element
    // that actually contains the upsell text, extract any article images
    // inside it, then remove that element + its following siblings.
    let upsellFound = false;
    Array.from(d.childNodes).forEach(node => {
      if (upsellFound) { node.remove(); return; }
      if (node.nodeType !== 1) return;
      if (!node.textContent.includes('Do stories and artists like this matter')) return;
      if (this._hasArticleImgAfter(node)) return; // safety net — images follow, don't cut

      upsellFound = true;

      // Walk down to the smallest descendant still containing the upsell text.
      let smallest = node;
      while (true) {
        const child = Array.from(smallest.children).find(c =>
          c.textContent.includes('Do stories and artists like this matter'));
        if (!child) break;
        smallest = child;
      }

      // Extract any article images from `smallest` and insert them before it,
      // so they survive the removal.
      const rescueImgs = (el, anchor) => {
        el.querySelectorAll('img[src*="wp-content/uploads"]').forEach(img => {
          const wrap = (img.closest('a') || img).cloneNode(true);
          anchor.parentNode.insertBefore(wrap, anchor);
        });
      };

      if (smallest === node) {
        // Upsell text lives directly on the matched node (no narrower child).
        rescueImgs(node, node);
        node.remove();
      } else {
        rescueImgs(smallest, smallest);
        // Remove `smallest` and all its following siblings within its parent.
        let n = smallest;
        while (n) {
          const next = n.nextSibling;
          n.parentNode.removeChild(n);
          n = next;
        }
      }
    });

    _n('after-7-upsell');
    return d.innerHTML;
  },

  // ── BWPAwards (bwpawards.org) ──────────────────────────────────────────────
  // Squarespace lightbox galleries expose full-res images only as <a href="…jpg">
  // links — jina.ai renders these as anchor tags, not <img> tags.
  // Convert every anchor whose href is a direct image URL into an inline <img>.
  //   • If the <a> already wraps an <img>, replace the img's src with the full-res href.
  //   • If the <a> has no child img, replace it with a <p><img …></p>.
  // Keeps surrounding text/headings intact; does not filter by MPix here
  // (the save-images pipeline handles that downstream).
  _bwpawards(html) {
    const d = document.createElement('div');
    d.innerHTML = html;

    const IMG_EXT_RE = /\.(jpe?g|png|webp|gif)(\?[^)]*)?$/i;

    d.querySelectorAll('a[href]').forEach(a => {
      const href = (a.getAttribute('href') || '').trim();
      if (!IMG_EXT_RE.test(href)) return;

      const existingImg = a.querySelector('img');
      if (existingImg) {
        // Upgrade thumbnail src → full-res href
        existingImg.setAttribute('src', href);
        existingImg.setAttribute('style', 'max-width:100%;height:auto;');
        // Unwrap the <a> so the img stands alone
        a.replaceWith(existingImg.cloneNode(true));
      } else {
        // No child img — create one from the href
        const img = document.createElement('img');
        img.setAttribute('src', href);
        img.setAttribute('alt', a.textContent.trim() || '');
        img.setAttribute('style', 'max-width:100%;height:auto;');
        const p = document.createElement('p');
        p.appendChild(img);
        a.replaceWith(p);
      }
    });

    return d.innerHTML;
  },

  // ── NatureTTL (naturettl.com) ──────────────────────────────────────────────
  // Gallery layout: <h2 rank> → <p title/credit> → <img> → <p description…>
  // The TITLE always sits in the <p> immediately above the image; descriptions
  // below are filler. The image-saver derives filenames from captions, and its
  // priority is figcaption → next-sibling <p> → alt → preceding <h2-5>. To make
  // it pick the title (the line above), we restructure each image into
  //   <figure><img><figcaption>title</figcaption></figure>
  // and drop the description <p>(s) that immediately follow.
  _naturettl(html) {
    return this._labelAbove(html, { gated: false });
  },

  // ── Generic "label above each picture" transform ──────────────────────────
  // Same restructuring as naturettl, optionally gated on the hint
  // "the LAST image has no <p> below it, but at least one earlier image does."
  // With gated:false, the transform always runs (use for known sites).
  // With gated:true (default), it runs only when the hint fires (safe for
  // unknown sites that might use the captions-below pattern).
  _labelAbove(html, opts) {
    opts = opts || {};
    const gated = opts.gated !== false;

    const d = document.createElement('div');
    d.innerHTML = html;

    const imgs = Array.from(d.querySelectorAll('img'));
    if (imgs.length < 1) return html;

    // Walk siblings skipping whitespace text + comments. Real text blocks
    // the run (we don't want to swallow paragraphs that are NOT captions).
    const nextEl = (node) => {
      let s = node.nextSibling;
      while (s && (s.nodeType === 3 || s.nodeType === 8)) {
        if (s.nodeType === 3 && s.textContent.trim()) return null;
        s = s.nextSibling;
      }
      return (s && s.nodeType === 1) ? s : null;
    };
    const prevEl = (node) => {
      let s = node.previousSibling;
      while (s && (s.nodeType === 3 || s.nodeType === 8)) {
        if (s.nodeType === 3 && s.textContent.trim()) return null;
        s = s.previousSibling;
      }
      return (s && s.nodeType === 1) ? s : null;
    };

    if (gated) {
      if (imgs.length < 2) return html;
      const trailingP = imgs.map(img => {
        const n = nextEl(img); return n && n.tagName === 'P' ? n : null;
      });
      const lastHasP  = !!trailingP[trailingP.length - 1];
      const someHaveP = trailingP.slice(0, -1).some(Boolean);
      if (lastHasP || !someHaveP) return html;
    }

    imgs.forEach(img => {
      if (img.closest('figure')) return;  // already structured
      const parent = img.parentNode;
      if (!parent) return;

      // Title = the <p> immediately preceding the image.
      const prev = prevEl(img);
      const titleP = (prev && prev.tagName === 'P') ? prev : null;

      // Description run = consecutive <p>s immediately after the image.
      const toRemove = [];
      let after = nextEl(img);
      while (after && after.tagName === 'P') {
        toRemove.push(after);
        const nxt = nextEl(after);
        after = nxt;
      }

      if (titleP) {
        const fig = document.createElement('figure');
        const cap = document.createElement('figcaption');
        cap.innerHTML = titleP.innerHTML;
        parent.insertBefore(fig, img);
        fig.appendChild(img);           // moves img out of parent
        fig.appendChild(cap);
        titleP.remove();
      }
      toRemove.forEach(n => n.remove());
    });

    return d.innerHTML;
  },

  // ── Instagram (instagram.com) ─────────────────────────────────────────────
  // jina.ai returns Instagram pages in three common shapes:
  //   (A) Useful: caption in <h2> ("X on Instagram: \"…\""), then a
  //       transcription/body, then garbage tail (like counts, audio link).
  //   (B) Mixed: caption + profile-pic CDN <img> + body + comment blocks
  //       (repeating PLACE-anchor / short text / "N like(s)" / "Reply").
  //   (C) Login wall: <h1>Instagram</h1> + login form + nothing else.
  //
  // We keep the caption (when there is one), strip profile-pic/blob images,
  // cut comment blocks and login-wall text, drop trailing like counts and
  // audio attribution. If nothing meaningful survives, return a stub link
  // so the row still has *something* in ftext (the live IG embed in V
  // remains the primary content for these rows).
  _instagram(html, sourceUrl) {
    const d = document.createElement('div');
    d.innerHTML = html;

    // 1. Strip profile-pic / blob images. IG embeds the post author's
    //    avatar from *.cdninstagram.com — never useful as article content.
    d.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src') || '';
      if (src.startsWith('blob:')
          || /cdninstagram\.com/i.test(src)
          || /static\.cdninstagram\.com/i.test(src)) {
        (img.closest('figure, p') || img).remove();
      }
    });

    // 2. Pull the caption from the first informative heading. The "real"
    //    caption looks like "{handle} on Instagram: \"…\""; bare "Instagram"
    //    is the login-wall title and gets discarded.
    let caption = '';
    Array.from(d.querySelectorAll('h1, h2, h3')).some(h => {
      const t = (h.textContent || '').trim();
      if (t && t.toLowerCase() !== 'instagram' && /Instagram/i.test(t)) {
        caption = t; return true;
      }
      return false;
    });
    // Remove all headings — we'll re-insert the caption at top once.
    d.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => h.remove());

    // 3. Strip standalone PLACE-only anchors. These are leftover markdown
    //    placeholders that didn't get re-substituted (nested images inside
    //    links — IG profile pics inside profile links). Either way: noise.
    d.querySelectorAll('a').forEach(a => {
      const t = (a.textContent || '').trim();
      if (/^PLACE\d+$/.test(t)) {
        const par = a.parentNode;
        if (par && par.tagName === 'P'
            && par.children.length === 1 && (par.textContent || '').trim() === t) {
          par.remove();
        } else {
          a.remove();
        }
      }
    });

    // 4. Strip login-wall paragraphs. Each line in the IG login wall is its
    //    own <p>; matching exact strings (case-insensitive) avoids gobbling
    //    legitimate body text that mentions one of these words.
    const LOGIN_LINES = new Set([
      'log in', 'log into instagram', 'sign up', 'forgot password',
      'forgot password?', 'log in with facebook', 'create new account',
      'mobile number, username or email', 'mobile number, username, or email',
      'mobile number or email', 'username or email', 'password',
      'see everyday moments from your close friends.',
      'meta', 'about', 'blog', 'jobs', 'help', 'api', 'privacy', 'terms',
      'locations', 'instagram lite', 'threads', 'contact uploading & non-users',
      'meta verified', 'english'
    ]);
    d.querySelectorAll('p').forEach(p => {
      const t = (p.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (LOGIN_LINES.has(t)) p.remove();
    });

    // 5. Cut at "See more posts" — everything after is related-reel anchors.
    {
      const seeMoreRe = /see\s*more\s*posts/i;
      let cutting = false;
      Array.from(d.childNodes).forEach(n => {
        if (cutting) { n.remove(); return; }
        if (n.nodeType === 1 && seeMoreRe.test(n.textContent || '')) {
          cutting = true; n.remove();
        }
      });
    }

    // 6. Cut the comment block. IG embeds repeat a 4-line pattern:
    //      handle-anchor (often PLACE\d+ — already stripped above)
    //      short comment text
    //      "N like(s)"
    //      "Reply"
    //    Find the first standalone "Reply" or "N like(s)" — whichever comes
    //    earlier — and cut everything from there to end. Then walk back a
    //    few siblings to also drop the orphan comment-text paragraph that
    //    preceded it.
    {
      const childEls = Array.from(d.childNodes).filter(n => n.nodeType === 1);
      let cutFrom = -1;
      for (let i = 0; i < childEls.length; i++) {
        const n = childEls[i];
        if (n.tagName !== 'P') continue;
        const t = (n.textContent || '').trim();
        if (/^reply$/i.test(t) || /^\d+\s+likes?$/i.test(t)) {
          cutFrom = i; break;
        }
      }
      if (cutFrom > 0) {
        // Walk back over short paragraphs (likely orphan comment text) —
        // stop at the first paragraph with substantial body content (>200
        // chars) or any non-<p> block.
        for (let j = cutFrom - 1; j >= 0; j--) {
          const m = childEls[j];
          if (m.tagName !== 'P') break;
          const mt = (m.textContent || '').trim();
          if (mt.length > 200) break;
          cutFrom = j;
        }
        for (let i = cutFrom; i < childEls.length; i++) childEls[i].remove();
      }
    }

    // 7. Trim trailing noise: bare numeric paragraphs ("2,871", "152" — view
    //    or like counts) and audio attribution anchors.
    while (d.lastElementChild) {
      const last = d.lastElementChild;
      const t = (last.textContent || '').trim();
      if (last.tagName === 'P' && /^[\d,]+$/.test(t)) { last.remove(); continue; }
      if (last.tagName === 'P' && last.querySelector('a[href*="instagram.com/reels/audio"]')) {
        last.remove(); continue;
      }
      // Trailing <p>* </p> (asterisk leftover from markdown emphasis)
      if (last.tagName === 'P' && /^\*?\s*\*?$/.test(t)) { last.remove(); continue; }
      break;
    }

    // 8. Re-insert the caption at the top (if we found one).
    if (caption) {
      const h = document.createElement('h2');
      h.textContent = caption;
      d.insertBefore(h, d.firstChild);
    }

    // 9. Bail-out: if cleanup produced almost nothing (login-wall case), drop
    //    in a single URL link so V/T still show *something*. The live IG
    //    embed in V remains the primary content for these rows.
    const remaining = (d.textContent || '').replace(/\s+/g, ' ').trim();
    if (remaining.length < 80) {
      const esc = s => String(s).replace(/[<>&"]/g, c =>
        ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;' }[c]));
      return '<p><a href="' + esc(sourceUrl) + '" target="_blank" rel="noopener">'
        + esc(sourceUrl) + '</a></p>';
    }

    return d.innerHTML;
  }
};
