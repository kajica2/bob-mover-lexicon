#!/usr/bin/env python3
"""
Bob Mover Jazz Lexicon — Practice Library server.

Features:
- Static file serving
- PDF practice sheet generation
- MusicXML serving (with optional transposition)
- Practice log API
- Collections API
"""
import http.server
import io
import json
import os
import socketserver
import sys
import zipfile
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse, parse_qs

# Optional dependencies
try:
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.units import inch
    from reportlab.pdfgen import canvas
    from reportlab.lib.utils import ImageReader
    from reportlab.lib.colors import HexColor, black, white
    HAS_REPORTLAB = True
except ImportError:
    HAS_REPORTLAB = False

try:
    # music21 is the gold standard for MusicXML manipulation
    from music21 import stream, interval, key, pitch
    HAS_MUSIC21 = True
except ImportError:
    HAS_MUSIC21 = False

import db

ROOT = Path(__file__).parent.resolve()
EXERCISES_JSON = ROOT / "exercises.json"
IMAGES_DIR = ROOT / "exercises_images"
# Local MusicXML dir (works in dev and in production)
# Falls back to /workspace location for backward compat with the original extraction
_LOCAL_MUSICXML = ROOT / "musicxml"
_LEGACY_MUSICXML = Path("/workspace/extracted/exercises/musicxml")
MUSICXML_DIR = _LOCAL_MUSICXML if _LOCAL_MUSICXML.exists() else _LEGACY_MUSICXML

PORT = int(os.environ.get("PORT", "8080"))


def load_db_data():
    with open(EXERCISES_JSON) as f:
        return json.load(f)


def generate_pdf(config, exercises_db):
    """Generate a practice sheet PDF in memory."""
    if not HAS_REPORTLAB:
        raise RuntimeError("reportlab not installed")
    by_id = {e["id"]: e for e in exercises_db["exercises"]}
    exercises = [by_id[i] for i in config["ids"] if i in by_id]
    if not exercises:
        raise ValueError("No valid exercises found")

    title = config.get("title", "Practice Sheet")
    subtitle = config.get("subtitle", "")
    include_notes = config.get("includeNotes", True)
    include_title_page = config.get("includeTitlePage", True)

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    page_w, page_h = letter

    if include_title_page and len(exercises) > 3:
        c.setFont("Helvetica-Bold", 28)
        c.drawCentredString(page_w / 2, page_h - 1.2 * inch, title)
        if subtitle:
            c.setFont("Helvetica-Oblique", 14)
            c.drawCentredString(page_w / 2, page_h - 1.6 * inch, subtitle)
        today = datetime.now().strftime("%Y-%m-%d")
        c.setFont("Helvetica", 10)
        c.drawCentredString(
            page_w / 2,
            page_h - 2.0 * inch,
            f"{today} • {len(exercises)} exercises • Bob Mover Jazz Lexicon",
        )
        c.setFont("Helvetica", 11)
        y = page_h - 2.8 * inch
        for e in exercises:
            text = f"#{e['id']:>3}   {e['title'][:55]:<55}   §{e['section']} (p.{e['page']})"
            c.drawString(0.75 * inch, y, text)
            y -= 0.22 * inch
            if y < 1 * inch:
                c.showPage()
                y = page_h - 1 * inch
        c.showPage()

    for i, e in enumerate(exercises):
        c.setFont("Helvetica-Bold", 13)
        c.drawString(0.5 * inch, page_h - 0.45 * inch, f"#{e['id']}: {e['title'][:80]}")
        c.setFont("Helvetica-Oblique", 9)
        c.drawRightString(
            page_w - 0.5 * inch,
            page_h - 0.45 * inch,
            f"Section {e['section']} • Source page {e['page']}",
        )

        img_path = IMAGES_DIR / f"{e['id']:04d}.png"
        new_h = 0
        if img_path.exists():
            img = ImageReader(str(img_path))
            iw, ih = img.getSize()
            max_w = page_w - 1 * inch
            max_h = page_h - 1.6 * inch
            if include_notes:
                max_h -= 0.9 * inch
            scale = min(max_w / iw, max_h / ih)
            new_w = iw * scale
            new_h = ih * scale
            x = (page_w - new_w) / 2
            y = page_h - 0.7 * inch - new_h
            c.drawImage(img, x, y, width=new_w, height=new_h, preserveAspectRatio=True)

        if include_notes:
            y_tracking = (page_h - 0.7 * inch - new_h - 0.3 * inch) if img_path.exists() else page_h / 2 - 1 * inch
            if y_tracking < 1.2 * inch:
                c.showPage()
                y_tracking = page_h - 1 * inch
            c.setFont("Helvetica-Bold", 10)
            c.drawString(0.5 * inch, y_tracking, "Practice tracking:")
            c.setFont("Helvetica", 9)
            for txt, x in [("☐ Completed", 0.5), ("Tempo: ____", 1.8), ("Date: ____", 3.1)]:
                c.drawString(x * inch, y_tracking - 0.25 * inch, txt)
            c.setStrokeColorRGB(0.75, 0.75, 0.75)
            note_y = y_tracking - 0.55 * inch
            for _ in range(3):
                c.line(0.5 * inch, note_y, page_w - 0.5 * inch, note_y)
                note_y -= 0.22 * inch

        c.setFont("Helvetica", 8)
        c.setFillColorRGB(0.6, 0.6, 0.6)
        c.drawCentredString(
            page_w / 2,
            0.3 * inch,
            f"{i + 1} / {len(exercises)} • Bob Mover Jazz Lexicon",
        )
        c.setFillColorRGB(0, 0, 0)
        c.showPage()

    c.save()
    return buf.getvalue()


