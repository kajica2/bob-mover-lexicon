/* History page */
(function () {
  'use strict';

  async function loadAll() {
    // Load exercises for IDs -> titles
    const exRes = await fetch('../exercises.json');
    const exDb = await exRes.json();
    const exById = {};
    exDb.exercises.forEach((e) => exById[e.id] = e);
    document.getElementById('total-count').textContent = exDb.total_exercises;

    // Load stats
    const statsRes = await fetch('../api/practice/stats?days=30');
    const stats = await statsRes.json();
    renderStats(stats, exById);

    // Load recent
    const recentRes = await fetch('../api/practice/recent?days=30&limit=200');
    const recent = await recentRes.json();
    renderTable(recent.practice || [], exById);
  }

  function renderStats(stats, exById) {
    const o = stats.overall || {};
    document.getElementById('stat-sessions').textContent = o.sessions || 0;
    document.getElementById('stat-unique').textContent = o.unique_exercises || 0;
    document.getElementById('stat-minutes').textContent = Math.round(o.total_minutes || 0);
    document.getElementById('stat-max-tempo').textContent = o.max_tempo ? `${o.max_tempo} bpm` : '—';

    // Heatmap
    const heatmap = document.getElementById('heatmap');
    heatmap.innerHTML = '';
    const byDayMap = {};
    (stats.by_day || []).forEach((d) => { byDayMap[d.day] = d; });

    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const data = byDayMap[dateStr];
      const minutes = data ? data.minutes : 0;
      let level = 0;
      if (minutes > 0) level = 1;
      if (minutes >= 2) level = 2;
      if (minutes >= 5) level = 3;
      if (minutes >= 10) level = 4;
      const day = document.createElement('div');
      day.className = 'day';
      day.dataset.level = level;
      day.dataset.tooltip = `${dateStr}: ${data ? `${data.sessions} sessions, ${Math.round(minutes)} min` : 'no practice'}`;
      heatmap.appendChild(day);
    }

    // Top exercises
    const topList = document.getElementById('top-exercises');
    const top = stats.top_exercises || [];
    if (top.length === 0) {
      topList.innerHTML = '<p class="hint">No practice logged yet. Start with the Practice page.</p>';
      return;
    }
    topList.innerHTML = top.map((t) => {
      const ex = exById[t.exercise_id];
      const title = ex ? ex.title : 'Unknown';
      return `
        <a class="top-item" href="../practice/?id=${t.exercise_id}">
          <span class="top-num">#${t.exercise_id}</span>
          <span class="top-title">${title}</span>
          <span class="top-count">${t.sessions}×</span>
          <span class="top-tempo">${t.best_tempo || '—'}bpm</span>
        </a>
      `;
    }).join('');
  }

  function renderTable(practice, exById) {
    const tbody = document.getElementById('history-tbody');
    if (practice.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state"><div class="empty-icon">🎵</div>Nothing logged yet — log your first session to see history.</td></tr>';
      return;
    }
    tbody.innerHTML = practice.map((p) => {
      const date = new Date(p.practiced_at);
      const ex = exById[p.exercise_id];
      const title = ex ? ex.title : 'Unknown exercise';
      return `
        <tr>
          <td>${date.toLocaleString()}</td>
          <td>
            <a class="ex-link" href="../practice/?id=${p.exercise_id}">#${p.exercise_id}</a>
            ${title}
          </td>
          <td>${p.tempo_bpm || '—'}</td>
          <td>${p.key_signature || '—'}</td>
          <td>${p.duration_min ? p.duration_min + ' min' : '—'}</td>
          <td>${p.notes ? escapeHtml(p.notes) : ''}</td>
        </tr>
      `;
    }).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadAll);
  } else {
    loadAll();
  }
})();
