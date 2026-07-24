# AGENTS.md

A self-contained web app to browse, practice, and track progress on the 407 exercise patterns in the *Bob Mover Jazz Lexicon* (2nd Edition, Treble Clef). Python HTTP server + vanilla JS frontend, no build step.

## Setup commands

- Install deps:  `pip install -r requirements.txt`   (only `music21>=9.0`)
- Start dev:     `python3 server.py`   (port `8080` by default, honours `$PORT`)
- Open:          http://localhost:8080/
- Healthcheck:   `curl -f http://localhost:${PORT:-8080}/`   (matches the Dockerfile HEALTHCHECK)
- Syntax check:  `python3 -m py_compile server.py db.py`     (no linter configured)
- Deploy:        Railway, Render, Fly.io, or Docker — all use `python3 server.py` as the start command. See `DEPLOY.md`.

## Project layout

- `server.py`              — stdlib `http.server` + `music21` transposition + MusicXML/PDF API
- `db.py`                  — SQLite layer for practice log + collections
- `index.html` `app.js` `styles.css`  — Browse / sheet-builder UI
- `etudes.html` `etudes.js` `etudes.css` `etudes-stitch.js` `etudes-store.js` `range-modal.js` — etude mode
- `practice/`              — Practice player page (Verovio + Web Audio + Tone.js)
- `history/`               — History / stats page
- `exercises.json`         — Metadata for all 407 exercises
- `exercises_images/`      — 407 cropped PNGs (gitignored large assets live here)
- `musicxml/`              — 407 Audiveris-OMR `.mxl` files (one per exercise)
- `vendor/verovio-toolkit.js` — Vendored Verovio (notation engine, ~11 MB)
- `Dockerfile` `Procfile` `render.yaml` `railway.json` — multi-host deploy configs
- `build-chords.py`        — Off-tree data pipeline (chord detection via Mac Vision OCR)

## Code style

- Python: stdlib only outside `music21`; module docstrings at the top of each file; one-purpose modules (`server.py` = HTTP, `db.py` = SQLite).
- JS: vanilla IIFEs with `'use strict'`, no framework, no bundler. `practice/practice.js` is the largest file and is the main place to look for playback logic.
- Commit prefix: conventional commits — `feat(playback):` / `fix(playback):` / `refactor:` / `docs:`. The most recent ~15 commits are a playback-engine refactor; read them before touching audio.
- **Cache-bust convention**: when a frontend bug ships stale, append `?v=N` to the affected `<script src>` and mention the bump in the commit message. Recent: `v3` … `v20`. Keep the version counter moving.
- No formatter / linter is configured. Match what's already in the file you're editing.

## Testing instructions

- **There is no test suite, no CI, and no test framework configured.** `pytest`, `tests/`, and `.github/workflows/` do not exist.
- Before claiming a backend change done, smoke-test with the running server:
  ```bash
  python3 server.py &        # then exercise
  curl -sf http://localhost:8080/api/practice/stats
  curl -sf http://localhost:8080/api/musicxml/1?transpose=2 | head -c 200
  ```
- For frontend / playback changes, load `/practice/` in a real browser and verify Verovio renders, audio plays, and the test-sound button (recently added) works. Static checks don't catch Web Audio / Verovio bugs.
- Always commit while the working tree is clean of generated files (`practice.db`, `*.db-wal`, `*.db-shm` — all gitignored).

## PR & commit conventions

- Single primary branch: `main` (this is a solo / hobby project — direct commits to `main` are normal).
- Push to GitHub (`kajica2/bob-mover-lexicon`); Railway auto-deploys from `main` on each push.
- This repo inherits the global git author (`kajica2 <kai.djuric@gmail.com>`) — no per-repo override, no special flags needed. If a future automation tool drops a `Gemini CLI` local config in here, unset it with `git config --local --unset user.name && git config --local --unset user.email` so Vercel / GitHub Actions don't reject the committer.
- Conventional commit prefixes; scope is usually `playback` for the active refactor or the page name (`etudes`, `history`, `practice`).

## Data pipeline (off-tree)

The `exercises.json` / `exercises_images/` / `musicxml/` artifacts were extracted from `Bob_Mover_Jazz_Lexicon_-_2nd_Edition.pdf` using `pdftoppm`, `tesseract`, `pymupdf`, and `Audiveris`. `build-chords.py` adds chord changes via Mac Vision OCR. Re-run only if the source PDF changes — these are not regenerated on every commit.

## Security

- No secrets, no auth, no user accounts. The app is fully public read/write to its own SQLite file.
- `.gitignore` covers `practice.db`, `__pycache__/`, and `*.db-wal` / `*.db-shm` — never force-add them.
- Practice history lives in a single SQLite file on the deployment's persistent volume. On Railway's free tier the volume may be ephemeral; upgrade or back up `practice.db` if you need long-term history.
</content>
</invoke>