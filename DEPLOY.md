# Deploying to Railway (and other hosts)

This app is a single Python process serving HTML/JS/MusicXML/PDF. It deploys to several places with zero code changes.

## Option 1: Railway (recommended, ~2 min)

**Easiest path: web UI, no CLI needed.**

1. Go to https://railway.app/new
2. Sign in with GitHub
3. Choose one of:
   - **"Deploy from GitHub repo"** — push this folder to a new repo, then select it
   - **"Empty Project"** — once created, drag this folder into the deploy UI
4. Railway auto-detects:
   - `runtime.txt` → Python 3.11
   - `requirements.txt` → installs `music21`
   - `Procfile` → runs `python3 server.py`
5. Wait ~2 min for build + first deploy
6. Click **"Generate Domain"** to get a public URL like `https://bob-mover-lexicon.up.railway.app`

**Free tier:** 500 hours/month, $5 credit. Plenty for personal use.

## Option 2: Railway CLI (if you have npm)

```bash
npm install -g @railway/cli
railway login
cd /path/to/lexicon-web
railway init   # creates project, picks region
railway up     # deploys
railway domain # generate public URL
```

Or just run `./deploy.sh` (it wraps the above).

## Option 3: Render (also great, free tier)

1. Push to GitHub
2. Go to https://render.com → New + → Web Service → pick repo
3. Render auto-detects `render.yaml` and uses it
4. Or set manually: Build = `pip install -r requirements.txt`, Start = `python3 server.py`

## Option 4: Fly.io (Docker, free tier)

```bash
# Install: https://fly.io/docs/hands-on/install-flyctl/
fly launch  # uses the included Dockerfile
fly deploy
```

## Option 5: Docker anywhere

```bash
docker build -t bob-mover-lexicon .
docker run -p 8080:8080 bob-mover-lexicon
```

Then expose 8080 with your reverse proxy / tunnel.

## What's deployed

The full `lexicon-web/` directory is what's pushed:
- `server.py` (16KB) — the Python HTTP server
- `db.py` (9KB) — SQLite layer
- `requirements.txt` — `music21`
- `exercises.json` (200KB) — all 407 exercise metadata
- `exercises_images/` (22MB) — 407 cropped PNGs
- `musicxml/` (17MB) — 407 Audiveris MusicXML files
- `index.html`, `app.js`, `styles.css` — browse + sheet builder
- `practice/` — practice player (with Verovio bundled)
- `history/` — history page
- `vendor/verovio-toolkit.js` (11MB) — notation engine
- `Dockerfile`, `railway.json`, `render.yaml`, `Procfile` — deployment configs

Total: ~50MB, deploys in under a minute.

## After deploy

- Open the generated URL in any browser
- Browse, filter, practice
- Practice history is stored in SQLite (one file per deployment, persists across restarts)
- Collections seeded automatically on first run

## Notes

- **Database**: SQLite file lives on the deployment's persistent volume. Practice history survives restarts. (On Railway free tier, the volume may be ephemeral — if you care about long-term persistence, upgrade or use an external DB.)
- **MusicXML cache**: Transpositions are computed on-the-fly with music21 (1-3s each). First transposition of an exercise is slow; subsequent calls are the same. To cache, you'd need to pre-compute and store. Not done here to keep the deploy simple.
- **Cold starts**: Railway free tier spins down after 5min of no traffic. First request after spin-down takes ~10s. Pay tier = always-on.
- **Custom domain**: Both Railway and Render let you bring your own domain. railway.app / onrender.com subdomains work out of the box.

## Why not Vercel?

Vercel is optimized for static + serverless. This app is:
- Stateful (SQLite file on disk)
- Long-running Python process
- Heavy deps (`music21` is ~5MB and needs subprocess for some operations)
- Computationally expensive (transposition = 1-3s)

Railway / Render / Fly.io handle all of this natively. Vercel would require a major refactor (Postgres, JS-only PDF/MusicXML, pre-computed transpositions).

If you really want Vercel-style static hosting, the alternative is a Next.js rewrite, but you'd lose server-side transposition and SQLite-backed practice history.
