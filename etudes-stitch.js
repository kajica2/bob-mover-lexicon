/* Stitch multiple exercises into a single MusicXML etude.
 *
 * Pure JS, no music21, runs in the browser. Operates on raw MusicXML
 * strings from /api/musicxml/<id> (already title-injected + clef-dedup'd
 * by the server, so each source part has its own <work><work-title> and
 * one <clef> on the first measure).
 *
 * Operations:
 *   1. fetchSource(id)            -- fetch and unwrap a single exercise
 *   2. transpose(xml, semitones) -- shift every <pitch> by N semitones
 *   3. respellInKey(xml, fifths) -- re-spell every <pitch> to match the
 *                                   new key signature (so the user sees
 *                                   "F major" instead of "C major with
 *                                   every note F#-accidented"); also
 *                                   strips now-redundant explicit alters
 *                                   that the key sig would have provided.
 *   4. injectKeySignature(xml, N) -- add <key><fifths>N</fifths></key> to
 *                                   the first measure's <attributes>
 *                                   block (creating the block if needed).
 *   5. stitch(parts, name)       -- concatenate multiple parts into one,
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
 * Doesn't yet handle: multi-voice sources (collapses to voice 1), or
 * per-measure key signatures when the etude mixes transpositions (the
 * etude's key is taken from the first part; segments at a different
 * transposition will be in the wrong key visually -- the pitches are
 * still correct, the user just sees accidentals that don't match a
 * real key). time-signature joining is also a no-op (the Lexicon is
 * free-rhythm, no <time> elements).
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

  // Map a semitone offset (mod 12) to a key-signature <fifths> value.
  // We use the conventional flat-side keys for the 1-6 semitone range
  // (Db, Eb, F, Gb/F# written as Gb, Ab, Bb) so the etude lands in the
  // most-readable key for each transposition amount. The result is a
  // number in [-7, 7] suitable for <fifths>.
  //   0 -> C(0)   1 -> Db(-5) 2 -> D(2)   3 -> Eb(-3) 4 -> E(4)
  //   5 -> F(-1)  6 -> Gb(-6) 7 -> G(1)   8 -> Ab(-4) 9 -> A(3)
  //  10 -> Bb(-2) 11 -> B(5)
  const SEMITONES_TO_FIFTHS = { 0:0, 1:-5, 2:2, 3:-3, 4:4, 5:-1, 6:-6, 7:1, 8:-4, 9:3, 10:-2, 11:5 };
  function getKeyFifths(semitones) {
    if (!semitones) return 0;
    return SEMITONES_TO_FIFTHS[((semitones % 12) + 12) % 12];
  }

  // Map a key-signature <fifths> value to the set of letters it affects
  // (positive for sharps, negative for flats). Returns { 'F': 1, ... }.
  const SHARP_LETTER_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
  const FLAT_LETTER_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
  function getKeyLetterAlters(fifths) {
    const letters = {};
    if (fifths > 0) {
      for (let i = 0; i < fifths && i < SHARP_LETTER_ORDER.length; i++) {
        letters[SHARP_LETTER_ORDER[i]] = 1;
      }
    } else if (fifths < 0) {
      for (let i = 0; i < -fifths && i < FLAT_LETTER_ORDER.length; i++) {
        letters[FLAT_LETTER_ORDER[i]] = -1;
      }
    }
    return letters;
  }

  // Re-spell every <pitch> in an XML string for the given key signature.
  // Walks each pitch, computes the MIDI, then picks the most appropriate
  // (step, alter, octave) for the new key. The scoring prefers:
  //   1. pitches that the key sig provides "for free" (no explicit alter
  //      needed in the XML -- the renderer applies the key sig)
  //   2. the same letter as the original (so a "B natural" stays spelled
  //      as B, with a natural sign if the new key sig has Bb)
  //   3. preserving the direction of any original alteration (a "raised
  //      note" stays a sharp, a "lowered note" stays a flat)
  //   4. the same octave as the original
  //   5. for chromatic notes, the spelling that matches the key's
  //      general direction (flats in flat keys, sharps in sharp keys)
  // Returns a new XML string. Non-pitch elements are untouched.
  function respellInKey(xml, fifths) {
    if (!xml) return xml;
    const keyAlters = getKeyLetterAlters(fifths);
    const useFlat = fifths < 0;
    return xml.replace(/<pitch\b[^>]*>([\s\S]*?)<\/pitch>/g, function (fullMatch, body) {
      const stepM = /<step>\s*([A-Ga-g][#b]?)\s*<\/step>/.exec(body);
      const octM = /<octave>\s*(-?\d+)\s*<\/octave>/.exec(body);
      if (!stepM || !octM) return fullMatch;
      const step = stepM[1].charAt(0).toUpperCase();
      const octave = parseInt(octM[1], 10);
      const altM = /<alter>\s*(-?\d+)\s*<\/alter>/.exec(body);
      const oldAlter = altM ? parseInt(altM[1], 10) : 0;
      const oldMidi = pitchToMidi(step, oldAlter, octave);
      // Try every letter at up to 3 octaves (target, target-1, target+1)
      // and pick the highest-scoring spelling.
      const targetOct = Math.floor(oldMidi / 12) - 1;
      let best = null, bestScore = -1;
      const letters = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
      for (let li = 0; li < letters.length; li++) {
        const letter = letters[li];
        for (let od = -1; od <= 1; od++) {
          const tryOct = targetOct + od;
          const natMidi = pitchToMidi(letter, 0, tryOct);
          const explicitAlter = oldMidi - natMidi;
          if (explicitAlter < -2 || explicitAlter > 2) continue;
          const keyAlter = keyAlters[letter] || 0;
          let score = 0;
          // 1. Key-sig-provided pitch: emit no alter tag at all. This is
          //    the most-desired outcome -- the renderer draws the natural
          //    accidental from the key signature.
          if (explicitAlter === keyAlter) score += 100;
          // 2. Preserve the original letter (so B natural stays B, not Cb).
          if (letter === step) score += 20;
          // 3. Preserve the direction of any alteration.
          if (oldAlter !== 0 && Math.sign(explicitAlter) === Math.sign(oldAlter)) {
            score += 8;
          }
          if (oldAlter === 0 && explicitAlter === 0 && keyAlter === 0) {
            score += 8;
          }
          // 4. Diatonic alterations (single sharp/flat) are more conventional.
          if (Math.abs(explicitAlter) <= 1) score += 3;
          // 5. Same octave.
          if (od === 0) score += 2;
          // 6. For chromatic alterations, match the key's general direction.
          if (explicitAlter !== 0) {
            if (useFlat && explicitAlter < 0) score += 2;
            if (!useFlat && explicitAlter > 0) score += 2;
          }
          // Penalty: octave-displaced candidates are visually weird.
          if (od !== 0) score -= 5;
          if (best === null || score > bestScore) {
            best = { letter: letter, explicitAlter: explicitAlter, keyAlter: keyAlter,
                     score: score, octave: tryOct };
            bestScore = score;
          }
        }
      }
      if (!best) return fullMatch;  // no valid spelling, leave the pitch alone
      // Build the new <pitch> block. If the key sig naturally provides the
      // pitch, omit the <alter> tag entirely so we don't duplicate the
      // accidental on the staff.
      let newBody = '<step>' + best.letter + '</step>';
      if (best.explicitAlter !== best.keyAlter) {
        newBody += '<alter>' + best.explicitAlter + '</alter>';
      }
      newBody += '<octave>' + best.octave + '</octave>';
      return '<pitch>' + newBody + '</pitch>';
    });
  }

  // Add a <key><fifths>N</fifths></key> element to the first measure's
  // <attributes> block. If no <attributes> block exists, create one with
  // a minimal <divisions>1</divisions> so the key is legal. The canonical
  // MusicXML order inside <attributes> is: <divisions>, <key>, <time>,
  // <clef>, so we insert <key> right after <divisions> if present.
  function injectKeySignature(xml, fifths) {
    if (!xml) return xml;
    const keyTag = '<key><fifths>' + fifths + '</fifths></key>';
    // Look for an existing <attributes> on the first measure
    const firstAttrsM = xml.match(/<measure[^>]*>([\s\S]*?)<attributes>/);
    if (firstAttrsM) {
      // Insert <key> after <divisions> if present, else after <attributes>
      return xml.replace(
        /<attributes>([\s\S]*?)<\/attributes>/,
        function (fullAttrs, inner) {
          // If a <key> already exists, replace it
          if (/<key>[\s\S]*?<\/key>/.test(inner)) {
            return fullAttrs.replace(/<key>[\s\S]*?<\/key>/, keyTag);
          }
          const divM = /(<divisions>[\s\S]*?<\/divisions>)/.exec(inner);
          if (divM) {
            return fullAttrs.replace(divM[1], divM[1] + keyTag);
          }
          return fullAttrs.replace('<attributes>', '<attributes>' + keyTag);
        }
      );
    }
    // No <attributes> block on the first measure. Create one inside the
    // first <measure>, before the first <note> (or at the end of the
    // measure body if no <note>). Use <divisions>1</divisions> as a
    // safe default -- Verovio and most renderers are happy with this.
    const divTag = '<divisions>1</divisions>';
    const attrsBlock = '<attributes>' + divTag + keyTag + '</attributes>';
    return xml.replace(
      /<measure([^>]*)>([\s\S]*?)(<note\b)/,
      function (fullMatch, measureAttrs, bodyPrefix, firstNote) {
        return '<measure' + measureAttrs + '>' + bodyPrefix + attrsBlock + firstNote;
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
    if (semitones) {
      xml = transposePitch(xml, semitones);
      // After transposing, re-spell every pitch so the notation matches
      // the new key. Without this, the user sees "C major transposed to
      // F" as a stream of explicit sharp/flat accidentals on every note
      // that should be in the F-major key signature.
      xml = respellInKey(xml, getKeyFifths(semitones));
    }
    // v31: strip <harmony> elements (chord symbols). The server injects
    // them on the served MusicXML for the practice page (so the player
    // sees the chord progression while practicing), but the etude
    // generator doesn't want them -- an etude stitches many sources and
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
      // Strip any <barline> from inside each measure -- they're end-of-
      // measure markers that confuse the layout when measures are stitched.
      for (let j = 0; j < measures.length; j++) {
        measures[j] = measures[j].replace(/<barline\b[^>]*>[\s\S]*?<\/barline>/g, '');
      }
      // v29: time signatures are preserved as-is. The Bob Mover Lexicon
      // doesn't emit <time> elements (it's "free-rhythm"), but if a
      // future source has one, it passes through unchanged. We never
      // synthesise, rewrite, or normalise time signatures here -- that
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
    // end) -- but easier: keep the prefix up to and including <part-list>,
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

    // Inject a key signature on the first measure so the etude shows
    // the new key instead of "C major with every note accidental'd".
    // We use the first part's semitones as the canonical transposition
    // for the whole etude. When the etude mixes transpositions, segments
    // at a different transposition will still be in the right pitch but
    // the user will see the first segment's key sig applied across the
    // whole etude -- slightly imperfect but a much smaller "strange
    // accidentals" problem than the previous no-key-sig behavior.
    const firstSemitones = (parts[0] && parts[0].semitones) || 0;
    const stitchedPart =
      '<part id="P1">' +
        injectKeySignature(allMeasures.join(''), getKeyFifths(firstSemitones)) +
      '</part>';

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
      // MIDI value, or too narrow for the step), leave the note alone --
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
  //     The 3/4 waltz is encoded as 4/4 with a quarter rest on beat 4 --
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
  // 4 here -- a quarter = 4 divisions, so a half = 8, a whole = 16).
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
  // curriculum. Asserts the bar sums to exactly 4 beats -- a data
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
  //
  // v36: accepts an optional `maxBars` (default Infinity) so the
  // preview pane can show the first N bars of a longer etude
  // (the user wants to see ~8 bars of context before committing
  // to save+practice). When maxBars is set and is less than the
  // total bars, we emit only that many measures. Same chord / pitch
  // handling, same assertions -- the only difference is the slice
  // length at the end.
  function buildMasterClassEtude(etude, line, maxBars) {
    if (!etude || !line) throw new Error('buildMasterClassEtude: etude and line required');

    // Flatten chords → bars into a single ordered list of bar objects.
    // Each chord's `bars` is an array; we keep the chord name as a
    // comment in the measure so anyone reading the raw XML can see the
    // harmonic context. (Verovio ignores comments; this is purely for
    // human debugging.)
    const allBars = [];
    for (let i = 0; i < line.chords.length; i++) {
      const ch = line.chords[i];
      for (let j = 0; j < ch.bars.length; j++) {
        allBars.push({ notes: ch.bars[j].notes, chord: ch.name });
      }
    }
    if (!allBars.length) throw new Error('buildMasterClassEtude: no bars in line');

    // v36: truncate to maxBars if specified. The bar-beat assertion
    // in buildBarXml still runs on every emitted bar, so a data error
    // in the curriculum fails loud whether we're previewing or
    // saving.
    const barLimit = (typeof maxBars === 'number' && maxBars > 0)
      ? Math.min(maxBars, allBars.length)
      : allBars.length;
    const flatBars = allBars.slice(0, barLimit);
    if (!flatBars.length) throw new Error('buildMasterClassEtude: no bars after truncation');

    const divisions = 4;  // 1 quarter = 4 divisions (industry default)
    const bpm = etude.bpm || 80;
    const safeTitle = (etude.title + ' -- ' + line.name)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // First measure: include <attributes> with divisions, key (C major /
    // no accidentals), time (4/4 -- we always use 4/4 even for the
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
          '<encoding><software>Bob Mover Lexicon -- Master Class builder</software></encoding>' +
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

  // Build a short preview MusicXML of a Master Class etude line,
  // truncated to the first `maxBars` measures. Used by the
  // preview pane in the etudes page so the user can see the
  // notation + range check before committing to save + navigate
  // to /practice/. Same XML structure as the full version, just
  // a smaller slice.
  function buildEtudePreviewXML(etude, line, maxBars) {
    const limit = (typeof maxBars === 'number' && maxBars > 0) ? maxBars : 8;
    return buildMasterClassEtude(etude, line, limit);
  }

  // v38: canonical range for the Master Class curriculum. The
  // user wants every generated etude to land within E3 (MIDI 52)
  // and C6 (MIDI 84). This is broader than the typical instrument
  // range (alto default is Ab2..E5) and acts as a curriculum
  // data-integrity check: if any note falls outside this band,
  // the etude is either too extreme to be a sensible practice
  // exercise, or there's a transcription error in the curriculum
  // data. Surfaced in the preview pane as a second "E3–C6" badge
  // and (when violated) a warning panel. The save still proceeds
  // -- the warning is informational, not blocking, so the user can
  // still study extreme registers on purpose.
  //
  // To widen or narrow this band later, edit the two MIDI values
  // here. The validateEtudeNotes() function and the preview's
  // range check both pull from this object.
  const MC_CANONICAL_RANGE = { lowMidi: 52, highMidi: 84 };  // E3..C6

  // Walk a MusicXML string and replace every <pitch>...</pitch>
  // block with its simplest enharmonic spelling. Mirrors music21's
  // Pitch.simplifyEnharmonic: E#→F, B#→C, Fb→E, Cb→B, and so on.
  // Useful for the "Fix Enharmonics" button in the etudes preview
  // pane: when an etude has been transposed (or hand-edited) and
  // ends up with awkward enharmonics like E# or Fb, one click
  // rewrites every pitch to the canonical sharp-or-natural form.
  //
  // Algorithm:
  //   1. For each <note>...</note> block with a <pitch>, extract
  //      step (may be 'C' or 'C#' or 'Db'), alter, octave.
  //   2. Roll any '#' / 'b' suffix on the step into the alter
  //      (so 'C#' + alter=0 == 'C' + alter=1).
  //   3. Compute MIDI from the normalised (step, alter, octave).
  //   4. Map the MIDI's pitch class to the canonical spelling:
  //      white keys (C, D, E, F, G, A, B) keep their natural name;
  //      black keys take the sharp form (C#, D#, F#, G#, A#).
  //      This means E#→F (MIDI 5), B#→C-octave+1 (MIDI 12 wraps),
  //      Fb→E (MIDI 4), Cb→B-octave-1, etc.
  //   5. Recompute the octave for the new spelling -- necessary
  //      because C and B straddle an octave boundary (B#4 becomes
  //      C5, Cb4 becomes B3).
  //
  // Returns a new MusicXML string with the simplified pitches. If
  // the input is invalid or empty, returns it unchanged.
  function simplifyEnharmonicXml(xml) {
    if (!xml || typeof xml !== 'string') return xml;
    // Match every <note>...</note> block that has a <pitch>.
    // We don't need to worry about rests or chord tones -- they
    // don't have <pitch> and so don't match.
    const noteRe = /<note>\s*<pitch>[\s\S]*?<\/pitch>[\s\S]*?<\/note>/g;
    return xml.replace(noteRe, function (noteBlock) {
      const stepM = /<step>\s*([A-Ga-g][#b]?)\s*<\/step>/.exec(noteBlock);
      const altM  = /<alter>\s*(-?\d+)\s*<\/alter>/.exec(noteBlock);
      const octM  = /<octave>\s*(-?\d+)\s*<\/octave>/.exec(noteBlock);
      if (!stepM || !octM) return noteBlock;
      // Normalise the step: roll any '#' / 'b' suffix into the alter.
      let cleanStep = stepM[1].charAt(0).toUpperCase();
      let accidental = 0;
      if (stepM[1].length === 2) {
        const suffix = stepM[1].charAt(1);
        if (suffix === '#') accidental = 1;
        else if (suffix === 'b') accidental = -1;
      }
      const totalAlter = (altM ? parseInt(altM[1], 10) : 0) + accidental;
      const octave = parseInt(octM[1], 10);
      // Compute MIDI.
      const baseOffset = STEP_TO_OFFSET[cleanStep];
      if (baseOffset === undefined) return noteBlock;
      const midi = (octave + 1) * 12 + baseOffset + totalAlter;
      // Canonical spelling table: pitch class → simplest step+alter.
      // White keys take their natural name; black keys take the
      // sharp form (no Db/Gb/Ab -- those are valid but not "simplest"
      // in the music21 sense).
      const pc = ((midi % 12) + 12) % 12;
      const CANONICAL = [
        { step: 'C', alter: 0 },  // 0
        { step: 'C', alter: 1 },  // 1  C# (was Cb or B# → C)
        { step: 'D', alter: 0 },  // 2
        { step: 'D', alter: 1 },  // 3  D# (was Eb)
        { step: 'E', alter: 0 },  // 4
        { step: 'F', alter: 0 },  // 5  (was Fb or E#)
        { step: 'F', alter: 1 },  // 6  F# (was Gb)
        { step: 'G', alter: 0 },  // 7
        { step: 'G', alter: 1 },  // 8  G# (was Ab)
        { step: 'A', alter: 0 },  // 9
        { step: 'A', alter: 1 },  // 10 A# (was Bb)
        { step: 'B', alter: 0 },  // 11 (was Cb or B# → B/C -- handled by octave bump)
      ];
      const canonical = CANONICAL[pc];
      // Recompute the octave for the new spelling. C and B straddle
      // an octave boundary, so B#4 (MIDI 72) becomes C5 (octave+1)
      // and Cb4 (MIDI 59) becomes B3 (octave-1). For all other
      // pitch classes the octave stays the same.
      const newOctave = Math.floor(midi / 12) - 1;
      // If the result is the same as the input, no rewrite needed.
      // This is a quick no-op check that avoids touching the XML
      // when the spelling is already canonical.
      if (cleanStep === canonical.step &&
          (altM ? parseInt(altM[1], 10) : 0) === canonical.alter &&
          parseInt(octM[1], 10) === newOctave) {
        return noteBlock;
      }
      const newPitch =
        '<pitch>' +
          '<step>' + canonical.step + '</step>' +
          (canonical.alter === 0 ? '' : '<alter>' + canonical.alter + '</alter>') +
          '<octave>' + newOctave + '</octave>' +
        '</pitch>';
      return noteBlock.replace(/<pitch>[\s\S]*?<\/pitch>/, newPitch);
    });
  }

  // Count <note> elements in a Master-Class-generated MusicXML string.
  // Mirrors countNotes() above but only counts non-rest notes -- useful
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

  // Validate a generated etude's notes against the user's saved
  // instrument range and a maximum-interval "smooth voice leading"
  // check (no jump larger than a major 7th = 11 semitones). Returns
  // a structured report so the caller can surface warnings in the UI:
  //
  //   {
  //     pitchedNotes: [{ midi, beat, duration, measureIndex, noteIndex }, ...],
  //     outOfRange:   [{ midi, measureIndex, noteIndex, pitch, low, high }, ...],
  //     bigJumps:     [{ from, to, semitones, fromIndex, toIndex }, ...],
  //     ok:           boolean   // true if no violations found
  //   }
  //
  // Parses the MusicXML with DOMParser (the same parser the practice
  // page uses for parseMusicXML). Each <note> block contributes one
  // entry to pitchedNotes if it has a <pitch> (skips rests + chord
  // tones, matching the practice page's monophony). Range check
  // uses the user-provided lowMidi/highMidi. Interval check measures
  // the absolute semitone distance between consecutive pitched
  // notes -- anything > 11 is reported.
  //
  // Why both checks: the user wants to confirm their generated etudes
  // (a) are playable on their instrument (range) and (b) don't have
  // vocal-leap problems (big jumps). The practice page already
  // renders and plays whatever is in the MusicXML, so a stray
  // out-of-range note would either fail to render or play in the
  // wrong octave via the engine's hardcoded range clamp. Catching
  // these at generation time is much friendlier than debugging
  // weird playback later.
  function validateEtudeNotes(xml, lowMidi, highMidi) {
    const out = {
      pitchedNotes: [],
      outOfRange: [],
      bigJumps: [],
      ok: true,
    };
    if (!xml || typeof xml !== 'string') {
      out.ok = false;
      return out;
    }
    let doc;
    try {
      doc = new DOMParser().parseFromString(xml, 'application/xml');
    } catch (e) {
      out.ok = false;
      return out;
    }
    const measures = doc.querySelectorAll('measure');
    let absoluteBeat = 0;
    measures.forEach(function (measure, measureIndex) {
      const noteElems = measure.querySelectorAll('note');
      let posInMeasure = 0;
      // Mirror the practice page's note-walking: extract pitched
      // notes in order, skip rests and chord tones, advance
      // posInMeasure by the note's duration. We don't recompute the
      // duration from <type> here because the purpose is just to
      // enumerate notes for the range + jump checks; timing
      // fidelity is the practice page's job.
      noteElems.forEach(function (note) {
        if (note.querySelector('rest')) {
          const dur = note.querySelector('duration');
          if (dur) {
            posInMeasure += parseFloat(dur.textContent) / 4;  // divisions=4
          }
          return;
        }
        if (note.querySelector('chord')) {
          // Skip chord tones (monophonic -- practice page does the same)
          return;
        }
        const stepEl   = note.querySelector('pitch > step');
        const octaveEl = note.querySelector('pitch > octave');
        const alterEl  = note.querySelector('pitch > alter');
        if (!stepEl || !octaveEl) return;
        const step   = stepEl.textContent.trim();
        const octave = parseInt(octaveEl.textContent, 10);
        const alter  = alterEl ? parseInt(alterEl.textContent, 10) : 0;
        const midi   = pitchToMidi(step, alter, octave);
        // Mirror practice.js: pitched notes are in the order they
        // appear; chord tones are skipped; rests advance posInMeasure
        // but don't emit a note. duration here is the basic <duration>/4
        // approximation -- accurate enough for the validation, which
        // doesn't need sub-beat precision.
        const dur = note.querySelector('duration');
        const durBeats = dur ? parseFloat(dur.textContent) / 4 : 1;
        out.pitchedNotes.push({
          midi: midi,
          beat: absoluteBeat + posInMeasure,
          duration: durBeats,
          measureIndex: measureIndex,
          noteIndex: noteElems.length === 0 ? 0 : Array.prototype.indexOf.call(noteElems, note),
          pitch: { step: step, alter: alter, octave: octave },
        });
        posInMeasure += durBeats;
      });
      // The practice page hardcodes 4 beats/measure (see the
      // "currentTime += 4" line in practice.js). Mirror that for
      // accurate beat positions in the validation report.
      absoluteBeat += 4;
    });

    // Range check: each note must be in [lowMidi, highMidi]
    if (typeof lowMidi === 'number' && typeof highMidi === 'number') {
      for (let i = 0; i < out.pitchedNotes.length; i++) {
        const p = out.pitchedNotes[i];
        if (p.midi < lowMidi || p.midi > highMidi) {
          out.outOfRange.push({
            midi: p.midi,
            measureIndex: p.measureIndex,
            noteIndex: p.noteIndex,
            pitch: p.pitch,
            low: lowMidi,
            high: highMidi,
          });
        }
      }
    }

    // Interval check: absolute semitone distance between consecutive
    // pitched notes. A 7th is 10 semitones (minor 7th) or 11
    // semitones (major 7th). Anything > 11 is "wider than a 7th"
    // and would force a register break on most instruments. We use
    // 11 as the strict ceiling per the user's "no jump bigger than
    // 7th" instruction.
    const MAX_JUMP_SEMITONES = 11;
    for (let i = 1; i < out.pitchedNotes.length; i++) {
      const a = out.pitchedNotes[i - 1];
      const b = out.pitchedNotes[i];
      const delta = Math.abs(b.midi - a.midi);
      if (delta > MAX_JUMP_SEMITONES) {
        out.bigJumps.push({
          from: a.midi,
          to:   b.midi,
          semitones: delta,
          fromIndex: i - 1,
          toIndex:   i,
          fromPitch: a.pitch,
          toPitch:   b.pitch,
        });
      }
    }

    out.ok = out.outOfRange.length === 0 && out.bigJumps.length === 0;
    return out;
  }

  window.etudesStitch = {
    stitch: stitch,
    transposePitch: transposePitch,
    respellInKey: respellInKey,
    getKeyFifths: getKeyFifths,
    getKeyLetterAlters: getKeyLetterAlters,
    injectKeySignature: injectKeySignature,
    countNotes: countNotes,
    countMeasures: countMeasures,
    clampToRange: clampToRange,
    buildMasterClassEtude: buildMasterClassEtude,
    buildEtudePreviewXML: buildEtudePreviewXML,
    simplifyEnharmonicXml: simplifyEnharmonicXml,
    countPitchedNotes: countPitchedNotes,
    validateEtudeNotes: validateEtudeNotes,
    MC_CANONICAL_RANGE: MC_CANONICAL_RANGE,
  };
})();
