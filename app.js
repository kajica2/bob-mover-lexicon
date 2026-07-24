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

    // Event listeners
    document.getElementById('search').addEventListener('input', (e) => {
      state.search = e.target.value;
      renderBrowse();
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

    // Section chips
    renderSectionChips();
    renderBrowse();
  }

  // ===== Browse view =====
  function renderBrowse() {
    const filtered = computeFiltered();
    state.filtered = filtered;
    document.getElementById('match-count').textContent = filtered.length;
    document.getElementById('selected-count').textContent = state.selected.size;

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
    // Attach click handlers.
    // The whole card navigates to the practice page when clicked. The
    // star button is its own toggle target — stop propagation so
    // clicking the star doesn't also fire the card navigation.
    grid.querySelectorAll('.ex-card').forEach((el) => {
      const id = parseInt(el.dataset.id, 10);
      el.addEventListener('click', (e) => {
        // Don't navigate if the user clicked the star button (it has
        // its own handler that stops propagation, but defensively skip
        // anything inside the star too).
        if (e.target.closest('.select-star')) return;
        window.location.href = `./practice/?id=${id}`;
      });
      const star = el.querySelector('.select-star');
      if (star) {
        star.addEventListener('click', function (e) {
          e.stopPropagation();
          toggleSelect(id);
        });
      }
    });
    // Update status indicators
    updateStatusIndicators(filtered);
  }

  async function updateStatusIndicators(exercises) {
    // Fetch practice status for visible exercises
    const ids = exercises.map((e) => e.id);
    if (ids.length === 0) return;
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
        </div>
        <div class="ex-meta">
          <div class="ex-row1">
            <span class="ex-num">#${e.id}</span>
            <span class="ex-section">§${e.section} <span class="ex-section-name">${sectionName(e.section)}</span></span>
          </div>
          <div class="ex-row2">
            <span class="ex-page">p.${e.page}</span>
            <span class="ex-status" data-ex-status="${e.id}"></span>
          </div>
          <p class="ex-title">${escapeHtml(e.title)}</p>
          <div class="ex-actions">
            <a class="ex-practice-link" href="./practice/?id=${e.id}">Practice →</a>
            <button class="select-star ${isSel ? 'favorited' : ''}" data-toggle-fav="${e.id}" type="button" aria-label="${isSel ? 'Remove from favorites' : 'Add to favorites'}" title="${isSel ? 'Remove from favorites' : 'Add to favorites'}">
              <span class="select-star-icon">${isSel ? '★' : '☆'}</span>
              <span class="select-star-label">Add to favorites</span>
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // Map section id (e.g. '1A', '4') to a human-readable name
  const SECTION_NAMES = {
    '1A': 'Chromatic',
    '1B': 'Scalic',
    '1C': 'Chords / Arpeggios',
    '2':  'Whole Tone / Augmented / M3rds',
    '3':  'Diminished / Minor 3rds',
    '4':  'Cyclic / Progressions',
    '5':  'Tritones',
    '6':  'Dominant 7ths',
    '7':  'Quartals',
  };
  function sectionName(id) {
    return SECTION_NAMES[id] || '';
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

  // ===== Section chips =====
  function renderSectionChips() {
    const container = document.getElementById('section-chips');
    const _counts = {};
    state.exercises.forEach((e) => { _counts[e.section] = (_counts[e.section] || 0) + 1; });
    container.innerHTML =
      `<span style="color: var(--ink-500); font-size: 13px; margin-right: 4px;">Sections:</span>` +
      state.sections
        .map(
          (s) => {
            const id = s.id || s.section;
            const name = s.name || '';
            const count = s.count != null ? s.count : (_counts[id] || 0);
            return `<button class="chip ${state.activeSections.has(id) ? 'active' : ''}" data-section="${id}" data-target="browse"><strong>§${id}</strong>${name ? ' · ' + escapeHtml(name) : ''} <span class="chip-count">${count}</span></button>`;
          }
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
