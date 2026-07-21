/* Constraint-based pattern generator for the Etudes page.
 *
 * Generates MusicXML directly (no server roundtrip, no music21 dependency
 * in the browser). All output is treble-clef single-voice free-rhythm in
 * the Bob Mover Lexicon convention: no time signature, <measure-numbering>
 * = "system" so Verovio only prints measure numbers between systems.
 *
 * Knobs:
 *   key            : 'C', 'F', 'Bb', 'Eb', 'G', 'D', 'A', 'E', 'Cmin',
 *                    'Dmin', 'Gmin', 'Amin'  (12 most-used keys)
 *   pattern        : 'chromatic' | 'triplets' | 'sixteenths' | 'mix'
 *   bars           : integer 1..8
 *   difficulty     : 'beginner' | 'intermediate' | 'advanced'
 *
 * Difficulty knobs (deterministic, no ML):
 *   - chromatic density: how often a chromatic neighbour fires
 *     beginner: every 4th step; intermediate: every 2nd; advanced: every step
 *   - leap frequency: chance of a P4/P5 leap per measure
 *     beginner: 0%; intermediate: 25%; advanced: 50%
 *   - range spread: half the saved user range (beginner) → full range (advanced)
 *   - phrase variation: every 4 bars introduce a direction change
 *
 * Output is wrapped in a minimal <score-partwise> document that Verovio
 * accepts. The function returns { musicxml, noteCount, range } so the
 * UI can show a preview before saving.
 */
