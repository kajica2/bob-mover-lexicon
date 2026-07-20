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
    audio: null,
    audioCtx: null,
    isPlaying: false,
    playInterval: null,
    metronomeInterval: null,
  };

  // ===== Audio engine =====
  // A richer synth: 2-op FM (carrier + modulator), lowpass filter envelope,
  // vibrato, and a feedback-delay for ambience. Master gain controls volume.

  function initAudio() {
    if (state.audioCtx) return state.audioCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    state.audioCtx = new Ctx();

    // Master gain (volume slider writes here)
    state.masterGain = state.audioCtx.createGain();
    state.masterGain.gain.value = 0.5;

    // Soft compressor to keep peaks tame
    state.compressor = state.audioCtx.createDynamicsCompressor();
    state.compressor.threshold.value = -18;
    state.compressor.knee.value = 12;
    state.compressor.ratio.value = 4;
    state.compressor.attack.value = 0.003;
    state.compressor.release.value = 0.18;

    // Stereo delay (ambience)
    state.delayL = state.audioCtx.createDelay(1.0);
    state.delayR = state.audioCtx.createDelay(1.0);
    state.delayL.delayTime.value = 0.21;
    state.delayR.delayTime.value = 0.27;
    state.delayFB = state.audioCtx.createGain();
    state.delayFB.gain.value = 0.28;
    const merger = state.audioCtx.createChannelMerger(2);
    state.delayL.connect(merger, 0, 0);
    state.delayR.connect(merger, 0, 1);
    state.delayL.connect(state.delayFB);
    state.delayR.connect(state.delayFB);
    state.delayFB.connect(state.delayL);
    state.delayFB.connect(state.delayR);
    state.delayOut = state.audioCtx.createGain();
    state.delayOut.gain.value = 0.22;
    merger.connect(state.delayOut);

    // Wire master chain
    state.masterGain.connect(state.compressor);
    state.compressor.connect(state.audioCtx.destination);
    state.delayOut.connect(state.compressor);

    return state.audioCtx;
  }

  function playNote(midi, duration = 0.5, time = null, velocity = 0.85) {
    if (!state.audioCtx) return;
    const ctx = state.audioCtx;
    const t = time !== null ? time : ctx.currentTime;
    const freq = midiToFreq(midi);

    // ----- Carrier (triangle — woody, sax-ish) -----
    const carrier = ctx.createOscillator();
    carrier.type = 'triangle';
    carrier.frequency.value = freq;

    // ----- Modulator (sine, octave up, ratio * index = FM brightness) -----
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = freq * 2;
    const modGain = ctx.createGain();
    // Modulation index (FM depth). Higher = brighter/harmonically richer.
    modGain.gain.value = freq * 1.5;
    mod.connect(modGain);
    modGain.connect(carrier.frequency);

    // ----- Sub-oscillator for body (one octave below) -----
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = freq * 0.5;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.35;
    sub.connect(subGain);

    // ----- Mix carrier + sub -----
    const mix = ctx.createGain();
    mix.gain.value = 1.0;
    carrier.connect(mix);
    subGain.connect(mix);

    // ----- Lowpass filter with envelope (mimics breath/articulation) -----
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 4;
    filter.frequency.setValueAtTime(800, t);
    filter.frequency.linearRampToValueAtTime(Math.min(freq * 8, 6000), t + 0.04);
    filter.frequency.exponentialRampToValueAtTime(Math.max(freq * 1.5, 600), t + duration);

    // ----- Amp envelope -----
    const amp = ctx.createGain();
    const peak = 0.32 * velocity;
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(peak, t + 0.015);
    amp.gain.linearRampToValueAtTime(peak * 0.7, t + 0.12); // slight sustain dip
    amp.gain.setValueAtTime(peak * 0.7, t + Math.max(0.12, duration - 0.05));
    amp.gain.exponentialRampToValueAtTime(0.001, t + duration);

    // ----- Vibrato (LFO on carrier frequency, kicks in after 200ms) -----
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 5.5; // ~5.5 Hz vibrato
    const lfoGain = ctx.createGain();
    lfoGain.gain.setValueAtTime(0, t);
    lfoGain.gain.linearRampToValueAtTime(freq * 0.012, t + 0.25);
    lfoGain.gain.setValueAtTime(freq * 0.012, t + Math.max(0.25, duration - 0.1));
    lfoGain.gain.linearRampToValueAtTime(0, t + duration);
    lfo.connect(lfoGain);
    lfoGain.connect(carrier.frequency);

    // ----- Wiring -----
    mix.connect(filter);
    filter.connect(amp);
    // Dry to master
    amp.connect(state.masterGain);
    // Wet to delay taps
    const wetTap = ctx.createGain();
    wetTap.gain.value = 0.35;
    amp.connect(wetTap);
    wetTap.connect(state.delayL);
    wetTap.connect(state.delayR);

    // Start/stop
    carrier.start(t);
    mod.start(t);
    sub.start(t);
    lfo.start(t);
    carrier.stop(t + duration + 0.05);
    mod.stop(t + duration + 0.05);
    sub.stop(t + duration + 0.05);
    lfo.stop(t + duration + 0.05);
  }

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function click(t = null, accent = false) {
    if (!state.audioCtx) return;
    const ctx = state.audioCtx;
    const now = t !== null ? t : ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = accent ? 1500 : 1000;
    const peak = accent ? 0.22 : 0.13;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
    osc.connect(gain);
    gain.connect(state.masterGain);
    osc.start(now);
    osc.stop(now + 0.05);
  }

  function setVolume(v) {
    const vol = Math.max(0, Math.min(100, v)) / 100;
    if (state.masterGain) {
      // Smooth ramp to avoid clicks
      const ctx = state.audioCtx;
      state.masterGain.gain.cancelScheduledValues(ctx.currentTime);
      state.masterGain.gain.setTargetAtTime(vol, ctx.currentTime, 0.02);
    }
  }

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

  // ===== Playback =====
  function play() {
    if (!state.currentScore) return;
    initAudio();
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
    state.isPlaying = true;
    const bpm = parseInt(document.getElementById('tempo').value) || 120;
    const secondsPerBeat = 60 / bpm;

    const notes = state.currentScore.notes;
    if (notes.length === 0) return;

    const useMetronome = document.getElementById('metronome').checked;
    const startTime = state.audioCtx.currentTime + 0.1;

    // Schedule each note
    notes.forEach((n) => {
      const t = startTime + n.beat * secondsPerBeat;
      playNote(n.midi, n.duration * secondsPerBeat * 0.95, t);
    });

    // Metronome — accent on beat 1 of each measure
    if (useMetronome) {
      const totalBeats = Math.max(...notes.map(n => n.beat)) + 4;
      for (let beat = 0; beat <= totalBeats; beat += 4) {
        click(startTime + beat * secondsPerBeat, true);   // accent
        // Optional downbeat clicks for beats 2/3/4
        for (let sub = 1; sub < 4; sub++) {
          click(startTime + (beat + sub) * secondsPerBeat, false);
        }
      }
    }

    // Auto-stop
    const totalDuration = (Math.max(...notes.map(n => n.beat + n.duration)) + 1) * secondsPerBeat * 1000;
    state.playInterval = setTimeout(() => stop(), totalDuration);

    document.getElementById('play-label').textContent = '⏸ Playing…';
    document.getElementById('btn-play').disabled = true;
    document.getElementById('btn-stop').disabled = false;
  }

  function stop() {
    state.isPlaying = false;
    if (state.playInterval) clearTimeout(state.playInterval);
    if (state.metronomeInterval) clearInterval(state.metronomeInterval);
    if (state.audioCtx) state.audioCtx.close().then(() => state.audioCtx = null);
    document.getElementById('play-label').textContent = '▶ Play';
    document.getElementById('btn-play').disabled = false;
    document.getElementById('btn-stop').disabled = true;
  }

  // ===== Verovio rendering =====
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
    try {
      state.verovio.setOptions({
        scale: 50,
        adjustPageHeight: true,
        breaks: 'auto',
      });
      state.verovio.loadData(xmlString);
      const svg = state.verovio.renderToSVG(1, {});
      container.innerHTML = svg;
      // Parse notes for playback
      state.currentScore = parseMusicXML(xmlString);
      // Update tempo field with detected BPM
      if (state.currentScore.bpm && !document.getElementById('tempo').dataset.userSet) {
        document.getElementById('tempo').value = Math.round(state.currentScore.bpm);
      }
    } catch (e) {
      console.error('Verovio render error:', e);
      container.innerHTML = `<div class="score-loading">Failed to render notation: ${e.message}</div>`;
    }
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
    stop(); // stop any playing
    state.currentId = id;
    const ex = state.byId[id];
    if (!ex) {
      console.error('Exercise not found:', id);
      return;
    }
    document.getElementById('ex-num').textContent = `#${id}`;
    document.getElementById('ex-title').textContent = ex.title;
    document.getElementById('ex-section').textContent = `§${ex.section}`;
    document.getElementById('ex-page').textContent = `p.${ex.page}`;
    document.getElementById('ex-detail-link').href = `../exercises/${id}/`;

    // Update URL without reload
    const newUrl = new URL(window.location);
    newUrl.searchParams.set('id', id);
    window.history.replaceState({}, '', newUrl);

    // Load and render MusicXML
    const instrument = document.getElementById('instrument').value;
    const transpose = document.getElementById('transpose').value;
    document.getElementById('score-container').innerHTML = '<div class="score-loading">Loading notation…</div>';
    try {
      const url = `../api/musicxml/${id}?instrument=${instrument}&transpose=${transpose}`;
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
    } catch (e) {
      console.error(e);
    }
  }

  function formatRecentItem(r) {
    const date = new Date(r.practiced_at);
    const dateStr = date.toLocaleDateString();
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `
      <div class="recent-item">
        <span class="ri-num">#${r.exercise_id}</span>
        <span class="ri-title">${r.notes || '—'}</span>
        <span class="ri-meta">${r.tempo_bpm || '—'}bpm · ${dateStr}</span>
      </div>
    `;
  }

  // ===== Queue =====
  function renderQueue() {
    const list = document.getElementById('queue-list');
    document.getElementById('queue-count').textContent = state.queue.length;
    if (state.queue.length === 0) {
      list.innerHTML = '<p class="empty-state">Empty. Add exercises from the Browse page.</p>';
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
        : '<p class="empty-state">No other practice logged yet.</p>';
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
        list.innerHTML = '<p class="empty-state">No collections yet.</p>';
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

    // Get initial exercise from URL or default to #1
    const url = new URL(window.location);
    const initialId = parseInt(url.searchParams.get('id') || '1', 10);

    // Wire up controls
    document.getElementById('btn-prev').addEventListener('click', () => {
      const idx = state.exercises.findIndex((e) => e.id === state.currentId);
      if (idx > 0) loadExercise(state.exercises[idx - 1].id);
    });
    document.getElementById('btn-next').addEventListener('click', () => {
      const idx = state.exercises.findIndex((e) => e.id === state.currentId);
      if (idx < state.exercises.length - 1) loadExercise(state.exercises[idx + 1].id);
    });
    document.getElementById('instrument').addEventListener('change', () => {
      if (state.currentId) loadExercise(state.currentId);
    });
    document.getElementById('transpose').addEventListener('change', () => {
      if (state.currentId) loadExercise(state.currentId);
    });
    document.getElementById('tempo').addEventListener('input', (e) => {
      e.target.dataset.userSet = '1';
    });
    document.getElementById('btn-play').addEventListener('click', play);
    document.getElementById('btn-stop').addEventListener('click', stop);
    document.getElementById('volume').addEventListener('input', (e) => {
      setVolume(e.target.value);
    });
    document.getElementById('btn-log').addEventListener('click', logPractice);

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === ' ') {
        e.preventDefault();
        state.isPlaying ? stop() : play();
      } else if (e.key === 'ArrowLeft') {
        document.getElementById('btn-prev').click();
      } else if (e.key === 'ArrowRight') {
        document.getElementById('btn-next').click();
      } else if (e.key === 'l' || e.key === 'L') {
        logPractice();
      }
    });

    await loadExercise(initialId);
    await loadRecent();
    await loadCollections();
    renderQueue();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
