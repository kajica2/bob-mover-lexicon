#!/usr/bin/env python3
"""
Strip the phantom 2nd voice from #58.

Audiveris introduced a stray voice-2 16th rest in m2 (with a
<backup> and <forward> pair) that the renderer draws as a slash
through the m2 quarter rest — the "weird look" the user flagged.
The original PDF is single-voice, so the 2nd voice elements should
go away entirely.

The script removes:
  - All <note> elements with <voice>2</voice> (the phantom rest)
  - The matching <backup> and <forward> elements that drove the
    voice switch
"""
import re
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path('/Users/kaidejuricmasscmbook/GrokDesk/bob-mover-lexicon-push')
MXL_DIR = ROOT / 'musicxml'

EID = 58


def fix_mxl(eid: int) -> dict:
    mxl_path = MXL_DIR / f'{eid:04d}.mxl'
    if not mxl_path.exists():
        return {'eid': eid, 'error': 'no .mxl'}

    backup = mxl_path.with_suffix('.bak.mxl')
    if not backup.exists():
        shutil.copy2(mxl_path, backup)

    with zipfile.ZipFile(mxl_path) as zf:
        xml_names = [n for n in zf.namelist()
                     if n.endswith('.xml') and 'META' not in n]
        if not xml_names:
            return {'eid': eid, 'error': 'no .xml inside .mxl'}
        inner_name = xml_names[0]
        original = zf.read(inner_name).decode('utf-8')

    new = original
    # Drop the voice-2 notes.
    new, n_notes = re.subn(
        r'<note\b[^>]*>(?:(?!</note>).)*<voice>2</voice>(?:(?!</note>).)*</note>\s*',
        '', new, flags=re.DOTALL)
    # Drop the <backup> and <forward> elements (they only existed to
    # support the phantom voice 2).
    new, n_backup = re.subn(r'<backup>.*?</backup>\s*', '', new, flags=re.DOTALL)
    new, n_forward = re.subn(r'<forward>.*?</forward>\s*', '', new, flags=re.DOTALL)

    if n_notes + n_backup + n_forward == 0:
        return {'eid': eid, 'removed': 0, 'changed': False}

    tmp_path = mxl_path.with_suffix('.tmp.mxl')
    with zipfile.ZipFile(mxl_path, 'r') as zin:
        with zipfile.ZipFile(tmp_path, 'w', zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                if item.filename == inner_name:
                    zout.writestr(item, new.encode('utf-8'))
                else:
                    zout.writestr(item, zin.read(item.filename))
    shutil.move(tmp_path, mxl_path)
    return {'eid': eid, 'removed': n_notes + n_backup + n_forward,
            'voice2_notes': n_notes, 'backups': n_backup, 'forwards': n_forward,
            'changed': True}


def main():
    r = fix_mxl(EID)
    if 'error' in r:
        print(f"#{EID}: ERROR {r['error']}")
        sys.exit(1)
    print(f"#{EID}: removed {r['removed']} element(s) "
          f"(voice2-notes={r.get('voice2_notes',0)} "
          f"backups={r.get('backups',0)} "
          f"forwards={r.get('forwards',0)})")


if __name__ == '__main__':
    main()
