#!/usr/bin/env python3
"""
Compare rendered screenshots (from render_all.mjs) against the
source PDF page crops and flag exercises where the rendered score
looks suspiciously different from the source.

Prereq:
  - dev server running on localhost:8080
  - node render_all.mjs   # populates /tmp/bml-renders/

What this catches (and doesn't):
  - CATCHES: gross transcription errors — empty/missing measures,
    very different note counts, completely different layouts. The
    6 known-broken exercises (17, 79, 132, 152, 168, 229 — see
    practice.js's static-PNG fallback) are detected this way.
  - DOESN'T CATCH: pitch-level errors where Audiveris transcribed
    the right number of notes but the wrong notes (e.g. exercise
    #38 from the user's report — 5 measures × 8 notes, but the
    pitches don't match the source). For these you need either
    visual inspection or a re-OCR with Audiveris.

Heuristics:
  - Crop both images to their non-white content bounding box.
  - Resize to a fixed comparison box.
  - Compute Mean Squared Error (MSE) of the pixel diff.
  - Anything more than SUSPICION_SIGMA std devs above the mean
    MSE is flagged — most exercises have similar MSE (same
    notation engine, same source style), so outliers are
    mis-transcriptions.

Outputs:
  - visual_diff_results.csv: every exercise with its MSE
  - visual_diff_suspicious.csv: only the flagged ones
  - /tmp/bml-sidebyside/<id>.png: top-N side-by-side images
    (rendered | source) for manual inspection
"""
import csv
import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
import numpy as np

ROOT = Path('/Users/kaidejuricmasscmbook/GrokDesk/bob-mover-lexicon-push')
IMG_DIR = ROOT / 'exercises_images'
RENDERS_DIR = Path('/tmp/bml-renders')
SIDEBYSIDE_DIR = Path('/tmp/bml-sidebyside')
OUT_FULL = ROOT / 'visual_diff_results.csv'
OUT_SUSPICIOUS = ROOT / 'visual_diff_suspicious.csv'
RENDER_W = 1200
SUSPICION_SIGMA = 2.0
SIDE_BY_SIDE_TOP_N = 50
# Known-broken exercises (per practice.js:fill_empty_measures
# comment + the static-PNG fallback in renderAtScale). These
# always get a side-by-side image so the user can see them
# without relying on the MSE heuristic.
KNOWN_BROKEN = {17, 79, 132, 152, 168, 229}


def crop_to_content(img, threshold=240):
    arr = np.array(img)
    mask = arr < threshold
    rows = np.any(mask, axis=1)
    cols = np.any(mask, axis=0)
    if not rows.any() or not cols.any():
        return img
    rmin, rmax = np.where(rows)[0][[0, -1]]
    cmin, cmax = np.where(cols)[0][[0, -1]]
    rmin = max(0, rmin - 4)
    cmin = max(0, cmin - 4)
    rmax = min(arr.shape[0] - 1, rmax + 4)
    cmax = min(arr.shape[1] - 1, cmax + 4)
    return img.crop((cmin, rmin, cmax + 1, rmax + 1))


def resize_to(img, w, h):
    return img.resize((w, h), Image.LANCZOS)


def mse(a, b):
    arr_a = np.array(a, dtype=np.float32)
    arr_b = np.array(b, dtype=np.float32)
    return float(np.mean((arr_a - arr_b) ** 2))


def side_by_side(rendered_path, source_path, out_path, label):
    """Save a side-by-side image (rendered | source) at out_path."""
    r = Image.open(rendered_path).convert('RGB')
    s = Image.open(source_path).convert('RGB')
    # Same height for both.
    H = max(r.height, s.height)
    r = r.resize((int(r.width * H / r.height), H))
    s = s.resize((int(s.width * H / s.height), H))
    gap = 16
    out = Image.new('RGB', (r.width + gap + s.width, H + 40), 'white')
    d = ImageDraw.Draw(out)
    d.text((10, 6), 'RENDERED (current .mxl)', fill='black')
    d.text((r.width + gap + 10, 6), 'SOURCE (PDF page crop)', fill='black')
    d.text((10, 22), label, fill='red')
    out.paste(r, (0, 40))
    out.paste(s, (r.width + gap, 40))
    out.save(out_path)


