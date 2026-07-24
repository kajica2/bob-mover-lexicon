#!/usr/bin/env python3
"""
Detect likely-bad transcriptions in the musicxml/ directory.

For each of the 407 .mxl files, parses the MusicXML with music21 and
extracts a structural fingerprint. Flags exercises where the structure
looks suspicious vs the source PDF page. The user can then manually
inspect the flagged ones and re-OCR them with Audiveris if needed.

Heuristics used:
  1. **Parse error**: music21 couldn't parse the .mxl at all.
  2. **Too few notes**: <5 pitched notes (Audiveris often drops most
     of a page when the OMR fails — see practice.js fallback for the
     6 known-broken exercises: 17, 79, 132, 152, 168, 229).
  3. **No time signature**: missing <attributes><time> in any measure
     (would render as a meterless bar in Verovio).
  4. **Bar count mismatch**: the page number from exercises.json is
     used as a proxy for "expected bars per page" — but bar count
     varies too widely across exercises for a hard rule, so we just
     report it and the user eyeballs.
  5. **Empty measures**: any measure with zero pitched notes AND zero
     rests (a "phantom" measure Audiveris sometimes inserts at the
     start of a line).

Outputs:
  - transcription_health.csv: every exercise with structural fields
  - transcription_health_suspicious.csv: only the flagged ones (sorted
    by suspicion level: parse errors first, then too-few-notes, etc.)
  - Prints a summary to stdout.

Usage:
  python3 detect_bad_transcriptions.py
"""
import csv
import os
import sys
from pathlib import Path

from music21 import converter

ROOT = Path('/Users/kaidejuricmasscmbook/GrokDesk/bob-mover-lexicon-push')
MUSICXML_DIR = ROOT / 'musicxml'

# Output files
OUT_FULL = ROOT / 'transcription_health.csv'
OUT_SUSPICIOUS = ROOT / 'transcription_health_suspicious.csv'


def analyze(eid, mxl_path):
    """Return a dict of structural fields, or None on parse error.

    A parse-error result has only {id, error} populated.
    """
    try:
        score = converter.parse(str(mxl_path))
    except Exception as e:
        return {'id': eid, 'error': repr(e)[:200]}

    parts = list(score.parts)
    if not parts:
        return {'id': eid, 'error': 'no parts in score'}

    # Use the first part for analysis. All exercises in this book are
    # single-line (treble clef), so part[0] is the one.
    part = parts[0]
    measures = list(part.getElementsByClass('Measure'))
    notes_all = list(part.recurse().notes)
    pitched = [n for n in notes_all if n.isNote]
    rests = [n for n in notes_all if n.isRest]
    chords = [n for n in notes_all if n.isChord]

    # Time signature: walk measures and grab the first one we see.
    # NOTE: Audiveris often drops the <time> element from the
    # extracted MusicXML — the bar lengths are still correct
    # (Verovio and music21 infer 4/4 from the beat count), so
    # missing time signature is NOT a useful suspicion signal.
    # Kept here for completeness but not used in suspicious_reason().
    time_sig = ''
    for m in measures:
        for ts in m.getElementsByClass('TimeSignature'):
            time_sig = str(ts)
            break
        if time_sig:
            break

    # Key signature: same approach.
    key_sig = ''
    for m in measures:
        for ks in m.getElementsByClass('KeySignature'):
            key_sig = str(ks)
            break
        if key_sig:
            break

    # Bar-line presence: how many measures have a real barline.
    measures_with_end = sum(
        1 for m in measures
        if getattr(m, 'rightBarline', None) is not None
        or (m.offset == 0 and m is not measures[-1])  # internal
        or m is measures[-1]  # final
    )

    # Empty measures: a measure with no notes AND no rests.
    empty_measures = sum(
        1 for m in measures
        if not list(m.recurse().getElementsByClass('Note'))
        and not list(m.recurse().getElementsByClass('Rest'))
    )

    # Max notes per measure: a heuristic for "Audiveris doubled a
    # passage" — most measures in the Bob Mover book have <20
    # notes; >25 in any one measure is suspicious.
    max_notes_per_measure = 0
    for m in measures:
        n = sum(1 for x in m.recurse().getElementsByClass('Note') if x.isNote)
        if n > max_notes_per_measure:
            max_notes_per_measure = n

    return {
        'id': eid,
        'error': '',
        'measure_count': len(measures),
        'pitched_count': len(pitched),
        'rest_count': len(rests),
        'chord_count': len(chords),
        'time_sig': time_sig,
        'key_sig': key_sig,
        'empty_measures': empty_measures,
        'max_notes_per_measure': max_notes_per_measure,
    }


