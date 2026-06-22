#!/usr/bin/env node
// orgToO.js — convert Orgzly / org-mode files (flat level-1 headlines) into o.json,
// a LOCAL review store parallel to ml.json / s.json. Each `* ` headline → one row.
//
//   node orgToO.js                      # single: orgzly/_org2/AqNew.org -> o.json (overwrite)
//   node orgToO.js in.org [out.json]    # single file, overwrite out (default o.json)
//   node orgToO.js --all [dir] [out]    # ALL *.org in dir (default orgzly/_org2) -> out
//   node orgToO.js --all --append       # merge those .org files INTO an existing o.json,
//                                        #   skipping rows already present (notebook+line) —
//                                        #   this is how you "import the rest" without
//                                        #   clobbering the cleaned/edited rows you already have.
//
// After an --append import of new notebooks, run  node cleanO.js --apply  to strip the
// pasted-web-app DOM junk from the freshly added bodies (same as the original main import).
//
// Row shape: { id, notebook, keyword, title, tags[], link, text, chars,
//              dateAdded, dateModified, src, line }
//   - notebook   the source .org file (minus extension); AqNew is renamed → "main".
//   - dateAdded  from the org :CREATED: [YYYY-MM-DD Day HH:mm] property drawer when the
//                file has one (older/junk/aaa/…). AqNew/main has none → '' (blank).
//   - dateModified  initialised to dateAdded; the O screen re-stamps it on every edit.
//   - keyword    recognised ONLY from the org TODO set {TODO,DONE,NEXT}; all-caps title
//                words (AI, US, MIT…) are preserved as title text.
//   - tags       the trailing :a:b: org tag set — kept INDEPENDENT of tags.json.
//   - text       the entry body VERBATIM, with the :PROPERTIES: drawer stripped out.
//   - link       the first http(s) URL found in the body.
//
// The store is gitignored (local only), like s.json / ig.json — the raw pasted text
// never enters the repo. Re-run any time; --append is idempotent (notebook+line dedupe).
'use strict';
const fs = require('fs');
const path = require('path');

// ── Args ───────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const ALL    = argv.includes('--all');
const APPEND = argv.includes('--append');
const pos    = argv.filter(a => !a.startsWith('--'));

const KEYWORDS = new Set(['TODO', 'DONE', 'NEXT']);
// A level-1+ org headline: one-or-more stars then a space.
const HEAD = /^(\*+)\s+(.*)$/;
// Trailing org tags ":a:b:" (whitespace-preceded) at end of a headline.
const TAGS = /\s+(:(?:[A-Za-z0-9_@#%]+:)+)\s*$/;
// First URL in a body. Excludes common trailing delimiters so ")" / "]" don't stick.
const URL  = /https?:\/\/[^\s)>\]"'`]+/;
// :CREATED:  [2021-11-11 Thu 19:39]  → capture date and (optional) HH:mm.
const CREATED = /^\s*:CREATED:\s*\[(\d{4}-\d{2}-\d{2})(?:[^\]\d]*(\d{2}:\d{2}))?[^\]]*\]/i;

// AqNew is the user's working notebook, displayed as "main".
function notebookName(file) {
  const b = path.basename(file).replace(/\.org$/i, '').trim();
  return /^aqnew$/i.test(b) ? 'main' : (b || 'main');
}

// Pull a leading :PROPERTIES: … :END: drawer off the body lines. Returns the parsed
// props plus the remaining real-body lines.
function extractDrawer(bodyLines) {
  let i = 0;
  while (i < bodyLines.length && bodyLines[i].trim() === '') i++;   // skip blank lead
  if (i >= bodyLines.length || !/^\s*:PROPERTIES:\s*$/i.test(bodyLines[i]))
    return { props: {}, body: bodyLines };
  const props = {};
  let j = i + 1;
  for (; j < bodyLines.length; j++) {
    if (/^\s*:END:\s*$/i.test(bodyLines[j])) { j++; break; }
    const cm = bodyLines[j].match(CREATED);
    if (cm) props.created = cm[1] + (cm[2] ? ' ' + cm[2] : '');
  }
  return { props, body: bodyLines.slice(j) };
}

