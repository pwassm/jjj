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
 *     { id, label, kind, rank?, parents:[], aliases?:[], def?:"", common?:"", extinct?:false }
 *   Rules:
 *     - id is a slug (lowercase, a-z 0-9 and hyphens)
 *     - kind === "taxon" → parents.length <= 1
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

  // ── public API ───────────────────────────────────────────────────────────
  const api = {
    load: loadTags,
    save: saveTags,
    all: () => tagsArr.slice(),
    get: (id) => byId.get(id) || null,
    has: (id) => byId.has(id),
    resolve: resolveInput,
    ancestors: tagAncestors,
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
    renderChipsForRecord,
    recordTagIds
  };
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
      if (t.def == null) t.def = '';
    });
    buildIndex();
  }

  async function saveTags() {
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
      (t.aliases || []).forEach(a => {
        const k = String(a).toLowerCase().trim();
        if (k) aliasToId.set(k, t.id);
      });
    });
    // Find orphans (tags on records that don't exist in dictionary)
    const seen = new Set();
    if (typeof data !== 'undefined' && Array.isArray(data)) {
      data.forEach(r => {
        (r.tags || []).forEach(id => {
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
      aliases: Array.isArray(partial.aliases) ? partial.aliases.filter(Boolean) : [],
      def: partial.def || '',
    };
    if (rank) rec.rank = rank;
    if (partial.common) rec.common = formatTagLabel(partial.common);
    if (partial.extinct) rec.extinct = true;
    // Taxon rule: single parent
    if (rec.kind === 'taxon' && rec.parents.length > 1) {
      rec.parents = [rec.parents[0]];
    }
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
        if (t.kind === 'taxon' && t.parents.length > 1) t.parents = [t.parents[0]];
      } else if (k === 'aliases' && Array.isArray(patch.aliases)) {
        t.aliases = patch.aliases.filter(Boolean);
      } else {
        t[k] = patch[k];
      }
    });
    if (t.kind === 'taxon' && (t.parents || []).length > 1) t.parents = [t.parents[0]];
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
  //   - `from`'s common/def copied to `to` if `to` lacks them
  //   - `from` is then deleted
  // Refuses if toId is a descendant of fromId (would create a cycle).
  function mergeTag(fromId, toId) {
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
    const toAdd = [from.label, from.common || '', ...(from.aliases || [])]
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
    to.aliases = mergedAliases;

    // 2. Fill in common/def on target if missing
    if (!to.common && from.common) to.common = from.common;
    if (!to.def    && from.def)    to.def    = from.def;

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
    return t ? t.label : id;
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
    return '#ccc';
  }

  function chipHtml(id, opts) {
    opts = opts || {};
    const t = byId.get(id);
    const label = t ? t.label : id;
    const color = kindColor(t);
    const title = t
      ? (t.kind === 'taxon' && t.rank ? t.rank + ' · ' + label : (t.kind + ' · ' + label)) + (t.common ? ' (' + t.common + ')' : '')
      : '⚠ orphan: ' + id;
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
    let inner;
    if (!missing && t.kind === 'taxon' && t.common && t.common !== t.label) {
      inner = escapeHtml(t.common)
        + ' <span style="color:#fff;font-style:italic;font-weight:normal;margin-left:3px;">' + escapeHtml(t.label) + '</span>';
    } else {
      inner = escapeHtml(label);
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
        const label = t ? t.label : id;
        const color = kindColor(t);
        const missing = !t;
        span.title = t
          ? (t.kind === 'taxon' && t.rank ? t.rank + ' · ' + label : (t.kind + ' · ' + label)) + (t.common ? ' (' + t.common + ')' : '')
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
          const cand = { score: s, field: h.field, len: h.s.length, via: h.s };
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

      // "Create new" offer if no exact match and user typed something
      let showCreate = false;
      if (q && !matches.some(m => m.score === 0)) showCreate = true;

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
        const via = (m.via && m.via !== t.label.toLowerCase()) ? ' <span style="color:#666;font-size:10px;">(via "' + escapeHtml(m.via) + '")</span>' : '';
        const rankBadge = t.rank
          ? '<span style="color:#666;font-size:10px;margin-left:5px;">' + t.rank + '</span>'
          : (t.kind && t.kind !== 'taxon' ? '<span style="color:#666;font-size:10px;margin-left:5px;">' + t.kind + '</span>' : '');
        const parentLbl = (t.parents || [])
          .map(p => labelFor(p))
          .filter(Boolean)
          .slice(0, 2)
          .join(', ');
        const parentHtml = parentLbl ? '<span style="color:#555;font-size:10px;"> → ' + escapeHtml(parentLbl) + '</span>' : '';
        item.innerHTML = '<span style="color:' + kindColor(t) + ';">' + escapeHtml(t.label) + '</span>'
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
            const r = createTag({ label: input.value.trim() });  // let createTag guess kind/rank
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

  // Table-context chip menu: shown on right-click of a chip in the T view.
  // Slightly different items than the Annotate chip menu — there's no
  // "remove from this row" because we'd need to mutate the data record
  // and re-save; instead the table provides Annotate / Filter / Dictionary / GBIF.
  window.openTableChipMenu = function (x, y, tagId, row) {
    // (zip0158) Toggle: if a menu was just open for this tag, close it
    // without action. The doc-level mousedown handler will have already
    // nulled _chipMenu by the time contextmenu fires, so we instead
    // consult a side-channel timestamp/tagId stash that survives the
    // close. Within 300ms of the previous menu closing for the same tag,
    // a second R-click is interpreted as "dismiss".
    const now = Date.now();
    if (_lastChipMenuClose
        && _lastChipMenuClose.tagId === tagId
        && (now - _lastChipMenuClose.t) < 300) {
      _lastChipMenuClose = null;
      return;
    }
    closeChipContextMenu();  // reuse the same DOM slot for any chip menu
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
    if (isTaxon) {
      items.push({
        key: 'g',
        labelHtml: 'Check <u>G</u>BIF',
        action: () => {
          openDictForTag(tagId);
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const btn = document.getElementById('de-gbif');
            if (btn) btn.click();
          }));
        }
      });
    }
    items.push({ sep: true });
    items.push({
      key: 'a',
      labelHtml: '<u>A</u>nnotate this row',
      action: () => {
        if (typeof window.openBrowseForRow === 'function' && row) window.openBrowseForRow(row);
      }
    });
    items.push({
      key: 'f',
      labelHtml: '<u>F</u>ilter table to this tag',
      action: () => {
        if (typeof window.setRowFilter === 'function') {
          window.setRowFilter({ col: 'tags', val: tagId, hierarchical: true });
        }
      }
    });

    _buildChipMenu(x, y, t, items);
  };

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
    // (zip0158) Toggle behavior — see openTableChipMenu for full detail.
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
    if (isTaxon) {
      items.push({
        key: 'g',
        labelHtml: 'Check <u>G</u>BIF',
        action: () => {
          openDictForTag(tagId);
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const btn = document.getElementById('de-gbif');
            if (btn) btn.click();
          }));
        }
      });
    }
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
          const hay = [t.label, t.id, t.common || '', t.def || '', ...(t.aliases || [])]
            .map(s => String(s).toLowerCase()).join(' ');
          return hay.includes(q);
        });
      }
      filtered.sort((a, b) => {
        const ka = (a.kind === 'taxon' ? '0' : a.kind === 'root' ? '0' : '1');
        const kb = (b.kind === 'taxon' ? '0' : b.kind === 'root' ? '0' : '1');
        if (ka !== kb) return ka < kb ? -1 : 1;
        return a.label.localeCompare(b.label);
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
        const parents = (t.parents || []).map(p => labelFor(p)).filter(Boolean).join(', ');
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
          + '<span style="color:' + color + ';font-weight:bold;">' + escapeHtml(t.label) + '</span>'
          + '<span style="color:#666;font-size:10px;">' + escapeHtml(t.kind + rank) + '</span>'
          + '<span style="flex:1;"></span>'
          + '<span style="color:#4af;font-size:10px;">' + use + ' vid</span>'
          + '</div>'
          + (parents ? '<div style="color:#555;font-size:10px;margin-top:2px;">↑ ' + escapeHtml(parents) + '</div>' : '')
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

      // Optional search-match set. If empty query, show everything.
      const matchedIds = new Set();
      if (q) {
        tagsArr.forEach(t => {
          const hay = [t.label, t.id, t.common || '', t.def || '', ...(t.aliases || [])]
            .map(s => String(s).toLowerCase()).join(' ');
          if (hay.includes(q)) matchedIds.add(t.id);
        });
        // When searching, also show all ancestors of matches so you see where they live.
        const expanded = new Set(matchedIds);
        matchedIds.forEach(id => tagAncestors(id).forEach(a => expanded.add(a)));
        // Temporarily expand every ancestor of a match
        expanded.forEach(id => expandedNodes.add(id));
      }

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
      childrenByParent.forEach(arr => arr.sort((a, b) => a.label.localeCompare(b.label)));

      // 1) Unsorted section (rootless non-root tags) — most recently created first
      const unsorted = tagsArr
        .map((t, i) => ({ t, i }))
        .filter(x => x.t.kind !== 'root' && (!x.t.parents || !x.t.parents.length))
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

      // 2) The roots (kind==='root'): render each as its own tree
      const roots = tagsArr.filter(t => t.kind === 'root');
      roots.sort((a, b) => a.label.localeCompare(b.label));
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

    function renderTreeNode(container, tag, depth, childrenByParent, matchedIds, q) {
      const t = tag;
      const row = document.createElement('div');
      row.className = 'tree-node';
      row.dataset.tagId = t.id;

      const kids = childrenByParent.get(t.id) || [];
      const isExpanded = expandedNodes.has(t.id);
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
      const commonHint = t.common ? ' <span style="color:#678;font-size:10px;">(' + escapeHtml(t.common) + ')</span>' : '';
      const useHint = use ? ' <span style="color:#4af;font-size:10px;">· ' + use + 'v</span>' : '';
      const kidsCount = kids.length ? ' <span style="color:#555;font-size:10px;">· ' + kids.length + '▾</span>' : '';
      const cutBadge = isCutSource ? ' <span style="color:#fc6;font-size:9px;">✂ cut</span>' : '';

      row.innerHTML = chevron
        + '<span class="tree-label" style="color:' + color + ';font-weight:' + (t.kind === 'root' ? 'bold' : 'normal') + ';">' + escapeHtml(t.label) + '</span>'
        + commonHint + rankBadge + extinct + cutBadge + kidsCount + useHint + aliasHint;

      // Chevron click → toggle expand
      const chevEl = row.querySelector('.tree-chev');
      if (chevEl) {
        chevEl.addEventListener('click', (e) => {
          e.stopPropagation();
          if (isExpanded) expandedNodes.delete(t.id); else expandedNodes.add(t.id);
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
          if (isExpanded) expandedNodes.delete(t.id); else expandedNodes.add(t.id);
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
        kids.forEach(k => renderTreeNode(container, k, depth + 1, childrenByParent, matchedIds, q));
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
      chip.innerHTML = escapeHtml(t.label)
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
      editEl.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
          <span style="font-size:17px;color:${kindColor(t)};font-weight:bold;">${escapeHtml(t.label)}</span>
          <span style="color:#555;font-size:11px;">id=${escapeHtml(t.id)}</span>
        </div>
        <div style="font-size:11px;color:#666;margin-bottom:10px;">
          Directly tagged on <b style="color:#4af;">${use}</b> videos · total (with descendants): <b style="color:#4af;">${effUse}</b> · descendants: <b style="color:#4af;">${descCount}</b>
        </div>

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

          <label style="color:#6af;padding-top:5px;">Common name</label>
          <input id="de-common" type="text" value="${escapeAttr(t.common || '')}"
            style="padding:5px 8px;background:#0a0a1a;border:1px solid #333;color:#fff;border-radius:4px;font-family:monospace;font-size:12px;outline:none;">

          <label style="color:#6af;padding-top:5px;">Definition</label>
          <textarea id="de-def" rows="4"
            style="padding:5px 8px;background:#0a0a1a;border:1px solid #333;color:#ccc;border-radius:4px;font-family:monospace;font-size:12px;outline:none;resize:vertical;">${escapeHtml(t.def || '')}</textarea>

          <label style="color:#6af;padding-top:5px;">Extinct</label>
          <label style="padding-top:5px;"><input id="de-extinct" type="checkbox" ${t.extinct ? 'checked' : ''}> <span style="color:#888;font-size:11px;">extinct taxon</span></label>
        </div>

        <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;">
          <button id="de-save" style="padding:6px 18px;border:1px solid #5f5;background:rgba(0,80,0,0.4);color:#afa;border-radius:5px;cursor:pointer;font-family:monospace;font-size:12px;font-weight:bold;">✓ Save</button>
          <button id="de-merge" style="padding:6px 14px;border:1px solid #fc8;background:rgba(80,50,0,0.35);color:#fc8;border-radius:5px;cursor:pointer;font-family:monospace;font-size:12px;" title="Merge this tag into another — moves records, adds aliases, deletes this tag">↗ Merge into…</button>
          <button id="de-del" style="padding:6px 14px;border:1px solid #f66;background:rgba(80,0,0,0.3);color:#f88;border-radius:5px;cursor:pointer;font-family:monospace;font-size:12px;">🗑 Delete</button>
          ${t.kind === 'taxon' ? '<button id="de-gbif" style="padding:6px 12px;border:1px solid #4af;background:rgba(0,40,100,0.35);color:#8ef;border-radius:5px;cursor:pointer;font-family:monospace;font-size:11px;" title="Verify this name against GBIF (Global Biodiversity Information Facility)">🔎 Check GBIF</button>' : ''}
          <span style="flex:1;"></span>
          <button id="de-viewrecs" style="padding:6px 12px;border:1px solid #4af;background:rgba(0,60,140,0.4);color:#8ef;border-radius:5px;cursor:pointer;font-family:monospace;font-size:11px;">Show ${effUse} videos</button>
        </div>
        <div id="de-gbif-result" style="margin-top:10px;"></div>

        ${children.length ? `<div style="margin-top:18px;border-top:1px solid #333;padding-top:10px;"><div style="color:#666;font-size:11px;margin-bottom:6px;">CHILDREN (${children.length})</div><div style="display:flex;flex-wrap:wrap;gap:4px;">${children.map(c => chipHtml(c.id)).join('')}</div></div>` : ''}
      `;

      // Mount parent chip input
      const parentMount = editEl.querySelector('#de-parents');
      let curParents = (t.parents || []).slice();
      window.mountTagChipInput({
        container: parentMount,
        getIds: () => curParents,
        setIds: (next) => { curParents = next; },
        placeholder: (t.kind === 'taxon' ? 'single parent…' : 'parent(s)…')
      });

      editEl.querySelector('#de-save').addEventListener('click', () => {
        const patch = {
          label:    editEl.querySelector('#de-label').value.trim(),
          kind:     editEl.querySelector('#de-kind').value,
          rank:     editEl.querySelector('#de-rank').value || undefined,
          parents:  curParents.slice(),
          aliases:  editEl.querySelector('#de-aliases').value.split(',').map(s => s.trim()).filter(Boolean),
          common:   editEl.querySelector('#de-common').value.trim(),
          def:      editEl.querySelector('#de-def').value,
          extinct:  editEl.querySelector('#de-extinct').checked
        };
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
            const res = await queryGbif(queryName);
            renderGbifResult(resultEl, id, queryName, res);
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
      renderView();
    });
    dictOverlay.querySelector('#dictClose').addEventListener('click', () => window.closeDictionary());

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
        if (kids.length && !expandedNodes.has(keyboardFocusedId)) {
          e.preventDefault(); e.stopPropagation();
          expandedNodes.add(keyboardFocusedId);
          renderView();
          return true;
        }
        if (kids.length && expandedNodes.has(keyboardFocusedId)) {
          // Already expanded → move focus into first child
          e.preventDefault(); e.stopPropagation();
          kids.sort((a, b) => a.label.localeCompare(b.label));
          setKbFocus(kids[0].id, true);
          return true;
        }
        return false;
      }
      if (e.key === 'ArrowLeft' && keyboardFocusedId && viewMode === 'tree') {
        const t = byId.get(keyboardFocusedId);
        if (!t) return false;
        if (expandedNodes.has(keyboardFocusedId)) {
          // Currently expanded → collapse it
          e.preventDefault(); e.stopPropagation();
          expandedNodes.delete(keyboardFocusedId);
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
      e.preventDefault();
      e.stopPropagation();
      window.closeDictionary();
    };
    document.addEventListener('keydown', dictOverlay._escHandler, true);
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
    const carryOver = [from.label, from.common || '', ...(from.aliases || [])].filter(Boolean);
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
          ? ('→ <span style="color:' + kindColor(t) + ';">' + escapeHtml(t.label) + '</span>'
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

  function renderGbifResult(container, tagId, query, res) {
    const t = byId.get(tagId);
    if (!t) { container.innerHTML = ''; return; }

    const matchType = res.matchType || 'NONE';
    const canonical = res.canonicalName || res.scientificName || '';
    const rank = (res.rank || '').toLowerCase();
    const conf = res.confidence || 0;

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
      headerHtml = '<span style="color:#afa;font-weight:bold;">✓ Exact match on GBIF</span>'
        + ' <span style="color:#666;font-size:10px;">(confidence ' + conf + '%)</span>';
      bgColor = 'rgba(80,200,80,0.08)';
      borderColor = '#484';
    } else if (matchType === 'FUZZY') {
      headerHtml = '<span style="color:#fc8;font-weight:bold;">⚠ Fuzzy match on GBIF</span>'
        + ' <span style="color:#666;font-size:10px;">(confidence ' + conf + '%)</span>'
        + '<div style="color:#fc8;margin-top:4px;font-size:11px;">Did you mean <b>' + escapeHtml(canonical) + '</b>?</div>';
      bgColor = 'rgba(255,200,100,0.08)';
      borderColor = '#764';
    } else if (matchType === 'HIGHERRANK') {
      headerHtml = '<span style="color:#88f;font-weight:bold;">↑ Matched at higher rank</span>'
        + '<div style="color:#aaf;margin-top:4px;font-size:11px;">GBIF matched <b>' + escapeHtml(canonical) + '</b> (' + escapeHtml(rank) + ') but not your exact name. Could be a common name — try the candidate list below.</div>';
      bgColor = 'rgba(100,100,255,0.08)';
      borderColor = '#446';
    } else {
      // NONE — likely a common name or misspelling
      headerHtml = '<span style="color:#f88;font-weight:bold;">✗ No exact scientific match</span>'
        + '<div style="color:#f99;margin-top:4px;font-size:11px;">"<b>' + escapeHtml(query) + '</b>" did not match any canonical scientific name. If this is a common name, see candidates below.</div>';
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
      if (res.scientificName && res.scientificName !== t.label
          && !(t.aliases || []).some(a => a.toLowerCase() === res.scientificName.toLowerCase())) {
        individualBtns.push({ id:'apply-alias', label:'Add "' + res.scientificName + '" as alias' });
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

    const gbifUrl = res.usageKey ? ('https://www.gbif.org/species/' + res.usageKey) : null;
    const linkHtml = gbifUrl
      ? '<div style="margin-top:4px;"><a href="' + gbifUrl + '" target="_blank" rel="noopener" style="color:#6af;font-size:10px;">View on gbif.org ↗</a></div>'
      : '';

    container.innerHTML =
      '<div style="padding:10px 12px;background:' + bgColor + ';border:1px solid ' + borderColor + ';border-radius:5px;font-size:11px;line-height:1.5;">'
      + headerHtml + chainHtml + linkHtml + actionsHtml
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
          patch.aliases = [...(t.aliases || []), res.scientificName];
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
      const candidates = await searchGbif(query, 8);
      // Filter out anything without a usable scientificName
      const usable = candidates.filter(c => c.scientificName && c.rank);
      if (!usable.length) {
        container.innerHTML = '<div style="padding:6px;color:#777;font-size:10px;">No additional candidates from GBIF common-name search.</div>';
        return;
      }
      let html = '<div style="font-size:10px;color:#888;margin-bottom:5px;">CANDIDATE MATCHES <span style="color:#666;">(scientific + common name search, deduped)</span>:</div>';
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
        return '<div data-cand-idx="' + i + '" style="padding:6px 9px;margin-bottom:3px;background:rgba(255,255,255,0.03);border:1px solid #333;border-radius:4px;cursor:pointer;font-size:11px;">'
          + '<span style="color:#8ef;font-weight:bold;font-style:italic;">' + escapeHtml(c.canonicalName || c.scientificName) + '</span>'
          + author
          + ' <span style="color:#888;font-size:10px;">' + escapeHtml((c.rank || '').toLowerCase()) + '</span>'
          + vennHtml
          + (chain ? '<div style="color:#667;font-size:9px;margin-top:3px;">' + escapeHtml(chain) + '</div>' : '')
          + '</div>';
      }).join('');
      container.innerHTML = html;
      // Wire candidate clicks: re-run the GBIF detail view against the chosen species
      [...container.querySelectorAll('[data-cand-idx]')].forEach(el => {
        const handlePick = (alsoApplyAll) => {
          const idx = parseInt(el.dataset.candIdx, 10);
          const c = usable[idx];
          if (!c) return;
          el.style.background = 'rgba(100,170,255,0.15)';
          el.style.borderColor = '#6cf';
          const synth = {
            matchType: 'EXACT',
            canonicalName: c.canonicalName || c.scientificName,
            scientificName: c.scientificName,
            rank: c.rank,
            confidence: 100,
            usageKey: c.key,
            authorship: c.authorship || '',
            kingdom: c.kingdom, phylum: c.phylum, class: c.class,
            order: c.order, family: c.family, genus: c.genus, species: c.species,
            vernacularNames: c.vernacularNames || []
          };
          const editElScope = el.closest('#dictEdit') || document.getElementById('dictEdit');
          const resultEl = editElScope ? editElScope.querySelector('#de-gbif-result') : null;
          if (resultEl) renderGbifResult(resultEl, tagId, c.scientificName, synth);
          if (alsoApplyAll) {
            // Defer one frame so the rendered result includes the Apply-All button
            requestAnimationFrame(() => {
              applyChainImport(tagId, synth, { withAliasAndCommon: true });
            });
          }
        };
        el.addEventListener('click',    () => handlePick(false));
        el.addEventListener('dblclick', () => handlePick(true));
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

    // Wire parent chain: each rank's parent is the next-higher rank present
    let parentChainEdits = 0;
    for (let i = 1; i < chain.length; i++) {
      const childId  = idsByRank[chain[i].rank];
      const parentId = idsByRank[chain[i - 1].rank];
      if (!childId || !parentId) continue;
      const child = byId.get(childId);
      if (!child) continue;
      const currentParents = child.parents || [];
      if (!currentParents.includes(parentId)) {
        // For taxa, single-parent rule: replace
        updateTag(childId, { parents: [parentId] });
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

    // ── Apply All extras: scientific-name-with-author alias + English common name
    let aliasAdded = false, commonSet = false;
    if (options.withAliasAndCommon) {
      const mostSpecificId = idsByRank[chain[chain.length - 1].rank];
      if (mostSpecificId) {
        const target = byId.get(mostSpecificId);
        if (target) {
          const patch = {};
          // 1) Add scientific name w/ authorship as alias if distinct from label
          if (res.scientificName
              && res.scientificName !== target.label
              && !(target.aliases || []).some(a => String(a).toLowerCase() === res.scientificName.toLowerCase())) {
            patch.aliases = [...(target.aliases || []), res.scientificName];
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
    const overlap = Object.values(idsByRank).includes(tagId);
    if (!overlap) {
      // Most-specific rank present
      const mostSpecific = idsByRank[chain[chain.length - 1].rank];
      if (mostSpecific) {
        // Add the original's label as alias of the species (so common-name
        // searches still work) and delete the now-redundant original.
        const target = byId.get(mostSpecific);
        if (target && t.label) {
          const existingAliases = target.aliases || [];
          const lc = t.label.toLowerCase();
          if (!existingAliases.some(a => String(a).toLowerCase() === lc)
              && lc !== target.label.toLowerCase()
              && lc !== (target.common || '').toLowerCase()) {
            // Set as common name if target lacks one and original doesn't look scientific
            if (!target.common && !/^[A-Z][a-z]+ [a-z]+$/.test(t.label)) {
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

    if (typeof toast === 'function') {
      const lines = [options.withAliasAndCommon ? '✓ Applied All from GBIF' : '✓ Imported GBIF chain'];
      lines.push(createdCount + ' new taxa created · ' + reusedCount + ' reused');
      if (parentChainEdits) lines.push(parentChainEdits + ' parent links set');
      if (aliasAdded) lines.push('scientific name + author added as alias');
      if (commonSet) lines.push('English common name set');
      if (originalRehomed) lines.push('Original tag merged into species (records re-tagged)');
      toast(lines.join('\n'), 3800);
    }
    if (typeof render === 'function') render();

    // Refresh dictionary view, jump selection to the species we ended up with
    const finalId = originalRehomed
      ? idsByRank[chain[chain.length - 1].rank]
      : tagId;
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
      _salColOrder: ['id','label','kind','rank','parents','aliases','common','def','extinct'],
      _salColWidths: { id:140, label:170, kind:70, rank:80, parents:200, aliases:220, common:140, def:320, extinct:60 }
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
      def:'Family of amphipod crustaceans with elongated slender bodies, typically clinging to algae or hydroids and moving in an inchworm fashion.' });
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
