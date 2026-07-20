"""
SQLite database for practice history.

Schema:
- practice_log: one row per practice session
  - id, exercise_id, practiced_at, tempo_bpm, key, duration_min, notes, completed
- collections: named groups of exercises (e.g. "Coltrane warmup")
  - id, name, created_at
- collection_items: many-to-many
  - collection_id, exercise_id, position
"""
import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path

DB_PATH = Path(__file__).parent / "practice.db"
_LOCK = threading.Lock()


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    """Create tables if they don't exist."""
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("""
            CREATE TABLE IF NOT EXISTS practice_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                exercise_id INTEGER NOT NULL,
                practiced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                tempo_bpm INTEGER,
                key_signature TEXT,
                duration_min REAL,
                notes TEXT,
                completed INTEGER NOT NULL DEFAULT 0
            )
        """)
        c.execute("""
            CREATE INDEX IF NOT EXISTS idx_practice_exercise
            ON practice_log(exercise_id, practiced_at DESC)
        """)
        c.execute("""
            CREATE INDEX IF NOT EXISTS idx_practice_time
            ON practice_log(practiced_at DESC)
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS collections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                description TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS collection_items (
                collection_id INTEGER NOT NULL,
                exercise_id INTEGER NOT NULL,
                position INTEGER NOT NULL,
                PRIMARY KEY (collection_id, exercise_id),
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
            )
        """)
        # Seed default collections
        c.execute("SELECT COUNT(*) FROM collections")
        if c.fetchone()[0] == 0:
            seeds = [
                ("Coltrane-style", "Major thirds, quartals, sheets of sound", 1, 87, 145, 200, 280),
                ("Bud Powell bebop", "8th note bebop phrases, dominant vocabulary", 16, 79, 252, 296, 320),
                ("Barry Harris diminished", "Diminished 7th arpeggios, related dominants", 65, 67, 295, 300, 305, 310),
                ("30-min Warmup", "Quick chromatic + scalic + arpeggio warmup", 1, 2, 12, 24, 31, 50, 100),
                ("II-V-I Essentials", "Core II-V-I patterns from section 4", 246, 255, 278, 290, 300, 320),
                ("Whole Tone Studies", "All whole tone / augmented exercises", 145, 150, 160, 170, 180, 190),
            ]
            for name, desc, *ex_ids in seeds:
                c.execute(
                    "INSERT INTO collections (name, description) VALUES (?, ?)",
                    (name, desc),
                )
                cid = c.lastrowid
                for pos, eid in enumerate(ex_ids):
                    c.execute(
                        "INSERT INTO collection_items (collection_id, exercise_id, position) VALUES (?, ?, ?)",
                        (cid, eid, pos),
                    )


# ===== Practice log API =====

def log_practice(exercise_id, tempo_bpm=None, key_signature=None,
                 duration_min=None, notes=None, completed=True, practiced_at=None):
    if practiced_at is None:
        practiced_at = datetime.utcnow().isoformat() + "Z"
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("""
            INSERT INTO practice_log
              (exercise_id, practiced_at, tempo_bpm, key_signature, duration_min, notes, completed)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (exercise_id, practiced_at, tempo_bpm, key_signature, duration_min, notes,
              1 if completed else 0))
        return c.lastrowid


def get_exercise_history(exercise_id, limit=20):
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("""
            SELECT * FROM practice_log
            WHERE exercise_id = ?
            ORDER BY practiced_at DESC
            LIMIT ?
        """, (exercise_id, limit))
        return [dict(r) for r in c.fetchall()]


def get_recent_practice(days=30, limit=100):
    cutoff = (datetime.utcnow() - timedelta(days=days)).isoformat() + "Z"
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("""
            SELECT * FROM practice_log
            WHERE practiced_at >= ?
            ORDER BY practiced_at DESC
            LIMIT ?
        """, (cutoff, limit))
        return [dict(r) for r in c.fetchall()]


def get_practice_stats(days=30):
    """Get aggregated stats for the practice view."""
    cutoff = (datetime.utcnow() - timedelta(days=days)).isoformat() + "Z"
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        # Total sessions, exercises, time
        c.execute("""
            SELECT
                COUNT(*) AS sessions,
                COUNT(DISTINCT exercise_id) AS unique_exercises,
                COALESCE(SUM(duration_min), 0) AS total_minutes,
                COALESCE(AVG(tempo_bpm), 0) AS avg_tempo,
                COALESCE(MAX(tempo_bpm), 0) AS max_tempo
            FROM practice_log
            WHERE practiced_at >= ?
        """, (cutoff,))
        overall = dict(c.fetchone())

        # Per-day counts for the last `days` days
        c.execute("""
            SELECT
                date(practiced_at) AS day,
                COUNT(*) AS sessions,
                COUNT(DISTINCT exercise_id) AS unique_exercises,
                COALESCE(SUM(duration_min), 0) AS minutes
            FROM practice_log
            WHERE practiced_at >= ?
            GROUP BY date(practiced_at)
            ORDER BY day
        """, (cutoff,))
        by_day = [dict(r) for r in c.fetchall()]

        # Most practiced exercises
        c.execute("""
            SELECT exercise_id, COUNT(*) AS sessions, MAX(tempo_bpm) AS best_tempo
            FROM practice_log
            WHERE practiced_at >= ?
            GROUP BY exercise_id
            ORDER BY sessions DESC
            LIMIT 10
        """, (cutoff,))
        top_exercises = [dict(r) for r in c.fetchall()]

        return {
            "overall": overall,
            "by_day": by_day,
            "top_exercises": top_exercises,
        }


def get_exercise_summary(exercise_id):
    """One-line summary of an exercise for card display."""
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("""
            SELECT
                COUNT(*) AS times_practiced,
                MAX(practiced_at) AS last_practiced,
                MAX(tempo_bpm) AS best_tempo
            FROM practice_log
            WHERE exercise_id = ?
        """, (exercise_id,))
        row = c.fetchone()
        return dict(row) if row else {}


# ===== Collections API =====

def list_collections():
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("""
            SELECT c.*, COUNT(ci.exercise_id) AS exercise_count
            FROM collections c
            LEFT JOIN collection_items ci ON ci.collection_id = c.id
            GROUP BY c.id
            ORDER BY c.created_at DESC
        """)
        return [dict(r) for r in c.fetchall()]


def get_collection(collection_id):
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("SELECT * FROM collections WHERE id = ?", (collection_id,))
        col = c.fetchone()
        if not col:
            return None
        col = dict(col)
        c.execute("""
            SELECT exercise_id, position FROM collection_items
            WHERE collection_id = ?
            ORDER BY position
        """, (collection_id,))
        col["exercises"] = [r["exercise_id"] for r in c.fetchall()]
        return col


def create_collection(name, description=None, exercise_ids=None):
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        try:
            c.execute(
                "INSERT INTO collections (name, description) VALUES (?, ?)",
                (name, description),
            )
        except sqlite3.IntegrityError:
            return None  # duplicate
        cid = c.lastrowid
        if exercise_ids:
            for pos, eid in enumerate(exercise_ids):
                c.execute(
                    "INSERT INTO collection_items (collection_id, exercise_id, position) VALUES (?, ?, ?)",
                    (cid, eid, pos),
                )
        return cid


def delete_collection(collection_id):
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("DELETE FROM collections WHERE id = ?", (collection_id,))
        return c.rowcount > 0


# Initialize on import
init_db()