# Note names for semitone offsets 0-11, used to label transposed pages
SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLAT_NAMES  = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]


def note_name(semitones, prefer_flats=False):
    """Return the note name for a semitone offset 0-11."""
    s = semitones % 12
    return (FLAT_NAMES if prefer_flats else SHARP_NAMES)[s]


def transposition_sequence(mode):
    """Return a list of 12 semitone offsets (0-11) for the given mode.

    - 'chromatic': 0, 1, 2, ... 11 (chromatic ascending)
    - 'min3-cycle5': minor 3rds (+3 semitones) walking by cycle of 5ths (+7
      semitones each step). Order: 0, 3, 10, 5, 0, ... — accumulates by
      (+7 mod 12) and adds 3 base offset. After 12 steps all 12 keys are hit.
    """
    if mode == "chromatic":
        return list(range(12))
    if mode == "min3-cycle5":
        # Walk cycle of 5ths: each step adds +7 mod 12 (i.e. +7, then +5, ...).
        # Within each key, the transposition for the "minor 3rd voicing" is +3
        # semitones above the root — we present the exercise in the minor-3rd
        # register relative to each cycle-of-5ths key center.
        seq = []
        s = 0
        for i in range(12):
            seq.append(s)
            s = (s + 7) % 12
        return seq
    raise ValueError(f"Unknown transposition mode: {mode}")


