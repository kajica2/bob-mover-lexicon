#!/usr/bin/env python3
"""
Bob Mover Jazz Lexicon — Practice Library server.

Features:
- Static file serving
- MusicXML serving (with optional transposition)
- Practice log API
- Collections API
"""
import http.server
import json
import os
import re
import socketserver
import sys
import zipfile
from pathlib import Path
from urllib.parse import urlparse, parse_qs

# music21 is the gold standard for MusicXML manipulation
try:
    from music21 import stream, interval, key, pitch
    HAS_MUSIC21 = True
except ImportError:
    HAS_MUSIC21 = False

import db

ROOT = Path(__file__).parent.resolve()
EXERCISES_JSON = ROOT / "exercises.json"
IMAGES_DIR = ROOT / "exercises_images"
# Local MusicXML dir (works in dev and in production)
# Falls back to /workspace location for backward compat with the original extraction
_LOCAL_MUSICXML = ROOT / "musicxml"
_LEGACY_MUSICXML = Path("/workspace/extracted/exercises/musicxml")
MUSICXML_DIR = _LOCAL_MUSICXML if _LOCAL_MUSICXML.exists() else _LEGACY_MUSICXML

PORT = int(os.environ.get("PORT", "8080"))


def load_db_data():
    with open(EXERCISES_JSON) as f:
        return json.load(f)


def extract_musicxml_from_mxl(mxl_path):
    """Extract the .xml from a .mxl (zipped MusicXML) file."""
    with zipfile.ZipFile(mxl_path, 'r') as z:
        # Find the root .xml (not META-INF/container.xml)
        for name in z.namelist():
            if name.endswith('.xml') and not name.startswith('META-INF/'):
                return z.read(name).decode('utf-8')
    return None


def transpose_musicxml(mxl_path, semitones):
    """Transpose a MusicXML file by N semitones using music21.

    Returns the transposed XML as a string, or None if music21 unavailable.
    """
    if not HAS_MUSIC21:
        return None
    try:
        original_xml = extract_musicxml_from_mxl(mxl_path)
        if not original_xml:
            return None
        # Parse from string
        score = stream.Score()
        from music21 import converter
        score = converter.parse(original_xml, format='musicxml')
        if semitones != 0:
            score = score.transpose(semitones)
        # Serialize back to MusicXML. score.write returns a Path; read it back as string
        import tempfile
        with tempfile.NamedTemporaryFile(suffix='.musicxml', delete=False, mode='w') as tmp:
            tmp_path = tmp.name
        try:
            written = score.write('musicxml', fp=tmp_path)
            with open(written if isinstance(written, str) else tmp_path) as f:
                return f.read()
        finally:
            try:
                import os as _os
                _os.unlink(tmp_path)
            except OSError:
                pass
    except Exception as e:
        print(f"Transpose error: {e}", file=sys.stderr)
        return None


# Cycle mode -> semitone step per bar
CYCLE_STEP = {
    "chromatic": 1,
    "min3": 3,
    "4ths": 5,
    "5ths": 7,
}


def semitones_to_fifths(n):
    """Return the number of fifths for a major key n semitones above C.

    For n in 0..11, returns the standard key signature fifths:
      0=C(0), 1=C#(7), 2=D(2), 3=D#(9), 4=E(4), 5=F(-1), 6=F#(3),
      7=G(1), 8=G#(8), 9=A(5), 10=Bb(-2), 11=B(11).
    The original exercise starts in C (no key signature), so offsets
    use sharp-side spellings (positive fifths) where possible.
    """
    table = {0:0, 1:7, 2:2, 3:9, 4:4, 5:-1, 6:3, 7:1, 8:8, 9:5, 10:-2, 11:11}
    return table.get(n % 12, 0)


def cycle_key_sequence(mode, n=12):
    """Return the n-semitone offset list for the given cycle mode.

    'chromatic' -> [0,1,2,...,11]
    'min3'      -> [0,3,6,9,0,3,6,9,0,3,6,9]
    '4ths'      -> [0,5,10,3,8,1,6,11,4,9,2,7]
    '5ths'      -> [0,7,2,9,4,11,6,1,8,3,10,5]
    """
    if mode == "off" or mode is None:
        return [0]
    step = CYCLE_STEP.get(mode)
    if step is None:
        return [0]
    seq, s = [], 0
    for _ in range(n):
        seq.append(s)
        s = (s + step) % 12
    return seq


