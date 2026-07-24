/* Master Class curriculum — 6 pre-built pedagogical etudes distilled from
 * Bob Mover's Master Class series (referenced by MC # in the original
 * material). Each etude is a focused concept, with multiple clickable
 * "lines" (variations on the same idea) the user can generate, save
 * to IndexedDB, and practice.
 *
 * Data shape (per etude):
 *   id        : stable slug used in the etude id ('etude_mc-1-line-1')
 *   title     : short display name (shown on the Master Class tab)
 *   subtitle  : longer subtitle, shown under the title
 *   mc        : source Master Class numbers from the Bob Mover series
 *   concept   : one-paragraph explanation of what the etude trains
 *   bpm       : default playback tempo (the practice page lets the user
 *               change this at runtime, so this is just a starting point)
 *   timeSig   : '4/4' for everything except Etude 4 step 10 (3/4 waltz).
 *               We never emit a 3/4 time signature in the MusicXML
 *               (the practice page's parseMusicXML hard-codes 4 beats
 *               per measure; instead we encode the 3/4 waltz as 4/4 with
 *               a quarter rest at beat 4 of every bar to preserve the
 *               timing). Marked '4/4-waltz' on line.metadata to flag it.
 *   lines     : array of "line" objects:
 *     name        : short label (e.g. 'Line 1: 9 → ♯9 → Maj7')
 *     description : one-line subtitle shown under the line button
 *     chords      : array of { name, bars }, where each bar is a list
 *                   of { p, d } notes:
 *                     p = pitch string 'C4', 'Bb3', 'F#5', etc.
 *                         Set p to null to encode a rest (a true
 *                         <rest/> in the MusicXML — used by the 3/4
 *                         waltz to fill beat 4 with silence).
 *                     d = duration in beats (1 = quarter, 2 = half,
 *                         4 = whole, 0.5 = eighth, 0.25 = 16th)
 *                   Total beats per bar MUST equal 4. The builder
 *                   asserts this at runtime — if it ever fails, that's
 *                   a data error here, not a renderer bug.
 *
 * The MusicXML for each generated line is built fresh in the browser
 * by `window.etudesStitch.buildMasterClassEtude(line, etude)` — no
 * server roundtrip, no /api/musicxml fetch. Saves to IDB with
 * `source: 'master-class'` and navigates to /practice/?id=etude_xxx.
 *
 * Ranges: the pitches here are written for the alto-sax default
 * (Bb3..F#6, MIDI 58..78). Alto, tenor, and soprano all fit. The
 * practice page's renderScore flow doesn't re-clamp etudes, so the
 * pitch ranges here are the source of truth — keep them within the
 * common-sax sweet spot (Bb3..A5) to stay safe across instruments.
 *
 * Time-signature note: the user's instruction "should be no changing
 * time signatures" applies to stitched etudes (etudes-stitch.js
 * never synthesises or rewrites <time> elements). The Master Class
 * builder here DOES set <time> on the first measure of each line,
 * because the lines are standalone, not stitched from sources. For
 * the 3/4 waltz we emit 4/4 + a quarter rest (see above); this
 * satisfies the spirit of the rule (no mid-line time change) and
 * also makes the practice page's hardcoded "4 beats per measure"
 * parser happy.
 */
