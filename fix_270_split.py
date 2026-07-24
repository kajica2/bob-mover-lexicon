#!/usr/bin/env python3
"""
Split fix for #270 and #271.

Root cause: exercises_images/0270.png was miscropped — it actually
contains BOTH #270 and #271 stacked in one image. exercises_images/0271.png
was cropped from the wrong page area and shows #272/#273/#274 instead.

When Audiveris OCR'd these images, it captured:
  - 0270.mxl: 17 measures, mixing #270 (parallel phrases) with the start
              of #271 (which was in the bottom half of the same source PNG)
  - 0271.mxl: structurally correct content (Jimmy Raney, 14 measures in
              3 sections with repeats) but its source image was wrong

Fixes:
  1. Re-crop source PNGs (already done in /tmp, will be moved to
     exercises_images/ by the shell step)
  2. Trim 0270.mxl to the #270 portion (first 8 measures), adding a
     whole rest to m4 and m8 to close the math (those were the parallel-
     phrase ending measures that the OMR dropped, plus a 9th hallucinated
     phrase beyond the 2 the source actually contains)
  3. Leave 0271.mxl as-is (per user direction)
"""
import re
import shutil
import zipfile
from pathlib import Path

ROOT = Path('/Users/kaidejuricmasscmbook/GrokDesk/bob-mover-lexicon-push')
MXL = ROOT / 'musicxml/0270.mxl'

# Whole rest MusicXML fragment (at divisions=2: 4 ticks = whole rest duration)
WHOLE_REST = '''<note>
        <rest>
          <display-step>B</display-step>
          <display-octave>4</display-octave>
        </rest>
        <duration>4</duration>
        <voice>1</voice>
        <type>whole</type>
      </note>'''


def main():
    # Read the .mxl
    with zipfile.ZipFile(MXL) as z:
        with z.open('0270.xml') as f:
            xml = f.read().decode()

    # Find all measures in order
    measures = re.findall(r'<measure[^>]*>.*?</measure>', xml, re.DOTALL)
    print(f'found {len(measures)} measures')

    # Keep first 8
    kept = measures[:8]

    # m4 and m8 are empty self-closed tags — replace with open-close + whole rest
    out = []
    for i, m in enumerate(kept):
        idx = i + 1
        if idx in (4, 8):
            # Replace the empty self-closed measure with one containing a whole rest
            # original: <measure number="N" width="W"></measure>
            new_m = re.sub(
                r'(<measure\s+number="\d+"\s+width="\d+">)\s*</measure>',
                rf'\1\n      {WHOLE_REST}\n    </measure>',
                m,
            )
            out.append(new_m)
        else:
            out.append(m)

    # Splice the kept measures back into the XML.
    # Find the first <measure> opening and the last </measure> closing,
    # then replace the entire measures block with our trimmed + fixed set.
    # Use a non-greedy match for the full sequence of measure elements.
    pattern = re.compile(r'(<measure\b.*?</measure>\s*){8,17}', re.DOTALL)
    new_measures_block = '\n    '.join(out)
    # New XML: replace the measures section. We use a simple approach:
    # find the first <measure ...> and the last </measure>, replace everything in between.
    first = xml.find('<measure')
    last_close = xml.rfind('</measure>') + len('</measure>')
    new_xml = xml[:first] + new_measures_block + '\n    ' + xml[last_close:]

    # Quick sanity: count actual <measure> opening tags (not <measure-numbering>)
    new_count = len(re.findall(r'<measure\s+number=', new_xml))
    print(f'new measure count: {new_count}')
    assert new_count == 8, f'expected 8 measures, got {new_count}'

    # Write the .mxl back (zip in place)
    bak = MXL.with_suffix('.bak.mxl')
    if not bak.exists():
        shutil.copy(MXL, bak)
        print(f'backup → {bak}')

    tmp = MXL.with_suffix('.mxl.tmp')
    with zipfile.ZipFile(MXL, 'r') as zin:
        with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
            for item in zin.namelist():
                if item == '0270.xml':
                    zout.writestr(item, new_xml)
                else:
                    zout.writestr(item, zin.read(item))
    shutil.move(tmp, MXL)
    print(f'wrote {MXL}')


if __name__ == '__main__':
    main()
