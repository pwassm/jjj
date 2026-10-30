/* ============================================================================
 * tags.js — Tag dictionary + graph operations + chip input + dictionary UI
 * ============================================================================
 * Depends on these globals provided by index.html:
 *   data              — array of video records (linksData)
 *   save()            — persists ml.json
 *   writeFileToDisk() — writes a named file to the project dir
 *   toast()           — shows a transient notification
 *   render()          — rebuilds table
 *   isoNow()          — ISO timestamp string
 *
 * Exposes on window:
 *   window.tagsLib    — the public API
 *   window.openDictionary()     — open dictionary overlay
 *   window.closeDictionary()
 *   window.mountTagChipInput(opts) — create a chip input in a container
 *
 * Storage:
 *   tags.json is an array: [meta, ...tagRecords] (SAL-style)
 *   Each tag record:
 *     { id, label, kind, rank?, parents:[], aliases?:[], formerly?:[], common?:"", extinct?:false,
 *       facts1?:"", facts2?:"", facts3?:"", NameOrigin?:"", NameSay?:"",
 *       NameOriginEdited?:true, NameSayEdited?:true }
 *   formerly (dev1116) = older scientific names the label replaced (Pleuroncodes
 *   planipes on Grimothea planipes). Searched and matched exactly like aliases,
 *   but shown as "formerly" so an old name is told apart from a common-name variant.
 *   facts1-3 (dev1148) = HTML written in Xe v2; facts1 is the old `def`, renamed
 *   on load. A fact goes on the tag at the rank where it is TRUE — a family-wide
 *   fact once on the family, not repeated on every species. NameOrigin = how the
 *   binomial was given (plain text). NameSay = respelled pronunciation, one
 *   "Label: respelling" line per variant (US / GB / Classical), stress in CAPS.
 *   ABSENT vs '' matters for these five: absent = never written (the tags.json
 *   write guard in core.js may backfill it from disk), '' = deliberately cleared.
 *   (dev1152) On a taxon the two name fields are looked up and saved by D
 *   itself; …Edited = Phil changed the looked-up text, so no look-up replaces it.
 *   Rules:
 *     - id is a slug (lowercase, a-z 0-9 and hyphens)
 *     - kind === "taxon" → at most ONE parent of kind taxon/root (its single
 *       place in the tree of life) PLUS any number of kind:"group" parents
 *       (ecology groups like "fish" that cut across clades)
 *     - others can have multiple parents
 *     - a tag may have no parents (root-level concept)
 * ========================================================================= */

(function () {
  'use strict';

  // ── state ────────────────────────────────────────────────────────────────
  let tagsArr = [];            // array of tag records (no meta)
  let tagsMeta = null;         // meta record (null until loaded)
  const byId = new Map();      // id -> record
  const aliasToId = new Map(); // lowercase alias/label -> id
  let orphanTags = [];         // referenced but missing

  const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

  // (dev1148) The prose fields a tag can carry. core.js's tags.json write guard
  // reads this list (tagsLib.TEXT_FIELDS) to know what to backfill from disk.
  const TEXT_FIELDS = ['facts1', 'facts2', 'facts3', 'NameOrigin', 'NameSay'];

  // Searchable text of a tag's facts + name origin, tags stripped. NameSay is
  // left out: respellings like "MOH-luh" only add junk matches.
  function factsText(t) {
    if (!t) return '';
    return ['facts1', 'facts2', 'facts3', 'NameOrigin'].map(f => t[f] || '').join(' ')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Old `def` values are plain text; facts1 is HTML. Text that already holds a
  // tag is passed through, anything else is escaped and given paragraphs.
  function plainToHtml(s) {
    s = String(s == null ? '' : s);
    if (!s.trim()) return '';
    if (/<[a-z][\s\S]*>/i.test(s)) return s;
    const esc = x => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return s.split(/\n\s*\n/).map(p => p.split('\n').map(l => esc(l.trim())).filter(Boolean).join('<br>'))
      .filter(Boolean).map(p => '<p>' + p + '</p>').join('');
  }

  // Xe hands back '<p></p>' for an emptied editor — that is a clear, not content.
  function isBlankHtml(h) {
    h = String(h == null ? '' : h);
    if (/<(img|video|iframe)\b/i.test(h)) return false;
    return !h.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
  }

  // What D's Facts box shows: the HTML itself, or a hint when there is none.
  function factsPreviewHtml(h) {
    return isBlankHtml(h)
      ? '<span style="color:#556;font-style:italic;">empty — ✎ Xe to write</span>'
      : String(h);
  }

  // The respelling key behind D's "?" next to Name say. Based on Wikipedia's
  // pronunciation respelling key, with "uh" where it uses ə — no IPA symbols.
  const NAMESAY_KEY_HTML =
    'Hyphens between syllables; the <b>stressed syllable in CAPITALS</b>. One line per variant, '
    + 'usual one first: <code>US:</code> <code>GB:</code> <code>Classical:</code> — add a line only when it differs.'
    + '<table>'
    + '<tr><td>ee</td><td>s<b>ee</b></td></tr>'
    + '<tr><td>eye / y</td><td><b>eye</b>, m<b>y</b> (SY = "sigh")</td></tr>'
    + '<tr><td>ay</td><td>d<b>ay</b></td></tr>'
    + '<tr><td>oh</td><td>g<b>o</b></td></tr>'
    + '<tr><td>oo</td><td>f<b>oo</b>d</td></tr>'
    + '<tr><td>ow</td><td>n<b>ow</b></td></tr>'
    + '<tr><td>uh</td><td>the unstressed a in sof<b>a</b></td></tr>'
    + '<tr><td>g</td><td>always hard, as in <b>g</b>et (soft g is written j)</td></tr>'
    + '<tr><td>k / s</td><td>hard c / soft c (or<b>c</b>a → k, Or<b>c</b>inus → s)</td></tr>'
    + '</table>';

  // (dev1150) NameOrigin is plain text; a credit link is written [Wikipedia](https://…)
  // so it reads fine in D's textarea. This turns it into HTML for display:
  // escaped text, <br> per line, and only http(s) links become <a>.
  function nameOriginHtml(s) {
    return escapeHtml(String(s || ''))
      .replace(/\[([^\]\n]{1,80})\]\((https?:\/\/[^\s)]+)\)/g, (m, txt, url) =>
        '<a href="' + url + '" target="_blank" rel="noopener" style="color:#68a;">' + txt + '</a>')
      .replace(/\n/g, '<br>');
  }

  // ── Name origin lookup (dev1149) ───────────────────────────────────────────
  // A draft built only from sources, never invented:
  //   WoRMS (GBIF for land taxa) → "Described by Garman in 1888", plus "first
  //     placed in a different genus" when the authority is in parentheses;
  //   Wiktionary → what a one-word name is built from (genus, family…), or what
  //     a species epithet means in Latin (following "inflection of" to the lemma);
  //   Wikipedia (per-tag 🔎 only) → sentences about the name, offered to add.
  // (dev1150) A species draft explains BOTH words: the genus (its Wiktionary
  // etymology, or for a compound like Rhinomuraena the parts: rhino- “nose” +
  // Muraena “moray eel”) and the epithet. Phil wants the whole binomial there.
  // Wiktionary and WoRMS are fetched 50 names per request, so 🔎 Fill names over
  // every taxon is a couple of dozen requests, not hundreds — Wikimedia answers
  // a burst of single-page calls with HTTP 429.
  const WT_LANG = { grc: 'Ancient Greek', la: 'Latin', 'la-new': 'New Latin', 'la-lat': 'Late Latin',
    'la-med': 'Medieval Latin', 'NL.': 'New Latin', 'ML.': 'Medieval Latin', 'LL.': 'Late Latin', mul: '',
    en: 'English', ja: 'Japanese', fr: 'French', de: 'German', es: 'Spanish', pt: 'Portuguese', it: 'Italian',
    haw: 'Hawaiian', ar: 'Arabic', nl: 'Dutch', el: 'Greek', gkm: 'Byzantine Greek', ru: 'Russian', zh: 'Chinese',
    mi: 'Maori', sv: 'Swedish', da: 'Danish', no: 'Norwegian', ms: 'Malay', id: 'Indonesian', tpi: 'Tok Pisin',
    hi: 'Hindi', sa: 'Sanskrit', fa: 'Persian', tr: 'Turkish', ko: 'Korean', pl: 'Polish', fi: 'Finnish',
    is: 'Icelandic', ga: 'Irish', cy: 'Welsh', he: 'Hebrew', sw: 'Swahili', qu: 'Quechua', nah: 'Nahuatl',
    tl: 'Tagalog', 'la-cla': 'Latin', 'la-vul': 'Vulgar Latin', 'grc-koi': 'Koine Greek', enm: 'Middle English',
    ang: 'Old English', fro: 'Old French', frm: 'Middle French', non: 'Old Norse' };
  // An unlisted code is dropped rather than shown raw ("From ms kakaktua").
  const _wtLang = c => (c in WT_LANG ? WT_LANG[c] : '');

  function _wtTemplate(body) {
    const parts = body.split('|');
    const name = parts.shift().trim().toLowerCase();
    const pos = [], kv = {};
    parts.forEach(p => {
      const m = /^\s*([a-z0-9]+)\s*=([\s\S]*)$/i.exec(p);
      if (m) kv[m[1].toLowerCase()] = m[2].trim(); else pos.push(p.trim());
    });
    const gl = (t, g) => (g ? t + ' (“' + g + '”)' : t);
    switch (name) {
      case 'der': case 'inh': case 'bor': case 'lbor': case 'uder': case 'cal': case 'slbor': case 'obor':
      case 'der+': case 'inh+': case 'bor+': {
        const ln = _wtLang(pos[1] || '');
        const term = pos[3] || pos[2] || '';                 // "-" = no term given
        return (ln ? ln + ' ' : '') + gl(term === '-' ? '' : term, kv.t || kv.gloss || pos[4] || '');
      }
      case 'm': case 'l': case 'mention': case 'link': case 'll': case 'm+': case 'l-self':
        return gl(pos[2] || pos[1] || '', kv.t || kv.gloss || pos[3] || '');
      case 'af': case 'affix': case 'compound': case 'com': case 'suffix': case 'prefix': case 'confix': case 'blend':
        return pos.slice(1).map((t, i) => {
          if (!t) return '';
          const lc = kv['lang' + (i + 1)];
          return (lc ? _wtLang(lc) + ' ' : '') + gl(t, kv['t' + (i + 1)] || kv['gloss' + (i + 1)] || kv['pos' + (i + 1)] || '');
        }).filter(Boolean).join(' + ');
      case 'taxlink': case 'taxfmt': case 'vern':
        return pos[0] || '';
      case 'w': case 'wp': case 'glossary':
        return pos[1] || pos[0] || '';
      case 'gloss':
        return '(“' + (pos[0] || '') + '”)';
      case 'q': case 'qualifier': case 'i':
        return '(' + pos.join(', ') + ')';
      case 'alternative form of': case 'alt form': case 'alt form of': case 'synonym of': case 'syn of':
        return gl(pos[1] || '', kv.t || kv.gloss || pos[3] || '');
      case 'inflection of': case 'infl of': case 'form of':
        return '\u0001' + (pos[1] || '');                // marker: follow to the lemma
      default:
        return '';
    }
  }

  function _wtRender(src) {
    let s = String(src || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<ref[^>]*\/>/g, '').replace(/<ref[\s\S]*?<\/ref>/g, '');
    for (let g = 0; g < 50 && /\{\{[^{}]*\}\}/.test(s); g++) s = s.replace(/\{\{([^{}]*)\}\}/g, (m, b) => _wtTemplate(b));
    s = s.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').replace(/'''?/g, '').replace(/<[^>]+>/g, '');
    return s.replace(/\s+/g, ' ').replace(/\s+([,.;:)])/g, '$1').replace(/^[\s,.;:]+$/, '').trim();
  }

  // One language section's etymology + first definitions.
  function _wtSections(wikitext, langs) {
    const out = [];
    const secs = String(wikitext || '').split(/^==([^=].*?)==\s*$/m);
    for (let i = 1; i < secs.length; i += 2) {
      const lang = secs[i].trim();
      if (!langs.includes(lang)) continue;
      const body = secs[i + 1] || '';
      const em = /===+\s*Etymology[^=]*===+\s*\n([\s\S]*?)(?=\n=)/.exec(body);
      const ety = em ? _wtRender(em[1].split(/\n\s*\n/)[0]) : '';
      const defs = [...body.matchAll(/^#\s*(?![:*])(.+)$/gm)].map(m => _wtRender(m[1])).filter(Boolean).slice(0, 3);
      out.push({ lang, ety, defs });
    }
    return out;
  }

  const _sleep = ms => new Promise(r => setTimeout(r, ms));
  // Run fn over items, at most n at a time (gentle on the public services).
  async function _pool(items, n, fn) {
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  }
  // (dev1151) _netFails counts requests that never got an answer, so a look-up
  // can tell "no source" from "the service didn't reply" (and try again later).
  let _netFails = 0;
  async function _getJson(url) {
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const r = await fetch(url);
        if (r.status === 204) return null;
        if (r.status === 429 || r.status === 503) { await _sleep(2500 * (attempt + 1)); continue; }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const txt = await r.text();
        return txt ? JSON.parse(txt) : null;
      }
      throw new Error('rate-limited (HTTP 429)');
    } catch (e) {
      _netFails++;
      throw e;
    }
  }

  // Wiktionary wikitext for many words, 50 per request. Map word → wikitext.
  // (dev1151) Pages are remembered for the session ('' = no page), so Name
  // origin and Name say, and the next tag opened, ask for each word once.
  const _wtCache = new Map();
  async function _wtFetchMany(words) {
    const out = new Map();
    const uniq = [...new Set(words.filter(Boolean))].filter(w => {
      if (!_wtCache.has(w)) return true;
      if (_wtCache.get(w)) out.set(w, _wtCache.get(w));
      return false;
    });
    for (let i = 0; i < uniq.length; i += 50) {
      const batch = uniq.slice(i, i + 50);
      const j = await _getJson('https://en.wiktionary.org/w/api.php?action=query&prop=revisions&rvprop=content'
        + '&rvslots=main&format=json&formatversion=2&redirects=1&origin=*&titles='
        + encodeURIComponent(batch.join('|'))).catch(() => null);
      if (j && j.query) {
        const got = new Map();
        (j.query.pages || []).forEach(p => {
          const rev = p.revisions && p.revisions[0];
          const txt = rev && rev.slots && rev.slots.main ? rev.slots.main.content : '';
          if (txt) got.set(p.title, txt);
        });
        const to = _titleResolver(j.query);
        batch.forEach(w => { const txt = got.get(to(w)) || ''; _wtCache.set(w, txt); if (txt) out.set(w, txt); });
      }
      if (i + 50 < uniq.length) await _sleep(1500);   // 600 ms drew 429s
    }
    return out;
  }
  // A MediaWiki query answers under the final title: asked → normalized →
  // redirect target. Several asked titles may land on one page.
  function _titleResolver(q) {
    const norm = {}, redir = {};
    (q.normalized || []).forEach(x => { norm[x.from] = x.to; });
    (q.redirects || []).forEach(x => { redir[x.from] = x.to; });
    return t => { t = norm[t] || t; return redir[t] || t; };
  }

  // Up to the first . or ; that is outside “quotes” and (brackets), so a gloss
  // like (“rag; wrinkle”) is not cut in half.
  const _firstSentence = (s, max) => {
    s = String(s || '');
    let depth = 0, end = s.length;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '“' || c === '(') depth++;
      else if ((c === '”' || c === ')') && depth > 0) depth--;
      else if ((c === '.' || c === ';') && depth === 0 && (i + 1 === s.length || /\s/.test(s[i + 1]))) { end = i; break; }
    }
    let t = s.slice(0, end).replace(/[.;\s]+$/, '');
    if (t.length > (max || 220)) t = t.slice(0, max || 220).replace(/\s+\S*$/, '') + '…';
    return t;
  };

  // What a one-word name is built from (Translingual/Latin etymology).
  function _wtNameEtymology(wikitext) {
    const s = _wtSections(wikitext, ['Translingual', 'Latin']).find(x => x.ety && !/\u0001/.test(x.ety));
    return s ? _firstSentence(s.ety) : '';
  }
  // What an epithet means: { text } or { lemma } when it is an inflected form.
  function _wtEpithetMeaning(wikitext) {
    for (const s of _wtSections(wikitext, ['Translingual', 'Latin'])) {
      const follow = s.defs.find(d => d.charAt(0) === '\u0001');
      if (follow) {
        const lemma = follow.slice(1).normalize('NFD').replace(/[̀-ͯ]/g, '');
        if (lemma) return { lemma };
      }
      const defs = s.defs.filter(d => d.charAt(0) !== '\u0001')
        .map(d => d.split(';')[0].replace(/,\s*having been\b.*$/, '').trim()).filter(Boolean);
      const epo = defs.length && /^(.+?)\s*\(attributive\)$/.exec(defs[0]);
      if (epo) return { text: 'named after ' + epo[1] };
      if (defs.length) return { text: (s.lang === 'Latin' ? 'Latin, ' : '') + '“' + defs.slice(0, 2).join('; ') + '”' };
      if (s.ety) return { text: _firstSentence(s.ety) };
    }
    return null;
  }

  // A compound name Wiktionary has no page for (Rhinomuraena): split after a
  // connecting vowel (o, i) into a prefix entry + a word or suffix entry.
  function _wtSplits(word) {
    const lw = String(word || '').toLowerCase(), out = [];
    for (let i = 3; i <= Math.min(9, lw.length - 3); i++) {         // real prefixes are short
      if (lw[i - 1] !== 'o' && lw[i - 1] !== 'i') continue;
      const rest = lw.slice(i);
      // Suffix entry first (-cephalus “head”), then a genus page — Translingual
      // only, so Cephalus the myth is not taken for -cephalus — then the word.
      out.push({ pre: lw.slice(0, i) + '-', forms: [
        { t: '-' + rest, langs: WT_PART_LANGS },
        { t: rest[0].toUpperCase() + rest.slice(1), langs: ['Translingual'] },
        { t: rest, langs: WT_PART_LANGS }] });
    }
    return out;
  }
  const WT_PART_LANGS = ['Translingual', 'Latin', 'English'];
  // The short meaning of a word part: the first quoted gloss in its etymology,
  // else its first real definition. "" when the page says nothing usable.
  function _wtPartGloss(wikitext, langs) {
    for (const s of _wtSections(wikitext, langs || WT_PART_LANGS)) {
      const q = /“([^”]+)”/.exec(s.ety || '') || /“([^”]+)”/.exec(s.defs.join(' '));
      const d = q ? q[1] : s.defs.find(x => x.charAt(0) !== '\u0001' && !/^(Used |A taxonomic|\()/i.test(x));
      if (d) return d.replace(/\.$/, '').replace(/^Of (the )?/i, '').replace(/^./, c => c.toLowerCase())
        .split(',').slice(0, 2).join(',').trim();
    }
    return '';
  }
  // "rhino- (“nose”) + Muraena (“moray eel”)", or "" when no split is backed by both pages.
  function _wtCompound(word, pages) {
    for (const sp of _wtSplits(word)) {
      const pg = _wtPartGloss(pages.get(sp.pre));
      if (!pg) continue;
      for (const f of sp.forms) {
        const rg = _wtPartGloss(pages.get(f.t), f.langs);
        if (rg) return sp.pre + ' (“' + pg + '”) + ' + f.t + ' (“' + rg + '”)';
      }
    }
    return '';
  }

  // WoRMS authority for many names, 50 per request; a homonym is settled by the
  // tag's own lineage (Mertensia the comb jelly, not the plant). Map name → {auth, url}.
  async function _wormsAuthorities(items, onStep) {
    const out = new Map();
    const batches = [];
    for (let i = 0; i < items.length; i += 50) batches.push(items.slice(i, i + 50));
    let done = 0;
    // WoRMS takes ~13 s per 50 names, so three batches run at once.
    await _pool(batches, 3, async batch => {
      const qs = batch.map(x => 'scientificnames[]=' + encodeURIComponent(x.name)).join('&');
      const res = await _getJson('https://www.marinespecies.org/rest/AphiaRecordsByMatchNames?' + qs
        + '&marine_only=false').catch(() => null);
      batch.forEach((x, j) => {
        const hits = (res && Array.isArray(res[j]) ? res[j] : [])
          .filter(h => h && /^(exact|phonetic)$/.test(h.match_type || '') && h.authority);
        if (!hits.length) return;
        const fit = h => [h.kingdom, h.phylum, h.class, h.order, h.family].some(v => v && x.lineage.has(String(v).toLowerCase()));
        const h = hits.find(fit) || (hits.length === 1 ? hits[0] : hits.find(h => h.status === 'accepted') || hits[0]);
        out.set(x.name, { auth: h.authority, url: h.url || '', aphia: h.status === 'accepted' ? h.AphiaID : 0 });
      });
      done++;
      if (onStep && batches.length > 1) onStep('WoRMS: who named them… ' + done + '/' + batches.length);
    });
    return out;
  }
  async function _gbifAuthority(name) {
    const g = await _getJson('https://api.gbif.org/v1/species/match?strict=true&name=' + encodeURIComponent(name)).catch(() => null);
    if (!g || !(g.matchType === 'EXACT' || (g.matchType === 'FUZZY' && g.confidence >= 95))) return null;
    const auth = g.authorship || (g.scientificName && g.canonicalName ? g.scientificName.slice(g.canonicalName.length).trim() : '');
    return auth ? { auth, url: g.usageKey ? 'https://www.gbif.org/species/' + g.usageKey : '' } : null;
  }

  // "(Garman, 1888)" → "Described by Garman in 1888, first placed in a different genus."
  // (dev1151) x.names = the authors' full names (Wikidata), x.orig = the name it
  // was first described under: "Described by Carl Linnaeus in 1758 as Tetraodon mola."
  function _splitAuthority(auth) {
    const a = String(auth || '').trim();
    const moved = /^\(.*\)$/.test(a);
    const inner = a.replace(/^\(|\)$/g, '').trim();
    const m = /^(.*?),?\s*(\d{4})\s*$/.exec(inner);
    return { moved, inner, who: m ? m[1].trim() : inner, year: m ? m[2] : '' };
  }
  function authoritySentence(auth, x) {
    if (!String(auth || '').trim()) return '';
    const p = _splitAuthority(auth);
    x = x || {};
    const names = (x.names || []).length
      ? x.names.slice(0, -1).join(', ') + (x.names.length > 1 ? ' and ' : '') + x.names[x.names.length - 1] : p.who;
    return 'Described by ' + names + (p.year ? ' in ' + p.year : '')
      + (p.moved ? (x.orig ? ' as ' + x.orig + '.' : ', first placed in a different genus.') : '.');
  }

  // Wikidata, many names per query: each taxon item's authors (full names)
  // and its original combination / basionym. Map name → [{ q, authors[], orig }].
  async function _wdTaxa(names) {
    const out = new Map();
    for (let i = 0; i < names.length; i += 80) {
      const batch = names.slice(i, i + 80).filter(n => /^[A-Za-z][A-Za-z -]*$/.test(n));
      if (!batch.length) continue;
      const q = 'SELECT ?name ?item ?authorLabel ?origName WHERE { VALUES ?name { '
        + batch.map(n => '"' + n + '"').join(' ') + ' } ?item p:P225 ?st . ?st ps:P225 ?name . '
        + 'OPTIONAL { ?st pq:P405 ?author . } OPTIONAL { ?item wdt:P566|wdt:P1403 ?o . ?o wdt:P225 ?origName . } '
        + 'SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". } }';
      const j = await _getJson('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q)).catch(() => null);
      const items = new Map();
      ((j && j.results && j.results.bindings) || []).forEach(b => {
        const q = b.item.value.replace(/^.*\//, '');
        if (!items.has(q)) items.set(q, { q, name: b.name.value, authors: [], orig: '' });
        const it = items.get(q);
        const al = b.authorLabel && b.authorLabel.value;
        if (al && !/^Q\d+$/.test(al) && !it.authors.includes(al)) it.authors.push(al);
        if (b.origName && !it.orig) it.orig = b.origName.value;
      });
      items.forEach(it => { if (!out.has(it.name)) out.set(it.name, []); out.get(it.name).push(it); });
    }
    return out;
  }
  // The Wikidata item whose authors are the WoRMS/GBIF authority's surnames,
  // in that order. Anything that does not line up is ignored, so a homonym
  // (a plant of the same name) can't lend its authors.
  function _wdMatch(items, auth, genus, epithet) {
    const p = _splitAuthority(auth);
    const sur = p.who.split(/\s*(?:,|&|\band\b|\bet\b)\s*/).filter(Boolean)
      .map(s => salFold(s.split(/\s+/).pop()));
    for (const it of items || []) {
      if (!sur.length || it.authors.length !== sur.length) continue;
      const names = sur.map(s => it.authors.find(a => salFold(a.split(/\s+/).pop()) === s));
      if (names.some(n => !n || n.length > 60)) continue;
      return { q: it.q, names, orig: _origOk(it.orig, genus, epithet) ? it.orig : '' };
    }
    return null;
  }
  // An original combination is another genus with the same epithet (its
  // ending may change with the genus: Sepia pfefferi, Medusa velella).
  function _origOk(orig, genus, epithet) {
    const w = String(orig || '').trim().split(/\s+/);
    if (w.length < 2 || !epithet) return false;
    return w[0] !== genus && salFold(w[w.length - 1]).slice(0, 4) === salFold(epithet).slice(0, 4);
  }
  // WoRMS synonyms of a moved species: the one under the authority without
  // brackets is the name it was first described under (Tetraodon mola).
  async function _wormsOriginal(a, genus, epithet) {
    const inner = _splitAuthority(a.auth).inner;
    const all = [];
    for (let off = 1; off < 200; off += 50) {
      const page = await _getJson('https://www.marinespecies.org/rest/AphiaSynonymsByAphiaID/' + a.aphia + '?offset=' + off);
      if (!Array.isArray(page)) break;
      all.push(...page);
      if (page.length < 50) break;
    }
    const c = all.filter(x => x && String(x.authority || '').trim() === inner && _origOk(x.scientificname, genus, epithet));
    const best = c.find(x => /basionym|original/i.test((x.unacceptreason || '') + ' ' + (x.status || ''))) || c[0];
    return best ? best.scientificname : '';
  }

  // What the bare word means, from its first two definitions (for the base of
  // a diminutive: velum “cloth; sail of a ship”, not the PIE root in its etymology).
  function _wtFirstDef(wikitext, langs) {
    for (const s of _wtSections(wikitext, langs)) {
      const d = s.defs.filter(x => x.charAt(0) !== '\u0001' && !/^(Used |A taxonomic)/i.test(x))
        .map(x => x.replace(/^\([^)]*\)\s*/, '').replace(/\.$/, '').replace(/^(an?|the) /i, '').split(/[;,]/)[0].trim())
        .filter(Boolean);
      if (d.length) return d.slice(0, 2).join('; ');
    }
    return '';
  }
  // Velella → vel + -ella → velum (“sail”): a Latin diminutive of a word
  // Wiktionary has. Bases tried: -um, -us, -a.
  const WT_DIM = ['ellus', 'ella', 'ellum', 'illus', 'illa', 'illum', 'ulus', 'ula', 'ulum'];
  function _wtDimBases(word) {
    const lw = String(word || '').toLowerCase();
    const suf = WT_DIM.find(s => lw.endsWith(s) && lw.length - s.length >= 3);
    if (!suf) return [];
    const stem = lw.slice(0, -suf.length);
    return [stem + 'um', stem + 'us', stem + 'a'];
  }
  function _wtDiminutive(word, pages) {
    for (const b of _wtDimBases(word)) {
      const g = _wtFirstDef(pages.get(b), ['Latin']);
      if (g) return 'a diminutive of Latin ' + b + ' (“' + g + '”)';
    }
    return '';
  }
  // An epithet with no Wiktionary page at all, ending in the Latin genitive of
  // a surname: pfefferi → “of Pfeffer”. (-ae/-orum skipped: novaeangliae.)
  function _eponym(ep) {
    const m = /^([a-z]{3,}?[^aeiouy])(ii|i)$/.exec(String(ep || ''));
    if (!m) return '';
    const who = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    return '“of ' + who + '”, after a person named ' + who;
  }

  // Wikipedia: the article a tag is filed under (taxoninfo), else its label,
  // which Wikipedia redirects (Rhinomuraena quaesita → Ribbon eel).
  function _wikiTitleFor(t) {
    const ti = t && window.taxonInfo && typeof window.taxonInfo.get === 'function' ? window.taxonInfo.get(t.id) : null;
    return (ti && ti.wikiTitle) || (t && t.label) || '';
  }
  // A species' genus tag, when it is filed under one.
  function _genusTagOf(t) {
    const g = String(t.label || '').trim().split(/\s+/)[0];
    const pid = (t.parents || []).find(p => { const pt = byId.get(p); return pt && pt.label === g; });
    return pid ? byId.get(pid) : null;
  }
  const _wpUrl = title => 'https://en.wikipedia.org/wiki/' + encodeURIComponent(String(title).replace(/ /g, '_'));
  const _wtUrl = (word, lang) => 'https://en.wiktionary.org/wiki/' + encodeURIComponent(word) + (lang ? '#' + lang : '');
  // The part of a Wikipedia sentence that explains `word`: from the clause
  // that names it and says what it means, so "It was originally classified …
  // as Tetraodon mola, its epithet mola is Latin for …" starts at "Its epithet".
  // A clause before it that doesn't name the word stays ("In Latin, the name
  // Mola means …"). "Aptly named" is not an explanation, so plain "named" isn't enough.
  // "Refers to" counts only next to "name"/"epithet" — fossils that literature
  // "refers to" under a synonym explain nothing.
  const _MEAN_RE = /\b(?:Latin|Greek)\b|\bmeans?\b|\bmeaning\b|\bnamed (?:after|for|in honou?r)|\bhonou?r(?:s|ing|ed)?\b|\bderive[sd]? from\b|\betymolog\w*|\beponym\w*|\b(?:name|epithet)\b.*\b(?:refer(?:s|ring)? to|allud(?:es|ing) to)\b/i;
  // (dev1152) Sentences that explain a word without writing it: "The genus name
  // is a combination of rhino … and op …" (Rhinopias), "The name is derived
  // from … askaros … and sepion" (Ascarosepion). `implicit` is the phrase that
  // stands for the word; the caller decides which article may use which phrase.
  const _IMPL_GENUS = /\b(?:the|its|this) (?:genus|generic) name\b|\bthe name of the genus\b/i;
  const _IMPL_BARE = /\b(?:the|its|this) (?:scientific |Latin |Greek )?name\b(?! of the (?:species|family|order))/i;
  const _IMPL_EPITHET = /\b(?:the|its|this) (?:specific|species|trivial) (?:name|epithet)\b/i;
  function _wikiClause(text, word, implicit) {
    if (!word) return '';
    const wre = new RegExp('(^|[^A-Za-z])' + word.replace(/-/g, '\\-') + '($|[^A-Za-z])', 'i');
    if (!wre.test(text)) {
      const m = implicit ? implicit.exec(text) : null;
      if (!m) return '';
      let t = text.slice(m.index);
      // "The genus name Metasepia …" is about another name.
      if (/^\s+["“]?[A-Z][a-z]/.test(t.slice(m[0].length)) || !_MEAN_RE.test(t)) return '';
      // A tail after ";" that says nothing about the name goes ("…and sepion;
      // the type species, A. verreauxi, was collected off Sydney…").
      const semi = t.indexOf('; ');
      if (semi > 0 && !_MEAN_RE.test(t.slice(semi))) t = t.slice(0, semi) + '.';
      return t.charAt(0).toUpperCase() + t.slice(1);
    }
    const starts = [0];
    String(text).replace(/[,;]\s+/g, (m, off) => { starts.push(off + m.length); return m; });
    for (let k = 0; k < starts.length; k++) {
      const seg = text.slice(starts[k], k + 1 < starts.length ? starts[k + 1] : text.length);
      if (wre.test(seg) && _MEAN_RE.test(seg)) {
        if (!wre.test(text.slice(0, starts[k]))) return text;
        const t = text.slice(starts[k]).replace(/^(?:and|but|while|whereas|whilst)\s+/i, '');
        return t.charAt(0).toUpperCase() + t.slice(1);
      }
    }
    return '';
  }

  function _lineageLabels(t) {
    const s = new Set();
    tagAncestors(t.id).forEach(aid => { const a = byId.get(aid); if (a && a.label) s.add(a.label.toLowerCase()); });
    return s;
  }

  // Drafts for many taxon tags. Returns Map id → { draft, sources, auth, ety, meaning, epithet, word }.
  // (dev1151) opts.deep — for the one tag D has open — also asks WoRMS for the
  // original combination and Wikipedia for sentences that explain the words.
  // Both are a request per tag, so 🔎 Fill names over every taxon skips them.
  async function lookupNameOrigins(tags, onStep, opts) {
    const step = onStep || (() => {});
    const deep = !!(opts && opts.deep);
    const jobs = tags.map(t => {
      const words = String(t.label || '').trim().split(/\s+/).filter(w => /^[A-Za-z-]+$/.test(w));
      const single = words.length === 1;
      return { t, name: words.join(' '), lineage: _lineageLabels(t),
               word: single ? words[0] : '', genus: single ? '' : words[0],
               epithet: single ? '' : (words[words.length - 1] || '').toLowerCase() };
    }).filter(j => j.name);
    step('WoRMS: who named them…');
    const auths = await _wormsAuthorities(jobs.map(j => ({ name: j.name, lineage: j.lineage })), step);
    const missing = jobs.filter(j => !auths.has(j.name));
    let gDone = 0;
    await _pool(missing, 4, async j => {
      const a = await _gbifAuthority(j.name);
      if (a) auths.set(j.name, a);
      step('GBIF for the rest… ' + (++gDone) + '/' + missing.length);
    });
    step('Wiktionary: what the names mean…');
    const pages = await _wtFetchMany(jobs.flatMap(j => [j.word, j.genus, j.epithet]));
    // Genus / one-word names: their own etymology, else (genera only) built from
    // their parts — prefixes first, then the rest only where a prefix exists,
    // so a bulk fill stays a handful of requests.
    const etys = new Map(), etySrc = new Map();
    const genera = new Set(jobs.map(j => j.genus || (j.t.rank === 'genus' ? j.word : '')).filter(Boolean));
    const needParts = [];
    new Set(jobs.map(j => j.word || j.genus).filter(Boolean)).forEach(w => {
      const e = _wtNameEtymology(pages.get(w));
      if (e) { etys.set(w, e); etySrc.set(w, w); } else if (genera.has(w)) needParts.push(w);
    });
    if (needParts.length) {
      step('Wiktionary: parts of ' + needParts.length + ' genus names…');
      const pp = await _wtFetchMany(needParts.flatMap(w => _wtSplits(w).map(sp => sp.pre).concat(_wtDimBases(w))));
      const rest = needParts.flatMap(w => _wtSplits(w).filter(sp => _wtPartGloss(pp.get(sp.pre))).flatMap(sp => sp.forms.map(f => f.t)));
      if (rest.length) (await _wtFetchMany(rest)).forEach((v, k) => pp.set(k, v));
      needParts.forEach(w => {
        const c = _wtCompound(w, pp) || _wtDiminutive(w, pp);
        if (c) { etys.set(w, c); etySrc.set(w, (/^(\S+) \(/.exec(c) || /Latin (\S+) \(/.exec(c) || [])[1] || ''); }
      });
    }
    const meanings = new Map(), lemmas = new Map();
    jobs.forEach(j => {
      if (!j.epithet) return;
      const m = _wtEpithetMeaning(pages.get(j.epithet));
      if (m && m.lemma && m.lemma !== j.epithet) lemmas.set(j.epithet, m.lemma);
      else if (m && m.text && m.text.toLowerCase().replace(/[^a-z]/g, '') !== j.epithet.replace(/[^a-z]/g, '')) meanings.set(j.epithet, m.text);
      else if (!pages.has(j.epithet) && _eponym(j.epithet)) meanings.set(j.epithet, _eponym(j.epithet));
    });
    if (lemmas.size) {
      const lp = await _wtFetchMany([...lemmas.values()]);
      lemmas.forEach((lemma, ep) => {
        const m = _wtEpithetMeaning(lp.get(lemma));
        if (m && m.text) meanings.set(ep, m.text.replace(/^Latin, (.*)$/, 'Latin $1 (a form of ' + lemma + ')'));
      });
    }
    // Who: full names and the original genus from Wikidata (batched), then for
    // the open tag WoRMS's own synonym list, which knows more original names.
    step('Wikidata: the authors’ full names…');
    const wd = await _wdTaxa(jobs.filter(j => auths.has(j.name)).map(j => j.name)).catch(() => new Map());
    const who = new Map();
    jobs.forEach(j => {
      const a = auths.get(j.name);
      const m = a ? _wdMatch(wd.get(j.name), a.auth, j.genus, j.epithet) : null;
      if (m) who.set(j.name, m);
    });
    const wiki = new Map();
    if (deep) {
      step('WoRMS + Wikipedia: original name, and what the words mean…');
      await Promise.all(jobs.map(async j => {
        const a = auths.get(j.name);
        if (a && a.aphia && j.epithet && _splitAuthority(a.auth).moved) {
          const o = await _wormsOriginal(a, j.genus, j.epithet).catch(() => '');
          if (o) who.set(j.name, Object.assign({}, who.get(j.name) || {}, { orig: o }));
        }
        const g = j.genus ? _genusTagOf(j.t) : null;
        const titles = [...new Set([_wikiTitleFor(j.t), j.genus ? (g ? _wikiTitleFor(g) : j.genus) : ''].filter(Boolean))];
        const keys = [j.word || j.genus, j.epithet].filter(Boolean);
        // self = the tag's own article; for a species the second is the genus's.
        wiki.set(j.t.id, (await Promise.all(titles.map((ti, k) => wikiNamingSentences(ti, keys)
          .then(a => a.map(s => Object.assign(s, { self: k === 0 }))).catch(() => [])))).flat());
      }));
    }
    const out = new Map();
    jobs.forEach(j => {
      const a = auths.get(j.name);
      const nameWord = j.word || j.genus;
      const ety = etys.get(nameWord) || '';
      const meaning = j.epithet ? (meanings.get(j.epithet) || '') : '';
      const w = who.get(j.name) || {};
      const sources = [];
      const lines = [];
      if (a) {
        lines.push(authoritySentence(a.auth, w));
        if (a.url) sources.push({ name: /gbif/.test(a.url) ? 'GBIF' : 'WoRMS', url: a.url });
        if (w.q && (w.names || w.orig)) sources.push({ name: 'Wikidata', url: 'https://www.wikidata.org/wiki/' + w.q });
      }
      // A Wikipedia sentence that explains a word takes that word's line — it
      // says why (“which the fish resembles…”), Wiktionary only what. Taken
      // as written, so it carries its credit link (CC BY-SA).
      const ws = wiki.get(j.t.id) || [];
      // Words named outright win; then (dev1152) sentences that stand a phrase
      // in for the word. The genus: "the genus name" in either article, a bare
      // "the name" only in its own article. The epithet: "the specific name",
      // only in the species' own article. A paragraph that starts on another
      // name ("Metasepia was described …") is about that one.
      const gWord = (j.genus || j.word).toLowerCase();
      const isGenus = !!j.genus || j.t.rank === 'genus';
      const wikiFor = (word, epi) => {
        for (const s of ws) { const c = _wikiClause(s.text, word); if (c) return { c, src: s.src }; }
        for (const s of ws) {
          if (s.subject && s.subject.toLowerCase() !== gWord) continue;
          const own = j.word ? s.self : !s.self;
          for (const [re, bare] of epi ? [[s.self ? _IMPL_EPITHET : null, false]]
                                       : [[isGenus ? _IMPL_GENUS : null, false], [own ? _IMPL_BARE : null, true]]) {
            const c = re ? _wikiClause(s.text, word, re) : '';
            if (c) return { c: bare && j.genus ? j.genus + ': ' + c.charAt(0).toLowerCase() + c.slice(1) : c, src: s.src };
          }
        }
        return null;
      };
      const wG = wikiFor(nameWord, false), wE = j.epithet ? wikiFor(j.epithet, true) : null;
      const wikiLine = x => x.c + ' ([Wikipedia](' + x.src + '))';
      if (wG || wE) sources.push({ name: 'Wikipedia', url: (wG || wE).src });
      const wt = [];                                   // Wiktionary pages the draft used
      const tauto = !!(j.genus && j.epithet && j.genus.toLowerCase() === j.epithet);
      if (tauto) {
        const x = wG || wE;
        if (!x && ety) wt.push(etySrc.get(nameWord));
        lines.push(j.genus + ' ' + j.epithet + ': the genus and the epithet are the same word'
          + (!x && ety ? ', ' + ety.charAt(0).toLowerCase() + ety.slice(1) : '') + '.');
        if (x) lines.push(wikiLine(x));
      } else {
        // One sentence often explains both words, or one clause is the tail of
        // the other: keep the longer, once.
        let g2 = wG, e2 = wE;
        if (g2 && e2 && (g2.c.includes(e2.c) || e2.c.includes(g2.c))) { g2 = g2.c.length >= e2.c.length ? g2 : e2; e2 = null; }
        if (g2) lines.push(wikiLine(g2));
        else if (ety) { lines.push(nameWord + ': ' + ety + '.'); wt.push(etySrc.get(nameWord)); }
        if (e2) lines.push(wikiLine(e2));
        else if (!wE && meaning) {
          lines.push(j.epithet + ': ' + meaning + '.');
          wt.push(lemmas.get(j.epithet) || (pages.has(j.epithet) ? j.epithet : ''));
        }
      }
      const wt1 = wt.find(Boolean);
      if (wt1) sources.push({ name: 'Wiktionary', url: _wtUrl(wt1) });
      out.set(j.t.id, { draft: lines.map(l => l.replace(/\.{2,}$/, '.').replace(/([.!?])\.$/, '$1')).join('\n'),
                        sources, auth: a || null, ety, meaning, word: j.word, epithet: j.epithet });
    });
    return out;
  }

  // Wikipedia sentences that talk about the name, best first. Per-tag only —
  // full-article extracts come one page per request.
  const _NAMING_RE = /\b(named|naming|derived from|derives from|from the (?:Ancient )?(?:Greek|Latin)|etymolog\w*|specific (?:name|epithet)|generic name|genus name|epithet|honou?r(?:s|ing|ed)?|eponym\w*|(?:Latin|Greek) (?:word )?for|meaning|means|refer(?:s|ring)? to|in reference to|alludes? to)\b/i;
  async function wikiNamingSentences(title, keyWords) {
    if (!title) return [];
    const j = await _getJson('https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1'
      + '&format=json&formatversion=2&redirects=1&origin=*&titles=' + encodeURIComponent(title)).catch(() => null);
    const p = j && j.query && j.query.pages && j.query.pages[0];
    if (!p || !p.extract) return [];
    const keys = (keyWords || []).map(w => String(w).toLowerCase()).filter(Boolean);
    const src = 'https://en.wikipedia.org/wiki/' + encodeURIComponent(String(p.title).replace(/ /g, '_'));
    // (dev1152) Paragraph by paragraph: `subject` is the name a paragraph opens
    // on ("Metasepia was described …"), so a "The name …" inside it is that name's.
    const sents = [];
    p.extract.split(/\n+/).forEach(par => {
      par = par.trim();
      if (!par || /^=+[^=]*=+$/.test(par)) return;
      const m = /^["“]?([A-Z][a-z]+)\s+(?:was|is|were|are|has|had)\b/.exec(par);
      const subject = m && !_NOT_SUBJECT.test(m[1]) ? m[1] : '';
      _sentences(par).forEach(s => sents.push({ s: s.replace(/\s+/g, ' ').trim(), subject }));
    });
    return sents
      .filter(x => x.s.length > 25 && x.s.length < 450 && _NAMING_RE.test(x.s))
      .map(({ s, subject }) => {
        const ls = s.toLowerCase();
        let score = 0;
        if (keys.some(k => ls.includes(k))) score += 3;
        if (/(generic|specific|genus) name|epithet|etymolog/i.test(s)) score += 3;
        if (/(Latin|Greek) (word )?for|from the (Ancient )?(Greek|Latin)/i.test(s)) score += 2;
        if (/named (after|for|in honou?r)|honou?r/i.test(s)) score += 2;
        if (/\bderive[sd]? from\b|\bcombination of\b/i.test(s)) score += 2;
        if (/common name/i.test(s)) score -= 1;
        return { text: s, src, score, subject };
      })
      .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 4);
  }
  const _NOT_SUBJECT = /^(?:It|Its|This|That|These|Those|There|They|Their|He|She|One|Each|All|Both|Some|Most|Many|Several|Such|Which|What|Who|Here)$/;
  // Sentences, without breaking after an initial or a short abbreviation
  // ("R. frondosa", "A. verreauxi", "e.g.").
  function _sentences(par) {
    const out = [];
    par.split(/(?<=[.!?]["”’)]?)\s+(?=[A-Z"“(])/).forEach(p => {
      const prev = out.length ? out[out.length - 1] : '';
      if (prev && (/(?:^|[\s(])[A-Z]\.$/.test(prev) || /(?:^|[\s(])(?:st|mt|dr|mrs?|ms|cf|ca|e\.g|i\.e|spp?|var|fig|approx|vol|no)\.$/i.test(prev))) {
        out[out.length - 1] = prev + ' ' + p;
      } else out.push(p);
    });
    return out;
  }

  // ── Name say from published pronunciations (dev1151) ─────────────────────
  // Only what a source has printed — never worked out from the spelling (the
  // dev1149 rule respelling was dropped as poor):
  //   Wikipedia leads: {{respell}} or {{IPAc-en}} right after a bold name;
  //   Wiktionary: Translingual pronunciation, or the English entry whose sense
  //     is this animal ("mola: a sunfish, Mola mola").
  // IPA is rewritten in the respelling key behind D's "?". A binomial is
  // filled only when every word has a source; otherwise the box stays empty.
  const IPA_V = ['eɪ', 'aɪ', 'ɔɪ', 'oʊ', 'əʊ', 'aʊ', 'ɪə', 'eə', 'ɛə', 'ʊə', 'iː', 'uː', 'ɑː', 'ɔː', 'ɜː', 'ɛː',
    'i', 'u', 'ɪ', 'ʊ', 'e', 'ɛ', 'æ', 'ɑ', 'ɒ', 'ɔ', 'ʌ', 'ə', 'a', 'o'];
  const IPA_C = ['tʃ', 'dʒ', 'hw', 'p', 'b', 't', 'd', 'k', 'g', 'f', 'v', 'θ', 'ð', 's', 'z', 'ʃ', 'ʒ', 'h',
    'm', 'n', 'ŋ', 'l', 'r', 'j', 'w', 'x'];
  const IPA_ONSET = new Set(['pl', 'pr', 'bl', 'br', 'tr', 'dr', 'kl', 'kr', 'gl', 'gr', 'fl', 'fr', 'θr', 'ʃr',
    'sp', 'st', 'sk', 'sm', 'sn', 'sl', 'sw', 'sf', 'tw', 'dw', 'kw', 'gw', 'θw', 'pj', 'bj', 'tj', 'dj', 'kj', 'gj',
    'mj', 'nj', 'fj', 'vj', 'hj', 'lj', 'sj', 'zj', 'θj', 'spl', 'spr', 'str', 'skr', 'skw', 'skj', 'spj', 'stj']);
  const IPA_CHECKED = new Set(['ɪ', 'ʊ', 'e', 'ɛ', 'æ', 'ɒ', 'ʌ', 'ɑ']);
  const RS_CONS = { 'θ': 'th', 'ð': 'dh', 'ʃ': 'sh', 'ʒ': 'zh', 'tʃ': 'ch', 'dʒ': 'j', 'j': 'y', 'ŋ': 'ng', 'x': 'kh', 'hw': 'wh' };
  // vowel + r in the same syllable: before a consonant or at the end (near,
  // north), and before a vowel (merry, moray → MORR-ay), as Wikipedia writes them.
  const RS_R = { 'ɔː': 'or', 'ɔ': 'or', 'o': 'or', 'ɑː': 'ar', 'ɑ': 'ar', 'a': 'ar', 'ə': 'er', 'ɜː': 'ur',
    'ɪə': 'eer', 'iː': 'eer', 'i': 'eer', 'ɛə': 'air', 'eə': 'air', 'ɛː': 'air', 'ʊə': 'oor', 'uː': 'oor', 'u': 'oor' };
  const RS_R_CONS = { 'ɪ': 'eer', 'ɛ': 'air', 'e': 'air', 'ʊ': 'oor', 'ʌ': 'ur', 'æ': 'ar', 'ɒ': 'or' };
  const RS_R_VOW = { 'ɪ': 'irr', 'ɛ': 'err', 'e': 'err', 'ʊ': 'oor', 'ʌ': 'urr', 'æ': 'arr', 'ɒ': 'orr' };

  function _ipaNorm(s) {
    return String(s || '').normalize('NFC')
      .replace(/[,;].*$/, '')                     // first of several forms
      .replace(/[\/\[\]]/g, '').replace(/\([^)]*\)/g, '')     // optional sounds dropped
      .replace(/[͜͡‿]/g, '').replace(/[ɹɻ]/g, 'r').replace(/ɡ/g, 'g').replace(/ɫ/g, 'l')
      .replace(/ɾ/g, 't').replace(/ʍ/g, 'hw').replace(/ʔ/g, '').replace(/ɚ/g, 'ər').replace(/ɝ/g, 'ɜːr')
      .replace(/ɐ/g, 'ə').replace(/[ᵻɨ]/g, 'ɪ').replace(/ᵿ/g, 'ʊ').replace(/ɵ/g, 'oʊ').replace(/:/g, 'ː')
      .replace(/'/g, 'ˈ').replace(/([nlmr])[̩̍]/g, 'ə$1')     // syllabic n̩ l̩ → ən əl
      .replace(/[̀-ͯ]/g, '').replace(/ˑ/g, '').replace(/ɜ(?!ː)/g, 'ɜː')
      .trim();
  }
  // One IPA word → its syllables { on[], v, co[], st } (st 2 = primary stress).
  function _ipaSyllables(word) {
    const toks = [];
    for (let i = 0; i < word.length;) {
      const ch = word[i];
      if (ch === 'ˈ' || ch === 'ˌ' || ch === '.' || ch === '-') { toks.push({ k: 'B', st: ch === 'ˈ' ? 2 : ch === 'ˌ' ? 1 : 0 }); i++; continue; }
      const v = IPA_V.find(x => word.startsWith(x, i));
      if (v) { toks.push({ k: 'V', p: v }); i += v.length; continue; }
      const c = IPA_C.find(x => word.startsWith(x, i));
      if (c) { toks.push({ k: 'C', p: c }); i += c.length; continue; }
      return null;                                  // a symbol we can't read: no respelling at all
    }
    const nuc = toks.map((t, j) => (t.k === 'V' ? j : -1)).filter(j => j >= 0);
    if (!nuc.length) return null;
    const sy = [];
    nuc.forEach((ni, n) => {
      const gap = toks.slice(n ? nuc[n - 1] + 1 : 0, ni);
      const s = { on: [], v: toks[ni].p, co: [], st: 0 };
      const cons = gap.filter(g => g.k === 'C').map(g => g.p);
      const bi = gap.findIndex(g => g.k === 'B');
      gap.forEach(g => { if (g.k === 'B' && g.st > s.st) s.st = g.st; });
      if (!n) s.on = cons;
      else {
        const prev = sy[n - 1];
        let split;
        if (bi >= 0) split = gap.slice(0, bi).filter(g => g.k === 'C').length;
        else {
          // Maximal onset, but a stressed short vowel keeps a consonant (TOP-ə-də).
          let k = cons.length;
          while (k > 0 && !(k === 1 ? cons[cons.length - 1] !== 'ŋ' : IPA_ONSET.has(cons.slice(-k).join('')))) k--;
          split = cons.length - k;
          if (!split && cons.length && prev.st === 2 && IPA_CHECKED.has(prev.v)) split = 1;
        }
        // Even across a printed boundary (/ˈpæ.ɡjə.ɹəs/) a stressed short vowel
        // is written closed, as Wikipedia does: PAG-yer-uhs, not PA-.
        if (!split && cons.length && prev.st === 2 && IPA_CHECKED.has(prev.v) && s.st !== 2) split = 1;
        prev.co = cons.slice(0, split);
        s.on = cons.slice(split);
      }
      sy.push(s);
    });
    sy[sy.length - 1].co = toks.slice(nuc[nuc.length - 1] + 1).filter(t => t.k === 'C').map(t => t.p);
    // The word's stress: primary, else its secondary, else a lone syllable.
    if (!sy.some(s => s.st === 2)) { const s2 = sy.find(s => s.st === 1); if (s2) s2.st = 2; else if (sy.length === 1) sy[0].st = 2; }
    return sy;
  }
  function _sylSpell(s, nextHasOnset) {
    const co = s.co.slice();
    let v;
    if (co[0] === 'r' && (RS_R[s.v] || RS_R_CONS[s.v])) {
      v = RS_R[s.v] || ((co.length > 1 || nextHasOnset !== false) ? RS_R_CONS[s.v] : RS_R_VOW[s.v]);
      co.shift();
    } else {
      const open = !co.length;
      v = { 'æ': 'a', 'ɛ': open ? 'eh' : 'e', 'e': open ? 'eh' : 'e', 'ɪ': open ? 'ih' : 'i', 'ɒ': 'o',
        'ʌ': open ? 'uh' : 'u', 'ʊ': 'uu', 'ə': 'uh', 'ɑ': open ? 'ah' : 'o', 'ɑː': 'ah', 'ɔː': 'aw', 'ɔ': 'aw',
        'ɜː': 'ur', 'iː': 'ee', 'i': 'ee', 'uː': 'oo', 'u': 'oo', 'eɪ': 'ay', 'oʊ': 'oh', 'əʊ': 'oh', 'o': 'oh',
        'aʊ': 'ow', 'ɔɪ': 'oy', 'ɪə': 'eer', 'eə': 'air', 'ɛə': 'air', 'ɛː': 'air', 'ʊə': 'oor', 'a': 'a',
        'aɪ': !s.on.length ? 'eye' : (open ? 'y' : 'igh') }[s.v];
    }
    const cons = arr => arr.map((c, i) => (c === 'ŋ' && (arr[i + 1] === 'k' || arr[i + 1] === 'g') ? 'n' : (RS_CONS[c] || c))).join('');
    if (s.dropR) v = v.slice(0, -1);                 // see ipaToRespell: myoo-REE
    const out = cons(s.on) + v + cons(co);
    return s.st === 2 ? out.toUpperCase() : out;
  }
  // "/ˈməʊ.lə/" → "MOH-luh"; several words keep their spaces. '' when unreadable.
  function ipaToRespell(ipa) {
    const words = _ipaNorm(ipa).split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    const out = [];
    for (const w of words) {
      const sy = _ipaSyllables(w);
      if (!sy) return '';
      // eer/air/oor already end in r: before an r-syllable write one r —
      // LAIR-ee-uh, but myoo-REE when the r-syllable carries the stress.
      sy.forEach((s, i) => {
        const nx = sy[i + 1];
        if (s.co.length || !nx || nx.on[0] !== 'r' || !/^(ɪə|eə|ɛə|ʊə|ɛː)$/.test(s.v)) return;
        if (nx.st === 2 && (s.v === 'ʊə' || s.v === 'ɪə')) s.dropR = true;
        else nx.on = nx.on.slice(1);
      });
      out.push(sy.map((s, i) => _sylSpell(s, i + 1 < sy.length ? sy[i + 1].on.length > 0 : true)).join('-'));
    }
    return out.join(' ');
  }
  // {{respell|ok|TOP|ə|də}} → "ok-TOP-uh-duh" (Wikipedia's own respelling, ə → uh).
  function _respellTemplate(body) {
    const all = body.split('|').slice(1).map(p => p.trim()).filter(p => p && !/=/.test(p));
    const cut = all.findIndex(p => /^[,;]/.test(p));                 // ",_" starts another form
    const parts = (cut >= 0 ? all.slice(0, cut) : all).filter(p => p !== '-');
    if (!parts.length) return '';
    return parts.join('-').replace(/-?_-?/g, ' ').replace(/ər/g, 'er').replace(/ə/g, 'uh');
  }
  // {{IPAc-en|UK|ˈ|m|ɒr|eɪ|,_|US|m|ə|ˈ|r|eɪ}} → { GB: 'ˈmɒreɪ', US: 'məˈreɪ', any: '' }
  function _ipacenForms(body) {
    const rec = { US: '', GB: '', any: '' };
    let cur = { acc: 'any', ipa: '' };
    const flush = () => { if (cur.ipa.trim() && !rec[cur.acc]) rec[cur.acc] = cur.ipa.trim(); };
    body.split('|').slice(1).map(p => p.trim()).filter(p => p && !/^[a-z0-9]+\s*=/i.test(p)).forEach(p => {
      if (/^[,;]/.test(p)) { flush(); cur = { acc: 'any', ipa: '' }; return; }
      if (/^[A-Za-z]{2,}$/.test(p) && p !== 'hw') {     // a label, not a sound
        if (cur.ipa.trim()) { flush(); cur = { acc: 'any', ipa: '' }; }
        const a = _accent(p);
        if (a !== 'any') cur.acc = a;
        return;
      }
      cur.ipa += p.replace(/_/g, ' ');
    });
    flush();
    delete rec.skip;
    return rec;
  }
  function _accent(s) {
    const set = new Set();
    String(s || '').split(/[,|]/).map(x => x.trim()).filter(Boolean).forEach(x => {
      if (/^(UK|RP|GB|SSB|Brit(ish)?|England|Received Pronunciation|Standard Southern British)$/i.test(x)) set.add('GB');
      else if (/^(US|GA|GenAm|General American|Amer(ican)?)$/i.test(x)) set.add('US');
      else if (!/^(en|mul|also|pron|lang|local|uncommon|rare|old-fashioned|traditional|standard|more common|common)$/i.test(x)) set.add('other');
    });
    if (set.has('GB') && set.has('US')) return 'any';
    if (set.has('GB')) return 'GB';
    if (set.has('US')) return 'US';
    return set.has('other') ? 'skip' : 'any';
  }
  // Pronunciations in a Wikipedia lead, keyed by the folded bold term they
  // follow: "order '''Octopoda''' ({{IPAc-en|…}})" belongs to Octopoda.
  function _wpSays(lead) {
    const out = new Map();
    const s = String(lead || '');
    const re = /\{\{\s*(IPAc-en|respell)\s*\|([^{}]*)\}\}/gi;
    let m;
    while ((m = re.exec(s))) {
      const before = s.slice(0, m.index);
      const bolds = [...before.matchAll(/'''(.+?)'''(?!')/g)];
      const b = bolds[bolds.length - 1];
      if (!b) continue;
      const gap = before.slice(b.index + b[0].length).replace(/\{\{[^{}]*\}\}/g, '');
      if (gap.length > 40 || /[.!?]\s|\)/.test(gap)) continue;
      const term = salFold(b[1].replace(/''/g, '').replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').trim());
      if (!term) continue;
      const rec = out.get(term) || { US: '', GB: '', any: '', respell: '' };
      if (/^respell$/i.test(m[1])) rec.respell = rec.respell || _respellTemplate('respell|' + m[2]);
      else { const f = _ipacenForms('IPAc-en|' + m[2]); ['US', 'GB', 'any'].forEach(k => { if (!rec[k] && f[k]) rec[k] = f[k]; }); }
      out.set(term, rec);
    }
    return out;
  }
  // Pronunciation lines of one language section of a Wiktionary page. For
  // English, only the etymology whose sense is a taxon (taxlink/taxfmt/
  // "genus"), so "mola" the textile can't lend its sound to Mola the fish.
  function _wtSays(wikitext, lang) {
    const secs = String(wikitext || '').split(/^==([^=].*?)==\s*$/m);
    let body = null;
    for (let i = 1; i < secs.length; i += 2) if (secs[i].trim() === lang) { body = secs[i + 1] || ''; break; }
    if (body == null) return null;
    if (lang === 'English') {
      const parts = body.split(/^===\s*Etymology[^=]*===\s*$/m);
      const isTaxon = x => /\{\{\s*(taxlink|taxfmt|taxon|taxlinknew|vern)\s*\|/i.test(x)
        || /^#[^:*].*\b(genus|species|family)\b/m.test(x);
      const k = parts.length > 1 ? parts.slice(1).findIndex(isTaxon) + 1 : (isTaxon(body) ? 0 : -1);
      if (k < 0 || (parts.length > 1 && k === 0)) return null;
      const own = parts.length > 1 ? _wtPronLines(parts[k]) : null;
      return own && (own.US || own.GB || own.any) ? own : _wtPronLines(parts[0]);
    }
    return _wtPronLines(body);
  }
  function _wtPronLines(text) {
    const rec = { US: '', GB: '', any: '' };
    String(text || '').split('\n').forEach(line => {
      if (!/^\*/.test(line)) return;
      const lineAcc = (/\{\{\s*(?:a|accent)\s*\|([^{}]*)\}\}/.exec(line) || [])[1] || '';
      for (const m of line.matchAll(/\{\{\s*IPA\s*\|([^{}]*)\}\}/g)) {
        const ps = m[1].split('|').map(p => p.trim());
        if (!/^(en|mul)$/.test(ps[0])) continue;
        const kv = {}, pos = [];
        ps.slice(1).forEach(p => { const x = /^(\w+)\s*=([\s\S]*)$/.exec(p); if (x) kv[x[1]] = x[2].trim(); else pos.push(p); });
        const ipa = pos.find(p => /^\//.test(p)) || pos.find(p => /^\[/.test(p));
        const acc = _accent(kv.a || kv.accent || lineAcc);
        if (ipa && acc !== 'skip' && !rec[acc]) rec[acc] = ipa;
      }
    });
    return rec;
  }
  // A sanity check, not a rule: a pronunciation printed next to a name but
  // meant for another word (Wikipedia's "Moray eels, or Muraenidae (/ˈmɒreɪ/)")
  // has too few or too many syllables for the spelling, so it is not used.
  function _sylFits(label, respell) {
    const lw = String(label).toLowerCase().split(/\s+/), rw = String(respell).split(/\s+/);
    if (lw.length !== rw.length) return false;
    return lw.every((w, i) => {
      const n = rw[i].split('-').filter(Boolean).length;
      return n >= (w.match(/[aeiouy]+/g) || []).length && n <= (w.match(/[aeiouy]/g) || []).length + 1;
    });
  }
  // A source record → { us, gb } respellings (one copied to the other when
  // only one accent is printed), or null.
  function _sayPair(rec) {
    if (!rec) return null;
    if (rec.respell) return { us: rec.respell, gb: rec.respell };
    const us = rec.US || rec.any ? ipaToRespell(rec.US || rec.any) : '';
    const gb = rec.GB || rec.any ? ipaToRespell(rec.GB || rec.any) : '';
    return us || gb ? { us: us || gb, gb: gb || us } : null;
  }
  // Lead-section wikitext of many Wikipedia pages, 50 per request.
  // Map asked title → { title, text }. Remembered for the session.
  const _wpLeadCache = new Map();
  async function _wpLeads(titles) {
    const out = new Map();
    const need = [...new Set(titles.filter(Boolean))].filter(x => {
      if (!_wpLeadCache.has(x)) return true;
      if (_wpLeadCache.get(x)) out.set(x, _wpLeadCache.get(x));
      return false;
    });
    for (let i = 0; i < need.length; i += 50) {
      const batch = need.slice(i, i + 50);
      const j = await _getJson('https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content'
        + '&rvslots=main&rvsection=0&format=json&formatversion=2&redirects=1&origin=*&titles='
        + encodeURIComponent(batch.join('|'))).catch(() => null);
      if (j && j.query) {
        const got = new Map();
        (j.query.pages || []).forEach(p => {
          const rev = p.revisions && p.revisions[0];
          const txt = rev && rev.slots && rev.slots.main ? rev.slots.main.content : '';
          if (txt) got.set(p.title, { title: p.title, text: txt });
        });
        const to = _titleResolver(j.query);
        batch.forEach(b => { const v = got.get(to(b)) || null; _wpLeadCache.set(b, v); if (v) out.set(b, v); });
      }
      if (i + 50 < need.length) await _sleep(1000);
    }
    return out;
  }

  // Name say for many taxon tags. Map id → { say, partial, missing[], sources[] }:
  // say = the lines for the box ('' unless every word has a source).
  async function lookupNameSays(tags, onStep) {
    const step = onStep || (() => {});
    const jobs = tags.map(t => {
      const words = String(t.label || '').trim().split(/\s+/).filter(w => /^[A-Za-z-]+$/.test(w));
      if (!words.length) return null;
      const g = words.length > 1 ? _genusTagOf(t) : null;
      const titles = [...new Set([_wikiTitleFor(t), words.length > 1 ? (g ? _wikiTitleFor(g) : words[0]) : ''].filter(Boolean))];
      return { t, words, label: words.join(' '), titles };
    }).filter(Boolean);
    step('Wikipedia: pronunciations in ' + jobs.length + ' article leads…');
    const leads = await _wpLeads(jobs.flatMap(j => j.titles));
    step('Wiktionary: pronunciations…');
    const pages = await _wtFetchMany(jobs.flatMap(j => [j.label, ...j.words, ...j.words.map(w => w.toLowerCase())]));
    const out = new Map();
    jobs.forEach(j => {
      const wp = j.titles.map(ti => leads.get(ti)).filter(Boolean).map(x => ({ x, says: _wpSays(x.text) }));
      const find = w => {
        const f = salFold(w);
        const fits = p => p && _sylFits(w, p.us) && _sylFits(w, p.gb);
        for (const { x, says } of wp) {
          const p = _sayPair(says.get(f));
          if (fits(p)) return { pair: p, src: { name: 'Wikipedia', url: _wpUrl(x.title) } };
        }
        for (const [pg, lang] of [[w, 'Translingual'], [w.toLowerCase(), 'English'], [w.toLowerCase(), 'Translingual']]) {
          const p = _sayPair(_wtSays(pages.get(pg), lang));
          if (fits(p)) return { pair: p, src: { name: 'Wiktionary', url: _wtUrl(pg, lang), word: pg } };
        }
        return null;
      };
      const whole = find(j.label);
      const parts = whole ? [whole] : j.words.length > 1 ? j.words.map(find) : [null];
      const missing = whole ? [] : j.words.filter((w, i) => !parts[i]);
      const sources = [];
      parts.forEach(p => { if (p && !sources.some(s => s.url === p.src.url)) sources.push(p.src); });
      let say = '', partial = '';
      if (!missing.length) {
        const us = parts.map(p => p.pair.us).join(' '), gb = parts.map(p => p.pair.gb).join(' ');
        say = us === gb ? us : 'US: ' + us + '\nGB: ' + gb;
      } else if (sources.length) {
        partial = j.words.map((w, i) => (parts[i] ? parts[i].pair.us : w.toLowerCase())).join(' ');
      }
      out.set(j.t.id, { say, partial, missing, sources });
    });
    return out;
  }

  // D's auto-fill: one look-up per tag per session (keyed by label as well, so
  // a renamed tag is looked up again). A failed look-up is forgotten.
  // fresh (D's ↻ Look up / R) asks the services again.
  const _autoCache = new Map();
  function autoNameDraft(kind, t, fresh) {
    const key = kind + '|' + t.id + '|' + t.label;
    if (fresh) _autoCache.delete(key);
    if (!_autoCache.has(key)) {
      const p = (async () => {
        const ti = window.taxonInfo;
        if (ti && ti.load && ti.loaded && !ti.loaded()) await ti.load().catch(() => {});
        const fails = _netFails;
        const m = kind === 'origin' ? await lookupNameOrigins([t], null, { deep: true }) : await lookupNameSays([t]);
        const r = Object.assign({}, m.get(t.id) || {});
        // A service that didn't answer: say so, and look again next time.
        if (_netFails > fails) { r.incomplete = true; _autoCache.delete(key); }
        return r;
      })();
      p.catch(() => _autoCache.delete(key));
      _autoCache.set(key, p);
    }
    return _autoCache.get(key);
  }

  // ── public API ───────────────────────────────────────────────────────────
  // ── salFold (dev0855) ───────────────────────────────────────────
  // ONE fold used by EVERY search path in the app: this file (searchTags, the
  // chip suggestions), boot.js (the shareable-menu Search blobs + query) and
  // core.js (the T 'anywhere' filter). It is shared rather than copied because
  // the whole safety of diacritic folding rests on both sides of a comparison
  // being folded IDENTICALLY:
  //   • Fold both sides and the change is monotone — it can only ADD matches,
  //     never lose one that works today.
  //   • Fold ONE side and it silently breaks. NFD decomposes Japanese dakuten
  //     (バ → ハ + U+3099) and Korean Hangul into jamo; folded on both sides
  //     those still match perfectly, folded on one side CJK search dies.
  // Two stages, because NFD alone only gets you halfway:
  //   1. NFD + strip U+0300-036F handles the combining-mark letters (é ñ ü å).
  //   2. The map handles the atomic ones NFD cannot touch — ø æ ł đ ß ð þ have
  //      no decomposition at all, so "klippelæbefisk" would stay unreachable
  //      from an ASCII keyboard without it. Expansions follow lodash.deburr
  //      (æ→ae, ø→o, œ→oe, ß→ss) rather than being invented here.
  // Known and accepted: Cyrillic й→и and ё→е merge two real letters, so "мои"
  // matches "мой". Over-matching only; the collection has 5 Cyrillic rows.
  const _foldMap = { 'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss',
                     'ð': 'd', 'þ': 'th', 'đ': 'd', 'ł': 'l',
                     'ŧ': 't', 'ħ': 'h', 'ŋ': 'n', 'ı': 'i' };
  function salFold(s) {
    return String(s == null ? '' : s)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[\u00f8\u00e6\u0153\u00df\u00f0\u00fe\u0111\u0142\u0167\u0127\u014b\u0131]/g,
               ch => _foldMap[ch] || ch);
  }
  window.salFold = salFold;

  const api = {
    load: loadTags,
    save: saveTags,
    all: () => tagsArr.slice(),
    get: (id) => byId.get(id) || null,
    has: (id) => byId.has(id),
    resolve: resolveInput,
    ancestors: tagAncestors,
    lineagePaths: tagLineagePaths,
    lineageString: tagLineageString,
    descendants: tagDescendants,
    expand: expandWithAncestors,
    matchesQuery: recordMatchesTagQuery,
    rebuildIndex: buildIndex,
    orphans: () => orphanTags.slice(),
    createTag,
    updateTag,
    deleteTag,
    mergeTag,
    labelFor,
    chipHtml,
    // (dev0891) applyChainImport was D-screen-only until now: the T promote
    // action (core.js _tEnrichSpeciesTag) reuses the exact same function the
    // Dictionary’s own Apply All button calls, so a right-click promotion and
    // a manual D lookup wire a species into the tree the identical way —
    // dedup, ecology-group linking, alias hygiene and all.
    applyChainImport,
    renderChipsForRecord,
    recordTagIds,
    search: searchTags,
    fold: salFold,
    resolveTaxon: (name, opts) => resolveTaxon(name, opts),
    closeMenu: closeChipContextMenu,
    TEXT_FIELDS,
    factsText,
    lookupNameOrigins,
    lookupNameSays,
    ipaToRespell,
    nameOriginHtml,
  };

  // Substring search across label, common name, and aliases.
  // Returns array of tag objects sorted: start-of-label matches first,
  // then by label length ascending (shorter = tighter match).
  function searchTags(q, limit) {
    if (!q) return [];
    limit = limit || 20;
    // (dev0855) Folded on BOTH sides — see salFold. Without it the chips fall
    // out of step with the results: typing 'senorita' would find the rows but
    // show no Oxyjulis chip — the same class of confusion as the old chip bug.
    const lq = salFold(q);
    const scored = [];
    tagsArr.forEach(t => {
      const lbl = salFold(t.label || '');
      const com = salFold(t.common || '');
      const ali = (t.aliases || []).concat(t.formerly || []).map(a => salFold(a));
      const inLabel   = lbl.includes(lq);
      const inCommon  = com.includes(lq);
      const inAlias   = ali.some(a => a.includes(lq));
      if (!inLabel && !inCommon && !inAlias) return;
      const starts = lbl.startsWith(lq) || com.startsWith(lq) || ali.some(a => a.startsWith(lq));
      scored.push({ t, starts, len: t.label.length });
    });
    scored.sort((a, b) => {
      if (a.starts !== b.starts) return a.starts ? -1 : 1;
      return a.len - b.len;
    });
    return scored.slice(0, limit).map(x => x.t);
  }
  window.tagsLib = api;

  // ── load / save ──────────────────────────────────────────────────────────
  async function loadTags() {
    let raw = null;
    try { const r = await fetch('tags.json?t=' + Date.now()); if (r.ok) raw = await r.json(); } catch (e) {}
    if (!raw) {
      try { const ls = localStorage.getItem('sal-tags'); if (ls) raw = JSON.parse(ls); } catch (e) {}
    }
    if (!raw || !Array.isArray(raw) || raw.length === 0) {
      raw = seedDictionary();
    }
    if (raw[0] && raw[0]._salMeta) {
      tagsMeta = raw[0];
      tagsArr = raw.slice(1);
    } else {
      tagsMeta = { _salMeta: true, _tagsVersion: 1 };
      tagsArr = raw.slice();
    }
    // Normalize
    tagsArr.forEach(t => {
      if (!Array.isArray(t.parents)) t.parents = t.parents ? [t.parents] : [];
      if (!Array.isArray(t.aliases)) t.aliases = [];
      if (t.formerly != null && !Array.isArray(t.formerly)) t.formerly = [String(t.formerly)];
      // (dev1148) `def` → `facts1`. Done here, in the app, not by a script on
      // tags.json: an open tab's next saveTags() would write the old shape back.
      // Disk keeps `def` until the next save, so this runs on every load until
      // then — harmless, it finds nothing left to move the second time.
      if (t.def != null) {
        const d = plainToHtml(t.def);
        if (d) t.facts1 = (t.facts1 && !isBlankHtml(t.facts1)) ? (t.facts1.includes(d) ? t.facts1 : t.facts1 + d) : d;
        delete t.def;
      }
    });
    if (tagsMeta && Array.isArray(tagsMeta._salColOrder)) {
      const co = tagsMeta._salColOrder.map(c => c === 'def' ? 'facts1' : c);
      let at = co.indexOf('facts1');
      if (at < 0) { co.push('facts1'); at = co.length - 1; }
      TEXT_FIELDS.slice(1).forEach(f => { if (!co.includes(f)) co.splice(++at, 0, f); });
      tagsMeta._salColOrder = co;
      const w = tagsMeta._salColWidths;
      if (w && w.def != null) { if (w.facts1 == null) w.facts1 = w.def; delete w.def; }
    }
    buildIndex();
  }

  // Bulk operations call updateTag once per row and every updateTag saves, so
  // one Apply of 27 changes fired 27 overlapping writes of the same file —
  // writeFileToDisk is async and no caller awaits it, so they raced. Wrap a bulk
  // operation in withBatchedSave and it writes once, at the end.
  let _saveDepth = 0, _savePending = false;
  function withBatchedSave(fn) {
    _saveDepth++;
    try { return fn(); }
    finally {
      _saveDepth--;
      if (!_saveDepth && _savePending) { _savePending = false; saveTags(); }
    }
  }

  async function saveTags() {
    if (_saveDepth) { _savePending = true; return; }
    const payload = [tagsMeta || { _salMeta: true, _tagsVersion: 1 }].concat(tagsArr);
    try { localStorage.setItem('sal-tags', JSON.stringify(payload)); } catch (e) {}
    if (typeof writeFileToDisk === 'function') {
      try { await writeFileToDisk('tags.json', payload); } catch (e) {}
    }
  }

  function buildIndex() {
    byId.clear();
    aliasToId.clear();
    orphanTags = [];
    tagsArr.forEach(t => { if (t.id) byId.set(t.id, t); });
    tagsArr.forEach(t => {
      if (t.label) aliasToId.set(t.label.toLowerCase().trim(), t.id);
      if (t.common) aliasToId.set(t.common.toLowerCase().trim(), t.id);
      (t.aliases || []).concat(t.formerly || []).forEach(a => {
        const k = String(a).toLowerCase().trim();
        if (k) aliasToId.set(k, t.id);
      });
    });
    // Find orphans (tags on records that don't exist in dictionary)
    const seen = new Set();
    if (typeof data !== 'undefined' && Array.isArray(data)) {
      data.forEach(r => {
        // Guard against rows whose `tags` field isn't an array (a stray string,
        // object, etc. from older imports). `("foo" || []).forEach` throws, and
        // since buildIndex runs inside createTag/updateTag, that TypeError aborted
        // the entire GBIF "Apply All" — the apply appeared to do nothing.
        if (!Array.isArray(r.tags)) return;
        r.tags.forEach(id => {
          if (!byId.has(id) && !seen.has(id)) { seen.add(id); orphanTags.push(id); }
        });
      });
    }
  }

  // ── resolve free-text input to a tag id (or null) ────────────────────────
  function resolveInput(str) {
    if (!str) return null;
    const k = String(str).toLowerCase().trim();
    // exact id match
    if (byId.has(k)) return k;
    // alias/label match
    if (aliasToId.has(k)) return aliasToId.get(k);
    return null;
  }

  function slugify(str) {
    return String(str).toLowerCase().trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  // Strip taxonomic authorship from a scientific name, leaving the clean
  // canonical Latin name. GBIF's `scientificName` carries author + year — e.g.
  // "Lybia tessellata (Latreille, 1812)" — and that comma is poison: the
  // Dictionary aliases field is comma-separated (split on save), so an author
  // comma re-splits one alias into junk fragments ("…(Latreille" + "1812)").
  // Common-name aliases (no year, no "(Author") pass through untouched.
  // Returns '' for pure authorship fragments (e.g. "1812)") so callers drop them.
  function stripAuthorship(name) {
    const s = String(name || '').trim();
    if (!s) return '';
    if (!/\d{4}/.test(s) && !/\([A-Z]/.test(s)) return s;   // not a sci-name-with-author
    // Leading Latin name: Genus + 1–2 lowercase epithets (species / subspecies).
    const m = s.match(/^[A-Z][a-zë-]+(?:\s+[a-zë-]+){1,2}/);
    return m ? m[0].trim() : '';
  }

  // Enforce the alias-field invariant: aliases NEVER contain commas (the field's
  // own separator). Strip authorship, replace any remaining comma with a space,
  // collapse whitespace, drop empties, dedupe case-insensitively. Applied at
  // every write point so the comma-separated editor round-trips losslessly.
  function cleanAliasList(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [], seen = new Set();
    arr.forEach(a => {
      let s = stripAuthorship(a).replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
      if (!s) return;
      const lc = s.toLowerCase();
      if (seen.has(lc)) return;
      seen.add(lc);
      out.push(s);
    });
    return out;
  }

  // (dev1116) Keep `formerly` clean: same comma rule as aliases, never the
  // label itself, and a name listed there is not ALSO an alias (moving it to
  // Formerly takes it out of Aliases). An empty list is dropped from the record.
  function tidyFormerly(rec) {
    if (!rec) return;
    const lbl = String(rec.label || '').toLowerCase().trim();
    const f = cleanAliasList(rec.formerly).filter(s => s.toLowerCase() !== lbl);
    if (!f.length) { delete rec.formerly; return; }
    rec.formerly = f;
    const fl = new Set(f.map(s => s.toLowerCase()));
    rec.aliases = (rec.aliases || []).filter(a => !fl.has(String(a).toLowerCase().trim()));
  }

  // (dev1116) Record `name` as a former name of tag `id` (used when a taxon is
  // renamed to the accepted name). No-op when it is blank or already the label.
  function addFormerly(id, name) {
    const t = byId.get(id);
    const s = stripAuthorship(name);
    if (!t || !s) return;
    updateTag(id, { formerly: (t.formerly || []).concat([s]) });
  }

  // ── graph operations ─────────────────────────────────────────────────────
  function tagAncestors(id) {
    // Returns Set of all ancestor IDs (NOT including self)
    const out = new Set();
    const stack = [id];
    const seen = new Set([id]);
    while (stack.length) {
      const cur = stack.pop();
      const t = byId.get(cur);
      if (!t) continue;
      (t.parents || []).forEach(p => {
        if (!seen.has(p)) { seen.add(p); out.add(p); stack.push(p); }
      });
    }
    return out;
  }

  // tagAncestors answers "is X above me?" but throws the route away, which is
  // fine for filtering and useless for display. tagLineagePaths keeps the route:
  // an array of paths, each ordered rootmost → immediate parent. A taxon wired
  // to an ecology group has two parents and so yields two paths — that is the
  // point, since filtering can travel either one.
  function tagLineagePaths(id, maxPaths) {
    maxPaths = maxPaths || 6;
    const out = [];
    (function walk(cur, trail, onTrail) {
      if (out.length >= maxPaths) return;
      const t = byId.get(cur);
      const parents = (t && t.parents || []).filter(x => byId.has(x) && !onTrail.has(x));
      if (!parents.length) {
        if (trail.length) out.push(trail.slice().reverse());
        return;
      }
      for (const x of parents) {
        if (out.length >= maxPaths) return;
        onTrail.add(x);
        walk(x, trail.concat(x), onTrail);
        onTrail.delete(x);
      }
    })(id, [], new Set([id]));
    return out;
  }

  // Flat "Life › Animalia › Mollusca …" string, for tooltips and toasts.
  function tagLineageString(id, sep) {
    const paths = tagLineagePaths(id, 2);
    if (!paths.length) return '';
    return paths.map(pp => pp.map(labelFor).join(sep || ' › ')).join('   |   ');
  }

  function tagDescendants(id) {
    // Returns Set of all descendant IDs (NOT including self)
    // Build parent→children index lazily (on demand; cheap at dict sizes)
    const children = new Map();
    tagsArr.forEach(t => {
      (t.parents || []).forEach(p => {
        if (!children.has(p)) children.set(p, []);
        children.get(p).push(t.id);
      });
    });
    const out = new Set();
    const stack = [id];
    const seen = new Set([id]);
    while (stack.length) {
      const cur = stack.pop();
      (children.get(cur) || []).forEach(c => {
        if (!seen.has(c)) { seen.add(c); out.add(c); stack.push(c); }
      });
    }
    return out;
  }

  function expandWithAncestors(ids) {
    // Given a list of tag IDs, return the set of those IDs plus all ancestors.
    // This is the "effective" tag set — what this record "has" at any rank.
    const out = new Set();
    ids.forEach(id => {
      if (!id) return;
      out.add(id);
      tagAncestors(id).forEach(a => out.add(a));
    });
    return out;
  }

  // ── record matching against a query tag id ───────────────────────────────
  // A record matches query id Q if any of the record's tag IDs equals Q
  // OR has Q as an ancestor. I.e. expand(record.tags) contains Q.
  function recordMatchesTagQuery(recordTagIds, queryTagId) {
    if (!queryTagId) return true;
    if (!Array.isArray(recordTagIds) || !recordTagIds.length) return false;
    const eff = expandWithAncestors(recordTagIds);
    return eff.has(queryTagId);
  }

  // ── Label formatting for scientific/taxonomic names ─────────────────────
  // Rule: uppercase the first character only. Preserves the rest.
  // This gives correct binomial form: "hymenopus coronatus" → "Hymenopus coronatus"
  // (the specific epithet stays lowercase). Also correct for single-word names
  // ("caprellidae" → "Caprellidae") and sentence-case common names.
  function formatTagLabel(str) {
    const s = String(str || '').trim();
    if (!s) return '';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // Guess the rank of a scientific name based on its ending or word pattern.
  // Returns { kind, rank } or null if no confident guess.
  // Conservative by design — false positives (calling common names taxa) are
  // worse than false negatives (missed species). User can set rank/kind
  // manually in the Dictionary when auto-detection declines to guess.
  function guessTaxonShape(label) {
    const s = String(label || '').trim();
    if (!s) return null;
    // Binomial: exactly two words, both lowercase (pre-format) or
    // "Genus species" (post-format) — accept either, since we format the
    // label before guessing. Genus must be at least 4 chars to reduce
    // false positives on short common-name phrases ("at home", "on top").
    if (/^[A-Z][a-z]{3,}\s+[a-z]+$/.test(s)) return { kind: 'taxon', rank: 'species' };
    // Three-word common names like "walking flower mantis" or "giant sea bass"
    // look like trinomials too often to auto-guess safely — skip.
    // Single word with distinctive taxonomic endings.
    // These endings are rarely ambiguous with English words, so allow short stems.
    if (/^[A-Z][a-z]+aceae$/.test(s))   return { kind: 'taxon', rank: 'family' };      // plants
    if (/^[A-Z][a-z]+idae$/.test(s))    return { kind: 'taxon', rank: 'family' };      // animals
    if (/^[A-Z][a-z]+inae$/.test(s))    return { kind: 'taxon', rank: 'subfamily' };
    if (/^[A-Z][a-z]+oidea$/.test(s))   return { kind: 'taxon', rank: 'superfamily' };
    if (/^[A-Z][a-z]+formes$/.test(s))  return { kind: 'taxon', rank: 'order' };       // birds/fish
    if (/^[A-Z][a-z]+ales$/.test(s))    return { kind: 'taxon', rank: 'order' };       // plants
    return null;
  }

  // ── CRUD on dictionary ───────────────────────────────────────────────────
  // A taxon has exactly one place in the tree of life, so it keeps at most ONE
  // parent of kind taxon/root. Ecology groups ("fish", "crustacean") are a
  // different axis — they cut across clades — so they are additional and
  // unlimited.
  //
  // The old rule was blunter: taxon ⇒ parents.length <= 1, enforced by
  // truncating to parents[0]. Every group-wiring call built its patch as
  // [...existingParents, groupId], so the truncation threw the group away and
  // kept whatever was already there. The Ecology panel toasted "✓ wired N",
  // saved nothing, and re-rendered every class as still unwired — which is why
  // all eight group tags sat at zero children. Same for the class → group
  // auto-wire inside applyChainImport.
  function enforceParentRule(rec) {
    if (!rec || rec.kind !== 'taxon') return;
    const hier = [], cross = [];
    (rec.parents || []).filter(Boolean).forEach(x => {
      const pt = byId.get(x);
      // An unknown parent counts as hierarchical: it is nearly always a taxon
      // that hasn't been created yet, and dropping it would lose data.
      if (!pt || pt.kind === 'taxon' || pt.kind === 'root') hier.push(x);
      else cross.push(x);
    });
    rec.parents = (hier.length ? [hier[0]] : []).concat(cross);
  }

  function createTag(partial) {
    const label = formatTagLabel(partial.label || '');
    if (!label) return { ok: false, err: 'label required' };
    let id = partial.id ? slugify(partial.id) : slugify(label);
    if (!id || !SLUG_RE.test(id)) return { ok: false, err: 'bad id: ' + id };
    if (byId.has(id)) return { ok: false, err: 'id exists: ' + id };

    // If caller didn't specify kind, try to guess from label shape.
    // Explicit kind (including 'topic') is respected — only `undefined`/empty
    // kind triggers the guess. This lets the chip input's "create new tag"
    // flow (which passes no kind) get smart defaults while keeping user
    // intent sovereign when they've chosen something.
    let kind = partial.kind;
    let rank = partial.rank;
    if (!kind && !rank) {
      const guess = guessTaxonShape(label);
      if (guess) {
        kind = guess.kind;
        rank = guess.rank;
      }
    }

    const rec = {
      id,
      label,
      kind: kind || 'topic',
      parents: Array.isArray(partial.parents) ? partial.parents.filter(Boolean) : [],
      aliases: cleanAliasList(partial.aliases),
    };
    // (dev1148) `def` still accepted from older callers; it lands as facts1.
    const f1 = partial.facts1 || plainToHtml(partial.def);
    if (f1) rec.facts1 = f1;
    TEXT_FIELDS.slice(1).forEach(f => { if (partial[f]) rec[f] = partial[f]; });
    if (rank) rec.rank = rank;
    if (partial.common) rec.common = formatTagLabel(partial.common);
    if (partial.extinct) rec.extinct = true;
    if (Array.isArray(partial.formerly)) { rec.formerly = partial.formerly; tidyFormerly(rec); }
    enforceParentRule(rec);
    tagsArr.push(rec);
    buildIndex();
    saveTags();
    return { ok: true, id, guessed: (rank && !partial.kind) ? { kind: rec.kind, rank } : null };
  }

  function updateTag(id, patch) {
    const t = byId.get(id);
    if (!t) return { ok: false, err: 'not found' };
    Object.keys(patch).forEach(k => {
      if (k === 'id') return;              // immutable
      if (k === 'parents' && Array.isArray(patch.parents)) {
        t.parents = patch.parents.filter(Boolean);
      } else if (k === 'aliases' && Array.isArray(patch.aliases)) {
        t.aliases = cleanAliasList(patch.aliases);
      } else if (k === 'formerly') {
        t.formerly = Array.isArray(patch.formerly) ? patch.formerly : [];
      } else {
        t[k] = patch[k];
      }
    });
    // Run after every key is applied — `kind` may have changed in this patch,
    // and a new label or new aliases change what Formerly may hold.
    if (t.formerly) tidyFormerly(t);
    enforceParentRule(t);
    buildIndex();
    saveTags();
    return { ok: true };
  }

  function deleteTag(id) {
    const i = tagsArr.findIndex(t => t.id === id);
    if (i < 0) return { ok: false, err: 'not found' };
    // Remove from any child parents list
    tagsArr.forEach(t => {
      if ((t.parents || []).includes(id)) t.parents = t.parents.filter(p => p !== id);
    });
    tagsArr.splice(i, 1);
    // Remove from any record
    let dataChanges = 0;
    if (typeof data !== 'undefined' && Array.isArray(data)) {
      data.forEach(r => {
        if (Array.isArray(r.tags) && r.tags.includes(id)) {
          r.tags = r.tags.filter(x => x !== id);
          dataChanges++;
        }
      });
      if (dataChanges && typeof save === 'function') save();
    }
    buildIndex();
    saveTags();
    return { ok: true, removedFromRecords: dataChanges };
  }

  // ── mergeTag(fromId, toId) ───────────────────────────────────────────────
  // Merges `from` into `to`:
  //   - every record tagged `from` becomes tagged `to` (dedup if already there)
  //   - `from`'s label + common + aliases become aliases of `to`
  //   - `from`'s children re-point their parent to `to`
  //   - `from`'s common, facts1-3, NameOrigin, NameSay copied to `to` if `to` lacks them
  //   - `from` is then deleted
  // Refuses if toId is a descendant of fromId (would create a cycle).
  // (dev1116) opts.asFormerly: `from` is an out-of-date name for `to`, so its
  // label goes to `to`'s Formerly list instead of its aliases. Either way any
  // Formerly names `from` already had stay Formerly on `to`.
  function mergeTag(fromId, toId, opts) {
    opts = opts || {};
    if (fromId === toId) return { ok: false, err: 'cannot merge a tag into itself' };
    const from = byId.get(fromId);
    const to   = byId.get(toId);
    if (!from) return { ok: false, err: 'source tag not found' };
    if (!to)   return { ok: false, err: 'target tag not found' };
    if (tagDescendants(fromId).has(toId)) {
      return { ok: false, err: 'target is a descendant of source — would create a cycle' };
    }

    // 1. Merge aliases (label + common + aliases of source → aliases of target)
    const existingLc = new Set([
      to.label, to.common || '', ...(to.aliases || [])
    ].map(s => String(s).toLowerCase().trim()).filter(Boolean));
    const toAdd = [opts.asFormerly ? '' : from.label, from.common || '', ...(from.aliases || [])]
      .filter(Boolean);
    const mergedAliases = [...(to.aliases || [])];
    let aliasesAdded = 0;
    toAdd.forEach(a => {
      const lc = String(a).toLowerCase().trim();
      if (lc && !existingLc.has(lc)) {
        mergedAliases.push(a);
        existingLc.add(lc);
        aliasesAdded++;
      }
    });
    to.aliases = cleanAliasList(mergedAliases);
    const formerly = (to.formerly || []).concat(from.formerly || [], opts.asFormerly ? [from.label] : []);
    if (formerly.length) { to.formerly = formerly; tidyFormerly(to); }

    // 2. Fill in common + the prose fields on target if missing
    if (!to.common && from.common) to.common = from.common;
    TEXT_FIELDS.forEach(f => {
      if ((!to[f] || isBlankHtml(to[f])) && from[f] && !isBlankHtml(from[f])) {
        to[f] = from[f];
        if (from[f + 'Edited']) to[f + 'Edited'] = true;     // (dev1152) Phil's own name text stays his
      }
    });

    // 3. Re-point children: any tag whose parents include fromId → toId
    let childrenMoved = 0;
    tagsArr.forEach(t => {
      if (t.id === fromId) return;
      if ((t.parents || []).includes(fromId)) {
        const repointed = t.parents.map(p => p === fromId ? toId : p);
        // Dedup in case target was already a parent
        t.parents = [...new Set(repointed)];
        // Taxon rule: single parent — if somehow >1, keep the target
        if (t.kind === 'taxon' && t.parents.length > 1) t.parents = [toId];
        childrenMoved++;
      }
    });

    // 4. Re-tag records: any record with fromId → replace with toId (dedup)
    const nowStr = (typeof isoNow === 'function')
      ? isoNow()
      : new Date().toISOString().replace('T',' ').slice(0,19);
    let recordsChanged = 0;
    if (typeof data !== 'undefined' && Array.isArray(data)) {
      data.forEach(r => {
        if (!Array.isArray(r.tags)) return;
        if (r.tags.includes(fromId)) {
          const kept = r.tags.filter(t => t !== fromId);
          if (!kept.includes(toId)) kept.push(toId);
          r.tags = kept;
          r.DateModified = nowStr;
          recordsChanged++;
        }
      });
      if (recordsChanged && typeof save === 'function') save();
    }

    // 5. Delete the source tag
    const i = tagsArr.findIndex(t => t.id === fromId);
    if (i >= 0) tagsArr.splice(i, 1);

    buildIndex();
    saveTags();
    return { ok: true, recordsChanged, childrenMoved, aliasesAdded };
  }

  // ── rendering helpers ────────────────────────────────────────────────────
  function labelFor(id) {
    const t = byId.get(id);
    // A blank label renders as an invisible chip / an empty crumb. The 'life'
    // root has one, which is how the whole tree of life came to be represented
    // on screen by a chip with nothing written on it. Fall back to the id.
    return (t && t.label) ? t.label : id;
  }

  function kindColor(t) {
    if (!t) return '#777';
    if (t.kind === 'taxon') {
      const rank = (t.rank || '').toLowerCase();
      if (rank === 'kingdom' || rank === 'root') return '#8ef';
      if (rank === 'phylum' || rank === 'subphylum') return '#4af';
      if (rank === 'class' || rank === 'order') return '#6ad';
      if (rank === 'family')  return '#8cf';
      if (rank === 'genus')   return '#cae';
      if (rank === 'species') return '#fa8';
      return '#8ac';
    }
    if (t.kind === 'topic')     return '#afa';
    if (t.kind === 'technique') return '#fc8';
    if (t.kind === 'place')     return '#fca';
    if (t.kind === 'root')      return '#8ef';
    if (t.kind === 'group')     return '#fc8';
    return '#ccc';
  }

  function chipHtml(id, opts) {
    opts = opts || {};
    const t = byId.get(id);
    const label = labelFor(id);
    const color = kindColor(t);
    // Hovering a chip is the cheapest place to answer "what is this filed
    // under?", so the tooltip carries the whole path, not just the rank.
    let title;
    if (!t) {
      title = '⚠ orphan: ' + id;
    } else {
      title = (t.kind === 'taxon' && t.rank ? t.rank + ' · ' + label : (t.kind + ' · ' + label))
        + (t.common ? ' (' + t.common + ')' : '');
      const lin = tagLineageString(id);
      if (lin) title += '\n↑ ' + lin;
    }
    const missing = !t;
    const bg = missing ? 'rgba(255,80,80,0.15)' : 'rgba(255,255,255,0.05)';
    const bd = missing ? '#f66' : color;
    const removeBtn = opts.removable
      ? '<span class="tag-chip-x" data-tag-id="' + id + '" style="margin-left:4px;cursor:pointer;opacity:0.7;">×</span>'
      : '';

    // Dual-display for taxa with both common + scientific name:
    //   "Orchid mantis · Hymenopus coronatus"
    // Common name in normal weight, scientific italicized in muted color.
    // Sorting is unaffected — the underlying tag id stays canonical.
    // (dev0930) SPANISH. Both helpers return '' unless the viewer has actually
    // switched to Spanish AND tags.es.json has an entry, so in English — and on
    // every dev screen — this block is a no-op and the chips are byte-identical
    // to before.
    //
    // The SCIENTIFIC name is never touched. A binomial is the same in every
    // language; "translating" one would be a straight error, and it is the half
    // of the chip a Spanish reader can already use.
    const _esCommon = (window.salTagsEs && window.salTagsEs.common(id)) || '';
    const _esLabel  = (window.salTagsEs && window.salTagsEs.label(id))  || '';

    let inner;
    const _common = _esCommon || t && t.common;
    if (!missing && t.kind === 'taxon' && _common && _common !== t.label) {
      inner = escapeHtml(_common)
        + ' <span style="color:#fff;font-style:italic;font-weight:normal;margin-left:3px;">' + escapeHtml(t.label) + '</span>';
    } else {
      inner = escapeHtml(_esLabel || label);
    }

    return '<span class="tag-chip" data-tag-id="' + id + '" title="' + escapeAttr(title) + '" style="'
      + 'display:inline-flex;align-items:center;padding:1px 6px;margin:1px 3px 1px 0;'
      + 'background:' + bg + ';border:1px solid ' + bd + ';border-radius:10px;'
      + 'font-size:11px;color:' + (missing ? '#f88' : color) + ';font-family:monospace;white-space:nowrap;">'
      + inner + removeBtn + '</span>';
  }

  function renderChipsForRecord(record) {
    const ids = recordTagIds(record);
    if (!ids.length) return '';
    return ids.map(id => chipHtml(id)).join('');
  }

  function recordTagIds(record) {
    if (!record) return [];
    return Array.isArray(record.tags) ? record.tags.slice() : [];
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
  }

  // ── tag chip input component ─────────────────────────────────────────────
  // Usage: mountTagChipInput({ container, getIds, setIds, onChange, placeholder })
  //   container: DOM element to render into (replaces its contents)
  //   getIds:    function() -> array of current tag ids
  //   setIds:    function(newIds) -> void (caller persists)
  //   placeholder: text for empty input
  window.mountTagChipInput = function (opts) {
    const container = opts.container;
    if (!container) return;
    container.innerHTML = '';
    container.classList.add('tag-chip-input');
    container.style.cssText = (container.style.cssText || '') +
      ';display:flex;flex-wrap:wrap;align-items:center;gap:3px;min-height:34px;'
      + 'padding:4px 6px;background:#0a0a1a;border:1px solid #6af;border-radius:5px;'
      + 'font-family:monospace;font-size:12px;cursor:text;';

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:3px;flex:1;min-width:0;';
    container.appendChild(wrap);

    const input = document.createElement('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = opts.placeholder || 'add tag…';
    input.style.cssText = 'flex:1;min-width:100px;background:transparent;border:none;color:#fff;'
      + 'font-family:monospace;font-size:12px;outline:none;padding:3px 2px;';

    let dd = null;
    let ddIdx = -1;

    function render() {
      // Clear chip area but keep input
      [...wrap.querySelectorAll('.tag-chip')].forEach(n => n.remove());
      const ids = (opts.getIds && opts.getIds()) || [];
      ids.forEach(id => {
        const span = document.createElement('span');
        span.className = 'tag-chip';
        span.dataset.tagId = id;
        const t = byId.get(id);
        const label = labelFor(id);
        const color = kindColor(t);
        const missing = !t;
        span.title = t
          ? (t.kind === 'taxon' && t.rank ? t.rank + ' · ' + label : (t.kind + ' · ' + label)) + (t.common ? ' (' + t.common + ')' : '')
            + ((t.formerly || []).length ? ' — formerly ' + t.formerly.join(', ') : '')
          : '⚠ orphan tag: ' + id;
        span.style.cssText = 'display:inline-flex;align-items:center;padding:2px 6px;'
          + 'background:' + (missing ? 'rgba(255,80,80,0.15)' : 'rgba(255,255,255,0.05)') + ';'
          + 'border:1px solid ' + (missing ? '#f66' : color) + ';border-radius:10px;'
          + 'font-size:11px;color:' + (missing ? '#f88' : color) + ';white-space:nowrap;cursor:pointer;';
        // Dual-display: common name + italic scientific for taxa with both
        let inner;
        if (!missing && t.kind === 'taxon' && t.common && t.common !== t.label) {
          inner = escapeHtml(t.common)
            + ' <span style="color:#fff;font-style:italic;font-weight:normal;margin-left:3px;">' + escapeHtml(t.label) + '</span>';
        } else {
          inner = escapeHtml(label);
        }
        span.innerHTML = inner + '<span class="chip-x" title="Remove from this row" style="margin-left:5px;cursor:pointer;opacity:0.6;font-weight:bold;">×</span>';
        span.querySelector('.chip-x').addEventListener('click', (e) => {
          e.stopPropagation();
          removeTag(id);
        });
        // Click chip body (not ×) → open Dictionary on this tag.
        // From there you can hit GBIF, edit, merge, etc.
        span.addEventListener('click', (e) => {
          if (e.target.classList && e.target.classList.contains('chip-x')) return;
          e.stopPropagation();
          openDictForTag(id);
        });
        // Right-click → context menu (Dictionary / GBIF / Remove)
        span.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openChipContextMenu(e.clientX, e.clientY, id, () => removeTag(id));
        });
        wrap.insertBefore(span, input);
      });
    }

    function removeTag(id) {
      const ids = (opts.getIds && opts.getIds()) || [];
      const next = ids.filter(x => x !== id);
      opts.setIds && opts.setIds(next);
      if (opts.onChange) opts.onChange(next);
      render();
      input.focus();
    }

    function addTag(id) {
      const ids = (opts.getIds && opts.getIds()) || [];
      if (ids.includes(id)) return;
      const next = ids.concat([id]);
      opts.setIds && opts.setIds(next);
      if (opts.onChange) opts.onChange(next);
      render();
    }

    function closeDd() {
      if (dd) { dd.remove(); dd = null; ddIdx = -1; }
    }

    // (dev1115) opts.autoCheckTaxonomy: a NEW tag typed as exactly two words
    // (a binomial, e.g. "Pleuroncodes planipes") goes straight to the
    // Dictionary with 🔎 Check taxonomy running — the R-click → Check taxonomy
    // steps done for you. A two-word common name lands there too; Esc leaves.
    function afterCreate(id, typed) {
      if (!opts.autoCheckTaxonomy) return;
      if (String(typed || '').trim().split(/\s+/).length !== 2) return;
      checkTaxonomyForTag(id);
    }

    function showDd() {
      closeDd();
      const q = input.value.trim().toLowerCase();
      const currentIds = new Set((opts.getIds && opts.getIds()) || []);

      // Build matches: for each tag, check label + aliases + common name
      const matches = [];
      tagsArr.forEach(t => {
        if (currentIds.has(t.id)) return;
        if (opts.filter && !opts.filter(t.id)) return;  // caller-supplied filter
        // Build haystacks tagged by source field. Field rank: 0 = label/common
        // (canonical), 1 = alias (often a descriptive phrase). Within a match
        // tier (score), canonical fields beat aliases, then shorter beats
        // longer — so typing "sw" finds "Swimming" (label, 8 chars) before
        // "swimming sea cucumber" (alias, 21 chars).
        const haystacks = [];
        if (t.label)  haystacks.push({ s: t.label.toLowerCase(),  field: 0 });
        if (t.common) haystacks.push({ s: t.common.toLowerCase(), field: 0 });
        (t.aliases || []).forEach(a => {
          if (a) haystacks.push({ s: String(a).toLowerCase(), field: 1 });
        });
        (t.formerly || []).forEach(a => {
          if (a) haystacks.push({ s: String(a).toLowerCase(), field: 1, formerly: true });
        });
        // Also search the tag's id (dashes → spaces). A tag can have an id like
        // "halichoeres-burekae" whose label/common/aliases don't literally spell
        // out the scientific name (e.g. label is a common name). Without this,
        // typing "halichoeres burekae" found nothing yet createTag rejected it as
        // "id exists" — the match list and the create-check disagreed. Field 1
        // (alias-tier) so canonical label/common still win ties.
        if (t.id) {
          haystacks.push({ s: String(t.id).toLowerCase(), field: 1 });
          const idWords = String(t.id).toLowerCase().replace(/-/g, ' ');
          if (idWords !== String(t.id).toLowerCase()) haystacks.push({ s: idWords, field: 1 });
        }
        if (!q) {
          // Empty query: show root-level and recently-used (first 40)
          if (matches.length < 40) matches.push({ t, via: t.label.toLowerCase(), score: -1, field: 0, len: t.label.length });
          return;
        }
        // Find the BEST haystack for this tag (lowest score; ties broken by
        // field then length).
        let best = null;
        for (const h of haystacks) {
          let s;
          if (h.s === q)              s = 0;
          else if (h.s.startsWith(q)) s = 1;
          else if (h.s.includes(q))   s = 2;
          else continue;
          const cand = { score: s, field: h.field, len: h.s.length, via: h.s, formerly: !!h.formerly };
          if (!best
              || cand.score < best.score
              || (cand.score === best.score && cand.field < best.field)
              || (cand.score === best.score && cand.field === best.field && cand.len < best.len)) {
            best = cand;
          }
        }
        if (best) matches.push({ t, ...best });
      });

      // Sort: 1) score (exact > prefix > substring),
      //       2) field (canonical > alias),
      //       3) haystack length (shorter first — favors plain words over phrases),
      //       4) alphabetical by label.
      matches.sort((a, b) =>
        a.score - b.score
        || a.field - b.field
        || a.len - b.len
        || a.t.label.localeCompare(b.t.label));
      const top = matches.slice(0, 30);

      // "Create new" offer if no exact match and user typed something.
      // Guard against the id-collision case: if the typed text slugifies to an
      // id that already exists, don't offer "Create new" (createTag would reject
      // it as "id exists"). The id-haystack above should surface that tag in the
      // list; this is a belt-and-suspenders check so we never show a Create that
      // can't succeed.
      let showCreate = false;
      if (q && !matches.some(m => m.score === 0) && !byId.has(slugify(q))) showCreate = true;

      if (!top.length && !showCreate) return;

      dd = document.createElement('div');
      dd.className = 'tag-dd';
      dd.style.cssText = 'position:fixed;z-index:9999999;background:#14142a;border:1px solid #6af;'
        + 'border-radius:0 0 6px 6px;max-height:260px;overflow-y:auto;'
        + 'font-family:monospace;font-size:12px;box-shadow:0 4px 22px rgba(0,0,0,0.92);min-width:260px;';
      top.forEach((m, i) => {
        const item = document.createElement('div');
        item.className = 'tag-dd-item';
        item.dataset.idx = i;
        const t = m.t;
        const via = (m.via && m.via !== t.label.toLowerCase())
          ? (m.formerly
              ? ' <span style="color:#9a8;font-size:10px;">(formerly <i>' + escapeHtml(formatTagLabel(m.via)) + '</i>)</span>'
              : ' <span style="color:#666;font-size:10px;">(via "' + escapeHtml(m.via) + '")</span>')
          : '';
        const rankBadge = t.rank
          ? '<span style="color:#666;font-size:10px;margin-left:5px;">' + t.rank + '</span>'
          : (t.kind && t.kind !== 'taxon' ? '<span style="color:#666;font-size:10px;margin-left:5px;">' + t.kind + '</span>' : '');
        const parentLbl = (t.parents || [])
          .map(p => labelFor(p))
          .filter(Boolean)
          .slice(0, 2)
          .join(', ');
        const parentHtml = parentLbl ? '<span style="color:#555;font-size:10px;"> → ' + escapeHtml(parentLbl) + '</span>' : '';
        item.innerHTML = '<span style="color:' + kindColor(t) + ';">' + escapeHtml(labelFor(t.id)) + '</span>'
          + rankBadge + parentHtml + via;
        item.style.cssText = 'padding:5px 10px;cursor:pointer;border-bottom:1px solid #1a1a2e;';
        item.addEventListener('mouseenter', () => setDdIdx(i));
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          addTag(t.id);
          input.value = '';
          closeDd();
          input.focus();
        });
        dd.appendChild(item);
      });
      if (showCreate) {
        const ci = top.length;
        const item = document.createElement('div');
        item.className = 'tag-dd-item';
        item.dataset.idx = ci;
        item.innerHTML = '<span style="color:#ff8;">+ Create new tag:</span> <span style="color:#fff;">' + escapeHtml(q) + '</span>'
          + ' <span style="color:#555;font-size:10px;">(kind=topic, no parent)</span>';
        item.style.cssText = 'padding:6px 10px;cursor:pointer;border-top:1px solid #444;background:rgba(255,255,100,0.05);';
        item.addEventListener('mouseenter', () => setDdIdx(ci));
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const r = createTag({ label: q });  // let createTag guess kind/rank
          if (r.ok) {
            addTag(r.id);
            input.value = '';
            closeDd();
            input.focus();
            if (typeof toast === 'function') {
              const created = api.get(r.id);
              const guessNote = r.guessed
                ? '\n(auto-detected: ' + r.guessed.kind + (r.guessed.rank ? ' · ' + r.guessed.rank : '') + ' — edit in D)'
                : '\n(set kind/parent in Dictionary: D)';
              toast('Created new tag: ' + (created ? created.label : q) + guessNote, 1800);
            }
            afterCreate(r.id, q);
          } else {
            if (typeof toast === 'function') toast('Could not create: ' + r.err);
          }
        });
        dd.appendChild(item);
      }

      // Position below input
      const r = input.getBoundingClientRect();
      const cr = container.getBoundingClientRect();
      dd.style.left = cr.left + 'px';
      dd.style.top = (cr.bottom) + 'px';
      dd.style.width = Math.max(cr.width, 260) + 'px';
      document.body.appendChild(dd);
      ddIdx = top.length === 0 && showCreate ? 0 : -1;
      if (ddIdx >= 0) setDdIdx(ddIdx);
    }

    function setDdIdx(i) {
      ddIdx = i;
      if (!dd) return;
      [...dd.children].forEach((el, j) => {
        el.style.background = j === i ? '#1a3a6a' : '';
      });
    }

    function commitCurrent() {
      if (!dd) return false;
      if (ddIdx < 0) ddIdx = 0;
      const item = dd.children[ddIdx];
      if (!item) return false;
      // Synthesize mousedown to reuse its logic
      const ev = new MouseEvent('mousedown', { cancelable: true });
      item.dispatchEvent(ev);
      return true;
    }

    input.addEventListener('input', showDd);
    input.addEventListener('focus', showDd);
    input.addEventListener('blur', () => setTimeout(closeDd, 160));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!dd) { showDd(); return; }
        setDdIdx(Math.min(ddIdx + 1, dd.children.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setDdIdx(Math.max(ddIdx - 1, 0));
      } else if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',') {
        if (dd && ddIdx >= 0) {
          e.preventDefault();
          commitCurrent();
        } else if (input.value.trim()) {
          // Try to resolve typed value
          const id = resolveInput(input.value.trim());
          if (id) {
            e.preventDefault();
            addTag(id);
            input.value = '';
            closeDd();
          } else if (e.key !== 'Tab') {
            // Create new tag
            e.preventDefault();
            const typed = input.value.trim();
            const r = createTag({ label: typed });  // let createTag guess kind/rank
            if (r.ok) {
              addTag(r.id);
              input.value = '';
              closeDd();
              if (typeof toast === 'function') {
                const created = api.get(r.id);
                const guessNote = r.guessed
                  ? '\n(auto-detected: ' + r.guessed.kind + (r.guessed.rank ? ' · ' + r.guessed.rank : '') + ' — edit in D)'
                  : '\n(set kind/parent in Dictionary: D)';
                toast('Created new tag: ' + (created ? created.label : r.id) + guessNote, 1800);
              }
              afterCreate(r.id, typed);
            }
          }
        }
      } else if (e.key === 'Backspace' && !input.value) {
        // remove last chip
        const ids = (opts.getIds && opts.getIds()) || [];
        if (ids.length) { removeTag(ids[ids.length - 1]); }
      } else if (e.key === 'Escape') {
        closeDd();
      }
    });

    container.addEventListener('click', (e) => {
      if (e.target === container || e.target === wrap) input.focus();
    });

    wrap.appendChild(input);
    render();

    return {
      refresh: render,
      focus: () => input.focus(),
      destroy: () => { closeDd(); container.innerHTML = ''; }
    };
  };

  // ── dictionary overlay ───────────────────────────────────────────────────
  let dictOverlay = null;

  // Persisted state across open/close. Lets the user return to the same view,
  // search query, focused row, etc. after a quick trip to T or G.
  // Lives at module scope so it survives Dictionary close/reopen, but is reset
  // to defaults if the page reloads (intentional — reload should feel fresh).
  let _dictState = {
    viewMode: 'list',
    searchText: '',
    selectedId: null,
    keyboardFocusedId: null,
    expandedNodes: ['life','health','activity','other'],
    scrollTop: 0
  };

  // Open the Dictionary and select a specific tag in the right edit panel.
  // Used by chip clicks in Annotate/Video Editor — one click takes you from
  // a chip to the full editor (and from there one more click to GBIF, merge,
  // parents, etc.).
  function openDictForTag(tagId) {
    if (!byId.get(tagId)) {
      if (typeof toast === 'function') toast('Tag not found in dictionary', 1500);
      return;
    }
    // (zip0158) Force tree view when opening for a specific tag — the
    // tree puts the tag in its hierarchical context (parent → grandparent
    // up to a root) which is what users want when navigating from a chip
    // or from a focused T row. List view loses that context.
    _dictState.viewMode = 'tree';
    // Expand all ancestors so the tag is visible without manual clicks.
    const expanded = new Set(_dictState.expandedNodes || []);
    tagAncestors(tagId).forEach(a => expanded.add(a));
    _dictState.expandedNodes = [...expanded];

    // If Dictionary is already open, just select the tag inside it.
    if (dictOverlay && dictOverlay._selectTag) {
      dictOverlay._selectTag(tagId);
      // _selectTag handles scrolling-into-view; nothing else to do.
      return;
    }
    // Otherwise: pre-seed state and open. Persisted state from prior sessions
    // (search) is kept; selection/focus/viewMode/expansion just got refreshed.
    _dictState.selectedId = tagId;
    _dictState.keyboardFocusedId = tagId;
    if (typeof window.openDictionary === 'function') {
      window.openDictionary();
    }
  }
  // Expose for outside callers (e.g. the table chip-click in renderBody)
  window.openDictForTag = openDictForTag;

  // Open the Dictionary on a tag and press its 🔎 Check taxonomy button. Used by
  // the chip menu's "g" item and (dev1115) by a chip input with autoCheckTaxonomy.
  function checkTaxonomyForTag(tagId) {
    openDictForTag(tagId);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const btn = document.getElementById('de-gbif');
      if (btn) btn.click();
    }));
  }

  // (dev0575) The T-view chip right-click menu was removed: R-click now copies
  // the tag and Ctrl+R-click deletes it from the row directly (see core.js
  // renderBody). _buildChipMenu below still serves the Annotate panel's menu.

  // Internal: builds and shows the menu DOM. Shared by chip menus from the
  // Annotate panel (with "Remove from this row") and from the T view (with
  // "Annotate this row" / "Filter").
  function _buildChipMenu(x, y, t, items) {
    closeChipContextMenu();
    _chipMenu = document.createElement('div');
    _chipMenu.id = 'chipCtxMenu';
    // (zip0158) Tag this menu with the tag id so a second R-click on the
    // same chip can detect the open menu and close it without action.
    _chipMenu.dataset.forTag = t.id;
    _chipMenu.style.cssText = 'position:fixed;z-index:30000;background:#0d0d1e;'
      + 'border:1px solid #4af;border-radius:5px;box-shadow:0 6px 20px rgba(0,0,0,0.85);'
      + 'font-family:monospace;font-size:12px;color:#ddd;min-width:200px;'
      + 'padding:4px 0;left:' + x + 'px;top:' + y + 'px;';

    const hdr = document.createElement('div');
    hdr.style.cssText = 'padding:4px 12px;color:#8ef;font-size:11px;font-weight:bold;border-bottom:1px solid #1a1a2e;';
    hdr.textContent = t.label + (t.common ? ' · ' + t.common : '');
    _chipMenu.appendChild(hdr);

    items.forEach(item => {
      if (item.sep) {
        const sep = document.createElement('div');
        sep.style.cssText = 'border-top:1px solid #1a1a2e;margin:3px 0;';
        _chipMenu.appendChild(sep);
        return;
      }
      const r = document.createElement('div');
      r.dataset.key = item.key;
      const baseColor = item.warn ? '#f88' : '#cef';
      r.style.cssText = 'padding:6px 14px;cursor:pointer;color:' + baseColor + ';';
      r.innerHTML = item.labelHtml;
      r.addEventListener('mouseenter', () => r.style.background = item.warn ? 'rgba(255,80,80,0.18)' : 'rgba(100,170,255,0.18)');
      r.addEventListener('mouseleave', () => r.style.background = '');
      r.addEventListener('click', () => {
        closeChipContextMenu();
        item.action();
      });
      _chipMenu.appendChild(r);
    });

    document.body.appendChild(_chipMenu);

    const rect = _chipMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) _chipMenu.style.left = (window.innerWidth - rect.width - 6) + 'px';
    if (rect.bottom > window.innerHeight) _chipMenu.style.top = (window.innerHeight - rect.height - 6) + 'px';

    _chipMenu._docHandler = (e) => {
      if (_chipMenu && !_chipMenu.contains(e.target)) closeChipContextMenu();
    };
    setTimeout(() => {
      if (_chipMenu) document.addEventListener('mousedown', _chipMenu._docHandler, true);
    }, 0);

    _chipMenu._keyHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        closeChipContextMenu();
        return;
      }
      const k = e.key.toLowerCase();
      const it = items.find(x => !x.sep && x.key === k);
      if (it) {
        e.preventDefault(); e.stopPropagation();
        closeChipContextMenu();
        it.action();
      }
    };
    document.addEventListener('keydown', _chipMenu._keyHandler, true);
  }

  // Right-click context menu shown on a tag chip in Annotate / Video Editor.
  // Items: Open in Dictionary, Check GBIF (taxa only), Remove.
  let _chipMenu = null;
  // (zip0158) Side-channel stash for detecting "second R-click on the same
  // chip dismisses". The doc-level mousedown handler closes the menu before
  // contextmenu fires on the chip, so we record what was just closed and
  // for which tag, then check that on the next opener call.
  let _lastChipMenuClose = null;
  function closeChipContextMenu() {
    if (_chipMenu) {
      // Stash before tearing down
      const tagId = _chipMenu.dataset && _chipMenu.dataset.forTag;
      if (tagId) _lastChipMenuClose = { tagId: tagId, t: Date.now() };
      if (_chipMenu._docHandler) document.removeEventListener('mousedown', _chipMenu._docHandler, true);
      if (_chipMenu._keyHandler) document.removeEventListener('keydown', _chipMenu._keyHandler, true);
      _chipMenu.remove();
      _chipMenu = null;
    }
  }

  function openChipContextMenu(x, y, tagId, removeFn) {
    // (zip0158) Toggle behavior: a second R-click on the same chip within 300ms
    // closes the just-opened menu without action.
    const now = Date.now();
    if (_lastChipMenuClose
        && _lastChipMenuClose.tagId === tagId
        && (now - _lastChipMenuClose.t) < 300) {
      _lastChipMenuClose = null;
      return;
    }
    closeChipContextMenu();
    const t = byId.get(tagId);
    if (!t) return;

    const isTaxon = t.kind === 'taxon';

    const items = [
      {
        key: 'd',
        labelHtml: 'Open in <u>D</u>ictionary',
        action: () => openDictForTag(tagId)
      }
    ];
    // (mim0254) Offer Check GBIF for any kind. If the user runs GBIF on a
    // non-taxon tag and accepts a chain, applyChainImport promotes the tag to
    // kind=taxon — so this is the one-click "verify this is a taxon" path the
    // user asked for. The Dictionary edit panel will render the same button.
    items.push({
      key: 'g',
      labelHtml: isTaxon ? 'Check taxonomy (<u>g</u>)' : 'Check taxonomy (<u>g</u>) — verify as taxon',
      action: () => checkTaxonomyForTag(tagId)
    });
    items.push({ sep: true });
    items.push({
      key: 'r',
      labelHtml: '<u>R</u>emove from this row',
      action: () => { if (removeFn) removeFn(); },
      warn: true
    });

    _buildChipMenu(x, y, t, items);
  }

  window.openDictionary = function () {
    if (dictOverlay) return;
    // (dev0315) D (Dictionary) is dev-only — never render it on the public
    // site, regardless of how the call was reached.
    if (typeof _isUserMode === 'function' && _isUserMode()) return;

    // Inject one-time CSS for keyboard-focus highlight in the right edit panel.
    // Browser default :focus is often invisible on dark UIs; this makes the
    // currently-active text input/select pop visually.
    if (!document.getElementById('dictOverlayCSS')) {
      const css = document.createElement('style');
      css.id = 'dictOverlayCSS';
      css.textContent = `
        #dictEdit input:focus,
        #dictEdit select:focus,
        #dictEdit textarea:focus {
          outline: 2px solid #8ef !important;
          outline-offset: 1px;
          background: #102036 !important;
          border-color: #8ef !important;
        }
        #dictEdit button:focus {
          outline: 2px solid #8ef !important;
          outline-offset: 2px;
        }
        #dictSearch:focus {
          outline: 2px solid #8ef !important;
          outline-offset: 1px;
        }
        /* (zip0188) Bump D-screen font sizes by 1px across the board.
           Preserves the size hierarchy by mapping each level up by one. */
        #dictOverlay [style*="font-size:10px"] { font-size: 11px !important; }
        #dictOverlay [style*="font-size: 10px"] { font-size: 11px !important; }
        #dictOverlay [style*="font-size:11px"] { font-size: 12px !important; }
        #dictOverlay [style*="font-size: 11px"] { font-size: 12px !important; }
        #dictOverlay [style*="font-size:12px"] { font-size: 13px !important; }
        #dictOverlay [style*="font-size: 12px"] { font-size: 13px !important; }
        #dictOverlay [style*="font-size:13px"] { font-size: 14px !important; }
        #dictOverlay [style*="font-size: 13px"] { font-size: 14px !important; }
        #dictOverlay [style*="font-size:14px"] { font-size: 15px !important; }
        #dictOverlay [style*="font-size: 14px"] { font-size: 15px !important; }
      `;
      document.head.appendChild(css);
    }

    dictOverlay = document.createElement('div');
    dictOverlay.id = 'dictOverlay';
    dictOverlay.style.cssText = 'position:fixed;inset:0;z-index:29500;background:rgba(5,5,14,0.96);'
      + 'display:flex;flex-direction:column;font-family:monospace;color:#ddd;';
    dictOverlay.innerHTML = `
      <div style="padding:10px 14px;background:#0d0d1e;border-bottom:2px solid #4af;display:flex;align-items:center;gap:10px;flex-shrink:0;flex-wrap:wrap;">
        <span style="color:#8ef;font-size:14px;font-weight:bold;">📚 Tag Dictionary</span>
        <input id="dictSearch" type="text" placeholder="Search tags, aliases, definitions…" autocomplete="off"
          style="flex:1;max-width:360px;padding:5px 10px;background:#0a0a1a;border:1px solid #4af;color:#fff;border-radius:5px;font-family:monospace;font-size:12px;outline:none;">
        <span id="dictCount" style="color:#666;font-size:11px;"></span>
        <!-- (zip0158) Single toggle button replaces the two-button List/Tree
             segment. Default view is tree; clicking the button flips to the
             other view and updates the label. data-view stores the CURRENT
             mode so the click handler can flip it. -->
        <button id="view-toggle" class="dict-view-btn" data-view="tree"
                style="padding:5px 12px;background:rgba(100,170,255,0.25);color:#8ef;border:1px solid #666;border-radius:5px;cursor:pointer;font-family:monospace;font-size:11px;"
                title="Click to toggle between Tree and List views">🌳 Tree</button>
        <button id="dictAdd" style="padding:5px 12px;border:1px solid #5f5;background:rgba(0,80,0,0.4);color:#afa;border-radius:5px;cursor:pointer;font-family:monospace;font-size:12px;">+ New</button>
        <button id="dictEcology" title="Ecology groups — fish, bird, mammal, etc. — review which class taxa are wired under group tags so hierarchical filtering works"
          style="padding:5px 12px;border:1px solid #fc8;background:rgba(80,50,0,0.4);color:#fc8;border-radius:5px;cursor:pointer;font-family:monospace;font-size:12px;">🐟 Ecology Groups</button>
        <button id="dictNormalize" title="Check every kingdom, phylum and unplaced taxon against GBIF and propose a tidier top of the tree. Shows a plan first — nothing is written until you approve it."
          style="padding:5px 12px;border:1px solid #6c9;background:rgba(0,80,55,0.45);color:#8ec;border-radius:5px;cursor:pointer;font-family:monospace;font-size:12px;">🌳 Normalize tree</button>
        <button id="dictTaxonInfo" title="Taxon info (dev0847) — short Wikipedia notes, common names and IUCN status per taxon, kept in taxoninfo.json. Opens the review panel: see what has been fetched, fetch what is missing, and resolve names that several kingdoms share."
          style="padding:5px 12px;border:1px solid #9bd;background:rgba(20,45,90,0.5);color:#9bd;border-radius:5px;cursor:pointer;font-family:monospace;font-size:12px;">📖 Taxon info</button>
        <button id="dictFillNames" title="Fill Name origin and Name say on every taxon that has none yet. Name origin: WoRMS/GBIF + Wikidata (who named it, when) and Wiktionary (what the name means). Name say: only pronunciations Wikipedia or Wiktionary have published, in the ? respelling key. About 3–4 minutes for 600 taxa. Never touches one you have written or cleared. Opening a taxon looks its own two up again anyway (with Wikipedia sentences and the original name too) and saves them; R in D does it on demand."
          style="padding:5px 12px;border:1px solid #4af;background:rgba(0,40,100,0.35);color:#8ef;border-radius:5px;cursor:pointer;font-family:monospace;font-size:12px;">🔎 Fill names</button>
        <button id="dictClose" style="padding:5px 12px;border:1px solid #f66;background:rgba(80,0,0,0.4);color:#f88;border-radius:5px;cursor:pointer;font-family:monospace;font-size:12px;">✕ Close (Esc)</button>
      </div>
      <div style="flex:1;overflow:hidden;display:flex;min-height:0;">
        <div id="dictList" style="flex:1;overflow-y:auto;border-right:1px solid #333;min-width:300px;"></div>
        <div id="dictEdit" style="flex:1.3;padding:14px 18px;overflow-y:auto;min-width:320px;"></div>
      </div>
    `;
    document.body.appendChild(dictOverlay);

    const search = dictOverlay.querySelector('#dictSearch');
    const listEl = dictOverlay.querySelector('#dictList');
    const editEl = dictOverlay.querySelector('#dictEdit');
    const countEl = dictOverlay.querySelector('#dictCount');
    let selectedId = _dictState.selectedId;
    // Keyboard-navigation focus — the row currently highlighted by arrow keys.
    // Distinct from selectedId (which is what's loaded in the edit panel).
    let keyboardFocusedId = _dictState.keyboardFocusedId;
    let viewMode = _dictState.viewMode || 'tree';
    // Expanded tree nodes (ids) — default-expand the top roots
    const expandedNodes = new Set(_dictState.expandedNodes || ['life','health','activity','other']);
    // (dev1152) While the search box has text: ancestors of matches, open for
    // the search only, and the rows the filtered tree draws (null = all).
    let _searchOpen = new Set(), _searchShow = null;
    const _searchClosed = new Set();     // search-opened nodes closed by hand
    const isOpen = id => expandedNodes.has(id) || (_searchOpen.has(id) && !_searchClosed.has(id));
    const setOpen = (id, open) => {
      if (open) { expandedNodes.add(id); _searchClosed.delete(id); }
      else { expandedNodes.delete(id); _searchClosed.add(id); }
    };
    // Restore prior search text; renderView() picks it up
    if (_dictState.searchText) search.value = _dictState.searchText;
    // (zip0158) Sync the single view-toggle button label/state to the
    // current viewMode. data-view stores what mode is ACTIVE; the label
    // shows that mode (so clicking gives you the other one).
    const vbtn = dictOverlay.querySelector('#view-toggle');
    if (vbtn) {
      vbtn.dataset.view = viewMode;
      vbtn.textContent = (viewMode === 'tree') ? '🌳 Tree' : '☰ List';
      vbtn.title = (viewMode === 'tree') ? 'Tree view — click for List' : 'List view — click for Tree';
    }
    // Snapshot fn — called by closeDictionary to persist state across reopen
    dictOverlay._snapshot = () => {
      _dictState = {
        viewMode: viewMode,
        searchText: search ? search.value : '',
        selectedId: selectedId,
        keyboardFocusedId: keyboardFocusedId,
        expandedNodes: [...expandedNodes],
        scrollTop: listEl ? listEl.scrollTop : 0
      };
    };

    // Top-level dispatch: render whichever view is active
    function renderView() {
      if (viewMode === 'tree') renderTree();
      else renderList();
    }

    function useCountFor(id) {
      let n = 0;
      if (typeof data !== 'undefined') {
        data.forEach(r => {
          if (Array.isArray(r.tags) && r.tags.includes(id)) n++;
        });
      }
      return n;
    }

    function renderList() {
      const q = search.value.trim().toLowerCase();
      let filtered = tagsArr.slice();
      if (q) {
        filtered = filtered.filter(t => {
          const hay = [t.label, t.id, t.common || '', factsText(t), ...(t.aliases || []), ...(t.formerly || [])]
            .map(s => String(s).toLowerCase()).join(' ');
          return hay.includes(q);
        });
      }
      filtered.sort((a, b) => {
        const ka = (a.kind === 'taxon' ? '0' : a.kind === 'root' ? '0' : '1');
        const kb = (b.kind === 'taxon' ? '0' : b.kind === 'root' ? '0' : '1');
        if (ka !== kb) return ka < kb ? -1 : 1;
        return labelFor(a.id).localeCompare(labelFor(b.id));
      });
      countEl.textContent = filtered.length + ' / ' + tagsArr.length + ' tags'
        + (orphanTags.length ? ' · ⚠ ' + orphanTags.length + ' orphan' : '');
      listEl.innerHTML = '';
      if (orphanTags.length) {
        const hdr = document.createElement('div');
        hdr.style.cssText = 'padding:6px 12px;background:rgba(255,100,100,0.15);border-bottom:1px solid #633;color:#f88;font-size:11px;';
        hdr.textContent = '⚠ Orphan tag IDs referenced by records (no dictionary entry):';
        listEl.appendChild(hdr);
        orphanTags.forEach(id => {
          const row = document.createElement('div');
          row.style.cssText = 'padding:4px 14px;color:#f88;font-size:11px;display:flex;gap:8px;border-bottom:1px solid #1a1a2e;';
          row.innerHTML = '<span style="flex:1;">' + escapeHtml(id) + '</span>'
            + '<button data-create style="font-size:10px;padding:1px 6px;border:1px solid #5f5;background:rgba(0,80,0,0.3);color:#afa;border-radius:3px;cursor:pointer;">Create</button>';
          row.querySelector('[data-create]').addEventListener('click', () => {
            const r = createTag({ id, label: id.replace(/-/g, ' '), kind: 'topic' });
            if (r.ok) { renderView(); selectTag(id); }
          });
          listEl.appendChild(row);
        });
      }
      filtered.forEach(t => {
        const row = document.createElement('div');
        row.className = 'dict-row';
        row.dataset.id = t.id;
        row.dataset.tagId = t.id;
        const color = kindColor(t);
        const use = useCountFor(t.id);
        const rank = t.rank ? ' · ' + t.rank : '';
        // The row used to print only the immediate parent, which is exactly the
        // one fact you already know. What you want to see is that a cuttlefish
        // is a mollusc — so print the whole path.
        const linPaths = tagLineagePaths(t.id, 3);
        const isSelected = t.id === selectedId;
        const isKbFocused = t.id === keyboardFocusedId;
        let bg = '';
        let outline = '';
        if (isKbFocused) {
          bg = 'background:rgba(100,170,255,0.22);';
          outline = 'outline:1px solid #8ef;';
        } else if (isSelected) {
          bg = 'background:rgba(100,170,255,0.10);';
        }
        row.style.cssText = 'padding:6px 14px;border-bottom:1px solid #1a1a2e;cursor:pointer;'
          + bg + outline;
        row.innerHTML =
          '<div style="display:flex;align-items:center;gap:8px;">'
          + '<span style="color:' + color + ';font-weight:bold;">' + escapeHtml(labelFor(t.id)) + '</span>'
          + '<span style="color:#666;font-size:10px;">' + escapeHtml(t.kind + rank) + '</span>'
          + '<span style="flex:1;"></span>'
          + '<span style="color:#4af;font-size:10px;">' + use + ' vid</span>'
          + '</div>'
          + (linPaths.length
              ? '<div style="color:#5d6f80;font-size:10px;margin-top:2px;">↑ '
                + escapeHtml(linPaths[0].map(labelFor).join(' › '))
                + (linPaths.length > 1
                    ? ' <span style="color:#8a7a4a;">+' + (linPaths.length - 1) + ' more path'
                      + (linPaths.length > 2 ? 's' : '') + '</span>'
                    : '')
                + '</div>'
              : (t.kind === 'taxon'
                  ? '<div style="color:#b87;font-size:10px;margin-top:2px;">⚠ unplaced — no parent, so no broader group finds it</div>'
                  : ''))
          + ((t.formerly || []).length ? '<div style="color:#9a8;font-size:10px;margin-top:2px;">formerly: <i>' + escapeHtml(t.formerly.join(', ')) + '</i></div>' : '')
          + ((t.aliases || []).length ? '<div style="color:#777;font-size:10px;margin-top:2px;">also: ' + escapeHtml((t.aliases || []).join(', ')) + '</div>' : '');
        row.addEventListener('click', () => selectTag(t.id));
        listEl.appendChild(row);
      });
    }

    // ── Tree view with drag-drop re-parenting ────────────────────────────
    //
    // Layout:
    //   ┌─ 🗂 Unsorted (N)  ← rootless non-root tags, most-recently-created first
    //   │     tag · tag · tag
    //   ┌─ Life
    //   │    ▼ Arthropoda
    //   │       ▼ Crustacea
    //   │         ...
    //
    // Drag any tag onto any other tag → it becomes a child of that tag.
    // Drag onto "🗂 Unsorted" → it becomes rootless (parents cleared).
    // Refuses if it would create a cycle (target is descendant of dragged).
    // For topic/technique/etc.: replaces parents with [newParent]. If you want
    // multi-parent, edit the tag directly (list view → edit panel).
    function renderTree() {
      const q = search.value.trim().toLowerCase();
      _searchOpen = new Set();

      // Optional search-match set. If empty query, show everything.
      const matchedIds = new Set();
      if (q) {
        tagsArr.forEach(t => {
          const hay = [t.label, t.id, t.common || '', factsText(t), ...(t.aliases || []), ...(t.formerly || [])]
            .map(s => String(s).toLowerCase()).join(' ');
          if (hay.includes(q)) matchedIds.add(t.id);
        });
        // (dev1152) A real filter, live as you type: only the matches and their
        // ancestors (dimmed, so you see where they live) are drawn, and those
        // ancestors open for the search only. They used to be added to
        // expandedNodes for good, so typing "a" left almost the whole tree open.
        matchedIds.forEach(id => tagAncestors(id).forEach(a => _searchOpen.add(a)));
      }
      _searchShow = q ? new Set([...matchedIds, ..._searchOpen]) : null;

      const totalTags = tagsArr.length;
      countEl.textContent = (q ? matchedIds.size + ' match / ' : '')
        + totalTags + ' tags' + (orphanTags.length ? ' · ⚠ ' + orphanTags.length + ' orphan' : '');

      listEl.innerHTML = '';
      listEl.style.padding = '8px 0';

      // Build children index for fast lookup
      const childrenByParent = new Map();
      tagsArr.forEach(t => {
        (t.parents || []).forEach(p => {
          if (!childrenByParent.has(p)) childrenByParent.set(p, []);
          childrenByParent.get(p).push(t);
        });
      });
      // Sort children alphabetically by label
      childrenByParent.forEach(arr => arr.sort((a, b) => labelFor(a.id).localeCompare(labelFor(b.id))));

      // 1) Unsorted section (rootless non-root tags) — most recently created first
      const unsorted = tagsArr
        .map((t, i) => ({ t, i }))
        // Unsorted is for tags with nowhere to be, so exclude anything that is
        // itself the top of a tree — those render as roots above.
        .filter(x => x.t.kind !== 'root' && (!x.t.parents || !x.t.parents.length)
          && !(childrenByParent.get(x.t.id) || []).length)
        .sort((a, b) => b.i - a.i)
        .map(x => x.t);

      const unsortedHeader = document.createElement('div');
      unsortedHeader.className = 'tree-unsorted-header';
      unsortedHeader.style.cssText = 'padding:6px 12px;margin:0 8px 4px;'
        + 'background:rgba(255,200,100,0.08);border:1px dashed #764;border-radius:5px;'
        + 'font-size:11px;color:#cb8;display:flex;align-items:center;gap:6px;';
      unsortedHeader.innerHTML = '<span>🗂 <b>Unsorted</b> (' + unsorted.length + ')'
        + ' <span style="color:#666;font-weight:normal;">— new tags you haven\'t placed yet. Right-click a tag below for placement options (Cut → right-click target → Paste).</span></span>';
      listEl.appendChild(unsortedHeader);

      if (unsorted.length) {
        const unsortedBody = document.createElement('div');
        unsortedBody.style.cssText = 'padding:0 8px 8px;display:flex;flex-wrap:wrap;gap:4px;';
        unsorted.forEach(t => {
          if (q && !matchedIds.has(t.id)) return;
          unsortedBody.appendChild(buildTreeChip(t));
        });
        listEl.appendChild(unsortedBody);
      }

      // 2) The roots. Anything with no parent but with children is a root of
      //    some tree, whatever its `kind` says. This used to test kind==='root'
      //    alone, which meant only Health / Activity / Other ever rendered:
      //    'life' is stored as kind:'taxon', so it fell through to Unsorted and
      //    took all 544 taxa with it. Every classification the dictionary knows
      //    about was one blank-labelled chip.
      const hasKids = (id) => (childrenByParent.get(id) || []).length > 0;
      const roots = tagsArr.filter(t => t.kind === 'root'
        || ((!t.parents || !t.parents.length) && hasKids(t.id)));
      roots.sort((a, b) => labelFor(a.id).localeCompare(labelFor(b.id)));
      roots.forEach(root => {
        // When searching, only render a root's tree if it contains a match
        if (q) {
          const descSet = tagDescendants(root.id);
          descSet.add(root.id);
          let anyMatch = false;
          descSet.forEach(id => { if (matchedIds.has(id)) anyMatch = true; });
          if (!anyMatch) return;
        }
        renderTreeNode(listEl, root, 0, childrenByParent, matchedIds, q);
      });

      // 3) Any rootless tags that ARE kind==='root' but missing — shouldn't happen,
      //    but orphans with dangling parents can also show at the bottom.
      const orphansWithParents = tagsArr.filter(t => {
        if (t.kind === 'root') return false;
        if (!t.parents || !t.parents.length) return false;
        return t.parents.every(p => !byId.get(p));  // all parents missing
      });
      if (orphansWithParents.length) {
        const hdr = document.createElement('div');
        hdr.style.cssText = 'margin:10px 8px 4px;padding:6px 12px;background:rgba(255,80,80,0.1);border:1px dashed #733;border-radius:5px;font-size:11px;color:#c88;';
        hdr.textContent = '⚠ Tags with missing parents (' + orphansWithParents.length + ')';
        listEl.appendChild(hdr);
        const body = document.createElement('div');
        body.style.cssText = 'padding:0 8px;display:flex;flex-wrap:wrap;gap:4px;';
        orphansWithParents.forEach(t => { if (!q || matchedIds.has(t.id)) body.appendChild(buildTreeChip(t)); });
        listEl.appendChild(body);
      }

      // Orphan tag-IDs referenced by records but not in dict (same as list view)
      if (orphanTags.length && !q) {
        const hdr = document.createElement('div');
        hdr.style.cssText = 'margin:10px 8px 4px;padding:6px 12px;background:rgba(255,100,100,0.12);border:1px solid #633;border-radius:5px;color:#f88;font-size:11px;';
        hdr.textContent = '⚠ Orphan tag IDs referenced by records (no dictionary entry):';
        listEl.appendChild(hdr);
        orphanTags.forEach(id => {
          const row = document.createElement('div');
          row.style.cssText = 'padding:3px 20px;color:#f88;font-size:11px;display:flex;gap:8px;';
          row.innerHTML = '<span style="flex:1;">' + escapeHtml(id) + '</span>'
            + '<button data-create style="font-size:10px;padding:1px 6px;border:1px solid #5f5;background:rgba(0,80,0,0.3);color:#afa;border-radius:3px;cursor:pointer;">Create</button>';
          row.querySelector('[data-create]').addEventListener('click', () => {
            const r = createTag({ id, label: id.replace(/-/g, ' '), kind: 'topic' });
            if (r.ok) { renderView(); selectTag(id); }
          });
          listEl.appendChild(row);
        });
      }
    }

    function renderTreeNode(container, tag, depth, childrenByParent, matchedIds, q, inMatch) {
      const t = tag;
      const row = document.createElement('div');
      row.className = 'tree-node';
      row.dataset.tagId = t.id;

      // (dev1152) Filtering: under a match everything shows (open it to see its
      // children); elsewhere only matches and their ancestors.
      const underMatch = inMatch || (q && matchedIds.has(t.id));
      const kids = (childrenByParent.get(t.id) || []).filter(k => !_searchShow || underMatch || _searchShow.has(k.id));
      const isExpanded = isOpen(t.id);
      const isSelected = t.id === selectedId;
      const isKbFocused = t.id === keyboardFocusedId;
      const isMatch = !q || matchedIds.has(t.id);
      const isCutSource = t.id === _cutTagId;
      const use = useCountFor(t.id);
      const color = kindColor(t);

      // Brightness model:
      //   default rows           : slightly subdued (opacity 0.78) — readable but quiet
      //   keyboard-focused row   : full opacity, blue outline + bright background
      //   non-matching (search)  : strongly dimmed (opacity 0.32) so matches stand out
      //   cut source (pending)   : dashed yellow outline + reduced opacity
      let opacity = '0.78';
      if (isKbFocused) opacity = '1';
      else if (q && !isMatch) opacity = '0.32';
      else if (isCutSource) opacity = '0.55';

      let bg = '';
      let outline = '';
      if (isCutSource) {
        outline = 'outline:1px dashed #fc6;';
      } else if (isKbFocused) {
        bg = 'background:rgba(100,170,255,0.22);';
        outline = 'outline:1px solid #8ef;';
      } else if (isSelected) {
        bg = 'background:rgba(100,170,255,0.10);';
      }

      row.style.cssText = 'display:flex;align-items:center;gap:4px;'
        + 'padding:3px 8px 3px ' + (10 + depth * 18) + 'px;'
        + 'cursor:pointer;font-size:12px;'
        + 'opacity:' + opacity + ';'
        + bg + outline
        + 'border-radius:3px;';

      const chevron = kids.length
        ? (isExpanded
            ? '<span class="tree-chev" style="display:inline-block;width:12px;color:#888;cursor:pointer;">▾</span>'
            : '<span class="tree-chev" style="display:inline-block;width:12px;color:#888;cursor:pointer;">▸</span>')
        : '<span style="display:inline-block;width:12px;"></span>';
      const rankBadge = t.rank
        ? ' <span style="color:#555;font-size:10px;">' + t.rank + '</span>'
        : (t.kind !== 'taxon' && t.kind !== 'root' ? ' <span style="color:#555;font-size:10px;">' + t.kind + '</span>' : '');
      const extinct = t.extinct ? ' <span style="color:#a66;font-size:9px;">†ext</span>' : '';
      const aliasHint = (t.aliases || []).length
        ? ' <span style="color:#666;font-size:10px;">also: ' + escapeHtml((t.aliases || []).slice(0,3).join(', ')) + '</span>'
        : '';
      const formerlyHint = (t.formerly || []).length
        ? ' <span style="color:#9a8;font-size:10px;">formerly <i>' + escapeHtml(t.formerly.slice(0,2).join(', ')) + '</i></span>'
        : '';
      const commonHint = t.common ? ' <span style="color:#678;font-size:10px;">(' + escapeHtml(t.common) + ')</span>' : '';
      const useHint = use ? ' <span style="color:#4af;font-size:10px;">· ' + use + 'v</span>' : '';
      const kidsCount = kids.length ? ' <span style="color:#555;font-size:10px;">· ' + kids.length + '▾</span>' : '';
      const cutBadge = isCutSource ? ' <span style="color:#fc6;font-size:9px;">✂ cut</span>' : '';
      // A tag with two parents is drawn twice in this tree. Say so, rather than
      // letting it read as a duplicate.
      const alsoUnder = (t.parents || []).filter(x => byId.get(x));
      const multiParent = alsoUnder.length > 1
        ? ' <span title="Filed under ' + escapeAttr(alsoUnder.map(labelFor).join(' + '))
          + ' — shown once under each" style="color:#8a9;font-size:9px;">⧉' + alsoUnder.length + '</span>'
        : '';

      row.innerHTML = chevron
        + '<span class="tree-label" style="color:' + color + ';font-weight:' + (t.kind === 'root' ? 'bold' : 'normal') + ';">' + escapeHtml(labelFor(t.id)) + '</span>'
        + commonHint + rankBadge + extinct + multiParent + cutBadge + kidsCount + useHint + formerlyHint + aliasHint;

      // Chevron click → toggle expand
      const chevEl = row.querySelector('.tree-chev');
      if (chevEl) {
        chevEl.addEventListener('click', (e) => {
          e.stopPropagation();
          setOpen(t.id, !isExpanded);
          renderView();
        });
      }
      // Row click (not on chevron) → set keyboard focus to this row.
      // setKbFocus auto-loads it into the right edit panel via selectTag.
      row.addEventListener('click', (e) => {
        if (e.target.classList && e.target.classList.contains('tree-chev')) return;
        setKbFocus(t.id, false);
      });
      // Double-click to expand/collapse
      row.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (kids.length) {
          setOpen(t.id, !isExpanded);
          renderView();
        }
      });
      // Right-click → context menu
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setKbFocus(t.id, false);
        openTreeContextMenu(e.clientX, e.clientY, t.id);
      });

      container.appendChild(row);

      if (isExpanded && kids.length) {
        kids.forEach(k => renderTreeNode(container, k, depth + 1, childrenByParent, matchedIds, q, underMatch));
      }
    }

    // Small pill chip for Unsorted section — pointer + click + right-click menu
    function buildTreeChip(t) {
      const chip = document.createElement('span');
      chip.className = 'tree-chip';
      chip.dataset.tagId = t.id;
      const isCutSource = t.id === _cutTagId;
      chip.style.cssText = 'display:inline-flex;align-items:center;padding:3px 10px;'
        + 'background:rgba(255,255,255,0.05);border:1px ' + (isCutSource ? 'dashed #fc6' : 'solid ' + kindColor(t)) + ';border-radius:12px;'
        + 'font-size:11px;color:' + kindColor(t) + ';cursor:pointer;'
        + (isCutSource ? 'opacity:0.55;' : '');
      chip.innerHTML = escapeHtml(labelFor(t.id))
        + (t.common ? ' <span style="color:#678;font-size:10px;margin-left:4px;">(' + escapeHtml(t.common) + ')</span>' : '')
        + (isCutSource ? ' <span style="color:#fc6;font-size:9px;margin-left:3px;">✂</span>' : '');
      chip.addEventListener('click', () => setKbFocus(t.id, false));
      chip.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setKbFocus(t.id, false);
        openTreeContextMenu(e.clientX, e.clientY, t.id);
      });
      return chip;
    }

    // ── Cut / Paste state for tree restructuring ──────────────────────────
    // Replaces drag-and-drop. The user picks a tag to "cut" (it gets a dashed
    // yellow outline + 'cut' badge), then on a target picks Paste-Same-Rank
    // (becomes a sibling) or Paste-Lower-Rank (becomes a child). The cut
    // tag remains in the tree until paste; cancel via Escape or by cutting
    // a different tag.
    let _cutTagId = null;

    function setCut(id) {
      _cutTagId = id;
      renderView();
      const t = byId.get(id);
      if (typeof toast === 'function' && t) {
        toast('✂ Cut "' + t.label + '"\nNow right-click target → Paste same rank (sibling) or Paste lower rank (child)', 2400);
      }
    }
    function clearCut() { _cutTagId = null; renderView(); }

    function pasteAtSameRank(targetId) {
      // The cut tag becomes a sibling of target — i.e., its parent becomes
      // the parent of target.
      if (!_cutTagId) return;
      if (_cutTagId === targetId) return;
      const target = byId.get(targetId);
      const cut = byId.get(_cutTagId);
      if (!target || !cut) return;
      // Cycle check: target must not be a descendant of cut
      if (tagDescendants(_cutTagId).has(targetId)) {
        if (typeof toast === 'function') toast('✗ Cannot paste: "' + target.label + '" is a descendant of "' + cut.label + '"', 2500);
        return;
      }
      const newParents = (target.parents || []).slice(0, 1);  // single parent for taxa
      const r = updateTag(_cutTagId, { parents: newParents });
      if (r.ok) {
        const parentLabel = newParents.length ? labelFor(newParents[0]) : '(top level)';
        if (typeof toast === 'function') toast('✓ "' + cut.label + '" → sibling of "' + target.label + '" under "' + parentLabel + '"', 1800);
        if (typeof render === 'function') render();
        const moved = _cutTagId;
        _cutTagId = null;
        renderView();
        setKbFocus(moved, true);
      }
    }

    function pasteAtLowerRank(targetId) {
      // The cut tag becomes a CHILD of target.
      if (!_cutTagId) return;
      if (_cutTagId === targetId) return;
      const target = byId.get(targetId);
      const cut = byId.get(_cutTagId);
      if (!target || !cut) return;
      if (tagDescendants(_cutTagId).has(targetId)) {
        if (typeof toast === 'function') toast('✗ Cannot paste: "' + target.label + '" is already a descendant of "' + cut.label + '" — would create a cycle', 2500);
        return;
      }
      const r = updateTag(_cutTagId, { parents: [targetId] });
      if (r.ok) {
        expandedNodes.add(targetId);
        if (typeof toast === 'function') toast('✓ "' + cut.label + '" → child of "' + target.label + '"', 1800);
        if (typeof render === 'function') render();
        const moved = _cutTagId;
        _cutTagId = null;
        renderView();
        setKbFocus(moved, true);
      }
    }

    function deleteTagWithConfirm(tagId) {
      const t = byId.get(tagId);
      if (!t) return;
      const useCount = useCountFor(tagId);
      const confirmMsg = 'Delete tag "' + t.label + '"?'
        + (useCount ? '\nIt will be removed from ' + useCount + ' video record(s).' : '');
      if (!confirm(confirmMsg)) return;
      // Remember neighbor for post-delete focus
      const ids = getVisibleRowIds();
      const idx = ids.indexOf(tagId);
      const r = deleteTag(tagId);
      if (r.ok) {
        if (typeof toast === 'function') toast('✓ Deleted "' + t.label + '"' + (r.removedFromRecords ? ' (removed from ' + r.removedFromRecords + ' records)' : ''), 1400);
        if (typeof render === 'function') render();
        if (selectedId === tagId) {
          selectedId = null;
          editEl.innerHTML = '<div style="color:#777;">(select a tag)</div>';
        }
        if (_cutTagId === tagId) _cutTagId = null;
        const newIds = getVisibleRowIds();
        const nextFocus = newIds[idx] || newIds[idx - 1] || null;
        setKbFocus(nextFocus, true);
        renderView();
      }
    }

    // ── Right-click context menu ───────────────────────────────────────────
    let _treeMenu = null;
    function closeTreeContextMenu() {
      if (_treeMenu) {
        if (_treeMenu._docHandler) document.removeEventListener('mousedown', _treeMenu._docHandler, true);
        if (_treeMenu._keyHandler) document.removeEventListener('keydown', _treeMenu._keyHandler, true);
        _treeMenu.remove();
        _treeMenu = null;
      }
    }

    function openTreeContextMenu(x, y, tagId) {
      closeTreeContextMenu();
      const t = byId.get(tagId);
      if (!t) return;

      // Determine which actions are valid
      const hasCut = !!_cutTagId;
      const isSelf = _cutTagId === tagId;
      const isCutDesc = hasCut && tagDescendants(_cutTagId).has(tagId);
      const canPaste = hasCut && !isSelf && !isCutDesc;

      // Build menu items: { key (letter shortcut), labelHtml, action, disabled }
      const items = [
        {
          key: 'c',
          labelHtml: '<u>C</u>ut',
          action: () => setCut(tagId),
          disabled: false
        },
        {
          key: 'a',
          labelHtml: 'P<u>a</u>ste same rank' + (hasCut ? ' <span style="color:#888;">(' + labelFor(_cutTagId) + ' as sibling)</span>' : ''),
          action: () => pasteAtSameRank(tagId),
          disabled: !canPaste
        },
        {
          key: 's',
          labelHtml: 'Pa<u>s</u>te lower rank' + (hasCut ? ' <span style="color:#888;">(' + labelFor(_cutTagId) + ' as child)</span>' : ''),
          action: () => pasteAtLowerRank(tagId),
          disabled: !canPaste
        },
        { sep: true },
        {
          key: 'd',
          labelHtml: '<u>D</u>elete',
          action: () => deleteTagWithConfirm(tagId),
          disabled: false,
          warn: true
        }
      ];

      _treeMenu = document.createElement('div');
      _treeMenu.id = 'treeCtxMenu';
      _treeMenu.style.cssText = 'position:fixed;z-index:30000;background:#0d0d1e;'
        + 'border:1px solid #4af;border-radius:5px;box-shadow:0 6px 20px rgba(0,0,0,0.85);'
        + 'font-family:monospace;font-size:12px;color:#ddd;min-width:240px;'
        + 'padding:4px 0;left:' + x + 'px;top:' + y + 'px;';

      // Header showing which tag the menu is for
      const hdr = document.createElement('div');
      hdr.style.cssText = 'padding:4px 12px;color:#8ef;font-size:11px;font-weight:bold;border-bottom:1px solid #1a1a2e;';
      hdr.textContent = t.label;
      _treeMenu.appendChild(hdr);

      // If there's an active cut, show a banner
      if (hasCut) {
        const cb = document.createElement('div');
        cb.style.cssText = 'padding:4px 12px;color:#fc6;font-size:10px;background:rgba(255,200,100,0.07);border-bottom:1px solid #1a1a2e;';
        cb.innerHTML = '✂ Pending cut: <b>' + escapeHtml(labelFor(_cutTagId)) + '</b>';
        _treeMenu.appendChild(cb);
      }

      items.forEach(item => {
        if (item.sep) {
          const sep = document.createElement('div');
          sep.style.cssText = 'border-top:1px solid #1a1a2e;margin:3px 0;';
          _treeMenu.appendChild(sep);
          return;
        }
        const row = document.createElement('div');
        row.dataset.key = item.key;
        const baseColor = item.warn ? '#f88' : '#cef';
        const disabledStyle = item.disabled ? 'opacity:0.4;cursor:not-allowed;' : 'cursor:pointer;';
        row.style.cssText = 'padding:6px 14px;color:' + baseColor + ';' + disabledStyle;
        row.innerHTML = item.labelHtml;
        if (!item.disabled) {
          row.addEventListener('mouseenter', () => row.style.background = item.warn ? 'rgba(255,80,80,0.18)' : 'rgba(100,170,255,0.18)');
          row.addEventListener('mouseleave', () => row.style.background = '');
          row.addEventListener('click', () => {
            closeTreeContextMenu();
            item.action();
          });
        }
        _treeMenu.appendChild(row);
      });

      document.body.appendChild(_treeMenu);

      // Reposition if it would go off the bottom-right edge
      const r = _treeMenu.getBoundingClientRect();
      if (r.right > window.innerWidth) _treeMenu.style.left = (window.innerWidth - r.width - 6) + 'px';
      if (r.bottom > window.innerHeight) _treeMenu.style.top = (window.innerHeight - r.height - 6) + 'px';

      // Click-outside closes
      _treeMenu._docHandler = (e) => {
        if (_treeMenu && !_treeMenu.contains(e.target)) closeTreeContextMenu();
      };
      // Bind on next tick so the original right-click that opened it doesn't immediately close it
      setTimeout(() => {
        if (_treeMenu) document.addEventListener('mousedown', _treeMenu._docHandler, true);
      }, 0);

      // Letter-key shortcuts while menu is open
      _treeMenu._keyHandler = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation();
          closeTreeContextMenu();
          return;
        }
        const k = e.key.toLowerCase();
        const it = items.find(x => !x.sep && x.key === k);
        if (it && !it.disabled) {
          e.preventDefault(); e.stopPropagation();
          closeTreeContextMenu();
          it.action();
        }
      };
      document.addEventListener('keydown', _treeMenu._keyHandler, true);
    }

    function selectTag(id) {
      selectedId = id;
      renderView();
      const t = byId.get(id);
      if (!t) {
        editEl.innerHTML = '<div style="color:#777;">(select a tag)</div>';
        return;
      }
      // Expose for outside callers (e.g., GBIF apply buttons via selectTagFromOutside)
      dictOverlay._selectTag = selectTag;
      const children = tagsArr.filter(x => (x.parents || []).includes(id));
      const descCount = tagDescendants(id).size;
      const use = useCountFor(id);
      const effUse = (() => {
        if (typeof data === 'undefined') return 0;
        let n = 0;
        data.forEach(r => {
          if (!Array.isArray(r.tags) || !r.tags.length) return;
          if (recordMatchesTagQuery(r.tags, id)) n++;
        });
        return n;
      })();

      // -- CLASSIFIED UNDER ------------------------------------------------
      // Filtering by any ancestor finds this tag — that is what
      // recordMatchesTagQuery does — but the panel only ever showed the
      // immediate parent chip, so "why did Mollusca find this cuttlefish?" had
      // no answer anywhere on screen. Print every path a filter can travel,
      // each node clickable.
      const linPaths = tagLineagePaths(id);
      const linCrumb = (path) => path.map(pid => {
        const pt = byId.get(pid);
        const ttl = pt ? ((pt.rank || pt.kind || '') + ' · ' + pt.label) : pid;
        return '<span data-lin="' + escapeAttr(pid) + '" title="' + escapeAttr(ttl)
          + '" style="color:' + kindColor(pt) + ';cursor:pointer;'
          + 'text-decoration:underline dotted;text-underline-offset:3px;">'
          + escapeHtml(labelFor(pid)) + '</span>';
      }).join('<span style="color:#556;padding:0 4px;">&rsaquo;</span>')
        + '<span style="color:#556;padding:0 4px;">&rsaquo;</span>'
        + '<span style="color:' + kindColor(t) + ';font-weight:bold;">' + escapeHtml(labelFor(t.id)) + '</span>';
      const dictLineageHtml =
        '<div style="margin-bottom:12px;padding:7px 10px;background:rgba(70,110,180,0.10);'
        + 'border:1px solid #345;border-radius:5px;">'
        + '<div style="color:#78899a;font-size:10px;margin-bottom:4px;letter-spacing:0.5px;">CLASSIFIED UNDER'
        + ' <span style="color:#566;letter-spacing:0;">— filtering by any name here also finds this tag</span></div>'
        + (linPaths.length
            ? linPaths.map(pp => '<div style="font-size:11px;line-height:2;">' + linCrumb(pp) + '</div>').join('')
            : '<div style="color:#c96;font-size:11px;line-height:1.6;">⚠ No parent — nothing broader finds this tag.'
              + '<br>Set a Parent below, or run 🔎 Check taxonomy → 🚀 Apply All to import the whole chain.</div>')
        + '</div>';

      editEl.innerHTML = `
        <style>
          .de-facts-prev { flex:1; min-width:0; max-height:120px; overflow:auto; padding:5px 8px; background:#0a0a1a;
            border:1px solid #333; border-radius:4px; color:#ccc; font:12px/1.4 system-ui,sans-serif; cursor:pointer; }
          .de-facts-prev p, .de-facts-prev ul, .de-facts-prev ol { margin:.2em 0; }
          .de-facts-prev h1, .de-facts-prev h2, .de-facts-prev h3, .de-facts-prev h4 { font-size:1.1em; margin:.25em 0; color:#ff8; }
          .de-facts-prev img, .de-facts-prev video { max-width:100%; max-height:80px; }
          #de-namesay-keybox table { border-collapse:collapse; margin-top:4px; }
          #de-namesay-keybox td { padding:1px 10px 1px 0; }
          #de-namesay-keybox td:first-child { font-family:monospace; color:#fff; }
          .de-auto-note { color:#678; font:10.5px/1.5 system-ui,sans-serif; margin-top:2px; }
          .de-auto-note:empty { display:none; }
          .de-auto-note a { color:#68a; }
          .de-auto-note button { margin-left:4px; padding:0 6px; border:1px solid #456; background:#14142a; color:#9ab;
            border-radius:3px; cursor:pointer; font:10px monospace; }
          .de-name-btn { padding:4px 9px; border:1px solid #4af; background:rgba(0,40,100,0.35); color:#8ef; border-radius:4px;
            cursor:pointer; font-family:monospace; font-size:11px; white-space:nowrap; }
          .de-name-btn[hidden] { display:none; }
          #dictEdit textarea[readonly] { color:#9ab !important; cursor:default; }
          .de-name-flag { display:inline-block; margin-top:4px; padding:0 6px; border:1px solid #c94; border-radius:8px;
            background:rgba(120,70,0,0.3); color:#fc8; font:10px/1.6 monospace; cursor:pointer; }
        </style>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
          <span style="font-size:17px;color:${kindColor(t)};font-weight:bold;">${escapeHtml(labelFor(t.id))}</span>
          <span style="color:#555;font-size:11px;">id=${escapeHtml(t.id)}</span>
        </div>
        ${(t.formerly || []).length ? `<div style="margin:-8px 0 10px;color:#9a8;font-size:12px;">formerly <i>${escapeHtml(t.formerly.join(', '))}</i></div>` : ''}
        <div style="font-size:11px;color:#666;margin-bottom:10px;">
          Directly tagged on <b style="color:#4af;">${use}</b> videos · total (with descendants): <b style="color:#4af;">${effUse}</b> · descendants: <b style="color:#4af;">${descCount}</b>
        </div>

        ${dictLineageHtml}

        <div style="display:grid;grid-template-columns:110px 1fr;gap:8px;align-items:start;font-size:12px;">
          <label style="color:#6af;padding-top:5px;">Label</label>
          <input id="de-label" type="text" value="${escapeAttr(t.label)}"
            style="padding:5px 8px;background:#0a0a1a;border:1px solid #333;color:#fff;border-radius:4px;font-family:monospace;font-size:12px;outline:none;">

          <label style="color:#6af;padding-top:5px;">Kind</label>
          <select id="de-kind" style="padding:5px 8px;background:#0a0a1a;border:1px solid #333;color:#fff;border-radius:4px;font-family:monospace;font-size:12px;outline:none;">
            ${['root','taxon','topic','technique','place','person','other'].map(k => `<option value="${k}"${t.kind === k ? ' selected' : ''}>${k}</option>`).join('')}
          </select>

          <label style="color:#6af;padding-top:5px;">Rank <span style="color:#555;font-size:10px;">(if taxon)</span></label>
          <select id="de-rank" style="padding:5px 8px;background:#0a0a1a;border:1px solid #333;color:#fff;border-radius:4px;font-family:monospace;font-size:12px;outline:none;">
            ${['','domain','kingdom','phylum','subphylum','class','subclass','order','suborder','family','subfamily','genus','species'].map(r => `<option value="${r}"${(t.rank || '') === r ? ' selected' : ''}>${r || '—'}</option>`).join('')}
          </select>

          <label style="color:#6af;padding-top:5px;">Parent(s)</label>
          <div id="de-parents" style="min-width:0;"></div>

          <label style="color:#6af;padding-top:5px;">Aliases</label>
          <input id="de-aliases" type="text" value="${escapeAttr((t.aliases || []).join(', '))}"
            placeholder="comma-separated synonyms, e.g. skeleton shrimp, caprellid"
            style="padding:5px 8px;background:#0a0a1a;border:1px solid #333;color:#fff;border-radius:4px;font-family:monospace;font-size:12px;outline:none;">

          <label style="color:#6af;padding-top:5px;" title="Older scientific names this label replaced. Typing one still finds this tag.">Formerly</label>
          <input id="de-formerly" type="text" value="${escapeAttr((t.formerly || []).join(', '))}"
            placeholder="older scientific names, e.g. Pleuroncodes planipes"
            style="padding:5px 8px;background:#0a0a1a;border:1px solid #333;color:#cdb;border-radius:4px;font-family:monospace;font-size:12px;font-style:italic;outline:none;">

          <label style="color:#6af;padding-top:5px;">Common name</label>
          <input id="de-common" type="text" value="${escapeAttr(t.common || '')}"
            style="padding:5px 8px;background:#0a0a1a;border:1px solid #333;color:#fff;border-radius:4px;font-family:monospace;font-size:12px;outline:none;">

          ${['facts1', 'facts2', 'facts3'].map((f, i) => `
          <label style="color:#6af;padding-top:5px;" title="${i ? 'Secondary facts — whatever suits this taxon. Start with a heading to title the block.' : 'Main facts, shown first on card backs. Put a fact on the tag at the rank where it is true: a family-wide fact goes on the family.'}">Facts ${i + 1}</label>
          <div style="display:flex;gap:6px;align-items:flex-start;min-width:0;">
            <div class="de-facts-prev" data-facts-prev="${f}" title="Double-click to edit in Xe">${factsPreviewHtml(t[f])}</div>
            <button data-facts-edit="${f}" title="Edit Facts ${i + 1} in Xe" style="padding:4px 9px;border:1px solid #4af;background:rgba(0,40,100,0.35);color:#8ef;border-radius:4px;cursor:pointer;font-family:monospace;font-size:11px;white-space:nowrap;">✎ Xe</button>
          </div>`).join('')}

          <label style="color:#6af;padding-top:5px;" title="How the binomial was given: who named it, when, and what the Latin or Greek means">Name origin<span data-name-flag="origin"></span></label>
          <div style="min-width:0;">
            <div style="display:flex;gap:6px;align-items:flex-start;">
              <textarea id="de-nameorigin" rows="3" placeholder="who named it, when, and what the Latin or Greek means"
                style="flex:1;min-width:0;padding:5px 8px;background:#0a0a1a;border:1px solid #333;color:#ccc;border-radius:4px;font-family:system-ui,sans-serif;font-size:12px;outline:none;resize:vertical;">${escapeHtml(t.NameOrigin || '')}</textarea>
              ${t.kind === 'taxon' ? `<div style="display:flex;flex-direction:column;gap:4px;">
                <button data-name-edit="origin" title="Change the looked-up text. Once you change it and press ✓ Save it is yours: it is flagged “edited” and no look-up replaces it." class="de-name-btn">✎ Edit</button>
                <button id="de-names-look" title="R — look Name origin and Name say up again now (WoRMS, GBIF, Wikidata, Wiktionary, Wikipedia) and save what is found. Fields flagged “edited” are left alone." class="de-name-btn">↻ Look up</button>
              </div>` : ''}
            </div>
            <div id="de-origin-auto" class="de-auto-note"></div>
            <div id="de-origin-inherit"></div>
          </div>

          <label style="color:#6af;padding-top:5px;" title="Respelled pronunciation, one line per variant">Name say<span data-name-flag="say"></span></label>
          <div style="min-width:0;">
            <div style="display:flex;gap:6px;align-items:flex-start;">
              <textarea id="de-namesay" rows="2" placeholder="US: or-SY-nuhs OR-kuh&#10;GB: aw-SY-nuhs AW-kuh"
                style="flex:1;min-width:0;padding:5px 8px;background:#0a0a1a;border:1px solid #333;color:#fff;border-radius:4px;font-family:monospace;font-size:12px;outline:none;resize:vertical;">${escapeHtml(t.NameSay || '')}</textarea>
              ${t.kind === 'taxon' ? `<button data-name-edit="say" title="Change the looked-up pronunciation. Once you change it and press ✓ Save it is flagged “edited” and no look-up replaces it." class="de-name-btn">✎ Edit</button>` : ''}
              <button id="de-namesay-key" title="Respelling key" style="padding:4px 9px;border:1px solid #556;background:#14142a;color:#9ab;border-radius:4px;cursor:pointer;font-family:monospace;font-size:11px;">?</button>
            </div>
            <div id="de-namesay-auto" class="de-auto-note"></div>
            <div id="de-namesay-keybox" style="display:none;margin-top:6px;padding:7px 10px;background:#0d0d1e;border:1px solid #345;border-radius:5px;color:#aab;font:11px/1.6 system-ui,sans-serif;">${NAMESAY_KEY_HTML}</div>
          </div>

          <label style="color:#6af;padding-top:5px;">Extinct</label>
          <label style="padding-top:5px;"><input id="de-extinct" type="checkbox" ${t.extinct ? 'checked' : ''}> <span style="color:#888;font-size:11px;">extinct taxon</span></label>
        </div>

        <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;">
          <button id="de-save" style="padding:6px 18px;border:1px solid #5f5;background:rgba(0,80,0,0.4);color:#afa;border-radius:5px;cursor:pointer;font-family:monospace;font-size:12px;font-weight:bold;">✓ Save</button>
          <button id="de-merge" style="padding:6px 14px;border:1px solid #fc8;background:rgba(80,50,0,0.35);color:#fc8;border-radius:5px;cursor:pointer;font-family:monospace;font-size:12px;" title="Merge this tag into another — moves records, adds aliases, deletes this tag">↗ Merge into…</button>
          <button id="de-del" style="padding:6px 14px;border:1px solid #f66;background:rgba(80,0,0,0.3);color:#f88;border-radius:5px;cursor:pointer;font-family:monospace;font-size:12px;">🗑 Delete</button>
          <button id="de-gbif" style="padding:6px 12px;border:1px solid #4af;background:rgba(0,40,100,0.35);color:#8ef;border-radius:5px;cursor:pointer;font-family:monospace;font-size:11px;" title="${t.kind === 'taxon' ? 'Look this name up in WoRMS (World Register of Marine Species), falling back to GBIF for anything not marine' : 'Look this name up in WoRMS, then GBIF — applying a chain will mark this tag as a taxon'}">🔎 Check taxonomy${t.kind === 'taxon' ? '' : ' (verify as taxon)'}</button>
          <span style="flex:1;"></span>
          <button id="de-viewrecs" style="padding:6px 12px;border:1px solid #4af;background:rgba(0,60,140,0.4);color:#8ef;border-radius:5px;cursor:pointer;font-family:monospace;font-size:11px;">Show ${effUse} videos</button>
        </div>
        <div id="de-gbif-result" style="margin-top:10px;"></div>

        ${children.length ? `<div style="margin-top:18px;border-top:1px solid #333;padding-top:10px;"><div style="color:#666;font-size:11px;margin-bottom:6px;">CHILDREN (${children.length})</div><div style="display:flex;flex-wrap:wrap;gap:4px;">${children.map(c => chipHtml(c.id)).join('')}</div></div>` : ''}
      `;

      // Any node in the CLASSIFIED UNDER path jumps the panel to that tag.
      editEl.querySelectorAll('[data-lin]').forEach(el => {
        el.addEventListener('click', () => selectTag(el.dataset.lin));
      });

      // Mount parent chip input
      const parentMount = editEl.querySelector('#de-parents');
      let curParents = (t.parents || []).slice();
      window.mountTagChipInput({
        container: parentMount,
        getIds: () => curParents,
        setIds: (next) => { curParents = next; },
        placeholder: (t.kind === 'taxon' ? 'single parent…' : 'parent(s)…')
      });

      // (dev1148) Facts 1-3 open in Xe v2 with THIS TAG as the record. Xe calls
      // onSave (its 1 s autosave and ✓ Save) instead of writing ml.json, so the
      // HTML goes through updateTag → tags.json. Only the preview box is redrawn,
      // not the whole panel: a full selectTag() would throw away anything typed
      // in the other boxes and not yet saved.
      const openFacts = (field) => {
        if (!window.XE2 || typeof window.XE2.open !== 'function') {
          if (typeof toast === 'function') toast('Xe v2 is not loaded', 2000);
          return;
        }
        const n = field.slice(-1);
        const refresh = () => {
          const el = editEl.querySelector('[data-facts-prev="' + field + '"]');
          const cur = byId.get(id);
          if (el && el.isConnected && cur) el.innerHTML = factsPreviewHtml(cur[field]);
        };
        window.XE2.open('Facts ' + n, t, {
          field,
          title: 'Facts ' + n + ' · ' + labelFor(id),
          onSave: (html) => {
            const cur = byId.get(id);
            if (!cur) return false;
            const v = isBlankHtml(html) ? '' : html;
            if (v === '' && cur[field] == null) return true;      // never written, still empty
            if (cur[field] != null && v === cur[field]) return true;
            updateTag(id, { [field]: v });
            refresh();
            return true;
          },
          onClose: refresh
        });
      };
      editEl.querySelectorAll('[data-facts-edit]').forEach(b =>
        b.addEventListener('click', () => openFacts(b.dataset.factsEdit)));
      editEl.querySelectorAll('[data-facts-prev]').forEach(el =>
        el.addEventListener('dblclick', () => openFacts(el.dataset.factsPrev)));

      // ? shows the respelling key. NameSay is only ever a PUBLISHED
      // pronunciation or Phil's own (the dev1149 rule respelling and the 🔊
      // speech buttons were removed in dev1150 — Phil found both poor).
      editEl.querySelector('#de-namesay-key').addEventListener('click', () => {
        const k = editEl.querySelector('#de-namesay-keybox');
        k.style.display = (k.style.display === 'none') ? 'block' : 'none';
      });

      // (dev1149) Name origin. Greyed below: the family's (and higher) origins.
      // The genus is skipped under a species — its draft explains the genus too.
      const originBox = editEl.querySelector('#de-nameorigin');
      if (t.kind === 'taxon') {
        const lw = String(t.label || '').trim().split(/\s+/);
        const genusWord = lw.length > 1 ? lw[0] : null;
        const inh = [];
        let cur = t;
        for (let hops = 0; hops < 3 && cur; hops++) {
          const pid = (cur.parents || []).find(p => { const pt = byId.get(p); return pt && pt.kind === 'taxon'; });
          cur = pid ? byId.get(pid) : null;
          if (cur && cur.NameOrigin && cur.label !== genusWord) inh.push(cur);
        }
        editEl.querySelector('#de-origin-inherit').innerHTML = inh.slice(0, 2).map(a =>
          '<div style="color:#789;font:11px/1.45 system-ui,sans-serif;margin-top:4px;">'
          + '<b style="color:#9ab;">' + escapeHtml((a.rank ? a.rank + ' ' : '') + a.label) + ':</b> '
          + nameOriginHtml(a.NameOrigin) + '</div>').join('');
      }
      // (dev1152) Name origin / Name say fill AND SAVE themselves for a taxon:
      // no ↓ Use / + add, no ✓ Save. The first time a tag is opened in a session
      // it is looked up again (0.4 s after opening, so arrowing down the list
      // doesn't look up every row passed) and a better answer replaces the old.
      // Text Phil changes is his: ✓ Save stores it with NameOriginEdited /
      // NameSayEdited and no look-up touches it again until he clicks the
      // "edited ✕" flag. A looked-up box is read-only until ✎ Edit (or a
      // double-click), so a stray key can't turn it into an edit.
      const sayBox = editEl.querySelector('#de-namesay');
      const isTaxon = t.kind === 'taxon';
      const NF = {
        origin: { kind: 'origin', field: 'NameOrigin', box: originBox, note: editEl.querySelector('#de-origin-auto') },
        say:    { kind: 'say',    field: 'NameSay',    box: sayBox,    note: editEl.querySelector('#de-namesay-auto') },
      };
      const live = () => selectedId === id && originBox.isConnected;
      const srcLinks = srcs => (srcs || []).map(s => '<a href="' + escapeAttr(s.url) + '" target="_blank" rel="noopener">'
        + escapeHtml(s.name) + '</a>').join(' · ');
      const normName = (st, s) => st.kind === 'say'
        ? String(s || '').split('\n').map(x => x.trim()).filter(Boolean).join('\n') : String(s || '').trim();
      const MINE = 'Your text — look-ups leave it alone.';
      const valueOf = (st, r) => (st.kind === 'origin' ? r && r.draft : r && (r.say || r.partial)) || '';
      const noteFor = (st, r) => {
        const v = valueOf(st, r);
        const retry = r && r.incomplete ? ' (A source didn’t answer — R looks again.)' : '';
        if (st.kind === 'origin') {
          return v ? 'Looked up: ' + srcLinks(r.sources) + ' — saved.' + retry
            : retry ? 'A source didn’t answer — R looks again.'
            : 'No source found for this name (WoRMS, GBIF, Wiktionary, Wikipedia) — ✎ type one.';
        }
        if (r && r.say) return 'From ' + srcLinks(r.sources) + ' — saved.';
        if (v) return 'Published for part of the name only (' + srcLinks(r.sources) + ') — <i>'
          + escapeHtml(r.missing.join(', ')) + '</i> is left as spelled. Saved.';
        return retry ? 'Wikipedia or Wiktionary didn’t answer — R looks again.'
          : 'No published pronunciation (Wikipedia, Wiktionary) — ✎ type one with the ? key.';
      };
      const show = (st, v) => {
        st.box.value = v;
        if (st.kind === 'say') st.box.rows = Math.max(2, v.split('\n').length);
        if (st.box.scrollHeight > st.box.clientHeight) st.box.style.height = (st.box.scrollHeight + 4) + 'px';
      };
      // A look-up → the tag, saved at once. Never over Phil's own text, and
      // never a blank over something already there (a source may be down).
      const applyLook = (st, r) => {
        const cur = byId.get(id);
        const v = valueOf(st, r);
        if (cur && !cur[st.flagKey] && !st.typed && v && cur[st.field] !== v) updateTag(id, { [st.field]: v });
        if (!live()) return;
        if (st.edited() || st.typed) { st.note.textContent = st.edited() ? MINE : ''; return; }
        if (v) show(st, v);
        st.note.innerHTML = noteFor(st, r);
        st.paint();
      };
      const look = (fresh) => Object.values(NF).forEach(st => {
        if (st.edited()) { st.note.textContent = MINE; return; }
        st.note.textContent = '🔎 looking up…';
        autoNameDraft(st.kind, t, fresh).then(r => applyLook(st, r))
          .catch(e => { if (live()) st.note.textContent = 'Look-up failed: ' + (e && e.message || e); });
      });
      // "edited ✕": drop Phil's text and go back to the look-up.
      const revert = async (st) => {
        st.note.textContent = '🔎 looking up…';
        const r = await autoNameDraft(st.kind, t).catch(() => ({ incomplete: true }));
        const v = valueOf(st, r);
        if (!v && r.incomplete) { if (live()) st.note.textContent = 'A source didn’t answer — click ✕ again.'; return; }
        const cur = byId.get(id);
        if (!cur) return;
        delete cur[st.flagKey];
        updateTag(id, { [st.field]: v });
        if (!live()) return;
        st.typed = false;
        st.unlocked = false;
        show(st, v);
        st.note.innerHTML = noteFor(st, r);
        st.paint();
      };
      Object.values(NF).forEach(st => {
        st.flagKey = st.field + 'Edited';
        st.typed = false;
        st.unlocked = false;
        st.flag = editEl.querySelector('[data-name-flag="' + st.kind + '"]');
        st.editBtn = editEl.querySelector('[data-name-edit="' + st.kind + '"]');
        st.edited = () => { const c = byId.get(id); return !!(c && c[st.flagKey]); };
        st.paint = () => {
          if (!isTaxon) return;
          const mine = st.edited() || st.typed;
          st.box.readOnly = !mine && !st.unlocked && !!st.box.value.trim();
          if (st.editBtn) st.editBtn.hidden = !st.box.readOnly;
          st.flag.innerHTML = mine ? '<br><span class="de-name-flag" title="'
            + (st.edited() ? 'You changed this, so no look-up replaces it. Click to drop your text and use the looked-up one.'
                           : 'Changed, not saved yet — ✓ Save makes it yours. Click to put the looked-up text back.')
            + '">edited' + (st.edited() ? '' : ' •') + ' ✕</span>' : '';
          const f = st.flag.querySelector('.de-name-flag');
          if (f) f.addEventListener('click', () => revert(st));
        };
        st.unlock = () => {
          st.unlocked = true;
          st.paint();
          st.box.focus();
          st.box.setSelectionRange(st.box.value.length, st.box.value.length);
        };
        if (st.editBtn) st.editBtn.addEventListener('click', st.unlock);
        st.box.addEventListener('dblclick', () => { if (st.box.readOnly) st.unlock(); });
        st.box.addEventListener('input', () => { if (!st.typed) { st.typed = true; st.paint(); } });
      });
      if (isTaxon) {
        Object.values(NF).forEach(st => { st.paint(); if (st.edited()) st.note.textContent = MINE; });
        if (!NF.origin.edited() || !NF.say.edited()) setTimeout(() => { if (live()) look(false); }, 400);
      }
      // ↻ Look up (R): ask the services again now.
      const lookBtn = editEl.querySelector('#de-names-look');
      if (lookBtn) lookBtn.addEventListener('click', () => {
        if (NF.origin.edited() && NF.say.edited()) {
          if (typeof toast === 'function') toast('Both are your own text — click an “edited ✕” flag to look one up again.', 2500);
          return;
        }
        look(true);
      });

      editEl.querySelector('#de-save').addEventListener('click', () => {
        const patch = {
          label:    editEl.querySelector('#de-label').value.trim(),
          kind:     editEl.querySelector('#de-kind').value,
          rank:     editEl.querySelector('#de-rank').value || undefined,
          parents:  curParents.slice(),
          aliases:  editEl.querySelector('#de-aliases').value.split(',').map(s => s.trim()).filter(Boolean),
          formerly: editEl.querySelector('#de-formerly').value.split(',').map(s => s.trim()).filter(Boolean),
          common:   editEl.querySelector('#de-common').value.trim(),
          extinct:  editEl.querySelector('#de-extinct').checked
        };
        // facts1-3 are NOT in this patch — Xe saves them itself. (dev1152) A name
        // field goes in only when its box differs from what is stored, and on a
        // taxon that makes it Phil's (…Edited) — emptied too, so a rejected
        // look-up doesn't come back. Looked-up text is already saved.
        const stored = byId.get(id) || t;
        Object.values(NF).forEach(st => {
          const v = normName(st, st.box.value);
          if (v === normName(st, stored[st.field])) return;
          patch[st.field] = v;
          if (isTaxon) patch[st.flagKey] = true;
        });
        const r = updateTag(id, patch);
        if (r.ok) {
          if (typeof toast === 'function') toast('✓ Saved: ' + patch.label, 1000);
          if (typeof render === 'function') render();
          renderView();
          selectTag(id);
        } else {
          if (typeof toast === 'function') toast('Save failed: ' + r.err);
        }
      });
      editEl.querySelector('#de-merge').addEventListener('click', () => {
        openMergeModal(id, () => {
          // After successful merge, the source tag is gone. Clear selection.
          selectedId = null;
          renderView();
          editEl.innerHTML = '<div style="color:#777;">(select a tag)</div>';
        });
      });
      editEl.querySelector('#de-del').addEventListener('click', () => {
        if (!confirm('Delete tag "' + t.label + '"?\nIt will be removed from ' + use + ' video record(s).')) return;
        const r = deleteTag(id);
        if (r.ok) {
          if (typeof toast === 'function') toast('✓ Deleted (removed from ' + r.removedFromRecords + ' records)', 1400);
          if (typeof render === 'function') render();
          selectedId = null;
          renderView();
          editEl.innerHTML = '<div style="color:#777;">(select a tag)</div>';
        }
      });
      // GBIF check (only present for taxa)
      const gbifBtn = editEl.querySelector('#de-gbif');
      if (gbifBtn) {
        gbifBtn.addEventListener('click', async () => {
          const resultEl = editEl.querySelector('#de-gbif-result');
          // Read whatever's currently in the label field (even unsaved edits)
          const queryName = editEl.querySelector('#de-label').value.trim() || t.label;
          resultEl.innerHTML = '<div style="padding:10px;color:#888;font-size:11px;">🔎 Querying GBIF…</div>';
          gbifBtn.disabled = true;
          try {
            const resolution = await resolveTaxon(queryName, {
              rankHint: editEl.querySelector('#de-rank').value || t.rank || null,
              compare: true,
              vernacular: true
            });
            const res = resolution.primary || { matchType: 'NONE', _source: 'worms' };
            renderTaxonResult(resultEl, id, queryName, res, resolution);
          } catch (e) {
            resultEl.innerHTML = '<div style="padding:10px 12px;background:rgba(255,80,80,0.1);border:1px solid #533;border-radius:5px;color:#f88;font-size:11px;">'
              + 'GBIF request failed: ' + escapeHtml(String(e && e.message || e))
              + '<br><span style="color:#777;">Check internet connection. GBIF API may be temporarily unreachable.</span></div>';
          } finally {
            gbifBtn.disabled = false;
          }
        });
      }
      editEl.querySelector('#de-viewrecs').addEventListener('click', () => {
        // Set hierarchical tag filter (matches descendants too) and close dict
        if (typeof window.setRowFilter === 'function') {
          window.setRowFilter({ col: 'tags', val: t.id, hierarchical: true });
        }
        window.closeDictionary();
        if (typeof window.toast === 'function') {
          window.toast('🔍 Filtered table to "' + t.label + '" (and descendants)\nPress E to edit, A to annotate, click filter ✕ in toolbar to clear', 3000);
        }
      });
    }

    search.addEventListener('input', () => {
      // New search invalidates keyboard focus
      keyboardFocusedId = null;
      _searchClosed.clear();
      if (!search.value.trim()) revealSelected();
      renderView();
    });
    // (dev1152) After the filter is cleared, keep the open tag in sight: its
    // ancestors open (the search opened them only for itself).
    function revealSelected() {
      if (selectedId && byId.get(selectedId)) tagAncestors(selectedId).forEach(a => expandedNodes.add(a));
    }
    function scrollSelectedIntoView() {
      const el = selectedId && listEl.querySelector('[data-tag-id="' + selectedId + '"]');
      if (el) el.scrollIntoView({ block: 'center' });
    }
    // F: the search text is D's only filter.
    function clearFilters() {
      const had = !!search.value.trim();
      search.value = '';
      _searchClosed.clear();
      revealSelected();
      renderView();
      scrollSelectedIntoView();
      if (typeof toast === 'function') toast(had ? 'Filter cleared' : 'No filter to clear', 900);
    }
    // (dev0847) Taxon info panel — the Tier 1 note/wiki/IUCN store. Lives in
    // taxoninfo.js and its own taxoninfo.json, deliberately NOT in tags.json:
    // saveTags() rewrites this whole array on every edit, so prose does not
    // belong on that path. Wired HERE, with the other one-time overlay buttons,
    // and NOT in the edit-panel render — that re-runs per selected tag and would
    // stack a fresh listener each time, so one click would toggle the panel open,
    // shut, open again, once per tag ever selected.
    const tiBtn = dictOverlay.querySelector('#dictTaxonInfo');
    if (tiBtn) {
      tiBtn.addEventListener('click', () => {
        if (window.taxonInfo && typeof window.taxonInfo.openPanel === 'function') {
          window.taxonInfo.openPanel();
        } else if (typeof toast === 'function') {
          toast('taxoninfo.js not loaded', 2000);
        }
      });
    }
    // (dev1149) 🔎 Fill names — Name origin for every taxon that has NONE
    // (absent, not ''), so a hand-written or cleared one is never touched.
    // (dev1151) Name say too, wherever a published pronunciation exists.
    // Writes once at the end (withBatchedSave). The open tag's boxes are only
    // filled if still empty, so nothing typed there is replaced.
    const fnBtn = dictOverlay.querySelector('#dictFillNames');
    if (fnBtn) {
      fnBtn.addEventListener('click', async () => {
        const todo = tagsArr.filter(x => x.kind === 'taxon' && x.NameOrigin === undefined);
        const todoSay = tagsArr.filter(x => x.kind === 'taxon' && x.NameSay === undefined);
        const say = (s, ms) => { if (typeof toast === 'function') toast(s, ms || 8000); };
        if (!todo.length && !todoSay.length) { say('Every taxon already has a Name origin and a Name say.', 2500); return; }
        fnBtn.disabled = true;
        say('🔎 Fill names: looking up ' + Math.max(todo.length, todoSay.length) + ' taxa — about '
          + Math.max(5, Math.round(todo.length / 6 + todoSay.length / 4)) + ' s…');
        try {
          const ti = window.taxonInfo;
          if (ti && ti.load && ti.loaded && !ti.loaded()) await ti.load().catch(() => {});
          const res = todo.length ? await lookupNameOrigins(todo, s => say('🔎 Fill names (' + todo.length + '): ' + s)) : new Map();
          const resSay = todoSay.length ? await lookupNameSays(todoSay, s => say('🔎 Fill names (' + todoSay.length + '): ' + s)) : new Map();
          let n = 0, nSay = 0;
          withBatchedSave(() => {
            todo.forEach(x => {
              const r = res.get(x.id), cur = byId.get(x.id);
              if (r && r.draft && cur && cur.NameOrigin === undefined) { updateTag(x.id, { NameOrigin: r.draft }); n++; }
            });
            todoSay.forEach(x => {
              const r = resSay.get(x.id), cur = byId.get(x.id);
              if (r && r.say && cur && cur.NameSay === undefined) { updateTag(x.id, { NameSay: r.say }); nSay++; }
            });
          });
          if (selectedId && editEl) {
            const cur = byId.get(selectedId);
            const box = editEl.querySelector('#de-nameorigin'), sBox = editEl.querySelector('#de-namesay');
            if (box && !box.value.trim() && cur && cur.NameOrigin) box.value = cur.NameOrigin;
            if (sBox && !sBox.value.trim() && cur && cur.NameSay) sBox.value = cur.NameSay;
          }
          say('✓ Name origin filled on ' + n + ' of ' + todo.length + ' taxa; Name say on ' + nSay + ' of ' + todoSay.length
            + (nSay < todoSay.length ? ' (the rest have no published pronunciation)' : '') + '.', 8000);
        } catch (e) {
          say('Fill names failed: ' + (e && e.message || e), 5000);
        } finally {
          fnBtn.disabled = false;
        }
      });
    }
    dictOverlay.querySelector('#dictClose').addEventListener('click', () => window.closeDictionary());
    dictOverlay.querySelector('#dictEcology').addEventListener('click', () => openEcologyPanel());
    dictOverlay.querySelector('#dictNormalize').addEventListener('click', () => openNormalizePanel());

    // ── Keyboard navigation: ↓/↑ move focus, Enter selects, Tab → edit panel ───
    //
    // From search input or focused row:
    //   ↓  : focus next visible row
    //   ↑  : focus previous visible row (or back to search if at top)
    //   Enter (on focused row) : selectTag → loads into edit panel
    //   Tab : move to first input on the right side (edit panel)
    //   Esc : (handled by document-level handler) closes overlay

    function getVisibleRowIds() {
      // Returns array of tag IDs in visual order — works for both list + tree.
      // We read whatever the rendered DOM shows so it always matches what user sees.
      return [...listEl.querySelectorAll('[data-tag-id]')]
        .map(el => el.dataset.tagId)
        .filter(id => id && id !== '__unsorted__' && byId.get(id));
    }

    function setKbFocus(id, scrollIntoView) {
      keyboardFocusedId = id;
      // Mirror keyboard focus into the right edit panel — arrow keys = browse mode
      if (id && byId.get(id)) {
        selectTag(id);  // this also calls renderView()
      } else {
        renderView();
      }
      if (id && scrollIntoView) {
        const el = listEl.querySelector('[data-tag-id="' + id + '"]');
        if (el) {
          el.scrollIntoView({ block: 'nearest', behavior: 'auto' });
        }
      }
    }

    // ── Keyboard navigation: regions, Tab confinement, T/G escape ─────────
    //
    // Three regions: header (search + view buttons + close), left panel
    // (list/tree of tags), right panel (edit form). Tab confined to the
    // currently-active region — never escapes to browser chrome.
    //
    // Left panel:
    //   ↑/↓     : move keyboard focus between visible rows
    //   ←       : (tree only) collapse focused node, or jump to parent
    //   →       : (tree only) expand focused node, or jump to first child
    //   Enter   : load focused tag into right panel (selectTag)
    //   Delete  : remove focused tag (with confirm)
    //   Tab     : jump to right panel
    //   T or G  : close dictionary, switch to Table or Grid screen
    //
    // Right panel:
    //   Tab/Shift-Tab : cycle focusable elements within right panel
    //   T or G  : (when not in text field) close dictionary, go to T/G
    //
    // Search input:
    //   ↓       : jump into list (focus first row)
    //   Enter   : same as ↓ (focus first match)
    //   T/G keys: typed normally (it's a text field)

    function isTextField(el) {
      if (!el) return false;
      const tag = el.tagName;
      if (el.readOnly) return false;     // (dev1152) a looked-up name box until ✎ Edit
      if (tag === 'TEXTAREA') return true;
      if (tag === 'INPUT') {
        const type = (el.type || 'text').toLowerCase();
        // Real text-bearing input types
        return ['text','search','email','url','tel','password','number'].includes(type);
      }
      // contentEditable elements
      if (el.isContentEditable) return true;
      return false;
    }

    function inRightPanel(el) {
      return !!(el && editEl.contains(el));
    }
    function inLeftPanel(el) {
      return !!(el && listEl.contains(el));
    }
    function inHeader(el) {
      const hdr = dictOverlay.querySelector(':scope > div:first-child');
      return !!(hdr && el && hdr.contains(el));
    }

    function focusableInRightPanel() {
      // All inputs, selects, textareas, and buttons inside the right panel.
      // Filters out hidden/disabled and anything inside a closed <details>.
      return [...editEl.querySelectorAll('input, select, textarea, button')]
        .filter(el => !el.disabled && el.offsetParent !== null);
    }

    function focusFirstEditField() {
      const items = focusableInRightPanel();
      if (!items.length) return false;
      // Prefer the label input if present (most common entry point)
      const lbl = editEl.querySelector('#de-label');
      if (lbl && items.includes(lbl)) { lbl.focus(); lbl.select(); return true; }
      items[0].focus();
      return true;
    }

    function cycleRightPanelTab(currentEl, reverse) {
      const items = focusableInRightPanel();
      if (!items.length) return false;
      const idx = items.indexOf(currentEl);
      if (idx < 0) {
        // Not currently in panel — focus first
        items[0].focus();
        return true;
      }
      const nextIdx = reverse
        ? (idx === 0 ? items.length - 1 : idx - 1)
        : (idx === items.length - 1 ? 0 : idx + 1);
      items[nextIdx].focus();
      return true;
    }

    // Scroll a tag's row into view in the left panel.
    function scrollKbFocusIntoView() {
      if (!keyboardFocusedId) return;
      const el = listEl.querySelector('[data-tag-id="' + keyboardFocusedId + '"]');
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }

    function handleNavKey(e, sourceIsSearch) {
      // Don't hijack keys while a chip-input dropdown is open (it has its own ↑↓)
      if (document.querySelector('.tag-dd')) return false;

      if (e.key === 'ArrowDown') {
        const ids = getVisibleRowIds();
        if (!ids.length) return false;
        let idx = keyboardFocusedId ? ids.indexOf(keyboardFocusedId) : -1;
        idx = Math.min(idx + 1, ids.length - 1);
        if (idx < 0) idx = 0;
        e.preventDefault(); e.stopPropagation();
        if (sourceIsSearch) search.blur();
        setKbFocus(ids[idx], true);
        return true;
      }
      if (e.key === 'ArrowUp') {
        const ids = getVisibleRowIds();
        if (!ids.length) return false;
        let idx = keyboardFocusedId ? ids.indexOf(keyboardFocusedId) : -1;
        if (sourceIsSearch || idx <= 0) {
          e.preventDefault(); e.stopPropagation();
          setKbFocus(null, false);
          search.focus();
          return true;
        }
        e.preventDefault(); e.stopPropagation();
        setKbFocus(ids[idx - 1], true);
        return true;
      }

      // ←/→ : tree collapse/expand or move to parent/child
      if (e.key === 'ArrowRight' && keyboardFocusedId && viewMode === 'tree') {
        const t = byId.get(keyboardFocusedId);
        if (!t) return false;
        const childrenByParent = new Map();
        tagsArr.forEach(x => (x.parents || []).forEach(p => {
          if (!childrenByParent.has(p)) childrenByParent.set(p, []);
          childrenByParent.get(p).push(x);
        }));
        const kids = childrenByParent.get(keyboardFocusedId) || [];
        if (kids.length && !isOpen(keyboardFocusedId)) {
          e.preventDefault(); e.stopPropagation();
          setOpen(keyboardFocusedId, true);
          renderView();
          return true;
        }
        if (kids.length && isOpen(keyboardFocusedId)) {
          // Already expanded → move focus into first child (that the filter shows)
          const shown = new Set(getVisibleRowIds());
          const vis = kids.filter(k => shown.has(k.id)).sort((a, b) => a.label.localeCompare(b.label));
          if (!vis.length) return false;
          e.preventDefault(); e.stopPropagation();
          setKbFocus(vis[0].id, true);
          return true;
        }
        return false;
      }
      if (e.key === 'ArrowLeft' && keyboardFocusedId && viewMode === 'tree') {
        const t = byId.get(keyboardFocusedId);
        if (!t) return false;
        if (isOpen(keyboardFocusedId)) {
          // Currently expanded → collapse it
          e.preventDefault(); e.stopPropagation();
          setOpen(keyboardFocusedId, false);
          renderView();
          return true;
        }
        // Already collapsed (or no children) → jump up to parent
        if ((t.parents || []).length) {
          e.preventDefault(); e.stopPropagation();
          setKbFocus(t.parents[0], true);
          return true;
        }
        return false;
      }

      if (e.key === 'Enter' && keyboardFocusedId) {
        e.preventDefault(); e.stopPropagation();
        selectTag(keyboardFocusedId);
        return true;
      }

      // Cancel pending cut via Escape (only when no menus or modals are up)
      if (e.key === 'Escape' && _cutTagId && !sourceIsSearch) {
        if (!_treeMenu) {
          e.preventDefault(); e.stopPropagation();
          if (typeof toast === 'function') toast('✂ Cut canceled', 900);
          clearCut();
          return true;
        }
      }

      // Cut / Paste / Delete shortcuts on the focused row.
      // Only fire when not in search and a row is focused.
      if (keyboardFocusedId && !sourceIsSearch) {
        // Delete key: same as before (legacy path) → defer to deleteTagWithConfirm
        if (e.key === 'Delete') {
          e.preventDefault(); e.stopPropagation();
          deleteTagWithConfirm(keyboardFocusedId);
          return true;
        }
        // Letter shortcuts mirroring the right-click menu
        const k = e.key.toLowerCase();
        if (k === 'c') {
          e.preventDefault(); e.stopPropagation();
          setCut(keyboardFocusedId);
          return true;
        }
        if (k === 'a' && _cutTagId) {
          // Paste-same-rank only if there's a pending cut and target valid
          if (_cutTagId === keyboardFocusedId) return true;
          if (tagDescendants(_cutTagId).has(keyboardFocusedId)) return true;
          e.preventDefault(); e.stopPropagation();
          pasteAtSameRank(keyboardFocusedId);
          return true;
        }
        if (k === 's' && _cutTagId) {
          if (_cutTagId === keyboardFocusedId) return true;
          if (tagDescendants(_cutTagId).has(keyboardFocusedId)) return true;
          e.preventDefault(); e.stopPropagation();
          pasteAtLowerRank(keyboardFocusedId);
          return true;
        }
        if (k === 'd') {
          e.preventDefault(); e.stopPropagation();
          deleteTagWithConfirm(keyboardFocusedId);
          return true;
        }
      }

      if (e.key === 'Tab' && !e.shiftKey) {
        if (focusFirstEditField()) {
          e.preventDefault(); e.stopPropagation();
          return true;
        }
      }
      return false;
    }

    // Search-input keys
    search.addEventListener('keydown', (e) => {
      if (handleNavKey(e, true)) return;
    });

    // Document-level handler dispatches based on current focus location.
    dictOverlay._navHandler = (e) => {
      const ae = document.activeElement;
      // If a chip-autocomplete dropdown is open or merge modal is open, defer
      if (document.querySelector('.tag-dd')) return;
      if (document.getElementById('mergeModal')) return;
      // (dev1148) Xe (Facts editing) or Xs on top owns the keyboard. Both
      // listeners are document-capture and D's registered first, so without
      // this T/G and the arrow keys would act on D while typing in Xe.
      if (document.getElementById('textEditorOverlay') || document.getElementById('teSlideOverlay')) return;

      // (dev1152) Whenever the key isn't going into a text box:
      //   f = to the search (filter) box   F = clear the filter
      //   R = look the open taxon's Name origin + Name say up again
      if (!e.ctrlKey && !e.altKey && !e.metaKey && !isTextField(ae) && !document.getElementById('treeCtxMenu')
          && (e.key === 'f' || e.key === 'F' || e.key === 'r' || e.key === 'R')) {
        e.preventDefault(); e.stopPropagation();
        if (e.key === 'f') { search.focus(); search.select(); }
        else if (e.key === 'F') clearFilters();
        else {
          const b = editEl.querySelector('#de-names-look');
          if (b) b.click();
          else if (typeof toast === 'function') toast('R looks up the names of the open taxon', 1500);
        }
        return;
      }

      // Right panel: confine Tab cycling, allow T/G escape only when NOT in text field
      if (inRightPanel(ae)) {
        if (e.key === 'Tab') {
          // If the focused input is inside a chip-input container, let the
          // chip-input handle Tab itself (it commits dropdown selections etc.)
          // We'll cycle to the next right-panel item AFTER the chip input is done.
          if (ae.closest && ae.closest('.tag-chip-input')) {
            // Don't preventDefault; default-Tab will move focus to the next focusable.
            // But the next focusable might be outside our panel — schedule a
            // post-tab check that re-confines focus.
            setTimeout(() => {
              const newAe = document.activeElement;
              if (!inRightPanel(newAe)) {
                cycleRightPanelTab(ae, e.shiftKey);
              }
            }, 0);
            return;
          }
          e.preventDefault(); e.stopPropagation();
          cycleRightPanelTab(ae, e.shiftKey);
          return;
        }
        // T/G escape — only when not in a text field (so users can type "T" or "G" in label/aliases/etc.)
        if (!isTextField(ae)) {
          const k = e.key.toLowerCase();
          if (k === 't' || k === 'g') {
            e.preventDefault(); e.stopPropagation();
            window.closeDictionary();
            // Hand off to the master hotkey dispatcher
            if (window._executeHotkey) setTimeout(() => window._executeHotkey(k), 10);
            return;
          }
        }
        return; // otherwise let the field handle the key naturally
      }

      // Header: Tab cycles within header buttons. Default browser behavior is fine
      // for plain Tab as long as we manually wrap when reaching the boundaries.
      if (inHeader(ae) && ae !== search) {
        if (e.key === 'Tab') {
          const headerEls = [...dictOverlay.querySelector(':scope > div:first-child').querySelectorAll('input, button')]
            .filter(el => !el.disabled && el.offsetParent !== null);
          const i = headerEls.indexOf(ae);
          if (i >= 0) {
            e.preventDefault(); e.stopPropagation();
            const nextI = e.shiftKey ? (i === 0 ? headerEls.length - 1 : i - 1)
                                     : (i === headerEls.length - 1 ? 0 : i + 1);
            headerEls[nextI].focus();
          }
          return;
        }
      }

      // Search field: route to handleNavKey (handles ↓ / Tab to right panel)
      if (ae === search) return;  // search has its own keydown listener

      // Otherwise: left panel context (no element focused, or focused row).
      // T/G escape when not in a text field
      if (!isTextField(ae)) {
        const k = e.key.toLowerCase();
        if (k === 't' || k === 'g') {
          e.preventDefault(); e.stopPropagation();
          window.closeDictionary();
          if (window._executeHotkey) setTimeout(() => window._executeHotkey(k), 10);
          return;
        }
      }
      handleNavKey(e, false);
    };
    document.addEventListener('keydown', dictOverlay._navHandler, true);

    // (zip0158) Single-button toggle. Flips between tree and list, updates
    // label, then re-renders. Was a two-button selector that needed to
    // diff against the previously-active button.
    const _vbtn = dictOverlay.querySelector('#view-toggle');
    if (_vbtn) {
      _vbtn.addEventListener('click', () => {
        viewMode = (viewMode === 'tree') ? 'list' : 'tree';
        _vbtn.dataset.view = viewMode;
        _vbtn.textContent = (viewMode === 'tree') ? '🌳 Tree' : '☰ List';
        _vbtn.title = (viewMode === 'tree') ? 'Tree view — click for List' : 'List view — click for Tree';
        renderView();
      });
    }
    dictOverlay.querySelector('#dictAdd').addEventListener('click', () => {
      const label = prompt('New tag — label:');
      if (!label) return;
      const kind = prompt('Kind: taxon, topic, technique, place, person, other', 'topic') || 'topic';
      const r = createTag({ label: label.trim(), kind: kind.trim() });
      if (r.ok) { renderView(); selectTag(r.id); }
      else if (typeof toast === 'function') toast('Create failed: ' + r.err);
    });
    // Document-level Escape handler — survives focus changes within the overlay.
    // Bail when a chip-autocomplete dropdown or the merge modal is open; those
    // have their own Escape handling and should close first.
    dictOverlay._escHandler = (e) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('.tag-dd')) return;
      if (document.getElementById('mergeModal')) return;
      // (dev1148) Esc in Xe/Xs closes that layer only, not the dictionary under it.
      if (document.getElementById('textEditorOverlay') || document.getElementById('teSlideOverlay')) return;
      e.preventDefault();
      e.stopPropagation();
      window.closeDictionary();
    };
    document.addEventListener('keydown', dictOverlay._escHandler, true);
    // Panels that rewrite the graph from outside this closure (Normalize,
    // Ecology) need a way to redraw the list they just invalidated.
    dictOverlay._renderView = renderView;
    renderView();
    // Restore scroll position
    if (_dictState.scrollTop && listEl) {
      listEl.scrollTop = _dictState.scrollTop;
    }
    // If a tag was previously loaded into the right panel, repopulate it
    if (selectedId && byId.get(selectedId)) {
      selectTag(selectedId);
      // Re-restore scroll because selectTag re-renders
      if (_dictState.scrollTop && listEl) listEl.scrollTop = _dictState.scrollTop;
    }
    // Restore focus: kb-focused row stays in left panel; otherwise focus search
    setTimeout(() => {
      if (keyboardFocusedId && byId.get(keyboardFocusedId)) {
        // Left-panel focus mode: scroll the focused row into view, don't grab
        // text input focus (search would steal arrow keys)
        const el = listEl.querySelector('[data-tag-id="' + keyboardFocusedId + '"]');
        if (el) el.scrollIntoView({ block: 'nearest' });
      } else {
        search.focus();
        if (search.value) search.select();
      }
    }, 40);
  };

  window.closeDictionary = function () {
    if (dictOverlay) {
      // Persist UI state so a return trip lands the user in the same spot
      if (dictOverlay._snapshot) {
        try { dictOverlay._snapshot(); } catch(e) { console.warn('dict snapshot failed:', e); }
      }
      if (dictOverlay._escHandler) {
        document.removeEventListener('keydown', dictOverlay._escHandler, true);
      }
      if (dictOverlay._navHandler) {
        document.removeEventListener('keydown', dictOverlay._navHandler, true);
      }
      dictOverlay.remove();
      dictOverlay = null;
    }
  };

  // ── Merge modal ──────────────────────────────────────────────────────────
  // Shown when user clicks "↗ Merge into…" on a tag in the Dictionary.
  // `onDone` callback is called after a successful merge (so the dict list can refresh).
  function openMergeModal(fromId, onDone) {
    const from = byId.get(fromId);
    if (!from) return;

    // Count records tagged with fromId (for the summary)
    let recordCount = 0;
    if (typeof data !== 'undefined') {
      data.forEach(r => { if (Array.isArray(r.tags) && r.tags.includes(fromId)) recordCount++; });
    }
    // Source aliases that will be carried over
    const carryOver = [from.label, from.common || '', ...(from.aliases || []), ...(from.formerly || [])].filter(Boolean);
    const childCount = tagsArr.filter(t => (t.parents || []).includes(fromId)).length;

    // Descendants set — cannot pick any of these as target (would create a cycle)
    const forbidden = new Set([fromId]);
    tagDescendants(fromId).forEach(id => forbidden.add(id));

    let targetId = null;

    const modal = document.createElement('div');
    modal.id = 'mergeModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:30500;background:rgba(0,0,0,0.72);'
      + 'display:flex;align-items:center;justify-content:center;font-family:monospace;';
    modal.innerHTML = `
      <div style="background:#141428;border:2px solid #fc8;border-radius:10px;padding:20px 22px;min-width:460px;max-width:580px;color:#ddd;box-shadow:0 10px 40px rgba(0,0,0,0.8);">
        <h3 style="color:#fc8;margin:0 0 4px;font-size:15px;">↗ Merge tag</h3>
        <div style="color:#888;font-size:12px;margin-bottom:14px;">
          Merge <span style="color:${kindColor(from)};">“${escapeHtml(from.label)}”</span> into another tag.
        </div>

        <div style="background:rgba(255,200,100,0.06);border:1px solid #543;border-radius:6px;padding:9px 12px;margin-bottom:14px;font-size:11px;color:#bb9;line-height:1.55;">
          This will:<br>
          • Re-tag <b style="color:#fc8;">${recordCount}</b> video record${recordCount === 1 ? '' : 's'} from “${escapeHtml(from.label)}” to the target<br>
          • Add <b style="color:#fc8;">${carryOver.length}</b> name${carryOver.length === 1 ? '' : 's'} (“${escapeHtml(from.label)}”${from.common ? `, common: “${escapeHtml(from.common)}”` : ''}${(from.aliases || []).length ? `, aliases: ${(from.aliases || []).map(a => '“'+escapeHtml(a)+'”').join(', ')}` : ''}) as aliases of the target
          ${childCount > 0 ? `<br>• Re-point <b style="color:#fc8;">${childCount}</b> child tag${childCount === 1 ? '' : 's'} to the target` : ''}
          <br>• <b style="color:#f88;">Delete “${escapeHtml(from.label)}”</b> from the dictionary
        </div>

        <label style="color:#8ef;font-size:12px;display:block;margin-bottom:5px;">Merge into <span style="color:#555;font-size:10px;">(type to search — Enter to pick, Enter again to confirm)</span></label>
        <div id="merge-picker" style="margin-bottom:4px;"></div>
        <div id="merge-preview" style="font-size:11px;color:#666;min-height:16px;margin-bottom:16px;"></div>

        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button id="merge-cancel" style="padding:7px 18px;border:1px solid #666;background:rgba(40,40,60,0.5);color:#ccc;border-radius:5px;cursor:pointer;font-family:monospace;font-size:12px;">Cancel (Esc)</button>
          <button id="merge-go" style="padding:7px 22px;border:1px solid #fc8;background:rgba(80,50,0,0.35);color:#fc8;border-radius:5px;cursor:pointer;font-family:monospace;font-size:12px;font-weight:bold;opacity:0.4;" disabled>↗ Merge</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const picker = modal.querySelector('#merge-picker');
    const previewEl = modal.querySelector('#merge-preview');
    const goBtn = modal.querySelector('#merge-go');

    function setTarget(newId) {
      targetId = newId;
      if (newId) {
        const t = byId.get(newId);
        const preview = t
          ? ('→ <span style="color:' + kindColor(t) + ';">' + escapeHtml(labelFor(t.id)) + '</span>'
             + (t.kind === 'taxon' && t.rank ? ' <span style="color:#555;font-size:10px;">(' + t.rank + ')</span>' : '')
             + (t.common ? ' <span style="color:#777;">common: ' + escapeHtml(t.common) + '</span>' : ''))
          : '';
        previewEl.innerHTML = preview;
        goBtn.disabled = false;
        goBtn.style.opacity = '1';
      } else {
        previewEl.textContent = '';
        goBtn.disabled = true;
        goBtn.style.opacity = '0.4';
      }
    }

    // Mount a single-select chip input — any new selection replaces the previous
    window.mountTagChipInput({
      container: picker,
      getIds: () => targetId ? [targetId] : [],
      setIds: (next) => {
        // Keep only the last selection (single-select semantics)
        setTarget(next.length ? next[next.length - 1] : null);
      },
      placeholder: 'target tag…',
      filter: (id) => !forbidden.has(id)
    });

    function performMerge() {
      if (!targetId) return;
      const r = mergeTag(fromId, targetId);
      if (r.ok) {
        if (typeof toast === 'function') {
          toast('✓ Merged “' + from.label + '” → “' + (byId.get(targetId) ? byId.get(targetId).label : targetId) + '”'
            + '\n' + r.recordsChanged + ' record' + (r.recordsChanged === 1 ? '' : 's')
            + ', ' + r.aliasesAdded + ' alias' + (r.aliasesAdded === 1 ? '' : 'es') + ' added'
            + (r.childrenMoved ? ', ' + r.childrenMoved + ' child tag' + (r.childrenMoved === 1 ? '' : 's') + ' re-pointed' : ''), 3000);
        }
        if (typeof render === 'function') render();
        closeMerge();
        if (typeof onDone === 'function') onDone(targetId);
      } else {
        if (typeof toast === 'function') toast('Merge failed: ' + r.err, 2200);
      }
    }

    function closeMerge() {
      document.removeEventListener('keydown', escHandler, true);
      modal.remove();
    }
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        // Don't swallow if autocomplete dropdown is open
        if (document.querySelector('.tag-dd')) return;
        e.preventDefault();
        e.stopPropagation();
        closeMerge();
      } else if (e.key === 'Enter' && targetId && !document.querySelector('.tag-dd')) {
        // Second Enter (dropdown closed, target picked) → commit merge
        e.preventDefault();
        e.stopPropagation();
        performMerge();
      }
    };
    document.addEventListener('keydown', escHandler, true);

    modal.querySelector('#merge-cancel').addEventListener('click', closeMerge);
    modal.querySelector('#merge-go').addEventListener('click', performMerge);

    // Focus the picker input
    setTimeout(() => {
      const inp = modal.querySelector('#merge-picker input');
      if (inp) inp.focus();
    }, 30);
  }

  // ── Ecology Groups panel ─────────────────────────────────────────────────
  // Lists each ecology group (fish, bird, mammal …), shows which class taxa
  // exist in the dictionary, whether they're wired as children of the group
  // tag, and offers Create / Wire actions. Solves the "I created 'bird' but
  // filtering by it shows nothing" problem by giving visibility + one-click
  // wiring of all classes that match CLASS_TO_GROUP.
  function openEcologyPanel() {
    let modal = document.getElementById('ecologyPanel');
    if (modal) { modal.remove(); return; }  // toggle
    modal = document.createElement('div');
    modal.id = 'ecologyPanel';
    modal.style.cssText = 'position:fixed;inset:0;z-index:31500;background:rgba(5,5,14,0.78);'
      + 'display:flex;align-items:flex-start;justify-content:center;padding-top:50px;';

    // Build group→classes index from CLASS_TO_GROUP
    const groupToClasses = {};
    Object.entries(CLASS_TO_GROUP).forEach(([cls, grp]) => {
      if (!groupToClasses[grp]) groupToClasses[grp] = [];
      groupToClasses[grp].push(cls);
    });

    // ── Auto-create-and-wire ALL standard groups in one shot ──────────────
    function autoWireAll() {
      let created = 0, wired = 0;
      withBatchedSave(() => Object.keys(groupToClasses).forEach(grp => {
        let gid = resolveInput(grp);
        if (!gid) {
          const r = createTag({ label: grp, kind: 'group' });
          if (r.ok) { gid = r.id; created++; }
        }
        if (!gid) return;
        groupToClasses[grp].forEach(cls => {
          const cid = resolveInput(cls);
          if (!cid) return;
          const tag = byId.get(cid);
          if (tag && !(tag.parents || []).includes(gid)) {
            updateTag(cid, { parents: [...(tag.parents || []), gid] });
            wired++;
          }
        });
      }));
      toast('✓ Standard groups: ' + created + ' created, ' + wired + ' classes wired', 2200);
      build();
    }

    function build() {
      // ── Standard-group sections ──────────────────────────────────────────
      const stdHtml = Object.keys(groupToClasses).sort().map(grp => {
        const classes = groupToClasses[grp];
        const groupId  = resolveInput(grp);
        const groupTag = groupId ? byId.get(groupId) : null;
        const rows = classes.map(cls => {
          const cid  = resolveInput(cls);
          const tag  = cid ? byId.get(cid) : null;
          const wired = tag && groupId && (tag.parents || []).includes(groupId);
          const useCount = (cid && typeof data !== 'undefined')
            ? data.reduce((n, r) => n + (recordMatchesTagQuery(r.tags, cid) ? 1 : 0), 0)
            : 0;
          return { cls, cid, tag, wired, useCount };
        });
        const presentClasses = rows.filter(r => r.tag);
        const unwiredPresent = rows.filter(r => r.tag && !r.wired);
        const groupUse = groupId
          ? data.reduce((n, r) => n + (recordMatchesTagQuery(r.tags, groupId) ? 1 : 0), 0)
          : 0;

        const badge = !groupTag
          ? '<span style="color:#f88;font-size:11px;">✗ no tag yet</span>'
          : '<span style="color:#afa;font-size:11px;">✓</span> <span style="color:#888;font-size:11px;">' + groupUse + ' rows</span>';

        const classRows = rows.map(r => {
          if (!r.tag) return '<span style="color:#555;font-size:10px;">' + escapeHtml(r.cls) + '(—)</span>';
          const dot = r.wired ? '<span style="color:#5f5;">✓</span>' : '<span style="color:#fc6;">○</span>';
          const wire = (!r.wired && groupTag)
            ? ' <button data-act="wire-one" data-cls-id="'+escapeAttr(r.cid)+'" data-grp-id="'+escapeAttr(groupId)+'"'
              + ' style="padding:0 5px;border:1px solid #5f5;background:rgba(0,80,0,0.4);color:#afa;border-radius:3px;cursor:pointer;font-size:10px;">wire</button>'
            : '';
          return dot + ' <span style="color:#ccd;font-size:11px;">'+escapeHtml(r.cls)+'</span>'
            + ' <span style="color:#666;font-size:10px;">('+r.useCount+')</span>' + wire;
        }).join(' &nbsp;│&nbsp; ');

        const actBtns = [];
        if (!groupTag && presentClasses.length)
          actBtns.push('<button data-act="create-and-wire" data-grp="'+escapeAttr(grp)+'" data-cls-ids="'+escapeAttr(presentClasses.map(r=>r.cid).join(','))+'"'
            + ' style="padding:3px 9px;border:1px solid #8cf;background:rgba(0,40,80,0.45);color:#8cf;border-radius:4px;cursor:pointer;font-size:11px;">Create + wire all</button>');
        else if (!groupTag)
          actBtns.push('<button data-act="create-group" data-grp="'+escapeAttr(grp)+'"'
            + ' style="padding:3px 9px;border:1px solid #5f5;background:rgba(0,80,0,0.4);color:#afa;border-radius:4px;cursor:pointer;font-size:11px;">+ Create group tag</button>');
        if (groupTag && unwiredPresent.length)
          actBtns.push('<button data-act="wire-all" data-grp-id="'+escapeAttr(groupId)+'" data-cls-ids="'+escapeAttr(unwiredPresent.map(r=>r.cid).join(','))+'"'
            + ' style="padding:3px 9px;border:1px solid #fc8;background:rgba(80,50,0,0.4);color:#fc8;border-radius:4px;cursor:pointer;font-size:11px;">Wire '+unwiredPresent.length+' unwired</button>');

        return '<div style="padding:8px 12px;margin-bottom:8px;background:rgba(255,255,255,0.02);border:1px solid #2a2a3a;border-radius:5px;">'
          + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">'
          +   '<span style="color:#fc8;font-weight:bold;min-width:90px;">'+escapeHtml(grp)+'</span>'
          +   badge
          +   (actBtns.length ? '<span style="flex:1;"></span>' + actBtns.join(' ') : '')
          + '</div>'
          + '<div style="margin-top:5px;line-height:1.8;">' + classRows + '</div>'
          + '</div>';
      }).join('');

      // ── All existing kind:'group' tags (including custom ones) ───────────
      const allGroups = tagsArr.filter(t => t.kind === 'group');
      const stdGroupLabels = new Set(Object.keys(groupToClasses));
      const customGroups = allGroups.filter(t => !stdGroupLabels.has(t.label));
      const customHtml = customGroups.length
        ? customGroups.map(t => {
            const childCount = tagsArr.filter(c => (c.parents||[]).includes(t.id)).length;
            const useCount = (typeof data !== 'undefined')
              ? data.reduce((n, r) => n + (recordMatchesTagQuery(r.tags, t.id) ? 1 : 0), 0)
              : 0;
            return '<div style="padding:4px 8px;margin-bottom:4px;background:rgba(255,255,255,0.02);border:1px solid #2a2a3a;border-radius:4px;font-size:11px;color:#ccd;">'
              + '<span style="color:#fc8;">' + escapeHtml(labelFor(t.id)) + '</span>'
              + (t.common ? ' <span style="color:#888;">('+escapeHtml(t.common)+')</span>' : '')
              + ' <span style="color:#666;">· ' + childCount + ' children · ' + useCount + ' rows match</span>'
              + '</div>';
          }).join('')
        : '<div style="color:#555;font-size:11px;padding:4px 0;">(none yet)</div>';

      modal.innerHTML = '<div style="background:#0d0d1e;border:2px solid #fc8;border-radius:8px;'
        + 'box-shadow:0 8px 32px rgba(0,0,0,0.85);width:780px;max-width:96vw;max-height:85vh;overflow-y:auto;'
        + 'font-family:monospace;color:#ddd;padding:16px 20px;">'
        // Header
        + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">'
        +   '<span style="color:#fc8;font-size:14px;font-weight:bold;">🐟 Ecology Groups</span>'
        +   '<span style="color:#777;font-size:11px;flex:1;">Group tags sit above GBIF class taxa so filtering "fish" finds all ray-finned species.</span>'
        +   '<button id="ecoClose" style="padding:3px 10px;border:1px solid #f66;background:rgba(80,0,0,0.4);color:#f88;border-radius:4px;cursor:pointer;font-size:11px;">✕ Close</button>'
        + '</div>'
        // One-click wire-all
        + '<div style="margin-bottom:14px;padding:10px 14px;background:rgba(80,120,200,0.1);border:1px solid #446;border-radius:6px;">'
        +   '<button id="ecoWireAll" style="padding:6px 16px;border:1px solid #8cf;background:rgba(0,40,100,0.55);color:#8cf;border-radius:5px;cursor:pointer;font-family:monospace;font-size:12px;font-weight:bold;">⚡ Create &amp; wire ALL standard groups now</button>'
        +   ' <span style="color:#888;font-size:11px;">Creates any missing group tags + wires all known class taxa in one click. Safe to re-run.</span>'
        + '</div>'
        // Standard groups
        + '<div style="font-size:12px;color:#aaf;font-weight:bold;margin-bottom:6px;">Standard groups (from GBIF class map):</div>'
        + stdHtml
        // Custom groups
        + '<div style="font-size:12px;color:#aaf;font-weight:bold;margin:12px 0 6px;">Custom groups:</div>'
        + customHtml
        // New custom group
        + '<div style="margin-top:10px;display:flex;gap:8px;align-items:center;">'
        +   '<input id="ecoNewName" type="text" placeholder="new group name (e.g. marine mammals)…" autocomplete="off"'
        +     ' style="flex:1;padding:5px 10px;background:#0a0a1a;border:1px solid #fc8;color:#fff;border-radius:5px;font-family:monospace;font-size:12px;outline:none;">'
        +   '<button id="ecoNewCreate" style="padding:5px 12px;border:1px solid #5f5;background:rgba(0,80,0,0.4);color:#afa;border-radius:5px;cursor:pointer;font-family:monospace;font-size:12px;">+ Create group</button>'
        + '</div>'
        + '</div>';

      // Bind one-time events on rebuilt DOM
      modal.querySelector('#ecoClose').onclick  = () => { modal.remove(); };
      modal.querySelector('#ecoWireAll').onclick = autoWireAll;
      modal.querySelector('#ecoNewCreate').onclick = () => {
        const inp = modal.querySelector('#ecoNewName');
        const name = inp ? inp.value.trim() : '';
        if (!name) return;
        const r = createTag({ label: name, kind: 'group' });
        if (r.ok) toast('✓ Created group "' + name + '"', 1400);
        else      toast('Failed: ' + (r.err || 'unknown'), 1600);
        if (inp) inp.value = '';
        build();
      };
      modal.querySelector('#ecoNewName').addEventListener('keydown', e => {
        if (e.key === 'Enter') modal.querySelector('#ecoNewCreate').click();
        if (e.key === 'Escape') { modal.remove(); }
      });
    }

    build();
    document.body.appendChild(modal);

    modal.addEventListener('click', e => {
      if (e.target === modal) { modal.remove(); return; }
      const act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      if (act === 'create-group') {
        const r = createTag({ label: e.target.dataset.grp, kind: 'group' });
        toast(r.ok ? '✓ Created "' + e.target.dataset.grp + '"' : 'Failed: ' + r.err, 1400);
        build();
      } else if (act === 'wire-one') {
        const tag = byId.get(e.target.dataset.clsId);
        const gid = e.target.dataset.grpId;
        if (tag && !((tag.parents||[]).includes(gid))) updateTag(tag.id, { parents: [...(tag.parents||[]), gid] });
        toast('✓ Wired ' + (tag?.label||'?') + ' → ' + (byId.get(gid)?.label||gid), 1400);
        build();
      } else if (act === 'wire-all') {
        const gid  = e.target.dataset.grpId;
        const cids = (e.target.dataset.clsIds||'').split(',').filter(Boolean);
        let n = 0;
        withBatchedSave(() => cids.forEach(cid => {
          const tag = byId.get(cid);
          if (tag && !((tag.parents||[]).includes(gid))) { updateTag(cid, { parents: [...(tag.parents||[]), gid] }); n++; }
        }));
        toast('✓ Wired ' + n + ' → ' + (byId.get(gid)?.label||gid), 1500);
        build();
      } else if (act === 'create-and-wire') {
        const r = createTag({ label: e.target.dataset.grp, kind: 'group' });
        if (!r.ok) { toast('Failed: ' + r.err, 1600); return; }
        const gid  = r.id;
        const cids = (e.target.dataset.clsIds||'').split(',').filter(Boolean);
        let n = 0;
        withBatchedSave(() => cids.forEach(cid => {
          const tag = byId.get(cid);
          if (tag && !((tag.parents||[]).includes(gid))) { updateTag(cid, { parents: [...(tag.parents||[]), gid] }); n++; }
        }));
        toast('✓ Created "' + e.target.dataset.grp + '" + wired ' + n, 1800);
        build();
      }
    });
  }

  // ── Normalize top of tree ────────────────────────────────────────────────
  // One pass over the roof of the taxonomy, checked against GBIF, shown as a
  // plan before anything is written.
  //
  // What goes wrong up there is invisible from inside a species record. Mollusca
  // sat under a kingdom called Metazoa while Chordata and Echinodermata sat under
  // one called Animalia — so filtering by Animalia missed every mollusc, and no
  // screen said so. Another 33 phyla hung straight off the root, and seven genera
  // and species were parked at the root beside them.
  //
  // The scan asks GBIF about every kingdom, phylum, subphylum and every parentless
  // taxon, then proposes the DEEPEST GBIF ancestor that ALREADY EXISTS here as the
  // new parent. It creates no tags, deletes none (bar a duplicate kingdom you tick),
  // and never re-tags a record. Re-running it is a no-op.
  //
  // The two refusals matter more than the moves:
  //   - Rank disagreement. GBIF's match endpoint resolves "Retaria" to an animal
  //     genus in Brachiopoda and "Endomyxa" to a protozoan genus; both are
  //     rhizarian phyla here. Same spelling, different organism. When the
  //     dictionary's rank and GBIF's rank disagree the row is reported and never
  //     applied — following GBIF there would file a phylum under a genus.
  //   - No match. The Ediacaran and problematic phyla (Petalonamae, Proarticulata,
  //     Trilobozoa, Vetulicolia, Agmata, Saccorhytida, Monoblastozoa) are not in
  //     GBIF's backbone at all. They stay exactly where they are.
  const NORMALIZE_RANKS   = new Set(['kingdom', 'phylum', 'subphylum']);
  const GBIF_CHAIN_FIELDS = ['kingdom', 'phylum', 'class', 'order', 'family', 'genus'];

  // The root of the taxonomy: parentless, and parent to more tags than any other
  // parentless tag. Derived rather than hardcoded to 'life'.
  function taxonomyRootId() {
    const kids = new Map();
    tagsArr.forEach(t => (t.parents || []).forEach(p => kids.set(p, (kids.get(p) || 0) + 1)));
    let best = null, bestN = 0;
    tagsArr.forEach(t => {
      if ((t.parents || []).length) return;
      const n = kids.get(t.id) || 0;
      if (n > bestN) { best = t.id; bestN = n; }
    });
    return best;
  }

  // The one parent that places a taxon in the tree. enforceParentRule keeps it
  // first; anything after it is a cross-cutting ecology group.
  function hierParentOf(t) {
    const first = (t.parents || [])[0];
    if (!first) return null;
    const p = byId.get(first);
    if (p && p.kind !== 'taxon' && p.kind !== 'root') return null;
    return first;
  }

  function childCountOf(id) {
    let n = 0;
    tagsArr.forEach(x => { if ((x.parents || []).includes(id)) n++; });
    return n;
  }

  // Also reachable without the Dictionary open, for a future hotkey.
  window.openNormalizeTree = () => openNormalizePanel();

  function openNormalizePanel() {
    let modal = document.getElementById('normalizePanel');
    if (modal) { modal.remove(); return; }
    modal = document.createElement('div');
    modal.id = 'normalizePanel';
    modal.style.cssText = 'position:fixed;inset:0;z-index:31600;background:rgba(5,5,14,0.84);'
      + 'display:flex;align-items:flex-start;justify-content:center;padding-top:40px;';
    document.body.appendChild(modal);

    let cancelled = false;
    modal.addEventListener('click', (e) => {
      if (e.target === modal) { cancelled = true; modal.remove(); }
    });

    const CARD = 'background:#0d0d1e;border:2px solid #6c9;border-radius:8px;'
      + 'box-shadow:0 8px 32px rgba(0,0,0,0.85);width:940px;max-width:96vw;max-height:88vh;'
      + 'overflow-y:auto;font-family:monospace;color:#ddd;padding:16px 20px;';
    const HEAD = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">'
      + '<span style="color:#6c9;font-size:14px;font-weight:bold;">🌳 Normalize top of tree</span>'
      + '<span style="color:#777;font-size:11px;flex:1;">Every kingdom, phylum and unplaced taxon, checked against WoRMS and then GBIF. Nothing is written until you press Apply.</span>'
      + '<button id="nzClose" style="padding:3px 10px;border:1px solid #f66;background:rgba(80,0,0,0.4);color:#f88;border-radius:4px;cursor:pointer;font-size:11px;">✕ Close</button>'
      + '</div>';

    function paint(bodyHtml) {
      modal.innerHTML = '<div style="' + CARD + '">' + HEAD + bodyHtml + '</div>';
      const c = modal.querySelector('#nzClose');
      if (c) c.onclick = () => { cancelled = true; modal.remove(); };
    }

    paint('<div id="nzProgress" style="padding:24px 4px;color:#8ec;font-size:12px;">Scanning the dictionary…</div>');

    scanTree()
      .then(plan => { if (!cancelled && plan) renderPlan(plan); })
      .catch(e => {
        if (cancelled) return;
        paint('<div style="padding:14px;color:#f88;font-size:12px;">Scan failed: '
          + escapeHtml(String(e && e.message || e))
          + '<br><span style="color:#777;">GBIF may be unreachable, or you may be on the VPN.</span></div>');
      });

    // ── scan ───────────────────────────────────────────────────────────────
    async function scanTree() {
      const rootId  = taxonomyRootId();
      const rootTag = rootId ? byId.get(rootId) : null;

      // Root repairs need no network.
      const rootFixes = [];
      tagsArr.forEach(t => {
        if ((t.parents || []).length) return;
        const kids = childCountOf(t.id);
        if (!kids || String(t.label || '').trim()) return;
        const label = formatTagLabel(String(t.id).replace(/-/g, ' '));
        rootFixes.push({
          id: t.id, patch: { label: label },
          desc: 'blank label on a tag with ' + kids + ' children — nothing to read or click in the tree',
          to: label
        });
      });
      if (rootTag && String(rootTag.common || '').trim()) {
        rootFixes.push({
          id: rootTag.id, patch: { common: '' },
          desc: 'the root of the tree carries a common name ("' + rootTag.common + '") — a root has no vernacular',
          to: '(cleared)'
        });
      }

      // The roof of the tree, plus anything left unplaced.
      const cands = tagsArr.filter(t => t.kind === 'taxon'
        && t.id !== rootId
        && String(t.label || '').trim()
        && (NORMALIZE_RANKS.has(String(t.rank || '').toLowerCase()) || !(t.parents || []).length));

      let done = 0;
      const showProgress = () => {
        const el = modal.querySelector('#nzProgress');
        if (el) el.textContent = 'Checking ' + cands.length
          + ' tags at the top of the tree against WoRMS, then GBIF…  ' + done + ' / ' + cands.length;
      };
      showProgress();

      const answers = new Map();
      const queue = cands.slice();
      const worker = async () => {
        while (queue.length && !cancelled) {
          const t = queue.shift();
          let res;
          try {
            // The recorded rank is passed as a hint so a name held by more than
            // one organism resolves to the right one: Ctenophora is a comb-jelly
            // phylum here and two chromist genera in WoRMS.
            const r = await resolveTaxon(t.label, { rankHint: t.rank });
            if (r.primary) { res = r.primary; }
            else if (r.errors.length) { res = { matchType: 'ERROR', _err: r.errors.join(' / ') }; }
            else { res = { matchType: 'NONE' }; }
          } catch (e) { res = { matchType: 'ERROR', _err: String(e && e.message || e) }; }
          answers.set(t.id, res);
          done++; showProgress();
        }
      };
      // Four at a time: fast enough to feel instant, gentle enough on a free API.
      await Promise.all([worker(), worker(), worker(), worker()]);
      if (cancelled) return null;

      const reparent = [], setRank = [], conflicts = [], unknown = [], noanchor = [],
            errored = [], renames = [];
      cands.forEach(t => {
        const res = answers.get(t.id);
        const mt  = res && res.matchType;
        const via = res && res._source === 'worms' ? 'WoRMS' : 'GBIF';
        // A request that never landed says nothing about the taxon. Reporting a
        // dead connection as "never heard of Chordata" would be a lie, and the
        // sort of lie you would act on.
        if (mt === 'ERROR' || !mt) {
          errored.push({ t: t, why: (res && res._err) || 'no response' });
          return;
        }
        if (mt === 'NONE') {
          unknown.push({ t: t, why: 'neither WoRMS nor GBIF has a match for this name' });
          return;
        }
        const sRank = String(res.rank  || '').toLowerCase();
        const dRank = String(t.rank    || '').toLowerCase();
        // Compare by tier, not by string: the registers disagree about modifier
        // prefixes without disagreeing about the organism. WoRMS calls
        // Actinopterygii a gigaclass and Endomyxa a subphylum where this
        // dictionary says class and phylum — same taxon, finer label. A tier
        // mismatch (phylum here, genus there) is the homonym that must be refused.
        if (dRank && sRank && rankTier(dRank) !== rankTier(sRank)) {
          conflicts.push({ t: t, via: via,
            why: 'you have it as a ' + dRank + ', ' + via + ' matched a ' + sRank
            + ' of the same name'
            + (res.kingdom ? ' in ' + res.kingdom + (res.phylum ? ' › ' + res.phylum : '') : '') });
          return;
        }
        // WoRMS says the name itself is out of date, and gives the accepted one.
        if (res._supersededFrom && res.canonicalName
            && res.canonicalName.toLowerCase() !== String(t.label || '').toLowerCase()) {
          const existing = resolveInput(res.canonicalName);
          if (existing && existing !== t.id && !tagDescendants(t.id).has(existing)) {
            renames.push({ t: t, to: res.canonicalName, mergeInto: existing,
              was: res._supersededFrom, via: via });
            return;   // it is going away; where it sits meanwhile does not matter
          } else if (!existing) {
            renames.push({ t: t, to: res.canonicalName, mergeInto: null,
              was: res._supersededFrom, via: via });
          }
        }
        const selfLc  = String(t.label || '').toLowerCase();
        const canonLc = String(res.canonicalName || '').toLowerCase();
        const chain = GBIF_CHAIN_FIELDS.map(f => res[f]).filter(Boolean)
          .filter(n => {
            const lc = String(n).toLowerCase();
            return lc !== selfLc && lc !== canonLc;
          });
        // Deepest ancestor GBIF names that this dictionary already has. Nothing
        // is created, so a taxon only ever moves to somewhere you can already see.
        const desc = tagDescendants(t.id);
        let anchor = null;
        for (let i = chain.length - 1; i >= 0 && !anchor; i--) {
          const pid = resolveInput(chain[i]);
          if (pid && pid !== t.id && !desc.has(pid)) anchor = pid;
        }
        // Only ever write back a rank this dictionary can store — WoRMS is
        // finer-grained than the rank dropdown (gigaclass, infraclass, parvorder).
        if (!dRank && sRank && DICT_RANKS.has(sRank)) setRank.push({ t: t, rank: sRank, via: via });
        if (!anchor) {
          if (!hierParentOf(t)) noanchor.push({ t: t, chain: chain, via: via });
          return;
        }
        const cur = hierParentOf(t);
        if (cur === anchor) return;
        reparent.push({ t: t, from: cur, to: anchor, chain: chain, sRank: sRank, via: via });
      });

      // Second pass: the names neither register placed, asked again as GBIF
      // synonyms. WoRMS answers this in the first pass via status/valid_name,
      // so only the leftovers reach here.
      let synDone = 0;
      const synQueue = unknown.slice();
      const synWorker = async () => {
        while (synQueue.length && !cancelled) {
          const u = synQueue.shift();
          try { u.syn = await gbifSynonymTarget(u.t.label, u.t.rank); }
          catch (e) { u.syn = null; }
          synDone++;
          const el = modal.querySelector('#nzProgress');
          if (el) el.textContent = 'Checking ' + unknown.length
            + ' unmatched names for synonyms…  ' + synDone + ' / ' + unknown.length;
        }
      };
      await Promise.all([synWorker(), synWorker(), synWorker()]);
      if (cancelled) return null;

      const merges = [];
      unknown.forEach(u => {
        let intoName = null, because = null;
        if (u.syn && u.syn.name) {
          intoName = u.syn.name;
          because = 'GBIF holds "' + u.t.label + '" as a synonym of ' + u.syn.name
            + (u.syn.rank ? ' (' + u.syn.rank + ')' : '');
        } else if (String(u.t.rank || '').toLowerCase() === 'kingdom') {
          // Fallback for a duplicate GBIF has no row for at all: if every child
          // resolves to one kingdom that does exist here, this is that kingdom.
          const kids = tagsArr.filter(x => (x.parents || []).includes(u.t.id));
          const kingdoms = new Set();
          kids.forEach(k => { const r = answers.get(k.id); if (r && r.kingdom) kingdoms.add(r.kingdom); });
          if (kids.length && kingdoms.size === 1) {
            intoName = [...kingdoms][0];
            because = 'its ' + kids.length + ' child' + (kids.length === 1 ? '' : 'ren')
              + ' all resolve to ' + intoName;
          }
        }
        if (!intoName) return;
        // Fourth constraint: only ever merge into something already here, so the
        // records have somewhere real to land.
        const target = resolveInput(intoName);
        if (!target || target === u.t.id) return;
        if (tagDescendants(u.t.id).has(target)) return;
        merges.push({ t: u.t, into: target, because: because });
      });
      const merged = new Set(merges.map(m => m.t.id));

      return {
        rootFixes: rootFixes,
        reparent:  reparent,
        setRank:   setRank,
        merges:    merges,
        conflicts: conflicts,
        unknown:   unknown.filter(u => !merged.has(u.t.id)),
        noanchor:  noanchor,
        errored:   errored,
        renames:   renames,
        sources:   (() => {
          let w = 0, g = 0;
          answers.forEach(r => { if (r && r._source === 'worms') w++; else if (r && r._source === 'gbif') g++; });
          return { worms: w, gbif: g };
        })(),
        scanned:   cands.length
      };
    }

    // ── plan ───────────────────────────────────────────────────────────────
    function renderPlan(plan) {
      const actions = [];
      const box = (i) => '<input type="checkbox" data-nz="' + i + '" checked '
        + 'style="margin-right:9px;vertical-align:middle;cursor:pointer;">';
      const viaTag = (via) => via
        ? ' <span style="padding:0 4px;border-radius:3px;font-size:9px;'
          + (via === 'WoRMS' ? 'background:rgba(80,200,180,0.16);color:#7dd;'
                             : 'background:rgba(100,140,255,0.16);color:#9bf;')
          + '">' + via + '</span>'
        : '';
      const nameOf = (t) => '<span style="color:' + kindColor(t) + ';font-weight:bold;">'
        + escapeHtml(t.label || t.id) + '</span>'
        + (t.rank ? ' <span style="color:#667;font-size:10px;">' + escapeHtml(t.rank) + '</span>' : '');
      const ROW = 'padding:5px 10px;margin-bottom:3px;background:rgba(255,255,255,0.03);'
        + 'border:1px solid #2a3a34;border-radius:4px;font-size:11px;line-height:1.7;';
      const DEAD = 'padding:4px 10px;margin-bottom:3px;background:rgba(255,255,255,0.02);'
        + 'border:1px solid #333;border-radius:4px;font-size:11px;';

      let html = '';

      // Lead with the failures. A half-answered scan that quietly proposes
      // moves is worse than one that admits it could not see.
      const errs  = (plan.errored || []).length;
      const badly = errs > 0 && errs >= plan.scanned / 4;
      if (errs) {
        html += '<div style="margin:4px 0 8px;padding:9px 12px;background:rgba(255,80,80,0.10);'
          + 'border:1px solid #733;border-radius:5px;font-size:11px;line-height:1.7;">'
          + '<b style="color:#f99;">⚠ ' + errs + ' of ' + plan.scanned
          + ' lookups did not reach WoRMS or GBIF.</b> <span style="color:#c99;">'
          + escapeHtml(plan.errored[0].why) + '</span>'
          + '<div style="color:#a88;margin-top:3px;">These are unanswered, not unrecognised — '
          + 'they are left out of the plan entirely. If you are on the VPN, drop it and scan again.</div>'
          + '<div style="color:#977;margin-top:4px;">'
          + plan.errored.slice(0, 40).map(u => escapeHtml(u.t.label)).join(', ')
          + (errs > 40 ? ', …' : '') + '</div>'
          + '</div>';
      }

      if (plan.rootFixes.length) {
        html += heading('Root repairs', '#8ec', 'the tag everything else hangs from');
        plan.rootFixes.forEach(f => {
          const i = actions.push({ kind: 'patch', id: f.id, patch: f.patch, label: labelFor(f.id), desc: f.desc }) - 1;
          html += '<div style="' + ROW + '">' + box(i)
            + '<span style="color:#8ec;font-weight:bold;">' + escapeHtml(f.id) + '</span>'
            + ' <span style="color:#999;">' + escapeHtml(f.desc) + '</span>'
            + ' <span style="color:#556;">→</span> <b style="color:#afa;">' + escapeHtml(f.to) + '</b>'
            + '</div>';
        });
      }

      if (plan.merges.length) {
        html += heading('Duplicate names', '#fc8',
          'a second name for a tag you already have');
        plan.merges.forEach(m => {
          const i = actions.push({ kind: 'merge', id: m.t.id, into: m.into,
            label: m.t.label, intoLabel: labelFor(m.into) }) - 1;
          const recs = (typeof data !== 'undefined' && Array.isArray(data))
            ? data.filter(r => Array.isArray(r.tags) && r.tags.includes(m.t.id)).length : 0;
          html += '<div style="' + ROW + '">' + box(i)
            + nameOf(m.t) + ' <span style="color:#556;">merge into</span> '
            + '<b style="color:#fc8;">' + escapeHtml(labelFor(m.into)) + '</b>'
            + '<div style="color:#889;font-size:10px;padding-left:26px;">' + escapeHtml(m.because)
            + '. ' + (recs ? recs + ' record' + (recs === 1 ? '' : 's') + ' move across; ' : '')
            + 'the name survives as an alias, so searching it still works.</div>'
            + '</div>';
        });
      }

      if ((plan.renames || []).length) {
        html += heading('Out-of-date names', '#9dd',
          'WoRMS holds the name you have as superseded, and names the accepted one');
        plan.renames.forEach(r => {
          const i = actions.push(r.mergeInto
            ? { kind: 'merge', id: r.t.id, into: r.mergeInto, label: r.t.label,
                intoLabel: labelFor(r.mergeInto), asFormerly: true }
            : { kind: 'rename', id: r.t.id, to: r.to, label: r.t.label }) - 1;
          html += '<div style="' + ROW + '">' + box(i) + nameOf(r.t) + viaTag(r.via)
            + ' <span style="color:#556;">' + (r.mergeInto ? 'merge into' : 'rename to') + '</span> '
            + '<b style="color:#9dd;">' + escapeHtml(r.mergeInto ? labelFor(r.mergeInto) : r.to) + '</b>'
            + '<div style="color:#889;font-size:10px;padding-left:26px;">'
            + escapeHtml(r.t.label) + ' is <b>' + escapeHtml(r.was) + '</b> in WoRMS. '
            + (r.mergeInto
                ? 'You already have the accepted name, so the records move across and the old name is kept as Formerly.'
                : 'The old name is kept as Formerly, so searching it still works.')
            + '</div></div>';
        });
      }

      if (plan.reparent.length) {
        html += heading('Re-parent', '#8cf',
          'moved to the deepest ancestor the register names that already exists here');
        plan.reparent.forEach(r => {
          const i = actions.push({ kind: 'reparent', id: r.t.id, to: r.to,
            label: r.t.label, toLabel: labelFor(r.to) }) - 1;
          html += '<div style="' + ROW + '">' + box(i)
            + nameOf(r.t) + viaTag(r.via)
            + ' <span style="color:#889;">' + escapeHtml(r.from ? labelFor(r.from) : '(nothing)') + '</span>'
            + ' <span style="color:#556;">→</span> '
            + '<b style="color:#8cf;">' + escapeHtml(labelFor(r.to)) + '</b>'
            + '<div style="color:#667;font-size:10px;padding-left:26px;">' + escapeHtml(r.via || 'GBIF') + ': '
            + escapeHtml(r.chain.join(' › ')) + '</div>'
            + '</div>';
        });
      }

      if (plan.setRank.length) {
        html += heading('Fill in a missing rank', '#cae', 'these have no rank recorded');
        plan.setRank.forEach(r => {
          const i = actions.push({ kind: 'rank', id: r.t.id, rank: r.rank, label: r.t.label }) - 1;
          html += '<div style="' + ROW + '">' + box(i) + nameOf(r.t) + viaTag(r.via)
            + ' <span style="color:#556;">rank →</span> <b style="color:#cae;">' + escapeHtml(r.rank) + '</b>'
            + '</div>';
        });
      }

      // ── read-only: everything deliberately left alone ─────────────────────
      if (plan.conflicts.length) {
        html += heading('Left alone — the register disagrees about the rank', '#f99',
          'same spelling, different organism. Following it here would file a phylum under a genus');
        plan.conflicts.forEach(c => {
          html += '<div style="' + DEAD + '"><span style="color:#fbb;">' + escapeHtml(c.t.label)
            + '</span>' + viaTag(c.via)
            + ' <span style="color:#977;">— ' + escapeHtml(c.why) + '</span>'
            + ' <span data-nzopen="' + escapeAttr(c.t.id) + '" style="color:#6af;cursor:pointer;text-decoration:underline dotted;">open</span></div>';
        });
      }

      if (plan.unknown.length) {
        html += heading('Left alone — both registers answered, neither had a match', '#a96',
          'extinct, disputed, or not a scientific name. Staying put is the safe answer');
        html += '<div style="' + DEAD + 'line-height:2;">'
          + plan.unknown.map(u => '<span data-nzopen="' + escapeAttr(u.t.id) + '" title="'
              + escapeAttr(u.why) + '" style="color:#cb9;cursor:pointer;margin-right:10px;'
              + 'text-decoration:underline dotted;">' + escapeHtml(u.t.label) + '</span>').join('')
          + '</div>';
      }

      if (plan.noanchor.length) {
        html += heading('Unplaced, and no ancestor of theirs exists here yet', '#899',
          'run 🔎 Check taxonomy → 🚀 Apply All on one of these to create its chain');
        html += '<div style="' + DEAD + 'line-height:2;">'
          + plan.noanchor.map(u => '<span data-nzopen="' + escapeAttr(u.t.id) + '" title="'
              + escapeAttr('GBIF: ' + u.chain.join(' > ')) + '" style="color:#9aa;cursor:pointer;margin-right:10px;'
              + 'text-decoration:underline dotted;">' + escapeHtml(u.t.label) + '</span>').join('')
          + '</div>';
      }

      const changes = actions.length;
      const bar = '<div style="position:sticky;bottom:0;margin-top:14px;padding:10px 0 2px;'
        + 'background:#0d0d1e;border-top:1px solid #2a3a34;display:flex;align-items:center;gap:10px;">'
        + (badly
            ? '<button id="nzRescan2" style="padding:7px 16px;border:1px solid #6c9;background:rgba(0,90,60,0.5);'
              + 'color:#bfd;border-radius:5px;cursor:pointer;font-family:monospace;font-size:12px;">↻ Scan again</button>'
              + '<span style="color:#f99;font-size:11px;">Too much of that scan failed to act on. '
              + (changes ? 'The ' + changes + ' offline repair' + (changes === 1 ? '' : 's') + ' below can still be applied.' : '')
              + '</span>'
            : '')
        + (changes
            ? '<button id="nzApply" style="padding:7px 18px;border:1px solid #6c9;background:rgba(0,90,60,0.55);'
              + 'color:#bfd;font-weight:bold;border-radius:5px;cursor:pointer;font-family:monospace;font-size:12px;">'
              + '✓ Apply ' + changes + ' change' + (changes === 1 ? '' : 's') + '</button>'
              + '<button id="nzNone" style="padding:7px 12px;border:1px solid #667;background:rgba(40,40,60,0.5);'
              + 'color:#99a;border-radius:5px;cursor:pointer;font-family:monospace;font-size:11px;">untick all</button>'
            : '<span style="color:#8ec;font-size:12px;">✓ Nothing to change — the top of the tree agrees with GBIF.</span>')
        + '<span style="flex:1;"></span>'
        + '<span style="color:#667;font-size:11px;">' + plan.scanned + ' tags checked · '
        + ((plan.sources && plan.sources.worms) || 0) + ' answered by WoRMS, '
        + ((plan.sources && plan.sources.gbif) || 0) + ' by GBIF</span>'
        + '</div>';

      paint(html + bar);

      modal.querySelectorAll('[data-nzopen]').forEach(el => {
        el.addEventListener('click', () => {
          cancelled = true;
          modal.remove();
          selectTagFromOutside(el.dataset.nzopen);
        });
      });
      const none = modal.querySelector('#nzNone');
      if (none) none.onclick = () => {
        modal.querySelectorAll('[data-nz]').forEach(b => { b.checked = false; });
      };
      const apply = modal.querySelector('#nzApply');
      if (apply) apply.onclick = () => applyPlan(actions);
      const rescan2 = modal.querySelector('#nzRescan2');
      if (rescan2) rescan2.onclick = () => {
        paint('<div id="nzProgress" style="padding:24px 4px;color:#8ec;font-size:12px;">Scanning the dictionary…</div>');
        scanTree().then(pl => { if (!cancelled && pl) renderPlan(pl); });
      };

      function heading(text, colour, note) {
        return '<div style="margin:14px 0 6px;color:' + colour + ';font-size:12px;font-weight:bold;">'
          + escapeHtml(text)
          + (note ? ' <span style="color:#777;font-weight:normal;font-size:11px;">— ' + note + '</span>' : '')
          + '</div>';
      }
    }

    // ── apply ──────────────────────────────────────────────────────────────
    function applyPlan(actions) {
      const chosen = [...modal.querySelectorAll('[data-nz]')]
        .filter(b => b.checked)
        .map(b => actions[parseInt(b.dataset.nz, 10)])
        .filter(Boolean);

      // Repairs first so labels read correctly in the log, re-parents next,
      // merges last so a kingdom is emptied before it is folded away.
      const order = { patch: 0, reparent: 1, rank: 2, merge: 3 };
      chosen.sort((a, b) => order[a.kind] - order[b.kind]);

      const log = [];
      let ok = 0, failed = 0;
      withBatchedSave(() => chosen.forEach(a => {
        const t = byId.get(a.id);
        if (!t) { log.push(['✗', a.label || a.id, 'no longer exists']); failed++; return; }
        let r;
        if (a.kind === 'patch') {
          r = updateTag(a.id, a.patch);
          if (r.ok) log.push(['✓', a.label || a.id, a.desc]);
        } else if (a.kind === 'reparent') {
          // Keep cross-cutting group parents; the new clade goes first so
          // enforceParentRule hands it the single hierarchical slot.
          const keep = (t.parents || []).filter(p => {
            const pt = byId.get(p);
            return pt && pt.kind !== 'taxon' && pt.kind !== 'root';
          });
          r = updateTag(a.id, { parents: [a.to].concat(keep) });
          if (r.ok) log.push(['✓', a.label, 'now under ' + a.toLabel]);
        } else if (a.kind === 'rank') {
          r = updateTag(a.id, { rank: a.rank });
          if (r.ok) log.push(['✓', a.label, 'rank set to ' + a.rank]);
        } else if (a.kind === 'rename') {
          // Keep the superseded name searchable — it is what the sources, the
          // captions and half the internet still call it. (dev1116) It goes in
          // Formerly, not aliases, so D shows it as the old name it is.
          r = updateTag(a.id, { label: a.to, formerly: (t.formerly || []).concat(a.label ? [a.label] : []) });
          if (r.ok) log.push(['✓', a.label, 'renamed to ' + a.to + ' (old name kept as Formerly)']);
        } else if (a.kind === 'merge') {
          r = mergeTag(a.id, a.into, { asFormerly: !!a.asFormerly });
          if (r.ok) log.push(['✓', a.label, 'merged into ' + a.intoLabel]);
        }
        if (r && r.ok) ok++; else { failed++; log.push(['✗', a.label || a.id, (r && r.err) || 'failed']); }
      }));

      if (typeof render === 'function') render();
      if (dictOverlay && dictOverlay._renderView) dictOverlay._renderView();
      if (typeof toast === 'function') {
        toast('🌳 Normalized: ' + ok + ' change' + (ok === 1 ? '' : 's') + ' applied'
          + (failed ? ', ' + failed + ' failed' : ''), 2600);
      }

      paint('<div style="margin:8px 0 10px;color:#8ec;font-size:12px;font-weight:bold;">'
        + '✓ Applied ' + ok + ' change' + (ok === 1 ? '' : 's')
        + (failed ? ' · <span style="color:#f88;">' + failed + ' failed</span>' : '') + '</div>'
        + '<div style="font-size:11px;line-height:1.9;">'
        + log.map(l => '<div><span style="color:' + (l[0] === '✓' ? '#8f8' : '#f88') + ';">' + l[0] + '</span> '
            + '<b style="color:#ccd;">' + escapeHtml(String(l[1])) + '</b> '
            + '<span style="color:#889;">' + escapeHtml(String(l[2])) + '</span></div>').join('')
        + '</div>'
        + '<div style="margin-top:14px;padding-top:10px;border-top:1px solid #2a3a34;display:flex;gap:10px;">'
        + '<button id="nzRescan" style="padding:6px 14px;border:1px solid #6c9;background:rgba(0,90,60,0.5);'
        + 'color:#bfd;border-radius:5px;cursor:pointer;font-family:monospace;font-size:11px;">↻ Scan again</button>'
        + '<span style="color:#667;font-size:11px;align-self:center;">Re-running is safe — a normalized tree proposes nothing.</span>'
        + '</div>');

      const again = modal.querySelector('#nzRescan');
      if (again) again.onclick = () => {
        paint('<div id="nzProgress" style="padding:24px 4px;color:#8ec;font-size:12px;">Scanning the dictionary…</div>');
        scanTree().then(p => { if (!cancelled && p) renderPlan(p); });
      };
    }
  }

  // Maps GBIF class names → ecology group tag labels. Used by applyChainImport
  // to auto-wire e.g. Actinopterygii → "fish" if that tag exists in the dict.
  const CLASS_TO_GROUP = {
    'Actinopterygii':      'fish',
    'Chondrichthyes':      'fish',
    'Sarcopterygii':       'fish',
    'Myxini':              'fish',
    'Cephalaspidomorphi':  'fish',
    'Petromyzontida':      'fish',
    'Aves':                'bird',
    'Mammalia':            'mammal',
    'Amphibia':            'amphibian',
    'Reptilia':            'reptile',
    'Insecta':             'insect',
    'Arachnida':           'arachnid',
    'Malacostraca':        'crustacean',
    'Maxillopoda':         'crustacean',
    'Merostomata':         'crustacean',
  };

  // ── GBIF lookup ─────────────────────────────────────────────────────────
  // Calls GBIF's species/match endpoint. Free, no auth, CORS-enabled.
  // Docs: https://www.gbif.org/developer/species
  // Returns the parsed JSON; fields of interest:
  //   matchType:   EXACT | FUZZY | HIGHERRANK | NONE
  //   scientificName: "Hymenopus coronatus Olivier, 1792"
  //   canonicalName:  "Hymenopus coronatus"  (no author)
  //   rank:        "SPECIES" | "GENUS" | "FAMILY" | ... (uppercase)
  //   kingdom, phylum, class, order, family, genus, species: full hierarchy
  //   confidence:  0-100
  async function queryGbif(name) {
    const url = 'https://api.gbif.org/v1/species/match?name=' + encodeURIComponent(name)
      + '&verbose=true&strict=false';
    const r = await fetch(url);
    if (!r.ok) throw new Error('GBIF returned ' + r.status);
    return await r.json();
  }

  // Common-name (vernacular) search. The /species/search endpoint searches
  // across both scientific names and vernacular (common) names. Returns up
  // to `limit` candidates, ranked by GBIF's relevance scoring.
  // Useful when /species/match returns NONE because the user typed a common
  // name like "orchid mantis" (which isn't a canonical scientific name).
  async function searchGbif(query, limit) {
    // Request more raw results than we'll display; we dedupe heavily client-side.
    // Filter to ACCEPTED status (excludes synonyms pointing elsewhere) and
    // restrict rank to species/genus/family/order — finer ranks (subspecies,
    // form) and broader ones (kingdom) rarely match a useful common-name query.
    const rawLimit = Math.max(40, (limit || 10) * 5);
    const url = 'https://api.gbif.org/v1/species/search?q=' + encodeURIComponent(query)
      + '&limit=' + rawLimit + '&status=ACCEPTED'
      + '&rank=SPECIES&rank=SUBSPECIES&rank=GENUS&rank=FAMILY&rank=ORDER';
    const r = await fetch(url);
    if (!r.ok) throw new Error('GBIF returned ' + r.status);
    const j = await r.json();
    const raw = j.results || [];

    // GBIF aggregates from multiple checklist sources (Catalogue of Life,
    // ITIS, WoRMS, GBIF Backbone, etc.) — same species shows up multiple
    // times. Dedupe by canonical name + rank, keeping the GBIF Backbone
    // entry first if available (its datasetKey is constant and it's the
    // most-curated unified source).
    const GBIF_BACKBONE = 'd7dddbf4-2cf0-4f39-9b2a-bb099caae36c';
    const byKey = new Map();
    raw.forEach(c => {
      // Skip records that explicitly point at a different accepted name —
      // those are synonyms, and the actual accepted entry is also in results.
      if (c.acceptedKey && c.acceptedKey !== c.key) return;
      const canonical = c.canonicalName || c.scientificName || '';
      if (!canonical) return;
      const dedupeKey = canonical.toLowerCase() + '|' + (c.rank || '');
      const existing = byKey.get(dedupeKey);
      if (!existing) {
        byKey.set(dedupeKey, c);
        return;
      }
      // Prefer Backbone entry over others
      const isBb        = c.datasetKey       === GBIF_BACKBONE;
      const existingBb  = existing.datasetKey === GBIF_BACKBONE;
      if (isBb && !existingBb) byKey.set(dedupeKey, c);
      // Otherwise keep what we had (first-seen wins)
    });

    // Sort: species first, then genus, then family, then order.
    // Within each rank tier, preserve GBIF's original ranking.
    const rankOrder = { SPECIES: 0, SUBSPECIES: 1, GENUS: 2, FAMILY: 3, ORDER: 4 };
    const deduped = [...byKey.values()];
    deduped.sort((a, b) => (rankOrder[a.rank] || 99) - (rankOrder[b.rank] || 99));

    return deduped.slice(0, limit || 10);
  }

  // Pick the most useful vernacular name from a GBIF result.
  // Strategy: prefer English; fall back to first non-empty.
  // Returns { name, lang } or null.
  function pickVernacular(c) {
    const vs = c.vernacularNames || [];
    if (!vs.length) return null;
    const en = vs.find(v => (v.language || '').toLowerCase() === 'eng');
    if (en && en.vernacularName) return { name: en.vernacularName, lang: 'en' };
    const first = vs.find(v => v.vernacularName);
    if (first) return { name: first.vernacularName, lang: (first.language || '').slice(0, 2).toLowerCase() };
    return null;
  }

  // Fetch full taxonomic detail for a usageKey (used to fill in missing ranks
  // and to get the most authoritative hierarchy).
  async function getGbifSpecies(usageKey) {
    const r = await fetch('https://api.gbif.org/v1/species/' + usageKey);
    if (!r.ok) throw new Error('GBIF returned ' + r.status);
    return await r.json();
  }

  // ── WoRMS ────────────────────────────────────────────────────────────────
  // The World Register of Marine Species. Primary source; GBIF is the fallback.
  //
  // Measured over the 539 ranked taxa in this dictionary, WoRMS resolves 87.9%
  // and agrees with the recorded rank on 85.9%, against GBIF's 86.6% / 82.9%.
  // The totals are close; the failures are not. GBIF's species/match endpoint
  // answers HIGHERRANK when it cannot find a name — it hands back the KINGDOM,
  // which reads exactly like a successful match. Bathynomus, Lithopoma,
  // Caprella, Clionidae, Polychaeta, Parachela and Chaetognatha all came back as
  // a bare "Animalia". It resolves Tunicata to a genus of BACTERIA, Retaria to
  // an animal genus in Brachiopoda, Endomyxa to a protozoan genus. It also
  // misses core marine groups outright: Ctenophora, Actinopterygii, Teleostei,
  // Amphibia, Metazoa, Chelicerata, Paguroidea, Thoracica.
  //
  // GBIF keeps the fallback slot for what WoRMS has no remit for: land animals
  // (Loxodonta, Bradypodion, Bothrops, the birds) and viruses.
  const WORMS_REST = 'https://www.marinespecies.org/rest';

  async function wormsFetch(path) {
    const r = await fetch(WORMS_REST + path);
    if (r.status === 204) return null;         // WoRMS signals "no rows" with 204
    if (!r.ok) throw new Error('WoRMS returned ' + r.status);
    return await r.json();
  }

  // Ranks this dictionary can actually store — the de-rank dropdown's options.
  // WoRMS is finer-grained than that (gigaclass, infraclass, parvorder), so a
  // rank is only ever written back when it is one of these.
  const DICT_RANKS = new Set(['domain','kingdom','phylum','subphylum','class','subclass',
    'order','suborder','superfamily','family','subfamily','genus','species']);

  // Compare ranks across sources by tier, ignoring the modifier prefixes the two
  // registries disagree about: WoRMS calls Actinopterygii a gigaclass and
  // Thoracica an infraclass where this dictionary says class.
  function rankTier(r) {
    return String(r || '').toLowerCase().trim()
      .replace(/^(giga|mega|super|sub|infra|parv)/, '');
  }

  // Fold a WoRMS record into the shape the GBIF code already speaks, so every
  // consumer downstream works unchanged whichever source answered.
  function wormsRowToResult(row, queried, followedFrom) {
    const rank = String(row.rank || '');
    return {
      matchType: String(row.match_type || 'exact').toLowerCase() === 'exact' ? 'EXACT' : 'FUZZY',
      canonicalName:  row.scientificname || '',
      scientificName: row.authority ? (row.scientificname + ' ' + row.authority) : (row.scientificname || ''),
      authorship: row.authority || '',
      rank: rank.toUpperCase(),
      confidence: 100,
      kingdom: row.kingdom || '', phylum: row.phylum || '', class: row.class || '',
      order:   row.order   || '', family: row.family || '', genus:  row.genus  || '',
      species: rank.toLowerCase() === 'species' ? (row.scientificname || '') : '',
      vernacularNames: [],
      _source: 'worms',
      _aphiaId: row.AphiaID,
      _url: row.url || '',
      _status: row.status || '',
      _extinct: row.isExtinct === 1,
      _marine: !!row.isMarine, _terrestrial: !!row.isTerrestrial,
      _freshwater: !!row.isFreshwater, _brackish: !!row.isBrackish,
      // Set when the name asked about is not the accepted one. This is the field
      // that would have told us "Sepia latimanus" is now "Ascarosepion latimanus".
      _supersededFrom: followedFrom || null,
      _queried: queried
    };
  }

  // rankHint: when the dictionary already records a rank, prefer the WoRMS record
  // at that tier. Without it a name like Ctenophora — a comb-jelly phylum AND two
  // chromist genera, four accepted records — resolves by luck of row order.
  async function wormsMatch(name, rankHint) {
    const rows = await wormsFetch('/AphiaRecordsByName/' + encodeURIComponent(name)
      + '?like=false&marine_only=false&offset=1');
    if (!rows || !rows.length) return { matchType: 'NONE', _source: 'worms' };

    const accepted = rows.filter(r => r.status === 'accepted');
    const pool = accepted.length ? accepted : rows;
    let row = null;
    if (rankHint) {
      const want = rankTier(rankHint);
      row = pool.find(r => rankTier(r.rank) === want) || null;
    }
    if (!row) row = pool[0];

    let res;
    if (row.status !== 'accepted' && row.valid_AphiaID && row.valid_AphiaID !== row.AphiaID) {
      // A synonym row carries the OLD placement — Sepia latimanus lists genus
      // Sepia. Follow it so the chain we return is the valid one.
      const valid = await wormsFetch('/AphiaRecordByAphiaID/' + row.valid_AphiaID);
      res = valid ? wormsRowToResult(valid, name, row.status) : wormsRowToResult(row, name, null);
    } else {
      res = wormsRowToResult(row, name, null);
    }
    // Other records under this spelling, for the candidate picker.
    res._alternatives = rows
      .filter(r => r.AphiaID !== row.AphiaID)
      .map(r => ({ name: r.scientificname, rank: r.rank, kingdom: r.kingdom,
                   phylum: r.phylum, status: r.status, aphiaId: r.AphiaID }));
    return res;
  }

  // Common-name search. Catches the ones typed as vernaculars — "mantis shrimp",
  // "moray eel" — that species/match and AphiaRecordsByName both answer NONE for.
  async function wormsByVernacular(term) {
    const rows = await wormsFetch('/AphiaRecordsByVernacular/' + encodeURIComponent(term)
      + '?like=false&offset=1');
    return Array.isArray(rows) ? rows : [];
  }

  async function wormsVernaculars(aphiaId) {
    try {
      const rows = await wormsFetch('/AphiaVernacularsByAphiaID/' + aphiaId);
      return Array.isArray(rows) ? rows : [];
    } catch (e) { return []; }
  }

  // ── the resolver ─────────────────────────────────────────────────────────
  // WoRMS first, GBIF only if WoRMS has no record. Returns both halves so the
  // UI can show a disagreement rather than silently picking a winner.
  //
  //   opts.rankHint  — prefer a WoRMS record at this rank tier
  //   opts.compare   — also query GBIF even when WoRMS answered, for the strip
  //   opts.vernacular— fetch WoRMS common names for the winning record
  async function resolveTaxon(name, opts) {
    opts = opts || {};
    const out = { query: name, worms: null, gbif: null, primary: null, source: null, errors: [] };

    try { out.worms = await wormsMatch(name, opts.rankHint); }
    catch (e) { out.errors.push('WoRMS: ' + String(e && e.message || e)); }

    const wormsHit = out.worms && out.worms.matchType !== 'NONE';
    if (wormsHit) { out.primary = out.worms; out.source = 'worms'; }

    if (!wormsHit || opts.compare) {
      try { out.gbif = await queryGbif(name); }
      catch (e) { out.errors.push('GBIF: ' + String(e && e.message || e)); }
      if (!wormsHit && out.gbif && out.gbif.matchType && out.gbif.matchType !== 'NONE') {
        out.gbif._source = 'gbif';
        out.primary = out.gbif;
        out.source = 'gbif';
      } else if (out.gbif) {
        out.gbif._source = 'gbif';
      }
    }

    if (opts.vernacular && out.primary && out.primary._source === 'worms' && out.primary._aphiaId) {
      const vs = await wormsVernaculars(out.primary._aphiaId);
      out.primary.vernacularNames = vs.map(v => ({
        vernacularName: v.vernacular, language: v.language_code || v.language || ''
      }));
    }

    // Both answered and they disagree about what this name is.
    if (out.worms && out.gbif && wormsHit && out.gbif.matchType && out.gbif.matchType !== 'NONE') {
      const wr = rankTier(out.worms.rank), gr = rankTier(out.gbif.rank);
      const wk = String(out.worms.kingdom || '').toLowerCase();
      const gk = String(out.gbif.kingdom || '').toLowerCase();
      if (wr !== gr || (wk && gk && wk !== gk)) out.disagree = { wormsRank: out.worms.rank,
        gbifRank: out.gbif.rank, wormsKingdom: out.worms.kingdom, gbifKingdom: out.gbif.kingdom };
    }
    return out;
  }

  // species/match answers NONE for a name GBIF holds only as a synonym — it is
  // a matcher, not a lookup. species/search does hold the synonym rows, with the
  // accepted taxon attached. That is the difference between "GBIF has never
  // heard of Metazoa" (what match says) and "Metazoa is a synonym of Animalia"
  // (what is true).
  //
  // Three constraints keep this from doing damage, because the raw results are
  // dangerous. A bare search for Ctenophora offers Ctenophora Meigen, a
  // crane-fly genus; Onychophora offers Amphichorda, a fungus:
  //   1. rank — the search is restricted to the rank you already recorded, so a
  //      phylum can never be answered by a genus.
  //   2. exact canonical — the synonym row's own name must equal this label.
  //   3. a different accepted name — the same name under another author is a
  //      homonym, not a synonym, and is rejected.
  // The caller adds a fourth: the accepted taxon must already exist here.
  async function gbifSynonymTarget(label, rank) {
    const want = String(label || '').trim().toLowerCase();
    if (!want) return null;
    const url = 'https://api.gbif.org/v1/species/search?q=' + encodeURIComponent(label)
      + '&limit=20&status=SYNONYM'
      + (rank ? '&rank=' + encodeURIComponent(String(rank).toUpperCase()) : '');
    const r = await fetch(url);
    if (!r.ok) throw new Error('GBIF returned ' + r.status);
    const j = await r.json();
    for (const row of (j.results || [])) {
      if (String(row.canonicalName || '').trim().toLowerCase() !== want) continue;
      if (!row.acceptedKey) continue;
      let acc;
      try { acc = await getGbifSpecies(row.acceptedKey); } catch (e) { continue; }
      const canon = String(acc && acc.canonicalName || '').trim();
      if (!canon || canon.toLowerCase() === want) continue;
      return { name: canon, rank: String(acc.rank || '').toLowerCase() };
    }
    return null;
  }

  function renderTaxonResult(container, tagId, query, res, resolution) {
    const t = byId.get(tagId);
    if (!t) { container.innerHTML = ''; return; }

    const matchType = res.matchType || 'NONE';
    const canonical = res.canonicalName || res.scientificName || '';
    const rank = (res.rank || '').toLowerCase();
    const conf = res.confidence || 0;
    const src = res._source === 'worms' ? 'WoRMS' : 'GBIF';
    const srcBadge = '<span style="padding:1px 6px;border-radius:3px;font-size:10px;'
      + (res._source === 'worms'
          ? 'background:rgba(80,200,180,0.18);color:#7dd;border:1px solid #497;'
          : 'background:rgba(100,140,255,0.18);color:#9bf;border:1px solid #558;')
      + '">' + src + '</span>';

    // Build a taxonomic chain display
    const chainRanks = ['kingdom','phylum','class','order','family','genus','species'];
    const chain = chainRanks.map(r => ({ r, name: res[r] })).filter(x => x.name);
    const chainHtml = chain.length
      ? '<div style="margin-top:6px;font-size:10px;color:#889;">'
        + chain.map(x => '<span style="color:#667;">' + x.r + ':</span> <b>' + escapeHtml(x.name) + '</b>').join(' → ')
        + '</div>'
      : '';

    let headerHtml, bgColor, borderColor;

    if (matchType === 'EXACT') {
      headerHtml = '<span style="color:#afa;font-weight:bold;">✓ Exact match</span> ' + srcBadge
        + (res._source === 'gbif' && resolution && resolution.worms
            ? ' <span style="color:#888;font-size:10px;">(WoRMS has no record — not a marine taxon)</span>'
            : '')
        + (res._source === 'worms' ? '' : ' <span style="color:#666;font-size:10px;">(confidence ' + conf + '%)</span>');
      bgColor = 'rgba(80,200,80,0.08)';
      borderColor = '#484';
    } else if (matchType === 'FUZZY') {
      headerHtml = '<span style="color:#fc8;font-weight:bold;">⚠ Fuzzy match</span> ' + srcBadge
        + ' <span style="color:#666;font-size:10px;">(confidence ' + conf + '%)</span>'
        + '<div style="color:#fc8;margin-top:4px;font-size:11px;">Did you mean <b>' + escapeHtml(canonical) + '</b>?</div>';
      bgColor = 'rgba(255,200,100,0.08)';
      borderColor = '#764';
    } else if (matchType === 'HIGHERRANK') {
      // GBIF answers HIGHERRANK by handing back the kingdom, which is not a
      // match at all. Say so plainly rather than dressing it up as one.
      headerHtml = '<span style="color:#88f;font-weight:bold;">↑ No match — ' + src
        + ' fell back to a broader rank</span>'
        + '<div style="color:#aaf;margin-top:4px;font-size:11px;">It returned <b>' + escapeHtml(canonical)
        + '</b> (' + escapeHtml(rank) + '), which is an ancestor, not this name. '
        + 'Do not apply this as-is — pick the right taxon from the candidate list ↓</div>';
      bgColor = 'rgba(100,100,255,0.08)';
      borderColor = '#446';
    } else {
      // NONE — likely a common name or misspelling
      headerHtml = '<span style="color:#f88;font-weight:bold;">✗ Not found in WoRMS or GBIF</span>'
        + '<div style="color:#f99;margin-top:4px;font-size:11px;">"<b>' + escapeHtml(query) + '</b>" is not a '
        + 'scientific name either register holds. Common names work too — both are searched for vernaculars '
        + 'in the candidate list below.</div>';
      bgColor = 'rgba(255,100,100,0.08)';
      borderColor = '#633';
    }

    // Build action buttons. The headline action is "🚀 Apply All" which
    // does chain import + alias + rank + common name in one click — the
    // workflow most users want by default. Individual actions stay available
    // in a "Just specific actions" disclosure below.
    const individualBtns = [];
    if (matchType === 'FUZZY' && canonical && canonical !== t.label) {
      individualBtns.push({ id:'apply-spell', label:'Apply "' + canonical + '" as label' });
    }
    if ((matchType === 'EXACT' || matchType === 'FUZZY') && rank && rank !== (t.rank || '').toLowerCase()) {
      individualBtns.push({ id:'apply-rank', label:'Set rank → ' + rank });
    }
    if (matchType === 'EXACT' || matchType === 'FUZZY') {
      const sciAlias = stripAuthorship(res.canonicalName || res.scientificName);
      const sciAliasLc = sciAlias.toLowerCase();
      // (dev1116) An out-of-date name is renamed in place — the accepted name
      // becomes the label and the old one goes to Formerly — rather than
      // gaining the NEW name as an alias. Only when no other tag already holds
      // the accepted name; that case is a merge, which Apply All does.
      const heldBy = res._supersededFrom && sciAlias ? resolveInput(sciAlias) : null;
      if (res._supersededFrom && sciAlias && sciAliasLc !== String(t.label || '').toLowerCase()
          && (!heldBy || heldBy === tagId)) {
        individualBtns.push({ id:'apply-rename', label:'Rename to "' + sciAlias + '" (old name → Formerly)' });
      } else if (sciAlias && sciAliasLc !== String(t.label || '').toLowerCase()
          && sciAliasLc !== String(t.common || '').toLowerCase()
          && !(t.aliases || []).some(a => a.toLowerCase() === sciAliasLc)) {
        individualBtns.push({ id:'apply-alias', label:'Add "' + sciAlias + '" as alias' });
      }
      if (chain.length > 1) {
        individualBtns.push({ id:'apply-chain', label:'📥 Import chain only (' + chain.length + ' ranks)' });
      }
    }

    let actionsHtml = '';
    if (matchType === 'EXACT' || matchType === 'FUZZY') {
      // Headline ApplyAll button
      const englishCommon = pickVernacular(res);
      const summaryParts = [];
      if (chain.length > 1) summaryParts.push(chain.length + ' ranks');
      if (res.scientificName) summaryParts.push('alias');
      if (englishCommon) summaryParts.push('common name');
      if (rank) summaryParts.push('rank');
      const summary = summaryParts.length ? ' <span style="color:#9ce;font-weight:normal;font-size:10px;">(' + summaryParts.join(' + ') + ')</span>' : '';

      actionsHtml = '<div style="margin-top:8px;">'
        + '<button data-action="apply-all" title="Or double-click any candidate below to Apply All against that match" style="padding:7px 14px;border:1px solid #6cf;background:rgba(0,80,140,0.55);color:#cef;font-weight:bold;border-radius:5px;cursor:pointer;font-family:monospace;font-size:12px;">🚀 Apply All' + summary + ' <span style="color:#9ce;font-weight:normal;font-size:10px;">(or double-click candidate)</span></button>'
        + '</div>';

      if (individualBtns.length) {
        actionsHtml += '<details style="margin-top:6px;">'
          + '<summary style="color:#888;font-size:10px;cursor:pointer;padding:2px 0;user-select:none;">▸ Just specific actions</summary>'
          + '<div style="display:flex;flex-wrap:wrap;gap:5px;padding-top:5px;">'
          + individualBtns.map(b =>
              '<button data-action="' + b.id + '" style="padding:4px 10px;border:1px solid #5a5;background:rgba(50,120,50,0.4);color:#bfb;border-radius:4px;cursor:pointer;font-family:monospace;font-size:11px;">'
              + escapeHtml(b.label) + '</button>'
            ).join('')
          + '</div></details>';
      }
    }

    // Common-name candidate list (always shown if we have results)
    const candidatesContainerHtml = '<div id="gbif-candidates" style="margin-top:10px;"></div>';

    // The name you asked about is no longer the accepted one. This is the single
    // most useful thing WoRMS says and GBIF's matcher never does: it is what
    // renames Sepia latimanus to Ascarosepion latimanus.
    const supersededHtml = res._supersededFrom
      ? '<div style="margin-top:6px;padding:6px 9px;background:rgba(255,200,100,0.10);border:1px solid #764;'
        + 'border-radius:4px;color:#fc8;font-size:11px;">↳ <b>' + escapeHtml(query) + '</b> is '
        + escapeHtml(res._supersededFrom) + ' in WoRMS. The accepted name is <b>'
        + escapeHtml(canonical) + '</b>, and the chain below is the accepted one.</div>'
      : '';

    // Both registers answered and they disagree about what this name IS. Show it
    // rather than quietly preferring one.
    const disagreeHtml = (resolution && resolution.disagree)
      ? '<div style="margin-top:6px;padding:6px 9px;background:rgba(255,120,120,0.10);border:1px solid #744;'
        + 'border-radius:4px;font-size:11px;line-height:1.6;">'
        + '<b style="color:#f99;">The two registers disagree about this name.</b>'
        + '<div style="color:#9dd;">WoRMS: ' + escapeHtml(String(resolution.disagree.wormsRank).toLowerCase())
        + ' in ' + escapeHtml(resolution.disagree.wormsKingdom || '?') + '</div>'
        + '<div style="color:#9bf;">GBIF: ' + escapeHtml(String(resolution.disagree.gbifRank).toLowerCase())
        + ' in ' + escapeHtml(resolution.disagree.gbifKingdom || '?') + '</div>'
        + '<div style="color:#a88;margin-top:2px;">Same spelling, different organism. WoRMS is used above; '
        + 'it is the marine authority.</div></div>'
      : '';

    const srcUrl = res._source === 'worms'
      ? (res._url || (res._aphiaId ? 'https://www.marinespecies.org/aphia.php?p=taxdetails&id=' + res._aphiaId : null))
      : (res.usageKey ? ('https://www.gbif.org/species/' + res.usageKey) : null);
    const linkHtml = srcUrl
      ? '<div style="margin-top:4px;"><a href="' + srcUrl + '" target="_blank" rel="noopener" style="color:#6af;font-size:10px;">View on '
        + (res._source === 'worms' ? 'marinespecies.org' : 'gbif.org') + ' ↗</a></div>'
      : '';

    container.innerHTML =
      '<div style="padding:10px 12px;background:' + bgColor + ';border:1px solid ' + borderColor + ';border-radius:5px;font-size:11px;line-height:1.5;">'
      + headerHtml + supersededHtml + chainHtml + linkHtml + disagreeHtml + actionsHtml
      + '</div>'
      + candidatesContainerHtml;

    // Always also fetch common-name candidates so user can pick a different
    // species if the auto-match was wrong.
    fetchAndRenderCandidates(query, container.querySelector('#gbif-candidates'), tagId);

    // Wire apply buttons
    [...container.querySelectorAll('button[data-action]')].forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        if (action === 'apply-all') {
          await applyChainImport(tagId, res, { withAliasAndCommon: true });
          return;
        }
        if (action === 'apply-chain') {
          await applyChainImport(tagId, res, { withAliasAndCommon: false });
          return;
        }
        const patch = {};
        if (action === 'apply-spell') patch.label = canonical;
        if (action === 'apply-rank')  patch.rank  = rank;
        if (action === 'apply-alias') {
          patch.aliases = [...(t.aliases || []), stripAuthorship(res.canonicalName || res.scientificName)];
        }
        if (action === 'apply-rename') {
          patch.label = stripAuthorship(res.canonicalName || res.scientificName);
          patch.formerly = (t.formerly || []).concat([t.label]);
        }
        const rr = updateTag(tagId, patch);
        if (rr.ok) {
          if (typeof toast === 'function') toast('✓ Applied from GBIF', 1200);
          if (typeof render === 'function') render();
          renderView();
          selectTagFromOutside(tagId);
        }
      });
    });
  }

  // Fetch a list of GBIF candidates (matches scientific OR common names)
  // and render them as clickable rows. Clicking a candidate re-runs the
  // detail flow against that specific entry.
  async function fetchAndRenderCandidates(query, container, tagId) {
    if (!container) return;
    container.innerHTML = '<div style="padding:8px;color:#666;font-size:11px;">Searching common names too…</div>';
    try {
      // WoRMS candidates first. Its vernacular index carries the common names
      // that neither scientific matcher resolves — "mantis shrimp" and "moray
      // eel" are both sitting unplaced in this dictionary for exactly that
      // reason. Homonym rows for the queried spelling come along too, so a name
      // held by several organisms offers the choice instead of picking for you.
      let wormsRows = [];
      try {
        const vern = await wormsByVernacular(query);
        const byName = await wormsFetch('/AphiaRecordsByName/' + encodeURIComponent(query)
          + '?like=false&marine_only=false&offset=1').catch(() => null);
        wormsRows = [].concat(vern || [], byName || []);
      } catch (e) { /* WoRMS silent — GBIF candidates still render below */ }
      const seenW = new Set();
      const wormsCands = wormsRows.filter(r => {
        if (!r || !r.scientificname || !r.rank) return false;
        const k = r.scientificname.toLowerCase() + '|' + String(r.rank).toLowerCase();
        if (seenW.has(k)) return false;
        seenW.add(k);
        return true;
      }).slice(0, 8).map(r => ({
        _source: 'worms',
        _aphiaId: r.AphiaID,
        scientificName: r.authority ? (r.scientificname + ' ' + r.authority) : r.scientificname,
        canonicalName: r.scientificname,
        authorship: r.authority || '',
        rank: r.rank,
        status: r.status,
        validName: r.valid_name || '',
        kingdom: r.kingdom || '', phylum: r.phylum || '', class: r.class || '',
        order: r.order || '', family: r.family || '', genus: r.genus || ''
      }));

      const candidates = await searchGbif(query, 8);
      // Filter out anything without a usable scientificName
      const gbifUsable = candidates.filter(c => c.scientificName && c.rank)
        .map(c => Object.assign({ _source: 'gbif' }, c));
      // Drop GBIF rows WoRMS already offered under the same name+rank.
      const usable = wormsCands.concat(
        gbifUsable.filter(c => !seenW.has(String(c.canonicalName || c.scientificName).toLowerCase()
          + '|' + String(c.rank).toLowerCase())));
      if (!usable.length) {
        container.innerHTML = '<div style="padding:6px;color:#777;font-size:10px;">No candidates from the WoRMS or GBIF common-name search.</div>';
        return;
      }
      let html = '<div style="font-size:10px;color:#888;margin-bottom:5px;">CANDIDATES — WoRMS then GBIF, scientific AND common names <span style="color:#666;">(deduped; click to preview, double-click to Apply All)</span>:</div>';
      html += usable.map((c, i) => {
        const v = pickVernacular(c);
        const vennHtml = v
          ? ' <span style="color:#cb8;">' + escapeHtml(v.name)
            + (v.lang && v.lang !== 'en' ? ' <span style="color:#777;font-size:9px;">[' + v.lang + ']</span>' : '')
            + '</span>'
          : '';
        // Show whichever sub-chain is most informative (last 3 ranks present)
        const chainParts = ['kingdom','phylum','class','order','family','genus']
          .map(r => c[r]).filter(Boolean);
        const chain = chainParts.slice(-3).join(' → ');
        const author = c.authorship ? ' <span style="color:#666;font-size:10px;">' + escapeHtml(c.authorship) + '</span>' : '';
        const badge = ' <span style="padding:0 4px;border-radius:3px;font-size:9px;'
          + (c._source === 'worms' ? 'background:rgba(80,200,180,0.16);color:#7dd;'
                                   : 'background:rgba(100,140,255,0.16);color:#9bf;')
          + '">' + (c._source === 'worms' ? 'WoRMS' : 'GBIF') + '</span>';
        const superseded = (c._source === 'worms' && c.status && c.status !== 'accepted' && c.validName)
          ? '<div style="color:#fc8;font-size:9px;margin-top:2px;">' + escapeHtml(c.status)
            + ' — accepted name is <b>' + escapeHtml(c.validName) + '</b></div>'
          : '';
        return '<div data-cand-idx="' + i + '" style="padding:6px 9px;margin-bottom:3px;background:rgba(255,255,255,0.03);border:1px solid #333;border-radius:4px;cursor:pointer;font-size:11px;">'
          + '<span style="color:#8ef;font-weight:bold;font-style:italic;">' + escapeHtml(c.canonicalName || c.scientificName) + '</span>'
          + badge + superseded
          + author
          + ' <span style="color:#888;font-size:10px;">' + escapeHtml((c.rank || '').toLowerCase()) + '</span>'
          + vennHtml
          + (chain ? '<div style="color:#667;font-size:9px;margin-top:3px;">' + escapeHtml(chain) + '</div>' : '')
          + '</div>';
      }).join('');
      container.innerHTML = html;
      // Wire candidate clicks: re-run the GBIF detail view against the chosen species
      [...container.querySelectorAll('[data-cand-idx]')].forEach(el => {
        const handlePick = async (alsoApplyAll) => {
          const idx = parseInt(el.dataset.candIdx, 10);
          const c = usable[idx];
          if (!c) return;
          el.style.background = 'rgba(100,170,255,0.15)';
          el.style.borderColor = '#6cf';
          // /species/search rows are unreliable — many checklist sources leave
          // kingdom/phylum/.../order/family blank or include only a fragment of
          // the hierarchy. We fetch /species/{key} so the chain in applyChainImport
          // always reaches the species rank instead of bottoming out at order.
          // A WoRMS candidate resolves through WoRMS — by its own name, with its
          // own rank as the hint — so the chain and any superseded-name notice
          // come from the register that offered it.
          if (c._source === 'worms') {
            const nm = c.canonicalName || c.scientificName;
            const rr = await resolveTaxon(nm, { rankHint: c.rank, vernacular: true, compare: true });
            const pick2 = rr.primary;
            if (pick2) {
              const scope2 = el.closest('#dictEdit') || document.getElementById('dictEdit');
              const out2 = scope2 ? scope2.querySelector('#de-gbif-result') : null;
              if (out2) renderTaxonResult(out2, tagId, nm, pick2, rr);
              if (alsoApplyAll) requestAnimationFrame(() => applyChainImport(tagId, pick2, { withAliasAndCommon: true }));
            }
            return;
          }
          let detail = null;
          if (c.key) {
            try { detail = await getGbifSpecies(c.key); } catch (e) { /* fall back to row */ }
          }
          const merged = detail || {};
          const pick = (field) => merged[field] || c[field] || '';
          const synth = {
            matchType: 'EXACT',
            canonicalName: c.canonicalName || merged.canonicalName || c.scientificName,
            scientificName: merged.scientificName || c.scientificName,
            rank: c.rank || merged.rank,
            confidence: 100,
            usageKey: c.key,
            authorship: merged.authorship || c.authorship || '',
            kingdom: pick('kingdom'), phylum: pick('phylum'), class: pick('class'),
            order: pick('order'),     family: pick('family'),
            genus: pick('genus'),     species: pick('species'),
            vernacularNames: merged.vernacularNames || c.vernacularNames || []
          };
          // If this is a species-rank entry but GBIF didn't fill in `species`,
          // use the canonical name as the species link so the chain reaches it.
          if (!synth.species && (synth.rank || '').toUpperCase() === 'SPECIES' && synth.canonicalName) {
            synth.species = synth.canonicalName;
          }
          const editElScope = el.closest('#dictEdit') || document.getElementById('dictEdit');
          const resultEl = editElScope ? editElScope.querySelector('#de-gbif-result') : null;
          if (resultEl) renderTaxonResult(resultEl, tagId, c.scientificName, synth);
          if (alsoApplyAll) {
            requestAnimationFrame(() => {
              applyChainImport(tagId, synth, { withAliasAndCommon: true });
            });
          }
        };
        // Disambiguate single vs double click with a short timer. A single
        // click (handlePick(false)) calls renderTaxonResult → fetchAndRenderCandidates,
        // which tears down and rebuilds this whole candidate list. If we ran that
        // on the FIRST click of a double-click, `el` would be detached before the
        // browser could fire `dblclick` — so Apply All never ran. Delaying the
        // preview lets a double-click cancel it and run Apply All instead.
        let clickTimer = null;
        el.addEventListener('click', () => {
          if (clickTimer) return;           // second click of a pair — dblclick handles it
          clickTimer = setTimeout(() => { clickTimer = null; handlePick(false); }, 250);
        });
        el.addEventListener('dblclick', () => {
          if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
          handlePick(true);
        });
        el.title = 'Click to preview · Double-click to Apply All immediately';
      });
    } catch (e) {
      container.innerHTML = '<div style="padding:6px;color:#a88;font-size:10px;">Common-name search failed: ' + escapeHtml(String(e.message || e)) + '</div>';
    }
  }

  // Import a full taxonomic chain from a GBIF response. For each rank in
  // [kingdom, phylum, class, order, family, genus, species]:
  //   - look up an existing tag by name (case-insensitive); if found, reuse
  //   - otherwise create a new taxon tag with kind=taxon and rank=<that rank>
  // Then chain them as parents: species → genus → family → … → kingdom
  // The kingdom's parent is set to the existing 'life' root if present.
  // Finally, the original tag (the one user clicked GBIF on) is re-pointed
  // to the most-specific ancestor (or relabeled to the canonical species).
  async function applyChainImport(tagId, res, options) {
    options = options || {};
    const t = byId.get(tagId);
    if (!t) return;
    const ranks = ['kingdom','phylum','class','order','family','genus','species'];
    // Build chain bottom-up: filter to ranks GBIF returned
    const chain = ranks.map(r => ({ rank: r, name: res[r] })).filter(x => x.name);
    if (!chain.length) {
      if (typeof toast === 'function') toast('No taxonomic chain in this GBIF result.', 1500);
      return;
    }

    // Resolve or create each tag in the chain. Track results.
    const idsByRank = {};
    let createdCount = 0;
    let reusedCount = 0;
    for (const link of chain) {
      // Try to find existing tag matching this name (label, common, or alias)
      const existingId = resolveInput(link.name);
      if (existingId) {
        idsByRank[link.rank] = existingId;
        reusedCount++;
        continue;
      }
      // Create new taxon tag
      const r = createTag({
        label: link.name,        // formatTagLabel will capitalize first char
        kind: 'taxon',
        rank: link.rank
      });
      if (r.ok) {
        idsByRank[link.rank] = r.id;
        createdCount++;
      }
    }

    // Wire parent chain: each rank's parent is the next-higher rank present.
    // Preserve any non-chain parents (e.g. ecology group tags like "fish")
    // so GBIF re-import doesn't wipe manually placed group memberships.
    let parentChainEdits = 0;
    const chainIdSet = new Set(Object.values(idsByRank));
    for (let i = 1; i < chain.length; i++) {
      const childId  = idsByRank[chain[i].rank];
      const parentId = idsByRank[chain[i - 1].rank];
      if (!childId || !parentId) continue;
      const child = byId.get(childId);
      if (!child) continue;
      const currentParents = child.parents || [];
      if (!currentParents.includes(parentId)) {
        const nonChainParents = currentParents.filter(p => !chainIdSet.has(p));
        // Chain parent FIRST: enforceParentRule keeps the first taxon/root
        // parent it sees and files the rest as cross-cutting group parents. Put
        // GBIF's answer first and a stale hand-placed clade gets replaced, while
        // a wired ecology group survives. Listing it last, as this did, meant a
        // taxon already sitting under a different clade (Mollusca under Metazoa,
        // say) never moved to the one GBIF returned.
        updateTag(childId, { parents: [parentId, ...nonChainParents] });
        parentChainEdits++;
      }
    }

    // Top of chain: link kingdom (or whatever is highest) under 'life' root if exists
    const topRankId = idsByRank[chain[0].rank];
    if (topRankId && byId.get('life')) {
      const top = byId.get(topRankId);
      if (top && (!top.parents || !top.parents.length)) {
        updateTag(topRankId, { parents: ['life'] });
      }
    }

    // Auto-wire class → ecology group tag (e.g. Actinopterygii → "fish").
    // If a group tag with the mapped label exists, add it as an extra parent of
    // the class-rank tag so hierarchical filtering through "fish" etc. works.
    const classId = idsByRank['class'];
    if (classId) {
      const classTag = byId.get(classId);
      if (classTag) {
        const groupLabel = CLASS_TO_GROUP[classTag.label];
        if (groupLabel) {
          const groupId = resolveInput(groupLabel);
          if (groupId) {
            const cp = classTag.parents || [];
            if (!cp.includes(groupId)) {
              updateTag(classId, { parents: [...cp, groupId] });
            }
          }
        }
      }
    }

    // ── Apply All extras: scientific-name-with-author alias + English common name
    let aliasAdded = false, commonSet = false;
    if (options.withAliasAndCommon) {
      const mostSpecificId = idsByRank[chain[chain.length - 1].rank];
      if (mostSpecificId) {
        const target = byId.get(mostSpecificId);
        if (target) {
          const patch = {};
          // 1) Add the clean canonical scientific name as an alias if it's a
          // distinct synonym (e.g. an old genus name). Authorship is stripped so
          // no comma ever enters the aliases field. Skip when it just duplicates
          // the label/common — that produced redundant (and comma-split) junk.
          const sci = stripAuthorship(res.canonicalName || res.scientificName);
          const sciLc = sci.toLowerCase();
          if (sci
              && sciLc !== String(target.label || '').toLowerCase()
              && sciLc !== String(target.common || '').toLowerCase()
              && !(target.aliases || []).some(a => String(a).toLowerCase() === sciLc)) {
            patch.aliases = [...(target.aliases || []), sci];
            aliasAdded = true;
          }
          // 2) Set English common name if target lacks one
          if (!target.common) {
            const v = pickVernacular(res);
            if (v && v.lang === 'en') {
              patch.common = v.name;
              commonSet = true;
            }
          }
          if (Object.keys(patch).length) updateTag(mostSpecificId, patch);
        }
      }
    }

    // Original tag: if it represents a less-specific concept (e.g. user typed
    // "orchid mantis" common name), re-point it as a child of the most-specific
    // imported rank. If the original IS one of the imported ranks (e.g. user
    // had "Hymenopus coronatus" already), leave it alone — the chain edits
    // already linked things correctly. Detect overlap by checking whether
    // tagId equals any value in idsByRank.
    let originalRehomed = false;
    let demoteBlocked = false;
    const overlap = Object.values(idsByRank).includes(tagId);
    if (!overlap) {
      // Most-specific rank present
      const mostSpecificRank = chain[chain.length - 1].rank;
      const mostSpecific = idsByRank[mostSpecificRank];

      // (mim0254) Refuse to silently demote a binomial-labeled tag down into
      // a coarser rank like order. If user typed "Thaumoctopus mimicus" and
      // GBIF only returned the chain up to family/order (sparse-data candidate,
      // synonym entry, etc.) we'd otherwise re-tag their records to point at
      // the order — which is how a Thaumoctopus mimicus tag once became
      // Octopoda. Keep the original tag intact; the user can re-run GBIF on a
      // better candidate or fix the dictionary manually.
      const labelIsBinomial = /^[A-Z][a-z]+\s+[a-z]+$/.test(t.label || '');
      const coarseRanks = new Set(['kingdom','phylum','class','order','family']);
      if (mostSpecific && labelIsBinomial && coarseRanks.has(mostSpecificRank)) {
        demoteBlocked = true;
      }

      if (mostSpecific && !demoteBlocked) {
        // Add the original's label as alias of the species (so common-name
        // searches still work) and delete the now-redundant original.
        const target = byId.get(mostSpecific);
        // (dev1116) The register says the name you had is out of date — WoRMS
        // followed it to the accepted name, or GBIF matched it as a synonym. It
        // is the species' former name: it goes in Formerly. Before this it fell
        // through to the test below and, on a species with no English common
        // name, was saved AS the common name (the old binomial shown as the
        // vernacular). Formerly names the original already had come along too.
        const supersededName = !!res._supersededFrom
          || String(res.status || '').toUpperCase() === 'SYNONYM';
        if (target && (t.formerly || []).length) {
          updateTag(mostSpecific, { formerly: (target.formerly || []).concat(t.formerly) });
        }
        if (target && t.label && supersededName) {
          addFormerly(mostSpecific, t.label);
        } else if (target && t.label) {
          const existingAliases = target.aliases || [];
          const lc = t.label.toLowerCase();
          if (!existingAliases.some(a => String(a).toLowerCase() === lc)
              && lc !== target.label.toLowerCase()
              && lc !== (target.common || '').toLowerCase()) {
            // Decide common vs alias by comparing the label to the canonical
            // scientific name from GBIF, not by regex. The old regex falsely
            // classified common names like "Mimic octopus" as binomials, so
            // they ended up in aliases instead of as the common name.
            const canonicalLc = String(res.canonicalName || '').toLowerCase();
            const looksLikeScientificName = canonicalLc && lc === canonicalLc;
            if (!target.common && !looksLikeScientificName) {
              updateTag(mostSpecific, { common: t.label });
            } else {
              updateTag(mostSpecific, { aliases: [...existingAliases, t.label] });
            }
          }
        }
        // Re-tag any video records that pointed at original → point at species
        if (typeof data !== 'undefined' && Array.isArray(data)) {
          let recs = 0;
          data.forEach(r => {
            if (Array.isArray(r.tags) && r.tags.includes(tagId)) {
              r.tags = r.tags.filter(x => x !== tagId);
              if (!r.tags.includes(mostSpecific)) r.tags.push(mostSpecific);
              recs++;
            }
          });
          if (recs && typeof save === 'function') save();
        }
        // Delete the original tag
        deleteTag(tagId);
        originalRehomed = true;
      }
    }

    // (mim0254) When the original tag is kept (either because it overlaps with
    // one of the imported ranks, or because we refused to demote it) and it
    // wasn't already marked as a taxon, promote it now — the user just told us
    // it's a taxon by running GBIF on it and accepting the chain.
    const survivingId = originalRehomed ? null : tagId;
    if (survivingId) {
      const surv = byId.get(survivingId);
      if (surv && surv.kind !== 'taxon') {
        const patch = { kind: 'taxon' };
        if (!surv.rank && res.rank) patch.rank = String(res.rank).toLowerCase();
        updateTag(survivingId, patch);
      }
    }

    // The tag we ended up on. Computed before the toast so the toast can name
    // the chain it just wired instead of only counting it.
    const finalId = originalRehomed
      ? idsByRank[chain[chain.length - 1].rank]
      : tagId;

    if (typeof toast === 'function') {
      const lines = [options.withAliasAndCommon ? '✓ Applied All from GBIF' : '✓ Imported GBIF chain'];
      const wiredPath = finalId ? tagLineageString(finalId) : '';
      if (wiredPath) lines.push('↑ ' + wiredPath);
      lines.push(createdCount + ' new taxa created · ' + reusedCount + ' reused');
      if (parentChainEdits) lines.push(parentChainEdits + ' parent links set');
      if (aliasAdded) lines.push('scientific name + author added as alias');
      if (commonSet) lines.push('English common name set');
      if (originalRehomed) lines.push('Original tag merged into species (records re-tagged)');
      if (demoteBlocked) {
        lines.push('⚠ Original tag "' + (t.label || '') + '" kept — GBIF chain stopped at '
          + chain[chain.length - 1].rank + ', would have demoted a binomial label.');
        lines.push('Try a different candidate, or fix the dictionary by hand.');
      }
      toast(lines.join('\n'), demoteBlocked ? 6000 : 3800);
    }
    if (typeof render === 'function') render();

    // Refresh dictionary view, jump selection to the species we ended up with.
    // Its CLASSIFIED UNDER block is the persistent record of what Apply All did.
    if (dictOverlay && dictOverlay._selectTag && finalId) {
      dictOverlay._selectTag(finalId);
    } else {
      // Fallback if dictOverlay state isn't quite right
      selectTagFromOutside(finalId);
    }
  }

  // Helper to re-select a tag after an outside change — works because selectTag
  // is defined inside openDictionary's closure. We expose it via a dispatcher on
  // dictOverlay so GBIF apply buttons can trigger a refresh.
  function selectTagFromOutside(id) {
    if (dictOverlay && dictOverlay._selectTag) dictOverlay._selectTag(id);
  }


  function seedDictionary() {
    const T = [];
    T.push({ _salMeta: true, _tagsVersion: 1,
      _salColOrder: ['id','label','kind','rank','parents','aliases','formerly','common','facts1','facts2','facts3','NameOrigin','NameSay','extinct'],
      _salColWidths: { id:140, label:170, kind:70, rank:80, parents:200, aliases:220, formerly:170, common:140, facts1:320, extinct:60 }
    });
    // Roots
    T.push({ id:'life',     label:'Life',     kind:'root', parents:[] });
    T.push({ id:'health',   label:'Health',   kind:'root', parents:[] });
    T.push({ id:'activity', label:'Activity', kind:'root', parents:[] });
    T.push({ id:'other',    label:'Other',    kind:'root', parents:[] });

    // All phyla from index.html's PHYLA_EXTANT list
    const phyla = ['Annelida','Arthropoda','Brachiopoda','Bryozoa','Chaetognatha','Chordata',
      'Cnidaria','Ctenophora','Cycliophora','Dicyemida','Echinodermata','Entoprocta',
      'Gastrotricha','Gnathostomulida','Hemichordata','Kinorhyncha','Loricifera',
      'Micrognathozoa','Mollusca','Monoblastozoa','Nematoda','Nematomorpha','Nemertea',
      'Onychophora','Orthonectida','Phoronida','Placozoa','Platyhelminthes','Porifera',
      'Priapulida','Rotifera','Tardigrada','Xenacoelomorpha'];
    phyla.forEach(p => T.push({ id: slugify(p), label: p, kind:'taxon', rank:'phylum', parents:['life'] }));
    const phylaExt = ['Agmata','Petalonamae','Proarticulata','Saccorhytida','Trilobozoa','Vetulicolia'];
    phylaExt.forEach(p => T.push({ id: slugify(p), label: p, kind:'taxon', rank:'phylum', parents:['life'], extinct:true }));

    // Intermediate taxa to cover current data
    T.push({ id:'crustacea',       label:'Crustacea',       kind:'taxon', rank:'subphylum', parents:['arthropoda'] });
    T.push({ id:'chelicerata',     label:'Chelicerata',     kind:'taxon', rank:'subphylum', parents:['arthropoda'] });
    T.push({ id:'malacostraca',    label:'Malacostraca',    kind:'taxon', rank:'class',     parents:['crustacea'] });
    T.push({ id:'amphipoda',       label:'Amphipoda',       kind:'taxon', rank:'order',     parents:['malacostraca'], aliases:['amphipod','amphipods'] });
    T.push({ id:'isopoda',         label:'Isopoda',         kind:'taxon', rank:'order',     parents:['malacostraca'], aliases:['isopod','isopod crustacean'] });
    T.push({ id:'caprellidae',     label:'Caprellidae',     kind:'taxon', rank:'family',    parents:['amphipoda'],
      aliases:['caprellid','caprellid amphipod','skeleton shrimp','skeleton shrimps','ghost shrimp'],
      facts1:'<p>Family of amphipod crustaceans with elongated slender bodies, typically clinging to algae or hydroids and moving in an inchworm fashion.</p>' });
    T.push({ id:'phtisica',        label:'Phtisica',        kind:'taxon', rank:'genus',     parents:['caprellidae'] });
    T.push({ id:'phtisica-marina', label:'Phtisica marina', kind:'taxon', rank:'species',   parents:['phtisica'], common:'Skeleton shrimp' });
    T.push({ id:'liropus',         label:'Liropus',         kind:'taxon', rank:'genus',     parents:['caprellidae'] });
    T.push({ id:'liropus-minusculus', label:'Liropus minusculus', kind:'taxon', rank:'species', parents:['liropus'], common:'Skeleton shrimp' });

    // Fish
    T.push({ id:'actinopterygii', label:'Actinopterygii', kind:'taxon', rank:'class', parents:['chordata'], aliases:['ray-finned fish','bony fish'] });
    T.push({ id:'notothenioidei', label:'Notothenioidei', kind:'taxon', rank:'suborder', parents:['actinopterygii'] });
    T.push({ id:'channichthyidae', label:'Channichthyidae', kind:'taxon', rank:'family', parents:['notothenioidei'], aliases:['icefish','crocodile icefish'] });
    T.push({ id:'chaenocephalus', label:'Chaenocephalus', kind:'taxon', rank:'genus', parents:['channichthyidae'] });
    T.push({ id:'chaenocephalus-aceratus', label:'Chaenocephalus aceratus', kind:'taxon', rank:'species', parents:['chaenocephalus'], common:'Blackfin icefish', aliases:['icefish'] });
    T.push({ id:'polyprionidae', label:'Polyprionidae', kind:'taxon', rank:'family', parents:['actinopterygii'] });
    T.push({ id:'stereolepis', label:'Stereolepis', kind:'taxon', rank:'genus', parents:['polyprionidae'] });
    T.push({ id:'stereolepis-gigas', label:'Stereolepis gigas', kind:'taxon', rank:'species', parents:['stereolepis'], common:'Giant sea bass', aliases:['giant sea bass'] });
    T.push({ id:'sebastidae', label:'Sebastidae', kind:'taxon', rank:'family', parents:['actinopterygii'] });
    T.push({ id:'sebastes', label:'Sebastes', kind:'taxon', rank:'genus', parents:['sebastidae'], aliases:['rockfish'] });
    T.push({ id:'sebastes-flavidus', label:'Sebastes flavidus', kind:'taxon', rank:'species', parents:['sebastes'], common:'Yellowfin rockfish', aliases:['yellowfin rockfish'] });
    T.push({ id:'labridae', label:'Labridae', kind:'taxon', rank:'family', parents:['actinopterygii'], aliases:['wrasses'] });
    T.push({ id:'semicossyphus-pulcher', label:'Semicossyphus pulcher', kind:'taxon', rank:'species', parents:['labridae'], common:'California sheephead', aliases:['california sheephead','sheephead'] });

    // Echinoderms
    T.push({ id:'echinoidea', label:'Echinoidea', kind:'taxon', rank:'class', parents:['echinodermata'], aliases:['sea urchin','sea urchins'] });
    T.push({ id:'astropyga', label:'Astropyga', kind:'taxon', rank:'genus', parents:['echinoidea'] });
    T.push({ id:'astropyga-radiata', label:'Astropyga radiata', kind:'taxon', rank:'species', parents:['astropyga'], common:'Blue-spotted sea urchin', aliases:['blue-spotted sea urchin'] });
    T.push({ id:'crinoidea', label:'Crinoidea', kind:'taxon', rank:'class', parents:['echinodermata'], aliases:['feather star','sea lily','crinoid'] });
    T.push({ id:'holothuroidea', label:'Holothuroidea', kind:'taxon', rank:'class', parents:['echinodermata'], aliases:['sea cucumber','sea cucumbers','sea pig'] });
    T.push({ id:'enypniastes', label:'Enypniastes', kind:'taxon', rank:'genus', parents:['holothuroidea'] });
    T.push({ id:'enypniastes-eximia', label:'Enypniastes eximia', kind:'taxon', rank:'species', parents:['enypniastes'], common:'Swimming sea cucumber', aliases:['swimming sea cucumber','headless chicken monster'] });
    T.push({ id:'asteroidea', label:'Asteroidea', kind:'taxon', rank:'class', parents:['echinodermata'], aliases:['sea star','starfish','leather star'] });
    T.push({ id:'ophiuroidea', label:'Ophiuroidea', kind:'taxon', rank:'class', parents:['echinodermata'], aliases:['brittle star','basket star'] });
    T.push({ id:'gorgonocephalus', label:'Gorgonocephalus', kind:'taxon', rank:'genus', parents:['ophiuroidea'], aliases:['basket star'] });

    // Cnidarians
    T.push({ id:'anthozoa', label:'Anthozoa', kind:'taxon', rank:'class', parents:['cnidaria'], aliases:['anemone','anemones','coral'] });
    T.push({ id:'actiniaria', label:'Actiniaria', kind:'taxon', rank:'order', parents:['anthozoa'], aliases:['sea anemone','sea anemones'] });
    T.push({ id:'urticina', label:'Urticina', kind:'taxon', rank:'genus', parents:['actiniaria'] });
    T.push({ id:'urticina-grebelnyi', label:'Urticina grebelnyi', kind:'taxon', rank:'species', parents:['urticina'], common:'Painted anemone', aliases:['painted anemone'] });
    T.push({ id:'condylactis', label:'Condylactis', kind:'taxon', rank:'genus', parents:['actiniaria'] });
    T.push({ id:'condylactis-gigantea', label:'Condylactis gigantea', kind:'taxon', rank:'species', parents:['condylactis'], common:'Giant anemone', aliases:['giant anemone'] });
    T.push({ id:'stomphia', label:'Stomphia', kind:'taxon', rank:'genus', parents:['actiniaria'] });
    T.push({ id:'stomphia-coccinea', label:'Stomphia coccinea', kind:'taxon', rank:'species', parents:['stomphia'], common:'Swimming anemone', aliases:['swimming anemone'] });

    // Ctenophora (comb jellies)
    T.push({ id:'comb-jelly', label:'Comb jelly', kind:'taxon', rank:'class', parents:['ctenophora'], aliases:['comb jelly','comb jellies','ctenophore'] });

    // Mollusks
    T.push({ id:'cephalopoda', label:'Cephalopoda', kind:'taxon', rank:'class', parents:['mollusca'] });
    T.push({ id:'octopoda', label:'Octopoda', kind:'taxon', rank:'order', parents:['cephalopoda'], aliases:['octopus','octopuses','octopi'] });

    // Annelids
    T.push({ id:'polychaeta', label:'Polychaeta', kind:'taxon', rank:'class', parents:['annelida'], aliases:['polychaete','bristle worm'] });
    T.push({ id:'scale-worm', label:'Scale worm', kind:'taxon', rank:'order', parents:['polychaeta'], aliases:['scale worm','scale worms','polynoidae'] });

    // Tunicates / Chordata
    T.push({ id:'tunicata', label:'Tunicata', kind:'taxon', rank:'subphylum', parents:['chordata'], aliases:['tunicate','sea squirt','ascidian'] });
    T.push({ id:'megalodicopia', label:'Megalodicopia', kind:'taxon', rank:'genus', parents:['tunicata'] });
    T.push({ id:'megalodicopia-hians', label:'Megalodicopia hians', kind:'taxon', rank:'species', parents:['megalodicopia'], common:'Predatory tunicate', aliases:['predatory tunicate'] });

    // Extinct chelicerates
    T.push({ id:'megachelicerax', label:'Megachelicerax', kind:'taxon', rank:'genus', parents:['chelicerata'], extinct:true, aliases:['cambrian chelicerate'] });
    T.push({ id:'megachelicerax-cousteaui', label:'Megachelicerax cousteaui', kind:'taxon', rank:'species', parents:['megachelicerax'], extinct:true });

    // Topics (non-taxa) — crosscutting
    T.push({ id:'predation',       label:'Predation',       kind:'topic', parents:[] });
    T.push({ id:'symbiosis',       label:'Symbiosis',       kind:'topic', parents:[] });
    T.push({ id:'mating',          label:'Mating & reproduction', kind:'topic', parents:[] });
    T.push({ id:'locomotion',      label:'Locomotion',      kind:'topic', parents:[] });
    T.push({ id:'camouflage',      label:'Camouflage',      kind:'topic', parents:[] });
    T.push({ id:'larval-stage',    label:'Larval stage',    kind:'topic', parents:[] });
    T.push({ id:'deep-sea',        label:'Deep sea',        kind:'topic', parents:[] });
    T.push({ id:'tide-pool',       label:'Tide pool',       kind:'topic', parents:[] });
    T.push({ id:'bioluminescence', label:'Bioluminescence', kind:'topic', parents:[] });

    // Techniques
    T.push({ id:'macro-photo',     label:'Macro photography', kind:'technique', parents:[], aliases:['macro','macrophoto'] });
    T.push({ id:'underwater-video',label:'Underwater video',  kind:'technique', parents:[] });
    T.push({ id:'microscopy',      label:'Microscopy',        kind:'technique', parents:[] });

    // Health roots subset
    T.push({ id:'diet-nutrition',  label:'Diet & Nutrition', kind:'topic', parents:['health'] });
    T.push({ id:'exercise-body',   label:'Exercise & Body',  kind:'topic', parents:['health'] });
    T.push({ id:'mental-health',   label:'Mental health',    kind:'topic', parents:['health'] });
    T.push({ id:'sleep',           label:'Sleep',            kind:'topic', parents:['health'] });

    // Activity roots subset
    T.push({ id:'tennis',          label:'Tennis',   kind:'topic', parents:['activity'] });
    T.push({ id:'swimming',        label:'Swimming', kind:'topic', parents:['activity'] });
    T.push({ id:'cycling',         label:'Cycling',  kind:'topic', parents:['activity'] });
    T.push({ id:'hiking',          label:'Hiking & Outdoors', kind:'topic', parents:['activity'] });

    // Other
    T.push({ id:'humor',           label:'Humor',     kind:'topic', parents:['other'] });
    T.push({ id:'science',         label:'Science',   kind:'topic', parents:['other'] });
    T.push({ id:'reference',       label:'Reference', kind:'topic', parents:['other'] });

    return T;
  }
})();
