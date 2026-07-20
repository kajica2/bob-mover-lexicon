/* Bob Mover Jazz Lexicon — main app */
(function () {
  'use strict';

  const state = {
    db: null,
    exercises: [],
    sections: [],
    selected: new Set(),
    activeSections: new Set(),
    search: '',
    showOnlySelected: false,
    sheetSearch: '',
    sheetActiveSections: new Set(),
    sheetSelected: [],
    view: 'browse',
  };

  // ===== Init =====
  async function init() {
    // Load data
    try {
      const r = await fetch('exercises.json');
      const db = await r.json();
      state.db = db;
      state.exercises = db.exercises;
      state.sections = db.sections_defined || [];
      document.getElementById('total-count').textContent = db.total_exercises;
    } catch (e) {
      console.error('Failed to load exercises', e);
      document.getElementById('exercise-grid').innerHTML =
        '<div class="empty">Failed to load exercises. Try refreshing the page.</div>';
      return;
    }

    // Load favorites
    try {
      const saved = localStorage.getItem('jazz_lex_favorites');
      if (saved) state.selected = new Set(JSON.parse(saved));
    } catch {}

    // Route handling
    window.addEventListener('hashchange', handleRoute);
    handleRoute();

    // Event listeners
    document.getElementById('search').addEventListener('input', (e) => {
      state.search = e.target.value;
      renderBrowse();
    });
    document.getElementById('sheet-search').addEventListener('input', (e) => {
      state.sheetSearch = e.target.value;
      renderSheetPicker();
    });
    document.getElementById('select-all').addEventListener('click', () => {
      state.filtered.forEach((e) => state.selected.add(e.id));
      persistFavorites();
      renderBrowse();
    });
    document.getElementById('clear-selection').addEventListener('click', () => {
      state.selected.clear();
      persistFavorites();
      renderBrowse();
    });
    document.getElementById('toggle-selected-only').addEventListener('click', (e) => {
      state.showOnlySelected = !state.showOnlySelected;
      e.target.textContent = state.showOnlySelected ? 'Show all' : 'Show only selected';
      renderBrowse();
    });
    document.getElementById('sheet-clear').addEventListener('click', clearSheetSelection);
    document.getElementById('generate-pdf').addEventListener('click', generatePdf);
    document.getElementById('generate-allkeys').addEventListener('click', generateAllKeysPdf);

    // Quick add buttons
    document.querySelectorAll('[data-add-random]').forEach((btn) => {
      btn.addEventListener('click', () => {
        addRandom(parseInt(btn.dataset.addRandom, 10));
      });
    });

    // Modal
    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.querySelector('.modal-backdrop').addEventListener('click', closeModal);

    // Section chips
    renderSectionChips();
    renderSheetSectionChips();
    renderSectionButtons();
    renderBrowse();
  }

  function handleRoute() {
    const hash = window.location.hash.replace('#', '');
    if (hash === 'sheet') {
      switchView('sheet');
    } else {
      switchView('browse');
    }
  }

  function switchView(view) {
    state.view = view;
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach((l) => l.classList.remove('active'));
    document.getElementById(`view-${view}`).classList.add('active');
    document.querySelector(`[data-view="${view}"]`)?.classList.add('active');
    if (view === 'sheet') {
      renderSheetPicker();
      renderSheetSelected();
    }
  }

  // ===== Browse view =====
  function renderBrowse() {
    const filtered = computeFiltered();
    state.filtered = filtered;
    document.getElementById('match-count').textContent = filtered.length;
    document.getElementById('selected-count').textContent = state.selected.size;
    const navCount = document.getElementById('nav-count');
    if (state.selected.size > 0) {
      navCount.style.display = '';
      navCount.textContent = state.selected.size;
    } else {
      navCount.style.display = 'none';
    }

    const actionBar = document.getElementById('action-bar');
    if (state.selected.size > 0) {
      actionBar.style.display = '';
      document.getElementById('action-count').textContent = state.selected.size;
    } else {
      actionBar.style.display = 'none';
    }
    const toggleBtn = document.getElementById('toggle-selected-only');
    if (state.selected.size > 0) {
      toggleBtn.style.display = '';
    } else {
      toggleBtn.style.display = 'none';
    }

    const grid = document.getElementById('exercise-grid');
    if (filtered.length === 0) {
      grid.innerHTML = '';
      document.getElementById('empty-state').style.display = '';
      return;
    }
    document.getElementById('empty-state').style.display = 'none';
    grid.innerHTML = filtered.map((e) => exerciseCardHtml(e)).join('');
    // Attach click handlers
    grid.querySelectorAll('.ex-card').forEach((el) => {
      const id = parseInt(el.dataset.id, 10);
      el.querySelector('.ex-img').addEventListener('click', () => toggleSelect(id));
      el.querySelector('.ex-detail-link').addEventListener('click', (e) => {
        e.stopPropagation();
        openDetail(id);
      });
      const queueBtn = el.querySelector('[data-queue]');
      if (queueBtn) {
        queueBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          addToQueue(id);
        });
      }
    });
    // Update status indicators
    updateStatusIndicators(filtered);
  }

  function addToQueue(id) {
    try {
      let queue = JSON.parse(localStorage.getItem('practice_queue') || '[]');
      if (!queue.includes(id)) {
        queue.push(id);
        localStorage.setItem('practice_queue', JSON.stringify(queue));
        // Visual feedback
        const btn = document.querySelector(`[data-queue="${id}"]`);
        if (btn) {
          const orig = btn.textContent;
          btn.textContent = '✓ Queued';
          btn.classList.add('queued');
          setTimeout(() => {
            btn.textContent = orig;
            btn.classList.remove('queued');
          }, 1500);
        }
      }
    } catch {}
  }

  async function updateStatusIndicators(exercises) {
    // Fetch practice status for visible exercises
    const ids = exercises.map((e) => e.id);
    if (ids.length === 0) return;
    // Batch by checking each (could be optimized, but fine for now)
    const summaryMap = {};
    await Promise.all(ids.slice(0, 60).map(async (id) => {
      try {
        const r = await fetch(`api/practice/exercise/${id}`);
        const data = await r.json();
        summaryMap[id] = data.summary || {};
      } catch {}
    }));
    document.querySelectorAll('[data-ex-status]').forEach((el) => {
      const id = parseInt(el.dataset.exStatus, 10);
      const s = summaryMap[id];
      if (s && s.times_practiced) {
        el.className = 'ex-status practiced';
        el.title = `Practiced ${s.times_practiced}×, best tempo: ${s.best_tempo || '—'}`;
        el.textContent = `✓ ${s.times_practiced}×`;
      } else {
        el.className = 'ex-status';
        el.textContent = '';
      }
    });
  }

  function exerciseCardHtml(e) {
    const isSel = state.selected.has(e.id);
    return `
      <div class="ex-card ${isSel ? 'selected' : ''}" data-id="${e.id}">
        <div class="ex-img">
          <img src="exercises_images/${String(e.id).padStart(4, '0')}.png" alt="#${e.id}: ${escapeHtml(e.title)}" loading="lazy">
          <div class="select-dot">${isSel ? '✓' : '+'}</div>
        </div>
        <div class="ex-meta">
          <div>
            <span class="ex-num">#${e.id}</span>
            <span class="ex-section">§${e.section}</span>
            <span class="ex-page">p.${e.page}</span>
            <span class="ex-status" data-ex-status="${e.id}"></span>
          </div>
          <p class="ex-title">${escapeHtml(e.title)}</p>
          <div class="ex-actions">
            <a class="ex-detail-link" href="#">Open detail →</a>
            <button class="ex-queue-btn" data-queue="${e.id}" title="Add to practice queue">+ Queue</button>
            <a class="ex-practice-link" href="./practice/?id=${e.id}">Practice →</a>
          </div>
        </div>
      </div>
    `;
  }

  function computeFiltered() {
    let pool = state.exercises;
    if (state.activeSections.size > 0) {
      pool = pool.filter((e) => state.activeSections.has(e.section));
    }
    if (state.search) {
      const q = state.search.toLowerCase();
      pool = pool.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          e.section.toLowerCase().includes(q) ||
          String(e.id).includes(q)
      );
    }
    if (state.showOnlySelected) {
      pool = pool.filter((e) => state.selected.has(e.id));
    }
    return pool;
  }

  function toggleSelect(id) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    persistFavorites();
    renderBrowse();
  }

  function persistFavorites() {
    try {
      localStorage.setItem('jazz_lex_favorites', JSON.stringify([...state.selected]));
    } catch {}
  }

  // ===== Sheet builder =====
  function renderSheetPicker() {
    let pool = state.exercises;
    if (state.sheetActiveSections.size > 0) {
      pool = pool.filter((e) => state.sheetActiveSections.has(e.section));
    }
    if (state.sheetSearch) {
      const q = state.sheetSearch.toLowerCase();
      pool = pool.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          e.section.toLowerCase().includes(q) ||
          String(e.id).includes(q)
      );
    }
    const grid = document.getElementById('picker-grid');
    const limit = 100;
    const visible = pool.slice(0, limit);
    grid.innerHTML = visible.map((e) => {
      const isSel = state.sheetSelected.includes(e.id);
      return `
        <button class="picker-item" data-id="${e.id}" ${isSel ? 'disabled' : ''}>
          <span class="pi-num">#${e.id}</span>
          <span class="pi-title">${escapeHtml(e.title)}</span>
          <span class="pi-section">§${e.section}</span>
        </button>
      `;
    }).join('');
    grid.querySelectorAll('.picker-item').forEach((el) => {
      el.addEventListener('click', () => {
        const id = parseInt(el.dataset.id, 10);
        if (!state.sheetSelected.includes(id)) {
          state.sheetSelected.push(id);
          renderSheetPicker();
          renderSheetSelected();
        }
      });
    });
    const hint = document.getElementById('picker-hint');
    if (pool.length > limit) {
      hint.textContent = `Showing first ${limit} of ${pool.length}. Refine your search to see more.`;
    } else {
      hint.textContent = `${pool.length} matching`;
    }
  }

  function renderSheetSelected() {
    const list = document.getElementById('selected-list');
    const count = document.getElementById('sheet-count');
    count.textContent = state.sheetSelected.length;
    const navCount = document.getElementById('nav-count');
    if (state.sheetSelected.length > 0) {
      navCount.style.display = '';
      navCount.textContent = state.sheetSelected.length;
    } else {
      navCount.style.display = 'none';
    }

    if (state.sheetSelected.length === 0) {
      list.innerHTML = '<p class="hint">No exercises selected. Add some from the left.</p>';
    } else {
      const byId = {};
      state.exercises.forEach((e) => (byId[e.id] = e));
      list.innerHTML = state.sheetSelected.map((id, idx) => {
        const e = byId[id];
        if (!e) return '';
        return `
          <div class="selected-item">
            <span class="si-num">#${e.id}</span>
            <span class="si-title">${escapeHtml(e.title)}</span>
            <button class="si-btn" data-action="up" data-idx="${idx}" title="Move up">↑</button>
            <button class="si-btn" data-action="down" data-idx="${idx}" title="Move down">↓</button>
            <button class="si-btn danger" data-action="remove" data-idx="${idx}" title="Remove">×</button>
          </div>
        `;
      }).join('');
      list.querySelectorAll('.si-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.idx, 10);
          const action = btn.dataset.action;
          if (action === 'up') moveInSheet(idx, -1);
          else if (action === 'down') moveInSheet(idx, 1);
          else if (action === 'remove') {
            state.sheetSelected.splice(idx, 1);
            renderSheetPicker();
            renderSheetSelected();
          }
        });
      });
    }

    document.getElementById('generate-pdf').disabled = state.sheetSelected.length === 0;
    document.getElementById('generate-allkeys').disabled = state.sheetSelected.length === 0;
    }

  function moveInSheet(idx, delta) {
    const j = idx + delta;
    if (j < 0 || j >= state.sheetSelected.length) return;
    const t = state.sheetSelected[idx];
    state.sheetSelected[idx] = state.sheetSelected[j];
    state.sheetSelected[j] = t;
    renderSheetSelected();
  }

  function addRandom(n) {
    let pool = state.exercises;
    if (state.sheetActiveSections.size > 0) {
      pool = pool.filter((e) => state.sheetActiveSections.has(e.section));
    }
    if (state.sheetSearch) {
      const q = state.sheetSearch.toLowerCase();
      pool = pool.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          e.section.toLowerCase().includes(q) ||
          String(e.id).includes(q)
      );
    }
    const available = pool.filter((e) => !state.sheetSelected.includes(e.id));
    for (let i = 0; i < n && available.length > 0; i++) {
      const idx = Math.floor(Math.random() * available.length);
      state.sheetSelected.push(available[idx].id);
      available.splice(idx, 1);
    }
    renderSheetPicker();
    renderSheetSelected();
  }

  function clearSheetSelection() {
    state.sheetSelected = [];
    renderSheetPicker();
    renderSheetSelected();
  }

  // ===== Section chips =====
  function renderSectionChips() {
    const container = document.getElementById('section-chips');
    container.innerHTML =
      `<span style="color: var(--ink-500); font-size: 13px; margin-right: 4px;">Sections:</span>` +
      state.sections
        .map(
          (s) =>
            `<button class="chip ${state.activeSections.has(s.section) ? 'active' : ''}" data-section="${s.section}" data-target="browse">${s.section} · ${s.count || 0}</button>`
        )
        .join('');
    container.querySelectorAll('[data-target="browse"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sec = btn.dataset.section;
        if (state.activeSections.has(sec)) state.activeSections.delete(sec);
        else state.activeSections.add(sec);
        renderSectionChips();
        renderBrowse();
      });
    });
  }

  function renderSheetSectionChips() {
    const container = document.getElementById('sheet-section-chips');
    container.innerHTML = state.sections
      .map(
        (s) =>
          `<button class="chip ${state.sheetActiveSections.has(s.section) ? 'active' : ''}" data-section="${s.section}">${s.section} · ${s.count || 0}</button>`
      )
      .join('');
    container.querySelectorAll('[data-section]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sec = btn.dataset.section;
        if (state.sheetActiveSections.has(sec)) state.sheetActiveSections.delete(sec);
        else state.sheetActiveSections.add(sec);
        renderSheetSectionChips();
        renderSheetPicker();
      });
    });
  }

  function renderSectionButtons() {
    const container = document.getElementById('section-buttons');
    container.innerHTML = state.sections
      .map((s) => `<button class="btn btn-ghost" data-section="${s.section}">+3 from §${s.section}</button>`)
      .join('');
    container.querySelectorAll('[data-section]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sec = btn.dataset.section;
        const pool = state.exercises.filter((e) => e.section === sec);
        const available = pool.filter((e) => !state.sheetSelected.includes(e.id));
        available.slice(0, 3).forEach((e) => state.sheetSelected.push(e.id));
        renderSheetPicker();
        renderSheetSelected();
      });
    });
  }

  // ===== Detail modal =====
  function openDetail(id) {
    const e = state.exercises.find((ex) => ex.id === id);
    if (!e) return;
    const isFav = state.selected.has(id);
    const modal = document.getElementById('detail-modal');
    const body = document.getElementById('modal-body');
    body.innerHTML = `
      <img src="exercises_images/${String(e.id).padStart(4, '0')}.png" alt="#${e.id}">
      <div class="meta">
        <span class="ex-num" style="color: var(--brass-600); font-weight: 700;">#${e.id}</span>
        <span class="ex-section" style="background: var(--ink-100); padding: 2px 8px; border-radius: 10px; font-size: 12px;">Section ${e.section}</span>
        <span>Source page ${e.page}</span>
      </div>
      <h2>${escapeHtml(e.title)}</h2>
      <div class="actions">
        <button class="btn ${isFav ? 'btn-primary' : 'btn-secondary'}" id="modal-fav">${isFav ? '★ Saved' : '☆ Add to favorites'}</button>
        <button class="btn btn-primary" id="modal-add">Add to sheet →</button>
      </div>
    `;
    modal.style.display = '';
    body.querySelector('#modal-fav').addEventListener('click', () => {
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      persistFavorites();
      openDetail(id);
      renderBrowse();
    });
    body.querySelector('#modal-add').addEventListener('click', () => {
      if (!state.sheetSelected.includes(id)) state.sheetSelected.push(id);
      switchView('sheet');
    });
  }

  function closeModal() {
    document.getElementById('detail-modal').style.display = 'none';
  }

  // ===== PDF generation =====
  async function generatePdf() {
    if (state.sheetSelected.length === 0) return;
    const btn = document.getElementById('generate-pdf');
    btn.disabled = true;
    btn.textContent = 'Generating…';
    const download = document.getElementById('download-link');
    download.style.display = 'none';

    try {
      const title = document.getElementById('sheet-title').value || 'Practice Sheet';
      const subtitle = document.getElementById('sheet-subtitle').value || '';
      const includeNotes = document.getElementById('opt-notes').checked;
      const includeTitlePage = document.getElementById('opt-title-page').checked;

      const res = await fetch('api/sheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: state.sheetSelected,
          title,
          subtitle,
          includeNotes,
          includeTitlePage,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        alert('Error: ' + (err.error || 'PDF generation failed'));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      download.href = url;
      download.download = title.replace(/\s+/g, '_') + '.pdf';
      download.style.display = '';
      download.textContent = '↓ Download PDF';
    } catch (e) {
      alert('Error: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Generate PDF';
    }
  }

  // ===== All-keys PDF generation =====
  async function generateAllKeysPdf() {
    if (state.sheetSelected.length === 0) return;
    if (state.sheetSelected.length > 10) {
      alert('Max 10 exercises for the all-keys sheet (12 pages each).');
      return;
    }
    const btn = document.getElementById('generate-allkeys');
    const status = document.getElementById('allkeys-status');
    const download = document.getElementById('download-allkeys-link');
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = 'Generating…';
    download.style.display = 'none';
    status.textContent = '';

    try {
      const mode = document.getElementById('opt-allkeys-mode').value;
      const preferFlats = document.getElementById('opt-allkeys-flats').checked;
      const title = document.getElementById('sheet-title').value || 'Practice Sheet';
      const modeLabel = mode === 'chromatic'
        ? 'All 12 Keys (Chromatic)'
        : 'All 12 Keys (m3 Cycle of 5ths)';
      const subtitle = document.getElementById('sheet-subtitle').value || modeLabel;

      status.textContent = `Rendering ${state.sheetSelected.length} × 12 = ${state.sheetSelected.length * 12} pages…`;

      const res = await fetch('api/sheet/all-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: state.sheetSelected,
          mode,
          preferFlats,
          title: title + ' — ' + modeLabel,
          subtitle,
          includeNotes: true,
          includeTitlePage: true,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        status.textContent = 'Error: ' + (err.error || 'PDF generation failed');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      download.href = url;
      download.download = title.replace(/\s+/g, '_') + '-12keys.pdf';
      download.style.display = '';
      download.textContent = '↓ Download 12-Key PDF';
      status.textContent = `Done — ${state.sheetSelected.length * 12} pages ready.`;
    } catch (e) {
      status.textContent = 'Error: ' + e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }

  // ===== Utils =====
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ===== Start =====
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
