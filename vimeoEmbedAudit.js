#!/usr/bin/env node
// vimeoEmbedAudit.js — REPORT-ONLY audit of every Vimeo row in ml.json.
//   node vimeoEmbedAudit.js                 # audit ml.json, print the census
//   node vimeoEmbedAudit.js --json out.json # also write the full per-video result
//   node vimeoEmbedAudit.js some.json       # audit a different file
//
// WRITES NOTHING. Not ml.json, not a column, not a backfill — by design. A
// script-written ml.json column is wiped by the app's next save (that trap is
// well documented), so this prints what it found and you act in the app.
//
// WHAT IT DETECTS
// Two ways a Vimeo row goes dead, and they need different handling:
//   • EMBED DISABLED — the video still exists on vimeo.com, but the owner turned
//     off embedding. oEmbed answers 200 with `domain_status_code: 403` and an
//     empty title. The app can never play it: G cells, V, E and the row-preview
//     pane all mount the same Vimeo SDK iframe, so there is no path that works.
//     The player shows "Because of its privacy settings, this video cannot be
//     played here." The `g` source-page hotkey still reaches it on vimeo.com.
//   • GONE — deleted or made private. oEmbed answers 404. Nothing works.
//
// WHAT IT IS NOT
// A Cloudflare "are you human" page on vimeo.com is NOT this. That is the IP
// being challenged (usually the VPN) and it comes and goes; an embed block is a
// property of the video and is stable. Re-run from the home IP before believing
// a sudden crop of failures.
//
// DOMAIN WHITELISTING — CHECKED, AND IT DOES NOT APPLY
// Vimeo judges `domain_status_code` against the REQUESTING domain, so in
// principle a video could refuse this script yet embed fine on the live site.
// Measured 2026-08-30 over 102 distinct ids, three ways — no referer, a
// sealifeandmore.com referer, and a real fetch running at
// `origin: https://sealifeandmore.com` in the browser — the verdict changed on
// ZERO of them. These blocks are global, so a plain CLI run is trustworthy.
// If that ever stops holding, the same fetch pasted into the console on
// sealifeandmore.com is the authoritative answer.

'use strict';
const fs = require('fs');

const args = process.argv.slice(2);
let jsonOut = null;
const ji = args.indexOf('--json');
if (ji !== -1) { jsonOut = args[ji + 1] || 'vimeoEmbedAudit.out.json'; args.splice(ji, 2); }
const FILE = args[0] || 'ml.json';

const rows = JSON.parse(fs.readFileSync(FILE, 'utf8')).filter(r => r && !r._salMeta);
const vim = rows.filter(r => /vimeo\.com/i.test(String(r.link || '')));
if (!vim.length) { console.log('No Vimeo rows in ' + FILE); process.exit(0); }

// One probe per distinct video, not per row — the same URL can appear on
// several rows (a `_d`/`_1` duplicate, the same clip cut two ways).
// Unlisted links are `vimeo.com/ID/HASH`. oEmbed answers differently for the
// two spellings of those (the /HASH form 403s, the ?h= form 404s), so keep the
// link VERBATIM as the probe url — normalising it here would invent a result.
const byKey = new Map();
vim.forEach(r => {
  const link = String(r.link).trim();
  const m = link.match(/vimeo\.com\/(?:video\/)?(\d+)(?:\/([A-Za-z0-9]+))?/i);
  if (!m) { console.log('UNPARSED vimeo link, UID ' + r.UID + ': ' + link); return; }
  const key = m[1] + (m[2] ? '/' + m[2] : '');
  if (!byKey.has(key)) byKey.set(key, { id: m[1], hash: m[2] || null, link, uids: [], ltypes: new Set() });
  const e = byKey.get(key);
  e.uids.push(String(r.UID));
  e.ltypes.add(r.ltype === undefined || r.ltype === null || r.ltype === '' ? '-' : String(r.ltype));
});

const probe = async url => {
  const api = 'https://vimeo.com/api/oembed.json?url=' + encodeURIComponent(url);
  try {
    const res = await fetch(api, { headers: { Referer: 'https://sealifeandmore.com/' } });
    if (res.status === 404) return { verdict: 'GONE', detail: 'oembed 404 — deleted or private' };
    if (!res.ok) return { verdict: 'ERROR', detail: 'oembed http ' + res.status };
    const j = await res.json();
    if (j.domain_status_code) {
      return { verdict: 'BLOCKED', detail: 'domain_status_code ' + j.domain_status_code };
    }
    return { verdict: 'ok', detail: '', title: String(j.title || '') };
  } catch (e) {
    return { verdict: 'ERROR', detail: 'network: ' + String(e.message).slice(0, 60) };
  }
};

(async () => {
  const list = [...byKey.values()];
  console.log('Auditing ' + vim.length + ' Vimeo row(s), ' + list.length + ' distinct video(s), from ' + FILE + '\n');
  const CONC = 6;
  let next = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (next < list.length) {
      const e = list[next++];
      // Probe the link exactly as ml.json stores it; for an unlisted video also
      // try the ?h= spelling, because only one of the two ever answers.
      e.res = await probe(e.link);
      if (e.hash && e.res.verdict !== 'ok') {
        const alt = await probe('https://vimeo.com/' + e.id + '?h=' + e.hash);
        if (alt.verdict === 'ok') e.res = alt;
        else e.res.detail += ' (?h= form: ' + alt.detail + ')';
      }
      process.stdout.write('.');
    }
  }));
  console.log('\n');

  const of = v => list.filter(e => e.res.verdict === v);
  const blocked = of('BLOCKED'), gone = of('GONE'), errs = of('ERROR');
  const show = (title, arr) => {
    if (!arr.length) return;
    console.log('\n' + title);
    arr.forEach(e => console.log('  UID ' + e.uids.join(',').padEnd(14)
      + 'ltype=' + [...e.ltypes].join(',').padEnd(8) + e.link + '   [' + e.res.detail + ']'));
  };

  console.log('=== census ===');
  console.log('  playable       : ' + of('ok').length);
  console.log('  embed disabled : ' + blocked.length);
  console.log('  gone           : ' + gone.length);
  console.log('  probe errors   : ' + errs.length);
  show('EMBED DISABLED — exists on vimeo.com, cannot be embedded anywhere in the app.', blocked);
  show('GONE — deleted or private. Dead rows.', gone);
  show('ERRORS — re-run these (a Cloudflare challenge or the VPN will land here).', errs);
  if (!blocked.length && !gone.length && !errs.length) console.log('\nEvery Vimeo row is playable.');

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(list.map(e => ({
      id: e.id, hash: e.hash, link: e.link, uids: e.uids, ltypes: [...e.ltypes],
      verdict: e.res.verdict, detail: e.res.detail, title: e.res.title || ''
    })), null, 1));
    console.log('\nwrote ' + jsonOut);
  }
})();
