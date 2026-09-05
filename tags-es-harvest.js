#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// tags-es-harvest.js — build tags.es.json (Spanish tag text)          (dev0930)
// ══════════════════════════════════════════════════════════════════════════════
//
//   node tags-es-harvest.js              harvest common names for taxon tags
//   node tags-es-harvest.js --force      re-harvest everything (network)
//   node tags-es-harvest.js --reseed     recompute the seeds from the candidates
//                                        already in the file — NO network at all,
//                                        and hand-edited entries are left alone
//
// THE PROBLEM THIS EXISTS FOR. A Spanish common name is NOT a translation of the
// English one. "Sarcastic fringehead" is not a phrase Spanish renders; the animal
// either has a Spanish name in use or it does not. So the names have to be
// HARVESTED from sources that record actual usage, never translated — and where
// no source has one, the field stays empty and the card falls back to the
// scientific name, which is what a Spanish speaker would expect anyway.
//
// WHAT THE SOURCES ACTUALLY GIVE (measured over this dictionary, dev0930):
//
//   GBIF  /species/match -> /species/{key}/vernacularNames
//         The best source. ~60% of SPECIES, near 0% of genus/class/order — the
//         Spanish-speaking world names the fish it eats and the whales it
//         watches, not the Echinoidea. Two requests per taxon, so this is the
//         slow pass. NOTE: /species/search?q= looks like a one-request shortcut
//         and is NOT — its first result is unstable and returned Spanish names
//         for 0 of 40 taxa that the match route answered. Do not "optimise"
//         back to it.
//
//   Wikidata P1843 (taxon common name), language-filtered to es
//         ~11%, one request per 50 taxa, so effectively free. But its language
//         tags are dirty: "Peixe Lua" is filed under es for Mola mola and is
//         Portuguese. Treated as a weaker witness than GBIF for that reason.
//
//   WoRMS AphiaVernacularsByAphiaID
//         Authoritative for marine taxa and agrees with GBIF where both have a
//         name, but is thinner for Spanish and 500s intermittently. NOT called
//         here: it costs a third and fourth request per taxon to add very
//         little that GBIF did not already have. The hook is left in the notes
//         because tags.js already has wormsVernaculars() if this ever needs it.
//
// WHY THE OUTPUT IS CANDIDATES, NOT ANSWERS. Real harvested data for one taxon:
//     Orcinus orca -> "Orca común / Orca gigante | orca / ballena asesina /
//                      ballena pinta"
// Five regional variants, inconsistent casing, and a stray delimiter inside one
// field. Picking between "ballena asesina" (widespread) and "orca" (what Spain
// actually says) is an editorial call about audience, not a data problem, and
// tags.json's `common` has always been hand-curated for exactly this reason.
//
// So: `common` is written with a MACHINE SEED — the single best candidate under
// the rules in pickBest() — and `candidates` records every name found and where
// it came from. The seed is a starting point for review in the D screen, not a
// finished answer. An entry the author edits by hand is never overwritten,
// because a re-run only fills tags whose id is absent from `common`.
//
// `labels` (the non-taxon tags — Predation, Camouflage, Tide pool, …) is NOT
// harvested at all. Those are ordinary English phrases with ordinary Spanish
// equivalents and no database has them; they are translated by hand into this
// file and this script leaves whatever is already there untouched.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');

const TAGS = path.join(__dirname, 'tags.json');
const TI   = path.join(__dirname, 'taxoninfo.json');
const OUT  = path.join(__dirname, 'tags.es.json');

const UA = { 'User-Agent': 'SLAM-tags-es/1.0 (https://sealifeandmore.com; pwassm@yahoo.com)' };
const REST_MS = 140;
const RETRIES = 2;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function j(url) {
  let wait = 500, last = null;
  for (let a = 0; a <= RETRIES; a++) {
    if (a) { await sleep(wait); wait *= 2; }
    let r;
    try { r = await fetch(url, { headers: UA }); }
    catch (e) { last = e; continue; }
    if (r.ok) return r.json();
    last = new Error('HTTP ' + r.status);
    if (r.status !== 429 && r.status < 500) throw last;
  }
  throw last || new Error('request failed');
}
const jSafe = async u => { try { return await j(u); } catch (e) { return null; } };

