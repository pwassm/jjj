#!/usr/bin/env node
// cleanO.js — purge copied-web-app DOM junk from o.json's pasted text, IN PLACE.
//   node cleanO.js            # DRY-RUN: report only, writes nothing (default)
//   node cleanO.js --apply    # writes o.json  (o.json.bak saved first)
//   node cleanO.js --apply some.json
//
// Two safety-first tiers (see analyzeOrgJunk.js for how the thresholds were chosen):
//   TIER 1 — truncate the trailing widget-DOM dump. Cut at the first HIGH-CONFIDENCE
//     signature (OpenWeb/spotim <ow-…> / spcv_ / data-spot-im, <script|style|svg|
//     iframe>, a CSS-variable or multi-declaration style="…", or a structural tag
//     carrying class="…") — markup that never occurs in real prose — then back up to
//     the previous blank line so the cut lands on a paragraph break. Inline tags
//     (<br> <p> <a href> <em>) do NOT trigger a cut. Refuses to gut an entry.
//   TIER 2 — in-place cosmetic cleanup, NO truncation: unwrap <a>…</a> to its text,
//     turn block/inline tags into whitespace, decode HTML entities, drop the ￼
//     object-replacement char, collapse blank-line runs. Runs on every entry.
//
// Real content is preserved: prose <…> placeholders (e.g. an LLM prompt's
// <patient-name>, <allowed-responses>) match no signature and aren't in the strip
// list, so they pass through untouched.
'use strict';
const fs = require('fs');

const FILE = process.argv.slice(2).find(a => !a.startsWith('--')) || 'o.json';
const APPLY = process.argv.includes('--apply');

// ── Tier 1 ─────────────────────────────────────────────────────────────────────
const SIGS = [
  /<ow-[a-z0-9]{5,}/i,
  /data-spot-im[\w-]*\s*=/i,
  /data-openweb[\w-]*\s*=/i,
  /\bspcv_[a-z]/i,
  /<script[\s>]/i, /<style[\s>]/i, /<noscript[\s>]/i,
  /<svg[\s>]/i, /<iframe[\s>]/i, /<picture[\s>]/i, /<source[\s>]/i,
  /<path\s+[^>]*\bd\s*=\s*"/i,
  /style\s*=\s*"\s*--/i,
  /style\s*=\s*"[^"]*:[^"]*;[^"]*:/i,
  /<(?:div|ul|ol|li|span|section|article|aside|nav|header|footer|table|tbody|tr|td|button|figure|figcaption)\s+[^>]*\bclass\s*=\s*"/i
];
function firstSig(t) {
  let min = -1;
  for (const re of SIGS) { const m = t.match(re); if (m && (min === -1 || m.index < min)) min = m.index; }
  return min;
}
function tier1(t) {
  const sig = firstSig(t);
  if (sig === -1) return { text: t, dropped: 0 };
  let cp = t.lastIndexOf('\n\n', sig);
  if (cp === -1) cp = t.lastIndexOf('\n', sig);
  if (cp === -1) cp = sig;
  const kept = t.slice(0, cp).replace(/\s+$/, '');
  const drop = t.length - kept.length;
  if (drop < 200) return { text: t, dropped: 0 };                          // stray near end → leave to Tier 2
  if (kept.length < 300 && drop > t.length * 0.9) return { text: t, dropped: 0, flagged: true }; // would gut → skip
  return { text: kept, dropped: drop };
}

// ── Tier 2 ─────────────────────────────────────────────────────────────────────
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'",
  '&nbsp;': ' ', '&rsquo;': '’', '&lsquo;': '‘', '&ldquo;': '“', '&rdquo;': '”',
  '&mdash;': '—', '&ndash;': '–', '&hellip;': '…', '&trade;': '™',
  '&copy;': '©', '&reg;': '®', '&deg;': '°' };
