#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// taxoninfo-es.js — build taxoninfo.es.json from SPANISH Wikipedia   (dev0930)
// ══════════════════════════════════════════════════════════════════════════════
//
//   node taxoninfo-es.js            build/refresh taxoninfo.es.json
//   node taxoninfo-es.js --force    refetch every taxon, not just the missing
//
// WHY THIS IS NOT A TRANSLATION. taxoninfo.json's notes are Wikipedia intro
// extracts. Spanish Wikipedia has its own article for most of these taxa, written
// by Spanish speakers — so the Spanish card back should be THAT article's intro,
// not a machine rendering of the English one. Same provenance, same licence, no
// translation step, and the result reads natively.
//
// WHY IT DOES NOT RE-RUN THE DISAMBIGUATION. The expensive and error-prone half
// of taxoninfo.js is deciding WHICH article is about our taxon — the P225 check,
// the Mertensia-the-comb-jelly-not-the-borage problem, the ambiguous cases a
// human resolved by hand in the panel. All of that work is already recorded, as
// a Wikidata QID per taxon, and a QID is language-neutral: the eswiki sitelink
// hanging off Q1338609 IS the Spanish article about the same organism, with no
// re-verification needed. So this script never searches and never guesses. It
// reads the QIDs that were already verified and follows their sitelinks.
//
// A taxon with no eswiki sitelink is simply absent from the output. The card
// back falls back to the English note (see the _pick() in taxoninfo.js) rather
// than showing nothing — an English note is far better than a blank card, and
// at the last measurement 348 of 468 taxa (74%) had a Spanish article, so about
// a quarter of backs stay English until es.wikipedia grows.
//
// SHAPE. Same as taxoninfo.json so the reader can treat them interchangeably:
//   { _salMeta, _taxonInfoVersion, _lang:'es', _updated, items: { id: rec } }
// The record carries note/descr/wiki/wikiTitle only. iucn, thumb, qid, rank and
// status are language-neutral and stay in the English file; nothing is
// duplicated that would then need keeping in sync.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'taxoninfo.json');
const OUT = path.join(__dirname, 'taxoninfo.es.json');

// A descriptive UA with a contact is what Wikimedia's policy asks of scripted
// callers; anonymous scripted traffic with a default UA is what gets 403'd.
const UA = { 'User-Agent': 'SLAM-taxoninfo-es/1.0 (https://sealifeandmore.com; pwassm@yahoo.com)' };

// TWENTY, for the reason taxoninfo.js documents at length: the TextExtracts
// module silently caps extracts at 20 pages per request no matter what exlimit
// says, and the pages past the cap come back complete but with NO extract. Ask
// for more than 20 and the overflow is written as an empty note over a perfectly
// good article — the worst outcome, because it looks like success.
const BATCH_EXTRACT = 20;
const BATCH_WD      = 50;   // wbgetentities genuinely takes 50
const REST_MS       = 250;
const RETRIES       = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function j(url) {
  let wait = 600, last = null;
  for (let a = 0; a <= RETRIES; a++) {
    if (a) { await sleep(wait); wait *= 2; }
    let r;
    try { r = await fetch(url, { headers: UA }); }
    catch (e) { last = e; continue; }
    if (r.ok) return r.json();
    last = new Error('HTTP ' + r.status);
    // 429 and 5xx are congestion — retry. Anything else is a real refusal and
    // retrying it just burns the rate budget.
    if (r.status !== 429 && r.status < 500) throw last;
  }
  throw last || new Error('request failed');
}

