/* Practice page — MusicXML player, transposition, practice logging */
(function () {
  'use strict';

  const state = {
    exercises: [],
    byId: {},
    sections: [],
    currentId: null,
    queue: JSON.parse(localStorage.getItem('practice_queue') || '[]'),
    verovio: null,
    audioRec: {
      active: false,
      mediaRecorder: null,
      mediaStream: null,
      audioCtx: null,
      analyser: null,
      chunks: [],
      startedAt: null,
      rafId: null,
      blobUrl: null,
      blobMime: null,
      lastDurationMs: 0,
    },
    rawXml: null,
    zoomScale: 50,
    zoomPage: 1,
    zoomPageCount: 1,
    fullPage: false,
  };

  // ===== MusicXML playback =====
  function parseMusicXML(xmlString) {
    // Parse the MusicXML and extract notes with timing
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'application/xml');
    const notes = [];

    // Get tempo from score
    let bpm = 120;
    const soundTempo = doc.querySelector('sound[tempo]');
    if (soundTempo) bpm = parseFloat(soundTempo.getAttribute('tempo'));

    // Walk through measures, collecting notes
    const measures = doc.querySelectorAll('measure');
    let divisions = 1;
    let measureNum = 0;
    let currentTime = 0; // in beats
    let keyFifths = 0;

    // Get key signature
    const keyElem = doc.querySelector('key > fifths');
    if (keyElem) keyFifths = parseInt(keyElem.textContent);

    measures.forEach((measure) => {
      measureNum++;
      const measureStart = currentTime;
      const noteElems = measure.querySelectorAll('note');
      let posInMeasure = 0;

      noteElems.forEach((note) => {
        if (note.querySelector('rest')) return;
        if (note.querySelector('chord')) {
          posInMeasure -= getNoteDuration(note, divisions);
        }
        const step = note.querySelector('pitch > step')?.textContent || 'C';
        const octave = parseInt(note.querySelector('pitch > octave')?.textContent || '4');
        const alter = parseInt(note.querySelector('pitch > alter')?.textContent || '0');
        const duration = getNoteDuration(note, divisions);
        const midi = stepToMidi(step, octave, alter);
        notes.push({
          midi,
          beat: measureStart + posInMeasure,
          duration: duration,  // in beats
        });
        posInMeasure += duration;
      });

      // Each measure is 4 beats (4/4 assumed)
      currentTime += 4;
    });

    return { bpm, notes, keyFifths };
  }

  function getNoteDuration(note, divisions) {
    const dur = note.querySelector('duration')?.textContent;
    if (!dur) return 1; // default to quarter
    return parseFloat(dur) / divisions;
  }

  function stepToMidi(step, octave, alter) {
    const stepMap = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    return 12 * (octave + 1) + stepMap[step] + (alter || 0);
  }

  // Clean an exercise title for display in the player header. The
  // source titles sometimes carry trailing "  . . . N" page numbers
  // or repeated dots from the original PDF extraction; collapse
  // those so the header reads cleanly.
  //   "Major 3rds with neighbor notes, ascending in minor 3rds"
  //   "Diatonic 6ths with neighbor notes, descending ... 9"
  //   "II V I phrase using stacked 4ths a half step apart, descending chromatically"
  function cleanExerciseTitle(raw) {
    if (!raw) return '';
    let t = String(raw);
    // Strip trailing page numbers like " 9" or " 23" that follow ellipses.
    t = t.replace(/\s*\.\s*\.+(\s+\d+)?\s*$/, '');
    // Collapse runs of dots to a single ellipsis with surrounding spaces.
    t = t.replace(/\s*\.(\s*\.)+\s*/g, ' ... ');
    // Tidy double spaces and trim.
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  }

  // ===== Cycle (adds bars across keys) =====
  // When the user picks a Cycle mode other than 'off' and Bars > 1, the
  // current exercise is repeated Bars times during playback, each repetition
  // transposed by `step * i` semitones. The original (transposed by the
  // Transpose dropdown) is iteration 0.
  const CYCLE_STEP = {
    chromatic: 1,
    min3: 3,
    '4ths': 5,
    '5ths': 7,
  };

  // Per-instrument playable MIDI range (concert pitch). Notes outside the
  // range are dropped during the cycle so the transposed pattern stays
  // physically playable on the selected horn.
  // Standard ranges pulled from common method books.
  const INSTRUMENT_RANGES = {
    concert:  { min: 21, max: 108 }, // full piano — no clamp
    soprano:  { min: 56, max: 100 }, // Ab3–E6 (concert), Bb soprano
    alto:     { min: 49, max: 81 },  // Db3–A5 (concert), Eb alto
    tenor:    { min: 44, max: 76 },  // Ab2–E5 (concert), Bb tenor
    bari:     { min: 36, max: 69 },  // Db2–A4 (concert), Eb bari
    trumpet:  { min: 52, max: 84 },  // E3–C6 (concert), Bb trumpet
    clarinet: { min: 50, max: 95 },  // D3–Bb6 (concert), Bb clarinet (low E is rare)
    bass:     { min: 43, max: 55 },  // G2–G3 (concert), bass — concert pitch, bass clef
  };

  const CYCLE_MODE_LABELS = {
    off: 'Off',
    chromatic: 'Chromatic',
    min3: 'Minor 3rds',
    '4ths': 'In 4ths',
    '5ths': 'In 5ths',
  };

  // Build a sequence of 12 semitone offsets for the given mode (mod 12).
  function cycleKeySequence(mode) {
    if (mode === 'off' || mode == null) return [0];
    const step = CYCLE_STEP[mode];
    if (step == null) return [0];
    const seq = [];
    let s = 0;
    for (let i = 0; i < 12; i++) {
      seq.push(s);
      s = (s + step) % 12;
    }
    return seq;
  }

  // Returns { notes, dropped } where dropped is the count of notes that
  // fell outside the instrument's playable range.
  function buildCycleNotes(originalNotes, mode, bars, instrument) {
    const stats = { dropped: 0, kept: 0, lastKey: 0 };
    if (mode === 'off' || bars <= 1) {
      stats.kept = originalNotes.length;
      return { notes: originalNotes, stats };
    }
    const step = CYCLE_STEP[mode];
    if (step == null) {
      stats.kept = originalNotes.length;
      return { notes: originalNotes, stats };
    }
    const range = INSTRUMENT_RANGES[instrument] || INSTRUMENT_RANGES.concert;
    const passLen = Math.max(
      ...originalNotes.map(n => n.beat + n.duration),
    );
    // Use the mod-12 key sequence so all 12 transpositions land on unique
    // keys (e.g. 5ths: 0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5) — the pattern
    // stays in the same register rather than climbing off the horn.
    const seq = cycleKeySequence(mode);
    const out = [];
    for (let i = 0; i < bars; i++) {
      const shift = seq[i] || 0;
      stats.lastKey = shift;
      const offset = i * passLen;
      for (const n of originalNotes) {
        const m = n.midi + shift;
        if (m < range.min || m > range.max) {
          stats.dropped++;
        } else {
          out.push({
            midi: m,
            beat: n.beat + offset,
            duration: n.duration,
          });
          stats.kept++;
        }
      }
    }
    return { notes: out, stats };
  }

  // ===== Verovio rendering =====
  function renderAtScale() {
    if (!state.verovio || !state.rawXml) return;
    const container = state.fullPage
      ? document.getElementById('fullpage-score')
      : document.getElementById('score-container');
    if (!container) return;
    try {
      const opts = {
        scale: state.zoomScale,
        // Server inserts <print new-system="yes"/> every 4 measures, so
        // we just respect the print marks here.
        breaks: 'auto',
        adjustPageHeight: true,
        justifyVertically: false,
        spacingSystem: 6,
        spacingStaff: 2,
      };
      if (state.fullPage) {
        opts.pageWidth = 1800;
        opts.pageHeight = 2400;
      } else {
        // Match the inline score-container width
        opts.pageWidth = 1263;
        opts.pageHeight = 1500;
      }
      state.verovio.setOptions(opts);
      state.verovio.loadData(state.rawXml);
      try {
        state.zoomPageCount = state.verovio.getPageCount();
      } catch (e) {
        state.zoomPageCount = 1;
      }
      if (state.zoomPage > state.zoomPageCount) {
        state.zoomPage = state.zoomPageCount;
      }
      const svg = state.verovio.renderToSVG(state.zoomPage, {});
      container.innerHTML = svg;
      // Fallback: if the served MusicXML was broken upstream (Audiveris
      // extraction produced a stub), Verovio renders an SVG with no notes.
      // The static PNG (rendered directly from the source PDF) still has the
      // real notation, so swap to it. Triggered for the 6 known-broken
      // exercises (17, 79, 132, 152, 168, 229) whose served MusicXML
      // contains <3 note elements total. Static PNG does NOT respect
      // transpose/cycle/range, but it's still better than empty staff.
      const sourceNoteCount = (state.rawXml || '').match(/<note\b/g)?.length || 0;
      if (sourceNoteCount < 3 && state.currentId) {
        const fallback = document.createElement('div');
        fallback.className = 'score-fallback';
        fallback.innerHTML =
          '<div class="score-fallback-banner">' +
          'Source image shown — MusicXML for this exercise is incomplete ' +
          '(upstream Audiveris extraction). Transpose / cycle / range are ' +
          'not applied to the image.' +
          '</div>' +
          '<img src="../exercises_images/' +
          String(state.currentId).padStart(4, '0') +
          '.png" alt="Exercise ' + state.currentId + ' notation" />';
        container.innerHTML = '';
        container.appendChild(fallback);
      }
      const pageEl = document.getElementById('zoom-page-indicator');
      if (pageEl) {
        pageEl.textContent = state.zoomPageCount > 1
          ? `${state.zoomPage} / ${state.zoomPageCount}`
          : '';
      }
      const labelEl = document.getElementById('zoom-label');
      if (labelEl) labelEl.textContent = state.zoomScale + '%';
      const prevBtn = document.getElementById('zoom-prev-page');
      const nextBtn = document.getElementById('zoom-next-page');
      if (prevBtn) prevBtn.disabled = state.zoomPage <= 1;
      if (nextBtn) nextBtn.disabled = state.zoomPage >= state.zoomPageCount;
    } catch (e) {
      console.error('Verovio render error:', e);
      container.innerHTML = `<div class="score-loading">Failed to render notation: ${e.message}</div>`;
    }
  }

  async function renderScore(xmlString) {
    const container = document.getElementById('score-container');
    if (!state.verovio) {
      try {
        state.verovio = new verovio.toolkit();
      } catch (e) {
        container.innerHTML = '<div class="score-loading">Notation engine failed to load. Check your internet connection (Verovio CDN).</div>';
        return;
      }
    }
    state.rawXml = xmlString;
    state.zoomPage = 1;
    renderAtScale();
    state.currentScore = parseMusicXML(xmlString);
    // Index the rendered SVG notes by horizontal position so the playback
    // engine can highlight them in sync. Verovio's id attrs are timestamp-
    // based and not stable across renders, so we go by SVG X position.
    // Guard against cached-old JS where this helper isn't yet defined.
    if (typeof indexScoreNotePositions === 'function') {
      indexScoreNotePositions();
    }
  }

  // Cancel any in-flight MIDI playback and reset the Play/Stop button
  // state. Defined up here (above loadExercise) so it's hoisted and
  // definitely available when loadExercise runs. Called when navigating
  // to a different exercise so notes from the previous one don't bleed
  // into the new score. NOTE: defensive guards for the playback
  // helpers (clearNoteHighlights, highlightNote, indexScoreNotePositions)
  // — the real definitions live later in the file. Function declarations
  // ARE hoisted in JS, but the Python http.server sends no Cache-Control
  // headers, so browsers may still be running an older cached practice.js
  // that pre-dates the helpers. Each call site is guarded; inline stubs
  // below give the cached-old JS a working no-op so the page still loads.
  function stopPlayback() {
    const eng = window.playbackEngine;
    if (eng) {
      try { eng.stop(); } catch (e) {}
    }
    if (typeof clearNoteHighlights === 'function') clearNoteHighlights();
    const playBtn = document.getElementById('btn-playback-play');
    const stopBtn = document.getElementById('btn-playback-stop');
    if (playBtn) playBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;
    const statusEl = document.getElementById('playback-status');
    if (statusEl) {
      statusEl.textContent = 'ready';
      statusEl.className = 'playback-status';
    }
  }
  // Inline fallback definitions for the cached-old-JS scenario.
  // The real implementations later in the file override these via
  // function-declaration hoisting (the last declaration wins).
  function clearNoteHighlights() {
    const els = document.querySelectorAll('#score-container g.note.active');
    for (const el of els) el.classList.remove('active');
  }
  function highlightNote(/* note, on */) {}
  function indexScoreNotePositions() {}
  function applyFavoriteState(/* btn, isFav */) {}

  function zoomIn() {
    state.zoomScale = Math.min(120, state.zoomScale + 10);
    renderAtScale();
  }
  function zoomOut() {
    state.zoomScale = Math.max(20, state.zoomScale - 10);
    renderAtScale();
  }
  function pagePrev() {
    if (state.zoomPage > 1) {
      state.zoomPage--;
      renderAtScale();
    }
  }
  function pageNext() {
    if (state.zoomPage < state.zoomPageCount) {
      state.zoomPage++;
      renderAtScale();
    }
  }
  function toggleFullPage() {
    state.fullPage = !state.fullPage;
    const overlay = document.getElementById('fullpage-overlay');
    if (overlay) {
      overlay.style.display = state.fullPage ? 'flex' : 'none';
      if (state.fullPage) renderAtScale();
    }
  }
  function closeFullPage() {
    state.fullPage = false;
    const overlay = document.getElementById('fullpage-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  // ===== Data loading =====
  async function loadExercises() {
    const r = await fetch('../exercises.json');
    const db = await r.json();
    state.exercises = db.exercises;
    state.sections = db.sections_defined || [];
    state.byId = {};
    state.exercises.forEach((e) => state.byId[e.id] = e);
    document.getElementById('total-count').textContent = db.total_exercises;
  }

  async function loadExercise(id) {
    stop(); // stop any playing (audio recorder)
    // Also stop the MIDI playback engine so notes from the previous
    // exercise don't continue sounding under the new score.
    stopPlayback();

    // Etude load path: client-side stitched MusicXML from IndexedDB.
    // Etude IDs are prefixed "etude_" and don't exist in exercises.json,
    // so we branch out before the favorites/exercises.json lookups and
    // skip the cycle/range-clamp flow (etudes are baked-in final scores).
    if (typeof id === 'string' && id.indexOf('etude_') === 0) {
      await loadEtude(id);
      return;
    }

    state.currentId = id;
    // Check favorite status
    if (state.currentId) {
      try {
        const r = await fetch(`../api/favorites/${id}`);
        if (r.ok) {
          const d = await r.json();
          const favBtn = document.getElementById('btn-favorite');
          applyFavoriteState(favBtn, !!d.favorited);
        }
      } catch (e) {
        console.error('Favorite check failed:', e);
      }
    }
    const ex = state.byId[id];
    if (!ex) {
      console.error('Exercise not found:', id);
      return;
    }
    document.getElementById('ex-num').textContent = `#${id}`;
    // The full exercise title (e.g. "Major 3rds with neighbor notes,
    // ascending in minor 3rds") is shown in the player header so
    // the user can identify the exercise without scanning to the
    // score. Source titles sometimes carry trailing "...  N" page
    // numbers from the original PDF extraction; strip those and
    // collapse repeated dots into a single ellipsis so the header
    // reads cleanly.
    document.getElementById('ex-title').textContent = cleanExerciseTitle(ex.title);
    document.getElementById('ex-section').textContent = `§${ex.section}`;
    document.getElementById('ex-page').textContent = `p.${ex.page}`;

    // Update URL without reload
    const newUrl = new URL(window.location);
    newUrl.searchParams.set('id', id);
    window.history.replaceState({}, '', newUrl);

    // Load and render MusicXML
    const instrument = document.getElementById('instrument').value;
    const transpose = document.getElementById('transpose').value;
    document.getElementById('score-container').innerHTML = '<div class="score-loading">Loading notation…</div>';
    // Send the active instrument's effective range (saved-or-preset).
    // The per-instrument range lives in window.rangeInfo (legacy) or
    // window.getEffectiveRange(instrument) (current). The latter is the
    // authoritative source for "what range does this instrument use right
    // now"; window.rangeInfo is kept in sync for downstream listeners.
    let rangeParams = '';
    if (typeof window.getEffectiveRange === 'function') {
      const r = window.getEffectiveRange(instrument);
      if (r && typeof r.lowMidi === 'number' && typeof r.highMidi === 'number') {
        rangeParams = `&low=${r.lowMidi}&high=${r.highMidi}`;
      }
    } else if (window.rangeInfo && typeof window.rangeInfo.lowMidi === 'number') {
      rangeParams = `&low=${window.rangeInfo.lowMidi}&high=${window.rangeInfo.highMidi}`;
    }
    try {
      const url = `../api/musicxml/${id}?instrument=${instrument}&transpose=${transpose}${rangeParams}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const xml = await r.text();
      await renderScore(xml);
    } catch (e) {
      document.getElementById('score-container').innerHTML =
        `<div class="score-loading">Could not load MusicXML for this exercise.<br><small>${e.message}</small></div>`;
    }

    // Update queue active state
    renderQueue();
    // Fetch practice history for this exercise
    loadExerciseHistory(id);
    // Re-evaluate cycle against the new score + instrument range
    if (typeof applyCycle === 'function') applyCycle();
  }

  // Etude loader: reads the stitched MusicXML from IndexedDB and renders
  // it through Verovio. Skips the favorites API, exercises.json lookup,
  // cycle/range-clamp, and practice-history fetch — an etude is its own
  // finished piece (no source exercises, no range to clamp against).
  async function loadEtude(id) {
    if (!window.etudesStore) {
      document.getElementById('score-container').innerHTML =
        '<div class="score-loading">Etudes store unavailable. Reload the page.</div>';
      return;
    }
    let etude;
    try {
      etude = await window.etudesStore.getEtude(id);
    } catch (e) {
      console.error('Etude load failed:', e);
      document.getElementById('score-container').innerHTML =
        '<div class="score-loading">Could not load etude.</div>';
      return;
    }
    if (!etude) {
      document.getElementById('score-container').innerHTML =
        '<div class="score-loading">Etude not found in this browser. It was saved on another device or the storage was cleared.</div>';
      return;
    }
    state.currentId = id;
    // Update URL without reload
    const newUrl = new URL(window.location);
    newUrl.searchParams.set('id', id);
    window.history.replaceState({}, '', newUrl);

    document.getElementById('ex-num').textContent = '';
    document.getElementById('ex-title').textContent = etude.name || 'Etude';
    document.getElementById('ex-section').textContent = 'Etudes';
    // Pattern-generated etudes have no exerciseIds (mode='pattern'); show
    // the source label instead. Stitched etudes always have a count.
    var exCount = (etude.exerciseIds || []).length;
    var sourceLabel = etude.source === 'pattern' ? 'pattern-generated'
      : etude.source === 'composer' ? 'composed' : 'random';
    var label = exCount > 0
      ? exCount + ' exercises · ' + (etude.noteCount || 0) + ' notes'
      : sourceLabel + ' · ' + (etude.noteCount || 0) + ' notes';
    document.getElementById('ex-page').textContent = label;

    // Etudes CAN be favorited (server-side). Show the star and load
    // its current state. The favorite API now accepts string IDs.
    const favBtn = document.getElementById('btn-favorite');
    if (favBtn) {
      favBtn.style.visibility = '';
      applyFavoriteState(favBtn, false);  // optimistic default
      try {
        const r = await fetch(`../api/favorites/${encodeURIComponent(id)}`);
        if (r.ok) {
          const d = await r.json();
          applyFavoriteState(favBtn, !!d.favorited);
        }
      } catch (e) {
        console.error('Favorite check failed:', e);
      }
    }

    document.getElementById('score-container').innerHTML = '<div class="score-loading">Loading notation…</div>';
    try {
      await renderScore(etude.musicxml);
    } catch (e) {
      document.getElementById('score-container').innerHTML =
        '<div class="score-loading">Could not render etude.<br><small>' + e.message + '</small></div>';
    }
    // No queue / history / cycle for etudes (they're finished pieces).
    const queueEl = document.getElementById('session-queue');
    if (queueEl) queueEl.innerHTML = '<p class="muted">Etudes don\'t use the queue.</p>';
    const recentEl = document.getElementById('recent-list');
    if (recentEl) recentEl.innerHTML = '<p class="muted">No practice log for etudes yet.</p>';
  }

  async function loadExerciseHistory(id) {
    try {
      const r = await fetch(`../api/practice/exercise/${id}?limit=5`);
      const data = await r.json();
      const recentEl = document.getElementById('recent-list');
      if (data.history && data.history.length > 0) {
        recentEl.innerHTML = `
          <h4 style="font-size: 13px; margin: 8px 0 4px; color: var(--ink-600);">This exercise:</h4>
          ${data.history.map(formatRecentItem).join('')}
          <p class="hint" style="margin-top: 8px;">
            ${data.summary.times_practiced} sessions, best tempo: ${data.summary.best_tempo || '—'}
          </p>
        `;
      } else {
        recentEl.innerHTML = `<h4 style="font-size: 13px; margin: 8px 0 4px; color: var(--ink-600);">This exercise:</h4><p class="hint">Not practiced yet.</p>`;
      }
      // Wire up delete buttons
      recentEl.querySelectorAll('button.delete-log').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const logId = btn.dataset.logId;
          if (!confirm('Delete this practice entry?')) return;
          try {
            const r = await fetch(`../api/practice/${logId}`, { method: 'DELETE' });
            if (r.ok) {
              btn.closest('.recent-item').remove();
            } else {
              alert('Failed to delete entry');
            }
          } catch (err) {
            console.error('Delete failed:', err);
            alert('Delete failed: ' + err.message);
          }
        });
      });
    } catch (e) {
      console.error(e);
    }
  }

  function formatRecentItem(r) {
    const date = new Date(r.practiced_at);
    const dateStr = date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dur = r.duration_min ? `${r.duration_min}m` : '—';
    return `
      <div class="recent-item" data-log-id="${r.id}">
        <span class="ri-num">#${r.exercise_id}</span>
        <span class="ri-title">${r.notes || '—'}</span>
        <span class="ri-meta">${r.tempo_bpm || '—'}bpm · ${dur}</span>
        <span class="ri-date" title="${r.practiced_at}">${dateStr} ${timeStr}</span>
        <button class="delete-log" data-log-id="${r.id}" title="Delete this entry">×</button>
      </div>
    `;
  }

  // ===== Queue =====
  function renderQueue() {
    const list = document.getElementById('queue-list');
    document.getElementById('queue-count').textContent = state.queue.length;
    if (state.queue.length === 0) {
      list.innerHTML = '<div class="empty-state"><div class="empty-icon">🎷</div>No exercises queued yet.<br><a class="empty-cta" href="../">Browse the library →</a></div>';
      return;
    }
    list.innerHTML = state.queue.map((id, idx) => {
      const ex = state.byId[id];
      if (!ex) return '';
      return `
        <div class="queue-item ${id === state.currentId ? 'active' : ''}" data-id="${id}">
          <span class="qi-num">#${id}</span>
          <span class="qi-title">${ex.title}</span>
          <button class="qi-btn" data-action="jump" data-idx="${idx}" title="Jump to">▶</button>
          <button class="qi-btn danger" data-action="remove" data-idx="${idx}" title="Remove">×</button>
        </div>
      `;
    }).join('');
    list.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx, 10);
        const action = btn.dataset.action;
        if (action === 'jump') {
          loadExercise(state.queue[idx]);
        } else if (action === 'remove') {
          state.queue.splice(idx, 1);
          localStorage.setItem('practice_queue', JSON.stringify(state.queue));
          renderQueue();
        }
      });
    });
    list.querySelectorAll('.queue-item').forEach((el) => {
      el.addEventListener('click', () => loadExercise(parseInt(el.dataset.id, 10)));
    });
  }

  // ===== Recent practice =====
  async function loadRecent() {
    try {
      const r = await fetch('../api/practice/recent?days=7&limit=15');
      const data = await r.json();
      const list = document.getElementById('recent-list');
      const recentAll = data.practice || [];
      // Filter to "all recent" - exclude the current exercise (it's shown above)
      const otherRecent = recentAll.filter((p) => p.exercise_id !== state.currentId);
      const html = otherRecent.length > 0
        ? otherRecent.slice(0, 8).map((r) => formatRecentItem(r)).join('')
        : '<div class="empty-state"><div class="empty-icon">🎵</div>No other practice logged yet.</div>';
      // Only update the bottom part (after the "This exercise" section)
      const existing = list.querySelector('h4');
      if (existing) {
        existing.insertAdjacentHTML('afterend',
          `<h4 style="font-size: 13px; margin: 12px 0 4px; color: var(--ink-600);">Other recent:</h4>${html}`
        );
      } else {
        list.innerHTML = html;
      }
    } catch (e) {
      console.error(e);
    }
  }

  // ===== Collections =====
  async function loadCollections() {
    try {
      const r = await fetch('../api/collections');
      const data = await r.json();
      const list = document.getElementById('collections-list');
      const cols = data.collections || [];
      if (cols.length === 0) {
        list.innerHTML = '<div class="empty-state"><div class="empty-icon">📚</div>No collections yet.<br>Group exercises by topic, key, or routine.</div>';
        return;
      }
      list.innerHTML = cols.map((c) => `
        <div class="collection-item" data-id="${c.id}">
          <span class="ci-num">§${c.id}</span>
          <span class="ci-title">${c.name}</span>
          <span class="ci-count">${c.exercise_count}</span>
        </div>
      `).join('');
      list.querySelectorAll('.collection-item').forEach((el) => {
        el.addEventListener('click', async () => {
          const id = parseInt(el.dataset.id, 10);
          const r = await fetch(`../api/collections/${id}`);
          const col = await r.json();
          // Replace queue with this collection
          state.queue = col.exercises || [];
          localStorage.setItem('practice_queue', JSON.stringify(state.queue));
          renderQueue();
          if (state.queue.length > 0) {
            loadExercise(state.queue[0]);
          }
        });
      });
    } catch (e) {
      console.error(e);
    }
  }

  // ===== Practice logging =====
  // ===== Recording (timed practice session) =====
  // Tracks wall-clock time + which exercises were visited while recording.
  // On stop, posts a single /api/practice log for the exercise that was
  // active when the user clicked Stop, with duration_min derived from elapsed
  // seconds. (If we wanted per-exercise splits we'd batch POST — kept simple
  // here so the server schema doesn't need a new "session group" concept.)

  // Friendly key names for each semitone offset from original (matches the
  // <select id="transpose"> options in index.html: 0=Original, then the
  // listed offsets mod 12 cycle around the circle of fifths).
  const TRANSPOSE_OFFSET_NAMES = {
    1: 'Db', 2: 'D', 3: 'Eb', 4: 'E', 5: 'F',
    6: 'Gb', 7: 'G', 8: 'Ab', 9: 'A', 10: 'Bb', 11: 'B',
  };

  function fmtTimer(secs) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  // ===== Audio recording (microphone) =====
  // Records what the user plays/sings while they practice, draws a live
  // waveform, and offers the finished take as a downloadable file. State is
  // independent of the timed practice recorder above — both can run in
  // parallel if the user wants.

  function pickRecorderMime() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    if (typeof MediaRecorder === 'undefined') return null;
    for (const m of candidates) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {}
    }
    return '';
  }

  function extForMime(mime) {
    if (!mime) return 'webm';
    if (mime.indexOf('webm') !== -1) return 'webm';
    if (mime.indexOf('ogg') !== -1) return 'ogg';
    if (mime.indexOf('mp4') !== -1) return 'm4a';
    return 'bin';
  }

  function setAudioRecUI(phase) {
    // phase ∈ {idle, recording, ready}
    const recBtn = document.getElementById('btn-audio-rec');
    const stopBtn = document.getElementById('btn-audio-stop');
    const dl = document.getElementById('audio-download');
    if (recBtn) {
      recBtn.disabled = phase === 'recording';
      recBtn.classList.toggle('recording', phase === 'recording');
      recBtn.textContent = phase === 'recording' ? '● Recording' : '🎙 Rec';
    }
    if (stopBtn) stopBtn.disabled = phase !== 'recording';
    if (phase !== 'ready' && dl) dl.style.display = 'none';
  }

  function drawIdleWaveform() {
    const canvas = document.getElementById('audio-waveform');
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    // Subtle dark backdrop so the idle line is visible
    ctx.fillStyle = '#0f1117';
    ctx.fillRect(0, 0, w, h);
    // Centered brass-tinted horizontal line
    ctx.strokeStyle = 'rgba(228, 189, 86, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(8, h / 2);
    ctx.lineTo(w - 8, h / 2);
    ctx.stroke();
    // Small "READY" caption centered on the canvas
    ctx.fillStyle = 'rgba(228, 189, 86, 0.55)';
    ctx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('READY', w / 2, h / 2 - 8);
  }

  function renderWaveformLoop() {
    const r = state.audioRec;
    if (!r.active) return;
    const canvas = document.getElementById('audio-waveform');
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    const analyser = r.analyser;
    if (!analyser) return;

    const bufLen = analyser.fftSize;
    const data = new Uint8Array(bufLen);
    analyser.getByteTimeDomainData(data);

    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = 'rgba(20, 22, 28, 0.55)'; // matches card bg
    ctx.fillRect(0, 0, w, h);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#d97706'; // brass accent
    ctx.beginPath();

    const step = Math.max(1, Math.floor(bufLen / w));
    for (let x = 0; x < w; x++) {
      // average a slice of samples so the waveform fills the canvas
      let min = 255, max = 0;
      const start = x * step;
      const end = Math.min(bufLen, start + step);
      for (let i = start; i < end; i++) {
        const v = data[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const yMin = ((min - 128) / 128) * (h / 2) + (h / 2);
      const yMax = ((max - 128) / 128) * (h / 2) + (h / 2);
      ctx.moveTo(x + 0.5, yMin);
      ctx.lineTo(x + 0.5, Math.max(yMax, yMin + 0.5));
    }
    ctx.stroke();

    // tick the timer text
    if (r.startedAt) {
      const t = document.getElementById('audio-timer');
      if (t) t.textContent = fmtTimer(Math.floor((Date.now() - r.startedAt) / 1000));
    }
    r.rafId = requestAnimationFrame(renderWaveformLoop);
  }

  async function startAudioRecording() {
    const r = state.audioRec;
    if (r.active) return;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      alert('Microphone API not available in this browser.');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      alert('Microphone access denied or unavailable: ' + e.message);
      return;
    }
    const mime = pickRecorderMime();
    let recorder;
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (e) {
      alert('Audio recording not supported: ' + e.message);
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    r.mediaStream = stream;
    r.mediaRecorder = recorder;
    r.chunks = [];
    r.blobMime = recorder.mimeType || mime || 'audio/webm';
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) r.chunks.push(ev.data);
    };
    recorder.onstop = () => finishAudioRecording();
    recorder.onerror = (ev) => {
      console.error('MediaRecorder error', ev);
      alert('Recording error.');
      cleanupAudioRecording();
      setAudioRecUI('idle');
      drawIdleWaveform();
    };

    // Set up AnalyserNode for the live waveform. We need an AudioContext.
    // Playback synth was removed; create a transient one just for the
    // analyser/meter.
    let ctx = null;
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch { ctx = null; }
    r.audioCtx = ctx;
    if (ctx) {
      try {
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.6;
        src.connect(analyser);
        // Don't connect to destination — we don't want to echo mic back.
        r.analyser = analyser;
      } catch (e) {
        console.warn('analyser setup failed', e);
        r.analyser = null;
      }
    }

    try {
      recorder.start(250); // 250ms timeslice
    } catch (e) {
      alert('Could not start recording: ' + e.message);
      cleanupAudioRecording();
      setAudioRecUI('idle');
      return;
    }
    r.active = true;
    r.startedAt = Date.now();
    setAudioRecUI('recording');
    drawIdleWaveform();
    r.rafId = requestAnimationFrame(renderWaveformLoop);
  }

  function stopAudioRecording() {
    const r = state.audioRec;
    if (!r.active) return;
    try {
      if (r.mediaRecorder && r.mediaRecorder.state !== 'inactive') {
        r.mediaRecorder.stop();
      } else {
        finishAudioRecording();
      }
    } catch (e) {
      console.error('stop failed', e);
      cleanupAudioRecording();
      setAudioRecUI('idle');
      drawIdleWaveform();
    }
  }

  function finishAudioRecording() {
    const r = state.audioRec;
    if (r.rafId) { cancelAnimationFrame(r.rafId); r.rafId = null; }
    const elapsedMs = r.startedAt ? (Date.now() - r.startedAt) : 0;
    r.lastDurationMs = elapsedMs;
    r.active = false;
    r.startedAt = null;

    // Build a Blob + object URL for download + inline playback.
    if (r.blobUrl) { try { URL.revokeObjectURL(r.blobUrl); } catch {} r.blobUrl = null; }
    const blob = new Blob(r.chunks, { type: r.blobMime || 'audio/webm' });
    r.blobUrl = URL.createObjectURL(blob);
    const ext = extForMime(r.blobMime);
    const eid = state.currentId || 'session';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dl = document.getElementById('audio-download');
    if (dl) {
      dl.href = r.blobUrl;
      dl.download = `bob-mover-${eid}-${ts}.${ext}`;
      dl.textContent = `⬇ Download (${fmtTimer(Math.floor(elapsedMs / 1000))})`;
      dl.style.display = '';
    }

    // Wire the inline <audio> player to the same object URL.
    const player = document.getElementById('audio-player');
    if (player) {
      try { player.pause(); } catch {}
      player.src = r.blobUrl;
      player.style.display = '';
      // Reload so metadata (duration) loads — controls then show length.
      try { player.load(); } catch {}
    }

    // Persist to IndexedDB so it survives reload, then refresh the list.
    saveTakeToStore(blob, eid, elapsedMs, r.blobMime, ext).then(function () {
      renderTakesList();
    }).catch(function (err) {
      console.error('take save failed', err);
    });

    cleanupAudioRecording(/*keepBlob=*/true);
    setAudioRecUI('ready');

    // freeze the final waveform (last frame stays visible)
    const t = document.getElementById('audio-timer');
    if (t) t.textContent = fmtTimer(Math.floor(elapsedMs / 1000));
  }

  // Save a finished take to IndexedDB. Swallows + logs errors so the
  // download path still works even if storage is full / blocked.
  async function saveTakeToStore(blob, exerciseId, durationMs, mime, ext) {
    if (!window.takesStore) return;
    const record = {
      exerciseId: exerciseId,
      durationMs: durationMs,
      mime: mime,
      size: blob.size,
      ext: ext,
      createdAt: new Date().toISOString(),
      blob: blob,
    };
    return window.takesStore.addTake(record);
  }

  // Render the "My Takes" side panel. Builds object URLs on the fly from
  // stored Blobs; revokes them on next render to avoid leaks.
  let _takeUrls = [];
  function renderTakesList() {
    const list = document.getElementById('takes-list');
    const countEl = document.getElementById('takes-count');
    if (!list || !window.takesStore) return;
    // Revoke any prior URLs we own before re-rendering.
    _takeUrls.forEach((u) => { try { URL.revokeObjectURL(u); } catch {} });
    _takeUrls = [];
    window.takesStore.listTakes().then(function (all) {
      // Newest first.
      all.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
      if (countEl) countEl.textContent = all.length;
      if (all.length === 0) {
        list.innerHTML = '<div class="empty-state"><div class="empty-icon">🎙</div>No takes yet. Hit Rec to capture one.</div>';
        return;
      }
      list.innerHTML = all.map(function (t) {
        const url = URL.createObjectURL(t.blob);
        _takeUrls.push(url);
        const dur = fmtTimer(Math.floor(t.durationMs / 1000));
        const date = new Date(t.createdAt);
        const dateStr = date.toLocaleString(undefined, {
          month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
        });
        const eidLabel = t.exerciseId != null ? ('#' + t.exerciseId) : 'session';
        return [
          '<div class="take-item" data-take-id="' + t.id + '">',
            '<audio class="take-player" controls preload="metadata" src="' + url + '"></audio>',
            '<div class="take-meta">',
              '<span class="take-id">#' + t.id + ' · ' + eidLabel + '</span>',
              '<span class="take-dur">' + dur + '</span>',
            '</div>',
            '<div class="take-foot">',
              '<span class="take-date">' + dateStr + '</span>',
              '<button class="take-del" data-take-id="' + t.id + '" title="Delete this take">×</button>',
            '</div>',
          '</div>'
        ].join('');
      }).join('');
      // Wire delete buttons (re-query because innerHTML replaced them).
      list.querySelectorAll('.take-del').forEach(function (btn) {
        btn.addEventListener('click', function () {
          const id = parseInt(btn.dataset.takeId, 10);
          if (!confirm('Delete this take?')) return;
          window.takesStore.deleteTake(id).then(function () { renderTakesList(); });
        });
      });
    });
  }

  function cleanupAudioRecording(keepBlob = false) {
    const r = state.audioRec;
    if (r.mediaStream) {
      r.mediaStream.getTracks().forEach((t) => t.stop());
      r.mediaStream = null;
    }
    r.mediaRecorder = null;
    r.analyser = null;
    r.chunks = [];
    if (!keepBlob && r.blobUrl) {
      try { URL.revokeObjectURL(r.blobUrl); } catch {}
      r.blobUrl = null;
    }
  }

  async function logPractice() {
    if (!state.currentId) return;
    const tempo = parseInt(document.getElementById('log-tempo').value) || null;
    const duration = parseFloat(document.getElementById('log-duration').value) || null;
    const key = document.getElementById('log-key').value || null;
    const notes = document.getElementById('log-notes').value || null;
    const completed = document.getElementById('log-completed').checked;

    try {
      const r = await fetch('../api/practice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exercise_id: state.currentId,
          tempo_bpm: tempo,
          duration_min: duration,
          key_signature: key,
          notes,
          completed,
        }),
      });
      const data = await r.json();
      if (data.ok) {
        const status = document.getElementById('log-status');
        status.textContent = '✓ Logged! Reload to see in history.';
        status.style.color = 'var(--brass-600)';
        // Clear form
        document.getElementById('log-notes').value = '';
        document.getElementById('log-duration').value = '';
        // Refresh history
        loadExerciseHistory(state.currentId);
        loadRecent();
      } else {
        throw new Error(data.error || 'Unknown error');
      }
    } catch (e) {
      const status = document.getElementById('log-status');
      status.textContent = '✗ ' + e.message;
      status.style.color = '#dc2626';
    }
  }

  // ===== Init =====
  async function init() {
    await loadExercises();

    // Get initial exercise from URL or default to #1. Etudes have string IDs
    // ("etude_<uuid>") that aren't in exercises.json, so we keep those as
    // strings and pass them to loadExercise unchanged.
    const url = new URL(window.location);
    const idParam = url.searchParams.get('id');
    let initialId;
    if (idParam && idParam.indexOf('etude_') === 0) {
      initialId = idParam;
    } else {
      initialId = parseInt(idParam || '1', 10);
    }

    // Wire up controls
    document.getElementById('btn-prev').addEventListener('click', () => {
      // Etudes don't have a prev/next — they're finished pieces.
      if (typeof state.currentId === 'string' && state.currentId.indexOf('etude_') === 0) return;
      const idx = state.exercises.findIndex((e) => e.id === state.currentId);
      if (idx > 0) loadExercise(state.exercises[idx - 1].id);
    });
    document.getElementById('btn-next').addEventListener('click', () => {
      if (typeof state.currentId === 'string' && state.currentId.indexOf('etude_') === 0) return;
      const idx = state.exercises.findIndex((e) => e.id === state.currentId);
      if (idx < state.exercises.length - 1) loadExercise(state.exercises[idx + 1].id);
    });
    document.getElementById('instrument').addEventListener('change', () => {
      // Etudes are baked-in final scores; their range is whatever the user
      // chose when generating. Re-rendering them with the active instrument
      // would just cycle through Verovio's clef rendering, not the data.
      if (typeof state.currentId === 'string' && state.currentId.indexOf('etude_') === 0) return;
      if (state.currentId) {
        loadExercise(state.currentId);
        // Re-evaluate cycle against new instrument range
        if (typeof applyCycle === 'function') applyCycle();
      }
    });
    // Favorite button (the star in the player header). Clicking toggles
    // the favorite state on the server and flips the star's visual state.
    // Works for both numeric exercise IDs and string etude IDs
    // (e.g. "etude_<uuid>"). The favorites API now accepts both.
    const favBtn = document.getElementById('btn-favorite');
    if (favBtn) {
      favBtn.addEventListener('click', async () => {
        if (!state.currentId) return;
        // Optimistic UI flip — read current state from the .favorited
        // class so we know which way to send.
        const willFavorite = !favBtn.classList.contains('favorited');
        favBtn.disabled = true;
        try {
          const method = willFavorite ? 'POST' : 'DELETE';
          const r = await fetch(`../api/favorites/${encodeURIComponent(state.currentId)}`, { method });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const d = await r.json();
          applyFavoriteState(favBtn, d.favorited);
        } catch (e) {
          console.error('Favorite toggle failed:', e);
        } finally {
          favBtn.disabled = false;
        }
      });
    }

    // Reflect the server's favorite state on the star button.
  function applyFavoriteState(btn, isFav) {
    if (!btn) return;
    if (isFav) {
      btn.classList.add('favorited');
      btn.textContent = '★';
      btn.title = 'Remove from favorites';
      btn.setAttribute('aria-label', 'Remove from favorites');
    } else {
      btn.classList.remove('favorited');
      btn.textContent = '☆';
      btn.title = 'Add to favorites';
      btn.setAttribute('aria-label', 'Add to favorites');
    }
  }

  document.getElementById('transpose').addEventListener('change', () => {
    // Etudes are baked-in — the user's chosen semitones are part of the
    // stitched MusicXML. Transposing here would only re-render the existing
    // pitches via Verovio, not change the data.
    if (typeof state.currentId === 'string' && state.currentId.indexOf('etude_') === 0) return;
    if (state.currentId) loadExercise(state.currentId);
  });

  // ===== MIDI playback =====
  // Wires the Playback control row (Play/Stop/tempo-slider/metronome) to
  // window.playbackEngine loaded from playback-engine.js. The engine
  // handles the actual audio synthesis; this code is just the UI glue.
  // (stopPlayback is defined above loadExercise for hoisting safety.)

  function wirePlaybackControls() {
    const playBtn  = document.getElementById('btn-playback-play');
    const stopBtn  = document.getElementById('btn-playback-stop');
    const tempo    = document.getElementById('playback-tempo');
    const tempoLbl = document.getElementById('playback-tempo-label');
    const metroBtn = document.getElementById('btn-playback-metronome');
    const statusEl = document.getElementById('playback-status');
    if (!playBtn || !stopBtn) return;

    function setStatus(text, cls) {
      if (!statusEl) return;
      statusEl.textContent = text;
      statusEl.className = 'playback-status' + (cls ? ' ' + cls : '');
    }

    function effectiveBpm() {
      const base = (state.currentScore && state.currentScore.bpm) || 120;
      const pct  = tempo ? (parseInt(tempo.value, 10) || 100) : 100;
      return Math.max(20, Math.round(base * pct / 100));
    }

    function refreshTempoLabel() {
      if (tempoLbl) {
        const pct = tempo ? (parseInt(tempo.value, 10) || 100) : 100;
        tempoLbl.textContent = pct + '%';
      }
    }

    playBtn.addEventListener('click', async () => {
      if (!state.currentScore || !state.currentScore.notes || !state.currentScore.notes.length) {
        setStatus('no notes', 'error');
        return;
      }
      const eng = window.playbackEngine;
      if (!eng) { setStatus('engine missing', 'error'); return; }
      // Tone.js requires the AudioContext to be running before any audio
      // can be heard. On Safari + iOS, the context stays 'suspended'
      // until a user gesture AND until our start() call resolves. We
      // make play() async: kick Tone.start() and wait for the promise
      // to resolve. The current click is the gesture, so this should
      // complete within a single turn. On browsers that auto-resume
      // (e.g. desktop Chrome), the promise resolves immediately.
      const ToneNs = (typeof window !== 'undefined' && window.Tone) || null;
      if (ToneNs && typeof ToneNs.context !== 'undefined' && ToneNs.context.state === 'suspended') {
        try {
          await ToneNs.start();
        } catch (e) {
          // fall through; play() will be a no-op if context still suspended
        }
      }
      // init() lazily creates the AudioContext + synth. Safe to call
      // repeatedly; no-op once initialized.
      eng.init();
      eng.setNotes(state.currentScore.notes, (state.currentScore.bpm || 120));
      eng.setTempo(effectiveBpm());
      const started = eng.play({
        onNote: (n) => highlightNote(n, true),
        onEnd:  () => {
          playBtn.disabled = false;
          stopBtn.disabled = true;
          clearNoteHighlights();
          setStatus('done');
        },
      });
      if (!started) { setStatus('audio blocked', 'error'); return; }
      playBtn.disabled = true;
      stopBtn.disabled = false;
      setStatus('playing', 'playing');
    });

    stopBtn.addEventListener('click', () => {
      const eng = window.playbackEngine;
      if (eng) eng.stop();
      playBtn.disabled = false;
      stopBtn.disabled = true;
      clearNoteHighlights();
      setStatus('ready');
    });

    // Test Sound button: fires window.playbackEngine.testSound() to verify
    // audio output works, independent of the schedule/transport logic. If
    // you don't hear a 4-second 400Hz tone after pressing this, the issue
    // is at the macOS audio layer (system volume, output device, etc.) —
    // not anything in the engine.
    const testBtn = document.getElementById('btn-playback-test');
    if (testBtn) {
      testBtn.addEventListener('click', () => {
        const eng = window.playbackEngine;
        if (!eng) { setStatus('engine missing', 'error'); return; }
        const fired = eng.testSound();
        setStatus(fired ? 'test firing — listen!' : 'test failed', fired ? 'playing' : 'error');
      });
    }

    if (tempo) {
      tempo.addEventListener('input', () => {
        refreshTempoLabel();
        const eng = window.playbackEngine;
        if (eng) eng.setTempo(effectiveBpm());
      });
      refreshTempoLabel();
    }

    if (metroBtn) {
      metroBtn.addEventListener('click', () => {
        const on = !metroBtn.classList.contains('active');
        metroBtn.classList.toggle('active', on);
        metroBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        const eng = window.playbackEngine;
        if (eng) eng.setMetronome(on);
      });
      metroBtn.setAttribute('aria-pressed', 'false');
    }
  }

  // Map every rendered <g class="note"> in the SVG to the beat position
  // that produced it. Verovio emits <g class="note"> in document order,
  // matching parseMusicXML's notes[] array. We capture the SVG X position
  // (bounding-box left edge) and sort by it so a "closest beat to this
  // position" lookup can find the right element when playback fires
  // onNote(note).
  function indexScoreNotePositions() {
    state.scoreNotePositions = [];
    if (!state.currentScore || !state.currentScore.notes || !state.currentScore.notes.length) return;
    const groups = Array.from(document.querySelectorAll('#score-container g.note'));
    if (!groups.length) return;
    const positions = groups.map((el, i) => {
      let x = 0;
      try {
        const bb = el.getBBox();
        if (bb && typeof bb.x === 'number') x = bb.x;
      } catch (e) { /* SVG bbox unavailable in some browsers; ignore */ }
      return {
        x,
        beat: state.currentScore.notes[i] ? state.currentScore.notes[i].beat : 0,
        el,
      };
    });
    positions.sort((a, b) => a.x - b.x);
    state.scoreNotePositions = positions;
  }

  // Highlight the SVG note whose beat is closest to `note.beat`. Called by
  // the playback engine's onNote callback. If the position indexer hasn't
  // run yet (score hasn't rendered), this is a no-op.
  function highlightNote(note, on) {
    // Clear any other notes that may still be highlighted from prior
    // attacks. Monophonic playback — at most one note sounds at a time,
    // so only the matching element should carry .active.
    if (on) {
      const prev = document.querySelectorAll('#score-container g.note.active');
      for (const el of prev) el.classList.remove('active');
    }
    if (!note || !state.scoreNotePositions || !state.scoreNotePositions.length) return;
    let best = state.scoreNotePositions[0];
    let bestDiff = Math.abs(best.beat - note.beat);
    for (let i = 1; i < state.scoreNotePositions.length; i++) {
      const d = Math.abs(state.scoreNotePositions[i].beat - note.beat);
      if (d < bestDiff) { bestDiff = d; best = state.scoreNotePositions[i]; }
    }
    if (!best || !best.el) return;
    if (on) {
      best.el.classList.add('active');
    } else {
      best.el.classList.remove('active');
    }
  }

  // Clear every .active highlight. Called on Stop and on natural end-of-
  // playback (via the engine's onEnd callback).
  function clearNoteHighlights() {
    const els = document.querySelectorAll('#score-container g.note.active');
    for (const el of els) el.classList.remove('active');
  }

  // Render the playback row on page load. Safe to call even before any
  // exercise is loaded — the controls just sit idle.
  wirePlaybackControls();

  // Cycle controls — dropdown/bars are STAGED, then committed by the
    // Apply button. Persisted across sessions.
    const cycleModeSel = document.getElementById('cycle-mode');
    const cycleBarsInp = document.getElementById('cycle-bars');
    const cycleApplyBtn = document.getElementById('cycle-apply');
    const cycleBadge = document.getElementById('cycle-badge');
    state.cycleCommitted = { mode: 'off', bars: 1, key: 0, dropped: 0 };

    function updateBadge(committed) {
      if (!cycleBadge) return;
      const { mode, bars, key, dropped } = committed;
      if (mode === 'off' || bars <= 1) {
        cycleBadge.textContent = 'Cycle off';
        cycleBadge.className = 'cycle-badge off';
      } else {
        const seq = cycleKeySequence(mode).slice(0, bars);
        const lastKey = seq[seq.length - 1] || 0;
        cycleBadge.textContent =
          `Cycle: ${bars}× in ${CYCLE_MODE_LABELS[mode] || mode} ` +
          `(last shift +${lastKey} st)` +
          (dropped > 0 ? ` · ${dropped} dropped` : '');
        cycleBadge.className = 'cycle-badge on';
      }
    }

    async function applyCycle() {
      if (!state.currentId) {
        // No exercise loaded yet — just commit the staged values
        const mode = cycleModeSel ? cycleModeSel.value : 'off';
        const bars = cycleBarsInp ? Math.max(1, Math.min(12, parseInt(cycleBarsInp.value, 10) || 12)) : 1;
        state.cycleCommitted = { mode, bars, key: 0, dropped: 0 };
        updateBadge(state.cycleCommitted);
        return;
      }
      const instr = (document.getElementById('instrument') || {}).value || 'concert';
      const transpose = parseInt((document.getElementById('transpose') || {}).value || '0', 10);
      const mode = cycleModeSel ? cycleModeSel.value : 'off';
      const bars = cycleBarsInp ? Math.max(1, Math.min(12, parseInt(cycleBarsInp.value, 10) || 12)) : 12;
      // User range (from the range modal). If unset, the server falls back
      // to the instrument preset range.
      const userRange = (typeof window.rangeInfo === 'object' && window.rangeInfo)
        ? { low: window.rangeInfo.lowMidi, high: window.rangeInfo.highMidi }
        : {};
      // Disable the Apply button + show pending state
      if (cycleApplyBtn) {
        cycleApplyBtn.disabled = true;
        cycleApplyBtn.textContent = 'Applying…';
      }
      try {
        const r = await fetch(`../api/musicxml/${state.currentId}/cycle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({ mode, bars, instrument: instr, transpose }, userRange)),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({ error: r.statusText }));
          throw new Error(err.error || 'Cycle request failed');
        }
        const xml = await r.text();
        // Re-render the score from the cycled MusicXML. This also re-parses
        // the notes for playback, so state.currentScore.notes will reflect
        // the full extended exercise.
        await renderScore(xml);
        const seq = cycleKeySequence(mode);
        const lastKey = mode === 'off' ? 0 : (seq[Math.min(bars, seq.length) - 1] || 0);
        state.cycleCommitted = { mode, bars, key: lastKey, dropped: 0 };
        // Persist
        try {
          localStorage.setItem('practice_cycle', JSON.stringify({ mode, bars }));
        } catch (e) { /* ignore */ }
        updateBadge(state.cycleCommitted);
      } catch (e) {
        console.error('Cycle apply failed:', e);
        if (cycleBadge) {
          cycleBadge.textContent = 'Apply failed: ' + e.message;
          cycleBadge.className = 'cycle-badge off';
        }
      } finally {
        if (cycleApplyBtn) {
          cycleApplyBtn.disabled = false;
          cycleApplyBtn.textContent = '✓ Apply';
        }
      }
    }

    try {
      const saved = JSON.parse(localStorage.getItem('practice_cycle') || '{}');
      if (saved.mode && cycleModeSel) cycleModeSel.value = saved.mode;
      if (saved.bars && cycleBarsInp) cycleBarsInp.value = saved.bars;
    } catch (e) { /* ignore */ }

    // Re-apply when exercise or instrument changes (since range may differ)
    if (cycleApplyBtn) cycleApplyBtn.addEventListener('click', applyCycle);
    if (cycleModeSel) cycleModeSel.addEventListener('change', applyCycle);
    if (cycleBarsInp) cycleBarsInp.addEventListener('input', applyCycle);
    // Initial commit so the badge reflects the restored state
    applyCycle();
    updateBadge(state.cycleCommitted);
    const audioRecBtn = document.getElementById('btn-audio-rec');
    if (audioRecBtn) audioRecBtn.addEventListener('click', startAudioRecording);
    const audioStopBtn = document.getElementById('btn-audio-stop');
    if (audioStopBtn) audioStopBtn.addEventListener('click', stopAudioRecording);
    // Initialise the idle waveform baseline so the canvas isn't blank.
    setAudioRecUI('idle');
    drawIdleWaveform();

    // Zoom + page controls
    const zOut = document.getElementById('zoom-out');
    const zIn = document.getElementById('zoom-in');
    const pPrev = document.getElementById('zoom-prev-page');
    const pNext = document.getElementById('zoom-next-page');
    const fpOpen = document.getElementById('fullpage-open');
    const fpClose = document.getElementById('fp-close');
    const fpZOut = document.getElementById('fp-zoom-out');
    const fpZIn = document.getElementById('fp-zoom-in');
    const fpPPrev = document.getElementById('fp-prev-page');
    const fpPNext = document.getElementById('fp-next-page');
    if (zOut) zOut.addEventListener('click', zoomOut);
    if (zIn) zIn.addEventListener('click', zoomIn);
    if (pPrev) pPrev.addEventListener('click', pagePrev);
    if (pNext) pNext.addEventListener('click', pageNext);
    if (fpOpen) fpOpen.addEventListener('click', toggleFullPage);
    if (fpClose) fpClose.addEventListener('click', closeFullPage);
    if (fpZOut) fpZOut.addEventListener('click', zoomOut);
    if (fpZIn) fpZIn.addEventListener('click', zoomIn);
    if (fpPPrev) fpPPrev.addEventListener('click', pagePrev);
    if (fpPNext) fpPNext.addEventListener('click', pageNext);
    // Sync the fullpage zoom label to the main one
    const mainZ = document.getElementById('zoom-label');
    const fpZ = document.getElementById('fp-zoom-label');
    if (mainZ && fpZ) {
      new MutationObserver(() => { fpZ.textContent = mainZ.textContent; })
        .observe(mainZ, { childList: true, characterData: true, subtree: true });
    }
    document.getElementById('btn-log').addEventListener('click', logPractice);

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft') {
        // Shift+Left = previous score page, plain Left = previous exercise
        if (e.shiftKey) { e.preventDefault(); pagePrev(); }
        else document.getElementById('btn-prev').click();
      } else if (e.key === 'ArrowRight') {
        if (e.shiftKey) { e.preventDefault(); pageNext(); }
        else document.getElementById('btn-next').click();
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        document.getElementById('btn-prev').click();
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        document.getElementById('btn-next').click();
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomIn();
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomOut();
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        toggleFullPage();
      } else if (e.key === 'Escape') {
        if (state.fullPage) { e.preventDefault(); closeFullPage(); }
      } else if (e.key === ' ' || e.code === 'Space') {
        // Space toggles play/stop on the MIDI player. Don't hijack the
        // spacebar when the user is typing in an input/textarea or any
        // contenteditable region.
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault();
        const playBtn = document.getElementById('btn-playback-play');
        const stopBtn = document.getElementById('btn-playback-stop');
        if (!playBtn || !stopBtn) return;
        // Toggle: if Stop is enabled (i.e. we're playing), click it; otherwise
        // click Play. Disabled buttons in HTML ignore clicks, so this is safe
        // even if both are present.
        if (!stopBtn.disabled) stopBtn.click();
        else playBtn.click();
      } else if (e.key === 'l' || e.key === 'L') {
        logPractice();
      } else if (e.key === 'h' || e.key === 'H') {
        // h = home (first exercise)
        e.preventDefault();
        if (state.exercises.length > 0) loadExercise(state.exercises[0].id);
      } else if (e.key === 'e' || e.key === 'E') {
        // e = end (last exercise)
        e.preventDefault();
        if (state.exercises.length > 0) {
          loadExercise(state.exercises[state.exercises.length - 1].id);
        }
      }
    });

    await loadExercise(initialId);
    await loadRecent();
    await loadCollections();
    renderQueue();
    renderTakesList();
    renderRangeIndicator();
  }

  // Mirror the persisted register range (set by the range-modal first-visit
  // gate) into the Practice page header. Re-runs whenever the modal saves
  // a new range (event: 'range-changed').
  function renderRangeIndicator() {
    var ind = document.getElementById('range-indicator');
    var txt = document.getElementById('range-indicator-text');
    if (!ind || !txt) return;
    var r = window.rangeInfo;
    if (!r || !r.lowName || !r.highName) {
      ind.hidden = true;
      return;
    }
    ind.hidden = false;
    txt.textContent = r.lowName + ' – ' + r.highName;
  }
  window.addEventListener('range-changed', renderRangeIndicator);
  var changeLink = document.getElementById('range-change-link');
  if (changeLink) {
    changeLink.addEventListener('click', function () {
      if (typeof window.openRangeModal === 'function') {
        // Pre-select the currently-playing instrument so the modal opens
        // on that instrument's saved range.
        var cur = document.getElementById('instrument');
        window.openRangeModal({
          preferredInstrument: cur ? cur.value : null
        });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
