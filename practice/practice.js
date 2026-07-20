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
  // Polyphonic FM synth with explicit voice allocation (max 8 voices),
  // mono output, and a single-tap feedback reverb. Built on raw Web Audio
  // (Tone.js not bundled in this repo); API is Tone.js-shaped so swapping
  // in `new Tone.PolySynth(...)` later is a small change.

  const NUM_VOICES = 8;
  const VOICE_REVERB_WET = 0.20;

  function initAudio() {
    if (state.audioCtx) return state.audioCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();

    // ----- Force mono output on the destination -----
    // Prevents phase issues across stereo speakers and matches the
    // single-voice sax practice aesthetic.
    try {
      ctx.destination.channelCount = 1;
      ctx.destination.channelCountMode = 'explicit';
      ctx.destination.channelInterpretation = 'speakers';
    } catch (e) {
      console.warn('Could not force mono destination:', e);
    }

    // ----- Master bus -----
    state.masterGain = ctx.createGain();
    state.masterGain.gain.value = 0.5;

    state.compressor = ctx.createDynamicsCompressor();
    state.compressor.threshold.value = -16;
    state.compressor.knee.value = 10;
    state.compressor.ratio.value = 4;
    state.compressor.attack.value = 0.003;
    state.compressor.release.value = 0.18;

    state.masterGain.connect(state.compressor);
    state.compressor.connect(ctx.destination);

    // ----- Mono feedback reverb (single delay line) -----
    state.reverbIn = ctx.createGain();
    state.reverbIn.gain.value = 1.0;
    state.reverbDelay = ctx.createDelay(1.0);
    state.reverbDelay.delayTime.value = 0.18;
    state.reverbFB = ctx.createGain();
    state.reverbFB.gain.value = 0.22;
    state.reverbWet = ctx.createGain();
    state.reverbWet.gain.value = VOICE_REVERB_WET;
    state.reverbIn.connect(state.reverbDelay);
    state.reverbDelay.connect(state.reverbFB);
    state.reverbFB.connect(state.reverbDelay);
    state.reverbDelay.connect(state.reverbWet);
    state.reverbWet.connect(state.masterGain);

    state.audioCtx = ctx;
    state.voices = [];
    for (let i = 0; i < NUM_VOICES; i++) state.voices.push(createVoice(ctx));

    // Dedicated mono metronome bus (keeps the click out of reverb)
    state.metroGain = ctx.createGain();
    state.metroGain.gain.value = 0.7;
    state.metroGain.connect(state.masterGain);

    return ctx;
  }

  function createVoice(ctx) {
    // Persistent voice: oscillators run forever, amp envelope gates audio.
    // Reusing nodes avoids per-note allocation and start/stop cliffs.
    const carrier = ctx.createOscillator();
    carrier.type = 'triangle';
    carrier.frequency.value = 440;

    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = 880;
    const modDepth = ctx.createGain();
    modDepth.gain.value = 0;
    mod.connect(modDepth);
    modDepth.connect(carrier.frequency);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 220;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.32;
    sub.connect(subGain);

    const mix = ctx.createGain();
    mix.gain.value = 1.0;
    carrier.connect(mix);
    subGain.connect(mix);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 2;
    filter.frequency.value = 1200;
    mix.connect(filter);

    const amp = ctx.createGain();
    amp.gain.value = 0;
    filter.connect(amp);
    amp.connect(state.masterGain);

    const wetTap = ctx.createGain();
    wetTap.gain.value = 1.0;
    amp.connect(wetTap);
    wetTap.connect(state.reverbIn);

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 5.5;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0;
    lfo.connect(lfoDepth);
    lfoDepth.connect(carrier.frequency);

    carrier.start();
    mod.start();
    sub.start();
    lfo.start();

    return {
      ctx, carrier, mod, modDepth, sub, subGain,
      filter, amp, lfo, lfoDepth, wetTap,
      inUse: false,
      noteOnTime: -1,
      scheduledStop: -1,
    };
  }

  function findFreeVoice() {
    // Idle voice first; if all busy, steal the oldest one (hard cut).
    let oldest = state.voices[0];
    for (const v of state.voices) {
      if (!v.inUse) return v;
      if (v.noteOnTime < oldest.noteOnTime) oldest = v;
    }
    hardStopVoice(oldest);
    return oldest;
  }

  function hardStopVoice(v) {
    const now = v.ctx.currentTime;
    v.amp.gain.cancelScheduledValues(now);
    v.amp.gain.setTargetAtTime(0, now, 0.005);
    v.inUse = false;
    v.noteOnTime = -1;
    v.scheduledStop = -1;
  }

  function playNote(midi, duration = 0.5, time = null, velocity = 0.85) {
    if (!state.audioCtx) return;
    const ctx = state.audioCtx;
    const t = time !== null ? time : ctx.currentTime;
    const freq = midiToFreq(midi);
    const v = findFreeVoice();

    v.inUse = true;
    v.noteOnTime = t;
    v.scheduledStop = t + duration;

    v.carrier.frequency.cancelScheduledValues(t);
    v.carrier.frequency.setValueAtTime(freq, t);
    v.mod.frequency.cancelScheduledValues(t);
    v.mod.frequency.setValueAtTime(freq * 2, t);
    v.sub.frequency.cancelScheduledValues(t);
    v.sub.frequency.setValueAtTime(freq * 0.5, t);

    v.modDepth.gain.cancelScheduledValues(t);
    v.modDepth.gain.setValueAtTime(freq * 1.2, t);

    v.lfoDepth.gain.cancelScheduledValues(t);
    if (duration > 0.25) {
      v.lfoDepth.gain.setValueAtTime(0, t);
      v.lfoDepth.gain.linearRampToValueAtTime(freq * 0.010, t + 0.25);
      v.lfoDepth.gain.linearRampToValueAtTime(0, t + duration);
    } else {
      v.lfoDepth.gain.setValueAtTime(0, t);
    }

    v.filter.frequency.cancelScheduledValues(t);
    v.filter.frequency.setValueAtTime(800, t);
    v.filter.frequency.linearRampToValueAtTime(Math.min(freq * 6, 5000), t + 0.04);
    v.filter.frequency.exponentialRampToValueAtTime(
      Math.max(freq * 1.5, 500), t + duration,
    );

    const peak = 0.28 * velocity;
    v.amp.gain.cancelScheduledValues(t);
    v.amp.gain.setValueAtTime(0, t);
    v.amp.gain.linearRampToValueAtTime(peak, t + 0.012);
    v.amp.gain.linearRampToValueAtTime(peak * 0.7, t + 0.10);
    const releaseStart = Math.max(0.12, duration - 0.08);
    v.amp.gain.setValueAtTime(peak * 0.7, t + releaseStart);
    v.amp.gain.exponentialRampToValueAtTime(0.0005, t + duration);

    // Release voice back to pool after note ends
    const releaseMs = (duration + 0.02) * 1000;
    setTimeout(() => {
      if (v.inUse && Math.abs(v.noteOnTime - t) < 1e-6) {
        v.inUse = false;
        v.noteOnTime = -1;
      }
    }, releaseMs);
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
    gain.gain.exponentialRampToValueAtTime(0.0005, now + 0.045);
    osc.connect(gain);
    gain.connect(state.metroGain);
    osc.start(now);
    osc.stop(now + 0.06);
  }

  function setVolume(v) {
    const vol = Math.max(0, Math.min(100, v)) / 100;
    if (state.masterGain) {
      const ctx = state.audioCtx;
      state.masterGain.gain.cancelScheduledValues(ctx.currentTime);
      state.masterGain.gain.setTargetAtTime(vol, ctx.currentTime, 0.02);
    }
  }

  function panic() {
    // Immediately silence all voices (called by stop())
    if (state.voices) for (const v of state.voices) hardStopVoice(v);
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

  // ===== Playback =====
  function play() {
    if (!state.currentScore) return;
    initAudio();
    if (state.audioCtx.state === 'suspended') {
      state.audioCtx.resume();
    }
    state.isPlaying = true;
    const bpm = parseInt(document.getElementById('tempo').value) || 120;
    const secondsPerBeat = 60 / bpm;

    // Apply the Cycle mode (extends the exercise across keys).
    // Reads from the committed state (set by applyCycle) so the user's
    // explicit "Apply" press controls playback, not the live dropdown.
    const instr = (document.getElementById('instrument') || {}).value || 'concert';
    const cycleMode = state.cycleCommitted ? state.cycleCommitted.mode : 'off';
    const cycleBars = state.cycleCommitted ? state.cycleCommitted.bars : 1;
    const { notes, stats } = buildCycleNotes(
      state.currentScore.notes, cycleMode, cycleBars, instr,
    );
    if (notes.length === 0) return;
    if (stats.dropped > 0) {
      console.info(
        `[cycle] ${stats.dropped} note(s) dropped — outside ${instr} range ` +
        `(${INSTRUMENT_RANGES[instr].min}-${INSTRUMENT_RANGES[instr].max} MIDI)`,
      );
    }

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
    // Silences voices in place — keeps the AudioContext alive so the next
    // play() doesn't have to recreate oscillators and modulators.
    panic();
    if (state.audioCtx) state.audioCtx.suspend();
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
    // Re-evaluate cycle against the new score + instrument range
    if (typeof applyCycle === 'function') applyCycle();
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
      if (state.currentId) {
        loadExercise(state.currentId);
        // Re-evaluate cycle against new instrument range
        if (typeof applyCycle === 'function') applyCycle();
      }
    });
    document.getElementById('transpose').addEventListener('change', () => {
      if (state.currentId) loadExercise(state.currentId);
    });

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

    function applyCycle() {
      if (!state.currentScore) {
        // No exercise loaded yet — just commit the staged values
        const mode = cycleModeSel ? cycleModeSel.value : 'off';
        const bars = cycleBarsInp ? Math.max(1, Math.min(12, parseInt(cycleBarsInp.value, 10) || 12)) : 1;
        state.cycleCommitted = { mode, bars, key: 0, dropped: 0 };
        updateBadge(state.cycleCommitted);
        return;
      }
      const instr = (document.getElementById('instrument') || {}).value || 'concert';
      const mode = cycleModeSel ? cycleModeSel.value : 'off';
      const bars = cycleBarsInp ? Math.max(1, Math.min(12, parseInt(cycleBarsInp.value, 10) || 12)) : 12;
      const seq = cycleKeySequence(mode);
      const lastKey = mode === 'off' ? 0 : (seq[Math.min(bars, seq.length) - 1] || 0);
      const { stats } = buildCycleNotes(state.currentScore.notes, mode, bars, instr);
      state.cycleCommitted = { mode, bars, key: lastKey, dropped: stats.dropped };
      // Persist
      try {
        localStorage.setItem('practice_cycle', JSON.stringify({ mode, bars }));
      } catch (e) { /* ignore */ }
      updateBadge(state.cycleCommitted);
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