(function () {
  'use strict';

  // ---------- Pitch tables ----------
  // Major scales (circle of fifths, ascending)
  const MAJOR_SCALES = {
    'C':  ['C', 'D', 'E', 'F', 'G', 'A', 'B'],
    'G':  ['G', 'A', 'B', 'C', 'D', 'E', 'F#'],
    'D':  ['D', 'E', 'F#', 'G', 'A', 'B', 'C#'],
    'A':  ['A', 'B', 'C#', 'D', 'E', 'F#', 'G#'],
    'E':  ['E', 'F#', 'G#', 'A', 'B', 'C#', 'D#'],
    'F':  ['F', 'G', 'A', 'Bb', 'C', 'D', 'E'],
    'Bb': ['Bb', 'C', 'D', 'Eb', 'F', 'G', 'A'],
    'Eb': ['Eb', 'F', 'G', 'Ab', 'Bb', 'C', 'D'],
  };
  // Natural minor scales
  const MINOR_SCALES = {
    'Amin': ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
    'Dmin': ['D', 'E', 'F', 'G', 'A', 'Bb', 'C'],
    'Gmin': ['G', 'A', 'Bb', 'C', 'D', 'Eb', 'F'],
    'Emin': ['E', 'F#', 'G', 'A', 'B', 'C', 'D'],
    'Cmin': ['C', 'D', 'Eb', 'F', 'G', 'Ab', 'Bb'],
    'Fmin': ['F', 'G', 'Ab', 'Bb', 'C', 'Db', 'Eb'],
  };

  // MIDI helpers. octave = scientific octave (C4 = middle C = MIDI 60).
  function stepToOffset(step) {
    return { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[step];
  }
  function pitchToMidi(step, alter, octave) {
    return (octave + 1) * 12 + stepToOffset(step) + (alter || 0);
  }
  // Reverse: pick the nearest step+alter+octave for a target MIDI value.
  // Prefers sharp spelling for chromatic notes (the Lexicon convention).
  function midiToPitch(midi) {
    const octave = Math.floor(midi / 12) - 1;
    const pc = ((midi % 12) + 12) % 12;
    const TABLE = [
      ['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0],
      ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0],
    ];
    const [step, alter] = TABLE[pc];
    return { step, alter, octave };
  }

  // ---------- Scale + key helpers ----------
  function getScale(keyName) {
    if (MAJOR_SCALES[keyName]) return MAJOR_SCALES[keyName];
    if (MINOR_SCALES[keyName]) return MINOR_SCALES[keyName];
    throw new Error('Unknown key: ' + keyName);
  }

  // Given a key, return all natural + chromatic scale degrees as a sorted
  // MIDI array over a 2-octave range. Used for the chromatic pattern.
  function chromaticNotesAround(keyName, lowMidi, highMidi) {
    // Build natural scale
    const scale = getScale(keyName);
    // Pick a starting octave so the tonic is within range
    const tonicStep = scale[0];
    const tonicOctave = Math.max(3, Math.ceil((lowMidi + 2) / 12));
    const tonicMidi = pitchToMidi(tonicStep, 0, tonicOctave);
    // 2-octave chromatic walk up from tonic
    const out = [];
    for (let m = tonicMidi; m <= tonicMidi + 24; m++) {
      out.push(m);
    }
    return out.filter(function (m) { return m >= lowMidi && m <= highMidi; });
  }

  function diatonicNotesAround(keyName, lowMidi, highMidi) {
    const scale = getScale(keyName);
    const tonicStep = scale[0];
    const tonicOctave = Math.max(3, Math.ceil((lowMidi + 2) / 12));
    const tonicMidi = pitchToMidi(tonicStep, 0, tonicOctave);
    const out = [];
    for (let i = 0; i < 14; i++) {
      const stepIdx = i % 7;
      const octaveBump = Math.floor(i / 7);
      const step = scale[stepIdx];
      const midi = pitchToMidi(step, 0, tonicOctave + octaveBump);
      out.push(midi);
    }
    return out.filter(function (m) { return m >= lowMidi && m <= highMidi; });
  }

  // ---------- Difficulty knobs ----------
  const DIFFICULTY = {
    beginner: {
      chromaticEvery: 4,    // chromatic neighbour every 4 steps
      leapChance: 0.0,      // no P4/P5 leaps
      rangeFactor: 0.5,     // use 50% of user's saved range around the tonic
      tripletEmbellishChance: 0.0,
      sixteenthsLeapChance: 0.0,
    },
    intermediate: {
      chromaticEvery: 2,
      leapChance: 0.25,
      rangeFactor: 0.75,
      tripletEmbellishChance: 0.15,
      sixteenthsLeapChance: 0.15,
    },
    advanced: {
      chromaticEvery: 1,
      leapChance: 0.50,
      rangeFactor: 1.0,
      tripletEmbellishChance: 0.35,
      sixteenthsLeapChance: 0.30,
    },
  };

  // ---------- Pitch sequence generators ----------
  // Each returns an array of MIDI values for a single bar (or multi-bar).
  // They never emit notes outside [lowMidi, highMidi].

  // 8th-note chromatic pattern. 8 eighths per bar in 4/4.
  function chromaticBar(scale, anchor, low, high, diff) {
    const out = [anchor];
    let dir = 1;
    let stepsSinceFlip = 0;
    for (let i = 1; i < 8; i++) {
      // Every diff.chromaticEvery steps, fire a chromatic neighbour
      // (scale step + 1 semitone) before continuing.
      const shouldChromatic = (i % diff.chromaticEvery) === 0;
      // Every 4th step, consider flipping direction (phrase variation)
      if (stepsSinceFlip >= 4 && Math.random() < 0.3) {
        dir = -dir;
        stepsSinceFlip = 0;
      }
      stepsSinceFlip++;
      let next;
      if (shouldChromatic) {
        // Pick the nearest chromatic neighbour (up or down by 1 semitone)
        next = out[out.length - 1] + (dir === 1 ? 1 : -1);
        out.push(clamp(next, low, high));
        // Then take a real scale step too
        next = out[out.length - 1] + (dir === 1 ? 1 : -1);
      } else {
        // Real diatonic step
        next = out[out.length - 1] + dir;
      }
      out.push(clamp(next, low, high));
    }
    return out;
  }

  // 8th-note triplet pattern. 12 triplet-8ths per bar.
  function tripletBar(scale, anchor, low, high, diff, midAnchor) {
    const out = [anchor];
    let dir = 1;
    let stepsSinceFlip = 0;
    for (let i = 1; i < 12; i++) {
      if (stepsSinceFlip >= 5 && Math.random() < 0.25) {
        dir = -dir;
        stepsSinceFlip = 0;
      }
      stepsSinceFlip++;
      // Every 3rd note, consider inserting a chromatic neighbour
      let next;
      if (i % 3 === 0 && Math.random() < diff.tripletEmbellishChance) {
        next = out[out.length - 1] + (dir === 1 ? 1 : -1);
        out.push(clamp(next, low, high));
        next = out[out.length - 1] + dir;
      } else {
        next = out[out.length - 1] + dir;
      }
      out.push(clamp(next, low, high));
    }
    return out;
  }

  // 16th-note scalar pattern. 16 sixteenths per bar.
  function sixteenthBar(scale, anchor, low, high, diff) {
    const out = [anchor];
    let dir = 1;
    let stepsSinceFlip = 0;
    for (let i = 1; i < 16; i++) {
      // Leap every 8 sixteenths if advanced
      if (stepsSinceFlip >= 8 && Math.random() < diff.sixteenthsLeapChance) {
        const leap = (Math.random() < 0.5 ? -1 : 1) * (4 + Math.floor(Math.random() * 2));
        out.push(clamp(out[out.length - 1] + leap, low, high));
        dir = -dir; // flip after leap
        stepsSinceFlip = 0;
        continue;
      }
      stepsSinceFlip++;
      const next = out[out.length - 1] + dir;
      out.push(clamp(next, low, high));
    }
    return out;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // ---------- MusicXML emission ----------
  // Build a complete <score-partwise> document with N measures of
  // 8th-note (or triplet / 16th) content. Uses free-rhythm (no time
  // signature), treble clef, the user's key.
  function buildMusicXml(opts) {
    const key = opts.key;
    const pattern = opts.pattern;
    const bars = opts.bars;
    const diff = DIFFICULTY[opts.difficulty] || DIFFICULTY.intermediate;
    const lowMidi = Math.max(36, Math.min(opts.lowMidi, opts.highMidi));
    const highMidi = Math.min(96, Math.max(opts.lowMidi, opts.highMidi));
    // Range factor: at advanced, use full range; at beginner, narrow.
    const center = Math.round((lowMidi + highMidi) / 2);
    const halfRange = Math.round((highMidi - lowMidi) * diff.rangeFactor / 2);
    const adjLow = Math.max(lowMidi, center - halfRange);
    const adjHigh = Math.min(highMidi, center + halfRange);

    const scale = getScale(key);
    // Anchor: tonic at the center of the adjusted range
    const tonicMidi = clamp(pitchToMidi(scale[0], 0, 4), adjLow, adjHigh);
    let anchor = tonicMidi;
    let dir = 1;

    // Decide which pattern per bar (for 'mix' mode)
    function patternFor(barIndex) {
      if (pattern === 'chromatic') return 'chromatic';
      if (pattern === 'triplets') return 'triplets';
      if (pattern === 'sixteenths') return 'sixteenths';
      // mix: cycle
      const cycle = ['chromatic', 'triplets', 'sixteenths', 'chromatic',
                     'chromatic', 'sixteenths', 'triplets', 'chromatic'];
      return cycle[barIndex % cycle.length];
    }

    // Build all measures
    const measures = [];
    for (let b = 0; b < bars; b++) {
      const pat = patternFor(b);
      let pitches;
      if (pat === 'chromatic') pitches = chromaticBar(scale, anchor, adjLow, adjHigh, diff);
      else if (pat === 'triplets') pitches = tripletBar(scale, anchor, adjLow, adjHigh, diff);
      else pitches = sixteenthBar(scale, anchor, adjLow, adjHigh, diff);
      // Every 4 bars, also try a leap if advanced
      if (b > 0 && b % 4 === 0 && Math.random() < diff.leapChance) {
        const leap = (Math.random() < 0.5 ? -1 : 1) * (4 + Math.floor(Math.random() * 2));
        anchor = clamp(anchor + leap, adjLow, adjHigh);
        // Replace the first note of this bar with the new anchor
        pitches[0] = anchor;
      } else {
        // Update anchor to the last note of this bar
        anchor = clamp(pitches[pitches.length - 1], adjLow, adjHigh);
      }
      const measureXml = buildMeasure(b + 1, pat, pitches);
      measures.push(measureXml);
    }

    // Compose the full MusicXML
    const title = opts.name || 'Pattern Library etude';
    const safeTitle = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0.3 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n' +
      '<score-partwise version="4.0.3">\n' +
        '<work><work-title>' + safeTitle + '</work-title></work>\n' +
        '<identification><encoding><software>Bob Mover Lexicon Pattern Generator</software></encoding></identification>\n' +
        '<part-list><score-part id="P1"><part-name></part-name></score-part></part-list>\n' +
        '<part id="P1">\n' +
        measures.join('\n') + '\n' +
        '</part>\n' +
      '</score-partwise>\n'
    );
  }

  // Build one <measure> element. `pitches` is an array of MIDI values.
  // `pattern` is the rhythm type for proper note durations.
  function buildMeasure(measureNum, pattern, pitches) {
    let body = '';
    if (measureNum === 1) {
      body += '<attributes>' +
        '<divisions>6</divisions>' +
        '<key><fifths>0</fifths></key>' +
        '<clef><sign>G</sign><line>2</line></clef>' +
        '</attributes>';
    }
    body += '<print><measure-numbering>system</measure-numbering></print>';
    // Compute note duration based on pattern.
    // - chromatic = 8th note -> divisions 3 (6/2)
    // - triplets   = triplet 8th -> divisions 2 (6/3)
    // - sixteenths = 16th note -> divisions 1.5? MusicXML requires integer
    //   divisions. We use divisions=12 for sixteenths so 16th = 3 units.
    // To keep things simple across patterns, we use divisions=12 throughout,
    // and pick duration units per pattern:
    //   chromatic: 6 (8th note in 12-division)
    //   triplets:  4 (triplet 8th in 12-division)
    //   sixteenths: 3 (16th in 12-division)
    const durUnit = pattern === 'sixteenths' ? 3 : pattern === 'triplets' ? 4 : 6;
    for (let i = 0; i < pitches.length; i++) {
      body += midiToNoteXml(pitches[i], durUnit);
    }
    return '<measure number="' + measureNum + '">' + body + '</measure>';
  }

  function midiToNoteXml(midi, durUnit) {
    const p = midiToPitch(midi);
    const alterTag = p.alter ? '<alter>' + p.alter + '</alter>' : '';
    return (
      '<note>' +
        '<pitch>' +
          '<step>' + p.step + '</step>' +
          alterTag +
          '<octave>' + p.octave + '</octave>' +
        '</pitch>' +
        '<duration>' + durUnit + '</duration>' +
        '<voice>1</voice>' +
        '<type>' + (durUnit === 3 ? '16th' : durUnit === 4 ? 'eighth' : 'eighth') + '</type>' +
      '</note>'
    );
  }

  // ---------- Public API ----------
  function generate(opts) {
    if (!opts || !opts.key) throw new Error('generate: opts.key is required');
    if (!opts.pattern) throw new Error('generate: opts.pattern is required');
    if (!opts.bars || opts.bars < 1 || opts.bars > 8) {
      throw new Error('generate: opts.bars must be 1..8');
    }
    if (!DIFFICULTY[opts.difficulty]) {
      opts.difficulty = 'intermediate';
    }
    if (typeof opts.lowMidi !== 'number') opts.lowMidi = 53; // F3
    if (typeof opts.highMidi !== 'number') opts.highMidi = 79; // G5
    const xml = buildMusicXml(opts);
    const noteCount = (xml.match(/<note\b/g) || []).length;
    let pMin = null, pMax = null;
    const re = /<step>([A-G])<\/step>(?:<alter>(-?\d+)<\/alter>)?<octave>(-?\d+)<\/octave>/g;
    let m;
    while ((m = re.exec(xml))) {
      const step = m[1];
      const alter = m[2] ? parseInt(m[2], 10) : 0;
      const octave = parseInt(m[3], 10);
      const midi = pitchToMidi(step, alter, octave);
      if (pMin === null || midi < pMin) pMin = midi;
      if (pMax === null || midi > pMax) pMax = midi;
    }
    return {
      musicxml: xml,
      noteCount: noteCount,
      range: pMin !== null ? { low: pMin, high: pMax } : null,
    };
  }

  window.patternGenerator = {
    KEYS: Object.keys(MAJOR_SCALES).concat(Object.keys(MINOR_SCALES)),
    PATTERNS: ['chromatic', 'triplets', 'sixteenths', 'mix'],
    DIFFICULTIES: Object.keys(DIFFICULTY),
    generate: generate,
  };
})();
