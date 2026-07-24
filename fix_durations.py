#!/usr/bin/env python3
"""
Hand-fix the 8 .mxl files whose durations are wrong (all notes rendered
as quarters when they should be 8ths or 8th-tuplets).

For each exercise:
  1. Load the .mxl via music21
  2. Iterate the notes, change quarter → eighth (and add <time-modification>
     for tuplets) based on a per-exercise rule
  3. Write back, re-render, re-compare

The plan: per-exercise (id, target_dur, tuplet) tuples. For simple cases
(all notes change), just iterate; for mixed cases, do per-measure.
"""
import re
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

from music21 import converter, stream, duration as m21dur, note as m21note

ROOT = Path('/Users/kaidejuricmasscmbook/GrokDesk/bob-mover-lexicon-push')
MXL_DIR = ROOT / 'musicxml'
RENDER_DIR = Path('/tmp/bml-renders')
OUT_DIR = Path('/tmp/bml-book-compare')

# Per-exercise fix. Each entry is:
#   eid: exercise id
#   rule: 'all_quarter_to_eighth'  — every note in the piece becomes an 8th
#         'all_quarter_to_eighth_triplet'  — every note becomes an 8th triplet
#         'all_quarter_to_eighth_quintuplet'  — every note becomes an 8th quintuplet
#         'all_quarter_to_eighth_sextuplet'  — every note becomes an 8th sextuplet
# Notes:
#   - We don't need to touch the <duration> tag because the practice-page
#     player uses <type>-based durations (v28) and will compute the
#     quarterLength correctly via music21 on the client.
#   - We DO add <time-modification> for tuplets so the printed notation
#     shows the tuplet bracket.

FIX_PLAN = [
    {'eid': 9,   'rule': 'all_quarter_to_eighth'},  # Chromatic permutation
    {'eid': 146, 'rule': 'all_quarter_to_eighth_triplet'},  # Augmented triads, 3rds
    {'eid': 174, 'rule': 'all_quarter_to_eighth'},  # V 7+5 permutation
    {'eid': 236, 'rule': 'all_quarter_to_eighth_quintuplet'},  # Diminished 7th + neighbor, 5-tuplets
    {'eid': 318, 'rule': 'all_quarter_to_eighth_triplet'},  # 4th pattern, II V
    {'eid': 319, 'rule': 'all_quarter_to_eighth_triplet'},  # Descending 4th pattern, II V
    {'eid': 337, 'rule': 'all_quarter_to_eighth_triplet'},  # Minor triads tritone
    {'eid': 387, 'rule': 'all_quarter_to_eighth_sextuplet'},  # Dominant 13b9, 6-tuplets
]