def generate_all_keys_pdf(config, exercises_db):
    """Generate a PDF with each exercise rendered 12 times, once per key.

    The PDF uses the original cropped PNG (we can't render transposed notation
    server-side without Lilypond/MuseScore). Each page is clearly labeled with
    the target key so the player can mentally transpose or play along with
    the practice player set to that instrument/key.

    Modes:
      - 'chromatic': all 12 keys chromatically (C, C#, D, ... B)
      - 'min3-cycle5': all 12 keys ordered by cycle of 5ths (C, G, D, A, ...)
                        each shown at +m3 voicing
    """
    if not HAS_REPORTLAB:
        raise RuntimeError("reportlab not installed")
    by_id = {e["id"]: e for e in exercises_db["exercises"]}
    ids = config.get("ids") or []
    exercises = [by_id[i] for i in ids if i in by_id]
    if not exercises:
        raise ValueError("No valid exercises found")

    mode = config.get("mode", "chromatic")
    seq = transposition_sequence(mode)

    title = config.get("title") or "All 12 Keys"
    subtitle = config.get("subtitle") or (
        "Chromatic ascent" if mode == "chromatic"
        else "Minor 3rds in cycle of 5ths"
    )
    prefer_flats = bool(config.get("preferFlats", False))
    include_notes = config.get("includeNotes", True)
    include_title_page = config.get("includeTitlePage", True)

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    page_w, page_h = letter

    # ----- Title page -----
    if include_title_page:
        c.setFont("Helvetica-Bold", 28)
        c.drawCentredString(page_w / 2, page_h - 1.2 * inch, title)
        c.setFont("Helvetica-Oblique", 14)
        c.drawCentredString(page_w / 2, page_h - 1.6 * inch, subtitle)
        c.setFont("Helvetica", 11)
        c.drawCentredString(
            page_w / 2, page_h - 2.0 * inch,
            f"{len(exercises)} exercise(s) × {len(seq)} keys = "
            f"{len(exercises) * len(seq)} pages",
        )
        y = page_h - 2.7 * inch
        c.setFont("Helvetica-Bold", 11)
        c.drawString(0.75 * inch, y, "Key sequence:")
        c.setFont("Helvetica", 10)
        y -= 0.22 * inch
        # Two columns of 6 keys each
        for i, semi in enumerate(seq):
            col = i // 6
            row = i % 6
            cx = 0.75 * inch + col * 3.2 * inch
            cy = y - row * 0.25 * inch
            label = f"{i + 1:>2}. {note_name(semi, prefer_flats)} (+{semi} st)"
            c.drawString(cx, cy, label)
        c.setFont("Helvetica-Oblique", 9)
        c.setFillColorRGB(0.4, 0.4, 0.4)
        c.drawCentredString(
            page_w / 2, 1.0 * inch,
            "Each exercise appears in all 12 keys. Use the Practice page "
            "to hear each transposition with the synth.",
        )
        c.setFillColorRGB(0, 0, 0)
        c.showPage()

    # ----- Body: each exercise × each key -----
    total_pages = len(exercises) * len(seq)
    page_idx = 0
    for ex in exercises:
        for k_idx, semi in enumerate(seq):
            page_idx += 1
            key_label = note_name(semi, prefer_flats)

            # Header bar with exercise info
            c.setFillColorRGB(0.95, 0.95, 0.95)
            c.rect(0, page_h - 0.55 * inch, page_w, 0.55 * inch, fill=1, stroke=0)
            c.setFillColorRGB(0, 0, 0)
            c.setFont("Helvetica-Bold", 12)
            c.drawString(0.5 * inch, page_h - 0.35 * inch,
                         f"#{ex['id']}: {ex['title'][:70]}")
            c.setFont("Helvetica-Bold", 14)
            c.drawRightString(page_w - 0.5 * inch, page_h - 0.35 * inch,
                              f"Key of {key_label}")
            c.setFont("Helvetica-Oblique", 8)
            c.setFillColorRGB(0.45, 0.45, 0.45)
            c.drawString(0.5 * inch, page_h - 0.50 * inch,
                         f"Section {ex['section']} • Source page {ex['page']} • "
                         f"{mode} • {k_idx + 1}/{len(seq)}")
            c.setFillColorRGB(0, 0, 0)

            # Embed the exercise image
            img_path = IMAGES_DIR / f"{ex['id']:04d}.png"
            new_h = 0
            if img_path.exists():
                img = ImageReader(str(img_path))
                iw, ih = img.getSize()
                max_w = page_w - 1 * inch
                max_h = page_h - 1.8 * inch
                if include_notes:
                    max_h -= 0.9 * inch
                scale = min(max_w / iw, max_h / ih)
                new_w = iw * scale
                new_h = ih * scale
                x = (page_w - new_w) / 2
                y = page_h - 0.7 * inch - new_h
                c.drawImage(img, x, y, width=new_w, height=new_h,
                            preserveAspectRatio=True)

            # Transposition instruction banner
            banner_y = (page_h - 0.7 * inch - new_h - 0.18 * inch) \
                if img_path.exists() else page_h / 2 - 1.5 * inch
            if banner_y > 1.6 * inch:
                c.setFillColorRGB(1.0, 0.96, 0.85)  # warm yellow
                c.rect(0.5 * inch, banner_y - 0.05 * inch,
                       page_w - 1 * inch, 0.32 * inch, fill=1, stroke=0)
                c.setFillColorRGB(0.15, 0.10, 0)
                c.setFont("Helvetica-Bold", 10)
                c.drawString(0.6 * inch, banner_y + 0.14 * inch,
                             f"Transpose the pattern up {semi} semitones "
                             f"to play it in {key_label}.")
                c.setFont("Helvetica", 9)
                if mode == "min3-cycle5":
                    c.drawString(0.6 * inch, banner_y + 0.0 * inch,
                                 "Voicing: play each phrase starting on the "
                                 "minor 3rd above the root.")
                else:
                    c.drawString(0.6 * inch, banner_y + 0.0 * inch,
                                 "Use the Practice page → Transpose dropdown "
                                 f"to hear this in {key_label}.")
                c.setFillColorRGB(0, 0, 0)

            # Practice tracking row (optional)
            if include_notes:
                y_track = banner_y - 0.55 * inch if banner_y > 1.6 * inch else 1.0 * inch
                c.setFont("Helvetica-Bold", 9)
                c.drawString(0.5 * inch, y_track, "Practice tracking:")
                c.setFont("Helvetica", 9)
                for txt, x in [("☐ Done", 0.5),
                               ("Tempo: ____", 1.8),
                               ("Date: ____", 3.1),
                               ("Key: " + key_label, 4.4)]:
                    c.drawString(x * inch, y_track - 0.22 * inch, txt)
                c.setStrokeColorRGB(0.75, 0.75, 0.75)
                note_y = y_track - 0.50 * inch
                for _ in range(2):
                    c.line(0.5 * inch, note_y, page_w - 0.5 * inch, note_y)
                    note_y -= 0.22 * inch

            # Footer
            c.setFont("Helvetica", 8)
            c.setFillColorRGB(0.6, 0.6, 0.6)
            c.drawCentredString(
                page_w / 2, 0.3 * inch,
                f"{page_idx} / {total_pages} • "
                f"Bob Mover Jazz Lexicon — {mode}",
            )
            c.setFillColorRGB(0, 0, 0)
            c.showPage()

    c.save()
    return buf.getvalue()


