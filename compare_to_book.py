#!/usr/bin/env python3
"""
Compare what's on the site (the rendered MusicXML) against what's in
the book (the source PDF page crop). For each exercise:

  1. Reads the source PDF crop (exercises_images/<NNNN>.png)
  2. Reads the rendered version (from /tmp/bml-renders/<NNNN>.png
     — populated by `node render_all.mjs`)
  3. Extracts the note-duration sequence from the committed
     musicxml/<NNNN>.mxl via music21 (e.g. for 4 measures:
     [4,4,4,4] = four quarter-rest measures,
     [0.5]*16 = sixteen eighth notes, etc.)
  4. Generates a side-by-side PNG (rendered | source) into
     /tmp/bml-book-compare/<NNNN>.png

The script also outputs:
  - compare_to_book_results.csv: every exercise with its duration
    sequence, the count of each duration type, and the path to the
    side-by-side image.
  - compare_to_book_suspicious.csv: only exercises that look
    suspicious from a duration standpoint. The current heuristic
    is: the exercise has 0 eighth notes (8th / 16th / dotted 8th)
    AND the side-by-side image looks plausibly 8th-note-heavy.
    That's a coarse filter — use the side-by-sides to confirm.

Prereq:
  - dev server running on localhost:8080
  - node render_all.mjs        # populates /tmp/bml-renders/

Usage:
  python3 compare_to_book.py
"""
import csv
import sys
import time
from collections import Counter
from pathlib import Path

from PIL import Image, ImageDraw
from music21 import converter

ROOT = Path('/Users/kaidejuricmasscmbook/GrokDesk/bob-mover-lexicon-push')
IMG_DIR = ROOT / 'exercises_images'
RENDERS_DIR = Path('/tmp/bml-renders')
OUT_DIR = Path('/tmp/bml-book-compare')
OUT_FULL = ROOT / 'compare_to_book_results.csv'
OUT_SUSPICIOUS = ROOT / 'compare_to_book_suspicious.csv'

# Quarter note = 1.0, eighth note = 0.5, sixteenth = 0.25, half = 2.0,
# whole = 4.0, dotted = +50% (e.g. dotted quarter = 1.5, dotted 8th = 0.75).
# Treat anything in [0.25, 0.75] as an 8th-note family member.
EIGHTH_FAMILY = {0.25, 0.375, 0.5, 0.5625, 0.625, 0.75}

# Side-by-side image dimensions.
SB_TILE_H = 360


def get_durations(mxl_path):
    """Return (per_measure_durations, flat_durations, duration_counts)
    for a .mxl. per_measure_durations is a list of lists of quarter-
    lengths; flat_durations is the concatenated flat list.
    duration_counts is a Counter of durations → count.
    """
    if not mxl_path.exists():
        return None, None, None
    try:
        score = converter.parse(str(mxl_path))
    except Exception as e:
        return None, None, {'error': str(e)[:200]}
    if not score.parts:
        return [], [], Counter()
    part = score.parts[0]
    per_measure = []
    flat = []
    for m in part.getElementsByClass('Measure'):
        measure_durations = []
        for n in m.recurse().notes:
            if n.isNote or n.isChord:
                # duration.quarterLength gives the duration in quarter notes.
                measure_durations.append(float(n.duration.quarterLength))
                flat.append(float(n.duration.quarterLength))
        per_measure.append(measure_durations)
    counts = Counter(round(d * 4) / 4 for d in flat)  # bucket to nearest 0.25
    return per_measure, flat, counts


def make_side_by_side(rendered_path, source_path, out_path, label):
    r = Image.open(rendered_path).convert('RGB')
    s = Image.open(source_path).convert('RGB')
    H = max(r.height, s.height)
    def fit(img):
        ratio = SB_TILE_H / img.height
        return img.resize((max(1, int(img.width * ratio)), SB_TILE_H))
    r2, s2 = fit(r), fit(s)
    gap = 20
    out = Image.new('RGB', (r2.width + gap + s2.width, SB_TILE_H + 50), 'white')
    d = ImageDraw.Draw(out)
    d.text((10, 8), 'RENDERED (current .mxl)', fill='black')
    d.text((r2.width + gap + 10, 8), 'SOURCE (PDF page crop)', fill='black')
    d.text((10, 30), label, fill='red')
    out.paste(r2, (0, 50))
    out.paste(s2, (r2.width + gap, 50))
    out.save(out_path)


def has_eighth_family(counts):
    """True if the duration counts include any 8th-note family member."""
    if not counts or 'error' in counts:
        return False
    return any(abs(d - 0.5) < 0.01 or d in {0.25, 0.375, 0.5625, 0.625, 0.75}
               for d in counts)