// Parse one .org file → array of rows (ids/dedupe handled by the caller).
function parseFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');   // normalise CRLF/CR → LF
  const nb = notebookName(file);
  const src = path.basename(file);
  const out = [];
  let cur = null, body = [];

  const flush = () => {
    if (!cur) return;
    let head = cur.headline;

    let tags = [];
    const tm = head.match(TAGS);
    if (tm) { tags = tm[1].split(':').filter(Boolean); head = head.slice(0, tm.index); }
    head = head.trim();

    let keyword = '';
    const sp = head.indexOf(' ');
    const first = sp === -1 ? head : head.slice(0, sp);
    if (KEYWORDS.has(first)) { keyword = first; head = sp === -1 ? '' : head.slice(sp + 1); }

    const { props, body: realBody } = extractDrawer(body);
    const title = head.trim();
    const text  = realBody.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
    const lm = text.match(URL);
    const dateAdded = props.created || '';

    out.push({
      id: 'o_' + nb + '_' + cur.line,
      notebook: nb,
      keyword,
      title,
      tags,
      link: lm ? lm[0] : '',
      text,
      chars: text.length,
      dateAdded,
      dateModified: dateAdded,
      src,
      line: cur.line
    });
  };

  lines.forEach((ln, i) => {
    const m = ln.match(HEAD);
    if (m) { flush(); cur = { line: i + 1, headline: m[2] }; body = []; }
    else if (cur) { body.push(ln); }
    // lines before the first headline (file preamble) are ignored
  });
  flush();
  return out;
}

// ── Resolve inputs ───────────────────────────────────────────────────────────
let files, outPath;
if (ALL) {
  const dir = pos[0] || path.join('orgzly', '_org2');
  outPath = pos[1] || 'o.json';
  files = fs.readdirSync(dir).filter(f => /\.org$/i.test(f)).map(f => path.join(dir, f));
} else {
  const inPath = pos[0] || path.join('orgzly', '_org2', 'AqNew.org');
  outPath = pos[1] || 'o.json';
  files = [inPath];
}

// ── Parse ──────────────────────────────────────────────────────────────────────
let parsed = [];
const perNb = {};
for (const f of files) {
  let rows;
  try { rows = parseFile(f); }
  catch (e) { console.error('✗ cannot read ' + f + ': ' + e.message); continue; }
  parsed = parsed.concat(rows);
  const nb = notebookName(f);
  perNb[nb] = (perNb[nb] || 0) + rows.length;
}

// ── Merge (append) or overwrite ─────────────────────────────────────────────────
let finalRows, existing = [], added = 0, skipped = 0;
if (APPEND && fs.existsSync(outPath)) {
  try { existing = JSON.parse(fs.readFileSync(outPath, 'utf8')); if (!Array.isArray(existing)) existing = []; }
  catch (e) { console.error('✗ cannot parse existing ' + outPath + ': ' + e.message); process.exit(1); }
  // Key existing rows by notebook+line (fall back to derived notebook on legacy rows).
  const key = r => (r.notebook || notebookName(r.src || '')) + '\t' + r.line;
  const seen = new Set(existing.map(key));
  finalRows = existing.slice();
  for (const r of parsed) {
    if (seen.has(key(r))) { skipped++; continue; }
    seen.add(key(r)); finalRows.push(r); added++;
  }
} else {
  finalRows = parsed;
  added = parsed.length;
}

fs.writeFileSync(outPath, JSON.stringify(finalRows, null, 2));

// ── Summary ──────────────────────────────────────────────────────────────────
const withLink = parsed.filter(r => r.link).length;
const withTags = parsed.filter(r => r.tags.length).length;
const withKw   = parsed.filter(r => r.keyword).length;
const withDate = parsed.filter(r => r.dateAdded).length;
const sz = fs.statSync(outPath).size;

console.log('✔ ' + (ALL ? files.length + ' .org files' : files[0]) + '  ->  ' + outPath
  + (APPEND ? '  (append/merge)' : '  (overwrite)'));
console.log('  parsed rows:   ' + parsed.length);
if (ALL) Object.keys(perNb).sort((a, b) => perNb[b] - perNb[a])
  .forEach(nb => console.log('     · ' + nb.padEnd(18) + perNb[nb]));
if (APPEND) console.log('  added: ' + added + '   skipped (already present): ' + skipped
  + '   total now: ' + finalRows.length);
console.log('  with link:     ' + withLink);
console.log('  with tags:     ' + withTags);
console.log('  with keyword:  ' + withKw);
console.log('  with :CREATED: ' + withDate + '  (date added)');
console.log('  o.json size:   ' + (sz / 1048576).toFixed(1) + ' MB');
if (APPEND && added) console.log('\n→ next: run  node cleanO.js --apply  to strip DOM junk from the new bodies.');
