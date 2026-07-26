// loops.js — USER LOOPS (dev0667)
// ─────────────────────────────────────────────────────────────────────────────
// A viewer-owned list of A→B segments ("loops") over rows in ml.json.
//
// WHY A SEPARATE STORE: ml.json is dev-owned and the app FSA-clobbers it on
// every save, so a viewer's loops can NEVER be written there — they'd be lost
// on the next dev save and would leak one viewer's marks into everyone's data.
// Loops therefore live entirely in the viewer's own browser.
//
// STORAGE = localStorage (key `slam-user-loops`), not cookies: cookies cap at
// ~4KB and ride along on every request. localStorage is per-browser +
// per-site, survives quitting the browser and rebooting, and is cleared only
// when the user wipes site data.
//
// SYNC-READY BY DESIGN: every public method returns a Promise even though the
// local implementation is synchronous. That is the whole point of the seam —
// when the sal-api backend (worker/ + D1, see auth.js / window.salAuth) grows
// a loops table, `salLoops.remote = {…}` can be filled in below and the UI
// (vp.js's save button, the menu's "My Loops" tab) needs no rewrite.
//
// KEYING: a loop stores BOTH the row's UID and its link. UID is the primary
// key; the link is the fallback used when a row is renumbered or replaced, so
// a viewer's loop degrades to "found it anyway" instead of orphaning. Callers
// resolve with salLoops.matchRow(entry, row).
(function () {
  'use strict';

  var KEY = 'slam-user-loops';
  // Bound on the list so a runaway UI can't fill the origin's storage quota.
  // Oldest entries fall off the end once the cap is hit.
  var MAX = 200;
  var VERSION = 1;

  function _readRaw() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }
  function _writeRaw(list) {
    // Throws on quota — callers surface that as a toast rather than failing
    // silently, because a silent failure here looks exactly like "the button
    // did nothing".
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  }
  function _num(v) { var n = Number(v); return Number.isFinite(n) ? n : null; }
  function _clean(e) {
    if (!e || typeof e !== 'object') return null;
    var a = _num(e.a), b = _num(e.b);
    if (a === null || b === null) return null;
    if (b <= a) return null;
    return {
      id:   String(e.id || _newId()),
      uid:  e.uid == null ? '' : String(e.uid),
      link: String(e.link || ''),
      name: String(e.name || '').trim() || 'Loop',
      a: a, b: b,
      ts:  _num(e.ts)  || Date.now(),
      mts: _num(e.mts) || _num(e.ts) || Date.now(),
      v:   _num(e.v) || VERSION
    };
  }
  function _newId() {
    return 'lp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }
  // Newest first, same ordering rule as saved searches.
  function _sorted(list) {
    return list.slice().sort(function (x, y) { return (y.ts || 0) - (x.ts || 0); });
  }
  function _load() {
    return _sorted(_readRaw().map(_clean).filter(Boolean));
  }

  // Two loops are "the same" when they mark the same span of the same row.
  // 0.05s tolerance = well under one frame, so re-saving an unchanged A→B
  // updates the existing entry instead of piling up near-duplicates.
  function _same(e, uid, a, b) {
    return String(e.uid) === String(uid)
      && Math.abs(e.a - a) < 0.05 && Math.abs(e.b - b) < 0.05;
  }

  var salLoops = {
    // Which store is behind the adapter right now. Flips to 'sal-api' when a
    // remote is attached; the UI can show it but must not branch on it.
    backend: 'local',
    // (dev0667) Sync seam. Assign an object with
    //   list()          → Promise<entry[]>
    //   save(entry)     → Promise<entry>
    //   remove(id)      → Promise<void>
    // and call salLoops.sync() to reconcile. Nothing in the UI touches this.
    remote: null,

    // All loops, newest first.
    list: function () {
      try { return Promise.resolve(_load()); }
      catch (e) { return Promise.resolve([]); }
    },

    // How many loops are stored (cheap; used for the tab's count badge).
    countSync: function () { return _load().length; },

    // Add a loop. Re-saving the same span on the same row rewrites that entry
    // (new name / timestamp) rather than adding a second one.
    // Resolves { entry, created } so callers can word the toast honestly.
    add: function (o) {
      var e = _clean({
        uid: o && o.uid, link: o && o.link, name: o && o.name,
        a: o && o.a, b: o && o.b, ts: Date.now(), mts: Date.now()
      });
      if (!e) return Promise.reject(new Error('bad loop'));
      var list = _load();
      var hit = list.filter(function (x) { return _same(x, e.uid, e.a, e.b); })[0];
      var created = true;
      if (hit) {
        created = false;
        hit.name = e.name;
        hit.link = e.link || hit.link;
        hit.mts = Date.now();
        e = hit;
      } else {
        list.unshift(e);
      }
      try { _writeRaw(_sorted(list)); }
      catch (err) { return Promise.reject(err); }
      return Promise.resolve({ entry: e, created: created });
    },

    // Patch a loop by id (name / a / b / uid / link). Resolves the updated
    // entry, or null when the id is unknown.
    update: function (id, patch) {
      var list = _load(), found = null;
      list = list.map(function (e) {
        if (e.id !== String(id)) return e;
        var merged = _clean(Object.assign({}, e, patch || {}, { id: e.id, ts: e.ts, mts: Date.now() }));
        found = merged || e;
        return found;
      });
      if (!found) return Promise.resolve(null);
      try { _writeRaw(list); } catch (err) { return Promise.reject(err); }
      return Promise.resolve(found);
    },

    remove: function (id) {
      var list = _load();
      var next = list.filter(function (e) { return e.id !== String(id); });
      if (next.length === list.length) return Promise.resolve(false);
      try { _writeRaw(next); } catch (err) { return Promise.reject(err); }
      return Promise.resolve(true);
    },

    // Does this stored loop point at this ml.json row? UID first, link as the
    // fallback for a renumbered/replaced row (see KEYING at the top).
    matchRow: function (e, row) {
      if (!e || !row) return false;
      if (e.uid && row.UID != null && String(row.UID) === String(e.uid)) return true;
      return !!(e.link && row.link && String(row.link) === String(e.link));
    },

    // Resolve a loop to a live row out of a set of ml.json rows. Returns
    // { row, byLink } — byLink true means the UID missed and the link saved
    // it, which the caller should write back via update() so the next lookup
    // is a UID hit again.
    resolve: function (e, rows) {
      if (!e || !Array.isArray(rows)) return { row: null, byLink: false };
      var byUid = null, byLink = null;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (!r || r._salMeta) continue;
        if (!byUid && e.uid && r.UID != null && String(r.UID) === String(e.uid)) { byUid = r; break; }
        if (!byLink && e.link && r.link && String(r.link) === String(e.link)) byLink = r;
      }
      if (byUid) return { row: byUid, byLink: false };
      return { row: byLink, byLink: !!byLink };
    },

    // mm:ss.s — how a loop's edges are written everywhere in the UI.
    fmt: function (s) {
      var n = Number(s);
      if (!Number.isFinite(n) || n < 0) n = 0;
      var m = Math.floor(n / 60);
      var sec = n - m * 60;
      return m + ':' + (sec < 10 ? '0' : '') + sec.toFixed(1);
    },

    // (dev0667) No remote yet — resolves false so callers can wire a "Sync"
    // affordance now and have it light up when the backend lands.
    sync: function () {
      if (!salLoops.remote) return Promise.resolve(false);
      return Promise.resolve(salLoops.remote.list())
        .then(function (remoteList) {
          // Last-write-wins merge on id, newest mts kept. Deliberately simple:
          // loops are small, viewer-private, and conflicts are rare.
          var byId = {};
          _load().forEach(function (e) { byId[e.id] = e; });
          (remoteList || []).map(_clean).filter(Boolean).forEach(function (e) {
            var cur = byId[e.id];
            if (!cur || (e.mts || 0) > (cur.mts || 0)) byId[e.id] = e;
          });
          _writeRaw(_sorted(Object.keys(byId).map(function (k) { return byId[k]; })));
          salLoops.backend = 'sal-api';
          return true;
        })
        .catch(function () { return false; });
    },

    // Escape hatches for debugging / a future export button.
    exportJson: function () { return JSON.stringify(_load(), null, 2); },
    clearAll:   function () { try { localStorage.removeItem(KEY); } catch (e) {} return Promise.resolve(true); },
    STORAGE_KEY: KEY
  };

  window.salLoops = salLoops;
})();