def is_suspicious(per_measure, counts, side_by_side_path):
    """Heuristic: exercise has 0 eighth notes AND the side-by-side
    image exists (i.e. we have a render to compare against the
    source). This catches the case where Audiveris transcribed
    every note as a quarter, when the source is all 8ths.
    """
    if per_measure is None:
        return 'PARSE_ERROR'
    if not counts:
        return 'NO_DURATIONS'
    if 'error' in counts:
        return 'PARSE_ERROR: ' + counts.get('error', '')
    if not has_eighth_family(counts):
        if side_by_side_path:
            return 'NO_8TH_NOTES (might be all quarters)'
    return ''


def main():
    if not RENDERS_DIR.is_dir() or not any(RENDERS_DIR.glob('*.png')):
        print(f'{RENDERS_DIR} not populated. Run `node render_all.mjs` first.',
              file=sys.stderr)
        sys.exit(1)
    if not IMG_DIR.is_dir():
        print(f'exercises_images/ not found', file=sys.stderr)
        sys.exit(1)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    pngs = sorted(IMG_DIR.glob('*.png'))
    print(f'Comparing {len(pngs)} exercises...')

    results = []
    t0 = time.time()
    for i, png in enumerate(pngs, 1):
        eid = int(png.stem)
        padded = f'{eid:04d}'
        mxl = MUSICXML_DIR / f'{padded}.mxl'
        render_path = RENDERS_DIR / f'{padded}.png'
        per_measure, flat, counts = get_durations(mxl)
        # Build the per-measure signature as a string (e.g. "4,4,4,4"
        # for four quarter notes per measure, or "0.5,0.5,1,0.5" for
        # a measure with two 8ths + quarter + 8th).
        if per_measure is not None:
            sig = ' | '.join(','.join(str(d) for d in m) for m in per_measure)
            eighth_count = sum(1 for d in (flat or []) if abs(d - 0.5) < 0.01)
            quarter_count = sum(1 for d in (flat or []) if abs(d - 1.0) < 0.01)
            half_count = sum(1 for d in (flat or []) if abs(d - 2.0) < 0.01)
            sixteenth_count = sum(1 for d in (flat or []) if abs(d - 0.25) < 0.01)
            other_count = len(flat or []) - eighth_count - quarter_count - half_count - sixteenth_count
        else:
            sig = ''
            eighth_count = quarter_count = half_count = sixteenth_count = other_count = 0
        # Side-by-side.
        sb_path = OUT_DIR / f'{padded}.png'
        if render_path.exists():
            try:
                make_side_by_side(render_path, png, sb_path,
                                   f'#{eid}  8th={eighth_count} qtr={quarter_count} half={half_count} 16th={sixteenth_count} other={other_count}')
            except Exception as e:
                print(f'  side-by-side failed for {eid}: {e}', file=sys.stderr)
                sb_path = None
        else:
            sb_path = None
        sb_relpath = str(sb_path) if sb_path else ''
        # Heuristic suspicion.
        reason = is_suspicious(per_measure, counts, sb_path)
        results.append({
            'id': eid,
            'measure_count': len(per_measure) if per_measure else 0,
            'note_count': len(flat or []),
            '8th': eighth_count,
            'qtr': quarter_count,
            'half': half_count,
            '16th': sixteenth_count,
            'other': other_count,
            'per_measure_sig': sig,
            'side_by_side': sb_relpath,
            'suspicious': reason,
        })
        if i % 50 == 0:
            print(f'  {i}/{len(pngs)}  elapsed={time.time() - t0:.0f}s',
                  file=sys.stderr)

    # Sort: suspicious first.
    results.sort(key=lambda r: (1 if r['suspicious'] else 0, r['id']))

    # Full CSV.
    fieldnames = ['id', 'measure_count', 'note_count', '8th', 'qtr', 'half',
                  '16th', 'other', 'per_measure_sig', 'side_by_side', 'suspicious']
    with open(OUT_FULL, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in results:
            w.writerow({k: r.get(k, '') for k in fieldnames})
    suspicious = [r for r in results if r['suspicious']]

    # Suspicious-only CSV.
    with open(OUT_SUSPICIOUS, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in suspicious:
            w.writerow({k: r.get(k, '') for k in fieldnames})

    print()
    print(f'Total: {len(results)}')
    print(f'Suspicious (no 8th notes): {len(suspicious)}')
    if suspicious:
        print()
        print('First 30:')
        for r in suspicious[:30]:
            print(f'  #{r["id"]:>4}  notes={r["note_count"]:>3}  '
                  f'8th={r["8th"]} qtr={r["qtr"]} half={r["half"]}  '
                  f'sig={r["per_measure_sig"][:60]}')
    print()
    print(f'Wrote: {OUT_FULL}')
    print(f'Wrote: {OUT_SUSPICIOUS}')
    print(f'Side-by-side images: {OUT_DIR}/  ({sum(1 for r in results if r["side_by_side"])} files)')


MUSICXML_DIR = ROOT / 'musicxml'  # used by get_durations()

if __name__ == '__main__':
    main()
