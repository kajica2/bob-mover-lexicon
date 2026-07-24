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
    // Read <divisions> from the first measure's <attributes>. MusicXML
    // stores note durations in "divisions" units; we divide by this to
    // get beats. Without this, every <duration>2</duration> triplet would
    // be misread as a half note — the engine then schedules the whole
    // exercise at the wrong times and pitches. v21 bug fix.
    const firstDivs = doc.querySelector('measure > attributes > divisions');
    if (firstDivs) divisions = parseFloat(firstDivs.textContent);
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
        if (note.querySelector('rest')) {
          // v24: advance posInMeasure by the rest's duration so the
          // next pitched note in the same measure lands at the right
          // beat. The previous code returned early, which worked only
          // when the rest happened to be the last element of the last
          // measure (all 407 source exercises happen to put their
          // rests there). A rest mid-measure would have caused the
          // next note to fire early.
          posInMeasure += getNoteDuration(note, divisions);
          return;
        }
        if (note.querySelector('chord')) {
          // v23: skip <chord/> notes. The engine is monophonic (sax
          // practice tool) — playing every chord tone simultaneously
          // produces ugly stacked-tone "harmonies" that aren't in the
          // exercise's intent. The first note of each chord plays;
          // subsequent chord tones are dropped. Verovio still renders
          // the full chord on the score, so what you see and what you
          // hear line up (one note = the lead of each chord stack).
          return;
        }
        const step = note.querySelector('pitch > step')?.textContent || 'C';
        const octave = parseInt(note.querySelector('pitch > octave')?.textContent || '4');
        const alter = parseInt(note.querySelector('pitch > alter')?.textContent || '0');
        const duration = getNoteDuration(note, divisions);
        const midi = stepToMidi(step, octave, alter);
        // v24: tie handling. If this note is the STOP end of a tie
        // (i.e. it should sustain from the previous same-pitch note),
        // merge the duration into the previous entry. Ties in MusicXML
        // are encoded as <tie type="start"/> on the first note and
        // <tie type="stop"/> on the second; the two become one
        // sustained note. The previous code treated them as two
        // separate notes back-to-back, which sounded OK for a same-
        // pitch pair but broke the timing of any further tied chains
        // and produced double visual highlights.
        const tieStop = note.querySelector('tie[type="stop"]');
        if (tieStop && notes.length > 0) {
          const prev = notes[notes.length - 1];
          if (prev.midi === midi) {
            prev.duration += duration;
            posInMeasure += duration;
            return;  // skip emitting this note — its time is part of prev
          }
        }
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

  // v28: rewrite getNoteDuration to compute from <type> + <dot> +
  // <time-modification> rather than <duration>/divisions. Reason:
  // encoders (Audiveris, music21) round the <duration> field to
  // integer divisions, so a 5:4 quintuplet of 16th notes (each
  // 0.2 beat = 2.4 divisions in divisions=12) would land at 2 or 3
  // divisions — 0.167 or 0.25 beat — off by up to 1/divisions. The
  // type-based approach is independent of divisions and handles ANY
  // tuplet ratio: 3:2 (triplet), 5:4 (quintuplet), 6:4 (sextuplet),
  // 7:8 (septuplet), 11:8 (irrational), whatever. The trade-off is
  // losing the <duration> field's encoding of grace-note duration
  // (always 0) and tie-adjusted duration (handled separately at the
  // v24 level). For pitched notes and rests, <type> is required by
  // the MusicXML spec so this is always available.
  //
  // Beats-per-type table is the standard whole-note system: a whole
  // note = 4 beats, then halve for half, quarter, eighth, etc.
  // A <dot> extends the duration by half each time (so a dotted
  // quarter = 1.5 beats, double-dotted = 1.75).
  const TYPE_BEATS = {
    'whole': 4, 'half': 2, 'quarter': 1, 'eighth': 0.5, '16th': 0.25,
    '32nd': 0.125, '64th': 0.0625, '128th': 0.03125,
    'breve': 8, 'long': 16,
  };
  function getNoteDuration(note, divisions) {
    const typeEl = note.querySelector('type');
    if (!typeEl) {
      // No <type> (e.g. grace notes): fall back to <duration>/divisions.
      const dur = note.querySelector('duration')?.textContent;
      return dur ? parseFloat(dur) / divisions : 1;
    }
    const base = TYPE_BEATS[typeEl.textContent];
    if (base == null) {
      // Unknown type: fall back to <duration>/divisions.
      const dur = note.querySelector('duration')?.textContent;
      return dur ? parseFloat(dur) / divisions : 1;
    }
    let beats = base;
    // Dots: each <dot/> multiplies by 1.5. MusicXML allows up to
    // 4 dots in practice (a double-dotted note is 1.75x, triple is
    // 1.875x, etc.).
    const dotCount = note.querySelectorAll('dot').length;
    for (let i = 0; i < dotCount; i++) beats *= 1.5;
    // Tuplet: actual = nominal * (normal-notes / actual-notes).
    // Use <normal-notes>/<actual-notes> directly — don't need the
    // <normal-type> child since we already have the nominal from
    // the <type> above.
    const tm = note.querySelector('time-modification');
    if (tm) {
      const an = parseInt(tm.querySelector('actual-notes')?.textContent || '1');
      const nn = parseInt(tm.querySelector('normal-notes')?.textContent || '1');
      if (an > 0 && nn > 0) beats = beats * nn / an;
    }
    return beats;
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
    // Show the original page-cropped PNG from the book under the
    // rendered score. The image is the static source PDF crop (not
    // the Verovio render), so it doesn't reflect any transposition,
    // cycle, or range-clamp — it's there as a sanity-check / study
    // aid, not as the playable view. Hidden by default via the [hidden]
    // attribute; revealed here once an exercise is loaded.
    const origPngBox = document.getElementById('original-png');
    const origPngImg = document.getElementById('original-png-img');
    if (origPngBox && origPngImg) {
      if (typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id))) {
        const numericId = typeof id === 'number' ? id : parseInt(id, 10);
        origPngImg.src = '../exercises_images/' +
          String(numericId).padStart(4, '0') + '.png';
        origPngImg.alt = 'Original page from the Bob Mover Jazz Lexicon — exercise #' + numericId;
        origPngBox.hidden = false;
      } else {
        // Etude load path (string id starting with 'etude_'): no
        // single source page to show, so leave the original PNG
        // hidden.
        origPngBox.hidden = true;
        origPngImg.removeAttribute('src');
      }
    }
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
      : etude.source === 'composer' ? 'composed'
      : etude.source === 'master-class' ? 'master class'
      : 'random';
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
    const metroBtn = document.getElementById('chk-playback-metronome');
    const statusEl = document.getElementById('playback-status');
    const beatIndicator = document.getElementById('beat-indicator');
    const metroTimeSigSel = document.getElementById('metro-timesig');
    const metroSubSel = document.getElementById('metro-subdivision');
    if (!playBtn || !stopBtn) return;

    function setStatus(text, cls) {
      if (!statusEl) return;
      statusEl.textContent = text;
      statusEl.className = 'playback-status' + (cls ? ' ' + cls : '');
    }

    // Flash the small beat indicator next to the Metronome button.
    // v22: visual feedback so the user can see (not just hear) each
    // metronome tick. We briefly add a class then remove it after the
    // animation. Using a class instead of inline styles keeps the
    // easing/colors in CSS where they're easy to tweak.
    let beatFlashTimer = null;
    function flashBeatIndicator(beat) {
      if (!beatIndicator || !beat) return;
      const cls = beat.isSubdivision ? 'pulse-sub'
        : beat.isDown ? 'pulse-down'
        : 'pulse-beat';
      beatIndicator.classList.remove('pulse-down', 'pulse-beat', 'pulse-sub');
      // Force reflow so the class re-add triggers the CSS transition
      // (otherwise back-to-back flashes on the same element don't animate).
      void beatIndicator.offsetWidth;
      beatIndicator.classList.add(cls);
      if (beatFlashTimer) clearTimeout(beatFlashTimer);
      beatFlashTimer = setTimeout(() => {
        beatIndicator.classList.remove('pulse-down', 'pulse-beat', 'pulse-sub');
      }, 80);
    }

    // Push the current time-sig/subdivision values from the dropdowns
    // into the engine. Idempotent; safe to call on every change.
    function pushMetroConfig() {
      const eng = window.playbackEngine;
      if (!eng || typeof eng.setMetroConfig !== 'function') return;
      eng.setMetroConfig({
        timeSig: metroTimeSigSel ? metroTimeSigSel.value : '4/4',
        subdivision: metroSubSel ? metroSubSel.value : 'off',
      });
    }
    if (metroTimeSigSel) metroTimeSigSel.addEventListener('change', pushMetroConfig);
    if (metroSubSel) metroSubSel.addEventListener('change', pushMetroConfig);

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
      // Stop the standalone metronome if it's running, so we don't
      // layer two click tracks. (The standalone and exercise share the
      // same Tone.Transport.)
      if (typeof eng.stopMetronome === 'function' && eng.isMetronomeRunning && eng.isMetronomeRunning()) {
        try { eng.stopMetronome(); } catch (e) {}
        // updateStandaloneUi lives in the wiring scope below; if it's
        // not in scope here, the UI button state is harmless either way.
        if (typeof updateStandaloneUi === 'function') updateStandaloneUi(false);
      }
      // Push the latest metronome config so this play() schedules
      // clicks with the dropdowns' current time-sig/subdivision.
      pushMetroConfig();
      const started = eng.play({
        onNote: (n) => highlightNote(n, true),
        onBeat: (beat) => flashBeatIndicator(beat),
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
        if (!eng || typeof eng.testSound !== 'function') {
          setStatus('engine missing', 'error');
          return;
        }
        const result = eng.testSound();
        if (result && typeof result === 'object' && 'ok' in result) {
          setStatus(result.ok ? '✓ ' + result.message : '✗ ' + result.message,
                    result.ok ? 'playing' : 'error');
        } else {
          // Legacy boolean return — preserve old behavior.
          setStatus(result ? 'test firing — listen!' : 'test failed',
                    result ? 'playing' : 'error');
        }
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
      // v26: metronome is now a checkbox, not a button. State lives on
      // input.checked; we use the change event (fires on user toggle)
      // and the same `setMetronome` engine call. The mutual-exclusion
      // with the standalone metronome is unchanged: turning this on
      // stops the standalone, and starting the standalone clears this
      // checkbox.
      // v30: synchronise the engine with the checkbox's initial state
      // (the HTML has `checked` so the engine's metronomeOn flag
      // should also start true — otherwise play() would skip the
      // metronome scheduling even though the box is checked). One-time
      // sync at init, then `change` keeps them in lock-step from there.
      const eng0 = window.playbackEngine;
      if (eng0) eng0.setMetronome(!!metroBtn.checked);
      metroBtn.addEventListener('change', () => {
        const on = !!metroBtn.checked;
        const eng = window.playbackEngine;
        if (eng) eng.setMetronome(on);
        if (on && eng && typeof eng.stopMetronome === 'function' && eng.isMetronomeRunning && eng.isMetronomeRunning()) {
          eng.stopMetronome();
          updateStandaloneUi(false);
        }
      });
    }

    // v33: Loop toggle. Same checkbox pattern as the metronome. The
    // engine reads its loopOn flag inside the onEnd closure and
    // re-arms playback (with a 200ms gap) if set. We don't pre-arm
    // or queue anything here — toggling just flips the flag. The
    // current pass plays to its natural end and the loop callback
    // picks up the new value when it fires.
    const loopBtn = document.getElementById('chk-playback-loop');
    if (loopBtn) {
      const engLoop0 = window.playbackEngine;
      if (engLoop0 && typeof engLoop0.setLoop === 'function') {
        engLoop0.setLoop(!!loopBtn.checked);
      }
      loopBtn.addEventListener('change', () => {
        const on = !!loopBtn.checked;
        const eng = window.playbackEngine;
        if (eng && typeof eng.setLoop === 'function') eng.setLoop(on);
      });
    }

    // ---- Standalone metronome (free-running) ----
    // v22. Lives in the side panel. Independent of any exercise — click
    // Start and the click track begins at the configured BPM, with the
    // chosen time sig + subdivision. Stops the in-exercise metronome
    // (and exercise playback) when started, for the same exclusivity
    // reason as above.
    const standaloneStartBtn = document.getElementById('btn-standalone-start');
    const standaloneStopBtn  = document.getElementById('btn-standalone-stop');
    const standaloneBpmInp   = document.getElementById('standalone-bpm');
    const standaloneTimeSel  = document.getElementById('standalone-timesig');
    const standaloneSubSel   = document.getElementById('standalone-subdivision');
    const standaloneVolInp   = document.getElementById('standalone-volume');
    const standaloneInd      = document.getElementById('standalone-beat-indicator');
    const standaloneNum      = document.getElementById('standalone-beat-num');
    const standaloneSubLbl   = document.getElementById('standalone-beat-sub');

    function updateStandaloneUi(running) {
      if (standaloneStartBtn) standaloneStartBtn.disabled = !!running;
      if (standaloneStopBtn) standaloneStopBtn.disabled = !running;
    }

    let standaloneFlashTimer = null;
    function flashStandaloneIndicator(beat) {
      if (!standaloneInd || !beat) return;
      const cls = beat.isSubdivision ? 'pulse-sub'
        : beat.isDown ? 'pulse-down'
        : 'pulse-beat';
      standaloneInd.classList.remove('pulse-down', 'pulse-beat', 'pulse-sub');
      void standaloneInd.offsetWidth; // restart CSS transition
      standaloneInd.classList.add(cls);
      if (standaloneNum) {
        // Display the beat number modulo the time sig for readability
        const beatsPerBar = { '4/4': 4, '3/4': 3, '2/4': 2, '6/8': 6 }[beat.timeSig || '4/4'] || 4;
        standaloneNum.textContent = String((beat.beat % beatsPerBar) + 1);
      }
      if (standaloneSubLbl) {
        if (beat.isSubdivision) {
          standaloneSubLbl.textContent = 'sub';
        } else if (beat.isDown) {
          standaloneSubLbl.textContent = 'downbeat';
        } else {
          standaloneSubLbl.textContent = '';
        }
      }
      if (standaloneFlashTimer) clearTimeout(standaloneFlashTimer);
      standaloneFlashTimer = setTimeout(() => {
        standaloneInd.classList.remove('pulse-down', 'pulse-beat', 'pulse-sub');
      }, 110);
    }

    function readStandaloneConfig() {
      const bpm = standaloneBpmInp ? (parseInt(standaloneBpmInp.value, 10) || 100) : 100;
      const timeSig = standaloneTimeSel ? standaloneTimeSel.value : '4/4';
      const subdivision = standaloneSubSel ? standaloneSubSel.value : 'off';
      const volume = standaloneVolInp ? (parseInt(standaloneVolInp.value, 10) / 100) : 0.6;
      return { bpm, timeSig, subdivision, volume };
    }

    async function startStandaloneMetronome() {
      const eng = window.playbackEngine;
      if (!eng || typeof eng.startMetronome !== 'function') return;
      // Make sure the AudioContext is running (browser autoplay policy
      // requires a user gesture — this click is the gesture).
      const ToneNs = window.Tone;
      if (ToneNs && ToneNs.context && ToneNs.context.state === 'suspended') {
        try { await ToneNs.start(); } catch (e) {}
      }
      // Stop exercise playback and the in-exercise metronome so we
      // don't double up.
      try { eng.stop(); } catch (e) {}
      if (metroBtn && metroBtn.checked) {
        metroBtn.checked = false;
        try { eng.setMetronome(false); } catch (e) {}
      }
      const cfg = readStandaloneConfig();
      const ok = eng.startMetronome({
        bpm: cfg.bpm,
        timeSig: cfg.timeSig,
        subdivision: cfg.subdivision,
        volume: cfg.volume,
        onBeat: (beat) => {
          // Stash the time sig on the beat payload so flashStandaloneIndicator
          // can compute the display number.
          beat.timeSig = cfg.timeSig;
          flashStandaloneIndicator(beat);
        },
      });
      if (ok) updateStandaloneUi(true);
    }

    function stopStandaloneMetronome() {
      const eng = window.playbackEngine;
      if (!eng) return;
      try { eng.stopMetronome(); } catch (e) {}
      updateStandaloneUi(false);
    }

    if (standaloneStartBtn) standaloneStartBtn.addEventListener('click', startStandaloneMetronome);
    if (standaloneStopBtn)  standaloneStopBtn.addEventListener('click', stopStandaloneMetronome);
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

    // Re-clamp every note in the current score to the user's saved
    // instrument range. Operates on state.rawXml (the post-cycle,
    // post-transpose MusicXML currently rendered) — so the user's
    // existing choices (transpose, cycle) are preserved and only
    // out-of-range notes get shifted by whole octaves. The re-render
    // also re-parses the score for playback, so the audio engine
    // plays the in-range version.
    //
    // Edge cases:
    //  - No exercise loaded: toast and bail.
    //  - No range saved for the current instrument: fall back to
    //    window.rangeInfo (the modal's active range), or to the
    //    instrument's default preset if neither is set.
    //  - Already in range: toast says so, no re-render (avoids
    //    chewing the user's scroll position for a no-op).
    //  - cycleToRange unavailable: toast an error (the etudes-stitch
    //    script failed to load — should never happen in production
    //    but defensive).
    function commitToRange() {
      if (!state.currentId) {
        if (typeof toast === 'function') toast('Load an exercise first.', true);
        return;
      }
      if (!state.rawXml) {
        if (typeof toast === 'function') toast('No score loaded yet.', true);
        return;
      }
      if (!window.etudesStitch || typeof window.etudesStitch.clampToRange !== 'function') {
        if (typeof toast === 'function') toast('Range-clamp helper not loaded.', true);
        return;
      }
      // Resolve the active range. Prefer the per-instrument
      // effective range (falls back to the modal's stored range
      // when the instrument has no saved preset).
      const instr = (document.getElementById('instrument') || {}).value || 'concert';
      let range = null;
      if (typeof window.getEffectiveRange === 'function') {
        const r = window.getEffectiveRange(instr);
        if (r && typeof r.lowMidi === 'number' && typeof r.highMidi === 'number') {
          range = { low: r.lowMidi, high: r.highMidi };
        }
      }
      if (!range && window.rangeInfo && typeof window.rangeInfo.lowMidi === 'number') {
        range = { low: window.rangeInfo.lowMidi, high: window.rangeInfo.highMidi };
      }
      if (!range) {
        if (typeof toast === 'function') {
          toast('No range set — open the range modal (top right) to pick one.', true);
        }
        return;
      }
      const before = (state.rawXml.match(/<note\b/g) || []).length;
      const result = window.etudesStitch.clampToRange(state.rawXml, range.low, range.high);
      if (!result || result.moved === 0) {
        if (typeof toast === 'function') {
          toast('All ' + before + ' notes already fit your range (' +
                midiToName(range.low) + '–' + midiToName(range.high) + ').');
        }
        return;
      }
      // Re-render with the clamped XML. renderScore updates
      // state.rawXml, re-parses for playback, and re-indexes the
      // SVG note positions.
      renderScore(result.xml);
      if (typeof toast === 'function') {
        toast('Shifted ' + result.moved + ' of ' + before +
              ' note(s) into your range (' +
              midiToName(range.low) + '–' + midiToName(range.high) + ').');
      }
    }

    // Local midi→name helper for the toast text. Mirrors the one in
    // etudes.js so the user sees a familiar name like "E3" instead
    // of "MIDI 52". Returns "C-1" for the very bottom of MIDI; for
    // any real horn range this is unreachable.
    function midiToName(midi) {
      const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      const pc = ((midi % 12) + 12) % 12;
      const octave = Math.floor(midi / 12) - 1;
      return NAMES[pc] + octave;
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
    // "Commit to range" button — re-clamps every note in the current
    // score to the saved instrument range. Useful when a cycle (or a
    // raw source MusicXML) has pushed notes out of the user's
    // register. The server already clamps initial loads and cycle
    // responses, so this is mostly a "force a re-fit" button — handy
    // if the user has tightened their range in the modal after
    // loading the score, or if the source XML is wider than expected.
    // Uses the same clampToRange helper that the etudes page uses
    // for in-browser stitching, so the result matches what the
    // server would have produced.
    const commitBtn = document.getElementById('btn-commit-range');
    if (commitBtn) commitBtn.addEventListener('click', commitToRange);
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

  // ===== Toast (lightweight status messages) =====
  // The practice page has no global toast helper (only the etudes
  // page does), so the "Commit to range" button and a few other
  // inline actions show their result here. Mirrors the etudes-page
  // toast style: dark pill at the bottom-centre, fades after 2.4s.
  // The CSS lives in styles.css under the .practice-toast class
  // (added so the etudes and practice pages can have different
  // z-indexes — practice is inside the player panel which already
  // has its own stacking context, so the toast needs to opt out
  // with a high z-index).
  function toast(msg, isError) {
    let el = document.querySelector('.practice-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'practice-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.classList.add('visible');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove('visible'); }, 2400);
  }
})();