(async function main() {
  const force = process.argv.includes('--force');

  if (!fs.existsSync(SRC)) { console.error('missing ' + SRC); process.exit(1); }
  const en = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const items = en.items || {};

  let out = { _salMeta: true, _taxonInfoVersion: 1, _lang: 'es', _updated: '', items: {} };
  if (!force && fs.existsSync(OUT)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      if (prev && prev.items) out = prev;
    } catch (e) { console.warn('existing ' + path.basename(OUT) + ' unreadable, starting fresh'); }
  }

  // Only verified records with a QID are eligible. status 'none' means the
  // English pass found no article at all, so there is nothing to follow.
  const todo = Object.entries(items)
    .filter(([id, r]) => r && r.qid && r.status === 'ok')
    .filter(([id]) => force || !out.items[id])
    .map(([id, r]) => ({ id, label: r.label || id, qid: r.qid }));

  console.log('eligible taxa      : ' + Object.values(items).filter(r => r && r.qid && r.status === 'ok').length);
  console.log('already in ' + path.basename(OUT) + ': ' + Object.keys(out.items).length);
  console.log('to fetch           : ' + todo.length);
  if (!todo.length) { console.log('nothing to do'); return; }

  // ── pass 1: QID -> Spanish article title ───────────────────────────────────
  const esTitle = new Map();
  for (let i = 0; i < todo.length; i += BATCH_WD) {
    const batch = todo.slice(i, i + BATCH_WD);
    const d = await j('https://www.wikidata.org/w/api.php?action=wbgetentities&ids=' +
      batch.map(b => b.qid).join('|') +
      '&props=sitelinks&sitefilter=eswiki&format=json&origin=*');
    for (const b of batch) {
      const e = (d.entities && d.entities[b.qid]) || {};
      const title = e.sitelinks && e.sitelinks.eswiki && e.sitelinks.eswiki.title;
      if (title) esTitle.set(b.id, title);
    }
    process.stdout.write('  sitelinks ' + Math.min(i + BATCH_WD, todo.length) + '/' + todo.length + '\r');
    await sleep(REST_MS);
  }
  console.log('\nwith a Spanish article: ' + esTitle.size + ' of ' + todo.length +
              ' (' + (100 * esTitle.size / todo.length).toFixed(0) + '%)');

  // ── pass 2: Spanish titles -> intro extracts ───────────────────────────────
  const byTitle = new Map();                 // title -> [ids]
  for (const [id, title] of esTitle) {
    if (!byTitle.has(title)) byTitle.set(title, []);
    byTitle.get(title).push(id);
  }
  const titles = [...byTitle.keys()];
  let got = 0, empty = 0;

  for (let i = 0; i < titles.length; i += BATCH_EXTRACT) {
    const batch = titles.slice(i, i + BATCH_EXTRACT);
    const d = await j('https://es.wikipedia.org/w/api.php?action=query&format=json&origin=*' +
      '&redirects=1&prop=extracts|description&exintro=1&explaintext=1&exlimit=20' +
      '&titles=' + encodeURIComponent(batch.join('|')));
    const q = (d && d.query) || {};
    const norm = {}, redir = {}, pages = {};
    (q.normalized || []).forEach(n => { norm[n.from] = n.to; });
    (q.redirects  || []).forEach(r => { redir[r.from] = r.to; });
    Object.values(q.pages || {}).forEach(pg => { if (pg && pg.title) pages[pg.title] = pg; });

    for (const asked of batch) {
      let cur = norm[asked] || asked;
      cur = redir[cur] || cur;
      const pg = pages[cur];
      const note = String((pg && pg.extract) || '').trim();
      if (!note) { empty++; continue; }       // never write an empty note over a good name
      for (const id of byTitle.get(asked)) {
        out.items[id] = {
          note:      note,
          descr:     (pg && pg.description) || '',
          wiki:      'https://es.wikipedia.org/wiki/' + encodeURIComponent(String(pg.title).replace(/ /g, '_')),
          wikiTitle: pg.title,
          fetched:   new Date().toISOString()
        };
        got++;
      }
    }
    process.stdout.write('  extracts ' + Math.min(i + BATCH_EXTRACT, titles.length) + '/' + titles.length + '\r');
    await sleep(REST_MS);
  }

  out._updated = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));

  const chars = Object.values(out.items).reduce((a, r) => a + (r.note || '').length, 0);
  console.log('\n');
  console.log('written            : ' + path.basename(OUT));
  console.log('records this run   : ' + got + (empty ? ('  (' + empty + ' titles returned no extract)') : ''));
  console.log('records total      : ' + Object.keys(out.items).length);
  console.log('Spanish prose      : ' + chars.toLocaleString() + ' chars');
})().catch(e => { console.error('FAILED: ' + (e && e.message)); process.exit(1); });
