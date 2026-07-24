#!/usr/bin/env python3
"""
Remove phantom 3-tuplet <time-modification> elements from specific
measures where the rhythmic math is broken.

This is the rhythmic-integrity pass for the 3-tuplet candidate set.
For each target (file, measure), the script:

  1. Loads the inner MusicXML from the .mxl
  2. Locates the named measure
  3. Strips every <time-modification>...</time-modification> block
     from that measure's body
  4. Writes the .mxl back (zipping the modified XML in place)
  5. Backs up to <id>.bak.mxl first if not already backed up

The targets are pre-computed by the audit script (math verification):
removing the tuplet markings makes the measure add up to the file's
canonical time signature (4/4 or 5/4 in all current cases). The
audit also confirms there is NO case where adding tuplet markings
would fix the math — so removing is the safe direction here.

Per the user's brief: "Before you change a single pitch, you must
verify the mathematics of every bar. If a bar does not add up to the
correct time signature, flag it immediately." This script only
edits measures where the math is provably wrong AND the fix is
provably correct (removing tuplets yields the canonical total).

Output:
  - Prints before/after time-modification count per (eid, mnum)
  - Re-renders each affected exercise to /tmp/bml-renders-3tuplets/
    for visual verification
"""
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path('/Users/kaidejuricmasscmbook/GrokDesk/bob-mover-lexicon-push')
MXL_DIR = ROOT / 'musicxml'
RENDER_DIR = Path('/tmp/bml-renders-3tuplets')
NODE_BIN = '/Users/kaidejuricmasscmbook/.nvm/versions/node/v26.1.0/bin/node'

# Targets verified by the rhythmic-integrity audit (4/4 = 48, 5/4 = 60).
# Each entry: eid, mnum, canonical_units, units_with_tuplets, units_without
TARGETS = [
    (38,  1, 48, 32, 48),  # 4/4
    (99,  1, 48, 36, 48),  # 4/4
    (102, 1, 48, 42, 48),  # 4/4
    (106, 4, 48, 42, 48),  # 4/4
    (116, 1, 48, 36, 48),  # 4/4
    (132, 2, 48, 42, 48),  # 4/4
    (147, 3, 48, 36, 48),  # 4/4
    (157, 1, 48, 42, 48),  # 4/4
    (170, 4, 48, 42, 48),  # 4/4
    (314, 1, 48, 42, 48),  # 4/4
    (352, 1, 48, 38, 48),  # 4/4
    (355, 1, 48, 38, 48),  # 4/4
    (358, 1, 48, 38, 48),  # 4/4
    (369, 1, 48, 42, 48),  # 4/4
    (383, 1, 60, 48, 60),  # 5/4
    (384, 1, 60, 48, 60),  # 5/4
    (406, 5, 60, 48, 60),  # 5/4
    (407, 4, 60, 48, 60),  # 5/4
]


def strip_tuplets_in_measure(body: str) -> tuple[str, int]:
    new_body, n = re.subn(r'<time-modification>.*?</time-modification>',
                          '', body, flags=re.DOTALL)
    return new_body, n