def suspicious_reason(row):
    """Return a reason string if this row is suspicious, else ''.

    Heuristics, in order of severity:
      1. PARSE_ERROR — music21 couldn't parse the file
      2. VERY_FEW_NOTES — fewer than 5 pitched notes (Audiveris
         usually drops most of a page when OMR fails; the 6 known-
         broken exercises are 17, 79, 132, 152, 168, 229 per
         practice.js's static-PNG fallback)
      3. EMPTY_MEASURES — any measure with no notes AND no rests
      4. MAX_NOTES_PER_MEASURE — any measure with >25 notes (an
         OMR error that doubled a passage is usually > 25)
    """
    if row.get('error'):
        return 'PARSE_ERROR'
    rc = row.get('pitched_count', 0)
    if rc < 5:
        return f'VERY_FEW_NOTES ({rc})'
    em = row.get('empty_measures', 0)
    if em and em > 0:
        return f'EMPTY_MEASURES ({em})'
    mnpm = row.get('max_notes_per_measure', 0)
    if mnpm and mnpm > 25:
        return f'BEAT_DENSITY (max {mnpm} notes/bar)'
    return ''


def main():
    if not MUSICXML_DIR.is_dir():
        print(f'musicxml/ not found at {MUSICXML_DIR}', file=sys.stderr)
        sys.exit(1)

    mxl_files = sorted(MUSICXML_DIR.glob('*.mxl'))
    print(f'Scanning {len(mxl_files)} .mxl files in {MUSICXML_DIR}...')

    rows = []
    for i, mxl in enumerate(mxl_files, 1):
        if i % 50 == 0:
            print(f'  {i}/{len(mxl_files)}...', file=sys.stderr)
        eid = int(mxl.stem)
        row = analyze(eid, mxl)
        row['suspicious'] = suspicious_reason(row)
        rows.append(row)

    # Sort by suspiciousness (suspicious first), then by id.
    rows.sort(key=lambda r: (0 if r['suspicious'] else 1, r['id']))

    # Full CSV
    fieldnames = ['id', 'error', 'measure_count', 'pitched_count', 'rest_count',
                  'chord_count', 'time_sig', 'key_sig', 'empty_measures',
                  'max_notes_per_measure', 'suspicious']
    with open(OUT_FULL, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, '') for k in fieldnames})

    # Suspicious-only CSV (same headers, just filtered)
    suspicious = [r for r in rows if r['suspicious']]
    with open(OUT_SUSPICIOUS, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in suspicious:
            w.writerow({k: r.get(k, '') for k in fieldnames})

    # Stdout summary
    print()
    print(f'Total exercises scanned: {len(rows)}')
    print(f'Suspicious:              {len(suspicious)}')
    print()
    print('Breakdown:')
    by_reason = {}
    for r in suspicious:
        reason = r['suspicious'].split(' ')[0]
        by_reason[reason] = by_reason.get(reason, 0) + 1
    for reason, n in sorted(by_reason.items(), key=lambda x: -x[1]):
        print(f'  {reason}: {n}')
    print()
    if suspicious:
        print('First 30 suspicious exercises (full list in transcription_health_suspicious.csv):')
        for r in suspicious[:30]:
            print(f'  #{r["id"]:>4}  {r["suspicious"]:<20}  '
                  f'notes={r.get("pitched_count", "?"):<3}  ts={r.get("time_sig", "")}')

    print()
    print(f'Wrote: {OUT_FULL}')
    print(f'Wrote: {OUT_SUSPICIOUS}')


if __name__ == '__main__':
    main()