def extract_musicxml_from_mxl(mxl_path):
    """Extract the .xml from a .mxl (zipped MusicXML) file."""
    with zipfile.ZipFile(mxl_path, 'r') as z:
        # Find the root .xml (not META-INF/container.xml)
        for name in z.namelist():
            if name.endswith('.xml') and not name.startswith('META-INF/'):
                return z.read(name).decode('utf-8')
    return None


def transpose_musicxml(mxl_path, semitones):
    """Transpose a MusicXML file by N semitones using music21.

    Returns the transposed XML as a string, or None if music21 unavailable.
    """
    if not HAS_MUSIC21:
        return None
    try:
        original_xml = extract_musicxml_from_mxl(mxl_path)
        if not original_xml:
            return None
        # Parse from string
        score = stream.Score()
        from music21 import converter
        score = converter.parse(original_xml, format='musicxml')
        if semitones != 0:
            score = score.transpose(semitones)
        # Serialize back to MusicXML. score.write returns a Path; read it back as string
        import tempfile
        with tempfile.NamedTemporaryFile(suffix='.musicxml', delete=False, mode='w') as tmp:
            tmp_path = tmp.name
        try:
            written = score.write('musicxml', fp=tmp_path)
            with open(written if isinstance(written, str) else tmp_path) as f:
                return f.read()
        finally:
            try:
                import os as _os
                _os.unlink(tmp_path)
            except OSError:
                pass
    except Exception as e:
        print(f"Transpose error: {e}", file=sys.stderr)
        return None


def get_musicxml(exercise_id, transpose_semitones=0):
    """Get MusicXML for an exercise, optionally transposed.

    Returns (xml_string, content_type) or (None, None) if not found.
    """
    mxl_path = MUSICXML_DIR / f"{exercise_id:04d}.mxl"
    if not mxl_path.exists():
        return None, None

    if transpose_semitones == 0:
        # Return raw extracted XML
        xml = extract_musicxml_from_mxl(mxl_path)
        return xml, "application/vnd.recordare.musicxml+xml"

    transposed = transpose_musicxml(mxl_path, transpose_semitones)
    if transposed:
        return transposed, "application/vnd.recordare.musicxml+xml"
    # Fallback to original if transposition failed
    xml = extract_musicxml_from_mxl(mxl_path)
    return xml, "application/vnd.recordare.musicxml+xml"


