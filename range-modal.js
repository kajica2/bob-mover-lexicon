/* Register-range modal — shown on first visit, persisted in localStorage.
 *
 * Gating model: on every page load, if `jazz_lex_range` is absent from
 * localStorage, the body is locked behind a full-viewport modal. The user
 * picks an instrument preset (which auto-fills sensible low/high notes in
 * scientific pitch), adjusts the note selectors if they want, and confirms.
 * The modal is dismissed; the range is persisted; subsequent loads skip
 * the modal entirely. A "Change range" affordance in the chrome re-opens
 * it on demand.
 *
 * Single self-contained file. Loaded once on every page. Mounts its own
 * DOM into the document body on DOMContentLoaded.
 *
 * Public API (window.rangeInfo):
 *   - instrument: 'concert' | 'soprano' | 'alto' | 'tenor' | 'bari' | 'trumpet' | 'clarinet'
 *   - lowMidi:    integer (MIDI note number, e.g. 44 = Ab2)
 *   - highMidi:   integer
 *   - lowName:    scientific-pitch string (e.g. 'Ab2')
 *   - highName:   scientific-pitch string
 *
 *   openRangeModal()  - re-open the modal even if a range is set
 *   setRange(r)       - programmatic set (used by the modal itself + tests)
 *   clearRange()      - clear the persisted range (forces re-prompt)
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'jazz_lex_range';

  // Per-instrument sensible defaults (concert-pitch MIDI note numbers).
  // Source: common method-book ranges; the user can override either bound.
  // Lowest MIDI = A0 (21); highest usable MIDI on the system is C8 (108).
  const INSTRUMENT_PRESETS = {
    concert:  { label: 'Concert pitch',     low: 21,  high: 108, hint: 'Full piano range — no clamp' },
    soprano:  { label: 'Soprano Sax / Bb',  low: 56,  high: 100, hint: 'Ab3 – E6 (concert)' },
    alto:     { label: 'Alto Sax / Eb',     low: 49,  high: 81,  hint: 'Db3 – A5 (concert)' },
    tenor:    { label: 'Tenor Sax / Bb',    low: 44,  high: 76,  hint: 'Ab2 – E5 (concert)' },
    bari:     { label: 'Bari Sax / Eb',     low: 36,  high: 69,  hint: 'Db2 – A4 (concert)' },
    trumpet:  { label: 'Trumpet / Bb',      low: 52,  high: 84,  hint: 'E3 – C6 (concert)' },
    clarinet: { label: 'Clarinet / Bb',    low: 50,  high: 95,  hint: 'D3 – Bb6 (concert)' },
  };

  // Scientific-pitch MIDI conversion. C4 = 60, A4 = 69.
  // Note names use sharps (standard for jazz — sharps read more naturally
  // when scrolling up an instrument range).
  const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT_NAMES  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

  function midiToName(midi) {
    const n = Math.max(0, Math.min(127, midi | 0));
    const octave = Math.floor(n / 12) - 1;
    const pc = n % 12;
    return SHARP_NAMES[pc] + octave;
  }
  function nameToMidi(name) {
    // Accepts "C4", "C#4", "Db4", "F#3"; defaults to octave 4 if missing.
    const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec((name || '').trim());
    if (!m) return null;
    const letter = m[1].toUpperCase();
    const accidental = m[2];
    const octave = parseInt(m[3], 10);
    const baseIdx = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[letter];
    let pc = baseIdx + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0);
    // Cb = B (-1 mod 12 = 11)
    if (pc < 0) pc += 12;
    return (octave + 1) * 12 + pc;
  }
  function isValidMidi(n) {
    return typeof n === 'number' && isFinite(n) && n >= 0 && n <= 127;
  }

  // ---------- storage ----------

  function readRange() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !isValidMidi(obj.lowMidi) || !isValidMidi(obj.highMidi)) return null;
      if (obj.lowMidi > obj.highMidi) return null;
      if (!INSTRUMENT_PRESETS[obj.instrument]) return null;
      return obj;
    } catch {
      return null;
    }
  }
  function writeRange(r) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(r));
    } catch (e) {
      console.warn('range-modal: could not persist range', e);
    }
  }
  function clearRange() {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  }

  // ---------- DOM building ----------

  // Build the options for the note selector: 12 note letters × 7 octaves
  // (MIDI 21..104, A0..E7). One option per (letter, octave) — labelled
  // with the scientific-pitch name and (small) the MIDI number for
  // technical users.
  function noteSelectOptions(minMidi, maxMidi) {
    const out = [];
    for (let n = 21; n <= 104; n++) {
      if (n < minMidi || n > maxMidi) continue;
      out.push(`<option value="${n}">${midiToName(n)}</option>`);
    }
    return out.join('');
  }

  function buildModal() {
    const wrap = document.createElement('div');
    wrap.id = 'range-modal-overlay';
    wrap.className = 'range-modal-overlay';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'range-modal-title');
    wrap.innerHTML = [
      '<div class="range-modal">',
        '<div class="range-modal-head">',
          '<span class="range-modal-icon">🎷</span>',
          '<div>',
            '<h2 id="range-modal-title">Set your playing range</h2>',
            '<p class="range-modal-sub">',
              'We use this to show you exercises that fit in your register. ',
              'You can change it anytime from the Practice page.',
            '</p>',
          '</div>',
        '</div>',
        '<div class="range-form">',
          '<label class="range-field">',
            '<span class="range-label">Instrument</span>',
            '<select id="range-instrument" class="range-input">',
              Object.keys(INSTRUMENT_PRESETS).map(function (k) {
                return `<option value="${k}">${INSTRUMENT_PRESETS[k].label}</option>`;
              }).join(''),
            '</select>',
            '<span class="range-hint" id="range-hint"></span>',
          '</label>',
          '<div class="range-row">',
            '<label class="range-field range-field-half">',
              '<span class="range-label">Lowest note you can play</span>',
              '<select id="range-low" class="range-input"></select>',
            '</label>',
            '<label class="range-field range-field-half">',
              '<span class="range-label">Highest note you can play</span>',
              '<select id="range-high" class="range-input"></select>',
            '</label>',
          '</div>',
          '<div class="range-validation" id="range-validation"></div>',
        '</div>',
        '<div class="range-modal-foot">',
          '<button id="range-confirm" class="btn btn-primary range-confirm" type="button">',
            'Set range and continue',
          '</button>',
        '</div>',
      '</div>',
    ].join('');
    return wrap;
  }

  function populateNoteSelects(overlay, lowMidi, highMidi) {
    const low = overlay.querySelector('#range-low');
    const high = overlay.querySelector('#range-high');
    // The lowest selector is allowed to go as low as A0 (21); highest as E7 (104)
    low.innerHTML = noteSelectOptions(21, 104);
    high.innerHTML = noteSelectOptions(21, 104);
    low.value = String(lowMidi);
    high.value = String(highMidi);
  }

  // ---------- open / close / lock body ----------

  function lockBody(locked) {
    if (locked) {
      document.body.classList.add('range-modal-locked');
    } else {
      document.body.classList.remove('range-modal-locked');
    }
  }

  function openModal(opts) {
    opts = opts || {};
    const existing = document.getElementById('range-modal-overlay');
    if (existing) existing.remove();

    const overlay = buildModal();
    document.body.appendChild(overlay);

    // Pre-fill from existing range if present, else from instrument default
    const stored = opts.existingRange || readRange();
    let instrument = stored && stored.instrument;
    let lowMidi = stored && stored.lowMidi;
    let highMidi = stored && stored.highMidi;
    if (!instrument || !INSTRUMENT_PRESETS[instrument]) instrument = 'tenor';
    if (!isValidMidi(lowMidi)) lowMidi = INSTRUMENT_PRESETS[instrument].low;
    if (!isValidMidi(highMidi)) highMidi = INSTRUMENT_PRESETS[instrument].high;

    const sel = overlay.querySelector('#range-instrument');
    sel.value = instrument;
    populateNoteSelects(overlay, lowMidi, highMidi);
    refreshHint(overlay);
    validateRange(overlay);

    sel.addEventListener('change', function () {
      const preset = INSTRUMENT_PRESETS[sel.value];
      if (!preset) return;
      populateNoteSelects(overlay, preset.low, preset.high);
      refreshHint(overlay);
      validateRange(overlay);
    });
    overlay.querySelector('#range-low').addEventListener('change', function () { validateRange(overlay); });
    overlay.querySelector('#range-high').addEventListener('change', function () { validateRange(overlay); });

    overlay.querySelector('#range-confirm').addEventListener('click', function () {
      const result = validateRange(overlay, /*strict*/ true);
      if (!result.ok) return;
      const range = {
        instrument: sel.value,
        lowMidi: parseInt(overlay.querySelector('#range-low').value, 10),
        highMidi: parseInt(overlay.querySelector('#range-high').value, 10),
      };
      range.lowName = midiToName(range.lowMidi);
      range.highName = midiToName(range.highMidi);
      writeRange(range);
      // Keep the global in sync so pages that read window.rangeInfo
      // before the event handler runs see the new value.
      window.rangeInfo = range;
      lockBody(false);
      overlay.remove();
      if (typeof opts.onConfirm === 'function') opts.onConfirm(range);
      window.dispatchEvent(new CustomEvent('range-changed', { detail: range }));
    });

    // Trap focus inside the modal — first focusable element gets focus.
    setTimeout(function () {
      const first = overlay.querySelector('select, button');
      if (first) first.focus();
    }, 0);
    // Esc closes the modal only when there is an existing range (i.e. user
    // is editing, not being onboarded).
    if (stored) {
      overlay.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          overlay.remove();
          lockBody(false);
        }
      });
    }
  }

  function refreshHint(overlay) {
    const sel = overlay.querySelector('#range-instrument');
    const hint = overlay.querySelector('#range-hint');
    const preset = INSTRUMENT_PRESETS[sel.value];
    if (hint) hint.textContent = preset ? preset.hint : '';
  }

  function validateRange(overlay, strict) {
    const low = parseInt(overlay.querySelector('#range-low').value, 10);
    const high = parseInt(overlay.querySelector('#range-high').value, 10);
    const msg = overlay.querySelector('#range-validation');
    const ok = isValidMidi(low) && isValidMidi(high) && low <= high;
    if (ok) {
      msg.textContent = '';
      msg.className = 'range-validation';
      overlay.querySelector('#range-confirm').disabled = false;
      return { ok: true, low: low, high: high };
    } else {
      msg.textContent = 'Lowest must be ≤ highest.';
      msg.className = 'range-validation error';
      if (strict) {
        overlay.querySelector('#range-confirm').disabled = true;
      }
      return { ok: false, low: low, high: high };
    }
  }

  // ---------- public API ----------

  // First-visit gate. Called on every page load.
  function init() {
    const existing = readRange();
    if (!existing) {
      lockBody(true);
      openModal({ existingRange: null });
    }
    // Always expose the current range (or null) on window for other code.
    window.rangeInfo = existing || null;
  }

  window.openRangeModal = function (onConfirm) {
    openModal({ onConfirm: onConfirm });
  };
  window.setRange = function (r) {
    writeRange(r);
    r.lowName = midiToName(r.lowMidi);
    r.highName = midiToName(r.highMidi);
    window.rangeInfo = r;
    window.dispatchEvent(new CustomEvent('range-changed', { detail: r }));
  };
  window.clearRange = function () {
    clearRange();
    window.rangeInfo = null;
  };
  window.rangePresets = INSTRUMENT_PRESETS;
  window.midiToName = midiToName;
  window.nameToMidi = nameToMidi;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();