def main():
    if not RENDERS_DIR.is_dir():
        print(f'{RENDERS_DIR} not found. Run `node render_all.mjs` first.', file=sys.stderr)
        sys.exit(1)
    if not IMG_DIR.is_dir():
        print(f'exercises_images/ not found at {IMG_DIR}', file=sys.stderr)
        sys.exit(1)

    SIDEBYSIDE_DIR.mkdir(parents=True, exist_ok=True)

    pngs = sorted(IMG_DIR.glob('*.png'))
    print(f'Comparing {len(pngs)} exercises...')

    results = []
    t0 = time.time()
    for i, png in enumerate(pngs, 1):
        eid = int(png.stem)
        padded = f'{eid:04d}'
        render_path = RENDERS_DIR / f'{padded}.png'
        if not render_path.exists():
            results.append({'id': eid, 'mse': None, 'error': 'no render'})
            continue
        try:
            rendered = Image.open(render_path).convert('L')
            source = Image.open(png).convert('L')
        except Exception as e:
            results.append({'id': eid, 'mse': None, 'error': str(e)[:200]})
            continue
        r_crop = crop_to_content(rendered)
        s_crop = crop_to_content(source)
        target_w = RENDER_W
        ratio = target_w / max(s_crop.width, 1)
        target_h = max(1, int(s_crop.height * ratio))
        r_resized = resize_to(r_crop, target_w, target_h)
        s_resized = resize_to(s_crop, target_w, target_h)
        score = mse(r_resized, s_resized)
        results.append({'id': eid, 'mse': round(score, 1), 'error': ''})
        if i % 50 == 0:
            elapsed = time.time() - t0
            print(f'  {i}/{len(pngs)}  elapsed={elapsed:.0f}s', file=sys.stderr)

    valid = [r['mse'] for r in results if r['mse'] is not None]
    if not valid:
        print('No valid results. Did render_all.mjs run successfully?', file=sys.stderr)
        sys.exit(1)
    mean = float(np.mean(valid))
    std = float(np.std(valid))
    threshold = mean + SUSPICION_SIGMA * std

    for r in results:
        eid = r['id']
        reasons = []
        if r['mse'] is None:
            reasons.append(r['error'] or 'RENDER_FAILED')
        elif r['mse'] > threshold:
            reasons.append(f'MSE>{threshold:.0f}')
        if eid in KNOWN_BROKEN:
            reasons.append('KNOWN_BROKEN (practice.js static-PNG fallback)')
        r['suspicious'] = '; '.join(reasons) if reasons else ''

    # Sort: suspicious first, then by MSE desc.
    results.sort(key=lambda r: (1 if r['suspicious'] else 0, -(r['mse'] or 0)))

    fieldnames = ['id', 'mse', 'suspicious', 'error']
    with open(OUT_FULL, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in results:
            w.writerow({k: r.get(k, '') for k in fieldnames})
    suspicious = [r for r in results if r['suspicious']]
    with open(OUT_SUSPICIOUS, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in suspicious:
            w.writerow({k: r.get(k, '') for k in fieldnames})

    # Build side-by-side images for the top N (by MSE) plus all
    # known-broken. These let the user flip through /tmp/bml-sidebyside/
    # and visually spot the worst ones.
    sb_candidates = sorted(
        [r for r in results if r['mse'] is not None],
        key=lambda r: -(r['mse'] or 0)
    )[:SIDE_BY_SIDE_TOP_N]
    # Also include all known-broken (in case they don't appear in the top N).
    for eid in KNOWN_BROKEN:
        if not any(r['id'] == eid for r in sb_candidates):
            extra = next((r for r in results if r['id'] == eid), None)
            if extra:
                sb_candidates.append(extra)

    print(f'\nBuilding {len(sb_candidates)} side-by-side images in {SIDEBYSIDE_DIR}...')
    for r in sb_candidates:
        eid = r['id']
        padded = f'{eid:04d}'
        rp = RENDERS_DIR / f'{padded}.png'
        sp = IMG_DIR / f'{padded}.png'
        if not rp.exists() or not sp.exists():
            continue
        label = f"#{eid}  MSE={r['mse']:.0f}  {'KNOWN-BROKEN' if eid in KNOWN_BROKEN else ''}"
        out = SIDEBYSIDE_DIR / f'{padded}.png'
        try:
            side_by_side(rp, sp, out, label)
        except Exception as e:
            print(f'  side-by-side failed for {eid}: {e}')

    print()
    print(f'Total: {len(results)}')
    print(f'Valid: {len(valid)}')
    print(f'  MSE mean:  {mean:.0f}')
    print(f'  MSE std:   {std:.0f}')
    print(f'  Threshold: {threshold:.0f}  (mean + {SUSPICION_SIGMA}σ)')
    print(f'Suspicious: {len(suspicious)}')
    if suspicious:
        print()
        print('Worst 30 (highest MSE first):')
        for r in suspicious[:30]:
            print(f'  #{r["id"]:>4}  MSE={r["mse"]:<7}  {r["suspicious"]}')
    print()
    print(f'Wrote: {OUT_FULL}')
    print(f'Wrote: {OUT_SUSPICIOUS}')
    print(f'Side-by-side images: {SIDEBYSIDE_DIR}/  ({len(sb_candidates)} files)')


if __name__ == '__main__':
    main()