(function () {
  'use strict';

  // ---------- Etude 1: Voice Leading & Target Notes ----------
  // II-V-I voice leading in C. Each line isolates ONE essential
  // voice-leading movement: 9→♯9→Maj7, 7→♭9→5, 7→♯11→9, 13→♭13→5.
  // Plus a chromatic enclosure variation.
  //
  // Pitches and rhythm sourced from the music21 reference script
  // (see the user's note in the etudes-curriculum source for the
  // exact Python). Pitches land in the low-to-mid register (B3, G3,
  // A3 as the resolutions) so the line is singable for vocal practice
  // and sits in the chalumeau register of the alto sax. The ii and V
  // tones are 2 tied eighths followed by a 3-beat rest (dotted half
  // rest in the score), and the I resolution is held as a whole note —
  // the "two tied eighth-notes leading to a long tone" pattern from
  // the original instructions. Same shape: 3 bars, one per chord, 4/4.
  const MC1 = {
    id: 'mc-1-voice-leading',
    title: 'Voice Leading & Target Notes',
    subtitle: 'II–V–I voice leading in C — five movements + chromatic enclosure',
    mc: '4, 20, 22, 23, 36–39',
    concept: 'Isolate the four essential voice-leading movements through a ii–V–I. The goal is a smooth, swinging melody where every note is felt as a color against the chord below. Each line holds its target note as a long tone — sing it before you play it.',
    bpm: 80,
    timeSig: '4/4',
    lines: [
      {
        name: 'Line 1: 9 → ♯9 → Maj7',
        description: 'E (9) → F (♯9) → B3 (Maj7). The colour-tone line.',
        chords: [
          // Dm7: 2 tied eighths of E + dotted-half rest (3 beats)
          { name: 'Dm7',   bars: [{ notes: [
            { p: 'E4', d: 0.5 }, { p: 'E4', d: 0.5 }, { p: null, d: 3 }
          ]}]},
          // G7: 2 tied eighths of F + dotted-half rest
          { name: 'G7',    bars: [{ notes: [
            { p: 'F4', d: 0.5 }, { p: 'F4', d: 0.5 }, { p: null, d: 3 }
          ]}]},
          // Cmaj7: whole note B3 (the resolution, in the lower octave)
          { name: 'Cmaj7', bars: [{ notes: [
            { p: 'B3', d: 4 }
          ]}]},
        ],
      },
      {
        name: 'Line 2: 7 → ♭9 → 5',
        description: 'C (7) → D♭ (♭9) → G3 (5). The dominant-pull line.',
        chords: [
          { name: 'Dm7',   bars: [{ notes: [
            { p: 'C4', d: 0.5 }, { p: 'C4', d: 0.5 }, { p: null, d: 3 }
          ]}]},
          { name: 'G7',    bars: [{ notes: [
            { p: 'Db4', d: 0.5 }, { p: 'Db4', d: 0.5 }, { p: null, d: 3 }
          ]}]},
          { name: 'Cmaj7', bars: [{ notes: [
            { p: 'G3', d: 4 }
          ]}]},
        ],
      },
      {
        name: 'Line 3: 7 → ♯11 → 9',
        description: 'C (7) → C♯ (♯11) → D4 (9). The Lydian-shift line.',
        chords: [
          { name: 'Dm7',   bars: [{ notes: [
            { p: 'C4', d: 0.5 }, { p: 'C4', d: 0.5 }, { p: null, d: 3 }
          ]}]},
          { name: 'G7',    bars: [{ notes: [
            { p: 'C#4', d: 0.5 }, { p: 'C#4', d: 0.5 }, { p: null, d: 3 }
          ]}]},
          { name: 'Cmaj7', bars: [{ notes: [
            { p: 'D4', d: 4 }
          ]}]},
        ],
      },
      {
        name: 'Line 4: 13 → ♭13 → 5',
        description: 'A3 (13) → A♭3 (♭13) → G3 (5). The bop-register line.',
        chords: [
          { name: 'Dm7',   bars: [{ notes: [
            { p: 'A3', d: 0.5 }, { p: 'A3', d: 0.5 }, { p: null, d: 3 }
          ]}]},
          { name: 'G7',    bars: [{ notes: [
            { p: 'Ab3', d: 0.5 }, { p: 'Ab3', d: 0.5 }, { p: null, d: 3 }
          ]}]},
          { name: 'Cmaj7', bars: [{ notes: [
            { p: 'G3', d: 4 }
          ]}]},
        ],
      },
      {
        name: 'Variation: Chromatic Enclosure (MC 22)',
        description: 'E → F → [C → B♭] → B3. Enclose the target from a half-step above and below.',
        chords: [
          // Dm7: quarter E + 3-beat rest (simpler rhythm than the
          // tied-eighths pattern in the main lines; the enclosure
          // happens on the V chord, not the ii).
          { name: 'Dm7',   bars: [{ notes: [
            { p: 'E4', d: 1 }, { p: null, d: 3 }
          ]}]},
          // G7: quarter F + quarter C + quarter B♭ + quarter rest
          // (= 4 beats; the C and B♭ enclose the target B from
          // a half-step above and below).
          { name: 'G7',    bars: [{ notes: [
            { p: 'F4', d: 1 }, { p: 'C4', d: 1 }, { p: 'Bb3', d: 1 }, { p: null, d: 1 }
          ]}]},
          // Cmaj7: half note B3 (the resolution, held).
          { name: 'Cmaj7', bars: [{ notes: [
            { p: 'B3', d: 2 }, { p: null, d: 2 }
          ]}]},
        ],
      },
    ],
  };

  // ---------- Etude 2: Chromatic Passageway (Rhythm Changes Bridge) ----------
  // 8 bars across the bridge (4 dominant chords moving in 4ths):
  // D7 | D7 | G7 | G7 | C7 | C7 | F7 | F7
  // A relentless descending chromatic line through the 3rds of each
  // chord, accenting the 3 of each new chord. The line F#-F-E-Eb-D-Db-C-B
  // walks the tritone substitute descent across the first half, then
  // Bb-A-Ab-G-Gb-F-E-Eb continues the descent through the resolution.
  // Bars 1-7 are quarter-note walk; bar 8 holds the 3 of F7 (A) for the
  // resolution.
  const MC2 = {
    id: 'mc-2-chromatic-passageway',
    title: 'Chromatic Passageway',
    subtitle: 'Rhythm Changes bridge — descending chromatic walk through the 3rds',
    mc: '2, 9, 35',
    concept: 'The bridge of "I Got Rhythm" is a sequence of dominant chords moving in fourths. Connect the essential 3rd of each chord with a relentless descending chromatic line — a classic bebop passageway. Accent the first note of each new chord; feel the swing eighths even when the score shows quarters.',
    bpm: 100,
    timeSig: '4/4',
    lines: [
      {
        name: 'Descending: 3 to ♭7/3 across the bridge',
        description: 'F♯ walking down to A (3 of F7). 28 quarters + a whole-note resolution.',
        chords: [
          { name: 'D7', bars: [{ notes: [
            { p: 'F#4', d: 1 }, { p: 'F4', d: 1 }, { p: 'E4', d: 1 }, { p: 'Eb4', d: 1 }
          ]}]},
          { name: 'D7', bars: [{ notes: [
            { p: 'D4', d: 1 }, { p: 'Db4', d: 1 }, { p: 'C4', d: 1 }, { p: 'B3', d: 1 }
          ]}]},
          { name: 'G7', bars: [{ notes: [
            { p: 'Bb3', d: 1 }, { p: 'A3', d: 1 }, { p: 'Ab3', d: 1 }, { p: 'G3', d: 1 }
          ]}]},
          { name: 'G7', bars: [{ notes: [
            { p: 'Gb3', d: 1 }, { p: 'F3', d: 1 }, { p: 'E3', d: 1 }, { p: 'Eb3', d: 1 }
          ]}]},
          { name: 'C7', bars: [{ notes: [
            { p: 'D4', d: 1 }, { p: 'Db4', d: 1 }, { p: 'C4', d: 1 }, { p: 'B3', d: 1 }
          ]}]},
          { name: 'C7', bars: [{ notes: [
            { p: 'Bb3', d: 1 }, { p: 'A3', d: 1 }, { p: 'Ab3', d: 1 }, { p: 'G3', d: 1 }
          ]}]},
          { name: 'F7', bars: [{ notes: [
            { p: 'Gb3', d: 1 }, { p: 'F3', d: 1 }, { p: 'E3', d: 1 }, { p: 'Eb3', d: 1 }
          ]}]},
          { name: 'F7', bars: [{ notes: [
            { p: 'A3', d: 4 }
          ]}]},
        ],
      },
    ],
  };

  // ---------- Etude 3: Harmonic Shift (Dorian → Diminished) on Solar ----------
  // ii–V in C minor via the tritone sub: Dm7♭5 → A♭7 → Cm. The line
  // moves from D Locrian to an A♭ diminished arpeggio (Ab–B–D–F using
  // the enharmonic B for C♭) to Cm, hitting the 5 (G), the ♭3 (E♭),
  // and the root (C) of the resolution.
  const MC3 = {
    id: 'mc-3-dorian-diminished',
    title: 'Harmonic Shift: Dorian → Diminished',
    subtitle: 'Solar ii–V–i with a Locrian-to-diminished shift on the tritone sub',
    mc: '7, 8, 11, 32',
    concept: 'Move from a dark minor sound (D Locrian) to a bright, tense sound (A♭ diminished) on the tritone sub of G7, then resolve to C minor. The A♭ diminished arpeggio outlines A♭7 — the same notes sound "tense" over the altered dominant and "settled" over the tonic.',
    bpm: 90,
    timeSig: '4/4',
    lines: [
      {
        name: 'Arpeggios: D Locrian → A♭° → Cm',
        description: 'D–F–A♭–C → A♭–B–D–F → G–E♭–C. One bar per chord.',
        chords: [
          { name: 'Dm7♭5', bars: [{ notes: [
            { p: 'D4', d: 1 }, { p: 'F4', d: 1 }, { p: 'Ab4', d: 1 }, { p: 'C5', d: 1 }
          ]}]},
          { name: 'A♭7', bars: [{ notes: [
            { p: 'Ab4', d: 1 }, { p: 'B4', d: 1 }, { p: 'D5', d: 1 }, { p: 'F5', d: 1 }
          ]}]},
          { name: 'Cm(maj7)', bars: [{ notes: [
            { p: 'G4', d: 2 }, { p: 'Eb4', d: 1 }, { p: 'C4', d: 1 }
          ]}]},
        ],
      },
    ],
  };

  // ---------- Etude 4: Melodic Paraphrase on "There Will Never Be Another You" ----------
  // Eb major. Original 2-bar phrase + 4 paraphrase variations. The
  // waltz version (step 10) is encoded as 4/4 with a quarter rest on
  // beat 4 of every bar — the practice page's parser hardcodes 4
  // beats per measure, so a true 3/4 time signature would mis-time
  // the notes. The rest at beat 4 preserves the waltz feel.
  const MC4 = {
    id: 'mc-4-paraphrase',
    title: 'Melodic Paraphrase on "There Will Never Be Another You"',
    subtitle: 'E♭ major — 4 paraphrase steps on the opening phrase + a 3/4 waltz',
    mc: '24–27, 31–33',
    concept: 'A paraphrase is an improvisation that lives in the space between the melody and a brand-new line. The same two bars, restated five different ways: as written, syncopated, with a chromatic passing tone, with rhythm alteration + enclosure, and stretched into a 3/4 waltz.',
    bpm: 80,
    timeSig: '4/4',
    lines: [
      {
        name: 'Step 1: Straight Melody',
        description: 'Play it as written, with a beautiful sound.',
        chords: [
          { name: 'E♭maj7', bars: [{ notes: [
            { p: 'Eb4', d: 1 }, { p: 'F4', d: 1 }, { p: 'G4', d: 1 }, { p: 'Bb4', d: 1 }
          ]}]},
          { name: 'E♭maj7', bars: [{ notes: [
            { p: 'Ab4', d: 1 }, { p: 'G4', d: 1 }, { p: 'F4', d: 1 }, { p: 'Eb4', d: 1 }
          ]}]},
        ],
      },
      {
        name: 'Step 2: Syncopated',
        description: 'Anticipate the second bar — rest then leap in on the off-beat.',
        chords: [
          { name: 'E♭maj7', bars: [{ notes: [
            { p: 'Eb4', d: 1 }, { p: 'F4', d: 1 }, { p: 'G4', d: 1 }, { p: 'Bb4', d: 1 }
          ]}]},
          { name: 'E♭maj7', bars: [{ notes: [
            { p: 'Eb4', d: 0.5 }, { p: 'Ab4', d: 0.5 }, { p: 'G4', d: 1 },
            { p: 'F4', d: 0.5 }, { p: 'Eb4', d: 0.5 }, { p: null, d: 1 }
          ]}]},
        ],
      },
      {
        name: 'Step 4: Single Passing Tone',
        description: 'Insert a chromatic connector between G and B♭ (A♭).',
        chords: [
          { name: 'E♭maj7', bars: [{ notes: [
            { p: 'Eb4', d: 1 }, { p: 'F4', d: 1 },
            { p: 'G4', d: 0.5 }, { p: 'Ab4', d: 0.5 },
            { p: 'Bb4', d: 1 }
          ]}]},
          { name: 'E♭maj7', bars: [{ notes: [
            { p: 'Ab4', d: 1 }, { p: 'G4', d: 1 }, { p: 'F4', d: 1 }, { p: 'Eb4', d: 1 }
          ]}]},
        ],
      },
      {
        name: 'Step 6: Rhythm Alteration + Enclosure',
        description: 'Long Eb + F, then quick runs and a D→E♭ enclosure of the resolution.',
        chords: [
          { name: 'E♭maj7', bars: [{ notes: [
            { p: 'Eb4', d: 2 }, { p: 'F4', d: 2 }
          ]}]},
          { name: 'E♭maj7', bars: [{ notes: [
            { p: 'G4', d: 0.5 }, { p: 'Bb4', d: 0.5 }, { p: 'Ab4', d: 0.5 }, { p: 'G4', d: 0.5 },
            { p: 'F4', d: 1 }, { p: 'Eb4', d: 1 }
          ]}]},
          { name: 'E♭maj7', bars: [{ notes: [
            { p: 'D4', d: 2 }, { p: 'Eb4', d: 2 }
          ]}]},
        ],
      },
      {
        name: 'Step 10: 3/4 Waltz',
        description: 'Stretch the pitches into a 3/4 waltz (encoded as 4/4 with a quarter rest on beat 4).',
        chords: [
          { name: 'E♭maj7', bars: [{ notes: [
            { p: 'Eb4', d: 1 }, { p: 'F4', d: 1 }, { p: 'G4', d: 1 },
            { p: null, d: 1 }
          ]}]},
          { name: 'E♭maj7', bars: [{ notes: [
            { p: 'Bb4', d: 1 }, { p: 'Ab4', d: 1 }, { p: 'G4', d: 1 },
            { p: null, d: 1 }
          ]}]},
          { name: 'E♭maj7', bars: [{ notes: [
            { p: 'F4', d: 2 }, { p: 'Eb4', d: 2 }
          ]}]},
        ],
        waltz: true,
      },
    ],
  };

  // ---------- Etude 5: The Pocket Groove (F Blues) ----------
  // 12-bar F blues with a simple singing melody. The pedagogical
  // content is the *feel* — the same 12 bars practiced with two
  // different internal pulses (deep half-time vs regular 2 & 4). The
  // melody is the substrate; the pocket is the lesson.
  const MC5 = {
    id: 'mc-5-pocket-groove',
    title: 'The Pocket Groove',
    subtitle: 'F blues — deep pocket vs regular pocket, same melody, two feels',
    mc: '5, 10, 11, 34',
    concept: 'Train your body to feel two different time levels simultaneously. The same 12-bar blues melody is played twice — once with a half-time pulse (♩ = 50, felt on 1 and 3 of a slow bar), once with the regular backbeat (♩ = 100, felt on 2 and 4). The tempo is the same; only your perception of the primary pulse has shifted.',
    bpm: 100,
    timeSig: '4/4',
    lines: [
      {
        name: 'F Blues Head (simple melody)',
        description: '12-bar F blues with a singable melody. Practice at ♩ = 100.',
        chords: [
          { name: 'F7', bars: [{ notes: [
            { p: 'F4', d: 1 }, { p: 'F4', d: 1 }, { p: 'A4', d: 1 }, { p: 'C5', d: 1 }
          ]}]},
          { name: 'B♭7', bars: [{ notes: [
            { p: 'A4', d: 1 }, { p: 'F4', d: 1 }, { p: 'F4', d: 1 }, { p: 'F4', d: 1 }
          ]}]},
          { name: 'F7', bars: [{ notes: [
            { p: 'Bb4', d: 1 }, { p: 'Bb4', d: 1 }, { p: 'D5', d: 1 }, { p: 'F5', d: 1 }
          ]}]},
          { name: 'Cm7 F7', bars: [{ notes: [
            { p: 'D5', d: 1 }, { p: 'Bb4', d: 1 }, { p: 'F4', d: 1 }, { p: 'F4', d: 1 }
          ]}]},
          { name: 'B♭7', bars: [{ notes: [
            { p: 'A4', d: 1 }, { p: 'F4', d: 1 }, { p: 'F4', d: 1 }, { p: 'F4', d: 1 }
          ]}]},
          { name: 'B♭7', bars: [{ notes: [
            { p: 'Bb4', d: 1 }, { p: 'Bb4', d: 1 }, { p: 'D5', d: 1 }, { p: 'F5', d: 1 }
          ]}]},
          { name: 'F7', bars: [{ notes: [
            { p: 'F4', d: 1 }, { p: 'F4', d: 1 }, { p: 'A4', d: 1 }, { p: 'C5', d: 1 }
          ]}]},
          { name: 'D7', bars: [{ notes: [
            { p: 'Eb5', d: 1 }, { p: 'D5', d: 1 }, { p: 'C5', d: 1 }, { p: 'A4', d: 1 }
          ]}]},
          { name: 'G7', bars: [{ notes: [
            { p: 'G4', d: 1 }, { p: 'G4', d: 1 }, { p: 'Bb4', d: 1 }, { p: 'D5', d: 1 }
          ]}]},
          { name: 'C7', bars: [{ notes: [
            { p: 'C5', d: 1 }, { p: 'C5', d: 1 }, { p: 'Eb5', d: 1 }, { p: 'G5', d: 1 }
          ]}]},
          { name: 'F7', bars: [{ notes: [
            { p: 'F4', d: 1 }, { p: 'F4', d: 1 }, { p: 'A4', d: 1 }, { p: 'C5', d: 1 }
          ]}]},
          { name: 'C7', bars: [{ notes: [
            { p: 'F5', d: 1 }, { p: 'E5', d: 1 }, { p: 'D5', d: 1 }, { p: 'C5', d: 1 }
          ]}]},
        ],
      },
    ],
  };

  // ---------- Etude 6: Bebop Line in All Keys Through Symmetrical Intervals ----------
  // The original line: Dm7: C E G Bb | G7: Ab G F E | Cmaj7: D C.
  // Refracted through the tonal system by constant interval: up a
  // minor 3rd (Fm7-Bb7-Ebmaj7), up a major 3rd (F#m7-B7-Emaj7), and
  // up a tritone (Abm7-Db7-Gbmaj7). Same melodic shape, four keys.
  //
  // The "line shape" is 4 quarters on the ii, 4 quarters on the V,
  // then half-half on the I. For tritone-up we use enharmonic
  // respellings (B for Cb, A for Bbb, E for Fb) so the score reads
  // cleanly.
  const MC6 = {
    id: 'mc-6-bebop-symmetrical',
    title: 'Bebop Line in All Keys Through Symmetrical Intervals',
    subtitle: 'A Parker-inspired line refracted through C, E♭, E, and G♭',
    mc: '28, 35',
    concept: 'The goal is not just to learn one line, but to refract it through the entire tonal system using symmetrical movement. The same intervallic shape — ♭7-9-11-♭13 on the ii, ♭9-1-7-3 on the V, 9-1 on the I — applied to four keys a constant interval apart. Train your logical ear: sing the line in the new key using functional numbers before you play it.',
    bpm: 90,
    timeSig: '4/4',
    lines: [
      {
        name: 'Line 1: C major (ii–V–I in C)',
        description: 'The original. Dm7: C E G B♭ | G7: A♭ G F E | Cmaj7: D C.',
        chords: [
          { name: 'Dm7',   bars: [{ notes: [
            { p: 'C4', d: 1 }, { p: 'E4', d: 1 }, { p: 'G4', d: 1 }, { p: 'Bb3', d: 1 }
          ]}]},
          { name: 'G7',    bars: [{ notes: [
            { p: 'Ab4', d: 1 }, { p: 'G4', d: 1 }, { p: 'F4', d: 1 }, { p: 'E4', d: 1 }
          ]}]},
          { name: 'Cmaj7', bars: [{ notes: [
            { p: 'D5', d: 2 }, { p: 'C5', d: 2 }
          ]}]},
        ],
      },
      {
        name: 'Line 2: E♭ major (up a minor 3rd)',
        description: 'Fm7: E♭ G B♭ D♭ | B♭7: C♭ B♭ A♭ G♭ | E♭maj7: F E♭.',
        chords: [
          { name: 'Fm7',   bars: [{ notes: [
            { p: 'Eb4', d: 1 }, { p: 'G4', d: 1 }, { p: 'Bb4', d: 1 }, { p: 'Db5', d: 1 }
          ]}]},
          { name: 'B♭7',   bars: [{ notes: [
            { p: 'Cb5', d: 1 }, { p: 'Bb4', d: 1 }, { p: 'Ab4', d: 1 }, { p: 'Gb4', d: 1 }
          ]}]},
          { name: 'E♭maj7', bars: [{ notes: [
            { p: 'F5', d: 2 }, { p: 'Eb5', d: 2 }
          ]}]},
        ],
      },
      {
        name: 'Line 3: E major (up a major 3rd)',
        description: 'F♯m7: E G♯ B D | B7: C♯ B A G♯ | Emaj7: F♯ E.',
        chords: [
          { name: 'F♯m7',  bars: [{ notes: [
            { p: 'E4', d: 1 }, { p: 'G#4', d: 1 }, { p: 'B4', d: 1 }, { p: 'D5', d: 1 }
          ]}]},
          { name: 'B7',    bars: [{ notes: [
            { p: 'C#5', d: 1 }, { p: 'B4', d: 1 }, { p: 'A4', d: 1 }, { p: 'G#4', d: 1 }
          ]}]},
          { name: 'Emaj7', bars: [{ notes: [
            { p: 'F#5', d: 2 }, { p: 'E5', d: 2 }
          ]}]},
        ],
      },
      {
        name: 'Line 4: G♭ major (up a tritone)',
        description: 'A♭m7: G B♭ D♭ E | D♭7: E♭ D♭ B A | G♭maj7: A♭ G♭. (Enharmonic respellings for readability.)',
        chords: [
          { name: 'A♭m7',  bars: [{ notes: [
            { p: 'G4', d: 1 }, { p: 'Bb4', d: 1 }, { p: 'Db5', d: 1 }, { p: 'E5', d: 1 }
          ]}]},
          { name: 'D♭7',   bars: [{ notes: [
            { p: 'Eb5', d: 1 }, { p: 'Db5', d: 1 }, { p: 'B4', d: 1 }, { p: 'A4', d: 1 }
          ]}]},
          { name: 'G♭maj7', bars: [{ notes: [
            { p: 'Ab5', d: 2 }, { p: 'Gb5', d: 2 }
          ]}]},
        ],
      },
    ],
  };

  // ---------- Public list ----------
  const ETUDES = [MC1, MC2, MC3, MC4, MC5, MC6];

  window.masterClassEtudes = {
    list: ETUDES,
    byId: function (id) {
      for (let i = 0; i < ETUDES.length; i++) {
        if (ETUDES[i].id === id) return ETUDES[i];
      }
      return null;
    },
  };
})();
