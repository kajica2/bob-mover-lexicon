#!/usr/bin/env python3
"""
Build chords.json by running Mac Vision OCR on each exercise's full
crop from the source PDF. The chord labels appear below each measure
in section 4 (cyclic progressions) and other section 4+ exercises
where harmonic context is shown.

Pipeline:
  1. Render every page that contains an exercise with chord labels at 600 DPI.
  2. For each exercise, OCR its full crop_box region.
  3. Filter OCR output: drop titles, page numbers, qualifiers like
     "(major or minor)"; keep chord-like tokens.
  4. Sort by (y descending, x ascending) to get chord progression.
  5. Apply chord-name cleanup (g->9, Domaj->Dbmaj, etc.).
  6. Save chords.json with { exerciseId: [chord, chord, ...] }.

Note: the committed .mxl files are not modified; the server injects
the chord data at serve time.
"""
import json, os, re, subprocess, sys
from collections import defaultdict
from PIL import Image
from pathlib import Path

ROOT = Path('/Users/kaidejuricmasscmbook/GrokDesk/bob-mover-lexicon-push')
SRC = Path('/Users/kaidejuricmasscmbook/Downloads/Bob_Mover_Jazz_Lexicon_-_2nd_Edition.pdf')
OUT = ROOT / 'chords.json'

# Vision request Swift shim — uses Apple's Vision framework for OCR,
# which is much better at reading the Bob Mover music-font chord
# labels than tesseract (which trips on italic stems and the music
# font's flat-symbol style). Written to a temp .swift file on first
# call so we don't need a separate checked-in file.
_VISION_SHIM_SOURCE = """import Foundation
import Vision
import AppKit

let arg = CommandLine.arguments[1]
let url = URL(fileURLWithPath: arg)
guard let img = NSImage(contentsOf: url),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  print("ERROR loading image"); exit(1)
}
let req = VNRecognizeTextRequest { request, error in
  guard let observations = request.results as? [VNRecognizedTextObservation] else { return }
  for obs in observations {
    if let top = obs.topCandidates(1).first {
      let bb = obs.boundingBox
      print("\\(bb.origin.y),\\(bb.origin.x): \\(top.string)")
    }
  }
}
do {
  let handler = VNImageRequestHandler(cgImage: cg, options: [:])
  try handler.perform([req])
} catch {
  print("ERROR: \\(error)"); exit(1)
}
"""
_VISION_SHIM_PATH = None

# Chord regex: C, D, E, F, G, A, B + optional #/b + chord quality (m, maj7, 7,
# m7, dim, dim7, alt, sus, etc.) + optional extensions (b9, #9, b13).
# Allow qualifiers like "(major or minor)" as separate annotations.
CHORD_RE = re.compile(
    r'^([A-G])([#b]?)(m(aj7?|in7)?|maj7?|min7?|\+|dim7?|[0-9]?|sus4?)?(b9|#9|#11|b13|\(.*\))?$',
    re.IGNORECASE,
)

# Things to drop from OCR output:
SKIP_PATTERNS = [
    re.compile(r'^#?\d{3}\b'),     # "##262" / "#262" / "#262 V7 to I..."
    re.compile(r'^Continue'),
    re.compile(r'^ETC\b', re.IGNORECASE),
    re.compile(r'^\d+\.?$'),          # bare numbers (page footer)
    re.compile(r'^(major|minor)\s*$', re.IGNORECASE),
    re.compile(r'^bobod', re.IGNORECASE),  # garbled "Move" or text
    re.compile(r'^Continue through'),
    re.compile(r'^\(.*\)$'),          # qualifier like "(major or minor)" by itself
]

# Common OCR error fixes (applied after stripping)
CHORD_FIXES = {
    'g': '9',
    'Domaj': 'Dbmaj',
    'Bomajg': 'Bbmaj9',
    'Bomaj9': 'Bbmaj9',
    'Bomaj7': 'Bbmaj7',
    'Bom7': 'Bbm7',
    'Gomaj7': 'Gbmaj7',
    'Gomaj': 'Gbmaj',
    'Calt': 'C7alt',
    'C7alt': 'C7alt',
    'Fmaj/': 'Fmaj7',
}


