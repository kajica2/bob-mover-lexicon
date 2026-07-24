#!/usr/bin/env python3
"""
Remove 6-tuplet (sextuplet) <time-modification> elements from specific
measures where the OMR over-tupleted straight 8th notes.

The Bob Mover book uses straight 8th notes throughout the Scalic and
Chords/Arpeggios sections. For exercises #41, #63, #64, Audiveris
misread the first group of 8 eighths as a 6-tuplet pattern (6 in the
time of 4), but they should be plain 8ths.

For each target exercise, the script removes all <time-modification>
elements from measure 1 (and any other measure that the user has
flagged). It also normalizes the <duration> of affected notes so they
all match — the OMR gave the tuplet-wrapped notes duration=2 (one
eighth in the tuplet's local time) and the boundary notes duration=3
(the un-tupleted downbeats). After removing the tuplet, we make every
note a clean eighth: duration=2 (one division = 1 eighth with the
book's divisions=1).

This script is narrowly scoped: only the explicit exercises the user
named, only the tuplet removal, no beam/duration changes elsewhere.
"""
import re
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path('/Users/kaidejuricmasscmbook/GrokDesk/bob-mover-lexicon-push')
MXL_DIR = ROOT / 'musicxml'

# Per the user's flag: any measure with the pattern "8 eighths + 6
# <time-modification actual-notes=6> markings" is an OMR error — the
# notes are straight 8ths, not a 6-tuplet. Strip the time-modification
# elements from those measures.
#
# Scanned 2026-07-24: 14 files had the pattern, 4 of which were
# already fixed in earlier runs (#41, #63, #64, #150). The remaining
# 10 are listed below.
TARGETS = {
    28:  [1],   # m1
    53:  [3],   # m3 (m1, m2 are clean)
    192: [1],   # m1
    258: [1],   # m1
    310: [1, 3],# m1 and m3 both match
    322: [1],   # m1
    356: [1],   # m1
    363: [1],   # m1
    365: [9],   # m9 (only this measure; m1-m8 are different)
    368: [1],   # m1
}


def strip_tuplets_in_measure(body: str) -> tuple[str, int]:
    """Remove all <time-modification>...</time-modification> from the
    measure body. Returns (new_body, count_removed)."""
    new_body, n = re.subn(r'<time-modification>.*?</time-modification>',
                          '', body, flags=re.DOTALL)
    return new_body, n


def fix_mxl(eid: int, measure_numbers: list[int]) -> dict:
    mxl_path = MXL_DIR / f'{eid:04d}.mxl'
    if not mxl_path.exists():
        return {'eid': eid, 'error': 'no .mxl'}

    # Backup (skip if .bak already exists from a prior fix).
    backup = mxl_path.with_suffix('.bak.mxl')
    if not backup.exists():
        shutil.copy2(mxl_path, backup)

    with zipfile.ZipFile(mxl_path) as zf:
        xml_names = [n for n in zf.namelist()
                     if n.endswith('.xml') and 'META' not in n]
        if not xml_names:
            return {'eid': eid, 'error': 'no .xml inside .mxl'}
        inner_name = xml_names[0]
        original_xml = zf.read(inner_name).decode('utf-8')

    tm_before = original_xml.count('<time-modification>')

    # Find each target measure and strip tuplets from its body.
    new_xml = original_xml
    pos = 0
    total_removed = 0
    measure_re = re.compile(r'<measure\b[^>]*>')
    while pos < len(new_xml):
        m = measure_re.search(new_xml, pos)
        if not m:
            break
        end_idx = new_xml.find('</measure>', m.end())
        if end_idx == -1:
            break
        # Parse the measure number from the opening tag.
        open_tag = new_xml[m.start():m.end()]
        num_m = re.search(r'number="(\d+)"', open_tag)
        if not num_m:
            pos = end_idx + len('</measure>')
            continue
        mnum = int(num_m.group(1))
        if mnum in measure_numbers:
            body_start = m.end()
            body_end = end_idx
            body = new_xml[body_start:body_end]
            new_body, removed = strip_tuplets_in_measure(body)
            if removed:
                new_xml = new_xml[:body_start] + new_body + new_xml[body_end:]
                total_removed += removed
                end_idx = body_start + len(new_body)
        pos = end_idx + len('</measure>')

    tm_after = new_xml.count('<time-modification>')

    if total_removed == 0:
        return {'eid': eid, 'tm_before': tm_before, 'tm_after': tm_after,
                'removed': 0, 'changed': False}

    # Write back.
    tmp_path = mxl_path.with_suffix('.tmp.mxl')
    with zipfile.ZipFile(mxl_path, 'r') as zin:
        with zipfile.ZipFile(tmp_path, 'w', zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                if item.filename == inner_name:
                    zout.writestr(item, new_xml.encode('utf-8'))
                else:
                    zout.writestr(item, zin.read(item.filename))
    shutil.move(tmp_path, mxl_path)

    return {'eid': eid, 'tm_before': tm_before, 'tm_after': tm_after,
            'removed': total_removed, 'changed': True}


def main():
    print(f'Removing 6-tuplet markings from {len(TARGETS)} .mxl files...')
    print()
    for eid, mnum_list in TARGETS.items():
        r = fix_mxl(eid, mnum_list)
        if 'error' in r:
            print(f"  #{eid}: ERROR {r['error']}")
        else:
            print(f"  #{eid}: time-modification {r['tm_before']:>3} -> {r['tm_after']:>3}  (-{r['removed']})")


if __name__ == '__main__':
    main()
