#!/usr/bin/env python3
"""
Add missing <beam> elements to the 8 .mxl files where Audiveris dropped
the beam info. The notes are correct (durations, pitches, stems); only
the beam grouping is missing — so each eighth renders as a single flagged
note instead of a beamed group.

Pair with fix_durations.py: that script fixed the note *durations* on
these same 8 files, but the renderer still draws flagged notes without
beam elements. This script adds the beams.

Heuristic: per measure, count unique beats (a beat = one non-chord,
non-rest eighth-or-tuplet eighth note; chord notes share the previous
note's beat). Split the beat list into two equal-or-near-equal halves
("half-bar" rule: 4+4 for 8 eighths, 6+6 for 12 triplet-eighths, etc.)
and assign <beam number="1">begin/continue/end</beam> to each note
accordingly. A half of size 1 is skipped (single flagged notes don't
need a beam element).

Backups: if `<id>.bak.mxl` doesn't already exist, the original is
copied there first. (fix_durations.py already created .bak.mxl for
these 8 files, so the second pass is a no-op backup-wise.)

Outputs:
  - Modifies the 8 .mxl files in place.
  - Prints before/after beam-count and per-measure group sizes to stdout.
  - Re-renders each exercise via the practice page (Playwright) and
    saves PNGs to /tmp/bml-renders-beams/ for visual verification.

Usage:
  python3 fix_beams.py
"""
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path('/Users/kaidejuricmasscmbook/GrokDesk/bob-mover-lexicon-push')
MXL_DIR = ROOT / 'musicxml'
RENDER_DIR = Path('/tmp/bml-renders-beams')

# Same 8 exercises that fix_durations.py targets. Order is preserved so
# a side-by-side diff is easy. We don't depend on the rule here; the
# beam grouping is purely a function of how many beamed notes the OMR
# extracted per measure, so the rule is metadata-only.
TARGETS = [9, 146, 174, 236, 318, 319, 337, 387]


def process_measure(body: str) -> str:
    """Return the measure body with <beam> elements inserted after each
    <stem>...</stem> for the eighth notes that need them. Rests and
    non-eighths are left alone.
    """
    notes = list(re.finditer(r'<note\b.*?</note>', body, flags=re.DOTALL))
    if not notes:
        return body

    # Build (start, end, beat_pos_or_None, beam_value_or_None) for each note.
    # chord notes share the previous note's beat. rests / non-eighths get None.
    note_info = []
    beat = 0
    for nm in notes:
        block = nm.group(0)
        is_rest = '<rest' in block
        is_eighth = '<type>eighth</type>' in block
        is_chord = '<chord/>' in block
        if is_rest or not is_eighth:
            note_info.append((nm.start(), nm.end(), None, None))
        elif is_chord:
            # Find the most recent non-None beat position.
            prev_beat = None
            for _, _, b, _ in reversed(note_info):
                if b is not None:
                    prev_beat = b
                    break
            if prev_beat is None:
                prev_beat = max(beat - 1, 0)
            note_info.append((nm.start(), nm.end(), prev_beat, None))
        else:
            note_info.append((nm.start(), nm.end(), beat, None))
            beat += 1

    if beat < 2:
        # Nothing worth beaming in this measure (0 or 1 unique beats).
        return body

    # Split beats into two halves. Equal sizes when even; first half
    # gets the extra note when odd (so a 3-beat measure becomes 2+1,
    # and the 1 is skipped because half-of-odd is too small to beam).
    if beat % 2 == 0:
        first_half = beat // 2
    else:
        first_half = (beat + 1) // 2
    second_half = beat - first_half

    # Assign beam values. Group of size 1 → skip (no beam needed; the
    # note renders as a flagged eighth either way).
    for i, (start, end, b, _) in enumerate(note_info):
        if b is None:
            continue
        if b < first_half:
            pos_in_group = b
            group_size = first_half
        else:
            pos_in_group = b - first_half
            group_size = second_half
        if group_size < 2:
            value = None
        elif pos_in_group == 0:
            value = 'begin'
        elif pos_in_group == group_size - 1:
            value = 'end'
        else:
            value = 'continue'
        note_info[i] = (start, end, b, value)

    # Apply insertions in reverse order so earlier positions don't shift.
    # Each insertion point is the index in `body` just after </stem>.
    insertions = []
    for start, end, b, value in note_info:
        if value is None:
            continue
        block = body[start:end]
        stem_close = '</stem>'
        idx = block.find(stem_close)
        if idx == -1:
            # Defensive: skip if the note has no <stem> (shouldn't happen
            # for pitched eighths in this book).
            continue
        insert_at = start + idx + len(stem_close)
        insertions.append((insert_at, f'<beam number="1">{value}</beam>'))

    insertions.sort(key=lambda x: -x[0])
    new_body = body
    for pos, text in insertions:
        new_body = new_body[:pos] + text + new_body[pos:]
    return new_body


