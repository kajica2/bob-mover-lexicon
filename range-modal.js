/* Register-range modal — shown on first visit, persisted in localStorage.
 *
 * Per-instrument range storage: the user can pick any subset of supported
 * instruments and save a custom low/high note range for each one. The
 * Practice page reads the active instrument's effective range (saved or
 * preset default) and sends it with every score load so the server can
 * clamp notes outside the user's register.
 *
 * Storage schema (jazz_lex_ranges): an object keyed by instrument id.
 *   {
 *     "tenor": { lowMidi: 44, highMidi: 76, lowName: "Ab2", highName: "E5" },
 *     "bass":  { lowMidi: 43, highMidi: 55, lowName: "G2",  highName: "G3" }
 *   }
 *
 * First-visit gate: when the per-instrument map is empty (or only the
 * legacy single-instrument key is present), the body is locked behind a
 * full-viewport modal until the user picks an instrument and confirms a
 * range. The modal saves under the chosen instrument's key. Other
 * instruments fall back to their preset range until the user explicitly
 * customizes them via the "change" affordance in the Practice header.
 *
 * Legacy migration: if the older single-instrument key (jazz_lex_range)
 * is present, fold it into the new map under its `instrument` field and
 * delete it.
 *
 * Public API (window.*):
 *   - rangeInfo:           { instrument, lowMidi, highMidi, lowName, highName }
 *                          or null. The range that was last saved/confirmed.
 *   - openRangeModal(opts) — re-open the modal even if a range is set.
 *                          opts.preferredInstrument pre-selects an instrument.
 *   - getEffectiveRange(i) — return the saved-or-preset range for instrument i.
 *   - setRange(r)          — programmatic set (used by tests / debugging).
 *   - clearRange()         — clear all saved ranges (forces re-prompt).
 *   - rangePresets         — the static INSTRUMENT_PRESETS map.
 *   - midiToName / nameToMidi — scientific-pitch conversion helpers.
 */
