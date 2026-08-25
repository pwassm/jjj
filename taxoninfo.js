// ══════════════════════════════════════════════════════════════════════════════
// TAXON INFO  (dev0847)  —  Tier 1 species/taxon enrichment for the card backs
// ══════════════════════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS. The Turn/Fold card backs in G show a row's tag chips over the
// first five lines of its ftext — but 677 of the 1,019 tagged rows have NO ftext
// at all, so two thirds of the backs are chips over blank space. This fills that
// blank space from the dictionary side instead of the row side: one short note per
// TAXON, written once, reused by every row that carries the tag.
//
// NAMED taxoninfo, NOT speciesinfo, deliberately — a phylum or an order is often
// the more interesting card ("Order of flying mammals"), and every lookup here
// works at any rank. Ranks above species are first-class, not a fallback.
//
// ──────────────────────────────────────────────────────────────────────────────
// WHY A SEPARATE FILE, NOT A COLUMN IN tags.json
//
// saveTags() rewrites the WHOLE tags.json array and mirrors the whole thing into
// localStorage['sal-tags'] on EVERY tag edit (tags.js). Hanging a few hundred KB
// of prose off that write path means re-serialising all of it every time someone
// renames a tag, and pushing a large payload through localStorage — which is the
// exact shape of the ftext wipe. So the notes live in their own taxoninfo.json,
// loaded lazily (first panel open / first card back that wants one), and written
// only when enrichment actually changes something. tags.json stays lean and the
// chip render path stays untouched.
//
// ──────────────────────────────────────────────────────────────────────────────
// HOW A LOOKUP IS VERIFIED — the part that stops it filling in garbage
//
// Wikipedia titles are not taxon names, and taxon names are not unique across
// kingdoms. Naively trusting /page/summary/<label> gets you:
//     Morus       -> a disambiguation page (a mulberry genus AND the gannets)
//     Aurelia     -> a disambiguation page
//     Sarcodina   -> redirects to "Amoeba", an obsolete grouping
//     Mertensia   -> the BORAGE genus, when ours is the comb jelly
//     Hippocampus -> the BRAIN REGION, when ours is the seahorse genus
// So every hit is checked against Wikidata property P225 (taxon name), which is
// the authoritative "this article is about this taxon" statement:
//
//   1. Ask the Action API for a batch of titles. Each answer carries the intro
//      extract, the short description, and the page's Wikidata QID.
//   2. Ask Wikidata for those QIDs' claims. If P225 equals our label -> VERIFIED.
//      This is what lets  Chiroptera -> "Bat"  and  Paguroidea -> "Hermit crab"
//      be accepted: the TITLE differs wildly, but the taxon name matches exactly.
//      No P225 at all means the article is not about a taxon, which is how the
//      Hippocampus brain region gets turned away.
//   3. A binomial whose P225 is only the GENUS is still accepted, flagged viaGenus
//      — Wikipedia files Enypniastes eximia at the Enypniastes article, and that
//      genus page is the right reading for this animal even though the note
//      describes the genus rather than the species.
//   4. Disambiguation page, or missing/mismatched P225 -> fall back to searching
//      Wikidata for  haswbstatement:P225=<label> , which returns every taxon of
//      that name across all kingdoms, each with an English Wikipedia sitelink.
//   5. Exactly one candidate -> take it. Several -> score them against this tag's
//      OWN ancestry from tags.js (a Mertensia whose description says "ctenophores"
//      wins when our lineage contains Ctenophora). One clear winner is taken; a
//      tie is stored as  status:'ambiguous'  WITH the candidates, and the panel
//      shows them as one-click buttons. Nothing ambiguous is ever guessed.
//
// Anything that fails every step is recorded as status:'none' rather than silently
// skipped, so the panel can show you what has no source instead of a blank row.
//
// ──────────────────────────────────────────────────────────────────────────────
// WHAT TIER 1 STORES  (per taxon id)
//   note        Wikipedia intro extract, plain text — a few hundred chars up to
//               a couple of thousand. Stored whole; the CARD decides how much
//               of it to show, because truncating on the way in loses data
//               that a longer card back could have used.
//   descr       Wikipedia's one-line description ("Order of flying mammals")
//   wiki        canonical article URL         wikiTitle  the article's real title
//   qid         Wikidata id                   thumb      lead image URL if any
//   iucn        IUCN status from Wikidata P141 ("vulnerable", "endangered", ...)
//   viaGenus    set when the note describes the GENUS, not this species
//   status      'ok' | 'ambiguous' | 'none'   fetched    ISO timestamp
//
// No common name is stored. tags.json already has a hand-curated `common` per
// taxon and Wikidata's P1843 contradicts it often enough to be a hazard — it
// calls Stereolepis gigas the "Black sea bass", which is a different fish.
//
// The eight-column trait table (habitat/range/size/lifespan/predators/diet/
// reproduction/dimorphism) is NOT here and is not a Tier 1 omission: no database
// exposes those columns. WoRMS attributes use an incompatible vocabulary, GBIF
// descriptions are empty about half the time, and Wikidata's trait properties are
// essentially absent for length/mass/lifespan. That work belongs in a Tier 2 pass
// that extracts the fields from the article prose, not in a fetch loop.
//
// ──────────────────────────────────────────────────────────────────────────────
// CUT-OUT INSTRUCTIONS — to remove the feature entirely:
//   1. delete this file and taxoninfo.json
//   2. delete 'taxoninfo.js' from the files[] array in index.html
//   3. in tags.js, drop the #dictTaxonInfo button from the dictionary toolbar
//      and its click handler
// Nothing else references it.
// ──────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  var FILE   = 'taxoninfo.json';
  var LS_KEY = 'sal-taxoninfo';
  var UA_HDR = { 'Api-User-Agent': 'SLAM-taxoninfo/1.0 (sealifeandmore.com)' };

  // BATCH is TITLES PER REQUEST, not requests in flight. One wave = one Wikipedia
  // call + one Wikidata call, so a whole run is a few dozen requests and the rate
  // limit never comes into it.
  //
  // TWENTY, not fifty. titles= accepts 50, and the first run used 40 - but the
  // TextExtracts module caps extracts at 20 pages per request no matter what, and
  // it does NOT warn. exlimit=max does not lift it for anonymous callers; it was
  // measured returning exactly 20 extracts for 25 titles. At 40 titles a wave, the
  // last 20 came back as perfectly good pages with QIDs, correct P225, and NO
  // extract - so they were stored status:'ok' with an empty note, which is the
  // worst possible outcome: 169 of 456 records looked fine and had nothing to
  // show on a card. Keep BATCH <= 20 so every page in a wave gets its text.
  var BATCH      = 20;
  var BATCH_REST = 250;
  var RETRIES    = 3;      // per request, on 429/5xx, with widening backoff

  var store   = null;     // { _salMeta, _version, _updated, items:{ id: rec } }
  var loading = null;     // in-flight load promise
  var cancel  = false;    // set by the panel's Stop button

  // ── storage ─────────────────────────────────────────────────────────────────

  function blank() {
    return { _salMeta: true, _taxonInfoVersion: 1, _updated: '', items: {} };
  }

  async function load(force) {
    if (store && !force) return store;
    if (loading && !force) return loading;
    loading = (async function () {
      var raw = null;
      try {
        var r = await fetch(FILE + '?t=' + Date.now());
        if (r.ok) raw = await r.json();
      } catch (e) {}
      if (!raw) {
        try { var ls = localStorage.getItem(LS_KEY); if (ls) raw = JSON.parse(ls); } catch (e) {}
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = blank();
      if (!raw.items || typeof raw.items !== 'object') raw.items = {};
      store = raw;
      return store;
    })();
    return loading;
  }

  async function persist() {
    if (!store) return;
    store._updated = new Date().toISOString();
    try { localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch (e) {}
    if (typeof writeFileToDisk === 'function') {
      try { await writeFileToDisk(FILE, store); } catch (e) {}
    }
  }

  function get(id) { return (store && store.items && store.items[id]) || null; }
  function has(id) { var r = get(id); return !!(r && r.status === 'ok'); }

  // ── helpers ─────────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Retries on 429 and 5xx with a widening wait. A throttled response must never
  // be allowed to read as "this taxon has no article" — that is how the first seed
  // run wrote 174 empty records over perfectly good names.
  async function j(url) {
    var wait = 600, lastErr = null;
    for (var attempt = 0; attempt <= RETRIES; attempt++) {
      if (attempt) await new Promise(function (res) { setTimeout(res, wait); wait *= 2; });
      var r;
      try { r = await fetch(url, { headers: UA_HDR }); }
      catch (e) { lastErr = e; continue; }
      if (r.ok) return r.json();
      if (r.status === 404) throw new Error('HTTP 404');     // genuinely absent, do not retry
      lastErr = new Error('HTTP ' + r.status);
      if (r.status !== 429 && r.status < 500) throw lastErr; // a real refusal, not congestion
    }
    throw lastErr || new Error('request failed');
  }

  function say(msg, ms) {
    if (typeof toast === 'function') { try { toast(msg, ms || 2000); } catch (e) {} }
  }

  // Every taxon in the dictionary, plus how many ml.json rows actually carry it.
  // Usage matters here: the used taxa are the ones whose card backs are blank
  // right now, so they are what a "fetch missing" run should reach for first.
  function taxonList() {
    if (!window.tagsLib) return [];
    var used = new Map();
    try {
      // CAREFUL: the global `data` is NOT always ml.json. Opening the C screen does
      // `data = _cData` (collection.js), so reading `data` while C is up counts tags
      // across c.json grid configs and reports every taxon as unused. collection.js
      // stashes the real rows in _tSave.data for exactly this reason — prefer it.
      var rows = [];
      if (typeof _tSave !== 'undefined' && _tSave && Array.isArray(_tSave.data)) rows = _tSave.data;
      else if (typeof data !== 'undefined' && Array.isArray(data)) rows = data;
      rows.forEach(function (row) {
        if (!row || !Array.isArray(row.tags)) return;
        row.tags.forEach(function (id) { used.set(id, (used.get(id) || 0) + 1); });
      });
    } catch (e) {}
    return window.tagsLib.all()
      .filter(function (t) { return t.kind === 'taxon'; })
      .map(function (t) {
        return { id: t.id, label: t.label || t.id, rank: t.rank || '', common: t.common || '',
                 rows: used.get(t.id) || 0 };
      })
      .sort(function (a, b) {
        if (b.rows !== a.rows) return b.rows - a.rows;      // most-used first
        return a.label.localeCompare(b.label);
      });
  }

  // Ancestor LABELS for this tag, lowercased — the evidence used to pick between
  // same-named taxa in different kingdoms.
  function ancestorWords(id) {
    var out = [];
    try {
      var anc = window.tagsLib.ancestors(id);
      var ids = (anc instanceof Set) ? Array.from(anc) : (Array.isArray(anc) ? anc : []);
      ids.forEach(function (a) {
        var t = window.tagsLib.get(a);
        if (t && t.label) out.push(String(t.label).toLowerCase());
        if (t && t.common) out.push(String(t.common).toLowerCase());
      });
    } catch (e) {}
    return out;
  }

  // "Ctenophora" should match a description saying "ctenophores", "Cnidaria"
  // should match "cnidarians". Comparing on a stem rather than the whole word is
  // what makes that work; 5 characters is long enough that "Annelida"/"annelid"
  // hits while unrelated names do not.
  function stem(w) { return String(w || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 5); }

  // ── the lookup pipeline ─────────────────────────────────────────────────────
  //
  // BATCHED, and that is not an optimisation — it is what makes this work at all.
  // The first two attempts used the REST endpoint (/api/rest_v1/page/summary) one
  // taxon at a time. At 5 in flight a 178-taxon run returned 4 ok / 174 "no source";
  // dropped to 2 in flight with backoff it still returned 53 ok / 125 failures, of
  // which 118 were HTTP 429. Wikimedia throttles anonymous per-title REST traffic
  // hard, and a throttled reply is indistinguishable from "no such article", so the
  // failure mode is silently writing empty records over perfectly good names.
  //
  // The Action API takes FIFTY titles per request and is not throttled that way:
  //   - one call to  en.wikipedia.org/w/api.php  with 40 titles returns, for each,
  //     the intro extract, the short description, a thumbnail, the Wikidata QID
  //     (pageprops.wikibase_item), a disambiguation flag, and the normalized /
  //     redirect mapping needed to tie the answer back to the title we asked for
  //   - one call to  wikidata.org/w/api.php  with those 40 QIDs returns P225 (the
  //     taxon-name check) and P141 (IUCN status)
  // So a whole 178-taxon dictionary costs about ten requests instead of ~450.
  //
  // iNaturalist is NOT called. It has no batch endpoint, so it would reintroduce
  // one-request-per-taxon for two fields, and Wikidata P141 already carries the
  // IUCN status. Its common names were also wrong often enough to be a liability —
  // P1843 gives "Black sea bass" for Stereolepis gigas, which is the giant sea
  // bass — and tags.json already holds a hand-curated `common` per taxon. Common
  // names stay the dictionary's business; this file does not touch them.

  var WIKI_API = 'https://en.wikipedia.org/w/api.php';
  var WD_API   = 'https://www.wikidata.org/w/api.php';

  var IUCN = {
    Q211005: 'least concern',        Q719675:  'near threatened',
    Q278113: 'vulnerable',           Q11394:   'endangered',
    Q219127: 'critically endangered', Q239509: 'extinct in the wild',
    Q237350: 'extinct',              Q3245245: 'data deficient'
  };

  // One Action API call for up to 50 titles. Returns { requestedTitle: page }.
  // The normalized/redirect hops matter: we ask for "Chiroptera" and the answer
  // arrives filed under "Bat", so without walking those two maps every redirected
  // taxon would look missing.
  async function fetchPages(titles) {
    var url = WIKI_API + '?action=query&format=json&origin=*&redirects=1' +
      '&prop=extracts|pageprops|pageimages|description' +
      '&exintro=1&explaintext=1&exlimit=20&piprop=thumbnail&pithumbsize=320' +
      '&ppprop=wikibase_item|disambiguation' +
      '&titles=' + encodeURIComponent(titles.join('|'));
    var d = await j(url);
    var q = (d && d.query) || {};
    var norm = {}, redir = {}, byTitle = {};
    (q.normalized || []).forEach(function (n) { norm[n.from] = n.to; });
    (q.redirects  || []).forEach(function (r) { redir[r.from] = r.to; });
    Object.keys(q.pages || {}).forEach(function (k) {
      var pg = q.pages[k];
      if (pg && pg.title) byTitle[pg.title] = pg;
    });
    var out = {};
    titles.forEach(function (t) {
      var cur = norm[t] || t;
      cur = redir[cur] || cur;
      out[t] = byTitle[cur] || null;
    });
    return out;
  }

  // One Wikidata call for up to 50 QIDs -> { qid: { taxonName, iucn } }.
  async function fetchClaims(qids) {
    if (!qids.length) return {};
    var d = await j(WD_API + '?action=wbgetentities&ids=' + qids.join('|') +
                    '&props=claims&format=json&origin=*');
    var out = {};
    qids.forEach(function (q) {
      var c = (d.entities && d.entities[q] && d.entities[q].claims) || {};
      var tn = c.P225 && c.P225[0] && c.P225[0].mainsnak &&
               c.P225[0].mainsnak.datavalue && c.P225[0].mainsnak.datavalue.value;
      var st = c.P141 && c.P141[0] && c.P141[0].mainsnak &&
               c.P141[0].mainsnak.datavalue && c.P141[0].mainsnak.datavalue.value;
      out[q] = { taxonName: tn || '', iucn: (st && IUCN[st.id]) || '' };
    });
    return out;
  }

  // Every taxon carrying this exact name, across all kingdoms, each with its
  // English Wikipedia article. This is the disambiguation escape hatch, and it is
  // only ever reached for the handful of names that fail the batched check.
  async function p225Candidates(label) {
    var s = await j(WD_API + '?action=query&list=search&srsearch=' +
                    encodeURIComponent('haswbstatement:P225=' + label) +
                    '&srlimit=10&format=json&origin=*');
    var qids = ((s.query && s.query.search) || []).map(function (r) { return r.title; });
    if (!qids.length) return [];
    var e = await j(WD_API + '?action=wbgetentities&ids=' + qids.join('|') +
                    '&props=sitelinks|descriptions&languages=en&sitefilter=enwiki&format=json&origin=*');
    return qids.map(function (q) {
      var ent = (e.entities && e.entities[q]) || {};
      return {
        qid: q,
        page: (ent.sitelinks && ent.sitelinks.enwiki && ent.sitelinks.enwiki.title) || '',
        descr: (ent.descriptions && ent.descriptions.en && ent.descriptions.en.value) || ''
      };
    }).filter(function (r) { return r.page; });
  }

  function pickCandidate(cands, id) {
    if (cands.length === 1) return cands[0];
    var words = ancestorWords(id).map(stem).filter(Boolean);
    if (!words.length) return null;
    var scored = cands.map(function (c) {
      var hay = (c.descr + ' ' + c.page).toLowerCase();
      var n = 0;
      words.forEach(function (w) { if (w && hay.indexOf(w) >= 0) n++; });
      return { c: c, n: n };
    }).sort(function (a, b) { return b.n - a.n; });
    // A winner must actually score, and must beat the runner-up outright. A tie
    // is a real ambiguity and belongs in front of a human, not in the file.
    if (scored[0].n > 0 && (scored.length === 1 || scored[0].n > scored[1].n)) return scored[0].c;
    return null;
  }

  function recFromPage(pg) {
    return {
      note: String((pg && pg.extract) || '').trim(),
      descr: (pg && pg.description) || '',
      wiki: 'https://en.wikipedia.org/wiki/' +
            encodeURIComponent(String((pg && pg.title) || '').replace(/ /g, '_')),
      wikiTitle: (pg && pg.title) || '',
      qid: (pg && pg.pageprops && pg.pageprops.wikibase_item) || '',
      thumb: (pg && pg.thumbnail && pg.thumbnail.source) || ''
    };
  }

  function isDisambig(pg) {
    return !!(pg && pg.pageprops && pg.pageprops.disambiguation !== undefined);
  }

  // Accept a page for this tag, or say why not.
  //   'ok'       P225 equals the label
  //   'genus'    P225 is the genus half of our binomial — Wikipedia covers the
  //              species at its genus article (Enypniastes eximia -> Enypniastes)
  //   'species'  the mirror image: our GENUS is covered at the article for its one
  //              well-known species. Megaptera resolves to "Humpback whale", whose
  //              P225 is Megaptera novaeangliae; the same happens for Nymphicus ->
  //              Cockatiel, Riftia -> Riftia pachyptila, Delphinapterus -> Beluga.
  //              Rejecting these cost ~20 real genera in the first full run.
  //   ''         not this taxon. No P225 at all means it is not a taxon article,
  //              which is how "Hippocampus" gets rejected: the title resolves to
  //              the brain region, not the seahorse genus.
  function verdict(label, taxonName) {
    var low = String(label).toLowerCase(), tlow = String(taxonName || '').toLowerCase();
    if (!tlow) return '';
    if (tlow === low) return 'ok';
    if (low.indexOf(tlow + ' ') === 0) return 'genus';
    if (tlow.indexOf(low + ' ') === 0) return 'species';
    return '';
  }

  // ── the run ─────────────────────────────────────────────────────────────────

  async function enrich(tags, onProgress) {
    await load();
    cancel = false;
    var done = 0, ok = 0, amb = 0, none = 0;

    for (var i = 0; i < tags.length; i += BATCH) {
      if (cancel) break;
      var slice = tags.slice(i, i + BATCH);
      var stamp = new Date().toISOString();
      var recs = {}, retry = [];

      slice.forEach(function (t) {
        recs[t.id] = { label: t.label || t.id, rank: t.rank || '', status: 'none', fetched: stamp };
      });

      try {
        var pages = await fetchPages(slice.map(function (t) { return t.label || t.id; }));
        var qids = [];
        slice.forEach(function (t) {
          var pg = pages[t.label || t.id];
          if (pg && !isDisambig(pg) && pg.pageprops && pg.pageprops.wikibase_item) {
            qids.push(pg.pageprops.wikibase_item);
          }
        });
        var claims = await fetchClaims(qids);

        slice.forEach(function (t) {
          var label = t.label || t.id;
          var pg = pages[label];
          var rec = recs[t.id];
          if (!pg || pg.missing !== undefined || isDisambig(pg)) { retry.push(t); return; }
          var qid = (pg.pageprops && pg.pageprops.wikibase_item) || '';
          var cl = claims[qid] || {};
          var v = verdict(label, cl.taxonName);
          if (!v) { retry.push(t); return; }
          var base = recFromPage(pg);
          for (var k in base) if (base[k]) rec[k] = base[k];
          if (cl.iucn) rec.iucn = cl.iucn;
          if (v === 'genus')   rec.viaGenus   = cl.taxonName;
          if (v === 'species') rec.viaSpecies = cl.taxonName;
          rec.status = 'ok';
        });
      } catch (e) {
        // A failed BATCH must not be written out as a slice of "no source" records
        // — that is exactly the damage the old per-title code did. Hand the whole
        // slice to the fallback instead, and let whatever stays unresolved carry
        // the error so the panel can show what actually went wrong.
        slice.forEach(function (t) {
          retry.push(t);
          recs[t.id].error = String((e && e.message) || e);
        });
      }

      // Fallback, one at a time — but only for the few that failed the batch.
      for (var r = 0; r < retry.length; r++) {
        if (cancel) break;
        var t2 = retry[r];
        var rec2 = recs[t2.id];
        try {
          var cands = await p225Candidates(t2.label || t2.id);
          if (!cands.length) continue;
          var pick = pickCandidate(cands, t2.id);
          if (!pick) { rec2.status = 'ambiguous'; rec2.candidates = cands; continue; }
          var one = await fetchPages([pick.page]);
          var pg2 = one[pick.page];
          if (!pg2) continue;
          var base2 = recFromPage(pg2);
          for (var k2 in base2) if (base2[k2]) rec2[k2] = base2[k2];
          rec2.qid = pick.qid;
          var cl2 = await fetchClaims([pick.qid]);
          if (cl2[pick.qid] && cl2[pick.qid].iucn) rec2.iucn = cl2[pick.qid].iucn;
          rec2.status = 'ok';
          delete rec2.error;
        } catch (e) { rec2.error = String((e && e.message) || e); }
      }

      slice.forEach(function (t) {
        store.items[t.id] = recs[t.id];
        done++;
        if (recs[t.id].status === 'ok') ok++;
        else if (recs[t.id].status === 'ambiguous') amb++;
        else none++;
      });

      if (typeof onProgress === 'function') {
        onProgress({ done: done, total: tags.length, ok: ok, ambiguous: amb, none: none });
      }
      // Written every wave, not once at the end: a run interrupted by a closed tab
      // or a dropped connection keeps everything it already fetched.
      await persist();
      if (i + BATCH < tags.length && BATCH_REST) {
        await new Promise(function (res) { setTimeout(res, BATCH_REST); });
      }
    }
    return { done: done, ok: ok, ambiguous: amb, none: none, cancelled: cancel };
  }

  // One taxon on its own — for callers that want a single refresh rather than a
  // run. Goes through the same batched path so there is only one code path.
  async function enrichOne(tag) {
    await enrich([tag]);
    return get(tag.id);
  }

  function stop() { cancel = true; }

  // Resolve an ambiguous taxon to one of its candidates (the panel's buttons).
  async function resolveTo(id, qid) {
    await load();
    var rec = store.items[id];
    if (!rec || !rec.candidates) return null;
    var pick = rec.candidates.filter(function (c) { return c.qid === qid; })[0];
    if (!pick) return null;
    try {
      var pages = await fetchPages([pick.page]);
      var pg = pages[pick.page];
      if (!pg) throw new Error('no page');
      var next = { label: rec.label, rank: rec.rank, status: 'ok',
                   fetched: new Date().toISOString() };
      var base = recFromPage(pg);
      for (var k in base) if (base[k]) next[k] = base[k];
      next.qid = pick.qid;
      var cl = await fetchClaims([pick.qid]);
      if (cl[pick.qid] && cl[pick.qid].iucn) next.iucn = cl[pick.qid].iucn;
      store.items[id] = next;
      await persist();
      return next;
    } catch (e) { say('Could not fetch ' + pick.page, 2500); return null; }
  }


  function stats() {
    var list = taxonList(), ok = 0, amb = 0, none = 0, missing = 0, usedMissing = 0;
    list.forEach(function (t) {
      var r = get(t.id);
      if (!r) { missing++; if (t.rows > 0) usedMissing++; return; }
      if (r.status === 'ok') ok++;
      else if (r.status === 'ambiguous') amb++;
      else none++;
    });
    return { total: list.length, ok: ok, ambiguous: amb, none: none,
             missing: missing, usedMissing: usedMissing };
  }

  // ── the review panel ────────────────────────────────────────────────────────
  // This is the answer to "how do I look at what we got": one scrollable list of
  // every taxon in the dictionary, what was found for it, and where that came
  // from — with the ambiguous ones offering their candidates as buttons.

  var panel = null;
  var filter = 'all';

  function close() {
    stop();
    if (panel) { panel.remove(); panel = null; }
    document.removeEventListener('keydown', onKey, true);
  }

  function onKey(e) {
    if (!panel) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  }

  async function openPanel() {
    if (panel) { close(); return; }
    await load();
    panel = document.createElement('div');
    panel.id = 'taxonInfoPanel';
    panel.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#08080f;' +
      'color:#ddd;font-family:monospace;display:flex;flex-direction:column;';
    panel.innerHTML =
      '<div style="padding:10px 14px;border-bottom:1px solid #333;display:flex;gap:8px;' +
        'align-items:center;flex-wrap:wrap;background:#0c0c18;">' +
        '<span style="color:#8ef;font-weight:bold;font-size:13px;">Taxon info</span>' +
        '<span id="tiStats" style="color:#888;font-size:11px;"></span>' +
        '<span style="flex:1;"></span>' +
        '<button id="tiFetchUsed" style="' + BTN('#6c9', '0,80,55') + '">' +
          'Fetch missing (used on rows)</button>' +
        '<button id="tiFetchAll" style="' + BTN('#4af', '0,40,100') + '">' +
          'Fetch missing (all taxa)</button>' +
        '<button id="tiStop" style="' + BTN('#fc8', '80,50,0') + 'display:none;">Stop</button>' +
        '<button id="tiClose" style="' + BTN('#f88', '80,0,0') + '">Close (Esc)</button>' +
      '</div>' +
      '<div id="tiBar" style="height:3px;background:#182;width:0;transition:width .2s;"></div>' +
      '<div style="padding:7px 14px;border-bottom:1px solid #222;display:flex;gap:6px;' +
        'align-items:center;flex-wrap:wrap;background:#0a0a14;">' +
        FILTBTN('all', 'All') + FILTBTN('ok', 'Have info') + FILTBTN('missing', 'Missing') +
        FILTBTN('ambiguous', 'Ambiguous') + FILTBTN('none', 'No source') + FILTBTN('used', 'Used on rows') +
        '<input id="tiSearch" type="text" placeholder="filter by name…" autocomplete="off" style="' +
          'margin-left:8px;padding:4px 9px;background:#0a0a1a;border:1px solid #345;color:#fff;' +
          'border-radius:4px;font-family:monospace;font-size:11px;outline:none;min-width:180px;">' +
      '</div>' +
      '<div id="tiList" style="flex:1;overflow-y:auto;padding:4px 0;"></div>';
    document.body.appendChild(panel);

    panel.querySelector('#tiClose').addEventListener('click', close);
    panel.querySelector('#tiStop').addEventListener('click', function () {
      stop(); say('Stopping after this wave…', 1800);
    });
    panel.querySelector('#tiFetchUsed').addEventListener('click', function () { run(true); });
    panel.querySelector('#tiFetchAll').addEventListener('click', function () { run(false); });
    panel.querySelector('#tiSearch').addEventListener('input', renderList);
    Array.prototype.forEach.call(panel.querySelectorAll('.ti-filt'), function (b) {
      b.addEventListener('click', function () {
        filter = b.getAttribute('data-f');
        Array.prototype.forEach.call(panel.querySelectorAll('.ti-filt'), function (o) {
          o.style.background = (o === b) ? 'rgba(100,170,255,0.35)' : 'rgba(255,255,255,0.05)';
        });
        renderList();
      });
    });
    document.addEventListener('keydown', onKey, true);
    renderStats(); renderList();
  }

  function BTN(fg, rgb) {
    return 'padding:5px 11px;border:1px solid ' + fg + ';background:rgba(' + rgb + ',0.4);' +
           'color:' + fg + ';border-radius:5px;cursor:pointer;font-family:monospace;font-size:11px;';
  }
  function FILTBTN(f, label) {
    return '<button class="ti-filt" data-f="' + f + '" style="padding:3px 9px;border:1px solid #345;' +
      'background:rgba(' + (f === 'all' ? '100,170,255,0.35' : '255,255,255,0.05') + ');color:#9bd;' +
      'border-radius:10px;cursor:pointer;font-family:monospace;font-size:11px;">' + label + '</button>';
  }

  function renderStats() {
    if (!panel) return;
    var s = stats();
    panel.querySelector('#tiStats').textContent =
      s.total + ' taxa  ·  ' + s.ok + ' with info  ·  ' + s.missing + ' missing (' +
      s.usedMissing + ' of them used on rows)  ·  ' + s.ambiguous + ' ambiguous  ·  ' +
      s.none + ' no source';
  }

  async function run(usedOnly) {
    var list = taxonList().filter(function (t) {
      if (usedOnly && t.rows === 0) return false;
      var r = get(t.id);
      return !r || r.status === 'none';     // ambiguous rows wait for a human
    });
    if (!list.length) { say('Nothing missing' + (usedOnly ? ' among used taxa' : ''), 2200); return; }
    var stopBtn = panel.querySelector('#tiStop');
    var bar = panel.querySelector('#tiBar');
    stopBtn.style.display = '';
    var res = await enrich(list, function (p) {
      if (!panel) return;
      bar.style.width = Math.round(p.done / p.total * 100) + '%';
      panel.querySelector('#tiStats').textContent =
        'fetching…  ' + p.done + ' / ' + p.total + '   ·   ' + p.ok + ' ok  ·  ' +
        p.ambiguous + ' ambiguous  ·  ' + p.none + ' no source';
      renderList();
    });
    if (!panel) return;
    stopBtn.style.display = 'none';
    bar.style.width = '0';
    say((res.cancelled ? 'Stopped — ' : 'Done — ') + res.ok + ' filled, ' +
        res.ambiguous + ' need a pick, ' + res.none + ' no source', 3500);
    renderStats(); renderList();
  }

  function renderList() {
    if (!panel) return;
    var q = (panel.querySelector('#tiSearch').value || '').toLowerCase().trim();
    var rows = taxonList().filter(function (t) {
      var r = get(t.id);
      var st = r ? r.status : 'missing';
      if (filter === 'ok' && st !== 'ok') return false;
      if (filter === 'missing' && r) return false;
      if (filter === 'ambiguous' && st !== 'ambiguous') return false;
      if (filter === 'none' && st !== 'none') return false;
      if (filter === 'used' && t.rows === 0) return false;
      if (q) {
        var hay = (t.label + ' ' + t.common + ' ' + t.id + ' ' +
                   ((r && r.note) || '') + ' ' + ((r && r.descr) || '')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });

    var html = rows.map(function (t) {
      var r = get(t.id);
      var st = r ? r.status : 'missing';
      var badge = st === 'ok' ? '<span style="color:#5fa;">&#10003;</span>'
                : st === 'ambiguous' ? '<span style="color:#fc8;">?</span>'
                : st === 'none' ? '<span style="color:#f77;">&#8212;</span>'
                : '<span style="color:#555;">&#183;</span>';
      var head =
        '<div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;">' +
          '<span style="width:14px;display:inline-block;">' + badge + '</span>' +
          '<b style="color:#cfe;">' + esc(t.label) + '</b>' +
          '<span style="color:#678;font-size:10px;">' + esc(t.rank || '-') + '</span>' +
          (t.rows ? '<span style="color:#5a8;font-size:10px;">' + t.rows + ' rows</span>'
                  : '<span style="color:#444;font-size:10px;">unused</span>') +
          (r && r.iucn ? '<span style="color:#fa8;font-size:10px;border:1px solid #753;' +
             'border-radius:8px;padding:0 6px;">' + esc(r.iucn) + '</span>' : '') +
          (t.common ? '<span style="color:#8ad;font-size:10px;">' + esc(t.common) + '</span>' : '') +
          (r && r.wiki ? '<a href="' + esc(r.wiki) + '" target="_blank" rel="noopener" ' +
             'style="color:#69f;font-size:10px;margin-left:auto;">' +
             esc(r.wikiTitle || 'wikipedia') + ' &#8599;</a>' : '') +
        '</div>';
      var body = '';
      if (r && r.viaGenus) {
        body += '<div style="color:#c9a;font-size:10px;margin:2px 0 0 22px;">' +
          'note describes the genus ' + esc(r.viaGenus) + ', not this species</div>';
      }
      if (r && r.viaSpecies) {
        body += '<div style="color:#c9a;font-size:10px;margin:2px 0 0 22px;">' +
          'note describes ' + esc(r.viaSpecies) + ', one species in this genus</div>';
      }
      if (r && r.descr) {
        body += '<div style="color:#9ab;font-size:11px;margin:2px 0 0 22px;">' + esc(r.descr) + '</div>';
      }
      if (r && r.note) {
        body += '<div style="color:#bbb;font-size:11px;line-height:1.45;margin:3px 0 0 22px;">' +
                esc(r.note) + '</div>';
      }
      if (r && st === 'ambiguous' && r.candidates) {
        body += '<div style="margin:4px 0 0 22px;font-size:11px;color:#fc8;">' +
          'Several taxa share this name &#8212; pick one: ' +
          r.candidates.map(function (c) {
            return '<button class="ti-pick" data-id="' + esc(t.id) + '" data-qid="' + esc(c.qid) + '" ' +
              'style="' + BTN('#fc8', '80,50,0') + 'margin:2px 4px 2px 0;">' +
              esc(c.page) + (c.descr ? ' &#183; ' + esc(c.descr) : '') + '</button>';
          }).join('') + '</div>';
      }
      if (r && st === 'none') {
        body += '<div style="color:#866;font-size:10px;margin:2px 0 0 22px;">' +
          'no verified Wikipedia taxon page' + (r.error ? ' (' + esc(r.error) + ')' : '') + '</div>';
      }
      return '<div style="padding:7px 14px;border-bottom:1px solid #16161f;">' + head + body + '</div>';
    }).join('');

    var listEl = panel.querySelector('#tiList');
    listEl.innerHTML = html || '<div style="padding:24px;color:#666;text-align:center;">nothing matches</div>';
    Array.prototype.forEach.call(listEl.querySelectorAll('.ti-pick'), function (b) {
      b.addEventListener('click', async function () {
        b.disabled = true; b.textContent = 'fetching…';
        await resolveTo(b.getAttribute('data-id'), b.getAttribute('data-qid'));
        renderStats(); renderList();
      });
    });
  }

  window.taxonInfo = {
    load: load, get: get, has: has, stats: stats,
    enrich: enrich, enrichOne: enrichOne, stop: stop, resolveTo: resolveTo,
    taxonList: taxonList, openPanel: openPanel, close: close, persist: persist
  };
})();