def cycle_musicxml(mxl_path, mode, bars):
    """Return MusicXML extended to `bars` copies of the exercise, each
    transposed by the appropriate cycle key.

    Returns the new XML string, or None on failure.
    """
    if not HAS_MUSIC21:
        return None
    try:
        original_xml = extract_musicxml_from_mxl(mxl_path)
        if not original_xml:
            return None
        from music21 import converter
        base = converter.parse(original_xml, format='musicxml')
        # Extract all measures from the first part. We operate on the part
        # so we can transpose by exact semitones and preserve the
        # original ordering.
        base_part = base.parts[0] if base.parts else base
        seq = cycle_key_sequence(mode, max(12, bars))[:bars]
        if len(seq) < bars:
            seq = seq + [0] * (bars - len(seq))
        out = converter.parse(original_xml, format='musicxml')
        out_part = out.parts[0] if out.parts else out
        # Strip existing measures — we'll rebuild from the base
        for m in list(out_part.getElementsByClass('Measure')):
            out_part.remove(m)
        # For each cycle iteration, deep-copy the base measures, transpose,
        # and insert.
        from music21 import stream as m21stream, key as m21key
        import copy as _copy
        for i, shift in enumerate(seq):
            # Deep-copy the base_part so we don't mutate the original
            cloned = _copy.deepcopy(base_part)
            if shift != 0:
                cloned = cloned.transpose(shift)
            # Insert a key signature at the start of this iteration's first
            # measure so the new key is announced on the barline (the
            # keychange only happens at the beginning of a bar).
            cloned_measures = cloned.getElementsByClass('Measure')
            if cloned_measures and shift != 0:
                first_m = cloned_measures[0]
                # Strip any existing key signature on this measure
                for k in list(first_m.getElementsByClass('Key')):
                    first_m.remove(k)
                # Insert the new key (use a major key from the offset)
                fifths = semitones_to_fifths(shift)
                ks = m21key.KeySignature(fifths)
                # Insert at position 0 of the measure (before any notes)
                first_m.insert(0, ks)
            # Insert each measure into the output part
            for m in cloned.getElementsByClass('Measure'):
                out_part.append(m)
        # Renumber measures sequentially so MusicXML/Verovio don't
        # see duplicate measure numbers (music21 resets numbering on
        # append; we want a continuous count 1, 2, 3, ...).
        measures = list(out_part.getElementsByClass('Measure'))
        for i, m in enumerate(measures, start=1):
            m.number = i

        # Re-emit to MusicXML
        import tempfile
        with tempfile.NamedTemporaryFile(suffix='.musicxml', delete=False, mode='w') as tmp:
            tmp_path = tmp.name
        try:
            written = out.write('musicxml', fp=tmp_path)
            with open(written if isinstance(written, str) else tmp_path) as f:
                return f.read()
        finally:
            try:
                import os as _os
                _os.unlink(tmp_path)
            except OSError:
                pass
    except Exception as e:
        print(f"Cycle error: {e}", file=sys.stderr)
        return None


# MusicXML <step> letter -> base pitch class within an octave. Sharps/flats
# are added via <alter> in the same <pitch> element.
_STEP_TO_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def _midi_from_pitch(step, alter, octave):
    pc = _STEP_TO_PC.get(step)
    if pc is None:
        return None
    if alter in ("1", "+1"):
        pc += 1
    elif alter in ("-1"):
        pc -= 1
    return (octave + 1) * 12 + pc