# Instrument transposition offsets (semitones from concert to written)
INSTRUMENT_OFFSETS = {
    "concert": 0,
    "bb": 2,     # Bb instruments sound a M2 lower than written -> transpose UP 2 to get written
    "eb": 9,     # Eb instruments sound a M6 lower than written -> transpose UP 9
    "f": 7,      # F instruments (horn) sound P5 lower
    "alto": 9,   # alto sax
    "tenor": 2,  # tenor sax
    "soprano": 2, # soprano sax
    "bari": 9,   # bari sax
    "trumpet": 2,
    "clarinet": 2,
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        # API routes
        if path == "/api/practice/recent":
            return self.handle_recent(qs)
        if path == "/api/practice/stats":
            return self.handle_stats(qs)
        if path.startswith("/api/practice/exercise/"):
            try:
                eid = int(path.rsplit("/", 1)[-1])
                return self.handle_exercise_history(eid)
            except ValueError:
                return self.send_json({"error": "Invalid exercise ID"}, 400)

        if path.startswith("/api/musicxml/"):
            try:
                eid = int(path.rsplit("/", 1)[-1])
            except ValueError:
                return self.send_json({"error": "Invalid exercise ID"}, 400)
            transpose = int(qs.get("transpose", ["0"])[0])
            instrument = qs.get("instrument", ["concert"])[0]
            offset = INSTRUMENT_OFFSETS.get(instrument, 0)
            semitones = transpose + offset
            xml, ctype = get_musicxml(eid, semitones)
            if xml is None:
                return self.send_json({"error": "MusicXML not available for this exercise"}, 404)
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Access-Control-Allow-Origin", "*")
            body = xml.encode("utf-8") if isinstance(xml, str) else xml
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/api/collections":
            return self.handle_list_collections()
        if path.startswith("/api/collections/") and path != "/api/collections/":
            try:
                cid = int(path.rsplit("/", 1)[-1])
                return self.handle_get_collection(cid)
            except ValueError:
                return self.send_json({"error": "Invalid collection ID"}, 400)

        # Default: serve static
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/sheet":
            return self.handle_sheet_api()
        if path == "/api/sheet/all-keys":
            return self.handle_sheet_all_keys_api()
        if path == "/api/practice":
            return self.handle_log_practice()
        if path == "/api/collections":
            return self.handle_create_collection()
        return self.send_json({"error": "Not Found"}, 404)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/collections/") and path != "/api/collections/":
            try:
                cid = int(path.rsplit("/", 1)[-1])
                if db.delete_collection(cid):
                    return self.send_json({"ok": True})
                return self.send_json({"error": "Not found"}, 404)
            except ValueError:
                return self.send_json({"error": "Invalid collection ID"}, 400)
        return self.send_json({"error": "Not Found"}, 404)

    # ===== API handlers =====

    def handle_sheet_api(self):
        if not HAS_REPORTLAB:
            return self.send_json({"error": "reportlab not installed"}, 500)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            config = json.loads(raw)
        except Exception as e:
            return self.send_json({"error": f"Invalid JSON: {e}"}, 400)
        ids = config.get("ids") or []
        if not isinstance(ids, list) or len(ids) == 0:
            return self.send_json({"error": "No exercise IDs provided"}, 400)
        if len(ids) > 200:
            return self.send_json({"error": "Too many exercises (max 200)"}, 400)
        try:
            edb = load_db_data()
            pdf_bytes = generate_pdf(config, edb)
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            title = config.get("title", "practice_sheet")
            safe_title = "".join(c if c.isalnum() or c in "_-" else "_" for c in title)[:60]
            self.send_header("Content-Disposition", f'attachment; filename="{safe_title}.pdf"')
            self.send_header("Content-Length", str(len(pdf_bytes)))
            self.end_headers()
            self.wfile.write(pdf_bytes)
        except Exception as e:
            print(f"PDF gen error: {e}", file=sys.stderr)
            return self.send_json({"error": str(e)}, 500)

    def handle_sheet_all_keys_api(self):
        """Generate a PDF with each exercise rendered in all 12 keys.

        Body JSON:
          {
            "ids": [int, ...],            # exercise IDs (max 10)
            "mode": "chromatic"|"min3-cycle5",
            "preferFlats": bool,
            "title": str,
            "subtitle": str,
            "includeNotes": bool,
            "includeTitlePage": bool,
          }
        """
        if not HAS_REPORTLAB:
            return self.send_json({"error": "reportlab not installed"}, 500)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            config = json.loads(raw)
        except Exception as e:
            return self.send_json({"error": f"Invalid JSON: {e}"}, 400)
        ids = config.get("ids") or []
        if not isinstance(ids, list) or len(ids) == 0:
            return self.send_json({"error": "No exercise IDs provided"}, 400)
        if len(ids) > 10:
            return self.send_json({"error": "Max 10 exercises for all-keys sheet (12 pages each)"}, 400)
        mode = config.get("mode", "chromatic")
        if mode not in ("chromatic", "min3-cycle5"):
            return self.send_json({"error": f"Unknown mode: {mode}"}, 400)
        try:
            edb = load_db_data()
            pdf_bytes = generate_all_keys_pdf(config, edb)
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            title = config.get("title") or f"all-keys-{mode}"
            safe_title = "".join(c if c.isalnum() or c in "_-" else "_" for c in title)[:60]
            self.send_header(
                "Content-Disposition",
                f'attachment; filename="{safe_title}.pdf"',
            )
            self.send_header("Content-Length", str(len(pdf_bytes)))
            self.end_headers()
            self.wfile.write(pdf_bytes)
        except Exception as e:
            print(f"All-keys PDF gen error: {e}", file=sys.stderr)
            return self.send_json({"error": str(e)}, 500)

    def handle_log_practice(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            data = json.loads(raw)
        except Exception as e:
            return self.send_json({"error": f"Invalid JSON: {e}"}, 400)
        eid = data.get("exercise_id")
        if not isinstance(eid, int):
            return self.send_json({"error": "exercise_id (int) required"}, 400)
        try:
            lid = db.log_practice(
                exercise_id=eid,
                tempo_bpm=data.get("tempo_bpm"),
                key_signature=data.get("key_signature"),
                duration_min=data.get("duration_min"),
                notes=data.get("notes"),
                completed=data.get("completed", True),
                practiced_at=data.get("practiced_at"),
            )
            return self.send_json({"ok": True, "id": lid})
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)

    def handle_recent(self, qs):
        try:
            days = int(qs.get("days", ["30"])[0])
        except ValueError:
            days = 30
        try:
            limit = int(qs.get("limit", ["100"])[0])
        except ValueError:
            limit = 100
        return self.send_json({
            "practice": db.get_recent_practice(days=days, limit=limit)
        })

    def handle_stats(self, qs):
        try:
            days = int(qs.get("days", ["30"])[0])
        except ValueError:
            days = 30
        return self.send_json(db.get_practice_stats(days=days))

    def handle_exercise_history(self, exercise_id):
        try:
            limit = int(parse_qs(urlparse(self.path).query).get("limit", ["20"])[0])
        except (ValueError, IndexError):
            limit = 20
        return self.send_json({
            "exercise_id": exercise_id,
            "history": db.get_exercise_history(exercise_id, limit=limit),
            "summary": db.get_exercise_summary(exercise_id),
        })

    def handle_list_collections(self):
        return self.send_json({"collections": db.list_collections()})

    def handle_get_collection(self, cid):
        col = db.get_collection(cid)
        if col is None:
            return self.send_json({"error": "Not found"}, 404)
        return self.send_json(col)

    def handle_create_collection(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            data = json.loads(raw)
        except Exception as e:
            return self.send_json({"error": f"Invalid JSON: {e}"}, 400)
        name = data.get("name")
        if not name:
            return self.send_json({"error": "name required"}, 400)
        cid = db.create_collection(
            name=name,
            description=data.get("description"),
            exercise_ids=data.get("exercise_ids"),
        )
        if cid is None:
            return self.send_json({"error": "Collection name already exists"}, 409)
        return self.send_json({"ok": True, "id": cid})

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    print(f"Bob Mover Lexicon Practice Library")
    print(f"  Serving:    {ROOT}")
    print(f"  Port:       {PORT}")
    print(f"  ReportLab:  {'yes' if HAS_REPORTLAB else 'NO'}")
    print(f"  music21:    {'yes' if HAS_MUSIC21 else 'NO - transposition disabled'}")
    print(f"  MusicXML:   {MUSICXML_DIR} ({len(list(MUSICXML_DIR.glob('*.mxl'))) if MUSICXML_DIR.exists() else 0} files)")
    print(f"  Images:     {IMAGES_DIR} ({len(list(IMAGES_DIR.glob('*.png')))} files)")
    print(f"  DB:         {db.DB_PATH}")
    print()
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        httpd.allow_reuse_address = True
        print(f"  Open: http://localhost:{PORT}/")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down.")


if __name__ == "__main__":
    main()