def fix_mxl(eid, rule):
    mxl_path = MXL_DIR / f'{eid:04d}.mxl'
    if not mxl_path.exists():
        print(f'  {eid}: no .mxl')
        return False
    # Backup first.
    backup = mxl_path.with_suffix('.bak.mxl')
    if not backup.exists():
        shutil.copy2(mxl_path, backup)
    # Read raw XML (don't use music21 to write — it re-serializes the whole
    # piece and may lose <accidental>/<stem> attributes. We do regex edits).
    with zipfile.ZipFile(mxl_path) as zf:
        xml_names = [n for n in zf.namelist()
                     if n.endswith('.xml') and 'META' not in n]
        if not xml_names:
            print(f'  {eid}: no .xml inside .mxl')
            return False
        inner_name = xml_names[0]
        xml_bytes = zf.read(inner_name)
    xml = xml_bytes.decode('utf-8')

    # Strategy: for each <note> element that has <type>quarter</type>,
    # change to the target type. For tuplets, also add <time-modification>.
    #
    # Use regex to find <note>...</note> blocks and edit each in place.

    def change_note_type(match):
        block = match.group(0)
        # Only edit if it has <type>quarter</type> (skip rests).
        if '<type>quarter</type>' not in block:
            return block
        # Skip if it's a rest.
        if '<rest' in block:
            return block
        new_block = block
        if rule == 'all_quarter_to_eighth':
            new_block = new_block.replace('<type>quarter</type>',
                                           '<type>eighth</type>')
        elif rule == 'all_quarter_to_eighth_triplet':
            # 8th triplet = 3 in the time of 2 (8th notes).
            new_block = new_block.replace('<type>quarter</type>',
                                           '<type>eighth</type>')
            # Insert <time-modification> right after <type>...</type>.
            tm = '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>'
            new_block = re.sub(r'(<type>eighth</type>)',
                                tm + r'\1', new_block, count=1)
        elif rule == 'all_quarter_to_eighth_quintuplet':
            new_block = new_block.replace('<type>quarter</type>',
                                           '<type>eighth</type>')
            tm = '<time-modification><actual-notes>5</actual-notes><normal-notes>4</normal-notes></time-modification>'
            new_block = re.sub(r'(<type>eighth</type>)',
                                tm + r'\1', new_block, count=1)
        elif rule == 'all_quarter_to_eighth_sextuplet':
            new_block = new_block.replace('<type>quarter</type>',
                                           '<type>eighth</type>')
            tm = '<time-modification><actual-notes>6</actual-notes><normal-notes>4</normal-notes></time-modification>'
            new_block = re.sub(r'(<type>eighth</type>)',
                                tm + r'\1', new_block, count=1)
        else:
            return block
        return new_block

    new_xml = re.sub(r'<note\b[^>]*>.*?</note>', change_note_type, xml, flags=re.DOTALL)

    # Write back.
    tmp_path = mxl_path.with_suffix('.tmp.mxl')
    with zipfile.ZipFile(mxl_path, 'r') as zin:
        with zipfile.ZipFile(tmp_path, 'w', zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                if item.filename == inner_name:
                    zout.writestr(item, new_xml)
                else:
                    zout.writestr(item, zin.read(item.filename))
    shutil.move(tmp_path, mxl_path)
    print(f'  {eid}: fixed (rule={rule})')
    return True


def re_render(eid):
    """Use Node/Puppeteer to re-render the .mxl via the practice page."""
    # The render_all.mjs script renders all 407. For a single one, we
    # can use the practice page directly via a small node script.
    script = f'''
import {{ createRequire }} from 'node:module';
const require = createRequire('/Users/kaidejuricmasscmbook/.nvm/versions/node/v26.1.0/lib/node_modules/playwright/');
const {{ chromium }} = require('playwright');
const fs = require('fs');
const out = '/tmp/bml-renders/{eid:04d}.png';
(async () => {{
  const browser = await chromium.launch();
  const page = await browser.newPage({{ viewport: {{ width: 1400, height: 600 }} }});
  await page.goto('http://localhost:8080/practice/?eid={eid}&transpose=0', {{ waitUntil: 'networkidle', timeout: 15000 }});
  await page.waitForTimeout(2500);
  const svg = await page.$('#score svg');
  if (!svg) {{ console.error('no svg'); await browser.close(); process.exit(1); }}
  await svg.screenshot({{ path: out }});
  await browser.close();
  console.log('rendered', out);
}})();
'''
    Path('/tmp/_rerender.mjs').write_text(script)
    res = subprocess.run(['node', '/tmp/_rerender.mjs'],
                         capture_output=True, text=True, timeout=30)
    return res.returncode == 0


def count_durations(eid):
    """Return (8th_count, qtr_count, tuplet_count, other_count, total)
    for the .mxl via direct XML parse (works for tuplets and 8th
    notes alike, without depending on music21's quarterLength which
    is rounded to 0.25 buckets by the comparator).
    """
    mxl = MXL_DIR / f'{eid:04d}.mxl'
    if not mxl.exists():
        return 0, 0, 0, 0, 0
    with zipfile.ZipFile(mxl) as zf:
        xml_names = [n for n in zf.namelist()
                     if n.endswith('.xml') and 'META' not in n]
        if not xml_names:
            return 0, 0, 0, 0, 0
        xml = zf.read(xml_names[0]).decode('utf-8')
    e = q = t = o = 0
    for m in re.finditer(r'<note\b[^>]*>(.*?)</note>', xml, flags=re.DOTALL):
        block = m.group(1)
        if '<rest' in block:
            continue
        is_tuplet = '<time-modification>' in block
        if '<type>eighth</type>' in block:
            if is_tuplet:
                t += 1
            else:
                e += 1
        elif '<type>quarter</type>' in block:
            q += 1
        else:
            o += 1
    return e, q, t, o, e + q + t + o


def main():
    if not RENDER_DIR.exists():
        RENDER_DIR.mkdir(parents=True)
    for plan in FIX_PLAN:
        eid = plan['eid']
        rule = plan['rule']
        print(f'[{eid}] {rule}')
        e0, q0, t0, o0, n0 = count_durations(eid)
        print(f'  before: 8th={e0} qtr={q0} tuplet={t0} other={o0} total={n0}')
        if not fix_mxl(eid, rule):
            continue
        e1, q1, t1, o1, n1 = count_durations(eid)
        print(f'  after:  8th={e1} qtr={q1} tuplet={t1} other={o1} total={n1}')


if __name__ == '__main__':
    main()
