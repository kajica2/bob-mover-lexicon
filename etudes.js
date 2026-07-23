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

    // Selected rows are no longer prepended here — they live in the
    // pinned composer-selected panel so they remain visible regardless of
    // the current section or filter.
    const rows = filtered;

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
    try {
      await window.etudesStore.saveEtude({
        id: id,
        name: name,
        exerciseIds: parts.map(function (p) { return p.id; }),
        semitones: parts.map(function (p) { return p.semitones; }),
        mode: 'composer',
        source: 'composer',
        musicxml: xml,
        noteCount: noteCount,
      });
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
    const count = parseInt(document.getElementById('random-count').value, 10);
    const spread = parseInt(document.getElementById('random-spread').value, 10);
    const pool = state.exercisesBySection[section] || [];
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

    var namePreset = 'Random: §' + (state.random.section || '?') +
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
          breaks: 'auto',
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
    // Source badge: distinguishes pattern / composed / random at a glance.
    const sourceBadge = document.createElement('span');
    sourceBadge.className = 'etude-source-badge source-' + (et.source || 'random');
    sourceBadge.textContent = et.source === 'pattern' ? 'pattern'
      : et.source === 'composer' ? 'composed' : 'random';
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
