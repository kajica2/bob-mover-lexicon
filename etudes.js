/* Etudes page controller.
 *
 * Loads exercises.json once, drives the Composer + Generator UIs, persists
 * saved etudes through window.etudesStore (IndexedDB).
 *
 * Two modes:
 *   - Composer: section-pick → checkbox exercises → reorder via drag → set
 *     per-ex transpose semitones → click Generate → stitch + save to IDB.
 *   - Generator: section-pick → N exercises → ±semitone spread → click
 *     Generate → preview the random sample → save with a name.
 *
 * After saving, the etude appears in the Saved Etudes list. Each card has
 * a Practice link that takes the user to /practice/?id=etude_<uuid>, where
 * practice.js reads the etude's stored MusicXML from IndexedDB instead of
 * calling /api/musicxml/<id>.
 */
(function () {
  'use strict';

  // ---------- Global state ----------
  const state = {
    exercises: [],            // [{id, section, section_name, title, page}, ...]
    exercisesBySection: {},   // {section: [ex, ...]}
    composer: {
      selected: [],           // ordered list of {id, semitones}
      filter: '',             // search text
      section: '',            // currently selected section chip
    },
    random: {
      lastPreview: null,      // [{id, semitones}, ...]
    },
    savedFilter: '',           // search text for the saved-etudes list
  };

  // ---------- Bootstrap ----------
  function init() {
    wireModeTabs();
    wireSavedListFilter();
    wireAdminLogin();
    wireCurated();
    renderMasterClass();   // Master Class has no server dependency — render immediately
    fetchExercises().then(function () {
      populateComposerSection();
      populateRandomSection();
      renderComposer();
      wireComposerControls();
      wireRandomControls();
      wireEtudesActions();
      refreshSavedEtudes();
      refreshAdminStatus();
    });
  }

  // ---------- Admin login / server etudes ----------
  // v41: when an admin is logged in, etudes are also saved to the
  // server so they persist across devices / browsers. The token is
  // stored in localStorage by etudes-server.js. Composer / Random /
  // Master Class save flows additionally call saveToServer() when
  // the user is logged in (failures are non-fatal — the local
  // save still succeeded).
  function wireAdminLogin() {
    var loginBtn = document.getElementById('admin-login-btn');
    var form = document.getElementById('admin-login-form');
    var cancelBtn = document.getElementById('admin-login-cancel');
    var status = document.getElementById('admin-status');
    if (loginBtn) {
      loginBtn.addEventListener('click', function () {
        loginBtn.hidden = true;
        form.hidden = false;
        var u = document.getElementById('admin-username');
        if (u) u.focus();
      });
    }
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        form.hidden = true;
        loginBtn.hidden = false;
      });
    }
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var u = document.getElementById('admin-username').value;
        var p = document.getElementById('admin-password').value;
        if (!window.etudesServer) {
          toast('Server module not loaded.', true);
          return;
        }
        window.etudesServer.login(u, p).then(function (user) {
          form.hidden = true;
          loginBtn.hidden = true;
          toast('Signed in as ' + user.username);
          refreshAdminStatus();
          refreshServerEtudes();
        }).catch(function (err) {
          toast('Login failed: ' + (err && err.message ? err.message : 'unknown'), true);
        });
      });
    }
    if (status) {
      // Event delegation — the status element is rebuilt by
      // refreshAdminStatus() so a single listener on the body
      // wouldn't help; instead, attach after the element is rendered.
      status.addEventListener('click', function (e) {
        if (e.target && e.target.id === 'admin-logout-btn') {
          window.etudesServer.logout();
          refreshAdminStatus();
          toast('Signed out.');
        }
      });
    }
  }

  function refreshAdminStatus() {
    if (!window.etudesServer) return;
    window.etudesServer.status().then(function (body) {
      var loginBtn = document.getElementById('admin-login-btn');
      var form = document.getElementById('admin-login-form');
      var status = document.getElementById('admin-status');
      var wrap = document.getElementById('server-etudes-wrap');
      var isAdmin = !!(body.authenticated && body.user && body.user.role === 'admin');
      if (body.authenticated && body.user) {
        if (loginBtn) loginBtn.hidden = true;
        if (form) form.hidden = true;
        if (status) {
          status.hidden = false;
          status.innerHTML = '';
          var u = document.createElement('span');
          u.className = 'admin-username';
          u.textContent = body.user.username;
          status.appendChild(u);
          var role = document.createElement('span');
          role.textContent = '(' + body.user.role + ')';
          status.appendChild(role);
          var out = document.createElement('button');
          out.id = 'admin-logout-btn';
          out.className = 'btn btn-ghost btn-sm';
          out.type = 'button';
          out.textContent = 'Logout';
          status.appendChild(out);
        }
        if (wrap) wrap.hidden = false;
        refreshServerEtudes();
      } else {
        if (loginBtn) loginBtn.hidden = false;
        if (form) form.hidden = true;
        if (status) {
          status.hidden = true;
          status.innerHTML = '';
        }
        if (wrap) wrap.hidden = true;
      }
      // Curated tab upload widget + delete buttons are admin-only.
      var uploadWrap = document.getElementById('curated-upload-wrap');
      var noAdmin = document.getElementById('curated-no-admin');
      if (uploadWrap) uploadWrap.hidden = !isAdmin;
      if (noAdmin) noAdmin.hidden = isAdmin;
      // Bulk-action toolbar is admin-only. When the viewer switches
      // from admin to non-admin we drop any pending selection so a
      // future admin re-login doesn't accidentally act on items
      // that no longer exist.
      var bulkWrap = document.getElementById('curated-bulk-wrap');
      if (bulkWrap) bulkWrap.hidden = !isAdmin;
      if (!isAdmin) _curatedSelected.clear();
      refreshCuratedList(isAdmin);
    });
  }

  function refreshServerEtudes() {
    var list = document.getElementById('server-etudes-list');
    var count = document.getElementById('server-etudes-count');
    if (!list) return;
    if (!window.etudesServer || !window.etudesServer.isLoggedIn()) {
      list.innerHTML = '';
      if (count) count.textContent = '(0)';
      return;
    }
    window.etudesServer.listEtudes().then(function (rows) {
      list.innerHTML = '';
      if (!rows.length) {
        var p = document.createElement('p');
        p.className = 'muted';
        p.id = 'server-etudes-empty';
        p.textContent = 'No server-side etudes yet. Save one to populate this list.';
        list.appendChild(p);
        if (count) count.textContent = '(0)';
        return;
      }
      if (count) count.textContent = '(' + rows.length + ')';
      rows.forEach(function (et) { list.appendChild(makeServerEtudeCard(et)); });
    });
  }

  // ---------- Curated MXL ----------
  // v45: admin-curated MusicXML library. Anyone can read + open
  // items in the practice page; only admins can upload/delete. The
  // list refresh runs on init (public read) and again whenever the
  // admin logs in/out so the upload widget + delete buttons appear
  // for the right audience.
  function wireCurated() {
    var form = document.getElementById('curated-upload-form');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        handleCuratedUpload();
      });
    }
    // Bulk-action toolbar. Each button is wired to its own handler;
    // the toolbar itself is shown/hidden by refreshAdminStatus
    // based on whether the viewer is an admin.
    var selectAll = document.getElementById('curated-select-all');
    if (selectAll) selectAll.addEventListener('click', function () {
      curatedSelectAll();
    });
    var selectNone = document.getElementById('curated-select-none');
    if (selectNone) selectNone.addEventListener('click', function () {
      curatedSelectNone();
    });
    var batchDel = document.getElementById('curated-batch-delete');
    if (batchDel) batchDel.addEventListener('click', function () {
      handleCuratedBatchDelete();
    });
  }

  // ---------- Curated bulk-select state ----------
  // Module-scoped Set so the selection survives re-renders
  // (refreshCuratedList rebuilds the list DOM from scratch each
  // time). When a card is re-rendered, it consults this Set to
  // restore its checked state.
  var _curatedSelected = new Set();
  function curatedIsSelected(id) { return _curatedSelected.has(id); }
  function curatedSelectOne(id, checkbox) {
    if (checkbox.checked) _curatedSelected.add(id);
    else _curatedSelected.delete(id);
    curatedUpdateBulkToolbar();
  }
  function curatedSelectAll() {
    document.querySelectorAll('#curated-list .curated-checkbox').forEach(function (cb) {
      cb.checked = true;
      _curatedSelected.add(cb.value);
    });
    curatedUpdateBulkToolbar();
  }
  function curatedSelectNone() {
    document.querySelectorAll('#curated-list .curated-checkbox').forEach(function (cb) {
      cb.checked = false;
    });
    _curatedSelected.clear();
    curatedUpdateBulkToolbar();
  }
  function curatedUpdateBulkToolbar() {
    var n = _curatedSelected.size;
    var lbl = document.getElementById('curated-selected-count');
    if (lbl) lbl.textContent = n + ' selected';
    var del = document.getElementById('curated-batch-delete');
    if (del) del.disabled = n === 0;
    var clear = document.getElementById('curated-select-none');
    if (clear) clear.disabled = n === 0;
    // "Select all" only makes sense if there's at least one item.
    var list = document.getElementById('curated-list');
    var total = list ? list.querySelectorAll('.curated-checkbox').length : 0;
    var selectAll = document.getElementById('curated-select-all');
    if (selectAll) selectAll.disabled = total === 0;
  }

  function refreshCuratedList(isAdmin) {
    var list = document.getElementById('curated-list');
    var count = document.getElementById('curated-count');
    if (!list) return;
    fetch('/api/curated-mxl').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (body) {
      var items = (body && body.items) || [];
      list.innerHTML = '';
      if (count) count.textContent = '(' + items.length + ')';
      if (!items.length) {
        var empty = document.createElement('p');
        empty.className = 'muted';
        empty.id = 'curated-empty';
        empty.textContent = 'No curated items yet.';
        list.appendChild(empty);
        // Fall through to the toolbar refresh so the "N selected"
        // label + Delete button reset when the list is emptied
        // (e.g. after a batch delete removes the last item).
      } else {
        items.forEach(function (c) { list.appendChild(makeCuratedCard(c, isAdmin)); });
      }
      // Sync the bulk-action toolbar with the new DOM: a re-render
      // may have added/removed cards, so the "Select all" enable
      // state and the "N selected" label both need a refresh.
      curatedUpdateBulkToolbar();
    }).catch(function (err) {
      list.innerHTML = '<p class="muted" style="color: var(--danger, #b03030);">Failed to load curated items: ' +
        (err && err.message ? err.message : err) + '</p>';
      curatedUpdateBulkToolbar();
    });
  }

  function makeCuratedCard(c, isAdmin) {
    var card = document.createElement('div');
    card.className = 'etude-card curated-card' + (isAdmin ? ' etude-card-has-checkbox' : '');
    card.dataset.id = c.id;

    // Admin-only selection checkbox. Lives outside the .etude-info
    // flex row so the layout doesn't shift when the checkbox
    // appears/disappears. The bulk-delete toolbar pulls these
    // values to build its POST body.
    if (isAdmin) {
      var checkCell = document.createElement('div');
      checkCell.className = 'etude-checkbox-cell';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'curated-checkbox';
      cb.value = c.id;
      cb.checked = curatedIsSelected(c.id);
      cb.setAttribute('aria-label', 'Select ' + c.name);
      cb.addEventListener('change', function () {
        curatedSelectOne(c.id, cb);
      });
      cb.addEventListener('click', function (e) {
        // Don't let the click bubble to the card — selecting via
        // checkbox shouldn't open the piece in the practice page.
        e.stopPropagation();
      });
      checkCell.appendChild(cb);
      card.appendChild(checkCell);
    }

    var info = document.createElement('div');
    info.className = 'etude-info';
    var titleRow = document.createElement('div');
    titleRow.className = 'etude-title-row';
    var name = document.createElement('span');
    name.className = 'etude-name';
    name.textContent = c.name;
    titleRow.appendChild(name);
    var badge = document.createElement('span');
    badge.className = 'etude-source-badge';
    badge.style.background = 'rgba(180, 140, 60, 0.15)';
    badge.style.color = '#8a6a20';
    badge.style.borderColor = 'rgba(180, 140, 60, 0.40)';
    badge.textContent = '★ Curated';
    titleRow.appendChild(badge);
    info.appendChild(titleRow);

    if (c.description) {
      var desc = document.createElement('div');
      desc.className = 'etude-meta';
      desc.style.fontStyle = 'italic';
      desc.textContent = c.description;
      info.appendChild(desc);
    }

    var meta = document.createElement('div');
    meta.className = 'etude-meta';
    var date = c.updated_at ? new Date(c.updated_at).toLocaleDateString() :
              (c.created_at ? new Date(c.created_at).toLocaleDateString() : '');
    var filename = c.original_filename || '';
    var bits = ['<strong>' + escapeHtml(c.id || '') + '</strong>'];
    if (date) bits.push(date);
    if (filename) bits.push(escapeHtml(filename));
    meta.innerHTML = bits.join(' · ');
    info.appendChild(meta);

    card.appendChild(info);

    var openLink = document.createElement('a');
    openLink.className = 'btn-practice';
    openLink.href = '/practice/?id=' + encodeURIComponent(c.id);
    openLink.textContent = 'Practice';
    card.appendChild(openLink);

    var playLink = document.createElement('a');
    playLink.className = 'btn-play-midi';
    playLink.href = '/practice/?id=' + encodeURIComponent(c.id) + '&play=1';
    playLink.textContent = 'Play MIDI';
    playLink.title = 'Open in Practice and auto-play';
    card.appendChild(playLink);

    if (isAdmin) {
      var delBtn = document.createElement('button');
      delBtn.className = 'btn btn-ghost btn-sm';
      delBtn.type = 'button';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', function () {
        if (!confirm('Delete "' + c.name + '"? This cannot be undone.')) return;
        handleCuratedDelete(c.id, delBtn);
      });
      card.appendChild(delBtn);
    }

    return card;
  }

  function handleCuratedUpload() {
    if (!window.etudesServer || !window.etudesServer.isLoggedIn() ||
        !window.etudesServer.currentUser() ||
        window.etudesServer.currentUser().role !== 'admin') {
      toast('Admin login required to upload.', true);
      return;
    }
    var fileInput = document.getElementById('curated-file');
    var nameInput = document.getElementById('curated-name');
    var descInput = document.getElementById('curated-description');
    var statusEl = document.getElementById('curated-upload-status');
    var files = fileInput.files ? Array.from(fileInput.files) : [];
    if (!files.length) {
      statusEl.textContent = 'Pick at least one .mxl file.';
      return;
    }
    // Display name is optional for batch uploads — the server uses
    // the file's basename when no name is provided. We still warn
    // when a single file is uploaded without a name so the user
    // doesn't accidentally get a generic "head" entry.
    if (files.length === 1 && !nameInput.value.trim()) {
      statusEl.textContent = 'Display name is required for a single upload.';
      nameInput.focus();
      return;
    }
    statusEl.textContent = 'Uploading ' + files.length + ' file' +
      (files.length === 1 ? '' : 's') + '…';
    var fd = new FormData();
    files.forEach(function (f) { fd.append('file', f, f.name); });
    var trimmedName = nameInput.value.trim();
    if (trimmedName) fd.append('name', trimmedName);
    if (descInput.value.trim()) fd.append('description', descInput.value.trim());
    var token = (function () {
      try { return localStorage.getItem('bml_admin_token') || ''; }
      catch (e) { return ''; }
    })();
    fetch('/api/curated-mxl', {
      method: 'POST',
      body: fd,
      headers: token ? { 'Authorization': 'Bearer ' + token } : {},
    }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status));
        return body;
      });
    }).then(function (body) {
      var saved = (body.items || []).length;
      var failed = (body.errors || []).length;
      var parts = ['Saved ' + saved + ' item' + (saved === 1 ? '' : 's')];
      if (failed) parts.push(failed + ' failed');
      if (saved) {
        var first = body.items[0];
        parts.push('(first: ' + first.id + ')');
      }
      statusEl.textContent = parts.join(' · ');
      // Clear the form so a second upload doesn't accidentally re-send
      // the same files.
      fileInput.value = '';
      nameInput.value = '';
      descInput.value = '';
      if (saved) {
        toast('Uploaded ' + saved + ' curated item' + (saved === 1 ? '' : 's') +
              (failed ? ' (' + failed + ' failed)' : ''));
      }
      if (failed) {
        // Surface per-file failures so the admin can fix them and retry.
        var msg = (body.errors || []).map(function (e) {
          return e.filename + ': ' + e.error;
        }).join('\n');
        alert('Some files could not be parsed:\n\n' + msg);
      }
      refreshCuratedList(true);
    }).catch(function (err) {
      statusEl.textContent = 'Upload failed: ' + (err && err.message ? err.message : err);
    });
  }

  function handleCuratedDelete(curatedId, btn) {
    var token = (function () {
      try { return localStorage.getItem('bml_admin_token') || ''; }
      catch (e) { return ''; }
    })();
    if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
    fetch('/api/curated-mxl/' + encodeURIComponent(curatedId), {
      method: 'DELETE',
      headers: token ? { 'Authorization': 'Bearer ' + token } : {},
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (b) { throw new Error((b && b.error) || ('HTTP ' + r.status)); });
      toast('Deleted.');
      refreshCuratedList(true);
    }).catch(function (err) {
      toast('Delete failed: ' + (err && err.message ? err.message : err), true);
      if (btn) { btn.disabled = false; btn.textContent = 'Delete'; }
    });
  }

  function handleCuratedBatchDelete() {
    if (!window.etudesServer || !window.etudesServer.isLoggedIn() ||
        !window.etudesServer.currentUser() ||
        window.etudesServer.currentUser().role !== 'admin') {
      toast('Admin login required.', true);
      return;
    }
    var ids = Array.from(_curatedSelected);
    if (!ids.length) {
      toast('No items selected.', true);
      return;
    }
    if (!confirm('Delete ' + ids.length + ' curated item' +
                 (ids.length === 1 ? '' : 's') + '? This cannot be undone.')) {
      return;
    }
    var btn = document.getElementById('curated-batch-delete');
    if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
    var token = (function () {
      try { return localStorage.getItem('bml_admin_token') || ''; }
      catch (e) { return ''; }
    })();
    fetch('/api/curated-mxl/batch-delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify({ ids: ids }),
    }).then(function (r) {
      return r.json().then(function (b) {
        if (!r.ok) throw new Error((b && b.error) || ('HTTP ' + r.status));
        return b;
      });
    }).then(function (body) {
      var deleted = body.deleted || 0;
      var requested = body.requested || ids.length;
      if (deleted === requested) {
        toast('Deleted ' + deleted + ' item' + (deleted === 1 ? '' : 's') + '.');
      } else {
        toast('Deleted ' + deleted + '/' + requested +
              ' (some ids were already gone).', true);
      }
      _curatedSelected.clear();
      refreshCuratedList(true);
    }).catch(function (err) {
      toast('Batch delete failed: ' + (err && err.message ? err.message : err), true);
      if (btn) { btn.disabled = false; btn.textContent = 'Delete selected'; }
    });
  }

  function makeServerEtudeCard(et) {
    var card = document.createElement('div');
    card.className = 'etude-card';
    card.dataset.id = et.id;

    var info = document.createElement('div');
    info.className = 'etude-info';
    var titleRow = document.createElement('div');
    titleRow.className = 'etude-title-row';
    var name = document.createElement('span');
    name.className = 'etude-name';
    name.textContent = et.name;
    titleRow.appendChild(name);
    var badge = document.createElement('span');
    badge.className = 'etude-source-badge source-' + (et.source || 'composer');
    badge.textContent = et.source === 'random' ? 'random' :
                        et.source === 'master-class' ? 'master class' :
                        et.source === 'pattern' ? 'pattern' : 'composed';
    titleRow.appendChild(badge);
    var cloud = document.createElement('span');
    cloud.className = 'etude-source-badge';
    cloud.style.background = 'rgba(80,120,200,0.10)';
    cloud.style.color = '#1f4080';
    cloud.style.borderColor = 'rgba(80,120,200,0.30)';
    cloud.textContent = '☁ server';
    titleRow.appendChild(cloud);
    info.appendChild(titleRow);

    var meta = document.createElement('div');
    meta.className = 'etude-meta';
    var notes = et.noteCount || 0;
    var date = et.updatedAt ? new Date(et.updatedAt).toLocaleDateString() :
              (et.createdAt ? new Date(et.createdAt).toLocaleDateString() : '');
    meta.innerHTML = '<strong>' + (et.exerciseIds || []).length + '</strong> exercises · ' +
                     '<strong>' + notes + '</strong> notes · ' + (date || '');
    info.appendChild(meta);

    var rename = document.createElement('button');
    rename.className = 'btn btn-ghost btn-sm';
    rename.textContent = 'Rename';
    rename.addEventListener('click', function () {
      var n = prompt('Rename etude:', et.name);
      if (n && n.trim() && n !== et.name) {
        window.etudesServer.renameEtude(et.id, n.trim()).then(refreshServerEtudes);
      }
    });

    var del = document.createElement('button');
    del.className = 'btn btn-danger btn-sm';
    del.textContent = 'Delete';
    del.addEventListener('click', function () {
      if (confirm('Delete "' + et.name + '" from the server?')) {
        window.etudesServer.deleteEtude(et.id).then(refreshServerEtudes);
      }
    });

    var practice = document.createElement('a');
    practice.className = 'btn-practice';
    practice.href = '/practice/?id=' + encodeURIComponent(et.id);
    practice.textContent = 'Practice';

    var playMidi = document.createElement('a');
    playMidi.className = 'btn-play-midi';
    playMidi.href = '/practice/?id=' + encodeURIComponent(et.id) + '&play=1';
    playMidi.textContent = 'Play MIDI';
    playMidi.title = 'Open in Practice and auto-play';

    card.appendChild(info);
    card.appendChild(rename);
    card.appendChild(del);
    card.appendChild(practice);
    card.appendChild(playMidi);
    return card;
  }

  // Non-blocking helper: try to save to the server. Failures are
  // silent (toast) but don't block the local save flow.
  function saveToServer(record) {
    if (!window.etudesServer || !window.etudesServer.isLoggedIn()) return;
    window.etudesServer.saveEtude(record).then(function () {
      // Refresh the server list so the user can see the saved etude.
      if (typeof refreshServerEtudes === 'function') refreshServerEtudes();
    }).catch(function (err) {
      console.error('server save failed', err);
      toast('Server save failed: ' + (err && err.message ? err.message : 'unknown'), true);
    });
  }

  // ---------- Favorites ----------
  // The browse page (app.js) writes the user's starred exercise ids to
  // localStorage['jazz_lex_favorites'] as a JSON-encoded array. The
  // etudes page reads from the same key so the user's favorites show
  // up here too — no migration, no separate store. A
  // "★ Favorites" pseudo-section is prepended to the SECTION dropdowns
  // in both Composer and Generator modes; selecting it filters the
  // exercise list to the starred set. Each row in the composer list
  // has a star toggle (.ex-fav) so the user can add or remove
  // favorites without leaving the etudes page.
  var FAV_SECTION_ID = '__favorites__';
  function getFavorites() {
    try {
      var raw = localStorage.getItem('jazz_lex_favorites');
      if (!raw) return new Set();
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return new Set();
      return new Set(arr.filter(function (x) { return Number.isFinite(x); }));
    } catch (e) {
      return new Set();
    }
  }
  function persistFavorites(favSet) {
    try {
      localStorage.setItem('jazz_lex_favorites', JSON.stringify([...favSet]));
    } catch (e) { /* localStorage unavailable — non-fatal */ }
  }
  function toggleFavorite(id) {
    var fav = getFavorites();
    if (fav.has(id)) fav.delete(id);
    else fav.add(id);
    persistFavorites(fav);
  }
  // After a star is toggled, the dropdown label "(N)" needs to update
  // so the user sees the new count. Cheap: walk both SELECTs and
  // rewrite the option text.
  function refreshFavoritesDropdownText() {
    var favCount = getFavorites().size;
    var label = '★ Favorites (' + favCount + ')';
    ['composer-section', 'random-section'].forEach(function (selId) {
      var sel = document.getElementById(selId);
      if (!sel) return;
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === FAV_SECTION_ID) {
          sel.options[i].textContent = label;
          break;
        }
      }
    });
  }

  // Lazy-load Verovio (11MB) only when the user actually opens the
  // Pattern Library tab and clicks Generate. The script is fetched once
  // and cached on `window.verovio`. Resolves to the toolkit constructor.
  function loadVerovio() {
    if (window.verovio && window.verovio.toolkit) {
      return Promise.resolve(window.verovio);
    }
    if (window.__verovioLoading) return window.__verovioLoading;
    window.__verovioLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'practice/vendor/verovio-toolkit.js';
      s.onload = function () { resolve(window.verovio); };
      s.onerror = function () {
        delete window.__verovioLoading;
        reject(new Error('Failed to load Verovio toolkit'));
      };
      document.head.appendChild(s);
    });
    return window.__verovioLoading;
  }

  function fetchExercises() {
    return fetch('/exercises.json').then(function (r) {
      if (!r.ok) throw new Error('Failed to load exercises.json');
      return r.json();
    }).then(function (data) {
      state.exercises = data.exercises || [];
      state.exercisesBySection = {};
      state.exercises.forEach(function (e) {
        const s = e.section || '';
        if (!state.exercisesBySection[s]) state.exercisesBySection[s] = [];
        state.exercisesBySection[s].push(e);
      });
    });
  }

  // ---------- Mode tabs ----------
  function wireModeTabs() {
    document.querySelectorAll('.mode-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        const mode = tab.dataset.mode;
        document.querySelectorAll('.mode-tab').forEach(function (t) {
          const isActive = t === tab;
          t.classList.toggle('active', isActive);
          t.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        document.querySelectorAll('.mode-pane').forEach(function (p) {
          p.classList.toggle('active', p.id === 'mode-' + mode);
        });
      });
    });
  }

  // ---------- Composer mode ----------
  function populateComposerSection() {
    const sel = document.getElementById('composer-section');
    sel.innerHTML = '';
    // Favorites pseudo-section at the top — prepended so the user
    // always sees their starred set as a first-class option. Count
    // comes from localStorage (same key the browse page writes to).
    var favCount = getFavorites().size;
    var favOpt = document.createElement('option');
    favOpt.value = FAV_SECTION_ID;
    favOpt.textContent = '★ Favorites (' + favCount + ')';
    sel.appendChild(favOpt);
    var realKeys = Object.keys(state.exercisesBySection).sort();
    realKeys.forEach(function (sec) {
      const exs = state.exercisesBySection[sec];
      const name = exs[0].section_name || sec;
      const opt = document.createElement('option');
      opt.value = sec;
      opt.textContent = sec + ' · ' + name + ' (' + exs.length + ')';
      sel.appendChild(opt);
    });
    // Default: select the first real section (skip Favorites on first
    // load — the user hasn't asked to see favorites yet). If the
    // user has already chosen a section, restore that choice.
    if (!state.composer.section) {
      sel.value = realKeys[0] || FAV_SECTION_ID;
      state.composer.section = sel.value;
    } else {
      sel.value = state.composer.section;
    }
  }

  function renderComposer() {
    const list = document.getElementById('composer-exercises');
    list.innerHTML = '';
    const sec = state.composer.section;
    // Favorites pseudo-section: the source pool is the user's
    // starred exercises (from localStorage) instead of a fixed
    // section. Empty when the user hasn't starred anything yet —
    // show a "no favorites" hint instead of an empty list.
    let all;
    if (sec === FAV_SECTION_ID) {
      const fav = getFavorites();
      all = state.exercises.filter(function (e) { return fav.has(e.id); });
    } else {
      all = state.exercisesBySection[sec] || [];
    }
    const filter = state.composer.filter.toLowerCase();
    const filtered = filter
      ? all.filter(function (e) {
          return (e.title || '').toLowerCase().indexOf(filter) >= 0 ||
                 String(e.id).indexOf(filter) >= 0;
        })
      : all;
    const selectedIds = {};
    state.composer.selected.forEach(function (s) { selectedIds[s.id] = s; });

    // Selected rows are no longer prepended here — they live in the
    // pinned composer-selected panel so they remain visible regardless of
    // the current section or filter.
    const rows = filtered;

    // Summary line — shows the current pool size + filter result. In
    // the Favorites section, show "X favorited of 407 total" so the
    // user knows the absolute count.
    if (sec === FAV_SECTION_ID) {
      document.getElementById('composer-list-summary').textContent =
        filtered.length + ' of ' + all.length + ' favorited' +
        (filtered.length !== all.length ? ' (filtered)' : '');
    } else {
      document.getElementById('composer-list-summary').textContent =
        filtered.length + ' of ' + all.length + ' in this section';
    }

    // Empty state — different message for the Favorites section
    // (point the user to the browse page to star exercises) vs an
    // empty section (e.g. a section with no exercises, which
    // shouldn't happen but guard anyway).
    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'composer-list-empty muted';
      if (sec === FAV_SECTION_ID) {
        empty.innerHTML = 'No favorites yet — star exercises on the <a href="./">Browse</a> page, ' +
          'or click the ☆ next to any exercise here to add it.';
      } else if (filter) {
        empty.textContent = 'No exercises match "' + filter + '".';
      } else {
        empty.textContent = 'No exercises in this section.';
      }
      list.appendChild(empty);
      renderSelectedPanel();
      updateComposerCount();
      return;
    }

    const favSet = getFavorites();

    rows.forEach(function (entry) {
      const isSelected = entry.id in selectedIds;
      const transposeVal = isSelected ? (selectedIds[entry.id].semitones || 0) : 0;
      const ex = state.exercises.filter(function (e) { return e.id === entry.id; })[0] || entry;
      const isFav = favSet.has(ex.id);

      const row = document.createElement('div');
      row.className = 'composer-ex-row' + (isSelected ? ' selected' : '');
      row.dataset.id = ex.id;

      const handle = document.createElement('span');
      handle.className = 'drag-handle';
      handle.textContent = isSelected ? '≡' : '';
      handle.draggable = isSelected;
      handle.title = isSelected ? 'Drag to reorder' : '';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = isSelected;
      checkbox.addEventListener('change', function () {
        toggleSelect(ex.id);
      });

      const idCell = document.createElement('span');
      idCell.className = 'ex-id';
      idCell.textContent = '#' + ex.id;

      const titleCell = document.createElement('span');
      titleCell.className = 'ex-title';
      titleCell.textContent = ex.title || '';

      // Star button — toggles this exercise in/out of the user's
      // favorites (localStorage 'jazz_lex_favorites', same key the
      // browse page writes to). The filled ★ marks a starred
      // exercise; the empty ☆ marks an unstarred one. When the
      // current section is "Favorites", toggling off here will
      // remove the row from the list (handled by re-rendering
      // below). The button stops click propagation so clicking
      // the star doesn't also trigger the row's other handlers.
      const starBtn = document.createElement('button');
      starBtn.className = 'ex-fav' + (isFav ? ' favorited' : '');
      starBtn.type = 'button';
      starBtn.textContent = isFav ? '★' : '☆';
      starBtn.title = isFav ? 'Remove from favorites' : 'Add to favorites';
      starBtn.setAttribute('aria-label', starBtn.title);
      starBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleFavorite(ex.id);
        refreshFavoritesDropdownText();
        renderComposer();
      });

      const transposeInput = document.createElement('input');
      transposeInput.type = 'number';
      transposeInput.min = -12;
      transposeInput.max = 12;
      transposeInput.step = 1;
      transposeInput.value = transposeVal;
      transposeInput.className = 'ex-transpose';
      transposeInput.title = 'Transpose semitones (-12..+12)';
      transposeInput.disabled = !isSelected;
      transposeInput.addEventListener('input', function () {
        updateTranspose(ex.id, parseInt(transposeInput.value, 10) || 0);
      });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'ex-remove';
      removeBtn.textContent = '×';
      removeBtn.title = 'Remove from etude';
      removeBtn.style.visibility = isSelected ? 'visible' : 'hidden';
      removeBtn.addEventListener('click', function () {
        toggleSelect(ex.id);
      });

      row.appendChild(handle);
      row.appendChild(checkbox);
      row.appendChild(idCell);
      row.appendChild(titleCell);
      row.appendChild(starBtn);
      row.appendChild(transposeInput);
      row.appendChild(removeBtn);
      list.appendChild(row);
    });

    renderSelectedPanel();
    updateComposerCount();
  }

  // Render the pinned selection panel (above the section picker, always
  // visible). Shows the current selection in order, with up/down reorder
  // buttons and per-row transpose inputs.
  function renderSelectedPanel() {
    const panel = document.getElementById('composer-selected');
    if (!panel) return;
    panel.innerHTML = '';
    if (!state.composer.selected.length) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = 'block';
    state.composer.selected.forEach(function (sel, idx) {
      const ex = state.exercises.find(function (e) { return e.id === sel.id; });
      const section = ex ? ex.section : '?';
      const title = ex ? ex.title : 'Unknown exercise';
      const row = document.createElement('div');
      row.className = 'selected-panel-row';
      row.dataset.id = sel.id;
      // Up / down reorder buttons (also drag the row to reorder)
      const upBtn = document.createElement('button');
      upBtn.className = 'selected-reorder';
      upBtn.textContent = '↑';
      upBtn.title = 'Move up';
      upBtn.disabled = idx === 0;
      upBtn.addEventListener('click', function () { moveSelected(sel.id, sel.id /* placeholder */, idx - 1); });
      const downBtn = document.createElement('button');
      downBtn.className = 'selected-reorder';
      downBtn.textContent = '↓';
      downBtn.title = 'Move down';
      downBtn.disabled = idx === state.composer.selected.length - 1;
      downBtn.addEventListener('click', function () { moveSelected(sel.id, sel.id, idx + 1); });
      row.appendChild(upBtn);
      row.appendChild(downBtn);
      const idCell = document.createElement('span');
      idCell.className = 'selected-id';
      idCell.textContent = '#' + sel.id;
      row.appendChild(idCell);
      const sectionBadge = document.createElement('span');
      sectionBadge.className = 'selected-section';
      sectionBadge.textContent = '§' + section;
      row.appendChild(sectionBadge);
      const titleCell = document.createElement('span');
      titleCell.className = 'selected-title';
      titleCell.textContent = title;
      row.appendChild(titleCell);
      const transposeInput = document.createElement('input');
      transposeInput.type = 'number';
      transposeInput.min = -12;
      transposeInput.max = 12;
      transposeInput.step = 1;
      transposeInput.value = sel.semitones || 0;
      transposeInput.className = 'ex-transpose';
      transposeInput.title = 'Transpose semitones (-12..+12)';
      transposeInput.addEventListener('input', function () {
        updateTranspose(sel.id, parseInt(transposeInput.value, 10) || 0);
      });
      row.appendChild(transposeInput);
      const removeBtn = document.createElement('button');
      removeBtn.className = 'ex-remove';
      removeBtn.textContent = '×';
      removeBtn.title = 'Remove from etude';
      removeBtn.addEventListener('click', function () { toggleSelect(sel.id); });
      row.appendChild(removeBtn);
      // Drag handle on the row itself
      row.draggable = true;
      row.addEventListener('dragstart', function (e) {
        e.dataTransfer.setData('text/plain', String(sel.id));
        e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragover', function (e) {
        if (!e.dataTransfer.types.includes('text/plain')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });
      row.addEventListener('drop', function (e) {
        e.preventDefault();
        const srcId = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (!srcId || srcId === sel.id) return;
        const targetIdx = state.composer.selected.findIndex(function (s) { return s.id === sel.id; });
        moveSelected(srcId, sel.id, targetIdx);
      });
      panel.appendChild(row);
    });
  }

  function toggleSelect(id) {
    const idx = state.composer.selected.findIndex(function (s) { return s.id === id; });
    if (idx >= 0) state.composer.selected.splice(idx, 1);
    else state.composer.selected.push({ id: id, semitones: 0 });
    renderComposer();
  }

  function updateTranspose(id, semitones) {
    const sel = state.composer.selected.find(function (s) { return s.id === id; });
    if (sel) sel.semitones = Math.max(-12, Math.min(12, semitones));
  }

  // Move srcId to the given targetIdx in the selected list.
  // targetIdx is clamped to [0, length-1].
  function moveSelected(srcId, _unused, targetIdx) {
    const srcIdx = state.composer.selected.findIndex(function (s) { return s.id === srcId; });
    if (srcIdx < 0) return;
    const [moved] = state.composer.selected.splice(srcIdx, 1);
    const len = state.composer.selected.length;  // after splice
    const clamped = Math.max(0, Math.min(len, targetIdx));
    state.composer.selected.splice(clamped, 0, moved);
    renderComposer();
  }

  function updateComposerCount() {
    document.getElementById('composer-count').textContent =
      state.composer.selected.length + ' exercises selected';
    const genBtn = document.getElementById('composer-generate');
    genBtn.disabled = state.composer.selected.length < 2 || state.composer.selected.length > 12;
  }

  function wireComposerControls() {
    document.getElementById('composer-section').addEventListener('change', function (e) {
      state.composer.section = e.target.value;
      state.composer.filter = '';
      document.getElementById('composer-search').value = '';
      renderComposer();
    });
    document.getElementById('composer-search').addEventListener('input', function (e) {
      state.composer.filter = e.target.value;
      renderComposer();
    });
    document.getElementById('composer-clear').addEventListener('click', function () {
      state.composer.selected = [];
      renderComposer();
    });
    document.getElementById('composer-shuffle').addEventListener('click', function () {
      // Fisher-Yates
      const a = state.composer.selected;
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      renderComposer();
    });
    document.getElementById('composer-generate').addEventListener('click', function () {
      generateComposerPreview();
    });
  }

  // Composer mode preview: stitches the currently selected exercises
  // and shows the rendered SVG plus Save / Re-roll actions. Same lazy-
  // loaded Verovio toolkit as the Random / Pattern previews.
  function generateComposerPreview() {
    var box = document.getElementById('composer-preview');
    if (!box) return;
    if (state.composer.selected.length < 2) {
      toast('Pick at least 2 exercises to preview.', true);
      return;
    }
    if (state.composer.selected.length > 12) {
      toast('Max 12 exercises per etude.', true);
      return;
    }
    var namePreset = (document.getElementById('composer-name').value || '')
      .trim() || ('Composer: ' + state.composer.selected.length + ' exercises');
    var picked = state.composer.selected.slice();
    box.innerHTML = '';
    box.classList.add('visible');
    var h = document.createElement('h4');
    h.textContent = 'Preview · ' + namePreset +
      ' (' + picked.length + ' exercises)';
    box.appendChild(h);

    // Inline preview wrapper
    var previewWrap = document.createElement('div');
    previewWrap.className = 'pattern-preview-svg';
    var loadingText = document.createElement('p');
    loadingText.className = 'muted';
    loadingText.textContent = 'Stitching score…';
    previewWrap.appendChild(loadingText);
    box.appendChild(previewWrap);

    // Stitch then render
    window.etudesStitch.stitch(
      picked.map(function (p) { return { id: p.id, semitones: p.semitones || 0 }; }),
      namePreset
    ).then(function (xml) {
      // Clamp the stitched score to the user's saved instrument range.
      var r = getEtudesRange();
      var clamped = window.etudesStitch.clampToRange(xml, r.lowMidi, r.highMidi);
      renderSvgForXml(previewWrap, clamped.xml);
      state.composer.lastXml = clamped.xml;
      state.composer.lastName = namePreset;
      if (clamped.moved > 0) {
        toast('Shifted ' + clamped.moved + ' note(s) into your instrument range.');
      }
    }).catch(function (e) {
      previewWrap.innerHTML = '<p class="muted">Stitch failed: ' +
        (e && e.message ? e.message : e) + '</p>';
    });

    // Actions: Save / Re-roll
    var actions = document.createElement('div');
    actions.className = 'preview-actions';
    var nameInput = document.createElement('input');
    nameInput.className = 'input';
    nameInput.placeholder = 'Etude name';
    nameInput.value = namePreset;
    nameInput.addEventListener('input', function () {
      state.composer.lastName = nameInput.value;
    });
    actions.appendChild(nameInput);

    var saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = 'Save & open Practice';
    saveBtn.addEventListener('click', function () {
      saveComposerEtude(nameInput.value || namePreset);
    });
    actions.appendChild(saveBtn);

    var regenBtn = document.createElement('button');
    regenBtn.className = 'btn btn-ghost';
    regenBtn.textContent = 'Re-stitch';
    regenBtn.title = 'Re-stitch with the current exercise list (transpose changes applied)';
    regenBtn.addEventListener('click', function () {
      generateComposerPreview();
    });
    actions.appendChild(regenBtn);

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-ghost';
    cancelBtn.textContent = 'Discard';
    cancelBtn.addEventListener('click', function () {
      box.classList.remove('visible');
      box.innerHTML = '';
      state.composer.lastXml = null;
    });
    actions.appendChild(cancelBtn);

    box.appendChild(actions);
  }

  // Actually save the composer's last previewed XML as an IndexedDB etude.
  async function saveComposerEtude(name) {
    var xml = state.composer.lastXml;
    if (!xml) {
      toast('Click Generate preview first.', true);
      return;
    }
    name = (name || '').trim() || ('Composer: ' + (state.composer.selected.length || 0) + ' exercises');
    name = await uniquifyEtudeName(name);
    // Count notes for the metadata (cheap; just regex the XML string).
    var noteCount = (xml.match(/<note\b/g) || []).length;
    var parts = state.composer.selected.map(function (p) {
      return { id: p.id, semitones: p.semitones || 0 };
    });
    var id = window.etudesStore.newId();
    var composerRecord = {
      id: id,
      name: name,
      exerciseIds: parts.map(function (p) { return p.id; }),
      semitones: parts.map(function (p) { return p.semitones; }),
      mode: 'composer',
      source: 'composer',
      musicxml: xml,
      noteCount: noteCount,
    };
    try {
      await window.etudesStore.saveEtude(composerRecord);
      saveToServer(composerRecord);
    } catch (e) {
      toast('Save failed: ' + e.message, true);
      return;
    }
    toast('Saved "' + name + '" — opening Practice…');
    setTimeout(function () {
      window.location.href = '/practice/?id=' + encodeURIComponent(id);
    }, 600);
  }

  // ---------- Random mode ----------
  function populateRandomSection() {
    const sel = document.getElementById('random-section');
    sel.innerHTML = '';
    // Favorites pseudo-section at the top (same logic as the
    // Composer dropdown). When selected, the random picker draws
    // from the user's starred exercises instead of a fixed
    // section.
    var favCount = getFavorites().size;
    var favOpt = document.createElement('option');
    favOpt.value = FAV_SECTION_ID;
    favOpt.textContent = '★ Favorites (' + favCount + ')';
    sel.appendChild(favOpt);
    Object.keys(state.exercisesBySection).sort().forEach(function (sec) {
      const exs = state.exercisesBySection[sec];
      const name = exs[0].section_name || sec;
      const opt = document.createElement('option');
      opt.value = sec;
      opt.textContent = sec + ' · ' + name + ' (' + exs.length + ')';
      sel.appendChild(opt);
    });
  }

  function wireRandomControls() {
    document.getElementById('random-generate').addEventListener('click', generateRandomPreview);
  }

  // Pull the user's union-of-all-instruments range from localStorage.
  // If the user has set a per-instrument range on any instrument, we
  // take the minimum lowMidi and maximum highMidi across all stored
  // instruments — this way the etudes page respects whatever the user
  // has configured without asking them to pick an instrument here.
  // Fall back to a sensible alto-sax default if nothing is stored.
  function getEtudesRange() {
    var all = null;
    try {
      var raw = localStorage.getItem('jazz_lex_ranges');
      if (raw) all = JSON.parse(raw);
    } catch (e) { /* localStorage unavailable */ }
    if (all && typeof all === 'object' && Object.keys(all).length) {
      var lo = Infinity, hi = -Infinity;
      Object.keys(all).forEach(function (k) {
        var r = all[k];
        if (r && typeof r.lowMidi === 'number' && typeof r.highMidi === 'number') {
          if (r.lowMidi < lo) lo = r.lowMidi;
          if (r.highMidi > hi) hi = r.highMidi;
        }
      });
      if (lo < Infinity && hi > -Infinity && hi >= lo) {
        return { lowMidi: lo, highMidi: hi };
      }
    }
    // Fall back: if the user has touched a single range (jazz_lex_range
    // legacy key), use it; otherwise alto-sax default (Ab2..E5).
    try {
      var legacy = localStorage.getItem('jazz_lex_range');
      if (legacy) {
        var parsed = JSON.parse(legacy);
        if (parsed && typeof parsed.lowMidi === 'number') return parsed;
      }
    } catch (e) {}
    return { lowMidi: 56, highMidi: 76 }; // Ab2..E5 default
  }

  function generateRandomPreview(isReroll) {
    const section = document.getElementById('random-section').value;
    // Mirror the dropdown into state so renderRandomPreview() (called
    // for both initial generation and re-roll) can read the current
    // section without re-querying the DOM. This also makes the bug-
    // fix below (`section_X × N exercises`) actually carry the right
    // section id — previously the name always showed "?" because no
    // code path was writing to state.random.section.
    state.random.section = section;
    const count = parseInt(document.getElementById('random-count').value, 10);
    const spread = parseInt(document.getElementById('random-spread').value, 10);
    // Favorites pseudo-section: the random pool is the user's starred
    // exercises, not a fixed section. Falls through to the same
    // dedupe + spread logic below.
    let pool;
    if (section === FAV_SECTION_ID) {
      const fav = getFavorites();
      pool = state.exercises.filter(function (e) { return fav.has(e.id); });
    } else {
      pool = state.exercisesBySection[section] || [];
    }
    if (pool.length === 0) {
      toast(section === FAV_SECTION_ID
        ? 'No favorites yet — star exercises on the Browse page first.'
        : 'This section has no exercises.', true);
      return;
    }
    if (pool.length < count) {
      toast('Section only has ' + pool.length + ' exercises — pick fewer or another section.', true);
      return;
    }
    // New pick means: new random sample, drop the cached stitch, reset
    // the typed-name tracker so the user sees a fresh auto-name.
    state.random.stitchedXml = null;
    state.random.wasReroll = !!isReroll;
    // If this is a fresh pick (not a re-roll), clear the typed-name so
    // the new etude starts with a fresh auto-name. (On re-rolls the
    // typed name carries over so the user can keep iterating.)
    if (!isReroll) state.random.typedName = null;
    // Pick `count` unique random exercises from the pool.
    const indices = [];
    while (indices.length < count) {
      const r = Math.floor(Math.random() * pool.length);
      if (indices.indexOf(r) < 0) indices.push(r);
    }
    const picked = indices.map(function (i) {
      const ex = pool[i];
      const semitones = spread === 0 ? 0 : Math.round((Math.random() * 2 - 1) * spread);
      return { id: ex.id, semitones: semitones };
    });
    state.random.lastPreview = picked;
    renderRandomPreview();
  }

  function renderRandomPreview() {
    const box = document.getElementById('random-preview');
    const picked = state.random.lastPreview;
    if (!picked || !picked.length) {
      box.classList.remove('visible');
      return;
    }
    box.classList.add('visible');
    box.innerHTML = '';
    const h = document.createElement('h4');
    h.textContent = 'Preview (' + picked.length + ' exercises)';
    box.appendChild(h);

    const list = document.createElement('ol');
    picked.forEach(function (p) {
      const ex = state.exercises.filter(function (e) { return e.id === p.id; })[0];
      const li = document.createElement('li');
      const t = (ex && ex.title) || ('Exercise ' + p.id);
      const s = (p.semitones === 0 ? '' : (p.semitones > 0 ? ' +' : ' ') + p.semitones + ' semitones');
      li.textContent = '#' + p.id + ' — ' + t + s;
      list.appendChild(li);
    });
    box.appendChild(list);

    // Inline Verovio preview so the user sees the stitched score before
    // saving. Reuses loadVerovio (lazy-loaded once). The stitched
    // MusicXML is cached on state.random.lastXml so re-rolls don't
    // re-stitch.
    var previewWrap = document.createElement('div');
    previewWrap.className = 'pattern-preview-svg';
    var loadingText = document.createElement('p');
    loadingText.className = 'muted';
    loadingText.textContent = 'Stitching score…';
    previewWrap.appendChild(loadingText);
    box.appendChild(previewWrap);

    // Generated etude names always start with "section_<id>" so the
    // setlist view is greppable / sortable by source. We dropped the
    // "Random: §…" prefix and the § symbol (which didn't render in
    // the chosen font) — "section_1A × 8 exercises" reads cleanly.
    // state.random.section is now mirrored from the dropdown in
    // generateRandomPreview() so the placeholder never falls back to "?".
    var namePreset = 'section_' + (state.random.section || '?') +
      ' × ' + picked.length + ' exercises';
    var pickedSnapshot = picked.slice();
    (function stitchThenRender() {
      // Memoize the stitch so re-rolls just re-render the SVG.
      if (!state.random.stitchedXml) {
        window.etudesStitch.stitch(
          pickedSnapshot.map(function(p){return {id: p.id, semitones: p.semitones};}),
          namePreset
        ).then(function(xml) {
          // Clamp to the user's saved instrument range before rendering.
          var r = getEtudesRange();
          var clamped = window.etudesStitch.clampToRange(xml, r.lowMidi, r.highMidi);
          state.random.stitchedXml = clamped.xml;
          renderSvgForXml(previewWrap, clamped.xml);
          if (clamped.moved > 0) {
            toast('Shifted ' + clamped.moved + ' note(s) into your instrument range.');
          }
        }).catch(function(e) {
          previewWrap.innerHTML = '<p class="muted">Stitch failed: ' +
            (e && e.message ? e.message : e) + '</p>';
        });
      } else {
        renderSvgForXml(previewWrap, state.random.stitchedXml);
      }
    })();

    const actions = document.createElement('div');
    actions.className = 'preview-actions';
    const nameInput = document.createElement('input');
    nameInput.className = 'input';
    nameInput.placeholder = 'Name this etude (e.g. Random chromatic sketch)';
    nameInput.value = namePreset;
    // Preserve typed name across re-rolls.
    if (state.random.typedName) {
      nameInput.value = state.random.typedName;
    } else {
      state.random.typedName = namePreset;
    }
    nameInput.addEventListener('input', function() {
      state.random.typedName = nameInput.value;
    });
    actions.appendChild(nameInput);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', function () {
      generateAndSave('random', nameInput.value || ('Random ' + new Date().toLocaleString()));
    });
    actions.appendChild(saveBtn);

    const regenBtn = document.createElement('button');
    regenBtn.className = 'btn btn-ghost';
    regenBtn.textContent = 'Re-roll';
    regenBtn.addEventListener('click', function () {
      // New random roll — drop the cached stitch so we get a different score.
      state.random.stitchedXml = null;
      state.random.wasReroll = true;
      generateRandomPreview();
    });
    actions.appendChild(regenBtn);

    box.appendChild(actions);
  }

  // Render a MusicXML document into the wrapper element using Verovio.
  // Wrapper is cleared and replaced with the SVG (or an error message).
  function renderSvgForXml(wrap, xml) {
    loadVerovio().then(function (v) {
      try {
        var tk = new v.toolkit();
        tk.setOptions({
          scale: 28,
          // Respect only explicit <print new-system="yes"/> marks (the
          // etudes-stitch inserts these at every segment boundary, and
          // server.py insert_line_breaks adds them every 4 measures
          // within each source). Per the project rule: a system break
          // may only fall at a barline, never halfway through a measure.
          breaks: 'encoded',
          adjustPageHeight: true,
          justifyVertically: false,
          spacingSystem: 4,
          spacingStaff: 2,
          pageWidth: 1100,
          pageHeight: 600,
        });
        tk.loadData(xml);
        var svg = tk.renderToSVG(1, {});
        wrap.innerHTML = svg;
      } catch (e) {
        wrap.innerHTML = '<p class="muted">Could not render preview: ' +
          (e && e.message ? e.message : e) + '</p>';
      }
    }).catch(function () {
      wrap.innerHTML = '<p class="muted">Could not load notation engine.</p>';
    });
  }

  // ---------- Master Class mode ----------
  // Renders the 6 pre-built pedagogical etudes from
  // window.masterClassEtudes.list. Each line is a clickable button:
  // click → build MusicXML in-browser via etudesStitch.buildMasterClassEtude
  // → save to IndexedDB (source='master-class') → navigate to
  // /practice/?id=etude_xxx. No server roundtrip, no /api/musicxml fetch.
  //
  // Renders eagerly on init (no /exercises.json dependency), so the
  // tab is interactive as soon as the user clicks the Master Class tab.
  function renderMasterClass() {
    const list = document.getElementById('master-class-list');
    if (!list) return;
    if (!window.masterClassEtudes || !window.masterClassEtudes.list) {
      list.innerHTML = '<p class="muted">Master Class curriculum not loaded.</p>';
      return;
    }
    list.innerHTML = '';
    const etudes = window.masterClassEtudes.list;

    etudes.forEach(function (etude) {
      const card = document.createElement('div');
      card.className = 'mc-card';

      const header = document.createElement('div');
      header.className = 'mc-header';
      const title = document.createElement('h3');
      title.className = 'mc-title';
      title.textContent = etude.title;
      header.appendChild(title);
      const meta = document.createElement('div');
      meta.className = 'mc-meta';
      const mcBadge = document.createElement('span');
      mcBadge.className = 'mc-mc-badge';
      mcBadge.textContent = 'MC ' + etude.mc;
      meta.appendChild(mcBadge);
      const tempoBadge = document.createElement('span');
      tempoBadge.className = 'mc-tempo-badge';
      tempoBadge.textContent = '♩ = ' + etude.bpm;
      meta.appendChild(tempoBadge);
      const sigBadge = document.createElement('span');
      sigBadge.className = 'mc-sig-badge';
      sigBadge.textContent = etude.timeSig;
      meta.appendChild(sigBadge);
      header.appendChild(meta);
      card.appendChild(header);

      const subtitle = document.createElement('p');
      subtitle.className = 'mc-subtitle';
      subtitle.textContent = etude.subtitle;
      card.appendChild(subtitle);

      const concept = document.createElement('p');
      concept.className = 'mc-concept';
      concept.textContent = etude.concept;
      card.appendChild(concept);

      const linesWrap = document.createElement('div');
      linesWrap.className = 'mc-lines';
      etude.lines.forEach(function (line) {
        const btn = document.createElement('button');
        btn.className = 'btn mc-line-btn';
        const name = document.createElement('div');
        name.className = 'mc-line-name';
        name.textContent = line.name;
        btn.appendChild(name);
        if (line.description) {
          const desc = document.createElement('div');
          desc.className = 'mc-line-desc';
          desc.textContent = line.description;
          btn.appendChild(desc);
        }
        btn.addEventListener('click', function () {
          previewMasterClassEtude(etude, line);
        });
        linesWrap.appendChild(btn);
      });
      card.appendChild(linesWrap);

      list.appendChild(card);
    });
  }

  // Show a preview of a Master Class etude line before saving. v36:
  // the user wants to see the first 8 bars of notation + a range
  // check against their saved instrument range, and only then
  // commit to save + navigate. This avoids the surprise of
  // discovering an out-of-range note 30 seconds into a practice
  // session. The preview renders the first 8 bars via Verovio (the
  // same lazy loader as the composer mode) and shows a green or
  // red range badge depending on whether every pitched note lands
  // within [userLow, userHigh]. If out-of-range, an action button
  // offers a one-click "auto-transpose" path (uses clampToRange
  // which shifts notes by whole octaves) plus the original
  // "save as-is" path.
  //
  // v37: added "Fix Enharmonics" button. The current XML is held in
  // mutable closures (currentFullXml / currentPreviewXml /
  // currentReport) so the "Fix" button can rewrite the XML, re-render
  // the SVG, and re-run the range check — and the action buttons
  // always read the latest state. Mirrors music21's
  // Pitch.simplifyEnharmonic (E#→F, B#→C, Fb→E, Cb→B, etc.).
  function previewMasterClassEtude(etude, line) {
    var box = document.getElementById('master-class-preview');
    if (!box) return;
    if (!window.etudesStitch || !window.etudesStitch.buildEtudePreviewXML) {
      toast('Master Class builder unavailable.', true);
      return;
    }
    var currentFullXml, currentPreviewXml;
    try {
      currentFullXml = window.etudesStitch.buildMasterClassEtude(etude, line);
      currentPreviewXml = window.etudesStitch.buildEtudePreviewXML(etude, line, 8);
    } catch (e) {
      console.error('buildMasterClassEtude failed', e);
      toast('Build failed: ' + (e && e.message ? e.message : e), true);
      return;
    }

    // Range check against the user's saved instrument range.
    var rangeUsed = null;
    var currentReport = null;
    // v38: also validate against the Master Class canonical range
    // (E3..C6 by default — broader than any single instrument,
    // acts as a curriculum data-integrity check). Both badges
    // show in the preview header; both warnings show in the
    // warning panel.
    var canonicalRange = (window.etudesStitch && window.etudesStitch.MC_CANONICAL_RANGE)
      ? window.etudesStitch.MC_CANONICAL_RANGE
      : { lowMidi: 52, highMidi: 84 };
    var currentCanonicalReport = null;
    try {
      rangeUsed = getEtudesRange();
      if (window.etudesStitch.validateEtudeNotes) {
        currentReport = window.etudesStitch.validateEtudeNotes(
          currentFullXml, rangeUsed.lowMidi, rangeUsed.highMidi
        );
        currentCanonicalReport = window.etudesStitch.validateEtudeNotes(
          currentFullXml, canonicalRange.lowMidi, canonicalRange.highMidi
        );
      }
    } catch (e) {
      console.warn('range check failed (continuing):', e);
    }

    // Render the preview pane.
    box.innerHTML = '';
    box.classList.add('visible');

    var header = document.createElement('div');
    header.className = 'mc-preview-header';
    var title = document.createElement('div');
    title.className = 'mc-preview-title';
    title.textContent = etude.title + ' — ' + line.name;
    header.appendChild(title);
    var meta = document.createElement('div');
    meta.className = 'mc-preview-meta';
    meta.innerHTML = '<strong>Preview</strong> · first 8 bars · ♩ = ' + etude.bpm;
    header.appendChild(meta);
    // Two range badges in the header:
    //   1. User range: "in range" / "X outside range" against the
    //      saved instrument range (alto default Ab2..E5)
    //   2. Canonical range: "E3–C6 ✓" / "E3–C6 ⚠ N" against the
    //      Master Class canonical range (E3..C6 by default). The
    //      canonical range is broader than any single instrument —
    //      it acts as a curriculum data-integrity check: if a note
    //      falls outside E3..C6, the etude is either too extreme
    //      to be a sensible practice exercise, or there's a
    //      transcription error in the curriculum data.
    var badge = document.createElement('span');
    header.appendChild(badge);
    var canonicalBadge = document.createElement('span');
    header.appendChild(canonicalBadge);
    function paintBadge(report) {
      if (!report) { badge.textContent = ''; badge.className = ''; return; }
      if (report.ok) {
        badge.className = 'mc-range-badge range-ok';
        badge.textContent = '✓ in range';
        badge.title = 'Every note fits within your instrument range (' +
                       midiToNoteName(rangeUsed.lowMidi) + '–' +
                       midiToNoteName(rangeUsed.highMidi) + ').';
      } else {
        badge.className = 'mc-range-badge range-bad';
        badge.textContent = '⚠ ' + report.outOfRange.length + ' outside range';
        badge.title = 'Some notes fall outside your instrument range (' +
                       midiToNoteName(rangeUsed.lowMidi) + '–' +
                       midiToNoteName(rangeUsed.highMidi) + ').';
      }
    }
    function paintCanonicalBadge(report) {
      if (!report) { canonicalBadge.textContent = ''; canonicalBadge.className = ''; return; }
      var lo = midiToNoteName(canonicalRange.lowMidi);
      var hi = midiToNoteName(canonicalRange.highMidi);
      if (report.ok) {
        canonicalBadge.className = 'mc-range-badge range-ok canonical';
        canonicalBadge.textContent = lo + '–' + hi + ' ✓';
        canonicalBadge.title = 'Every note lands within the Master Class canonical range ' +
                               '(' + lo + '–' + hi + ').';
      } else {
        canonicalBadge.className = 'mc-range-badge range-bad canonical';
        canonicalBadge.textContent = lo + '–' + hi + ' ⚠ ' + report.outOfRange.length;
        canonicalBadge.title = report.outOfRange.length + ' note(s) fall outside the Master Class ' +
                               'canonical range (' + lo + '–' + hi + '). This usually means the ' +
                               'curriculum data has a transcription error — please report it.';
      }
    }
    paintBadge(currentReport);
    paintCanonicalBadge(currentCanonicalReport);
    box.appendChild(header);

    // Range warning panel (only when there are out-of-range notes).
    // Re-rendered when the XML changes so the offending-note list
    // reflects the latest state. Wrapped in a container so we can
    // tear it down + rebuild on each update.
    var warnContainer = document.createElement('div');
    warnContainer.className = 'mc-preview-warn-container';
    box.appendChild(warnContainer);
    function paintWarnPanel() {
      warnContainer.innerHTML = '';
      // User-range violations (existing behaviour).
      if (currentReport && !currentReport.ok && currentReport.outOfRange.length) {
        var warn = document.createElement('div');
        warn.className = 'mc-range-warning';
        var warnMsg = document.createElement('div');
        warnMsg.innerHTML = '<strong>Out of your instrument range:</strong> ' +
          currentReport.outOfRange.length + ' note(s) fall outside your saved ' +
          'instrument range. Use <em>Auto-transpose</em> to shift them ' +
          'by whole octaves, or <em>Save as-is</em> to keep the original ' +
          'pitches (useful for studying extreme registers).';
        warn.appendChild(warnMsg);
        var list = document.createElement('ul');
        for (var i = 0; i < currentReport.outOfRange.length; i++) {
          var v = currentReport.outOfRange[i];
          var p = v.pitch;
          var step = p.step;
          if (p.alter === 1) step += '#';
          else if (p.alter === -1) step += 'b';
          var li = document.createElement('li');
          li.textContent = 'bar ' + (v.measureIndex + 1) + ', ' + step + p.octave +
                           ' (MIDI ' + v.midi + ', range ' +
                           midiToNoteName(v.low) + '–' + midiToNoteName(v.high) + ')';
          list.appendChild(li);
        }
        warn.appendChild(list);
        warnContainer.appendChild(warn);
      }
      // Canonical-range violations (v38). Different severity from
      // the user range — the canonical range represents the
      // curriculum's intended register, so a violation is more
      // likely a data error than a user preference. Shown in a
      // second warning panel with a slightly different visual
      // (canonical-warning class — see etudes.css).
      if (currentCanonicalReport && !currentCanonicalReport.ok && currentCanonicalReport.outOfRange.length) {
        var cwarn = document.createElement('div');
        cwarn.className = 'mc-range-warning canonical-warning';
        var cwarnMsg = document.createElement('div');
        cwarnMsg.innerHTML = '<strong>Outside the Master Class canonical range (' +
          midiToNoteName(canonicalRange.lowMidi) + '–' +
          midiToNoteName(canonicalRange.highMidi) + '):</strong> ' +
          currentCanonicalReport.outOfRange.length + ' note(s) fall outside the etude\'s intended register. ' +
          'This usually means the curriculum data has a transcription error — please report it.';
        cwarn.appendChild(cwarnMsg);
        var clist = document.createElement('ul');
        for (var j = 0; j < currentCanonicalReport.outOfRange.length; j++) {
          var cv = currentCanonicalReport.outOfRange[j];
          var cp = cv.pitch;
          var cstep = cp.step;
          if (cp.alter === 1) cstep += '#';
          else if (cp.alter === -1) cstep += 'b';
          var cli = document.createElement('li');
          cli.textContent = 'bar ' + (cv.measureIndex + 1) + ', ' + cstep + cp.octave +
                            ' (MIDI ' + cv.midi + ')';
          clist.appendChild(cli);
        }
        cwarn.appendChild(clist);
        warnContainer.appendChild(cwarn);
      }
    }
    paintWarnPanel();

    // Verovio SVG of the first 8 bars.
    var svgWrap = document.createElement('div');
    svgWrap.className = 'mc-preview-svg';
    var loadingMsg = document.createElement('p');
    loadingMsg.className = 'muted';
    loadingMsg.textContent = 'Rendering preview…';
    svgWrap.appendChild(loadingMsg);
    box.appendChild(svgWrap);
    renderSvgForXml(svgWrap, currentPreviewXml);

    // Helper: re-render the SVG with the current preview XML. Used
    // after "Fix Enharmonics" (or any future "transform XML" button).
    function rerenderSvg() {
      svgWrap.innerHTML = '<p class="muted">Rendering preview…</p>';
      renderSvgForXml(svgWrap, currentPreviewXml);
    }
    // Helper: re-run the range check + repaint badge + warning.
    function rerunRangeCheck() {
      try {
        if (window.etudesStitch.validateEtudeNotes && rangeUsed) {
          currentReport = window.etudesStitch.validateEtudeNotes(
            currentFullXml, rangeUsed.lowMidi, rangeUsed.highMidi
          );
          currentCanonicalReport = window.etudesStitch.validateEtudeNotes(
            currentFullXml, canonicalRange.lowMidi, canonicalRange.highMidi
          );
          paintBadge(currentReport);
          paintCanonicalBadge(currentCanonicalReport);
          paintWarnPanel();
        }
      } catch (e) {
        console.warn('re-run range check failed:', e);
      }
    }

    // Action buttons.
    var actions = document.createElement('div');
    actions.className = 'mc-preview-actions';

    // Save & Practice — the primary action. Always present.
    var saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = 'Save & open Practice';
    saveBtn.addEventListener('click', function () {
      // Read the latest XML + report from the closures (might have
      // been updated by "Fix Enharmonics" before the user clicked Save).
      saveMasterClassEtude(etude, line, currentFullXml, rangeUsed, currentReport, /*transposed=*/false);
    });
    actions.appendChild(saveBtn);

    // Fix Enharmonics — always present. Walks the current XML and
    // rewrites every pitch to its canonical spelling (E#→F, B#→C,
    // Fb→E, Cb→B, etc.). Re-renders the SVG and re-runs the range
    // check so the user sees the result immediately. The "Save" and
    // "Auto-transpose" buttons then use the updated XML on click.
    // Useful when the user has hand-transposed a stitched etude and
    // ended up with awkward enharmonics, or when a curriculum edit
    // happens to introduce them.
    var fixBtn = document.createElement('button');
    fixBtn.className = 'btn btn-ghost';
    fixBtn.textContent = 'Fix Enharmonics';
    fixBtn.title = 'Rewrite every pitch to its canonical spelling (E#→F, Fb→E, etc.)';
    fixBtn.addEventListener('click', function () {
      if (!window.etudesStitch || !window.etudesStitch.simplifyEnharmonicXml) {
        toast('Enharmonic helper unavailable.', true);
        return;
      }
      try {
        currentFullXml = window.etudesStitch.simplifyEnharmonicXml(currentFullXml);
        currentPreviewXml = window.etudesStitch.simplifyEnharmonicXml(currentPreviewXml);
      } catch (e) {
        console.error('simplifyEnharmonicXml failed', e);
        toast('Fix failed: ' + (e && e.message ? e.message : e), true);
        return;
      }
      rerenderSvg();
      rerunRangeCheck();
      toast('Enharmonics simplified.');
    });
    actions.appendChild(fixBtn);

    // Auto-transpose + Save — only when there are out-of-range notes.
    // Uses clampToRange to shift notes by whole octaves. The
    // resulting XML is built + validated again before saving.
    if (currentReport && !currentReport.ok && currentReport.outOfRange.length) {
      var transposeBtn = document.createElement('button');
      transposeBtn.className = 'btn btn-ghost';
      transposeBtn.textContent = 'Auto-transpose & save';
      transposeBtn.title = 'Shift out-of-range notes by whole octaves to fit your range';
      transposeBtn.addEventListener('click', function () {
        var xmlToSave = currentFullXml;
        try {
          var clamped = window.etudesStitch.clampToRange(currentFullXml, rangeUsed.lowMidi, rangeUsed.highMidi);
          if (clamped.moved > 0) {
            xmlToSave = clamped.xml;
            toast('Shifted ' + clamped.moved + ' note(s) into your instrument range.');
          } else {
            toast('No notes needed shifting (clampToRange found no moves).');
          }
        } catch (e) {
          console.warn('clampToRange failed (saving original):', e);
        }
        saveMasterClassEtude(etude, line, xmlToSave, rangeUsed, currentReport, /*transposed=*/true);
      });
      actions.appendChild(transposeBtn);
    }

    // Cancel — hide the preview. Useful if the user picked the
    // wrong line and wants to start over without leaving the page.
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-ghost';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function () {
      box.classList.remove('visible');
      box.innerHTML = '';
    });
    actions.appendChild(cancelBtn);

    // A small note when the line has range + big-jump warnings.
    if (currentReport && !currentReport.ok && currentReport.bigJumps.length) {
      var note = document.createElement('span');
      note.className = 'mc-preview-note';
      note.textContent = '· ' + currentReport.bigJumps.length + ' jump(s) > 7th — saved as-is, see console';
      actions.appendChild(note);
    }

    box.appendChild(actions);

    // Scroll the preview into view so the user sees the result
    // without having to hunt for it. (Smooth scroll is fine on
    // desktop; on mobile the focus jump is enough.)
    try { box.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
  }

  // Convert a MIDI number to a note name string for the range badge
  // tooltips (e.g. MIDI 60 = "C4", MIDI 57 = "A3"). Mirrors the
  // practice.js note-name logic. Used only in the preview pane.
  function midiToNoteName(midi) {
    var NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    var pc = ((midi % 12) + 12) % 12;
    var octave = Math.floor(midi / 12) - 1;
    return NAMES[pc] + octave;
  }

  // Build a Master Class etude's MusicXML in-browser, save to IDB, and
  // jump to /practice/?id=etude_xxx. Mirrors the composer/random save
  // flow (toast on success, redirect after 600ms) but uses the
  // dedicated Master Class builder rather than stitching server
  // sources. `source: 'master-class'` on the IDB record means the
  // saved-etudes card shows a distinct badge.
  //
  // v36: refactored to accept a pre-built XML (built by the preview
  // pane) and a cached rangeUsed/report. The preview flow builds
  // the XML once, runs the range check, and on user confirmation
  // hands the result to this function. If the user picked
  // auto-transpose, the caller passes the clamped XML and sets
  // transposed=true so we can show the right toast.
  async function saveMasterClassEtude(etude, line, xml, rangeUsed, report, transposed) {
    if (!xml) {
      toast('No MusicXML to save.', true);
      return;
    }

    // Big-jump warning (if the report had any). These are saved as-is
    // — the user already saw the warning in the preview pane.
    if (report && !report.ok && report.bigJumps.length) {
      console.warn('[mc] big jumps (saved as-is):', report.bigJumps);
    }

    var pitchedCount = window.etudesStitch.countPitchedNotes(xml);
    var name = 'MC ' + etude.id.replace(/^mc-/, '').replace(/-/g, ' ') +
                 ' — ' + line.name;
    var id = window.etudesStore.newId();
    try {
      var mcRecord = {
        id: id,
        name: name,
        exerciseIds: [],
        semitones: [],
        mode: 'master-class',
        source: 'master-class',
        musicxml: xml,
        noteCount: pitchedCount,
        metadata: {
          etudeId: etude.id,
          lineName: line.name,
          mc: etude.mc,
          bpm: etude.bpm,
          transposed: !!transposed,
        },
      };
      await window.etudesStore.saveEtude(mcRecord);
      saveToServer(mcRecord);
    } catch (e) {
      console.error('saveEtude failed', e);
      toast('Save failed: ' + e.message, true);
      return;
    }
    toast('Saved "' + name + '" — opening Practice…');
    setTimeout(function () {
      window.location.href = '/practice/?id=' + encodeURIComponent(id);
    }, 600);
  }

  // ---------- Generate & save ----------
  async function generateAndSave(source, customName) {
    let parts;
    let name;
    if (source === 'composer') {
      if (state.composer.selected.length < 2) {
        toast('Pick at least 2 exercises to make an etude.', true);
        return;
      }
      if (state.composer.selected.length > 12) {
        toast('Max 12 exercises per etude.', true);
        return;
      }
      parts = state.composer.selected.slice();
      name = (customName || document.getElementById('composer-name').value || '').trim()
        || ('Etude ' + new Date().toLocaleString());
    } else if (source === 'random') {
      if (!state.random.lastPreview) {
        toast('Click Generate first to pick exercises.', true);
        return;
      }
      parts = state.random.lastPreview.slice();
      name = (customName || '').trim()
        || ('Random ' + new Date().toLocaleString());
    } else {
      return;
    }

    let musicxml;
    try {
      musicxml = await window.etudesStitch.stitch(parts, name);
    } catch (e) {
      console.error('stitch failed', e);
      toast('Could not stitch: ' + e.message, true);
      return;
    }

    // Always clamp to the user's saved instrument range. Any notes
    // outside the user's playable register get shifted by whole octaves
    // so the result is always playable.
    try {
      var r = getEtudesRange();
      var clamped = window.etudesStitch.clampToRange(musicxml, r.lowMidi, r.highMidi);
      if (clamped.moved > 0) {
        toast('Shifted ' + clamped.moved + ' note(s) into your instrument range.');
      }
      musicxml = clamped.xml;
    } catch (clampErr) {
      console.warn('clampToRange failed (continuing with unclamped stitch):', clampErr);
    }

    // Avoid duplicate names: if "My Sketch" already exists, save as
    // "My Sketch (2)", "My Sketch (3)", etc.
    name = await uniquifyEtudeName(name);

    const id = window.etudesStore.newId();
    var genRecord = {
      id: id,
      name: name,
      exerciseIds: parts.map(function (p) { return p.id; }),
      semitones: parts.map(function (p) { return p.semitones || 0; }),
      mode: source,
      source: source,
      musicxml: musicxml,
      noteCount: window.etudesStitch.countNotes(musicxml),
    };
    try {
      await window.etudesStore.saveEtude(genRecord);
      saveToServer(genRecord);
    } catch (e) {
      console.error('saveEtude failed', e);
      toast('Could not save etude: ' + e.message, true);
      return;
    }

    toast('Saved "' + name + '" — opening Practice…');

    // Redirect to practice page
    setTimeout(function () {
      window.location.href = '/practice/?id=' + encodeURIComponent(id);
    }, 600);
  }

  // ---------- Saved etudes list ----------
  // Filter state lives on state.savedFilter. The input is the search box
  // rendered into the saved-etudes panel by initSavedListFilter().
  async function refreshSavedEtudes() {
    const list = document.getElementById('etudes-list');
    const count = document.getElementById('etudes-count');
    let all = [];
    try {
      all = await window.etudesStore.listEtudes();
    } catch (e) {
      count.textContent = '(storage unavailable)';
      return;
    }
    count.textContent = '(' + all.length + ')';
    list.innerHTML = '';
    if (!all.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.id = 'etudes-empty';
      p.textContent = 'No saved etudes yet.';
      list.appendChild(p);
      return;
    }
    // Apply filter
    const filter = (state.savedFilter || '').toLowerCase().trim();
    const visible = filter
      ? all.filter(function (et) {
          return (et.name || '').toLowerCase().indexOf(filter) >= 0 ||
                 (et.source || '').indexOf(filter) >= 0;
        })
      : all;
    if (!visible.length && filter) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'No etudes match "' + filter + '".';
      list.appendChild(p);
      return;
    }
    visible.forEach(function (et) {
      list.appendChild(makeEtudeCard(et));
    });
  }

  // Ensure an etude name is unique in the user's saved-etudes list.
  // If `name` already exists, append " (2)", " (3)", etc. Returns the
  // first unused variant. Used by the Composer and Random save flows
  // so the user can save rapidly without thinking about naming, and
  // gets sensibly-suffixed copies when they do.
  async function uniquifyEtudeName(name) {
    var all = [];
    try { all = await window.etudesStore.listEtudes(); }
    catch (e) { return name; }
    var taken = {};
    all.forEach(function (e) { taken[e.name] = true; });
    if (!taken[name]) return name;
    var stripped = name.replace(/ \(\d+\)$/, '');
    var i = 2;
    while (taken[stripped + ' (' + i + ')']) i++;
    return stripped + ' (' + i + ')';
  }

  // Wire the saved-etudes search filter input. Called once at boot.
  function wireSavedListFilter() {
    const input = document.getElementById('etudes-search');
    if (!input) return;
    input.addEventListener('input', function (e) {
      state.savedFilter = e.target.value;
      refreshSavedEtudes();
    });
  }

  function makeEtudeCard(et) {
    const card = document.createElement('div');
    card.className = 'etude-card';
    card.dataset.id = et.id;

    const info = document.createElement('div');
    info.className = 'etude-info';
    const titleRow = document.createElement('div');
    titleRow.className = 'etude-title-row';
    const name = document.createElement('span');
    name.className = 'etude-name';
    name.textContent = et.name;
    titleRow.appendChild(name);
    // Source badge: distinguishes pattern / composed / random / master-class at a glance.
    const sourceBadge = document.createElement('span');
    sourceBadge.className = 'etude-source-badge source-' + (et.source || 'random');
    sourceBadge.textContent = et.source === 'pattern' ? 'pattern'
      : et.source === 'composer' ? 'composed'
      : et.source === 'master-class' ? 'master class'
      : 'random';
    titleRow.appendChild(sourceBadge);
    info.appendChild(titleRow);

    const meta = document.createElement('div');
    meta.className = 'etude-meta';
    const parts = et.exerciseIds || [];
    const notes = et.noteCount || (et.musicxml ? window.etudesStitch.countNotes(et.musicxml) : 0);
    const date = et.createdAt ? new Date(et.createdAt).toLocaleDateString() : '';
    const exLabel = parts.length > 0
      ? '<strong>' + parts.length + '</strong> exercises · '
      : '';
    meta.innerHTML =
      exLabel +
      '<strong>' + notes + '</strong> notes · ' +
      (date ? date : '');
    info.appendChild(meta);

    const practice = document.createElement('a');
    practice.className = 'btn-practice';
    practice.href = '/practice/?id=' + encodeURIComponent(et.id);
    practice.textContent = 'Practice';

    const playMidi = document.createElement('a');
    playMidi.className = 'btn-play-midi';
    playMidi.href = '/practice/?id=' + encodeURIComponent(et.id) + '&play=1';
    playMidi.textContent = 'Play MIDI';
    playMidi.title = 'Open in Practice and auto-play';

    const rename = document.createElement('button');
    rename.className = 'btn btn-ghost btn-sm';
    rename.textContent = 'Rename';
    rename.addEventListener('click', function () {
      const n = prompt('Rename etude:', et.name);
      if (n && n.trim() && n !== et.name) {
        window.etudesStore.renameEtude(et.id, n.trim()).then(refreshSavedEtudes);
      }
    });

    const dup = document.createElement('button');
    dup.className = 'btn btn-ghost btn-sm';
    dup.textContent = 'Duplicate';
    dup.title = 'Create a copy of this etude';
    dup.addEventListener('click', function () {
      const copy = Object.assign({}, et);
      delete copy.id;
      copy.name = et.name + ' (copy)';
      copy.createdAt = new Date().toISOString();
      window.etudesStore.saveEtude(copy).then(function () {
        toast('Duplicated.');
        refreshSavedEtudes();
      });
    });

    const del = document.createElement('button');
    del.className = 'btn btn-danger btn-sm';
    del.textContent = 'Delete';
    del.addEventListener('click', function () {
      if (confirm('Delete "' + et.name + '"?')) {
        window.etudesStore.deleteEtude(et.id).then(refreshSavedEtudes);
      }
    });

    card.appendChild(info);
    card.appendChild(rename);
    card.appendChild(dup);
    card.appendChild(del);
    card.appendChild(practice);
    card.appendChild(playMidi);
    return card;
  }

  function wireEtudesActions() {
    document.getElementById('etudes-clear-all').addEventListener('click', function () {
      window.etudesStore.listEtudes().then(function (all) {
        if (!all.length) return;
        if (!confirm('Delete all ' + all.length + ' saved etudes?')) return;
        Promise.all(all.map(function (e) { return window.etudesStore.deleteEtude(e.id); }))
          .then(refreshSavedEtudes)
          .then(function () { toast('All etudes deleted.'); });
      });
    });
  }

  // ---------- HTML escape ----------
  // Used by makeCuratedCard() to prevent name/description fields
  // from injecting markup into the curated list. Mirrors the same
  // helper in app.js.
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------- Toast ----------
  function toast(msg, isError) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.classList.add('visible');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove('visible'); }, 2400);
  }

  // ---------- Go ----------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
