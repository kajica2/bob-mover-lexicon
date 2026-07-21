# Bob Mover Jazz Lexicon — Practice Library

A self-contained web app to browse, practice, and track progress on the **407 exercise patterns** in the Bob Mover Jazz Lexicon (2nd Edition, Treble Clef).

## Features

### 📚 Browse
- Browse all 407 exercises in a clean visual grid
- Filter by section (Chromatic, Scalic, Chords/Arpeggios, Whole Tone, Diminished, II-V-I, Tritones, Dominant 7ths, Quartals)
- Search by title, section, or exercise number
- Mark favorites — saved to localStorage
- "Add to queue" button on every card to build a practice session
- Practice status indicators (`✓ 2×`) on cards you've worked on

### 🎵 Practice Player (`/practice/`)
- **Real Verovio-rendered notation** (not PDF crops) — sharp, scalable, professional
- **Transposition engine** powered by music21:
  - 12-key transposition
  - Instrument-aware: Concert, Tenor/Baritone/Trumpet (Bb), Alto/Bari (Eb), Soprano (Bb)
  - Server-side, returns valid MusicXML
- **Audio playback** with Web Audio API:
  - Triangle-wave synth (sounds vaguely saxophone-ish)
  - Tempo control (40-320 BPM)
  - Metronome on beat 1
  - Volume slider
  - Play/Stop with auto-stop
- **Session queue** — build a list of exercises, jump between them
- **Collections** — pre-made sets (Coltrane, Bud Powell, Barry Harris, 30-min Warmup, II-V-I Essentials, Whole Tone)
- **Log this practice** form — record tempo reached, duration, key, notes
- Keyboard shortcuts: `Space` = play/stop, `←/→` = prev/next exercise, `L` = log

### 📊 History (`/history/`)
- 4 stat cards: sessions, unique exercises, minutes practiced, max tempo (last 30 days)
- **Activity heatmap** (last 30 days, color-coded by minutes)
- **Most practiced** list (top 10) — clickable to jump to that exercise
- **All sessions table** with date, exercise, tempo, key, duration, notes
- Every session row is a link to the practice page for that exercise

### 🗄️ Backend
- **SQLite** for persistence (single file: `practice.db`)
- **music21** for transposition (with proper key signature adjustment)
- REST API:
  - `GET/POST /api/practice` — log and retrieve sessions
  - `GET /api/practice/stats` — aggregated stats
  - `GET /api/practice/exercise/:id` — single exercise history
  - `GET /api/musicxml/:id?transpose=N&instrument=X` — transposed MusicXML
  - `GET/POST/DELETE /api/collections` — manage collections

## Stack

- **Frontend**: Vanilla HTML/CSS/JS, Verovio (notation engine), Web Audio API
- **Backend**: Python 3 + `music21` (transposition) + SQLite
- **Data**: JSON metadata + 407 cropped PNGs + 407 MusicXML files
- **No npm, no webpack, no build step** — open and run

## Running

```bash
# Install Python deps
pip install music21

# Start the server (defaults to port 8080)
python3 server.py

# Open in browser
open http://localhost:8080/
```

## Files

```
.
├── index.html         # Browse + sheet builder
├── app.js             # Frontend logic
├── styles.css         # Jazz-themed styling
├── exercises.json     # All 407 exercises
├── exercises_images/  # 407 cropped PNGs
├── server.py          # HTTP server + PDF API + MusicXML API
├── db.py              # SQLite layer for practice log + collections
├── practice.db        # SQLite database (created on first run)
├── practice/          # Practice player page
│   ├── index.html
│   ├── practice.js
│   ├── practice.css
│   └── vendor/        # Verovio toolkit (11MB, served locally)
├── history/           # History page
│   ├── index.html
│   ├── history.js
│   └── history.css
├── vendor/            # Verovio toolkit (also here for direct access)
└── README.md
```

## How transposition works

When you select "Tenor Sax" and exercise #1:
1. Frontend calls `/api/musicxml/1?instrument=tenor`
2. Server extracts the .xml from the .mxl zip
3. music21 parses it, transposes by +2 semitones (Bb instrument = M2 up from concert)
4. music21 re-serializes to MusicXML, including the new key signature
5. Verovio renders the transposed notation in the browser
6. The audio playback uses the transposed MIDI pitches

For pure key changes (e.g. "Down M2"), the transpose parameter adds to the instrument offset.

## Source

Extracted from `Bob_Mover_Jazz_Lexicon_-_2nd_Edition.pdf` using:
- `pdftoppm` for page rendering
- `tesseract` OCR for title detection
- `pymupdf` for precise cropping
- `Audiveris` for MusicXML OMR
- `music21` for transposition

The original PDF remains the authoritative source; this is a study/practice aid.

Enjoy your practice! 🎷