def is_chord(text):
    """Return True if text is a chord-like token."""
    t = text.strip()
    if not t:
        return False
    for pat in SKIP_PATTERNS:
        if pat.search(t):
            return False
    # Strip "(major or minor)" qualifier if present
    base = re.sub(r'\s*\(.*\)\s*$', '', t).strip()
    # Allow compound chord names up to ~14 chars
    if len(base) > 14 or len(base) < 1:
        return False
    # Must start with a letter A-G
    if not re.match(r'^[A-G]', base):
        return False
    # Apply OCR error fixes
    if base in CHORD_FIXES:
        return True
    # Accept if base looks like a chord:
    #   root: A-G + optional #/b
    #   quality: (optional) — single letter (m), 2-4 letters (maj, min, dim,
    #     sus, alt), 1-2 digits (7, 9, 11, 13), or compound (maj7, maj9, m7,
    #     m11, etc.)
    #   extension: (optional) — #11, b9, #13, etc.
    if re.match(
        r'^[A-G][#b]?'
        r'(maj[0-9]*|min[0-9]*|m[0-9]*|dim[0-9]*|sus[24]?|[0-9]+|alt)*'
        r'([#b][0-9]+)?$',
        base, re.IGNORECASE,
    ):
        return True
    return False


def fix_chord(text):
    """Apply OCR-error fixes; return the cleaned chord string."""
    t = text.strip()
    return CHORD_FIXES.get(t, t)


def page_image(page, dpi=600):
    """Render a single page of the source PDF at high DPI."""
    out_dir = Path('/tmp/chord-build')
    out_dir.mkdir(exist_ok=True)
    # pdftoppm appends -{page:03d}.png to the prefix; e.g. prefix=p76 -> p76-076.png
    out = out_dir / f'p{page}-{page:03d}.png'
    if not out.exists():
        subprocess.run(
            ['pdftoppm', '-r', str(dpi), '-f', str(page), '-l', str(page), '-png', str(SRC), str(out_dir / f'p{page}')],
            check=True,
        )
    return Image.open(out)


def ocr_image(path):
    """Run Mac Vision OCR on an image and return sorted observations
    as [(y_norm, x_norm, text), ...] sorted top-to-bottom, left-to-right."""
    r = subprocess.run(
        ['swift', 'vision-test.swift', str(path)],
        capture_output=True, text=True, timeout=60,
    )
    obs = []
    for line in r.stdout.strip().splitlines():
        # Format: "y,x: text"
        m = re.match(r'^([\d.]+),([\d.]+): (.+)$', line)
        if not m:
            continue
        y, x, text = float(m.group(1)), float(m.group(2)), m.group(3).strip()
        obs.append((y, x, text))
    # Sort top-to-bottom (y descending in Vision coords) then left-to-right.
    obs.sort(key=lambda o: (-o[0], o[1]))
    return obs


def chords_for_exercise(ex, full_img):
    """Crop the exercise from the full page image and OCR for chord labels."""
    PX = 600 / 72.0
    y1 = int(ex['crop_box_pts'][1] * PX)
    y2 = int(ex['crop_box_pts'][3] * PX)
    crop = full_img.crop((0, y1, full_img.width, y2))
    # Save to temp file for Vision OCR
    crop_path = Path(f'/tmp/chord-build/crop_{ex["id"]}.png')
    crop.save(crop_path)
    obs = ocr_image(crop_path)
    # Filter to chord tokens, dedupe consecutive duplicates (same chord on
    # both systems of a 2-line exercise), preserve order.
    result = []
    prev = None
    for y, x, text in obs:
        if not is_chord(text):
            continue
        c = fix_chord(text)
        if c == prev:
            continue
        result.append(c)
        prev = c
    return result


def main():
    exercises = json.load(open(ROOT / 'exercises.json'))['exercises']
    # Group by page
    by_page = defaultdict(list)
    for e in exercises:
        by_page[e['page']].append(e)

    chords = {}
    total = len(exercises)
    print(f'Building chords.json for {total} exercises across {len(by_page)} pages')

    for page, exs in sorted(by_page.items()):
        print(f'  page {page}: {len(exs)} exercises')
        try:
            img = page_image(page)
        except Exception as e:
            print(f'    page render failed: {e}')
            continue
        for ex in sorted(exs, key=lambda x: x['crop_box_pts'][1]):
            cs = chords_for_exercise(ex, img)
            if cs:
                chords[ex['id']] = cs
                print(f'    ex {ex["id"]:3d}: {cs}')

    # Save
    OUT.write_text(json.dumps(chords, indent=2))
    print(f'\nSaved {len(chords)}/{total} exercises with chords to {OUT}')


if __name__ == '__main__':
    main()