(function () {
  'use strict';

  // Per-instrument range presets (concert-pitch MIDI note numbers). Used as
  // defaults when the user hasn't customized a given instrument's range.
  // Source: common method-book ranges; the user can override either bound
  // in the modal.
  const INSTRUMENT_PRESETS = {
    concert:  { label: 'Concert pitch',     low: 21,  high: 108, hint: 'Full piano range — no clamp' },
    soprano:  { label: 'Soprano Sax / Bb',  low: 56,  high: 100, hint: 'Ab3 – E6 (concert)' },
    alto:     { label: 'Alto Sax / Eb',     low: 49,  high: 81,  hint: 'Db3 – A5 (concert)' },
    tenor:    { label: 'Tenor Sax / Bb',    low: 44,  high: 76,  hint: 'Ab2 – E5 (concert)' },
    bari:     { label: 'Bari Sax / Eb',     low: 36,  high: 69,  hint: 'Db2 – A4 (concert)' },
    trumpet:  { label: 'Trumpet / Bb',      low: 52,  high: 84,  hint: 'E3 – C6 (concert)' },
    clarinet: { label: 'Clarinet / Bb',    low: 50,  high: 95,  hint: 'D3 – Bb6 (concert)' },
    bass:     { label: 'Bass',              low: 43,  high: 55,  hint: 'G2 – G3 (concert) — shown in bass clef' },
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
    if (pc < 0) pc += 12;
    return (octave + 1) * 12 + pc;
  }
  function isValidMidi(n) {
    return typeof n === 'number' && isFinite(n) && n >= 0 && n <= 127;
  }

  // ---------- storage (per-instrument) ----------

  const STORAGE_KEY = 'jazz_lex_ranges';
  const OLD_STORAGE_KEY = 'jazz_lex_range';

  function readAllRanges() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : {};
    } catch {
      return {};
    }
  }
  function writeAllRanges(map) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch (e) {
      console.warn('range-modal: could not persist ranges', e);
    }
  }
  function readRangeForInstrument(instrument) {
    const map = readAllRanges();
    const r = map[instrument];
    if (!r || !isValidMidi(r.lowMidi) || !isValidMidi(r.highMidi)) return null;
    if (r.lowMidi > r.highMidi) return null;
    if (!r.lowName) r.lowName = midiToName(r.lowMidi);
    if (!r.highName) r.highName = midiToName(r.highMidi);
    return r;
  }
  function writeRangeForInstrument(instrument, r) {
    const map = readAllRanges();
    map[instrument] = {
      lowMidi: r.lowMidi,
      highMidi: r.highMidi,
      lowName: r.lowName || midiToName(r.lowMidi),
      highName: r.highName || midiToName(r.highMidi),
    };
    writeAllRanges(map);
  }
  function migrateLegacy() {
    try {
      const oldRaw = localStorage.getItem(OLD_STORAGE_KEY);
      if (!oldRaw) return;
      const old = JSON.parse(oldRaw);
      if (!old || !isValidMidi(old.lowMidi) || !isValidMidi(old.highMidi)) {
        localStorage.removeItem(OLD_STORAGE_KEY);
        return;
      }
      if (!INSTRUMENT_PRESETS[old.instrument]) {
        localStorage.removeItem(OLD_STORAGE_KEY);
        return;
      }
      writeRangeForInstrument(old.instrument, old);
      localStorage.removeItem(OLD_STORAGE_KEY);
    } catch {}
  }
  function clearRange() {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    try { localStorage.removeItem(OLD_STORAGE_KEY); } catch {}
  }
  function hasAnySavedRange() {
    const map = readAllRanges();
    return Object.keys(map).length > 0;
  }

  // The effective range for an instrument: the user's saved value if
  // present, otherwise the preset default. Always returns a complete
  // range object (never null) for a known instrument.
  function getEffectiveRange(instrument) {
    if (!INSTRUMENT_PRESETS[instrument]) return null;
    const saved = readRangeForInstrument(instrument);
    if (saved) {
      saved.instrument = instrument;
      return saved;
    }
    const preset = INSTRUMENT_PRESETS[instrument];
    return {
      instrument: instrument,
      lowMidi: preset.low,
      highMidi: preset.high,
      lowName: midiToName(preset.low),
      highName: midiToName(preset.high),
    };
  }

  // ---------- DOM building ----------

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

    // Pre-fill logic:
    //   - opts.existingRange overrides everything (caller-supplied)
    //   - else: read this instrument's effective range. opts.preferredInstrument
    //     lets the caller (e.g. Practice page "change" link) hint which
    //     instrument to pre-select.
    //   - last-resort default: tenor.
    const preferredInstrument = opts.preferredInstrument ||
      (opts.existingRange && opts.existingRange.instrument);
    let instrument = preferredInstrument;
    if (!INSTRUMENT_PRESETS[instrument]) instrument = 'tenor';

    let lowMidi, highMidi;
    let hasSaved = false;
    if (opts.existingRange) {
      instrument = opts.existingRange.instrument || instrument;
      lowMidi = opts.existingRange.lowMidi;
      highMidi = opts.existingRange.highMidi;
      hasSaved = true;
    } else {
      const r = getEffectiveRange(instrument);
      lowMidi = r.lowMidi;
      highMidi = r.highMidi;
      hasSaved = !!readRangeForInstrument(instrument);
    }
    if (!isValidMidi(lowMidi)) lowMidi = INSTRUMENT_PRESETS[instrument].low;
    if (!isValidMidi(highMidi)) highMidi = INSTRUMENT_PRESETS[instrument].high;

    const sel = overlay.querySelector('#range-instrument');
    sel.value = instrument;
    populateNoteSelects(overlay, lowMidi, highMidi);
    refreshHint(overlay);
    validateRange(overlay);

    sel.addEventListener('change', function () {
      const r = getEffectiveRange(sel.value);
      if (r) populateNoteSelects(overlay, r.lowMidi, r.highMidi);
      refreshHint(overlay);
      validateRange(overlay);
    });
    overlay.querySelector('#range-low').addEventListener('change', function () { validateRange(overlay); });
    overlay.querySelector('#range-high').addEventListener('change', function () { validateRange(overlay); });

    overlay.querySelector('#range-confirm').addEventListener('click', function () {
      const result = validateRange(overlay, /*strict*/ true);
      if (!result.ok) return;
      const instrument = sel.value;
      const range = {
        instrument: instrument,
        lowMidi: parseInt(overlay.querySelector('#range-low').value, 10),
        highMidi: parseInt(overlay.querySelector('#range-high').value, 10),
      };
      range.lowName = midiToName(range.lowMidi);
      range.highName = midiToName(range.highMidi);
      writeRangeForInstrument(instrument, range);
      window.rangeInfo = range;
      lockBody(false);
      overlay.remove();
      if (typeof opts.onConfirm === 'function') opts.onConfirm(range);
      window.dispatchEvent(new CustomEvent('range-changed', { detail: range }));
    });

    setTimeout(function () {
      const first = overlay.querySelector('select, button');
      if (first) first.focus();
    }, 0);
    // Esc closes the modal only when there is an existing range for the
    // current instrument (i.e. user is editing, not being onboarded).
    if (hasSaved) {
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

  // First-visit gate. Called on every page load. Migrates the legacy
  // single-instrument key (if present) into the per-instrument map, then
  // prompts if and only if no range has ever been saved.
  function init() {
    migrateLegacy();
    const has = hasAnySavedRange();
    if (!has) {
      lockBody(true);
      openModal({});
    }
    // Expose the most recently saved range as the active one. If multiple
    // instruments have saved ranges, this is the last one written (we
    // don't track order; this is a sensible default and the Practice
    // page uses getEffectiveRange() to look up the active instrument's
    // range explicitly).
    const map = readAllRanges();
    const keys = Object.keys(map);
    if (keys.length > 0) {
      const last = map[keys[keys.length - 1]];
      last.instrument = keys[keys.length - 1];
      window.rangeInfo = last;
    } else {
      window.rangeInfo = null;
    }
  }

  window.openRangeModal = function (opts) {
    if (typeof opts === 'function') opts = { onConfirm: opts };
    openModal(opts || {});
  };
  window.setRange = function (r) {
    if (!r || !r.instrument) return;
    r.lowName = r.lowName || midiToName(r.lowMidi);
    r.highName = r.highName || midiToName(r.highMidi);
    writeRangeForInstrument(r.instrument, r);
    window.rangeInfo = r;
    window.dispatchEvent(new CustomEvent('range-changed', { detail: r }));
  };
  window.clearRange = function () {
    clearRange();
    window.rangeInfo = null;
  };
  window.getEffectiveRange = getEffectiveRange;
  window.rangePresets = INSTRUMENT_PRESETS;
  window.midiToName = midiToName;
  window.nameToMidi = nameToMidi;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