def clamp_notes_to_range(xml_string, low_midi, high_midi):
    """Walk every <pitch> in the score. If its MIDI note falls outside
    [low_midi, high_midi], shift the <octave> down (or up) until it fits.

    Notes *below* the range go up an octave; notes *above* the range go
    down an octave. The function returns the (possibly rewritten) XML
    string and a dict with counts. The user's request was specifically
    "transpose down an octave" for out-of-range notes; this implementation
    handles both edges because the same logic naturally moves a too-high
    note down while a too-low note would get pushed up.

    Operates on the raw MusicXML string via regex — no music21 round-trip.
    Fast, idempotent, and safe to call on a string that may or may not
    already contain octaves at the right value.
    """
    import re
    if not xml_string:
        return xml_string, {"moved": 0, "low": 0, "high": 0, "unchanged": 0}

    stats = {"moved": 0, "low_moved_up": 0, "high_moved_down": 0, "unchanged": 0}

    # Match each <pitch>...</pitch> block. The XML for a pitch is small;
    # re.sub with a callback is fine.
    pitch_re = re.compile(
        r'(<pitch\b[^>]*>)(.*?)(</pitch>)',
        re.DOTALL,
    )

    def replace_pitch(match):
        open_tag, body, close_tag = match.group(1), match.group(2), match.group(3)
        step_m = re.search(r'<step>\s*([A-Ga-g])\s*</step>', body)
        oct_m  = re.search(r'<octave>\s*(-?\d+)\s*</octave>', body)
        alt_m  = re.search(r'<alter>\s*(-?\d+)\s*</alter>', body)
        if not step_m or not oct_m:
            return match.group(0)  # malformed — leave alone
        step = step_m.group(1).upper()
        try:
            octave = int(oct_m.group(1))
        except ValueError:
            return match.group(0)
        alter = alt_m.group(1) if alt_m else "0"
        midi = _midi_from_pitch(step, alter, octave)
        if midi is None:
            return match.group(0)

        # Shift octave up if too low, down if too high. Always decrement at
        # least once when the note is out of range — the while loop
        # condition only checks the lower octave, but a single decrement
        # of an out-of-range note is always needed.
        if midi < low_midi:
            octave += 1
            midi = _midi_from_pitch(step, alter, octave)
            while midi < low_midi and octave < 9:
                octave += 1
                midi = _midi_from_pitch(step, alter, octave)
            stats["low_moved_up"] += 1
            stats["moved"] += 1
        elif midi > high_midi:
            octave -= 1
            midi = _midi_from_pitch(step, alter, octave)
            while midi > high_midi and octave > 0:
                octave -= 1
                midi = _midi_from_pitch(step, alter, octave)
            stats["high_moved_down"] += 1
            stats["moved"] += 1
        else:
            stats["unchanged"] += 1

        # Re-emit the pitch block with the new octave. Reuse the original
        # whitespace layout to keep diffs minimal.
        new_body = re.sub(
            r'<octave>\s*-?\d+\s*</octave>',
            '<octave>%d</octave>' % octave,
            body,
            count=1,
        )
        return open_tag + new_body + close_tag

    new_xml = pitch_re.sub(replace_pitch, xml_string)
    return new_xml, stats


def swap_to_bass_clef(xml_string):
    """Rewrite every <clef> in the score from treble (G/line 2) to bass
    (F/line 4). Handles the four shapes MusicXML uses:

      <clef><sign>G</sign><line>2</line></clef>
      <clef><sign>G</sign><line>2</line><clef-octave-change>...</clef-octave-change></clef>
      <clef print-object="no"><sign>G</sign><line>2</line></clef>
      (and the same with different attribute ordering)

    The simplest robust swap: regex over each <clef>...</clef> block;
    replace <sign>G</sign> with <sign>F</sign> and <line>2</line> with
    <line>4</line>, leaving everything else (attributes, clef-octave-change)
    untouched.

    Used when the user picks a bass instrument so the score reads in their
    clef instead of treble.
    """
    import re
    if not xml_string:
        return xml_string

    clef_re = re.compile(r"<clef\b[^>]*>(.*?)</clef>", re.DOTALL)

    def rewrite(match):
        body = match.group(1)
        new_body = body
        new_body = re.sub(
            r"<sign>\s*G\s*</sign>",
            "<sign>F</sign>",
            new_body,
            count=1,
        )
        new_body = re.sub(
            r"<line>\s*2\s*</line>",
            "<line>4</line>",
            new_body,
            count=1,
        )
        if new_body == body:
            return match.group(0)  # no treble clef inside; leave alone
        return "<clef>" + new_body + "</clef>"

    return clef_re.sub(rewrite, xml_string)


