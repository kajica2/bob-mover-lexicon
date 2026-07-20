#!/bin/bash
# Deploy Bob Mover Lexicon to Railway.app
#
# Prerequisites:
#   1. Install Railway CLI:  npm install -g @railway/cli
#   2. Login:                railway login
#   3. Initialize project:   railway init (in this dir)
#   4. Deploy:               railway up
#
# Or use the web UI at https://railway.app — even easier:
#   1. Sign in at railway.app
#   2. New Project → Deploy from GitHub repo (or "Empty Project" + drag this folder)
#   3. Railway auto-detects Python, installs requirements.txt, runs Procfile

set -e
echo "🚂 Deploying Bob Mover Jazz Lexicon to Railway"
echo ""

if ! command -v railway &> /dev/null; then
    echo "❌ Railway CLI not found."
    echo ""
    echo "Option A: Install it"
    echo "  npm install -g @railway/cli"
    echo "  railway login"
    echo "  railway init    # creates project, picks region"
    echo "  railway up      # deploys"
    echo ""
    echo "Option B: Use the web UI (easier)"
    echo "  1. Go to https://railway.app/new"
    echo "  2. Sign in with GitHub"
    echo "  3. Click 'Deploy from GitHub repo' OR 'Empty Project'"
    echo "  4. If empty: drag this folder in, or:"
    echo "     - Push this dir to a new GitHub repo first"
    echo "     - Then 'Deploy from GitHub' and pick the repo"
    echo "  5. Railway will:"
    echo "     - Detect Python via runtime.txt"
    echo "     - Install requirements.txt"
    echo "     - Run 'python3 server.py' via the Procfile"
    echo "  6. After deploy, click 'Generate Domain' to get a public URL"
    echo ""
    exit 1
fi

# Check login
if ! railway whoami &> /dev/null; then
    echo "Not logged in. Run: railway login"
    exit 1
fi

# Init if no project linked yet
if [ ! -f .railway/project.json ] 2>/dev/null; then
    echo "Initializing Railway project..."
    railway init
fi

echo "Deploying..."
railway up
echo ""
echo "✓ Deploy initiated. Watch logs with: railway logs --follow"
echo "  Generate a public URL: railway domain"
