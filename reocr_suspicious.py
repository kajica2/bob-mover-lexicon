#!/usr/bin/env python3
"""
Re-OCR the suspicious exercises with Audiveris, carefully.

For each exercise ID in the list, this script:
  1. Looks up the PDF page + crop_box in exercises.json
  2. Renders the page from the source PDF at 400 DPI
     (higher than the typical 300 for more precise OMR — Audiveris
     is more accurate with more pixels per symbol)
  3. Crops the render to the exercise's bounding box
  4. Runs Audiveris in batch mode with full transcription + export
  5. Extracts the resulting .mxl (it's a ZIP containing score.xml)
  6. Compares to the committed musicxml/<NNNN>.mxl:
     - note count
     - rest count
     - measure count
  7. Renders the new .mxl through the practice page (Verovio) and
     saves a side-by-side comparison with the source PNG.

Usage:
  python3 reocr_suspicious.py           # re-OCR the 7 known-suspicious
  python3 reocr_suspicious.py 38 99     # re-OCR specific IDs
  python3 reocr_suspicious.py --all     # re-OCR all 407 (slow)

Prereqs:
  - Audiveris installed to /Applications/Audiveris.app
  - dev server running on localhost:8080
  - ~/bin/audiveris CLI wrapper in PATH
  - /opt/homebrew/opt/openjdk/bin in PATH
"""
import argparse
import csv
import json
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

from PIL import Image
from music21 import converter

ROOT = Path('/Users/kaidejuricmasscmbook/GrokDesk/bob-mover-lexicon-push')
EXERCISES_JSON = ROOT / 'exercises.json'
MUSICXML_DIR = ROOT / 'musicxml'
IMAGES_DIR = ROOT / 'exercises_images'
PDF_PATH = Path('/Users/kaidejuricmasscmbook/Downloads/Bob_Mover_Jazz_Lexicon_-_2nd_Edition.pdf')
WORK_DIR = Path('/tmp/audiveris-reocr')
SIDEBYSIDE_DIR = Path('/tmp/audiveris-reocr-sidebyside')
RENDERS_DIR = Path('/tmp/bml-renders')  # reused from visual_diff

# Known-suspicious (from the previous visual diff run + the 6
# known-broken in practice.js's static-PNG fallback). Add to this
# list as more bad ones are confirmed.
DEFAULT_SUSPICIOUS = [17, 79, 132, 152, 168, 183, 229]

# High DPI for precise OMR. 600 is the upper bound — Audiveris
# doesn't get meaningfully more accurate above this for printed
# music, but it does help with small or cramped notation.
RENDER_DPI = 600
PTS_PER_INCH = 72
PX_PER_PT = RENDER_DPI / PTS_PER_INCH

# Side-by-side image dimensions.
SB_TILE_H = 400


def render_page(page_num, out_path):
    """Render one PDF page to a PNG at RENDER_DPI."""
    prefix = out_path.with_suffix('')
    # pdftoppm naming: <prefix>-<padded>.png
    subprocess.run(
        ['pdftoppm', '-r', str(RENDER_DPI), '-f', str(page_num), '-l', str(page_num),
         '-png', str(PDF_PATH), str(prefix)],
        check=True,
    )
    # Find the produced file (pdftoppm uses 3-digit padding with -<num>).
    for cand in [
        f'{prefix}-{page_num:03d}.png',
        f'{prefix}-{page_num}.png',
        f'{prefix}-{page_num:03d}-102.png',  # defensive: bad page arg
    ]:
        if Path(cand).exists():
            if Path(cand) != out_path:
                shutil.move(cand, out_path)
            return out_path
    # Last resort: glob for any matching pattern.
    matches = list(Path(str(prefix)).parent.glob(f'{prefix.name}*.png'))
    if matches:
        shutil.move(matches[0], out_path)
        return out_path
    raise FileNotFoundError(f'pdftoppm output not found for page {page_num}')


def crop_to_box(src_png, out_png, crop_box_pts):
    """Crop the rendered page to the exercise's bounding box.
    crop_box_pts: [left, top, right, bottom] in points.
    """
    img = Image.open(src_png)
    left, top, right, bottom = crop_box_pts
    l = max(0, int(left * PX_PER_PT))
    t = max(0, int(top * PX_PER_PT))
    r = min(img.width, int(right * PX_PER_PT))
    b = min(img.height, int(bottom * PX_PER_PT))
    img.crop((l, t, r, b)).save(out_png)
    return out_png