function decodeEntities(t) {
  return t
    .replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp|rsquo|lsquo|ldquo|rdquo|mdash|ndash|hellip|trade|copy|reg|deg);/g, m => ENT[m] || m)
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(+n); } catch (_) { return m; } })
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return m; } });
}
function tier2(t) {
  let s = t;
  s = s.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1');                      // unwrap anchors, keep text
  s = s.replace(/<\/?a\b[^>]*>/gi, '');                                    // any leftover unclosed <a>
  s = s.replace(/<br\s*\/?>/gi, '\n')
       .replace(/<\/(?:p|div|li|h[1-6]|ul|ol|tr|figure|figcaption|section|blockquote)>/gi, '\n')
       .replace(/<(?:p|div|li|h[1-6]|ul|ol|tr|figure|figcaption|section|blockquote)\b[^>]*>/gi, '\n');
  s = s.replace(/<\/?(?:em|strong|i|b|span|sup|sub|small|mark|u|s|abbr|cite|code|hr|wbr)\b[^>]*>/gi, '');
  s = decodeEntities(s);
  s = s.replace(/￼/g, '');                                            // object-replacement / broken image
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
  return s;
}

// ── Run ──────────────────────────────────────────────────────────────────────
const rows = JSON.parse(fs.readFileSync(FILE, 'utf8'));
let t1cut = 0, t1saved = 0, t1flag = 0, t2changed = 0, t2saved = 0, totalBefore = 0, totalAfter = 0;
const t1samples = [], t2samples = [];
let drHouse = null;

rows.forEach(r => {
  const orig = r.text || '';
  totalBefore += orig.length;
  const a = tier1(orig);
  if (a.dropped) {
    t1cut++; t1saved += a.dropped;
    if (t1samples.length < 5) t1samples.push({ title: r.title.slice(0, 48), keep: a.text.length, cut: a.dropped });
  }
  if (a.flagged) t1flag++;
  const after = tier2(a.text);
  const t2drop = a.text.length - after.length;
  if (t2drop !== 0 && !a.dropped) {
    t2changed++; t2saved += t2drop;
    if (t2samples.length < 4 && t2drop > 8)
      t2samples.push({ title: r.title.slice(0, 40),
        before: orig.replace(/\n/g, '⏎').slice(0, 120), after: after.replace(/\n/g, '⏎').slice(0, 120) });
  } else if (t2drop !== 0) { t2saved += t2drop; }
  totalAfter += after.length;
  if (/allowed-responses|patient-name/i.test(orig)) drHouse = { before: orig.length, after: after.length, text: after };
  if (APPLY) { r.text = after; r.chars = after.length; }
});

console.log((APPLY ? '✍ APPLIED' : '🔎 DRY-RUN (no write — pass --apply to write)') + '  ·  ' + FILE);
console.log('entries:                ' + rows.length);
console.log('TIER 1 truncated:       ' + t1cut + ' entries   −' + (t1saved / 1048576).toFixed(2) + ' MB');
console.log('TIER 1 flagged (skip):  ' + t1flag);
console.log('TIER 2 cleaned:         ' + t2changed + ' entries   −' + (t2saved / 1024).toFixed(0) + ' KB (￼ / entities / tags)');
console.log('text:  ' + (totalBefore / 1048576).toFixed(1) + ' MB  →  ' + (totalAfter / 1048576).toFixed(1)
  + ' MB   (−' + ((totalBefore - totalAfter) / totalBefore * 100).toFixed(1) + '%)');
console.log('\n── Tier 1 sample cuts:');
t1samples.forEach(s => console.log('   • keep ' + s.keep + ' / cut ' + s.cut + '  — ' + s.title));
console.log('\n── Tier 2 sample (…before / after…):');
t2samples.forEach(s => { console.log('   • ' + s.title); console.log('     B: ' + s.before); console.log('     A: ' + s.after); });
if (drHouse) console.log('\n── SAFETY CHECK — LLM-prompt entry (<patient-name>/<allowed-responses>): '
  + drHouse.before + ' → ' + drHouse.after + ' chars '
  + (drHouse.before === drHouse.after ? '✓ UNCHANGED' : '⚠ CHANGED — inspect!'));

if (APPLY) {
  fs.copyFileSync(FILE, FILE + '.bak');
  fs.writeFileSync(FILE, JSON.stringify(rows, null, 2));
  console.log('\n💾 wrote ' + FILE + '  (backup: ' + FILE + '.bak)');
}
