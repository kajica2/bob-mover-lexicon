/* Server-side etude sync for admins.
 *
 * Anonymous users (no token) keep using the per-browser IndexedDB
 * store (etudes-store.js) — the existing local-only behavior. Once
 * an admin logs in, this module:
 *   - Tracks the bearer token in localStorage under
 *     'bml_admin_token' (and the user object under 'bml_admin_user')
 *   - Exposes login() / logout() / status() / saveEtude() /
 *     listEtudes() / renameEtude() / deleteEtude() helpers that
 *     talk to the server's /api/auth/* and /api/etudes/* endpoints
 *   - Auto-loads the token on script init so a refresh keeps the
 *     user logged in
 *
 * The token is the only auth credential — anyone with the token
 * can act as the user. Tokens last 30 days (server SESSION_TTL_HOURS)
 * and are bcrypt-style random 32-byte hex.
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'bml_admin_token';
  var USER_KEY = 'bml_admin_user';
  var LIST_KEY = 'bml_server_etudes_v1';

  var _token = null;
  var _user = null;
  var _list = null; // cached server-side etudes

  // ---------- init from localStorage ----------
  try {
    _token = localStorage.getItem(TOKEN_KEY) || null;
    var u = localStorage.getItem(USER_KEY);
    if (u) _user = JSON.parse(u);
  } catch (e) { /* localStorage unavailable */ }

  // ---------- network helpers ----------
  function _fetchJson(path, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    if (_token) headers['Authorization'] = 'Bearer ' + _token;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.json);
      delete opts.json;
    }
    return fetch(path, Object.assign({ method: opts.method || 'GET', headers: headers }, opts))
      .then(function (r) {
        return r.json().then(function (body) {
          if (!r.ok) {
            var err = new Error((body && body.error) || ('HTTP ' + r.status));
            err.status = r.status;
            err.body = body;
            throw err;
          }
          return body;
        });
      });
  }

  // ---------- auth ----------
  function login(username, password) {
    return _fetchJson('/api/auth/login', {
      method: 'POST',
      json: { username: username, password: password },
    }).then(function (body) {
      _token = body.token;
      _user = body.user;
      try {
        localStorage.setItem(TOKEN_KEY, _token);
        localStorage.setItem(USER_KEY, JSON.stringify(_user));
      } catch (e) {}
      _list = null; // force refetch on next listEtudes()
      return _user;
    });
  }

  function logout() {
    var t = _token;
    _token = null;
    _user = null;
    _list = null;
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch (e) {}
    // Best-effort server-side revoke; ignore failures.
    if (t) {
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + t },
      }).catch(function () {});
    }
  }

  function status() {
    if (!_token) {
      return Promise.resolve({ authenticated: false });
    }
    return _fetchJson('/api/auth/status').then(function (body) {
      // Server may have revoked the token since we last cached it.
      if (!body.authenticated) {
        _token = null;
        _user = null;
        try {
          localStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem(USER_KEY);
        } catch (e) {}
      }
      return body;
    }).catch(function () {
      // Network error: trust the cached token optimistically.
      return { authenticated: !!_token, user: _user, offline: true };
    });
  }

  function isLoggedIn() {
    return !!_token && !!_user;
  }

  function currentUser() {
    return _user;
  }

  // ---------- etudes ----------
  function listEtudes(forceRefresh) {
    if (!_token) return Promise.resolve([]);
    if (!forceRefresh && _list) return Promise.resolve(_list);
    return _fetchJson('/api/etudes').then(function (body) {
      _list = body.etudes || [];
      // Mirror to localStorage so a stale page can still show the
      // last known list when offline. Not a cache — just a fallback.
      try { localStorage.setItem(LIST_KEY, JSON.stringify(_list)); } catch (e) {}
      return _list;
    });
  }

  function saveEtude(record) {
    if (!_token) return Promise.reject(new Error('Not logged in'));
    return _fetchJson('/api/etudes', {
      method: 'POST',
      json: {
        id: record.id,
        name: record.name,
        musicxml: record.musicxml,
        exerciseIds: record.exerciseIds || [],
        semitones: record.semitones || [],
        source: record.source || record.mode || 'composer',
        noteCount: record.noteCount || 0,
      },
    }).then(function (body) {
      // Optimistic list update so the UI doesn't need a refetch.
      _list = null;
      return body;
    });
  }

  function deleteEtude(id) {
    if (!_token) return Promise.reject(new Error('Not logged in'));
    return _fetchJson('/api/etudes/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function () { _list = null; });
  }

  function renameEtude(id, name) {
    if (!_token) return Promise.reject(new Error('Not logged in'));
    return _fetchJson('/api/etudes/' + encodeURIComponent(id) + '/rename', {
      method: 'POST',
      json: { name: name },
    }).then(function () { _list = null; });
  }

  // Try the cached list from localStorage as a synchronous fallback
  // (used by the UI to render something on first paint before the
  // server response arrives).
  function cachedList() {
    if (_list) return _list;
    try {
      var raw = localStorage.getItem(LIST_KEY);
      if (raw) return JSON.parse(raw) || [];
    } catch (e) {}
    return [];
  }

  window.etudesServer = {
    login: login,
    logout: logout,
    status: status,
    isLoggedIn: isLoggedIn,
    currentUser: currentUser,
    listEtudes: listEtudes,
    cachedList: cachedList,
    saveEtude: saveEtude,
    deleteEtude: deleteEtude,
    renameEtude: renameEtude,
  };
})();
