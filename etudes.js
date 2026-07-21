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
  };

  // ---------- Bootstrap ----------
  function init() {
    wireModeTabs();
    fetchExercises().then(function () {
      populateComposerSection();
      populateRandomSection();
      renderComposer();
      wireComposerControls();
      wireRandomControls();
      wireEtudesActions();
      refreshSavedEtudes();
    });
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
    Object.keys(state.exercisesBySection).sort().forEach(function (sec) {
      const exs = state.exercisesBySection[sec];
      const name = exs[0].section_name || sec;
      const opt = document.createElement('option');
      opt.value = sec;
      opt.textContent = sec + ' · ' + name + ' (' + exs.length + ')';
      sel.appendChild(opt);
    });
    state.composer.section = sel.value;
  }

  function renderComposer() {
    const list = document.getElementById('composer-exercises');
    list.innerHTML = '';
    const sec = state.composer.section;
    const all = state.exercisesBySection[sec] || [];
    const filter = state.composer.filter.toLowerCase();
    const filtered = filter
      ? all.filter(function (e) {
          return (e.title || '').toLowerCase().indexOf(filter) >= 0 ||
                 String(e.id).indexOf(filter) >= 0;
        })
      : all;
    const selectedIds = {};
    state.composer.selected.forEach(function (s) { selectedIds[s.id] = s; });

    // Selected first (in selected order), then unselected (alphabetical by id).
    const selectedRows = state.composer.selected.slice();
    const unselectedRows = filtered.filter(function (e) { return !(e.id in selectedIds); });
    const rows = selectedRows.concat(unselectedRows);

    document.getElementById('composer-list-summary').textContent =
      filtered.length + ' of ' + all.length + ' in this section';

    rows.forEach(function (entry) {
      const isSelected = entry.id in selectedIds;
      const transposeVal = isSelected ? (selectedIds[entry.id].semitones || 0) : 0;
      const ex = state.exercises.filter(function (e) { return e.id === entry.id; })[0] || entry;

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
      row.appendChild(transposeInput);
      row.appendChild(removeBtn);
      list.appendChild(row);

      // Drag & drop reorder
      if (isSelected) {
        handle.addEventListener('dragstart', function (e) {
          e.dataTransfer.setData('text/plain', String(ex.id));
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
          const targetId = ex.id;
          if (!selectedIds[srcId] || srcId === targetId) return;
          moveSelected(srcId, targetId);
        });
      }
    });

    updateComposerCount();
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

  function moveSelected(srcId, targetId) {
    const srcIdx = state.composer.selected.findIndex(function (s) { return s.id === srcId; });
    const targetIdx = state.composer.selected.findIndex(function (s) { return s.id === targetId; });
    if (srcIdx < 0 || targetIdx < 0) return;
    const [moved] = state.composer.selected.splice(srcIdx, 1);
    state.composer.selected.splice(targetIdx, 0, moved);
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
      generateAndSave('composer');
    });
  }

  // ---------- Random mode ----------
  function populateRandomSection() {
    const sel = document.getElementById('random-section');
    sel.innerHTML = '';
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

  function generateRandomPreview() {
    const section = document.getElementById('random-section').value;
    const count = parseInt(document.getElementById('random-count').value, 10);
    const spread = parseInt(document.getElementById('random-spread').value, 10);
    const pool = state.exercisesBySection[section] || [];
    if (pool.length < count) {
      toast('Section only has ' + pool.length + ' exercises — pick fewer or another section.', true);
      return;
    }
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

    const actions = document.createElement('div');
    actions.className = 'preview-actions';
    const nameInput = document.createElement('input');
    nameInput.className = 'input';
    nameInput.placeholder = 'Name this etude (e.g. Random chromatic sketch)';
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
    regenBtn.addEventListener('click', generateRandomPreview);
    actions.appendChild(regenBtn);

    box.appendChild(actions);
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

    const id = window.etudesStore.newId();
    try {
      await window.etudesStore.saveEtude({
        id: id,
        name: name,
        exerciseIds: parts.map(function (p) { return p.id; }),
        semitones: parts.map(function (p) { return p.semitones || 0; }),
        mode: source,
        source: source,
        musicxml: musicxml,
        noteCount: window.etudesStitch.countNotes(musicxml),
      });
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
    all.forEach(function (et) {
      list.appendChild(makeEtudeCard(et));
    });
  }

  function makeEtudeCard(et) {
    const card = document.createElement('div');
    card.className = 'etude-card';

    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'etude-name';
    name.textContent = et.name;
    const meta = document.createElement('div');
    meta.className = 'etude-meta';
    const parts = et.exerciseIds || [];
    const notes = et.noteCount || (et.musicxml ? window.etudesStitch.countNotes(et.musicxml) : 0);
    const date = et.createdAt ? new Date(et.createdAt).toLocaleDateString() : '';
    meta.innerHTML =
      '<strong>' + parts.length + '</strong> exercises · ' +
      '<strong>' + notes + '</strong> notes · ' +
      (date ? date : '');
    info.appendChild(name);
    info.appendChild(meta);

    const practice = document.createElement('a');
    practice.className = 'btn-practice';
    practice.href = '/practice/?id=' + encodeURIComponent(et.id);
    practice.textContent = 'Practice';

    const rename = document.createElement('button');
    rename.className = 'btn btn-ghost btn-sm';
    rename.textContent = 'Rename';
    rename.addEventListener('click', function () {
      const n = prompt('Rename etude:', et.name);
      if (n && n.trim() && n !== et.name) {
        window.etudesStore.renameEtude(et.id, n.trim()).then(refreshSavedEtudes);
      }
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
    card.appendChild(del);
    card.appendChild(practice);
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