// ── cleaning ────────────────────────────────────────────────────────────────
// GBIF fields carry embedded delimiters ("Orca gigante | orca"), stray
// parentheticals and authorship crumbs. Split on them rather than storing a
// compound string that would render as one absurd name on a card.
function splitNames(raw) {
  return String(raw || '')
    .split(/\s*[|;,/]\s*|\s+o\s+/i)
    .map(s => s.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(s => s.length > 1 && s.length < 48 && /[a-záéíóúñü]/i.test(s));
}

// The project rule is: lowercase unless it is a proper noun. Sources capitalise
// almost at random ("Ballena Esperma", "burro payaso", "Lubina gigante"), so
// lowercasing is right far more often than not — but blindly lowercasing would
// wreck "vieja de California" and "ballena de Groenlandia".
//
// A token is kept capitalised on either of two pieces of EVIDENCE, never on a
// built-in list of place names — a hand-maintained gazetteer here would be the
// "algorithmic common name" this project has already decided against:
//
//   1. the same token is capitalised in the tag's ENGLISH common name, which is
//      hand-curated and therefore already knows "California" is a proper noun
//   2. every source that used the token NOT as the first word capitalised it.
//      First position is excluded because sentence-casing capitalises it for
//      reasons that have nothing to do with proper nouns — that is what made
//      "Ballena de Groenlandia" and "ballena de Groenlandia" agree on the one
//      token that matters while disagreeing on the one that does not.
//
// Rule 2 needs to see all the candidates, so it is computed once per taxon and
// passed in; a token no source ever capitalised mid-phrase is lowercased.
function properFromSources(all) {
  // A source string that Title-Cases EVERY word carries no information about
  // proper nouns — "Vieja De California" capitalises "De" as readily as
  // "California". Counting it as evidence is what turned "vieja de California"
  // into "vieja De California" and "ballena jorobada" into "ballena Jorobada".
  // So only strings that leave at least one mid-phrase word lowercase are
  // allowed to vote: those are the ones whose capitals were a choice.
  const signal = all.filter(n => {
    const mid = n.split(/\s+/).slice(1);
    return mid.length && mid.some(w => /^[a-záéíóúñü]/.test(w));
  });
  const mid = new Map();   // lowercased token -> { seen, capped }
  signal.forEach(n => {
    n.split(/\s+/).forEach((w, i) => {
      if (i === 0) return;                     // first word tells us nothing
      if (!/^[a-záéíóúñü]/i.test(w)) return;
      const lw = w.toLowerCase();
      if (!mid.has(lw)) mid.set(lw, { seen: 0, capped: 0 });
      const e = mid.get(lw);
      e.seen++;
      if (/^[A-ZÁÉÍÓÚÑÜ]/.test(w)) e.capped++;
    });
  });
  const out = new Set();
  for (const [w, e] of mid) if (e.seen && e.capped === e.seen) out.add(w);
  return out;
}

function normCase(name, enCommon, fromSources) {
  const proper = new Set(
    String(enCommon || '').split(/\s+/)
      .filter(w => /^[A-Z][a-z]{2,}$/.test(w))
      .map(w => w.toLowerCase())
  );
  (fromSources || []).forEach(w => proper.add(w));
  return name.split(/\s+/).map(w => {
    const lw = w.toLowerCase();
    if (proper.has(lw)) return w.charAt(0).toUpperCase() + w.slice(1);
    return lw;
  }).join(' ');
}

// The seed. Prefer a name two independent sources agree on; otherwise the most
// frequent GBIF name; otherwise a lone P1843 name. Anything else stays empty and
// waits for a human.
function pickBest(cands, enCommon) {
  const all = [...(cands.gbif || []), ...(cands.p1843 || [])];
  const fromSources = properFromSources(all);
  const tally = new Map();   // normalised -> { n, srcs:Set }
  const add = (name, src) => {
    const k = normCase(name, enCommon, fromSources);
    if (!k) return;
    if (!tally.has(k)) tally.set(k, { n: 0, srcs: new Set() });
    const e = tally.get(k); e.n++; e.srcs.add(src);
  };
  (cands.gbif || []).forEach(n => add(n, 'gbif'));
  (cands.p1843 || []).forEach(n => add(n, 'p1843'));
  if (!tally.size) return null;
  const rows = [...tally.entries()].map(([name, e]) => ({ name, n: e.n, srcs: [...e.srcs] }));
  // agreement across sources first, then frequency, then shortest (the shortest
  // is reliably the plain name — "orca" over "orca común de dientes anchos")
  rows.sort((a, b) =>
    (b.srcs.length - a.srcs.length) || (b.n - a.n) || (a.name.length - b.name.length));
  return rows[0];
}

(async function main() {
  const force  = process.argv.includes('--force');
  const reseed = process.argv.includes('--reseed');

  const tags = JSON.parse(fs.readFileSync(TAGS, 'utf8')).filter(t => t && !t._salMeta);
  const ti   = fs.existsSync(TI) ? (JSON.parse(fs.readFileSync(TI, 'utf8')).items || {}) : {};

  let out = {
    _salMeta: true, _lang: 'es', _updated: '',
    _notes: 'labels = hand-translated non-taxon tag names. common = Spanish ' +
            'vernacular per taxon: MACHINE SEED from GBIF + Wikidata P1843, ' +
            'pending review — edit freely, a re-run never overwrites an ' +
            'existing entry. candidates = everything found, with sources, for ' +
            'that review. Built by tags-es-harvest.js.',
    // _seeded lists the ids whose `common` was written by THIS script and never
    // touched since. It is what makes --reseed safe: a re-seed may overwrite an
    // id in this list, and must never overwrite one that is not (that entry was
    // edited by hand, and a hand edit is the whole point of the review pass).
    // Remove an id from here — or just edit its value and drop the id — to pin
    // it against every future run.
    labels: {}, common: {}, _seeded: [], candidates: {}
  };
  if (fs.existsSync(OUT)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      if (prev && typeof prev === 'object') {
        out.labels     = prev.labels     || {};
        out.common     = prev.common     || {};
        // A file written before _seeded existed has no hand edits in it by
        // definition — every entry came out of this seeder — so backfill the
        // marker rather than treating the whole file as hand-curated and
        // freezing it against every future improvement to pickBest().
        out._seeded = Array.isArray(prev._seeded)
          ? prev._seeded
          : Object.keys(out.common).filter(k => out.common[k]);
        out.candidates = (force && !reseed) ? {} : (prev.candidates || {});
      }
    } catch (e) { console.warn('existing tags.es.json unreadable, starting fresh'); }
  }
  const seededSet = new Set(out._seeded);

  // ── --reseed: recompute from what is already on disk, no network ───────────
  if (reseed) {
    let changed = 0, kept = 0;
    for (const [id, c] of Object.entries(out.candidates)) {
      if (out.common[id] && !seededSet.has(id)) { kept++; continue; }   // hand-edited
      const best = pickBest({ gbif: c.gbif || [], p1843: c.p1843 || [] }, c.en);
      const val = best ? best.name : '';
      if (val && val !== out.common[id]) changed++;
      if (val) { out.common[id] = val; seededSet.add(id); }
    }
    out._seeded = [...seededSet].sort();
    out._updated = new Date().toISOString();
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    console.log('reseeded from stored candidates — no network');
    console.log('  changed        : ' + changed);
    console.log('  hand-edits kept: ' + kept);
    console.log('  common total   : ' + Object.values(out.common).filter(Boolean).length);
    return;
  }

  const taxa = tags.filter(t => t.kind === 'taxon');
  const todo = taxa.filter(t => force || !(t.id in out.candidates));
  console.log('taxon tags        : ' + taxa.length);
  console.log('non-taxon tags    : ' + (tags.length - taxa.length) + '  (labels, hand-translated)');
  console.log('to harvest        : ' + todo.length + '\n');

  // ── pass 1: Wikidata P1843, batched, cheap ─────────────────────────────────
  const p1843 = new Map();
  const withQid = todo.map(t => ({ t, qid: (ti[t.id] || {}).qid })).filter(x => x.qid);
  for (let i = 0; i < withQid.length; i += 50) {
    const batch = withQid.slice(i, i + 50);
    const d = await jSafe('https://www.wikidata.org/w/api.php?action=wbgetentities&ids=' +
      batch.map(b => b.qid).join('|') + '&props=claims&format=json&origin=*');
    if (d) for (const b of batch) {
      const claims = (d.entities && d.entities[b.qid] && d.entities[b.qid].claims) || {};
      const names = (claims.P1843 || [])
        .map(c => c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value)
        .filter(v => v && v.language === 'es')
        .flatMap(v => splitNames(v.text));
      if (names.length) p1843.set(b.t.id, [...new Set(names)]);
    }
    process.stdout.write('  wikidata ' + Math.min(i + 50, withQid.length) + '/' + withQid.length + '\r');
    await sleep(200);
  }
  console.log('\n  P1843 es names for ' + p1843.size + ' taxa\n');

  // ── pass 2: GBIF, two requests per taxon ───────────────────────────────────
  let done = 0, gbifHits = 0;
  for (const t of todo) {
    const m = await jSafe('https://api.gbif.org/v1/species/match?name=' + encodeURIComponent(t.label));
    let gbif = [];
    if (m && m.usageKey) {
      const v = await jSafe('https://api.gbif.org/v1/species/' + m.usageKey + '/vernacularNames?limit=200');
      if (v && Array.isArray(v.results)) {
        gbif = [...new Set(v.results
          .filter(r => /^(spa|es)$/i.test(r.language || ''))
          .flatMap(r => splitNames(r.vernacularName)))];
      }
    }
    if (gbif.length) gbifHits++;

    const cands = { gbif: gbif, p1843: p1843.get(t.id) || [] };
    if (cands.gbif.length || cands.p1843.length) {
      out.candidates[t.id] = { label: t.label, en: t.common || '', ...cands };
      // Seed `common` only where it is not already set — a hand edit always wins.
      if (!out.common[t.id]) {
        const best = pickBest(cands, t.common);
        if (best) { out.common[t.id] = best.name; seededSet.add(t.id); }
      }
    } else {
      out.candidates[t.id] = { label: t.label, en: t.common || '', gbif: [], p1843: [] };
    }

    if (++done % 20 === 0 || done === todo.length) {
      process.stdout.write('  gbif ' + done + '/' + todo.length + '  (' + gbifHits + ' with es names)\r');
    }
    await sleep(REST_MS);
  }

  // Non-taxon labels: create empty slots so the file itself is the worklist.
  let blanks = 0;
  tags.filter(t => t.kind !== 'taxon').forEach(t => {
    if (!(t.id in out.labels)) { out.labels[t.id] = ''; blanks++; }
  });

  out._seeded  = [...seededSet].sort();
  out._updated = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));

  const seeded = Object.values(out.common).filter(Boolean).length;
  console.log('\n\nwritten           : tags.es.json');
  console.log('common seeded     : ' + seeded + ' / ' + taxa.length +
              '  (' + (100 * seeded / taxa.length).toFixed(0) + '%)');
  console.log('label slots blank : ' + blanks + '  (hand-translate these)');
})().catch(e => { console.error('FAILED: ' + (e && e.message)); process.exit(1); });