def strip_extra_clefs(xml_string):
    """Remove <clef> elements from every measure EXCEPT the first.

    The cycle path deep-copies each iteration of the source measures, and
    the source MusicXML carries a <clef> on its first measure. After a
    cycle, every iteration's first measure ends up with its own <clef>,
    which Verovio renders as redundant clef glyphs at the start of each
    key on the cycled score. Removing all but the first clef leaves a
    clean score that only sets the clef once at the very start.

    Operates on the raw MusicXML string via regex. Idempotent.
    """
    import re
    if not xml_string:
        return xml_string

    # Walk each <measure ...>...</measure> block in order. On the first
    # measure we keep its clef; on subsequent measures we strip ALL clef
    # blocks. The measure-block detection uses `<measure ` (followed by
    # space or `>`) so it does NOT split `<measure-numbering>` (which
    # lives inside <print> within the first measure).
    parts = re.split(r'(<measure[\s>])', xml_string)
    out = [parts[0]]
    saw_first = False
    for i in range(1, len(parts), 2):
        tag = parts[i]
        body = parts[i + 1] if i + 1 < len(parts) else ''
        out.append(tag)
        m_end = re.search(r'</measure>', body)
        if not m_end:
            out.append(body)
            continue
        measure_text = body[:m_end.end()]
        rest = body[m_end.end():]
        if saw_first:
            # Subsequent measures: strip ALL clef blocks entirely.
            measure_text = re.sub(
                r'<clef\b[^>]*>.*?</clef>',
                '',
                measure_text,
                flags=re.DOTALL,
            )
        # First measure is left as-is (it keeps its own clef block
        # verbatim, no shifting of attributes). Subsequent measures get
        # their clefs dropped above.
        out.append(measure_text)
        out.append(rest)
        saw_first = True
    return ''.join(out)


def inject_title_into_musicxml(xml_string, exercise_id, title, section=None,
                                section_name=None):
    """Inject <work><work-title>...</work-title></work> into the score so
    Verovio renders the exercise label at the top.

    The displayed title is composed as:
      <section full name> · #<exercise id>
    e.g. "Chromatic · #5"

    Falls back to the short section code (e.g. "1A") if `section_name` isn't
    provided, and to "Exercise <id>" if no title/name data is available.

    The `title` parameter is retained for callers that pass it (and for
    logging), but is intentionally NOT included in the rendered work-title —
    the score header should stay short so it doesn't dominate the page.
    """
    import re
    label_section = section_name or section or ""
    full = f"{label_section} · #{exercise_id}".strip(" ·")
    if not full:
        full = f"Exercise {exercise_id}"
    full = re.sub(r"\s+", " ", full)[:120]
    work_block = f'<work><work-title>{full}</work-title></work>'
    if "<work>" in xml_string:
        if "<work-title>" in xml_string:
            xml_string = re.sub(
                r"<work-title>[^<]*</work-title>",
                f"<work-title>{full}</work-title>",
                xml_string, count=1,
            )
        else:
            xml_string = xml_string.replace(
                "<work>", f"<work><work-title>{full}</work-title>", 1,
            )
        return xml_string
    if "<score-partwise" in xml_string:
        return re.sub(
            r"<score-partwise(\s[^>]*)?>", f"<score-partwise\\1>{work_block}",
            xml_string, count=1,
        )
    if "<score-timewise" in xml_string:
        return re.sub(
            r"<score-timewise(\s[^>]*)?>", f"<score-timewise\\1>{work_block}",
            xml_string, count=1,
        )
    return xml_string


def insert_line_breaks(xml_string, measures_per_line=4):
    """Insert <print new-system="yes"/> after every Nth <measure> to
    force Verovio to lay out the score in strict N-measure lines.

    Skips the first measure (no break before it). Skips the last
    measure's break so the final bar doesn't start a new system.

    Idempotent — re-running with a different N replaces existing
    new-system markers.
    """
    import re
    if not xml_string or measures_per_line < 1:
        return xml_string
    # Remove any existing <print new-system="yes"/> to start clean
    xml_string = re.sub(
        r'<print\b[^>]*new-system="yes"[^>]*/>',
        '',
        xml_string,
    )
    # Walk measures in order, insert <print new-system="yes"/> after every
    # measures_per_line-th one EXCEPT after the very last measure.
    # IMPORTANT: match `<measure ` (followed by space/attribute) — NOT
    # `<measure-numbering>`, which is a child element that lives inside
    # the first measure. Without this distinction the function would
    # count print marks inside <print>...</print> blocks as measures.
    parts = re.split(r'(<measure[\s>])', xml_string)
    out = [parts[0]]
    count = 0
    # First pass: count total measures
    total_measures = sum(1 for i in range(1, len(parts), 2))
    for i in range(1, len(parts), 2):
        tag = parts[i]
        body = parts[i + 1] if i + 1 < len(parts) else ''
        out.append(tag)
        m_end = re.search(r'</measure>', body)
        if m_end:
            measure_text = body[:m_end.end()]
            rest = body[m_end.end():]
        else:
            measure_text = body
            rest = ''
        out.append(measure_text)
        count += 1
        # Insert break after every Nth measure, but not after the last
        if count % measures_per_line == 0 and count < total_measures and rest:
            out.append('<print new-system="yes"/>')
        out.append(rest)
    return ''.join(out)


