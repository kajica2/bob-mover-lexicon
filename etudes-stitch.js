/* Stitch multiple exercises into a single MusicXML etude.
 *
 * Pure JS, no music21, runs in the browser. Operates on raw MusicXML
 * strings from /api/musicxml/<id> (already title-injected + clef-dedup'd
 * by the server, so each source part has its own <work><work-title> and
 * one <clef> on the first measure).
 *
 * Operations:
 *   1. fetchSource(id)            — fetch and unwrap a single exercise
 *   2. transpose(xml, semitones) — shift every <pitch> by N semitones
 *   3. stitch(parts, name)       — concatenate multiple parts into one,
 *                                   merging measures into a single <part>,
 *                                   rewriting <work-title>, dropping extra
 *                                   <print> elements, inserting light
 *                                   <barline> markers between segments.
 *
 * Idempotent: stitch() over a single part returns that part's measures
 * unchanged in pitch (modulo transpose). stitch() over 12 parts produces
 * one part with N*measures from each source.
 *
 * Scope: treble clef, single voice per exercise, free-rhythm notation.
 * Doesn't yet handle: multi-voice sources (collapses to voice 1),
 * key-signature preservation across segments (Audiveris output for these
 * exercises has no <key> elements so this is moot), time-signature
 * joining (the Lexicon is free-rhythm, no <time> elements).
 */