def add_beams(xml: str) -> tuple[str, int]:
    """Return (new_xml, total_beam_elements_added)."""
    out = []
    pos = 0
    added = 0
    measure_re = re.compile(r'<measure\b[^>]*>')
    while pos < len(xml):
        m = measure_re.search(xml, pos)
        if not m:
            out.append(xml[pos:])
            break
        out.append(xml[pos:m.start()])
        # Find matching </measure> (no nested <measure> in MusicXML partwise).
        end_idx = xml.find('</measure>', m.end())
        if end_idx == -1:
            out.append(xml[m.start():])
            break
        measure_xml = xml[m.start():end_idx + len('</measure>')]
        # Process just the body of the measure (between opening and closing tag).
        opening_end = m.end()
        body = measure_xml[opening_end - m.start():measure_xml.rindex('</measure>')]
        new_body = process_measure(body)
        new_measure = measure_xml[:opening_end - m.start()] + new_body + '</measure>'
        # Count beam elements added.
        added += new_measure.count('<beam ') - measure_xml.count('<beam ')
        out.append(new_measure)
        pos = end_idx + len('</measure>')
    return ''.join(out), added


def fix_mxl(eid: int) -> dict:
    """Add beam elements to a single .mxl. Returns a stats dict."""
    mxl_path = MXL_DIR / f'{eid:04d}.mxl'
    if not mxl_path.exists():
        return {'eid': eid, 'error': f'no .mxl at {mxl_path}'}

    # Backup if not already backed up.
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

    beams_before = original_xml.count('<beam ')
    if beams_before > 0:
        # Already has beams (idempotent: skip).
        return {
            'eid': eid, 'beams_before': beams_before, 'beams_after': beams_before,
            'added': 0, 'changed': False, 'skipped': 'already_has_beams',
        }
    new_xml, beams_added = add_beams(original_xml)
    beams_after = new_xml.count('<beam ')

    if beams_added == 0:
        return {
            'eid': eid, 'beams_before': beams_before, 'beams_after': beams_after,
            'added': 0, 'changed': False,
        }

    # Write back to the .mxl (zip archive).
    tmp_path = mxl_path.with_suffix('.tmp.mxl')
    with zipfile.ZipFile(mxl_path, 'r') as zin:
        with zipfile.ZipFile(tmp_path, 'w', zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                if item.filename == inner_name:
                    zout.writestr(item, new_xml.encode('utf-8'))
                else:
                    zout.writestr(item, zin.read(item.filename))
    shutil.move(tmp_path, mxl_path)

    return {
        'eid': eid, 'beams_before': beams_before, 'beams_after': beams_after,
        'added': beams_added, 'changed': True,
    }


def re_render(eid: int) -> bool:
    """Render the exercise to a PNG via the practice page (Playwright)."""
    RENDER_DIR.mkdir(parents=True, exist_ok=True)
    script = f'''
import {{ createRequire }} from 'node:module';
const require = createRequire('/Users/kaidejuricmasscmbook/.nvm/versions/node/v26.1.0/lib/node_modules/playwright/');
const {{ chromium }} = require('playwright');
const out = '{RENDER_DIR}/{eid:04d}.png';
(async () => {{
  const browser = await chromium.launch();
  const page = await browser.newPage({{ viewport: {{ width: 1400, height: 600 }} }});
  await page.goto('http://localhost:8080/practice/?eid={eid}&transpose=0', {{ waitUntil: 'networkidle', timeout: 15000 }});
  await page.waitForTimeout(2500);
  const svg = await page.$('#score-container svg');
  if (!svg) {{ console.error('no svg'); await browser.close(); process.exit(1); }}
  await svg.screenshot({{ path: out }});
  await browser.close();
  console.log('rendered', out);
}})();
'''
    Path('/tmp/_rerender_beams.mjs').write_text(script)
    # Use the absolute node path; nvm-installed node isn't on the
    # default subprocess PATH on this machine.
    node_bin = '/Users/kaidejuricmasscmbook/.nvm/versions/node/v26.1.0/bin/node'
    res = subprocess.run([node_bin, '/tmp/_rerender_beams.mjs'],
                         capture_output=True, text=True, timeout=30)
    return res.returncode == 0


def main():
    print(f'Adding beams to {len(TARGETS)} .mxl files in {MXL_DIR}...')
    print()
    results = []
    for eid in TARGETS:
        r = fix_mxl(eid)
        results.append(r)
        if 'error' in r:
            print(f"  #{eid}: ERROR {r['error']}")
        else:
            print(f"  #{eid}: beams {r['beams_before']:>3} -> {r['beams_after']:>3}  (+{r['added']})")

    changed = [r for r in results if r.get('changed')]
    print()
    print(f'Changed: {len(changed)} / {len(results)}')
    if not changed:
        print('Nothing to re-render.')
        return

    # Re-render only the changed ones.
    print()
    print(f'Re-rendering {len(changed)} exercises to {RENDER_DIR}/...')
    for r in changed:
        ok = re_render(r['eid'])
        print(f"  #{r['eid']:>3}: {'OK' if ok else 'FAIL'}")


if __name__ == '__main__':
    main()