def strip_score_junk(xml_string):
    """Remove dynamic markings, voice/staff labels, and other markings
    that clutter the score. Keeps the title and the notes only.

    - Strips <direction> elements (dynamics, text directions, tempo).
    - Strips <staff-text> elements.
    - Empties <part-name>, <part-abbreviation>, and <instrument-name>
      so Verovio doesn't render a default 'Voice' staff label.
    Idempotent.
    """
    import re
    if not xml_string:
        return xml_string

    # <movement-title> blocks (music21's write() adds this; we want
    # only the <work-title> we injected to show)
    xml_string = re.sub(r"<movement-title>.*?</movement-title>", "", xml_string, flags=re.DOTALL)
    xml_string = re.sub(r"<movement-title\b[^>]*/>", "", xml_string)

    # <key>...</key> blocks (we want accidentals on notes, not a key
    # signature at the start of each bar). Music21's transpose() may
    # add <key> elements; strip them all.
    xml_string = re.sub(r"<key>.*?</key>", "", xml_string, flags=re.DOTALL)
    xml_string = re.sub(r"<key\b[^>]*/>", "", xml_string)
    # <fifths> as a standalone (defensive)
    xml_string = re.sub(r"<fifths>.*?</fifths>", "", xml_string, flags=re.DOTALL)
    xml_string = re.sub(r"<fifths\b[^>]*/>", "", xml_string)

    # All <direction>...</direction> blocks (paired tags)
    xml_string = re.sub(
        r"<direction\b[^>]*>.*?</direction>",
        "",
        xml_string,
        flags=re.DOTALL,
    )
    # Self-closed <direction/>
    xml_string = re.sub(r"<direction\b[^>]*/>", "", xml_string)

    # <staff-text>...</staff-text>
    xml_string = re.sub(
        r"<staff-text\b[^>]*>.*?</staff-text>",
        "",
        xml_string,
        flags=re.DOTALL,
    )
    xml_string = re.sub(r"<staff-text\b[^>]*/>", "", xml_string)

    # Empty out part-name, part-abbreviation, instrument-name
    xml_string = re.sub(
        r"<part-name>[^<]*</part-name>",
        "<part-name></part-name>",
        xml_string,
    )
    xml_string = re.sub(
        r"<part-abbreviation>[^<]*</part-abbreviation>",
        "<part-abbreviation></part-abbreviation>",
        xml_string,
    )
    xml_string = re.sub(
        r"<instrument-name>[^<]*</instrument-name>",
        "<instrument-name></instrument-name>",
        xml_string,
    )
    return xml_string


def get_musicxml_with_title(exercise_id, transpose_semitones=0):
    """Like get_musicxml, but with the exercise title injected into the
    MusicXML <work> element so Verovio renders it at the top.
    """
    xml, ctype = get_musicxml(exercise_id, transpose_semitones)
    if xml is None:
        return None, None
    try:
        with open(EXERCISES_JSON) as f:
            data = json.load(f)
        ex = next((e for e in data["exercises"] if e["id"] == exercise_id), None)
        if ex:
            xml = inject_title_into_musicxml(
                xml,
                exercise_id,
                ex.get("title", ""),
                ex.get("section"),
                ex.get("section_name"),
            )
    except Exception:
        pass
    xml = strip_score_junk(xml)
    xml = strip_extra_clefs(xml)
    xml = insert_line_breaks(xml, 4)
    return xml, ctype


def get_musicxml(exercise_id, transpose_semitones=0):
    """Get MusicXML for an exercise, optionally transposed.

    Returns (xml_string, content_type) or (None, None) if not found.
    """
    mxl_path = MUSICXML_DIR / f"{exercise_id:04d}.mxl"
    if not mxl_path.exists():
        return None, None

    if transpose_semitones == 0:
        # Return raw extracted XML
        xml = extract_musicxml_from_mxl(mxl_path)
        return xml, "application/vnd.recordare.musicxml+xml"

    transposed = transpose_musicxml(mxl_path, transpose_semitones)
    if transposed:
        return transposed, "application/vnd.recordare.musicxml+xml"
    # Fallback to original if transposition failed
    xml = extract_musicxml_from_mxl(mxl_path)
    return xml, "application/vnd.recordare.musicxml+xml"