(function () {
  'use strict';

  const STEP_TO_OFFSET = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const OFFSET_TO_STEP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  // Note: 'B#' is enharmonically 'C' but we don't expect it from these exercises.
  const FLAT_TO_OFFSET = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  function pitchToMidi(step, alter, octave) {
    const baseOffset = STEP_TO_OFFSET[step];
    if (baseOffset === undefined) {
      throw new Error('Unknown step: ' + step);
    }
    const alt = alter ? parseInt(alter, 10) : 0;
    return (parseInt(octave, 10) + 1) * 12 + baseOffset + alt;
  }

  function midiToPitch(midi) {
    // Normalise to a natural pitch class; we'll pick sharp/flat based on
    // how many naturals we cross, defaulting to the sharp spelling for
    // chromatic notes (the Lexicon convention).
    const pitchClass = ((midi % 12) + 12) % 12;
    const octave = Math.floor(midi / 12) - 1;
    const step = OFFSET_TO_STEP[pitchClass].charAt(0);
    const accidental = OFFSET_TO_STEP[pitchClass].length > 1
      ? (OFFSET_TO_STEP[pitchClass].charAt(1) === '#' ? '1' : '-1')
      : '0';
    return { step: step, alter: accidental, octave: String(octave) };
  }

  // Transpose every <pitch> in an XML string by N semitones. Returns a new
  // string. Handles <step>, <alter>, <octave> with surrounding whitespace
  // and newlines.
  function transposePitch(xml, semitones) {
    if (!semitones) return xml;
    return xml.replace(
      /<pitch>[\s\S]*?<\/pitch>/g,
      function (pitchBlock) {
        const stepMatch = pitchBlock.match(/<step>\s*([A-G])\s*<\/step>/);
        const alterMatch = pitchBlock.match(/<alter>\s*(-?\d+)\s*<\/alter>/);
        const octaveMatch = pitchBlock.match(/<octave>\s*(-?\d+)\s*<\/octave>/);
        if (!stepMatch || !octaveMatch) return pitchBlock;
        const step = stepMatch[1];
        const alter = alterMatch ? parseInt(alterMatch[1], 10) : 0;
        const octave = parseInt(octaveMatch[1], 10);
        const midi = pitchToMidi(step, alter, octave);
        const newPitch = midiToPitch(midi + semitones);
        return (
          '<pitch>' +
            '<step>' + newPitch.step + '</step>' +
            (newPitch.alter === '0' ? '' : '<alter>' + newPitch.alter + '</alter>') +
            '<octave>' + newPitch.octave + '</octave>' +
          '</pitch>'
        );
      }
    );
  }

  // Fetch + unwrap a single exercise's MusicXML. The server returns the
  // <score-partwise> root element directly.
  async function fetchSource(exerciseId, semitones) {
    const url = '/api/musicxml/' + exerciseId +
                '?instrument=concert&transpose=0&low=21&high=108';
    const r = await fetch(url);
    if (!r.ok) throw new Error('Failed to fetch ex ' + exerciseId + ': HTTP ' + r.status);
    let xml = await r.text();
    if (semitones) xml = transposePitch(xml, semitones);
    // v31: strip <harmony> elements (chord symbols). The server injects
    // them on the served MusicXML for the practice page (so the player
    // sees the chord progression while practicing), but the etude
    // generator doesn't want them — an etude stitches many sources and
    // the chord labels from one source would be misleading on the next
    // (different key, different progression). Drop all of them here.
    xml = xml.replace(/<harmony>[\s\S]*?<\/harmony>/g, '');
    xml = xml.replace(/<harmony\b[^>]*\/>/g, '');  // self-closing variant
    return xml;
  }

  // Strip the source's existing <work><work-title>...</work-title></work>
  // block. The server injects this for /api/musicxml/<id> so the served
  // score can render its own title; for stitched etudes, the new etude
  // title takes its place. Verovio rejects multiple <work> blocks.
  function stripWorkBlock(xml) {
    return xml.replace(/<work>[\s\S]*?<\/work>/, '');
  }

  // Pull out every <measure ...>...</measure> block in order. Returns the
  // FULL element (opening tag + body + closing tag) so the stitcher can
  // drop them into the new <part> unchanged. Walks the XML by index,
  // tracking the open/close tag positions so we handle the case where a
  // measure attribute string contains '>' (the Lexicon's measures don't
  // have quoted attributes with '>', but the algorithm is robust either
  // way).
  function extractMeasures(xml) {
    const measures = [];
    let i = 0;
    while (true) {
      const openIdx = xml.indexOf('<measure', i);
      if (openIdx < 0) break;
      const gtIdx = xml.indexOf('>', openIdx);
      if (gtIdx < 0) break;
      const closeIdx = xml.indexOf('</measure>', gtIdx);
      if (closeIdx < 0) break;
      // Include the opening tag (so the measure keeps its number= and width=
      // attributes) and the closing tag. The body between them is just notes
      // and barlines.
      const fullMeasure = xml.slice(openIdx, closeIdx + '</measure>'.length);
      measures.push(fullMeasure);
      i = closeIdx + '</measure>'.length;
    }
    return measures;
  }

  // Pull out the part-list (the <part-list>...</part-list> block, including
  // <score-part> definitions). We rewrite all <score-part id="P1"> to P1,
  // but our stitched output only has one part so we just keep the first.
  function extractPartList(xml) {
    const m = xml.match(/<part-list>[\s\S]*?<\/part-list>/);
    return m ? m[0] : '<part-list></part-list>';
  }

  // Strip all <print>...</print> blocks. We don't want Audiveris's
  // measure-numbering "system" markers to repeat; the stitched etude
  // gets fresh numbering.
  function stripPrintElements(xml) {
    return xml.replace(/<print\b[^>]*>[\s\S]*?<\/print>/g, '');
  }

  // Insert a system-break <print> after a given measure body so Verovio
  // starts a new line. Used between stitched segments for readability.
  function withSystemBreak(body) {
    return '<print new-system="yes"/>' + body;
  }

  // The main entry point. Takes:
  //   parts: [{ id: number, semitones: number }, ...]
  //   name : string (the etude title to inject)
  // Returns: a MusicXML string (the stitched score)
  async function stitch(parts, name) {
    if (!parts || !parts.length) throw new Error('stitch: parts is empty');
    if (parts.length > 12) throw new Error('stitch: max 12 exercises per etude');

    const sources = [];
    for (let i = 0; i < parts.length; i++) {
      sources.push(await fetchSource(parts[i].id, parts[i].semitones || 0));
    }

    // Use the first source's <score-partwise> as the scaffold. We replace
    // its <part-list>, <work>, and <part> contents with the stitched result.
    const firstSrc = sources[0];

    // Collect measures from every source, strip their <print> elements,
    // strip their <work> blocks (replaced by the etude title), strip
    // right-edge <barline> elements (they'd render at every internal
    // boundary and clutter the score), and concatenate. Insert a system-
    // break <print> between segments.
    const allMeasures = [];
    for (let i = 0; i < sources.length; i++) {
      const xml = sources[i];
      const cleaned = stripPrintElements(stripWorkBlock(xml));
      const measures = extractMeasures(cleaned);
      if (!measures.length) continue;
      // Strip any <barline> from inside each measure — they're end-of-
      // measure markers that confuse the layout when measures are stitched.
      for (let j = 0; j < measures.length; j++) {
        measures[j] = measures[j].replace(/<barline\b[^>]*>[\s\S]*?<\/barline>/g, '');
      }
      // v29: time signatures are preserved as-is. The Bob Mover Lexicon
      // doesn't emit <time> elements (it's "free-rhythm"), but if a
      // future source has one, it passes through unchanged. We never
      // synthesise, rewrite, or normalise time signatures here — that
      // would silently change the feel of the source. If the user
      // wants a uniform time signature across an etude whose sources
      // disagree, that should be a deliberate step (e.g. a separate
      // "normalise" action), not a side effect of stitching.
      if (i > 0) allMeasures.push(withSystemBreak(measures[0]));
      else allMeasures.push(measures[0]);
      for (let j = 1; j < measures.length; j++) {
        allMeasures.push(measures[j]);
      }
    }

    // Sanity: stitch across the same exercise ID is fine (produces
    // repeated content); stitch across zero measures throws.
    if (!allMeasures.length) {
      throw new Error('stitch: no measures extracted from sources');
    }

    // Compose the new <part> with a single id. We replace the original
    // <part id="P1">...</part> contents (between </identification>-
    // <defaults>-<part-list> on the front and </score-partwise> on the
    // end) — but easier: keep the prefix up to and including <part-list>,
    // then emit one stitched <part>, then </score-partwise>.
    // We strip <work> from firstSrc BEFORE extracting the prefix so the
    // server-injected title (e.g. "Chromatic · #17") doesn't leak through;
    // the etude title takes its place.
    const cleanedFirstSrc = stripWorkBlock(firstSrc);
    const prefixMatch = cleanedFirstSrc.match(/[\s\S]*?<\/part-list>/);
    if (!prefixMatch) {
      throw new Error('stitch: source XML is malformed (no </part-list>)');
    }
    const prefix = prefixMatch[0];

    // Inject the new title
    const safeTitle = String(name || 'Untitled Etude')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const workBlock = '<work><work-title>' + safeTitle + '</work-title></work>';
    // Insert after <score-partwise version="...">
    const prefixWithWork = prefix.replace(
      /(<score-partwise[^>]*>)/,
      '$1' + workBlock
    );

    const stitchedPart =
      '<part id="P1">' + allMeasures.join('') + '</part>';

    return prefixWithWork + stitchedPart + '</score-partwise>';
  }

  // Count <note> elements in a stitched MusicXML string. Used by the UI
  // to display "32 notes" in the saved-etudes list.
  function countNotes(xml) {
    if (!xml) return 0;
    const matches = xml.match(/<note\b/g);
    return matches ? matches.length : 0;
  }

  // Count <measure> elements.
  function countMeasures(xml) {
    if (!xml) return 0;
    const matches = xml.match(/<measure\b(?!-numbering)/g);
    return matches ? matches.length : 0;
  }
  function countNotes(xml) {
    if (!xml) return 0;
    const matches = xml.match(/<note\b/g);
    return matches ? matches.length : 0;
  }

  // Walk a MusicXML string and rewrite any note whose MIDI falls outside
  // [lowMidi, highMidi] so it falls within, by shifting the <octave>.
  // Returns { xml, moved }. Mirrors server.py:clamp_notes_to_range() so
  // the browser-side result matches what the server would have produced
  // for a single exercise (the server doesn't run on stitched scores;
  // this is the equivalent in JS).
  function clampToRange(xml, lowMidi, highMidi) {
    if (!xml) return { xml, moved: 0 };
    let moved = 0;
    const pitchRe = /<pitch\b[^>]*>([\s\S]*?)<\/pitch>/g;
    const out = xml.replace(pitchRe, function (fullMatch, body) {
      // Match step with optional accidental: A–G, optional 'b' or '#'.
      const stepM = /<step>\s*([A-Ga-g][#b]?)\s*<\/step>/.exec(body);
      const octM  = /<octave>\s*(-?\d+)\s*<\/octave>/.exec(body);
      if (!stepM || !octM) return fullMatch;
      const step = stepM[1].toUpperCase();
      const octave = parseInt(octM[1], 10);
      const altM = /<alter>\s*(-?\d+)\s*<\/alter>/.exec(body);
      const alter = altM ? parseInt(altM[1], 10) : 0;
      const midi = pitchToMidiRange(step, alter, octave);
      if (midi < 0) return fullMatch; // unparseable, leave alone
      if (midi >= lowMidi && midi <= highMidi) return fullMatch; // in range
      // Try to shift to a neighbour in the same diatonic step that lands
      // in range. If no neighbour in range exists (e.g. range is a single
      // MIDI value, or too narrow for the step), leave the note alone —
      // there's no point in feeding the user a note that's still out of
      // range; the alternative is to alert them.
      // Up to 6 octaves either way covers all horn ranges we'll ever see.
      let bestShift = 0;
      for (let s = -6; s <= 6; s++) {
        if (s === 0) continue;
        const m = pitchToMidiRange(step, alter, octave + s);
        if (m < 0) continue;
        if (m >= lowMidi && m <= highMidi) {
          bestShift = s;
          break;
        }
      }
      if (bestShift === 0) return fullMatch; // no valid shift exists
      moved++;
      return fullMatch.replace(
        /<octave>\s*-?\d+\s*<\/octave>/,
        '<octave>' + (octave + bestShift) + '</octave>'
      );
    });
    return { xml: out, moved: moved };
  }
  // Inverse of the existing pitchToMidi (line 35 above). Wraps it with
  // a sharp- and flat-prefix-aware fallback so clampToRange doesn't
  // throw on '<step>Bb</step>' or '<step>F#</step>' which the rest of
  // the file would otherwise trip on. Returns -1 on truly unparseable
  // input (caller will leave the note unchanged).
  function pitchToMidiRange(step, alter, octave) {
    try {
      return pitchToMidi(step, alter, octave);
    } catch (e) {
      if (step.length === 2 && step[0] in STEP_TO_OFFSET) {
        const delta = step[1] === '#' ? 1 : step[1] === 'b' ? -1 : 0;
        if (delta === 0) return -1;
        try {
          return pitchToMidi(step[0], (alter || 0) + delta, octave);
        } catch (e2) {
          return -1;
        }
      }
      return -1;
    }
  }

  // ---------- Master Class etude builder ----------
  //
  // Generates a complete MusicXML document for a single line from the
  // Master Class curriculum. Unlike stitch() (which concatenates
  // exercises from the server), this is a fresh, single-part score
  // built from the curriculum's note-level data:
  //
  //   buildMasterClassEtude(etude, line) -> MusicXML string
  //
  // Inputs:
  //   etude : { title, bpm, timeSig, lines: [...], ... }
  //   line  : { name, description, chords: [{name, bars: [{notes: [...]}]}] }
  //
  // Each `note` is { p: 'C4' | null, d: 1 } (p=null = rest).
  //
  // Why a separate builder rather than reusing stitch():
  //   - The curriculum is note-level (we have the actual pitches), not
  //     exercise-level. There's no server source to fetch.
  //   - The output is a single Part, single Voice, treble-clef, 4/4 score.
  //     The 3/4 waltz is encoded as 4/4 with a quarter rest on beat 4 —
  //     the practice page's parseMusicXML hardcodes 4 beats per measure
  //     so a true 3/4 time signature would mis-time the notes.
  //   - The user's title is injected as <work-title>.
  //
  // Asserts at runtime:
  //   - Every bar's notes sum to exactly 4 beats (a data error here
  //     would be silent otherwise; the practice page would just play
  //     a mis-timed score).
  //   - Every pitch string parses to step+alter+octave.
  //
  // Helper: convert a pitch string ('C4', 'Bb3', 'F#5', 'Fb4', 'Bbb3')
  // into { step, alter, octave } for the MusicXML <pitch> block.
  // Supports up to two sharps or two flats (MusicXML's <alter> range).
  function parsePitchString(p) {
    // Match the letter, optional 1-2 accidentals, then the octave digits.
    const m = /^([A-G])(##|bb|#|b)?(-?\d+)$/.exec(p);
    if (!m) throw new Error('parsePitchString: bad pitch "' + p + '"');
    const step = m[1];
    const acc = m[2] || '';
    const octave = parseInt(m[3], 10);
    let alter = 0;
    if (acc === '#')  alter = 1;
    else if (acc === 'b')  alter = -1;
    else if (acc === '##') alter = 2;
    else if (acc === 'bb') alter = -2;
    return { step: step, alter: alter, octave: octave };
  }

  // Helper: convert a beat duration (1=quarter, 0.5=eighth, etc.) to a
  // MusicXML <type> string. We map the standard set: whole=4, half=2,
  // quarter=1, eighth=0.5, 16th=0.25. Anything else is rounded to the
  // nearest of those five.
  function durationToType(beats) {
    // Compare with a small epsilon so floating-point drift (e.g. 0.5+0.5)
    // doesn't push us into the wrong bucket.
    const eps = 0.001;
    if (Math.abs(beats - 4)    < eps) return 'whole';
    if (Math.abs(beats - 2)    < eps) return 'half';
    if (Math.abs(beats - 1)    < eps) return 'quarter';
    if (Math.abs(beats - 0.5)  < eps) return 'eighth';
    if (Math.abs(beats - 0.25) < eps) return '16th';
    // Fallback: round to nearest supported type. This shouldn't fire
    // if the curriculum data is sane (all bars sum to exactly 4 with
    // types drawn from {whole, half, quarter, eighth, 16th}), but we
    // degrade gracefully rather than throwing.
    if (beats >= 3)    return 'whole';
    if (beats >= 1.5)  return 'half';
    if (beats >= 0.75) return 'quarter';
    if (beats >= 0.375) return 'eighth';
    return '16th';
  }

  // Build one <note> element. `note` is { p, d } from the curriculum
  // (p=null → rest). `divisions` is the per-beat resolution (always
  // 4 here — a quarter = 4 divisions, so a half = 8, a whole = 16).
  function buildNoteXml(note, divisions) {
    const dur = Math.round(note.d * divisions);
    const type = durationToType(note.d);
    if (note.p == null) {
      return (
        '<note>' +
          '<rest/>' +
          '<duration>' + dur + '</duration>' +
          '<type>' + type + '</type>' +
        '</note>'
      );
    }
    const { step, alter, octave } = parsePitchString(note.p);
    return (
      '<note>' +
        '<pitch>' +
          '<step>' + step + '</step>' +
          (alter === 0 ? '' : '<alter>' + alter + '</alter>') +
          '<octave>' + octave + '</octave>' +
        '</pitch>' +
        '<duration>' + dur + '</duration>' +
        '<type>' + type + '</type>' +
      '</note>'
    );
  }

  // Build one <measure> element. `bar` is { notes: [...] } from the
  // curriculum. Asserts the bar sums to exactly 4 beats — a data
  // error in the curriculum should fail loud, not play a mis-timed
  // score in the practice page.
  function buildBarXml(bar, divisions, measureNumber) {
    let total = 0;
    for (let i = 0; i < bar.notes.length; i++) total += bar.notes[i].d;
    if (Math.abs(total - 4) > 0.001) {
      throw new Error(
        'buildBarXml: bar ' + measureNumber + ' sums to ' + total +
        ' beats, expected 4. This is a curriculum data error.'
      );
    }
    const notesXml = bar.notes.map(function (n) {
      return buildNoteXml(n, divisions);
    }).join('');
    return '<measure number="' + measureNumber + '">' + notesXml + '</measure>';
  }

  // Main entry point. Returns a complete MusicXML string ready to
  // save to IDB and hand to the practice page's renderScore.
  function buildMasterClassEtude(etude, line) {
    if (!etude || !line) throw new Error('buildMasterClassEtude: etude and line required');

    // Flatten chords → bars into a single ordered list of bar objects.
    // Each chord's `bars` is an array; we keep the chord name as a
    // comment in the measure so anyone reading the raw XML can see the
    // harmonic context. (Verovio ignores comments; this is purely for
    // human debugging.)
    const flatBars = [];
    for (let i = 0; i < line.chords.length; i++) {
      const ch = line.chords[i];
      for (let j = 0; j < ch.bars.length; j++) {
        flatBars.push({ notes: ch.bars[j].notes, chord: ch.name });
      }
    }
    if (!flatBars.length) throw new Error('buildMasterClassEtude: no bars in line');

    const divisions = 4;  // 1 quarter = 4 divisions (industry default)
    const bpm = etude.bpm || 80;
    const safeTitle = (etude.title + ' — ' + line.name)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // First measure: include <attributes> with divisions, key (C major /
    // no accidentals), time (4/4 — we always use 4/4 even for the
    // waltz, see header comment), and treble clef. Subsequent measures
    // are bare <note> sequences; the earlier <attributes> carry through.
    const firstBar = flatBars[0];
    const firstNotesXml = firstBar.notes.map(function (n) {
      return buildNoteXml(n, divisions);
    }).join('');
    const total0 = firstBar.notes.reduce(function (s, n) { return s + n.d; }, 0);
    if (Math.abs(total0 - 4) > 0.001) {
      throw new Error('buildMasterClassEtude: first bar sums to ' + total0 + ' beats, expected 4');
    }
    const measure1Xml =
      '<measure number="1">' +
        '<attributes>' +
          '<divisions>' + divisions + '</divisions>' +
          '<key><fifths>0</fifths></key>' +
          '<time><beats>4</beats><beat-type>4</beat-type></time>' +
          '<clef><sign>G</sign><line>2</line></clef>' +
        '</attributes>' +
        '<sound tempo="' + bpm + '"/>' +
        firstNotesXml +
      '</measure>';

    const restMeasuresXml = [];
    for (let i = 1; i < flatBars.length; i++) {
      restMeasuresXml.push(buildBarXml(flatBars[i], divisions, i + 1));
    }

    // Stitch everything into a complete <score-partwise> document.
    return (
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">' +
      '<score-partwise version="3.1">' +
        '<work><work-title>' + safeTitle + '</work-title></work>' +
        '<identification>' +
          '<creator type="composer">Bob Mover (Master Class)</creator>' +
          '<encoding><software>Bob Mover Lexicon — Master Class builder</software></encoding>' +
        '</identification>' +
        '<part-list>' +
          '<score-part id="P1"><part-name>Voice</part-name></score-part>' +
        '</part-list>' +
        '<part id="P1">' +
          measure1Xml +
          restMeasuresXml.join('') +
        '</part>' +
      '</score-partwise>'
    );
  }

  // Count <note> elements in a Master-Class-generated MusicXML string.
  // Mirrors countNotes() above but only counts non-rest notes — useful
  // for the saved-etudes card display ("4 notes" not "8 notes with 4
  // rests"). Mirrors the practice page's countNotes semantics.
  function countPitchedNotes(xml) {
    if (!xml) return 0;
    // Match <note>...</note> blocks that contain a <pitch> element.
    // We do this with a single regex by matching <note>...</note> then
    // checking for <pitch> in each block. For the Master Class's
    // small scores this is fast enough; for huge scores we'd switch
    // to a proper parser.
    const noteBlocks = xml.match(/<note>[\s\S]*?<\/note>/g) || [];
    let n = 0;
    for (let i = 0; i < noteBlocks.length; i++) {
      if (/<pitch>/.test(noteBlocks[i])) n++;
    }
    return n;
  }

  window.etudesStitch = {
    stitch: stitch,
    transposePitch: transposePitch,
    countNotes: countNotes,
    countMeasures: countMeasures,
    clampToRange: clampToRange,
    buildMasterClassEtude: buildMasterClassEtude,
    countPitchedNotes: countPitchedNotes,
  };
})();
