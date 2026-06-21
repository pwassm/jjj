#!/usr/bin/env node
// orgToO.js — convert an Orgzly / org-mode file (flat level-1 headlines) into o.json,
// a LOCAL review store parallel to ml.json / s.json. Each `* ` headline → one row.
//
//   node orgToO.js [in.org] [out.json]
//   defaults:  orgzly/_org2/AqNew.org  ->  o.json     (both relative to cwd)
//
// Row shape:  { id, keyword, title, tags[], link, text, chars, src, line }
//   - keyword is recognized ONLY from the org TODO set {TODO,DONE,NEXT}; all-caps
//     title words (AI, US, MIT, NASA…) are preserved as title text.
//   - tags is the trailing  :a:b:  org tag set, split — kept INDEPENDENT of tags.json
//     (the T dictionary). These are the file's own primitive tags.
//   - text is the entry body VERBATIM (the pasted article text the user wants to keep).
//   - link is the first http(s) URL found in the body (usually the first line).
//
// The store is gitignored (local only), like s.json / ig.json — the raw 66 MB of
// pasted text never enters the repo. Re-run any time, or point it at another .org.
'use strict';
const fs = require('fs');
const path = require('path');

const KEYWORDS = new Set(['TODO', 'DONE', 'NEXT']);
const inPath  = process.argv[2] || path.join('orgzly', '_org2', 'AqNew.org');
const outPath = process.argv[3] || 'o.json';
const src = path.basename(inPath);

let raw;
try { raw = fs.readFileSync(inPath, 'utf8'); }
catch (e) { console.error('✗ cannot read ' + inPath + ': ' + e.message); process.exit(1); }

// Normalize CRLF/CR → LF (Orgzly writes LF, but be safe), then split.
const lines = raw.replace(/\r\n?/g, '\n').split('\n');

// A level-1 (or deeper) org headline: one-or-more stars, then a space. This file is
// entirely flat L1, but matching ^\*+ is the org-correct rule and harmless here.
const HEAD = /^(\*+)\s+(.*)$/;
// Trailing org tags ":a:b:" (whitespace-preceded) at end of a headline.
const TAGS = /\s+(:(?:[A-Za-z0-9_@#%]+:)+)\s*$/;
// First URL in a body. Excludes common trailing delimiters so ")" / "]" don't stick.
const URL  = /https?:\/\/[^\s)>\]"'`]+/;

const rows = [];
let cur = null;       // { line, headline }
let body = [];

function flush() {
  if (!cur) return;
  let head = cur.headline;

  // trailing tags
  let tags = [];
  const tm = head.match(TAGS);
  if (tm) { tags = tm[1].split(':').filter(Boolean); head = head.slice(0, tm.index); }
  head = head.trim();

  // leading TODO-state keyword (only the known org states — not title words)
  let keyword = '';
  const sp = head.indexOf(' ');
  const first = sp === -1 ? head : head.slice(0, sp);
  if (KEYWORDS.has(first)) { keyword = first; head = sp === -1 ? '' : head.slice(sp + 1); }

  const title = head.trim();
  const text  = body.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');  // trim blank ends
  const lm = text.match(URL);

  rows.push({
    id: 'o' + (rows.length + 1),
    keyword,
    title,
    tags,
    link: lm ? lm[0] : '',
    text,
    chars: text.length,
    src,
    line: cur.line
  });
}

lines.forEach((ln, i) => {
  const m = ln.match(HEAD);
  if (m) { flush(); cur = { line: i + 1, headline: m[2] }; body = []; }
  else if (cur) { body.push(ln); }
  // lines before the first headline (file preamble) are ignored
});
flush();

fs.writeFileSync(outPath, JSON.stringify(rows, null, 2));

// ── Summary ──────────────────────────────────────────────────────────────────
const withLink = rows.filter(r => r.link).length;
const withTags = rows.filter(r => r.tags.length).length;
const withKw   = rows.filter(r => r.keyword).length;
const withText = rows.filter(r => r.chars > 0).length;
const tagCount = {};
rows.forEach(r => r.tags.forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; }));
const topTags = Object.keys(tagCount).sort((a, b) => tagCount[b] - tagCount[a]).slice(0, 12)
  .map(t => t + ':' + tagCount[t]).join('  ');
const sz = fs.statSync(outPath).size;

console.log('✔ ' + inPath + '  ->  ' + outPath);
console.log('  rows:          ' + rows.length);
console.log('  with link:     ' + withLink);
console.log('  with tags:     ' + withTags + '  (' + Object.keys(tagCount).length + ' distinct)');
console.log('  with keyword:  ' + withKw);
console.log('  with body text:' + withText);
console.log('  o.json size:   ' + (sz / 1048576).toFixed(1) + ' MB');
console.log('  top tags:      ' + topTags);