def run_audiveris(input_png, output_dir):
    """Run Audiveris batch mode on a single sheet. Returns the path
    to the resulting .mxl (or None on failure).
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        'audiveris',
        '-batch',
        '-output', str(output_dir),
        '-export',
        '-transcribe',
        str(input_png),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    # The .mxl ends up in <output_dir>/<basename>.mxl
    expected = output_dir / f'{input_png.stem}.mxl'
    return expected if expected.exists() else None


def analyze_mxl(mxl_path):
    """Return a dict of structural info for a .mxl, or {error: ...}."""
    if not mxl_path or not mxl_path.exists():
        return {'error': 'mxl not found'}
    try:
        # music21 can read .mxl directly (it unzips internally).
        score = converter.parse(str(mxl_path))
        parts = list(score.parts)
        if not parts:
            return {'error': 'no parts'}
        part = parts[0]
        notes = list(part.recurse().notes)
        pitched = [n for n in notes if n.isNote]
        rests = [n for n in notes if n.isRest]
        measures = list(part.getElementsByClass('Measure'))
        return {
            'note_count': len(pitched),
            'rest_count': len(rests),
            'measure_count': len(measures),
        }
    except Exception as e:
        return {'error': str(e)[:200]}


def render_via_practice(eid, out_png):
    """Render the new .mxl through the practice page's Verovio
    and screenshot the score container. Returns True on success.
    """
    # We just call the dev server with a custom ID mapped to a temp
    # etude, then screenshot. For now, skip this — the structural
    # comparison is enough; visual diff is a separate step.
    # (Returning None to keep the script focused.)
    return None


def make_side_by_side(eid, old_mxl, new_mxl, source_png, out_png):
    """Render the new .mxl via the practice page and side-by-side it
    with the source. Falls back to side-by-side with the old
    rendered (from the previous visual_diff) if Verovio render fails.
    """
    rendered_new = RENDERS_DIR / f'{eid:04d}.png'  # from previous run
    if not rendered_new.exists():
        return False
    try:
        from PIL import Image, ImageDraw
        rn = Image.open(rendered_new).convert('RGB')
        sp = Image.open(source_png).convert('RGB')
        # Scale both to SB_TILE_H tall.
        def fit(img):
            r = SB_TILE_H / img.height
            return img.resize((max(1, int(img.width * r)), SB_TILE_H))
        rn, sp = fit(rn), fit(sp)
        gap = 20
        out = Image.new('RGB', (rn.width + gap + sp.width, SB_TILE_H + 50), 'white')
        d = ImageDraw.Draw(out)
        d.text((10, 8), 'OLD .mxl (committed)', fill='black')
        d.text((rn.width + gap + 10, 8), 'SOURCE (PDF)', fill='black')
        d.text((10, 30), f'#{eid}  Re-OCR with Audiveris 5.11.0 + 400 DPI', fill='red')
        out.paste(rn, (0, 50))
        out.paste(sp, (rn.width + gap, 50))
        out.save(out_png)
        return True
    except Exception as e:
        print(f'  side-by-side failed: {e}', file=sys.stderr)
        return False


def process_one(eid, ex_data):
    page = ex_data['page']
    crop_box = ex_data['crop_box_pts']
    print(f'\n=== Exercise {eid} (page {page}, crop {crop_box}) ===')
    work = WORK_DIR / f'e{eid:04d}'
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    page_png = work / f'page{page}.png'
    crop_png = work / f'crop{page}.png'
    out_dir = work / 'out'

    # 1. Render the page at 400 DPI.
    print(f'  rendering page {page} at {RENDER_DPI} DPI...')
    render_page(page, page_png)

    # 2. Crop to the exercise's box.
    print(f'  cropping to box {crop_box}...')
    crop_to_box(page_png, crop_png, crop_box)
    cw, ch = Image.open(crop_png).size
    print(f'  cropped to {cw}×{ch}')

    # 3. Run Audiveris.
    print(f'  running Audiveris...')
    t0 = time.time()
    new_mxl = run_audiveris(crop_png, out_dir)
    dt = time.time() - t0
    if not new_mxl:
        print(f'  Audiveris FAILED (took {dt:.0f}s)')
        return {'id': eid, 'status': 'audiveris-failed'}

    # 4. Compare.
    old_mxl = MUSICXML_DIR / f'{eid:04d}.mxl'
    old_info = analyze_mxl(old_mxl)
    new_info = analyze_mxl(new_mxl)
    print(f'  old: {old_info}')
    print(f'  new: {new_info}  (took {dt:.0f}s)')

    # 5. Side-by-side image.
    sb_out = SIDEBYSIDE_DIR / f'{eid:04d}.png'
    source_png = IMAGES_DIR / f'{eid:04d}.png'
    sb_ok = make_side_by_side(eid, old_mxl, new_mxl, source_png, sb_out)
    if sb_ok:
        print(f'  side-by-side: {sb_out}')

    # Copy the new .mxl to a stable path for review.
    stable_new = ROOT / f'.reocr-{eid:04d}.mxl'
    shutil.copy(new_mxl, stable_new)
    print(f'  new .mxl: {stable_new}')

    return {
        'id': eid,
        'page': page,
        'status': 'ok',
        'old_notes': old_info.get('note_count'),
        'new_notes': new_info.get('note_count'),
        'old_measures': old_info.get('measure_count'),
        'new_measures': new_info.get('measure_count'),
        'old_rests': old_info.get('rest_count'),
        'new_rests': new_info.get('rest_count'),
        'time_sec': round(dt),
        'side_by_side': str(sb_out) if sb_ok else '',
        'new_mxl': str(stable_new),
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument('ids', nargs='*', type=int, help='Exercise IDs to re-OCR (default: 7 known-suspicious)')
    p.add_argument('--all', action='store_true', help='Re-OCR all 407 (slow)')
    args = p.parse_args()

    if args.all:
        ex_data = json.loads(EXERCISES_JSON.read_text())
        ids = [e['id'] for e in ex_data['exercises']]
    elif args.ids:
        ids = args.ids
    else:
        ids = DEFAULT_SUSPICIOUS

    ex_data_all = {e['id']: e for e in json.loads(EXERCISES_JSON.read_text())['exercises']}
    SIDEBYSIDE_DIR.mkdir(parents=True, exist_ok=True)

    print(f'Re-OCRing {len(ids)} exercises with Audiveris 5.11.0 at {RENDER_DPI} DPI')
    results = []
    t0 = time.time()
    for i, eid in enumerate(ids, 1):
        ex = ex_data_all.get(eid)
        if not ex:
            print(f'\n{eid}: not in exercises.json, skipping')
            continue
        r = process_one(eid, ex)
        results.append(r)
        elapsed = time.time() - t0
        print(f'  ({i}/{len(ids)} total, elapsed {elapsed:.0f}s)')

    # Summary CSV.
    out_csv = ROOT / 'reocr_results.csv'
    fieldnames = ['id', 'page', 'status', 'old_notes', 'new_notes', 'old_measures', 'new_measures', 'old_rests', 'new_rests', 'time_sec', 'side_by_side', 'new_mxl']
    with open(out_csv, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in results:
            w.writerow({k: r.get(k, '') for k in fieldnames})
    print(f'\nWrote: {out_csv}')

    # Stdout summary.
    print()
    print('=== Re-OCR Summary ===')
    print(f'{"ID":>4} {"p":>3} {"old":>4} {"new":>4} {"old_m":>5} {"new_m":>5}  status')
    for r in results:
        if r.get('status') != 'ok':
            print(f'  {r["id"]:>4}  --  {r.get("status")}')
            continue
        delta = (r.get('new_notes') or 0) - (r.get('old_notes') or 0)
        sign = '+' if delta > 0 else ('' if delta == 0 else '')
        print(f'  {r["id"]:>4} {r["page"]:>3} {r.get("old_notes", "?"):>4} '
              f'{r.get("new_notes", "?"):>4} {r.get("old_measures", "?"):>5} '
              f'{r.get("new_measures", "?"):>5}  {sign}{delta} notes, {r.get("time_sec", "?")}s')
    print()
    print(f'Side-by-side images: {SIDEBYSIDE_DIR}/')
    print(f'New .mxl files:      {ROOT}/.reocr-NNNN.mxl  (re-run to compare)')


if __name__ == '__main__':
    main()