# Instrument transposition offsets (semitones from concert to written)
INSTRUMENT_OFFSETS = {
    "concert": 0,
    "bb": 2,     # Bb instruments sound a M2 lower than written -> transpose UP 2 to get written
    "eb": 9,     # Eb instruments sound a M6 lower than written -> transpose UP 9
    "f": 7,      # F instruments (horn) sound P5 lower
    "alto": 9,   # alto sax
    "tenor": 2,  # tenor sax
    "soprano": 2, # soprano sax
    "bari": 9,   # bari sax
    "trumpet": 2,
    "clarinet": 2,
    "bass": 0,   # bass (acoustic/electric) — concert pitch, non-transposing
}

# Which instruments get the score rendered in bass clef instead of treble.
# All other instruments use whatever clef music21 / the source MusicXML
# carries (currently treble for every exercise in this library).
BASS_CLEF_INSTRUMENTS = {"bass"}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        # API routes
        if path == "/api/practice/recent":
            return self.handle_recent(qs)
        if path == "/api/practice/stats":
            return self.handle_stats(qs)
        if path.startswith("/api/practice/exercise/"):
            try:
                eid = int(path.rsplit("/", 1)[-1])
                return self.handle_exercise_history(eid)
            except ValueError:
                return self.send_json({"error": "Invalid exercise ID"}, 400)

        if path.startswith("/api/musicxml/"):
            try:
                eid = int(path.rsplit("/", 1)[-1])
            except ValueError:
                return self.send_json({"error": "Invalid exercise ID"}, 400)
            transpose = int(qs.get("transpose", ["0"])[0])
            instrument = qs.get("instrument", ["concert"])[0]
            offset = INSTRUMENT_OFFSETS.get(instrument, 0)
            semitones = transpose + offset
            xml, ctype = get_musicxml_with_title(eid, semitones)
            if xml is None:
                return self.send_json({"error": "MusicXML not available for this exercise"}, 404)
            # Optional user range (from the range modal). Out-of-range notes
            # are octave-shifted so the score always reads in the player's
            # register. Sent by the Practice page whenever the user has a
            # range saved; absent otherwise (cycle path uses a different
            # mechanism via the JSON body).
            try:
                user_low  = int(qs.get("low",  [""])[0] or 0) or None
            except (TypeError, ValueError):
                user_low = None
            try:
                user_high = int(qs.get("high", [""])[0] or 0) or None
            except (TypeError, ValueError):
                user_high = None
            if user_low is not None and user_high is not None and user_low > user_high:
                user_low, user_high = user_high, user_low
            if user_low is not None and user_high is not None:
                xml, _ = clamp_notes_to_range(xml, user_low, user_high)
            # Bass clef swap for bass-family instruments
            if instrument in BASS_CLEF_INSTRUMENTS and xml is not None:
                xml = swap_to_bass_clef(xml)
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Access-Control-Allow-Origin", "*")
            body = xml.encode("utf-8") if isinstance(xml, str) else xml
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        # Check favorite status
        m_fav_get = re.match(r"^/api/favorites/(\d+)$", path)
        if m_fav_get:
            try:
                eid = int(m_fav_get.group(1))
            except ValueError:
                return self.send_json({"error": "Invalid exercise ID"}, 400)
            return self.send_json({"exercise_id": eid, "favorited": db.is_favorite(eid)})
        if path == "/api/favorites":
            return self.send_json({"favorites": db.get_favorites()})
        if path == "/api/collections":
            return self.handle_list_collections()
        if path.startswith("/api/collections/") and path != "/api/collections/":
            try:
                cid = int(path.rsplit("/", 1)[-1])
                return self.handle_get_collection(cid)
            except ValueError:
                return self.send_json({"error": "Invalid collection ID"}, 400)

        # Default: serve static
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        # Favorite endpoints
        m_fav = re.match(r"^/api/favorites/(\d+)$", path)
        if m_fav:
            try:
                eid = int(m_fav.group(1))
            except ValueError:
                return self.send_json({"error": "Invalid exercise ID"}, 400)
            try:
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length) if length else b"{}"
            except Exception:
                raw = b"{}"
            db.add_favorite(eid)
            return self.send_json({"ok": True, "favorited": True})
        if path == "/api/favorites":
            return self.send_json({"favorites": db.get_favorites()})
        if path.startswith("/api/musicxml/") and path.endswith("/cycle"):
            return self.handle_musicxml_cycle(path)
        if path == "/api/practice":
            return self.handle_log_practice()
        if path == "/api/collections":
            return self.handle_create_collection()
        return self.send_json({"error": "Not Found"}, 404)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path
        # Unfavorite
        m_fav = re.match(r"^/api/favorites/(\d+)$", path)
        if m_fav:
            try:
                eid = int(m_fav.group(1))
            except ValueError:
                return self.send_json({"error": "Invalid exercise ID"}, 400)
            db.remove_favorite(eid)
            return self.send_json({"ok": True, "favorited": False})
        # Delete a practice log entry
        m_log = re.match(r"^/api/practice/(\d+)$", path)
        if m_log:
            try:
                log_id = int(m_log.group(1))
            except ValueError:
                return self.send_json({"error": "Invalid log ID"}, 400)
            if db.delete_practice_log(log_id):
                return self.send_json({"ok": True})
            return self.send_json({"error": "Not found"}, 404)
        if path.startswith("/api/collections/") and path != "/api/collections/":
            try:
                cid = int(path.rsplit("/", 1)[-1])
                if db.delete_collection(cid):
                    return self.send_json({"ok": True})
                return self.send_json({"error": "Not found"}, 404)
            except ValueError:
                return self.send_json({"error": "Invalid collection ID"}, 400)
        return self.send_json({"error": "Not Found"}, 404)

    # ===== API handlers =====

    def handle_musicxml_cycle(self, path):
        """POST /api/musicxml/<id>/cycle  body: { mode, bars, instrument, transpose }

        Returns MusicXML extended to `bars` copies of the exercise, each
        transposed by the appropriate cycle key (mod-12 sequence).
        """
        try:
            eid = int(path.split("/")[3])
        except (ValueError, IndexError):
            return self.send_json({"error": "Invalid exercise ID"}, 400)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            payload = json.loads(raw)
        except Exception as e:
            return self.send_json({"error": f"Invalid JSON: {e}"}, 400)
        mode = payload.get("mode", "off")
        try:
            bars = max(1, min(12, int(payload.get("bars", 1))))
        except (TypeError, ValueError):
            bars = 1
        if mode not in ("off", "chromatic", "min3", "4ths", "5ths"):
            return self.send_json({"error": f"Unknown mode: {mode}"}, 400)
        # Optional user range (from the range modal). If supplied, every
        # <pitch> outside [low, high] is shifted by an octave (or more)
        # until it fits. Bad/missing values are silently ignored.
        try:
            user_low  = int(payload["low"])  if payload.get("low")  is not None else None
        except (KeyError, TypeError, ValueError):
            user_low = None
        try:
            user_high = int(payload["high"]) if payload.get("high") is not None else None
        except (KeyError, TypeError, ValueError):
            user_high = None
        if user_low is not None and user_high is not None and user_low > user_high:
            user_low, user_high = user_high, user_low  # swap if reversed
        mxl_path = MUSICXML_DIR / f"{eid:04d}.mxl"
        if not mxl_path.exists():
            return self.send_json({"error": "MusicXML not available"}, 404)
        if mode == "off" or bars == 1:
            transpose = int(payload.get("transpose", 0))
            instrument = payload.get("instrument", "concert")
            offset = INSTRUMENT_OFFSETS.get(instrument, 0)
            xml, ctype = get_musicxml(eid, transpose + offset)
        else:
            xml, ctype = get_musicxml(eid, 0)
            if xml is not None:
                cycled = cycle_musicxml(mxl_path, mode, bars)
                if cycled is not None:
                    xml = cycled
        # Clamp every note to the user's register range. Out-of-range notes
        # are shifted down (or up) by an octave. Done before the title +
        # line-break post-processing so the rendered score reflects the
        # transposition in its measure layout.
        if xml is not None and user_low is not None and user_high is not None:
            xml, _clamp_stats = clamp_notes_to_range(xml, user_low, user_high)
        # Bass clef swap. Done after transposition + clamp so the resulting
        # score reads in bass clef with notes already in the player's
        # register. Only fires for instruments in BASS_CLEF_INSTRUMENTS.
        instrument_for_clef = payload.get("instrument", "concert")
        if xml is not None and instrument_for_clef in BASS_CLEF_INSTRUMENTS:
            xml = swap_to_bass_clef(xml)
        # Inject the exercise title into the returned XML (cycled or not)
        if xml is not None:
            try:
                with open(EXERCISES_JSON) as f:
                    _ex_data = json.load(f)
                _ex = next((e for e in _ex_data["exercises"] if e["id"] == eid), None)
                xml = inject_title_into_musicxml(
                    xml, eid, _ex.get("title", "") if _ex else "",
                    _ex.get("section") if _ex else None,
                    _ex.get("section_name") if _ex else None,
                )
            except Exception:
                xml = inject_title_into_musicxml(xml, eid, "", None, None)
            if xml is not None:
                xml = strip_score_junk(xml)
                xml = strip_extra_clefs(xml)
                xml = insert_line_breaks(xml, 4)
        if xml is None:
            return self.send_json({"error": "Cycle generation failed"}, 500)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        body = xml.encode("utf-8") if isinstance(xml, str) else xml
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_log_practice(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            data = json.loads(raw)
        except Exception as e:
            return self.send_json({"error": f"Invalid JSON: {e}"}, 400)
        eid = data.get("exercise_id")
        if not isinstance(eid, int):
            return self.send_json({"error": "exercise_id (int) required"}, 400)
        try:
            lid = db.log_practice(
                exercise_id=eid,
                tempo_bpm=data.get("tempo_bpm"),
                key_signature=data.get("key_signature"),
                duration_min=data.get("duration_min"),
                notes=data.get("notes"),
                completed=data.get("completed", True),
                practiced_at=data.get("practiced_at"),
            )
            return self.send_json({"ok": True, "id": lid})
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)

    def handle_recent(self, qs):
        try:
            days = int(qs.get("days", ["30"])[0])
        except ValueError:
            days = 30
        try:
            limit = int(qs.get("limit", ["100"])[0])
        except ValueError:
            limit = 100
        return self.send_json({
            "practice": db.get_recent_practice(days=days, limit=limit)
        })

    def handle_stats(self, qs):
        try:
            days = int(qs.get("days", ["30"])[0])
        except ValueError:
            days = 30
        return self.send_json(db.get_practice_stats(days=days))

    def handle_exercise_history(self, exercise_id):
        try:
            limit = int(parse_qs(urlparse(self.path).query).get("limit", ["20"])[0])
        except (ValueError, IndexError):
            limit = 20
        return self.send_json({
            "exercise_id": exercise_id,
            "history": db.get_exercise_history(exercise_id, limit=limit),
            "summary": db.get_exercise_summary(exercise_id),
        })

    def handle_list_collections(self):
        return self.send_json({"collections": db.list_collections()})

    def handle_get_collection(self, cid):
        col = db.get_collection(cid)
        if col is None:
            return self.send_json({"error": "Not found"}, 404)
        return self.send_json(col)

    def handle_create_collection(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            data = json.loads(raw)
        except Exception as e:
            return self.send_json({"error": f"Invalid JSON: {e}"}, 400)
        name = data.get("name")
        if not name:
            return self.send_json({"error": "name required"}, 400)
        cid = db.create_collection(
            name=name,
            description=data.get("description"),
            exercise_ids=data.get("exercise_ids"),
        )
        if cid is None:
            return self.send_json({"error": "Collection name already exists"}, 409)
        return self.send_json({"ok": True, "id": cid})

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    print(f"Bob Mover Lexicon Practice Library")
    print(f"  Serving:    {ROOT}")
    print(f"  Port:       {PORT}")
    print(f"  music21:    {'yes' if HAS_MUSIC21 else 'NO - transposition disabled'}")
    print(f"  MusicXML:   {MUSICXML_DIR} ({len(list(MUSICXML_DIR.glob('*.mxl'))) if MUSICXML_DIR.exists() else 0} files)")
    print(f"  Images:     {IMAGES_DIR} ({len(list(IMAGES_DIR.glob('*.png')))} files)")
    print(f"  DB:         {db.DB_PATH}")
    print()
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        httpd.allow_reuse_address = True
        print(f"  Open: http://localhost:{PORT}/")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down.")


if __name__ == "__main__":
    main()
