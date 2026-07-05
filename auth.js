/* SLAM auth — thin client for the sal-api Cloudflare Worker (worker/src/index.js).
 *
 * Passwordless magic-link login. Anyone may log in; browsing the site NEVER
 * requires it — this module is purely additive. If the API is unreachable
 * every call fails soft (resolves to a signed-out / empty state) so the public
 * site keeps working exactly as it did before auth existed.
 *
 * Exposes window.salAuth:
 *   harvestHash()                 — call ONCE on load; grabs #session=… → LS, strips it
 *   token()                       — current bearer token or null
 *   loggedIn()                    — boolean (token present)
 *   me()                          — cached GET /auth/me → {email,name,role} | null
 *   requestLink(email)            — POST /auth/request-link → {ok,sent,devLink?} | {error}
 *   logout()                      — POST /auth/logout + clear LS
 *   getComments(uid)              — GET /comments?uid=… → [{author,body,created}]
 *   postComment(uid, body)        — POST /comments   (expert/admin)
 *   postMessage(body, opts)       — POST /messages   {uid?, kind?}  (any user)
 */
(function () {
  'use strict';

  // One place to point at the API. Swap for api.sealifeandmore.com once the
  // custom domain is live (see worker/wrangler.toml routes).
  var API = 'https://sal-api.pwassm.workers.dev';
  var LS_KEY = 'salSession';

  var _meCache;         // undefined = not fetched, null = anon, object = user
  var _mePromise = null;

  function token() {
    try { return localStorage.getItem(LS_KEY) || null; } catch (e) { return null; }
  }
  function loggedIn() { return !!token(); }

  function _setToken(t) {
    try { t ? localStorage.setItem(LS_KEY, t) : localStorage.removeItem(LS_KEY); } catch (e) {}
    _meCache = undefined; _mePromise = null;   // invalidate identity cache
  }

  // Harvest "#session=<hex>" left by /auth/verify's redirect, store it, and
  // scrub it from the URL so it never lingers in history/bookmarks/referrers.
  function harvestHash() {
    try {
      var m = /[#&]session=([a-f0-9]{16,})/i.exec(location.hash || '');
      if (!m) return false;
      _setToken(m[1]);
      var clean = (location.hash || '').replace(/[#&]session=[a-f0-9]+/i, '').replace(/^#&?/, '#');
      if (clean === '#') clean = '';
      history.replaceState(null, '', location.pathname + location.search + clean);
      return true;
    } catch (e) { return false; }
  }

  function _url(path) { return API + path; }

  // Fetch with the bearer header injected. Never throws — network / parse
  // failures resolve to {error} so callers can fail soft.
  function authFetch(path, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    var t = token();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    if (opts.body != null && typeof opts.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(_url(path), Object.assign({}, opts, { headers: headers }))
      .then(function (r) {
        return r.json().catch(function () { return {}; })
          .then(function (d) {
            if (r.status === 401) _setToken(null);   // stale/expired session
            return d;
          });
      })
      .catch(function (e) { return { error: 'network', detail: String(e && e.message || e) }; });
  }

  // Cached identity lookup. Anonymous (no token) short-circuits to null so the
  // public site makes zero API calls unless someone has actually signed in.
  function me() {
    if (!token()) { _meCache = null; return Promise.resolve(null); }
    if (_meCache !== undefined) return Promise.resolve(_meCache);
    if (_mePromise) return _mePromise;
    _mePromise = authFetch('/auth/me').then(function (d) {
      _meCache = (d && d.email) ? d : null;
      _mePromise = null;
      return _meCache;
    });
    return _mePromise;
  }

  function requestLink(email) {
    return authFetch('/auth/request-link', {
      method: 'POST',
      body: { email: String(email || '').trim(), site: location.origin },
    });
  }

  function logout() {
    var p = token() ? authFetch('/auth/logout', { method: 'POST' }) : Promise.resolve({});
    _setToken(null);
    return p;
  }

  function getComments(uid) {
    return fetch(_url('/comments?uid=' + encodeURIComponent(uid)))
      .then(function (r) { return r.json(); })
      .then(function (d) { return (d && d.comments) || []; })
      .catch(function () { return []; });
  }
  function postComment(uid, body) {
    return authFetch('/comments', { method: 'POST', body: { uid: String(uid), body: String(body) } });
  }
  function postMessage(body, opts) {
    opts = opts || {};
    return authFetch('/messages', {
      method: 'POST',
      body: { body: String(body), uid: opts.uid ? String(opts.uid) : undefined, kind: opts.kind },
    });
  }

  window.salAuth = {
    API: API,
    harvestHash: harvestHash,
    token: token,
    loggedIn: loggedIn,
    me: me,
    requestLink: requestLink,
    logout: logout,
    getComments: getComments,
    postComment: postComment,
    postMessage: postMessage,
  };

  // Harvest immediately at parse time so the token is present before boot.js
  // builds the shareable menu (auth.js is loaded before boot.js in index.html).
  harvestHash();
})();