def fix_mxl(eid: int, mnum: int) -> dict:
    mxl_path = MXL_DIR / f'{eid:04d}.mxl'
    if not mxl_path.exists():
        return {'eid': eid, 'mnum': mnum, 'error': 'no .mxl'}

    backup = mxl_path.with_suffix('.bak.mxl')
    if not backup.exists():
        shutil.copy2(mxl_path, backup)

    with zipfile.ZipFile(mxl_path) as zf:
        xml_names = [n for n in zf.namelist()
                     if n.endswith('.xml') and 'META' not in n]
        if not xml_names:
            return {'eid': eid, 'mnum': mnum, 'error': 'no inner .xml'}
        inner_name = xml_names[0]
        original = zf.read(inner_name).decode('utf-8')

    tm_before = original.count('<time-modification>')

    # Find the named measure and strip tuplets from its body
    new = original
    removed = 0
    measure_re = re.compile(r'<measure\b[^>]*>')
    pos = 0
    while pos < len(new):
        m = measure_re.search(new, pos)
        if not m:
            break
        body_end = new.find('</measure>', m.end())
        if body_end == -1:
            break
        num_m = re.search(r'number="(\d+)"', new[m.start():m.end()])
        if num_m and int(num_m.group(1)) == mnum:
            body_start = m.end()
            body = new[body_start:body_end]
            new_body, n = strip_tuplets_in_measure(body)
            if n:
                new = new[:body_start] + new_body + new[body_end:]
                removed = n
            break
        pos = body_end + len('</measure>')

    if removed == 0:
        return {'eid': eid, 'mnum': mnum, 'tm_before': tm_before,
                'tm_after': tm_before, 'removed': 0, 'changed': False}

    tmp_path = mxl_path.with_suffix('.tmp.mxl')
    with zipfile.ZipFile(mxl_path, 'r') as zin:
        with zipfile.ZipFile(tmp_path, 'w', zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                if item.filename == inner_name:
                    zout.writestr(item, new.encode('utf-8'))
                else:
                    zout.writestr(item, zin.read(item.filename))
    shutil.move(tmp_path, mxl_path)
    return {'eid': eid, 'mnum': mnum, 'tm_before': tm_before,
            'tm_after': tm_before - removed, 'removed': removed,
            'changed': True}


def re_render(eid: int) -> bool:
    RENDER_DIR.mkdir(parents=True, exist_ok=True)
    script = f"""import {{ createRequire }} from 'node:module';
const require = createRequire('/Users/kaidejuricmasscmbook/.nvm/versions/node/v26.1.0/lib/node_modules/playwright/');
const {{ chromium }} = require('playwright');
(async () => {{
  const browser = await chromium.launch();
  const page = await browser.newPage({{ viewport: {{ width: 1600, height: 800 }} }});
  await page.goto('http://localhost:8080/practice/?id={eid}&transpose=0', {{ waitUntil: 'networkidle', timeout: 20000 }});
  await page.waitForTimeout(3500);
  await page.evaluate(() => {{ const m = document.getElementById('range-modal-overlay'); if (m) m.style.display = 'none'; }});
  await page.waitForTimeout(600);
  const score = await page.$('#score-container');
  if (!score) {{ console.error('no svg for {eid}'); await browser.close(); process.exit(1); }}
  await score.screenshot({{ path: '{RENDER_DIR}/{eid:04d}.png' }});
  await browser.close();
  console.log('rendered {eid}');
}})();
"""
    Path('/tmp/_render_3t.mjs').write_text(script)
    res = subprocess.run([NODE_BIN, '/tmp/_render_3t.mjs'],
                         capture_output=True, text=True, timeout=30)
    return res.returncode == 0


def main():
    print(f'Stripping 3-tuplet markings from {len(TARGETS)} measure(s)...')
    print()
    results = []
    for eid, mnum, canon, with_t, without_t in TARGETS:
        r = fix_mxl(eid, mnum)
        if 'error' in r:
            print(f"  #{eid:>3} m{mnum:>2}: ERROR {r['error']}")
            continue
        if r['changed']:
            print(f"  #{eid:>3} m{mnum:>2}: tm {r['tm_before']:>3} -> {r['tm_after']:>3}  (-{r['removed']})  "
                  f"[{with_t} -> {without_t} units = {canon}/12 quarter]")
        else:
            print(f"  #{eid:>3} m{mnum:>2}: nothing to remove (tm before/after={r['tm_before']})")
        results.append(r)

    changed = [r for r in results if r.get('changed')]
    if not changed:
        print('\nNo changes — nothing to re-render.')
        return
    print(f'\nRe-rendering {len(changed)} changed exercise(s)...')
    for r in changed:
        ok = re_render(r['eid'])
        print(f"  #{r['eid']:>3} m{r['mnum']:>2}: {'OK' if ok else 'FAIL'}")


if __name__ == '__main__':
    main()
