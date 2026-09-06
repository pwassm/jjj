// ══════════════════════════════════════════════════════════════════════════════
// lang.js — SPANISH (dev0930)  ·  the translation shim
// ══════════════════════════════════════════════════════════════════════════════
//
// STEP 1 of the Spanish plan: the site can be read in Spanish by a viewer on
// sealifeandmore.com, toggled from a button on menu page 1. Nothing about the
// DEV screens (T / A / E / D / Xe / I / St / O / X / LLC) is translated and
// nothing here runs for them — this is a viewer-facing feature only.
//
// ── THE KEY IS THE ENGLISH STRING ────────────────────────────────────────────
// T('Welcome') looks up "Welcome" in lang.es.json and returns "Bienvenido", or
// returns "Welcome" unchanged if there is no entry. That choice is deliberate
// and it is the whole reason this could be retrofitted onto a codebase that
// never had an i18n layer:
//   • no key registry to invent, maintain, or keep in sync
//   • a missing translation degrades to English instead of to "menu.tab.1"
//   • deleting a string from the JSON is a safe no-op
//   • the diff at every call site is T( ... ) around text that already read well
// The cost is that one English string cannot have two Spanish readings in two
// different places. At this size that has not come up; if it ever does, the
// escape hatch is T('Close|verb') with the disambiguator stripped after lookup.
//
// ── LOADING ──────────────────────────────────────────────────────────────────
// lang.js is FIRST in the files[] list in index.html — before helpfloat.js. It
// registers no key listener, so it does not disturb the helpfloat→core keydown
// ordering that comment protects; it just needs to define window.T before any
// other file's top-level code can call it.
//
// The dictionary is fetched async. t() is SYNCHRONOUS and falls back to English
// until it lands, so an early caller is never blocked and never throws. The one
// surface that must not flash English first is the menu, so _showShareableMenu
// awaits salLang.ready() before it builds. Everything else (G, V) mounts long
// after the fetch has settled.
//
// ── WHY A RELOAD ON TOGGLE ───────────────────────────────────────────────────
// Switching language reloads the page. The menu, the grid and the viewers all
// build their text once at mount from dozens of call sites; re-running every
// one of them in place would mean a re-render path per screen and a new class
// of "half-translated" bug. A reload is one line, cannot go stale, and on
// sealifeandmore.com everything is inside the 10-minute shell cache anyway, so
// it costs a repaint rather than a download.
//
// ── CUT-OUT INSTRUCTIONS ─────────────────────────────────────────────────────
//   1. delete this file, lang.es.json, taxoninfo.es.json, tags.es.json,
//      ftext.es.json
//   2. delete 'lang.js' from the files[] array in index.html
//   3. drop the #smLangBtn block from boot.js (menu page 1) and its CSS
//   4. in taxoninfo.js, delete the _esStore block and the two _pick() calls
//   5. in vp.js and grid.js, change salFtext(row) back to row.ftext (the
//      helper is null-safe but undefined without this file)
//   6. the T() wrappers can stay — with no window.T they are inert, but the
//      shim below is what defines T, so remove them or keep this file.
// ══════════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  var LS_KEY  = 'slam-lang';
  var SUPPORTED = { en: 'English', es: 'Español' };

  var dict    = null;    // { "English string": "Spanish string" }
  var readyP  = null;
  var current = 'en';

  // ── which language ──────────────────────────────────────────────────────────
  // ?lang= wins (so a link can be shared already-Spanish), then the stored
  // choice. No navigator.language sniffing: this site's audience is largely
  // English-speaking and guessing from the browser would flip the site under
  // people who never asked for it. The button is the way in.
  function pick() {
    var q = '';
    try { q = (new URLSearchParams(location.search).get('lang') || '').toLowerCase(); } catch (e) {}
    if (SUPPORTED[q]) return q;
    try {
      var ls = (localStorage.getItem(LS_KEY) || '').toLowerCase();
      if (SUPPORTED[ls]) return ls;
    } catch (e) {}
    return 'en';
  }

  current = pick();

  // html.lang-es is the hook for the handful of places where Spanish's extra
  // length needs a smaller font rather than a wrap — see the menu tab rule in
  // boot.js. documentElement.lang is set for correctness (screen readers,
  // hyphenation) and so a glance at the DOM says which mode the page is in.
  function stamp() {
    try {
      document.documentElement.lang = current;
      document.documentElement.classList.toggle('lang-es', current === 'es');
    } catch (e) {}
  }
  stamp();

  // ── the dictionary ──────────────────────────────────────────────────────────
  function load() {
    if (readyP) return readyP;
    if (current === 'en') { dict = {}; readyP = Promise.resolve({}); return readyP; }
    readyP = fetch('lang.' + current + '.json?v=' + (window.HELP_VERSION_STR || ''))
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (d) {
        // The file is authored in sections ({ "menu": {...}, "grid": {...} }) so
        // a human can find a string in it. Flatten to one map here — the call
        // sites do not know or care which section their string came from, and a
        // string that moves between sections must not stop resolving.
        var flat = {};
        Object.keys(d || {}).forEach(function (k) {
          if (k.charAt(0) === '_') return;                 // _meta, _notes
          var v = d[k];
          if (v && typeof v === 'object') {
            Object.keys(v).forEach(function (kk) {
              if (typeof v[kk] === 'string' && v[kk]) flat[kk] = v[kk];
            });
          } else if (typeof v === 'string' && v) { flat[k] = v; }
        });
        dict = flat;
        return flat;
      })
      .catch(function () { dict = {}; return {}; });
    return readyP;
  }
  load();

  // ── T ───────────────────────────────────────────────────────────────────────
  // Synchronous, total, and never throws. Returns the English argument for:
  // English mode, a dictionary that has not landed, a missing entry, a non-string
  // argument. That totality is what makes it safe to wrap anything.
  function t(en) {
    if (current === 'en' || !dict) return en;
    if (typeof en !== 'string' || !en) return en;
    var hit = dict[en];
    if (typeof hit === 'string' && hit) return hit;
    // Disambiguator escape hatch: 'Close|verb' falls back to 'Close'.
    var bar = en.indexOf('|');
    if (bar > 0) {
      var base = en.slice(0, bar);
      var h2 = dict[base];
      return (typeof h2 === 'string' && h2) ? h2 : base;
    }
    return en;
  }

  function set(code) {
    if (!SUPPORTED[code] || code === current) return;
    try { localStorage.setItem(LS_KEY, code); } catch (e) {}
    // Drop ?lang= from the URL on the way out, otherwise a shared ?lang=es link
    // would pin the page and the button would appear to do nothing.
    var url;
    try {
      url = new URL(location.href);
      url.searchParams.delete('lang');
    } catch (e) { url = null; }
    location.replace(url ? url.toString() : location.href);
  }

  // ── static HTML in index.html ───────────────────────────────────────────────
  // Most of the site's text is built by JS and goes through T() at its call
  // site. A handful of viewer-facing controls are static markup in index.html
  // instead — the user-mode hamburger items, the menu button's tooltip — and
  // those cannot call T() because they were parsed before any script ran.
  //
  // Mark them  data-t="English text"  and this pass rewrites them after load.
  // The attribute holds the English so the DICTIONARY KEY IS STILL THE ENGLISH
  // STRING, exactly as everywhere else, and the element's own markup stays
  // readable in index.html for anyone reading the file rather than the page.
  //
  //   data-t       -> innerHTML  (translations may carry markup, e.g. <u>H</u>)
  //   data-t-title -> title attribute
  //
  // Runs once, at DOMContentLoaded, and only in Spanish — in English every
  // element already says the right thing and touching them would be pure risk.
  function applyStatic() {
    if (current === 'en') return;
    try {
      document.querySelectorAll('[data-t]').forEach(function (el) {
        var en = el.getAttribute('data-t');
        var es = t(en);
        if (es && es !== en) el.innerHTML = es;
      });
      document.querySelectorAll('[data-t-title]').forEach(function (el) {
        var en = el.getAttribute('data-t-title');
        var es = t(en);
        if (es && es !== en) el.title = es;
      });
    } catch (e) {}
  }
  // The dictionary and DOMContentLoaded race, so wait for both.
  load().then(function () {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', applyStatic, { once: true });
    } else { applyStatic(); }
  });

  // ── tags.es.json ────────────────────────────────────────────────────────────
  // Spanish tag text, kept out of tags.json for the same reason taxoninfo.json is
  // kept out of it: saveTags() rewrites the WHOLE array and mirrors it into
  // localStorage on every tag edit, and hanging more text off that write path is
  // the shape of the ftext wipe. Two maps:
  //   common — Spanish vernacular per TAXON tag  (harvested; see tags-es-harvest.js)
  //   labels — Spanish name per NON-TAXON tag    (hand-translated; no database has these)
  // Both are sparse. A miss returns '' and the caller keeps its English text.
  var tagsEs = null;
  var tagsEsP = null;
  function loadTagsEs() {
    if (tagsEsP) return tagsEsP;
    if (current === 'en') { tagsEs = { common: {}, labels: {} }; tagsEsP = Promise.resolve(tagsEs); return tagsEsP; }
    tagsEsP = fetch('tags.es.json?v=' + (window.HELP_VERSION_STR || ''))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        tagsEs = { common: (d && d.common) || {}, labels: (d && d.labels) || {} };
        return tagsEs;
      })
      .catch(function () { tagsEs = { common: {}, labels: {} }; return tagsEs; });
    return tagsEsP;
  }
  loadTagsEs();

  window.salTagsEs = {
    ready:  loadTagsEs,
    common: function (id) { return (current === 'es' && tagsEs && tagsEs.common[id]) || ''; },
    label:  function (id) { return (current === 'es' && tagsEs && tagsEs.labels[id]) || ''; },
    // "What should this tag chip say?" — the Spanish label for a topic tag, the
    // Spanish common name for a taxon, else whatever English text was passed in.
    // Binomials are deliberately NOT touched: a scientific name is the same in
    // every language and translating one would be a straight error.
    chip: function (id, enText) {
      if (current !== 'es' || !tagsEs) return enText;
      return tagsEs.labels[id] || tagsEs.common[id] || enText;
    }
  };

  // ── ftext.es.json ───────────────────────────────────────────────────────────
  // STEP 2 of the Spanish plan: the CONTENT, not just the chrome. A card's own
  // prose lives in ml.json's `ftext`, and ml.json is a dev file that the app
  // rewrites on every save — so the Spanish copy is a READ-ONLY SIDECAR keyed by
  // UID, exactly like taxoninfo.es.json. Nothing here is ever written back.
  //
  // That separation is not tidiness, it is the whole safety argument:
  //   • ml.json is gitignored and FSA-clobbered by the running app. A second
  //     language column in it would be overwritten by the next save.
  //   • ftext is ~90% of ml.json and irreplaceable. The one historic mass-wipe
  //     came from a read path that fed a write path. salFtext() is read-only and
  //     row.ftext in memory is NEVER reassigned, so the Spanish string cannot
  //     reach disk however the app is driven.
  //   • A viewer in Spanish and a dev in English are looking at the same row.
  //
  // The value is the WHOLE ftext, `<hr>` sections and all, because every reader
  // (the V slide pager, makeCardSplit's card faces, the G thumbnail) splits it
  // itself and a per-section store would have to reproduce that splitter three
  // times. The picture URL in section 1 is therefore duplicated, which is the
  // one real cost: change a card's image and its Spanish copy still points at
  // the old one. `enLen` is recorded per entry so a stale copy can be FOUND —
  // salFtextEs.stale(rows) lists the cards whose English has moved since.
  //
  // An entry may be a bare string instead of { enLen, ftext } — a translation
  // added by hand should not have to carry bookkeeping to work.
  var ftEs  = null;
  var ftEsP = null;
  function loadFtextEs() {
    if (ftEsP) return ftEsP;
    if (current === 'en') { ftEs = {}; ftEsP = Promise.resolve(ftEs); return ftEsP; }
    ftEsP = fetch('ftext.es.json?v=' + (window.HELP_VERSION_STR || ''))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { ftEs = (d && d.cards) || {}; return ftEs; })
      .catch(function () { ftEs = {}; return ftEs; });
    return ftEsP;
  }
  loadFtextEs();

  function esEntry(uid) {
    if (current !== 'es' || !ftEs || uid == null) return null;
    var e = ftEs[String(uid)];
    if (typeof e === 'string') return e ? { ftext: e, enLen: null } : null;
    if (e && typeof e.ftext === 'string' && e.ftext) return e;
    return null;
  }

  window.salFtextEs = {
    ready: loadFtextEs,
    has:   function (uid) { return !!esEntry(uid); },
    // Which cards have drifted? Pass the ml.json rows; get back the UIDs whose
    // English ftext is no longer the length the translation was made from. A
    // null enLen (hand-added entry) is never stale — it never claimed a source.
    stale: function (rows) {
      var out = [];
      if (!ftEs || !rows) return out;
      rows.forEach(function (r) {
        if (!r || r.UID == null) return;
        var e = ftEs[String(r.UID)];
        if (!e || typeof e === 'string' || e.enLen == null) return;
        if ((r.ftext || '').length !== e.enLen) out.push(String(r.UID));
      });
      return out;
    }
  };

  // ── salFtext(row) ───────────────────────────────────────────────────────────
  // THE ONE ACCESSOR every viewer-facing render path reads ftext through. Total:
  // English mode, a sidecar that has not landed, a row with no translation, a
  // row with no ftext at all — every one of them returns the English string the
  // caller would have used anyway, so wrapping a read site cannot break it.
  //
  // The rule for a call site is simply: READS go through salFtext(row), WRITES
  // stay on row.ftext. Anything that edits, saves, measures for a save, or
  // computes a stored column must keep using row.ftext directly.
  window.salFtext = function (row) {
    if (!row) return '';
    var en = row.ftext || '';
    var e  = esEntry(row.UID);
    return e ? e.ftext : en;
  };

  window.salLang = {
    get:   function () { return current; },
    is:    function (c) { return current === c; },
    set:   set,
    t:     t,
    // ready() settles when EVERY Spanish file this shim owns has landed —
    // the dictionary, the tag names and the ftext sidecar. boot.js awaits it
    // before it builds the menu, and a caller that waited for the chrome and
    // then found the content still in English would be a bug that only ever
    // showed up on a cold load. Each of the three swallows its own failure, so
    // the whole is as total as the parts: it never rejects.
    ready: function () { return Promise.all([load(), loadTagsEs(), loadFtextEs()]); },
    langs: SUPPORTED,
    // For the generators and the taxoninfo/tags sidecar lookups: "should the
    // Spanish data files be consulted at all?"
    esActive: function () { return current === 'es'; }
  };
  window.T = t;
})();
